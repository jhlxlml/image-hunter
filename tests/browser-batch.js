/* ImageHunter — 真实浏览器批量校验：下载到的必须是**原图**，不是 CDN 转码版
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * **完全离线**：目标页由 lib/localsite.js 的 `bceProcess` 模式提供。
 * 它精确复现了 IT之家 / 百度云加速那种形态：
 *   - 页面上的地址带 `?x-bce-process=image/auto-orient,o_1/format,f_avif`
 *   - 带这个参数 → 服务返回**转码版**：像素尺寸与全尺寸**完全相同**，但字节小得多
 *   - 不带       → 服务返回**原图**：每像素伪随机，deflate 存不下，字节大得多
 *
 * 于是「还原有没有真的生效」可以双向断言：地址里的参数被去掉，**而且**
 * 落盘的是大的那份。这正是历史上踩过的坑 —— 修复前 f667889f….jpg 会以
 * image/avif / 52842 字节落盘（还被改名为 .avif），修复后才是 746445 字节的真原图。
 *
 * 覆盖：
 *   1. 扫描器解析出的地址已经去掉了 x-bce-process，且 marked restored
 *   2. 批量下载后每张都落盘、字节数 === 服务端的**原图**字节数（不是转码版）
 *   3. 历史记录与下载记录里的尺寸 / 体积 / MIME 一致
 *   4. 对照：转码版确实小得多（否则第 2 条断言等于没断言）
 */
'use strict';

const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./lib/localsite');

const EDGE = process.env.IH_BROWSER
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'ih-batch-profile-' + Date.now());
const DL = path.join(os.tmpdir(), 'ih-batch-downloads-' + Date.now());

const COLS = 4, ROWS = 3;
const TOTAL = COLS * ROWS;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把扩展的共享层 + 扫描器源码注入页面，用**扩展自己的代码**去解析图片
const SRC = [];
for (const f of ['shared/constants.js', 'shared/utils.js', 'shared/store.js', 'content/scanner.js']) {
  SRC.push(fs.readFileSync(path.join(EXT, f), 'utf8'));
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.mkdirSync(DL, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DL }
  }));

  const site = await startServer({
    cols: COLS, rows: ROWS, imgW: 600, imgH: 400, bceProcess: true
  });
  console.log('测试站点 =', site.url, '（' + TOTAL + ' 张，CDN 转码模式）');
  console.log('  原图字节数   =', site.originalBytes(0));
  console.log('  转码版字节数 =', site.transcodedBytes(0));

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE, headless: true, viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    const page = await ctx.newPage();
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    } catch (e) { console.log('CDP 失败:', e.message); }

    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    /* ---------- 1. 扫描器解析：参数被去掉，且标记为已还原 ---------- */
    console.log('\n=== 1. 扩展扫描器解析出的地址 ===');
    const cands = await page.evaluate(async (src) => {
      delete globalThis.IH;
      globalThis.chrome = {
        runtime: { getURL: (p) => 'x/' + p, lastError: undefined, sendMessage() {}, onMessage: { addListener() {} } },
        storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } }
      };
      for (const code of src) { (0, eval)(code); }
      const IH = globalThis.IH;
      await IH.Store.loadSettings();
      const s = IH.Store.getSettings();
      const imgs = Array.from(document.images);
      const out = [];
      for (const im of imgs) {
        let c = null;
        try { c = await IH.Scanner.resolveForElement(im); } catch (e) { /* */ }
        if (c && c.url) {
          out.push({
            pageSrc: im.currentSrc || im.getAttribute('src') || '',
            url: c.url,
            width: c.width || 0,
            height: c.height || 0,
            restored: !!c.restored,
            rule: c.restoreRule || '',
            filename: IH.U.buildFilename(c, s, 0)
          });
        }
      }
      return out;
    }, SRC);

    console.log('解析到候选:', cands.length);
    cands.slice(0, 3).forEach((c, i) => console.log('  #' + i, c.width + 'x' + c.height,
      c.filename, 'restored=' + c.restored, '(' + c.rule + ')', '\n      ' + c.url));

    check(cands.length === TOTAL, '解析出全部 ' + TOTAL + ' 张', cands.length);
    check(cands.length > 0 && cands.every((c) => c.pageSrc.indexOf('x-bce-process=') >= 0),
      '页面上的地址确实带 x-bce-process（否则这轮测试没意义）',
      JSON.stringify(cands.slice(0, 1).map((c) => c.pageSrc)));
    check(cands.length > 0 && cands.every((c) => c.url.indexOf('x-bce-process=') < 0),
      '解析后的地址已经去掉了 x-bce-process', JSON.stringify(cands.slice(0, 1).map((c) => c.url)));
    check(cands.length > 0 && cands.every((c) => c.restored === true),
      '每一张都被标记为「已还原」', String(cands.filter((c) => !c.restored).length) + ' 张没标记');
    check(cands.length > 0 && cands.every((c) => c.rule === 'bce-process'),
      '还原规则如实记成 bce-process，而不是笼统的 builtin',
      JSON.stringify(Array.from(new Set(cands.map((c) => c.rule)))));
    check(cands.length > 0 && cands.every((c) => c.width === 600 && c.height === 400),
      '像素尺寸仍是 600×400（转码版与全尺寸同尺寸，靠面积分不出高下）',
      JSON.stringify(cands.slice(0, 3).map((c) => c.width + 'x' + c.height)));

    // 对照：转码版确实小得多，否则下面「下载到的是原图」那条断言没有区分力
    check(site.originalBytes(0) > site.transcodedBytes(0) * 100,
      '对照：原图比转码版大两个数量级（' + site.originalBytes(0)
      + ' vs ' + site.transcodedBytes(0) + '）',
      '原图/转码 = ' + (site.originalBytes(0) / site.transcodedBytes(0)).toFixed(1));

    /* ---------- 2. 批量下载 ---------- */
    console.log('\n=== 2. 驱动后台批量下载 ===');
    const out = await sw.evaluate(async (items) => {
      const before = await chrome.storage.local.get('ih_history');
      const beforeN = (before.ih_history || []).length;
      await startBatch(items, {});
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        if (!queue.length && !pumping) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, 1500));
      const after = await chrome.storage.local.get('ih_history');
      const added = (after.ih_history || []).slice(0, (after.ih_history || []).length - beforeN);
      const dl = await chrome.downloads.search({ limit: 40, orderBy: ['-startTime'] });
      return {
        job: job && { status: job.status, total: job.total, done: job.done, failed: job.failed, skipped: job.skipped },
        added: added.map((h) => ({ status: h.status, filename: h.filename, bytes: h.bytes, wh: h.width + 'x' + h.height, error: h.error })),
        downloads: dl.map((d) => ({ state: d.state, error: d.error, mime: d.mime, bytes: d.bytesReceived, exists: d.exists, name: (d.filename || '').split('\\').pop() }))
      };
    }, cands.map((c) => ({ url: c.url, filename: c.filename, width: c.width, height: c.height, pageUrl: site.url })));

    console.log('job =', JSON.stringify(out.job));

    check(out.job && out.job.total === TOTAL, '批次总数是 ' + TOTAL, out.job && out.job.total);
    check(out.job && out.job.done === TOTAL, '全部完成（done = ' + TOTAL + '）', out.job && out.job.done);
    check(out.job && out.job.failed === 0, '没有失败项', out.job && out.job.failed);

    /* ---------- 3. 落盘的是原图字节数 ---------- */
    console.log('\n=== 3. 落盘文件的字节数 ===');
    const files = fs.readdirSync(DL);
    const sizes = files.map((f) => fs.statSync(path.join(DL, f)).size).sort((a, b) => a - b);
    console.log('下载目录 ' + files.length + ' 个文件，体积范围 '
      + (sizes[0] || 0) + ' ~ ' + (sizes[sizes.length - 1] || 0));

    const wantBytes = site.originalBytes(0);
    const badBytes = site.transcodedBytes(0);

    check(files.length === TOTAL, '落盘 ' + TOTAL + ' 个文件', files.length);
    check(files.length > 0 && sizes.every((s) => s === wantBytes),
      '每个文件都是原图字节数（' + wantBytes + '），不是转码版（' + badBytes + '）',
      '实际分布 ' + JSON.stringify(Array.from(new Set(sizes))));
    check(files.length > 0 && sizes.every((s) => s !== badBytes),
      '没有一个文件是转码版的大小',
      String(sizes.filter((s) => s === badBytes).length) + ' 个命中');

    const mimes = Array.from(new Set(out.downloads.map((d) => d.mime)));
    check(mimes.length === 1 && mimes[0] === 'image/png',
      '下载记录的 MIME 都是 image/png', JSON.stringify(mimes));
    check(out.downloads.every((d) => d.state === 'complete' && d.exists !== false),
      '下载记录都是 complete 且文件存在',
      JSON.stringify(out.downloads.filter((d) => d.state !== 'complete').slice(0, 2)));
    check(out.downloads.every((d) => d.bytes === wantBytes),
      'chrome.downloads 报的字节数也等于原图字节数',
      JSON.stringify(Array.from(new Set(out.downloads.map((d) => d.bytes)))));

    /* ---------- 4. 历史记录 ---------- */
    console.log('\n=== 4. 历史记录 ===');
    check(out.added.length === TOTAL, '历史新增 ' + TOTAL + ' 条', out.added.length);
    check(out.added.every((h) => h.status === 'done'),
      '每条历史都是 done', JSON.stringify(Array.from(new Set(out.added.map((h) => h.status)))));
    check(out.added.every((h) => h.bytes === wantBytes),
      '每条历史记的体积都是原图字节数',
      JSON.stringify(Array.from(new Set(out.added.map((h) => h.bytes)))));
    check(out.added.every((h) => h.wh === '600x400'),
      '每条历史记的尺寸都是 600x400',
      JSON.stringify(Array.from(new Set(out.added.map((h) => h.wh)))));
    check(out.added.every((h) => /\.png$/i.test(h.filename || '')),
      '落盘文件名保留了 .png',
      JSON.stringify(Array.from(new Set(out.added.map((h) => h.filename))).slice(0, 3)));

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
