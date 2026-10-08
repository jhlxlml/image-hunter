/* ImageHunter — 真实浏览器：嗅探结果被截断时必须如实告知
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是 AUDIT P1-4：
 *   后台 finalizeScan 有 SCAN_LIMIT = 2000，超过就 list.slice(0, 2000) 静默截断。
 *   界面上「共 N 张」显示的是截断后的数量，用户完全不知道自己少看了图 ——
 *   这跟当初「图片要能够全部显示」的诉求是直接冲突的。
 *
 * 修法：后台额外回传 found（去重后的真实总数，截断前）与 truncated（是否截断），
 *       弹窗底栏跟在「共 N 张」后面补一句「（本页共 M 张，仅展示前 N 张）」。
 *
 * 覆盖：
 *   - 后台契约：2001 张的页面 → images.length === 2000、found === 2001、truncated === true
 *   - 未超限时不截断：found === images.length、truncated === false
 *   - 弹窗底栏出现截断提示，文案里同时有真实总数与展示数量
 *   - 未超限时提示位保持隐藏（不给正常页面添噪音）
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
const PROFILE = path.join(os.tmpdir(), 'ih-scan-limit-profile-' + Date.now());

const LIMIT = 2000;            // 与 background.js 的 SCAN_LIMIT 对齐
const OVER = LIMIT + 1;        // 2001：刚好越界 1 张，验证边界
const UNDER = 40;              // 未超限对照组

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让后台直接对某个标签页跑一次嗅探，返回原始结果（绕开界面，验后台契约） */
async function scanViaSw(sw, port) {
  return sw.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
    if (!t) return { error: '找不到标签页' };
    return scanTab(t.id);
  }, port);
}

/** 等图库底栏的「共 N 张」达到期望值 */
async function waitTotal(page, n, budgetMs) {
  let waited = 0;
  while (waited < budgetMs) {
    const v = await page.evaluate(() => document.getElementById('statTotal').textContent);
    if (Number(v) >= n) return v;
    await sleep(300);
    waited += 300;
  }
  return page.evaluate(() => document.getElementById('statTotal').textContent);
}

const readNote = (page) => page.evaluate(() => {
  const el = document.getElementById('truncNote');
  return el ? { hidden: el.hidden, text: el.textContent } : null;
});

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  // 2001 张：一行一张竖着排，图片做小一点，页面轻量
  const big = await startServer({ cols: 1, rows: OVER, imgW: 64, imgH: 64 });
  console.log('超限站点 =', big.url, '（' + OVER + ' 张，SCAN_LIMIT = ' + LIMIT + '）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  let small = null;

  try {
    /* ---------- 1. 后台契约：超限 ---------- */
    console.log('\n=== 1. 后台契约：' + OVER + ' 张的页面 ===');
    const page = await ctx.newPage();
    await page.goto(big.url, { waitUntil: 'load', timeout: 60000 });
    await page.bringToFront();
    await sleep(3000);

    const r1 = await scanViaSw(sw, big.port);
    if (r1.error) throw new Error('嗅探失败：' + r1.error);
    console.log('images=' + r1.images.length + ' found=' + r1.found + ' truncated=' + r1.truncated);
    check(r1.ok === true, '嗅探成功');
    check(r1.images.length === LIMIT,
      'images 被截到 ' + LIMIT + ' 张（上限仍然生效）', r1.images.length);
    check(r1.found === OVER,
      'found 回传了截断前的真实总数 ' + OVER, r1.found);
    check(r1.truncated === true, 'truncated 为 true', String(r1.truncated));
    check(typeof r1.found === 'number' && r1.found > r1.images.length,
      'found 与 images.length 的差额就是被藏起来的张数',
      r1.found + ' - ' + r1.images.length + ' = ' + (r1.found - r1.images.length));

    /* ---------- 2. 界面：截断提示 ---------- */
    console.log('\n=== 2. 弹窗底栏应出现截断提示 ===');
    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, big.port);
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');

    const total = await waitTotal(gallery, LIMIT, 60000);
    check(Number(total) === LIMIT, '底栏「共 N 张」显示的是展示数量 ' + LIMIT, total);

    const note = await readNote(gallery);
    console.log('截断提示 =', JSON.stringify(note));
    check(note && note.hidden === false, '截断提示位可见', note && String(note.hidden));
    check(note && note.text.indexOf(String(OVER)) >= 0,
      '提示里有截断前的真实总数 ' + OVER, note && note.text);
    check(note && note.text.indexOf(String(LIMIT)) >= 0,
      '提示里有实际展示的数量 ' + LIMIT, note && note.text);

    /* ---------- 3. 对照：未超限时不显示提示 ---------- */
    console.log('\n=== 3. 对照：' + UNDER + ' 张的页面不应出现提示 ===');
    small = await startServer({ cols: 8, rows: 5, imgW: 64, imgH: 64 });
    console.log('普通站点 =', small.url, '（' + small.total + ' 张）');

    const page2 = await ctx.newPage();
    await page2.goto(small.url, { waitUntil: 'load', timeout: 60000 });
    await sleep(1500);

    const r2 = await scanViaSw(sw, small.port);
    if (r2.error) throw new Error('嗅探失败：' + r2.error);
    console.log('images=' + r2.images.length + ' found=' + r2.found + ' truncated=' + r2.truncated);
    check(r2.truncated === false, '未超限时 truncated 为 false', String(r2.truncated));
    check(r2.found === r2.images.length && r2.images.length === UNDER,
      '未超限时 found === images.length === ' + UNDER,
      r2.found + ' / ' + r2.images.length);

    // 把图库切到普通站点，提示位必须重新隐藏
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, small.port);
    await sleep(1000);
    await waitTotal(gallery, UNDER, 30000);
    await sleep(1500);

    const note2 = await readNote(gallery);
    const total2 = await gallery.evaluate(() => document.getElementById('statTotal').textContent);
    console.log('普通站点：共 ' + total2 + ' 张，提示 =', JSON.stringify(note2));
    check(Number(total2) === UNDER, '底栏「共 N 张」刷新为 ' + UNDER, total2);
    check(note2 && note2.hidden === true, '未超限时截断提示位保持隐藏', note2 && String(note2.hidden));
    check(note2 && note2.text === '',
      '隐藏时文案被清空（不留上一页的过期数字）', note2 && JSON.stringify(note2.text));

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    big.close();
    if (small) small.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
