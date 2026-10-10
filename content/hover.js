/* ==========================================================================
 * ImageHunter — content/hover.js
 * 单图快速操作：鼠标悬停时在图片右上角浮现一小组圆形按钮
 *   放大镜 → 大图预览（就地开灯箱，不跳走）
 *   下载箭头 → 保存原图
 *
 * 下载键四态反馈：idle 下载图标 → saving 转圈 → done 绿色对勾 → error 红色感叹号
 * （预览键也有异步态：点下去要先整理本页全部图片，期间转圈 + 气泡说明在等什么）
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.__hoverInstalled) return;
  IH.__hoverInstalled = true;

  const C = IH.C;
  const U = IH.U;
  const MSG = C.MSG;
  /* 悬停按钮的标题与气泡都是给用户看的，跟着界面语言走。
     写成函数而不是在顶层取值 —— 那时 Store 还没加载，语言判定不出来。 */
  const t = (k, a) => IH.I18n.t(k, a);

  /* ---------------------------- 图标 ---------------------------- */

  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3.5v11.5"/><path d="M7 10.5l5 5 5-5"/><path d="M4.5 20h15"/></svg>';

  // 放大镜里带个加号 —— 和顶栏「探测体积」的准星、图库卡片上的放大镜区分开，
  // 一眼能认出是「放大看原图」
  const ICON_PREVIEW =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M19.5 19.5l-4.4-4.4"/>' +
    '<path d="M10.6 8.2v4.8"/><path d="M8.2 10.6h4.8"/></svg>';

  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4.5 12.5l5 5L19.5 6.5"/></svg>';

  const ICON_ERROR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M12 5.5v8.5"/><circle cx="12" cy="18.6" r="1.5" fill="currentColor" stroke="none"/></svg>';

  /* ---------------------------- 状态 ---------------------------- */

  let ui = null;                 // { host, root, bar, preview, btn, bubble }
  let target = null;             // { el, kind }
  let state = 'idle';            // idle | saving | done | error
  let previewBusy = false;       // 预览键：正在整理本页图片
  let showTimer = null;
  let hideTimer = null;
  let resetTimer = null;
  let bubbleTimer = null;
  let installed = false;

  function settings() { return IH.Store.getSettings(); }

  /**
   * 自己是不是跑在子 frame 里？
   *
   * 内容脚本注入到**所有** frame，但灯箱是 `position:fixed` 铺满**当前文档**的 ——
   * 在子 frame 里开就会被 iframe 的边界裁成一小块。所以子 frame 里的预览请求
   * 要交回顶层 frame 去开（见 openPreview）。跨源时读 `window.top` 会抛错，
   * 那种情况按「在子 frame 里」处理 —— 反正它也一定是。
   */
  const inSubFrame = (() => {
    try { return window.top !== window; } catch (e) { return true; }
  })();

  /* ---------------------------- UI 构建 ---------------------------- */

  /** 统一的「不把事件漏给宿主页面」处理 —— 页面自己的点击/拖拽逻辑不能被我们的按钮触发 */
  function seal(btn, onClick) {
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    btn.addEventListener('mouseup', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    }, true);
    btn.addEventListener('mouseenter', cancelHide);
  }

  function makeButton(cls, label, title, icon) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-hover-btn ' + cls;
    btn.setAttribute('aria-label', label);
    btn.title = title;
    btn.innerHTML = icon;
    return btn;
  }

  function ensureUI() {
    if (ui) return ui;

    const created = U.createShadowHost(
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;'
    );

    // bar 才是定位/显隐的载体（.ih-hover 从「一个按钮」升级成「一排按钮」）
    const bar = document.createElement('div');
    bar.className = 'ih-hover';

    const preview = makeButton('ih-hover-preview', t('pg.preview'), t('pg.previewTitle'), ICON_PREVIEW);
    seal(preview, () => { if (target) openPreview(target); });

    const btn = makeButton('ih-hover-save', t('pg.saveOriginal'), t('pg.saveOriginalTitle'), ICON_DOWNLOAD);
    seal(btn, () => { if (target) saveElement(target); });

    bar.appendChild(preview);
    bar.appendChild(btn);

    const bubble = document.createElement('div');
    bubble.className = 'ih-bubble';

    created.root.appendChild(bar);
    created.root.appendChild(bubble);

    const parent = document.documentElement || document.body;
    if (parent) parent.appendChild(created.host);

    ui = { host: created.host, root: created.root, bar, preview, btn, bubble };
    setInteractive(false);   // 初始隐藏，不拦截页面点击
    return ui;
  }

  /* ---------------------------- 定位 ---------------------------- */

  const BTN_SIZE = 32;    // 单个圆钮直径，必须与 overlay.css 的 .ih-hover-btn 保持一致
  const BTN_GAP = 6;      // 两个圆钮之间的间距
  const EDGE_GAP = 8;     // 与图片右上角、视口边缘的留白
  const BAR_W = BTN_SIZE * 2 + BTN_GAP;

  const reposition = U.rafThrottle(() => {
    if (!target || !ui || !ui.bar.classList.contains('ih-show')) return;
    position();
  });

  function position() {
    if (!target || !ui) return;
    let rect;
    try { rect = target.el.getBoundingClientRect(); } catch (e) { hideNow(); return; }

    // 图片已完全滚出视口 → 隐藏
    const vw = window.innerWidth, vh = window.innerHeight;
    if (rect.bottom < -8 || rect.top > vh + 8 || rect.right < -8 || rect.left > vw + 8) {
      hideNow();
      return;
    }

    // 整排贴着图片右上角，右对齐 —— 这样下载键永远停在「图片右上角」那个老位置，
    // 预览键往左长出去，不改变已经形成的肌肉记忆。
    let left = rect.right - BAR_W - EDGE_GAP;
    let top = rect.top + EDGE_GAP;

    // 图片很窄时贴紧右边缘
    if (rect.width < BAR_W + EDGE_GAP * 2) left = rect.right - BAR_W - 4;

    left = U.clamp(left, 4, Math.max(4, vw - BAR_W - 4));
    top = U.clamp(top, 4, Math.max(4, vh - BTN_SIZE - 4));

    ui.bar.style.left = Math.round(left) + 'px';
    ui.bar.style.top = Math.round(top) + 'px';
  }

  function positionBubble() {
    if (!ui || !target) return;
    const b = ui.bubble;
    let rect;
    try { rect = target.el.getBoundingClientRect(); } catch (e) { return; }

    // 先归零再测量，避免旧位置影响宽度计算
    b.style.left = '0px';
    b.style.top = '0px';
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;

    let left = rect.right - bw - 8;
    let top = rect.top + BTN_SIZE + 14;

    if (top + bh > window.innerHeight - 8) {
      top = Math.max(8, rect.top - bh - 10);
    }
    left = U.clamp(left, 8, Math.max(8, window.innerWidth - bw - 8));

    b.style.left = Math.round(left) + 'px';
    b.style.top = Math.round(top) + 'px';
  }

  /* ---------------------------- 状态 ---------------------------- */

  function setState(next) {
    state = next;
    if (!ui) return;
    const btn = ui.btn;
    btn.classList.toggle('ih-saving', next === 'saving');
    btn.classList.toggle('ih-done', next === 'done');
    btn.classList.toggle('ih-error', next === 'error');

    if (next === 'saving') {
      btn.innerHTML = '<div class="ih-spinner"></div>';
      btn.title = t('pg.saving');
    } else if (next === 'done') {
      btn.innerHTML = ICON_CHECK;
      btn.title = t('pg.saved');
    } else if (next === 'error') {
      btn.innerHTML = ICON_ERROR;
      btn.title = t('pg.saveFailedRetry');
    } else {
      btn.innerHTML = ICON_DOWNLOAD;
      btn.title = t('pg.saveOriginalTitle');
    }
  }

  /**
   * 预览键的忙碌态。
   *
   * 点预览不是「立刻开个灯箱」了 —— 要先整理出本页全部图片（含原图还原），
   * 这段时间里按钮必须转起来，否则用户看到的就是「点了没反应」。
   * 和下载键的四态分开维护：两个键可以同时各自忙（一边保存、一边整理预览），
   * 共用一个 state 的话后一个动作会把前一个的反馈冲掉。
   */
  function setPreviewBusy(on) {
    previewBusy = !!on;
    if (!ui) return;
    const p = ui.preview;
    p.classList.toggle('ih-busy', previewBusy);
    p.innerHTML = previewBusy ? '<div class="ih-spinner"></div>' : ICON_PREVIEW;
    p.title = previewBusy
      ? t('pg.collecting')
      : t('pg.previewTitle');
  }

  /** 「正在忙」：保存中，或正在整理本页图片。这两种时候收起 UI 等于把反馈藏起来 */
  function busy() { return state === 'saving' || previewBusy; }

  /**
   * 显式控制整排按钮的可点击性（设在容器上，两个键一起继承）。
   * 宿主元素设了 pointer-events:none，该属性会被子元素继承；
   * overlay.css 里虽然做了恢复，但如果样式表加载失败就会退化成「看得见点不动」，
   * 所以这里再用内联样式兜一层，保证点击永远有效。
   */
  function setInteractive(on) {
    if (!ui || !ui.bar) return;
    ui.bar.style.pointerEvents = on ? 'auto' : 'none';
  }

  /** 文件名太长时中间省略，保留扩展名（气泡宽度有限） */
  function shortName(name) {
    const s = String(name || '');
    if (s.length <= 26) return s;
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? s.slice(dot) : '';
    return s.slice(0, Math.max(8, 26 - ext.length - 1)) + '…' + ext;
  }

  /**
   * 和具体图片无关的一句提示（比如「先把鼠标移到图片上」）。
   * 贴在视口底部中间 —— 这时候没有 target 可以依附，positionBubble 会直接 no-op，
   * 气泡会留在上一次的位置上，看起来像是坏了。
   */
  function showCenterHint(text) {
    ensureUI();
    const b = ui.bubble;
    b.textContent = text;
    b.classList.add('ih-bubble-error');
    b.style.left = '0px';
    b.style.top = '0px';
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    b.style.left = Math.round(Math.max(8, (window.innerWidth - bw) / 2)) + 'px';
    b.style.top = Math.round(Math.max(8, window.innerHeight - bh - 36)) + 'px';
    void b.offsetWidth;               // 触发过渡
    b.classList.add('ih-show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      b.classList.remove('ih-show');
      b.classList.remove('ih-bubble-error');
    }, 2600);
  }

  function showBubble(text, isError) {
    ensureUI();
    const b = ui.bubble;
    b.textContent = text;
    b.classList.toggle('ih-bubble-error', !!isError);
    positionBubble();
    // 触发过渡
    void b.offsetWidth;
    b.classList.add('ih-show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.remove('ih-show'), isError ? 2600 : 1900);
  }

  /**
   * 一直显示、直到明确收起的那句提示。
   *
   * 整理本页图片要多久不取决于我们（冷还原最长好几秒），
   * 用 showBubble 那套定时消失的话，扫描还没完提示就自己没了，
   * 用户又回到「点了没反应」的状态。所以这里**不排**自动隐藏。
   */
  function showBusyBubble(text) {
    ensureUI();
    const b = ui.bubble;
    b.textContent = text;
    b.classList.remove('ih-bubble-error');
    positionBubble();
    void b.offsetWidth;
    b.classList.add('ih-show');
    clearTimeout(bubbleTimer);
  }

  function hideBubble() {
    clearTimeout(bubbleTimer);
    if (ui) ui.bubble.classList.remove('ih-show');
  }

  /* ---------------------------- 显示 / 隐藏 ---------------------------- */

  /**
   * 本站点是否被排除。
   *
   * 排除列表的语义是「这个域名上不要出现我的 UI」。门设在**显示路径**上
   * （onMouseOver / show / onClick），而不是只靠在 boot 时不调用 start() ——
   * 因为用户在别的标签页改了设置之后，已经打开的页面不会重新 boot，
   * 而这里的 `settings()` 每次都读最新缓存，改完立即生效。
   */
  function blocked() {
    try { return IH.U.isHostBlocked(location.href, settings().blockedHosts); } catch (e) { return false; }
  }

  function isSaveable(el) {
    if (!el || el.nodeType !== 1) return false;
    const s = settings();
    const min = Math.max(16, s.minSize || 64);

    let rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }

    // 以「页面显示尺寸」为准：太小的图标 / 分隔条 / 雪碧图碎片 不显示图标
    const maxSide = Math.max(rect.width, rect.height);
    const minSide = Math.min(rect.width, rect.height);
    if (maxSide < min || minSide < 16) return false;

    // IMG 若已加载，用真实像素再确认一次不是占位图
    if (el.tagName === 'IMG' && el.naturalWidth && el.naturalHeight) {
      if (el.naturalWidth <= 2 && el.naturalHeight <= 2) return false;
    }
    return true;
  }

  function scheduleShow(found) {
    cancelHide();
    clearTimeout(showTimer);
    const delay = Math.max(0, settings().hoverDelay != null ? settings().hoverDelay : 120);
    showTimer = setTimeout(() => show(found), delay);
  }

  function show(found) {
    if (!settings().hoverEnabled) return;
    if (blocked()) return;
    if (IH.__lightboxOpen) return;
    if (!isSaveable(found.el)) return;

    ensureUI();
    target = found;
    setState('idle');
    position();
    setInteractive(true);
    // 下一帧加类，保证过渡生效
    requestAnimationFrame(() => { if (ui) ui.bar.classList.add('ih-show'); });
  }

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    cancelHide();
    hideTimer = setTimeout(hideNow, 180);
  }

  function hideNow() {
    if (busy()) return;   // 保存中 / 整理预览中不隐藏，保证有反馈
    // 作废还没跑的那一帧悬停处理：滚动 / 移出之后不该再被翻出来显示
    pendingOverEl = null;
    target = null;
    if (ui) {
      ui.bar.classList.remove('ih-show');
      setInteractive(false);          // 隐藏后不再拦截页面点击
    }
  }

  /* ---------------------------- 事件 ---------------------------- */

  /**
   * findSaveTarget 结果缓存。
   *
   * mouseover 会反复打在同一块区域上，而 findSaveTarget 的背景图分支要对最多 4 层
   * 祖先逐个跑 `getComputedStyle()`（强制样式重算）+ `getBoundingClientRect()`（强制布局），
   * 交替执行就是典型的布局抖动。同一元素 400ms 内不重复计算，抖动就没了。
   *
   * 用 WeakMap：元素被回收时缓存跟着消失，不会像普通 Map 那样攒着不放。
   * TTL 取 400ms —— 够短，懒加载图片换了 src 也能很快重新解析。
   */
  const findCache = new WeakMap();
  const FIND_TTL = 400;

  function findSaveTargetCached(el) {
    const now = Date.now();
    const hit = findCache.get(el);
    if (hit && now - hit.at < FIND_TTL) return hit.found;

    const found = IH.Scanner.findSaveTarget(el);
    findCache.set(el, { at: now, found });
    return found;
  }

  function isHostEl(el) {
    return !!(el && el.hasAttribute && el.hasAttribute('data-ih-host'));
  }

  function handleHostOver(t) {
    if (ui && t === ui.host) cancelHide();
    else scheduleHide();
  }

  /**
   * 处理一次「悬停到某个元素」。
   * 传入的必须是元素本身 —— 不要延后去读事件对象，免得平白多留一份引用。
   */
  function handleOver(t) {
    if (isHostEl(t)) { handleHostOver(t); return; }

    if (IH.__lightboxOpen) { scheduleHide(); return; }

    const found = findSaveTargetCached(t);
    if (!found || !isSaveable(found.el)) { scheduleHide(); return; }

    if (target && target.el === found.el) { cancelHide(); return; }
    scheduleShow(found);
  }

  /* mouseover 节流：只处理「本帧最后一次」的 target。
     鼠标划过复杂页面时这个事件每秒能触发几十上百次，每次都全量算一遍是白费。
     （position() 早就用 U.rafThrottle 节流了，onMouseOver 之前漏了。） */
  let pendingOverEl = null;
  let overFrame = 0;

  function flushOver() {
    overFrame = 0;
    const el = pendingOverEl;
    pendingOverEl = null;
    if (!el || !el.isConnected) return;      // 这一帧里元素已经被移出文档
    handleOver(el);
  }

  function onMouseOver(e) {
    if (!settings().hoverEnabled) return;
    if (blocked()) return;
    const t = e.target;
    if (!t || t.nodeType !== 1) return;

    // 我们自己的 UI 宿主必须**立刻**处理：鼠标在下载图标上移动时如果也延后一帧，
    // 会先被 scheduleHide 藏掉再显示，肉眼可见地闪。
    if (isHostEl(t)) { handleHostOver(t); return; }

    pendingOverEl = t;
    if (!overFrame) overFrame = requestAnimationFrame(flushOver);
  }

  function onMouseLeaveDoc(e) {
    // relatedTarget 为空说明指针离开了整个窗口
    if (!e.relatedTarget) scheduleHide();
  }

  function onScrollOrResize() {
    if (busy()) return;
    hideNow();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && ui) {
      clearTimeout(resetTimer);
      setState('idle');
      hideNow();
    }
  }

  /** Alt + 点击图片 → 免悬停直接保存 */
  function onClick(e) {
    const s = settings();
    if (!s.altClickSave || !e.altKey) return;
    if (blocked()) return;
    const found = IH.Scanner.findSaveTarget(e.target);
    if (!found || !isSaveable(found.el)) return;
    e.preventDefault();
    e.stopPropagation();
    saveElement(found);
  }

  /* ---------------------------- 预览 ---------------------------- */

  /** 整理本页图片最长等多久。后台自己还有 15s 的还原兜底，这里是内容脚本再兜一层 */
  const PREVIEW_SCAN_TIMEOUT = 20000;

  /**
   * 向后台要一份「本页全部图片」的**最终**结果（含原图还原、覆盖所有 frame）。
   *
   * 超时 / 出错一律 resolve(null)，由调用方降级 —— 消息通道出问题时
   * 宁可退回「只预览这一张」，也不能让按钮永远转下去。
   */
  function scanForPreview() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), PREVIEW_SCAN_TIMEOUT);
      try {
        U.sendToBg({ type: MSG.SCAN_TAB, finalOnly: true }).then((r) => finish(r), () => finish(null));
      } catch (e) { finish(null); }
    });
  }

  /**
   * 在整份列表里定位「鼠标压着的那一张」。
   *
   * 两边各自跑过一次原图还原，地址可能一个已还原、一个没有，所以四个方向都要认：
   * 当前这张的「现在地址 / 还原前地址」× 列表项的「现在地址 / 还原前地址」，
   * 再加上元素上的原始 src（还原撞上时间预算时，它是唯一还能对上的东西）。
   *
   * 认不出来就返回 -1 —— 由调用方把当前这张补到最前面，
   * 而不是随便挑一个下标假装就是它。
   */
  function indexOfCurrent(list, cand, el) {
    const now = cand.url ? U.normalizeUrl(cand.url) : '';

    // 第一优先：当前地址直接对上（两边都还原过的话，这是最精确的一种）
    if (now) {
      for (let i = 0; i < list.length; i++) {
        if (U.normalizeUrl(list[i].url) === now) return i;
      }
    }

    /* 第二优先：拿「还原前的地址」去对。
       列表那一侧可能根本没跑还原（降级到本地采集时），
       也可能当前这张已被还原、而列表里存的还是页面上的原地址。
       元素上的 src 也算一个 —— 还原撞上时间预算时它是唯一还能对上的东西
       （走属性而非 getAttribute：currentSrc / src 是绝对地址）。 */
    const alts = [];
    if (cand.restoredFrom) alts.push(U.normalizeUrl(cand.restoredFrom));
    if (el && el.tagName === 'IMG') {
      const raw = el.currentSrc || el.src || '';
      if (raw) alts.push(U.normalizeUrl(raw));
    }
    const altKeys = alts.filter(Boolean);

    if (altKeys.length) {
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (altKeys.indexOf(U.normalizeUrl(it.url)) >= 0) return i;
        if (it.restoredFrom && altKeys.indexOf(U.normalizeUrl(it.restoredFrom)) >= 0) return i;
      }
    }
    return -1;
  }

  /**
   * 拼出预览要用的列表 + 起始下标。
   *
   * 三级降级，每一级都比上一级少一点东西，但**没有一级会让点击落空**：
   *   1. 后台整页扫描的最终结果 —— 含原图还原、覆盖所有 frame，
   *      还吃扫描缓存（这个页面先开过图库的话，这一步是瞬时的）
   *   2. 本地 collectAll —— 后台那条路不通时的兜底。只扫当前 frame、不做还原，
   *      但至少仍是「本页全部图片」，能翻
   *   3. 只有当前这一张 —— 与改动前完全一致。灯箱会显示「1 / 1」，不会撒谎
   */
  async function buildPreviewList(cand, self, el) {
    const res = await scanForPreview();
    const imgs = res && res.ok && Array.isArray(res.images) ? res.images : null;

    if (imgs && imgs.length) {
      /* 后台为了给图库用，合并时按面积降序排过一次；
         预览要的是「按页面顺序翻」，所以这里重排回文档顺序。
         （order 是各 frame 内部各自数的，跨 frame 只保证稳定，不保证谁先谁后。） */
      const list = imgs.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const at = indexOfCurrent(list, cand, el);
      if (at >= 0) return { list: placeSelf(list, at, self), index: at };
      // 两边还原口径不同时会对不上。补在最前面 —— 用户点开看到的仍是自己那张，
      // 往后翻是本页其余图片，总比「打开的是别的图」强
      list.unshift(self);
      return { list, index: 0 };
    }

    // 后台那条路没给结果（站点被排除 / 那一帧正忙 / 消息异常）→ 本地采一遍
    let local = [];
    try {
      const r = IH.Scanner.collectAll(settings());
      if (r && r.list && r.list.length) {
        local = r.list
          .filter((c) => c && c.url)
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map((c) => IH.Scanner.toWire(c));
      }
    } catch (e) { local = []; }

    if (local.length) {
      const at = indexOfCurrent(local, cand, el);
      if (at >= 0) return { list: placeSelf(local, at, self), index: at };
      local.unshift(self);
      return { list: local, index: 0 };
    }

    return { list: [self], index: 0 };
  }

  /**
   * 把「鼠标压着的这一张」放回它命中的那个位置。
   *
   * 命中的那一项要用 resolveForElement 的结果顶掉：它是针对**这一个元素**
   * 解析出来的（已补尺寸、已还原），而列表里那一项可能还停在页面上的地址 ——
   * 降级到本地采集时尤其如此，那一级压根没跑还原。不顶掉的话，
   * 用户点开的就会是缩略图版本，等于把「预览看原图」这件事弄丢了。
   */
  function placeSelf(list, at, self) {
    list[at] = self;
    return list;
  }

  /**
   * 就地开大图预览，并且能在**本页全部图片**之间左右切换。
   *
   * 为什么不只送这一张：悬停场景下手里确实只有鼠标压着的那一个元素，
   * 但「点开一张图想接着看下一张」是再自然不过的动作 —— 只给一张，
   * 灯箱的左右键就是摆设，用户得退出去、再一张张点开。
   * 所以这里按当前设置把本页扫一遍，拿到还原后的原图列表再开灯箱。
   *
   * 代价是要等：原图还原得给每张候选发一次真实加载请求。宁可等一下拿到原图，
   * 也不要先把页面上的缩略图地址铺出来、翻到一半再被换成另一批 URL。
   * 但「等」必须是看得见的等 —— 按钮转圈 + 气泡说明在等什么。
   */
  async function openPreview(found) {
    if (!found || !found.el) return;
    if (previewBusy) return;          // 已经在整理了，别再叠一次全页扫描
    if (!IH.Lightbox) {
      showBubble(t('pg.previewNotLoaded'), true);
      return;
    }

    let cand = null;
    try {
      cand = await IH.Scanner.resolveForElement(found.el);
    } catch (e) { /* 解析失败按「没有可预览的图片」处理 */ }

    if (!cand || !cand.url) {
      showBubble(t('pg.previewNone'), true);
      return;
    }

    const el = found.el;
    const alt = (el.getAttribute && el.getAttribute('alt')) || '';
    const self = {
      url: cand.url,
      width: cand.width || 0,
      height: cand.height || 0,
      type: U.extFromUrl(cand.url),
      sizeBytes: null,          // 悬停路径不做体积探测，留空由灯箱显示「尺寸未知」那套逻辑兜
      alt,
      restored: !!cand.restored,
      // 还原前的地址留着：预览里翻到某一张再点「在图库中打开」时，
      // 图库那一侧可能还是页面上的版本，只能靠这个对上
      restoredFrom: cand.restoredFrom || null
    };

    setPreviewBusy(true);
    showBusyBubble(t('pg.collecting'));

    let view = { list: [self], index: 0 };
    try {
      view = await buildPreviewList(cand, self, el);
    } catch (e) {
      view = { list: [self], index: 0 };
    }

    setPreviewBusy(false);
    hideBubble();

    // 先把自己收起来：灯箱是全屏的，悬停按钮留在下面既没意义，
    // 还可能因为 pointer-events 残留挡住灯箱的边缘点击区
    hideNow();

    // 子 frame 里开灯箱会被 iframe 的边界裁成一小块 —— 交回顶层 frame 去开。
    // 顶层拿不到内容脚本时（chrome:// 之类）退回本地开：宁可裁一点，也别什么都不显示。
    if (inSubFrame) {
      let ok = false;
      try {
        const r = await U.sendToBg({
          type: MSG.OPEN_LIGHTBOX,
          // host: 'content' —— 网页里的预览才显示「在图库中打开」
          // （在预览里翻到某一张时，可以一键跳到图库里的同一张）
          payload: {
            list: view.list, index: view.index,
            pageUrl: location.href, host: 'content'
          }
        });
        ok = !!(r && r.ok);
      } catch (e) { /* 退回本地开 */ }
      if (ok) return;
    }

    IH.Lightbox.open(view.list, view.index, { pageUrl: location.href, host: 'content' });
  }

  /* ---------------------------- 保存 ---------------------------- */

  async function saveElement(found) {
    if (state === 'saving') return;

    ensureUI();
    target = found;
    position();
    ui.bar.classList.add('ih-show');
    setInteractive(true);
    setState('saving');
    clearTimeout(resetTimer);

    try {
      const cand = await IH.Scanner.resolveForElement(found.el);
      if (!cand || !cand.url) throw new Error(t('pg.noSavable'));

      const s = settings();
      const res = await U.sendToBg({
        type: MSG.DOWNLOAD_ONE,
        payload: {
          url: cand.url,
          pageUrl: location.href,
          width: cand.width || 0,
          height: cand.height || 0,
          filename: U.buildFilename(cand, s, 0),
          restored: !!cand.restored
        }
      });

      if (res && res.ok) {
        setState('done');
        if (res.skipped) {
          // 被「跳过已下载」拦下 —— 这不是保存成功，必须说清楚，
          // 否则用户会以为文件已经存下来了却怎么也找不到。
          showBubble(t('pg.skippedDownloaded'), false);
        } else {
          // dim 自带前导空格（尺寸未知时就是空串，不会多出一个悬空空格）
          const dim = cand.width && cand.height ? ' ' + cand.width + '×' + cand.height : '';
          // 「已保存」和「已保存原图」是两句不同的话，不是拼接 ——
          // 英文里原图那句要加个空格，拼出来会变成 "Savedoriginal 1920×1080"
          let text = cand.restored ? t('pg.savedOriginalDim', { dim }) : t('pg.savedDim', { dim });
          // 开了「保存到子目录」时说清存到哪一层 —— 否则用户拿着一个文件名
          // 在下载目录里翻半天
          if (res.folder) text += t('pg.savedFolder', { folder: res.folder });
          // Chrome 会按真实 MIME 纠正扩展名，如实告知实际文件名，免得用户找不到
          if (res.renamed && res.filename) text += t('pg.savedAs', { name: shortName(res.filename) });
          showBubble(text, false);
        }
        resetTimer = setTimeout(() => setState('idle'), 1400);
      } else {
        throw new Error((res && res.error) || t('pg.downloadFailed'));
      }
    } catch (err) {
      setState('error');
      showBubble(String((err && err.message) || err || t('pg.saveFailed')), true);
      resetTimer = setTimeout(() => setState('idle'), 2400);
    }
  }

  /* ---------------------------- 启动 ---------------------------- */

  function start() {
    if (installed) return;
    installed = true;

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseLeaveDoc, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);

    window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });

    // 页面滚动容器内部滚动也隐藏
    document.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });

    // 设置变化时立即生效
    IH.Store.onChange((payload) => {
      if (!payload || payload.type !== 'settings') return;
      if (!settings().hoverEnabled) hideNow();
      /* 站点被排除时收起已经浮出来的按钮。
         典型场景：用户在另一个标签页把当前站点加进了排除列表，
         这个页面不会重新 boot，只能靠这里把已经显示的 UI 收掉。
         （启动期就不挂监听那件事由 main.js 负责 —— 它管「要不要 start」，
         这里管「已经 start 了之后的行为」。） */
      else if (blocked()) hideNow();
    });
  }

  /**
   * 快捷键「保存鼠标当前悬停的那张图」。
   *
   * 三个分支，顺序是有讲究的：
   *   1. 灯箱开着 → 保存**正在看的那一张**。此时鼠标多半没停在图片上
   *      （灯箱是全屏的），去猜鼠标底下那张反而会存错图。
   *   2. 有悬停目标 → 走和点悬停下载键完全相同的那条路（含气泡与四态反馈）。
   *   3. 都没有 → 在页面底部说一句「先把鼠标移到图片上」。
   *      **不能什么都不做** —— 用户按了快捷键却毫无反应，只会以为扩展坏了。
   */
  async function saveHovered() {
    if (blocked()) return { ok: false, error: 'blocked' };

    if (IH.__lightboxOpen && IH.Lightbox && IH.Lightbox.save) {
      IH.Lightbox.save();
      return { ok: true, via: 'lightbox' };
    }

    if (target && target.el && target.el.isConnected) {
      await saveElement(target);
      return { ok: true, via: 'hover' };
    }

    showCenterHint(t('pg.hoverFirst'));
    return { ok: false, error: 'no-target' };
  }

  IH.Hover = {
    start,
    saveElement,
    preview: openPreview,
    saveHovered,
    hide: hideNow,
    /* 供 content/main.js 的 syncTheme 用：设置改了主色之后要把它重新刷到
       这个 shadow host 上。UI 还没建时返回 null（那时没什么可刷的，
       建的时候 createShadowHost 会带上当前主题）。 */
    host: () => (ui ? ui.host : null)
  };
})();
