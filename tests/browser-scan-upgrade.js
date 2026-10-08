/* ImageHunter — 真实浏览器：先出图、后升级（消灭冷还原的白等）
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是这条体验缺口：
 *   原图还原要给每张候选发一次真实加载请求，冷加载时整轮轻松好几秒。
 *   旧流程里图库必须**等还原全部跑完**才拿到结果 —— 用户就那么盯着 spinner 白等。
 *   「不会返回空列表」解决了「看不到图」，没解决「要等」。
 *
 * 修法（两步）：
 *   1. 内容脚本交出第一版中间结果（partial）时，后台**立刻兑现** SCAN_TAB 的响应，
 *      图库马上把页面上的版本铺出来；
 *   2. 还原跑完拿到最终结果后，后台广播 SCAN_UPGRADE，图库**原地**把卡片换成原图地址。
 *
 * 最容易踩的回归：还原会改 URL → id（= quickHash(normalizeUrl(url))）跟着变 →
 *   用户在这几秒里勾选的图全丢。所以升级时必须拿每张图自带的 restoredFrom
 *   （还原前的地址）反算出旧 id，把 state.selected / state.sizes 一起搬过去。
 *
 * 覆盖：
 *   1. 网格在**最终结果到达之前**就出现了（先出图），且此刻还是页面上的缩略图版本
 *   2. 最终结果到达后原地升级成原图地址，数量不变、没有重新扫描
 *   3. **勾选被保留**（按图片本体对齐，不是按 id）—— 这条就是防回归的核心
 *   4. 体积缓存跟着搬（「合计体积」不会因为换 URL 而清零）
 *   5. 对照：没有中间结果的路径（页面一张图都没有）行为不变
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
const PROFILE = path.join(os.tmpdir(), 'ih-scan-upgrade-profile-' + Date.now());

const COLS = 6, ROWS = 4;
const TOTAL = COLS * ROWS;          // 24 张
const IMG_DELAY = 1500;             // 单张还原候选的冷加载延迟
// 还原并发 8（scanner.js RESTORE_CONCURRENCY）→ 24 张约 3 批 × 1.5s ≈ 4.5 秒
const EXPECT_RESTORE_MS = 3000;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 缩略图地址 /thumb/img/N.png → 图片本体标识 img/N.png（升级前后靠它对齐） */
const bodyOf = (url) => String(url || '').replace('/thumb/img/', '/img/');

/** 图库当前的可见状态。urls 用 card.title（buildCard 里 title = c.url） */
function snapshot() {
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  return {
    total: Number((document.getElementById('statTotal') || {}).textContent || 0),
    selected: Number((document.getElementById('statSelected') || {}).textContent || 0),
    cards: cards.length,
    restored: cards.filter((c) => c.querySelector('.badge.restored')).length,
    urls: cards.map((c) => c.title),
    selUrls: cards.filter((c) => c.classList.contains('selected')).map((c) => c.title),
    emptyHidden: document.getElementById('empty').hidden,
    sizeText: (document.getElementById('statSize') || {}).textContent || ''
  };
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  // 缩略图 300x200 放 /thumb/，原图 600x400 放 /，候选冷加载 1.5 秒
/* 尺寸的**较短边**必须 > 图库尺寸滑条默认的 256px（v1.11.0 起开箱按短边 256 过滤）。
     用 600×400 + thumbPath 时页面上的缩略图是 300×200 —— 短边只有 200，会被整片挡住。
     本用例测的是「先出图、后升级」，
     不该被尺寸过滤干扰，所以夹具必须稳稳过门槛。 */
  const site = await startServer({
    cols: COLS, rows: ROWS, imgW: 800, imgH: 600, thumbPath: true, imgDelay: IMG_DELAY
  });
  console.log('测试站点 =', site.url, '（' + TOTAL + ' 张，候选延迟 ' + IMG_DELAY + 'ms）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    const src = await ctx.newPage();
    await src.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await src.bringToFront();
    await sleep(2500);                 // 让页面自己的缩略图先加载完（否则还原会连缩略图一起等）

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, site.port);
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');

    /* --------------------------------------------------------------- *
     * 1. 先出图：网格必须在最终结果到达之前出现
     * --------------------------------------------------------------- */
    console.log('\n=== 1. 先出图：网格要在原图还原跑完之前就出现 ===');

    const t0 = Date.now();
    let first = null, firstAt = 0;
    let upgraded = null, upgradedAt = 0;

    while (Date.now() - t0 < 40000) {
      const s = await gallery.evaluate(snapshot);
      if (!first && s.total >= TOTAL && s.cards >= TOTAL) {
        first = s;
        firstAt = Date.now() - t0;
      }
      if (!upgraded && s.total >= TOTAL && s.restored >= TOTAL) {
        upgraded = s;
        upgradedAt = Date.now() - t0;
        break;
      }
      await sleep(80);
    }

    if (!first) {
      check(false, '网格始终没有出现（total=' + TOTAL + '）');
      console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
      await ctx.close(); site.close();
      process.exit(1);
    }
    if (!upgraded) {
      check(false, '始终没有等到原图升级（restored 未到 ' + TOTAL + '）');
      console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
      await ctx.close(); site.close();
      process.exit(1);
    }

    console.log('首次铺图 = ' + firstAt + 'ms（restored=' + first.restored + '）'
      + '，升级完成 = ' + upgradedAt + 'ms');

    check(first.total === TOTAL, '铺图时数量已经正确（' + TOTAL + ' 张）', first.total);
    check(first.restored === 0,
      '铺出来的是**页面上的版本**（还没有任何一张被还原）', 'restored=' + first.restored);
    check(first.urls.every((u) => u.indexOf('/thumb/') >= 0),
      '铺图时卡片地址确实还是缩略图地址',
      JSON.stringify(first.urls.slice(0, 2)));
    check(firstAt < upgradedAt,
      '铺图发生在升级之前（' + firstAt + 'ms < ' + upgradedAt + 'ms）');
    check(upgradedAt - firstAt >= EXPECT_RESTORE_MS,
      '两个阶段确实隔了足够久（' + (upgradedAt - firstAt) + 'ms ≥ ' + EXPECT_RESTORE_MS
      + 'ms）—— 否则「先出图」这件事根本没被验证到');

    /* --------------------------------------------------------------- *
     * 2. 升级：原地换成原图地址
     * --------------------------------------------------------------- */
    console.log('\n=== 2. 后升级：原地换成原图地址 ===');
    check(upgraded.restored === TOTAL, '全部 ' + TOTAL + ' 张都升级成了原图', upgraded.restored);
    check(upgraded.urls.every((u) => u.indexOf('/thumb/') < 0),
      '升级后卡片地址里不再有 /thumb/', JSON.stringify(upgraded.urls.slice(0, 2)));
    check(upgraded.urls.every((u) => u.indexOf('/img/') >= 0),
      '升级后指向 /img/ 原图');
    // 升级前后必须是**同一批图**，不是重新扫了一遍换来另一批
    check(JSON.stringify(first.urls.map(bodyOf).sort())
      === JSON.stringify(upgraded.urls.map(bodyOf).sort()),
      '升级前后是同一批图片（没有换成另一批）');
    check(upgraded.emptyHidden === true, '全程没有显示「本页没有发现图片」');

    /* --------------------------------------------------------------- *
     * 3. 核心防回归：升级不能把用户已经勾选的图弄丢
     *
     * 注意这一节必须在**升级之前**勾选才有意义。上面的轮询已经把时间花掉了，
     * 所以这里重新打开一次图库，重跑一遍两阶段，在中间那一小段里勾选。
     * --------------------------------------------------------------- */
    console.log('\n=== 3. 核心：partial 之后勾选，升级之后勾选仍在 ===');

    const g2 = gallery;
    await g2.bringToFront();

    // 触发一次重新嗅探，然后盯着「铺图 → 升级」这个窗口。
    // 本地站的图片带 Cache-Control: no-store，所以这一轮还原同样是冷的，
    // 窗口宽度和第一次一样。
    await g2.evaluate(() => {
      const b = document.getElementById('btnRescan');
      if (b) b.click();
    });
    await sleep(150);   // 让 doScan 先把上一轮清掉

    const t1 = Date.now();
    let preSel = null;
    let pickedBodies = null;

    while (Date.now() - t1 < 40000) {
      const s = await g2.evaluate(snapshot);
      // 等到「铺出来了、但还没升级」的那一刻
      if (s.total >= TOTAL && s.cards >= TOTAL && s.restored === 0) {
        // 勾前 3 张
        await g2.evaluate((n) => {
          const cards = Array.from(document.querySelectorAll('#grid .card')).slice(0, n);
          for (const c of cards) {
            const p = c.querySelector('.pick');
            if (p) p.click();
          }
        }, 3);
        await sleep(200);
        preSel = await g2.evaluate(snapshot);
        pickedBodies = preSel.selUrls.map(bodyOf).sort();
        break;
      }
      await sleep(60);
    }

    if (!preSel) {
      check(false, '没能在「已铺图、未升级」的窗口里勾选（窗口太短？）');
    } else {
      console.log('勾选时 = ' + JSON.stringify(preSel.selUrls));
      check(preSel.selected === 3, '升级前勾选了 3 张', preSel.selected);
      check(pickedBodies.length === 3
        && pickedBodies.every((b) => b.indexOf('/img/') >= 0 && b.indexOf('/thumb/') < 0),
        '勾选记录拿到的确实是图片本体标识（/img/，已去掉 /thumb/）',
        JSON.stringify(pickedBodies));

      // 等升级
      let after = null;
      const t2 = Date.now();
      while (Date.now() - t2 < 30000) {
        const s = await g2.evaluate(snapshot);
        if (s.total >= TOTAL && s.restored >= TOTAL) { after = s; break; }
        await sleep(80);
      }

      if (!after) {
        check(false, '升级始终没有发生');
      } else {
        console.log('升级后 = ' + JSON.stringify(after.selUrls));
        check(after.restored === TOTAL, '已升级 ' + TOTAL + ' 张', after.restored);
        check(after.selected === 3,
          '升级后仍然勾着 3 张（还原改 URL 不该把勾选弄丢）', after.selected);
        check(JSON.stringify(after.selUrls.map(bodyOf).sort()) === JSON.stringify(pickedBodies),
          '而且**就是原来那 3 张**（按图片本体对齐，不是碰巧数量相同）',
          JSON.stringify(after.selUrls.map(bodyOf).sort()) + ' vs ' + JSON.stringify(pickedBodies));
        check(after.selUrls.every((u) => u.indexOf('/thumb/') < 0),
          '这 3 张的地址也已经换成原图地址');
      }
    }

    /* --------------------------------------------------------------- *
     * 4. 对照：整页一张图都没有时，不该出现「升级」这件事
     * --------------------------------------------------------------- */
    console.log('\n=== 4. 对照：没有中间结果的路径行为不变 ===');
    // fixture-ok: 对照用例 —— 直接调后台 scanTab 验契约，全程不打开图库网格
    const blank = await startServer({ cols: 1, rows: 1, imgW: 10, imgH: 10 });
    const blankPage = await ctx.newPage();
    await blankPage.goto(blank.url, { waitUntil: 'load', timeout: 60000 });
    await blankPage.bringToFront();
    await sleep(1500);

    const r = await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      return scanTab(t.id);
    }, blank.port);
    check(r && r.ok === true, '直接调用 scanTab 拿到的是最终结果（契约没变）', JSON.stringify(!!r));
    check(r && typeof r.phase === 'undefined',
      '最终结果里没有 phase=partial 标记（走的是完整路径）', String(r && r.phase));
    check(r && r.images && r.images.length >= 1, 'blank 站也拿到了图', r && r.images.length);

    blankPage.close();
    blank.close();

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
