/* ImageHunter — 真实浏览器：体积探测的「推进」语义
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是 AUDIT P1-5：
 *
 *   const targets = state.filtered
 *     .filter((c) => state.sizes[c.url] === undefined || state.sizes[c.url] === null)
 *     .slice(0, 120);
 *
 * 失败项被记成 null，而 null 仍然满足「待探测」的过滤条件 ——
 * 于是前 120 张只要**全部失败**，再点多少次「探测体积」，选中的永远是同一批 120 张，
 * 第 121 张之后一辈子轮不到。120（弹窗上限）× 120（后台上限）两个各自合理的数字，
 * 叠起来成了死循环。
 *
 * 修法：弹窗按 PROBE_LIMIT 分批**循环到底**（一次点击覆盖全部待探测项），
 * 失败项记进 probeFailed 不再算「待探测」；等全部探过一轮后，
 * 再点一次才进入「重试失败项」模式。推进与重试互不阻塞。
 *
 * 这条用例怎么拿到地面真相：
 *   本地站点把「探测请求」（HEAD / 带 Range 的 GET）逐条记进 probeLog，
 *   并可以配置成一律返回 500。页面自身的 <img> 是普通 GET，不受影响，
 *   所以图片照常加载、照常被嗅探，只有体积拿不到。
 *   于是「后台到底请求了哪几张、分了几批」完全可观测 ——
 *   只靠界面文案是分不清「换了一批新的」还是「又把同一批重试了一遍」的。
 *
 * 覆盖：
 *   阶段 A（探测全部失败，130 张 > 上限 120）
 *     - 一次点击就推进到**全部** 130 张，不再被 120 卡住
 *     - 确实是分两批发的（前 120 张的请求全部先于第 121 张）
 *     - 全部失败时如实报失败，不谎报「已获取」
 *     - 再点一次进入「重试」模式：130 张再走一遍
 *     - 反复点击按钮始终能恢复，不会卡在「探测中」
 *   阶段 B（探测正常，130 张）
 *     - 多批次成功路径没被改坏：一次点击拿回全部 130 张的真实体积
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
const PROFILE = path.join(os.tmpdir(), 'ih-probe-advance-profile-' + Date.now());

// 130 张 > PROBE_LIMIT(120)，才能看出「有没有推进到第 121 张」
const COLS = 13, ROWS = 10;
const TOTAL = COLS * ROWS;
const LIMIT = 120;   // 与 C.PROBE_LIMIT 对齐

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等按钮退出「探测中」；返回是否等到了 */
async function waitIdle(page, budgetMs) {
  let waited = 0;
  while (waited < budgetMs) {
    const t = await page.evaluate(() => ({
      disabled: document.getElementById('btnProbe').disabled,
      busy: document.getElementById('btnProbe').classList.contains('busy')
    }));
    if (!t.disabled && !t.busy) return true;
    await sleep(100);
    waited += 100;
  }
  return false;
}

const toastText = (page) => page.evaluate(() => document.getElementById('toast').textContent);

/** 等图库渲染出至少 n 张卡片 */
async function waitCards(page, n, budgetMs) {
  let waited = 0;
  while (waited < budgetMs) {
    const c = await page.evaluate(() => document.querySelectorAll('#grid .card').length);
    if (c >= n) return c;
    await sleep(300);
    waited += 300;
  }
  return page.evaluate(() => document.querySelectorAll('#grid .card').length);
}

/** 让图库把某个标签页设为嗅探目标（按端口号精确匹配，不依赖「当前活动标签页」） */
async function targetTab(sw, port) {
  return sw.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
    if (!t) return null;
    await openGallery(t.id);
    return t.id;
  }, port);
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

/* 尺寸的**较短边**必须 > 图库尺寸滑条默认的 256px（v1.11.0 起开箱按短边 256 过滤）。
     用 600×400 + thumbPath 时页面上的缩略图是 300×200 —— 短边只有 200，会被整片挡住。
     本用例测的是「探测推进 / 分批上限」，
     不该被尺寸过滤干扰，所以夹具必须稳稳过门槛。 */
  const siteA = await startServer({ cols: COLS, rows: ROWS, imgW: 480, imgH: 300, probeFail: true });
  console.log('阶段 A 站点 =', siteA.url, '（' + TOTAL + ' 张，探测请求一律 500）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  let siteB = null;

  try {
    /* ---------- 1. 打开测试页与图库 ---------- */
    console.log('\n=== 1. 打开测试页 → 打开图库独立页 ===');
    const page = await ctx.newPage();
    await page.goto(siteA.url, { waitUntil: 'load', timeout: 60000 });
    await page.bringToFront();
    await sleep(2500);

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async () => {
      const target = await pickTargetTab(null);
      await openGallery(target);
    });
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');
    await sleep(4000);

    const statTotal = await gallery.evaluate(() => document.getElementById('statTotal').textContent);
    check(Number(statTotal) >= TOTAL, '嗅探到 ' + TOTAL + ' 张图片', statTotal);
    const cards = await waitCards(gallery, TOTAL, 20000);
    console.log('网格卡片数 =', cards, '/ 上限 =', LIMIT);

    /* ---------- 2. 一次点击必须覆盖全部（含第 121 张之后） ---------- */
    console.log('\n=== 2. 点击「探测体积」：一次点击应推进到全部 ' + TOTAL + ' 张 ===');
    siteA.resetProbeLog();

    await gallery.evaluate(() => document.getElementById('btnProbe').click());
    const during = await gallery.evaluate(() => document.getElementById('btnProbe').disabled);
    check(during === true, '点击后按钮立刻进入禁用（探测中）', String(during));

    check(await waitIdle(gallery, 60000), '探测结束后按钮恢复可用');

    const hit = siteA.probedIndexes();
    const t1 = await toastText(gallery);
    console.log('命中 ' + hit.length + ' 张；提示 = ' + t1);

    // 核心断言：旧代码这里恒为 120，第 121 张之后永远探不到
    check(hit.length === TOTAL,
      '一次点击覆盖全部 ' + TOTAL + ' 张（不再被 120 卡死）', hit.length + ' 张');
    check(hit.length > 0 && hit[hit.length - 1] === TOTAL - 1,
      '第 ' + TOTAL + ' 张（上限之外的尾巴）确实被探到了', hit[hit.length - 1]);

    // 确实是分批发的：第 121 张的请求必须晚于前 120 张的全部请求
    const firstTail = siteA.probeLog.findIndex((r) => r.i >= LIMIT);
    const headOnly = firstTail > 0 && siteA.probeLog.slice(0, firstTail).every((r) => r.i < LIMIT);
    check(headOnly,
      '分 ' + Math.ceil(TOTAL / LIMIT) + ' 批发送：前 ' + LIMIT + ' 张的请求全部先于第 ' + (LIMIT + 1) + ' 张',
      'firstTail=' + firstTail + ', 共 ' + siteA.probeLog.length + ' 条');

    check(/未能获取体积|失败/.test(t1), '全部失败时如实报失败', t1);
    check(!/已获取/.test(t1), '没有把失败谎报成「已获取」', t1);

    const sizeShown = await gallery.evaluate(() => {
      const s = document.querySelector('#grid .card .size');
      return s ? s.textContent : '';
    });
    check(sizeShown !== '' && !/^\d/.test(sizeShown),
      '探测失败后卡片仍显示格式名而不是体积', sizeShown);

    /* ---------- 3. 再点一次：进入「重试失败项」模式 ---------- */
    console.log('\n=== 3. 再点一次：重试全部失败项 ===');
    siteA.resetProbeLog();
    await gallery.evaluate(() => document.getElementById('btnProbe').click());
    check(await waitIdle(gallery, 60000), '重试结束后按钮恢复可用');

    const retried = siteA.probedIndexes();
    const t2 = await toastText(gallery);
    console.log('重试命中 ' + retried.length + ' 张（共 ' + siteA.probeLog.length + ' 条请求）；提示 = ' + t2);
    // 看「去重覆盖」而不是原始请求数：旧代码重试时请求数也会涨，
    // 但覆盖的始终是那同一批 120 张
    check(retried.length === TOTAL,
      '重试覆盖全部 ' + TOTAL + ' 张失败项', retried.length + ' 张');
    check(retried.length > 0 && retried[retried.length - 1] === TOTAL - 1,
      '重试也包含上限之外的尾巴', retried[retried.length - 1]);
    check(/未能获取体积|失败/.test(t2), '重试后仍失败，提示照实说', t2);

    /* ---------- 4. 反复点击不会卡住 ---------- */
    console.log('\n=== 4. 反复点击不会卡住 ===');
    for (let k = 0; k < 3; k++) {
      await gallery.evaluate(() => document.getElementById('btnProbe').click());
      if (!await waitIdle(gallery, 60000)) break;
    }
    const alive = await gallery.evaluate(() => {
      const b = document.getElementById('btnProbe');
      return { disabled: b.disabled, busy: b.classList.contains('busy') };
    });
    check(!alive.disabled && !alive.busy, '连续点击后按钮依然可用（没有卡在探测中）',
      JSON.stringify(alive));

    /* ---------- 5. 阶段 B：多批次成功路径没被改坏 ---------- */
    console.log('\n=== 5. 阶段 B：探测正常时，一次点击拿回全部体积 ===');
    siteB = await startServer({ cols: COLS, rows: ROWS, imgW: 480, imgH: 300, probeFail: false });
    console.log('阶段 B 站点 =', siteB.url, '（' + TOTAL + ' 张，探测正常）');

    const pageB = await ctx.newPage();
    await pageB.goto(siteB.url, { waitUntil: 'load', timeout: 60000 });
    await pageB.bringToFront();
    await sleep(2000);

    const tid = await targetTab(sw, siteB.port);
    check(tid != null, '图库已切换嗅探目标到阶段 B 站点', String(tid));
    await sleep(1000);

    const cardsB = await waitCards(gallery, TOTAL, 25000);
    check(cardsB >= TOTAL, '阶段 B 渲染出 ' + TOTAL + ' 张卡片', cardsB + ' 张');

    await gallery.evaluate(() => document.getElementById('btnProbe').click());
    check(await waitIdle(gallery, 60000), '阶段 B 探测结束后按钮恢复可用');

    const t3 = await toastText(gallery);
    console.log('提示 = ' + t3);
    check(/已获取\s*(\d+)\s*张图片的体积/.test(t3), '提示为「已获取 N 张图片的体积」', t3);

    const sizes = await gallery.evaluate(() => {
      return Array.from(document.querySelectorAll('#grid .card')).map((c) => ({
        url: c.title,
        size: (c.querySelector('.size') || {}).textContent || ''
      }));
    });
    // 逐张跟服务器真实字节数比对：多批次路径下也不能串位
    const bad = [];
    let compared = 0;
    for (let i = 0; i < Math.min(sizes.length, TOTAL); i++) {
      const realBytes = siteB.png(i).length;
      const expected = await gallery.evaluate((b) => IH.U.formatBytes(b), realBytes);
      compared++;
      if (sizes[i].size !== expected) {
        bad.push({ i, got: sizes[i].size, expected, realBytes });
      }
    }
    check(compared === TOTAL, '逐张比对了全部 ' + TOTAL + ' 张', compared + ' 张');
    check(bad.length === 0, compared + ' 张卡片的体积与服务器真实字节数完全一致',
      bad.length ? JSON.stringify(bad.slice(0, 4)) : '');

    const gotAll = sizes.filter((s) => /^\d/.test(s.size)).length;
    check(gotAll === TOTAL, '第 121 张之后的卡片也拿到了体积', gotAll + ' / ' + TOTAL);

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    siteA.close();
    if (siteB) siteB.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
