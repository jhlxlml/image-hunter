/* ImageHunter — 真实浏览器：顶栏图标常驻 + 筛选条默认收起
 *
 * 依赖与用法同 browser-lang.js（playwright-core + 本机 Edge / Chrome）。
 * 自建本地 HTTP 页面（真实 PNG），不依赖外网。
 *
 * 这个套件存在的理由：
 *
 *   顶栏这一版是「8 个动作全部常驻」—— 中间短暂试过把三条偶尔用的动作
 *   收进「更多」溢出菜单，后来又**改回常驻**了（常驻才是一点就到，
 *   而且「探测体积」工作时图标要转圈，藏进菜单里就看不见了）。
 *   撤掉菜单这件事，**静态守卫看不出坏**：validate.js 只认得
 *   「HTML 里有没有这个 id」，而这里真正会坏的地方全是运行时的：
 *
 *   1. **拆菜单时漏了 .menu 的 CSS 定位上下文。** 删掉 .hdr-actions 的
 *      position:relative 之后如果不连带清掉菜单样式，残留的绝对定位元素
 *      会在顶栏里乱跑。
 *   2. **三条动作搬回来但没接上线。** 从菜单项改回 <button> 时，
 *      bindEvents 里那三行忘了改 —— 按钮长得对、点了不动。最常见的坏法。
 *   3. **两个按钮的图标长得一模一样。** 用户明确提过「不同功能图标不要一样」；
 *      这类问题肉眼看得出来、静态正则却很难守（path 里差一个小数点就不同），
 *      所以这里把**每一条 path 的 d 属性规范化后求指纹**，两两比对。
 *   4. **筛选条默认展开的老行为没改掉。** HTML 上 aria-expanded 与 hidden
 *      两处要同时翻，只翻一处会出现「按钮说收起了、条还在」。
 *   5. **默认收起了但「有没有在筛」看不出来。** 一旦有生效条件，
 *      按钮必须常亮 + 显示数量，否则用户会以为自己没筛过。
 *   6. **窄栏（面板模式 380px）下 8 个图标挤爆顶栏。** 减按钮尺寸的
 *      媒体查询没生效 / 生效了但顶栏还是溢出。
 *         · 这里的观测点是 **`.ctrl-bar` 的 scrollWidth** 与
 *           `documentElement.scrollWidth`，**不是** `.hdr-actions` 的 ——
 *           后者有 margin-left:auto，在 flex 行里被压到内容宽度，
 *           scrollWidth 恒等于 clientWidth，无论塞多少东西都是绿的。
 *           我第一版就栽在这儿（注入「删掉媒体查询」它照样全绿）。
 *   7. **底栏「保存选中」被长统计文字挤到折行。** `.sum` 是
 *      `flex: 1 1 auto`（basis 为 auto），会按内容宽度抢地方；深度嗅探
 *      往 `.sum` 里加的那句「已达滚动上限」提示能把按钮压到 90px、文字折行。
 *      **判据只能看 `scrollHeight`** —— flex 行会把按钮的
 *      `getBoundingClientRect().height` 钉在 34px，看高度测不到症状
 *      （本轮第三个假绿）。这一点务必和「空态下按钮本来就窄」区分开。
 *
 * 所以这里真的开图库页、真的点每一个图标、真的按 380px 重排一遍。
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
const PROFILE = path.join(os.tmpdir(), 'ih-topbar-profile-' + Date.now());

const SITE_OPTS = { cols: 4, rows: 3, imgW: 600, imgH: 400 };
const TOTAL = SITE_OPTS.cols * SITE_OPTS.rows;

/** 顶栏应当常驻的动作（顺序即 DOM 顺序）。
 *
 * `#btnClose` 是 `panel-only`：DOM 里永远在，但**独立页模式下 display:none**。
 * 所以「顶栏里有哪些按钮」和「用户看到几个」是两个数 —— 分开断言，
 * 而不是把一个会随模式变化的数字写成硬编码。 */
const EXPECTED_TOP_IDS = ['btnRescan', 'btnProbe', 'btnExport', 'btnDeep',
  'btnPanel', 'btnOptions', 'btnClose'];
const EXPECTED_VISIBLE = ['btnRescan', 'btnProbe', 'btnExport', 'btnDeep',
  'btnPanel', 'btnOptions'];

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 顶栏 + 工具行的当前状态 */
const state = (page) => page.evaluate(() => {
  const panel = document.getElementById('filterPanel');
  const fbtn = document.getElementById('btnFilters');
  const box = document.querySelector('.hdr-actions');
  const bar = document.querySelector('.ctrl-bar');
  const btns = box
    ? Array.from(box.querySelectorAll(':scope > .icon-btn'))
      .filter((b) => b.offsetParent !== null || getComputedStyle(b).display !== 'none')
    : [];
  const first = btns.length ? btns[0].getBoundingClientRect() : null;
  const last = btns.length ? btns[btns.length - 1].getBoundingClientRect() : null;
  return {
    // 顶栏动作组：第一/最后一个按钮的横向范围
    firstLeft: first ? Math.round(first.left) : null,
    lastRight: last ? Math.round(last.right) : null,
    lastBtnW: last ? Math.round(last.width) : null,
    // 工具行：8 个控件带 margin-left:auto 的滑条，窄栏里最容易把行撑爆
    barScrollW: bar ? bar.scrollWidth : null,
    barClientW: bar ? bar.clientWidth : null,
    // 整页横向滚动 —— 溢出的最终判据（documentElement 而不是某个容器：
    // 容器可以是 overflow:hidden 把问题藏起来，整页的滚动条藏不住）
    docScrollW: document.documentElement.scrollWidth,
    viewportW: window.innerWidth,
    activeId: document.activeElement ? document.activeElement.id : '',
    filtersHidden: panel ? panel.hidden : null,
    filtersExpanded: fbtn ? fbtn.getAttribute('aria-expanded') : null,
    filtersOn: fbtn ? fbtn.classList.contains('on') : null,
    filterBadgeHidden: (document.getElementById('filterCount') || {}).hidden,
    filterBadge: (document.getElementById('filterCount') || {}).textContent,
    // 溢出菜单的残留物：这场重构要把它清干净
    hasMenu: !!document.querySelector('.menu, #moreMenu'),
    hasMoreBtn: !!document.getElementById('btnMoreMenu'),
  };
});

/** 顶栏常驻图标。
 *
 * 只数**可见**的：`#btnClose` 是 panel-only，独立页模式下 DOM 里有它但
 * `display:none`。数 DOM 子节点会把 7 常驻 + 一个隐形的关闭按钮算成 8，
 * 而「用户看到几个」才是要守的东西。
 *
 * 顺便把每个按钮的图标**指纹**取出来：所有 path / rect / circle / line 的
 * 形状属性规范化后拼成一串。两个按钮干不同的事却用同一个图标，
 * 指纹就会撞上 —— 那是用户明确要求不许出现的事。 */
const topIcons = (page) => page.evaluate(() => {
  const box = document.querySelector('.hdr-actions');
  if (!box) return null;
  const all = Array.from(box.querySelectorAll(':scope > .icon-btn'));
  const visible = all.filter((b) => b.offsetParent !== null || getComputedStyle(b).display !== 'none');

  const fingerprint = (btn) => {
    const svg = btn.querySelector('svg');
    if (!svg) return null;
    const shapes = Array.from(svg.querySelectorAll('path, rect, circle, line, polyline, polygon'));
    if (!shapes.length) return null;
    return shapes.map((s) => {
      const tag = s.tagName.toLowerCase();
      // 规范化：把数字里的尾随 0 和小数点去掉（"3.50" 与 "3.5" 是同一个形状），
      // 空白统一成单空格 —— 否则「同一个图标抄了两遍、只是格式不同」会漏判。
      const attrs = ['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r',
        'x1', 'y1', 'x2', 'y2', 'points']
        .map((a) => s.getAttribute(a))
        .filter((v) => v != null)
        .map((v) => v.replace(/\s+/g, ' ').trim()
          .replace(/(\d)\.0+(?=\D|$)/g, '$1')
          .replace(/(\.\d*?)0+(?=\D|$)/g, '$1')
          .replace(/(\d)\.(?=\D|$)/g, '$1'))
        .join(',');
      return tag + ':' + attrs;
    }).join('|');
  };

  return {
    count: visible.length,
    ids: visible.map((b) => b.id),
    allIds: all.map((b) => b.id),
    hiddenIds: all.filter((b) => !visible.includes(b)).map((b) => b.id),
    prints: Object.fromEntries(all.map((b) => [b.id, fingerprint(b)])),
  };
});

/** 指纹两两比对，返回「撞在一起」的 id 对 */
function collidingIconPairs(prints) {
  const ids = Object.keys(prints || {}).filter((id) => prints[id]);
  const seen = new Map();
  const dupes = [];
  for (const id of ids) {
    const p = prints[id];
    if (seen.has(p)) dupes.push([seen.get(p), id]);
    else seen.set(p, id);
  }
  return dupes;
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  console.log('测试页地址 =', localSite.url, '（' + TOTAL + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',
    headless: true,
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log('扩展 ID =', extId);

  try {
    /* ---------- 0. 开图库页 ---------- */
    /* 先把视图状态清掉：`filtersOpen` 是**用户偏好，会落盘**（这是有意做的），
       于是上一轮跑这个套件留下的「展开过」会被读回来，
       让「默认收起」的断言假红。清一次保证起点是真正的默认态。 */
    await sw.evaluate(() => new Promise((res) => {
      try { chrome.storage.local.clear(() => res(true)); } catch (e) { res(false); }
    }));

    const site = await ctx.newPage();
    await site.goto(localSite.url, { waitUntil: 'load', timeout: 60000 });
    await site.bringToFront();

    const gal = await ctx.newPage();
    await gal.goto(`chrome-extension://${extId}/popup/popup.html?mode=page`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    // 等图铺出来（有卡片 = 扫描完成）
    await gal.waitForFunction(
      () => document.querySelectorAll('#grid .card').length > 0,
      { timeout: 30000 }
    ).catch(() => {});
    await sleep(600);

    /* ---------- 1. 六个动作全部常驻 ---------- */
    console.log('\n=== 1. 顶栏动作全部常驻（没有溢出菜单）===');
    const icons = await topIcons(gal);
    console.log('  可见常驻 =', JSON.stringify(icons.ids), '｜ 隐藏 =', JSON.stringify(icons.hiddenIds));
    check(icons.ids.join(',') === EXPECTED_VISIBLE.join(','),
      '可见常驻正好是这 6 个、且顺序未变：' + EXPECTED_VISIBLE.join(' / '),
      JSON.stringify(icons.ids));
    check(icons.allIds.join(',') === EXPECTED_TOP_IDS.join(','),
      '顶栏 DOM 里正好 7 个按钮（含独立页不显示的关闭）',
      JSON.stringify(icons.allIds));
    check(icons.hiddenIds.length === 1 && icons.hiddenIds[0] === 'btnClose',
      '唯一不显示的是「关闭面板」（panel-only，独立页里本就不该出现）',
      JSON.stringify(icons.hiddenIds));

    const st0 = await state(gal);
    check(st0.hasMenu === false, '页面里没有溢出菜单的残留（.menu / #moreMenu）', String(st0.hasMenu));
    check(st0.hasMoreBtn === false, '页面里没有「更多」按钮（#btnMoreMenu）', String(st0.hasMoreBtn));

    /* ---------- 2. 不同功能的图标不许雷同 ---------- */
    console.log('\n=== 2. 图标区分度（不同功能不要用同一个图标）===');
    console.log('  指纹：');
    for (const [id, p] of Object.entries(icons.prints)) {
      console.log('    ' + id.padEnd(14) + ' ' + (p ? p.slice(0, 78) + (p.length > 78 ? '…' : '') : '(无)'));
    }
    const dupes = collidingIconPairs(icons.prints);
    check(dupes.length === 0,
      '没有两个按钮共用同一个图标（路径指纹全不同）',
      dupes.map((d) => d.join(' == ')).join('；'));

    /* 「导出清单」和「保存到本地」原来用的是**同一条 path**（都是「下箭头 + 托盘」），
       是这一轮重点消灭的一对。btnSave 在底栏、不在 .hdr-actions 里，
       所以要单独把它捞出来比。 */
    const savePrint = await gal.evaluate(() => {
      const b = document.getElementById('btnSave');
      if (!b) return null;
      const svg = b.querySelector('svg');
      if (!svg) return null;
      return Array.from(svg.querySelectorAll('path, rect, circle, line, polyline, polygon'))
        .map((s) => s.tagName.toLowerCase() + ':' + ['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r']
          .map((a) => s.getAttribute(a)).filter((v) => v != null)
          .map((v) => v.replace(/\s+/g, ' ').trim()).join(','))
        .join('|');
    });
    console.log('    btnSave        ' + (savePrint ? savePrint.slice(0, 78) + '…' : '(无)'));
    check(savePrint && icons.prints.btnExport && savePrint !== icons.prints.btnExport,
      '「导出清单」不再是「保存到本地」的下载箭头',
      'save=' + (savePrint || '').slice(0, 40));

    /* 「深度嗅探」的图标应该带页面轮廓（rect），不是单纯的箭头 */
    check(icons.prints.btnDeep && /^rect:/.test(icons.prints.btnDeep),
      '「深度嗅探」是「页面 + 向下箭头」（以 rect 打头），不是裸的下载箭头',
      (icons.prints.btnDeep || '').slice(0, 40));

    /* ---------- 3. 三条动作确实接了线（搬 DOM 不搬 handler 会静默失效） ---------- */
    console.log('\n=== 3. 三个按钮都接着 handler ===');
    /* 「事件绑上了没」的可观测证据：toast 文案变了。
       为什么不用「按钮进 busy 态」：probeSizes 在「已经全探过」时会
       early-return 并吐一句「没有可探测的」—— 那时按钮确实进不了 busy，
       于是断言会失败在一个**行为正确**的实现上（假红）。
       而 toast 无论走哪条分支都会变，是「handler 真的跑了」的稳定证据。 */
    const toastText = () => gal.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
    const before = await toastText();
    await gal.click('#btnProbe');
    await sleep(900);
    const after = await toastText();
    console.log('  toast: ' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
    check(after && after !== before,
      '「探测体积」点下去真的跑了 handler（toast 文案变了）', JSON.stringify(after));

    // 等探测结束，别把它留在 busy 影响后面
    await gal.waitForFunction(
      () => document.getElementById('btnProbe').getAttribute('aria-disabled') !== 'true',
      { timeout: 20000 }
    ).catch(() => {});

    /* 导出：点下去应该触发一次下载（清单 JSON） */
    const dl = await Promise.all([
      gal.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      gal.click('#btnExport')
    ]).then((r) => r[0]);
    check(!!dl, '「导出清单」点下去真的触发下载（事件绑上了）',
      dl ? dl.suggestedFilename() : 'no download');

    /* 深度嗅探：点下去会进 loading（滚动整页要十几秒）。
       只用「loading 文案变成深度嗅探的进度」当证据 —— 那是它独有的通路。 */
    await gal.click('#btnDeep');
    let deepRan = false;
    try {
      await gal.waitForFunction(
        () => /正在深度嗅探/.test(document.getElementById('loadingText').textContent),
        { timeout: 12000 }
      );
      deepRan = true;
    } catch (e) { /* 下面统一断言 */ }
    check(deepRan, '「深度嗅探」点下去进了它的滚动进度（事件绑上了）');

    /* ---------- 4. 筛选条默认收起 ---------- */
    console.log('\n=== 4. 筛选条默认收起 ===');
    // 深度嗅探还在跑，等它安静下来再读状态
    await gal.waitForFunction(
      () => document.getElementById('loading').hidden === true,
      { timeout: 120000 }
    ).catch(() => {});
    await sleep(500);
    let st = await state(gal);
    console.log('  筛选条 =', JSON.stringify({
      hidden: st.filtersHidden, expanded: st.filtersExpanded, on: st.filtersOn
    }));
    check(st.filtersHidden === true, '筛选条默认是隐藏的', String(st.filtersHidden));
    check(st.filtersExpanded === 'false', '「筛选」按钮 aria-expanded=false（和 hidden 一致）', String(st.filtersExpanded));

    /* 点开 */
    await gal.click('#btnFilters');
    await sleep(400);
    st = await state(gal);
    check(st.filtersHidden === false, '点「筛选」后展开', String(st.filtersHidden));
    check(st.filtersExpanded === 'true', 'aria-expanded 变成 true', String(st.filtersExpanded));
    const chipsVisible = await gal.evaluate(() => {
      const box = document.getElementById('filterPanel');
      return !!box && box.offsetHeight > 0;
    });
    check(chipsVisible, '展开后筛选条真的占了高度（不是 hidden=false 但高 0）', String(chipsVisible));

    /* 收起 */
    await gal.click('#btnFilters');
    await sleep(400);
    st = await state(gal);
    check(st.filtersHidden === true, '再点收起', String(st.filtersHidden));

    /* ---------- 5. 有筛选时按钮要「看得出来在筛」 ---------- */
    console.log('\n=== 5. 收起后仍能看出「正在筛」 ===');
    /* 先确保起点干净：展开筛选条 → 点「重置」。不能假设「刚进来就没筛」——
       滑条值是从 storage 里读回来的（上一轮跑这个套件留下的 256 之外的
       值会带进来），深嗅探也可能改过别的状态。 */
    await gal.click('#btnFilters');
    await sleep(400);
    await gal.click('#btnResetFilters');
    await sleep(900);
    await gal.click('#btnFilters');
    await sleep(400);

    let badge = await state(gal);
    check(badge.filtersOn === false, '没筛时按钮不常亮', String(badge.filtersOn));
    check(badge.filterBadgeHidden === true, '没筛时数量角标是隐藏的', String(badge.filterBadgeHidden));

    // 展开 → 点一个格式 chip（PNG）→ 收起
    await gal.click('#btnFilters');
    await sleep(400);
    const clicked = await gal.evaluate(() => {
      const box = document.getElementById('typeChips');
      if (!box) return false;
      const chip = Array.from(box.querySelectorAll('.chip')).find((c) => !c.classList.contains('active'));
      if (chip) { chip.click(); return true; }
      return false;
    });
    check(clicked, '（前提）筛选条里点中了一个未选中的格式 chip', String(clicked));
    await sleep(500);
    await gal.click('#btnFilters');
    await sleep(400);
    badge = await state(gal);
    console.log('  筛选后 =', JSON.stringify({
      on: badge.filtersOn, hidden: badge.filterBadgeHidden, n: badge.filterBadge
    }));
    check(badge.filtersHidden === true, '（前提）此时筛选条是收起的', String(badge.filtersHidden));
    check(badge.filtersOn === true, '有生效条件时「筛选」按钮常亮', String(badge.filtersOn));
    check(badge.filterBadgeHidden === false, '有生效条件时数量角标显示出来', String(badge.filterBadgeHidden));
    check(Number(badge.filterBadge) >= 1, '角标里的数字 >= 1', badge.filterBadge);

    /* ---------- 6. 窄栏（380px）下顶栏不溢出 ---------- */
    console.log('\n=== 6. 窄栏 380px 下不溢出（顶栏 + 工具行） ===');
    /* 为什么不用 ?mode=panel 开一个真面板：面板模式要求一个由后台签发、
       与当前标签页绑定的 token（verifyPanelOrigin → MSG.PANEL_VERIFY），
       直接开链接会被判为「不可信嵌入」并把界面清空 —— 那样连顶栏按钮
       都找不到，测的是「拒绝逻辑」而不是布局。
       面板真正要验的只是**宽度**：把同一个图库页压到 380px 即可。
       （顶栏结构两种模式完全一样，区别只在 body 的 class。） */
    const narrow = await ctx.newPage();
    await narrow.setViewportSize({ width: 380, height: 900 });
    await narrow.goto(`chrome-extension://${extId}/popup/popup.html?mode=page`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(1500);
    /* **必须把筛选条展开**再量。收起时工具行只有搜索 / 筛选 / 排序 / 滑条，
       压力太小 —— 我看截图发现问题时正是展开态（面板模式默认收起，
       截图脚本为了看「最挤的布局」手动点开了它）。
       展开态会把尺寸 / 比例 / 格式 / 来源 / 其他五排 chips 全铺出来，
       那才是真正的窄栏极限。 */
    await narrow.evaluate(() => {
      const p = document.getElementById('filterPanel');
      if (p && p.hidden) document.getElementById('btnFilters').click();
    });
    await sleep(500);
    const narrowIcons = await topIcons(narrow);
    check(narrowIcons && narrowIcons.ids.join(',') === EXPECTED_VISIBLE.join(','),
      '380px 下顶栏仍是同样 6 个常驻（媒体查询没有把任何一个藏起来）',
      narrowIcons && JSON.stringify(narrowIcons.ids));
    check(narrowIcons && narrowIcons.hiddenIds.length === 1 && narrowIcons.hiddenIds[0] === 'btnClose',
      '380px 下被藏起来的仍然只有「关闭面板」',
      narrowIcons && JSON.stringify(narrowIcons.hiddenIds));

    const narrowSt = await state(narrow);
    console.log('  按钮尺寸 =', narrowSt.lastBtnW, '｜ 最后一个按钮右缘 =', narrowSt.lastRight,
      '｜ 工具行 =', narrowSt.barScrollW + ' / ' + narrowSt.barClientW,
      '｜ 整页 =', narrowSt.docScrollW + ' / ' + narrowSt.viewportW);

    /* 「有没有溢出」的两个真信号。
       第一版这里断言的是 `.hdr-actions` 的 scrollWidth <= clientWidth ——
       **那是错的观测点**：`.hdr-actions` 有 margin-left:auto、在 flex 行里
       会被压缩到内容宽度，于是 scrollWidth 恒等于 clientWidth，
       无论里面塞了多少东西都是绿的。注入「删掉窄栏媒体查询」时它照样全绿，
       而真正的症状在别处：`.ctrl-bar` 的 scrollWidth 冲到 780px、
       整页多出一条横向滚动条。所以改看这两个：
       ① 工具行自身有没有被撑开；② 整页有没有横向滚动。 */
    check(narrowSt.barScrollW != null && narrowSt.barScrollW <= narrowSt.barClientW + 1,
      '工具行没有被撑开（scrollWidth <= clientWidth —— 滑条在窄栏里换行）',
      narrowSt.barScrollW + ' vs ' + narrowSt.barClientW);
    check(narrowSt.docScrollW <= narrowSt.viewportW + 1,
      '整页没有横向滚动条（documentElement.scrollWidth <= 视口宽）',
      narrowSt.docScrollW + ' vs ' + narrowSt.viewportW);
    check(narrowSt.lastRight != null && narrowSt.lastRight <= narrowSt.viewportW,
      '顶栏最后一个按钮没有跑出视口右缘',
      narrowSt.lastRight + ' vs ' + narrowSt.viewportW);
    check(narrowSt.filtersHidden === false, '（前提）窄栏下筛选条已展开（量的是最挤的布局）',
      String(narrowSt.filtersHidden));
    check(narrowSt.hasMenu === false, '窄栏下也没有溢出菜单的残留', String(narrowSt.hasMenu));

    /* ── 底栏「保存选中」：这里守的是**真折行** ───────────────────────
       面板底栏只有 ~340px 宽，左边挤着 `.sum`（「共 N 张 · 符合 N ·
       已选 N · 合计 X MB」，深度嗅探还会往里面加一句「已达滚动上限」的
       长提示），右边是「保存选中 N」。`.sum` 是 `flex: 1 1 auto`，
       `flex-basis: auto` 时它按**内容宽度**抢地方，于是按钮被压到 90px、
       文字折行。repair 是三条：`.sum { flex-basis: 0 }` 让它肯让位、
       `button.primary { white-space: nowrap; flex: 0 0 auto }` 让它保住宽度。

       **判据必须看 `scrollHeight`，不能看 `getBoundingClientRect().height`。**
       这是本轮踩的第三个假绿：`.ftr-main` 是 `align-items: center` 的 flex 行，
       行高由最高的那个子元素决定，按钮被压扁时**行会把按钮的高度钉在 34px**，
       `rect.height` 永远是 34 —— 写 `h <= 44` 的断言在缺陷态下照样绿。
       而内容真的折了行时，`scrollHeight`（49）会超过 `clientHeight`（34）。
       注入验证：摘掉那三条 CSS → 这条断言红（49 vs 34）；
       还原 → 绿（34 vs 34）。

       注意**不要照空态截图判断**：尺寸过滤把卡片清空时 `.sum` 很短、
       按钮只有 90px 宽，那是正常的单行窄按钮，不是折行。
       所以在这里测必须让 `.sum` 带上长文本（本套件的第 1~5 节会留下
       深度嗅探的「滚动上限」提示，正好构造出这个最坏情况）。 */
    const saveBtn = await narrow.evaluate(() => {
      const b = document.getElementById('btnSave');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const s = document.querySelector('.sum');
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        // 内容行盒有没有超出被 flex 行强制的高度 —— 只有它真能反映折行
        scrollH: b.scrollHeight, clientH: b.clientHeight,
        // 留一份 .sum 的现场，方便日后理解「按钮为什么被压窄」
        sumW: s ? Math.round(s.getBoundingClientRect().width) : null,
        sumTxt: s ? s.innerText.replace(/\s+/g, ' ').trim().slice(0, 46) : null,
        text: b.textContent.replace(/\s+/g, ' ').trim(),
      };
    });
    console.log('  「保存选中」=', JSON.stringify(saveBtn));
    check(saveBtn && saveBtn.text.length > 0,
      '窄栏下底栏「保存选中」按钮渲染出来了、文案没丢', saveBtn && saveBtn.text);
    check(saveBtn && saveBtn.scrollH <= saveBtn.clientH + 1,
      '窄栏下「保存选中」没有被统计文字挤到折行（scrollHeight 没超过被强制的高度）',
      saveBtn && (saveBtn.scrollH + ' vs ' + saveBtn.clientH));
    check(saveBtn && saveBtn.w >= 70,
      '窄栏下「保存选中」仍保有可读宽度（没有被 .sum 按内容宽度抢走）',
      saveBtn && (saveBtn.w + 'px'));

  } finally {
    await ctx.close();
    await localSite.close();
  }

  console.log('\n-----------------------------');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('套件崩溃：', e);
  process.exit(1);
});
