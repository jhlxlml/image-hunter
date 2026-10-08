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
  let tabId = null;
  let bound = false;
  let panelToken = null;

  async function getTabId() {
    if (tabId != null) return tabId;
    const res = await U.sendToBg({ type: MSG.GET_TAB_ID });
    if (res && res.ok && res.tabId != null) tabId = res.tabId;
    return tabId;
  }

  /**
   * 领一个只属于本标签页的 token，写进 iframe 的 URL。
   * 面板启动时会拿它回后台核验 —— 这样「网页自己伪造一个 iframe 套壳图库」
   * 就过不了校验（网页拿不到 token，见 AUDIT P3-7）。
   */
  async function getPanelToken() {
    if (panelToken) return panelToken;
    try {
      const res = await U.sendToBg({ type: MSG.PANEL_TOKEN });
      if (res && res.ok && res.token) panelToken = res.token;
    } catch (e) { /* 拿不到就不带 token，面板会拒绝启动 */ }
    return panelToken;
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
        // 面板重新加载完成
        frame.contentWindow.postMessage({ __ih: true, type: 'init', tabId }, '*');
      }
    });
  }

  async function show() {
    const id = await getTabId();
    build();
    listen();

    if (!frame.getAttribute('src')) {
      const token = await getPanelToken();
      const url = U.extUrl('popup/popup.html') +
        '?mode=panel' +
        (id != null ? '&tabId=' + encodeURIComponent(id) : '') +
        (token ? '&token=' + encodeURIComponent(token) : '');
      frame.setAttribute('src', url);
    } else {
      try { frame.contentWindow.postMessage({ __ih: true, type: 'refresh' }, '*'); } catch (e) { /* ignore */ }
    }

    host.classList.add('ih-open');
    host.style.pointerEvents = 'auto';
    isOpen = true;
  }

  function hide() {
    if (!host) return;
    host.classList.remove('ih-open');
    host.style.pointerEvents = 'none';
    isOpen = false;
  }

  function toggle() {
    if (isOpen) { hide(); return Promise.resolve(false); }
    return show().then(() => true);
  }

  IH.Panel = { show, hide, toggle, isOpen: () => isOpen };
})();
