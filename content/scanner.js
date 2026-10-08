/* ==========================================================================
 * ImageHunter — content/scanner.js
 * 【核心】图片嗅探引擎 + 原图还原算法
 *
 * 设计要点：
 *  1. 覆盖 9 类来源：img / srcset / picture / 懒加载属性 / CSS 背景图 /
 *     伪元素背景 / video poster / 内联 SVG / 链接图片 / preload / og:image
 *  2. 原图还原：把缩略图 URL 改写成原图 URL，但**必须真实加载验证且像素更大**才采用，
 *     否则回退原 URL —— 从机制上杜绝「把好链接改坏」
 *  3. 尺寸探测带并发限流 + 结果缓存，避免图片多时拖垮页面
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.Scanner) return;

  const C = IH.C;
  const U = IH.U;

  /** 懒加载属性候选（按优先级） */
  const LAZY_ATTRS = [
    'data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-actualsrc',
    'data-echo', 'data-url', 'data-image', 'data-img', 'data-big', 'data-large',
    'data-hi-res', 'data-hires', 'data-full', 'data-original-src', 'data-defer-src',
    'data-srcset', 'data-lazy-srcset', 'data-original-set'
  ];

  /** 需要跳过的标签（背景图扫描时） */
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, HEAD: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

  /* ==================================================================== *
   * 尺寸探测
   * ==================================================================== */

  const sizeCache = new Map();     // url -> {w,h} | null
  const inflight = new Map();      // url -> Promise
  let limiter = null;
  let limiterMax = 0;

  /* 尺寸缓存上限。按 URL 累积，在长时间驻留的页面（比如开着不关的资讯站）上
     只增不减 —— 无限滚动刷一天能攒出几万条。超上限就按插入顺序淘汰最旧的。 */
  const SIZE_CACHE_MAX = 4000;

  function cacheSize(url, value) {
    // 先删再插：Map 保持插入顺序，这样「最近用到的」永远排在后面，
    // 淘汰时丢掉的就是真正最久没用过的
    if (sizeCache.has(url)) sizeCache.delete(url);
    sizeCache.set(url, value);
    while (sizeCache.size > SIZE_CACHE_MAX) {
      const oldest = sizeCache.keys().next().value;
      if (oldest === undefined) break;
      sizeCache.delete(oldest);
    }
  }

  function getLimiter(max) {
    const n = Math.max(1, max | 0);
    if (!limiter || limiterMax !== n) {
      limiter = U.createLimiter(n);
      limiterMax = n;
    }
    return limiter;
  }

  /**
   * 探测一张图片的真实像素尺寸
   * 在内容脚本环境里用 Image 加载，天然携带页面 Referer 与 Cookie
   * @returns {Promise<{w:number,h:number}|null>}
   */
  function probeSize(url, timeout) {
    if (!url) return Promise.resolve(null);
    if (sizeCache.has(url)) return Promise.resolve(sizeCache.get(url));
    if (inflight.has(url)) return inflight.get(url);

    const p = new Promise((resolve) => {
      const img = new Image();
      let done = false;
      let timer = null;

      const finish = (value) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        cacheSize(url, value);
        inflight.delete(url);
        resolve(value);
      };

      timer = setTimeout(() => finish(null), Math.max(500, timeout || 4000));

      img.onload = () => {
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        finish(w > 0 && h > 0 ? { w, h } : null);
      };
      img.onerror = () => finish(null);

      try {
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer-when-downgrade';
        img.src = url;
      } catch (e) {
        finish(null);
      }
    });

    inflight.set(url, p);
    return p;
  }

  /** 并发受限的探测 */
  function probeLimited(url, timeout, concurrency) {
    return getLimiter(concurrency || 6)(() => probeSize(url, timeout));
  }

  /* ------------------------------------------------------------------ *
   * 并发闸门 / 时间预算
   * ------------------------------------------------------------------ */

  /**
   * 受并发上限约束的串行映射。
   *
   * 原图还原曾经是 `Promise.all(list.map(...))` —— 每张图内部再并发 6 个候选，
   * 于是 65 张图意味着最多 390 个加载请求同时在飞，实际并发完全不可控，
   * 撞上 HTTP/1.1 的每 host 6 连接限制后就变成几百个请求排队。
   */
  async function mapWithLimit(list, limit, fn) {
    let cursor = 0;
    const workers = [];
    const n = Math.max(1, Math.min(limit, list.length));
    for (let k = 0; k < n; k++) {
      workers.push((async () => {
        while (cursor < list.length) {
          const item = list[cursor++];
          try { await fn(item); } catch (e) { /* 单张失败不影响整轮 */ }
        }
      })());
    }
    await Promise.all(workers);
  }

  /**
   * 给一个 Promise 套时间预算。
   * @returns {Promise<boolean>} 在预算内跑完为 true；超预算被放弃为 false。
   *          注意被放弃不代表工作被取消 —— 在飞的请求仍会跑完，只是结果不再被采纳。
   */
  function withinBudget(promise, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, ms);
      promise.then(
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } },
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } }
      );
    });
  }

  /* ==================================================================== *
   * 采集器
   * ==================================================================== */

  function createCollector() {
    const map = new Map();
    let order = 0;

    function push(rawUrl, meta) {
      if (!rawUrl) return;
      meta = meta || {};

      let url = String(rawUrl).trim();
      if (!url) return;

      if (!U.isDataUrl(url) && !U.isBlobUrl(url)) {
        url = U.absUrl(url, document.baseURI);
        if (!url) return;
      }
      // 常见的 1x1 透明 GIF 占位
      if (/^data:image\/gif;base64,R0lGOD/i.test(url)) return;
      // javascript: / mailto: 等
      if (/^(javascript|mailto|tel|about):/i.test(url)) return;

      const key = U.normalizeUrl(url);
      const prev = map.get(key);

      if (prev) {
        if (!prev.element && meta.element) prev.element = meta.element;
        const prevArea = (prev.width || 0) * (prev.height || 0);
        const metaArea = (meta.width || 0) * (meta.height || 0);
        if (metaArea > prevArea) {
          prev.width = meta.width || 0;
          prev.height = meta.height || 0;
        }
        if (meta.source && prev.allSources.indexOf(meta.source) < 0) prev.allSources.push(meta.source);
        if ((meta.displayWidth || 0) > prev.displayWidth) {
          prev.displayWidth = meta.displayWidth || 0;
          prev.displayHeight = meta.displayHeight || 0;
        }
        if (meta.alt && !prev.alt) prev.alt = meta.alt;
        return;
      }

      map.set(key, {
        id: U.quickHash(key),
        key,
        url,
        /* 采集到的这个地址就是「页面实际显示的那张图」（可能是缩略图）。
           原图还原会把 url 换成更大的那张，displayUrl 保持不动 ——
           图库卡片拿它当缩略图用，避免为了一个小格子去下载整张大图。
           注意别和「网页地址」搞混：那个是 state.pageUrl，只作下载 Referer。 */
        displayUrl: url,
        source: meta.source || 'img',
        allSources: [meta.source || 'img'],
        element: meta.element || null,
        width: meta.width || 0,
        height: meta.height || 0,
        displayWidth: meta.displayWidth || 0,
        displayHeight: meta.displayHeight || 0,
        alt: meta.alt || '',
        order: order++,
        restored: false,
        restoreRule: null,
        sizeBytes: null
      });
    }

    return { map, push };
  }

  /* ------------------------------ img ------------------------------ */

  function collectFromImg(img, push) {
    const rect = img.getBoundingClientRect();
    const dispW = Math.round(rect.width) || img.width || 0;
    const dispH = Math.round(rect.height) || img.height || 0;
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;

    const seen = new Set();
    const add = (raw, source, sizeKnown) => {
      if (!raw) return;
      const abs = U.isDataUrl(raw) ? raw : U.absUrl(raw, document.baseURI);
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      push(abs, {
        source,
        element: img,
        width: sizeKnown ? nw : 0,
        height: sizeKnown ? nh : 0,
        displayWidth: dispW,
        displayHeight: dispH,
        alt: img.alt || img.getAttribute('title') || ''
      });
    };

    if (img.currentSrc) add(img.currentSrc, 'img', true);
    if (img.getAttribute('src')) add(img.getAttribute('src'), 'img', true);

    const srcset = img.getAttribute('srcset');
    if (srcset) add(U.pickLargestFromSrcset(srcset), 'srcset', false);

    // <picture><source srcset>
    const pic = img.parentElement && img.parentElement.tagName === 'PICTURE'
      ? img.parentElement
      : (img.closest ? img.closest('picture') : null);
    if (pic) {
      const sources = pic.querySelectorAll('source[srcset]');
      for (const src of sources) {
        const best = U.pickLargestFromSrcset(src.getAttribute('srcset'));
        if (best) add(best, 'picture', false);
      }
    }

    // 懒加载属性
    for (const attr of LAZY_ATTRS) {
      const v = img.getAttribute(attr);
      if (!v) continue;
      if (/srcset|set$/i.test(attr)) {
        const best = U.pickLargestFromSrcset(v);
        if (best) add(best, 'lazy', false);
      } else {
        add(v, 'lazy', false);
      }
    }
  }

  function collectImgs(push) {
    const imgs = document.images;
    for (let i = 0; i < imgs.length; i++) collectFromImg(imgs[i], push);
  }

  /* --------------------------- 背景图 --------------------------- */

  /* 背景图扫描最多遍历多少个元素。每个元素都要 getBoundingClientRect() +
     getComputedStyle()（强制布局 + 强制样式重算），开销随 DOM 元素数线性增长，
     在超大型页面上会成为扫描的主要耗时，所以必须有上限。
     超限不是「静默丢弃」—— 截断情况会随扫描结果一起上报，界面会告诉用户（P2-3）。 */
  const BG_ELEMENT_LIMIT = 8000;

  function collectBackgrounds(push, opts) {
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    const limit = Math.min(all.length, opts.maxElements || BG_ELEMENT_LIMIT);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (SKIP_TAGS[el.tagName]) continue;

      let rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
      if (rect.width < 24 || rect.height < 24) continue;

      let bg = '';
      try { bg = getComputedStyle(el).backgroundImage; } catch (e) { continue; }

      if (bg && bg !== 'none' && bg.indexOf('url(') >= 0) {
        for (const raw of U.extractCssUrls(bg)) {
          push(raw, {
            source: 'bg',
            element: el,
            displayWidth: Math.round(rect.width),
            displayHeight: Math.round(rect.height)
          });
        }
      }

      if (opts.scanPseudo && rect.width >= 48 && rect.height >= 48) {
        for (const pseudo of ['::before', '::after']) {
          let pbg = '';
          try { pbg = getComputedStyle(el, pseudo).backgroundImage; } catch (e) { continue; }
          if (!pbg || pbg === 'none' || pbg.indexOf('url(') < 0) continue;
          for (const raw of U.extractCssUrls(pbg)) {
            push(raw, {
              source: 'pseudo',
              element: el,
              displayWidth: Math.round(rect.width),
              displayHeight: Math.round(rect.height)
            });
          }
        }
      }
    }
    return { total: all.length, scanned: limit };
  }

  /* --------------------------- poster --------------------------- */

  function collectPosters(push) {
    const videos = document.querySelectorAll('video[poster]');
    for (const v of videos) {
      const poster = v.getAttribute('poster');
      if (!poster) continue;
      const rect = v.getBoundingClientRect();
      push(poster, {
        source: 'poster',
        element: v,
        displayWidth: Math.round(rect.width),
        displayHeight: Math.round(rect.height)
      });
    }
  }

  /* --------------------------- 内联 SVG --------------------------- */

  function collectSvg(push) {
    const svgs = document.querySelectorAll('svg');
    for (const svg of svgs) {
      let rect;
      try { rect = svg.getBoundingClientRect(); } catch (e) { continue; }
      if (rect.width < 48 || rect.height < 48) continue;
      try {
        const clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(rect.width)));
        if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(rect.height)));
        const str = new XMLSerializer().serializeToString(clone);
        if (str.length > 300000) continue;
        const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
        push(dataUrl, {
          source: 'svg',
          element: svg,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          displayWidth: Math.round(rect.width),
          displayHeight: Math.round(rect.height)
        });
      } catch (e) { /* ignore */ }
    }
  }

  /* --------------------------- 链接图片 --------------------------- */

  function collectLinks(push) {
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#')) continue;
      const abs = U.absUrl(href, document.baseURI);
      if (!abs || U.isDataUrl(abs) || U.isBlobUrl(abs)) continue;
      if (!U.extFromUrl(abs)) continue;   // 必须是明确的图片扩展名，避免误收
      const rect = a.getBoundingClientRect();
      push(abs, {
        source: 'link',
        element: a,
        displayWidth: Math.round(rect.width),
        displayHeight: Math.round(rect.height)
      });
    }
  }

  /* --------------------------- preload / og --------------------------- */

  function collectHeadHints(push, opts) {
    if (opts.scanPreload) {
      const preloads = document.querySelectorAll('link[rel~="preload"][as="image"]');
      for (const link of preloads) {
        const href = link.getAttribute('href');
        if (href) push(href, { source: 'preload', element: link });
        const isrcset = link.getAttribute('imagesrcset');
        if (isrcset) {
          const best = U.pickLargestFromSrcset(isrcset);
          if (best) push(best, { source: 'preload', element: link });
        }
      }
      const imageSrc = document.querySelectorAll('link[rel="image_src"]');
      for (const link of imageSrc) {
        const href = link.getAttribute('href');
        if (href) push(href, { source: 'preload', element: link });
      }
    }

    if (opts.scanOg) {
      const metas = document.querySelectorAll(
        'meta[property="og:image"],meta[property="og:image:secure_url"],' +
        'meta[name="og:image"],meta[name="twitter:image"],meta[property="twitter:image"]'
      );
      for (const m of metas) {
        const content = m.getAttribute('content');
        if (content) push(content, { source: 'og', element: null });
      }
    }
  }

  /* ==================================================================== *
   * 原图还原
   * ==================================================================== */

  /**
   * 依据内置规则 + 用户自定义规则，生成原图候选 URL。
   *
   * 实现已搬到 shared/constants.js —— 图库页要用同一个函数来判断
   * 「这张卡片值不值得显示『还原』按钮」，两边必须是同一套规则，
   * 否则会出现「按钮显示得出来、点了却一个候选都没有」的错位。
   *
   * @returns {Array<{url:string, ruleId:string}>}
   */
  const buildRestoreCandidates = C.buildRestoreCandidates;

  /**
   * 判断 b 是否是 a 的「同资源、但去掉了图片处理参数」的版本。
   *
   * 场景：`x.jpg?x-bce-process=image/format,f_avif` —— CDN 会返回 AVIF 转码版，
   * 像素尺寸与原图完全相同（所以面积比较分不出高下），但体积可能只有原图的 1/10，
   * 而且 Chrome 会按真实 MIME 把落盘文件名改成 .avif。
   * 这种「同尺寸但更干净」的候选必须采纳，否则永远拿不到真正的原图。
   */
  function isCleanerVariant(fromUrl, toUrl) {
    try {
      const a = new URL(fromUrl);
      const b = new URL(toUrl);
      if (a.origin !== b.origin) return false;
      if (a.pathname !== b.pathname) return false;
      if (b.search) return false;     // 目标必须已经不含任何查询参数
      return !!a.search;              // 源必须原本带查询参数
    } catch (e) {
      return false;
    }
  }

  /**
   * 尝试为一张图片找到更大的原图
   *
   * @param {object} cand  至少要有 url（width/height 用于「是否确实更大」的判断）
   * @param {object} settings
   * @param {object} [opts]
   * @param {boolean} [opts.refresh]
   *        忽略已缓存的探测结果，对候选地址重新探测一次。
   *
   *        **「单张重试」必须带上它**：probeSize 会把失败结果（null）也缓存起来
   *        （避免同一个坏地址被反复重试），所以上一次因探测超时 / 网络抖动而失败的
   *        候选，重试时会直接命中缓存里的「失败」，按钮点了等于没点。
   *        只清 sizeCache、**不清 inflight** —— 正在飞的探测直接复用它更划算，
   *        也避免同一个地址被同时请求两次。
   *
   * @returns {Promise<{url,w,h,area,ruleId}|null>}
   */
  async function tryRestore(cand, settings, opts) {
    const candidates = buildRestoreCandidates(cand.url, settings);
    if (!candidates.length) return null;

    if (opts && opts.refresh) {
      for (const c2 of candidates) sizeCache.delete(c2.url);
    }

    const timeout = settings.probeTimeout || 4000;
    const conc = settings.probeConcurrency || 6;

    const results = await Promise.all(candidates.map(async (cand2) => {
      const sz = await probeLimited(cand2.url, timeout, conc);
      if (!sz) return null;
      return { url: cand2.url, ruleId: cand2.ruleId, w: sz.w, h: sz.h, area: sz.w * sz.h };
    }));

    const ok = results.filter(Boolean).sort((a, b) => b.area - a.area);
    if (!ok.length) return null;

    const best = ok[0];
    const curArea = (cand.width || 0) * (cand.height || 0);

    // 关键保护：默认只有确实更大才替换；尺寸未知时也接受（至少说明能加载）
    // 例外：像素尺寸完全相同、但去掉了图片处理参数的干净 URL 也采纳 ——
    // 此时拿到的是未被转码压缩的原图，体积和格式都更正确。
    const strictlyBigger = curArea <= 0 || best.area > curArea;
    const sameButCleaner = curArea > 0 && best.area === curArea &&
      isCleanerVariant(cand.url, best.url);
    if (!strictlyBigger && !sameButCleaner) return null;
    if (best.area < 4096) return null;   // 太小的结果不可信

    return best;
  }

  /* ==================================================================== *
   * 主扫描
   * ==================================================================== */

  /**
   * 还原之后，多个缩略图可能被还原成同一个原图地址，这里再合并一次
   * 保留面积最大的一条，并补齐来源 / 元素 / 顺序等元信息
   */
  function dedupeByUrl(list) {
    const merged = new Map();
    for (const c of list) {
      const key = U.normalizeUrl(c.url);
      const prev = merged.get(key);
      if (!prev) {
        c.key = key;
        merged.set(key, c);
        continue;
      }
      const prevArea = (prev.width || 0) * (prev.height || 0);
      const curArea = (c.width || 0) * (c.height || 0);
      const winner = curArea > prevArea ? c : prev;
      const loser = winner === c ? prev : c;

      if (!winner.element && loser.element) winner.element = loser.element;
      if (!winner.displayUrl && loser.displayUrl) winner.displayUrl = loser.displayUrl;
      if (!winner.restored && loser.restored) {
        winner.restored = true;
        winner.restoreRule = loser.restoreRule;
        winner.restoredFrom = loser.restoredFrom;
      }
      if (!winner.alt && loser.alt) winner.alt = loser.alt;
      winner.order = Math.min(prev.order, c.order);
      winner.displayWidth = Math.max(prev.displayWidth || 0, c.displayWidth || 0);
      winner.displayHeight = Math.max(prev.displayHeight || 0, c.displayHeight || 0);
      winner.allSources = Array.from(new Set(
        (prev.allSources || []).concat(c.allSources || [])
      ));
      winner.key = key;
      merged.set(key, winner);
    }
    return Array.from(merged.values());
  }

  /**
   * 最近一次 scan() 的统计信息。
   *
   * 存在的意义是「不静默丢东西」：背景图扫描有元素数上限，
   * 撞上上限时用户应该知道，而不是以为看到的就是全部。
   * scan() 是数组返回，加字段会牵动 background / popup 的整条链路，
   * 所以统计单独走一个取值函数，由 content/main.js 一并塞进 SCAN_RESULT。
   */
  let lastScanStats = null;

  /** 重建主键：规范化 URL 的稳定哈希。图库拿它当勾选状态 / 去重的主键，跨扫描必须一致 */
  function assignIds(list) {
    for (const c of list) {
      c.key = U.normalizeUrl(c.url);
      c.id = U.quickHash(c.key);
    }
    return list;
  }

  /** 过滤（有效性）→ 排序（文档顺序）→ 重建主键。中间结果与最终结果共用同一套口径，
      否则「先看到的图」和「最终拿到的图」顺序 / 有效性都会不一致。 */
  function prefilter(list, settings) {
    const out = list.filter((c) => isValidCandidate(c, settings));
    out.sort((a, b) => a.order - b.order);
    return assignIds(out);
  }

  /** 候选对象 → 可跨消息传递的普通对象 */
  function toWireList(list) {
    return list.map((c) => toWire(c));
  }

  /* 原图还原的全局并发上限与时间预算。
     还原要给每张候选发一次真实加载请求，冷加载时这一步是整轮扫描的主要耗时；
     不限流的话 N 张图 × 6 条规则会一次性打出几百个请求，既拖慢自己，
     也容易把后台的等待判据拖爆（历史上就是这么「偶尔识别不到图片」的）。 */
  const RESTORE_CONCURRENCY = 8;
  const RESTORE_TIME_BUDGET = 8000;

  /**
   * 采集阶段：把当前 DOM 里所有能找到的图片收进一个列表。
   *
   * **只采集，不联网** —— 不补尺寸、不还原。拆出来是为了让「深度嗅探」能
   * 反复调用它（滚动一屏采一次），最后只对合并结果做一次联网加工。
   *
   * @returns {{list: Array, stats: object}}
   */
  function collectAll(settings) {
    const { map, push } = createCollector();
    const stats = {
      bgElements: 0, bgScanned: 0, bgTruncated: false,
      restoreTruncated: false,
      // 深度嗅探撞上轮数 / 时间预算（普通扫描永远是 false）
      deepTruncated: false
    };

    try {
      if (settings.scanImg !== false) collectImgs(push);
      if (settings.scanBackground) {
        const r = collectBackgrounds(push, { scanPseudo: settings.scanPseudo !== false });
        stats.bgElements = r.total;
        stats.bgScanned = r.scanned;
        stats.bgTruncated = r.total > r.scanned;
        if (stats.bgTruncated) {
          console.info('[ImageHunter] 页面元素过多（' + r.total + ' 个），'
            + '背景图扫描只覆盖前 ' + r.scanned + ' 个');
        }
      }
      if (settings.scanPoster) collectPosters(push);
      if (settings.scanSvg) collectSvg(push);
      if (settings.scanLinks) collectLinks(push);
      collectHeadHints(push, {
        scanPreload: settings.scanPreload !== false,
        scanOg: settings.scanOg !== false
      });
    } catch (e) {
      console.warn('[ImageHunter] 采集阶段异常', e);
    }
    lastScanStats = stats;

    return { list: Array.from(map.values()), stats };
  }

  /**
   * 加工阶段：回报中间结果 → 补尺寸 → 原图还原 → 过滤排序。
   *
   * 中间结果**排在最前面**是有意的（理由见函数体里第 0 步的注释）：
   * 它是后台「这次扫描还活着」的第一个证据，必须只依赖纯 DOM 采集。
   *
   * @param {Array} list  采集到的候选
   * @param {object} stats 采集统计（会被就地补充 restoreTruncated）
   * @param {object} settings
   * @param {(early: Array) => void} [onPartial] 补尺寸之前的中间结果回调
   * @returns {Promise<Array>}
   */
  async function finishList(list, stats, settings, onPartial) {
    const st = stats || {};
    const conc = settings.probeConcurrency || 6;
    const timeout = settings.probeTimeout || 4000;

    /* 0) 先把「页面上已经看到的候选」交出去 —— 这一步**必须排在补尺寸之前**。
       补尺寸只能靠真实加载，页面自己还没加载的图（懒加载、首屏之外）就得等网络，
       慢起来没有上限（每张 probeTimeout，并发只有 probeConcurrency）。
       而「先出图」的全部意义就是别让用户对着加载动画等网络。

       实测过的代价：真实站点上十几张「还没加载的图」就足以把首次回报推迟到 4 秒以上，
       而后台的「内容脚本没动静」判据正是 4 秒 —— 于是首次点开图标经常一张图都看不到，
       刷新一次反而好了（第二次探测结果已经在缓存里）。所以首次回报的耗时
       必须由**采集**（纯 DOM 操作，快且可控）决定，不能由联网步骤决定。

       尺寸未知的候选照常出现在结果里：图库对「尺寸未知」是刻意放行的
       （见 popup.js 的尺寸筛选），补完尺寸的最终结果随后原地替换。 */
    if (typeof onPartial === 'function' && list.length) {
      try { onPartial(toWireList(prefilter(list, settings))); } catch (e) {
        console.warn('[ImageHunter] 中间结果回报失败', e);
      }
    }

    // 1) 补齐未知尺寸（限流 + 缓存）
    const unknown = list.filter((c) => !c.width || !c.height);
    await Promise.all(unknown.map((c) => probeLimited(c.url, timeout, conc).then((sz) => {
      if (sz) { c.width = sz.w; c.height = sz.h; }
    })));

    // 2) 原图还原（全局限流 + 时间预算）
    if (settings.restoreOriginal !== false && list.length) {
      const budget = settings.restoreBudget || RESTORE_TIME_BUDGET;
      const finished = await withinBudget(
        mapWithLimit(list, settings.restoreConcurrency || RESTORE_CONCURRENCY, async (c) => {
          const better = await tryRestore(c, settings);
          if (better) {
            c.restoredFrom = c.url;
            c.url = better.url;
            c.width = better.w;
            c.height = better.h;
            c.restored = true;
            c.restoreRule = better.ruleId || 'builtin';
          }
        }),
        budget
      );
      if (!finished) {
        // 按文档顺序推进，所以超预算时牺牲的一定是靠后的图片 —— 结果是可预期的
        st.restoreTruncated = true;
        console.info('[ImageHunter] 原图还原超过 ' + budget + 'ms 预算，'
          + '未完成的图片保持原始地址');
      }
      // 还原后可能撞车，重新合并
      list = dedupeByUrl(list);
    }

    // 3) 过滤 + 排序 + 重建主键（与中间结果同一套口径）
    return prefilter(list, settings);
  }

  /**
   * 扫描当前文档中的所有图片
   * @param {object} [overrides] 覆盖设置
   * @param {(early: Array) => void} [onPartial]
   *        补尺寸与还原之前的中间结果回调（已过滤、已排序、已带主键，
   *        但**尺寸可能还没补齐、也没还原**）。
   *        调用方拿它先回报一版结果，避免「联网步骤卡住 → 一张图都看不到」。
   * @returns {Promise<Array>} 候选图片列表
   */
  async function scan(overrides, onPartial) {
    const settings = Object.assign({}, IH.Store.getSettings(), overrides || {});
    const { list, stats } = collectAll(settings);
    return finishList(list, stats, settings, onPartial);
  }

  /* ==================================================================== *
   * 深度嗅探（无限滚动 / 分页加载的站点）
   * ==================================================================== */

  /* 每滚一屏后等多久让新内容落地；最多滚几屏；整轮的时间预算 */
  const DEEP_ROUND_DELAY = 600;
  const DEEP_MAX_ROUNDS = 20;
  const DEEP_TIME_BUDGET = 25000;
  /* 连续几轮没采集到新图就认为到底了。
     不能取 1：有些站点要滚两三屏才触发下一批，中间那几屏天然「没有新图」。
     取 3 是「容忍两屏空滚」的余量 —— 每轮都要多花 600ms，不值得再放大。 */
  const DEEP_IDLE_ROUNDS = 3;
  /* 已经滚到文档底部后，再确认几轮（有些站点到底才触发追加） */
  const DEEP_BOTTOM_ROUNDS = 2;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 页面滚动的当前状态。
   *
   * 只用 window 级滚动：内层容器滚动的站点（少数）不适用，
   * 但那种情况普通嗅探本来也拿不到被容器裁掉的内容，不会更糟。
   */
  function scrollMetrics() {
    const de = document.documentElement;
    const body = document.body;
    const viewport = window.innerHeight || (de && de.clientHeight) || 800;
    const height = Math.max(
      (de && de.scrollHeight) || 0,
      (body && body.scrollHeight) || 0
    );
    const y = window.scrollY || window.pageYOffset || (de && de.scrollTop) || 0;
    return { y, viewport, height };
  }

  function atBottom() {
    const m = scrollMetrics();
    // 留 4px 容差：缩放、亚像素布局都会让「到底」差一点点
    return m.height > 0 && m.y + m.viewport >= m.height - 4;
  }

  function scrollOneScreen() {
    const m = scrollMetrics();
    const dy = Math.max(1, Math.floor(m.viewport * 0.9));
    try {
      if (typeof window.scrollBy === 'function') window.scrollBy(0, dy);
      else window.scrollTo(0, m.y + dy);
    } catch (e) { /* 页面禁止滚动时忽略 */ }
  }

  function restoreScroll(y) {
    try {
      window.scrollTo(0, y);
    } catch (e) { /* ignore */ }
  }

  /**
   * 深度嗅探：滚动整页、边滚边采集，最后只对合并结果做一次加工。
   *
   * 为什么需要它：`collectAll` 只看**此刻存在**的 DOM。无限滚动的站点
   * （微博、Pinterest、电商瀑布流）要滚到底才加载下一批，普通嗅探只能拿到首屏。
   *
   * @param {object} [overrides] 覆盖设置
   * @param {({round:number,total:number,added:number}) => void} [onProgress]
   *        每轮采集后回调一次，用来把进度实时送到界面上（否则整页滚动期间
   *        用户只能盯着加载动画，会以为卡死了）。
   * @param {(early: Array) => void} [onPartial] 同 scan()
   * @returns {Promise<Array>}
   */
  async function deepScan(overrides, onProgress, onPartial) {
    const settings = Object.assign({}, IH.Store.getSettings(), overrides || {});
    const acc = new Map();          // key（规范化 URL）→ 候选，跨轮合并去重
    const startY = scrollMetrics().y;
    const t0 = Date.now();

    // 这三个走 overrides 通道（不暴露在设置页）：测试要把轮间延迟压到毫秒级，
    // 否则一条用例光等滚动就要好几秒
    const roundDelay = settings.deepRoundDelay || DEEP_ROUND_DELAY;
    const maxRounds = settings.deepMaxRounds || DEEP_MAX_ROUNDS;
    const timeBudget = settings.deepTimeBudget || DEEP_TIME_BUDGET;

    let stats = null;
    let round = 0;
    let idleRounds = 0;
    let bottomRounds = 0;

    while (true) {
      const r = collectAll(settings);
      stats = r.stats;

      const before = acc.size;
      for (const c of r.list) {
        if (acc.has(c.key)) continue;
        // 每轮的 order 都从 0 重新数，合并时要接着上一轮排，
        // 否则排序会变成「后一轮的图反而更靠前」
        c.order = acc.size;
        acc.set(c.key, c);
      }
      const added = acc.size - before;

      if (typeof onProgress === 'function') {
        try { onProgress({ round, total: acc.size, added }); } catch (e) { /* ignore */ }
      }

      if (added === 0) idleRounds++;
      else idleRounds = 0;

      const elapsed = Date.now() - t0;
      const outOfBudget = round >= maxRounds || elapsed > timeBudget;
      if (idleRounds >= DEEP_IDLE_ROUNDS || outOfBudget) break;

      if (atBottom()) {
        bottomRounds++;
        if (bottomRounds >= DEEP_BOTTOM_ROUNDS) break;
      }

      scrollOneScreen();
      await sleep(roundDelay);
      round++;
    }

    // 不是「滚到底 / 连续几轮没有新图」而停下，而是撞上了轮数或时间预算 ——
    // 说明页面里很可能还有没采到的图片，要如实告诉用户
    if (stats && idleRounds < DEEP_IDLE_ROUNDS) stats.deepTruncated = true;

    // 滚动位置必须复原 —— 这是别人的页面，我们没有理由把它滚乱
    restoreScroll(startY);

    return finishList(Array.from(acc.values()), stats, settings, onPartial);
  }

  function isValidCandidate(c, settings) {
    if (!c.url) return false;

    // 1x1 / 极小追踪像素
    if (c.width && c.height && c.width <= 2 && c.height <= 2) return false;

    if (U.isDataUrl(c.url)) return /^data:image\//i.test(c.url);
    if (U.isBlobUrl(c.url)) return true;

    // 有真实尺寸，或扩展名/形态像图片
    if (c.width > 0 && c.height > 0) return true;
    return U.isProbablyImageUrl(c.url);
  }

  /* ==================================================================== *
   * 单元素解析（悬停图标 / 右键菜单 使用）
   * ==================================================================== */

  /**
   * 找到事件目标对应的可保存图片元素
   * @returns {{el: Element, kind: string}|null}
   */
  function findSaveTarget(node) {
    if (!node || node.nodeType !== 1) return null;

    // 1) 向上找 <img> / <video poster>
    let el = node;
    let depth = 0;
    while (el && el.nodeType === 1 && depth < 8) {
      if (el.tagName === 'IMG') return { el, kind: 'img' };
      if (el.tagName === 'VIDEO' && el.getAttribute('poster')) return { el, kind: 'poster' };
      if (el.tagName === 'SVG') return { el, kind: 'svg' };
      el = el.parentElement;
      depth++;
    }

    // 2) 背景图
    el = node;
    depth = 0;
    while (el && el.nodeType === 1 && depth < 4) {
      try {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none' && bg.indexOf('url(') >= 0) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 64 && rect.height >= 64) return { el, kind: 'bg' };
        }
      } catch (e) { /* ignore */ }
      el = el.parentElement;
      depth++;
    }

    return null;
  }

  /** 为一个元素收集候选并返回最优（面积最大）的一张 */
  async function resolveForElement(el, overrides) {
    const settings = Object.assign({}, IH.Store.getSettings(), overrides || {});
    const { map, push } = createCollector();

    const tag = el.tagName;
    try {
      if (tag === 'IMG') collectFromImg(el, push);
      else if (tag === 'VIDEO') {
        const poster = el.getAttribute('poster');
        if (poster) push(poster, { source: 'poster', element: el });
      } else if (tag === 'SVG') {
        collectSvgSingle(el, push);
      } else if (tag === 'A') {
        const href = el.getAttribute('href');
        if (href) push(href, { source: 'link', element: el });
      } else {
        // 背景图元素
        try {
          const bg = getComputedStyle(el).backgroundImage;
          for (const raw of U.extractCssUrls(bg)) push(raw, { source: 'bg', element: el });
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.warn('[ImageHunter] 元素解析异常', e);
    }

    const list = Array.from(map.values());
    if (!list.length) return null;

    const conc = settings.probeConcurrency || 6;
    const timeout = settings.probeTimeout || 4000;

    // 补齐尺寸
    await Promise.all(list.map((c) => {
      if (c.width && c.height) return null;
      return probeLimited(c.url, timeout, conc).then((sz) => {
        if (sz) { c.width = sz.w; c.height = sz.h; }
      });
    }));

    // 原图还原
    if (settings.restoreOriginal !== false) {
      await Promise.all(list.map(async (c) => {
        const better = await tryRestore(c, settings);
        if (better) {
          c.restoredFrom = c.url;
          c.url = better.url;
          c.width = better.w;
          c.height = better.h;
          c.restored = true;
          c.restoreRule = better.ruleId || 'builtin';
        }
      }));
    }

    const valid = dedupeByUrl(list).filter((c) => isValidCandidate(c, settings));
    if (!valid.length) return null;

    // 取面积最大的一张
    valid.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const best = valid[0];
    best.key = U.normalizeUrl(best.url);
    best.id = U.quickHash(best.key);
    return best;
  }

  function collectSvgSingle(svg, push) {
    let rect;
    try { rect = svg.getBoundingClientRect(); } catch (e) { rect = { width: 0, height: 0 }; }
    try {
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(rect.width) || 300));
      if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(rect.height) || 300));
      const str = new XMLSerializer().serializeToString(clone);
      push('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str), {
        source: 'svg',
        element: svg,
        width: Math.round(rect.width) || 300,
        height: Math.round(rect.height) || 300,
        displayWidth: Math.round(rect.width),
        displayHeight: Math.round(rect.height)
      });
    } catch (e) { /* ignore */ }
  }

  /* ==================================================================== *
   * 序列化（DOM 元素无法跨消息传递）
   * ==================================================================== */

  function toWire(c) {
    if (!c) return null;
    return {
      id: c.id,
      url: c.url,
      displayUrl: c.displayUrl,
      source: c.source,
      allSources: c.allSources,
      width: c.width,
      height: c.height,
      displayWidth: c.displayWidth,
      displayHeight: c.displayHeight,
      alt: c.alt,
      order: c.order,
      restored: c.restored,
      restoreRule: c.restoreRule,
      restoredFrom: c.restoredFrom || null,
      sizeBytes: c.sizeBytes || null,
      type: U.extFromUrl(c.url) || '',
      host: U.prettyHost(c.url)
    };
  }

  /* ==================================================================== *
   * 导出
   * ==================================================================== */

  IH.Scanner = {
    scan,
    deepScan,
    collectAll,
    resolveForElement,
    findSaveTarget,
    probeSize,
    probeLimited,
    tryRestore,
    toWire,
    lastScanStats: () => lastScanStats,
    clearSizeCache() { sizeCache.clear(); inflight.clear(); }
  };
})();
