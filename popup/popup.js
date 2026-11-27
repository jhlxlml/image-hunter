/* ==========================================================================
 * ImageHunter — popup/popup.js
 * 图库主界面：统计 / 多维筛选 / 网格多选 / 批量保存 / 进度 / 导出
 * 同一份代码服务两种宿主（class 由 popup/mode.js 在首帧之前定好）：
 *   ?mode=page  独立标签页（点击扩展图标打开，空间最大）—— 默认
 *   ?mode=panel 页内面板（iframe 内嵌）
 *
 * 历史上还有第三种「扩展弹窗」，但 manifest 里没有 default_popup，
 * 不存在不带 ?mode= 的入口 —— 那条路径从来没被走到过，已删干净。
 * ========================================================================== */
(function () {
  'use strict';

  const IH = globalThis.IH;
  const C = IH.C;
  const U = IH.U;
  const Store = IH.Store;
  const MSG = C.MSG;
  const I18n = IH.I18n;
  const Theme = IH.Theme;
  const t = (k, a) => I18n.t(k, a);

  const params = new URLSearchParams(location.search);
  const rawMode = params.get('mode');
  // 只有 page / panel 两种宿主，兜底取 page（与 popup/mode.js 保持一致）。
  // 原来这里兜底成 'popup' —— manifest 没有 default_popup，那个值取不到。
  const MODE = rawMode === 'panel' ? 'panel' : 'page';
  /* 面板模式的 tabId **不从 URL 读**（URL 是请求方自己填的，网页可以随便写）；
     它由后台按 `sender.tab.id` 回答，见 init。独立页的 tabId 是后台建页时写进去的，
     网页没法把顶层导航到 chrome-extension:// ，所以那个值可信。 */
  let tabId = (MODE === 'page' && params.get('tabId'))
    ? parseInt(params.get('tabId'), 10)
    : null;
  /* 扫描目标控制器（实现在 popup/targets.js） */
  let tgt = null;
  function getTgt() {
    if (!tgt) {
      tgt = IH.PopupTargets.create({
        $, MODE, state, t,
        getTabId: () => tabId,
        setTabId: (id) => { tabId = id; },
        doScan,
        focusImage
      });
    }
    return tgt;
  }
  function activeTargetIds() { return getTgt().activeTargetIds(); }
  function applyTargetMode() { return getTgt().applyTargetMode(); }
  function loadTabList() { return getTgt().loadTabList(); }
  function renderTargets() { return getTgt().renderTargets(); }
  function onTargetChange(e) { return getTgt().onTargetChange(e); }
  function switchTarget(nextId, focusUrl) { return getTgt().switchTarget(nextId, focusUrl); }
  function bindTargetPicker() { return getTgt().bindTargetPicker(); }
  function onSettingsChanged() { return getTgt().onSettingsChanged(); }
  function mergeTabResults(ids, results) { return getTgt().mergeTabResults(ids, results); }
  /* 面板模式的通行证。**不再从 URL 读**（那个 src 在页面 DOM 里，网页脚本读得到）——
     改由内容脚本在 `ready` 之后用 postMessage 点对点交接过来，见 onParentMessage。

     为什么是「候选队列」而不是「一个变量」：网页脚本也能往这个 iframe 投消息，
     它完全可以在内容脚本之前塞一个假 token 进来。如果代码认「第一个到达的」，
     网页就能把面板卡死在「校验失败」上（拒绝服务）。
     所以这里收下所有候选，逐个拿去后台校验，**第一个通过的就是真的** ——
     假 token 后台不认识，自然落选。 */
  let panelToken = '';
  let panelTokenLocked = false;   // 校验通过后锁定：之后谁再投 init 都不改它
  const pendingTokens = [];
  let tokenWaiters = [];

  function pushPanelToken(tok) {
    if (panelTokenLocked) return;
    if (typeof tok !== 'string' || !tok) return;
    if (pendingTokens.indexOf(tok) >= 0) return;
    pendingTokens.push(tok);
    const w = tokenWaiters;
    tokenWaiters = [];
    for (const f of w) f();
  }

  function waitPanelToken(ms) {
    return new Promise((resolve) => {
      if (pendingTokens.length) { resolve(); return; }
      let done = false;
      const fire = () => { if (done) return; done = true; resolve(); };
      tokenWaiters.push(fire);
      setTimeout(fire, ms);
    });
  }
  /* 「在图库中打开」带过来的那张图。新开标签页时走 URL 参数，
     复用已有标签页时走 GALLERY_TARGET 消息（见 init 里的监听）。 */
  let pendingFocus = params.get('focus') || '';

  const $ = (id) => document.getElementById(id);
  const CHUNK = 120;
  const SIZE_PRESETS = [
    { label: '', value: 0, i18n: 'cmn.all' },
    { label: '≥ 800px', value: 800 },
    { label: '≥ 1200px', value: 1200 },
    { label: '≥ 1920px', value: 1920 },
    { label: '≥ 2560px', value: 2560 }
  ];

  /* 尺寸滑条（连续、比档位细）。默认 256 —— 与「最小显示尺寸」
     「大图预览最小尺寸」的默认值一致，三处尺子同一个感觉。
     取值范围 0-4096，0 = 不过滤。 */
  const SIZE_MIN_DEFAULT = 256;
  const SIZE_MIN_MAX = 4096;
  const SIZE_MIN_STEP = 16;

  /* 滑条值存在 chrome.storage.local（不是 settings）：
     它是**图库这一屏的视图状态**，和排序方式、搜索词同类，
     不该进设置页、也不该被「导入配置」搬走。
     单独一个键，弹窗 / 独立页 / 面板三个宿主共享同一份。 */
  const GALLERY_VIEW_KEY = 'ih_gallery_view';

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  const state = {
    all: [],
    filtered: [],
    selected: new Set(),
    sizes: {},
    probeFailed: new Set(),     // 探测过但拿不到体积的 url（不再算「待探测」，避免堵住队列）
    downloaded: new Set(),
    scanned: false,
    lastClickIndex: -1,
    progress: null,
    // 嗅探截断信息：found = 去重后的真实总数，truncated = 是否被上限截断
    // （页面图片过多时后台只回传前 SCAN_LIMIT 张，这里要把差额告诉用户）
    found: 0,
    truncated: false,
    // 背景图扫描撞上元素数上限的 frame 数 / 最大元素数（见 AUDIT P2-3）
    bgTruncatedFrames: 0,
    bgTruncatedElements: 0,
    // 原图还原撞上时间预算：靠后的图片仍是页面上的版本（见 v1.5.1）
    restoreTruncated: false,
    // 深度嗅探撞上滚动上限（见 v1.6.0）
    deepTruncated: false,
    // 正在深度嗅探（自动滚动整页）。用来把滚动进度只显示给发起扫描的那个图库页
    deepScanning: false,
    // 本轮扫描的 reqId 与「还在等原图还原」标记（先出图、后升级）。
    // reqId 用来挡掉上一轮迟到的 SCAN_UPGRADE 广播。
    scanReqId: null,
    upgradePending: false,
    // 这一轮结果是从缓存复用的：0 = 真的重新扫过；否则是那一次的落盘时间戳。
    // 「不用等」和「这是新扫的」不能混为一谈 —— 界面要如实标出来。
    cachedAt: 0,
    // 多标签页合并嗅探：这一轮一共扫了几个页面（1 = 普通单页扫描）。
    // 卡片上的「来源页」角标、底栏截断说明、顶栏标题都看它决定要不要提「多页」。
    targetCount: 1,
    // 合并模式下每个页面各自的扫描情况 [{ id, pageUrl, host, title, count, ok, blocked }]
    pages: []
  };

  const filters = {
    sizePreset: 0,
    /* 尺寸滑条的当前值（较短边 ≥ 它）。**与 sizePreset 互斥**：
       档位选了非「全部」就听档位，否则听滑条。两个都当成「最小尺寸」的
       独立约束去叠加的话，用户点「≥ 800px」再拖到 256 会得到 800 ——
       界面上没有任何一处告诉他为什么滤不掉那些小图。 */
    sizeMin: SIZE_MIN_DEFAULT,
    aspect: 'all',
    type: 'all',
    source: 'all',
    /* 排序拆成「维度 + 方向」两件事（界面上也是一个下拉 + 一个按钮）。
       原来把「分辨率 大→小 / 分辨率 小→大」当成两个并列选项 ——
       五个选项里有两对是同一维度的正反，选完还得回下拉里找另一头；
       而且每加一个维度就要多两个选项。 */
    sortKey: 'area',
    sortDir: 'desc',
    search: '',
    onlyRestored: false,
    hideDownloaded: false,
    maxOnly: false,
    onlySelected: false
  };

  /** 合法的排序维度 / 方向。改这里就要同步改设置页那个 select 的 option 值。 */
  const SORT_DIMS = ['area', 'size', 'order', 'host'];
  const SORT_DIRS = ['desc', 'asc'];

  /**
   * 把设置里存的 `'<维度>:<方向>'`（如 `'area:desc'`）解析成 { key, dir }。
   * 任何不认识的值都退回默认 —— 设置可能是老版本写的、或者用户手改过 JSON，
   * 不能让它把一个非法值透传进 sort() 的比较函数（那样排序结果会是乱的，
   * 而且不报错）。
   */
  function parseSort(spec) {
    const parts = String(spec == null ? '' : spec).split(':');
    return {
      key: SORT_DIMS.indexOf(parts[0]) >= 0 ? parts[0] : 'area',
      dir: SORT_DIRS.indexOf(parts[1]) >= 0 ? parts[1] : 'desc'
    };
  }

  /* 「上次看着是什么样」的界面状态（与 filters 分开：那些是**约束**，
     这些纯粹是**布局偏好**，不该混进 activeFilterCount 或落进导出）。
     目前两项：滑条值、筛选条展开态。见 saveViewState / loadViewState。 */
  const viewState = { filtersOpen: false };

  /* 当前界面的语言。用来发现「设置页把语言改了」——
     图库自己没有语言切换控件，但设置页改完这一屏要立刻跟着变，
     否则用户切了英文、回到图库看到的是半中半英。 */
  let currentLang = 'zh';

  let renderedCount = 0;
  let fillToken = 0;          // 每次重建自增，用来作废上一轮还没跑完的「分片补全」
  let fillHandle = null;      // rAF / timeout 句柄
  let exportFormat = 'json';

  /* 网格的「roving tabindex」：整个网格只占**一个** Tab 停靠点，
     进去之后靠方向键在卡片间移动（见 onGridKeydown）。
     不这么做的话，2000 张图就是 2000 个 Tab 停靠点 ——
     键盘用户要按两千次 Tab 才能从第一张走到最后一张，
     比「完全不支持键盘」还难受。
     `rovingIndex` 指向当前那个 `tabindex="0"` 的卡片；点击卡片也会把它挪过去，
     于是「鼠标点过哪儿、Tab 回来就还在哪儿」。 */
  let rovingIndex = 0;
  let srTimer = null;         // 读屏器播报的防抖句柄
  let lastAnnouncedSelected = 0;   // 上一次播报过的勾选数（避免重复念同一句）

  /* ------------------------------------------------------------------ *
   * 动作控制器（实现在 popup/actions.js）
   * ------------------------------------------------------------------ */
  let actions = null;
  function getActions() {
    if (!actions) {
      actions = IH.PopupActions.create({
        $, state, t, toast, announce, applyFilters, fileNameOf
      });
    }
    return actions;
  }
  function probeSizes() { return getActions().probeSizes(); }
  function saveSelected() { return getActions().saveSelected(); }
  function saveSelectedZip() { return getActions().saveSelectedZip(); }
  function renderProgress() { return getActions().renderProgress(); }
  function exportList() { return getActions().exportList(exportFormat); }

  /* ------------------------------------------------------------------ *
   * 框选控制器（实现在 popup/marquee.js）
   * ------------------------------------------------------------------ */
  let mq = null;
  function paintSelection(set, geom) { if (mq) mq.paintSelection(set, geom); }
  function invalidateMarqueeGeom() { if (mq) mq.invalidateGeom(); }

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    /* 视觉上的提示（toast）对读屏器是「一闪而过」的 —— 它没有 aria-live，
       而且 2.6 秒就消失了，读屏器根本来不及念。
       所以同一条文案也送一份给 #srStatus。 */
    announce(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  function areaOf(c) { return (c.width || 0) * (c.height || 0); }

  function formatDimShort(c) {
    if (c.width && c.height) return c.width + '×' + c.height;
    return t('pop.dimUnknown');
  }

  function fileNameOf(url) {
    if (!url) return '';
    if (U.isDataUrl(url)) return t('pop.inlineImage');
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      return last || U.prettyHost(url);
    } catch (e) { return url.slice(0, 80); }
  }

  /** 用于「每张仅留最大」的同一性签名 */
  function signatureOf(c) {
    if (U.isDataUrl(c.url)) return 'data:' + U.quickHash(c.url);
    try {
      const url = new URL(c.url);
      let p = url.pathname.toLowerCase();
      p = p.replace(/-\d{2,4}x\d{2,4}(?=\.)/, '');
      p = p.replace(/_\d{2,4}x\d{2,4}[a-z0-9]*(?=\.)/, '');
      p = p.replace(/_(?:thumb|small|mini|medium|preview)(?=\.)/, '');
      return url.hostname + p;
    } catch (e) {
      return c.url;
    }
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  /**
   * 启动前的授权校验。
   *
   * 两种宿主，两条路径，**都要过**：
   *
   * 面板（?mode=panel）—— 它被嵌在**别人的网页**里，而 popup/* 必须在
   *   web_accessible_resources 里，所以任何网站都能构造同款 iframe 套壳。
   *   凭据是内容脚本交接过来的 token：网页脚本拿不到它（它发不出 runtime 消息），
   *   所以伪造的 iframe 一定没有 token → 拒绝启动。
   *   注意**不校验 e.origin、也不信 URL 里的 tabId**：前者是请求方自己报的，
   *   后者是请求方自己填的。真正的身份由后台用 `sender.tab.id` 判定。
   *
   * 独立页（?mode=page）—— 以前这里直接 `return true`，理由是「网页碰不到」。
   *   那个理由不成立：网页可以 `<iframe src="...popup.html?mode=page">`。
   *   所以现在两道：① 自己检查有没有被嵌（window.top !== window.self）；
   *   ② 再问后台「我是不是扩展页 + 顶层 frame」（sender 侧判定，伪造不了）。
   */
  async function verifyPanelOrigin() {
    if (MODE === 'panel') {
      /* 等「第一个能通过后台校验的 token」。网页脚本抢先塞进来的假 token
         会在这里被逐个试掉（后台不认识它），随后真正的那个再通过。

         为什么是**分段重试**而不是「一次等够久」：
         内容脚本要先把 token 拿到手（它得先问一次后台），面板这边只是等。
         单次超时只能靠「猜一个够长的数」——猜短了在慢机器上误杀，
         猜长了在正常机器上白白卡住。分段重试把「等多久」换成「试几次」：
         每轮等 3 秒，等不到就再喊一次 ready 让内容脚本重新交接，最多 3 轮。
         正常路径第一轮就过（实测 <50ms），慢机器上也有第二次、第三次机会。 */
      const ROUNDS = 3;
      const ROUND_MS = 3000;
      for (let round = 0; round < ROUNDS; round++) {
        if (round > 0) {
          // 重新喊一次 ready：内容脚本收到就再交接一遍 token
          try { window.parent.postMessage({ __ih: true, type: 'ready' }, '*'); } catch (e) { /* ignore */ }
        }
        const deadline = Date.now() + ROUND_MS;
        while (Date.now() < deadline) {
          if (!pendingTokens.length) {
            await waitPanelToken(Math.max(50, deadline - Date.now()));
          }
          while (pendingTokens.length) {
            const tok = pendingTokens.shift();
            let ok = false;
            try {
              const res = await U.sendToBg({
                type: MSG.PANEL_VERIFY,
                payload: { token: tok }
              });
              ok = !!(res && res.ok && res.valid);
            } catch (e) { ok = false; }
            if (ok) {
              panelToken = tok;
              panelTokenLocked = true;
              return true;
            }
          }
        }
      }
      return false;
    }

    // mode === 'page'
    let embedded = false;
    try { embedded = window.top !== window.self; } catch (e) { embedded = true; }
    if (embedded) return false;
    try {
      const res = await U.sendToBg({ type: MSG.GALLERY_AUTH });
      return !!(res && res.ok && res.valid);
    } catch (e) {
      return false;
    }
  }

  /** 校验没过时把界面锁掉，不给任何可点的操作 */
  function refuseUntrustedEmbed() {
    const main = document.querySelector('.app') || document.body;
    try { main.textContent = ''; } catch (e) { /* ignore */ }
    const box = document.createElement('div');
    box.style.cssText = 'padding:24px;font:13px/1.7 system-ui,sans-serif;color:#666';
    box.textContent = t('pop.untrusted');
    main.appendChild(box);
  }

  async function init() {
    // 正常路径下 popup/mode.js 已经在首帧之前设好了（见那个文件的头注释）。
    // 这里再设一次只是兜底：万一 mode.js 没加载成功，至少不会停在无 class 的状态。
    document.body.className = 'mode-' + MODE;

    /* 面板模式：**先挂监听，再喊 ready**。
       反过来的话，宿主收到 ready 立刻回 init，而那时监听还没注册 ——
       token 就永远收不到了（表现是面板卡在空白，很难查）。 */
    if (MODE === 'panel') {
      window.addEventListener('message', onParentMessage);
      try { window.parent.postMessage({ __ih: true, type: 'ready' }, '*'); } catch (e) { /* ignore */ }
    }

    if (!await verifyPanelOrigin()) {
      refuseUntrustedEmbed();
      return;
    }

    if (MODE === 'panel') {
      /* 扫描目标由后台按 `sender.tab.id` 回答 —— 这个值浏览器填的，不可伪造。
         URL 里的 tabId 一概不读：那是请求方自己填的，网页可以随便写。 */
      const res = await U.sendToBg({ type: MSG.GET_TAB_ID });
      if (res && res.ok && res.tabId != null) tabId = res.tabId;
      if (tabId == null) { refuseUntrustedEmbed(); return; }
    }

    await Store.loadSettings();
    applyTheme();
    /* 「跟随系统」要在图库页**当场**生效，而不是等用户切一次页。
       此前这条监听只有设置页有（options.js 那份 applyTheme 里挂的），
       于是系统在用户盯着图库时切成深色，图库纹丝不动 —— 直到切页才补上。
       收进 Theme.watch 之后两处都有，且只在 theme === 'auto' 时才重算。 */
    Theme.watch(document, () => Store.getSettings());
    /* 与设置页同一个顺序：先把 HTML 里的静态文案填一遍，再去拼动态内容。
       反过来的话筛选 chips、卡片角标会先用旧语言拼一遍再被覆盖。 */
    I18n.apply(document);
    document.title = t('pop.titleGallery');
    currentLang = I18n.lang();

    // 「先出图、后升级」的第二步：扫描的最终结果（原图还原之后）由后台广播过来。
    // page / panel 两种宿主都要收 —— 面板模式同样会经历「先铺图、后换原图」。
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== MSG.SCAN_UPGRADE) return undefined;
      applyScanUpgrade(msg.payload);
      return undefined;
    });

    if (MODE === 'page') {
      // 后台据此记住本标签页，避免图标被反复点击时开出一堆图库页
      U.sendToBg({ type: MSG.GALLERY_HELLO });
      // 后台可能在复用本页时通知「切换扫描目标」，顺带带上「要定位到哪张图」
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== MSG.GALLERY_TARGET) return undefined;
        const p = msg.payload || {};
        if (p.tabId != null || p.focusUrl) switchTarget(p.tabId, p.focusUrl);
        return undefined;
      });
      Store.onChange((p) => {
        if (!p || p.type !== 'settings') return;
        onSettingsChanged();
      });
    }

    // 主题与语言：不管哪种宿主都要跟着变（设置页改了，图库也得改）
    Store.onChange((p) => {
      if (!p || p.type !== 'settings') return;
      applyTheme();
      applyLangChange();
    });

    /* 合并嗅探只在独立页里提供 —— 页内面板天生是「贴着当前这一页」的窄条，
       让它去合并别的标签页既装不下那个多选面板，也违背面板的定位。 */
    getTgt().setMerge(MODE === 'page' && !!Store.getSettings().mergeTabs);
    applyTargetMode();

    // 滑条值要在 buildSizePresets（它会 syncSizeSlider）**之前**读回来，
    // 否则首屏渲染的是默认 256，读完再跳一下 —— 用户能看到数字在抖。
    await loadViewState();

    buildStaticChips();
    buildDynamicChips();
    buildSizePresets();
    // 排序控件按设置里的「默认排序」初始化（必须在 bindEvents 之前，
    // 免得用户还没操作就被当成「改过了」）
    applyDefaultSort();
    bindSizeSlider();
    bindEvents();

    /* 筛选条**两种宿主都默认收起**。
       默认展开时它是一整行五个标签云，占掉将近 1/3 的纵向空间 ——
       而绝大多数打开图库的人只是想看图、勾图、下载。
       收起后，「有没有在筛」由按钮上的数量徽标（#filterCount）和常亮态表达，
       信息不会丢；想筛的人点一下就在原位展开，也不比原来多一步。
       用户在本次会话里手动展开过就记住（见 loadViewState / setPanel 的调用方）。 */
    setPanel(!!viewState.filtersOpen);

    await resolveTab();
    // 先填充标签页下拉（可能顺带修正 tabId），再嗅探
    if (MODE === 'page') await loadTabList();
    await loadDownloadedFlags();
    await doScan();
    // 「在图库中打开」带过来的那张图：等图铺出来之后再去定位
    if (pendingFocus) {
      const want = pendingFocus;
      pendingFocus = '';
      await focusImage(want);
    }
    await refreshProgress();
  }

  /* ------------------------------------------------------------------ *
   * 扫描目标标签页（独立页面模式）
   *
   * 两个控件说同一件事，由设置 `mergeTabs` 决定用哪个：
   *   - 关闭（默认）：`#selTargetTab` 原生单选下拉，一次扫一页
   *   - 打开：`#targetMulti` 勾选列表，可以一次勾多个页面合并扫
   * 两者互斥显示，避免「到底听谁的」这种歧义。
   * ------------------------------------------------------------------ */

  /* (扫描目标选择器 / 多标签页合并 已拆分至 popup/targets.js) */

  /* ------------------------------------------------------------------ *
   * 定位到某一张图（「在图库中打开」的落点）
   * ------------------------------------------------------------------ */

  /**
   * 等某张卡片真的进了 DOM。
   * 网格是**分片补全**的（首屏 120 张，其余每帧补一批），目标很可能还没轮到，
   * 直接 querySelector 会查不到 —— 那不是「没有这张图」，只是还没渲染。
   */
  function waitForCard(id, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const cards = document.querySelectorAll('#grid .card');
        for (let i = 0; i < cards.length; i++) {
          if (cards[i].dataset.id === id) { resolve(cards[i]); return; }
        }
        if (Date.now() - t0 > (timeout || 3000)) { resolve(null); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /**
   * 定位到某一张图。
   *
   * 三种结果都要如实说 —— 「在图库中打开」没兑现时不能假装成功：
   *   1. 在当前筛选结果里 → 滚到可见 + 高亮一下
   *   2. 被筛选条件挡住了 → 复位筛选再找，并说明「已为你重置筛选」
   *   3. 压根不在这轮结果里（超出前 SCAN_LIMIT 张 / 页面已经变了）→ 明说找不到
   *
   * 另外按 `restoredFrom` 也认一次：灯箱里那张可能是还原后的原图地址，
   * 而卡片上挂的地址取决于「先出图、后升级」跑到哪一步了。
   */
  async function focusImage(url) {
    if (!url) return;
    const key = U.normalizeUrl(url);
    const hit = (c) => U.normalizeUrl(c.url) === key
      || (c.restoredFrom && U.normalizeUrl(c.restoredFrom) === key);

    let card = state.filtered.find(hit);
    let reset = false;

    if (!card && state.all.some(hit)) {
      // 被当前筛选条件挡在外面了。直接复位 —— 用户是奔着这张图来的，
      // 让他自己去猜是哪个条件把它筛掉的不合理。
      resetFilters();
      reset = true;
      card = state.filtered.find(hit);
    }

    if (!card) {
      toast(t('pop.focusMissing', { n: C.SCAN_LIMIT }), 'err');
      return;
    }

    const el = await waitForCard(card.id, 3000);
    if (!el) {
      // 卡片在列表里、却没等到它渲染出来：那是分片补全还没轮到，不是找不到。
      toast(t('pop.focusFar'));
      return;
    }

    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    el.classList.add('ih-focus');
    setTimeout(() => el.classList.remove('ih-focus'), 2400);

    /* 定位过去的这张也顺手变成 Tab 停靠点：用户从别处跳过来，
       接着按方向键就应该从这张继续走，而不是从列表第一张重新开始。 */
    const landed = state.filtered.findIndex((c) => c.id === card.id);
    if (landed >= 0) setRoving(landed);

    toast(reset ? t('pop.focusReset') : t('pop.focusOk'), 'ok');
  }

  async function refreshProgress() {
    const res = await U.sendToBg({ type: MSG.GET_STATS });
    if (res && res.ok && res.progress && res.progress.status !== 'idle') {
      state.progress = res.progress;
      renderProgress();
    }
  }

  /**
   * 主题。实现在 shared/theme.js —— 原来这里有一份自己的 applyTheme，
   * 与 options.js 那份逻辑重复；而且两份还漂移了（设置页挂了系统深浅色监听，
   * 这里没挂，「跟随系统」在图库页只有切页时才对齐一次）。
   * 现在只有一种算法，那边改这边自动跟随。
   */
  function applyTheme() {
    return Theme.apply(document, Store.getSettings());
  }

  /**
   * 语言被改了之后重画这一屏。
   *
   * 静态文案走 I18n.apply（data-i18n）；但筛选 chips、卡片角标、底栏统计、
   * 目标页摘要全是 JS 拼出来的，apply 管不到 —— 只能整块重建。
   * 少了这一步就是「切了英文、界面还是半中半英」。
   */
  function applyLangChange() {
    const next = I18n.lang();
    if (next === currentLang) return;
    currentLang = next;
    I18n.apply(document);
    document.title = t('pop.titleGallery');
    buildStaticChips();
    buildDynamicChips();
    buildSizePresets();
    renderTargets();
    // 排序方向按钮的文案是**按当前方向**拼的，I18n.apply 管不到，得单独重写
    updateSortDirUI();
    // 卡片上的角标、aria-label、底栏统计都嵌着文案 —— 重跑一遍才会换语言
    if (state.all.length) applyFilters();
    else updateStats();
    renderProgress();
  }

  /**
   * 父窗口发来的消息。
   *
   * 严格到什么程度：**只认 `window.parent`、只认带对 token 的指令**。
   *
   * 旧实现有两个洞：
   *   ① 没校验 `e.source` —— 任何拿到这个 window 引用的脚本都能投递；
   *   ② `init` 里允许改 `tabId` —— 网页脚本一句
   *      `iframe.contentWindow.postMessage({__ih:true,type:'init',tabId:9999},'*')`
   *      就能把面板的扫描目标换成任意标签页（面板有跨标签页嗅探能力）。
   * 现在 tabId 一律由后台按 `sender.tab.id` 回答，消息里根本不存在这个字段；
   * 其余指令（refresh）必须回带内容脚本交接的那个 token —— 网页不知道它。
   */
  function onParentMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__ih) return;
    if (MODE !== 'panel') return;
    if (e.source !== window.parent) return;

    if (d.type === 'init') {
      // 已认证之后不再接受任何新 token —— 否则网页脚本投一个自己的 init，
      // 就能把「后续指令必须带对 token」这条判断架空了。
      pushPanelToken(d.token);
      return;
    }

    // 后续指令：必须带着同一个 token，否则就是网页脚本在瞎喊
    if (!panelToken || d.token !== panelToken) return;
    if (d.type === 'refresh') doScan();
  }

  async function resolveTab() {
    if (tabId != null) return tabId;

    if (MODE === 'page') {
      // 独立标签页里 tabs.query({active,currentWindow}) 拿到的是图库页自己，
      // 所以扫描目标必须问后台（它记得最近活跃的普通网页标签页）
      const res = await U.sendToBg({ type: MSG.GET_TARGET_TAB });
      if (res && res.ok && res.tabId != null) {
        tabId = res.tabId;
        return tabId;
      }
      return null;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab) {
        tabId = tab.id;
        return tabId;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 筛选条件 —— 所有维度统一成 chips，点一下即生效
   * ------------------------------------------------------------------ */

  /* label 留空、真正的值走 `i18n` 键 —— 语言切换后 buildStaticChips 会重建，
     那时才取词。写死在这里的话切了语言这几个 chip 不会变。 */
  const ASPECTS = [
    { value: 'all', i18n: 'pop.aspAll' },
    { value: 'landscape', i18n: 'pop.aspLandscape' },
    { value: 'portrait', i18n: 'pop.aspPortrait' },
    { value: 'square', i18n: 'pop.aspSquare' },
    { value: 'wide', i18n: 'pop.aspWide' },
    { value: 'tall', i18n: 'pop.aspTall' }
  ];

  /** 三个开关型条件，顺序即界面顺序 */
  const SWITCHES = [
    { key: 'onlyRestored', i18n: 'pop.swRestored' },
    { key: 'hideDownloaded', i18n: 'pop.swHideDownloaded' },
    { key: 'maxOnly', i18n: 'pop.swMaxOnly' },
    { key: 'onlySelected', i18n: 'pop.swSelected' }
  ];

  /** 渲染一组单选 chips。current 决定高亮项，onPick 里再决定是否重排列表 */
  function renderChips(box, items, current, onPick) {
    if (!box) return;
    box.textContent = '';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (String(it.value) === String(current) ? ' active' : '');
      b.dataset.value = String(it.value);
      b.textContent = it.i18n ? t(it.i18n) : it.label;
      b.addEventListener('click', () => {
        onPick(String(it.value));
        // 只刷新本组高亮，不必整块重建
        Array.prototype.forEach.call(box.children, (c) => c.classList.toggle('active', c === b));
      });
      box.appendChild(b);
    });
  }

  /** 渲染开关型 chips（可多选，互不影响） */
  function renderSwitches(box) {
    if (!box) return;
    box.textContent = '';
    SWITCHES.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (filters[s.key] ? ' active' : '');
      b.dataset.flag = s.key;
      b.textContent = t(s.i18n);
      b.addEventListener('click', async () => {
        filters[s.key] = !filters[s.key];
        b.classList.toggle('active', filters[s.key]);
        // 「隐藏已下载」需要指纹数据，第一次打开时才去取
        if (s.key === 'hideDownloaded' && filters.hideDownloaded && !state.downloaded.size) {
          await loadDownloadedFlags(true);
        }
        applyFilters();
      });
      box.appendChild(b);
    });
  }

  /** 与扫描结果无关的条件（比例 / 开关） */
  function buildStaticChips() {
    renderChips($('aspectChips'), ASPECTS, filters.aspect, (v) => {
      filters.aspect = v;
      applyFilters();
    });
    renderSwitches($('flagChips'));
  }

  /** 格式 / 来源只列出这一页真实出现过的值，避免一长串空选项 */
  function buildDynamicChips() {
    const types = [];
    const seenT = new Set();
    const sources = [];
    const seenS = new Set();
    const sourceCounts = {};

    state.all.forEach((c) => {
      const ty = c.type || U.extFromUrl(c.url);
      if (ty && !seenT.has(ty)) { seenT.add(ty); types.push(ty); }
      (c.allSources || [c.source]).forEach((s) => {
        if (!s) return;
        sourceCounts[s] = (sourceCounts[s] || 0) + 1;
        if (!seenS.has(s)) { seenS.add(s); sources.push(s); }
      });
    });

    types.sort();
    // 来源按**当前语言**的标签排 —— 按中文排的话切到英文后顺序会看着乱
    sources.sort((a, b) => String(I18n.sourceLabel(a))
      .localeCompare(String(I18n.sourceLabel(b))));

    // 之前选中的值在这次扫描里没有了，退回「全部」
    if (filters.type !== 'all' && !seenT.has(filters.type)) filters.type = 'all';
    if (filters.source !== 'all' && !seenS.has(filters.source)) filters.source = 'all';

    renderChips($('typeChips'),
      [{ value: 'all', i18n: 'cmn.all' }].concat(types.map((x) => ({ value: x, label: x.toUpperCase() }))),
      filters.type,
      (v) => { filters.type = v; applyFilters(); });

    renderChips($('sourceChips'),
      [{ value: 'all', i18n: 'cmn.all' }].concat(
        sources.map((s) => ({ value: s, label: I18n.sourceLabel(s) + ' (' + sourceCounts[s] + ')' }))),
      filters.source,
      (v) => { filters.source = v; applyFilters(); });
  }

  function buildSizePresets() {
    renderChips($('sizePresets'),
      SIZE_PRESETS.map((p) => ({ value: p.value, i18n: p.i18n, label: p.label })),
      filters.sizePreset,
      (v) => {
        filters.sizePreset = Number(v);
        /* 必须在这里同步滑条的降权态：renderChips 的 onPick 只负责改状态 + 回调，
           高亮由它自己刷，但滑条是**另一个**控件、不在它的刷新范围内。
           漏掉这一步的后果是「点了 ≥800px，滑条看起来还在生效」——
           用户会以为两个条件叠加了，而实际上滑条已经被忽略。 */
        syncSizeSlider();
        applyFilters();
      });
    updateChipCounts();
    syncSizeSlider();
  }

  /** 滑条的显示值 + 「被档位接管」的视觉降权 */
  function syncSizeSlider() {
    const el = $('sizeMin');
    const out = $('sizeMinOut');
    const row = $('sizeSliderRow');
    if (!el) return;
    el.value = String(filters.sizeMin);
    if (out) out.textContent = filters.sizeMin > 0 ? '≥ ' + filters.sizeMin + 'px' : t('cmn.noFilter');
    // 档位生效时滑条被忽略 —— 视觉上要说出来，否则用户拖了没反应会以为坏了
    if (row) row.classList.toggle('overridden', filters.sizePreset > 0);
    if (out) out.title = filters.sizePreset > 0 ? t('pop.sliderOverridden', { n: filters.sizePreset }) : '';
  }

  /** 滑条：input 时只更新数字（跟手），change 时才算 + 落盘 */
  function bindSizeSlider() {
    const el = $('sizeMin');
    if (!el) return;

    el.addEventListener('input', () => {
      filters.sizeMin = Number(el.value) || 0;
      const out = $('sizeMinOut');
      if (out) out.textContent = filters.sizeMin > 0 ? '≥ ' + filters.sizeMin + 'px' : t('cmn.noFilter');
    });

    el.addEventListener('change', () => {
      filters.sizeMin = Number(el.value) || 0;
      /* 拖滑条 = 明确表达「我要用连续这一把」，
         所以顺手把档位复位回「全部」，避免出现「拖了却没变化」。 */
      if (filters.sizePreset > 0) {
        filters.sizePreset = 0;
        buildSizePresets();      // 档位 chips 高亮要跟着回到「全部」
      } else {
        syncSizeSlider();
      }
      saveViewState();
      applyFilters();
    });
  }

  /* 视图状态（滑条值 · 筛选条展开态）落盘。失败不提示 ——
     存不下顶多下次回到默认，不该为这种事打断用户。 */
  function saveViewState() {
    try {
      const p = chrome.storage.local.set({
        [GALLERY_VIEW_KEY]: { sizeMin: filters.sizeMin, filtersOpen: !$('filterPanel').hidden }
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  async function loadViewState() {
    try {
      const got = await chrome.storage.local.get(GALLERY_VIEW_KEY);
      const v = got && got[GALLERY_VIEW_KEY];
      if (v && typeof v.sizeMin === 'number' && v.sizeMin >= 0 && v.sizeMin <= SIZE_MIN_MAX) {
        filters.sizeMin = Math.round(v.sizeMin);
      }
      /* 只有显式存过 true 才算「展开过」—— 缺字段（老数据）或存了 false
         一律落到默认收起，不必区分「没存过」和「存了 false」。 */
      if (v && v.filtersOpen === true) viewState.filtersOpen = true;
    } catch (e) { /* 读不到就用默认值 */ }
  }

  /** 生效的筛选条件个数，显示在「筛选」按钮的角标上 */
  function activeFilterCount() {
    let n = 0;
    /* 尺寸这一格算一项，不重复计数：档位和滑条互斥，
       同时算两次会让角标出现「明明只动了一处却是 2」的困惑。
       **滑条停在默认 256 时不算「在筛」** —— 它本来就在那儿，
       不是用户的动作。原来筛条常驻，角标常显 1 只是噪音；
       现在筛条默认收起，一个恒亮的「1」会让用户以为自己在筛、
       又找不到筛的是什么（打开筛条，五个维度看着全是默认）。
       判据与 resetFilters 一致：只有**离开** SIZE_MIN_DEFAULT 才算数。 */
    if (filters.sizePreset || filters.sizeMin !== SIZE_MIN_DEFAULT) n++;
    if (filters.aspect !== 'all') n++;
    if (filters.type !== 'all') n++;
    if (filters.source !== 'all') n++;
    if (filters.search) n++;
    SWITCHES.forEach((s) => { if (filters[s.key]) n++; });
    return n;
  }

  function updateFilterCount() {
    const n = activeFilterCount();
    const badge = $('filterCount');
    const btn = $('btnFilters');
    if (badge) { badge.textContent = String(n); badge.hidden = n === 0; }
    if (btn) btn.classList.toggle('on', n > 0);
    updateSearchState();
  }

  /** 搜索有内容时，图标按钮常亮（提示「现在结果是被搜过的」） */
  function updateSearchState() {
    const btn = $('btnSearch');
    if (btn) btn.classList.toggle('on', !!filters.search);
  }

  function resetFilters() {
    filters.sizePreset = 0;
    /* 滑条「重置」也要回到它自己的默认值 256，而不是 0。
       回到 0 的话，用户点一次重置会**比打开时看到更多图** ——
       这和他心里「恢复默认」的预期不符（默认本来就是 256）。 */
    filters.sizeMin = SIZE_MIN_DEFAULT;
    filters.aspect = 'all';
    filters.type = 'all';
    filters.source = 'all';
    filters.search = '';
    SWITCHES.forEach((s) => { filters[s.key] = false; });
    if ($('search')) $('search').value = '';
    /* 排序也一并回到**设置里的默认排序**（不是硬编码的「分辨率 大到小」）——
       「重置」的语义是「恢复默认」，而默认值现在是可配置的。 */
    applyDefaultSort();
    buildStaticChips();
    buildDynamicChips();
    buildSizePresets();
    applyFilters();
  }

  /* ------------------------------------------------------------------ *
   * 浮层：筛选条 / 搜索框
   * ------------------------------------------------------------------ */

  /** 筛选条直接平铺在控制区里，这个开关只负责「收起 / 展开」 */
  function setPanel(open) {
    const panel = $('filterPanel');
    const btn = $('btnFilters');
    if (!panel) return;
    panel.hidden = !open;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  }

  /** 搜索：图标按钮原位展开成输入框 */
  function setSearch(open) {
    const pop = $('searchPop');
    const btn = $('btnSearch');
    if (!pop) return;
    pop.hidden = !open;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      const input = $('search');
      if (input) { input.focus(); input.select(); }
    }
  }

  /** 收起搜索框；有内容则保留（图标按钮会常亮） */
  function closeSearch() {
    setSearch(false);
    updateSearchState();
  }

  function clearSearch() {
    const input = $('search');
    if (input) input.value = '';
    filters.search = '';
    setSearch(false);
    applyFilters();
    updateSearchState();
  }

  /* ------------------------------------------------------------------ *
   * 排序
   * ------------------------------------------------------------------ */

  /**
   * 把当前排序方向同步到那个按钮上：图标旋转 + 文案。
   *
   * 文案（title / aria-label）**不挂 data-i18n** —— 它跟着方向变，
   * 挂上去会在切语言时被覆盖成一个固定方向的说法（I18n.apply 是整段覆写）。
   * 所以由这里在「初始化」和「切语言」两个时刻各写一次
   * （见 init 里的调用与 applyLangChange）。
   */
  function updateSortDirUI() {
    const btn = $('btnSortDir');
    if (!btn) return;
    const asc = filters.sortDir === 'asc';
    btn.classList.toggle('asc', asc);
    const label = t(asc ? 'pop.sortDirAscTitle' : 'pop.sortDirDescTitle');
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
    // 给测试和调试一个稳定的读点，不必去猜 svg 转了多少度
    btn.dataset.dir = filters.sortDir;
  }

  /**
   * 用设置里的「默认排序」初始化排序控件。
   *
   * 图库**每次打开**都回到这个默认值 —— 用户在界面上临时改的排序不落盘，
   * 和筛选条件一致（只有滑条值与筛选条展开态两个纯布局偏好会记住）。
   * 这样设置页那一项的效果就是可预期的：改了什么，下次打开就是什么。
   */
  function applyDefaultSort() {
    const s = parseSort(Store.getSettings().defaultSort);
    filters.sortKey = s.key;
    filters.sortDir = s.dir;
    const sel = $('selSort');
    if (sel) sel.value = filters.sortKey;
    updateSortDirUI();
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  function bindEvents() {
    const targetSel = $('selTargetTab');
    if (targetSel) targetSel.addEventListener('change', onTargetChange);
    bindTargetPicker();

    // 网格的键盘导航（roving tabindex + 方向键），见 onGridKeydown
    $('grid').addEventListener('keydown', onGridKeydown);

    /* 排序拆成两个控件：下拉选**维度**、按钮切**方向**。
       两个都只改 filters 再 applyFilters，没有别的副作用 ——
       排序不参与「生效筛选条件」的计数（角标数的是筛选，不是排序）。 */
    $('selSort').addEventListener('change', (e) => {
      filters.sortKey = e.target.value;
      applyFilters();
    });

    $('btnSortDir').addEventListener('click', () => {
      filters.sortDir = filters.sortDir === 'asc' ? 'desc' : 'asc';
      updateSortDirUI();
      applyFilters();
      // 方向只体现在图标旋转上，太轻；补一句播报给读屏器（也是可见 toast）
      toast(t(filters.sortDir === 'asc' ? 'pop.sortAsc' : 'pop.sortDesc'));
    });

    const search = $('search');
    search.addEventListener('input', U.debounce(() => {
      filters.search = search.value.trim().toLowerCase();
      // 搜索是逐字触发的，取消勾选的提示会一直闪，这里静默处理
      applyFilters({ quiet: true });
    }, 200));

    // 搜索框：回车收起（保留结果）、Esc 清空并收起
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closeSearch(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearSearch(); }
    });

    $('btnSearch').addEventListener('click', (e) => {
      e.stopPropagation();
      setSearch($('searchPop').hidden);
    });

    $('btnSearchClear').addEventListener('click', (e) => {
      e.stopPropagation();
      clearSearch();
    });

    // 筛选条：直接平铺，按钮只负责收起 / 展开
    $('btnFilters').addEventListener('click', (e) => {
      e.stopPropagation();
      setPanel($('filterPanel').hidden);
      // 展开 / 收起是布局偏好，记下来（下次打开还是这个样子）
      saveViewState();
    });

    $('btnResetFilters').addEventListener('click', () => {
      resetFilters();
      toast(t('pop.filtersReset'));
    });

    // 点搜索框以外的地方 → 收起搜索框（筛选条常驻，不参与自动收起）
    document.addEventListener('pointerdown', (e) => {
      if ($('searchPop').hidden) return;
      if (e.target.closest && e.target.closest('.search-wrap')) return;
      closeSearch();
    });

    // 勾选只在「当前筛选结果」里进行 —— 所以「全选」就是「勾上筛选出的全部」
    $('btnSelectAll').addEventListener('click', () => {
      const before = state.selected.size;
      state.filtered.forEach((c) => state.selected.add(c.id));
      updateStats();
      paintSelection(state.selected);
      const added = state.selected.size - before;
      if (added) toast(t('pop.selectedN', { n: added }));
      else toast(t('pop.allSelected'));
    });

    $('btnInvert').addEventListener('click', () => {
      // 反选同样只在筛选结果内翻转，否则会立刻产生「看不见的勾选」
      state.filtered.forEach((c) => {
        if (state.selected.has(c.id)) state.selected.delete(c.id);
        else state.selected.add(c.id);
      });
      updateStats();
      paintSelection(state.selected);
    });

    $('btnClear').addEventListener('click', () => {
      state.selected.clear();
      updateStats();
      paintSelection(state.selected);
    });

    $('btnSave').addEventListener('click', saveSelected);
    if ($('btnSaveZip')) $('btnSaveZip').addEventListener('click', saveSelectedZip);
    $('btnCancel').addEventListener('click', async () => {
      const act = getActions();
      if (act && act.isZipPacking && act.isZipPacking()) {
        act.cancelZip();
        toast(t('pop.zipCancelling'));
        return;
      }
      const res = await U.sendToBg({ type: MSG.CANCEL_BATCH });
      const dropped = (res && res.dropped) || 0;
      const active = (res && res.active) || 0;
      // 已经在飞的下载没法中断，会照常落盘 —— 文案必须说清楚，
      // 否则用户点完「停止」又看到几个文件冒出来，会以为按钮坏了（AUDIT P2-5）
      if (active > 0) {
        toast(t('pop.cancelPartial', { dropped, active }), 'ok');
      } else {
        toast(dropped ? t('pop.cancelQueued', { n: dropped }) : t('pop.cancelStopped'));
      }
    });

    // 顶栏三个动作：探测体积 / 导出清单 / 深度嗅探。
    // 它们都是**偶尔**用一次的动作，但常驻才有「一眼看到、一点就到」，
    // 收进「更多」菜单反而要多点一下、还看不出谁在忙（探测的转圈图标
    // 只在常驻时才有意义）。宽度问题由顶栏自己的响应式规则解决。
    $('btnProbe').addEventListener('click', probeSizes);
    $('btnExport').addEventListener('click', exportList);
    $('btnDeep').addEventListener('click', () => doScan(true, true));

    // 重新嗅探一律**绕过缓存** —— 用户点它就是因为觉得结果旧了，
    // 再从缓存里捞一份几分钟前的回来，等于按钮点了没反应。
    $('btnRescan').addEventListener('click', () => doScan(true, false, true));

    // 底栏那个「复用 N 分钟前的嗅探结果」标记，点一下也是重新嗅探
    const cnote = $('cacheNote');
    if (cnote) cnote.addEventListener('click', () => doScan(true, false, true));

    $('btnOptions').addEventListener('click', () => {
      // openOptionsPage 返回 Promise，try/catch 抓不到异步拒绝，需要单独 catch
      try {
        const p = chrome.runtime.openOptionsPage();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* ignore */ }
    });

    $('btnPanel').addEventListener('click', async () => {
      const r = await U.sendToBg({ type: MSG.OPEN_PANEL, tabId });
      if (r && r.blocked) toast(t('pop.blockedNoPanel'), 'err');
      else if (!r || !r.ok) toast(t('pop.panelFail'), 'err');
      // 原来这里还有一句 `if (MODE === 'popup') window.close();`：
      // 弹窗模式打开面板后要把自己关掉。弹窗入口已不存在（manifest 无 default_popup），
      // 那是一条永远走不到的分支，已删。
    });

    $('btnClose').addEventListener('click', () => {
      try { window.parent.postMessage({ __ih: true, type: 'close' }, '*'); } catch (e) { /* ignore */ }
    });

    // 网格事件委托
    $('grid').addEventListener('click', onGridClick);
    $('grid').addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.pick, .zoom, .restore')) return;
      const card = e.target.closest ? e.target.closest('.card') : null;
      if (!card) return;
      const idx = state.filtered.findIndex((c) => c.id === card.dataset.id);
      if (idx >= 0) openLightbox(idx);
    });

    // 框选：在网格空白或卡片上按下并拖动即可画框
    mq = IH.PopupMarquee.create({
      $, state, t, toast, updateStats, syncSelectionUI,
      scheduleFill, cancelFill,
      hasMoreToRender: () => renderedCount < state.filtered.length
    });
    $('gridWrap').addEventListener('pointerdown', mq.onPointerDown);
    // 拖拽期间若窗口失焦（切标签页、点开开发者工具），按当前选区直接落定
    window.addEventListener('blur', () => { if (mq.isArmed()) mq.onPointerUp(); });

    // 窗口尺寸变化会改列宽 → 每张卡片的位置都变，几何快照必须作废。
    // 拖拽中改尺寸是极端情况，但快照错了会框错图，宁可重算一次。
    window.addEventListener('resize', invalidateMarqueeGeom);

    // 进度推送
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return undefined;

      if (msg.type === MSG.PROGRESS) {
        state.progress = msg.payload;
        renderProgress();
      }

      // 深度嗅探的滚动进度：只有「发起这次扫描的那个标签页」才该响应，
      // 否则同时开着两个图库时会互相串台
      if (msg.type === MSG.DEEP_PROGRESS && state.deepScanning) {
        const p = msg.payload || {};
        if (p.tabId == null || p.tabId === tabId) {
          setLoadingText(
            t('pop.deepProgress', { n: p.total }),
            t('pop.deepProgressHint', { round: p.round + 1, added: p.added })
          );
        }
      }
      return undefined;
    });

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // 正在框选时，Esc 先用来放弃框选
        if (mq && mq.isDragging()) { mq.cancel(); return; }
        // 其次收起搜索框（搜索框自己处理了 Esc，这里兜底）
        if (!$('searchPop').hidden) { clearSearch(); return; }
        if (MODE === 'panel') {
          try { window.parent.postMessage({ __ih: true, type: 'close' }, '*'); } catch (err) { /* ignore */ }
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        const tag = (e.target && e.target.tagName) || '';
        if (/^(INPUT|TEXTAREA)$/.test(tag)) return;
        e.preventDefault();
        state.filtered.forEach((c) => state.selected.add(c.id));
        updateStats();
        paintSelection(state.selected);
      }
    });
  }

  function onGridClick(e) {
    const card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    const id = card.dataset.id;
    const idx = state.filtered.findIndex((c) => c.id === id);
    if (idx < 0) return;

    /* 鼠标点过哪一张，就把「可 Tab 到的那一张」挪到哪一张 ——
       于是「点了几下 → 按 Tab 回来 → 焦点还在刚才那张」。
       focus: false，因为焦点交给浏览器按点击自己决定（点卡片不等于要移动焦点）。 */
    setRoving(idx);

    const zoomBtn = e.target.closest('.zoom');
    if (zoomBtn) {
      e.stopPropagation();
      openLightbox(idx);
      return;
    }

    // 「还原」按钮：单独重试这一张，不要顺手把它勾上 / 取消
    const restoreBtn = e.target.closest('.restore');
    if (restoreBtn) {
      e.stopPropagation();
      runOneRestore(card, state.filtered[idx], restoreBtn);
      return;
    }

    const pickBtn = e.target.closest('.pick');
    if (pickBtn) e.stopPropagation();

    // Shift 连选
    if (e.shiftKey && state.lastClickIndex >= 0) {
      const from = Math.min(state.lastClickIndex, idx);
      const to = Math.max(state.lastClickIndex, idx);
      for (let i = from; i <= to; i++) state.selected.add(state.filtered[i].id);
    } else {
      toggleSelect(id);
    }
    state.lastClickIndex = idx;
    updateStats();
    // 只刷新 DOM 选中态：整格重建会把滚动位置弹回顶部
    paintSelection(state.selected);
  }

  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  }

  /* ------------------------------------------------------------------ *
   * 扫描
   * ------------------------------------------------------------------ */

  /** 加载态的两行文案：普通嗅探与深度嗅探要说清楚正在发生什么 */
  function setLoadingText(text, hint) {
    const elText = $('loadingText');
    const elHint = $('loadingHint');
    if (elText) elText.textContent = text;
    if (elHint) elHint.textContent = hint;
  }

  /* 取词不能在模块顶层做 —— 那时 Store 还没加载，语言还判定不出来。 */
  function loadingIdle() {
    return { text: t('pop.loading'), hint: t('pop.loadingHint') };
  }

  /**
   * @param {boolean} [notify] 完成后弹一句提示（重新嗅探用）
   * @param {boolean} [deep]   深度嗅探：先自动滚动整页再采集，
   *        用于「要滚到底才加载下一批」的无限滚动站点
   * @param {boolean} [force]  绕过后台的扫描结果缓存。
   *        「重新嗅探」按钮必须传 true —— 用户点它就是因为觉得结果旧了，
   *        再从缓存里捞一份几分钟前的回来，等于按钮点了没反应。
   */
  async function doScan(notify, deep, force) {
    state.deepScanning = !!deep;
    $('loading').hidden = false;
    const idle = loadingIdle();
    setLoadingText(
      deep ? t('pop.deepLoading') : idle.text,
      deep ? t('pop.deepLoadingHint') : idle.hint
    );
    $('empty').hidden = true;
    cancelFill();                 // 别让上一轮还没补完的卡片插进清空后的网格
    $('grid').textContent = '';
    renderedCount = 0;
    state.selected.clear();
    state.sizes = {};
    state.probeFailed.clear();
    state.found = 0;
    state.truncated = false;
    state.bgTruncatedFrames = 0;
    state.bgTruncatedElements = 0;
    state.restoreTruncated = false;
    state.deepTruncated = false;
    state.cachedAt = 0;
    syncSelectionUI();

    if (!getTgt().isMerge() && tabId == null) await resolveTab();
    const ids = activeTargetIds();
    if (!ids.length) {
      state.deepScanning = false;
      $('loading').hidden = true;
      showEmpty(MODE === 'page'
        ? (getTgt().isMerge() ? t('pop.noTargetMerge') : t('pop.noTargetSingle'))
        : t('pop.noTargetPanel'));
      return;
    }

    /* 勾了多个页面 → 走合并路径（见 doMergedScan） */
    if (ids.length > 1) {
      await doMergedScan(ids, { notify, deep, force });
      return;
    }

    tabId = ids[0];
    const res = await U.sendToBg({
      type: MSG.SCAN_TAB,
      tabId,
      deep: !!deep,
      force: !!force
    });

    state.deepScanning = false;
    setLoadingText(idle.text, idle.hint);
    $('loading').hidden = true;
    state.scanned = true;

    if (!res || !res.ok) {
      // 「站点已排除」不是错误，是用户自己的设置 —— 说清楚，并告诉他去哪儿改。
      // 用一句笼统的「嗅探失败：blocked」等于把责任推给用户猜。
      if (res && res.blocked) {
        state.pageUrl = res.pageUrl || state.pageUrl;
        state.targetCount = 1;
        state.pages = [];
        if (res.pageUrl) {
          $('pageHost').textContent = U.prettyHost(res.pageUrl) || t('pop.currentPage');
          $('pageHost').title = res.title || res.pageUrl;
        }
        showEmpty(t('pop.blockedEmpty'), t('pop.blockedEmptyHint'));
        return;
      }
      showEmpty(t('pop.scanFail', { msg: (res && res.error) || t('cmn.unknownError') }));
      return;
    }

    /* 「先出图、后升级」：后台收到内容脚本的第一版中间结果（partial）就立刻兑现，
       不等原图还原跑完 —— 冷还原最长 8 秒，那 8 秒原来是用户盯着 spinner 白等的。
       现在先把页面上的版本铺出来，还原完成后后台广播 SCAN_UPGRADE，再原地换 URL。

       reqId 用来把迟到的广播挡掉：用户可能已经切了目标页 / 又点了一次重新嗅探，
       上一轮的升级结果不该盖到新结果上。 */
    state.scanReqId = res.reqId || null;
    state.upgradePending = res.phase === C.SCAN_PHASE.PARTIAL;
    // 结果来自后台的扫描缓存（5 分钟内、同一个标签页同一个地址）。
    // 记下落盘时间，界面据此如实说明「这是几分钟前的」，而不是假装刚扫过。
    state.cachedAt = res.cached ? (res.cachedAt || Date.now()) : 0;
    state.targetCount = 1;
    state.pages = [];

    if (!adoptScanResult(res, { partial: state.upgradePending })) return;

    if (notify) {
      toast(state.truncated
        ? t('pop.rescanTrunc', { found: state.found, shown: state.all.length })
        : t('pop.rescanDone', { n: state.all.length }));
    }
  }

  /**
   * 把一份扫描结果装进 state 并渲染。单页扫描与合并扫描**共用这一处** ——
   * 两条路各写一份「设 state.all / found / truncated …」迟早会分叉，
   * 而那正是「界面显示的和实际的不一致」这类 bug 的温床。
   *
   * @returns {boolean} 是否真的有图可显示（false 时调用方通常还要再补一句空态说明）
   */
  function adoptScanResult(res, opts) {
    opts = opts || {};
    state.all = res.images || [];
    state.pageUrl = res.pageUrl || '';
    state.title = res.title || '';
    // 后台在超过 SCAN_LIMIT 时只回传前 N 张，同时带上真实总数与截断标记。
    // 老版本后台没有这两个字段，用 state.all.length / false 兜底。
    state.found = typeof res.found === 'number' ? res.found : state.all.length;
    state.truncated = !!res.truncated;
    state.bgTruncatedFrames = res.bgTruncatedFrames || 0;
    state.bgTruncatedElements = res.bgTruncatedElements || 0;
    state.restoreTruncated = !!res.restoreTruncated;
    state.deepTruncated = !!res.deepTruncated;
    state.targetCount = res.targetCount || 1;
    state.pages = res.pages || [];
    state.upgradePending = !!opts.partial;
    updateTargetHeader();

    if (!state.all.length) {
      // 中间结果里一张都没有、但还原还在跑 —— 这时候说「本页没有发现图片」是错的
      showEmpty(state.upgradePending
        ? t('pop.restoring')
        : (state.targetCount > 1 ? t('pop.emptyMulti') : t('pop.empty')));
      return false;
    }

    // 打开后默认不勾选任何图片：让用户用单击 / Shift 连选 / Ctrl+A / 拖拽框选自行决定
    state.lastClickIndex = -1;

    // 格式 / 来源 chips 按这一轮实际出现的值重建
    buildDynamicChips();
    applyFilters();

    /* 读屏器播报「扫完了、有多少张」。只在**最终结果**上播 ——
       「先出图、后升级」会先来一份 partial，那时候报一次、升级完再报一次，
       用户会以为扫了两遍。 */
    if (!opts.partial) {
      announce(state.targetCount > 1
        ? t('pop.announceMerged', { pages: state.targetCount, n: state.all.length })
        : t('pop.announceScan', { n: state.all.length }));
    }
    return true;
  }

  /** 顶栏「站点」那一位：单页显示域名；合并时显示「N 个页面」，悬停列出是哪几个 */
  function updateTargetHeader() {
    const el = $('pageHost');
    if (!el) return;
    if (state.targetCount > 1) {
      el.textContent = t('pop.pageCount', { n: state.targetCount });
      el.title = state.pages
        .map((p) => (p.title || p.pageUrl || '') + (p.ok ? '' : t('pop.notScanned')))
        .filter(Boolean).join('\n') || t('pop.mergedScan');
    } else {
      el.textContent = U.prettyHost(state.pageUrl) || t('pop.currentPage');
      el.title = state.title || state.pageUrl;
    }
  }

  /* (mergeTabResults 已拆分至 popup/targets.js) */

  /**
   * 多标签页合并嗅探。
   *
   * 与单页扫描两处**刻意**的不同：
   *
   * 1. **每页都带 `finalOnly`** —— 不要「先出图、后升级」的中间结果。
   *    多页并发时，partial → SCAN_UPGRADE 那套「按 tabId 原地换 URL」的配对会纠缠：
   *    升级广播带的是一整页的列表，而合并后的 state.all 是另一份东西，
   *    单靠 tabId 已经判断不出该不该采纳。与其把升级逻辑改成能处理 N 份来源，
   *    不如让每页各自等到最终结果 —— 反正是并发跑的，总等待约等于最慢的那一页。
   * 2. **每到一个就并进去、重渲染** —— 快的页面先出图，不干等最慢的。
   *
   * 注意：合并结果**不进**后台的扫描缓存（缓存是 per-tab 的），
   * 但每个单页扫描自己会命中各自的缓存，所以重复合并依然很快。
   */
  async function doMergedScan(ids, opts) {
    const results = new Array(ids.length).fill(null);
    let done = 0;
    const paint = () => {
      setLoadingText(
        t('pop.mergedProgress', { n: ids.length, done }),
        t('pop.mergedProgressHint')
      );
    };
    paint();

    await Promise.all(ids.map(async (id, idx) => {
      let r = null;
      try {
        r = await U.sendToBg({
          type: MSG.SCAN_TAB,
          tabId: id,
          deep: !!opts.deep,
          force: !!opts.force,
          finalOnly: true
        });
      } catch (e) { r = { ok: false, error: String(e) }; }
      results[idx] = r;
      done++;
      paint();
      // 已经到手的先铺出来 —— 快的页面不用等最慢的那个
      const partial = mergeTabResults(ids, results);
      if (partial.images.length) adoptScanResult(partial, { partial: done < ids.length });
    }));

    state.deepScanning = false;
    const idle2 = loadingIdle();
    setLoadingText(idle2.text, idle2.hint);
    $('loading').hidden = true;
    state.scanned = true;
    // 合并路径没有 partial → upgrade 的配对，别留下一个会被迟到的广播命中的 reqId
    state.scanReqId = null;
    state.upgradePending = false;

    const merged = mergeTabResults(ids, results);
    // 有任何一个页面命中了缓存，就说清「结果里有旧的」
    state.cachedAt = results.some((r) => r && r.cached) ? Date.now() : 0;

    if (!merged.ok) {
      if (merged.blocked) {
        showEmpty(t('pop.blockedEmptyMulti'), t('pop.blockedEmptyHintMulti'));
      } else {
        showEmpty(t('pop.scanFail', { msg: merged.error || t('cmn.unknownError') }));
      }
      return;
    }

    adoptScanResult(merged);
    if (opts.notify && merged.images.length) {
      toast(t('pop.rescanMerged', { pages: ids.length, n: merged.images.length }));
    }
  }

  let ftrHintTimer = null;

  /** 临时占用底栏那句提示，过一会儿自动还回去（面板模式里它是隐藏的，无副作用） */
  function setFooterHint(text, restoreMs) {
    const el = $('ftrHint');
    if (!el) return;
    clearTimeout(ftrHintTimer);
    el.textContent = text;
    // 还回时按**当前语言**取 —— 期间切过语言的话，不该还回一句旧语言的默认提示
    ftrHintTimer = setTimeout(() => { el.textContent = t('pop.ftrHint'); }, restoreMs || 5000);
  }

  /**
   * 「先出图、后升级」的第二步。
   *
   * 后台把内容脚本的第一版中间结果（partial）先兑现给图库 —— 用户马上看到图，
   * 不用再盯着 spinner 等还原跑完。等还原结束，后台广播最终结果，这里负责把
   * 卡片**原地**换成还原后的地址：不重扫、不清空、不打断用户正在做的事。
   *
   * 难点全在 id 上。id = quickHash(normalizeUrl(url))，而还原**会改 url**，
   * 所以同一张图在升级前后是两个不同的 id。勾选集合是按 id 存的，直接整体
   * 换掉列表会让用户刚勾的全掉。办法是拿每张图自带的 `restoredFrom`
   * （还原前的地址）反算出旧 id，建一张 旧→新 的映射，把 state.selected
   * 和 state.sizes 一起搬过去。
   */
  function applyScanUpgrade(payload) {
    if (!payload || !Array.isArray(payload.images) || !payload.images.length) return;
    // 迟到的广播：用户可能已经切了目标标签页，或者又点了一次重新嗅探
    if (state.scanReqId && payload.reqId && payload.reqId !== state.scanReqId) return;
    if (tabId != null && payload.tabId != null && payload.tabId !== tabId) return;
    /* 合并嗅探走的是 finalOnly，本来就不会有升级广播；
       真收到一条（上一轮单页扫描的迟到广播）也不能采纳 ——
       它带的是一整页的列表，会把合并结果整个盖掉。 */
    if (state.targetCount > 1) return;
    if (!state.scanned) return;

    const prev = state.all;
    const prevIds = new Set(prev.map((c) => c.id));
    const next = payload.images;

    // 旧 id → 新 id
    const idMap = new Map();
    for (const img of next) {
      if (!img || !img.id || !img.restoredFrom) continue;
      const oldId = U.quickHash(U.normalizeUrl(img.restoredFrom));
      if (oldId !== img.id && prevIds.has(oldId)) idMap.set(oldId, img.id);
    }

    // 勾选跟着搬
    if (idMap.size) {
      const sel = new Set();
      for (const id of state.selected) sel.add(idMap.get(id) || id);
      state.selected = sel;
    }
    // 体积缓存是按 url 存的，也要跟着搬（否则「合计体积」会凭空少一截）
    for (const [oldId, newId] of idMap) {
      const o = prev.find((c) => c.id === oldId);
      const n = next.find((c) => c.id === newId);
      if (!o || !n || o.url === n.url) continue;
      if (state.sizes[o.url] !== undefined && state.sizes[n.url] === undefined) {
        state.sizes[n.url] = state.sizes[o.url];
      }
    }

    const prevRestored = prev.filter((c) => c.restored).length;
    const nowRestored = next.filter((c) => c.restored).length;
    const selectedBefore = state.selected.size;

    state.all = next;
    state.found = typeof payload.found === 'number' ? payload.found : next.length;
    state.truncated = !!payload.truncated;
    state.bgTruncatedFrames = payload.bgTruncatedFrames || 0;
    state.bgTruncatedElements = payload.bgTruncatedElements || 0;
    state.restoreTruncated = !!payload.restoreTruncated;
    state.deepTruncated = !!payload.deepTruncated;
    state.upgradePending = false;

    buildDynamicChips();
    // quiet：勾选是**故意**迁移过去的，不是「被筛掉」，不要弹「已取消 N 张」
    // keepScale：升级只换了地址，列表规模不该跟着缩回 —— 见 renderGrid 的说明
    applyFilters({ quiet: true, keepScale: true });

    // 迁移没兜住的勾选：图片真的不在最终列表里了（例如还原后与另一张合并去重）。
    // 这种情况必须说出来 —— 用户点「保存选中」时少了几张，比弹个提示糟糕得多。
    const dropped = selectedBefore - state.selected.size;
    if (dropped > 0) {
      toast(t('pop.upgradeDropped', { n: dropped }), 'err');
    } else if (nowRestored > prevRestored) {
      setFooterHint(t('pop.upgraded', { n: nowRestored - prevRestored }));
    }
  }

  /** 空状态默认的副标题（正常「没找到图」时用）。取词要现取，别在顶层缓存 */
  function emptyHint() {
    return t('pop.emptyHint');
  }

  function showEmpty(text, hint) {
    $('emptyText').textContent = text || t('pop.empty');
    // 副标题要跟着主文案走：说「没有发现图片」时提示去刷新，
    // 说「站点被排除了」时还提示刷新就是在误导
    $('emptyHint').textContent = hint || emptyHint();
    $('empty').hidden = false;
    $('grid').textContent = '';
    updateStats();
  }

  /* ------------------------------------------------------------------ *
   * 筛选 / 排序
   * ------------------------------------------------------------------ */

  /**
   * 筛选的**纯谓词链**：给定一组候选，返回符合当前 filters 的那些。
   *
   * 从 applyFilters 里抽出来是为了让「空态判断」能复用同一套条件 ——
   * 空态要回答「摘掉尺寸这一条会不会有结果」，只能跑一遍真条件；
   * 另写一份判断迟早会和这里跑偏（而那正好会造出一条点了没用的出口）。
   * 不碰任何界面 / 状态，只读 filters 和 state.downloaded。
   */
  function applyFilterPredicates(input) {
    const q = filters.search;
    let list = input.slice();

    // 尺寸：档位优先，否则听滑条（见 filters.sizeMin 的注释）
    if (filters.sizePreset > 0) {
      list = list.filter((c) => (c.width || 0) >= filters.sizePreset);
    } else if (filters.sizeMin > 0) {
      /* 判据是**较短边**（宽高都要达标）：分隔条那种 1200×8 只有一个边长，
         只看宽度它会大摇大摆地留在结果里 —— 而那正是最该滤掉的一类。
         尺寸未知（探测超时）的**放行**：拿 0 去比会静默藏图，
         和图库其它维度（比例 / 类型）的严格判定不同，这里是刻意宽松的。 */
      const min = filters.sizeMin;
      list = list.filter((c) => {
        const w = c.width || 0;
        const h = c.height || 0;
        if (!w || !h) return true;
        return Math.min(w, h) >= min;
      });
    }

    // 比例
    if (filters.aspect !== 'all') {
      list = list.filter((c) => {
        if (!c.width || !c.height) return false;
        const r = c.width / c.height;
        switch (filters.aspect) {
          case 'landscape': return r > 1.1;
          case 'portrait': return r < 0.9;
          case 'square': return r >= 0.9 && r <= 1.1;
          case 'wide': return r >= 2.4;
          case 'tall': return r <= 1 / 2.4;
          default: return true;
        }
      });
    }

    // 类型
    if (filters.type !== 'all') {
      list = list.filter((c) => (c.type || U.extFromUrl(c.url)) === filters.type);
    }

    // 来源
    if (filters.source !== 'all') {
      list = list.filter((c) => (c.allSources || [c.source]).indexOf(filters.source) >= 0);
    }

    // 仅已还原
    if (filters.onlyRestored) list = list.filter((c) => c.restored);

    // 隐藏已下载
    if (filters.hideDownloaded && state.downloaded.size) {
      list = list.filter((c) => !state.downloaded.has(c.id));
    }

    // 仅看已选
    if (filters.onlySelected) {
      list = list.filter((c) => state.selected.has(c.id));
    }

    // 搜索
    if (q) {
      list = list.filter((c) => {
        if ((c.url && c.url.toLowerCase().indexOf(q) >= 0)
          || (c.alt && String(c.alt).toLowerCase().indexOf(q) >= 0)
          || (fileNameOf(c.url).toLowerCase().indexOf(q) >= 0)) return true;
        /* 合并嗅探时，来源页地址也参与搜索 —— 用户勾了三页之后，
           想「只看 a 站那页的」是很自然的动作，而那一页的域名
           在图片地址里往往根本不出现（图常常挂在 CDN 上）。 */
        return state.targetCount > 1 && c.pageUrl
          && String(c.pageUrl).toLowerCase().indexOf(q) >= 0;
      });
    }

    return list;
  }

  /**
   * 应用筛选条件。
   *
   * 关键语义：**筛选即缩小工作集** —— 不在新结果里的图片会被取消勾选。
   * 这样「已选 N」永远等于你眼前能看到并勾上的数量，点「保存选中」绝不会
   * 悄悄多出几张已经被筛掉、看不见的图。
   *
   * @param {{quiet?: boolean}} [opts] quiet=true 时不弹「已取消 N 张」的提示
   *        （搜索框是逐字触发的，弹提示会一直闪）
   */
  function applyFilters(opts) {
    let list = applyFilterPredicates(state.all);

    // 每张仅留最大
    if (filters.maxOnly) {
      const best = new Map();
      for (const c of list) {
        const sig = signatureOf(c);
        const prev = best.get(sig);
        if (!prev || areaOf(c) > areaOf(prev)) best.set(sig, c);
      }
      const keep = new Set(Array.from(best.values()).map((c) => c.id));
      list = list.filter((c) => keep.has(c.id));
    }

    /* 排序：先按**维度**比较出一个带符号的差值，再按**方向**整体取反。
       方向对 area / size 有直观意义（大到小 / 小到大）；对 order / host
       就是「正序 / 逆序」—— 一样说得通，所以统一支持，不为它们开特例。
       比较函数只要求符号有意义，所以直接 `flip * r` 就够了。 */
    const flip = filters.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let r;
      switch (filters.sortKey) {
        case 'size': r = (state.sizes[a.url] || 0) - (state.sizes[b.url] || 0); break;
        case 'order': r = (a.order || 0) - (b.order || 0); break;
        /* 「站点」：合并嗅探时先按**来源页**分组 —— 那才是用户勾多个页面时想看的；
           页内再按图片自己的域名。单页扫描时 pageIndex 恒为 0，
           于是退化成「按图片域名排」，也就是这个选项标签本来就该有的行为
           （此前 c.host 一直是空的，这条排序其实一直在按面积兜底，见 background.js）。
           同组同域名时再按面积打平，让结果稳定。 */
        case 'host':
          r = ((a.pageIndex || 0) - (b.pageIndex || 0))
            || String(a.host || '').localeCompare(String(b.host || ''))
            || (areaOf(a) - areaOf(b));
          break;
        default: r = areaOf(a) - areaOf(b);
      }
      return flip * r;
    });

    state.filtered = list;

    // 不在筛选结果里的图片 → 取消勾选（排序变化时集合不变，这里自然是空操作）
    pruneSelection(opts);

    updateChipCounts();
    updateFilterCount();
    /* keepScale：筛选条件本身没变、只是某几张的地址被换掉了（「先出图、后升级」）。
       这时整体重建是必须的（卡片地址变了），但不该把已经铺出来的几百张缩回首屏 ——
       用户会看到列表凭空变短，然后等它再爬一遍。 */
    renderGrid(opts && opts.keepScale ? 'keepScale' : true);
    updateStats();
  }

  /**
   * 把勾选裁剪到「当前筛选结果」范围内。
   * 返回被取消的数量；有任何取消时给一次提示，免得用户觉得勾选莫名其妙丢了。
   */
  function pruneSelection(opts) {
    if (!state.selected.size) return 0;
    const keep = new Set(state.filtered.map((c) => c.id));
    let removed = 0;
    for (const id of Array.from(state.selected)) {
      if (!keep.has(id)) { state.selected.delete(id); removed++; }
    }
    if (removed && !(opts && opts.quiet)) {
      toast(t('pop.pruned', { n: removed }));
    }
    return removed;
  }

  /* 每个尺寸档后面的数字。原先是对**每个 chip** 都跑一次 state.all.filter(...)，
     也就是 O(档位数 × 图片数)：图片上千张时每次筛选/搜索都要多跑好几千次比较，
     而这里的档位是固定且递增的。
     改成「一次排序 + 每个档位二分」：整体 O(n log n)，与档位数无关。
     语义保持完全一致 —— 仍然是「宽度 >= 档位值」的张数（档位 0 即全部，不显示）。 */
  function updateChipCounts() {
    const box = $('sizePresets');
    if (!box) return;

    const widths = state.all.map((c) => c.width || 0).sort((a, b) => a - b);

    /** 宽度 >= v 的张数（二分找第一个 >= v 的位置） */
    const countAtLeast = (v) => {
      let lo = 0, hi = widths.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (widths[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return widths.length - lo;
    };

    Array.prototype.forEach.call(box.querySelectorAll('.chip'), (b) => {
      const v = Number(b.dataset.value);
      if (!v) return;
      const n = countAtLeast(v);
      let em = b.querySelector('em');
      if (!em) { em = document.createElement('em'); b.appendChild(em); }
      em.textContent = n ? String(n) : '';
    });
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  /**
   * 结果为空时，判断「是不是仅仅被尺寸过滤挡住了」。
   *
   * 为什么值得单开一个判断：尺寸滑条**默认 256px**，而列表页缩略图大量在 200px 上下 ——
   * 打开图库撞上一片空白是很容易发生的。这时网格里什么都不画、只说一句
   * 「没有符合当前筛选条件的图片」，用户会以为嗅探坏了（他已经忘了自己没拖过滑条）。
   *
   * 判据要严：只有**除尺寸之外所有条件都放着**、且**尺寸确实是唯一挡路的那个**时才算，
   * 否则会给出一条误导性的出口 —— 点下去还是空的。
   * 返回 { count, ... } 表示命中，null 表示不是这种情况。
   */
  function sizeFilterOnlyBlocker() {
    // 别的维度只要有一个在起作用，就不能把锅推给尺寸
    if (filters.search || filters.aspect !== 'all' || filters.type !== 'all'
      || filters.source !== 'all' || filters.onlyRestored || filters.hideDownloaded
      || filters.maxOnly) return null;
    if (!(filters.sizePreset > 0) && !(filters.sizeMin > 0)) return null;

    // 把尺寸条件摘掉，看是不是就全活了
    const savedPreset = filters.sizePreset;
    const savedMin = filters.sizeMin;
    filters.sizePreset = 0;
    filters.sizeMin = 0;
    const withoutSize = applyFilterPredicates(state.all);
    filters.sizePreset = savedPreset;
    filters.sizeMin = savedMin;

    if (!withoutSize.length) return null;      // 摘掉尺寸还是空的 → 不是尺寸的锅
    return { count: withoutSize.length };
  }

  /** 空态里那个「一键关掉尺寸过滤」按钮的显示与接线 */
  function syncEmptyAction(sizeOnly) {
    const btn = $('emptyClearSize');
    if (!btn) return;
    if (!sizeOnly) { btn.hidden = true; btn.onclick = null; return; }
    btn.textContent = t('pop.showAll', { n: sizeOnly.count });
    btn.hidden = false;
    /* 出口的语义是「我现在就想看到全部」，所以**两条尺寸条件都清掉**：
       档位复位到「全部」、滑条拖到 0（而不是拖回默认的 256 —— 那样等于什么都没做，
       这正是第一版的 bug：`filters.sizeMin = sizeMinIsNonDefault() ? 256 : 0`
       在默认值下算出来还是 256，点了没反应）。 */
    btn.onclick = () => {
      filters.sizePreset = 0;
      filters.sizeMin = 0;
      syncSizeSlider();
      buildSizePresets();
      /* 必须落盘：滑条值是**视图状态**（存 ih_gallery_view），下次打开要沿用。
         不清的话，点了「显示全部」当场确实看到全部图了，但下次打开（或页内面板
         那边重新拉一次视图状态）又会把 608 这个旧值捡回来 —— 等于出口是假的。
         与滑条 change 处理器里那句 saveViewState() 保持一致。 */
      saveViewState();
      applyFilters();
    };
  }

  /* 渲染网格。
     reset 的三种取值：
       false       —— 继续往后补（分片补全的常规步进）
       true        —— 彻底重来：清空并从首屏 CHUNK 张重新开始
       'keepScale' —— 清空重建，但**保留当前已渲染的张数**。
                      给「先出图、后升级」用：升级要换掉每张卡片的地址，
                      只能整体重建；但绝不能因此把已经铺出来的几百张缩回首屏 ——
                      用户会看到列表凭空变短，然后眼睁睁等它再爬一遍。
                      1200 张的站点上，这个循环会让网格永远停在 120 张附近。 */
  function renderGrid(reset) {
    /* 必须在建卡片**之前**夹一次：buildCard 按 rovingIndex 决定谁拿 tabindex=0，
       而筛选 / 重扫之后列表可能短了一大截 —— 夹晚了就会出现
       「一张卡片都不是 Tab 停靠点」，网格从此键盘进不去。 */
    clampRoving();
    if (reset) {
      const keepScale = reset === 'keepScale';
      const keep = keepScale ? renderedCount : 0;
      cancelFill();
      $('grid').textContent = '';
      renderedCount = 0;
      if (keepScale) {
        // 直接铺到原来的规模（list 可能比原来短：还原后合并去重会少几张）
        const total = Math.min(keep, state.filtered.length);
        while (renderedCount < total) {
          const n = Math.min(CHUNK, total - renderedCount);
          const slice = state.filtered.slice(renderedCount, renderedCount + n);
          const frag = document.createDocumentFragment();
          slice.forEach((c, i) => frag.appendChild(buildCard(c, renderedCount + i)));
          $('grid').appendChild(frag);
          renderedCount += slice.length;
        }
      }
    }
    // 卡片集合变了（清空重来 / 又补了一批），框选的几何快照立刻作废 ——
    // grid 换行时新加入的卡片会让最后一行的位置整体挪动
    invalidateMarqueeGeom();

    const list = state.filtered;
    if (!list.length) {
      $('empty').hidden = false;
      /* 「一张都不剩」有三种完全不同的原因，必须分开说，不能都甩一句
         「没有符合当前筛选条件的图片」：
           1) 本页真的没图；
           2) 有图，但被**尺寸过滤**挡掉了（尺寸滑条默认 256 是最常见的元凶 ——
              商品列表、新闻站的缩略图大量在 200px 上下，开箱就撞上）；
           3) 有图、也不是尺寸挡的，但**别的筛选条件**把结果清空了。
         第 2 种最需要解释：它看起来像「嗅探坏了」，而且有一个明确的出口。 */
      const sizeOnly = sizeFilterOnlyBlocker();
      if (!state.all.length) {
        $('emptyText').textContent = t('pop.empty');
        $('emptyHint').textContent = emptyHint();
      } else if (sizeOnly) {
        $('emptyText').textContent = t('pop.emptySizeBlocked', { n: sizeOnly.count, min: filters.sizeMin });
        $('emptyHint').textContent = t('pop.emptySizeBlockedHint', { min: filters.sizeMin });
      } else {
        $('emptyText').textContent = t('pop.emptyFiltered');
        // 走的是和 showEmpty 同一个副标题来源，避免上一次的「站点被排除」提示留在这里
        $('emptyHint').textContent = emptyHint();
      }
      syncEmptyAction(sizeOnly);
      return;
    }
    $('empty').hidden = true;
    syncEmptyAction(null);

    const slice = list.slice(renderedCount, renderedCount + CHUNK);
    const frag = document.createDocumentFragment();
    slice.forEach((c, i) => frag.appendChild(buildCard(c, renderedCount + i)));
    $('grid').appendChild(frag);
    renderedCount += slice.length;

    // 还没渲染完就接着补 —— 用户不需要点任何按钮，滚到底就是全部图片
    if (renderedCount < list.length) scheduleFill();
  }

  /* 分片补全的调度：首屏先出 CHUNK 张，剩下的在每帧的空闲里继续塞。
     用 requestAnimationFrame 而不是同步循环，浏览器才有机会绘制，
     几千张图也不会把界面卡住；后台标签页不触发也没关系，
     切回前台会立刻接着补完（而且那时本来就没人看）。 */
  const rafCall = window.requestAnimationFrame
    ? (fn) => window.requestAnimationFrame(fn)
    : (fn) => setTimeout(fn, 16);
  const rafKill = window.cancelAnimationFrame
    ? (id) => window.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

  function scheduleFill() {
    if (fillHandle != null) return;
    const token = fillToken;
    fillHandle = rafCall(() => {
      fillHandle = null;
      // 期间换过筛选条件 / 重新扫描过 → 这一轮作废
      if (token !== fillToken) return;
      if (renderedCount >= state.filtered.length) return;
      renderGrid(false);
    });
  }

  function cancelFill() {
    fillToken++;                                  // 作废在途的那一轮
    if (fillHandle != null) { rafKill(fillHandle); fillHandle = null; }
  }

  /* ------------------------------------------------------------------ *
   * 键盘导航（网格的 roving tabindex）
   *
   * 为什么不是「每张卡片都 tabindex=0」：网格里可能有 2000 张卡片，
   * 每张都进 Tab 顺序等于没有键盘支持 —— 用户要按两千次 Tab 才能从第一张
   * 走到最后一张，比完全不支持还难受。所以整个网格只留**一个** Tab 停靠点，
   * 进去之后靠方向键移动。
   *
   * 键盘与鼠标操作的对应关系（#gridHelp 里也写给读屏器了）：
   *   ←/→/↑/↓、Home/End、PageUp/PageDown   移动焦点
   *   Enter / 空格                           勾选 / 取消（= 点击卡片）
   *   P                                      大图预览（= 点右上角放大镜）
   *   R                                      单独重试还原（= 点右下角「还原」）
   * ------------------------------------------------------------------ */

  /** 网格当前有几列 —— 从计算样式里数轨道，不写死（窗口宽度会变） */
  function gridColumns() {
    const grid = $('grid');
    if (!grid) return 1;
    let tpl = '';
    try { tpl = getComputedStyle(grid).gridTemplateColumns || ''; } catch (e) { /* ignore */ }
    const n = tpl.split(/\s+/).filter(Boolean).length;
    if (n > 0) return n;
    /* 计算样式拿不到（jsdom 不解析外部样式表）时退到几何：数第一行有几张。
       再拿不到就按 1 列算 —— 退化成「上下键 = 前后一张」，
       功能不完整，但绝不会卡住。 */
    const cards = grid.children;
    if (!cards.length) return 1;
    const top = cards[0].offsetTop;
    let count = 0;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].offsetTop !== top) break;
      count++;
    }
    return count > 0 ? count : 1;
  }

  /** PageUp / PageDown 一次跨几行：按网格可视高度估，至少 1 行 */
  function gridRowsPerPage() {
    const grid = $('grid');
    const card = grid && grid.children[0];
    const h = card && card.offsetHeight;
    const vh = grid && grid.clientHeight;
    if (!h || !vh) return 1;
    return Math.max(1, Math.floor(vh / h));
  }

  /** 目标下标可能还没渲染出来（分片补全每帧只补 120 张）—— 先把它补到位 */
  function ensureRenderedTo(idx) {
    let guard = 0;
    while (renderedCount <= idx && renderedCount < state.filtered.length && guard++ < 200) {
      renderGrid(false);
    }
  }

  /**
   * 把「可 Tab 到的那一张」挪到 idx。
   * @param {number} idx
   * @param {{focus?: boolean}} [opts] focus = 真的把 DOM 焦点移过去（方向键用）
   */
  function setRoving(idx, opts) {
    opts = opts || {};
    if (idx < 0 || idx >= state.filtered.length) return;
    ensureRenderedTo(idx);
    const cards = $('grid').children;
    if (rovingIndex >= 0 && rovingIndex < cards.length && rovingIndex !== idx) {
      cards[rovingIndex].tabIndex = -1;
    }
    rovingIndex = idx;
    const el = cards[idx];
    if (!el) return;
    el.tabIndex = 0;
    if (opts.focus) {
      el.focus({ preventScroll: true });
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /** 列表换了（筛选 / 重扫 / 升级重建）之后，把 roving 夹回合法范围 */
  function clampRoving() {
    if (!state.filtered.length) { rovingIndex = 0; return; }
    if (rovingIndex < 0 || rovingIndex >= state.filtered.length) rovingIndex = 0;
  }

  function onGridKeydown(e) {
    const card = e.target && e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    const idx = state.filtered.findIndex((c) => c.id === card.dataset.id);
    if (idx < 0) return;

    const last = state.filtered.length - 1;
    const cols = gridColumns();
    let next = -1;

    switch (e.key) {
      case 'ArrowRight': next = idx + 1; break;
      case 'ArrowLeft': next = idx - 1; break;
      case 'ArrowDown': next = idx + cols; break;
      case 'ArrowUp': next = idx - cols; break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      case 'PageDown': next = idx + cols * gridRowsPerPage(); break;
      case 'PageUp': next = idx - cols * gridRowsPerPage(); break;

      case 'Enter':
      case ' ':
        e.preventDefault();
        toggleSelect(state.filtered[idx].id);
        state.lastClickIndex = idx;
        updateStats();
        paintSelection(state.selected);
        return;

      case 'p': case 'P':
        e.preventDefault();
        openLightbox(idx);
        return;

      case 'r': case 'R': {
        const btn = card.querySelector('.restore');
        if (!btn) return;                 // 这张本来就是原图，什么都不做
        e.preventDefault();
        runOneRestore(card, state.filtered[idx], btn);
        return;
      }

      default: return;
    }

    e.preventDefault();
    setRoving(Math.max(0, Math.min(last, next)), { focus: true });
  }

  /* ------------------------------------------------------------------ *
   * 读屏器播报
   *
   * 界面上的数字变化又碎又频繁（扫描进度、体积合计、框选中的计数……），
   * 直接给底栏统计挂 aria-live 会把每个中间态都念一遍，等于噪音。
   * 所以另起一个只读屏器可见的区域（#srStatus），只在**有意义的时刻**
   * 写一句人话进去；连续调用做防抖，最后一句说了算。
   * ------------------------------------------------------------------ */
  function announce(text) {
    const el = $('srStatus');
    if (!el || !text) return;
    clearTimeout(srTimer);
    srTimer = setTimeout(() => { el.textContent = String(text); }, 180);
  }

  /* ------------------------------------------------------------------ *
   * 单张还原（对某一张没还原成功的图单独重试）
   * ------------------------------------------------------------------ */

  /**
   * 这张图值不值得给一个「还原」按钮？
   *
   * 判据是「有没有可用的原图候选 URL」—— 纯字符串运算，不发请求。
   * 页面上本来就是原图的（URL 里没有任何尺寸 / 处理参数），点了也是白等
   * 一次 4 秒探测，给按钮只会让整个网格充满无效操作。
   *
   * 结果按候选对象缓存：网格是分片增量渲染的，筛选一变还会整体重排，
   * 同一张卡片会被反复构建，没必要每次重跑十来个正则。
   */
  const restoreCache = new WeakMap();
  function canRestoreOne(c) {
    if (!c || c.restored) return false;
    const hit = restoreCache.get(c);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      ok = C.buildRestoreCandidates(c.url, Store.getSettings()).length > 0;
    } catch (e) { ok = false; }
    restoreCache.set(c, ok);
    return ok;
  }

  /* 图标一律走 IH.Lucide（shared/lucide.js）。原来这三个是手画的，
     stroke-width 分别写了 3 / 3.4 / 2.4 —— 同一张卡片上的两个角标
     粗细不一样，放大看就是毛边。尺寸交给 CSS 的 --ic-xs 档位。 */
  const RESTORE_SPINNER = U.icon('loader-circle');

  /** 原地换掉一个卡片元素：不重排、不滚动、不重放入场动画 */
  function replaceCardInPlace(cardEl, c) {
    if (!cardEl || !cardEl.parentNode) return null;
    const idx = state.filtered.indexOf(c);
    const fresh = buildCard(c, idx < 0 ? 0 : idx);
    fresh.style.animation = 'none';     // 原地替换不该再播一次入场动画
    cardEl.replaceWith(fresh);
    return fresh;
  }

  /**
   * 对一张图单独重跑一次原图还原。
   *
   * 为什么不能「改完 c.url 直接 applyFilters()」：id = quickHash(normalizeUrl(url))，
   * 还原会改 url，于是同一张图换了 id —— 勾选集合是按 id 存的，整格重建会让用户
   * 刚勾的全掉，而且排序一变卡片会跳走、滚动位置也会弹回顶部。所以这里只动这一张：
   * 把 id / 勾选 / 体积缓存一起搬过去，再**原地替换这一个卡片元素**。
   */
  async function runOneRestore(cardEl, c, btn) {
    if (!c || c.restoring) return;
    c.restoring = true;
    btn.disabled = true;
    btn.classList.add('busy');
    btn.innerHTML = RESTORE_SPINNER;

    let res = null;
    try {
      res = await U.sendToBg({
        type: MSG.RESTORE_ONE,
        payload: {
          tabId: tabId,
          // 交给后台去定位拥有这张图的 frame —— 一次还原会给每个候选发真实加载请求，
          // 页面上 iframe 一多，广播式的转发会让每个 frame 都白跑一遍
          frameId: typeof c.frameId === 'number' ? c.frameId : null,
          url: c.url,
          width: c.width || 0,
          height: c.height || 0
        }
      });
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    c.restoring = false;

    if (!res || !res.ok) {
      // 失败要保持按钮可用 —— 多半是网络抖动 / 页面正在刷新，再点一次就好
      btn.disabled = false;
      btn.classList.remove('busy');
      btn.textContent = t('pop.restore');
      toast(t('pop.restoreFail', { msg: (res && res.error) || t('cmn.unknownError') }), 'err');
      return;
    }

    if (!res.restored) {
      // 确实没有更大的原图：把按钮收掉，别让它一直勾着人再点第二次
      restoreCache.set(c, false);
      replaceCardInPlace(cardEl, c);
      toast(t('pop.restoreNoBetter'));
      return;
    }

    const oldId = c.id;
    const oldUrl = c.url;
    c.restoredFrom = oldUrl;
    c.url = res.url;
    c.width = res.width || c.width;
    c.height = res.height || c.height;
    c.restored = true;
    c.restoreRule = res.ruleId || 'builtin';
    c.type = U.extFromUrl(c.url) || '';
    c.host = U.prettyHost(c.url);

    // id 跟着 URL 走，勾选与体积缓存一起搬（跟「先出图、后升级」同一套做法）
    const newId = U.quickHash(U.normalizeUrl(c.url));
    if (newId !== oldId) {
      c.id = newId;
      if (state.selected.delete(oldId)) state.selected.add(newId);
    }
    if (state.sizes[oldUrl] !== undefined) {
      if (state.sizes[c.url] === undefined) state.sizes[c.url] = state.sizes[oldUrl];
      delete state.sizes[oldUrl];
    }

    replaceCardInPlace(cardEl, c);
    updateChipCounts();     // 尺寸变了，尺寸筛选 chip 上的计数要跟着变
    updateStats();
    toast(t('pop.restoredOne', { w: c.width || 0, h: c.height || 0 }));
  }

  /**
   * 卡片的可访问名称。读屏器念这一句，用户就该知道
   * 「这是第几张、多大、什么格式、有没有还原、来自哪一页」。
   *
   * 不把「已勾选 / 未勾选」写进来 —— 那是 `aria-selected` 的职责，
   * 写进名字里会被念两遍（「已勾选，已勾选」）。
   */
  function cardLabel(c, index) {
    const parts = [t('pop.cardIndex', { n: index + 1 })];
    parts.push(formatDimShort(c));
    if (c.type) parts.push(String(c.type).toUpperCase());
    if (c.restored) parts.push(t('pop.labelRestored'));
    if (state.targetCount > 1 && c.pageHost) {
      parts.push(t('pop.fromPage', { host: c.pageHost }));
    }
    // 中文用「，」分隔，英文用 ', ' —— 读屏器念起来才自然
    return parts.join(I18n.lang() === 'zh' ? '，' : ', ');
  }

  function buildCard(c, index) {
    const card = document.createElement('div');
    const selected = state.selected.has(c.id);
    card.className = 'card' + (selected ? ' selected' : '');
    card.dataset.id = c.id;
    card.style.animationDelay = Math.min(index, 24) * 10 + 'ms';
    card.title = c.url;
    /* 网格是 listbox、卡片是 option —— 读屏器才念得出「第几张 / 多大 / 选没选」。
       tabindex 走 roving：只有当前那一张是 0，其余全是 -1（见 rovingIndex）。 */
    card.setAttribute('role', 'option');
    card.tabIndex = index === rovingIndex ? 0 : -1;
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    card.setAttribute('aria-label', cardLabel(c, index));

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;   // 防止原生图片拖拽打断框选
    img.alt = c.alt || '';
    img.src = c.displayUrl || c.url;
    let triedFallback = false;
    img.addEventListener('error', () => {
      if (triedFallback) { img.style.visibility = 'hidden'; return; }
      triedFallback = true;
      img.src = c.url;
    });
    thumb.appendChild(img);

    // 勾选圈
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.type = 'button';
    pick.title = t('pop.pickTitle');
    /* 对读屏器隐藏：它和卡片自己的 `aria-selected` 说的是同一件事，
       两个都念一遍只会让人以为有两个开关。键盘用户按 Enter / 空格即可。
       鼠标用户照常点它（点击处理在 onGridClick 里）。 */
    pick.setAttribute('aria-hidden', 'true');
    pick.tabIndex = -1;
    pick.innerHTML = U.icon('check');
    thumb.appendChild(pick);

    // 预览
    const zoom = document.createElement('button');
    zoom.className = 'zoom';
    zoom.type = 'button';
    zoom.title = t('pop.zoomTitle');
    /* tabindex = -1：不占 Tab 顺序（否则每张卡片都是 3 个停靠点），
       但仍在无障碍树里，读屏器的虚拟光标可以点它。
       键盘等价物是卡片上的 P 键（见 onGridKeydown 与 #gridHelp）。 */
    zoom.tabIndex = -1;
    zoom.setAttribute('aria-label', t('pop.zoomAria'));
    zoom.innerHTML = U.icon('zoom-in');
    thumb.appendChild(zoom);

    // 「还原」按钮：只给「有原图候选、但这一轮没还原成功」的图。
    // 原图还原有 8 秒时间预算（RESTORE_TIME_BUDGET），按文档顺序推进，
    // 超预算时牺牲的一定是靠后的图片 —— 它们会保持页面上的缩略图地址。
    // 以前用户只有「重新嗅探」一条路，而重跑大概率还是超时；有了这个按钮
    // 就能对某一张单独补一次，不必重来。
    if (canRestoreOne(c)) {
      const restore = document.createElement('button');
      restore.className = 'restore';
      restore.type = 'button';
      restore.title = t('pop.restoreTitle');
      restore.tabIndex = -1;                 // 同 zoom：不占 Tab 顺序，键盘等价物是 R
      restore.setAttribute('aria-label', t('pop.restoreAria'));
      restore.textContent = t('pop.restore');
      thumb.appendChild(restore);
    }

    // 角标
    const badges = document.createElement('div');
    badges.className = 'badges';
    if (c.restored) {
      const b = document.createElement('span');
      b.className = 'badge restored';
      b.textContent = t('pop.cardOriginal');
      b.title = t('pop.cardOriginalTitle');
      badges.appendChild(b);
    }
    if (state.downloaded.has(c.id)) {
      const b = document.createElement('span');
      b.className = 'badge downloaded';
      b.textContent = t('pop.cardDownloaded');
      badges.appendChild(b);
    }
    if (c.width && c.width >= 1920) {
      const b = document.createElement('span');
      b.className = 'badge big';
      b.textContent = 'HD';
      badges.appendChild(b);
    }
    /* 合并嗅探时才出现：这张图是从哪个页面扫到的。
       不标的话，多页合并后用户根本分不清哪张来自哪一页 ——
       而「哪一页」正是他勾多个页面的原因。 */
    if (state.targetCount > 1 && c.pageHost) {
      const b = document.createElement('span');
      b.className = 'badge page';
      b.textContent = c.pageHost;
      b.title = t('pop.fromPage', { host: c.pageUrl || c.pageHost })
        + (c.pageHosts && c.pageHosts.length > 1
          ? t('pop.alsoOn', {
            list: c.pageHosts.filter((h) => h !== c.pageHost)
              .join(I18n.lang() === 'zh' ? '、' : ', ')
          })
          : '');
      badges.appendChild(b);
    }
    if (badges.children.length) thumb.appendChild(badges);

    card.appendChild(thumb);

    // 信息条
    const meta = document.createElement('div');
    meta.className = 'meta';

    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = formatDimShort(c);
    meta.appendChild(dim);

    const size = document.createElement('span');
    size.className = 'size';
    const known = state.sizes[c.url];
    if (known === undefined) {
      size.textContent = c.type ? String(c.type).toUpperCase() : '';
    } else if (known === null) {
      size.textContent = '—';
    } else {
      size.textContent = U.formatBytes(known);
    }
    meta.appendChild(size);

    card.appendChild(meta);
    return card;
  }

  function syncSelectionUI() {
    const n = state.selected.size;
    $('statSelected').textContent = String(n);
    $('saveCount').textContent = String(n);
    $('btnSave').disabled = n === 0;
    if ($('btnSaveZip')) $('btnSaveZip').disabled = n === 0;
    $('ftrHint').textContent = n ? t('pop.willSave', { n }) : t('pop.ftrHintSelect');
    /* 读屏器：勾选数变了要说一声。announce 自带 180ms 防抖，
       所以框选拖拽期间（每帧都在变）不会刷屏，只在停下来之后念一句。
       初值是 0，于是「打开图库」那一次 n=0 不会白念一句。 */
    if (n !== lastAnnouncedSelected) {
      lastAnnouncedSelected = n;
      announce(n ? t('pop.selectedN', { n }) : t('pop.clearedAll'));
    }
  }

  /** 把「几分钟前」说成人话 */
  function cacheAgeText(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 60) return t('pop.ageSeconds', { n: s });
    return t('pop.ageMinutes', { n: Math.round(s / 60) });
  }

  function updateStats() {
    $('statTotal').textContent = String(state.all.length);
    $('statFiltered').textContent = String(state.filtered.length);

    // 截断提示：只有真的被截断时才出现，避免给正常页面添噪音。
    // 三种情况都在这儿说：① 图片总数超上限；② 背景图扫描超元素数上限；
    // ③ 原图还原超过时间预算（靠后的图片仍是页面上的版本）。
    const note = $('truncNote');
    if (note) {
      const parts = [];
      if (state.truncated && state.found > state.all.length) {
        parts.push(t('pop.truncTotal', { found: state.found, shown: state.all.length }));
      }
      // 合并嗅探：合并后的 found 就等于实际张数，上面那条不会触发，
      // 但「某个页面被截断了」这件事仍要如实说出来
      if (state.targetCount > 1 && state.truncated) {
        parts.push(t('pop.truncMerged'));
      }
      if (state.bgTruncatedFrames) {
        parts.push(t('pop.truncBg', { n: state.bgTruncatedElements }));
      }
      if (state.restoreTruncated) {
        parts.push(t('pop.truncRestore'));
      }
      if (state.deepTruncated) {
        parts.push(t('pop.truncDeep'));
      }
      // 隐藏时清空文案：否则 DOM 里会留着上一页的「本页共 2001 张」，
      // 一旦哪天样式把 hidden 覆盖掉就会露出过期数字
      note.hidden = !parts.length;
      note.textContent = parts.length
        ? t('pop.parenList', { list: parts.join(I18n.lang() === 'zh' ? '；' : '; ') })
        : '';
    }

    /* 复用缓存时如实标出来。**不能因为「反正是同一页」就闷着不说** ——
       用户点了重新嗅探却发现还是旧结果，会以为扩展坏了。
       做成按钮，点一下就是强制重新嗅探。 */
    const cnote = $('cacheNote');
    if (cnote) {
      if (state.cachedAt) {
        cnote.hidden = false;
        cnote.textContent = t('pop.cacheNote', { age: cacheAgeText(state.cachedAt) });
      } else {
        cnote.hidden = true;
        cnote.textContent = '';
      }
    }

    const mfc = $('selAllCount');
    if (mfc) mfc.textContent = state.filtered.length ? String(state.filtered.length) : '';

    let bytes = 0;
    let known = 0;
    for (const c of state.selected.size ? state.all.filter((x) => state.selected.has(x.id)) : []) {
      const b = state.sizes[c.url];
      if (typeof b === 'number') { bytes += b; known++; }
    }
    $('statSize').textContent = known ? U.formatBytes(bytes) : '—';

    syncSelectionUI();
  }

  /* ------------------------------------------------------------------ *
   * 已下载标记
   * ------------------------------------------------------------------ */

  async function loadDownloadedFlags(force) {
    if (!state.all.length) return;
    if (state.downloaded.size && !force) return;

    // 计算指纹需要 SHA-256，分批处理避免阻塞
    const map = await Store.getFingerprintMap();
    const keys = Object.keys(map);
    if (!keys.length) return;

    const set = new Set();
    const batch = 200;
    for (let i = 0; i < state.all.length; i += batch) {
      const slice = state.all.slice(i, i + batch);
      const fps = await Promise.all(slice.map((c) => fingerprintOf(c)));
      fps.forEach((fp, j) => { if (map[fp]) set.add(slice[j].id); });
    }
    state.downloaded = set;
  }

  async function fingerprintOf(c) {
    return await U.sha256hex(c.url + '|' + (c.width || 0) + 'x' + (c.height || 0));
  }

  /* ------------------------------------------------------------------ *
   * 体积探测
   * ------------------------------------------------------------------ */

  /**
   * 探测图片体积（HEAD 请求读 Content-Length，不下载图片本体）。
   *
   * 推进策略 —— 「推进」和「重试」是两个动作，绝不互相堵死：
   *   1. 有待探测的（从没探过）→ 探它们，全部探完为止（按 PROBE_LIMIT 分批）。
   *   2. 待探测的已经探过一轮、但有失败项 → 这一轮只重试失败项。
   *   3. 两样都没有 → 提示无事可做。
   *
   * 失败项记进 state.probeFailed，不再算作「待探测」。
   * 否则前 N 张一直失败（站点禁跨域）就会永远占据队首，后面的图一辈子轮不到 ——
   * 这正是 AUDIT P1-5 里的死循环。
   */
  /* (探测体积 / 批量保存 / 进度 / 导出清单 已拆分至 popup/actions.js) */

  /* ------------------------------------------------------------------ *
   * 预览
   * ------------------------------------------------------------------ */

  async function openLightbox(index) {
    // 灯箱只需要「当前要显示的那张图」和它的元信息。
    // 之前这里还塞了候选的 pageUrl（页面实际显示的地址），但 lightbox.js 从头到尾没读过
    // —— 纯死字段，已去掉（AUDIT P3-9）。
    const list = state.filtered.map((c) => ({
      url: c.url,
      width: c.width,
      height: c.height,
      type: c.type || U.extFromUrl(c.url),
      sizeBytes: typeof state.sizes[c.url] === 'number' ? state.sizes[c.url] : null,
      alt: c.alt,
      restored: c.restored
    }));

    // 面板模式：图库本身是嵌在网页右侧的一条窄 iframe，灯箱开在里面只会被挤成一条，
    // 交给网页开才是真正的全屏。这里维持原样。
    if (MODE === 'panel') {
      const res = await U.sendToBg({
        type: MSG.OPEN_LIGHTBOX,
        tabId,
        payload: { list, index }
      });
      if (!res || !res.ok) toast(t('pop.lightboxFail'), 'err');
      return;
    }

    // 弹窗 / 独立标签页：在本页直接开灯箱。
    //
    // 以前这里不分模式，一律把消息转给**目标网页**标签页，灯箱就开在那边 ——
    // 于是「点放大镜」变成「被甩到原标签页」，弹窗模式还会顺手 window.close() 把自己关掉。
    // 现在预览留在图库页内，点开就是点开，不换地方。
    if (!IH.Lightbox) {
      toast(t('pop.lightboxMissing'), 'err');
      return;
    }
    IH.Lightbox.open(list, index, { pageUrl: state.pageUrl || '' });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  // 导出格式切换：在「导出清单」按钮上右键 → CSV（左键仍是 JSON）
  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('btnExport');
    if (!btn) return;
    btn.title = t('pop.exportTitle2');
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      exportFormat = 'csv';
      exportList();
      exportFormat = 'json';
    });
  });

  init().catch((e) => {
    console.error('[ImageHunter] 初始化失败', e);
    $('loading').hidden = true;
    showEmpty(t('pop.initFail', { msg: (e && e.message) || e || t('cmn.unknownError') }));
  });
})();
