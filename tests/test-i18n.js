/* ImageHunter — 界面语言（中英切换）行为测试
 *
 * 这个套件守的是 shared/i18n.js 的**机制**，不是「哪句话翻译得对不对」
 * （那是文案表的事，静态部分在 validate.js 第 16 节：中英齐平、没有空串、
 * 代码里引用的键都存在）。
 *
 * 机制里最值得钉的是**降级链**：
 *   当前语言 → 中文 → key 本身
 * 这条链每一环都有一次「悄悄变坏」的机会：
 *   - 少了一环，英文用户看到的是空字符串（界面上就是一小片空白，没人会报 bug）；
 *   - 最外环（返回 key）看着最难看，其实是**故意**的 —— 显示 "pop.saveSelected"
 *     一眼就能看出是漏翻译，比显示空串好排查得多。
 *
 * 另一件必须钉的是**语言判定的优先级**：设置里选了就用选的，
 * 'auto' 或没设才跟随浏览器。反过来的话，用户手动选了英文、
 * 换台中文浏览器又被打回中文 —— 而「设置不生效」是最难被归因的一类 bug。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');
const i18nSrc = fs.readFileSync(path.join(BASE, 'shared/i18n.js'), 'utf8');
const constSrc = fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8');
const utilSrc = fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  if (actual === expected) ok(label);
  else bad(label, 'got ' + JSON.stringify(actual) + ' / want ' + JSON.stringify(expected));
}

/* ------------------------------------------------------------------ *
 * 极简上下文：只加载 i18n.js，用来测「浏览器语言 → 语言」这一层。
 * 没有 Store 时 lang() 只能靠 navigator —— 正好把 detect() 单独隔离出来。
 * ------------------------------------------------------------------ */
function plainCtx(navLang) {
  const ctx = { console, Object, Array, String, Number, JSON, Promise, Math, Date };
  ctx.globalThis = ctx;
  if (navLang !== undefined) ctx.navigator = { language: navLang };
  vm.createContext(ctx);
  vm.runInContext(i18nSrc, ctx);
  return ctx;
}

/* ------------------------------------------------------------------ *
 * 带 Store 的上下文：用 jsdom 提供 document，用 chrome.storage 桩喂设置。
 * 语言由设置里的 uiLang 决定（和真实环境一致）。
 * ------------------------------------------------------------------ */
const { JSDOM } = require('jsdom');

function storeCtx(uiLang, html) {
  const dom = new JSDOM(html || '<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    runScripts: 'outside-only'
  });
  const ctx = dom.getInternalVMContext();
  ctx.console = console;
  const stored = uiLang === undefined ? {} : { uiLang };
  ctx.chrome = {
    runtime: { lastError: undefined, getURL: (p) => p, onMessage: { addListener() {} } },
    storage: {
      local: {
        get: () => Promise.resolve({ ih_settings: stored }),
        set: () => Promise.resolve()
      },
      onChanged: { addListener() {} }
    }
  };
  const load = (src) => vm.runInContext(src, ctx);
  load(constSrc);
  load(utilSrc);
  load(storeSrc);
  load(i18nSrc);
  return { dom, ctx, IH: ctx.IH, stored };
}

/* 新建一个上下文并**等设置加载完** —— 语言判定读的是 Store 的缓存，
   缓存没加载时 uiLang 还是默认的 'auto'，测出来的会是「跟随浏览器」。 */
async function readyCtx(uiLang, html) {
  const env = storeCtx(uiLang, html);
  await env.IH.Store.loadSettings();
  return env;
}

(async function run() {
  /* ================================================================ *
   * 1. 浏览器语言 → 语言
   * ================================================================ */
  console.log('=== 1. 浏览器语言判定 ===');
  [
    ['zh', 'zh', 'zh 本身算中文'],
    ['zh-CN', 'zh', 'zh-CN 算中文'],
    ['zh-TW', 'zh', 'zh-TW 也算中文（都是中文，不做简繁区分）'],
    ['ZH-HANS', 'zh', '大小写不敏感'],
    ['en-US', 'en', 'en-US 算英文'],
    ['ja-JP', 'en', '其它语言一律退到英文（英文是通用兜底）']
  ].forEach(([nav, want, label]) => eq(plainCtx(nav).IH.I18n.detect(), want, label));
  eq(plainCtx(undefined).IH.I18n.detect(), 'en', '连 navigator 都没有时退到英文，不抛错');

  /* ================================================================ *
   * 2. 设置优先于浏览器语言
   * ================================================================ */
  console.log('\n=== 2. 设置里的 uiLang 优先 ===');
  {
    const zh = await readyCtx('zh');
    const en = await readyCtx('en');
    const auto = await readyCtx('auto');
    const unset = await readyCtx(undefined);

    eq(zh.IH.I18n.lang(), 'zh', 'uiLang=zh → 中文');
    eq(en.IH.I18n.lang(), 'en', 'uiLang=en → 英文（哪怕浏览器是中文）');
    // jsdom 的 navigator.language 恒为 en-US，所以 'auto' 应当落到 en
    eq(auto.IH.I18n.lang(), 'en', "uiLang='auto' → 跟随浏览器（jsdom 里是 en-US）");
    eq(unset.IH.I18n.lang(), 'en', '设置里没有 uiLang（老版本存下来的设置）→ 跟随浏览器');
  }

  /* ================================================================ *
   * 3. 降级链：当前语言 → 中文 → key
   * ================================================================ */
  console.log('\n=== 3. 取词的降级链 ===');
  {
    const S = (await readyCtx('zh')).IH.I18n.STRINGS;
    check(typeof S.zh['pop.saveSelected'] === 'string' && typeof S.en['pop.saveSelected'] === 'string',
      '中英两份都有 pop.saveSelected');

    /* 注入验证：临时抠掉英文里的一条，模拟「加了中文忘了英文」。
       不断言这一段，降级链的第一环其实从来没被走过。 */
    const enEnv = await readyCtx('en');
    const backup = enEnv.IH.I18n.STRINGS.en['pop.saveSelected'];
    delete enEnv.IH.I18n.STRINGS.en['pop.saveSelected'];
    eq(enEnv.IH.I18n.t('pop.saveSelected'), S.zh['pop.saveSelected'],
      '英文漏了这条 → 退回中文（不是空串，也不是 key）');
    enEnv.IH.I18n.STRINGS.en['pop.saveSelected'] = backup;
    eq(enEnv.IH.I18n.t('pop.saveSelected'), backup, '把英文补回去 → 又走英文（说明上面那条是注入造成的）');

    eq((await readyCtx('zh')).IH.I18n.t('pop.saveSelected'), S.zh['pop.saveSelected'], '中文环境照常');
    eq(plainCtx('en').IH.I18n.t('nope.not.a.key'), 'nope.not.a.key',
      '两种语言都没有 → 原样返回 key（显示 "nope.not.a.key" 一眼看得出漏翻译，比空白好排查）');

    const t = plainCtx('en').IH.I18n.t;
    eq(t('pop.selectedN', { n: 7 }), '7 selected', '占位符被替换（英文）');
    eq(t('pop.selectedN', { n: 7, unused: 'x' }), '7 selected', '多余的参数不影响结果');
    eq(t('pop.selectedN'), '{n} selected', '不传参数时占位符原样留着（不变成 undefined）');
    eq(t('pop.selectedN', { n: 0 }), '0 selected', '0 也要真的替换进去（不能被当成「假值」跳过）');
  }

  /* ================================================================ *
   * 4. apply()：把文案填进页面
   * ================================================================ */
  console.log('\n=== 4. 填充页面（data-i18n 系列） ===');
  {
    const html = [
      '<!doctype html><html lang="zh-CN"><body>',
      '<span id="a" data-i18n="pop.filter">筛选</span>',
      '<span id="b" data-i18n-html="opt.dlTemplateHint">占位</span>',
      '<input id="c" data-i18n-ph="pop.searchPh" placeholder="占位">',
      '<button id="d" data-i18n-aria="pop.rescanAria">x</button>',
      '<button id="e" data-i18n-title="pop.clearTitle">x</button>',
      '<span id="f" data-i18n="pop.saveSelected">保存选中</span>',
      '</body></html>'
    ].join('');

    const env = await readyCtx('zh', html);
    const doc = env.ctx.document;
    env.IH.I18n.apply(doc);

    eq(doc.getElementById('a').textContent, '筛选', 'data-i18n 走 textContent');
    check(doc.getElementById('b').innerHTML.indexOf('<code>') >= 0,
      'data-i18n-html 走 innerHTML（含 <code> 的说明才不会被显示成字面量）');
    eq(doc.getElementById('c').getAttribute('placeholder'), '搜索文件名 / 图片地址…',
      'data-i18n-ph 填 placeholder');
    eq(doc.getElementById('d').getAttribute('aria-label'), '重新嗅探', 'data-i18n-aria 填 aria-label');
    eq(doc.getElementById('d').getAttribute('title'), '重新嗅探', 'data-i18n-aria 同时填 title');
    eq(doc.getElementById('e').getAttribute('title'), '取消全部勾选', 'data-i18n-title 只填 title');
    eq(doc.documentElement.getAttribute('lang'), 'zh-CN', '<html lang> 被改成 zh-CN');

    // 切成英文再 apply 一次 —— 这正是「切换语言」时做的事
    await env.IH.I18n.setLang('en');
    env.IH.I18n.apply(doc);
    eq(doc.getElementById('a').textContent, 'Filters', '切到英文后静态文案跟着变');
    eq(doc.getElementById('f').textContent, 'Save selected', '同一批元素整体换语言');
    eq(doc.documentElement.getAttribute('lang'), 'en', '<html lang> 也跟着变（读屏器才知道换语言了）');
    eq(doc.getElementById('c').getAttribute('placeholder'), 'Search filename / image URL…',
      'placeholder 也跟着变');
  }

  /* ================================================================ *
   * 5. setLang 会落盘
   * ================================================================ */
  console.log('\n=== 5. setLang 落盘 ===');
  {
    const env = await readyCtx('zh');
    eq(env.IH.I18n.lang(), 'zh', '起始是中文');

    await env.IH.I18n.setLang('en');
    eq(env.IH.I18n.lang(), 'en', 'setLang 之后当场生效');
    eq(env.IH.Store.getSettings().uiLang, 'en', '而且写进了设置（不是只改了内存里的语言变量）');

    await env.IH.I18n.setLang('nonsense');
    eq(env.IH.Store.getSettings().uiLang, 'auto', '非法值退到 auto（不会把脏值写进设置）');

    await env.IH.I18n.setLang('zh');
    eq(env.IH.I18n.lang(), 'zh', '再切回中文仍然有效');
  }

  /* ================================================================ *
   * 6. 来源标签与规则名也跟着语言走
   * ================================================================ */
  console.log('\n=== 6. 来源标签 / 还原规则名 ===');
  {
    const zh = await readyCtx('zh');
    eq(zh.IH.I18n.sourceLabel('bg'), '背景图', '来源标签：中文');
    eq(zh.IH.I18n.ruleLabel('wp-size', '兜底名'), 'WordPress 尺寸后缀（image-300x200.jpg）',
      '规则名按 id 取中文');
    eq(zh.IH.I18n.ruleLabel('no-such-rule', '兜底名'), '兜底名',
      '不认识的规则 id → 退回 constants 里那份 label');

    const en = await readyCtx('en');
    eq(en.IH.I18n.sourceLabel('bg'), 'Background', '来源标签：英文');
    eq(en.IH.I18n.ruleLabel('wp-size', '兜底名'), 'WordPress size suffix (image-300x200.jpg)',
      '规则名按 id 取英文');
    eq(en.IH.I18n.sourceLabel('no-such-source'), 'no-such-source',
      '不认识的来源 key → 原样返回（至少还看得出是什么）');
  }

  /* ================================================================ *
   * 7. uiLang 是受管的设置项
   * ================================================================ */
  console.log('\n=== 7. uiLang 是受管的设置项 ===');
  {
    const env = await readyCtx('zh');
    eq(env.IH.C.DEFAULT_SETTINGS.uiLang, 'auto', 'DEFAULT_SETTINGS 里 uiLang 默认 auto');
    /* 导出的白名单就是 DEFAULT_SETTINGS 的键。不在里面 = 导出→导入会被静默过滤掉，
       用户切了英文、导入一次备份就回到中文，还以为是自己记错了。 */
    check(Object.keys(env.IH.C.DEFAULT_SETTINGS).indexOf('uiLang') >= 0,
      'uiLang 在 DEFAULT_SETTINGS 的键里（导出→导入不会把它静默过滤掉）');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('套件异常退出：', e);
  process.exit(1);
});
