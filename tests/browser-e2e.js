/* ImageHunter — 真实浏览器端到端：悬停 → 点下载 → 文件真的落盘
 *
 * 依赖：playwright-core + 本机 Chromium 系浏览器（Edge / Chrome）。
 *       npm i playwright-core   （无需下载浏览器，直接用系统已装的）
 * 用法：NODE_PATH=<node_modules> node tests/browser-e2e.js
 *
 * **完全离线**：目标页由 lib/localsite.js 的 `bceProcess` 模式提供（缩略图地址带
 * `?x-bce-process=image/format,f_avif`，服务返回「同像素尺寸、字节小得多」的转码版；
 * 去掉参数才拿到真原图）。这样「保存的是不是原图」才有地面真相可比。
 *
 * 说明：这个文件以前只**打印**信息、从不失败（没有断言、退出码恒为 0），
 * 加上要访问外网，实际上既跑不了也测不出东西。现在改成真断言 + 本地站。
 *
 * 覆盖：
 *   1. 悬停后出现页内 UI：宿主 + 「预览 / 下载」两个按钮，且停在图片右上角
 *   2. 点下载 → 气泡如实说「已保存原图 600×400」
 *   3. 下载目录里确实出现**一个**文件，字节数 === 服务端的原图字节数（不是转码版）
 *   4. 后台历史：1 条、done、pageUrl 是图片所在页面（不是 chrome-extension://）
 *   5. 再点同一张 → 「已下载过，本次已跳过」，且不会多出一个文件
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
const PROFILE = path.join(os.tmpdir(), 'ih-e2e-profile-' + Date.now());
const DL = path.join(os.tmpdir(), 'ih-e2e-downloads-' + Date.now());

const COLS = 4, ROWS = 3;
const TOTAL = COLS * ROWS;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 ok() 为真，返回最后一次取值 */
async function until(fn, ok, budgetMs, stepMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(stepMs || 150);
  }
  return last;
}

/**
 * 等下载目录**稳定**下来（文件列表连续 1.2 秒不变）再数文件。
 * 只等固定毫秒数会误判：第二次下载如果没被「跳过」，Chrome 会用
 * conflictAction:'uniquify' 存成 `0 (1).png` —— 落盘晚一点，
 * 数早了就会看到「还是 1 个文件」，那条断言于是变成恒真的废话。
 */
async function waitFiles(budgetMs) {
  const t0 = Date.now();
  let lastKey = '';
  let stableSince = 0;
  let list = [];
  while (Date.now() - t0 < (budgetMs || 10000)) {
    list = fs.readdirSync(DL);
    const key = list.join('|');
    if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 1200) return list;
    await sleep(200);
  }
  return list;
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.mkdirSync(DL, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DL }
  }));

  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 600, imgH: 400, bceProcess: true });
  console.log('测试站点 =', site.url, '（' + TOTAL + ' 张，CDN 转码模式）');
  console.log('  原图字节数 =', site.originalBytes(0), '/ 转码版 =', site.transcodedBytes(0));

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    const page = await ctx.newPage();
    // 覆盖 Playwright 的下载重定向，让文件名保持真实（否则会被改成 UUID）
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    } catch (e) { console.log('CDP 失败:', e.message); }

    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    /* ---------- 1. 悬停 → 出现两个按钮 ---------- */
    console.log('\n=== 1. 悬停图片 → 页内 UI ===');
    // 挑「完整落在视口里、面积最大」的那张，避免贴边元素被裁
    const target = await page.evaluate(() => {
      const cands = Array.from(document.images)
        .map((im) => ({ im, r: im.getBoundingClientRect() }))
        .filter(({ r }) => r.width >= 120 && r.height >= 80 && r.top >= 40 && r.bottom <= window.innerHeight - 40);
      if (!cands.length) return null;
      cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
      const el = cands[0].im;
      el.setAttribute('data-ih-e2e-target', '1');
      const r = el.getBoundingClientRect();
      return {
        src: el.currentSrc || el.getAttribute('src'),
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }
      };
    });
    console.log('目标图片:', JSON.stringify(target));
    check(!!target, '页面上找到一张完整可见的图片');
    check(!!target && target.src.indexOf('x-bce-process=') >= 0,
      '这张图的地址带着 x-bce-process（还原场景成立）', target && target.src);

    if (!target) { console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项'); await ctx.close(); site.close(); process.exit(1); }

    await page.hover('[data-ih-e2e-target="1"]');
    await sleep(600);

    const ui = await page.evaluate(() => {
      const host = document.querySelector('[data-ih-host]');
      if (!host) return { host: false };
      const sr = host.shadowRoot;
      const bar = sr && sr.querySelector('.ih-hover');
      const save = sr && sr.querySelector('.ih-hover-save');
      const preview = sr && sr.querySelector('.ih-hover-preview');
      const img = document.querySelector('[data-ih-e2e-target="1"]');
      const ir = img.getBoundingClientRect();
      const br = bar ? bar.getBoundingClientRect() : null;
      return {
        host: true,
        save: !!save,
        preview: !!preview,
        bar: br ? { top: br.top, right: br.right, bottom: br.bottom, left: br.left } : null,
        img: { top: ir.top, right: ir.right, bottom: ir.bottom, left: ir.left }
      };
    });
    console.log('悬停 UI:', JSON.stringify(ui));

    check(ui.host === true, '悬停后出现了页内 UI 宿主');
    check(ui.save === true, '有「保存原图」按钮');
    check(ui.preview === true, '有「大图预览」按钮');
    check(!!ui.bar && ui.bar.bottom < (ui.img.top + ui.img.bottom) / 2,
      '按钮排停在图片**上半部分**（不是压在中间）',
      ui.bar && JSON.stringify(ui.bar));
    check(!!ui.bar && ui.bar.right >= ui.img.right - 60 && ui.bar.right <= ui.img.right + 8,
      '按钮排右对齐贴住图片右上角',
      ui.bar && (ui.bar.right + ' vs img.right ' + ui.img.right));

    /* ---------- 2. 点下载 ---------- */
    console.log('\n=== 2. 点击下载 ===');
    const btn = page.locator('[data-ih-host] .ih-hover-save').first();
    await btn.click({ force: true });
    console.log('已点击下载图标');

    const bubble = await until(
      () => page.locator('[data-ih-host] .ih-bubble').first()
        .evaluate((el) => ({ text: el.textContent, cls: el.className })).catch(() => null),
      (b) => b && /已保存|已下载|失败/.test(b.text || ''),
      15000
    );
    console.log('气泡:', JSON.stringify(bubble));

    check(!!bubble && /已保存/.test(bubble.text), '气泡说的是「已保存」', bubble && bubble.text);
    check(!!bubble && /原图/.test(bubble.text), '气泡明确写了「原图」（不是转码版）', bubble && bubble.text);
    check(!!bubble && /600×400/.test(bubble.text), '气泡带上了 600×400 的尺寸', bubble && bubble.text);
    check(!!bubble && !/error/.test(bubble.cls || ''), '气泡不是错误态', bubble && bubble.cls);

    /* ---------- 3. 真的落盘，而且是原图字节数 ---------- */
    console.log('\n=== 3. 磁盘上的文件 ===');
    const wantBytes = site.originalBytes(0);
    const badBytes = site.transcodedBytes(0);

    const files = await until(
      () => fs.readdirSync(DL),
      (list) => list.length >= 1,
      15000, 200
    );
    console.log('下载目录:', files.join(', ') || '(空)');

    check(files.length === 1, '下载目录里正好 1 个文件', files.length + ' 个');    const size = files.length ? fs.statSync(path.join(DL, files[0])).size : -1;
    console.log('文件体积 =', size, '（原图应为 ' + wantBytes + '，转码版为 ' + badBytes + '）');
    check(size === wantBytes, '落盘的是**原图**字节数 ' + wantBytes, size);
    check(size !== badBytes, '不是转码版的大小 ' + badBytes, size);

    /* ---------- 4. 后台历史 ---------- */
    console.log('\n=== 4. 后台历史 / 下载记录 ===');
    const bg = await until(async () => await sw.evaluate(async () => {
      const local = await chrome.storage.local.get(null);
      const dl = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
      return {
        history: (local.ih_history || []).map((h) => ({
          status: h.status, filename: h.filename, bytes: h.bytes,
          wh: h.width + 'x' + h.height, pageUrl: h.pageUrl, url: h.url
        })),
        fingerprints: local.ih_fingerprints ? Object.keys(local.ih_fingerprints).length : 0,
        downloads: dl.map((d) => ({ state: d.state, mime: d.mime, bytes: d.bytesReceived, exists: d.exists }))
      };
    }), (v) => v && v.history.length >= 1, 10000);

    console.log('历史:', JSON.stringify(bg.history, null, 2));

    check(bg.history.length === 1, '后台历史正好 1 条', bg.history.length);
    const h0 = bg.history[0] || {};
    check(h0.status === 'done', '这条历史状态是 done', h0.status);
    check(h0.bytes === wantBytes, '历史记的体积是原图字节数', h0.bytes);
    check(h0.wh === '600x400', '历史记的尺寸是 600x400', h0.wh);
    check(String(h0.pageUrl || '').indexOf(site.url) === 0,
      '历史里的 pageUrl 是图片所在页面（不是扩展地址）', h0.pageUrl);
    check(String(h0.url || '').indexOf('x-bce-process=') < 0,
      '历史里存的是还原后的原图地址', h0.url);
    check(bg.fingerprints >= 1, '已下载指纹写入了（去重才有依据）', bg.fingerprints);

    /* ---------- 5. 重复点击 → 跳过 ---------- */
    console.log('\n=== 5. 重复点击同一张 ===');
    await page.hover('[data-ih-e2e-target="1"]');
    await sleep(400);
    await page.locator('[data-ih-host] .ih-hover-save').first().click({ force: true });

    const bubble2 = await until(
      () => page.locator('[data-ih-host] .ih-bubble').first()
        .evaluate((el) => el.textContent).catch(() => ''),
      (t) => /已下载|已保存|失败/.test(t || ''),
      15000
    );
    console.log('第二次气泡:', JSON.stringify(bubble2));
    check(/已下载过|已跳过/.test(bubble2 || ''),
      '提示「已下载过，本次已跳过」（不会伪装成又保存了一次）', bubble2);

    /* 断言「没有重复下载」只能看**下载记录条数**，不能数文件。
       实测：CDP 用 downloadPath 接管下载时，Chrome 不认 conflictAction:'uniquify' ——
       重复下载三次，chrome.downloads 里是 3 条 complete，但目录里始终只有一个 0.png
       （后一次把前一次覆盖了）。所以「目录里还是 1 个文件」在旧行为下也成立，
       是条恒真的废话。 */
    await sleep(900);
    const dlAfter = await sw.evaluate(async () => {
      const d = await chrome.downloads.search({ limit: 10, orderBy: ['-startTime'] });
      return { n: d.length, names: d.map((x) => (x.filename || '').split('\\').pop()) };
    });
    console.log('后台下载记录条数 =', dlAfter.n, JSON.stringify(dlAfter.names));
    check(dlAfter.n === 1, '后台只有 1 条下载记录（第二次真的被跳过了，没有重新下载）',
      dlAfter.n + ' 条: ' + JSON.stringify(dlAfter.names));

    const files2 = await waitFiles(6000);
    check(files2.length === 1, '下载目录里仍只有 1 个文件', files2.join(', '));
    check(files2.length === 1 && fs.statSync(path.join(DL, files2[0])).size === wantBytes,
      '这个文件仍是原图字节数（没有被转码版覆盖）',
      files2.length === 1 ? fs.statSync(path.join(DL, files2[0])).size : 'n/a');

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
