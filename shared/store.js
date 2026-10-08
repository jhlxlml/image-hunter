/* ==========================================================================
 * ImageHunter — shared/store.js
 * chrome.storage 封装：设置 / 下载历史 / 已下载指纹
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.Store) return;

  const C = IH.C;
  const K = C.STORAGE_KEYS;

  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  /* 设置的内存缓存，供 content script 同步读取 */
  let settingsCache = withDefaults(null);
  let loaded = false;
  let loadPromise = null;
  const listeners = new Set();

  /**
   * 合并默认设置，并保证数组型字段（customRules / blockedHosts）是**独立副本**。
   * Object.assign 是浅拷贝 —— 直接合并的话，所有 settingsCache 会共享
   * DEFAULT_SETTINGS 里的同一个数组，任何就地修改都会污染默认值。
   */
  function withDefaults(stored) {
    const s = Object.assign({}, C.DEFAULT_SETTINGS, stored || {});
    s.customRules = Array.isArray(s.customRules)
      ? s.customRules.filter((r) => r && typeof r === 'object').slice()
      : [];
    s.blockedHosts = Array.isArray(s.blockedHosts)
      ? s.blockedHosts.filter((h) => typeof h === 'string' && h.trim()).slice()
      : [];
    return s;
  }

  function area() { return chrome.storage.local; }

  async function rawGet(key, fallback) {
    if (!hasStorage) return fallback;
    try {
      const obj = await area().get(key);
      return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
    } catch (e) {
      return fallback;
    }
  }

  async function rawSet(key, value) {
    if (!hasStorage) return;
    try {
      await area().set({ [key]: value });
    } catch (e) {
      /* 配额超限等异常静默处理，避免打断主流程 */
      console.warn('[ImageHunter] storage.set 失败', e);
    }
  }

  /* ------------------------------------------------------------------ *
   * 写串行化
   *
   * chrome.storage.local 是**异步 IPC**，任何「读全量 → 内存改 → 整体写回」
   * 的写法在 await 期间都会被其它任务插入，后写的直接覆盖先写的。
   * 下载队列默认 concurrency=3，多个 runTask 同时收尾就会撞上：
   *   实测 5 次并发 addHistory 只落 1 条，addFingerprints 只落 1 个，
   *   bumpStats({saved:1,bytes:100}) × 5 最终只有 saved=1 / bytes=100。
   * 后果是历史缺失、统计偏低、指纹丢失导致「跳过已下载」失效。
   *
   * 这里把所有写操作串成一条链，让它们严格按调用顺序执行。
   * ------------------------------------------------------------------ */

  let writeChain = Promise.resolve();

  function serialize(fn) {
    const run = writeChain.then(fn, fn);
    // 吞掉失败，避免一次异常把整条链卡死（真正的错误由 run 返回给调用方）
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  /* 写入代数：每有一次设置写入落地就 +1。
     用来解决「读的期间有人写了」这个反向竞态 ——
     见 loadSettings 里的说明。 */
  let writeGen = 0;

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */

  async function loadSettings(force) {
    if (loaded && !force) return settingsCache;
    if (loadPromise && !force) return loadPromise;
    loadPromise = (async () => {
      const gen = writeGen;
      const stored = await rawGet(K.SETTINGS, {});
      /* 读的**期间**有写入落地了（用户保存设置 / storage.onChanged 从别的
         上下文同步过来），那就不能拿刚读到的旧值去盖新的。

         这是「读-改-写」竞态的镜像版本：那边是丢写入，这边是**丢读取的时效性**。
         SW 冷启动时最容易撞上 —— bootstrap() 的 loadSettings 还挂在 storage.get 上，
         此时 options 页写了一次设置，onChanged 把缓存更新成了新值，
         接着那个迟到的 get 一 resolve 就把新值盖回旧的，而且因为 loaded 已经是 true，
         之后再也没有机会纠正。表现为「设置明明保存了，扩展却按旧设置跑」。 */
      if (gen !== writeGen) return settingsCache;
      settingsCache = withDefaults(stored);
      loaded = true;
      return settingsCache;
    })();
    return loadPromise;
  }

  function getSettings() {
    return settingsCache;
  }

  function updateSettings(patch) {
    return serialize(async () => {
      await loadSettings();
      settingsCache = Object.assign({}, settingsCache, patch || {});
      loaded = true;
      writeGen++;
      await rawSet(K.SETTINGS, settingsCache);
      emit({ type: 'settings', settings: settingsCache });
      return settingsCache;
    });
  }

  function resetSettings() {
    return serialize(async () => {
      settingsCache = withDefaults(null);
      loaded = true;
      writeGen++;
      await rawSet(K.SETTINGS, settingsCache);
      emit({ type: 'settings', settings: settingsCache });
      return settingsCache;
    });
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function emit(payload) {
    for (const cb of Array.from(listeners)) {
      try { cb(payload); } catch (e) { /* ignore */ }
    }
  }

  /* 跨上下文同步：storage.onChanged */
  if (hasStorage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[K.SETTINGS]) {
        const next = changes[K.SETTINGS].newValue || {};
        settingsCache = withDefaults(next);
        loaded = true;
        // 外部写入同样要作废「正在进行中的读」—— 否则那个迟到的读
        // 会把刚同步过来的新值盖回旧的（见 loadSettings 里的说明）
        writeGen++;
        emit({ type: 'settings', settings: settingsCache });
      }
      if (changes[K.HISTORY]) emit({ type: 'history' });
      if (changes[K.FINGERPRINTS]) emit({ type: 'fingerprints' });
    });
  }

  /* ------------------------------------------------------------------ *
   * 下载历史
   * ------------------------------------------------------------------ */

  function addHistory(entries) {
    return serialize(async () => {
      const list = Array.isArray(entries) ? entries : [entries];
      const prev = await rawGet(K.HISTORY, []);
      const next = list.concat(prev).slice(0, C.HISTORY_LIMIT);
      await rawSet(K.HISTORY, next);
      return next;
    });
  }

  async function getHistory() {
    return await rawGet(K.HISTORY, []);
  }

  function clearHistory() {
    return serialize(async () => {
      await rawSet(K.HISTORY, []);
      emit({ type: 'history' });
    });
  }

  /* ------------------------------------------------------------------ *
   * 已下载指纹（用于「跳过已下载」）
   * 结构：{ [fingerprint]: timestamp }
   * ------------------------------------------------------------------ */

  async function getFingerprintMap() {
    return await rawGet(K.FINGERPRINTS, {});
  }

  async function hasFingerprint(fp) {
    const map = await getFingerprintMap();
    return !!map[fp];
  }

  async function hasFingerprints(list) {
    const map = await getFingerprintMap();
    const out = {};
    for (const fp of list) out[fp] = !!map[fp];
    return out;
  }

  function addFingerprints(list) {
    return serialize(async () => {
      const map = await getFingerprintMap();
      const now = Date.now();
      for (const fp of list) map[fp] = now;
      // 控制体积：超出上限时按时间淘汰最旧的
      const keys = Object.keys(map);
      if (keys.length > C.FINGERPRINT_LIMIT) {
        keys.sort((a, b) => map[a] - map[b]);
        const drop = keys.length - C.FINGERPRINT_LIMIT;
        for (let i = 0; i < drop; i++) delete map[keys[i]];
      }
      await rawSet(K.FINGERPRINTS, map);
      return map;
    });
  }

  function clearFingerprints() {
    return serialize(async () => {
      await rawSet(K.FINGERPRINTS, {});
      emit({ type: 'fingerprints' });
    });
  }

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */

  const DEFAULT_STATS = { saved: 0, failed: 0, skipped: 0, bytes: 0 };

  async function getStats() {
    return Object.assign({}, DEFAULT_STATS, await rawGet(K.STATS, {}));
  }

  function bumpStats(patch) {
    return serialize(async () => {
      const cur = await getStats();
      for (const k in patch) {
        if (typeof patch[k] === 'number') cur[k] = (cur[k] || 0) + patch[k];
      }
      await rawSet(K.STATS, cur);
      return cur;
    });
  }

  function resetStats() {
    return serialize(async () => {
      await rawSet(K.STATS, Object.assign({}, DEFAULT_STATS));
      return getStats();
    });
  }

  IH.Store = {
    loadSettings,
    getSettings,
    updateSettings,
    resetSettings,
    onChange,
    addHistory,
    getHistory,
    clearHistory,
    getFingerprintMap,
    hasFingerprint,
    hasFingerprints,
    addFingerprints,
    clearFingerprints,
    getStats,
    bumpStats,
    resetStats
  };
})();
