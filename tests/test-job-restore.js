/* ImageHunter — MV3 下载任务持久化 / 重启对账测试
 *
 * 守的是 MV3 最容易被忽略的一类 bug：**Service Worker 随时会被回收**。
 *
 * 旧实现有两个洞：
 *
 *   ① `persistJob()` 只存 `queue`（待办），而队列里的任务在 worker
 *      `shift()` 出去的那一刻就不在 queue 里了。于是 SW 一被回收，
 *      **正在下载的那一张彻底消失**：既不在待办里，也没进 done/failed。
 *      这个批次的 done+failed+skipped 永远小于 total，进度条卡在 99%。
 *
 *   ② 从来没存过 `downloadId`。重启后就算想对账也无从下手 ——
 *      唯一的选择是「重下一遍」，而那一张很可能已经落盘了，
 *      于是用户下载目录里多出一个重名文件。
 *
 * 修法：把「在飞的任务 + 它的 downloadId」也持久化；重启时拿 downloadId
 * 去问 `chrome.downloads.search`，按结果分别处理：
 *   complete    → 补记指纹 / 统计 / 历史，**不重下**（幂等）
 *   interrupted → 记一次失败
 *   in_progress → 接上 onChanged 等它落盘，**不重下**
 *   查不到      → 当作没开始，重新排队
 *
 * 这个套件用两个独立的 vm 上下文模拟「SW 被回收 → 重新拉起」：
 * 它们共享同一份 session storage 与下载登记表，但内存状态是全新的。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label); else bad(label, 'got ' + a + ' / expect ' + b);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 跨「进程」共享的两份外部状态
 * ------------------------------------------------------------------ */

/** session storage（SW 重启后仍然存在，浏览器关闭才清） */
const sessionStore = {};
/** local storage（设置 / 历史 / 统计 / 指纹） */
const storeData = {
  ih_settings: { skipDownloaded: false, retries: 0, fetchFallback: true, concurrency: 1 }
};
/** 下载登记表：id -> DownloadItem */
const downloads = new Map();

let nextDownloadId = 1;
/** 每个环境各自记录「这次启动里发起了哪些下载」 */
function makeEnv(tag, opts) {
  opts = opts || {};
  const log = { downloads: [], progress: [], id: tag };
  const changeListeners = [];

  const chrome = {
    runtime: {
      lastError: undefined,
      id: 'fake-ext-id',
      onMessage: { addListener: (fn) => { log.message = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: (msg) => {
        if (msg && msg.type === 'IH_PROGRESS') log.progress.push(msg.payload);
        return Promise.resolve();
      },
      getURL: (p) => 'chrome-extension://fake/' + p
    },
    i18n: { getMessage: () => '' },
    downloads: {
      download(o) {
        const id = nextDownloadId++;
        log.downloads.push({ id, url: o.url, filename: o.filename });
        if (opts.completeAfter) {
          // 这个环境里的下载会在一小段时间后「完成」
          setTimeout(() => {
            downloads.set(id, {
              id,
              state: 'complete',
              filename: 'C:\\Users\\tester\\Downloads\\' + (o.filename || 'x.jpg'),
              bytesReceived: 4321,
              fileSize: 4321,
              exists: true
            });
            for (const fn of changeListeners) fn({ id, state: { current: 'complete' } });
          }, opts.completeAfter);
        } else {
          // 永远停在「下载中」—— 用来模拟「SW 在下载途中被回收」
          downloads.set(id, {
            id,
            state: 'in_progress',
            filename: o.filename,
            bytesReceived: 0,
            fileSize: 0
          });
        }
        return Promise.resolve(id);
      },
      search(query) {
        if (query && query.id != null) {
          const it = downloads.get(query.id);
          return Promise.resolve(it ? [it] : []);
        }
        return Promise.resolve(Array.from(downloads.values()));
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
        get(keys) {
          const out = {};
          if (typeof keys === 'string') { if (keys in sessionStore) out[keys] = sessionStore[keys]; }
          else if (Array.isArray(keys)) { for (const k of keys) if (k in sessionStore) out[k] = sessionStore[k]; }
          else { Object.assign(out, sessionStore); }
          return Promise.resolve(out);
        },
        set(obj) { Object.assign(sessionStore, JSON.parse(JSON.stringify(obj))); return Promise.resolve(); },
        remove(k) { delete sessionStore[k]; return Promise.resolve(); }
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
    console: { log() {}, warn() {}, error: console.error },
    chrome, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Object, Array, String, Number, Math, Date, JSON, Map, Set,
    URL, URLSearchParams, TextEncoder, Blob, Response, ReadableStream,
    AbortController, Uint8Array,
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
  const env = { ctx, log, send: (msg, limit) => send(env, msg, limit || 4000) };
  return env;
}

/** 往这个「后台进程」发一条消息，拿回它的响应 */
function send(env, msg, limit) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, error: 'no response' }), limit);
    const listener = env.log.message;
    if (!listener) { done({ ok: false, error: 'listener not registered' }); return; }
    const handled = listener(msg, { tab: { id: 1 } }, done);
    if (handled !== true) done({ ok: false, error: 'not async' });
  });
}

const URLS = [
  'https://img.example.com/1.jpg',
  'https://img.example.com/2.jpg',
  'https://img.example.com/3.jpg'
];

(async function () {
  /* ---------------------------------------------------------------- *
   * 1. 环境 A：开一批 3 张，concurrency=1，第一张卡在「下载中」
   * ---------------------------------------------------------------- */
  console.log('=== 1. 下载途中被回收：在飞的任务必须落盘 ===');
  const envA = makeEnv('A');
  await sleep(120);   // 等 bootstrap 跑完

  const a = await envA.send({
    type: 'IH_DOWNLOAD_BATCH',
    payload: {
      items: URLS.map((u, i) => ({ url: u, filename: 'p' + (i + 1) + '.jpg', width: 100, height: 100 }))
    }
  });
  eq(a && a.ok, true, '批次已入队');
  eq(a && a.total, 3, '批次总数 3');

  await sleep(250);   // 让第一张进入「下载中」，其余 2 张留在队列

  const saved = sessionStore.ih_job || {};
  console.log('落盘的 job =', JSON.stringify({
    total: saved.total, done: saved.done, pending: (saved.pending || []).length,
    active: (saved.active || []).map((x) => x.downloadId)
  }));
  eq((saved.active || []).length, 1, '在飞的那一张被持久化了（旧实现只存 pending，这张会丢）');
  eq((saved.pending || []).length, 2, '待办的 2 张也都在');
  check(saved.active && saved.active[0] && saved.active[0].downloadId != null,
    '在飞任务带着 downloadId（没有它就无法在重启后对账）',
    saved.active && JSON.stringify(saved.active[0]));

  const flying = saved.active[0];
  if (!flying) {
    /* 走到这里说明「在飞任务没被持久化」—— 后面几节都依赖它，
       与其崩掉（那样 runner 只会报「中途退出，未跑完」，看不出原因），
       不如明确报一条失败再收工。 */
    bad('在飞任务没有落盘，后面的对账用例无从验证');
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
  }

  /* ---------------------------------------------------------------- *
   * 2. 模拟 SW 被回收：内存状态全丢，session storage 还在
   * ---------------------------------------------------------------- */
  console.log('\n=== 2. 重启后对账：已经落盘的不重下 ===');
  // 那一张其实已经下完了（用户下载目录里已经有文件了）
  downloads.set(flying.downloadId, {
    id: flying.downloadId,
    state: 'complete',
    filename: 'C:\\Users\\tester\\Downloads\\' + flying.filename,
    bytesReceived: 4321,
    fileSize: 4321,
    exists: true
  });

  const historyBefore = (storeData.ih_history || []).length;
  const envB = makeEnv('B', { completeAfter: 40 });   // 这个环境的下载会很快完成
  await sleep(500);   // bootstrap → restoreJob → 对账 → 重排队 → 下载完

  console.log('环境 B 发起的下载 =', JSON.stringify(envB.log.downloads.map((d) => d.filename)));
  console.log('最终进度 =', JSON.stringify(envB.log.progress[envB.log.progress.length - 1]));

  check(envB.log.downloads.every((d) => d.filename !== flying.filename),
    '已经下完的那一张**没有**被重新下载（否则下载目录里会多一个重名文件）',
    JSON.stringify(envB.log.downloads.map((d) => d.filename)));
  eq(envB.log.downloads.length, 2, '只重下了队列里那 2 张');

  const hist = storeData.ih_history || [];
  const forFlying = hist.filter((h) => h.filename === flying.filename || (h.url === flying.url));
  eq(forFlying.length, 1, '对账补记了历史，且只有 1 条（不是 0 条也不是 2 条）');
  check(forFlying[0] && forFlying[0].status === 'done', '补记的状态是 done',
    forFlying[0] && forFlying[0].status);
  eq(forFlying[0] && forFlying[0].bytes, 4321, '补记的体积取自 DownloadItem（不是 0）');

  const finalProgress = envB.log.progress[envB.log.progress.length - 1] || {};
  eq(finalProgress.total, 3, '总数仍是 3（没有把在飞的那张重复计入）');
  eq(finalProgress.done, 3, '三张都算作 done —— 旧实现这里会永远停在 2');
  eq(finalProgress.remaining, 0, '队列清空');
  eq(finalProgress.status, 'done', '批次收尾为 done');

  /* ---------------------------------------------------------------- *
   * 3. 幂等：同一个 downloadId 再对一次账，不许重复计数
   * ---------------------------------------------------------------- */
  console.log('\n=== 3. 幂等：同一个 downloadId 不重复记账 ===');
  /* `job` 是用 let 声明的 —— 它在上下文的**全局词法作用域**里，
     不是 sandbox 对象的属性，所以要用 runInContext 再求值一次才读得到。 */
  const jobDone = () => vm.runInContext('job.done', envB.ctx);
  const doneBefore = jobDone();
  const histLenBefore = (storeData.ih_history || []).length;
  const settle = vm.runInContext('settleRestoredDone', envB.ctx);
  await settle(Object.assign({}, flying), downloads.get(flying.downloadId));
  eq(jobDone(), doneBefore, 'done 没有被再加一次');
  eq((storeData.ih_history || []).length, histLenBefore, '历史没有多出一条');

  /* ---------------------------------------------------------------- *
   * 4. 查不到下载记录时：当作没开始，重新排队
   * ---------------------------------------------------------------- */
  console.log('\n=== 4. 下载记录查不到 → 重新排队 ===');
  sessionStore.ih_job = {
    batchId: 'b-orphan',
    total: 1,
    done: 0,
    failed: 0,
    skipped: 0,
    status: 'running',
    restores: 0,
    pending: [],
    active: [{
      url: 'https://img.example.com/orphan.jpg',
      pageUrl: '',
      filename: 'orphan.jpg',
      width: 10,
      height: 10,
      index: 1,
      downloadId: 99999      // 登记表里没有这个 id
    }],
    settled: []
  };
  const envC = makeEnv('C', { completeAfter: 40 });
  await sleep(400);
  console.log('环境 C 发起的下载 =', JSON.stringify(envC.log.downloads.map((d) => d.filename)));
  check(envC.log.downloads.some((d) => d.filename === 'orphan.jpg'),
    '查不到记录的下载被重新排队并执行（而不是当成已完成悄悄吞掉）',
    JSON.stringify(envC.log.downloads.map((d) => d.filename)));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常', e); process.exit(1); });
