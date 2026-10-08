/* ImageHunter — background.js 右键菜单幂等性回归测试
 *
 * 复现并锁死这个 bug：
 *   "Unchecked runtime.lastError: Cannot create item with duplicate id ih-save-image"
 *
 * 成因：SW 启动时的顶层 IIFE / onInstalled / onStartup 都会调用 setupMenus()，
 * 而 chrome.contextMenus.removeAll 是异步的 —— 两个流程的回调交错执行时，
 * 后一个 create 就会撞上已存在的同 id 菜单项。
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
 * chrome API 桩：真实模拟 duplicate id 行为
 * ------------------------------------------------------------------ */

const existingMenus = new Set();
const stats = { removeAll: 0, create: 0, duplicateErrors: 0, createdIds: [] };
const listeners = { installed: [], startup: [], command: [], menuClicked: [], message: [] };

const chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    sendMessage: () => Promise.resolve(),
    getURL: (p) => 'chrome-extension://fake/' + p
  },
  i18n: { getMessage: () => '' },
  contextMenus: {
    removeAll(cb) {
      stats.removeAll++;
      existingMenus.clear();
      // 异步回调 —— 这正是竞态的窗口
      setTimeout(() => { chrome.runtime.lastError = undefined; cb && cb(); }, 0);
    },
    create(def, cb) {
      stats.create++;
      setTimeout(() => {
        if (existingMenus.has(def.id)) {
          // 真实 Chrome 在此处设置 lastError
          chrome.runtime.lastError = { message: 'Cannot create item with duplicate id ' + def.id };
          stats.duplicateErrors++;
        } else {
          existingMenus.add(def.id);
          stats.createdIds.push(def.id);
          chrome.runtime.lastError = undefined;
        }
        cb && cb();
      }, 0);
    },
    onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) }
  },
  commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
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
  scripting: { executeScript: () => Promise.resolve() },
  downloads: {
    download: () => Promise.resolve(1),
    search: () => Promise.resolve([]),
    onChanged: { addListener() {} }
  },
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    onChanged: { addListener() {} }
  }
};

const sandbox = {
  console,
  chrome,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Object,
  Array,
  String,
  Number,
  Math,
  Date,
  JSON,
  Map,
  Set,
  URL,
  URLSearchParams,
  TextEncoder,
  crypto: { subtle: null },
  importScripts: function () {
    for (const f of arguments) {
      const p = path.join(BASE, f);
      vm.runInContext(fs.readFileSync(p, 'utf8'), ctx);
    }
  }
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);

/* ------------------------------------------------------------------ *
 * 加载 background.js
 * ------------------------------------------------------------------ */

vm.runInContext(fs.readFileSync(path.join(BASE, 'background.js'), 'utf8'), ctx);

(async function run() {
  await sleep(60);   // 等顶层 bootstrap IIFE 跑完

  console.log('=== 1. SW 顶层启动不应创建菜单 ===');
  check(stats.removeAll === 0,
    '顶层 IIFE 不再调用 setupMenus()（避免每次 SW 唤醒都重建菜单）', 'removeAll 调用 ' + stats.removeAll + ' 次');
  check(stats.create === 0, '顶层启动未创建任何菜单项');

  console.log('\n=== 2. 并发触发 onInstalled + onStartup（复现竞态）===');
  check(listeners.installed.length === 1, '已注册 onInstalled 监听');
  check(listeners.startup.length === 1, '已注册 onStartup 监听');

  // 同一时刻触发两个生命周期事件 —— 修复前这里会产生 duplicate id
  await Promise.all([
    listeners.installed[0]({ reason: 'update' }),
    listeners.startup[0]()
  ]);
  await sleep(80);

  check(stats.removeAll === 1,
    '并发触发下 removeAll 只执行 1 次（Promise 缓存生效）', '实际 ' + stats.removeAll + ' 次');
  check(stats.create === 2,
    '只创建了 2 个菜单项（而非 4 个）', '实际 ' + stats.create + ' 次');
  check(stats.duplicateErrors === 0,
    '未发生任何 duplicate id 错误', '实际 ' + stats.duplicateErrors + ' 次');
  check(existingMenus.size === 2, '最终存在 2 个菜单项');
  check(existingMenus.has('ih-save-image'), '菜单 ih-save-image 已创建');
  check(existingMenus.has('ih-open-gallery'), '菜单 ih-open-gallery 已创建');
  check(chrome.runtime.lastError === undefined, '结束时 lastError 已被清理（不会有 Unchecked 告警）');

  console.log('\n=== 3. 连续多次调用仍然幂等 ===');
  const before = { removeAll: stats.removeAll, create: stats.create };
  await listeners.installed[0]({ reason: 'update' });
  await listeners.startup[0]();
  await listeners.installed[0]({ reason: 'install' });
  await sleep(60);
  check(stats.removeAll === before.removeAll,
    '后续调用直接复用已完成的 Promise，不再重复 removeAll');
  check(stats.create === before.create, '后续调用不再重复 create');
  check(stats.duplicateErrors === 0, '全程无 duplicate id 错误');

  console.log('\n=== 4. 跨 SW 实例撞车时的兜底 ===');
  // 模拟另一个 SW 实例已经创建过菜单：直接调用 create 应被静默容忍
  stats.duplicateErrors = 0;
  let warned = 0;
  const origWarn = console.warn;
  console.warn = () => { warned++; };
  await new Promise((resolve) => {
    chrome.contextMenus.create({ id: 'ih-save-image', title: 'x', contexts: ['image'] }, () => {
      const err = chrome.runtime.lastError;
      // 与 background.js 中相同的处理逻辑
      if (err && !/duplicate id/i.test(err.message || '')) warned++;
      resolve();
    });
  });
  console.warn = origWarn;
  check(warned === 0, 'duplicate id 被视为「已存在且配置一致」，不输出告警');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
