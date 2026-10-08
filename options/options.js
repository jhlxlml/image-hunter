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
      note.textContent = '当前没有排除任何站点';
      return;
    }

    const good = [];
    const bad = [];
    for (const line of lines) {
      const p = U.normalizeHostPattern(line);
      if (p) { if (good.indexOf(p) < 0) good.push(p); }
      else bad.push(line);
    }

    note.className = 'inline-note' + (bad.length ? ' warn' : '');
    note.textContent = bad.length
      ? '会排除 ' + good.length + ' 个站点；下面这 ' + bad.length + ' 行不是有效域名，将被忽略：'
        + bad.join('、')
      : '会排除 ' + good.length + ' 个站点：' + good.join('、');
  }

  function updateOutput(el) {
    const out = document.querySelector('[data-out="' + el.dataset.key + '"]');
    if (!out) return;
    const key = el.dataset.key;
    const v = Number(el.value);
    if (key === 'probeTimeout') out.textContent = v + ' ms';
    else if (key === 'hoverDelay') out.textContent = v + ' ms';
    else if (key === 'minSize') out.textContent = v + ' px';
    else if (key === 'lightboxMinSize') out.textContent = v > 0 ? v + ' px' : '不过滤';
    else if (key === 'concurrency') out.textContent = v + ' 张';
    else if (key === 'retries') out.textContent = v + ' 次';
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
      if (n) extra.push(n + ' 条自定义还原规则');
      if (b) extra.push(b + ' 个排除站点');
      const msg = extra.length
        ? '确定要把所有设置恢复为默认值吗？\n\n这会同时删除你添加的 ' + extra.join(' 和 ') + '，且无法撤销。'
        : '确定要把所有设置恢复为默认值吗？';
      if (!confirm(msg)) return;
      settings = await Store.resetSettings();
      renderSettings();
      renderRules();
      toast('已恢复默认设置', 'ok');
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
      d.firstChild.textContent = r.label;
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
    pattern.placeholder = '匹配正则，如  -\\d{2,4}x\\d{2,4}(?=\\.jpg)';
    pattern.value = rule.pattern || '';

    const flags = document.createElement('input');
    flags.type = 'text';
    flags.placeholder = 'flags';
    flags.value = rule.flags || 'i';

    const replace = document.createElement('input');
    replace.type = 'text';
    replace.placeholder = '替换为（留空即删除匹配部分）';
    replace.value = rule.replace == null ? '' : rule.replace;

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.title = '删除该规则';
    del.textContent = '×';

    const hint = document.createElement('div');
    hint.className = 'hint-row';
    hint.textContent = '示例：正则 (-\\d{2,4}x\\d{2,4})(?=\\.jpg)  ·  替换为空 → 去掉 WordPress 尺寸后缀';

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
        out.push({ by: 'custom', url: '', error: '正则非法：' + e.message });
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
    if (!url) { box.innerHTML = '<span class="none">请先粘贴一个图片地址</span>'; return; }

    const list = buildCandidates(url);
    if (!list.length) {
      box.innerHTML = '<span class="none">没有规则匹配这个地址 —— 它会被当作原图直接下载</span>';
      return;
    }

    box.innerHTML = '<span class="none">正在加载候选原图…</span>';

    const rows = await Promise.all(list.map(async (c) => {
      if (!c.url) return { ...c, size: null };
      const size = await probe(c.url);
      return { ...c, size };
    }));

    box.textContent = '';
    const originSize = await probe(url);

    const head = document.createElement('div');
    head.className = 'none';
    head.textContent = '原地址：' + (originSize ? originSize.w + ' × ' + originSize.h : '加载失败 / 未知');
    box.appendChild(head);

    for (const r of rows) {
      const d = document.createElement('div');
      if (r.error) {
        d.innerHTML = '<span class="none">[' + U.escapeHtml(r.by) + '] ' + U.escapeHtml(r.error) + '</span>';
      } else {
        const dim = r.size ? r.size.w + ' × ' + r.size.h : '加载失败';
        const better = r.size && originSize && (r.size.w * r.size.h > originSize.w * originSize.h);
        d.innerHTML = '<span class="' + (better ? 'hit' : 'none') + '">[' + U.escapeHtml(r.by) + '] '
          + dim + ' → ' + U.escapeHtml(r.url) + (better ? '  ✓ 会被采用' : '  （不会采用）') + '</span>';
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
      body.innerHTML = '<p style="color:var(--text-3);padding:20px 0">还没有下载记录</p>';
    } else {
      const table = document.createElement('table');
      table.className = 'hist-table';
      table.innerHTML = '<thead><tr><th>时间</th><th>文件名</th><th>尺寸</th><th>体积</th><th>状态</th><th>来源页</th></tr></thead>';
      const tb = document.createElement('tbody');

      history.slice(0, 300).forEach((h) => {
        const tr = document.createElement('tr');
        const st = h.status === 'done'
          ? '<span class="pill ok">成功</span>'
          : '<span class="pill err">失败</span>';
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
    toast('设置已导出', 'ok');
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
      toast('诊断模块未加载，请重新加载扩展', 'err');
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
      toast('诊断包自查未通过（' + leaks.length + ' 处地址未清洗），已中止导出', 'err');
      return;
    }

    const text = JSON.stringify(diag, null, 2);
    U.downloadText(IH.Diag.fileName(), text, 'application/json');
    toast('诊断包已导出（' + (diag.recentDownloadsCount || 0) + ' 条下载记录）', 'ok');
  }

  function importSettings(file) {
    const fr = new FileReader();
    fr.onload = async () => {      try {
        const data = JSON.parse(fr.result);
        const incoming = data && data.settings ? data.settings : data;
        if (!incoming || typeof incoming !== 'object') throw new Error('文件格式不正确');

        // 只接受已知字段（customRules 会在里面走 sanitizeCustomRules 校验），
        // 避免脏数据；也保证「导出 → 导入」是完整的往返
        const clean = U.mergeImportedSettings(incoming, C.DEFAULT_SETTINGS);

        settings = await Store.updateSettings(clean);
        renderSettings();
        renderRules();
        const n = (settings.customRules || []).length;
        toast(n ? '设置已导入（含 ' + n + ' 条自定义还原规则）' : '设置已导入', 'ok');
      } catch (e) {
        toast('导入失败：' + ((e && e.message) || e), 'err');
      }
    };
    fr.readAsText(file);
  }

  function bindData() {
    $('btnViewHistory').addEventListener('click', showHistory);
    $('modalClose').addEventListener('click', () => { $('modal').hidden = true; });
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });

    $('btnClearHistory').addEventListener('click', async () => {
      if (!confirm('确定清除所有下载历史吗？已保存的文件不受影响。')) return;
      await Store.clearHistory();
      await refreshStats();
      toast('下载历史已清除', 'ok');
    });

    $('btnClearFp').addEventListener('click', async () => {
      if (!confirm('确定清除去重指纹吗？清除后，之前下载过的图片会重新允许下载。')) return;
      await Store.clearFingerprints();
      await refreshStats();
      toast('去重指纹已清除', 'ok');
    });

    $('btnExportSettings').addEventListener('click', exportSettings);

    $('btnExportDiag').addEventListener('click', () => {
      exportDiagnostics().catch((e) => toast('导出失败：' + ((e && e.message) || e), 'err'));
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

    /* 页脚版本号从 manifest 读，不写死。
       原来这里硬编码着 `v1.0.0`，而 manifest 早就走到 1.7.x —— 没人会记得改它。 */
    try {
      const m = chrome.runtime.getManifest();
      $('ftrVersion').textContent = 'v' + (m.version || '—');
    } catch (e) { /* 拿不到就保持占位符，不编一个版本号出来 */ }

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
    toast('初始化失败：' + ((e && e.message) || e), 'err');
  });
})();
