/* ImageHunter — 真实浏览器：首次点开图标就要出图（不许「刷新一下才行」）
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是用户报的这句话：**「首次点击扩展图标，嗅探有问题，要刷新下才行」**。
 *
 * 根因（已定位，见 tests/test-scan-timeout.js 的说明）：
 *   background.js 的 scanTab() 一开始就挂一个 4 秒兜底计时，本意是
 *   「内容脚本完全没接上话」。可它同时也在给内容脚本的**正常加工**计时 ——
 *   补尺寸只能靠真实加载，页面自己还没加载的图（懒加载、首屏之外）就得等网络。
 *   十几张没加载的图就足够把首次回报推迟到 4 秒以上 → 4 秒一到就收尾 →
 *   此刻一个 frame 都还没回报 → ok:true + 空列表 → 图库说「本页没有发现图片」。
 *   刷新一次为什么就好了：第二次的探测结果已在内容脚本的缓存里，回报是毫秒级的。
 *
 * 修法（两处，缺一不可）：
 *   · 内容脚本：把「先出图」的中间结果**挪到补尺寸之前** ——
 *     首次回报的耗时改由采集（纯 DOM，快且可控）决定，不再由联网步骤决定；
 *   · 后台：收到内容脚本对 DO_SCAN 的确认之后，把兜底计时从「没接上话」档
 *     放宽到加工档；并且**一个 frame 都没回报时不许说「本页没有发现图片」**。
 *
 * 覆盖：
 *   1. 首次打开：图片在 4 秒判据之内就铺出来了（这就是那条 bug 的正面回归）
 *   2. 全程没有出现过「本页没有发现图片」这个错误说法
 *   3. 最终结果（补完尺寸）仍然会到，数量一张不少
 *   4. 关掉图库、趁上一轮还没跑完再打开一次 → 也要出图（内容脚本排队，不回空结果）
 *   5. 反向：页面里真的一张图都没有时，**仍然**说「本页没有发现图片」
 *      —— 修「撒谎」不能把「如实」也修坏
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
const PROFILE = path.join(os.tmpdir(), 'ih-first-scan-profile-' + Date.now());

const COLS = 4, ROWS = 3;
const TOTAL = COLS * ROWS;          // 12 张
/* 每张图响应延迟。为什么必须这么慢：
   要让「补尺寸」这一步明显超过后台的 4 秒判据，否则复现不出这个 bug。
   12 张、探测并发 6 → 两批 × 2500ms ≈ 5 秒 > 4 秒。 */
const IMG_DELAY = 2500;
/** 后台「内容脚本没接上话」的判据（background.js SCAN_IDLE_TIMEOUT） */
const IDLE_BUDGET_MS = 4000;

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

/** 图库此刻的样子 */
function snapshot(page) {
  return page.evaluate(() => {
    const grid = document.getElementById('grid');
    const empty = document.getElementById('empty');
    const txt = empty && !empty.hidden ? empty.textContent.replace(/\s+/g, ' ').trim() : '';
    return {
      cards: grid ? grid.querySelectorAll('.card').length : -1,
      emptyShown: !!empty && !empty.hidden,
      emptyText: txt,
      /* 「本页没有发现图片」和「嗅探失败」是两回事：
         前者是「看过了，没有」，后者是「没看成」。这条 bug 的要害就是它们混了。 */
      saysNoImages: /没有发现图片/.test(txt),
      total: Number((document.getElementById('statTotal') || {}).textContent || 0)
    };
  });
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 600, imgH: 400, imgDelay: IMG_DELAY });
  console.log('测试站点 =', site.url, '（' + TOTAL + ' 张，每张响应延迟 ' + IMG_DELAY + 'ms）');

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
    /* ---------- 0. 准备：页面已加载完、内容脚本就位 ---------- */
    console.log('\n=== 0. 准备目标页 ===');
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(IMG_DELAY + 2500);

    const tabId = await sw.evaluate(() => pickTargetTab(null));
    const ping = await sw.evaluate(async (id) => {
      try { return await chrome.tabs.sendMessage(id, { type: 'IH_PING' }); } catch (e) { return null; }
    }, tabId);
    check(tabId != null && !!(ping && ping.ok), '内容脚本已在目标页上就位', JSON.stringify(ping));

    /* 把已经加载好的 src 挪到 data-src：这是真实站点上最常见的两种情形 ——
       「懒加载还没触发」和「图片还没加载完」。此时 naturalWidth = 0，
       嗅探只能靠联网探测补尺寸，而那正是把首次回报拖过 4 秒的那一步。 */
    const stripped = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('img').forEach((im) => {
        const s = im.getAttribute('src');
        if (s) { im.removeAttribute('src'); im.setAttribute('data-src', s); n++; }
      });
      return n;
    });
    check(stripped === TOTAL, '把 ' + TOTAL + ' 张图的 src 挪到 data-src（尺寸变成未知）', stripped);

    /* ---------- 1. 首次打开图库 ---------- */
    console.log('\n=== 1. 首次打开图库（就是「点扩展图标」这一步） ===');
    const t0 = Date.now();
    const p1 = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (id) => { await openGallery(id); }, tabId);
    const gallery = await p1;
    await gallery.waitForLoadState('domcontentloaded');

    /* 一边等一边记录「有没有出现过那句错话」。
       不能只在最后看一眼：中途出现过又消失，对用户来说也是出现过。 */
    let sawNoImages = false;
    let firstCardsAt = 0;
    const painted = await until(async () => {
      const s = await snapshot(gallery);
      if (s.saysNoImages) sawNoImages = true;
      if (s.cards > 0 && !firstCardsAt) firstCardsAt = Date.now() - t0;
      return s;
    }, (s) => s.cards > 0, 12000);

    console.log('  首次出图耗时 =', firstCardsAt, 'ms，卡片 =', painted.cards);
    check(painted.cards === TOTAL,
      '首次打开就铺出了 ' + TOTAL + ' 张图（不再需要刷新）', painted.cards + ' 张');
    check(firstCardsAt > 0 && firstCardsAt < IDLE_BUDGET_MS,
      '出图发生在后台的「没接上话」判据（' + IDLE_BUDGET_MS + 'ms）之内',
      firstCardsAt + 'ms');
    check(sawNoImages === false,
      '全程没有出现过「本页没有发现图片」这句错话（没扫成 ≠ 没有图）');

    /* ---------- 2. 最终结果仍然会到（补完尺寸） ---------- */
    console.log('\n=== 2. 最终结果（尺寸补齐） ===');
    /* 别拿 statTotal 当「最终结果到了」的判据 —— 中间结果里它就已经是 12 了，
       一查就返回，等于什么都没等。真正的判据是**卡片上的尺寸**：
       中间结果是补尺寸**之前**交出来的，那一版里未知尺寸会显示成「尺寸未知」；
       最终结果把它们换成真实尺寸。 */
    const unknownAt = await gallery.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#grid .card'));
      return cards.filter((c) => /尺寸未知/.test(c.textContent)).length;
    });
    console.log('  中间结果阶段「尺寸未知」的卡片 =', unknownAt);

    const sized = await until(
      () => gallery.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#grid .card'));
        return {
          cards: cards.length,
          unknown: cards.filter((c) => /尺寸未知/.test(c.textContent)).length
        };
      }),
      (s) => s.cards > 0 && s.unknown === 0,
      20000
    );
    console.log('  最终结果：卡片 =', sized.cards, '，尺寸未知 =', sized.unknown);
    check(sized.cards === TOTAL, '最终结果里仍然是 ' + TOTAL + ' 张', sized.cards);
    check(sized.unknown === 0, '尺寸都补上了（没有停在「尺寸未知」）', sized.unknown + ' 张未知');

    /* ---------- 3. 关掉、趁上一轮还没跑完再打开 ---------- */
    console.log('\n=== 3. 立刻关掉再打开一次（上一轮可能还在还原） ===');
    await gallery.close();
    await sleep(300);
    const t1 = Date.now();
    const p2 = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (id) => { await openGallery(id); }, tabId);
    const gallery2 = await p2;
    await gallery2.waitForLoadState('domcontentloaded');

    let sawNoImages2 = false;
    const again = await until(async () => {
      const s = await snapshot(gallery2);
      if (s.saysNoImages) sawNoImages2 = true;
      return s;
    }, (s) => s.cards > 0 || (s.emptyShown && !s.saysNoImages), 15000);
    console.log('  第二次出图耗时 =', Date.now() - t1, 'ms，卡片 =', again.cards, '，空态 =', again.emptyShown);
    check(again.cards === TOTAL, '第二次打开也有图（内容脚本排队，不回空结果）', again.cards + ' 张');
    check(sawNoImages2 === false, '第二次也没有出现过「本页没有发现图片」');
    await gallery2.close();

    /* ---------- 4. 反向：页面里真的一张图都没有 ---------- */
    console.log('\n=== 4. 反向：页面确实没有图片 → 仍然如实说「没有发现图片」 ===');
    /* 必须换一个地址：后台的扫描缓存是按「标签页 + 地址」存的，
       同一个地址再扫会直接命中缓存（那是它该做的事），于是我们看不到真实的空页面。 */
    await page.goto(site.origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(IMG_DELAY + 1500);
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach((im) => im.remove());
    });
    const emptyCount = await page.evaluate(() => document.images.length);
    check(emptyCount === 0, '目标页上的 <img> 已全部移除', emptyCount);

    const p3 = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (id) => { await openGallery(id); }, tabId);
    const gallery3 = await p3;
    await gallery3.waitForLoadState('domcontentloaded');
    const emptyState = await until(() => snapshot(gallery3), (s) => s.emptyShown, 15000);
    console.log('  空态文案 =', JSON.stringify(emptyState.emptyText));
    check(emptyState.emptyShown === true, '如实显示了空态');
    check(emptyState.saysNoImages === true,
      '空态说的就是「没有发现图片」—— 真的没有图时不该变成错误提示',
      emptyState.emptyText);

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
