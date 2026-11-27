/* ImageHunter — 真实浏览器：新增嗅探能力与设置页导出回归
 *
 * 覆盖：
 *   1. 页面内 <canvas> 导出（scanCanvas: true）+ blob: 转 data:（convertBlob: true）
 *      + <input type="image"> + <object type="image/png">
 *   2. 设置页下载历史弹窗「导出 CSV」（含 UTF-8 BOM 与公式注入防护）
 *   3. 设置页自定义还原规则「导出规则 / 导入规则」
 */
'use strict';

const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.IH_BROWSER
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'ih-sniff-extra-' + Date.now());

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 PNG buffer
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC',
  'base64'
);

function startExtraServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/pic.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(TINY_PNG);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Sniff Extra</title></head>
<body>
  <canvas id="cv" width="320" height="320"></canvas>
  <img id="blobImg" width="320" height="320">
  <input type="image" src="/pic.png" width="100" height="100" alt="btn">
  <object type="image/png" data="/pic.png" width="100" height="100"></object>
  <script>
    const cv = document.getElementById('cv');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(0, 0, 320, 320);
    cv.toBlob((b) => {
      document.getElementById('blobImg').src = URL.createObjectURL(b);
    }, 'image/png');
  </script>
</body></html>`);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ url: 'http://127.0.0.1:' + addr.port + '/', close: () => srv.close() });
    });
  });
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  const srv = await startExtraServer();
  console.log('测试页地址 =', srv.url);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;

  // 1. 打开设置页：开启 scanCanvas，写入一条带公式前缀的测试历史记录，测历史 CSV + 规则导入导出
  const optPage = await ctx.newPage();
  await optPage.goto('chrome-extension://' + extId + '/options/options.html');
  await optPage.waitForFunction(() => !!document.querySelector('input[data-key="scanCanvas"]'));

  await optPage.evaluate(async () => {
    await globalThis.IH.Store.updateSettings({ scanCanvas: true, convertBlob: true });
    await globalThis.IH.Store.addHistory({
      ts: Date.now(),
      filename: '=CMD|calc.png',
      url: 'https://example.com/a.png',
      pageUrl: 'https://example.com/',
      width: 100,
      height: 100,
      bytes: 1234,
      status: 'failed'
    });
  });

  // 拦截 downloadText 验证历史 CSV 导出与公式注入转义
  await optPage.evaluate(() => {
    window.__downloads = [];
    globalThis.IH.U.downloadText = (name, text, mime) => {
      window.__downloads.push({ name, text, mime });
    };
  });
  await optPage.click('#btnViewHistory');
  await optPage.waitForFunction(() => !document.getElementById('modal').hidden);
  await optPage.click('.hist-toolbar .btn');
  const histDl = await optPage.evaluate(() => window.__downloads.slice(-1)[0]);
  check(!!histDl && /\.csv$/i.test(histDl.name), '下载历史导出生成 .csv 文件');
  check(!!histDl && histDl.text.charCodeAt(0) === 0xfeff, '历史 CSV 含 UTF-8 BOM');
  check(!!histDl && histDl.text.includes("'=CMD|calc.png"), '历史 CSV 对 = 开头文件名做了防公式注入转义');
  await optPage.click('#modalClose');

  // 自定义规则导入/导出
  const ruleFile = path.join(PROFILE, 'rules.json');
  fs.writeFileSync(ruleFile, JSON.stringify([{ pattern: '_thumb\\.', flags: 'i', replace: '.' }]));
  await optPage.setInputFiles('#importRulesFile', ruleFile);
  await sleep(200);
  const rulesNow = await optPage.evaluate(() => globalThis.IH.Store.getSettings().customRules);
  check(Array.isArray(rulesNow) && rulesNow.some((r) => r.pattern === '_thumb\\.'), '自定义规则 JSON 导入成功');
  await optPage.click('#btnExportRules');
  const ruleDl = await optPage.evaluate(() => window.__downloads.slice(-1)[0]);
  check(!!ruleDl && ruleDl.name === 'image-hunter-rules.json' && ruleDl.text.includes('_thumb'), '自定义规则导出 JSON 成功');

  // 2. 打开测试页，等待 blob URL 就绪，再开独立图库页扫描
  const testPage = await ctx.newPage();
  await testPage.goto(srv.url);
  await testPage.waitForFunction(() => {
    const img = document.getElementById('blobImg');
    return img && /^blob:/i.test(img.src) && img.complete;
  });

  const popPage = await ctx.newPage();
  await popPage.goto('chrome-extension://' + extId + '/popup/popup.html?mode=page');
  await popPage.waitForFunction(() => document.getElementById('loading').hidden && document.querySelectorAll('.card').length > 0, { timeout: 15000 });
  await popPage.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('.card img'));
    return imgs.some((im) => /^data:image\/png/i.test(im.getAttribute('src') || ''));
  }, { timeout: 15000 }).catch(() => {});

  const scanInfo = await popPage.evaluate(async () => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const srcs = cards.map((el) => el.dataset.source || '');
    const imgSrcs = cards.map((el) => (el.querySelector('img') ? el.querySelector('img').getAttribute('src') : ''));
    return { count: cards.length, srcs, imgSrcs };
  });
  check(scanInfo.imgSrcs.some((s) => /^data:image\/png/i.test(s)), '真机扫描成功采集到 canvas/blob 转存后的 data:image/png 图片', JSON.stringify(scanInfo));
  check(scanInfo.count >= 2, '真机扫描采集到额外标签与画布图片 (count=' + scanInfo.count + ')');

  // 3. 验证 ZIP 批量打包进度条与下载触发
  await popPage.click('#btnSelectAll');
  await popPage.click('#btnSaveZip');
  await popPage.waitForFunction(() => {
    const p = document.getElementById('progress');
    return p && !p.hidden && p.getAttribute('aria-valuenow') === '100';
  }, { timeout: 10000 });
  const zipUi = await popPage.evaluate(() => ({
    hidden: document.getElementById('progress').hidden,
    now: document.getElementById('progress').getAttribute('aria-valuenow'),
    text: document.getElementById('progressText').textContent
  }));
  check(!zipUi.hidden && zipUi.now === '100' && zipUi.text.length > 0, 'ZIP 打包显示进度条并推进至 100%', JSON.stringify(zipUi));

  await ctx.close();
  srv.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
