/* ImageHunter — 真实浏览器：大图预览不再把人甩到原标签页
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是这条体验问题：
 *   图库页里点放大镜，openLightbox 把 OPEN_LIGHTBOX 转发给**目标网页**标签页，
 *   灯箱开在那边 —— 用户点一下预览就被甩到原标签页上去了（弹窗模式还会顺手
 *   把弹窗自己关掉）。预览是「看一眼」，不该等于「换一个页面」。
 *
 * 修法：图库页直接加载内容脚本那份 lightbox.js，在本页开灯箱；
 *       面板模式例外 —— 图库是嵌在网页里的一条窄 iframe，灯箱开在里面只会被挤扁，
 *       仍然交给网页开才是真正的全屏。
 *
 * 覆盖：
 *   1. 图库页内开灯箱：宿主出现、处于打开态、拿到完整列表（可连播）、未发生导航
 *   2. 源页面**没有**被牵连：它那边一张灯箱都没开
 *   3. 灯箱在本页可用：方向键切换、保存时 Referer 用的是**图片所在页面**而不是
 *      chrome-extension://（否则防盗链站点会 403）
 *   4. Esc 关闭后图库页还在原处
 *   5. 对照：面板模式仍然把灯箱交给网页开
 *   6. 图片在子 iframe 里时，预览交回顶层 frame 开
 *   7. 灯箱是页内模态：真页面上滚轮 / 空格 / ↑↓ 都不该把背景滚走，
 *      真滚动条宽度要补偿，关掉之后滚动位置还在原处
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
const PROFILE = path.join(os.tmpdir(), 'ih-lb-local-profile-' + Date.now());
const DL = path.join(os.tmpdir(), 'ih-lb-local-dl-' + Date.now());

const COLS = 4, ROWS = 4, TOTAL = COLS * ROWS;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等图库底栏的「共 N 张」达到期望值（page 或 frame 都行） */
async function waitTotal(page, n, budgetMs) {
  let waited = 0;
  while (waited < budgetMs) {
    const v = await page.evaluate(() => {
      const el = document.getElementById('statTotal');
      return el ? el.textContent : '0';
    });
    if (Number(v) >= n) return v;
    await sleep(300);
    waited += 300;
  }
  return page.evaluate(() => {
    const el = document.getElementById('statTotal');
    return el ? el.textContent : '0';
  });
}

/**
 * 这个页面/框架里开着灯箱吗？
 *
 * 必须穿透 shadow DOM 去数：`.ih-lb` 在 shadow root 里，`document.querySelector`
 * 是看不见的 —— 用它来断言「源页面没开灯箱」会永远为真，等于什么都没测。
 *
 * 注意 `open` 只在**扩展页面**（图库页 / 面板 iframe）里可信：
 * 内容脚本跑在隔离世界，网页的 main world 里读不到 `window.IH`。
 * 所以判断网页那边开没开灯箱，只能看 `hasLb` / `shown` 这些 DOM 事实。
 */
const lightboxState = (target) => target.evaluate(() => {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  let host = null, lb = null;
  for (const h of hosts) {
    const el = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
    if (el) { host = h; lb = el; break; }
  }
  const img = host ? host.shadowRoot.querySelector('.ih-lb-img') : null;
  const meta = host ? host.shadowRoot.querySelector('.ih-lb-meta') : null;
  return {
    open: !!(window.IH && window.IH.__lightboxOpen),
    hasLb: !!lb,
    shown: lb ? lb.classList.contains('ih-show') : false,
    src: img ? img.getAttribute('src') : null,
    meta: meta ? meta.textContent : null,
    hostCount: hosts.length
  };
});

/** 在页面内直接点灯箱上的某个按钮（绕开 shadow DOM 选择器的不确定性） */
const clickLightbox = (target, act) => target.evaluate((a) => {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    const lb = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
    if (!lb) continue;
    const btn = lb.querySelector('[data-act="' + a + '"]');
    if (btn) { btn.click(); return true; }
  }
  return false;
}, act);

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.mkdirSync(DL, { recursive: true });

  /* 图片尺寸的**较短边**必须大于图库尺寸滑条的默认 256px（v1.11.0 起按短边 256 过滤）。
     注意是短边不是宽度：320×240 的短边只有 240，照样被挡。
     用 400×300（短边 300）—— 本用例测的是「灯箱开在哪个宿主」，
     不该被尺寸过滤干扰，所以这里必须稳稳过门槛。 */
  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 400, imgH: 300 });
  console.log('测试站点 =', site.url, '（' + TOTAL + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  let framed = null;
  let tall = null;

  try {
    /* ---------- 准备：源页面 + 图库独立标签页 ---------- */
    const src = await ctx.newPage();
    await src.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await src.bringToFront();
    await sleep(2000);

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, site.port);
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');

    try {
      const cdp = await ctx.newCDPSession(gallery);
      await cdp.send('Browser.setDownloadBehavior',
        { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    } catch (e) { console.log('CDP 下载目录设置失败（不影响断言）:', e.message); }

    console.log('\n=== 1. 图库页内点放大镜 → 灯箱开在本页 ===');
    const total = await waitTotal(gallery, TOTAL, 60000);
    check(Number(total) === TOTAL, '图库已扫到 ' + TOTAL + ' 张', total);

    const gUrlBefore = gallery.url();
    check(gUrlBefore.indexOf('mode=page') >= 0, '图库是独立标签页模式', gUrlBefore);

    await gallery.bringToFront();
    await gallery.locator('.card .zoom').first().click();
    await sleep(1000);

    const g = await lightboxState(gallery);
    console.log('图库页灯箱状态 =', JSON.stringify(g));
    check(g.hasLb, '图库页内出现了灯箱');
    check(g.open, '图库页的 IH.__lightboxOpen 为真');
    check(g.shown, '灯箱进入 ih-show（可见）');
    check(g.src && g.src.indexOf('127.0.0.1:' + site.port) >= 0,
      '灯箱显示的是本页图片', g.src);
    check(/1\s*\/\s*16/.test(g.meta || ''), '灯箱拿到的是完整列表（1 / 16），可连播',
      g.meta);
    check(gallery.url() === gUrlBefore, '点预览没有触发任何导航', gallery.url());

    console.log('\n=== 2. 源页面没有被牵连 ===');
    const s = await lightboxState(src);
    console.log('源页面灯箱状态 =', JSON.stringify(s));
    check(!s.hasLb, '源页面里没有灯箱（以前灯箱是开在这边的）');
    check(s.hostCount === 0,
      '源页面连一个 Shadow DOM 宿主都没多出来（内容脚本完全没被叫醒）', s.hostCount);

    console.log('\n=== 3. 灯箱在本页可用 ===');
    const firstSrc = g.src;
    await gallery.keyboard.press('ArrowRight');
    await sleep(600);
    const g2 = await lightboxState(gallery);
    check(g2.src && g2.src !== firstSrc, '按 → 切到了下一张', g2.src);
    check(/2\s*\/\s*16/.test(g2.meta || ''), 'meta 更新为 2 / 16', g2.meta);

    const clicked = await clickLightbox(gallery, 'save');
    check(clicked, '点到了灯箱上的「保存原图」');
    await sleep(3500);

    const hist = await sw.evaluate(async () => {
      const local = await chrome.storage.local.get('ih_history');
      return (local.ih_history || []).slice(0, 5);
    });
    const hit = hist.find((h) => h && h.url && h.url.indexOf('127.0.0.1') >= 0);
    console.log('历史首条 =', JSON.stringify(hist[0] || null));
    check(!!hit, '下载历史里出现了这次保存');
    // 这一条是关键：灯箱跑在 chrome-extension:// 页面上，如果不显式传 pageUrl，
    // 这里记下的就会是扩展自己的地址 —— 防盗链站点据此判断 Referer 会直接拒绝。
    check(hit && hit.pageUrl === site.url,
      '历史里的 pageUrl 是【图片所在页面】而不是扩展地址', hit && hit.pageUrl);
    check(hit && hit.status === 'done', '保存状态为 done', hit && hit.status);

    console.log('\n=== 4. Esc 关闭后图库页还在原处 ===');
    await gallery.keyboard.press('Escape');
    await sleep(500);
    const g3 = await lightboxState(gallery);
    check(!g3.open && !g3.shown, 'Esc 关闭了灯箱', JSON.stringify(g3));
    check(gallery.url() === gUrlBefore, '图库页仍在原处', gallery.url());
    check(src.url().indexOf('127.0.0.1:' + site.port) >= 0, '源页面也没被导航走', src.url());

    console.log('\n=== 5. 对照：面板模式仍交给网页开（否则会被挤成一条）===');
    await src.bringToFront();
    // 网页上若还留着灯箱，它的 z-index 比面板高，会把面板上的点击全挡住。
    // 正常路径下这里是空操作（没开灯箱时 onKeyDown 直接早退）。
    await src.keyboard.press('Escape');
    await sleep(400);
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await chrome.tabs.sendMessage(t.id, { type: 'IH_TOGGLE_PANEL' }, { frameId: 0 });
    }, site.port);
    await sleep(3000);

    const panelFrame = src.frames().find((f) => f.url().indexOf('mode=panel') >= 0);
    check(!!panelFrame, '面板 iframe 已就绪');
    if (panelFrame) {
      await waitTotal(panelFrame, TOTAL, 40000);
      await panelFrame.locator('.card .zoom').first().click();
      await sleep(1200);

      const inPanel = await lightboxState(panelFrame);
      const inPage = await lightboxState(src);
      console.log('面板内 =', JSON.stringify(inPanel), ' / 网页内 =', JSON.stringify(inPage));
      check(!inPanel.hasLb, '面板 iframe 自己没有开灯箱');
      // 网页那边是内容脚本开的灯箱，main world 读不到 IH，只能看 DOM 事实
      check(inPage.hasLb && inPage.shown, '灯箱开在网页上（全屏铺满）',
        JSON.stringify(inPage));
    }

    console.log('\n=== 6. 图片在 iframe 里：预览交回顶层 frame 开 ===');
    // 内容脚本注入到所有 frame，所以悬停按钮在子 frame 里也会出现。
    // 但灯箱是 position:fixed 铺满**当前文档**的 —— 在子 frame 里开会被裁成一小块。
    // fixture-ok: 这一节测「图片在子 iframe 里时预览交回顶层开」，只用悬停灯箱，不打开图库网格
    framed = await startServer({ cols: 2, rows: 2, imgW: 200, imgH: 150, iframe: true });
    const host = await ctx.newPage();
    await host.goto(framed.url, { waitUntil: 'load', timeout: 60000 });
    await host.bringToFront();
    await sleep(2500);

    const frame = host.frames().find((f) => f.url() === framed.frameUrl);
    check(!!frame, '子 iframe 已加载');

    if (frame) {
      await frame.locator('img').first().hover();
      await sleep(450);

      const inFrame = await frame.evaluate(() => {
        const h = document.querySelector('[data-ih-host]');
        const bar = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-hover');
        const pv = h && h.shadowRoot && h.shadowRoot.querySelector('.ih-hover-preview');
        return { hasBar: !!bar, hasPv: !!pv, shown: bar ? bar.classList.contains('ih-show') : false };
      });
      console.log('iframe 内悬停 UI =', JSON.stringify(inFrame));
      check(inFrame.hasBar && inFrame.hasPv, '子 frame 里也出现了悬停按钮（含预览键）');
      check(inFrame.shown, '悬停后按钮可见');

      await frame.evaluate(() => {
        const h = document.querySelector('[data-ih-host]');
        h.shadowRoot.querySelector('.ih-hover-preview').click();
      });
      await sleep(1500);

      const top = await lightboxState(host);
      const sub = await lightboxState(frame);
      console.log('顶层 =', JSON.stringify(top), ' / 子 frame =', JSON.stringify(sub));
      check(top.hasLb && top.shown, '灯箱开在顶层页面上（不会被 iframe 边界裁掉）');
      check(!sub.hasLb, '子 frame 里没有开灯箱（那样会被裁成一小块）');
      check(top.src && top.src.indexOf('127.0.0.1:' + framed.port) >= 0,
        '顶层灯箱显示的是子 frame 里那张图', top.src);
    }

    /* --------------------------------------------------------------- *
     * 7. 灯箱是页内模态：背景不该跟着滚
     *
     * 这一节必须用**能滚起来**的页面。上面那个 4×4 的站点整页都在视口里，
     * 不管怎么滚 window.scrollY 都是 0 —— 拿它来断言「页面没被滚走」恒真。
     *
     * 滚轮 / 键盘在 JS 层的精确断言（defaultPrevented、缩略图条放行）在
     * test-hover.js 第 4 节，那里能直接看事件对象；这里管的是真页面上的集成效果：
     * 锁是不是真的落到了 documentElement 上、真滚动条宽度有没有补偿、
     * 关掉之后滚动位置还在不在原处。
     * --------------------------------------------------------------- */
    console.log('\n=== 7. 灯箱锁住背景滚动（真实页面 + 真实滚动条）===');
    // fixture-ok: 这一节测「灯箱锁住背景滚动」，只用悬停灯箱 + 真实滚动条，不打开图库网格
    tall = await startServer({ cols: 4, rows: 40, imgW: 200, imgH: 150 });
    const tp = await ctx.newPage();
    await tp.goto(tall.url, { waitUntil: 'load', timeout: 60000 });
    await tp.bringToFront();
    await sleep(2500);

    const metrics = () => tp.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      clientW: document.documentElement.clientWidth,
      overflow: document.documentElement.style.overflow,
      padRight: document.documentElement.style.paddingRight,
      bodyOverflow: document.body.style.overflow
    }));

    const m0 = await metrics();
    console.log('页面指标 =', JSON.stringify(m0));
    check(m0.scrollH > m0.innerH + 600,
      '站点确实比视口高得多，可以滚动（否则这一节的断言会恒真）',
      m0.scrollH + ' vs ' + m0.innerH);

    await tp.evaluate(() => window.scrollTo(0, 600));
    await sleep(300);
    const m1 = await metrics();
    check(m1.scrollY > 500, '页面已滚到 600 附近', String(m1.scrollY));

    // 直接从后台把预览发给这个页面的内容脚本。
    // 不走「悬停 → 点预览键」：Playwright 的 hover() 会自动把元素滚进视口，
    // 顺手把上面刚设置的滚动位置冲掉，整节的断言就失去意义了。
    const opened = await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      if (!t) return { ok: false, error: '找不到标签页' };
      const origin = new URL(t.url).origin;
      const list = [];
      for (let i = 0; i < 6; i++) {
        list.push({ url: origin + '/img/' + i + '.png', width: 200, height: 150, type: 'png' });
      }
      try {
        const r = await chrome.tabs.sendMessage(t.id,
          { type: 'IH_OPEN_LIGHTBOX', payload: { list, index: 0, pageUrl: t.url } },
          { frameId: 0 });
        return r || { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }, tall.port);
    check(opened && opened.ok, '内容脚本接受了打开预览的请求', JSON.stringify(opened));
    await sleep(1600);

    const lbOn = await lightboxState(tp);
    const m2 = await metrics();
    console.log('开灯箱后 =', JSON.stringify(m2), ' / 灯箱 =', JSON.stringify(lbOn));
    check(lbOn.hasLb && lbOn.shown, '灯箱已打开');
    check(m2.overflow === 'hidden', 'html 的 overflow 被锁成 hidden', m2.overflow);
    check(m2.bodyOverflow === 'hidden', 'body 的 overflow 也被锁上', m2.bodyOverflow);
    // 滚动条宽度补偿。headless Edge 用的是 overlay 滚动条（clientWidth === innerWidth），
    // 这种环境下不能假装测过补偿算术 —— 那是 test-hover.js 第 4 节用 stub 出来的
    // clientWidth 精确覆盖的（1000 vs 1024 → padding 10px 变 34px）。
    // 这里能做的是把两种环境下的**正确行为**分别钉住。
    const barW = m1.innerW - m1.clientW;
    if (barW > 0) {
      check(Number.parseFloat(m2.padRight) > 0,
        '隐藏了 ' + barW + 'px 滚动条后补了等宽 padding-right（内容不会横跳）',
        'padding-right=' + JSON.stringify(m2.padRight));
    } else {
      check(m2.padRight === '',
        '本环境没有常驻滚动条（overlay），此时不应凭空加 padding-right',
        JSON.stringify(m2.padRight));
      console.log('  （滚动条宽度的补偿算术由 test-hover.js 第 4 节精确覆盖）');
    }
    check(m2.scrollY === m1.scrollY,
      '开灯箱本身没有改变滚动位置', m1.scrollY + ' → ' + m2.scrollY);

    // 滚轮落在灯箱上
    await tp.mouse.move(640, 450);
    await tp.mouse.wheel(0, 800);
    await sleep(400);
    const m3 = await metrics();
    check(m3.scrollY === m1.scrollY,
      '在灯箱上滚滚轮，页面没有跟着滚', m1.scrollY + ' → ' + m3.scrollY);

    // 翻页键
    for (const k of ['Space', 'PageDown', 'ArrowDown', 'End']) {
      await tp.keyboard.press(k);
      await sleep(180);
    }
    await sleep(400);
    const m4 = await metrics();
    check(m4.scrollY === m1.scrollY,
      '空格 / PageDown / ArrowDown / End 都没把页面滚走', m1.scrollY + ' → ' + m4.scrollY);

    /* 上面两条在「锁生效」的前提下是冗余的 —— 光是 overflow:hidden 就足以
       让滚轮和键盘都滚不动，把 onWheel / onKeyDown 改回旧行为它们照样绿。
       所以这里**主动把锁摘掉**，模拟「锁管不到」的情况：只剩事件拦截兜底，
       它必须依然把页面按住。这才是这两条真正要证明的东西。 */
    console.log('  （摘掉 overflow 锁，只留 onWheel / onKeyDown 兜底）');
    await tp.evaluate(() => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    });
    await sleep(200);

    await tp.mouse.move(640, 450);
    await tp.mouse.wheel(0, 800);
    await sleep(400);
    const m4b = await metrics();
    check(m4b.scrollY === m1.scrollY,
      '【锁被摘掉后】onWheel 兜底仍把页面按住', m1.scrollY + ' → ' + m4b.scrollY);

    for (const k of ['Space', 'PageDown', 'ArrowDown', 'End']) {
      await tp.keyboard.press(k);
      await sleep(180);
    }
    await sleep(400);
    const m4c = await metrics();
    check(m4c.scrollY === m1.scrollY,
      '【锁被摘掉后】onKeyDown 兜底仍把页面按住', m1.scrollY + ' → ' + m4c.scrollY);

    /* 上面那次滚轮还不足以复现原始 bug —— 图是正常加载的，`loaded` 为 true，
       旧代码在这种情况下也会 preventDefault。真正穿透的条件是**图片没加载成功**：
       旧代码 onWheel 第一行就是 `if (!loaded) return;`，直接放行。
       所以这里换成一张 404 的图，并且让锁继续保持摘掉状态。 */
    const brokenOk = await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      if (!t) return { ok: false, error: '找不到标签页' };
      const origin = new URL(t.url).origin;
      const list = [{ url: origin + '/img/999999.png', width: 200, height: 150, type: 'png' }];
      try {
        const r = await chrome.tabs.sendMessage(t.id,
          { type: 'IH_OPEN_LIGHTBOX', payload: { list, index: 0, pageUrl: t.url } },
          { frameId: 0 });
        return r || { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }, tall.port);
    check(brokenOk && brokenOk.ok, '已换成一张加载必然失败的图（404）');
    await sleep(1500);
    // lockScroll() 有 `if (scrollLock) return` 守卫，所以这次 open 不会重新加锁；
    // 为稳妥起见再摘一次。
    await tp.evaluate(() => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    });
    const m4d = await metrics();
    check(m4d.scrollY === m1.scrollY, '换图本身没有改变滚动位置',
      m1.scrollY + ' → ' + m4d.scrollY);

    await tp.mouse.move(640, 450);
    await tp.mouse.wheel(0, 800);
    await sleep(400);
    const m4e = await metrics();
    check(m4e.scrollY === m1.scrollY,
      '【图片加载失败 + 锁被摘掉】滚轮仍被拦住 —— 这正是旧版穿透的那个场景',
      m1.scrollY + ' → ' + m4e.scrollY);

    // 关掉之后：还原 + 还在原来那一屏（这才是整节的意义）
    await tp.keyboard.press('Escape');
    await sleep(600);
    const m5 = await metrics();
    const lbOff = await lightboxState(tp);
    console.log('关闭后 =', JSON.stringify(m5), ' / 灯箱 =', JSON.stringify(lbOff));
    check(!lbOff.open && !lbOff.shown, 'Esc 关闭了灯箱');
    check(m5.overflow === m0.overflow,
      '关闭后 html 的 overflow 还原成页面原本的值',
      JSON.stringify(m0.overflow) + ' → ' + JSON.stringify(m5.overflow));
    check(m5.padRight === m0.padRight,
      '关闭后 padding-right 也还原（不留下补偿值）',
      JSON.stringify(m0.padRight) + ' → ' + JSON.stringify(m5.padRight));
    check(m5.scrollY === m1.scrollY,
      '关闭后仍在原来那一屏', m1.scrollY + ' → ' + m5.scrollY);

    // 还原之后页面必须能正常滚 —— 否则就是把用户的页面锁死了
    await tp.evaluate(() => window.scrollTo(0, 1400));
    await sleep(300);
    const m6 = await metrics();
    check(m6.scrollY > 1200, '还原后页面可以正常滚动（没被锁死）', String(m6.scrollY));

    await tp.close();
    tall.close();
    tall = null;

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
    if (framed) framed.close();
    if (tall) tall.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
