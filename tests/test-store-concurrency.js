/* ImageHunter — shared/store.js 并发写回归测试
 *
 * 锁死这个 bug：chrome.storage.local 是**异步 IPC**，而 addHistory /
 * addFingerprints / bumpStats 都是「读全量 → 内存改 → 整体写回」。
 * 下载队列默认 concurrency=3，多个 runTask 同时收尾时，后写的会直接
 * 覆盖先写的 —— 实测 5 次并发 addHistory 只落 1 条。
 *
 * 关键：storage 桩**必须带一个宏任务延迟**，否则 await 期间没有让出机会，
 * 竞态窗口会被抹平，测了等于没测（这正是原来的 test-download.js 没抓到的原因）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

/* ------------------------------------------------------------------ *
 * storage 桩：模拟真实 IPC 延迟（每个 get/set 都是一个宏任务）
 * ------------------------------------------------------------------ */

const IPC_DELAY = 5;
let storeData = {};

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

let getCalls = 0;
let setCalls = 0;
let failNextSet = false;
/** storage.onChanged 的回调。手动触发它 = 模拟「别的上下文写了设置」 */
let onChangedCb = null;

const chrome = {
  storage: {
    local: {
      get(keys) {
        getCalls++;
        const snap = clone(storeData);          // 取值即快照 —— 与真实 IPC 一致
        return new Promise((r) => setTimeout(() => {
          if (keys == null) return r(clone(snap));
          if (typeof keys === 'string') {
            const out = {};
            if (keys in snap) out[keys] = snap[keys];
            return r(out);
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in snap) out[k] = snap[k];
            return r(out);
          }
          return r(clone(snap));
        }, IPC_DELAY));
      },
      set(obj) {
        setCalls++;
        return new Promise((resolve, reject) => setTimeout(() => {
          if (failNextSet) { failNextSet = false; reject(new Error('QUOTA_BYTES')); return; }
          for (const k of Object.keys(obj)) storeData[k] = clone(obj[k]);
          resolve();
        }, IPC_DELAY));
      }
    },
    onChanged: { addListener(cb) { onChangedCb = cb; } }
  }
};

const sandbox = {
  console, chrome, setTimeout, clearTimeout,
  Promise, Object, Array, String, Number, Math, Date, JSON, Map, Set
};
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(BASE, 'shared/store.js'), 'utf8'), ctx);

const C = ctx.IH.C;
const S = ctx.IH.Store;
const K = C.STORAGE_KEYS;

function reset() { storeData = {}; getCalls = 0; setCalls = 0; failNextSet = false; }

(async function run() {
  /* --------------------------------------------------------------- *
   * 1. 并发 addHistory：每条都要落盘
   * --------------------------------------------------------------- */
  console.log('=== 1. 并发 addHistory ===');
  reset();
  await Promise.all([0, 1, 2, 3, 4].map((i) =>
    S.addHistory({ ts: 1000 + i, filename: 'h' + i, status: 'done' })));

  const hist = storeData[K.HISTORY] || [];
  check(hist.length === 5, '5 次并发 → 写入 5 条（修复前只有 1 条）', '实际 ' + hist.length);
  check(new Set(hist.map((h) => h.filename)).size === 5,
    '5 条内容互不重复', JSON.stringify(hist.map((h) => h.filename)));

  /* --------------------------------------------------------------- *
   * 2. 并发 addFingerprints：每个指纹都要留下
   * --------------------------------------------------------------- */
  console.log('\n=== 2. 并发 addFingerprints ===');
  reset();
  await Promise.all([0, 1, 2, 3, 4].map((i) => S.addFingerprints(['fp' + i])));

  const fps = Object.keys(storeData[K.FINGERPRINTS] || {});
  check(fps.length === 5, '5 次并发 → 写入 5 个指纹（修复前只有 1 个）', '实际 ' + fps.length);
  check([0, 1, 2, 3, 4].every((i) => fps.indexOf('fp' + i) >= 0),
    'fp0~fp4 全部存在', fps.join(','));

  /* --------------------------------------------------------------- *
   * 3. 并发 bumpStats：累加不能丢
   * --------------------------------------------------------------- */
  console.log('\n=== 3. 并发 bumpStats ===');
  reset();
  await Promise.all([0, 1, 2, 3, 4].map(() => S.bumpStats({ saved: 1, bytes: 100 })));

  const st = storeData[K.STATS] || {};
  check(st.saved === 5, 'saved 累加到 5（修复前是 1）', String(st.saved));
  check(st.bytes === 500, 'bytes 累加到 500（修复前是 100）', String(st.bytes));

  /* --------------------------------------------------------------- *
   * 4. 高并发压力：20 次混合写
   * --------------------------------------------------------------- */
  console.log('\n=== 4. 20 次高并发混合写 ===');
  reset();
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(S.addHistory({ ts: i, filename: 'm' + i }));
    jobs.push(S.addFingerprints(['mf' + i]));
    jobs.push(S.bumpStats({ saved: 1 }));
  }
  await Promise.all(jobs);

  check((storeData[K.HISTORY] || []).length === 20,
    '20 条历史一条不少', String((storeData[K.HISTORY] || []).length));
  check(Object.keys(storeData[K.FINGERPRINTS] || {}).length === 20,
    '20 个指纹一个不少', String(Object.keys(storeData[K.FINGERPRINTS] || {}).length));
  check((storeData[K.STATS] || {}).saved === 20,
    '统计累加到 20', String((storeData[K.STATS] || {}).saved));

  /* --------------------------------------------------------------- *
   * 5. 顺序性：串行调用的先后关系必须保持（历史是新条目在前）
   * --------------------------------------------------------------- */
  console.log('\n=== 5. 写入顺序 ===');
  reset();
  await Promise.all([S.addHistory({ filename: 'first' }), S.addHistory({ filename: 'second' })]);
  const ordered = (storeData[K.HISTORY] || []).map((h) => h.filename);
  check(ordered[0] === 'second' && ordered[1] === 'first',
    '后调用的排在前面，且顺序确定（不被异步打乱）', JSON.stringify(ordered));

  /* --------------------------------------------------------------- *
   * 6. clear 与 add 交错
   * --------------------------------------------------------------- */
  console.log('\n=== 6. clear 与 add 交错 ===');
  reset();
  const p1 = S.addHistory({ filename: 'x1' });
  const p2 = S.clearHistory();
  const p3 = S.addHistory({ filename: 'x2' });
  await Promise.all([p1, p2, p3]);
  const after = (storeData[K.HISTORY] || []).map((h) => h.filename);
  check(after.length === 1 && after[0] === 'x2',
    'clear 之后写的才留下（顺序确定，结果可预测）', JSON.stringify(after));

  /* --------------------------------------------------------------- *
   * 7. 一次失败不能卡死整条链
   * --------------------------------------------------------------- */
  console.log('\n=== 7. 写失败后的恢复 ===');
  reset();
  failNextSet = true;
  await S.addHistory({ filename: 'boom' }).catch(() => {});
  await S.addHistory({ filename: 'after-boom' });
  const rec = (storeData[K.HISTORY] || []).map((h) => h.filename);
  check(rec.indexOf('after-boom') >= 0,
    '前一次写失败后，后续写入仍能正常落盘', JSON.stringify(rec));

  /* --------------------------------------------------------------- *
   * 8. 指纹上限淘汰仍生效
   * --------------------------------------------------------------- */
  console.log('\n=== 8. 指纹上限淘汰 ===');
  reset();
  const LIMIT = C.FINGERPRINT_LIMIT;
  const big = [];
  for (let i = 0; i < LIMIT + 50; i++) big.push('bulk' + i);
  await S.addFingerprints(big);
  const map = storeData[K.FINGERPRINTS] || {};
  check(Object.keys(map).length === LIMIT,
    '超出 FINGERPRINT_LIMIT 时被裁剪到 ' + LIMIT, String(Object.keys(map).length));
  check(!map.bulk0 && !!map['bulk' + (LIMIT + 49)],
    '淘汰的是最旧的、保留的是最新的');

  /* --------------------------------------------------------------- *
   * 9. 「读的期间有人写了」—— 迟到的读不能把新值盖回旧的
   *
   * 这是第 1~8 节的镜像：那边是写入被覆盖（丢写入），这边是**读**过时
   * （丢读取的时效性）。真实触发路径：
   *   SW 冷启动 → bootstrap() 的 loadSettings 挂在 storage.get 上
   *             → options 页保存设置 → onChanged 把缓存更新成新值
   *             → 那个迟到的 get 一 resolve 就把新值盖回旧的，
   *               而且 loaded 已是 true，之后再没有机会纠正。
   * 表现：「设置明明保存了，扩展却按旧设置跑」。
   * --------------------------------------------------------------- */
  console.log('\n=== 9. 读期间的写入不被迟到的读盖掉 ===');
  reset();
  storeData[K.SETTINGS] = { theme: 'light', blockedHosts: [] };

  const pending = S.loadSettings(true);        // 读开始（IPC_DELAY 后才回来）
  // 读还没回来时，别的上下文写了一次设置（options 页 → onChanged）
  onChangedCb({ [K.SETTINGS]: { newValue: { theme: 'dark', blockedHosts: ['example.com'] } } }, 'local');

  const got = await pending;
  check(got.theme === 'dark', '迟到的读返回的是新值，不是它读到的旧值', String(got.theme));
  check(S.getSettings().theme === 'dark', '内存缓存也没有被盖回旧的', String(S.getSettings().theme));
  check(JSON.stringify(S.getSettings().blockedHosts) === '["example.com"]',
    '刚写入的排除列表还在（这正是浏览器套件里踩到的那个现象）',
    JSON.stringify(S.getSettings().blockedHosts));

  // 对照：没有并发写入时，读照常从存储里取
  reset();
  storeData[K.SETTINGS] = { theme: 'auto' };
  const normal = await S.loadSettings(true);
  check(normal.theme === 'auto', '没有并发写入时，强制重读照常生效', String(normal.theme));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
