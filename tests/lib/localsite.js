/* ImageHunter — 测试用本地图片站点（零依赖）
 *
 * 真浏览器测试不该依赖外网：起一个 127.0.0.1 上的 HTTP 服务，
 * 页面里放若干张**真实 PNG**（用 zlib 手写编码，在内存里生成），
 * 扩展的嗅探 / 原图还原 / 体积探测都能在完全可控的数据上跑。
 *
 * 用法：
 *   const { startServer } = require('./lib/localsite');
 *   const { server, port, url } = await startServer({ cols: 8, rows: 6 });
 *   ...
 *   server.close();
 */
'use strict';

const http = require('http');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * 手写 PNG 编码
 * ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crc]);
}

/**
 * 生成一张纯色 PNG。
 * @param {number} w
 * @param {number} h
 * @param {[number,number,number]} rgb
 * @returns {Buffer}
 */
function makePng(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0;                                  // filter: None
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 生成一张「不可压缩」的噪声 PNG。
 *
 * 为什么需要它：纯色 PNG 经 deflate 之后只有几 KB，拿它当「原图」就分不出
 * 「下载到的是原图还是 CDN 转码版」—— 两者字节数差不多，断言等于没断言。
 * 这里让每个像素伪随机取值，deflate 只能原样存储，于是原图明显大于转码版。
 *
 * @param {number} seed 固定种子 → 同一张图每次生成完全相同的字节（断言才能比大小）
 */
function makeNoisyPng(w, h, seed) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  let s = (seed >>> 0) || 1;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0;                                  // filter: None
    for (let x = 0; x < w; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const o = row + 1 + x * 3;
      raw[o] = s & 0xff;
      raw[o + 1] = (s >>> 8) & 0xff;
      raw[o + 2] = (s >>> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

/* 逐张尺寸：给了 opts.sizeByIndex 就按它算，否则整页统一用 imgW/imgH。
   必须定义在**模块级**，因为两个地方都要用它：
     - buildHtml：写进 HTML 的 width/height 属性
     - pngOf（在 startServer 里）：决定服务端真正返回的 PNG 像素
   两处必须一致 —— 只改属性不改像素的话，嗅探按属性判定、实际图却是另一个尺寸，
   按尺寸过滤的用例就会测出一个假象。

   有它才测得了阈值边界：全站一个尺寸时，任何阈值要么全过要么全滤。 */
function sizeOf(opts, i) {
  if (typeof opts.sizeByIndex === 'function') {
    const s = opts.sizeByIndex(i);
    if (s && s.w > 0 && s.h > 0) return s;
  }
  return { w: opts.imgW, h: opts.imgH };
}

function buildHtml(opts) {
  const cols = opts.cols, rows = opts.rows, w = opts.imgW, h = opts.imgH;
  const dir = opts.thumbPath ? '/thumb' : '';
  // CDN 转码模式：页面拿到的是带图片处理参数的地址（IT之家那种 x-bce-process）
  const q = opts.bceProcess ? '?x-bce-process=image/auto-orient,o_1/format,f_avif' : '';
  const perBatch = cols * rows;
  const batches = opts.lazyBatches || 1;
  const total = perBatch * batches;

  /* 页面渲染哪几张图。默认就是首屏那一批（0..perBatch-1），
     给了 `imageIndexes` 就按给的来 —— 「多标签页合并嗅探」的测试要靠它
     在**同一个站点**上挂两个页面、各自渲染不同的图片子集，
     于是两页之间既有重叠（能验证跨页去重）又有各自独有的（能验证真的合并了）。
     逐张尺寸的 `sizeByIndex` 仍然照常生效，不受这个选项影响。 */
  const indexes = (Array.isArray(opts.imageIndexes) && opts.imageIndexes.length)
    ? opts.imageIndexes.slice()
    : Array.from({ length: perBatch }, (_, i) => i);
  // 指定了子集就不再走「懒加载批次」—— 两个特性叠在一起会让断言没法算
  const useLazy = batches > 1 && !(Array.isArray(opts.imageIndexes) && opts.imageIndexes.length);
  const shown = indexes.length;

  const sizeAt = (i) => sizeOf(opts, i);

  /** 页面上的 width/height 属性（HTML 属性必须与实际像素一致，
      否则嗅探会按属性值判定、与实际图不符，测试就假了）。
      注意开头的空格和属性里的引号 —— 调用处是直接接在 src 的收尾引号后面拼的，
      少一个引号会让 src 变成 `/img/0.png width=`，整页图片集体 404。 */
  const attrs = (i) => {
    const s = sizeAt(i);
    return ' width="' + s.w + '" height="' + s.h + '"';
  };

  // 无限滚动模式：首屏只渲染第一批，剩下的等滚到底再追加 ——
  // 这正是「深度嗅探」要解决的场景
  let imgs = '';
  for (const i of indexes) {
    imgs += '<img src="' + dir + '/img/' + i + '.png' + q + '"' + attrs(i)
      + ' alt="pic' + i + '">\n';
  }

  let script = '';
  if (useLazy) {
    /* 逐张尺寸模式下要把尺寸表注入页面脚本 —— 追加的批次也得有正确尺寸，
       否则「首屏统一、追加的批次统一另一个尺寸」会让断言莫名其妙。 */
    const sizes = [];
    for (let i = 0; i < total; i++) sizes.push(sizeAt(i).w + ',' + sizeAt(i).h);
    script = '<script>(function(){'
      + 'var BATCHES=' + batches + ',PER=' + perBatch + ',DIR=' + JSON.stringify(dir)
      + ',Q=' + JSON.stringify(q)
      + ',W=' + w + ',H=' + h + ',loaded=1;'
      + 'var SIZES=' + JSON.stringify(sizes) + ';'
      + 'var root=document.getElementById("wrap");'
      + 'function append(){'
      + 'if(loaded>=BATCHES)return;'
      + 'var start=loaded*PER;'
      + 'for(var i=0;i<PER;i++){'
      + 'var n=start+i;'
      + 'var s=(SIZES[n]||(W+","+H)).split(",");'
      + 'var el=document.createElement("img");'
      + 'el.src=DIR+"/img/"+n+".png"+Q;'
      + 'el.width=Number(s[0]);el.height=Number(s[1]);el.alt="pic"+n;'
      + 'root.appendChild(el);}'
      + 'loaded++;}'
      + 'window.addEventListener("scroll",function(){'
      + 'if(window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-4)append();'
      + '},{passive:true});'
      + '})();<\/script>';
  }

  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>' + (opts.title || 'ImageHunter 测试页') + '</title><style>'
    + 'body{margin:0;font:14px/1.5 sans-serif;background:#fff}'
    + 'h1{font-size:16px;margin:12px 16px}'
    + '.wrap{display:grid;grid-template-columns:repeat(' + cols + ',1fr);gap:10px;padding:0 16px 40px}'
    + 'img{width:100%;height:auto;display:block;background:#eef}'
    + '</style></head><body><h1>ImageHunter 测试页（' + shown + ' 张'
    + (useLazy ? '，首屏 ' + perBatch + ' 张，滚到底追加' : '') + '）</h1>'
    + '<div class="wrap" id="wrap">' + imgs + '</div>' + script + '</body></html>';
}

/**
 * iframe 宿主页：本身一张图都没有，图片全在子 frame 里。
 *
 * 内容脚本注入到**所有** frame，所以「图片在 iframe 里」是真实且常见的情况
 * （广告位、第三方图床、嵌入式画廊）。灯箱是 `position:fixed` 铺满当前文档的，
 * 开在子 frame 里会被 iframe 边界裁成一小块 —— 这条用例就是盯着这个坑。
 */
function buildFrameHost() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>ImageHunter 测试页（iframe 宿主）</title><style>'
    + 'body{margin:0;font:14px/1.5 sans-serif;background:#fff}'
    + 'h1{font-size:16px;margin:12px 16px}'
    + '.holder{margin:0 16px;border:1px dashed #ccd;background:#fafbff}'
    + '.holder iframe{display:block;width:100%;height:520px;border:0}'
    + '</style></head><body>'
    + '<h1>ImageHunter 测试页（图片在 iframe 内）</h1>'
    + '<div class="holder"><iframe src="/frame" title="子页面"></iframe></div>'
    + '</body></html>';
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

/**
 * @param {object} [options]
 * @param {number} [options.cols=8]   页面里每行放几张
 * @param {number} [options.rows=6]   共几行
 * @param {number} [options.imgW=600]
 * @param {number} [options.imgH=400]
 * @param {(i:number) => {w:number, h:number}} [options.sizeByIndex]
 *        **逐张指定尺寸**（覆盖 imgW/imgH）。HTML 属性、服务端实际返回的 PNG
 *        像素尺寸都由它决定，两边永远一致 —— 否则嗅探按属性判定、
 *        实际图却是另一个尺寸，按尺寸过滤的用例会测出假象。
 *        有它才测得了阈值边界：全站一个尺寸时，任何阈值要么全过要么全滤。
 *        `thumbPath` 模式下缩略图取它的一半。
 * @param {boolean|((i:number)=>boolean)} [options.probeFail=false]
 *        为真时，**探测请求**（HEAD 或带 Range 的 GET）返回 500 + Content-Length: 0。
 *        页面自身的 <img> 加载是普通 GET，不受影响 —— 所以图片照常显示、照常被嗅探，
 *        只有「体积探测」拿不到结果。用来复现「探测全失败」的场景。
 * @param {number} [options.imgDelay=0]   图片 GET 的响应延迟（ms）。
 *        用来模拟「图片还没进浏览器缓存」—— 原图还原要给每张候选发一次真实加载请求，
 *        冷加载时这一步会成为整轮扫描的主要耗时。
 * @param {boolean} [options.thumbPath=false]
 *        把图片放在 `/thumb/img/N.png` 下，且缩略图只有原图的**一半尺寸**。
 *        路径里的 `/thumb/` 会命中 `path-dim` 还原规则（去掉 `/thumb/`，候选是
 *        `/img/N.png`），于是每张图都要联网加载一次候选，而且候选确实更大 ——
 *        还原会真的生效。两者叠加即可复现「还原太慢 → 后台超时 → 一张图都认不到」。
 * @param {boolean|((i:number)=>boolean)} [options.candidateFail=false]
 *        **只影响全尺寸那张**（`/img/N.png`，也就是还原候选；`/thumb/` 缩略图不受影响）
 *        返回 404。用来复现「图片本身显示得好好的，但第一轮还原没成功」——
 *        比用延迟制造超时更快也更确定。传入函数时可以靠外部开关控制，
 *        测试就能做到「先失败、再放行，然后点重试」。
 *        仅在 `thumbPath: true` 时有意义（否则页面图片本身就走的 /img/）。
 * @param {boolean} [options.bceProcess=false]
 *        **CDN 转码模式**（离线复现 IT之家 / 百度云加速那种 `?x-bce-process=`）：
 *        页面给出带 `?x-bce-process=image/auto-orient,o_1/format,f_avif` 的地址，
 *        服务按**有没有这个参数**返回两种响应 ——
 *          - 带参数 → 转码版：与全尺寸**像素完全相同**，但内容是可压缩的纯色，字节数小得多
 *          - 不带   → 原图：每像素伪随机的噪声图，deflate 只能原样存储，字节数大得多
 *        于是「还原有没有生效」可以双向断言：URL 去掉了参数，**而且**下载到的是大的那份。
 *        不传时 `/img/N.png` 仍是纯色 PNG（老用例的字节数不受影响）。
 * @param {string} [options.title='ImageHunter 测试页']
 *        页面标题。**多个本地站点同处一个测试里时必须给不同标题** ——
 *        `prettyHost()` 只看主机名，两个站点都跑在 `127.0.0.1` 上，
 *        光靠顶栏域名分不出图库当前锁的是哪一个目标页。
 * @param {number} [options.lazyBatches=1]  无限滚动模式：页面共 `cols*rows*lazyBatches` 张，
 *        但**首屏只渲染第一批**，其余的等滚到文档底部才追加（页面内脚本监听 scroll）。
 *        用来验证深度嗅探：普通嗅探只能拿到第一批，深度嗅探应当拿到全部。
 * @param {boolean} [options.iframe=false]
 *        把图片全部放进一个子 iframe（`/frame`），顶层页面本身没有图片。
 *        用来验证「图片在 iframe 里」时页内 UI 的行为 —— 内容脚本注入到所有 frame，
 *        但灯箱在子 frame 里会被 iframe 边界裁掉，必须交回顶层开。
 * @returns {Promise<{server, port, url, frameUrl, total, perBatch, opts, png, probeLog, probedIndexes, resetProbeLog, close}>}
 */
function startServer(options) {
  const opts = Object.assign({
    cols: 8, rows: 6, imgW: 600, imgH: 400, probeFail: false, imgDelay: 0,
    thumbPath: false, lazyBatches: 1, iframe: false, candidateFail: false, bceProcess: false,
    title: 'ImageHunter 测试页',
    /* 监听地址。默认 127.0.0.1；给 'localhost' 就能在同一个测试进程里
       起出**两个 host 名不同**的站点 —— 「多标签页合并嗅探」要靠它验证
       「来源页域名」真的区分得开（两个都跑在 127.0.0.1 的话，prettyHost 出来
       是同一个字符串，断言等于没断言）。 */
    host: '127.0.0.1',
    /* 多页模式：[{ path, imageIndexes, title }]。
       在**同一个站点**上挂多个页面、各自渲染不同的图片子集 ——
       只有同源才能让两个页面出现**完全相同的图片地址**，
       「跨页去重」这件事才测得出来（跨站点时地址必然不同，永远没有重叠）。 */
    pages: null
  }, options || {});
  const perBatch = opts.cols * opts.rows;
  const pageList = (Array.isArray(opts.pages) && opts.pages.length) ? opts.pages : null;
  /** 某一页实际渲染的图片序号（没给 imageIndexes 就是首屏那一批） */
  const indexesOf = (p) => (p && Array.isArray(p.imageIndexes) && p.imageIndexes.length)
    ? p.imageIndexes.slice()
    : Array.from({ length: perBatch }, (_, i) => i);
  /* 有 pages 时，服务端认的合法图片序号 = 各页用到的最大序号 + 1；
     否则维持老口径 perBatch × lazyBatches。 */
  const total = pageList
    ? Math.max.apply(null, pageList.map((p) => Math.max.apply(null, indexesOf(p)) + 1))
    : perBatch * opts.lazyBatches;
  const pngCache = new Map();

  /* 探测请求日志：每条 { i, method, range }。
     测试靠它拿到「后台到底请求了哪几张」这个地面真相 ——
     只看界面文案分不清「换了新的一批」还是「又把同一批重试了一遍」。 */
  const probeLog = [];

  /* 全尺寸图片（`/img/`，即缩略图站点的**还原候选**）的请求日志：每条 { i, method }。
     用来区分「只问了一次」和「每个 frame 都问了一次」—— 后台转发「单张还原」时
     如果忘了带 frameId，标签页里每个 frame 的内容脚本都会各跑一遍同样的探测。 */
  const fullLog = [];

  function shouldFailProbe(i) {
    return typeof opts.probeFail === 'function' ? !!opts.probeFail(i) : !!opts.probeFail;
  }

  function shouldFailCandidate(i) {
    return typeof opts.candidateFail === 'function' ? !!opts.candidateFail(i) : !!opts.candidateFail;
  }

  /**
   * 第 i 张图。
   * - `thumb=true`：**半尺寸**版本，让「原图还原」有真实收益（候选确实更大）
   * - `transcoded=true`：与全尺寸**像素完全相同**、但内容可压缩得多的版本，
   *   模拟 CDN 按 `?x-bce-process=image/format,f_avif` 返回的转码版。
   *   像素一样 → 面积比较分不出高下，只能靠「去掉处理参数的干净地址」这条规则采纳；
   *   字节小得多 → 「下载到的是不是转码版」才断言得出来。
   */
  function pngOf(i, thumb, transcoded) {
    const key = (transcoded ? 'c' : '') + (thumb ? 't' : '') + i;
    if (!pngCache.has(key)) {
      /* 逐张尺寸要连**图片像素**一起变，不能只改 HTML 属性 ——
         否则服务端返回的还是整页统一尺寸，嗅探补齐/还原后拿到的
         真实尺寸与属性不符，按尺寸过滤的用例就测了个假象。 */
      const base = sizeOf(opts, i);
      const w = thumb ? Math.max(1, base.w >> 1) : base.w;
      const h = thumb ? Math.max(1, base.h >> 1) : base.h;
      pngCache.set(key, transcoded
        ? makePng(w, h, [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256])
        : (opts.bceProcess ? makeNoisyPng(w, h, i + 1 + (thumb ? 977 : 0))
          : makePng(w, h, [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256])));
    }
    return pngCache.get(key);
  }

  /** 某张图「原图」的字节数（地面真相，供测试断言下载到的是不是它） */
  const originalBytes = (i) => pngOf(i, false, false).length;
  /** 某张图「CDN 转码版」的字节数 */
  const transcodedBytes = (i) => pngOf(i, false, true).length;

  const html = Buffer.from(buildHtml(opts), 'utf8');
  const hostHtml = Buffer.from(buildFrameHost(), 'utf8');

  /* 多页模式：每页各渲染一份 HTML（图片子集不同），按 path 分发 */
  const pageHtml = new Map();
  if (pageList) {
    for (const p of pageList) {
      if (!p || !p.path) continue;
      pageHtml.set(p.path, Buffer.from(buildHtml(Object.assign({}, opts, {
        imageIndexes: indexesOf(p),
        title: p.title || opts.title,
        lazyBatches: 1
      })), 'utf8'));
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // 多页模式：按 path 分发各自的 HTML（各自渲染不同的图片子集）
    if (pageHtml.has(url)) {
      const body = pageHtml.get(url);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }

    if (url === '/') {
      const body = opts.iframe ? hostHtml : html;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }

    // iframe 模式的子页面：图片都在这里
    if (url === '/frame') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store'
      });
      res.end(html);
      return;
    }

    if (url === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store'
      });
      res.end(html);
      return;
    }

    // 允许 `/thumb/img/N.png`（thumbPath 模式下的页面地址）与 `/img/N.png`（还原候选）
    const m = /^(?:\/thumb)?\/img\/(\d+)\.png$/.exec(url);
    if (m) {
      const i = Number(m[1]);
      if (i < 0 || i >= total) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('out of range');
        return;
      }

      // 「还原候选故意失败」：只打全尺寸那张（/img/，不是 /thumb/），
      // 页面上的缩略图照常显示 —— 精确复现「第一轮还原没成功，但图本身没问题」。
      if (!url.startsWith('/thumb/')) {
        fullLog.push({ i, method: req.method });
      }
      if (!url.startsWith('/thumb/') && shouldFailCandidate(i)) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': '0' });
        res.end();
        return;
      }

      // 探测请求 = HEAD，或带 Range 的 GET（扩展的 probeRemoteSize 这两条路都会走）。
      // 页面里 <img> 的普通 GET 不带 Range，所以不会被误伤。
      const isProbe = req.method === 'HEAD' || !!req.headers.range;
      if (isProbe) {
        probeLog.push({ i, method: req.method, range: req.headers.range || '' });
        if (shouldFailProbe(i)) {
          // Content-Length 显式给 0：这样即便扩展走 Range 兜底分支，
          // 拿到的也是 bytes=0，而不是把错误页的正文长度当成图片体积。
          res.writeHead(500, { 'Content-Type': 'text/plain', 'Content-Length': '0' });
          res.end();
          return;
        }
      }

      const buf = pngOf(i, url.startsWith('/thumb/'),
        opts.bceProcess && /[?&]x-bce-process=/.test(req.url));
      // HEAD 时 Node 会自动省略 body，但 Content-Length 仍会发出，
      // 正好用来验证扩展的「体积探测」链路。
      const send = () => {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'Accept-Ranges': 'bytes'
        });
        res.end(buf);
      };

      // 冷路径才延迟：页面 <img> 走 /thumb/（视为已在浏览器缓存里，立刻返回），
      // 原图还原发起的候选请求走 /img/（视为要联网，按 imgDelay 慢下来）。
      const cold = !url.startsWith('/thumb/');
      if (cold && opts.imgDelay > 0) setTimeout(send, opts.imgDelay);
      else send();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    /* 监听地址分两种：
       - 默认（127.0.0.1）按 host 绑，走**纯 IPv4** —— 不给正常站点平白加一层
         IPv4-mapped IPv6 的开销（探测类套件要发上百个请求，累积起来不小）。
       - `host: 'localhost'` 时**绑所有接口**（Node 默认 `::`，IPv6 双栈）。
         verbatim 解析顺序下 `listen(0, 'localhost')` 只会绑到 ::1 或 127.0.0.1
         中的**一个**（实测是 ::1），而浏览器解析 localhost 的顺序未必一致 ——
         于是 page.goto 直接 ERR_CONNECTION_REFUSED。「多标签页合并嗅探」正是靠
         `host: 'localhost'` 起第二个站点，就这么红的。
       origin 仍然按 opts.host 拼，所以「两个站点 host 名不同」的语义不受影响。 */
    const bindHost = opts.host === 'localhost' ? undefined : opts.host;
    server.listen(0, bindHost, () => {
      const port = server.address().port;
      const origin = 'http://' + opts.host + ':' + port;
      resolve({
        server,
        port,
        host: opts.host,
        origin,
        url: origin + '/',
        /** 同一个站点上另一个路径的完整地址（多页模式用） */
        pathUrl: (p) => origin + p,
        frameUrl: origin + '/frame',
        total,
        perBatch,
        opts,
        pages: pageList,
        png: pngOf,
        originalBytes,
        transcodedBytes,
        probeLog,
        /** 探测请求命中的去重图片序号（升序） */
        probedIndexes: () => Array.from(new Set(probeLog.map((r) => r.i))).sort((a, b) => a - b),
        resetProbeLog: () => { probeLog.length = 0; },
        fullLog,
        /** 全尺寸图 `/img/i.png` 被请求了几次（还原候选探测的地面真相） */
        fullHits: (i) => fullLog.filter((r) => r.i === i).length,
        resetFullLog: () => { fullLog.length = 0; },
        close: () => server.close()
      });
    });
  });
}

module.exports = { startServer, makePng };
