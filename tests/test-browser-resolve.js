/* ImageHunter — 浏览器挑选逻辑测试（纯函数，不开浏览器）
 *
 * 这个套件守的是一条**本地永远看不见**的失败：
 *
 * 浏览器解析的旧顺序是「IH_BROWSER → 各平台常见路径 → Playwright 缓存」。
 * 在开发机上这个顺序完全正确 —— 本地装着 Edge，第一轮就命中，从没出过问题。
 * 但 GitHub 的 ubuntu runner **自带 /usr/bin/google-chrome**，于是 CI 里也
 * 命中了系统路径，而**品牌版 Chrome 137 起移除了 `--load-extension`**。
 * 结果：扩展加载不上，28 个浏览器套件全部卡在「等 service worker」上超时，
 * 报出来的错看起来像「扩展坏了」，根因却是「浏览器选错了」。
 *
 * 这条路径本地复现不了（本地没装 /usr/bin/google-chrome，CI 分支也不会走），
 * 所以只能把挑选逻辑拆成纯函数，在普通 Node 套件里把它钉死。
 *
 * 钉的是三件事：
 *   1. CI 里必须选 Playwright 装的那个（哪怕系统路径存在）；
 *   2. CI 里如果 Playwright 那个没装成，要**立刻报错并说清怎么装**，
 *      而不是静默退回系统 chrome —— 静默退回的代价是 28 个套件一起超时；
 *   3. 本地（非 CI）行为**不许变**：系统浏览器仍然优先。
 *      这条是防「修 CI 顺手把本地开发体验改坏」。
 */
'use strict';

const path = require('path');

let BP = null;
let loadErr = null;
try {
  BP = require('./lib/browser-pick.js');
} catch (e) {
  loadErr = e;
}

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label);
  else bad(label, 'got ' + a + ' / want ' + b);
}

console.log('=== 0. 模块可加载 ===');
if (!BP || typeof BP.pickBrowser !== 'function') {
  bad('tests/lib/browser-pick.js 导出 pickBrowser', loadErr ? String(loadErr.message) : '没有这个函数');
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(1);
}
ok('tests/lib/browser-pick.js 导出 pickBrowser');
eq(typeof BP.findPlaywrightChromium, 'function', '导出 findPlaywrightChromium');
eq(typeof BP.platformCandidates, 'function', '导出 platformCandidates');
eq(typeof BP.isHeadlessShell, 'function', '导出 isHeadlessShell');

/* 伪造一个「只认识这几个路径」的文件系统。
 * 真实探测会让断言依赖这台机器上装了什么 —— 那正是这个套件要避免的事。 */
const fakeFs = (present) => (p) => present.indexOf(p) >= 0;

const SYS_CHROME = '/usr/bin/google-chrome';
const PW_CHROME = '/home/runner/.cache/ms-playwright/chromium-1243/chrome-linux/chrome';

/* 问题存在的前提：Linux 候选清单里确实排着 /usr/bin/google-chrome。
 * 这条如果变红，说明候选清单被改过 —— 那么「CI 会选错」的推理链要重新走一遍。 */
console.log('\n=== 1. 前提：候选清单里确实有系统 chrome ===');
check(BP.LINUX_CANDIDATES.indexOf(SYS_CHROME) >= 0,
  'LINUX_CANDIDATES 含 /usr/bin/google-chrome（GitHub ubuntu runner 自带的那个）');
eq(BP.LINUX_CANDIDATES[0], SYS_CHROME,
  '它排在 Linux 候选的第一位 —— 旧顺序下必然被优先命中');

/* ================================================================== *
 * 2. CI：必须选 Playwright 的 Chromium
 * ================================================================== */
console.log('\n=== 2. CI 环境：Playwright 的 Chromium 优先 ===');
const ciEnv = { CI: 'true', GITHUB_ACTIONS: 'true' };

{
  // 最关键的场景：系统 chrome **存在**，Playwright 那个也存在
  const r = BP.pickBrowser({
    env: ciEnv,
    exists: fakeFs([SYS_CHROME, PW_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  eq(r.path, PW_CHROME, 'CI：系统 chrome 存在，仍然选 Playwright 的 Chromium');
  eq(r.error, undefined, 'CI：不报错');
  check(/CI/.test(r.from || ''), 'CI：来源说明里点明这是 CI 策略', r.from);
}

{
  // Playwright 没装成 —— 必须硬失败，不许静默退回系统 chrome
  const r = BP.pickBrowser({
    env: ciEnv,
    exists: fakeFs([SYS_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: null
  });
  eq(r.path, undefined, 'CI 且没装 Playwright Chromium：不返回任何路径（不静默退回系统 chrome）');
  check(!!r.error, 'CI 且没装 Playwright Chromium：返回错误');
  check(/--no-shell/.test(r.error || ''), '错误信息里给出正确的安装命令（--no-shell 不能漏）', r.error);
}

{
  // 只有 GITHUB_ACTIONS、没有 CI（某些 runner / 自建 CI 会这样）
  const r = BP.pickBrowser({
    env: { GITHUB_ACTIONS: 'true' },
    exists: fakeFs([SYS_CHROME, PW_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  eq(r.path, PW_CHROME, '只有 GITHUB_ACTIONS=true 也算 CI');
}

{
  const r = BP.pickBrowser({
    env: { CONTINUOUS_INTEGRATION: 'true' },
    exists: fakeFs([SYS_CHROME, PW_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  eq(r.path, PW_CHROME, '只有 CONTINUOUS_INTEGRATION=true 也算 CI');
}

/* ================================================================== *
 * 3. 非 CI：本地行为不许变
 * ================================================================== */
console.log('\n=== 3. 本地（非 CI）：系统浏览器仍然优先 ===');
{
  const r = BP.pickBrowser({
    env: {},
    exists: fakeFs([SYS_CHROME, PW_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  eq(r.path, SYS_CHROME, '非 CI：系统浏览器优先（本地开发体验不变）');
  eq(r.from, '系统已安装', '非 CI：来源标注为「系统已安装」');
}
{
  const r = BP.pickBrowser({
    env: {},
    exists: fakeFs([PW_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  eq(r.path, PW_CHROME, '非 CI 且系统里没有浏览器：退回 Playwright 的 Chromium');
}
{
  const r = BP.pickBrowser({
    env: {},
    exists: fakeFs([]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: null
  });
  check(!!r.error, '非 CI 且一个都没有：报错');
  check(/--no-shell/.test(r.error || ''), '报错里给出安装命令', r.error);
}

/* ================================================================== *
 * 4. IH_BROWSER：显式指定最高优先级
 * ================================================================== */
console.log('\n=== 4. IH_BROWSER 环境变量 ===');
{
  const r = BP.pickBrowser({
    env: { IH_BROWSER: '/opt/my/chrome', CI: 'true' },
    exists: fakeFs(['/opt/my/chrome', SYS_CHROME, PW_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  eq(r.path, '/opt/my/chrome', 'IH_BROWSER 在 CI 里也优先于 Playwright 的 Chromium');
}
{
  const r = BP.pickBrowser({
    env: { IH_BROWSER: '/nope/chrome' },
    exists: fakeFs([SYS_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: PW_CHROME
  });
  check(!!r.error, 'IH_BROWSER 指向不存在的文件：报错（不静默忽略、也不偷偷换一个）');
  check(/IH_BROWSER/.test(r.error || ''), '报错里点名是 IH_BROWSER 的问题', r.error);
}

/* ================================================================== *
 * 5. headless shell 必须被拒
 * ================================================================== */
console.log('\n=== 5. headless shell 不能用于加载扩展 ===');
check(BP.isHeadlessShell('/x/chromium_headless_shell-1243/chrome-linux/headless_shell') === true,
  'isHeadlessShell 认得出 chromium_headless_shell');
check(BP.isHeadlessShell('/x/chromium-1243/chrome-linux/chrome') === false,
  'isHeadlessShell 不会把完整 Chromium 误判成 headless shell');
{
  // executablePath() 在个别 Playwright 版本上会指向 headless shell —— 必须被拒
  const r = BP.pickBrowser({
    env: {},
    exists: fakeFs([SYS_CHROME]),
    candidates: BP.LINUX_CANDIDATES,
    pwPath: '/x/chromium_headless_shell-1243/chrome-linux/headless_shell'
  });
  eq(r.path, SYS_CHROME, 'pwPath 是 headless shell 时当作「没有 Playwright Chromium」');
}

/* ================================================================== *
 * 6. 平台候选表
 * ================================================================== */
console.log('\n=== 6. 平台候选表 ===');
check(BP.platformCandidates('win32').length > 0
  && BP.platformCandidates('win32').every((p) => /\\/.test(p)),
  'win32 候选是 Windows 路径');
check(BP.platformCandidates('darwin').length > 0
  && BP.platformCandidates('darwin').every((p) => /^\/Applications\//.test(p)),
  'darwin 候选在 /Applications 下');
check(BP.platformCandidates('linux').length > 0,
  'linux 候选非空');
check(BP.platformCandidates('freebsd').indexOf(SYS_CHROME) >= 0,
  '未知平台退回 Linux 候选（FreeBSD 之类也是 /usr/bin 布局）');

/* ================================================================== *
 * 7. 缓存目录兜底扫描
 *
 * 这一段是补上去的：写这个模块时实测发现，`executablePath()` 按
 * package.json 钉的 playwright-core 版本算路径（1.63 → chromium-1243），
 * 而 `npx playwright-core install` 装的是另一个版本（1.64 → chromium-1248），
 * 于是 exists 为 false —— 兜底扫描就成了**唯一**能找到浏览器的路。
 * 而那条兜底当时只写了 `chrome-win/`，新版布局是 `chrome-win64/`，
 * 也就是说它**一直在静默失效**。这种「兜底本身坏了」的代码只能靠注入式断言守。
 * ================================================================== */
console.log('\n=== 7. 缓存目录兜底扫描 ===');
{
  const ROOT = '/cache/ms-playwright';
  /* 期望值必须用 path.join 拼 —— 被测代码里就是 path.join，
     在 Windows 上会得到反斜杠。手写正斜杠字符串会「本地红、CI 绿」，
     这类「断言自己写错了」的失败最浪费时间。 */
  const at = (...segs) => path.join(ROOT, ...segs);
  const dirs = {
    [ROOT]: ['chromium-1243', 'chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013', 'winldd-1007']
  };
  const fakeReaddir = (d) => {
    if (dirs[d]) return dirs[d].slice();
    throw new Error('ENOENT ' + d);
  };

  // 新版 Windows 布局 chrome-win64/
  const win64 = BP.scanBrowserCache([ROOT],
    fakeFs([at('chromium-1248', 'chrome-win64/chrome.exe')]), fakeReaddir);
  eq(win64, at('chromium-1248', 'chrome-win64/chrome.exe'),
    '认得出新版 Windows 布局 chrome-win64/chrome.exe（旧代码只认 chrome-win/，一直没命中）');

  // 旧版 Windows 布局 chrome-win/
  const win32 = BP.scanBrowserCache([ROOT],
    fakeFs([at('chromium-1243', 'chrome-win/chrome.exe')]), fakeReaddir);
  eq(win32, at('chromium-1243', 'chrome-win/chrome.exe'), '也认旧版布局 chrome-win/chrome.exe');

  // Linux
  const lin = BP.scanBrowserCache([ROOT],
    fakeFs([at('chromium-1248', 'chrome-linux/chrome')]), fakeReaddir);
  eq(lin, at('chromium-1248', 'chrome-linux/chrome'), '认 Linux 布局 chrome-linux/chrome');

  // Mac arm64
  const MAC_REL = 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium';
  const macArm = BP.scanBrowserCache([ROOT],
    fakeFs([at('chromium-1248', MAC_REL)]), fakeReaddir);
  eq(macArm, at('chromium-1248', MAC_REL), '认 Mac arm64 布局 chrome-mac-arm64/');

  // 两个版本都在：取版本号大的
  const both = BP.scanBrowserCache([ROOT], fakeFs([
    at('chromium-1243', 'chrome-linux/chrome'),
    at('chromium-1248', 'chrome-linux/chrome')
  ]), fakeReaddir);
  eq(both, at('chromium-1248', 'chrome-linux/chrome'), '同时存在 1243 / 1248 时取新版本');

  // headless shell 目录必须被跳过
  const onlyShell = BP.scanBrowserCache([ROOT], fakeFs([
    at('chromium_headless_shell-1248', 'chrome-linux/chrome')
  ]), fakeReaddir);
  eq(onlyShell, null, 'chromium_headless_shell-* 目录被跳过（它加载不了扩展）');

  // 目录读不了不该炸
  let threw = false;
  let got = 'x';
  try { got = BP.scanBrowserCache(['/nope'], fakeFs([]), fakeReaddir); } catch (e) { threw = true; }
  eq(threw, false, '目录不存在时不抛异常（readdir 失败就地跳过）');
  eq(got, null, '目录不存在时返回 null');

  // CHROME_RELS 里必须同时有新旧两种 Windows 布局
  check(BP.CHROME_RELS.indexOf('chrome-win64/chrome.exe') >= 0
    && BP.CHROME_RELS.indexOf('chrome-win/chrome.exe') >= 0,
    'CHROME_RELS 同时含 chrome-win64/ 与 chrome-win/');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
