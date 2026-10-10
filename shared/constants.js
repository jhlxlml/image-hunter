/* ==========================================================================
 * ImageHunter — shared/constants.js
 * 全局命名空间、消息类型、默认配置、原图还原规则表
 * 经典脚本（非 ESM），同时被 content script / service worker / 弹窗 / 设置页加载
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.C) return; // 防止重复执行

  /* ------------------------------------------------------------------ *
   * 消息类型
   * ------------------------------------------------------------------ */
  const MSG = {
    // content <-> background
    GET_TAB_ID: 'IH_GET_TAB_ID',
    DO_SCAN: 'IH_DO_SCAN',
    SCAN_RESULT: 'IH_SCAN_RESULT',
    SCAN_TAB: 'IH_SCAN_TAB',
    DOWNLOAD_ONE: 'IH_DOWNLOAD_ONE',
    DOWNLOAD_BATCH: 'IH_DOWNLOAD_BATCH',
    CANCEL_BATCH: 'IH_CANCEL_BATCH',
    PROBE_SIZE: 'IH_PROBE_SIZE',
    GET_HISTORY: 'IH_GET_HISTORY',
    CLEAR_HISTORY: 'IH_CLEAR_HISTORY',
    CLEAR_FINGERPRINTS: 'IH_CLEAR_FINGERPRINTS',
    GET_STATS: 'IH_GET_STATS',
    /* 诊断包：设置页要「版本 + 平台 + 设置 + 最近下载 + 最近一次扫描统计」。
       扫描统计只有 background 有（它才知道 frameCount / 截断 / 还原情况），
       所以由设置页来取，而不是让设置页自己猜。 */
    GET_DIAGNOSTICS: 'IH_GET_DIAGNOSTICS',
    OPEN_PANEL: 'IH_OPEN_PANEL',
    TOGGLE_PANEL: 'IH_TOGGLE_PANEL',
    OPEN_LIGHTBOX: 'IH_OPEN_LIGHTBOX',
    // 图库独立标签页 <-> background
    GET_TARGET_TAB: 'IH_GET_TARGET_TAB',
    LIST_TABS: 'IH_LIST_TABS',
    GALLERY_HELLO: 'IH_GALLERY_HELLO',
    GALLERY_TARGET: 'IH_GALLERY_TARGET',
    // 广播
    PROGRESS: 'IH_PROGRESS',
    SETTINGS_CHANGED: 'IH_SETTINGS_CHANGED',
    // 「先出图、后升级」的第二步：后台收到内容脚本的第一版中间结果（partial）就
    // 立刻兑现 SCAN_TAB 的响应，图库马上把图铺出来；等原图还原跑完（冷启动最长
    // 8 秒），再用这条广播把**最终结果**推给图库页，由它原地升级卡片。
    //
    // 为什么 final 不能走 SCAN_TAB 的响应：一条消息只能 sendResponse 一次。
    SCAN_UPGRADE: 'IH_SCAN_UPGRADE',
    // 深度嗅探的滚动进度：content → background → 图库界面。
    // 单独一条而不是塞进 SCAN_RESULT，是因为它一秒要来好几次，
    // 走 SCAN_RESULT 会被后台当成「又来了一版结果」，把安静期反复清零。
    DEEP_PROGRESS: 'IH_DEEP_PROGRESS',
    // 内部桥接（原本是散落在各处的裸字符串，收进表里才能被 validate.js 校验到）
    PING: 'IH_PING',
    FETCH_IMAGE: 'IH_FETCH_IMAGE',
    SAVE_BY_SRC: 'IH_SAVE_BY_SRC',
    // 页内面板的来源校验（见 AUDIT P3-7）：
    // 面板是「页面里的 iframe 加载扩展页」，任何网站都能构造同款 iframe 来套壳点击。
    // 内容脚本先向后台领一个只属于本标签页的 token，写进 iframe 的 URL；
    // 面板启动时拿它回后台核验。网站拿不到 token（它没法给后台发消息），
    // 所以伪造的 iframe 过不了校验。
    PANEL_TOKEN: 'IH_PANEL_TOKEN',
    PANEL_VERIFY: 'IH_PANEL_VERIFY',
    // 「单张还原」：撞上还原时间预算时靠后的图会保持缩略图地址，
    // 图库给这些卡片一个「还原」小按钮，对这一张单独重跑一次 tryRestore。
    // 走后台转发是因为图库页（扩展页）与目标图片不在同一个上下文里。
    RESTORE_ONE: 'IH_RESTORE_ONE',
    // 「在图库中打开」：悬停预览只送得进 1 张图（手里只有鼠标压着的那个元素），
    // 灯箱的 ←→ 因此是 disabled 的。灯箱顶栏给一个入口，把当前这张交给图库页，
    // 由它定位到对应卡片 —— 用户看完这一张想「再看下一张」时不用回图库重新找。
    // 方向是 content → background（由后台决定复用还是新开图库标签页）。
    OPEN_GALLERY: 'IH_OPEN_GALLERY',
    // 快捷键「保存鼠标当前悬停的那张图」：后台 → 内容脚本。
    // 悬停目标只有内容脚本知道（它才收 mouseover），所以这条只能往下发。
    SAVE_HOVERED: 'IH_SAVE_HOVERED'
  };

  /* ------------------------------------------------------------------ *
   * 默认设置
   * ------------------------------------------------------------------ */
  const DEFAULT_SETTINGS = {
    /* 通用 */
    theme: 'light',                    // light | dark | auto
    /* 主题预设配色：六选一（靛蓝 / 青碧 / 翡翠 / 玫红 / 琥珀 / 石板）。
       与 theme（亮暗档）是两个正交的维度 —— 换预设不改变亮暗，
       换亮暗也不改变预设。实际主色由 shared/theme.js 的 PRESETS 决定，
       这里只存**用户选了哪一套**。
       必须列在默认设置里：否则导出设置再导入会被白名单滤掉。 */
    themePreset: 'indigo',
    /* 自定义主色，格式 '#rrggbb'。**空串 = 跟随上面的预设** ——
       用空串而不是 null/undefined，是因为它要能被 JSON 往返
       （导出→导入是 JSON，undefined 会整个键消失）。
       非空但格式非法时同样退回预设（见 Theme.resolve）。 */
    themeAccent: '',
    /* 界面语言：'auto' 跟随浏览器，'zh' / 'en' 强制指定。
       为什么不直接用 chrome.i18n：那套只能跟随**浏览器界面语言**，
       用户在扩展里自己选一个语言它做不到 —— 所以界面文案另起一层
       （shared/i18n.js），这里存的只是「用户选了什么」。
       必须列在默认设置里：否则导出设置再导入时会被白名单滤掉，
       用户选的语言会静默回到「跟随浏览器」。 */
    uiLang: 'auto',

    /* 嗅探 */
    scanImg: true,
    scanBackground: true,
    scanPseudo: true,
    scanPoster: true,
    scanSvg: false,
    scanLinks: true,
    scanPreload: true,
    scanOg: true,
    restoreOriginal: true,             // 缩略图 -> 原图 还原
    minSize: 64,                       // 悬停图标生效的最小边（px，页面显示尺寸）
    /* 大图预览列表的最小边（px，图片**真实像素**尺寸）。0 = 不过滤。
       与上面的 minSize 是两件事，别合并：
         - minSize    判「页面显示尺寸」，决定悬停图标显不显示
         - lightboxMinSize 判「真实像素尺寸」，决定灯箱里能翻到哪几张
       只作用于灯箱，图库卡片 / 批量下载 / 悬停图标都不受它影响。 */
    lightboxMinSize: 64,
    probeTimeout: 4000,                // 单张图片尺寸探测超时
    probeConcurrency: 6,               // 尺寸探测并发

    /* 下载 */
    concurrency: 3,
    retries: 2,
    skipDownloaded: true,
    fetchFallback: true,
    filenameTemplate: '{name}.{ext}',  // 支持 {name} {ext} {index} {host} {w} {h}
    batchPrefix: false,                // 批量下载时给文件名加序号前缀
    /* 保存到子目录：留空即直接存到下载目录。支持 {host} {date} {index}。
       渲染结果会拼在文件名前面，最终形如 `<下载目录>/<subfolder>/<文件名>` */
    subfolder: '',

    /* 交互 */
    hoverEnabled: true,
    hoverDelay: 120,
    altClickSave: true,
    /* 多标签页合并嗅探：打开后，图库顶部的「扫描目标」从单选下拉变成多选，
       可以一次勾选多个已打开的网页标签页，把它们上面的图片合并成一份列表
       （按图片地址去重，卡片上标出来自哪个页面）。
       默认关 —— 只扫当前这一页是绝大多数时候想要的行为，
       合并是一次「有意的额外动作」，不该默认替用户打开。 */
    mergeTabs: false,

    /* 站点排除列表：这些站点上不显示悬停按钮、不响应 Alt+点击、不开页内面板，
       扫描也直接如实回「已排除」而不是回一个空列表。一条记录是一个域名，
       同时匹配它的所有子域名（example.com 也匹配 www.example.com）。
       注意：MV3 的 content_scripts 是静态声明，文件**仍会**被加载，
       这里关掉的是 UI 行为，不是注入本身。 */
    blockedHosts: [],

    /* 自定义原图还原规则 [{pattern, flags, replace}]，在设置页里编辑。
       必须列在这里：否则它不算「已知设置」，导出后再导入会被白名单过滤掉，
       用户辛苦写的规则会静默消失。 */
    customRules: []
  };

  /* ------------------------------------------------------------------ *
   * 图片扩展名
   * ------------------------------------------------------------------ */
  const IMAGE_EXT = [
    'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif',
    'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'heif', 'jxl'
  ];

  /* ------------------------------------------------------------------ *
   * 来源标签（用于弹窗筛选）
   * ------------------------------------------------------------------ */
  const SOURCE_LABELS = {
    img: '页面图片',
    srcset: 'srcset 大图',
    picture: 'picture',
    lazy: '懒加载图',
    bg: '背景图',
    pseudo: '伪元素背景',
    poster: '视频封面',
    svg: '内联 SVG',
    link: '图片链接',
    preload: '预加载图',
    og: '社交主图'
  };

  /* ------------------------------------------------------------------ *
   * 原图还原规则
   * 每条规则：{ id, label, apply(url) -> string|null }
   * apply 返回新 URL（与原 URL 不同）表示可以尝试还原，返回 null 表示不适用
   * 所有还原候选都会被真实加载验证，只有确实更大才会采用 —— 不会改坏链接
   * ------------------------------------------------------------------ */

  /** 删除 URL 中指定的查询参数；无变化返回 null */
  function dropQueryKeys(url, keys) {
    const hashIdx = url.indexOf('#');
    let hash = '';
    let base = url;
    if (hashIdx >= 0) { hash = url.slice(hashIdx); base = url.slice(0, hashIdx); }

    const qIdx = base.indexOf('?');
    if (qIdx < 0) return null;

    const path = base.slice(0, qIdx);
    const params = new URLSearchParams(base.slice(qIdx + 1));
    let changed = false;
    for (const key of Array.from(params.keys())) {
      if (keys.indexOf(key.toLowerCase()) >= 0) { params.delete(key); changed = true; }
    }
    if (!changed) return null;
    const rest = params.toString();
    return (rest ? path + '?' + rest : path) + hash;
  }

  /** 删除 URL 中匹配正则的查询片段（如 ?imageView2/2/w/300） */
  function dropQueryByRegex(url, regex) {
    const out = url.replace(regex, (m, p1) => (p1 === '?' || p1 === '&' ? p1 : ''));
    const cleaned = out.replace(/[?&]+$/, '').replace(/\?&/, '?').replace(/&&/g, '&');
    return cleaned !== url ? cleaned : null;
  }

  const BUILTIN_RESTORE_RULES = [
    {
      id: 'wp-size',
      label: 'WordPress 尺寸后缀（image-300x200.jpg）',
      apply(url) {
        const m = url.match(/^(.*?)-(\d{2,4})x(\d{2,4})(\.(?:jpe?g|png|gif|webp|avif|bmp))((?:\?[^#]*)?(?:#.*)?)$/i);
        if (!m) return null;
        return m[1] + m[4] + (m[5] || '');
      }
    },
    {
      id: 'path-dim',
      label: '路径尺寸段（/300x200/、/w_300/）',
      apply(url) {
        const m = url.match(/^(https?:\/\/[^/]+)([^?#]*)((?:[?#].*)?)$/i);
        if (!m) return null;
        const origin = m[1];
        const pathPart = m[2];
        const tail = m[3] || '';
        let p = pathPart;
        p = p.replace(/\/(?:w_|h_|s_|c_)?\d{2,4}[x_]\d{2,4}\//gi, '/');
        p = p.replace(/\/(?:thumb|thumbs|thumbnail|thumbnails|small|mini|medium|preview|resize|resized|crop|cropped|compressed)\//gi, '/');
        p = p.replace(/\/{2,}/g, '/');
        if (p === pathPart) return null;
        return origin + p + tail;
      }
    },
    {
      id: 'cloudinary',
      label: 'Cloudinary 变换段（/upload/w_300,h_200/）',
      apply(url) {
        let out = url.replace(/(\/upload\/)(?:[a-z]{1,3}_[^/,?#]*,?)+\//i, '$1');
        if (out === url) return null;
        out = out.replace(/(\/upload\/)v\d+\//i, '$1');
        return out;
      }
    },
    {
      id: 'qiniu',
      label: '七牛云 imageView（?imageView2/…）',
      apply(url) {
        return dropQueryByRegex(url, /([?&])image(?:View2?|Mogr2|Info|Ave|Watermark)\/[^&#]*/gi);
      }
    },
    {
      id: 'ali-oss',
      label: '阿里云 OSS（?x-oss-process=…）',
      apply(url) {
        return dropQueryByRegex(url, /([?&])x-oss-process=[^&#]*/gi);
      }
    },
    {
      id: 'bce-process',
      label: '百度云加速 BCE（?x-bce-process=…）',
      apply(url) {
        return dropQueryByRegex(url, /([?&])x-bce-process=[^&#]*/gi);
      }
    },
    {
      id: 'upyun',
      label: '又拍云（! 分隔的缩略参数）',
      apply(url) {
        const m = url.match(/^([^!]+)!([a-zA-Z0-9_\-/,.]+)$/);
        if (!m) return null;
        // 排除协议里可能出现的 !（几乎不可能），保守处理
        if (/^https?$/.test(m[1])) return null;
        return m[1];
      }
    },
    {
      id: 'taobao-cdn',
      label: '淘宝/天猫 CDN（abc.jpg_300x300q75.jpg）',
      apply(url) {
        const m = url.match(/^(.*?\.(?:jpe?g|png|gif|webp|avif))_[A-Za-z0-9.]+((?:[?#].*)?)$/i);
        if (!m) return null;
        return m[1] + (m[2] || '');
      }
    },
    {
      id: 'query-size',
      label: '通用查询参数（?w= &h= &q= &resize= …）',
      apply(url) {
        return dropQueryKeys(url, [
          'w', 'h', 'width', 'height', 'q', 'quality', 'resize', 'size', 'sizes',
          'scale', 'fit', 'crop', 'dpr', 'maxwidth', 'maxheight', 'max_width',
          'max_height', 'compression', 'compress', 'sharpen', 'blur', 'strip',
          'thumbnail', 'thumb', 'small', 'smaller', 'preview', 'auto', 'fm', 'cs'
        ]);
      }
    }
  ];

  /* ------------------------------------------------------------------ *
   * 候选生成（纯字符串运算，不发请求、不碰 DOM）
   * ------------------------------------------------------------------ */

  /**
   * 依据内置规则 + 用户自定义规则，生成原图候选 URL。
   *
   * 放在 shared 而不是 scanner.js，是因为两个宿主都要用它：
   *   - 内容脚本：扫描时批量还原（scanner.tryRestore 内部调用）
   *   - 图库页：判断某张卡片**值不值得**显示「还原」按钮 ——
   *     一条候选都生成不出来的图，点了也是白等 4 秒探测，不该给它按钮。
   *
   * 每个候选都带着**是哪条规则产生的**（ruleId），这样还原结果可以如实标注，
   * 而不是一律写 'builtin'（历史上 tryRestore 声明返回 ruleId 却没返回，
   * 导致 restoreRule 恒为 'builtin'，规则命中信息成了死数据）。
   *
   * 注意：constants.js 在 utils.js **之前**加载（见 manifest 的 js 数组），
   * 所以这里不能引用 IH.U —— data:/blob: 的判断直接内联。
   *
   * @returns {Array<{url:string, ruleId:string}>}
   */
  function buildRestoreCandidates(url, settings) {
    if (!url || /^(?:data|blob):/i.test(url)) return [];
    const out = new Map();          // 候选 URL -> 首个命中它的规则 id

    for (const rule of BUILTIN_RESTORE_RULES) {
      let v = null;
      try { v = rule.apply(url); } catch (e) { v = null; }
      if (v && v !== url && !out.has(v)) out.set(v, rule.id);
    }

    const custom = (settings && settings.customRules) || [];
    for (const rule of custom) {
      if (!rule || !rule.pattern) continue;
      try {
        const re = new RegExp(rule.pattern, rule.flags || 'i');
        const v = url.replace(re, rule.replace == null ? '' : rule.replace);
        if (v && v !== url && !out.has(v)) out.set(v, 'custom');
      } catch (e) { /* 用户正则非法时忽略 */ }
    }

    return Array.from(out.entries())
      .slice(0, 6)
      .map(([u, id]) => ({ url: u, ruleId: id }));
  }

  /* ------------------------------------------------------------------ *
   * 扫描回报的两个阶段
   * ------------------------------------------------------------------ */

  /**
   * 一次 SCAN_RESULT 可能处于两个阶段：
   * - partial：采集完成、尺寸已补齐，但**原图还原还没跑**的中间结果。
   *   它有两个用途：① 向后台证明「扫描确实在进行」（后台据此不再按超时收尾）；
   *   ② 万一还原迟迟不结束，用户至少能看到未还原的图，而不是一张都没有。
   * - final：还原完成后的最终结果，会**覆盖**同一 frame 的 partial。
   *
   * 之所以要分两阶段：原图还原要给每张候选发真实加载请求，冷加载时很容易
   * 超过任何固定超时。历史上后台只有「1.5 秒没响应就收尾」这一个判据，
   * 于是首次打开图库时经常拿到空列表 —— 而第二次打开因为图片已进 HTTP
   * 缓存就又快又准，表现为「偶尔」识别不到。
   */
  const SCAN_PHASE = { PARTIAL: 'partial', FINAL: 'final' };

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  IH.C = {
    MSG,
    SCAN_PHASE,
    DEFAULT_SETTINGS,
    IMAGE_EXT,
    SOURCE_LABELS,
    BUILTIN_RESTORE_RULES,
    buildRestoreCandidates,
    STORAGE_KEYS: {
      SETTINGS: 'ih_settings',
      HISTORY: 'ih_history',
      FINGERPRINTS: 'ih_fingerprints',
      STATS: 'ih_stats'
    },
    HISTORY_LIMIT: 500,
    FINGERPRINT_LIMIT: 5000,
    /* 一次「探测体积」请求里最多带多少张。弹窗按这个值分批发，
       后台也按这个值兜底截断 —— 两边必须是同一个数，否则后台会静默丢掉多余的 URL。 */
    PROBE_LIMIT: 120,
    /* 单次嗅探最多返回多少张（再多界面也看不过来，而且会拖慢消息序列化）。
       放到这里是因为**界面上要如实说出这个数**（「本页共 N 张，仅展示前 M 张」
       之外还要解释「可能超出前 2000 张」）—— 写死在文案里迟早和后台对不上。 */
    SCAN_LIMIT: 2000
  };
})();
