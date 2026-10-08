/* ImageHunter — 真实浏览器：点击扩展图标打开「图库独立标签页」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * **完全离线**：两个目标页都是 lib/localsite.js 起的本地站。
 * 两个站点必须给**不同的页面标题** —— prettyHost() 只看主机名，两个站点都跑在
 * 127.0.0.1 上，光靠顶栏域名分不出图库当前锁的是哪一个目标页。
 *
 * 覆盖：
 *   - 图标点击后在新标签页打开图库（而不是弹小窗）
 *   - 图库能自动锁定「最近活跃的普通网页标签页」作为扫描目标
 *     （独立页里 tabs.query({active}) 拿到的是图库自己，必须由后台兜住）
 *   - 扫描目标下拉框能列出其它网页标签页
 *   - 切到另一个标签页后真的能嗅探出图
 *   - 重复点击图标复用同一个图库标签页，不会越开越多
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
const PROFILE = path.join(os.tmpdir(), 'ih-gallery-profile-' + Date.now());

const TITLE_A = '图库测试站 A';
const TITLE_B = '图库测试站 B';

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  // A 站：12 张，用来验证「切过去真的能嗅探出图」
  const siteA = await startServer({ cols: 4, rows: 3, imgW: 600, imgH: 400, title: TITLE_A });
  // B 站：4 张，用来当「点击图标时活跃的那个标签页」
  const siteB = await startServer({ cols: 2, rows: 2, imgW: 600, imgH: 400, title: TITLE_B });
  console.log('A 站 =', siteA.url, '（' + siteA.total + ' 张）');
  console.log('B 站 =', siteB.url, '（' + siteB.total + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  try {
    /* ---------- 1. 先开两个普通网页标签页 ---------- */
    console.log('\n=== 1. 准备两个网页标签页 ===');
    const pageA = await ctx.newPage();
    await pageA.goto(siteA.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    const pageB = await ctx.newPage();
    await pageB.goto(siteB.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1200);

    // 让 B 成为「最近活跃」的普通网页标签页
    await pageB.bringToFront();
    await sleep(600);

    const seen = await sw.evaluate(() => ({ last: lastContentTabId, gallery: galleryTabId }));
    console.log('后台记录: lastContentTabId =', seen.last, ', galleryTabId =', seen.gallery);
    check(seen.last != null, '后台记住了最近活跃的网页标签页');
    check(seen.gallery == null, '此时还没有图库标签页');

    /* ---------- 2. 触发图标点击 ---------- */
    console.log('\n=== 2. 触发扩展图标点击 ===');
    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async () => {
      const target = await pickTargetTab(null);
      await openGallery(target);
    });
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');
    await sleep(3500);   // 等扫描完成

    const url = gallery.url();
    console.log('图库地址:', url);
    check(/popup\/popup\.html\?mode=page/.test(url), '图库以独立标签页打开（mode=page）');
    check(/tabId=\d+/.test(url), 'URL 里带上了扫描目标 tabId');

    /* ---------- 3. 页面结构与目标解析 ---------- */
    console.log('\n=== 3. 图库页面状态 ===');
    const info = await gallery.evaluate(() => {
      const sel = document.getElementById('selTargetTab');
      const host = document.getElementById('pageHost');
      return {
        bodyClass: document.body.className,
        title: document.title,
        host: host ? host.textContent : '',
        hostTitle: host ? host.title : '',
        options: sel ? Array.from(sel.options).map((o) => ({ v: o.value, t: o.textContent, u: o.title })) : null,
        cards: document.querySelectorAll('#grid .card, #grid > *').length,
        targetVisible: !!sel && getComputedStyle(sel.parentElement).display !== 'none'
      };
    });
    console.log(JSON.stringify(info, null, 2));

    check(info.bodyClass.indexOf('mode-page') >= 0, 'body 处于 mode-page 布局');
    check(info.title.indexOf('图库') >= 0, '标签页标题为图库', info.title);
    check(info.targetVisible, '「扫描目标」下拉框在独立页里可见');
    // 图库页自己会被排除，所以这里正好是 A + B 两个
    check(info.options && info.options.length === 2,
      '下拉框列出了 A / B 两个网页标签页（图库自己不算）', info.options && info.options.length + ' 项');
    [siteA.port, siteB.port].forEach((p) => {
      check(!!info.options && info.options.some((o) => (o.u || '').indexOf(':' + p + '/') >= 0),
        '下拉框中能找到端口 ' + p + ' 的页面（按 URL 匹配）');
    });
    // 图标是在 B 站处于前台时点的，所以目标应当锁定为 B 站
    check(info.host === '127.0.0.1', '顶栏域名是本地站主机名', info.host);
    check(info.hostTitle.indexOf(TITLE_B) >= 0,
      '扫描目标锁定为点击图标时活跃的那个标签页（B 站）', info.hostTitle);
    check(info.cards === siteB.total, '默认就嗅探出了 B 站的 ' + siteB.total + ' 张', info.cards);

    /* ---------- 3b. 切到 A 站标签页，验证真的能嗅探出图 ---------- */
    console.log('\n=== 3b. 切换到 A 站标签页 ===');
    const toA = await gallery.evaluate(async (port) => {
      const sel = document.getElementById('selTargetTab');
      const opt = Array.from(sel.options).find((o) => (o.title || '').indexOf(':' + port + '/') >= 0);
      if (!opt) return { ok: false, reason: '下拉框里没有 A 站' };
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 6000));
      const host = document.getElementById('pageHost');
      return {
        ok: true,
        host: host.textContent,
        hostTitle: host.title,
        cards: document.querySelectorAll('#grid > *').length,
        total: document.getElementById('statTotal').textContent
      };
    }, siteA.port);
    console.log(JSON.stringify(toA));
    check(toA.ok === true, '切换目标成功', toA.reason);
    if (toA.ok) {
      check(toA.hostTitle.indexOf(TITLE_A) >= 0,
        '顶栏跟着换成了 A 站（按页面标题确认）', toA.hostTitle);
      check(Number(toA.total) === siteA.total,
        '统计到 A 站的 ' + siteA.total + ' 张', toA.total);
      check(toA.cards === siteA.total, '网格渲染出了 ' + siteA.total + ' 个图片卡片', toA.cards + ' 个');
    }

    /* ---------- 4. 重复点击图标应复用标签页 ---------- */
    console.log('\n=== 4. 重复点击图标 ===');
    const before = ctx.pages().length;
    await pageA.bringToFront();
    await sleep(500);
    await sw.evaluate(async () => {
      const target = await pickTargetTab(null);
      await openGallery(target);
    });
    await sleep(2000);
    const after = ctx.pages().length;
    check(after === before, '没有新开标签页（复用已打开的那个）', before + ' → ' + after);

    const galleryCount = ctx.pages().filter((p) => p.url().indexOf('popup/popup.html') >= 0).length;
    check(galleryCount === 1, '始终只有一个图库标签页', '实际 ' + galleryCount + ' 个');

    // 复用标签页时应当把新的扫描目标推给它
    const pushed = await gallery.evaluate(() => {
      const host = document.getElementById('pageHost');
      return { host: host.textContent, hostTitle: host.title, sel: document.getElementById('selTargetTab').value };
    });
    check(pushed.hostTitle.indexOf(TITLE_A) >= 0,
      '复用标签页时自动切到新的扫描目标（A 站）', pushed.hostTitle);

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    siteA.close();
    siteB.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
