/* ImageHunter — background.js 下载语义回归测试
 *
 * 锁死这两个 bug：
 *   1. 「提示已保存，事实上没有保存下来」
 *      —— startBatch() 里 pump() 没有 await，DOWNLOAD_ONE 立刻返回 { ok:true }，
 *         悬停图标据此显示「已保存」，但那只是「已入队」。
 *   2. 「历史/统计里的体积永远是 0」
 *      —— downloadOne() 读的是 chrome.downloads.DownloadItem 上不存在的 bytes 字段，
 *         真实字段是 fileSize / bytesReceived。
 *
 * 附带覆盖：
 *   - 被「跳过已下载」拦下时返回 skipped，而不是伪造成功
 *   - 下载失败时返回 ok:false + 错误原因
 *   - Chrome 按真实 MIME 纠正扩展名时（.jpg → .avif），如实回传实际文件名
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * chrome API 桩：可精确控制下载耗时与最终状态
 * ------------------------------------------------------------------ */

const storeData = {
  // retries:0 让失败路径不必等待重试退避
  ih_settings: { skipDownloaded: true, retries: 0, fetchFallback: true, concurrency: 1 }
};

const listeners = { message: [] };
const changeListeners = [];

let idSeq = 0;
let downloadCalls = [];
let failDownload = false;      // download() 直接抛错
let nameOverride = null;       // 模拟 Chrome 纠正扩展名
let completeDelay = 220;       // 下载完成所需时间

function makeItem(id, requestedName) {
  const name = nameOverride || requestedName;
  return {
    id,
    state: 'complete',
    filename: 'C:\\Users\\tester\\Downloads\\' + name,
    bytesReceived: 1234,
    fileSize: 1234,
    totalBytes: 1234,
    exists: true,
    mime: 'image/jpeg'
  };
}

let currentItem = null;

const chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage: () => Promise.resolve(),
    getURL: (p) => 'chrome-extension://fake/' + p
  },
  i18n: { getMessage: () => '' },
  downloads: {
    download(opts) {
      downloadCalls.push(opts);
      if (failDownload) return Promise.reject(new Error('NETWORK_FAILED'));
      const id = ++idSeq;
      // 模拟：下载启动 → 一段时间后完成
      setTimeout(() => {
        currentItem = makeItem(id, opts.filename);
        for (const fn of changeListeners) fn({ id, state: { current: 'complete' } });
      }, completeDelay);
      return Promise.resolve(id);
    },
    search(query) {
      const items = currentItem && (!query || query.id === currentItem.id) ? [currentItem] : [];
      return Promise.resolve(items);
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) }
  },
  storage: {
    local: {
      get(keys) {
        const out = {};
        if (typeof keys === 'string') { if (keys in storeData) out[keys] = storeData[keys]; }
        else if (Array.isArray(keys)) { for (const k of keys) if (k in storeData) out[k] = storeData[k]; }
        else { Object.assign(out, storeData); }
        return Promise.resolve(out);
      },
      set(obj) { Object.assign(storeData, obj); return Promise.resolve(); }
    },
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve()
    },
    onChanged: { addListener() {} }
  },
  action: { onClicked: { addListener() {} } },
  windows: { update: () => Promise.resolve() },
  tabs: {
    query: () => Promise.resolve([]),
    sendMessage: () => Promise.resolve(),
    create: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    update: () => Promise.resolve(null),
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} }
  },
  contextMenus: {
    removeAll: (cb) => setTimeout(() => cb && cb(), 0),
    create: (def, cb) => setTimeout(() => cb && cb(), 0),
    onClicked: { addListener() {} }
  },
  commands: { onCommand: { addListener() {} } },
  scripting: { executeScript: () => Promise.resolve() },
  notifications: { create() {}, onClicked: { addListener() {} } }
};

const sandbox = {
  console, chrome, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Object, Array, String, Number, Math, Date, JSON, Map, Set,
  URL, URLSearchParams, TextEncoder,
  crypto: { subtle: null },                       // 走 quickHash 兜底，保证确定性
  fetch: () => Promise.reject(new Error('offline')),   // 降级路径也失败，便于测失败分支
  importScripts: function () {
    for (const f of arguments) {
      vm.runInContext(fs.readFileSync(path.join(BASE, f), 'utf8'), ctx);
    }
  }
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(BASE, 'background.js'), 'utf8'), ctx);

/* ------------------------------------------------------------------ *
 * 辅助：向 SW 发一条消息，拿回真实响应
 * ------------------------------------------------------------------ */

function sendMessage(msg, timeoutMs) {
  const limit = timeoutMs || 3000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    // 必须带超时：handler 返回 true 表示「会异步回应」，但万一它永远不调
    // sendResponse，裸 await 就会挂住；此时事件循环若无 timer，Node 会
    // 静默以退出码 0 结束，套件剩下一半断言不跑却报绿。
    const timer = setTimeout(() => {
      done({ ok: false, error: '消息 ' + (msg && msg.type) + ' 在 ' + limit + 'ms 内没有回应' });
    }, limit);
    const handled = listeners.message[0](msg, { tab: { id: 1 } }, done);
    if (handled !== true) done({ ok: false, error: '未异步响应' });
  });
}

const PAGE = 'https://www.ithome.com/1/007/649.htm';
const URL_A = 'https://img.ithome.com/newsuploadfiles/2026/9/f667889f-687e-4167-bb6b-2bc55b101b7d.jpg';

(async function run() {
  await sleep(80);   // 等顶层 bootstrap 跑完

  /* --------------------------------------------------------------- *
   * 1. DOWNLOAD_ONE 必须等下载真正完成才回应
   * --------------------------------------------------------------- */
  console.log('=== 1. 悬停单张下载：等真实结果，不假成功 ===');

  let resolvedAt = 0;
  const t0 = Date.now();
  const p1 = new Promise((resolve) => {
    listeners.message[0](
      { type: 'IH_DOWNLOAD_ONE', payload: { url: URL_A, filename: 'f667889f.jpg', width: 1440, height: 2132, pageUrl: PAGE } },
      {},
      (r) => { resolvedAt = Date.now() - t0; resolve(r); }
    );
  });

  await sleep(100);
  check(resolvedAt === 0,
    '下载完成前不回应（修复前这里会立刻返回 ok:true）', 'resolvedAt=' + resolvedAt);

  const res1 = await p1;
  check(resolvedAt >= completeDelay - 40,
    '响应发生在下载真正完成之后', resolvedAt + 'ms（下载耗时 ' + completeDelay + 'ms）');
  check(res1 && res1.ok === true, '返回 ok:true');
  check(res1 && res1.filename === 'f667889f.jpg', '回传实际落盘文件名', res1 && res1.filename);
  check(res1 && res1.bytes === 1234, '回传真实字节数（而非 0）', res1 && String(res1.bytes));
  check(res1 && res1.skipped !== true, '正常下载不会被标记为 skipped');

  /* --------------------------------------------------------------- *
   * 2. 历史记录里的体积必须正确
   * --------------------------------------------------------------- */
  console.log('\n=== 2. 历史记录体积 ===');
  const hist = storeData.ih_history || [];
  check(hist.length === 1, '写入了 1 条历史');
  check(hist[0] && hist[0].bytes === 1234,
    '历史记录字节数来自 fileSize/bytesReceived（修复前恒为 0）', hist[0] && String(hist[0].bytes));
  check(hist[0] && hist[0].status === 'done', '历史状态为 done');

  /* --------------------------------------------------------------- *
   * 3. 重复下载同一张图 → skipped，而不是伪造成功
   * --------------------------------------------------------------- */
  console.log('\n=== 3. 跳过已下载 ===');
  downloadCalls = [];
  const res2 = await sendMessage({
    type: 'IH_DOWNLOAD_ONE',
    payload: { url: URL_A, filename: 'f667889f.jpg', width: 1440, height: 2132, pageUrl: PAGE }
  });
  check(res2 && res2.ok === true, '跳过时仍返回 ok:true');
  check(res2 && res2.skipped === true, '明确标记 skipped（前端据此提示「已跳过」）');
  check(downloadCalls.length === 0, '跳过时不会真的发起下载', '实际发起 ' + downloadCalls.length + ' 次');

  /* --------------------------------------------------------------- *
   * 4. 下载失败 → ok:false + 错误原因
   * --------------------------------------------------------------- */
  console.log('\n=== 4. 下载失败必须如实上报 ===');
  failDownload = true;
  const res3 = await sendMessage({
    type: 'IH_DOWNLOAD_ONE',
    payload: { url: URL_A + '?fail=1', filename: 'fail.jpg', width: 800, height: 600, pageUrl: PAGE }
  });
  failDownload = false;
  check(res3 && res3.ok === false, '失败时返回 ok:false（修复前恒为 ok:true）');
  check(res3 && typeof res3.error === 'string' && res3.error.length > 0,
    '带回了错误原因', res3 && res3.error);

  /* --------------------------------------------------------------- *
   * 5. Chrome 纠正扩展名时如实回传
   * --------------------------------------------------------------- */
  console.log('\n=== 5. 扩展名被 Chrome 纠正 ===');
  nameOverride = 'abc.avif';
  const res4 = await sendMessage({
    type: 'IH_DOWNLOAD_ONE',
    payload: { url: URL_A + '?fmt=avif', filename: 'abc.jpg', width: 1440, height: 2132, pageUrl: PAGE }
  });
  nameOverride = null;
  check(res4 && res4.ok === true, '下载成功');
  check(res4 && res4.filename === 'abc.avif', '回传的是实际文件名 abc.avif', res4 && res4.filename);
  check(res4 && res4.renamed === true, '标记 renamed，前端据此提示用户实际文件名');

  /* --------------------------------------------------------------- *
   * 6. 批量下载仍立即返回（不阻塞进度条）
   * --------------------------------------------------------------- */
  console.log('\n=== 6. 批量下载不阻塞 ===');
  downloadCalls = [];
  const t1 = Date.now();
  const res5 = await sendMessage({
    type: 'IH_DOWNLOAD_BATCH',
    payload: { items: [
      { url: URL_A + '?b=1', filename: 'b1.jpg', width: 100, height: 100, pageUrl: PAGE },
      { url: URL_A + '?b=2', filename: 'b2.jpg', width: 100, height: 100, pageUrl: PAGE }
    ] }
  });
  const dt = Date.now() - t1;
  check(res5 && res5.ok === true, '批量下载返回 ok:true');
  check(dt < 120, '批量入口立即返回，不等待全部完成', dt + 'ms');
  check(res5 && res5.total === 2, '返回任务总数 2', res5 && String(res5.total));

  await sleep(700);   // 等队列跑完，避免进程退出时残留定时器

  /* --------------------------------------------------------------- *
   * 7. 停止批量下载：如实说明「在飞的几张会继续完成」
   *
   * 回归 AUDIT P2-5：cancelBatch() 只清队列，已经在跑的下载不会被中断。
   * 旧实现只回 { ok, dropped }，界面只能说「已停止后续下载」，
   * 用户随后看到还有文件落盘就会以为按钮坏了。
   * 现在必须回 active，让界面把「这几张还会下完」讲清楚。
   * --------------------------------------------------------------- */
  console.log('\n=== 7. 停止批量下载（P2-5）===');

  // 收一份 PROGRESS 广播，用来核对取消后的进度数字
  const progressEvents = [];
  chrome.runtime.sendMessage = (msg) => {
    if (msg && msg.type === 'IH_PROGRESS') progressEvents.push(msg.payload);
    return Promise.resolve();
  };

  completeDelay = 400;      // 拉长单张耗时，保证取消时确实有一张在飞
  downloadCalls = [];
  const batch7 = [];
  for (let i = 0; i < 4; i++) {
    batch7.push({
      url: URL_A + '?c=' + i,
      filename: 'c' + i + '.jpg',
      width: 100, height: 100, pageUrl: PAGE
    });
  }

  const res6 = await sendMessage({ type: 'IH_DOWNLOAD_BATCH', payload: { items: batch7 } });
  check(res6 && res6.total === 4, '入队 4 张', res6 && String(res6.total));

  await sleep(150);         // concurrency=1 → 第一张已被取走在下载，其余 3 张还在队列
  check(downloadCalls.length === 1, '此刻恰好 1 张在下载中（concurrency=1）',
    downloadCalls.length + ' 张');

  const res7 = await sendMessage({ type: 'IH_CANCEL_BATCH' });
  console.log('停止结果 =', JSON.stringify(res7));
  check(res7 && res7.ok === true, '停止返回 ok:true');
  check(res7 && res7.active === 1,
    '如实回报 1 张正在下载中（旧实现没有这个字段）', res7 && String(res7.active));
  check(res7 && res7.dropped === 3, '取消掉队列里剩下的 3 张', res7 && String(res7.dropped));

  const afterCancel = progressEvents[progressEvents.length - 1] || {};
  console.log('取消后进度 =', JSON.stringify(afterCancel));
  check(afterCancel.status === 'cancelled', '进度状态为 cancelled', String(afterCancel.status));
  check(afterCancel.active === 1, '进度里带着 active=1，界面据此提示', String(afterCancel.active));
  check(afterCancel.total === 1,
    '总数把在飞的那张也算进来（否则会出现「完成数 > 总数」）',
    'total=' + afterCancel.total + ', done+failed+skipped=' +
      ((afterCancel.done || 0) + (afterCancel.failed || 0) + (afterCancel.skipped || 0)));

  // 在飞的那张不会被中断，会照常落盘
  await sleep(600);
  check(downloadCalls.length === 1,
    '停止后没有再启动新下载（第 2~4 张确实没开始）', downloadCalls.length + ' 张');
  const finalProgress = progressEvents[progressEvents.length - 1] || {};
  console.log('最终进度 =', JSON.stringify(finalProgress));
  check((finalProgress.done || 0) === 1,
    '在飞的那张照常完成，计入 done', String(finalProgress.done));
  check((finalProgress.done || 0) + (finalProgress.failed || 0) + (finalProgress.skipped || 0)
        <= (finalProgress.total || 0),
    '完成数不超过总数（进度条不会溢出）',
    JSON.stringify({ total: finalProgress.total, done: finalProgress.done }));

  completeDelay = 220;

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
