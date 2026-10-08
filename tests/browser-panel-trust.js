/* ImageHunter — 真实浏览器：页内面板的「来源校验」
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 回归的是 AUDIT P3-7：
 *
 *   页内面板 = 「网页里的 iframe 加载扩展页 popup.html?mode=panel&tabId=N」。
 *   popup/* 必须在 web_accessible_resources 里（否则 iframe 加载不了），
 *   代价是**任何网站都能构造同款 iframe** —— 把图库叠在自己页面上做套壳点击，
 *   或者靠「能不能加载这个资源」探测用户装没装本扩展。
 *
 * 修法：
 *   ① manifest 把 popup/* 通配收窄成三个具体文件（将来往 popup/ 里加文件不会再被
 *      自动暴露，是「默认安全」而不是「默认暴露」）；
 *   ② 内容脚本先向后台领一个只属于本标签页的随机 token 写进 iframe URL，
 *      面板启动时拿它回后台核验 —— 网页拿不到 token（它没法给后台发消息），
 *      伪造的 iframe 一律拒绝启动。
 *
 * 覆盖：
 *   正面：正常打开面板 → iframe URL 带 tabId + token → 图库真的渲染出图片
 *   反面 A：网页自己 iframe popup.html（不带 token）→ 拒绝启动，不出图库
 *   反面 B：网页自己 iframe popup.html（带一个瞎编的 token）→ 同样拒绝
 *   反面 C：网页拿另一个标签页的 tabId 配自己的 token → 拒绝
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
const PROFILE = path.join(os.tmpdir(), 'ih-panel-trust-profile-' + Date.now());

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里找到面板的 shadow host，读出 iframe 的 src */
function panelSrc() {
  const hosts = Array.from(document.querySelectorAll('[data-ih-host]'));
  for (const h of hosts) {
    const sr = h.shadowRoot;
    if (!sr) continue;
    const f = sr.querySelector('.ih-panel-frame');
    if (f) return { src: f.getAttribute('src') || '', open: h.classList.contains('ih-open') };
  }
  return null;
}

/** 等某个 frame 里的图库渲染出卡片；返回状态 */
async function frameState(frame, budgetMs) {
  let waited = 0;
  let last = null;
  while (waited < budgetMs) {
    try {
      last = await frame.evaluate(() => ({
        hasGrid: !!document.getElementById('grid'),
        cards: document.querySelectorAll('#grid .card').length,
        total: (document.getElementById('statTotal') || {}).textContent || '',
        // 空态文案：尺寸滑条默认 256px，这个站的图只有 200×140，会被整片挡掉。
        // 断言「网格里有没有卡片」已经不足以说明面板是否正常 —— 得看它是**哪一种**空。
        emptyShown: !(document.getElementById('empty') || {}).hidden,
        emptyText: (document.getElementById('emptyText') || {}).textContent || '',
        emptyHint: (document.getElementById('emptyHint') || {}).textContent || '',
        actionText: (document.getElementById('emptyClearSize') || {}).textContent || '',
        actionShown: !!document.getElementById('emptyClearSize')
          && !document.getElementById('emptyClearSize').hidden,
        text: (document.body.textContent || '').slice(0, 120)
      }));
      if (last.cards > 0) return last;
    } catch (e) { last = { error: String(e && e.message) }; }
    await sleep(300);
    waited += 300;
  }
  return last;
}

/** 等某个 frame 进入「拒绝启动」态 */
async function waitRefused(frame, budgetMs) {
  let waited = 0;
  let last = null;
  while (waited < budgetMs) {
    try {
      last = await frame.evaluate(() => ({
        hasGrid: !!document.getElementById('grid'),
        cards: document.querySelectorAll('#grid .card').length,
        text: (document.body.textContent || '').slice(0, 120)
      }));
      if (/已拒绝/.test(last.text)) return last;
    } catch (e) { last = { error: String(e && e.message) }; }
    await sleep(200);
    waited += 200;
  }
  return last;
}

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  /* fixture-ok: 故意用小图 —— 这一节测的正是「尺寸默认 256 把 200×140 整片挡住时，
     面板是否给出如实解释与一键出口」，夹具必须落在门槛之下。 */
  const site = await startServer({ cols: 8, rows: 5, imgW: 200, imgH: 140 });
  console.log('测试页地址 =', site.url, '（' + site.total + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const EXT_ID = new URL(sw.url()).host;
  console.log('扩展 ID =', EXT_ID);

  try {
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: 'load', timeout: 60000 });
    await page.bringToFront();
    await sleep(2500);

    /* ---------- 1. 正面：正常打开面板 ---------- */
    console.log('\n=== 1. 正常打开页内面板（内容脚本领了 token）===');
    await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf('127.0.0.1') >= 0);
      await chrome.tabs.sendMessage(t.id, { type: 'IH_OPEN_PANEL' }, { frameId: 0 });
    });
    await sleep(2500);

    const ps = await page.evaluate(panelSrc);
    console.log('面板 iframe src =', ps && ps.src);
    check(ps != null, '页面里出现了面板 iframe');
    check(ps && /mode=panel/.test(ps.src), 'iframe URL 带 mode=panel');
    check(ps && /[?&]tabId=\d+/.test(ps.src), 'iframe URL 带 tabId');
    check(ps && /[?&]token=[0-9a-z]{8,}/i.test(ps.src),
      'iframe URL 带内容脚本领到的 token', ps && ps.src.replace(/token=\w+/, 'token=<...>'));

    const panelFrame = page.frames().find((f) => f.url().indexOf('popup/popup.html') >= 0);
    check(panelFrame != null, '能在页面里定位到面板 frame');
    let st = await frameState(panelFrame, 25000);
    console.log('面板内状态 =', JSON.stringify(st));
    /* 这个站的图是 200×140，而尺寸滑条**默认 256px** —— 所以面板正确打开后
       网格就是空的，而且必须是**带解释的那种**空（v1.11.0 之前是一句
       「没有符合当前筛选条件的图片」，用户会以为嗅探坏了）。
       所以这里不再断言「有卡片」，改断言「面板启动了 + 空态说清了是尺寸挡的 + 有一键出口」。
       真正「有卡片」的验证交给后面点一下出口按钮再断言一次 —— 那样才同时证明了
       token 路径通、以及出口真的能用。 */
    check(st && st.hasGrid, '面板真的启动了（token 校验通过，渲染出了网格容器）',
      st && JSON.stringify({ hasGrid: st.hasGrid, cards: st.cards, emptyText: st.emptyText }));
    check(st && st.emptyShown, '尺寸默认 256px，200×140 的图被整片挡住 → 显示空态');
    check(st && /被「最小尺寸 ≥ 256px」挡住了/.test(st.emptyText),
      '空态如实说明是尺寸过滤挡的（而不是含糊的「没有符合筛选条件」）',
      st && st.emptyText);
    check(st && st.actionShown, '空态给出「一键关掉尺寸过滤」的出口', st && st.actionText);
    check(st && Number(st.total) >= site.total, '面板嗅探到 ' + site.total + ' 张图片',
      st && st.total);

    // 点那个出口 → 图片应该全都回来（顺带证明这条出口真的接上了）
    await panelFrame.evaluate(() => {
      const b = document.getElementById('emptyClearSize');
      if (b) b.click();
    });
    st = await frameState(panelFrame, 12000);
    console.log('点「' + st.actionText + '」后 =', JSON.stringify({
      cards: st.cards, emptyShown: st.emptyShown, total: st.total
    }));
    check(st && st.cards > 0, '点出口后图片全部回来（出口真的能用）', st && st.cards + ' 张');
    check(st && !st.emptyShown, '点出口后空态收起了');

    // 关掉面板，避免干扰后面的反面用例
    await page.evaluate(() => {
      const h = document.querySelector('.ih-panel-host');
      if (h) h.classList.remove('ih-open');
    });
    await sleep(400);

    /* ---------- 2. 反面 A：网页自己 iframe，不带 token ---------- */
    console.log('\n=== 2. 反面 A：网页自己 iframe（无 token）===');
    await page.evaluate((id) => {
      const f = document.createElement('iframe');
      f.id = 'evil1';
      f.style.cssText = 'position:fixed;left:-9999px;width:600px;height:600px';
      f.src = 'chrome-extension://' + id + '/popup/popup.html?mode=panel&tabId=1';
      document.body.appendChild(f);
    }, EXT_ID);
    await sleep(2500);

    const evil1 = page.frames().find((f) => f.url().indexOf('evil') >= 0
      || (f.url().indexOf('popup/popup.html') >= 0 && f.url().indexOf('token=') < 0
          && f !== panelFrame));
    const e1 = await waitRefused(evil1, 12000);
    console.log('无 token 的伪造 iframe =', JSON.stringify(e1));
    check(e1 && /已拒绝/.test(e1.text), '无 token 时拒绝启动并说明原因', e1 && e1.text);
    check(e1 && !e1.hasGrid && e1.cards === 0, '拒绝时连图库界面都不渲染（没有可被套壳点击的东西）',
      e1 && ('hasGrid=' + e1.hasGrid + ', ' + e1.cards + ' 张卡片'));

    /* ---------- 3. 反面 B：网页自己 iframe，带瞎编的 token ---------- */
    console.log('\n=== 3. 反面 B：网页自己 iframe（伪造 token）===');
    await page.evaluate((id) => {
      const f = document.createElement('iframe');
      f.id = 'evil2';
      f.style.cssText = 'position:fixed;left:-9999px;width:600px;height:600px';
      f.src = 'chrome-extension://' + id + '/popup/popup.html?mode=panel&tabId=1&token=fakefakefake';
      document.body.appendChild(f);
    }, EXT_ID);
    await sleep(2500);

    const evil2 = page.frames().find((f) => f.url().indexOf('token=fakefakefake') >= 0);
    const e2 = await waitRefused(evil2, 12000);
    console.log('伪造 token 的 iframe =', JSON.stringify(e2));
    check(e2 && /已拒绝/.test(e2.text), '伪造 token 被拒绝', e2 && e2.text);
    check(e2 && !e2.hasGrid && e2.cards === 0, '伪造 token 时连图库界面都不渲染',
      e2 && ('hasGrid=' + e2.hasGrid + ', ' + e2.cards + ' 张卡片'));

    /* ---------- 4. 反面 C：token 与 tabId 不配对 ---------- */
    console.log('\n=== 4. 反面 C：拿别的标签页的 tabId 配自己的 token ===');
    // 从真实面板的 URL 里取到 token，但换一个 tabId 用 —— 应当拒绝
    const realToken = (ps.src.match(/[?&]token=([^&]+)/) || [])[1] || '';
    check(!!realToken, '取到了真实 token 用于本用例', realToken ? realToken.slice(0, 8) + '…' : '');

    await page.evaluate(({ id, tok }) => {
      const f = document.createElement('iframe');
      f.id = 'evil3';
      f.style.cssText = 'position:fixed;left:-9999px;width:600px;height:600px';
      f.src = 'chrome-extension://' + id + '/popup/popup.html?mode=panel&tabId=999999&token=' + tok;
      document.body.appendChild(f);
    }, { id: EXT_ID, tok: realToken });
    await sleep(2500);

    const evil3 = page.frames().find((f) => f.url().indexOf('tabId=999999') >= 0);
    const e3 = await waitRefused(evil3, 12000);
    console.log('错配 tabId 的 iframe =', JSON.stringify(e3));
    check(e3 && /已拒绝/.test(e3.text), 'token 与 tabId 不配对时被拒绝', e3 && e3.text);
    check(e3 && !e3.hasGrid && e3.cards === 0, '错配时连图库界面都不渲染',
      e3 && ('hasGrid=' + e3.hasGrid + ', ' + e3.cards + ' 张卡片'));

    /* ---------- 5. 收窄后的 WAR 仍然够用 ---------- */
    console.log('\n=== 5. web_accessible_resources 收窄后仍可加载 ===');
    const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    const war = ((mf.web_accessible_resources || [])[0] || {}).resources || [];
    console.log('WAR =', JSON.stringify(war));
    check(war.indexOf('popup/*') < 0, '不再用 popup/* 通配暴露整个目录');
    check(war.indexOf('popup/popup.html') >= 0, 'popup.html 仍在清单里（面板需要它）');
    check(war.indexOf('content/overlay.css') >= 0, 'overlay.css 仍在清单里（页内 UI 需要它）');
    // 面板在收窄后依然能完整工作 —— 上面第 1 节已经证明（卡片 > 0）

    /* 面板页自己 `<link>` / `<script src>` 引的那几个文件**不需要** WAR：
       它们由扩展页（chrome-extension:// 同源）内部加载，WAR 只管「让网页也能拿到」。
       把它们留着只会白白扩大指纹面。这条断言防的是「有人图省事又加回来」。 */
    ['popup/popup.css', 'popup/popup.js', 'popup/mode.js'].forEach((r) => {
      check(war.indexOf(r) < 0,
        r + ' 不在 WAR 里（它由扩展页内部加载，不需要对网页暴露）');
    });
    // 反向确认：这几个文件**确实**被 popup.html 自己引用（否则上面的收窄就没意义了）
    const pHtml = fs.readFileSync(path.join(EXT, 'popup/popup.html'), 'utf8');
    check(/href="popup\.css"/.test(pHtml), 'popup.html 自己 link 了 popup.css（所以不需要 WAR）');
    check(/src="mode\.js"/.test(pHtml), 'popup.html 自己 script 了 mode.js（所以不需要 WAR）');
    check(/src="popup\.js"/.test(pHtml), 'popup.html 自己 script 了 popup.js（所以不需要 WAR）');

    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } finally {
    await ctx.close();
    site.close();
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
