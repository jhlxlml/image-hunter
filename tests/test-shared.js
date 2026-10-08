const fs = require('fs');
const path = require('path');
const base = require('path').resolve(__dirname, '..');
const vm = require('vm');

const ctx = { console, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout, Math, Date, JSON };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/utils.js'), 'utf8'), ctx);

const { U, C } = ctx.IH;

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log('FAIL', label, '\n  got     :', JSON.stringify(actual), '\n  expected:', JSON.stringify(expected)); }
}

// --- srcset ---
eq(U.pickLargestFromSrcset('a.jpg 300w, b.jpg 800w, c.jpg 1600w'), 'c.jpg', 'srcset w');
eq(U.pickLargestFromSrcset('a.jpg 1x, b.jpg 2x'), 'b.jpg', 'srcset x');
eq(U.pickLargestFromSrcset(''), '', 'srcset empty');
eq(U.parseSrcset('a.jpg 300w, b.jpg 800w').length, 2, 'parse count');

// --- extFromUrl ---
eq(U.extFromUrl('https://x.com/a/b.JPG?x=1'), 'jpg', 'ext upper+query');
eq(U.extFromUrl('https://x.com/a/b'), '', 'ext none');
eq(U.extFromUrl('data:image/svg+xml;base64,AAA'), 'svg', 'ext data svg');
eq(U.extFromUrl('data:image/jpeg;base64,AAA'), 'jpg', 'ext data jpeg');

// --- normalizeUrl ---
eq(U.normalizeUrl('https://x.com/a.jpg?b=2&a=1#frag'), 'https://x.com/a.jpg?a=1&b=2', 'normalize');

// --- filename ---
eq(U.buildFilename({ url: 'https://cdn.x.com/pic/photo-300x200.jpg', width: 1920, height: 1080 }, { filenameTemplate: '{name}.{ext}' }, 0),
   'photo-300x200.jpg', 'filename basic');
eq(U.buildFilename({ url: 'https://cdn.x.com/a%20b/cat.png' }, { filenameTemplate: '{name}.{ext}' }, 0),
   'cat.png', 'filename decode+space');
eq(U.buildFilename({ url: 'https://x.com/' }, { filenameTemplate: '{name}.{ext}' }, 0), 'x.com.jpg', 'filename root fallback');
eq(U.buildFilename({ url: 'https://x.com/a/b', width: 800 }, { filenameTemplate: '{index}_{w}_{name}.{ext}' }, 7),
   '007_800_b.jpg', 'filename template');

// --- restore rules ---
function applyRules(url) {
  const out = [];
  for (const r of C.BUILTIN_RESTORE_RULES) {
    let v = null;
    try { v = r.apply(url); } catch (e) { v = 'ERR:' + e.message; }
    if (v) out.push([r.id, v]);
  }
  return out;
}
console.log('\n--- restore rules ---');
[
  'https://blog.x.com/wp-content/uploads/2024/05/hero-1024x768.jpg',
  'https://cdn.x.com/upload/w_400,h_300,c_fill/v1234/sample/photo.jpg',
  'https://img.x.com/photo.jpg?imageView2/2/w/300/h/200',
  'https://oss.x.com/pic.jpg?x-oss-process=image/resize,w_300',
  'https://up.x.com/pic.jpg!small',
  'https://gw.alicdn.com/img/abc.jpg_300x300q75.jpg',
  'https://images.unsplash.com/photo-123?auto=format&fit=crop&w=400&q=80',
  'https://x.com/thumbs/photo.jpg',
  'https://x.com/2024/05/photo.jpg'
].forEach((u) => {
  console.log(u);
  const r = applyRules(u);
  if (!r.length) console.log('   (无匹配)');
  r.forEach(([id, v]) => console.log('   ->', id, '=>', v));
});

// --- 回归：bce-process 还原规则（IT之家 / 百度云加速） ---
// 背景：ithome 的图片带 ?x-bce-process=image/auto-orient,o_1/format,f_avif，
// CDN 会返回 AVIF 转码版（52KB）而不是原始 JPEG（746KB），
// 且 Chrome 会按真实 MIME 把落盘文件名从 .jpg 改成 .avif。
console.log('\n--- bce-process（回归）---');
const BCE_IN = 'https://img.ithome.com/newsuploadfiles/2026/9/f667889f-687e-4167-bb6b-2bc55b101b7d.jpg'
  + '?x-bce-process=image/auto-orient,o_1/format,f_avif';
const bceOut = applyRules(BCE_IN);
eq(bceOut.some(([id, v]) => id === 'bce-process'
  && v === 'https://img.ithome.com/newsuploadfiles/2026/9/f667889f-687e-4167-bb6b-2bc55b101b7d.jpg'),
  true, 'bce-process 去掉 x-bce-process 参数，还原为原图地址');
eq(bceOut.some(([id, v]) => id === 'bce-process' && /\?/.test(v)), false,
  'bce-process 的结果不含任何查询串');
eq(applyRules('https://img.ithome.com/x/abc.jpg').some(([id]) => id === 'bce-process'), false,
  'bce-process 对无参数 URL 不返回结果');
eq(applyRules('https://x.com/a.jpg?x-bce-process=image/resize,w_300&keep=1')
  .some(([id, v]) => id === 'bce-process' && v === 'https://x.com/a.jpg?keep=1'),
  true, 'bce-process 只删自己那个参数，其余查询参数保留');

// --- 回归：设置导出 → 导入必须是完整往返 ---
// 背景：importSettings 原来用 Object.keys(DEFAULT_SETTINGS) 做白名单，
// 而 customRules 当时不在 DEFAULT_SETTINGS 里，于是导出文件里明明有规则，
// 导入后却全部消失（静默数据丢失）。
console.log('\n--- 设置导入往返（回归）---');
eq(Object.prototype.hasOwnProperty.call(C.DEFAULT_SETTINGS, 'customRules'), true,
  'customRules 是 DEFAULT_SETTINGS 的已知字段');

const myRules = [
  { pattern: '-\\d{2,4}x\\d{2,4}(?=\\.jpg)', flags: 'i', replace: '' },
  { pattern: '\\?w=\\d+', flags: 'gi', replace: '' }
];
const exported = Object.assign({}, C.DEFAULT_SETTINGS, { customRules: myRules, theme: 'dark' });
const imported = U.mergeImportedSettings(JSON.parse(JSON.stringify(exported)), C.DEFAULT_SETTINGS);
eq(imported.customRules.length, 2, '导入后 2 条自定义规则都在（修复前是 0 条）');
eq(imported.customRules[0].pattern, '-\\d{2,4}x\\d{2,4}(?=\\.jpg)', '规则内容原样保留');
eq(imported.theme, 'dark', '普通字段照常导入');

// 文件里没带 customRules → 不要顺手清空
const noRules = U.mergeImportedSettings({ theme: 'light' }, C.DEFAULT_SETTINGS);
eq(Object.prototype.hasOwnProperty.call(noRules, 'customRules'), false,
  '文件里没有 customRules 时不覆盖现有规则');

// 脏数据要被挡掉
const dirty = U.mergeImportedSettings({ customRules: [
  { pattern: 'ok' },
  null,
  'nope',
  { pattern: '   ' },
  { pattern: 'x', flags: 'i', replace: null }
] }, C.DEFAULT_SETTINGS);
eq(dirty.customRules.length, 2, '脏数据被过滤，只留 2 条合法规则');
eq(dirty.customRules[1].replace, '', 'replace 为 null 时归一成空串');
eq(U.sanitizeCustomRules('not-an-array'), [], '非数组输入返回空数组');
eq(U.mergeImportedSettings(null, C.DEFAULT_SETTINGS), {}, 'null 输入返回空补丁');

// --- 候选生成：必须住在 shared 里（图库页和内容脚本用同一套规则） ---
// 背景：原来 buildRestoreCandidates 只在 content/scanner.js 里，图库页拿不到。
// 而图库要靠它判断「这张卡片值不值得显示『还原』按钮」—— 两边如果各写一份，
// 迟早出现「按钮显示得出来、点了却一个候选都没有」的错位。
console.log('\n--- buildRestoreCandidates（shared）---');
eq(typeof C.buildRestoreCandidates, 'function',
  'IH.C.buildRestoreCandidates 存在（图库页要用它）');

const cand = (url, settings) => C.buildRestoreCandidates(url, settings || {});

// 缩略图目录 → 去掉 /thumb/，命中 path-dim
const thumbCand = cand('https://x.com/thumb/img/0.png');
eq(thumbCand.length >= 1, true, '缩略图地址能生成候选');
eq(thumbCand[0].url, 'https://x.com/img/0.png', '候选是去掉 /thumb/ 的原图地址');
eq(thumbCand[0].ruleId, 'path-dim', '并且如实带上命中的规则 id');

// 本来就是原图 → 一个候选都没有（图库据此不给「还原」按钮）
eq(cand('https://x.com/img/0.png'), [], '本来就是原图的地址生成不出候选');
eq(cand('http://127.0.0.1:8080/img/0.png'), [], '本地原图地址同样生成不出候选');
eq(cand('https://x.com/a/b/c.png'), [], '普通无参数地址生成不出候选');

// data: / blob: 直接跳过
eq(cand('data:image/png;base64,AAAA'), [], 'data: URL 不生成候选');
eq(cand('blob:https://x.com/abc'), [], 'blob: URL 不生成候选');
eq(cand(''), [], '空地址返回空数组');

// 自定义规则也要算进来（否则图库会漏掉用户自己写的规则）。
// 注意用一个**内置规则都不会命中**的地址（?zzz= 不在 query-size 的键表里），
// 否则内置规则会先占住同一个候选地址，ruleId 就不是 'custom' 了。
eq(cand('https://x.com/pic.png?zzz=1', {
  customRules: [{ pattern: '\\?zzz=\\d+', flags: 'g', replace: '' }]
}).some((c) => c.ruleId === 'custom' && c.url === 'https://x.com/pic.png'),
  true, '用户自定义规则命中的候选也在列表里');
eq(cand('https://x.com/pic.png?zzz=1', { customRules: [{ pattern: '(' }] }).length, 0,
  '非法自定义正则应被静默跳过，不能把整个函数炸掉');

// 同一个候选只出现一次，且总数有上限
const many = cand('https://cdn.x.com/upload/w_400,h_300/v1/thumb/photo-800x600.jpg?w=100&x-oss-process=image/resize');
const urls = many.map((c) => c.url);
eq(urls.length === new Set(urls).size, true, '候选去重（同一地址只出现一次）');
eq(many.length <= 6, true, '候选数量有上限（≤ 6），避免一次重试打出一堆请求');

// --- 站点排除列表 ---
// 语义：一条记录 = 一个域名，匹配「它自己」+「它的所有子域名」。
// 刻意不做路径级 / 正则级匹配 —— 用户输入什么，一眼就能看懂自己排除了什么。
console.log('\n--- 站点排除列表 ---');
eq(typeof U.isHostBlocked, 'function', 'IH.U.isHostBlocked 存在');
eq(typeof U.normalizeHostPattern, 'function', 'IH.U.normalizeHostPattern 存在');

// 规范化：允许粘贴完整 URL / 带路径 / 带端口 / 带 user@ / 前导 *.
eq(U.normalizeHostPattern('Example.COM'), 'example.com', '大小写归一');
eq(U.normalizeHostPattern('  example.com  '), 'example.com', '去空白');
eq(U.normalizeHostPattern('https://example.com/a/b?c=1'), 'example.com', '完整 URL 取出域名');
eq(U.normalizeHostPattern('example.com/path'), 'example.com', '没带协议的粘贴也认');
eq(U.normalizeHostPattern('example.com:8443'), 'example.com', '去掉端口');
eq(U.normalizeHostPattern('user@example.com'), 'example.com', '去掉 user@');
eq(U.normalizeHostPattern('*.example.com'), 'example.com', '前导 *. 只是习惯写法');
eq(U.normalizeHostPattern('.example.com.'), 'example.com', '前后多余的点');
eq(U.normalizeHostPattern('localhost'), 'localhost', '单段域名放行');
eq(U.normalizeHostPattern('127.0.0.1'), '127.0.0.1', 'IP 放行');
eq(U.normalizeHostPattern(''), '', '空串返回空');
eq(U.normalizeHostPattern('   '), '', '纯空白返回空');
eq(U.normalizeHostPattern('not a host'), '', '含空格的不认');
eq(U.normalizeHostPattern('http://'), '', '只有协议的不认');
eq(U.normalizeHostPattern(null), '', 'null 返回空');

// 匹配：域名本身 + 所有子域名
eq(U.hostMatches('example.com', 'example.com'), true, '域名本身命中');
eq(U.hostMatches('www.example.com', 'example.com'), true, '子域名命中');
eq(U.hostMatches('img.cdn.example.com', 'example.com'), true, '多级子域名命中');
eq(U.hostMatches('example.com.evil.com', 'example.com'), false,
  '后缀伪装不命中（example.com.evil.com 不是 example.com 的子域）');
eq(U.hostMatches('notexample.com', 'example.com'), false, '部分前缀不命中');
eq(U.hostMatches('example.org', 'example.com'), false, '不同域名不命中');
eq(U.hostMatches('EXAMPLE.COM', 'example.com'), true, '匹配时大小写不敏感');

// 整个 URL 入口
const BLOCK = ['example.com', 'bank.example.cn'];
eq(U.isHostBlocked('https://www.example.com/a/b.jpg', BLOCK), true, 'URL 命中排除列表');
eq(U.isHostBlocked('https://img.cdn.example.com/x.png', BLOCK), true, 'CDN 子域也命中');
eq(U.isHostBlocked('https://other.com/x.png', BLOCK), false, '别的站点不受影响');
eq(U.isHostBlocked('https://example.com/x.png', []), false, '空列表谁都不拦');
eq(U.isHostBlocked('https://example.com/x.png', null), false, 'null 列表不拦（不能炸）');
eq(U.isHostBlocked('', BLOCK), false, '空地址不拦');

// 清洗：规范化 + 去重 + 丢掉无效行
eq(U.sanitizeBlockedHosts(['Example.com', 'https://example.com/x', 'example.com']),
  ['example.com'], '规范化后去重（同一个域名三种写法只留一条）');
eq(U.sanitizeBlockedHosts(['ok.com', '', '   ', 'not a host', null, 42, 'two.com']),
  ['ok.com', 'two.com'], '无效行被丢掉');
eq(U.sanitizeBlockedHosts('not-an-array'), [], '非数组输入返回空数组');
eq(U.sanitizeBlockedHosts(new Array(500).fill('').map((_, i) => 'h' + i + '.com')).length, 200,
  '有上限（≤ 200），避免一个导入文件把设置撑爆');

// 导入往返：blockedHosts 必须和 customRules 一样被单独校验
const importedBlock = U.mergeImportedSettings(
  { blockedHosts: ['Example.com', 'https://www.foo.cn/a'], theme: 'dark' },
  C.DEFAULT_SETTINGS
);
eq(importedBlock.blockedHosts, ['example.com', 'www.foo.cn'], '导入的排除列表被规范化');
eq(U.mergeImportedSettings({ theme: 'light' }, C.DEFAULT_SETTINGS).blockedHosts, undefined,
  '文件里没有 blockedHosts 时不覆盖现有列表');
eq(Object.prototype.hasOwnProperty.call(C.DEFAULT_SETTINGS, 'blockedHosts'), true,
  'blockedHosts 是 DEFAULT_SETTINGS 的已知字段（否则导出→导入会静默丢失）');
eq(C.DEFAULT_SETTINGS.blockedHosts.length, 0, '默认不排除任何站点');

// --- 保存到子目录 ---
console.log('\n--- 保存到子目录 ---');
eq(typeof U.buildSubfolder, 'function', 'IH.U.buildSubfolder 存在');
eq(Object.prototype.hasOwnProperty.call(C.DEFAULT_SETTINGS, 'subfolder'), true,
  'subfolder 是 DEFAULT_SETTINGS 的已知字段');
eq(C.DEFAULT_SETTINGS.subfolder, '', '默认不分子目录');

// 留空 → 不加目录（老行为完全不变）
eq(U.buildFilename({ url: 'https://cdn.x.com/a/photo.jpg' }, { filenameTemplate: '{name}.{ext}' }, 0),
  'photo.jpg', 'subfolder 留空时文件名不含目录');
eq(U.buildFilename({ url: 'https://cdn.x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: '   ' }, 0),
  'photo.jpg', 'subfolder 只有空白时同样不分子目录');

// {host} / {date} 变量
eq(U.buildFilename({ url: 'https://cdn.x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: '{host}' }, 0),
  'cdn.x.com/photo.jpg', '{host} 用真实主机名（不去 www.）');
eq(U.buildFilename({ url: 'https://www.x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: '{host}' }, 0),
  'www.x.com/photo.jpg', '{host} 保留 www. —— 目录名要和地址对得上');
eq(U.buildFilename({ url: 'https://x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: '{date}/{host}' }, 0),
  U.buildSubfolder('{date}', { url: 'https://x.com/a/photo.jpg' }, 0) + '/x.com/photo.jpg',
  '多级子目录（{date}/{host}）');
eq(U.buildFilename({ url: 'https://x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: 'shots/{index}' }, 7),
  'shots/007/photo.jpg', '{index} 在子目录里补零到 3 位');
eq(U.buildFilename({ url: 'https://x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: 'a\\b' }, 0),
  'a/b/photo.jpg', '反斜杠统一成斜杠');

// 路径安全：不能往上跳、不能是绝对路径、不能带盘符
eq(U.buildSubfolder('../../etc', { url: 'https://x.com/a.jpg' }, 0), 'etc',
  '.. 被丢掉（不允许往上跳）');
eq(U.buildSubfolder('..', { url: 'https://x.com/a.jpg' }, 0), '', '纯 .. 什么都不剩');
eq(U.buildSubfolder('/abs/path', { url: 'https://x.com/a.jpg' }, 0), 'abs/path',
  '开头的 / 被去掉（不能是绝对路径）');
eq(U.buildSubfolder('C:\\Windows', { url: 'https://x.com/a.jpg' }, 0), 'C_/Windows',
  '盘符里的 : 被换掉');
eq(U.buildSubfolder('a/b/c/d/e', { url: 'https://x.com/a.jpg' }, 0), 'a/b/c',
  '最多 3 层，模板写飞了也不会挖出深井');
eq(U.buildSubfolder('  /  /  ', { url: 'https://x.com/a.jpg' }, 0), '', '全是分隔符时返回空');
eq(U.buildSubfolder('...', { url: 'https://x.com/a.jpg' }, 0), '',
  '纯点号不留下一层名叫 image 的兜底目录');
eq(U.buildSubfolder('a*b?c', { url: 'https://x.com/a.jpg' }, 0), 'a_b_c',
  'Windows 非法字符换成 _');
eq(U.buildSubfolder('{host}', { url: 'data:image/png;base64,AAA' }, 0), '',
  'data: 地址取不到主机名 → 不生成目录（而不是生成一个字面量 {host}）');

// 序号前缀加的是**文件名**，不是目录名
eq(U.buildFilename({ url: 'https://x.com/a/photo.jpg' },
  { filenameTemplate: '{name}.{ext}', subfolder: '{host}', batchPrefix: true }, 3),
  'x.com/003_photo.jpg', 'batchPrefix 与 subfolder 同时开启时前缀加在文件名上');

// 模板里写 / 也能分子目录（老行为，这里锁住防止回归）
eq(U.buildFilename({ url: 'https://x.com/a/photo.jpg' },
  { filenameTemplate: '{host}/{name}.{ext}' }, 0),
  'x.com/photo.jpg', '文件名模板里写 / 也当子目录');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
