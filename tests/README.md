# 测试

这些是**开发期测试**，不影响扩展运行（Chrome 加载扩展时会忽略 `tests/` 目录）。

## 运行

```bash
npm ci                  # 首次：装开发期依赖（jsdom + playwright-core）
npm test                # Node 套件（15 个）
npm run test:browser    # 真实浏览器套件（25 个，需要本机 Edge / Chrome）
npm run test:all        # 两个入口都跑
```

不装 npm 也能跑，直接用 Node 执行入口：

```bash
node tests/run-all.js           # Node 套件（需要 Node 22.22.2+，DOM 相关测试依赖 jsdom）
node tests/run-all-browser.js   # 真实浏览器套件
```

`jsdom` 不在默认查找路径里时，用 `NODE_PATH` 指过去即可；两个入口都会**自动**
把受管 node workspace 与项目内 `node_modules` 补进 `NODE_PATH`。

> **浏览器套件第一次跑要先装一份完整 Chromium**：
> `npx playwright-core install --with-deps --no-shell chromium`。
> **`--no-shell` 不能省** —— headless shell 不支持 `--load-extension`，
> 装错的话 25 个套件会全部卡在「等 service worker」超时，报错看起来像扩展坏了。

CI 在 `.github/workflows/ci.yml`：`push` / `pull_request` 都跑这两个入口，
两个 job 都**不允许 `continue-on-error`**。失败时会把汇总里的 ✗ 行做成
**annotation**（Actions 的日志 API 要 admin 权限，annotations 不要）——
提交页 / PR 页上直接能看到「哪个套件红了、为什么」，不用去翻几千行日志。

## 测试套件

| 文件 | 覆盖内容 |
|---|---|
| `test-shared.js` | 纯函数：srcset 解析、URL 规范化、文件名生成、原图还原规则表；并守住「**还原候选只有一份实现**」——`buildRestoreCandidates` 必须住在 shared 里（图库要靠它判断是否显示「还原」按钮，内容脚本要靠它真的生成候选），data:/blob:/无参数地址必须生成不出候选、自定义规则要算进来、非法正则不能把函数炸掉 |
| `test-store-concurrency.js` | **核心**。存储读-改-写竞态：多个并发写入不互相覆盖、不丢数据；第 9 节专测「**读期间的写入不被迟到的读盖掉**」—— SW 冷启动时 `loadSettings()` 的异步 `get` 还在飞，`onChanged` 已把新值写进缓存，迟到的读若照单全收就会把新值盖回旧的（写入代数 `writeGen` 就是为这条加的） |
| `test-blocked.js` | 站点排除列表（jsdom）：一条记录匹配「域名本身 + 所有子域名」而**不**匹配后缀伪装（`example.com.evil.com`）；`main.js` 启动时确实不挂悬停；悬停显示路径也各自拦住；对照组（不在名单里的站点行为不变）。探针在加载 `main.js` **之前**装好，才能观察到「有没有调用 startHover」 |
| `test-scanner.js` | **核心**。jsdom 真实 DOM 环境下的嗅探引擎：9 类来源采集、原图还原择优、去重、单元素解析；第 19 节钉住**分阶段回报的顺序**（中间结果必须早于联网加工 —— 补尺寸 / 还原都还没跑，所以这一版里尺寸可能还是 0），第 20 节是深度嗅探的无限滚动仿真 |
| `test-hover.js` | 悬停快捷操作端到端：悬停 → 出现「预览 + 下载」两个按钮 → 点下载解析原图 → 发出下载请求 → 成功态反馈；点预览就地开灯箱且**不误触发下载**。含 `pointer-events` 回归断言、按钮排布断言（下载键必须停在图片右上角老位置）与「跳过 / 扩展名被纠正」文案断言 |
| `test-lightbox-gallery.js` | 灯箱顶栏「在图库中打开」按钮（jsdom）：**默认 `host` 取 `'gallery'` 时按钮不显示**（漏传时最坏是少一个按钮，不是多一个点了没反应的）→ 传 `host: 'content'` 才出现 → 点击发出 `OPEN_GALLERY` 且带当前那张的 `url` + `pageUrl` → 翻页后发的确实是**当前**那张而不是第一张 → **投递失败时不关灯箱**（关了用户手里就什么都没了）→ `IH.Lightbox.save` 已导出（快捷键要调用它） |
| `test-lightbox-filter.js` | 灯箱「按最小尺寸过滤」（jsdom，10 节）：默认 `lightboxMinSize` = 64 且 `minSize` **没被顺手改掉**（两把尺子互相独立）→ **按较短边判**：`48×48` / `1200×8` 分隔条 / `16×16` 三类都出局，而 `1200×8` 只有在「较短边」判据下才挡得住（最长边判据会漏它）→ **尺寸未知（`0×0`）一律放行**（探测超时不该被静默藏图）→ **过滤后定位不偏**（`startIndex` 是原列表下标，必须先按地址认位置再重新定位）→ meta 写明「已按 64px 过滤 N 张」→ 阈值 `0` = 不过滤且 meta 不出现「过滤」字样 → 阈值可调（600 / 16 各验一次）→ **全灭兜底**：阈值把候选全筛掉时照常打开用户点的那一张，**但提示要留着**（`dropped` 不清零）→ **只管灯箱**：`scanner.js` / `popup.js` 都**没有**读这个键（图库列表与批量下载因此不受影响）→ 设置读崩时退回「不过滤」而不是抛出去 → 导入白名单认得新键、旧配置由 `withDefaults` 补默认值 |
| `test-download.js` | **核心**。Service Worker 下载语义：`DOWNLOAD_ONE` 必须等真实结果才回应、体积取 `fileSize`/`bytesReceived`、跳过与失败的分支、扩展名被 Chrome 纠正时回传实际文件名 |
| `test-scan-cache.js` | **核心**。扫描结果缓存（SW 重启模拟：每个用例新建 vm context 跑 `background.js`，`sessionStore` 可跨实例传，等价于 MV3 的 SW 被回收后重启）。9 节：命中（第二次返回同一份 + `cached:true`）/ `deep` 与 `force` 都绕得开 / **同 tabId 换地址不命中**（键含 URL）/ **URL 不变的刷新（`changeInfo.status==='loading'`）也作废** / 关闭标签页清掉 / 设置变更清空 / 排除站点不缓存 / 跨 SW 重启仍命中 / TTL 过期后失效 |
| `test-scan-timeout.js` | **核心**。「扫描的结论必须是三态」—— 有图 / 真的没图 / **没扫成**。这一套的由来是一句用户报告：「首次点击扩展图标，嗅探有问题，要刷新下才行」。根因不在嗅探，而在后台 `scanTab()` 的 4 秒兜底计时（本意是「内容脚本没接上话」）同时也在给内容脚本的**正常加工**计时 —— 而加工的第一步「补尺寸」只能靠真实加载，真实站点上十几张还没加载的图就足够把首次回报推迟到 4 秒以上；4 秒一到就收尾，此刻一个 frame 都还没回报，结果是 `ok:true` + 空列表，图库照直说「本页没有发现图片」。9 节 40 项：先验证真实常量没被改坏、且**缩短超时的替换真的命中**（替换不到就抛错 —— 否则某天常量改了名，测试会安安静静地跑着、测的却是另一套超时）；然后是正面回归（内容脚本已确认但回报晚于「没接话」档 → **必须等**）、对照组（没接上话 → 快速收尾且必须是**错误态**，文案里不许出现「没有发现图片」）、确认过却始终不回报 → 同样错误态、中间结果先兑现而最终结果走 `SCAN_UPGRADE` 广播、内容脚本自报的 `busy` / 异常如实转达（一个 frame 报错而别的 frame 有图时整轮仍然算成功）、**页面里确实没有图片时仍然是成功态**（修「撒谎」不能把「如实」也修坏）、排除列表不受影响，最后静态钉住四处接线。注入「后台不再放宽计时」后第 2 节红 3 项 |
| `test-batch-index.js` | **核心**。批量下载序号：新批次一律从 001 起（不跨批次累加）、追加到运行中的同一批次才接着排、取消后重开仍从 001 起、悬停单张下载不干扰后续批次、`batchPrefix` 模式同样从 001 起 |
| `test-menus.js` | Service Worker 右键菜单幂等性：模拟 `onInstalled` / `onStartup` 并发触发，断言不会出现 `duplicate id` |
| `test-package.js` | 打包脚本 `tools/package.js`：**自己按 ZIP 规范独立写了一个读取器**（只认中央目录，不参考写入器的布局，否则等于拿写入器验写入器）。5 节：清单完整性 + 孤儿检测（`collectFiles` 从 manifest 递归展开，磁盘上多出来的运行时文件必须被抓到）/ zip 合法性 + 逐个条目 CRC + 与磁盘文件逐字节比对 / **可复现**（同源码打两次字节相同）/ `crc32` 标准测试向量（`''`→`0`、`'123456789'`→`0xCBF43926`、quick brown fox→`0x414FA339`） |
| `test-diagnostics.js` | **诊断包（纯函数，无需 jsdom）**。守的不是功能而是**边界** —— 诊断包是要被用户贴到公开 issue 里的文件，所以它最重要的性质是「里面不可能出现完整地址」。9 节 59 项：`hostOf` 只取主机名（丢路径 / 查询 / 锚点，保留端口）；`scrub` 把任何 `scheme://…` 换成 `[url]`（含 `chrome-extension://`）且**无状态**（连调两次结果一致 —— 正则带 `g` 会让 `lastIndex` 残留）；`sanitizeDownload` 结果只含白名单字段、`host` 从 `url` 现算、未列入白名单的 `referer` / `cookie` **连键都不出现**；`sanitizeScan` 丢掉 `pageUrl` / `title`、`sourceCounts` 只保留数字值；`sanitizeSettings` 把 `blockedHosts` 换成条数；`build` 的缺省与垃圾输入过滤；`audit` 的路径定位（`$.list[1].bad`）。第 8 节是**注入式端到端断言**：故意塞 `referer` / `cookie` / 完整 URL / 内网主机名 / 页面标题，要求序列化后连一个 `http://` 都不出现 |
| `validate.js` | 交付完整性：manifest 引用、HTML 资源、元素 id、`getURL` 路径、PNG 尺寸、内容脚本加载顺序、i18n 键、`MSG.*` 常量正反向校验、图库宿主模式（无弹窗残留 + 首帧布局）、还原候选实现唯一性；第 12 节静态钉住「在图库中打开 / 扫描缓存 / 快捷键」的接线（命令声明、后台分支、`SAVE_HOVERED` 必须广播给所有 frame、内容脚本接线、灯箱导出 `save`）；第 13 节静态钉住**「没有死设置」**——遍历 `DEFAULT_SETTINGS` 的每个键，在产品代码里找读取点，一个都没有才算死；并给三条**非 `data-key` 形态**的界面入口（分段按钮 `theme`、富文本控件 `blockedHosts` / `customRules`）加反向守卫。注入一条零读取的 `__deadProbe` 后第 13 节如实变红。**v1.11.0 又追加两组守卫**：① 图库尺寸滑条的契约（HTML 的 `min/max/step/value` 必须与 `popup.js` 的 `SIZE_MIN_*` 常量逐一对上，`min=0`/`max=4096`/`value=256` 三个需求硬指标单独钉，视图状态键 `ih_gallery_view` 不得混进 `DEFAULT_SETTINGS`）；② **跨套件夹具守卫** —— 静态扫描所有浏览器用例的 `startServer({...imgW,imgH...})` 字面量，带 `thumbPath: true` 的按短边减半算，短边必须严格大于滑条默认阈值，否则报红并指明文件与尺寸。真正的例外走文件级白名单或行内 `// fixture-ok: <理由>` 标记，理由必须写出来，且白名单引用了不存在的文件也会报红（防腐烂）。注入一个 200×150 的夹具后如实变红。**v1.12.0 再追加第 14 节**：静态钉住「多标签页合并嗅探」的 11 条接线 —— `mergeTabs` 默认值必须是 `false`（需求就是「提供开关」，默认必须是关的）、设置页必须有 `data-key="mergeTabs"`、单选 `#selTargetTab` 与多选 `#targetMulti` / `#targetsList` 三个节点都在、两者按设置互斥显示、`popup.js` 里真的读了这个设置、只在 `MODE === 'page'` 时启用、合并路径每页都传 `finalOnly: true`（否则多页并发时「先出图后升级」的广播会互相盖掉）、单页路径未被改动、去重确实按 `U.normalizeUrl(img.url)`、空态文案含「还没有勾选要嗅探的页面」。注入「默认值改成 true」与「去掉合并路径的 finalOnly」各红 1 项。**v1.13.0 再追加第 15 节（键盘与读屏器接线，19 条）**：断言一律打在**去注释后的源码**上（整块 `/* */` 与整行 `//` 先抹掉）—— 否则一句「这里本来该写 `onGridKeydown`」的注释就能把守卫骗过去；内容覆盖 listbox 语义、`#gridHelp` 是 `sr-only` 且按键说明写全、`#srStatus` 的三件套、`progress[role=progressbar]` + `aria-valuenow`、`.card:focus` 必须让 `.zoom` / `.restore` 显形、`.card:focus-visible` 必须有 `outline`、**`.sr-only` 不得用 `display:none` / `visibility:hidden`**、roving tabindex 的三元表达式、移动键与动作键接全、`keydown` 真的绑在 `#grid` 上、`announce()` 有防抖、勾选同步到 `aria-selected`、`.pick` 对读屏器隐藏、`.zoom` / `.restore` 不占 Tab 顺序。**第 16 节（诊断包接线，19 条）**：`MSG.GET_DIAGNOSTICS` 定义唯一、后台真的处理它、真扫描与缓存命中**两条路**都记摘要、扫描摘要里**没有** `pageUrl` / `title`（只留 `pageHost`）、`probeStats` 只累计计数、设置页有按钮且脚本加载顺序在 `options.js` 之前、`build` + `audit` 都在、**`audit` 挡在落盘前面**、`sanitizeDownload` 走 `pick(白名单)` 而**不是** `Object.assign` 整体透传、`DOWNLOAD_FIELDS` 里没有 `url`、`SETTINGS_OMIT` 排除了 `blockedHosts`、`URL_RE` **不带 `g` 标志**、`IH.Diag` 导出齐全、新套件已登记进 `run-all.js`。注入 7 项：删焦点显现规则 / 删四个方向键分支 / 所有卡片 `tabIndex=0` / 白名单退化成整体透传 / 摘要塞回 `pageUrl` / `URL_RE` 加 `g`，各红 1 项**v1.13.1 再追加第 17 节（扫描结论的三态，13 条）**：钉的是**接线**而不是行为 —— `finalizeScan` 的 `ok` 不能退回裸的 `!session.blocked`（那样「没扫成」又会冒充「没有图」）、`noReply` 判据必须在、`SCAN_NO_REPLY` 的文案里**不许出现**「没有发现图片」这种会被读成「这页没图」的说法、图库的「嗅探失败」分支必须排在「本页没有发现图片」**之前**、内容脚本里不再有 `error: 'busy'` 这条路径、中间结果的回报必须排在补尺寸**之前**；另外两条是「测试资产自身的完整性」：后台 vm 桩只能有一份（`tests/lib/bgstub.js`，缓存套件不许自己再养一份），以及浏览器回归套件必须以 `browser-` 开头（总入口靠这个前缀自动发现，名字起错了不会报错，它只是永远不被跑） |
| `tools/audit-settings.js` | **设置项巡检（辅助脚本，不在 `run-all.js` 里）**：把每条设置的「定义点 / 读取点 / UI 挂点 / 写入点」连**行号**列出来，把候选缩到一小撮。加 `IH_AUDIT_VERBOSE=1` 打印每条的全部命中位置。**它不做判断** —— 判定仍要人打开文件看原代码，因为反向读取（`!== false`）、属性链（`settings.batchPrefix`）、整体透传（`scanTab(tabId, opts)`）都不是简单字符串匹配能覆盖的。写它时三次把 `theme` / `blockedHosts` / `customRules` 误报成「没有界面入口」—— 分别是分段按钮组、按 id 挂的 textarea、动态列表根节点，每次都是识别方式漏了一类形态 |

### 可选：真实浏览器测试

`browser-e2e.js` / `browser-batch.js` / `browser-gallery.js` / `browser-marquee.js` /
`browser-probe.js` / `browser-probe-advance.js` / `browser-filter.js` / `browser-many.js` /
`browser-scan-limit.js` / `browser-lightbox-window.js` / `browser-panel-trust.js` /
`browser-slow-restore.js` / `browser-deep-scan.js` / `browser-lightbox-local.js` /
`browser-scan-upgrade.js` / `browser-restore-one.js` / `browser-blocked.js` /
`browser-subfolder.js` / `browser-gallery-jump.js` / `browser-preview-all.js` /
`browser-size-slider.js` / `browser-merge-tabs.js` /
`browser-first-scan.js`
会把扩展真加载进 Chromium 跑端到端，用来抓 jsdom 测不出来的问题
（真实图片加载、真实下载落盘、Chrome 改写文件名、真实鼠标拖拽等）。
它们**不在 `run-all.js` 里**，需要额外依赖：

```bash
npm i playwright-core        # 不下载浏览器，直接用系统已装的 Edge / Chrome
NODE_PATH=<node_modules> node tests/browser-e2e.js
NODE_PATH=<node_modules> node tests/browser-batch.js
NODE_PATH=<node_modules> node tests/browser-gallery.js
NODE_PATH=<node_modules> node tests/browser-marquee.js
NODE_PATH=<node_modules> node tests/browser-probe.js
NODE_PATH=<node_modules> node tests/browser-probe-advance.js
NODE_PATH=<node_modules> node tests/browser-filter.js
NODE_PATH=<node_modules> node tests/browser-many.js
NODE_PATH=<node_modules> node tests/browser-scan-limit.js
NODE_PATH=<node_modules> node tests/browser-lightbox-window.js
NODE_PATH=<node_modules> node tests/browser-panel-trust.js
NODE_PATH=<node_modules> node tests/browser-slow-restore.js
NODE_PATH=<node_modules> node tests/browser-deep-scan.js
NODE_PATH=<node_modules> node tests/browser-lightbox-local.js
NODE_PATH=<node_modules> node tests/browser-scan-upgrade.js
NODE_PATH=<node_modules> node tests/browser-restore-one.js
NODE_PATH=<node_modules> node tests/browser-blocked.js
NODE_PATH=<node_modules> node tests/browser-subfolder.js
NODE_PATH=<node_modules> node tests/browser-gallery-jump.js
NODE_PATH=<node_modules> node tests/browser-size-slider.js
NODE_PATH=<node_modules> node tests/browser-merge-tabs.js
```

> **22 套真浏览器用例全部离线**，统一走 `lib/localsite.js` 起的 `127.0.0.1` 本地站。
> 早先 `browser-e2e.js` / `browser-batch.js` / `browser-gallery.js` 打的是 `www.ithome.com`，
> 断网或代理不通就整条跳过（而且站点一改版断言就烂），现在这三套也换成了本地站，
> 在哪台机器上都能跑，结果也不再随第三方页面漂移。

| 文件 | 覆盖内容 |
|---|---|
| `browser-e2e.js` | **悬停一键保存端到端（离线）**：本地站上悬停 → 断言宿主出现、两个按钮就位、条子停在图片上半部且右对齐 → 点下载 → 校验气泡文案、后台历史（`pageUrl` 是图片所在页）、文件真的落到磁盘且字节数与服务器一致；末节重复点击，断言气泡提示「已下载过，本次已跳过」且 `chrome.downloads` **只有 1 条记录**（不是靠数目录里的文件 —— CDP 接管下载时 `conflictAction:'uniquify'` 不生效，重复下载会覆盖同名文件，「目录里还是 1 个文件」是恒真的废话） |
| `browser-batch.js` | **批量下载存的是原图而不是转码版（离线）**：本地站用 `bceProcess` 造出「页面地址带 `?x-bce-process=image/...`、服务端据此返回同尺寸纯色转码版（778B），不带参数才是真原图（噪声图 720683B）」。驱动后台批量下载后，逐张断言**落盘字节数 === `originalBytes(i)`**，而不是 `transcodedBytes(i)` —— 这条只有真下载才测得出来 |
| `browser-gallery.js` | **图库多站点切换（离线）**：同时起 A（12 张）/ B（4 张）两个本地站（必须给不同的 `title`，因为 `prettyHost()` 只看主机名、两个站都跑在 `127.0.0.1`）。断言顶栏显示的是 `127.0.0.1`、`pageHost.title` 含当前站点标题、标签页下拉框**正好 2 项**（A / B —— 图库页自己被排除）、切换后数量随之变化、重复点图标复用同一个图库标签页 |
| `browser-marquee.js` | 图库默认不勾选、鼠标拖拽框选（切换语义 / Ctrl 只加 / Alt 只减 / Esc 放弃 / 跨行框选）、单击不再重建网格 |
| `browser-probe.js` | 「探测体积」全链路：后台 `PROBE_SIZE` 消息、卡片显示的体积与服务器真实字节数逐张一致、合计体积求和 |
| `browser-probe-advance.js` | **探测推进语义**（夹具 `480×300`，短边 300 > 尺寸滑条默认 256，见第十三个坑）：130 张（> 上限 120）的站，断言一次点击覆盖全部（分批 120 + 10）、第 121 张之后不被卡住、失败项单独记 `probeFailed` 后「重试」仍覆盖全部、反复点击不卡在探测中；另含探测正常时的多批次成功对照。靠本地站点记录的探测请求日志做地面真相 |
| `browser-filter.js` | **筛选语义**：切换筛选会取消「不在新结果里」的勾选、清掉筛选不复活、排序变化不影响勾选、全选/反选只在筛选结果内，并逐步校验「已选数 === 可见勾选数」这条恒等式 |
| `browser-many.js` | **大量图片全显示**：1200 张图的站，断言没有「显示更多」按钮、不做任何操作卡片数会自己补到 1200、卡片 id 唯一，并压测框选每帧耗时（中位数 < 16ms）。第 5 节专测**「先出图、后升级」不得把已铺出来的规模缩回头** —— 升级要整体重建网格（每张卡片地址都变了），但重建时**保留当前已渲染张数**；旧行为下这里会退回首屏 120 张，导致 1200 张的站永远补不到全量。注入「升级退回彻底重来」后红 4 项 |
| `browser-scan-limit.js` | **截断如实上报**：2001 张（> `SCAN_LIMIT` 2000）的站，断言后台回传 `images.length === 2000` / `found === 2001` / `truncated === true`，弹窗底栏出现「（本页共 2001 张，仅展示前 2000 张）」；另含未超限时 `truncated === false` 且提示位隐藏、文案清空的对照 |
| `browser-lightbox-window.js` | **预览缩略图条窗口化**：300 张的站，断言条上最多 81 个缩略图、窗口贴边/居中正确、`data-i` 与列表索引对齐（窗口化后 DOM 下标 ≠ 列表下标）、连按 60 次方向键节点数不涨且高亮不丢、窗口只在索引越界时重开 |
| `browser-panel-trust.js` | **页内面板的来源校验 + 尺寸空态**：正常打开时 iframe URL 带 tabId + token 且图库确实启动；**本站图是 200×140，尺寸滑条默认 256px 会把它们整片挡住 —— 断言这时显示的是「带解释的空态」**（`N 张图片都被「最小尺寸 ≥ 256px」挡住了`）而不是含糊的「没有符合筛选条件」、并且给出「显示全部 N 张」的一键出口；**点那个出口后 40 张全部回来、空态收起**（v1.11.0 那次出口第一版是坏的 —— 默认值下把值又算回 256，点了没反应，就是这条断言抓出来的）。这个夹具**故意**落在门槛之下，见文件里的 `fixture-ok` 标记。三种伪造 iframe（无 token / 假 token / token 与 tabId 错配）都拒绝启动且连界面都不渲染；末节核对 `web_accessible_resources` —— **只有 `popup/popup.html` 与 `content/overlay.css` 该在里面**（前者是页面侧 iframe 的 src，后者是悬浮 UI 靠 URL 拉的样式表），`popup.{css,js}` / `mode.js` 由扩展页内部加载、**不该**暴露给网页，多留着只是白送指纹面 |
| `browser-slow-restore.js` | **还原慢时不能误判成没有图片**（夹具 `800×600 + thumbPath` —— 缩略图减半后是 `400×300`，短边 300 才够过尺寸滑条默认 256 的门槛；用 `600×400` 会得到 `300×200`，图库开箱即空，见第十三个坑）（用户报的「首次点击偶尔识别不到图片」）：本地站把原图放在 `/img/`、缩略图放在 `/thumb/img/`（缩略图只有一半尺寸，`path-dim` 规则必然命中），并给还原候选加响应延迟。断言扫描耗时确实跨过旧的 1.5 秒判据的前提下，仍然拿到全部图片、且已还原成原图地址与尺寸；另含「还原超出时间预算」的对照：照样一张不少，并如实上报 `restoreTruncated`。注入旧行为（去掉中间结果回报 + 加回 1.5 秒定时器）后 6 项变红 |
| `browser-deep-scan.js` | **深度嗅探（无限滚动页面）**：本地站用 `lazyBatches` 造出「首屏只渲染第一批、滚到文档底部才追加下一批」的页面。断言普通嗅探只拿到首屏 16 张、深度嗅探拿到全部 48 张、多轮采集无重复项、**滚动位置复原**；端到端另测点「深度嗅探」按钮后卡片数达到全量、loading 出现过「已采集 N 张」的滚动进度、自然滚到底时不出现「已达滚动上限」提示。注入「忽略 deep 参数」后 4 项变红 |
| `browser-lightbox-local.js` | **预览不再把人甩到原标签页**（第 1 节的图库夹具 `400×300`，短边必须 > 尺寸滑条默认 256；第 6/7 节只用悬停灯箱、不开图库网格，所以仍用 `200×150` 并带 `fixture-ok` 标记）：图库页点放大镜，断言灯箱开在**图库页内**（宿主出现、`ih-show`、拿到完整列表可连播、未发生导航），而**源页面一个 Shadow DOM 宿主都没多出来**；灯箱在本页可用（方向键切换、保存时历史里的 `pageUrl` 是图片所在页面而不是 `chrome-extension://`）；Esc 关闭后图库页仍在原处；对照断言面板模式**仍**把灯箱交给网页开；末节用 `iframe: true` 的本地站验证**图片在子 iframe 里时预览交回顶层 frame 开**（否则灯箱会被 iframe 边界裁成一小块）。注入「openLightbox 一律转发」后 14 项变红，注入「子 frame 不转发」后 3 项变红 |
| `browser-scan-upgrade.js` | **先出图、后升级**（夹具 `800×600 + thumbPath`，缩略图 `400×300`；第 4 节的 blank 对照站是 `10×10` 且带 `fixture-ok` 标记，因为它直接调后台 `scanTab` 验契约、不开图库网格）：断言网格在最终结果到达**之前**就出现（此刻还全是页面上的缩略图地址），随后原地升级成原图地址、数量不变、没有重新扫描；核心防回归是「partial 窗口里勾的 3 张，升级后仍然勾着、而且就是原来那 3 张」（按图片本体对齐，因为还原改 URL 会让 id 变）。注入「去掉 onPartial」后 5 项变红，注入「去掉勾选迁移」后 2 项变红 |
| `browser-restore-one.js` | **没还原成功的图可以单独重试**（夹具 `800×600 + thumbPath` → 缩略图 `400×300`、原图 `800×600`；注意断言里的尺寸文案是**写死**跟着夹具走的，改夹具就要一起改）：本地站用 `candidateFail` 让后 8 张的还原候选暂时 404，于是第一轮只还原成功 8 张、另 8 张停在缩略图地址上并各长出一个「还原」按钮（有按钮 ⇔ 没还原，严格一一对应）。放行候选后点「还原」，断言这一张**原地**变成原图（同图、勾选不丢、不重扫、按钮收掉），其余失败的图不受影响；候选确实不可用时如实提示「已经是能拿到的最大的版本了」并收掉按钮；对照「本来就是原图、生成不出候选」的页面一个按钮都没有；末节用 `iframe` 站验证按 `frameId` 定位（候选只被请求 **1** 次，而不是每个 frame 各跑一遍）。注入「去掉 `refresh`」后 8 项变红，注入「去掉勾选迁移」/「去掉 frameId 定位」/「不收起按钮」各红 1 项 |
| `browser-blocked.js` | **站点排除列表的四道门（离线）**：写设置后**轮询确认后台真的读到了**再开测（这一步不能省 —— 第一版只 `set` 不等待，2 项失败，反而暴露了上面那条真实竞态）。断言被排除的站点：悬停不出宿主、Alt+点击不保存、页内面板拒绝打开、后台连注入都省了；对照组站点一切照常；**显式保存仍然可用**（右键路径不受黑名单影响）；图库扫出来是空的时候如实说明「该站点已被排除」而不是「这页没图」 |
| `browser-subfolder.js` | **保存到子目录（离线）**：劫持 `chrome.downloads.download` 记录 filename，断言 `{host}` / `{date}` / `{index}` 渲染正确、`batchPrefix` 加在文件名而不是目录名上、路径穿越（`../`、盘符、超过 3 层）被清洗掉。**注意**：CDP 接管下载会丢掉子目录（只取最后一段），所以这里断言的是「交给 `chrome.downloads` 的 filename」＋「Chrome 接受了它（`state === complete`）」，**不是**「文件落在 `下载目录/子目录/` 下」—— 后者在这套脚手架里测不到，原因见下面第五个坑 |
| `browser-preview-all.js` | **悬停预览能翻本页全部图片**：本地站用 `thumbPath` （页面给 `/thumb/`、还原候选是更大的 `/img/`）＋ `imgDelay` 让还原真的发生且不瞬时。悬停**第 6 张**（故意不挑第一张）后点预览，断言灯箱计数是「6 / 12」（列表是本页全部图片、起始下标落在鼠标压着那张，而不是 `1 / 1`）、打开的是**还原后的** `/img/5.png`、缩略图条 12 张**全是原图地址**、`→`/`←`/按钮都能翻且末尾绕回首张；**加载态**必须在灯箱打开**之前**高频轮询才抓得到（等开了再看转圈早就解除，断言恒真）；末节关掉再开一次，断言仍不退化成 1 张。末节（第 4 节）验「大图预览最小尺寸」：从 service worker 侧把 `lightboxMinSize` 写进 `chrome.storage.local`，断言阈值真的被内容脚本读进内存并作用在灯箱列表上（`9999` → 12 张滤剩 1 张、meta 写出「已按 9999px 过滤 11 张」、缩略图条整条收起；改回 `0` → 12 张全部回来且定位仍正确）。注入「只送 1 张」的旧行为后 **9 项**变红 |
| `browser-size-slider.js` | **图库尺寸滑条（离线）**：本地站用 `sizeByIndex` 造出四种尺寸循环（`128×128` / `300×80` / `400×300` / `900×600`），24 张。9 节：① 控件本身 —— 存在、`min/max/step/value` 与 JS 常量一致，**外加位置契约**（`#sizeSliderRow` 必须挂在 `.ctrl-bar` 里、**不**在 `.filterbar` 里、且紧跟在选择操作组 `.seg` 之后 —— 见下条布局说明）；② **默认即过滤** —— 打开图库（未动任何控件）可见卡片就应只剩短边 ≥ 256 的那 12 张；③ **较短边判据** —— `300×80` 这张**宽度 300 > 256 但短边 80 不够**，必须被拦；反证是把滑条降到 80 后它出现（若实现误用宽度判据，第 ③ 节两条断言一正一反必然有一条红）；④ `0` = 不过滤、24 张全回来；⑤ 档位优先 —— 点 `≥ 800px` 后再拖滑条应自动把档位复位成「全部」，档位生效时 `#sizeSliderRow` 带 `overridden` 类做视觉降权（**不是** `disabled`，仍可拖）；⑥ 重置按钮把滑条打回 256（不是 0）；⑦ 跨会话持久化 —— 改值后关标签页重开，值仍在（走 `chrome.storage.local` 的 `ih_gallery_view`，**不**进 `DEFAULT_SETTINGS`）；⑧ **空态出口必须落盘** —— 阈值 700 把 24 张全滤掉 → 出现「显示全部 24 张」→ 点击后全部回来 → **关掉重开仍全部**（这一节是回归测试，见第十四个坑：出口以前只改内存不落盘，表现成「面板打开后一张卡都没有」）。注入「短边判据改成宽度判据」后 7 项变红；注入「撤掉 `syncSizeSlider()`」后 1 项变红；注入「删掉出口里的 `saveViewState()`」后 2 项变红。同一份 `sizeByIndex` 必须同时作用于 ① HTML 的 `width/height` 属性 ② 服务端真正返回的 PNG 像素 ③ lazy 批次追加脚本 —— 三处只要有一处不一致，测出来的就是假象（见下面第十一个坑） |
| `browser-merge-tabs.js` | **多标签页合并嗅探（离线，39 项 / 10 节）**：`mergeTabs` 是**默认关**的开关（设置页里开），打开后图库顶部的「扫描目标」从单选下拉变成多选勾选列表。两个本地站 —— **A 是同站两页**（`pages: [{path:'/', imageIndexes:[0..5]}, {path:'/b', imageIndexes:[3..7]}]`，故意让第 3/4/5 张**两页都有**）、**B 换 host**（`host:'localhost'`，跨站地址必然不同、永远没有重叠，用来验「合并」而不是「去重」）。① 默认关：单选在、多选不在、6 张、无来源页角标；② 打开设置**当场生效**（不用刷新）、默认勾 1 个、列表 3 行；③ 勾同源两页 → **8 张而不是 11**（去重按 `U.normalizeUrl` 的规范化地址），`/img/3.png` 全列表只出现一次；④ 每张卡片带来源页角标、顶栏写「2 个页面」；⑤ 跨站 A+B = 10 张（**没有重叠**，证明第 ③ 节的 8≠11 不是「少扫了」而是真的去重）；⑥ 只勾一个 → 退回 6 张、角标消失、顶栏回域名；⑦ 全取消 → 空态说「还没有勾选要嗅探的页面」（**不是**「这些页面没有图片」）；⑧ 搜 `localhost` → 只剩 B 站的 4 张（搜索要连来源页一起匹配）；⑨ 导出 CSV 带「来源页」列且 10 条；⑩ **切扫描目标**（图库开着时再点一次图标）—— 合并模式下勾选收缩成一个，单选模式下也必须真的换过去（**回归测试**，见第十三个坑的续记）。**注入验证**：去掉跨页去重（`if (false && prev)`）→ 红 3 项；去掉来源页角标 → 红 1 项；把 `loadTabList()` 的单选分支改回「用 `targetIds` 覆盖 `tabId`」→ 第 10 节红 2 项。夹具里的 `pages` / `host` 见下面的选项表 |
| `browser-a11y.js` | **键盘与读屏器（离线，50 项 / 10 节）**。静态守卫只能证明「代码写了」，证明不了「真的能用」—— roving tabindex 写错会变成「整个网格完全 Tab 不进去」，`:focus` 显隐规则写错会变成「Tab 到一个看不见的按钮上」，这两种错都不影响截图和鼠标操作。所以这里用**真键盘**走一遍：① 语义骨架（`role="listbox"` / `aria-multiselectable` / `aria-describedby` / `#gridHelp` 是 `sr-only` 且宽度 ≤ 1px / `#srStatus` 的 `role`+`aria-live`+`aria-atomic` / `#progress` 是 `progressbar` 且有 `aria-valuenow`）；② **整个网格只有 1 个 Tab 停靠点**（`#grid` 内 `tabIndex >= 0` 的元素计数 === 1，30 张卡片不是 30 个停靠点），且 `Tab` / `Shift+Tab` 都能正常进出；③ 方向键真的移动焦点（`→` +1、`↓` +列数、边界不越界）且 roving 停靠点跟着挪（`zeroCount` 恒为 1）；④ `Home` / `End`；⑤ `:focus-visible` 匹配、`outline` 是 `solid ≥ 2px`、**聚焦卡片上 `.zoom` 的 `opacity` 真的是 1**（WCAG 2.4.7），而未聚焦未悬停的卡片上仍是 0（焦点规则没有误伤全局）；⑥ `Enter` / `空格` 勾选（`class` 与 `aria-selected` 双写）且读屏器播报「已勾选 1 张」（要等过 180ms 防抖）；⑦ `P` 打开灯箱、`Esc` 关掉；⑧ `.pick` 的 `aria-hidden` + `tabIndex=-1`、`.zoom` / `.restore` 不占 Tab 顺序、卡片可访问名称以「第 1 张」开头且**不含**勾选状态；⑨ 搜索把列表清空后没有残留的 `tabindex=0`，恢复后停靠点被夹回第一张。**注入验证**：让所有卡片都 `tabIndex = 0` → **50 → 45/5** |
| `browser-gallery-jump.js` | **灯箱「在图库中打开」+ 扫描缓存（离线）**：网页上悬停预览（v1.9.0 起拿到本页全部图片，但顶栏按钮发的是**当前那张**）→ 点它图库标签页打开并**定位到那张卡片**（`.ih-focus`、滚进视口、原页灯箱收起）→ 图库页自己的灯箱**不显示**这个按钮（`host === 'gallery'`）→ 关掉再开走缓存（实测 **227ms**）且界面如实标注「复用 N 分钟前的嗅探结果」→ 点「重新嗅探」绕开缓存 → 点底栏那行缓存标记本身也能强制重扫。注入「默认 host 改 content」红 5 项、「不按宿主判断」红 5 项、「失败也关灯箱」红 9 项、「永远发第一张」红 5 项、「缓存不校验地址」红 6 项 |
| `browser-diagnostics.js` | **诊断包导出全链路（离线）**。`test-diagnostics.js` 已经测过纯函数，但用户点的是设置页那个按钮，中间还隔着四段可能悄悄断掉的接线：设置页 → `sendToBg(GET_DIAGNOSTICS)` → background 回原料 → `IH.Diag.build()` → `audit()` → `U.downloadText()`。**任何一段坏了，界面表现都是「点了按钮什么也没发生」，而纯函数测试全绿。** 所以这里在真浏览器 + 真扩展里走一遍：① 先真扫一次（12 张），断言 background 的 `lastScan` 真的存在、`pageHost` 是这次那个站、`found` 与真实张数对得上、有来源分布、**没有 `pageUrl`**；② 写一条排除列表并**确认后台读到了**（不能只 `set` 不等待，见 `browser-blocked.js` 的教训）；③ 打开设置页，把 `IH.U.downloadText` 截下来（**不真去读磁盘上的下载文件** —— CDP 接管下载会把文件名改写成随机名，「找到那个文件」本身就是不稳的活儿，而这里要断言的是**内容**），点按钮，断言确实产出了 payload、文件名匹配 `image-hunter-diag-<8位>-<6位>.json`、mime 是 `application/json`；④ payload 内容：`_version` 必须等于 `chrome.runtime.getManifest().version`、`settings.blockedHostsCount` 等于条数而 `blockedHosts` 键不存在；⑤ **边界**：`http://` / `https://` / 带端口的本机地址 / 图片路径 `/img/` / 被排除的站点域名**一个都不出现**，`scheme://` 出现 0 次；⑥ `audit` 判定干净，且**注入一个地址后如实报出 `$.settings.__probe`**（证明上一条不是恒真） |
| `browser-first-scan.js` | **首次点开图标就要出图（离线，12 项）** —— 用户原话是「首次点击扩展图标，嗅探有问题，要刷新下才行」。这里是那条 bug 的**端到端**回归：把页面图片的 `src` 挪到 `data-src`（真实站点上「懒加载还没触发」「图还没加载完」都是这个形态，此时 `naturalWidth = 0`，尺寸只能靠联网探测补），再让服务端每张图延迟 2.5 秒响应 —— 12 张、探测并发 6，于是「补尺寸」这一步必然越过后台的 4 秒判据。① 首次打开就铺出 12 张、且出图耗时在 4 秒判据之内；② **全程**没有出现过「本页没有发现图片」这句错话（一边等一边记录，不只在最后看一眼 —— 中途出现过又消失，对用户来说也是出现过）；③ 最终结果仍会到、尺寸全都补上（这里要按**卡片上的尺寸文案**等，别拿 `statTotal` 当「最终结果到了」的判据：中间结果里它就已经是 12 了，一查就返回，等于什么都没等）；④ 关掉图库、趁上一轮还没跑完再打开一次 → 也要出图（内容脚本「忙」时排队，不回空结果）；⑤ **反向**：页面里真的一张图都没有时，仍然如实说「没有发现图片」（这一节必须先换一个地址，否则会命中后台的扫描缓存 —— 那是它该做的事）。注入「把提前回报关掉」后首次出图 5710ms，第 1 节如实变红 |
| `screenshot.js` | 给界面截图（改 UI 后快速看效果），输出十一张，**默认全部落在 `docs/screenshots/`**（第二个参数可改目录，脚本会自己把目录建出来）：`gallery-preview.png`（真实默认态）、`gallery-filters.png`（搜索框展开 + 有生效条件）、`gallery-panel.png`（页内面板模式 380px 窄屏，主动展开筛选条看最挤的情况）、`gallery-marquee.png`（框选进行中）、`gallery-lightbox.png`（图库页内的大图预览）、`hover-buttons.png`（网页图片右上角的两个按钮）、`gallery-restore.png`（没还原成功的卡片右下角的「还原」按钮）、`options-page.png`（设置页全页，含「站点排除列表」与「保存到子目录」，拍的是全新配置的真实默认态，顺带把页脚版本号读出来打在日志里，确认它是从 manifest 取的而不是写死的）、`lightbox-content.png`（**网页里**打开的灯箱，顶栏带「在图库中打开」按钮 —— 对比 `gallery-lightbox.png` 可见图库页自己的灯箱不显示它）、`gallery-empty-size.png`（尺寸过滤清空时的空态 + 一键出口）、`gallery-merge-tabs.png`（多标签页合并嗅探的勾选面板 —— v1.12.0 唯一的新界面，而且**默认关**，不主动打开就永远看不到它，所以脚本里显式开一次开关、再开一个别的页面，然后拍展开的面板；控件没切过来就打印警告，别把「面板没展开」当成「截好了」）。不传目标 URL 时用 `lib/localsite.js` 起本地站，栅格布局稳定可复现。**面板那张必须走内容脚本真领 token 那条路**（从后台发 `TOGGLE_PANEL` → 抓页面里那个带 token 的 iframe → 按它的 URL 重开），不能自己拼 `?mode=panel&tabId=N` 直接 goto —— v1.8.1 的来源校验会拒绝没有 token 的宿主，截出来是那句「已拒绝在此显示图库」。脚本现在按**渲染出的是哪种界面**做硬检查（有拒绝文案 → 真挂了；有 `#grid` 但 0 张 → 大概率是过滤把夹具清空了；有卡片 → 正常），不再把「正常空态」误报成拒绝页（见第十四个坑） |

`lib/bgstub.js` 是后台（`background.js`）的 **vm 测试桩**：一套够用的假 `chrome`，把 SW 原样跑在 vm context 里，于是「扫描超时判据」「缓存键」这类纯后台逻辑可以毫秒级、完全离线地断言，不必起浏览器。两个能力是它存在的理由：**内容脚本是可编程的**（`opts.onScan` 决定什么时候回报、报什么、报不报 —— 超时 / 排队 / 报错这些场景只有这样才测得了），以及**超时常量可缩短**（它们是 `const`，vm 里从外面改不到，所以对源码做一次**带校验**的替换，替换不到就抛错）。
`test-scan-cache.js` 与 `test-scan-timeout.js` 共用它 —— 两份桩迟早会分叉。

`lib/localsite.js` 是上面几个用例共用的**本地图片站点**：起一个 `127.0.0.1` 上的 HTTP 服务，
用 `zlib` 在内存里手写 PNG 编码生成真实图片。好处是**完全离线、数据可控**——
图片字节数有地面真相，可以拿来跟界面显示的体积逐张比对。

它通过选项模拟各种真实站点的形态：

| 选项 | 模拟的场景 | 用在 |
|---|---|---|
| `probeFail` | 站点禁止跨域读取响应头 | `browser-probe*` |
| `imgDelay` + `thumbPath` | 缩略图放在 `/thumb/`、原图在 `/`（缩略图尺寸减半），且**只给还原候选加响应延迟** | `browser-slow-restore` |
| `candidateFail` + `thumbPath` | **只让还原候选**（`/img/`，不是页面上的 `/thumb/`）返回 404 —— 图片本身照常显示，只是「更大那张」暂时取不到。比用延迟造超时更快也更确定 | `browser-restore-one` |
| `lazyBatches` | 无限滚动：首屏只渲染第一批，滚到文档底部才追加下一批 | `browser-deep-scan` |
| `iframe` | 顶层页面一张图都没有，图片全在子 iframe（`/frame`）里 | `browser-lightbox-local`、`browser-restore-one` |
| `bceProcess` | 页面里的图片地址带 `?x-bce-process=image/auto-orient,o_1/format,f_avif`；**带参数 → 服务端返回同尺寸纯色转码版（778B），不带参数才是真原图（噪声图，约 720KB）**。用来验证批量下载存下来的是原图而不是转码版 | `browser-batch` |
| `title` | 覆盖页面 `<title>`。**多个本地站点同处一个测试时必须给不同标题** —— `prettyHost()` 只看主机名，两个站都跑在 `127.0.0.1` 上分不出来 | `browser-gallery` |
| `host` | 换掉监听的 host 名（默认 `127.0.0.1`）。用来造**两个「同源不同名」的站** —— `127.0.0.1` 与 `localhost` 指向同一台机器，但 `prettyHost()` 认得出是两个站点，于是能测「跨站合并」而不是「同站去重」。返回值上的 `host` / `origin` 跟着变 | `browser-merge-tabs` |
| `pages` | **一个服务上挂多个页面**：`[{ path:'/', imageIndexes:[0..5], title:'…' }, { path:'/b', imageIndexes:[3..7], title:'…' }]`。`imageIndexes` 是「这一页渲染哪几张」（子集），于是能故意让同一张图**出现在两个页面上**，用来验跨页去重。返回对象多出 `pathUrl(p)`（拿某页的绝对地址）与 `pages`。**注意**：`total` 在 `pages` 模式下改成「各页 `imageIndexes` 的最大值 + 1」，不再是 `perBatch * lazyBatches` —— 后者在子集模式下会算出根本不合法的序号上界，图片集体 404 | `browser-merge-tabs` |
| `sizeByIndex` | 逐张指定尺寸：`(i) => ({w, h})`。**必须同时作用于三处** —— HTML 的 `width/height` 属性、服务端真正返回的 PNG 像素、lazy 批次追加脚本。用来测「尺寸筛选」这类依赖真实像素的判据 | `browser-size-slider` |

> `lazyBatches` 有个容易踩的坑：**每批必须比视口高一屏以上**。
> 第一版用 24 张（6×4）刚好塞满 900px 视口，首屏就「已经在底部」，
> 滚动根本触发不了追加 —— 深度嗅探滚不动，测出来的现象和真实站点完全不同。

两个可选开关（都是给「体积探测」类用例用的）：

| 选项 | 作用 |
|---|---|
| `probeFail: true \| (i) => boolean` | 让**探测请求**（HEAD / 带 Range 的 GET）返回 `500 + Content-Length: 0`。页面自身的 `<img>` 是普通 GET，不受影响 —— 图片照常显示、照常被嗅探，只有体积拿不到。用来复现「探测全失败」 |
| 返回值上的 `probeLog` / `probedIndexes()` / `resetProbeLog()` | 逐条记录探测请求（`{i, method, range}`）以及命中的去重图片序号。**这是地面真相**：只看界面文案分不清「换了一批新的」还是「又把同一批重试了一遍」 |

还有一个给「单张还原」用的地面真相：

| 选项 | 作用 |
|---|---|
| `candidateFail: true \| (i) => boolean` | 只让**全尺寸那张**（`/img/N.png`，即还原候选）返回 404，`/thumb/` 缩略图不受影响。传函数时可以靠外部开关控制，于是能演「先失败 → 再放行 → 点重试」。仅在 `thumbPath: true` 时有意义 |
| 返回值上的 `fullLog` / `fullHits(i)` / `resetFullLog()` | 逐条记录**全尺寸图**的请求。用来区分「只问了一次」和「每个 frame 都问了一次」—— 后台转发「单张还原」时如果忘了带 `frameId`，标签页里每个 frame 的内容脚本都会各跑一遍同样的探测 |

还有一个给「批量下载」用的地面真相（配合 `bceProcess`）：

| 返回值 | 作用 |
|---|---|
| `originalBytes(i)` | 第 i 张**原图**的字节数（噪声 PNG，不可压缩，每张都不一样） |
| `transcodedBytes(i)` | 第 i 张**转码版**的字节数（同尺寸纯色 PNG，只有几百字节） |

两者差三个数量级，所以「落盘文件 === `originalBytes(i)`」这条断言不可能碰巧成立。
用每张图**自己的字节数**而不是「有没有重试」做判据，是因为 `chrome.downloads` 的
`failedUrls` / `skippedUrls` / `attempts` 都是**累积数组**（新批次不去重），按 URL 判断不可靠。


## 关于 jsdom 的几个坑

写这类测试时有三个必踩的坑，`test-scanner.js` 里已经处理好：

1. **必须加 `runScripts: 'outside-only'`**，否则 `dom.getInternalVMContext()` 拿不到 vm context，`vm.runInContext` 会直接抛错
2. **不能直接把 `window` 当 vm context 用**，必须走 `dom.getInternalVMContext()`
3. **jsdom 缺失的 API 要打桩**，否则核心逻辑根本测不出来：

| API | jsdom 行为 | 处理方式 |
|---|---|---|
| `getBoundingClientRect()` | 全部返回 0 | 按属性返回固定尺寸 |
| `naturalWidth` / `naturalHeight` | 不存在 | `Object.defineProperty(HTMLImageElement.prototype, ...)` |
| `currentSrc` | 可能为空 | 返回 `src` 属性 |
| `new Image()` | 不会真正加载 | 自定义类，按尺寸表异步回调 `onload` / `onerror` |
| `getComputedStyle(el, '::before')` | **完全不支持** | 自行拦截，按选择器返回假样式 |

> 注意：jsdom 不会加载 `<link rel="stylesheet">`，所以 `test-hover.js` 里的点击成功，
> 同时也验证了「即使 `overlay.css` 加载失败，悬停按钮依然可点击」这条降级路径。

## 测试自己会骗人：二十二个坑

前两个是「报绿但没测」，第三、五个是「断言恒真」，第六个是「注入验证根本没跑」，
第七个是「超时被吞掉，把真 bug 伪装成正常」，第八个是「断言的前提被后来的修复推翻，
于是修复被当成回归拦下来」，第九个是「取证范围自己划错，于是误报」，
第十个是「**错误的行为被写成断言，把 bug 固化成预期**」，
第十六个是「**守卫扫到了它自己的注释**」，
第十七个是「**断言把『关掉』的判据写错了**」，
第十八个是「**手写清单漏掉一个套件时不会报错**」。
共同点是**失败时不出声** —— 而一个不出声的测试比没有测试更危险。

### 1. 裸 `await` 等一个永远不来的响应 → Node 静默退出，runner 报绿

这是最危险的一个，因为**它看起来是绿的**。

```js
// 反面教材
await new Promise((r) => {
  listeners.message[0]({ type: 'IH_RELOAD_SETTINGS' }, {}, r);
});
```

`IH_RELOAD_SETTINGS` 这个类型在产品代码里**根本不存在**（全仓库只此一处），
后台路由落到 `default: return undefined`，`sendResponse` 永不调用 —— 这个 Promise 永不 settle。
此时事件循环里**一个 timer 都没有**，Node 不会报错，会**静默以退出码 0 结束**。
于是 runner 认为通过，而套件剩下的一半断言一条都没跑。

`test-batch-index.js` 曾经就是这样：8 条断言只跑了 7 条，一路绿灯。

两道防线，缺一不可：

| 防线 | 位置 | 作用 |
|---|---|---|
| **消息等待必须带超时** | 各套件的 `ask()` / `sendMessage()` 助手 | 类型不存在或 handler 不回话时，超时 reject，套件以非 0 退出 |
| **runner 必须校验完成标记** | `run-all.js` | 每个套件跑到底都要打印 `通过 N 项，失败 M 项`；没打印就判「套件中途退出，未跑完」 |

所以：

- **新写「发消息等回应」的助手时，一律带超时**，不要裸 `await new Promise`
- **新写套件时，收尾必须打印 `通过 N 项，失败 M 项`**（`console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')`）。
  建议把 `run()` 包一层 try/catch，让异常也走收尾，避免整个套件连汇总行都没有
- 别指望只靠退出码：`run-all.js` 现在还会看完成标记

> 注意 `test-download.js` 的 `sendMessage()` 里有 `if (handled !== true)` 守卫，
> 但那只覆盖「后台同步返回 undefined」这一种情况；handler 返回 `true` 却永不回话时
> 仍然会挂住 —— 所以那里也补了超时。

### 2. 真浏览器里两条「断言永远为真」

写 `browser-*` 时踩到过两次：断言写得很像回事，实际**新旧行为都通过**。

1. **页内 UI 在 Shadow DOM 里，`document.querySelector` 看不见它。**
   断言「源页面没开灯箱」时如果写 `document.querySelector('.ih-lb')`，结果恒为 `null`，
   于是等于什么都没测。必须遍历 `[data-ih-host]` 再进 `shadowRoot` 查。
2. **内容脚本跑在隔离世界，网页的 main world 读不到它的 `window.IH`。**
   `page.evaluate(() => window.IH.__lightboxOpen)` 对普通网页永远是 `undefined` ——
   这个断言同样恒真。判断网页那边开没开灯箱，只能看 DOM 事实（宿主 / `ih-show`）；
   `IH.__lightboxOpen` 只在**扩展页面**（图库页、面板 iframe）里可信。

### 3. 断言要带「空值守卫」，否则失败方式会很难看

`test-hover.js` 曾经在预览键不存在时直接 `dispatchEvent(null)` 抛 `TypeError`，
把整个套件打断在半路 —— 于是你看到的是「套件崩了」，而不是「预览键没了」。

拿元素之前先守卫：

```js
if (!pv || !bar || !btn) { check(false, '悬停条里应该有预览键和下载键'); process.exit(1); }
```

同类的还有**注入验证的锚点必须唯一**：`String.replace` 只换第一处，
锚点如果在一个文件里出现两次，注入就静默失效、测试全绿，会让你误判「这条断言没用」。

```js
const anchor = '    if (MODE === \'panel\') {\n      const res = await U.sendToBg(';
if (s.split(anchor).length - 1 !== 1) process.exit(1);   // 命中次数必须校验
```

### 4. 等「卡片齐了」会拿到 partial，不是最终结果

`browser-restore-one.js` 第一版就是这么写的：等 `cards === 16` 就开测，结果
`restored` 一直是 0。原因是 v1.7.1 的「先出图、后升级」——**第一版中间结果会先铺出来**，
那一刻卡片数已经对了，但原图还原还没跑完，卡片地址全是页面上的缩略图。

凡是「扫描结果里的某个字段」做断言，等待条件都不能只看数量，必须等到**状态稳定**：

```js
// (restored, btns, cards) 连续 1.2 秒不变，才算这一轮真的结束
const key = s.restored + '/' + s.btns + '/' + s.cards;
if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
else if (Date.now() - stableSince > 1200) return s;
```

同一个坑还有第二种形态：图库**复用同一个标签页**（`openGallery` → `GALLERY_TARGET`），
切站点时上一个站点的数量还挂在 `statTotal` 上。新站点数量更少时，
「数量 ≥ N」一上来就成立 —— 测的是上一轮的残留数据。
用**卡片 URL 里的端口**认站点最稳，别用数量。

### 5. CDP 接管下载会丢掉子目录 —— 「文件落在哪」有时测不到

`browser-subfolder.js` 第一版有 5 项失败，断言写的是「文件落在
`下载目录/127.0.0.1/0.png`」。跑 `tests/_probe-subdir.js` 实测后才发现：

| 做法 | 实际结果 |
|---|---|
| `Browser.setDownloadBehavior` / `Page.setDownloadBehavior` 指到 DL | 扩展给的 filename 是 `sub/one/0.png`，**落盘却只有 `DL/0.png`** —— 子目录被丢掉，只取最后一段 |
| 不用 CDP，靠 Playwright 默认下载处理 | 更糟：Playwright 把文件名换成 GUID 落到 artifacts 目录，子目录同样没了 |
| 不用 CDP 且 `acceptDownloads: false` | 直接 `USER_CANCELED` |

也就是说：**「子目录真的建出来了」这件事，在这套脚手架里根本观察不到** ——
继续断言下去，只会得到一个永远为假的断言（而不是一个恒真的废话，但同样没用）。

改成能测的两条：

1. **交给 `chrome.downloads` 的 filename** —— 劫持 `chrome.downloads.download` 记下来，
   这是扩展**真正请求**的东西，子目录信息完整；
2. **Chrome 接受了它** —— 下载记录的 `state === 'complete'`，证明这个带 `/` 的
   filename 不是非法的、不会被浏览器静默拒绝。

> 这一条和坑 2 是同一枚硬币的两面：坑 2 是「断言永远为真」，这条是「断言永远为假」。
> 两种都是**没测到**，区别只是骗你的方向相反。
> 遇到「怎么写都不对」的断言，先停下来问：**这个事实在当前环境里到底可不可观察？**

### 6. 注入验证脚本里 spawn 子进程 → 全部静默失败，误判「这条断言没用」

「注入验证」的做法是：把产品代码的**旧行为改回去**，确认新断言**确实变红** —— 变红才证明这条断言真在盯着新逻辑。第一版把整个流程写成脚本（`tests/_inject-cache.js`），脚本里用 `execFileSync` 去跑「打补丁 → 跑测试 → 还原」。

结果**六条注入全部报「没变红」**，看着像是六条断言都是废物。实际原因是：**本环境不允许脚本内 spawn 子进程** —— `execFileSync` 直接抛 `status=null`，stdout / stderr 全空，被脚本当成「测试没红」。

正确做法是**把「打补丁」和「跑测试」拆开，由 shell 循环串起来**：

```bash
# tests/_patch.js 只做一件事：按索引把某处旧行为改回去（或还原）
for i in 0 1 2 3 4 5; do
  node tests/_patch.js $i              # 打补丁
  node tests/test-scan-cache.js        # 在 shell 里跑，不经过脚本 spawn
  node tests/_patch.js restore         # 还原
done
```

拆开之后六条注入分别红 4 / 5 / 2 / 1 / 3 / 2 项，还原后 34 项全绿 —— 断言都是有效的。

> 教训：**注入验证的「跑测试」那一步要交给 shell**，别塞进一个 Node 脚本里再 spawn。
> 同时**锚点唯一性校验依然必须有**（`String.replace` 只换第一处）：
> 本阶段真的撞到 `payload: { url: c.url, … }` 在 `content/lightbox.js` 里命中 **2 次**
> （`downloadOne` 和 `openInGallery` 各一处），校验拦下来后改用多行锚点才成功注入。

上面几条都是同一个教训：
**先想清楚「这条断言在旧行为下会不会变红」，再写它。**
`browser-lightbox-local.js` 和 `test-hover.js` 里的每条新断言都做过注入验证。

### 7. 用 `.catch(() => {})` 吞掉等待超时 → 真 bug 被伪装成「很快就完成了」

`browser-many.js` 原来这么等「卡片自动补全到 1200 张」：

```js
await gallery.waitForFunction((want) => /* 卡片数 >= want */, 1200, { timeout: 30000 })
  .then(() => { cards = 1200; })
  .catch(() => {});                       // ← 超时被静静吃掉
const elapsed = Date.now() - t0;          // ← 于是这只是「超时后过了多久」
```

结果是：**卡片其实根本补不到 1200 张**（升级重建把已铺出来的图片缩回了首屏 120 张，
一直循环），30 秒超时后 `.catch` 吞掉异常，代码继续往下走，
`elapsed` 打印出 **341ms** —— 一个完全无意义的数字，却被读成「补全很快」。

也就是说：**这条最该报警的断言，恰好因为它吞掉了超时而彻底失声。**

修法：**等待超时一律如实失败**，不要 `catch` 成空函数。
需要「拿不到就继续」的场合，也要把失败**记进断言**，而不是静静咽下：

```js
// 会抛就让它抛：waitForFunction 超时本身就是一条失败信息
await gallery.waitForFunction((want) => /* ... */, 1200, { timeout: 30000 });
```

判据很简单：**写完 `.catch` 之后问一句「这里面原本要报的错去哪了？」**
答案是「没了」的时候，就是在培养下一个不会出声的测试。

> 第六个坑（注入验证 spawn 失效）和这个是同一类病：**失败信息被中间层吃掉了**。
> 一个在脚本里 spawn 失败、一个在 catch 里吞异常 —— 表面现象都是「一切正常」。

### 8. 断言的**前提**会被后来的改动推翻 —— 于是修复被当成回归拦下来

v1.9.0 之前，`browser-gallery-jump.js` 里有一条断言长这样：

```js
check(lbInfo.prevDisabled === true && lbInfo.stripHidden === true,
  '这一张是孤零零一张（← 禁用、缩略图条隐藏）—— 正是要补的那个缺口');
```

它断言的是「悬停预览只有 1 张」这个**当时的缺口**，用它来保证后面的
「在图库中打开」测的确实是「孤零零一张也能跳过去」这条路径。

v1.9.0 把这个缺口补上了（预览里就是本页全部图片），于是 `prevDisabled` 变成
`false`、缩略图条也不再隐藏 —— **这条断言立刻变红，而它红的原因恰恰是修对了。**

这正是第五个坑那一类「静态校验的前提也会写错」的反面：
前提不是写错了，是**被后来的正确改动推翻了**。两种情况的处理是一样的：
**以实测为准，并且回头把那条断言一起改掉**，否则它下次还会拦人。

翻面之后它仍然有 guarding 作用 —— 列表要是退化回 1 张，这条又会红：

```js
check(lbInfo.prevDisabled === false && lbInfo.stripHidden === false,
  '预览里已经是本页全部图片（← 可用、缩略图条可见）—— v1.9.0 补掉的缺口',
  lbInfo && JSON.stringify(lbInfo));
```

判据：**看到一条断言变红，先问「它断言的是行为，还是某个历史状态？」**
后者在被有意改变时必须跟着改，并且把「为什么改」写进注释 ——
不然下一个人读到它，只会以为这个功能是坏的。

### 9. 「我搜过了，没有」——**搜索范围是自己划的，划错了必然误报**

这是第五个坑的同族，但更隐蔽：不是断言前提写错，是**做结论时的取证范围划错**。

两次同类事故：

- **v1.8.1**：我说 `scanImg`「被 scanner 读取但设置页没有开关，用户无法关闭」。
  回源核对才发现它确实有读取（`scanner.js:636`），而且导入 JSON 也能改
  （白名单 = `DEFAULT_SETTINGS`）。**错在把「没有 UI」等同于「改不了」。**
- **v1.9.1**：我列了 5 个「疑似死设置」，回源核对后**五条全部证伪**。
  根因是取证范围：我只在自己以为「该读它」的文件里搜（`popup.js` / `main.js`），
  而真正读它们的全在 `scanner.js` 和 `utils.js`。

两次的病一样：**先有印象，再去搜一个足以支撑印象的范围** —— 那不是取证，是找证据。

判据与做法：

1. **搜索范围要由「这个键可能被谁用」决定，而不是由「我记得它在哪」决定。**
   拿不准就把全仓库（排除 `tests/` / `dist/`）扫一遍，再看命中。
2. **反向读取、属性链、整体透传是字符串搜索的三个盲区**：
   - 反向判断：`settings.scanImg !== false` —— 搜 `scanImg` 能中，但逻辑恰恰相反
   - 属性链：`settings.batchPrefix` —— 搜 `batchPrefix` 能中，但要看是不是 `settings.` 上的
   - 整体透传：`scanTab(tabId, opts)` 里 opts 带着一堆设置进门 —— 在任何一处搜键名都不会中
3. **所以「搜不到读取点」只是把人缩小到一小撮候选，绝不能直接当结论。**
   每个候选都要**打开文件看那几行原代码**。
4. 工程化的做法：`tools/audit-settings.js` 把四个维度（定义 / 读取 / UI 挂点 / 写入）
   连行号列出来，`validate.js` 第 13 节再把「一个读取点都没有才算死」这条底线静态钉死。
   **工具负责缩小范围，人负责下结论** —— 这两件事不能互相替代。

> 第九个坑和第五个坑（断言前提写错）的共同点是：
> **「我以为」参与了结论的形成**。第五个是以为前提还对，这个以为范围够用。
> 差别在于第五个的修复要靠实测，这个的修复要靠**扩大取证范围**。

### 10. 把**错误的行为**写成断言 —— 测试通过，bug 被固化成「预期」

第九个坑是「搜错了地方」，这个坑更深一层：**搜对了地方，但把错的东西钉住了。**

v1.10.0 做「灯箱按最小尺寸过滤」时，我在实现里给「阈值把候选全筛掉」这种
边缘情况写了个兜底（放开过滤、只显示用户点的那一张），顺手把 `dropped` 也清成了 0，
并在单元测试里断言：

```js
// 反面教材 —— 这条断言把 bug 变成了「预期行为」
check(fAll.minSize === 0 && fAll.dropped === 0,
  '这种情况下如实报「本轮未过滤」，不假装滤掉了 2 张');
```

单元测试 38/0 **全绿**。然后在真浏览器里加第 4 节要验「设置真的从扩展存储读进来了」，
才看见：

```
阈值 9999 = {"meta":"200 × 150  ·  PNG  ·  1 / 1","thumbCount":0}
✗ meta 如实写出「已按 9999px 过滤 N 张」   → 200 × 150  ·  PNG  ·  1 / 1
```

**过滤确实生效了（12 张 → 1 张），但灯箱里一个字都没说。**
用户刚刚正是被这个阈值挡住的那一个，他看到孤零零的 `1 / 1`，
只会以为「这页就这一张图」或者「嗅探坏了」—— 而这恰恰是那句提示最该起作用的时候。

问题有两层，第二层才是关键：

1. 产品逻辑错（`dropped` 不该清零）；
2. **单元测试用一条断言主动认可了这个错误** —— 它不再是「漏测」，
   而是把错误行为声明成了预期。下次有人想改对，反而会被这条断言拦住。

判据与做法：

1. **写断言时问一句「这是在描述事实，还是在描述我希望的事实」。**
   上面那条断言读起来像在描述事实（「如实报」），其实是在替一个刚写下的实现选择背书。
   实现是我几分钟前才拍的，凭什么它就成了「如实」的标准？
2. **边缘分支的断言要来自产品意图，不能来自实现。** 这里的产品意图只有一条：
   *用户必须知道图是被他自己设的门槛挡掉的*。从这个意图出发，
   正确断言是 `dropped === 1` 且 meta 里看得到那句话 —— 无论实现怎么兜底。
3. **换个宿主再验一遍。** 这个 bug 是在真浏览器里暴露的，不是在 jsdom 里 ——
   不是因为 jsdom 测不了，而是因为我**换了个更贴近用户的问题**去问它
   （「用户到底看不看得见」而不是「我的函数返回了什么」）。
   同一个功能有两个宿主时，两个都跑一遍，问的角度不一样，能互相补盲。
4. **注入验证也是这个道理的反面用法**：把实现改成错的（`dropped = 0`），
   正确的断言必须变红。如果改了实现测试还绿，说明断言没咬住真正要保的东西。
   —— 这条在这里没做，是这次留下的教训：**边缘兜底分支至少要有一次注入验证。**

### 11. 造数据的「一个真相源」被拆成三份 —— 三处各写各的，测出来的是幻觉

做「图库尺寸滑条」（v1.11.0）时需要本地站按张给出不同尺寸。加 `sizeByIndex` 时我把它
分别接到了三个地方：

1. `buildHtml()` 里 `<img>` 的 `width` / `height` **属性**；
2. `pngOf()` 里**真正返回的 PNG 像素**；
3. lazy 批次追加时那段内联脚本里的 `SIZES` 表。

三份数据描述的是「第 i 张图多大」这**一件事**。只要有一处脱节，测出来的现象就与真实站点
完全不同 —— 而这种错不会报错，只会让断言以极其费解的方式失败。

本轮实际连踩两次，都在同一处：

- **少一个引号**：`attrs(i)` 返回 `' width="..."'`，而原来的调用处是 `'" width="'`（收尾引号在调用处）。
  我把调用处换成 `+ attrs(i)` 后，`src` 属性少了收尾引号，HTML 变成
  `<img src="/img/0.png width="100" height="100" ...>` —— 浏览器把 `src` 解析成 `/img/0.png width=`，
  **整页图片集体 404**。表现是「图库一张都扫不到」，看起来像嗅探坏了。
- **作用域放错**：`sizeAt` 定义在 `buildHtml()` 内，而 `pngOf()` 在 `startServer()` 里 ——
  后者根本看不到前者，直接 `ReferenceError: sizeAt is not defined`（这次倒是痛快地报错了）。

判据与做法：

1. **一个事实只能有一个产出点。** 修法不是「把三处对齐」，而是抽出模块级 `sizeOf(opts, i)`，
   让三处都从它取值 —— 对齐是维护负担，共用是零负担。
2. **别在 HTML 字符串里手工拼属性。** 属性值里带引号时，调用处的固定引号与返回值里的引号
   会互相抵消。要拼就把**完整属性**（含引号、含前导空格）当作一个整体返回，
   调用处不加任何额外引号 —— 否则迟早又是「少一个引号、整页 404」。
3. **报错是好事。** 第二次的 `ReferenceError` 五分钟就修好了；第一次的静默 404 才是时间黑洞。
   如果一个改动能让现象「看起来像另一个模块坏了」，优先怀疑自己刚动过的那一段。
4. **加完 `sizeByIndex` 先跑一遍最简用例**（哪怕只是一个 `console.log` 图片数），
   确认整页图片仍能正常加载，再去写真正的断言。**别把基础设施的错误和被测逻辑的错误混在一次调试里。**

### 12. 工具类脚本「打印成功」≠「做对了事」—— 截图脚本连出几轮拒绝页

第 10 个坑讲的是**断言**把错的行为钉住了。这里更外一层：**截图脚本根本没断言**。

`gallery-panel.png` 是九张截图里唯一一张窄屏图 —— 面板模式 380px，是最挤的宿主，
`.ctrl-bar` / `.filterbar` / 尺寸滑条在窄屏会不会塌，全靠它来看。
但 v1.8.1 给页内面板加了**来源校验**（内容脚本向后台领一个只属于本标签页的 token
写进 iframe URL，popup 启动时回后台核验，伪造的一律拒绝），
而截图脚本一直是自己拼 `?mode=panel&tabId=N` 直接 `goto` —— **拿不到 token**。

于是它拍的是那句「这个页面不是由图片猎人打开的，已拒绝在此显示图库」，
而脚本照样打印「已截图 → gallery-panel.png」。**连续几轮都是这样**：
我每次「重出截图」都以为窄屏看过了，实际上一次都没看过。

这次做尺寸滑条时才发现 —— 因为滑条在面板模式有一组专门的 CSS（轨道收窄、输出值变小），
不看到真图根本不知道该不该收窄、收多窄。

判据与做法：

1. **工具类脚本也要有「产出正确性」检查，不能只检查「跑完了」。**
   截图脚本的等价物是：**先确认截到的是不是目标界面**。
   这里就是那句 `document.querySelector('#grid .card')` —— 拿不到网格说明是拒绝页。
2. **对「只失败一半」的路径尤其要检查。** 直接 `goto` 一个带权限校验的 URL 会**静默降级**
   成一个能渲染、但内容是拒绝文案的页面 —— 它不报错、不漏 404，看起来完全正常。
   凡是「能不能渲染」取决于隐藏凭证（token / cookie / header）的地方，
   都要显式验证「渲染出来的是不是我要的那个」。
3. **UI 改动的验收必须真的看图。** 这次如果不是去读那张 PNG，滑条在面板里
   会一直是一段 110px 的短轨道 + 右侧空档，而所有测试都会报绿（它们不测像素）。

### 13. 改一个**默认值**，会悄悄作废一整个测试舰队 —— 而且它们各自坏得不一样

做「图库尺寸滑条」（v1.11.0）时，用户点名默认值 **256px**。实现、单测、新浏览器用例
全绿之后，我把真浏览器用例全跑了一遍 —— **6 个套件变红，而且失败方式各不相同**：

| 套件 | 夹具 | 短边 | 失败表现 |
|---|---|---|---|
| `browser-panel-trust` | 200×140 | 140 | 面板里 0 张卡片（断言「面板渲染出图库」失败） |
| `browser-lightbox-local` | 200×150 | 150 | 等 `.card .zoom` 一直超时 |
| `browser-probe-advance` | 320×200 | 200 | 「点一次覆盖 130 张」变成 0 张 |
| `browser-restore-one` | 600×400 + `thumbPath` | **200**（缩略图减半） | 「没还原的卡片显示 300×200」失败 |
| `browser-slow-restore` | 600×400 + `thumbPath` | **200** | 「没有显示本页没有发现图片」失败 |
| `browser-scan-upgrade` | 600×400 + `thumbPath` | **200** | 「先出图」的证据全没了 |

**它们坏得不一样，是这件事最危险的地方。** 如果六个套件都报同一句
「网格是空的」，我会立刻想到是默认值。但它们分别表现为**超时**（元素等不到）、
**计数为 0**（探测发不出去）、**文案不符**（尺寸数字对不上）、
**时序断言失效**（「隔了 3000ms」变成 0ms）—— 看起来像六个不相关的 bug。

判据与做法：

1. **改默认值时，先把「所有依赖这个量的夹具」列出来再动手。**
   这次我该在改 `SIZE_MIN_DEFAULT` 之前就 grep 一遍所有 `imgW/imgH`。
   凡是被测行为依赖某个数值的产品默认值，那个值就是**全局测试约束**。
2. **短边不是宽度 —— 减半更要命。** `600×400` 看着很大，加 `thumbPath: true`
   之后页面上是 `300×200`，短边只有 200。**夹具要按「页面上实际呈现的像素」算，
   不是按站点配置里的数字算。**
3. **修夹具，别改产品。** 这六个用例测的都是别的东西（探测分批、还原重试、先出图后升级……），
   尺寸只是背景条件。所以正确做法是把夹具抬过门槛（`600×400+thumb → 800×600+thumb`），
   并在每处写清「为什么是这个尺寸」—— 否则下一个人会「顺手调小」再踩一次。
4. **硬编码的期望值要跟着夹具一起改。** `browser-restore-one` 里
   `dim === '300×200'` / `'600×400'` 是写死的，夹具一抬就全部对不上。
   **夹具的尺寸最好只写一处、期望值从它推导**；做不到时，至少把两者放在相邻行。
5. **全绿之前不要打包。** 这次如果不是把 21 个浏览器套件全跑一遍，
   6 个套件会带着假绿进 dist —— 而它们在 CI（还没有）里本来就会红。

> 正面对照：`browser-size-slider.js` 是**故意**用小尺寸造出来的
> （`128×128 / 300×80 / 400×300 / 900×600` 循环），它断言的正是过滤本身，
> 所以不受影响 —— 判断标准是「这个套件测的是不是尺寸」，
> 是 → 用小尺寸；不是 → 必须过门槛。

> **续记（v1.12.0）—— 同一个形状又出现了一次，只是这次的「一个改动」是个共用函数。**
>
> 做多标签页合并嗅探时重写了 `loadTabList()`（它同时负责填**单选下拉**和**多选勾选列表**）。
> 新版在末尾加了一句「保持 `tabId` 与勾选同步」：
>
> ```js
> if (targetIds.length) tabId = targetIds[0];    // ← 两种模式都执行
> ```
>
> 在**合并模式**下这是对的（勾选才是真相源）。但在**单选模式**下它会把
> `switchTarget()` 刚设好的新 `tabId` 覆盖回旧的 —— 而 `switchTarget()` 正是
> 「图库开着时再点一次扩展图标 / 在别的页面点『在图库中打开』」走的那条路。
> 于是那次切换**当场被撤销**：下拉和顶栏都换了，网格里还是上一页的图。
>
> 又是**三个套件同时红、症状各不相同**，而且这次更阴 —— 它们都不是在测「切换目标」：
>
> | 套件 | 失败表现 | 看起来像 |
> |---|---|---|
> | `browser-scan-limit` | 对照站「共 N 张」还是 2000，截断提示没清 | 截断提示的清除逻辑坏了 |
> | `browser-restore-one` | 对照站拿到 16 张而不是 6 张 | 夹具或嗅探范围坏了 |
> | `browser-probe-advance` | 体积探测整个失败（0/130） | `probeFail` 或跨域读取坏了 |
>
> 三条报错**没有一条**指向 `loadTabList`。判据还是第十三个坑那一句：
> **「多个不相关的套件同时红，先怀疑自己刚改的那个共用件」** ——
> 这次是「刚重写的那个被两种模式共用的函数」。
>
> 另外，**这次是靠三个套件顺带踩出来的，属于运气好**。所以补了一条专门的断言
> （`browser-merge-tabs.js` 第 10 节：切目标之后图必须真的换过去，合并模式与单选模式各验一遍），
> 并在那一节里写明了它的来历。注入回旧写法后它红 2 项，且报的正是
> 「切到 A 站，图还是 B 站的」——下次一坏就直说，不用再靠推理。

### 第十四个坑：**改了「视图状态」，却只改内存不落盘**

**症状**：截图脚本里，页内面板那张图**忽然**变成一张空白（不是拒绝页，是渲染出来但一张卡都没有）。
单独跑「打开面板」的用例却完全正常。看起来像面板的 token 路径坏了。

**根因**：不是面板坏了，是**空态那个「显示全部」出口按钮**（v1.11.0）只做了

```js
filters.sizeMin = 0;      // 只改内存
syncSizeSlider();
applyFilters();           // 当场确实看到全部图了
```

**没有 `saveViewState()`**。而滑条值 `sizeMin` 是**视图状态**，存在
`chrome.storage.local` 的 `ih_gallery_view` 里 —— 页内面板是一份**全新加载**，
启动时必然重读这个键。于是流程变成：

1. 截图脚本先把滑条拖到 601 → `change` 处理器**落盘**了 `608`
2. 点出口 → 内存清零，**盘上还是 608**
3. 面板打开 → 读盘 → 捡回 608 → 60 张夹具短边都 < 608 → **一张不剩**

**当场看着什么都对**（图都回来了），错只在下一次加载时暴露。

**判据与做法**：

1. **凡是「视图状态」的写点，必须和它的读点成对检查。**
   滑条 `change` 里有 `saveViewState()`，出口按钮里也必须有一句 ——
   它们改的是**同一个键**，漏一句就是「这个出口是假的」。
2. **回归测试要断言「重开之后」，不能只断言「当场」。**
   第九节专门为此写了：点出口 → **关掉图库重开** → 仍是全部。
   注入「删掉那句 `saveViewState()`」后这两条立刻变红
   （重开后滑条 = 704、可见 0 张 —— 正是 bug 的原样症状）。
3. **截图脚本的硬检查别只看「有没有卡片」。**
   面板本来就**沿用视图状态**，夹具短边不够时「一张卡都没有」是**正常渲染的空态**，
   不是拒绝页。判据要按「渲染出的是哪种界面」分：
   有拒绝文案 → 真挂了；有 `#grid` 但 0 张 → 大概率是尺寸过滤（查视图状态）；
   有卡片 → 正常。否则会把「正常空态」误报成「拒绝页」，
   然后你去修一个根本没坏的地方。
4. **顺手把截图段的出口复位也做成断言**：点完出口立刻查 `#grid .card` 数量，
   0 张就当场打印警告 —— 免得这个「假出口」把后面每一张截图都悄悄带歪。

### 第十五个坑：**静态守卫用正则解析源码 —— 夹具写成变量就静默漏掉**

做「多标签页合并嗅探」（v1.12.0）时，`browser-merge-tabs.js` 需要起**两个**本地站。
第一版很自然地把夹具抽成常量：

```js
// 反面教材 —— 守卫看不见
const A_OPTS = { cols: 3, rows: 2, imgW: 600, imgH: 400, title: '合并测试 A', pages: [...] };
const B_OPTS = { cols: 2, rows: 2, imgW: 800, imgH: 600, host: 'localhost', title: '合并测试 B' };
const siteA = await startServer(A_OPTS);
const siteB = await startServer(B_OPTS);
```

`validate.js` 第 12 节有一组**跨套件夹具守卫**：它静态扫描所有浏览器用例里
`startServer({...imgW, imgH...})` 的**字面量**，逐个按「短边 > 尺寸滑条默认阈值」校验
（见第十三个坑）。它的正则是 `startServer\(\{([\s\S]*?)\}\)` —— 只认**字面量**。

于是这次的表现是：**新增的两个站一个都没被扫到**，夹具计数从 22 掉到 21，
而**所有测试全绿**。守卫没报错、没警告，它只是「没看见」。
如果哪天有人把 `imgW` 调小，这两个站不会有任何东西拦他 —— 直到真浏览器里
图库开箱即空（正是第十三个坑的原样症状），而且**找不到是谁弄的**。

**判据与做法**：

1. **凡是「扫源码」的守卫，都要知道自己扫不到什么。**
   正则解析不是 AST，它看不见变量、展开、模板字符串、`Object.assign`。
   写这类守卫时必须在注释里写明**它只认哪种写法** —— 否则下一个人会以为它无所不包。
2. **主动迁就守卫的写法，并把理由写在夹具旁边。**
   这次把两个 `startServer` 改回字面量，并在文件里留了一行注释
   「写成字面量是为了让 `validate.js` 的夹具守卫能看见」——
   否则将来有人「顺手重构」成常量，又会静默失效一次。
3. **守卫要有「扫到了几个」的自证。** 光断言「扫到的都合格」是不够的：
   一个都扫不到时它恒真。至少把命中数打进日志（现在是 24 处），
   数量掉下来时人一眼能看见。
4. **同一类病在别处也犯过**：第 3 个坑里的「注入锚点必须唯一」
   是同一个根因的另一面 —— 都是**「工具以为它覆盖了，其实没有」**，
   而且都不出声。区别只是这次漏的是夹具，那次漏的是补丁。

### 第十六个坑：**守卫扫到了它自己的注释**

做「可访问性静态守卫」（v1.13.0，`validate.js` 第 15 节）时，我给新加的那段
写了一段说明性注释，里面随手举了个例子，大意是：

```js
/* …它扫的是形如 getURL('content/xxx.css') 的调用… */
```

结果跑出来一条：

```
✗ getURL → … 不存在
```

`validate.js` 第 4 节有一条守卫，用正则 `/(?:getURL|extUrl)\(\s*'([^']+)'/g`
**从仓库根递归扫所有 `.js`**，逐个校验路径真实存在。而我写在注释里的那个例子，
**正好被它自己的正则扫中了** —— 注释里没有真实的文件，于是报了一条「路径不存在」。

排查过程很典型：第 4 节的输出是「`getURL → …` 不存在」，路径叫 `…`，
看不出是哪个文件。全仓库 grep `getURL(` 才定位到源头是**自己刚写的那段注释**。

**判据与做法**：

1. **凡是扫源码的守卫，都要先把注释剥掉再匹配。**
   第 15 节因此全部断言都打在**去注释后的源码**上：

   ```js
   const jsCode = popupJsSrc
     .replace(/\/\*[\s\S]*?\*\//g, '')   // 整块注释
     .replace(/^\s*\/\/.*$/gm, '');        // 整行注释（只抹整行的，
                                            // 免得把字符串里的 https:// 也切掉）
   ```

   这不是洁癖：不剥注释的话，一句「这里本来该写 `onGridKeydown`」的**注释**
   就能让守卫全部通过，而代码里根本没有这个函数 —— 守卫被自己的文档骗了。
2. **剥注释本身也要小心。** 一开始想用 `/\/\/.*$/gm` 抹掉所有 `//`，
   但那会把 `https://…` 里的 `//` 也切掉。只抹**整行**的 `//` 才是安全的。
3. **同一种病的第一版**（第 4 节）还留着：它扫的是仓库全部 `.js`，
   装了 devDependencies 之后会扎进几万个第三方文件。这次顺手加了
   `SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github', 'coverage'])`。

### 第十七个坑：**断言把「关掉」的判据写错了 —— 元素没被摘掉，只是摘了类**

`browser-a11y.js`（v1.13.0）第 8 节要验「按 `P` 能打开灯箱、`Esc` 能关掉」。
第一版是这样写的：

```js
const lbOpen = await gallery.evaluate(() => !!document.querySelector('.ih-lb'));
await gallery.keyboard.press('Escape');
const lbClosed = await gallery.evaluate(() => !document.querySelector('.ih-lb'));
```

跑出来：**「按 P 打开了灯箱」红，「Esc 关闭灯箱」绿**。两个都错得不一样：

- **红的那条**是因为灯箱**不在 light DOM 里**。它建在一个
  `[data-ih-host]` 宿主元素的 **open shadow root** 内
  （见 `U.createShadowHost`），`document.querySelector('.ih-lb')` 永远是 `null`。
- **绿的那条是假绿**：`!document.querySelector('.ih-lb')` 恒为 `true`
  —— 它根本没在测「关掉了没有」，它测的是「这个选择器一直找不到东西」。

修完第一个问题（改从 `shadowRoot` 里查）之后，**绿的变成了红的**：
`Esc` 之后 `.ih-lb` **还在**。因为关闭（`Esc` / 点 X）只是摘掉 `.ih-show` 类，
元素本身一直留在 DOM 里（`ensureUI()` 建一次就复用）。

正确的判据在 `browser-lightbox-local.js` 里早就有了：`shown: lb.classList.contains('ih-show')`。
照着抄过来之后 50/0。

**判据与做法**：

1. **「关掉了没有」不能靠「元素在不在」。** 弹层类 UI 十有八九是复用同一个节点、
   只切可见性类（`.ih-show` / `hidden` / `display:none`）。判据要跟着实现走。
2. **`!querySelector(...)` 这种断言要格外小心**：它对「选择器写错了」和
   「元素真的不在」返回同一个值 —— **恒真的假绿**就藏在这里。
   写这类断言时问自己一句：「如果我的选择器一直是错的，这条会不会变红？」
   不会变红，就说明它没在测东西。
3. **同一个项目里已经有正确判据时，去抄它。** 这次的正解就在隔壁文件里，
   第一版却是自己现编的 —— 现编的判据没人验过，隔壁那条是被 48 项断言压过的。

### 第十八个坑：**手写清单漏掉一个套件时不会报错，只是「不被跑」**

做 CI（v1.13.0）时要给浏览器套件写总入口。第一版很自然：

```js
const SUITES = [
  'browser-batch.js', 'browser-blocked.js', 'browser-deep-scan.js', /* …22 行… */
];
```

问题在于：**漏掉一行不会报错。** 那个套件只是「不被跑」——
而「没跑」和「跑过且通过」在汇总里长得**一模一样**（都是不出现）。

改成自动发现：

```js
const SUITES = fs.readdirSync(DIR).filter((f) => /^browser-.*\.js$/.test(f)).sort();
```

再加 `run-all.js` 早就有的两道防线：子进程输出走**临时文件**（受管沙箱里管道捕获会 EBUSY）、
每个套件必须打印 `通过 N 项，失败 M 项` 否则判「中途退出」。

**这两道防线刚写完全派上了用场。** 第一次跑总入口时，汇总报：

```
22 个套件，通过 499 项
1 个测试套件失败
  ✗ browser-lightbox-local  → 套件中途退出，未跑完（没有打印完成标记…）
```

`browser-lightbox-local` 单独跑是 **48/0** —— 是抖动（22 个浏览器连续起，
中途超时退出），不是回归。注意 **499 + 48 = 547**，正好是上一轮全绿的总数：
如果没有「完成标记」这道校验，这 48 项会**静默消失**，而汇总仍然报「全绿」。

**判据与做法**：

1. **凡是「清单」，都问一句「漏了一项会怎样」。** 会报错 → 好；
   不会报错、只是少做一件事 → 那它迟早会烂。能自动发现就自动发现。
2. **「没跑」和「跑过且通过」必须可区分。** 做法是要求每个套件打印一个
   **完成标记**，没打就判失败 —— 而不是只看退出码（Node 在事件循环空掉时
   会静默以 0 退出，第 1 个坑就是这么来的）。
3. **抖动的正确处置是「如实报红」，不是「重试到绿」。** 这次汇总报红是对的：
   它让我去确认了那 48 项确实是抖动而不是回归。如果把 `1 个套件失败`
   也当成噪声忽略，那真正的中途退出就永远看不见了。

### 第十九个坑：**把「先出图」的中间结果当成最终结果去断言**

修「首次点开图标看不到图」（v1.13.1）时给 `test-scan-timeout.js` 写了一条：

```js
const r4 = await partialFirst.send(scanMsg(), RESTORE + 3000);
check(r4.images.length === 2, '拿到的是最终结果（2 张），不是那份 1 张的中间结果');
```

红了，实际是 1 张。第一反应是「后台没等到最终结果」—— 但**代码是对的**。

`scanTab` 的响应**故意**先兑现中间结果（「先出图」的全部意义），最终结果走
`SCAN_UPGRADE` **广播**。所以 `sendResponse` 拿到的那一版本来就不是最终结果；
要去广播里找它。断言写错了，却长得像产品代码的 bug —— 这种「测试的错」最容易
被当成「代码的错」去改代码，改完还全绿（因为改错了方向）。

**判据与做法**：

1. **先问「这条消息通道本来该送哪一版结果」。** 「先出图、后升级」把结果拆成了
   两条路（`sendResponse` 送中间结果、广播送最终结果），断言之前先确认自己站在哪条上。
2. **为了能断言广播，桩得把它记下来。** `lib/bgstub.js` 的 `runtime.sendMessage`
   会把广播推进 `broadcasts` —— 只看 `sendResponse`，会得出「最终结果根本没回来」的假结论。
3. 顺带又栽了一次**第十六个坑**：这轮新加的静态断言里有一条是
   「`main.js` 里不该再有 `error: 'busy'`」，而我在那段代码上方写的**注释**里
   正好引用着 `error: 'busy'` 来解释它以前的行为 —— 守卫扫到了自己的说明文字。
   剥掉注释再匹配即可。**这个坑会反复出现**，因为「在代码旁边解释代码」是好习惯；
   凡是用正则读源码的断言，第一句都该是先剥注释。

### 第二十个坑：**断言是绿的，不代表它测的是你以为的那件事**

同一次修复里，`test-scanner.js` 第 19 节早就有一句：

```js
check(partial.every((p) => p.restored !== true), '中间结果里没有「已还原」标记');
```

把 `finishList()` 里中间结果的回报点从「补尺寸之后」挪到「**补尺寸之前**」——
**时序改动不小**，而这句话在改动前后**都是绿的**。为什么？因为它测的是
「还原还没跑」，而中间结果无论排在补尺寸前还是后，都确实在还原之前。
它绿得没错，只是它**根本没覆盖到被改动的那一段**。

于是补了 3 条真正压在这段时序上的断言：往文档里放几张不给 `data-nw` / `data-nh`
的图（`naturalWidth` 为 0，于是进「尺寸未知」名单，但地址在探测表里）——
中间结果里它们必须是 `0×0`，最终结果里必须已补成 `640×480`。
把回报点挪回补尺寸之后，这条立刻变红（`640x480,640x480,640x480,640x480`）。

**判据与做法**：

1. **改完时序，回头问一句「现有的断言里，哪一条真的会因为我这次改动而变红」。**
   一条都答不上来，就说明这段时序没被覆盖 —— 无论套件当前多绿。
   最省事的验证就是**故意改错**（注入），看它红不红；不红就是没覆盖。
2. **断言文案里写着的「时机」必须和代码里的实际时机对得上。**
   「还原开始前」和「补尺寸与还原之前」是两句不同的话；代码挪了位置而文案没跟着挪，
   读注释的人（包括几周后的自己）会按错的前提去理解整个流程。
3. 这和第十九个坑是**一对**：第十九个坑是「断言站错了通道」（红得莫名其妙），
   这个是「断言站对了通道、却没站在被改的那一段上」（绿得毫无意义）。
   一红一绿，都指向同一件事 —— **先想清楚这条断言在测什么，再写它**。

### 第二十一个坑：**本地全绿、CI 全红 —— 因为两边跑测试的 Node 不是同一个版本**

CI（`.github/workflows/ci.yml`）首次上线，Node 套件 job 直接红。本地同一份代码、
同一份 `package-lock.json`、同一批依赖版本，**15 个套件全绿**。

差别只有一个：**CI 写的是 `node-version: '20'`，本地是 Node 22.22.2。**

Node 20 下 `require('jsdom')` 会直接抛：

```
TypeError: webidl.util.markAsUncloneable is not a function
    at new CacheStorage (.../undici/lib/web/cache/cachestorage.js:20:17)
```

因为 `jsdom@30` 的 engines 是 `^22.22.2 || ^24.15.0 || >=26.0.0` —— Node 20 不在范围内。
于是**恰好那 5 个 `require('jsdom')` 的套件**（`test-scanner` / `test-hover` /
`test-blocked` / `test-lightbox-gallery` / `test-lightbox-filter`）全部「中途退出，未跑完」，
其余 10 个（纯 vm / 纯字符串处理）照常通过。

这个失败形态**极具误导性**：5 个套件、5 套不同的断言，一起变红，看着像 5 个互不相关的
bug —— 根因却只是「Node 太旧」。

**判据与做法**：

1. **「本地全绿」这句话必须带上「在哪个 Node 上」。** 版本不够时，测试不会报
   「你的 Node 不对」，它只会**以别的方式**坏掉。`package.json` 的 `engines`
   现在照抄了 jsdom 的范围，`npm ci` 会给警告；但 warning 不是 error，别指望它拦得住。
2. **红掉的集合「恰好等于某个特征集合」时，先去找那个共同点。** 这里 5 个红掉的
   套件恰好是全仓库仅有的 5 个 `require('jsdom')` 的文件 —— 这个巧合不是巧合。
   换成「红的都是用了某个 API 的套件」，就该去查那个 API。
3. **拿不到 CI 日志时，用「装一个同版本」来缩小范围。** Actions 的日志 API 要 admin
   权限（`403 Must have admin rights to Repository.`），job 页面又是懒加载、抓不到日志行。
   这时从 `nodejs.org/dist/v20.x/` 下一个 zip 解压即用，跑一次就把范围从
   「CI 与本地的全部差异」缩到「Node 版本」这一条 —— 复现出来的那一刻，根因就不用猜了。

### 第二十二个坑：**本地单独跑全绿、批量跑却红 —— 间歇失败的三个来源**

CI 的浏览器 job 红了。在本地跑整套（25 个）也红 2 个 —— 但这 2 个**单独跑都是绿的**：

```
✗ browser-blocked     → 套件报告失败（退出码 1）
✗ browser-merge-tabs  → 套件中途退出，未跑完
```

「单独绿、批量红」意味着失败**不在断言里，而在环境里**。最后找到两个根因，
外加一个**修的过程中自己造出来的**第三个。

**来源一：`localhost` 的双栈解析（browser-merge-tabs）**

```
page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:57794/
```

本地站是 `server.listen(0, opts.host)`，而 `host: 'localhost'` 时：

```
默认解析顺序 = verbatim
localhost 解析 = [{::1}, {127.0.0.1}]
listen(0, 'localhost') 实际绑到 = {address: "::1", family: "IPv6"}
```

Node 只绑**一个**地址（实测 `::1`），而浏览器解析 `localhost` 的顺序未必一致 ——
先走 IPv4 就直接被拒。修法：`host: 'localhost'` 时绑所有接口（`::`，IPv6 双栈）。

**来源二：SW 启动期写设置抢跑（browser-blocked）**

```
=== 1. 被排除的站点 ===
  后台看到的排除列表 = []          ← 应该是 ["127.0.0.1"]
  ✗ 悬停不出现任何页内 UI  → 1 个宿主
  ✗ Alt+点击不会保存  → 1 条下载记录
```

设置根本没写进去，于是后面两条断言红得**像是产品坏了**（悬停 UI 冒出来了、
Alt+点击真保存了），其实只是前提没成立。而这个套件**本来就有**确认机制
（写完轮询 6 秒）—— 问题是**确认失败时静默返回**，调用方又没接返回值。
修法两条：写之前先 `await IH.Store.loadSettings()`（等 SW 真正就绪，别和
`bootstrap()` 的启动期加载抢跑）；确认失败就**抛错**，不许带着错误状态往下跑。

**来源三（自己造的）：修一个地方，把影响面放大了**

来源一的第一版修法是「**所有**站点都绑 `::`」。改完 `merge-tabs` 确实绿了，
但 `browser-probe-advance` 变红了：

```
✗ 逐张比对了全部 130 张  → 120 张
✗ 第 121 张之后的卡片也拿到了体积  → 120 / 130
```

它单独跑**也是绿的**。差别在于它要给 130 张图发探测请求 —— `127.0.0.1` 站点
被绑到 `::` 之后，每次连接都走 IPv4-mapped IPv6，开销累积起来把第二批（10 张）
挤出了时间预算。改成**只在 `host === 'localhost'` 时才双栈**，其余保持纯 IPv4，
两个套件就都绿了。

**判据与做法**：

1. **「单独跑绿、批量跑红」= 环境问题，不是断言问题。** 先去查这套件**和别的套件
   有什么不同**（起几个服务器？绑什么地址？发多少请求？有没有等 SW 就绪？），
   而不是去读断言。
2. **测试里凡是「等某个外部条件成立」的地方，超时就该炸。** 静默返回等于把失败
   推迟到几条断言之后，那时的报错已经指不回真正的原因了。
3. **改一个 bug 之前，先问「这个改动的影响面有多大」。** 为了让一个套件绿而改掉
   所有套件共用的底层（这里是把全部站点的监听地址都换掉），很容易把别处弄红 ——
   而且红的那个套件同样会「单独跑绿」，又是一轮排查。**把改动收窄到只覆盖出问题的
   那条路径**，通常更省事。

