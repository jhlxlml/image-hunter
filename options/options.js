/* ==========================================================================
 * ImageHunter — options/options.js
 * ========================================================================== */
(function () {
  'use strict';

  const IH = globalThis.IH;
  const C = IH.C;
  const U = IH.U;
  const Store = IH.Store;
  const MSG = C.MSG;
  const I18n = IH.I18n;
  const t = (k, a) => I18n.t(k, a);

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  let settings = {};
  let saveTimer = null;

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(text, kind) {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2400);
  }

  function flashSaved() {
    const el = $('saveState');
    el.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  /* ------------------------------------------------------------------ *
   * 主题
   * ------------------------------------------------------------------ */

  function applyTheme(theme) {
    let t = theme || 'light';
    if (t === 'auto') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
    $$('#segTheme button').forEach((b) => b.classList.toggle('active', b.dataset.v === theme));
  }

  /* ------------------------------------------------------------------ *
   * 界面语言
   *
   * 切换之后要做三件事，少一件界面就会中英混着：
   *   1. 重填 HTML 里的静态文案（I18n.apply 走 data-i18n）
   *   2. 重渲染**动态**内容 —— 内置规则名、自定义规则里的按钮、统计标签
   *      都嵌着文案，它们不在 data-i18n 里，apply 管不到
   *   3. 把当前选择高亮回 segLang
   * ------------------------------------------------------------------ */

  function applyLang() {
    const v = settings.uiLang || 'auto';
    $$('#segLang button').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  }

  /**
   * 页脚。版本号从 manifest 读，不写死 ——
   * 原来这里硬编码着 `v1.0.0`，而 manifest 早就走到 1.7.x，没人会记得改它。
   *
   * 必须单独成一个函数：它是**直接赋值**上去的（不走 data-i18n），
   * 所以切换语言时不重设的话，页脚会一直停在旧语言 —— 一整页英文里
   * 挂着一句中文，而截图看着毫无异样。
   */
  function renderFooter() {
    try {
      const m = chrome.runtime.getManifest();
      /* 版本号单独包一层 `<b id="ftrVersion">`（用 innerHTML 就是为了产出这个元素）：
         它是「版本确实从 manifest 读的、不是写死的 v—」的**可取到的锚点** ——
         tests/screenshot.js 就靠它做这项检查。只把版本本身转义，模板是我们自己写的。
         调用点有两处：init() 与 switchLang()（页脚是直接赋值，不走 data-i18n，
         只在 init 里设一次的话，切语言时它会纹丝不动）。 */
      $('ftrText').innerHTML = t('opt.footer', {
        version: '<b id="ftrVersion">v' + U.escapeHtml(m.version || '—') + '</b>'
      });
    } catch (e) { /* 拿不到就保持占位符，不编一个版本号出来 */ }
  }

  async function switchLang(v) {
    settings = (await I18n.setLang(v)) || settings;
    I18n.apply(document);
    applyLang();
    renderFooter();
    renderSettings();
    renderBuiltin();
    renderRules();
    flashSaved();
  }

  /* ------------------------------------------------------------------ *
   * 设置绑定
   * ------------------------------------------------------------------ */

  function renderSettings() {
    // 开关
    $$('input[type="checkbox"][data-key]').forEach((el) => {
      el.checked = !!settings[el.dataset.key];
    });

    // 滑块 / 数字
    $$('input[type="range"][data-key]').forEach((el) => {
      const v = settings[el.dataset.key];
      el.value = v != null ? v : el.min;
      updateOutput(el);
    });

    // 文本框
    $$('input[type="text"][data-key]').forEach((el) => {
      el.value = settings[el.dataset.key] != null ? settings[el.dataset.key] : '';
    });

    // 站点排除列表（多行文本框，一行一个域名）
    const bh = $('blockedHosts');
    if (bh) bh.value = (settings.blockedHosts || []).join('\n');
    renderBlockedNote();

    applyTheme(settings.theme);
  }

  /**
   * 站点排除列表的即时反馈。
   *
   * 输入过程中不**改写**用户敲的内容（光标会跳），只把「哪些行会被采纳」
   * 说出来；等失焦（change）时才把规范化后的结果回填。
   */
  function renderBlockedNote() {
    const el = $('blockedHosts');
    const note = $('blockedNote');
    if (!el || !note) return;

    const lines = el.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) {
      note.className = 'inline-note';
      note.textContent = t('opt.blockNoteEmpty');
      return;
    }

    const good = [];
    const bad = [];
    for (const line of lines) {
      const p = U.normalizeHostPattern(line);
      if (p) { if (good.indexOf(p) < 0) good.push(p); }
      else bad.push(line);
    }

    /* 列表本身是域名，中英文都一样，所以只有前后缀需要翻译；
       分隔符用 '、' 还是 ', ' 也跟着语言走。 */
    const sep = I18n.lang() === 'zh' ? '、' : ', ';
    note.className = 'inline-note' + (bad.length ? ' warn' : '');
    note.textContent = bad.length
      ? t('opt.blockNoteBad', { n: good.length, m: bad.length, list: bad.join(sep) })
      : t('opt.blockNoteOk', { n: good.length, list: good.join(sep) });
  }

  function updateOutput(el) {
    const out = document.querySelector('[data-out="' + el.dataset.key + '"]');
    if (!out) return;
    const key = el.dataset.key;
    const v = Number(el.value);
    if (key === 'probeTimeout') out.textContent = v + ' ms';
    else if (key === 'hoverDelay') out.textContent = v + ' ms';
    else if (key === 'minSize') out.textContent = v + ' px';
    else if (key === 'lightboxMinSize') out.textContent = v > 0 ? v + ' px' : t('cmn.noFilter');
    else if (key === 'concurrency') out.textContent = t('opt.unitImgs', { v });
    else if (key === 'retries') out.textContent = t('opt.unitTimes', { v });
    else out.textContent = String(v);
  }

  async function persist(patch) {
    settings = await Store.updateSettings(patch);
    flashSaved();
    // 通知内容脚本刷新设置
    try {
      const p = chrome.runtime.sendMessage({ type: MSG.SETTINGS_CHANGED });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function bindControls() {
    $$('input[type="checkbox"][data-key]').forEach((el) => {
      el.addEventListener('change', () => persist({ [el.dataset.key]: el.checked }));
    });

    $$('input[type="range"][data-key]').forEach((el) => {
      el.addEventListener('input', () => updateOutput(el));
      el.addEventListener('change', () => persist({ [el.dataset.key]: Number(el.value) }));
    });

    $$('input[type="text"][data-key]').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.dataset.key;
        persist({ [key]: el.value.trim() || C.DEFAULT_SETTINGS[key] });
      });
    });

    $$('#segTheme button').forEach((b) => {
      b.addEventListener('click', () => {
        applyTheme(b.dataset.v);
        persist({ theme: b.dataset.v });
      });
    });

    $$('#segLang button').forEach((b) => {
      b.addEventListener('click', () => { switchLang(b.dataset.v); });
    });

    // 站点排除列表：输入时就存（防抖），失焦时把规范化结果回填
    const bhEl = $('blockedHosts');
    if (bhEl) {
      const saveBlocked = async (normalizeText) => {
        // 换行 / 逗号 / 分号都当分隔符 —— 用户从别处粘一串域名时通常是逗号分隔的
        const list = U.sanitizeBlockedHosts(bhEl.value.split(/[\n,;]+/));
        await persist({ blockedHosts: list });
        if (normalizeText) {
          bhEl.value = list.join('\n');
          renderBlockedNote();
        }
      };
      const commitBlocked = U.debounce(() => saveBlocked(false), 700);
      bhEl.addEventListener('input', () => { renderBlockedNote(); commitBlocked(); });
      bhEl.addEventListener('change', () => saveBlocked(true));
    }

    $('btnReset').addEventListener('click', async () => {
      // 自定义还原规则与排除列表都会一起清掉，先把条数说清楚，别让用户白写
      const n = (settings.customRules || []).length;
      const b = (settings.blockedHosts || []).length;
      const extra = [];
      if (n) extra.push(t('opt.ruleCount', { n }));
      if (b) extra.push(t('opt.blockCount', { n: b }));
      const msg = extra.length
        ? t('opt.resetConfirm') + '\n\n' + t('opt.resetConfirmExtra', { extra: extra.join(t('cmn.and')) })
        : t('opt.resetConfirm');
      if (!confirm(msg)) return;
      settings = await Store.resetSettings();
      renderSettings();
      renderRules();
      toast(t('opt.restored'), 'ok');
    });

    $('btnShortcuts').addEventListener('click', () => {
      // tabs.create 返回 Promise，需要显式 catch，否则会冒出 Unchecked runtime.lastError
      try {
        const p = chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* ignore */ }
    });
  }

  /* ------------------------------------------------------------------ *
   * 还原规则
   * ------------------------------------------------------------------ */

  function renderBuiltin() {
    const wrap = $('builtinRules');
    wrap.textContent = '';
    C.BUILTIN_RESTORE_RULES.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'builtin-item';
      d.innerHTML = '<span></span><em>' + U.escapeHtml(r.id) + '</em>';
      // 规则名跟着语言走；constants 里的 label 是中文兜底
      d.firstChild.textContent = I18n.ruleLabel(r.id, r.label);
      wrap.appendChild(d);
    });
  }

  function renderRules() {
    const wrap = $('customRules');
    wrap.textContent = '';
    const rules = settings.customRules || [];
    rules.forEach((rule, i) => wrap.appendChild(buildRuleRow(rule, i)));
  }

  function buildRuleRow(rule, index) {
    const row = document.createElement('div');
    row.className = 'rule';

    const pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.placeholder = t('opt.rulePatternPh');
    pattern.value = rule.pattern || '';

    const flags = document.createElement('input');
    flags.type = 'text';
    flags.placeholder = t('opt.ruleFlagsPh');
    flags.value = rule.flags || 'i';

    const replace = document.createElement('input');
    replace.type = 'text';
    replace.placeholder = t('opt.ruleReplacePh');
    replace.value = rule.replace == null ? '' : rule.replace;

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.title = t('opt.ruleDelTitle');
    del.setAttribute('aria-label', t('opt.ruleDelTitle'));
    del.textContent = '×';

    const hint = document.createElement('div');
    hint.className = 'hint-row';
    hint.textContent = t('opt.ruleHint');

    const commit = U.debounce(async () => {
      const list = (settings.customRules || []).slice();
      list[index] = {
        pattern: pattern.value.trim(),
        flags: flags.value.trim() || 'i',
        replace: replace.value
      };
      await persist({ customRules: list });
    }, 500);

    pattern.addEventListener('input', commit);
    flags.addEventListener('input', commit);
    replace.addEventListener('input', commit);

    del.addEventListener('click', async () => {
      const list = (settings.customRules || []).slice();
      list.splice(index, 1);
      await persist({ customRules: list });
      renderRules();
    });

    row.appendChild(pattern);
    row.appendChild(flags);
    row.appendChild(replace);
    row.appendChild(del);
    row.appendChild(hint);
    return row;
  }

  /* ------------------------------------------------------------------ *
   * 规则调试
   * ------------------------------------------------------------------ */

  function buildCandidates(url) {
    const out = [];
    for (const rule of C.BUILTIN_RESTORE_RULES) {
      let v = null;
      try { v = rule.apply(url); } catch (e) { v = null; }
      if (v && v !== url) out.push({ by: rule.id, url: v });
    }
    for (const rule of (settings.customRules || [])) {
      if (!rule || !rule.pattern) continue;
      try {
        const re = new RegExp(rule.pattern, rule.flags || 'i');
        const v = url.replace(re, rule.replace == null ? '' : rule.replace);
        if (v && v !== url) out.push({ by: 'custom', url: v });
      } catch (e) {
        out.push({ by: 'custom', url: '', error: t('opt.ruleErr', { msg: e.message }) });
      }
    }
    return out;
  }

  function probe(url) {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const t = setTimeout(() => finish(null), 6000);
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        img.onload = img.onerror = null;
        resolve(v);
      }
      img.onload = () => finish({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  async function runTest() {
    const url = $('testUrl').value.trim();
    const box = $('testResult');
    const none = (s) => '<span class="none">' + U.escapeHtml(s) + '</span>';

    if (!url) { box.innerHTML = none(t('opt.testNeedUrl')); return; }

    const list = buildCandidates(url);
    if (!list.length) {
      box.innerHTML = none(t('opt.testNoMatch'));
      return;
    }

    box.innerHTML = none(t('opt.testLoading'));

    const rows = await Promise.all(list.map(async (c) => {
      if (!c.url) return { ...c, size: null };
      const size = await probe(c.url);
      return { ...c, size };
    }));

    box.textContent = '';
    const originSize = await probe(url);

    const head = document.createElement('div');
    head.className = 'none';
    head.textContent = t('opt.testOrigin', {
      dim: originSize ? originSize.w + ' × ' + originSize.h : t('opt.testUnknown')
    });
    box.appendChild(head);

    for (const r of rows) {
      const d = document.createElement('div');
      if (r.error) {
        d.innerHTML = '<span class="none">[' + U.escapeHtml(r.by) + '] ' + U.escapeHtml(r.error) + '</span>';
      } else {
        const dim = r.size ? r.size.w + ' × ' + r.size.h : t('opt.testLoadFail');
        const better = r.size && originSize && (r.size.w * r.size.h > originSize.w * originSize.h);
        d.innerHTML = '<span class="' + (better ? 'hit' : 'none') + '">[' + U.escapeHtml(r.by) + '] '
          + dim + ' → ' + U.escapeHtml(r.url)
          + U.escapeHtml(better ? t('opt.testWillUse') : t('opt.testWontUse')) + '</span>';
      }
      box.appendChild(d);
    }
  }

  /* ------------------------------------------------------------------ *
   * 数据与统计
   * ------------------------------------------------------------------ */

  async function refreshStats() {
    const [stats, history, fps] = await Promise.all([
      Store.getStats(),
      Store.getHistory(),
      Store.getFingerprintMap()
    ]);
    $('stSaved').textContent = String(stats.saved || 0);
    $('stFailed').textContent = String(stats.failed || 0);
    $('stBytes').textContent = U.formatBytes(stats.bytes || 0);
    $('stHistory').textContent = String(history.length);
    $('stFp').textContent = String(Object.keys(fps).length);
  }

  async function showHistory() {
    const history = await Store.getHistory();
    const body = $('modalBody');
    body.textContent = '';

    if (!history.length) {
      const p = document.createElement('p');
      p.style.cssText = 'color:var(--text-3);padding:20px 0';
      p.textContent = t('opt.histEmpty');
      body.appendChild(p);
    } else {
      const table = document.createElement('table');
      table.className = 'hist-table';
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      /* 写全键、不拼前缀：拼出来的键静态查不到，
         一旦某个键漏了翻译，界面上会直接显示 "opt.histTime" 而测试全绿。 */
      ['opt.histTime', 'opt.histName', 'opt.histDims',
        'opt.histBytes', 'opt.histStatus', 'opt.histPage'].forEach((k) => {
        const th = document.createElement('th');
        th.textContent = t(k);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      const tb = document.createElement('tbody');

      history.slice(0, 300).forEach((h) => {
        const tr = document.createElement('tr');
        const st = h.status === 'done'
          ? '<span class="pill ok">' + U.escapeHtml(t('opt.histOk')) + '</span>'
          : '<span class="pill err">' + U.escapeHtml(t('opt.histFail')) + '</span>';
        tr.innerHTML =
          '<td>' + U.formatTime(h.ts) + '</td>' +
          '<td>' + U.escapeHtml(h.filename || '') + '</td>' +
          '<td>' + ((h.width && h.height) ? h.width + '×' + h.height : '—') + '</td>' +
          '<td>' + (h.bytes ? U.formatBytes(h.bytes) : '—') + '</td>' +
          '<td>' + st + '</td>' +
          '<td class="url">' + U.escapeHtml(h.pageUrl || '') + '</td>';
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      body.appendChild(table);
    }

    $('modal').hidden = false;
  }

  function exportSettings() {
    const data = {
      _app: 'ImageHunter',
      _version: 1,
      exportedAt: new Date().toISOString(),
      settings: settings
    };
    const stamp = new Date().toISOString().slice(0, 10);
    U.downloadText('imagehunter-settings-' + stamp + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast(t('opt.exported'), 'ok');
  }

  /* ------------------------------------------------------------------ *
   * 诊断包
   *
   * 这里只做三件事：取原料（background）→ 交给 IH.Diag 组装 → 自查后落盘。
   * **组装规则全在 shared/diagnostics.js**，设置页不碰字段白名单 ——
   * 否则「哪些字段能导出」会散落在两个文件里，迟早对不上。
   * ------------------------------------------------------------------ */

  async function exportDiagnostics() {
    if (!IH.Diag) {
      toast(t('opt.diagMissing'), 'err');
      return;
    }

    let version = '';
    try { version = chrome.runtime.getManifest().version || ''; } catch (e) { /* 保持空 */ }

    // background 可能刚被回收过，拿不到就退化成「只有设置和版本」——
    // 少一段有用信息，但绝不能因此导不出来
    let raw = { lastScan: null, recent: [], probe: null };
    try {
      const res = await U.sendToBg({ type: MSG.GET_DIAGNOSTICS });
      if (res && res.ok) raw = res;
    } catch (e) { /* 用上面的退化值 */ }

    const diag = IH.Diag.build({
      version,
      platform: navigator.userAgent || '',
      language: navigator.language || '',
      settings: settings,
      recentDownloads: raw.recent || [],
      lastScan: raw.lastScan || null,
      probe: raw.probe || null
    });

    /* 落盘前自查一遍。这一步是「不靠人记得」的兑现：
       以后谁往设置里加了一个带地址的键，只要没被 scrub 掉，
       就会在这里被拦下并当场报出来，而不是等用户把文件贴到 issue 里。 */
    const leaks = IH.Diag.audit(diag);
    if (leaks.length) {
      console.error('[ImageHunter] 诊断包自查发现未清洗的地址：', leaks);
      toast(t('opt.diagAuditFail', { n: leaks.length }), 'err');
      return;
    }

    const text = JSON.stringify(diag, null, 2);
    U.downloadText(IH.Diag.fileName(), text, 'application/json');
    toast(t('opt.diagExported', { n: diag.recentDownloadsCount || 0 }), 'ok');
  }

  function importSettings(file) {
    const fr = new FileReader();
    fr.onload = async () => {      try {
        const data = JSON.parse(fr.result);
        const incoming = data && data.settings ? data.settings : data;
        if (!incoming || typeof incoming !== 'object') throw new Error(t('opt.importBadFormat'));

        // 只接受已知字段（customRules 会在里面走 sanitizeCustomRules 校验），
        // 避免脏数据；也保证「导出 → 导入」是完整的往返
        const clean = U.mergeImportedSettings(incoming, C.DEFAULT_SETTINGS);

        settings = await Store.updateSettings(clean);
        renderSettings();
        renderRules();
        const n = (settings.customRules || []).length;
        toast(n ? t('opt.importedRules', { n }) : t('opt.imported'), 'ok');
      } catch (e) {
        toast(t('opt.importFail', { msg: (e && e.message) || e }), 'err');
      }
    };
    fr.readAsText(file);
  }

  function bindData() {
    $('btnViewHistory').addEventListener('click', showHistory);
    $('modalClose').addEventListener('click', () => { $('modal').hidden = true; });
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });

    $('btnClearHistory').addEventListener('click', async () => {
      if (!confirm(t('opt.clearHistoryConfirm'))) return;
      await Store.clearHistory();
      await refreshStats();
      toast(t('opt.historyCleared'), 'ok');
    });

    $('btnClearFp').addEventListener('click', async () => {
      if (!confirm(t('opt.clearFpConfirm'))) return;
      await Store.clearFingerprints();
      await refreshStats();
      toast(t('opt.fpCleared'), 'ok');
    });

    $('btnExportSettings').addEventListener('click', exportSettings);

    $('btnExportDiag').addEventListener('click', () => {
      exportDiagnostics().catch((e) => toast(t('opt.exportFail', { msg: (e && e.message) || e }), 'err'));
    });

    $('btnImportSettings').addEventListener('click', () => $('fileImport').click());

    $('fileImport').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importSettings(f);
      e.target.value = '';
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  async function init() {
    settings = await Store.loadSettings();

    /* 先把 HTML 里的静态文案按当前语言填一遍，再去渲染动态内容 ——
       顺序反了的话，规则列表这类动态内容会先用旧语言渲染一遍再被覆盖。 */
    I18n.apply(document);
    applyLang();
    renderFooter();

    bindControls();
    renderSettings();
    renderBuiltin();
    renderRules();
    bindData();

    $('btnAddRule').addEventListener('click', async () => {
      const list = (settings.customRules || []).slice();
      list.push({ pattern: '', flags: 'i', replace: '' });
      await persist({ customRules: list });
      renderRules();
    });

    $('btnTest').addEventListener('click', runTest);
    $('testUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') runTest(); });

    await refreshStats();

    // 其他页面改了设置时同步
    Store.onChange(() => { refreshStats(); });

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onScheme = () => { if (settings.theme === 'auto') applyTheme('auto'); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
  }

  init().catch((e) => {
    console.error('[ImageHunter] 设置页初始化失败', e);
    toast(t('opt.initFail', { msg: (e && e.message) || e }), 'err');
  });
})();
