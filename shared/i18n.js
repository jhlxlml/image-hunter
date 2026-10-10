/* ==========================================================================
 * ImageHunter — shared/i18n.js
 * 界面文案与中英切换
 *
 * 为什么不用 chrome.i18n：
 *   `chrome.i18n.getMessage()` 的语言**只能跟随浏览器界面语言**，用户在扩展里
 *   自己选一个语言这件事它做不到 —— 要「可中英切换」就只能自己实现一层。
 *   `_locales/` 那两份仍然保留：扩展名称、描述、快捷键说明、右键菜单文案归它管
 *   （那些是 manifest / 浏览器原生 UI 渲染的，轮不到页面脚本）。
 *   所以这里是**第二套**，只管页面内的界面文案。
 *
 * 用法：
 *   IH.I18n.t('pop.saveSelected')                  → 当前语言的文案
 *   IH.I18n.t('pop.total', { n: 12 })              → 带占位符
 *   IH.I18n.apply(document)                        → 填充页面上所有 data-i18n
 *   IH.I18n.setLang('en')                          → 切换并落盘（走 Store）
 *
 * 降级顺序：当前语言 → 中文 → key 本身。
 * 中文是**写死在这里**的「原文」，不是从别处读的 —— 所以新增文案时，
 * 英文漏了不会白屏，只是那一处退回中文（比显示 key 好排查）。
 *
 * 加载顺序：必须在 store.js **之后**（要读 settings.uiLang）。
 * ========================================================================== */
(function () {
  'use strict';

  const IH = (globalThis.IH = globalThis.IH || {});
  if (IH.I18n) return;

  /* ------------------------------------------------------------------ *
   * 语言判定
   * ------------------------------------------------------------------ */

  /** 浏览器语言。'zh'、'zh-CN'、'zh-TW' 都算中文，其余一律英文 */
  function detect() {
    try {
      const l = String(navigator.language || '').toLowerCase();
      if (l.indexOf('zh') === 0) return 'zh';
    } catch (e) { /* 没有 navigator 的上下文（如纯 vm 测试） */ }
    return 'en';
  }

  /** 当前生效的语言：设置里选了就用选的，'auto' 或没设就跟随浏览器 */
  function lang() {
    let v = null;
    try {
      const s = IH.Store && IH.Store.getSettings ? IH.Store.getSettings() : null;
      v = s ? s.uiLang : null;
    } catch (e) { /* Store 还没加载完 */ }
    if (!v || v === 'auto') return detect();
    return (v === 'zh' || v === 'en') ? v : detect();
  }

  /** 切换语言并落盘。返回 Promise（走 Store.updateSettings 串行写） */
  function setLang(v) {
    const next = (v === 'zh' || v === 'en' || v === 'auto') ? v : 'auto';
    if (IH.Store && IH.Store.updateSettings) {
      return IH.Store.updateSettings({ uiLang: next });
    }
    return Promise.resolve();
  }

  /* ------------------------------------------------------------------ *
   * 取词
   * ------------------------------------------------------------------ */

  function t(key, args) {
    const l = lang();
    let s = null;
    if (STRINGS[l]) s = STRINGS[l][key];
    if (s == null && STRINGS.zh) s = STRINGS.zh[key];
    if (s == null) return key;

    if (args) {
      Object.keys(args).forEach((k) => {
        s = s.split('{' + k + '}').join(String(args[k]));
      });
    }
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 填充页面
   *
   * 三种属性：
   *   data-i18n             → textContent（纯文案）
   *   data-i18n-html        → innerHTML（文案里含 <code> 这类标记时用）
   *   data-i18n-ph          → placeholder
   *   data-i18n-aria        → aria-label + title（两者通常写同一句）
   * ------------------------------------------------------------------ */

  function apply(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;

    const each = (sel, fn) => {
      Array.prototype.forEach.call(scope.querySelectorAll(sel), fn);
    };

    each('[data-i18n]', (el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    each('[data-i18n-html]', (el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    each('[data-i18n-ph]', (el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    each('[data-i18n-aria]', (el) => {
      const v = t(el.getAttribute('data-i18n-aria'));
      el.setAttribute('aria-label', v);
      el.setAttribute('title', v);
    });
    each('[data-i18n-title]', (el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    // <html lang>：让浏览器按正确语言渲染 / 读屏器用正确的语音
    if (scope.documentElement) {
      scope.documentElement.setAttribute('lang', lang() === 'zh' ? 'zh-CN' : 'en');
    }
  }

  /* ------------------------------------------------------------------ *
   * 文案表
   * ------------------------------------------------------------------ */

  const STRINGS = {};

  /* ---------------------------- 中文 ---------------------------- */
  STRINGS.zh = {
    /* ---- 通用 ---- */
    'cmn.cancel': '取消',
    'cmn.close': '关闭',
    'cmn.save': '保存',
    'cmn.saved': '已保存',
    'cmn.clear': '清空',
    'cmn.reset': '重置',
    'cmn.all': '全部',
    'cmn.view': '查看',
    'cmn.export': '导出',
    'cmn.import': '导入',
    'cmn.test': '测试',
    'cmn.light': '浅色',
    'cmn.dark': '深色',
    'cmn.auto': '跟随系统',
    'cmn.yes': '是',
    'cmn.no': '否',
    'cmn.retry': '重试',
    'cmn.and': ' 和 ',
    'cmn.loading': '加载中…',
    'cmn.unknown': '未知',
    'cmn.unknownError': '未知错误',
    'cmn.noFilter': '不过滤',

    /* ---- 设置页 ---- */
    'opt.title': '图片猎人 · 设置',
    'opt.sub': '悬停一键存原图 · 全页嗅探 · 批量下载高清大图',
    'opt.reset': '恢复默认',

    'opt.lang': '界面语言',
    'opt.langHint': '选择界面显示的语言，切换后立即生效。默认跟随浏览器',
    'opt.langAuto': '跟随浏览器',
    'opt.langZh': '中文',
    'opt.langEn': 'English',

    'opt.general': '通用',
    'opt.generalSub': '界面外观与基础偏好',
    'opt.theme': '主题',
    'opt.themeHint': '亮暗模式与配色方案，影响图库、页内面板与设置页',

    'opt.themeMode': '亮暗模式',
    'opt.themePreset': '配色方案',
    'opt.themePresetHint': '整体色调。六套预设各自自带浅色与深色两档主色',
    'opt.themeAccent': '自定义主色',
    'opt.themeAccentHint': '覆盖配色方案的主色。其余深浅色与投影会自动跟随',
    'opt.themeAccentAuto': '跟随配色方案',
    'opt.themeAccentPick': '选一个颜色',
    'opt.themeAccentReset': '恢复跟随配色方案',
    'opt.themePreview': '预览',
    /* 预设名字。为什么不放进 theme.js 的 PRESETS 里：
       那里已经有 zh / en 两个字段，但界面文案的**唯一入口**是这张表 ——
       两处都存一份就是又一次「两份会漂移的副本」。
       这里按 preset 的 key 拼出键名（opt.preset.indigo 等）。 */
    'opt.preset.indigo': '靛蓝',
    'opt.preset.teal': '青碧',
    'opt.preset.emerald': '翡翠',
    'opt.preset.rose': '玫红',
    'opt.preset.amber': '琥珀',
    'opt.preset.slate': '石板',

    'opt.scan': '嗅探范围',
    'opt.scanSub': '决定「能发现哪些图片」。开启得越多，越不容易漏图',
    'opt.restore': '原图还原（推荐）',
    'opt.restoreHint': '把缩略图地址改写成原图地址。所有候选都会真实加载验证，只有像素更大才采用',
    'opt.scanImg': '页面图片',
    'opt.scanImgHint': '扫描 <img> 元素（含 srcset / 懒加载属性）。关掉后只看背景图、链接等其它来源',
    'opt.scanBg': 'CSS 背景图',
    'opt.scanBgHint': '扫描元素的计算样式中的 background-image',
    'opt.scanPseudo': '伪元素背景图',
    'opt.scanPseudoHint': '扫描 ::before / ::after 上的背景图（更耗性能）',
    'opt.scanPoster': '视频封面',
    'opt.scanPosterHint': '扫描 <video> 的 poster 属性',
    'opt.scanSvg': '内联 SVG',
    'opt.scanSvgHint': '把页面里的 SVG 图形转成可保存的图片',
    'opt.scanLinks': '链接指向的图片',
    'opt.scanLinksHint': '扫描 <a href> 指向的图片文件',
    'opt.scanPreload': '预加载图片',
    'opt.scanPreloadHint': '扫描 <link rel="preload" as="image">',
    'opt.scanOg': '社交分享主图',
    'opt.scanOgHint': '扫描 og:image / twitter:image',
    'opt.probeConc': '尺寸探测并发数',
    'opt.probeConcHint': '同时探测多少张图片的真实分辨率，过大可能拖慢页面',
    'opt.probeTimeout': '单张探测超时',
    'opt.probeTimeoutHint': '超过该时间未加载成功即放弃，单位毫秒',
    'opt.mergeTabs': '多标签页合并嗅探',
    'opt.mergeTabsHint': '打开后，图库顶部的「扫描目标」可以一次勾选多个标签页，把它们上面的图片合并成一份列表（按图片地址去重，卡片标出来自哪个页面）。关闭时只扫当前选中的那一页',

    'opt.rules': '原图还原规则',
    'opt.rulesSub': '内置规则覆盖 WordPress、Cloudinary、七牛、阿里 OSS、又拍云、淘宝 CDN 等常见场景。可追加你自己的规则',
    'opt.rulesBuiltin': '内置规则',
    'opt.rulesCustom': '自定义规则',
    'opt.rulesAdd': '+ 添加规则',
    'opt.rulesDebug': '规则调试',
    'opt.rulesTestPh': '粘贴一个缩略图地址，例如 https://blog.x.com/wp-content/uploads/2024/05/hero-1024x768.jpg',

    'opt.dl': '下载',
    'opt.dlSub': '保存行为、命名与鲁棒性',
    'opt.dlConc': '同时下载数',
    'opt.dlConcHint': '并发过高可能被站点限流',
    'opt.dlRetries': '失败重试次数',
    'opt.dlRetriesHint': '单张图片下载失败后的重试次数',
    'opt.dlSkip': '跳过已下载',
    'opt.dlSkipHint': '对相同图片地址 + 尺寸做指纹记录，避免重复保存',
    'opt.dlFallback': '防盗链降级（推荐）',
    'opt.dlFallbackHint': '直链下载失败时，改用扩展页拉取图片再保存，可绕过部分站点的 403 限制',
    'opt.dlTemplate': '文件名模板',
    'opt.dlTemplateHint': '可用变量：{name} 原文件名 · {ext} 扩展名 · {index} 序号 · {host} 站点 · {w} {h} 尺寸 · {date} 日期。模板里写 <code>/</code> 也会当成子目录',
    'opt.dlSubfolder': '保存到子目录',
    'opt.dlSubfolderHint': '留空即直接存到下载目录。可用变量：<code>{host}</code> 站点 · <code>{date}</code> 日期 · <code>{index}</code> 序号。例：<code>{host}</code> → 每个站点一个文件夹；<code>{date}/{host}</code> → 按日期再分站点',
    'opt.dlSubfolderPh': '留空 = 下载目录根',
    'opt.dlBatchPrefix': '批量下载加序号前缀',
    'opt.dlBatchPrefixHint': '勾选后文件名形如 <code>001_photo.jpg</code>，保持下载顺序',

    'opt.ux': '交互',
    'opt.uxSub': '悬停下载图标与大图预览',
    'opt.uxHover': '图片右上角下载图标',
    'opt.uxHoverHint': '鼠标悬停在图片上时，右上角浮现圆形下载按钮，单击直接保存原图',
    'opt.uxHoverDelay': '图标出现延迟',
    'opt.uxHoverDelayHint': '避免鼠标快速划过时图标闪烁',
    'opt.uxMinSize': '最小显示尺寸',
    'opt.uxMinSizeHint': '小于该边长的图片不显示下载图标，用于排除小图标与分隔条',
    'opt.uxLightboxMin': '大图预览最小尺寸',
    'opt.uxLightboxMinHint': '大图预览里只翻到短边不小于该值的图片（按图片真实像素判定，0 为不过滤）。仅影响预览，图库列表与批量下载不受影响',
    'opt.uxAltClick': 'Alt + 点击直接保存',
    'opt.uxAltClickHint': '无需先悬停出图标，按住 Alt 点击图片即可保存原图',
    'opt.uxShortcut': '面板快捷键',
    'opt.uxShortcutHint': '默认 Alt+Shift+S，可在浏览器扩展快捷键页面修改',
    'opt.uxOpenShortcut': '打开快捷键设置',

    'opt.block': '站点排除列表',
    'opt.blockSub': '这些站点上不显示悬停按钮、不响应 Alt+点击、也不打开页内面板',
    'opt.blockList': '已排除的站点',
    'opt.blockListHint': '每行一个域名。一条记录会同时匹配它自己和它的所有子域名 —— 写 <code>example.com</code> 即可覆盖 <code>www.example.com</code>；直接粘贴完整网址（<code>https://example.com/photo</code>）也会自动取出域名。',
    'opt.blockLimits': '这个列表管不到的地方',
    'opt.blockLimitsHint': '扩展的文件在所有网页上都会被加载（Manifest V3 的 <code>content_scripts</code> 是静态声明，没有按站点跳过加载的办法），这里关掉的是<b>界面行为</b>：悬停按钮、Alt+点击、页内面板，以及自动扫描。右键菜单里的「保存这张图片」仍然可用 —— 那是你自己点出来的，不算打扰。',

    'opt.data': '数据与统计',
    'opt.dataSub': '下载记录、去重指纹与设置备份',
    'opt.stSaved': '累计保存',
    'opt.stFailed': '失败',
    'opt.stBytes': '累计体积',
    'opt.stHistory': '历史记录',
    'opt.stFp': '去重指纹',
    'opt.history': '下载历史',
    'opt.historyHint': '最近 500 条保存记录',
    'opt.clearHistory': '清除下载历史',
    'opt.clearHistoryHint': '不影响已保存的文件',
    'opt.clearFp': '清除去重指纹',
    'opt.clearFpHint': '清除后，之前下载过的图片会重新被允许下载',
    'opt.backup': '备份设置',
    'opt.backupHint': '导出为 JSON 文件，或从文件导入',
    'opt.diag': '导出诊断包',
    'opt.diagHint': '版本、平台、当前设置、最近 20 条下载记录、最近一次扫描统计。只含聚合数字与主机名，不含图片地址与页面地址',

    'opt.footer': '图片猎人 ImageHunter {version} · 所有图片均以原始分辨率保存',
    'opt.footerNote': '界面支持中文与英文，可在上方「界面语言」切换',
    'opt.modalHistory': '下载历史',

    /* ---- 设置页：运行时提示（confirm / toast） ---- */
    'opt.resetConfirm': '确定要把所有设置恢复为默认值吗？',
    'opt.resetConfirmExtra': '这会同时删除你添加的 {extra}，且无法撤销。',
    'opt.ruleCount': '{n} 条自定义还原规则',
    'opt.blockCount': '{n} 个排除站点',
    'opt.restored': '已恢复默认设置',
    'opt.exported': '设置已导出',
    'opt.diagMissing': '诊断模块未加载，请重新加载扩展',
    'opt.diagAuditFail': '诊断包自查未通过（{n} 处地址未清洗），已中止导出',
    'opt.diagExported': '诊断包已导出（{n} 条下载记录）',
    'opt.imported': '设置已导入',
    'opt.importedRules': '设置已导入（含 {n} 条自定义还原规则）',
    'opt.importFail': '导入失败：{msg}',
    'opt.historyCleared': '下载历史已清除',
    'opt.fpCleared': '去重指纹已清除',
    'opt.exportFail': '导出失败：{msg}',
    'opt.initFail': '初始化失败：{msg}',

    /* ---- 设置页：动态生成的内容 ----
     * 规则编辑器、排除列表即时反馈、历史表格、规则调试器。
     * 这些是 JS 拼出来的，不在 data-i18n 里，切换语言时必须重新渲染。 */
    'opt.blockNoteEmpty': '当前没有排除任何站点',
    'opt.blockNoteOk': '会排除 {n} 个站点：{list}',
    'opt.blockNoteBad': '会排除 {n} 个站点；下面这 {m} 行不是有效域名，将被忽略：{list}',
    'opt.unitImgs': '{v} 张',
    'opt.unitTimes': '{v} 次',

    'opt.rulePatternPh': '匹配正则，如  -\\d{2,4}x\\d{2,4}(?=\\.jpg)',
    'opt.ruleFlagsPh': 'flags',
    'opt.ruleReplacePh': '替换为（留空即删除匹配部分）',
    'opt.ruleDelTitle': '删除该规则',
    'opt.ruleHint': '示例：正则 (-\\d{2,4}x\\d{2,4})(?=\\.jpg)  ·  替换为空 → 去掉 WordPress 尺寸后缀',
    'opt.ruleErr': '正则非法：{msg}',

    'opt.testNeedUrl': '请先粘贴一个图片地址',
    'opt.testNoMatch': '没有规则匹配这个地址 —— 它会被当作原图直接下载',
    'opt.testLoading': '正在加载候选原图…',
    'opt.testOrigin': '原地址：{dim}',
    'opt.testUnknown': '加载失败 / 未知',
    'opt.testLoadFail': '加载失败',
    'opt.testWillUse': '  ✓ 会被采用',
    'opt.testWontUse': '  （不会采用）',

    'opt.histEmpty': '还没有下载记录',
    'opt.histTime': '时间',
    'opt.histName': '文件名',
    'opt.histDims': '尺寸',
    'opt.histBytes': '体积',
    'opt.histStatus': '状态',
    'opt.histPage': '来源页',
    'opt.histOk': '成功',
    'opt.histFail': '失败',

    'opt.importBadFormat': '文件格式不正确',
    'opt.clearHistoryConfirm': '确定清除所有下载历史吗？已保存的文件不受影响。',
    'opt.clearFpConfirm': '确定清除去重指纹吗？清除后，之前下载过的图片会重新允许下载。',

    /* ---- 图库（popup / 面板） ---- */
    'pop.title': '图片猎人',
    'pop.brand': '图片猎人',
    'pop.targetPh': '正在读取标签页…',
    'pop.targetAria': '选择要嗅探的标签页',
    'pop.targetMultiAria': '选择要合并嗅探的标签页',
    'pop.targetSummary': '选择页面…',
    'pop.targetMultiHd': '勾选要合并嗅探的页面',
    'pop.probeTitle': '探测体积：只读响应头拿真实文件大小，不下载图片',
    'pop.probeAria': '探测体积',
    'pop.exportTitle': '导出清单：左键 JSON，右键 CSV',
    'pop.exportAria': '导出清单',
    'pop.rescanTitle': '重新嗅探本页图片',
    'pop.rescanAria': '重新嗅探',
    'pop.deepTitle': '深度嗅探：自动滚动整页后再嗅探，用于无限滚动 / 越滚越多的站点（会临时滚动你的页面，结束后会滚回原位）',
    'pop.deepAria': '深度嗅探',
    'pop.panelAria': '在页面中打开图库面板',
    'pop.optionsAria': '设置',
    'pop.closeAria': '关闭面板',
    'pop.searchAria': '搜索',
    'pop.searchPh': '搜索文件名 / 图片地址…',
    'pop.searchClear': '清空并收起',
    'pop.filtersTitle': '展开 / 收起筛选条件',
    'pop.filter': '筛选',
    'pop.sort': '排序方式',
    'pop.sortArea': '分辨率 大→小',
    'pop.sortAreaAsc': '分辨率 小→大',
    'pop.sortSize': '体积 大→小',
    'pop.sortOrder': '页面顺序',
    'pop.sortHost': '站点',
    'pop.selGroup': '批量选择',
    'pop.selectAllTitle': '勾上当前筛选出的全部图片（Ctrl + A）',
    'pop.selectAll': '全选',
    'pop.invertTitle': '在筛选结果内，把选中与未选中互换',
    'pop.invert': '反选',
    'pop.clearTitle': '取消全部勾选',
    'pop.sizeSliderTitle': '最小图片尺寸（按短边过滤）',
    'pop.sizeSliderAria': '最小图片尺寸',
    'pop.fgSize': '尺寸',
    'pop.fgAspect': '比例',
    'pop.fgType': '格式',
    'pop.fgSource': '来源',
    'pop.fgOther': '其他',
    'pop.resetFilters': '重置',
    'pop.gridAria': '图片网格',
    'pop.gridHelp': '图片网格：方向键移动，Home / End 到首尾，PageUp / PageDown 翻页，Enter 或空格勾选与取消，P 打开大图预览，R 对没还原成功的图片单独重试',
    'pop.loading': '正在嗅探本页图片…',
    'pop.loadingHint': '会分析 srcset、懒加载、背景图，并尝试还原被缩略化的原图',
    'pop.empty': '本页没有发现图片',
    'pop.emptyHint': '试试点击右上角刷新，或检查是否屏蔽了背景图嗅探',
    'pop.progressAria': '保存进度',
    'pop.progressText': '准备中…',
    'pop.stop': '停止',
    'pop.ftrHint': '网格中拖拽框选 · 框到已勾选的会取消',
    'pop.saveSelected': '保存选中',

    /* ---- 图库：JS 拼出来的文案（toast / 空态 / 卡片 / 进度 / 导出） ---- */
    'pop.titleGallery': '图片猎人 · 图库',
    'pop.untrusted': '这个页面不是由图片猎人打开的，已拒绝在此显示图库。',
    'pop.dimUnknown': '尺寸未知',
    'pop.inlineImage': '内联图片',
    'pop.noTabs': '没有可嗅探的网页标签页',
    'pop.untitled': '（无标题）',
    'pop.noPagePicked': '还没有勾选任何页面',
    'pop.pageCount': '{n} 个页面',
    'pop.currentPage': '当前页面',
    'pop.notScanned': '（未扫到）',
    'pop.mergedScan': '合并嗅探',
    'pop.focusMissing': '图库里没有这张图（可能超出前 {n} 张，或页面已经变了）',
    'pop.focusFar': '这张图排在列表很靠后，向下滚动即可看到',
    'pop.focusReset': '已定位到这张图（它原本被筛选条件挡住，已重置筛选）',
    'pop.focusOk': '已定位到这张图 · 点放大镜可浏览全部图片',

    'pop.aspAll': '全部',
    'pop.aspLandscape': '横图',
    'pop.aspPortrait': '竖图',
    'pop.aspSquare': '方图',
    'pop.aspWide': '超宽',
    'pop.aspTall': '超长',
    'pop.swRestored': '仅已还原原图',
    'pop.swHideDownloaded': '隐藏已下载',
    'pop.swMaxOnly': '每张仅留最大',

    'pop.sliderOverridden': '当前由上方档位（≥ {n}px）决定；拖动这里会切回滑条',
    'pop.filtersReset': '已重置全部筛选条件',
    'pop.selectedN': '已勾选 {n} 张',
    'pop.allSelected': '当前筛选出的已全部勾选',
    'pop.clearedAll': '已取消全部勾选',
    'pop.cancelPartial': '已取消队列中 {dropped} 张；正在下载的 {active} 张会继续完成',
    'pop.cancelQueued': '已取消队列中 {n} 张',
    'pop.cancelStopped': '已停止后续下载',
    'pop.blockedNoPanel': '这个站点已在排除列表中，不打开面板',
    'pop.panelFail': '无法在当前页面打开面板',

    'pop.deepLoading': '正在深度嗅探…',
    'pop.deepLoadingHint': '自动滚动页面以加载更多图片，结束后会把页面滚回原位',
    'pop.deepProgress': '正在深度嗅探… 已采集 {n} 张',
    'pop.deepProgressHint': '第 {round} 轮 · 本轮新增 {added} 张 · 结束后会滚回原位',
    'pop.mergedProgress': '正在嗅探 {n} 个页面…（已完成 {done}/{n}）',
    'pop.mergedProgressHint': '合并嗅探：每个页面各自嗅探并还原原图，再按图片地址合并去重',
    'pop.noTargetMerge': '还没有勾选要嗅探的页面 — 点顶部的「选择页面」，勾一个或多个标签页',
    'pop.noTargetSingle': '还没有选择要嗅探的页面 — 在顶部选一个标签页，或先打开一个网页',
    'pop.noTargetPanel': '无法确定当前标签页',
    'pop.blockedEmpty': '这个站点在你的排除列表里，所以没有嗅探',
    'pop.blockedEmptyHint': '要在这里使用，请到设置页的「站点排除列表」里移除它',
    'pop.blockedEmptyMulti': '这些站点都在你的排除列表里，所以没有嗅探',
    'pop.blockedEmptyHintMulti': '要在这里使用，请到设置页的「站点排除列表」里移除它们',
    'pop.scanFail': '嗅探失败：{msg}',
    'pop.allPagesEmpty': '全部页面都没扫到图片',
    'pop.rescanDone': '已重新嗅探，共发现 {n} 张图片',
    'pop.rescanTrunc': '已重新嗅探，本页共 {found} 张，仅展示前 {shown} 张',
    'pop.rescanMerged': '已重新嗅探 {pages} 个页面，合并去重后共 {n} 张',
    'pop.restoring': '正在还原原图…',
    'pop.emptyMulti': '这些页面里没有发现图片',
    'pop.announceScan': '嗅探完成，共发现 {n} 张图片',
    'pop.announceMerged': '合并嗅探完成，{pages} 个页面共 {n} 张图片',
    'pop.upgraded': '已升级为原图：{n} 张',
    'pop.upgradeDropped': '还原后有 {n} 张已勾选的图片不在列表里了，已自动取消勾选',
    'pop.pruned': '已取消 {n} 张不在当前筛选内的勾选',
    'pop.showAll': '显示全部 {n} 张',
    'pop.emptyFiltered': '没有符合当前筛选条件的图片',
    'pop.emptySizeBlocked': '{n} 张图片都被「最小尺寸 ≥ {min}px」挡住了',
    'pop.emptySizeBlockedHint': '这一页的图片较短边都小于 {min}px（常见于列表缩略图）。',
    'pop.initFail': '初始化失败：{msg}',

    'pop.marqueeMiss': '框选未命中任何图片',
    'pop.marqueeAdd': '已追加，共勾选 {n} 张',
    'pop.marqueeSub': '已取消框内图片，共勾选 {n} 张',
    'pop.marqueeToggle': '已勾选 {n} 张',
    'pop.marqueeCleared': '已取消框内图片',

    'pop.cardIndex': '第 {n} 张',
    'pop.labelRestored': '已还原为原图',
    'pop.fromPage': '来自 {host}',
    'pop.alsoOn': '（也出现在：{list}）',
    'pop.cardDownloaded': '已下载',
    'pop.cardOriginal': '原图',
    'pop.cardOriginalTitle': '已从缩略图还原为原图',
    'pop.pickTitle': '勾选 / 取消',
    'pop.zoomTitle': '大图预览',
    'pop.zoomAria': '大图预览',
    'pop.restore': '还原',
    'pop.restoreTitle': '这张图没还原成功，单独重试一次',
    'pop.restoreAria': '单独重试还原这张图',
    'pop.restoreFail': '还原失败：{msg}',
    'pop.restoreNoBetter': '这张图已经是能拿到的最大的版本了',
    'pop.restoredOne': '已还原为原图 {w}×{h}',

    'pop.willSave': '将保存 {n} 张原图到浏览器下载目录',
    'pop.ftrHintSelect': '网格中拖拽框选图片 · 框到已勾选的会取消勾选',
    'pop.ageSeconds': '{n} 秒',
    'pop.ageMinutes': '{n} 分钟',
    'pop.truncTotal': '本页共 {found} 张，仅展示前 {shown} 张',
    'pop.truncMerged': '部分页面图片过多，每页只取了前若干张',
    'pop.truncBg': '页面元素过多（约 {n} 个），部分 CSS 背景图未扫描',
    'pop.truncRestore': '原图还原超时，靠后的部分图片仍是页面上的版本',
    'pop.truncDeep': '深度嗅探已达滚动上限，页面里可能还有未采集到的图片',
    'pop.cacheNote': '（复用 {age}前的嗅探结果 · 点此重新嗅探）',
    'pop.parenList': '（{list}）',

    'pop.probeNothing': '没有需要探测的图片',
    'pop.probing': '正在探测体积…',
    'pop.probeRunning': '正在探测 {n} 张图片的体积…',
    'pop.probeRetrying': '正在重试 {n} 张图片的体积…',
    'pop.probeProgress': '正在探测体积… {done} / {total}',
    'pop.probeDone': '已获取 {n} 张图片的体积',
    'pop.probeDoneFail': '已获取 {n} 张图片的体积，{failed} 张失败',
    'pop.probeAllFail': '未能获取体积：站点可能禁止跨域读取',

    'pop.saveNothing': '请先勾选要保存的图片',
    'pop.queued': '已加入下载队列：{n} 张',
    'pop.saveFail': '批量保存失败：{msg}',
    'pop.savingStart': '开始保存 {n} 张图片',
    'pop.saveEnd': '保存结束：成功 {n} 张',
    'pop.saveEndFailed': '，失败 {n} 张',
    'pop.saveEndSkipped': '，跳过 {n} 张',
    'pop.stRunning': '下载中',
    'pop.stDone': '已完成',
    'pop.stStopped': '已停止',
    'pop.stStoppedActive': '已停止（{n} 张仍在完成）',
    'pop.pDone': '成功 {n}',
    'pop.pFailed': '失败 {n}',
    'pop.pSkipped': '跳过 {n}',

    'pop.exportNothing': '没有可导出的图片',
    'pop.exportEmpty': '当前筛选条件下没有图片，已取消导出',
    'pop.csvIndex': '序号',
    'pop.csvFilename': '文件名',
    'pop.csvWidth': '宽度',
    'pop.csvHeight': '高度',
    'pop.csvBytes': '体积',
    'pop.csvType': '格式',
    'pop.csvSource': '来源',
    'pop.csvRestored': '已还原原图',
    'pop.csvHost': '站点',
    'pop.csvPageUrl': '来源页',
    'pop.csvUrl': '地址',
    'pop.exported': '已导出 {n} 条记录（{fmt}）',
    'pop.exportTitle2': '左键导出 JSON，右键导出 CSV',
    'pop.lightboxFail': '无法在页面中打开预览',
    'pop.lightboxMissing': '预览组件未加载，请重新加载扩展',

    'pop.searchTitle': '搜索文件名 / 图片地址',
    'pop.searchClearAria': '清空并收起搜索',
    'pop.resetFiltersTitle': '恢复全部默认条件',
    'pop.sumTotal': '共',
    'pop.unitImg': '张',
    'pop.sumMatched': '符合',
    'pop.sumSelected': '已选',
    'pop.sumBytes': '合计',

    /* ---- 页内界面：悬停按钮 / 气泡 / 灯箱 / 页内面板 ---- */
    'pg.preview': '大图预览',
    'pg.previewTitle': '大图预览（就在当前页看，不跳走）',
    'pg.saveOriginal': '保存原图',
    'pg.saveOriginalTitle': '保存原图（Alt+点击图片 可免悬停直存）',
    'pg.saving': '正在保存…',
    'pg.saved': '已保存',
    'pg.saveFailedRetry': '保存失败，点击重试',
    'pg.collecting': '正在整理本页图片…',
    'pg.previewNotLoaded': '预览组件未加载',
    'pg.previewNone': '没找到可预览的图片',
    'pg.hoverFirst': '先把鼠标移到图片上，再按这个快捷键',
    'pg.noSavable': '未找到可保存的图片',
    'pg.skippedDownloaded': '已下载过，本次已跳过',
    'pg.savedOriginalDim': '已保存原图{dim}',
    'pg.savedDim': '已保存{dim}',
    'pg.savedFolder': ' → {folder}/',
    'pg.savedAs': '（实际为 {name}）',
    'pg.downloadFailed': '下载失败',
    'pg.saveFailed': '保存失败',

    'pg.lbZoomOut': '缩小',
    'pg.lbZoomIn': '放大',
    'pg.lbCopyLink': '复制图片直链',
    'pg.lbCopyImage': '复制图片到剪贴板',
    'pg.lbOpenTab': '在新标签页打开原图',
    'pg.lbOpenGallery': '在图库中打开：定位到这张图，并可浏览本页全部图片',
    'pg.lbClose': '关闭 (Esc)',
    'pg.lbPrev': '上一张 (←)',
    'pg.lbNext': '下一张 (→)',
    'pg.lbLoadFailed': '原图加载失败（可能受站点防盗链限制，仍可尝试保存）',
    'pg.tagRestored': '已还原原图',
    'pg.dimUnknown': '尺寸未知',
    'pg.filteredOut': '已按 {min}px 过滤 {n} 张',
    'pg.imageWord': '图片',
    'pg.inlineImage': '内联图片',
    'pg.savingShort': '保存中…',
    'pg.skippedExists': '已存在，已跳过',
    'pg.savedCheck': '已保存 ✓',
    'pg.fetchImageFailed': '获取图片失败',
    'pg.copyUnsupported': '当前环境不支持复制图片',

    'pg.galleryPanel': '图片库',
    'pg.noResponse': '无响应',
    'pg.noSavableUrl': '没有可保存的图片地址',
    'pg.hoverNotLoaded': '悬停模块未加载',
    'pg.missingUrl': '缺少图片地址',

    /* ---- 后台（Service Worker）返回给界面看的错误 ----
     * 后台没有界面，但这些字符串会原样显示在悬停气泡 / 图库提示 / 下载历史里，
     * 所以同样要跟着界面语言走。 */
    'bg.downloadTimeout': '下载超时',
    'bg.downloadInterrupted': '下载被中断',
    'bg.emptyBody': '响应内容为空',
    'bg.skippedAlready': '已下载过',
    'bg.unknownError': '未知错误',
    'bg.noImages': '没有需要下载的图片',
    'bg.scanBusy': '上一次嗅探还没结束 —— 等它跑完再试一次',
    'bg.scanBlocked': '这个站点在你的排除列表里',
    /* 一个 frame 都没回报时给用户的说法。
       **不能**说「本页没有发现图片」—— 那是把「没问成」说成「没有图」，
       用户会以为页面上真的没图，然后去别的地方找原因。 */
    'bg.scanNoReply': '没能在这张页面上开始嗅探 —— 页面可能还没加载完，或者不允许扩展运行。'
      + '刷新页面后重试，或换一个已经加载完的标签页',
    'bg.noTargetTab': '找不到目标标签页',
    'bg.noSourceTab': '找不到来源标签页',
    'bg.imageTooBig': '图片过大',
    'bg.missingUrl': '缺少图片地址',
    'bg.cannotConnect': '无法连接到目标页面'
  };

  /* ---------------------------- English ---------------------------- */
  STRINGS.en = {
    /* ---- common ---- */
    'cmn.cancel': 'Cancel',
    'cmn.close': 'Close',
    'cmn.save': 'Save',
    'cmn.saved': 'Saved',
    'cmn.clear': 'Clear',
    'cmn.reset': 'Reset',
    'cmn.all': 'All',
    'cmn.view': 'View',
    'cmn.export': 'Export',
    'cmn.import': 'Import',
    'cmn.test': 'Test',
    'cmn.light': 'Light',
    'cmn.dark': 'Dark',
    'cmn.auto': 'Follow system',
    'cmn.yes': 'Yes',
    'cmn.no': 'No',
    'cmn.retry': 'Retry',
    'cmn.and': ' and ',
    'cmn.loading': 'Loading…',
    'cmn.unknown': 'Unknown',
    'cmn.unknownError': 'Unknown error',
    'cmn.noFilter': 'No filter',

    /* ---- settings page ---- */
    'opt.title': 'ImageHunter · Settings',
    'opt.sub': 'Hover to save originals · Scan the whole page · Batch-download full-resolution images',
    'opt.reset': 'Restore defaults',

    'opt.lang': 'Interface language',
    'opt.langHint': 'Choose the interface language. It takes effect immediately. Defaults to following your browser',
    'opt.langAuto': 'Follow browser',
    'opt.langZh': '中文',
    'opt.langEn': 'English',

    'opt.general': 'General',
    'opt.generalSub': 'Appearance and basic preferences',
    'opt.theme': 'Theme',
    'opt.themeHint': 'Light/dark mode and colour scheme. Applies to the gallery, the in-page panel and this settings page',

    'opt.themeMode': 'Light/dark mode',
    'opt.themePreset': 'Colour scheme',
    'opt.themePresetHint': 'Overall hue. Each of the six presets ships its own light and dark accent',
    'opt.themeAccent': 'Custom accent',
    'opt.themeAccentHint': 'Overrides the accent of the colour scheme. Shades and shadows follow automatically',
    'opt.themeAccentAuto': 'Follow the colour scheme',
    'opt.themeAccentPick': 'Pick a colour',
    'opt.themeAccentReset': 'Back to the colour scheme',
    'opt.themePreview': 'Preview',
    'opt.preset.indigo': 'Indigo',
    'opt.preset.teal': 'Teal',
    'opt.preset.emerald': 'Emerald',
    'opt.preset.rose': 'Rose',
    'opt.preset.amber': 'Amber',
    'opt.preset.slate': 'Slate',

    'opt.scan': 'What to scan',
    'opt.scanSub': 'Decides which images can be found. The more you enable, the less you miss.',
    'opt.restore': 'Restore originals (recommended)',
    'opt.restoreHint': 'Rewrites thumbnail URLs into original-image URLs. Every candidate is really loaded and verified; only a larger image is adopted',
    'opt.scanImg': 'Page images',
    'opt.scanImgHint': 'Scan <img> elements (including srcset / lazy-load attributes). Turn it off to look only at backgrounds, links and other sources',
    'opt.scanBg': 'CSS backgrounds',
    'opt.scanBgHint': 'Scan background-image in each element’s computed style',
    'opt.scanPseudo': 'Pseudo-element backgrounds',
    'opt.scanPseudoHint': 'Scan backgrounds on ::before / ::after (slower)',
    'opt.scanPoster': 'Video posters',
    'opt.scanPosterHint': 'Scan the poster attribute of <video>',
    'opt.scanSvg': 'Inline SVG',
    'opt.scanSvgHint': 'Turn SVG graphics on the page into savable images',
    'opt.scanLinks': 'Images behind links',
    'opt.scanLinksHint': 'Scan <a href> values that point to image files',
    'opt.scanPreload': 'Preloaded images',
    'opt.scanPreloadHint': 'Scan <link rel="preload" as="image">',
    'opt.scanOg': 'Social share images',
    'opt.scanOgHint': 'Scan og:image / twitter:image',
    'opt.probeConc': 'Size-probe concurrency',
    'opt.probeConcHint': 'How many images are probed for real resolution at once. Too high may slow the page down',
    'opt.probeTimeout': 'Per-image probe timeout',
    'opt.probeTimeoutHint': 'Give up after this many milliseconds',
    'opt.mergeTabs': 'Merge several tabs',
    'opt.mergeTabsHint': 'When on, the “scan target” picker at the top of the gallery lets you tick several tabs at once and merge their images into one list (deduplicated by URL, each card shows which page it came from). When off, only the selected page is scanned',

    'opt.rules': 'Restore rules',
    'opt.rulesSub': 'Built-in rules cover WordPress, Cloudinary, Qiniu, Aliyun OSS, UPYUN, Taobao CDN and other common cases. You can add your own.',
    'opt.rulesBuiltin': 'Built-in rules',
    'opt.rulesCustom': 'Custom rules',
    'opt.rulesAdd': '+ Add rule',
    'opt.rulesDebug': 'Rule tester',
    'opt.rulesTestPh': 'Paste a thumbnail URL, e.g. https://blog.x.com/wp-content/uploads/2024/05/hero-1024x768.jpg',

    'opt.dl': 'Downloads',
    'opt.dlSub': 'Saving behaviour, naming and robustness',
    'opt.dlConc': 'Concurrent downloads',
    'opt.dlConcHint': 'Too many at once may get you rate-limited',
    'opt.dlRetries': 'Retry count',
    'opt.dlRetriesHint': 'How many times to retry a single failed image',
    'opt.dlSkip': 'Skip already downloaded',
    'opt.dlSkipHint': 'Fingerprints image URL + size so the same file is not saved twice',
    'opt.dlFallback': 'Hotlink fallback (recommended)',
    'opt.dlFallbackHint': 'If a direct download fails, fetch the image from the extension page and save that — it gets around the 403 block on some sites',
    'opt.dlTemplate': 'Filename template',
    'opt.dlTemplateHint': 'Variables: {name} original name · {ext} extension · {index} index · {host} site · {w} {h} dimensions · {date} date. A <code>/</code> in the template also creates a subfolder',
    'opt.dlSubfolder': 'Save into subfolder',
    'opt.dlSubfolderHint': 'Leave empty to save straight into the downloads folder. Variables: <code>{host}</code> site · <code>{date}</code> date · <code>{index}</code> index. E.g. <code>{host}</code> → one folder per site; <code>{date}/{host}</code> → by date, then by site',
    'opt.dlSubfolderPh': 'Empty = downloads root',
    'opt.dlBatchPrefix': 'Number-prefix batch downloads',
    'opt.dlBatchPrefixHint': 'Filenames become <code>001_photo.jpg</code> so the download order is kept',

    'opt.ux': 'Interaction',
    'opt.uxSub': 'Hover button and large preview',
    'opt.uxHover': 'Download button on images',
    'opt.uxHoverHint': 'Hovering an image shows a round download button in its top-right corner; one click saves the original',
    'opt.uxHoverDelay': 'Button delay',
    'opt.uxHoverDelayHint': 'Stops the button flickering when the mouse sweeps past',
    'opt.uxMinSize': 'Minimum display size',
    'opt.uxMinSizeHint': 'Images smaller than this side show no button — filters out tiny icons and dividers',
    'opt.uxLightboxMin': 'Minimum size in preview',
    'opt.uxLightboxMinHint': 'In the large preview you only step through images whose shorter side is at least this (real pixels; 0 disables). Preview only — the gallery list and batch download are unaffected',
    'opt.uxAltClick': 'Alt + click to save',
    'opt.uxAltClickHint': 'No need to hover first: hold Alt and click an image to save the original',
    'opt.uxShortcut': 'Panel shortcut',
    'opt.uxShortcutHint': 'Alt+Shift+S by default; change it in your browser’s extension shortcuts page',
    'opt.uxOpenShortcut': 'Open shortcut settings',

    'opt.block': 'Excluded sites',
    'opt.blockSub': 'No hover button, no Alt+click and no in-page panel on these sites',
    'opt.blockList': 'Excluded sites',
    'opt.blockListHint': 'One domain per line. An entry also matches all of its subdomains — <code>example.com</code> covers <code>www.example.com</code>. Pasting a full URL (<code>https://example.com/photo</code>) picks out the domain for you.',
    'opt.blockLimits': 'What this list cannot control',
    'opt.blockLimitsHint': 'The extension’s files still load on every page (Manifest V3 declares <code>content_scripts</code> statically — there is no way to skip loading per site). What this turns off is <b>interface behaviour</b>: the hover button, Alt+click, the in-page panel and automatic scanning. “Save this image” in the right-click menu still works — you asked for that one yourself, it is not a nuisance.',

    'opt.data': 'Data & statistics',
    'opt.dataSub': 'Download history, dedupe fingerprints and settings backup',
    'opt.stSaved': 'Saved',
    'opt.stFailed': 'Failed',
    'opt.stBytes': 'Total size',
    'opt.stHistory': 'History',
    'opt.stFp': 'Fingerprints',
    'opt.history': 'Download history',
    'opt.historyHint': 'The most recent 500 records',
    'opt.clearHistory': 'Clear download history',
    'opt.clearHistoryHint': 'Your saved files are not affected',
    'opt.clearFp': 'Clear fingerprints',
    'opt.clearFpHint': 'After clearing, images you downloaded before may be downloaded again',
    'opt.backup': 'Back up settings',
    'opt.backupHint': 'Export to a JSON file, or import from one',
    'opt.diag': 'Export diagnostics',
    'opt.diagHint': 'Version, platform, current settings, the last 20 downloads and the last scan summary. Aggregated numbers and host names only — no image or page URLs',

    'opt.footer': 'ImageHunter {version} · Every image is saved at its original resolution',
    'opt.footerNote': 'The interface is available in Chinese and English — switch it under “Interface language” above',
    'opt.modalHistory': 'Download history',

    /* ---- settings page: runtime messages (confirm / toast) ---- */
    'opt.resetConfirm': 'Reset all settings to their defaults?',
    'opt.resetConfirmExtra': 'This also deletes the {extra} you added, and cannot be undone.',
    'opt.ruleCount': '{n} custom restore rules',
    'opt.blockCount': '{n} excluded sites',
    'opt.restored': 'Defaults restored',
    'opt.exported': 'Settings exported',
    'opt.diagMissing': 'Diagnostics module is not loaded — please reload the extension',
    'opt.diagAuditFail': 'Diagnostics self-check failed ({n} unscrubbed addresses); export aborted',
    'opt.diagExported': 'Diagnostics exported ({n} download records)',
    'opt.imported': 'Settings imported',
    'opt.importedRules': 'Settings imported (including {n} custom restore rules)',
    'opt.importFail': 'Import failed: {msg}',
    'opt.historyCleared': 'Download history cleared',
    'opt.fpCleared': 'Fingerprints cleared',
    'opt.exportFail': 'Export failed: {msg}',
    'opt.initFail': 'Initialisation failed: {msg}',

    /* ---- settings page: dynamically generated content ----
     * The rule editor, the live exclusion-list feedback, the history table and
     * the rule tester. These are built in JS, not marked with data-i18n, so
     * they have to be re-rendered when the language changes. */
    'opt.blockNoteEmpty': 'No sites are excluded right now',
    'opt.blockNoteOk': 'Will exclude {n} sites: {list}',
    'opt.blockNoteBad': 'Will exclude {n} sites; these {m} lines are not valid domains and will be ignored: {list}',
    'opt.unitImgs': '{v} at once',
    'opt.unitTimes': '{v}×',

    'opt.rulePatternPh': 'Match regex, e.g.  -\\d{2,4}x\\d{2,4}(?=\\.jpg)',
    'opt.ruleFlagsPh': 'flags',
    'opt.ruleReplacePh': 'Replace with (empty = delete the match)',
    'opt.ruleDelTitle': 'Delete this rule',
    'opt.ruleHint': 'Example: regex (-\\d{2,4}x\\d{2,4})(?=\\.jpg) with an empty replacement → strips the WordPress size suffix',
    'opt.ruleErr': 'Invalid regex: {msg}',

    'opt.testNeedUrl': 'Paste an image URL first',
    'opt.testNoMatch': 'No rule matches this URL — it will be downloaded as-is',
    'opt.testLoading': 'Loading candidate originals…',
    'opt.testOrigin': 'Original: {dim}',
    'opt.testUnknown': 'Load failed / unknown',
    'opt.testLoadFail': 'Load failed',
    'opt.testWillUse': '  ✓ will be used',
    'opt.testWontUse': '  (not used)',

    'opt.histEmpty': 'No downloads recorded yet',
    'opt.histTime': 'Time',
    'opt.histName': 'File',
    'opt.histDims': 'Dimensions',
    'opt.histBytes': 'Size',
    'opt.histStatus': 'Status',
    'opt.histPage': 'Source page',
    'opt.histOk': 'Success',
    'opt.histFail': 'Failed',

    'opt.importBadFormat': 'The file format is not valid',
    'opt.clearHistoryConfirm': 'Clear all download history? Your saved files are not affected.',
    'opt.clearFpConfirm': 'Clear all dedupe fingerprints? Images you saved before can then be saved again.',

    /* ---- gallery (popup / in-page panel) ---- */
    'pop.title': 'ImageHunter',
    'pop.brand': 'ImageHunter',
    'pop.targetPh': 'Reading tabs…',
    'pop.targetAria': 'Choose a tab to scan',
    'pop.targetMultiAria': 'Choose the tabs to merge',
    'pop.targetSummary': 'Select pages…',
    'pop.targetMultiHd': 'Select the pages to merge',
    'pop.probeTitle': 'Probe size: reads response headers for the real file size, it does not download the image',
    'pop.probeAria': 'Probe size',
    'pop.exportTitle': 'Export the list: left-click for JSON, right-click for CSV',
    'pop.exportAria': 'Export list',
    'pop.rescanTitle': 'Re-scan this page for images',
    'pop.rescanAria': 'Re-scan',
    'pop.deepTitle': 'Deep scan: scrolls the whole page before scanning, for infinite-scroll sites (it scrolls your page temporarily and returns to the original position afterwards)',
    'pop.deepAria': 'Deep scan',
    'pop.panelAria': 'Open the gallery panel in this page',
    'pop.optionsAria': 'Settings',
    'pop.closeAria': 'Close panel',
    'pop.searchAria': 'Search',
    'pop.searchPh': 'Search filename / image URL…',
    'pop.searchClear': 'Clear and collapse',
    'pop.filtersTitle': 'Expand / collapse filters',
    'pop.filter': 'Filters',
    'pop.sort': 'Sort by',
    'pop.sortArea': 'Resolution large → small',
    'pop.sortAreaAsc': 'Resolution small → large',
    'pop.sortSize': 'File size large → small',
    'pop.sortOrder': 'Page order',
    'pop.sortHost': 'Site',
    'pop.selGroup': 'Bulk selection',
    'pop.selectAllTitle': 'Select all filtered images (Ctrl + A)',
    'pop.selectAll': 'Select all',
    'pop.invertTitle': 'Swap selected and unselected within the filtered results',
    'pop.invert': 'Invert',
    'pop.clearTitle': 'Clear all selections',
    'pop.sizeSliderTitle': 'Minimum image size (by shorter side)',
    'pop.sizeSliderAria': 'Minimum image size',
    'pop.fgSize': 'Size',
    'pop.fgAspect': 'Aspect',
    'pop.fgType': 'Format',
    'pop.fgSource': 'Source',
    'pop.fgOther': 'Other',
    'pop.resetFilters': 'Reset',
    'pop.gridAria': 'Image grid',
    'pop.gridHelp': 'Image grid: arrow keys to move, Home / End for first / last, PageUp / PageDown to page, Enter or Space to toggle selection, P opens the large preview, R retries images that could not be restored',
    'pop.loading': 'Scanning this page for images…',
    'pop.loadingHint': 'Looks at srcset, lazy-loading and backgrounds, and tries to restore thumbnailed originals',
    'pop.empty': 'No images found on this page',
    'pop.emptyHint': 'Try the refresh button at the top right, or check whether background-image scanning is disabled',
    'pop.progressAria': 'Save progress',
    'pop.progressText': 'Preparing…',
    'pop.stop': 'Stop',
    'pop.ftrHint': 'Drag to marquee-select · dragging over a selected card deselects it',
    'pop.saveSelected': 'Save selected',

    /* ---- gallery: copy built in JS (toasts / empty states / cards / progress / export) ---- */
    'pop.titleGallery': 'ImageHunter · Gallery',
    'pop.untrusted': 'This page was not opened by ImageHunter, so the gallery is not shown here.',
    'pop.dimUnknown': 'Size unknown',
    'pop.inlineImage': 'Inline image',
    'pop.noTabs': 'No web page tabs to scan',
    'pop.untitled': '(untitled)',
    'pop.noPagePicked': 'No pages ticked yet',
    'pop.pageCount': '{n} pages',
    'pop.currentPage': 'Current page',
    'pop.notScanned': ' (not scanned)',
    'pop.mergedScan': 'Merged scan',
    'pop.focusMissing': 'That image is not in the gallery (it may be beyond the first {n}, or the page has changed)',
    'pop.focusFar': 'That image is far down the list — scroll down to see it',
    'pop.focusReset': 'Jumped to it (a filter was hiding it, so the filters were reset)',
    'pop.focusOk': 'Jumped to it · click the magnifier to browse every image',

    'pop.aspAll': 'All',
    'pop.aspLandscape': 'Landscape',
    'pop.aspPortrait': 'Portrait',
    'pop.aspSquare': 'Square',
    'pop.aspWide': 'Panoramic',
    'pop.aspTall': 'Very tall',
    'pop.swRestored': 'Restored only',
    'pop.swHideDownloaded': 'Hide downloaded',
    'pop.swMaxOnly': 'Largest per image',

    'pop.sliderOverridden': 'Currently set by the preset above (≥ {n}px); dragging here switches back to the slider',
    'pop.filtersReset': 'All filters reset',
    'pop.selectedN': '{n} selected',
    'pop.allSelected': 'Everything in the current filter is already selected',
    'pop.clearedAll': 'Selection cleared',
    'pop.cancelPartial': 'Cancelled {dropped} queued; {active} already downloading will finish',
    'pop.cancelQueued': 'Cancelled {n} queued',
    'pop.cancelStopped': 'Stopped the remaining downloads',
    'pop.blockedNoPanel': 'This site is on your exclusion list, so the panel is not opened',
    'pop.panelFail': 'Cannot open the panel on this page',

    'pop.deepLoading': 'Deep scanning…',
    'pop.deepLoadingHint': 'Scrolls the page to load more images, then returns it to where it was',
    'pop.deepProgress': 'Deep scanning… {n} collected so far',
    'pop.deepProgressHint': 'Round {round} · {added} new this round · the page is returned afterwards',
    'pop.mergedProgress': 'Scanning {n} pages… ({done}/{n} done)',
    'pop.mergedProgressHint': 'Merged scan: each page is scanned and restored on its own, then deduplicated by image URL',
    'pop.noTargetMerge': 'No pages ticked yet — use “Select pages” at the top and tick one or more tabs',
    'pop.noTargetSingle': 'No page selected yet — pick a tab at the top, or open a web page first',
    'pop.noTargetPanel': 'Cannot determine the current tab',
    'pop.blockedEmpty': 'This site is on your exclusion list, so it was not scanned',
    'pop.blockedEmptyHint': 'To use it here, remove it under “Excluded sites” in the settings',
    'pop.blockedEmptyMulti': 'These sites are all on your exclusion list, so none were scanned',
    'pop.blockedEmptyHintMulti': 'To use them here, remove them under “Excluded sites” in the settings',
    'pop.scanFail': 'Scan failed: {msg}',
    'pop.allPagesEmpty': 'No images were found on any of the pages',
    'pop.rescanDone': 'Re-scanned, {n} images found',
    'pop.rescanTrunc': 'Re-scanned, {found} images on this page, showing the first {shown}',
    'pop.rescanMerged': 'Re-scanned {pages} pages, {n} images after deduplication',
    'pop.restoring': 'Restoring originals…',
    'pop.emptyMulti': 'No images found on these pages',
    'pop.announceScan': 'Scan finished, {n} images found',
    'pop.announceMerged': 'Merged scan finished, {n} images across {pages} pages',
    'pop.upgraded': 'Upgraded to originals: {n}',
    'pop.upgradeDropped': '{n} selected images dropped out of the list after restoring — deselected',
    'pop.pruned': 'Deselected {n} images outside the current filter',
    'pop.showAll': 'Show all {n}',
    'pop.emptyFiltered': 'No images match the current filters',
    'pop.emptySizeBlocked': 'All {n} images are blocked by “minimum size ≥ {min}px”',
    'pop.emptySizeBlockedHint': 'Every image on this page has a shorter side under {min}px (typical for list thumbnails).',
    'pop.initFail': 'Initialisation failed: {msg}',

    'pop.marqueeMiss': 'The marquee hit no images',
    'pop.marqueeAdd': 'Added, {n} selected in total',
    'pop.marqueeSub': 'Deselected the ones inside, {n} selected in total',
    'pop.marqueeToggle': '{n} selected',
    'pop.marqueeCleared': 'Deselected the ones inside',

    'pop.cardIndex': 'Image {n}',
    'pop.labelRestored': 'Restored to the original',
    'pop.fromPage': 'From {host}',
    'pop.alsoOn': ' (also on: {list})',
    'pop.cardDownloaded': 'Downloaded',
    'pop.cardOriginal': 'Original',
    'pop.cardOriginalTitle': 'Restored from a thumbnail to the original',
    'pop.pickTitle': 'Select / deselect',
    'pop.zoomTitle': 'Large preview',
    'pop.zoomAria': 'Large preview',
    'pop.restore': 'Restore',
    'pop.restoreTitle': 'Restoring failed for this image — retry it on its own',
    'pop.restoreAria': 'Retry restoring this image',
    'pop.restoreFail': 'Restore failed: {msg}',
    'pop.restoreNoBetter': 'This is already the largest version available',
    'pop.restoredOne': 'Restored to the original {w}×{h}',

    'pop.willSave': 'Will save {n} originals to your browser’s downloads folder',
    'pop.ftrHintSelect': 'Drag to marquee-select · dragging over a selected card deselects it',
    'pop.ageSeconds': '{n}s',
    'pop.ageMinutes': '{n} min',
    'pop.truncTotal': '{found} images on this page, showing the first {shown}',
    'pop.truncMerged': 'Some pages had too many images; only the first ones of each were taken',
    'pop.truncBg': 'Too many elements on the page (about {n}); some CSS backgrounds were not scanned',
    'pop.truncRestore': 'Restoring timed out; the images further down are still the page versions',
    'pop.truncDeep': 'Deep scan hit its scroll limit; the page may still have images that were not collected',
    'pop.cacheNote': '(reusing the scan from {age} ago · click to re-scan)',
    'pop.parenList': '({list})',

    'pop.probeNothing': 'Nothing left to probe',
    'pop.probing': 'Probing sizes…',
    'pop.probeRunning': 'Probing the size of {n} images…',
    'pop.probeRetrying': 'Retrying the size of {n} images…',
    'pop.probeProgress': 'Probing sizes… {done} / {total}',
    'pop.probeDone': 'Got the size of {n} images',
    'pop.probeDoneFail': 'Got the size of {n} images, {failed} failed',
    'pop.probeAllFail': 'Could not read any size — the site may block cross-origin reads',

    'pop.saveNothing': 'Select the images you want to save first',
    'pop.queued': 'Queued for download: {n}',
    'pop.saveFail': 'Batch save failed: {msg}',
    'pop.savingStart': 'Saving {n} images',
    'pop.saveEnd': 'Finished: {n} saved',
    'pop.saveEndFailed': ', {n} failed',
    'pop.saveEndSkipped': ', {n} skipped',
    'pop.stRunning': 'Downloading',
    'pop.stDone': 'Done',
    'pop.stStopped': 'Stopped',
    'pop.stStoppedActive': 'Stopped ({n} still finishing)',
    'pop.pDone': 'saved {n}',
    'pop.pFailed': 'failed {n}',
    'pop.pSkipped': 'skipped {n}',

    'pop.exportNothing': 'Nothing to export',
    'pop.exportEmpty': 'The current filters leave no images — export cancelled',
    'pop.csvIndex': 'Index',
    'pop.csvFilename': 'Filename',
    'pop.csvWidth': 'Width',
    'pop.csvHeight': 'Height',
    'pop.csvBytes': 'Size',
    'pop.csvType': 'Format',
    'pop.csvSource': 'Source',
    'pop.csvRestored': 'Restored',
    'pop.csvHost': 'Host',
    'pop.csvPageUrl': 'Page',
    'pop.csvUrl': 'URL',
    'pop.exported': 'Exported {n} rows ({fmt})',
    'pop.exportTitle2': 'Left-click exports JSON, right-click exports CSV',
    'pop.lightboxFail': 'Cannot open the preview on this page',
    'pop.lightboxMissing': 'Preview component is not loaded — please reload the extension',

    'pop.searchTitle': 'Search filename / image URL',
    'pop.searchClearAria': 'Clear and collapse the search',
    'pop.resetFiltersTitle': 'Restore all default conditions',
    'pop.sumTotal': 'Total',
    'pop.unitImg': 'images',
    'pop.sumMatched': 'matching',
    'pop.sumSelected': 'selected',
    'pop.sumBytes': 'total size',

    /* ---- in-page UI: hover button / bubble / lightbox / in-page panel ---- */
    'pg.preview': 'Large preview',
    'pg.previewTitle': 'Large preview (opens right here — no tab switch)',
    'pg.saveOriginal': 'Save original',
    'pg.saveOriginalTitle': 'Save original (Alt+click an image skips hovering)',
    'pg.saving': 'Saving…',
    'pg.saved': 'Saved',
    'pg.saveFailedRetry': 'Save failed — click to retry',
    'pg.collecting': 'Collecting this page’s images…',
    'pg.previewNotLoaded': 'Preview component not loaded',
    'pg.previewNone': 'No previewable image found',
    'pg.hoverFirst': 'Move the mouse over an image first, then press this shortcut',
    'pg.noSavable': 'No savable image found',
    'pg.skippedDownloaded': 'Already downloaded — skipped this time',
    'pg.savedOriginalDim': 'Saved original{dim}',
    'pg.savedDim': 'Saved{dim}',
    'pg.savedFolder': ' → {folder}/',
    'pg.savedAs': ' (saved as {name})',
    'pg.downloadFailed': 'Download failed',
    'pg.saveFailed': 'Save failed',

    'pg.lbZoomOut': 'Zoom out',
    'pg.lbZoomIn': 'Zoom in',
    'pg.lbCopyLink': 'Copy image URL',
    'pg.lbCopyImage': 'Copy image to clipboard',
    'pg.lbOpenTab': 'Open the original in a new tab',
    'pg.lbOpenGallery': 'Open in the gallery: jumps to this image and lets you browse them all',
    'pg.lbClose': 'Close (Esc)',
    'pg.lbPrev': 'Previous (←)',
    'pg.lbNext': 'Next (→)',
    'pg.lbLoadFailed': 'The original failed to load (the site may block hotlinking — saving may still work)',
    'pg.tagRestored': 'Restored to original',
    'pg.dimUnknown': 'Size unknown',
    'pg.filteredOut': 'Filtered {n} out at {min}px',
    'pg.imageWord': 'Image',
    'pg.inlineImage': 'Inline image',
    'pg.savingShort': 'Saving…',
    'pg.skippedExists': 'Already there — skipped',
    'pg.savedCheck': 'Saved ✓',
    'pg.fetchImageFailed': 'Could not get the image',
    'pg.copyUnsupported': 'This environment cannot copy images',

    'pg.galleryPanel': 'Image gallery',
    'pg.noResponse': 'No response',
    'pg.noSavableUrl': 'No savable image URL',
    'pg.hoverNotLoaded': 'Hover component not loaded',
    'pg.missingUrl': 'Missing image URL',

    /* ---- errors the service worker hands back to the UI ----
     * The worker has no UI of its own, but these strings are shown verbatim in
     * the hover bubble, the gallery notices and the download history — so they
     * follow the interface language too. */
    'bg.downloadTimeout': 'Download timed out',
    'bg.downloadInterrupted': 'Download interrupted',
    'bg.emptyBody': 'The response body was empty',
    'bg.skippedAlready': 'Already downloaded',
    'bg.unknownError': 'Unknown error',
    'bg.noImages': 'No images to download',
    'bg.scanBusy': 'The previous scan has not finished yet — wait for it and try again',
    'bg.scanBlocked': 'This site is on your exclusion list',
    'bg.scanNoReply': 'Could not start scanning on this page — it may not have finished loading, '
      + 'or extensions are not allowed to run on it. Refresh the page and try again, '
      + 'or switch to a tab that has finished loading',
    'bg.noTargetTab': 'Cannot find the target tab',
    'bg.noSourceTab': 'Cannot find the source tab',
    'bg.imageTooBig': 'The image is too large',
    'bg.missingUrl': 'Missing image URL',
    'bg.cannotConnect': 'Cannot connect to the target page'
  };

  /* ------------------------------------------------------------------ *
   * 来源标签 / 还原规则名：跟着语言走
   *
   * 它们本来写在 constants.js 里，是常量。但它们是**给用户看的**，
   * 所以取用时走这里；constants 里那份保留为兜底（英文没写时退回中文名）。
   * ------------------------------------------------------------------ */

  const SOURCE_LABELS = {
    zh: {
      img: '页面图片', srcset: 'srcset 大图', picture: 'picture', lazy: '懒加载图',
      bg: '背景图', pseudo: '伪元素背景', poster: '视频封面', svg: '内联 SVG',
      link: '图片链接', preload: '预加载图', og: '社交主图'
    },
    en: {
      img: 'Page image', srcset: 'srcset larger', picture: 'picture', lazy: 'Lazy-loaded',
      bg: 'Background', pseudo: 'Pseudo-element', poster: 'Video poster', svg: 'Inline SVG',
      link: 'Image link', preload: 'Preloaded', og: 'Social image'
    }
  };

  function sourceLabel(key) {
    const l = lang();
    const v = (SOURCE_LABELS[l] || {})[key];
    if (v) return v;
    return (SOURCE_LABELS.zh[key])
      || (IH.C && IH.C.SOURCE_LABELS ? IH.C.SOURCE_LABELS[key] : null)
      || key;
  }

  /**
   * 内置还原规则的名字。
   *
   * 键是 constants.js 里的规则 id（稳定的技术标识），不是中文名 ——
   * 否则以后改名字就得连规则匹配一起改。
   * 英文漏了就退回 constants 里那份中文名，不显示空。
   */
  const RULE_LABELS = {
    zh: {
      'wp-size': 'WordPress 尺寸后缀（image-300x200.jpg）',
      'path-dim': '路径尺寸段（/300x200/、/w_300/）',
      'cloudinary': 'Cloudinary 变换段（/upload/w_300,h_200/）',
      'qiniu': '七牛云 imageView（?imageView2/…）',
      'ali-oss': '阿里云 OSS（?x-oss-process=…）',
      'bce-process': '百度云加速 BCE（?x-bce-process=…）',
      'upyun': '又拍云（! 分隔的缩略参数）',
      'taobao-cdn': '淘宝/天猫 CDN（abc.jpg_300x300q75.jpg）',
      'query-size': '通用查询参数（?w= &h= &q= &resize= …）'
    },
    en: {
      'wp-size': 'WordPress size suffix (image-300x200.jpg)',
      'path-dim': 'Path size segment (/300x200/, /w_300/)',
      'cloudinary': 'Cloudinary transform segment (/upload/w_300,h_200/)',
      'qiniu': 'Qiniu imageView (?imageView2/…)',
      'ali-oss': 'Aliyun OSS (?x-oss-process=…)',
      'bce-process': 'Baidu BCE (?x-bce-process=…)',
      'upyun': 'UPYUN (! separated thumbnail params)',
      'taobao-cdn': 'Taobao / Tmall CDN (abc.jpg_300x300q75.jpg)',
      'query-size': 'Generic query params (?w= &h= &q= &resize= …)'
    }
  };

  /** @param {string} id 规则 id  @param {string} fallback constants 里的 label */
  function ruleLabel(id, fallback) {
    const l = lang();
    const v = (RULE_LABELS[l] || {})[id];
    if (v) return v;
    return RULE_LABELS.zh[id] || fallback || id;
  }

  IH.I18n = { t, apply, lang, detect, setLang, sourceLabel, ruleLabel, STRINGS };
})();
