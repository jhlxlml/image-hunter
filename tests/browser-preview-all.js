/* ImageHunter — 真实浏览器：悬停预览能翻【本页全部图片】
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是这个缺口：
 *   网页上点图片右上角的「大图预览」，灯箱里只有**鼠标压着的那一**张 ——
 *   左右切换键是摆设，想看下一张得退出去、再一张张点开。
 *
 * 设计取舍（用户明确选过的两条）：
 *   1. 直接用原图，宁可等一下 —— 不接受「先把页面上的缩略图铺出来、
 *      翻到一半再换成原图地址」那种「先快后好」。所以点下去要先走一轮
 *      整页嗅探（含原图还原），**但这几秒必须是看得见的等**：按钮转圈 + 气泡说明。
 *   2. 翻页范围是本页全部图片，按**页面顺序** —— 与图库同源（含背景图 / 链接等），
 *      只是排序口径换成文档顺序（图库默认按面积排，不适合翻页）。
 *
 * 覆盖：
 *   1. 点预览 → 灯箱拿到的是整份列表（不是 1 / 1），且起始下标落在鼠标压着那张
 *   2. 列表里是**还原后的原图**（thumbPath 站点：页面给 /thumb/，还原后是 /img/）
 *   3. 「下一张」/ ← → 键都能翻，翻到末尾绕回第一张
 *   4. 缩略图条铺出全部图片
 *   5. 整理期间预览键转圈 + 气泡说明（不是「点了没反应」）
 *   6. 第二次点预览仍然给出完整列表（吃扫描缓存，不重新退化为 1 张）
 *   7. 把「大图预览最小尺寸」调到大于图片尺寸 → 列表真的被过滤，
 *      且计数如实写出被挡掉的张数（这一条只能在真浏览器里验：
 *      过滤读的是扩展存储里的设置，jsdom 那边是拿桩喂进去的）
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
const PROFILE = path.join(os.tmpdir(), 'ih-preview-all-profile-' + Date.now());

const COLS = 4, ROWS = 3;
const TOTAL = COLS * ROWS;          // 12 张
const PICK = 5;                     // 悬停第 6 张（下标 5）—— 故意不挑第一张
// 让还原候选（/img/）冷加载慢下来：一来复现「要等一下」，
// 二来加载态才观察得到（0ms 就回包的话转圈一闪而过，断言恒真）
const IMG_DELAY = 300;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 网页里灯箱的状态。内容脚本跑在隔离世界，读不到 window.IH —— 只看 DOM 事实 */
const lightboxState = (target) => target.evaluate(() => {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  let host = null, lb = null;
  for (const h of hosts) {
    const el = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
    if (el) { host = h; lb = el; break; }
  }
  if (!host) return { hasLb: false };
  const sr = host.shadowRoot;
  const img = sr.querySelector('.ih-lb-img');
  const strip = sr.querySelector('.ih-lb-strip');
  return {
    hasLb: true,
    shown: lb.classList.contains('ih-show'),
    src: img ? img.getAttribute('src') : null,
    meta: (sr.querySelector('.ih-lb-meta') || {}).textContent || '',
    thumbs: strip ? Array.from(strip.querySelectorAll('.ih-lb-thumb img')).map((i) => i.getAttribute('src')) : [],
    nextDisabled: (sr.querySelector('.ih-lb-next') || {}).disabled,
    thumbCount: strip ? strip.querySelectorAll('.ih-lb-thumb').length : 0
  };
});

/** 悬停 UI 的状态（按钮在 shadow DOM 里） */
const hoverState = (target) => target.evaluate(() => {
  const h = document.querySelector('[data-ih-host]');
  const bar = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-hover');
  const pv = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-hover-preview');
  const bubble = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-bubble');
  return {
    shown: bar ? bar.classList.contains('ih-show') : false,
    busy: pv ? pv.classList.contains('ih-busy') : false,
    spinner: !!(pv && pv.querySelector('.ih-spinner')),
    bubble: bubble ? bubble.textContent : '',
    bubbleShown: bubble ? bubble.classList.contains('ih-show') : false
  };
});

const clickPreview = (target) => target.evaluate(() => {
  const h = document.querySelector('[data-ih-host]');
  const pv = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-hover-preview');
  if (!pv) return false;
  pv.click();
  return true;
});

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const site = await startServer({
    cols: COLS, rows: ROWS, imgW: 200, imgH: 150,
    thumbPath: true,        // 页面给 /thumb/，还原候选是更大的 /img/ —— 还原真的会发生
    imgDelay: IMG_DELAY,
    title: '预览连播测试页'
  });
  console.log('测试站点 =', site.url, '（' + TOTAL + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    console.log('扩展 ID =', new URL(sw.url()).host);

    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await page.bringToFront();
    await sleep(2500);   // 等内容脚本注入 + 悬停监听挂上

    /* ------------------------------------------------------------- *
     * 1. 悬停第 6 张 → 点预览
     * ------------------------------------------------------------- */
    console.log('\n=== 1. 点预览 → 拿到本页全部图片，起始落在鼠标压着那张 ===');

    await page.locator('.wrap img').nth(PICK).hover();
    await sleep(600);

    const hs = await hoverState(page);
    console.log('悬停 UI =', JSON.stringify(hs));
    check(hs.shown, '悬停后出现了「预览 + 下载」按钮');

    /* 加载态必须在**灯箱打开之前**抓到 ——
       等灯箱开了再看，转圈早就解除了，断言会恒真。
       这里点完立刻高频轮询，直到看见忙碌态或超时。 */
    const clicked = await clickPreview(page);
    check(clicked, '点到了预览键');

    let busy = null;
    for (let i = 0; i < 100; i++) {
      const s = await hoverState(page);
      if (s.busy) { busy = s; break; }
      await sleep(30);
    }
    check(!!busy, '整理本页图片期间预览键进入忙碌态（不是「点了没反应」）');
    if (busy) {
      check(busy.spinner, '忙碌态里是转圈图标');
      check(busy.bubbleShown && busy.bubble.indexOf('正在整理本页图片') >= 0,
        '气泡说清在等什么', busy.bubble);
    }

    // 等灯箱打开（整页嗅探 + 原图还原，最长给它 20 秒）
    let st = null;
    for (let i = 0; i < 200; i++) {
      st = await lightboxState(page);
      if (st.hasLb && st.shown) break;
      await sleep(100);
    }
    console.log('灯箱 =', JSON.stringify({ meta: st.meta, src: st.src, thumbCount: st.thumbCount }));

    check(st.hasLb && st.shown, '灯箱已打开');
    check(st.meta.indexOf(PICK + 1 + ' / ' + TOTAL) >= 0,
      '计数是「' + (PICK + 1) + ' / ' + TOTAL + '」—— 列表是本页全部图片，' +
      '且起始下标落在鼠标压着那张（不是 1 / 1）', st.meta);
    check(st.src && /\/img\/5\.png/.test(st.src),
      '打开的是【还原后的原图】/img/5.png，而不是页面上的 /thumb/', st.src);
    check(st.thumbCount === TOTAL, '缩略图条铺出了全部 ' + TOTAL + ' 张',
      String(st.thumbCount));
    check(st.nextDisabled === false, '「下一张」可用（按钮不再禁用）');

    /* 列表里每一张都该是还原后的原图 —— 用户选的是「直接用原图，宁可等一下」，
       拿到一列表页面缩略图就等于没兑现。 */
    const allRestored = st.thumbs.length === TOTAL
      && st.thumbs.every((u) => u && u.indexOf('/thumb/') < 0);
    check(allRestored, '整份列表都是还原后的原图地址（不含 /thumb/）',
      JSON.stringify(st.thumbs.slice(0, 3)));

    /* ------------------------------------------------------------- *
     * 2. 翻页
     * ------------------------------------------------------------- */
    console.log('\n=== 2. 翻页 ===');

    const clickLb = (act) => page.evaluate((a) => {
      const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
      for (const h of hosts) {
        const lb = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
        if (!lb) continue;
        const btn = lb.querySelector('[data-act="' + a + '"]');
        if (btn) { btn.click(); return true; }
      }
      return false;
    }, act);

    await clickLb('next');
    await sleep(400);
    st = await lightboxState(page);
    check(st.meta.indexOf((PICK + 2) + ' / ' + TOTAL) >= 0,
      '点「下一张」走到 ' + (PICK + 2) + ' / ' + TOTAL, st.meta);
    check(st.src && /\/img\/6\.png/.test(st.src), '切到了页面顺序上的下一张', st.src);

    await page.keyboard.press('ArrowLeft');
    await sleep(400);
    st = await lightboxState(page);
    check(st.src && /\/img\/5\.png/.test(st.src), '← 键退回上一张', st.src);

    // 一路翻到末尾，再往后应当绕回第一张
    for (let i = 0; i < TOTAL - PICK - 1; i++) {
      await page.keyboard.press('ArrowRight');
      await sleep(160);
    }
    st = await lightboxState(page);
    check(st.meta.indexOf(TOTAL + ' / ' + TOTAL) >= 0, '翻到了最后一张', st.meta);

    await page.keyboard.press('ArrowRight');
    await sleep(400);
    st = await lightboxState(page);
    check(st.meta.indexOf('1 / ' + TOTAL) >= 0, '最后一张再往后绕回第一张', st.meta);

    /* ------------------------------------------------------------- *
     * 3. 关掉再开一次：仍然拿整份列表（扫描缓存 / 不退化）
     * ------------------------------------------------------------- */
    console.log('\n=== 3. 再开一次：仍然是整份列表 ===');

    await page.keyboard.press('Escape');
    await sleep(600);
    st = await lightboxState(page);
    check(!st.shown, 'Esc 关闭了灯箱');

    await page.locator('.wrap img').nth(PICK).hover();
    await sleep(600);
    await clickPreview(page);

    let st2 = null;
    for (let i = 0; i < 200; i++) {
      st2 = await lightboxState(page);
      if (st2.hasLb && st2.shown) break;
      await sleep(100);
    }
    console.log('第二次 =', JSON.stringify({ meta: st2.meta, src: st2.src }));
    check(st2.hasLb && st2.shown, '第二次点预览灯箱照样打开');
    check(st2.meta.indexOf(PICK + 1 + ' / ' + TOTAL) >= 0,
      '第二次仍是整份列表且定位正确（不是退化成 1 / 1）', st2.meta);
    check(st2.src && /\/img\/5\.png/.test(st2.src), '第二次打开的还是那张原图', st2.src);

    /* ------------------------------------------------------------- *
     * 4. 把「大图预览最小尺寸」调到比图片还大 → 列表被过滤
     *
     * 测试站点的图是 200x150。阈值 120 卡在中间：短边 150 >= 120 仍然合格，
     * 所以先不急着断言「被滤掉」—— 真正要验的是**设置确实从存储读进来了、
     * 并且真的作用在灯箱列表上**。用 9999 把全部候选一次滤光，
     * 就能看到两条只有过滤生效才会出现的事实：
     *   a) meta 里出现「已按 9999px 过滤 N 张」
     *   b) 列表缩到「点的那一张」（全灭兜底：绝不弹不出来）
     * ------------------------------------------------------------- */
    console.log('\n=== 4. 大图预览最小尺寸生效（真读扩展设置）===');

    /* 上一节末尾灯箱还开着，页内宿主元素垫在图片上面，
       直接 hover 会被它挡住（Playwright 会一直重试到超时）。
       统一走这个帮手：先 Esc 收掉灯箱 → 鼠标挪到空白 → 再 hover。 */
    const reopenAt = async (n) => {
      await page.keyboard.press('Escape');
      await sleep(500);
      await page.mouse.move(2, 2);
      await sleep(200);
      await page.locator('.wrap img').nth(n).hover();
      await sleep(600);
      await clickPreview(page);
    };

    const setMin = async (v) => {
      await sw.evaluate(async (val) => {
        const cur = (await chrome.storage.local.get('ih_settings')).ih_settings || {};
        cur.lightboxMinSize = val;
        await chrome.storage.local.set({ ih_settings: cur });
      }, v);
      // 设置变更 → 内容脚本收到广播刷新缓存，给它一点时间落地
      await sleep(500);
    };

    await setMin(9999);
    await reopenAt(PICK);

    let st3 = null;
    for (let i = 0; i < 200; i++) {
      st3 = await lightboxState(page);
      if (st3.hasLb && st3.shown) break;
      await sleep(100);
    }
    console.log('阈值 9999 =', JSON.stringify({ meta: st3.meta, thumbCount: st3.thumbCount }));
    check(st3.hasLb && st3.shown, '阈值调大后灯箱照样打开（全灭时不许弹不出来）');
    check(st3.meta.indexOf('已按 9999px 过滤') >= 0,
      'meta 如实写出「已按 9999px 过滤 N 张」—— 说明设置真的从存储读进来了',
      st3.meta);
    const droppedN = (st3.meta.match(/过滤 (\d+) 张/) || [])[1];
    check(Number(droppedN) === TOTAL - 1,
      '被过滤的张数是 ' + (TOTAL - 1) + '（12 张里只剩点的那一张）',
      String(droppedN));
    check(st3.thumbCount === 0, '只剩一张时缩略图条整条收起（1 张没什么可翻的）',
      String(st3.thumbCount));

    // 阈值改回 0 → 完全不过滤，一张不少
    await setMin(0);
    await reopenAt(PICK);

    let st4 = null;
    for (let i = 0; i < 200; i++) {
      st4 = await lightboxState(page);
      if (st4.hasLb && st4.shown) break;
      await sleep(100);
    }
    console.log('阈值 0 =', JSON.stringify({ meta: st4.meta, thumbCount: st4.thumbCount }));
    check(st4.meta.indexOf('过滤') < 0,
      '阈值 0 → meta 里不出现「过滤」字样（不过滤，无可披露）', st4.meta);
    check(st4.thumbCount === TOTAL,
      '阈值 0 → 缩略图条铺回全部 ' + TOTAL + ' 张', String(st4.thumbCount));
    check(st4.meta.indexOf(PICK + 1 + ' / ' + TOTAL) >= 0,
      '阈值 0 时定位仍然正确（' + (PICK + 1) + ' / ' + TOTAL + '）', st4.meta);
  } catch (e) {
    console.error('测试异常', e);
    fail++;
  } finally {
    await ctx.close();
    site.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
