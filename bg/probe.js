/* ==========================================================================
 * ImageHunter — bg/probe.js
 * 图片体积探测（HEAD / Range 0-0 + 响应体立刻取消）
 * 由 background.js 通过 importScripts 加载，共享同一个 SW 全局作用域。
 * ========================================================================== */

/** 体积探测的累计成败（用户点「探测体积」时累加，用于区分「站点不支持 HEAD」和「扩展坏了」） */
const probeStats = { ok: 0, failed: 0, lastAt: null };

/**
 * 丢掉一个响应体。**只读响应头、不要内容的请求必须调它。**
 *
 * 不调会怎样：浏览器会继续把整个响应体收完（白白占带宽、占内存），
 * 连接也不释放。Range 探测尤其危险 —— 我们只想要 `Content-Range` 里的
 * 总长度，而**服务器完全可能忽略 Range 直接回 200 + 整个文件**，
 * 于是一次「探测体积」就把整张原图下载了一遍。
 */
async function discardBody(res) {
  if (!res || !res.body) return;
  try {
    if (typeof res.body.cancel === 'function') { await res.body.cancel(); return; }
    /* 兜底：个别实现（老版本 / 测试桩）的 ReadableStream 上没有 cancel。
       锁一个 reader 再取消，效果一样 —— 关键是让浏览器停止继续收这个响应体。 */
    if (typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      await reader.cancel();
    }
  } catch (e) { /* 已经读完 / 已关闭，忽略 */ }
}

async function probeRemoteSize(url) {
  if (!U.isHttpUrl(url)) return null;

  try {
    const res = await U.fetchWithTimeout(url, { method: 'HEAD', credentials: 'include', cache: 'no-store' }, 7000);
    if (res.ok) {
      const len = res.headers.get('content-length');
      const type = res.headers.get('content-type') || '';
      if (len) { await discardBody(res); return { bytes: parseInt(len, 10) || 0, type }; }
    }
    await discardBody(res);
  } catch (e) { /* HEAD 不被支持时继续 */ }

  try {
    const res = await U.fetchWithTimeout(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'include',
      cache: 'no-store'
    }, 7000);
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) { await discardBody(res); return { bytes: parseInt(m[1], 10) || 0, type: res.headers.get('content-type') || '' }; }
    }
    const len = res.headers.get('content-length');
    if (len && res.status !== 206) {
      // 服务器忽略了 Range，回的是 200 + 整个文件：长度就是它，但**必须立刻掐掉**
      await discardBody(res);
      return { bytes: parseInt(len, 10) || 0, type: res.headers.get('content-type') || '' };
    }
    await discardBody(res);
  } catch (e) { /* ignore */ }

  return null;
}

async function probeMany(urls) {
  const limiter = U.createLimiter(4);
  const out = {};
  // 上限与弹窗的分批大小共用同一个常量：调用方按 C.PROBE_LIMIT 分批，
  // 这里再截一次只是防御，正常不会真的截掉东西（AUDIT P1-5）
  await Promise.all((urls || []).slice(0, C.PROBE_LIMIT).map((u) => limiter(async () => {
    const r = await probeRemoteSize(u);
    out[u] = r;
    /* 累计成败。这个计数是给诊断包用的：用户说「体积探测不出来」时，
       ok=0 / failed=12 是「这些站点都不给 HEAD，正常」，
       ok=0 / failed=0 才是「扩展根本没跑到这里」—— 两者界面表现一样。 */
    if (r) probeStats.ok++; else probeStats.failed++;
    probeStats.lastAt = Date.now();
  })));
  return out;
}
