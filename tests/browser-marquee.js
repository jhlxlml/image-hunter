/* ImageHunter — 真实浏览器：图库「框选」与「默认不勾选」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 * 自建一个本地 HTTP 页面（48 张真实 PNG），不依赖外网，结果稳定可复现。
 *
 * 覆盖：
 *   - 打开图库后默认不勾选任何图片
 *   - 在网格中按住鼠标拖出矩形 → 框内已勾选的取消、未勾选的勾上（切换语义）
 *   - 多次框选不同区域 = 累加；框回已选区域 = 取消
 *   - 拖拽过程中遮罩层可见，且实时显示命中数量
 *   - Ctrl 拖拽 = 只加，Alt 拖拽 = 只减
 *   - 框选结束后紧接着的 click 不会把卡片点反
 *   - 单击 / 全选 不再重建网格（滚动位置不弹回顶部）
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
const PROFILE = path.join(os.tmpdir(), 'ih-marquee-profile-' + Date.now());

const SITE_OPTS = { cols: 8, rows: 6, imgW: 600, imgH: 400 };   // 测试页：每行 8 张、共 6 行
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

/** 取第 i 张卡片的 client 矩形（i 按 DOM 顺序） */
async function cardRect(page, i) {
  return page.evaluate((idx) => {
    const cards = document.querySelectorAll('#grid .card');
    const r = cards[idx].getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  }, i);
}

async function selectedCount(page) {
  return page.evaluate(() => document.querySelectorAll('#grid .card.selected').length);
}

async function statSelected(page) {
  return page.evaluate(() => document.getElementById('statSelected').textContent);
}

async function clearSelection(page) {
  await page.evaluate(() => document.getElementById('btnClear').click());
  await sleep(120);
}

/** 单击第 i 张卡片。
 *  先把卡片滚到「sticky 顶栏下方」的可视区里——顶栏盖住的卡片点下去会打到顶栏按钮上。 */
async function clickCard(page, i) {
  const r = await page.evaluate((idx) => {
    const c = document.querySelectorAll('#grid .card')[idx];
    const bar = document.querySelector('.topbar');
    const barH = bar ? bar.getBoundingClientRect().bottom : 0;
    let rect = c.getBoundingClientRect();
    const cy = rect.top + rect.height / 2;
    if (cy < barH + 6 || cy > window.innerHeight - 6) {
      const want = barH + (window.innerHeight - barH) / 2;
      window.scrollBy(0, cy - want);
      rect = c.getBoundingClientRect();
    }
    return { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
  }, i);
  await sleep(120);
  await page.mouse.click(Math.round(r.left + r.w / 2), Math.round(r.top + r.h / 2));
  await sleep(120);
}

/**
 * 在网格上拖出一个矩形。
 * @param {object} o  {from:{x,y}, to:{x,y}, modifier:'Control'|'Alt'|null, release:boolean, onMid:fn}
 */
async function marqueeDrag(page, o) {
  const steps = o.steps || 14;
  if (o.modifier) await page.keyboard.down(o.modifier);
  await page.mouse.move(o.from.x, o.from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      o.from.x + (o.to.x - o.from.x) * i / steps,
      o.from.y + (o.to.y - o.from.y) * i / steps
    );
  }
  const mid = o.onMid ? await o.onMid() : null;
  if (o.release !== false) await page.mouse.up();
  if (o.modifier) await page.keyboard.up(o.modifier);
  return mid;
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
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
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
  await sleep(4000);   // 等扫描 + 渲染完成

  // 注意：这里**故意不**把图库标签页切到前台。
  // 后台标签页里 Chrome 会把 setTimeout 节流到至少 1 秒，
  // 正好用来守住「框选后那次合成 click 的拦截不能依赖定时器」这条底线
  // （早期用 `标志位 + setTimeout(0)` 实现，在这里就会漏吞掉真实点击）。
  check(true, '图库保持后台标签页运行（用于暴露定时器节流问题）');

  const basic = await gallery.evaluate(() => ({
    mode: document.body.className,
    total: document.getElementById('statTotal').textContent,
    cards: document.querySelectorAll('#grid .card').length,
    selected: document.querySelectorAll('#grid .card.selected').length
  }));
  console.log(JSON.stringify(basic));
  check(basic.mode.indexOf('mode-page') >= 0, '图库处于独立页模式');
  check(Number(basic.total) >= TOTAL, '嗅探到 ' + TOTAL + ' 张图片', basic.total);
  check(basic.cards >= TOTAL, '网格渲染出全部卡片', basic.cards + ' 个');

  /* ---------- 2. 默认不勾选 ---------- */
  console.log('\n=== 2. 打开后默认不勾选 ===');
  check(basic.selected === 0, '没有任何卡片处于选中态', basic.selected + ' 个');
  check(await statSelected(gallery) === '0', '「已勾选」统计为 0');
  const saveDisabled = await gallery.evaluate(() => document.getElementById('btnSave').disabled);
  check(saveDisabled === true, '「保存选中」按钮为禁用态');
  const hint = await gallery.evaluate(() => document.getElementById('ftrHint').textContent);
  check(/框选/.test(hint), '底部提示里说明了框选用法', hint);

  await gallery.waitForTimeout(400);   // 等卡片入场动画结束，矩形测量才稳定

  // 图库栅格列数由容器宽度决定（auto-fill + minmax），不能假设与测试页一致，实测第一行有几张
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

  /** 取覆盖第 row 行前 n 张卡片的拖拽矩形（四边都留在 gap 里，结果确定） */
  async function rowBox(row, n) {
    const first = await cardRect(gallery, row * cols);
    const last = await cardRect(gallery, row * cols + (n - 1));
    return {
      from: { x: Math.round(first.left - 10), y: Math.round(first.top - 10) },
      to: { x: Math.round(last.right + 5), y: Math.round(last.bottom + 5) }
    };
  }

  /* ---------- 3. 拖拽框选第一行的前 5 张 ---------- */
  console.log('\n=== 3. 框选第一行前 5 张 ===');
  const c0 = await cardRect(gallery, 0);
  const c4 = await cardRect(gallery, 4);
  const box = {
    from: { x: Math.round(c0.left - 10), y: Math.round(c0.top - 10) },
    to: { x: Math.round(c4.right + 5), y: Math.round(c4.bottom + 5) }
  };
  console.log('拖拽 ' + JSON.stringify(box.from) + ' → ' + JSON.stringify(box.to));

  const midInfo = await marqueeDrag(gallery, {
    ...box,
    onMid: () => gallery.evaluate(() => {
      const mq = document.getElementById('marquee');
      const r = mq.getBoundingClientRect();
      return {
        hidden: mq.hidden,
        w: Math.round(r.width),
        h: Math.round(r.height),
        label: document.getElementById('mqCount').textContent,
        mode: mq.dataset.mode,
        bodySelecting: document.body.classList.contains('ih-selecting')
      };
    })
  });

  console.log('拖拽中: ' + JSON.stringify(midInfo));
  check(midInfo.hidden === false, '拖拽过程中遮罩层可见');
  check(midInfo.w > 100 && midInfo.h >= 100, '遮罩层尺寸跟随鼠标', midInfo.w + '×' + midInfo.h);
  check(midInfo.bodySelecting === true, '拖拽期间全局禁用了文字选择');
  check(midInfo.mode === 'toggle', '默认拖拽进入「切换」模式', midInfo.mode);
  check(/5$/.test(midInfo.label), '遮罩层角标实时显示命中 5 张', midInfo.label);

  const after = await selectedCount(gallery);
  check(after === 5, '松手后恰好选中 5 张卡片', after + ' 张');
  check(await statSelected(gallery) === '5', '「已勾选」统计更新为 5');
  const saveEnabled = await gallery.evaluate(() => !document.getElementById('btnSave').disabled);
  check(saveEnabled, '「保存选中」按钮变为可用');

  const mqHidden = await gallery.evaluate(() => document.getElementById('marquee').hidden);
  check(mqHidden === true, '松手后遮罩层隐藏');
  const selectingGone = await gallery.evaluate(() => !document.body.classList.contains('ih-selecting'));
  check(selectingGone, '松手后恢复正常光标');

  /* ---------- 4. 框选结束后紧接着的 click 不应反转选择 ---------- */
  console.log('\n=== 4. 框选后的 click 不误伤 ===');
  await sleep(120);
  const stillFive = await selectedCount(gallery);
  check(stillFive === 5, '框选结果没有被随后的 click 破坏', stillFive + ' 张');

  /* ---------- 4b. 切换语义：再框同一区域 = 取消 ---------- */
  console.log('\n=== 4b. 再框同一区域 → 取消 ===');
  const reMid = await marqueeDrag(gallery, {
    ...box,
    onMid: () => gallery.evaluate(() => ({
      mode: document.getElementById('marquee').dataset.mode,
      label: document.getElementById('mqCount').textContent
    }))
  });
  console.log('拖拽中: ' + JSON.stringify(reMid));
  check(reMid.mode === 'toggle', '仍是「切换」模式', reMid.mode);
  check(reMid.label === '0', '拖拽中角标实时归零', reMid.label);
  check(await selectedCount(gallery) === 0, '再框同一区域 → 5 张全部取消', await selectedCount(gallery));
  check(await statSelected(gallery) === '0', '「已勾选」回到 0');

  await marqueeDrag(gallery, box);
  check(await selectedCount(gallery) === 5, '第三次框选 → 又全部选回来', await selectedCount(gallery));

  /* ---------- 4c. 框内「已选 + 未选」混合：各自翻转 ---------- */
  console.log('\n=== 4c. 混合区域各自翻转 ===');
  await clearSelection(gallery);
  await clickCard(gallery, 0);
  await clickCard(gallery, 1);
  check(await selectedCount(gallery) === 2, '先单击选中前 2 张', await selectedCount(gallery));
  await marqueeDrag(gallery, box);   // 覆盖第 1~5 张
  const mixed = await selectedCount(gallery);
  check(mixed === 3, '框内已选的 2 张取消、未选的 3 张勾上 → 剩 3 张', mixed + ' 张');
  const mixedIdx = await gallery.evaluate(() =>
    Array.from(document.querySelectorAll('#grid .card')).reduce((acc, c, i) => {
      if (c.classList.contains('selected')) acc.push(i);
      return acc;
    }, []));
  console.log('仍选中的卡片序号: ' + JSON.stringify(mixedIdx));
  check(JSON.stringify(mixedIdx) === '[2,3,4]', '翻转结果精确落在第 3~5 张上', JSON.stringify(mixedIdx));

  /* ---------- 4d. 多次框选不同区域 = 累加 ---------- */
  console.log('\n=== 4d. 多次框选不同区域累加 ===');
  await clearSelection(gallery);
  await marqueeDrag(gallery, box);            // 第 1 行前 5 张
  check(await selectedCount(gallery) === 5, '第一次框选 → 5 张', await selectedCount(gallery));
  const boxRow2 = await rowBox(1, 5);         // 第 2 行前 5 张
  await marqueeDrag(gallery, boxRow2);
  const acc = await selectedCount(gallery);
  check(acc === 10, '第二次框选另一区域 → 累加到 10 张', acc + ' 张');

  // 复位到 5 张，供后续用例
  await clearSelection(gallery);
  await marqueeDrag(gallery, box);
  check(await selectedCount(gallery) === 5, '复位为 5 张', await selectedCount(gallery));

  /* ---------- 5. 单击仍然正常 ---------- */
  console.log('\n=== 5. 单击切换单张 ===');
  const c9 = await cardRect(gallery, 9);
  await gallery.mouse.click(Math.round(c9.left + c9.w / 2), Math.round(c9.top + c9.h / 2));
  await sleep(150);
  check(await selectedCount(gallery) === 6, '单击第 10 张后共选中 6 张', await selectedCount(gallery));
  await gallery.mouse.click(Math.round(c9.left + c9.w / 2), Math.round(c9.top + c9.h / 2));
  await sleep(150);
  check(await selectedCount(gallery) === 5, '再单击一次取消，回到 5 张', await selectedCount(gallery));

  /* ---------- 6. Ctrl 拖拽 = 只加 ---------- */
  console.log('\n=== 6. Ctrl 拖拽只加 ===');
  const box2 = await rowBox(1, 3);            // 第 2 行前 3 张
  const midAdd = await marqueeDrag(gallery, {
    ...box2, modifier: 'Control',
    onMid: () => gallery.evaluate(() => ({
      mode: document.getElementById('marquee').dataset.mode,
      label: document.getElementById('mqCount').textContent
    }))
  });
  console.log('拖拽中: ' + JSON.stringify(midAdd));
  check(midAdd.mode === 'add', '遮罩层进入「追加」模式');
  check(await selectedCount(gallery) === 8, 'Ctrl 拖拽后 5 + 3 = 8 张', await selectedCount(gallery));

  /* ---------- 7. Alt 拖拽 = 减选 ---------- */
  console.log('\n=== 7. Alt 拖拽减选 ===');
  const midSub = await marqueeDrag(gallery, {
    ...box2, modifier: 'Alt',
    onMid: () => gallery.evaluate(() => ({
      mode: document.getElementById('marquee').dataset.mode,
      label: document.getElementById('mqCount').textContent
    }))
  });
  console.log('拖拽中: ' + JSON.stringify(midSub));
  check(midSub.mode === 'sub', '遮罩层进入「减选」模式');
  check(await selectedCount(gallery) === 5, 'Alt 拖拽后 8 - 3 = 5 张', await selectedCount(gallery));

  /* ---------- 8. Esc 放弃框选 ---------- */
  console.log('\n=== 8. 拖拽中按 Esc 放弃 ===');
  await marqueeDrag(gallery, {
    ...box2,
    release: false,
    onMid: async () => {
      await gallery.keyboard.press('Escape');
      await sleep(80);
      return gallery.evaluate(() => ({
        hidden: document.getElementById('marquee').hidden,
        selected: document.querySelectorAll('#grid .card.selected').length
      }));
    }
  });
  await gallery.mouse.up();
  await sleep(150);
  const afterEsc = await gallery.evaluate(() => ({
    hidden: document.getElementById('marquee').hidden,
    selected: document.querySelectorAll('#grid .card.selected').length
  }));
  console.log(JSON.stringify(afterEsc));
  check(afterEsc.hidden === true, 'Esc 后遮罩层收起');
  check(afterEsc.selected === 5, 'Esc 放弃框选，选择保持原样 5 张', afterEsc.selected + ' 张');

  /* ---------- 9. 单击不重建网格（滚动位置不丢） ---------- */
  console.log('\n=== 9. 单击不重建网格 ===');
  await gallery.evaluate(() => window.scrollTo(0, 900));
  await sleep(250);
  const y1 = await gallery.evaluate(() => Math.round(window.scrollY));

  // ⚠️ 必须挑一张**真正露在可视区里**的卡片。
  // 顶栏是 sticky 的，被它盖住的卡片点下去会打到顶栏按钮上（曾经因此误点「重新嗅探」，
  // 触发重新扫描把网格清空，测试以奇怪的方式失败）。
  const target = await gallery.evaluate(() => {
    const bar = document.querySelector('.topbar');
    const minY = (bar ? bar.getBoundingClientRect().bottom : 0) + 6;
    const cards = document.querySelectorAll('#grid .card');
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const cy = r.top + r.height / 2;
      if (cy > minY && cy < window.innerHeight - 6) {
        return { i, x: Math.round(r.left + r.width / 2), y: Math.round(cy) };
      }
    }
    return null;
  });
  check(target !== null, '滚动后能找到一张露在可视区里的卡片', JSON.stringify(target));

  await gallery.mouse.click(target.x, target.y);
  await sleep(250);
  const y2 = await gallery.evaluate(() => Math.round(window.scrollY));
  const domCount = await gallery.evaluate(() => document.querySelectorAll('#grid .card').length);
  console.log('scrollY: ' + y1 + ' → ' + y2 + '，卡片数 ' + domCount + '（点的第 ' + target.i + ' 张）');
  check(Math.abs(y2 - y1) <= 2, '单击后滚动位置没有弹回顶部', y1 + ' → ' + y2);
  check(domCount >= TOTAL, '卡片 DOM 没有被重建丢弃', domCount + ' 个');

  /* ---------- 10. 框选可以命中多行 ---------- */
  console.log('\n=== 10. 跨多行框选 ===');
  await gallery.evaluate(() => window.scrollTo(0, 0));
  await clearSelection(gallery);

  const a = await cardRect(gallery, 0);
  const last = await cardRect(gallery, cols * 2 + (cols - 1));   // 第三行最后一张
  const box3 = {
    from: { x: Math.round(a.left - 10), y: Math.round(a.top - 10) },
    to: { x: Math.round(last.right + 5), y: Math.round(last.bottom + 5) }
  };
  await marqueeDrag(gallery, box3);
  await sleep(200);
  const multi = await selectedCount(gallery);
  console.log('跨行框选结果 =', multi);
  check(multi === cols * 3, '跨 3 行框选命中 ' + (cols * 3) + ' 张', multi + ' 张');

  await marqueeDrag(gallery, box3);
  await sleep(200);
  const multiOff = await selectedCount(gallery);
  check(multiOff === 0, '再框同一大区域 → 全部取消', multiOff + ' 张');

  /* ---------- 11. 清空按钮 ---------- */
  console.log('\n=== 11. 清空按钮 ===');
  await marqueeDrag(gallery, box);
  check(await selectedCount(gallery) === 5, '先框选 5 张', await selectedCount(gallery));
  await gallery.evaluate(() => document.getElementById('btnClear').click());
  await sleep(150);
  check(await selectedCount(gallery) === 0, '「清空」后无选中卡片', await selectedCount(gallery));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await ctx.close();
  localSite.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
