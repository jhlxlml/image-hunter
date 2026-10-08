/* ImageHunter — 真实浏览器：原图还原慢时，不能把「还在跑」误判成「没有图片」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是用户报告的 bug：
 *   首次点击扩展图标打开图库，偶尔一张图都识别不到（https://fuliba.net/truly-naked.html）。
 *
 * 根因：原图还原要给**每张图的每个候选**发一次真实加载请求。那类页面上 65 张图
 *   全是 sogoucdn 缩略图代理地址，规则会为每个地址生成多个候选，冷加载时这一轮
 *   轻松超过 1 秒。而后台 scanTab 的收尾判据是：
 *       setTimeout(() => { if (images.length === 0 && frames.size === 0) finish(); }, 1500)
 *   它区分不了「没有 frame 响应」和「frame 正在还原」—— 于是把正常的慢扫描
 *   判定成「本页没有图片」，弹窗直接显示空列表。
 *   第二次打开时图片已进 HTTP 缓存、还原秒完，所以表现为「偶尔」。
 *
 * 修法三处：
 *   1. 后台删掉「1.5 秒无响应即收尾」，只在**内容脚本完全没动静**时才兜底；
 *   2. 内容脚本分两阶段回报：先交出「已采集、未还原」的 partial，还原跑完再交 final
 *      —— partial 既是「扫描确实在进行」的证据，也是还原超时的保底结果；
 *   3. 还原阶段加全局并发闸门与时间预算，不再让 N 张 × 6 条规则无节制地打请求。
 *
 * 覆盖：
 *   - 冷的还原候选 + 慢响应：仍然拿到全部图片（旧行为：0 张）
 *   - 还原确实生效：结果是原图地址、原图尺寸
 *   - 实测耗时确实跨过了旧的 1.5 秒判据（否则这轮测试就是假绿）
 *   - 还原超出时间预算时仍然有图，且总耗时有上界
 *   - 端到端：点开图库，底栏「共 N 张」是真实数量
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
const PROFILE = path.join(os.tmpdir(), 'ih-slow-restore-profile-' + Date.now());

/** 旧实现的硬超时：只要扫描比它慢，旧代码就会返回空列表 */
const OLD_HARD_TIMEOUT = 1500;
/** 新的还原阶段兜底超时（background.js SCAN_RESTORE_TIMEOUT） */
const RESTORE_TIMEOUT = 15000;

const SLOW_A = 800;      // 站点 A：单张还原候选延迟 800ms，48 张 → 约 5 秒（超旧超时，在预算内）
const SLOW_B = 2500;     // 站点 B：单张 2500ms，24 张 → 约 7.5 秒（超出还原预算，走兜底）

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让后台直接对某个标签页跑一次嗅探，返回原始结果与实测耗时 */
async function scanViaSw(sw, port) {
  const started = Date.now();
  const r = await sw.evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
    if (!t) return { error: '找不到标签页' };
    return scanTab(t.id);
  }, port);
  return { r, ms: Date.now() - started };
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

  // 站点 A：48 张，缩略图 300x200、原图 600x400，候选冷加载 800ms
/* 尺寸的**较短边**必须 > 图库尺寸滑条默认的 256px（v1.11.0 起开箱按短边 256 过滤）。
     用 600×400 + thumbPath 时页面上的缩略图是 300×200 —— 短边只有 200，会被整片挡住。
     本用例测的是「还原慢时不能误判成没有图片」，
     不该被尺寸过滤干扰，所以夹具必须稳稳过门槛。 */
  const a = await startServer({ cols: 8, rows: 6, imgW: 800, imgH: 600, thumbPath: true, imgDelay: SLOW_A });
  // 站点 B：24 张，候选冷加载 2500ms —— 整轮必然超出还原预算
  const b = await startServer({ cols: 6, rows: 4, imgW: 800, imgH: 600, thumbPath: true, imgDelay: SLOW_B });

  console.log('站点 A =', a.url, '（' + a.total + ' 张，候选延迟 ' + SLOW_A + 'ms）');
  console.log('站点 B =', b.url, '（' + b.total + ' 张，候选延迟 ' + SLOW_B + 'ms）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    /* ---------- 1. 冷的还原候选 + 慢响应 ---------- */
    console.log('\n=== 1. 还原候选冷加载 ' + SLOW_A + 'ms（' + a.total + ' 张） ===');
    const pageA = await ctx.newPage();
    await pageA.goto(a.url, { waitUntil: 'load', timeout: 60000 });
    await pageA.bringToFront();
    await sleep(2500);                       // 让页面自己的缩略图先加载完

    const s1 = await scanViaSw(sw, a.port);
    if (s1.r.error) throw new Error('嗅探失败：' + s1.r.error);
    console.log('images=' + s1.r.images.length + ' found=' + s1.r.found
      + ' 耗时=' + s1.ms + 'ms');

    check(s1.r.ok === true, '嗅探成功');
    check(s1.r.images.length === a.total,
      '拿到全部 ' + a.total + ' 张（旧实现的 1.5 秒判据会返回 0 张）', s1.r.images.length);
    check(s1.ms > OLD_HARD_TIMEOUT,
      '实测耗时 ' + s1.ms + 'ms 确实超过旧的 ' + OLD_HARD_TIMEOUT
      + 'ms 判据（否则这轮测试是假绿）', s1.ms);

    const urlsA = s1.r.images.map((i) => i.url);
    const restoredCount = urlsA.filter((u) => u.indexOf('/thumb/') < 0).length;
    console.log('还原后地址命中 ' + restoredCount + ' / ' + urlsA.length);
    check(restoredCount === a.total,
      '全部还原成了原图地址（/thumb/ 已去掉）', restoredCount);
    // 带上 length 判断：空列表时 every() 恒为真，加了才不会假绿
    check(s1.r.images.length > 0 && s1.r.images.every((i) => i.width === a.opts.imgW),
      '尺寸是原图的 ' + a.opts.imgW + 'px，而不是缩略图的 ' + (a.opts.imgW >> 1) + 'px',
      JSON.stringify(s1.r.images.slice(0, 3).map((i) => i.width)));
    check(s1.r.images.length > 0 && s1.r.restoreTruncated === false,
      '在预算内跑完，restoreTruncated 为 false', String(s1.r.restoreTruncated));

    /* ---------- 2. 端到端：点开图库 ---------- */
    console.log('\n=== 2. 端到端：打开图库，底栏应是真实数量 ===');
    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, a.port);
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');

    const totalA = await waitTotal(gallery, a.total, 40000);
    check(Number(totalA) === a.total,
      '底栏「共 N 张」= ' + a.total + '，而不是 0', totalA);

    const emptyHidden = await gallery.evaluate(() => document.getElementById('empty').hidden);
    check(emptyHidden === true, '没有显示「本页没有发现图片」', String(emptyHidden));

    /* ---------- 3. 还原超出时间预算时仍有图 ---------- */
    console.log('\n=== 3. 还原候选冷加载 ' + SLOW_B + 'ms（' + b.total + ' 张，必然超出预算） ===');
    const pageB = await ctx.newPage();
    await pageB.goto(b.url, { waitUntil: 'load', timeout: 60000 });
    await pageB.bringToFront();
    await sleep(2000);

    const s3 = await scanViaSw(sw, b.port);
    if (s3.r.error) throw new Error('嗅探失败：' + s3.r.error);
    console.log('images=' + s3.r.images.length + ' found=' + s3.r.found
      + ' 耗时=' + s3.ms + 'ms');

    check(s3.r.images.length === b.total,
      '还原跑不完也照样拿到全部 ' + b.total + ' 张', s3.r.images.length);
    check(s3.ms < RESTORE_TIMEOUT + 5000,
      '总耗时 ' + s3.ms + 'ms 有上界（不会无限等下去）', s3.ms);
    check(s3.ms > OLD_HARD_TIMEOUT,
      '这一轮同样跨过了旧的 ' + OLD_HARD_TIMEOUT + 'ms 判据', s3.ms);
    check(s3.r.restoreTruncated === true,
      '如实上报「还原超时」，而不是假装全部还原成功', String(s3.r.restoreTruncated));

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    a.close();
    b.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
