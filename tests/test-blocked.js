/* ImageHunter — 站点排除列表（jsdom）
 *
 * 为什么单开一个文件：`isHostBlocked` / `normalizeHostPattern` 这类纯函数
 * 已经在 test-shared.js 里覆盖了，这里要测的是**接线**——
 * 被排除的站点上，悬停按钮到底还会不会浮出来。
 *
 * 两处门，缺一不可：
 *   1. hover.js 的显示路径（show / onMouseOver / onClick）—— 每次读最新设置，
 *      所以用户在别的标签页改完设置，已打开的页面立即生效
 *   2. main.js 的启动路径 —— 被排除的站点干脆不挂监听（省一层常驻监听），
 *      并在设置变化时「被排除 → 收起已有按钮 / 解除排除 → 补上监听」
 *
 * 只测其中一处都会漏：只测 2 会漏掉「页面已经开着才改设置」；
 * 只测 1 会漏掉「boot 时就不该挂监听」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const BASE = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * 公用：造一个 jsdom + 加载扩展脚本
 * ================================================================== */

const PAGE_URL = 'https://example.com/article/post-1';
const IMG_SRC = 'https://blog.example.com/wp-content/uploads/2024/05/hero-1024x768.jpg';

const HTML = `<!DOCTYPE html><html><body>
  <img id="a" src="${IMG_SRC}" data-nw="1024" data-nh="768" alt="文章主图">
</body></html>`;

/**
 * @param {object} opts
 *   opts.settings  初始设置（会写进 storage 桩）
 *   opts.withMain  是否加载 content/main.js
 */
function makeEnv(opts) {
  const o = opts || {};
  const dom = new JSDOM(HTML, { url: PAGE_URL, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;

  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 100, left: 100, right: 900, bottom: 700, x: 100, y: 100,
      toJSON() { return { width: 800, height: 600 }; } };
  };
  Object.defineProperty(window.HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true, get() { return parseInt(this.getAttribute('data-nw') || '0', 10); }
  });
  Object.defineProperty(window.HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true, get() { return parseInt(this.getAttribute('data-nh') || '0', 10); }
  });
  Object.defineProperty(window.HTMLImageElement.prototype, 'currentSrc', {
    configurable: true, get() { return this.getAttribute('src') || ''; }
  });

  window.Image = class FakeImage {
    constructor() { this.onload = null; this.onerror = null; this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
    set src(v) { this._src = v; setTimeout(() => { if (this.onerror) this.onerror(); }, 0); }
    get src() { return this._src; }
  };

  const sent = [];
  /* uiLang 钉成中文：jsdom 的 navigator.language 恒为 en-US，
     而断言写的是中文文案（浏览器套件那边用 locale: 'zh-CN'）。 */
  const storeData = { ih_settings: Object.assign({ uiLang: 'zh' }, o.settings || {}) };

  const ctx = dom.getInternalVMContext();
  ctx.console = console;
  ctx.chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => 'chrome-extension://fake/' + p,
      sendMessage: (msg, cb) => { sent.push(msg); setTimeout(() => { if (cb) cb({ ok: true }); }, 0); },
      onMessage: { addListener() {} },
      getManifest: () => ({ version: '0.0.0-test' })
    },
    storage: {
      local: {
        get: (k) => {
          const out = {};
          if (typeof k === 'string') { if (k in storeData) out[k] = storeData[k]; }
          else Object.assign(out, storeData);
          return Promise.resolve(out);
        },
        set: (obj) => { Object.assign(storeData, obj); return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    }
  };

  const load = (rel) => vm.runInContext(fs.readFileSync(path.join(BASE, rel), 'utf8'), ctx);
  load('shared/constants.js');
  load('shared/utils.js');
  load('shared/store.js');
  load('shared/i18n.js');       // 与 manifest 的清单同序
  load('content/scanner.js');
  load('content/hover.js');
  load('content/lightbox.js');

  /* 探针必须**赶在 main.js 之前**装好。
     main.js 一被求值就会调 boot()，而 boot 里第一句是 `await loadSettings()` ——
     也就是说 `IH.Hover.start()` 发生在几个微任务之后。先 `await` 再装探针是
     撞运气：碰巧赢了测试就是绿的，输了就变成「明明 start 过却记成 0 次」。
     直接在加载顺序上做保证，比在时序上做保证稳。 */
  const calls = { start: 0, hide: 0 };
  const realStart = ctx.IH.Hover.start;
  const realHide = ctx.IH.Hover.hide;
  ctx.IH.Hover.start = function () { calls.start++; return realStart.apply(this, arguments); };
  ctx.IH.Hover.hide = function () { calls.hide++; return realHide.apply(this, arguments); };

  if (o.withMain) load('content/main.js');

  return { dom, window, ctx, IH: ctx.IH, sent, storeData, calls };
}

const hoverHosts = (doc) => doc.querySelectorAll('[data-ih-host]').length;

/** 悬停一次并等过 hoverDelay（默认 120ms） */
async function hoverOnce(env) {
  const img = env.window.document.getElementById('a');
  img.dispatchEvent(new env.window.MouseEvent('mouseover', { bubbles: true }));
  await sleep(260);
}

(async function run() {

  /* ============================================================== *
   * 1. hover.js 自己的门（显示路径）
   * ============================================================== */
  console.log('=== 1. hover 的显示路径（不依赖 main.js 是否调用 start） ===');

  {
    const env = makeEnv({ settings: { blockedHosts: ['example.com'] } });
    await env.IH.Store.loadSettings();

    check(env.IH.Store.getSettings().blockedHosts.length === 1,
      '设置里的排除列表读进来了');

    // 刻意**手动** start：即便 main.js 因为某种原因还是挂了监听，
    // 显示路径也必须拦住 —— 这就是第二道门的价值
    env.IH.Hover.start();
    await hoverOnce(env);
    check(hoverHosts(env.window.document) === 0,
      '站点被排除时悬停不出现任何页内 UI',
      hoverHosts(env.window.document) + ' 个宿主');

    // Alt+点击也必须无效（它走的是同一条「页内 UI」语义）
    const img = env.window.document.getElementById('a');
    img.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
    await sleep(120);
    check(!env.sent.some((m) => m && m.type === 'IH_DOWNLOAD_ONE'),
      '站点被排除时 Alt+点击不会触发保存');

    // 解除排除 → 同一个页面（没重新加载）立刻恢复
    await env.IH.Store.updateSettings({ blockedHosts: [] });
    await hoverOnce(env);
    check(hoverHosts(env.window.document) === 1,
      '解除排除后同一个页面立刻恢复悬停按钮（不用刷新）',
      hoverHosts(env.window.document) + ' 个宿主');

    // 再加回去 → 已经浮出来的按钮要自己收掉（hover.js 的 onChange）
    await env.IH.Store.updateSettings({ blockedHosts: ['example.com'] });
    await sleep(60);
    const h = env.window.document.querySelector('[data-ih-host]');
    const b = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-hover');
    check(!b || !b.classList.contains('ih-show'),
      '重新排除后已浮出的按钮被收起（不用刷新页面）');

    // 而且不会再冒出来
    await hoverOnce(env);
    check(!b || !b.classList.contains('ih-show'), '收起之后再悬停也不会重新出现');

    env.dom.window.close();
  }

  /* ============================================================== *
   * 2. 子域名匹配 —— 别把「只是长得像」的站点也拦了
   * ============================================================== */
  console.log('\n=== 2. 子域名匹配的边界 ===');

  {
    // 页面在 www.example.com 上，排除的是 example.com → 应该拦
    const env = makeEnv({ settings: { blockedHosts: ['example.com'] } });
    await env.IH.Store.loadSettings();
    env.IH.Hover.start();
    // jsdom 的 location 改不了，直接查纯函数在真实地址上的结果
    check(env.IH.U.isHostBlocked('https://www.example.com/a', env.IH.Store.getSettings().blockedHosts) === true,
      'example.com 覆盖 www.example.com');
    check(env.IH.U.isHostBlocked('https://example.com.evil.com/a', env.IH.Store.getSettings().blockedHosts) === false,
      'example.com.evil.com 不被误伤（后缀伪装）');
    env.dom.window.close();
  }

  /* ============================================================== *
   * 3. main.js 的启动路径
   * ============================================================== */
  console.log('\n=== 3. main.js 启动 / 设置变化时的接线 ===');

  {
    const env = makeEnv({ settings: { blockedHosts: ['example.com'] }, withMain: true });

    await sleep(80);   // 等 boot 落地
    check(env.calls.start === 0, '站点被排除时 boot 不挂悬停监听', 'start 调了 ' + env.calls.start + ' 次');
    await hoverOnce(env);
    check(hoverHosts(env.window.document) === 0,
      'boot 被排除 → 悬停真的一张宿主都没有', hoverHosts(env.window.document) + ' 个宿主');

    // 解除排除 → main.js 的 onChange 应该补上监听
    await env.IH.Store.updateSettings({ blockedHosts: [] });
    await sleep(80);
    check(env.calls.start === 1, '解除排除后 main.js 补上悬停监听', 'start 调了 ' + env.calls.start + ' 次');
    await hoverOnce(env);
    check(hoverHosts(env.window.document) === 1, '补上之后悬停按钮真的出现了');

    // 再排除 → 由 hover 自己的 onChange 收起（main.js 不管这一半）
    await env.IH.Store.updateSettings({ blockedHosts: ['example.com'] });
    await sleep(80);
    const host = env.window.document.querySelector('[data-ih-host]');
    const bar = host && host.shadowRoot && host.shadowRoot.querySelector('.ih-hover');
    check(!bar || !bar.classList.contains('ih-show'),
      '再排除后按钮被收起（hover 自己负责，不依赖 main.js）');

    env.dom.window.close();
  }

  /* ============================================================== *
   * 4. 没被排除的站点不受影响（对照组）
   * ============================================================== */
  console.log('\n=== 4. 对照组：没被排除的站点一切照旧 ===');

  {
    const env = makeEnv({ settings: { blockedHosts: ['other.com', 'bank.example.cn'] } });
    await env.IH.Store.loadSettings();
    env.IH.Hover.start();
    await hoverOnce(env);
    check(hoverHosts(env.window.document) === 1,
      '排除列表里没有本站点时，悬停按钮照常出现',
      hoverHosts(env.window.document) + ' 个宿主');
    env.dom.window.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('套件异常：', e);
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(1);
});
