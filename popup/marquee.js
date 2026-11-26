/* ==========================================================================
 * ImageHunter — popup/marquee.js
 * 网格框选（拖拽画框多选 + 自动滚动 + 几何快照缓存）
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});

  const DRAG_THRESHOLD = 4;   // 位移阈值（px），小于它仍视为单击
  const SCROLL_EDGE = 44;     // 距边缘多少像素开始自动滚动
  const SCROLL_SPEED = 16;    // 自动滚动速度（px / 帧）

  /**
   * 创建框选控制器。
   * @param {object} ctx
   * @param {Function} ctx.$
   * @param {object}   ctx.state
   * @param {Function} ctx.t
   * @param {Function} ctx.toast
   * @param {Function} ctx.updateStats
   * @param {Function} ctx.syncSelectionUI
   * @param {Function} ctx.scheduleFill
   * @param {Function} ctx.cancelFill
   * @param {Function} ctx.hasMoreToRender  () => boolean (renderedCount < state.filtered.length)
   */
  function create(ctx) {
    const {
      $, state, t, toast, updateStats, syncSelectionUI,
      scheduleFill, cancelFill, hasMoreToRender
    } = ctx;

    /**
     * 框选（拖拽画框多选）状态机。
     * 坐标一律用「grid-wrap 内容坐标系」（client 坐标 - wrap 位置 + wrap 滚动量），
     * 这样无论是弹窗内网格滚动，还是独立页整页滚动，遮罩层都能贴在正确的图片上。
     *
     * 默认语义是**切换**：框内已勾选的取消、未勾选的勾上。
     * 于是「多次框选不同区域」天然是累加，而「框回已选区域」就是反选取消。
     */
    const marquee = {
      armed: false,          // 已按下鼠标，等待位移超过阈值
      dragging: false,       // 已真正进入框选
      sx: 0, sy: 0,          // 起点
      cx: 0, cy: 0,          // 当前点
      mode: 'toggle',        // toggle（默认）/ add（Ctrl 只加）/ sub（Alt 只减）
      base: null,            // 按下时的选择快照，供三种语义使用
      hits: new Set(),       // 当前落入选框的卡片 id
      preview: null,         // 松手后将要生效的选择集合
      pointer: { x: 0, y: 0 },  // 最近一次指针的 client 坐标（自动滚动用）
      geom: null,            // 拖拽期间的卡片几何快照（见 buildMarqueeGeom）
      raf: null
    };

    /** 框选要滚动哪个容器：网格自身能滚就用网格，否则（独立页）用整页 */
    function scrollerOf() {
      const wrap = $('gridWrap');
      if (!wrap) return document.scrollingElement || document.documentElement;
      return wrap.scrollHeight > wrap.clientHeight + 2
        ? wrap
        : (document.scrollingElement || document.documentElement);
    }

    /** client 坐标 → grid-wrap 内容坐标 */
    function toLocal(clientX, clientY) {
      const wrap = $('gridWrap');
      const r = wrap.getBoundingClientRect();
      return {
        x: clientX - r.left + wrap.scrollLeft,
        y: clientY - r.top + wrap.scrollTop
      };
    }

    function marqueeRect() {
      const x1 = Math.min(marquee.sx, marquee.cx);
      const y1 = Math.min(marquee.sy, marquee.cy);
      const x2 = Math.max(marquee.sx, marquee.cx);
      const y2 = Math.max(marquee.sy, marquee.cy);
      return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
    }

    /* ---- 框选几何缓存 ----
       拖拽时每一帧都要判断「哪些卡片落进了选框」。最直白的写法是每帧遍历所有
       已渲染卡片、逐个 getBoundingClientRect()，但那是**每帧 N 次强制布局**：
       上千张卡片时，一次拖拽要跑几十帧 × 上千次，掉帧非常明显。

       做法改成分两步：
         1) 按下鼠标（或自动滚动把新卡片带进视口）时，取一次几何快照
         2) 拖动过程只做纯数学比较，不再碰 DOM

       坐标系与 toLocal() 一致 —— 都是「相对 gridWrap 内容原点（含滚动偏移）」，
       这样自动滚动时选框与卡片一起平移，不需要重算卡片位置。
       卡片尺寸由 CSS 决定（.thumb 是 aspect-ratio: 4/3 + width:100%），
       与图片是否加载完成无关，所以快照在布局不变期间一直有效。

       快照失效的三种情况，都显式清掉（见 invalidateGeom）：
         - 网格重渲染 / 分片补全追加了新卡片（换行可能让最后一行重排）
         - 窗口尺寸变化（列宽变了，卡片位置全变）
         - 筛选/排序变化 */
    function invalidateGeom() {
      marquee.geom = null;
    }

    function buildMarqueeGeom() {
      const wrap = $('gridWrap');
      const grid = $('grid');
      if (!wrap || !grid) return null;

      // 基准偏移：offsetTop/offsetLeft 是相对「offsetParent 内容盒」的，
      // 而 toLocal() 用的是 border box 原点。两者的差 = gridWrap 的 padding，
      // 但这里**不写死 padding 数值**，而是拿第一张卡片实测一次求差 —— 以后改 CSS 也不会算错。
      const cards = grid.querySelectorAll('.card');
      const wr = wrap.getBoundingClientRect();
      const baseX = wr.left + wrap.scrollLeft;
      const baseY = wr.top + wrap.scrollTop;

      const list = new Array(cards.length);
      let offX = null, offY = null;
      for (let i = 0; i < cards.length; i++) {
        const el = cards[i];
        // offsetParent 不是 gridWrap 时（理论上不该发生）就没有可信的 offset 坐标，
        // 退回逐张 rect —— 慢一点，但不能算错。
        if (el.offsetParent !== wrap) return null;
        if (offX === null) {
          const cr = el.getBoundingClientRect();
          offX = (cr.left + wrap.scrollLeft) - baseX - el.offsetLeft;
          offY = (cr.top + wrap.scrollTop) - baseY - el.offsetTop;
        }
        list[i] = {
          id: el.dataset.id,
          el,
          x: el.offsetLeft + offX,
          y: el.offsetTop + offY,
          w: el.offsetWidth,
          h: el.offsetHeight
        };
      }
      return list;
    }

    function marqueeGeom() {
      if (!marquee.geom) marquee.geom = buildMarqueeGeom();
      return marquee.geom;
    }

    /* 只刷新已渲染卡片的选中态（不重建网格）。
       传了 geom（框选的几何快照）就直接用里面缓存的元素引用 —— 省掉一次
       querySelectorAll('.card') 全量查询；框选热路径上这已经是第二次遍历了。 */
    function paintSelection(set, geom) {
      if (geom) {
        for (let i = 0; i < geom.length; i++) {
          const el = geom[i].el;
          const on = set.has(geom[i].id);
          // 只在真的变了的时候写 DOM：框选热路径上每帧都要走这里，
          // 无条件 classList.toggle + setAttribute 是白白的开销
          if (el.classList.contains('selected') !== on) {
            el.classList.toggle('selected', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
          }
        }
        return;
      }
      const grid = $('grid');
      if (!grid) return;
      Array.prototype.forEach.call(grid.querySelectorAll('.card'), (card) => {
        const on = set.has(card.dataset.id);
        card.classList.toggle('selected', on);
        card.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    /** 根据修饰键决定本次框选的语义 */
    function modeOf(e) {
      if (e.ctrlKey || e.metaKey) return 'add';   // 只加不减
      if (e.altKey) return 'sub';                 // 只减不加
      return 'toggle';                            // 默认：已选→取消，未选→勾上
    }

    /**
     * 拖拽结束后，浏览器会紧接着在鼠标抬起的位置补发一次 click，
     * 如果不拦，会把那张卡片点反（刚框选完就被取消）。
     *
     * 拦截必须用「捕获阶段的一次性监听」，**不能用标志位 + setTimeout(0)**：
     * 后台标签页里 Chrome 会把定时器节流到至少 1 秒，等 click 到达时标志位还没清掉，
     * 于是这一次真实的点击也被误吞了（实测过，很隐蔽）。
     * 捕获监听在 click 派发的同一轮里同步执行，与定时器无关，确定可靠。
     */
    function swallowNextClick() {
      const swallow = (ev) => {
        ev.stopPropagation();          // 别让事件走到 #grid 上的委托监听
        window.removeEventListener('click', swallow, true);
      };
      window.addEventListener('click', swallow, true);
      // 兜底：万一这次交互压根没产生 click，别把监听器永久挂着
      setTimeout(() => window.removeEventListener('click', swallow, true), 400);
    }

    /** 按下鼠标：进入「预备框选」，位移超过阈值才真正开始 */
    function onPointerDown(e) {
      if (e.button !== 0 || e.isPrimary === false) return;
      // 按钮、状态层上按下不参与框选
      if (e.target.closest && e.target.closest('.pick, .zoom, .restore, .tbtn, .state')) return;
      const wrap = $('gridWrap');
      if (!wrap || !$('marquee')) return;

      const p = toLocal(e.clientX, e.clientY);
      marquee.armed = true;
      marquee.dragging = false;
      marquee.sx = p.x; marquee.sy = p.y;
      marquee.cx = p.x; marquee.cy = p.y;
      marquee.pointer.x = e.clientX; marquee.pointer.y = e.clientY;
      marquee.mode = modeOf(e);
      marquee.base = new Set(state.selected);
      marquee.hits = new Set();
      marquee.preview = null;
      // 每次开始新的拖拽都丢掉上次的快照：期间可能补过卡片、也可能改过筛选
      invalidateGeom();

      /* 拖拽期间**冻结分片补全**。两个理由，缺一不可：
         1) 正确性：拖动时网格还在往后面塞卡片，用户看到一个不断变长的列表，
            「此刻松手会选中哪些」变得不可预测 —— 而且要选中新补出来的卡片，
            几何快照就得每帧重建，优化也就白做了。
         2) 性能：补全和拖拽都在 rAF 上跑，叠在一起必然掉帧。
         冻结点是「按下鼠标」（还没真正进拖拽），松手/取消时恢复；
         如果从头到尾没超过位移阈值（就是一次普通单击），恢复时也会立刻续上。 */
      cancelFill();

      window.addEventListener('pointermove', onWindowPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    }

    function onWindowPointerMove(e) {
      if (!marquee.armed) return;
      marquee.pointer.x = e.clientX; marquee.pointer.y = e.clientY;

      const p = toLocal(e.clientX, e.clientY);
      marquee.cx = p.x; marquee.cy = p.y;

      if (!marquee.dragging) {
        if (Math.abs(p.x - marquee.sx) < DRAG_THRESHOLD &&
            Math.abs(p.y - marquee.sy) < DRAG_THRESHOLD) return;
        marquee.dragging = true;
        document.body.classList.add('ih-selecting');
        $('marquee').hidden = false;
        startAutoScroll();
      }

      // 修饰键可在拖拽过程中随时改变语义
      marquee.mode = modeOf(e);
      paintMarquee();
    }

    function onPointerUp() {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      stopAutoScroll();

      /* 解除「拖拽期间冻结分片补全」（见 onPointerDown）。
         必须放在下面那个 early return **之前** —— 按下鼠标但没拖动（就是一次单击）
         的路径也会走到这里，那时同样要恢复补全，否则列表就永远停在半截了。 */
      if (hasMoreToRender()) scheduleFill();

      if (!marquee.armed) return;
      const wasDragging = marquee.dragging;
      marquee.armed = false;
      marquee.dragging = false;
      document.body.classList.remove('ih-selecting');
      if ($('marquee')) $('marquee').hidden = true;

      if (wasDragging) swallowNextClick();   // 吃掉紧跟着的那次合成 click

      if (wasDragging && marquee.preview) {
        state.selected = marquee.preview;
        paintSelection(state.selected);
        updateStats();
        const n = state.selected.size;
        if (!marquee.hits.size) toast(t('pop.marqueeMiss'));
        else if (marquee.mode === 'add') toast(t('pop.marqueeAdd', { n }));
        else if (marquee.mode === 'sub') toast(t('pop.marqueeSub', { n }));
        else toast(n ? t('pop.marqueeToggle', { n }) : t('pop.marqueeCleared'));
      }
      marquee.preview = null;
      marquee.base = null;
      marquee.hits = new Set();
    }

    /** 计算「此刻松手会得到什么」，并刷新遮罩层 / 卡片高亮 / 计数 */
    function paintMarquee() {
      const rect = marqueeRect();
      const el = $('marquee');
      if (el) {
        el.style.left = rect.x1 + 'px';
        el.style.top = rect.y1 + 'px';
        el.style.width = rect.w + 'px';
        el.style.height = rect.h + 'px';
        el.dataset.mode = marquee.mode;
      }

      /* 用几何快照做纯数学比较，不再每帧逐卡 getBoundingClientRect（见 buildMarqueeGeom）。
         快照拿不到时（布局异常）退回逐张 rect，慢但不会算错。 */
      const geom = marqueeGeom();
      const hits = new Set();
      if (geom) {
        for (let i = 0; i < geom.length; i++) {
          const g = geom[i];
          if (!(g.x + g.w < rect.x1 || g.x > rect.x2 ||
                g.y + g.h < rect.y1 || g.y > rect.y2)) {
            hits.add(g.id);
          }
        }
      } else {
        const wrap = $('gridWrap');
        const wr = wrap.getBoundingClientRect();
        Array.prototype.forEach.call($('grid').querySelectorAll('.card'), (card) => {
          const cr = card.getBoundingClientRect();
          const x = cr.left - wr.left + wrap.scrollLeft;
          const y = cr.top - wr.top + wrap.scrollTop;
          const overlap = !(x + cr.width < rect.x1 || x > rect.x2 ||
                            y + cr.height < rect.y1 || y > rect.y2);
          if (overlap) hits.add(card.dataset.id);
        });
      }
      marquee.hits = hits;

      // 从「按下鼠标时的快照」出发重新算，所以拖拽过程中来回扫不会反复翻转
      const next = new Set(marquee.base);
      hits.forEach((id) => {
        if (marquee.mode === 'add') next.add(id);
        else if (marquee.mode === 'sub') next.delete(id);
        else if (next.has(id)) next.delete(id);   // toggle：已选 → 取消
        else next.add(id);                        // toggle：未选 → 勾上
      });
      marquee.preview = next;

      paintSelection(next, geom);

      const cnt = $('mqCount');
      if (cnt) {
        const sign = marquee.mode === 'add' ? '+' : (marquee.mode === 'sub' ? '−' : '');
        cnt.textContent = sign + next.size;
      }
      // 底部计数实时预览，松手即生效
      $('statSelected').textContent = String(next.size);
      $('saveCount').textContent = String(next.size);
      $('btnSave').disabled = next.size === 0;
    }

    /** Esc 放弃本次框选，选择状态回到按下鼠标之前 */
    function cancel() {
      stopAutoScroll();
      const wasDragging = marquee.dragging;
      marquee.armed = false;
      marquee.dragging = false;
      marquee.preview = null;
      // Esc 也会走到这里，同样要解除「拖拽期间冻结分片补全」
      if (hasMoreToRender()) scheduleFill();
      document.body.classList.remove('ih-selecting');
      if ($('marquee')) $('marquee').hidden = true;
      paintSelection(state.selected);
      syncSelectionUI();
      if (wasDragging) swallowNextClick();
    }

    /* 拖到网格边缘时自动滚动，方便一次框选很长的列表 */
    function startAutoScroll() {
      if (marquee.raf) return;
      marquee.raf = requestAnimationFrame(autoScrollStep);
    }

    function stopAutoScroll() {
      if (marquee.raf) {
        cancelAnimationFrame(marquee.raf);
        marquee.raf = null;
      }
    }

    function autoScrollStep() {
      marquee.raf = null;
      if (!marquee.dragging) return;

      const sc = scrollerOf();
      const isWrap = sc === $('gridWrap');
      const box = isWrap ? sc.getBoundingClientRect()
                         : { top: 0, bottom: window.innerHeight };

      let dy = 0;
      if (marquee.pointer.y < box.top + SCROLL_EDGE) {
        dy = -SCROLL_SPEED * Math.min(1, (box.top + SCROLL_EDGE - marquee.pointer.y) / SCROLL_EDGE);
      } else if (marquee.pointer.y > box.bottom - SCROLL_EDGE) {
        dy = SCROLL_SPEED * Math.min(1, (marquee.pointer.y - (box.bottom - SCROLL_EDGE)) / SCROLL_EDGE);
      }

      if (dy) {
        sc.scrollTop += dy;
        const p = toLocal(marquee.pointer.x, marquee.pointer.y);
        marquee.cx = p.x; marquee.cy = p.y;
        paintMarquee();
      }
      marquee.raf = requestAnimationFrame(autoScrollStep);
    }

    return {
      isArmed: () => marquee.armed,
      isDragging: () => marquee.dragging,
      paintSelection,
      invalidateGeom,
      onPointerDown,
      onPointerUp,
      cancel
    };
  }

  IH.PopupMarquee = { create };
})();
