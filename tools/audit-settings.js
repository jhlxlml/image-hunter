/* ImageHunter — 死设置 / 死常量的半自动巡检
 *
 * 用法：node tools/audit-settings.js
 *
 * 为什么需要它：判一条设置是不是"死的"，靠印象必错。
 * v1.8.1 那轮我就把 `theme`（活的）报成了死设置；v1.9.0 收尾时又把 5 条
 * **全都是活的**设置报成了死设置。两次都栽在同一个地方：
 * **没有回源，凭印象作答。**
 *
 * 这个脚本只做一件事：把每条设置的「定义点 / 读取点 / UI 开关 / 写入点」
 * 机械地列出来，让人一眼看出哪一条真的没有任何读取方。
 * 它**不做判断** —— 判定仍然要人来看（因为反向读取如 `!== false`、
 * 属性访问如 `settings.batchPrefix`、以及 settings 对象被整体传递的场合，
 * 都不是简单的字符串匹配能覆盖的）。
 *
 * 判据（v1.8.1 / v1.9.0 两次踩坑总结）：
 *   1. 「没有 UI 开关」≠「改不了」 —— mergeImportedSettings 的白名单 = DEFAULT_SETTINGS，
 *      任何在默认设置里的键都能被导入 JSON 写到（shared/utils.js:451）
 *   2. 「没搜到读取点」≠「没有读取点」 —— 反向判断（!== false / || 默认值）、
 *      属性链（settings.batchPrefix）、以及把整个 settings 传下去的场合都会漏
 *   3. 所以每个候选都要**打开文件看那几行原代码**，脚本只负责把候选缩到一小撮
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 产品代码（不含测试、不含打包产物） */
const SRC_DIRS = ['shared', 'content', 'popup', 'options'];
const SRC_FILES = ['background.js'];
const EXTS = ['.js', '.html', '.css', '.json'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.includes(path.extname(name))) out.push(p);
  }
  return out;
}

function collectSources() {
  const files = [];
  for (const d of SRC_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  for (const f of SRC_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) files.push(abs);
  }
  const manifests = [path.join(ROOT, 'manifest.json')].filter((p) => fs.existsSync(p));
  return files.concat(manifests);
}

/** 从 constants.js 里抠出 DEFAULT_SETTINGS 的键（保持源码顺序） */
function settingsKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  const start = src.indexOf('const DEFAULT_SETTINGS');
  const body = src.slice(src.indexOf('{', start) + 1, src.indexOf('\n  };', start));
  const keys = [];
  const re = /^\s{4}([A-Za-z_$][\w$]*)\s*:/gm;
  let m;
  while ((m = re.exec(body))) keys.push(m[1]);
  return keys;
}

/** 相对路径 + 行号，方便直接跳过去看 */
function loc(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** 设置页 HTML 与它的脚本，只读一次 —— hasUiHook 两个来源都要查 */
const UI_HTML = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
const UI_JS = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');

/**
 * 这个键在设置页里有没有"用户能操作它"的痕迹？
 *
 * 三类真实形态（漏掉任何一类都会把活设置报成死的 —— 写这个脚本时依次漏了后两类）：
 *   1. 表单控件：      data-key="scanImg" / data-out="retries"
 *   2. 按 id 挂的富控件：id="blockedHosts"（textarea）/ id="customRules"（动态列表根节点）
 *   3. 分段按钮组：    id="segTheme" + <button data-v="light">；
 *                      键名既不在 data-* 也不在 id 上，唯一线索是
 *                      options.js 里的 `persist({ theme: b.dataset.v })`
 */
function hasUiHook(key) {
  if (new RegExp('data-(key|out|list)\\s*=\\s*["\'][^"\']*\\b' + key + '\\b').test(UI_HTML)) return true;
  if (new RegExp('id\\s*=\\s*["\']' + key + '["\']').test(UI_HTML)) return true;
  if (new RegExp('persist\\(\\s*\\{\\s*' + key + '\\s*:').test(UI_JS)) return true;
  return false;
}

function scanFor(key, files) {
  const def = [];      // 定义点
  const use = [];      // 读取点
  const ui = [];       // 设置页里用户能操作它的地方
  const write = [];    // 写入点

  for (const f of files) {
    const rel = loc(f);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const re = new RegExp('\\b' + key + '\\b');
      if (!re.test(line)) continue;
      const at = rel + ':' + (i + 1);

      if (hasUiHook(key)) ui.push(at);
      // 定义（constants.js 的 DEFAULT_SETTINGS）
      if (rel === 'shared/constants.js') { def.push(at); continue; }
      // 写入（options 保存、导入）
      if (/persist\(|updateSettings|SET_SETTINGS|IMPORT/.test(line)) { write.push(at); continue; }
      use.push(at);
    }
  }
  return { def, use, ui, write };
}

/* ------------------------------------------------------------------ */

const keys = settingsKeys();
const files = collectSources();

console.log('ImageHunter — 设置项巡检');
console.log('源码文件 ' + files.length + ' 个（不含 tests/ 与 dist/）');
console.log('设置项   ' + keys.length + ' 条\n');

const suspects = [];

for (const key of keys) {
  const r = scanFor(key, files);
  // 只把「没有 UI 开关」的挑出来 —— 有 UI 的一定是活的，
  // 没 UI 的也不一定是死的（导入 JSON 可能写到它），所以要人看
  const flag = r.ui.length ? '  ' : ' ?';
  if (!r.ui.length) suspects.push(key);

  console.log(flag + ' ' + key.padEnd(20)
    + ' 读取 ' + String(r.use.length).padStart(2)
    + ' · UI ' + r.ui.length
    + ' · 写入 ' + r.write.length);

  if (process.env.IH_AUDIT_VERBOSE) {
    for (const [label, arr] of [['  定义', r.def], ['  读取', r.use], ['  UI  ', r.ui], ['  写入', r.write]]) {
      for (const at of arr) console.log(label + ' ' + at);
    }
  }
}

console.log('\n设置页里没有开关的（需要人工回源判断，不是"死设置"名单）：');
for (const k of suspects) console.log('  · ' + k);

console.log('\n判据提醒：');
console.log('  1. 「没有 UI 开关」≠「改不了」——导入 JSON 的白名单 = DEFAULT_SETTINGS');
console.log('     （shared/utils.js 的 mergeImportedSettings）');
console.log('  2. 「脚本没搜到读取点」≠「没有读取点」——反向判断（!== false）、');
console.log('     属性链（settings.x）、整个 settings 被传下去的场合都会漏');
console.log('  3. 所以上面每个候选都要打开文件看原代码再下结论');
console.log('     加 IH_AUDIT_VERBOSE=1 可以打印每条的全部命中位置');
