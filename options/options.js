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
   *
   * 实现在 shared/theme.js —— 原来这里有一份和 popup.js 重复的 applyTheme，
   * 两份还漂移了（这份挂了系统深浅色监听，图库页没挂）。现在只有一种算法。
   * 这里保留一个薄壳是为了「设置页独有的那件事」——把当前选择高亮回
   * #segTheme / 色卡 / 取色器上（DOM 相关，不该塞进共享层）。
   * ------------------------------------------------------------------ */

  function applyTheme() {
    const raw = settings.theme || 'light';
    IH.Theme.apply(document, settings);

    $$('#segTheme button').forEach((b) => b.classList.toggle('active', b.dataset.v === raw));
    renderThemeControls();
  }

  /**
   * 渲染配色方案色卡 + 自定义主色控件。
   *
   * 色卡的颜色值从 IH.Theme.presetList() 取（即 theme.js 的 PRESETS），
   * **不在这里写死一份** —— 否则加一套预设要改两个文件，漏一个就是
   * 「色卡上有、点了没反应」。
   *
   * 亮色档还是深色档的色做色卡？用**当前亮暗档对应的那一档**：
   * 深色模式下深色档主色才是用户实际会看到的颜色，拿浅色档的色做色卡
   * 会让人选了之后发现「跟色卡不一样」。
   */
  function renderThemeControls() {
    const presets = IH.Theme.presetList();
    const cur = IH.Theme.resolve(settings);
    const box = $('themeSwatches');
    /* 色卡上的样本色取**当前亮暗档对应的那一档**：
       深色模式下深色档主色才是用户实际会看到的颜色，拿浅色档的色做样本
       会让人选了之后发现「跟色卡不一样」。 */
    const sampleOf = (p) => (cur.mode === 'dark' ? p.dark : p.light);

    if (box) {
      // 数量对不上才重建 —— 每次 renderSettings 都重建会让色卡闪一下
      if (box.children.length !== presets.length) {
        box.innerHTML = '';
        presets.forEach((p) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'swatch';
          btn.setAttribute('role', 'radio');
          btn.dataset.preset = p.key;
          box.appendChild(btn);
        });
      }
      presets.forEach((p, i) => {
        const btn = box.children[i];
        if (!btn) return;
        const on = p.key === cur.preset;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        /* roving tabindex：整组只留**一个** Tab 停靠点（当前选中的那个），
           进去之后用方向键切。六个色卡各占一个 Tab 位等于让用户按六次 Tab
           才能穿过这个控件 —— 和网格那套做法一致。 */
        btn.tabIndex = on ? 0 : -1;
        btn.style.setProperty('--swatch-color', sampleOf(p));
        /* 名字走 i18n 表（opt.preset.xxx）而不是 PRESETS 里的 zh/en 字段 ——
           界面文案的唯一入口是 i18n 表，两处都存一份就是又一次会漂移的副本。 */
        const key = 'opt.preset.' + p.key;
        btn.title = t(key);
        btn.setAttribute('aria-label', t(key));
      });
    }

    const pick = $('accentPick');
    const input = $('themeAccent');
    const reset = $('btnAccentReset');

    if (input) {
      // 取色器要有一个具体值才能显示颜色 —— 没有自定义时就显示当前生效的主色
      input.value = cur.accent;
      input.setAttribute('aria-label', t('opt.themeAccent'));
    }
    if (pick) {
      pick.classList.toggle('custom', cur.isCustomAccent);
      const lbl = pick.querySelector('.accent-label');
      /* 没有自定义时把标签换成「跟随配色方案」——「选一个颜色」是诱导，
         而此刻的状态是「没在自定义」。 */
      if (lbl) lbl.textContent = cur.isCustomAccent ? cur.accent : t('opt.themeAccentAuto');
    }
    // 没在自定义时「恢复」是个空操作，禁用掉（给个能点的按钮只会让人多点一次）
    if (reset) reset.disabled = !cur.isCustomAccent;
  }

  /** 换配色方案。抽出来是为了 click 与键盘（role=radio 的方向键）都能用。 */
  function pickPreset(key) {
    if (!IH.Theme.PRESETS[key]) return;
    settings.themePreset = key;
    applyTheme();
    persist({ themePreset: key });
    flashSaved();
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

    /* 下拉选择（目前只有 defaultSort 一个）。
       值不存在时退回**第一个选项**，而不是留空 —— 留空会让 select 显示成
       空白（浏览器对「值不在选项里」的处理就是什么都不选），
       用户会以为自己把排序弄坏了。 */
    $$('select[data-key]').forEach((el) => {
      const v = settings[el.dataset.key];
      el.value = v != null && v !== '' ? v : (el.options[0] ? el.options[0].value : '');
    });

    // 站点排除列表（多行文本框，一行一个域名）
    const bh = $('blockedHosts');
    if (bh) bh.value = (settings.blockedHosts || []).join('\n');
    renderBlockedNote();

    applyTheme();
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

    /* 下拉选择：change 即存。没有做「非法值退回」—— option 是写死的，
       用户只能从这 6 个里选；真正要防的是**导入的 JSON**里塞了别的值，
       那由图库侧的 parseSort 兜底（认不出就回默认）。 */
    $$('select[data-key]').forEach((el) => {
      el.addEventListener('change', () => {
        persist({ [el.dataset.key]: el.value });
      });
    });

    $$('#segTheme button').forEach((b) => {
      b.addEventListener('click', () => {
        /* 先写进 settings 再 applyTheme —— 新的 applyTheme 不带参数，
           它读的是 settings（applyTheme(v) 那种签名已经收进 Theme 了）。 */
        settings.theme = b.dataset.v;
        applyTheme();
        persist({ theme: b.dataset.v });
      });
    });

    $$('#segLang button').forEach((b) => {
      b.addEventListener('click', () => { switchLang(b.dataset.v); });
    });

    /* ---- 配色方案色卡 ----
       点击换预设。键盘（方向键 / Home / End）在 role="radiogroup" 上按
       「单选组」的惯例切 —— 色卡是 button 不是 radio，那套默认行为要自己给，
       否则键盘用户 Tab 进来是一片「没有名字也动不了」的圆点。 */
    const swatchBox = $('themeSwatches');
    if (swatchBox) {
      swatchBox.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.swatch');
        if (btn) pickPreset(btn.dataset.preset);
      });
      /* button 元素上 Enter / 空格本来就会触发 click，不用另写一份。
         这里只补方向键那套（button 没有默认的方向键行为）。 */
      swatchBox.addEventListener('keydown', (e) => {
        const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
        if (keys.indexOf(e.key) < 0) return;
        e.preventDefault();
        const items = Array.prototype.slice.call(swatchBox.children);
        const at = items.indexOf(e.target.closest ? e.target.closest('.swatch') : null);
        if (at < 0) return;
        let next = at;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % items.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        if (items[next]) {
          /* roving tabindex 要跟着走：只挪焦点不挪 Tab 落点的话，
             用户切到第 5 张色卡后按 Tab 出去，再 Shift+Tab 回来会跳回原来那张。
             方向键只挪焦点，**不顺手改选中的那套配色** —— 这是单选组的惯例
             （参考 WAI-ARIA radio group：方向键移动即选中；但色卡这种
             「一眼就能看出选没选中」的控件，移动焦点即选中会让人来不及比较。
             所以这里只移焦点，选中仍由 Enter / 空格 / 点击决定）。 */
          items.forEach((b, i) => { b.tabIndex = i === next ? 0 : -1; });
          items[next].focus();
        }
      });
    }

    /* ---- 自定义主色 ----
       取色器的 input 事件在拖动过程中会连续触发（原生取色器会实时回报），
       所以这里**只更新界面**不落盘；落盘放到 change（用户确认选色之后）。
       否则拖一次会写几十遍 storage。 */
    const accentInput = $('themeAccent');
    if (accentInput) {
      accentInput.addEventListener('input', () => {
        settings.themeAccent = accentInput.value;
        applyTheme();
      });
      accentInput.addEventListener('change', () => {
        persist({ themeAccent: accentInput.value });
        flashSaved();
      });
    }

    const btnAccentReset = $('btnAccentReset');
    if (btnAccentReset) {
      btnAccentReset.addEventListener('click', () => {
        settings.themeAccent = '';
        applyTheme();
        persist({ themeAccent: '' });
        flashSaved();
      });
    }

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

    /* 系统深浅色监听收进了 shared/theme.js（图库页此前缺这条，见那边的注释）。
       系统从浅切深、theme 仍是 'auto' 时，Theme.watch 会重算 data-theme；
       设置页的三个亮暗按钮高亮本来就不该动（用户选的还是 auto），
       所以这里不需要额外回调。 */
    IH.Theme.watch(document, () => settings);
  }

  init().catch((e) => {
    console.error('[ImageHunter] 设置页初始化失败', e);
    toast(t('opt.initFail', { msg: (e && e.message) || e }), 'err');
  });
})();
