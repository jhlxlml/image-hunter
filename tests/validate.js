/* 交付完整性校验：manifest 引用、HTML 资源引用、getURL 路径、图标尺寸 */
const fs = require('fs');
const path = require('path');

const ROOT = require('path').resolve(__dirname, '..');
let pass = 0, fail = 0;

function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

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
  ['shared/store.js', 'content/scanner.js', 'store 先于 scanner'],
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
if (/图库里没有这张图/.test(popupCode)) {
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
// 一旦它们被误判成"没有界面可以改"，说明 hasUi 的识别又漏了一类形态
['theme', 'blockedHosts', 'customRules'].forEach((k) => {
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
  if (/还没有勾选要嗅探的页面/.test(popupJsSrc)) {
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
  if (/<p class="sr-only" id="gridHelp">/.test(popupHtml)) ok('#gridHelp 是 sr-only（视觉不占位、无障碍树里在）');
  else bad('#gridHelp 缺失或不是 sr-only');
  const helpText = (popupHtml.match(/<p class="sr-only" id="gridHelp">([\s\S]*?)<\/p>/) || [])[1] || '';
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
  const scriptIdx = optHtml.indexOf('shared/diagnostics.js');
  const optJsIdx = optHtml.indexOf('options.js');
  if (scriptIdx >= 0 && scriptIdx < optJsIdx) ok('diagnostics.js 在 options.js 之前加载（IH.Diag 先就位）');
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

  // (c) 给用户看的那句话不能读起来像「这页没图」
  const noReplyText = (/const SCAN_NO_REPLY = ([\s\S]*?);\n/.exec(bgSrc3) || [])[1] || '';
  if (noReplyText && !/没有发现图片/.test(noReplyText)) {
    ok('「没扫成」的文案里没有「没有发现图片」这种会被读成「这页没图」的说法');
  } else {
    bad('SCAN_NO_REPLY 文案会把「没扫成」说成「这页没图」', noReplyText);
  }
  if (/刷新|加载/.test(noReplyText)) ok('「没扫成」的文案给了可操作的建议（刷新 / 等加载完）');
  else bad('SCAN_NO_REPLY 没告诉用户该怎么办');

  // (d) 图库侧：错误分支必须**早于**空页面分支，而且各自说各自的话
  const iFail = popupSrc.indexOf("showEmpty('嗅探失败");
  const iNoImg = popupSrc.indexOf('本页没有发现图片');
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

console.log('\n-----------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
