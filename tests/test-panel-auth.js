/* ImageHunter — 后台授权的判定测试（合成 sender，不需要浏览器）
 *
 * 为什么需要这一套：真实浏览器里**造不出**「sender.frameId 缺失」这种情形，
 * 而它恰恰是 v1.20.0 残留风险清单里的一条 —— 有些浏览器版本对扩展页不给
 * frameId，旧判定（`frameId === 0`）会一律判 false，把正常的面板/图库挡在门外。
 *
 * 这一套直接给后台喂**手工构造的 sender**，把「谁能通过、为什么不能」逐条钉住：
 *
 *   GALLERY_AUTH（?mode=page 自证）
 *     · 扩展页 + 顶层           → 通过
 *     · 扩展页 + 嵌在网页里     → 拒绝（not-top-level）
 *     · 网页自己                → 拒绝（not-extension-page）
 *     · frameId 缺失 + tab.url 是扩展地址 → **通过**（兜底判据生效）
 *     · frameId 缺失 + tab.url 是网页地址 → 拒绝
 *     · 两种判据都拿不到         → 拒绝，且 reason = frame-unknown（不是静默放过）
 *
 *   PANEL_VERIFY（面板自证）
 *     · 扩展页 + 嵌在网页里 + 对的 token → 通过
 *     · 扩展页 + 顶层                    → 拒绝（not-embedded）
 *     · 网页自己 + **拿到真 token**       → 拒绝（这条是整套的地基：
 *                                          网页能偷到 token 也没用，因为它
 *                                          发不出 runtime 消息，sender 是网页地址）
 *     · payload.tabId 与 sender.tab.id 不一致 → 拒绝（tab-mismatch）
 *
 *   PANEL_TOKEN（领 token）
 *     · 内容脚本（网页地址的 sender）→ 发
 *     · 扩展页（面板自己）           → 拒绝（否则等于自己给自己发通行证）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const EXT = 'chrome-extension://abcdefghijklmnop/';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label); else bad(label, 'got ' + a + ' / expect ' + b);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessionStore = {};
const storeData = { ih_settings: { skipDownloaded: false, retries: 0, fetchFallback: true, concurrency: 1 } };

const listeners = { message: [] };

const chrome = {
  runtime: {
    lastError: undefined,
    id: 'abcdefghijklmnop',
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage: () => Promise.resolve(),
    getURL: (p) => EXT + (p || '')
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
        if (typeof keys === 'string') { if (keys in storeData) out[keys] = storeData[keys]; }
        else if (Array.isArray(keys)) { for (const k of keys) if (k in storeData) out[k] = storeData[k]; }
        else Object.assign(out, storeData);
        return Promise.resolve(out);
      },
      set(obj) { Object.assign(storeData, obj); return Promise.resolve(); }
    },
    session: {
      get(keys) {
        const out = {};
        if (typeof keys === 'string') { if (keys in sessionStore) out[keys] = sessionStore[keys]; }
        else if (Array.isArray(keys)) { for (const k of keys) if (k in sessionStore) out[k] = sessionStore[k]; }
        else Object.assign(out, sessionStore);
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
  crypto: { subtle: null },                 // 走 quickHash 兜底，结果确定
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

/** 发一条消息，sender 完全由调用方构造 */
function send(msg, sender, limit) {
  const ms = limit || 3000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, error: 'no response in ' + ms + 'ms' }), ms);
    const handled = listeners.message[0](msg, sender || {}, done);
    if (handled !== true) done({ ok: false, error: 'not async' });
  });
}

/* 几种 sender 的写法 —— 名字即含义，读断言时不用回头查构造 */
const S = {
  /** 内容脚本：网页地址 + 标签页 */
  content: (tabId) => ({ id: 'abcdefghijklmnop', url: 'https://site.example/a.html', tab: { id: tabId, url: 'https://site.example/a.html' }, frameId: 0 }),
  /** 扩展自己的顶层页 */
  extTop: (tabId) => ({ id: 'abcdefghijklmnop', url: EXT + 'popup/popup.html', tab: { id: tabId, url: EXT + 'popup/popup.html' }, frameId: 0 }),
  /** 被网页 iframe 进去的扩展页（面板） */
  extFrame: (tabId) => ({ id: 'abcdefghijklmnop', url: EXT + 'popup/popup.html?mode=panel', tab: { id: tabId, url: 'https://site.example/a.html' }, frameId: 3 }),
  /** 扩展顶层页，但浏览器没给 frameId —— tab.url 兜底能判出来 */
  extTopNoFrame: (tabId) => ({ id: 'abcdefghijklmnop', url: EXT + 'popup/popup.html', tab: { id: tabId, url: EXT + 'popup/popup.html' } }),
  /** 嵌在网页里的扩展页，同样没有 frameId */
  extFrameNoFrame: (tabId) => ({ id: 'abcdefghijklmnop', url: EXT + 'popup/popup.html?mode=panel', tab: { id: tabId, url: 'https://site.example/a.html' } }),
  /** 连 tab.url 都没有（最坏情况） */
  extNoFrameNoTabUrl: (tabId) => ({ id: 'abcdefghijklmnop', url: EXT + 'popup/popup.html', tab: { id: tabId } })
};

(async function run() {
  await sleep(120);   // 等顶层 bootstrap 跑完

  console.log('=== 1. GALLERY_AUTH：独立页必须是「扩展页 + 顶层」 ===');
  let r = await send({ type: 'IH_GALLERY_AUTH' }, S.extTop(7));
  check(r && r.ok && r.valid === true, '扩展顶层页 → 通过', JSON.stringify(r));

  r = await send({ type: 'IH_GALLERY_AUTH' }, S.extFrame(7));
  check(r && r.valid === false && r.reason === 'not-top-level',
    '被 iframe 进去的扩展页 → 拒绝（这正是网页套壳图库的形态）', JSON.stringify(r));

  r = await send({ type: 'IH_GALLERY_AUTH' }, S.content(7));
  check(r && r.valid === false && r.reason === 'not-extension-page',
    '网页自己发 → 拒绝（内容脚本的 sender.url 是网页地址）', JSON.stringify(r));

  console.log('\n=== 2. GALLERY_AUTH：frameId 缺失时的兜底判据 ===');
  r = await send({ type: 'IH_GALLERY_AUTH' }, S.extTopNoFrame(7));
  check(r && r.valid === true, 'frameId 缺失 + tab.url 是扩展地址 → 通过（兜底生效，不再误杀）', JSON.stringify(r));

  r = await send({ type: 'IH_GALLERY_AUTH' }, S.extFrameNoFrame(7));
  check(r && r.valid === false && r.reason === 'not-top-level',
    'frameId 缺失 + tab.url 是网页地址 → 拒绝（兜底不是放宽）', JSON.stringify(r));

  r = await send({ type: 'IH_GALLERY_AUTH' }, S.extNoFrameNoTabUrl(7));
  check(r && r.valid === false && r.reason === 'frame-unknown',
    '两种判据都拿不到 → 拒绝，并如实说 frame-unknown（不静默放过）', JSON.stringify(r));

  console.log('\n=== 3. PANEL_TOKEN：只有内容脚本能领 ===');
  r = await send({ type: 'IH_PANEL_TOKEN' }, S.content(11));
  check(r && r.ok && typeof r.token === 'string' && r.token.length >= 16,
    '内容脚本领到 token', JSON.stringify(r && { ok: r.ok, len: r.token && r.token.length }));
  const realToken = r && r.token;

  r = await send({ type: 'IH_PANEL_TOKEN' }, S.extFrame(11));
  check(r && r.ok === false, '面板自己来领 token → 拒绝（否则等于自己给自己发通行证）', JSON.stringify(r));

  r = await send({ type: 'IH_PANEL_TOKEN' }, {});
  check(r && r.ok === false, '没有 sender.tab 的请求 → 拒绝', JSON.stringify(r));

  console.log('\n=== 4. PANEL_VERIFY：token 对还不够，来源也要对 ===');
  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: realToken } }, S.extFrame(11));
  check(r && r.valid === true, '面板（扩展页 + 嵌在网页里 + 对的 token）→ 通过', JSON.stringify(r));

  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: realToken } }, S.extTop(11));
  check(r && r.valid === false && r.reason === 'not-embedded',
    '顶层扩展页拿 token 冒充面板 → 拒绝', JSON.stringify(r));

  /* 这一条是整套的地基：网页能偷到 token（比如老版本把 token 写进 iframe 的 src），
     也照样过不去 —— 因为它发不出 runtime 消息，sender 只能是网页地址。 */
  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: realToken } }, S.content(11));
  check(r && r.valid === false && r.reason === 'not-extension-page',
    '网页拿着**真 token** 来验 → 仍然拒绝（授权绑的是 sender，不是 token 本身）', JSON.stringify(r));

  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: 'wrong-token' } }, S.extFrame(11));
  check(r && r.valid === false, 'token 不对 → 拒绝', JSON.stringify(r));

  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: realToken, tabId: 99 } }, S.extFrame(11));
  check(r && r.valid === false && r.reason === 'tab-mismatch',
    'payload.tabId 与 sender.tab.id 不一致 → 拒绝（tabId 不许自己填）', JSON.stringify(r));

  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: realToken } }, S.extFrameNoFrame(11));
  check(r && r.valid === true, 'frameId 缺失 + tab.url 是网页地址 → 仍判为「嵌在网页里」，通过', JSON.stringify(r));

  console.log('\n=== 5. 换一个标签页的 token 不能冒充 ===');
  r = await send({ type: 'IH_PANEL_TOKEN' }, S.content(22));
  const token22 = r && r.token;
  check(!!token22 && token22 !== realToken, '不同标签页领到不同的 token', String(!!token22));
  r = await send({ type: 'IH_PANEL_VERIFY', payload: { token: token22 } }, S.extFrame(11));
  check(r && r.valid === false,
    '标签页 22 的 token 在标签页 11 里不通过（token 是按标签页签发的）', JSON.stringify(r));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常', e); process.exit(1); });
