/* ImageHunter — 真实浏览器：图库「尺寸滑条」按最小尺寸过滤
 *
 * 依赖与用法同 browser-e2e.js（playwright-core + 本机 Edge / Chrome）。
 *
 * 需求原话：「筛选所在的工具栏……加入类似最小显示尺寸滑动控制条，
 *   默认过滤小于 256px，可设置范围 0-4096px。UI 统一」
 *
 * 两条用户定过的语义（不是我自己拍的）：
 *   1. 判据是**较短边**（宽高都要达标）。旁边的「≥ 800px」档位判的是宽度，
 *      这里是刻意不同的 —— 因为要挡掉的分隔条（1200×8）在宽度判据下反而合格。
 *   2. 与档位 chips **互斥、档位优先**：chips 选了非「全部」就听 chips，
 *      否则听滑条。两个都当成「最小尺寸」独立约束去叠加的话，
 *      用户点「≥ 800px」再拖到 256 会得到 800，而界面上没有任何一处解释为什么。
 *
 * 测试站点用 `sizeByIndex` 造出**混合尺寸**——这是这个用例成立的前提：
 * 全站一个尺寸时，任何阈值要么全过要么全滤，区间边界根本踩不到。
 * 24 张，四档尺寸循环（每档 6 张）：
 *   6 张 128×128   （短边 128 < 256 → 该被默认滤掉）
 *   6 张 300×80    （短边  80 < 256 → 该被默认滤掉；宽度 300 够，只有较短边判据拦得住）
 *   6 张 400×300   （短边 300 ≥ 256 → 该留下）
 *   6 张 900×600   （短边 600 ≥ 256 → 该留下）
 *
 * 覆盖：
 *   1. 默认值就是 256，且开箱即过滤（48/24 → 12）
 *   2. 判据是较短边：300×80 那张被拦住（宽度判据会放它进来）
 *   3. 滑条 0 = 不过滤，24 张全部回来
 *   4. 档位优先：选「≥ 800px」后滑条被视觉降权，结果由档位决定
 *   5. 拖滑条自动把档位复位成「全部」（不会出现「拖了没反应」）
 *   6. 「重置」把滑条恢复到默认 256，而不是 0
 *   7. 值持久化：重开图库仍是上次拖到的值
 *   8. 尺寸空态的「一键关掉」出口：点完把清空后的值**落盘**（重开仍是全部）
 */
'use strict';

const { chromium } = require('playwright-core');
const { startServer } = require('./lib/localsite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.IH_BROWSER
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'ih-size-slider-' + Date.now());

/* 24 张：四档尺寸循环，每档 6 张 */
const PATTERN = [
  { w: 128, h: 128 },     // 短边 128
  { w: 300, h: 80 },      // 短边  80，但宽度 300 —— 只有「较短边」判据拦得住
  { w: 400, h: 300 },     // 短边 300
  { w: 900, h: 600 }      // 短边 600
];
const REPS = 6;
const TOTAL = PATTERN.length * REPS;          // 24
const EXPECT_256 = 12;                        // 短边 ≥ 256 的两档 × 6
const SIZE_OPTS = {
  cols: 4, rows: 6,
  sizeByIndex: (i) => PATTERN[i % PATTERN.length],
  title: '尺寸滑条测试页'
};

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });

  const localSite = await startServer(SIZE_OPTS);
  console.log('本地图片站 =', localSite.url, '共', localSite.total, '张（四档尺寸循环）');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    locale: 'zh-CN',   // 界面固定中文：断言写的是中文，不能让它跟着 runner 的语言变
    headless: true,
    viewport: { width: 1440, height: 940 },
    args: ['--no-sandbox', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });

  const target = await ctx.newPage();
  await target.goto(localSite.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  await target.bringToFront();
  await sleep(500);

  const openGallery = async () => {
    const p = ctx.waitForEvent('page', { timeout: 20000 });
    await sw.evaluate(async () => { await openGallery(await pickTargetTab(null)); });
    const g = await p;
    await g.waitForLoadState('domcontentloaded');
    await sleep(5000);
    return g;
  };

  let gallery = await openGallery();

  /* ---------------- 小工具 ---------------- */

  const N = (id) => `Number(document.getElementById('${id}').textContent)`;

  /** 滑条 + 统计的现场 */
  const snap = () => gallery.evaluate(() => {
    const sl = document.getElementById('sizeMin');
    const out = document.getElementById('sizeMinOut');
    const row = document.getElementById('sizeSliderRow');
    return {
      value: sl ? Number(sl.value) : null,
      min: sl ? Number(sl.min) : null,
      max: sl ? Number(sl.max) : null,
      out: out ? out.textContent.trim() : null,
      overridden: row ? row.classList.contains('overridden') : null,
      total: Number(document.getElementById('statTotal').textContent),
      filtered: Number(document.getElementById('statFiltered').textContent),
      badge: (() => {
        const b = document.getElementById('filterCount');
        return b && !b.hidden ? Number(b.textContent) : 0;
      })(),
      activeChip: (() => {
        // 高亮类是 .active（renderChips 里定的），不是 .on —— .on 是「筛选」那个
        // 按钮的类名，两者很容易看混
        const c = document.querySelector('#sizePresets .chip.active');
        return c ? c.textContent.replace(/\d+$/, '').trim() : null;
      })()
    };
  });

  const setSlider = (v) => gallery.evaluate((val) => {
    const el = document.getElementById('sizeMin');
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);

  const clickChip = (label) => gallery.evaluate((t) => {
    const chips = Array.from(document.querySelectorAll('#sizePresets .chip'));
    const hit = chips.find((c) => c.textContent.indexOf(t) >= 0);
    if (!hit) return false;
    hit.click();
    return true;
  }, label);

  const clickReset = () => gallery.evaluate(() => {
    const b = document.getElementById('btnResetFilters');
    if (!b) return false;
    b.click();
    return true;
  });

  try {
    /* ============================================================== *
     * 1. 控件本身：存在、范围 0-4096、默认 256
     * ============================================================== */
    console.log('\n=== 1. 滑条存在、范围与默认值 ===');

    let s = await snap();
    console.log('滑条 =', JSON.stringify(s));
    check(s.value !== null, '工具行右侧有 #sizeMin 滑条');
    check(s.min === 0, '最小档是 0（=' + s.min + '）', String(s.min));
    check(s.max === 4096, '最大档是 4096（=' + s.max + '）', String(s.max));
    check(s.value === 256, '默认值 256（=' + s.value + '）', String(s.value));
    check(/256/.test(s.out || ''), '输出文本里写着 256', s.out);

    /* 位置契约：滑条挂在**工具行**（.ctrl-bar）最右侧，不在筛选条（.filterbar）里。
       这是用户点名搬过去的位置 —— 工具行右侧本来有大片空档，滑条塞进去不占额外行高，
       而筛选条里「尺寸」那一格只剩 chips、和别的 fg 一样高，整条筛选栏更齐。 */
    const place = await gallery.evaluate(() => {
      const row = document.getElementById('sizeSliderRow');
      if (!row) return null;
      return {
        inCtrl: !!row.closest('.ctrl-bar'),
        inFilter: !!row.closest('.filterbar'),
        afterSeg: !!row.previousElementSibling
          && row.previousElementSibling.classList.contains('seg')
      };
    });
    console.log('滑条位置 =', JSON.stringify(place));
    check(place && place.inCtrl, '滑条挂在工具行（.ctrl-bar）里', JSON.stringify(place));
    check(place && !place.inFilter, '滑条已从筛选条（.filterbar）里移出', JSON.stringify(place));
    check(place && place.afterSeg, '滑条紧跟选择操作组之后（工具行最右）', JSON.stringify(place));

    /* ============================================================== *
     * 2. 默认即过滤：24 张里只剩短边 ≥ 256 的 12 张
     * ============================================================== */
    console.log('\n=== 2. 默认 256 开箱即过滤 ===');

    check(s.total === TOTAL, '总共嗅到 ' + TOTAL + ' 张', String(s.total));
    check(s.filtered === EXPECT_256,
      '默认阈值下剩 ' + EXPECT_256 + ' 张（短边 300 / 600 那两档）—— 我实测 ' + s.filtered,
      String(s.filtered));

    // 逐张核对：被留下的必须都是短边 ≥ 256 的
    const keptMinSides = await gallery.evaluate(() => {
      /* 卡片上的尺寸文本形如「400 × 300」；解析出来算短边。
         直接读 DOM 而不是读内部状态 —— 内容脚本/页面脚本在隔离世界里，
         测试拿不到 JS 变量，只能看界面事实。 */
      return Array.from(document.querySelectorAll('#grid .card')).map((c) => {
        const t = c.textContent || '';
        const m = t.match(/(\d+)\s*×\s*(\d+)/);
        return m ? Math.min(Number(m[1]), Number(m[2])) : null;
      }).filter((v) => v !== null);
    });
    console.log('留下的短边样本 =', JSON.stringify(keptMinSides.slice(0, 8)));
    check(keptMinSides.length === EXPECT_256,
      '网格里确实铺着 ' + EXPECT_256 + ' 张（与统计一致）', String(keptMinSides.length));
    check(keptMinSides.every((v) => v >= 256),
      '每一张的**较短边**都 ≥ 256', JSON.stringify(keptMinSides));

    /* ============================================================== *
     * 3. 判据是较短边：300×80 必须被拦住
     *
     * 这一条是这个功能的核心理由。300×80 宽度 300 ≥ 256，
     * 按宽度判会留下；只有较短边判据才拦得住它。
     * ============================================================== */
    console.log('\n=== 3. 判据是较短边（挡长条图）===');

    const hasWideThin = await gallery.evaluate(() =>
      Array.from(document.querySelectorAll('#grid .card'))
        .some((c) => /300\s*×\s*80/.test(c.textContent || '')));
    check(!hasWideThin,
      '300×80 那张被拦住了（宽度 300 达标，只有较短边判据拦得住它）');

    // 反证：滑条拉到 80 时它该出现，证明「拦住它」是阈值判的、不是它压根没被嗅到
    await setSlider(80);
    await sleep(700);
    s = await snap();
    const hasWideThin80 = await gallery.evaluate(() =>
      Array.from(document.querySelectorAll('#grid .card'))
        .some((c) => /300\s*×\s*80/.test(c.textContent || '')));
    check(hasWideThin80,
      '阈值降到 80 后它出现了 —— 证明它一直被嗅到，只是被较短边判据挡在门外',
      'filtered=' + s.filtered);

    /* ============================================================== *
     * 4. 滑条 0 = 不过滤
     * ============================================================== */
    console.log('\n=== 4. 滑条 0 = 不过滤 ===');

    await setSlider(0);
    await sleep(700);
    s = await snap();
    console.log('阈值 0 =', JSON.stringify(s));
    check(s.filtered === TOTAL, '0 时 ' + TOTAL + ' 张全部回来（我实测 ' + s.filtered + '）',
      String(s.filtered));
    check(/不过滤/.test(s.out || ''), '输出文本变成「不过滤」', s.out);

    /* ============================================================== *
     * 5. 与档位 chips 的关系：档位优先 + 视觉降权
     * ============================================================== */
    console.log('\n=== 5. 档位优先，滑条被视觉降权 ===');

    // 先把滑条设成一个宽松值，再点「≥ 800px」，结果应当由档位说了算
    await setSlider(0);
    await sleep(500);
    const clicked = await clickChip('800');
    await sleep(700);
    s = await snap();
    console.log('点 ≥800px 后 =', JSON.stringify(s));
    check(clicked, '点到了「≥ 800px」档位');
    check(s.activeChip && /800/.test(s.activeChip), '「≥ 800px」被高亮', s.activeChip);
    check(s.overridden === true, '滑条进入「被档位接管」的视觉降权态', String(s.overridden));
    /* 900×600 那档宽度 900 ≥ 800，共 6 张。
       如果滑条还在叠加（值 0 不叠加，但若是 256 就会变成 12），结果会是别的数。 */
    check(s.filtered === 6,
      '结果由档位决定（宽度 ≥ 800 → 6 张），不是滑条', String(s.filtered));

    /* ============================================================== *
     * 6. 拖滑条 → 档位自动复位成「全部」
     *
     * 不然用户会遇到「拖了没反应」，而且界面上没有任何解释。
     * ============================================================== */
    console.log('\n=== 6. 拖滑条自动把档位复位 ===');

    await setSlider(256);
    await sleep(700);
    s = await snap();
    console.log('拖到 256 后 =', JSON.stringify(s));
    check(s.overridden === false, '滑条恢复常态（不再被档位接管）', String(s.overridden));
    check(s.activeChip && /全部/.test(s.activeChip),
      '档位自动复位到「全部」', s.activeChip);
    check(s.filtered === EXPECT_256,
      '结果由滑条决定（256 → ' + EXPECT_256 + ' 张）', String(s.filtered));

    /* ============================================================== *
     * 7. 「重置」回到默认 256，而不是 0
     * ============================================================== */
    console.log('\n=== 7. 重置回到默认 256 ===');

    await setSlider(1500);
    await sleep(600);
    s = await snap();
    const filteredAt1500 = s.filtered;
    check(filteredAt1500 === 0,
      '阈值 1500 时 0 张（最大那档短边也只有 600）', String(filteredAt1500));

    await clickReset();
    await sleep(800);
    s = await snap();
    console.log('重置后 =', JSON.stringify(s));
    check(s.value === 256, '重置后滑条回到 256（不是 0）', String(s.value));
    check(s.filtered === EXPECT_256,
      '重置后结果也回到默认的 ' + EXPECT_256 + ' 张', String(s.filtered));

    /* ============================================================== *
     * 8. 值持久化：关掉图库重开，仍是上次拖到的值
     * ============================================================== */
    console.log('\n=== 8. 滑条值跨会话保留 ===');

    await setSlider(400);
    await sleep(700);
    await gallery.close();
    await sleep(600);

    gallery = await openGallery();
    await sleep(1500);
    s = await snap();
    console.log('重开图库 =', JSON.stringify(s));
    check(s.value === 400, '重开仍是上次设的 400（=' + s.value + '）', String(s.value));
    check(s.filtered === 6,
      '结果按 400 生效：只剩短边 600 那档 6 张', String(s.filtered));

    /* ============================================================== *
     * 9. 尺寸空态的一键出口 —— 点完必须**落盘**
     *
     * 这一条是回归测试：出口以前只改内存里的 filters.sizeMin，不写
     * ih_gallery_view。当场看着没问题（图都回来了），但**下次打开**又会把
     * 旧阈值捡回来 —— 页内面板那边尤其明显（它是一份全新加载，必然重读视图
     * 状态），表现成「面板打开后一张卡都没有」，看上去像面板坏了。
     * 所以这里断言「点完出口 → 关掉重开 → 依然是全部」，而不只是当场看着对。
     * ============================================================== */
    console.log('\n=== 9. 尺寸空态出口：点完要落盘 ===');

    // 拖到 700：四档短边（128/80/300/600）全部 < 700 → 一张不剩，触发空态
    await setSlider(700);
    await sleep(800);
    s = await snap();
    check(s.filtered === 0, '阈值 700 把 24 张全滤掉（=' + s.filtered + '）', String(s.filtered));

    const emptyUi = await gallery.evaluate(() => {
      const b = document.getElementById('emptyClearSize');
      return {
        shown: !!(b && !b.hidden),
        text: b ? b.textContent.trim() : ''
      };
    });
    console.log('空态出口 =', JSON.stringify(emptyUi));
    check(emptyUi.shown, '空态里出现「一键关掉」出口按钮', String(emptyUi.shown));
    check(/显示全部\s*24\s*张/.test(emptyUi.text),
      '出口文案说清「显示全部 24 张」（=' + emptyUi.text + '）', emptyUi.text);

    await gallery.evaluate(() => document.getElementById('emptyClearSize').click());
    await sleep(700);
    s = await snap();
    check(s.filtered === TOTAL, '点出口后 ' + TOTAL + ' 张全部回来（=' + s.filtered + '）', String(s.filtered));
    check(s.value === 0, '滑条也跟着回到 0（=' + s.value + '）', String(s.value));

    // 关键：关掉重开，确认「清掉」这件事已经落盘（而不是只活在内存里）
    await gallery.close();
    await sleep(600);
    gallery = await openGallery();
    await sleep(1500);
    s = await snap();
    console.log('点出口后重开 =', JSON.stringify(s));
    check(s.value === 0, '重开后滑条仍是 0（出口已落盘，=' + s.value + '）', String(s.value));
    check(s.filtered === TOTAL, '重开后仍是全部 ' + TOTAL + ' 张（=' + s.filtered + '）', String(s.filtered));
  } catch (e) {
    console.error('测试异常', e);
    fail++;
  } finally {
    await ctx.close();
    localSite.close();
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
