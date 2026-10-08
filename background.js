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

importScripts('shared/constants.js', 'shared/utils.js', 'shared/store.js', 'shared/i18n.js');

const IH = globalThis.IH;
const C = IH.C;
const U = IH.U;
const Store = IH.Store;
const MSG = C.MSG;
/* 后台没有界面，但它返回的 error / reason 会被悬停气泡、图库提示和下载历史
   原样显示给用户 —— 所以这些句子同样跟着界面语言走。
   语言取自设置里的 uiLang（'auto' 时退到 navigator.language，SW 里也有）。 */
const t = (k, a) => IH.I18n.t(k, a);

/* ====================================================================== *
 * 全局状态
 * ====================================================================== */

let queue = [];                  // 待下载任务
let activeCount = 0;
let pumping = false;
let job = null;                  // 当前批次 { batchId, total, done, failed, skipped, status, ... }
const recentLog = [];            // 最近若干条下载结果（用于进度面板）
let jobRestoreCount = 0;

const pendingDownloads = new Map();   // downloadId -> { resolve, reject, timer }
const scanSessions = new Map();       // reqId -> session

const SESSION_KEY = 'ih_job';

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

/** 体积探测的累计成败（用户点「探测体积」时累加，用于区分「站点不支持 HEAD」和「扩展坏了」） */
const probeStats = { ok: 0, failed: 0, lastAt: null };

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
 * 通用
 * ====================================================================== */

function broadcast(message) {
  try {
    const p = chrome.runtime.sendMessage(message);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* 没有接收方时忽略 */ }
}

function downloadPath(name) {
  let n = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = n.split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => U.sanitizeFilename(s));
  n = segs.join('/');
  if (!n) n = 'image_' + Date.now() + '.jpg';
  return n;
}

/** 从绝对路径里取文件名（chrome.downloads 返回的是完整路径） */
function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 取「相对下载目录的目录部分」（开了子目录才有内容），没有目录时返回 '' */
function dirName(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * 取下载项的真实体积。
 * 注意：chrome.downloads.DownloadItem 上【没有】bytes 字段，
 * 只有 fileSize / bytesReceived / totalBytes —— 之前误用 info.bytes，
 * 导致历史记录和统计里的体积永远是 0。
 */
function itemBytes(item) {
  if (!item) return 0;
  return item.fileSize || item.bytesReceived || item.totalBytes || 0;
}

async function settings() {
  return await Store.loadSettings();
}

/* ====================================================================== *
 * 下载等待
 * ====================================================================== */

function settleDownload(id, item) {
  const rec = pendingDownloads.get(id);
  if (!rec) return;
  pendingDownloads.delete(id);
  clearTimeout(rec.timer);
  rec.resolve(item || {});
}

function failDownload(id, error) {
  const rec = pendingDownloads.get(id);
  if (!rec) return;
  pendingDownloads.delete(id);
  clearTimeout(rec.timer);
  rec.reject(error);
}

function waitForDownload(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDownloads.delete(id);
      reject(new Error(t('bg.downloadTimeout')));
    }, timeoutMs || 180000);

    pendingDownloads.set(id, { resolve, reject, timer });

    // 可能已经完成（快速下载 / SW 重启后）
    chrome.downloads.search({ id }).then((items) => {
      const item = items && items[0];
      if (!item) return;
      if (item.state === 'complete') settleDownload(id, item);
      else if (item.state === 'interrupted') failDownload(id, new Error(item.error || t('bg.downloadInterrupted')));
    }).catch(() => {});
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingDownloads.has(delta.id)) return;
  if (!delta.state) return;
  if (delta.state.current === 'complete') {
    chrome.downloads.search({ id: delta.id })
      .then((items) => settleDownload(delta.id, items && items[0]))
      .catch(() => settleDownload(delta.id, null));
  } else if (delta.state.current === 'interrupted') {
    failDownload(delta.id, new Error((delta.error && delta.error.current) || t('bg.downloadInterrupted')));
  }
});

/* ====================================================================== *
 * 单张下载（含 403 降级）
 * ====================================================================== */

async function downloadOne(task) {
  const s = await settings();
  const requested = downloadPath(task.filename);

  try {
    const id = await chrome.downloads.download({
      url: task.url,
      filename: requested,
      conflictAction: 'uniquify',
      saveAs: false
    });
    const info = await waitForDownload(id, task.interactive ? 60000 : 180000);
    return describeSaved(info, requested);
  } catch (err) {
    if (!s.fetchFallback) throw err;
    if (U.isDataUrl(task.url) || U.isBlobUrl(task.url)) throw err;
    return await downloadViaFetch(task, requested);
  }
}

/**
 * 汇总一次真实落盘的结果。
 *
 * 关键点：Chrome 会按响应的真实 MIME 纠正扩展名 —— 例如 CDN 把 .jpg 转码成
 * AVIF 时，请求的文件名是 xxx.jpg，最终落盘却是 xxx.avif。
 * 必须把「实际文件名」如实回传，否则用户按提示的名字去下载目录里找会找不到。
 */
function describeSaved(info, requested) {
  const actual = baseName(info && info.filename) || requested;
  const wantBase = baseName(requested) || requested;
  return {
    filename: actual,
    requested,
    path: (info && info.filename) || '',
    bytes: itemBytes(info),
    /* 比较**文件名**而不是整个相对路径。
       开了「保存到子目录」之后 requested 形如 `站点/照片.jpg`，而 actual
       只有 `照片.jpg` —— 拿整串比会让每一次带子目录的下载都谎报
       「被浏览器改了扩展名」，气泡上凭空多出一句「（实际为 照片.jpg）」。 */
    renamed: actual !== wantBase
  };
}

/**
 * 降级方案：在扩展页里 fetch 图片（不受页面 CORS 限制），
 * 拿到 blob 后用 blob URL / dataURL 交给下载 API —— 可绕过缺少 Referer 导致的 403
 */
async function downloadViaFetch(task, filename) {
  const opts = { credentials: 'include', cache: 'no-store' };
  if (task.pageUrl) {
    try {
      opts.referrer = task.pageUrl;
      opts.referrerPolicy = 'strict-origin-when-cross-origin';
    } catch (e) { /* 忽略 */ }
  }

  const res = await U.fetchWithTimeout(task.url, opts, 30000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  if (!blob.size) throw new Error(t('bg.emptyBody'));

  let objectUrl = null;
  let downloadable;
  if (typeof URL.createObjectURL === 'function') {
    objectUrl = URL.createObjectURL(blob);
    downloadable = objectUrl;
  } else {
    downloadable = await U.blobToDataUrl(blob);
  }

  try {
    const id = await chrome.downloads.download({
      url: downloadable,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
    const info = await waitForDownload(id);
    const described = describeSaved(info, filename);
    if (!described.bytes) described.bytes = blob.size;
    return described;
  } finally {
    if (objectUrl) {
      setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ } }, 60000);
    }
  }
}

/* ====================================================================== *
 * 队列调度
 * ====================================================================== */

function pushRecent(entry) {
  /* 补一个时间戳：进度面板用不到它，但诊断包需要 ——
     没有 ts 的话「最近 12 条下载记录」就只是一堆无始无终的行。 */
  if (entry && typeof entry.ts !== 'number') entry.ts = Date.now();
  recentLog.unshift(entry);
  if (recentLog.length > 30) recentLog.length = 30;
}

/**
 * 通知等待方：这个任务真正结束了（成功 / 失败 / 跳过）。
 * 悬停图标依赖它拿到真实结果，而不是「已入队」的假成功。
 */
function finishTask(task, result) {
  const resolve = task && task._resolve;
  if (!resolve) return;
  task._resolve = null;
  try { resolve(result); } catch (e) { /* 忽略 */ }
}

function progressPayload() {
  if (!job) {
    return { batchId: null, status: 'idle', total: 0, done: 0, failed: 0, skipped: 0, remaining: 0, active: 0, recent: [] };
  }
  return {
    batchId: job.batchId,
    status: job.status,
    total: job.total,
    done: job.done,
    failed: job.failed,
    skipped: job.skipped,
    remaining: queue.length,
    active: activeCount,
    recent: recentLog.slice(0, 12)
  };
}

function broadcastProgress() {
  broadcast({ type: MSG.PROGRESS, payload: progressPayload() });
  persistJob();
}

async function persistJob() {
  try {
    if (!job || job.status !== 'running') {
      await chrome.storage.session.remove(SESSION_KEY);
      return;
    }
    await chrome.storage.session.set({
      [SESSION_KEY]: {
        batchId: job.batchId,
        total: job.total,
        done: job.done,
        failed: job.failed,
        skipped: job.skipped,
        status: job.status,
        restores: jobRestoreCount,
        pending: queue.map((t) => ({
          url: t.url,
          pageUrl: t.pageUrl,
          filename: t.filename,
          width: t.width,
          height: t.height,
          index: t.index
        }))
      }
    });
  } catch (e) { /* session 存储不可用时忽略 */ }
}

async function worker() {
  while (queue.length) {
    const task = queue.shift();
    if (!task) break;
    activeCount++;
    broadcastProgress();
    try {
      await runTask(task);
    } catch (e) {
      job.failed++;
      const msg = String((e && e.message) || e);
      pushRecent({ index: task.index, url: task.url, status: 'failed', error: msg });
      finishTask(task, { ok: false, url: task.url, error: msg });
    }
    activeCount--;
    broadcastProgress();
  }
}

async function pump() {
  if (pumping) return;
  if (!queue.length) return;
  pumping = true;
  try {
    const s = await settings();
    const max = U.clamp(s.concurrency || 3, 1, 10);
    const workers = [];
    for (let i = 0; i < max; i++) workers.push(worker());
    await Promise.all(workers);
    if (job && job.status === 'running' && !queue.length) {
      job.status = 'done';
      job.finishedAt = Date.now();
    }
    broadcastProgress();
    broadcast({ type: MSG.PROGRESS, payload: progressPayload() });
    await persistJob();
  } finally {
    pumping = false;
    // 竞态兜底：worker 刚判断队列为空、pumping 还没复位时又入队了新任务，
    // 这些新任务不会被任何 worker 消费 —— 必须再泵一次。
    if (queue.length && job && job.status === 'running') {
      pump().catch(() => {});
    }
  }
}

async function runTask(task) {
  const s = await settings();
  const fp = await U.sha256hex(task.url + '|' + (task.width || 0) + 'x' + (task.height || 0));

  // 跳过已下载
  if (s.skipDownloaded) {
    const exists = await Store.hasFingerprint(fp);
    if (exists) {
      task.status = 'skipped';
      job.skipped++;
      pushRecent({ index: task.index, url: task.url, status: 'skipped' });
      broadcastProgress();
      // 跳过 ≠ 保存成功，必须如实告知，否则用户会以为文件已经存下来了
      finishTask(task, { ok: true, skipped: true, url: task.url, reason: t('bg.skippedAlready') });
      return;
    }
  }

  const maxAttempts = U.clamp((s.retries || 0) + 1, 1, 6);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    task.attempts = attempt + 1;
    try {
      const result = await downloadOne(task);
      task.status = 'done';
      task.bytes = result.bytes || 0;
      task.filename = result.filename || task.filename;   // 以实际落盘文件名为准
      /* 历史里存**相对下载目录的完整路径**（含子目录），而不是只有文件名 ——
         开了「保存到子目录」之后，只写 `0.png` 的话用户拿着历史记录
         根本找不到文件在哪一层目录里。没开子目录时两者完全相同。 */
      task.relPath = result.requested || result.filename || task.filename;
      job.done++;
      pushRecent({
        index: task.index,
        url: task.url,
        filename: task.filename,
        status: 'done',
        bytes: result.bytes || 0
      });
      await Store.addFingerprints([fp]);
      await Store.bumpStats({ saved: 1, bytes: result.bytes || 0 });
      await Store.addHistory({
        ts: Date.now(),
        url: task.url,
        pageUrl: task.pageUrl,
        filename: task.relPath,
        width: task.width || 0,
        height: task.height || 0,
        bytes: result.bytes || 0,
        status: 'done'
      });
      broadcastProgress();
      finishTask(task, {
        ok: true,
        url: task.url,
        filename: task.filename,
        // 开了子目录时告诉界面存到哪一层，否则用户只知道文件名、不知道去哪找
        folder: dirName(task.relPath),
        path: result.path || '',
        bytes: result.bytes || 0,
        renamed: !!result.renamed,
        restored: !!task.restored
      });
      return;
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts - 1) await U.sleep(350 * (attempt + 1));
    }
  }

  task.status = 'failed';
  task.error = String((lastError && lastError.message) || lastError || t('bg.unknownError'));
  job.failed++;
  pushRecent({ index: task.index, url: task.url, status: 'failed', error: task.error });
  await Store.bumpStats({ failed: 1 });
  await Store.addHistory({
    ts: Date.now(),
    url: task.url,
    pageUrl: task.pageUrl,
    filename: task.filename,
    width: task.width || 0,
    height: task.height || 0,
    status: 'failed',
    error: task.error
  });
  broadcastProgress();
  finishTask(task, { ok: false, url: task.url, error: task.error });
}

/* ====================================================================== *
 * 批量入口
 * ====================================================================== */

async function startBatch(items, options) {
  if (!items || !items.length) return { ok: false, error: t('bg.noImages') };

  const s = await settings();
  const opts = options || {};

  /*
   * 先确定批次，再分配序号。
   *
   * 序号语义是「**本批次内**第几张」，所以必须等新批次建立之后才开始计数。
   * 原来的写法 `const baseIndex = job ? job.total : 0;` 在批次建立**之前**取值，
   * 取到的是上一批的 total —— 于是第二批从 003 开始（实测），
   * 而且 job.total 并非单调（cancelBatch 会把它改小、批次运行中的单张下载会 +1），
   * 序号完全不可预测。
   */
  const startingNewBatch = !job || job.status !== 'running';
  if (startingNewBatch) {
    job = {
      batchId: U.uid(),
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      status: 'running',
      startedAt: Date.now()
    };
    recentLog.length = 0;
    jobRestoreCount = 0;
  }

  // 新批次从 1 开始；追加到运行中的批次则接着当前批次的序号往下排
  const baseIndex = startingNewBatch ? 0 : job.total;

  const tasks = items.map((it, i) => {
    const t = {
      url: it.url,
      pageUrl: it.pageUrl || '',
      filename: it.filename || U.buildFilename(it, s, baseIndex + i + 1),
      width: it.width || 0,
      height: it.height || 0,
      restored: !!it.restored,
      index: baseIndex + i + 1,
      attempts: 0,
      status: 'pending',
      _resolve: null
    };
    // 只有需要「等真实结果」的调用（悬停单张下载）才挂等待器
    if (opts.awaitCompletion) {
      t.interactive = true;   // 交互式下载：用户正盯着图标转圈，超时要短一些
      t.done = new Promise((resolve) => { t._resolve = resolve; });
    }
    return t;
  });

  job.total += tasks.length;

  queue.push(...tasks);
  broadcastProgress();
  pump().catch(() => {});

  // 单张下载（悬停图标 / 右键菜单）必须等真实结果再回应。
  // 之前这里直接 return { ok:true }，导致「提示已保存」只是「已入队」，
  // 下载失败或被跳过时用户依然看到成功提示 —— 这正是「提示已保存却没存下来」的根因。
  if (opts.awaitCompletion) {
    const results = await Promise.all(tasks.map((t) => t.done));
    return results.length === 1 ? results[0] : { ok: true, results };
  }

  return { ok: true, batchId: job.batchId, total: tasks.length };
}

/**
 * 停止批量下载。
 *
 * 只能清掉**还没开始**的队列，已经在飞的那 active 个请求没法中断
 * （chrome.downloads 一旦开始落盘就没有安全的撤回手段，强行 cancel 会留下半个文件）。
 * 所以返回值里把 active 一并带上，让界面能如实说明「这几张还会下完」——
 * 光说「已停止」而后面又冒出几个文件，比不说更让人困惑（AUDIT P2-5）。
 */
function cancelBatch() {
  const dropped = queue.length;
  const active = activeCount;
  queue = [];
  if (job && job.status === 'running') {
    job.status = 'cancelled';
    // 已经在飞的这几张会照常落盘，所以总数要把它们算进去，
    // 否则进度条会出现「完成数 > 总数」
    job.total = job.done + job.failed + job.skipped + active;
  }
  broadcastProgress();
  return { ok: true, dropped, active };
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
    }  }
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

/** 内容脚本完全没有动静时，等多久就放弃（秒级，用户还在盯着加载动画） */
const SCAN_IDLE_TIMEOUT = 4000;
/** 已经收到 partial、正在等原图还原时，最多再等多久 */
const SCAN_RESTORE_TIMEOUT = 15000;
/** 深度嗅探：要滚动整页，光滚动就可能十几秒，还原还得再算 */
const SCAN_DEEP_TIMEOUT = 45000;

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

/* ====================================================================== *
 * 体积探测
 * ====================================================================== */

async function probeRemoteSize(url) {
  if (!url || U.isDataUrl(url)) return null;

  try {
    const res = await U.fetchWithTimeout(url, { method: 'HEAD', credentials: 'include', cache: 'no-store' }, 7000);
    if (res.ok) {
      const len = res.headers.get('content-length');
      const type = res.headers.get('content-type') || '';
      if (len) return { bytes: parseInt(len, 10) || 0, type };
    }
  } catch (e) { /* HEAD 不被支持时继续 */ }

  try {
    const res = await U.fetchWithTimeout(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      cache: 'no-store'
    }, 7000);
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) return { bytes: parseInt(m[1], 10) || 0, type: res.headers.get('content-type') || '' };
    }
    const len = res.headers.get('content-length');
    if (len && res.status !== 206) return { bytes: parseInt(len, 10) || 0, type: res.headers.get('content-type') || '' };
  } catch (e) { /* ignore */ }

  return null;
}

async function probeMany(urls) {
  const limiter = U.createLimiter(4);
  const out = {};
  // 上限与弹窗的分批大小共用同一个常量：调用方按 C.PROBE_LIMIT 分批，
  // 这里再截一次只是防御，正常不会真的截掉东西（AUDIT P1-5）
  await Promise.all((urls || []).slice(0, C.PROBE_LIMIT).map((u) => limiter(async () => {
    const r = await probeRemoteSize(u);
    out[u] = r;
    /* 累计成败。这个计数是给诊断包用的：用户说「体积探测不出来」时，
       ok=0 / failed=12 是「这些站点都不给 HEAD，正常」，
       ok=0 / failed=0 才是「扩展根本没跑到这里」—— 两者界面表现一样。 */
    if (r) probeStats.ok++; else probeStats.failed++;
    probeStats.lastAt = Date.now();
  })));
  return out;
}

/* ====================================================================== *
 * 页内面板的来源校验 token（AUDIT P3-7）
 *
 * 面板 = 「网页里的 iframe 加载扩展页 popup.html?mode=panel&tabId=N」。
 * popup/* 必须在 web_accessible_resources 里（否则 iframe 加载不了），
 * 于是**任何网站都能构造同款 iframe**，把图库叠在自己页面上做套壳点击，
 * 或者靠「能不能加载这个资源」探测用户装没装本扩展。
 *
 * 校验办法：内容脚本向后台领一个只属于本标签页的随机 token，写进 iframe 的 URL；
 * 面板启动时拿 URL 里的 tabId + token 回后台核验。
 * 网页自己没法给后台发消息（不是扩展上下文），拿不到 token，也就伪造不出合法 URL。
 *
 * token 存在 storage.session 而不是内存里：MV3 的 SW 会被回收，
 * 内存 Map 一丢，已经打开的面板刷新一次就废了。
 * ====================================================================== */

const PANEL_TOKEN_KEY = 'ih_panel_tokens';

async function panelTokens() {
  try {
    const got = await chrome.storage.session.get(PANEL_TOKEN_KEY);
    return (got && got[PANEL_TOKEN_KEY]) || {};
  } catch (e) { return {}; }
}

/** 给标签页发（或复用）一个 token。同一个标签页重复打开面板会拿到同一个值。 */
async function issuePanelToken(tabId) {
  const store = await panelTokens();
  if (store[tabId]) return store[tabId];

  const token = U.uid() + U.uid() + U.uid();
  store[tabId] = token;
  try { await chrome.storage.session.set({ [PANEL_TOKEN_KEY]: store }); } catch (e) { /* 忽略 */ }
  return token;
}

async function verifyPanelToken(tabId, token) {
  if (tabId == null || !token) return false;
  const store = await panelTokens();
  return !!store[tabId] && store[tabId] === token;
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
            : (p) => answer(Object.assign({ phase: C.SCAN_PHASE.PARTIAL }, p))
        }).then((final) => {
          /* 只缓存**最终**结果：partial 里还全是页面上的缩略图地址，存下来等于
             把「没还原」的状态固化 5 分钟。也只在真的扫成功时缓存 ——
             blocked / 出错都该下次重新判断，不能留下痕迹。 */
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
          if (p.pageUrl) {
            try { opts.referrer = p.pageUrl; opts.referrerPolicy = 'strict-origin-when-cross-origin'; } catch (e) { /* ignore */ }
          }
          const res = await U.fetchWithTimeout(p.url, opts, 20000);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          if (blob.size > 16 * 1024 * 1024) throw new Error(t('bg.imageTooBig'));
          const dataUrl = await U.blobToDataUrl(blob);
          sendResponse({ ok: true, dataUrl, size: blob.size, mime: blob.type });
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
      // 只发给真正的内容脚本：sender.tab 是消息来源标签页，网页伪造不了
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (tabId == null) { sendResponse({ ok: false, error: '不是来自标签页的请求' }); return true; }
      issuePanelToken(tabId).then(
        (token) => sendResponse({ ok: true, token }),
        () => sendResponse({ ok: false })
      );
      return true;
    }

    case MSG.PANEL_VERIFY: {
      const p = msg.payload || {};
      verifyPanelToken(p.tabId, p.token).then(
        (valid) => sendResponse({ ok: true, valid }),
        () => sendResponse({ ok: false, valid: false })
      );
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

async function restoreJob() {
  try {
    const obj = await chrome.storage.session.get(SESSION_KEY);
    const saved = obj && obj[SESSION_KEY];
    if (!saved || saved.status !== 'running' || !saved.pending || !saved.pending.length) return;

    // 避免反复恢复造成死循环
    if ((saved.restores || 0) >= 3) {
      await chrome.storage.session.remove(SESSION_KEY);
      return;
    }
    jobRestoreCount = (saved.restores || 0) + 1;

    job = {
      batchId: saved.batchId,
      total: saved.total,
      done: saved.done || 0,
      failed: saved.failed || 0,
      skipped: saved.skipped || 0,
      status: 'running',
      restored: true
    };
    queue = saved.pending.map((t) => Object.assign({ attempts: 0, status: 'pending' }, t));
    console.log('[ImageHunter] 恢复未完成的下载队列：', queue.length, '项');
    broadcastProgress();
    pump();
  } catch (e) { /* ignore */ }
}
