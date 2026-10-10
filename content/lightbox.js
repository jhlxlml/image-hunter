/* ==========================================================================
 * ImageHunter — content/lightbox.js
 * 全屏大图预览：缩放 / 拖拽 / 左右切换 / 直接保存 / 缩略图条
 *
 * 两处宿主共用这一份实现：
 *   1. 内容脚本（网页里）—— 从网页上直接点开预览
 *   2. 图库页（popup.html 的弹窗 / 独立页 / 面板）—— 从图库里点开预览
 *
 * 之所以要能跑在图库页里：以前图库里点放大镜是把消息转给**目标网页**标签页，
 * 灯箱开在那边 —— 于是用户点一下预览就被甩到原标签页上去了。
 * 现在图库页自己就能开灯箱，预览不再离开当前页面。
 *
 * 代价是这里不能再假设 `location.href` 就是图片所在页面（图库页的 location 是
 * chrome-extension://…/popup.html），所以 open() 接受 opts.pageUrl 显式传入，
 * 下载/抓取时的 Referer 才不会变成扩展自己的地址。
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.Lightbox) return;

  const C = IH.C;
  const U = IH.U;
  const MSG = C.MSG;
  /* 灯箱的按钮标题与状态文字都跟着界面语言走。
     它跑在两个宿主里（内容脚本 / 图库页），两边都先加载了 shared/i18n.js。 */
  const t = (k, a) => IH.I18n.t(k, a);
  /* 下面这段 UI 是拼 innerHTML 的，文案要转义 —— 英文文案里有 ' 和 &，
     不转义在 HTML 属性里会当场截断。 */
  const esc = (s) => U.escapeHtml(s);

  const ICON_PREV =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  const ICON_NEXT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11.5"/>' +
    '<path d="M7 10.5l5 5 5-5"/><path d="M4.5 20h15"/></svg>';
  const ICON_LINK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/>' +
    '<path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/></svg>';
  const ICON_OPEN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-8 8"/>' +
    '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  const ICON_COPY_IMG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
  const ICON_GALLERY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/>' +
    '<rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/>' +
    '<rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/>' +
    '<rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';

  let ui = null;
  let list = [];
  let index = 0;
  let scale = 1, tx = 0, ty = 0;
  let loaded = false;
  let installed = false;
  let saveTimer = null;
  // 这些图片「真正所在的页面」。内容脚本里就是 location.href；
  // 图库页里由 open() 的 opts.pageUrl 传入，否则 Referer 会变成扩展地址（防盗链站点会 403）。
  let pageUrl = '';

  /* 尺寸过滤的现场记录（open() 里算一次，updateMeta() 拿来向用户交代）：
   *   minSize  —— 本轮用的阈值（0 = 不过滤）
   *   dropped  —— 因为太小被挡在灯箱外的张数
   * 只作用于灯箱列表。图库卡片、批量下载走的是 scanner / popup 那一侧，
   * 完全不经过这里 —— 用户明确选过「只管灯箱」。 */
  let minSize = 0;
  let dropped = 0;

  /* 灯箱开在哪种宿主里：'content'（网页里）或 'gallery'（图库页 / 面板）。
   *
   * 只用来决定「在图库中打开」这个按钮显不显示 —— 它解决的是**网页里**的
   * 悬停预览只有 1 张、没法连播的问题；在图库页里用户本来就在图库，按钮没有意义，
   * 面板模式下点了还会把焦点抢到自己身上（面板就在这个页面上）。
   *
   * 默认取 'gallery'（**不显示**）是刻意的：漏传时最坏是少一个按钮，
   * 而不是多一个点了没反应、或者把用户弹走的按钮。 */
  let host = 'gallery';

  /* ---------------------- 背景滚动锁 ----------------------
   * 灯箱是**页内模态**：它盖住了整个页面，底下那层就不该再动。
   * 不锁的话，在图片还在加载 / 加载失败时滚一下滚轮，或者按空格、↑↓，
   * 后面的文章就跟着滚走了 —— 关掉灯箱发现已经不在原来的位置。
   *
   * 两个细节都不能省：
   *   1. 原值要**记下来再还原**，不能写死还原成 ''。页面自己可能就是
   *      overflow:hidden，写死会把它的布局改掉。
   *   2. 隐藏滚动条会让内容整体右移，得补一个等宽的 padding-right 顶住。
   *      不补的话页面会「跳」一下（Windows 的常驻滚动条上尤其明显）。
   */
  let scrollLock = null;

  function lockScroll() {
    if (scrollLock) return;
    const de = document.documentElement;
    if (!de) return;

    const barW = Math.max(0, (window.innerWidth || 0) - (de.clientWidth || 0));
    scrollLock = {
      htmlOverflow: de.style.overflow,
      htmlPaddingRight: de.style.paddingRight,
      // 有的页面靠 body 滚动（html 不滚），两处都锁上才稳。
      // 没有 body 时记 null，还原时就不要去碰它。
      bodyOverflow: document.body ? document.body.style.overflow : null
    };

    de.style.overflow = 'hidden';
    if (barW > 0) {
      let cur = 0;
      try { cur = parseFloat(getComputedStyle(de).paddingRight) || 0; } catch (e) { cur = 0; }
      de.style.paddingRight = (cur + barW) + 'px';
    }
    if (document.body) document.body.style.overflow = 'hidden';
  }

  function unlockScroll() {
    if (!scrollLock) return;
    const de = document.documentElement;
    if (de) {
      de.style.overflow = scrollLock.htmlOverflow;
      de.style.paddingRight = scrollLock.htmlPaddingRight;
    }
    if (document.body && scrollLock.bodyOverflow !== null) {
      document.body.style.overflow = scrollLock.bodyOverflow;
    }
    scrollLock = null;
  }

  /* ---------------------------- 构建 ---------------------------- */

  function ensureUI() {
    if (ui) return ui;

    const created = U.createShadowHost(
      'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;'
    );
    const root = created.root;

    const lb = document.createElement('div');
    lb.className = 'ih-lb';
    lb.innerHTML = [
      '<div class="ih-lb-bar">',
      '  <span class="ih-lb-tag" style="display:none"></span>',
      '  <span class="ih-lb-title"></span>',
      '  <span class="ih-lb-meta"></span>',
      '  <span class="ih-lb-spacer"></span>',
      '  <span class="ih-lb-zoom">',
      /* 图标按钮没有可见文字，title 与 aria-label 都要给 —— 只给 title 的话
         读屏器念的是「按钮」，键盘/读屏用户根本不知道这一排是干什么的。 */
      '    <button data-act="zoom-out" title="' + esc(t('pg.lbZoomOut')) + '" aria-label="' + esc(t('pg.lbZoomOut')) + '">−</button>',
      '    <span class="ih-lb-zoom-val">100%</span>',
      '    <button data-act="zoom-in" title="' + esc(t('pg.lbZoomIn')) + '" aria-label="' + esc(t('pg.lbZoomIn')) + '">+</button>',
      '  </span>',
      '  <button class="ih-lb-btn" data-act="link" title="' + esc(t('pg.lbCopyLink')) + '" aria-label="' + esc(t('pg.lbCopyLink')) + '">' + ICON_LINK + '</button>',
      '  <button class="ih-lb-btn" data-act="copyimg" title="' + esc(t('pg.lbCopyImage')) + '" aria-label="' + esc(t('pg.lbCopyImage')) + '">' + ICON_COPY_IMG + '</button>',
      '  <button class="ih-lb-btn" data-act="open" title="' + esc(t('pg.lbOpenTab')) + '" aria-label="' + esc(t('pg.lbOpenTab')) + '">' + ICON_OPEN + '</button>',
      '  <button class="ih-lb-btn ih-lb-gallery" data-act="gallery" title="' + esc(t('pg.lbOpenGallery')) + '" aria-label="' + esc(t('pg.lbOpenGallery')) + '">' + ICON_GALLERY + '</button>',
      '  <button class="ih-lb-btn ih-lb-primary" data-act="save">' + ICON_DOWNLOAD + '<span>' + esc(t('pg.saveOriginal')) + '</span></button>',
      '  <button class="ih-lb-btn ih-lb-icon" data-act="close" title="' + esc(t('pg.lbClose')) + '" aria-label="' + esc(t('pg.lbClose')) + '">' + ICON_CLOSE + '</button>',
      '</div>',
      '<div class="ih-lb-stage">',
      '  <button class="ih-lb-nav ih-lb-prev" data-act="prev" title="' + esc(t('pg.lbPrev')) + '" aria-label="' + esc(t('pg.lbPrev')) + '">' + ICON_PREV + '</button>',
      '  <img class="ih-lb-img" alt="" draggable="false" />',
      '  <div class="ih-lb-loading"><div class="ih-spinner"></div></div>',
      '  <button class="ih-lb-nav ih-lb-next" data-act="next" title="' + esc(t('pg.lbNext')) + '" aria-label="' + esc(t('pg.lbNext')) + '">' + ICON_NEXT + '</button>',
      '</div>',
      '<div class="ih-lb-strip"></div>'
    ].join('');

    root.appendChild(lb);
    (document.documentElement || document.body).appendChild(created.host);

    const $ = (sel) => lb.querySelector(sel);
    ui = {
      host: created.host,
      root,
      lb,
      tag: $('.ih-lb-tag'),
      title: $('.ih-lb-title'),
      meta: $('.ih-lb-meta'),
      zoomVal: $('.ih-lb-zoom-val'),
      stage: $('.ih-lb-stage'),
      img: $('.ih-lb-img'),
      loading: $('.ih-lb-loading'),
      strip: $('.ih-lb-strip'),
      prev: $('.ih-lb-prev'),
      next: $('.ih-lb-next'),
      galleryBtn: $('[data-act="gallery"]')
    };

    bindEvents();
    return ui;
  }

  /* ---------------------------- 事件绑定 ---------------------------- */

  function bindEvents() {
    const { lb, img, stage, strip } = ui;

    lb.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        handleAction(btn.getAttribute('data-act'));
        return;
      }
      // 点击背景关闭
      if (e.target === lb || e.target === stage) close();
    });

    lb.addEventListener('mousedown', (e) => e.stopPropagation(), true);
    lb.addEventListener('wheel', onWheel, { passive: false });

    // 缩放 / 拖拽
    img.addEventListener('dblclick', () => setScale(scale > 1.02 ? 1 : 2));
    img.addEventListener('pointerdown', onPointerDown);
    img.addEventListener('pointermove', onPointerMove);
    img.addEventListener('pointerup', onPointerUp);
    img.addEventListener('pointercancel', onPointerUp);
    img.addEventListener('load', () => {
      loaded = true;
      ui.loading.style.display = 'none';
      updateMeta();
    });
    img.addEventListener('error', () => {
      loaded = false;
      ui.loading.style.display = 'none';
      ui.meta.textContent = t('pg.lbLoadFailed');
    });

    strip.addEventListener('click', (e) => {
      const thumb = e.target.closest ? e.target.closest('.ih-lb-thumb') : null;
      if (!thumb) return;
      e.preventDefault();
      e.stopPropagation();
      go(parseInt(thumb.getAttribute('data-i'), 10));
    });
  }

  function handleAction(act) {
    switch (act) {
      case 'close': close(); break;
      case 'prev': go(index - 1); break;
      case 'next': go(index + 1); break;
      case 'zoom-in': setScale(scale * 1.25); break;
      case 'zoom-out': setScale(scale / 1.25); break;
      case 'save': saveCurrent(); break;
      case 'link': copyLink(); break;
      case 'copyimg': copyImage(); break;
      case 'open': openInTab(); break;
      case 'gallery': openInGallery(); break;
      default: break;
    }
  }

  /** 按宿主显示 / 隐藏「在图库中打开」（只有网页里的悬停预览才需要它） */
  function applyHost() {
    if (!ui || !ui.galleryBtn) return;
    ui.galleryBtn.style.display = host === 'content' ? '' : 'none';
  }

  /* ---------------------------- 缩放 / 拖拽 ---------------------------- */

  let dragging = false, dragX = 0, dragY = 0, startTx = 0, startTy = 0;

  function onWheel(e) {
    const unit = e.deltaMode === 1 ? 20 : 1;   // deltaMode=1 表示「行」，换算成像素

    // 落在缩略图条上：把竖向滚轮转成横向滚动。
    // 浏览器自己**不会**这么干 —— 竖向滚轮不会去滚一个只横向溢出的元素，
    // 所以这里不接管的话，条上就成了一块「滚轮死区」（实测：什么都不动）。
    if (ui && ui.strip && ui.strip.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      ui.strip.scrollLeft += d * unit;
      return;
    }

    // **无条件**拦住。原来这里是 `if (!loaded) return;` —— 于是图片还在加载、
    // 或者加载失败时，滚轮会直接穿透到灯箱后面的页面上，把它滚走。
    // 灯箱是页内模态，底下那层任何时候都不该动。
    e.preventDefault();
    e.stopPropagation();

    if (!loaded) return;            // 没加载完就没有可缩放的对象，但事件已经拦下了
    setScale(scale * Math.pow(0.999, e.deltaY * unit));
  }

  function setScale(next) {
    scale = U.clamp(next, 0.2, 8);
    if (scale <= 1.02) { tx = 0; ty = 0; }
    applyTransform();
  }

  function applyTransform() {
    if (!ui) return;
    ui.img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    ui.zoomVal.textContent = Math.round(scale * 100) + '%';
  }

  function onPointerDown(e) {
    if (scale <= 1.02) return;
    dragging = true;
    dragX = e.clientX; dragY = e.clientY;
    startTx = tx; startTy = ty;
    ui.img.classList.add('ih-dragging');
    try { ui.img.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function onPointerMove(e) {
    if (!dragging) return;
    tx = startTx + (e.clientX - dragX);
    ty = startTy + (e.clientY - dragY);
    applyTransform();
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    ui.img.classList.remove('ih-dragging');
  }

  /* ---------------------------- 导航 ---------------------------- */

  function go(next) {
    if (!list.length) return;
    index = (next + list.length) % list.length;
    render();
  }

  function current() { return list[index] || null; }

  function render() {
    const c = current();
    if (!c) return;

    scale = 1; tx = 0; ty = 0;
    loaded = false;
    applyTransform();

    ui.loading.style.display = 'flex';
    ui.img.classList.remove('ih-dragging');
    ui.img.setAttribute('src', c.url);
    ui.img.setAttribute('alt', c.alt || '');
    ui.title.textContent = c.alt || fileNameOf(c.url);
    ui.title.title = c.url;

    ui.tag.style.display = c.restored ? 'inline-flex' : 'none';
    if (c.restored) ui.tag.textContent = t('pg.tagRestored');

    updateMeta();

    ui.prev.disabled = list.length < 2;
    ui.next.disabled = list.length < 2;

    renderStrip();
    highlightStrip();
  }

  function updateMeta() {
    const c = current();
    if (!c) return;
    const parts = [];
    if (ui.img.naturalWidth && ui.img.naturalHeight) {
      parts.push(ui.img.naturalWidth + ' × ' + ui.img.naturalHeight);
    } else if (c.width && c.height) {
      parts.push(c.width + ' × ' + c.height);
    } else {
      parts.push(t('pg.dimUnknown'));
    }
    if (c.type) parts.push(String(c.type).toUpperCase());
    if (c.sizeBytes) parts.push(U.formatBytes(c.sizeBytes));
    parts.push((index + 1) + ' / ' + list.length);
    /* 被尺寸阈值挡掉的那些要如实说出来。
       不说的话用户只会以为「嗅探漏了图」—— 而设置页里那个开关是他自己调的，
       得让他能把「这张图没出现」和「我设了 64px」对上。 */
    if (dropped > 0) parts.push(t('pg.filteredOut', { min: minSize, n: dropped }));
    ui.meta.textContent = parts.join('  ·  ');
  }

  /* 缩略图条只渲染「当前项附近」的一个窗口。
     一次性给整份列表建 <img> 是实打实的 DOM 开销 —— loading="lazy" 只省网络，
     不省节点。从 2000 张的图库打开预览，原来会一次性插入 2000 个元素。 */
  const STRIP_WINDOW = 40;
  let stripFrom = 0;
  let stripTo = 0;

  function renderStrip(force) {
    if (!ui) return;
    if (list.length < 2) {
      ui.strip.style.display = 'none';
      stripFrom = stripTo = 0;
      return;
    }
    ui.strip.style.display = 'flex';

    // 当前项还在已渲染的窗口里就不用重建 —— 否则每按一次方向键都要重建 81 个节点
    const inWindow = !force && stripTo > stripFrom
      && stripTo <= list.length
      && index >= stripFrom && index < stripTo;
    if (inWindow) return;

    // 以当前项为中心重开窗口
    const from = Math.max(0, index - STRIP_WINDOW);
    const to = Math.min(list.length, index + STRIP_WINDOW + 1);

    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      const c = list[i];
      const d = document.createElement('div');
      d.className = 'ih-lb-thumb';
      d.setAttribute('data-i', String(i));   // 窗口化后 DOM 下标 ≠ 列表下标，必须靠这个
      d.title = c.alt || fileNameOf(c.url);
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.decoding = 'async';
      im.src = c.url;
      im.alt = '';
      d.appendChild(im);
      frag.appendChild(d);
    }
    ui.strip.textContent = '';
    ui.strip.appendChild(frag);
    stripFrom = from;
    stripTo = to;
  }

  function highlightStrip() {
    if (!ui) return;
    const items = ui.strip.querySelectorAll('.ih-lb-thumb');
    let active = null;
    items.forEach((el) => {
      const on = parseInt(el.getAttribute('data-i'), 10) === index;
      el.classList.toggle('ih-active', on);
      if (on) active = el;
    });
    if (active && active.scrollIntoView) {
      try { active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    }
  }

  function fileNameOf(url) {
    if (!url) return t('pg.imageWord');
    if (U.isDataUrl(url)) return t('pg.inlineImage');
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      return last || U.prettyHost(url);
    } catch (e) { return url.slice(0, 60); }
  }

  /* ---------------------------- 操作 ---------------------------- */

  async function saveCurrent() {
    const c = current();
    if (!c) return;
    const btn = ui.lb.querySelector('[data-act="save"]');
    const label = btn.querySelector('span');

    clearTimeout(saveTimer);
    btn.disabled = true;
    if (label) label.textContent = t('pg.savingShort');

    const s = IH.Store.getSettings();
    const res = await U.sendToBg({
      type: MSG.DOWNLOAD_ONE,
      payload: {
        url: c.url,
        pageUrl: pageUrl || location.href,
        width: c.width || ui.img.naturalWidth || 0,
        height: c.height || ui.img.naturalHeight || 0,
        filename: U.buildFilename(c, s, index + 1),
        restored: !!c.restored
      }
    });

    btn.disabled = false;
    if (res && res.ok) {
      if (label) label.textContent = res.skipped ? t('pg.skippedExists') : t('pg.savedCheck');
    } else {
      if (label) label.textContent = t('pg.saveFailed');
      console.warn('[ImageHunter] 保存失败', res && res.error);
    }
    saveTimer = setTimeout(() => { if (label) label.textContent = t('pg.saveOriginal'); }, 1800);
  }

  function flashButton(act, ok) {
    if (!ui) return;
    const btn = ui.lb.querySelector('[data-act="' + act + '"]');
    if (!btn) return;
    btn.style.borderColor = ok ? 'rgba(22,163,74,.9)' : 'rgba(229,72,77,.9)';
    setTimeout(() => { btn.style.borderColor = ''; }, 1000);
  }

  async function copyLink() {
    const c = current();
    if (!c) return;
    const ok = await U.copyText(c.url);
    flashButton('link', ok);
  }

  async function copyImage() {
    const c = current();
    if (!c) return;
    try {
      const res = await U.sendToBg({
        type: MSG.FETCH_IMAGE,
        payload: { url: c.url, pageUrl: pageUrl || location.href }
      });
      if (!res || !res.ok) throw new Error((res && res.error) || t('pg.fetchImageFailed'));

      const blob = await (await fetch(res.dataUrl)).blob();
      const png = await U.toPngBlob(blob);

      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error(t('pg.copyUnsupported'));
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      flashButton('copyimg', true);
    } catch (e) {
      console.warn('[ImageHunter] 复制图片失败', e);
      flashButton('copyimg', false);
    }
  }

  function openInTab() {
    const c = current();
    if (!c) return;
    if (U.isDataUrl(c.url)) return;
    try { window.open(c.url, '_blank', 'noopener'); } catch (e) { /* ignore */ }
  }

  /**
   * 「在图库中打开」：把当前这张图交给图库页，由它定位到对应卡片。
   *
   * 存在的理由：悬停预览手里只有鼠标压着的那一个元素，只能送 1 张进灯箱，
   * 于是 ←→ 是 disabled 的、缩略图条也是隐藏的。用户看完这张想「再看看这一页
   * 还有什么图」，原来只能关掉灯箱、再点扩展图标、再在图库里找刚才那张。
   *
   * 方向是 content → background：由后台决定复用已有图库标签页还是新开一个
   * （它才知道哪个标签页是图库）。这里不关心结果落在哪儿。
   */
  async function openInGallery() {
    const c = current();
    if (!c) return;
    const btn = ui.lb.querySelector('[data-act="gallery"]');
    if (btn) btn.disabled = true;
    let res = null;
    try {
      res = await U.sendToBg({
        type: MSG.OPEN_GALLERY,
        payload: { url: c.url, pageUrl: pageUrl || location.href }
      });
    } catch (e) { res = null; }
    if (btn) btn.disabled = false;

    if (!res || !res.ok) {
      flashButton('gallery', false);
      return;
    }
    // 灯箱留在原页面没有意义了（用户已经在图库那边），顺手收掉，
    // 免得他切回来时还要再按一次 Esc
    close();
  }

  /* ---------------------------- 开关 ---------------------------- */

  /* 这些键在灯箱里没有对应操作，但**会把底下的页面滚走**。
     只拦 Esc/←/→ 远远不够 —— 空格和 ↑↓ 才是用户翻页最常按的键，
     不拦的话关掉灯箱会发现文章已经不在原来的位置了。 */
  const SCROLL_KEYS = {
    ArrowUp: 1, ArrowDown: 1, PageUp: 1, PageDown: 1,
    Home: 1, End: 1, ' ': 1, Spacebar: 1
  };

  function onKeyDown(e) {
    if (!IH.__lightboxOpen) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

    if (SCROLL_KEYS[e.key]) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(index - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(index + 1); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); e.stopPropagation(); saveCurrent(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); setScale(scale * 1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setScale(scale / 1.25); }
    else if (e.key === '0') { e.preventDefault(); setScale(1); }
  }

  /**
   * @param {Array} items 图片列表，每项 { url, width, height, type, sizeBytes, alt, restored }
   * @param {number} startIndex 打开时定位到第几张
   * @param {{pageUrl?: string, host?: string}} [opts]
   *        pageUrl = 这些图片真正所在的页面。内容脚本里可以不传（默认 location.href）；
   *        图库页里**必须传**，否则保存/复制时带的 Referer 是 chrome-extension://，
   *        防盗链站点会直接拒绝。
   *        host = 'content' | 'gallery'（默认 gallery）。只影响「在图库中打开」
   *        按钮显不显示 —— 网页里的悬停预览才需要它。
   */
  /**
   * 按「最小尺寸」把太小的图片挡在灯箱外。
   *
   * 判据是**较短边**（宽高都要达标）：分隔条那种 1200×8 才会被筛掉；
   * 只看最长边的话它反而合格。用的是候选身上的 width/height ——
   * 灯光列表来自嗅探结果，那里已经尽力补过尺寸了（scanner 的 finishList）。
   *
   * 尺寸未知（探测超时 / 还没加载完）**一律放行**：宁可多给几张让用户自己划过去，
   * 也不要因为一次探测失败就悄悄把图藏起来。判断权交给用户，不交给超时。
   *
   * @returns {{list: Array, dropped: number, minSize: number}}
   */
  function applySizeFilter(items, min) {
    if (!min || min <= 0) return { list: items, dropped: 0, minSize: 0 };
    let out = [];
    let gone = 0;
    for (const c of items) {
      const w = Number(c && c.width) || 0;
      const h = Number(c && c.height) || 0;
      if (w > 0 && h > 0 && Math.min(w, h) < min) { gone++; continue; }
      out.push(c);
    }
    return { list: out, dropped: gone, minSize: min };
  }

  /** 当前生效的阈值（读失败时按「不过滤」处理 —— 设置坏了不该让预览打不开） */
  function currentMinSize() {
    try {
      const s = IH.Store && IH.Store.getSettings && IH.Store.getSettings();
      const v = Number(s && s.lightboxMinSize);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }

  function open(items, startIndex, opts) {
    if (!items || !items.length) return;
    pageUrl = (opts && opts.pageUrl) || location.href;
    host = (opts && opts.host) || 'gallery';

    /* 先过滤，再定位。
     *
     * 顺序不能反：startIndex 是**原列表**里的下标，过滤会把前面的项挤走。
     * 所以先按「当前这张」的地址在原列表里认一下位置，再从过滤后的列表里
     * 按同一张图重新定位 —— 否则用户点的是第 6 张，打开却跳到第 2 张。
     *
     * 认不出（地址不在列表里 / 没有地址）才退回用原下标夹取，最坏是定位偏几张，
     * 总比「点了预览打开的是别的图」强。 */
    const src = items.slice();
    const at = U.clamp(startIndex | 0, 0, src.length - 1);
    const anchor = src[at] && src[at].url;

    minSize = currentMinSize();
    const r = applySizeFilter(src, minSize);
    list = r.list;
    dropped = r.dropped;

    /* 过滤后一张不剩：阈值把**所有**候选都筛掉了（真实的「点了一张小图标」场景）。
     * 这时放开过滤、只显示用户点的那一张 —— 「点了预览什么都没弹」是最糟的结果。
     *
     * dropped / minSize 要**保留**，不能清成 0：用户刚刚正是被这个阈值挡住的那一个，
     * 灯箱里必须明白写着「已按 9999px 过滤 11 张」，否则他看到孤零零的 1 / 1，
     * 只会以为「这页就这一张图」或者「嗅探坏了」——
     * 而这恰恰是这个提示最该起作用的时候。 */
    if (!list.length) {
      dropped = src.length - 1;
      list = [src[at]];
      index = 0;
    } else {
      let found = anchor ? list.findIndex((c) => c && c.url === anchor) : -1;
      if (found < 0) found = U.clamp(at, 0, list.length - 1);
      index = found;
    }

    stripFrom = stripTo = 0;      // 换了列表，缩略图条必须重建

    ensureUI();
    if (!installed) {
      installed = true;
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', () => {
        if (IH.__lightboxOpen) { setScale(scale); }
      }, { passive: true });
    }

    applyHost();
    render();
    ui.host.style.pointerEvents = 'auto';
    IH.__lightboxOpen = true;
    lockScroll();
    requestAnimationFrame(() => ui.lb.classList.add('ih-show'));
    if (IH.Hover) IH.Hover.hide();
  }

  function close() {
    if (!ui) return;
    IH.__lightboxOpen = false;
    unlockScroll();
    ui.lb.classList.remove('ih-show');
    ui.host.style.pointerEvents = 'none';
    // 释放大图，避免长时间占用内存
    setTimeout(() => {
      if (!IH.__lightboxOpen && ui) {
        ui.img.removeAttribute('src');
        ui.strip.textContent = '';
        stripFrom = stripTo = 0;      // 下次打开要重建缩略图窗口
      }
    }, 240);
  }

  // save 是给快捷键用的：灯箱开着时按「保存悬停图」，要保存的显然是正在看的那一张，
  // 而不是鼠标底下那张（鼠标多半根本没在图片上）。
  IH.Lightbox = {
    open, close, save: saveCurrent,
    isOpen: () => !!IH.__lightboxOpen,
    /* 供 content/main.js 的 syncTheme 用（理由同 hover.js 的同名方法） */
    host: () => (ui ? ui.host : null),
    /* 过滤现场（只读快照）。测试靠它区分「列表确实被过滤了」和
       「页面本来就只有这几张」—— 只看 DOM 计数分不清这两件事。 */
    lastFilter: () => ({ minSize, dropped, kept: list.length })
  };
})();
