"""临时注入脚本：用来验证「新加的断言真的能抓到旧漏洞」。

用法： python tests/_inject.py <mode>
每个 mode 都有对应的逆操作（*_off），跑完必须还原。

为什么需要这个文件：安全断言最容易写成「永远绿」——比如断言一个
根本不存在的元素、或者断言一个已经不可能发生的条件。只有把实现改坏、
看到断言变红，才能证明它真的在盯着那段代码。
"""
import io
import sys

POPUP = 'popup/popup.js'
PANEL = 'content/panel.js'
UTILS = 'shared/utils.js'


def read(p):
    return io.open(p, encoding='utf-8', newline='').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ---------------------------------------------------------------- popup.js
POPUP_NEW = """  function onParentMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__ih) return;
    if (MODE !== 'panel') return;
    if (e.source !== window.parent) return;

    if (d.type === 'init') {
      // 已认证之后不再接受任何新 token —— 否则网页脚本投一个自己的 init，
      // 就能把「后续指令必须带对 token」这条判断架空了。
      pushPanelToken(d.token);
      return;
    }

    // 后续指令：必须带着同一个 token，否则就是网页脚本在瞎喊
    if (!panelToken || d.token !== panelToken) return;
    if (d.type === 'refresh') doScan();
  }"""

# 原始实现（v1.19.2 及以前）
POPUP_OLD = """  function onParentMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__ih) return;
    if (d.type === 'init' && d.tabId != null) tabId = d.tabId;
    if (d.type === 'refresh') doScan();
  }"""

# 外科式：保留 token 交接（正常流程不受影响），只留那两个洞
POPUP_SURGICAL = """  function onParentMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__ih) return;
    if (MODE !== 'panel') return;
    if (e.source !== window.parent) return;
    if (d.type === 'init') {
      if (d.tabId != null) tabId = d.tabId;
      pushPanelToken(d.token);
      return;
    }
    if (d.type === 'refresh') doScan();
  }"""

PAGE_NEW = """    // mode === 'page'
    let embedded = false;
    try { embedded = window.top !== window.self; } catch (e) { embedded = true; }
    if (embedded) return false;
    try {
      const res = await U.sendToBg({ type: MSG.GALLERY_AUTH });
      return !!(res && res.ok && res.valid);
    } catch (e) {
      return false;
    }"""

PAGE_BYPASS = """    // mode === 'page' —— 注入：退回「网页碰不到」那个错误假设
    return true;"""

# ---------------------------------------------------------------- panel.js
PANEL_NEW = """      /* src 里**只有 mode**：token 走 postMessage 交接，tabId 由面板自己
         向后台问（后台用 sender.tab.id 回答，比 URL 参数可信）。
         这个 src 会被网页脚本读到，所以它上面不许有任何凭据。 */
      frame.setAttribute('src', U.extUrl('popup/popup.html') + '?mode=panel');
      // token 提前取好，`ready` 一到就能立刻交接
      getPanelToken();"""

PANEL_TOKEN_IN_URL = """      /* 注入：把 token 塞回 URL（v1.19.2 的写法） */
      getPanelToken().then((tok) => {
        frame.setAttribute('src', U.extUrl('popup/popup.html')
          + '?mode=panel' + (tok ? '&token=' + encodeURIComponent(tok) : ''));
      });"""


def apply(path, old, new):
    src = read(path)
    assert old in src, '找不到要替换的块：' + path
    write(path, src.replace(old, new))


# ---------------------------------------------------------------- utils.js
UTILS_LIMITED = """    const reader = res.body.getReader();
    const deadline = Date.now() + timeoutMs;"""

BG = 'background.js'

BG_DISCARD = """async function discardBody(res) {
  if (!res || !res.body || typeof res.body.cancel !== 'function') return;
  try { await res.body.cancel(); } catch (e) { /* 已经读完 / 已关闭，忽略 */ }
}"""

BG_DISCARD_FB = """async function discardBody(res) {
  if (!res || !res.body) return;
  try {
    if (typeof res.body.cancel === 'function') { await res.body.cancel(); return; }
    /* 兜底：个别实现（老版本 / 测试桩）的 ReadableStream 上没有 cancel。
       锁一个 reader 再取消，效果一样 —— 关键是让浏览器停止继续收这个响应体。 */
    if (typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      await reader.cancel();
    }
  } catch (e) { /* 已经读完 / 已关闭，忽略 */ }
}"""

BG_DISCARD_FB_OFF = """async function discardBody(res) {
  if (!res || !res.body || typeof res.body.cancel !== 'function') return;   // 注入：没有兜底
  try { await res.body.cancel(); } catch (e) { /* 已经读完 / 已关闭，忽略 */ }
}"""

BG_DISCARD_OFF = """async function discardBody(res) {
  return;   // 注入：不取消响应体（旧行为）
}"""

BG_PERSIST = """        active: activeTasks.map((t) => Object.assign(slimTask(t), {
          downloadId: t.downloadId == null ? null : t.downloadId
        })),"""

BG_PERSIST_OFF = """        active: [],   // 注入：只存 pending（旧行为）"""

# 注入：frameId 缺失时不做 tab.url 兜底（v1.20.0 之前的写法）
BG_FRAME = """function isTopLevelSender(sender) {
  const fid = senderFrameId(sender);
  if (fid != null) return fid === 0;
  const tabUrl = senderTabUrl(sender);
  const base = extBase();
  if (!tabUrl || !base) return null;
  return tabUrl.indexOf(base) === 0;
}"""

BG_FRAME_OFF = """function isTopLevelSender(sender) {
  const fid = senderFrameId(sender);
  return fid == null ? null : fid === 0;   // 注入：没有兜底
}"""

# 注入：对账时「查不到下载记录」一律重排队（不看指纹表）—— v1.20.0 之前的写法
BG_FP = """        if (already) await settleRestoredAlreadyThere(task);
        else requeue.push(task);      // 真没下过 → 当作没开始过，重新排队"""

BG_FP_OFF = """        requeue.push(task);   // 注入：一律重排队（旧行为）"""

STORE = 'shared/store.js'

STORE_STRICT = """    try {
      await area().set({ [key]: value });
      lastWriteError = null;
    } catch (e) {"""

STORE_SWALLOW = """    try {
      await area().set({ [key]: value });
      lastWriteError = null;
    } catch (e) {
      // 注入：吞掉异常（旧行为）
      return;"""


# 注入：退回「先吃完再判大小、不设截止时间、不看 MIME」
UTILS_NAIVE = """    // 注入：退回裸 blob()（v1.19.2 的写法）
    {
      const blob0 = await res.blob();
      return { blob: blob0, bytes: blob0.size, mime: mime || blob0.type || '' };
    }
    const reader = res.body.getReader();
    const deadline = Date.now() + timeoutMs;"""


def main():
    mode = sys.argv[1]
    if mode == 'panel-old':
        apply(POPUP, POPUP_NEW, POPUP_OLD)
    elif mode == 'panel-surgical':
        apply(POPUP, POPUP_NEW, POPUP_SURGICAL)
    elif mode == 'panel-restore':
        src = read(POPUP)
        if POPUP_OLD in src:
            write(POPUP, src.replace(POPUP_OLD, POPUP_NEW))
        else:
            write(POPUP, src.replace(POPUP_SURGICAL, POPUP_NEW))
    elif mode == 'page-bypass':
        apply(POPUP, PAGE_NEW, PAGE_BYPASS)
    elif mode == 'page-restore':
        apply(POPUP, PAGE_BYPASS, PAGE_NEW)
    elif mode == 'token-url':
        apply(PANEL, PANEL_NEW, PANEL_TOKEN_IN_URL)
    elif mode == 'token-url-restore':
        apply(PANEL, PANEL_TOKEN_IN_URL, PANEL_NEW)
    elif mode == 'body-naive':
        apply(UTILS, UTILS_LIMITED, UTILS_NAIVE)
    elif mode == 'body-restore':
        apply(UTILS, UTILS_NAIVE, UTILS_LIMITED)
    elif mode == 'discard-off':
        apply(BG, BG_DISCARD, BG_DISCARD_OFF)
    elif mode == 'discard-on':
        apply(BG, BG_DISCARD_OFF, BG_DISCARD)
    elif mode == 'persist-off':
        apply(BG, BG_PERSIST, BG_PERSIST_OFF)
    elif mode == 'persist-on':
        apply(BG, BG_PERSIST_OFF, BG_PERSIST)
    elif mode == 'discard-fb-off':
        apply(BG, BG_DISCARD_FB, BG_DISCARD_FB_OFF)
    elif mode == 'discard-fb-on':
        apply(BG, BG_DISCARD_FB_OFF, BG_DISCARD_FB)
    elif mode == 'frame-fallback-off':
        apply(BG, BG_FRAME, BG_FRAME_OFF)
    elif mode == 'frame-fallback-on':
        apply(BG, BG_FRAME_OFF, BG_FRAME)
    elif mode == 'restore-fp-off':
        apply(BG, BG_FP, BG_FP_OFF)
    elif mode == 'restore-fp-on':
        apply(BG, BG_FP_OFF, BG_FP)
    elif mode == 'rawset-swallow':
        apply(STORE, STORE_STRICT, STORE_SWALLOW)
    elif mode == 'rawset-strict':
        apply(STORE, STORE_SWALLOW, STORE_STRICT)
    else:
        raise SystemExit('未知 mode: ' + mode)
    print('注入完成：' + mode)


main()
