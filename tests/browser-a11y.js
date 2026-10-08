/* ImageHunter — 真实浏览器：键盘与读屏器可访问性
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 * 自建本地 HTTP 页面（30 张真实 PNG），不依赖外网。
 *
 * 这个套件存在的理由：可访问性的静态守卫（validate.js 第 15 节）只能证明
 * 「代码写了」，证明不了「真的能用」。roving tabindex 写错了会变成
 * 「整个网格完全 Tab 不进去」，:focus 显隐规则写错了会变成
 * 「Tab 到一个看不见的按钮上」—— 这两种错都不影响截图和鼠标操作，
 * 只有真的按键盘才会暴露。所以这里用真键盘走一遍。
 *
 * 覆盖：
 *   - 语义结构：listbox / aria-multiselectable / aria-describedby / srStatus / progressbar
 *   - roving tabindex：整个网格恰好 1 个 Tab 停靠点，Tab / Shift+Tab 都能正常进出
 *   - 方向键、Home / End 真的移动焦点（且焦点环跟着走）
 *   - Enter / 空格 = 勾选（class + aria-selected 双写），并触发读屏器播报
 *   - P = 打开灯箱
 *   - WCAG 2.4.7：卡片获得焦点时，原本 hover 才出现的 .zoom / .restore 必须可见
 *   - 卡片内的辅助按钮不占 Tab 顺序、勾选圈对读屏器隐藏
 *   - 卡片可访问名称包含「第 N 张」等关键信息
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
const PROFILE = path.join(os.tmpdir(), 'ih-a11y-profile-' + Date.now());

const SITE_OPTS = { cols: 6, rows: 5, imgW: 600, imgH: 400 };   // 30 张，够铺满多行
const TOTAL = SITE_OPTS.cols * SITE_OPTS.rows;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 交互辅助
 * ------------------------------------------------------------------ */

/** 把焦点放到第 i 张卡片上（走真实的 DOM focus，不模拟按键） */
async function focusCard(page, i) {
  await page.evaluate((idx) => {
    const c = document.querySelectorAll('#grid .card')[idx];
    if (c) c.focus();
  }, i);
  await sleep(60);
}

/** 当前焦点落在第几张卡片上（不在卡片上则返回 -1），以及谁是唯一的 tabindex=0 */
async function roving(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#grid .card'));
    return {
      focusIdx: cards.indexOf(document.activeElement),
      zeroIdx: cards.findIndex((c) => c.tabIndex === 0),
      zeroCount: cards.filter((c) => c.tabIndex === 0).length,
      total: cards.length
    };
  });
}

async function selectedCount(page) {
  return page.evaluate(() => document.querySelectorAll('#grid .card.selected').length);
}

/** 读屏器播报区当前文本（announce 有 180ms 防抖，调用方要等够） */
async function srText(page) {
  return page.evaluate(() => document.getElementById('srStatus').textContent);
}

/**
 * 灯箱状态。两个坑都踩过，写在这里免得下次再踩：
 *  1. 灯箱不在 light DOM 里 —— 它建在一个 `[data-ih-host]` 宿主元素的
 *     **open shadow root** 内（见 U.createShadowHost），
 *     `document.querySelector('.ih-lb')` 永远是 null。
 *  2. 关闭（Esc / 点 X）**不会**把元素摘掉，只摘 `.ih-show` 类。
 *     所以「关没关」要看类名，不能看元素在不在。
 */
async function lightboxState(page) {
  return page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
    let lb = null;
    for (const h of hosts) {
      const el = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
      if (el) { lb = el; break; }
    }
    return { hasLb: !!lb, shown: lb ? lb.classList.contains('ih-show') : false };
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  const SITE = localSite.url;
  console.log('测试页地址 =', SITE);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  /* ---------- 1. 打开测试页并打开图库 ---------- */
  console.log('\n=== 1. 打开测试页 → 打开图库独立页 ===');
  const site = await ctx.newPage();
  await site.goto(SITE, { waitUntil: 'load', timeout: 60000 });
  await site.bringToFront();
  await sleep(2000);

  const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await sw.evaluate(async () => {
    const target = await pickTargetTab(null);
    await openGallery(target);
  });
  const gallery = await galleryPromise;
  await gallery.waitForLoadState('domcontentloaded');
  // 键盘测试必须有真实焦点，所以这次要切到前台（与 browser-marquee 相反）
  await gallery.bringToFront();
  await sleep(4000);

  const basic = await gallery.evaluate(() => ({
    mode: document.body.className,
    cards: document.querySelectorAll('#grid .card').length,
    selected: document.querySelectorAll('#grid .card.selected').length
  }));
  console.log(JSON.stringify(basic));
  check(basic.mode.indexOf('mode-page') >= 0, '图库处于独立页模式');
  check(basic.cards >= TOTAL, '网格渲染出全部卡片', basic.cards + ' 个');
  check(basic.selected === 0, '打开后默认不勾选', basic.selected + ' 个');

  /* ---------- 2. 语义结构 ---------- */
  console.log('\n=== 2. 语义结构（读屏器看到的骨架）===');
  const sem = await gallery.evaluate(() => {
    const grid = document.getElementById('grid');
    const help = document.getElementById('gridHelp');
    const sr = document.getElementById('srStatus');
    const prog = document.getElementById('progress');
    return {
      gridRole: grid.getAttribute('role'),
      multi: grid.getAttribute('aria-multiselectable'),
      describedby: grid.getAttribute('aria-describedby'),
      gridLabel: grid.getAttribute('aria-label'),
      helpClass: help ? help.className : null,
      helpText: help ? help.textContent.replace(/\s+/g, ' ').trim() : '',
      helpVisible: help ? (help.getBoundingClientRect().width > 1) : null,
      srRole: sr ? sr.getAttribute('role') : null,
      srLive: sr ? sr.getAttribute('aria-live') : null,
      srAtomic: sr ? sr.getAttribute('aria-atomic') : null,
      progRole: prog ? prog.getAttribute('role') : null,
      progNow: prog ? prog.getAttribute('aria-valuenow') : null
    };
  });
  console.log(JSON.stringify(sem));
  check(sem.gridRole === 'listbox', '网格 role="listbox"', sem.gridRole);
  check(sem.multi === 'true', '网格 aria-multiselectable="true"（多选列表）', sem.multi);
  check(sem.describedby === 'gridHelp', '网格 aria-describedby 指向 #gridHelp', sem.describedby);
  check(!!sem.gridLabel, '网格有 aria-label', sem.gridLabel);
  check(sem.helpClass === 'sr-only', '#gridHelp 是 sr-only', sem.helpClass);
  check(sem.helpVisible === false, '#gridHelp 视觉上不占位（宽度 ≤ 1px）', String(sem.helpVisible));
  check(/方向键/.test(sem.helpText) && /Enter/.test(sem.helpText) && /空格/.test(sem.helpText),
    '操作说明里写明了方向键 / Enter / 空格', sem.helpText.slice(0, 40));
  check(sem.srRole === 'status' && sem.srLive === 'polite',
    '#srStatus 是 role="status" + aria-live="polite"', sem.srRole + '/' + sem.srLive);
  check(sem.srAtomic === 'true', '#srStatus 是 aria-atomic', sem.srAtomic);
  check(sem.progRole === 'progressbar', '保存进度是 role="progressbar"', sem.progRole);
  check(sem.progNow !== null, '进度条有 aria-valuenow（随时可查）', sem.progNow);

  /* ---------- 3. roving tabindex：网格只占一个停靠点 ---------- */
  console.log('\n=== 3. roving tabindex：整个网格只有一个 Tab 停靠点 ===');
  const r0 = await roving(gallery);
  console.log(JSON.stringify(r0));
  check(r0.zeroCount === 1, '恰好一张卡片是 tabindex=0', r0.zeroCount + ' 张');
  check(r0.zeroIdx === 0, '初始停靠点是第一张卡片', '第 ' + r0.zeroIdx + ' 张');

  // 网格内所有可 Tab 元素的总数 —— 这才是「按多少次 Tab 才能走完」的真实答案
  const stops = await gallery.evaluate(() => {
    const grid = document.getElementById('grid');
    let n = 0;
    grid.querySelectorAll('*').forEach((el) => {
      if (el.tabIndex >= 0 && !el.disabled) n++;
    });
    return n;
  });
  check(stops === 1, '网格内可 Tab 元素共 1 个（' + basic.cards + ' 张卡片不是 ' + basic.cards + ' 个停靠点）', stops + ' 个');

  // 从停靠点 Tab 出去 → 焦点必须离开网格
  await focusCard(gallery, 0);
  await gallery.keyboard.press('Tab');
  await sleep(80);
  const outDown = await gallery.evaluate(() => {
    const a = document.activeElement;
    return { inGrid: !!(a && a.closest && a.closest('#grid')), tag: a ? a.tagName : null, id: a ? a.id : null };
  });
  console.log('Tab 之后焦点：' + JSON.stringify(outDown));
  check(outDown.inGrid === false, '在网格里按 Tab → 焦点离开网格（不会逐张走）', JSON.stringify(outDown));

  // Shift+Tab 从停靠点往回 → 也必须离开网格
  await focusCard(gallery, 0);
  await gallery.keyboard.press('Shift+Tab');
  await sleep(80);
  const outUp = await gallery.evaluate(() => {
    const a = document.activeElement;
    return { inGrid: !!(a && a.closest && a.closest('#grid')), tag: a ? a.tagName : null, id: a ? a.id : null };
  });
  console.log('Shift+Tab 之后焦点：' + JSON.stringify(outUp));
  check(outUp.inGrid === false, 'Shift+Tab → 焦点同样离开网格（只占一个停靠点）', JSON.stringify(outUp));

  /* ---------- 4. 方向键真的移动焦点 ---------- */
  console.log('\n=== 4. 方向键移动焦点 ===');
  const cols = await gallery.evaluate(() => {
    const cards = document.querySelectorAll('#grid .card');
    const top0 = cards[0].getBoundingClientRect().top;
    let n = 0;
    for (const c of cards) {
      if (Math.abs(c.getBoundingClientRect().top - top0) < 2) n++;
      else break;
    }
    return n;
  });
  console.log('图库每行 ' + cols + ' 张');

  await focusCard(gallery, 0);
  await gallery.keyboard.press('ArrowRight');
  await sleep(80);
  let r = await roving(gallery);
  console.log(JSON.stringify(r));
  check(r.focusIdx === 1, '→ 焦点移到第 2 张', '第 ' + (r.focusIdx + 1) + ' 张');
  check(r.zeroCount === 1 && r.zeroIdx === 1, 'roving 停靠点跟着一起挪（仍只有一个是 0）',
    'zeroIdx=' + r.zeroIdx + ' count=' + r.zeroCount);

  await gallery.keyboard.press('ArrowLeft');
  await sleep(80);
  r = await roving(gallery);
  check(r.focusIdx === 0, '← 焦点移回第 1 张', '第 ' + (r.focusIdx + 1) + ' 张');

  await gallery.keyboard.press('ArrowDown');
  await sleep(80);
  r = await roving(gallery);
  check(r.focusIdx === cols, '↓ 焦点下移一行（+' + cols + '）', '第 ' + (r.focusIdx + 1) + ' 张');

  await gallery.keyboard.press('ArrowUp');
  await sleep(80);
  r = await roving(gallery);
  check(r.focusIdx === 0, '↑ 焦点上移一行', '第 ' + (r.focusIdx + 1) + ' 张');

  // 边界：第一张按 ← 不越界
  await gallery.keyboard.press('ArrowLeft');
  await sleep(80);
  r = await roving(gallery);
  check(r.focusIdx === 0, '第一张再按 ← 不越界（停在原地）', '第 ' + (r.focusIdx + 1) + ' 张');

  /* ---------- 5. Home / End ---------- */
  console.log('\n=== 5. Home / End ===');
  await gallery.keyboard.press('End');
  await sleep(120);
  r = await roving(gallery);
  check(r.focusIdx === r.total - 1, 'End → 跳到最后一张', '第 ' + (r.focusIdx + 1) + ' / ' + r.total + ' 张');

  await gallery.keyboard.press('Home');
  await sleep(120);
  r = await roving(gallery);
  check(r.focusIdx === 0, 'Home → 跳回第一张', '第 ' + (r.focusIdx + 1) + ' 张');

  /* ---------- 6. 焦点环真的画出来了 ---------- */
  console.log('\n=== 6. 焦点可见（WCAG 2.4.7）===');
  await focusCard(gallery, 0);
  const ring = await gallery.evaluate(() => {
    const card = document.querySelectorAll('#grid .card')[0];
    const cs = getComputedStyle(card);
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      focusVisible: card.matches(':focus-visible'),
      zoomOpacity: getComputedStyle(card.querySelector('.zoom')).opacity,
      hoverOpacity: getComputedStyle(document.querySelectorAll('#grid .card')[5].querySelector('.zoom')).opacity
    };
  });
  console.log(JSON.stringify(ring));
  check(ring.focusVisible === true, '卡片获得键盘焦点时匹配 :focus-visible', String(ring.focusVisible));
  check(ring.outlineStyle === 'solid' && parseFloat(ring.outlineWidth) >= 2,
    '焦点环真的画出来了（outline solid ≥ 2px）', ring.outlineStyle + ' ' + ring.outlineWidth);
  check(parseFloat(ring.zoomOpacity) === 1,
    '聚焦卡片上的 .zoom 可见（原本 hover 才出现 → 不会 Tab 到看不见的按钮）', ring.zoomOpacity);
  check(parseFloat(ring.hoverOpacity) === 0,
    '未聚焦、未悬停的卡片上 .zoom 仍是隐藏的（焦点规则没有误伤全局）', ring.hoverOpacity);

  /* ---------- 7. Enter / 空格 = 勾选 ---------- */
  console.log('\n=== 7. Enter / 空格勾选 ===');
  await gallery.evaluate(() => document.getElementById('btnClear').click());
  await sleep(120);
  await focusCard(gallery, 0);
  await gallery.keyboard.press('Enter');
  await sleep(120);
  let sel = await gallery.evaluate(() => {
    const c = document.querySelectorAll('#grid .card')[0];
    return { cls: c.classList.contains('selected'), aria: c.getAttribute('aria-selected') };
  });
  console.log(JSON.stringify(sel));
  check(sel.cls === true, 'Enter 勾选第 1 张（class 加上 selected）', String(sel.cls));
  check(sel.aria === 'true', '同时写入 aria-selected="true"（读屏器念得出「已选中」）', sel.aria);
  check(await selectedCount(gallery) === 1, '已勾选统计为 1 张', (await selectedCount(gallery)) + ' 张');

  await sleep(350);   // 等 announce 的 180ms 防抖
  const srSel = await srText(gallery);
  console.log('读屏器播报 = ' + JSON.stringify(srSel));
  check(/已勾选\s*1\s*张/.test(srSel), '读屏器播报了「已勾选 1 张」', srSel);

  // 再按一次取消
  await gallery.keyboard.press('Enter');
  await sleep(120);
  sel = await gallery.evaluate(() => {
    const c = document.querySelectorAll('#grid .card')[0];
    return { cls: c.classList.contains('selected'), aria: c.getAttribute('aria-selected') };
  });
  check(sel.cls === false && sel.aria === 'false', '再按 Enter 取消勾选（class 与 aria-selected 同步）',
    sel.cls + '/' + sel.aria);

  // 空格
  await focusCard(gallery, 1);
  await gallery.keyboard.press('Space');
  await sleep(120);
  const sp = await gallery.evaluate(() => {
    const c = document.querySelectorAll('#grid .card')[1];
    return { cls: c.classList.contains('selected'), aria: c.getAttribute('aria-selected') };
  });
  check(sp.cls === true && sp.aria === 'true', '空格 = 勾选（与 Enter 等价）', sp.cls + '/' + sp.aria);

  /* ---------- 8. P = 打开灯箱 ---------- */
  console.log('\n=== 8. P 打开大图预览 ===');
  await focusCard(gallery, 0);
  await gallery.keyboard.press('p');
  await sleep(900);
  const lbOpen = await lightboxState(gallery);
  console.log('开灯箱后 = ' + JSON.stringify(lbOpen));
  check(lbOpen.hasLb && lbOpen.shown, '按 P 打开了灯箱（不用去够右上角的放大镜按钮）', JSON.stringify(lbOpen));
  await gallery.keyboard.press('Escape');
  await sleep(500);
  const lbClosed = await lightboxState(gallery);
  console.log('Esc 后 = ' + JSON.stringify(lbClosed));
  check(!lbClosed.shown, 'Esc 关闭灯箱（.ih-show 被摘掉）', JSON.stringify(lbClosed));

  /* ---------- 9. 卡片内辅助控件的无障碍属性 ---------- */
  console.log('\n=== 9. 辅助控件不占 Tab、勾选圈不重复播报 ===');
  const aux = await gallery.evaluate(() => {
    const c = document.querySelectorAll('#grid .card')[0];
    const pick = c.querySelector('.pick');
    const zoom = c.querySelector('.zoom');
    const restore = c.querySelector('.restore');
    return {
      pickHidden: pick ? pick.getAttribute('aria-hidden') : null,
      pickTab: pick ? pick.tabIndex : null,
      zoomTab: zoom ? zoom.tabIndex : null,
      zoomLabel: zoom ? zoom.getAttribute('aria-label') : null,
      restoreTab: restore ? restore.tabIndex : null,
      cardLabel: c.getAttribute('aria-label'),
      cardRole: c.getAttribute('role')
    };
  });
  console.log(JSON.stringify(aux));
  check(aux.cardRole === 'option', '卡片是 role="option"（listbox 的子项）', aux.cardRole);
  check(aux.pickHidden === 'true', '勾选圈对读屏器隐藏（不把「已选中」念两遍）', aux.pickHidden);
  check(aux.pickTab === -1, '勾选圈不占 Tab 顺序', String(aux.pickTab));
  check(aux.zoomTab === -1, '放大镜不占 Tab 顺序（键盘等价物是 P）', String(aux.zoomTab));
  check(aux.restoreTab === null || aux.restoreTab === -1,
    '「还原」按钮不占 Tab 顺序（键盘等价物是 R）', String(aux.restoreTab));
  check(/^第 1 张/.test(aux.cardLabel || ''), '卡片可访问名称以「第 1 张」开头', aux.cardLabel);
  check(!/已勾选|未勾选/.test(aux.cardLabel || ''),
    '卡片名称里不写勾选状态（那是 aria-selected 的职责，写进去会念两遍）', aux.cardLabel);

  /* ---------- 10. 筛选后 roving 不越界 ---------- */
  console.log('\n=== 10. 列表变化后 roving 不越界 ===');
  await gallery.keyboard.press('End');
  await sleep(120);
  r = await roving(gallery);
  const lastIdx = r.focusIdx;
  console.log('先把焦点放到最后一张（第 ' + (lastIdx + 1) + ' 张）');
  // 输入搜索词把列表砍短
  await gallery.evaluate(() => {
    const s = document.getElementById('search');
    s.value = 'zzz-不存在的文件名-zzz';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(400);
  const afterFilter = await gallery.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#grid .card'));
    return {
      cards: cards.length,
      zeroCount: cards.filter((c) => c.tabIndex === 0).length,
      emptyShown: !document.getElementById('empty').hidden
    };
  });
  console.log(JSON.stringify(afterFilter));
  check(afterFilter.cards === 0, '搜不到结果时网格为空', afterFilter.cards + ' 个');
  check(afterFilter.zeroCount === 0, '空列表里没有残留的 tabindex=0 卡片', afterFilter.zeroCount + ' 个');

  // 清掉搜索词，列表恢复，roving 必须回到合法位置
  await gallery.evaluate(() => {
    const s = document.getElementById('search');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  r = await roving(gallery);
  console.log(JSON.stringify(r));
  check(r.zeroCount === 1, '列表恢复后重新恰好一个停靠点', r.zeroCount + ' 个');
  check(r.zeroIdx === 0, '停靠点被夹回第 1 张（没有留在越界的位置上）', '第 ' + (r.zeroIdx + 1) + ' 张');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await ctx.close();
  localSite.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
