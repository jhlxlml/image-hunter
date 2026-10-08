/* ImageHunter — 给图库界面截图（真实浏览器，便于 UI 迭代时看效果）
 *
 * 依赖与用法同 browser-e2e.js。
 * 用法： NODE_PATH=<node_modules> node tests/screenshot.js [目标页面URL] [输出路径]
 *
 * 不传目标页面时，起一个本地图片站（48 张 PNG），保证栅格布局稳定、截图可复现。
 *
 * 会输出十一张（默认全部落在 `docs/screenshots/`，可通过第二个参数改目录）：
 *   1) 输出路径（默认 docs/screenshots/gallery-preview.png）—— 图库常态（筛选条展开、无生效条件）
 *   2) 同目录 gallery-filters.png       —— 搜索框展开 + 有生效条件的激活态
 *   3) 同目录 gallery-panel.png         —— 页内面板模式（380px 窄屏，最挤的情况）
 *                                          走内容脚本真领 token 那条路拿 iframe，
 *                                          拿不到网格会打印「⚠ 拒绝页」而不是假装成功
 *   4) 同目录 gallery-marquee.png       —— 鼠标拖拽框选进行中
 *   5) 同目录 gallery-lightbox.png      —— 图库页内打开的大图预览灯箱（v1.7.0）
 *   6) 同目录 hover-buttons.png         —— 网页图片右上角的「预览 + 下载」两个按钮（v1.7.0）
 *   7) 同目录 gallery-restore.png       —— 没还原成功的卡片右下角的「还原」按钮（v1.7.1）
 *   8) 同目录 options-page.png          —— 设置页（含「站点排除列表」与「保存到子目录」，v1.7.2）
 *   9) 同目录 lightbox-content.png      —— **网页里**打开的灯箱，顶栏带「在图库中打开」（v1.8.0）
 *  10) 同目录 gallery-empty-size.png    —— 尺寸过滤把结果清空时的空态 + 一键出口（v1.11.0）
 *  11) 同目录 gallery-merge-tabs.png    —— 多标签页合并嗅探的勾选面板（v1.12.0）
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
const PROFILE = path.join(os.tmpdir(), 'ih-shot-profile-' + Date.now());
const OUT = process.argv[3] || path.resolve(__dirname, '../docs/screenshots/gallery-preview.png');
const OUT_MQ = path.join(path.dirname(OUT), 'gallery-marquee.png');
const OUT_FILTERS = path.join(path.dirname(OUT), 'gallery-filters.png');
const OUT_PANEL = path.join(path.dirname(OUT), 'gallery-panel.png');
const OUT_LB = path.join(path.dirname(OUT), 'gallery-lightbox.png');
const OUT_HOVER = path.join(path.dirname(OUT), 'hover-buttons.png');
const OUT_RESTORE = path.join(path.dirname(OUT), 'gallery-restore.png');
const OUT_OPTIONS = path.join(path.dirname(OUT), 'options-page.png');
const OUT_LB_CONTENT = path.join(path.dirname(OUT), 'lightbox-content.png');
const OUT_EMPTY = path.join(path.dirname(OUT), 'gallery-empty-size.png');
const OUT_MERGE = path.join(path.dirname(OUT), 'gallery-merge-tabs.png');
const SITE_OPTS = { cols: 8, rows: 6, imgW: 600, imgH: 400 };
const VIEW = { width: 1440, height: 940 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  // 输出目录可能还不存在（默认 docs/screenshots/，或调用方传了任意路径）——
  // 这里主动建出来，否则 playwright 会以一个不好懂的 ENOENT 结束
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  const TARGET = process.argv[2] || localSite.url;

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: VIEW.width, height: VIEW.height },
    deviceScaleFactor: 2,
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });

  const target = await ctx.newPage();
  await target.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await target.bringToFront();
  await sleep(600);

  const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await sw.evaluate(async () => { await openGallery(await pickTargetTab(null)); });
  const gallery = await galleryPromise;
  await gallery.waitForLoadState('domcontentloaded');
  await sleep(5000);

  // 第一张保持「打开后的真实默认态」——不勾选任何图片
  await gallery.screenshot({ path: OUT, fullPage: false });
  console.log('已截图 →', OUT);

  /* ---- 第二张：筛选条展开 + 搜索框展开 + 有生效条件的样式 ---- */
  // 筛选条在独立页模式默认就是展开的，这里额外演示「激活态」：
  // 打开搜索框输入 png（48 张全中，结果不空），再点一个比例 chip
  await gallery.evaluate(() => document.getElementById('btnSearch').click());
  await sleep(220);
  await gallery.evaluate(() => {
    const input = document.getElementById('search');
    input.value = 'png';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(450);
  await gallery.evaluate(() => {
    const chips = document.querySelectorAll('#aspectChips .chip');
    if (chips[1]) chips[1].click(); // 「横图」
  });
  await sleep(450);
  await gallery.screenshot({ path: OUT_FILTERS, fullPage: false });
  console.log('已截图 →', OUT_FILTERS);
  // 复位，避免影响后面的截图
  await gallery.evaluate(() => document.getElementById('btnSearchClear').click());
  await sleep(250);
  await gallery.evaluate(() => {
    const chips = document.querySelectorAll('#aspectChips .chip');
    if (chips[0]) chips[0].click(); // 「全部」
  });
  await sleep(250);

  /* ---- 第十张：尺寸过滤把结果清空时的空态 + 一键出口（v1.11.0） ----
     这一屏值得单独留一张：列表页缩略图大量在 200px 上下，而尺寸滑条默认 256px ——
     空态是很容易撞上的**第一印象**，必须能一眼看出它有没有把原因说清楚。
     本站图是 600×400，所以把滑条拖到 601（短边 400 的图全部不达标）来造出这个状态。 */
  await gallery.evaluate(() => {
    const el = document.getElementById('sizeMin');
    el.value = '601';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(700);
  await gallery.screenshot({ path: OUT_EMPTY, fullPage: false });
  console.log('已截图 →', OUT_EMPTY);
  // 点出口复位（顺带证明它真的能用），别影响后面的截图
  await gallery.evaluate(() => {
    const b = document.getElementById('emptyClearSize');
    if (b && !b.hidden) b.click();
  });
  await sleep(500);
  /* 出口必须**真的**把图放回来，而且要把清掉后的值落盘 ——
     否则页内面板那边重新拉视图状态时又会捡回旧阈值（这时面板会一张卡都没有，
     后面的面板截图就会莫名其妙地拍成空白）。这里当场断言，坏了要立刻知道。 */
  const afterExit = await gallery.evaluate(() => document.querySelectorAll('#grid .card').length);
  if (!afterExit) console.log('⚠ 点了「显示全部」之后网格还是空的 —— 出口可能没生效');
  else console.log('（尺寸空态出口已复位，网格回到 ' + afterExit + ' 张）');

  /* ---- 第三张：页内面板模式（最窄的宿主，用来确认控制区在窄屏不塌） ---- */
  /* 必须走**内容脚本领 token**那条真实路径，不能自己拼 `?mode=panel&tabId=N`
   * 直接 goto。v1.8.1 给面板加了来源校验：内容脚本向后台领一个只属于本标签页的
   * token 写进 iframe URL，popup 启动时拿它回后台核验，伪造的一律拒绝渲染。
   * 直接拼 URL 拿不到 token，截出来的是那句「已拒绝在此显示图库」—— 之前几轮
   * 这张图一直是拒绝页，等于「窄屏布局」根本没被看过（而面板模式恰恰是最挤的宿主）。
   * 正确做法：从后台发 TOGGLE_PANEL 让内容脚本去开（与 Alt+Shift+S 同一条路），
   * 再把那个带 token 的 iframe 抓出来重新打开 —— 拿到的是同一份渲染。 */
  await target.bringToFront();
  await sleep(500);
  await sw.evaluate(async (tabId) => {
    await chrome.tabs.sendMessage(tabId, { type: 'IH_TOGGLE_PANEL' }, { frameId: 0 }).catch(() => {});
  }, await gallery.evaluate(() => {
    const sel = document.getElementById('selTargetTab');
    return sel && sel.value ? Number(sel.value) : null;
  }).catch(() => null));
  await sleep(3000);
  // 面板是一个嵌在页面里的 iframe（src 指向 chrome-extension://.../popup.html?mode=panel&tabId=N&token=...）
  const panelFrame = target.frames().find((f) => /popup\.html\?.*mode=panel/.test(f.url()));
  if (panelFrame) {
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 380, height: 900 });
    // 用 iframe 的真实 URL（含 token）打开，拿到和页内面板**同一份**渲染
    await panel.goto(panelFrame.url(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);
    // 面板模式默认收起筛选条；这里展开，专门检查最挤的窄屏布局
    await panel.evaluate(() => {
      const p = document.getElementById('filterPanel');
      if (p && p.hidden) document.getElementById('btnFilters').click();
    });
    await sleep(600);
    /* 截图前先确认拿到的**不是**拒绝页。
       之前几轮这张图一直是「已拒绝在此显示图库」，而脚本照样打印「已截图」——
       等于「窄屏布局」从来没被看过。这里加一条硬检查。

       注意判据不能只看「有没有卡片」：面板会**沿用视图状态**（尺寸滑条默认 256），
       夹具短边不够时会因为尺寸过滤而一张不剩 —— 那是**正常渲染**的空态，
       不是拒绝页。所以这里按「渲染出的是哪种界面」来分：
         · 有卡片          → 正常
         · 有 #grid 或空态容器 → 正常（可能是尺寸过滤清空）
         · 只有那句拒绝文案 → 真的挂了
       （顺带修掉根因：空态那个「显示全部」按钮以前不落盘，导致面板捡到旧值。） */
    const panelState = await panel.evaluate(() => ({
      cards: document.querySelectorAll('#grid .card').length,
      hasGrid: !!document.getElementById('grid'),
      refuse: /已拒绝在此显示图库/.test(document.body.innerText || '')
    }));
    if (panelState.refuse) {
      console.log('⚠ 面板模式截到的是拒绝页（token 路径失效了）');
    } else if (!panelState.cards) {
      console.log('⚠ 面板渲染了，但一张卡片都没有（尺寸过滤把夹具全筛掉了？）');
    }
    await panel.screenshot({ path: OUT_PANEL, fullPage: false });
    console.log('已截图 →', OUT_PANEL + (panelState.refuse ? '（⚠ 拒绝页，非真实面板）' : ''));
    await panel.close();
  } else {
    console.log('拿不到页内面板 iframe（token 路径没走通），跳过面板模式截图');
  }
  await gallery.bringToFront();
  await sleep(600);

  /* ---- 第四张：框选进行中 ---- */
  const rect = await gallery.evaluate(() => {
    const cards = document.querySelectorAll('#grid .card');
    if (cards.length < 12) return null;
    const a = cards[0].getBoundingClientRect();
    const b = cards[11].getBoundingClientRect();
    return { ax: a.left, ay: a.top, bx: b.right, by: b.bottom };
  });

  if (rect) {
    await gallery.evaluate(() => document.getElementById('btnClear').click());
    await sleep(300);

    const from = { x: Math.round(rect.ax - 12), y: Math.round(rect.ay - 12) };
    const to = { x: Math.round(rect.bx + 8), y: Math.round(rect.by + 8) };
    await gallery.mouse.move(from.x, from.y);
    await gallery.mouse.down();
    for (let i = 1; i <= 16; i++) {
      await gallery.mouse.move(
        from.x + (to.x - from.x) * i / 16,
        from.y + (to.y - from.y) * i / 16
      );
      await sleep(12);
    }
    await sleep(260);
    await gallery.screenshot({ path: OUT_MQ, fullPage: false });
    await gallery.mouse.up();
    console.log('已截图 →', OUT_MQ);
  } else {
    console.log('图片太少，跳过框选截图');
  }

  /* ---- 第五张：图库页内打开的大图预览灯箱 ----
     v1.7.0 之前这张图拍不出来 —— 点放大镜会跳到原标签页，图库页里什么都没有。 */
  await gallery.evaluate(() => document.getElementById('btnClear').click());
  await sleep(300);
  await gallery.bringToFront();
  await gallery.locator('.card .zoom').first().click();
  await sleep(2500);
  await gallery.screenshot({ path: OUT_LB, fullPage: false });
  console.log('已截图 →', OUT_LB);
  await gallery.keyboard.press('Escape');
  await sleep(500);

  /* ---- 第六张：网页图片右上角的「预览 + 下载」两个按钮（局部放大，看清排布） ---- */
  await target.bringToFront();
  const box = await target.evaluate(() => {
    // 挑「完整落在视口里、面积最大」的那张 —— 本地站一屏能塞下十几张，
    // 写死宽高阈值会在栅格密集的页面上一个都选不出来
    const all = Array.from(document.images);
    let cands = all.map((im) => ({ im, r: im.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 120 && r.height >= 80 && r.top >= 40 && r.bottom <= window.innerHeight - 40);
    if (!cands.length) return null;
    // 本地站第 0 张图的颜色是 rgb(0,0,0)（纯黑），拍出来看不出内容 —— 有别的就优先别的
    if (cands.length > 1) {
      const nonBlack = cands.filter(({ im }) => im !== all[0]);
      if (nonBlack.length) cands = nonBlack;
    }
    cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    const el = cands[0].im;
    el.setAttribute('data-ih-shot', '1');
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

  if (box) {
    await target.hover('[data-ih-shot="1"]');
    await sleep(600);
    const pad = 24;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    await target.screenshot({
      path: OUT_HOVER,
      clip: {
        x, y,
        width: Math.min(box.w + pad * 2, VIEW.width - x),
        height: Math.min(box.h + pad * 2, VIEW.height - y)
      }
    });
    console.log('已截图 →', OUT_HOVER);

    /* ---- 第九张：**网页里**打开的灯箱，顶栏带「在图库中打开」（v1.8.0） ----
       悬停条上的预览键就在当前页开灯箱（不跳走），此时灯箱宿主是 'content'，
       顶栏的「在图库中打开」按钮才会显示 —— 图库页自己的灯箱是不显示它的。 */
    await target.locator('[data-ih-host] .ih-hover-preview').first().click({ force: true });
    await sleep(1800);
    await target.screenshot({ path: OUT_LB_CONTENT, fullPage: false });
    console.log('已截图 →', OUT_LB_CONTENT);
    await target.keyboard.press('Escape');
    await sleep(400);
  } else {
    console.log('页面没有合适的图片，跳过悬停按钮截图');
  }

  /* ---- 第七张：没还原成功的卡片右下角的「还原」按钮（v1.7.1） ----
     需要一个「有一半图片还原不出来」的站点：缩略图在 /thumb/、原图在 /img/，
     但后半张的 /img/ 一律 404 —— 图片本身照常显示，只是取不到更大的版本。
     按钮是悬停才浮现的，所以必须真的把鼠标移到某张卡片上再拍。 */
  const failSite = await startServer({
    cols: 6, rows: 4, imgW: 600, imgH: 400, thumbPath: true,
    candidateFail: (i) => i >= 12
  });
  const failPage = await ctx.newPage();
  await failPage.goto(failSite.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await failPage.bringToFront();
  await sleep(2500);

  await sw.evaluate(async (port) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + port + '/') >= 0);
    await openGallery(t.id);      // 复用已开着的图库标签页，并广播换目标
  }, failSite.port);

  // 等图库切到新站点、且这一轮扫描**真的结束**。
  //
  // 不能只等「有还原按钮了」—— 「先出图、后升级」会把未还原的那一版**先**铺出来，
  // 那一刻 24 张卡片**全都**有按钮（因为一张都还没还原）。必须等到状态稳定：
  // 「已还原张数 + 按钮张数」连续 1.2 秒不变，才说明还原真的跑完了。
  let btnCount = 0;
  let lastKey = '';
  let stableSince = 0;
  const WANT = failSite.total;
  for (let i = 0; i < 160; i++) {
    const s = await gallery.evaluate(() => ({
      btns: document.querySelectorAll('#grid .card .restore').length,
      restored: document.querySelectorAll('#grid .card .badge.restored').length,
      cards: document.querySelectorAll('#grid .card').length
    }));
    btnCount = s.btns;
    const key = s.cards + '/' + s.restored + '/' + s.btns;
    if (s.cards === WANT && key !== lastKey) { lastKey = key; stableSince = Date.now(); }
    else if (s.cards === WANT && Date.now() - stableSince > 1200) break;
    await sleep(150);
  }
  await gallery.bringToFront();

  if (btnCount > 0) {
    await gallery.locator('.card:has(.restore)').first().hover();
    await sleep(600);
    await gallery.screenshot({ path: OUT_RESTORE, fullPage: false });
    console.log('已截图 →', OUT_RESTORE, '（' + btnCount + ' 张卡片带「还原」按钮）');
  } else {
    console.log('没等到「还原」按钮，跳过该截图');
  }

  await failPage.close();
  await failSite.close();

  /* ---- 第八张：设置页（v1.7.2 新增「站点排除列表」与「保存到子目录」） ----
     拍的是**全新配置下的真实默认态**，不是填好示例数据的演示态 ——
     这样一眼能看出「新用户打开设置页看到的是什么」。
     顺带验证两件事：新控件确实渲染出来了；页脚版本号是从 manifest 读的（不是写死的 v—）。 */
  const extId = new URL(sw.url()).host;
  const optionsPage = await ctx.newPage();
  await optionsPage.setViewportSize({ width: 1000, height: VIEW.height });
  await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await sleep(1200);
  const ftr = await optionsPage.evaluate(() => {
    const el = document.getElementById('ftrVersion');
    return el ? el.textContent.trim() : '';
  });
  await optionsPage.screenshot({ path: OUT_OPTIONS, fullPage: true });
  console.log('已截图 →', OUT_OPTIONS, '（页脚版本：' + (ftr || '(空)') + '）');
  await optionsPage.close();

  /* ---- 第十一张：多标签页合并嗅探的勾选面板（v1.12.0） ----
     这是这一版唯一的新界面，而且**默认关** —— 不主动打开就永远看不到它。
     所以这里显式开一次开关、再开一个别的页面（否则列表里只有一行，
     完全看不出「多选」这件事），然后拍下展开的面板。
     顺带验证：改设置能**当场**切控件（不用刷新图库）。 */
  const site2 = await startServer({
    cols: 4, rows: 3, imgW: 600, imgH: 400, title: '合并截图用第二站'
  });
  const tab2 = await ctx.newPage();
  await tab2.goto(site2.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1800);

  /* 把主站页面拨到前台再开开关：图库此刻的 tabId 还指着上面那个已经关掉的
     failPage，`loadTabList()` 会因此退回后台推荐值（`lastContentTabId`）。
     这里显式指定，截图才可复现 —— 否则勾中的是哪个页面取决于谁最后被激活。 */
  await target.bringToFront();
  await sleep(900);

  await sw.evaluate(async () => { await IH.Store.updateSettings({ mergeTabs: true }); });
  await sleep(4500);

  const mergeUi = await gallery.evaluate(() => {
    const b = document.getElementById('btnTargets');
    if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    return {
      selHidden: document.getElementById('selTargetTab').hidden,
      multiVisible: !document.getElementById('targetMulti').hidden,
      rows: document.querySelectorAll('#targetsList .tm-row').length
    };
  });
  await sleep(600);
  await gallery.screenshot({ path: OUT_MERGE, fullPage: false });
  console.log('已截图 →', OUT_MERGE,
    '（多选面板 ' + mergeUi.rows + ' 行；单选下拉已隐藏=' + mergeUi.selHidden + '）');
  // 硬检查：控件真的切过来了吗 —— 别把「面板没展开」当成「截好了」
  if (!mergeUi.multiVisible || mergeUi.rows < 2) {
    console.log('  ⚠ 合并控件没有按预期出现（multiVisible=' + mergeUi.multiVisible
      + ', rows=' + mergeUi.rows + '）—— 这张图不能信');
  }
  await tab2.close();
  site2.close();

  await ctx.close();
  await localSite.close();
})().catch((e) => { console.error(e); process.exit(1); });
