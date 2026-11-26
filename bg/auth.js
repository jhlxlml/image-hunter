/* ==========================================================================
 * ImageHunter — bg/auth.js
 * 页内面板 token 签发/核验与消息来源（sender）安全判据
 * 由 background.js 通过 importScripts 加载，共享同一个 SW 全局作用域。
 * ========================================================================== */

/* ====================================================================== *
 * 页内面板的来源校验 token（AUDIT P3-7）
 *
 * 面板 = 「网页里的 iframe 加载扩展页 popup.html?mode=panel」。
 * popup/* 必须在 web_accessible_resources 里（否则 iframe 加载不了），
 * 于是**任何网站都能构造同款 iframe**，把图库叠在自己页面上做套壳点击，
 * 或者靠「能不能加载这个资源」探测用户装没装本扩展。
 *
 * 校验办法：内容脚本向后台领一个只属于本标签页的随机 token，
 * **用 postMessage 交给面板**（不是写进 iframe 的 URL —— 那个 src 在页面的
 * DOM 里，网页脚本 `host.shadowRoot.querySelector('iframe').src` 就读到了，
 * 拿到 token 之后它就能自己拼一个合法 iframe 出来，校验等于白做）。
 * 面板拿 token 回后台核验，后台再用 **sender.tab.id** 确认「这个面板确实
 * 跑在那个标签页里」—— 请求方自己填的 tabId 一律不认。
 *
 * 网页自己没法给后台发消息（不是扩展上下文），拿不到 token，也就伪造不出合法面板。
 *
 * token 存在 storage.session 而不是内存里：MV3 的 SW 会被回收，
 * 内存 Map 一丢，已经打开的面板刷新一次就废了。
 * ====================================================================== */

const PANEL_TOKEN_KEY = 'ih_panel_tokens';

async function panelTokens() {
  try {
    const got = await chrome.storage.session.get(PANEL_TOKEN_KEY);
    return (got && got[PANEL_TOKEN_KEY]) || {};
  } catch (e) { return {}; }
}

/** 给标签页发（或复用）一个 token。同一个标签页重复打开面板会拿到同一个值。 */
async function issuePanelToken(tabId) {
  const store = await panelTokens();
  if (store[tabId]) return store[tabId];

  const token = U.uid() + U.uid() + U.uid();
  store[tabId] = token;
  try { await chrome.storage.session.set({ [PANEL_TOKEN_KEY]: store }); } catch (e) { /* 忽略 */ }
  return token;
}

async function verifyPanelToken(tabId, token) {
  if (tabId == null || !token) return false;
  const store = await panelTokens();
  return !!store[tabId] && store[tabId] === token;
}

/* ---------------------------------------------------------------------- *
 * 「这条消息是谁发的」—— 授权的唯一可信来源
 *
 * 不要用 `e.origin` / `msg.payload.tabId` / `sender.url` 里的页面地址来判身份：
 * 前两个是**请求方自己说的**，第三个在网页内容脚本里就是网页地址（谁都能伪造页面）。
 *
 * 能信的只有浏览器填的这几项：
 *   sender.id        —— 必须等于本扩展 ID（别的扩展发不进来，但白拿一道）
 *   sender.url       —— **扩展页**是 chrome-extension://<id>/...；内容脚本是网页地址。
 *                       这是区分「我的扩展页」和「我的内容脚本」的关键。
 *   sender.tab.id    —— 消息来自哪个标签页。内容脚本和嵌在网页里的扩展页都拿得到，
 *                       而网页脚本自己**发不出** runtime 消息，所以这个值不可伪造。
 *   sender.frameId   —— 0 表示顶层（扩展自己开的标签页），>0 表示嵌在别人页面里。
 * ---------------------------------------------------------------------- */

/** 扩展页的根地址（`chrome-extension://<id>/`） */
function extBase() {
  try { return chrome.runtime.getURL(''); } catch (e) { return ''; }
}

/** 这条消息是不是**本扩展的页面**（popup.html / options.html）发出的 */
function isExtensionPageSender(sender) {
  if (!sender) return false;
  try {
    if (sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
  } catch (e) { /* 拿不到 runtime.id 就跳过这一道 */ }
  const base = extBase();
  if (!base) return false;
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (url) return url.indexOf(base) === 0;
  // 个别 Chrome 版本对扩展页不给 sender.url，退一步看 origin
  return typeof sender.origin === 'string' && sender.origin === base.replace(/\/$/, '');
}

/** 消息来源标签页 id（拿不到就是 null）。**不读 msg 里的 tabId。** */
function senderTabId(sender) {
  return sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
}

/** 是不是顶层 frame（扩展自己开的标签页）。拿不到 frameId 时返回 null（未知）。 */
function senderFrameId(sender) {
  return sender && typeof sender.frameId === 'number' ? sender.frameId : null;
}

/** 消息来源标签页的**主框架**地址（不是发消息那一帧的地址）。
 *
 * 这是 `frameId` 拿不到时的兜底判据。区别很关键：
 *   · 扩展自己开的标签页（顶层）→ tab.url 是 chrome-extension://<id>/popup/popup.html
 *   · 被网页 iframe 进去的扩展页 → tab.url 是**那个网页**的地址
 * 所以「tab.url 是不是扩展地址」等价于「这一帧是不是这个标签页的顶层」。
 * 这个值同样由浏览器填，网页改不了。 */
function senderTabUrl(sender) {
  return sender && sender.tab && typeof sender.tab.url === 'string' ? sender.tab.url : '';
}

/**
 * 这条消息是不是**顶层 frame**。
 * @returns {boolean|null} null = 两种判据都拿不到（调用方按「不可信」处理）
 */
function isTopLevelSender(sender) {
  const fid = senderFrameId(sender);
  if (fid != null) return fid === 0;
  const tabUrl = senderTabUrl(sender);
  const base = extBase();
  if (!tabUrl || !base) return null;
  return tabUrl.indexOf(base) === 0;
}

/**
 * 这条消息是不是**嵌在别人页面里**的 frame。
 * 面板一定是嵌进去的，所以它是 PANEL_VERIFY 的必要条件之一。
 * @returns {boolean|null} null = 判不出来
 */
function isEmbeddedSender(sender) {
  const fid = senderFrameId(sender);
  if (fid != null) return fid > 0;
  const top = isTopLevelSender(sender);
  return top == null ? null : !top;
}
