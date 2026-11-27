/* ==========================================================================
 * ImageHunter — background.js  (Manifest V3 Service Worker)
 *
 * 职责：
 *  1. 消息路由（弹窗 / 内容脚本）
 *  2. 多 iframe 扫描结果汇总
 *  3. 下载队列：并发控制、失败重试、进度广播
 *  4. 403 降级：扩展页 fetch 不受 CORS 限制 → blob / dataURL 再下载
 *  5. 图片体积探测（HEAD / Range）
 *  6. 下载历史 + 已下载指纹（跳过重复）
 *  7. 右键菜单 / 快捷键
 *  8. SW 休眠恢复：队列持久化到 storage.session
 * ========================================================================== */

importScripts('shared/constants.js', 'shared/utils.js', 'shared/store.js', 'shared/i18n.js', 'shared/i18n-ext.js');

const IH = globalThis.IH;
const C = IH.C;
const U = IH.U;
const Store = IH.Store;
const MSG = C.MSG;
/* 后台没有界面，但它返回的 error / reason 会被悬停气泡、图库提示和下载历史
   原样显示给用户 —— 所以这些句子同样跟着界面语言走。
   语言取自设置里的 uiLang（'auto' 时退到 navigator.language，SW 里也有）。 */
const t = (k, a) => IH.I18n.t(k, a);

importScripts('bg/probe.js', 'bg/auth.js', 'bg/scan.js', 'bg/downloads.js');

/* ====================================================================== *
 * 全局状态（由 bg/*.js 与本文件共同使用）
 * ====================================================================== */

let queue = [];                  // 待下载任务
let activeCount = 0;
let pumping = false;
let job = null;                  // 当前批次 { batchId, total, done, failed, skipped, status, ... }
const recentLog = [];            // 最近若干条下载结果（用于进度面板）
let jobRestoreCount = 0;

/* 已经在下载中的任务（已经从 queue 里 shift 出去了）。
 *
 * 为什么要单独记：persistJob 以前只存 queue，而 queue 里的任务在 worker
 * `shift()` 出去的那一刻就不在里面了 —— 于是 SW 一被回收，**正在下的那一张
 * 就彻底消失**：既不在待办里，也没进 done/failed，这个批次的数字永远对不上
 * （done+failed+skipped 会一直小于 total，进度条卡在 99%）。
 *
 * 配上 downloadId 之后还能做更重要的判断：重启后先问 chrome.downloads
 * 「那个 id 到底下完了没有」，下完了就直接记账（不重下、不留重复文件），
 * 没下完就重新排队。这叫对账，不是猜。 */
let activeTasks = [];
/* 已经记过账的 downloadId。对账要幂等：SW 可能连续重启两次，
   同一个 id 不能既算一次 done 又写一条历史。 */
let settledIds = new Set();
let restoringJob = false;

const pendingDownloads = new Map();   // downloadId -> { resolve, reject, timer }
const scanSessions = new Map();       // reqId -> session

const SESSION_KEY = 'ih_job';

/** 内容脚本完全没有动静时，等多久就放弃（秒级，用户还在盯着加载动画） */
const SCAN_IDLE_TIMEOUT = 4000;
/** 已经收到 partial、正在等原图还原时，最多再等多久 */
const SCAN_RESTORE_TIMEOUT = 15000;
/** 深度嗅探：要滚动整页，光滚动就可能十几秒，还原还得再算 */
const SCAN_DEEP_TIMEOUT = 45000;

function broadcast(message) {
  try {
    const p = chrome.runtime.sendMessage(message);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* 没有接收方时忽略 */ }
}

async function settings() {
  return await Store.loadSettings();
}

/* ====================================================================== *
 * 消息路由
 * ====================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  switch (msg.type) {
    case MSG.GET_TAB_ID: {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      sendResponse({ ok: tabId != null, tabId });
      return true;
    }

    case MSG.SCAN_TAB: {
      const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      if (tabId == null) { sendResponse({ ok: false, error: t('bg.noTargetTab') }); return true; }

      /* 先出图、后升级。
       *
       * 一条消息**只能 sendResponse 一次**，所以这里得自己记住兑现过没有：
       *   - 内容脚本报第一版中间结果（partial）时立刻兑现 → 图库马上把图铺出来，
       *     不用盯着 spinner 等原图还原（冷还原最长 8 秒）
       *   - 还原跑完拿到最终结果时再兑现一次，但那一次是空操作 ——
       *     于是改走 SCAN_UPGRADE 广播，由图库页原地把卡片换成原图地址
       *
       * 没有 partial 的路径（整页一张图都没有、内容脚本报 busy）不受影响：
       * 只有最终结果一次兑现，与改动前完全一致。 */
      let answered = false;
      const answer = (payload) => {
        if (answered) return false;
        answered = true;
        sendResponse(payload);
        return true;
      };

      const runScan = () => {
        scanTab(tabId, {
          deep: !!msg.deep,
          /* finalOnly：调用方只要**最终结果**（含原图还原），不接受「先出图」的 partial。
             悬停预览走的就是这条路 —— 用户点预览键要的是「能左右翻的整份原图列表」，
             给他一版还没还原的缩略图地址，翻到一半再被 SCAN_UPGRADE 换成另一批 URL，
             体验上是「图会自己变」，比多等两秒难受得多。
             scanTab 兑现的本来就是最终结果，这里只是不让 partial 抢先兑现响应。 */
          onPartial: msg.finalOnly
            ? null
            : async (p) => {
              await ensurePreviewRefererRules(p && p.images, p && p.pageUrl);
              answer(Object.assign({ phase: C.SCAN_PHASE.PARTIAL }, p));
            }
        }).then(async (final) => {
          /* 只缓存**最终**结果：partial 里还全是页面上的缩略图地址，存下来等于
             把「没还原」的状态固化 5 分钟。也只在真的扫成功时缓存 ——
             blocked / 出错都该下次重新判断，不能留下痕迹。 */
          await ensurePreviewRefererRules(final && final.images, final && final.pageUrl);
          if (final && final.ok && final.pageUrl) putCachedScan(tabId, final.pageUrl, final);
          recordScanSummary(final, final && final.pageUrl);
          if (!answer(final)) broadcast({ type: MSG.SCAN_UPGRADE, payload: final });
        }, (e) => answer({ ok: false, error: String(e) }));
      };

      // 深度嗅探（用户显式要求「滚一遍全页」）和 force（点了「重新嗅探」）
      // 一律走真扫描 —— 这两个入口的全部意义就是「别给我旧结果」。
      if (msg.deep || msg.force) { runScan(); return true; }

      /* 缓存命中就立刻兑现，不注入、不重扫。
         键里带地址，所以同一个标签页导航到别的页面后必然不命中；
         拿不到地址（查询失败）时也不用缓存 —— 宁可慢一次，不能给错列表。 */
      (async () => {
        let url = '';
        try {
          const info = await chrome.tabs.get(tabId);
          url = (info && info.url) || '';
        } catch (e) { url = ''; }

        let hit = null;
        try { hit = await getCachedScan(tabId, url); } catch (e) { hit = null; }
        if (hit) {
          await ensurePreviewRefererRules(hit.result && hit.result.images, url);
          // reqId 换成新的：旧的那个可能对应一次已经结束的扫描，
          // 留着它反而有机会和一条迟到的 SCAN_UPGRADE 广播撞上
          // 缓存命中也要记一笔：用户看到的这一份就是它，诊断包里
          // 「这次扫描为什么这么快」的答案就在 cached 这个字段上
          recordScanSummary(hit.result, url, { cached: true });
          sendResponse(Object.assign({}, hit.result, {
            reqId: U.uid(),
            cached: true,
            cachedAt: hit.at,
            ageMs: Date.now() - hit.at
          }));
          return;
        }
        runScan();
      })();
      return true;
    }

    case MSG.DEEP_PROGRESS: {
      // 内容脚本滚一屏回报一次；转发给扩展页，让界面把进度显示出来。
      // 带上 tabId 是因为图库可能同时开着多个，只有发起这次扫描的那个该响应。
      const tabId = sender && sender.tab && sender.tab.id;
      broadcast({
        type: MSG.DEEP_PROGRESS,
        payload: { tabId, round: msg.round || 0, total: msg.total || 0, added: msg.added || 0 }
      });
      sendResponse({ ok: true });
      return true;
    }

    case MSG.SCAN_RESULT:
      onScanResult(msg, sender);
      sendResponse({ ok: true });
      return true;

    case MSG.DOWNLOAD_ONE: {
      const payload = msg.payload || {};
      // awaitCompletion: 等这张图真正落盘（或失败/被跳过）再回应，
      // 保证悬停图标的提示与实际结果一致
      startBatch([payload], { awaitCompletion: true })
        .then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case MSG.DOWNLOAD_BATCH: {
      const payload = msg.payload || {};
      startBatch(payload.items || [], payload).then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case MSG.CANCEL_BATCH:
      sendResponse(cancelBatch());
      return true;

    case MSG.GALLERY_HELLO: {
      // 图库页自报家门，后台据此记住它的标签页 id（复用标签页 + 避免重复打开）
      const gid = sender && sender.tab ? sender.tab.id : null;
      if (gid != null) galleryTabId = gid;
      sendResponse({ ok: true });
      return true;
    }

    case MSG.GET_TARGET_TAB: {
      // 独立标签页模式下，页面里的「当前活动标签页」就是图库自己，
      // 所以扫描目标必须由后台给出
      pickTargetTab(null).then((tabId) => sendResponse({ ok: true, tabId }), () => sendResponse({ ok: false }));
      return true;
    }

    case MSG.LIST_TABS: {
      const selfId = sender && sender.tab ? sender.tab.id : null;
      chrome.tabs.query({}).then((tabs) => {
        const list = (tabs || [])
          .filter((t) => isContentTab(t) && t.id !== selfId)
          .map((t) => ({
            id: t.id,
            title: t.title || '',
            url: t.url || '',
            host: U.prettyHost(t.url || ''),
            active: !!t.active
          }));
        sendResponse({ ok: true, tabs: list, current: lastContentTabId });
      }, () => sendResponse({ ok: false, tabs: [] }));
      return true;
    }

    case MSG.GET_STATS:
      sendResponse({ ok: true, progress: progressPayload(), stats: null });
      return true;

    /* 诊断包的原料。**只回原料，不做组装** ——
       清洗 / 白名单 / 自查都在 shared/diagnostics.js 里，由设置页调用。
       让 background 也参与格式化的话，同一份规则就要维护两遍。 */
    case MSG.GET_DIAGNOSTICS: {
      loadLastScan().then((scan) => sendResponse({
        ok: true,
        lastScan: scan || null,
        recent: recentLog.slice(0, 20),
        probe: Object.assign({}, probeStats)
      }), () => sendResponse({ ok: false }));
      return true;
    }

    case MSG.GET_HISTORY:
      Store.getHistory().then((h) => sendResponse({ ok: true, history: h }), () => sendResponse({ ok: false }));
      return true;

    case MSG.CLEAR_HISTORY:
      Store.clearHistory().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    case MSG.CLEAR_FINGERPRINTS:
      Store.clearFingerprints().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    case MSG.PROBE_SIZE: {
      const urls = (msg.payload && msg.payload.urls) || [];
      probeMany(urls).then((r) => sendResponse({ ok: true, sizes: r }), () => sendResponse({ ok: false }));
      return true;
    }

    case MSG.OPEN_LIGHTBOX: {
      const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      if (tabId == null) { sendResponse({ ok: false }); return true; }
      chrome.tabs.sendMessage(tabId, {
        type: MSG.OPEN_LIGHTBOX,
        payload: msg.payload
      }, { frameId: 0 }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    case MSG.TOGGLE_PANEL:
    case MSG.OPEN_PANEL: {
      const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      if (tabId == null) { sendResponse({ ok: false }); return true; }
      // 站点被排除时不注入、不开面板 —— 面板是「往别人页面里塞一个 iframe」，
      // 正是排除列表要拦的那类行为。内容脚本里还有一道同款检查兜底。
      (async () => {
        let info = null;
        try { info = await chrome.tabs.get(tabId); } catch (e) { info = null; }
        if (info && isBlockedUrl(info.url)) {
          sendResponse({ ok: false, error: 'blocked', blocked: true });
          return;
        }
        await ensureInjected(tabId);
        const type = msg.type === MSG.OPEN_PANEL ? MSG.OPEN_PANEL : MSG.TOGGLE_PANEL;
        chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 })
          .then((r) => sendResponse(r || { ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
      })();
      return true;
    }

    case MSG.OPEN_GALLERY: {
      /* 网页里悬停预览的「在图库中打开」。tabId 一律取自 sender ——
         内容脚本没法伪造它，也不该由它指定「打开哪个页面的图库」。

         排除列表**不拦这条路**：用户是从灯箱里主动点的，属于「显式操作」，
         和右键菜单的 SAVE_BY_SRC 同一类。黑名单管的是「别自己冒出来打扰我」。 */
      const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      if (tabId == null) { sendResponse({ ok: false, error: t('bg.noSourceTab') }); return true; }
      const focusUrl = (msg.payload && msg.payload.url) || '';
      openGallery(tabId, focusUrl).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true;
    }

    case MSG.FETCH_IMAGE: {
      const p = msg.payload || {};
      (async () => {
        try {
          const opts = { credentials: 'include', cache: 'no-store' };
          const res = await withRefererRule(p.url, p.pageUrl, () => U.fetchWithTimeout(p.url, opts, 20000));
          if (!res.ok) throw new Error('HTTP ' + res.status);
          /* 以前是先 `await res.blob()` 再判 `size > 16MB` ——
             判断发生在内存已经吃完之后，等于没判。改成边读边计数。 */
          let got;
          try {
            got = await U.readBodyLimited(res, {
              maxBytes: MAX_IMAGE_BYTES,
              timeoutMs: FETCH_IMAGE_READ_TIMEOUT,
              allowMime: U.isImageMime
            });
          } catch (e) {
            throw bodyLimitError(e);
          }
          if (!got.bytes) throw new Error(t('bg.emptyBody'));
          const dataUrl = await U.blobToDataUrl(got.blob);
          sendResponse({ ok: true, dataUrl, size: got.bytes, mime: got.mime });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true;
    }

    case MSG.SAVE_BY_SRC: {
      // 右键菜单：让内容脚本按 srcUrl 定位元素并保存原图
      const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      if (tabId == null) { sendResponse({ ok: false }); return true; }
      chrome.tabs.sendMessage(tabId, {
        type: MSG.SAVE_BY_SRC,
        payload: msg.payload
      }, { frameId: (sender && sender.frameId) || 0 })
        .then((r) => sendResponse(r || { ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case MSG.RESTORE_ONE: {
      /* 单张还原：图库页发起的、对某一张图单独重跑一次原图还原。
         图库是扩展页，跟图片所在的页面不在同一个上下文，所以必须由后台转发。

         尽量只发给「拥有这张图的那个 frame」：一次 tryRestore 会给每个候选 URL
         发真实加载请求，页面上有几十个 iframe 时，广播式的 sendMessage 会让
         每个 frame 都白跑一遍同样的探测（实测确实会）。
         frameId 由 onScanResult 打在每张图上，一路带到图库。 */
      const payload = msg.payload || {};
      const tabId = payload.tabId != null ? payload.tabId : (sender && sender.tab && sender.tab.id);
      if (tabId == null) { sendResponse({ ok: false, error: t('bg.noTargetTab') }); return true; }
      if (!payload.url) { sendResponse({ ok: false, error: t('bg.missingUrl') }); return true; }

      const message = {
        type: MSG.RESTORE_ONE,
        payload: { url: payload.url, width: payload.width || 0, height: payload.height || 0 }
      };
      const frameOpt = typeof payload.frameId === 'number' ? { frameId: payload.frameId } : null;

      (async () => {
        const injected = await ensureInjected(tabId);
        if (!injected) { sendResponse({ ok: false, error: t('bg.cannotConnect') }); return; }

        let res = null;
        try {
          res = await chrome.tabs.sendMessage(tabId, message, frameOpt || undefined);
        } catch (e) {
          // 记下的 frameId 可能已经失效（页面刷新 / 子 frame 被移除），退化成广播一次
          if (frameOpt) {
            try { res = await chrome.tabs.sendMessage(tabId, message); } catch (e2) { res = null; }
          }
        }
        sendResponse(res || { ok: false, error: '目标页面没有响应（可能已关闭或正在刷新）' });
      })();
      return true;
    }

    case MSG.PANEL_TOKEN: {
      /* 只发给**内容脚本**。
         `sender.tab` 是消息来源标签页，网页脚本发不出 runtime 消息，伪造不了。
         但嵌在网页里的扩展页（面板自己）也带 sender.tab —— 如果它也来领 token，
         就变成了「自己给自己发通行证」，所以扩展页要挡掉：
         它的 sender.url 是 chrome-extension://，内容脚本的是网页地址。 */
      if (isExtensionPageSender(sender)) {
        sendResponse({ ok: false, error: '扩展页不能领面板 token' });
        return true;
      }
      const tabId = senderTabId(sender);
      if (tabId == null) { sendResponse({ ok: false, error: '不是来自标签页的请求' }); return true; }
      issuePanelToken(tabId).then(
        (token) => sendResponse({ ok: true, token }),
        () => sendResponse({ ok: false })
      );
      return true;
    }

    case MSG.PANEL_VERIFY: {
      /* 面板自证。
         关键点：**tabId 从 sender 取，不从 payload 取**。
         以前是 `verifyPanelToken(p.tabId, p.token)` —— p.tabId 是请求方自己填的，
         只要拿到任意一个标签页的 token，就能声称自己是那个标签页。
         现在绑成「你确实跑在 sender.tab 里」，网页换不了。 */
      const p = msg.payload || {};
      const tabId = senderTabId(sender);
      const frameId = senderFrameId(sender);
      const ok = !!tabId && isExtensionPageSender(sender);
      if (!ok) { sendResponse({ ok: true, valid: false, reason: 'not-extension-page' }); return true; }
      /* 「嵌在网页里」是必要条件。frameId 拿不到时用 tab.url 兜底
         （见 isEmbeddedSender）—— 有些浏览器版本对扩展页不给 frameId，
         以前这里会一律判 false，把正常的面板也挡在门外。 */
      const embedded = isEmbeddedSender(sender);
      if (embedded !== true) {
        // 顶层扩展页不是面板 —— 面板一定是被内容脚本嵌进网页的
        sendResponse({
          ok: true, valid: false,
          reason: embedded === null ? 'frame-unknown' : 'not-embedded'
        });
        return true;
      }
      if (p.tabId != null && Number(p.tabId) !== tabId) {
        sendResponse({ ok: true, valid: false, reason: 'tab-mismatch' });
        return true;
      }
      verifyPanelToken(tabId, p.token).then(
        (valid) => sendResponse({ ok: true, valid, tabId, frameId }),
        () => sendResponse({ ok: false, valid: false })
      );
      return true;
    }

    case MSG.GALLERY_AUTH: {
      /* 独立页（?mode=page）自证。
         以前 mode=page 完全跳过校验，理由写在注释里：「网页碰不到」。
         可网页能 `<iframe src="...popup.html?mode=page">` —— 于是这条假设不成立，
         等于给了网页一个**零成本、完全可用**的图库套壳。
         现在要求：必须是本扩展的页面 + 必须是顶层 frame（frameId === 0）。 */
      const tabId = senderTabId(sender);
      const frameId = senderFrameId(sender);
      const isPage = isExtensionPageSender(sender);
      const top = isTopLevelSender(sender);
      sendResponse({
        ok: true,
        valid: !!tabId && isPage && top === true,
        tabId,
        frameId,
        reason: !isPage ? 'not-extension-page'
          : (top === null ? 'frame-unknown' : (top ? 'ok' : 'not-top-level'))
      });
      return true;
    }

    case MSG.SETTINGS_CHANGED: {
      // options 页保存设置后用 runtime.sendMessage 广播 —— 那条消息只能到达扩展自身
      // 的上下文（SW / 扩展页），**到不了内容脚本**。所以这里必须由后台接住再转发。
      // 否则内容脚本里那个 SETTINGS_CHANGED 分支永远是死的（AUDIT P3-2）。
      Store.loadSettings(true).then(() => {
        /* 设置一变，缓存就作废：扫哪些来源（背景图 / srcset / preload…）、
           还原规则、尺寸阈值全都可能改，留着旧结果等于拿按旧设置扫的列表
           冒充新设置的结果。整个清掉最省心，代价只是下一次慢一点。 */
        clearScanCache();
        chrome.tabs.query({}, (tabs) => {
          for (const t of tabs || []) {
            if (!t || t.id == null) continue;
            // 内容脚本没注入的页面（chrome://、扩展页等）会 reject，忽略即可
            chrome.tabs.sendMessage(t.id, { type: MSG.SETTINGS_CHANGED }, () => {
              void chrome.runtime.lastError;
            });
          }
        });
        sendResponse({ ok: true });
      }, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    default:
      return undefined;
  }
});

/* ====================================================================== *
 * 右键菜单
 * ====================================================================== */

/* `_locales/` 那套（chrome.i18n）只认**浏览器界面语言**，管的是浏览器自己渲染的东西
   —— 右键菜单标题就在这儿。名字叫 localeMsg，别和上面那个按 uiLang 取词的 t() 混了：
   两者同名会直接 SyntaxError（`Identifier 't' has already been declared`）。 */
function localeMsg(key, fallback) {
  try {
    const v = chrome.i18n.getMessage(key);
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

const MENU_DEFS = [
  {
    id: 'ih-save-image',
    titleKey: 'ctxSaveOriginal',
    titleFallback: '保存此图片（原图）',
    contexts: ['image']
  },
  {
    id: 'ih-open-gallery',
    titleKey: 'ctxOpenGallery',
    titleFallback: '打开图片库（嗅探本页图片）',
    contexts: ['page', 'link', 'selection', 'video']
  }
];

/**
 * 创建右键菜单。
 *
 * 这里必须做幂等保护：`removeAll` 是异步的，若并发调用两次，
 * 两个回调会交错执行，第二次 create 就会报
 * "Cannot create item with duplicate id"。
 *
 * 三道防线：
 *  1. 用模块级 Promise 缓存，同一 SW 实例内只执行一次
 *  2. 回调里显式读取 chrome.runtime.lastError，消除 Unchecked runtime.lastError 告警
 *  3. 即使跨 SW 实例撞车，duplicate id 也视为「已存在且配置一致」，静默忽略
 */
let menusReady = null;

function setupMenus() {
  if (menusReady) return menusReady;

  menusReady = new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;   // 读取即视为已处理，避免告警

      let left = MENU_DEFS.length;
      if (!left) { resolve(); return; }

      MENU_DEFS.forEach((def) => {
        chrome.contextMenus.create({
          id: def.id,
          title: localeMsg(def.titleKey, def.titleFallback),
          contexts: def.contexts
        }, () => {
          const err = chrome.runtime.lastError;
          if (err && !/duplicate id/i.test(err.message || '')) {
            console.warn('[ImageHunter] 右键菜单创建失败:', def.id, err.message);
          }
          if (--left === 0) resolve();
        });
      });
    });
  });

  return menusReady;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;

  if (info.menuItemId === 'ih-save-image') {
    await ensureInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      type: MSG.SAVE_BY_SRC,
      payload: { srcUrl: info.srcUrl || '' }
    }, { frameId: info.frameId || 0 }).catch(() => {});
    return;
  }

  if (info.menuItemId === 'ih-open-gallery') {
    await ensureInjected(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: MSG.OPEN_PANEL }, { frameId: 0 }).catch(() => {});
  }
});

/* ====================================================================== *
 * 图库独立标签页
 *
 * 点击扩展图标不再弹小窗口，而是在新标签页里打开完整图库。
 * 这里有两个关键点：
 *  1. 图库页自己所在的标签页会成为「当前活动标签页」，
 *     所以不能在页面里用 tabs.query({active,currentWindow}) 找扫描目标 ——
 *     必须在后台记住「最近一个普通网页标签页」。
 *  2. 图标被重复点击时复用已打开的图库标签页，而不是堆一堆。
 * ====================================================================== */

const GALLERY_PATH = 'popup/popup.html';
const galleryBase = chrome.runtime.getURL(GALLERY_PATH);

let lastContentTabId = null;   // 最近活跃的普通网页标签页
let galleryTabId = null;       // 图库标签页（由图库页自己上报）

/** 只有真正的网页才值得当作扫描目标（排除扩展页 / 新标签页 / devtools 等） */
function isContentTab(tab) {
  if (!tab || tab.id == null) return false;
  const u = tab.url || tab.pendingUrl || '';
  return /^https?:/i.test(u);
}

function galleryUrl(targetTabId, focusUrl) {
  const q = new URLSearchParams({ mode: 'page' });
  if (targetTabId != null) q.set('tabId', String(targetTabId));
  // 新开图库标签页时，「要定位到哪张图」只能走 URL 带过去 ——
  // 复用已有标签页那条路走 GALLERY_TARGET 消息（见 openGallery）。
  if (focusUrl) q.set('focus', focusUrl);
  return galleryBase + '?' + q.toString();
}

/** 找到已经打开的图库标签页；找不到返回 null */
async function findGalleryTab() {
  if (galleryTabId != null) {
    try {
      const t = await chrome.tabs.get(galleryTabId);
      if (t && (t.url || '').indexOf(GALLERY_PATH) >= 0) return galleryTabId;
    } catch (e) { /* 已关闭 */ }
    galleryTabId = null;
  }
  // 兜底：SW 重启后内存记录会丢，扫一遍标签页找回来
  try {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || '').indexOf(galleryBase) === 0);
    if (hit) { galleryTabId = hit.id; return hit.id; }
  } catch (e) { /* 没有权限时忽略 */ }
  return null;
}

/**
 * @param {number|null} targetTabId 要嗅探哪个标签页
 * @param {string} [focusUrl] 打开后定位到这张图（「在图库中打开」用）。
 *        注意是**尽力而为**：那张图可能已经被用户筛掉，也可能不在前 SCAN_LIMIT 张里，
 *        图库页会如实说明，而不是假装定位成功。
 */
async function openGallery(targetTabId, focusUrl) {
  const existing = await findGalleryTab();
  if (existing != null) {
    try {
      await chrome.tabs.update(existing, { active: true });
      const t = await chrome.tabs.get(existing);
      if (t && t.windowId != null && chrome.windows) {
        await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      }
      // 复用已有标签页时，把新的扫描目标告诉它。
      // 用 runtime.sendMessage 广播而不是 tabs.sendMessage —— 后者只面向 content script，
      // 不保证能送达扩展自己的页面。
      if (targetTabId != null || focusUrl) {
        const p = chrome.runtime.sendMessage({
          type: MSG.GALLERY_TARGET,
          payload: { tabId: targetTabId, focusUrl: focusUrl || '' }
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      return existing;
    } catch (e) { galleryTabId = null; }
  }

  const tab = await chrome.tabs.create({ url: galleryUrl(targetTabId, focusUrl) });
  if (tab && tab.id != null) galleryTabId = tab.id;
  return tab && tab.id;
}

/** 挑一个最合适的扫描目标 */
async function pickTargetTab(fallbackTab) {
  if (isContentTab(fallbackTab)) return fallbackTab.id;
  if (lastContentTabId != null) {
    try {
      const t = await chrome.tabs.get(lastContentTabId);
      if (isContentTab(t)) return lastContentTabId;
    } catch (e) { lastContentTabId = null; }
  }
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs && tabs[0];
    if (isContentTab(t)) return t.id;
  } catch (e) { /* ignore */ }
  return null;
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    const target = await pickTargetTab(tab);
    await openGallery(target);
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isContentTab(tab)) lastContentTabId = tabId;
  } catch (e) { /* ignore */ }
});

// 标签页从 chrome:// 导航到普通网页时也要记上
if (chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo) return;
    /* 地址变了、或者页面开始（重新）加载 —— 之前扫出来的结果都作废。
       只看 URL 不够：按 F5 刷新时 URL 一个字符都不变，但页面内容会重来一遍，
       拿旧列表去对新的 DOM 就是「看起来正常、内容全错」。 */
    if (changeInfo.url || changeInfo.status === 'loading') dropCachedScan(tabId);
    if (!changeInfo.url) return;
    if (isContentTab(tab)) lastContentTabId = tabId;
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === lastContentTabId) lastContentTabId = null;
  if (tabId === galleryTabId) galleryTabId = null;
  dropCachedScan(tabId);
});

/* ====================================================================== *
 * 快捷键
 * ====================================================================== */

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;

    // 打开图库走和「点扩展图标」完全同一条路 —— 包括复用已有图库标签页，
    // 免得快捷键按两下开出一堆图库页
    if (command === 'open-gallery') {
      await openGallery(await pickTargetTab(tab));
      return;
    }

    await ensureInjected(tab.id);

    if (command === 'toggle-panel') {
      chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_PANEL }, { frameId: 0 }).catch(() => {});
      return;
    }

    /* 保存「鼠标当前悬停的那张图」。悬停目标只有内容脚本知道（它才收 mouseover），
       所以这条消息只能往下发 —— 后台这边连「现在指着哪张图」都无从得知。

       刻意**不带 frameId**：图片完全可能在子 iframe 里，而鼠标在哪一帧只有那一帧
       自己知道。广播给所有 frame 后，手里真有目标的那一个才会动
       （其余帧的 target 是 null，什么都不做）。 */
    if (command === 'save-hovered') {
      chrome.tabs.sendMessage(tab.id, { type: MSG.SAVE_HOVERED }).catch(() => {});
    }
  });
}

/* ====================================================================== *
 * 生命周期：安装 / 启动 / 休眠恢复
 * ====================================================================== */

chrome.runtime.onInstalled.addListener(async () => {
  await setupMenus();
  await Store.loadSettings();
  // 保证默认设置落盘
  await Store.updateSettings({});
});

chrome.runtime.onStartup.addListener(async () => {
  await setupMenus();
  await Store.loadSettings();
  await restoreJob();
});

/**
 * SW 被唤醒时恢复未完成的下载队列。
 *
 * 注意：这里【不再】调用 setupMenus()。右键菜单是挂在扩展上的，
 * 会跨 SW 重启持续存在，只有安装 / 浏览器启动时才需要（重新）创建。
 * 若在每次 SW 唤醒时都 removeAll + create，不仅徒增开销，
 * 还会造成菜单短暂消失，并放大并发创建导致的 duplicate id 问题。
 */
(async function bootstrap() {
  try {
    await Store.loadSettings();
  } catch (e) { /* ignore */ }
  await restoreJob();
})();
