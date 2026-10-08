/* ImageHunter — 悬停快捷操作端到端测试
 * 覆盖：悬停出现「预览 + 下载」两个按钮 → 点下载解析原图并 DOWNLOAD_ONE → 成功态反馈
 *       → 点预览就地开灯箱（不跳走、不误触发下载）
 * 并附带 overlay.css 的 pointer-events 回归断言（防止「图标可见但点不动」再次发生）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const BASE = require('path').resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * 第一部分：overlay.css 静态回归断言
 * ================================================================== */

console.log('=== 1. overlay.css 结构 / pointer-events 回归断言 ===');
const css = fs.readFileSync(path.join(BASE, 'content/overlay.css'), 'utf8');

function ruleBody(selector) {
  const idx = css.indexOf('\n' + selector + ' {');
  if (idx < 0) return null;
  const start = css.indexOf('{', idx);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

const baseRule = ruleBody('.ih-hover');
const showRule = ruleBody('.ih-hover.ih-show');
const btnRule = ruleBody('.ih-hover-btn');

check(baseRule !== null, '找到 .ih-hover 基础规则');
check(baseRule && /pointer-events:\s*none/.test(baseRule),
  '隐藏状态下 .ih-hover 为 pointer-events:none（不拦截页面点击）');
check(showRule !== null, '找到 .ih-hover.ih-show 规则');
check(showRule && /pointer-events:\s*auto/.test(showRule),
  '显示状态下 .ih-hover.ih-show 为 pointer-events:auto（可点击）');

// .ih-hover 已从「一个按钮」升级成「一排按钮的容器」：
// 容器负责定位与显隐，真正的按钮是 .ih-hover-btn。少任何一半都会退化成
// 「按钮堆在左上角」或「看得见点不动」。
check(btnRule !== null, '找到 .ih-hover-btn 规则（按钮本身）');
check(btnRule && /width:\s*32px/.test(btnRule) && /height:\s*32px/.test(btnRule),
  '.ih-hover-btn 为 32×32（与 hover.js 的 BTN_SIZE 一致）');
check(baseRule && /display:\s*flex/.test(baseRule), '.ih-hover 用 flex 横排按钮');
check(baseRule && /gap:\s*6px/.test(baseRule),
  '.ih-hover 间距 6px（与 hover.js 的 BTN_GAP 一致，否则定位会偏）');
check(!/width:\s*32px/.test(baseRule),
  '.ih-hover 容器不再写死 32px 宽（写死会把第二个按钮挤出去）');

const hostStyleSrc = fs.readFileSync(path.join(BASE, 'content/hover.js'), 'utf8');
check(/pointer-events:none/.test(hostStyleSrc), 'hover 宿主元素确实设为 pointer-events:none');

// JS 与 CSS 的尺寸常量必须成对出现，否则改一处就会静默错位
check(/BTN_SIZE\s*=\s*32/.test(hostStyleSrc) && /BTN_GAP\s*=\s*6/.test(hostStyleSrc),
  'hover.js 中 BTN_SIZE=32 / BTN_GAP=6 与 CSS 对齐');
check(/BAR_W\s*=\s*BTN_SIZE\s*\*\s*2\s*\+\s*BTN_GAP/.test(hostStyleSrc),
  '整排宽度按「按钮数 × 尺寸 + 间距」算出来，不是写死的魔法数');

/* ================================================================== *
 * 第二部分：端到端交互测试
 * ================================================================== */

console.log('\n=== 2. 悬停 → 点击下载 → 保存 端到端 ===');

const SIZE_MAP = {
  'https://blog.example.com/wp-content/uploads/2024/05/hero-1024x768.jpg': { w: 1024, h: 768 },
  'https://blog.example.com/wp-content/uploads/2024/05/hero.jpg': { w: 2400, h: 1800 }
};

/* 页面上放三张图，是为了让「预览能翻本页全部图片」这条需求可测：
   只放一张的话，灯箱里是 1 张还是 3 张根本看不出区别，断言会恒真。 */
const HTML = `<!DOCTYPE html><html><body>
  <img id="a"
       src="https://blog.example.com/wp-content/uploads/2024/05/hero-1024x768.jpg"
       data-nw="1024" data-nh="768" alt="文章主图">
  <img id="b"
       src="https://blog.example.com/wp-content/uploads/2024/05/second-1024x768.jpg"
       data-nw="1024" data-nh="768" alt="第二张">
  <img id="c"
       src="https://blog.example.com/wp-content/uploads/2024/05/third-1024x768.jpg"
       data-nw="1024" data-nh="768" alt="第三张">
</body></html>`;

const dom = new JSDOM(HTML, {
  url: 'https://example.com/article/post-1',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
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
  set src(v) {
    this._src = v;
    setTimeout(() => {
      const s = SIZE_MAP[v];
      if (s) { this.naturalWidth = s.w; this.naturalHeight = s.h; if (this.onload) this.onload(); }
      else if (this.onerror) this.onerror();
    }, 0);
  }
  get src() { return this._src; }
};

/* -------- chrome API 桩 -------- */

const sent = [];
const storeData = {};

const ctx = dom.getInternalVMContext();
ctx.console = console;

// 可切换的响应，用来验证不同后台结果下气泡文案是否正确。
// 也可以是函数 —— 预览会同时发 SCAN_TAB 和 OPEN_LIGHTBOX，两类要分别给不同的结果。
let nextResponse = { ok: true };
// 让「整理本页图片」这一步慢下来。0ms 就回包的话加载态一闪而过，根本观察不到。
let scanDelay = 0;

ctx.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (p) => 'chrome-extension://fake/' + p,
    sendMessage: (msg, cb) => {
      sent.push(msg);
      // 模拟 background 响应
      const r = typeof nextResponse === 'function' ? nextResponse(msg) : nextResponse;
      const d = msg && msg.type === 'IH_SCAN_TAB' ? scanDelay : 0;
      setTimeout(() => { if (cb) cb(r); }, d);
    },
    onMessage: { addListener() {} }
  },
  storage: {
    local: {
      get: (k) => Promise.resolve({}),
      set: (o) => { Object.assign(storeData, o); return Promise.resolve(); }
    },
    onChanged: { addListener() {} }
  }
};

vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'content/scanner.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'content/hover.js'), 'utf8'), ctx);
// 悬停的预览键会直接调用 IH.Lightbox —— 灯箱必须真的加载进来，
// 否则 openPreview 只会弹一句「预览组件未加载」而测试照样"通过"。
vm.runInContext(fs.readFileSync(path.join(BASE, 'content/lightbox.js'), 'utf8'), ctx);

const IH = ctx.IH;
const doc = window.document;

(async function run() {
  IH.Hover.start();

  const img = doc.getElementById('a');

  // --- 悬停 ---
  img.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await sleep(250);   // hoverDelay 默认 120ms

  const host = doc.querySelector('[data-ih-host]');
  check(!!host, '悬停后创建了 Shadow DOM 宿主');

  const bar = host && host.shadowRoot && host.shadowRoot.querySelector('.ih-hover');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('.ih-hover-save');
  const pv = host && host.shadowRoot && host.shadowRoot.querySelector('.ih-hover-preview');

  check(!!bar, '宿主内存在 .ih-hover 容器');
  check(!!btn, '容器内存在下载按钮 .ih-hover-save');
  check(!!pv, '容器内存在预览按钮 .ih-hover-preview');

  await sleep(60);    // 等一帧 rAF
  check(bar && bar.classList.contains('ih-show'), '容器进入 ih-show 显示态');
  check(bar && bar.style.left && bar.style.top, '容器已完成定位',
    bar && (bar.style.left + ',' + bar.style.top));

  // JS 层兜底：jsdom 不会真正加载 overlay.css，所以此处的点击成功
  // 恰好证明了「即使样式表加载失败，按钮依然可点击」
  check(bar && bar.style.pointerEvents === 'auto',
    '容器已通过内联样式启用 pointer-events（CSS 未加载时也可点击）', bar && bar.style.pointerEvents);

  /* --- 两个按钮的排布 ---
     下载键必须停在「图片右上角」那个老位置，预览键往左长出去。
     否则老用户的肌肉记忆会点错东西（本来想保存，结果开了预览）。 */
  check(bar && bar.children.length === 2, '容器内正好两个按钮',
    bar && String(bar.children.length));
  check(bar && bar.children[0] === pv && bar.children[1] === btn,
    '预览键在左、下载键在右');

  if (bar) {
    const left = parseInt(bar.style.left, 10);
    const top = parseInt(bar.style.top, 10);
    // rect.right=900 → 900 - (32*2+6) - 8 = 822
    check(left === 822, '整排右对齐贴住图片右上角', String(left));
    check(top === 108, '整排与图片顶边留 8px', String(top));
    // 旧版单按钮时 left = 900 - 32 - 8 = 860；新版下载键应仍在 860
    check(left + 32 + 6 === 860, '下载键仍停在原位置（860），预览键往左长出去',
      String(left + 32 + 6));
  }

  // --- 点击下载 ---
  const before = sent.length;
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  // saveElement() 在首个 await 之前就同步置入 saving 态，所以这里必须【同步】断言。
  // 不能先 sleep：桩环境里 background 0ms 就回包，等一拍就已经跳到 done 态了。
  check(btn.classList.contains('ih-saving'), '点击后立即进入 saving 态（有即时反馈）');

  await sleep(800);   // 等解析原图 + 发送消息

  check(sent.length > before, '点击后确实向 background 发送了消息');

  const msg = sent.slice(before).find((m) => m && m.type === 'IH_DOWNLOAD_ONE');
  check(!!msg, '发送的是 DOWNLOAD_ONE 消息');

  if (msg) {
    const p = msg.payload || {};
    check(p.url === 'https://blog.example.com/wp-content/uploads/2024/05/hero.jpg',
      '下载的是【还原后的原图】而非页面上的缩略图', p.url);
    check(p.width === 2400 && p.height === 1800, '携带了真实像素尺寸', p.width + 'x' + p.height);
    check(/\.jpg$/.test(p.filename || ''), '文件名合法', p.filename);
    check(p.filename === 'hero.jpg', '文件名取自原图地址', p.filename);
    check(p.pageUrl === 'https://example.com/article/post-1', '携带了来源页地址');
  }

  // --- 成功态 ---
  check(btn.classList.contains('ih-done'), '收到成功响应后进入 ih-done 态');
  const bubble = host.shadowRoot.querySelector('.ih-bubble');
  check(bubble && bubble.textContent.indexOf('已保存原图') >= 0, '显示了成功提示气泡',
    bubble && bubble.textContent);

  /* --------------------------------------------------------------- *
   * 回归：「提示已保存但实际没保存」的两个分支
   * --------------------------------------------------------------- */

  // 分支 A —— 后台返回 skipped（命中「跳过已下载」），不能说成「已保存」
  nextResponse = { ok: true, skipped: true, url: 'x', reason: '已下载过' };
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(700);
  const bubble2 = host.shadowRoot.querySelector('.ih-bubble');
  check(bubble2 && bubble2.textContent.indexOf('已跳过') >= 0,
    '后台返回 skipped 时提示「已跳过」', bubble2 && bubble2.textContent);
  check(bubble2 && bubble2.textContent.indexOf('已保存') < 0,
    '被跳过时不再出现「已保存」字样', bubble2 && bubble2.textContent);

  // 分支 B —— Chrome 按真实 MIME 纠正了扩展名，必须告知实际文件名
  nextResponse = { ok: true, filename: 'abc.avif', renamed: true, bytes: 999 };
  await sleep(1500);   // 等 resetTimer 把状态复位
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(700);
  const bubble3 = host.shadowRoot.querySelector('.ih-bubble');
  check(bubble3 && bubble3.textContent.indexOf('abc.avif') >= 0,
    '扩展名被 Chrome 纠正时提示实际文件名', bubble3 && bubble3.textContent);

  /* =============================================================== *
   * 3. 悬停预览键 → 就地开灯箱
   * =============================================================== */

  console.log('\n=== 3. 悬停预览键 → 就地开灯箱（不跳走、不误下载）===');

  // 守卫：预览键不存在时（例如有人把功能改回单按钮）第 3 节没法跑。
  // 直接 dispatchEvent(null) 会抛 TypeError 打断整个套件，只留下一个
  // 「测试异常」的堆栈 —— 那样等于用崩溃冒充失败，看不出是哪条需求没了。
  if (!pv || !bar || !btn) {
    check(false, '预览按钮缺失，第 3 节无法执行（功能被改回单按钮？）');
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
  }

  // 让状态复位并重新悬停，拿到一个干净的 target
  await sleep(1500);
  img.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await sleep(250);

  check(bar.classList.contains('ih-show'), '重新悬停后按钮再次出现');

  const beforePreview = sent.length;
  pv.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(800);   // 等 resolveForElement 解析原图

  check(IH.Lightbox.isOpen(), '点预览后灯箱已打开');

  const lbHost = doc.querySelectorAll('[data-ih-host]')[1];
  check(!!lbHost, '灯箱自建了 Shadow DOM 宿主（与悬停 UI 互不干扰）');

  const lb = lbHost && lbHost.shadowRoot && lbHost.shadowRoot.querySelector('.ih-lb');
  check(!!lb, '灯箱宿主内存在 .ih-lb');

  const lbImg = lbHost && lbHost.shadowRoot.querySelector('.ih-lb-img');
  check(lbImg && lbImg.getAttribute('src') === 'https://blog.example.com/wp-content/uploads/2024/05/hero.jpg',
    '灯箱显示的是【还原后的原图】', lbImg && lbImg.getAttribute('src'));

  const lbTitle = lbHost && lbHost.shadowRoot.querySelector('.ih-lb-title');
  check(lbTitle && lbTitle.textContent === '文章主图', '灯箱标题取图片 alt',
    lbTitle && lbTitle.textContent);

  const downloadMsgs = sent.slice(beforePreview).filter((m) => m && m.type === 'IH_DOWNLOAD_ONE');
  check(downloadMsgs.length === 0,
    '点预览【不会】误触发下载', downloadMsgs.length + ' 条 DOWNLOAD_ONE');

  check(!bar.classList.contains('ih-show'), '开预览后悬停按钮自动收起，不压在灯箱上');

  // 灯箱开着时不应再冒出悬停按钮
  img.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  await sleep(250);
  check(!bar.classList.contains('ih-show'), '灯箱打开期间悬停不再弹出按钮');

  IH.Lightbox.close();
  await sleep(320);
  check(!IH.Lightbox.isOpen() && !lb.classList.contains('ih-show'), '可以正常关闭灯箱');

  /* =============================================================== *
   * 4. 灯箱是页内模态：背景不该跟着滚
   * =============================================================== */

  console.log('\n=== 4. 灯箱锁住背景滚动 ===');

  // 页内 UI 都在 Shadow DOM 里，document.querySelector 看不见 —— 必须进 shadowRoot
  function lightboxRoot() {
    const hosts = Array.from(doc.querySelectorAll('[data-ih-host]'));
    for (const h of hosts) {
      if (h.shadowRoot && h.shadowRoot.querySelector('.ih-lb')) return h.shadowRoot;
    }
    return null;
  }

  // jsdom 的 clientWidth 恒为 0，会让「滚动条宽度补偿」完全测不出来。
  // 给一个比 innerWidth 小 24 的值，模拟 Windows 上 24px 常驻滚动条。
  const de = doc.documentElement;
  Object.defineProperty(de, 'clientWidth', { configurable: true, get() { return 1000; } });
  check(window.innerWidth === 1024, 'jsdom 视口宽 1024，与 clientWidth 差 24px',
    String(window.innerWidth));

  // 页面自己原本就有 overflow / padding。还原时必须还回**这两个原值**，
  // 不能写死成 '' —— 否则会把页面自己的布局改掉。
  de.style.overflow = 'auto';
  de.style.paddingRight = '10px';

  IH.Lightbox.open([
    { url: 'https://ex.com/1.jpg', width: 100, height: 100, alt: '一' },
    { url: 'https://ex.com/2.jpg', width: 100, height: 100, alt: '二' }
  ], 0, { pageUrl: 'https://example.com/article/post-1' });
  await sleep(80);

  check(IH.Lightbox.isOpen(), '灯箱已打开');
  check(de.style.overflow === 'hidden', '打开后 html 的 overflow 被锁成 hidden', de.style.overflow);
  check(de.style.paddingRight === '34px',
    '补偿了 24px 滚动条宽度（页面原 10px + 24px）', de.style.paddingRight);
  check(doc.body.style.overflow === 'hidden',
    'body 的 overflow 也一并锁上（有的页面靠 body 滚，不锁会漏）');

  // 记下锁定后的值。下面「关闭后还原」那几条必须跟它一起看才有意义 ——
  // 单看「关闭后 === 页面原值」，在「压根没锁」的旧行为下**也为真**（值一直没变过）。
  const lockedOverflow = de.style.overflow;
  const lockedPadding = de.style.paddingRight;

  const lbRoot = lightboxRoot();
  if (!lbRoot) {
    check(false, '找不到灯箱 Shadow DOM 宿主，第 4 节无法继续');
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
  }
  const lbImgEl = lbRoot.querySelector('.ih-lb-img');
  const stripEl = lbRoot.querySelector('.ih-lb-strip');

  function wheelOn(el, deltaY) {
    const e = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
    el.dispatchEvent(e);
    return e;
  }

  // 关键回归：原来 onWheel 第一行是 `if (!loaded) return;`，
  // 于是图片还在加载 / 加载失败时，滚轮会直接穿透到灯箱后面的页面。
  // jsdom 不会真的加载图片，此刻 loaded 恰好是 false —— 正是要测的状态。
  check(wheelOn(lbImgEl, 120).defaultPrevented,
    '图片【尚未加载完】时滚轮也被拦住（原来会穿透到后面的页面）');

  // 加载完之后滚轮仍然拦住，并且用于缩放
  lbImgEl.dispatchEvent(new window.Event('load'));
  const zoomEv = wheelOn(lbImgEl, -100);
  check(zoomEv.defaultPrevented, '加载完后滚轮依然被拦住');
  const zoomVal = lbRoot.querySelector('.ih-lb-zoom-val').textContent;
  check(zoomVal !== '100%', '滚轮确实驱动了缩放', zoomVal);

  // 缩略图条自己要横向滚。浏览器不会把竖向滚轮转成横向滚动（实测条上是个死区），
  // 所以 onWheel 必须自己接管：拦住事件 + 把 deltaY 加到 scrollLeft 上。
  const stripEv = wheelOn(stripEl, 120);
  check(stripEv.defaultPrevented, '缩略图条上的滚轮被接管（不穿透到页面，也不缩放）');
  check(stripEl.scrollLeft === 120,
    '条的 scrollLeft 真的被推进了 120px（竖向滚轮映射成横向滚动）', String(stripEl.scrollLeft));
  const zoomAfterStrip = lbRoot.querySelector('.ih-lb-zoom-val').textContent;
  check(zoomAfterStrip === zoomVal, '滚条不会改变缩放', zoomVal + ' → ' + zoomAfterStrip);

  function key(k) {
    const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    doc.dispatchEvent(e);
    return e;
  }

  // 空格 / ↑↓ / PageUp / PageDown 才是用户翻页最常按的键。
  // 原来 onKeyDown 只拦 Esc/←/→，这些键会把底下的文章滚走。
  check(key(' ').defaultPrevented, '空格被拦住（否则关掉灯箱文章已经翻页了）');
  check(key('PageDown').defaultPrevented, 'PageDown 被拦住');
  check(key('PageUp').defaultPrevented, 'PageUp 被拦住');
  check(key('ArrowUp').defaultPrevented, 'ArrowUp 被拦住');
  check(key('ArrowDown').defaultPrevented, 'ArrowDown 被拦住');
  check(key('Home').defaultPrevented, 'Home 被拦住');
  check(key('End').defaultPrevented, 'End 被拦住');
  check(!key('a').defaultPrevented, '无关按键不受影响');

  // --- 关闭后必须还原成页面自己的原值 ---
  IH.Lightbox.close();
  await sleep(320);
  check(!IH.Lightbox.isOpen(), '灯箱已关闭');
  check(lockedOverflow === 'hidden' && de.style.overflow === 'auto',
    '关闭后 html 的 overflow 从 hidden 还原成页面原本的 auto（不是写死成空）',
    JSON.stringify(lockedOverflow) + ' → ' + JSON.stringify(de.style.overflow));
  check(lockedPadding === '34px' && de.style.paddingRight === '10px',
    '关闭后 paddingRight 从补偿值还原成页面原本的 10px（不留下 34px）',
    JSON.stringify(lockedPadding) + ' → ' + JSON.stringify(de.style.paddingRight));
  check(doc.body.style.overflow === '',
    '关闭后 body 的 overflow 还原成空', JSON.stringify(doc.body.style.overflow));

  /* =============================================================== *
   * 5. 预览能翻本页全部图片（不再「只能看这一张」）
   *
   * 回归的是这个缺口：悬停预览过去只把鼠标压着的那一张塞进灯箱，
   * 左右切换键形同虚设 —— 想看下一张得退出去再一张张点开。
   * =============================================================== */

  console.log('\n=== 5. 预览能翻本页全部图片 ===');

  const HERO = 'https://blog.example.com/wp-content/uploads/2024/05/hero.jpg';
  const SECOND = 'https://blog.example.com/wp-content/uploads/2024/05/second.jpg';
  const THIRD = 'https://blog.example.com/wp-content/uploads/2024/05/third.jpg';

  /* 后台那份结果按**文档顺序**给，但故意把当前这张放在中间 ——
     起始下标要是对不上，灯箱打开的就是别人的图，这一条立刻变红。 */
  const scanImages = [
    { url: SECOND, width: 800, height: 600, alt: '第二张', order: 0 },
    { url: HERO, width: 2400, height: 1800, alt: '文章主图', order: 1, restored: true },
    { url: THIRD, width: 800, height: 600, alt: '第三张', order: 2 }
  ];

  function lbParts() {
    const root = lightboxRoot();
    if (!root) return null;
    return {
      img: root.querySelector('.ih-lb-img'),
      meta: root.querySelector('.ih-lb-meta'),
      strip: root.querySelector('.ih-lb-strip'),
      next: root.querySelector('.ih-lb-next')
    };
  }

  async function hoverAndPreview() {
    if (IH.Lightbox.isOpen()) { IH.Lightbox.close(); await sleep(320); }
    nextResponse = (msg) => (msg && msg.type === 'IH_SCAN_TAB'
      ? { ok: true, images: scanImages }
      : { ok: true });
    img.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    await sleep(250);
    return sent.length;
  }

  /* ---- 5.1 加载态：点了不能像没反应 ---- */
  scanDelay = 600;   // 让「整理本页图片」跑满 600ms，加载态才观察得到
  let mark = await hoverAndPreview();
  check(bar.classList.contains('ih-show'), '5.1 重新悬停后按钮出现');

  const busySeen = { on: false, bubble: '', spinner: false };
  pv.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 80 && !busySeen.on; i++) {
    await sleep(20);
    if (pv.classList.contains('ih-busy')) {
      busySeen.on = true;
      busySeen.spinner = !!pv.querySelector('.ih-spinner');
      busySeen.bubble = bubble.textContent;
    }
  }
  check(busySeen.on, '5.1 整理本页图片期间预览键进入忙碌态（不是「点了没反应」）');
  check(busySeen.spinner, '5.1 忙碌态里是转圈图标', JSON.stringify(busySeen));
  check(busySeen.bubble.indexOf('正在整理本页图片') >= 0,
    '5.1 气泡说清在等什么', busySeen.bubble);

  const scanMsgs = sent.slice(mark).filter((m) => m && m.type === 'IH_SCAN_TAB');
  check(scanMsgs.length > 0, '5.1 点了预览会去整理本页图片（发了 SCAN_TAB）',
    scanMsgs.length + ' 条');
  check(scanMsgs.length > 0 && scanMsgs[0].finalOnly === true,
    '5.1 要的是【最终结果】而非「先出图」的 partial（否则会拿到未还原的地址）',
    JSON.stringify(scanMsgs[0]));

  /* ---- 5.2 打开的是整份列表，且定位到当前那张 ---- */
  for (let i = 0; i < 80 && !IH.Lightbox.isOpen(); i++) await sleep(20);
  check(IH.Lightbox.isOpen(), '5.2 整理完成后灯箱打开');
  check(!pv.classList.contains('ih-busy'), '5.2 整理完成后忙碌态已解除');

  let p = lbParts();
  check(!!p, '5.2 找到灯箱 DOM');
  if (p) {
    check(p.img.getAttribute('src') === HERO,
      '5.2 打开的就是鼠标压着那张（已还原的原图）', p.img.getAttribute('src'));
    check(/2\s*\/\s*3/.test(p.meta.textContent),
      '5.2 计数是「2 / 3」—— 列表是本页全部图片，且起始下标落在当前那张（不是 1 / 1）',
      p.meta.textContent);
    check(p.strip.querySelectorAll('.ih-lb-thumb').length === 3,
      '5.2 缩略图条铺出了全部 3 张',
      String(p.strip.querySelectorAll('.ih-lb-thumb').length));
    check(!p.next.disabled, '5.2 有下一张可翻（按钮不再禁用）');
  }

  /* ---- 5.3 翻页 ---- */
  if (p) {
    p.next.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(80);
    check(p.img.getAttribute('src') === THIRD,
      '5.3 点「下一张」切到了页面顺序上的下一张', p.img.getAttribute('src'));
    check(/3\s*\/\s*3/.test(p.meta.textContent), '5.3 计数跟着走到 3 / 3', p.meta.textContent);

    // 键盘 → 也是同一条路
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await sleep(80);
    check(p.img.getAttribute('src') === SECOND,
      '5.3 → 键翻到最后一张会绕回第一张', p.img.getAttribute('src'));
  }

  /* ---- 5.4 后台那条路不通时：本地兜底，但仍不能退回缩略图 ----
     这一节是 5.2 的镜像：列表里存的是页面上的地址（没跑还原），
     命中的那一项必须换成 resolveForElement 解析出来的已还原版本。
     不做这步替换的话，用户点开看到的是 1024×768 的缩略图。 */
  scanDelay = 0;
  mark = await hoverAndPreview();
  nextResponse = (msg) => (msg && msg.type === 'IH_SCAN_TAB'
    ? { ok: true, images: [] }      // 后台给了个空结果 —— 走本地兜底
    : { ok: true });

  pv.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 80 && !IH.Lightbox.isOpen(); i++) await sleep(20);
  check(IH.Lightbox.isOpen(), '5.4 后台没给结果时灯箱照样打开（点击不落空）');

  p = lbParts();
  if (p) {
    check(/\/ 3/.test(p.meta.textContent),
      '5.4 降级后仍然拿到了本页全部图片（本地采集兜底，不是只剩 1 张）',
      p.meta.textContent);
    check(p.img.getAttribute('src') === HERO,
      '5.4 降级后打开的仍是【已还原的原图】而非页面上的缩略图',
      p.img.getAttribute('src'));
  }
  IH.Lightbox.close();
  await sleep(320);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
