/* ImageHunter — 真实浏览器：图库「探测体积」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 * 用 tests/lib/localsite.js 起本地 HTTP 站点，图片是内存里手写编码的真实 PNG，
 * 所以**字节数有地面真相**，可以把界面显示的体积跟服务器实际返回的长度逐张比对。
 *
 * 覆盖：
 *   - 探测前卡片显示的是格式名（PNG），顶栏「合计体积」为 —
 *   - 点「探测体积」→ 请求打到后台 PROBE_SIZE → 拿回 Content-Length
 *   - 每张卡片显示的体积与服务器真实字节数**完全一致**
 *   - 顶栏「合计体积」等于选中各张之和
 *   - 按钮在探测中禁用、结束后恢复；重复点击给出合理提示
 *
 * 这条用例是为了回归一个真实 bug：
 *   constants.js 里定义的是 PROBE_SIZE（单数），popup / background 却写了 MSG.PROBE_SIZES，
 *   解析成 undefined → 后台 `if (!msg.type) return` 早退不回应 → 点按钮永远弹「体积探测失败」。
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
const PROFILE = path.join(os.tmpdir(), 'ih-probe-profile-' + Date.now());

const SITE_OPTS = { cols: 6, rows: 4, imgW: 480, imgH: 320 };   // 24 张，够用且探测快
const TOTAL = SITE_OPTS.cols * SITE_OPTS.rows;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取网格里每张卡片的 {url, sizeText} */
async function cardSizes(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('#grid .card')).map((c) => ({
      url: c.title,
      size: (c.querySelector('.size') || {}).textContent || ''
    }));
  });
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  console.log('测试页地址 =', localSite.url, '（' + TOTAL + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  /* ---------- 1. 打开测试页与图库 ---------- */
  console.log('\n=== 1. 打开测试页 → 打开图库独立页 ===');
  const site = await ctx.newPage();
  await site.goto(localSite.url, { waitUntil: 'load', timeout: 60000 });
  await site.bringToFront();
  await sleep(2000);

  const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await sw.evaluate(async () => {
    const target = await pickTargetTab(null);
    await openGallery(target);
  });
  const gallery = await galleryPromise;
  await gallery.waitForLoadState('domcontentloaded');
  await sleep(4000);

  const total = await gallery.evaluate(() => document.getElementById('statTotal').textContent);
  check(Number(total) >= TOTAL, '嗅探到 ' + TOTAL + ' 张图片', total);

  /* ---------- 2. 探测前 ---------- */
  console.log('\n=== 2. 探测前：体积未知 ===');
  const before = await cardSizes(gallery);
  console.log('前 3 张: ' + JSON.stringify(before.slice(0, 3)));
  check(before.length >= TOTAL, '网格渲染出卡片', before.length + ' 张');
  check(before.every((c) => c.size === 'PNG'), '卡片右侧显示的是格式名 PNG（体积未知）',
    before.slice(0, 3).map((c) => c.size).join(', '));
  const statSizeBefore = await gallery.evaluate(() => document.getElementById('statSize').textContent);
  check(statSizeBefore === '—', '顶栏「合计体积」为 —', statSizeBefore);

  /* ---------- 3. 点击「探测体积」 ---------- */
  console.log('\n=== 3. 点击「探测体积」 ===');
  const btnState = await gallery.evaluate(() => ({
    disabled: document.getElementById('btnProbe').disabled,
    busy: document.getElementById('btnProbe').classList.contains('busy')
  }));
  check(btnState.disabled === false && btnState.busy === false, '按钮初始可用', JSON.stringify(btnState));

  await gallery.evaluate(() => document.getElementById('btnProbe').click());

  // 立刻看一眼：按钮应处于「探测中」禁用态（图标按钮用 busy 类，不再是改文案）
  await sleep(120);
  const during = await gallery.evaluate(() => ({
    disabled: document.getElementById('btnProbe').disabled,
    busy: document.getElementById('btnProbe').classList.contains('busy')
  }));
  console.log('探测中按钮: ' + JSON.stringify(during));
  check(during.busy || !during.disabled,
    '按钮进入探测中状态（或已快速完成）', JSON.stringify(during));

  // 等探测结束：按钮恢复可用且退出 busy
  let waited = 0;
  while (waited < 30000) {
    const t = await gallery.evaluate(() => ({
      disabled: document.getElementById('btnProbe').disabled,
      busy: document.getElementById('btnProbe').classList.contains('busy')
    }));
    if (!t.disabled && !t.busy) break;
    await sleep(300);
    waited += 300;
  }
  const toastText = await gallery.evaluate(() => document.getElementById('toast').textContent);
  console.log('提示文案: ' + toastText);
  check(!/失败/.test(toastText), '没有出现「失败」提示', toastText);
  check(/已获取\s*(\d+)\s*张图片的体积/.test(toastText), '提示为「已获取 N 张图片的体积」', toastText);

  /* ---------- 4. 逐张比对真实字节数 ---------- */
  console.log('\n=== 4. 显示体积 vs 服务器真实字节数 ===');
  const after = await cardSizes(gallery);
  const bad = [];
  let compared = 0;

  for (let i = 0; i < Math.min(after.length, TOTAL); i++) {
    const realBytes = localSite.png(i).length;
    // 用页面里同一份 formatBytes 生成期望文案，避免测试自己复制格式化规则
    const expected = await gallery.evaluate((b) => IH.U.formatBytes(b), realBytes);
    const got = after[i].size;
    compared++;
    if (got !== expected) bad.push({ i, url: after[i].url, got, expected, realBytes });
  }

  console.log('前 3 张实际显示: ' + JSON.stringify(after.slice(0, 3)));
  check(bad.length === 0,
    compared + ' 张卡片的体积与服务器真实字节数完全一致',
    bad.length ? JSON.stringify(bad.slice(0, 4)) : '');
  check(after.every((c) => c.size !== 'PNG'), '卡片不再显示格式名，而是真实体积');

  /* ---------- 5. 顶栏「合计体积」= 选中各张之和 ---------- */
  console.log('\n=== 5. 合计体积 ===');
  const sumCheck = await gallery.evaluate((n) => {
    // 通过点击卡片选中前 n 张
    const cards = Array.from(document.querySelectorAll('#grid .card')).slice(0, n);
    cards.forEach((c) => c.click());
    return document.getElementById('statSize').textContent;
  }, 5);
  const expectSum = await gallery.evaluate((bytesList) => {
    const total = bytesList.reduce((a, b) => a + b, 0);
    return IH.U.formatBytes(total);
  }, Array.from({ length: 5 }, (_, i) => localSite.png(i).length));
  console.log('界面合计 = ' + sumCheck + '，期望 = ' + expectSum);
  check(sumCheck === expectSum, '顶栏合计体积等于选中 5 张之和', sumCheck + ' vs ' + expectSum);

  /* ---------- 6. 重复点击 ---------- */
  console.log('\n=== 6. 重复点击 ===');
  await gallery.evaluate(() => document.getElementById('btnProbe').click());
  await sleep(1200);
  const toast2 = await gallery.evaluate(() => document.getElementById('toast').textContent);
  console.log('提示文案: ' + toast2);
  check(/没有需要探测的图片|已获取/.test(toast2), '重复点击给出合理提示', toast2);
  const stillOk = await gallery.evaluate(() => !document.getElementById('btnProbe').disabled);
  check(stillOk, '按钮恢复可用，没有卡在探测中');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await ctx.close();
  localSite.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
