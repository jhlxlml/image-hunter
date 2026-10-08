/* ImageHunter — 批量下载序号回归测试
 *
 * 锁死这个 bug：startBatch() 里
 *     const baseIndex = job ? job.total : 0;
 * 是在**新批次建立之前**取值的，取到的是上一批的 total。
 * 于是连续两次批量下载，第二批会从 003 开始（实测），
 * 而且 job.total 并非单调（cancelBatch 会改小、运行中单张下载会 +1），序号不可预测。
 *
 * 正确语义：序号 = 「本批次内第几张」，新批次一律从 001 开始；
 * 追加到**运行中**的同一批次才接着往下排。
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

/**
 * 向后台发一条消息并等回应，**必须带超时**。
 *
 * 反面教材（本文件原来的写法）：
 *     await new Promise((r) => { listeners.message[0]({ type: 'X' }, {}, r); });
 * 如果 X 是个后台不认识的消息类型，路由会落到 `default: return undefined`，
 * sendResponse 永远不被调用 —— 这个 Promise 永远不 settle。此时事件循环里
 * 一个 timer 都没有，Node 会**静默以退出码 0 结束**，runner 于是报绿，
 * 而剩下的断言一条都没跑。测试套件自己会骗人，比没有测试更危险。
 */
function ask(type, payload, timeoutMs) {
  const limit = timeoutMs || 2000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('消息 ' + type + ' 在 ' + limit + 'ms 内没有回应 —— ' +
        '该类型可能不存在（后台会落到 default 分支直接忽略）'));
    }, limit);
    listeners.message[0]({ type, payload }, {}, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/* ------------------------------------------------------------------ *
 * chrome 桩
 * ------------------------------------------------------------------ */

const storeData = {
  ih_settings: {
    skipDownloaded: false,
    retries: 0,
    fetchFallback: false,
    concurrency: 1,
    filenameTemplate: '{index}-{name}.{ext}',
    batchPrefix: false
  }
};

const listeners = { message: [] };
const changeListeners = [];
let idSeq = 0;
let downloadCalls = [];
let completeDelay = 20;

function makeItem(id, requestedName) {
  return {
    id, state: 'complete',
    filename: 'C:\\Users\\tester\\Downloads\\' + requestedName,
    fileSize: 10, bytesReceived: 10, totalBytes: 10, exists: true
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
      downloadCalls.push(opts.filename);
      const id = ++idSeq;
      setTimeout(() => {
        currentItem = makeItem(id, opts.filename);
        for (const fn of changeListeners) fn({ id, state: { current: 'complete' } });
      }, completeDelay);
      return Promise.resolve(id);
    },
    // 必须按 id 过滤：否则会把上一次下载的陈旧项当成「本次已完成」，
    // 下载瞬间 settle，批次来不及进入运行态
    search: (q) => Promise.resolve(currentItem && q && q.id === currentItem.id ? [currentItem] : []),
    onChanged: { addListener: (fn) => changeListeners.push(fn) }
  },
  storage: {
    local: {
      get(keys) {
        const out = {};
        if (typeof keys === 'string') { if (keys in storeData) out[keys] = storeData[keys]; }
        else Object.assign(out, storeData);
        return Promise.resolve(out);
      },
      set(obj) { Object.assign(storeData, obj); return Promise.resolve(); }
    },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    onChanged: { addListener() {} }
  },
  action: { onClicked: { addListener() {} } },
  windows: { update: () => Promise.resolve() },
  tabs: {
    // 两种调用形式都要支持：background.js 里 SETTINGS_CHANGED 的转发用的是
    // 回调式 `chrome.tabs.query({}, cb)`，只实现 Promise 形式会让那个分支静默不执行
    query: (q, cb) => {
      const list = [];
      if (typeof cb === 'function') { cb(list); return undefined; }
      return Promise.resolve(list);
    },
    sendMessage: () => Promise.resolve(),
    create: () => Promise.resolve(), get: () => Promise.resolve(null),
    update: () => Promise.resolve(null),
    onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }
  },
  contextMenus: {
    removeAll: (cb) => setTimeout(() => cb && cb(), 0),
    create: (d, cb) => setTimeout(() => cb && cb(), 0),
    onClicked: { addListener() {} }
  },
  commands: { onCommand: { addListener() {} } },
  scripting: { executeScript: () => Promise.resolve() }
};

const sandbox = {
  console, chrome, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Object, Array, String, Number, Math, Date, JSON, Map, Set,
  URL, URLSearchParams, TextEncoder,
  crypto: { subtle: null },
  fetch: () => Promise.reject(new Error('offline')),
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
 * 辅助
 * ------------------------------------------------------------------ */

function batch(n, tag) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ url: 'https://ex.com/' + tag + i + '.jpg', width: 100, height: 100, pageUrl: 'https://ex.com/' });
  }
  return ask('IH_DOWNLOAD_BATCH', { items });
}

function cancel() {
  return ask('IH_CANCEL_BATCH');
}

function status() {
  return ask('IH_GET_STATS');
}

function single(tag) {
  return ask('IH_DOWNLOAD_ONE',
    { url: 'https://ex.com/' + tag + '.jpg', width: 1, height: 1, pageUrl: 'https://ex.com/' });
}

async function run() {
  await sleep(80);   // 等顶层 bootstrap

  /* --------------------------------------------------------------- *
   * 1. 两批独立下载：都从 001 开始
   * --------------------------------------------------------------- */
  console.log('=== 1. 连续两批：第二批必须从 001 开始 ===');

  downloadCalls = [];
  await batch(2, 'a');
  await sleep(200);
  const first = downloadCalls.slice();
  check(JSON.stringify(first) === JSON.stringify(['001-a0.jpg', '002-a1.jpg']),
    '第 1 批序号 001 / 002', JSON.stringify(first));

  downloadCalls = [];
  await batch(2, 'b');
  await sleep(200);
  const second = downloadCalls.slice();
  check(JSON.stringify(second) === JSON.stringify(['001-b0.jpg', '002-b1.jpg']),
    '第 2 批序号重新从 001 开始（修复前是 003 / 004）', JSON.stringify(second));

  /* --------------------------------------------------------------- *
   * 2. 第三批同样从 001 开始
   * --------------------------------------------------------------- */
  console.log('\n=== 2. 第三批 ===');
  downloadCalls = [];
  await batch(3, 'c');
  await sleep(250);
  const third = downloadCalls.slice();
  check(JSON.stringify(third) === JSON.stringify(['001-c0.jpg', '002-c1.jpg', '003-c2.jpg']),
    '第 3 批仍是 001 起（序号不跨批次累积）', JSON.stringify(third));

  /* --------------------------------------------------------------- *
   * 3. 追加到「运行中」的同一批次：接着往下排
   * --------------------------------------------------------------- */
  console.log('\n=== 3. 批次运行中追加 ===');
  completeDelay = 120;                       // 拉长下载时间，让批次还在跑
  downloadCalls = [];
  await batch(2, 'd');                       // 001, 002（开始跑）
  await sleep(60);                           // 此时批次仍在运行
  const mid = await status();
  console.log('  追加前状态:', JSON.stringify({
    status: mid.progress.status, total: mid.progress.total, done: mid.progress.done,
    active: mid.progress.active, remaining: mid.progress.remaining
  }));
  await batch(2, 'e');                       // 应接着 003, 004
  await sleep(900);
  const appended = downloadCalls.slice();
  check(appended.length === 4, '4 张都发起了下载', String(appended.length));
  check(appended[0] === '001-d0.jpg' && appended[2] === '003-e0.jpg',
    '运行中追加的批次接着当前序号排（001,002 → 003,004）', JSON.stringify(appended));
  completeDelay = 20;

  /* --------------------------------------------------------------- *
   * 4. 取消后重新开始：从 001 开始
   * --------------------------------------------------------------- */
  console.log('\n=== 4. 取消之后 ===');
  completeDelay = 200;
  downloadCalls = [];
  await batch(4, 'f');
  await sleep(60);
  await cancel();
  await sleep(900);                          // 等已在飞的跑完

  downloadCalls = [];
  await batch(2, 'g');
  await sleep(400);
  const afterCancel = downloadCalls.slice();
  check(JSON.stringify(afterCancel) === JSON.stringify(['001-g0.jpg', '002-g1.jpg']),
    '取消后新批次从 001 开始（不受被改小的 job.total 影响）', JSON.stringify(afterCancel));
  completeDelay = 20;

  /* --------------------------------------------------------------- *
   * 5. 悬停单张下载不该打乱后续批次序号
   * --------------------------------------------------------------- */
  console.log('\n=== 5. 单张下载与批次的相互影响 ===');
  await single('solo');
  await sleep(200);
  downloadCalls = [];
  await batch(2, 'h');
  await sleep(250);
  const afterSingle = downloadCalls.slice();
  check(JSON.stringify(afterSingle) === JSON.stringify(['001-h0.jpg', '002-h1.jpg']),
    '先来一次单张下载，随后的批次仍从 001 开始', JSON.stringify(afterSingle));

  /* --------------------------------------------------------------- *
   * 6. batchPrefix 模式同样从 001 起
   * --------------------------------------------------------------- */
  console.log('\n=== 6. batchPrefix 模式 ===');
  storeData.ih_settings.filenameTemplate = '{name}.{ext}';
  storeData.ih_settings.batchPrefix = true;
  // 设置是内存缓存的，直接改 store 后需要重新加载。
  // 消息类型必须是产品代码里真实存在的 IH_SETTINGS_CHANGED
  // （shared/constants.js:40，background.js:987 会 Store.loadSettings(true) 并回 { ok: true }）。
  // 曾经这里写的是 IH_RELOAD_SETTINGS —— 那个类型全仓库只有这一处，
  // 后台落到 default 分支不回应，于是这一行永远挂住、整个套件静默退出。
  await ask('IH_SETTINGS_CHANGED');
  await sleep(50);

  downloadCalls = [];
  await batch(2, 'i');
  await sleep(250);
  const prefixed = downloadCalls.slice();
  check(JSON.stringify(prefixed) === JSON.stringify(['001_i0.jpg', '002_i1.jpg']),
    'batchPrefix 模式下序号也从 001 起', JSON.stringify(prefixed));
}

/* 收尾**必须**打印完成标记，哪怕中途抛异常。
 * run-all.js 靠这个标记判断套件是不是跑完了 —— 少一行「通过 N 项，失败 M 项」
 * 就意味着这个套件没跑到底，它报出来的绿色不可信。 */
(async function main() {
  try {
    await run();
  } catch (e) {
    fail++;
    console.log('  ✗ 套件中断：' + ((e && e.message) || e));
  }
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
