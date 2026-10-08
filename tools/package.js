/* ==========================================================================
 * ImageHunter — tools/package.js
 * 把扩展打包成可以直接上传商店 / 直接拖进 chrome://extensions 的 zip。
 *
 * 用法：
 *   node tools/package.js              → dist/image-hunter-v<版本>.zip
 *   node tools/package.js --list       → 只列出会被打包的文件，不写 zip
 *   node tools/package.js --out x.zip  → 指定输出路径
 *
 * 两个设计取舍：
 *
 * 1. **零依赖**。手写最小 ZIP（local header + central directory + EOCD），
 *    压缩用内置的 zlib。为了一个打包脚本去装 archiver / jszip 不划算，
 *    而且扩展本身是「零依赖零构建」的，工具链也不该例外。
 *
 * 2. **白名单是算出来的，不是手写的**。手写清单迟早会烂（加了个文件忘了写进去，
 *    打包出来的 zip 就是残的，而且**要到用户装上去才发现**）。
 *    这里从 manifest.json 出发，顺着它引用的资源递归展开（HTML 里的
 *    script/link/img 也算引用），最后再反向检查一遍「运行时目录里有没有谁
 *    没被引用到」—— 有就报错。这样「新加了文件但没人引用」会在打包时就被抓住。
 *
 * 时间戳固定：所有条目写同一个 DOS 时间，于是**同样的源码永远打出字节相同的 zip**
 * （可复现构建）。测起来也方便 —— 打两次比对哈希就行。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
/** 会进包的所有目录（根目录下的 manifest.json / background.js 单独算） */
const RUNTIME_DIRS = ['shared', 'content', 'popup', 'options', 'icons', '_locales'];
const ROOT_FILES = ['manifest.json', 'background.js'];
/** 固定时间戳，保证可复现。DOS 时间从 1980 年开始算 */
const FIXED_DATE = new Date(2026, 0, 1, 0, 0, 0);

/* ------------------------------------------------------------------ *
 * CRC32（ZIP 每个条目都要）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ *
 * 白名单：从 manifest 出发把引用关系走一遍
 * ------------------------------------------------------------------ */

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function exists(rel) {
  try { return fs.statSync(path.join(ROOT, rel)).isFile(); } catch (e) { return false; }
}

function listDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).map((n) => rel + '/' + n);
}

/** 把 `icons/*` 这种简单通配展开成真实文件；没有通配符时原样返回 */
function expandRef(rel) {
  if (rel.indexOf('*') < 0) return [rel];
  const dir = path.dirname(rel);
  const base = path.basename(rel);
  const re = new RegExp('^' + base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return listDir(dir).filter((f) => re.test(path.basename(f)));
}

/** 相对某个目录解析引用（HTML 里的 src/href 是相对该 html 的） */
function resolveRel(fromRel, ref) {
  if (!ref) return null;
  if (/^(https?:|data:|chrome-extension:|#|\/\/)/i.test(ref)) return null;
  const clean = ref.split('?')[0].split('#')[0];
  if (!clean) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), clean));
  if (joined.startsWith('..')) return null;
  return joined;
}

/** 从 HTML 里抠出 script src / link href / img src */
function refsInHtml(rel) {
  let html = '';
  try { html = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return []; }
  const out = [];
  const re = /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const r = resolveRel(rel, m[1]);
    if (r) out.push(r);
  }
  return out;
}

/**
 * 算出应该进包的全部文件。
 * @returns {{files: string[], problems: string[]}}
 */
function collectFiles() {
  const problems = [];
  const seen = new Set();
  const queue = [];

  const add = (rel) => {
    if (!rel || seen.has(rel)) return;
    if (!exists(rel)) { problems.push('清单里引用了不存在的文件：' + rel); return; }
    seen.add(rel);
    queue.push(rel);
  };

  ROOT_FILES.forEach(add);

  let mf = null;
  try { mf = readJSON(path.join(ROOT, 'manifest.json')); } catch (e) {
    return { files: [], problems: ['manifest.json 读不了或不是合法 JSON：' + e.message] };
  }

  // 后台
  if (mf.background && mf.background.service_worker) add(mf.background.service_worker);
  if (mf.background && Array.isArray(mf.background.scripts)) mf.background.scripts.forEach(add);

  // 内容脚本（js + css 都要，css 是 manifest 直接注入的那部分）
  (mf.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  });

  // 图标 / 选项页 / 扩展页
  const icons = mf.icons || {};
  Object.keys(icons).forEach((k) => add(icons[k]));
  if (mf.action && mf.action.default_icon) {
    const di = mf.action.default_icon;
    if (typeof di === 'string') add(di);
    else Object.keys(di).forEach((k) => add(di[k]));
  }
  if (mf.options_page) add(mf.options_page);
  if (mf.options_ui && mf.options_ui.page) add(mf.options_ui.page);
  if (mf.action && mf.action.default_popup) add(mf.action.default_popup);

  // web_accessible_resources：页面里靠 URL 拉的那些（overlay.css / popup.html 等）
  (mf.web_accessible_resources || []).forEach((w) => {
    (w.resources || []).forEach((r) => expandRef(r).forEach(add));
  });

  // 语言包
  if (mf.default_locale) add('_locales/' + mf.default_locale + '/messages.json');
  listDir('_locales').forEach((d) => {
    if (exists(d + '/messages.json')) add(d + '/messages.json');
  });

  // 顺着 HTML 继续展开（popup.html 里的 mode.js、options.html 里的 options.js…）
  for (let i = 0; i < queue.length; i++) {
    const rel = queue[i];
    if (/\.html?$/i.test(rel)) refsInHtml(rel).forEach(add);
  }

  // 反向检查：运行时目录里还有谁没被引用到？
  const leftovers = [];
  RUNTIME_DIRS.forEach((dir) => {
    listDir(dir).forEach((f) => {
      let st = null;
      try { st = fs.statSync(path.join(ROOT, f)); } catch (e) { return; }
      if (st.isDirectory()) {
        fs.readdirSync(path.join(ROOT, f)).forEach((n) => {
          if (!seen.has(f + '/' + n)) leftovers.push(f + '/' + n);
        });
        return;
      }
      if (!seen.has(f)) leftovers.push(f);
    });
  });

  if (leftovers.length) {
    problems.push('这些文件在运行时目录里，却没有任何地方引用它们（不会进包）：\n    '
      + leftovers.sort().join('\n    ')
      + '\n  → 如果它们确实该进包，请在 manifest / HTML 里引用；'
      + '\n    如果是废弃文件，请删掉（留着会让人以为它还在用）。');
  }

  return { files: Array.from(seen).sort(), problems };
}

/* ------------------------------------------------------------------ *
 * 最小 ZIP 写入
 * ------------------------------------------------------------------ */

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function buildZip(entries) {
  const { time, date } = dosDateTime(FIXED_DATE);
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    // 压不小就原样存（PNG 这类已经是压缩格式的，deflate 只会白费 CPU）
    let body = e.data;
    let method = 0;
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    if (deflated.length < e.data.length) { body = deflated; method = 8; }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);      // 通用标志位：文件名为 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // 生成方版本
    ch.writeUInt16LE(20, 6);          // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // 起始磁盘号
    ch.writeUInt16LE(0, 36);          // 内部属性
    ch.writeUInt32LE(0, 38);          // 外部属性
    ch.writeUInt32LE(offset, 42);     // local header 偏移
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.indexOf('--list') >= 0;
  const outIdx = argv.indexOf('--out');
  const customOut = outIdx >= 0 ? argv[outIdx + 1] : null;

  const { files, problems } = collectFiles();
  if (problems.length) {
    console.error('\n打包前的检查没通过：\n');
    problems.forEach((p) => console.error('  ✗ ' + p + '\n'));
    process.exit(1);
  }

  const version = readJSON(path.join(ROOT, 'manifest.json')).version;

  if (listOnly) {
    console.log('会打进 zip 的文件（共 ' + files.length + ' 个）：');
    files.forEach((f) => console.log('  ' + f));
    return;
  }

  const entries = files.map((name) => ({
    name,
    data: fs.readFileSync(path.join(ROOT, name))
  }));
  const zip = buildZip(entries);

  const out = customOut
    ? path.resolve(process.cwd(), customOut)
    : path.join(ROOT, 'dist', 'image-hunter-v' + version + '.zip');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip);

  const raw = entries.reduce((n, e) => n + e.data.length, 0);
  console.log('已打包 → ' + out);
  console.log('  版本    v' + version);
  console.log('  文件    ' + entries.length + ' 个');
  console.log('  原始    ' + kb(raw));
  console.log('  压缩后  ' + kb(zip.length) + '（' + Math.round(zip.length / raw * 100) + '%）');
}

function kb(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

if (require.main === module) main();

module.exports = { collectFiles, buildZip, crc32 };
