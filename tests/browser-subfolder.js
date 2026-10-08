/* ImageHunter — 真实浏览器：保存到子目录
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 为什么必须真浏览器：`chrome.downloads.download` 的 `filename` 能不能带 `/`、
 * 带 `/` 之后 Chrome 会不会接受，是**接口层面**的事 —— 单元测试里
 * `buildFilename` 拼出来的字符串再正确也证明不了这一点。
 *
 * ---------------------------------------------------------------------------
 * 一个必须写下来的限制：**CDP 接管下载时会丢掉子目录**
 *
 * 这个套件要断言「文件真的落在 下载目录/<子目录>/ 里」，实测**做不到**：
 * 只要用了 `Browser.setDownloadBehavior`（或 `Page.setDownloadBehavior`）
 * 把下载目录指到 DL，Chrome 就只取扩展给的 filename 的**最后一段**：
 *
 *     扩展请求 filename = 'sub/one/a.png'，downloadPath = DL
 *     实测落盘       = DL/a.png          ← sub/one 没了
 *     chrome.downloads 报告的 filename 也是 DL\a.png
 *
 * 两种 CDP 命令都试过，行为一致。而**不用** CDP 更糟：Playwright 会接管下载，
 * 文件名被换成 GUID 落到它自己的 artifacts 目录（`acceptDownloads: false` 则
 * 因为无头模式弹不出下载确认框直接 USER_CANCELED）。
 * 也就是说在这套脚手架里，「子目录真的建出来了」这件事**测不到**。
 *
 * 所以这里改成断言**扩展的决策**（交给 chrome.downloads 的那串 filename）
 * 加上 Chrome **接受了**它（state === complete，没有 error）。
 * 前者是我们要负责的部分，后者能挡住「路径非法 → 下载直接失败」。
 * 谁要是以后想在文件系统上断言，先看上面这段，别白费力气。
 * ---------------------------------------------------------------------------
 *
 * 覆盖：
 *   1. `{host}`：交给 Chrome 的路径是 `127.0.0.1/0.png`
 *   2. `{date}/{host}`：两级子目录，`{date}` 展开成 YYYYMMDD
 *   3. 留空：回到只有文件名的老行为
 *   4. **路径安全**：`../../escape` 不许往上跳、不许是绝对路径、不许带盘符
 *   5. 历史记录里存的是含子目录的相对路径
 *   6. 气泡不能因为「带子目录」就谎报「实际为 xxx」（那是 renamed 的误判）
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
const PROFILE = path.join(os.tmpdir(), 'ih-subdir-profile-' + Date.now());
const DL = path.join(os.tmpdir(), 'ih-subdir-downloads-' + Date.now());

const COLS = 2, ROWS = 2;
const HOST = '127.0.0.1';

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

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
};

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.mkdirSync(DL, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DL }
  }));

  const site = await startServer({ cols: COLS, rows: ROWS, imgW: 600, imgH: 400, title: '子目录测试站' });
  console.log('测试站点 =', site.url, '（' + site.total + ' 张）');

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

  /* 记录「扩展到底把什么路径交给了 chrome.downloads」。
     这是本套件的核心地面真相 —— 见文件顶部关于 CDP 丢子目录的说明。 */
  await sw.evaluate(() => {
    globalThis.__dlCalls = [];
    const orig = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = function (opts) {
      globalThis.__dlCalls.push({ filename: opts && opts.filename, conflictAction: opts && opts.conflictAction });
      return orig(opts);
    };
  });

  const dlCalls = () => sw.evaluate(() => globalThis.__dlCalls.slice());
  const resetDlCalls = () => sw.evaluate(() => { globalThis.__dlCalls.length = 0; });

  async function seedSubfolder(tpl) {
    await sw.evaluate(async (v) => {
      const cur = (await chrome.storage.local.get('ih_settings')).ih_settings || {};
      cur.subfolder = v;
      await chrome.storage.local.set({ ih_settings: cur });
    }, tpl);
    const got = await until(() => sw.evaluate(() => IH.Store.getSettings().subfolder),
      (v) => v === tpl, 6000);
    console.log('  后台看到的 subfolder =', JSON.stringify(got));
  }

  /** 悬停第 i 张图 → 点下载 → 等气泡出结果 */
  async function downloadByIndex(page, i) {
    await page.evaluate((idx) => {
      const im = document.images[idx];
      im.setAttribute('data-ih-pick', '1');
      im.scrollIntoView({ block: 'center' });
    }, i);
    await sleep(400);
    await page.hover('[data-ih-pick="1"]');
    await sleep(700);
    await page.locator('[data-ih-host] .ih-hover-save').first().click({ force: true });

    const bubble = await until(
      () => page.locator('[data-ih-host] .ih-bubble').first()
        .evaluate((el) => el.textContent).catch(() => null),
      (t) => t && /已保存|已下载|失败/.test(t),
      20000
    );
    console.log('  气泡:', JSON.stringify(bubble));
    await page.evaluate(() => {
      const im = document.querySelector('[data-ih-pick="1"]');
      if (im) im.removeAttribute('data-ih-pick');
    });
    return bubble;
  }

  /** 后台刚处理完的那次下载的真实状态 */
  const lastDownload = () => sw.evaluate(async () => {
    const items = await chrome.downloads.search({ limit: 3, orderBy: ['-startTime'] });
    return items.map((i) => ({ filename: i.filename, state: i.state, error: i.error || null }));
  });

  try {
    const page = await ctx.newPage();
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    } catch (e) { console.log('CDP 失败:', e.message); }

    /* ---------- 1. {host} ---------- */
    console.log('\n=== 1. subfolder = "{host}" ===');
    await seedSubfolder('{host}');
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    await resetDlCalls();
    const bubble1 = await downloadByIndex(page, 0);
    const calls1 = await dlCalls();
    console.log('  交给 chrome.downloads 的 filename =', JSON.stringify(calls1));

    check(calls1.length === 1, '这次下载只调用了一次 chrome.downloads.download', calls1.length + ' 次');
    check(!!calls1[0] && calls1[0].filename === HOST + '/0.png',
      '交给 Chrome 的路径是 ' + HOST + '/0.png', calls1[0] && calls1[0].filename);
    check(!!calls1[0] && calls1[0].conflictAction === 'uniquify',
      '仍然带 conflictAction:uniquify（同名不覆盖）', calls1[0] && calls1[0].conflictAction);

    const dl1 = await until(() => lastDownload(), (l) => l.length > 0 && l[0].state !== 'in_progress', 10000);
    check(!!dl1[0] && dl1[0].state === 'complete',
      'Chrome 接受了这个路径（下载完成，没有报错）', JSON.stringify(dl1[0]));
    check(!!dl1[0] && dl1[0].error == null, '没有 error', dl1[0] && dl1[0].error);

    check(!!bubble1 && /已保存/.test(bubble1), '气泡说「已保存」', bubble1);
    check(!!bubble1 && /→\s*127\.0\.0\.1\//.test(bubble1),
      '气泡告诉用户存到了 127.0.0.1/ 这一层（否则只能拿着文件名瞎找）', bubble1);
    check(!!bubble1 && !/实际为/.test(bubble1),
      '气泡**不**谎报「实际为 xxx」—— 带子目录不等于被浏览器改名', bubble1);

    const hist = await sw.evaluate(async () => (await IH.Store.getHistory()).slice(0, 1));
    console.log('  历史记录:', JSON.stringify(hist));
    check(!!hist[0] && hist[0].filename === HOST + '/0.png',
      '历史里存的是含子目录的相对路径', hist[0] && hist[0].filename);
    check(!!hist[0] && hist[0].bytes === site.originalBytes(0),
      '字节数与服务器上的原图一致', hist[0] && (hist[0].bytes + ' vs ' + site.originalBytes(0)));

    /* ---------- 2. {date}/{host} ---------- */
    console.log('\n=== 2. subfolder = "{date}/{host}" ===');
    await seedSubfolder('{date}/{host}');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);

    await resetDlCalls();
    await downloadByIndex(page, 1);
    const calls2 = await dlCalls();
    console.log('  交给 chrome.downloads 的 filename =', JSON.stringify(calls2));
    check(!!calls2[0] && calls2[0].filename === today() + '/' + HOST + '/1.png',
      '两级子目录 ' + today() + '/' + HOST + '/1.png', calls2[0] && calls2[0].filename);

    const dl2 = await until(() => lastDownload(), (l) => l.length > 0 && l[0].state !== 'in_progress', 10000);
    check(!!dl2[0] && dl2[0].state === 'complete', 'Chrome 接受了这个两级路径', JSON.stringify(dl2[0]));

    /* ---------- 3. 路径安全 ---------- */
    console.log('\n=== 3. 往上跳的模板（安全边界） ===');
    await seedSubfolder('../../escape');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);

    await resetDlCalls();
    await downloadByIndex(page, 2);
    const calls3 = await dlCalls();
    console.log('  交给 chrome.downloads 的 filename =', JSON.stringify(calls3));
    const got3 = (calls3[0] && calls3[0].filename) || '';
    check(got3 === 'escape/2.png', '`..` 被丢掉，只剩 escape/2.png', got3);
    check(got3.indexOf('..') < 0, '路径里不含 ..（不许往上跳）', got3);
    check(got3.charAt(0) !== '/', '不是绝对路径', got3);
    check(!/^[a-zA-Z]:/.test(got3), '不带盘符', got3);
    check(got3.split('/').length <= 4, '目录层数有上限（模板写飞了也不会挖深井）', got3);

    const dl3 = await until(() => lastDownload(), (l) => l.length > 0 && l[0].state !== 'in_progress', 10000);
    check(!!dl3[0] && dl3[0].state === 'complete', 'Chrome 接受了清理后的路径', JSON.stringify(dl3[0]));

    /* ---------- 4. 留空 ---------- */
    console.log('\n=== 4. subfolder 留空 ===');
    await seedSubfolder('');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);

    await resetDlCalls();
    const bubble4 = await downloadByIndex(page, 3);
    const calls4 = await dlCalls();
    console.log('  交给 chrome.downloads 的 filename =', JSON.stringify(calls4));
    check(!!calls4[0] && calls4[0].filename === '3.png',
      '留空时只有文件名，回到老行为', calls4[0] && calls4[0].filename);
    check(!!bubble4 && !/→/.test(bubble4),
      '留空时气泡不提目录（没有目录可提）', bubble4);

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
