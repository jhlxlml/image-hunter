/* ImageHunter — 真实浏览器：大图预览的缩略图条只渲染「当前项附近的窗口」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是 AUDIT P2-4：
 *   renderStrip() 对整份列表 list.forEach(...) 每一项都建一个 <img>。
 *   从 2000 张的图库打开预览，会一次性插入 2000 个图片元素 ——
 *   loading="lazy" 只省网络请求，DOM 节点是实打实的。
 *
 * 修法：只渲染当前项左右各 STRIP_WINDOW(40) 个，共最多 81 个；
 *       当前项还在已渲染窗口内时连重建都省掉（否则每按一次方向键都要重建 81 个节点）；
 *       窗口化之后 DOM 下标 ≠ 列表下标，所以定位/高亮一律改用 data-i。
 *
 * 覆盖：
 *   - 打开第 1 张：窗口 0..40（41 个），高亮项 data-i === 0
 *   - 打开中间第 151 张：窗口 110..190（81 个），高亮项 data-i === 150
 *   - 打开最后一张：窗口 259..299（41 个），高亮项 data-i === 299
 *   - 一路按 → 走 60 步：缩略图数量始终 ≤ 81，高亮项始终跟着当前索引走
 *   - 走到窗口边缘之外时会重新开窗（高亮项始终存在于 DOM 里）
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
const PROFILE = path.join(os.tmpdir(), 'ih-lightbox-window-profile-' + Date.now());

const COLS = 20, ROWS = 15;
const TOTAL = COLS * ROWS;          // 300 张，远大于窗口 81
const WINDOW = 40;                  // 与 lightbox.js 的 STRIP_WINDOW 对齐
const MAX_THUMBS = WINDOW * 2 + 1;  // 81

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里读出缩略图条的状态（lightbox 在 shadow DOM 里，open 模式可直接访问） */
function stripProbe() {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    const sr = h.shadowRoot;
    if (!sr) continue;
    const strip = sr.querySelector('.ih-lb-strip');
    if (!strip) continue;
    const thumbs = Array.from(strip.querySelectorAll('.ih-lb-thumb'));
    const active = strip.querySelector('.ih-lb-thumb.ih-active');
    const meta = sr.querySelector('.ih-lb-meta');
    return {
      count: thumbs.length,
      imgCount: strip.querySelectorAll('img').length,
      indices: thumbs.map((t) => Number(t.getAttribute('data-i'))),
      activeIndex: active ? Number(active.getAttribute('data-i')) : null,
      meta: meta ? meta.textContent : ''
    };
  }
  return null;
}

/** 缩略图条的几何 / 滚动状态。滚轮测试要靠它拿到条在屏幕上的真实位置 */
function stripGeom() {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    const sr = h.shadowRoot;
    if (!sr) continue;
    const strip = sr.querySelector('.ih-lb-strip');
    if (!strip) continue;
    const r = strip.getBoundingClientRect();
    const zoom = sr.querySelector('.ih-lb-zoom-val');
    return {
      scrollLeft: strip.scrollLeft,
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      zoom: zoom ? zoom.textContent : ''
    };
  }
  return null;
}

/** 大图舞台（图片区域）的中心点与当前缩放值 */
function stageGeom() {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    const sr = h.shadowRoot;
    if (!sr) continue;
    const st = sr.querySelector('.ih-lb-stage');
    if (!st) continue;
    const r = st.getBoundingClientRect();
    const zoom = sr.querySelector('.ih-lb-zoom-val');
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, zoom: zoom ? zoom.textContent : '' };
  }
  return null;
}

/** 让后台把大图预览发给页面的内容脚本 */
async function openLightbox(sw, port, index) {
  return sw.evaluate(async ({ p, idx, total }) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
    if (!t) return { ok: false, error: '找不到标签页' };
    const origin = new URL(t.url).origin;
    const list = [];
    for (let i = 0; i < total; i++) {
      list.push({ url: origin + '/img/' + i + '.png', width: 64, height: 64, type: 'png' });
    }
    try {
      const r = await chrome.tabs.sendMessage(t.id,
        { type: 'IH_OPEN_LIGHTBOX', payload: { list, index: idx } }, { frameId: 0 });
      return r || { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, { p: port, idx: index, total: TOTAL });
}

/** 等缩略图条出现并稳定 */
async function waitStrip(page, budgetMs) {
  let waited = 0;
  while (waited < budgetMs) {
    const s = await page.evaluate(stripProbe);
    if (s && s.count > 0) return s;
    await sleep(200);
    waited += 200;
  }
  return page.evaluate(stripProbe);
}

const rangeOk = (indices, from, to) =>
  indices.length === (to - from + 1) && indices[0] === from && indices[indices.length - 1] === to;

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 64, imgH: 64 });
  console.log('测试页地址 =', site.url, '（' + TOTAL + ' 张，窗口上限 ' + MAX_THUMBS + '）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await page.bringToFront();
    await sleep(2000);

    /* ---------- 1. 打开第 1 张 ---------- */
    console.log('\n=== 1. 打开第 1 张：窗口应贴在开头 ===');
    const r0 = await openLightbox(sw, site.port, 0);
    check(r0 && r0.ok, '内容脚本接受了打开预览的请求', JSON.stringify(r0));

    const s0 = await waitStrip(page, 15000);
    console.log('缩略图 ' + s0.count + ' 个，区间 ' + s0.indices[0] + '..'
      + s0.indices[s0.indices.length - 1] + '，高亮 data-i=' + s0.activeIndex);
    check(s0.count === WINDOW + 1, '只渲染 ' + (WINDOW + 1) + ' 个缩略图（不是 ' + TOTAL + ' 个）',
      s0.count + ' 个');
    check(rangeOk(s0.indices, 0, WINDOW), '窗口区间为 0..' + WINDOW, JSON.stringify(s0.indices.slice(0, 3)));
    check(s0.activeIndex === 0, '高亮的是 data-i=0', String(s0.activeIndex));
    check(/^1 \/ /.test(s0.meta.trim()) || s0.meta.indexOf('1 / ' + TOTAL) >= 0,
      '顶部信息显示 1 / ' + TOTAL, s0.meta);
    check(s0.imgCount === s0.count, '缩略图 <img> 数量与节点数一致', s0.imgCount + ' / ' + s0.count);

    /* ---------- 2. 打开中间第 151 张 ---------- */
    console.log('\n=== 2. 打开中间第 151 张：窗口应以它为中心 ===');
    await openLightbox(sw, site.port, 150);
    await sleep(800);
    const s1 = await page.evaluate(stripProbe);
    console.log('缩略图 ' + s1.count + ' 个，区间 ' + s1.indices[0] + '..'
      + s1.indices[s1.indices.length - 1] + '，高亮 data-i=' + s1.activeIndex);
    check(s1.count === MAX_THUMBS, '窗口两侧都撑满，共 ' + MAX_THUMBS + ' 个', s1.count + ' 个');
    check(rangeOk(s1.indices, 150 - WINDOW, 150 + WINDOW),
      '窗口区间为 ' + (150 - WINDOW) + '..' + (150 + WINDOW), s1.indices[0] + '..' + s1.indices[s1.indices.length - 1]);
    check(s1.activeIndex === 150, '高亮的是 data-i=150', String(s1.activeIndex));
    check(s1.indices.indexOf(150) === WINDOW, '高亮项正好在窗口正中', String(s1.indices.indexOf(150)));

    /* ---------- 3. 打开最后一张 ---------- */
    console.log('\n=== 3. 打开最后一张：窗口应贴在末尾 ===');
    await openLightbox(sw, site.port, TOTAL - 1);
    await sleep(800);
    const s2 = await page.evaluate(stripProbe);
    console.log('缩略图 ' + s2.count + ' 个，区间 ' + s2.indices[0] + '..'
      + s2.indices[s2.indices.length - 1] + '，高亮 data-i=' + s2.activeIndex);
    check(s2.count === WINDOW + 1, '末尾只渲染 ' + (WINDOW + 1) + ' 个', s2.count + ' 个');
    check(rangeOk(s2.indices, TOTAL - 1 - WINDOW, TOTAL - 1),
      '窗口区间为 ' + (TOTAL - 1 - WINDOW) + '..' + (TOTAL - 1),
      s2.indices[0] + '..' + s2.indices[s2.indices.length - 1]);
    check(s2.activeIndex === TOTAL - 1, '高亮的是最后一张 data-i=' + (TOTAL - 1), String(s2.activeIndex));

    /* ---------- 4. 一路按 → 走 60 步：节点数不涨，高亮不丢 ---------- */
    console.log('\n=== 4. 连续按 → 走 60 步 ===');
    await openLightbox(sw, site.port, 100);
    await sleep(800);

    let maxCount = 0;
    let lost = 0;
    let stuck = 0;
    let last = null;

    for (let step = 0; step < 60; step++) {
      await page.keyboard.press('ArrowRight');
      await sleep(60);
      const s = await page.evaluate(stripProbe);
      if (!s) { lost++; continue; }
      maxCount = Math.max(maxCount, s.count);
      if (s.activeIndex == null) lost++;                 // 高亮项必须始终在 DOM 里
      if (s.activeIndex !== 100 + step + 1) stuck++;     // 高亮项必须等于当前索引
      last = s;
    }
    console.log('60 步后：缩略图 ' + last.count + ' 个，区间 ' + last.indices[0] + '..'
      + last.indices[last.indices.length - 1] + '，高亮 data-i=' + last.activeIndex
      + '，峰值 ' + maxCount);

    check(maxCount <= MAX_THUMBS, '全程缩略图数量从未超过 ' + MAX_THUMBS, '峰值 ' + maxCount);
    check(lost === 0, '每一步高亮项都在 DOM 里（窗口跟随正确）', lost + ' 步丢失');
    check(stuck === 0, '每一步高亮项都等于当前索引（data-i 对齐正确）', stuck + ' 步不对');
    check(last.activeIndex === 160, '走完 60 步后当前索引为 160', String(last.activeIndex));
    // 窗口不是每一步都重建 —— 只在索引走出已渲染区间时才重开。
    // 从 100 出发、窗口 [60,140]，走到 141 越界 → 重开为 [101,181]，
    // 之后 142..160 都落在这个区间里，一次都不用再建。
    check(rangeOk(last.indices, 101, 181),
      '窗口区间为 101..181（只在越界时重开一次，不是每步重建）',
      last.indices[0] + '..' + last.indices[last.indices.length - 1]);
    check(last.indices.indexOf(160) >= 0 && last.count === MAX_THUMBS,
      '重开后的窗口仍然包含当前项，且数量仍在上限内',
      last.count + ' 个, 位置 ' + last.indices.indexOf(160));

    /* ---------- 5. 反向：一路按 ← 回到开头 ---------- */
    console.log('\n=== 5. 反向走回开头 ===');
    let backLost = 0;
    for (let step = 0; step < 60; step++) {
      await page.keyboard.press('ArrowLeft');
      await sleep(60);
      const s = await page.evaluate(stripProbe);
      if (!s || s.activeIndex !== 160 - step - 1) backLost++;
    }
    const sBack = await page.evaluate(stripProbe);
    console.log('回到 data-i=' + sBack.activeIndex + '，缩略图 ' + sBack.count + ' 个');
    check(backLost === 0, '反向走也始终跟随正确', backLost + ' 步不对');
    check(sBack.activeIndex === 100, '回到 data-i=100', String(sBack.activeIndex));

    /* --------------------------------------------------------------- *
     * 6. 缩略图条自己要能横向滚
     *
     * onWheel 现在**无条件**拦住滚轮（灯箱是页内模态，不能让页面跟着滚），
     * 但缩略图条本身是需要横向滚动的 —— 一刀切会把它一起吃掉。
     * 所以 onWheel 开头有一条「落在条上就放行」。
     *
     * 这条只有真浏览器能测：jsdom 没有布局，scrollLeft 永远是 0。
     * --------------------------------------------------------------- */
    console.log('\n=== 6. 缩略图条仍能横向滚（滚轮没被一刀切成缩放）===');
    await openLightbox(sw, site.port, 0);
    await sleep(900);

    const g0 = await page.evaluate(stripGeom);
    console.log('条：scrollWidth=' + g0.scrollWidth + ' clientWidth=' + g0.clientWidth
      + ' 中心=(' + Math.round(g0.x) + ',' + Math.round(g0.y) + ') zoom=' + g0.zoom);
    // 先确认这条真的能滚 —— 不能滚的话下面的断言恒真
    check(g0.scrollWidth > g0.clientWidth + 100,
      '缩略图条确实横向溢出（否则这一节等于什么都没测）',
      g0.scrollWidth + ' vs ' + g0.clientWidth);
    check(g0.scrollLeft === 0, '初始 scrollLeft 为 0', String(g0.scrollLeft));

    await page.mouse.move(g0.x, g0.y);
    await page.mouse.wheel(0, 300);
    await sleep(600);
    const g1 = await page.evaluate(stripGeom);
    check(g1.scrollLeft > g0.scrollLeft,
      '在条上滚滚轮 → 条自己横向滚了（没被 onWheel 拦成缩放）',
      g0.scrollLeft + ' → ' + g1.scrollLeft);
    check(g1.zoom === g0.zoom, '同时没有被误当成缩放', g0.zoom + ' → ' + g1.zoom);

    /* 对照：滚轮落在大图上必须被灯箱吃掉（缩放），而不是穿透到页面 */
    const st0 = await page.evaluate(stageGeom);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(st0.x, st0.y);
    await page.mouse.wheel(0, -600);
    await sleep(400);
    const st1 = await page.evaluate(stageGeom);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    check(st1.zoom !== st0.zoom, '在大图上滚滚轮 → 确实缩放了', st0.zoom + ' → ' + st1.zoom);
    check(scrollAfter === scrollBefore, '页面没有被一起滚走',
      scrollBefore + ' → ' + scrollAfter);

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
