/* ==========================================================================
 * ImageHunter — content/panel.js
 * 页内右侧滑出式图库面板（内嵌 popup.html?mode=panel，复用完整图库能力）
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.Panel) return;

  const C = IH.C;
  const U = IH.U;
  const MSG = C.MSG;

  let host = null;
  let root = null;
  let frame = null;
  let isOpen = false;
  let bound = false;
  let panelToken = null;
  let watcher = null;
  let watchTimer = null;

  function stopWatch() {
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
    if (watcher) { try { watcher.disconnect(); } catch (e) { /* ignore */ } watcher = null; }
  }

  function startWatch() {
    stopWatch();
    const s = IH.Store && IH.Store.getSettings ? IH.Store.getSettings() : {};
    if (!s.autoWatch || typeof MutationObserver !== 'function') return;
    const target = document.body || document.documentElement;
    if (!target) return;

    const scheduleRefresh = () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        const cur = IH.Store && IH.Store.getSettings ? IH.Store.getSettings() : {};
        if (!isOpen || !cur.autoWatch || !frame || !frame.contentWindow) return;
        getPanelToken().then((tok) => {
          try {
            frame.contentWindow.postMessage({ __ih: true, type: 'refresh', token: tok }, extOrigin());
          } catch (e) { /* ignore */ }
        });
      }, 1200);
    };

    watcher = new MutationObserver((records) => {
      for (const r of records) {
        if (host && (r.target === host || host.contains(r.target))) continue;
        if (r.type === 'attributes' || (r.addedNodes && r.addedNodes.length)) {
          scheduleRefresh();
          break;
        }
      }
    });
    try {
      watcher.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'style']
      });
    } catch (e) { stopWatch(); }
  }

  /**
   * 领一个只属于本标签页的 token。
   *
   * **不再写进 iframe 的 URL**：那个 src 就在页面 DOM 里，
   * 网页脚本 `host.shadowRoot.querySelector('iframe').src` 就读得到 ——
   * 读到之后它能自己拼一个带合法 token 的 iframe，校验等于白做。
   * 现在改成面板加载完、发回 `ready` 之后，用 postMessage 点对点交给它：
   * 发给 `frame.contentWindow` 的消息只有那个 window 收得到，网页脚本听不见。
   */
  async function getPanelToken() {
    if (panelToken) return panelToken;
    try {
      const res = await U.sendToBg({ type: MSG.PANEL_TOKEN });
      if (res && res.ok && res.token) panelToken = res.token;
    } catch (e) { /* 拿不到就不交接，面板会拒绝启动 */ }
    return panelToken;
  }

  /** 扩展页的 origin（postMessage 的 targetOrigin —— 不给网页任何投递机会） */
  function extOrigin() {
    try {
      const u = new URL(U.extUrl('popup/popup.html'));
      return u.origin;
    } catch (e) { return '*'; }
  }

  /** 把 token 交接给面板（点对点，网页脚本收不到） */
  function handOff() {
    if (!frame || !frame.contentWindow) return;
    const msg = { __ih: true, type: 'init' };
    if (panelToken) msg.token = panelToken;
    try { frame.contentWindow.postMessage(msg, extOrigin()); } catch (e) { /* ignore */ }
  }

  function build() {
    if (host) return;
    const created = U.createShadowHost('');
    created.host.className = 'ih-panel-host';

    const grip = document.createElement('div');
    grip.className = 'ih-panel-grip';

    const iframe = document.createElement('iframe');
    iframe.className = 'ih-panel-frame';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('title', IH.I18n.t('pg.galleryPanel'));

    created.root.appendChild(grip);
    created.root.appendChild(iframe);
    (document.documentElement || document.body).appendChild(created.host);

    host = created.host;
    root = created.root;
    frame = iframe;
    host.style.pointerEvents = 'none';   // 关闭时不拦截页面点击
  }

  function listen() {
    if (bound) return;
    bound = true;
    window.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || typeof data !== 'object' || !data.__ih) return;
      if (e.source !== (frame && frame.contentWindow)) return;

      if (data.type === 'close') hide();
      else if (data.type === 'ready') {
        // 面板加载完成 → 把 token 点对点交给它（第一次就顺带取 token）
        getPanelToken().then(handOff, handOff);
      }
    });
  }

  async function show() {
    build();
    listen();

    if (!frame.getAttribute('src')) {
      /* src 里**只有 mode**：token 走 postMessage 交接，tabId 由面板自己
         向后台问（后台用 sender.tab.id 回答，比 URL 参数可信）。
         这个 src 会被网页脚本读到，所以它上面不许有任何凭据。 */
      frame.setAttribute('src', U.extUrl('popup/popup.html') + '?mode=panel');
      // token 提前取好，`ready` 一到就能立刻交接
      getPanelToken();
    } else if (isOpen) {
      // 已经开着再点一次：让面板重扫。带上 token —— 面板只认带对的 token 的指令
      getPanelToken().then((tok) => {
        try {
          frame.contentWindow.postMessage({ __ih: true, type: 'refresh', token: tok }, extOrigin());
        } catch (e) { /* ignore */ }
      });
    }

    host.classList.add('ih-open');
    host.style.pointerEvents = 'auto';
    isOpen = true;
    startWatch();
  }

  function hide() {
    if (!host) return;
    stopWatch();
    host.classList.remove('ih-open');
    host.style.pointerEvents = 'none';
    isOpen = false;
  }

  function toggle() {
    if (isOpen) { hide(); return Promise.resolve(false); }
    return show().then(() => true);
  }

  IH.Panel = {
    show, hide, toggle, isOpen: () => isOpen,
    /* 供 content/main.js 的 syncTheme 用（理由同 hover.js 的同名方法）。
       注意面板的 host 里装的是一个 iframe（图库页 ?mode=panel），
       iframe 里那份 popup.js 自己会读设置并应用主题 —— 所以严格说
       这个 host 上的变量主要影响面板自己的边框/圆角等外壳。 */
    host: () => host
  };
})();
