/* ImageHunter — 灯箱「在图库中打开」的回归测试（jsdom）
 *
 * 这个按钮补的是 v1.7.0 留下的一个半截能力：悬停预览手里只有鼠标压着的那一个
 * 元素，只能送 1 张进灯箱，于是 ←→ 是 disabled 的、缩略图条是隐藏的。
 * 用户看完这张想「再看看这一页还有什么」，原来只能关掉灯箱、点扩展图标、
 * 再到图库里重新找刚才那张。
 *
 * 三条最容易写错的：
 *   1. **按钮只在网页里显示**。图库页 / 面板里点它毫无意义（用户本来就在图库），
 *      面板模式下还会把焦点抢走。所以默认必须是「不显示」—— 漏传 host 时
 *      最坏是少一个按钮，而不是多一个点了没反应的。
 *   2. **发的必须是当前那张的地址**。灯箱能翻页，切到第二张之后按钮要跟着变。
 *   3. **失败不能关灯箱**。关了的话用户手里什么都没了，还以为是自己的操作有问题。
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
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://example.com/article/post-1',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;
const ctx = dom.getInternalVMContext();
ctx.console = console;

/* chrome 桩：记下发出去的消息，并按 nextResponse 回应 */
const sent = [];
let nextResponse = { ok: true };

ctx.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (p) => 'chrome-extension://fake/' + p,
    sendMessage: (msg, cb) => {
      sent.push(msg);
      setTimeout(() => { if (cb) cb(nextResponse); }, 0);
    },
    onMessage: { addListener() {} }
  },
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    onChanged: { addListener() {} }
  }
};

vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'content/lightbox.js'), 'utf8'), ctx);

const IH = ctx.IH;
const doc = window.document;
const ITEMS = [
  { url: 'https://cdn.example.com/a.png', width: 800, height: 600, alt: 'A' },
  { url: 'https://cdn.example.com/b.png', width: 400, height: 300, alt: 'B' }
];

function lbRoot() {
  const hosts = Array.from(doc.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    if (h.shadowRoot && h.shadowRoot.querySelector('.ih-lb')) return h.shadowRoot;
  }
  return null;
}
const galleryBtn = () => {
  const r = lbRoot();
  return r ? r.querySelector('[data-act="gallery"]') : null;
};

(async function run() {
  console.log('=== 1. 只有网页里的预览才显示这个按钮 ===');

  IH.Lightbox.open(ITEMS, 0, { pageUrl: 'https://example.com/article/post-1', host: 'content' });
  await sleep(40);
  let btn = galleryBtn();
  check(!!btn, '灯箱里有「在图库中打开」按钮');
  check(btn && btn.style.display !== 'none', 'host=content 时按钮可见',
    btn && ('display=' + (btn.style.display || '(空)')));
  check(btn && /在图库中打开/.test(btn.title || ''), '按钮 title 说明了它的用途', btn && btn.title);
  IH.Lightbox.close();
  await sleep(20);

  IH.Lightbox.open(ITEMS, 0, { pageUrl: 'https://example.com/p', host: 'gallery' });
  await sleep(40);
  btn = galleryBtn();
  check(btn && btn.style.display === 'none', 'host=gallery 时按钮隐藏',
    btn && ('display=' + btn.style.display));
  IH.Lightbox.close();
  await sleep(20);

  // 漏传 host（面板模式走的就是这条路）→ 默认不显示，最坏只是少一个按钮
  IH.Lightbox.open(ITEMS, 0, { pageUrl: 'https://example.com/p' });
  await sleep(40);
  btn = galleryBtn();
  check(btn && btn.style.display === 'none', '漏传 host 时不显示（默认按 gallery 处理）',
    btn && ('display=' + btn.style.display));

  console.log('\n=== 2. 点它要发对消息，并且带上当前那张的地址 ===');

  sent.length = 0;
  nextResponse = { ok: true };
  btn.click();
  await sleep(40);

  const msg = sent[sent.length - 1];
  check(!!msg, '发出了消息');
  check(msg && msg.type === IH.C.MSG.OPEN_GALLERY, '消息类型是 OPEN_GALLERY',
    msg && msg.type);
  check(msg && msg.payload && msg.payload.url === ITEMS[0].url,
    '带的是当前那张图的地址', msg && msg.payload && msg.payload.url);
  check(msg && msg.payload && msg.payload.pageUrl === 'https://example.com/p',
    '带上了图片真正所在的页面（图库据此选对目标标签页）',
    msg && msg.payload && msg.payload.pageUrl);
  check(!IH.Lightbox.isOpen(), '成功之后灯箱自己收掉（用户已经到图库那边了）');

  console.log('\n=== 3. 翻到第二张，发的就该是第二张 ===');

  sent.length = 0;
  IH.Lightbox.open(ITEMS, 0, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  galleryBtn().click();          // 先失败一次，验证灯箱还开着
  nextResponse = { ok: false, error: 'x' };
  await sleep(40);
  IH.Lightbox.close();
  await sleep(20);

  nextResponse = { ok: true };
  IH.Lightbox.open(ITEMS, 1, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  sent.length = 0;
  galleryBtn().click();
  await sleep(40);
  const msg2 = sent[sent.length - 1];
  check(msg2 && msg2.payload && msg2.payload.url === ITEMS[1].url,
    '定位到第二张时发的是第二张的地址', msg2 && msg2.payload && msg2.payload.url);

  console.log('\n=== 4. 失败不能把灯箱关掉 ===');

  sent.length = 0;
  nextResponse = { ok: false, error: '打不开图库' };
  IH.Lightbox.open(ITEMS, 0, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const b = galleryBtn();
  b.click();
  await sleep(60);
  check(IH.Lightbox.isOpen(), '打开失败时灯箱仍然开着（不能把用户手里的东西收走）');
  check(b.disabled === false, '失败后按钮恢复可点（可以再试一次）', 'disabled=' + b.disabled);

  // 后台完全没回应（扩展上下文丢了）也不能卡住
  IH.Lightbox.close();
  await sleep(20);
  IH.Lightbox.open(ITEMS, 0, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const b2 = galleryBtn();
  b2.click();
  await sleep(60);
  check(b2.disabled === false, '无响应时按钮也会恢复，不会一直卡在禁用态');

  console.log('\n=== 5. 顺手：快捷键要的 save 也导出了 ===');

  check(typeof IH.Lightbox.save === 'function',
    'IH.Lightbox.save 存在（快捷键「保存悬停图」在灯箱开着时用它）');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
