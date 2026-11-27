/* ==========================================================================
 * ImageHunter — bg/scan.js
 * 多 iframe 扫描会话汇总、扫描结果缓存与诊断摘要
 * 由 background.js 通过 importScripts 加载，共享同一个 SW 全局作用域。
 * ========================================================================== */

/* ---------------------------------------------------------------------- *
 * 诊断包用的「最近一次扫描摘要」
 *
 * 为什么要在 background 留一份：扫描统计（frame 数、截断、还原成功数、
 * 来源分布）只有这里才拼得出来 —— 图库拿到的最终结果里没有 frameCount，
 * 设置页更是完全不知情。用户报「有时候识别不到图片」时，这一份就是
 * 唯一能看出「是没扫到、还是扫到被截断、还是还原超时」的东西。
 *
 * 两条纪律：
 *  1. 只存**聚合数字**与主机名。页面标题、完整页面地址一律不进 ——
 *     内网地址（`http://10.0.0.12/…`）对排障毫无价值，泄露却是实打实的。
 *  2. 存 `storage.session`（浏览器关闭即清），不落 local ——
 *     它是排障快照，不是用户资产，没必要在磁盘上留一份浏览痕迹。
 * ---------------------------------------------------------------------- */
const DIAG_SCAN_KEY = 'ih_last_scan';
let lastScanSummary = null;
let lastScanLoaded = false;

function persistLastScan() {
  try {
    const p = chrome.storage.session.set({ [DIAG_SCAN_KEY]: lastScanSummary });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* session 存储不可用时忽略：诊断包少一段，不影响功能 */ }
}

async function loadLastScan() {
  if (lastScanLoaded) return lastScanSummary;
  lastScanLoaded = true;
  try {
    const got = await chrome.storage.session.get(DIAG_SCAN_KEY);
    if (got && got[DIAG_SCAN_KEY]) lastScanSummary = got[DIAG_SCAN_KEY];
  } catch (e) { /* 忽略 */ }
  return lastScanSummary;
}

/**
 * 记下一次扫描的聚合摘要。
 * @param {object} result  finalizeScan 的产物
 * @param {string} pageUrl 这次扫的页面地址（只取 hostname）
 * @param {{cached?: boolean}} [extra]
 */
function recordScanSummary(result, pageUrl, extra) {
  if (!result || !Array.isArray(result.images)) return;
  const sourceCounts = {};
  let restored = 0;
  for (const im of result.images) {
    const src = (im && im.source) || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    if (im && im.restored) restored++;
  }
  const found = typeof result.found === 'number' ? result.found : result.images.length;
  lastScanSummary = {
    at: Date.now(),
    pageHost: U.prettyHost(pageUrl || result.pageUrl || ''),
    frameCount: result.frameCount || 0,
    found,
    truncated: !!result.truncated,
    restored,
    // 「有多少张没拿到原图」比「还原超时了没」更好用：后者是个布尔，
    // 前者能直接对上下载后发现是缩略图的张数
    notRestored: Math.max(0, found - restored),
    restoreTruncated: !!result.restoreTruncated,
    bgTruncatedFrames: result.bgTruncatedFrames || 0,
    bgTruncatedElements: result.bgTruncatedElements || 0,
    deepTruncated: !!result.deepTruncated,
    blocked: !!result.blocked,
    cached: !!(extra && extra.cached),
    sourceCounts
  };
  lastScanLoaded = true;
  persistLastScan();
}

/* ====================================================================== *
 * 扫描：多 iframe 汇总
 * ====================================================================== */

const CONTENT_FILES = [
  'shared/constants.js',
  'shared/utils.js',
  'shared/store.js',
  'content/scanner.js',
  'content/hover.js',
  'content/lightbox.js',
  'content/panel.js',
  'content/main.js'
];

async function ensureInjected(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    if (res && res.ok) return true;
  } catch (e) { /* 未注入 */ }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES
    });
    return true;
  } catch (e) {
    return false;
  }
}

/* 单次嗅探最多返回多少张。放在 C 里是因为界面也要引用它
   （图库说「可能超出前 2000 张」用的是同一个数），写两份迟早对不上。 */
const SCAN_LIMIT = C.SCAN_LIMIT;

function finalizeScan(session) {
  const seen = new Map();
  let bgTruncatedFrames = 0;
  let bgTruncatedElements = 0;
  let restoreTruncated = false;
  let deepTruncated = false;
  /* 第一个自报错误的 frame 的错误码（见下面的「没问成 ≠ 没有图」） */
  let firstError = '';

  for (const rec of session.byFrame.values()) {
    if (rec.restoreTruncated) restoreTruncated = true;
    if (rec.deepTruncated) deepTruncated = true;
    if (rec.error && !firstError) firstError = rec.error;
    if (rec.bgTruncated) {
      bgTruncatedFrames++;
      bgTruncatedElements = Math.max(bgTruncatedElements, rec.bgElements);
    }
    for (const img of rec.images) {
      if (!img || !img.url) continue;
      const key = U.normalizeUrl(img.url);
      if (!seen.has(key)) seen.set(key, img);
    }
  }
  let list = Array.from(seen.values());
  /* 图片自身的站点。图库的「站点」排序和 CSV 导出里的「站点」列一直在读 c.host，
     但扫描结果里从来没写过这个字段 —— 于是那条排序实际上按「空串」比较，
     永远退化成按面积排。这里补上，让那个选项名副其实。
     注意别和「来源页」搞混：合并多标签页时，pageUrl 记的是「这张图出现在哪个页面」，
     而 host 是图片文件自己所在的域名（常常是 CDN）。 */
  for (const img of list) img.host = U.prettyHost(img.url);
  // 按面积降序，让大图排在前面
  list.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));

  // 截断必须如实上报 —— 否则用户以为看到的就是全部，
  // 与「所有图片一次性全部显示」的承诺直接冲突
  const found = list.length;
  const truncated = found > SCAN_LIMIT;
  if (truncated) list = list.slice(0, SCAN_LIMIT);

  /* 「一个 frame 都没回报」和「页面里确实没有图片」是两件完全不同的事，
     但过去它们长得一模一样：都是 ok:true + images:[]，图库于是统一说
     「本页没有发现图片」—— 对前者来说这是**在撒谎**：我们压根没问成。
     所以这里立一条不变量：**没有任何 frame 回报过，就不是「没图」，是「没问成」**。

     同理，frame 自己报了错（busy / 扫描抛异常）且一张图都没拿到时，
     也不能说「本页没有发现图片」—— 那是把「没扫成」冒充成「没有图」。 */
  const reported = session.byFrame.size;
  const noReply = !session.blocked && reported === 0;
  const failed = !session.blocked && !noReply && !list.length && !!firstError;

  return {
    ok: !session.blocked && !noReply && !failed,
    // 站点在用户的排除列表里：这不是「扫描失败」，是「按你的设置没扫」。
    // 单独一个字段，图库才能给出对得上的说法而不是一句笼统的错误。
    blocked: !!session.blocked,
    error: session.blocked ? 'blocked'
      : noReply ? scanNoReply()
        : failed ? (SCAN_ERROR_TEXT[firstError] ? t(SCAN_ERROR_TEXT[firstError]) : firstError)
          : undefined,
    images: list,
    title: session.title,
    pageUrl: session.pageUrl,
    frameCount: session.byFrame.size,
    found,          // 去重后的真实总数（截断前）
    truncated,      // 是否发生了截断
    // 背景图扫描撞上元素数上限的 frame 数（P2-3）。这些 frame 里
    // 第 BG_ELEMENT_LIMIT 个元素之后的 CSS 背景图没被扫到。
    bgTruncatedFrames,
    bgTruncatedElements,
    // 原图还原撞上时间预算：靠后的图片仍是页面上的版本，不是原图
    restoreTruncated,
    // 深度嗅探撞上轮数 / 时间预算：页面里很可能还有没采到的图片
    deepTruncated
  };
}

/* 内容脚本自报的错误码 → 文案键（取词在 finalizeScan 里做，见那儿）。
   存**键**不存句子：文案跟着界面语言走，句子是在用时才定的。 */
const SCAN_ERROR_TEXT = {
  /* 现在的版本不会再回 busy（忙的时候内容脚本自己排队，见 content/main.js）。
     留着是为了**扩展更新后那些还开着的老页面** —— 它们跑的是旧内容脚本，
     回一句 busy 总比把「没扫成」说成「这页没有图」好。 */
  busy: 'bg.scanBusy',
  blocked: 'bg.scanBlocked'
};

/* 一个 frame 都没回报时给用户的说法（文案见 i18n 的 bg.scanNoReply）。
   **不能**说「本页没有发现图片」—— 那是把「没问成」说成「没有图」，
   用户会以为页面上真的没图，然后去别的地方找原因。 */
function scanNoReply() {
  return t('bg.scanNoReply');
}

/** 这个地址所在的站点是否在用户的排除列表里（见设置页「站点排除列表」） */
function isBlockedUrl(url) {
  try { return U.isHostBlocked(url, Store.getSettings().blockedHosts); } catch (e) { return false; }
}

/* ====================================================================== *
 * 扫描结果缓存
 *
 * 为什么值得做：一次完整扫描要「注入内容脚本 + 全页采集 + 给每张候选发
 * 真实加载请求做原图还原」，冷加载时好几秒。而用户的典型动作是
 * 「关掉图库 → 想起来还有几张没存 → 再点开图标」，前后往往不到一分钟，
 * 页面压根没变。这时候重扫一遍纯属白等。
 *
 * 三个约束，缺一不可：
 *   1. **键要含地址**：只按 tabId 存的话，同一个标签页导航到别的页面后会
 *      拿到上一个页面的图片列表 —— 这是最坏的一种错（看起来正常，内容全错）。
 *   2. **必须能绕开**：深度嗅探和「重新嗅探」都要走真扫描，否则按钮成了摆设。
 *   3. **命中要如实说**：界面得标出「这是几分钟前的结果」，否则用户看到
 *      过期列表却以为是刚扫的。
 *
 * 存 storage.session 而不是内存：MV3 的 SW 随时会被回收，
 * 而「关掉图库、过一会儿再打开」正是 SW 最可能已经被回收的场景 ——
 * 只放内存里的话，缓存会在最需要它的时候刚好失效。
 * ====================================================================== */

const SCAN_CACHE_KEY = 'ih_scan_cache';
const SCAN_CACHE_TTL = 5 * 60 * 1000;
/** 最多留几份（每份最多 2000 张图，storage.session 有配额，不能无限涨） */
const SCAN_CACHE_MAX = 12;

let scanCache = null;          // { 'tabId|url': { at, result } }
let scanCacheReady = null;     // 首次读取的 Promise

function scanCacheKey(tabId, url) { return String(tabId) + '|' + (url || ''); }

function loadScanCache() {
  if (scanCache) return Promise.resolve(scanCache);
  if (!scanCacheReady) {
    scanCacheReady = (async () => {
      let obj = null;
      try { obj = await chrome.storage.session.get(SCAN_CACHE_KEY); } catch (e) { obj = null; }
      scanCache = (obj && obj[SCAN_CACHE_KEY]) || {};
      return scanCache;
    })();
  }
  return scanCacheReady;
}

function persistScanCache() {
  try {
    const p = chrome.storage.session.set({ [SCAN_CACHE_KEY]: scanCache || {} });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* session 存储不可用时忽略：缓存丢了只是慢一点，不影响正确性 */ }
}

function pruneScanCache() {
  if (!scanCache) return;
  const now = Date.now();
  for (const k of Object.keys(scanCache)) {
    const e = scanCache[k];
    if (!e || typeof e.at !== 'number' || now - e.at > SCAN_CACHE_TTL) delete scanCache[k];
  }
  const rest = Object.keys(scanCache).sort((a, b) => scanCache[b].at - scanCache[a].at);
  for (let i = SCAN_CACHE_MAX; i < rest.length; i++) delete scanCache[rest[i]];
}

async function getCachedScan(tabId, url) {
  if (!url) return null;               // 拿不到地址就不敢用缓存（可能是刚导航/查询失败）
  const cache = await loadScanCache();
  const k = scanCacheKey(tabId, url);
  const e = cache[k];
  if (!e) return null;
  if (Date.now() - e.at > SCAN_CACHE_TTL) {
    delete cache[k];
    persistScanCache();
    return null;
  }
  return e;
}

function putCachedScan(tabId, url, result) {
  if (!url || !result) return;
  if (!scanCache) scanCache = {};
  scanCache[scanCacheKey(tabId, url)] = { at: Date.now(), result };
  pruneScanCache();
  persistScanCache();
}

/** 某个标签页的缓存全部作废（导航 / 关闭时调用） */
async function dropCachedScan(tabId) {
  const cache = await loadScanCache();
  const pre = String(tabId) + '|';
  let hit = false;
  for (const k of Object.keys(cache)) {
    if (k.indexOf(pre) === 0) { delete cache[k]; hit = true; }
  }
  if (hit) persistScanCache();
}

/**
 * 清空全部缓存。设置一变就得清 —— 扫描来源（是否扫背景图 / srcset / preload…）
 * 和还原规则都会影响结果，留着旧的就是在拿按旧设置扫的列表冒充新设置的结果。
 */
async function clearScanCache() {
  const cache = await loadScanCache();
  if (!Object.keys(cache).length) return;
  scanCache = {};
  persistScanCache();
}

const PREVIEW_DNR_BASE = 2000;
const PREVIEW_DNR_MAX = 80;
const previewRefererHosts = new Map();

/**
 * 为图库/灯箱（扩展页）预览图片挂载会话级 Referer 规则。
 * 严格限定 initiatorDomains = [chrome.runtime.id] 与 resourceTypes = ['image']，
 * 不影响任何普通网页请求。
 */
async function ensurePreviewRefererRules(images, pageUrl) {
  const dnr = typeof chrome !== 'undefined' && chrome.declarativeNetRequest;
  if (!dnr || typeof dnr.updateSessionRules !== 'function') return;
  if (!Array.isArray(images) || !images.length) return;
  const extId = typeof chrome.runtime !== 'undefined' && chrome.runtime.id;
  if (!extId) return;

  let changed = false;
  for (const im of images) {
    if (!im || !U.isHttpUrl(im.url)) continue;
    const pUrl = im.pageUrl || pageUrl;
    if (!U.isHttpUrl(pUrl)) continue;
    try {
      const imgHost = new URL(im.url).hostname;
      const refOrigin = new URL(pUrl).origin + '/';
      if (!imgHost || previewRefererHosts.get(imgHost) === refOrigin) continue;
      if (previewRefererHosts.has(imgHost)) previewRefererHosts.delete(imgHost);
      previewRefererHosts.set(imgHost, refOrigin);
      while (previewRefererHosts.size > PREVIEW_DNR_MAX) {
        const oldest = previewRefererHosts.keys().next().value;
        if (oldest === undefined) break;
        previewRefererHosts.delete(oldest);
      }
      changed = true;
    } catch (e) { /* ignore */ }
  }
  if (!changed) return;

  const removeRuleIds = [];
  for (let i = 0; i < PREVIEW_DNR_MAX; i++) removeRuleIds.push(PREVIEW_DNR_BASE + i);
  const addRules = [];
  let idx = 0;
  for (const [imgHost, refOrigin] of previewRefererHosts.entries()) {
    addRules.push({
      id: PREVIEW_DNR_BASE + idx++,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Referer', operation: 'set', value: refOrigin }]
      },
      condition: {
        requestDomains: [imgHost],
        initiatorDomains: [extId],
        resourceTypes: ['image']
      }
    });
  }
  try {
    await dnr.updateSessionRules({ removeRuleIds, addRules });
  } catch (e) { /* ignore */ }
}

function scanTab(tabId, opts) {
  const reqId = U.uid();
  const deep = !!(opts && opts.deep);

  return new Promise((resolve) => {
    const session = {
      // frameId -> { images, title, pageUrl, bgTruncated, bgElements }
      // 按 frame 分开存，是因为同一 frame 会先报 partial 再报 final，
      // final 必须能整体覆盖掉自己那一份 partial，而不是和它混在一起。
      byFrame: new Map(),
      // 已报 partial、还没报 final 的 frame
      pending: new Set(),
      deep,
      title: '',
      pageUrl: '',
      quietTimer: null,
      hardTimer: null,
      settled: false,
      // 站点在排除列表里：不去注入、不去问，直接如实回一个 blocked 结果
      blocked: false,
      // 「先出图、后升级」：调用方想提前拿到第一版中间结果就传 onPartial，
      // partialSent 保证它只被调一次
      onPartial: (opts && opts.onPartial) || null,
      partialSent: false
    };

    /* 兑现给调用方。**永远兑现的是最终结果** —— 这样 scanTab 的契约没变，
       直接 await 它的调用方（测试、以后可能有的其他入口）拿到的还是完整的原图列表。
       「先出图」那一步走的是另一条路：第一版中间结果一到就调 opts.onPartial，
       由**消息边界**（MSG.SCAN_TAB 的 handler）决定要不要提前兑现响应。 */
    session.finish = () => {
      if (session.settled) return;
      session.settled = true;
      scanSessions.delete(reqId);
      clearTimeout(session.quietTimer);
      clearTimeout(session.hardTimer);
      resolve(Object.assign({ reqId, tabId }, finalizeScan(session)));
    };

    scanSessions.set(reqId, session);

    // 兜底：内容脚本始终没有动静时，4 秒内返回。
    //
    // 这里**不能**用「没收到结果」来推断「扫描失败」——原图还原要给每张候选
    // 发一次真实加载请求，冷加载时远超 4 秒，而此时扫描其实是正常进行的。
    // 旧的 1.5 秒「无响应即收尾」判据正是这样，把「还在还原」误判成「本页没有图片」。
    //
    // 4 秒只覆盖「内容脚本根本没接上话」这一段（注入 + 投递）。一旦它接下请求
    // （见下面 ack 那一处），计时就换成加工阶段的量级 —— 否则「首次点开图标
    // 嗅探不出来、刷新一次反而好了」这个 bug 会换个马甲回来。
    session.hardTimer = setTimeout(session.finish, SCAN_IDLE_TIMEOUT);

    (async () => {
      /* 站点排除列表：被排除的站点连「注入 + 问一遍」都不做，直接收尾。
         图库据此说「此站点已在排除列表中」，而不是说「本页没有发现图片」——
         后者是在撒谎，用户明明看得见一页的图，却不知道是自己排除过这个站。
         （chrome.tabs.get 失败时按「没被排除」处理，别让一次查询异常把扫描也带崩。） */
      let info = null;
      try { info = await chrome.tabs.get(tabId); } catch (e) { info = null; }
      if (info && isBlockedUrl(info.url)) {
        session.blocked = true;
        session.pageUrl = info.url || '';
        session.title = info.title || '';
        session.finish();
        return;
      }

      const injected = await ensureInjected(tabId);
      if (!injected) { session.finish(); return; }

      try {
        const ack = await chrome.tabs.sendMessage(tabId, { type: MSG.DO_SCAN, reqId, deep });

        /* 内容脚本收下了这次请求（消息 handler 里同步 sendResponse 确认）。
           从这一刻起，「没动静」不再意味着「内容脚本不在」—— 它在跑，只是还没跑完：
           补尺寸要真实加载图片，页面自己还没加载的那些（懒加载、首屏之外）只能等网络。

           所以把兜底超时换成加工阶段的量级。不这么做的话，4 秒一到就 session.finish()，
           而这一轮**一个 frame 都还没回报**，结果是 ok:true + 空列表 ——
           图库会说「本页没有发现图片」。实测：真实站点上十几张没加载的图就足够
           把首次回报推迟到 4 秒以上，于是「首次点开图标看不到图，刷新一次反而好了」
           （第二次探测结果已在内容脚本的缓存里，回报是毫秒级的）。

           只在「还没收到 partial」时换计时：收到 partial 时 onScanResult 已经
           把计时调成了同一档，这里再设一遍是多余的（而且会把深度的档位覆盖掉）。 */
        if (ack && !session.settled && session.pending.size === 0) {
          clearTimeout(session.hardTimer);
          session.hardTimer = setTimeout(session.finish,
            session.deep ? SCAN_DEEP_TIMEOUT : SCAN_RESTORE_TIMEOUT);
        }
      } catch (e) {
        session.finish();
      }
    })();
  });
}

function onScanResult(msg, sender) {
  const session = scanSessions.get(msg.reqId);
  if (!session) return;

  const frameId = (sender && sender.frameId) || 0;
  const images = (Array.isArray(msg.images) ? msg.images : []).filter((i) => i && i.url);
  for (const img of images) img.frameId = frameId;

  let rec = session.byFrame.get(frameId);
  if (!rec) {
    rec = {
      images: [], title: '', pageUrl: '',
      bgTruncated: false, bgElements: 0, restoreTruncated: false, deepTruncated: false,
      error: null
    };
    session.byFrame.set(frameId, rec);
  }
  // 同一 frame 的后一版结果整体覆盖前一版（partial → final）
  rec.images = images;
  rec.restoreTruncated = !!msg.restoreTruncated;
  rec.deepTruncated = !!msg.deepTruncated;
  /* 内容脚本自己报的错（busy / 扫描过程中抛异常）。
     以前这里把 msg.error 直接丢掉，于是一次「忙」、一次异常都被记成
     「这一帧有 0 张图」，最后汇总成「本页没有发现图片」——
     又一次「没扫成」冒充「没有图」。拿到图的时候错误码没有意义，只留没图的那些。 */
  rec.error = images.length ? null : (msg.error || null);
  if (msg.title) rec.title = msg.title;
  if (frameId === 0) {
    session.title = msg.title || session.title;
    session.pageUrl = msg.pageUrl || session.pageUrl;
  }
  if (msg.bgTruncated) {
    rec.bgTruncated = true;
    rec.bgElements = Math.max(rec.bgElements, msg.bgElements || 0);
  }

  // 没有 phase 字段的老消息（例如 busy 空结果）一律按 final 处理
  const isPartial = msg.phase === C.SCAN_PHASE.PARTIAL;

  if (isPartial) {
    // 内容脚本明说了「还原还在跑」：不启动安静期倒计时（否则还原没跑完就被判定成收尾），
    // 并把兜底超时放宽到还原阶段的量级。
    session.pending.add(frameId);
    clearTimeout(session.quietTimer);
    clearTimeout(session.hardTimer);
    session.hardTimer = setTimeout(session.finish,
      session.deep ? SCAN_DEEP_TIMEOUT : SCAN_RESTORE_TIMEOUT);

    /* 先出图：把第一版中间结果交给调用方（如果它关心）。
       冷还原最长 8 秒，这 8 秒原来是用户盯着 spinner 白等的时间。
       session 继续留着收 final —— 到了再让图库原地升级。
       只调第一次：后续帧的 partial 对「先出图」没有增量价值。 */
    if (session.onPartial && !session.partialSent) {
      session.partialSent = true;
      try {
        session.onPartial(Object.assign(
          { phase: C.SCAN_PHASE.PARTIAL, reqId: msg.reqId, tabId: (sender && sender.tab && sender.tab.id) },
          finalizeScan(session)
        ));
      } catch (e) { /* 调用方自己抛错不该拖垮扫描 */ }
    }
    return;
  }

  session.pending.delete(frameId);
  clearTimeout(session.quietTimer);
  // 所有 frame 都交了最终结果后，安静 450ms 再收尾
  if (session.pending.size === 0) {
    session.quietTimer = setTimeout(() => session.finish(), 450);
  }
}
