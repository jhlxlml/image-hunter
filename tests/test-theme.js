/* ImageHunter — 主题系统行为测试
 *
 * 这个套件守的是 shared/theme.js 与 shared/theme.css 的**机制**，不是
 * 「哪个颜色好看」。它要挡住的是几类「看起来没坏、其实是错的」情形：
 *
 *   1. **theme.css 的兜底值和推导值漂了。**
 *      没有 JS 时（设置页被禁用脚本打开、或者脚本报错）界面用的是 theme.css
 *      里手写的那套值；有 JS 时用的是 derive() 算出来的。两者必须**逐字符相等**——
 *      不相等就是「同一个默认主题、两种颜色」，而且差得越小越难发现。
 *      这是本套件里最值得钉的一条。
 *
 *   2. **自定义主色只改主色，不改派生值。**
 *      散落在 CSS 里的 rgba(79,110,247,…) 有 9 处，是主色投影。用户换成橙色
 *      之后如果它们还留在蓝色上，就是一圈蓝色光晕围着一个橙色按钮 ——
 *      而单看按钮是「对的」。所以要断言派生值确实跟着主色变了。
 *
 *   3. **「跟随预设」切不回去。**
 *      themeAccent 从 '#ff0000' 变回 '' 时，如果内联 style 上的 --primary
 *      没被清掉，红色会一直赖着 —— 界面看着正常（红色也挺好看），
 *      但用户的操作为什么都没生效这件事无迹可循。
 *
 *   4. **非法输入让整页失去颜色。**
 *      themeAccent 是用户能从导入的 JSON 里塞任意字符串的字段。
 *      塞一个 '#zzz' 进去，如果不做校验就 setProperty，浏览器会丢弃这条声明 ——
 *      界面失去主色（按钮变灰、选中态没了），而控制台一片安静。
 *
 *   5. **深色档拿浅色档的主色。**
 *      深底上用 #4f6ef7 对比度不够（看不清），所以深色档的主色是**另一组值**。
 *      断言 resolve() 在深色下取的是深色档，不是浅色档。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const themeSrc = fs.readFileSync(path.join(BASE, 'shared/theme.js'), 'utf8');
const themeCss = fs.readFileSync(path.join(BASE, 'shared/theme.css'), 'utf8');
const constSrc = fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8');
const utilSrc = fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8');

const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  if (actual === expected) ok(label);
  else bad(label, 'got ' + JSON.stringify(actual) + ' / want ' + JSON.stringify(expected));
}

/* ------------------------------------------------------------------ *
 * 上下文：jsdom 提供 document，chrome.storage 桩喂设置。
 * 语言钉成 zh —— 不是这个套件要测的东西，但钉死之后「本地绿、CI 红」
 * 这类由 runner 语言差异引起的假失败不会混进来（见 tests/README.md）。
 * ------------------------------------------------------------------ */
function themeCtx(settings, opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://example.com/',
    runScripts: 'outside-only'
  });
  const ctx = dom.getInternalVMContext();
  ctx.console = console;
  /* navigator 在 jsdom 里是只有 getter 的属性，直接赋值会抛
     「Cannot set property navigator ... which has only a getter」。
     主题逻辑本身不读 navigator（语言靠设置里的 uiLang 钉死），
     所以这里只需要把 language 改掉，方便任何间接读它的代码走中文分支。 */
  try {
    Object.defineProperty(ctx.navigator, 'language', { value: 'zh-CN', configurable: true });
  } catch (e) { /* jsdom 版本差异，兜底忽略 */ }

  /* 系统深浅色用 matchMedia 桩模拟。prefersDark 决定 'auto' 落到哪一档。
     注意：ctx 是 jsdom 的 vm context，window / navigator / matchMedia 都是
     只有 getter 的属性，直接 `ctx.window = ctx` 会抛
     「Cannot set property window ... which has only a getter」。
     matchMedia 上也要 defineProperty 而不是赋值（同一原因）。

     prefersDark 用**对象**包住而不是裸布尔：配套的 setDark() 要能在上下文
     建好之后翻转它，桩闭包读到新值。裸 const 会让「模拟系统切换」这个动作
     变成空操作 —— 测试里表现为「回调触发了、界面没动」，看起来像产品 bug。 */
  const sys = { dark: !!o.prefersDark };
  const listeners = [];
  const setDark = (v) => { sys.dark = !!v; };
  const matchMediaStub = (q) => ({
    matches: /prefers-color-scheme:\s*dark/.test(q) ? sys.dark : false,
    addEventListener: (type, fn) => { if (type === 'change') listeners.push(fn); },
    removeEventListener: () => {}
  });

  try {
    Object.defineProperty(ctx, 'matchMedia', { value: matchMediaStub, configurable: true, writable: true });
  } catch (e) {
    throw new Error('无法注入 matchMedia 桩，jsdom 版本可能不兼容：' + e.message);
  }

  const stored = Object.assign({ uiLang: 'zh' }, settings || {});
  ctx.chrome = {
    runtime: { lastError: undefined, getURL: (p) => p, onMessage: { addListener() {} } },
    storage: {
      local: {
        get: () => Promise.resolve({ ih_settings: stored }),
        set: () => Promise.resolve()
      },
      onChanged: { addListener() {} }
    }
  };

  const load = (src) => vm.runInContext(src, ctx);
  load(constSrc);
  load(utilSrc);
  load(storeSrc);
  load(themeSrc);

  return { dom, ctx, IH: ctx.IH, doc: dom.window.document, listeners, sys, setDark };
}

async function readyCtx(settings, opts) {
  const env = themeCtx(settings, opts);
  await env.IH.Store.loadSettings();
  return env;
}

/** 从 theme.css 里抠出某个选择器块内的自定义属性 */
function cssVars(selector) {
  const i = themeCss.indexOf(selector);
  if (i < 0) throw new Error('theme.css 里找不到选择器：' + selector);
  const s = themeCss.indexOf('{', i);
  const e = themeCss.indexOf('}', s);
  const out = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(themeCss.slice(s + 1, e)))) out[m[1]] = m[2].trim();
  return out;
}

(async function run() {
  /* ================================================================ *
   * 1. theme.css 与推导值严格一致
   *
   * 这是本套件最重要的一条：兜底值（CSS）与运行时值（JS）必须逐字符相等，
   * 否则「没设过主题」与「选了默认预设」会渲染出两个略有差异的颜色。
   * 差异越小越危险 —— 大差异一眼看得出，末位差 1 一辈子发现不了。
   * ================================================================ */
  console.log('=== 1. theme.css 兜底值 === 推导值 ===');
  {
    const env = await readyCtx({});
    const T = env.IH.Theme;

    const rootCss = cssVars('\n:root {');
    const darkCss = cssVars('\n[data-theme="dark"] {');

    ['--primary', '--primary-dark', '--primary-soft', '--primary-soft-2',
      '--primary-ring', '--primary-shadow', '--primary-shadow-strong',
      '--primary-solid'].forEach((k) => {
      const light = T._derive('#4f6ef7', 'light')[k];
      eq(rootCss[k], light, '浅色 ' + k + ' 与 derive() 输出一致');
      const dark = T._derive('#6b86ff', 'dark')[k];
      eq(darkCss[k], dark, '深色 ' + k + ' 与 derive() 输出一致');
    });

    /* 兜底值本身也必须和 PRESETS.indigo 对得上 ——
       「写死的 #4f6ef7」不能和「预设表的 indigo」各走各的。 */
    eq(T.PRESETS.indigo.light, '#4f6ef7', 'PRESETS.indigo.light 就是 theme.css 里那个 #4f6ef7');
    eq(T.PRESETS.indigo.dark, '#6b86ff', 'PRESETS.indigo.dark 就是深色档那个 #6b86ff');
  }

  /* ================================================================ *
   * 2. 亮暗档 + auto 的判定
   * ================================================================ */
  console.log('\n=== 2. 亮暗档判定 ===');
  {
    const light = await readyCtx({ theme: 'light' });
    const dark = await readyCtx({ theme: 'dark' });
    eq(light.IH.Theme.resolve().mode, 'light', "theme='light' → mode=light");
    eq(dark.IH.Theme.resolve().mode, 'dark', "theme='dark' → mode=dark");
    eq(dark.IH.Theme.resolve().rawMode, 'dark', 'rawMode 保留用户原值（设置页高亮要用它）');

    /* 'auto' 靠 matchMedia 决定。两条都要测 —— 只测一条的话，
       把 matches 写反（或者对 q 的判断写反正）不会被发现。 */
    const autoLight = await readyCtx({ theme: 'auto' }, { prefersDark: false });
    const autoDark = await readyCtx({ theme: 'auto' }, { prefersDark: true });
    eq(autoLight.IH.Theme.resolve().mode, 'light', "theme='auto' + 系统浅色 → light");
    eq(autoDark.IH.Theme.resolve().mode, 'dark', "theme='auto' + 系统深色 → dark");
    eq(autoDark.IH.Theme.resolve().rawMode, 'auto', "auto 时 rawMode 仍是 'auto'（不是解析出来的 dark）");

    /* 老版本存下来的设置里没有 theme 这个键 —— 必须退到浅色，不能是 undefined */
    const legacy = await readyCtx({});
    eq(legacy.IH.Theme.resolve().mode, 'light', '没有 theme 键（老设置）→ 退到浅色');

    /* 手选了亮色就**不该**被系统深浅色影响 —— 否则「手选」这个动作白做了 */
    const forced = await readyCtx({ theme: 'light' }, { prefersDark: true });
    eq(forced.IH.Theme.resolve().mode, 'light', '手选浅色 + 系统深色 → 仍是浅色（系统不该覆盖手选）');
  }

  /* ================================================================ *
   * 3. apply：写 data-theme + 内联主色
   * ================================================================ */
  console.log('\n=== 3. apply 写入 DOM ===');
  {
    const env = await readyCtx({ theme: 'dark', themePreset: 'teal' });
    const root = env.doc.documentElement;
    const r = env.IH.Theme.apply(env.doc);

    eq(root.getAttribute('data-theme'), 'dark', "apply 写了 data-theme='dark'");
    eq(r.mode, 'dark', 'apply 返回解析结果（调用方不用再算一遍）');

    /* 主色应当写在内联 style 上（优先级高于 :root 与 [data-theme]） */
    const st = root.style;
    eq(st.getPropertyValue('--primary').trim(), '#3fc7b8', 'teal 深色档主色写进了内联 style');
    check(!!st.getPropertyValue('--primary-shadow'), '主色投影也写进去了（否则会留着蓝色光晕）');

    /* 深色档 ≠ 浅色档 —— 拿错档的话深底上对比度不够 */
    check(st.getPropertyValue('--primary').trim() !== '#0f9b8e',
      '深色档取的不是浅色档那个值（深底上浅色主色看不清）');
  }

  /* ================================================================ *
   * 4. 自定义主色的派生值
   *
   * 用户只给一个颜色，其余七个全要跟着变。漏掉任何一个：
   * 橙色按钮配蓝色光晕 / 橙色按钮配蓝色 ring。
   * ================================================================ */
  console.log('\n=== 4. 自定义主色的派生 ===');
  {
    const env = await readyCtx({ theme: 'light', themeAccent: '#ff8800' });
    const T = env.IH.Theme;
    const r = T.resolve();

    eq(r.accent, '#ff8800', '自定义主色生效');
    eq(r.isCustomAccent, true, 'isCustomAccent 标出来（设置页据此禁用「恢复」按钮）');
    eq(r.derived['--primary'], '#ff8800', '--primary 就是用户给的颜色');

    /* 派生值必须是**这个颜色**的，不能是从别处抄来的 */
    const d = r.derived['--primary-soft'];
    check(d.indexOf('255, 136, 0') >= 0, '--primary-soft 用的是自定义主色的 RGB，不是默认蓝', d);
    check(r.derived['--primary-shadow'].indexOf('255, 136, 0') >= 0,
      '--primary-shadow 也跟着换（否则橙色按钮带蓝色光晕）', r.derived['--primary-shadow']);
    check(r.derived['--primary-ring'].indexOf('255, 136, 0') >= 0,
      '--primary-ring 也跟着换（否则 spinner 的轨道还是蓝的）');
    /* --primary-solid 是图库卡片角标（.badge.restored）的底色。
       它压在照片上，所以是 .92 而不是纯色 —— 但它同样是**主色**，
       漏掉它的话用户换成橙色后角标还是蓝的，而角标面积小、很容易漏看。 */
    check(r.derived['--primary-solid'].indexOf('255, 136, 0') >= 0,
      '--primary-solid 也跟着换（否则「原图还原」角标还是蓝的）', r.derived['--primary-solid']);
    check(/0\.92\)$/.test(r.derived['--primary-solid']),
      '--primary-solid 保持 .92 不透明度（压在照片上要够实）', r.derived['--primary-solid']);

    /* --primary-dark 应当是同色相的加深，不是某个固定的蓝 */
    check(r.derived['--primary-dark'] !== '#3c5adc',
      '--primary-dark 不是默认蓝的深色档（说明确实按色相重算了）', r.derived['--primary-dark']);

    /* 写进 DOM 之后能取出来 */
    T.apply(env.doc);
    eq(env.doc.documentElement.style.getPropertyValue('--primary').trim(), '#ff8800',
      '自定义主色真的写到了 <html> 上');
  }

  /* ================================================================ *
   * 5. 「跟随预设」要能切回去
   *
   * themeAccent 从有值变回空串时，内联 style 必须被**清掉** ——
   * 不清的话红色会一直赖着，而界面看着完全正常（红色也挺好看）。
   * ================================================================ */
  console.log('\n=== 5. 切回跟随预设 ===');
  {
    const env = await readyCtx({ theme: 'light', themeAccent: '#ff0000', themePreset: 'teal' });
    const root = env.doc.documentElement;
    const T = env.IH.Theme;

    T.apply(env.doc);
    eq(root.style.getPropertyValue('--primary').trim(), '#ff0000', '先自定义成红色');

    // 把设置改回「跟随预设」，再 apply
    const s = env.IH.Store.getSettings();
    s.themeAccent = '';
    const r = T.apply(env.doc, s);

    eq(r.isCustomAccent, false, 'themeAccent 空了 → isCustomAccent=false');
    eq(r.accent, T.PRESETS.teal.light, '主色回到所选预设（teal）');
    eq(root.style.getPropertyValue('--primary').trim(), T.PRESETS.teal.light,
      '内联 style 上写的是预设主色（不是残留的红色）');

    /* 再验一次「彻底清干净」：直接清空内联之后应当取不到任何主色 ——
       说明 clearAccent 把七个变量全删了，而不是只删了 --primary。 */
    T.clearAccent(env.doc);
    ['--primary', '--primary-dark', '--primary-soft', '--primary-soft-2',
      '--primary-ring', '--primary-shadow', '--primary-shadow-strong',
      '--primary-solid'].forEach((k) => {
      eq(root.style.getPropertyValue(k), '', 'clearAccent 清掉了 ' + k);
    });
  }

  /* ================================================================ *
   * 6. 非法输入不能把界面搞成无色
   *
   * themeAccent 是能从导入的 JSON 里塞任意字符串的字段。
   * ================================================================ */
  console.log('\n=== 6. 非法 themeAccent 的兜底 ===');
  {
    const T = (await readyCtx({})).IH.Theme;

    [['#zzz', '明显非法'], ['', '空串'], ['red', '颜色名（不是 hex）'],
      ['#12345', '位数不对'], ['#12345678', '八位 hex（带 alpha，这套代数不吃）'],
      ['javascript:alert(1)', '恶意串'], ['#ff8800 ', '带尾空格（应当被 trim 后接受）']].forEach(([v, label]) => {
      const r = T.resolve({ theme: 'light', themePreset: 'rose', themeAccent: v });
      /* 唯一一个**应该**被接受的是带尾空格的合法 hex。
         其余全部要退回预设 —— 关键是 derived 不能是 null，
         否则 apply() 会去 clearAccent，界面就没了主色。 */
      if (v.trim() === '#ff8800') {
        eq(r.accent.toLowerCase(), '#ff8800', '带尾空格的合法 hex：' + label + ' → 接受');
      } else {
        eq(r.accent, T.PRESETS.rose.light, '非法输入退回预设：' + label);
      }
      check(r.derived !== null && r.derived !== undefined,
        'derived 不是空：' + label + '（否则 apply 会清掉主色、界面变灰）');
    });

    /* 写进 DOM 也不能出现浏览器会丢弃的值 */
    const env = await readyCtx({ theme: 'light', themeAccent: '#zzz' });
    env.IH.Theme.apply(env.doc);
    const got = env.doc.documentElement.style.getPropertyValue('--primary').trim();
    check(got !== '#zzz' && got !== '', '非法值没有被原样写进 style（写了会被浏览器丢弃）', got);
    eq(got, env.IH.Theme.PRESETS.indigo.light, '非法值时用的是预设主色');
  }

  /* ================================================================ *
   * 7. 预设表完整性
   * ================================================================ */
  console.log('\n=== 7. 预设表 ===');
  {
    const T = (await readyCtx({})).IH.Theme;
    const keys = Object.keys(T.PRESETS);
    check(keys.length >= 4, '至少 4 套预设（只有一两套谈不上「可自定义」）', String(keys.length));
    check(keys.indexOf(T.DEFAULT_PRESET) >= 0, 'DEFAULT_PRESET 确实在 PRESETS 里（否则默认值取出来是 undefined）');

    let badHex = [];
    let sameAccent = [];
    keys.forEach((k) => {
      const p = T.PRESETS[k];
      if (!T._parseHex(p.light) || !T._parseHex(p.dark)) badHex.push(k);
      /* 深浅两档必须不同：相同的话说明作者偷懒只填了一个，
         而深底上用浅色档主色是对比度不够的。 */
      if (p.light === p.dark) sameAccent.push(k);
      /* zh / en 两个名字字段也要有 —— presetList 会把它们带出来 */
    });
    eq(badHex.length, 0, '每套预设的深浅两档都是合法 hex');
    eq(sameAccent.length, 0, '每套预设的深色档都与浅色档不同（深底需要另一组值）');

    const list = T.presetList();
    eq(list.length, keys.length, 'presetList 覆盖全部预设');
    check(list.every((p) => p.key && p.light && p.dark), 'presetList 每项都带 key / light / dark');

    /* 未知预设名要退到默认，不能崩 */
    const unknown = T.resolve({ themePreset: '不存在的预设' });
    eq(unknown.preset, T.DEFAULT_PRESET, '未知预设名 → 退回默认预设');
  }

  /* ================================================================ *
   * 8. 页内 UI 的宿主主题（内容脚本用）
   *
   * 内容脚本不能改宿主页面的 <html>，所以主题写在 shadow host 元素上。
   * ================================================================ */
  console.log('\n=== 8. shadow host 主题 ===');
  {
    const env = await readyCtx({ theme: 'dark', themePreset: 'emerald' });
    const T = env.IH.Theme;
    const host = env.doc.createElement('div');

    T.applyToHost(host, env.IH.Store.getSettings());
    eq(host.getAttribute('data-ih-theme'), 'dark',
      "host 上是 data-ih-theme（不是 data-theme —— 别和宿主页面自己的主题撞车）");
    eq(host.style.getPropertyValue('--primary').trim(), T.PRESETS.emerald.dark,
      'host 上写的是深色档主色');

    /* 关键：**不能**碰宿主页面的 documentElement */
    eq(env.doc.documentElement.getAttribute('data-theme'), null,
      'applyToHost 不碰宿主页面的 <html>（那是别人的页面）');
    eq(env.doc.documentElement.style.getPropertyValue('--primary'), '',
      'applyToHost 不往宿主页面的根上写变量（会污染页面）');

    T.clearHost(host);
    eq(host.style.getPropertyValue('--primary'), '', 'clearHost 清掉了 host 上的变量');
  }

  /* ================================================================ *
   * 9. 系统深浅色监听
   * ================================================================ */
  console.log('\n=== 9. 系统深浅色监听 ===');
  {
    /* 翻转系统深浅色 = 改桩里的开关 + 手动调已注册的 change 回调。
       真实浏览器会替我们调回调，jsdom 不会；两件事少做一件就测不出东西。

       这里**不**去改 ctx.matchMedia：桩的闭包读的是 env.sys.dark，
       setDark() 改的就是它。早先的写法是给 ctx.matchMedia 赋一个新箭头函数，
       但 matchMedia 是只读 getter（赋值静默失败），而且桩本身根本没变 ——
       于是「系统切深色」变成了空操作，断言红得莫名其妙。 */
    const flipSystem = (env, dark) => {
      env.setDark(dark);
      env.listeners.forEach((fn) => fn());
    };

    /* 起一个 auto 上下文，并把监听挂上（apply 本身不挂 —— 挂监听是 watch 的事，
       所以这两条都要显式写，别指望 apply 顺手做了） */
    const bootAuto = async (theme, prefersDark) => {
      const env = await readyCtx({ theme }, { prefersDark });
      env.IH.Theme.apply(env.doc);
      env.IH.Theme.watch(env.doc, () => env.IH.Store.getSettings());
      return env;
    };

    /* theme='auto' 时系统切换要重算 */
    const autoEnv = await bootAuto('auto', false);
    eq(autoEnv.doc.documentElement.getAttribute('data-theme'), 'light', 'auto + 系统浅色 → light');
    eq(autoEnv.listeners.length > 0, true, 'watch() 确实挂上了监听（没挂上后面两条都是假绿）');
    flipSystem(autoEnv, true);
    eq(autoEnv.doc.documentElement.getAttribute('data-theme'), 'dark',
      'auto 时系统切深色 → 界面跟着变（图库页此前缺这条，见 theme.js 头注释）');

    /* 同一上下文里再切回浅色：监听得是**持续**有效的，不是只触发一次 */
    flipSystem(autoEnv, false);
    eq(autoEnv.doc.documentElement.getAttribute('data-theme'), 'light', 'auto 时系统切回浅色 → 界面跟着切回');

    /* theme='light' 时系统切换**不该**动界面 */
    const fixedEnv = await bootAuto('light', false);
    flipSystem(fixedEnv, true);
    eq(fixedEnv.doc.documentElement.getAttribute('data-theme'), 'light',
      '手选浅色时系统切深色 → 界面纹丝不动（手选优先于系统）');

    /* theme='dark' 同理：手选深色时系统切浅色也不该动 */
    const darkEnv = await bootAuto('dark', true);
    flipSystem(darkEnv, false);
    eq(darkEnv.doc.documentElement.getAttribute('data-theme'), 'dark',
      '手选深色时系统切浅色 → 界面同样纹丝不动');

    /* watch 是幂等的：同一文档重复挂不会叠加监听
       （叠加的后果是每次系统切换跑 N 遍 apply，面板多起来就是可感的卡顿） */
    const once = autoEnv.listeners.length;
    autoEnv.IH.Theme.watch(autoEnv.doc, () => autoEnv.IH.Store.getSettings());
    autoEnv.IH.Theme.watch(autoEnv.doc, () => autoEnv.IH.Store.getSettings());
    eq(autoEnv.listeners.length, once, '同一文档重复 watch() 不会叠加监听');
  }

  /* ================================================================ *
   * 10. 新增设置项受管
   * ================================================================ */
  console.log('\n=== 10. 主题设置项受管 ===');
  {
    const env = await readyCtx({});
    const DS = env.IH.C.DEFAULT_SETTINGS;

    /* 不在 DEFAULT_SETTINGS 里 = 导出→导入会被静默过滤掉，
       用户设好的配色导入一次备份就回到默认。 */
    eq(Object.keys(DS).indexOf('themePreset') >= 0, true, 'themePreset 在 DEFAULT_SETTINGS 里');
    eq(Object.keys(DS).indexOf('themeAccent') >= 0, true, 'themeAccent 在 DEFAULT_SETTINGS 里');
    eq(Object.keys(DS).indexOf('theme') >= 0, true, 'theme 在 DEFAULT_SETTINGS 里');

    eq(DS.themeAccent, '', 'themeAccent 默认是空串（= 跟随预设）');
    check(Object.keys(env.IH.Theme.PRESETS).indexOf(DS.themePreset) >= 0,
      'DEFAULT_SETTINGS.themePreset 是合法预设名（写错的话默认主色会退到 indigo）');

    /* 空串必须能被 JSON 往返 —— 用 null/undefined 的话导出时整个键会消失 */
    eq(JSON.parse(JSON.stringify({ a: DS.themeAccent })).a, '', 'themeAccent 默认值能 JSON 往返（不是 undefined）');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('套件异常退出：', e);
  process.exit(1);
});
