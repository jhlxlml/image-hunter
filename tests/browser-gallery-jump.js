/* ImageHunter — 真实浏览器：「在图库中打开」+ 扫描结果缓存
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 * **完全离线**：目标页由 lib/localsite.js 起在 127.0.0.1 上。
 *
 * 为什么必须在真浏览器里测：
 *   - 「点一下按钮，另一个标签页打开并**滚到那张卡片**」整条链路跨了
 *     内容脚本 → 后台 → 新标签页三个上下文，jsdom 里没有后两个
 *   - 卡片是**分片补全**渲染的，定位要等它真的进 DOM —— 这个时序只有真浏览器有
 *   - 扫描缓存的效果是「第二次打开快不快、有没有如实标注」，也要真开两次才看得到
 *
 * 覆盖：
 *   1. 网页里悬停 → 预览：灯箱确实只有 1 张（←→ 被禁用），但多了「在图库中打开」
 *   2. 点它 → 图库打开并**定位到那张**（高亮 + 滚进视口），原页面的灯箱自己收掉
 *   3. 图库页自己的灯箱**不显示**这个按钮（用户本来就在图库）
 *   4. 关掉图库再打开：走缓存（明显更快），并如实标注「复用 N 分钟前的嗅探结果」
 *   5. 点「重新嗅探」→ 缓存标记消失（说明真的重扫了）
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
const PROFILE = path.join(os.tmpdir(), 'ih-jump-profile-' + Date.now());

const COLS = 4, ROWS = 3;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ok, budgetMs, stepMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(stepMs || 150);
  }
  return last;
}

const basename = (u) => {
  try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || ''); }
  catch (e) { return ''; }
};

/** 悬停页面上「面积最大、完整可见」的那张图 */
async function hoverBiggest(page) {
  const ok = await page.evaluate(() => {
    const cands = Array.from(document.images)
      .map((im) => ({ im, r: im.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 120 && r.height >= 80 && r.top >= 40 && r.bottom <= window.innerHeight - 40);
    if (!cands.length) return false;
    cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    cands[0].im.setAttribute('data-ih-probe', '1');
    return true;
  });
  if (!ok) return false;
  await page.hover('[data-ih-probe="1"]');
  await sleep(700);
  return true;
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 600, imgH: 400, title: '跳转测试站' });
  console.log('测试站点 =', site.url, '（' + site.total + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  console.log('扩展 ID =', new URL(sw.url()).host);

  const targetTabId = async () => {
    const id = await sw.evaluate(async (port) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + port + '/') >= 0);
      return t ? t.id : null;
    }, site.port);
    return id;
  };

  try {
    /* ---------- 0. 打开目标页 ---------- */
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    check(await page.evaluate(() => document.images.length) === site.total,
      '目标页图片齐全', (await page.evaluate(() => document.images.length)) + ' 张');

    /* ---------- 1. 悬停 → 预览 ---------- */
    console.log('\n=== 1. 悬停预览：拿到本页全部图片，且有「在图库中打开」 ===');

    check(await hoverBiggest(page), '找到了一张可悬停的图片');
    await page.locator('[data-ih-host] .ih-hover-preview').first().click({ force: true });

    const opened = await until(
      () => page.evaluate(() => {
        const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
        for (const h of hosts) {
          const lb = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
          if (lb && lb.classList.contains('ih-show')) return true;
        }
        return false;
      }),
      (v) => v === true, 8000
    );
    check(opened === true, '点预览后灯箱在**当前页面**打开');

    const lbInfo = await page.evaluate(() => {
      const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
      for (const h of hosts) {
        const lb = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
        if (!lb || !lb.classList.contains('ih-show')) continue;
        const g = lb.querySelector('[data-act="gallery"]');
        const title = lb.querySelector('.ih-lb-title');
        const prev = lb.querySelector('.ih-lb-prev');
        return {
          hasGalleryBtn: !!g,
          galleryDisplay: g ? (g.style.display || '') : null,
          galleryVisible: !!(g && g.getBoundingClientRect().width > 0),
          url: title ? title.getAttribute('title') : '',
          prevDisabled: !!(prev && prev.disabled),
          stripHidden: lb.querySelector('.ih-lb-strip').style.display === 'none'
        };
      }
      return null;
    });
    console.log('  灯箱状态 =', JSON.stringify(lbInfo));

    check(!!lbInfo, '拿得到灯箱内部状态');
    check(!!lbInfo && lbInfo.hasGalleryBtn === true, '灯箱里有「在图库中打开」按钮');
    check(!!lbInfo && lbInfo.galleryVisible === true, '网页里这个按钮是可见的',
      lbInfo && ('display=' + lbInfo.galleryDisplay));
    /* 这条断言在 v1.9.0 被**有意**翻了个面。
       它原来断言的是「这一张是孤零零一张（← 禁用、缩略图条隐藏）—— 正是要补的那个缺口」。
       那个缺口现在补上了：悬停预览拿到的是本页全部图片。
       留着旧断言，等于把这次修复当成回归拦下来 —— 静态校验的前提也会过时，
       前提不成立时必须连断言一起改，不能只改被测代码。
       翻面之后仍然有 guarding 作用：列表要是退化回 1 张，这条立刻变红。 */
    check(!!lbInfo && lbInfo.prevDisabled === false && lbInfo.stripHidden === false,
      '预览里已经是本页全部图片（← 可用、缩略图条可见）—— v1.9.0 补掉的缺口',
      lbInfo && JSON.stringify(lbInfo));

    const sentUrl = lbInfo && lbInfo.url;
    check(!!sentUrl && /127\.0\.0\.1/.test(sentUrl), '灯箱里那张图的地址是本地的',
      sentUrl);

    /* ---------- 2. 点「在图库中打开」 ---------- */
    console.log('\n=== 2. 点它：图库打开并定位到那张 ===');

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await page.locator('[data-ih-host] .ih-lb-btn[data-act="gallery"]').first().click({ force: true });

    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');
    console.log('  图库 URL =', gallery.url());

    check(/mode=page/.test(gallery.url()), '打开的是独立页模式的图库', gallery.url());
    check(/focus=/.test(gallery.url()), 'URL 里带上了 focus（新开标签页那条路）', gallery.url());

    // 等扫描出图
    const total = await until(
      () => gallery.evaluate(() => Number(document.getElementById('statTotal').textContent) || 0),
      (n) => n > 0, 25000
    );
    check(total === site.total, '图库里嗅探到全部图片', total + ' vs ' + site.total);

    // 等定位生效（focusImage 里 scrollIntoView 是平滑滚动）
    const focused = await until(
      () => gallery.evaluate(() => {
        const el = document.querySelector('#grid .card.ih-focus');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { id: el.dataset.id, title: el.title, top: Math.round(r.top), bottom: Math.round(r.bottom),
          vh: window.innerHeight };
      }),
      (v) => v && v.top > -50 && v.bottom < v.vh + 50, 12000
    );
    console.log('  定位到的卡片 =', JSON.stringify(focused));

    check(!!focused, '图库里出现了被高亮的卡片（.ih-focus）');
    check(await gallery.evaluate(() => document.querySelectorAll('#grid .card.ih-focus').length) === 1,
      '高亮的卡片只有一张');
    check(!!focused && basename(focused.title) === basename(sentUrl),
      '高亮的就是刚在灯箱里看的那张',
      focused && (basename(focused.title) + ' vs ' + basename(sentUrl)));
    check(!!focused && focused.top >= -50 && focused.bottom <= focused.vh + 50,
      '卡片已经被滚进视口', focused && (focused.top + '~' + focused.bottom + ' / 视口 ' + focused.vh));

    // 原页面的灯箱应该自己收掉了
    await sleep(400);
    const stillOpen = await page.evaluate(() => {
      const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
      return hosts.some((h) => {
        const lb = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
        return lb && lb.classList.contains('ih-show');
      });
    });
    check(stillOpen === false, '原页面的灯箱已经收掉（用户已经在图库那边了）');

    /* ---------- 3. 图库页自己的灯箱不显示这个按钮 ---------- */
    console.log('\n=== 3. 图库页的灯箱不显示这个按钮 ===');

    await gallery.locator('#grid .card .zoom').first().click();
    const gb = await until(
      () => gallery.evaluate(() => {
        const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
        for (const h of hosts) {
          const lb = h.shadowRoot && h.shadowRoot.querySelector('.ih-lb');
          if (!lb || !lb.classList.contains('ih-show')) continue;
          const g = lb.querySelector('[data-act="gallery"]');
          return { visible: !!(g && g.getBoundingClientRect().width > 0), display: g ? g.style.display : null };
        }
        return null;
      }),
      (v) => v !== null, 8000
    );
    check(!!gb, '图库页里的灯箱打开了');
    check(!!gb && gb.visible === false, '图库页里的灯箱**不显示**「在图库中打开」',
      gb && ('display=' + gb.display));
    await gallery.keyboard.press('Escape');
    await sleep(400);

    /* ---------- 4. 关掉图库再打开：走缓存并如实标注 ---------- */
    console.log('\n=== 4. 重开图库走缓存，并如实标注 ===');

    const tabId = await targetTabId();
    check(tabId != null, '拿得到目标标签页 id');

    await gallery.close();
    await sleep(600);

    const t0 = Date.now();
    const g2Promise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (id) => { await openGallery(id); }, tabId);
    const g2 = await g2Promise;
    await g2.waitForLoadState('domcontentloaded');

    const note = await until(
      () => g2.evaluate(() => {
        const el = document.getElementById('cacheNote');
        return {
          hidden: el.hidden,
          text: el.textContent || '',
          total: Number(document.getElementById('statTotal').textContent) || 0
        };
      }),
      (v) => v && v.total > 0, 20000
    );
    const elapsed = Date.now() - t0;
    console.log('  第二次打开：' + elapsed + 'ms，cacheNote =', JSON.stringify(note));

    check(!!note && note.total === site.total, '缓存里也是全部图片', note && note.total);
    check(!!note && note.hidden === false, '出现了「复用缓存」的标记（如实告知）');
    check(!!note && /复用/.test(note.text), '标记文案说的是「复用」', note && note.text);
    check(!!note && /重新嗅探/.test(note.text), '标记上写明了可以重新嗅探', note && note.text);

    /* ---------- 5. 重新嗅探：标记消失 ---------- */
    console.log('\n=== 5. 「重新嗅探」绕过缓存 ===');

    await g2.locator('#btnRescan').click();
    const after = await until(
      () => g2.evaluate(() => {
        const el = document.getElementById('cacheNote');
        return {
          hidden: el.hidden,
          total: Number(document.getElementById('statTotal').textContent) || 0,
          toast: (document.getElementById('toast') || {}).textContent || ''
        };
      }),
      (v) => v && v.total > 0 && v.hidden === true, 25000
    );
    check(!!after && after.hidden === true, '重新嗅探后缓存标记消失（真的重扫了）',
      after && JSON.stringify(after));
    check(!!after && after.total === site.total, '重扫后数量不变', after && after.total);

    /* ---------- 6. 点标记本身也能刷新 ---------- */
    console.log('\n=== 6. 缓存标记本身就是刷新入口 ===');

    await g2.close();
    await sleep(500);
    const g3Promise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (id) => { await openGallery(id); }, tabId);
    const g3 = await g3Promise;
    await g3.waitForLoadState('domcontentloaded');
    const n3 = await until(
      () => g3.evaluate(() => {
        const el = document.getElementById('cacheNote');
        return { hidden: el.hidden, total: Number(document.getElementById('statTotal').textContent) || 0 };
      }),
      (v) => v && v.total > 0 && v.hidden === false, 20000
    );
    check(!!n3 && n3.hidden === false, '第三次打开又命中了缓存');

    await g3.locator('#cacheNote').click();
    const n4 = await until(
      () => g3.evaluate(() => {
        const el = document.getElementById('cacheNote');
        return { hidden: el.hidden, total: Number(document.getElementById('statTotal').textContent) || 0 };
      }),
      (v) => v && v.total > 0 && v.hidden === true, 25000
    );
    check(!!n4 && n4.hidden === true, '点标记之后也真的重扫了', n4 && JSON.stringify(n4));

    await g3.close();
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    await ctx.close();
    await site.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
