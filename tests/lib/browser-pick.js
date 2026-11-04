/* ImageHunter — 浏览器挑选（纯逻辑 + 一次文件系统探测）
 *
 * 为什么单独拆一个文件：
 * 「CI 上该用哪个浏览器」这件事，在开发机上**永远看不出来** ——
 * 本地装着 Edge，系统路径第一轮就命中，CI 分支根本不会被执行到。
 * 把它拆成不依赖真实文件系统的纯函数（`exists` 由调用方注入），
 * 就能在普通 Node 套件里把「CI 里必须选 Playwright 那个」钉死，
 * 而不用真的开一个浏览器。
 *
 * 为什么要区分 CI：
 * 品牌版 Google Chrome 137 起移除了 `--load-extension`，而 GitHub 的
 * ubuntu runner **自带 /usr/bin/google-chrome**。解析顺序是「系统路径优先」，
 * 于是 CI 上必然挑中它 —— 扩展加载不上，28 个浏览器套件全部卡在
 * 「等 service worker」上超时，报出来的错看着像扩展坏了。
 * 本地从没复现，是因为本地用的是 Edge（还没移除这个开关）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

const INSTALL_HINT = '这台机器上找不到可用的 Chrome / Edge / Chromium。\n'
  + '  装一个即可（任选其一）：\n'
  + '    npx playwright-core install --with-deps --no-shell chromium\n'
  + '  或者显式指定：IH_BROWSER=/path/to/chrome node tests/run-all-browser.js';

/** 各平台的常见安装路径。未知平台按 Linux 布局试（FreeBSD 之类也是 /usr/bin）。 */
function platformCandidates(platform) {
  if (platform === 'win32') return WIN_CANDIDATES.slice();
  if (platform === 'darwin') return MAC_CANDIDATES.slice();
  return LINUX_CANDIDATES.slice();
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

/** 环境变量里有没有「我在 CI 里」的信号。三种都认，因为不同 runner 写法不同。 */
function isCI(env) {
  env = env || {};
  return truthy(env.CI) || truthy(env.GITHUB_ACTIONS) || truthy(env.CONTINUOUS_INTEGRATION);
}

/**
 * 这个路径是不是 chromium-headless-shell。
 * headless shell **不支持 `--load-extension`**（会被静默忽略），
 * 拿它跑浏览器套件会全部卡在「等 service worker」上超时。
 * `playwright.chromium.executablePath()` 在个别版本上会指向它，所以必须挡一道。
 */
function isHeadlessShell(p) {
  return /headless[_-]?shell/i.test(String(p || ''));
}

/** Playwright 缓存里完整 Chromium 的相对路径。
 *
 * 为什么要列这么多种：这个目录名 Playwright 改过好几次 ——
 * 新版 Windows 是 `chrome-win64/`（旧版 `chrome-win/`），
 * Mac arm64 是 `chrome-mac-arm64/`。漏一个就等于那段兜底不存在。
 * 2026-10-10 实测踩过：只写了 `chrome-win/`，于是「明明装了却找不到」。 */
const CHROME_RELS = [
  'chrome-linux/chrome',
  'chrome-linux64/chrome',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win/chrome.exe',
  'chrome-win64/chrome.exe'
];

/**
 * 在 ms-playwright 缓存目录里翻完整 Chromium。**纯函数**（fs 由调用方注入）。
 *
 * 为什么要这条兜底：`executablePath()` 是按 **package.json 里钉的
 * playwright-core 版本**算出来的（1.63 → chromium-1243），
 * 而 `npx playwright-core install` 可能装的是另一个版本的浏览器
 * （2026-10-10 实测：npx 拉到 1.64，装进 chromium-1248，
 *  本地 playwright-core 1.63 仍指向 1243 → exists 为 false）。
 *
 * `chromium_headless_shell-*` 不会被 `/^chromium-\d/` 命中 —— 那是故意的：
 * headless shell 不支持 `--load-extension`，拿来跑扩展套件会全部超时。
 */
function scanBrowserCache(roots, exists, readdir) {
  exists = exists || (() => false);
  readdir = readdir || (() => []);
  for (const root of roots || []) {
    if (!root) continue;
    let dirs = [];
    try { dirs = readdir(root) || []; } catch (e) { continue; }
    // 版本号倒序：同时存在 1243 / 1248 时优先用新的那个
    for (const d of dirs.slice().sort().reverse()) {
      if (!/^chromium-\d/.test(d)) continue;
      for (const rel of CHROME_RELS) {
        const p = path.join(root, d, rel);
        if (exists(p) && !isHeadlessShell(p)) return p;
      }
    }
  }
  return null;
}

/** Playwright 缓存目录的候选位置（按优先级） */
function cacheRoots() {
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  ].filter(Boolean);
}

/** Playwright 下载的 Chromium（`npx playwright-core install --no-shell chromium` 装的） */
function findPlaywrightChromium() {
  try {
    const pw = require('playwright-core');
    const p = pw.chromium.executablePath();
    if (p && fs.existsSync(p) && !isHeadlessShell(p)) return p;
  } catch (e) { /* 没装 playwright-core 就算了 */ }
  return scanBrowserCache(cacheRoots(), fs.existsSync, fs.readdirSync);
}

/**
 * 挑选浏览器。**纯函数**：文件系统由 `exists()` 注入，所以可以脱机断言。
 *
 * 顺序（CI 与非 CI 不同，这是本文件存在的全部理由）：
 *
 *   IH_BROWSER（显式指定，永远最高）
 *     → 若在 CI：Playwright 的 Chromium；**没有就报错**，绝不退回系统浏览器
 *     → 若不在 CI：系统已安装的浏览器 → Playwright 的 Chromium
 *     → 都没有：报错并给出安装命令
 *
 * 为什么 CI 里「没有 Playwright Chromium」要报错而不是退回系统 chrome：
 * 退回去不会立刻失败，它会让 28 个套件各卡 300 秒超时，最后报出来的错是
 * 「等 service worker 超时」—— 看起来像扩展坏了。而真正的原因是
 * 「`npx playwright-core install` 那一步没成功」。一行明确的报错比 28 个超时值钱。
 *
 * @param {object}   o
 * @param {object}   o.env         环境变量（通常是 process.env）
 * @param {Function} o.exists      路径是否存在
 * @param {string[]} o.candidates  该平台的常见安装路径
 * @param {string?}  o.pwPath      Playwright 下载的 Chromium（没有就 null）
 * @returns {{path?: string, from?: string, error?: string}}
 */
function pickBrowser(o) {
  o = o || {};
  const env = o.env || {};
  const exists = o.exists || (() => false);
  const candidates = o.candidates || [];
  const pwPath = o.pwPath && !isHeadlessShell(o.pwPath) ? o.pwPath : null;

  if (env.IH_BROWSER) {
    if (exists(env.IH_BROWSER)) return { path: env.IH_BROWSER, from: 'IH_BROWSER 环境变量' };
    return { error: 'IH_BROWSER 指向的文件不存在：' + env.IH_BROWSER };
  }

  if (isCI(env)) {
    if (pwPath) return { path: pwPath, from: 'Playwright 下载的 Chromium（CI 优先）' };
    return {
      error: 'CI 环境里没有找到 Playwright 装的 Chromium。\n'
        + '  这个 job 必须先跑这一步（注意 --no-shell 不能漏）：\n'
        + '    npx playwright-core install --with-deps --no-shell chromium\n'
        + '  系统自带的 google-chrome 不能替代它：品牌版 Chrome 137 起移除了\n'
        + '  --load-extension，扩展加载不上，浏览器套件会全部卡在「等 service worker」。'
    };
  }

  for (const p of candidates) {
    if (exists(p)) return { path: p, from: '系统已安装' };
  }
  if (pwPath) return { path: pwPath, from: 'Playwright 下载的 Chromium' };
  return { error: INSTALL_HINT };
}

module.exports = {
  WIN_CANDIDATES,
  MAC_CANDIDATES,
  LINUX_CANDIDATES,
  INSTALL_HINT,
  CHROME_RELS,
  platformCandidates,
  isCI,
  isHeadlessShell,
  cacheRoots,
  scanBrowserCache,
  findPlaywrightChromium,
  pickBrowser
};
