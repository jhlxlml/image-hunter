/* ImageHunter — 打包脚本（tools/package.js）的回归测试
 *
 * 打包这件事的失败方式是**延迟的**：清单漏了一个文件，本地跑得好好的，
 * 直到用户装上商店版才发现某个页面白屏。所以这里测的重点不是「能不能打出 zip」，
 * 而是：
 *
 *   1. manifest 引用的每个文件都在包里（漏一个就是残包）
 *   2. 运行时目录里没有「谁都没引用」的孤儿文件（新加了文件忘了接线 → 报错）
 *   3. 打出来的 zip 是**真的 zip** —— 用独立实现的读取器解析中央目录、
 *      逐个校验 CRC 并解压比对内容（自己写的写入器配自己写的读取器容易一起错，
 *      所以读取器按 ZIP 规范从头写，只认中央目录，不参考写入器的布局）
 *   4. 可复现：同样的源码打两次，字节完全相同
 *   5. 包里不该有 tests / *.md / 截图
 *
 * 另外手工用 Python 的 zipfile 独立验证过一次（`zipfile.testzip()` 全过、
 * 24 个条目与磁盘文件逐字节一致），确认不是「只有自己读得懂」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const { collectFiles, buildZip, crc32 } = require('../tools/package.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}

/* ------------------------------------------------------------------ *
 * 独立实现的 ZIP 读取器（只认中央目录，按规范来）
 * ------------------------------------------------------------------ */

function readZip(buf) {
  // EOCD 在文件末尾，注释最长 65535，所以从后往前找签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD —— 这不是一个 zip');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (p + cdSize !== eocd) throw new Error('中央目录大小与偏移对不上');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录条目签名不对 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('局部头签名不对：' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('不认识的压缩方法 ' + method + '：' + name);

    if (data.length !== usize) throw new Error('解压后长度不符：' + name);
    if (crc32(data) !== crc) throw new Error('CRC 不符：' + name);

    entries.push({ name, method, data });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/* ================================================================== *
 * 开始
 * ================================================================== */

console.log('=== 1. 清单：manifest 引用的都要在，孤儿文件要报错 ===');

const { files, problems } = collectFiles();
check(problems.length === 0, '清单检查没有报问题', problems.join(' | '));

const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const required = ['manifest.json', mf.background.service_worker];
(mf.content_scripts || []).forEach((cs) => {
  (cs.js || []).forEach((f) => required.push(f));
  (cs.css || []).forEach((f) => required.push(f));
});
(mf.web_accessible_resources || []).forEach((w) => {
  (w.resources || []).forEach((r) => {
    if (r.indexOf('*') < 0) required.push(r);
  });
});
required.push(mf.options_page);
Object.keys(mf.icons || {}).forEach((k) => required.push(mf.icons[k]));
Object.keys((mf.action && mf.action.default_icon) || {}).forEach((k) => required.push(mf.action.default_icon[k]));
required.push('_locales/' + mf.default_locale + '/messages.json');

const missing = required.filter((f) => files.indexOf(f) < 0);
check(missing.length === 0, 'manifest 直接引用的 ' + required.length + ' 个路径全部在包里',
  missing.join(', '));

// HTML 里引用的（popup/mode.js 这种只出现在 <script src> 里的）
check(files.indexOf('popup/mode.js') >= 0,
  'HTML 里 <script src> 引到的文件也被带上了（popup/mode.js）');
check(files.indexOf('options/options.js') >= 0, '设置页的脚本在包里');
check(files.indexOf('options/options.css') >= 0, '设置页的样式在包里');
check(files.indexOf('content/overlay.css') >= 0,
  'overlay.css 在包里（它是运行时靠 URL 拉的，最容易漏）');
check(files.indexOf('_locales/en/messages.json') >= 0, '英文语言包也在（虽然界面是中文）');

const junk = files.filter((f) => /^tests\//.test(f) || /\.md$/i.test(f) || /\.png$/i.test(f) && !/^icons\//.test(f));
check(junk.length === 0, '包里没有 tests / markdown / 根目录截图', junk.join(', '));
check(files.every((f) => !path.isAbsolute(f) && f.indexOf('..') < 0), '所有条目路径都是相对的、不越界');

console.log('\n=== 2. 孤儿文件必须被发现 ===');

// 造一个没人引用的文件，清单检查应该报错 —— 这条就是「新加了文件忘了接线」的护栏
const orphan = path.join(ROOT, 'shared', '_orphan-probe.js');
try {
  fs.writeFileSync(orphan, '/* 临时探针 */\n');
  const r = collectFiles();
  check(r.problems.length > 0, '有孤儿文件时清单检查会报错');
  check(r.problems.join(' ').indexOf('_orphan-probe.js') >= 0,
    '报错信息里点名了那个文件', r.problems.join(' | '));
  check(r.files.indexOf('shared/_orphan-probe.js') < 0, '孤儿文件不会被塞进包');
} finally {
  fs.unlinkSync(orphan);
}
const after = collectFiles();
check(after.problems.length === 0, '删掉探针之后又恢复正常', after.problems.join(' | '));

console.log('\n=== 3. zip 是合法的、内容对得上 ===');

const entries = files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }));
const zip = buildZip(entries);
check(zip.slice(0, 4).toString('binary') === 'PK\x03\x04', '以 PK\\x03\\x04 开头（本地文件头签名）');

const parsed = readZip(zip);
check(parsed.length === entries.length, '条目数与清单一致',
  parsed.length + ' vs ' + entries.length);
check(parsed.map((e) => e.name).join(',') === entries.map((e) => e.name).join(','),
  '条目顺序与清单一致');

const mismatched = [];
parsed.forEach((e) => {
  const src = fs.readFileSync(path.join(ROOT, e.name));
  if (!src.equals(e.data)) mismatched.push(e.name);
});
check(mismatched.length === 0, '每个条目解压后与磁盘文件逐字节一致', mismatched.join(', '));

const compressed = parsed.filter((e) => e.method === 8).length;
check(compressed > 0, '有条目真的走了 deflate（' + compressed + '/' + parsed.length + '）');

// PNG 已经压过了，再 deflate 只会白费 CPU —— 应该原样存
const png = parsed.filter((e) => /^icons\//.test(e.name));
check(png.length > 0 && png.every((e) => e.method === 0),
  'PNG 图标按「存储」写入（压不动就不压）');

const manifestInZip = JSON.parse(parsed.find((e) => e.name === 'manifest.json').data.toString('utf8'));
check(manifestInZip.version === mf.version, '包里的 manifest 版本与仓库一致', manifestInZip.version);
check(parsed.some((e) => e.name === 'manifest.json' && e.name.indexOf('/') < 0),
  'manifest.json 在压缩包根目录（否则商店会拒收）');

console.log('\n=== 4. 可复现：同样的源码打两次，字节完全相同 ===');

const zip2 = buildZip(files.map((name) => ({
  name,
  data: fs.readFileSync(path.join(ROOT, name))
})));
check(zip.equals(zip2), '两次打包结果字节一致（时间戳固定，没有随机成分）');

console.log('\n=== 5. 顺手：crc32 实现是对的 ===');

// 标准测试向量
check(crc32(Buffer.from('')) === 0, '空串 CRC32 = 0');
check(crc32(Buffer.from('123456789')) === 0xcbf43926,
  'CRC32("123456789") = 0xCBF43926', '0x' + crc32(Buffer.from('123456789')).toString(16));
check(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')) === 0x414fa339,
  'CRC32(quick brown fox) = 0x414FA339',
  '0x' + crc32(Buffer.from('The quick brown fox jumps over the lazy dog')).toString(16));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
