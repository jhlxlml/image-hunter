/* ImageHunter — 真实浏览器：「筛选 = 缩小工作集」语义
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 背景：早期版本里，筛选只改变「看得见哪些」，勾选状态会保留下来——
 * 于是「已选 6」可能在屏幕上一张都看不到，点「保存选中」还会把这 6 张
 * （含被筛掉的）一起存下去，非常容易误操作。
 *
 * 现在的约定（用户确认过的行为）：
 *   切换筛选条件时，**不在新结果里的图片会被取消勾选**。
 *   因此恒等式：已选数量 === 可见卡片里带 .selected 的数量。
 *
 * 覆盖：
 *   1. 部分命中：勾 6 张 → 搜出 11 张 → 交集只剩 1 张
 *   2. 真的被取消了（不是只是藏起来）：清掉筛选后不会复活
 *   3. 排序变化不影响勾选（集合没变）
 *   4. 「全选」= 勾上当前筛选结果；数量标注与「符合」一致
 *   5. 「反选」只在筛选结果内翻转，不会产生看不见的勾选
 *   6. 空结果 → 勾选清零、保存按钮禁用
 *   7. 恒等式在每一步都成立
 *   8. 「导出清单」跟随筛选结果；筛到 0 张时不导出（而不是导出全部）
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
const PROFILE = path.join(os.tmpdir(), 'ih-filter-profile-' + Date.now());
const SITE_OPTS = { cols: 8, rows: 6, imgW: 600, imgH: 400 };   // 48 张，全部 600×400 横图

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
  await sleep(2500);
  await target.bringToFront();
  await sleep(500);

  const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await sw.evaluate(async () => { await openGallery(await pickTargetTab(null)); });
  const gallery = await galleryPromise;
  await gallery.waitForLoadState('domcontentloaded');
  await sleep(5000);

  /* ---------------- 小工具 ---------------- */
  const visibleSelected = () => gallery.evaluate(() =>
    Array.from(document.querySelectorAll('#grid .card.selected')).map((c) => c.dataset.id));

  const stat = () => gallery.evaluate(() => ({
    total: Number(document.getElementById('statTotal').textContent),
    filtered: Number(document.getElementById('statFiltered').textContent),
    selected: Number(document.getElementById('statSelected').textContent),
    saveCount: Number(document.getElementById('saveCount').textContent),
    saveDisabled: document.getElementById('btnSave').disabled,
    allCount: document.getElementById('selAllCount').textContent
  }));

  /** 恒等式：已选数量必须等于「可见卡片中带 .selected 的数量」 */
  async function checkInvariant(where) {
    const s = await stat();
    const vis = await visibleSelected();
    check(s.selected === vis.length,
      where + '：已选(' + s.selected + ') === 可见勾选(' + vis.length + ')',
      JSON.stringify({ selected: s.selected, visible: vis.length }));
    return s;
  }

  const clickCards = (n) => gallery.evaluate((count) => {
    const cards = document.querySelectorAll('#grid .card');
    for (let i = 0; i < count && i < cards.length; i++) cards[i].click();
  }, n);

  const setSearch = (text) => gallery.evaluate((t) => {
    const input = document.getElementById('search');
    input.value = t;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);

  const clearSearch = async () => {
    await gallery.evaluate(() => document.getElementById('btnSearchClear').click());
    await sleep(500);
  };

  const pickAspect = (index) => gallery.evaluate((i) => {
    const chips = document.querySelectorAll('#aspectChips .chip');
    if (chips[i]) chips[i].click();
  }, index);

  /* ---------------- 1. 部分命中 ---------------- */
  console.log('\n=== 1. 部分命中：勾 6 张 → 筛选只剩 1 张 ===');
  await clickCards(6);
  await sleep(400);
  let s = await checkInvariant('勾选 6 张后');
  check(s.selected === 6, '已选 6 张', String(s.selected));

  // 搜 pic1 → 命中 pic1 / pic10..pic19 共 11 张；与已选 {pic0..pic5} 的交集是 {pic1}
  await setSearch('pic1');
  await sleep(700);
  s = await checkInvariant('搜索 pic1 后');
  check(s.filtered === 11, '搜索 pic1 命中 11 张', String(s.filtered));
  check(s.selected === 1, '已选从 6 收缩到 1（交集）', String(s.selected));
  const left = await visibleSelected();
  check(left.length === 1, '屏幕上只剩 1 张勾选', JSON.stringify(left));

  const toastText = await gallery.evaluate(() => document.getElementById('toast').textContent);
  console.log('提示文案:', toastText);

  /* ---------------- 2. 真的被取消，不是藏起来 ---------------- */
  console.log('\n=== 2. 清掉筛选后不复活 ===');
  await clearSearch();
  s = await checkInvariant('清掉搜索后');
  check(s.filtered === 48, '筛选已清空（符合 48）', String(s.filtered));
  check(s.selected === 1, '被筛掉的那 5 张没有复活', String(s.selected));

  /* ---------------- 3. 排序变化不影响勾选 ---------------- */
  console.log('\n=== 3. 只改排序，集合没变 → 勾选保持 ===');
  await gallery.evaluate(() => {
    const sel = document.getElementById('selSort');
    sel.value = 'area-asc';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(500);
  s = await checkInvariant('改排序后');
  check(s.selected === 1, '改排序不影响勾选', String(s.selected));

  /* ---------------- 4. 全选 = 当前筛选结果 ---------------- */
  console.log('\n=== 4. 全选 ===');
  await gallery.evaluate(() => document.getElementById('btnSelectAll').click());
  await sleep(500);
  s = await checkInvariant('全选后');
  check(s.selected === 48, '全选把 48 张全勾上', String(s.selected));
  check(s.allCount === '48', '「全选」按钮上的数量标注为 48', s.allCount);

  // 带筛选时全选 → 只勾筛选结果
  await gallery.evaluate(() => document.getElementById('btnClear').click());
  await sleep(300);
  await setSearch('pic1');
  await sleep(700);
  await gallery.evaluate(() => document.getElementById('btnSelectAll').click());
  await sleep(500);
  s = await checkInvariant('带筛选时全选');
  check(s.selected === 11, '带筛选时全选只勾到 11 张筛选结果', String(s.selected));
  check(s.allCount === '11', '「全选」按钮数量标注随筛选变化', s.allCount);

  /* ---------------- 5. 反选只在筛选结果内 ---------------- */
  console.log('\n=== 5. 反选 ===');
  await gallery.evaluate(() => document.getElementById('btnInvert').click());
  await sleep(500);
  s = await checkInvariant('反选后');
  check(s.selected === 0, '11 张全被反选掉', String(s.selected));

  await gallery.evaluate(() => document.getElementById('btnInvert').click());
  await sleep(500);
  s = await checkInvariant('再反选一次');
  check(s.selected === 11, '再反选一次回到 11', String(s.selected));

  /* ---------------- 6. 空结果 ---------------- */
  console.log('\n=== 6. 筛选到空 ===');
  await clearSearch();
  await sleep(400);
  // 本地站全是 600×400 横图 → 「竖图」命中 0 张
  await pickAspect(2);
  await sleep(700);
  s = await checkInvariant('切到「竖图」后');
  check(s.filtered === 0, '竖图命中 0 张', String(s.filtered));
  check(s.selected === 0, '勾选清零', String(s.selected));
  check(s.saveDisabled === true, '「保存选中」被禁用', String(s.saveDisabled));

  // 点 chip 触发的取消要给提示（搜索框是逐字触发的，特意静默，免得一直闪）
  const chipToast = await gallery.evaluate(() => document.getElementById('toast').textContent);
  console.log('提示文案:', chipToast);
  check(/已取消\s*11\s*张/.test(chipToast), '点筛选条件时提示「已取消 11 张」', chipToast);

  await pickAspect(0);
  await sleep(600);
  s = await checkInvariant('切回「全部」后');
  check(s.filtered === 48 && s.selected === 0, '切回全部：48 张符合，但勾选仍是 0', JSON.stringify(s));

  /* ---------------- 7. 清空按钮 ---------------- */
  console.log('\n=== 7. 清空 ===');
  await gallery.evaluate(() => document.getElementById('btnSelectAll').click());
  await sleep(400);
  await gallery.evaluate(() => document.getElementById('btnClear').click());
  await sleep(400);
  s = await checkInvariant('清空后');
  check(s.selected === 0, '清空后已选归零', String(s.selected));

  /* ---------------- 8. 导出清单跟随筛选 ---------------- */
  console.log('\n=== 8. 导出清单 ===');

  /** 点「导出清单」并读回文件内容；没产生下载时返回 null */
  async function exportAndRead() {
    const wait = gallery.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await gallery.evaluate(() => document.getElementById('btnExport').click());
    const dl = await wait;
    if (!dl) return null;
    const file = await dl.path();
    return file ? fs.readFileSync(file, 'utf8') : null;
  }

  await gallery.evaluate(() => document.getElementById('btnClear').click());
  await sleep(300);
  const allJson = await exportAndRead();
  check(allJson !== null, '无筛选时能正常导出', String(allJson !== null));
  check(allJson ? JSON.parse(allJson).length === 48 : false,
    '无筛选 → 导出 48 条', allJson ? String(JSON.parse(allJson).length) : 'null');

  await setSearch('pic1');
  await sleep(700);
  const filteredJson = await exportAndRead();
  check(filteredJson ? JSON.parse(filteredJson).length === 11 : false,
    '搜索 pic1 → 只导出 11 条筛选结果',
    filteredJson ? String(JSON.parse(filteredJson).length) : 'null');

  // 关键回归：筛到 0 张时不能悄悄导出全部
  await clearSearch();
  await sleep(400);
  await pickAspect(2);            // 本地站全是横图 → 竖图命中 0 张
  await sleep(700);
  s = await stat();
  check(s.filtered === 0, '前置条件：当前筛选结果是 0 张', String(s.filtered));

  const emptyJson = await exportAndRead();
  check(emptyJson === null,
    '筛到 0 张时不产生导出文件（修复前会导出全部 48 条）',
    emptyJson ? '仍导出了 ' + JSON.parse(emptyJson).length + ' 条' : '');

  const emptyToast = await gallery.evaluate(() => document.getElementById('toast').textContent);
  console.log('提示文案:', emptyToast);
  check(/没有图片/.test(emptyToast), '给出「当前筛选条件下没有图片」提示', emptyToast);

  await pickAspect(0);
  await sleep(500);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await ctx.close();
  await localSite.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
