/**
 * 回放管理器
 * 支持双模式：CDP（chrome.debugger）+ DOM 降级
 */

/** 改为 true 后：打开扩展 Service Worker 控制台可看到 AI 步骤的节点数与操作计划 */
const DEBUG_AI_NATURAL = false;

/** 与后端/库里的 action_type 对齐（去空格、小写），避免编辑保存时偶发空格导致不走智能分支 */
function isAiNaturalStep(step) {
  const t = String(step?.action_type ?? '')
    .trim()
    .toLowerCase();
  return t === 'ai_natural';
}

function normalizeLocale(locale) {
  const raw = String(locale || '').trim().toLowerCase();
  return raw.startsWith('en') ? 'en' : 'zh';
}

function trByLocale(locale, zh, en) {
  return normalizeLocale(locale) === 'en' ? (en || zh) : zh;
}

function localizePlaybackError(locale, message) {
  const msg = String(message || '');
  if (normalizeLocale(locale) !== 'en' || !msg) return msg;
  let out = msg;
  const replacements = [
    [/页面出现错误提示，已中止回放：/g, 'Page error detected, playback stopped: '],
    [/\[页面错误提示\]/g, '[Page Error Toast]'],
    [/摘录：/g, 'Snippet: '],
    [/未配置起始 URL：请在中台编辑该用例并填写「起始 URL」，保存后再从用例页或此处重试/g, 'Start URL is not configured: edit this case in platform, fill "Start URL", save, then retry'],
    [/起始页为其他扩展的页面，无法回放：/g, 'Start page belongs to another extension and cannot be played back: '],
    [/请将用例「起始 URL」改为 http\(s\) 地址，勿指向其他扩展的 chrome-extension:\/\/ 页面。/g, 'Set case "Start URL" to an http(s) address, not another extension chrome-extension:// page.'],
    [/起始页为浏览器内置协议，无法注入回放脚本：/g, 'Start page uses browser internal protocol and playback script cannot be injected: '],
    [/请改为 http\(s\) 页面。/g, 'Please switch to an http(s) page.'],
    [/无法向当前页注入回放脚本（受限 URL 或第三方扩展页面）：/g, 'Cannot inject playback script into current page (restricted URL or third-party extension page): '],
    [/找不到元素（等待超时；全页 loading 时计时会暂停）/g, 'Element not found (wait timed out; timer pauses while full-page loading is active)'],
    [/在下拉框中找不到选项 "([^"]+)"（等待超时；全页 loading 时计时会暂停）/g, 'Option "$1" not found in dropdown (wait timed out; timer pauses while full-page loading is active)'],
    [/下拉框中实际选项（前30条）/g, 'Actual options in dropdown (top 30)'],
    [/下拉框中未找到任何选项（可能仍在加载，或下拉框未成功打开）/g, 'No options found in dropdown (it may still be loading, or the dropdown did not open)'],
    [/断言失败：未配置断言文本（「输入值」不能为空或仅空白）/g, 'Assertion failed: expected text is not configured (input value cannot be empty or whitespace only)'],
    [/断言失败：找不到目标元素/g, 'Assertion failed: target element not found'],
    [/断言失败：元素内容与「输入值」不一致/g, 'Assertion failed: element content does not match input value'],
    [/断言失败：页面中未找到文本/g, 'Assertion failed: text not found on page'],
    [/JSON 断言需要填写 CSS 选择器或 XPath，以定位展示 JSON 的容器元素/g, 'JSON assertion requires a CSS selector or XPath to locate the JSON container'],
    [/JSON 断言步骤缺少步骤 id，请重新加载用例后重试/g, 'JSON assertion step is missing step id. Reload the case and retry'],
    [/JSON 断言：在超时内未找到目标元素或无法读取文本/g, 'JSON assertion: target element not found within timeout or text cannot be read'],
    [/JSON 断言失败：/g, 'JSON assertion failed: '],
    [/AI 自然语言步骤需要 CDP（debugger）模式，请确认扩展具备调试权限且页面允许附加调试器/g, 'AI natural-language step requires CDP (debugger). Ensure extension debug permission and target page allow debugger attach'],
    [/JSON 断言步骤需要 CDP（debugger）模式，请确认扩展具备调试权限且页面允许附加调试器/g, 'JSON assertion step requires CDP (debugger). Ensure extension debug permission and target page allow debugger attach'],
    [/输入失败（等待超时）/g, 'Input failed (wait timed out)'],
    [/按键失败：未找到目标元素/g, 'Key action failed: target element not found'],
    [/按键失败/g, 'Key action failed'],
    [/目标不可点击：视口中心点被其它元素遮挡（常见于非预期弹窗、遮罩或浮层；与 Playwright 的 hit-test 类似）。请先关闭遮挡物或调整用例。/g, 'Target is not clickable: viewport center is covered (often by unexpected popup/mask/overlay). Close the blocker or adjust the case'],
    [/目标不可悬停：视口中心点被其它元素遮挡（常见于非预期弹窗、遮罩或浮层）。请先关闭遮挡物或调整用例。/g, 'Target cannot be hovered: viewport center is covered (often by unexpected popup/mask/overlay). Close the blocker or adjust the case'],
    [/Tree 诊断: 当前页面未找到 ([^\\s]+) 树节点，可能页面状态或前置步骤不一致。/g, 'Tree diagnosis: no $1 tree nodes were found on the current page; page state or prerequisites may be inconsistent.'],
    [/Tree 诊断: 当前树中找不到标题为「([^」]+)」的节点，可能节点未展开、未加载或已被前序步骤改名\/删除。/g, 'Tree diagnosis: node titled "$1" was not found; it may be collapsed, not loaded, renamed, or deleted by a previous step.'],
    [/Tree 诊断: 找到 (\\d+) 个同名节点，但父路径与录制时不匹配，可能点击到了另一棵分支或树结构已变化。/g, 'Tree diagnosis: found $1 same-title nodes, but their parent path does not match the recorded path; the branch or tree structure may have changed.'],
    [/Tree 诊断: 找到同名节点且父路径接近，但层级与录制时不一致，可能目标节点层级发生变化。/g, 'Tree diagnosis: found same-title nodes with similar parent path, but the level differs from recording; the target node level may have changed.'],
    [/Tree 诊断: 已找到目标节点「([^」]+)」，但未找到可点击的展开\/收起按钮，可能图标需要先 hover、节点不可展开，或组件 DOM 已变化。/g, 'Tree diagnosis: found target node "$1", but no clickable expand/collapse control was found; it may require hover, be non-expandable, or the component DOM changed.'],
    [/Tree 诊断: 已找到目标节点「([^」]+)」，但未找到可点击的节点操作图标，可能图标需要先 hover、节点不可展开，或组件 DOM 已变化。/g, 'Tree diagnosis: found target node "$1", but no clickable node action icon was found; it may require hover or the component DOM changed.'],
    [/Tree 诊断: 已找到目标节点「([^」]+)」，但未找到可点击的节点内容区域，可能图标需要先 hover、节点不可展开，或组件 DOM 已变化。/g, 'Tree diagnosis: found target node "$1", but no clickable node content area was found; the component DOM may have changed.'],
    [/Tree 诊断: 已找到候选 Tree 节点，但目标元素仍未通过可见性\/可点击性检查，可能被遮挡、未渲染完成或页面状态变化。/g, 'Tree diagnosis: candidate tree node was found, but the target did not pass visibility/clickability checks; it may be covered, not fully rendered, or page state changed.'],
    [/录制父路径:/g, 'Recorded parent path:'],
    [/录制层级:/g, 'Recorded level:'],
    [/选项文本:/g, 'Option text:'],
    [/「智能自然语言」步骤需由扩展后台以 CDP 模式执行，当前为纯 DOM 降级路径/g, 'AI natural-language step must run via extension background in CDP mode; current path is DOM fallback'],
    [/「JSON 断言」步骤需由扩展后台以 CDP 执行并在后端比对，当前为纯 DOM 降级路径/g, 'JSON assertion step must run via extension background in CDP mode and be compared on backend; current path is DOM fallback'],
    [/未知或不支持的操作类型:/g, 'Unknown or unsupported action type:'],
    [/步骤执行失败（页面脚本无有效响应，请刷新目标页后重试）/g, 'Step execution failed (no valid response from page script; refresh target page and retry)'],
    [/无法设置输入框（未找到元素或非 INPUT\/TEXTAREA）/g, 'Cannot set input value (element not found or not INPUT/TEXTAREA)'],
    [/用户手动停止/g, 'Stopped by user'],
    [/AI 步骤：DOM 更新后未采集到可交互节点，请重试该步/g, 'AI step: no interactive nodes collected after DOM update, retry this step'],
    [/AI 步骤：DOM 更新后无法匹配原节点 /g, 'AI step: cannot remap original node after DOM update '],
    [/（页面结构变化过大，请重试该步或拆成多条智能步骤）/g, '(page structure changed too much; retry this step or split into multiple AI steps)'],
    [/AI 步骤：找不到节点 /g, 'AI step: node not found '],
    [/（DOM 可能已更新，请重试该步）/g, '(DOM may have changed, retry this step)'],
    [/AI 步骤：找不到悬停目标 /g, 'AI step: hover target not found '],
    [/（DOM 可能已更新）/g, '(DOM may have changed)'],
    [/AI 步骤：assert_text 缺少 value/g, 'AI step: assert_text missing value'],
    [/AI 断言失败：页面中未找到文本/g, 'AI assertion failed: text not found on page'],
    [/无法解析页面结构快照（DOM 更新后）/g, 'Cannot parse page structure snapshot (after DOM update)'],
    [/DOM 更新后未采集到可交互节点，请确认页面已加载完成/g, 'No interactive nodes collected after DOM update, ensure page is fully loaded'],
    [/AI 步骤缺少自然语言指令（请在「自然语言指令」或步骤描述中填写）/g, 'AI step missing natural-language instruction (fill instruction field or step description)'],
    [/无法解析页面结构快照/g, 'Cannot parse page structure snapshot'],
    [/未采集到可交互节点，请确认页面已加载完成/g, 'No interactive nodes collected, ensure page is fully loaded'],
    [/大模型未返回可执行操作：/g, 'Model returned no executable operations: '],
    [/大模型返回了无效节点 id:/g, 'Model returned an invalid node id:'],
  ];
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MAX_CONCURRENT_PLAYS = 5;
const VIEWPORT_MODES = new Set(['maximized', 'current', 'custom']);
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;

function normalizeViewportMode(input, fallback = 'maximized') {
  const raw = String(input || '').trim().toLowerCase();
  if (VIEWPORT_MODES.has(raw)) return raw;
  const fallbackRaw = String(fallback || '').trim().toLowerCase();
  return VIEWPORT_MODES.has(fallbackRaw) ? fallbackRaw : 'maximized';
}

function normalizeViewportDimension(input, fallback) {
  const value = Math.round(Number(input));
  if (Number.isFinite(value) && value >= 320 && value <= 10000) return value;
  const fallbackValue = Math.round(Number(fallback));
  if (Number.isFinite(fallbackValue) && fallbackValue >= 320 && fallbackValue <= 10000) return fallbackValue;
  return 0;
}

async function readWindowBounds(windowId) {
  if (windowId == null) return null;
  const win = await chrome.windows.get(Number(windowId)).catch(() => null);
  if (!win) return null;
  const width = normalizeViewportDimension(win.width, 0);
  const height = normalizeViewportDimension(win.height, 0);
  if (!width || !height) return null;
  return {
    width,
    height,
    left: Number.isFinite(Number(win.left)) ? Number(win.left) : undefined,
    top: Number.isFinite(Number(win.top)) ? Number(win.top) : undefined,
  };
}

async function resolveWindowPreference(input = {}) {
  const mode = normalizeViewportMode(input.viewportMode || input.viewport_mode, 'maximized');
  if (mode === 'custom') {
    return {
      mode,
      width: normalizeViewportDimension(input.viewportWidth || input.viewport_width, DEFAULT_VIEWPORT_WIDTH),
      height: normalizeViewportDimension(input.viewportHeight || input.viewport_height, DEFAULT_VIEWPORT_HEIGHT),
    };
  }
  if (mode === 'current') {
    const bounds = await readWindowBounds(input.sourceWindowId);
    if (bounds) return { mode, ...bounds };
  }
  return { mode: 'maximized' };
}

function buildWindowCreateData(url, focused, preference) {
  const data = { url, focused };
  if (preference?.mode === 'custom' || preference?.mode === 'current') {
    data.state = 'normal';
    data.width = preference.width;
    data.height = preference.height;
    if (preference.left != null) data.left = preference.left;
    if (preference.top != null) data.top = preference.top;
    return data;
  }
  data.state = 'maximized';
  return data;
}

async function applyWindowPreference(windowId, preference) {
  if (windowId == null) return;
  if (preference?.mode === 'custom' || preference?.mode === 'current') {
    await chrome.windows.update(windowId, { state: 'normal' }).catch(() => {});
    await chrome.windows.update(windowId, {
      width: preference.width,
      height: preference.height,
      ...(preference.left != null ? { left: preference.left } : {}),
      ...(preference.top != null ? { top: preference.top } : {}),
      focused: true,
    }).catch(() => {});
    return;
  }
  await chrome.windows.update(windowId, { state: 'maximized', focused: true }).catch(() => {});
}

/**
 * 弹窗未传 startUrl 时用用例上的 start_url；必须能解析出带协议的 http(s) 地址。
 */
function resolvePlaybackStartUrl(startUrl, testCase) {
  const a = startUrl != null && String(startUrl).trim() !== '' ? String(startUrl).trim() : '';
  const b =
    testCase?.start_url != null && String(testCase.start_url).trim() !== ''
      ? String(testCase.start_url).trim()
      : '';
  let raw = a || b;
  if (!raw) {
    throw new Error(
      '未配置起始 URL：请在中台编辑该用例并填写「起始 URL」，保存后再从用例页或此处重试',
    );
  }
  if (!/^https?:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  return raw;
}

function normalizeStartStepIndex(value, stepCount) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  if (n >= stepCount) return -1;
  return n;
}

export class PlayerManager {
  constructor(state, api) {
    this.state = state;
    this.api = api;
    /** @type {Set<{ stopped: boolean, debuggerAttached: boolean, tabId: number | null, testCaseId: number, liveBroadcast?: boolean }>} */
    this._playContexts = new Set();
    /** @type {Map<number, number>} */
    this._playTabByCaseId = new Map();
  }

  /** 是否为「非本扩展」的 chrome-extension:// 页面（CDP / scripting 均受限） */
  static _isForeignExtensionPageUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('chrome-extension://')) return false;
    const own = chrome.runtime.id;
    return !url.startsWith(`chrome-extension://${own}/`);
  }

  /** CDP 在跨扩展页面上会抛此错，应断开 debugger 并降级为 DOM */
  static _isCdpForeignExtensionError(err) {
    const m = String(err && err.message ? err.message : err);
    return (
      (m.includes('Cannot access') && m.includes('chrome-extension'))
      || m.includes('different extension')
    );
  }

  /**
   * 页面是否处于常见「接口/表格加载中」UI（iView / Ant / Element 等）。
   * 与 content/player.js 中 isPageLoadingUi 保持语义一致。
   */
  static PAGE_LOADING_UI_CHECK = `(function(){
    try {
      if (document.querySelector('[aria-busy="true"]')) return true;
      var nodes = document.querySelectorAll(
        '.ivu-spin-fix .ivu-spin-main,.ivu-table-wrapper .ivu-spin-main,.ivu-table-with-loading .ivu-spin,' +
        '.ivu-spin.ivu-spin-fix .ivu-spin-main,.ivu-load-loop,.ant-spin-spinning,.ant-spin-nested-loading .ant-spin,' +
        '.el-loading-mask,.el-loading-spinner,.el-icon-loading,.v-loading-parent--relative .v-loading,' +
        '[data-loading="true"]'
      );
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        var st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) continue;
        return true;
      }
    } catch (e) {}
    return false;
  })()`;

  /** 加载态下墙钟上限（秒），防止永不结束 */
  static LOADING_WAIT_WALL_MS = 180000;

  /**
   * 命中即中止回放（正文子串匹配，英文不区分大小写）。
   * 与 content/player.js 中 detectPageErrorSignal 保持列表一致。
   */
  static DEFAULT_PAGE_ERROR_KEYWORDS = [
    '请求失败', '加载失败', '网络错误', '网络异常', '系统异常', '操作失败', '登录失败',
    '权限不足', '无权限', '访问被拒绝', '服务异常', '服务器错误', '请稍后重试', '接口异常',
    'Internal Server Error', 'Bad Gateway', 'Network Error', 'Failed to fetch', 'Gateway Timeout',
  ];

  static _pageErrorCheckExpr = null;

  static getPageErrorCheckExpr() {
    if (!PlayerManager._pageErrorCheckExpr) {
      const kw = JSON.stringify(PlayerManager.DEFAULT_PAGE_ERROR_KEYWORDS);
      PlayerManager._pageErrorCheckExpr = `(function(){
        try {
          var keywords = ${kw};
          var text = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 24000) : '';
          for (var i = 0; i < keywords.length; i++) {
            var k = keywords[i];
            if (!k) continue;
            var idx = text.toLowerCase().indexOf(k.toLowerCase());
            if (idx >= 0) {
              var snip = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + k.length + 120)).replace(/\\s+/g, ' ').trim();
              return { hit: true, keyword: k, snippet: snip };
            }
          }
          var errSel = '.ivu-message-error,.ivu-notice-error,.el-message--error,.ant-message-error,.ant-message-error .ant-message-content,.arco-message-error,.alert-danger,.alert-error,.ivu-alert-error,.t-message--error';
          var nodes = document.querySelectorAll(errSel);
          for (var j = 0; j < nodes.length; j++) {
            var el = nodes[j];
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            var st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) continue;
            var t = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 400);
            if (t.length > 0) return { hit: true, keyword: '[页面错误提示]', snippet: t };
          }
        } catch (e) {}
        return null;
      })()`;
    }
    return PlayerManager._pageErrorCheckExpr;
  }

  _broadcastPlayback(payload) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        const u = tab.url;
        if (
          u.startsWith('chrome://')
          || u.startsWith('chrome-extension://')
          || u.startsWith('edge://')
          || u.startsWith('about:')
        ) {
          continue;
        }
        chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
      }
    });
  }

  /**
   * 将回放标签页置于前台。仅作 best-effort：部分环境下 windows.update(focused)
   * 会触发 “Cannot access a chrome-extension:// URL of different extension”，故整体包在 try/catch 中。
   */
  async _bringTabToForeground(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
      console.warn('[Player] tabs.update(active) 失败:', e?.message || e);
      return;
    }
    if (tab.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        console.warn('[Player] windows.update(focused) 失败:', e?.message || e);
      }
    }
  }

  async focusPlayTab(testCaseId) {
    const tid = this._playTabByCaseId.get(testCaseId);
    if (tid == null) {
      return { ok: false, error: '当前没有该用例的回放标签页' };
    }
    const tab = await chrome.tabs.get(tid).catch(() => null);
    if (!tab) {
      this._playTabByCaseId.delete(testCaseId);
      return { ok: false, error: '标签页已关闭' };
    }
    await this._bringTabToForeground(tid);
    return { ok: true };
  }

  handlePlayTabClosed(tabId) {
    for (const ctx of this._playContexts) {
      if (ctx.tabId === tabId) ctx.stopped = true;
    }
  }

  async start(testCaseId, startUrl, opts = {}) {
    const runLocale = normalizeLocale(opts.locale);
    if (this.state.mode === 'recording') {
      return { ok: false, error: trByLocale(runLocale, '正在录制，无法回放', 'Recording in progress, playback is unavailable') };
    }
    if (this._playContexts.size >= MAX_CONCURRENT_PLAYS) {
      return { ok: false, error: trByLocale(runLocale, '并发回放已达上限（5）', 'Concurrent playback limit reached (5)') };
    }

    let ctx = null;
    let playTabId = null;

    try {
      const res = await this.api.getTestCase(testCaseId);
      const testCase = res.data;
      const steps = testCase.steps || [];
      const windowPreference = await resolveWindowPreference({
        viewportMode: opts.viewportMode || testCase.viewport_mode,
        viewportWidth: opts.viewportWidth || testCase.viewport_width,
        viewportHeight: opts.viewportHeight || testCase.viewport_height,
        sourceWindowId: opts.sourceWindowId,
      });
      const pageErrorCheckEnabled = Number(testCase.page_error_check_enabled ?? 0) !== 0;
      const screenshotMode = String(testCase.screenshot_mode || '').trim().toLowerCase() === 'full_hd'
        ? 'full_hd'
        : 'standard';

      if (!steps.length) {
        return { ok: false, error: trByLocale(runLocale, '用例没有步骤', 'Case has no steps') };
      }

      const startStepIndex = normalizeStartStepIndex(opts.startStepIndex, steps.length);
      if (startStepIndex < 0) {
        return { ok: false, error: trByLocale(runLocale, '起始步骤超出用例步骤范围', 'Start step is outside the case step range') };
      }
      const stepStartUrl =
        startStepIndex > 0
          ? String(steps[startStepIndex]?.url || steps[startStepIndex - 1]?.url || '').trim()
          : '';
      const targetUrl = resolvePlaybackStartUrl(startUrl || stepStartUrl, testCase);

      if (this.state.mode === 'recording') {
        return { ok: false, error: trByLocale(runLocale, '正在录制，无法回放', 'Recording in progress, playback is unavailable') };
      }
      if (this._playContexts.size >= MAX_CONCURRENT_PLAYS) {
        return { ok: false, error: trByLocale(runLocale, '并发回放已达上限（5）', 'Concurrent playback limit reached (5)') };
      }

      ctx = {
        stopped: false,
        debuggerAttached: false,
        tabId: null,
        testCaseId,
        reusedTab: false,
        locale: runLocale,
        pageErrorCheckEnabled,
        startStepIndex,
      };
      this._playContexts.add(ctx);
      this.state.activePlayCount = (this.state.activePlayCount || 0) + 1;
      this.state.testCaseId = testCaseId;

      const reuseTabId = opts.reuseTabId ?? null;

      if (reuseTabId != null) {
        playTabId = reuseTabId;
        ctx.tabId = playTabId;
        ctx.reusedTab = true;
        const reuseTab = await chrome.tabs.get(playTabId).catch(() => null);
        if (reuseTab?.windowId != null) await applyWindowPreference(reuseTab.windowId, windowPreference);
        await chrome.tabs.update(playTabId, { url: targetUrl, active: true });
      } else {
        const active = opts.backgroundTab !== true;
        const win = await chrome.windows.create(buildWindowCreateData(targetUrl, active, windowPreference));
        const tab = win.tabs[0];
        playTabId = tab.id;
        ctx.tabId = playTabId;
      }
      this._playTabByCaseId.set(testCaseId, playTabId);
      this._pageErrorCheckEnabledByTab = this._pageErrorCheckEnabledByTab || new Map();
      this._pageErrorCheckEnabledByTab.set(playTabId, pageErrorCheckEnabled);
      ctx.liveBroadcast = true;
      this._broadcastPlayback({ type: 'AT_PLAYBACK_LIVE', testCaseId, tabId: playTabId });
      await this._bringTabToForeground(playTabId);
      await this._waitForTabLoad(playTabId);

      const tabAfterLoad = await chrome.tabs.get(playTabId).catch(() => null);
      const urlAfterLoad = tabAfterLoad?.url || '';
      if (PlayerManager._isForeignExtensionPageUrl(urlAfterLoad)) {
        throw new Error(
          `起始页为其他扩展的页面，无法回放：${urlAfterLoad}\n请将用例「起始 URL」改为 http(s) 地址，勿指向其他扩展的 chrome-extension:// 页面。`,
        );
      }
      if (
        urlAfterLoad.startsWith('chrome://')
        || urlAfterLoad.startsWith('devtools://')
        || urlAfterLoad.startsWith('edge://')
      ) {
        throw new Error(
          `起始页为浏览器内置协议，无法注入回放脚本：${urlAfterLoad}\n请改为 http(s) 页面。`,
        );
      }

      let cdpAvailable = await this._attachDebugger(playTabId, ctx);

      try {
        await chrome.scripting.executeScript({
          target: { tabId: playTabId },
          files: ['content/player.js'],
        });
      } catch (injErr) {
        const im = String(injErr && injErr.message ? injErr.message : injErr);
        if (im.includes('chrome-extension') || im.includes('Cannot access')) {
          throw new Error(
            `无法向当前页注入回放脚本（受限 URL 或第三方扩展页面）：${urlAfterLoad || targetUrl}\n${im}`,
          );
        }
        throw injErr;
      }

      this._notifyPopup(
        startStepIndex > 0
          ? trByLocale(
            ctx.locale,
            `开始回放 #${testCaseId}，从第 ${startStepIndex + 1}/${steps.length} 步开始`,
            `Start playback #${testCaseId} from step ${startStepIndex + 1}/${steps.length}`,
          )
          : trByLocale(ctx.locale, `开始回放 #${testCaseId}，共 ${steps.length} 步`, `Start playback #${testCaseId}, total ${steps.length} steps`),
      );

      const startTime = Date.now();
      let errorStep = null;
      let errorMsg = null;
      let failureContext = null;
      const playbackScreenshots = new Array(steps.length).fill('');
      const aiSubtasksByStep = {};

      for (let i = startStepIndex; i < steps.length; i++) {
        if (ctx.stopped) {
          errorMsg = trByLocale(ctx.locale, '用户手动停止', 'Stopped by user');
          errorStep = i;
          break;
        }

        const step = steps[i];
        const runtimeStep = PlayerManager._resolveDynamicStepValue(step);
        const runtimeNextStep = steps[i + 1] ? PlayerManager._resolveDynamicStepValue(steps[i + 1]) : null;
        const at = String(runtimeStep.action_type || '').trim().toLowerCase();
        const stepLine = isAiNaturalStep(step)
          ? trByLocale(ctx.locale, `#${testCaseId} 第 ${i + 1}/${steps.length} 步 · 智能步骤`, `#${testCaseId} Step ${i + 1}/${steps.length} · AI Step`)
          : at === 'assert_json'
            ? trByLocale(ctx.locale, `#${testCaseId} 第 ${i + 1}/${steps.length} 步 · JSON 断言`, `#${testCaseId} Step ${i + 1}/${steps.length} · JSON Assert`)
            : trByLocale(ctx.locale, `#${testCaseId} 第 ${i + 1}/${steps.length} 步: ${runtimeStep.description || runtimeStep.action_type}`, `#${testCaseId} Step ${i + 1}/${steps.length}: ${runtimeStep.description || runtimeStep.action_type}`);
        this._notifyPopup(stepLine);

        try {
          const waitBefore = Math.max(0, Number(runtimeStep.wait_before) || 0);
          if (waitBefore) await this._sleep(waitBefore);
          const executableStep = waitBefore ? { ...runtimeStep, wait_before: 0 } : runtimeStep;

          if (String(executableStep.action_type || '').trim().toLowerCase() !== 'assert_text') {
            await this._throwIfPageError(playTabId);
          }

          const actionType = String(executableStep.action_type || '').trim().toLowerCase();
          const captureInsideCdpStep = cdpAvailable
            && this._canUseCDP(executableStep)
            && ['click', 'double_click', 'right_click', 'hover'].includes(actionType);
          const captureCurrentStep = async () => {
            if (!cdpAvailable) return;
            const shot = await this._capturePlaybackScreenshot(playTabId, screenshotMode);
            if (shot) playbackScreenshots[i] = shot;
          };

          if (cdpAvailable && !captureInsideCdpStep) {
            await captureCurrentStep();
          }

          if (isAiNaturalStep(executableStep)) {
            if (!cdpAvailable) {
              throw new Error('AI 自然语言步骤需要 CDP（debugger）模式，请确认扩展具备调试权限且页面允许附加调试器');
            }
            const aiSubtasks = await this._executeAiNaturalStep(playTabId, executableStep, ctx, {
              stepIndex: i + 1,
              stepTotal: steps.length,
            });
            if (Array.isArray(aiSubtasks) && aiSubtasks.length) {
              aiSubtasksByStep[String(i)] = aiSubtasks;
            }
          } else if (String(executableStep.action_type || '').trim().toLowerCase() === 'assert_json') {
            if (!cdpAvailable) {
              throw new Error('JSON 断言步骤需要 CDP（debugger）模式，请确认扩展具备调试权限且页面允许附加调试器');
            }
            await this._executeAssertJsonStep(playTabId, executableStep, testCaseId);
          } else if (String(executableStep.action_type || '').trim().toLowerCase() === 'assert_text' && cdpAvailable) {
            // 必须在后台用 CDP 直接断言：依赖 tabs.sendMessage 回包易丢，导致失败被当成成功
            await this._executeAssertTextStepCDP(playTabId, executableStep);
          } else if (cdpAvailable && this._canUseCDP(executableStep)) {
            try {
              await this._executeStepCDP(playTabId, executableStep, targetUrl, ctx.locale, runtimeNextStep, {
                beforeActionScreenshot: captureCurrentStep,
              });
            } catch (cdpErr) {
              if (PlayerManager._isCdpForeignExtensionError(cdpErr)) {
                await this._detachDebugger(playTabId, ctx);
                cdpAvailable = false;
                await this._executeStepDOM(playTabId, executableStep, ctx.locale, runtimeNextStep);
              } else {
                throw cdpErr;
              }
            }
          } else {
            await this._executeStepDOM(playTabId, executableStep, ctx.locale, runtimeNextStep);
          }

          await this._sleep(300);

          if (['click', 'navigate', 'ai_natural'].includes(String(executableStep.action_type || '').trim().toLowerCase())) {
            await this._waitForTabLoad(playTabId);
          }
        } catch (err) {
          const rawErrMsg = err && err.message ? err.message : String(err);
          errorMsg = localizePlaybackError(ctx.locale, rawErrMsg);
          errorStep = i;
          if (isAiNaturalStep(runtimeStep) && Array.isArray(err?.aiSubtasks) && err.aiSubtasks.length) {
            aiSubtasksByStep[String(i)] = err.aiSubtasks;
          }
          if (cdpAvailable && playTabId != null) {
            try {
              const failShot = await this._capturePlaybackScreenshot(playTabId, screenshotMode);
              if (failShot) playbackScreenshots[i] = failShot;
            } catch {
              /* ignore */
            }
            try {
              failureContext = await this._collectFailureContext(playTabId, i, errorMsg);
            } catch {
              failureContext = { error_message: errorMsg, error_step_index: i, url: targetUrl };
            }
          } else {
            failureContext = { error_message: errorMsg, error_step_index: i, url: targetUrl, cdp_unavailable: true };
          }
          break;
        }
      }

      const duration = Date.now() - startTime;
      const success = !errorMsg;
      const executedStepIndexes = [];
      for (let i = startStepIndex; i < steps.length; i++) executedStepIndexes.push(i);

      await this.api.saveResult(testCaseId, {
        status: success ? 'success' : 'failed',
        duration,
        error_message: errorMsg || '',
        error_step: errorStep,
        detail: {
          steps: steps.length,
          start_step_index: startStepIndex,
          executed_step_indexes: executedStepIndexes,
          cdp_mode: cdpAvailable,
          playback_screenshots: playbackScreenshots,
          ai_subtasks_by_step: aiSubtasksByStep,
          ...(failureContext ? { failure_context: failureContext } : {}),
        },
      });

      this._notifyPopup(
        success
          ? trByLocale(ctx.locale, `✅ #${testCaseId} 成功（${duration}ms）`, `✅ #${testCaseId} Success (${duration}ms)`)
          : trByLocale(ctx.locale, `❌ #${testCaseId} 失败: ${errorMsg}`, `❌ #${testCaseId} Failed: ${errorMsg}`),
      );
      this._showNotification(
        success
          ? trByLocale(ctx.locale, '回放成功', 'Playback succeeded')
          : trByLocale(ctx.locale, '回放失败', 'Playback failed'),
        success
          ? trByLocale(ctx.locale, `#${testCaseId} 用时 ${duration}ms`, `#${testCaseId} Duration ${duration}ms`)
          : trByLocale(ctx.locale, `#${testCaseId} 第 ${(errorStep ?? 0) + 1} 步: ${errorMsg}`, `#${testCaseId} Step ${(errorStep ?? 0) + 1}: ${errorMsg}`),
      );

      return { ok: success, duration, error: errorMsg };
    } catch (err) {
      const rawMsg = err && err.message ? err.message : String(err);
      const msg = localizePlaybackError(ctx?.locale ?? runLocale, rawMsg);
      if (msg && !rawMsg.includes('用户手动停止') && !msg.includes('Stopped by user')) {
        this._showNotification(
          trByLocale(ctx?.locale ?? runLocale, '回放无法启动或异常退出', 'Playback failed to start or exited abnormally'),
          msg.length > 180 ? `${msg.slice(0, 180)}…` : msg,
        );
      }
      return { ok: false, error: msg };
    } finally {
      // 须始终广播 END（含拉取用例失败、无步骤等），否则中台顺序回放会一直等不到结束事件
      this._broadcastPlayback({ type: 'AT_PLAYBACK_END', testCaseId });
      if (ctx != null) {
        if (ctx.liveBroadcast) {
          this._playTabByCaseId.delete(ctx.testCaseId);
        }
        if (playTabId != null) {
          if (ctx.debuggerAttached) await this._detachDebugger(playTabId, ctx).catch(() => {});
          await chrome.tabs.sendMessage(playTabId, { type: 'AT_PLAYER_CLEANUP' }).catch(() => {});
          if (this._pageErrorCheckEnabledByTab) this._pageErrorCheckEnabledByTab.delete(playTabId);
          if (!ctx.reusedTab) {
            await chrome.tabs.remove(playTabId).catch(() => {});
          }
        }
        ctx.tabId = null;
        this._playContexts.delete(ctx);
        this.state.activePlayCount = Math.max(0, (this.state.activePlayCount || 0) - 1);
      }
    }
  }

  async stop() {
    for (const ctx of this._playContexts) {
      ctx.stopped = true;
    }
    return { ok: true };
  }

  // =========================================================
  // CDP 相关
  // =========================================================
  _canUseCDP(step) {
    return [
      'click',
      'double_click',
      'right_click',
      'input',
      'key',
      'scroll',
      'hover',
    ].includes(step.action_type);
  }

  async _attachDebugger(tabId, ctx) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      ctx.debuggerAttached = true;
      return true;
    } catch (e) {
      console.warn('[Player] CDP attach 失败，降级为 DOM 模式:', e.message);
      ctx.debuggerAttached = false;
      return false;
    }
  }

  async _detachDebugger(tabId, ctx) {
    if (!ctx.debuggerAttached) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {}
    ctx.debuggerAttached = false;
  }

  async _cdpSend(tabId, method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  }

  /** 视口截图（需已附加 debugger），用于回放步骤截图落库 */
  async _capturePlaybackScreenshot(tabId, screenshotMode = 'standard') {
    const quality = screenshotMode === 'full_hd' ? 90 : 68;
    try {
      const res = await this._cdpSend(tabId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality,
        fromSurface: true,
      });
      if (!res || !res.data) return '';
      return 'data:image/jpeg;base64,' + res.data;
    } catch (e) {
      console.warn('[Player] 步骤截图失败', e && e.message ? e.message : e);
      return '';
    }
  }

  // 判断元素是否处于 disabled 状态。组件库 class 禁用只作用于交互组件根，避免普通祖先容器误伤内部按钮。
  static _disabledInfoCode(elVar) {
    return `(function(el){
      function brief(node) {
        if (!node) return '';
        var tag = String(node.tagName || '').toLowerCase();
        var id = node.id ? '#' + node.id : '';
        var cls = String(node.className || '').trim().replace(/\\s+/g, '.');
        return tag + id + (cls ? '.' + cls : '');
      }
      if (!el) return { disabled: false };
      const disabledClassRe = /(?:^|\\s)(?:[a-z]+-)?disabled(?:\\s|$)/i;
      const formControlSel = 'button,input,select,textarea,option,optgroup';
      const componentRootSel = [
        '.el-select', '.ivu-select', '.ant-select', '.v-select', '.vs__dropdown-toggle', '[role="combobox"]',
        '.el-button', '.ivu-btn', '.ant-btn', '[role="button"]',
        '.el-radio', '.ivu-radio-wrapper', '.ant-radio-wrapper',
        '.el-checkbox', '.ivu-checkbox-wrapper', '.ant-checkbox-wrapper',
        '.el-input', '.ivu-input-wrapper', '.ant-input-affix-wrapper',
        '.el-cascader', '.ivu-cascader', '.ant-cascader', '.ant-cascader-picker',
        '.el-switch', '.ivu-switch', '.ant-switch',
        '.el-slider', '.ivu-slider', '.ant-slider',
        '.el-date-editor', '.ivu-date-picker', '.ant-picker',
        '.el-input-number', '.ivu-input-number', '.ant-input-number',
        '.el-autocomplete', '.el-upload',
        '.t-select', '.t-button', '.t-radio', '.t-checkbox', '.t-switch',
        '.arco-select', '.arco-btn', '.arco-radio', '.arco-checkbox', '.arco-switch',
        '.n-select', '.n-button', '.n-radio', '.n-checkbox', '.n-switch',
        '.MuiButton-root', '.MuiSelect-root', '.MuiInputBase-root', '.MuiSwitch-root'
      ].join(',');
      if (el.disabled || (el.getAttribute && el.getAttribute('disabled') !== null)) {
        return { disabled: true, reason: 'native-disabled', by: brief(el) };
      }
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') {
        return { disabled: true, reason: 'aria-disabled', by: brief(el) };
      }
      const ownerControl = el.closest && el.closest(formControlSel);
      if (ownerControl) {
        if (ownerControl.disabled || (ownerControl.getAttribute && ownerControl.getAttribute('disabled') !== null)) {
          return { disabled: true, reason: 'owner-native-disabled', by: brief(ownerControl) };
        }
        if (ownerControl.getAttribute && ownerControl.getAttribute('aria-disabled') === 'true') {
          return { disabled: true, reason: 'owner-aria-disabled', by: brief(ownerControl) };
        }
        const fieldset = ownerControl.closest && ownerControl.closest('fieldset[disabled]');
        if (fieldset) return { disabled: true, reason: 'fieldset-disabled', by: brief(fieldset) };
      }
      let cur = el;
      while (cur && cur !== document.body) {
        if (cur.matches && cur.matches(componentRootSel)) {
          if (cur.disabled || (cur.getAttribute && cur.getAttribute('disabled') !== null)) {
            return { disabled: true, reason: 'component-native-disabled', by: brief(cur) };
          }
          if (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true') {
            return { disabled: true, reason: 'component-aria-disabled', by: brief(cur) };
          }
          if (disabledClassRe.test(String(cur.className || ''))) {
            return { disabled: true, reason: 'component-disabled-class', by: brief(cur) };
          }
        }
        cur = cur.parentElement;
      }
      if (disabledClassRe.test(String(el.className || ''))) {
        return { disabled: true, reason: 'target-disabled-class', by: brief(el) };
      }
      return { disabled: false };
    })(${elVar})`;
  }

  static _isDisabledCode(elVar) {
    return `(${PlayerManager._disabledInfoCode(elVar)}).disabled`;
  }

  // 常见下拉浮层容器的选择器（iView / Element UI / Ant Design / Vuetify 等）
  static OVERLAY_CONTAINER_SEL = [
    '.ivu-select-dropdown', '.el-select-dropdown',
    '.ant-select-dropdown', '.v-menu__content',
    '.vs__dropdown-menu', '.el-popper',
  ].join(',');

  /** Teleport + Transition 内层 fixed 面板；与 recorder getVisibleCustomOverlayRoots 一致 */
  static _customOverlayCollectFnSource() {
    return `function collectCustomOverlayContainers() {
      var seen = new Set();
      var out = [];
      function add(el) {
        if (!el || el.nodeType !== 1 || seen.has(el)) return;
        var style = window.getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'absolute') return;
        var r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) return;
        seen.add(el);
        out.push(el);
      }
      for (var i = 0; i < document.body.children.length; i++) {
        var child = document.body.children[i];
        add(child);
        if (child.children) {
          for (var j = 0; j < child.children.length; j++) add(child.children[j]);
        }
      }
      var btns = document.querySelectorAll('button, [role="menuitem"]');
      for (var k = 0; k < btns.length; k++) {
        var cur = btns[k].parentElement;
        while (cur && cur !== document.body) {
          var p = window.getComputedStyle(cur).position;
          if (p === 'fixed' || p === 'absolute') { add(cur); break; }
          cur = cur.parentElement;
        }
      }
      return out;
    }
    function overlayItemTexts(el) {
      var full = el.textContent.trim().replace(/\\s+/g, ' ');
      var texts = [full];
      try {
        var title = el.querySelector('.truncate, [class*="font-medium"]');
        if (title) {
          var t = title.textContent.trim().replace(/\\s+/g, ' ');
          if (t && texts.indexOf(t) < 0) texts.push(t);
        }
      } catch (e) {}
      return texts;
    }
    function textsMatchItem(texts, needle) {
      for (var ti = 0; ti < texts.length; ti++) {
        var t2 = texts[ti];
        if (t2 === needle) return { exact: true };
        if (needle.length >= 1 && t2.includes(needle)) return { exact: false };
      }
      return null;
    }`;
  }

  // 找到当前页面中所有可见的浮层容器
  static _visibleOverlayContainersCode() {
    return `(function(){
      const sel = ${JSON.stringify(PlayerManager.OVERLAY_CONTAINER_SEL)};
      return Array.from(document.querySelectorAll(sel)).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    })()`;
  }

  // 在可见浮层内按文本找选项：多下拉同时展开时按 z-index、精确匹配优先，避免总点到第一个下拉里的同名项
  static _findInOverlayCode(text) {
    const t = JSON.stringify(text);
    const helpers = PlayerManager._customOverlayCollectFnSource();
    return `(function(){
      ${helpers}
      const needle = ${t};
      const sel = ${JSON.stringify(PlayerManager.OVERLAY_CONTAINER_SEL)};
      function zIndex(el) {
        let z = 0, cur = el;
        while (cur && cur !== document.body) {
          const zi = parseInt(window.getComputedStyle(cur).zIndex, 10);
          if (!isNaN(zi) && zi > z) z = zi;
          cur = cur.parentElement;
        }
        return z;
      }
      const containers = Array.from(document.querySelectorAll(sel)).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const candidates = [];
      let order = 0;
      for (const container of containers) {
        const cz = zIndex(container);
        const items = container.querySelectorAll('li, [role="option"], [role="menuitem"], .ivu-select-item, .el-select-dropdown__item, .el-option, .ant-select-item, .ant-select-item-option-content');
        for (const item of items) {
          const t2 = item.textContent.trim().replace(/\\s+/g, ' ');
          const exact = t2 === needle;
          const inc = !exact && needle.length >= 1 && t2.includes(needle);
          if (exact || inc) {
            const r = item.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              candidates.push({ item: item, exact: exact, score: cz + zIndex(item), ord: order++ });
            }
          }
        }
      }
      var popSel = '.ivu-tooltip-popper, .ivu-poptip-popper, .ivu-modal-wrap .ivu-modal';
      var popContainers = Array.from(document.querySelectorAll(popSel)).filter(function(el) {
        var r0 = el.getBoundingClientRect();
        return r0.width > 0 && r0.height > 0;
      });
      var btnSel = 'button, .ivu-btn, a.ivu-btn, .el-button, [role="button"]';
      for (var pi = 0; pi < popContainers.length; pi++) {
        var pcontainer = popContainers[pi];
        var pcz = zIndex(pcontainer);
        var pitems = pcontainer.querySelectorAll(btnSel);
        for (var pj = 0; pj < pitems.length; pj++) {
          var pitem = pitems[pj];
          var pt2 = pitem.textContent.trim().replace(/\\s+/g, ' ');
          var pexact = pt2 === needle;
          var pinc = !pexact && needle.length >= 1 && pt2.includes(needle);
          if (pexact || pinc) {
            var pr = pitem.getBoundingClientRect();
            if (pr.width > 0 && pr.height > 0) {
              candidates.push({ item: pitem, exact: pexact, score: pcz + zIndex(pitem), ord: order++ });
            }
          }
        }
      }
      // 自定义浮层 / 二次子菜单（Teleport + Transition 内层 fixed 面板）
      var customItemSel = 'button, [role="menuitem"], li, [role="option"]';
      var customContainers = collectCustomOverlayContainers();
      for (var ci = 0; ci < customContainers.length; ci++) {
        var ccontainer = customContainers[ci];
        var ccz = zIndex(ccontainer);
        var citems = ccontainer.querySelectorAll(customItemSel);
        for (var cj = 0; cj < citems.length; cj++) {
          var citem = citems[cj];
          var cm = textsMatchItem(overlayItemTexts(citem), needle);
          if (cm) {
            var crr = citem.getBoundingClientRect();
            if (crr.width > 0 && crr.height > 0) {
              candidates.push({ item: citem, exact: !!cm.exact, score: ccz + zIndex(citem), ord: order++ });
            }
          }
        }
      }
      candidates.sort(function(a, b) {
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.ord - a.ord;
      });
      var pick = candidates[0];
      if (pick) {
        pick.item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        const r = pick.item.getBoundingClientRect();
        var ocx = r.left + r.width / 2, ocy = r.top + r.height / 2;
        var ohit = document.elementFromPoint(ocx, ocy);
        var oitem = pick.item;
        var ohitOk = false;
        if (ohit && ohit.nodeType === 1) {
          var ocur = ohit;
          while (ocur) {
            if (ocur === oitem) { ohitOk = true; break; }
            ocur = ocur.parentElement;
          }
          if (!ohitOk) {
            try {
              var olab = typeof ohit.closest === 'function' ? ohit.closest('label') : null;
              if (olab && olab.control === oitem) ohitOk = true;
            } catch (oe) {}
          }
        }
        return { x: ocx, y: ocy, via: 'overlay-scored', hitOk: ohitOk };
      }
      for (const item of document.querySelectorAll('li, option, [role="option"]')) {
        if (item.textContent.trim().replace(/\\s+/g, ' ') === needle) {
          const r = item.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            item.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            const r2 = item.getBoundingClientRect();
            var gcx = r2.left + r2.width / 2, gcy = r2.top + r2.height / 2;
            var ghit = document.elementFromPoint(gcx, gcy);
            var ghitOk = false;
            if (ghit && ghit.nodeType === 1) {
              var gcur = ghit;
              while (gcur) {
                if (gcur === item) { ghitOk = true; break; }
                gcur = gcur.parentElement;
              }
              if (!ghitOk) {
                try {
                  var glab = typeof ghit.closest === 'function' ? ghit.closest('label') : null;
                  if (glab && glab.control === item) ghitOk = true;
                } catch (ge) {}
              }
            }
            return { x: gcx, y: gcy, via: 'global-text', hitOk: ghitOk };
          }
        }
      }
      return null;
    })()`;
  }

  // 获取当前可见下拉框内所有选项文本（用于报错诊断）
  async _getOverlayItemTexts(tabId) {
    const helpers = PlayerManager._customOverlayCollectFnSource();
    const code = `(function(){
      ${helpers}
      const sel = ${JSON.stringify(PlayerManager.OVERLAY_CONTAINER_SEL)};
      const containers = Array.from(document.querySelectorAll(sel)).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const texts = [];
      for (const container of containers) {
        for (const item of container.querySelectorAll('li, [role="option"], .ivu-select-item, .el-select-dropdown__item')) {
          const t = item.textContent.trim().replace(/\\s+/g, ' ');
          if (t) texts.push(t);
        }
      }
      for (const ccontainer of collectCustomOverlayContainers()) {
        for (const item of ccontainer.querySelectorAll('button, [role="menuitem"], li, [role="option"]')) {
          for (const t of overlayItemTexts(item)) {
            if (t) texts.push(t);
          }
        }
      }
      return JSON.stringify(texts.slice(0, 30));
    })()`;
    try {
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: code, returnByValue: true });
      return JSON.parse(res?.result?.value || '[]');
    } catch {
      return [];
    }
  }

  // 判断元素是否处于 disabled 状态。组件库 class 禁用只作用于交互组件根，避免普通祖先容器误伤内部按钮。
  static _disabledInfoCode(elVar) {
    return `(function(el){
      function brief(node) {
        if (!node) return '';
        var tag = String(node.tagName || '').toLowerCase();
        var id = node.id ? '#' + node.id : '';
        var cls = String(node.className || '').trim().replace(/\\s+/g, '.');
        return tag + id + (cls ? '.' + cls : '');
      }
      if (!el) return { disabled: false };
      const disabledClassRe = /(?:^|\\s)(?:[a-z]+-)?disabled(?:\\s|$)/i;
      const formControlSel = 'button,input,select,textarea,option,optgroup';
      const componentRootSel = [
        '.el-select', '.ivu-select', '.ant-select', '.v-select', '.vs__dropdown-toggle', '[role="combobox"]',
        '.el-button', '.ivu-btn', '.ant-btn', '[role="button"]',
        '.el-radio', '.ivu-radio-wrapper', '.ant-radio-wrapper',
        '.el-checkbox', '.ivu-checkbox-wrapper', '.ant-checkbox-wrapper',
        '.el-input', '.ivu-input-wrapper', '.ant-input-affix-wrapper',
        '.el-cascader', '.ivu-cascader', '.ant-cascader', '.ant-cascader-picker',
        '.el-switch', '.ivu-switch', '.ant-switch',
        '.el-slider', '.ivu-slider', '.ant-slider',
        '.el-date-editor', '.ivu-date-picker', '.ant-picker',
        '.el-input-number', '.ivu-input-number', '.ant-input-number',
        '.el-autocomplete', '.el-upload',
        '.t-select', '.t-button', '.t-radio', '.t-checkbox', '.t-switch',
        '.arco-select', '.arco-btn', '.arco-radio', '.arco-checkbox', '.arco-switch',
        '.n-select', '.n-button', '.n-radio', '.n-checkbox', '.n-switch',
        '.MuiButton-root', '.MuiSelect-root', '.MuiInputBase-root', '.MuiSwitch-root'
      ].join(',');
      if (el.disabled || (el.getAttribute && el.getAttribute('disabled') !== null)) {
        return { disabled: true, reason: 'native-disabled', by: brief(el) };
      }
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') {
        return { disabled: true, reason: 'aria-disabled', by: brief(el) };
      }
      const ownerControl = el.closest && el.closest(formControlSel);
      if (ownerControl) {
        if (ownerControl.disabled || (ownerControl.getAttribute && ownerControl.getAttribute('disabled') !== null)) {
          return { disabled: true, reason: 'owner-native-disabled', by: brief(ownerControl) };
        }
        if (ownerControl.getAttribute && ownerControl.getAttribute('aria-disabled') === 'true') {
          return { disabled: true, reason: 'owner-aria-disabled', by: brief(ownerControl) };
        }
        const fieldset = ownerControl.closest && ownerControl.closest('fieldset[disabled]');
        if (fieldset) return { disabled: true, reason: 'fieldset-disabled', by: brief(fieldset) };
      }
      let cur = el;
      while (cur && cur !== document.body) {
        if (cur.matches && cur.matches(componentRootSel)) {
          if (cur.disabled || (cur.getAttribute && cur.getAttribute('disabled') !== null)) {
            return { disabled: true, reason: 'component-native-disabled', by: brief(cur) };
          }
          if (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true') {
            return { disabled: true, reason: 'component-aria-disabled', by: brief(cur) };
          }
          if (disabledClassRe.test(String(cur.className || ''))) {
            return { disabled: true, reason: 'component-disabled-class', by: brief(cur) };
          }
        }
        cur = cur.parentElement;
      }
      if (disabledClassRe.test(String(el.className || ''))) {
        return { disabled: true, reason: 'target-disabled-class', by: brief(el) };
      }
      return { disabled: false };
    })(${elVar})`;
  }

  static _isDisabledCode(elVar) {
    return `(${PlayerManager._disabledInfoCode(elVar)}).disabled`;
  }

  /** Ant Design / rc-select 运行时 id，重渲染后失效 */
  static _isVolatileRcCss(sel) {
    return typeof sel === 'string' && /#rc_[a-z0-9_]+_\d+/i.test(sel);
  }

  static _isVolatileRcXPath(xp) {
    return typeof xp === 'string' && /\/\/\*\[@id\s*=\s*['"]rc_[^'"]+['"]\]/.test(xp);
  }

  /** 页面上仅有一个可见的 Ant Select 搜索框时的兜底（兼容旧录制数据） */
  static _antSelectSearchInputFallbackExpr() {
    return `(function(){
      var inputs = Array.from(document.querySelectorAll('input.ant-select-selection-search-input'));
      var vis = inputs.filter(function(e) {
        var r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return vis.length === 1 ? vis[0] : null;
    })()`;
  }

  /**
   * iView RadioGroup：主 CSS/XPath 失效时用 radio-group 容器 + 选项序号兜底（与 player.js 中 findIvuRadioInputFallback 一致）
   */
  static _ivuRadioGroupFallbackExpr(sel, xp) {
    const s = JSON.stringify(sel || '');
    const x = JSON.stringify(xp || '');
    return `(function(){
      try {
        var selector = ${s};
        var xpath = ${x};
        if (selector.indexOf('ivu-radio') < 0 && xpath.indexOf('ivu-radio') < 0 && selector.indexOf('radio-group') < 0) return null;
        var labelIdx = null;
        var mCss = selector.match(/label:nth-of-type\\((\\d+)\\)/);
        if (mCss) labelIdx = parseInt(mCss[1], 10);
        if (labelIdx == null || isNaN(labelIdx)) {
          var re = /\\/label\\[(\\d+)\\]/g;
          var mm;
          var last = null;
          while ((mm = re.exec(xpath)) !== null) { last = mm; }
          if (last) labelIdx = parseInt(last[1], 10);
        }
        if (!labelIdx || labelIdx < 1) return null;
        function pickNth(container) {
          if (!container) return null;
          var inputs = container.querySelectorAll('input.ivu-radio-input, .ivu-radio-wrapper input[type="radio"], label.ivu-radio-wrapper input[type="radio"]');
          if (inputs.length >= labelIdx) return inputs[labelIdx - 1];
          return null;
        }
        var pos = selector.lastIndexOf('> label');
        var stripped = pos < 0 ? '' : selector.slice(0, pos).trim();
        var candidates = [];
        if (stripped) candidates.push(stripped);
        var mFormItem = selector.match(/(div\\.ivu-form-item[\\w.-]*:nth-of-type\\(\\d+\\))/);
        if (mFormItem) {
          var base = mFormItem[1];
          candidates.push(base + ' .radio-group');
          candidates.push(base + ' .mb-6.radio-group');
          candidates.push(base + ' .ivu-radio-group');
          candidates.push(base + ' [class*="radio-group"]');
        }
        var c;
        for (c = 0; c < candidates.length; c++) {
          try {
            var container = document.querySelector(candidates[c]);
            var el = pickNth(container);
            if (el) return el;
          } catch (e1) {}
        }
        var mForm = xpath.match(/\\/form\\[(\\d+)\\]/i);
        var formIdx = mForm ? parseInt(mForm[1], 10) : 1;
        var forms = document.querySelectorAll('form');
        var form = forms[formIdx - 1];
        if (form) {
          var mItem = selector.match(/ivu-form-item[^>]*:nth-of-type\\((\\d+)\\)/);
          var itemN = mItem ? parseInt(mItem[1], 10) : null;
          if (itemN != null && !isNaN(itemN)) {
            var items = form.querySelectorAll('.ivu-form-item');
            var itemEl = items[itemN - 1];
            if (itemEl) {
              var rg = itemEl.querySelector('.radio-group, .mb-6.radio-group, .ivu-radio-group, [class*="radio-group"]');
              var el2 = pickNth(rg || itemEl);
              if (el2) return el2;
            }
          }
        }
        return null;
      } catch (e2) { return null; }
    })()`;
  }

  /**
   * iView Table 单元格：XPath 含 //tbody|thead/tr[n]/td[m] 时按行列重定位（与 player.js findIvuTableCellFallback 一致）
   */
  static _ivuTableCellFallbackExpr(safeXp, locatorContextJson = 'null') {
    const x = JSON.stringify(safeXp || '');
    const ctxJson = locatorContextJson;
    return `(function(){
      try {
        var xp = ${x};
        var ctx = ${ctxJson};
        var wrapM = xp.match(/\\(\\/\\/div\\[contains\\(@class,'ivu-table'\\)\\]\\)\\[(\\d+)\\]/i);
        var m = xp.match(/\\/(tbody|thead)\\/tr\\[(\\d+)\\]\\/(?:td|th)\\[(\\d+)\\]/i);
        if (!m) return null;
        var secName = (m[1] || 'tbody').toLowerCase();
        var trN = parseInt(m[2], 10);
        var tdN = parseInt(m[3], 10);
        if (trN < 1 || tdN < 1) return null;
        var expectedRow = '';
        if (ctx && ctx.table && ctx.table.row_text) {
          expectedRow = String(ctx.table.row_text || '').trim().replace(/\\s+/g, ' ').toLowerCase();
        }
        var wrapOnly = wrapM ? parseInt(wrapM[1], 10) : null;
        var wrappers = [];
        document.querySelectorAll('.ivu-table').forEach(function(w) {
          var t = w.querySelector('table');
          if (t) wrappers.push(t);
        });
        if (!wrappers.length) {
          Array.prototype.forEach.call(document.querySelectorAll('table'), function(t) {
            if (t.closest && t.closest('.ivu-table')) wrappers.push(t);
          });
        }
        function pickInCell(td) {
          if (!td) return null;
          var a = td.querySelector('a.ivu-poptip-rel, .ivu-poptip a, a[href], a');
          if (a) return a;
          var u = td.querySelector('svg use');
          if (u) return u;
          var ic = td.querySelector('[class*="data-source-icon"]');
          if (ic) return ic;
          return td;
        }
        var best = null, bestScore = -1e9, ti, section, tr, td, r, target, score, actual, tokens, hits, tj;
        for (ti = 0; ti < wrappers.length; ti++) {
          if (wrapOnly != null && ti + 1 !== wrapOnly) continue;
          section = secName === 'thead' ? wrappers[ti].querySelector('thead') : wrappers[ti].querySelector('tbody');
          if (!section) continue;
          tr = section.querySelector(':scope > tr:nth-of-type(' + trN + ')');
          if (!tr) continue;
          td = tr.querySelector(':scope > td:nth-of-type(' + tdN + '), :scope > th:nth-of-type(' + tdN + ')');
          if (!td) continue;
          r = td.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) continue;
          target = pickInCell(td);
          if (!target) continue;
          score = 0;
          if (wrapOnly != null) score += 30;
          if (ctx && ctx.table && Number.isInteger(ctx.table.row_index) && ctx.table.row_index === trN - 1) score += 50;
          if (expectedRow) {
            actual = String(tr.innerText || tr.textContent || '').trim().replace(/\\s+/g, ' ').toLowerCase();
            if (actual === expectedRow) score += 90;
            else {
              tokens = expectedRow.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 8);
              hits = tokens.filter(function(t){ return actual.indexOf(t) >= 0; }).length;
              if (hits) score += Math.min(70, hits * 15);
            }
          }
          if (score > bestScore) { bestScore = score; best = target; }
        }
        return best;
      } catch (e) { return null; }
    })()`;
  }

  /**
   * 与 content/player.js 中 pickTopmostDialogMatch 语义一致，供 CDP Runtime.evaluate 内联
   * 解决 querySelector 只取第一个（常为隐藏模板）而弹窗内按钮点不到的问题
   */
  static _modalAwareCssPickExpr(safeSel) {
    const s = JSON.stringify(safeSel || '');
    return `(function(){
      try {
        var sel = ${s};
        var nl = document.querySelectorAll(sel);
        if (!nl || nl.length === 0) return null;
        if (nl.length === 1) return nl[0];
        function vis(el) {
          if (!el) return false;
          var cur = el;
          while (cur) {
            var st = window.getComputedStyle(cur);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
            if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
            cur = cur.parentElement;
          }
          var r = el.getBoundingClientRect();
          return r.width >= 1 || r.height >= 1;
        }
        function inModal(el) {
          return el && el.closest && el.closest(
            '[role="dialog"],[role="alertdialog"],dialog,' +
            '.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,' +
            '.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,' +
            '[class*="modal-wrap"],[class*="Modal__"]'
          );
        }
        function zSum(el) {
          var z = 0, cur = el;
          while (cur && cur !== document.documentElement) {
            var st = window.getComputedStyle(cur);
            if (st.position !== 'static' || cur === el) {
              var zi = parseInt(st.zIndex, 10);
              if (!isNaN(zi) && zi > z) z = zi;
            }
            cur = cur.parentElement;
          }
          return z;
        }
        var arr = Array.prototype.slice.call(nl).filter(vis);
        var pool = arr.length ? arr : Array.prototype.slice.call(nl);
        var dlg = pool.filter(inModal);
        var use = dlg.length ? dlg : pool;
        var scored = use.map(function(n) { return { n: n, z: zSum(n) }; });
        scored.sort(function(a, b) { return b.z - a.z; });
        return scored[0] ? scored[0].n : nl[0];
      } catch (e) { return null; }
    })()`;
  }

  static _contextAwarePickExpr(nodesExpr, ctxJson) {
    return `(function(){
      try {
        var ctx = ${ctxJson || 'null'};
        var rawNodes = ${nodesExpr};
        var nodes = Array.prototype.slice.call(rawNodes || []).filter(function(n){ return n && n.nodeType === 1; });
        if (!nodes.length) return null;
        if (nodes.length === 1 || !ctx) {
          return (${PlayerManager._modalAwareNodeListPickExpr('nodes')});
        }
        function norm(s) { return String(s || '').trim().replace(/\\s+/g, ' '); }
        function vis(el) {
          if (!el) return false;
          var cur = el;
          while (cur) {
            var st = window.getComputedStyle(cur);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
            if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
            cur = cur.parentElement;
          }
          var r = el.getBoundingClientRect();
          return r.width >= 1 || r.height >= 1;
        }
        function controlRoot(el) {
          if (!el || !el.closest) return el; var componentRoot = el.closest('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]'); if (componentRoot) return componentRoot; return el.closest('select,textarea,input,button,a,[role="button"]') || el;
        }
        function controlKind(el) {
          var root = controlRoot(el);
          if (!root) return '';
          var tag = String(root.tagName || '').toLowerCase();
          if (tag === 'select' || (root.getAttribute && root.getAttribute('role') === 'combobox') || (root.matches && root.matches('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle'))) return 'combobox';
          if (tag === 'input') return 'input:' + String(root.type || 'text').toLowerCase();
          if (tag === 'textarea') return 'textarea';
          if (tag === 'button' || (root.getAttribute && root.getAttribute('role') === 'button')) return 'button';
          if (tag === 'a') return 'link';
          return tag;
        }
        function labelText(el) {
          var parts = [];
          function push(v) { var t = norm(v); if (t && parts.indexOf(t) < 0) parts.push(t); }
          try {
            if (el.labels && el.labels.length) Array.prototype.forEach.call(el.labels, function(l){ push(l.textContent); });
            var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
            if (labelledBy) labelledBy.split(/\\s+/).forEach(function(id){ var n = document.getElementById(id); push(n && n.textContent); });
            push(el.getAttribute && el.getAttribute('aria-label'));
            var ownLabel = el.closest && el.closest('label');
            if (ownLabel) push(ownLabel.textContent);
            var formItem = el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,.mapping-row,.map-row,[class*="mapping-row"],[class*="map-row"]');
            var label = formItem && formItem.querySelector('label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"]');
            if (label) push(label.textContent);
          } catch (e) {}
          return parts.join(' | ');
        }
        function containerText(el) {
          try {
            var c = el && el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"],.mapping-row,.map-row,[class*="mapping-row"],[class*="map-row"]');
            return norm((c && (c.innerText || c.textContent)) || '').slice(0, 300);
          } catch (e) { return ''; }
        }
        function siblingIndex(el) {
          var root = controlRoot(el);
          if (!root || !root.parentElement) return -1;
          var kind = controlKind(root);
          var selector = kind === 'combobox'
            ? '.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"],select'
            : String(root.tagName || '').toLowerCase();
          try {
            var direct = Array.prototype.slice.call(root.parentElement.querySelectorAll(':scope > ' + selector));
            var di = direct.indexOf(root);
            if (di >= 0) return di;
          } catch (e1) {}
          try {
            var scope = (root.closest && root.closest('.ant-form,.ivu-form,.el-form,form,[role="form"]')) || root.parentElement;
            var all = Array.prototype.slice.call(scope.querySelectorAll(selector)).filter(vis);
            return all.indexOf(root);
          } catch (e2) { return -1; }
        }
        function score(el) {
          var root = controlRoot(el) || el;
          var out = 0;
          if (vis(root)) out += 100;
          var kind = controlKind(el);
          if (ctx.control_kind && kind === ctx.control_kind) out += 16;
          var expectedLabel = norm(ctx.label_text).toLowerCase();
          if (expectedLabel) {
            var actualLabel = labelText(el).toLowerCase();
            var ctext = containerText(el).toLowerCase();
            if (actualLabel === expectedLabel) out += 80;
            else if (actualLabel && (actualLabel.indexOf(expectedLabel) >= 0 || expectedLabel.indexOf(actualLabel) >= 0)) out += 45;
            if (ctext.indexOf(expectedLabel) >= 0) out += 30;
          }
          var expectedContainer = norm(ctx.container_text).toLowerCase();
          if (expectedContainer) {
            var actualContainer = containerText(el).toLowerCase();
            if (actualContainer === expectedContainer) out += 45;
            else {
              var tokens = expectedContainer.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 10);
              var hits = tokens.filter(function(t){ return actualContainer.indexOf(t) >= 0; }).length;
              if (hits) out += Math.min(35, hits * 7);
            }
          }
          var expectedIndex = Number(ctx.sibling_index);
          if (Number.isInteger(expectedIndex) && expectedIndex >= 0) {
            var actualIndex = siblingIndex(el);
            if (actualIndex === expectedIndex) out += 55;
            else if (actualIndex >= 0) out -= Math.min(24, Math.abs(actualIndex - expectedIndex) * 8);
          }
          if (ctx.table) {
            var row = el.closest && el.closest('tr,.ant-table-row,.el-table__row,.ivu-table-row,[role="row"]');
            if (row && Number.isInteger(ctx.table.row_index)) {
              var sec = row.closest('tbody') || row.closest('thead');
              if (sec) {
                var rows = Array.prototype.slice.call(sec.querySelectorAll(':scope > tr'));
                var ri = rows.indexOf(row);
                if (ri === ctx.table.row_index) out += 85;
                else if (ri >= 0) out -= Math.min(40, Math.abs(ri - ctx.table.row_index) * 12);
              }
            }
            var expectedRow = norm(ctx.table.row_text).toLowerCase();
            if (expectedRow && row) {
              var actualRow = norm(row.innerText || row.textContent).toLowerCase();
              if (actualRow === expectedRow) out += 70;
              else {
                var rtoks = expectedRow.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 8);
                var rh = rtoks.filter(function(t){ return actualRow.indexOf(t) >= 0; }).length;
                if (rh) out += Math.min(50, rh * 12);
              }
            }
          }
          if (ctx.rect && root.getBoundingClientRect) {
            var r = root.getBoundingClientRect();
            var cx = r.left + r.width / 2;
            var cy = r.top + r.height / 2;
            var ecx = Number(ctx.rect.left || 0) + Number(ctx.rect.width || 0) / 2;
            var ecy = Number(ctx.rect.top || 0) + Number(ctx.rect.height || 0) / 2;
            var vw = Number(ctx.rect.viewportWidth || window.innerWidth || 1);
            var vh = Number(ctx.rect.viewportHeight || window.innerHeight || 1);
            var dist = Math.sqrt(Math.pow((cx - ecx) / vw, 2) + Math.pow((cy - ecy) / vh, 2));
            out += Math.max(0, 28 - dist * 80);
          }
          if (Array.isArray(ctx.state_classes) && ctx.state_classes.length) {
            var classSet = {};
            String(el.className || '').split(/\\s+/).filter(Boolean).forEach(function(c){ classSet[c] = true; });
            var rootClassSet = classSet;
            if (root && root !== el) {
              rootClassSet = {};
              String(root.className || '').split(/\\s+/).filter(Boolean).forEach(function(c){ rootClassSet[c] = true; });
            }
            var stateHits = 0;
            ctx.state_classes.forEach(function(c) {
              if (classSet[c] || rootClassSet[c]) stateHits += 1;
            });
            if (stateHits) out += Math.min(12, stateHits * 4);
          }
          return out;
        }
        var scored = nodes.map(function(n, i){ return { n: n, s: score(n), i: i }; });
        scored.sort(function(a, b){ return b.s !== a.s ? b.s - a.s : a.i - b.i; });
        return scored[0] ? scored[0].n : nodes[0];
      } catch (e) { return null; }
    })()`;
  }

  static _modalAwareNodeListPickExpr(listVar) {
    return `(function(){
      var nl = ${listVar};
      if (!nl || nl.length === 0) return null;
      if (nl.length === 1) return nl[0];
      function vis(el) {
        if (!el) return false;
        var cur = el;
        while (cur) {
          var st = window.getComputedStyle(cur);
          if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
          if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
          cur = cur.parentElement;
        }
        var r = el.getBoundingClientRect();
        return r.width >= 1 || r.height >= 1;
      }
      function inModal(el) {
        return el && el.closest && el.closest('[role="dialog"],[role="alertdialog"],dialog,.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,[class*="modal-wrap"],[class*="Modal__"]');
      }
      function zSum(el) {
        var z = 0, cur = el;
        while (cur && cur !== document.documentElement) {
          var st = window.getComputedStyle(cur);
          if (st.position !== 'static' || cur === el) {
            var zi = parseInt(st.zIndex, 10);
            if (!isNaN(zi) && zi > z) z = zi;
          }
          cur = cur.parentElement;
        }
        return z;
      }
      var arr = Array.prototype.slice.call(nl).filter(vis);
      var pool = arr.length ? arr : Array.prototype.slice.call(nl);
      var dlg = pool.filter(inModal);
      var use = dlg.length ? dlg : pool;
      var scored = use.map(function(n) { return { n: n, z: zSum(n) }; });
      scored.sort(function(a, b) { return b.z - a.z; });
      return scored[0] ? scored[0].n : nl[0];
    })()`;
  }

  /**
   * XPath 多匹配时与 player.js 中 findBestXPathMatch 一致（SNAPSHOT + 弹窗优先），
   * 避免 //span[normalize-space()='确定'] 只命中文档第一个隐藏副本
   */
  static _xpathSnapshotPickExpr(safeXp) {
    const xpJson = JSON.stringify(safeXp || '');
    return `(function(){
      try {
        var xp = ${xpJson};
        var res = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        var nodes = [];
        for (var i = 0; i < res.snapshotLength; i++) {
          var n = res.snapshotItem(i);
          if (n && n.nodeType === 1) nodes.push(n);
        }
        if (nodes.length === 0) return null;
        if (nodes.length === 1) return nodes[0];
        function vis(el) {
          if (!el) return false;
          var cur = el;
          while (cur) {
            var st = window.getComputedStyle(cur);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
            if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
            cur = cur.parentElement;
          }
          var r = el.getBoundingClientRect();
          return r.width >= 1 || r.height >= 1;
        }
        function inModal(el) {
          return el && el.closest && el.closest(
            '[role="dialog"],[role="alertdialog"],dialog,' +
            '.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,' +
            '.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,' +
            '[class*="modal-wrap"],[class*="Modal__"]'
          );
        }
        function zSum(el) {
          var z = 0, cur = el;
          while (cur && cur !== document.documentElement) {
            var st = window.getComputedStyle(cur);
            if (st.position !== 'static' || cur === el) {
              var zi = parseInt(st.zIndex, 10);
              if (!isNaN(zi) && zi > z) z = zi;
            }
            cur = cur.parentElement;
          }
          return z;
        }
        var arr = nodes.filter(vis);
        var pool = arr.length ? arr : nodes;
        var dlg = pool.filter(inModal);
        var use = dlg.length ? dlg : pool;
        var scored = use.map(function(n) { return { n: n, z: zSum(n) }; });
        scored.sort(function(a, b) { return b.z - a.z; });
        return scored[0] ? scored[0].n : nodes[0];
      } catch (e) { return null; }
    })()`;
  }

  static _xpathSnapshotNodesExpr(safeXp) {
    const xpJson = JSON.stringify(safeXp || '');
    return `(function(){
      try {
        var xp = ${xpJson};
        var res = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        var nodes = [];
        for (var i = 0; i < res.snapshotLength; i++) {
          var n = res.snapshotItem(i);
          if (n && n.nodeType === 1) nodes.push(n);
        }
        return nodes;
      } catch (e) { return []; }
    })()`;
  }

  static _normalizeLocatorMetaCandidates(locatorMeta) {
    if (locatorMeta == null || locatorMeta === '') return [];
    let meta = locatorMeta;
    if (typeof meta === 'string') {
      try {
        meta = JSON.parse(meta);
      } catch {
        return [];
      }
    }
    if (!meta || typeof meta !== 'object') return [];
    const raw = Array.isArray(meta.candidates) ? meta.candidates : [];
    const list = raw
      .map((c) => ({
        type: String(c?.type || ''),
        value: String(c?.value || ''),
        score: Number(c?.score || 0),
      }))
      .filter((c) => c.type && c.value);
    list.sort((a, b) => b.score - a.score);
    return list.slice(0, 16);
  }

  static _parseLocatorMetaObject(locatorMeta) {
    if (locatorMeta == null || locatorMeta === '') return null;
    if (typeof locatorMeta === 'object') return locatorMeta;
    if (typeof locatorMeta !== 'string') return null;
    try {
      const parsed = JSON.parse(locatorMeta);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  static _getTreeInteractionConfig(locatorMeta) {
    const meta = PlayerManager._parseLocatorMetaObject(locatorMeta);
    const candidates = Array.isArray(meta?.candidates) ? meta.candidates : [];
    for (const c of candidates) {
      if (String(c?.type || '') !== 'tree_interaction') continue;
      try {
        const cfg = typeof c.value === 'string' ? JSON.parse(c.value) : c.value;
        if (cfg && typeof cfg === 'object') return cfg;
      } catch {
        return null;
      }
    }
    const ctxCfg = meta?.context?.tree_interaction;
    return ctxCfg && typeof ctxCfg === 'object' ? ctxCfg : null;
  }

  static _treeInteractionDiagnosticExpr(locatorMeta) {
    const cfg = PlayerManager._getTreeInteractionConfig(locatorMeta);
    if (!cfg) return 'null';
    const framework = String(cfg.framework || '').trim().toLowerCase();
    const kind = String(cfg.kind || '').trim().toLowerCase();
    const title = String(cfg.title || '').trim().replace(/\s+/g, ' ');
    if (!framework || !kind || !title) return 'null';
    const parentPath = Array.isArray(cfg.parentPath)
      ? cfg.parentPath.map((x) => String(x || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
      : [];
    const level = Number.isFinite(Number(cfg.level)) ? Math.max(0, Number(cfg.level)) : null;
    const actionIndex = Math.max(0, Number(cfg.actionIndex || 0));
    return `(function(){
      try {
        var framework = ${JSON.stringify(framework)};
        var kind = ${JSON.stringify(kind)};
        var title = ${JSON.stringify(title)};
        var expectedParentPath = ${JSON.stringify(parentPath)};
        var expectedLevel = ${level === null ? 'null' : JSON.stringify(level)};
        var actionIndex = ${Number.isFinite(actionIndex) ? actionIndex : 0};
        function norm(s) { return String(s || '').trim().replace(/\\s+/g, ' '); }
        function visibleTitle(node) {
          if (!node) return '';
          try {
            var clone = node.cloneNode(true);
            clone.querySelectorAll('.tree-node-actions,.action-icon-wrapper,.data-source-icon,[class*="action"],button,svg').forEach(function(n){ n.remove(); });
            return norm(clone.textContent || '').slice(0, 120);
          } catch (e) { return norm(node.textContent || '').slice(0, 120); }
        }
        function leftOf(node) {
          try {
            var r = node && node.getBoundingClientRect && node.getBoundingClientRect();
            return r && (r.width > 0 || r.height > 0) ? r.left : 0;
          } catch (e) { return 0; }
        }
        function ariaLevel(node) {
          var cur = node;
          while (cur && cur.nodeType === 1) {
            var raw = cur.getAttribute && (cur.getAttribute('aria-level') || cur.getAttribute('data-level'));
            var n = Number(raw);
            if (Number.isFinite(n) && n > 0) return Math.max(0, n - 1);
            cur = cur.parentElement;
          }
          return -1;
        }
        function collect(nodes, titleFn, anchorFn) {
          var raw = [];
          var leftBuckets = [];
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var t = titleFn(node);
            if (!t) continue;
            var anchor = anchorFn(node) || node;
            var item = { node: node, title: t, ariaLevel: ariaLevel(node), left: leftOf(anchor) };
            raw.push(item);
            if (item.ariaLevel < 0) {
              var exists = false;
              for (var b = 0; b < leftBuckets.length; b++) {
                if (Math.abs(leftBuckets[b] - item.left) <= 6) { exists = true; break; }
              }
              if (!exists) leftBuckets.push(item.left);
            }
          }
          leftBuckets.sort(function(a, b){ return a - b; });
          var stack = [];
          return raw.map(function(item) {
            var level = item.ariaLevel >= 0 ? item.ariaLevel : Math.max(0, leftBuckets.findIndex(function(left){ return Math.abs(left - item.left) <= 6; }));
            if (level < 0) level = 0;
            stack[level] = item.title;
            stack.length = level + 1;
            item.level = level;
            item.parentPath = stack.slice(0, level);
            return item;
          });
        }
        function samePath(a, b) {
          if (!a.length) return true;
          if (!b || a.length !== b.length) return false;
          for (var i = 0; i < a.length; i++) if (norm(a[i]) !== norm(b[i])) return false;
          return true;
        }
        function targetOf(node) {
          if (!node) return null;
          if (framework === 'ant-tree') {
            if (kind === 'expand_toggle') return node.querySelector && node.querySelector('.ant-tree-switcher');
            if (kind === 'node_content') return node.querySelector && node.querySelector('.ant-tree-node-content-wrapper, .ant-tree-title') || node;
            if (kind === 'node_action') {
              var hosts = node.querySelectorAll('.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"]');
              if (!hosts || !hosts.length) hosts = node.querySelectorAll('.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"]');
              return hosts && hosts.length ? (hosts[actionIndex] || hosts[0]) : null;
            }
          }
          if (framework === 'vtree') {
            if (kind === 'expand_toggle') return node.querySelector && node.querySelector('.vtree-tree-node__square.vtree-tree-node__expand');
            if (kind === 'node_content') return node.querySelector && node.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || node;
          }
          return null;
        }
        var nodes = [];
        var items = [];
        if (framework === 'ant-tree') {
          nodes = Array.prototype.slice.call(document.querySelectorAll('.ant-tree-treenode'));
          if (!nodes.length) nodes = Array.prototype.slice.call(document.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
          items = collect(nodes, function(node){ return visibleTitle(node.querySelector && node.querySelector('.ant-tree-title') || node); }, function(node){ return node.querySelector && node.querySelector('.ant-tree-node-content-wrapper') || node; });
        } else if (framework === 'vtree') {
          nodes = Array.prototype.slice.call(document.querySelectorAll('.vtree-tree-node__indent-wrapper'));
          items = collect(nodes, function(node){ return visibleTitle(node.querySelector && (node.querySelector('.vtree-tree-node__title .node') || node.querySelector('.vtree-tree-node__title') || node.querySelector('.node')) || node); }, function(node){ return node.querySelector && node.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || node; });
        }
        var sameTitle = items.filter(function(item){ return item.title === title; });
        var pathMatched = sameTitle.filter(function(item){ return samePath(expectedParentPath, item.parentPath || []); });
        var levelMatched = pathMatched.filter(function(item){ return expectedLevel === null || item.level === expectedLevel; });
        var targetPool = levelMatched.length ? levelMatched : pathMatched.length ? pathMatched : sameTitle;
        var withTarget = targetPool.filter(function(item){ return !!targetOf(item.node); });
        return {
          framework: framework,
          kind: kind,
          title: title,
          expectedParentPath: expectedParentPath,
          expectedLevel: expectedLevel,
          treeNodeCount: items.length,
          sameTitleCount: sameTitle.length,
          pathMatchedCount: pathMatched.length,
          levelMatchedCount: levelMatched.length,
          targetMatchedCount: withTarget.length
        };
      } catch (e) {
        return { framework: ${JSON.stringify(framework)}, kind: ${JSON.stringify(kind)}, title: ${JSON.stringify(title)}, error: String(e && e.message || e) };
      }
    })()`;
  }

  static _randomAlphaNum(len = 8) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    try {
      if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
      } else {
        for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
    } catch {
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  static _randomDigits(len = 3) {
    const width = Math.max(1, Math.min(128, Number(len || 3) || 3));
    let out = '';
    for (let i = 0; i < width; i++) out += String(Math.floor(Math.random() * 10));
    return out;
  }

  static _pad2(value) {
    return String(value).padStart(2, '0');
  }

  static _formatTemplateDate(format, date = new Date()) {
    const yyyy = String(date.getFullYear());
    const yy = yyyy.slice(-2);
    const MM = PlayerManager._pad2(date.getMonth() + 1);
    const DD = PlayerManager._pad2(date.getDate());
    const HH = PlayerManager._pad2(date.getHours());
    const mm = PlayerManager._pad2(date.getMinutes());
    const ss = PlayerManager._pad2(date.getSeconds());
    return String(format || 'YYYYMMDD')
      .replace(/YYYY/g, yyyy)
      .replace(/YY/g, yy)
      .replace(/MM/g, MM)
      .replace(/DD/g, DD)
      .replace(/HH/g, HH)
      .replace(/mm/g, mm)
      .replace(/ss/g, ss);
  }

  static _dynamicTemplatePartValue(part) {
    const type = String(part?.type || '').trim();
    if (type === 'fixed') return String(part?.value ?? '');
    if (type === 'date') return PlayerManager._formatTemplateDate(part?.format || 'YYYYMMDD');
    if (type === 'random_number') return PlayerManager._randomDigits(part?.length || 3);
    if (type === 'random_string') {
      const width = Math.max(1, Math.min(1024, Number(part?.length || 8) || 8));
      return PlayerManager._randomAlphaNum(width);
    }
    if (type === 'timestamp') return String(Date.now());
    return '';
  }

  static _dynamicValueFromGeneration(gen, fallback = '') {
    const mode = String(gen?.mode || 'fixed').trim();
    if (mode === 'template') {
      const parts = Array.isArray(gen?.parts) ? gen.parts : [];
      const value = parts.map((part) => PlayerManager._dynamicTemplatePartValue(part)).join('');
      return value || fallback;
    }
    const prefix = String(gen?.prefix ?? fallback ?? '');
    const hardMax = mode === 'random_string' ? 1024 : 128;
    const minWidth = Math.max(1, Math.min(hardMax, Number(gen?.min_length || (mode === 'random_number' ? 1 : 8)) || (mode === 'random_number' ? 1 : 8)));
    const maxWidth = Math.max(minWidth, Math.min(hardMax, Number(gen?.max_length || (mode === 'random_number' ? 5 : 128)) || (mode === 'random_number' ? 5 : 128)));
    const width = minWidth === maxWidth
      ? minWidth
      : (Math.floor(Math.random() * (maxWidth - minWidth + 1)) + minWidth);
    if (!mode || mode === 'fixed') return fallback;
    if (mode === 'timestamp') return String(Date.now());
    if (mode === 'random_string') return PlayerManager._randomAlphaNum(width);
    if (mode === 'random_number') {
      return PlayerManager._randomDigits(width);
    }
    if (mode === 'prefix_timestamp') return `${prefix}${Date.now()}`;
    return fallback;
  }

  static _resolveDynamicStepValue(step) {
    if (!step || typeof step !== 'object') return step;
    const actionType = String(step.action_type || '').trim().toLowerCase();
    if (actionType !== 'input') return step;
    const meta = PlayerManager._parseLocatorMetaObject(step.locator_meta);
    const gen = meta?.value_generation;
    if (!gen || typeof gen !== 'object') return step;
    const mode = String(gen.mode || 'fixed').trim();
    if (!mode || mode === 'fixed') return step;
    return {
      ...step,
      value: PlayerManager._dynamicValueFromGeneration(gen, step.value ?? ''),
    };
  }

  static _extractRevealTriggerFromLocatorMeta(locatorMeta) {
    const meta = PlayerManager._parseLocatorMetaObject(locatorMeta);
    const reveal = meta?.context?.reveal;
    if (!reveal || typeof reveal !== 'object') return null;
    const trigger = reveal.trigger && typeof reveal.trigger === 'object' ? reveal.trigger : null;
    if (!trigger) return null;
    const action = String(trigger.action || 'hover').trim().toLowerCase();
    const target_selector = String(trigger.target_selector || '').trim();
    const target_xpath = String(trigger.target_xpath || '').trim();
    const triggerLocatorMeta = trigger.locator_meta ?? null;
    if (!target_selector && !target_xpath && !triggerLocatorMeta) return null;
    const wait = Number.isFinite(Number(reveal.max_wait_ms))
      ? Math.max(500, Math.min(10000, Number(reveal.max_wait_ms)))
      : 2200;
    return {
      action,
      target_selector,
      target_xpath,
      locator_meta: triggerLocatorMeta,
      max_wait_ms: wait,
    };
  }

  static _textExactTagPickExpr(rawValue) {
    const s = String(rawValue || '');
    const idx = s.indexOf('::');
    if (idx <= 0) return 'null';
    const tag = s.slice(0, idx).trim().toLowerCase();
    const text = s.slice(idx + 2).trim().replace(/\s+/g, ' ');
    if (!tag || !text) return 'null';
    return `(function(){
      try {
        var selector = ${JSON.stringify(tag)};
        var normalized = ${JSON.stringify(text)};
        var nodes = document.querySelectorAll(selector);
        var matched = [];
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var raw = (el.textContent || '').trim().replace(/\\s+/g, ' ');
          if (raw === normalized) matched.push(el);
        }
        if (matched.length === 0) return null;
        if (matched.length === 1) return matched[0];
        function vis(el) {
          if (!el) return false;
          var cur = el;
          while (cur) {
            var st = window.getComputedStyle(cur);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
            if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
            cur = cur.parentElement;
          }
          var r = el.getBoundingClientRect();
          return r.width >= 1 || r.height >= 1;
        }
        function inModal(el) {
          return el && el.closest && el.closest(
            '[role="dialog"],[role="alertdialog"],dialog,' +
            '.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,' +
            '.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,' +
            '[class*="modal-wrap"],[class*="Modal__"]'
          );
        }
        function zSum(el) {
          var z = 0, cur = el;
          while (cur && cur !== document.documentElement) {
            var st = window.getComputedStyle(cur);
            if (st.position !== 'static' || cur === el) {
              var zi = parseInt(st.zIndex, 10);
              if (!isNaN(zi) && zi > z) z = zi;
            }
            cur = cur.parentElement;
          }
          return z;
        }
        var arr = matched.filter(vis);
        var pool = arr.length ? arr : matched;
        var dlg = pool.filter(inModal);
        var use = dlg.length ? dlg : pool;
        var scored = use.map(function(n) { return { n: n, z: zSum(n) }; });
        scored.sort(function(a, b) { return b.z - a.z; });
        return scored[0] ? scored[0].n : matched[0];
      } catch (e) { return null; }
    })()`;
  }

  static _treeNodeTextPickExpr(rawValue) {
    let cfg = null;
    try { cfg = JSON.parse(String(rawValue || '')); } catch { cfg = null; }
    if (!cfg || typeof cfg !== 'object') return 'null';
    const title = String(cfg.title || '').trim().replace(/\s+/g, ' ');
    if (!title) return 'null';
    const sameTitleIndex = Math.max(0, Number(cfg.sameTitleIndex || 0));
    return `(function(){
      try {
        var title = ${JSON.stringify(title)};
        var sameTitleIndex = ${Number.isFinite(sameTitleIndex) ? sameTitleIndex : 0};
        function norm(s) { return String(s || '').trim().replace(/\\s+/g, ' '); }
        function titleOf(node) {
          var titleEl = node.querySelector && node.querySelector('.node,.el-tree-node__label,.ivu-tree-title,.arco-tree-node-title,.n-tree-node-content__text') || node;
          try {
            var clone = titleEl.cloneNode(true);
            clone.querySelectorAll('.tree-node-actions,.action-icon-wrapper,.data-source-icon,[class*="action"],button,svg').forEach(function(n){ n.remove(); });
            return norm(clone.textContent || '').slice(0, 120);
          } catch (e) {
            return norm(titleEl.textContent || '').slice(0, 120);
          }
        }
        var nodes = Array.prototype.slice.call(document.querySelectorAll('.el-tree-node__content,.ivu-tree-title,.arco-tree-node-title,.n-tree-node-content,[role="treeitem"]'));
        var matched = [];
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (titleOf(node) === title) matched.push(node);
        }
        return matched[sameTitleIndex] || matched[0] || null;
      } catch (e) { return null; }
    })()`;
  }

  static _treeInteractionPickExpr(rawValue) {
    let cfg = null;
    try { cfg = JSON.parse(String(rawValue || '')); } catch { cfg = null; }
    if (!cfg || typeof cfg !== 'object') return 'null';
    const framework = String(cfg.framework || '').trim().toLowerCase();
    const kind = String(cfg.kind || '').trim().toLowerCase();
    const title = String(cfg.title || '').trim().replace(/\s+/g, ' ');
    if (!framework || !kind || !title) return 'null';
    const sameTitleIndex = Math.max(0, Number(cfg.sameTitleIndex || 0));
    const actionIndex = Math.max(0, Number(cfg.actionIndex || 0));
    const parentPath = Array.isArray(cfg.parentPath)
      ? cfg.parentPath.map((x) => String(x || '').trim().replace(/\s+/g, ' ')).filter(Boolean)
      : [];
    const level = Number.isFinite(Number(cfg.level)) ? Math.max(0, Number(cfg.level)) : null;
    return `(function(){
      try {
        var framework = ${JSON.stringify(framework)};
        var kind = ${JSON.stringify(kind)};
        var title = ${JSON.stringify(title)};
        var sameTitleIndex = ${Number.isFinite(sameTitleIndex) ? sameTitleIndex : 0};
        var actionIndex = ${Number.isFinite(actionIndex) ? actionIndex : 0};
        var expectedParentPath = ${JSON.stringify(parentPath)};
        var expectedLevel = ${level === null ? 'null' : JSON.stringify(level)};
        function norm(s) { return String(s || '').trim().replace(/\\s+/g, ' '); }
        function visibleTitle(node) {
          if (!node) return '';
          try {
            var clone = node.cloneNode(true);
            clone.querySelectorAll('.tree-node-actions,.action-icon-wrapper,.data-source-icon,[class*="action"],button,svg').forEach(function(n){ n.remove(); });
            return norm(clone.textContent || '').slice(0, 120);
          } catch (e) {
            return norm(node.textContent || '').slice(0, 120);
          }
        }
        function leftOf(node) {
          try {
            var r = node && node.getBoundingClientRect && node.getBoundingClientRect();
            return r && (r.width > 0 || r.height > 0) ? r.left : 0;
          } catch (e) { return 0; }
        }
        function ariaLevel(node) {
          var cur = node;
          while (cur && cur.nodeType === 1) {
            var raw = cur.getAttribute && (cur.getAttribute('aria-level') || cur.getAttribute('data-level'));
            var n = Number(raw);
            if (Number.isFinite(n) && n > 0) return Math.max(0, n - 1);
            cur = cur.parentElement;
          }
          return -1;
        }
        function collect(nodes, titleFn, anchorFn) {
          var raw = [];
          var leftBuckets = [];
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var t = titleFn(node);
            if (!t) continue;
            var anchor = anchorFn(node) || node;
            var item = { node: node, order: i, title: t, ariaLevel: ariaLevel(node), left: leftOf(anchor) };
            raw.push(item);
            if (item.ariaLevel < 0) {
              var exists = false;
              for (var b = 0; b < leftBuckets.length; b++) {
                if (Math.abs(leftBuckets[b] - item.left) <= 6) { exists = true; break; }
              }
              if (!exists) leftBuckets.push(item.left);
            }
          }
          leftBuckets.sort(function(a, b){ return a - b; });
          var stack = [];
          return raw.map(function(item) {
            var level = item.ariaLevel >= 0 ? item.ariaLevel : Math.max(0, leftBuckets.findIndex(function(left){ return Math.abs(left - item.left) <= 6; }));
            if (level < 0) level = 0;
            stack[level] = item.title;
            stack.length = level + 1;
            item.level = level;
            item.parentPath = stack.slice(0, level);
            return item;
          });
        }
        function pathSame(a, b) {
          if (!a || !b || a.length !== b.length) return false;
          for (var i = 0; i < a.length; i++) if (norm(a[i]) !== norm(b[i])) return false;
          return true;
        }
        function pickBest(items) {
          var scored = [];
          var sameTitleOrd = 0;
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.title !== title) continue;
            var ord = sameTitleOrd++;
            var score = 1000;
            if (expectedParentPath.length) {
              if (pathSame(expectedParentPath, item.parentPath || [])) {
                score += 260;
              } else {
                var et = expectedParentPath.slice(-2).join('/');
                var at = (item.parentPath || []).slice(-2).join('/');
                if (et && et === at) score += 110;
                score -= Math.min(180, Math.abs(expectedParentPath.length - (item.parentPath || []).length) * 45);
              }
            }
            if (expectedLevel !== null) {
              if (item.level === expectedLevel) score += 120;
              else score -= Math.min(160, Math.abs(item.level - expectedLevel) * 55);
            }
            if (ord === sameTitleIndex) score += 45;
            else score -= Math.min(80, Math.abs(ord - sameTitleIndex) * 18);
            scored.push({ item: item, score: score, ord: ord });
          }
          scored.sort(function(a, b){ return (b.score - a.score) || (a.ord - b.ord); });
          return scored[0] && scored[0].item && scored[0].item.node || null;
        }
        if (framework === 'ant-tree') {
          var antNodes = Array.prototype.slice.call(document.querySelectorAll('.ant-tree-treenode'));
          if (!antNodes.length) antNodes = Array.prototype.slice.call(document.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
          var antItems = collect(
            antNodes,
            function(node){ return visibleTitle(node.querySelector && node.querySelector('.ant-tree-title') || node); },
            function(node){ return node.querySelector && node.querySelector('.ant-tree-node-content-wrapper') || node; }
          );
          var antNode = pickBest(antItems);
          if (!antNode) return null;
          if (kind === 'expand_toggle') return antNode.querySelector && antNode.querySelector('.ant-tree-switcher');
          if (kind === 'node_content') return antNode.querySelector && antNode.querySelector('.ant-tree-node-content-wrapper, .ant-tree-title') || antNode;
          if (kind !== 'node_action') return null;
          var hosts = antNode.querySelectorAll('.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"]');
          if (!hosts || !hosts.length) {
            hosts = antNode.querySelectorAll('.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"]');
          }
          if (hosts && hosts.length) return hosts[actionIndex] || hosts[0];
          return null;
        }
        if (framework === 'vtree') {
          var nodes = Array.prototype.slice.call(document.querySelectorAll('.vtree-tree-node__indent-wrapper'));
          var items = collect(
            nodes,
            function(node){ return visibleTitle(node.querySelector && (node.querySelector('.vtree-tree-node__title .node') || node.querySelector('.vtree-tree-node__title') || node.querySelector('.node')) || node); },
            function(node){ return node.querySelector && node.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || node; }
          );
          var targetNode = pickBest(items);
          if (!targetNode) return null;
          if (kind === 'expand_toggle') return targetNode.querySelector('.vtree-tree-node__square.vtree-tree-node__expand');
          if (kind === 'node_content') return targetNode.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || targetNode;
        }
        return null;
      } catch (e) { return null; }
    })()`;
  }

  // 滚动元素到视口中央并返回视口内坐标。
  // structured=true 时返回 actionability 状态，便于区分 not_found/disabled/hidden/covered。
  _buildFindCode(sel, xp, text, skipDisabledCheck = false, locatorMeta = null, structured = false) {
    const disabledGuard = (via) => skipDisabledCheck
      ? ''
      : `const disabledInfo = ${PlayerManager._disabledInfoCode('el')};
        if (disabledInfo && disabledInfo.disabled) {
          return ${structured ? `{ ok: false, reason: 'disabled', disabled: disabledInfo, via: '${via}' }` : 'null'};
        }`;

    const wrap = (findExpr, via) => `(function(){
      try {
        const el = ${findExpr};
        if (!el) return null;
        ${disabledGuard(via)}
        let target = el;
        if (target.matches && target.matches('.ivu-select,.ant-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]')) {
          const inner = target.querySelector('.ivu-select-selection,.ant-select-selector,.el-input,.el-select__wrapper,.vs__dropdown-toggle,[role="textbox"],input');
          if (inner) {
            const ir = inner.getBoundingClientRect();
            if (ir.width > 0 || ir.height > 0) target = inner;
          }
        }
        let r = target.getBoundingClientRect();
        const vtreeExpandToggle = target.closest && target.closest('.vtree-tree-node__square.vtree-tree-node__expand');
        if (vtreeExpandToggle) {
          const vr = vtreeExpandToggle.getBoundingClientRect();
          if (vr.width > 0 || vr.height > 0) { target = vtreeExpandToggle; r = vr; }
        }
        if (r.width === 0 && r.height === 0 && el.tagName === 'INPUT') {
          const typ = (el.type || '').toLowerCase();
          if (typ === 'radio' || typ === 'checkbox') {
            const w = el.closest('.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, label, .ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox');
            if (w) {
              const r2 = w.getBoundingClientRect();
              if (r2.width > 0 || r2.height > 0) { target = w; r = r2; }
            }
          }
        }
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        r = target.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return ${structured ? `{ ok: false, reason: 'hidden', via: '${via}' }` : 'null'};
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        let hitOk = false;
        let hitBrief = '';
        if (hit && hit.nodeType === 1) {
          hitBrief = String(hit.tagName || '').toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className ? '.' + String(hit.className).trim().replace(/\\s+/g, '.') : '');
          let cur = hit;
          while (cur) {
            if (cur === target) { hitOk = true; break; }
            cur = cur.parentElement;
          }
          if (!hitOk && typeof hit.contains === 'function' && hit.contains(target)) {
            hitOk = true;
          }
          if (!hitOk) {
            try {
              const lab = typeof hit.closest === 'function' ? hit.closest('label') : null;
              if (lab && lab.control === target) hitOk = true;
            } catch (e2) {}
          }
        }
        return { ok: true, x: cx, y: cy, via: '${via}', hitOk: hitOk, hit: hitBrief };
      } catch(e) {
        return ${structured ? `{ ok: false, reason: 'lookup_error', message: String(e && e.message || e), via: '${via}' }` : 'null'};
      }
    })()`;

    const hadVolatileRc = PlayerManager._isVolatileRcCss(sel) || PlayerManager._isVolatileRcXPath(xp || '');

    // 过滤非法 CSS 选择器（如 :nth-of-type(0) 是无效的，会抛异常）
    let safeSel = sel && !/:\w+-of-type\(0\)/.test(sel) ? sel : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';

    let safeXp = xp || '';
    if (PlayerManager._isVolatileRcXPath(safeXp)) safeXp = '';

    if (safeXp && !safeXp.startsWith('//') && !safeXp.startsWith('/html') && !safeXp.startsWith('/*')) {
      safeXp = '/' + safeXp;
    }

    // 易变 rc id 不要用「先试 #id」策略；稳定 #id 才优先 CSS
    const cssIsStableId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(sel)
    );

    const cssFindOne = safeSel
      ? (cssIsStableId
        ? `document.querySelector(${JSON.stringify(safeSel)})`
        : PlayerManager._contextAwarePickExpr(
          `document.querySelectorAll(${JSON.stringify(safeSel)})`,
          JSON.stringify(PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null),
        ))
      : null;
    const cssExpr = cssFindOne ? wrap(cssFindOne, 'css') : null;
    const locatorContextJson = JSON.stringify(PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null);
    const xpathExpr = safeXp ? wrap(
      PlayerManager._contextAwarePickExpr(PlayerManager._xpathSnapshotNodesExpr(safeXp), locatorContextJson),
      'xpath',
    ) : null;
    const parts = [];
    const metaParts = [];
    const metaCandidates = PlayerManager._normalizeLocatorMetaCandidates(locatorMeta);
    const seenMeta = new Set();
    for (const c of metaCandidates) {
      const type = String(c.type || '');
      const value = String(c.value || '').trim();
      if (!type || !value) continue;
      const uniqKey = `${type}::${value}`;
      if (seenMeta.has(uniqKey)) continue;
      seenMeta.add(uniqKey);

      if (type.startsWith('css_') || type.startsWith('component_root_') || type === 'table_cell_css') {
        if (/:\w+-of-type\(0\)/.test(value)) continue;
        if (PlayerManager._isVolatileRcCss(value)) continue;
        const isStableId = /^#[\w-]+$/.test(value) && !PlayerManager._isVolatileRcCss(value);
        const findExpr = isStableId
          ? `document.querySelector(${JSON.stringify(value)})`
          : PlayerManager._contextAwarePickExpr(
            `document.querySelectorAll(${JSON.stringify(value)})`,
            locatorContextJson,
          );
        metaParts.push(wrap(findExpr, `meta-${type}`));
        continue;
      }

      if (type === 'table_cell_xpath' || type === 'xpath_fallback') {
        if (PlayerManager._isVolatileRcXPath(value)) continue;
        let safeMetaXp = value;
        if (!safeMetaXp.startsWith('//') && !safeMetaXp.startsWith('/html') && !safeMetaXp.startsWith('/*')) {
          safeMetaXp = `/${safeMetaXp}`;
        }
        metaParts.push(wrap(
          PlayerManager._contextAwarePickExpr(PlayerManager._xpathSnapshotNodesExpr(safeMetaXp), locatorContextJson),
          'meta-xpath',
        ));
        continue;
      }

      if (type === 'text_exact' && !skipDisabledCheck) {
        metaParts.push(wrap(
          `(function(){const t=${JSON.stringify(value.trim().replace(/\s+/g, ' '))};` +
          `for(const e of document.querySelectorAll('li,option,[role="option"],[role="menuitem"],button,a,label,span,div'))` +
          `{if((e.textContent||'').trim().replace(/\\s+/g,' ')===t)return e;}return null;})()`,
          'meta-text'
        ));
        continue;
      }

      if (type === 'text_exact_tag' && !skipDisabledCheck) {
        const expr = PlayerManager._textExactTagPickExpr(value);
        if (expr !== 'null') metaParts.push(wrap(expr, 'meta-text-tag'));
        continue;
      }

      if (type === 'tree_interaction') {
        const expr = PlayerManager._treeInteractionPickExpr(value);
        if (expr !== 'null') metaParts.push(wrap(expr, 'meta-tree-interaction'));
        continue;
      }

      if (type === 'tree_node_text') {
        const expr = PlayerManager._treeNodeTextPickExpr(value);
        if (expr !== 'null') metaParts.push(wrap(expr, 'meta-tree-node-text'));
      }
    }
    if (metaParts.length) parts.push(...metaParts);
    if (cssIsStableId && cssExpr) parts.push(cssExpr);
    if (xpathExpr) parts.push(xpathExpr);
    if (!cssIsStableId && cssExpr) parts.push(cssExpr);
    if (text && !skipDisabledCheck) {
      parts.push(wrap(
        `(function(){const t=${JSON.stringify(text)};` +
        `for(const e of document.querySelectorAll('li,option,[role="option"],[role="menuitem"]'))` +
        `{if(e.textContent.trim().replace(/\\s+/g,' ')===t)return e;}return null;})()`,
        'text'
      ));
    }
    if (hadVolatileRc) {
      parts.push(wrap(PlayerManager._antSelectSearchInputFallbackExpr(), 'ant-search-fallback'));
    }

    const ivuRadioHint = (safeSel && (safeSel.includes('ivu-radio') || safeSel.includes('radio-group')))
      || (safeXp && (safeXp.includes('ivu-radio') || safeXp.includes('radio-group')));
    if (ivuRadioHint) {
      parts.push(wrap(PlayerManager._ivuRadioGroupFallbackExpr(safeSel, safeXp), 'ivu-radio-fallback'));
    }

    const ivuTableHint = safeXp && /\/(?:tbody|thead)\/tr\[\d+\]\/(?:td|th)\[\d+\]/i.test(safeXp);
    if (ivuTableHint) {
      parts.push(wrap(PlayerManager._ivuTableCellFallbackExpr(safeXp, locatorContextJson), 'ivu-table-cell'));
    }

    return parts.length ? parts.join(' || ') : 'null';
  }

  /**
   * 与 _buildFindCode 相同的元素定位顺序，返回「可见文本」原文（不做 trim）。
   * textarea / input 读 **value**（与 v-model 一致）；其它元素读 **textContent**。
   * 用于 assert_json 与平台预存 JSON 原样比对。
   */
  static _buildDomTextRawExpr(selector, xpath) {
    let safeSel = selector && !/:\w+-of-type\(0\)/.test(selector) ? selector : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';

    let safeXp = xpath || '';
    if (PlayerManager._isVolatileRcXPath(safeXp)) safeXp = '';

    if (safeXp && !safeXp.startsWith('//') && !safeXp.startsWith('/html') && !safeXp.startsWith('/*')) {
      safeXp = `/${safeXp}`;
    }

    const cssIsStableId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(selector)
    );

    const cssFindOne = safeSel
      ? (cssIsStableId
        ? `document.querySelector(${JSON.stringify(safeSel)})`
        : PlayerManager._modalAwareCssPickExpr(safeSel))
      : null;

    const elParts = [];
    if (cssIsStableId && cssFindOne) elParts.push(`(${cssFindOne})`);
    if (safeXp) elParts.push(PlayerManager._xpathSnapshotPickExpr(safeXp));
    if (!cssIsStableId && cssFindOne) elParts.push(`(${cssFindOne})`);

    const chain = elParts.length ? elParts.join(' || ') : 'null';

    return `(function(){
      try {
        var el = ${chain};
        if (!el) return { ok: false, err: 'not_found' };
        var tag = el.tagName && String(el.tagName).toLowerCase() || '';
        var t = '';
        if (tag === 'textarea' || tag === 'input') {
          t = el.value != null ? String(el.value) : '';
        } else {
          t = el.textContent;
          if (t === null || t === undefined) t = '';
        }
        return { ok: true, text: t };
      } catch (e) {
        return { ok: false, err: e && e.message ? String(e.message) : 'error' };
      }
    })()`;
  }

  async _waitForDomTextRawCDP(tabId, selector, xpath, timeout = 8000, skipPageErrorCheck = false) {
    let remaining = timeout;
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    const expr = PlayerManager._buildDomTextRawExpr(selector, xpath);
    while (Date.now() < wallEnd && remaining > 0) {
      if (!skipPageErrorCheck) await this._throwIfPageError(tabId);
      const loading = await this._isPageLoadingUi(tabId);
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      const v = res?.result?.value;
      if (v && v.ok && typeof v.text === 'string') return v.text;
      await this._sleep(400);
      if (!loading) remaining -= 400;
    }
    return null;
  }

  async _executeAssertJsonStep(tabId, step, testCaseId) {
    if (step.wait_before) await this._sleep(step.wait_before);
    await this._throwIfPageError(tabId);
    const sel = (step.target_selector || '').trim();
    const xp = (step.target_xpath || '').trim();
    if (!sel && !xp) {
      throw new Error('JSON 断言需要填写 CSS 选择器或 XPath，以定位展示 JSON 的容器元素');
    }
    const sid = step.id;
    if (sid == null || Number.isNaN(Number(sid))) {
      throw new Error('JSON 断言步骤缺少步骤 id，请重新加载用例后重试');
    }
    const actual = await this._waitForDomTextRawCDP(tabId, step.target_selector, step.target_xpath, 10000);
    if (actual == null) {
      const treeDiag = await this._getTreeWaitDiagnosticSuffix(tabId, step.locator_meta);
      throw new Error(
        `JSON 断言：在超时内未找到目标元素或无法读取文本${treeDiag}\n  CSS: ${sel || '—'}\n  XPath: ${xp || '—'}`,
      );
    }

    const ASSERT_JSON_LOG_MAX = 50000;
    console.log(
      '[AT assert_json] 定位 CSS:',
      step.target_selector || '—',
      'XPath:',
      step.target_xpath || '—',
    );
    console.log('[AT assert_json] 采集到的字符数:', actual.length);
    if (actual.length <= ASSERT_JSON_LOG_MAX) {
      console.log('[AT assert_json] 采集到的内容:\n' + actual);
    } else {
      console.log('[AT assert_json] 采集到的内容（前 ' + ASSERT_JSON_LOG_MAX + ' 字符）:\n' + actual.slice(0, ASSERT_JSON_LOG_MAX));
      console.log('[AT assert_json] …共 ' + actual.length + ' 字符，日志已截断');
    }

    try {
      await this.api.assertJson(testCaseId, { stepId: Number(sid), actual });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`JSON 断言失败：${msg}`);
    }
  }

  /**
   * 普通 assert_text：与 content/player.js 语义一致，但用 CDP 在后台执行，失败直接 throw，
   * 不经过 tabs.sendMessage（避免异步 sendResponse 丢包导致整例仍报成功）。
   */
  _logAssertTextCdpDebug(payload) {
    const PREVIEW_MAX = 8000;
    const { mode, expected, actual, hit, css, xpath } = payload;
    console.log('[AT assert_text] ========== CDP 执行 · 普通断言 ==========');
    console.log(
      '[AT assert_text] 说明:',
      mode === 'element'
        ? '已按 CSS/XPath 定位；textarea/input 取 value，其它取 textContent；与「输入值」全字符相等'
        : '未填选择器：整页 innerText 是否包含「输入值」子串',
    );
    if (css || xpath) console.log('[AT assert_text] CSS:', css || '—', 'XPath:', xpath || '—');
    const expStr = typeof expected === 'string' ? expected : '';
    const actStr = typeof actual === 'string' ? actual : '';
    console.log('[AT assert_text] 预期长度:', expStr.length);
    console.log(
      '[AT assert_text] 预期内容:\n' + (expStr.length > PREVIEW_MAX ? expStr.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expStr),
    );
    if (mode === 'element') {
      console.log('[AT assert_text] 实际长度:', actStr.length);
      console.log(
        '[AT assert_text] 实际内容:\n' + (actStr.length > PREVIEW_MAX ? actStr.slice(0, PREVIEW_MAX) + '\n…(已截断)' : actStr),
      );
    } else {
      console.log('[AT assert_text] 整页 innerText 长度:', actStr.length);
      console.log(
        '[AT assert_text] 整页 innerText 预览:\n' + (actStr.length > PREVIEW_MAX ? actStr.slice(0, PREVIEW_MAX) + '\n…(已截断)' : actStr),
      );
    }
    console.log('[AT assert_text] 比对结果:', mode === 'element' ? '全等 ===' : '整页 includes', '=', hit);
    console.log('[AT assert_text] ==========================================');
  }

  static _resolveAssertionConfig(step, hasLocator = false) {
    const meta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const raw = meta?.assertion && typeof meta.assertion === 'object' ? meta.assertion : {};
    const target = ['page', 'element', 'error'].includes(String(raw.target || '')) ? String(raw.target) : (hasLocator ? 'element' : 'page');
    const match = ['contains', 'equals', 'not_contains', 'regex'].includes(String(raw.match || '')) ? String(raw.match) : (hasLocator ? 'equals' : 'contains');
    return { target, match };
  }

  static _matchAssertionText(actual, expected, mode = 'contains') {
    const a = String(actual ?? '');
    const e = String(expected ?? '');
    if (mode === 'equals') return a === e;
    if (mode === 'not_contains') return !a.includes(e);
    if (mode === 'regex') {
      try {
        return new RegExp(e).test(a);
      } catch {
        return false;
      }
    }
    return a.includes(e);
  }

  async _waitForPageErrorTextCDP(tabId, timeout = 10000) {
    const end = Date.now() + timeout;
    let last = '';
    while (Date.now() < end) {
      const sig = await this._detectPageError(tabId);
      if (sig && sig.hit) {
        last = sig.snippet || sig.keyword || '';
        if (last) return last;
      }
      await this._sleep(300);
    }
    return last;
  }

  async _executeAssertTextStepCDP(tabId, step) {
    if (step.wait_before) await this._sleep(step.wait_before);
    const expected = step.value != null ? String(step.value) : '';
    if (expected.trim() === '') {
      throw new Error('断言失败：未配置断言文本（「输入值」不能为空或仅空白）');
    }

    const hasLocator = String(step.target_selector || '').trim() !== '' || String(step.target_xpath || '').trim() !== '';
    const assertion = PlayerManager._resolveAssertionConfig(step, hasLocator);

    if (assertion.target === 'error') {
      const actual = await this._waitForPageErrorTextCDP(tabId, 10000);
      const hit = PlayerManager._matchAssertionText(actual, expected, assertion.match);
      this._logAssertTextCdpDebug({
        mode: `error_${assertion.match}`,
        expected,
        actual,
        hit,
        css: '',
        xpath: '',
      });
      if (!hit) {
        throw new Error(`断言失败：错误提示未满足预期 "${expected.slice(0, 200)}"`);
      }
      return;
    }

    if (assertion.target === 'element') {
      const actual = await this._waitForDomTextRawCDP(tabId, step.target_selector, step.target_xpath, 10000, true);
      if (actual == null) {
        const treeDiag = await this._getTreeWaitDiagnosticSuffix(tabId, step.locator_meta);
        throw new Error(
          `断言失败：找不到目标元素${treeDiag}\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
        );
      }
      const hit = PlayerManager._matchAssertionText(actual, expected, assertion.match);
      this._logAssertTextCdpDebug({
        mode: 'element',
        expected,
        actual,
        hit,
        css: step.target_selector || '',
        xpath: step.target_xpath || '',
      });
      if (!hit) {
        throw new Error(
          `断言失败：元素内容与「输入值」不一致`,
        );
      }
      return;
    }

    const expr = `(function(){
      try {
        var t = document.body && document.body.innerText ? document.body.innerText : '';
        return { ok: true, text: t };
      } catch (e) {
        return { ok: false, err: String(e && e.message ? e.message : e) };
      }
    })()`;
    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const o = res?.result?.value;
    const pageText = o && o.ok && typeof o.text === 'string' ? o.text : '';
    const hit = PlayerManager._matchAssertionText(pageText, expected, assertion.match);
    this._logAssertTextCdpDebug({
      mode: `whole_page_${assertion.match}`,
      expected,
      actual: pageText,
      hit,
      css: '',
      xpath: '',
    });
    if (!hit) {
      const preview = expected.length > 200 ? `${expected.slice(0, 200)}…` : expected;
      throw new Error(`断言失败：页面中未找到文本 "${preview}"`);
    }
  }

  async _isPageLoadingUi(tabId) {
    try {
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: PlayerManager.PAGE_LOADING_UI_CHECK,
        returnByValue: true,
      });
      return res?.result?.value === true;
    } catch {
      return false;
    }
  }

  async _detectPageError(tabId) {
    try {
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: PlayerManager.getPageErrorCheckExpr(),
        returnByValue: true,
      });
      const v = res?.result?.value;
      if (v && v.hit) return v;
    } catch {
      /* ignore */
    }
    return null;
  }

  async _throwIfPageError(tabId) {
    if (this._pageErrorCheckEnabledByTab && this._pageErrorCheckEnabledByTab.get(tabId) === false) return;
    const sig = await this._detectPageError(tabId);
    if (sig && sig.hit) {
      throw new Error(
        `页面出现错误提示，已中止回放：${sig.keyword}\n${sig.snippet ? `摘录：${sig.snippet}` : ''}`,
      );
    }
  }

  // 等待浮层（下拉框）出现在 DOM 并可见，最多等 timeout ms（页面 loading 时不扣减剩余时间）
  async _waitForOverlay(tabId, timeout = 3500) {
    const helpers = PlayerManager._customOverlayCollectFnSource();
    const code = `(function(){
      ${helpers}
      const sel = ${JSON.stringify(PlayerManager.OVERLAY_CONTAINER_SEL)};
      if (Array.from(document.querySelectorAll(sel)).some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })) return true;
      return collectCustomOverlayContainers().some(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    })()`;
    let remaining = timeout;
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    while (Date.now() < wallEnd && remaining > 0) {
      await this._throwIfPageError(tabId);
      const loading = await this._isPageLoadingUi(tabId);
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: code, returnByValue: true });
      if (res?.result?.value === true) return true;
      await this._sleep(200);
      if (!loading) remaining -= 200;
    }
    return false;
  }

  // 通过 CSS/XPath/文本内容 查找元素坐标，带超时重试（页面处于 loading 时不扣减剩余时间）
  // skipDisabledCheck=true 用于浮层选项（选项本身不会 disabled）
  async _getElementBoxResult(tabId, selector, xpath, textFallback = '', timeout = 5000, skipDisabledCheck = false, locatorMeta = null) {
    let remaining = timeout;
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    let lastStatus = null;
    while (Date.now() < wallEnd && remaining > 0) {
      await this._throwIfPageError(tabId);
      const loading = await this._isPageLoadingUi(tabId);
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: this._buildFindCode(selector, xpath, textFallback, skipDisabledCheck, locatorMeta),
        returnByValue: true,
      });
      const box = res?.result?.value;
      if (box) return { ok: true, box };

      const statusRes = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: this._buildFindCode(selector, xpath, textFallback, skipDisabledCheck, locatorMeta, true),
        returnByValue: true,
      });
      const status = statusRes?.result?.value;
      if (status && status.ok === false) lastStatus = status;
      await this._sleep(400);
      if (!loading) remaining -= 400;
    }
    const failed = lastStatus || { ok: false, reason: 'not_found' };
    const treeDiagExpr = PlayerManager._treeInteractionDiagnosticExpr(locatorMeta);
    if (treeDiagExpr !== 'null') {
      try {
        const diagRes = await this._cdpSend(tabId, 'Runtime.evaluate', {
          expression: treeDiagExpr,
          returnByValue: true,
        });
        const tree = diagRes?.result?.value;
        if (tree && typeof tree === 'object') failed.tree = tree;
      } catch (e) { /* ignore */ }
    }
    return failed;
  }

  async _getElementBox(tabId, selector, xpath, textFallback = '', timeout = 5000, skipDisabledCheck = false, locatorMeta = null) {
    const result = await this._getElementBoxResult(
      tabId, selector, xpath, textFallback, timeout, skipDisabledCheck, locatorMeta
    );
    return result && result.ok ? result.box : null;
  }

  _formatTreeWaitDiagnostic(tree) {
    if (!tree || typeof tree !== 'object' || !tree.framework || !tree.kind) return '';
    const title = tree.title ? `「${tree.title}」` : '目标节点';
    const path = Array.isArray(tree.expectedParentPath) && tree.expectedParentPath.length
      ? `\n  录制父路径: ${tree.expectedParentPath.join(' / ')}`
      : '';
    const level = tree.expectedLevel !== null && tree.expectedLevel !== undefined
      ? `\n  录制层级: ${tree.expectedLevel}`
      : '';
    if (tree.error) {
      return `\n  Tree 诊断: 诊断过程异常：${tree.error}`;
    }
    if (Number(tree.treeNodeCount || 0) <= 0) {
      return `\n  Tree 诊断: 当前页面未找到 ${tree.framework} 树节点，可能页面状态或前置步骤不一致。`;
    }
    if (Number(tree.sameTitleCount || 0) <= 0) {
      return `\n  Tree 诊断: 当前树中找不到标题为 ${title} 的节点，可能节点未展开、未加载或已被前序步骤改名/删除。${path}${level}`;
    }
    if (Array.isArray(tree.expectedParentPath) && tree.expectedParentPath.length && Number(tree.pathMatchedCount || 0) <= 0) {
      return `\n  Tree 诊断: 找到 ${tree.sameTitleCount} 个同名节点，但父路径与录制时不匹配，可能点击到了另一棵分支或树结构已变化。${path}${level}`;
    }
    if (tree.expectedLevel !== null && tree.expectedLevel !== undefined && Number(tree.levelMatchedCount || 0) <= 0) {
      return `\n  Tree 诊断: 找到同名节点且父路径接近，但层级与录制时不一致，可能目标节点层级发生变化。${path}${level}`;
    }
    if (Number(tree.targetMatchedCount || 0) <= 0) {
      const kindText = tree.kind === 'expand_toggle'
        ? '展开/收起按钮'
        : tree.kind === 'node_action'
          ? '节点操作图标'
          : '节点内容区域';
      return `\n  Tree 诊断: 已找到目标节点 ${title}，但未找到可点击的${kindText}，可能图标需要先 hover、节点不可展开，或组件 DOM 已变化。${path}${level}`;
    }
    return `\n  Tree 诊断: 已找到候选 Tree 节点，但目标元素仍未通过可见性/可点击性检查，可能被遮挡、未渲染完成或页面状态变化。${path}${level}`;
  }

  async _getTreeWaitDiagnosticSuffix(tabId, locatorMeta) {
    const expr = PlayerManager._treeInteractionDiagnosticExpr(locatorMeta);
    if (expr === 'null') return '';
    try {
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
      });
      return this._formatTreeWaitDiagnostic(res?.result?.value);
    } catch {
      return '';
    }
  }

  _formatElementWaitFailure(result, selector, xpath) {
    const reason = String(result?.reason || 'not_found');
    const css = selector || '—';
    const xp = xpath || '—';
    const treeDiag = this._formatTreeWaitDiagnostic(result?.tree);
    if (reason === 'disabled') {
      const disabled = result?.disabled || {};
      const by = disabled.by ? `\n  禁用来源: ${disabled.by}` : '';
      const why = disabled.reason ? `\n  禁用原因: ${disabled.reason}` : '';
      return `目标元素已找到，但仍处于禁用态（等待超时）${treeDiag}${why}${by}\n  CSS: ${css}\n  XPath: ${xp}`;
    }
    if (reason === 'hidden') {
      return `目标元素已找到，但不可见或尺寸为 0（等待超时）${treeDiag}\n  CSS: ${css}\n  XPath: ${xp}`;
    }
    if (reason === 'lookup_error') {
      return `查找目标元素时发生错误：${result?.message || 'unknown'}${treeDiag}\n  CSS: ${css}\n  XPath: ${xp}`;
    }
    return `找不到元素（等待超时；全页 loading 时计时会暂停）${treeDiag}\n  CSS: ${css}\n  XPath: ${xp}`;
  }

  async _activateRevealTriggerCDP(tabId, trigger) {
    if (!trigger) return false;
    const box = await this._getElementBox(
      tabId,
      trigger.target_selector || '',
      trigger.target_xpath || '',
      '',
      trigger.max_wait_ms || 2200,
      false,
      trigger.locator_meta ?? null
    );
    if (!box) return false;
    if (String(trigger.action || 'hover').toLowerCase() === 'click') {
      await this._cdpClick(tabId, box.x, box.y);
      await this._sleep(220);
      return true;
    }
    await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await this._sleep(380);
    return true;
  }

  // 浮层选项专用查找：等下拉框打开 → 在容器内按文本搜索 → 超时时输出诊断
  async _clickOverlayItem(tabId, step, locale = 'zh', options = {}) {
    const textToFind = step.value || '';
    const hadReveal = options.hadReveal === true;

    if (hadReveal) {
      const helpers = PlayerManager._customOverlayCollectFnSource();
      let waitSub = 2800;
      while (waitSub > 0) {
        const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
          expression: `(function(){ ${helpers} return collectCustomOverlayContainers().length; })()`,
          returnByValue: true,
        });
        const n = Number(res?.result?.value ?? 0);
        if (n >= 2) break;
        await this._sleep(200);
        waitSub -= 200;
      }
      await this._sleep(320);
    }

    // 等下拉框真正出现（最多约 3.5s）
    const overlayAppeared = await this._waitForOverlay(tabId, 3500);
    if (!overlayAppeared) {
      // 即使没检测到标准浮层容器，也继续尝试文本搜索（有些组件用非标准类名）
      console.warn('[AT Player] 未检测到标准浮层容器，仍将尝试文本搜索');
    }

    // 在浮层容器内按文本搜索；全页 loading 时不扣减 6s 预算
    let remaining = 6000;
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    let box = null;
    while (!box && Date.now() < wallEnd && remaining > 0) {
      await this._throwIfPageError(tabId);
      const loading = await this._isPageLoadingUi(tabId);
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: PlayerManager._findInOverlayCode(textToFind),
        returnByValue: true,
      });
      box = res?.result?.value || null;
      if (!box) {
        await this._sleep(400);
        if (!loading) remaining -= 400;
      }
    }

    if (!box && (step.target_xpath || step.target_selector)) {
      box = await this._getElementBox(
        tabId,
        step.target_selector || '',
        step.target_xpath || '',
        '',
        2000,
        true,
        step.locator_meta ?? null,
      );
    }

    if (!box) {
      // 超时：输出下拉框中实际选项，帮助诊断
      const actualItems = await this._getOverlayItemTexts(tabId);
      const hint = actualItems.length
        ? trByLocale(
          locale,
          `\n  下拉框中实际选项（前30条）:\n${actualItems.map((t, i) => `    ${i + 1}. "${t}"`).join('\n')}`,
          `\n  Actual options in dropdown (top 30):\n${actualItems.map((t, i) => `    ${i + 1}. "${t}"`).join('\n')}`,
        )
        : trByLocale(
          locale,
          '\n  下拉框中未找到任何选项（可能仍在加载，或下拉框未成功打开）',
          '\n  No options found in dropdown (it may still be loading, or the dropdown did not open)',
        );
      throw new Error(
        trByLocale(
          locale,
          `在下拉框中找不到选项 "${textToFind}"（等待超时；全页 loading 时计时会暂停）${hint}`,
          `Option "${textToFind}" not found in dropdown (wait timed out; timer pauses while full-page loading is active)${hint}`,
        ),
      );
    }

    return box;
  }

  // 执行一次 CDP 鼠标点击（完整序列：move→press→release）
  async _cdpClick(tabId, x, y, options = {}) {
    const button = options.button || 'left';
    const clickCount = Number(options.clickCount || 1);
    const buttons = button === 'right' ? 2 : 1;
    await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    if (clickCount <= 1 || button === 'right') {
      await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, buttons });
      await this._sleep(60);
      await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, buttons: 0 });
      return;
    }
    for (let i = 1; i <= clickCount; i++) {
      await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, buttons });
      await this._sleep(40);
      await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, buttons: 0 });
      if (i < clickCount) await this._sleep(60);
    }
  }

  /** 在页面中打标并序列化可交互节点，供大模型规划操作（优先采集可见下拉浮层，避免漏掉 iView 等 li 选项） */
  static COLLECT_AI_STRUCTURE_CODE = `(function(){
    var ATTR = 'data-at-ai-id';
    var OVERLAY_CONTAINERS = '.ivu-select-dropdown,.el-select-dropdown,.ant-select-dropdown,.v-menu__content,.vs__dropdown-menu,.el-popper';
    var OPTION_INNER = 'li, [role="option"], .ivu-select-item, .ivu-dropdown-item, .el-select-dropdown__item, .el-option, .ant-select-item, .ant-select-item-option-content, .t-select-option, .arco-select-option';
    var MAX_NODES = 280;

    document.querySelectorAll('[' + ATTR + ']').forEach(function(el){ el.removeAttribute(ATTR); });

    function getText(el) {
      var t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
      if (!t) {
        t = (el.getAttribute('placeholder') || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || getIconHint(el) || '').trim();
      }
      return t.slice(0, 200);
    }

    function normText(s) {
      return String(s || '').trim().replace(/\\s+/g, ' ');
    }

    function getControlKind(el) {
      if (!el) return '';
      var tag = String(el.tagName || '').toLowerCase();
      var role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
      var type = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
      if (tag === 'textarea') return 'textarea';
      if (tag === 'select' || role === 'combobox') return 'combobox';
      if (tag === 'input') return 'input:' + (type || 'text');
      if (role === 'textbox') return 'textbox';
      if (role === 'tab' || (el.matches && el.matches('.ivu-tabs-tab,.el-tabs__item,.ant-tabs-tab,.ant-tabs-tab-btn,[class*="tabs-tab"]'))) return 'tab';
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (el.closest && el.closest('.data-source-icon,.icon-v2,[class*="icon"]')) return 'icon';
      return tag || role || '';
    }

    function getIconHint(el) {
      if (!el) return '';
      try {
        var iconHost = el.matches && el.matches('.data-source-icon,.icon-v2,[class*="icon"]')
          ? el
          : (el.querySelector && el.querySelector('.data-source-icon,.icon-v2,[class*="icon"],svg use'));
        if (!iconHost) return '';
        var useNode = iconHost.matches && iconHost.matches('use') ? iconHost : (iconHost.querySelector && iconHost.querySelector('use'));
        var href = '';
        if (useNode) {
          href = useNode.getAttribute('href') || useNode.getAttribute('xlink:href') || '';
        }
        var cls = typeof iconHost.className === 'string' ? iconHost.className : '';
        var raw = String(href || cls || '').replace(/^#/, '').replace(/^icon[-_]?/i, '');
        raw = raw.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^v2\\s+/i, '').trim();
        return raw.slice(0, 80);
      } catch (e) {
        return '';
      }
    }

    function getLabelText(el) {
      if (!el) return '';
      var parts = [];
      function push(v) {
        var t = normText(v);
        if (t && parts.indexOf(t) < 0) parts.push(t);
      }
      try {
        if (el.labels && el.labels.length) {
          Array.prototype.forEach.call(el.labels, function(lb){ push(lb.innerText || lb.textContent); });
        }
      } catch (e1) {}
      try {
        var ariaIds = el.getAttribute && el.getAttribute('aria-labelledby');
        if (ariaIds) {
          ariaIds.split(/\\s+/).forEach(function(id){
            var n = document.getElementById(id);
            if (n) push(n.innerText || n.textContent);
          });
        }
      } catch (e2) {}
      try { push(el.getAttribute && el.getAttribute('aria-label')); } catch (e3) {}
      try {
        var ownLabel = el.closest && el.closest('label');
        if (ownLabel) push(ownLabel.innerText || ownLabel.textContent);
      } catch (e4) {}
      try {
        var formItem = el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th');
        if (formItem) {
          var lab = formItem.querySelector('label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"],th');
          if (lab) push(lab.innerText || lab.textContent);
        }
      } catch (e5) {}
      return parts.join(' | ').slice(0, 200);
    }

    function getFieldContext(el) {
      if (!el) return '';
      try {
        var c = el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"]');
        return normText((c && (c.innerText || c.textContent)) || '').slice(0, 280);
      } catch (e) {
        return '';
      }
    }

    function elementIndexInParent(el, selector) {
      if (!el || !el.parentElement) return -1;
      var list = el.parentElement.querySelectorAll(':scope > ' + selector);
      for (var i = 0; i < list.length; i++) {
        if (list[i] === el) return i;
      }
      return -1;
    }

    function getTableColumnContext(el) {
      try {
        var cell = el.closest && el.closest('td,th,.ant-table-cell,.el-table__cell,[role="gridcell"]');
        if (!cell) return '';
        var row = cell.closest && cell.closest('tr,[role="row"],.el-table__row,.ivu-table-row,.ant-table-row');
        if (!row) return '';
        var cellIndex = elementIndexInParent(cell, 'td,th,.ant-table-cell,.el-table__cell,[role="gridcell"]');
        if (cellIndex < 0 && typeof cell.cellIndex === 'number') cellIndex = cell.cellIndex;
        if (cellIndex < 0) return '';
        var host = row.closest && (row.closest('.ivu-table') || row.closest('.el-table') || row.closest('.ant-table') || row.closest('table'));
        if (!host) return '';
        var headers = host.querySelectorAll('.ivu-table-header thead tr:last-child th, .el-table__header-wrapper thead tr:last-child th, .ant-table-thead tr:last-child th, thead tr:last-child th');
        var th = headers[cellIndex];
        return normText((th && (th.innerText || th.textContent)) || '').slice(0, 120);
      } catch (e) {
        return '';
      }
    }

    /** 固定列场景：勾选框在左侧 table 的 tr 里，表名在主 table 同行 tr，按 tbody 内行号合并文案 */
    function parallelTbodyRowContext(row, norm) {
      var myTbody = row.closest('tbody');
      if (!myTbody || !myTbody.parentElement) return '';
      var ch = myTbody.children;
      var rowIdx = -1;
      for (var ri = 0; ri < ch.length; ri++) {
        if (ch[ri] === row) { rowIdx = ri; break; }
      }
      if (rowIdx < 0) return '';
      var host = myTbody.closest('.el-table__inner-wrapper') || myTbody.closest('.el-table') || myTbody.closest('.ivu-table') || myTbody.closest('.ant-table-content') || myTbody.closest('.ant-table');
      if (!host) return '';
      var tbs = host.querySelectorAll('tbody');
      var extraParts = [];
      for (var ti = 0; ti < tbs.length; ti++) {
        var tb = tbs[ti];
        if (tb === myTbody) continue;
        var tr2 = tb.children[rowIdx];
        if (!tr2 || (tr2.tagName && String(tr2.tagName).toLowerCase() !== 'tr')) continue;
        var tx = norm(tr2.innerText || tr2.textContent);
        if (tx && extraParts.indexOf(tx) < 0) extraParts.push(tx);
      }
      return extraParts.join(' | ').slice(0, 280);
    }

    /** 表格行内除本控件所在单元格外的可见文案（源表名/目标表等），供大模型区分多行复选框 */
    function getRowContextText(el) {
      var norm = function(s) { return (s || '').trim().replace(/\\s+/g, ' '); };
      var explicit = norm(el.getAttribute('data-row-context') || el.getAttribute('data-at-row-context'));
      var ariaOrTitle = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
      var anc = el.parentElement;
      var depthA = 0;
      while (anc && depthA++ < 12) {
        var ac = norm(anc.getAttribute && (anc.getAttribute('data-row-context') || anc.getAttribute('data-at-row-context')));
        if (ac && explicit.indexOf(ac) < 0) explicit = explicit ? (explicit + ' | ' + ac) : ac;
        anc = anc.parentElement;
      }
      var row = el.closest('tr');
      if (!row) row = el.closest('[role="row"]');
      if (!row) row = el.closest('.el-table__row');
      if (!row) row = el.closest('.ivu-table-row');
      if (!row) row = el.closest('.ant-table-row');
      var fromRow = '';
      if (row) {
        var parts = [];
        var cells = row.querySelectorAll(':scope > td, :scope > th, :scope > .ant-table-cell, :scope > .el-table__cell, :scope > [role="gridcell"], :scope > .ivu-table-cell');
        for (var ci = 0; ci < cells.length; ci++) {
          var cell = cells[ci];
          if (cell.contains(el)) continue;
          var ct = norm(cell.innerText || cell.textContent);
          if (ct && parts.indexOf(ct) < 0) parts.push(ct);
        }
        if (parts.length) fromRow = parts.join(' | ').slice(0, 280);
        else fromRow = norm(row.innerText || row.textContent).slice(0, 280);
        var frn = norm(fromRow);
        if (!frn || frn === 'on' || frn.length <= 2) {
          var para = parallelTbodyRowContext(row, norm);
          if (para) fromRow = para;
        } else if (parts.length === 0 && frn.length < 40) {
          var para2 = parallelTbodyRowContext(row, norm);
          if (para2 && para2.length > frn.length) fromRow = (frn + ' | ' + para2).slice(0, 280);
        }
      }
      if (!fromRow) {
        var p = el.parentElement;
        var depth = 0;
        while (p && depth++ < 10) {
          var sib = p.previousElementSibling;
          while (sib) {
            var st = norm(sib.innerText || sib.textContent);
            if (st) { fromRow = st.slice(0, 280); break; }
            sib = sib.previousElementSibling;
          }
          if (fromRow) break;
          p = p.parentElement;
        }
      }
      var bits = [explicit, ariaOrTitle, fromRow].filter(Boolean);
      var out = bits.filter(function(x, i) { return bits.indexOf(x) === i; }).join(' | ');
      return out.slice(0, 280);
    }

    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < window.innerHeight + 600 && r.bottom > -600;
    }

    var nodes = [];
    var seen = new WeakSet();
    var i = 0;

    function pushNode(el, source) {
      if (i >= MAX_NODES || seen.has(el)) return;
      if (!visible(el)) return;
      seen.add(el);
      var id = 'at-ai-' + (i++);
      el.setAttribute(ATTR, id);
      var tagLower = el.tagName.toLowerCase();
      var inpType = (el.getAttribute('type') || '').toLowerCase();
      var rowCtx = '';
      var labelText = getLabelText(el);
      var placeholderText = normText(el.getAttribute('placeholder') || '').slice(0, 120);
      var nameText = normText(el.getAttribute('name') || '').slice(0, 80);
      var fieldContext = getFieldContext(el);
      var columnContext = getTableColumnContext(el);
      var iconHint = getIconHint(el);
      var controlKind = getControlKind(el);
      var isCheckboxUi = tagLower === 'input' && inpType === 'checkbox';
      if (!isCheckboxUi && el.getAttribute('role') === 'checkbox') isCheckboxUi = true;
      if (!isCheckboxUi && el.matches) {
        if (el.matches('.el-checkbox') || el.matches('.ivu-checkbox-wrapper') || el.matches('.ant-checkbox, .ant-checkbox-wrapper')) isCheckboxUi = true;
      }
      if (isCheckboxUi || (el.closest && el.closest('tr,.el-table__row,.ivu-table-row,.ant-table-row,[role="row"]'))) rowCtx = getRowContextText(el);
      var innerCb = null;
      if (isCheckboxUi && tagLower !== 'input' && el.querySelector) innerCb = el.querySelector('input[type="checkbox"]');
      var checkedVal = el.checked === true || el.getAttribute('aria-checked') === 'true';
      if (innerCb) checkedVal = checkedVal || innerCb.checked === true;
      var selectedVal = el.getAttribute('aria-selected') === 'true';
      if (!selectedVal && el.matches) {
        selectedVal = el.matches('.ivu-tabs-tab-active,.el-tabs__item.is-active,.ant-tabs-tab-active,.active,[class*="tab-active"]');
      }
      nodes.push({
        id: id,
        tag: tagLower,
        role: el.getAttribute('role') || '',
        text: getText(el),
        row_context: rowCtx,
        label: labelText,
        icon_hint: iconHint,
        placeholder: placeholderText,
        name: nameText,
        field_context: fieldContext,
        column_context: columnContext,
        control_kind: controlKind,
        checked: checkedVal,
        selected: selectedVal,
        expanded: el.getAttribute('aria-expanded'),
        type: el.getAttribute('type') || '',
        classes: (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 10).join(' '),
        source: source || 'main'
      });
    }

    document.querySelectorAll(OVERLAY_CONTAINERS).forEach(function(container) {
      var cr = container.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) return;
      container.querySelectorAll(OPTION_INNER).forEach(function(el) {
        pushNode(el, 'dropdown');
      });
    });

    var selMain = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="treeitem"], [role="checkbox"], [role="menuitem"], [role="option"], [aria-haspopup="true"], [aria-haspopup="menu"], [class*="tree-node"], [class*="TreeNode"], tr[role="row"], [data-testid], label, .el-checkbox, .el-tree-node__content, .ant-tree-node-content-wrapper, .ivu-select-item, .ivu-dropdown-item, .ivu-select-selection, .ant-select-selector, .el-dropdown, .ivu-dropdown, .ivu-tabs-tab, .el-tabs__item, .ant-tabs-tab, .ant-tabs-tab-btn, .data-source-icon, svg.icon-v2, svg use';
    document.querySelectorAll(selMain).forEach(function(el) {
      pushNode(el, 'main');
    });

    return JSON.stringify({ nodes: nodes, url: location.href, title: document.title });
  })()`;

  static _normalizeAiNodeText(s) {
    return String(s || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  static _splitAiInstructionIntoSubtasks(instruction) {
    const raw = String(instruction || '').replace(/\r/g, '');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 1) return lines;

    const actionLead =
      '(点击|选择|输入|填写|打开|展开|勾选|取消|断言|测试|搜索|切换|悬停|click|select|input|enter|type|fill|open|expand|check|uncheck|assert|test|search|switch|hover)';
    const normalized = raw
      .replace(/\s+/g, ' ')
      .replace(/(?:^|\s)\d+(?:[\.、\)])\s*/g, '\n')
      .replace(new RegExp(`(?:，|,|;|；)\\s*(?=${actionLead})`, 'ig'), '\n')
      .replace(/(?:，|,|;|；)?\s*(然后|接着|再|最后|then|and then|next|finally|after that)\s*/ig, '\n');
    const parts = normalized
      .split(/\n+/)
      .map((part) => part.trim().replace(/^[，,、。；;.\-]+/, '').trim())
      .filter(Boolean);
    return parts.length ? parts : [raw.trim()];
  }

  static _aiPlanReasonLooksFailed(reason) {
    const text = String(reason || '').trim();
    if (!text) return false;
    return /(找不到|未找到|无法执行|不能执行|无法定位|未能定位|没有找到|无对应节点|无法完成|cannot|not found|unable to)/i.test(text);
  }

  /**
   * DOM 重渲后 data-at-ai-id 会重新编号，根据规划快照中的语义字段把旧 id 映射到当前采集结果中的新 id。
   */
  static _resolveAiNodeId(oldId, initialStructure, freshStructure) {
    const oldNode = (initialStructure?.nodes || []).find((n) => n.id === oldId);
    if (!oldNode) return oldId;

    const candidates = freshStructure?.nodes || [];
    if (!candidates.length) {
      throw new Error('AI 步骤：DOM 更新后未采集到可交互节点，请重试该步');
    }

    const oRow = PlayerManager._normalizeAiNodeText(oldNode.row_context);
    const oText = PlayerManager._normalizeAiNodeText(oldNode.text);
    const oLabel = PlayerManager._normalizeAiNodeText(oldNode.label);
    const oPlaceholder = PlayerManager._normalizeAiNodeText(oldNode.placeholder);
    const oName = PlayerManager._normalizeAiNodeText(oldNode.name);
    const oFieldContext = PlayerManager._normalizeAiNodeText(oldNode.field_context);
    const oColumnContext = PlayerManager._normalizeAiNodeText(oldNode.column_context);
    const oIconHint = PlayerManager._normalizeAiNodeText(oldNode.icon_hint);
    const oKind = String(oldNode.control_kind || '').toLowerCase();
    const oType = String(oldNode.type || '').toLowerCase();
    const oTag = String(oldNode.tag || '').toLowerCase();
    const oRole = String(oldNode.role || '').toLowerCase();
    const oSrc = String(oldNode.source || '');
    const oldLooksLikeFormField =
      /^input(?::|$)/.test(oKind)
      || oKind === 'textarea'
      || oKind === 'textbox'
      || oType === 'text'
      || oType === 'password'
      || !!(oLabel || oPlaceholder || oName || oFieldContext);

    let best = null;
    let bestScore = -1;

    for (const n of candidates) {
      let score = 0;
      const nTag = String(n.tag || '').toLowerCase();
      const nRole = String(n.role || '').toLowerCase();
      const nSrc = String(n.source || '');
      const nKind = String(n.control_kind || '').toLowerCase();
      const nType = String(n.type || '').toLowerCase();
      if (oTag && nTag && oTag === nTag) score += 6;
      if (oRole && nRole && oRole === nRole) score += 4;
      if (oSrc && nSrc && oSrc === nSrc) score += 3;
      if (oKind && nKind && oKind === nKind) score += 22;
      if (oType && nType && oType === nType) score += 14;

      const nRow = PlayerManager._normalizeAiNodeText(n.row_context);
      const nText = PlayerManager._normalizeAiNodeText(n.text);
      const nLabel = PlayerManager._normalizeAiNodeText(n.label);
      const nPlaceholder = PlayerManager._normalizeAiNodeText(n.placeholder);
      const nName = PlayerManager._normalizeAiNodeText(n.name);
      const nFieldContext = PlayerManager._normalizeAiNodeText(n.field_context);
      const nColumnContext = PlayerManager._normalizeAiNodeText(n.column_context);
      const nIconHint = PlayerManager._normalizeAiNodeText(n.icon_hint);
      const labelExactBonus = oldLooksLikeFormField ? 118 : 82;
      const labelPartialBonus = oldLooksLikeFormField ? 52 : 30;
      const placeholderExactBonus = oldLooksLikeFormField ? 136 : 92;
      const placeholderPartialBonus = oldLooksLikeFormField ? 62 : 36;
      const nameExactBonus = oldLooksLikeFormField ? 118 : 84;
      const namePartialBonus = oldLooksLikeFormField ? 54 : 32;
      const fieldContextExactBonus = oldLooksLikeFormField ? 104 : 76;
      const fieldContextPartialBonus = oldLooksLikeFormField ? 46 : 26;

      if (oRow && nRow) {
        if (oRow === nRow) score += 220;
        else if (oRow.includes(nRow) || nRow.includes(oRow)) score += 90;
        else {
          const ta = oRow.split(/[|\s/]+/).filter((x) => x.length > 1);
          const tb = nRow.split(/[|\s/]+/).filter((x) => x.length > 1);
          let inter = 0;
          for (const x of ta) {
            if (tb.some((y) => y === x || x.includes(y) || y.includes(x))) inter++;
          }
          score += inter * 28;
        }
      }

      if (oText && nText) {
        if (oText === nText) score += 110;
        else if (oText.includes(nText) || nText.includes(oText)) score += 55;
      }

      if (oLabel && nLabel) {
        if (oLabel === nLabel) score += labelExactBonus;
        else if (oLabel.includes(nLabel) || nLabel.includes(oLabel)) score += labelPartialBonus;
      }

      if (oPlaceholder && nPlaceholder) {
        if (oPlaceholder === nPlaceholder) score += placeholderExactBonus;
        else if (oPlaceholder.includes(nPlaceholder) || nPlaceholder.includes(oPlaceholder)) score += placeholderPartialBonus;
      }

      if (oName && nName) {
        if (oName === nName) score += nameExactBonus;
        else if (oName.includes(nName) || nName.includes(oName)) score += namePartialBonus;
      }

      if (oFieldContext && nFieldContext) {
        if (oFieldContext === nFieldContext) score += fieldContextExactBonus;
        else if (oFieldContext.includes(nFieldContext) || nFieldContext.includes(oFieldContext)) score += fieldContextPartialBonus;
      }

      if (oColumnContext && nColumnContext) {
        if (oColumnContext === nColumnContext) score += 96;
        else if (oColumnContext.includes(nColumnContext) || nColumnContext.includes(oColumnContext)) score += 44;
      }

      if (oIconHint && nIconHint) {
        if (oIconHint === nIconHint) score += 86;
        else if (oIconHint.includes(nIconHint) || nIconHint.includes(oIconHint)) score += 38;
      }

      const oc = String(oldNode.classes || '');
      const nc = String(n.classes || '');
      if (oc && nc && oc === nc) score += 2;

      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }

    const hasSemantic =
      (oRow && oRow.length > 2) ||
      (oText && oText.length > 2) ||
      (oLabel && oLabel.length > 1) ||
      (oPlaceholder && oPlaceholder.length > 1) ||
      (oName && oName.length > 1) ||
      (oFieldContext && oFieldContext.length > 2) ||
      (oColumnContext && oColumnContext.length > 1) ||
      (oIconHint && oIconHint.length > 1);
    const minScore = hasSemantic ? 38 : 7;
    if (!best || bestScore < minScore) {
      throw new Error(
        'AI 步骤：DOM 更新后无法匹配原节点 ' +
          oldId +
          '（页面结构变化过大，请重试该步或拆成多条智能步骤）',
      );
    }

    if (DEBUG_AI_NATURAL && best.id !== oldId) {
      console.log('[AT AI] 节点重映射:', oldId, '->', best.id, 'score=', bestScore);
    }
    return best.id;
  }

  async _collectFailureContext(tabId, errorStepIndex, errorMessage) {
    const expr = `(function(){
      try {
        var html = document.documentElement && document.documentElement.outerHTML ? document.documentElement.outerHTML : '';
        var text = document.body && document.body.innerText ? document.body.innerText : '';
        function normText(s) {
          return String(s || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
        }
        function isVisible(el) {
          if (!el) return false;
          var r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          var st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity) >= 0.05;
        }
        function zIndex(el) {
          var z = 0, cur = el;
          while (cur && cur !== document.body) {
            var zi = parseInt(window.getComputedStyle(cur).zIndex, 10);
            if (!isNaN(zi) && zi > z) z = zi;
            cur = cur.parentElement;
          }
          return z;
        }
        var overlaySel = [
          '.ivu-modal-wrap .ivu-modal',
          '.ivu-modal-wrap',
          '.ivu-message-error',
          '.ivu-notice-error',
          '.ivu-alert-error',
          '.ant-modal',
          '.ant-modal-confirm',
          '.ant-message-error',
          '.ant-notification-notice-error',
          '.el-message-box__wrapper',
          '.el-dialog__wrapper',
          '.el-message--error',
          '.arco-message-error',
          '.t-message--error',
          '.alert-danger',
          '.alert-error',
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[role="alert"]',
          'dialog'
        ].join(',');
        var errorOverlays = [];
        try {
          var seen = new Set();
          var overlayNodes = Array.from(document.querySelectorAll(overlaySel)).filter(isVisible);
          overlayNodes
            .sort(function(a, b) { return zIndex(b) - zIndex(a); })
            .forEach(function(el) {
              var txt = normText(el.innerText || el.textContent || '');
              if (!txt || seen.has(txt)) return;
              seen.add(txt);
              errorOverlays.push({
                text: txt,
                class_name: String(el.className || '').slice(0, 200),
                role: el.getAttribute && el.getAttribute('role') ? String(el.getAttribute('role')) : '',
                tag: String(el.tagName || '').toLowerCase(),
                z_index: zIndex(el),
              });
            });
          errorOverlays = errorOverlays.slice(0, 5);
        } catch (eOverlay) {}
        var pageErrorSignal = null;
        try {
          var keywords = ${JSON.stringify(PlayerManager.DEFAULT_PAGE_ERROR_KEYWORDS)};
          var lowerText = String(text || '').toLowerCase();
          for (var i = 0; i < keywords.length; i++) {
            var k = keywords[i];
            if (!k) continue;
            var idx = lowerText.indexOf(String(k).toLowerCase());
            if (idx >= 0) {
              var sourceText = String(text || '');
              var snip = sourceText.slice(Math.max(0, idx - 40), Math.min(sourceText.length, idx + String(k).length + 120)).replace(/\\s+/g, ' ').trim();
              pageErrorSignal = { keyword: k, snippet: snip };
              break;
            }
          }
          if (!pageErrorSignal && errorOverlays.length) {
            pageErrorSignal = { keyword: '[overlay-error]', snippet: errorOverlays[0].text };
          }
        } catch (eSignal) {}
        var resources = [];
        try {
          var entries = performance.getEntriesByType('resource');
          for (var j = Math.max(0, entries.length - 30); j < entries.length; j++) {
            var e = entries[j];
            if (e && e.name && e.name.indexOf('http') === 0) {
              resources.push({ name: e.name, duration: Math.round(e.duration), transferSize: e.transferSize || 0 });
            }
          }
        } catch (e2) {}
        return JSON.stringify({
          url: location.href,
          title: document.title,
          dom_excerpt: html.slice(0, 24000),
          body_text_excerpt: text.slice(0, 8000),
          error_overlays: errorOverlays,
          page_error_signal: pageErrorSignal,
          failed_requests_hint: resources
        });
      } catch (e) {
        return JSON.stringify({ parse_error: String(e && e.message) });
      }
    })()`;
    const r = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const raw = r?.result?.value;
    let page = {};
    try {
      page = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
    } catch {
      page = { raw_excerpt: String(raw).slice(0, 2000) };
    }
    return {
      error_message: errorMessage,
      failed_step_index: errorStepIndex,
      ...page,
    };
  }

  async _aiClickAtNode(tabId, nodeId) {
    const safe = String(nodeId).replace(/"/g, '');
    const css = '[data-at-ai-id="' + safe + '"]';
    let box = await this._getElementBox(tabId, css, '', '', 6000, false);
    if (!box) throw new Error('AI 步骤：找不到节点 ' + nodeId + '（DOM 可能已更新，请重试该步）');
    await this._sleep(100);
    const fresh = await this._getElementBox(tabId, css, '', '', 2000, false);
    const { x, y } = fresh || box;
    await this._cdpClick(tabId, x, y);
  }

  /** 智能步骤：悬停以展开下拉等（仅移动鼠标，不按下） */
  async _aiHoverAtNode(tabId, nodeId) {
    const safe = String(nodeId).replace(/"/g, '');
    const css = '[data-at-ai-id="' + safe + '"]';
    let box = await this._getElementBox(tabId, css, '', '', 6000, false);
    if (!box) throw new Error('AI 步骤：找不到悬停目标 ' + nodeId + '（DOM 可能已更新）');
    await this._sleep(100);
    const fresh = await this._getElementBox(tabId, css, '', '', 2000, false);
    const { x, y } = fresh || box;
    await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this._sleep(320);
  }

  /** 智能步骤：断言页面正文包含子串（与 player assert_text 一致） */
  async _aiAssertTextInPage(tabId, needle) {
    const n = String(needle || '').trim();
    if (!n) throw new Error('AI 步骤：assert_text 缺少 value');
    const logExpr = `(function(){
      var t = document.body && document.body.innerText ? document.body.innerText : '';
      return { len: t.length, head: t.slice(0, 8000) };
    })()`;
    const logRes = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: logExpr, returnByValue: true });
    const lv = logRes?.result?.value;
    console.log('[AT assert_text] (智能步骤) 规则：整页 innerText 须包含预期子串');
    console.log('[AT assert_text] (智能步骤) 预期子串（' + n.length + ' 字）:\n' + (n.length > 8000 ? n.slice(0, 8000) + '\n…(已截断)' : n));
    console.log('[AT assert_text] (智能步骤) 当前页 innerText 长度:', lv && lv.len != null ? lv.len : '—');
    console.log('[AT assert_text] (智能步骤) 当前页 innerText 预览（前 8000 字）:\n' + (lv && lv.head != null ? lv.head + (lv.len > 8000 ? '\n…(已截断)' : '') : '—'));

    const expr = `(function(){
      var t = document.body && document.body.innerText ? document.body.innerText : '';
      var needle = ${JSON.stringify(n)};
      return t.indexOf(needle) >= 0;
    })()`;
    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const hit = res?.result?.value === true;
    console.log('[AT assert_text] (智能步骤) includes(预期子串) =', hit);
    if (!hit) {
      throw new Error('AI 断言失败：页面中未找到文本「' + n.slice(0, 120) + '」');
    }
  }

  async _aiInputAtNode(tabId, nodeId, value) {
    await this._aiClickAtNode(tabId, nodeId);
    await this._sleep(80);
    await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 });
    await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 });
    const text = value || '';
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: ch });
      await this._sleep(12);
    }
  }

  /** 仅在与目标状态不一致时点击，避免 check/uncheck 误切换 */
  async _aiCheckboxSetChecked(tabId, nodeId, wantChecked) {
    const safe = String(nodeId).replace(/"/g, '');
    const want = JSON.stringify(Boolean(wantChecked));
    const expr = `(function(){
      var el = document.querySelector('[data-at-ai-id="${safe}"]');
      if (!el) return { ok: false, err: 'missing' };
      var cb = el;
      if (cb.tagName && String(cb.tagName).toLowerCase() !== 'input') {
        var inner = cb.querySelector && cb.querySelector('input[type="checkbox"]');
        if (inner) cb = inner;
      }
      var c = cb.checked === true || el.getAttribute('aria-checked') === 'true';
      var want = ${want};
      if (want === c) return { ok: true, skip: true };
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) r = cb.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return { ok: false, err: 'invisible' };
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`;
    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const o = res?.result?.value;
    if (!o || !o.ok) throw new Error(`AI 步骤：复选框 ${nodeId} 不可用（${o && o.err ? o.err : 'unknown'}）`);
    if (o.skip) return;
    await this._cdpClick(tabId, o.x, o.y);
  }

  /** 重新执行 COLLECT_AI_STRUCTURE_CODE（会清除并重打 data-at-ai-id），用于多步操作之间 DOM 已变化时的节点映射 */
  async _reCollectAiStructure(tabId) {
    const evalRes = await this._cdpSend(tabId, 'Runtime.evaluate', {
      expression: PlayerManager.COLLECT_AI_STRUCTURE_CODE,
      returnByValue: true,
    });
    const raw = evalRes?.result?.value;
    let structure;
    try {
      structure = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new Error('无法解析页面结构快照（DOM 更新后）');
    }
    if (!structure?.nodes?.length) {
      throw new Error('DOM 更新后未采集到可交互节点，请确认页面已加载完成');
    }
    return structure;
  }

  /**
   * @param {{ stepIndex?: number, stepTotal?: number }} meta 用于状态栏「第 N/M 步」与规划中/完成文案
   */
  async _executeAiNaturalStep(tabId, step, ctx, meta = {}) {
    const aiStepStartedAt = Date.now();
    if (step.wait_before) await this._sleep(step.wait_before);
    await this._throwIfPageError(tabId);
    const instruction = (step.nl_instruction || step.description || '').trim();
    if (!instruction) throw new Error('AI 步骤缺少自然语言指令（请在「自然语言指令」或步骤描述中填写）');

    const stepIndex = meta.stepIndex ?? '?';
    const stepTotal = meta.stepTotal ?? '?';
    const tcid = ctx.testCaseId ?? '?';

    console.log('[AT AI] 指令:', instruction);
    const subtasks = PlayerManager._splitAiInstructionIntoSubtasks(instruction);
    console.log('[AT AI] 子任务拆分:', subtasks);
    let totalOperations = 0;
    const subtaskResults = [];

    for (let si = 0; si < subtasks.length; si++) {
      const subInstruction = subtasks[si];
      if (ctx.stopped) throw new Error('用户手动停止');
      await this._throwIfPageError(tabId);
      this._notifyPopup(
        `#${tcid} 第 ${stepIndex}/${stepTotal} 步 · 智能子任务 ${si + 1}/${subtasks.length}：大模型规划中…（最长 100s）`,
      );

      const collectStartedAt = Date.now();
      const evalRes = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: PlayerManager.COLLECT_AI_STRUCTURE_CODE,
        returnByValue: true,
      });
      const raw = evalRes?.result?.value;
      let structure;
      try {
        structure = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        throw new Error('无法解析页面结构快照');
      }
      if (!structure?.nodes?.length) throw new Error('未采集到可交互节点，请确认页面已加载完成');
      console.log(
        '[AT AI PERF] collect duration_ms=%d subtask=%d/%d node_count=%d structure_chars=%d',
        Date.now() - collectStartedAt,
        si + 1,
        subtasks.length,
        Array.isArray(structure.nodes) ? structure.nodes.length : 0,
        JSON.stringify(structure).length,
      );

      if (DEBUG_AI_NATURAL) {
        console.log('[AT AI] 子任务 %d/%d 节点数: %d url: %s', si + 1, subtasks.length, structure.nodes.length, structure.url);
        console.table(structure.nodes.slice(0, 30).map((n) => ({
          id: n.id,
          tag: n.tag,
          text: (n.text || '').slice(0, 40),
          row: (n.row_context || '').slice(0, 50),
          checked: n.checked,
        })));
      }

      const planStartedAt = Date.now();
      const planRes = await this.api.aiStepPlan(
        { instruction: subInstruction, structure },
        { debug: DEBUG_AI_NATURAL, timeoutMs: 100000 },
      );
      console.log('[AT AI PERF] step_plan duration_ms=%d subtask=%d/%d', Date.now() - planStartedAt, si + 1, subtasks.length);
      const plan = planRes.data || {};
      const operations = plan.operations || [];
      const reason = plan.reason != null ? String(plan.reason) : '';
      totalOperations += operations.length;

      if (PlayerManager._aiPlanReasonLooksFailed(reason)) {
        subtaskResults.push({
          index: si + 1,
          instruction: subInstruction,
          status: 'failed',
          reason,
          operations_count: operations.length,
          error_message: '大模型规划未完成：' + reason,
        });
        for (let pending = si + 1; pending < subtasks.length; pending++) {
          subtaskResults.push({
            index: pending + 1,
            instruction: subtasks[pending],
            status: 'pending',
          });
        }
        const err = new Error('大模型规划未完成：' + reason);
        err.aiSubtasks = subtaskResults;
        throw err;
      }

      const resultSummary = reason
        ? reason.length > 120
          ? `${reason.slice(0, 120)}…`
          : reason
        : `已生成 ${operations.length} 条操作`;
      console.log('[AT AI] 子任务结果:', { subtask: si + 1, instruction: subInstruction, operations, reason: plan.reason });
      this._notifyPopup(
        `#${tcid} 第 ${stepIndex}/${stepTotal} 步 · 智能子任务 ${si + 1}/${subtasks.length}：${resultSummary}`,
      );

      if (DEBUG_AI_NATURAL) {
        console.log('[AT AI] 子任务模型 operations:', JSON.stringify(operations, null, 2));
        if (planRes.debug?.raw_model_response != null) {
          console.log('[AT AI] 子任务大模型原始返回（来自接口 debug）:\n', planRes.debug.raw_model_response);
        }
      }
      if (!operations.length) {
        subtaskResults.push({
          index: si + 1,
          instruction: subInstruction,
          status: 'failed',
          reason,
          operations_count: 0,
          error_message: '大模型未返回可执行操作：' + (plan.reason || '无'),
        });
        for (let pending = si + 1; pending < subtasks.length; pending++) {
          subtaskResults.push({
            index: pending + 1,
            instruction: subtasks[pending],
            status: 'pending',
          });
        }
        const err = new Error('大模型未返回可执行操作：' + (plan.reason || '无'));
        err.aiSubtasks = subtaskResults;
        throw err;
      }

      const validIds = new Set(structure.nodes.map((n) => n.id));
      for (const op of operations) {
        if (op.action === 'assert_text') continue;
        if (!op.nodeId || !validIds.has(op.nodeId)) {
          subtaskResults.push({
            index: si + 1,
            instruction: subInstruction,
            status: 'failed',
            reason,
            operations_count: operations.length,
            error_message: '大模型返回了无效节点 id: ' + (op.nodeId || '(空)'),
          });
          for (let pending = si + 1; pending < subtasks.length; pending++) {
            subtaskResults.push({
              index: pending + 1,
              instruction: subtasks[pending],
              status: 'pending',
            });
          }
          const err = new Error('大模型返回了无效节点 id: ' + (op.nodeId || '(空)'));
          err.aiSubtasks = subtaskResults;
          throw err;
        }
      }

      try {
        for (const op of operations) {
          if (ctx.stopped) throw new Error('用户手动停止');
          await this._throwIfPageError(tabId);
          const action = op.action || 'click';
          if (action === 'assert_text') {
            await this._aiAssertTextInPage(tabId, op.value || '');
          } else if (action === 'input') {
            await this._aiInputAtNode(tabId, op.nodeId, op.value || '');
          } else if (action === 'hover') {
            await this._aiHoverAtNode(tabId, op.nodeId);
          } else if (action === 'check') {
            await this._aiCheckboxSetChecked(tabId, op.nodeId, true);
          } else if (action === 'uncheck') {
            await this._aiCheckboxSetChecked(tabId, op.nodeId, false);
          } else {
            await this._aiClickAtNode(tabId, op.nodeId);
          }
          await this._sleep(280);
        }
        subtaskResults.push({
          index: si + 1,
          instruction: subInstruction,
          status: 'success',
          reason,
          operations_count: operations.length,
        });
      } catch (subErr) {
        subtaskResults.push({
          index: si + 1,
          instruction: subInstruction,
          status: 'failed',
          reason,
          operations_count: operations.length,
          error_message: subErr && subErr.message ? String(subErr.message) : String(subErr),
        });
        for (let pending = si + 1; pending < subtasks.length; pending++) {
          subtaskResults.push({
            index: pending + 1,
            instruction: subtasks[pending],
            status: 'pending',
          });
        }
        subErr.aiSubtasks = subtaskResults;
        throw subErr;
      }
    }
    console.log('[AT AI PERF] total duration_ms=%d subtasks=%d operations=%d', Date.now() - aiStepStartedAt, subtasks.length, totalOperations);
    return subtaskResults;
  }

  /** 在页面上下文中查找 input/textarea 并设置 value（兼容 Vue/React 受控组件） */
  async _setInputValueCDP(tabId, selector, xpath, value, locatorMeta = null, autoConfirmAntSelect = true) {
    let safeXp = xpath || '';
    if (PlayerManager._isVolatileRcXPath(safeXp)) safeXp = '';
    if (safeXp && !safeXp.startsWith('//') && !safeXp.startsWith('/html') && !safeXp.startsWith('/*')) {
      safeXp = `/${safeXp}`;
    }
    let safeSel = selector && !/:\w+-of-type\(0\)/.test(selector) ? selector : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';
    const volatileRc = PlayerManager._isVolatileRcCss(selector) || PlayerManager._isVolatileRcXPath(xpath);
    const preferId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(selector)
    );
    const metaCandidates = PlayerManager._normalizeLocatorMetaCandidates(locatorMeta);
    const locatorContext = PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null;

    const expr = `(function(){
      var sel = ${JSON.stringify(safeSel)};
      var xp = ${JSON.stringify(safeXp)};
      var val = ${JSON.stringify(value ?? '')};
      var autoConfirmAntSelect = ${autoConfirmAntSelect ? 'true' : 'false'};
      var volatileRc = ${volatileRc ? 'true' : 'false'};
      var locatorCandidates = ${JSON.stringify(metaCandidates)};
      var locatorContext = ${JSON.stringify(locatorContext)};
      function q(s) { try { return document.querySelector(s); } catch(e) { return null; } }
      function x(p) {
        try { return document.evaluate(p, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
        catch(e) { return null; }
      }
      function xSnapshot(p) {
        try {
          var res = document.evaluate(p, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          var nodes = [];
          for (var i = 0; i < res.snapshotLength; i++) {
            var n = res.snapshotItem(i);
            if (n && n.nodeType === 1) nodes.push(n);
          }
          if (nodes.length === 0) return null;
          if (nodes.length === 1) return nodes[0];
          return pickTopmost(nodes);
        } catch(e) { return null; }
      }
      function vis(el) {
        if (!el) return false;
        var cur = el;
        while (cur) {
          var st = window.getComputedStyle(cur);
          if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
          if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
          cur = cur.parentElement;
        }
        var r = el.getBoundingClientRect();
        return r.width >= 1 || r.height >= 1;
      }
      function inModal(el) {
        return el && el.closest && el.closest(
          '[role="dialog"],[role="alertdialog"],dialog,' +
          '.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,' +
          '.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,' +
          '[class*="modal-wrap"],[class*="Modal__"]'
        );
      }
      function zSum(el) {
        var z = 0, cur = el;
        while (cur && cur !== document.documentElement) {
          var st = window.getComputedStyle(cur);
          if (st.position !== 'static' || cur === el) {
            var zi = parseInt(st.zIndex, 10);
            if (!isNaN(zi) && zi > z) z = zi;
          }
          cur = cur.parentElement;
        }
        return z;
      }
      function pickContext(nodes) {
        if (!locatorContext) return null;
        function norm(s) { return String(s || '').trim().replace(/\\s+/g, ' '); }
        function root(el) { if (!el || !el.closest) return el; var componentRoot = el.closest('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]'); if (componentRoot) return componentRoot; return el.closest('select,textarea,input,button,a,[role="button"]') || el; }
        function kind(el) {
          var r = root(el);
          if (!r) return '';
          var tag = String(r.tagName || '').toLowerCase();
          if (tag === 'select' || (r.getAttribute && r.getAttribute('role') === 'combobox') || (r.matches && r.matches('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle'))) return 'combobox';
          if (tag === 'input') return 'input:' + String(r.type || 'text').toLowerCase();
          if (tag === 'textarea') return 'textarea';
          if (tag === 'button' || (r.getAttribute && r.getAttribute('role') === 'button')) return 'button';
          if (tag === 'a') return 'link';
          return tag;
        }
        function labelText(el) {
          var parts = [];
          function push(v) { var t = norm(v); if (t && parts.indexOf(t) < 0) parts.push(t); }
          try {
            if (el.labels && el.labels.length) Array.prototype.forEach.call(el.labels, function(l){ push(l.textContent); });
            var by = el.getAttribute && el.getAttribute('aria-labelledby');
            if (by) by.split(/\\s+/).forEach(function(id){ var n = document.getElementById(id); push(n && n.textContent); });
            push(el.getAttribute && el.getAttribute('aria-label'));
            var own = el.closest && el.closest('label');
            if (own) push(own.textContent);
            var formItem = el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset');
            var lab = formItem && formItem.querySelector('label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"]');
            if (lab) push(lab.textContent);
          } catch (e) {}
          return parts.join(' | ');
        }
        function containerText(el) {
          try {
            var c = el && el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"]');
            return norm((c && (c.innerText || c.textContent)) || '').slice(0, 300);
          } catch (e) { return ''; }
        }
        function siblingIndex(el) {
          var r = root(el);
          if (!r || !r.parentElement) return -1;
          var selector = kind(r) === 'combobox' ? '.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"],select' : String(r.tagName || '').toLowerCase();
          try {
            var direct = Array.prototype.slice.call(r.parentElement.querySelectorAll(':scope > ' + selector));
            var di = direct.indexOf(r);
            if (di >= 0) return di;
          } catch (e1) {}
          try {
            var scope = (r.closest && r.closest('.ant-form,.ivu-form,.el-form,form,[role="form"]')) || r.parentElement;
            var all = Array.prototype.slice.call(scope.querySelectorAll(selector)).filter(vis);
            return all.indexOf(r);
          } catch (e2) { return -1; }
        }
        function score(el) {
          var r = root(el) || el;
          var out = vis(r) ? 100 : 0;
          if (locatorContext.control_kind && kind(el) === locatorContext.control_kind) out += 16;
          var expectedLabel = norm(locatorContext.label_text).toLowerCase();
          if (expectedLabel) {
            var actualLabel = labelText(el).toLowerCase();
            var ct = containerText(el).toLowerCase();
            if (actualLabel === expectedLabel) out += 80;
            else if (actualLabel && (actualLabel.indexOf(expectedLabel) >= 0 || expectedLabel.indexOf(actualLabel) >= 0)) out += 45;
            if (ct.indexOf(expectedLabel) >= 0) out += 30;
          }
          var expectedContainer = norm(locatorContext.container_text).toLowerCase();
          if (expectedContainer) {
            var ac = containerText(el).toLowerCase();
            if (ac === expectedContainer) out += 45;
            else {
              var toks = expectedContainer.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 10);
              var hits = toks.filter(function(t){ return ac.indexOf(t) >= 0; }).length;
              if (hits) out += Math.min(35, hits * 7);
            }
          }
          var expectedIndex = Number(locatorContext.sibling_index);
          if (Number.isInteger(expectedIndex) && expectedIndex >= 0) {
            var actualIndex = siblingIndex(el);
            if (actualIndex === expectedIndex) out += 55;
            else if (actualIndex >= 0) out -= Math.min(24, Math.abs(actualIndex - expectedIndex) * 8);
          }
          if (locatorContext.table) {
            var trow = el.closest && el.closest('tr,.ant-table-row,.el-table__row,.ivu-table-row,[role="row"]');
            if (trow && Number.isInteger(locatorContext.table.row_index)) {
              var tsec = trow.closest('tbody') || trow.closest('thead');
              if (tsec) {
                var trows = Array.prototype.slice.call(tsec.querySelectorAll(':scope > tr'));
                var tri = trows.indexOf(trow);
                if (tri === locatorContext.table.row_index) out += 85;
                else if (tri >= 0) out -= Math.min(40, Math.abs(tri - locatorContext.table.row_index) * 12);
              }
            }
            var expectedRowT = norm(locatorContext.table.row_text).toLowerCase();
            if (expectedRowT && trow) {
              var actualRowT = norm(trow.innerText || trow.textContent).toLowerCase();
              if (actualRowT === expectedRowT) out += 70;
              else {
                var rtoks2 = expectedRowT.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 8);
                var rh2 = rtoks2.filter(function(t){ return actualRowT.indexOf(t) >= 0; }).length;
                if (rh2) out += Math.min(50, rh2 * 12);
              }
            }
          }
          if (locatorContext.rect && r.getBoundingClientRect) {
            var br = r.getBoundingClientRect();
            var cx = br.left + br.width / 2, cy = br.top + br.height / 2;
            var ecx = Number(locatorContext.rect.left || 0) + Number(locatorContext.rect.width || 0) / 2;
            var ecy = Number(locatorContext.rect.top || 0) + Number(locatorContext.rect.height || 0) / 2;
            var vw = Number(locatorContext.rect.viewportWidth || window.innerWidth || 1);
            var vh = Number(locatorContext.rect.viewportHeight || window.innerHeight || 1);
            var dist = Math.sqrt(Math.pow((cx - ecx) / vw, 2) + Math.pow((cy - ecy) / vh, 2));
            out += Math.max(0, 28 - dist * 80);
          }
          return out;
        }
        var scoredCtx = Array.prototype.slice.call(nodes || []).map(function(n, i){ return { n: n, s: score(n), i: i }; });
        scoredCtx.sort(function(a, b){ return b.s !== a.s ? b.s - a.s : a.i - b.i; });
        return scoredCtx[0] ? scoredCtx[0].n : null;
      }
      function pickTopmost(nodes) {
        var arr = Array.prototype.slice.call(nodes || []).filter(vis);
        var pool = arr.length ? arr : Array.prototype.slice.call(nodes || []);
        if (!pool.length) return null;
        var ctxPick = pickContext(pool);
        if (ctxPick) return ctxPick;
        var dlg = pool.filter(inModal);
        var use = dlg.length ? dlg : pool;
        var scored = use.map(function(n) { return { n: n, z: zSum(n) }; });
        scored.sort(function(a, b) { return b.z - a.z; });
        return scored[0] ? scored[0].n : use[0];
      }
      function pickFromCss(sel2) {
        try {
          var nl = document.querySelectorAll(sel2);
          if (!nl || nl.length === 0) return null;
          if (nl.length === 1) return nl[0];
          return pickTopmost(nl);
        } catch (e) { return null; }
      }
      function findByMeta() {
        if (!locatorCandidates || !locatorCandidates.length) return null;
        for (var i2 = 0; i2 < locatorCandidates.length; i2++) {
          var c = locatorCandidates[i2] || {};
          var t = String(c.type || '');
          var v = String(c.value || '');
          if (!t || !v) continue;
          if (t.indexOf('css_') === 0 || t.indexOf('component_root_') === 0) {
            var byCss = pickFromCss(v);
            if (byCss) return byCss;
            continue;
          }
          if (t === 'xpath_fallback') {
            var byXp = xSnapshot(v);
            if (byXp) return byXp;
            continue;
          }
          if (t === 'text_exact_tag') {
            var idx = v.indexOf('::');
            if (idx > 0) {
              var tag = v.slice(0, idx).trim().toLowerCase();
              var txt = v.slice(idx + 2).trim().replace(/\\s+/g, ' ');
              if (tag && txt) {
                var tagNodes = document.querySelectorAll(tag);
                var matched = [];
                for (var ti = 0; ti < tagNodes.length; ti++) {
                  var raw = (tagNodes[ti].textContent || '').trim().replace(/\\s+/g, ' ');
                  if (raw === txt) matched.push(tagNodes[ti]);
                }
                if (matched.length === 1) return matched[0];
                if (matched.length > 1) {
                  var best = pickTopmost(matched);
                  if (best) return best;
                }
              }
            }
          }
        }
        return null;
      }
      function antSearchFallback() {
        var inputs = Array.from(document.querySelectorAll('input.ant-select-selection-search-input'));
        var vis = inputs.filter(function(e) {
          var r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        return vis.length === 1 ? vis[0] : null;
      }
      function pickFromCssMulti(sel2, xp2) {
        try {
          var nl = document.querySelectorAll(sel2);
          var arr = Array.prototype.slice.call(nl);
          if (arr.length <= 1) return arr[0] || null;
          if (sel2.indexOf('ant-select-selection-search-input') < 0) return arr[0];
          var m = (xp2 || '').match(/\\/\\/(?:tbody|thead)\\/tr\\[(\\d+)\\]\\/(?:td|th)\\[(\\d+)\\]/i);
          if (!m) return arr[0];
          var trN = parseInt(m[1], 10);
          var tdN = parseInt(m[2], 10);
          var tables = document.querySelectorAll('table');
          for (var ti = 0; ti < tables.length; ti++) {
            var body = tables[ti].querySelector('tbody') || tables[ti];
            var tr = body.querySelector(':scope > tr:nth-of-type(' + trN + ')');
            if (!tr) continue;
            var cell = tr.querySelector(':scope > td:nth-of-type(' + tdN + '), :scope > th:nth-of-type(' + tdN + ')');
            var inp = cell && cell.querySelector('input.ant-select-selection-search-input');
            if (inp && arr.indexOf(inp) >= 0) return inp;
          }
          return arr[0];
        } catch (e) { return null; }
      }
      var el = null;
      el = findByMeta();
      if (!el && ${preferId ? 'true' : 'false'} && sel) el = q(sel);
      if (!el && xp) el = x(xp);
      if (!el && sel) el = pickFromCssMulti(sel, xp);
      if (!el && volatileRc) el = antSearchFallback();
      if (el && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var inner = el.querySelector && el.querySelector('input,textarea');
        if (inner) el = inner;
      }
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return { ok: false };
      function isTextLike(ae) {
        if (!ae) return false;
        if (ae.tagName === 'TEXTAREA') return true;
        if (ae.tagName !== 'INPUT') return false;
        var t = (ae.type || 'text').toLowerCase();
        return t === 'text' || t === 'search' || t === 'email' || t === 'password' || t === 'number' || t === 'tel' || t === 'url' || t === 'date' || t === 'time' || t === 'datetime-local' || t === '';
      }
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      var ae = document.activeElement;
      if (ae && ae !== el && isTextLike(ae)) {
        try { ae.blur(); } catch (eb) {}
      }
      try { el.focus({ preventScroll: true }); } catch (em) {}
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, val);
      else el.value = val;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: val }));
      } catch (e1) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      var isAntSel = el.classList && el.classList.contains('ant-select-selection-search-input');
      if (isAntSel && autoConfirmAntSelect) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        try {
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        } catch (ek1) {}
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      return { ok: true };
    })()`;

    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const o = res?.result?.value;
    if (!o || !o.ok) throw new Error('无法设置输入框（未找到元素或非 INPUT/TEXTAREA）');
  }

  async _dispatchKeyOnFocusedCDP(tabId, selector, xpath, key, locatorMeta = null) {
    let safeXp = xpath || '';
    if (PlayerManager._isVolatileRcXPath(safeXp)) safeXp = '';
    if (safeXp && !safeXp.startsWith('//') && !safeXp.startsWith('/html') && !safeXp.startsWith('/*')) {
      safeXp = `/${safeXp}`;
    }
    let safeSel = selector && !/:\w+-of-type\(0\)/.test(selector) ? selector : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';
    const volatileRc = PlayerManager._isVolatileRcCss(selector) || PlayerManager._isVolatileRcXPath(xpath);
    const preferId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(selector)
    );
    const metaCandidates = PlayerManager._normalizeLocatorMetaCandidates(locatorMeta);
    const locatorContext = PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null;
    const expr = `(function(){
      var sel = ${JSON.stringify(safeSel)};
      var xp = ${JSON.stringify(safeXp)};
      var k = ${JSON.stringify(key || 'Enter')};
      var volatileRc = ${volatileRc ? 'true' : 'false'};
      var locatorCandidates = ${JSON.stringify(metaCandidates)};
      var locatorContext = ${JSON.stringify(locatorContext)};
      function q(s) { try { return document.querySelector(s); } catch(e) { return null; } }
      function x(p) {
        try { return document.evaluate(p, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
        catch(e) { return null; }
      }
      function xSnapshot(p) {
        try {
          var res = document.evaluate(p, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          var nodes = [];
          for (var i = 0; i < res.snapshotLength; i++) {
            var n = res.snapshotItem(i);
            if (n && n.nodeType === 1) nodes.push(n);
          }
          if (nodes.length === 0) return null;
          if (nodes.length === 1) return nodes[0];
          return pickTopmost(nodes);
        } catch(e) { return null; }
      }
      function vis(el) {
        if (!el) return false;
        var cur = el;
        while (cur) {
          var st = window.getComputedStyle(cur);
          if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
          if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
          cur = cur.parentElement;
        }
        var r = el.getBoundingClientRect();
        return r.width >= 1 || r.height >= 1;
      }
      function inModal(el) {
        return el && el.closest && el.closest(
          '[role="dialog"],[role="alertdialog"],dialog,' +
          '.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,' +
          '.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,' +
          '[class*="modal-wrap"],[class*="Modal__"]'
        );
      }
      function zSum(el) {
        var z = 0, cur = el;
        while (cur && cur !== document.documentElement) {
          var st = window.getComputedStyle(cur);
          if (st.position !== 'static' || cur === el) {
            var zi = parseInt(st.zIndex, 10);
            if (!isNaN(zi) && zi > z) z = zi;
          }
          cur = cur.parentElement;
        }
        return z;
      }
      function pickContext(nodes) {
        if (!locatorContext) return null;
        function norm(s) { return String(s || '').trim().replace(/\\s+/g, ' '); }
        function root(el) { if (!el || !el.closest) return el; var componentRoot = el.closest('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]'); if (componentRoot) return componentRoot; return el.closest('select,textarea,input,button,a,[role="button"]') || el; }
        function kind(el) {
          var r = root(el);
          if (!r) return '';
          var tag = String(r.tagName || '').toLowerCase();
          if (tag === 'select' || (r.getAttribute && r.getAttribute('role') === 'combobox') || (r.matches && r.matches('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle'))) return 'combobox';
          if (tag === 'input') return 'input:' + String(r.type || 'text').toLowerCase();
          if (tag === 'textarea') return 'textarea';
          if (tag === 'button' || (r.getAttribute && r.getAttribute('role') === 'button')) return 'button';
          if (tag === 'a') return 'link';
          return tag;
        }
        function containerText(el) {
          try {
            var c = el && el.closest && el.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"]');
            return norm((c && (c.innerText || c.textContent)) || '').slice(0, 300);
          } catch (e) { return ''; }
        }
        function siblingIndex(el) {
          var r = root(el);
          if (!r || !r.parentElement) return -1;
          var selector = kind(r) === 'combobox' ? '.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"],select' : String(r.tagName || '').toLowerCase();
          try {
            var direct = Array.prototype.slice.call(r.parentElement.querySelectorAll(':scope > ' + selector));
            var di = direct.indexOf(r);
            if (di >= 0) return di;
          } catch (e1) {}
          try {
            var scope = (r.closest && r.closest('.ant-form,.ivu-form,.el-form,form,[role="form"]')) || r.parentElement;
            var all = Array.prototype.slice.call(scope.querySelectorAll(selector)).filter(vis);
            return all.indexOf(r);
          } catch (e2) { return -1; }
        }
        function score(el) {
          var r = root(el) || el;
          var out = vis(r) ? 100 : 0;
          if (locatorContext.control_kind && kind(el) === locatorContext.control_kind) out += 16;
          var expectedContainer = norm(locatorContext.container_text).toLowerCase();
          if (expectedContainer) {
            var ac = containerText(el).toLowerCase();
            if (ac === expectedContainer) out += 45;
            else {
              var toks = expectedContainer.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 10);
              var hits = toks.filter(function(t){ return ac.indexOf(t) >= 0; }).length;
              if (hits) out += Math.min(35, hits * 7);
            }
          }
          var expectedIndex = Number(locatorContext.sibling_index);
          if (Number.isInteger(expectedIndex) && expectedIndex >= 0) {
            var actualIndex = siblingIndex(el);
            if (actualIndex === expectedIndex) out += 55;
            else if (actualIndex >= 0) out -= Math.min(24, Math.abs(actualIndex - expectedIndex) * 8);
          }
          if (locatorContext.table) {
            var trow = el.closest && el.closest('tr,.ant-table-row,.el-table__row,.ivu-table-row,[role="row"]');
            if (trow && Number.isInteger(locatorContext.table.row_index)) {
              var tsec = trow.closest('tbody') || trow.closest('thead');
              if (tsec) {
                var trows = Array.prototype.slice.call(tsec.querySelectorAll(':scope > tr'));
                var tri = trows.indexOf(trow);
                if (tri === locatorContext.table.row_index) out += 85;
                else if (tri >= 0) out -= Math.min(40, Math.abs(tri - locatorContext.table.row_index) * 12);
              }
            }
            var expectedRowT = norm(locatorContext.table.row_text).toLowerCase();
            if (expectedRowT && trow) {
              var actualRowT = norm(trow.innerText || trow.textContent).toLowerCase();
              if (actualRowT === expectedRowT) out += 70;
              else {
                var rtoks2 = expectedRowT.split(/\\s+/).filter(function(t){ return t.length >= 2; }).slice(0, 8);
                var rh2 = rtoks2.filter(function(t){ return actualRowT.indexOf(t) >= 0; }).length;
                if (rh2) out += Math.min(50, rh2 * 12);
              }
            }
          }
          if (locatorContext.rect && r.getBoundingClientRect) {
            var br = r.getBoundingClientRect();
            var cx = br.left + br.width / 2, cy = br.top + br.height / 2;
            var ecx = Number(locatorContext.rect.left || 0) + Number(locatorContext.rect.width || 0) / 2;
            var ecy = Number(locatorContext.rect.top || 0) + Number(locatorContext.rect.height || 0) / 2;
            var vw = Number(locatorContext.rect.viewportWidth || window.innerWidth || 1);
            var vh = Number(locatorContext.rect.viewportHeight || window.innerHeight || 1);
            var dist = Math.sqrt(Math.pow((cx - ecx) / vw, 2) + Math.pow((cy - ecy) / vh, 2));
            out += Math.max(0, 28 - dist * 80);
          }
          return out;
        }
        var scoredCtx = Array.prototype.slice.call(nodes || []).map(function(n, i){ return { n: n, s: score(n), i: i }; });
        scoredCtx.sort(function(a, b){ return b.s !== a.s ? b.s - a.s : a.i - b.i; });
        return scoredCtx[0] ? scoredCtx[0].n : null;
      }
      function pickTopmost(nodes) {
        var arr = Array.prototype.slice.call(nodes || []).filter(vis);
        var pool = arr.length ? arr : Array.prototype.slice.call(nodes || []);
        if (!pool.length) return null;
        var ctxPick = pickContext(pool);
        if (ctxPick) return ctxPick;
        var dlg = pool.filter(inModal);
        var use = dlg.length ? dlg : pool;
        var scored = use.map(function(n) { return { n: n, z: zSum(n) }; });
        scored.sort(function(a, b) { return b.z - a.z; });
        return scored[0] ? scored[0].n : use[0];
      }
      function pickFromCss(sel2) {
        try {
          var nl = document.querySelectorAll(sel2);
          if (!nl || nl.length === 0) return null;
          if (nl.length === 1) return nl[0];
          return pickTopmost(nl);
        } catch (e) { return null; }
      }
      function findByMeta() {
        if (!locatorCandidates || !locatorCandidates.length) return null;
        for (var i2 = 0; i2 < locatorCandidates.length; i2++) {
          var c = locatorCandidates[i2] || {};
          var t = String(c.type || '');
          var v = String(c.value || '');
          if (!t || !v) continue;
          if (t.indexOf('css_') === 0 || t.indexOf('component_root_') === 0) {
            var byCss = pickFromCss(v);
            if (byCss) return byCss;
            continue;
          }
          if (t === 'xpath_fallback') {
            var byXp = xSnapshot(v);
            if (byXp) return byXp;
            continue;
          }
          if (t === 'text_exact_tag') {
            var idx = v.indexOf('::');
            if (idx > 0) {
              var tag = v.slice(0, idx).trim().toLowerCase();
              var txt = v.slice(idx + 2).trim().replace(/\\s+/g, ' ');
              if (tag && txt) {
                var tagNodes = document.querySelectorAll(tag);
                var matched = [];
                for (var ti = 0; ti < tagNodes.length; ti++) {
                  var raw = (tagNodes[ti].textContent || '').trim().replace(/\\s+/g, ' ');
                  if (raw === txt) matched.push(tagNodes[ti]);
                }
                if (matched.length === 1) return matched[0];
                if (matched.length > 1) {
                  var best = pickTopmost(matched);
                  if (best) return best;
                }
              }
            }
          }
        }
        return null;
      }
      function antSearchFallback() {
        var inputs = Array.from(document.querySelectorAll('input.ant-select-selection-search-input'));
        var vis = inputs.filter(function(e) {
          var r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        return vis.length === 1 ? vis[0] : null;
      }
      function pickFromCssMulti2(sel2, xp2) {
        try {
          var nl = document.querySelectorAll(sel2);
          var arr = Array.prototype.slice.call(nl);
          if (arr.length <= 1) return arr[0] || null;
          if (sel2.indexOf('ant-select-selection-search-input') < 0) return arr[0];
          var m2 = (xp2 || '').match(/\\/\\/(?:tbody|thead)\\/tr\\[(\\d+)\\]\\/(?:td|th)\\[(\\d+)\\]/i);
          if (!m2) return arr[0];
          var trN2 = parseInt(m2[1], 10);
          var tdN2 = parseInt(m2[2], 10);
          var tables2 = document.querySelectorAll('table');
          for (var tj = 0; tj < tables2.length; tj++) {
            var body2 = tables2[tj].querySelector('tbody') || tables2[tj];
            var tr2 = body2.querySelector(':scope > tr:nth-of-type(' + trN2 + ')');
            if (!tr2) continue;
            var cell2 = tr2.querySelector(':scope > td:nth-of-type(' + tdN2 + '), :scope > th:nth-of-type(' + tdN2 + ')');
            var inp2 = cell2 && cell2.querySelector('input.ant-select-selection-search-input');
            if (inp2 && arr.indexOf(inp2) >= 0) return inp2;
          }
          return arr[0];
        } catch (e) { return null; }
      }
      var el = null;
      el = findByMeta();
      if (!el && ${preferId ? 'true' : 'false'} && sel) el = q(sel);
      if (!el && xp) el = x(xp);
      if (!el && sel) el = pickFromCssMulti2(sel, xp);
      if (!el && volatileRc) el = antSearchFallback();
      if (!el) {
        var active = document.activeElement;
        var activeTextLike = false;
        if (active) {
          var activeTag = String(active.tagName || '').toUpperCase();
          var activeType = String(active.type || 'text').toLowerCase();
          activeTextLike = activeTag === 'TEXTAREA'
            || (activeTag === 'INPUT' && (
              activeType === 'text' || activeType === 'search' || activeType === 'email'
              || activeType === 'password' || activeType === 'number' || activeType === 'tel'
              || activeType === 'url' || activeType === 'date' || activeType === 'time'
              || activeType === 'datetime-local' || activeType === ''
            ))
            || !!active.isContentEditable
            || !!(active.closest && active.closest('[contenteditable="true"]'));
        }
        if (activeTextLike) {
          el = active.isContentEditable ? active : ((active.closest && active.closest('[contenteditable="true"]')) || active);
        }
      }
      if (!el) return { ok: false };
      function isTextLike2(ae) {
        if (!ae) return false;
        if (ae.tagName === 'TEXTAREA') return true;
        if (ae.tagName !== 'INPUT') return false;
        var t = (ae.type || 'text').toLowerCase();
        return t === 'text' || t === 'search' || t === 'email' || t === 'password' || t === 'number' || t === 'tel' || t === 'url' || t === 'date' || t === 'time' || t === 'datetime-local' || t === '';
      }
      function activateKeyTarget(el2) {
        if (isTextLike2(el2)) {
          try { el2.focus({ preventScroll: true }); } catch (ef) {}
          return;
        }
        var opts = { bubbles: false, cancelable: true, view: window };
        function stop(e) { e.stopPropagation(); }
        el2.addEventListener('mousedown', stop, { once: true });
        el2.addEventListener('mouseup', stop, { once: true });
        el2.addEventListener('click', stop, { once: true });
        el2.dispatchEvent(new MouseEvent('mousedown', opts));
        el2.dispatchEvent(new MouseEvent('mouseup', opts));
        el2.dispatchEvent(new MouseEvent('click', opts));
        try { el2.focus({ preventScroll: true }); } catch (ef2) {}
      }
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      var ae2 = document.activeElement;
      if (ae2 && ae2 !== el && isTextLike2(ae2)) {
        try { ae2.blur(); } catch (eb2) {}
      }
      try { activateKeyTarget(el); } catch (em2) {}
      return { ok: true };
    })()`;
    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const o = res?.result?.value;
    if (!o || !o.ok) throw new Error('按键失败：未找到目标元素');
    await this._dispatchKeyCDP(tabId, key || 'Enter');
  }

  async _dispatchKeyCDP(tabId, key) {
    const k = String(key || 'Enter');
    const defs = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
    };
    const def = defs[k] || { key: k, code: k, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
    await this._cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.nativeVirtualKeyCode,
      text: def.text || '',
      unmodifiedText: def.text || '',
    });
    await this._cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.nativeVirtualKeyCode,
    });
  }

  async _dispatchShortcutCDP(tabId, key, code, windowsVirtualKeyCode, modifiers) {
    const payload = {
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      modifiers,
    };
    await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...payload });
    await this._sleep(30);
    await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
  }

  async _setMonacoValueCDP(tabId, selector, xpath, value, locatorMeta = null) {
    const boxResult = await this._getElementBoxResult(tabId, selector, xpath, '', 6000, false, locatorMeta);
    if (!boxResult || !boxResult.ok || !boxResult.box) {
      throw new Error(this._formatElementWaitFailure(boxResult, selector, xpath));
    }
    const { x, y } = boxResult.box;
    await this._cdpClick(tabId, x, y);
    await this._sleep(100);
    // Monaco follows platform shortcuts; dispatch Meta+A and Ctrl+A so clear works on macOS and Windows/Linux.
    await this._dispatchShortcutCDP(tabId, 'a', 'KeyA', 65, 4);
    await this._sleep(40);
    await this._dispatchShortcutCDP(tabId, 'a', 'KeyA', 65, 2);
    await this._sleep(40);
    await this._dispatchKeyCDP(tabId, 'Backspace');
    const text = String(value ?? '');
    if (text) {
      await this._sleep(60);
      await this._cdpSend(tabId, 'Input.insertText', { text });
    }
  }

  static _sameRecordedTarget(a, b) {
    if (!a || !b) return false;
    const sa = String(a.target_selector || '').trim();
    const sb = String(b.target_selector || '').trim();
    const xa = String(a.target_xpath || '').trim();
    const xb = String(b.target_xpath || '').trim();
    if (sa && sb && sa === sb) return true;
    if (xa && xb && xa === xb) return true;
    return false;
  }

  static _stepLooksLikeAntSelectSearch(step) {
    const meta = typeof step?.locator_meta === 'string'
      ? step.locator_meta
      : JSON.stringify(step?.locator_meta || '');
    return [
      step?.target_selector,
      step?.target_xpath,
      meta,
    ].join(' ').includes('ant-select-selection-search-input');
  }

  static _stepLooksLikeMonacoEditor(step) {
    const metaObj = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    if (metaObj?.context?.editor === 'monaco') return true;
    const raw = [
      step?.target_selector,
      step?.target_xpath,
      typeof step?.locator_meta === 'string' ? step.locator_meta : JSON.stringify(step?.locator_meta || ''),
    ].join(' ');
    return raw.includes('monaco-editor') || raw.includes('monaco-diff-editor');
  }

  static _nextStepIsSameTargetEnter(step, nextStep) {
    return String(step?.action_type || '').trim().toLowerCase() === 'input'
      && String(nextStep?.action_type || '').trim().toLowerCase() === 'key'
      && String(nextStep?.value || 'Enter') === 'Enter'
      && PlayerManager._sameRecordedTarget(step, nextStep);
  }

  async _executeStepCDP(tabId, step, baseUrl, locale = 'zh', nextStep = null, hooks = {}) {
    if (step.wait_before) await this._sleep(step.wait_before);
    switch (step.action_type) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        const revealTrigger = PlayerManager._extractRevealTriggerFromLocatorMeta(step.locator_meta);
        if (revealTrigger) {
          try { await this._activateRevealTriggerCDP(tabId, revealTrigger); } catch (e) { /* ignore */ }
          await this._sleep(420);
        }
        // 自动识别浮层选项步骤（兼容旧录制数据中没有 is_overlay 标记的情况）
        // 判断依据：
        //   1. 明确标记了 is_overlay
        //   2. CSS 选择器为空且有文本值（录制器对浮层返回空 CSS）
        //   3. XPath 中含 normalize-space() （文本定位模式，录制器专门为浮层生成的）
        const looksLikeOverlay = (step.is_overlay && String(step.value || '').trim() !== '')
          || (!step.target_selector && step.value)
          || (step.target_xpath && step.target_xpath.includes('normalize-space()'));

        let box;
        if (looksLikeOverlay) {
          box = await this._clickOverlayItem(tabId, step, locale, { hadReveal: !!revealTrigger });
        } else {
          // 普通点击：检查 disabled 状态，等待组件就绪（级联 Select 场景）
          const boxResult = await this._getElementBoxResult(
            tabId, step.target_selector, step.target_xpath, step.value || '', 6000, false, step.locator_meta
          );
          box = boxResult && boxResult.ok ? boxResult.box : null;
          if (!box) {
            throw new Error(this._formatElementWaitFailure(boxResult, step.target_selector, step.target_xpath));
          }
        }

        // scrollIntoView 后等一帧让浏览器重排，再重取坐标（防止滚动偏差）
        await this._sleep(120);
        const freshBox = await this._cdpSend(tabId, 'Runtime.evaluate', {
          expression: looksLikeOverlay
            ? PlayerManager._findInOverlayCode(step.value || '')
            : this._buildFindCode(step.target_selector, step.target_xpath, '', false, step.locator_meta),
          returnByValue: true,
        }).then(r => r?.result?.value || null);
        const merged = freshBox || box;
        const { x, y } = merged;
        if (merged && merged.hitOk === false) {
          const base =
            '目标不可点击：视口中心点被其它元素遮挡（常见于非预期弹窗、遮罩或浮层；与 Playwright 的 hit-test 类似）。请先关闭遮挡物或调整用例。';
          if (looksLikeOverlay) {
            throw new Error(`${base}\n  选项文本: ${step.value || ''}`);
          }
          const treeDiag = await this._getTreeWaitDiagnosticSuffix(tabId, step.locator_meta);
          throw new Error(`${base}${treeDiag}\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}`);
        }

        if (typeof hooks.beforeActionScreenshot === 'function') {
          await hooks.beforeActionScreenshot();
        }

        await this._cdpClick(tabId, x, y, {
          button: step.action_type === 'right_click' ? 'right' : 'left',
          clickCount: step.action_type === 'double_click' ? 2 : 1,
        });

        if (looksLikeOverlay) await this._sleep(400);
        break;
      }

      case 'input': {
        const deadline = Date.now() + 8000;
        let lastErr = null;
        while (Date.now() < deadline) {
          await this._throwIfPageError(tabId);
          try {
            if (PlayerManager._stepLooksLikeMonacoEditor(step)) {
              await this._setMonacoValueCDP(
                tabId,
                step.target_selector,
                step.target_xpath,
                step.value || '',
                step.locator_meta
              );
            } else {
              await this._setInputValueCDP(
                tabId,
                step.target_selector,
                step.target_xpath,
                step.value || '',
                step.locator_meta,
                !(
                  PlayerManager._stepLooksLikeAntSelectSearch(step)
                  && PlayerManager._nextStepIsSameTargetEnter(step, nextStep)
                )
              );
            }
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            await this._sleep(400);
          }
        }
        if (lastErr) throw new Error(`输入失败（等待超时）\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}\n  ${lastErr.message}`);
        await this._sleep(120);
        break;
      }

      case 'key': {
        const deadline = Date.now() + 6500;
        let lastErr = null;
        while (Date.now() < deadline) {
          await this._throwIfPageError(tabId);
          try {
            await this._dispatchKeyOnFocusedCDP(
              tabId, step.target_selector, step.target_xpath, step.value || 'Enter', step.locator_meta
            );
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            await this._sleep(400);
          }
        }
        if (lastErr) throw new Error(`按键失败\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}`);
        await this._sleep(80);
        break;
      }

      case 'scroll': {
        const scrollY = step.value ? parseInt(step.value) : 300;
        await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: scrollY });
        break;
      }

      case 'hover': {
        const box = await this._getElementBox(tabId, step.target_selector, step.target_xpath, '', 5000, false, step.locator_meta);
        if (box) {
          await this._sleep(120);
          const freshBox = await this._getElementBox(
            tabId, step.target_selector, step.target_xpath, '', 2000, false, step.locator_meta
          );
          const merged = freshBox || box;
          if (merged.hitOk === false) {
            const treeDiag = await this._getTreeWaitDiagnosticSuffix(tabId, step.locator_meta);
            throw new Error(
              `目标不可悬停：视口中心点被其它元素遮挡（常见于非预期弹窗、遮罩或浮层）。请先关闭遮挡物或调整用例。${treeDiag}\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}`,
            );
          }
          if (typeof hooks.beforeActionScreenshot === 'function') {
            await hooks.beforeActionScreenshot();
          }
          await this._cdpSend(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: merged.x,
            y: merged.y,
            button: 'none',
          });
        }
        await this._sleep(300);
        break;
      }

      default:
        await this._executeStepDOM(tabId, step, locale);
    }
  }

  // =========================================================
  // DOM 降级执行
  // =========================================================
  async _executeStepDOM(tabId, step, locale = 'zh', nextStep = null) {
    const result = await new Promise((resolve) => {
      const pageErrorCheckEnabled = !(this._pageErrorCheckEnabledByTab && this._pageErrorCheckEnabledByTab.get(tabId) === false);
      chrome.tabs.sendMessage(tabId, { type: 'AT_EXECUTE_STEP', step, nextStep, locale, pageErrorCheckEnabled }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
    // 须严格为 true：避免 undefined / 丢包被当成成功
    if (result == null || result.ok !== true) {
      const errText = (result && result.error) || '步骤执行失败（页面脚本无有效响应，请刷新目标页后重试）';
      console.error('[Player] DOM 步骤失败', step.action_type, result);
      throw new Error(localizePlaybackError(locale, errText));
    }
  }

  // =========================================================
  // 工具方法
  // =========================================================
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _waitForTabLoad(tabId) {
    return new Promise((resolve) => {
      const check = async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || tab.status === 'complete') { resolve(); return; }
        setTimeout(check, 300);
      };
      setTimeout(check, 500);
    });
  }

  _displayMode() {
    if (this.state.mode === 'recording') return 'recording';
    if ((this.state.activePlayCount || 0) > 0) return 'playing';
    return 'idle';
  }

  _notifyPopup(statusText) {
    chrome.runtime.sendMessage({
      type: 'AT_STATE_CHANGED',
      state: { mode: this._displayMode(), statusText, testCaseId: this.state.testCaseId },
    }).catch(() => {});
  }

  _showNotification(title, message) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message,
    });
  }
}
