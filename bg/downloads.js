/* ==========================================================================
 * ImageHunter — bg/downloads.js
 * 下载队列、403 Fetch 降级（响应体上限）、以及 MV3 SW 重启后的任务对账恢复
 * 由 background.js 通过 importScripts 加载，共享同一个 SW 全局作用域。
 * ========================================================================== */

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
    /* 拿到 id 立刻记下来并落盘：这是重启后唯一能问「这张下完了吗」的凭据。
       晚一步（比如等 waitForDownload 之后）记，SW 恰好在那之间被回收，
       这个 id 就永久丢了 —— 那张图既没进 done，也不会重下。 */
    task.downloadId = id;
    await persistJob();
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

/* 一张图最多收多少。16MB 已经远超常见「原图」，再大多半是
   「这个 URL 其实指向视频 / 压缩包」或者服务器在灌垃圾。 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_READ_TIMEOUT = 60000;
const FETCH_IMAGE_READ_TIMEOUT = 20000;

/** 把 readBodyLimited 抛出的 code 翻成人话（否则气泡上会出现 'too-big'） */
function bodyLimitError(e) {
  const code = e && e.code;
  if (code === 'too-big') return new Error(t('bg.imageTooBig'));
  if (code === 'bad-mime') return new Error(t('bg.notAnImage'));
  if (code === 'read-timeout') return new Error(t('bg.readTimeout'));
  return e;
}

let dnrRuleSeq = 1000;

/**
 * 为扩展发起的跨域 fetch 临时挂载一条会话级 Referer 规则。
 *
 * 为什么必须走 DNR 而不是 `fetch(url, { referrer: pageUrl })`：
 * Fetch 规范禁止跨域自定义 referrer —— 扩展后台（`chrome-extension://<id>`）
 * 传入 `https://weibo.com/` 会被浏览器静默丢弃或回退为扩展源，
 * 导致微博（sinaimg.cn）等严格校验 Referer 的图床在降级 fetch 时依然 403。
 */
async function withRefererRule(targetUrl, pageUrl, fn) {
  const dnr = typeof chrome !== 'undefined' && chrome.declarativeNetRequest;
  if (!dnr || typeof dnr.updateSessionRules !== 'function' || !U.isHttpUrl(targetUrl) || !U.isHttpUrl(pageUrl)) {
    return await fn();
  }
  let refOrigin = '';
  try { refOrigin = new URL(pageUrl).origin + '/'; } catch (e) { refOrigin = ''; }
  if (!refOrigin) return await fn();

  const ruleId = dnrRuleSeq++;
  if (dnrRuleSeq > 999999) dnrRuleSeq = 1000;

  let host = '';
  try { host = new URL(targetUrl).hostname; } catch (e) { host = ''; }
  const condition = {
    urlFilter: targetUrl.split('#')[0],
    resourceTypes: ['xmlhttprequest', 'other', 'image']
  };
  if (host) condition.requestDomains = [host];
  if (typeof chrome.runtime !== 'undefined' && chrome.runtime.id) {
    condition.initiatorDomains = [chrome.runtime.id];
  }

  let added = false;
  try {
    await dnr.updateSessionRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Referer', operation: 'set', value: refOrigin }]
        },
        condition
      }]
    });
    added = true;
  } catch (e) { /* DNR 不可用或参数被拒时退回无规则执行 */ }

  try {
    return await fn();
  } finally {
    if (added) {
      try { await dnr.updateSessionRules({ removeRuleIds: [ruleId] }); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * 降级方案：在扩展页里 fetch 图片（不受页面 CORS 限制），
 * 拿到 blob 后用 blob URL / dataURL 交给下载 API —— 可绕过缺少 Referer 导致的 403
 */
async function downloadViaFetch(task, filename) {
  const opts = { credentials: 'include', cache: 'no-store' };
  const res = await withRefererRule(task.url, task.pageUrl, () => U.fetchWithTimeout(task.url, opts, 30000));
  if (!res.ok) throw new Error('HTTP ' + res.status);

  /* 这里以前是裸的 `await res.blob()`：先吃完整个响应体，再检查大小 ——
     等于「先让内存爆掉，再问它是不是太大了」。而且 fetchWithTimeout 的
     计时器在响应头到达时就 clearTimeout 了，body 可以无限期地慢慢吐。
     换成有上限、有截止时间的读法（见 shared/utils.js 的 readBodyLimited）。 */
  let blob;
  try {
    const got = await U.readBodyLimited(res, {
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: DOWNLOAD_READ_TIMEOUT,
      allowMime: U.isImageMime
    });
    blob = got.blob;
  } catch (e) {
    throw bodyLimitError(e);
  }
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
    // 同 downloadOne：降级路径也要留下 downloadId，否则重启后对不了账
    task.downloadId = id;
    await persistJob();
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

/** 持久化时用的任务瘦身版（去掉 Promise / 闭包，session storage 只收纯数据） */
function slimTask(t) {
  return {
    url: t.url,
    pageUrl: t.pageUrl,
    filename: t.filename,
    width: t.width,
    height: t.height,
    index: t.index,
    restored: !!t.restored
  };
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
        pending: queue.map(slimTask),
        /* 在飞的这几张也要存 —— 见 activeTasks 的注释。
           downloadId 是关键：没有它就没法在重启后对账。 */
        active: activeTasks.map((t) => Object.assign(slimTask(t), {
          downloadId: t.downloadId == null ? null : t.downloadId
        })),
        settled: Array.from(settledIds).slice(-200)
      }
    });
  } catch (e) { /* session 存储不可用时忽略 */ }
}

async function worker() {
  while (queue.length) {
    const task = queue.shift();
    if (!task) break;
    activeCount++;
    activeTasks.push(task);
    broadcastProgress();
    try {
      await runTask(task);
    } catch (e) {
      job.failed++;
      const msg = String((e && e.message) || e);
      pushRecent({ index: task.index, url: task.url, status: 'failed', error: msg });
      finishTask(task, { ok: false, url: task.url, error: msg });
    } finally {
      // 无论成功失败都要移出「在飞」清单，否则重启时会去对账一个早就不存在的任务
      const at = activeTasks.indexOf(task);
      if (at >= 0) activeTasks.splice(at, 1);
      activeCount--;
    }
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
      /* 记账（指纹 / 统计 / 历史）。
         Store.rawSet 现在会抛异常（不再假装成功），但**这里必须吞掉**：
         文件已经落盘了，把一次成功的下载判成失败是更糟的谎。
         所以这个「尽力而为」的决定写在这里，而不是藏在 Store 里。 */
      try {
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
      } catch (e) {
        console.warn('[ImageHunter] 下载已落盘，但记账失败：', (e && e.message) || e);
      }
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
  try {
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
  } catch (e) {
    // 同上：失败已经发生了，记账再失败不该改变这次任务的结果
    console.warn('[ImageHunter] 失败记账没写进去：', (e && e.message) || e);
  }
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
    // 新批次重新开始记账：上一批的 downloadId 不该再拦住这一批
    settledIds = new Set();
    activeTasks = [];
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
 * SW 休眠恢复与任务对账
 * ====================================================================== */

async function restoreJob() {
  /* 重入保护：restoreJob 会被 onStartup 和 bootstrap 各调一次。
     两处同时跑会读到同一份快照，于是同一批任务被恢复两遍 ——
     done 直接翻倍，历史里出现两份。 */
  if (restoringJob) return;
  restoringJob = true;
  try {
    const obj = await chrome.storage.session.get(SESSION_KEY);
    const saved = obj && obj[SESSION_KEY];
    if (!saved || saved.status !== 'running') return;
    const pending = saved.pending || [];
    const active = saved.active || [];
    if (!pending.length && !active.length) return;

    // 避免反复恢复造成死循环
    if ((saved.restores || 0) >= 3) {
      await chrome.storage.session.remove(SESSION_KEY);
      return;
    }
    jobRestoreCount = (saved.restores || 0) + 1;
    settledIds = new Set(saved.settled || []);

    job = {
      batchId: saved.batchId,
      total: saved.total,
      done: saved.done || 0,
      failed: saved.failed || 0,
      skipped: saved.skipped || 0,
      status: 'running',
      restored: true
    };
    queue = pending.map((t) => Object.assign({ attempts: 0, status: 'pending' }, t));

    /* 对账：在飞的那几张，先问 chrome.downloads「到底怎么样了」。
       这一步就是「幂等」的全部意义 ——
         · 已经落盘的**不要再下一遍**（会多出一个重名文件）
         · 已经记过账的**不要重复计数**（历史里会冒出两条一样的记录） */
    const requeue = [];
    for (const t of active) {
      const task = Object.assign({ attempts: 0, status: 'pending' }, t);
      if (task.downloadId == null) { requeue.push(task); continue; }
      if (settledIds.has(task.downloadId)) continue;

      let item = null;
      try {
        const items = await chrome.downloads.search({ id: task.downloadId });
        item = items && items[0];
      } catch (e) { item = null; }

      if (item && item.state === 'complete') await settleRestoredDone(task, item);
      else if (item && item.state === 'interrupted') await settleRestoredFailed(task, item);
      else if (item && item.state === 'in_progress') watchRestored(task);
      else {
        /* 记录查不到了。先看指纹 —— 「下完了但记录被清空」和「根本没下过」
           在 downloads API 眼里长得一模一样，重试的代价却完全不同
           （前者多一个重名文件，后者什么都不会损失）。 */
        let already = false;
        try {
          const fp = await U.sha256hex(task.url + '|' + (task.width || 0) + 'x' + (task.height || 0));
          already = await Store.hasFingerprint(fp);
        } catch (e) { already = false; }
        if (already) await settleRestoredAlreadyThere(task);
        else requeue.push(task);      // 真没下过 → 当作没开始过，重新排队
      }
    }
    queue = queue.concat(requeue);

    console.log('[ImageHunter] 恢复未完成的下载队列：待办 ' + queue.length
      + ' 项，在飞 ' + activeTasks.length + ' 项');
    broadcastProgress();

    if (queue.length) pump();
    else if (!activeTasks.length) {
      job.status = 'done';
      job.finishedAt = Date.now();
      broadcastProgress();
    }
  } catch (e) { /* ignore */ }
  finally { restoringJob = false; }
}

/* ---------------------------------------------------------------------- *
 * 恢复对账的两个落点 + 一个「还在下」的接续
 * ---------------------------------------------------------------------- */

/** 已落盘：补记指纹 / 统计 / 历史，并且**只记一次** */
async function settleRestoredDone(task, item) {
  if (task.downloadId != null) {
    if (settledIds.has(task.downloadId)) return;
    settledIds.add(task.downloadId);
  }
  const bytes = itemBytes(item);
  const actual = baseName(item && item.filename) || task.filename;
  job.done++;
  pushRecent({ index: task.index, url: task.url, filename: actual, status: 'done', bytes });
  try {
    const fp = await U.sha256hex(task.url + '|' + (task.width || 0) + 'x' + (task.height || 0));
    await Store.addFingerprints([fp]);
    await Store.bumpStats({ saved: 1, bytes });
    await Store.addHistory({
      ts: Date.now(),
      url: task.url,
      pageUrl: task.pageUrl,
      filename: actual,
      width: task.width || 0,
      height: task.height || 0,
      bytes,
      status: 'done'
    });
  } catch (e) {
    // 对账时文件已经在了，记账失败不该让整个恢复流程中断
    console.warn('[ImageHunter] 对账补记失败：', (e && e.message) || e);
  }
}

/** 已失败：同样只记一次 */
async function settleRestoredFailed(task, item) {
  if (task.downloadId != null) {
    if (settledIds.has(task.downloadId)) return;
    settledIds.add(task.downloadId);
  }
  const err = (item && item.error) || t('bg.downloadInterrupted');
  job.failed++;
  pushRecent({ index: task.index, url: task.url, status: 'failed', error: err });
  try {
    await Store.bumpStats({ failed: 1 });
    await Store.addHistory({
      ts: Date.now(),
      url: task.url,
      pageUrl: task.pageUrl,
      filename: task.filename,
      width: task.width || 0,
      height: task.height || 0,
      status: 'failed',
      error: err
    });
  } catch (e) {
    console.warn('[ImageHunter] 对账补记失败：', (e && e.message) || e);
  }
}

/**
 * 对账分支：下载记录查不到了，但**指纹表里有这张图** → 当作「已下过」结账。
 *
 * 这个分支的存在理由：`chrome.downloads.search({id})` 查不到有两种完全不同的成因 ——
 *   · 用户清空了下载记录（文件其实在）→ 重下会多一个重名文件
 *   · 下载压根没建起来（文件不存在）→ 重下正是我们想要的
 * 光看 downloads API 分不开这两者。指纹表能：这张图下完过就一定有指纹
 * （见 runTask 的成功分支），没有指纹才是真没下过。
 *
 * 语义与 runTask 的「跳过已下载」一致：只加 skipped 计数、不写历史。
 */
async function settleRestoredAlreadyThere(task) {
  if (task.downloadId != null) {
    if (settledIds.has(task.downloadId)) return;
    settledIds.add(task.downloadId);
  }
  job.skipped++;
  pushRecent({ index: task.index, url: task.url, status: 'skipped' });
}

/** 重启时那张还在下：接上 onChanged 等它落盘，**而不是重新下一遍** */
function watchRestored(task) {
  activeTasks.push(task);
  activeCount++;
  const finish = (fn) => {
    Promise.resolve(fn()).catch(() => {}).then(() => {
      const at = activeTasks.indexOf(task);
      if (at >= 0) activeTasks.splice(at, 1);
      activeCount--;
      if (job && job.status === 'running' && !queue.length && !activeCount) {
        job.status = 'done';
        job.finishedAt = Date.now();
      }
      broadcastProgress();
    });
  };
  waitForDownload(task.downloadId, 180000).then(
    (info) => finish(() => settleRestoredDone(task, info)),
    () => finish(() => settleRestoredFailed(task, null))
  );
}
