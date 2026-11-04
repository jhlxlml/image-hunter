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
 * 修法（v1.20.0 改过一轮，见下面「为什么不能把 token 放进 URL」）：
 *   ① manifest 把 popup/* 通配收窄成三个具体文件（将来往 popup/ 里加文件不会再被
 *      自动暴露，是「默认安全」而不是「默认暴露」）；
 *   ② 内容脚本先向后台领一个只属于本标签页的随机 token，
 *      **用 postMessage 点对点交给面板**，面板启动时拿它回后台核验；
 *   ③ 后台用 `sender.tab.id` 判身份，**不认消息里自报的 tabId**；
 *   ④ 独立页（?mode=page）也必须过校验，且必须证明自己没被嵌进别人的页面。
 *
 * 为什么不能把 token 放进 URL（这是 v1.20.0 修的那个洞）：
 *   iframe 的 src 是**页面 DOM 里的属性**。面板的 host 挂在网页里，
 *   shadow root 又是 `mode: 'open'`，于是网页脚本一句
 *   `host.shadowRoot.querySelector('iframe').src` 就把 token 读走了。
 *   读到之后它就能自己拼一个 `?mode=panel&tabId=N&token=<真 token>`，
 *   校验完全拦不住 —— 等于白做。postMessage 发给 `frame.contentWindow`
 *   的消息只有那个 window 收得到，网页脚本听不见，这才是点对点。
 *
 * 覆盖：
 *   正面：正常打开面板 → iframe src 里**没有任何凭据** → 图库真的渲染出图片
 *   反面 A：网页自己 iframe popup.html?mode=panel（没有 token）→ 拒绝启动
 *   反面 B：网页自己 iframe，URL 里塞一个瞎编的 token → 拒绝（URL token 一律不认）
 *   反面 C：网页脚本往**真面板**投假 init（改 tabId + 假 token）→ 面板不受影响
 *   反面 D：网页脚本往真面板投不带 token 的 refresh → 不触发
 *   反面 E：网页自己 iframe popup.html?mode=page → 拒绝（以前这里完全不校验）
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

/**
 * 以**网页脚本的视角**扫一遍页面，看能不能捞到任何凭据。
 * 这里用的就是攻击者的写法：遍历 `[data-ih-host]`，进 `shadowRoot`（open 才进得去），
 * 把 iframe 的 src 和整段 shadow HTML 都抓出来。
 */
function scanForCreds() {
  const out = { srcs: [], html: '', iframes: 0 };
  for (const h of Array.from(document.querySelectorAll('[data-ih-host]'))) {
    const sr = h.shadowRoot;
    if (!sr) continue;
    out.html += sr.innerHTML;
    for (const f of Array.from(sr.querySelectorAll('iframe'))) {
      out.iframes++;
      out.srcs.push(f.getAttribute('src') || '');
    }
  }
  return out;
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

    /* 这一段是本套件的核心：**网页脚本读得到 iframe 的 src**，
       所以 src 里不许有任何凭据。以前 token 就写在上面。 */
    const creds = await page.evaluate(scanForCreds);
    console.log('网页脚本能看到的 iframe src =', JSON.stringify(creds.srcs));
    check(creds.iframes >= 1, '网页脚本确实摸得到面板 iframe（攻击面是真实存在的，不是假想）');
    check(creds.srcs.every((s) => !/[?&]token=/i.test(s)),
      'iframe src 里没有 token（token 走 postMessage 点对点交接，网页读不到）',
      creds.srcs.join(' | '));
    check(creds.srcs.every((s) => !/[?&]tabId=/i.test(s)),
      'iframe src 里没有 tabId（扫描目标由后台按 sender.tab.id 回答）',
      creds.srcs.join(' | '));
    check(!/token=/i.test(creds.html), '整个 shadow DOM 里都搜不到 token=');
    check(!/[?&]token=/i.test(ps.src), 'panelSrc 读到的 src 也没有 token');

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

    /* ---------- 4. 反面 C：网页脚本往**真面板**里投假消息 ----------
     *
     * 这一节是 v1.20.0 新增的。旧实现的 onParentMessage 既不校验 e.source，
     * 又允许 init 改 tabId —— 网页脚本一句 postMessage 就能把面板的扫描目标
     * 换成任意标签页（面板有跨标签页嗅探能力，这等于白送一个读别处的口子）。
     */
    console.log('\n=== 4. 反面 C：网页脚本往真面板里投假 init（改 tabId）===');
    const before = await frameState(panelFrame, 6000);
    console.log('投毒前 =', JSON.stringify({ cards: before && before.cards, total: before && before.total }));

    await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll('[data-ih-host]'))
        .find((x) => x.shadowRoot && x.shadowRoot.querySelector('.ih-panel-frame'));
      const f = h.shadowRoot.querySelector('.ih-panel-frame');
      /* 冒充宿主，把完整的攻击链走一遍：
         ① init 换 tabId 到 999999 + 塞假 token（旧实现会当场改掉 tabId）
         ② refresh 强制重扫（旧实现不校验 token，会真的去扫那个标签页）
         两步合起来才能观察到「目标被换掉了」—— 只发 init 不重扫，
         变量变了但界面不动，断言看不出来。 */
      f.contentWindow.postMessage(
        { __ih: true, type: 'init', tabId: 999999, token: 'evil-token-1234' }, '*');
      f.contentWindow.postMessage({ __ih: true, type: 'refresh' }, '*');
    });
    await sleep(3000);

    const after = await frameState(panelFrame, 10000);
    console.log('投毒后 =', JSON.stringify({ cards: after && after.cards, total: after && after.total }));
    check(after && after.hasGrid, '投毒后面板还在（没有崩、没有退回拒绝态）');
    check(after && after.cards > 0, '投毒后照常显示图片（没有切到 tabId=999999 那个不存在的标签页）',
      after && after.cards + ' 张');
    check(after && before && after.total === before.total,
      '投毒后扫描目标没变（统计数一致：' + (before && before.total) + ' → ' + (after && after.total) + '）');

    /* ---------- 5. 反面 D：不带 token 的 refresh 不生效 ---------- */
    console.log('\n=== 5. 反面 D：网页脚本发不带 token 的 refresh ===');
    await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll('[data-ih-host]'))
        .find((x) => x.shadowRoot && x.shadowRoot.querySelector('.ih-panel-frame'));
      const f = h.shadowRoot.querySelector('.ih-panel-frame');
      f.contentWindow.postMessage({ __ih: true, type: 'refresh' }, '*');
      f.contentWindow.postMessage({ __ih: true, type: 'refresh', token: 'wrong-token' }, '*');
    });
    await sleep(2000);
    const afterRefresh = await frameState(panelFrame, 8000);
    check(afterRefresh && afterRefresh.cards > 0,
      '无 token / 错 token 的 refresh 被忽略，面板照常显示', afterRefresh && afterRefresh.cards + ' 张');
    check(afterRefresh && after.total === before.total, '无 token 的 refresh 没有引发重扫（统计数未变）');

    /* ---------- 6. 反面 E：网页 iframe 一个 mode=page ----------
     *
     * 这是 v1.20.0 修掉的第二个洞：旧 verifyPanelOrigin 对 mode=page
     * 直接 `return true`，理由是「网页碰不到」—— 而网页可以 iframe 它。
     * 那等于给网页一个零成本、功能完整的图库套壳。
     */
    console.log('\n=== 6. 反面 E：网页 iframe popup.html?mode=page ===');
    await page.evaluate((id) => {
      const f = document.createElement('iframe');
      f.id = 'evil-page';
      f.style.cssText = 'position:fixed;left:-9999px;width:900px;height:700px';
      f.src = 'chrome-extension://' + id + '/popup/popup.html?mode=page';
      document.body.appendChild(f);
    }, EXT_ID);
    await sleep(2500);

    const evilPage = page.frames().find((f) => /mode=page/.test(f.url()));
    const ePage = await waitRefused(evilPage, 12000);
    console.log('被嵌入的 mode=page =', JSON.stringify(ePage));
    check(ePage && /已拒绝/.test(ePage.text), '被网页嵌入的 mode=page 拒绝启动', ePage && ePage.text);
    check(ePage && !ePage.hasGrid && ePage.cards === 0,
      '被嵌入的 mode=page 连图库界面都不渲染（网页拿不到可套壳的东西）',
      ePage && ('hasGrid=' + ePage.hasGrid + ', ' + ePage.cards + ' 张卡片'));

    /* 反向确认：扩展自己开的**顶层** mode=page 必须照常工作 ——
       否则上面那条「拒绝」可能只是「mode=page 整个坏了」。 */
    console.log('\n=== 7. 正面：扩展自己开的顶层图库页仍然可用 ===');
    const gallery = await ctx.newPage();
    await gallery.goto('chrome-extension://' + EXT_ID + '/popup/popup.html?mode=page&tabId=1',
      { waitUntil: 'load', timeout: 30000 });
    await sleep(2500);
    const g = await gallery.evaluate(() => ({
      hasGrid: !!document.getElementById('grid'),
      refused: /已拒绝/.test(document.body.textContent || '')
    }));
    console.log('顶层图库页 =', JSON.stringify(g));
    check(g.hasGrid && !g.refused, '顶层 mode=page 通过校验（GALLERY_AUTH 没有误伤正常用法）');
    await gallery.close();

    /* ---------- 8. 收窄后的 WAR 仍然够用 ---------- */
    console.log('\n=== 8. web_accessible_resources 收窄后仍可加载 ===');
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
