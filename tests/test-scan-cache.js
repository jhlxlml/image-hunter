/* ImageHunter — 扫描结果缓存的回归测试
 *
 * 缓存这种东西最危险的地方不是「没生效」，而是**给错东西还看起来正常**：
 *   · 键里不带地址 → 同一标签页导航到别的页面后，返回上一个页面的图片列表
 *   · 刷新后仍命中 → 页面内容重来了一遍，却拿旧列表去对新的 DOM
 *   · 绕不开 → 用户点「重新嗅探」还是拿到几分钟前那份，按钮成了摆设
 *   · 设置改了不清 → 拿按旧设置扫的列表冒充新设置的结果
 *
 * 所以这个套件不测「缓存能不能命中」，重点是测**这些不该命中的场合确实不命中**，
 * 以及「命中时要如实带上 cached 标记」。
 *
 * 另一个重点是**跨 SW 回收**：缓存存 storage.session 而不是内存，就是为了
 * 「关掉图库、过一会儿再打开」这种 SW 最可能已经被回收的场景。
 * 这里用「重新建一个 vm context 加载 background.js」来模拟 SW 重启 ——
 * 存储桩是同一个对象，于是能验证「上次存的这次还读得到」。
 *
 * 后台的 vm 桩（假 chrome）已经搬去 tests/lib/bgstub.js —— 扫描超时判据那个套件
 * 也要用同一套桩，两份迟早会分叉。
 */
'use strict';

const { createBg, PAGE_A, PAGE_B } = require('./lib/bgstub');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scanMsg = (extra) => Object.assign({ type: 'IH_SCAN_TAB', tabId: 1 }, extra || {});

(async function run() {
  /* ================================================================ *
   * 1. 基本命中 / 不命中
   * ================================================================ */
  console.log('=== 1. 同一页第二次打开走缓存 ===');

  const bg = createBg();
  await sleep(60);   // 等 bootstrap 跑完

  const r1 = await bg.send(scanMsg());
  check(r1 && r1.ok === true, '第一次扫描成功');
  check(!r1.cached, '第一次不是缓存（没有 cached 标记）');
  check(bg.st.scanCount === 1, '真的扫了一次', 'scanCount=' + bg.st.scanCount);
  check(r1.images.length === 2, '拿到 2 张图');

  const r2 = await bg.send(scanMsg());
  check(r2 && r2.ok === true, '第二次扫描成功');
  check(r2.cached === true, '第二次命中缓存（cached:true）');
  check(typeof r2.cachedAt === 'number' && r2.cachedAt > 0, '带上了缓存落盘时间 cachedAt');
  check(bg.st.scanCount === 1, '没有真的重扫', 'scanCount=' + bg.st.scanCount);
  check(JSON.stringify(r2.images) === JSON.stringify(r1.images), '图片列表与第一次一致');
  check(r2.reqId && r2.reqId !== r1.reqId, '缓存命中时换了新的 reqId（不沿用旧扫描的）',
    r1.reqId + ' → ' + r2.reqId);

  /* ================================================================ *
   * 2. 绕得开：force 与 deep
   * ================================================================ */
  console.log('\n=== 2. 「重新嗅探」与深度嗅探必须绕过缓存 ===');

  const r3 = await bg.send(scanMsg({ force: true }));
  check(!r3.cached, 'force:true 不走缓存');
  check(bg.st.scanCount === 2, '真的重扫了一次', 'scanCount=' + bg.st.scanCount);

  const r4 = await bg.send(scanMsg({ deep: true }));
  check(!r4.cached, 'deep:true 不走缓存');
  check(bg.st.scanCount === 3, '深度嗅探真的扫了', 'scanCount=' + bg.st.scanCount);

  const r5 = await bg.send(scanMsg());
  check(r5.cached === true, '重扫之后又有新缓存可用了');

  /* ================================================================ *
   * 3. 地址变了不能命中（最坏的一种错：看着正常、内容全错）
   * ================================================================ */
  console.log('\n=== 3. 导航到别的页面后不能命中 ===');

  bg.setUrl(PAGE_B);
  const r6 = await bg.send(scanMsg());
  check(!r6.cached, '换了地址就不命中');
  check(bg.st.scanCount === 4, '重新扫了一次', 'scanCount=' + bg.st.scanCount);
  check(r6.pageUrl === PAGE_B, '结果里的 pageUrl 是新地址', r6.pageUrl);

  // 回到 A：A 的缓存还在（没有被 B 挤掉，键里带地址）
  bg.setUrl(PAGE_A);
  const r7 = await bg.send(scanMsg());
  check(r7.cached === true, '切回 A 仍能命中 A 自己的缓存');

  /* ================================================================ *
   * 4. 刷新（URL 不变）必须作废缓存
   * ================================================================ */
  console.log('\n=== 4. 刷新页面（URL 不变）也要作废 ===');

  bg.fireUpdated({ status: 'loading' });
  const r8 = await bg.send(scanMsg());
  check(!r8.cached, '刷新之后不命中（URL 没变但页面重来了）');
  check(bg.st.scanCount === 5, '重新扫了一次', 'scanCount=' + bg.st.scanCount);

  /* ================================================================ *
   * 5. 地址变化 / 标签页关闭
   * ================================================================ */
  console.log('\n=== 5. 地址变化与标签页关闭 ===');

  await bg.send(scanMsg());          // 先攒一份缓存
  bg.fireUpdated({ url: PAGE_B });   // 地址变化事件
  const r9 = await bg.send(scanMsg());
  check(!r9.cached, 'onUpdated 报地址变化后不命中');

  await bg.send(scanMsg());
  bg.fireRemoved();
  const r10 = await bg.send(scanMsg());
  check(!r10.cached, '标签页关闭后不命中');

  /* ================================================================ *
   * 6. 设置变了要清空（否则拿旧设置的列表冒充新设置的结果）
   * ================================================================ */
  console.log('\n=== 6. 设置变更清空缓存 ===');

  await bg.send(scanMsg());
  const before = await bg.send(scanMsg());
  check(before.cached === true, '设置变更前是命中的');

  await bg.send({ type: 'IH_SETTINGS_CHANGED' });
  await sleep(30);
  const after = await bg.send(scanMsg());
  check(!after.cached, '设置变更后不再命中（扫描来源/还原规则都可能变了）');

  /* ================================================================ *
   * 7. 被排除的站点不该留下缓存
   * ================================================================ */
  console.log('\n=== 7. 排除列表里的站点不缓存 ===');

  const bg2 = createBg({ settings: { blockedHosts: ['example.com'] } });
  await sleep(60);
  const b1 = await bg2.send(scanMsg());
  check(b1 && b1.blocked === true, '被排除的站点如实返回 blocked');
  const b2 = await bg2.send(scanMsg());
  check(!b2.cached, 'blocked 的结果不进缓存（每次都要按最新设置重新判断）');

  /* ================================================================ *
   * 8. 跨 SW 回收：缓存存在 storage.session 里，重启后还在
   * ================================================================ */
  console.log('\n=== 8. SW 被回收后缓存仍在（storage.session） ===');

  const shared = {};
  const sw1 = createBg({ sessionStore: shared });
  await sleep(60);
  await sw1.send(scanMsg());
  check(sw1.st.scanCount === 1, '第一个 SW 实例扫了一次');
  const persisted = shared.ih_scan_cache;
  check(persisted && Object.keys(persisted).length === 1, '缓存写进了 session 存储',
    persisted ? Object.keys(persisted).join(',') : '(无)');

  // 新实例 = SW 重启，内存全丢，只剩 session 存储
  const sw2 = createBg({ sessionStore: shared });
  await sleep(60);
  const r11 = await sw2.send(scanMsg());
  check(r11.cached === true, '重启后的新实例仍然命中缓存');
  check(sw2.st.scanCount === 0, '新实例一次真实扫描都没跑', 'scanCount=' + sw2.st.scanCount);

  /* ================================================================ *
   * 9. TTL 过期
   * ================================================================ */
  console.log('\n=== 9. 超过 TTL 不再命中 ===');

  const stale = {};
  stale.ih_scan_cache = {
    ['1|' + PAGE_A]: {
      // 6 分钟前存的 —— 超过 5 分钟 TTL
      at: Date.now() - 6 * 60 * 1000,
      result: { ok: true, images: [{ url: 'https://old.example.com/x.png' }], pageUrl: PAGE_A }
    }
  };
  const bg3 = createBg({ sessionStore: stale });
  await sleep(60);
  const s1 = await bg3.send(scanMsg());
  check(!s1.cached, '过期条目不命中');
  check(bg3.st.scanCount === 1, '改为真实扫描', 'scanCount=' + bg3.st.scanCount);
  check(s1.images[0].url !== 'https://old.example.com/x.png', '拿到的不是过期那份数据');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
