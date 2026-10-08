/* ImageHunter — 诊断包构建测试（纯函数，无需 jsdom）
 *
 * 这个套件守的不是「功能对不对」，而是**边界**：
 * 诊断包是要被用户贴到公开 issue 里的文件，所以它最重要的性质是
 * 「里面不可能出现完整地址」。这件事没法靠「我们记得没写」来保证，
 * 只能靠白名单 + scrub + audit 三层，然后在这里把三层各钉一遍。
 *
 * 其中最关键的一组是**注入式**断言：故意往输入里塞 referer / cookie /
 * 完整 URL，然后要求它们一个字都不出现在输出里。将来谁把白名单改成
 * `Object.assign` 整体透传，这几条会立刻变红。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const base = path.resolve(__dirname, '..');
const ctx = { console, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout, Math, Date, JSON, isFinite, String };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/utils.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/diagnostics.js'), 'utf8'), ctx);

const D = ctx.IH.Diag;

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label);
  else bad(label, 'got ' + a + ' / want ' + b);
}

check(!!D, 'IH.Diag 已挂到全局');

/* ================================================================== *
 * 1. hostOf —— 只取主机名，路径与查询串一律不进
 * ================================================================== */
console.log('\n=== 1. hostOf ===');
eq(D.hostOf('https://www.Example.com/a/b/c.png?token=secret#frag'), 'example.com', '去 www. 并小写，丢掉路径/查询/锚点');
eq(D.hostOf('http://cdn.x.com:8080/p.jpg'), 'cdn.x.com:8080', '保留端口（同主机不同端口的排障信息有用）');
eq(D.hostOf('data:image/png;base64,AAAA'), '', 'data URL 没有主机名');
eq(D.hostOf(''), '', '空串安全');
eq(D.hostOf(null), '', 'null 安全');

/* ================================================================== *
 * 2. scrub —— 任何 scheme:// 都换成 [url]
 * ================================================================== */
console.log('\n=== 2. scrub ===');
check(D.scrub('GET https://cdn.x.com/a.png 失败') === 'GET [url] 失败', 'http(s) 地址被替换');
check(D.scrub('见 http://a.b/c 和 https://d.e/f') === '见 [url] 和 [url]', '同一串里多处地址都替换');
check(D.scrub('错误码 HTTP 403') === '错误码 HTTP 403', '不含地址的文本原样保留');
check(D.scrub('chrome-extension://abc/x.js') === '[url]', '非 http 的自定义协议也算地址');
check(D.scrub(123) === 123, '非字符串原样返回');
// 正则不能带 g 造成 lastIndex 状态污染：连调两次结果必须一致
const s1 = D.scrub('https://a.b/c');
const s2 = D.scrub('https://a.b/c');
check(s1 === s2 && s1 === '[url]', 'scrub 无状态（连调两次结果一致）');

/* ================================================================== *
 * 3. sanitizeDownload —— 白名单 + 脱敏
 * ================================================================== */
console.log('\n=== 3. sanitizeDownload ===');
const dirty = {
  index: 7,
  ts: 1700000000000,
  url: 'https://cdn.x.com/private/path/photo-300x200.jpg?token=SECRET123',
  pageUrl: 'https://intranet.example.local/admin/panel?id=9',
  filename: 'sub/photo.jpg',
  status: 'done',
  bytes: 204800,
  referer: 'https://secret.example/where-i-came-from',
  cookie: 'session=abc',
  error: undefined
};
const sd = D.sanitizeDownload(dirty);
console.log('  ' + JSON.stringify(sd));
eq(Object.keys(sd).sort(), ['bytes', 'filename', 'host', 'status', 'ts'], '结果只含白名单字段');
check(sd.host === 'cdn.x.com', 'host 从 url 现算，且不含路径与查询串', sd.host);
check(JSON.stringify(sd).indexOf('SECRET123') < 0, '查询串里的 token 不在结果里');
check(JSON.stringify(sd).indexOf('private/path') < 0, '图片路径不在结果里');
check(JSON.stringify(sd).indexOf('intranet.example.local') < 0, '页面地址不在结果里');
check(JSON.stringify(sd).indexOf('referer') < 0 && JSON.stringify(sd).indexOf('cookie') < 0,
  '未列入白名单的 referer / cookie 连键都不出现');

eq(D.sanitizeDownload({ url: 'https://a.b/x.png', status: 'failed', error: 'HTTP 403 from https://a.b/x.png' }).error,
  'HTTP 403 from [url]', '错误信息里的地址被 scrub');

const weird = D.sanitizeDownload({ url: '', status: 'weird-status-aaaaaaaaaaaaaaaaaaaaaa', bytes: '2048' });
eq(weird.ts, null, '缺 ts → null（不编一个时间出来）');
eq(weird.bytes, 0, 'bytes 不是数字 → 0');
check(String(weird.status).length <= 24, '未知 status 被截断到 24 字', String(weird.status).length);
eq(D.sanitizeDownload(null), null, 'null 条目被丢弃');
eq(D.sanitizeDownload('nope'), null, '非对象条目被丢弃');

/* ================================================================== *
 * 4. sanitizeScan —— 聚合数字 + 主机名
 * ================================================================== */
console.log('\n=== 4. sanitizeScan ===');
const scanIn = {
  at: 1700000000000,
  pageHost: 'shop.example.com',
  pageUrl: 'https://shop.example.com/item/12345?from=ads',
  title: '某个具体的商品标题',
  frameCount: 3,
  found: 412,
  truncated: true,
  restored: 380,
  notRestored: 32,
  restoreTruncated: true,
  bgTruncatedFrames: 1,
  bgTruncatedElements: 8000,
  deepTruncated: false,
  blocked: false,
  cached: false,
  sourceCounts: { img: 300, bg: 90, srcset: 22, evil: 'nope' }
};
const ss = D.sanitizeScan(scanIn);
console.log('  ' + JSON.stringify(ss));
check(ss.pageUrl === undefined && ss.title === undefined, '页面地址与标题不进诊断包');
eq(ss.sourceCounts, { img: 300, bg: 90, srcset: 22 }, 'sourceCounts 只保留数字值');
eq(ss.found, 412, '聚合数字原样保留');
eq(ss.pageHost, 'shop.example.com', '只留主机名');
eq(D.sanitizeScan(null), null, 'null 安全');
check(D.sanitizeScan({ pageHost: 'https://x.y/z' }).pageHost === '[url]', '主机名位置混进地址也会被 scrub');

/* ================================================================== *
 * 5. sanitizeSettings —— 排除列表只留条数
 * ================================================================== */
console.log('\n=== 5. sanitizeSettings ===');
const settingsIn = {
  mergeTabs: false,
  scanBackground: true,
  subfolder: 'imghunter',
  blockedHosts: ['a.com', 'b.com', 'intranet.corp.local'],
  customRules: [{ pattern: 'x', flags: 'i', replace: 'https://cdn.x.com/big.jpg' }]
};
const st = D.sanitizeSettings(settingsIn);
console.log('  ' + JSON.stringify(st));
check(st.blockedHosts === undefined, 'blockedHosts 清单本身不导出（它是浏览轨迹）');
eq(st.blockedHostsCount, 3, '只留条数');
eq(st.mergeTabs, false, '普通开关原样保留');
check(JSON.stringify(st).indexOf('intranet.corp.local') < 0, '被排除的站点域名一个字都不出现');
check(st.customRules[0].replace === '[url]', '自定义规则里的地址被 scrub');
eq(D.sanitizeSettings(null), {}, 'null → 空对象');

/* ================================================================== *
 * 6. build —— 组装
 * ================================================================== */
console.log('\n=== 6. build ===');
const NOW = Date.UTC(2026, 9, 8, 7, 30, 12);   // 2026-10-08T07:30:12Z
const diag = D.build({
  version: '1.13.0',
  platform: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
  language: 'zh-CN',
  settings: settingsIn,
  recentDownloads: [dirty, { url: 'https://a.b/c.png', status: 'skipped', ts: 1 }],
  lastScan: scanIn,
  probe: { ok: 4, failed: 6, lastAt: 1700000000000, urls: ['https://secret/'] },
  now: NOW
});
console.log('  ' + JSON.stringify(diag).slice(0, 300) + ' …');
eq(diag._app, 'image-hunter', '_app 固定');
eq(diag._format, 1, '_format 版本号');
eq(diag._version, '1.13.0', '版本号透传');
eq(diag.createdAt, '2026-10-08T07:30:12.000Z', 'createdAt 用注入的 now');
eq(diag.platform.language, 'zh-CN', '语言透传');
eq(diag.recentDownloads.length, 2, '两条下载记录都保留');
eq(diag.recentDownloadsCount, 2, '条数与数组一致');
eq(diag.probe, { ok: 4, failed: 6, lastAt: 1700000000000 }, 'probe 只保留计数，urls 不出现');
check(Array.isArray(diag.notes) && diag.notes.length >= 2, '带 notes（告诉读的人哪些是故意没有的）');
eq(D.build({}).lastScan, null, 'lastScan 缺失 → null 而不是 {}');
eq(D.build({}).recentDownloads, [], 'recentDownloads 缺失 → 空数组');
eq(D.build({ recentDownloads: [null, 'x', 0] }).recentDownloads.length, 0, '垃圾条目被过滤');

/* ================================================================== *
 * 7. audit —— 自查
 * ================================================================== */
console.log('\n=== 7. audit ===');
eq(D.audit({ a: 1, b: 'plain text' }), [], '干净对象 → 无违规');
eq(D.audit({ a: 'see https://x.y/z' }), ['$.a'], '发现地址并报出路径');
eq(D.audit({ list: [{ ok: 1 }, { bad: 'http://q.r/s' }] }), ['$.list[1].bad'], '数组下标路径正确');
eq(D.audit('https://x.y/z'), ['$'], '顶层字符串也查');

/* ================================================================== *
 * 8. 端到端不变量：脏输入 → 干净输出
 * ================================================================== */
console.log('\n=== 8. 端到端：脏输入进来，地址一个字都出不去 ===');
const json = JSON.stringify(diag);
check(json.indexOf('http://') < 0 && json.indexOf('https://') < 0,
  '序列化后的诊断包里没有任何 http(s) 地址');
check(json.indexOf('SECRET123') < 0 && json.indexOf('session=abc') < 0,
  'token / cookie 值不出现');
eq(D.audit(diag), [], '导出前自查通过（audit 返回空）');
check(json.indexOf('intranet.example.local') < 0, '内网主机名不出现');
check(json.indexOf('某个具体的商品标题') < 0, '页面标题不出现');

/* ================================================================== *
 * 9. fileName
 * ================================================================== */
console.log('\n=== 9. fileName ===');
eq(D.fileName(Date.UTC(2026, 9, 8, 7, 30, 12)), 'image-hunter-diag-20261008-153012.json',
  '文件名带本地时间戳（UTC+8）');
check(/^image-hunter-diag-\d{8}-\d{6}\.json$/.test(D.fileName()), '文件名格式稳定');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
