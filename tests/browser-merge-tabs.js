/* ImageHunter — 真实浏览器：多标签页合并嗅探
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 需求原话：「多标签页合并嗅探提供开关设置」
 *
 * 这个功能的语义里有三件事必须钉住，否则用户会以为「丢了图」：
 *   1. **开关决定控件形态**：关（默认）是单选下拉，开是多选勾选列表。
 *      两个控件互斥显示 —— 不能让用户猜「到底听谁的」。
 *   2. **合并是按图片地址去重**：同一张图出现在两个页面时只留一张，
 *      卡片上标出来自哪个页面。不去重的话「勾了两页」会得到一堆重复。
 *   3. **改设置立即生效**：不用刷新图库（与排除列表那套一致）。
 *
 * 夹具刻意造出「同源两页、图片部分重叠」—— 只有同源，两个页面才可能出现
 * **完全相同的图片地址**，跨页去重这件事才测得出来：
 *
 *   站点 A（127.0.0.1）
 *     /    → 图片 0,1,2,3,4,5   （6 张）
 *     /b   → 图片 3,4,5,6,7     （5 张，其中 3/4/5 与 / 重叠）
 *     并集 = 8 张
 *   站点 B（localhost，**故意换个 host 名**）
 *     /    → 4 张，尺寸也不同 → 与 A 没有任何地址重叠
 *
 * 覆盖：
 *   1. 默认关：单选下拉在、多选列表不在
 *   2. 打开设置 → 控件当场切换（不用刷新），且勾选列表里只有一个默认选中
 *   3. 勾两页（同源、部分重叠）→ 8 张（不是 6+5=11），/img/3.png 只出现一次
 *   4. 卡片上带「来源页」角标，数量与卡片数一致；顶栏写「2 个页面」
 *   5. 跨站点合并（A + localhost）→ 6+4 = 10 张
 *   6. 取消勾选回到单页 → 6 张，来源页角标消失、顶栏回到域名
 *   7. 全部取消 → 空态说清「还没有勾选」，而不是「本页没有发现图片」
 *   8. 搜索能按来源页命中（合并时才生效）
 *   9. 导出的 JSON 带「来源页」字段，且记录数 = 合并结果数
 *  10. 「在图库中打开」切换扫描目标时**真的换过去**（合并模式收缩成一个；
 *      单选模式也不能被多选列表的残留勾选撤销）—— 回归测试，见该节注释
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
const PROFILE = path.join(os.tmpdir(), 'ih-merge-tabs-' + Date.now());

/* 站点 A：同源两页，图片部分重叠（并集 8 张） */
const A_FIRST = 6;      // 只看 / 时 6 张
const A_MERGED = 8;     // / + /b 并集 8 张
const B_TOTAL = 4;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  /* 夹具直接写成字面量：validate.js 的跨套件守卫是静态解析
     `startServer({...})` 字面量的，用变量包一层它就看不见了
     （那条守卫宁可不报也不误报，所以这里主动迁就它的写法）。 */
  const siteA = await startServer({
    cols: 3, rows: 2, imgW: 600, imgH: 400, title: '合并测试 A',
    pages: [
      { path: '/', imageIndexes: [0, 1, 2, 3, 4, 5], title: '合并测试 A1' },
      { path: '/b', imageIndexes: [3, 4, 5, 6, 7], title: '合并测试 A2' }
    ]
  });
  const siteB = await startServer({
    cols: 2, rows: 2, imgW: 800, imgH: 600, host: 'localhost', title: '合并测试 B'
  });
  console.log('站点 A =', siteA.origin, '（/ 6 张、/b 5 张，并集 8 张）');
  console.log('站点 B =', siteB.origin, '（4 张，host 不同）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1440, height: 940 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });

  /* 三个网页标签页，顺序固定：A/ → A/b → B/ */
  const tabA1 = await ctx.newPage();
  await tabA1.goto(siteA.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  const tabA2 = await ctx.newPage();
  await tabA2.goto(siteA.pathUrl('/b'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  const tabB = await ctx.newPage();
  await tabB.goto(siteB.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);

  // 以 A/ 作为主目标（合并模式下勾选才是决定性的，这里只是让初始态可预期）
  await tabA1.bringToFront();
  await sleep(600);

  const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await sw.evaluate(async () => { await openGallery(await pickTargetTab(null)); });
  const gallery = await galleryPromise;
  await gallery.waitForLoadState('domcontentloaded');
  await sleep(5000);

  /* ---------------- 小工具 ---------------- */

  const stat = () => gallery.evaluate(() => ({
    total: Number(document.getElementById('statTotal').textContent),
    filtered: Number(document.getElementById('statFiltered').textContent),
    host: document.getElementById('pageHost').textContent.trim(),
    cards: document.querySelectorAll('#grid .card').length,
    pageBadges: document.querySelectorAll('#grid .card .badge.page').length,
    selVisible: !document.getElementById('selTargetTab').hidden,
    multiVisible: !document.getElementById('targetMulti').hidden,
    checked: Array.from(document.querySelectorAll('#targetsList .tm-row input'))
      .filter((c) => c.checked).length,
    summary: (document.getElementById('targetsSummary') || {}).textContent || ''
  }));

  /** 某张图（按地址片段）在网格里出现了几次 —— 跨页去重的地面真相 */
  const countImg = (frag) => gallery.evaluate((f) => {
    return Array.from(document.querySelectorAll('#grid .card img'))
      .filter((im) => (im.getAttribute('src') || '').indexOf(f) >= 0).length;
  }, frag);

  /**
   * 按「host / 标题」勾选目标，直到实际勾选状态与期望一致。
   * 每改一个勾选都会重建列表 DOM，所以循环重查、直到收敛。
   */
  const setTargets = async (wanted) => {
    for (let round = 0; round < 6; round++) {
      const done = await gallery.evaluate((want) => {
        const rows = Array.from(document.querySelectorAll('#targetsList .tm-row'));
        for (const row of rows) {
          const host = (row.querySelector('.tm-host') || {}).textContent || '';
          const txt = (row.querySelector('.tm-txt') || {}).textContent || '';
          const should = want.some((w) => host === w || txt.indexOf(w) >= 0);
          const cb = row.querySelector('input');
          if (cb && cb.checked !== should) {
            cb.checked = should;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            return false;                 // 列表会被重建，重新查一遍
          }
        }
        return true;
      }, wanted);
      if (done) break;
      await sleep(200);
    }
    await sleep(4500);                    // 等 260ms 防抖 + 合并扫描跑完
  };

  const setMergeTabs = (on) => sw.evaluate(async (v) => {
    await IH.Store.updateSettings({ mergeTabs: v });
  }, on);

  const openPanel = () => gallery.evaluate(() => {
    const b = document.getElementById('btnTargets');
    if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
  });

  try {
    /* ============================================================== *
     * 1. 默认关：单选下拉在、多选列表不在
     * ============================================================== */
    console.log('\n=== 1. 默认关闭：还是原来的单选下拉 ===');

    let s = await stat();
    check(s.selVisible === true, '默认显示单选下拉 #selTargetTab', String(s.selVisible));
    check(s.multiVisible === false, '默认不显示多选列表 #targetMulti', String(s.multiVisible));
    check(s.total === A_FIRST, '单页扫描：只有 / 的 6 张（=' + s.total + '）', String(s.total));
    check(s.pageBadges === 0, '单页扫描时没有「来源页」角标', String(s.pageBadges));

    /* ============================================================== *
     * 2. 打开设置 → 控件当场切换（不用刷新）
     * ============================================================== */
    console.log('\n=== 2. 设置里打开 → 控件立即切换 ===');

    await setMergeTabs(true);
    await sleep(4500);
    s = await stat();
    check(s.selVisible === false, '打开后单选下拉隐藏', String(s.selVisible));
    check(s.multiVisible === true, '打开后多选列表出现', String(s.multiVisible));
    check(s.checked === 1, '默认只勾中一个页面（当前主目标）', String(s.checked));

    await openPanel();
    await sleep(300);
    const rowCount = await gallery.evaluate(() =>
      document.querySelectorAll('#targetsList .tm-row').length);
    check(rowCount === 3, '勾选列表里列出了 3 个网页标签页（=' + rowCount + '）', String(rowCount));

    /* ============================================================== *
     * 3. 勾两页（同源、部分重叠）→ 按地址去重
     * ============================================================== */
    console.log('\n=== 3. 勾选同源两页 → 合并去重 ===');

    await setTargets(['合并测试 A1', '合并测试 A2']);
    s = await stat();
    check(s.checked === 2, '两个页面都勾上了', String(s.checked));
    check(s.total === A_MERGED,
      '合并去重后 ' + A_MERGED + ' 张（不去重会是 6+5=11）（=' + s.total + '）', String(s.total));

    const dup3 = await countImg('/img/3.png');
    const dup5 = await countImg('/img/5.png');
    check(dup3 === 1, '重叠的 /img/3.png 只出现一次（=' + dup3 + '）', String(dup3));
    check(dup5 === 1, '重叠的 /img/5.png 只出现一次（=' + dup5 + '）', String(dup5));
    const only6 = await countImg('/img/6.png');
    check(only6 === 1, '只有 /b 才有的 /img/6.png 也在结果里（=' + only6 + '）', String(only6));

    /* ============================================================== *
     * 4. 来源页角标 + 顶栏标题
     * ============================================================== */
    console.log('\n=== 4. 卡片标出来源页 ===');

    check(s.pageBadges === s.cards,
      '每张卡片都带「来源页」角标（' + s.pageBadges + '/' + s.cards + '）',
      s.pageBadges + '/' + s.cards);
    check(s.host === '2 个页面', '顶栏显示「2 个页面」（=' + s.host + '）', s.host);
    check(/2 个页面/.test(s.summary), '胶囊摘要写「2 个页面」（=' + s.summary + '）', s.summary);

    /* ============================================================== *
     * 5. 跨站点合并：A/ + localhost
     * ============================================================== */
    console.log('\n=== 5. 跨站点合并（不同 host） ===');

    await setTargets(['合并测试 A1', '合并测试 B']);
    s = await stat();
    check(s.checked === 2, '勾上了两个不同站点的页面', String(s.checked));
    check(s.total === A_FIRST + B_TOTAL,
      'A(6) + B(4) = ' + (A_FIRST + B_TOTAL) + ' 张（=' + s.total + '）', String(s.total));

    /* ============================================================== *
     * 6. 取消勾选 → 回到单页
     * ============================================================== */
    console.log('\n=== 6. 只勾一个 → 回到单页语义 ===');

    await setTargets(['合并测试 A1']);
    s = await stat();
    check(s.checked === 1, '只剩一个勾选', String(s.checked));
    check(s.total === A_FIRST, '回到 / 的 6 张（=' + s.total + '）', String(s.total));
    check(s.pageBadges === 0, '单页时「来源页」角标消失', String(s.pageBadges));
    check(s.host === '127.0.0.1', '顶栏回到域名（=' + s.host + '）', s.host);

    /* ============================================================== *
     * 7. 全部取消 → 说清是「还没勾」
     * ============================================================== */
    console.log('\n=== 7. 全部取消 → 空态说清原因 ===');

    await setTargets([]);
    await sleep(1200);
    const empty = await gallery.evaluate(() => ({
      hidden: document.getElementById('empty').hidden,
      text: document.getElementById('emptyText').textContent.trim()
    }));
    check(empty.hidden === false, '出现空态', String(empty.hidden));
    check(/勾选|选择/.test(empty.text),
      '空态说的是「还没有勾选页面」，而不是「本页没有发现图片」', empty.text);

    /* ============================================================== *
     * 8. 搜索能按来源页命中（只在合并时）
     * ============================================================== */
    console.log('\n=== 8. 搜索按来源页命中 ===');

    await setTargets(['合并测试 A1', '合并测试 B']);
    s = await stat();
    check(s.total === A_FIRST + B_TOTAL, '前置：合并后 10 张', String(s.total));

    await gallery.evaluate(() => {
      const b = document.getElementById('btnSearch');
      if (document.getElementById('searchPop').hidden) b.click();
      const el = document.getElementById('search');
      el.value = 'localhost';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(900);
    const searched = await gallery.evaluate(() =>
      Number(document.getElementById('statFiltered').textContent));
    check(searched === B_TOTAL,
      '搜 "localhost" 只剩 B 站的 4 张（=' + searched + '）', String(searched));

    await gallery.evaluate(() => {
      const el = document.getElementById('search');
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const x = document.getElementById('btnSearchClear');
      if (x) x.click();
    });
    await sleep(900);

    /* ============================================================== *
     * 9. 导出的 JSON 带「来源页」
     * ============================================================== */
    console.log('\n=== 9. 导出带「来源页」 ===');

    const wait = gallery.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await gallery.evaluate(() => document.getElementById('btnExport').click());
    const dl = await wait;
    let rows = null;
    if (dl) {
      const file = await dl.path();
      if (file) { try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { rows = null; } }
    }
    check(Array.isArray(rows), '导出成功且是 JSON 数组', rows ? 'ok' : 'null');
    check(rows && rows.length === A_FIRST + B_TOTAL,
      '导出条数 = 合并结果数（' + (rows ? rows.length : 'null') + '）',
      rows ? String(rows.length) : 'null');
    check(rows && rows.every((r) => Object.prototype.hasOwnProperty.call(r, '来源页')),
      '每条记录都带「来源页」字段');
    check(rows && rows.some((r) => String(r['来源页']).indexOf('localhost') >= 0),
      'B 站那几张的来源页写着 localhost');

    /* ============================================================== *
     * 10. 「在图库中打开」切换扫描目标 → 必须真的换过去
     *
     * 这一节是**回归测试**。合并模式与单选模式共用 `loadTabList()`，
     * 而它一度会用多选列表的勾选**反向覆盖** `tabId` ——
     * `switchTarget()` 刚把 tabId 改成新目标，紧接着刷新列表时又被改回旧的，
     * 那次「切换」等于当场被撤销：顶栏和「扫描目标」控件都换了，
     * 网格里却还是上一页的图。
     *
     * 当时是 `browser-scan-limit` / `browser-restore-one` / `browser-probe-advance`
     * 三个套件以**三种完全不同的面目**顺带踩出来的（底栏数字不变 / 数量对不上 /
     * 体积探测整个失败），报错信息没有一条指向真凶。所以这里专门钉一条，
     * 让下次它一坏就直接报出「切了目标但图没换」。
     * ============================================================== */
    console.log('\n=== 10. 切扫描目标：图库开着时再点一次图标 ===');

    /** 按**完整地址**找标签页 id（A 站两个页同端口，只按端口找会歧义） */
    const tabIdOfUrl = (url) => sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url === u);
      return t ? t.id : null;
    }, url);

    const idB = await tabIdOfUrl(siteB.url);
    const idA1 = await tabIdOfUrl(siteA.url);
    check(idB != null && idA1 != null,
      '能找到两个站点标签页的 id（B=' + idB + ' / A1=' + idA1 + '）');

    /* 10a. 合并模式（此刻勾着 A1 + B）→ 切到 B：勾选应收缩成 B 这一个 */
    await sw.evaluate(async (id) => { await openGallery(id); }, idB);
    await sleep(5000);
    s = await stat();
    check(s.checked === 1,
      '合并模式下切目标 → 勾选收缩成一个（=' + s.checked + '）', String(s.checked));
    check(s.total === B_TOTAL,
      '结果换成 B 站的 ' + B_TOTAL + ' 张（=' + s.total + '）', String(s.total));
    check(s.host === 'localhost', '顶栏换成 localhost（=' + s.host + '）', s.host);
    check(s.pageBadges === 0, '只剩一个页面 → 来源页角标消失', String(s.pageBadges));

    /* 10b. 关掉合并开关 → 控件切回单选下拉 */
    await setMergeTabs(false);
    await sleep(4500);
    s = await stat();
    check(s.selVisible === true && s.multiVisible === false,
      '关掉后控件切回单选下拉（sel=' + s.selVisible + ' / multi=' + s.multiVisible + '）');

    /* 10c. 单选模式下再切一次目标 —— 正是那个回归的原样场景 */
    await sw.evaluate(async (id) => { await openGallery(id); }, idA1);
    await sleep(5000);
    s = await stat();
    const selVal = await gallery.evaluate(() => document.getElementById('selTargetTab').value);
    check(s.total === A_FIRST,
      '单选模式下切到 A 站，图真的换成 6 张、不是留在上一页（=' + s.total + '）', String(s.total));
    check(s.host === '127.0.0.1', '顶栏跟着换回 127.0.0.1（=' + s.host + '）', s.host);
    check(selVal === String(idA1),
      '目标下拉同步选中新目标（=' + selVal + '，期望 ' + idA1 + '）', selVal);
  } catch (e) {
    fail++;
    console.log('  ✗ 抛异常：' + (e && e.stack ? e.stack : e));
  }

  console.log('\n' + '-'.repeat(50));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');

  await ctx.close();
  siteA.close();
  siteB.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
