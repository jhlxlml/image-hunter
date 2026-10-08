/* ==========================================================================
 * ImageHunter — content/main.js
 * 内容脚本入口：初始化、消息桥、扫描回报
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.__mainInstalled) return;
  IH.__mainInstalled = true;

  const C = IH.C;
  const U = IH.U;
  const MSG = C.MSG;

  const isTopFrame = (() => {
    try { return window.top === window; } catch (e) { return false; }
  })();

  /**
   * 本站点是否被用户排除（设置页的「站点排除列表」）。
   *
   * 为什么要在**每一帧**各自判断、而不是只在顶层判断：内容脚本注入到所有 frame，
   * 每个 frame 有自己的 `location.hostname`。顶层是被排除的站点时子 frame 可能不是，
   * 反之亦然 —— 各判各的才对得上「这个域名上不要出现我的 UI」。
   *
   * 为什么要判两次（boot 里一次、消息里每次一次）：用户在另一个标签页改了设置后，
   * 已经打开的页面不会重新 boot；这里每次读最新的设置缓存，改完立即生效。
   */
  function isBlocked() {
    try {
      return U.isHostBlocked(location.href, IH.Store.getSettings().blockedHosts);
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------- 扫描 ---------------------------- */

  let scanning = false;
  /** 「忙」时排队等着的那一次请求（只留最新的一条，见 runScan） */
  let queuedScan = null;

  /**
   * 跑一次嗅探并回报结果。
   *
   * 同一帧内不并发扫描 —— 忙的时候**排队**，不丢弃。
   *
   * 这里的排队逻辑曾经被删掉过，理由是「Chrome 串行投递发往同一 frame 的消息，
   * 两次扫描不可能重叠」（AUDIT P3-1）。那个前提是错的：消息确实按序投递，
   * 但 handler **不等待**扫描（`runScan(...)` 之后立刻 sendResponse 确认），
   * 所以第二条 DO_SCAN 完全可以在第一条还没跑完时被投递进来。
   *
   * 实测的复现路径：「关掉图库 → 趁原图还原还没跑完又点一次图标」。
   * 那时候被回一个 `error: 'busy'` 的空结果，用户看到的是「嗅探失败」——
   * 而他明明只是又点了一次图标。
   *
   * 所以改成排队：那一轮扫描本来就要跑完，跑完之后再扫一次（尺寸与探测缓存都已热，
   * 中间结果是毫秒级的）。只留最新的一条 —— 用户连点三次，要的是最后那一次的结果。
   */
  async function runScan(reqId, deep) {
    /* 站点被排除时**如实**回一句「排除了」，而不是回一个空列表。
       回空列表的话图库只会说「本页没有发现图片」—— 那是在撒谎，
       用户明明看得见一页的图，却不知道是自己排除过这个站。 */
    if (isBlocked()) {
      U.sendToBg({
        type: MSG.SCAN_RESULT,
        reqId,
        images: [],
        error: 'blocked',
        pageUrl: location.href,
        title: document.title,
        frameUrl: location.href
      });
      return false;
    }

    if (scanning) {
      queuedScan = { reqId, deep };
      return false;
    }

    scanning = true;
    try {
      await doScanAndReport(reqId, deep);
    } finally {
      scanning = false;
    }

    /* 跑完看看有没有人排队等着。放在 finally **之后**：
       队列里那一次要重新走一遍完整流程（含 isBlocked 检查），
       而不是直接进 doScanAndReport。 */
    const next = queuedScan;
    queuedScan = null;
    if (next) runScan(next.reqId, next.deep);

    return true;
  }

  /**
   * 跑一次嗅探并回报结果。
   *
   * 回报分两个阶段（C.SCAN_PHASE）：
   * - partial：**采集完成、联网步骤（补尺寸 / 原图还原）还没开始**。
   *   它向后台证明「扫描确实在进行」，同时作为还原超时的保底结果 ——
   *   历史上后台只靠「1.5 秒没响应」判断，而冷加载时还原轻松超过 1.5 秒，
   *   于是首次打开图库经常一张图都看不到。
   *   注意这一版里**尺寸可能还没补齐**（未知尺寸显示成「尺寸未知」）：
   *   首次回报的耗时必须由采集（纯 DOM，快且可控）决定，不能由联网步骤决定 ——
   *   否则真实站点上十几张还没加载的图就足以把它推迟到 4 秒以上，
   *   而后台的「内容脚本没动静」判据正是 4 秒（见 content/scanner.js 里第 0 步的注释）。
   * - final：补尺寸 + 还原完成后的最终结果，整体覆盖同一 frame 的 partial。
   *
   * @param {boolean} [deep] 走深度嗅探：先滚动整页、边滚边采集，
   *        用来对付「要滚到底才加载下一批」的无限滚动站点。
   */
  async function doScanAndReport(reqId, deep) {
    let error = null;

    const report = (phase, images) => {
      // 背景图扫描有元素数上限，撞上了要如实带回后台（P2-3）
      let bgTruncated = false;
      let bgElements = 0;
      let restoreTruncated = false;
      let deepTruncated = false;
      const st = IH.Scanner.lastScanStats && IH.Scanner.lastScanStats();
      if (st) {
        bgTruncated = !!st.bgTruncated;
        bgElements = st.bgElements || 0;
        restoreTruncated = !!st.restoreTruncated;
        deepTruncated = !!st.deepTruncated;
      }

      U.sendToBg({
        type: MSG.SCAN_RESULT,
        reqId,
        phase,
        images,
        error,
        pageUrl: location.href,
        title: document.title,
        frameUrl: location.href,
        bgTruncated,
        bgElements,
        restoreTruncated,
        deepTruncated
      });
    };

    let images = [];
    try {
      const onPartial = (early) => report(C.SCAN_PHASE.PARTIAL, early);

      if (deep) {
        // 每滚一屏回报一次进度：整页滚动可能持续十几秒，
        // 没有进度反馈的话用户只能盯着加载动画，会以为卡死了
        const onProgress = (p) => U.sendToBg({
          type: MSG.DEEP_PROGRESS,
          reqId,
          round: p.round,
          total: p.total,
          added: p.added
        });
        const list = await IH.Scanner.deepScan(null, onProgress, onPartial);
        images = list.map((c) => IH.Scanner.toWire(c));
      } else {
        const list = await IH.Scanner.scan(null, onPartial);
        images = list.map((c) => IH.Scanner.toWire(c));
      }
    } catch (e) {
      error = String((e && e.message) || e);
      console.warn('[ImageHunter] 扫描失败', e);
    }
    report(C.SCAN_PHASE.FINAL, images);
  }

  /* ---------------------------- 按 srcUrl 保存（右键菜单） ---------------------------- */

  async function doDownload(cand) {
    const s = IH.Store.getSettings();
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
    return res || { ok: false, error: '无响应' };
  }

  async function saveBySrc(srcUrl) {
    let el = null;

    if (srcUrl) {
      const abs = U.absUrl(srcUrl, document.baseURI);
      const imgs = document.images;
      for (let i = 0; i < imgs.length; i++) {
        const cur = U.absUrl(imgs[i].currentSrc || imgs[i].getAttribute('src') || '', document.baseURI);
        if (cur && cur === abs) { el = imgs[i]; break; }
      }
    }

    if (el) {
      const cand = await IH.Scanner.resolveForElement(el);
      if (!cand) return { ok: false, error: '未找到可保存的图片' };
      return await doDownload(cand);
    }

    if (!srcUrl) return { ok: false, error: '没有可保存的图片地址' };

    // 找不到对应元素时，退化为「按 URL 直接下载 + 尝试原图还原」
    const cand = { url: srcUrl, width: 0, height: 0 };
    try {
      const better = await IH.Scanner.tryRestore(cand, IH.Store.getSettings());
      if (better) {
        cand.url = better.url;
        cand.width = better.w;
        cand.height = better.h;
        cand.restored = true;
      }
    } catch (e) { /* 忽略还原失败，仍按原 URL 下载 */ }
    return await doDownload(cand);
  }

  /* ---------------------------- 消息处理 ---------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;

    switch (msg.type) {
      case MSG.DO_SCAN:
        // runScan 自己负责回报 SCAN_RESULT（含「忙」的情况），这里只确认收到
        runScan(msg.reqId, !!msg.deep);
        sendResponse({ ok: true, accepted: true });
        return true;

      case MSG.OPEN_LIGHTBOX: {
        if (isBlocked()) { sendResponse({ ok: false, error: 'blocked' }); return true; }
        const payload = msg.payload || {};
        try {
          // pageUrl：图片真正所在的页面。子 frame 的预览请求会转发到这里（顶层 frame），
          // 不带上的话保存/复制时 Referer 会变成顶层页面的地址 —— 多数时候能用，
          // 但图片挂在第三方 iframe 上时防盗链就会拒绝。
          // host 由发起方决定：悬停预览传 'content'（显示「在图库中打开」），
          // 面板模式不传 —— 用户本来就在图库面板里，那个按钮没有意义。
          IH.Lightbox.open(payload.list || [], payload.index || 0,
            { pageUrl: payload.pageUrl || '', host: payload.host || 'gallery' });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return true;
      }

      case MSG.OPEN_PANEL:
        if (isBlocked()) { sendResponse({ ok: false, error: 'blocked' }); return true; }
        IH.Panel.show().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case MSG.TOGGLE_PANEL:
        if (isBlocked()) { sendResponse({ ok: false, error: 'blocked' }); return true; }
        IH.Panel.toggle().then((v) => sendResponse({ ok: true, open: v }), () => sendResponse({ ok: false }));
        return true;

      case MSG.SAVE_BY_SRC:
        saveBySrc((msg.payload && msg.payload.srcUrl) || '')
          .then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;

      case MSG.SAVE_HOVERED:
        /* 快捷键「保存鼠标当前悬停的那张图」。后台是广播给所有 frame 的
           （鼠标在哪一帧只有那一帧知道），没有目标的那几帧什么都不做。 */
        if (isBlocked()) { sendResponse({ ok: false, error: 'blocked' }); return true; }
        if (!IH.Hover || !IH.Hover.saveHovered) { sendResponse({ ok: false, error: '悬停模块未加载' }); return true; }
        IH.Hover.saveHovered().then(
          (r) => sendResponse(r),
          (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
        );
        return true;

      case MSG.RESTORE_ONE: {
        /* 单张还原：图库上某张图没还原成功（撞上还原时间预算，或那一次探测超时），
           用户点「还原」按钮时走这里，对这一张单独重跑一次 tryRestore。

           之所以能直接复用 tryRestore：它本来就是单张粒度的纯函数
           （输入 url/width/height，输出「更大的原图」或 null），不依赖 DOM 元素。
           而且它自带「只有确实更大才采纳」的保护，重试也改不坏链接。 */
        const payload = msg.payload || {};
        const url = payload.url || '';
        if (!url) { sendResponse({ ok: false, error: '缺少图片地址' }); return true; }

        const cand = { url, width: payload.width || 0, height: payload.height || 0 };
        (async () => {
          let better = null;
          try {
            better = await IH.Scanner.tryRestore(cand, IH.Store.getSettings(), { refresh: true });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
            return;
          }
          if (!better) {
            // 「没找到更大的原图」是正常结果，不是错误 —— 界面上要分开说
            sendResponse({ ok: true, restored: false });
            return;
          }
          sendResponse({
            ok: true,
            restored: true,
            url: better.url,
            width: better.w,
            height: better.h,
            ruleId: better.ruleId || 'builtin'
          });
        })();
        return true;
      }

      case MSG.PING:
        sendResponse({ ok: true, top: isTopFrame, url: location.href });
        return true;

      case MSG.SETTINGS_CHANGED:
        // 由后台在设置保存后转发过来（后台收到 options 的广播 → 再发给所有标签页）。
        // 设置变化会影响探测参数（probeTimeout / probeConcurrency）与还原规则，
        // 所以顺手把尺寸缓存清掉，避免继续用旧参数探出来的结果。
        IH.Store.loadSettings(true);
        try { IH.Scanner.clearSizeCache(); } catch (e) { /* scanner 未加载时忽略 */ }
        sendResponse({ ok: true });
        return true;

      default:
        return undefined;
    }
  });

  /* ---------------------------- 启动 ---------------------------- */

  async function boot() {
    try {
      await IH.Store.loadSettings();
    } catch (e) { /* 使用默认设置 */ }

    /* 被排除的站点**不必**挂悬停监听：少一层常驻的事件监听，
       也少一个「明明排除了却还看得见按钮」的可能。
       hover 内部在显示路径上还有一道同款检查（用户改设置后立即生效），
       这里是启动期的省事版本。 */
    const startHover = () => {
      try {
        IH.Hover.start();
      } catch (e) {
        console.warn('[ImageHunter] 悬停图标初始化失败', e);
      }
    };

    if (!isBlocked()) startHover();

    IH.Store.onChange((payload) => {
      if (!payload || payload.type !== 'settings') return;
      /* 这里只管**启动**那一半：解除排除后补上监听。
         另一半（被排除时收起已经浮出来的按钮）归 hover.js —— 它才是 UI 的主人，
         而且它自己的 onChange 只在 start() 之后才注册，正好和这里互补：
           · 启动时就被排除 → 这里不 start，于是根本不会有 UI，不需要收
           · 启动时没排除、后来被排除 → hover 已 start，它的 onChange 负责收 */
      if (!isBlocked()) startHover();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
