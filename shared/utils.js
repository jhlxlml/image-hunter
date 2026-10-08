/* ==========================================================================
 * ImageHunter — shared/utils.js
 * 纯函数工具集：URL 处理、srcset 解析、文件名生成、格式化、并发控制
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.U) return;

  const C = IH.C;
  const IMAGE_EXT = C.IMAGE_EXT;

  /* ------------------------------------------------------------------ *
   * URL
   * ------------------------------------------------------------------ */

  /** 把相对地址补全为绝对地址；失败返回 null */
  function absUrl(raw, base) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/^['"]|['"]$/g, '');
    if (!s) return null;
    if (/^(data|blob|filesystem):/i.test(s)) return s;
    if (/^(https?|ftp):/i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    try {
      return new URL(s, base || (typeof location !== 'undefined' ? location.href : undefined)).href;
    } catch (e) {
      return null;
    }
  }

  /**
   * URL 规范化，用于去重：
   * 去掉 fragment、排序查询参数、统一协议大小写；data/blob URL 原样返回
   */
  function normalizeUrl(url) {
    if (!url) return '';
    if (/^(data|blob):/i.test(url)) return url;
    try {
      const u = new URL(url);
      u.hash = '';
      const keys = Array.from(u.searchParams.keys()).sort();
      const params = new URLSearchParams();
      for (const k of keys) {
        const vals = u.searchParams.getAll(k).slice().sort();
        for (const v of vals) params.append(k, v);
      }
      u.search = params.toString();
      let out = u.href;
      // 末尾斜杠统一
      if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
      return out;
    } catch (e) {
      return url;
    }
  }

  function isDataUrl(u) { return /^data:/i.test(u || ''); }
  function isBlobUrl(u) { return /^blob:/i.test(u || ''); }

  /** 从 URL 推断扩展名（小写，不含点）；无法推断返回 '' */
  function extFromUrl(url) {
    if (!url) return '';
    if (isDataUrl(url)) {
      const m = url.match(/^data:image\/([a-z0-9.+-]+)/i);
      if (!m) return '';
      const sub = m[1].toLowerCase();
      if (sub === 'svg+xml') return 'svg';
      if (sub === 'jpeg') return 'jpg';
      if (sub === 'x-icon' || sub === 'vnd.microsoft.icon') return 'ico';
      return sub;
    }
    try {
      const pathname = new URL(url).pathname;
      const last = pathname.split('/').filter(Boolean).pop() || '';
      const dot = last.lastIndexOf('.');
      if (dot <= 0 || dot === last.length - 1) return '';
      const ext = last.slice(dot + 1).toLowerCase();
      return IMAGE_EXT.indexOf(ext) >= 0 ? ext : '';
    } catch (e) {
      return '';
    }
  }

  /** 粗略判断一个 URL 是否指向图片（看扩展名 / data url / 已知图床关键字） */
  function isProbablyImageUrl(url) {
    if (!url) return false;
    if (isDataUrl(url)) return /^data:image\//i.test(url);
    if (isBlobUrl(url)) return true;
    if (extFromUrl(url)) return true;
    // 无扩展名的 CDN 图片：常见关键字
    return /(?:^|[/_.-])(?:image|img|photo|pic|picture|thumb|avatar|cover|banner)(?:[/_.-]|\d)/i.test(url);
  }

  /* ------------------------------------------------------------------ *
   * srcset
   * ------------------------------------------------------------------ */

  /**
   * 解析 srcset 字符串
   * @returns {Array<{url:string, w:number, x:number}>}
   */
  function parseSrcset(srcset) {
    if (!srcset || typeof srcset !== 'string') return [];
    const out = [];
    // 按逗号切分，但要避免切到 URL 里的逗号（data: URL 内）
    const parts = srcset.split(/,(?![^(]*\))/);
    for (let part of parts) {
      part = part.trim();
      if (!part) continue;
      const segs = part.split(/\s+/);
      const url = segs[0];
      if (!url) continue;
      let w = 0, x = 0;
      for (let i = 1; i < segs.length; i++) {
        const d = segs[i];
        if (/^\d+(\.\d+)?w$/i.test(d)) w = parseFloat(d);
        else if (/^\d+(\.\d+)?x$/i.test(d)) x = parseFloat(d);
      }
      out.push({ url, w, x });
    }
    return out;
  }

  /** 取 srcset 里最大的那个 URL（优先按 w，其次按 x，再退回最后一个） */
  function pickLargestFromSrcset(srcset) {
    const list = parseSrcset(srcset);
    if (!list.length) return '';
    let best = list[0];
    let bestScore = -1;
    for (const item of list) {
      const score = item.w ? item.w * 1000 : (item.x ? item.x * 100 : 0);
      if (score >= bestScore) { bestScore = score; best = item; }
    }
    return best.url || '';
  }

  /* ------------------------------------------------------------------ *
   * CSS background-image 解析
   * ------------------------------------------------------------------ */

  /** 从 computed style 的 background-image 中抽出所有 url(...) */
  function extractCssUrls(backgroundImage) {
    if (!backgroundImage || backgroundImage === 'none') return [];
    const out = [];
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let m;
    while ((m = re.exec(backgroundImage)) !== null) {
      const raw = (m[1] || m[2] || m[3] || '').trim();
      if (raw && !/^data:image\/(?:gif|png);base64,R0lGOD/i.test(raw)) out.push(raw);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 文件名
   * ------------------------------------------------------------------ */

  function sanitizeFilename(name) {
    let out = String(name || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (!out) out = 'image';
    if (out.length > 120) out = out.slice(0, 120);
    // Windows 保留名
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
    return out;
  }

  function pad(n, len) {
    let s = String(n);
    while (s.length < (len || 3)) s = '0' + s;
    return s;
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
  }

  /**
   * 清洗**单层目录名**。
   *
   * 和 sanitizeFilename 的区别：非法/空白时返回 `''`（由调用方丢弃这一层），
   * 而不是兜底成 `image` —— 否则用户写个 `..` 或纯空格会凭空多出一个 `image/` 目录。
   */
  function sanitizeSegment(s) {
    let out = String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
    if (out.length > 80) out = out.slice(0, 80);
    return out;
  }

  /**
   * 把一段「子目录模板」渲染成安全的相对目录。
   *
   * 安全边界（chrome.downloads 会拒绝越界路径，这里先拦掉，避免下载直接失败）：
   *   - 反斜杠统一成 `/`，去掉开头的 `/`（绝对路径）
   *   - 丢掉空层、`.` 与 `..`（**不允许往上跳**）
   *   - 每层单独清洗，非法字符换成 `_`，盘符里的 `:` 因此也会被换掉
   *   - 最多 3 层，避免模板写飞了在下载目录里挖出深井
   *
   * @param {string} tpl 模板，支持 {host} {date} {index}
   * @param {object} cand {url, width, height}
   * @param {number} index 批量序号
   * @returns {string} 形如 `example.com/20260929`；无有效内容时返回 ''
   */
  function buildSubfolder(tpl, cand, index) {
    const raw = String(tpl == null ? '' : tpl);
    if (!raw.trim()) return '';
    const rendered = raw
      .replace(/\{host\}/g, rawHost(cand && cand.url) || '')
      .replace(/\{date\}/g, today())
      .replace(/\{index\}/g, index ? pad(index, 3) : '');
    return rendered
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .map((s) => sanitizeSegment(s))
      .filter(Boolean)
      .slice(0, 3)
      .join('/');
  }

  /**
   * 根据 URL / 模板生成下载路径（相对下载目录，可能含子目录）
   * @param {object} cand  {url, width, height}
   * @param {object} settings
   * @param {number} index 批量序号（从 1 开始）
   */
  function buildFilename(cand, settings, index) {
    const url = cand.url || '';
    let base = '';
    let ext = extFromUrl(url);
    let host = '';

    if (isDataUrl(url)) {
      base = 'image';
      if (!ext) ext = 'png';
    } else {
      try {
        const u = new URL(url);
        host = u.hostname.replace(/^www\./, '');
        const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        const dot = last.lastIndexOf('.');
        if (dot > 0) base = last.slice(0, dot);
        else base = last || host || 'image';
      } catch (e) {
        base = 'image';
      }
    }

    base = sanitizeFilename(base);
    if (!ext) ext = 'jpg';

    let name = (settings && settings.filenameTemplate) || '{name}.{ext}';
    name = name
      .replace(/\{name\}/g, base)
      .replace(/\{ext\}/g, ext)
      .replace(/\{index\}/g, index ? pad(index, 3) : '')
      .replace(/\{host\}/g, sanitizeFilename(host || 'image'))
      .replace(/\{w\}/g, cand.width ? String(cand.width) : '')
      .replace(/\{h\}/g, cand.height ? String(cand.height) : '')
      .replace(/\{date\}/g, today());

    // 保证有扩展名
    if (name.indexOf('.') < 0) name = name + '.' + ext;
    // 模板没带 {ext} 时，若结尾扩展名不是图片扩展名，补上
    const tailExt = (name.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXT.indexOf(tailExt) < 0) name = name + '.' + ext;

    name = name.split('/').map((s) => sanitizeFilename(s)).join('/');
    const segments = name.split('/');
    segments[segments.length - 1] = sanitizeFilename(segments[segments.length - 1]);
    name = segments.join('/');

    // 批量下载时加序号前缀，保持下载顺序
    if (settings && settings.batchPrefix && index) {
      const segs = name.split('/');
      const last = segs[segs.length - 1];
      if (!new RegExp('^' + pad(index, 3) + '_').test(last)) {
        segs[segs.length - 1] = pad(index, 3) + '_' + last;
        name = segs.join('/');
      }
    }

    /* 保存到子目录（设置页的 subfolder）。放在最后拼，这样上面的序号前缀
       加的是**文件名**而不是目录名 —— 否则会变成 `001_站点名/照片.jpg`。 */
    const sub = buildSubfolder(settings && settings.subfolder, cand, index);
    if (sub) name = sub + '/' + name;

    return name;
  }

  /* ------------------------------------------------------------------ *
   * 格式化
   * ------------------------------------------------------------------ */

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
  }

  function formatDim(w, h) {
    if (!w || !h) return '尺寸未知';
    return w + ' × ' + h;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => pad(n, 2);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function prettyHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /** 取 URL 的原始主机名（**不**去掉 www.）—— 站点排除列表要按真实域名匹配 */
  function rawHost(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ *
   * 站点排除列表
   *
   * 一条记录 = 一个域名，匹配「它自己」+「它的所有子域名」：
   *   example.com   → example.com / www.example.com / img.example.com
   *   *.example.com → 同上（前导 `*.` 可写可不写，只为照顾习惯）
   * 也允许直接粘贴完整 URL（`https://example.com/a/b`），会自动取出域名。
   *
   * 刻意**不做**路径级 / 正则级匹配：域名是最小惊讶的选择，
   * 而且用户输入什么都一眼能看懂自己排除了什么。
   * ------------------------------------------------------------------ */

  /** 把用户输入（域名或完整 URL）规范化成可比较的域名；无法识别返回 '' */
  function normalizeHostPattern(input) {
    let p = String(input == null ? '' : input).trim().toLowerCase();
    if (!p) return '';
    // 允许直接粘贴地址
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(p)) {
      try { p = new URL(p).hostname; } catch (e) { return ''; }
    }
    // 允许 `example.com/foo` 这种没带协议的粘贴
    if (p.indexOf('/') >= 0) p = p.split('/')[0];
    if (p.indexOf('@') >= 0) p = p.split('@').pop();   // user@host
    if (p.indexOf(':') >= 0) p = p.split(':')[0];      // 带端口
    p = p.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
    if (!p) return '';
    // 只接受形如 a.b 或 a.b.c 的域名；单段（如 localhost）也放行。
    // 「既没有点、也没有字母」的（例如用户手滑敲的 `42`）挡掉 ——
    // 这种输入只会变成一条谁也匹配不上的规则，不如当场不认。
    if (!/[a-z]/.test(p) && p.indexOf('.') < 0) return '';
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(p)) return '';
    return p;
  }

  /** 主机名是否命中某一条排除记录 */
  function hostMatches(host, pattern) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    const p = normalizeHostPattern(pattern);
    if (!h || !p) return false;
    return h === p || h.endsWith('.' + p);
  }

  /** 这个地址所在的站点是否被排除 */
  function isHostBlocked(url, list) {
    if (!Array.isArray(list) || !list.length) return false;
    const h = rawHost(url);
    if (!h) return false;
    for (const p of list) {
      if (hostMatches(h, p)) return true;
    }
    return false;
  }

  /** 清洗外部导入的排除列表：规范化、去重、限长 */
  function sanitizeBlockedHosts(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const p = normalizeHostPattern(item);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= 200) break;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 设置导入
   * ------------------------------------------------------------------ */

  /**
   * 校验外部导入的自定义还原规则。
   * 正则不在这里编译（编译失败由 scanner 静默跳过），但结构必须先卡住，
   * 免得把脏数据写进设置、让设置页渲染出一堆空行。
   * @param {any} raw
   * @returns {Array<{pattern:string,flags:string,replace:string}>}
   */
  function sanitizeCustomRules(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r === 'object' && typeof r.pattern === 'string' && r.pattern.trim())
      .slice(0, 50)
      .map((r) => ({
        pattern: String(r.pattern).slice(0, 500),
        flags: typeof r.flags === 'string' && r.flags.trim() ? r.flags.trim().slice(0, 10) : 'i',
        replace: r.replace == null ? '' : String(r.replace).slice(0, 500)
      }));
  }

  /**
   * 把导入文件里的设置合并成一份「只含已知字段」的干净补丁。
   *
   * 这里单独处理 customRules / blockedHosts 有三个原因：
   *  1. 它们必须走各自的校验（正则结构 / 域名规范化），不能原样拷贝；
   *  2. 历史上 customRules 根本不在白名单里（当时 DEFAULT_SETTINGS 没有这个键），
   *     于是「导出 → 导入」一轮之后用户写的规则会全部静默消失；
   *  3. 两者都是数组，需要独立副本，不能和 DEFAULT_SETTINGS 共享引用。
   *
   * @param {any} incoming 导入文件里的 settings 对象
   * @param {object} defaults C.DEFAULT_SETTINGS
   * @returns {object} 可直接交给 Store.updateSettings 的补丁
   */
  function mergeImportedSettings(incoming, defaults) {
    const clean = {};
    if (!incoming || typeof incoming !== 'object') return clean;

    const special = { customRules: sanitizeCustomRules, blockedHosts: sanitizeBlockedHosts };

    for (const k of Object.keys(defaults || {})) {
      if (Object.prototype.hasOwnProperty.call(special, k)) continue;  // 单独校验，见下
      if (Object.prototype.hasOwnProperty.call(incoming, k)) clean[k] = incoming[k];
    }

    // 文件里没带这个字段时保持现状，不要顺手清空用户已有的内容
    for (const k of Object.keys(special)) {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) clean[k] = special[k](incoming[k]);
    }
    return clean;
  }

  /* ------------------------------------------------------------------ *
   * 函数工具
   * ------------------------------------------------------------------ */

  function debounce(fn, wait) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  function rafThrottle(fn) {
    let scheduled = false, lastArgs = null, lastSelf = null;
    return function () {
      lastArgs = arguments; lastSelf = this;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn.apply(lastSelf, lastArgs);
      });
    };
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /** 轻量同步哈希（FNV-1a 32bit，转 16 进制）—— 用于无法用 SubtleCrypto 的场景 */
  function quickHash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** SHA-256（需要安全上下文，请在扩展页 / Service Worker 中调用） */
  async function sha256hex(str) {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const buf = new TextEncoder().encode(str);
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return quickHash(str) + quickHash(str + '#salt');
  }

  /* ------------------------------------------------------------------ *
   * 并发控制器
   * ------------------------------------------------------------------ */

  /**
   * 创建一个并发受限的执行器
   * @param {number} max 最大并发
   * @returns {(task: () => Promise<any>) => Promise<any>}
   */
  function createLimiter(max) {
    const limit = Math.max(1, max | 0);
    let active = 0;
    const queue = [];

    function next() {
      if (active >= limit || !queue.length) return;
      const job = queue.shift();
      active++;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .then(() => { active--; next(); });
    }

    return function run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
      });
    };
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ------------------------------------------------------------------ *
   * DOM / 其他
   * ------------------------------------------------------------------ */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 带超时的 fetch */
  async function fetchWithTimeout(url, options, timeout) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 8000);
    try {
      return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  /** 下载一份数据为文件（在扩展页中使用） */
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ------------------------------------------------------------------ *
   * 与 Service Worker 通信
   * ------------------------------------------------------------------ */

  /** 向 background 发消息，永不 reject，统一返回 { ok, ... } */
  function sendToBg(message) {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false, error: '扩展上下文不可用' });
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (res) => {
          const err = chrome.runtime.lastError;
          if (err) { resolve({ ok: false, error: err.message || String(err) }); return; }
          resolve(res === undefined ? { ok: false, error: '无响应' } : res);
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  /** 把扩展内的资源转成可访问 URL */
  function extUrl(path) {
    try { return chrome.runtime.getURL(path); } catch (e) { return path; }
  }

  /**
   * 创建一个带 Shadow DOM 的宿主元素，并注入扩展的 overlay.css
   * 这样页内 UI 与宿主页面样式完全隔离，互不污染
   */
  function createShadowHost(hostStyle) {
    const host = document.createElement('div');
    host.setAttribute('data-ih-host', '1');
    if (hostStyle) host.style.cssText = hostStyle;
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = extUrl('content/overlay.css');
    root.appendChild(link);
    return { host, root };
  }

  /** 复制文本到剪贴板（带 execCommand 回退） */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 回退 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** 把任意图片 blob 转成 PNG blob（剪贴板写入需要） */
  function toPngBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = img.naturalWidth || 1;
          cv.height = img.naturalHeight || 1;
          cv.getContext('2d').drawImage(img, 0, 0);
          cv.toBlob((b) => {
            URL.revokeObjectURL(url);
            if (b) resolve(b); else reject(new Error('图片转换失败'));
          }, 'image/png');
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  IH.U = {
    absUrl,
    normalizeUrl,
    isDataUrl,
    isBlobUrl,
    extFromUrl,
    isProbablyImageUrl,
    parseSrcset,
    pickLargestFromSrcset,
    extractCssUrls,
    sanitizeFilename,
    sanitizeSegment,
    buildFilename,
    buildSubfolder,
    sanitizeCustomRules,
    mergeImportedSettings,
    formatBytes,
    formatDim,
    formatTime,
    prettyHost,
    rawHost,
    normalizeHostPattern,
    hostMatches,
    isHostBlocked,
    sanitizeBlockedHosts,
    debounce,
    rafThrottle,
    clamp,
    uid,
    quickHash,
    sha256hex,
    createLimiter,
    sleep,
    escapeHtml,
    fetchWithTimeout,
    blobToDataUrl,
    downloadText,
    sendToBg,
    extUrl,
    createShadowHost,
    copyText,
    toPngBlob
  };
})();
