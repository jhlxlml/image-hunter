/* ==========================================================================
 * ImageHunter — shared/theme.js
 *
 * **全应用唯一的主题应用层。**
 *
 * 为什么单独抽一个文件（v1.15.0 之前不是这样）：
 *   `applyTheme()` 原来有两份几乎相同的实现 —— popup.js:709 与 options.js:45，
 *   差别只在签名（一份自己读 Store，一份收参数）。两份代码就是两条会各自
 *   漂移的路：设置页那份挂了 `matchMedia` 系统深浅色监听，图库页那份**没有**，
 *   于是「跟随系统」在图库页里只在你切页时才对一次，系统在用户盯着图库时
 *   切成深色，图库纹丝不动。
 *   合并到一处之后，「怎么算主题」与「算完写哪儿」只有一种答案。
 *
 * 用法：
 *   IH.Theme.apply(document, settings)      应用（settings 可省，自己去 Store 读）
 *   IH.Theme.resolve(settings)             只算不写，返回 { mode, accent, ... }（给测试）
 *   IH.Theme.watch(document, getSettings)   挂系统深浅色监听（每个页面调一次）
 *   IH.Theme.PRESETS                        预设配色表
 *
 * 加载顺序：必须在 store.js 之后（要读 settings），在 popup.js / options.js 之前。
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.Theme) return;

  /* ------------------------------------------------------------------ *
   * 预设配色
   *
   * 每套只给「浅色主色 + 深色主色」两个值，其余全部由主色推导（见 apply）。
   * 只让用户改一个颜色不是偷懒 —— 让用户填四个变量（主色 / 深色版 / 两个
   * 透明版 + 三个阴影色）的结果必然是其中几个不协调，而且没人会去调。
   *
   * 深色档的主色都要**单独给**，不能由浅色档自动算：
   * 深底上要的是「更亮、饱和度略低」，和浅底上的要求方向相反，
   * 拿同一个色相硬提明度会得到发灰或发荧光的颜色。
   * ------------------------------------------------------------------ */

  const PRESETS = {
    indigo: { zh: '靛蓝', en: 'Indigo', light: '#4f6ef7', dark: '#6b86ff' },
    teal:   { zh: '青碧', en: 'Teal',   light: '#0f9b8e', dark: '#3fc7b8' },
    emerald:{ zh: '翡翠', en: 'Emerald',light: '#12915a', dark: '#41c98a' },
    rose:   { zh: '玫红', en: 'Rose',   light: '#d9427a', dark: '#f2749f' },
    amber:  { zh: '琥珀', en: 'Amber',  light: '#c2760a', dark: '#e5a53a' },
    /* slate 用中性灰蓝，与文字色系同族，是六套里最「低调」的一档 ——
       它的作用不是好看，是给「不想有任何彩色强调」的人一个出口。 */
    slate:  { zh: '石板', en: 'Slate',  light: '#5b6b8c', dark: '#94a3b8' }
  };

  const DEFAULT_PRESET = 'indigo';

  /* ------------------------------------------------------------------ *
   * 颜色换算
   *
   * 不用 CSS 的 color-mix()：那需要 Chrome 111+，而 manifest 写着
   * minimum_chrome_version: 102。为了几个派生色把最低版本抬上去不值得。
   * ------------------------------------------------------------------ */

  /** '#rrggbb' 或 '#rgb' → {r,g,b}；非法返回 null */
  function parseHex(hex) {
    if (typeof hex !== 'string') return null;
    let s = hex.trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.min(100, Math.max(0, s)) / 100;
    l = Math.min(100, Math.max(0, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2]);
  }

  /**
   * 由主色推出全套派生值。
   *
   * 返回的键名就是 **CSS 变量名**（含 `--` 前缀）—— 这样 apply() 与
   * applyToHost() 都能直接 `setProperty(k, v)` 循环写下去，
   * 不需要任何「soft2 ↔ --primary-soft-2」这类翻译层。
   * 之前用驼峰短名做中间表示，正是这类翻译最容易悄悄对错的地方。
   */
  function derive(accent, mode) {
    const rgb = parseHex(accent);
    if (!rgb) return null;
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const dark = mode === 'dark';
    const a = (alpha) => 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + alpha + ')';

    return {
      '--primary': accent,
      /* --primary-dark 是「按下 / 悬停加深」档。
         两条曲线的系数是从 v1.14.0 手写的那两对值反推出来的：
           浅色  #4f6ef7 → #3b5bdb   （明度 −9.4、饱和度 ×0.76）
           深色  #6b86ff → #8ba0ff   （明度 +6.3、饱和度不变）
         只推明度不动饱和度，浅色档会算出 #234af5 —— 比原来那个紫味更重、
         更刺眼。所以饱和度也要按同一个比例压一档。
         饱和度在深色档**只加不压**：深底上降饱和会发灰，主色就没了存在感。 */
      '--primary-dark': dark
        ? hslToHex(hsl.h, Math.min(hsl.s, 100), Math.min(hsl.l + 6, 88))
        : hslToHex(hsl.h, hsl.s * 0.76, Math.max(hsl.l - 9, 12)),
      '--primary-soft': a(dark ? 0.16 : 0.10),
      '--primary-soft-2': a(dark ? 0.26 : 0.16),
      '--primary-ring': a(dark ? 0.28 : 0.22),
      '--primary-shadow': a(dark ? 0.22 : 0.18),
      '--primary-shadow-strong': a(dark ? 0.38 : 0.34),
      /* 压在照片上的元素（图库角标 / 灯箱按钮）用的不透明主色。
         不透明度固定 .92 —— 那是「图片透不过来、又能看出是半透明玻璃」
         的经验档位，与亮暗模式无关，所以深浅两档是同一个数。 */
      '--primary-solid': a(0.92)
    };
  }

  /* ------------------------------------------------------------------ *
   * 亮度判定：用来拒绝「浅底上选了个接近白的颜色」这类会把自己藏起来的输入
   * ------------------------------------------------------------------ */

  function luminance(hex) {
    const c = parseHex(hex);
    if (!c) return null;
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  /* ------------------------------------------------------------------ *
   * 解析
   * ------------------------------------------------------------------ */

  function currentSettings(explicit) {
    if (explicit) return explicit;
    try {
      return (IH.Store && IH.Store.getSettings && IH.Store.getSettings()) || {};
    } catch (e) {
      return {};
    }
  }

  /** 系统是不是深色。没有 matchMedia 的环境（纯 vm 测试）当浅色。 */
  function systemDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  /**
   * 只算不写。返回 { mode, preset, accent, derived, isCustomAccent }。
   * 单独抽出来是为了可测 —— 浏览器套件能直接断言「选了 teal 之后 mode 还是
   * 用户选的那个亮暗档」，不用先去读 DOM 再反推。
   */
  function resolve(settings) {
    const s = currentSettings(settings);

    const rawMode = s.theme || 'light';
    const mode = rawMode === 'auto' ? (systemDark() ? 'dark' : 'light') : (rawMode === 'dark' ? 'dark' : 'light');

    const presetKey = PRESETS[s.themePreset] ? s.themePreset : DEFAULT_PRESET;
    const preset = PRESETS[presetKey];

    /* themeAccent 为空 = 跟随预设。非空但非法也退回预设 ——
       宁可「看起来没生效」，也不要往 style 里写一个浏览器会丢弃的值。 */
    const custom = parseHex(s.themeAccent);
    const isCustomAccent = !!custom;
    const accent = isCustomAccent ? s.themeAccent.trim().toLowerCase() : preset[mode === 'dark' ? 'dark' : 'light'];

    return {
      mode,
      rawMode,
      preset: presetKey,
      accent,
      isCustomAccent,
      derived: derive(accent, mode)
    };
  }

  /* ------------------------------------------------------------------ *
   * 应用
   * ------------------------------------------------------------------ */

  /**
   * 把主题写到 <html>。
   *
   * 两个来源分工明确：
   *   · data-theme 属性 → theme.css 里那套「面 / 线 / 字 / 阴影」的切换
   *   · 内联 style 上的 --primary 系列 → 用户自定义的主色
   * 内联 style 的优先级高于 :root 与 [data-theme]，所以**清空它是必须的** ——
   * 用户从「自定义 #ff0000」切回「跟随预设」时如果不删，红色会一直赖着不走。
   */
  function apply(doc, settings) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return null;

    const r = resolve(settings);
    const el = d.documentElement;

    el.setAttribute('data-theme', r.mode);

    if (r.derived) {
      Object.keys(r.derived).forEach((k) => el.style.setProperty(k, r.derived[k]));
    } else {
      clearAccent(d);
    }

    return r;
  }

  /* 所有可能被内联写上的 token —— clear 时全清，别留半个 */
  const TOKENS = ['--primary', '--primary-dark', '--primary-soft', '--primary-soft-2',
    '--primary-ring', '--primary-shadow', '--primary-shadow-strong', '--primary-solid'];

  /** 抹掉内联主色，让 theme.css 的 :root / [data-theme=dark] 值生效 */
  function clearAccent(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return;
    TOKENS.forEach((k) => d.documentElement.style.removeProperty(k));
  }

  /* ------------------------------------------------------------------ *
   * 页内 UI（内容脚本）的用法
   *
   * 内容脚本**不能**往宿主页面的 <html> 上写 data-theme 或 --primary ——
   * 那是别人的页面，扩展没有资格改它的样式（而且会真的影响人家）。
   *
   * 正确做法：变量设在**我们自己的 shadow host 元素**上。
   * CSS 自定义属性沿 DOM 树继承，shadow host 上的值会传进 shadow 树，
   * 但不会向上或横向泄漏到页面 —— 既拿到了主题，又保住了隔离。
   * 深色模式走 `data-ih-theme="dark"` 属性而不是 data-theme，
   * 同样是为了不和宿主页面自己的 `[data-theme]` 撞车。
   *
   * 面色 / 文字色这一层没法只靠主色推（深色下要整块反转）。
   * 它们由 theme.css 的 `:host([data-ih-theme="dark"])` 段接管 ——
   * 所以这里**只写主色派生值**，别把面色也写到内联 style 上：
   * 内联优先级高于样式表，写上去就再也切不回浅色了。
   * ------------------------------------------------------------------ */

  /** 把主色主题写到 shadow host 元素上（悬停按钮 / 面板 / 灯箱共用） */
  function applyToHost(host, settings) {
    if (!host || !host.style) return null;
    const r = resolve(settings);

    host.setAttribute('data-ih-theme', r.mode);

    if (r.derived) {
      Object.keys(r.derived).forEach((k) => host.style.setProperty(k, r.derived[k]));
    } else {
      clearHost(host);
    }
    return r;
  }

  /** 抹掉 host 上的主题（关掉页内 UI 时用，避免残留影响下一次） */
  function clearHost(host) {
    if (!host || !host.style) return;
    TOKENS.forEach((k) => host.style.removeProperty(k));
  }

  /* ------------------------------------------------------------------ *
   * 系统深浅色监听
   * ------------------------------------------------------------------ */

  let watcher = null;

  /**
   * 挂上「系统深浅色变了」的监听。**每个文档只挂一次**（重复调用是空操作），
   * 而且只在 rawMode === 'auto' 时才真的重算 —— 用户手选了浅色，
   * 系统切深色时界面必须纹丝不动，否则「手选」这个动作就白做了。
   *
   * getSettings 传的是**函数**而不是对象：设置会被 Store 不断替换，
   * 闭包里抓一个快照就会永远用旧值。
   */
  function watch(doc, getSettings) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || d === watcher) return;
    watcher = d;

    let mq;
    try {
      mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    } catch (e) { /* 环境不支持就算了，auto 会在每次 apply 时重新算 */ }
    if (!mq || !mq.addEventListener) return;

    mq.addEventListener('change', () => {
      const s = typeof getSettings === 'function' ? getSettings() : getSettings;
      const cur = currentSettings(s);
      if ((cur.theme || 'light') !== 'auto') return;
      apply(d, cur);
    });
  }

  /* ------------------------------------------------------------------ *
   * 预设的展示信息（设置页的色卡用它）
   * ------------------------------------------------------------------ */

  function presetList() {
    return Object.keys(PRESETS).map((k) => ({
      key: k,
      zh: PRESETS[k].zh,
      en: PRESETS[k].en,
      light: PRESETS[k].light,
      dark: PRESETS[k].dark
    }));
  }

  IH.Theme = {
    PRESETS,
    DEFAULT_PRESET,
    presetList,
    resolve,
    apply,
    clearAccent,
    applyToHost,
    clearHost,
    watch,
    /* 下面三个只给测试用 —— 产品代码不需要自己算颜色 */
    _parseHex: parseHex,
    _derive: derive,
    _luminance: luminance
  };
})();
