/* ImageHunter — 真实浏览器：诊断包导出全链路
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 * 自建一个本地 HTTP 页面（12 张真实 PNG），不依赖外网。
 *
 * 为什么需要这一套（`test-diagnostics.js` 已经测过纯函数了）：
 * 纯函数测试只能证明「给它一组原料，它能拼出干净的结果」。
 * 但用户真正点的是设置页上那个按钮，中间还隔着四段可能悄悄断掉的接线：
 *
 *   设置页 → `U.sendToBg(GET_DIAGNOSTICS)` → background 回原料
 *          → `IH.Diag.build()` → `audit()` → `U.downloadText()`
 *
 * 这四段里任何一段坏了，界面表现都是「点了按钮，什么也没发生」——
 * 而纯函数测试全绿。所以这里在**真浏览器 + 真扩展**里把整条路走一遍：
 * 先真扫一次（让 background 真的攒下一份扫描摘要），再点按钮，
 * 把 `U.downloadText` 截下来看它到底拿到了什么。
 *
 * 覆盖：
 *   - 按钮存在且可点，点击后确实产出了一份 payload（不是「什么都没发生」）
 *   - 文件名是 image-hunter-diag-<时间戳>.json
 *   - `_app` / `_format` / `_version`（必须等于 manifest 里的版本）
 *   - `lastScan` 真的来自刚才那次扫描：pageHost / found / sourceCounts
 *   - `settings` 带上了真实设置；`blockedHosts` 只留条数、清单本身不出现
 *   - `probe` 是一组计数
 *   - **整份 payload 里没有任何 http(s) 地址**（这条是最重要的）
 *   - 落盘前的 `audit()` 没有把导出拦下来（说明它认可自己产出的东西）
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
const PROFILE = path.join(os.tmpdir(), 'ih-diag-profile-' + Date.now());

const SITE_OPTS = { cols: 4, rows: 3, imgW: 600, imgH: 400 };   // 12 张，短边 400 > 尺寸滑条默认 256
const TOTAL = SITE_OPTS.cols * SITE_OPTS.rows;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log('扩展 ID =', extId);

  /* ---------- 1. 先真扫一次，让 background 攒下扫描摘要 ---------- */
  console.log('\n=== 1. 真扫一次（诊断包里的 lastScan 必须有东西）===');
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
  await sleep(4000);

  const scanned = await gallery.evaluate(() => document.querySelectorAll('#grid .card').length);
  console.log('图库渲染出 ' + scanned + ' 张卡片');
  check(scanned >= TOTAL, '图库真的扫出了 ' + TOTAL + ' 张图', scanned + ' 张');

  // 顺手确认 background 那边确实记下了摘要（而不是等导出了才发现是空的）。
  //
  // ⚠️ 这里**不能**用 `chrome.runtime.sendMessage` 去问：从 service worker 自己的
  // 上下文发消息**不会**触发它自己的 `onMessage`（同上下文不互相投递），
  // 拿回来永远是 undefined。直接调它的函数读内存里的那份才是对的。
  const summary = await sw.evaluate(async () => ({
    lastScan: await loadLastScan()
  }));
  console.log('  background 的 lastScan =', JSON.stringify(summary && summary.lastScan));
  check(!!(summary && summary.lastScan), '扫描摘要在扫描后确实存在');
  check(summary && summary.lastScan && summary.lastScan.pageHost === '127.0.0.1',
    '摘要里的 pageHost 是这次扫描的站点', summary && summary.lastScan && summary.lastScan.pageHost);
  check(summary && summary.lastScan && summary.lastScan.found >= TOTAL,
    '摘要里的 found 与真实张数对得上', summary && summary.lastScan && summary.lastScan.found);
  check(summary && summary.lastScan && summary.lastScan.sourceCounts
    && Object.keys(summary.lastScan.sourceCounts).length > 0,
    '摘要里有来源分布', JSON.stringify(summary && summary.lastScan && summary.lastScan.sourceCounts));
  check(!(summary && summary.lastScan && ('pageUrl' in summary.lastScan)),
    '摘要里没有 pageUrl 字段（只留主机名）');

  /* ---------- 2. 写一条排除列表，验「只留条数」 ---------- */
  console.log('\n=== 2. 排除列表只留条数 ===');
  const BLOCKED = ['bank.example.com', 'intranet.corp.local'];
  await sw.evaluate(async (list) => {
    const cur = (await chrome.storage.local.get('ih_settings')).ih_settings || {};
    cur.blockedHosts = list;
    await chrome.storage.local.set({ ih_settings: cur });
  }, BLOCKED);
  await sleep(600);
  const seen = await sw.evaluate(() => (IH.Store.getSettings().blockedHosts || []).slice());
  console.log('  后台看到的排除列表 =', JSON.stringify(seen));
  check(JSON.stringify(seen) === JSON.stringify(BLOCKED), '排除列表已写入并被后台读到', JSON.stringify(seen));

  /* ---------- 3. 打开设置页并点「导出诊断包」 ---------- */
  console.log('\n=== 3. 设置页 → 导出诊断包 ===');
  const optionsPage = await ctx.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await sleep(1200);

  const btn = await optionsPage.evaluate(() => {
    const b = document.getElementById('btnExportDiag');
    return b ? { text: b.textContent.trim(), hidden: b.offsetParent === null } : null;
  });
  console.log('  按钮 =', JSON.stringify(btn));
  check(!!btn, '#btnExportDiag 存在');
  check(btn && btn.text === '导出诊断包', '按钮文案正确', btn && btn.text);
  check(btn && btn.hidden === false, '按钮可见（不是被 CSS 藏起来的）');

  /* 把 U.downloadText 截下来。
     为什么不真去读磁盘上的下载文件：CDP 接管下载时文件名会被改写成随机名
     （见 tests/README 第五个坑），「找到那个文件」本身就是个不稳的活儿。
     而这里真正要断言的是**产出的内容**，截下来看最直接。
     顺带记一笔 audit 有没有拦下导出 —— 拦下来的话 downloadText 根本不会被调用。 */
  await optionsPage.evaluate(() => {
    window.__diag = null;
    window.__origDownloadText = window.IH.U.downloadText;
    window.IH.U.downloadText = function (name, text, mime) {
      window.__diag = { name: name, text: text, mime: mime };
    };
  });

  await optionsPage.evaluate(() => document.getElementById('btnExportDiag').click());
  await sleep(1500);

  const captured = await optionsPage.evaluate(() => window.__diag);
  check(!!captured, '点击后确实调用了 downloadText（不是「点了没反应」）');
  if (!captured) {
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    await ctx.close();
    localSite.close();
    process.exit(1);
  }

  console.log('  文件名 = ' + captured.name);
  console.log('  mime  = ' + captured.mime);
  check(/^image-hunter-diag-\d{8}-\d{6}\.json$/.test(captured.name), '文件名格式正确', captured.name);
  check(captured.mime === 'application/json', 'mime 是 application/json', captured.mime);

  let diag = null;
  try { diag = JSON.parse(captured.text); } catch (e) { /* 下面会报 */ }
  check(!!diag, 'payload 是合法 JSON');
  if (!diag) {
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    await ctx.close();
    localSite.close();
    process.exit(1);
  }

  /* ---------- 4. payload 内容 ---------- */
  console.log('\n=== 4. payload 内容 ===');
  const mfVersion = await optionsPage.evaluate(() => chrome.runtime.getManifest().version);
  console.log('  _version =', diag._version, ' / manifest =', mfVersion);
  check(diag._app === 'image-hunter', '_app 正确', diag._app);
  check(diag._format === 1, '_format = 1', String(diag._format));
  check(diag._version === mfVersion, '_version 与 manifest 一致', diag._version + ' vs ' + mfVersion);
  check(/^\d{4}-\d{2}-\d{2}T/.test(diag.createdAt || ''), 'createdAt 是 ISO 时间', diag.createdAt);
  check(!!(diag.platform && diag.platform.userAgent), 'platform.userAgent 有值');
  check(!!diag.settings && typeof diag.settings === 'object', 'settings 是一个对象');
  check(diag.settings && diag.settings.blockedHostsCount === BLOCKED.length,
    'settings 里带上排除列表的**条数**', String(diag.settings && diag.settings.blockedHostsCount));
  check(!(diag.settings && ('blockedHosts' in diag.settings)),
    'settings 里**没有**排除列表清单本身');

  check(!!diag.lastScan, 'lastScan 存在（说明走了真扫描那条路）');
  check(diag.lastScan && diag.lastScan.pageHost === '127.0.0.1',
    'lastScan.pageHost 是刚才那个站', diag.lastScan && diag.lastScan.pageHost);
  check(diag.lastScan && diag.lastScan.found >= TOTAL,
    'lastScan.found 与真实张数对得上', diag.lastScan && diag.lastScan.found);
  check(!!(diag.lastScan && diag.lastScan.sourceCounts), 'lastScan 带来源分布');
  check(!(diag.lastScan && ('pageUrl' in diag.lastScan)), 'lastScan 里没有 pageUrl');
  check(Array.isArray(diag.recentDownloads), 'recentDownloads 是数组');
  check(diag.probe === null || (typeof diag.probe === 'object' && typeof diag.probe.ok === 'number'),
    'probe 是一组计数（或 null）', JSON.stringify(diag.probe));
  check(Array.isArray(diag.notes) && diag.notes.length > 0, '带 notes 说明');

  /* ---------- 5. 最重要的那条：整份 payload 里没有任何地址 ---------- */
  console.log('\n=== 5. 边界：一个地址都不能有 ===');
  const raw = captured.text;
  check(raw.indexOf('http://') < 0, 'payload 里没有 http://');
  check(raw.indexOf('https://') < 0, 'payload 里没有 https://');
  check(raw.indexOf('127.0.0.1:') < 0 && raw.indexOf('localhost:') < 0, 'payload 里没有带端口的本机地址');
  check(raw.indexOf('/img/') < 0, 'payload 里没有图片路径');
  check(raw.indexOf('bank.example.com') < 0 && raw.indexOf('intranet.corp.local') < 0,
    'payload 里没有被排除的站点域名');
  const allHosts = JSON.stringify(diag).match(/[a-z][a-z0-9+.-]*:\/\//gi) || [];
  check(allHosts.length === 0, '整份 payload 里 scheme:// 出现 0 次', allHosts.join(','));

  /* ---------- 6. 自查没有被拦下（说明 audit 认可自己的产出） ---------- */
  console.log('\n=== 6. audit 自查 ===');
  const auditResult = await optionsPage.evaluate((text) => {
    return window.IH.Diag.audit(JSON.parse(text));
  }, raw);
  console.log('  audit =', JSON.stringify(auditResult));
  check(Array.isArray(auditResult) && auditResult.length === 0,
    'audit 对这份 payload 判定为干净', JSON.stringify(auditResult));

  // 反证：往 payload 里塞一个地址，audit 必须报出来（否则上面那条是恒真的）
  const poisoned = await optionsPage.evaluate((text) => {
    const o = JSON.parse(text);
    o.settings.__probe = 'https://leak.example/x';
    return window.IH.Diag.audit(o);
  }, raw);
  console.log('  注入地址后 audit =', JSON.stringify(poisoned));
  check(poisoned.length === 1 && poisoned[0] === '$.settings.__probe',
    '注入一个地址后 audit 如实报出路径（证明上一条不是恒真）', JSON.stringify(poisoned));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  await ctx.close();
  localSite.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
