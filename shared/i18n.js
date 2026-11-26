/* ==========================================================================
 * ImageHunter — shared/i18n.js
 * 界面文案与中英切换
 *
 * 为什么不用 chrome.i18n：
 *   `chrome.i18n.getMessage()` 的语言**只能跟随浏览器界面语言**，用户在扩展里
 *   自己选一个语言这件事它做不到 —— 要「可中英切换」就只能自己实现一层。
 *   `_locales/` 那两份仍然保留：扩展名称、描述、快捷键说明、右键菜单文案归它管
 *   （那些是 manifest / 浏览器原生 UI 渲染的，轮不到页面脚本）。
 *   所以这里是**第二套**，只管页面内的界面文案。
 *
 * 用法：
 *   IH.I18n.t('pop.saveSelected')                  → 当前语言的文案
 *   IH.I18n.t('pop.total', { n: 12 })              → 带占位符
 *   IH.I18n.apply(document)                        → 填充页面上所有 data-i18n
 *   IH.I18n.setLang('en')                          → 切换并落盘（走 Store）
 *
 * 降级顺序：当前语言 → 中文 → key 本身。
 * 中文是**写死在这里**的「原文」，不是从别处读的 —— 所以新增文案时，
 * 英文漏了不会白屏，只是那一处退回中文（比显示 key 好排查）。
 *
 * 加载顺序：必须在 store.js **之后**（要读 settings.uiLang）。
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.I18n) return;

  /* ------------------------------------------------------------------ *
   * 语言判定
   * ------------------------------------------------------------------ */

  /** 浏览器语言。'zh'、'zh-CN'、'zh-TW' 都算中文，其余一律英文 */
  function detect() {
    try {
      const l = String(navigator.language || '').toLowerCase();
      if (l.indexOf('zh') === 0) return 'zh';
    } catch (e) { /* 没有 navigator 的上下文（如纯 vm 测试） */ }
    return 'en';
  }

  /** 当前生效的语言：设置里选了就用选的，'auto' 或没设就跟随浏览器 */
  function lang() {
    let v = null;
    try {
      const s = IH.Store && IH.Store.getSettings ? IH.Store.getSettings() : null;
      v = s ? s.uiLang : null;
    } catch (e) { /* Store 还没加载完 */ }
    if (!v || v === 'auto') return detect();
    return (v === 'zh' || v === 'en') ? v : detect();
  }

  /** 切换语言并落盘。返回 Promise（走 Store.updateSettings 串行写） */
  function setLang(v) {
    const next = (v === 'zh' || v === 'en' || v === 'auto') ? v : 'auto';
    if (IH.Store && IH.Store.updateSettings) {
      return IH.Store.updateSettings({ uiLang: next });
    }
    return Promise.resolve();
  }

  /* ------------------------------------------------------------------ *
   * 取词
   * ------------------------------------------------------------------ */

  function t(key, args) {
    const l = lang();
    let s = null;
    if (STRINGS[l]) s = STRINGS[l][key];
    if (s == null && STRINGS.zh) s = STRINGS.zh[key];
    if (s == null) return key;

    if (args) {
      Object.keys(args).forEach((k) => {
        s = s.split('{' + k + '}').join(String(args[k]));
      });
    }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 填充页面
   *
   * 三种属性：
   *   data-i18n             → textContent（纯文案）
   *   data-i18n-html        → innerHTML（文案里含 <code> 这类标记时用）
   *   data-i18n-ph          → placeholder
   *   data-i18n-aria        → aria-label + title（两者通常写同一句）
   * ------------------------------------------------------------------ */

  function apply(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;

    const each = (sel, fn) => {
      Array.prototype.forEach.call(scope.querySelectorAll(sel), fn);
    };

    each('[data-i18n]', (el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    each('[data-i18n-html]', (el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    each('[data-i18n-ph]', (el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    each('[data-i18n-aria]', (el) => {
      const v = t(el.getAttribute('data-i18n-aria'));
      el.setAttribute('aria-label', v);
      el.setAttribute('title', v);
    });
    each('[data-i18n-title]', (el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    // <html lang>：让浏览器按正确语言渲染 / 读屏器用正确的语音
    if (scope.documentElement) {
      scope.documentElement.setAttribute('lang', lang() === 'zh' ? 'zh-CN' : 'en');
    }
  }

  /* ------------------------------------------------------------------ *
   * 文案表
   * ------------------------------------------------------------------ */

  const STRINGS = {};

  /* ---------------------------- 中文 ---------------------------- */
  STRINGS.zh = {
    /* ---- 通用 ---- */
    'cmn.cancel': '取消',
    'cmn.close': '关闭',
    'cmn.save': '保存',
    'cmn.saved': '已保存',
    'cmn.clear': '清空',
    'cmn.reset': '重置',
    'cmn.all': '全部',
    'cmn.view': '查看',
    'cmn.export': '导出',
    'cmn.import': '导入',
    'cmn.test': '测试',
    'cmn.light': '浅色',
    'cmn.dark': '深色',
    'cmn.auto': '跟随系统',
    'cmn.yes': '是',
    'cmn.no': '否',
    'cmn.retry': '重试',
    'cmn.and': ' 和 ',
    'cmn.loading': '加载中…',
    'cmn.unknown': '未知',
    'cmn.unknownError': '未知错误',
    'cmn.noFilter': '不过滤',


    /* ---- 页内界面：悬停按钮 / 气泡 / 灯箱 / 页内面板 ---- */
    'pg.preview': '大图预览',
    'pg.previewTitle': '大图预览（就在当前页看，不跳走）',
    'pg.saveOriginal': '保存原图',
    'pg.saveOriginalTitle': '保存原图（Alt+点击图片 可免悬停直存）',
    'pg.saving': '正在保存…',
    'pg.saved': '已保存',
    'pg.saveFailedRetry': '保存失败，点击重试',
    'pg.collecting': '正在整理本页图片…',
    'pg.previewNotLoaded': '预览组件未加载',
    'pg.previewNone': '没找到可预览的图片',
    'pg.hoverFirst': '先把鼠标移到图片上，再按这个快捷键',
    'pg.noSavable': '未找到可保存的图片',
    'pg.skippedDownloaded': '已下载过，本次已跳过',
    'pg.savedOriginalDim': '已保存原图{dim}',
    'pg.savedDim': '已保存{dim}',
    'pg.savedFolder': ' → {folder}/',
    'pg.savedAs': '（实际为 {name}）',
    'pg.downloadFailed': '下载失败',
    'pg.saveFailed': '保存失败',

    'pg.lbZoomOut': '缩小',
    'pg.lbZoomIn': '放大',
    'pg.lbCopyLink': '复制图片直链',
    'pg.lbCopyImage': '复制图片到剪贴板',
    'pg.lbOpenTab': '在新标签页打开原图',
    'pg.lbOpenGallery': '在图库中打开：定位到这张图，并可浏览本页全部图片',
    'pg.lbClose': '关闭 (Esc)',
    'pg.lbPrev': '上一张 (←)',
    'pg.lbNext': '下一张 (→)',
    'pg.lbLoadFailed': '原图加载失败（可能受站点防盗链限制，仍可尝试保存）',
    'pg.tagRestored': '已还原原图',
    'pg.dimUnknown': '尺寸未知',
    'pg.filteredOut': '已按 {min}px 过滤 {n} 张',
    'pg.imageWord': '图片',
    'pg.inlineImage': '内联图片',
    'pg.savingShort': '保存中…',
    'pg.skippedExists': '已存在，已跳过',
    'pg.savedCheck': '已保存 ✓',
    'pg.fetchImageFailed': '获取图片失败',
    'pg.copyUnsupported': '当前环境不支持复制图片',

    'pg.galleryPanel': '图片库',
    'pg.noResponse': '无响应',
    'pg.noSavableUrl': '没有可保存的图片地址',
    'pg.hoverNotLoaded': '悬停模块未加载',
    'pg.missingUrl': '缺少图片地址',
  };

  /* ---------------------------- English ---------------------------- */
  STRINGS.en = {
    /* ---- common ---- */
    'cmn.cancel': 'Cancel',
    'cmn.close': 'Close',
    'cmn.save': 'Save',
    'cmn.saved': 'Saved',
    'cmn.clear': 'Clear',
    'cmn.reset': 'Reset',
    'cmn.all': 'All',
    'cmn.view': 'View',
    'cmn.export': 'Export',
    'cmn.import': 'Import',
    'cmn.test': 'Test',
    'cmn.light': 'Light',
    'cmn.dark': 'Dark',
    'cmn.auto': 'Follow system',
    'cmn.yes': 'Yes',
    'cmn.no': 'No',
    'cmn.retry': 'Retry',
    'cmn.and': ' and ',
    'cmn.loading': 'Loading…',
    'cmn.unknown': 'Unknown',
    'cmn.unknownError': 'Unknown error',
    'cmn.noFilter': 'No filter',


    /* ---- in-page UI: hover button / bubble / lightbox / in-page panel ---- */
    'pg.preview': 'Large preview',
    'pg.previewTitle': 'Large preview (opens right here — no tab switch)',
    'pg.saveOriginal': 'Save original',
    'pg.saveOriginalTitle': 'Save original (Alt+click an image skips hovering)',
    'pg.saving': 'Saving…',
    'pg.saved': 'Saved',
    'pg.saveFailedRetry': 'Save failed — click to retry',
    'pg.collecting': 'Collecting this page’s images…',
    'pg.previewNotLoaded': 'Preview component not loaded',
    'pg.previewNone': 'No previewable image found',
    'pg.hoverFirst': 'Move the mouse over an image first, then press this shortcut',
    'pg.noSavable': 'No savable image found',
    'pg.skippedDownloaded': 'Already downloaded — skipped this time',
    'pg.savedOriginalDim': 'Saved original{dim}',
    'pg.savedDim': 'Saved{dim}',
    'pg.savedFolder': ' → {folder}/',
    'pg.savedAs': ' (saved as {name})',
    'pg.downloadFailed': 'Download failed',
    'pg.saveFailed': 'Save failed',

    'pg.lbZoomOut': 'Zoom out',
    'pg.lbZoomIn': 'Zoom in',
    'pg.lbCopyLink': 'Copy image URL',
    'pg.lbCopyImage': 'Copy image to clipboard',
    'pg.lbOpenTab': 'Open the original in a new tab',
    'pg.lbOpenGallery': 'Open in the gallery: jumps to this image and lets you browse them all',
    'pg.lbClose': 'Close (Esc)',
    'pg.lbPrev': 'Previous (←)',
    'pg.lbNext': 'Next (→)',
    'pg.lbLoadFailed': 'The original failed to load (the site may block hotlinking — saving may still work)',
    'pg.tagRestored': 'Restored to original',
    'pg.dimUnknown': 'Size unknown',
    'pg.filteredOut': 'Filtered {n} out at {min}px',
    'pg.imageWord': 'Image',
    'pg.inlineImage': 'Inline image',
    'pg.savingShort': 'Saving…',
    'pg.skippedExists': 'Already there — skipped',
    'pg.savedCheck': 'Saved ✓',
    'pg.fetchImageFailed': 'Could not get the image',
    'pg.copyUnsupported': 'This environment cannot copy images',

    'pg.galleryPanel': 'Image gallery',
    'pg.noResponse': 'No response',
    'pg.noSavableUrl': 'No savable image URL',
    'pg.hoverNotLoaded': 'Hover component not loaded',
    'pg.missingUrl': 'Missing image URL',
  };

  const SOURCE_LABELS = { zh: {}, en: {} };
  const RULE_LABELS = { zh: {}, en: {} };

  function register(pack) {
    if (!pack) return;
    if (pack.zh) Object.assign(STRINGS.zh, pack.zh);
    if (pack.en) Object.assign(STRINGS.en, pack.en);
    if (pack.sources) {
      if (pack.sources.zh) Object.assign(SOURCE_LABELS.zh, pack.sources.zh);
      if (pack.sources.en) Object.assign(SOURCE_LABELS.en, pack.sources.en);
    }
    if (pack.rules) {
      if (pack.rules.zh) Object.assign(RULE_LABELS.zh, pack.rules.zh);
      if (pack.rules.en) Object.assign(RULE_LABELS.en, pack.rules.en);
    }
  }

  function sourceLabel(key) {
    const l = lang();
    const v = (SOURCE_LABELS[l] || {})[key];
    if (v) return v;
    return (SOURCE_LABELS.zh[key])
      || (IH.C && IH.C.SOURCE_LABELS ? IH.C.SOURCE_LABELS[key] : null)
      || key;
  }

  function ruleLabel(id, fallback) {
    const l = lang();
    const v = (RULE_LABELS[l] || {})[id];
    if (v) return v;
    return RULE_LABELS.zh[id] || fallback || id;
  }

  IH.I18n = { t, apply, lang, detect, setLang, register, sourceLabel, ruleLabel, STRINGS };
})();
