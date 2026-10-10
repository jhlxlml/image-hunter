/* 交付完整性校验：manifest 引用、HTML 资源引用、getURL 路径、图标尺寸 */
const fs = require('fs');
const path = require('path');

const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;

function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/* 只认标签本身（`<link rel="stylesheet" href="...">` / `<script src="...">`），
   不用裸 indexOf 找文件名。
   为什么：注释里提一句文件名（比如「theme.css 必须在 options.css 之前」）
   就会让 indexOf 命中那段**注释**，于是「顺序正确」被判成「顺序不对」。
   这个坑踩过两次 —— v1.15.0 新增主题注释时，先是 options.js / diagnostics.js
   对不上，紧接着是 options.css / theme.css。凡是拿位置做断言的地方一律走它。

   定义放在文件顶部：下面各节（16 / 19）都要用，写在中间会踩 TDZ
   （`Cannot access 'tagSrcIdx' before initialization`）。 */
function tagSrcIdx(html, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<(?:link|script)[^>]+(?:src|href)\\s*=\\s*["\'][^"\']*' + esc + '["\']');
  const m = html.match(re);
  return m ? m.index : -1;
}

/* 把 shared/i18n.js **真的跑一遍**，拿到中英两份文案表。
 *
 * 界面文案搬到 i18n 之后，那些「源码里有没有这句中文」的断言全部失效 ——
 * 只靠正则读源码的话，「键存在、值是空的」和「键根本不存在」长得一模一样。
 * 所以这里直接加载文案表，断言打在**键**上，并额外验一遍中英是否齐平。 */
globalThis.IH = globalThis.IH || {};
require(path.join(ROOT, 'shared/i18n.js'));
const STRINGS = (globalThis.IH.I18n && globalThis.IH.I18n.STRINGS) || { zh: {}, en: {} };
/** 这个键在中英两种语言里都真的有内容 */
const hasI18n = (k) => STRINGS.zh[k] != null && STRINGS.en[k] != null;

console.log('=== 1. manifest.json 引用 ===');
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const refs = [];
refs.push(['background.service_worker', mf.background.service_worker]);
refs.push(['options_page', mf.options_page]);
// 图库改成独立标签页后不再有 default_popup，改由 background.js 里的常量指定路径
refs.push(['action.default_popup（已移除）', 'popup/popup.html']);
(mf.content_scripts || []).forEach((cs, i) => {
  (cs.js || []).forEach((f) => refs.push(['content_scripts[' + i + '].js', f]));
  (cs.css || []).forEach((f) => refs.push(['content_scripts[' + i + '].css', f]));
});
Object.entries(mf.icons || {}).forEach(([k, v]) => refs.push(['icons.' + k, v]));
Object.entries((mf.action && mf.action.default_icon) || {}).forEach(([k, v]) => refs.push(['action.default_icon.' + k, v]));

refs.forEach(([label, p]) => {
  if (exists(p)) ok(label + ' → ' + p);
  else bad(label + ' → ' + p + ' 不存在');
});

// 点击扩展图标要打开独立标签页，因此必须【没有】default_popup，
// 否则 Chrome 会弹小窗口，action.onClicked 根本不会触发
if (mf.action && !mf.action.default_popup) {
  ok('action 未设 default_popup（点击图标会走 action.onClicked）');
} else {
  bad('action.default_popup 仍存在，点击图标会弹小窗而不是独立页面');
}
if (mf.action && mf.action.default_title) ok('action.default_title 已设置');
else bad('action.default_title 缺失');

// background.js 里声明的图库路径必须与真实文件一致
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const gp = (bgSrc.match(/GALLERY_PATH\s*=\s*'([^']+)'/) || [])[1];
if (gp && exists(gp)) ok('background.js GALLERY_PATH → ' + gp);
else bad('background.js GALLERY_PATH 指向的文件不存在', gp || '(未声明)');

console.log('\n=== 2. _locales ===');
(mf.content_scripts || []).length && ok('content_scripts 已声明');
if (mf.default_locale) {
  const lf = '_locales/' + mf.default_locale + '/messages.json';
  if (exists(lf)) ok('默认语言文件 ' + lf); else bad('默认语言文件缺失 ' + lf);
  ['zh_CN', 'en'].forEach((l) => {
    const f = '_locales/' + l + '/messages.json';
    if (exists(f)) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      const keys = Object.keys(m);
      ok(l + ' 文案 ' + keys.length + ' 条：' + keys.join(', '));
    } else bad('缺少 ' + f);
  });
  // manifest 里用到的 __MSG_ 键
  const raw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  const used = Array.from(new Set((raw.match(/__MSG_([A-Za-z0-9_]+)__/g) || []).map((s) => s.slice(6, -2))));
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/zh_CN/messages.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
  used.forEach((k) => {
    if (zh[k] && en[k]) ok('__MSG_' + k + '__ 在中英文案中均存在');
    else bad('__MSG_' + k + '__ 缺失', 'zh=' + !!zh[k] + ' en=' + !!en[k]);
  });
  // JS 里用到的 chrome.i18n 键
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  // 同时覆盖 t('key', ...) 直接调用与 MENU_DEFS 里 titleKey: 'key' 的间接引用。
  // 必须加 \b：否则 q.set('tabId', …) 里 "set(" 结尾的 t( 会被误判成 i18n 调用。
  const i18nKeys = Array.from(new Set(
    (bg.match(/(?:\bt\(|titleKey:\s*)'([A-Za-z0-9_]+)'/g) || [])
      .map((s) => s.replace(/^(?:\bt\(|titleKey:\s*)'/, '').replace(/'$/, ''))
  ));
  if (!i18nKeys.length) bad('未从 background.js 中提取到任何 i18n 键');
  i18nKeys.forEach((k) => {
    if (zh[k] && en[k]) ok('i18n 键 ' + k + ' 存在');
    else bad('i18n 键 ' + k + ' 缺失');
  });
}

console.log('\n=== 3. HTML 资源引用 ===');
['popup/popup.html', 'options/options.html'].forEach((htmlRel) => {
  const html = fs.readFileSync(path.join(ROOT, htmlRel), 'utf8');
  const dir = path.dirname(htmlRel);
  const srcs = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g)).map((m) => m[1])
    .filter((s) => !/^https?:|^data:|^#/.test(s));
  srcs.forEach((s) => {
    const rel = path.normalize(path.join(dir, s)).replace(/\\/g, '/');
    if (exists(rel)) ok(htmlRel + ' → ' + s);
    else bad(htmlRel + ' → ' + s + ' 不存在');
  });
  // 检查 getElementById 用到的 id 是否存在于 HTML
  const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g)).map((m) => m[1]));
  const jsRel = htmlRel.replace('.html', '.js');
  if (exists(jsRel)) {
    const js = fs.readFileSync(path.join(ROOT, jsRel), 'utf8');
    const used = Array.from(new Set((js.match(/\$\('([A-Za-z0-9_-]+)'\)/g) || []).map((s) => s.slice(3, -2))));
    const missing = used.filter((id) => !ids.has(id) && !/^cnt-/.test(id));
    if (missing.length) bad(jsRel + ' 引用了不存在的元素 id', missing.join(', '));
    else ok(jsRel + ' 引用的 ' + used.length + ' 个元素 id 均存在');
  }
});

console.log('\n=== 4. chrome.runtime.getURL 路径 ===');
/* 这个遍历从仓库根往下走，所以必须显式跳过不该看的目录 ——
   否则装了 devDependencies（`npm install` 会在根目录建 node_modules）之后，
   它会一头扎进几万个第三方 .js 里去找本文件下面那条正则匹配的东西：
   慢得离谱，而且**很可能撞上别人代码里的同名字符串**，
   报出一个和本项目毫无关系的「路径不存在」。
   （写这段注释时真的踩了一次：注释里随手举了个例子，就被自己的正则扫中，
   报了一条 `→ … 不存在`。守卫扫到自己这件事，在本项目的坑列表里已经有一席之地。） */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github', 'coverage']);
const jsFiles = [];
(function walk(d) {
  fs.readdirSync(d).forEach((f) => {
    if (SKIP_DIRS.has(f)) return;
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js')) jsFiles.push(p);
  });
})(ROOT);

const urlRefs = new Set();
jsFiles.forEach((p) => {
  const src = fs.readFileSync(p, 'utf8');
  Array.from(src.matchAll(/(?:getURL|extUrl)\(\s*'([^']+)'/g)).forEach((m) => urlRefs.add(m[1]));
});
urlRefs.forEach((r) => {
  if (exists(r)) ok('getURL → ' + r);
  else bad('getURL → ' + r + ' 不存在');
});

console.log('\n=== 5. 图标尺寸正确性 ===');
[16, 32, 48, 128].forEach((sz) => {
  const f = 'icons/icon' + sz + '.png';
  const buf = fs.readFileSync(path.join(ROOT, f));
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const isPng = buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (isPng && w === sz && h === sz) ok(f + ' 是合法 PNG 且尺寸 ' + w + 'x' + h);
  else bad(f + ' 尺寸/格式异常', w + 'x' + h);
});

console.log('\n=== 6. 内容脚本加载顺序 ===');
const order = mf.content_scripts[0].js;
const idx = (f) => order.indexOf(f);
const rules = [
  ['shared/constants.js', 'shared/utils.js', 'constants 先于 utils'],
  ['shared/utils.js', 'shared/store.js', 'utils 先于 store'],
  // i18n 要读 settings.uiLang，必须在 store 之后、任何用它取词的脚本之前
  ['shared/store.js', 'shared/i18n.js', 'store 先于 i18n'],
  ['shared/i18n.js', 'content/scanner.js', 'i18n 先于 scanner'],
  ['content/scanner.js', 'content/hover.js', 'scanner 先于 hover'],
  ['content/hover.js', 'content/lightbox.js', 'hover 先于 lightbox'],
  ['content/lightbox.js', 'content/panel.js', 'lightbox 先于 panel'],
  ['content/panel.js', 'content/main.js', 'panel 先于 main']
];
rules.forEach(([a, b, label]) => {
  if (idx(a) >= 0 && idx(b) >= 0 && idx(a) < idx(b)) ok(label);
  else bad(label, a + '=' + idx(a) + ' ' + b + '=' + idx(b));
});

console.log('\n=== 7. 背景脚本 importScripts ===');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const imp = Array.from(bg.matchAll(/importScripts\(([^)]+)\)/g))[0];
if (imp) {
  const list = Array.from(imp[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  list.forEach((f) => { if (exists(f)) ok('importScripts → ' + f); else bad('importScripts → ' + f + ' 不存在'); });
} else bad('background.js 未找到 importScripts');

console.log('\n=== 8. 消息类型一致性 ===');
const constants = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
const msgKeys = Array.from(constants.matchAll(/^\s{4}([A-Z_]+):\s*'IH_/gm)).map((m) => m[1]);
ok('定义的消息类型 ' + msgKeys.length + ' 个：' + msgKeys.join(', '));

// 反向校验：代码里出现的每一个 MSG.XXX 都必须真实定义。
// 曾经踩过的坑：constants 里是 PROBE_SIZE（单数），popup/background 却写成了复数形式，
// 解析成 undefined → 消息 type 为空 → 后台 `if (!msg.type) return` 直接早退不回应 → 功能静默失败。

/** 去掉注释但保留字符串字面量，避免注释里举的例子被当成真实引用 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const known = new Set(msgKeys);
const sources = jsFiles.map((f) => ({
  rel: path.relative(ROOT, f).replace(/\\/g, '/'),
  code: stripComments(fs.readFileSync(f, 'utf8'))
}));

const unknown = new Map();
for (const { rel, code } of sources) {
  for (const m of code.matchAll(/\bMSG\.([A-Za-z0-9_]+)\b/g)) {
    if (known.has(m[1])) continue;
    if (!unknown.has(m[1])) unknown.set(m[1], []);
    unknown.get(m[1]).push(rel);
  }
}
if (unknown.size) {
  for (const [name, files] of unknown) {
    bad('MSG.' + name + ' 未在 constants.js 中定义（被引用于 ' + files.join(', ') + '）');
  }
} else {
  ok('代码中引用的 MSG.* 全部有定义（扫描 ' + sources.length + ' 个 JS 文件）');
}

// 每个已定义的消息类型都应当被真正使用过，避免留下死常量
const allCode = sources.map((s) => s.code).join('\n');
const unused = msgKeys.filter((k) => !new RegExp('\\bMSG\\.' + k + '\\b').test(allCode));
if (unused.length) ok('未被引用的消息类型（保留项）：' + unused.join(', '));
else ok('所有消息类型均被引用');

/* 反向校验之二：产品代码里不应该再出现**裸的** 'IH_XXX' 字符串。
 *
 * 上面那条 MSG.* 校验只认 `MSG.` 前缀，裸字符串全部逃过检查 ——
 * 「写完没人调用」的 IH_HIGHLIGHT 能一直留到审计才被发现，正是因为这个漏洞：
 * 它的 `case 'IH_HIGHLIGHT'` 既不匹配 MSG.* 校验，也没人检查它是否被发送过。
 *
 * 注意只扫产品代码，跳过 tests/ 目录（用例里为了构造消息会直接写字符串）。
 */
const msgValues = new Set(
  Array.from(constants.matchAll(/:\s*'(IH_[A-Z0-9_]+)'/g)).map((m) => m[1])
);
const bareHits = [];
for (const { rel, code } of sources) {
  if (rel === 'shared/constants.js') continue;      // 常量表本身就是一堆字面量
  if (rel.startsWith('tests/')) continue;
  for (const m of code.matchAll(/'(IH_[A-Z0-9_]+)'/g)) {
    if (msgValues.has(m[1])) bareHits.push(rel + ' → ' + m[1]);
  }
}
if (bareHits.length) {
  bareHits.forEach((h) => bad('出现裸的消息字符串，应改用 MSG 常量：' + h));
} else {
  ok('产品代码里没有裸的消息字符串（全部走 MSG 常量）');
}

/* ====================================================================== *
 * 9. 图库页的宿主模式（page / panel）
 *
 * manifest 里没有 default_popup，点击扩展图标走 action.onClicked → ?mode=page，
 * 页内面板走 ?mode=panel —— 不存在不带 ?mode= 的入口。
 * 历史上还有一个「扩展弹窗」模式（MODE === 'popup'），从来没被走到过，
 * 现在已删干净。下面几条就是防止它悄悄长回来。
 * ====================================================================== */
console.log('\n=== 9. 图库页宿主模式（无弹窗模式 + 首帧布局正确）===');

/**
 * 剥掉 JS 里的注释，只留代码。
 *
 * 不剥的话「删干净了吗」这类检查会把注释也算进去 —— 删掉一段代码后通常会在
 * 原地留一句「原来这里是 xxx」，裸 grep 立刻误报，于是只好把注释改得含糊，
 * 检查本身也跟着变得不可信。这里宁可多写 20 行。
 *
 * 够用即可：不处理正则字面量和模板字符串里的 ${}。
 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  let state = null;               // null | "'" | '"' | '`' | '//' | '/*'
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (state === null) {
      if (c === '/' && d === '/') { state = '//'; i += 2; continue; }
      if (c === '/' && d === '*') { state = '/*'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === '//') { if (c === '\n') { state = null; out += c; } i++; continue; }
    if (state === '/*') { if (c === '*' && d === '/') { state = null; i += 2; } else i++; continue; }
    if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue; }
    if (c === state) state = null;
    out += c; i++;
  }
  return out;
}

const popupHtml = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
const popupJsRaw = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
const popupJs = stripJsComments(popupJsRaw);
const popupCssRaw = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8');
const popupCss = popupCssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

// (a) 没有内联脚本：MV3 扩展页面的默认 CSP 是 script-src 'self'，内联会被拦掉。
//     如果哪天有人为了「省一个文件」把模式判定写成内联，页面会静默少一段逻辑。
const inlineScripts = Array.from(popupHtml.matchAll(/<script\b([^>]*)>/g))
  .filter((m) => !/\bsrc\s*=/.test(m[1]));
if (inlineScripts.length) bad('popup.html 里有内联 <script>（MV3 CSP 会拦掉）', String(inlineScripts.length));
else ok('popup.html 没有内联脚本（MV3 CSP 只允许外部脚本）');

// (b) mode.js 必须在 popup.js 之前，而且要在 <body> 的最前面 ——
//     布局是按 body.mode-* 选的，晚一步就会先按错的尺寸画一帧。
//
//     注意这里找的是**脚本标签**而不是文件名：注释里写一句「详见 popup/mode.js」
//     也会被 indexOf 命中，于是标签被删掉时这条检查照样绿（实测踩过）。
const iMode = popupHtml.indexOf('src="mode.js"');
const iPopup = popupHtml.indexOf('src="popup.js"');
const iBody = popupHtml.indexOf('<body');
const iApp = popupHtml.indexOf('class="app"');
if (iMode >= 0 && iPopup >= 0 && iMode < iPopup) ok('mode.js 先于 popup.js 加载');
else bad('mode.js 必须先于 popup.js 加载', 'mode=' + iMode + ' popup=' + iPopup);
if (iBody >= 0 && iMode > iBody && (iApp < 0 || iMode < iApp)) {
  ok('mode.js 紧跟在 <body> 之后（首帧之前就定好布局）');
} else {
  bad('mode.js 应紧跟 <body>，在正文之前', 'body=' + iBody + ' mode=' + iMode + ' app=' + iApp);
}

// (c) <body> 不能再硬编码模式 class —— 写死任何一个，另一个模式就会闪一帧
const bodyTag = (popupHtml.match(/<body[^>]*>/) || [''])[0];
if (/\bclass\s*=\s*["'][^"']*mode-/.test(bodyTag)) {
  bad('popup.html 的 <body> 硬编码了模式 class（会让另一个模式首帧布局错）', bodyTag);
} else {
  ok('popup.html 的 <body> 没有硬编码模式 class');
}

// (d) popup 模式（扩展弹窗）应彻底消失
const popupLeftovers = [];
if (/MODE\s*===\s*'popup'/.test(popupJs)) popupLeftovers.push("popup.js 里还有 MODE === 'popup'");
if (/'panel'\s*:\s*\(?\s*rawMode\s*===\s*'page'/.test(popupJs)) popupLeftovers.push('popup.js 的 MODE 还在三分支判定');
if (/window\.close\(\)/.test(popupJs)) popupLeftovers.push('popup.js 里还有 window.close()（弹窗模式才需要）');
if (/body\.mode-popup\b/.test(popupCss)) popupLeftovers.push('popup.css 里还有 body.mode-popup 规则');
if (popupLeftovers.length) popupLeftovers.forEach((s) => bad('弹窗模式残留：' + s));
else ok('扩展弹窗模式已彻底清除（js / css 均无残留）');

// (e) 两种真实模式都必须有对应样式，否则会退化成「没有布局」
['page', 'panel'].forEach((m) => {
  if (new RegExp('body\\.mode-' + m + '\\s*\\{').test(popupCss)) ok('popup.css 有 body.mode-' + m + ' 布局');
  else bad('popup.css 缺少 body.mode-' + m + ' 布局');
});

// (f) 面板模式是在网页 iframe 里加载 popup.html —— 只有 **popup.html 自己**需要 WAR。
//
// 这里曾经把 popup.css / popup.js / mode.js 也算成必需项，理由是「它是网页 iframe 里的、
// 子资源网页要能取到」。这个前提是错的：iframe 加载的是扩展页，文档源是
// chrome-extension://<id>，它内部的 <link>/<script> 属于**同源扩展请求**，
// 由扩展自己的资源加载处理，根本不经过 WAR。
// WAR 只管「网页的脚本想直接 fetch 扩展资源」—— 页面侧真正这么做的只有两处：
//   content 悬浮 UI 引 overlay.css（shared/utils.js 的 createShadowHost）
//   页面侧 iframe 的 src 指向 popup.html（content/panel.js）
// 证据：收窄到三项后 tests/browser-panel-trust.js 实测面板完整渲染（卡片 > 0）。
// 多留着那几个文件只会扩大指纹面（任何网站都能 fetch 到扩展的实现代码）。
const war = (mf.web_accessible_resources || []).flatMap((w) => w.resources || []);
['popup/popup.html', 'content/overlay.css'].forEach((r) => {
  if (war.indexOf(r) >= 0) ok('web_accessible_resources 含 ' + r);
  else bad('web_accessible_resources 缺少 ' + r + '（页面侧靠 URL 拉它，缺了就坏）');
});

// 反向：这几个**不该**在 WAR 里（它们由 popup.html 在扩展页内部加载）
['popup/popup.css', 'popup/popup.js', 'popup/mode.js'].forEach((r) => {
  if (war.indexOf(r) < 0) ok('web_accessible_resources 不含 ' + r + '（扩展页内部加载，无需暴露）');
  else bad('web_accessible_resources 多了 ' + r + '（白白扩大指纹面，网页能直接 fetch）');
});

/* ====================================================================== *
 * 10. 「原图还原候选」只有一份实现（图库按钮不能和扫描用两套规则）
 *
 * 图库要靠 buildRestoreCandidates 判断「这张卡片值不值得显示『还原』按钮」，
 * 内容脚本靠它真的去生成候选地址。两边如果各写一份，迟早出现
 * 「按钮显示得出来、点了却一个候选都没有」的错位 —— 而这种错位只在
 * 用户点下去的那一刻才暴露，很难在人工回归里撞上。
 *
 * 所以：实现只允许住在 shared/constants.js，scanner 与 popup 都必须委托过去。
 * ====================================================================== */
console.log('\n=== 10. 还原候选只有一份实现 ===');

const codeOf = (rel) => {
  const hit = sources.find((s) => s.rel === rel);
  return hit ? hit.code : '';
};
const constCode = codeOf('shared/constants.js');
const scannerCode = codeOf('content/scanner.js');
const mainCode = codeOf('content/main.js');
const bgCode = codeOf('background.js');

// (a) 实现在 shared 里，并且被导出
if (/function\s+buildRestoreCandidates\s*\(/.test(constCode)) {
  ok('buildRestoreCandidates 定义在 shared/constants.js');
} else {
  bad('shared/constants.js 里找不到 buildRestoreCandidates 的定义');
}
if (/\bbuildRestoreCandidates\b\s*,/.test(constCode)) {
  ok('buildRestoreCandidates 已从 IH.C 导出（图库页才拿得到）');
} else {
  bad('IH.C 的导出里没有 buildRestoreCandidates');
}

// (b) scanner 不能再自己定义一份 —— 必须委托
if (/function\s+buildRestoreCandidates\s*\(/.test(scannerCode)) {
  bad('content/scanner.js 又自己定义了一份 buildRestoreCandidates（会和图库的规则分叉）');
} else {
  ok('content/scanner.js 没有重复定义（已委托 shared）');
}
if (/C\.buildRestoreCandidates/.test(scannerCode)) {
  ok('content/scanner.js 确实委托给 C.buildRestoreCandidates');
} else {
  bad('content/scanner.js 没有引用 C.buildRestoreCandidates');
}

// (c) 图库判定「值不值得给按钮」用的必须是同一个函数
if (/C\.buildRestoreCandidates\s*\(/.test(popupJs)) {
  ok('popup.js 用同一个 C.buildRestoreCandidates 判断是否显示「还原」按钮');
} else {
  bad('popup.js 没有用 C.buildRestoreCandidates 判断按钮是否显示');
}

// (d) 单张重试必须带 refresh —— probeSize 会把「失败」也缓存起来，
//     不带 refresh 的重试会直接命中缓存里的失败，按钮点了等于没点。
//
//     正则用 [^;]* 而不是 [^)]*：调用里嵌套了 IH.Store.getSettings()，
//     [^)]* 会在那个右括号处停下，于是永远匹配不到（实测踩过）。
if (/tryRestore\s*\([^;]*refresh\s*:\s*true/.test(mainCode)) {
  ok('内容脚本的单张重试带了 refresh: true（否则会命中缓存的失败结果）');
} else {
  bad('content/main.js 的 tryRestore 调用没有带 refresh: true');
}

// (e) 后台必须转发 RESTORE_ONE，而且要按 frameId 定位 ——
//     广播给每个 frame 会让页面里每个 iframe 都白跑一遍同样的探测
if (/case\s+MSG\.RESTORE_ONE\s*:/.test(bgCode)) {
  ok('background.js 有 MSG.RESTORE_ONE 路由');
} else {
  bad('background.js 缺少 MSG.RESTORE_ONE 路由');
}
if (/frameId\s*:\s*payload\.frameId/.test(bgCode)) {
  ok('background.js 按 payload.frameId 定位目标 frame（不是广播）');
} else {
  bad('background.js 没有按 payload.frameId 定位目标 frame');
}

// (f) 内容脚本必须接住 RESTORE_ONE
if (/case\s+MSG\.RESTORE_ONE\s*:/.test(mainCode)) {
  ok('content/main.js 接住了 MSG.RESTORE_ONE');
} else {
  bad('content/main.js 没有处理 MSG.RESTORE_ONE');
}

/* ====================================================================== *
 * 11. 站点排除列表 / 保存到子目录 —— 「接线」必须处处对上
 *
 * 这两个功能的共同风险不是算法写错，而是**漏接一处**：
 *   - 排除列表要在 4 个地方各判一次（内容脚本启动 / 悬停显示路径 /
 *     后台扫描 / 后台开面板），漏掉任何一处都会出现「明明排除了还看得见按钮」
 *     或者「排除了却还能扫出一堆图」
 *   - 子目录只要 buildFilename 不调用 buildSubfolder 就完全静默失效
 *     （设置页有输入框、保存也成功，就是不起作用）
 * 这些都不会报错、也不会让别的测试变红，只能靠静态检查钉住。
 * ====================================================================== */
console.log('\n=== 11. 排除列表 / 子目录的接线 ===');

const utilsCode = codeOf('shared/utils.js');
const hoverCode = codeOf('content/hover.js');
const optionsJs = codeOf('options/options.js');
const optionsHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
const popupHtmlRaw = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');

// --- (a) 默认设置里必须有这两个键，否则导出→导入会被白名单静默过滤 ---
if (/^\s{4}blockedHosts:\s*\[\s*\]/m.test(constCode)) {
  ok('DEFAULT_SETTINGS 里有 blockedHosts（且默认空数组）');
} else {
  bad('DEFAULT_SETTINGS 里找不到 blockedHosts —— 导出→导入会静默丢失');
}
if (/^\s{4}subfolder:\s*''/m.test(constCode)) {
  ok('DEFAULT_SETTINGS 里有 subfolder（且默认空串 = 不分子目录）');
} else {
  bad('DEFAULT_SETTINGS 里找不到 subfolder');
}

// --- (b) 匹配器与清洗函数必须从 shared 导出（内容脚本 / 后台 / 设置页三处共用）---
['isHostBlocked', 'normalizeHostPattern', 'hostMatches', 'sanitizeBlockedHosts', 'buildSubfolder']
  .forEach((fn) => {
    if (new RegExp('\\b' + fn + '\\b\\s*,').test(utilsCode) || new RegExp('\\b' + fn + '\\b\\s*$', 'm').test(utilsCode)) {
      ok('IH.U 导出了 ' + fn);
    } else {
      bad('IH.U 没有导出 ' + fn);
    }
  });

// --- (c) 四道门 ---
if (/isHostBlocked\s*\(/.test(mainCode)) {
  ok('content/main.js 判断了站点是否被排除');
} else {
  bad('content/main.js 没有判断站点排除（boot 会照常挂悬停监听）');
}
if (/isHostBlocked\s*\(/.test(hoverCode)) {
  ok('content/hover.js 在显示路径上也判断了（设置改动后立即生效）');
} else {
  bad('content/hover.js 没有判断站点排除 —— 页面开着时改设置不会生效');
}
if (/function\s+isBlockedUrl\s*\(/.test(bgCode)) {
  ok('background.js 有 isBlockedUrl（扫描 / 面板共用一个判据）');
} else {
  bad('background.js 缺少 isBlockedUrl');
}
if (/isBlockedUrl\s*\(/.test(bgCode) && /blocked:\s*!!session\.blocked/.test(bgCode)) {
  ok('background.js 把 blocked 一路带回给调用方（图库才能说对那句话）');
} else {
  bad('background.js 没有把 blocked 结果带回去');
}
if (/r\s*&&\s*r\.blocked|res\s*&&\s*res\.blocked/.test(popupJs)) {
  ok('popup.js 对「站点已排除」单独给了一句人话，而不是笼统的「嗅探失败」');
} else {
  bad('popup.js 没有单独处理 res.blocked');
}

// --- (d) 设置页的入口 + 清洗 ---
if (/id="blockedHosts"/.test(optionsHtml)) {
  ok('设置页有「站点排除列表」输入区');
} else {
  bad('设置页没有 blockedHosts 的输入区（功能藏起来了）');
}
if (/id="emptyHint"/.test(popupHtmlRaw)) {
  ok('图库空状态的副标题有独立节点（能跟着主文案换）');
} else {
  bad('图库空状态没有独立的副标题节点');
}
if (/data-key="subfolder"/.test(optionsHtml)) {
  ok('设置页有「保存到子目录」输入框');
} else {
  bad('设置页没有 subfolder 的输入框');
}
if (/sanitizeBlockedHosts\s*\(/.test(optionsJs)) {
  ok('设置页保存前走 sanitizeBlockedHosts（规范化 + 去重 + 丢无效行）');
} else {
  bad('设置页没有清洗排除列表 —— 脏输入会被原样存下来');
}

// --- (e) 导入必须把 blockedHosts 当特殊字段校验（和 customRules 同等待遇）---
const mergeBody = (utilsCode.match(/function\s+mergeImportedSettings[\s\S]*?\n  \}/) || [''])[0];
if (/blockedHosts\s*:\s*sanitizeBlockedHosts/.test(mergeBody)) {
  ok('mergeImportedSettings 单独校验 blockedHosts（否则导入会绕过规范化）');
} else {
  bad('mergeImportedSettings 没有单独处理 blockedHosts');
}

// --- (f) 子目录真的接上了 ---
if (/buildSubfolder\s*\(/.test(utilsCode) && /sub\s*\+\s*'\/'\s*\+\s*name/.test(utilsCode)) {
  ok('buildFilename 把 buildSubfolder 的结果拼到了文件名前面');
} else {
  bad('buildFilename 没有调用 buildSubfolder —— 设置页的输入框会完全不起作用');
}
/* 越界保护具体落在哪儿：
   - `..` / 空段由 sanitizeSegment 的「去掉首尾的点与空白」+ buildSubfolder 的
     filter(Boolean) 一起挡掉（所以 utils 里根本没有 `'..'` 这个字面量）
   - 层数上限由 buildSubfolder 的 slice(0, 3) 兜住
   断言写成「源码里还看得见这两道」，而不是去匹配某个具体写法。 */
const subBody = (utilsCode.match(/function\s+buildSubfolder[\s\S]*?\n  \}/) || [''])[0];
const segBody = (utilsCode.match(/function\s+sanitizeSegment[\s\S]*?\n  \}/) || [''])[0];
if (segBody.indexOf('.replace(/^[.') >= 0 && subBody.indexOf('.filter(Boolean)') >= 0) {
  ok('子目录清洗会丢掉空段与纯点号段（.. 因此进不来）');
} else {
  bad('sanitizeSegment / buildSubfolder 里的「去首尾点号 + 丢空段」不见了');
}
if (/slice\(0,\s*3\)/.test(subBody)) {
  ok('子目录层数有上限（模板写飞了也不会在下载目录里挖深井）');
} else {
  bad('buildSubfolder 缺少层数上限');
}

// --- (g) renamed 必须比「文件名」而不是「整条相对路径」---
//     否则开了子目录之后，每一次下载都会谎报「被浏览器改了扩展名」
const describeBody = (bgCode.match(/function\s+describeSaved[\s\S]*?\n\}/) || [''])[0];
if (/baseName\s*\(\s*requested\s*\)/.test(describeBody)) {
  ok('describeSaved 的 renamed 比的是文件名（不是含目录的整串）');
} else {
  bad('describeSaved 直接拿 requested 比 renamed —— 带子目录时会误报「实际为 xxx」');
}
if (/function\s+dirName\s*\(/.test(bgCode) && /folder:\s*dirName\(/.test(bgCode)) {
  ok('background.js 把目录名回传给界面（气泡才能说清存到哪一层）');
} else {
  bad('background.js 没有回传 folder');
}

// --- (h) 版本号不能写死在页面里 ---
if (/v\d+\.\d+\.\d+/.test(optionsHtml)) {
  bad('设置页里又出现了写死的版本号 —— 它会和 manifest 悄悄漂移');
} else {
  ok('设置页没有写死版本号');
}
if (/getManifest\s*\(/.test(optionsJs)) {
  ok('设置页从 manifest 运行时读版本号');
} else {
  bad('设置页没有从 manifest 读版本号');
}

/* ====================================================================== *
 * 12. 「在图库中打开」/ 扫描缓存 / 快捷键的接线
 *
 * 这三样都是「几处代码必须对上才有效」的功能：少接一处，表现是
 * 「按钮点了没反应」或者「缓存悄悄返回上一页的列表」——
 * 前者要靠人点，后者更糟（看起来完全正常）。所以静态检查在这里价值很高。
 * ====================================================================== */
console.log('\n=== 12. 「在图库中打开」/ 扫描缓存 / 快捷键的接线 ===');

const lbCode = codeOf('content/lightbox.js');
const popupCode = codeOf('popup/popup.js');   // hoverCode 在第 11 节已经取过

// --- (a) 灯箱：按钮 + 默认隐藏 + 失败不关灯箱 ---
if (/data-act="gallery"/.test(lbCode) && /MSG\.OPEN_GALLERY/.test(lbCode)) {
  ok('灯箱里有「在图库中打开」按钮，并会发 OPEN_GALLERY');
} else {
  bad('灯箱里没有「在图库中打开」的接线');
}
if (/host = \(opts && opts\.host\) \|\| 'gallery'/.test(lbCode)) {
  ok("host 默认取 'gallery'（漏传时最坏是少一个按钮，不会多一个点了没反应的）");
} else {
  bad("host 的默认值不是 'gallery' —— 漏传时会在图库页/面板里显示一个无意义的按钮");
}
if (/applyHost\(\);/.test(lbCode)) {
  ok('open() 时按宿主决定按钮显隐');
} else {
  bad('applyHost 没有接进 open()，按钮的显隐永远不会更新');
}
if (/if \(!res \|\| !res\.ok\) \{[\s\S]{0,80}?flashButton\('gallery', false\);\s*\n\s*return;/.test(lbCode)) {
  ok('打开失败时不关灯箱（不能把用户手里的东西收走）');
} else {
  bad('失败路径可能把灯箱关掉了');
}

// --- (b) 悬停预览必须显式声明自己在网页里 ---
if (/host: 'content'/.test(hoverCode)) {
  ok("悬停预览显式传 host:'content'（否则按钮永远不显示）");
} else {
  bad("content/hover.js 没有传 host:'content' —— 按钮永远出不来");
}

// --- (c) 后台：focusUrl 两条路都要通 ---
if (/async function openGallery\(targetTabId, focusUrl\)/.test(bgCode)) {
  ok('openGallery 接受 focusUrl');
} else {
  bad('openGallery 没有 focusUrl 参数');
}
if (/q\.set\('focus', focusUrl\)/.test(bgCode)) {
  ok('新开图库标签页时把 focus 写进 URL');
} else {
  bad('galleryUrl 没有带上 focus —— 新开标签页那条路定位不了');
}
if (/focusUrl: focusUrl \|\| ''/.test(bgCode)) {
  ok('复用图库标签页时用 GALLERY_TARGET 把 focus 带过去');
} else {
  bad('复用标签页那条路没带 focusUrl');
}
if (/case MSG\.OPEN_GALLERY:/.test(bgCode)) ok('后台有 OPEN_GALLERY 路由');
else bad('后台没有处理 OPEN_GALLERY');

// --- (d) 图库侧：定位要能等渲染，且三种结果都要如实说 ---
if (/async function focusImage\(/.test(popupCode)) ok('图库有 focusImage');
else bad('图库没有 focusImage —— focusUrl 传过去没人接');
if (/params\.get\('focus'\)/.test(popupCode) && /pendingFocus/.test(popupCode)) {
  ok('从 URL 读 focus 并在扫描后定位');
} else {
  bad('图库没有从 URL 参数读 focus');
}
if (/function waitForCard\(/.test(popupCode)) {
  ok('定位会等卡片真的渲染出来（网格是分片补全的，直接查会查不到）');
} else {
  bad('没有等渲染的逻辑 —— 排在第 120 张之后的图会定位失败');
}
if (/resetFilters\(\)/.test(popupCode) && /reset = true/.test(popupCode)) {
  ok('目标被筛选条件挡住时会复位筛选，而不是干说「找不到」');
} else {
  bad('focusImage 没有处理「被筛选挡住」这种情况');
}
if (/t\('pop\.focusMissing'/.test(popupCode) && hasI18n('pop.focusMissing')) {
  ok('真的找不到时如实说明（不假装定位成功）');
} else {
  bad('缺少「找不到」的如实提示');
}

// --- (e) 扫描缓存 ---
if (/const SCAN_CACHE_TTL = 5 \* 60 \* 1000/.test(bgCode)) {
  ok('缓存 TTL 是 5 分钟');
} else {
  bad('没有 5 分钟 TTL');
}
if (/function scanCacheKey\(tabId, url\) \{ return String\(tabId\) \+ '\|' \+ \(url \|\| ''\); \}/.test(bgCode)) {
  ok('缓存键含「标签页 + 地址」（只按 tabId 会在换页后返回上一页的列表）');
} else {
  bad('缓存键里没有地址 —— 同一标签页换页后会拿到上一页的图片列表');
}
if (/if \(msg\.deep \|\| msg\.force\) \{ runScan\(\); return true; \}/.test(bgCode)) {
  ok('深度嗅探与「重新嗅探」都绕过缓存');
} else {
  bad('缓存绕不开 —— 「重新嗅探」会变成摆设');
}
if (/changeInfo\.status === 'loading'/.test(bgCode)) {
  ok('刷新（URL 不变）也会作废缓存');
} else {
  bad('只看 URL 变化，按 F5 刷新后会继续用旧列表');
}
if (/clearScanCache\(\)/.test(bgCode)) {
  ok('设置变更会清空缓存（扫描来源/还原规则都变了）');
} else {
  bad('设置变更没清缓存');
}
if (/SCAN_CACHE_KEY/.test(bgCode) && /chrome\.storage\.session/.test(bgCode)) {
  ok('缓存存 storage.session（SW 被回收后还在）');
} else {
  bad('缓存没有落到 storage.session');
}
if (/cached: true/.test(bgCode) && /cachedAt/.test(bgCode)) {
  ok('命中缓存时如实带上 cached / cachedAt');
} else {
  bad('缓存命中没有标记 —— 界面会把旧结果当成刚扫的');
}

// --- (f) 图库侧：如实标注 + 重新嗅探要绕开 ---
if (/cacheNote/.test(popupCode) && /cacheAgeText/.test(popupCode)) {
  ok('图库会标出「复用 N 分钟前的嗅探结果」');
} else {
  bad('图库没有把「结果来自缓存」标出来');
}
if (/btnRescan'\)\.addEventListener\('click', \(\) => doScan\(true, false, true\)\)/.test(popupCode)) {
  ok('「重新嗅探」按钮传了 force（否则点了还是拿到缓存）');
} else {
  bad('「重新嗅探」没有传 force');
}

// --- (g) 快捷键 ---
const cmds = mf.commands || {};
['toggle-panel', 'open-gallery', 'save-hovered'].forEach((name) => {
  const c = cmds[name];
  if (c && c.suggested_key && c.suggested_key.default && c.description) {
    ok('快捷键 ' + name + ' 已声明（' + c.suggested_key.default + '）');
  } else {
    bad('快捷键 ' + name + ' 声明不完整');
  }
});
if (/command === 'open-gallery'/.test(bgCode) && /command === 'save-hovered'/.test(bgCode)) {
  ok('后台两条新快捷键都有分支');
} else {
  bad('后台缺少新快捷键的分支');
}
if (/chrome\.tabs\.sendMessage\(tab\.id, \{ type: MSG\.SAVE_HOVERED \}\)/.test(bgCode)) {
  ok('「保存悬停图」广播给所有 frame（图片可能在子 iframe 里）');
} else {
  bad('SAVE_HOVERED 带了 frameId 或没发 —— 子 iframe 里的图会存不到');
}
if (/case MSG\.SAVE_HOVERED:/.test(mainCode) && /saveHovered/.test(hoverCode)) {
  ok('内容脚本接住了 SAVE_HOVERED 并转给悬停模块');
} else {
  bad('内容脚本没有处理 SAVE_HOVERED');
}
if (/save: saveCurrent/.test(lbCode)) {
  ok('灯箱导出了 save（快捷键在灯箱开着时保存当前这张）');
} else {
  bad('灯箱没有导出 save');
}

// --- (h) 打包脚本 ---
if (exists('tools/package.js')) ok('打包脚本存在（tools/package.js）');
else bad('缺少 tools/package.js');

/* ====================================================================== *
 * 13. 没有"死设置"：每条 DEFAULT_SETTINGS 都要有地方读它
 *
 * 为什么值得静态检查：死设置不报错，只是静静地什么都不做。
 * 更坏的是它会被导入 JSON 写到（白名单 = DEFAULT_SETTINGS 的键），
 * 于是「导入一份配置 → 某个行为变了 → 但设置页里找不到对应开关」这种困惑
 * 会一直留在那里。
 *
 * 判定用的是「有读取点」而不是「有 UI 开关」—— 见 tools/audit-settings.js
 * 里写的三条判据：「没有 UI 开关」≠「改不了」、「搜不到读取点」≠「没有读取点」。
 * 这里只做最保守的一层：**一个读取点都没有**才算死。
 * ====================================================================== */
console.log('\n=== 13. 没有「死设置」（每条默认设置都有读取点）===');

/** 产品代码里所有会读到 settings 的地方（不含 tests / dist） */
function productCode() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = dir + '/' + name;
      const abs = path.join(ROOT, rel);
      if (fs.statSync(abs).isDirectory()) { walk(rel); continue; }
      if (/\.(js|html)$/.test(name)) out.push([rel, fs.readFileSync(abs, 'utf8')]);
    }
  };
  for (const d of ['shared', 'content', 'popup', 'options']) walk(d);
  out.push(['background.js', fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')]);
  return out;
}

const prodFiles = productCode();
const constSrc = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
const dsStart = constSrc.indexOf('const DEFAULT_SETTINGS');
const dsBody = constSrc.slice(constSrc.indexOf('{', dsStart) + 1, constSrc.indexOf('\n  };', dsStart));

const settingKeys = Array.from(dsBody.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)).map((m) => m[1]);
if (settingKeys.length >= 20) {
  ok('从 DEFAULT_SETTINGS 解析出 ' + settingKeys.length + ' 条设置');
} else {
  bad('只解析出 ' + settingKeys.length + ' 条设置 —— 解析正则可能已经和源码脱节', settingKeys.join(','));
}

// 设置页能不能改它（任意一种形态：data-key / 按 id 挂的富控件 / 分段按钮的 persist）
const uiHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
const uiJs = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');
const hasUi = (k) => new RegExp('data-(key|out|list)\\s*=\\s*["\'][^"\']*\\b' + k + '\\b').test(uiHtml)
  || new RegExp('id\\s*=\\s*["\']' + k + '["\']').test(uiHtml)
  || new RegExp('persist\\(\\s*\\{\\s*' + k + '\\s*:').test(uiJs);

const dead = [];
const noUi = [];
for (const k of settingKeys) {
  const re = new RegExp('\\b' + k + '\\b');
  // 定义自己的那一行不算读取点，所以在 constants.js 里排除定义行
  const readers = prodFiles.filter(([rel, src]) => {
    if (rel === 'shared/constants.js') {
      const lines = src.split('\n').filter((l) => re.test(l));
      return lines.some((l) => !/^\s{4}[A-Za-z_$][\w$]*\s*:/.test(l));
    }
    return re.test(src);
  });
  if (!readers.length) dead.push(k);
  else if (!hasUi(k)) noUi.push(k);
}

if (!dead.length) {
  ok(settingKeys.length + ' 条设置全都有读取点（没有死设置）');
} else {
  bad('发现死设置（定义了但从没被读过）：' + dead.join(', '), '建议删除或接上读取点');
}

/* 「没有 UI 开关」单独列出来，但**不算失败** ——
   导入 JSON 的白名单 = DEFAULT_SETTINGS 的键（shared/utils.js 的
   mergeImportedSettings），所以没有 UI 也可能完全可改。
   v1.8.1 那次就是在这里判错的：把"没有 UI"当成了"改不了"。 */
if (noUi.length) {
  console.log('  · 提示：以下设置在设置页里没有开关（不代表是死的，见注释）：' + noUi.join(', '));
}
// 反向守卫：这几条已知是「故意没有 data-key 但有其它 UI 形态」的，
// 一旦它们被误判成"没有界面可以改"，说明 hasUi 的识别又漏了一类形态。
// themePreset / themeAccent 是 v1.15.0 加的：色卡是 JS 生成的（HTML 里只有
// 一个空容器 #themeSwatches），取色器靠 id="themeAccent" + persist 认出来。
// 把它们钉在这里，是为了 next 一次改设置页时别把这两条识别能力碰掉。
['theme', 'themePreset', 'themeAccent', 'blockedHosts', 'customRules'].forEach((k) => {
  if (hasUi(k)) ok('「' + k + '」被识别为有界面入口（非 data-key 形态也要认得出）');
  else bad('「' + k + '」被误判成没有界面入口 —— hasUi 漏了一类 UI 形态');
});

/* ------------------------------------------------------------------
 * 图库尺寸滑条契约（v1.11.0）
 *
 * 为什么需要静态守卫：滑条的**默认值**和**上限**同时写在两个地方 ——
 * popup.html 的 value/max 属性、popup.js 的 SIZE_MIN_* 常量。
 * 二者一旦脱节，后果是"静默不一致"而不是报错：
 *   · HTML value="256" 但 JS 默认 128 → 打开图库时滑条显示 256、
 *     实际过滤用的是 128，用户看到的首屏结果与控件不符；
 *   · HTML max="4096" 但 JS 上限 2048 → 用户拖到头仍达不到承诺的 4096。
 * 这类错在浏览器里极难发现（拖一下就好、看着也"没坏"），
 * 所以必须在静态层面钉死。
 * ------------------------------------------------------------------ */
const popupJsSrc = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');

const sliderTag = (popupHtml.match(/<input[^>]*id\s*=\s*["']sizeMin["'][^>]*>/) || [])[0] || '';
const sliderAttr = (name) => {
  const m = sliderTag.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']+)["\']'));
  return m ? m[1] : null;
};
const jsConst = (name) => {
  const m = popupJsSrc.match(new RegExp('\\bconst\\s+' + name + '\\s*=\\s*(\\d+)'));
  return m ? Number(m[1]) : null;
};

if (sliderTag) {
  ok('图库尺寸滑条 <input id="sizeMin"> 存在');
} else {
  bad('图库尺寸滑条不见了 —— popup.html 里找不到 <input id="sizeMin">', sliderTag || '(无)');
}

/* 位置契约（v1.11.2）：滑条在**工具行**（.ctrl-bar）里，不在筛选条（.filterbar）里。
 *
 * 用户点名把滑条挪到工具行右侧的空白处（截图里那个红框）——
 * 工具行右侧本来就有大片空档，滑条塞进去不占额外的行高；同时筛选条里
 * 「尺寸」那一格只剩档位 chips，和别的 fg 一样高，整条筛选栏不再有一格特别高。
 *
 * 为什么值得静态钉住：这个位置是**设计决定**，不是实现细节 ——
 * 滑条一旦被移回筛选条，「尺寸」那一格又会高出一行，而这件事在真浏览器里
 * 只会表现成「筛选栏看起来有点不齐」，不会报错、也没人会发现。
 * 判据用 id 的出现位置：`sizeSliderRow` 与 `ctrl-bar` / `filterbar` 标签的相对次序。
 */
{
  const ctrlIdx = popupHtml.indexOf('class="ctrl-bar"');
  const filterIdx = popupHtml.indexOf('class="filterbar"');
  const sliderIdx = popupHtml.indexOf('id="sizeSliderRow"');
  const inCtrl = ctrlIdx >= 0 && filterIdx >= 0 && sliderIdx > ctrlIdx && sliderIdx < filterIdx;
  if (inCtrl) {
    ok('尺寸滑条位于工具行（.ctrl-bar）内，未落回筛选条');
  } else {
    bad('尺寸滑条不在工具行里（v1.11.2 把它移到了工具行右侧空白处）',
      'sliderIdx=' + sliderIdx + ' ctrlIdx=' + ctrlIdx + ' filterIdx=' + filterIdx);
  }
  // 工具行里也**不该**再有 fg-stack（那个上下叠放的结构随滑条一起退役了）
  if (!/class="fg-stack"/.test(popupHtml) && !/\.fg-stack\s*\{/.test(
    fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8'))) {
    ok('随滑条退役的 .fg-stack 已从 HTML 与 CSS 里清干净');
  } else {
    bad('.fg-stack 残留 —— 滑条搬走后这个上下叠放的结构不再需要');
  }
}

const contract = [
  ['min', '0', '下限必须为 0（用户要求可从 0 起，0 = 不过滤）'],
  ['max', String(jsConst('SIZE_MIN_MAX')), 'max 必须与 JS 的 SIZE_MIN_MAX 一致'],
  ['step', String(jsConst('SIZE_MIN_STEP')), 'step 必须与 JS 的 SIZE_MIN_STEP 一致'],
  ['value', String(jsConst('SIZE_MIN_DEFAULT')), 'value 必须与 JS 的 SIZE_MIN_DEFAULT 一致']
];

if (sliderTag && jsConst('SIZE_MIN_MAX') !== null) {
  contract.forEach(([attr, want, why]) => {
    const got = sliderAttr(attr);
    if (got === null) bad('滑条缺少 ' + attr + ' 属性', why);
    else if (got === want) ok('滑条 ' + attr + '="' + got + '" 符合契约');
    else bad('滑条 ' + attr + '="' + got + '"，但应为 ' + want + ' —— ' + why);
  });

  // 需求硬指标：默认 256、上限 4096、下限 0
  const jsDefault = jsConst('SIZE_MIN_DEFAULT');
  const jsMax = jsConst('SIZE_MIN_MAX');
  if (jsDefault === 256) ok('滑条默认值为 256（需求：默认过滤小于 256px）');
  else bad('滑条默认值 SIZE_MIN_DEFAULT=' + jsDefault + '，需求要求 256');
  if (jsMax === 4096) ok('滑条上限为 4096（需求：可设置范围 0-4096px）');
  else bad('滑条上限 SIZE_MIN_MAX=' + jsMax + '，需求要求 4096');

  // output 文案必须随值变化，否则用户改了看不到反馈
  const outBound = /\$\('sizeMinOut'\)/.test(popupJsSrc)
    && /out\.textContent\s*=\s*filters\.sizeMin/.test(popupJsSrc);
  if (/id\s*=\s*["']sizeMinOut["']/.test(popupHtml) && outBound) {
    ok('滑条有配套的 <output id="sizeMinOut"> 且由 JS 刷新文案');
  } else {
    bad('滑条缺少可见的数值反馈（output 未接上 JS）', '用户拖动后看不到当前阈值');
  }

  // 视图状态键必须**不**在 DEFAULT_SETTINGS 里（它是视图状态，不是可导入的设置）
  const VIEW_KEY = 'ih_gallery_view';
  if (popupJsSrc.indexOf(VIEW_KEY) >= 0) ok('滑条值按视图状态持久化（' + VIEW_KEY + '）');
  else bad('滑条值没有持久化 —— 重开图库会丢');
  const constView = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  const inSettings = new RegExp('\\bih_gallery_view\\b').test(constView);
  if (!inSettings) ok('视图状态键没有混进 DEFAULT_SETTINGS（不该被导入导出）');
  else bad('ih_gallery_view 被写进了 shared/constants.js —— 视图状态不该是可导入设置');

  /* -------- 跨套件约束：浏览器用例的夹具必须「短边 > 滑条默认值」 --------
   *
   * 这条守卫是交了学费换来的。滑条默认 256px 意味着**图库开箱就在按短边过滤**，
   * 而真浏览器用例里大量夹具是 200×140 / 320×200 / 600×400+thumbPath（缩略图 300×200）
   * —— 它们全部落到门槛之下，于是图库网格开箱是空的。
   * 六个套件同时变红，而且失败方式各不相同（超时 / 计数为 0 / 文案不符 / 时序断言失效），
   * 看起来像六个互不相关的 bug，实际是同一个原因。
   *
   * 判据：除了**专门**测尺寸过滤的 `browser-size-slider.js`，
   * 其它浏览器用例的夹具短边都必须严格大于默认阈值。
   * 这里做静态近似：解析 `startServer({...imgW: W, imgH: H...})` 的字面量，
   * 带 `thumbPath: true` 的把短边再砍一半。
   * 解析不出数字（用了变量 / 函数）就跳过 —— 静态守卫宁可漏报也不误报。 */
  const SLIDER_DEFAULT = jsDefault;
  const browserDir = path.join(ROOT, 'tests');
  /* 白名单有三层，从粗到细：
   *   1) FIXTURE_EXEMPT        —— 整个文件都不受影响（从不开图库网格）
   *   2) 行内标记              —— 某一次 startServer 调用不受影响，
   *                               在那一行的**上一行**写 `// fixture-ok: 理由`
   *   3) 什么都没有            —— 必须短边 > 默认值，否则报红
   * 无论哪一层，理由都必须写出来 —— 没有理由的白名单等于关掉守卫。 */
  const FIXTURE_EXEMPT = {
    // 它本身就是测尺寸过滤的，必须故意用一堆小图
    'browser-size-slider.js': '这个套件测的就是尺寸过滤，故意用小尺寸',
    // 只测「悬停预览在源页面上能翻多少张」，从不打开图库网格
    'browser-preview-all.js': '只用悬停灯箱，不打开图库网格（网格空不空无关）',
    // 悬停灯箱的缩略图条窗口化，宿主是网页不是图库
    'browser-lightbox-window.js': '只用悬停灯箱，不打开图库网格',
    // 只读底栏计数与截断提示，不数卡片
    'browser-scan-limit.js': '只断言后台回传的计数与截断提示，不数网格卡片'
  };
  let fixtureChecked = 0;
  let fixtureInlined = 0;
  const offenders = [];

  fs.readdirSync(browserDir)
    .filter((f) => /^browser-.*\.js$/.test(f) && !FIXTURE_EXEMPT[f])
    .forEach((f) => {
      const src = fs.readFileSync(path.join(browserDir, f), 'utf8');
      // 逐个 startServer({...}) 调用：抓出括号内那段，再分别取 imgW / imgH / thumbPath
      const re = /startServer\(\{([\s\S]*?)\}\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const args = m[1];
        const wm = args.match(/imgW\s*:\s*(\d+)/);
        const hm = args.match(/imgH\s*:\s*(\d+)/);
        if (!wm || !hm) continue;                  // 用了变量 → 跳过
        const thumb = /thumbPath\s*:\s*true/.test(args);
        let w = Number(wm[1]);
        let h = Number(hm[1]);
        if (thumb) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
        fixtureChecked++;
        const short = Math.min(w, h);
        if (short > SLIDER_DEFAULT) continue;

        // 行内豁免：这一行或它上面几行里有没有 `fixture-ok:` 标记
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const above = src.slice(Math.max(0, lineStart - 260), lineStart);
        if (/fixture-ok\s*:/.test(above)) { fixtureInlined++; continue; }

        offenders.push(f + ' 的 startServer（' + wm[1] + '×' + hm[1]
          + (thumb ? ' + thumbPath → 实际 ' + w + '×' + h : '')
          + '，短边 ' + short + '）');
      }
    });

  if (!fixtureChecked) {
    console.log('  · 提示：没能静态解析出任何浏览器用例夹具，本节跨套件约束未覆盖');
  } else if (!offenders.length) {
    ok('扫描 ' + fixtureChecked + ' 处浏览器用例夹具，短边都 > 滑条默认 ' + SLIDER_DEFAULT
      + 'px（否则图库开箱就是空的）'
      + (fixtureInlined ? '，另有 ' + fixtureInlined + ' 处行内豁免' : ''));
  } else {
    bad('有 ' + offenders.length + ' 处浏览器用例夹具的短边没超过滑条默认 ' + SLIDER_DEFAULT
      + 'px —— 这些用例的图库网格会开箱即空。'
      + '要么抬高夹具尺寸，要么在那一行上面写 `// fixture-ok: <理由>`：'
      + offenders.join('；'));
  }
  // 反向守卫：白名单里的文件如果真的不存在了，说明它被改名/删掉了，白名单已经腐烂
  const staleExempt = Object.keys(FIXTURE_EXEMPT)
    .filter((f) => !fs.existsSync(path.join(browserDir, f)));
  if (!staleExempt.length) ok('夹具白名单里的文件都还在（没有腐烂的条目）');
  else bad('夹具白名单引用了不存在的文件：' + staleExempt.join(', ')
    + ' —— 白名单该更新了');
} else {
  bad('无法读取 SIZE_MIN_* 常量，滑条契约本节跳过校验', 'JS 里的常量定义可能已改名');
}

/* ------------------------------------------------------------------
 * 14. 多标签页合并嗅探的接线（v1.12.0）
 *
 * 这个功能有三处「脱节了也不会报错」的地方，必须在静态层面钉住：
 *
 *  1. **开关默认必须是关的**。需求原话是「提供开关设置」——
 *     默认打开等于把「只扫当前这一页」这个绝大多数人想要的行为改掉了，
 *     而且改得毫无提示。所以这里不只查「有没有这个键」，还查它的默认值是 false。
 *  2. **两个控件必须都在 HTML 里**，且由 JS 按设置互斥显示。
 *     少一个 → 另一种模式打开就是白屏；不互斥 → 用户不知道到底听谁的。
 *  3. **合并路径必须传 finalOnly**。「先出图、后升级」那套 partial →
 *     SCAN_UPGRADE 是按 tabId 配对的，多页并发时会互相盖掉对方的结果 ——
 *     这里一旦有人「顺手」把 finalOnly 去掉，界面上只会表现成
 *     「结果偶尔闪一下」，极难归因。
 * ------------------------------------------------------------------ */
console.log('\n=== 14. 多标签页合并嗅探的接线 ===');
{
  const constSrc2 = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  const optSrc = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');

  // (a) 设置项存在，且默认是关的
  const defM = constSrc2.match(/\bmergeTabs\s*:\s*(true|false)/);
  if (defM && defM[1] === 'false') {
    ok('DEFAULT_SETTINGS 里有 mergeTabs，且默认 false（开箱还是「只扫当前这一页」）');
  } else if (defM) {
    bad('mergeTabs 默认值是 ' + defM[1] + ' —— 需求要求「提供开关」，默认必须是关的');
  } else {
    bad('DEFAULT_SETTINGS 里找不到 mergeTabs');
  }

  // (b) 设置页有开关
  if (/data-key\s*=\s*["']mergeTabs["']/.test(optSrc)) ok('设置页有 mergeTabs 开关（data-key）');
  else bad('设置页找不到 data-key="mergeTabs" 的开关');

  // (c) 两个目标控件都在 popup.html 里
  const hasSel = /id\s*=\s*["']selTargetTab["']/.test(popupHtml);
  const hasMulti = /id\s*=\s*["']targetMulti["']/.test(popupHtml);
  const hasList = /id\s*=\s*["']targetsList["']/.test(popupHtml);
  if (hasSel) ok('单选下拉 #selTargetTab 仍在（合并关闭时的形态）');
  else bad('#selTargetTab 不见了 —— 合并关闭时就没有扫描目标可选了');
  if (hasMulti && hasList) ok('多选控件 #targetMulti / #targetsList 都在');
  else bad('多选控件缺失', 'targetMulti=' + hasMulti + ' targetsList=' + hasList);

  // (d) JS 按设置互斥显示两个控件
  const toggleBound = /sel\.hidden\s*=\s*mergeTabs/.test(popupJsSrc)
    && /multi\.hidden\s*=\s*!mergeTabs/.test(popupJsSrc);
  if (toggleBound) ok('两个目标控件按 mergeTabs 互斥显示（不会同时露出来）');
  else bad('两个目标控件没有按 mergeTabs 互斥显示');

  // (e) 真的从设置里读这个键
  if (/getSettings\(\)\.mergeTabs/.test(popupJsSrc)) ok('图库从设置里读 mergeTabs');
  else bad('图库没有读 mergeTabs —— 开关会变成一个死开关');

  // (f) 面板模式不许开合并（面板是贴着当前页的窄条，装不下多选面板）
  if (/MODE\s*===\s*'page'\s*&&\s*!!?Store\.getSettings\(\)\.mergeTabs/.test(popupJsSrc)) {
    ok('合并嗅探只在独立页启用（页内面板恒为单目标）');
  } else {
    bad('没有限制「合并只在独立页启用」—— 面板里会露出一个装不下的多选控件');
  }

  // (g) 合并路径必须带 finalOnly（否则 partial/upgrade 会互相盖）
  const mergedCall = popupJsSrc.match(/doMergedScan[\s\S]{0,1200}?finalOnly\s*:\s*true/);
  if (mergedCall) ok('合并扫描每页都带 finalOnly（不吃 partial，避免 N 份升级互相盖）');
  else bad('合并扫描没有传 finalOnly —— partial → SCAN_UPGRADE 是按 tabId 配对的，多页会互相覆盖');

  // (h) 单页路径不受影响：仍走不带 finalOnly 的 SCAN_TAB（保留「先出图、后升级」）
  const singleCall = /type:\s*MSG\.SCAN_TAB[\s\S]{0,200}?tabId[\s\S]{0,200}?force:\s*!!force\s*\n\s*\}\);/.test(popupJsSrc);
  if (singleCall) ok('单页扫描路径保持原样（仍享受「先出图、后升级」）');
  else bad('单页扫描路径被改动了 —— 它不该受合并功能影响');

  // (i) 合并结果去重是按**规范化地址**，不是按页面
  if (/mergeTabResults[\s\S]{0,2000}?U\.normalizeUrl\(img\.url\)/.test(popupJsSrc)) {
    ok('跨页去重按规范化后的图片地址（同一张图只留一份）');
  } else {
    bad('合并时没有按规范化地址去重 —— 勾两页会得到一堆重复');
  }

  // (j) 空态要能区分「还没勾选」和「这些页面没有图片」
  if (/noTargetMerge/.test(popupJsSrc) && /noTargetSingle/.test(popupJsSrc)
    && hasI18n('pop.noTargetMerge') && hasI18n('pop.noTargetSingle')) {
    ok('全部取消勾选时有专门的空态文案（不是「本页没有发现图片」）');
  } else {
    bad('清空勾选后没有专门文案 —— 用户会以为嗅探坏了');
  }
}

/* ------------------------------------------------------------------
 * 15. 键盘与读屏器接线（v1.13.0 可访问性）
 *
 * 可访问性代码有个共同特点：**删掉它，界面看上去一模一样。**
 * 少一个 aria-label、少一条键盘分支、把 .sr-only 改成 display:none，
 * 截图全绿、鼠标用户毫无察觉，只有键盘 / 读屏器用户当场用不了。
 * 所以这些接线必须在静态层面钉死，且断言要打在**去注释后的源码**上
 * —— 否则一句「这里本来该写 onGridKeydown」的注释就能把守卫骗过去。
 * ------------------------------------------------------------------ */
console.log('\n=== 15. 键盘与读屏器接线 ===');
{
  // 去注释版：整块 /* */ 与整行 // 都抹掉，防止守卫被注释里的字面量骗过。
  // （只抹整行的 //，避免把字符串里的 https:// 也切掉。）
  const jsCode = popupJsSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // (a) 网格是 listbox，且声明了多选与说明文字
  const gridTag = (popupHtml.match(/<div id="grid"[\s\S]*?>/) || [])[0] || '';
  const isListbox = /role\s*=\s*["']listbox["']/.test(gridTag);
  const multiOk = /aria-multiselectable\s*=\s*["']true["']/.test(gridTag);
  const described = /aria-describedby\s*=\s*["']gridHelp["']/.test(gridTag);
  if (isListbox && multiOk) ok('网格声明为 role="listbox" + aria-multiselectable（读屏器才知道这是多选列表）');
  else bad('网格缺少 role="listbox" / aria-multiselectable', 'listbox=' + isListbox + ' multi=' + multiOk);
  if (described) ok('网格用 aria-describedby 指向 #gridHelp（操作说明读得到）');
  else bad('网格没有 aria-describedby="gridHelp" —— 键盘用法读屏器念不出来');

  // (b) #gridHelp 必须是 sr-only，且把按键都写全了
  // 结尾写 [^>]* 而不是 >：这一段挂了 data-i18n，尖括号前还有属性
  const helpTag = /<p class="sr-only" id="gridHelp"[^>]*>/.test(popupHtml);
  if (helpTag) ok('#gridHelp 是 sr-only（视觉不占位、无障碍树里在）');
  else bad('#gridHelp 缺失或不是 sr-only');
  const helpText = (popupHtml.match(/<p class="sr-only" id="gridHelp"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
  const helpKeys = ['方向键', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', '空格', 'P', 'R'];
  const helpMissing = helpKeys.filter((k) => helpText.indexOf(k) < 0);
  if (helpText && !helpMissing.length) ok('#gridHelp 把全部键盘用法写清了（方向键 / Home·End / PageUp·PageDown / Enter·空格 / P / R）');
  else bad('#gridHelp 漏了按键说明：' + (helpMissing.join('、') || '(段落没找到)'));

  // (c) 读屏器播报区
  const srTag = (popupHtml.match(/<p class="sr-only" id="srStatus"[^>]*>/) || [])[0] || '';
  if (/role\s*=\s*["']status["']/.test(srTag) && /aria-live\s*=\s*["']polite["']/.test(srTag)) {
    ok('#srStatus 是 role="status" + aria-live="polite"（状态变化才念，不打断）');
  } else {
    bad('#srStatus 缺少 role="status" 或 aria-live="polite"', srTag.slice(0, 80));
  }
  if (/aria-atomic\s*=\s*["']true["']/.test(srTag)) ok('#srStatus 是 aria-atomic（整句替换而不是只念增量）');
  else bad('#srStatus 没有 aria-atomic="true" —— 可能只念出变化的那几个字');

  // (d) 保存进度是 progressbar，且百分比可查
  const progTag = (popupHtml.match(/<div class="progress" id="progress"[\s\S]*?>/) || [])[0] || '';
  if (/role\s*=\s*["']progressbar["']/.test(progTag)) ok('保存进度声明为 role="progressbar"');
  else bad('保存进度缺少 role="progressbar"');
  if (/aria-valuenow/.test(progTag) && /setAttribute\('aria-valuenow'/.test(jsCode)) {
    ok('进度条有 aria-valuenow，且随渲染实时更新（随时可查当前百分比）');
  } else {
    bad('进度条没有同步 aria-valuenow —— 读屏器永远只知道 0%');
  }

  // (e) CSS：悬停才出现的按钮，键盘聚焦时必须出现（WCAG 2.4.7）
  const revealOnFocus = /\.card:focus\s+\.zoom[\s\S]{0,80}?\.card:focus\s+\.restore\s*\{[^}]*opacity\s*:\s*1/.test(popupCss);
  if (revealOnFocus) ok('.card:focus 会显示 .zoom / .restore（不会 Tab 到一个看不见的按钮）');
  else bad('.card:focus 没有显示 .zoom / .restore —— WCAG 2.4.7 违规：焦点落在 opacity:0 的按钮上');

  // (f) CSS：卡片要有可见的焦点环
  if (/\.card:focus-visible\s*\{[^}]*outline\s*:/.test(popupCss)) ok('.card:focus-visible 画焦点环（方向键移动时看得出停在哪张）');
  else bad('.card 没有 :focus-visible 焦点环 —— 键盘用户不知道焦点在哪');

  // (g) CSS：.sr-only 不得用 display:none / visibility:hidden
  const srBlock = (popupCss.match(/\.sr-only\s*\{([^}]*)\}/) || [])[1] || '';
  if (/clip\s*:/.test(srBlock) && !/display\s*:\s*none/.test(srBlock) && !/visibility\s*:\s*hidden/.test(srBlock)) {
    ok('.sr-only 用 clip 隐藏，不用 display:none（内容仍留在无障碍树里）');
  } else {
    bad('.sr-only 用了 display:none / visibility:hidden —— 会把内容一起从无障碍树里删掉', srBlock.slice(0, 60));
  }

  // (h) JS：roving tabindex —— 整张网格只留一个 Tab 停靠点
  if (/card\.tabIndex\s*=\s*index\s*===\s*rovingIndex\s*\?\s*0\s*:\s*-1/.test(jsCode)) {
    ok('卡片走 roving tabindex（只有当前那张是 0，其余 -1 —— 网格只占一个 Tab 停靠点）');
  } else {
    bad('卡片没有走 roving tabindex —— 每张都 tabindex=0 的话，2000 张图就是 2000 次 Tab');
  }

  // (i) JS：方向键 / Home·End / PageUp·PageDown 都接了
  const navKeys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'];
  const navMissing = navKeys.filter((k) => !new RegExp("case\\s*'" + k + "'").test(jsCode));
  if (!navMissing.length) ok('onGridKeydown 接全了移动键（四个方向 + Home·End + PageUp·PageDown）');
  else bad('onGridKeydown 漏了移动键：' + navMissing.join('、'));

  // (j) JS：Enter / 空格 = 勾选，P = 预览，R = 单张还原
  const actMissing = [];
  if (!/case\s*'Enter':\s*\n?\s*case\s*' '/.test(jsCode)) actMissing.push("Enter / 空格（勾选）");
  if (!/case\s*'p':\s*case\s*'P':/.test(jsCode)) actMissing.push('P（预览）');
  if (!/case\s*'r':\s*case\s*'R':/.test(jsCode)) actMissing.push('R（单张还原）');
  if (!actMissing.length) ok('onGridKeydown 接全了动作键（Enter·空格勾选 / P 预览 / R 单张还原）');
  else bad('onGridKeydown 漏了动作键：' + actMissing.join('、'));

  // (k) JS：keydown 真的绑到了 #grid 上
  if (/\$\('grid'\)\.addEventListener\('keydown',\s*onGridKeydown\)/.test(jsCode)) ok('keydown 监听挂在 #grid 上（不是只写了函数没接）');
  else bad('onGridKeydown 没有绑定到 #grid —— 函数写了但没人调用');

  // (l) JS：播报要防抖，否则连续变化会把每个中间态都念一遍
  if (/function announce[\s\S]{0,300}?setTimeout\(/.test(jsCode)) ok('announce() 有防抖（连续调用只有最后一句生效，不会刷屏）');
  else bad('announce() 没有防抖 —— 框选时读屏器会被每个中间计数刷屏');

  // (m) JS：勾选状态要同步到 aria-selected（列表选择状态的唯一真相源）
  if (/setAttribute\('aria-selected',\s*on\s*\?\s*'true'\s*:\s*'false'\)/.test(jsCode)) {
    ok('勾选状态同步到 aria-selected（读屏器才念得出「已选中」）');
  } else {
    bad('没有把勾选状态写进 aria-selected —— 读屏器不知道哪张被选中');
  }

  // (n) JS：卡片内的辅助按钮不占 Tab 顺序（否则每张卡 3 个停靠点）
  const pickHidden = /pick\.setAttribute\('aria-hidden',\s*'true'\)/.test(jsCode) && /pick\.tabIndex\s*=\s*-1/.test(jsCode);
  const auxNeg = /zoom\.tabIndex\s*=\s*-1/.test(jsCode) && /restore\.tabIndex\s*=\s*-1/.test(jsCode);
  if (pickHidden) ok('.pick 对读屏器隐藏且不占 Tab（勾选状态由 aria-selected 独家负责，不念两遍）');
  else bad('.pick 没有 aria-hidden / tabIndex=-1 —— 读屏器会把「已选中」念两遍');
  if (auxNeg) ok('.zoom / .restore 不占 Tab 顺序（键盘等价物是 P / R 键）');
  else bad('.zoom / .restore 没有 tabIndex=-1 —— 每张卡片会多出两个 Tab 停靠点');
}

/* ------------------------------------------------------------------
 * 16. 诊断包的接线（v1.13.0）
 *
 * 诊断包是要被用户**贴到公开 issue 里**的文件，所以这里守的不是功能，
 * 而是两条容易悄悄破掉的边界：
 *
 *  1. **白名单不能退化成整体透传。** 谁把 `pick(e, DOWNLOAD_FIELDS)`
 *     改成 `Object.assign({}, e)`，功能测试全绿（字段只多不少），
 *     泄露却是实打实的。这条必须在静态层面钉死。
 *  2. **background 侧的摘要不能夹带页面信息。** `pageUrl` / `title`
 *     加起来只要一行代码，而且看起来「更有助于排障」—— 但内网地址
 *     泄露的代价远大于那点便利。
 * ------------------------------------------------------------------ */
console.log('\n=== 16. 诊断包的接线 ===');
{
  const constSrc3 = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  const bgSrc2 = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const optHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
  const optJs = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');
  const diagSrc = fs.readFileSync(path.join(ROOT, 'shared/diagnostics.js'), 'utf8');

  // (a) 消息常量存在且唯一
  const msgHits = (constSrc3.match(/GET_DIAGNOSTICS:\s*'([^']+)'/g) || []);
  if (msgHits.length === 1) ok('MSG.GET_DIAGNOSTICS 已定义且只定义一次');
  else bad('MSG.GET_DIAGNOSTICS 定义次数异常', msgHits.length + ' 次');

  // (b) background 真的处理这条消息
  if (/case MSG\.GET_DIAGNOSTICS:/.test(bgSrc2)) ok('background 处理 GET_DIAGNOSTICS');
  else bad('background 没有处理 GET_DIAGNOSTICS —— 设置页会拿到 undefined');

  // (c) 扫描摘要真的被记录，且真扫描与缓存命中两条路都记
  if (/function recordScanSummary\(/.test(bgSrc2)) ok('background 有 recordScanSummary');
  else bad('background 没有 recordScanSummary');
  const realPath = /recordScanSummary\(final,\s*final\s*&&\s*final\.pageUrl\)/.test(bgSrc2);
  const cachePath = /recordScanSummary\(hit\.result,\s*url,\s*\{\s*cached:\s*true\s*\}\)/.test(bgSrc2);
  if (realPath && cachePath) ok('真扫描与缓存命中都会记一笔（cached 字段能解释「这次为什么这么快」）');
  else bad('扫描摘要的记录点不全', 'real=' + realPath + ' cached=' + cachePath);

  // (d) 摘要里不许出现页面地址与标题
  const sumBlock = (bgSrc2.match(/lastScanSummary = \{[\s\S]*?\n  \};/) || [])[0] || '';
  if (!sumBlock) {
    bad('找不到 lastScanSummary 的对象字面量 —— 本节后续断言失去意义');
  } else {
    if (!/pageUrl\s*:/.test(sumBlock) && !/\btitle\s*:/.test(sumBlock)) {
      ok('扫描摘要里没有 pageUrl / title（只留 pageHost —— 内网地址不该进诊断包）');
    } else {
      bad('扫描摘要里出现了 pageUrl / title —— 排障用不上，泄露是真的');
    }
    if (/pageHost:/.test(sumBlock)) ok('扫描摘要只保留 pageHost');
    else bad('扫描摘要连主机名都没留 —— 排障时看不出是哪个站在出问题');
  }

  // (e) 探测统计只能是计数
  const probeBlock = (bgSrc2.match(/const probeStats = \{[\s\S]*?\};/) || [])[0] || '';
  if (/ok:\s*0/.test(probeBlock) && /failed:\s*0/.test(probeBlock) && !/urls?\s*:/.test(probeBlock)) {
    ok('probeStats 只累计成败计数（不记录探测过哪些地址）');
  } else {
    bad('probeStats 的形状不对或记录了地址', probeBlock.slice(0, 60));
  }

  // (f) 设置页有按钮、脚本、绑定
  if (/id\s*=\s*["']btnExportDiag["']/.test(optHtml)) ok('设置页有「导出诊断包」按钮');
  else bad('设置页找不到 #btnExportDiag');
  /* 只认 <script src="..."> 标签本身，不用裸 indexOf 找文件名 ——
     注释里提一句 "options.js"（比如「色卡由 options.js 拼出来」）
     就会让 indexOf 命中那段注释，于是「顺序正确」被判成「顺序不对」。
     这个坑 v1.15.0 踩过一次：新增的主题注释里写了 options.js。
     实现统一走文件顶部的 tagSrcIdx（同样的坑在 theme.css 上又踩了一次）。 */
  const scriptSrcIdx = (name) => tagSrcIdx(optHtml, name);
  const diagIdx = scriptSrcIdx('diagnostics.js');
  const optJsIdx = scriptSrcIdx('options.js');
  if (diagIdx >= 0 && optJsIdx >= 0 && diagIdx < optJsIdx) ok('diagnostics.js 在 options.js 之前加载（IH.Diag 先就位）');
  else bad('diagnostics.js 没被引入，或加载顺序在 options.js 之后');
  if (/\$\('btnExportDiag'\)\.addEventListener\('click'/.test(optJs)) ok('按钮绑定了点击处理');
  else bad('#btnExportDiag 没有绑定 —— 按钮点了没反应');

  // (g) 设置页确实走 build + audit，且在落盘之前
  if (/IH\.Diag\.build\(/.test(optJs) && /IH\.Diag\.audit\(/.test(optJs)) ok('设置页调用 IH.Diag.build 并做 audit 自查');
  else bad('设置页没有走 build/audit —— 组装规则会散落成两份');
  const auditIdx = optJs.indexOf('IH.Diag.audit(');
  const dlIdx = optJs.indexOf('U.downloadText(IH.Diag.fileName()');
  if (auditIdx >= 0 && dlIdx > auditIdx) ok('自查在落盘之前（发现漏网就中止导出，而不是先写出去）');
  else bad('audit 没有挡在落盘前面');

  // (h) 白名单不能退化成整体透传（本节的守门员）
  if (/function sanitizeDownload\([\s\S]{0,600}?pick\(e,\s*DOWNLOAD_FIELDS\)/.test(diagSrc)) {
    ok('下载记录走 pick(白名单)，不是 Object.assign 整体透传');
  } else {
    bad('sanitizeDownload 没有走白名单 —— 以后新增的字段会静默泄露');
  }
  const dlFields = (diagSrc.match(/DOWNLOAD_FIELDS = \[([^\]]*)\]/) || [])[1] || '';
  if (!/url/i.test(dlFields)) ok('DOWNLOAD_FIELDS 里没有 url / pageUrl 这类字段');
  else bad('DOWNLOAD_FIELDS 里混进了地址字段', dlFields);
  if (/Object\.assign\(\{\},\s*e\)/.test(diagSrc)) bad('diagnostics.js 里出现了 Object.assign 整体透传');
  else ok('diagnostics.js 里没有整体透传的写法');

  // (i) 排除列表只留条数
  if (/SETTINGS_OMIT = \['blockedHosts'\]/.test(diagSrc)) ok('站点排除列表被列入不导出（它是设置，也是浏览轨迹）');
  else bad('SETTINGS_OMIT 没有排除 blockedHosts');

  // (j) URL 正则不能带 g（带 g 会让 lastIndex 在多次调用间残留）
  const urlReDecl = (diagSrc.match(/const URL_RE = (\/.*?\/[a-z]*);/) || [])[1] || '';
  if (urlReDecl && !/g/.test(urlReDecl.replace(/^\/.*\//, ''))) {
    ok('audit 用的 URL_RE 不带 g 标志（避免 lastIndex 状态污染）');
  } else {
    bad('URL_RE 带了 g 标志 —— 连续调用 audit 会漏报', urlReDecl);
  }

  // (k) 导出的 API 齐全
  const apiMissing = ['build', 'audit', 'fileName', 'scrub', 'hostOf']
    .filter((k) => !new RegExp('\\b' + k + '[,:]').test(diagSrc.split('IH.Diag = {')[1] || ''));
  if (!apiMissing.length) ok('IH.Diag 导出了 build / audit / fileName / scrub / hostOf');
  else bad('IH.Diag 少了导出项：' + apiMissing.join('、'));

  // (l) 新文件必须被登记进 Node 测试总入口，否则它不会被跑
  const runAllSrc = fs.readFileSync(path.join(ROOT, 'tests/run-all.js'), 'utf8');
  if (/'test-diagnostics\.js'/.test(runAllSrc)) ok('诊断包测试已登记进 run-all.js（否则等于没写）');
  else bad('run-all.js 里没有 test-diagnostics.js —— 新套件不会被跑到');
}

/* ------------------------------------------------------------------
 * 17. 扫描结论的三态：有图 / 真的没图 / 没扫成（v1.13.1）
 *
 * 这一节的由来是一句用户报告：**「首次点击扩展图标，嗅探有问题，要刷新下才行」**。
 * 根因不在嗅探本身，而在**结论只有两态**：成功（带一个可能为空的列表）与失败。
 * 于是「我们压根没问成」被塞进了「成功但 0 张」里，图库照直说「本页没有发现图片」——
 * 用户看着满屏的图，被告知这页没有图。
 *
 * 三态必须是三态，而且**每一态都要有对应的界面说法**：
 *   有图      → 铺卡片
 *   真的没图  → 「本页没有发现图片」（内容脚本回报了，就是 0 张）
 *   没扫成    → 「嗅探失败：…」（内容脚本没接上话 / 报错 / 页面被排除）
 *
 * 行为层面的回归在 tests/test-scan-timeout.js；这里钉的是**接线**：
 * 谁把 finalizeScan 的 ok 改回裸的 `!session.blocked`，或者把
 * 「本页没有发现图片」挪到错误分支前面，行为测试不一定抓得住（要凑时序），
 * 静态断言一定抓得住。
 * ------------------------------------------------------------------ */
console.log('\n=== 17. 扫描结论的三态 ===');
{
  const bgSrc3 = stripComments(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'));
  const popupSrc = stripComments(fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8'));
  const mainSrc3 = stripComments(fs.readFileSync(path.join(ROOT, 'content/main.js'), 'utf8'));
  const scanSrc3 = stripComments(fs.readFileSync(path.join(ROOT, 'content/scanner.js'), 'utf8'));

  // (a) 三态：ok 不能只看「有没有被排除」
  if (/ok: !session\.blocked && !noReply && !failed/.test(bgSrc3)) {
    ok('finalizeScan 的 ok 同时受「被排除 / 一个 frame 都没回报 / frame 自报错误」约束');
  } else {
    bad('finalizeScan 的 ok 退回了裸的 !session.blocked —— 「没扫成」又会冒充「没有图」');
  }

  // (b) 「一个 frame 都没回报」必须单独判出来
  if (/const reported = session\.byFrame\.size/.test(bgSrc3)
    && /const noReply = !session\.blocked && reported === 0/.test(bgSrc3)) {
    ok('「一个 frame 都没回报」被单独判成 noReply（不是「没有图」）');
  } else {
    bad('background.js 里找不到 noReply 判据');
  }

  // (c) 给用户看的那句话不能读起来像「这页没图」。
  //     文案搬到 i18n 之后，**两种语言都要查** —— 只查中文的话，
  //     英文那句写成 "No images found on this page" 谁也不会发现。
  const noReplyZh = String(STRINGS.zh['bg.scanNoReply'] || '');
  const noReplyEn = String(STRINGS.en['bg.scanNoReply'] || '');
  if (/scanNoReply/.test(bgSrc3) && noReplyZh && noReplyEn) {
    ok('「没扫成」的文案由 background.js 按语言取（bg.scanNoReply）');
  } else {
    bad('background.js 里找不到「没扫成」的文案接线（bg.scanNoReply）');
  }
  if (noReplyZh && !/没有发现图片/.test(noReplyZh) && !/no images found/i.test(noReplyEn)) {
    ok('「没扫成」的文案里没有「没有发现图片」这种会被读成「这页没图」的说法（中英都查）');
  } else {
    bad('「没扫成」的文案会被读成「这页没图」', noReplyZh + ' || ' + noReplyEn);
  }
  if (/刷新|加载/.test(noReplyZh) && /refresh|loading/i.test(noReplyEn)) {
    ok('「没扫成」的文案给了可操作的建议（中英都有刷新 / 等加载完）');
  } else {
    bad('「没扫成」的文案没告诉用户该怎么办', noReplyZh + ' || ' + noReplyEn);
  }

  // (d) 图库侧：错误分支必须**早于**空页面分支，而且各自说各自的话
  const iFail = popupSrc.indexOf("t('pop.scanFail'");
  const iNoImg = popupSrc.indexOf("t('pop.empty')");
  if (iFail > 0 && iNoImg > 0 && iFail < iNoImg) {
    ok('图库先判「嗅探失败」，再说「本页没有发现图片」（两者不会串台）');
  } else {
    bad('图库的「嗅探失败」与「本页没有发现图片」位置反了', iFail + ' / ' + iNoImg);
  }
  if (/if \(!res \|\| !res\.ok\) \{/.test(popupSrc)) {
    ok('图库用 !res.ok 判失败（而不是只看 images.length）');
  } else {
    bad('图库没有按 ok 判失败 —— 空列表会被当成「成功但没图」');
  }

  // (e) 内容脚本不再用「回一个空结果 + busy」表示忙
  if (!/error: 'busy'/.test(mainSrc3)) ok('内容脚本不再回「空结果 + busy」（忙的时候排队）');
  else bad("content/main.js 里还有 error: 'busy' —— 那一次请求会被当成「这页没图」");
  if (/queuedScan/.test(mainSrc3)) ok('内容脚本忙的时候排队（不丢弃那一次请求）');
  else bad('content/main.js 里没有排队逻辑');

  // (f) 首次回报必须只依赖采集，不能排在联网步骤之后
  const iFinish = scanSrc3.indexOf('async function finishList');
  const iPartial = scanSrc3.indexOf('onPartial(toWireList(', iFinish);
  const iProbe = scanSrc3.indexOf('const unknown = list.filter', iFinish);
  if (iFinish > 0 && iPartial > 0 && iProbe > 0 && iPartial < iProbe) {
    ok('「先出图」的中间结果排在补尺寸之前（首次回报不被联网步骤拖住）');
  } else {
    bad('中间结果排到了补尺寸之后 —— 首次点开图标又会被 4 秒判据截断');
  }

  // (g) 后台的 vm 桩只有一份（两份迟早分叉）
  const stubPath = path.join(ROOT, 'tests/lib/bgstub.js');
  const cacheSrc = fs.readFileSync(path.join(ROOT, 'tests/test-scan-cache.js'), 'utf8');
  if (fs.existsSync(stubPath)) ok('后台 vm 桩放在 tests/lib/bgstub.js');
  else bad('tests/lib/bgstub.js 不存在');
  if (/require\('\.\/lib\/bgstub'\)/.test(cacheSrc) && !/function createBg/.test(cacheSrc)) {
    ok('缓存套件复用了共享桩（没有自己再养一份）');
  } else {
    bad('test-scan-cache.js 又自带了一份 createBg —— 桩分叉了');
  }

  // (h) 新套件必须真的会被跑到
  if (fs.existsSync(path.join(ROOT, 'tests/test-scan-timeout.js'))) ok('超时判据套件存在');
  else bad('tests/test-scan-timeout.js 不存在');
  if (fs.existsSync(path.join(ROOT, 'tests/browser-first-scan.js'))) {
    /* 浏览器总入口靠 `browser-` 前缀自动发现。名字起错了不会报错，
       它只是永远不被跑 —— 而「没跑」和「跑过且通过」在汇总里长得一模一样。 */
    ok('浏览器回归套件存在，且以 browser- 开头（能被自动发现）');
  } else {
    bad('tests/browser-first-scan.js 不存在或没以 browser- 开头');
  }
}

/* ------------------------------------------------------------------
 * 18. 界面语言（中英切换）
 *
 * 这一节守的是「翻译件」本身，不是界面逻辑：
 *   - 缺键 / 空串比逻辑错更难发现 —— t() 会静默退回，界面上只是少一句话；
 *   - 拼错的键最坏：**t() 会把 key 原样显示出来**（"pop.svaeSelected"）；
 *   - 设置项没进 DEFAULT_SETTINGS，导出→导入会把它静默过滤掉 ——
 *     用户切了英文，导入一次备份就回到中文，还以为是自己记错了。
 * ------------------------------------------------------------------ */
console.log('\n=== 18. 界面语言 ===');
{
  const zhKeys = Object.keys(STRINGS.zh);
  const enKeys = Object.keys(STRINGS.en);
  const onlyZh = zhKeys.filter((k) => STRINGS.en[k] == null);
  const onlyEn = enKeys.filter((k) => STRINGS.zh[k] == null);
  if (!onlyZh.length && !onlyEn.length) {
    ok('中英文案表齐平（' + zhKeys.length + ' 条）');
  } else {
    bad('中英文案表不齐平',
      '只中文有：' + (onlyZh.join('、') || '无') + '；只英文有：' + (onlyEn.join('、') || '无'));
  }

  // 空值比缺键更隐蔽：t() 静默返回空串，界面上就是一小片空白
  const allKeys = zhKeys.concat(onlyEn);
  const blank = allKeys.filter((k) => !String(STRINGS.zh[k] || '').trim()
    || !String(STRINGS.en[k] || '').trim());
  if (!blank.length) ok('没有空文案（空串比缺键更难发现：界面上就是一小片空白）');
  else bad('这些文案是空的：' + blank.join('、'));

  /* 产品代码里引用的每个键都必须真的存在。
     拼错的键不会报错 —— t() 找不到就**把 key 原样返回**，
     界面上会出现 "pop.svaeSelected" 这种东西，而测试全绿。 */
  const uiFiles = [
    'popup/popup.html', 'popup/popup.js',
    'options/options.html', 'options/options.js',
    'background.js',
    'content/hover.js', 'content/lightbox.js', 'content/panel.js', 'content/main.js'
  ];
  const used = new Set();
  uiFiles.forEach((rel) => {
    /* 先剥注释：注释里写的 `t('pop.xxx')` 示例会被当成真实引用。
       再剥 `<!-- -->`（HTML）和 `/* *\/`、`//`（JS）。 */
    let s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    s = s.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    /* `(?<![\w$.])t\(` —— 否则 createElement('div') 的 …t('div'
       和 params.get('mode') 的 …t('mode' 都会被当成取词调用。 */
    for (const m of s.matchAll(/(?<![\w$.])t\(\s*'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of s.matchAll(/data-i18n(?:-html|-ph|-aria|-title)?\s*=\s*"([A-Za-z0-9_.]+)"/g)) used.add(m[1]);
  });
  const missing = Array.from(used).filter((k) => !hasI18n(k));
  if (!missing.length) ok('界面引用的 ' + used.size + ' 个文案键全部存在（t() 不会把 key 显示出来）');
  else bad('这些文案键在语言表里找不到：' + missing.join('、'));

  // (a) uiLang 必须在 DEFAULT_SETTINGS 里，否则导出→导入会静默丢掉它
  const constSrc = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  if (/uiLang\s*:/.test(constSrc)) ok('DEFAULT_SETTINGS 里有 uiLang（导出→导入不会把语言丢掉）');
  else bad('DEFAULT_SETTINGS 里没有 uiLang —— 导入设置后语言会被静默过滤');

  // (b) 设置页要有语言切换控件
  const optHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
  if (/id="segLang"/.test(optHtml) && /data-v="en"/.test(optHtml) && /data-v="zh"/.test(optHtml)) {
    ok('设置页有「跟随浏览器 / 中文 / English」三档语言切换');
  } else {
    bad('设置页缺少语言切换控件（#segLang 或 zh / en 档位）');
  }

  // (c) 加载顺序：i18n 要读 settings.uiLang，必须在 store.js 之后
  ['popup/popup.html', 'options/options.html'].forEach((rel) => {
    // 剥掉注释：注释里解释加载顺序时会提到这两个文件名，会把 indexOf 带偏
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const iStore = s.indexOf('shared/store.js');
    const iI18n = s.indexOf('shared/i18n.js');
    if (iStore > 0 && iI18n > iStore) ok(rel + ' 的 i18n.js 排在 store.js 之后（才读得到 uiLang）');
    else bad(rel + ' 的 i18n.js 加载顺序不对', 'store=' + iStore + ' i18n=' + iI18n);
  });

  /* (d) 浏览器套件必须自己钉死界面语言
     界面默认是「跟随浏览器」，于是 runner 的语言是什么，界面就是什么语言。
     开发机上是 zh-CN，CI runner 上是 en-US —— 而断言里写的是中文句子。
     不钉死就是「本地全绿、CI 全红」，两边都看不出是语言的问题。 */
  const suites = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => /^browser-.*\.js$/.test(f));
  const noLocale = suites.filter((f) => {
    const s = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    return !/locale:\s*'zh-CN'/.test(s);
  });
  if (!noLocale.length) {
    ok(suites.length + ' 个浏览器套件都固定了 locale: zh-CN（界面语言不跟着 runner 变）');
  } else {
    bad('这些浏览器套件没固定 locale —— 中文断言在英文 runner 上会全部翻掉：' + noLocale.join('、'));
  }

  /* (e) 同理：jsdom 套件手工维护加载清单，而 jsdom 的 navigator.language 恒为 en-US。
     内容脚本要 i18n 才能取词 —— 清单里少一项会以 `IH.I18n is undefined` 炸在
     一个离原因很远的地方；语言没钉死则会让中文断言整体翻成英文。 */
  const jsdomSuites = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => /^test-.*\.js$/.test(f));
  const noI18n = [];
  const noLang = [];
  jsdomSuites.forEach((f) => {
    const s = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    /* 只盯**真的把它加载进 vm** 的套件。
       有的套件只是把内容脚本当文本读出来做静态断言（readFileSync + 正则），
       那种不需要 i18n —— 把「读」当成「加载」会造出一条假红。 */
    const loads = /(?:vm\.runInContext\(fs\.readFileSync\(path\.join\(BASE,\s*|^\s*load\()'content\/(hover|lightbox|panel|main)\.js'/m;
    if (!loads.test(s)) return;
    if (!/shared\/i18n\.js/.test(s)) noI18n.push(f);
    if (!/uiLang:\s*'zh'/.test(s)) noLang.push(f);
  });
  if (!noI18n.length) ok('加载内容脚本的 jsdom 套件都加载了 shared/i18n.js（取词才有得取）');
  else bad('这些 jsdom 套件漏了 shared/i18n.js：' + noI18n.join('、'));
  if (!noLang.length) ok('加载内容脚本的 jsdom 套件都把 uiLang 钉成了中文（jsdom 的默认语言是 en-US）');
  else bad('这些 jsdom 套件没钉 uiLang —— 中文断言在 jsdom 里会整体翻成英文：' + noLang.join('、'));

  /* (f) `data-i18n` 是**整段 textContent 覆写**，所以它底下不能有任何元素。
     写 HTML 兜底文案时很容易顺手把 `<img>` / `<link rel="preload">` 直接写进去
     （原版是转义过的 `&lt;img&gt;`），解析器会真的把它们建出来；
     最狠的是 `<a href>` —— a 不是空元素，它会把**后面整篇文档**吞成自己的子节点，
     `apply()` 覆盖 textContent 时连那棵子树一起删掉。
     真机上的表现完全不像 HTML 问题：点「导出诊断包」整个页面重载、按钮像没接事件。
     所以这里在**解析后的 DOM** 上断言，而不是对着源码正则 —— 正则看不出解析器怎么吞的。 */
  {
    const { JSDOM } = require('jsdom');
    ['options/options.html', 'popup/popup.html'].forEach((rel) => {
      const dom = new JSDOM(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const offenders = [];
      dom.window.document.querySelectorAll('[data-i18n]').forEach((el) => {
        if (el.children.length) {
          offenders.push(el.getAttribute('data-i18n')
            + ' → <' + el.children[0].tagName.toLowerCase() + '>');
        }
      });
      if (!offenders.length) {
        ok(rel + ' 的 data-i18n 兜底文案没有裸标签（不会被 textContent 覆写连子树一起删掉）');
      } else {
        bad(rel + ' 的 data-i18n 兜底文案里写了没转义的标签 —— 会被整棵删掉，`<a>` 还会吞掉后面的文档',
          offenders.join('、'));
      }
    });
  }
}

/* ======================================================================
 * 19. 主题系统的接线（v1.15.0）
 *
 * 主题这件事的特点是：**错了也好看**。少引一个 theme.css、变量名拼错一个字母、
 * 容器忘了加 data-key —— 界面照样渲染，只是颜色悄悄用回了兜底值，或者
 * 用户改完发现"没反应"。所以这一节全部是「接线」层面的静态断言，
 * 具体代数（derive / 亮暗判定）在 tests/test-theme.js 里测。
 * ====================================================================== */
console.log('\n=== 19. 主题系统的接线 ===');
{
  const themeCss = fs.readFileSync(path.join(ROOT, 'shared/theme.css'), 'utf8');
  const themeJs = fs.readFileSync(path.join(ROOT, 'shared/theme.js'), 'utf8');
  const optHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
  const popHtml = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
  const popCss = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8');
  const optCss = fs.readFileSync(path.join(ROOT, 'options/options.css'), 'utf8');
  const overlayCss = fs.readFileSync(path.join(ROOT, 'content/overlay.css'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  /* (a) 单一 token 源：组件样式表里**不许**再出现变量定义。
     这正是这次重构要消灭的东西 —— 三份值各不相同的副本。
     判据只看「冒号缩进定义」这一种形态，靠 `--x: <值>;` 出现在大括号内的
     行首位置识别；theme.css 自己是唯一豁免的文件。 */
  ['popup/popup.css', 'options/options.css', 'content/overlay.css'].forEach((rel) => {
    const src = rel === 'popup/popup.css' ? popCss
      : rel === 'options/options.css' ? optCss : overlayCss;
    /* 判据：大括号里的 `--x: <值>;`。两处容易写错、都踩过：
       1) 先剥注释再找 —— 否则段落头注释里举的例子（`--primary: #4f6ef7;`）
          会被当成真的定义。注意剥注释**不能**把行结构也改掉，
          所以先剥注释、再按行扫。
       2) 不能只认「行首」的 `--x:` —— `:root { --primary: #4f6ef7; }`
          这种单行写法会漏掉。真正的判据是「在某个 `{}` 内部」，
          所以直接在大括号块里扫，而不是按行扫。
       行尾统一按 \r?\n 切：popup.css 是 CRLF（.gitattributes 钉的是 LF，
       但工作区里可能被 checkout 成 CRLF），不处理会让 `\r` 留在值里。 */
    const defs = [];
    const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
    Array.from(body.matchAll(/\{([^{}]*)\}/g)).forEach((m) => {
      Array.from(m[1].matchAll(/(--[a-z0-9-]+)\s*:/gi)).forEach((d) => defs.push(d[1]));
    });
    if (!defs.length) ok(rel + ' 里没有变量定义（变量都收在 shared/theme.css）');
    else bad(rel + ' 里又出现了变量定义，会盖住 shared/theme.css：' + defs.join(', '));
  });

  /* (b) 加载顺序契约：变量定义必须排在引用它们的组件样式表**之前**。
     反过来写不会报错，浏览器只是把 var(--primary) 当成无效值丢掉 ——
     界面上表现为「大片颜色没了」，但看不出是顺序问题。
     位置一律走 tagSrcIdx：这两个 HTML 的头注释里就写着
     「theme.css 必须在 options.css 之前」，裸 indexOf 会命中注释。 */
  {
    let allOk = true;
    [['options/options.html', optHtml, 'options.css'],
      ['popup/popup.html', popHtml, 'popup.css']].forEach(([rel, html, own]) => {
      const t = tagSrcIdx(html, 'shared/theme.css');
      const o = tagSrcIdx(html, own);
      if (t < 0) { bad(rel + ' 没有引入 shared/theme.css'); allOk = false; }
      else if (o < 0) { bad(rel + ' 找不到自家样式表 ' + own); allOk = false; }
      else if (t > o) {
        bad(rel + ' 里 theme.css 排在 ' + own + ' 之后 —— 变量定义会晚于引用，颜色会整片失效');
        allOk = false;
      }
    });
    if (allOk) ok('两个页面都按「theme.css 在前、组件样式在后」引入了变量层');
  }

  /* (c) theme.js 必须排在 store.js 之后 —— 它要在 apply() 里读设置。
     排在前面时 Store 还不存在，apply() 会拿到 undefined 设置，
     于是界面永远停在默认主题（改了设置不生效，但没有任何报错）。 */
  {
    let allOk = true;
    [['options/options.html', optHtml], ['popup/popup.html', popHtml]].forEach(([rel, html]) => {
      const storeAt = tagSrcIdx(html, 'shared/store.js');
      const themeAt = tagSrcIdx(html, 'shared/theme.js');
      if (themeAt < 0) { bad(rel + ' 没有引入 shared/theme.js'); allOk = false; }
      else if (storeAt >= 0 && themeAt < storeAt) {
        bad(rel + ' 里 theme.js 排在 store.js 之前 —— apply() 会读到 undefined 设置');
        allOk = false;
      }
    });
    if (allOk) ok('两个页面的 theme.js 都排在 store.js 之后（apply 时能读到设置）');
  }

  /* (d) 内容脚本侧也要有 theme.js，且在 i18n.js 之后（theme.js 自己不发文案，
     但它与 i18n 同属共享层，顺序写反说明清单被手工动过）。 */
  {
    const cs = manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js || [];
    const ti = cs.indexOf('shared/theme.js');
    const ii = cs.indexOf('shared/i18n.js');
    if (ti < 0) bad('manifest 的 content_scripts 里没有 shared/theme.js —— 页内面板切主题不会生效');
    else if (ii >= 0 && ti < ii) bad('content_scripts 里 theme.js 排在 i18n.js 之前，顺序可疑');
    else ok('manifest 的 content_scripts 引入了 shared/theme.js（在 i18n.js 之后）');
  }

  /* (e) web_accessible_resources 必须放行 theme.css。
     内容脚本用 <link> 往 shadow root 里注入样式表，拿不到访问权的资源
     会被浏览器拦掉 —— 表现是面板完全没样式，但控制台只有一条被折叠的网络错误。 */
  {
    const war = manifest.web_accessible_resources || [];
    const flat = war.reduce((acc, w) => acc.concat(w.resources || []), []);
    if (flat.indexOf('shared/theme.css') >= 0) {
      ok('web_accessible_resources 放行了 shared/theme.css（shadow root 注入要用）');
    } else {
      bad('web_accessible_resources 没有放行 shared/theme.css —— 页内面板会丢样式');
    }
  }

  /* (f) 散落的主色投影必须走 token。
     这几处的共同点是「亮色按钮 + 蓝色光晕」看着完全正常，
     只有把主色改成橙色才会露馅（一圈蓝光围着橙色按钮）。
     硬编码的 rgba(79,110,247,…) 一旦回流，用户改主色就会看到蓝色残影。 */
  {
    const stray = [];
    const scan = (rel, src) => {
      /* 行号要按**原始文件**算，不能按剥完注释的那份 ——
         剥注释会把多行注释压成空串、行数错位，报出来的行号指向别处。
         先剥注释只为避开注释里举的例子，所以位置还是回到原文里找。 */
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
      const re = /rgba\(\s*79\s*,\s*110\s*,\s*247[^)]*\)/g;
      let m;
      while ((m = re.exec(stripped))) {
        // 用命中片段在原文里定位（主题相关的这几处片段都足够独特）
        const at = src.indexOf(m[0]);
        const line = at < 0 ? 0 : src.slice(0, at).split('\n').length;
        stray.push(rel + ':' + line);
      }
    };
    scan('popup/popup.css', popCss);
    scan('options/options.css', optCss);
    scan('content/overlay.css', overlayCss);
    if (!stray.length) ok('三张样式表里没有硬编码的默认主色 rgba(79,110,247,…)（都走 token 了）');
    else bad('这些地方还在硬编码默认主色，改主色时会留下蓝色残影：' + stray.join('、'));
  }

  /* (g) 设置页三行主题控件的挂点必须齐。
     色卡容器是 JS 生成的，HTML 里只有一个空 div —— 所以只能靠 id 钉。
     少一个挂点 = 那一行永远空白，而且 JS 里 `$(...)` 返回 null 时不报错。 */
  {
    const need = [
      ['#segTheme', '亮暗模式分段按钮组'],
      ['#themeSwatches', '配色方案色卡容器'],
      ['#themeAccent', '自定义主色取色器'],
      ['#btnAccentReset', '恢复跟随配色方案的按钮']
    ];
    const missing = need.filter(([sel]) => optHtml.indexOf('id="' + sel.slice(1) + '"') < 0);
    if (!missing.length) ok('设置页四个主题挂点齐全（' + need.map(([s]) => s).join(' / ') + '）');
    else bad('设置页缺少主题挂点：' + missing.map(([s, d]) => s + '（' + d + '）').join('、'));
  }

  /* (h) theme.css 里的 token 名必须和 theme.js 的 TOKENS 对得上。
     对不上的后果很隐蔽：apply() 写了一个 CSS 里不存在的变量（没人用），
     clearAccent() 又漏掉了真正在用的那个（红色清不掉）。 */
  {
    const tokensM = themeJs.match(/const TOKENS = \[([^\]]+)\]/);
    if (!tokensM) {
      bad('theme.js 里找不到 TOKENS 数组 —— 本节的 token 对齐断言失去意义');
    } else {
      const tokens = Array.from(tokensM[1].matchAll(/'(--[\w-]+)'/g)).map((m) => m[1]);
      const missing = tokens.filter((t) => themeCss.indexOf(t + ':') < 0 && themeCss.indexOf(t + ' :') < 0);
      if (tokens.length >= 5 && !missing.length) {
        ok('theme.js 的 ' + tokens.length + ' 个内联 token 都能在 theme.css 里找到');
      } else if (missing.length) {
        bad('theme.js 会写这些 theme.css 里不存在的变量：' + missing.join(', '));
      } else {
        bad('从 TOKENS 里只解析出 ' + tokens.length + ' 个变量 —— 解析正则可能脱节了');
      }
    }
  }

  /* (i) 内容脚本不能直接改宿主页面 <html> 的主题。
     这条是「反向守卫」：applyToHost 是唯一允许写主题的地方，
     它必须只写自己的 shadow host。直接往 document.documentElement 上写
     会把宿主网站自己的深色模式开关顶掉（视觉上是"这个扩展坏了我的网站"）。 */
  {
    const contentFiles = ['content/main.js', 'content/hover.js', 'content/lightbox.js', 'content/panel.js'];
    const offenders = [];
    contentFiles.forEach((rel) => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/documentElement\.setAttribute\(\s*['"]data-ih-theme['"]/.test(src)) offenders.push(rel);
    });
    if (!offenders.length) ok('内容脚本没有直接往宿主页面 <html> 上写主题（只走 applyToHost）');
    else bad('这些内容脚本直接改了宿主页面的主题属性，会顶掉网站自己的深浅色开关：' + offenders.join('、'));
  }
}

console.log('\n=== 20. 顶栏收敛与筛选条默认态 ===');
{
  /* 这一节守的是「HTML 与 JS 对同一件事说法一致」。
     browser-topbar.js 能证明运行起来是对的，但有几处它观测不到 ——
     尤其是**首帧**（JS 还没跑时）HTML 自带的属性：
     JS 跑起来之后会把两处都改对，注入验证因此会假绿（我实际踩到了），
     但用户看到的那一帧闪动是真的。那条只能静态守。 */

  /* (a) 三张组件样式表里不该再有「拟物」的上下渐变底色。
     判据：.icon-btn / .pill / .size-slider / .topbar 的规则块里出现
     linear-gradient(180deg, ...) 就是回退了。
     （主色填充的渐变 —— 角标、选中的 chip、进度条、主按钮 —— 是另一回事，
     它们本来就是实色块，不在这一节的范围内。） */
  {
    const popCss = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = [];
    ['.topbar', '.icon-btn', '.pill', '.size-slider'].forEach((sel) => {
      /* 扫以该选择器**开头**的规则块（可带 [data-theme=...] 前缀的那种另算，
         这里只看基础块）。用大括号配对，不按行扫 —— 单行写法会漏。 */
      const re = new RegExp('(^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        + '\\s*\\{([^{}]*)\\}', 'g');
      let m;
      while ((m = re.exec(popCss))) {
        if (/linear-gradient\s*\(\s*180deg/.test(m[2])) offenders.push(sel);
      }
      // 深色档的覆盖块（[data-theme="dark"] .pill {...}）
      const re2 = new RegExp('\\[data-theme="dark"\\]\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        + '\\s*\\{([^{}]*)\\}', 'g');
      let m2;
      while ((m2 = re2.exec(popCss))) {
        if (/linear-gradient\s*\(\s*180deg/.test(m2[1])) offenders.push('[dark] ' + sel);
      }
    });
    if (!offenders.length) ok('顶栏 / 图标按钮 / 胶囊 / 滑条都没有拟物渐变底色（回退就会被抓）');
    else bad('这些控件又用回了线性渐变「打光」，顶栏会比图片还重：' + offenders.join('、'));
  }

  /* (b) 八个动作必须**全部**是顶栏的直接子元素。
     曾经试过把三条收进「更多」溢出菜单，后来改回常驻 ——
     所以这里同时守两件事：id 都在，且**没有**溢出菜单的残留。
     （残留的 .menu 是绝对定位，会把后面所有东西的层叠顺序搅乱。） */
  {
    const need = ['btnRescan', 'btnProbe', 'btnExport', 'btnDeep',
      'btnPanel', 'btnOptions', 'btnClose'];
    const missing = need.filter((id) => popupHtml.indexOf('id="' + id + '"') < 0);
    if (!missing.length) ok('顶栏七个按钮的 id 都在 HTML 里（含独立页不显示的关闭）');
    else bad('顶栏缺这些 id（按钮会点了不动）：' + missing.join('、'));

    /* 溢出菜单的痕迹：容器类/id、锚点按钮、菜单项标记 */
    const leftovers = [];
    if (/id="moreMenu"/.test(popupHtml)) leftovers.push('#moreMenu');
    if (/id="btnMoreMenu"/.test(popupHtml)) leftovers.push('#btnMoreMenu');
    if (/\bclass="[^"]*\bmenu-item\b/.test(popupHtml)) leftovers.push('.menu-item');
    if (!leftovers.length) ok('溢出菜单已彻底移除（没有 #moreMenu / #btnMoreMenu / .menu-item 残留）');
    else bad('溢出菜单的残留物还在 HTML 里 —— 绝对定位残留会搅乱顶栏层叠：' + leftovers.join('、'));

    /* popup.css 里也不该再有菜单规则块 */
    const popCss2 = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const cssLeft = [];
    ['\\.menu\\b', '\\.menu-item\\b', '\\.menu-txt\\b', '\\.menu-name\\b', '\\.menu-sub\\b']
      .forEach((sel) => { if (new RegExp(sel).test(popCss2)) cssLeft.push(sel.replace(/\\\\/g, '')); });
    if (!cssLeft.length) ok('popup.css 里也没有菜单样式残留');
    else bad('popup.css 还留着菜单样式：' + cssLeft.join('、'));
  }

  /* (c) 三条动作必须是**顶栏的直接子按钮**（不是菜单项、不是别的容器里的）。
     判据：在 .hdr-actions 到 </header> 之间，三个 id 各自出现在
     一个 `class="icon-btn"` 的 <button> 上，且 .hdr-actions 里没有任何
     role="menu" 的容器。 */
  {
    const iActions = popupHtml.indexOf('class="hdr-actions"');
    const iEnd = popupHtml.indexOf('</header>', iActions < 0 ? 0 : iActions);
    if (iActions >= 0 && iEnd > iActions) {
      const block = popupHtml.slice(iActions, iEnd);
      const notIconBtn = ['btnProbe', 'btnExport', 'btnDeep'].filter((id) => {
        // 找到这个 id 所在的整个开标签，确认它是 icon-btn 的 button
        const m = block.match(new RegExp('<(\\w+)([^>]*id="' + id + '"[^>]*)>'));
        if (!m) return true;
        return m[1].toLowerCase() !== 'button' || !/class="[^"]*\bicon-btn\b/.test(m[2]);
      });
      const hasMenuRole = /role="menu"/.test(block);
      if (!notIconBtn.length && !hasMenuRole) {
        ok('探测 / 导出 / 深度嗅探都是顶栏的 icon-btn 常驻按钮（不是菜单项）');
      } else {
        bad('顶栏结构不对 —— 这些不是常驻 icon-btn：' + (notIconBtn.join('、') || '（无）')
          + (hasMenuRole ? '；顶栏里仍有 role="menu" 容器' : ''));
      }
    } else {
      bad('找不到 .hdr-actions / </header> 的位置 —— 解析可能脱节了');
    }
  }

  /* (d) 筛选条的两个「默认收起」标记必须**同时**是收起态：
     HTML 上 aria-expanded="false" 与 元素带 hidden。
     只翻一处，JS 跑起来之前那一帧就是错的（按钮说收起了、条还挂着）。 */
  {
    const btnTag = (popupHtml.match(/<button[^>]*id="btnFilters"[^>]*>/) || [''])[0];
    const panelTag = (popupHtml.match(/<div[^>]*id="filterPanel"[^>]*>/) || [''])[0];
    const btnCollapsed = /aria-expanded="false"/.test(btnTag);
    const panelHidden = /\shidden(\s|>)/.test(panelTag);
    if (btnCollapsed && panelHidden) {
      ok('筛选条首帧就是收起的（按钮 aria-expanded=false 且面板 hidden，两处一致）');
    } else {
      bad('筛选条的默认态两处不一致 —— 按钮说收起=' + btnCollapsed + '，面板 hidden=' + panelHidden
        + '（首帧会闪一下展开的条）');
    }
  }

  /* (e) 三条动作必须真的接到 handler 上（直接 addEventListener，
     不再是走菜单的 bindMenuItem）。搬 DOM 不搬绑定是这类重构最常见的坏法。 */
  {
    const js = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const need = [
      ["$('btnProbe').addEventListener('click'", '探测体积'],
      ["$('btnExport').addEventListener('click'", '导出清单'],
      ["$('btnDeep').addEventListener('click'", '深度嗅探']
    ];
    const missing = need.filter(([frag]) => js.indexOf(frag) < 0).map(([, label]) => label);
    if (!missing.length) ok('三个动作都直接绑了 click（不走菜单转发了）');
    else bad('这些动作没接上 handler，点了不会动：' + missing.join('、'));

    /* 菜单控制器必须清干净 —— 留着就是死代码，而且会被下次改动当成线索 */
    const dead = ['menuOpen', 'closeMenu', 'setMenu', 'bindMenuItem', 'menuItems']
      .filter((name) => new RegExp('function\\s+' + name + '\\s*\\(').test(js));
    if (!dead.length) ok('菜单控制器（setMenu / closeMenu / bindMenuItem …）已删除');
    else bad('popup.js 里还留着菜单控制器死代码：' + dead.join('、'));
  }

  /* (f) 滑条停在默认值时不算「在筛」。
     这条是这一版修补的**真实缺陷**：筛条常驻时角标常显 1 只是噪音，
     但筛条默认收起后，那个恒亮的「1」会让用户以为自己在筛、
     打开一看五个维度全是默认。 */
  {
    const js = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/filters\.sizeMin\s*!==\s*SIZE_MIN_DEFAULT/.test(js)) {
      ok('滑条停在默认值时不计入「生效条件」（角标不会恒亮 1）');
    } else if (/filters\.sizeMin\s*>\s*0/.test(js)) {
      bad('滑条又用 `sizeMin > 0` 当判据了 —— 默认值 256 会让角标永远亮着「1」');
    } else {
      bad('找不到滑条是否计入筛选数量的判据 —— 解析可能脱节了');
    }
  }
  /* (g) 搜索必须搬进**顶栏动作组**里，而且不再出现在工具行里。
     为什么静态守：这条纯属「DOM 位置」，运行时怎么看都对 ——
     但一旦有人把它挪回 .ctrl-bar，顶栏就会少一个动作、
     而工具行会多一个「主动去够东西」的按钮，和旁边那排被动控件不搭。
     另外它必须是 .hdr-actions 的**直接子元素**（包在 .search-wrap 里），
     不是 .hdr 的独立一项 —— 后者在 380px 面板下会多一个 12px 间隙把顶栏挤爆。 */
  {
    const iA = popupHtml.indexOf('class="hdr-actions"');
    const iEnd = popupHtml.indexOf('</header>', iA < 0 ? 0 : iA);
    const hdrBlock = (iA >= 0 && iEnd > iA) ? popupHtml.slice(iA, iEnd) : '';
    const iBar = popupHtml.indexOf('class="ctrl-bar"');
    const iBarEnd = popupHtml.indexOf('</div>', iBar < 0 ? 0 : iBar);
    const barBlock = (iBar >= 0 && iBarEnd > iBar) ? popupHtml.slice(iBar, iBarEnd) : '';

    const inHdr = /id="btnSearch"/.test(hdrBlock);
    const wrapDirect = /<div class="search-wrap">/.test(hdrBlock);
    const inBar = /id="btnSearch"/.test(barBlock);
    if (inHdr && wrapDirect && !inBar) {
      ok('搜索按钮在顶栏动作组里（且已从工具行搬走）');
    } else {
      bad('搜索的位置不对 —— 在顶栏=' + inHdr + '，是动作组直接子元素=' + wrapDirect
        + '，还在工具行=' + inBar);
    }
  }

  /* (h) 排序必须是「一个维度下拉 + 一个升降序按钮」两个控件。
     核心判据是**下拉里只剩维度** —— 只要还留着 'area-asc' / 'size-asc'
     这类成对值，就说明方向没有被真正拆出去（那正是这一版要整合的东西）。 */
  {
    const selBlock = (popupHtml.match(/<select[^>]*id="selSort"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || '';
    const vals = Array.from(selBlock.matchAll(/<option[^>]*value="([^"]+)"/g)).map((m) => m[1]);
    const want = ['area', 'size', 'order', 'host'];
    const hasDirBtn = /id="btnSortDir"/.test(popupHtml);
    const pairedLeft = vals.filter((v) => /-(asc|desc)$/.test(v));
    if (vals.join(',') === want.join(',') && hasDirBtn && !pairedLeft.length) {
      ok('排序 = 4 个维度下拉 + 1 个升降序按钮（方向已从下拉里拆出去）');
    } else {
      bad('排序结构不对 —— 维度=' + (vals.join(',') || '（空）')
        + '，方向按钮=' + hasDirBtn
        + (pairedLeft.length ? '，下拉里还留着成对的方向值：' + pairedLeft.join('、') : ''));
    }

    /* 方向按钮必须真的在工具行里、并且接到 handler 上（搬 DOM 不搬绑定是常见坏法） */
    const iBar2 = popupHtml.indexOf('class="ctrl-bar"');
    const iBar2End = popupHtml.indexOf('</div>', iBar2 < 0 ? 0 : iBar2);
    const bar2 = (iBar2 >= 0 && iBar2End > iBar2) ? popupHtml.slice(iBar2, iBar2End) : '';
    const js2 = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const bound = /\$\('btnSortDir'\)\.addEventListener\('click'/.test(js2);
    if (/id="btnSortDir"/.test(bar2) && bound) {
      ok('升降序按钮在工具行里、且真的绑了 click');
    } else {
      bad('升降序按钮不对 —— 在工具行=' + /id="btnSortDir"/.test(bar2) + '，绑了 click=' + bound);
    }
  }

  /* (i) 「默认排序」这条设置必须三处齐备：默认值、设置页入口、图库读取点。
     少任何一处都是「静默无效」：设置页改了没反应，或者导出的 JSON 里没这个键。 */
  {
    const constSrc2 = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
    const optSrc = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
    const js3 = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
    const hasDefault = /^\s{4}defaultSort\s*:/m.test(constSrc2);
    const hasUi = /data-key\s*=\s*["']defaultSort["']/.test(optSrc);
    // 图库必须**真的**读了它（不是只在注释里提一句）
    const reads = /Store\.getSettings\(\)\.defaultSort/.test(js3);
    if (hasDefault && hasUi && reads) {
      ok('「默认排序」三处齐备（默认值 / 设置页下拉 / 图库读取点）');
    } else {
      bad('「默认排序」不完整 —— 默认值=' + hasDefault + '，设置页入口=' + hasUi
        + '，图库读取点=' + reads);
    }

    /* 图库那 4 个维度值必须和设置页下拉的 6 个组合**同源**：
       设置页写 'area:desc' 这种两段式，图库用 parseSort 解析。
       两边对不上（比如设置页写 'resolution'）就是「选了没效果」。 */
    const opts = Array.from(optSrc.matchAll(/<option[^>]*value="([^"]+)"[^>]*data-i18n="opt\.sort/g))
      .map((m) => m[1]);
    const badSpec = opts.filter((v) => !/^(area|size|order|host):(desc|asc)$/.test(v));
    const dimsOk = new RegExp('SORT_DIMS\\s*=\\s*\\[[^\\]]*\'area\'[^\\]]*\'size\'[^\\]]*\'order\'[^\\]]*\'host\'', 's')
      .test(js3);
    if (opts.length >= 4 && !badSpec.length && dimsOk) {
      ok('设置页的排序组合（' + opts.length + ' 项）与图库的维度表对得上');
    } else {
      bad('设置页排序值与图库对不上 —— 非法项：' + (badSpec.join('、') || '（无）')
        + '，图库维度表=' + dimsOk);
    }
  }
}

console.log('\n-----------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
