/* ==========================================================================
 * ImageHunter — 诊断包（shared/diagnostics.js）
 *
 * 用途：用户撞到「面板拒绝」「还原失败」「体积探测失败」这类问题时，
 * 界面上只能告诉他「失败了」，报 bug 就只能截图 + 口述。这个模块把
 * 「如实上报」延伸到「可自助排障」：一键导出一份 JSON，直接贴进 issue。
 *
 * ---------------------------------------------------------------------------
 * 这个文件里真正需要维护的只有两件事，其余都是顺带的管道：
 *
 *  1. **白名单，不是黑名单。**
 *     全部字段逐个列出、逐个拷贝，**绝不**用 `Object.assign({}, entry)`
 *     或 `JSON.stringify(recentLog)` 整体透传。理由不是「现在的字段很安全」，
 *     而是「以后的字段不可控」：哪天给下载任务加一个 `referer` / `fullPath` /
 *     `cookieHeader`，黑名单会**静默把它写进用户要公开粘贴的文件里**，
 *     而白名单只会**少一个字段**。前者是事故，后者是待办事项。
 *
 *  2. **任何字符串都要过 scrub()。**
 *     错误信息、自定义还原规则、文件名都可能夹带完整地址（错误信息里
 *     带请求 URL 是很常见的）。scrub 把 `scheme://…` 整体替换成 `[url]`，
 *     于是「诊断包里不可能出现任何完整地址」变成一条**结构上成立**的
 *     不变量 —— 而不是「我们记得别写进去」。
 *     配套的 audit() 会在导出前真的把结果走一遍，发现漏网就直接拦下来。
 *
 * 纯函数、不碰 chrome API、不碰 DOM —— 所以能在 Node 里直接跑断言
 * （见 tests/test-diagnostics.js）。
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});

  const APP = 'image-hunter';
  /** 诊断包自身的格式版本。以后字段增删改语义时 +1，方便阅读方兼容 */
  const FORMAT = 1;

  /* ------------------------------------------------------------------ *
   * 白名单
   * ------------------------------------------------------------------ */

  /** 下载记录：只留「什么时候、哪个站、哪个文件、成没成、多大、为什么失败」 */
  const DOWNLOAD_FIELDS = ['ts', 'filename', 'status', 'bytes', 'error'];

  /** 扫描摘要：全是聚合数字 + 主机名，没有任何页面地址或图片地址 */
  const SCAN_FIELDS = [
    'at', 'pageHost', 'frameCount', 'found', 'truncated',
    'restored', 'notRestored', 'restoreTruncated',
    'bgTruncatedFrames', 'bgTruncatedElements', 'deepTruncated',
    'blocked', 'cached', 'sourceCounts'
  ];

  /** 体积探测的累计成败（只有计数，没有探测过哪些地址） */
  const PROBE_FIELDS = ['ok', 'failed', 'lastAt'];

  /**
   * 设置里**不导出**的键。
   *
   * `blockedHosts` 是用户自己列的一份「我不嗅探这些站」的清单 ——
   * 它是设置，同时也是**浏览轨迹**（谁会把一个自己从没打开过的站加进排除列表？）。
   * 排障完全用不到它，所以整个丢掉，只留一个条数。
   */
  const SETTINGS_OMIT = ['blockedHosts'];

  /** 字符串里任何 `scheme://…` 都算地址。注意**不加 g 标志**，避免 lastIndex 状态污染 */
  const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/i;

  /* ------------------------------------------------------------------ *
   * 清洗
   * ------------------------------------------------------------------ */

  /** 把字符串里的完整地址换成 [url] */
  function scrub(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi, '[url]');
  }

  /** 递归清洗：字符串过 scrub，数组 / 普通对象逐项下去，其余原样 */
  function scrubDeep(v) {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(scrubDeep);
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach((k) => { out[k] = scrubDeep(v[k]); });
      return out;
    }
    return v;
  }

  /** 只拷白名单里的键。不在名单里的一律不出现 —— 包括调用方将来新加的键 */
  function pick(obj, keys) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }

  /**
   * 从地址里取主机名。
   * 不依赖 U.prettyHost，是为了让这个模块在 Node 里能脱离 shared/utils 单独跑；
   * 行为与 U.prettyHost 对齐（去 www.、小写）。
   */
  function hostOf(url) {
    const m = String(url || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
    if (!m) return '';
    return m[1].replace(/^www\./i, '').toLowerCase();
  }

  /* ------------------------------------------------------------------ *
   * 分项清洗
   * ------------------------------------------------------------------ */

  /**
   * 下载记录 → 诊断用的精简条目。
   * `url` / `pageUrl` / `referer` 这些**连键都不会出现在结果里**，
   * 因为 DOWNLOAD_FIELDS 里没有它们。
   */
  function sanitizeDownload(e) {
    if (!e || typeof e !== 'object') return null;
    const out = pick(e, DOWNLOAD_FIELDS);
    // 站点从 url 现算，只留 hostname（路径与查询串一律不进结果）
    out.host = hostOf(e.url);
    if (typeof out.ts !== 'number') out.ts = null;
    if (typeof out.bytes !== 'number') out.bytes = 0;
    if (out.status !== 'done' && out.status !== 'failed' && out.status !== 'skipped') {
      out.status = String(out.status || 'unknown').slice(0, 24);
    }
    if (out.filename != null) out.filename = scrub(String(out.filename)).slice(0, 200);
    if (out.error != null) out.error = scrub(String(out.error)).slice(0, 200);
    else delete out.error;
    return out;
  }

  /** 扫描摘要 → 诊断用。sourceCounts 只保留数字，防止有人往里塞别的东西 */
  function sanitizeScan(s) {
    if (!s || typeof s !== 'object') return null;
    const out = pick(s, SCAN_FIELDS);
    if (out.pageHost != null) out.pageHost = scrub(String(out.pageHost)).slice(0, 120);
    if (out.sourceCounts && typeof out.sourceCounts === 'object') {
      const counts = {};
      Object.keys(out.sourceCounts).forEach((k) => {
        const v = out.sourceCounts[k];
        if (typeof v === 'number' && isFinite(v)) counts[scrub(String(k)).slice(0, 24)] = v;
      });
      out.sourceCounts = counts;
    }
    return out;
  }

  /** 设置 → 诊断用。丢掉 SETTINGS_OMIT，其余递归过 scrub，另附被丢掉项的条数 */
  function sanitizeSettings(settings) {
    const src = settings || {};
    const out = {};
    Object.keys(src).forEach((k) => {
      if (SETTINGS_OMIT.indexOf(k) >= 0) return;
      out[k] = scrubDeep(src[k]);
    });
    SETTINGS_OMIT.forEach((k) => {
      if (Array.isArray(src[k])) out[k + 'Count'] = src[k].length;
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 构建
   * ------------------------------------------------------------------ */

  /**
   * 组装诊断包。
   *
   * @param {object} input
   * @param {string}  input.version          扩展版本号
   * @param {string}  [input.platform]       navigator.userAgent
   * @param {string}  [input.language]       navigator.language
   * @param {object}  [input.settings]       当前设置
   * @param {Array}   [input.recentDownloads] background 的 recentLog（原始形态，含 url）
   * @param {object}  [input.lastScan]        background 的 lastScanSummary
   * @param {number}  [input.now]             注入时间，便于测试
   * @returns {object} 可直接 JSON.stringify 的诊断包
   */
  function build(input) {
    input = input || {};
    const now = typeof input.now === 'number' ? input.now : Date.now();
    const downloads = (Array.isArray(input.recentDownloads) ? input.recentDownloads : [])
      .map(sanitizeDownload)
      .filter(Boolean);

    return {
      _app: APP,
      _format: FORMAT,
      _version: String(input.version || ''),
      createdAt: new Date(now).toISOString(),

      platform: {
        userAgent: scrub(String(input.platform || '')),
        language: scrub(String(input.language || ''))
      },

      settings: sanitizeSettings(input.settings),
      lastScan: sanitizeScan(input.lastScan),
      probe: input.probe ? pick(input.probe, PROBE_FIELDS) : null,
      recentDownloads: downloads,
      recentDownloadsCount: downloads.length,

      /* 写给「打开这个文件的人」看的。用户报 bug 时经常顺手把整份贴出去，
         这几行能让人一眼看出哪些东西是**故意**没有的，而不是被漏掉了。 */
      notes: [
        '本文件只含聚合数字与主机名，不含图片地址、页面地址、文件路径与查询串。',
        '所有完整地址已替换为 [url]；导出前由 audit() 自查过一遍。',
        '站点排除列表只保留条数（blockedHostsCount），清单本身不导出。'
      ]
    };
  }

  /* ------------------------------------------------------------------ *
   * 自查
   * ------------------------------------------------------------------ */

  /**
   * 把结果整体走一遍，找出任何夹带完整地址的字符串。
   * 返回违规路径数组，空数组 = 干净。
   *
   * 这个函数的存在意义是「不靠人记得」：以后有人往 settings 里加了一个
   * 带 URL 的键，只要它没被 scrub 掉，导出时就会被当场拦下。
   */
  function audit(obj) {
    const bad = [];
    const walk = (v, path) => {
      if (typeof v === 'string') {
        if (URL_RE.test(v)) bad.push(path);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
      if (v && typeof v === 'object') {
        Object.keys(v).forEach((k) => walk(v[k], path + '.' + k));
      }
    };
    walk(obj, '$');
    return bad;
  }

  /** 导出文件名：image-hunter-diag-20261008-153012.json */
  function fileName(now) {
    const d = new Date(typeof now === 'number' ? now : Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return 'image-hunter-diag-'
      + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
      + '.json';
  }

  IH.Diag = {
    APP,
    FORMAT,
    DOWNLOAD_FIELDS,
    SCAN_FIELDS,
    SETTINGS_OMIT,
    build,
    audit,
    fileName,
    scrub,
    scrubDeep,
    pick,
    hostOf,
    sanitizeDownload,
    sanitizeScan,
    sanitizeSettings
  };
})();
