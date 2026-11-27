/* ==========================================================================
 * ImageHunter — popup/actions.js
 * 图库动作模块：体积探测 / 批量保存与进度渲染 / 导出 JSON·CSV 清单
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  const C = IH.C;
  const U = IH.U;
  const Store = IH.Store;
  const MSG = C.MSG;
  const I18n = IH.I18n;

  /**
   * 创建图库动作控制器。
   * @param {object} ctx
   * @param {Function} ctx.$
   * @param {object}   ctx.state
   * @param {Function} ctx.t
   * @param {Function} ctx.toast
   * @param {Function} ctx.announce
   * @param {Function} ctx.applyFilters
   * @param {Function} ctx.fileNameOf
   */
  function create(ctx) {
    const { $, state, t, toast, announce, applyFilters, fileNameOf } = ctx;

    let progressTimer = null;
    let lastProgressStatus = 'idle';

    /* ------------------------------------------------------------------ *
     * 探测文件体积（HEAD / Range）
     * ------------------------------------------------------------------ */

    /**
     * 探测文件体积。
     *
     * 两段式策略：
     *   1. 优先探测所有「还没探过」的图（sizes 为 undefined，或上次失败但未记入失败集）。
     *   2. 待探测的已经探过一轮、但有失败项 → 这一轮只重试失败项。
     *   3. 两样都没有 → 提示无事可做。
     *
     * 失败项记进 state.probeFailed，不再算作「待探测」。
     * 否则前 N 张一直失败（站点禁跨域）就会永远占据队首，后面的图一辈子轮不到 ——
     * 这正是 AUDIT P1-5 里的死循环。
     */
    async function probeSizes() {
      const pending = state.filtered.filter((c) => state.sizes[c.url] === undefined
        || (state.sizes[c.url] === null && !state.probeFailed.has(c.url)));
      const failed = state.filtered.filter((c) => state.sizes[c.url] === null
        && state.probeFailed.has(c.url));

      let targets;
      let retrying = false;
      if (pending.length) {
        targets = pending;
      } else if (failed.length) {
        targets = failed;
        retrying = true;
        state.probeFailed.clear();     // 放开重试，失败再重新记进去
      } else {
        toast(t('pop.probeNothing'));
        return;
      }

      const btn = $('btnProbe');
      const baseTitle = t('pop.probeTitle');
      /* 注意这里是 aria-disabled 而**不是** disabled：
         用 disabled 会让浏览器把 :hover / 图标旋转一并压掉，那个转圈是
         「正在忙」的唯一反馈；aria-disabled 只声明不可点，样式照常。
         真正防重复触发靠的是下面 finally 里恢复 aria-disabled，加上探测
         本身是对 fixed 的 targets 列表跑的（重入也只是多跑一遍同一批）。 */
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('busy');
      btn.title = t('pop.probing');
      toast(retrying
        ? t('pop.probeRetrying', { n: targets.length })
        : t('pop.probeRunning', { n: targets.length }));

      let okCount = 0;
      let doneCount = 0;

      try {
        for (let i = 0; i < targets.length; i += C.PROBE_LIMIT) {
          const chunk = targets.slice(i, i + C.PROBE_LIMIT);
          const res = await U.sendToBg({
            type: MSG.PROBE_SIZE,
            payload: { urls: chunk.map((c) => c.url) }
          });

          if (res && res.ok && res.sizes) {
            for (const c of chunk) {
              const v = res.sizes[c.url];
              if (v && typeof v.bytes === 'number' && v.bytes > 0) {
                state.sizes[c.url] = v.bytes;
                okCount++;
              } else {
                state.sizes[c.url] = null;
                state.probeFailed.add(c.url);
              }
            }
          } else {
            // 这一批整体失败（后台异常 / 消息通道断了）：全部记为失败，
            // 但**继续下一批** —— 一批失败不该拖住后面的图片。
            for (const c of chunk) {
              state.sizes[c.url] = null;
              state.probeFailed.add(c.url);
            }
          }

          doneCount += chunk.length;
          if (doneCount < targets.length) {
            btn.title = t('pop.probeProgress', { done: doneCount, total: targets.length });
          }
        }
      } finally {
        btn.setAttribute('aria-disabled', 'false');
        btn.classList.remove('busy');
        btn.title = baseTitle;
      }

      applyFilters();

      const failedNow = targets.length - okCount;
      if (okCount) {
        toast(failedNow
          ? t('pop.probeDoneFail', { n: okCount, failed: failedNow })
          : t('pop.probeDone', { n: okCount }));
      } else {
        toast(t('pop.probeAllFail'), 'err');
      }
    }

    /* ------------------------------------------------------------------ *
     * 批量保存
     * ------------------------------------------------------------------ */

    async function saveSelected() {
      const items = state.all.filter((c) => state.selected.has(c.id));
      if (!items.length) { toast(t('pop.saveNothing')); return; }

      const settings = Store.getSettings();
      const payload = items.map((c, i) => ({
        url: c.url,
        pageUrl: state.pageUrl || '',
        width: c.width || 0,
        height: c.height || 0,
        filename: U.buildFilename(c, settings, i + 1)
      }));

      const btn = $('btnSave');
      btn.disabled = true;
      const res = await U.sendToBg({ type: MSG.DOWNLOAD_BATCH, payload: { items: payload } });
      btn.disabled = state.selected.size === 0;

      if (res && res.ok) {
        toast(t('pop.queued', { n: items.length }), 'ok');
        $('progress').hidden = false;
        renderProgress();
      } else {
        toast(t('pop.saveFail', { msg: (res && res.error) || t('cmn.unknownError') }), 'err');
      }
    }

    function dataUrlToBytes(dataUrl) {
      const idx = dataUrl.indexOf(',');
      if (idx < 0) return null;
      const meta = dataUrl.slice(0, idx);
      const body = dataUrl.slice(idx + 1);
      if (/;base64/i.test(meta)) {
        const bin = atob(body);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      const txt = decodeURIComponent(body);
      return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(txt) : null;
    }

    function uniqueZipName(raw, used) {
      let name = U.sanitizeFilename(String(raw || 'image.jpg').split('/').pop() || 'image.jpg');
      if (!used.has(name)) { used.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (used.has(stem + '_' + n + ext)) n++;
      const out = stem + '_' + n + ext;
      used.add(out);
      return out;
    }

    async function saveSelectedZip() {
      const items = state.all.filter((c) => state.selected.has(c.id));
      if (!items.length) { toast(t('pop.saveNothing')); return; }
      if (!IH.Zip || typeof IH.Zip.build !== 'function') return;

      const zipBtn = $('btnSaveZip');
      if (zipBtn) zipBtn.disabled = true;
      toast(t('pop.zipPacking', { n: items.length }));

      const settings = Store.getSettings();
      const usedNames = new Set();
      const entries = [];
      let failed = 0;

      for (let i = 0; i < items.length; i++) {
        const c = items[i];
        const rawName = U.buildFilename(c, settings, i + 1);
        let bytes = null;
        if (U.isDataUrl(c.url)) {
          bytes = dataUrlToBytes(c.url);
        } else {
          const res = await U.sendToBg({
            type: MSG.FETCH_IMAGE,
            payload: { url: c.url, pageUrl: state.pageUrl || '' }
          });
          if (res && res.ok && res.dataUrl) bytes = dataUrlToBytes(res.dataUrl);
        }
        if (bytes && bytes.length) {
          entries.push({ name: uniqueZipName(rawName, usedNames), data: bytes });
        } else {
          failed++;
        }
      }

      if (zipBtn) zipBtn.disabled = state.selected.size === 0;
      if (!entries.length) {
        toast(t('pop.zipEmpty'), 'err');
        return;
      }

      const zipBytes = IH.Zip.build(entries);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      const blobUrl = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const host = (state.targetCount > 1
        ? 'merged_' + state.targetCount + 'pages'
        : (U.prettyHost(state.pageUrl) || 'images'));
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = host + '_' + stamp + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ } }, 10000);

      toast(failed
        ? t('pop.zipDonePartial', { n: entries.length, failed })
        : t('pop.zipDone', { n: entries.length }), 'ok');
    }

    function renderProgress() {
      const p = state.progress;
      if (!p || p.status === 'idle') {
        $('progress').hidden = true;
        return;
      }
      $('progress').hidden = false;

      const finished = (p.done || 0) + (p.failed || 0) + (p.skipped || 0);
      const total = Math.max(p.total || 0, finished);
      const pct = total ? Math.round((finished / total) * 100) : 0;
      $('progressFill').style.width = pct + '%';
      /* progressbar 角色的数值状态：读屏器可以随时查询「现在到哪儿了」，
         不需要我们主动把每一张都念出来（那会吵得没法用）。 */
      const bar = $('progress');
      if (bar) bar.setAttribute('aria-valuenow', String(pct));

      /* 只在「开始」和「结束」各播报一句 —— 中间过程交给上面的 aria-valuenow。 */
      if (p.status === 'running' && lastProgressStatus !== 'running') {
        announce(t('pop.savingStart', { n: total }));
      } else if (p.status !== 'running' && lastProgressStatus === 'running') {
        announce(t('pop.saveEnd', { n: p.done || 0 })
          + (p.failed ? t('pop.saveEndFailed', { n: p.failed }) : '')
          + (p.skipped ? t('pop.saveEndSkipped', { n: p.skipped }) : ''));
      }
      lastProgressStatus = p.status;

      const parts = [];
      if (p.status === 'running') parts.push(t('pop.stRunning'));
      else if (p.status === 'done') parts.push(t('pop.stDone'));
      else if (p.status === 'cancelled') {
        // 停止后还在飞的那几张会照常落盘，进度条上得写明白
        parts.push(p.active ? t('pop.stStoppedActive', { n: p.active }) : t('pop.stStopped'));
      }

      parts.push(finished + ' / ' + total);
      if (p.done) parts.push(t('pop.pDone', { n: p.done }));
      if (p.failed) parts.push(t('pop.pFailed', { n: p.failed }));
      if (p.skipped) parts.push(t('pop.pSkipped', { n: p.skipped }));
      $('progressText').textContent = parts.join(' · ');

      if (p.status !== 'running') {
        clearTimeout(progressTimer);
        progressTimer = setTimeout(() => { $('progress').hidden = true; }, 4000);
      }
    }

    /* ------------------------------------------------------------------ *
     * 导出清单
     * ------------------------------------------------------------------ */

    function exportList(format) {
      const fmt = format === 'csv' ? 'csv' : 'json';
      // 判断「有没有图」要用 state.all；导出的是「当前筛选结果」。
      // 原来写成 `state.filtered.length ? state.filtered : state.all`，
      // 结果用户把条件筛到 0 张时点导出，拿到的是**全部图片**的清单。
      if (!state.all.length) { toast(t('pop.exportNothing')); return; }
      const list = state.filtered;
      if (!list.length) {
        toast(t('pop.exportEmpty'), 'err');
        return;
      }

      /* CSV / JSON 的表头。中英文下**列名要跟着变**，导出的是给人看的清单；
         键写英文，值才是翻译 —— 否则切了语言导出的表头还是中文。 */
      const rows = list.map((c, i) => ({
        [t('pop.csvIndex')]: i + 1,
        [t('pop.csvFilename')]: fileNameOf(c.url),
        [t('pop.csvWidth')]: c.width || '',
        [t('pop.csvHeight')]: c.height || '',
        [t('pop.csvBytes')]: state.sizes[c.url] != null ? state.sizes[c.url] : '',
        [t('pop.csvType')]: c.type || U.extFromUrl(c.url),
        [t('pop.csvSource')]: (c.allSources || [c.source]).map((s) => I18n.sourceLabel(s)).join('/'),
        [t('pop.csvRestored')]: c.restored ? t('cmn.yes') : t('cmn.no'),
        [t('pop.csvHost')]: c.host || '',
        /* 合并嗅探时，一条记录属于哪个页面必须写出来 ——
           否则导出之后这一列信息就永久丢了（用户没法再从别的渠道还原出来）。
           单页扫描时它就是 state.pageUrl，等于多一列常量，无害。 */
        [t('pop.csvPageUrl')]: c.pageUrl || state.pageUrl || '',
        [t('pop.csvUrl')]: c.url
      }));

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const base = (state.targetCount > 1
        ? 'merged_' + state.targetCount + 'pages'
        : (U.prettyHost(state.pageUrl) || 'page')) + '_' + stamp;

      if (fmt === 'csv') {
        const headers = Object.keys(rows[0]);
        const csv = [headers.join(',')].concat(rows.map((r) =>
          headers.map((h) => {
            let v = String(r[h] == null ? '' : r[h]);
            if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
            v = v.replace(/"/g, '""');
            return /[",\r\n]/.test(v) ? '"' + v + '"' : v;
          }).join(',')
        )).join('\r\n');
        U.downloadText(base + '.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
      } else {
        U.downloadText(base + '.json', JSON.stringify(rows, null, 2), 'application/json');
      }
      toast(t('pop.exported', { n: rows.length, fmt: fmt.toUpperCase() }), 'ok');
    }

    return { probeSizes, saveSelected, saveSelectedZip, renderProgress, exportList };
  }

  IH.PopupActions = { create };
})();
