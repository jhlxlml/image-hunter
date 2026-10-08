/* ImageHunter — 真实浏览器：界面语言切换
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 * 自建本地 HTTP 页面（真实 PNG），不依赖外网。
 *
 * 这个套件存在的理由：i18n 的**静态**守卫（validate.js 第 16 节）只能证明
 * 「键齐平、键存在、文件加载顺序对」，证明不了「切一下真的全变」。
 * 而这件事恰好有个非常隐蔽的坏法：
 *
 *   **静态文案走 data-i18n，JS 拼出来的内容（筛选 chips、内置规则名、
 *   底栏统计、空态提示）不在里面。** 只 apply() 不重建，界面就会变成
 *   「英文的标题 + 中文的筛选条」—— 截图看着正常，测试也全绿，
 *   只有真的盯着看才发现一半没翻。
 *
 * 所以这里真的点一下语言按钮，然后分别检查：
 *   - 静态文案（data-i18n）
 *   - JS 拼出来的内容（chips / 内置规则名 / 底栏统计）
 *   - <html lang>（读屏器靠它切语音）
 *   - 持久化（刷新之后还是英文）
 *   - **跨页面生效**：设置页切了语言，已经开着的图库要跟着变
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
const PROFILE = path.join(os.tmpdir(), 'ih-lang-profile-' + Date.now());

const SITE_OPTS = { cols: 4, rows: 3, imgW: 600, imgH: 400 };   // 12 张，够铺出底栏统计
const TOTAL = SITE_OPTS.cols * SITE_OPTS.rows;

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点一下语言档位，等界面重画 */
async function pickLang(page, value) {
  await page.evaluate((v) => {
    const b = document.querySelector('#segLang button[data-v="' + v + '"]');
    if (b) b.click();
  }, value);
  await sleep(700);
}

/** 当前高亮的语言档位 */
const activeLang = (page) => page.evaluate(() => {
  const b = document.querySelector('#segLang button.active');
  return b ? b.dataset.v : null;
});

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SITE_OPTS);
  console.log('测试页地址 =', localSite.url, '（' + TOTAL + ' 张）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    /* 这个套件**故意**用 zh-CN：它要验的正是「浏览器是中文、用户在扩展里选英文」
       这条路。默认的 'auto' 必须落在中文，后面的切换才有意义。 */
    locale: 'zh-CN',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log('扩展 ID =', extId);

  try {
    /* ---------- 0. 先开一个真网页，图库才有东西可扫 ---------- */
    const site = await ctx.newPage();
    await site.goto(localSite.url, { waitUntil: 'load', timeout: 60000 });
    await site.bringToFront();
    await sleep(1500);

    /* ---------- 1. 默认（跟随浏览器）= 中文 ---------- */
    console.log('\n=== 1. 默认跟随浏览器 → 中文 ===');
    const optionsPage = await ctx.newPage();
    await optionsPage.goto(`chrome-extension://${extId}/options/options.html`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(1200);

    check(await activeLang(optionsPage) === 'auto', '语言档位默认停在「跟随浏览器」',
      String(await activeLang(optionsPage)));

    const zhUi = await optionsPage.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.querySelector('h2').textContent.trim(),
      rule: (document.querySelector('#builtinRules .builtin-item span') || {}).textContent,
      footer: (document.getElementById('ftrText') || {}).textContent
    }));
    console.log('  中文界面 =', JSON.stringify(zhUi));
    check(zhUi.lang === 'zh-CN', '<html lang> 是 zh-CN', zhUi.lang);
    check(zhUi.title === '通用', '静态文案是中文（data-i18n）', zhUi.title);
    check(/WordPress 尺寸后缀/.test(zhUi.rule || ''), 'JS 拼出来的内置规则名是中文', zhUi.rule);
    check(/图片猎人 ImageHunter v/.test(zhUi.footer || ''), '页脚是中文', zhUi.footer);

    /* ---------- 2. 切到英文：静态 + 动态都要变 ---------- */
    console.log('\n=== 2. 切到 English ===');
    await pickLang(optionsPage, 'en');
    check(await activeLang(optionsPage) === 'en', '档位高亮切到 English');

    const enUi = await optionsPage.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.querySelector('h2').textContent.trim(),
      theme: document.querySelector('#segTheme button[data-v="light"]').textContent.trim(),
      langHint: document.querySelector('[data-i18n="opt.langHint"]').textContent.trim(),
      rule: (document.querySelector('#builtinRules .builtin-item span') || {}).textContent,
      ruleId: (document.querySelector('#builtinRules .builtin-item em') || {}).textContent,
      blockedNote: (document.getElementById('blockedNote') || {}).textContent,
      footer: (document.getElementById('ftrText') || {}).textContent,
      htmlHint: document.querySelector('[data-i18n-html="opt.dlTemplateHint"]').innerHTML,
      ph: (document.querySelector('[data-i18n-ph="opt.rulesTestPh"]') || {}).placeholder
    }));
    console.log('  英文界面 =', JSON.stringify(enUi, null, 2));

    check(enUi.lang === 'en', '<html lang> 跟着变成 en（读屏器才知道换语言了）', enUi.lang);
    check(enUi.title === 'General', '静态文案（data-i18n）变英文', enUi.title);
    check(enUi.theme === 'Light', '同一行的主题档位也变英文（整页一致，不是局部）', enUi.theme);
    check(/interface language/i.test(enUi.langHint), '说明文字变英文', enUi.langHint);
    check(enUi.ph && /Paste a thumbnail URL/.test(enUi.ph), 'placeholder 变英文', enUi.ph);
    check(/<code>/.test(enUi.htmlHint || '') && !/&lt;code&gt;/.test(enUi.htmlHint || ''),
      'data-i18n-html 那段仍然是真标签（没被转义成字面量）', enUi.htmlHint);

    /* 这一条是整套里最关键的：规则名是 renderBuiltin() 拼出来的，
       只 apply() 不重建的话它会留在中文 —— 也就是「半中半英」。
       规则 id（<em>）是技术标识，不该跟着翻译走。 */
    check(/WordPress size suffix/.test(enUi.rule || ''), 'JS 拼出来的内置规则名也变英文', enUi.rule);
    check(enUi.ruleId === 'wp-size', '规则 id 保持原样（那是匹配用的技术标识，不翻译）', enUi.ruleId);
    check(/No sites are excluded/.test(enUi.blockedNote || ''),
      '排除列表的即时反馈（renderBlockedNote 拼的）也变英文', enUi.blockedNote);
    check(/ImageHunter v/.test(enUi.footer || '') && !/图片猎人/.test(enUi.footer || ''),
      '页脚变英文', enUi.footer);

    /* ---------- 3. 持久化：刷新之后还是英文 ---------- */
    console.log('\n=== 3. 刷新后仍然是英文 ===');
    await optionsPage.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const afterReload = await optionsPage.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.querySelector('h2').textContent.trim(),
      active: (document.querySelector('#segLang button.active') || {}).dataset.v
    }));
    check(afterReload.lang === 'en' && afterReload.title === 'General',
      '刷新后仍是英文（写进了设置，不是只改了内存）', JSON.stringify(afterReload));
    check(afterReload.active === 'en', '档位高亮也恢复成 English', String(afterReload.active));

    /* ---------- 4. 跨页面：图库跟着设置页的语言变 ---------- */
    console.log('\n=== 4. 图库跟着变（跨页面） ===');
    await site.bringToFront();
    await sleep(400);
    const gallery = await ctx.newPage();
    await gallery.goto(`chrome-extension://${extId}/popup/popup.html?mode=page`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await sleep(3500);

    const enGallery = await gallery.evaluate(() => ({
      lang: document.documentElement.lang,
      cards: document.querySelectorAll('#grid .card').length,
      filter: (document.querySelector('#btnFilters span') || {}).textContent,
      save: (document.querySelector('#btnSave span') || {}).textContent,
      sumTotal: (document.querySelector('[data-i18n="pop.sumTotal"]') || {}).textContent,
      sizeChip: (document.querySelector('#sizePresets .chip') || {}).textContent,
      ftrHint: (document.getElementById('ftrHint') || {}).textContent
    }));
    console.log('  英文图库 =', JSON.stringify(enGallery));
    check(enGallery.cards >= TOTAL, '图库扫出了 ' + TOTAL + ' 张图', enGallery.cards + ' 张');
    check(enGallery.lang === 'en', '图库的 <html lang> 也是 en', enGallery.lang);
    check(enGallery.filter === 'Filters', '图库静态文案变英文（筛选）', enGallery.filter);
    check(enGallery.save === 'Save selected', '保存按钮变英文', enGallery.save);
    check(enGallery.sumTotal === 'Total', '底栏统计标签变英文', enGallery.sumTotal);
    check(enGallery.sizeChip === 'All', 'JS 拼出来的尺寸 chip 变英文', enGallery.sizeChip);

    /* 现在在**设置页**切回中文，已经开着的图库必须跟着变 ——
       这正是 applyLangChange 存在的理由（图库自己没有语言开关）。 */
    console.log('\n=== 5. 设置页切回中文，图库当场跟着变 ===');
    await optionsPage.bringToFront();
    await pickLang(optionsPage, 'zh');
    await sleep(1200);
    await gallery.bringToFront();
    await sleep(800);

    const backZh = await gallery.evaluate(() => ({
      lang: document.documentElement.lang,
      filter: (document.querySelector('#btnFilters span') || {}).textContent,
      save: (document.querySelector('#btnSave span') || {}).textContent,
      sizeChip: (document.querySelector('#sizePresets .chip') || {}).textContent,
      cards: document.querySelectorAll('#grid .card').length
    }));
    console.log('  切回中文的图库 =', JSON.stringify(backZh));
    check(backZh.lang === 'zh-CN', '图库当场切回中文（不用重开）', backZh.lang);
    check(backZh.filter === '筛选', '静态文案切回中文', backZh.filter);
    check(backZh.save === '保存选中', '按钮切回中文', backZh.save);
    check(backZh.sizeChip === '全部', 'chip 也切回中文（动态内容确实重建了）', backZh.sizeChip);
    check(backZh.cards === enGallery.cards, '切语言没有把已扫出来的图弄丢',
      backZh.cards + ' vs ' + enGallery.cards);

    /* ---------- 6. 「跟随浏览器」要能回到自动判定 ---------- */
    console.log('\n=== 6. 切回「跟随浏览器」 ===');
    await optionsPage.bringToFront();
    await pickLang(optionsPage, 'auto');
    await sleep(700);
    const autoBack = await optionsPage.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.querySelector('h2').textContent.trim()
    }));
    // 浏览器语言是 zh-CN → 应当回到中文
    check(autoBack.lang === 'zh-CN' && autoBack.title === '通用',
      'auto 在中文浏览器上落回中文', JSON.stringify(autoBack));
  } finally {
    await ctx.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('套件异常退出：', e);
  process.exit(1);
});
