/* ImageHunter — 真实浏览器：主题系统
 *
 * 依赖与用法同 browser-lang.js（playwright-core + 本机 Edge / Chrome）。
 * 自建本地 HTTP 页面（真实 PNG），不依赖外网。
 *
 * 这个套件存在的理由：主题的**静态**守卫（validate.js 第 19 节）只能证明
 * 「文件引了、顺序对、token 名对得上」，证明不了「换了之后画面真的变了」。
 * 而主题恰好有一串「静态全对、跑起来是错的」坏法：
 *
 *   1. **apply() 写了变量，但元素用的是另一套变量名。**
 *      改主色时按钮变了、角标没变 —— 单看按钮是「对的」。
 *   2. **内容脚本的面板/悬停条不跟主题走。**
 *      图库页切了深色、页内面板还是浅的。这两个走的是完全不同的代码路径
 *      （apply 写 <html> vs applyToHost 写 shadow host），静态守卫看不出。
 *   3. **宿主页面被污染。**
 *      内容脚本写错了节点，把网站自己的深色模式顶掉。
 *      视觉上是「这个扩展坏了我的网站」，而扩展自己的界面一切正常。
 *   4. **跨页面不同步。** 设置页切了，已经开着的图库不跟着变。
 *   5. **灯箱被主题带跑。** 灯箱是**恒深色**的显式设计（浅色遮罩会让图片
 *      边缘糊进背景），如果它跟着浅色主题变白，图片周围会糊成一片 ——
 *      这是设计决策，不是 bug，所以必须有断言守着它别被"顺手统一"掉。
 *
 * 所以这里真的点色卡、真的拖取色器、真的开一个内容脚本面板，
 * 然后分别检查 computed style（不是 class 名，是**最终颜色**）。
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
const PROFILE = path.join(os.tmpdir(), 'ih-theme-profile-' + Date.now());

const SITE_OPTS = { cols: 4, rows: 3, imgW: 600, imgH: 400 };
const TOTAL = SITE_OPTS.cols * SITE_OPTS.rows;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点一下亮暗档位 */
async function pickMode(page, value) {
  await page.evaluate((v) => {
    const b = document.querySelector('#segTheme button[data-v="' + v + '"]');
    if (b) b.click();
  }, value);
  await sleep(700);
}

/** 点一下第 i 张色卡（i 是 presetList 的下标） */
async function pickPreset(page, i) {
  await page.evaluate((idx) => {
    const box = document.getElementById('themeSwatches');
    if (box && box.children[idx]) box.children[idx].click();
  }, i);
  await sleep(700);
}

/**
 * 读一个元素**最终算出来的**颜色。
 *
 * 为什么不用 class 名 / 属性做断言：主题的正确性最终体现在像素上。
 * `data-theme="dark"` 挂着、但 CSS 里的选择器写错一个字符 —— 属性断言全绿，
 * 界面还是白的。getComputedStyle 走的是浏览器真正采纳的那套值。
 */
const styleOf = (page, sel, props) => page.evaluate(({ sel, props }) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const out = {};
  props.forEach((p) => { out[p] = cs.getPropertyValue(p).trim(); });
  return out;
}, { sel, props });

/** 读 <html> 上的主题属性与内联主色 */
const themeState = (page) => page.evaluate(() => {
  const el = document.documentElement;
  return {
    mode: el.getAttribute('data-theme'),
    primary: el.style.getPropertyValue('--primary').trim(),
    solid: el.style.getPropertyValue('--primary-solid').trim(),
    bg: getComputedStyle(el).getPropertyValue('--bg').trim(),
    swatchCount: (document.getElementById('themeSwatches') || { children: [] }).children.length,
    activeSwatch: Array.from((document.getElementById('themeSwatches') || { children: [] }).children)
      .findIndex((c) => c.classList.contains('active')),
    accentLabel: (document.querySelector('#accentPick .accent-label') || {}).textContent,
    resetDisabled: (document.getElementById('btnAccentReset') || {}).disabled
  };
});

/** 把 token 换算成可比较的 rgb 串（CSS 里写的是 hex 或 rgba） */
const rgbOf = (page, value) => page.evaluate((v) => {
  const d = document.createElement('div');
  d.style.color = v;
  document.body.appendChild(d);
  const out = getComputedStyle(d).color;
  d.remove();
  return out;
}, value);

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  console.log('测试页地址 =', localSite.url, '（' + TOTAL + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    /* 钉死中文：这套件不测语言，但 locale 会影响界面语言，
       中文文案长度与英文不同，可能改变布局（进而改变某些测量值）。
       钉死之后本地与 CI 的差别不会混进来。 */
    locale: 'zh-CN',
    headless: true,
    viewport: { width: 1280, height: 900 },
    /* 强制浅色系统偏好：后面要验「auto 跟随系统」，
       在 headless 里系统偏好默认是 light，正好用来做基线。 */
    colorScheme: 'light',
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log('扩展 ID =', extId);

  try {
    /* ---------- 0. 开一个真网页 ---------- */
    const site = await ctx.newPage();
    await site.goto(localSite.url, { waitUntil: 'load', timeout: 60000 });
    await site.bringToFront();
    await sleep(1500);

    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options/options.html`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(1200);

    /* ---------- 1. 色卡渲染 ---------- */
    console.log('\n=== 1. 设置页色卡 ===');
    const init = await themeState(opt);
    console.log('  初始主题状态 =', JSON.stringify(init));
    check(init.swatchCount === 6, '色卡渲染出 6 张（对应 PRESETS 六套）', String(init.swatchCount));
    check(init.activeSwatch === 0, '默认高亮第 1 张（indigo）', String(init.activeSwatch));
    check(init.resetDisabled === true, '没自定义主色时「恢复」按钮是禁用态', String(init.resetDisabled));

    /* ---------- 2. 切深色：面色真的变了 ---------- */
    console.log('\n=== 2. 切深色 ===');
    const lightBg = await rgbOf(opt, init.bg);
    await pickMode(opt, 'dark');
    const dark = await themeState(opt);
    const darkBg = await rgbOf(opt, dark.bg);
    console.log('  --bg: 浅色 ' + lightBg + ' → 深色 ' + darkBg);
    check(dark.mode === 'dark', 'data-theme 变成 dark', String(dark.mode));
    check(lightBg !== darkBg, '--bg 的实际颜色变了（不是只换了属性）', lightBg + ' → ' + darkBg);
    /* 深色的亮度必须更低。用「谁更深」判而不是等值比较 —— 色值随设计调整。 */
    const lum = (s) => {
      const m = s.match(/\d+/g);
      return m ? (+m[0]) * 0.299 + (+m[1]) * 0.587 + (+m[2]) * 0.114 : 0;
    };
    check(lum(darkBg) < lum(lightBg), '深色档确实更暗（不是换成了另一种浅色）',
      lum(lightBg).toFixed(0) + ' → ' + lum(darkBg).toFixed(0));

    /* ---------- 3. 换预设：主色跟着变成那一套 ---------- */
    console.log('\n=== 3. 换配色方案（靛蓝 → 翡翠）===');
    await pickMode(opt, 'light');
    await pickPreset(opt, 2);   // presetList 顺序: indigo, teal, emerald, ...
    const em = await themeState(opt);
    console.log('  换预设后 =', JSON.stringify(em));
    check(em.activeSwatch === 2, '高亮移到第 3 张色卡', String(em.activeSwatch));
    /* 翡翠的浅色档是 #12915a —— 换成绿色，和默认蓝差得很远，
       一眼能看出「真的换了一套」而不是「其实没生效」。 */
    const emRgb = await rgbOf(opt, em.primary);
    const greenish = (() => {
      const m = emRgb.match(/\d+/g);
      return m && (+m[1]) > (+m[2]) && (+m[1]) > (+m[0]);
    })();
    check(greenish, '主色真的变成了偏绿的一套（不是还留着蓝）', emRgb);
    check(em.solid !== '', '--primary-solid 也写上了（角标底色跟着走）', em.solid);

    /* ---------- 4. 自定义主色：取色器 ---------- */
    console.log('\n=== 4. 自定义主色（设成 #ff8800）===');
    /* 直接设 input 的值再派发 input/change —— 原生取色器的弹窗在 headless
       里没法点。派发的事件和真人拖动时浏览器发的是同一对，
       所以走的是同一条代码路径（input 只改界面、change 才落盘）。 */
    await opt.evaluate(() => {
      const el = document.getElementById('themeAccent');
      el.value = '#ff8800';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(700);

    const custom = await themeState(opt);
    console.log('  自定义后 =', JSON.stringify(custom));
    const cRgb = await rgbOf(opt, custom.primary);
    check(/255,\s*136,\s*0/.test(cRgb), '主色变成用户选的橙色', cRgb);
    check(custom.resetDisabled === false, '有自定义主色后「恢复」按钮可点了', String(custom.resetDisabled));
    check(/ff8800/i.test(custom.accentLabel || ''), '标签显示当前色值（而不是「选一个颜色」）',
      String(custom.accentLabel));

    /* ---------- 5. 恢复跟随配色方案 ---------- */
    console.log('\n=== 5. 恢复跟随配色方案 ===');
    await opt.evaluate(() => document.getElementById('btnAccentReset').click());
    await sleep(700);
    const reset = await themeState(opt);
    const rRgb = await rgbOf(opt, reset.primary);
    console.log('  恢复后 =', JSON.stringify({ primary: reset.primary, rgb: rRgb }));
    check(!/255,\s*136,\s*0/.test(rRgb), '主色不再是橙色（真的清掉了）', rRgb);
    check(reset.resetDisabled === true, '「恢复」按钮回到禁用态', String(reset.resetDisabled));
    /* 这里**不能**断言「内联 --primary 为空」—— apply() 的契约是
       「内联永远写下当前生效的主色」（预设档也一样），这样内联优先级
       才能稳定压住 :root，不必依赖「有没有内联」这个隐藏状态。
       clearAccent（把内联全删掉）只在 derived 为空时走，预设永远不为空，
       所以那条路径由 jsdom 套件单独测（test-theme.js 第 5 节）。
       这里要钉的是「内联写的**不是**用户那个橙色了」。 */
    check(reset.primary !== '#ff8800' && /^#[0-9a-f]{6}$/i.test(reset.primary),
      '内联主色换成了预设档的色（不是残留的 #ff8800）', JSON.stringify(reset.primary));
    check(reset.primary === '#12915a',
      '内联主色就是翡翠预设的浅色档（说明内联与 :root 用的是同一套值）',
      String(reset.primary));

    /* ---------- 6. auto 跟随系统 ---------- */
    console.log('\n=== 6. auto 跟随系统 ===');
    await pickMode(opt, 'auto');
    const autoState = await themeState(opt);
    /* 启动时 colorScheme: 'light' → auto 应落到 light */
    check(autoState.mode === 'light', 'auto 在浅色系统偏好下落到 light', String(autoState.mode));

    /* ---------- 7. 跨页面：图库跟着设置页变 ---------- */
    console.log('\n=== 7. 图库跟着变（跨页面） ===');
    await pickMode(opt, 'dark');
    await pickPreset(opt, 1);   // teal
    await sleep(400);

    const gallery = await ctx.newPage();
    await gallery.goto(`chrome-extension://${extId}/popup/popup.html?mode=page`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(3500);

    const g = await gallery.evaluate(() => {
      const el = document.documentElement;
      return {
        mode: el.getAttribute('data-theme'),
        primary: el.style.getPropertyValue('--primary').trim(),
        cards: document.querySelectorAll('#grid .card').length,
        bodyBg: getComputedStyle(document.body).backgroundColor
      };
    });
    console.log('  图库主题 =', JSON.stringify(g));
    check(g.mode === 'dark', '图库启动就是深色（设置是共享的）', String(g.mode));
    check(g.primary !== '', '图库也应用了主色（teal 的深色档）', g.primary);
    check(g.cards >= TOTAL, '图库扫出了 ' + TOTAL + ' 张图', g.cards + ' 张');

    /* 在设置页改成浅色 + 玫红，已开着的图库必须当场跟着变 */
    console.log('\n=== 8. 设置页改动，图库当场跟着变 ===');
    await opt.bringToFront();
    await pickMode(opt, 'light');
    await pickPreset(opt, 3);   // rose
    await sleep(1200);
    await gallery.bringToFront();
    await sleep(1000);

    const g2 = await gallery.evaluate(() => {
      const el = document.documentElement;
      /* 「原图还原」角标的底色走 --primary-solid。
         它是这套改动里最容易漏的一处：面积小、又压在照片上，
         漏了之后按钮变了、角标还是蓝的，不盯着看发现不了。

         这里**不**去 grid 里找 .badge.restored —— 那个角标只有
         「已还原」的图才有，本地站点上不存在，断言会静默跳过。
         改成量一个临时元素：把真实 class 挂上去，让浏览器算出
         实际生效的 background（走的就是 .badge.restored 那条规则）。 */
      const probe = document.createElement('span');
      probe.className = 'badge restored';
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const badgeBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        mode: el.getAttribute('data-theme'),
        primary: el.style.getPropertyValue('--primary').trim(),
        solid: el.style.getPropertyValue('--primary-solid').trim(),
        badgeBg,
        cards: document.querySelectorAll('#grid .card').length
      };
    });
    console.log('  切回浅色+玫红 =', JSON.stringify(g2));
    check(g2.mode === 'light', '图库当场切回浅色（不用重开）', String(g2.mode));
    check(g2.primary === '#d9427a', '图库主色变成玫红浅色档', g2.primary);
    check(g2.cards === g.cards, '切主题没有把已扫出来的图弄丢', g2.cards + ' vs ' + g.cards);
    /* 角标真的吃到了新主色（不是还留着蓝） */
    check(/217,\s*66,\s*122/.test(g2.badgeBg),
      '「原图还原」角标底色跟着变成玫红（不是留着的蓝）', g2.badgeBg);
    check(!/79,\s*110,\s*247/.test(g2.badgeBg),
      '角标底色里没有残留的默认蓝', g2.badgeBg);

    /* ---------- 9. 内容脚本：面板与悬停条 ---------- */
    console.log('\n=== 9. 页内面板跟着主题走（内容脚本） ===');
    /* 回到测试页，唤起页内面板。
       这里**不按快捷键**：Alt+Shift+S 走的是 chrome.commands，由浏览器
       自己派发，在 persistent context 里用 page.keyboard.press 往往打不通
       （键盘事件到不了浏览器层）。改成从 service worker 发
       MSG.TOGGLE_PANEL —— 这正是快捷键最终会发的那条消息
       （background.js 的 onCommand 处理器就这么写的），
       所以除了"按哪个键"之外，链路一模一样。 */
    await site.bringToFront();
    await sleep(500);
    await sw.evaluate(() => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'IH_TOGGLE_PANEL' }, { frameId: 0 })
            .catch(() => {});
        }
      });
    });
    await sleep(2500);

    const panel = await site.evaluate(() => {
      /* host 元素带 data-ih-host="1"（见 shared/utils.js 的 createShadowHost） */
      const host = document.querySelector('[data-ih-host]');
      if (!host) return { found: false };
      return {
        found: true,
        /* 内容脚本用的是 data-ih-theme，**不是** data-theme ——
           后者会撞上宿主页面自己的主题。 */
        attr: host.getAttribute('data-ih-theme'),
        hostTheme: host.getAttribute('data-theme'),
        primary: host.style.getPropertyValue('--primary').trim(),
        /* 宿主页面的 <html> 上不该有任何主题痕迹 */
        htmlTheme: document.documentElement.getAttribute('data-theme'),
        htmlIhAttr: document.documentElement.getAttribute('data-ih-theme'),
        htmlInlinePrimary: document.documentElement.style.getPropertyValue('--primary').trim(),
        hasShadow: !!host.shadowRoot,
        /* shadow 树里确实有东西（注入成功） */
        shadowHtml: host.shadowRoot ? host.shadowRoot.innerHTML.length : 0,
        /* --ih-* 别名映射生效：拿 shadow 内真实存在的元素实测。
           注意选择器要与实现的命名对齐 —— 面板的根是 .ih-panel-host
           （不是 .ih-panel），取一个不存在的元素会永远拿到 null，
           看着像"映射没生效"。所以这里先取 shadow 里的第一个元素兜底。 */
        ihPrimary: (() => {
          if (!host.shadowRoot) return null;
          const el = host.shadowRoot.querySelector('.ih-panel-host, .ih-panel, .ih-hover, .ih-lb')
            || host.shadowRoot.firstElementChild;
          if (!el) return null;
          return getComputedStyle(el).getPropertyValue('--ih-primary').trim();
        })(),
        shadowFirst: (() => {
          if (!host.shadowRoot) return null;
          const el = host.shadowRoot.firstElementChild;
          return el ? el.tagName + '.' + (el.className || '') : null;
        })()
      };
    });
    console.log('  页内面板 =', JSON.stringify(panel));
    check(panel.found, '页内面板确实挂上了（shadow host 存在）');
    console.log('  shadow 第一个元素 =', String(panel.shadowFirst));
    if (panel.found) {
      check(panel.hasShadow, '面板用的是 shadow root（样式不外泄）');
      check(panel.shadowHtml > 200, 'shadow 树里有内容（样式与 UI 都注入成功了）', String(panel.shadowHtml));
      check(panel.attr === 'light', 'host 上是 data-ih-theme="light"（跟着设置页的浅色）', String(panel.attr));
      check(panel.hostTheme === null,
        'host 上没有 data-theme（那是宿主页面的命名空间，撞上就顶掉人家的主题）',
        String(panel.hostTheme));
      check(panel.primary !== '', 'host 上写了内联主色', panel.primary);
      /* --ih-* 是 shadow 内的别名，靠 theme.css 那段 :host 映射拿到值。
         这一段如果没注入成功，面板会整块失去颜色（变量拿到空值）。 */
      check(panel.ihPrimary !== '' && panel.ihPrimary !== null,
        '--ih-primary 别名映射生效（shadow 内取得到主色）', String(panel.ihPrimary));

      /* 这三条是「不污染宿主」的核心：内容脚本绝不能碰页面的 <html>。 */
      check(panel.htmlTheme === null, '宿主页面 <html> 上没有 data-theme', String(panel.htmlTheme));
      check(panel.htmlIhAttr === null, '宿主页面 <html> 上没有 data-ih-theme', String(panel.htmlIhAttr));
      check(panel.htmlInlinePrimary === '',
        '宿主页面 <html> 上没有内联主色（会污染网站自己的配色）', JSON.stringify(panel.htmlInlinePrimary));
    }

    /* ---------- 10. 灯箱恒深色 ---------- */
    console.log('\n=== 10. 灯箱保持深色（显式设计决策） ===');
    /* 灯箱的遮罩必须恒深色：浅色遮罩会让图片边缘糊进背景，
       而灯箱的全部意义就是「看清这张图」。所以它**不跟** data-theme。
       驱动方式与 browser-lightbox-window.js 一致：让后台把一份图列表
       发给内容脚本，由它 IH.OpenLightbox 打开（这正是真实的入口）。 */
    const lbOpen = await sw.evaluate(async ({ p, total }) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.indexOf(':' + p + '/') >= 0);
      if (!t) return { ok: false, error: '找不到标签页' };
      const origin = new URL(t.url).origin;
      const list = [];
      for (let i = 0; i < total; i++) {
        list.push({ url: origin + '/img/' + i + '.png', width: 64, height: 64, type: 'png' });
      }
      try {
        await chrome.tabs.sendMessage(t.id,
          { type: 'IH_OPEN_LIGHTBOX', payload: { list, index: 0 } }, { frameId: 0 });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, { p: localSite.port, total: TOTAL });
    console.log('  打开灯箱 =', JSON.stringify(lbOpen));
    await sleep(2000);

    const lbProbe = await site.evaluate(() => {
      for (const h of document.querySelectorAll('[data-ih-host]')) {
        const sr = h.shadowRoot;
        if (!sr) continue;
        const lb = sr.querySelector('.ih-lb');
        if (!lb) continue;
        const cs = getComputedStyle(lb);
        return {
          found: true,
          bg: cs.backgroundColor,
          color: cs.color,
          /* 灯箱上有没有被写上 data-theme（它不该有 —— 恒深色） */
          themeAttr: lb.getAttribute('data-theme'),
          /* 宿主页面 <html> 上没有主题属性（内容脚本不该碰它）——
             所以"当前主题"要看 host 上的 data-ih-theme，不是 <html>。 */
          htmlTheme: document.documentElement.getAttribute('data-theme'),
          hostThemes: Array.from(document.querySelectorAll('[data-ih-host]'))
            .map((x) => x.getAttribute('data-ih-theme'))
        };
      }
      return { found: false };
    });
    console.log('  灯箱 =', JSON.stringify(lbProbe));

    check(lbProbe.found, '灯箱确实打开了（.ih-lb 存在）');
    if (lbProbe.found) {
      /* 前提：此刻内容脚本侧确实是浅色。看 host 的 data-ih-theme ——
         宿主页面的 <html> 上本来就不该有任何主题属性
         （内容脚本不碰它），拿它做前提会永远是 null。 */
      const hostTheme = (lbProbe.hostThemes || [])[0];
      check(hostTheme === 'light',
        '前提：此时内容脚本侧是浅色（否则「恒深色」这句话没有意义）', String(hostTheme));
      const m = (lbProbe.bg.match(/\d+/g) || []).map(Number);
      check(m.length >= 3 && m[0] < 90 && m[1] < 90 && m[2] < 90,
        '浅色主题下灯箱遮罩仍是深色（图片边缘不会糊进背景）', lbProbe.bg);
      /* 灯箱上的文字是浅色（深底浅字），进一步证明它没有跟着浅色主题走 */
      const tm = (lbProbe.color.match(/\d+/g) || []).map(Number);
      check(tm.length >= 3 && tm[0] > 180 && tm[1] > 180 && tm[2] > 180,
        '灯箱文字仍是浅色（深底浅字，没有跟着浅色主题翻转）', lbProbe.color);
      check(lbProbe.themeAttr === null,
        '灯箱元素本身不带 data-theme（它恒深色，不参与主题切换）',
        String(lbProbe.themeAttr));
    }

  } finally {
    await ctx.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('套件异常退出：', e);
  process.exit(1);
});
