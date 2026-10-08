#!/usr/bin/env node
/* ImageHunter — 测试总入口
 * 用法： node tests/run-all.js
 * 需要 Node 18+；DOM 相关测试依赖 jsdom。
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIR = __dirname;
const NODE = process.execPath;

// jsdom 可能装在受管的 node workspace 里，补进 NODE_PATH 让 require 能找到
const CANDIDATE_MODULES = [
  'C:/Users/qwert/.workbuddy-ai/binaries/node/workspace/node_modules',
  path.resolve(DIR, '../node_modules')
].filter((p) => {
  try { return fs.existsSync(path.join(p, 'jsdom')); } catch (e) { return false; }
});

const env = Object.assign({}, process.env, {
  NODE_PATH: [process.env.NODE_PATH].concat(CANDIDATE_MODULES).filter(Boolean).join(path.delimiter)
});

const SUITES = [
  ['共享层单元测试（srcset / 文件名 / 还原规则）', 'test-shared.js'],
  ['存储并发写测试（读-改-写竞态 / 不丢数据）', 'test-store-concurrency.js'],
  ['嗅探引擎 DOM 测试（jsdom）', 'test-scanner.js'],
  ['悬停下载端到端测试（jsdom）', 'test-hover.js'],
  ['站点排除列表测试（jsdom）', 'test-blocked.js'],
  ['灯箱「在图库中打开」测试（jsdom）', 'test-lightbox-gallery.js'],
  ['灯箱最小尺寸过滤测试（jsdom）', 'test-lightbox-filter.js'],
  ['下载语义测试（真实结果 / 体积 / 跳过 / 失败）', 'test-download.js'],
  ['扫描结果缓存测试（键 / 绕开 / 失效 / 跨 SW）', 'test-scan-cache.js'],
  ['扫描超时判据测试（没扫成 ≠ 没有图片）', 'test-scan-timeout.js'],
  ['批量序号测试（跨批次不累加）', 'test-batch-index.js'],
  ['右键菜单幂等性测试（SW 竞态）', 'test-menus.js'],
  ['打包脚本测试（清单完整性 / zip 合法性 / 可复现）', 'test-package.js'],
  ['诊断包测试（白名单 / 脱敏 / 自查不变量）', 'test-diagnostics.js'],
  ['交付完整性校验（manifest / 资源 / 图标）', 'validate.js']
];

/* 清单漏一项**不会报错**，它只是「不被跑」—— 而「没跑」和「跑过且通过」
   在汇总里长得一模一样。浏览器那边早就改成自动发现了（run-all-browser.js），
   这边留着清单是为了让套件有中文名；那就补一道守卫：目录里有 test-*.js
   却没出现在清单里，直接算失败。 */
const unlisted = fs.readdirSync(DIR)
  .filter((f) => /^test-.*\.js$/.test(f))
  .filter((f) => !SUITES.some(([, file]) => file === f))
  .sort();

/* 每个套件跑到底都必须打印这一行。它是「跑完了」的唯一凭据。
 *
 * 为什么不能只看退出码：Node 在「事件循环空了但还有 await 挂着」时会
 * **静默以退出码 0 结束**。曾经 test-batch-index.js 就是这样 —— 它发了一条
 * 后台不认识的消息，Promise 永远不 settle，事件循环里又没有 timer，
 * 于是进程干净退出、退出码 0、runner 报绿，而 8 条断言只跑了 7 条。
 * 一个会漏报的测试套件，比没有测试更危险。
 */
const COMPLETION = /通过 \d+ 项，失败 \d+ 项/;
const SUITE_TIMEOUT_MS = 180000;

// 子进程输出走**临时文件**而不是管道。
// 在受管沙箱里 spawnSync 带 encoding（即管道捕获）会直接 EBUSY ——
// 只有继承句柄可用。落到文件既能拿到输出，又不受这个限制。
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-run-all-'));

let failed = 0;
const results = [];

if (unlisted.length) {
  console.log('✗ 这些套件文件在目录里，却没有登记进 SUITES（等于从来没被跑过）：');
  unlisted.forEach((f) => console.log('    ' + f));
  failed += unlisted.length;
  results.push({ name: '套件清单完整性', ok: false, reason: unlisted.join(' / ') });
}

for (const [name, file] of SUITES) {
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
console.log('\n' + (failed ? failed + ' 个测试套件失败' : '全部测试套件通过'));

try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (e) {}

process.exit(failed ? 1 : 0);
