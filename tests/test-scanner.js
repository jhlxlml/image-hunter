/* ImageHunter — scanner.js 真实 DOM 环境测试（jsdom） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const BASE = require('path').resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * 探测尺寸的假数据表：模拟每张图真实加载后的像素尺寸
 * ------------------------------------------------------------------ */
const SIZE_MAP = {
  'https://blog.example.com/wp-content/uploads/2024/05/hero-1024x768.jpg': { w: 1024, h: 768 },
  'https://blog.example.com/wp-content/uploads/2024/05/hero-300x225.jpg': { w: 300, h: 225 },
  'https://blog.example.com/wp-content/uploads/2024/05/hero.jpg': { w: 2400, h: 1800 },
  'https://cdn.example.com/lazy-photo.jpg': { w: 1600, h: 1067 },
  'https://cdn.example.com/pic-800.jpg': { w: 800, h: 600 },
  'https://cdn.example.com/pic-1600.webp': { w: 1600, h: 1200 },
  'https://cdn.example.com/bg-hero.jpg': { w: 2000, h: 1000 },
  'https://cdn.example.com/bg-pseudo.png': { w: 800, h: 800 },
  'https://cdn.example.com/video-poster.jpg': { w: 1280, h: 720 },
  'https://example.com/gallery/full-size.jpg': { w: 3000, h: 2000 },
  'https://cdn.example.com/og-cover.jpg': { w: 1200, h: 630 },
  'https://cdn.example.com/preloaded.png': { w: 600, h: 600 },
  'https://cdn.example.com/icon-16.png': { w: 16, h: 16 },
  'https://cdn.example.com/same.jpg?v=2&a=1': { w: 900, h: 600 },
  'https://cdn.example.com/same.jpg?a=1&v=2': { w: 900, h: 600 },
  'https://cdn.example.com/sprite.png': { w: 400, h: 400 },
  // 回归用例：CDN 转码地址与去参数后的原图【像素尺寸完全相同】
  // （ithome / 百度云加速：?x-bce-process=image/format,f_avif）
  'https://cdn.example.com/bce-avif.jpg?x-bce-process=image/format,f_avif': { w: 1440, h: 2132 },
  'https://cdn.example.com/bce-avif.jpg': { w: 1440, h: 2132 }
};

/* 第 19 节用：/slow/ 前缀的图片加载会延迟 400ms，且「缩略图只有原图 1/4 面积」，
   于是 path-dim 规则（去掉 /thumb/）能还原出确实更大的原图。 */
const SLOW_N = 20;
for (let i = 0; i < SLOW_N; i++) {
  SIZE_MAP['https://cdn.example.com/slow/thumb/pic-' + i + '.jpg'] = { w: 400, h: 300 };
  SIZE_MAP['https://cdn.example.com/slow/pic-' + i + '.jpg'] = { w: 1600, h: 1200 };
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:image" content="https://cdn.example.com/og-cover.jpg">
  <link rel="preload" as="image" href="https://cdn.example.com/preloaded.png">
  <style>
    .hero { background-image: url("https://cdn.example.com/bg-hero.jpg"); }
    .hero::before { content: ""; background-image: url("https://cdn.example.com/bg-pseudo.png"); }
  </style>
</head>
<body>
  <img id="a"
       src="https://blog.example.com/wp-content/uploads/2024/05/hero-1024x768.jpg"
       srcset="https://blog.example.com/wp-content/uploads/2024/05/hero-300x225.jpg 300w,
               https://blog.example.com/wp-content/uploads/2024/05/hero-1024x768.jpg 1024w"
       data-nw="1024" data-nh="768" alt="文章主图">

  <img id="b"
       src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
       data-src="https://cdn.example.com/lazy-photo.jpg"
       data-nw="0" data-nh="0" alt="懒加载">

  <picture>
    <source srcset="https://cdn.example.com/pic-800.webp 800w, https://cdn.example.com/pic-1600.webp 1600w" type="image/webp">
    <img id="c" src="https://cdn.example.com/pic-800.jpg" data-nw="800" data-nh="600">
  </picture>

  <div class="hero"></div>

  <video poster="https://cdn.example.com/video-poster.jpg"></video>

  <a href="/gallery/full-size.jpg">查看大图</a>

  <img id="tiny" src="https://cdn.example.com/icon-16.png" data-nw="16" data-nh="16" data-tiny>

  <img id="dup1" src="https://cdn.example.com/same.jpg?v=2&a=1" data-nw="900" data-nh="600">
  <img id="dup2" src="https://cdn.example.com/same.jpg?a=1&v=2" data-nw="900" data-nh="600">

  <img id="bce"
       src="https://cdn.example.com/bce-avif.jpg?x-bce-process=image/format,f_avif"
       data-nw="1440" data-nh="2132" alt="BCE 转码图">
</body>
</html>`;

const dom = new JSDOM(HTML, {
  url: 'https://example.com/article/post-1',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;

/* ---------------------- jsdom 能力补丁 ---------------------- */

// getBoundingClientRect：默认 400x300，标记 data-tiny 的返回 16x16
window.Element.prototype.getBoundingClientRect = function () {
  const tiny = this.hasAttribute && this.hasAttribute('data-tiny');
  const w = tiny ? 16 : 400;
  const h = tiny ? 16 : 300;
  return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0,
    toJSON() { return { width: w, height: h }; } };
};

// naturalWidth / naturalHeight
Object.defineProperty(window.HTMLImageElement.prototype, 'naturalWidth', {
  configurable: true,
  get() { return parseInt(this.getAttribute('data-nw') || '0', 10); }
});
Object.defineProperty(window.HTMLImageElement.prototype, 'naturalHeight', {
  configurable: true,
  get() { return parseInt(this.getAttribute('data-nh') || '0', 10); }
});
Object.defineProperty(window.HTMLImageElement.prototype, 'currentSrc', {
  configurable: true,
  get() { return this.getAttribute('src') || ''; }
});

// Image：按 SIZE_MAP 异步回调 onload / onerror
// loads 记录每一次真实「加载」请求 —— 缓存命中时不会走到这里，
// 所以它可以直接当「有没有命中 sizeCache」的地面真相（见第 18 节）。
window.Image = class FakeImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._src = '';
  }
  set src(v) {
    this._src = v;
    FakeImage.loads.push(v);
    // /slow/ 前缀的加载延迟 400ms —— 第 19 节用它模拟「还原候选冷加载」，
    // 好验证还原阶段的时间预算确实会生效
    const delay = v.indexOf('/slow/') >= 0 ? 400 : 0;
    setTimeout(() => {
      const s = SIZE_MAP[v];
      if (s) {
        this.naturalWidth = s.w;
        this.naturalHeight = s.h;
        if (this.onload) this.onload();
      } else if (this.onerror) {
        this.onerror();
      }
    }, delay);
  }
  get src() { return this._src; }
};
window.Image.loads = [];

// jsdom 不支持伪元素的计算样式，这里补桩以验证 scanner 的伪元素采集分支
const PSEUDO_BG = {
  'div::before': 'url("https://cdn.example.com/bg-pseudo.png")'
};
const origGCS = window.getComputedStyle.bind(window);
window.getComputedStyle = function (el, pseudo) {
  if (pseudo) {
    const tag = (el.tagName || '').toLowerCase();
    const bg = PSEUDO_BG[tag + pseudo];
    return bg
      ? { backgroundImage: bg, content: '""' }
      : { backgroundImage: 'none', content: 'none' };
  }
  return origGCS(el);
};

/* ---------------------- 加载扩展脚本 ---------------------- */

const ctx = dom.getInternalVMContext();
ctx.console = console;

// 极简 chrome.storage 桩（scanner 只需要 Store.getSettings）
ctx.chrome = {
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve()
    },
    onChanged: { addListener() {} }
  }
};

vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'content/scanner.js'), 'utf8'), ctx);

const IH = ctx.IH;

/* ---------------------- 断言 ---------------------- */

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

(async function run() {
  const results = await IH.Scanner.scan();
  const byUrl = new Map(results.map((r) => [r.url, r]));

  console.log('\n=== 扫描结果（' + results.length + ' 条）===');
  results.forEach((r, i) => {
    console.log(
      '  ' + String(i + 1).padStart(2) + '. ' + (r.width + 'x' + r.height).padEnd(11) +
      ' [' + r.source.padEnd(8) + ']' +
      (r.restored ? ' 原图还原' : '        ') + '  ' + r.url.slice(0, 78)
    );
  });

  console.log('\n=== 断言 ===');

  // 1. srcset 取最大 + 原图还原
  check(byUrl.has('https://blog.example.com/wp-content/uploads/2024/05/hero.jpg'),
    'WordPress 缩略图 hero-1024x768.jpg 被还原为 hero.jpg');
  const hero = byUrl.get('https://blog.example.com/wp-content/uploads/2024/05/hero.jpg');
  check(hero && hero.width === 2400 && hero.height === 1800,
    '还原后采用更大的真实尺寸 2400x1800', hero && (hero.width + 'x' + hero.height));
  check(hero && hero.restored === true, '标记为已还原原图');
  check(hero && hero.restoredFrom && hero.restoredFrom.indexOf('hero-1024x768.jpg') >= 0,
    '记录了还原来源地址');
  // 回归（AUDIT P1-3）：restoreRule 必须是真正命中的规则 id。
  // 之前 buildRestoreCandidates 只返回 URL 字符串，调用方拿不到规则信息，
  // 于是恒写成 'builtin' —— 规则命中数据成了死数据。
  check(hero && hero.restoreRule === 'wp-size',
    'restoreRule 记录了实际命中的规则 id（wp-size）', hero && String(hero.restoreRule));

  // 2. 300w 版本不应单独存在（已合并进原图）
  check(!byUrl.has('https://blog.example.com/wp-content/uploads/2024/05/hero-300x225.jpg'),
    'srcset 中的 300w 小图未被单独保留');

  // 3. 懒加载 data-src
  check(byUrl.has('https://cdn.example.com/lazy-photo.jpg'), '懒加载 data-src 被采集');
  const lazy = byUrl.get('https://cdn.example.com/lazy-photo.jpg');
  check(lazy && lazy.width === 1600, '懒加载图补齐了真实尺寸', lazy && String(lazy.width));

  // 4. picture / source srcset 取最大
  check(byUrl.has('https://cdn.example.com/pic-1600.webp'), 'picture 内 source srcset 取最大');
  check(byUrl.has('https://cdn.example.com/pic-800.jpg'), 'picture 内的 img src 也被采集');

  // 5. 背景图 + 伪元素
  check(byUrl.has('https://cdn.example.com/bg-hero.jpg'), 'CSS 背景图被采集');
  check(byUrl.has('https://cdn.example.com/bg-pseudo.png'), '伪元素 ::before 背景图被采集');

  // 6. video poster
  check(byUrl.has('https://cdn.example.com/video-poster.jpg'), 'video poster 被采集');

  // 7. 链接图片（相对地址补全）
  check(byUrl.has('https://example.com/gallery/full-size.jpg'), 'a[href] 指向的图片被采集（相对地址已补全）');

  // 8. og:image / preload
  check(byUrl.has('https://cdn.example.com/og-cover.jpg'), 'og:image 被采集');
  check(byUrl.has('https://cdn.example.com/preloaded.png'), 'link preload as=image 被采集');

  // 9. 1x1 占位 GIF 必须被过滤
  check(!results.some((r) => r.url.indexOf('data:image/gif') === 0), '1x1 占位 GIF 被过滤');

  // 10. 去重（query 顺序不同视为同一张）
  const sameCount = results.filter((r) => r.url.indexOf('cdn.example.com/same.jpg') >= 0).length;
  check(sameCount === 1, 'query 参数顺序不同被正确去重', '实际 ' + sameCount + ' 条');

  // 11. 小图仍然被采集（图标过滤只作用于悬停按钮，不影响批量嗅探）
  check(byUrl.has('https://cdn.example.com/icon-16.png'), '16x16 小图仍出现在批量列表中');

  // 12. wire 序列化
  const wire = IH.Scanner.toWire(hero);
  check(wire && wire.url === hero.url && wire.type === 'jpg' && wire.host === 'blog.example.com',
    'toWire 序列化正确（含 type / host）', JSON.stringify(wire && { t: wire.type, h: wire.host }));

  // 13. findSaveTarget
  const imgA = window.document.getElementById('a');
  const t1 = IH.Scanner.findSaveTarget(imgA);
  check(t1 && t1.el === imgA && t1.kind === 'img', 'findSaveTarget 能识别 <img>');

  const heroDiv = window.document.querySelector('.hero');
  const t2 = IH.Scanner.findSaveTarget(heroDiv);
  check(t2 && t2.kind === 'bg', 'findSaveTarget 能识别背景图元素');

  const video = window.document.querySelector('video');
  const t3 = IH.Scanner.findSaveTarget(video);
  check(t3 && t3.kind === 'poster', 'findSaveTarget 能识别 video poster');

  // 14. resolveForElement：单张解析也应拿到原图
  const cand = await IH.Scanner.resolveForElement(imgA);
  check(cand && cand.url === 'https://blog.example.com/wp-content/uploads/2024/05/hero.jpg',
    'resolveForElement 单张解析得到原图', cand && cand.url);

  // 15. id 的性质
  //     （元素注册表 + getElementById 已随「定位到页面」功能一起移除，见 AUDIT P3-3/P3-4。
  //      但 id 本身仍是关键数据：图库拿它当勾选状态 / 去重的主键，必须唯一且稳定。）
  const ids = results.map((r) => r.id);
  check(ids.every((x) => typeof x === 'string' && x.length > 0), '每条结果都有 id');
  check(new Set(ids).size === ids.length, '结果里的 id 全部唯一',
    new Set(ids).size + ' / ' + ids.length);
  check(hero.id === IH.U.quickHash(IH.U.normalizeUrl(hero.url)),
    'id 是「规范化 URL 的哈希」—— 同一个地址跨扫描必须得到同一个 id',
    hero.id + ' vs ' + IH.U.quickHash(IH.U.normalizeUrl(hero.url)));

  // 16. 回归：像素尺寸相同、但去掉了图片处理参数的候选也必须采纳
  //     （ithome 的 ?x-bce-process=...format,f_avif 会被 CDN 转成 AVIF 压缩版，
  //      尺寸与原图一致，所以靠面积比较永远分不出高下）
  check(byUrl.has('https://cdn.example.com/bce-avif.jpg'),
    'BCE 转码地址被还原为原图（尺寸相同也必须采纳）');
  check(!results.some((r) => r.url.indexOf('x-bce-process') >= 0),
    '带 x-bce-process 的转码地址不再出现在结果里');
  const bce = byUrl.get('https://cdn.example.com/bce-avif.jpg');
  check(bce && bce.restored === true, 'BCE 还原结果标记为已还原');
  check(bce && bce.restoreRule === 'bce-process',
    'restoreRule 记录了实际命中的规则 id（bce-process）', bce && String(bce.restoreRule));

  // 17. 反向保护：不能把本来就没有参数的地址改坏
  check(byUrl.has('https://cdn.example.com/same.jpg?a=1&v=2') ||
        byUrl.has('https://cdn.example.com/same.jpg?v=2&a=1'),
    '无处理参数的普通地址不被误改');

  /* ================================================================ *
   * 18. 尺寸缓存有上限（回归 AUDIT P2-2）
   *
   * sizeCache 按 URL 累积，原来只增不减 —— 在长时间驻留的页面上
   * （无限滚动的资讯站）能攒出几万条。现在超过上限会按插入顺序淘汰最旧的。
   *
   * 怎么观测：缓存命中时 probeSize 直接返回，不会 new Image()；
   * 所以 FakeImage.loads 的长度就是「真实加载次数」的地面真相。
   * ================================================================ */
  console.log('\n=== 18. 尺寸缓存上限（P2-2）===');
  IH.Scanner.clearSizeCache();
  window.Image.loads.length = 0;     // 只统计本节产生的加载

  const CAP = 4000;                  // 与 scanner.js 的 SIZE_CACHE_MAX 对齐
  const N = CAP + 1;                 // 多灌 1 条，正好挤掉最旧的那一条
  const bulk = [];
  for (let i = 0; i < N; i++) bulk.push('https://cdn.example.com/bulk-' + i + '.png');

  await Promise.all(bulk.map((u) => IH.Scanner.probeSize(u, 200)));
  console.log('灌入 ' + N + ' 个 URL，实际加载 ' + window.Image.loads.length + ' 次');
  check(window.Image.loads.length === N, '每个新 URL 都真实加载了一次',
    window.Image.loads.length + ' 次');

  // 最近灌进去的那条：应当命中缓存，不产生新的加载
  const beforeRecent = window.Image.loads.length;
  await IH.Scanner.probeSize(bulk[N - 1], 200);
  check(window.Image.loads.length === beforeRecent,
    '刚探过的 URL 命中缓存（未重复加载）',
    (window.Image.loads.length - beforeRecent) + ' 次新加载');

  // 最早灌进去的那条：应当已被淘汰，必须重新加载
  const beforeOldest = window.Image.loads.length;
  await IH.Scanner.probeSize(bulk[0], 200);
  check(window.Image.loads.length === beforeOldest + 1,
    '最旧的 URL 已被淘汰，重新加载（缓存不再无限增长）',
    (window.Image.loads.length - beforeOldest) + ' 次新加载');

  // 再灌一批**全新**的 URL：验证淘汰是持续生效的，老条目会被逐步挤出去。
  // （注意不能用 bulk[0] 来验：它刚被重新加载过，反而成了「最近使用」的那条。）
  const bulk2 = [];
  for (let i = 0; i < N; i++) bulk2.push('https://cdn.example.com/bulk2-' + i + '.png');
  await Promise.all(bulk2.map((u) => IH.Scanner.probeSize(u, 200)));

  const beforeNew = window.Image.loads.length;
  await IH.Scanner.probeSize(bulk2[N - 1], 200);
  check(window.Image.loads.length === beforeNew,
    '新一批里最近灌入的命中缓存',
    (window.Image.loads.length - beforeNew) + ' 次新加载');

  const beforeOld = window.Image.loads.length;
  await IH.Scanner.probeSize(bulk[100], 200);   // 第一批里的老条目
  check(window.Image.loads.length === beforeOld + 1,
    '第一批的老条目已被挤出缓存（淘汰持续生效）',
    (window.Image.loads.length - beforeOld) + ' 次新加载');

  IH.Scanner.clearSizeCache();

  /* ================================================================ *
   * 19. 分阶段回报 + 还原阶段的时间预算
   *     （回归「首次点击扩展图标偶尔识别不到图片」）
   *
   * 原图还原要给每张图的每个候选发一次真实加载请求，冷加载时这一步能轻松
   * 拖到好几秒。旧的后台收尾判据是「1.5 秒没有 frame 响应就收尾」，
   * 它分不清「没有响应」和「正在联网加工」，于是把正常的慢扫描判定成空列表。
   *
   * 修法：scan() 在**任何联网步骤之前**先通过 onPartial 交出一版中间结果 ——
   *       补尺寸、原图还原此时都还没开始；联网加工受全局并发闸门 +
   *       时间预算约束，撞上预算时如实标记。
   *
   * 代价是这一版中间结果里**尺寸可能还没补齐**（DOM 上拿不到 naturalWidth
   * 的那些图就是 width === 0），下面有专门的断言盯着这一点。
   * ================================================================ */
  console.log('\n=== 19. 分阶段回报（中间结果 → 最终结果）===');

  // 先在文档里放 SLOW_N 张「缩略图」，其还原候选是 /slow/ 前缀的慢加载
  const body = window.document.body;
  for (let i = 0; i < SLOW_N; i++) {
    const el = window.document.createElement('img');
    el.setAttribute('src', 'https://cdn.example.com/slow/thumb/pic-' + i + '.jpg');
    el.setAttribute('data-nw', '400');
    el.setAttribute('data-nh', '300');
    el.setAttribute('alt', 'slow-' + i);
    body.appendChild(el);
  }

  /* 再放几张「DOM 上还没有真实尺寸」的图：不给 data-nw / data-nh，
     于是 naturalWidth 为 0、候选的 width === 0（进 unknown 名单），
     但地址在 SIZE_MAP 里 —— 补尺寸阶段能把 640x480 补上。
     用它们钉住「先出图的代价」：中间结果这一版里尺寸还没补齐。 */
  const LATE_N = 4;
  for (let i = 0; i < LATE_N; i++) {
    const url = 'https://cdn.example.com/late-size-' + i + '.jpg';
    SIZE_MAP[url] = { w: 640, h: 480 };
    const el = window.document.createElement('img');
    el.setAttribute('src', url);
    el.setAttribute('alt', 'late-' + i);
    body.appendChild(el);
  }

  let partial = null;
  let partialAt = 0;
  const t19 = Date.now();
  const final19 = await IH.Scanner.scan(null, (early) => {
    partial = early;
    partialAt = Date.now() - t19;
  });
  const finalAt = Date.now() - t19;
  console.log('中间结果 ' + (partial ? partial.length : 0) + ' 条 @' + partialAt
    + 'ms；最终结果 ' + final19.length + ' 条 @' + finalAt + 'ms');

  check(Array.isArray(partial) && partial.length > 0,
    '联网加工（补尺寸 / 还原）开始前先交出了一版非空中间结果', partial && partial.length);
  check(partialAt < finalAt,
    '中间结果确实早于最终结果（' + partialAt + 'ms < ' + finalAt + 'ms）',
    partialAt + ' / ' + finalAt);
  check(partial.every((p) => p.restored !== true),
    '中间结果里没有「已还原」标记（还原还没开始）');
  check(partial.every((p) => typeof p.id === 'string' && p.id.length > 0),
    '中间结果也带着主键（界面能直接拿它勾选 / 去重）');

  /* 先出图的代价：中间结果这一版里尺寸可能还没补齐。
     第 19 节开头那几张 late-size-* 图在 DOM 上拿不到 naturalWidth，
     所以 partial 里它们必然是 width === 0 —— 这不是 bug，是「不联网」
     的必然结果，也正是我们想要的（宁可先给用户看到图，也别干等联网）。 */
  const lateInPartial = partial.filter((p) => p.url.indexOf('/late-size-') >= 0);
  check(lateInPartial.length === LATE_N,
    '中间结果里已经包含了那 ' + LATE_N + ' 张「DOM 上还没尺寸」的图（先出图，不等联网）',
    lateInPartial.length);
  check(lateInPartial.every((p) => !p.width || !p.height),
    '这些图的尺寸在中间结果里还没补齐（width/height 为 0）',
    lateInPartial.map((p) => p.width + 'x' + p.height).join(','));

  const lateInFinal = final19.filter((r) => r.url.indexOf('/late-size-') >= 0);
  check(lateInFinal.length === LATE_N
    && lateInFinal.every((r) => r.width === 640 && r.height === 480),
    '到了最终结果，这 ' + LATE_N + ' 张图的尺寸已经补成 640x480（补尺寸确实跑了）',
    lateInFinal.length + ' 条 / '
      + lateInFinal.map((r) => r.width + 'x' + r.height).join(','));

  const slowFinal = final19.filter((r) => r.url.indexOf('/slow/') >= 0);
  const slowRestored = slowFinal.filter((r) => r.url.indexOf('/slow/thumb/') < 0);
  console.log('慢图最终结果 ' + slowFinal.length + ' 条，其中已还原 ' + slowRestored.length + ' 条');
  check(slowRestored.length === SLOW_N,
    '预算充足时 ' + SLOW_N + ' 张慢图全部还原成原图', slowRestored.length);
  check(slowRestored.every((r) => r.width === 1600 && r.height === 1200),
    '还原后拿到的是原图尺寸 1600x1200');
  check(IH.Scanner.lastScanStats().restoreTruncated === false,
    '预算充足时 restoreTruncated 为 false');

  /* --- 对照：预算极小 → 撞上预算，如实标记且不干等 --- */
  console.log('\n=== 19b. 还原撞上时间预算 ===');
  IH.Scanner.clearSizeCache();
  const t19b = Date.now();
  const budget19 = await IH.Scanner.scan({ restoreBudget: 1 });
  const ms19b = Date.now() - t19b;
  console.log('预算 1ms 时耗时 ' + ms19b + 'ms，结果 ' + budget19.length + ' 条');

  check(IH.Scanner.lastScanStats().restoreTruncated === true,
    '撞上预算时 restoreTruncated 如实为 true');
  check(ms19b < 2000,
    '撞上预算后立刻返回（' + ms19b + 'ms），没有干等还原跑完', ms19b);
  const slowB = budget19.filter((r) => r.url.indexOf('/slow/') >= 0);
  check(slowB.length === SLOW_N,
    '即使还原没跑完，' + SLOW_N + ' 张图一张不少（旧实现这里会是 0 张）', slowB.length);
  check(slowB.every((r) => r.url.indexOf('/slow/thumb/') >= 0),
    '没跑完的图保持页面上的原始地址，不会被写成半截状态');

  IH.Scanner.clearSizeCache();

  /* ================================================================ *
   * 20. 深度嗅探：滚动采集「要滚到底才加载下一批」的页面
   *
   * 普通 scan() 只看**此刻存在**的 DOM，所以无限滚动的站点只能拿到首屏。
   * deepScan() 滚动整页、边滚边采集，最后只对合并结果做一次加工。
   *
   * jsdom 没有布局引擎，所以这里把滚动相关的三样东西全打成桩：
   * innerHeight / scrollY / documentElement.scrollHeight，
   * 并让 scrollBy 在「滚到底」时追加下一批 —— 这就是无限滚动站点的行为。
   * ================================================================ */
  console.log('\n=== 20. 深度嗅探（无限滚动）===');

  // 清掉第 19 节塞进文档的图（慢图 + 那几张「DOM 上没尺寸」的），免得混进这一节的计数
  Array.from(window.document.querySelectorAll('img')).forEach((el) => {
    const src = el.getAttribute('src') || '';
    if (src.indexOf('/slow/') >= 0 || src.indexOf('/late-size-') >= 0) el.remove();
  });

  const deepRoot = window.document.createElement('div');
  window.document.body.appendChild(deepRoot);

  const BATCH = 3;          // 每批 3 张
  const BATCHES = 4;        // 共 4 批 = 12 张
  const ROW = 300;          // 每张图占 300px 高
  const VIEWPORT = 600;
  let appended = 0;
  let deepY = 0;

  function appendBatch() {
    if (appended >= BATCHES) return;
    for (let i = 0; i < BATCH; i++) {
      const el = window.document.createElement('img');
      el.setAttribute('src', 'https://cdn.example.com/deep/pic-' + (appended * BATCH + i) + '.jpg');
      el.setAttribute('data-nw', '800');
      el.setAttribute('data-nh', '600');
      deepRoot.appendChild(el);
    }
    appended++;
  }
  appendBatch();                              // 首屏 3 张

  const docHeight = () => appended * BATCH * ROW;

  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(window, 'scrollY', { get: () => deepY, configurable: true });
  Object.defineProperty(window.document.documentElement, 'scrollHeight',
    { get: docHeight, configurable: true });

  window.scrollBy = (x, dy) => {
    deepY += dy;
    if (deepY + VIEWPORT >= docHeight() - 4) appendBatch();   // 到底才加载下一批
  };
  window.scrollTo = (x, y) => { deepY = y; };

  /* 20a. 先证明普通嗅探确实够不着 —— 否则「深度嗅探有效」这条断言没有意义 */
  const plain = IH.Scanner.collectAll(IH.Store.getSettings());
  const plainDeep = plain.list.filter((c) => c.url.indexOf('/deep/') >= 0);
  console.log('未滚动时采集到 ' + plainDeep.length + ' 张 / 页面共 ' + (BATCHES * BATCH) + ' 张');
  check(plainDeep.length === BATCH,
    '未滚动时只采集到首屏 ' + BATCH + ' 张（这正是深度嗅探要解决的问题）', plainDeep.length);

  /* 20b. 深度嗅探应当拿到全部 */
  const rounds = [];
  const deepList = await IH.Scanner.deepScan(
    { deepRoundDelay: 5, scanBackground: false, restoreOriginal: false },
    (p) => rounds.push(p)
  );
  const deepImgs = deepList.filter((c) => c.url.indexOf('/deep/') >= 0);
  console.log('深度嗅探：' + deepImgs.length + ' 张，共滚动 ' + rounds.length + ' 轮');
  check(deepImgs.length === BATCHES * BATCH,
    '深度嗅探拿到全部 ' + (BATCHES * BATCH) + ' 张', deepImgs.length);
  check(rounds.length >= BATCHES,
    '确实滚了至少 ' + BATCHES + ' 轮', rounds.length);
  check(rounds.length > 0 && rounds.every((p, i) => i === 0 || p.total >= rounds[i - 1].total),
    '进度回调里的累计数量单调不减',
    JSON.stringify(rounds.map((p) => p.total)));
  // 取值前先判空：否则注入旧行为（一轮都不滚）时这里会抛异常把整个套件打断，
  // 而不是干净地失败一条断言
  const lastRound = rounds[rounds.length - 1];
  check(!!lastRound && lastRound.total >= BATCHES * BATCH,
    '最后一轮的累计数量覆盖了全部图片', lastRound && lastRound.total);

  /* 20c. 页面滚动位置必须复原 —— 这是别人的页面 */
  check(deepY === 0,
    '结束后页面滚回原位（deepY = ' + deepY + '）', deepY);

  /* 20d. 多轮采集不能产生重复项 */
  check(new Set(deepImgs.map((c) => c.url)).size === deepImgs.length,
    '多轮采集没有产生重复项', deepImgs.length + ' 张 / '
      + new Set(deepImgs.map((c) => c.url)).size + ' 个唯一地址');

  /* 20e. 合并后仍按「先出现的排前面」 */
  const orderSeen = deepImgs.map((c) => Number(/pic-(\d+)\.jpg/.exec(c.url)[1]));
  check(JSON.stringify(orderSeen) === JSON.stringify(orderSeen.slice().sort((a, b) => a - b)),
    '合并后仍按出现顺序排列（每轮的 order 接着上一轮排）', JSON.stringify(orderSeen));

  /* 20f. 撞上滚动上限时必须如实上报，而不是假装「已经到底了」 */
  const endless = window.document.createElement('div');
  window.document.body.appendChild(endless);
  let endlessH = VIEWPORT;
  Object.defineProperty(window.document.documentElement, 'scrollHeight',
    { get: () => endlessH, configurable: true });

  deepY = 0;
  window.scrollBy = (x, dy) => {
    deepY += dy;
    endlessH += VIEWPORT;                    // 永远滚不到底
    const el = window.document.createElement('img');
    el.setAttribute('src', 'https://cdn.example.com/endless/' + endlessH + '.jpg');
    el.setAttribute('data-nw', '800');
    el.setAttribute('data-nh', '600');
    endless.appendChild(el);
  };

  const limited = await IH.Scanner.deepScan({
    deepRoundDelay: 1, deepMaxRounds: 3, scanBackground: false, restoreOriginal: false
  });
  console.log('滚不到底的页面：采集 ' + limited.length + ' 张，'
    + 'deepTruncated=' + IH.Scanner.lastScanStats().deepTruncated);
  check(IH.Scanner.lastScanStats().deepTruncated === true,
    '滚不到底且撞上轮数上限时，deepTruncated 如实为 true');
  check(limited.filter((c) => c.url.indexOf('/endless/') >= 0).length > 0,
    '即使被截断，也已经返回采集到的图片');
  check(deepY === 0, '被截断时同样滚回原位', deepY);

  IH.Scanner.clearSizeCache();

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
