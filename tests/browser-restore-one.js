/* ImageHunter — 真实浏览器：没还原成功的图可以**单独重试**
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是这条体验缺口：
 *   原图还原有 8 秒时间预算（scanner.js RESTORE_TIME_BUDGET），按文档顺序推进，
 *   超预算时牺牲的一定是**靠后的图片** —— 它们会保持页面上的缩略图地址。
 *   这些图用户看得见，却无从补救：唯一的路是「重新嗅探」，而重跑大概率还是超时。
 *
 * 修法：
 *   restored !== true 且**确实存在原图候选**的卡片上多一个「还原」小按钮，
 *   点它就对这一张单独重跑一次 tryRestore（走 RESTORE_ONE 消息链路：
 *   图库 → 后台 → 拥有这张图的 frame）。
 *
 * 两个容易写错的地方，本套件专门盯着：
 *   ① 还原会改 URL → id（= quickHash(normalizeUrl(url))）跟着变。如果直接重绘整格，
 *      用户刚勾的图会全掉、排序一变卡片还会跳走。正确做法是只动这一张：
 *      id / 勾选 / 体积缓存一起搬，再原地替换那一个卡片元素。
 *   ② probeSize 会把**失败**结果（null）也缓存起来。上一次因探测超时 / 网络抖动
 *      而失败的候选，重试时会直接命中缓存里的「失败」，按钮点了等于没点。
 *      所以重试必须带 refresh，只清 sizeCache、不清 inflight。
 *
 * 覆盖：
 *   1. 第一轮还原失败的图：保留缩略图地址 + 有「还原」按钮；已还原的没有按钮
 *   2. 核心：点「还原」→ 这一张变成原图（原地、同一张图、勾选不丢、不重扫）
 *   3. 只有这一张被改（其余失败的图不受影响）
 *   4. 候选确实不可用时：按钮收掉 + 如实提示，不是假装成功
 *   5. 对照：本来就是原图的页面（生成不出任何候选）→ 一个按钮都没有
 *   6. iframe 里的图片也能单张还原，而且候选**只被请求了一次**
 *      （验证后台按 frameId 定位，而不是广播给每个 frame 各跑一遍）
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
const PROFILE = path.join(os.tmpdir(), 'ih-restore-one-profile-' + Date.now());

const COLS = 4, ROWS = 4;
const TOTAL = COLS * ROWS;      // 16 张
const FAIL_FROM = 8;            // 第 8 张之后（含）的候选地址暂时不可用
const OK_COUNT = FAIL_FROM;     // 第一轮能还原成功的张数

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 缩略图地址 /thumb/img/N.png → 图片本体标识 img/N.png（还原前后靠它对齐） */
const bodyOf = (url) => String(url || '').replace('/thumb/img/', '/img/');

/** 图库当前状态。url 用 card.title（buildCard 里 title = c.url） */
function snapshot() {
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  return {
    total: Number((document.getElementById('statTotal') || {}).textContent || 0),
    selected: Number((document.getElementById('statSelected') || {}).textContent || 0),
    cards: cards.length,
    restored: cards.filter((c) => c.querySelector('.badge.restored')).length,
    btns: cards.filter((c) => c.querySelector('.restore')).length,
    toast: (document.getElementById('toast') || {}).textContent || '',
    rows: cards.map((c) => ({
      body: String(c.title).replace('/thumb/img/', '/img/'),
      url: c.title,
      restored: !!c.querySelector('.badge.restored'),
      btn: !!c.querySelector('.restore'),
      selected: c.classList.contains('selected'),
      dim: (c.querySelector('.dim') || {}).textContent || ''
    }))
  };
}

/** 某张图片本体对应的卡片当前状态（找不到返回 null） */
function cardOf(body) {
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  const hit = cards.find((c) => String(c.title).replace('/thumb/img/', '/img/') === body);
  if (!hit) return null;
  return {
    body,
    url: hit.title,
    restored: !!hit.querySelector('.badge.restored'),
    btn: !!hit.querySelector('.restore'),
    selected: hit.classList.contains('selected'),
    dim: (hit.querySelector('.dim') || {}).textContent || ''
  };
}

/** 点击某张卡片的「还原」按钮 */
function clickRestoreOn(body) {
  const cards = Array.from(document.querySelectorAll('#grid .card'));
  const hit = cards.find((c) => String(c.title).replace('/thumb/img/', '/img/') === body);
  if (!hit) return 'card-not-found';
  const btn = hit.querySelector('.restore');
  if (!btn) return 'no-button';
  btn.click();
  return 'ok';
}

/** 轮询直到 ok() 为真，返回最后一次快照 */
async function poll(page, evalFn, arg, ok, budgetMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budgetMs) {
    last = await page.evaluate(evalFn, arg);
    if (ok(last)) return last;
    await sleep(100);
  }
  return last;
}

/**
 * 等图库切到某个站点、并且这一轮扫描**彻底结束**。
 *
 * 两个坑：
 *  ① 图库会复用同一个标签页（openGallery → GALLERY_TARGET），上一个站点的数量
 *     还挂在 statTotal 上，新站点数量更少时「数量 ≥ N」一上来就成立 ——
 *     测的是上一轮的残留数据。卡片 URL 里带着端口，用它认站点最稳。
 *  ② 「先出图、后升级」意味着第一版结果（未还原）会**先**铺出来，
 *     只看「卡片齐了」会拿到 partial，restored 全是 0。所以必须等到状态稳定：
 *     (restored, btns, cards) 连续 1.2 秒不变才算这一轮真的结束。
 */
async function waitSite(page, port, total, budgetMs) {
  const t0 = Date.now();
  let last = null;
  let lastKey = '';
  let stableSince = 0;

  while (Date.now() - t0 < (budgetMs || 40000)) {
    const s = await page.evaluate(snapshot);
    last = s;
    const okSite = s.cards === total
      && s.rows.length === total
      && s.rows.every((r) => r.url.indexOf(':' + port + '/') >= 0);

    if (okSite) {
      const key = s.restored + '/' + s.btns + '/' + s.cards;
      if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
      else if (Date.now() - stableSince > 1200) return s;
    } else {
      lastKey = '';
    }
    await sleep(120);
  }
  return last;
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  /* 站点 A：缩略图 400x300 放 /thumb/，原图 800x600 放 /img/。
     前 8 张候选正常，后 8 张候选暂时 404 —— 于是第一轮只还原成功 8 张，
     另外 8 张停在缩略图地址上，正是「撞上预算 / 探测失败」留下的那批图。
     用 404 而不是延迟：更快、更确定，也顺带覆盖「失败结果被缓存」这个坑。 */
  const flagA = { on: true };
/* 尺寸的**较短边**必须 > 图库尺寸滑条默认的 256px（v1.11.0 起开箱按短边 256 过滤）。
     用 600×400 + thumbPath 时页面上的缩略图是 300×200 —— 短边只有 200，会被整片挡住。
     本用例测的是「没还原成功的图能单独重试」，
     不该被尺寸过滤干扰，所以夹具必须稳稳过门槛。 */
  const site = await startServer({
    cols: COLS, rows: ROWS, imgW: 800, imgH: 600, thumbPath: true,
    candidateFail: (i) => flagA.on && i >= FAIL_FROM
  });
  console.log('测试站点 A =', site.url, '（' + TOTAL + ' 张，第 ' + FAIL_FROM + ' 张起的候选先失败）');

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
    const src = await ctx.newPage();
    await src.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await src.bringToFront();
    await sleep(2000);                 // 让页面自己的缩略图先加载完

    const galleryPromise = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, site.port);
    const gallery = await galleryPromise;
    await gallery.waitForLoadState('domcontentloaded');

    /* --------------------------------------------------------------- *
     * 1. 第一轮：失败的图保留缩略图地址，并且长出了「还原」按钮
     * --------------------------------------------------------------- */
    console.log('\n=== 1. 第一轮还原失败的图：保留缩略图 + 有「还原」按钮 ===');

    const s1 = await waitSite(gallery, site.port, TOTAL);

    check(s1 && s1.total === TOTAL, '图库拿到全部 ' + TOTAL + ' 张', s1 && s1.total);
    check(s1 && s1.restored === OK_COUNT,
      '第一轮只有 ' + OK_COUNT + ' 张还原成功（后 ' + (TOTAL - OK_COUNT) + ' 张候选不可用）',
      s1 && s1.restored);
    check(s1 && s1.btns === TOTAL - OK_COUNT,
      '另外 ' + (TOTAL - OK_COUNT) + ' 张各有一个「还原」按钮', s1 && s1.btns);

    if (!s1 || s1.btns !== TOTAL - OK_COUNT) {
      console.log('  · 实际状态：' + JSON.stringify(s1 && {
        restored: s1.restored, btns: s1.btns,
        rows: s1.rows.map((r) => r.body + (r.restored ? ':原图' : '') + (r.btn ? ':按钮' : ''))
      }));
      console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
      await ctx.close(); site.close();
      process.exit(1);
    }

    // 按钮必须长在**对的那批卡片**上：有按钮 ⇔ 没还原，一一对应
    const mismatch = s1.rows.filter((r) => r.btn === r.restored);
    check(mismatch.length === 0,
      '「有按钮」与「没还原」严格一一对应（没有按钮长错地方）',
      JSON.stringify(mismatch.slice(0, 3)));
    check(s1.rows.filter((r) => !r.restored).every((r) => r.url.indexOf('/thumb/') >= 0),
      '没还原的那些卡片地址确实还是缩略图地址');
    check(s1.rows.filter((r) => r.restored).every((r) => r.url.indexOf('/thumb/') < 0),
      '已还原的那些卡片地址是原图地址');
    check(s1.rows.filter((r) => !r.restored).every((r) => r.dim === '400×300'),
      '没还原的卡片显示的是缩略图尺寸 400×300',
      JSON.stringify(s1.rows.filter((r) => !r.restored).map((r) => r.dim).slice(0, 3)));

    /* --------------------------------------------------------------- *
     * 2. 核心：点「还原」，这一张变成原图
     * --------------------------------------------------------------- */
    console.log('\n=== 2. 核心：点「还原」→ 这一张变成原图 ===');

    const target = s1.rows.find((r) => !r.restored).body;   // 例如 img/8.png
    console.log('目标图片 =', target);

    // 先把它勾上 —— 还原会改 URL（id 跟着变），这一勾就是防回归的探针
    await gallery.evaluate((b) => {
      const cards = Array.from(document.querySelectorAll('#grid .card'));
      const hit = cards.find((c) => String(c.title).replace('/thumb/img/', '/img/') === b);
      if (hit) hit.querySelector('.pick').click();
    }, target);
    await sleep(150);

    const before = await gallery.evaluate(cardOf, target);
    check(before && before.selected === true, '还原前已勾选这一张', before && String(before.selected));
    check(before && before.dim === '400×300', '还原前尺寸文案是 400×300', before && before.dim);

    // 放行候选地址，然后点「还原」
    flagA.on = false;
    const clicked = await gallery.evaluate(clickRestoreOn, target);
    check(clicked === 'ok', '找到并点了「还原」按钮', clicked);

    const after = await poll(gallery, cardOf, target, (r) => r && r.restored, 20000);

    check(after && after.restored === true, '这一张变成了原图（出现「原图」角标）',
      after && String(after.restored));
    check(after && after.url.indexOf('/thumb/') < 0 && after.url.indexOf('/img/') >= 0,
      '卡片地址换成了原图地址（/thumb/ 已去掉）', after && after.url);
    check(after && after.body === target,
      '换地址前后是**同一张图**（按图片本体对齐，不是碰巧别的卡片被改了）',
      after && after.body);
    check(after && after.dim === '800×600', '尺寸文案更新成了原图的 800×600', after && after.dim);
    check(after && after.btn === false, '还原成功后「还原」按钮收掉了', after && String(after.btn));

    // 勾选必须跟着搬过去
    const nowAll = await gallery.evaluate(snapshot);
    check(nowAll.selected === 1, '勾选数量没变（还是 1 张）', nowAll.selected);
    check(nowAll.rows.filter((r) => r.selected).length === 1
      && nowAll.rows.filter((r) => r.selected)[0].body === target,
      '而且勾着的**就是刚才那一张**（还原改 URL 不该把勾选弄丢）',
      JSON.stringify(nowAll.rows.filter((r) => r.selected).map((r) => r.body)));
    check(nowAll.total === TOTAL && nowAll.cards === TOTAL,
      '没有触发重新扫描（总数与卡片数都不变）',
      nowAll.total + '/' + nowAll.cards);

    /* --------------------------------------------------------------- *
     * 3. 只动了这一张
     * --------------------------------------------------------------- */
    console.log('\n=== 3. 只动了这一张，其余失败的图不受影响 ===');
    check(nowAll.restored === OK_COUNT + 1,
      '还原成功的张数只 +1（' + (OK_COUNT + 1) + '）', nowAll.restored);
    check(nowAll.btns === TOTAL - OK_COUNT - 1,
      '「还原」按钮只少了一个（' + (TOTAL - OK_COUNT - 1) + ' 个）', nowAll.btns);

    /* --------------------------------------------------------------- *
     * 4. 候选确实不可用时：如实说，并且把按钮收掉
     * --------------------------------------------------------------- */
    console.log('\n=== 4. 候选确实不可用时：如实提示 + 收掉按钮 ===');
    const target2 = nowAll.rows.find((r) => !r.restored).body;
    flagA.on = true;                       // 让这一张的候选继续不可用
    const clicked2 = await gallery.evaluate(clickRestoreOn, target2);
    check(clicked2 === 'ok', '第二张也点到了「还原」', clicked2);

    const after2 = await poll(gallery, cardOf, target2, (r) => r && !r.btn, 20000);
    check(after2 && after2.restored === false,
      '没有假装成功：它仍然是缩略图地址', after2 && after2.url);
    check(after2 && after2.btn === false,
      '确认没有更大的原图后按钮收掉了（不再勾着用户重复点）', after2 && String(after2.btn));

    const t2 = await gallery.evaluate(snapshot);
    check(/最大的版本/.test(t2.toast),
      '如实提示「这张图已经是能拿到的最大的版本了」', t2.toast);

    /* --------------------------------------------------------------- *
     * 5. 对照：本来就是原图的页面 → 一个「还原」按钮都没有
     * --------------------------------------------------------------- */
    console.log('\n=== 5. 对照：生成不出任何候选的页面 → 没有「还原」按钮 ===');
    const plain = await startServer({ cols: 3, rows: 2, imgW: 600, imgH: 400 });
    const plainPage = await ctx.newPage();
    await plainPage.goto(plain.url, { waitUntil: 'load', timeout: 60000 });
    await plainPage.bringToFront();
    await sleep(1500);

    // openGallery 会复用已开着的图库标签页（并广播 GALLERY_TARGET 让它换目标），
    // 所以这里不能等新页面事件 —— 直接用同一个 gallery。
    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, plain.port);

    const s5 = await waitSite(gallery, plain.port, plain.total, 30000);
    check(s5 && s5.cards === plain.total, '对照站拿到 ' + plain.total + ' 张', s5 && s5.cards);
    check(s5 && s5.btns === 0,
      '页面上的图本来就是原图，一个「还原」按钮都没有', s5 && s5.btns);
    plainPage.close();
    plain.close();

    /* --------------------------------------------------------------- *
     * 6. iframe 里的图片：能单张还原，而且候选只被请求一次
     * --------------------------------------------------------------- */
    console.log('\n=== 6. iframe 里的图片：单张还原 + 候选只请求一次 ===');
    const flagF = { on: true };
    // 同第 1 节：短边必须 > 尺寸滑条默认的 256px（600×400 + thumbPath 的缩略图是 300×200，会被挡住）
    const framed = await startServer({
      cols: 2, rows: 2, imgW: 800, imgH: 600, thumbPath: true, iframe: true,
      candidateFail: () => flagF.on
    });
    const fPage = await ctx.newPage();
    await fPage.goto(framed.url, { waitUntil: 'load', timeout: 60000 });
    await fPage.bringToFront();
    await sleep(2000);

    await sw.evaluate(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      await openGallery(t.id);
    }, framed.port);

    const s6 = await waitSite(gallery, framed.port, framed.total, 30000);
    check(s6 && s6.cards === framed.total,
      'iframe 里的 ' + framed.total + ' 张都被嗅探到', s6 && s6.cards);
    check(s6 && s6.btns === framed.total,
      '每张都拿到了「还原」按钮（第一轮全部失败）', s6 && s6.btns);

    if (s6 && s6.btns === framed.total) {
      const tgt = s6.rows[0].body;
      const idx = Number(/(\d+)\.png$/.exec(tgt)[1]);
      flagF.on = false;
      framed.resetFullLog();                    // 只看这一次重试发了多少请求

      const c3 = await gallery.evaluate(clickRestoreOn, tgt);
      check(c3 === 'ok', '在 iframe 场景下也点到了「还原」', c3);

      const a3 = await poll(gallery, cardOf, tgt, (r) => r && r.restored, 20000);
      check(a3 && a3.restored === true,
        'iframe 里的这张图也成功还原了（frameId 转发链路通）', a3 && a3.url);
      check(a3 && a3.dim === '800×600', '尺寸更新成 800×600', a3 && a3.dim);

      // 关键：页面有 2 个 frame（顶层 + iframe）。如果后台忘了带 frameId 而广播，
      // 两个 frame 的内容脚本都会跑一遍同样的探测，这里就会看到 2 次。
      const hits = framed.fullHits(idx);
      check(hits === 1,
        '候选地址只被请求了 1 次（说明按 frameId 定位到了 iframe，没有广播给每个 frame）',
        '实际 ' + hits + ' 次');
    }

    fPage.close();
    framed.close();

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
