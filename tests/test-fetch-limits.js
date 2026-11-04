/* ImageHunter — 「有上限地读响应体」测试
 *
 * 守的是三个**在本地永远看不出来**的问题（本地网快、图小、CDN 正常）：
 *
 *   1. 先吃完整个响应体、再检查大小 —— 等于「先让内存爆掉，再问它是不是太大了」。
 *      旧代码就是这么写的：`const blob = await res.blob(); if (blob.size > 16MB) ...`
 *      遇到一个 2GB 的响应，检查语句永远轮不到执行。
 *   2. 没有读取截止时间 —— `fetchWithTimeout` 的计时器在**响应头到达**时就
 *      clearTimeout 了，之后慢慢吐 body 的服务器可以无限期挂着。
 *   3. 不看 MIME —— 图床出错时常常回 200 + text/html 的错误页，
 *      存下来就是一张「打不开的 .jpg」。
 *
 * 这里用真的 `Response` / `ReadableStream` 构造慢响应和超大响应，
 * 所以测的是真实的流式读取行为，不是桩。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const base = path.resolve(__dirname, '..');

const ctx = {
  console, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout,
  Math, Date, JSON, isFinite, String, Number, Object, Array, Promise,
  Blob, Response, ReadableStream, AbortController, Uint8Array
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/constants.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(base, 'shared/utils.js'), 'utf8'), ctx);

const U = ctx.IH.U;

let pass = 0, fail = 0;
function ok(label) { pass++; console.log('  ✓ ' + label); }
function bad(label, extra) { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
function check(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label); else bad(label, 'got ' + a + ' / want ' + b);
}

/** 跑一次 readBodyLimited，把「成功值」或「错误码」统一取出来 */
async function run(res, opts) {
  try {
    return { value: await U.readBodyLimited(res, opts) };
  } catch (e) {
    return { error: e && e.code, message: String((e && e.message) || e) };
  }
}

/* 一个「永远吐不完」的响应体：每次 pull 吐一块 */
function endlessBody(chunkSize, onCancel) {
  const chunk = new Uint8Array(chunkSize);
  return new ReadableStream({
    pull(c) { c.enqueue(chunk); },
    cancel() { if (onCancel) onCancel(); }
  });
}

/* 一个「吐得很慢」的响应体：每块要等 delayMs 才出来 */
function slowBody(delayMs, count, onCancel) {
  let n = 0;
  return new ReadableStream({
    pull(c) {
      return new Promise((resolve) => {
        setTimeout(() => {
          if (n >= count) { c.close(); resolve(); return; }
          n++;
          c.enqueue(new Uint8Array(4));
          resolve();
        }, delayMs);
      });
    },
    cancel() { if (onCancel) onCancel(); }
  });
}

/** 一个「正常的小响应体」 */
function smallBody(bytes, onCancel) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
    cancel() { if (onCancel) onCancel(); }
  });
}

(async function () {
  console.log('=== 0. 助手存在 ===');
  eq(typeof U.readBodyLimited, 'function', '导出 readBodyLimited');
  eq(typeof U.isImageMime, 'function', '导出 isImageMime');

  /* ================================================================== *
   * 1. 声明的 content-length 超限：一个字节都不该读
   * ================================================================== */
  console.log('\n=== 1. content-length 超限 → 读之前就拒绝 ===');
  {
    /* 注意：不能用「流的 pull 有没有被调用」来判断我们读没读 ——
       `new Response(stream)` 在构造时就会自己开始 pull。
       真正可靠的观测量是 `res.body.locked`：只有调过 getReader() 才会变 true。 */
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); } });
    const res = new Response(body, { headers: { 'content-length': String(200 * 1024 * 1024) } });
    const r = await run(res, { maxBytes: 1024 });
    eq(r.error, 'too-big', 'content-length 超过上限 → code 是 too-big');
    eq(res.body.locked, false, '没有取 reader（一个字节都没读，不是「读完了才发现太大」）');
  }

  /* ================================================================== *
   * 2. 没有 content-length，但实际很大 → 边读边掐
   * ================================================================== */
  console.log('\n=== 2. 没有 content-length，实际超大 → 读到一半掐掉 ===');
  {
    let cancelled = false;
    const res = new Response(endlessBody(64 * 1024, () => { cancelled = true; }));
    const r = await run(res, { maxBytes: 256 * 1024 });
    eq(r.error, 'too-big', '无穷响应体 → code 是 too-big');
    eq(cancelled, true, '超限时主动 cancel 了读取（不会继续把剩下的收完）');
  }

  /* ================================================================== *
   * 3. MIME 白名单
   * ================================================================== */
  console.log('\n=== 3. MIME 白名单 ===');
  {
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4)); } });
    const res = new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const r = await run(res, { maxBytes: 1024, allowMime: U.isImageMime });
    eq(r.error, 'bad-mime', 'text/html（CDN 错误页）→ code 是 bad-mime');
    eq(res.body.locked, false, 'MIME 不对时不取 reader（连第一个字节都不读）');
  }
  {
    const res = new Response(smallBody(16), { headers: { 'content-type': 'image/png' } });
    const r = await run(res, { maxBytes: 1024, allowMime: U.isImageMime });
    check(!!r.value, 'image/png 放行', r.error);
  }
  {
    const res = new Response(smallBody(16), { headers: { 'content-type': 'application/octet-stream' } });
    const r = await run(res, { maxBytes: 1024, allowMime: U.isImageMime });
    check(!!r.value, 'application/octet-stream 放行（有些图床就这么发）', r.error);
  }

  eq(U.isImageMime('image/png'), true, 'isImageMime: image/png');
  eq(U.isImageMime('IMAGE/JPEG; charset=binary'), true, 'isImageMime: 大小写与参数都能处理');
  eq(U.isImageMime(''), true, 'isImageMime: 没给类型时放行（很多 CDN 不给）');
  eq(U.isImageMime('text/html'), false, 'isImageMime: text/html 拒绝');
  eq(U.isImageMime('video/mp4'), false, 'isImageMime: video/mp4 拒绝');
  eq(U.isImageMime('application/json'), false, 'isImageMime: application/json 拒绝');

  /* ================================================================== *
   * 4. 读取截止时间
   * ================================================================== */
  console.log('\n=== 4. 读取超时（body 慢慢吐）===');
  {
    let cancelled = false;
    const res = new Response(slowBody(300, 100, () => { cancelled = true; }));
    const t0 = Date.now();
    const r = await run(res, { maxBytes: 1024 * 1024, timeoutMs: 400 });
    const took = Date.now() - t0;
    eq(r.error, 'read-timeout', 'body 吐得比截止时间慢 → code 是 read-timeout');
    eq(cancelled, true, '超时时主动 cancel 了读取');
    check(took < 2000, '在截止时间附近就返回了（没有一直挂着）', took + 'ms');
  }

  /* ================================================================== *
   * 5. 正常路径
   * ================================================================== */
  console.log('\n=== 5. 正常小图片 ===');
  {
    const res = new Response(smallBody(1234), { headers: { 'content-type': 'image/jpeg' } });
    const r = await run(res, { maxBytes: 1024 * 1024, allowMime: U.isImageMime });
    check(!!r.value, '正常读出来了', r.error);
    eq(r.value && r.value.bytes, 1234, '字节数正确');
    eq(r.value && r.value.mime, 'image/jpeg', 'MIME 正确回传');
    eq(r.value && r.value.blob.size, 1234, 'blob 大小正确');
  }
  {
    // 边界：正好等于上限应当放行（不能把「等于」判成「超过」）
    const res = new Response(smallBody(1024), { headers: { 'content-type': 'image/png' } });
    const r = await run(res, { maxBytes: 1024 });
    check(!!r.value, '正好等于上限 → 放行', r.error);
    eq(r.value && r.value.bytes, 1024, '边界值字节数正确');
  }

  /* ================================================================== *
   * 6. 没有流式 body 可读时的兜底
   * ================================================================== */
  console.log('\n=== 6. 没有 body.getReader 时退回 blob() ===');
  {
    const fake = {
      headers: { get: (n) => (n === 'content-type' ? 'image/png' : null) },
      blob: () => Promise.resolve(new Blob([new Uint8Array(64)], { type: 'image/png' }))
    };
    const r = await run(fake, { maxBytes: 1024 });
    check(!!r.value, '兜底路径能读出来', r.error);
    eq(r.value && r.value.bytes, 64, '兜底路径字节数正确');
  }
  {
    const fake = {
      headers: { get: () => null },
      blob: () => Promise.resolve(new Blob([new Uint8Array(2048)]))
    };
    const r = await run(fake, { maxBytes: 1024 });
    eq(r.error, 'too-big', '兜底路径也检查大小（不会因为没流就跳过）');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
