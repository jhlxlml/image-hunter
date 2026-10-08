/* ImageHunter — 「没扫成」不能冒充「本页没有图片」
 *
 * 用户报告的现象：**首次点开扩展图标，图库说「本页没有发现图片」，刷新一下反而好了。**
 *
 * 根因不在「有没有图」，而在**后台的收尾判据**：
 *   scanTab() 一开始就挂一个 4 秒兜底计时（SCAN_IDLE_TIMEOUT），
 *   而那个 4 秒本意是「内容脚本完全没接上话」。可它同时也在给内容脚本的**正常加工**计时 ——
 *   补尺寸只能靠真实加载，页面自己还没加载的图（懒加载、首屏之外）就得等网络。
 *   十几张没加载的图就足以把首次回报推迟到 4 秒以上 → 4 秒一到就收尾 →
 *   此时**一个 frame 都还没回报**，结果是 ok:true + 空列表 → 图库说「本页没有发现图片」。
 *   刷新一次为什么好了：第二次探测结果已经在内容脚本的缓存里，回报是毫秒级的。
 *
 * 所以这个套件盯的是三条不变量：
 *   1. **内容脚本已经接下请求（确认过）之后，不能再按「没动静」判它出局**；
 *   2. **一个 frame 都没回报 → 这不是「没有图」，是「没问成」**，必须是错误态；
 *   3. **真的没有图（内容脚本回报了、就是 0 张）仍然必须是成功态** ——
 *      修「撒谎」的时候很容易顺手把「如实」也一起弄坏。
 *
 * 时间参数由 lib/bgstub.js 把 background.js 的三个常量替换成小值（否则一个套件要跑二十几秒），
 * 第 1 节会先验证真实常量没被改坏、替换真的命中 —— 免得「测试在跑，测的是别的超时」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createBg, patchSource } = require('./lib/bgstub');

const BASE = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 缩短后的时间参数。取值要留出「安静期 450ms」的余量：
   内容脚本回报最终结果后，后台还要安静 450ms 才收尾，
   restore 档如果比它小，测到的就是兜底计时而不是安静期，断言会指向错的地方。 */
const T = { idle: 200, restore: 2000, deep: 4000 };
const IDLE = T.idle;
const RESTORE = T.restore;

const scanMsg = (extra) => Object.assign({ type: 'IH_SCAN_TAB', tabId: 1 }, extra || {});

(async function run() {
  /* ================================================================ *
   * 1. 先证明「缩短超时」这件事本身是可靠的
   * ================================================================ */
  console.log('=== 1. 真实常量与替换机制 ===');

  const realSrc = patchSource(null);
  const grab = (name) => {
    const m = new RegExp('const ' + name + ' = (\\d+);').exec(realSrc);
    return m ? Number(m[1]) : null;
  };
  const realIdle = grab('SCAN_IDLE_TIMEOUT');
  const realRestore = grab('SCAN_RESTORE_TIMEOUT');
  const realDeep = grab('SCAN_DEEP_TIMEOUT');

  check(realIdle === 4000, '「内容脚本没接上话」的兜底是 4 秒', realIdle);
  check(realRestore === 15000, '加工阶段的兜底是 15 秒', realRestore);
  check(realDeep === 45000, '深度嗅探的兜底是 45 秒', realDeep);
  /* 这条才是真正要守的：加工档必须明显大于「没接上话」档。
     两者一旦相等或反了，「首次嗅探被 4 秒截断」这个 bug 立刻回来。 */
  check(realRestore > realIdle * 2,
    '加工档明显宽于「没接上话」档（否则首次嗅探又会被截断）',
    realRestore + ' vs ' + realIdle);

  // 替换必须命中：命中不了 patchSource 会抛错 —— 这里正面确认它确实改到了源码
  const patched = patchSource(T);
  check(new RegExp('const SCAN_IDLE_TIMEOUT = ' + IDLE + ';').test(patched),
    '超时常量替换真的命中了（替换不到会抛错，不会静默失效）');
  check(!/const SCAN_IDLE_TIMEOUT = 4000;/.test(patched),
    '替换之后源码里不再有原来的 4000');

  /* ================================================================ *
   * 2. 本次 bug 的正面回归：确认过之后，慢回报必须等
   * ================================================================ */
  console.log('\n=== 2. 内容脚本已确认、但回报晚于「没动静」档 → 必须等 ===');

  /* 内容脚本 ack 之后 3 倍 idle 才回报最终结果。
     修复前：idle 一到就收尾，此时一个 frame 都没回报 → ok:true + 空列表。 */
  const late = createBg({
    timeouts: T,
    onScan: ({ reportFinal }) => { setTimeout(reportFinal, IDLE * 3); }
  });
  await sleep(60);

  const r1 = await late.send(scanMsg(), RESTORE + 3000);
  check(r1 && r1.ok === true, '晚回报仍然被判为成功', JSON.stringify(r1 && r1.error));
  check(r1 && r1.images && r1.images.length === 2,
    '拿到了那 2 张图（没有被提前收尾截成空列表）',
    r1 && r1.images && r1.images.length);
  check(r1 && !r1.error, '没有附带错误码', r1 && r1.error);

  /* ================================================================ *
   * 3. 对照组：内容脚本**没接上话**时，仍然要快速收尾
   * ================================================================ */
  console.log('\n=== 3. 内容脚本没接上话 → 快速收尾，且必须是错误态 ===');

  const t0 = Date.now();
  const noAck = createBg({
    timeouts: T,
    // ack 返回 falsy：等价于「消息投出去没人接」那一支
    onScan: () => null
  });
  await sleep(60);
  const r2 = await noAck.send(scanMsg(), RESTORE + 3000);
  const ms2 = Date.now() - t0;

  check(ms2 < RESTORE, '没有拖到加工档才收尾（「没接上话」仍然是快速判据）', ms2 + 'ms');
  check(r2 && r2.ok === false, '结果是失败态，不是「成功但 0 张」', JSON.stringify(r2));
  check(!!(r2 && r2.error), '带上了错误说明', r2 && r2.error);
  check(!!(r2 && r2.error) && r2.error.indexOf('没有发现图片') < 0,
    '**没有**说「本页没有发现图片」—— 那是把「没问成」说成「没有图」',
    r2 && r2.error);
  check(!!(r2 && r2.error) && /刷新|加载/.test(r2.error),
    '错误说明里给了可操作的建议（刷新 / 等页面加载完）', r2 && r2.error);

  /* ================================================================ *
   * 4. 确认过、但一直不回报 → 也要落到错误态（不能是「成功但 0 张」）
   * ================================================================ */
  console.log('\n=== 4. 确认过但始终不回报 → 错误态 ===');

  const silent = createBg({ timeouts: T, onScan: () => ({ ok: true, accepted: true }) });
  await sleep(60);
  const r3 = await silent.send(scanMsg(), RESTORE + 3000);
  check(r3 && r3.ok === false, '结果是失败态', JSON.stringify(r3));
  check(!!(r3 && r3.error) && r3.error.indexOf('没有发现图片') < 0,
    '同样**没有**说「本页没有发现图片」', r3 && r3.error);

  /* ================================================================ *
   * 5. 中间结果（partial）要能立刻兑现，最终结果随后走广播
   * ================================================================ */
  console.log('\n=== 5. partial 先兑现、final 走升级广播 ===');

  const partialFirst = createBg({
    timeouts: T,
    onScan: ({ reqId, emit, reportFinal }) => {
      // partial 早于 idle 档到达，最终结果晚于 idle 档
      setTimeout(() => emit({
        type: 'IH_SCAN_RESULT', reqId, phase: 'partial',
        images: [{ url: 'https://cdn.example.com/1.png', width: 800, height: 600 }],
        pageUrl: 'https://example.com/a.html', title: 'T'
      }), Math.round(IDLE / 2));
      setTimeout(reportFinal, IDLE * 4);
      return { ok: true, accepted: true };
    }
  });
  await sleep(60);
  const r4 = await partialFirst.send(scanMsg(), RESTORE + 3000);

  /* 这一条 sendResponse 拿到的是**中间结果**（这是设计：先出图，别让用户等还原）。
     要注意别把它当成「最终结果没回来」—— 最终结果走的是 SCAN_UPGRADE 广播。 */
  check(r4 && r4.ok === true, '中间结果被兑现（没有被判成失败）', JSON.stringify(r4 && r4.error));
  check(r4 && r4.phase === 'partial', '这一版确实是中间结果（phase=partial）', r4 && r4.phase);
  check(r4 && r4.images && r4.images.length === 1, '中间结果里就是那 1 张', r4 && r4.images.length);

  // 等最终结果（> idle 档）到达并广播
  const upgraded = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < RESTORE) {
      const hit = partialFirst.broadcasts.find((m) => m && m.type === 'IH_SCAN_UPGRADE');
      if (hit) return hit.payload;
      await sleep(50);
    }
    return null;
  })();
  check(!!upgraded, '最终结果通过 SCAN_UPGRADE 广播回来了（没有被 idle 档截断）');
  check(upgraded && upgraded.images && upgraded.images.length === 2,
    '广播里是完整的 2 张（中间结果那 1 张被整体覆盖，不是叠加）',
    upgraded && upgraded.images && upgraded.images.length);

  /* ================================================================ *
   * 6. 内容脚本自报的错不能丢（busy / 扫描抛异常）
   * ================================================================ */
  console.log('\n=== 6. 内容脚本自报错误 → 如实转达 ===');

  const busy = createBg({
    timeouts: T,
    onScan: ({ reqId, emit }) => {
      emit({
        type: 'IH_SCAN_RESULT', reqId, images: [], error: 'busy',
        pageUrl: 'https://example.com/a.html', title: 'T'
      });
      return { ok: true, accepted: true };
    }
  });
  await sleep(60);
  const r5 = await busy.send(scanMsg(), RESTORE + 3000);
  check(r5 && r5.ok === false, '「忙」不再被当成「成功但 0 张」', JSON.stringify(r5));
  check(!!(r5 && r5.error) && r5.error.indexOf('还没结束') >= 0,
    '错误码被翻译成一句人话（不是原样抛 busy）', r5 && r5.error);

  const threw = createBg({
    timeouts: T,
    onScan: ({ reqId, emit }) => {
      emit({
        type: 'IH_SCAN_RESULT', reqId, images: [], error: 'TypeError: x is not a function',
        pageUrl: 'https://example.com/a.html', title: 'T'
      });
      return { ok: true, accepted: true };
    }
  });
  await sleep(60);
  const r6 = await threw.send(scanMsg(), RESTORE + 3000);
  check(r6 && r6.ok === false, '扫描抛异常时是失败态', JSON.stringify(r6));
  check(!!(r6 && r6.error) && r6.error.indexOf('TypeError') >= 0,
    '原始错误信息被保留下来（排障要靠它）', r6 && r6.error);

  /* 反过来：一个 frame 报错、别的 frame 有图 → 不能因为一个错误就把整轮判失败 */
  const mixed = createBg({
    timeouts: T,
    onScan: ({ reqId, emit, reportFinal }) => {
      // 子 frame 报错
      emit({
        type: 'IH_SCAN_RESULT', reqId, images: [], error: 'busy',
        pageUrl: 'https://example.com/a.html', title: 'T'
      }, { tab: { id: 1 }, frameId: 7 });
      // 顶层 frame 有图
      setTimeout(reportFinal, IDLE * 2);
      return { ok: true, accepted: true };
    }
  });
  await sleep(60);
  const r7 = await mixed.send(scanMsg(), RESTORE + 3000);
  check(r7 && r7.ok === true, '有 frame 拿到了图 → 整轮仍然算成功', JSON.stringify(r7));
  check(r7 && r7.images && r7.images.length === 2, '图一张都没少', r7 && r7.images.length);

  /* ================================================================ *
   * 7. 反向断言：真的没有图，仍然是成功态
   * ================================================================ */
  console.log('\n=== 7. 页面里确实没有图片 → 仍然是成功态 ===');

  const empty = createBg({
    timeouts: T,
    images: [],
    onScan: ({ reportFinal }) => { setTimeout(reportFinal, IDLE / 2); }
  });
  await sleep(60);
  const r8 = await empty.send(scanMsg(), RESTORE + 3000);
  check(r8 && r8.ok === true,
    '「内容脚本回报了、就是 0 张」是成功态 —— 修「撒谎」不能把「如实」也修坏',
    JSON.stringify(r8));
  check(r8 && r8.images && r8.images.length === 0, '确实是空列表');
  check(r8 && !r8.error, '不带错误码（否则界面会弹「嗅探失败」）', r8 && r8.error);

  /* ================================================================ *
   * 8. 排除列表仍然是「不是失败、是没扫」
   * ================================================================ */
  console.log('\n=== 8. 站点排除列表不受影响 ===');

  const blocked = createBg({
    timeouts: T,
    blocked: true,
    settings: { blockedHosts: ['example.com'] }
  });
  await sleep(60);
  const r9 = await blocked.send(scanMsg(), RESTORE + 3000);
  check(r9 && r9.blocked === true, '仍然如实返回 blocked', JSON.stringify(r9));
  check(r9 && r9.ok === false, 'ok 为 false（图库据此给出「已在排除列表」的说法）');
  check(r9 && r9.error === 'blocked', '错误码仍是 blocked，没有被新的错误分支吃掉', r9 && r9.error);

  /* ================================================================ *
   * 9. 静态断言：这三条不变量在源码里留了痕迹（改坏了要有人拦）
   *
   * 匹配前**必须先剥注释** —— 这个项目已经栽过一次：守卫的正则扫到了
   * 它自己上方注释里举的例子，于是「检查通过」其实检查的是说明文字
   * （见 tests/README 第十六个坑）。这里要断言「main.js 里不再回 busy」，
   * 而我恰好在那段代码上方写了 `error: 'busy'` 来解释它以前的行为。
   * 只抹整行的 `//`，别把 `https://` 一起切掉。
   * ================================================================ */
  console.log('\n=== 9. 源码接线（防止以后被顺手改掉） ===');

  const stripComments = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const src = stripComments(fs.readFileSync(path.join(BASE, 'background.js'), 'utf8'));
  check(/noReply/.test(src) && /reported === 0/.test(src),
    'finalizeScan 里有「一个 frame 都没回报」的判断');
  check(/session\.pending\.size === 0/.test(src),
    'scanTab 里「收到确认后放宽计时」带了「还没收到 partial」的前置条件');
  check(/const ack = await chrome\.tabs\.sendMessage/.test(src),
    'scanTab 真的读了内容脚本的确认（ack），不是发了就不管');
  check(/rec\.error = images\.length \? null/.test(src),
    'onScanResult 不再丢掉内容脚本自报的错误码');

  const main = stripComments(fs.readFileSync(path.join(BASE, 'content/main.js'), 'utf8'));
  check(/queuedScan/.test(main), '内容脚本「忙」时改为排队（不再丢弃那一次请求）');
  check(!/error: 'busy'/.test(main),
    '内容脚本里已经没有「回一个空结果 + busy」这条路径了');

  const scanner = stripComments(fs.readFileSync(path.join(BASE, 'content/scanner.js'), 'utf8'));
  const finishIdx = scanner.indexOf('async function finishList');
  const partialIdx = scanner.indexOf('onPartial(toWireList(', finishIdx);
  const probeIdx = scanner.indexOf('const unknown = list.filter', finishIdx);
  check(partialIdx > 0 && probeIdx > 0 && partialIdx < probeIdx,
    '中间结果的回报排在「补尺寸」之前（否则又会被联网步骤拖住）');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
