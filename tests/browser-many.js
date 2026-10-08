/* ImageHunter — 真实浏览器：大量图片时「全部显示」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 背景：早期版本是分页的——一次只渲染 120 张，剩下的要点「显示更多」。
 * 用户反馈：「图片显示区域显示更多有什么作用，图片要能够全部显示」。
 * 现在改成：首屏先出 CHUNK 张，剩下的用 requestAnimationFrame **自动补全**，
 * 用户不用点任何按钮，滚到底就是全部图片。
 *
 * 这个用例用 1200 张图的本地站守住四件事：
 *   1. 界面上**不存在**「显示更多」按钮
 *   2. 不做任何操作，卡片数最终会等于图片数（自动补全）
 *   3. 1200 张卡片下框选拖拽仍不掉帧（每帧 < 16ms 预算内）
 *   4. ★「先出图、后升级」不能把已经铺出来的规模缩回头 —— 见第 5 节。
 *      升级要整体重建网格（每张卡片的地址都变了），但曾经它顺手把 renderedCount
 *      也清零了，于是 1200 张的站点上网格永远在「铺到几百张 → 升级 → 缩回 120 张」
 *      之间循环，**根本补不到全量**。而当时这套用例用 .catch(() => {}) 吞掉了
 *      waitForFunction 的超时，把「永远补不完」报成了「341ms 就补完了」。
 */
'use strict';

const { chromium } = require('playwright-core');
const { startServer } = require('./lib/localsite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.IH_BROWSER
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'ih-many-profile-' + Date.now());
const SITE_OPTS = { cols: 40, rows: 30, imgW: 600, imgH: 400 };   // 1200 张

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  console.log('本地图片站 =', localSite.url, '共', localSite.total, '张');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1440, height: 940 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });

  const target = await ctx.newPage();
  await target.goto(localSite.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  await target.bringToFront();
  await sleep(500);

  const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await sw.evaluate(async () => { await openGallery(await pickTargetTab(null)); });
  const gallery = await galleryPromise;
  await gallery.waitForLoadState('domcontentloaded');

  await gallery.waitForFunction(
    () => Number(document.getElementById('statTotal').textContent) > 0,
    { timeout: 60000 });
  const total = await gallery.evaluate(() => Number(document.getElementById('statTotal').textContent));
  check(total === localSite.total, '嗅探到全部 ' + localSite.total + ' 张', String(total));

  /* ---------------- 1. 界面上不该再有「显示更多」 ---------------- */
  console.log('\n=== 1. 没有「显示更多」按钮 ===');
  const leftovers = await gallery.evaluate(() => ({
    moreBox: !!document.getElementById('more'),
    moreBtn: !!document.getElementById('btnMore'),
    moreText: document.body.innerText.indexOf('显示更多') >= 0
  }));
  check(!leftovers.moreBox && !leftovers.moreBtn && !leftovers.moreText,
    '页面里没有「显示更多」相关元素', JSON.stringify(leftovers));

  /* ---------------- 2. 不点任何按钮，卡片自己补全 ---------------- */
  console.log('\n=== 2. 不操作，等它自己全部显示 ===');
  const firstFrame = await gallery.evaluate(() =>
    document.querySelectorAll('#grid .card').length);
  console.log('  首帧卡片数:', firstFrame);

  const t0 = Date.now();
  /* 这里的超时必须**如实失败**，不能 .catch(() => {}) 吞掉 ——
     旧版就是这么写的，于是「补全耗时」在超时的那次跑里算出来是个无意义的
     小数字（30 秒超时之后立刻 elapsed），把「卡片永远补不到 1200 张」
     这个真 bug 伪装成了「很快就补完了」。
     waitForFunction 自己会在超时抛出，直接让它抛。 */
  await gallery.waitForFunction((want) =>
    document.querySelectorAll('#grid .card').length >= want, localSite.total, { timeout: 30000 });
  const elapsed = Date.now() - t0;

  const now = await gallery.evaluate(() => document.querySelectorAll('#grid .card').length);
  check(now === localSite.total,
    '卡片数自动补到 ' + localSite.total + ' 张（没有点任何按钮）', String(now));
  check(elapsed < 15000, '补全在 15 秒内完成', elapsed + 'ms');
  console.log('  补全耗时:', elapsed + 'ms');

  const noButtonClicks = await gallery.evaluate(() => {
    // 兜底：确认 DOM 里连一个「加载更多」类的按钮都没有
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.filter((b) => /更多|加载|more/i.test(b.textContent)).length;
  });
  check(noButtonClicks === 0, '没有任何「加载更多」类按钮', String(noButtonClicks));

  /* ---------------- 3. 卡片 id 与扫描结果一一对应 ---------------- */
  console.log('\n=== 3. 渲染完整性 ===');
  const integrity = await gallery.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('#grid .card')).map((c) => c.dataset.id);
    return { count: ids.length, unique: new Set(ids).size };
  });
  check(integrity.count === localSite.total && integrity.unique === localSite.total,
    '卡片 id 数量与唯一性都正确', JSON.stringify(integrity));

  /* ---------------- 4. 大量卡片下框选仍然流畅 ---------------- */
  console.log('\n=== 4. 1200 张卡片下的框选帧耗时 ===');
  const perf = await gallery.evaluate(async () => {
    const cards = document.querySelectorAll('#grid .card');
    const a = cards[0].getBoundingClientRect();
    const wrap = document.getElementById('gridWrap');
    const frames = [];
    wrap.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: a.left + 5, clientY: a.top + 5, button: 0, isPrimary: true
    }));
    for (let i = 1; i <= 30; i++) {
      const t = performance.now();
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: a.left + 5 + i * 12, clientY: a.top + 5 + i * 8
      }));
      frames.push(performance.now() - t);
      await new Promise((r) => requestAnimationFrame(r));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    frames.sort((x, y) => x - y);
    return {
      median: Math.round(frames[Math.floor(frames.length / 2)] * 10) / 10,
      p90: Math.round(frames[Math.floor(frames.length * 0.9)] * 10) / 10
    };
  });
  console.log('  每帧耗时 中位数/90分位:', perf.median + 'ms /' + perf.p90 + 'ms');
  check(perf.median < 16, '框选每帧中位数在 16ms 预算内', perf.median + 'ms');
  check(perf.p90 < 33, '框选 90 分位不超两帧预算', perf.p90 + 'ms');

  /* ---------------- 5. 「先出图、后升级」不得把已铺出来的规模缩回头 ---------------- */
  console.log('\n=== 5. 升级重建后卡片数不缩水 ===');
  const beforeUpgrade = await gallery.evaluate(() => document.querySelectorAll('#grid .card').length);
  check(beforeUpgrade === localSite.total, '升级前已经是全量', String(beforeUpgrade));

  /* 直接让后台再广播一次 SCAN_UPGRADE（拿当前结果原样当作「升级后的最终结果」）。
     这走的是和图库里那条监听完全相同的路径 → applyScanUpgrade → applyFilters
     → renderGrid('keepScale')。旧行为下这里会掉回首屏 CHUNK 张。 */
  await sw.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + port + '/') >= 0);
    if (!t) return;
    const res = await chrome.tabs.sendMessage(t.id, { type: 'IH_SCAN_TAB' }, { frameId: 0 })
      .catch(() => null);
    // 用刚扫出来的结果原样广播一次升级
    const imgs = res && res.images;
    if (imgs && imgs.length) {
      chrome.runtime.sendMessage({ type: 'IH_SCAN_UPGRADE', payload: { images: imgs, tabId: t.id } });
    }
  }, localSite.port);

  const afterUpgrade = await gallery.evaluate(() => document.querySelectorAll('#grid .card').length);
  check(afterUpgrade === localSite.total,
    '升级重建后卡片数没有缩回首屏（' + localSite.total + ' 张仍在）', String(afterUpgrade));

  // 升级重建会作废框选几何快照，重建后必须能正常框选（不能因为快照过期就框不到）
  const afterSel = await gallery.evaluate(async () => {
    const cards = document.querySelectorAll('#grid .card');
    const a = cards[0].getBoundingClientRect();
    const wrap = document.getElementById('gridWrap');
    wrap.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: a.left + 5, clientY: a.top + 5, button: 0, isPrimary: true
    }));
    for (let i = 1; i <= 12; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: a.left + 5 + i * 14, clientY: a.top + 5 + i * 10
      }));
      await new Promise((r) => requestAnimationFrame(r));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return document.querySelectorAll('#grid .card.selected').length;
  });
  check(afterSel > 0, '重建后框选仍然有效（几何快照已正确失效重取）', afterSel + ' 张');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await ctx.close();
  await localSite.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
