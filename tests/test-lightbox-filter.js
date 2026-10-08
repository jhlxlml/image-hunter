/* ImageHunter — 灯箱「按最小尺寸过滤」的回归测试（jsdom）
 *
 * 这个设置补的是：从页面 / 图库点开大图预览后，≤64px 的小图标、分隔条、
 * 雪碧图碎片也在 ← → 里一起翻，翻十几张才看到正文那张。
 *
 * 设计要求（用户明确选过的三条）：
 *   1. **只管灯箱**。图库卡片、批量下载、悬停图标一律不受影响 ——
 *      所以过滤落在 lightbox.open()，不在 scanner.isValidCandidate()
 *      （那个被图库和批量下载共用，放那儿就违反这条）。
 *   2. 判据是**较短边**：宽高都必须达标。只看最长边的话，
 *      分隔条那种 1200×8 反而会被当成合格图放进来。
 *   3. **默认 64，开箱即过滤**；阈值 0 = 不过滤（用户想关掉就能关掉）。
 *
 * 另外三条容易写错、这里逐条钉住：
 *   - 过滤后**定位不能偏**。startIndex 是原列表下标，过滤会挤走前面的项，
 *     所以必须先按地址认位置、再重新定位。否则「点第 6 张、打开是第 2 张」。
 *   - 尺寸**未知要放行**。探测超时的图不该被静默藏起来 —— 判断权交给用户，
 *     不交给超时。
 *   - 被挡掉的张数要**如实说出来**。不说的话用户只会以为「嗅探漏图了」。
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

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://example.com/article/post-1',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;
const ctx = dom.getInternalVMContext();
ctx.console = console;

/* chrome.storage 桩：get 回我们要的这份设置，Store 就会把它铺成完整设置。
   Get 必须按 key 分流 —— 加载 settings 的表叫 ih_settings（C.STORAGE_KEYS.SETTINGS），
   一律返回同一份 `stored` 会把 settings 自己也当成设置塞进去。 */
let stored = {};
ctx.chrome = {
  runtime: {
    lastError: undefined,
    getURL: (p) => 'chrome-extension://fake/' + p,
    sendMessage: () => Promise.resolve({ ok: true }),
    onMessage: { addListener() {} }
  },
  storage: {
    local: {
      get: (key) => {
        const out = {};
        const keys = typeof key === 'string' ? [key] : Object.keys(key || {});
        for (const k of keys) {
          if (k === 'ih_settings') out[k] = stored;
          else if (key && typeof key === 'object') out[k] = key[k];
        }
        return Promise.resolve(out);
      },
      set: () => Promise.resolve()
    },
    onChanged: { addListener() {} }
  }
};

vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'content/lightbox.js'), 'utf8'), ctx);

const IH = ctx.IH;
const doc = window.document;

/* 一份「真实页面会给出的」列表：
 *   下标 0  48×48   收藏图标        → 该被滤掉
 *   下标 1  1200×8  分隔条          → 该被滤掉（只按最长边判的话它会漏网）
 *   下标 2  640×480 正文图          → 留下
 *   下标 3  0×0     尺寸探测超时    → **放行**（未知不能当小）
 *   下标 4  1024×768 正文大图       → 留下
 *   下标 5  16×16   小图标          → 该被滤掉
 */
const ITEMS = [
  { url: 'https://cdn.example.com/icon48.png', width: 48, height: 48 },
  { url: 'https://cdn.example.com/divider.png', width: 1200, height: 8 },
  { url: 'https://cdn.example.com/body.png', width: 640, height: 480 },
  { url: 'https://cdn.example.com/unknown.png', width: 0, height: 0 },
  { url: 'https://cdn.example.com/hero.png', width: 1024, height: 768 },
  { url: 'https://cdn.example.com/icon16.png', width: 16, height: 16 }
];

const lbRoot = () => {
  const hosts = Array.from(doc.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    if (h.shadowRoot && h.shadowRoot.querySelector('.ih-lb')) return h.shadowRoot;
  }
  return null;
};
const metaText = () => (lbRoot().querySelector('.ih-lb-meta') || {}).textContent || '';
const thumbSrcs = () => Array.from(
  lbRoot().querySelectorAll('.ih-lb-thumb img')
).map((i) => i.getAttribute('src'));

/** 换一份 storage 里的设置，并让 Store 丢掉缓存重读一次。
 *  loadSettings(true) 只是把 cached promise 换掉 —— storage.get 是同步 resolve 的
 *  微任务，所以这里 await 之后缓存已经是新值了。 */
async function useSettings(patch) {
  stored = patch;
  await IH.Store.loadSettings(true);
}

(async function run() {
  await IH.Store.loadSettings(true);

  /* ================================================================ *
   * 1. 默认值就是 64（开箱即过滤），且语义与 minSize 无关
   * ================================================================ */
  console.log('=== 1. 默认 64，且与「悬停图标最小尺寸」是两个独立的键 ===');
  check(IH.C.DEFAULT_SETTINGS.lightboxMinSize === 64,
    'DEFAULT_SETTINGS.lightboxMinSize 默认 64（开箱即过滤）',
    String(IH.C.DEFAULT_SETTINGS.lightboxMinSize));
  check(IH.C.DEFAULT_SETTINGS.minSize === 64,
    'minSize（悬停图标那把尺子）保持原样 64 —— 没被顺手改掉',
    String(IH.C.DEFAULT_SETTINGS.minSize));

  /* ================================================================ *
   * 2. 过滤真的发生：三个小的出局，未知的放行
   * ================================================================ */
  console.log('\n=== 2. 按较短边过滤（默认 64）===');

  IH.Lightbox.open(ITEMS, 2, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);

  const f = IH.Lightbox.lastFilter();
  console.log('过滤现场 =', JSON.stringify(f));
  check(f.minSize === 64, '本轮阈值是 64', String(f.minSize));
  check(f.dropped === 3, '48×48 / 1200×8 / 16×16 三张被挡在灯箱外', String(f.dropped));
  check(f.kept === 3, '剩下 3 张（正文图 + 未知尺寸 + 正文大图）', String(f.kept));

  let thumbs = thumbSrcs();
  check(thumbs.indexOf('https://cdn.example.com/body.png') >= 0, '640×480 正文图留下了');
  check(thumbs.indexOf('https://cdn.example.com/hero.png') >= 0, '1024×768 正文大图留下了');
  check(thumbs.indexOf('https://cdn.example.com/unknown.png') >= 0,
    '尺寸未知（0×0）的**放行** —— 探测超时不该被静默藏起来',
    JSON.stringify(thumbs));
  check(thumbs.indexOf('https://cdn.example.com/icon48.png') < 0, '48×48 图标没进来');
  check(thumbs.indexOf('https://cdn.example.com/icon16.png') < 0, '16×16 图标没进来');
  /* 这条是本功能最核心的判据：1200×8 的分隔条，最长边 1200 远超 64，
     只有按「较短边」判才挡得住它。用最长边的话它会漏进来。 */
  check(thumbs.indexOf('https://cdn.example.com/divider.png') < 0,
    '1200×8 分隔条被挡住 —— 判据是较短边，不是最长边',
    JSON.stringify(thumbs));

  IH.Lightbox.close();
  await sleep(20);

  /* ================================================================ *
   * 3. 定位不偏：过滤后仍要停在用户点的那一张
   * ================================================================ */
  console.log('\n=== 3. 过滤后定位不偏（startIndex 是原列表下标）===');

  // 点的是下标 4（hero.png），前面三张被滤掉 → 关掉灯箱看它打开的是不是 hero
  IH.Lightbox.open(ITEMS, 4, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const img = lbRoot().querySelector('.ih-lb-img');
  check(img && /\/hero\.png/.test(img.getAttribute('src') || ''),
    '点第 5 张（hero）→ 打开的仍是 hero，不是被挤位后的第 2 张',
    img && img.getAttribute('src'));
  // 过滤后 hero 在第 3 位（body / unknown / hero）
  check(metaText().indexOf('3 / 3') >= 0, '计数显示 3 / 3（过滤后的列表长度）', metaText());
  IH.Lightbox.close();
  await sleep(20);

  // 点的是下标 3（unknown.png），它被放行，所以该停在新列表的第 2 位
  IH.Lightbox.open(ITEMS, 3, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const img2 = lbRoot().querySelector('.ih-lb-img');
  check(img2 && /\/unknown\.png/.test(img2.getAttribute('src') || ''),
    '点尺寸未知那张 → 打开的也是那一张（放行后仍能正确定位）',
    img2 && img2.getAttribute('src'));
  check(metaText().indexOf('2 / 3') >= 0, '它落在过滤后列表的第 2 位', metaText());
  IH.Lightbox.close();
  await sleep(20);

  /* ================================================================ *
   * 4. 计数要如实披露：不然用户以为嗅探漏图了
   * ================================================================ */
  console.log('\n=== 4. 被过滤的张数要告诉用户 ===');

  IH.Lightbox.open(ITEMS, 2, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const meta = metaText();
  console.log('灯箱 meta =', meta);
  check(meta.indexOf('已按 64px 过滤 3 张') >= 0,
    'meta 里写清「已按 64px 过滤 3 张」', meta);
  IH.Lightbox.close();
  await sleep(20);

  /* ================================================================ *
   * 5. 阈值 0 = 不过滤（能关掉）
   * ================================================================ */
  console.log('\n=== 5. 阈值 0 → 不过滤，一张都不少 ===');

  await useSettings({ lightboxMinSize: 0 });
  IH.Lightbox.open(ITEMS, 5, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const f0 = IH.Lightbox.lastFilter();
  console.log('过滤现场 =', JSON.stringify(f0));
  check(f0.minSize === 0, '阈值读出来是 0', String(f0.minSize));
  check(f0.dropped === 0, '一张都没被滤掉', String(f0.dropped));
  check(thumbSrcs().length === ITEMS.length,
    '缩略图条铺出了全部 ' + ITEMS.length + ' 张', String(thumbSrcs().length));
  check(metaText().indexOf('过滤') < 0, 'meta 里不出现「过滤」字样（没有可披露的）', metaText());
  IH.Lightbox.close();
  await sleep(20);

  /* ================================================================ *
   * 6. 阈值调高 / 调低都即时生效
   * ================================================================ */
  console.log('\n=== 6. 阈值可调 ===');

  await useSettings({ lightboxMinSize: 600 });
  IH.Lightbox.open(ITEMS, 4, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const fHigh = IH.Lightbox.lastFilter();
  check(fHigh.dropped === 4,
    '阈值提到 600 → 640×480 也被滤掉（480 < 600），加上原本三张共 4 张出局',
    JSON.stringify(fHigh));
  IH.Lightbox.close();
  await sleep(20);

  await useSettings({ lightboxMinSize: 16 });
  IH.Lightbox.open(ITEMS, 5, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const fLow = IH.Lightbox.lastFilter();
  check(fLow.dropped === 1,
    '阈值降到 16 → 只剩 1200×8 那张出局（旧的 48/16 图标都够大了）',
    JSON.stringify(fLow));
  IH.Lightbox.close();
  await sleep(20);

  /* ================================================================ *
   * 7. 兜底：阈值把**所有**候选都筛掉时，必须仍然打开用户点的那一张
   *
   * 「点了预览什么都没弹」是最糟的结果 —— 比多显示一张小图糟得多。
   * 但**提示不能跟着一起丢**：用户刚被这个阈值挡住，得让他看得见
   * 「已按 9999px 过滤 1 张」，否则孤零零的 1 / 1 只会让人以为嗅探坏了。
   *
   * 注意这条只在「全灭」时才可能触发：尺寸未知的一律放行，
   * 所以只要页面里有一张没探到尺寸的图，它就一定会活下来当锚点
   * （下面 7b 单独钉这一点）。这里挑页面「全部尺寸已知且全部过小」的情形，
   * 也就是真实的「点了一张小图标」场景。
   * ================================================================ */
  console.log('\n=== 7. 阈值把所有候选都筛掉 → 放弃过滤，照常打开 ===');

  const TINY_ONLY = [
    { url: 'https://cdn.example.com/t1.png', width: 16, height: 16 },
    { url: 'https://cdn.example.com/t2.png', width: 24, height: 24 }
  ];
  await useSettings({ lightboxMinSize: 9999 });
  IH.Lightbox.open(TINY_ONLY, 1, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const fAll = IH.Lightbox.lastFilter();
  const imgAll = lbRoot().querySelector('.ih-lb-img');
  console.log('过滤现场 =', JSON.stringify(fAll));
  check(IH.Lightbox.isOpen(), '灯箱照样打开了（没弹不出来）');
  check(imgAll && /\/t2\.png/.test(imgAll.getAttribute('src') || ''),
    '显示的就是用户点的那一张（哪怕它自己低于阈值）',
    imgAll && imgAll.getAttribute('src'));
  /* 阈值和「滤掉几张」都要留着 —— 用户刚被这个阈值挡住，
     必须让他看见「已按 9999px 过滤 1 张」，而不是孤零零的 1 / 1。
     清成 0 的话他只会以为「这页就这一张」/「嗅探坏了」。 */
  check(fAll.minSize === 9999 && fAll.dropped === 1,
    '如实报「已按 9999px 过滤 1 张」（不清零、不假装没过滤）',
    JSON.stringify(fAll));
  check(metaText().indexOf('已按 9999px 过滤 1 张') >= 0,
    'meta 里也看得到这句（用户唯一能看到的提示）', metaText());
  IH.Lightbox.close();
  await sleep(20);

  /* 7b. 尺寸未知的候选是天然锚点：只要它在，过滤就不会走到「全灭」兜底，
         用户点的那张小图仍会被自己顶回列表（锚点定位逻辑兜住）。 */
  console.log('\n=== 7b. 有未知尺寸项在时，点在极小图上仍能正常打开 ===');
  IH.Lightbox.open(ITEMS, 5, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  const f7b = IH.Lightbox.lastFilter();
  const img7b = lbRoot().querySelector('.ih-lb-img');
  console.log('过滤现场 =', JSON.stringify(f7b));
  check(IH.Lightbox.isOpen(), '灯箱打开');
  check(f7b.dropped === 5 && f7b.kept === 1,
    '9999 阈值下只有「尺寸未知」那张活下来', JSON.stringify(f7b));
  check(img7b && /\/unknown\.png/.test(img7b.getAttribute('src') || ''),
    '定位锚点自动落到唯一活下来的那张上（没有崩、没有白屏）',
    img7b && img7b.getAttribute('src'));
  IH.Lightbox.close();
  await sleep(20);

  /* ================================================================ *
   * 8. 只管灯箱：扫描结果不受影响
   *
   * 用户选的是「只影响大图预览」。所以这里反着钉一条：
   * lightbox 的过滤不能碰 Scanner —— scanner 那边既不 import 也不读这个键。
   * （正面的「图库仍显示小图」由 test-scanner.js 第 11 节守着。）
   * ================================================================ */
  console.log('\n=== 8. 过滤只发生在灯箱这一层 ===');

  const lbSrc = fs.readFileSync(path.join(BASE, 'content/lightbox.js'), 'utf8');
  check(/lightboxMinSize/.test(lbSrc), 'lightbox.js 里确实读了 lightboxMinSize');

  const scannerSrc = fs.readFileSync(path.join(BASE, 'content/scanner.js'), 'utf8');
  check(!/lightboxMinSize/.test(scannerSrc),
    'scanner.js **没有**读它 —— 图库列表与批量下载因此完全不受影响',
    '一旦 scanner 也读它，「只影响预览」这条就不再成立');
  const popupSrc = fs.readFileSync(path.join(BASE, 'popup/popup.js'), 'utf8');
  check(!/lightboxMinSize/.test(popupSrc),
    'popup.js 也没读它（图库卡片列表不过滤）');

  /* ================================================================ *
   * 9. 设置读失败时按「不过滤」处理，不能把预览拖死
   * ================================================================ */
  console.log('\n=== 9. 设置读异常 → 退回不过滤（预览不能打不开）===');

  // 把 Store.getSettings 打成会抛的桩，模拟设置层坏掉
  const realGet = IH.Store.getSettings;
  IH.Store.getSettings = () => { throw new Error('boom'); };
  IH.Lightbox.open(ITEMS, 2, { pageUrl: 'https://example.com/p', host: 'content' });
  await sleep(40);
  check(IH.Lightbox.isOpen(), '设置读崩了也照样打开灯箱');
  check(IH.Lightbox.lastFilter().minSize === 0, '退回「不过滤」而不是抛出去',
    JSON.stringify(IH.Lightbox.lastFilter()));
  IH.Lightbox.close();
  await sleep(20);
  IH.Store.getSettings = realGet;

  /* ================================================================ *
   * 10. 导入 / 导出：新键自动进白名单
   *
   * mergeImportedSettings 是**白名单**（遍历 defaults 的键），但它只搬
   * 「导入文件里真的有」的字段 —— 文件里没有的键保持用户现状，不顺手清空。
   * 所以正确的断言是两条：
   *   a) 新键在文件里时能被搬进来（白名单认得它）
   *   b) 不在文件里时不出现（不会被当成未知键丢弃，也不会塞个默认值进去）
   * 补默认值是 withDefaults（Store 那一层）的职责，不是这里的。
   * ================================================================ */
  console.log('\n=== 10. 新旧配置互通（导入白名单自动纳入）===');

  const merged = IH.U.mergeImportedSettings(
    { minSize: 32, concurrency: 5, lightboxMinSize: 128 },
    IH.C.DEFAULT_SETTINGS
  );
  check(merged.lightboxMinSize === 128,
    '导入文件里有该键 → 照搬（新键已在白名单里，不会被丢掉）',
    String(merged.lightboxMinSize));
  check(merged.minSize === 32 && merged.concurrency === 5,
    '其它键照常生效（没被这次改动影响）',
    JSON.stringify({ m: merged.minSize, c: merged.concurrency }));

  const merged2 = IH.U.mergeImportedSettings({ lightboxMinSize: 0 }, IH.C.DEFAULT_SETTINGS);
  check(merged2.lightboxMinSize === 0,
    '导入配置里显式写了 0 → 尊重它（0 是有效值，不能被 ?? 掉）',
    String(merged2.lightboxMinSize));

  const merged3 = IH.U.mergeImportedSettings({ minSize: 32 }, IH.C.DEFAULT_SETTINGS);
  check(!('lightboxMinSize' in merged3),
    '导入文件里没这个键 → 不写进补丁（保持用户现状，不顺手清空）',
    JSON.stringify(merged3));

  /* 老版本导出的配置导入后要能拿到 64：补默认值是 withDefaults 干的 */
  await useSettings({ minSize: 32 });
  check(IH.Store.getSettings().lightboxMinSize === 64,
    '导入一份不含该键的旧配置 → Store 那层补上默认 64（设置不会变成 undefined）',
    String(IH.Store.getSettings().lightboxMinSize));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
