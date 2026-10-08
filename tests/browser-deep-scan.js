/* ImageHunter — 真实浏览器：深度嗅探（无限滚动页面）
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是产品承诺与实现之间的缺口：
 *   README 写着「全量嗅探」，但 collectAll 只看**此刻存在**的 DOM。
 *   微博、Pinterest、电商瀑布流这类站点要滚到底才加载下一批，
 *   于是图库只显示首屏那几十张 —— 用户会直接判定「这扩展不好用」。
 *
 * 修法：deepScan() 滚动整页、边滚边采集（每轮 600ms 让新内容落地），
 *   连续两轮没有新图或到达文档底部就停，最后只对合并结果做一次加工；
 *   结束后把 scrollY 复原（这是别人的页面，没理由把它滚乱）。
 *
 * 覆盖：
 *   - 后台契约：普通 scanTab 只拿到首屏，deep 模式拿到全部
 *   - 滚动位置复原
 *   - 去重：多轮采集不产生重复项
 *   - 端到端：点「深度嗅探」按钮 → 卡片数达到全量、loading 出现过滚动进度
 *   - 未滚动时普通嗅探确实够不着（否则这轮测试没有意义）
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
const PROFILE = path.join(os.tmpdir(), 'ih-deep-scan-profile-' + Date.now());

/* 每批必须比视口高一屏以上，否则首屏就「已经在底部」、滚动根本触发不了追加，
   测出来的现象会和真实站点完全不同（第一版就踩了这个：24 张刚好塞满 900px 视口，
   深度嗅探滚不动，只拿到 24 张）。 */
const COLS = 4, ROWS = 4;          // 每批 16 张，约 1.1 屏高
const BATCHES = 3;                 // 共 3 批 = 48 张

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让后台直接对某个标签页跑一次嗅探 */
async function scanViaSw(sw, port, deep) {
  return sw.evaluate(async ({ p, d }) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
    if (!t) return { error: '找不到标签页' };
    return scanTab(t.id, { deep: d });
  }, { p: port, d: !!deep });
}

async function waitTotal(page, n, budgetMs) {
  let waited = 0;
  while (waited < budgetMs) {
    const v = await page.evaluate(() => document.getElementById('statTotal').textContent);
    if (Number(v) >= n) return v;
    await sleep(300);
    waited += 300;
  }
  return page.evaluate(() => document.getElementById('statTotal').textContent);
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const site = await startServer({
    cols: COLS, rows: ROWS, imgW: 400, imgH: 300, lazyBatches: BATCHES
  });
  console.log('无限滚动站点 =', site.url,
    '（共 ' + site.total + ' 张，首屏 ' + site.perBatch + ' 张，滚到底追加）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await page.bringToFront();          // 后台标签页的定时器会被节流，必须放前台
    await sleep(1500);

    /* ---------- 1. 普通嗅探够不着 ---------- */
    console.log('\n=== 1. 普通嗅探（不滚动）===');
    const domBefore = await page.evaluate(() => document.images.length);
    const plain = await scanViaSw(sw, site.port, false);
    if (plain.error) throw new Error('嗅探失败：' + plain.error);
    console.log('DOM 里 ' + domBefore + ' 张，嗅探到 ' + plain.images.length + ' 张');
    check(domBefore === site.perBatch,
      '页面此刻只有首屏 ' + site.perBatch + ' 张（其余还没加载）', domBefore);
    check(plain.images.length === site.perBatch,
      '普通嗅探只拿到首屏 ' + site.perBatch + ' 张（这正是缺口所在）', plain.images.length);

    /* ---------- 2. 深度嗅探拿到全部 ---------- */
    console.log('\n=== 2. 深度嗅探（滚动整页）===');
    const yBefore = await page.evaluate(() => window.scrollY);
    const t0 = Date.now();
    const deep = await scanViaSw(sw, site.port, true);
    const ms = Date.now() - t0;
    if (deep.error) throw new Error('深度嗅探失败：' + deep.error);
    console.log('嗅探到 ' + deep.images.length + ' 张，耗时 ' + ms + 'ms');
    check(deep.images.length === site.total,
      '深度嗅探拿到全部 ' + site.total + ' 张', deep.images.length);
    check(deep.images.length > plain.images.length,
      '确实比普通嗅探多（' + deep.images.length + ' > ' + plain.images.length + '）',
      deep.images.length + ' / ' + plain.images.length);

    const urls = deep.images.map((i) => i.url);
    check(new Set(urls).size === urls.length,
      '多轮采集没有产生重复项', urls.length + ' 张 / ' + new Set(urls).size + ' 个唯一地址');

    /* ---------- 3. 滚动位置复原 ---------- */
    console.log('\n=== 3. 页面滚动位置必须复原 ===');
    const yAfter = await page.evaluate(() => window.scrollY);
    console.log('扫描前 scrollY=' + yBefore + '，扫描后 scrollY=' + yAfter);
    check(yAfter === yBefore,
      '页面滚回扫描前的位置（' + yBefore + ' → ' + yAfter + '）', yAfter);

    /* ---------- 4. 端到端：点「深度嗅探」按钮 ---------- */
    console.log('\n=== 4. 端到端：图库里的「深度嗅探」按钮 ===');
    // 重新起一个站，否则上面的页面已经滚到底、DOM 里已经全了
    const site2 = await startServer({
      cols: COLS, rows: ROWS, imgW: 400, imgH: 300, lazyBatches: BATCHES
    });
    const page2 = await ctx.newPage();
    await page2.goto(site2.url, { waitUntil: 'load', timeout: 60000 });
    await page2.bringToFront();
    await sleep(1200);

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, site2.port);
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');

    // 图库首次自动嗅探的是普通模式 → 只该有首屏
    const firstTotal = await waitTotal(gallery, site2.perBatch, 40000);
    check(Number(firstTotal) === site2.perBatch,
      '图库打开时（普通嗅探）只有首屏 ' + site2.perBatch + ' 张', firstTotal);

    const hasBtn = await gallery.evaluate(() => !!document.getElementById('btnDeep'));
    check(hasBtn, '顶栏存在「深度嗅探」按钮');

    await gallery.click('#btnDeep');

    // 滚动进度必须显示出来 —— 整页滚动可能十几秒，没有进度用户会以为卡死
    let sawProgress = false;
    try {
      await gallery.waitForFunction(
        () => /已采集/.test(document.getElementById('loadingText').textContent),
        { timeout: 20000 }
      );
      sawProgress = true;
    } catch (e) { /* 下面统一断言 */ }
    check(sawProgress, '滚动期间 loading 文案显示「已采集 N 张」的实时进度');

    const deepTotal = await waitTotal(gallery, site2.total, 60000);
    check(Number(deepTotal) === site2.total,
      '点完之后卡片数达到全量 ' + site2.total, deepTotal);

    const yAfter2 = await page2.evaluate(() => window.scrollY);
    check(yAfter2 === 0, '界面触发时同样把页面滚回原位', yAfter2);

    const note = await gallery.evaluate(() => {
      const el = document.getElementById('truncNote');
      return el ? { hidden: el.hidden, text: el.textContent } : null;
    });
    check(note && note.hidden === true,
      '滚到底自然结束时不应出现「已达滚动上限」提示', note && JSON.stringify(note));

    site2.close();
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
