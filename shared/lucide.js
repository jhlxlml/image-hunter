/* ==========================================================================
 * ImageHunter — shared/lucide.js
 *
 * **全应用唯一的图标来源。** 所有图形取自 Lucide（https://lucide.dev，ISC 许可），
 * 形状字符串与官网 SVG 的 `<svg>` 内部内容逐字符一致。
 *
 * 为什么要有这个文件（v1.19.0 之前不是这样）：
 *   39 个内联 SVG 是手画的，`viewBox` 都是 24 但 `stroke-width` 从 1.6 到 3.4
 *   什么值都有，尺寸更散 —— 11 / 12 / 13 / 14 / 15 / 16 / 17 / 20 / 32 全出现过。
 *   结果同一排按钮里图标粗细不一样、工具行三个按钮比旁边的胶囊小一号、
 *   卡片角标的「还原」比「勾选」小 1px。单看每个都「还行」，排在一起就是毛边。
 *   换成一套同源的图标 + 一套档位化的尺寸，这类毛边从源头没了。
 *
 * 为什么同时还在 HTML 里内联一份（**这不是冗余**）：
 *   图库是首屏界面，图标靠 JS 生成会先闪一下空按钮再出现图形。
 *   所以 popup.html / options.html 里保留内联 `<svg data-lucide="名字">`，
 *   本文件是**权威数据**，HTML 是**静态副本** —— 与 theme.css 的兜底值 /
 *   theme.js 的推导值是同一套做法：两处都写，靠测试钉住它们相等
 *   （validate.js 的「图标」一节逐形状对拍，任何一边改了另一边没改都会红）。
 *
 * 加图标 / 换图标：
 *   1. 去 lucide.dev 搜名字，把 `<svg>` 里的形状原样抄进 PATHS（键名就是官网图标名，
 *      这样下次换图标能直接搜同名，不必回来猜我们内部叫什么）；
 *   2. HTML 那边同步换成同一份形状，并写 `data-lucide="同一个名字"`。
 *
 * 尺寸**不在这里定** —— 一律交给 CSS 的 `--ic-*` 档位（见 shared/theme.css），
 * 这样「同一层级的图标一样大」是一条可检查的规则，而不是每个调用点各写一个数字。
 * ========================================================================== */

(function (global) {
  'use strict';

  const IH = global.IH = global.IH || {};

  /* 形状字符串：属性顺序、数字精度、命令大小写都保持 Lucide 原样，
     不做「美化」—— 一旦手改过，和官网对不上，下次比对就分不清是谁错了。 */
  const PATHS = {
    /* ---- 品牌 ---- */
    'image-down': '<path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/>'
      + '<path d="m14 19 3 3v-5.5"/>'
      + '<path d="m17 22 3-3"/>'
      + '<circle cx="9" cy="9" r="2"/>',
    /* ---- 顶栏动作 ---- */
    'search': '<path d="m21 21-4.34-4.34"/>'
      + '<circle cx="11" cy="11" r="8"/>',
    'rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>'
      + '<path d="M21 3v5h-5"/>',
    'gauge': '<path d="m12 14 4-4"/>'
      + '<path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    'file-down': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>'
      + '<path d="M14 2v5a1 1 0 0 0 1 1h5"/>'
      + '<path d="M12 18v-6"/>'
      + '<path d="m9 15 3 3 3-3"/>',
    'chevrons-down': '<path d="m7 6 5 5 5-5"/>'
      + '<path d="m7 13 5 5 5-5"/>',
    'panel-right': '<rect width="18" height="18" x="3" y="3" rx="2"/>'
      + '<path d="M15 3v18"/>',
    'settings': '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>'
      + '<circle cx="12" cy="12" r="3"/>',
    'x': '<path d="M18 6 6 18"/>'
      + '<path d="m6 6 12 12"/>',
    /* ---- 工具行 ---- */
    'list-filter': '<path d="M2 5h20"/>'
      + '<path d="M6 12h12"/>'
      + '<path d="M9 19h6"/>',
    'arrow-up-down': '<path d="m21 16-4 4-4-4"/>'
      + '<path d="M17 20V4"/>'
      + '<path d="m3 8 4-4 4 4"/>'
      + '<path d="M7 4v16"/>',
    'arrow-down-wide-narrow': '<path d="m3 16 4 4 4-4"/>'
      + '<path d="M7 20V4"/>'
      + '<path d="M11 4h10"/>'
      + '<path d="M11 8h7"/>'
      + '<path d="M11 12h4"/>',
    'square-check': '<rect width="18" height="18" x="3" y="3" rx="2"/>'
      + '<path d="m16 9-5.5 5.5L8 12"/>',
    'arrow-left-right': '<path d="M8 3 4 7l4 4"/>'
      + '<path d="M4 7h16"/>'
      + '<path d="m16 21 4-4-4-4"/>'
      + '<path d="M20 17H4"/>',
    'ruler': '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/>'
      + '<path d="m14.5 12.5 2-2"/>'
      + '<path d="m11.5 9.5 2-2"/>'
      + '<path d="m8.5 6.5 2-2"/>'
      + '<path d="m17.5 15.5 2-2"/>',
    /* ---- 卡片与底栏 ---- */
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'zoom-in': '<circle cx="11" cy="11" r="8"/>'
      + '<line x1="21" x2="16.65" y1="21" y2="16.65"/>'
      + '<line x1="11" x2="11" y1="8" y2="14"/>'
      + '<line x1="8" x2="14" y1="11" y2="11"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    'download': '<path d="M12 15V3"/>'
      + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
      + '<path d="m7 10 5 5 5-5"/>',
    /* ---- 空态 ---- */
    'image-off': '<line x1="2" x2="22" y1="2" y2="22"/>'
      + '<path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/>'
      + '<line x1="13.5" x2="6" y1="13.5" y2="21"/>'
      + '<line x1="18" x2="21" y1="12" y2="15"/>'
      + '<path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/>'
      + '<path d="M21 15V5a2 2 0 0 0-2-2H9"/>',
    /* ---- 页内 UI（悬停 / 灯箱） ---- */
    /* 灯箱缩放步进。原来是两个**文字**字形 `−` / `+`：字号 14px、字重随字体走，
       和旁边 2px 描边的图标摆在一排，粗细对不上（字形的横画细、竖画粗）。
       换成 Lucide 之后它们也是描边图标，和其它按钮同一套视觉。 */
    'minus': '<path d="M5 12h14"/>',
    'plus': '<path d="M5 12h14"/>'
      + '<path d="M12 5v14"/>',
    'circle-alert': '<circle cx="12" cy="12" r="10"/>'
      + '<line x1="12" x2="12" y1="8" y2="12"/>'
      + '<line x1="12" x2="12.01" y1="16" y2="16"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'link': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>'
      + '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'external-link': '<path d="M15 3h6v6"/>'
      + '<path d="M10 14 21 3"/>'
      + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>'
      + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/>'
      + '<rect width="7" height="7" x="14" y="3" rx="1"/>'
      + '<rect width="7" height="7" x="14" y="14" rx="1"/>'
      + '<rect width="7" height="7" x="3" y="14" rx="1"/>',
    /* ---- 目标选择器 ---- */
    'panel-top': '<rect width="18" height="18" x="3" y="3" rx="2"/>'
      + '<path d="M3 9h18"/>',
  };

  /**
   * 拼一枚完整的图标。
   *
   * 属性写死成 Lucide 的规范（24 视框 / stroke-width 2 / 圆头圆角 / 不填充），
   * **不接受调用点覆盖** —— 允许覆盖就等于允许漂移，那正是这一版要消灭的东西。
   * 尺寸也不在这里给：`width` / `height` 一律由 CSS 决定（`--ic-*` 档位）。
   *
   * 找不到名字时**不抛异常**：图标缺失不该让整个界面挂掉。
   * 返回一个同样大小的空 svg（保住布局），并在控制台留一句 ——
   * 与 i18n 的「最外环返回 key 本身」是同一个思路：坏了要看得见，但别崩。
   *
   * @param {string} name PATHS 里的键（= lucide.dev 的图标名）
   * @param {{cls?: string, hidden?: boolean}} [opts]
   * @returns {string} SVG 字符串
   */
  function svg(name, opts) {
    opts = opts || {};
    const body = PATHS[name];
    if (!body && typeof console !== 'undefined') {
      console.warn('[IH.Lucide] 没有这个图标：' + name);
    }
    const cls = 'ic' + (opts.cls ? ' ' + opts.cls : '');
    return '<svg class="' + cls + '"'
      + ' viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
      + (opts.hidden === false ? '' : ' aria-hidden="true"')
      + '>' + (body || '') + '</svg>';
  }

  IH.Lucide = {
    PATHS: PATHS,
    svg: svg,
    names: Object.keys(PATHS)
  };

})(typeof window !== 'undefined' ? window : globalThis);
