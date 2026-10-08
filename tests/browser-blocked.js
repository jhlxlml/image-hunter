/* ImageHunter — 真实浏览器：站点排除列表
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * **完全离线**：目标页由 lib/localsite.js 起在 127.0.0.1 上。
 *
 * 为什么必须在真浏览器里再测一遍（jsdom 那份 tests/test-blocked.js 已经覆盖了
 * 「悬停显示路径」的接线）：
 *   - jsdom 里的 `location` 改不了，**「按当前页面的域名判断」这件事本身测不到**
 *   - 排除列表的另一个入口在**后台**（扫描前先查标签页 URL），jsdom 里没有后台
 *   - 「图库如实说『已排除』而不是说『没发现图片』」只有把图库真开起来才看得到
 *
 * 覆盖：
 *   1. 被排除的站点：悬停不出按钮、Alt+点击不保存
 *   2. 对照组：把它从列表里移除、刷新页面，同一个站点立刻恢复正常
 *   3. 边界：右键菜单那条「显式保存」路径**仍然可用**（排除的是打扰，不是能力）
 *   4. 图库：对已排除的站点如实说「在排除列表里」，而不是「本页没有发现图片」
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
const PROFILE = path.join(os.tmpdir(), 'ih-blocked-profile-' + Date.now());
const DL = path.join(os.tmpdir(), 'ih-blocked-downloads-' + Date.now());

const COLS = 4, ROWS = 2;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 悬停页面上「面积最大、完整可见」的那张图 */
async function hoverBiggest(page) {
  const ok = await page.evaluate(() => {
    const cands = Array.from(document.images)
      .map((im) => ({ im, r: im.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 120 && r.height >= 80 && r.top >= 40 && r.bottom <= window.innerHeight - 40);
    if (!cands.length) return false;
    cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    cands[0].im.setAttribute('data-ih-probe', '1');
    return true;
  });
  if (!ok) return false;
  await page.hover('[data-ih-probe="1"]');
  await sleep(700);
  return true;
}

const hostCount = (page) => page.evaluate(() => document.querySelectorAll('[data-ih-host]').length);

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.mkdirSync(DL, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DL }
  }));

  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 600, imgH: 400, title: '排除列表测试站' });
  console.log('测试站点 =', site.url, '（' + site.total + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  /** 写设置并**确认后台真的读到了**，避免和 SW 的启动期加载抢跑 */
  async function seedBlocked(hosts) {
    await sw.evaluate(async (list) => {
      const cur = (await chrome.storage.local.get('ih_settings')).ih_settings || {};
      cur.blockedHosts = list;
      await chrome.storage.local.set({ ih_settings: cur });
    }, hosts);
    const got = await until(
      () => sw.evaluate(() => (IH.Store.getSettings().blockedHosts || []).slice()),
      (v) => JSON.stringify(v) === JSON.stringify(hosts),
      6000
    );
    console.log('  后台看到的排除列表 =', JSON.stringify(got));
    return got;
  }

  try {
    /* ---------- 1. 被排除的站点 ---------- */
    console.log('\n=== 1. 被排除的站点（127.0.0.1） ===');
    await seedBlocked(['127.0.0.1']);

    const page = await ctx.newPage();
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    } catch (e) { console.log('CDP 失败:', e.message); }

    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    const imgs = await page.evaluate(() => document.images.length);
    check(imgs === site.total, '图片照常显示（排除的是我们的 UI，不是页面）', imgs + ' 张');

    const hovered = await hoverBiggest(page);
    check(hovered, '找到了一张可悬停的图片');
    check(await hostCount(page) === 0, '悬停不出现任何页内 UI',
      (await hostCount(page)) + ' 个宿主');

    // Alt + 点击：也不该保存
    await page.keyboard.down('Alt');
    await page.click('[data-ih-probe="1"]', { force: true }).catch(() => {});
    await page.keyboard.up('Alt');
    await sleep(1200);
    const dlAfterAlt = await sw.evaluate(async () =>
      (await chrome.downloads.search({ limit: 5 })).length);
    check(dlAfterAlt === 0, 'Alt+点击不会保存', dlAfterAlt + ' 条下载记录');

    /* ---------- 2. 对照：从列表里移除 ---------- */
    console.log('\n=== 2. 对照组：把它从列表里移除 ===');
    await seedBlocked([]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const hovered2 = await hoverBiggest(page);
    check(hovered2, '找到了一张可悬停的图片');
    check(await hostCount(page) === 1, '移除后同一个站点立刻恢复正常（悬停按钮回来了）',
      (await hostCount(page)) + ' 个宿主');

    /* ---------- 3. 显式保存路径仍然可用 ---------- */
    console.log('\n=== 3. 排除的是打扰，不是能力 ===');
    await seedBlocked(['127.0.0.1']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);

    const filesBefore = (() => { try { return fs.readdirSync(DL); } catch (e) { return []; } })();
    // 刻意换一张**没下过**的图：用第 0 张会命中「跳过已下载」，
    // 于是 ok:true 但 skipped:true —— 那条断言就变成了「文件早就在那儿」的废话
    const target = await page.evaluate(() => {
      const im = document.images[1];
      return im ? (im.currentSrc || im.getAttribute('src')) : '';
    });
    console.log('  目标图片 =', target, '（已落盘', filesBefore.length, '个文件）');

    // 右键菜单走的就是这条消息（SAVE_BY_SRC）：用户主动点出来的，仍然照做
    const saved = await sw.evaluate(async (srcUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => /127\.0\.0\.1/.test(t.url || ''));
      if (!tab) return { ok: false, error: '找不到目标标签页' };
      return await chrome.tabs.sendMessage(tab.id, { type: 'IH_SAVE_BY_SRC', payload: { srcUrl } });
    }, target);
    console.log('  SAVE_BY_SRC 结果 =', JSON.stringify(saved));
    check(!!saved && saved.ok === true, '被排除的站点上，显式保存（右键菜单路径）仍然可用',
      JSON.stringify(saved));
    check(!!saved && saved.skipped !== true, '而且这次是真的保存，不是「已下载过」被跳过',
      JSON.stringify(saved));

    const files = await until(() => { try { return fs.readdirSync(DL); } catch (e) { return []; } },
      (l) => l.length > filesBefore.length, 8000);
    check(files.length === filesBefore.length + 1,
      '文件确实多落了一个', filesBefore.length + ' → ' + files.length + ' ' + JSON.stringify(files));

    /* ---------- 4. 图库如实说明 ---------- */
    console.log('\n=== 4. 图库对已排除站点的说法 ===');
    await page.bringToFront();
    await sleep(600);

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async () => {
      const t = await pickTargetTab(null);
      await openGallery(t);
    });
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');
    await sleep(4000);

    const empty = await gallery.evaluate(() => {
      const el = document.getElementById('empty');
      return {
        visible: !!el && !el.hidden,
        text: (document.getElementById('emptyText') || {}).textContent || '',
        hint: (document.getElementById('emptyHint') || {}).textContent || '',
        host: (document.getElementById('pageHost') || {}).textContent || '',
        cards: document.querySelectorAll('#grid > *').length
      };
    });
    console.log(JSON.stringify(empty));

    check(empty.cards === 0, '没有渲染出任何卡片', empty.cards + ' 个');
    check(empty.visible === true, '显示了空状态');
    check(/排除列表/.test(empty.text), '主文案说的是「在排除列表里」而不是「本页没有发现图片」',
      empty.text);
    check(/设置页/.test(empty.hint), '副标题告诉他去哪儿改（设置页）', empty.hint);
    check(!/刷新/.test(empty.hint),
      '副标题**不再**提示「刷新」——那会把人引到错误的方向', empty.hint);
    check(empty.host === '127.0.0.1', '顶栏仍然如实显示站点域名', empty.host);

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
