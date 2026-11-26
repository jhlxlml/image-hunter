/* ==========================================================================
 * ImageHunter — popup/targets.js
 * 扫描目标选择器（单选下拉 / 多标签页勾选合并 + 结果合并去重）
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  const C = IH.C;
  const U = IH.U;
  const Store = IH.Store;
  const MSG = C.MSG;

  /**
   * 创建扫描目标控制器。
   * @param {object} ctx
   * @param {Function} ctx.$
   * @param {string}   ctx.MODE
   * @param {object}   ctx.state
   * @param {Function} ctx.t
   * @param {Function} ctx.getTabId
   * @param {Function} ctx.setTabId
   * @param {Function} ctx.doScan
   * @param {Function} ctx.focusImage
   */
  function create(ctx) {
    const { $, MODE, state, t, getTabId, setTabId, doScan, focusImage } = ctx;

    /* 多标签页合并嗅探（设置页开关，默认关）。两个变量分工明确：
         mergeTabs —— 这一轮到底是不是合并模式（面板模式恒为 false，见 init）
         targetIds —— 合并模式下**勾选了哪些**标签页；tabId 始终同步成它的第一个
                       （页内面板、定位等仍按「单目标」语义工作，不用改）
       关闭合并时 targetIds 恒为空，一切按单个 tabId 走 —— 与改动前完全一致。 */
    let mergeTabs = false;
    let targetIds = [];
    let lastTabs = [];           // 最近一次 LIST_TABS 的结果，多选面板据此渲染

    /** 本轮真正要扫的标签页。合并模式下以勾选为准（可能为空 —— 那就是「还没选」）。 */
    function activeTargetIds() {
      if (mergeTabs) return targetIds.slice();
      const tid = getTabId();
      return tid != null ? [tid] : [];
    }

    /** 按设置切换「扫描目标」用哪个控件 */
    function applyTargetMode() {
      const sel = $('selTargetTab');
      const multi = $('targetMulti');
      if (!sel || !multi) return;
      sel.hidden = mergeTabs;
      multi.hidden = !mergeTabs;
      if (!mergeTabs) closeTargetsPanel();
    }

    function closeTargetsPanel() {
      const panel = $('targetsPanel');
      const btn = $('btnTargets');
      if (panel) panel.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    /** 拉取所有可选的普通网页标签页，填充单选下拉与多选列表 */
    async function loadTabList() {
      const sel = $('selTargetTab');
      const res = await U.sendToBg({ type: MSG.LIST_TABS });
      const tabs = (res && res.tabs) || [];
      lastTabs = tabs;
      let tabId = getTabId();

      /* ---- 单选下拉（合并关闭时用）---- */
      if (sel) {
        sel.innerHTML = '';
        if (!tabs.length) {
          const o = document.createElement('option');
          o.value = '';
          o.textContent = t('pop.noTabs');
          sel.appendChild(o);
          sel.disabled = true;
        } else {
          tabs.forEach((tab) => {
            const o = document.createElement('option');
            o.value = String(tab.id);
            const label = (tab.title || tab.host || tab.url).trim().slice(0, 60);
            o.textContent = tab.active ? '● ' + label : label;
            o.title = tab.url;
            sel.appendChild(o);
          });

          if (tabId != null && tabs.some((tab) => tab.id === tabId)) {
            sel.value = String(tabId);
          } else {
            // 目标标签页已关闭：退回到后台推荐的那个
            const fallback = res && res.current;
            if (fallback != null && tabs.some((tab) => tab.id === fallback)) {
              sel.value = String(fallback);
              tabId = fallback;
              setTabId(tabId);
            }
          }
          sel.disabled = false;
        }
      }

      /* ---- 多选列表（合并打开时用）----
         先清掉已经关掉的标签页，再保证「至少选中一个」——
         否则用户打开图库会看到一个空列表，还以为嗅探坏了。 */
      if (tabs.length) {
        const alive = new Set(tabs.map((tab) => tab.id));
        if (mergeTabs) {
          targetIds = targetIds.filter((id) => alive.has(id));
          if (!targetIds.length) {
            const fallback = res && res.current;
            const seed = (tabId != null && alive.has(tabId)) ? tabId
              : (fallback != null && alive.has(fallback)) ? fallback
                : tabs[0].id;
            targetIds = [seed];
          }
          tabId = targetIds[0];
          setTabId(tabId);
        } else {
          /* 单选模式下 `tabId` 才是唯一真相源，勾选列表只是跟着它走 ——
             这里**绝不能**反过来用 `targetIds` 覆盖 `tabId`。
             `switchTarget()` 会先把 `tabId` 改成新目标、紧接着调本函数刷新列表；
             若在刷新时被覆盖回旧值，那次「切换」就等于当场被撤销 ——
             表现是「顶栏和目标下拉都换了，图却还是上一页的」。
             目标标签页已被关闭时，退回列表第一个（与原行为一致）。 */
          targetIds = (tabId != null && alive.has(tabId)) ? [tabId] : [];
          if (!targetIds.length) {
            tabId = tabs[0].id;
            setTabId(tabId);
            targetIds = [tabId];
          }
        }
      } else {
        targetIds = [];
      }

      renderTargets();
    }

    /** 渲染多选面板里的勾选列表 + 胶囊上的摘要文字 */
    function renderTargets() {
      const list = $('targetsList');
      if (!list) return;

      list.textContent = '';
      if (!lastTabs.length) {
        const d = document.createElement('div');
        d.className = 'tm-empty';
        d.textContent = t('pop.noTabs');
        list.appendChild(d);
      } else {
        /* 循环变量叫 tab 不叫 t —— `t` 是本文件的「取词」助手，
           同名会把它盖掉，写出来的 `t('pop.xxx')` 会当场抛 TypeError。 */
        for (const tab of lastTabs) {
          const row = document.createElement('label');
          row.className = 'tm-row';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = String(tab.id);
          cb.checked = targetIds.indexOf(tab.id) >= 0;
          cb.addEventListener('change', () => {
            if (cb.checked) {
              if (targetIds.indexOf(tab.id) < 0) targetIds.push(tab.id);
            } else {
              targetIds = targetIds.filter((id) => id !== tab.id);
            }
            onTargetsChanged();
          });
          row.appendChild(cb);

          const txt = document.createElement('span');
          txt.className = 'tm-txt';
          txt.textContent = (tab.title || tab.url || '').trim().slice(0, 80) || t('pop.untitled');
          txt.title = tab.url || '';
          row.appendChild(txt);

          const host = document.createElement('span');
          host.className = 'tm-host';
          host.textContent = tab.host || '';
          row.appendChild(host);

          list.appendChild(row);
        }
      }

      const sum = $('targetsSummary');
      if (sum) {
        const n = targetIds.length;
        if (!n) {
          sum.textContent = t('pop.targetSummary');
          sum.title = t('pop.noPagePicked');
        } else if (n === 1) {
          const one = lastTabs.find((x) => x.id === targetIds[0]);
          sum.textContent = one
            ? ((one.title || one.url || '').trim().slice(0, 40) || t('pop.pageCount', { n: 1 }))
            : t('pop.pageCount', { n: 1 });
          sum.title = one ? (one.url || '') : '';
        } else {
          sum.textContent = t('pop.pageCount', { n });
          sum.title = targetIds.map((id) => {
            const found = lastTabs.find((x) => x.id === id);
            return found ? (found.title || found.url) : String(id);
          }).join('\n');
        }
      }
    }

    /* 连点几个复选框（或「全选」）会连着触发好几次变更。
       不防抖的话就是好几次**并发**的合并扫描同时在跑 ——
       它们各自 await 完之后都会去写 state.all，谁后到谁说了算，
       用户看到的是「结果闪来闪去，最后停在哪个全看运气」。
       等 260ms 再扫，中间的中间态自然被合并掉。 */
    const scheduleMergedRescan = U.debounce(() => {
      state.selected.clear();
      doScan();
    }, 260);

    /** 勾选变化：立刻刷摘要，扫描**防抖**后只跑一次 */
    function onTargetsChanged() {
      if (targetIds.length) setTabId(targetIds[0]);
      renderTargets();
      scheduleMergedRescan();
    }

    /** 单选下拉切换 */
    async function onTargetChange(e) {
      const v = parseInt(e.target.value, 10);
      if (!isFinite(v) || v === getTabId()) return;
      setTabId(v);
      state.selected.clear();
      await doScan();
    }

    /**
     * 切换扫描目标并重新嗅探；带 focusUrl 时顺便定位到那一张。
     *
     * 目标没变也要继续走定位 —— 用户可能就是在同一个页面的灯箱里又点了一次
     * 「在图库中打开」，那时候不该白重扫一遍。
     */
    async function switchTarget(nextId, focusUrl) {
      let changed = false;
      if (nextId != null) {
        // 合并模式下，「在图库中打开」表达的是「我只要这一页」——
        // 于是把勾选收缩成这一个，而不是在原有多个目标上再加一个。
        if (mergeTabs && (targetIds.length !== 1 || targetIds[0] !== nextId)) {
          targetIds = [nextId];
          changed = true;
        }
        if (nextId !== getTabId()) { setTabId(nextId); changed = true; }
      }
      if (changed) {
        state.selected.clear();
        await loadTabList();   // 顺带刷新列表（期间可能又开了新标签页）
        await doScan();
      }
      if (focusUrl) await focusImage(focusUrl);
    }

    /** 多选面板的开合、全选 / 清空、点外部关闭 */
    function bindTargetPicker() {
      const btn = $('btnTargets');
      const panel = $('targetsPanel');
      if (!btn || !panel) return;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = panel.hidden;
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      });

      $('btnTargetsAll').addEventListener('click', (e) => {
        e.stopPropagation();
        targetIds = lastTabs.map((tab) => tab.id);
        onTargetsChanged();
      });

      $('btnTargetsNone').addEventListener('click', (e) => {
        e.stopPropagation();
        targetIds = [];
        onTargetsChanged();
      });

      // 点面板以外的地方 → 收起（和搜索框同一套做法）
      document.addEventListener('pointerdown', (e) => {
        if (panel.hidden) return;
        if (e.target.closest && e.target.closest('.target-multi')) return;
        closeTargetsPanel();
      });
    }

    /**
     * 设置里改了「多标签页合并嗅探」→ 立刻切换控件并重扫。
     * 与排除列表那套一致：改完立即生效，不用刷新页面。
     */
    async function onSettingsChanged() {
      if (MODE !== 'page') return;                 // 面板模式恒为单目标
      const next = !!Store.getSettings().mergeTabs;
      if (next === mergeTabs) return;
      mergeTabs = next;
      applyTargetMode();
      if (mergeTabs) {
        // 从单选切过来：把当前主目标作为唯一的勾选项
        const tid = getTabId();
        targetIds = tid != null ? [tid] : [];
      }
      await loadTabList();
      state.selected.clear();
      await doScan();
    }

    /**
     * 把 N 个页面的扫描结果合并成一份。
     *
     * 合并规则（刻意简单、可解释）：
     *   - 去重按**图片地址**（U.normalizeUrl），跨页面同样生效；
     *   - 同一张图出现在多个页面时只留一张，并把「还出现在哪些页面」记进 pageHosts；
     *   - 每张图带上 pageUrl / pageHost / pageIndex，供「站点」排序与卡片角标使用；
     *   - order 重排成全局序号，于是「页面顺序」排序 = 按页面依次排，页内保持原顺序。
     *
     * @param {number[]} ids    这一轮的目标标签页（顺序 = 页面顺序）
     * @param {Array}    results 与 ids 一一对应的扫描结果；还没回来的位置是 null
     */
    function mergeTabResults(ids, results) {
      const seen = new Map();
      const out = [];
      const pages = [];
      let truncated = false;
      let restoreTruncated = false;
      let deepTruncated = false;
      let bgTruncatedFrames = 0;
      let bgTruncatedElements = 0;
      let okCount = 0;
      let blockedCount = 0;
      let failCount = 0;
      let firstError = '';

      results.forEach((r, idx) => {
        const pageUrl = (r && r.pageUrl) || '';
        const pageHost = U.prettyHost(pageUrl) || '';
        pages.push({
          id: ids[idx],
          pageUrl,
          host: pageHost,
          title: (r && r.title) || '',
          count: (r && Array.isArray(r.images)) ? r.images.length : 0,
          ok: !!(r && r.ok),
          blocked: !!(r && r.blocked)
        });

        if (!r) return;                      // 还没回来
        if (!r.ok) {
          if (r.blocked) blockedCount++;
          else { failCount++; if (!firstError && r.error) firstError = String(r.error); }
          return;
        }
        okCount++;
        if (r.truncated) truncated = true;
        if (r.restoreTruncated) restoreTruncated = true;
        if (r.deepTruncated) deepTruncated = true;
        bgTruncatedFrames += r.bgTruncatedFrames || 0;
        bgTruncatedElements = Math.max(bgTruncatedElements, r.bgTruncatedElements || 0);

        for (const img of (r.images || [])) {
          if (!img || !img.url) continue;
          const key = U.normalizeUrl(img.url);
          const prev = seen.get(key);
          if (prev) {
            // 同一张图出现在别的页面：只留一张，但把「还出现在哪」记下来
            if (prev.pageIndex !== idx && prev.pageHosts.indexOf(pageHost) < 0) {
              prev.pageHosts.push(pageHost);
            }
            continue;
          }
          const item = Object.assign({}, img);
          item.pageIndex = idx;
          item.pageUrl = pageUrl;
          item.pageHost = pageHost;
          item.pageHosts = [pageHost];
          // host（图片自身域名）由后台补；这里兜底，防止老版本后台的结果缺这个字段
          if (!item.host) item.host = U.prettyHost(item.url);
          // 全局顺序：页面顺序 → 页内顺序
          item.order = out.length;
          seen.set(key, item);
          out.push(item);
        }
      });

      const settled = results.filter((r) => r != null).length;
      return {
        ok: okCount > 0,
        // 「全都被排除」才叫 blocked；只要有一页扫到了，就不该拿排除列表来搪塞
        blocked: okCount === 0 && blockedCount > 0 && failCount === 0,
        error: okCount === 0 ? (firstError || (settled ? t('pop.allPagesEmpty') : '')) : undefined,
        images: out,
        found: out.length,
        truncated,
        restoreTruncated,
        deepTruncated,
        bgTruncatedFrames,
        bgTruncatedElements,
        pageUrl: pages[0] ? pages[0].pageUrl : '',
        title: pages[0] ? pages[0].title : '',
        targetCount: ids.length,
        pages
      };
    }

    return {
      isMerge: () => mergeTabs,
      setMerge: (v) => { mergeTabs = !!v; },
      activeTargetIds,
      applyTargetMode,
      closeTargetsPanel,
      loadTabList,
      renderTargets,
      onTargetChange,
      switchTarget,
      bindTargetPicker,
      onSettingsChanged,
      mergeTabResults
    };
  }

  IH.PopupTargets = { create };
})();
