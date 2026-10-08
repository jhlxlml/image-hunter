/* ImageHunter — background.js 的 vm 测试桩
 *
 * 为什么要有它：background.js 是**服务工作者**，它依赖的 chrome.* 接口在 Node 里
 * 一个都不存在。这个桩提供一套「够用的假 chrome」，把 background.js 原样跑在
 * vm context 里 —— 于是「扫描超时判据」「缓存键」「消息分支」这些**纯后台逻辑**
 * 可以在毫秒级、完全离线的条件下被断言，不必起浏览器。
 *
 * 两个使用者：
 *   tests/test-scan-cache.js    —— 缓存键 / 绕开 / 失效 / 跨 SW 回收
 *   tests/test-scan-timeout.js  —— 「没扫成」不能冒充「本页没有图片」
 *
 * 关键能力：
 *   1. **内容脚本是可编程的**（opts.onScan）。什么时候回报、报什么、报不报，
 *      全由用例决定 —— 超时 / 排队 / 报错这些场景只有这样才能测。
 *   2. **超时常量可缩短**（opts.timeouts）。它们是 background.js 里的 `const`，
 *      在 vm 里没法从外面覆盖，所以对源码做一次**带校验**的替换：
 *      替换不到就抛错，免得「测试还在跑，但测的其实是别的超时」。
 *   3. **sessionStore 可以跨实例传** → 用来模拟 SW 被回收后重启。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..', '..');

/** 桩里默认的「当前页面地址」 */
const PAGE_A = 'https://example.com/a.html';
const PAGE_B = 'https://example.com/b.html';

/**
 * 起一个后台实例（等价于「SW 启动一次」）。
 *
 * @param {object} [opts]
 * @param {object} [opts.sessionStore] 与别的实例共享 → 模拟 chrome.storage.session 的持久性
 * @param {string} [opts.tabUrl]       目标标签页地址
 * @param {boolean} [opts.blocked]     页面是否在排除列表里（决定内容脚本回报空列表）
 * @param {Array}  [opts.images]       内容脚本默认回报的图片列表
 * @param {object} [opts.settings]     写进 chrome.storage.local 的设置
 * @param {Function} [opts.onScan]     `({ reqId, msg, emit, reportFinal }) => ack`
 *        IH_DO_SCAN 到达时调用。返回值作为 sendMessage 的确认（undefined → `{ok:true}`）；
 *        什么时候回报、回报什么，由它自己用 `emit` / `reportFinal` 决定。
 *        不传时：立刻回报一条最终结果（老行为）。
 * @param {object} [opts.timeouts]     `{ idle, restore, deep }` —— 缩短 background.js 里的三个常量
 */
function createBg(opts) {
  const o = opts || {};
  // 共享的「会话存储」：模拟 chrome.storage.session
  const sessionStore = o.sessionStore || {};

  const listeners = { message: [], updated: [], removed: [], activated: [] };
  /* 后台向扩展页广播出去的消息（SCAN_UPGRADE / 进度…）。
     为什么必须记下来：「先出图、后升级」的第一版结果是 sendResponse 走的，
     最终结果走的是广播 —— 只看 sendResponse 会以为「最终结果根本没回来」。 */
  const broadcasts = [];
  const st = {
    tabUrl: o.tabUrl || PAGE_A,
    scanCount: 0,              // 真实扫描（走完注入 + DO_SCAN）的次数
    blocked: !!o.blocked,
    images: o.images || [
      { url: 'https://cdn.example.com/1.png', width: 800, height: 600, restored: true },
      { url: 'https://cdn.example.com/2.png', width: 400, height: 300, restored: false }
    ]
  };

  const settings = { ih_settings: Object.assign({ blockedHosts: [] }, o.settings || {}) };

  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage: (msg) => { broadcasts.push(msg); return Promise.resolve(); },
      getURL: (p) => 'chrome-extension://fake/' + p
    },
    i18n: { getMessage: () => '' },
    downloads: {
      download: () => Promise.resolve(1),
      search: () => Promise.resolve([]),
      onChanged: { addListener() {} }
    },
    storage: {
      local: {
        get(keys) {
          const out = {};
          if (typeof keys === 'string') { if (keys in settings) out[keys] = settings[keys]; }
          else if (Array.isArray(keys)) { for (const k of keys) if (k in settings) out[k] = settings[k]; }
          else Object.assign(out, settings);
          return Promise.resolve(out);
        },
        set(obj) { Object.assign(settings, obj); return Promise.resolve(); }
      },
      session: {
        get(keys) {
          const out = {};
          if (typeof keys === 'string') { if (keys in sessionStore) out[keys] = sessionStore[keys]; }
          else if (Array.isArray(keys)) { for (const k of keys) if (k in sessionStore) out[k] = sessionStore[k]; }
          else Object.assign(out, sessionStore);
          return Promise.resolve(out);
        },
        set(obj) { Object.assign(sessionStore, obj); return Promise.resolve(); },
        remove(keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete sessionStore[k]; });
          return Promise.resolve();
        }
      },
      onChanged: { addListener() {} }
    },
    action: { onClicked: { addListener() {} } },
    windows: { update: () => Promise.resolve() },
    tabs: {
      query: () => Promise.resolve([]),
      create: () => Promise.resolve({ id: 99 }),
      get: () => Promise.resolve({ id: 1, url: st.tabUrl, title: 'T' }),
      update: () => Promise.resolve(null),
      sendMessage(tabId, msg) {
        if (msg && msg.type === 'IH_PING') {
          return Promise.resolve({ ok: true, top: true, url: st.tabUrl });
        }
        if (msg && msg.type === 'IH_DO_SCAN') {
          st.scanCount++;
          const reqId = msg.reqId;
          const reportFinal = (extra) => emit(Object.assign({
            type: 'IH_SCAN_RESULT',
            reqId,
            phase: 'final',
            images: st.blocked ? [] : st.images,
            pageUrl: st.tabUrl,
            title: 'T'
          }, extra || {}));

          if (typeof o.onScan === 'function') {
            const ack = o.onScan({ reqId, msg, emit, reportFinal });
            return Promise.resolve(ack === undefined ? { ok: true } : ack);
          }

          // 默认：立刻回报「最终结果」（不报 partial，省掉安静期那 450ms 之外的分支）
          setTimeout(reportFinal, 0);
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ ok: true });
      },
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) }
    },
    contextMenus: {
      removeAll: (cb) => setTimeout(() => cb && cb(), 0),
      create: (def, cb) => setTimeout(() => cb && cb(), 0),
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
    /* 界面语言钉成中文。SW 里 `navigator.language` 是浏览器界面语言，
       桩里不给的话 i18n 会退到 'en'，而断言写的是中文句子 ——
       于是「测试全红」会被误读成「后台文案坏了」。 */
    navigator: { language: 'zh-CN' },
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
  vm.runInContext(patchSource(o.timeouts), ctx);

  function emit(msg, sender) {
    return listeners.message[0](msg, sender || { tab: { id: 1 }, frameId: 0 }, () => {});
  }

  function send(msg, timeoutMs) {
    const limit = timeoutMs || 4000;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      // 带超时：handler 返回 true 却永不 sendResponse 时，裸 await 会挂住，
      // 事件循环里没有别的 timer 时 Node 会静默以退出码 0 结束（见 tests/README 第 1 条）
      const timer = setTimeout(() => {
        done({ ok: false, error: '消息 ' + (msg && msg.type) + ' 在 ' + limit + 'ms 内没有回应' });
      }, limit);
      const handled = listeners.message[0](msg, { tab: { id: 1 } }, done);
      if (handled !== true) done({ ok: false, error: '未异步响应' });
    });
  }

  return {
    st, sessionStore, listeners, broadcasts, emit, send, ctx,
    setUrl(url) { st.tabUrl = url; },
    fireUpdated(changeInfo) {
      listeners.updated.forEach((fn) => fn(1, changeInfo, { id: 1, url: st.tabUrl }));
    },
    fireRemoved() { listeners.removed.forEach((fn) => fn(1, {})); }
  };
}

/**
 * 把 background.js 源码读出来，按需缩短三个超时常量。
 *
 * 为什么用「改源码」而不是「从外面覆盖」：它们是用 `const` 声明的，
 * vm 里 `const` 落在词法作用域上，不是 sandbox 的属性，外面根本改不到；
 * 而用真实的 4 秒 / 15 秒去测，一个套件就要跑二十几秒。
 *
 * 替换必须**命中**：找不到就抛错。否则某天常量改了名字，
 * 测试会安安静静地继续跑，测的却是另一套超时 —— 那比没有测试更糟。
 */
function patchSource(timeouts) {
  let src = fs.readFileSync(path.join(BASE, 'background.js'), 'utf8');
  if (!timeouts) return src;

  const patch = (name, value) => {
    const re = new RegExp('const ' + name + ' = \\d+;');
    if (!re.test(src)) throw new Error('background.js 里找不到 ' + name + '，无法缩短超时');
    src = src.replace(re, 'const ' + name + ' = ' + value + ';');
  };
  if (timeouts.idle != null) patch('SCAN_IDLE_TIMEOUT', timeouts.idle);
  if (timeouts.restore != null) patch('SCAN_RESTORE_TIMEOUT', timeouts.restore);
  if (timeouts.deep != null) patch('SCAN_DEEP_TIMEOUT', timeouts.deep);
  return src;
}

module.exports = { createBg, patchSource, PAGE_A, PAGE_B };
