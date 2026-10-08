/* ==========================================================================
 * ImageHunter — popup/mode.js
 * 在**首次绘制之前**把宿主模式（page / panel）定到 <body> 的 class 上。
 *
 * 为什么要单独一个文件、而且必须是 <body> 的第一个元素：
 *
 *   1. 整套布局是按 `body.mode-*` 选中的。HTML 里写死任何一个模式，另一个
 *      模式就会先按错的尺寸画一帧再跳 —— 原来硬编码 class="mode-popup"，
 *      独立标签页会先按弹窗的 780×600 画一帧，再跳到整页宽，看得见闪一下。
 *
 *   2. 不能写成内联 <script>：MV3 扩展页面的默认 CSP 是 `script-src 'self'`，
 *      内联脚本会被直接拦掉。所以只能是一个外部文件。
 *
 *   3. 放在 <body> 开头而不是 <head>：class 要打在 body 上，而 <head> 里
 *      document.body 还是 null。同步脚本在 body 开头执行时后面的内容还没解析，
 *      所以不会有一帧是用错布局画的。
 *
 * 兜底值取 page：manifest 里没有 default_popup，点击扩展图标走
 * action.onClicked → ?mode=page，页内面板走 ?mode=panel ——
 * **不存在**不带 ?mode= 的入口。
 * ========================================================================== */
(function () {
  'use strict';
  try {
    var raw = new URLSearchParams(location.search).get('mode');
    document.body.className = 'mode-' + (raw === 'panel' ? 'panel' : 'page');
  } catch (e) {
    document.body.className = 'mode-page';
  }
})();
