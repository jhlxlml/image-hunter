#!/usr/bin/env node
/* ImageHunter — 真浏览器测试总入口
 * 用法： node tests/run-all-browser.js
 *
 * 为什么需要它（而不是拿 shell 的 for 循环凑合）：
 *
 * 1. **完成标记**。`run-all.js` 早就强制「每个 Node 套件必须打印
 *    『通过 N 项，失败 M 项』，否则判中途退出」—— 因为 Node 在
 *    「事件循环空了但还有 await 挂着」时会**静默以退出码 0 结束**。
 *    真浏览器套件有完全一样的风险：一个 await 卡住、进程干净退出、
 *    shell 循环看到退出码 0 就报绿，而断言一条都没跑。
 *    这里把同一道防线补上。
 *
 * 2. **浏览器解析只做一次**。22 个套件各自写着 `IH_BROWSER || <Windows Edge 路径>`
 *    的默认值 —— 在 Linux / macOS 上直接跑会 22 次 ENOENT。
 *    这里统一解析（环境变量 → 各平台常见路径 → Playwright 缓存），
 *    解析结果注入每个子进程，套件自己不用改。
 *
 * 3. **汇总**。跑完给出「哪些套件红了」，而不是让人从几千行输出里找。
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIR = __dirname;
const NODE = process.execPath;

/* jsdom 可能装在受管的 node workspace 里，补进 NODE_PATH 让 require 能找到 */
const CANDIDATE_MODULES = [
  'C:/Users/qwert/.workbuddy-ai/binaries/node/workspace/node_modules',
  path.resolve(DIR, '../node_modules')
].filter((p) => {
  try { return fs.existsSync(path.join(p, 'playwright-core')); } catch (e) { return false; }
});

/* ------------------------------------------------------------------ *
 * 浏览器解析
 *
 * 顺序：显式 IH_BROWSER → 各平台常见安装路径 → Playwright 自己下载的 Chromium。
 * 全部找不到时**立刻失败并说清怎么装**，而不是让 22 个套件各自报一遍 ENOENT
 * ——那种输出会把人淹掉，真正的原因（「这台机器上没有浏览器」）反而看不见。
 * ------------------------------------------------------------------ */
const WIN_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];
const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];

/** Playwright 下载的 Chromium（`npx playwright-core install --no-shell chromium` 装的） */
function playwrightChromium() {
  try {
    const pw = require('playwright-core');
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 没装 playwright-core 就算了 */ }
  // 兜底：直接翻缓存目录（executablePath 在个别版本上会指向 headless shell）
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  ].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (e) { continue; }
    for (const d of dirs.sort().reverse()) {
      if (!/^chromium-\d/.test(d)) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-win/chrome.exe']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function resolveBrowser() {
  const fromEnv = process.env.IH_BROWSER;
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return { path: fromEnv, from: 'IH_BROWSER 环境变量' };
    return { error: 'IH_BROWSER 指向的文件不存在：' + fromEnv };
  }
  const cands = process.platform === 'win32' ? WIN_CANDIDATES
    : process.platform === 'darwin' ? MAC_CANDIDATES
      : LINUX_CANDIDATES;
  for (const p of cands) {
    if (fs.existsSync(p)) return { path: p, from: '系统已安装' };
  }
  const pw = playwrightChromium();
  if (pw) return { path: pw, from: 'Playwright 下载的 Chromium' };
  return {
    error: '这台机器上找不到可用的 Chrome / Edge / Chromium。\n'
      + '  装一个即可（任选其一）：\n'
      + '    npx playwright-core install --with-deps --no-shell chromium\n'
      + '  或者显式指定：IH_BROWSER=/path/to/chrome node tests/run-all-browser.js'
  };
}

const resolved = resolveBrowser();
if (resolved.error) {
  console.error('✗ ' + resolved.error);
  process.exit(2);
}

const env = Object.assign({}, process.env, {
  IH_BROWSER: resolved.path,
  NODE_PATH: [process.env.NODE_PATH].concat(CANDIDATE_MODULES).filter(Boolean).join(path.delimiter)
});

/* ------------------------------------------------------------------ *
 * 套件清单：自动发现，不写死列表
 *
 * Node 套件那边是手写清单（13 个，稳定）。浏览器套件已经有 22 个且还在长，
 * 手写清单迟早会漏 —— 漏掉的套件不会报错，它只是**不被跑**，
 * 而「没跑」和「跑过且通过」在汇总里长得一模一样。这正是本项目最忌讳的那类失败。
 * ------------------------------------------------------------------ */
const SUITES = fs.readdirSync(DIR)
  .filter((f) => /^browser-.*\.js$/.test(f))
  .sort();

const COMPLETION = /通过 \d+ 项，失败 \d+ 项/;
const SUITE_TIMEOUT_MS = 300000;

// 子进程输出走**临时文件**而不是管道（受管沙箱里管道捕获会 EBUSY，见 run-all.js）
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-run-browser-'));

console.log('浏览器      = ' + resolved.path);
console.log('来源        = ' + resolved.from);
console.log('套件        = ' + SUITES.length + ' 个');

let failed = 0;
let totalPass = 0;
const results = [];

for (const file of SUITES) {
  const name = file.replace(/\.js$/, '');
  console.log('\n' + '='.repeat(64));
  console.log('▶ ' + name);
  console.log('='.repeat(64));

  const logPath = path.join(LOG_DIR, file + '.log');
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(NODE, [path.join(DIR, file)], {
      stdio: ['ignore', fd, fd],
      env,
      timeout: SUITE_TIMEOUT_MS
    });
  } finally {
    fs.closeSync(fd);
  }
  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch (e) { out = ''; }
  if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');

  const m = out.match(/通过 (\d+) 项，失败 (\d+) 项/g);
  if (m) {
    const last = m[m.length - 1].match(/通过 (\d+) 项，失败 (\d+) 项/);
    totalPass += Number(last[1]);
  }

  let reason = '';
  if (r.error && r.error.code === 'ETIMEDOUT') {
    reason = '套件超时（超过 ' + (SUITE_TIMEOUT_MS / 1000) + ' 秒），已强制终止';
  } else if (r.error) {
    reason = '无法启动套件：' + r.error.message;
  } else if (r.signal) {
    reason = '套件被信号 ' + r.signal + ' 终止';
  } else if (!COMPLETION.test(out)) {
    reason = '套件中途退出，未跑完（没有打印完成标记「通过 N 项，失败 M 项」）';
  } else if (r.status !== 0) {
    reason = '套件报告失败（退出码 ' + r.status + '）';
  }

  const ok = !reason;
  if (!ok) failed++;
  results.push({ name, ok, reason });
  if (!ok) console.log('\n  ⚠ ' + reason);
}

console.log('\n' + '='.repeat(64));
console.log('汇总');
console.log('='.repeat(64));
results.forEach((r) => {
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '  → ' + r.reason));
});
console.log('\n' + SUITES.length + ' 个套件，通过 ' + totalPass + ' 项');
console.log(failed ? failed + ' 个测试套件失败' : '全部测试套件通过');

try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (e) {}

process.exit(failed ? 1 : 0);
