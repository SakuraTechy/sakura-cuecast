/**
 * 回放管理器
 * 支持双模式：CDP（chrome.debugger）+ DOM 降级
 */

import {
  getCuecastCapabilities,
  isCuecastCdpAction,
} from './canonical-action-registry.js';
import {
  CuecastVariableContext,
  evaluateArithmeticExpression,
  formatFormulaValue,
  formatVariableDate,
  isCuecastLocalVariableAction,
  toBoolean,
} from './variable-context.js';
import { attachOperationDiagnostic } from './operation-diagnostics.js';
import { isPdfViewerAttributeTarget, readPdfViewerAttribute } from './cdp-pdf-viewer.js';

/** 改为 true 后：打开扩展 Service Worker 控制台可看到 AI 步骤的节点数与操作计划 */
const DEBUG_AI_NATURAL = false;
const EXECUTION_FILE_DOWNLOADS_KEY = 'cuecastExecutionFileDownloadsByBatch';

/** 与后端/库里的 action_type 对齐（去空格、小写），避免编辑保存时偶发空格导致不走智能分支 */
function isAiNaturalStep(step) {
  const t = String(step?.action_type ?? '')
    .trim()
    .toLowerCase();
  return t === 'ai_natural';
}

/** 基础设施步骤由扩展后台委托受控执行器，绝不能发送到内容脚本或 CDP 页面上下文。 */
function isInfrastructureStep(step) {
  return [
    'server_command',
    'database_sql',
    'database_native',
    'host_command',
    'host_file_lookup',
    'host_file_delete',
    'host_pointer_move',
    'server_file_upload',
    'global_variable_system_info',
    'global_variable_available_ip',
    'global_variable_property',
  ].includes(
    String(step?.action_type ?? '').trim().toLowerCase(),
  );
}

function isInfrastructureTerminalStatus(status) {
  return ['passed', 'failed', 'cancelled', 'canceled', 'timeout'].includes(String(status || '').trim().toLowerCase());
}

function unwrapInfrastructureTask(response) {
  const task = response?.data && typeof response.data === 'object' ? response.data : response;
  return task && typeof task === 'object' ? task : {};
}

function normalizeLocale(locale) {
  const raw = String(locale || '').trim().toLowerCase();
  return raw.startsWith('en') ? 'en' : 'zh';
}

function trByLocale(locale, zh, en) {
  return normalizeLocale(locale) === 'en' ? (en || zh) : zh;
}

/** 执行历史只保存会话决策，不保存 Context、target、tab 或认证状态标识。 */
function buildSessionTransitionAudit(transition, opts = {}) {
  const source = transition && typeof transition === 'object' ? transition : {};
  const requestedMode = String(source.requestedMode || opts.sessionMode || '');
  const appliedMode = String(source.appliedMode || opts.sessionMode || '');
  const browserSessionSource = String(source.browserSessionSource || opts.browserSessionSource || '');
  if (!requestedMode && !appliedMode && !browserSessionSource) return null;
  return {
    requestedMode,
    appliedMode,
    browserSessionSource,
    reset: source.reset === true,
    resetCount: Number(source.resetCount) || 0,
    resetReason: String(source.resetReason || ''),
    navigationDecision: String(source.navigationDecision || opts.navigationDecision || ''),
    authStateCommitted: source.authStateCommitted === true,
  };
}

function formatPlatformDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
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
const DEFAULT_TAB_LOAD_TIMEOUT_MS = 30000;
const RECORD_CONTEXT_PREPARE_TIMEOUT_MS = 45000;
const CDP_COMMAND_TIMEOUT_MS = 20000;
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
  const mode = normalizeViewportMode(input.viewportMode ?? input.viewport_mode, 'maximized');
  if (mode === 'custom') {
    return {
      mode,
      width: normalizeViewportDimension(input.viewportWidth ?? input.viewport_width, DEFAULT_VIEWPORT_WIDTH),
      height: normalizeViewportDimension(input.viewportHeight ?? input.viewport_height, DEFAULT_VIEWPORT_HEIGHT),
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

function positiveInteger(value, fallback) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function enabledFlag(value) {
  return value === true || value === 1 || String(value ?? '').trim().toLowerCase() === 'true';
}

function continueOnFailureEnabled(step) {
  if (!step || typeof step !== 'object') return false;
  return enabledFlag(step.continue_on_failure ?? step.continueOnFailure);
}

export function resolvePlaybackBrowserBootstrap(value) {
  const mode = String(value || 'launch').trim().toLowerCase();
  if (!['launch', 'attach', 'none'].includes(mode)) {
    throw new Error(`不支持的 browser_bootstrap_mode：${mode || '(empty)'}`);
  }
  return {
    mode,
    initializeBrowser: mode !== 'none',
  };
}

/**
 * Admin 批次必须使用绑定 revision 返回的最终配置；客户端传入值仅保留给 popup/test-lab 兼容链路。
 */
export function resolvePlaybackRuntimeConfig(testCase, opts = {}, useAdminCase = false) {
  const batchId = String(opts.batchId || '').trim();
  const rawEffectiveConfig = testCase?.effectiveExecutionConfig ?? testCase?.effective_execution_config;
  const frozenRequired = useAdminCase && batchId !== '';
  const hasFrozenConfig = rawEffectiveConfig
    && typeof rawEffectiveConfig === 'object'
    && !Array.isArray(rawEffectiveConfig)
    && Object.keys(rawEffectiveConfig).length > 0;
  if (frozenRequired && !hasFrozenConfig) {
    throw new Error('Admin 批次未返回 EffectiveExecutionConfig，拒绝在 CueCast 端重新合并默认值');
  }
  if (frozenRequired) {
    const browserBootstrap = resolvePlaybackBrowserBootstrap(rawEffectiveConfig.browser_bootstrap_mode);
    return {
      frozen: true,
      executionConfig: { ...rawEffectiveConfig },
      startUrl: String(rawEffectiveConfig.start_url || '').trim(),
      browserBootstrapMode: browserBootstrap.mode,
      ignoreHttpsErrors: enabledFlag(rawEffectiveConfig.ignore_https_errors),
      windowSizeMode: rawEffectiveConfig.window_size_mode,
      viewportWidth: rawEffectiveConfig.viewport_width,
      viewportHeight: rawEffectiveConfig.viewport_height,
      pageErrorCheckEnabled: enabledFlag(rawEffectiveConfig.page_error_check_enabled),
      screenshotMode: String(rawEffectiveConfig.screenshot_mode || 'standard').trim().toLowerCase(),
      stepTimeoutMs: positiveInteger(rawEffectiveConfig.step_timeout_ms, 6000),
      caseTimeoutMs: positiveInteger(rawEffectiveConfig.case_timeout_ms, 600000),
    };
  }
  return {
    frozen: false,
    executionConfig: null,
    startUrl: String(opts.startUrl ?? testCase?.start_url ?? testCase?.startUrl ?? '').trim(),
    browserBootstrapMode: 'launch',
    ignoreHttpsErrors: enabledFlag(opts.ignoreHttpsErrors ?? testCase?.ignore_https_errors ?? false),
    windowSizeMode: opts.viewportMode ?? testCase?.window_size_mode ?? testCase?.viewport_mode,
    viewportWidth: opts.viewportWidth ?? testCase?.viewport_width,
    viewportHeight: opts.viewportHeight ?? testCase?.viewport_height,
    pageErrorCheckEnabled: enabledFlag(opts.pageErrorCheckEnabled ?? testCase?.page_error_check_enabled ?? 0),
    screenshotMode: String(testCase?.screenshot_mode || 'standard').trim().toLowerCase(),
    stepTimeoutMs: 6000,
    caseTimeoutMs: 600000,
  };
}

function normalizeStartStepIndex(value, stepCount) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  if (n >= stepCount) return -1;
  return n;
}

function normalizeStopAfterStepIndex(value, stepCount) {
  if (value == null || value === '') return stepCount - 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return -1;
  if (n >= stepCount) return stepCount - 1;
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
    /** Admin 执行文件按批次保留到 END/ABORT，避免网页后续提交时文件已被删除。 */
    this._executionFileDownloadsByBatch = new Map();
    // MV3 Service Worker 生命周期较短；同一 Admin 会话内限频上报，唤醒或换会话后会重新握手。
    this._capabilityHandshake = null;
    // 以下状态按受控 tab 隔离，避免并发回放之间的 iframe、隐式等待和鼠标坐标互相污染。
    this._frameStackByTab = new Map();
    this._frameContextByTab = new Map();
    this._implicitWaitMsByTab = new Map();
    this._stepTimeoutMsByTab = new Map();
    this._caseDeadlineByTab = new Map();
    this._pointerPositionByTab = new Map();
    // CDP 的 dialog 只能通过 Page.handleJavaScriptDialog 结束；缓存 opening 事件用于处理
    // “点击触发弹窗 → 下一条 dialog_* 步骤”的正常时序，而不是在页面上下文伪造 alert。
    this._dialogOpeningByTab = new Map();
    this._pendingDialogPromptByTab = new Map();
    if (chrome.debugger?.onEvent?.addListener) {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method === 'Page.javascriptDialogOpening' && source?.tabId != null) {
          this._dialogOpeningByTab.set(source.tabId, { ...params, openedAt: Date.now() });
        }
      });
    }
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

  async _registerExecutionFileDownloads(batchId, downloadIds) {
    const normalizedBatchId = String(batchId || '').trim();
    const ids = (Array.isArray(downloadIds) ? downloadIds : [])
      .filter((id) => id != null)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!normalizedBatchId || !ids.length) return;
    const current = this._executionFileDownloadsByBatch.get(normalizedBatchId) || [];
    const merged = [...new Set([...current, ...ids])];
    this._executionFileDownloadsByBatch.set(normalizedBatchId, merged);
    const session = chrome.storage?.session;
    if (!session?.get || !session?.set) return;
    const stored = await session.get(EXECUTION_FILE_DOWNLOADS_KEY).catch(() => ({}));
    const persisted = stored?.[EXECUTION_FILE_DOWNLOADS_KEY] || {};
    persisted[normalizedBatchId] = [...new Set([...(persisted[normalizedBatchId] || []), ...merged])];
    await session.set({ [EXECUTION_FILE_DOWNLOADS_KEY]: persisted });
  }

  async cleanupExecutionFiles(batchId, options = {}) {
    const normalizedBatchId = String(batchId || '').trim();
    if (!normalizedBatchId) return;
    const removeFiles = options.removeFiles !== false;
    const session = chrome.storage?.session;
    const stored = session?.get
      ? await session.get(EXECUTION_FILE_DOWNLOADS_KEY).catch(() => ({}))
      : {};
    const persisted = stored?.[EXECUTION_FILE_DOWNLOADS_KEY] || {};
    const downloadIds = [...new Set([
      ...(this._executionFileDownloadsByBatch.get(normalizedBatchId) || []),
      ...(persisted[normalizedBatchId] || []),
    ])];
    if (removeFiles && downloadIds.length) {
      await Promise.all(downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
    }
    this._executionFileDownloadsByBatch.delete(normalizedBatchId);
    if (session?.set) {
      delete persisted[normalizedBatchId];
      await session.set({ [EXECUTION_FILE_DOWNLOADS_KEY]: persisted }).catch(() => {});
    }
  }

  /** 页面异步重渲染会使 DOM nodeId/objectId 失效，文件上传可重新定位后安全重试。 */
  static _isCdpStaleFileInputError(err) {
    const message = String(err?.message || err).toLowerCase();
    return message.includes('could not find node with given id')
      || message.includes('could not find object with given id');
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

  async handlePlayTabClosed(tabId) {
    for (const ctx of this._playContexts) {
      const registryEntry = ctx.tabRegistry && typeof ctx.tabRegistry.entries === 'function'
        ? [...ctx.tabRegistry.entries()].find(([, item]) => Number(item?.tabId) === Number(tabId))
        : null;
      if (registryEntry) {
        ctx.tabRegistry.delete(registryEntry[0]);
        if (Number(ctx.tabId) === Number(tabId)) ctx.tabId = null;
        const alive = await this._livePlaybackTabEntries(ctx);
        if (alive.length > 0) continue;
        ctx.closedAllTabs = true;
        ctx.stopped = true;
        continue;
      }
      if (Number(ctx.tabId) === Number(tabId)) {
        ctx.tabId = null;
        const alive = await this._livePlaybackTabEntries(ctx);
        if (alive.length > 0) continue;
        ctx.closedAllTabs = true;
        ctx.stopped = true;
      }
    }
  }

  async _livePlaybackTabEntries(ctx) {
    if (!ctx?.tabRegistry || typeof ctx.tabRegistry.entries !== 'function') return [];
    const live = [];
    for (const [index, item] of ctx.tabRegistry.entries()) {
      if (item?.tabId == null) {
        ctx.tabRegistry.delete(index);
        continue;
      }
      const tab = await chrome.tabs.get(item.tabId).catch(() => null);
      if (tab) {
        live.push([index, item, tab]);
      } else {
        ctx.tabRegistry.delete(index);
        if (Number(ctx.tabId) === Number(item.tabId)) ctx.tabId = null;
      }
    }
    return live;
  }

  async _ensurePlayableTabBeforeStep(ctx, playTabId, actionType, locale = 'zh') {
    const tabId = Number(playTabId);
    if (Number.isInteger(tabId) && tabId > 0) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) return tabId;
    }
    ctx.tabId = null;
    const live = await this._livePlaybackTabEntries(ctx);
    if (live.length > 0 && actionType === 'switch_context') {
      return null;
    }
    if (live.length > 0) {
      throw new Error(trByLocale(
        locale,
        '当前回放标签页已关闭，且下一步不是切换标签页，无法继续执行',
        'Current playback tab was closed and the next step is not a tab switch, so playback cannot continue',
      ));
    }
    ctx.closedAllTabs = true;
    throw new Error(trByLocale(locale, '回放标签页已全部关闭', 'All playback tabs have been closed'));
  }

  async start(testCaseId, startUrl, opts = {}) {
    const runLocale = normalizeLocale(opts.locale);
    let ctx = null;
    let playTabId = null;
    let browserSessionFinalized = false;
    let browserSessionPrepared = false;
    let sessionTransition = null;
    let sessionNavigationDecision = '';
    let sessionErrorCode = '';
    let batchVariableSession = null;
    let playbackEndPayload = {
      type: 'AT_PLAYBACK_END',
      testCaseId,
      tabId: null,
      ok: false,
      error: '',
      purpose: String(opts.purpose || ''),
    };

    const adminCaseKey = String(opts.adminCaseKey || '').trim();
    const useAdminCase = Boolean(adminCaseKey) || String(opts.dataSource || '').trim().toLowerCase() === 'admin';
    if (useAdminCase) {
      // 能力目录仅影响 Admin 的可用性显示；旧 Admin 或网络异常绝不能阻断既有 CDP 回放。
      void this._reportOperationCapabilities(opts);
    }
    const sourceCaseKey = adminCaseKey || String(testCaseId || '').trim();
    const runStartedAt = Date.now();
    const safeCaseKey = sourceCaseKey.replace(/[^A-Za-z0-9._-]/g, '_') || 'case';
    const runId = String(opts.executionId || '').trim() || `${safeCaseKey}-${runStartedAt}`;
    let playbackOutcome = null;
    let progressFinished = false;
    let progressSequence = 0;
    let progressStepTotal = 0;
    const progressLogs = [];
    const broadcastProgress = (phase, payload = {}) => {
      if (!useAdminCase) return;
      const timestamp = new Date().toISOString();
      const sequence = ++progressSequence;
      if (payload.log?.message) {
        progressLogs.push({
          sequence,
          timestamp,
          level: payload.log.level || 'info',
          phase: payload.log.phase || phase,
          message: payload.log.message,
          detail: Boolean(payload.log.detail),
        });
      }
      this._broadcastPlayback({
        type: 'AT_PLAYBACK_PROGRESS',
        adminCaseKey: sourceCaseKey,
        batchId: opts.batchId || '',
        executionId: opts.executionId || runId,
        executor: 'extension-cdp',
        runId,
        sequence,
        phase,
        timestamp,
        stepTotal: progressStepTotal,
        ...payload,
      });
    };
    let executionSnapshot = {
      project_environment_id: opts.projectEnvironmentId ?? '',
      batch_id: opts.batchId ?? '',
      window_size_mode: opts.viewportMode ?? '',
      viewport_width: opts.viewportWidth ?? null,
      viewport_height: opts.viewportHeight ?? null,
      page_error_check_enabled: opts.pageErrorCheckEnabled ?? null,
    };
    broadcastProgress('log', {
      log: { level: 'info', phase: 'admin', message: 'CDP 任务已加入执行队列' },
    });
    broadcastProgress('case-started', {
      log: { level: 'info', phase: 'runner', message: `CDP 任务开始，case=${sourceCaseKey}` },
    });
    broadcastProgress('log', {
      log: { level: 'info', phase: 'case', message: '正在读取 admin 用例快照' },
    });

    try {
      const res = useAdminCase
        ? await this.api.getAdminPlaywrightCase(sourceCaseKey, opts.projectEnvironmentId, opts.batchId, opts.executionCapability)
        : await this.api.getTestCase(testCaseId);
      const testCase = res.data;
      const steps = testCase.steps || [];
      const runtimeConfig = resolvePlaybackRuntimeConfig(testCase, { ...opts, startUrl }, useAdminCase);
      const browserBootstrap = resolvePlaybackBrowserBootstrap(runtimeConfig.browserBootstrapMode);
      const resolvedProjectEnvironmentId = testCase.project_environment_id ?? opts.projectEnvironmentId ?? '';
      const caseDeadline = runStartedAt + runtimeConfig.caseTimeoutMs;
      const throwIfCaseTimedOut = () => {
        if (Date.now() >= caseDeadline) {
          throw new Error(`用例执行超时（${runtimeConfig.caseTimeoutMs}ms）`);
        }
      };
      const bindRuntimeConfigToTab = (tabId) => {
        if (tabId == null) return;
        this._stepTimeoutMsByTab.set(tabId, runtimeConfig.stepTimeoutMs);
        this._caseDeadlineByTab.set(tabId, caseDeadline);
        this._pageErrorCheckEnabledByTab = this._pageErrorCheckEnabledByTab || new Map();
        this._pageErrorCheckEnabledByTab.set(tabId, runtimeConfig.pageErrorCheckEnabled);
      };
      const initialVariables = opts.initialVariables ?? testCase.initial_variables ?? testCase.initialVariables ?? {};
      // 先验证 Admin case 与批次能力，再从后台受控批次恢复变量，不能接受网页传来的执行原文。
      if (useAdminCase && opts.batchId && typeof opts.prepareVariableContext === 'function') {
        batchVariableSession = await opts.prepareVariableContext({
          sceneKey: sourceCaseKey.split(':')[0],
          projectEnvironmentId: resolvedProjectEnvironmentId,
          initialVariables,
        });
      }
      const variableContext = batchVariableSession?.context || new CuecastVariableContext(initialVariables);
      const variableResultsByStep = {};
      progressStepTotal = steps.length;
      broadcastProgress('case-loaded', {
        log: { level: 'success', phase: 'case', message: `用例加载完成，共 ${steps.length} 个步骤` },
      });
      const windowPreference = browserBootstrap.initializeBrowser
        ? await resolveWindowPreference({
            viewportMode: runtimeConfig.windowSizeMode,
            viewportWidth: runtimeConfig.viewportWidth,
            viewportHeight: runtimeConfig.viewportHeight,
            sourceWindowId: opts.sourceWindowId,
          })
        : { mode: 'none', width: null, height: null };
      const pageErrorCheckEnabled = runtimeConfig.pageErrorCheckEnabled;
      const screenshotMode = runtimeConfig.screenshotMode === 'full_hd'
        ? 'full_hd'
        : 'standard';
      if (runtimeConfig.frozen) {
        // 原样上报服务端冻结配置及 sources，不能用运行时归一化结果覆盖审计事实。
        executionSnapshot = { ...runtimeConfig.executionConfig };
      } else {
        Object.assign(executionSnapshot, {
          project_environment_id: resolvedProjectEnvironmentId,
          project_environment_name: testCase.project_environment_name || '',
          environment_origin: testCase.environment_origin || '',
          effective_start_url: runtimeConfig.startUrl,
          window_size_mode: windowPreference.mode,
          viewport_width: windowPreference.width ?? null,
          viewport_height: windowPreference.height ?? null,
          page_error_check_enabled: pageErrorCheckEnabled ? 1 : 0,
        });
      }
      broadcastProgress('log', {
        log: {
          level: 'info',
          phase: 'config',
          message: browserBootstrap.initializeBrowser
            ? `浏览器启动模式=${browserBootstrap.mode}，窗口模式=${windowPreference.mode}，页面错误检测=${pageErrorCheckEnabled}`
            : '浏览器启动模式=none，纯基础设施用例不创建页面会话',
          detail: true,
        },
      });

      if (!steps.length) {
        throw new Error(trByLocale(runLocale, '用例没有步骤', 'Case has no steps'));
      }

      const startStepIndex = normalizeStartStepIndex(opts.startStepIndex, steps.length);
      if (startStepIndex < 0) {
        throw new Error(trByLocale(runLocale, '起始步骤超出用例步骤范围', 'Start step is outside the case step range'));
      }
      const stopAfterStepIndex = normalizeStopAfterStepIndex(opts.stopAfterStepIndex, steps.length);
      if (stopAfterStepIndex < startStepIndex) {
        throw new Error(trByLocale(runLocale, '停止步骤早于起始步骤', 'Stop step is before the start step'));
      }
      const variablePrecheck = PlayerManager._validateVariableReferencesForPlayback(
        steps, startStepIndex, stopAfterStepIndex, variableContext.names(),
      );
      if (!variablePrecheck.ok) {
        throw new Error(PlayerManager._formatVariablePrecheckError(variablePrecheck, runLocale));
      }
      const stepStartUrl =
        startStepIndex > 0
          ? String(steps[startStepIndex]?.url || steps[startStepIndex - 1]?.url || '').trim()
          : '';
      const targetUrl = browserBootstrap.initializeBrowser
        ? resolvePlaybackStartUrl(runtimeConfig.frozen
            ? runtimeConfig.startUrl
            : runtimeConfig.startUrl || stepStartUrl, runtimeConfig.frozen ? null : testCase)
        : '';

      if (this.state.mode === 'recording') {
        throw new Error(trByLocale(runLocale, '正在录制，无法回放', 'Recording in progress, playback is unavailable'));
      }
      if (this._playContexts.size >= MAX_CONCURRENT_PLAYS) {
        throw new Error(trByLocale(runLocale, '并发回放已达上限（5）', 'Concurrent playback limit reached (5)'));
      }

      ctx = {
        stopped: false,
        debuggerAttached: false,
        tabId: null,
        testCaseId,
        reusedTab: false,
        tabRegistry: new Map(),
        locale: runLocale,
        pageErrorCheckEnabled,
        caseDeadline,
        startStepIndex,
        stopAfterStepIndex,
        batchId: String(opts.batchId || '').trim(),
        keepTabOpenAfterPlayback: opts.keepTabOpenAfterPlayback === true,
        suppressResultSave: opts.suppressResultSave === true,
        playbackPurpose: String(opts.purpose || ''),
        activeTabId: null,
        managedWindowId: null,
        managedTabIds: new Set(),
        initialManagedTabId: null,
        ignoreHttpsErrors: runtimeConfig.ignoreHttpsErrors,
        executionCapability: String(opts.executionCapability || ''),
        infrastructureTaskIds: new Set(),
      };
      this._playContexts.add(ctx);
      this.state.activePlayCount = (this.state.activePlayCount || 0) + 1;
      this.state.testCaseId = testCaseId;
      const tabLoadTimeoutMs = ctx.playbackPurpose === 'record_context_prepare'
        ? RECORD_CONTEXT_PREPARE_TIMEOUT_MS
        : DEFAULT_TAB_LOAD_TIMEOUT_MS;

      let cdpAvailable = false;
      if (browserBootstrap.initializeBrowser) {
        const preparedSession = typeof opts.prepareBrowserSession === 'function'
          ? await opts.prepareBrowserSession({
              startUrl: targetUrl,
              ignoreHttpsErrors: runtimeConfig.ignoreHttpsErrors,
              windowPreference,
              sessionMode: opts.sessionMode,
              browserSessionSource: opts.browserSessionSource,
            })
          : null;
        const preparedTabId = preparedSession?.tabId ?? null;
        const initialNavigationUrl = String(preparedSession?.navigationUrl || targetUrl);
        const skipInitialNavigation = preparedSession?.skipInitialNavigation === true;
        browserSessionPrepared = Boolean(preparedSession);
        sessionNavigationDecision = String(preparedSession?.sessionTransition || '');
        for (const managedTabId of preparedSession?.managedTabIds || []) {
          if (Number.isInteger(Number(managedTabId))) ctx.managedTabIds.add(Number(managedTabId));
        }
        const reuseTabId = preparedTabId ?? (runtimeConfig.frozen
          ? (browserBootstrap.mode === 'attach' ? opts.reuseTabId ?? null : null)
          : opts.reuseTabId ?? null);
        if (browserBootstrap.mode === 'attach' && reuseTabId == null) {
          throw new Error('browser_bootstrap_mode=attach 缺少经过授权的受控标签页');
        }
        if (preparedSession?.keepTabOpenAfterPlayback === true) ctx.keepTabOpenAfterPlayback = true;

        broadcastProgress('browser-started', {
          log: { level: 'info', phase: 'browser', message: '正在初始化 CDP 浏览器' },
        });
        if (reuseTabId != null) {
          playTabId = reuseTabId;
          ctx.tabId = playTabId;
          // 受控无痕会话的 tab 属于本批次，可由用例关闭；legacy 复用页仍按用户标签页保护。
          ctx.reusedTab = preparedTabId == null;
          const reuseTab = await chrome.tabs.get(playTabId).catch(() => null);
          if (!reuseTab) {
            throw new Error(`复用回放标签页不存在：${playTabId}`);
          }
          ctx.managedWindowId = reuseTab.windowId ?? null;
          ctx.managedTabIds.add(playTabId);
          ctx.initialManagedTabId = playTabId;
          ctx.activeTabId = playTabId;
          if (reuseTab.windowId != null) await applyWindowPreference(reuseTab.windowId, windowPreference);
        } else {
          const active = opts.backgroundTab !== true;
          // 先停留在空白页，确保 CDP 证书策略在首次业务导航前已经生效。
          const win = await chrome.windows.create(buildWindowCreateData('about:blank', active, windowPreference));
          const tab = win.tabs?.[0];
          if (!tab?.id) throw new Error('创建回放标签页失败');
          playTabId = tab.id;
          ctx.tabId = playTabId;
          ctx.managedWindowId = win.id ?? tab.windowId ?? null;
          ctx.managedTabIds.add(playTabId);
          ctx.initialManagedTabId = playTabId;
          ctx.activeTabId = playTabId;
        }
        ctx.tabRegistry.set(0, {
          tabId: playTabId,
          url: skipInitialNavigation
            ? String((await chrome.tabs.get(playTabId).catch(() => null))?.url || initialNavigationUrl)
            : initialNavigationUrl,
          openerIndex: null,
        });
        cdpAvailable = await this._attachDebugger(playTabId, ctx);
        if (useAdminCase && !cdpAvailable) {
          // admin 入口定义为扩展 CDP 回放，不能静默降级 DOM 后仍报告成功；旧本地 mock 路径继续保留降级能力。
          throw new Error(`admin 扩展 CDP 无法初始化回放标签页：${ctx.cdpAttachError || '未知错误'}`);
        }
        if (skipInitialNavigation) {
          await chrome.tabs.update(playTabId, { active: true });
        } else {
          await chrome.tabs.update(playTabId, { url: initialNavigationUrl, active: true });
        }
        const viewportLabel = windowPreference.width && windowPreference.height
          ? `${windowPreference.width}x${windowPreference.height}`
          : windowPreference.mode;
        broadcastProgress('browser-ready', {
          log: { level: 'success', phase: 'browser', message: `浏览器初始化成功，viewport=${viewportLabel}` },
        });
        this._playTabByCaseId.set(testCaseId, playTabId);
        bindRuntimeConfigToTab(playTabId);
        ctx.liveBroadcast = true;
        this._broadcastPlayback({ type: 'AT_PLAYBACK_LIVE', testCaseId, tabId: playTabId });
        broadcastProgress('live-ready', {
          log: { level: 'success', phase: 'live', message: '实时画面已启用，来源=CDP' },
        });
        broadcastProgress('navigation-started', {
          log: {
            level: 'info',
            phase: 'navigation',
            message: preparedSession?.skipInitialNavigation === true
              ? '正在接管批次受控页面'
              : `正在打开用例起始页面：${targetUrl}`,
          },
        });
        await this._bringTabToForeground(playTabId);
        await this._waitForTabLoad(playTabId, tabLoadTimeoutMs);
        broadcastProgress('navigation-finished', {
          log: { level: 'success', phase: 'navigation', message: '起始页面加载完成' },
        });

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
      } else {
        broadcastProgress('browser-skipped', {
          log: { level: 'info', phase: 'browser', message: '纯基础设施用例已跳过浏览器初始化' },
        });
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
      const dependencySummary = PlayerManager._variableDependencySummary(steps, startStepIndex, ctx.locale);
      if (dependencySummary) this._notifyPopup(dependencySummary);

      let errorStep = null;
      let errorMsg = null;
      let blockingStepFailure = false;
      let failureContext = null;
      const playbackScreenshots = new Array(steps.length).fill('');
      const aiSubtasksByStep = {};
      const stepResults = [];
      const appendStepResult = (step, index, status, startedAt, error = '', locator = null, executorResult = null, stepDetails = {}) => {
        const definitionStep = PlayerManager._adaptRecordedStep(steps[index] || step);
        const normalizedStepDetails = stepDetails && typeof stepDetails === 'object' ? stepDetails : {};
        const { operation_assertion: configuredOperationAssertion, ...persistedStepDetails } = normalizedStepDetails;
        // CDP 读取结果包含本次断言的完整实际值，不能被详情中的历史占位对象覆盖。
        const operationAssertion = locator?.operationAssertion || configuredOperationAssertion;
        const operationFacts = locator?.operationFacts && typeof locator.operationFacts === 'object'
          ? locator.operationFacts
          : {};
        const resultLocator = locator && typeof locator === 'object' && locator.source ? locator : null;
        const durationMs = Math.max(0, Date.now() - startedAt);
        const cdpLocatorDiagnostics = PlayerManager._buildCdpLocatorDiagnostics(
          definitionStep,
          resultLocator,
          status,
          durationMs,
        );
        const details = {
          ...(executorResult?.infrastructure ? { infrastructure: executorResult.infrastructure } : {}),
          ...(executorResult?.taskId ? { infrastructure_task_id: executorResult.taskId } : {}),
          ...persistedStepDetails,
          ...(cdpLocatorDiagnostics && !persistedStepDetails.locator_diagnostics
            ? { locator_diagnostics: cdpLocatorDiagnostics }
            : {}),
        };
        let result = {
          step_id: step?.id ?? '',
          step_index: index,
          action_type: String(step?.action_type || '').trim().toLowerCase(),
          description: step?.description || '',
          target_selector: step?.target_selector || '',
          target_xpath: step?.target_xpath || '',
          status,
          duration_ms: durationMs,
          ...(resultLocator ? {
            locator_source: resultLocator.source || '',
            locator_type: resultLocator.type || '',
            locator_value: resultLocator.value || '',
            matched_count: resultLocator.matchedCount ?? null,
            visible_count: resultLocator.visibleCount ?? null,
          } : {}),
          ...(stepDetails?.error_code ? { error_code: stepDetails.error_code } : {}),
          ...(executorResult ? {
            executor: executorResult.executor || 'infrastructure-service',
            infrastructure_task_id: executorResult.taskId || '',
            exit_code: executorResult.exitCode ?? null,
            affected_rows: executorResult.affectedRows ?? null,
          } : {}),
          ...(error ? { error } : {}),
          ...(continueOnFailureEnabled(step) ? { continue_on_failure: true } : {}),
          ...operationFacts,
          ...(operationAssertion && typeof operationAssertion === 'object' ? { operation_assertion: operationAssertion } : {}),
          ...(Object.keys(details).length ? { details } : {}),
        };
        result = attachOperationDiagnostic(result, definitionStep, step, { executor: 'extension-cdp' });
        stepResults.push(result);
        broadcastProgress('step-finished', {
          stepIndex: index,
          status,
          description: result.description,
          actionType: result.action_type,
          durationMs: result.duration_ms,
          locatorSource: result.locator_source || '',
          locatorType: result.locator_type || '',
          locatorValue: result.locator_value || '',
          matchedCount: result.matched_count ?? null,
          visibleCount: result.visible_count ?? null,
          ...(executorResult ? {
            executor: result.executor,
            taskId: result.infrastructure_task_id,
            exitCode: result.exit_code,
            affectedRows: result.affected_rows,
          } : {}),
          ...(error ? { error } : {}),
          log: {
            level: status === 'passed' ? 'success' : status === 'skipped' ? 'warning' : 'error',
            phase: 'step',
            message: status === 'passed'
              ? `步骤 ${index + 1}: ${result.description || result.action_type}，执行成功，耗时 ${result.duration_ms}ms`
              : status === 'skipped'
                ? `步骤 ${index + 1}: ${result.description || result.action_type}，已跳过`
                : `步骤 ${index + 1}: ${result.description || result.action_type}，执行失败${error ? `：${error}` : ''}`,
          },
        });
        if (result.locator_source) {
          broadcastProgress('log', {
            log: {
              level: 'info',
              phase: 'locator',
              message: [
                `步骤 ${index + 1}: ${result.description || result.action_type}`,
                `定位来源=${result.locator_source}`,
                result.locator_type ? `定位类型=${result.locator_type}` : '',
                result.locator_value ? `定位元素=${result.locator_value}` : '',
                result.matched_count != null ? `命中=${result.matched_count}` : '',
                result.visible_count != null ? `可见=${result.visible_count}` : '',
              ].filter(Boolean).join('，'),
              detail: true,
            },
          });
        }
      };
      const runtimeVariables = Object.create(null);
      const runtimeVariableEvents = [];
      const stepTimings = [];
      const runtimeStepTargets = [];

      for (let i = startStepIndex; i <= stopAfterStepIndex; i++) {
        const stepStartedAt = Date.now();
        if (ctx.stopped) {
          errorMsg = ctx.closedAllTabs
            ? trByLocale(ctx.locale, '回放标签页已全部关闭', 'All playback tabs have been closed')
            : trByLocale(ctx.locale, '用户手动停止', 'Stopped by user');
          errorStep = i;
          blockingStepFailure = true;
          appendStepResult(PlayerManager._adaptRecordedStep(steps[i]), i, 'skipped', stepStartedAt, errorMsg);
          break;
        }

        const step = steps[i];
        const executableDefinitionStep = PlayerManager._adaptRecordedStep(step);
        const runtimeVariableReferences = variableContext.describeReferencesForStep(executableDefinitionStep);
        const localResolvedStep = variableContext.resolveStep(PlayerManager._resolveDynamicStepValue(executableDefinitionStep));
        const resolvedStepInfo = PlayerManager._resolveRuntimeVariablesWithTrace(
          localResolvedStep,
          runtimeVariables,
        );
        const runtimeStep = resolvedStepInfo.step;
        const runtimeNextStep = steps[i + 1] && PlayerManager._shouldResolveNextStepBeforeCurrent(executableDefinitionStep)
          ? PlayerManager._resolveRuntimeVariablesWithTrace(
              variableContext.resolveStep(PlayerManager._resolveDynamicStepValue(PlayerManager._adaptRecordedStep(steps[i + 1]))),
              runtimeVariables,
            ).step
          : null;
        const at = String(runtimeStep.action_type || '').trim().toLowerCase();
        const stepLine = isAiNaturalStep(step)
          ? trByLocale(ctx.locale, `#${testCaseId} 第 ${i + 1}/${steps.length} 步 · 智能步骤`, `#${testCaseId} Step ${i + 1}/${steps.length} · AI Step`)
          : at === 'assert_json'
            ? trByLocale(ctx.locale, `#${testCaseId} 第 ${i + 1}/${steps.length} 步 · JSON 断言`, `#${testCaseId} Step ${i + 1}/${steps.length} · JSON Assert`)
            : trByLocale(ctx.locale, `#${testCaseId} 第 ${i + 1}/${steps.length} 步: ${runtimeStep.description || runtimeStep.action_type}`, `#${testCaseId} Step ${i + 1}/${steps.length}: ${runtimeStep.description || runtimeStep.action_type}`);
        this._notifyPopup(stepLine);
        broadcastProgress('step-started', {
          stepIndex: i,
          status: 'running',
          description: runtimeStep.description || runtimeStep.action_type || '',
          actionType: at,
          log: {
            level: 'info',
            phase: 'step',
            message: `步骤 ${i + 1}: ${runtimeStep.description || runtimeStep.action_type || ''}，开始执行`,
          },
        });
        broadcastProgress('log', {
          log: {
            level: 'info',
            phase: 'step',
            message: `步骤 ${i + 1}: ${runtimeStep.description || runtimeStep.action_type || ''}，动作类型=${at || 'custom'}`,
            detail: true,
          },
        });

        let stepEndedAt = stepStartedAt;
        let stepTimingStatus = 'success';
        try {
          throwIfCaseTimedOut();
          let actualLocator = null;
          const waitBefore = Math.max(0, Number(runtimeStep.wait_before) || 0);
          if (waitBefore) await this._sleep(waitBefore);
          const executableStep = waitBefore ? { ...runtimeStep, wait_before: 0 } : runtimeStep;
          const actionType = String(executableStep.action_type || '').trim().toLowerCase();
          let stepExecutionResult = null;

          if (isInfrastructureStep(executableStep)) {
            const infrastructureResult = await this._executeInfrastructureStep(sourceCaseKey, executableStep, {
              ctx,
              executionId: opts.executionId || runId,
              projectEnvironmentId: resolvedProjectEnvironmentId,
              runtimeBindings: variableContext.bindingsForStep(step),
              onProgress: (phase, payload) => broadcastProgress(phase, payload),
            });
            const variable = this._applyInfrastructureVariableResult(executableStep, infrastructureResult, variableContext);
            if (variable) variableResultsByStep[String(i)] = variable;
            throwIfCaseTimedOut();
            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, infrastructureResult, {
              ...(variable ? { variable } : {}),
              ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            });
            continue;
          }
          if (actionType === 'wait') {
            const configuredWait = executableStep.duration_ms ?? executableStep.value;
            const waitDurationMs = configuredWait == null || configuredWait === ''
              ? 1000
              : Math.max(0, Number(configuredWait) || 0);
            await this._waitWithCountdown(waitDurationMs, (remainingSeconds) => {
              broadcastProgress('log', {
                log: {
                  level: 'info',
                  phase: 'step',
                  message: `步骤 ${i + 1}: ${runtimeStep.description || runtimeStep.action_type || '等待'}，正在执行：倒计时<${remainingSeconds}s>`,
                },
              });
            });
            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, null, {
              wait_duration_ms: waitDurationMs,
              ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            });
            continue;
          }
          if (actionType === 'captcha_ocr') {
            if (!cdpAvailable) throw new Error('验证码 OCR 需要 Chrome CDP 截图能力');
            const imageBase64 = await this._captureCaptchaTargetBase64(playTabId, executableStep);
            const infrastructureResult = await this._executeInfrastructureStep(sourceCaseKey, executableStep, {
              ctx,
              executionId: opts.executionId || runId,
              projectEnvironmentId: resolvedProjectEnvironmentId,
              runtimeBindings: variableContext.bindingsForStep(step),
              runtimeInput: { captcha_image_base64: imageBase64 },
              onProgress: (phase, payload) => broadcastProgress(phase, payload),
            });
            const variable = this._applyInfrastructureVariableResult(executableStep, infrastructureResult, variableContext);
            if (variable) variableResultsByStep[String(i)] = variable;
            throwIfCaseTimedOut();
            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, infrastructureResult, {
              ...(variable ? { variable } : {}),
              ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            });
            continue;
          }
          if (isCuecastLocalVariableAction(actionType)) {
            const localResult = await this._executeLocalVariableAction(playTabId, executableStep, variableContext);
            if (localResult?.variable) variableResultsByStep[String(i)] = localResult.variable;
            throwIfCaseTimedOut();
            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', localResult?.locator || null, null, {
              ...(localResult?.variable ? { variable: localResult.variable } : {}),
              ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            });
            continue;
          }
          const ensuredTabId = await this._ensurePlayableTabBeforeStep(ctx, playTabId, actionType, ctx.locale);
          if (ensuredTabId != null) playTabId = ensuredTabId;

          if (!PlayerManager._skipPageErrorCheckForAction(actionType)) {
            await this._throwIfPageError(playTabId);
          }
          if (actionType === 'navigate' && playTabId != null) {
            this._clearFrameSelection(playTabId);
            this._pointerPositionByTab.delete(playTabId);
          }

          const runtimeTarget = await this._collectRuntimeStepTarget(playTabId, executableStep, cdpAvailable);
          if (runtimeTarget) {
            runtimeStepTargets.push({
              step_index: i,
              ...runtimeTarget,
            });
          }

          if (actionType === 'switch_context') {
            const switched = await this._switchPlaybackContext(playTabId, executableStep, ctx, cdpAvailable, screenshotMode);
            playTabId = switched.tabId;
            cdpAvailable = switched.cdpAvailable;
            this._playTabByCaseId.set(testCaseId, playTabId);
            this._broadcastPlayback({ type: 'AT_PLAYBACK_LIVE', testCaseId, tabId: playTabId });
            await this._sleep(120);
            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, null, {
              ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            });
            continue;
          }
          if (actionType === 'set_variable') {
            const captured = await this._executeSetVariableStep(playTabId, executableStep, cdpAvailable, ctx.locale);
            const previousValue = Object.prototype.hasOwnProperty.call(runtimeVariables, captured.name)
              ? String(runtimeVariables[captured.name] ?? '')
              : null;
            runtimeVariables[captured.name] = captured.value;
            const variable = variableContext.set(captured.name, captured.value, {
              source: captured.source || 'set_variable',
            });
            variableResultsByStep[String(i)] = variable;
            runtimeVariableEvents.push({
              step_index: i,
              name: captured.name,
              value: PlayerManager._previewRuntimeValue(captured.value),
              raw_value: PlayerManager._previewRuntimeValue(captured.raw_value ?? captured.value),
              extract: captured.extract || { mode: 'full' },
              source: captured.source || '',
              overwritten: previousValue != null,
              previous_value: previousValue == null ? '' : PlayerManager._previewRuntimeValue(previousValue),
            });
            await this._sleep(120);
            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, null, {
              variable,
              ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            });
            continue;
          }
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

          const managedTabAction = await this._executeManagedTabAction(playTabId, executableStep, ctx, {
            cdpAvailable,
            useAdminCase,
          });
          if (managedTabAction) {
            actualLocator = managedTabAction.locator || null;
            if (Object.prototype.hasOwnProperty.call(managedTabAction, 'tabId')) {
              playTabId = managedTabAction.tabId;
              cdpAvailable = managedTabAction.cdpAvailable === true;
              bindRuntimeConfigToTab(playTabId);
            }
          } else if (isAiNaturalStep(executableStep)) {
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
            await this._validateStepXpathsCDP(playTabId, executableStep);
            actualLocator = await this._executeAssertTextStepCDP(playTabId, executableStep);
          } else if (cdpAvailable && this._canUseCDP(executableStep)) {
            try {
              const cdpResult = await this._executeStepCDP(playTabId, executableStep, targetUrl, ctx.locale, runtimeNextStep, {
                beforeActionScreenshot: captureCurrentStep,
                executionCapability: ctx.executionCapability,
                executionBatchId: ctx.batchId,
              });
              if (cdpResult?.__cdpStepResult === true) {
                stepExecutionResult = cdpResult;
                actualLocator = cdpResult.locator || null;
              } else {
                actualLocator = cdpResult;
              }
            } catch (cdpErr) {
              if (PlayerManager._isCdpForeignExtensionError(cdpErr) && !useAdminCase) {
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

          const executionStatus = stepExecutionResult?.status || 'passed';
          if (executionStatus !== 'skipped' && playTabId != null && ['click', 'navigate', 'ai_natural', 'reload', 'switch_page'].includes(actionType)) {
            await this._waitForTabLoad(playTabId, tabLoadTimeoutMs);
          }
          throwIfCaseTimedOut();
          stepTimingStatus = executionStatus === 'skipped' ? 'skipped' : 'success';
          appendStepResult(runtimeStep, i, executionStatus, stepStartedAt, '', actualLocator, null, {
            ...(stepExecutionResult?.details && typeof stepExecutionResult.details === 'object' ? stepExecutionResult.details : {}),
            ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
          });
        } catch (err) {
          const shouldContinue = continueOnFailureEnabled(runtimeStep)
            || continueOnFailureEnabled(executableDefinitionStep);
          stepTimingStatus = shouldContinue ? 'skipped' : 'failed';
          const rawErrMsg = err && err.message ? err.message : String(err);
          const enhancedErrMsg = PlayerManager._appendVariableResolutionToError(rawErrMsg, resolvedStepInfo.trace);
          const stepErrorMsg = localizePlaybackError(ctx.locale, enhancedErrMsg);
          if (!errorMsg) errorMsg = stepErrorMsg;
          if (errorStep == null) errorStep = i;
          const variableExtractionError = err?.variableExtraction || err?.variable_extraction_error || null;
          const operationAssertion = err?.operationAssertion && typeof err.operationAssertion === 'object'
            ? err.operationAssertion
            : null;
          const assertionLocator = err?.actualLocator && typeof err.actualLocator === 'object'
            ? err.actualLocator
            : null;
          const locatorError = err?.locatorError && typeof err.locatorError === 'object'
            ? err.locatorError
            : null;
          if (isAiNaturalStep(runtimeStep) && Array.isArray(err?.aiSubtasks) && err.aiSubtasks.length) {
            aiSubtasksByStep[String(i)] = err.aiSubtasks;
          }
          if (!failureContext) {
            if (ctx.suppressResultSave && ctx.playbackPurpose === 'record_context_prepare') {
              failureContext = {
                error_message: errorMsg,
                error_step_index: i,
                url: targetUrl,
                runtime_variables: runtimeVariableEvents,
                variable_resolution: resolvedStepInfo.trace,
                ...(variableExtractionError ? { variable_extraction_error: variableExtractionError } : {}),
              };
            } else if (cdpAvailable && playTabId != null) {
              try {
                const failShot = await this._capturePlaybackScreenshot(playTabId, screenshotMode);
                if (failShot) playbackScreenshots[i] = failShot;
              } catch {
                /* ignore */
              }
              try {
                failureContext = await this._collectFailureContext(playTabId, i, stepErrorMsg);
                failureContext.runtime_variables = runtimeVariableEvents;
                failureContext.variable_resolution = resolvedStepInfo.trace;
                if (variableExtractionError) failureContext.variable_extraction_error = variableExtractionError;
              } catch {
                failureContext = { error_message: stepErrorMsg, error_step_index: i, url: targetUrl, runtime_variables: runtimeVariableEvents, variable_resolution: resolvedStepInfo.trace, ...(variableExtractionError ? { variable_extraction_error: variableExtractionError } : {}) };
              }
            } else {
              failureContext = { error_message: stepErrorMsg, error_step_index: i, url: targetUrl, cdp_unavailable: true, runtime_variables: runtimeVariableEvents, variable_resolution: resolvedStepInfo.trace, ...(variableExtractionError ? { variable_extraction_error: variableExtractionError } : {}) };
            }
          }
          if (failureContext && locatorError) failureContext.locator_error = locatorError;
          appendStepResult(runtimeStep, i, shouldContinue ? 'skipped' : 'failed', stepStartedAt, stepErrorMsg, assertionLocator, null, {
            ...(runtimeVariableReferences.length ? { variable_references: runtimeVariableReferences } : {}),
            ...(err?.infrastructureTaskId ? { infrastructure_task_id: err.infrastructureTaskId } : {}),
            ...(locatorError ? { error_code: locatorError.code, locator_error: locatorError } : {}),
            ...(operationAssertion ? { operation_assertion: operationAssertion } : {}),
          });
          if (shouldContinue) {
            broadcastProgress('log', {
              log: {
                level: 'warning',
                phase: 'step',
                message: `步骤 ${i + 1}: ${runtimeStep.description || runtimeStep.action_type || ''} 执行失败，已跳过并继续执行`,
              },
            });
            continue;
          }
          blockingStepFailure = true;
          break;
        } finally {
          stepEndedAt = Date.now();
          stepTimings.push({
            step_index: i,
            started_at: stepStartedAt,
            ended_at: stepEndedAt,
            duration_ms: Math.max(0, stepEndedAt - stepStartedAt),
            status: stepTimingStatus,
          });
        }
      }

      // 未执行的步骤也写入结果，平台才能区分失败、区间外步骤和停止后的步骤。
      const stepResultIndexes = new Set(stepResults.map((item) => item.step_index));
      for (let i = 0; i < steps.length; i++) {
        if (!stepResultIndexes.has(i)) {
          const reason = i < startStepIndex
            ? 'Skipped before start step'
            : i > stopAfterStepIndex
              ? 'Skipped after stop step'
              : 'Skipped after playback stopped';
          appendStepResult(PlayerManager._adaptRecordedStep(steps[i]), i, 'skipped', Date.now(), reason);
        }
      }
      stepResults.sort((a, b) => a.step_index - b.step_index);

      const stepDuration = stepResults.reduce(
        (total, item) => total + Math.max(0, Number(item.duration_ms) || 0),
        0,
      );
      const duration = Date.now() - runStartedAt;
      // 失败后继续的步骤只记录为 skipped，不阻断用例最终通过；其他步骤失败仍判定用例失败。
      let success = !blockingStepFailure;
      if (typeof opts.finalizeBrowserSession === 'function') {
        const debuggerTabId = ctx.activeTabId ?? playTabId;
        if (ctx.debuggerAttached && debuggerTabId != null) {
          await this._detachDebugger(debuggerTabId, ctx);
        }
        const managedTabs = await this._refreshManagedTabs(ctx).catch(() => []);
        const finalTab = await chrome.tabs.get(playTabId).catch(() => null);
        try {
          sessionTransition = await opts.finalizeBrowserSession({
            success,
            finalActiveTabId: ctx.activeTabId ?? playTabId,
            managedTabIds: managedTabs.map((tab) => tab.id),
            finalUrl: finalTab?.url || '',
            navigationDecision: sessionNavigationDecision,
            browserSessionPrepared,
          });
        } catch (sessionError) {
          success = false;
          sessionErrorCode = String(sessionError?.code || 'CDP_SESSION_COMMIT_FAILED');
          sessionTransition = sessionError?.sessionTransition || sessionTransition;
          errorMsg = `CDP 批次会话提交失败：${sessionError?.message || String(sessionError)}`;
          failureContext = {
            ...(failureContext || {}),
            session_transition_error: errorMsg,
            ...(sessionError?.code ? { session_transition_error_code: sessionError.code } : {}),
          };
        } finally {
          browserSessionFinalized = true;
        }
      }
      const sessionTransitionAudit = buildSessionTransitionAudit(sessionTransition, {
        sessionMode: opts.sessionMode,
        browserSessionSource: opts.browserSessionSource,
        navigationDecision: sessionNavigationDecision,
      });
      // 可继续失败只保留在步骤明细和 failure_context 中，成功的用例不应带有用例级错误。
      const resultError = success ? '' : errorMsg || '';
      const resultErrorStep = success ? null : errorStep;
      playbackOutcome = { ok: success, duration, error: resultError, sessionTransition };
      const executedStepIndexes = stepResults
        .filter((item) => item.status !== 'skipped')
        .map((item) => item.step_index);
      const caseResult = {
        case_key: sourceCaseKey,
        case_id: testCase.case_id || testCase.caseId || testCaseId,
        case_name: testCase.name || '',
        status: success ? 'passed' : 'failed',
        duration_ms: duration,
        step_total: stepResults.length,
        step_pass: stepResults.filter((item) => item.status === 'passed').length,
        step_fail: stepResults.filter((item) => item.status === 'failed').length,
        step_skip: stepResults.filter((item) => item.status === 'skipped').length,
        step_duration_ms: stepDuration,
        steps: stepResults,
      };
      const resultDetail = {
        steps: steps.length,
        start_step_index: startStepIndex,
        stop_after_step_index: stopAfterStepIndex,
        executed_step_indexes: executedStepIndexes,
        step_duration_ms: stepDuration,
        cdp_mode: cdpAvailable,
        ...(ctx.cdpAttachError ? { cdp_attach_error: ctx.cdpAttachError } : {}),
        // Admin 结果不直接保存截图 base64，避免执行历史 JSON 膨胀。
        ...(useAdminCase
          ? { playback_screenshot_count: playbackScreenshots.filter(Boolean).length }
          : { playback_screenshots: playbackScreenshots }),
        step_results: stepResults,
        ai_subtasks_by_step: aiSubtasksByStep,
        variable_results_by_step: variableResultsByStep,
        runtime_variables: runtimeVariableEvents,
        step_timings: stepTimings,
        runtime_step_targets: runtimeStepTargets,
        ...(failureContext?.variable_extraction_error ? { variable_extraction_error: failureContext.variable_extraction_error } : {}),
        ...(failureContext ? { failure_context: failureContext } : {}),
        ...(sessionTransitionAudit ? { session_transition: sessionTransitionAudit } : {}),
      };
      broadcastProgress('case-finished', {
        status: success ? 'passed' : 'failed',
        durationMs: duration,
        stepDurationMs: stepDuration,
        ...(resultError ? { error: resultError } : {}),
        log: {
          level: success ? 'success' : 'error',
          phase: 'runner',
          message: `CDP 执行${success ? '完成' : '失败'}，耗时 ${duration}ms${resultError ? `：${resultError}` : ''}`,
        },
      });
      progressFinished = true;

      if (!ctx.suppressResultSave) {
        if (useAdminCase) {
          await this.api.saveAdminPlaywrightResult(sourceCaseKey, {
            status: success ? 'passed' : 'failed',
            success,
            duration_ms: duration,
            error: resultError,
            raw: {
              executor: 'extension-cdp',
              batch_id: opts.batchId || '',
              run_id: runId,
              started_at: formatPlatformDateTime(runStartedAt),
              finished_at: formatPlatformDateTime(),
              case_key: sourceCaseKey,
              case_id: testCaseId,
              status: success ? 'passed' : 'failed',
              success,
              duration_ms: duration,
              step_duration_ms: stepDuration,
              failed_step_index: resultErrorStep,
              ...(sessionErrorCode ? { error_code: sessionErrorCode } : {}),
              error: resultError,
              case_result: caseResult,
              detail: resultDetail,
              execution_config: executionSnapshot,
              execution_logs: progressLogs,
              ...(sessionTransitionAudit ? { session_transition: sessionTransitionAudit } : {}),
            },
          }, opts.executionCapability);
        } else {
          await this.api.saveResult(testCaseId, {
            status: success ? 'success' : 'failed',
            duration,
            error_message: resultError,
            error_step: resultErrorStep,
            detail: resultDetail,
          });
        }
      }

      if (success && !ctx.stopped && !ctx.suppressResultSave && batchVariableSession) {
        // 结果回传成功后才提交；失败、取消和预览执行均不能污染后续用例。
        opts.finalizeVariableContext?.(batchVariableSession, true);
      }

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

      playbackEndPayload = {
        type: 'AT_PLAYBACK_END',
        testCaseId,
        tabId: playTabId,
        ok: success,
        duration,
        error: resultError,
        errorStep: resultErrorStep,
        ...(sessionErrorCode ? { errorCode: sessionErrorCode } : {}),
        finalActiveTabId: ctx.activeTabId ?? playTabId,
        ...(sessionTransition ? { sessionTransition } : {}),
        purpose: ctx.playbackPurpose,
      };
      return playbackOutcome;
    } catch (err) {
      const rawMsg = err && err.message ? err.message : String(err);
      let msg = localizePlaybackError(ctx?.locale ?? runLocale, rawMsg);
      if (typeof opts.finalizeBrowserSession === 'function' && !browserSessionFinalized) {
        try {
          sessionTransition = await opts.finalizeBrowserSession({
            success: false,
            finalActiveTabId: ctx?.activeTabId ?? playTabId,
            managedTabIds: ctx?.managedTabIds ? [...ctx.managedTabIds] : [],
            finalUrl: '',
            navigationDecision: sessionNavigationDecision,
            browserSessionPrepared,
          });
        } catch (sessionError) {
          sessionErrorCode = String(sessionError?.code || 'CDP_SESSION_CLEANUP_FAILED');
          sessionTransition = sessionError?.sessionTransition || sessionTransition;
          msg = `${msg}；CDP 批次会话回滚失败：${sessionError?.message || String(sessionError)}`;
        } finally {
          browserSessionFinalized = true;
        }
      }
      playbackOutcome = { ok: false, error: msg };
      const finishedAt = Date.now();
      const quotaDetails = err?.quotaDetails || err?.apiData?.data || err?.response?.data?.data || null;
      const sessionTransitionAudit = buildSessionTransitionAudit(sessionTransition, {
        sessionMode: opts.sessionMode,
        browserSessionSource: opts.browserSessionSource,
        navigationDecision: sessionNavigationDecision,
      });
      playbackEndPayload = {
        type: 'AT_PLAYBACK_END',
        testCaseId,
        tabId: playTabId,
        ok: false,
        error: msg,
        finalActiveTabId: ctx?.activeTabId ?? playTabId,
        ...(sessionTransition ? { sessionTransition } : {}),
        ...(sessionErrorCode || err?.code ? { errorCode: sessionErrorCode || err.code } : {}),
        ...(quotaDetails && typeof quotaDetails === 'object' && quotaDetails.resource ? { quotaDetails } : {}),
        purpose: ctx?.playbackPurpose || String(opts.purpose || ''),
      };
      broadcastProgress('case-finished', {
        status: 'failed',
        durationMs: finishedAt - runStartedAt,
        error: msg,
        log: {
          level: 'error',
          phase: 'runner',
          message: `CDP 执行失败，耗时 ${finishedAt - runStartedAt}ms：${msg}`,
        },
      });
      progressFinished = true;
      // 启动阶段失败也必须回传 Admin，避免批次一直停留在执行中。
      if (useAdminCase && sourceCaseKey && !ctx?.suppressResultSave) {
        await this.api.saveAdminPlaywrightResult(sourceCaseKey, {
          status: 'failed',
          success: false,
          duration_ms: finishedAt - runStartedAt,
          error: msg,
          raw: {
            executor: 'extension-cdp',
            batch_id: opts.batchId || '',
            run_id: runId,
            started_at: formatPlatformDateTime(runStartedAt),
            finished_at: formatPlatformDateTime(finishedAt),
            case_key: sourceCaseKey,
            case_id: testCaseId,
            status: 'failed',
            success: false,
            startup_failure: true,
            ...(sessionErrorCode || err?.code ? { error_code: sessionErrorCode || err.code } : {}),
            error: msg,
            execution_config: executionSnapshot,
            execution_logs: progressLogs,
            ...(sessionTransitionAudit ? { session_transition: sessionTransitionAudit } : {}),
          },
        }, opts.executionCapability).catch(() => {});
      }
      if (msg && !rawMsg.includes('用户手动停止') && !msg.includes('Stopped by user')) {
        this._showNotification(
          trByLocale(ctx?.locale ?? runLocale, '回放无法启动或异常退出', 'Playback failed to start or exited abnormally'),
          msg.length > 180 ? `${msg.slice(0, 180)}…` : msg,
        );
      }
      return playbackOutcome;
    } finally {
      opts.finalizeVariableContext?.(batchVariableSession, false);
      if (!progressFinished && useAdminCase) {
        broadcastProgress('case-finished', {
          status: playbackOutcome?.ok ? 'passed' : 'failed',
          ...(playbackOutcome?.error ? { error: playbackOutcome.error } : {}),
          log: {
            level: playbackOutcome?.ok ? 'success' : 'error',
            phase: 'runner',
            message: playbackOutcome?.ok ? 'CDP 执行完成' : `CDP 执行失败：${playbackOutcome?.error || '未知错误'}`,
          },
        });
      }
      if (ctx != null) {
        if (ctx.liveBroadcast) {
          this._playTabByCaseId.delete(ctx.testCaseId);
        }
        if (ctx.tabRegistry && typeof ctx.tabRegistry.values === 'function') {
          for (const item of ctx.tabRegistry.values()) {
            if (item?.tabId != null) ctx.managedTabIds.add(Number(item.tabId));
          }
        }
        if (ctx.keepTabOpenAfterPlayback) {
          const tabs = await this._refreshManagedTabs(ctx).catch(() => []);
          if (ctx.debuggerAttached && playTabId != null) await this._detachDebugger(playTabId, ctx).catch(() => {});
          await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'AT_PLAYER_CLEANUP' }).catch(() => {})));
          for (const tab of tabs) this._clearTabExecutionState(tab.id);
        } else {
          await this._cleanupPlaybackTabs(ctx, playTabId).catch((cleanupError) => {
            console.warn('[Player] 回放标签页清理失败:', cleanupError?.message || cleanupError);
          });
        }
        ctx.tabId = null;
        ctx.activeTabId = null;
        this._playContexts.delete(ctx);
        this.state.activePlayCount = Math.max(0, (this.state.activePlayCount || 0) - 1);
      }
      // 须始终广播 END（含拉取用例失败、无步骤等），否则中台顺序回放会一直等不到结束事件。
      // 放在清理之后广播，方便“执行到这里再录制”立即接管保留的 tab。
      this._broadcastPlayback({
        ...playbackEndPayload,
        tabId: playbackEndPayload.tabId ?? playTabId,
        ...(useAdminCase ? {
          adminCaseKey: sourceCaseKey,
          batchId: opts.batchId || '',
          executor: 'extension-cdp',
          runId,
        } : {}),
      });
    }
  }

  async stop() {
    for (const ctx of this._playContexts) {
      ctx.stopped = true;
      const taskIds = Array.from(ctx.infrastructureTaskIds || []);
      // 取消由 admin 转发给实际执行节点；此处不保存也不重放任何基础设施步骤内容。
      await Promise.all(taskIds.map(taskId => this.api
        .cancelInfrastructureTask(taskId, ctx.executionCapability)
        .catch(() => {})));
    }
    return { ok: true };
  }

  /**
   * 在建立 Admin 回放会话时上报扩展版本、目录版本和真实 action 集合。
   * 不等待网络结果，避免旧版 Admin 缺接口或短暂网络失败影响已有回放链路。
   */
  _reportOperationCapabilities(options = {}) {
    if (typeof this.api?.registerOperationCapabilities !== 'function') {
      return Promise.resolve({ ok: false, skipped: true });
    }
    const extensionVersion = this._getExtensionVersion();
    // token 本身不进入限频状态；认证状态变化后仍会在下一轮握手使用 ApiClient 的最新 token。
    const capabilitySessionId = this._getCapabilitySessionId();
    const projectEnvironmentId = String(options.projectEnvironmentId || '').trim();
    const sessionKey = `${String(this.state?.apiBase || '').trim()}\n${this.state?.authToken ? 'authenticated' : 'anonymous'}\n${extensionVersion}\n${projectEnvironmentId}\n${capabilitySessionId}`;
    const now = Date.now();
    if (
      this._capabilityHandshake
      && this._capabilityHandshake.sessionKey === sessionKey
      && now - this._capabilityHandshake.attemptedAt < 60000
    ) {
      return this._capabilityHandshake.promise;
    }

    const capabilities = getCuecastCapabilities({
      executorVersion: extensionVersion,
      executorInstanceId: String(chrome.runtime?.id || 'cuecast-extension'),
      projectEnvironmentId,
      sessionId: capabilitySessionId,
      features: ['browser', 'cdp'],
    });
    const promise = Promise.resolve()
      .then(() => this.api.registerOperationCapabilities(capabilities))
      .then(() => {
        console.info(
          '[Player] 已上报 CueCast 能力，版本=%s，action=%d',
          capabilities.executorVersion,
          capabilities.actions.length,
        );
        return { ok: true };
      })
      .catch((error) => {
        // 404、目录版本不一致和临时网络异常均只影响能力快照，不能中断回放。
        console.warn('[Player] CueCast 能力上报未完成，继续回放：', error?.message || String(error));
        return { ok: false, error };
      });
    this._capabilityHandshake = { sessionKey, attemptedAt: now, promise };
    return promise;
  }

  _getCapabilitySessionId() {
    if (!this._capabilitySessionId) {
      this._capabilitySessionId = globalThis.crypto?.randomUUID?.()
        || `cuecast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    return this._capabilitySessionId;
  }

  _getExtensionVersion() {
    try {
      return String(chrome.runtime?.getManifest?.().version || 'unknown');
    } catch (_) {
      return 'unknown';
    }
  }

  static _skipPageErrorCheckForAction(actionType) {
    return new Set([
      'assert_text',
      'assert_text_not',
      'assert_attribute',
      'assert_script',
      'assert_text_regex',
      'dialog_accept',
      'dialog_dismiss',
      'dialog_prompt',
      'close_page',
      'close_all_pages',
      'reload',
      'switch_page',
      'frame_switch',
      'frame_parent',
      'frame_main',
      'implicit_wait',
      'switch_context',
    ]).has(actionType);
  }

  /**
   * 仅处理需要 Chrome tabs/window 状态的 canonical action。
   * 关闭和切换只使用本次回放新建窗口中的标签页，或从显式复用标签页派生出来的子标签页。
   */
  async _executeManagedTabAction(tabId, step, ctx, options = {}) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    if (actionType === 'close_page') {
      return this._closeManagedTab(tabId, ctx, options);
    }
    if (actionType === 'close_all_pages') {
      return this._closeAllManagedTabs(tabId, ctx, options);
    }
    if (actionType === 'reload') {
      return this._reloadManagedTab(tabId, ctx, options, step);
    }
    if (actionType === 'switch_page') {
      return this._switchManagedTab(tabId, step, ctx, options);
    }
    return null;
  }

  async _refreshManagedTabs(ctx) {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const byId = new Map(allTabs.filter((tab) => tab?.id != null).map((tab) => [tab.id, tab]));
    const managed = new Set(Array.from(ctx?.managedTabIds || []).filter((tabId) => byId.has(tabId)));
    if (ctx?.initialManagedTabId != null && byId.has(ctx.initialManagedTabId)) {
      managed.add(ctx.initialManagedTabId);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const tab of allTabs) {
        if (tab?.id == null || managed.has(tab.id)) continue;
        const openedByManagedTab = tab.openerTabId != null && managed.has(tab.openerTabId);
        if (openedByManagedTab) {
          managed.add(tab.id);
          changed = true;
        }
      }
    }
    ctx.managedTabIds = managed;
    return Array.from(managed)
      .map((tabId) => byId.get(tabId))
      .filter(Boolean)
      .sort((left, right) => Number(left.id) - Number(right.id));
  }

  _requireManagedTab(tabId, ctx) {
    if (tabId == null || !ctx?.managedTabIds?.has(tabId)) {
      throw new Error('当前标签页不属于本次 CueCast 回放，拒绝执行标签页控制操作');
    }
  }

  _clearTabExecutionState(tabId) {
    if (tabId == null) return;
    this._frameStackByTab.delete(tabId);
    this._frameContextByTab.delete(tabId);
    this._implicitWaitMsByTab.delete(tabId);
    this._stepTimeoutMsByTab.delete(tabId);
    this._caseDeadlineByTab.delete(tabId);
    this._pointerPositionByTab.delete(tabId);
    this._dialogOpeningByTab.delete(tabId);
    this._pendingDialogPromptByTab.delete(tabId);
    if (this._pageErrorCheckEnabledByTab) this._pageErrorCheckEnabledByTab.delete(tabId);
  }

  async _ensurePlayerScript(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = String(tab?.url || '');
    if (!tab || PlayerManager._isForeignExtensionPageUrl(url) || /^(chrome|edge|devtools):\/\//i.test(url)) {
      throw new Error(`无法向受控标签页注入回放脚本：${url || tabId}`);
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/player.js'],
      });
    } catch (error) {
      throw new Error(`无法向受控标签页注入回放脚本：${error?.message || String(error)}`);
    }
  }

  async _activateManagedTab(tabId, ctx, options = {}) {
    this._requireManagedTab(tabId, ctx);
    const previousTabId = ctx.activeTabId;
    if (options.cdpAvailable && previousTabId != null && previousTabId !== tabId && ctx.debuggerAttached) {
      await this._detachDebugger(previousTabId, ctx).catch(() => {});
    }
    await chrome.tabs.update(tabId, { active: true });
    ctx.activeTabId = tabId;
    ctx.tabId = tabId;
    this._playTabByCaseId.set(ctx.testCaseId, tabId);
    this._pageErrorCheckEnabledByTab = this._pageErrorCheckEnabledByTab || new Map();
    this._pageErrorCheckEnabledByTab.set(tabId, ctx.pageErrorCheckEnabled !== false);
    await this._waitForTabLoad(tabId);

    let cdpAvailable = Boolean(options.cdpAvailable);
    if (previousTabId !== tabId || !ctx.debuggerAttached) {
      cdpAvailable = await this._attachDebugger(tabId, ctx);
    }
    if (options.useAdminCase && !cdpAvailable) {
      throw new Error(`admin 扩展 CDP 无法初始化切换后的标签页：${ctx.cdpAttachError || '未知错误'}`);
    }
    await this._ensurePlayerScript(tabId);
    return { tabId, cdpAvailable };
  }

  async _switchManagedTab(tabId, step, ctx, options = {}) {
    const tabs = await this._refreshManagedTabs(ctx);
    if (!tabs.length) {
      throw new Error('本次 CueCast 回放没有可切换的受控标签页');
    }
    const rawMode = String(step?.page_mode || step?.mode || '').trim().toLowerCase();
    const rawIndex = step?.index ?? step?.page_index ?? step?.value;
    const useLatest = rawMode === 'latest' || rawIndex == null || String(rawIndex).trim() === '';
    let target;
    if (useLatest) {
      target = tabs[tabs.length - 1];
    } else {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
        throw new Error(`切换标签页序号无效：${rawIndex}，当前受控标签页数量=${tabs.length}`);
      }
      target = tabs[index];
    }
    return this._activateManagedTab(target.id, ctx, options);
  }

  async _closeManagedTab(tabId, ctx, options = {}) {
    this._requireManagedTab(tabId, ctx);
    if (ctx.reusedTab && tabId === ctx.initialManagedTabId) {
      throw new Error('复用的初始标签页不属于本次创建页面，拒绝关闭；请先切换到本次回放派生的标签页');
    }
    // 先发现当前步骤触发的派生页；即使当前页马上关闭，也不会把新页遗漏在受控集合外。
    await this._refreshManagedTabs(ctx);
    if (options.cdpAvailable && ctx.debuggerAttached) {
      await this._detachDebugger(tabId, ctx).catch(() => {});
    }
    await chrome.tabs.remove(tabId);
    ctx.managedTabIds.delete(tabId);
    this._clearTabExecutionState(tabId);
    const tabs = await this._refreshManagedTabs(ctx);
    if (!tabs.length) {
      ctx.activeTabId = null;
      ctx.tabId = null;
      return { tabId: null, cdpAvailable: false };
    }
    return this._activateManagedTab(tabs[tabs.length - 1].id, ctx, {
      ...options,
      cdpAvailable: false,
    });
  }

  async _closeAllManagedTabs(tabId, ctx, options = {}) {
    if (tabId != null) this._requireManagedTab(tabId, ctx);
    const tabs = await this._refreshManagedTabs(ctx);
    if (options.cdpAvailable && ctx.debuggerAttached && tabId != null) {
      await this._detachDebugger(tabId, ctx).catch(() => {});
    }
    const retainedTabId = ctx.reusedTab && tabs.some((tab) => tab.id === ctx.initialManagedTabId)
      ? ctx.initialManagedTabId
      : null;
    const ids = tabs
      .map((tab) => tab.id)
      .filter((id) => id !== retainedTabId);
    await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
    for (const id of ids) this._clearTabExecutionState(id);
    if (retainedTabId != null) {
      ctx.managedTabIds = new Set([retainedTabId]);
      return this._activateManagedTab(retainedTabId, ctx, {
        ...options,
        cdpAvailable: false,
      });
    }
    ctx.managedTabIds.clear();
    ctx.activeTabId = null;
    ctx.tabId = null;
    return { tabId: null, cdpAvailable: false };
  }

  async _reloadManagedTab(tabId, ctx, options = {}, step = {}) {
    this._requireManagedTab(tabId, ctx);
    this._clearFrameSelection(tabId);
    this._pointerPositionByTab.delete(tabId);
    const bypassCache = step?.bypass_cache === true || String(step?.bypass_cache || '').trim().toLowerCase() === 'true';
    await chrome.tabs.reload(tabId, { bypassCache }).catch((error) => {
      throw new Error(`刷新受控标签页失败：${error?.message || String(error)}`);
    });
    await this._waitForTabLoad(tabId);
    await this._ensurePlayerScript(tabId);
    return { tabId, cdpAvailable: Boolean(options.cdpAvailable) };
  }

  /**
   * 回放结束时仅删除本轮创建的页面。复用页只清理注入状态，避免影响用户原有标签页。
   */
  async _cleanupPlaybackTabs(ctx, activeTabId) {
    const tabs = await this._refreshManagedTabs(ctx);
    const retainedTabId = ctx.reusedTab && tabs.some((tab) => tab.id === ctx.initialManagedTabId)
      ? ctx.initialManagedTabId
      : null;
    const removableIds = tabs
      .map((tab) => tab.id)
      .filter((tabId) => tabId !== retainedTabId);

    if (ctx.debuggerAttached && activeTabId != null) {
      await this._detachDebugger(activeTabId, ctx).catch(() => {});
    }

    await Promise.all(tabs.map((tab) => (
      chrome.tabs.sendMessage(tab.id, { type: 'AT_PLAYER_CLEANUP' }).catch(() => {})
    )));
    await Promise.all(removableIds.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));

    for (const tabId of removableIds) this._clearTabExecutionState(tabId);
    if (retainedTabId != null) {
      this._clearTabExecutionState(retainedTabId);
      ctx.managedTabIds = new Set([retainedTabId]);
    } else {
      ctx.managedTabIds.clear();
    }
  }

  async _executeInfrastructureStep(caseKey, step, options) {
    const stepId = String(step?.id ?? '').trim();
    if (!caseKey || !stepId) {
      throw new Error('基础设施步骤缺少用例或步骤标识，无法委托执行');
    }
    const actionType = String(step.action_type || '').trim().toLowerCase();
    const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : () => {};
    const executionCapability = String(options.ctx?.executionCapability || '');
    const createResponse = await this.api.createInfrastructureTask({
      caseKey,
      stepId,
      executionId: String(options.executionId || ''),
      projectEnvironmentId: options.projectEnvironmentId ?? '',
      attempt: 0,
      ...(options.runtimeBindings && Object.keys(options.runtimeBindings).length > 0
        ? { runtimeBindings: options.runtimeBindings }
        : {}),
      // 验证码截图仅随本次任务请求传递，不能写入场景或回放结果。
      ...(options.runtimeInput && Object.keys(options.runtimeInput).length > 0
        ? { runtimeInput: options.runtimeInput }
        : {}),
    }, executionCapability);
    let task = unwrapInfrastructureTask(createResponse);
    const taskId = String(task.taskId || task.id || '').trim();
    if (!taskId) {
      throw new Error('基础设施任务创建成功但未返回 taskId');
    }
    options.ctx?.infrastructureTaskIds?.add(taskId);
    onProgress('infrastructure-task-started', {
      executor: 'infrastructure-service',
      taskId,
      actionType,
      status: 'running',
      log: { level: 'info', phase: 'infrastructure', message: `基础设施任务已提交：${taskId}` },
    });

    const timeoutMs = Math.max(10000, Math.min(600000, Number(step.timeout_ms || step.timeoutMs) || 30000)) + 10000;
    const caseDeadline = Number(options.ctx?.caseDeadline) || Number.POSITIVE_INFINITY;
    const deadline = Math.min(Date.now() + timeoutMs, caseDeadline);
    let afterSequence = 0;
    let lastProgressKey = '';
    try {
      while (!isInfrastructureTerminalStatus(task.status)) {
        if (options.ctx?.stopped) {
          await this.api.cancelInfrastructureTask(taskId, executionCapability).catch(() => {});
          throw new Error('用户手动停止');
        }
        if (Date.now() >= deadline) {
          await this.api.cancelInfrastructureTask(taskId, executionCapability).catch(() => {});
          throw new Error(deadline === caseDeadline ? '用例执行超时' : `基础设施任务超时（${timeoutMs}ms）`);
        }
        await this._sleep(500);
        task = unwrapInfrastructureTask(await this.api
          .getInfrastructureTask(taskId, afterSequence, executionCapability));
        const sequence = Number(task.nextSequence ?? afterSequence) || afterSequence;
        afterSequence = Math.max(afterSequence, sequence);
        const taskLogs = Array.isArray(task.logs) ? task.logs : [];
        for (const log of taskLogs) {
          onProgress('infrastructure-task-progress', {
            executor: 'infrastructure-service',
            taskId,
            actionType,
            status: String(task.status || 'running').toLowerCase(),
            log: {
              level: ['success', 'warning', 'error', 'info'].includes(String(log?.level || '').toLowerCase())
                ? String(log.level).toLowerCase()
                : 'info',
              phase: 'infrastructure',
              // 服务端按任务日志契约完成脱敏；扩展不拼接步骤原文、SQL 或 target_ref。
              message: String(log?.message || `基础设施任务状态：${task.status || 'running'}`),
              detail: true,
            },
          });
        }
        const progressKey = `${task.status || ''}:${afterSequence}:${task.errorMessage || task.resultSummary || ''}`;
        if (progressKey !== lastProgressKey) {
          lastProgressKey = progressKey;
          onProgress('infrastructure-task-progress', {
            executor: 'infrastructure-service',
            taskId,
            actionType,
            status: String(task.status || 'running').toLowerCase(),
            log: {
              level: String(task.status || '').toLowerCase() === 'failed' ? 'error' : 'info',
              phase: 'infrastructure',
              message: task.errorMessage || task.resultSummary || `基础设施任务状态：${task.status || 'running'}`,
              detail: true,
            },
          });
        }
      }
      const status = String(task.status || '').trim().toLowerCase();
      if (status !== 'passed') {
        const error = new Error(task.errorMessage || task.error || `基础设施任务执行失败：${status}`);
        error.infrastructureTaskId = taskId;
        throw error;
      }
      return {
        executor: task.executor || 'infrastructure-service',
        taskId,
        exitCode: task.exitCode ?? task.exit_code,
        affectedRows: task.affectedRows ?? task.affected_rows,
        // 受限结果预览进入 step.details；完整输出和大结果只能通过 Admin 受鉴权附件读取。
        infrastructure: task.result?.infrastructure && typeof task.result.infrastructure === 'object'
          ? task.result.infrastructure
          : null,
        // Admin 只对白名单基础设施动作返回受限变量快照；扩展不会读取命令输出或凭据。
        variables: task.result?.variables && typeof task.result.variables === 'object'
          ? task.result.variables
          : {},
      };
    } finally {
      options.ctx?.infrastructureTaskIds?.delete(taskId);
    }
  }

  static _normalizeVariableSourceType(value) {
    const source = String(value || '').trim().toLowerCase();
    if (['literal', 'value', 'text', 'constant', '常量', '固定值'].includes(source)) return 'literal';
    if (['locator', 'element', '页面元素', '元素'].includes(source)) return 'locator';
    if (['script', 'javascript', 'js', '脚本'].includes(source)) return 'script';
    return source;
  }

  static _transformVariableValue(value, step) {
    let transformed = value == null ? '' : String(value);
    const pattern = String(step?.regex || '');
    if (pattern) {
      if (pattern.length > 512) throw new Error('变量提取正则长度不能超过 512');
      let match;
      try {
        match = new RegExp(pattern).exec(transformed);
      } catch {
        throw new Error('变量提取正则不合法');
      }
      if (!match) throw new Error('变量提取正则未匹配到内容');
      const group = String(step?.regex_group || '1');
      transformed = match.groups?.[group] ?? match[Number(group)] ?? match[0];
    }
    if (step?.replace_from != null && String(step.replace_from) !== '') {
      transformed = transformed.split(String(step.replace_from)).join(String(step.replace_to ?? ''));
    }
    return transformed;
  }

  async _readVariableFromLocatorCDP(tabId, step) {
    if (tabId == null) throw new Error('从页面元素读取变量需要受控浏览器标签页');
    const mode = String(step?.read_mode || 'text').trim().toLowerCase();
    if (mode.startsWith('attribute:')) {
      return {
        value: await this._waitForTargetAttributeCDP(tabId, step, mode.slice('attribute:'.length)),
        locator: PlayerManager._actualLocatorFromVia(step, step.target_selector ? 'css' : 'xpath'),
      };
    }
    const result = await this._waitForVariableValueCDP(tabId, step, 8000, true);
    if (!result) throw new Error('从页面元素读取变量失败：找不到目标元素');
    return {
      value: result.value,
      locator: PlayerManager._actualLocatorFromVia(
        step,
        result.via,
        result.matched_count,
        result.visible_count,
      ),
    };
  }

  static _remoteResultValue(remoteResult) {
    if (remoteResult && Object.prototype.hasOwnProperty.call(remoteResult, 'value')) {
      return remoteResult.value;
    }
    return remoteResult?.unserializableValue ?? remoteResult?.description ?? '';
  }

  async _executeLocalVariableAction(tabId, step, variableContext) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    if (actionType === 'global_variable_set') {
      const name = String(step?.variable_name || '').trim();
      const source = PlayerManager._normalizeVariableSourceType(step?.source_type ?? step?.source ?? 'literal');
      let value;
      let locator = null;
      if (source === 'literal') {
        value = step?.value ?? '';
      } else if (source === 'locator') {
        const captured = await this._readVariableFromLocatorCDP(tabId, step);
        value = captured.value;
        locator = captured.locator;
      } else if (source === 'script') {
        if (tabId == null) throw new Error('从页面脚本读取变量需要受控浏览器标签页');
        const result = await this._evaluatePageScriptCDP(tabId, step?.script ?? step?.value);
        value = PlayerManager._remoteResultValue(result);
      } else {
        throw new Error(`不支持的变量来源：${source || '(空)'}`);
      }
      const variable = variableContext.set(
        name,
        PlayerManager._transformVariableValue(value, step),
        {
          masked: toBoolean(step?.value_masked),
          overwrite: step?.overwrite !== false && step?.overwrite !== 'false',
          source,
        },
      );
      return { variable, ...(locator ? { locator } : {}) };
    }

    if (actionType === 'global_variable_date') {
      const name = String(step?.variable_name || '').trim();
      const mode = String(step?.date_mode || 'current_datetime').trim().toLowerCase();
      const offsetSeconds = Number(step?.offset_seconds ?? 0);
      if (!Number.isFinite(offsetSeconds)) throw new Error('offset_seconds 必须是有效数字');
      const date = mode === 'custom_datetime'
        ? new Date(String(step?.datetime ?? step?.date_value ?? step?.value ?? ''))
        : new Date();
      if (Number.isNaN(date.getTime())) throw new Error('自定义日期不是合法时间');
      date.setTime(date.getTime() + offsetSeconds * 1000);
      const unit = String(step?.timestamp_unit || 'milliseconds').trim().toLowerCase();
      const value = mode === 'timestamp'
        ? (unit === 'seconds' ? Math.floor(date.getTime() / 1000) : date.getTime())
        : formatVariableDate(date, step?.format || 'yyyy-MM-dd HH:mm:ss');
      return {
        variable: variableContext.set(name, value, {
          masked: toBoolean(step?.value_masked),
          overwrite: step?.overwrite !== false && step?.overwrite !== 'false',
          source: 'date',
        }),
      };
    }

    if (actionType === 'global_variable_formula') {
      const value = evaluateArithmeticExpression(step?.expression ?? step?.value, variableContext);
      return {
        variable: variableContext.set(String(step?.variable_name || '').trim(), formatFormulaValue(value, step), {
          masked: toBoolean(step?.value_masked),
          overwrite: step?.overwrite !== false && step?.overwrite !== 'false',
          source: 'formula',
        }),
      };
    }

    const reference = String(step?.variable_name || step?.value || '').trim();
    const expected = String(step?.expect ?? step?.expected ?? '');
    const raw = variableContext.get(reference);
    const actual = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const matched = actual.includes(expected);
    const negate = actionType === 'assert_variable_list_not';
    if (negate ? matched : !matched) {
      throw new Error(negate
        ? `变量 ${reference} 不应包含 ${expected}`
        : `变量 ${reference} 未包含 ${expected}`);
    }
    return { variable: variableContext.describe(reference) };
  }

  _applyInfrastructureVariableResult(step, infrastructureResult, variableContext) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    const name = String(step?.variable_name || step?.result_binding || '').trim();
    const variables = infrastructureResult?.variables;
    if (!name) return null;
    if (!name || !variables || !Object.prototype.hasOwnProperty.call(variables, name)) {
      if (['global_variable_system_info', 'global_variable_available_ip', 'global_variable_property', 'captcha_ocr'].includes(actionType)) {
        throw new Error(`基础设施变量动作未返回变量：${name || '(空)'}`);
      }
      return null;
    }
    return variableContext.set(name, variables[name], {
      masked: toBoolean(step?.value_masked),
      overwrite: step?.overwrite !== false && step?.overwrite !== 'false',
      source: 'infrastructure',
    });
  }

  // =========================================================
  // CDP 相关
  // =========================================================
  _canUseCDP(step) {
    return isCuecastCdpAction(step?.action_type);
  }

  async _attachDebugger(tabId, ctx) {
    let attachError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        ctx.debuggerAttached = true;
        attachError = null;
        break;
      } catch (error) {
        attachError = error;
        const retryable = /Cannot attach to this target|No tab with given id/i
          .test(String(error?.message || error));
        if (!retryable || attempt >= 3) break;
        // 新建 about:blank 标签页的 debugger target 可能晚于 tabs/windows API 返回，短暂等待后重试。
        await this._sleep(150 * (attempt + 1));
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) break;
      }
    }
    if (!ctx.debuggerAttached) {
      ctx.cdpAttachError = attachError?.message || String(attachError || '未知错误');
      console.warn('[Player] CDP attach 失败，降级为 DOM 模式:', ctx.cdpAttachError);
      return false;
    }

    try {
      await this._configureCertificateErrors(tabId, ctx);
      // 开启 Page 域以接收 javascriptDialogOpening；即使该订阅失败，后续仍会直接尝试 handleJavaScriptDialog。
      await this._cdpSend(tabId, 'Page.enable').catch(() => {});
      return true;
    } catch (e) {
      ctx.cdpAttachError = `CDP 初始化失败：${e?.message || String(e)}`;
      console.warn('[Player] CDP 初始化失败，降级为 DOM 模式:', ctx.cdpAttachError);
      await chrome.debugger.detach({ tabId }).catch(() => {});
      ctx.debuggerAttached = false;
      return false;
    }
  }

  async _detachDebugger(tabId, ctx) {
    if (!ctx.debuggerAttached) return;
    if (ctx.certificateErrorListener) {
      chrome.debugger.onEvent.removeListener(ctx.certificateErrorListener);
      ctx.certificateErrorListener = null;
    }
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {}
    ctx.debuggerAttached = false;
  }

  async _configureCertificateErrors(tabId, ctx) {
    const ignore = ctx.ignoreHttpsErrors === true;
    ctx.certificateErrorMode = ignore ? 'direct' : 'disabled';
    try {
      // 新版协议支持该命令时，必须在业务页面首次导航前调用。
      await this._cdpSend(tabId, 'Security.setIgnoreCertificateErrors', { ignore });
      return;
    } catch (error) {
      const unsupported = /wasn't found|not found/i.test(String(error?.message || error));
      if (!unsupported) throw error;
      if (!ignore) return;
    }

    // 部分 Chrome 的扩展 debugger 不暴露 setIgnoreCertificateErrors，使用旧版事件协议兜底。
    try {
      await this._cdpSend(tabId, 'Security.setOverrideCertificateErrors', { override: true });
    } catch (error) {
      if (!/wasn't found|not found/i.test(String(error?.message || error))) throw error;
      // 证书拦截页会变成扩展不可调试目标，不能用键盘序列规避；直接提示可执行的替代方案。
      throw new Error(
        '当前 Chrome 不允许扩展忽略 HTTPS 证书错误，请关闭该选项后重试，或改用 Playwright Runner/安装受信任证书',
      );
    }
    ctx.certificateErrorMode = 'event-override';
    const listener = (source, method, params) => {
      if (source?.tabId !== tabId || method !== 'Security.certificateError') return;
      void this._cdpSend(tabId, 'Security.handleCertificateError', {
        eventId: params?.eventId,
        action: 'continue',
      }).catch((error) => console.warn('[Player] 处理 HTTPS 证书错误失败:', error?.message || error));
    };
    chrome.debugger.onEvent.addListener(listener);
    ctx.certificateErrorListener = listener;
  }

  _extractTabContext(step) {
    const meta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const tab = meta?.context?.tab;
    if (!tab || typeof tab !== 'object') {
      const n = Number(step?.value);
      return Number.isInteger(n) && n >= 0 ? { index: n, url: step?.url || '' } : null;
    }
    const index = Number(tab.index);
    if (!Number.isInteger(index) || index < 0) return null;
    return {
      index,
      url: String(tab.url || step?.url || '').trim(),
      openerIndex: Number.isInteger(Number(tab.opener_index)) ? Number(tab.opener_index) : null,
    };
  }

  _sameUrlForTabContext(actualUrl, expectedUrl) {
    const actual = String(actualUrl || '').trim();
    const expected = String(expectedUrl || '').trim();
    if (!expected) return true;
    if (actual === expected) return true;
    try {
      const a = new URL(actual);
      const e = new URL(expected);
      return a.origin === e.origin && a.pathname === e.pathname;
    } catch {
      return false;
    }
  }

  async _findPlaybackTabForContext(ctx, tabContext, currentTabId) {
    if (!ctx.tabRegistry || typeof ctx.tabRegistry.get !== 'function') ctx.tabRegistry = new Map();
    const existing = ctx.tabRegistry.get(tabContext.index);
    if (existing?.tabId != null) {
      const tab = await chrome.tabs.get(existing.tabId).catch(() => null);
      if (tab) return tab;
      ctx.tabRegistry.delete(tabContext.index);
    }

    let currentTab = await chrome.tabs.get(currentTabId).catch(() => null);
    if (!currentTab) {
      const live = await this._livePlaybackTabEntries(ctx);
      currentTab = live[0]?.[2] || null;
    }
    const windowId = currentTab?.windowId;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const tabs = await chrome.tabs.query(windowId != null ? { windowId } : {}).catch(() => []);
      const candidates = tabs
        .filter((tab) => tab?.id != null)
        .filter((tab) => ![...ctx.tabRegistry.values()].some((item) => Number(item.tabId) === Number(tab.id)))
        .filter((tab) => this._sameUrlForTabContext(tab.url, tabContext.url) || this._sameUrlForTabContext(tab.pendingUrl, tabContext.url));
      const match = candidates[0] || null;
      if (match) return match;
      await this._sleep(300);
    }
    return null;
  }

  async _switchPlaybackContext(currentTabId, step, ctx, cdpAvailable, screenshotMode) {
    const tabContext = this._extractTabContext(step);
    if (!tabContext) throw new Error('切换标签页失败：步骤缺少 tab context');
    if (!ctx.tabRegistry || typeof ctx.tabRegistry.get !== 'function') ctx.tabRegistry = new Map();
    const currentEntry = [...ctx.tabRegistry.entries()].find(([, item]) => Number(item.tabId) === Number(currentTabId));
    if (currentEntry && currentEntry[0] === tabContext.index) {
      return { tabId: currentTabId, cdpAvailable };
    }

    const targetTab = await this._findPlaybackTabForContext(ctx, tabContext, currentTabId);
    if (!targetTab?.id) {
      throw new Error(`切换标签页失败：未找到标签页 #${tabContext.index}${tabContext.url ? ` (${tabContext.url})` : ''}`);
    }

    if (ctx.debuggerAttached && currentTabId != null) await this._detachDebugger(currentTabId, ctx).catch(() => {});
    await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
    if (targetTab.windowId != null) await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
    await this._waitForTabLoad(targetTab.id);
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      files: ['content/player.js'],
    }).catch(() => {});
    ctx.tabRegistry.set(tabContext.index, {
      tabId: targetTab.id,
      url: targetTab.url || tabContext.url || '',
      openerIndex: tabContext.openerIndex,
    });
    ctx.tabId = targetTab.id;
    ctx.activeTabId = targetTab.id;
    ctx.managedTabIds?.add(targetTab.id);
    this._pageErrorCheckEnabledByTab = this._pageErrorCheckEnabledByTab || new Map();
    this._pageErrorCheckEnabledByTab.set(targetTab.id, ctx.pageErrorCheckEnabled);
    const nextCdpAvailable = await this._attachDebugger(targetTab.id, ctx);
    if (screenshotMode === 'full_hd') await this._sleep(80);
    return { tabId: targetTab.id, cdpAvailable: nextCdpAvailable };
  }

  async _cdpSend(tabId, method, params = {}, options = {}) {
    // 子调试会话有独立的 execution context，不能混入主会话选中的 iframe contextId。
    const effectiveParams = options.sessionId ? params : await this._prepareCdpCommandParams(tabId, method, params);
    const target = options.sessionId ? { tabId, sessionId: options.sessionId } : { tabId };
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`CDP 命令超时：${method}`));
      }, Math.max(1, Math.min(options.timeoutMs ?? CDP_COMMAND_TIMEOUT_MS, CDP_COMMAND_TIMEOUT_MS)));
      // Runtime.evaluate 可能需要绑定当前 iframe 的 execution context；必须发送预处理后的参数。
      chrome.debugger.sendCommand(target, method, effectiveParams, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  }

  /** 将 Runtime.evaluate 定向到当前 iframe，并把 iframe 内局部鼠标坐标转换到页面视口。 */
  async _prepareCdpCommandParams(tabId, method, params = {}) {
    let effective = params;
    if (method === 'Runtime.evaluate' && !Object.prototype.hasOwnProperty.call(params, 'contextId')) {
      const frame = this._frameContextByTab.get(tabId);
      if (frame?.contextId != null) {
        effective = { ...effective, contextId: frame.contextId };
      }
    }
    if (
      method === 'Input.dispatchMouseEvent'
      && Number.isFinite(Number(effective.x))
      && Number.isFinite(Number(effective.y))
      && this._frameContextByTab.has(tabId)
    ) {
      const point = await this._translateFramePointToViewport(tabId, Number(effective.x), Number(effective.y));
      effective = { ...effective, x: point.x, y: point.y };
    }
    return effective;
  }

  _clearFrameSelection(tabId) {
    this._frameStackByTab.delete(tabId);
    this._frameContextByTab.delete(tabId);
  }

  async _getFrameIndex(tabId) {
    const response = await this._cdpSend(tabId, 'Page.getFrameTree');
    const byId = new Map();
    let rootFrameId = '';
    const visit = (node, parentFrameId = '') => {
      if (!node?.frame?.id) return;
      const frameId = node.frame.id;
      if (!rootFrameId) rootFrameId = frameId;
      byId.set(frameId, {
        frameId,
        parentFrameId,
        name: node.frame.name || '',
        url: node.frame.url || '',
      });
      for (const child of node.childFrames || []) visit(child, frameId);
    };
    visit(response?.frameTree);
    return { rootFrameId, byId };
  }

  async _translateFramePointToViewport(tabId, x, y) {
    const active = this._frameContextByTab.get(tabId);
    if (!active?.frameId) return { x, y };
    try {
      const { rootFrameId, byId } = await this._getFrameIndex(tabId);
      let cursor = active.frameId;
      let viewportX = x;
      let viewportY = y;
      while (cursor && cursor !== rootFrameId) {
        const owner = await this._cdpSend(tabId, 'DOM.getFrameOwner', { frameId: cursor });
        const backendNodeId = owner?.backendNodeId;
        if (!backendNodeId) break;
        const model = await this._cdpSend(tabId, 'DOM.getBoxModel', { backendNodeId });
        const quad = model?.model?.content || model?.model?.border;
        if (!Array.isArray(quad) || quad.length < 8) break;
        const horizontal = [quad[0], quad[2], quad[4], quad[6]];
        const vertical = [quad[1], quad[3], quad[5], quad[7]];
        viewportX += Math.min(...horizontal);
        viewportY += Math.min(...vertical);
        cursor = byId.get(cursor)?.parentFrameId || '';
      }
      return { x: viewportX, y: viewportY };
    } catch {
      // 坐标转换失败时仍交给 CDP；后续 actionability 检查会给出具体定位失败原因。
      return { x, y };
    }
  }

  static _buildSimpleTargetElementExpr(selector, xpath) {
    let safeSelector = String(selector || '').trim();
    const safeXpath = PlayerManager._normalizeXPath(xpath);
    if (PlayerManager._isVolatileRcCss(safeSelector) || /:\w+-of-type\(0\)/.test(safeSelector)) safeSelector = '';
    const expressions = [];
    if (safeXpath) {
      expressions.push(`document.evaluate(${JSON.stringify(safeXpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`);
    }
    if (safeSelector) {
      expressions.push(`document.querySelector(${JSON.stringify(safeSelector)})`);
    }
    return expressions.length ? `(${expressions.join(' || ')})` : 'null';
  }

  async _resolveFrameId(tabId, step) {
    const selector = String(step?.target_selector || step?.selector || '').trim();
    const xpath = String(step?.target_xpath || step?.xpath || '').trim();
    if (selector || xpath) {
      const expression = PlayerManager._buildSimpleTargetElementExpr(selector, xpath);
      const deadline = Date.now() + this._getEffectiveWaitTimeout(tabId, 5000);
      let objectId = '';
      do {
        const result = await this._cdpSend(tabId, 'Runtime.evaluate', {
          expression,
          returnByValue: false,
        });
        if (result?.exceptionDetails) {
          throw new Error(`定位 iframe 失败：${result.exceptionDetails.text || 'Runtime.evaluate error'}`);
        }
        objectId = result?.result?.objectId || '';
        if (objectId || Date.now() >= deadline) break;
        await this._sleep(250);
      } while (Date.now() < deadline);
      if (!objectId) {
        throw new Error(`找不到 iframe 元素\n  CSS: ${selector || '—'}\n  XPath: ${xpath || '—'}`);
      }
      const node = await this._cdpSend(tabId, 'DOM.describeNode', { objectId });
      const frameId = node?.node?.frameId;
      if (!frameId) {
        throw new Error('目标元素不是可切换的 iframe');
      }
      return frameId;
    }

    const { rootFrameId, byId } = await this._getFrameIndex(tabId);
    const currentFrameId = this._frameContextByTab.get(tabId)?.frameId || rootFrameId;
    const candidates = Array.from(byId.values()).filter((item) => item.parentFrameId === currentFrameId);
    const rawIndex = step?.index ?? step?.frame_index ?? step?.value;
    const requested = Number(rawIndex);
    if (!Number.isInteger(requested)) {
      throw new Error('切换 iframe 需要 target_ref 或 1 起始的 iframe 序号');
    }
    const index = requested > 0 ? requested - 1 : 0;
    if (!candidates[index]) {
      throw new Error(`iframe 序号无效：${rawIndex}，当前层级 iframe 数量=${candidates.length}`);
    }
    return candidates[index].frameId;
  }

  async _selectFrame(tabId, frameId) {
    const { rootFrameId, byId } = await this._getFrameIndex(tabId);
    if (!byId.has(frameId) || frameId === rootFrameId) {
      this._clearFrameSelection(tabId);
      return;
    }
    const path = [];
    let cursor = frameId;
    while (cursor && cursor !== rootFrameId) {
      const item = byId.get(cursor);
      if (!item) throw new Error('iframe 层级已变化，无法恢复执行上下文');
      path.unshift(item);
      cursor = item.parentFrameId;
    }
    const stack = [];
    for (const item of path) {
      const world = await this._cdpSend(tabId, 'Page.createIsolatedWorld', {
        frameId: item.frameId,
        worldName: 'cuecast-playback',
        grantUniveralAccess: true,
      });
      if (world?.executionContextId == null) {
        throw new Error('创建 iframe CDP 执行上下文失败');
      }
      stack.push({ ...item, contextId: world.executionContextId });
    }
    this._frameStackByTab.set(tabId, stack);
    this._frameContextByTab.set(tabId, stack[stack.length - 1]);
  }

  async _executeFrameAction(tabId, step) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    // 鼠标相对坐标以当前 frame 的视口为参照，切换 frame 后不能沿用上一层的局部坐标。
    this._pointerPositionByTab.delete(tabId);
    if (actionType === 'frame_main') {
      this._clearFrameSelection(tabId);
      return;
    }
    if (actionType === 'frame_parent') {
      const stack = [...(this._frameStackByTab.get(tabId) || [])];
      stack.pop();
      if (!stack.length) {
        this._clearFrameSelection(tabId);
      } else {
        this._frameStackByTab.set(tabId, stack);
        this._frameContextByTab.set(tabId, stack[stack.length - 1]);
      }
      return;
    }
    const frameId = await this._resolveFrameId(tabId, step);
    await this._selectFrame(tabId, frameId);
  }

  /** 当前 tab 设置过隐式等待时，它是后续定位动作的默认超时；否则沿用动作已有默认值。 */
  _getEffectiveWaitTimeout(tabId, fallbackMs) {
    const fallback = Math.max(0, Math.round(Number(fallbackMs) || 0));
    const implicit = this._implicitWaitMsByTab.has(tabId)
      ? this._implicitWaitMsByTab.get(tabId)
      : fallback;
    const stepTimeout = this._stepTimeoutMsByTab.has(tabId)
      ? this._stepTimeoutMsByTab.get(tabId)
      : implicit;
    const caseRemaining = this._caseDeadlineByTab.has(tabId)
      ? Math.max(0, this._caseDeadlineByTab.get(tabId) - Date.now())
      : stepTimeout;
    return Math.max(0, Math.min(implicit, stepTimeout, caseRemaining));
  }

  _setImplicitWaitTimeout(tabId, step) {
    const raw = step?.duration_ms ?? step?.timeout_ms ?? step?.value;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('隐式等待的 duration_ms 必须是大于或等于 0 的毫秒数');
    }
    // 所有 CDP 定位循环仍受统一的 wall-clock 上限约束，避免错误配置让 Service Worker 长时间悬挂。
    this._implicitWaitMsByTab.set(
      tabId,
      Math.min(Math.round(value), PlayerManager.LOADING_WAIT_WALL_MS),
    );
  }

  static _firstStepString(step, fields) {
    for (const field of fields) {
      if (step?.[field] != null) return String(step[field]);
    }
    return '';
  }

  static _resolveAssertionExpectedValue(step) {
    const contextAssertion = PlayerManager._parseLocatorMetaObject(step?.locator_meta)?.context?.assertion;
    for (const value of [step?.expect, step?.expected, step?.value, contextAssertion?.preview]) {
      if (value == null) continue;
      const text = String(value);
      if (text.trim()) return text;
    }
    return '';
  }

  static _parseLegacyLocator(raw) {
    const value = String(raw || '').trim();
    if (!value) return { selector: '', xpath: '' };
    const xpath = value.match(/^xpath\s*=\s*(.+)$/i);
    if (xpath) return { selector: '', xpath: xpath[1].trim() };
    const css = value.match(/^css\s*=\s*(.+)$/i);
    if (css) return { selector: css[1].trim(), xpath: '' };
    if (/^(?:\/|\(|\.\/|\.\.\/)/.test(value)) return { selector: '', xpath: value };
    return { selector: value, xpath: '' };
  }

  static _optionLocatorFromStep(step) {
    const selector = PlayerManager._firstStepString(step, [
      'option_selector',
      'option_target_selector',
      'element_selector',
    ]).trim();
    const xpath = PlayerManager._firstStepString(step, [
      'option_xpath',
      'option_target_xpath',
      'element_xpath',
    ]).trim();
    if (selector || xpath) return { selector, xpath };
    return PlayerManager._parseLegacyLocator(step?.element);
  }

  static _formatInputDate(format, date = new Date()) {
    const year = String(date.getFullYear());
    const values = {
      yyyy: year,
      YYYY: year,
      yy: year.slice(-2),
      YY: year.slice(-2),
      MM: PlayerManager._pad2(date.getMonth() + 1),
      M: String(date.getMonth() + 1),
      dd: PlayerManager._pad2(date.getDate()),
      DD: PlayerManager._pad2(date.getDate()),
      d: String(date.getDate()),
      HH: PlayerManager._pad2(date.getHours()),
      H: String(date.getHours()),
      mm: PlayerManager._pad2(date.getMinutes()),
      m: String(date.getMinutes()),
      ss: PlayerManager._pad2(date.getSeconds()),
      s: String(date.getSeconds()),
      SSS: String(date.getMilliseconds()).padStart(3, '0'),
    };
    return String(format || 'yyyy-MM-dd HH:mm:ss')
      .replace(/yyyy|YYYY|SSS|yy|YY|MM|dd|DD|HH|mm|ss|M|d|H|m|s/g, (token) => values[token]);
  }

  static _parseDateOffsetSeconds(step) {
    const direct = step?.offset_seconds;
    if (direct != null && String(direct).trim() !== '') {
      const value = Number(direct);
      if (!Number.isFinite(value)) throw new Error('offset_seconds 必须是有效数字');
      return value;
    }
    // 兼容旧 XML 的 keys，例如 -60*4；只接收数值乘法，绝不执行任意表达式。
    const legacy = String(step?.keys ?? '').replace(/\s+/g, '');
    if (!legacy) return 0;
    if (!/^[+-]?\d+(?:\*[+-]?\d+)*$/.test(legacy)) {
      throw new Error('旧时间偏移 keys 仅支持数字和 *，例如 -60*4');
    }
    return legacy.split('*').reduce((total, part) => total * Number(part), 1);
  }

  _buildInputDateValue(step) {
    const rawDate = PlayerManager._firstStepString(step, ['datetime', 'date_value', 'date']).trim();
    const date = rawDate ? new Date(rawDate) : new Date();
    if (Number.isNaN(date.getTime())) {
      throw new Error(`无法解析 input_date 的日期值：${rawDate}`);
    }
    const offsetSeconds = PlayerManager._parseDateOffsetSeconds(step);
    date.setTime(date.getTime() + offsetSeconds * 1000);
    return PlayerManager._formatInputDate(step?.format || step?.key || 'yyyy-MM-dd HH:mm:ss', date);
  }

  async _setTextLikeInputWithRetry(tabId, step, value, autoConfirmAntSelect = false) {
    let actualLocator = null;
    if (step.target_selector || step.target_xpath || step.locator_meta) {
      const probe = await this._getElementBoxResult(
        tabId,
        step.target_selector,
        step.target_xpath,
        '',
        1600,
        false,
        step.locator_meta,
      );
      if (probe?.ok) actualLocator = PlayerManager._actualLocatorFromVia(step, probe.box?.via);
    }
    const deadline = Date.now() + this._getEffectiveWaitTimeout(tabId, 8000);
    let lastErr = null;
    do {
      await this._throwIfPageError(tabId);
      try {
        await this._setInputValueCDP(
          tabId,
          step.target_selector,
          step.target_xpath,
          value,
          step.locator_meta,
          autoConfirmAntSelect,
        );
        return actualLocator;
      } catch (error) {
        lastErr = error;
        if (Date.now() >= deadline) break;
        await this._sleep(400);
      }
    } while (Date.now() < deadline);
    throw new Error(
      `输入失败（等待超时）\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}\n  ${lastErr?.message || ''}`,
    );
  }

  async _executeInputDateCDP(tabId, step) {
    const value = this._buildInputDateValue(step);
    const locator = await this._setTextLikeInputWithRetry(tabId, step, value, false);
    await this._sleep(120);
    return locator;
  }

  async _executeClearCDP(tabId, step) {
    const locator = await this._setTextLikeInputWithRetry(tabId, step, '', false);
    await this._sleep(80);
    return locator;
  }

  /**
   * Chrome Debugger 协议支持 DOM.setFileInputFiles。文件路径只能来自显式 file_ref/certificate_ref，
   * 拒绝变量、相对路径和目录回退，避免扩展把任意页面文本误解释为宿主机文件路径。
   */
  async _executeFileUploadCDP(tabId, step, executionCapability = '', executionBatchId = '') {
    const staged = await this._stageFilePathsFromStep(step, executionCapability, executionBatchId);
    try {
      const expression = PlayerManager._buildSimpleTargetElementExpr(step?.target_selector, step?.target_xpath);
      if (expression === 'null') throw new Error('file_upload 需要文件控件定位');
      const deadline = Date.now() + this._getEffectiveWaitTimeout(tabId, 8000);
      let lastError = '';
      do {
        const evaluated = await this._cdpSend(tabId, 'Runtime.evaluate', {
          expression,
          returnByValue: false,
        });
        const objectId = evaluated?.result?.objectId || '';
        if (objectId) {
          try {
            const described = await this._cdpSend(tabId, 'DOM.describeNode', { objectId });
            const node = described?.node;
            const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
            const typeIndex = attributes.findIndex((value) => String(value).toLowerCase() === 'type');
            const inputType = typeIndex >= 0 ? String(attributes[typeIndex + 1] || '').toLowerCase() : '';
            if (String(node?.nodeName || '').toLowerCase() !== 'input' || inputType !== 'file') {
              throw new Error('目标元素不是 input[type=file]');
            }
            // objectId 与本轮定位结果同生命周期，避免继续使用页面刷新后可能失效的 nodeId。
            await this._cdpSend(tabId, 'DOM.setFileInputFiles', { objectId, files: staged.files });
            const fileNames = staged.files.map(PlayerManager._fileNameFromPath);
            const locator = PlayerManager._actualLocatorFromVia(step, step?.target_xpath ? 'xpath' : 'css');
            return {
              ...(locator || {}),
              operationFacts: {
                filename: fileNames.length === 1 ? fileNames[0] : fileNames.join(', '),
                file_count: fileNames.length,
                upload_status: '上传控件已设置',
                ...(String(step?.action_type || '').toLowerCase() === 'certificate_upload' ? {
                  certificate_uploaded: true,
                  uploaded_certificate_files: fileNames,
                } : {}),
              },
            };
          } catch (error) {
            if (!PlayerManager._isCdpStaleFileInputError(error)) throw error;
            lastError = '文件控件在上传时已刷新，正在重新定位';
          }
        } else {
          lastError = '未找到文件控件';
        }
        if (Date.now() >= deadline) break;
        await this._sleep(250);
      } while (Date.now() < deadline);
      throw new Error(`设置上传文件失败：${lastError || '未找到文件控件'}`);
    } finally {
      await Promise.all(staged.downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
    }
  }

  async _stageFilePathsFromStep(step, executionCapability = '', executionBatchId = '') {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    const source = actionType === 'certificate_upload'
      ? (step?.certificate_ref ?? step?.certificateRef ?? step?.file_ref ?? step?.fileRef)
      : (step?.file_ref ?? step?.fileRef ?? step?.files ?? step?.file);
    const candidates = Array.isArray(source) ? source : [source];
    const localCandidates = [];
    const downloadIds = [];
    try {
      for (const rawCandidate of candidates) {
        const candidate = PlayerManager._parseFileReference(rawCandidate);
        if (candidate && typeof candidate === 'object' && candidate.download_path) {
          const downloaded = await this.api.downloadExecutionFile(candidate, executionCapability, executionBatchId);
          downloadIds.push(downloaded.downloadId);
          localCandidates.push(downloaded.localPath);
        } else if (candidate && typeof candidate === 'object'
          && candidate.scope === 'project_environment') {
          throw new Error(`${actionType || 'file_upload'} 的环境文件引用未由 Admin 物化为下载引用`);
        } else {
          localCandidates.push(candidate);
        }
      }
      const files = PlayerManager._filePathsFromStep({
          ...step,
          ...(actionType === 'certificate_upload' ? { certificate_ref: localCandidates } : { file_ref: localCandidates }),
        });
      if (String(executionBatchId || '').trim()) {
        await this._registerExecutionFileDownloads(executionBatchId, downloadIds);
        return { files, downloadIds: [] };
      }
      return { files, downloadIds };
    } catch (error) {
      await Promise.all(downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
      throw error;
    }
  }

  static _parseFileReference(value) {
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text.startsWith('{') || !text.endsWith('}')) return value;
    try {
      return JSON.parse(text);
    } catch (_) {
      return value;
    }
  }

  static _fileNameFromPath(value) {
    const text = String(value || '');
    return text.split(/[\\/]/).filter(Boolean).at(-1) || text;
  }

  static _filePathsFromStep(step) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    const source = actionType === 'certificate_upload'
      ? (step?.certificate_ref ?? step?.certificateRef ?? step?.file_ref ?? step?.fileRef)
      : (step?.file_ref ?? step?.fileRef ?? step?.files ?? step?.file);
    const candidates = Array.isArray(source) ? source : [source];
    const files = candidates.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') {
        const value = item.path ?? item.local_path ?? item.localPath ?? item.file_path ?? item.filePath;
        return Array.isArray(value) ? value : [value];
      }
      return [];
    }).map((item) => String(item || '').trim()).filter(Boolean);
    if (!files.length) throw new Error(`${actionType || 'file_upload'} 缺少 file_ref 本机绝对路径`);
    for (const file of files) {
      if (file.includes('${') || file.includes('\u0000') || /(^|[\\/])\.\.([\\/]|$)/.test(file)
        || !(/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/'))) {
        throw new Error('file_ref 必须是无变量、无上级目录片段的本机绝对路径');
      }
    }
    return files;
  }

  async _clickConfiguredOptionCDP(tabId, step, option, locale) {
    let optionLocator = PlayerManager._optionLocatorFromStep(step);
    // 兼容旧 select-click 的 value 直接填写 XPath；新 canonical option 仍优先按可见文本处理。
    if (!optionLocator.selector && !optionLocator.xpath && /^(?:xpath\s*=|css\s*=|\/|\()/i.test(String(option || '').trim())) {
      optionLocator = PlayerManager._parseLegacyLocator(option);
    }
    if (optionLocator.selector || optionLocator.xpath) {
      const boxResult = await this._getElementBoxResult(
        tabId,
        optionLocator.selector,
        optionLocator.xpath,
        '',
        5000,
        true,
      );
      const box = boxResult?.ok ? boxResult.box : null;
      if (!box) {
        throw new Error(this._formatElementWaitFailure(boxResult, optionLocator.selector, optionLocator.xpath));
      }
      await this._cdpClick(tabId, box.x, box.y);
      return PlayerManager._actualLocatorFromVia({
        ...step,
        target_selector: optionLocator.selector,
        target_xpath: optionLocator.xpath,
      }, box.via);
    }

    const box = await this._clickOverlayItem(tabId, { value: option }, locale);
    await this._cdpClick(tabId, box.x, box.y);
    return PlayerManager._actualLocatorFromVia({ ...step, value: option }, 'overlay-text');
  }

  async _executeSelectOptionCDP(tabId, step, locale) {
    const option = PlayerManager._firstStepString(step, ['option', 'value', 'expect']);
    if (option.trim() === '') throw new Error('select_option 缺少 option');

    let targetLocator = null;
    if (step.target_selector || step.target_xpath || step.locator_meta) {
      const probe = await this._getElementBoxResult(
        tabId,
        step.target_selector,
        step.target_xpath,
        '',
        5000,
        false,
        step.locator_meta,
      );
      if (probe?.ok) targetLocator = PlayerManager._actualLocatorFromVia(step, probe.box?.via);
    }

    const targetExpr = PlayerManager._buildSimpleTargetElementExpr(
      step.target_selector,
      step.target_xpath,
    );
    if (targetExpr !== 'null') {
      const nativeResult = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: `(function(){
          var root = ${targetExpr};
          if (!root) return { ok: false, reason: 'target_not_found' };
          var select = String(root.tagName || '').toLowerCase() === 'select'
            ? root
            : (root.querySelector ? root.querySelector('select') : null);
          if (!select) return { ok: false, native: false };
          var wanted = ${JSON.stringify(option)};
          var items = Array.prototype.slice.call(select.options || []);
          var matched = items.find(function(item){ return item.value === wanted; })
            || items.find(function(item){ return String(item.textContent || '').trim() === wanted; });
          if (!matched) {
            return {
              ok: false,
              native: true,
              reason: 'option_not_found',
              options: items.slice(0, 30).map(function(item){ return String(item.textContent || '').trim(); })
            };
          }
          select.value = matched.value;
          matched.selected = true;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, native: true, text: String(matched.textContent || '').trim() };
        })()`,
        returnByValue: true,
      });
      const result = nativeResult?.result?.value;
      if (result?.native === true && result.ok !== true) {
        const available = Array.isArray(result.options) && result.options.length
          ? `，可选项：${result.options.join('、')}`
          : '';
        throw new Error(`原生 select 中找不到选项「${option}」${available}`);
      }
      if (result?.ok === true && result.native === true) return targetLocator;
    }

    const trigger = await this._getElementBoxResult(
      tabId,
      step.target_selector,
      step.target_xpath,
      '',
      5000,
      false,
      step.locator_meta,
    );
    const triggerBox = trigger?.ok ? trigger.box : null;
    if (!triggerBox) {
      throw new Error(this._formatElementWaitFailure(trigger, step.target_selector, step.target_xpath));
    }
    await this._cdpClick(tabId, triggerBox.x, triggerBox.y);
    await this._sleep(150);
    await this._clickConfiguredOptionCDP(tabId, step, option, locale);
    return targetLocator || PlayerManager._actualLocatorFromVia(step, triggerBox.via);
  }

  async _executeComboSelectCDP(tabId, step, locale) {
    const option = PlayerManager._firstStepString(step, ['option', 'value', 'expect']);
    if (option.trim() === '') throw new Error('combo_select 缺少 option');
    const targetLocator = await this._setTextLikeInputWithRetry(tabId, step, option, false);
    await this._sleep(160);
    await this._clickConfiguredOptionCDP(tabId, step, option, locale);
    return targetLocator;
  }

  static _scriptExpression(script) {
    const source = String(script || '').trim();
    if (!source) throw new Error('页面脚本不能为空');
    // Selenium executeScript 常见写法含顶层 return；Runtime.evaluate 需要函数包装才可执行。
    return /\breturn\b/.test(source) ? `(function(){\n${source}\n})()` : source;
  }

  async _evaluatePageScriptCDP(tabId, script) {
    const result = await this._cdpSend(tabId, 'Runtime.evaluate', {
      expression: PlayerManager._scriptExpression(script),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(`执行页面脚本失败：${result.exceptionDetails.text || 'Runtime.evaluate error'}`);
    }
    return result?.result || {};
  }

  static _scriptResultToString(remoteResult) {
    if (!remoteResult) return 'undefined';
    if (Object.prototype.hasOwnProperty.call(remoteResult, 'value')) {
      const value = remoteResult.value;
      if (value === undefined) return 'undefined';
      if (value === null) return 'null';
      if (typeof value === 'string') return value;
      if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return String(value); }
      }
      return String(value);
    }
    return String(remoteResult.unserializableValue ?? remoteResult.description ?? 'undefined');
  }

  async _executeEvaluateCDP(tabId, step) {
    await this._evaluatePageScriptCDP(tabId, step?.script ?? step?.value);
  }

  async _waitForTargetAttributeCDP(tabId, step, attribute) {
    const targetExpr = PlayerManager._buildSimpleTargetElementExpr(step.target_selector, step.target_xpath);
    if (targetExpr === 'null') throw new Error('assert_attribute 需要 target_ref');
    const deadline = Date.now() + this._getEffectiveWaitTimeout(tabId, 8000);
    let lastError = '';
    do {
      const result = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: `(function(){
          try {
            var el = ${targetExpr};
            if (!el) return { ok: false, reason: 'not_found' };
            return { ok: true, value: el.getAttribute(${JSON.stringify(attribute)}) };
          } catch (e) {
            return { ok: false, reason: String(e && e.message ? e.message : e) };
          }
        })()`,
        returnByValue: true,
      });
      const value = result?.result?.value;
      if (value?.ok) return value.value == null ? '' : String(value.value);
      lastError = value?.reason || 'not_found';
      if (Date.now() >= deadline) break;
      await this._sleep(300);
    } while (Date.now() < deadline);
    throw new Error(`断言失败：找不到属性目标元素（${lastError}）`);
  }

  async _executeAssertAttributeCDP(tabId, step) {
    const attribute = PlayerManager._firstStepString(step, ['attribute', 'value']).trim();
    const expected = PlayerManager._firstStepString(step, ['expect', 'expected']);
    if (!attribute) throw new Error('assert_attribute 缺少 attribute');
    const masked = step.value_masked === true || step.value_masked === 1;
    const operationAssertion = {
      subject: `元素属性 ${attribute}`,
      operator: 'equals',
      expected: masked ? { value_state: 'masked' } : { value_state: 'visible', preview: expected },
      actual: { value_state: 'unavailable' },
      passed: false,
    };
    let locator = null;
    try {
      // 不修改原始 playwright_step / locator_meta；仅为明确等价的 PDF XPath 补充 CDP 读取路径。
      const result = isPdfViewerAttributeTarget(step)
        ? await readPdfViewerAttribute({
          tabId,
          attribute,
          timeoutMs: this._getEffectiveWaitTimeout(tabId, 8000),
          sendCommand: (method, params, options) => this._cdpSend(tabId, method, params, options),
        })
        : { value: await this._waitForTargetAttributeCDP(tabId, step, attribute) };
      locator = result.locator || null;
      operationAssertion.actual = masked
        ? { value_state: 'masked' }
        : { value_state: 'visible', preview: String(result.value) };
      operationAssertion.passed = result.value === expected;
      if (!operationAssertion.passed) {
        throw new Error(`断言失败：属性 ${attribute} 的实际值与期望值不一致`);
      }
      return { ...(locator || {}), operationAssertion };
    } catch (error) {
      error.operationAssertion = operationAssertion;
      if (locator) error.actualLocator = locator;
      throw error;
    }
  }

  async _executeAssertScriptCDP(tabId, step) {
    const expected = PlayerManager._firstStepString(step, ['expect', 'expected']);
    const remoteResult = await this._evaluatePageScriptCDP(tabId, step?.script ?? step?.value);
    const actual = PlayerManager._scriptResultToString(remoteResult);
    if (actual !== expected) {
      throw new Error('断言失败：页面脚本返回值与期望值不一致');
    }
  }

  async _executeAssertTextNotCDP(tabId, step) {
    const expected = PlayerManager._firstStepString(step, ['expect', 'value']);
    if (expected.trim() === '') throw new Error('assert_text_not 缺少 expect');
    const actual = await this._waitForDomTextRawCDP(
      tabId,
      step.target_selector,
      step.target_xpath,
      10000,
      true,
      step.locator_meta,
    );
    if (actual == null) throw new Error('断言失败：找不到目标元素');
    const operator = String(step?.operator || step?.match || 'not_contains').trim().toLowerCase();
    const hit = operator === 'not_equals' ? actual !== expected : !actual.includes(expected);
    if (!hit) throw new Error('断言失败：元素内容包含不应出现的文本');
  }

  async _executeAssertTextRegexCDP(tabId, step) {
    const pattern = PlayerManager._firstStepString(step, ['regex', 'value']);
    if (!pattern.trim()) throw new Error('assert_text_regex 缺少 regex');
    let regex;
    try {
      regex = new RegExp(pattern, String(step?.regex_flags || ''));
    } catch (error) {
      throw new Error(`assert_text_regex 的正则无效：${error?.message || error}`);
    }
    const actual = await this._waitForDomTextRawCDP(
      tabId,
      step.target_selector,
      step.target_xpath,
      10000,
      true,
      step.locator_meta,
    );
    if (actual == null) throw new Error('断言失败：找不到目标元素');
    if (!regex.test(actual)) throw new Error('断言失败：元素内容不匹配正则表达式');
  }

  async _scrollToElementCDP(tabId, step) {
    const result = await this._getElementBoxResult(
      tabId,
      step.target_selector,
      step.target_xpath,
      '',
      5000,
      true,
      step.locator_meta,
    );
    if (!result?.ok) {
      throw new Error(this._formatElementWaitFailure(result, step.target_selector, step.target_xpath));
    }
    // _getElementBoxResult 的定位表达式会 scrollIntoView(center)，这里不触发 click，避免旧 scroll-element 的误点击副作用。
    return PlayerManager._actualLocatorFromVia(step, result.box?.via);
  }

  async _getCurrentPointerViewport(tabId) {
    const response = await this._cdpSend(tabId, 'Runtime.evaluate', {
      expression: `({ width: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1), height: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1) })`,
      returnByValue: true,
    });
    const value = response?.result?.value || {};
    return {
      width: Math.max(1, Number(value.width) || 1),
      height: Math.max(1, Number(value.height) || 1),
    };
  }

  _rememberPointerPosition(tabId, x, y) {
    this._pointerPositionByTab.set(tabId, {
      x: Number(x),
      y: Number(y),
      frameId: this._frameContextByTab.get(tabId)?.frameId || '',
    });
  }

  async _executePointerMoveCDP(tabId, step) {
    const coordinate = String(step?.coordinate || 'relative').trim().toLowerCase();
    if (coordinate && coordinate !== 'relative') {
      throw new Error('CueCast/CDP 的 pointer_move 只支持浏览器视口相对坐标；绝对屏幕坐标应使用 host_pointer_move Agent');
    }
    const offsetX = Number(step?.x ?? step?.offset_x);
    const offsetY = Number(step?.y ?? step?.offset_y);
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      throw new Error('pointer_move 需要有效的 x 和 y 相对偏移');
    }
    const frameId = this._frameContextByTab.get(tabId)?.frameId || '';
    const viewport = await this._getCurrentPointerViewport(tabId);
    const previous = this._pointerPositionByTab.get(tabId);
    const start = previous && previous.frameId === frameId
      ? previous
      : { x: viewport.width / 2, y: viewport.height / 2 };
    const x = Math.min(Math.max(0, start.x + offsetX), viewport.width - 1);
    const y = Math.min(Math.max(0, start.y + offsetY), viewport.height - 1);
    await this._cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
    });
    this._rememberPointerPosition(tabId, x, y);
  }

  async _waitForDialogOpening(tabId, timeout = 1200) {
    if (this._dialogOpeningByTab.has(tabId)) return true;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this._sleep(80);
      if (this._dialogOpeningByTab.has(tabId)) return true;
    }
    return false;
  }

  async _handleJavaScriptDialogCDP(tabId, accept, promptText) {
    const params = { accept: Boolean(accept) };
    if (accept && promptText != null) params.promptText = String(promptText);
    try {
      await this._cdpSend(tabId, 'Page.handleJavaScriptDialog', params);
    } catch (firstError) {
      // 点击触发 dialog 的 CDP 事件偶尔在下一条步骤开始后才到达；短暂等待后只重试一次。
      await this._waitForDialogOpening(tabId);
      try {
        await this._cdpSend(tabId, 'Page.handleJavaScriptDialog', params);
      } catch (secondError) {
        throw new Error(`处理浏览器弹窗失败：${secondError?.message || firstError?.message || secondError || firstError}`);
      }
    } finally {
      this._dialogOpeningByTab.delete(tabId);
    }
  }

  async _executeDialogActionCDP(tabId, step, nextStep) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    if (actionType === 'dialog_prompt') {
      const promptText = PlayerManager._firstStepString(step, ['value', 'prompt_text']);
      const nextAction = String(nextStep?.action_type || '').trim().toLowerCase();
      // Selenium 的旧 click-text 只写入文本而不关闭弹窗。CDP 无法单独写入 prompt，
      // 因而将文本暂存到紧随其后的 accept/dismiss，保持旧链路 click-text → click-ok 的语义。
      if (nextAction === 'dialog_accept' || nextAction === 'dialog_dismiss') {
        this._pendingDialogPromptByTab.set(tabId, promptText);
        return;
      }
      await this._handleJavaScriptDialogCDP(tabId, true, promptText);
      return;
    }
    const promptText = this._pendingDialogPromptByTab.get(tabId);
    this._pendingDialogPromptByTab.delete(tabId);
    await this._handleJavaScriptDialogCDP(tabId, actionType === 'dialog_accept', promptText);
  }

  /** 截取验证码元素本身，避免把整页截图或验证码内容写入场景数据。 */
  async _captureCaptchaTargetBase64(tabId, step) {
    const boxResult = await this._getElementBoxResult(
      tabId,
      step?.target_selector,
      step?.target_xpath,
      '',
      8000,
      false,
      step?.locator_meta,
    );
    const box = boxResult?.box;
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('验证码元素不可见，无法截取图片');
    }
    const screenshot = await this._cdpSend(tabId, 'Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
      captureBeyondViewport: false,
    });
    const data = String(screenshot?.data || '');
    if (!data || data.length > 3 * 1024 * 1024) {
      throw new Error('验证码截图为空或超过 2MB 限制');
    }
    return data;
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
      const loadingClassRe = /(?:^|\\s)(?:is-)?(?:loading|spinning|pending|btn-loading|button-loading|ant-btn-loading|ivu-btn-loading|el-button--loading|arco-btn-loading)(?:\\s|$)/i;
      const loadingIndicatorSel = [
        '.el-icon-loading', '.el-loading-spinner', '.is-loading',
        '.ivu-load-loop', '.ivu-icon-ios-loading', '.ivu-spin',
        '.ant-btn-loading-icon', '.anticon-loading', '.ant-spin-spinning',
        '.arco-icon-loading', '.arco-spin', '.n-spin',
        '[data-loading="true"]', '[aria-busy="true"]'
      ].join(',');
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
      function hasVisibleLoadingIndicator(root) {
        if (!root || !root.querySelectorAll) return false;
        var list = root.querySelectorAll(loadingIndicatorSel);
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item || item === root) continue;
          if (item.getAttribute && item.getAttribute('aria-hidden') === 'true') continue;
          var st = window.getComputedStyle ? window.getComputedStyle(item) : null;
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) === 0)) continue;
          var r = item.getBoundingClientRect ? item.getBoundingClientRect() : null;
          if (r && (r.width > 0 || r.height > 0)) return true;
        }
        return false;
      }
      if (el.disabled || (el.getAttribute && el.getAttribute('disabled') !== null)) {
        return { disabled: true, reason: 'native-disabled', by: brief(el) };
      }
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') {
        return { disabled: true, reason: 'aria-disabled', by: brief(el) };
      }
      if (el.getAttribute && (el.getAttribute('aria-busy') === 'true' || el.getAttribute('data-loading') === 'true')) {
        return { disabled: true, reason: 'target-loading-attr', by: brief(el) };
      }
      if (loadingClassRe.test(String(el.className || ''))) {
        return { disabled: true, reason: 'target-loading-class', by: brief(el) };
      }
      const ownerControl = el.closest && el.closest(formControlSel);
      if (ownerControl) {
        if (ownerControl.disabled || (ownerControl.getAttribute && ownerControl.getAttribute('disabled') !== null)) {
          return { disabled: true, reason: 'owner-native-disabled', by: brief(ownerControl) };
        }
        if (ownerControl.getAttribute && ownerControl.getAttribute('aria-disabled') === 'true') {
          return { disabled: true, reason: 'owner-aria-disabled', by: brief(ownerControl) };
        }
        if (ownerControl.getAttribute && (ownerControl.getAttribute('aria-busy') === 'true' || ownerControl.getAttribute('data-loading') === 'true')) {
          return { disabled: true, reason: 'owner-loading-attr', by: brief(ownerControl) };
        }
        if (loadingClassRe.test(String(ownerControl.className || ''))) {
          return { disabled: true, reason: 'owner-loading-class', by: brief(ownerControl) };
        }
        if (hasVisibleLoadingIndicator(ownerControl)) {
          return { disabled: true, reason: 'owner-loading-indicator', by: brief(ownerControl) };
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
          if (cur.getAttribute && (cur.getAttribute('aria-busy') === 'true' || cur.getAttribute('data-loading') === 'true')) {
            return { disabled: true, reason: 'component-loading-attr', by: brief(cur) };
          }
          if (loadingClassRe.test(String(cur.className || ''))) {
            return { disabled: true, reason: 'component-loading-class', by: brief(cur) };
          }
          if (hasVisibleLoadingIndicator(cur)) {
            return { disabled: true, reason: 'component-loading-indicator', by: brief(cur) };
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
      const loadingClassRe = /(?:^|\\s)(?:is-)?(?:loading|spinning|pending|btn-loading|button-loading|ant-btn-loading|ivu-btn-loading|el-button--loading|arco-btn-loading)(?:\\s|$)/i;
      const loadingIndicatorSel = [
        '.el-icon-loading', '.el-loading-spinner', '.is-loading',
        '.ivu-load-loop', '.ivu-icon-ios-loading', '.ivu-spin',
        '.ant-btn-loading-icon', '.anticon-loading', '.ant-spin-spinning',
        '.arco-icon-loading', '.arco-spin', '.n-spin',
        '[data-loading="true"]', '[aria-busy="true"]'
      ].join(',');
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
      function hasVisibleLoadingIndicator(root) {
        if (!root || !root.querySelectorAll) return false;
        var list = root.querySelectorAll(loadingIndicatorSel);
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item || item === root) continue;
          if (item.getAttribute && item.getAttribute('aria-hidden') === 'true') continue;
          var st = window.getComputedStyle ? window.getComputedStyle(item) : null;
          if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) === 0)) continue;
          var r = item.getBoundingClientRect ? item.getBoundingClientRect() : null;
          if (r && (r.width > 0 || r.height > 0)) return true;
        }
        return false;
      }
      if (el.disabled || (el.getAttribute && el.getAttribute('disabled') !== null)) {
        return { disabled: true, reason: 'native-disabled', by: brief(el) };
      }
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') {
        return { disabled: true, reason: 'aria-disabled', by: brief(el) };
      }
      if (el.getAttribute && (el.getAttribute('aria-busy') === 'true' || el.getAttribute('data-loading') === 'true')) {
        return { disabled: true, reason: 'target-loading-attr', by: brief(el) };
      }
      if (loadingClassRe.test(String(el.className || ''))) {
        return { disabled: true, reason: 'target-loading-class', by: brief(el) };
      }
      const ownerControl = el.closest && el.closest(formControlSel);
      if (ownerControl) {
        if (ownerControl.disabled || (ownerControl.getAttribute && ownerControl.getAttribute('disabled') !== null)) {
          return { disabled: true, reason: 'owner-native-disabled', by: brief(ownerControl) };
        }
        if (ownerControl.getAttribute && ownerControl.getAttribute('aria-disabled') === 'true') {
          return { disabled: true, reason: 'owner-aria-disabled', by: brief(ownerControl) };
        }
        if (ownerControl.getAttribute && (ownerControl.getAttribute('aria-busy') === 'true' || ownerControl.getAttribute('data-loading') === 'true')) {
          return { disabled: true, reason: 'owner-loading-attr', by: brief(ownerControl) };
        }
        if (loadingClassRe.test(String(ownerControl.className || ''))) {
          return { disabled: true, reason: 'owner-loading-class', by: brief(ownerControl) };
        }
        if (hasVisibleLoadingIndicator(ownerControl)) {
          return { disabled: true, reason: 'owner-loading-indicator', by: brief(ownerControl) };
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
          if (cur.getAttribute && (cur.getAttribute('aria-busy') === 'true' || cur.getAttribute('data-loading') === 'true')) {
            return { disabled: true, reason: 'component-loading-attr', by: brief(cur) };
          }
          if (loadingClassRe.test(String(cur.className || ''))) {
            return { disabled: true, reason: 'component-loading-class', by: brief(cur) };
          }
          if (hasVisibleLoadingIndicator(cur)) {
            return { disabled: true, reason: 'component-loading-indicator', by: brief(cur) };
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

  /**
   * XPath 必须原样交给浏览器。仅兼容旧数据中的 html/...、body/... 裸绝对路径，
   * 不能给括号 XPath、.// 相对 XPath或函数表达式擅自补斜杠。
   */
  static _normalizeXPath(xpath) {
    let normalized = String(xpath || '').trim();
    if (/^xpath\s*=/i.test(normalized)) normalized = normalized.replace(/^xpath\s*=\s*/i, '').trim();
    if (!normalized || PlayerManager._isVolatileRcXPath(normalized)) return '';
    return /^(?:html|body)\//i.test(normalized) ? `/${normalized}` : normalized;
  }

  static _locatorError(code, message, details = {}) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    error.locatorError = { code, message, ...details };
    return error;
  }

  static _unsupportedLocatorStrategy(value) {
    const raw = String(value || '').trim();
    const prefixed = /^(jquery|js(?:_path)?|jspath|testrigor)\s*=/i.exec(raw);
    if (prefixed) return prefixed[1].toLowerCase();
    if (/^\$\s*\(/.test(raw)) return 'jquery';
    if (/^(?:document|window)\s*\.\s*(?:querySelector|querySelectorAll)\s*\(/i.test(raw)) return 'js';
    return '';
  }

  static _xpathValidationExpr(xpath) {
    return `(function(){
      try {
        var result = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ANY_TYPE, null);
        var nodeResultTypes = [
          XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
          XPathResult.ORDERED_NODE_ITERATOR_TYPE,
          XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          XPathResult.ANY_UNORDERED_NODE_TYPE,
          XPathResult.FIRST_ORDERED_NODE_TYPE
        ];
        if (nodeResultTypes.indexOf(result.resultType) < 0) {
          return { ok: false, code: 'LOCATOR_XPATH_UNSUPPORTED', message: 'XPath result is not a node set' };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, code: 'LOCATOR_XPATH_INVALID', message: String(e && e.message || e || 'XPath evaluation failed') };
      }
    })()`;
  }

  async _validateStepXpathsCDP(tabId, step) {
    const allCandidates = PlayerManager._normalizeLocatorMetaCandidates(step?.locator_meta);
    const locatorValues = [
      { value: step?.target_selector, source: 'target_selector' },
      { value: step?.target_xpath, source: 'target_xpath' },
      ...allCandidates.map((candidate) => ({
        value: candidate?.value,
        source: `locator_meta.${String(candidate?.type || 'unknown')}`,
        type: String(candidate?.type || '').trim().toLowerCase(),
      })),
    ];
    const privateTypes = new Set(['jquery', 'js', 'js_path', 'jspath', 'testrigor']);
    for (const item of locatorValues) {
      const strategy = privateTypes.has(item.type)
        ? item.type
        : PlayerManager._unsupportedLocatorStrategy(item.value);
      if (!strategy) continue;
      throw PlayerManager._locatorError(
        'LOCATOR_STRATEGY_UNSUPPORTED',
        `Unsupported locator strategy: ${strategy}`,
        { source: item.source, strategy },
      );
    }

    const candidates = allCandidates
      .filter((candidate) => ['xpath_fallback', 'table_cell_xpath'].includes(String(candidate.type || '')));
    const values = [
      { raw: String(step?.target_xpath || '').trim(), source: 'target_xpath' },
      ...candidates.map((candidate) => ({ raw: String(candidate.value || '').trim(), source: `locator_meta.${candidate.type}` })),
    ];
    const seen = new Set();
    for (const item of values) {
      const normalized = PlayerManager._normalizeXPath(item.raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const response = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: PlayerManager._xpathValidationExpr(normalized),
        returnByValue: true,
      });
      const result = response?.result?.value;
      if (result?.ok) continue;
      const code = result?.code === 'LOCATOR_XPATH_UNSUPPORTED'
        ? 'LOCATOR_XPATH_UNSUPPORTED'
        : 'LOCATOR_XPATH_INVALID';
      throw PlayerManager._locatorError(code, result?.message || 'XPath evaluation failed', {
        source: item.source,
        raw_xpath: item.raw,
        normalized_xpath: normalized,
      });
    }
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

  /**
   * 将 v1.2 录制动作转换为 CueCast 的运行副本。
   * 原始 playwright_step 仍由 Admin 保存；这里只统一执行器和 operation 诊断身份。
   */
  static _adaptRecordedStep(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const action = String(step.action_type || '').trim().toLowerCase();
    const meta = PlayerManager._parseLocatorMetaObject(step.locator_meta);
    if (action === 'set_variable') {
      const variable = meta?.context?.variable;
      if (!variable || typeof variable !== 'object' || Array.isArray(variable)) return { ...step };
      const source = String(variable.source || 'text').trim().toLowerCase();
      const extract = variable.extract && typeof variable.extract === 'object' ? variable.extract : {};
      return {
        ...step,
        action_type: 'global_variable_set',
        original_action_type: 'set_variable',
        recording_source: 'cuecast-v1.2',
        variable_name: String(variable.name ?? step.value ?? '').trim(),
        source_type: 'locator',
        read_mode: source === 'value' ? 'value' : 'text',
        ...(String(extract.mode || 'full').trim().toLowerCase() === 'regex'
          ? { regex: String(extract.pattern ?? ''), regex_group: extract.group ?? 0 }
          : {}),
      };
    }
    if (action === 'assert_text') {
      const assertion = meta?.assertion && typeof meta.assertion === 'object'
        ? meta.assertion
        : meta?.context?.assertion;
      if (!assertion || String(assertion.target || 'element').trim().toLowerCase() !== 'element') return { ...step };
      const matchMode = String(assertion.match || '').trim().toLowerCase();
      if (!['contains', 'equals', 'not_contains', 'regex', 'visible'].includes(matchMode)) return { ...step };
      const contextAssertion = meta?.context?.assertion && typeof meta.context.assertion === 'object'
        ? meta.context.assertion
        : {};
      const source = String(contextAssertion.source || 'auto').trim().toLowerCase();
      const readMode = source === 'contenteditable'
        ? 'text'
        : (['auto', 'text', 'attribute', 'value'].includes(source) ? source : 'auto');
      const attribute = String(step?.attribute || contextAssertion.attribute || assertion.attribute || '').trim();
      if (readMode === 'attribute' && !attribute) {
        return {
          ...step,
          action_type: 'assert_element_match',
          original_action_type: 'assert_text',
          recording_source: 'cuecast-v1.2',
          read_mode: readMode,
          match_mode: matchMode,
          expect: matchMode === 'visible' ? '' : PlayerManager._resolveAssertionExpectedValue(step),
          attribute_error: '元素属性断言缺少属性名',
        };
      }
      return {
        ...step,
        action_type: 'assert_element_match',
        original_action_type: 'assert_text',
        recording_source: 'cuecast-v1.2',
        read_mode: readMode,
        ...(readMode === 'attribute' ? { attribute } : {}),
        match_mode: matchMode,
        expect: matchMode === 'visible' ? '' : PlayerManager._resolveAssertionExpectedValue(step),
      };
    }
    return { ...step };
  }

  /**
   * 变量生产步骤必须先完成写入，再解析下一步；否则下一步的引用会被提前判定为不存在。
   */
  static _shouldResolveNextStepBeforeCurrent(step) {
    const action = String(step?.action_type || '').trim().toLowerCase();
    return !isCuecastLocalVariableAction(action)
      && !isInfrastructureStep(step)
      && action !== 'captcha_ocr';
  }

  static _actualLocatorFromVia(step, via, matchedCount = 1, visibleCount = null) {
    const source = String(via || '').trim();
    if (!source) return null;
    const candidates = PlayerManager._normalizeLocatorMetaCandidates(step?.locator_meta);
    const locatorMeta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const recordedCandidates = Array.isArray(locatorMeta?.candidates) ? locatorMeta.candidates : [];
    let type = '';
    let value = '';
    let recordedCandidate = null;
    if (source.startsWith('meta-')) {
      const sourceType = source.slice(5);
      const candidate = sourceType === 'xpath'
        ? candidates.find((item) => ['table_cell_xpath', 'xpath_fallback'].includes(String(item?.type || '')))
        : sourceType === 'text'
          ? candidates.find((item) => String(item?.type || '') === 'text_exact')
          : candidates.find((item) => String(item?.type || '') === sourceType);
      type = String(candidate?.type || sourceType);
      value = String(candidate?.value || '');
      const candidateIndex = recordedCandidates.findIndex((item) => (
        String(item?.type || '') === type && String(item?.value || '') === value
      ));
      if (candidateIndex >= 0) recordedCandidate = { ...recordedCandidates[candidateIndex], index: candidateIndex };
    } else if (source === 'css') {
      type = 'css';
      value = String(step?.target_selector || '');
    } else if (source === 'xpath') {
      type = 'xpath';
      value = String(step?.target_xpath || '');
    } else if (source === 'text' || source === 'overlay-text') {
      type = 'text_exact';
      value = String(step?.value || '');
    } else {
      type = source;
      value = String(step?.target_selector || step?.target_xpath || step?.value || '');
    }
    const canonicalSource = recordedCandidate
      ? `locator_meta.candidates[${recordedCandidate.index}]`
      : source === 'css'
        ? 'target_selector'
        : source === 'xpath'
          ? 'target_xpath'
          : `cdp:${source}`;
    const recordingScore = Number(recordedCandidate?.score);
    return {
      source: canonicalSource,
      executionSource: `cdp:${source}`,
      type,
      value,
      matchedCount,
      ...(visibleCount != null ? { visibleCount } : {}),
      ...(Number.isFinite(recordingScore) ? { recordingScore } : {}),
    };
  }

  static _normalizeClickWhen(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || ['always', 'any', 'none', 'no_check'].includes(normalized)) return 'always';
    if (['off', 'unchecked', 'closed', 'inactive', 'false', '0', '关闭', '未选中', '未开启'].includes(normalized)) return 'off';
    if (['on', 'checked', 'opened', 'active', 'true', '1', '开启', '已选中', '已开启'].includes(normalized)) return 'on';
    if (['element_exists', 'exists', 'present', 'element_present', 'if_exists'].includes(normalized)) return 'element_exists';
    return normalized;
  }

  static _clickConditionLocatorFields(step) {
    const ref = step?.click_condition_ref;
    const selector = String(step?.click_condition_selector || '').trim();
    const xpath = String(step?.click_condition_xpath || '').trim();
    if (selector || xpath) return { selector, xpath };
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
      const strategy = String(ref.strategy || ref.type || '').trim().toLowerCase();
      const value = String(ref.value || ref.locator_value || ref.locatorValue || '').trim();
      return {
        selector: strategy === 'css' ? value : String(ref.target_selector || ref.selector || '').trim(),
        xpath: strategy === 'xpath' ? value : String(ref.target_xpath || ref.xpath || '').trim(),
      };
    }
    const raw = String(ref || '').trim();
    if (/^xpath\s*=/i.test(raw)) return { selector: '', xpath: raw.replace(/^xpath\s*=\s*/i, '').trim() };
    if (/^css\s*=/i.test(raw)) return { selector: raw.replace(/^css\s*=\s*/i, '').trim(), xpath: '' };
    if (raw.startsWith('/') || raw.startsWith('(') || raw.startsWith('.//')) return { selector: '', xpath: raw };
    return { selector: raw, xpath: '' };
  }

  static _buildClickStateExpr(selector, xpath, text = '', locatorMeta = null) {
    const targetChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
    const textJson = JSON.stringify(String(text || '').replace(/\s+/g, ' ').trim());
    return `(function(){
      try {
        var resolved = ${targetChain};
        var el = resolved && resolved.el;
        var needle = ${textJson};
        function norm(v) { return String(v || '').replace(/\\s+/g, ' ').trim(); }
        if (!el && needle) {
          var textNodes = Array.from(document.querySelectorAll('button,a,input,label,[role="button"],[role="checkbox"],[role="switch"],[aria-pressed],[aria-checked"]'));
          el = textNodes.find(function(node) { return norm(node.innerText || node.textContent) === needle; }) || null;
        }
        if (!el) return { ok: false, state: 'unknown', source: 'not_found', reason: 'not_found' };

        var nodes = [];
        function addNode(node) {
          if (node && nodes.indexOf(node) < 0) nodes.push(node);
        }
        addNode(el);
        try {
          if (el.matches && el.matches('input[type="checkbox"],input[type="radio"]')) addNode(el);
          var inner = el.querySelector && el.querySelector('input[type="checkbox"],input[type="radio"]');
          addNode(inner);
          var control = el.closest && el.closest('label');
          if (control && control.control) addNode(control.control);
          addNode(el.closest && el.closest('button,[role="checkbox"],[role="switch"],[role="button"],label'));
        } catch (e1) {}

        function stateFromValue(value) {
          var valueText = String(value == null ? '' : value).trim().toLowerCase();
          if (['true', '1', 'on', 'yes', 'checked', 'active', 'open', 'opened', 'enabled', 'selected', '开启', '打开', '启用', '已选中'].includes(valueText)) return 'on';
          if (['false', '0', 'off', 'no', 'unchecked', 'inactive', 'closed', 'disabled', 'unselected', '关闭', '关闭状态', '未选中', '未开启'].includes(valueText)) return 'off';
          return '';
        }
        function readAttribute(node, name) {
          try {
            if (!node || !node.getAttribute) return '';
            return stateFromValue(node.getAttribute(name));
          } catch (e2) { return ''; }
        }
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (typeof node.checked === 'boolean') return { ok: true, state: node.checked ? 'on' : 'off', source: 'checked' };
          var attrs = ['aria-checked', 'aria-pressed', 'data-state', 'data-checked', 'data-on', 'data-active', 'data-status'];
          for (var j = 0; j < attrs.length; j++) {
            var attrState = readAttribute(node, attrs[j]);
            if (attrState) return { ok: true, state: attrState, source: attrs[j] };
          }
        }
        for (var k = 0; k < nodes.length; k++) {
          var classText = String(nodes[k].className || '').toLowerCase();
          var classState = classText.match(/(?:^|[-_\s])(on|off|open|opened|closed|active|inactive|checked|unchecked|enabled|disabled)(?=$|[-_\s])/);
          if (classState) {
            var normalizedClassState = stateFromValue(classState[1]);
            if (normalizedClassState) return { ok: true, state: normalizedClassState, source: 'class' };
          }
        }
        for (var m = 0; m < nodes.length; m++) {
          var nodeText = norm(nodes[m].innerText || nodes[m].textContent).toLowerCase();
          if (/(^|\s)(on|open|opened|active|enabled|checked|开启|打开|启用|已选中)(?=$|\s)/.test(nodeText)) return { ok: true, state: 'on', source: 'text' };
          if (/(^|\s)(off|closed|inactive|disabled|unchecked|关闭|未选中|未开启)(?=$|\s)/.test(nodeText)) return { ok: true, state: 'off', source: 'text' };
        }
        return { ok: true, state: 'unknown', source: 'unknown' };
      } catch (e) {
        return { ok: false, state: 'unknown', source: 'lookup_error', reason: String(e && e.message || e) };
      }
    })()`;
  }

  static _buildElementExistsExpr(selector, xpath, locatorMeta = null) {
    const targetChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
    return `(function(){
      try {
        var resolved = ${targetChain};
        var el = resolved && resolved.el;
        return { ok: true, exists: Boolean(el), source: resolved && resolved.via || 'condition_locator' };
      } catch (e) {
        return { ok: false, exists: false, source: 'lookup_error', reason: String(e && e.message || e) };
      }
    })()`;
  }

  async _readClickStateCDP(tabId, step) {
    const result = await this._cdpSend(tabId, 'Runtime.evaluate', {
      expression: PlayerManager._buildClickStateExpr(
        step?.target_selector || '',
        step?.target_xpath || '',
        step?.value || '',
        step?.locator_meta,
      ),
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, state: 'unknown', source: 'lookup_error', reason: 'empty_result' };
  }

  async _readClickConditionExistsCDP(tabId, step) {
    const conditionLocator = PlayerManager._clickConditionLocatorFields(step);
    if (!conditionLocator.selector && !conditionLocator.xpath) {
      return { ok: false, exists: false, source: 'condition_locator_missing', reason: 'condition_locator_missing' };
    }
    const result = await this._cdpSend(tabId, 'Runtime.evaluate', {
      expression: PlayerManager._buildElementExistsExpr(
        conditionLocator.selector,
        conditionLocator.xpath,
        step?.click_condition_locator_meta,
      ),
      returnByValue: true,
    });
    return result?.result?.value || { ok: false, exists: false, source: 'lookup_error', reason: 'empty_result' };
  }

  static _buildCdpLocatorDiagnostics(step, actualLocator, status, durationMs) {
    if (!actualLocator?.source) return null;
    const configuredLocators = PlayerManager._normalizeLocatorMetaCandidates(step?.locator_meta);
    [
      { type: 'css', value: step?.target_selector },
      { type: 'xpath', value: step?.target_xpath },
    ].forEach((candidate) => {
      const value = String(candidate.value || '').trim();
      if (value && !configuredLocators.some((item) => item.type === candidate.type && item.value === value)) {
        configuredLocators.push({ type: candidate.type, value });
      }
    });
    return {
      version: 1,
      mode: 'cdp-ordered-candidate',
      outcome: status === 'passed' ? 'resolved' : status === 'skipped' ? 'skipped' : 'action-failed',
      configured_candidate_count: configuredLocators.length,
      selected: {
        source: actualLocator.source || '',
        execution_source: actualLocator.executionSource || '',
        type: actualLocator.type || '',
        value: actualLocator.value || '',
        decision: 'ordered-first-match',
        ...(Number.isFinite(actualLocator.recordingScore)
          ? { score: actualLocator.recordingScore, score_kind: 'recording_candidate' }
          : {}),
      },
      // CDP 当前只返回步骤总耗时，不能伪装成 Playwright 的语义定位等待耗时。
      wait: { wall_ms: Math.max(0, Number(durationMs) || 0), measurement: 'step_total' },
    };
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

  static _replaceRuntimeVariables(value, variables) {
    if (typeof value !== 'string' || (!value.includes('{{') && !value.includes('${'))) return value;
    const bag = variables && typeof variables === 'object' ? variables : {};
    return value.replace(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}|\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, cuecast, canonical) => {
      const name = cuecast || canonical;
      return Object.prototype.hasOwnProperty.call(bag, name) ? String(bag[name]) : all;
    });
  }

  static _replaceRuntimeVariablesDeep(value, variables) {
    if (typeof value === 'string') return PlayerManager._replaceRuntimeVariables(value, variables);
    if (Array.isArray(value)) return value.map((item) => PlayerManager._replaceRuntimeVariablesDeep(item, variables));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = PlayerManager._replaceRuntimeVariablesDeep(item, variables);
    }
    return out;
  }

  static _resolveRuntimeVariables(step, variables) {
    if (!step || typeof step !== 'object') return step;
    return {
      ...step,
      value: PlayerManager._replaceRuntimeVariables(step.value, variables),
      value_text: PlayerManager._replaceRuntimeVariables(step.value_text, variables),
      url: PlayerManager._replaceRuntimeVariables(step.url, variables),
      target_selector: PlayerManager._replaceRuntimeVariables(step.target_selector, variables),
      target_xpath: PlayerManager._replaceRuntimeVariables(step.target_xpath, variables),
      locator_meta: PlayerManager._replaceRuntimeVariablesDeep(step.locator_meta, variables),
      nl_instruction: PlayerManager._replaceRuntimeVariables(step.nl_instruction, variables),
    };
  }

  static _collectRuntimeVariableTrace(value, variables, path, out) {
    if (typeof value === 'string' && (value.includes('{{') || value.includes('${'))) {
      const resolved = PlayerManager._replaceRuntimeVariables(value, variables);
      const names = [];
      value.replace(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}|\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, cuecast, canonical) => {
        const name = cuecast || canonical;
        names.push(name);
        return all;
      });
      const missing = names.filter((name) => !Object.prototype.hasOwnProperty.call(variables || {}, name));
      const empty = names.filter((name) => (
        Object.prototype.hasOwnProperty.call(variables || {}, name)
        && String(variables[name] ?? '') === ''
      ));
      if (resolved !== value || missing.length || empty.length) {
        out.push({
          path,
          template: value,
          resolved: PlayerManager._previewRuntimeValue(resolved),
          missing,
          empty,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => PlayerManager._collectRuntimeVariableTrace(item, variables, `${path}[${index}]`, out));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        PlayerManager._collectRuntimeVariableTrace(item, variables, path ? `${path}.${key}` : key, out);
      });
    }
  }

  static _resolveRuntimeVariablesWithTrace(step, variables) {
    if (!step || typeof step !== 'object') return { step, trace: [] };
    const trace = [];
    ['value', 'value_text', 'url', 'target_selector', 'target_xpath', 'nl_instruction'].forEach((key) => {
      PlayerManager._collectRuntimeVariableTrace(step[key], variables, key, trace);
    });
    PlayerManager._collectRuntimeVariableTrace(step.locator_meta, variables, 'locator_meta', trace);
    return {
      step: PlayerManager._resolveRuntimeVariables(step, variables),
      trace: trace.slice(0, 80),
    };
  }

  static _collectVariableRefs(value, path = '', out = []) {
    if (typeof value === 'string' && (value.includes('{{') || value.includes('${'))) {
      value.replace(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}|\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, cuecast, canonical) => {
        out.push({ name: cuecast || canonical, path, template: value });
        return all;
      });
      return out;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => PlayerManager._collectVariableRefs(item, `${path}[${index}]`, out));
      return out;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => {
        PlayerManager._collectVariableRefs(item, path ? `${path}.${key}` : key, out);
      });
    }
    return out;
  }

  static _stepVariableName(step) {
    const action = String(step?.action_type || '').trim().toLowerCase();
    if (!['set_variable', 'global_variable_set'].includes(action)) return '';
    const meta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const raw = String(step?.variable_name || meta?.context?.variable?.name || step?.value || step?.name || '').trim();
    return /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : '';
  }

  static _stepVariableRefs(step) {
    return PlayerManager._collectVariableRefs({
      value: step?.value,
      value_text: step?.value_text,
      url: step?.url,
      target_selector: step?.target_selector,
      target_xpath: step?.target_xpath,
      locator_meta: step?.locator_meta,
      nl_instruction: step?.nl_instruction,
    });
  }

  static _validateVariableReferencesForPlayback(steps, startStepIndex = 0, stopAfterStepIndex = null, initialVariableNames = []) {
    const list = Array.isArray(steps) ? steps : [];
    const start = Math.max(0, Number(startStepIndex) || 0);
    const stop = stopAfterStepIndex == null || stopAfterStepIndex === ''
      ? list.length - 1
      : Math.max(start, Math.min(Number(stopAfterStepIndex) || 0, list.length - 1));
    const scoped = list.slice(start, stop + 1);
    const definitions = new Map();
    scoped.forEach((step, index) => {
      const name = PlayerManager._stepVariableName(step);
      if (name && !definitions.has(name)) definitions.set(name, start + index);
    });
    const seen = new Set(initialVariableNames);
    const issues = [];
    scoped.forEach((step, relIndex) => {
      const index = start + relIndex;
      const refs = PlayerManager._stepVariableRefs(step);
      refs.forEach((ref) => {
        if (seen.has(ref.name)) return;
        const defIndex = definitions.has(ref.name) ? definitions.get(ref.name) : -1;
        if (defIndex < 0) {
          issues.push({ type: 'undefined', name: ref.name, stepIndex: index, path: ref.path });
        } else if (defIndex > index) {
          issues.push({ type: 'defined_later', name: ref.name, stepIndex: index, defIndex, path: ref.path });
        }
      });
      const defined = PlayerManager._stepVariableName(step);
      if (defined) seen.add(defined);
    });
    return { ok: issues.length === 0, issues };
  }

  static _formatVariablePrecheckError(validation, locale = 'zh') {
    const issue = validation?.issues?.[0];
    if (!issue) return trByLocale(locale, '变量预检失败', 'Variable precheck failed');
    if (issue.type === 'defined_later') {
      return trByLocale(
        locale,
        `变量预检失败：第 ${issue.stepIndex + 1} 步引用了 {{${issue.name}}}，但第 ${issue.defIndex + 1} 步才定义。请调整步骤顺序或从变量定义步骤之前开始回放。`,
        `Variable precheck failed: step ${issue.stepIndex + 1} references {{${issue.name}}}, but it is defined at step ${issue.defIndex + 1}. Reorder steps or start playback before the variable is defined.`,
      );
    }
    return trByLocale(
      locale,
      `变量预检失败：第 ${issue.stepIndex + 1} 步引用了未定义变量 {{${issue.name}}}。请先添加保存变量步骤，或修正变量名。`,
      `Variable precheck failed: step ${issue.stepIndex + 1} references undefined variable {{${issue.name}}}. Add a set-variable step or fix the variable name.`,
    );
  }

  static _variableDependencySummary(steps, startStepIndex = 0, locale = 'zh') {
    const list = Array.isArray(steps) ? steps : [];
    const start = Math.max(0, Number(startStepIndex) || 0);
    const definitions = new Map();
    list.forEach((step, index) => {
      if (index < start) return;
      const name = PlayerManager._stepVariableName(step);
      if (name && !definitions.has(name)) definitions.set(name, index);
    });
    const pairs = [];
    list.forEach((step, index) => {
      if (index < start) return;
      PlayerManager._stepVariableRefs(step).forEach((ref) => {
        const defIndex = definitions.get(ref.name);
        if (defIndex == null || defIndex >= index) return;
        const label = `{{${ref.name}}}: S${defIndex + 1}->S${index + 1}`;
        if (!pairs.includes(label)) pairs.push(label);
      });
    });
    if (!pairs.length) return '';
    const body = pairs.slice(0, 8).join(', ');
    return trByLocale(locale, `变量依赖: ${body}`, `Variable dependencies: ${body}`);
  }

  static _previewRuntimeValue(value, max = 240) {
    const s = String(value ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  static _variableMeta(step) {
    const meta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const variable = meta?.context?.variable;
    return variable && typeof variable === 'object' ? variable : {};
  }

  static _applyVariableExtraction(rawValue, step, locale = 'zh') {
    const raw = String(rawValue ?? '');
    const meta = PlayerManager._variableMeta(step);
    const extract = meta.extract && typeof meta.extract === 'object' ? meta.extract : { mode: 'full' };
    const mode = String(extract.mode || 'full');
    if (mode === 'regex') {
      const pattern = String(extract.pattern || '');
      const name = PlayerManager._normalizeVariableName(step.value || step.variable_name || step.name);
      if (!pattern) {
        throw PlayerManager._variableExtractionError({
          locale,
          name,
          raw,
          pattern,
          group: extract.group,
          status: 'empty_pattern',
          messageZh: '保存变量失败：正则表达式为空',
          messageEn: 'Set variable failed: regex pattern is empty',
          suggestion: trByLocale(locale, '请填写正则表达式，或把抽取方式改为完整值。', 'Enter a regex pattern or switch extraction to full value.'),
        });
      }
      try {
        PlayerManager._validateRegexSafety(pattern, locale);
      } catch (err) {
        throw PlayerManager._variableExtractionError({
          locale,
          name,
          raw,
          pattern,
          group: extract.group,
          status: 'unsafe_regex',
          messageZh: err?.message || '保存变量失败：正则不安全',
          messageEn: err?.message || 'Set variable failed: unsafe regex',
          suggestion: trByLocale(locale, '请增加固定上下文并避免嵌套重复，例如使用 ^订单已提交：(.+)$。', 'Add fixed context and avoid nested repetition, e.g. ^Order submitted: (.+)$.'),
        });
      }
      let re;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw PlayerManager._variableExtractionError({
          locale,
          name,
          raw,
          pattern,
          group: extract.group,
          status: 'invalid_regex',
          messageZh: `保存变量失败：正则表达式无效（${err?.message || err}）`,
          messageEn: `Set variable failed: invalid regex (${err?.message || err})`,
          suggestion: trByLocale(locale, '请检查括号、转义字符和量词写法。', 'Check parentheses, escapes, and quantifiers.'),
        });
      }
      const match = raw.match(re);
      if (!match) {
        throw PlayerManager._variableExtractionError({
          locale,
          name,
          raw,
          pattern,
          group: extract.group,
          status: 'not_matched',
          messageZh: `保存变量失败：原始值未匹配正则 ${pattern}\n  原始值: ${raw}`,
          messageEn: `Set variable failed: raw value did not match regex ${pattern}\n  Raw value: ${raw}`,
          suggestion: PlayerManager._suggestVariableRegexFix(raw, pattern, locale),
        });
      }
      const group = Number.isInteger(Number(extract.group)) ? Number(extract.group) : (match.length > 1 ? 1 : 0);
      if (match[group] == null) {
        throw PlayerManager._variableExtractionError({
          locale,
          name,
          raw,
          pattern,
          group,
          status: 'group_missing',
          match,
          messageZh: `保存变量失败：正则捕获组 ${group} 不存在\n  原始值: ${raw}`,
          messageEn: `Set variable failed: regex group ${group} does not exist\n  Raw value: ${raw}`,
          suggestion: trByLocale(locale, `当前匹配只有 ${Math.max(0, match.length - 1)} 个捕获组，请把捕获组改为 ${match.length > 1 ? 1 : 0}。`, `Current match has ${Math.max(0, match.length - 1)} capture groups. Set group to ${match.length > 1 ? 1 : 0}.`),
        });
      }
      return { value: String(match[group]), raw, extract: { mode: 'regex', pattern, group } };
    }
    if (mode === 'after_delimiter') {
      const delimiter = String(extract.delimiter || '');
      if (!delimiter) {
        throw new Error(trByLocale(locale, '保存变量失败：分隔符为空', 'Set variable failed: delimiter is empty'));
      }
      const index = raw.indexOf(delimiter);
      if (index < 0) {
        throw new Error(trByLocale(
          locale,
          `保存变量失败：原始值中未找到分隔符 ${delimiter}\n  原始值: ${raw}`,
          `Set variable failed: delimiter ${delimiter} was not found\n  Raw value: ${raw}`,
        ));
      }
      let value = raw.slice(index + delimiter.length);
      if (extract.trim !== false) value = value.trim();
      return { value, raw, extract: { mode: 'after_delimiter', delimiter, trim: extract.trim !== false } };
    }
    return { value: raw, raw, extract: { mode: 'full' } };
  }

  static _variableExtractionError({ locale = 'zh', name = '', raw = '', pattern = '', group = '', status = '', match = null, messageZh = '', messageEn = '', suggestion = '' }) {
    const err = new Error(trByLocale(locale, messageZh || '保存变量失败：变量抽取失败', messageEn || 'Set variable failed: variable extraction failed'));
    const groups = Array.isArray(match) ? match.slice(0, 8).map((item) => String(item ?? '')) : [];
    err.variableExtraction = {
      variable_name: name,
      raw_value: PlayerManager._previewRuntimeValue(raw, 1000),
      pattern,
      group: Number.isInteger(Number(group)) ? Number(group) : group,
      match_status: status,
      matched_text: Array.isArray(match) && match[0] != null ? PlayerManager._previewRuntimeValue(match[0], 500) : '',
      capture_groups: groups,
      suggestion,
    };
    return err;
  }

  static _suggestVariableRegexFix(rawValue, pattern, locale = 'zh') {
    const raw = String(rawValue || '');
    const sample = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    if (raw.includes('：')) {
      const [prefix] = raw.split('：');
      return trByLocale(locale, `当前原始值包含“${prefix}：”，可尝试使用 ^${prefix}：(.+)$ 并选择捕获组 1。`, `Raw value contains "${prefix}:". Try ^${prefix}:(.+)$ and use capture group 1.`);
    }
    if (raw.includes(':')) {
      const [prefix] = raw.split(':');
      return trByLocale(locale, `当前原始值包含“${prefix}:”，可尝试使用 ^${prefix}:(.+)$ 并选择捕获组 1。`, `Raw value contains "${prefix}:". Try ^${prefix}:(.+)$ and use capture group 1.`);
    }
    return trByLocale(locale, `请根据原始值“${sample}”调整正则，确保正则能匹配并把目标片段放在捕获组中。`, `Adjust the regex for raw value "${sample}", and put the target segment in a capture group.`);
  }

  static _hasNestedRegexQuantifier(pattern) {
    const source = String(pattern || '');
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== '(' || source[i + 1] === '?') continue;
      let escaped = false;
      let depth = 0;
      let innerHasQuantifier = false;
      for (let j = i; j < source.length; j++) {
        const ch = source[j];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '(') depth += 1;
        if (depth > 0 && ['*', '+'].includes(ch)) innerHasQuantifier = true;
        if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            const next = source[j + 1] || '';
            if (innerHasQuantifier && ['*', '+'].includes(next)) return true;
            if (innerHasQuantifier && next === '{') return true;
            break;
          }
        }
      }
    }
    return false;
  }

  static _validateRegexSafety(pattern, locale = 'zh') {
    const source = String(pattern || '');
    if (source.length > 300) {
      throw new Error(trByLocale(locale, '保存变量失败：正则表达式过长，请缩短后再回放', 'Set variable failed: regex pattern is too long'));
    }
    if (PlayerManager._hasNestedRegexQuantifier(source)) {
      throw new Error(trByLocale(locale, '保存变量失败：正则存在嵌套重复结构，可能导致回放卡顿', 'Set variable failed: regex contains nested repetition and may hang playback'));
    }
    if (/(?:\.\*){2,}|(?:\.\+){2,}|\[[^\]]*\\s\\S[^\]]*\][*+][*+]?/.test(source)) {
      throw new Error(trByLocale(locale, '保存变量失败：正则过宽，可能误匹配大段文本', 'Set variable failed: regex is too broad'));
    }
  }

  static _appendVariableResolutionToError(message, trace) {
    const items = Array.isArray(trace)
      ? trace.filter((item) => item && (
        item.template !== item.resolved
        || (Array.isArray(item.missing) && item.missing.length)
        || (Array.isArray(item.empty) && item.empty.length)
      ))
      : [];
    if (!items.length) return message;
    const firstEmpty = items.find((item) => Array.isArray(item.empty) && item.empty.length);
    const firstMissing = items.find((item) => Array.isArray(item.missing) && item.missing.length);
    const lead = firstMissing
      ? `变量 {{${firstMissing.missing[0]}}} 未定义，导致本步骤中的变量模板无法解析。`
      : firstEmpty
        ? `变量 {{${firstEmpty.empty[0]}}} 当前值为空，可能导致本步骤定位、输入或选择失败。`
        : '';
    const lines = items.slice(0, 10).map((item) => (
      `  - ${item.path}: ${JSON.stringify(item.template)} -> ${JSON.stringify(item.resolved)}${Array.isArray(item.missing) && item.missing.length ? ` (missing: ${item.missing.join(', ')})` : ''}${Array.isArray(item.empty) && item.empty.length ? ` (empty: ${item.empty.join(', ')})` : ''}`
    ));
    return `${lead ? `${lead}\n` : ''}${message}\n变量解析:\n${lines.join('\n')}`;
  }

  static _normalizeVariableName(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/[^\w$]+/g, '_').replace(/^_+|_+$/g, '');
    if (!normalized) return '';
    return /^[A-Za-z_$]/.test(normalized) ? normalized : `v_${normalized}`;
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

  static _textExactPickExpr(rawValue) {
    const text = String(rawValue || '').trim().replace(/\s+/g, ' ');
    if (!text) return 'null';
    return `(function(){
      var targetText = ${JSON.stringify(text)};
      var normalizeText = function(value) { return String(value || '').trim().replace(/\\s+/g, ' '); };
      var owner = function(element) {
        return element && element.closest && element.closest(
          'button,a,label,[role="button"],[role="menuitem"],li,option,[role="option"],.ivu-btn,.ant-btn,.el-button,.arco-btn,.n-button'
        );
      };
      var primary = document.querySelectorAll(
        'button,a,label,[role="button"],[role="menuitem"],li,option,[role="option"],.ivu-btn,.ant-btn,.el-button,.arco-btn,.n-button'
      );
      for (var i = 0; i < primary.length; i++) {
        if (normalizeText(primary[i].textContent) === targetText) return primary[i];
      }
      var fallback = document.querySelectorAll('span,[class*="btn"],[class*="button"]');
      for (var j = 0; j < fallback.length; j++) {
        if (normalizeText(fallback[j].textContent) === targetText) return owner(fallback[j]) || fallback[j];
      }
      return null;
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
            if (r.width === 0 && r.height === 0 && el.id) {
              // 部分 Element UI 页面把原生 input 与 label[for] 作为同级节点，不能只查祖先包装器。
              const labels = document.getElementsByTagName('label');
              for (let i = 0; i < labels.length; i++) {
                const label = labels[i];
                if (label.getAttribute('for') !== el.id) continue;
                const r2 = label.getBoundingClientRect();
                if (r2.width > 0 || r2.height > 0) { target = label; r = r2; break; }
              }
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
        function normText(v, max) {
          return String(v || '').replace(/\\s+/g, ' ').trim().slice(0, max || 160);
        }
        function pushUnique(arr, v) {
          var t = normText(v, 180);
          if (t && arr.indexOf(t) < 0) arr.push(t);
        }
        function labelText(node) {
          var parts = [];
          try {
            if (node.labels && node.labels.length) {
              Array.prototype.forEach.call(node.labels, function(lb){ pushUnique(parts, lb.innerText || lb.textContent); });
            }
          } catch (e1) {}
          try {
            var ids = node.getAttribute && node.getAttribute('aria-labelledby');
            if (ids) {
              ids.split(/\\s+/).forEach(function(id){
                var n = document.getElementById(id);
                if (n) pushUnique(parts, n.innerText || n.textContent);
              });
            }
          } catch (e2) {}
          try { pushUnique(parts, node.getAttribute && node.getAttribute('aria-label')); } catch (e3) {}
          try {
            var ownLabel = node.closest && node.closest('label');
            if (ownLabel) pushUnique(parts, ownLabel.innerText || ownLabel.textContent);
          } catch (e4) {}
          try {
            var formItem = node.closest && node.closest('.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset');
            if (formItem) {
              var lab = formItem.querySelector('label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"]');
              if (lab) pushUnique(parts, lab.innerText || lab.textContent);
            }
          } catch (e5) {}
          return parts.join(' | ');
        }
        function tableContext(node) {
          try {
            var row = node.closest && (node.closest('tr') || node.closest('[role="row"]') || node.closest('.el-table__row,.ivu-table-row,.ant-table-row'));
            if (!row) return '';
            var cells = row.querySelectorAll(':scope > td, :scope > th, :scope > .ant-table-cell, :scope > .el-table__cell, :scope > [role="gridcell"], :scope > .ivu-table-cell');
            var parts = [];
            for (var i = 0; i < cells.length; i++) {
              var cell = cells[i];
              if (cell.contains(node)) continue;
              pushUnique(parts, cell.innerText || cell.textContent);
            }
            if (parts.length) return parts.join(' | ');
            return normText(row.innerText || row.textContent, 180);
          } catch (e) {
            return '';
          }
        }
        function describe(node, original) {
          var targetNode = node || original;
          var originalNode = original || node;
          var tag = String((targetNode && targetNode.tagName) || '').toLowerCase();
          var role = '';
          var type = '';
          var stable = '';
          var texts = [];
          try { role = String(targetNode.getAttribute && targetNode.getAttribute('role') || ''); } catch (e1) {}
          try { type = String(targetNode.getAttribute && targetNode.getAttribute('type') || ''); } catch (e2) {}
          pushUnique(texts, labelText(originalNode));
          pushUnique(texts, targetNode && targetNode.getAttribute && targetNode.getAttribute('placeholder'));
          pushUnique(texts, targetNode && targetNode.getAttribute && targetNode.getAttribute('title'));
          pushUnique(texts, targetNode && targetNode.value && tag !== 'input' ? targetNode.value : '');
          pushUnique(texts, targetNode && (targetNode.innerText || targetNode.textContent));
          pushUnique(texts, tableContext(originalNode));
          try {
            var stableAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label'];
            for (var ai = 0; ai < stableAttrs.length; ai++) {
              var av = targetNode.getAttribute && targetNode.getAttribute(stableAttrs[ai]);
              if (av) { stable = stableAttrs[ai] + ': ' + normText(av, 120); break; }
            }
          } catch (e3) {}
          return {
            label: texts[0] || stable || '',
            text: texts[1] || '',
            tag: tag,
            role: role,
            type: type,
            stable_attr: stable,
            via: '${via}',
          };
        }
        return { ok: true, x: cx, y: cy, via: '${via}', hitOk: hitOk, hit: hitBrief, target_summary: describe(target, el) };
      } catch(e) {
        return ${structured ? `{ ok: false, reason: 'lookup_error', message: String(e && e.message || e), via: '${via}' }` : 'null'};
      }
    })()`;

    const hadVolatileRc = PlayerManager._isVolatileRcCss(sel) || PlayerManager._isVolatileRcXPath(xp || '');

    // 过滤非法 CSS 选择器（如 :nth-of-type(0) 是无效的，会抛异常）
    let safeSel = sel && !/:\w+-of-type\(0\)/.test(sel) ? sel : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';

    const safeXp = PlayerManager._normalizeXPath(xp);

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
        const safeMetaXp = PlayerManager._normalizeXPath(value);
        if (!safeMetaXp) continue;
        metaParts.push(wrap(
          PlayerManager._contextAwarePickExpr(PlayerManager._xpathSnapshotNodesExpr(safeMetaXp), locatorContextJson),
          `meta-${type}`,
        ));
        continue;
      }

      if (type === 'text_exact' && !skipDisabledCheck) {
        metaParts.push(wrap(PlayerManager._textExactPickExpr(value), 'meta-text'));
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

      if (type === 'tree_node_text' || type === 'tree_item_text') {
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
   * 统一构造 CDP 元素解析结果。候选顺序与点击/输入保持一致：locator_meta、稳定 id、XPath、CSS。
   */
  static _buildDomTargetResultChain(selector, xpath, locatorMeta = null) {
    let safeSel = selector && !/:\w+-of-type\(0\)/.test(selector) ? selector : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';
    const safeXp = PlayerManager._normalizeXPath(xpath);
    const locatorContextJson = JSON.stringify(PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null);
    const cssIsStableId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(selector)
    );
    const candidates = [];
    const addCandidate = (expr, via, matchedCountExpr = '1') => {
      candidates.push(`(function(){
        try {
          var resolvedElement = ${expr};
          if (!resolvedElement) return null;
          return { el: resolvedElement, via: ${JSON.stringify(via)}, matched_count: Number(${matchedCountExpr}) || 1 };
        } catch (e) { return null; }
      })()`);
    };
    const addCss = (value, via) => {
      if (!value || /:\w+-of-type\(0\)/.test(value) || PlayerManager._isVolatileRcCss(value)) return;
      const selectorJson = JSON.stringify(value);
      const stableId = /^#[\w-]+$/.test(value);
      const expression = stableId
        ? `document.querySelector(${selectorJson})`
        : PlayerManager._contextAwarePickExpr(`document.querySelectorAll(${selectorJson})`, locatorContextJson);
      addCandidate(expression, via, `document.querySelectorAll(${selectorJson}).length`);
    };
    const addXpath = (value, via) => {
      const normalized = PlayerManager._normalizeXPath(value);
      if (!normalized) return;
      const nodesExpr = PlayerManager._xpathSnapshotNodesExpr(normalized);
      addCandidate(
        PlayerManager._contextAwarePickExpr(nodesExpr, locatorContextJson),
        via,
        `${nodesExpr}.length`,
      );
    };

    const seen = new Set();
    for (const candidate of PlayerManager._normalizeLocatorMetaCandidates(locatorMeta)) {
      const type = String(candidate.type || '');
      const value = String(candidate.value || '').trim();
      const key = `${type}::${value}`;
      if (!type || !value || seen.has(key)) continue;
      seen.add(key);
      if (type.startsWith('css_') || type.startsWith('component_root_') || type === 'table_cell_css') {
        addCss(value, `meta-${type}`);
      } else if (type === 'xpath_fallback' || type === 'table_cell_xpath') {
        addXpath(value, `meta-${type}`);
      } else if (type === 'text_exact') {
        addCandidate(PlayerManager._textExactPickExpr(value), 'meta-text');
      } else if (type === 'text_exact_tag') {
        addCandidate(PlayerManager._textExactTagPickExpr(value), 'meta-text-tag');
      } else if (type === 'tree_interaction') {
        addCandidate(PlayerManager._treeInteractionPickExpr(value), 'meta-tree-interaction');
      } else if (type === 'tree_node_text' || type === 'tree_item_text') {
        addCandidate(PlayerManager._treeNodeTextPickExpr(value), 'meta-tree-node-text');
      }
    }
    if (cssIsStableId) addCss(safeSel, 'css');
    addXpath(safeXp, 'xpath');
    if (!cssIsStableId) addCss(safeSel, 'css');
    if (!candidates.length) return 'null';
    return `(function(){
      var candidate = null;
      ${candidates.map((candidate) => `candidate = ${candidate}; if (candidate && candidate.el) return candidate;`).join('\n')}
      return null;
    })()`;
  }

  static _buildDomTargetChain(selector, xpath, locatorMeta = null) {
    const resultChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
    return `(function(){ var resolved = ${resultChain}; return resolved && resolved.el || null; })()`;
  }

  static _buildDomTextRawExpr(selector, xpath, locatorMeta = null) {
    const resultChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
    return `(function(){
      try {
        var resolved = ${resultChain};
        var el = resolved && resolved.el;
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

  static _buildVariableValueExpr(selector, xpath, locatorMeta = null) {
    const resultChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
    return `(function(){
      try {
        var resolved = ${resultChain};
        var el = resolved && resolved.el;
        if (!el) return { ok: false, err: 'not_found' };
        var tag = el.tagName && String(el.tagName).toLowerCase() || '';
        var value = '';
        if (tag === 'textarea' || tag === 'input' || tag === 'select') {
          value = el.value != null ? String(el.value) : '';
        } else if (el.isContentEditable || (el.closest && el.closest('[contenteditable="true"]'))) {
          var editable = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
          value = editable && editable.textContent != null ? String(editable.textContent) : '';
        } else {
          var text = el.innerText != null ? el.innerText : el.textContent;
          value = text != null ? String(text) : '';
        }
        return {
          ok: true,
          value: value,
          via: resolved.via || '',
          matched_count: Number(resolved.matched_count || 1),
          visible_count: 1,
        };
      } catch (e) {
        return { ok: false, err: e && e.message ? String(e.message) : 'error' };
      }
    })()`;
  }

  static _buildElementAssertionExpr(selector, xpath, readMode = 'auto', locatorMeta = null, attribute = '') {
    const resultChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
    const normalizedReadMode = ['auto', 'text', 'attribute', 'value'].includes(String(readMode)) ? String(readMode) : 'auto';
    const normalizedAttribute = String(attribute || '').trim();
    return `(function(){
      try {
        var resolved = ${resultChain};
        var el = resolved && resolved.el;
        if (!el) return { ok: false, err: 'not_found' };
        var visible = true;
        var current = el;
        while (current && current.nodeType === 1) {
          var style = window.getComputedStyle(current);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) <= 0) {
            visible = false;
            break;
          }
          current = current.parentElement;
        }
        var rect = el.getBoundingClientRect();
        if (el.hidden || !rect || rect.width <= 0 || rect.height <= 0 || el.getClientRects().length === 0) visible = false;
        var tag = el.tagName && String(el.tagName).toLowerCase() || '';
        var mode = ${JSON.stringify(normalizedReadMode)};
        if (mode === 'auto') mode = (tag === 'input' || tag === 'textarea' || tag === 'select') ? 'value' : 'text';
        var value = '';
        if (mode === 'value') {
          value = 'value' in el && el.value != null ? String(el.value) : '';
        } else if (mode === 'attribute') {
          var attributeName = ${JSON.stringify(normalizedAttribute)};
          var attributePresent = Boolean(attributeName && el.hasAttribute(attributeName));
          // DOM 降级策略：当 HTML 属性不存在时，尝试从 DOM 属性或运行时状态读取
          if (!attributePresent && attributeName) {
            var attrLower = attributeName.toLowerCase();
            // 图片/资源地址：优先读取运行时实际加载的地址
            if (attrLower === 'src') {
              var domSrc = el.currentSrc || el.src || '';
              if (domSrc) { value = String(domSrc); attributePresent = true; }
            } else if (attrLower === 'href') {
              var domHref = el.href || '';
              if (domHref) { value = String(domHref); attributePresent = true; }
            }
            // 布尔属性：从 DOM 属性或 aria 状态读取
            else if (attrLower === 'checked') {
              if (typeof el.checked === 'boolean') { value = el.checked ? 'true' : 'false'; attributePresent = true; }
            } else if (attrLower === 'disabled') {
              if (typeof el.disabled === 'boolean') { value = el.disabled ? 'true' : 'false'; attributePresent = true; }
            } else if (attrLower === 'readonly') {
              if (typeof el.readOnly === 'boolean') { value = el.readOnly ? 'true' : 'false'; attributePresent = true; }
            } else if (attrLower === 'selected') {
              if (typeof el.selected === 'boolean') { value = el.selected ? 'true' : 'false'; attributePresent = true; }
            }
            // aria 状态映射
            else if (attrLower === 'aria-checked' && el.getAttribute('aria-checked')) {
              value = String(el.getAttribute('aria-checked')); attributePresent = true;
            } else if (attrLower === 'aria-disabled' && el.getAttribute('aria-disabled')) {
              value = String(el.getAttribute('aria-disabled')); attributePresent = true;
            }
          }
          if (!attributePresent) {
            return {
              ok: true,
              visible: visible,
              attribute_present: false,
              attribute: ${JSON.stringify(normalizedAttribute)},
              value: '',
              via: resolved.via || '',
              matched_count: Number(resolved.matched_count || 1),
              visible_count: visible ? 1 : 0
            };
          }
          if (!value) value = el.getAttribute(attributeName) || '';
        } else {
          var text = el.innerText != null ? el.innerText : el.textContent;
          value = text != null ? String(text) : '';
        }
        return {
          ok: true,
          visible: visible,
          attribute_present: true,
          attribute: ${JSON.stringify(normalizedAttribute)},
          value: value,
          via: resolved.via || '',
          matched_count: Number(resolved.matched_count || 1),
          visible_count: visible ? 1 : 0
        };
      } catch (e) {
        return { ok: false, err: e && e.message ? String(e.message) : 'error' };
      }
    })()`;
  }

  async _waitForDomTextRawCDP(tabId, selector, xpath, timeout = 8000, skipPageErrorCheck = false, locatorMeta = null) {
    let remaining = this._getEffectiveWaitTimeout(tabId, timeout);
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    const expr = PlayerManager._buildDomTextRawExpr(selector, xpath, locatorMeta);
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

  async _waitForVariableValueCDP(tabId, step, timeout = 8000, returnDetails = false) {
    let remaining = timeout;
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    const expr = PlayerManager._buildVariableValueExpr(step.target_selector, step.target_xpath, step.locator_meta);
    while (Date.now() < wallEnd && remaining > 0) {
      await this._throwIfPageError(tabId);
      const loading = await this._isPageLoadingUi(tabId);
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      const v = res?.result?.value;
      if (v && v.ok && typeof v.value === 'string') return returnDetails ? v : v.value;
      await this._sleep(400);
      if (!loading) remaining -= 400;
    }
    return null;
  }

  async _waitForElementAssertionCDP(tabId, step, timeout = 10000, requireVisible = false) {
    let remaining = this._getEffectiveWaitTimeout(tabId, timeout);
    const wallEnd = Date.now() + PlayerManager.LOADING_WAIT_WALL_MS;
    const expr = PlayerManager._buildElementAssertionExpr(
      step.target_selector,
      step.target_xpath,
      step.read_mode || 'auto',
      step.locator_meta,
      step.attribute || '',
    );
    let lastMatched = null;
    while (Date.now() < wallEnd && remaining > 0) {
      const loading = await this._isPageLoadingUi(tabId);
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      const value = res?.result?.value;
      if (value && value.ok) {
        lastMatched = value;
        if (!requireVisible || value.visible === true) return value;
      }
      await this._sleep(400);
      if (!loading) remaining -= 400;
    }
    return lastMatched;
  }

  async _executeSetVariableStep(tabId, step, cdpAvailable, locale = 'zh') {
    const name = PlayerManager._normalizeVariableName(step.value || step.variable_name || step.name);
    if (!name) {
      throw new Error(trByLocale(locale, '保存变量失败：变量名为空', 'Set variable failed: variable name is empty'));
    }

    if (cdpAvailable) {
      const rawValue = await this._waitForVariableValueCDP(tabId, step, 8000);
      if (rawValue == null) {
        const treeDiag = await this._getTreeWaitDiagnosticSuffix(tabId, step.locator_meta);
        throw new Error(
          trByLocale(
            locale,
            `保存变量失败：找不到目标元素${treeDiag}\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
            `Set variable failed: target element not found\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
          ),
        );
      }
      const extracted = PlayerManager._applyVariableExtraction(rawValue, step, locale);
      return {
        name,
        value: extracted.value,
        raw_value: extracted.raw,
        extract: extracted.extract,
        source: PlayerManager._variableMeta(step).source || '',
      };
    }

    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'AT_EXTRACT_VARIABLE', step, locale }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
    if (!result || result.ok !== true) {
      throw new Error(localizePlaybackError(locale, result?.error || '保存变量失败：页面脚本无有效响应'));
    }
    return {
      name: result.name || name,
      value: String(result.value ?? ''),
      raw_value: String(result.raw_value ?? result.value ?? ''),
      extract: result.extract || PlayerManager._variableMeta(step).extract || { mode: 'full' },
      source: PlayerManager._variableMeta(step).source || '',
    };
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
    const actual = await this._waitForDomTextRawCDP(
      tabId,
      step.target_selector,
      step.target_xpath,
      10000,
      false,
      step.locator_meta,
    );
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
    if (mode === 'element' || String(mode || '').startsWith('element_attribute:')) {
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
    console.log('[AT assert_text] 比对结果:', mode === 'element' || String(mode || '').startsWith('element_attribute:') ? '元素值匹配' : '整页 includes', '=', hit);
    console.log('[AT assert_text] ==========================================');
  }

  static _resolveAssertionConfig(step, hasLocator = false) {
    const meta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const contextAssertion = meta?.context?.assertion && typeof meta.context.assertion === 'object'
      ? meta.context.assertion
      : {};
    const raw = meta?.assertion && typeof meta.assertion === 'object' ? meta.assertion : contextAssertion;
    const canonical = String(step?.action_type || '').trim().toLowerCase() === 'assert_element_match';
    const configuredTarget = canonical ? 'element' : raw.target;
    const configuredMatch = canonical ? step?.match_mode : raw.match;
    const target = ['page', 'element', 'error', 'url'].includes(String(configuredTarget || '')) ? String(configuredTarget) : (hasLocator ? 'element' : 'page');
    const rawMatch = ['contains', 'equals', 'not_contains', 'regex', 'visible'].includes(String(configuredMatch || '')) ? String(configuredMatch) : (hasLocator ? 'equals' : 'contains');
    const match = rawMatch === 'visible' && target !== 'element' ? 'contains' : rawMatch;
    const source = String(step?.read_mode || contextAssertion.source || 'auto').trim().toLowerCase();
    const readMode = source === 'contenteditable' ? 'text' : (['auto', 'text', 'attribute', 'value'].includes(source) ? source : 'auto');
    const attribute = String(step?.attribute || contextAssertion.attribute || '').trim();
    return attribute ? { target, match, readMode, attribute } : { target, match, readMode };
  }

  static _matchAssertionText(actual, expected, mode = 'contains') {
    const rawActual = String(actual ?? '');
    const rawExpected = String(expected ?? '');
    if (mode === 'regex') {
      try {
        return new RegExp(rawExpected).test(rawActual);
      } catch {
        return false;
      }
    }
    const a = PlayerManager._normalizeAssertionText(rawActual);
    const e = PlayerManager._normalizeAssertionText(rawExpected);
    if (mode === 'equals') return a === e;
    if (mode === 'not_contains') return !a.includes(e);
    return a.includes(e);
  }

  static _matchRawAssertionText(actual, expected, mode = 'contains') {
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

  static _normalizeAssertionText(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  static _assertionMatchLabel(mode = 'contains') {
    if (mode === 'equals') return '等于';
    if (mode === 'not_contains') return '不包含';
    if (mode === 'regex') return '匹配正则';
    if (mode === 'visible') return '可见';
    return '包含';
  }

  static _assertionTargetLabel(target = 'page') {
    if (target === 'element') return '指定元素';
    if (target === 'error') return '错误提示';
    if (target === 'url') return 'URL';
    return '整页文本';
  }

  static _previewAssertionValue(value, max = 500) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '（空）';
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  static _formatAssertionFailure({ target, attribute, match, expected, actual, css, xpath }) {
    return [
      '断言失败：实际值不满足预期',
      `断言目标: ${PlayerManager._assertionTargetLabel(target)}`,
      ...(attribute ? [`属性名: ${attribute}`] : []),
      `匹配方式: ${PlayerManager._assertionMatchLabel(match)}`,
      `期望值: ${PlayerManager._previewAssertionValue(expected)}`,
      `实际值: ${PlayerManager._previewAssertionValue(actual)}`,
      `原始长度: 期望 ${String(expected ?? '').length}，实际 ${String(actual ?? '').length}`,
      `CSS: ${css || '—'}`,
      `XPath: ${xpath || '—'}`,
    ].join('\n  ');
  }

  static _createAssertionFailureError(payload) {
    const error = new Error(PlayerManager._formatAssertionFailure(payload));
    // 错误文本用于日志；结构化字段用于报告准确区分期望值和页面实际值。
    error.operationAssertion = PlayerManager._buildAssertionDiagnostic(payload);
    if (payload.actualLocator && typeof payload.actualLocator === 'object') {
      error.actualLocator = payload.actualLocator;
    }
    return error;
  }

  static _buildAssertionDiagnostic(payload) {
    return {
      subject: payload.attribute ? `元素属性 ${payload.attribute}` : PlayerManager._assertionTargetLabel(payload.target),
      operator: String(payload.match || 'equals'),
      expected: { value_state: 'visible', preview: String(payload.expected ?? '') },
      actual: { value_state: 'visible', preview: String(payload.actual ?? '') },
      passed: payload.passed === true,
    };
  }

  static _createAssertionResult(locator, payload) {
    return {
      ...(locator && typeof locator === 'object' ? locator : {}),
      operationAssertion: PlayerManager._buildAssertionDiagnostic({ ...payload, passed: true }),
    };
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
    const expected = PlayerManager._resolveAssertionExpectedValue(step);
    const hasLocator = String(step.target_selector || '').trim() !== ''
      || String(step.target_xpath || '').trim() !== ''
      || PlayerManager._normalizeLocatorMetaCandidates(step.locator_meta).length > 0;
    const assertion = PlayerManager._resolveAssertionConfig(step, hasLocator);
    if (assertion.target === 'element' && assertion.readMode === 'attribute' && !assertion.attribute) {
      throw new Error('断言失败：元素属性读取方式缺少属性名');
    }
    if (step?.attribute_error) throw new Error(`断言失败：${step.attribute_error}`);
    if (assertion.match !== 'visible' && expected.trim() === '') {
      throw new Error('断言失败：未配置断言文本（「输入值」不能为空或仅空白）');
    }
    if (assertion.match === 'regex') {
      try {
        new RegExp(expected);
      } catch (error) {
        throw new Error(`断言失败：正则表达式不合法：${error?.message || expected}`);
      }
    }

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
        throw PlayerManager._createAssertionFailureError({
          target: assertion.target,
          match: assertion.match,
          expected,
          actual,
          css: '',
          xpath: '',
        });
      }
      return PlayerManager._createAssertionResult(null, {
        target: assertion.target,
        match: assertion.match,
        expected,
        actual,
      });
    }

    if (assertion.target === 'url') {
      const res = await this._cdpSend(tabId, 'Runtime.evaluate', {
        expression: 'String(location.href || "")',
        returnByValue: true,
      });
      const actual = String(res?.result?.value || '');
      const hit = PlayerManager._matchAssertionText(actual, expected, assertion.match);
      this._logAssertTextCdpDebug({
        mode: `url_${assertion.match}`,
        expected,
        actual,
        hit,
        css: '',
        xpath: '',
      });
      if (!hit) {
        throw PlayerManager._createAssertionFailureError({
          target: assertion.target,
          match: assertion.match,
          expected,
          actual,
          css: '',
          xpath: '',
        });
      }
      return PlayerManager._createAssertionResult(null, {
        target: assertion.target,
        match: assertion.match,
        expected,
        actual,
      });
    }

    if (assertion.target === 'element') {
      const result = await this._waitForElementAssertionCDP(
        tabId,
        { ...step, read_mode: assertion.readMode, attribute: assertion.attribute },
        10000,
        assertion.match === 'visible',
      );
      if (result == null) {
        const treeDiag = await this._getTreeWaitDiagnosticSuffix(tabId, step.locator_meta);
        throw new Error(
          `断言失败：找不到目标元素${treeDiag}\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
        );
      }
      if (assertion.match === 'visible') {
        const actualLocator = PlayerManager._actualLocatorFromVia(
          step,
          result.via,
          result.matched_count,
          result.visible_count,
        );
        if (result.visible === true) {
          return PlayerManager._createAssertionResult(actualLocator, {
            target: assertion.target,
            match: assertion.match,
            expected: 'visible',
            actual: 'visible',
          });
        }
        throw PlayerManager._createAssertionFailureError({
          target: assertion.target,
          match: assertion.match,
          expected: 'visible',
          actual: 'hidden',
          css: step.target_selector || '',
          xpath: step.target_xpath || '',
          actualLocator,
        });
      }
      const actualLocator = PlayerManager._actualLocatorFromVia(
        step,
        result.via,
        result.matched_count,
        result.visible_count,
      );
      if (assertion.readMode === 'attribute' && result.attribute_present !== true) {
        throw PlayerManager._createAssertionFailureError({
          target: assertion.target,
          attribute: assertion.attribute,
          match: assertion.match,
          expected,
          actual: '属性不存在',
          css: step.target_selector || '',
          xpath: step.target_xpath || '',
          actualLocator,
        });
      }
      const actual = String(result.value ?? '');
      const hit = assertion.readMode === 'attribute'
        ? PlayerManager._matchRawAssertionText(actual, expected, assertion.match)
        : PlayerManager._matchAssertionText(actual, expected, assertion.match);
      this._logAssertTextCdpDebug({
        mode: assertion.readMode === 'attribute' ? `element_attribute:${assertion.attribute}` : 'element',
        expected,
        actual,
        hit,
        css: step.target_selector || '',
        xpath: step.target_xpath || '',
      });
      if (!hit) {
        throw PlayerManager._createAssertionFailureError({
          target: assertion.target,
          attribute: assertion.attribute,
          match: assertion.match,
          expected,
          actual,
          css: step.target_selector || '',
          xpath: step.target_xpath || '',
          actualLocator,
        });
      }
      return PlayerManager._createAssertionResult(actualLocator, {
        target: assertion.target,
        attribute: assertion.attribute,
        match: assertion.match,
        expected,
        actual,
      });
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
      throw PlayerManager._createAssertionFailureError({
        target: assertion.target,
        match: assertion.match,
        expected,
        actual: pageText,
        css: '',
        xpath: '',
      });
    }
    return PlayerManager._createAssertionResult(null, {
      target: assertion.target,
      match: assertion.match,
      expected,
      actual: pageText,
    });
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
    let remaining = this._getEffectiveWaitTimeout(tabId, timeout);
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
  async _getElementBoxResult(
    tabId,
    selector,
    xpath,
    textFallback = '',
    timeout = 5000,
    skipDisabledCheck = false,
    locatorMeta = null,
    requireHitTest = false,
  ) {
    let remaining = this._getEffectiveWaitTimeout(tabId, timeout);
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
      if (box && requireHitTest && box.hitOk === false) {
        // 元素已渲染但仍被 loading mask/浮层挡住时，继续等待真正可点击。
        lastStatus = { ok: false, reason: 'covered', covered: box.hit };
        await this._sleep(120);
        if (!loading) remaining -= 120;
        continue;
      }
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

  async _collectRuntimeStepTarget(tabId, step, cdpAvailable) {
    if (!cdpAvailable || tabId == null || !step) return null;
    const actionType = String(step.action_type || '').trim().toLowerCase();
    if (['navigate', 'switch_context', 'scroll', 'wait', 'ai_natural'].includes(actionType)) return null;
    const hasLocator = String(step.target_selector || '').trim() || String(step.target_xpath || '').trim() || step.locator_meta;
    if (!hasLocator) return null;
    const textFallback = ['click', 'double_click', 'right_click', 'hover', 'select'].includes(actionType)
      ? String(step.value || step.value_text || '')
      : '';
    try {
      const result = await this._getElementBoxResult(
        tabId,
        step.target_selector || '',
        step.target_xpath || '',
        textFallback,
        1200,
        true,
        step.locator_meta,
      );
      const summary = result?.ok && result.box?.target_summary ? result.box.target_summary : null;
      if (!summary || typeof summary !== 'object') return null;
      const label = String(summary.label || summary.text || summary.stable_attr || '').trim();
      if (!label) return null;
      const via = String(summary.via || '');
      return {
        label: PlayerManager._previewRuntimeValue(label, 180),
        tag: String(summary.tag || ''),
        role: String(summary.role || ''),
        type: String(summary.type || ''),
        via,
        locator: PlayerManager._previewRuntimeValue(PlayerManager._runtimeLocatorValueForVia(step, via), 500),
      };
    } catch {
      return null;
    }
  }

  static _runtimeLocatorValueForVia(step, via) {
    const rawVia = String(via || '').trim();
    if (!step || !rawVia) return '';
    if (rawVia === 'css') return String(step.target_selector || '');
    if (rawVia === 'xpath') return String(step.target_xpath || '');
    if (rawVia === 'text') return String(step.value || step.value_text || '');
    if (!rawVia.startsWith('meta-')) return '';
    const type = rawVia.slice(5);
    const meta = PlayerManager._parseLocatorMetaObject(step.locator_meta);
    const candidates = Array.isArray(meta?.candidates) ? meta.candidates : [];
    if (type === 'xpath') {
      const xpathCandidate = candidates.find((item) => String(item?.type || '').includes('xpath') && String(item?.value || '').trim());
      return String(xpathCandidate?.value || step.target_xpath || '');
    }
    if (type === 'text') {
      const textCandidate = candidates.find((item) => String(item?.type || '').startsWith('text_') && String(item?.value || '').trim());
      return String(textCandidate?.value || step.value || step.value_text || '');
    }
    const candidate = candidates.find((item) => String(item?.type || '') === type);
    return String(candidate?.value || '');
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
    if (reason === 'covered') {
      const covered = result?.covered ? `\n  遮挡元素: ${result.covered}` : '';
      return `目标不可点击：视口中心点在等待超时后仍被其它元素遮挡${covered}${treeDiag}\n  CSS: ${css}\n  XPath: ${xp}`;
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
    const virtualMeta = PlayerManager._parseLocatorMetaObject(step?.locator_meta)?.context?.virtual_scroll;
    const hasVirtualContext = virtualMeta && ['maybe', 'true'].includes(String(virtualMeta.hint || ''));

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
    let remaining = this._getEffectiveWaitTimeout(tabId, 6000);
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

    if (!box) {
      box = await this._findVirtualScrollTargetBoxCDP(tabId, step, { overlayOnly: true });
    }

    if (!box && !hasVirtualContext && (step.target_xpath || step.target_selector)) {
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

  async _findVirtualScrollTargetBoxCDP(tabId, step, options = {}) {
    const meta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
    const vs = meta?.context?.virtual_scroll;
    if (!vs || !['maybe', 'true'].includes(String(vs.hint || ''))) return null;
    const text = String(step?.value || vs.item_text || vs.option_text || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const payload = JSON.stringify({
      text,
      virtual_scroll: vs,
      overlayOnly: options.overlayOnly === true,
    });
    return this._cdpSend(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const payload = ${payload};
        const needle = String(payload.text || '').replace(/\\s+/g, ' ').trim();
        const ctx = payload.virtual_scroll || {};
        const overlayOnly = payload.overlayOnly === true;
        if (!needle) return null;

        const overlaySel = ${JSON.stringify(PlayerManager.OVERLAY_CONTAINER_SEL)};
        const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const byXpath = (xp) => {
          if (!xp) return null;
          try { return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return null; }
        };
        const visible = (el) => {
          if (!el || !el.getBoundingClientRect) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.02;
        };
        const isScrollable = (el) => {
          if (!visible(el)) return false;
          const st = window.getComputedStyle(el);
          const overflow = [st.overflow, st.overflowY, st.overflowX].join(' ');
          return /(auto|scroll|overlay)/i.test(overflow)
            && ((el.scrollHeight - el.clientHeight > 2) || (el.scrollWidth - el.clientWidth > 2));
        };
        const zIndex = (el) => {
          let z = 0, cur = el;
          while (cur && cur !== document.body) {
            const zi = parseInt(window.getComputedStyle(cur).zIndex, 10);
            if (!isNaN(zi) && zi > z) z = zi;
            cur = cur.parentElement;
          }
          return z;
        };
        const itemSelector = [
          'li',
          '[role="option"]',
          '[role="row"]',
          '[role="treeitem"]',
          '[role="menuitem"]',
          'tr',
          '[data-index]',
          '[aria-rowindex]',
          '.ant-select-item',
          '.ant-select-item-option',
          '.ant-select-item-option-content',
          '.el-select-dropdown__item',
          '.el-option',
          '.ivu-select-item',
          '[class*="virtual"]',
          '[class*="row"]',
          '[class*="item"]'
        ].join(',');
        const itemText = (el) => {
          try {
            const title = el.querySelector && el.querySelector('.truncate, [class*="font-medium"]');
            const titleText = norm(title && (title.innerText || title.textContent));
            if (titleText) return titleText;
          } catch (e) {}
          return norm(el.innerText || el.textContent || '');
        };
        const clickableFor = (item) => {
          if (!item) return null;
          if (item.matches && item.matches('button,a,[role="button"],input[type="button"],input[type="submit"],li,[role="option"],[role="menuitem"],.ant-select-item,.el-select-dropdown__item,.el-option,.ivu-select-item')) return item;
          return item.querySelector && (item.querySelector('button,a,[role="button"],input[type="button"],input[type="submit"]') || item);
        };
        const boxFor = (el) => {
          if (!el) return null;
          try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
          const r = el.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) return null;
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          let hitOk = false;
          let cur = hit;
          while (cur) {
            if (cur === el) { hitOk = true; break; }
            cur = cur.parentElement;
          }
          return { x, y, width: r.width, height: r.height, via: 'virtual-scroll-text', hitOk };
        };
        const findIn = (container) => {
          const rows = Array.from(container.querySelectorAll(itemSelector)).filter(visible);
          const exact = rows.find((row) => itemText(row) === needle);
          const partial = exact ? null : rows.find((row) => {
            const text = itemText(row);
            return needle.length >= 1 && text.includes(needle);
          });
          const row = exact || partial;
          return row ? boxFor(clickableFor(row)) : null;
        };
        const looksVirtual = (container) => {
          if (!container) return false;
          if (String(ctx.hint || '') === 'true') return true;
          const cls = norm([container.className, container.parentElement && container.parentElement.className, container.firstElementChild && container.firstElementChild.className].join(' ')).toLowerCase();
          if (/virtual|virtual-list|virtual-scroll|rc-virtual-list|cdk-virtual|v-virtual/.test(cls)) return true;
          const rows = Array.from(container.querySelectorAll(itemSelector)).filter(visible);
          const ratio = container.clientHeight > 0 ? container.scrollHeight / container.clientHeight : 1;
          return ratio > 2.2 && rows.length > 0 && rows.length <= 80;
        };

        const candidates = [];
        const add = (el) => {
          if (!el || candidates.includes(el)) return;
          if (isScrollable(el)) candidates.push(el);
        };
        if (ctx.container_selector) {
          try { add(document.querySelector(ctx.container_selector)); } catch (e) {}
        }
        add(byXpath(ctx.container_xpath));
        if (overlayOnly) {
          const overlays = Array.from(document.querySelectorAll(overlaySel)).filter(visible).sort((a, b) => zIndex(b) - zIndex(a));
          for (const overlay of overlays) {
            add(overlay);
            Array.from(overlay.querySelectorAll('*')).forEach(add);
          }
        } else {
          Array.from(document.querySelectorAll('*')).forEach(add);
        }
        const filtered = candidates.filter(looksVirtual);
        const searchTargets = filtered.length ? filtered : candidates.filter((el) => String(ctx.hint || '') === 'maybe' && isScrollable(el));
        for (const container of searchTargets.slice(0, 8)) {
          const originalTop = container.scrollTop;
          const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
          const recordedTop = Number(ctx.scroll_top);
          const stepSize = Math.max(40, Math.floor((container.clientHeight || 160) * 0.82));
          const positions = [];
          const pushPos = (v) => {
            if (!Number.isFinite(v)) return;
            const n = Math.max(0, Math.min(maxTop, Math.round(v)));
            if (!positions.includes(n)) positions.push(n);
          };
          pushPos(recordedTop);
          pushPos(originalTop);
          pushPos(0);
          for (let p = 0; p <= maxTop && positions.length < 16; p += stepSize) pushPos(p);
          pushPos(maxTop);
          for (const pos of positions) {
            container.scrollTop = pos;
            try { container.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
            const found = findIn(container);
            if (found) return found;
          }
        }
        return null;
      })()`,
      returnByValue: true,
    }).then(r => r?.result?.value || null).catch(() => null);
  }

  // 执行一次 CDP 鼠标点击（完整序列：move→press→release）
  async _cdpClick(tabId, x, y, options = {}) {
    const button = options.button || 'left';
    const clickCount = Number(options.clickCount || 1);
    const buttons = button === 'right' ? 2 : 1;
    await this._cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    this._rememberPointerPosition(tabId, x, y);
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
        function findTextSignal(source, keywords) {
          var raw = String(source || '');
          var lower = raw.toLowerCase();
          for (var si = 0; si < keywords.length; si++) {
            var kw = String(keywords[si] || '');
            if (!kw) continue;
            var idx = lower.indexOf(kw.toLowerCase());
            if (idx < 0) continue;
            var snippet = raw.slice(Math.max(0, idx - 80), Math.min(raw.length, idx + kw.length + 140)).replace(/\\s+/g, ' ').trim();
            return { hit: true, keyword: kw, snippet: snippet };
          }
          return null;
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
        var sessionStateSignal = null;
        try {
          var href = String(location.href || '');
          var lowerHref = href.toLowerCase();
          var loweredText = String(text || '').toLowerCase();
          var hasPassword = Boolean(document.querySelector('input[type="password"]'));
          var loginUrlHit = /(^|[/?#&])(login|signin|sign-in|auth|sso|cas|oauth|passport)([/?#&=]|$)/i.test(lowerHref)
            || /(^|[/?#&])user\\/login([/?#&=]|$)/i.test(lowerHref);
          var loginButtonHit = false;
          var buttons = document.querySelectorAll('button,input[type="submit"],a,[role="button"]');
          for (var b = 0; b < Math.min(buttons.length, 100); b++) {
            var btnText = String(buttons[b].innerText || buttons[b].value || buttons[b].getAttribute('aria-label') || '').trim().toLowerCase();
            if (/^(登录|登陆|log in|login|sign in|signin)$/.test(btnText)) {
              loginButtonHit = true;
              break;
            }
          }
          var titleText = String(document.title || '').trim();
          var headingText = '';
          var headings = document.querySelectorAll('h1,h2,h3,[role="heading"],form legend,form [class*="title"],form [class*="header"]');
          for (var h = 0; h < Math.min(headings.length, 30); h++) {
            headingText += ' ' + String(headings[h].innerText || headings[h].textContent || '').trim();
          }
          var loginPageTextHit = /(登录|登陆|用户登录|账号登录|密码登录|sign in|log in|login)/i.test(titleText + ' ' + headingText);
          var unauthorizedMatch = loweredText.match(/unauthorized|forbidden|session expired|please sign in|please log in|登录已失效|请先登录|未登录|无权限|会话过期|登录超时|登录过期/i);
          var unauthorizedHit = Boolean(unauthorizedMatch);
          var passwordLoginFormHit = hasPassword && (loginButtonHit || loginPageTextHit);
          var loggedOut = loginUrlHit || unauthorizedHit || passwordLoginFormHit;
          var loggedInTextHit = /(退出登录|用户中心|个人中心|工作台|项目管理|测试用例|执行计划|dashboard|logout|sign out|profile|workspace|projects)/i.test(titleText + ' ' + text);
          var loggedInUrlHit = !loginUrlHit && /(dashboard|workspace|project|console|home|admin|case|testcase|plan)/i.test(lowerHref);
          var loggedIn = !loggedOut && (loggedInTextHit || loggedInUrlHit);
          var snippet = '';
          if (unauthorizedMatch && unauthorizedMatch.index != null) {
            snippet = String(text || '').slice(Math.max(0, unauthorizedMatch.index - 60), Math.min(String(text || '').length, unauthorizedMatch.index + String(unauthorizedMatch[0]).length + 140)).replace(/\\s+/g, ' ').trim();
          } else if (loginPageTextHit) {
            snippet = String(titleText + ' ' + headingText).replace(/\\s+/g, ' ').trim().slice(0, 240);
          } else if (loggedInTextHit) {
            snippet = String(titleText + ' ' + text).replace(/\\s+/g, ' ').trim().slice(0, 240);
          }
          sessionStateSignal = {
            logged_out: loggedOut,
            logged_in: loggedIn,
            href: href,
            snippet: snippet,
            signals: { hasPassword: hasPassword, loginUrlHit: loginUrlHit, loginButtonHit: loginButtonHit, loginPageTextHit: loginPageTextHit, unauthorizedHit: unauthorizedHit, passwordLoginFormHit: passwordLoginFormHit, loggedInTextHit: loggedInTextHit, loggedInUrlHit: loggedInUrlHit }
          };
        } catch (eSession) {}
        var overlayText = errorOverlays.map(function(item) { return item && item.text ? item.text : ''; }).join(' ');
        var permissionSignal = null;
        var emptyStateSignal = null;
        var businessErrorSignal = null;
        var pageStateSignal = null;
        try {
          var signalText = [String(document.title || ''), String(text || ''), overlayText].join(' ');
          permissionSignal = findTextSignal(signalText, [
            '无权限', '权限不足', '没有权限', '访问被拒绝', '未授权',
            'forbidden', 'permission denied', 'access denied', 'not authorized', 'not authorised', '403'
          ]);
          emptyStateSignal = findTextSignal(signalText, [
            '无匹配数据', '暂无数据', '没有数据', '未查询到', '查询为空', '列表为空',
            'no data', 'no results', 'no matching data', 'not found in list', 'option not found'
          ]);
          businessErrorSignal = findTextSignal([overlayText, pageErrorSignal && pageErrorSignal.snippet].join(' '), [
            '保存失败', '提交失败', '创建失败', '删除失败', '操作失败', '执行失败',
            '校验失败', '验证失败', '名称重复', '已存在',
            'failed to save', 'save failed', 'submit failed', 'operation failed', 'already exists', 'duplicate'
          ]);
          pageStateSignal = findTextSignal(signalText, [
            '页面不存在', '资源不存在', '404', 'not found', 'not available', 'state mismatch'
          ]);
        } catch (eSignals) {}
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
          session_state_signal: sessionStateSignal,
          permission_signal: permissionSignal,
          empty_state_signal: emptyStateSignal,
          business_error_signal: businessErrorSignal,
          page_state_signal: pageStateSignal,
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

  static _cleanAiVisionSelector(value) {
    return String(value || '')
      .trim()
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
      .replace(/[，,；;。]+$/g, '')
      .trim();
  }

  static _readAiVisionSelectorByLabel(text, labels) {
    for (const label of labels) {
      const re = new RegExp(`${label}\\s*(?:selector|选择器)?\\s*[:：=]\\s*([^\\n,，;；]+)`, 'i');
      const m = String(text || '').match(re);
      if (m?.[1]) return PlayerManager._cleanAiVisionSelector(m[1]);
    }
    return '';
  }

  static _readAiVisionSelectorAfter(text, phrases) {
    for (const phrase of phrases) {
      const re = new RegExp(`${phrase}\\s*[「\\[\\(（'"\`“”‘’]?\\s*([^\\s，,；;」\\]\\)）'"\`“”‘’]+)`, 'i');
      const m = String(text || '').match(re);
      if (m?.[1]) return PlayerManager._cleanAiVisionSelector(m[1]);
    }
    return '';
  }

  static _looksLikeSelector(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    if (s.startsWith('#') || s.startsWith('.') || s.startsWith('[')) return true;
    if (s.startsWith('//') || s.startsWith('/html') || s.startsWith('(')) return true;
    if (/[>:[\]#.=~*+]/.test(s) && /^[a-zA-Z_*][\w-]*/.test(s)) return true;
    return false;
  }

  static _normalizeAiVisionSelector(value) {
    const selector = PlayerManager._cleanAiVisionSelector(value);
    return PlayerManager._looksLikeSelector(selector) ? selector : '';
  }

  static _parseAiVisionInstruction(instruction) {
    const text = String(instruction || '').trim();
    if (!/(验证码|图片识别|识别.{0,12}图片|ocr|captcha|vision)/i.test(text)) return null;

    const imageSelector =
      PlayerManager._normalizeAiVisionSelector(PlayerManager._readAiVisionSelectorByLabel(text, ['image', 'img', 'captcha', '图片', '验证码'])) ||
      PlayerManager._normalizeAiVisionSelector(PlayerManager._readAiVisionSelectorAfter(text, ['识别图片', '识别验证码图片', '识别验证码', '识别', 'ocr', 'captcha']));
    const inputSelector =
      PlayerManager._normalizeAiVisionSelector(PlayerManager._readAiVisionSelectorByLabel(text, ['input', 'field', 'target', '输入框', '验证码输入框'])) ||
      PlayerManager._normalizeAiVisionSelector(PlayerManager._readAiVisionSelectorAfter(text, ['输入到', '填入到', '填入', '写入到', '写入']));
    const submitSelector =
      PlayerManager._normalizeAiVisionSelector(PlayerManager._readAiVisionSelectorByLabel(text, ['submit', 'button', 'login', '提交按钮', '登录按钮'])) ||
      PlayerManager._normalizeAiVisionSelector(PlayerManager._readAiVisionSelectorAfter(text, ['然后点击', '并点击', '点击']));

    const promptMatch = text.match(/(?:prompt|提示词|识别要求)\s*[:：=]\s*([\s\S]+)$/i);
    const prompt = promptMatch?.[1]
      ? PlayerManager._cleanAiVisionSelector(promptMatch[1])
      : '请识别图片中的验证码内容。只返回验证码字符或算术结果，不要解释，不要添加标点。如果无法识别，请只返回 UNKNOWN。';
    return {
      imageSelector,
      inputSelector,
      submitSelector,
      autoDetect: !imageSelector || !inputSelector,
      autoSubmit: !submitSelector && /(登录|登陆|提交|sign\s*in|log\s*in|submit)/i.test(text),
      prompt,
    };
  }

  static _selectorKind(selector) {
    const s = String(selector || '').trim();
    if (s.startsWith('//') || s.startsWith('/html') || s.startsWith('(')) return 'xpath';
    return 'css';
  }

  async _detectAiVisionTargets(tabId) {
    const expr = `(function(){
      var captchaRe = /(captcha|verify|verification|checkcode|validcode|authcode|code|验证码|校验码|图形码|图片码)/i;
      var loginRe = /(login|log in|sign in|submit|登录|登陆|提交|进入)/i;
      function arr(list) { return Array.prototype.slice.call(list || []); }
      function norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }
      function cssEscape(s) {
        if (window.CSS && CSS.escape) return CSS.escape(String(s));
        return String(s).replace(/[^a-zA-Z0-9_-]/g, function(ch){ return '\\\\' + ch; });
      }
      function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        var cur = el;
        while (cur && cur.nodeType === 1) {
          var st = window.getComputedStyle(cur);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.03) return false;
          if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
          cur = cur.parentElement;
        }
        return true;
      }
      function selector(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + cssEscape(el.id);
        var testid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'));
        if (testid) return '[' + (el.getAttribute('data-testid') ? 'data-testid' : el.getAttribute('data-test') ? 'data-test' : 'data-cy') + '="' + String(testid).replace(/"/g, '\\\\"') + '"]';
        var name = el.getAttribute && el.getAttribute('name');
        var tag = String(el.tagName || '').toLowerCase();
        if (name && /^(input|textarea|select|button|img)$/i.test(tag)) return tag + '[name="' + String(name).replace(/"/g, '\\\\"') + '"]';
        var parts = [];
        var cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 5) {
          var curTag = String(cur.tagName || '').toLowerCase();
          var part = curTag;
          if (cur.classList && cur.classList.length) {
            var stable = arr(cur.classList).filter(function(c){ return c && !/\\d{3,}|css-|hash|active|focus|hover|selected|open|loading/i.test(c); }).slice(0, 2);
            if (stable.length) part += '.' + stable.map(cssEscape).join('.');
          }
          if (cur.parentElement) {
            var siblings = arr(cur.parentElement.children).filter(function(n){ return n.tagName === cur.tagName; });
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
          }
          parts.unshift(part);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      function attrs(el) {
        if (!el || !el.getAttribute) return '';
        return norm([
          el.id,
          el.className,
          el.getAttribute('name'),
          el.getAttribute('alt'),
          el.getAttribute('title'),
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('src'),
          el.getAttribute('type'),
          el.getAttribute('inputmode')
        ].join(' '));
      }
      function nearText(el) {
        var parts = [];
        function push(v) {
          var t = norm(v);
          if (t && parts.indexOf(t) < 0) parts.push(t);
        }
        try {
          push(el.getAttribute && el.getAttribute('aria-label'));
          var label = el.closest && el.closest('label');
          push(label && label.innerText);
          if (el.id) {
            arr(document.querySelectorAll('label[for="' + cssEscape(el.id) + '"]')).forEach(function(l){ push(l.innerText); });
          }
          var box = el.closest && el.closest('.field,.form-item,.ivu-form-item,.el-form-item,.ant-form-item,[class*="form-item"],[class*="field"],td,th');
          push(box && box.innerText);
          var p = el.parentElement;
          for (var i = 0; p && i < 2; i++, p = p.parentElement) push(p.innerText);
        } catch (e) {}
        return norm(parts.join(' ')).slice(0, 500);
      }
      function rect(el) {
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      }
      function distance(a, b) {
        var ar = a.getBoundingClientRect();
        var br = b.getBoundingClientRect();
        var ax = ar.left + ar.width / 2;
        var ay = ar.top + ar.height / 2;
        var bx = br.left + br.width / 2;
        var by = br.top + br.height / 2;
        return Math.sqrt(Math.pow(ax - bx, 2) + Math.pow(ay - by, 2));
      }
      function containerScore(root) {
        var score = 0;
        var text = norm(root.innerText || root.textContent || '');
        if (root.querySelector('input[type="password"]')) score += 45;
        if (loginRe.test(text)) score += 25;
        if (captchaRe.test(text)) score += 35;
        if (root.matches && root.matches('form')) score += 15;
        return score;
      }
      function imageScore(el) {
        var r = el.getBoundingClientRect();
        var score = 0;
        var a = attrs(el);
        var n = nearText(el);
        if (captchaRe.test(a)) score += 90;
        if (captchaRe.test(n)) score += 55;
        if (r.width >= 50 && r.width <= 260 && r.height >= 20 && r.height <= 110) score += 30;
        if (/^(img|canvas|svg)$/i.test(el.tagName || '')) score += 12;
        if (String(el.getAttribute && el.getAttribute('src') || '').startsWith('data:image')) score += 10;
        return score;
      }
      function inputScore(el) {
        var score = 0;
        var a = attrs(el);
        var n = nearText(el);
        var max = Number(el.getAttribute && el.getAttribute('maxlength'));
        var type = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden' || type === 'password') return -999;
        if (captchaRe.test(a)) score += 95;
        if (captchaRe.test(n)) score += 60;
        if (max >= 4 && max <= 8) score += 20;
        if (/numeric|decimal|tel/i.test(String(el.getAttribute && el.getAttribute('inputmode') || ''))) score += 12;
        return score;
      }
      function submitScore(el) {
        var text = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '');
        var score = loginRe.test(text) ? 80 : 0;
        if (String(el.getAttribute && el.getAttribute('type') || '').toLowerCase() === 'submit') score += 15;
        return score;
      }
      function bestIn(root, query, scorer, minScore) {
        return arr(root.querySelectorAll(query))
          .filter(visible)
          .map(function(el){ return { el: el, score: scorer(el), selector: selector(el), rect: rect(el), text: norm((el.innerText || el.value || el.getAttribute('alt') || el.getAttribute('placeholder') || '').slice(0, 80)) }; })
          .filter(function(c){ return c.selector && c.score >= minScore; })
          .sort(function(a, b){ return b.score - a.score; });
      }
      var roots = arr(document.querySelectorAll('form,[role="dialog"],[role="alertdialog"],.ant-modal,.ivu-modal,.el-dialog,.login-card,.auth-captcha-lab,[class*="login"],[class*="Login"],[class*="auth"],[class*="Auth"]'))
        .filter(visible);
      roots.push(document.body);
      roots = roots
        .map(function(root){ return { root: root, score: containerScore(root), selector: selector(root) || 'body' }; })
        .sort(function(a, b){ return b.score - a.score; })
        .slice(0, 8);
      var best = null;
      var debug = [];
      roots.forEach(function(item){
        var root = item.root;
        var images = bestIn(root, 'img,canvas,svg,[style*="background-image"]', imageScore, 55).slice(0, 5);
        var inputs = bestIn(root, 'input,textarea', inputScore, 55).slice(0, 5);
        var submits = bestIn(root, 'button,input[type="submit"],input[type="button"],[role="button"]', submitScore, 30).slice(0, 3);
        debug.push({
          root: item.selector,
          root_score: item.score,
          images: images.map(function(c){ return { selector: c.selector, score: c.score, rect: c.rect, text: c.text }; }),
          inputs: inputs.map(function(c){ return { selector: c.selector, score: c.score, rect: c.rect, text: c.text }; }),
          submits: submits.map(function(c){ return { selector: c.selector, score: c.score, text: c.text }; })
        });
        images.forEach(function(img){
          inputs.forEach(function(input){
            var d = distance(img.el, input.el);
            var pairScore = item.score + img.score + input.score + (d < 260 ? 35 : d < 520 ? 15 : 0);
            var submit = submits[0] || null;
            if (!best || pairScore > best.score) {
              best = { image: img, input: input, submit: submit, score: pairScore, root_score: item.score };
            }
          });
        });
      });
      if (!best || best.score < 190) {
        return { ok: false, reason: 'low_confidence', debug: debug.slice(0, 5) };
      }
      return {
        ok: true,
        imageSelector: best.image.selector,
        inputSelector: best.input.selector,
        submitSelector: best.submit ? best.submit.selector : '',
        confidence: Math.min(0.99, Math.round(best.score) / 300),
        score: Math.round(best.score),
        debug: debug.slice(0, 5)
      };
    })()`;
    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const out = res?.result?.value;
    if (!out?.ok) {
      const err = new Error('AI 图片识别：未能自动识别验证码图片和输入框，请在指令中指定 image/input 选择器');
      err.autoDetectDebug = out?.debug || [];
      throw err;
    }
    return out;
  }

  async _getElementRectBySelector(tabId, selector) {
    const kind = PlayerManager._selectorKind(selector);
    const expr = `(function(){
      var selector = ${JSON.stringify(selector)};
      var kind = ${JSON.stringify(kind)};
      function q(s) { try { return document.querySelector(s); } catch(e) { return null; } }
      function x(p) {
        try { return document.evaluate(p, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
        catch(e) { return null; }
      }
      function rectUsable(r) {
        return r && r.width >= 1 && r.height >= 1;
      }
      function rectInViewport(r) {
        return rectUsable(r)
          && r.top >= 0
          && r.left >= 0
          && r.bottom <= window.innerHeight
          && r.right <= window.innerWidth;
      }
      var el = kind === 'xpath' ? x(selector) : q(selector);
      if (!el) return { ok: false, reason: 'not_found' };
      var r = el.getBoundingClientRect();
      if (!rectInViewport(r)) {
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch(e) { el.scrollIntoView(); }
        r = el.getBoundingClientRect();
      }
      if (!rectUsable(r)) return { ok: false, reason: 'invisible' };
      var pad = 3;
      var x0 = Math.max(0, r.left - pad);
      var y0 = Math.max(0, r.top - pad);
      var x1 = Math.min(window.innerWidth, r.right + pad);
      var y1 = Math.min(window.innerHeight, r.bottom + pad);
      return {
        ok: true,
        x: x0,
        y: y0,
        width: Math.max(1, x1 - x0),
        height: Math.max(1, y1 - y0),
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2
      };
    })()`;
    const res = await this._cdpSend(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const out = res?.result?.value;
    if (!out?.ok) throw new Error(`AI 图片识别：找不到图片元素 ${selector}（${out?.reason || 'unknown'}）`);
    return out;
  }

  async _captureElementImageDataUrl(tabId, selector) {
    const rect = await this._getElementRectBySelector(tabId, selector);
    const res = await this._cdpSend(tabId, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      },
    });
    if (!res?.data) throw new Error(`AI 图片识别：验证码截图失败 ${selector}`);
    return `data:image/png;base64,${res.data}`;
  }

  async _clickBySelectorCDP(tabId, selector) {
    const rect = await this._getElementRectBySelector(tabId, selector);
    await this._cdpClick(tabId, rect.centerX, rect.centerY);
  }

  async _executeAiVisionStep(tabId, task, ctx, meta = {}) {
    const stepIndex = meta.stepIndex ?? '?';
    const stepTotal = meta.stepTotal ?? '?';
    const tcid = ctx.testCaseId ?? '?';
    const subtasks = [];
    const fail = (message) => {
      const err = new Error(message);
      err.aiSubtasks = subtasks;
      throw err;
    };

    const nextIndex = () => subtasks.length + 1;
    const resolvedTask = { ...task };
    if (resolvedTask.autoDetect || !resolvedTask.imageSelector || !resolvedTask.inputSelector || (resolvedTask.autoSubmit && !resolvedTask.submitSelector)) {
      try {
        this._notifyPopup(`#${tcid} 第 ${stepIndex}/${stepTotal} 步 · 正在自动识别验证码区域…`);
        const detected = await this._detectAiVisionTargets(tabId);
        if (!resolvedTask.imageSelector) resolvedTask.imageSelector = detected.imageSelector;
        if (!resolvedTask.inputSelector) resolvedTask.inputSelector = detected.inputSelector;
        if (!resolvedTask.submitSelector && resolvedTask.autoSubmit) resolvedTask.submitSelector = detected.submitSelector || '';
        subtasks.push({
          index: nextIndex(),
          instruction: '自动识别验证码图片、输入框和提交按钮',
          status: 'success',
          reason: `图片 ${resolvedTask.imageSelector}，输入框 ${resolvedTask.inputSelector}${resolvedTask.submitSelector ? `，提交 ${resolvedTask.submitSelector}` : ''}`,
          operations_count: 1,
        });
      } catch (e) {
        subtasks.push({
          index: nextIndex(),
          instruction: '自动识别验证码图片、输入框和提交按钮',
          status: 'failed',
          error_message: e?.message || String(e),
          operations_count: 1,
        });
        fail(e?.message || 'AI 图片识别：自动识别验证码区域失败');
      }
    }

    if (!resolvedTask.imageSelector || !resolvedTask.inputSelector) {
      fail('AI 图片识别：缺少验证码图片或输入框选择器，请使用 image/input 显式指定');
    }

    let image = '';
    let text = '';
    try {
      this._notifyPopup(`#${tcid} 第 ${stepIndex}/${stepTotal} 步 · 正在截取验证码图片…`);
      image = await this._captureElementImageDataUrl(tabId, resolvedTask.imageSelector);
      subtasks.push({
        index: nextIndex(),
        instruction: `截取验证码图片 ${resolvedTask.imageSelector}`,
        status: 'success',
        reason: '已截取目标图片区域',
        operations_count: 1,
      });
    } catch (e) {
      subtasks.push({
        index: nextIndex(),
        instruction: `截取验证码图片 ${resolvedTask.imageSelector}`,
        status: 'failed',
        error_message: e?.message || String(e),
        operations_count: 1,
      });
      fail(e?.message || 'AI 图片识别：验证码截图失败');
    }

    try {
      this._notifyPopup(`#${tcid} 第 ${stepIndex}/${stepTotal} 步 · 正在识别图片…`);
      const res = await this.api.aiVisionRecognize(
        { image, prompt: task.prompt, mode: 'captcha' },
        { timeoutMs: 60000 },
      );
      text = String(res?.data?.text || '').trim();
      if (!text || /^unknown$/i.test(text)) {
        throw new Error('AI 图片识别：模型未能识别出验证码');
      }
      subtasks.push({
        index: nextIndex(),
        instruction: '识别验证码图片文本',
        status: 'success',
        reason: `识别结果：${text}`,
        operations_count: 1,
      });
    } catch (e) {
      subtasks.push({
        index: nextIndex(),
        instruction: '识别验证码图片文本',
        status: 'failed',
        error_message: e?.message || String(e),
        operations_count: 1,
      });
      fail(e?.message || 'AI 图片识别失败');
    }

    try {
      const kind = PlayerManager._selectorKind(resolvedTask.inputSelector);
      await this._setInputValueCDP(
        tabId,
        kind === 'css' ? resolvedTask.inputSelector : '',
        kind === 'xpath' ? resolvedTask.inputSelector : '',
        text,
        null,
        false,
      );
      subtasks.push({
        index: nextIndex(),
        instruction: `输入识别结果到 ${resolvedTask.inputSelector}`,
        status: 'success',
        reason: `已输入：${text}`,
        operations_count: 1,
      });
    } catch (e) {
      subtasks.push({
        index: nextIndex(),
        instruction: `输入识别结果到 ${resolvedTask.inputSelector}`,
        status: 'failed',
        error_message: e?.message || String(e),
        operations_count: 1,
      });
      fail(e?.message || 'AI 图片识别：输入识别结果失败');
    }

    if (resolvedTask.submitSelector) {
      try {
        await this._sleep(180);
        await this._clickBySelectorCDP(tabId, resolvedTask.submitSelector);
        subtasks.push({
          index: nextIndex(),
          instruction: `点击提交按钮 ${resolvedTask.submitSelector}`,
          status: 'success',
          reason: '已点击提交按钮',
          operations_count: 1,
        });
      } catch (e) {
        subtasks.push({
          index: nextIndex(),
          instruction: `点击提交按钮 ${resolvedTask.submitSelector}`,
          status: 'failed',
          error_message: e?.message || String(e),
          operations_count: 1,
        });
        fail(e?.message || 'AI 图片识别：点击提交按钮失败');
      }
    }
    return subtasks;
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

    const visionTask = PlayerManager._parseAiVisionInstruction(instruction);
    if (visionTask) {
      return this._executeAiVisionStep(tabId, visionTask, ctx, meta);
    }

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
    const safeXp = PlayerManager._normalizeXPath(xpath);
    let safeSel = selector && !/:\w+-of-type\(0\)/.test(selector) ? selector : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';
    const volatileRc = PlayerManager._isVolatileRcCss(selector) || PlayerManager._isVolatileRcXPath(xpath);
    const preferId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(selector)
    );
    const metaCandidates = PlayerManager._normalizeLocatorMetaCandidates(locatorMeta);
    const locatorContext = PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null;
    const unifiedTargetExpr = PlayerManager._buildDomTargetChain(safeSel, safeXp, locatorMeta);

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
      var el = ${unifiedTargetExpr};
      if (!el) el = findByMeta();
      if (!el && ${preferId ? 'true' : 'false'} && sel) el = q(sel);
      if (!el && xp) el = x(xp);
      if (!el && sel) el = pickFromCssMulti(sel, xp);
      if (!el && volatileRc) el = antSearchFallback();
      if (el && el.tagName === 'SELECT') {
        var matched = false;
        var opts = Array.prototype.slice.call(el.options || []);
        for (var oi = 0; oi < opts.length; oi++) {
          if (String(opts[oi].value) === String(val)) {
            el.value = opts[oi].value;
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (var ti = 0; ti < opts.length; ti++) {
            if (String(opts[ti].text || '').trim() === String(val).trim()) {
              el.value = opts[ti].value;
              matched = true;
              break;
            }
          }
        }
        if (!matched) return { ok: false, reason: 'option_not_found' };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, control: 'select' };
      }
      if (el && (el.isContentEditable || (el.closest && el.closest('[contenteditable="true"]')))) {
        el = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        try { el.focus({ preventScroll: true }); } catch (em0) {}
        el.textContent = String(val);
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(val) }));
        } catch (e0) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, control: 'contenteditable' };
      }
      if (el && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var inner = el.querySelector && el.querySelector('input,textarea,[contenteditable="true"]');
        if (inner) el = inner;
      }
      if (el && (el.isContentEditable || (el.closest && el.closest('[contenteditable="true"]')))) {
        el = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        try { el.focus({ preventScroll: true }); } catch (em1) {}
        el.textContent = String(val);
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(val) }));
        } catch (e01) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, control: 'contenteditable' };
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

  async _setSelectValueCDP(tabId, selector, xpath, value, valueText = '', locatorMeta = null) {
    try {
      await this._setInputValueCDP(tabId, selector, xpath, value, locatorMeta, false);
      return;
    } catch (e) {
      if (!valueText || String(valueText) === String(value)) throw e;
    }
    await this._setInputValueCDP(tabId, selector, xpath, valueText, locatorMeta, false);
  }

  async _dispatchKeyOnFocusedCDP(tabId, selector, xpath, key, locatorMeta = null) {
    const safeXp = PlayerManager._normalizeXPath(xpath);
    let safeSel = selector && !/:\w+-of-type\(0\)/.test(selector) ? selector : '';
    if (PlayerManager._isVolatileRcCss(safeSel)) safeSel = '';
    const volatileRc = PlayerManager._isVolatileRcCss(selector) || PlayerManager._isVolatileRcXPath(xpath);
    const preferId = Boolean(
      safeSel && /^#[\w-]+$/.test(safeSel) && !PlayerManager._isVolatileRcCss(selector)
    );
    const metaCandidates = PlayerManager._normalizeLocatorMetaCandidates(locatorMeta);
    const locatorContext = PlayerManager._parseLocatorMetaObject(locatorMeta)?.context || null;
    const unifiedTargetExpr = PlayerManager._buildDomTargetChain(safeSel, safeXp, locatorMeta);
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
      var el = ${unifiedTargetExpr};
      if (!el) el = findByMeta();
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

  static _stepLooksLikeOverlay(step) {
    const locatorContext = PlayerManager._parseLocatorMetaObject(step?.locator_meta)?.context || {};
    return (step?.is_overlay && String(step?.value || '').trim() !== '')
      || (locatorContext.overlay === true && String(step?.value || '').trim() !== '')
      || (!step?.target_selector && step?.value);
  }

  async _executeStepCDP(tabId, step, baseUrl, locale = 'zh', nextStep = null, hooks = {}) {
    if (step.wait_before) await this._sleep(step.wait_before);
    let actualLocator = null;
    const actionType = String(step.action_type || '').trim().toLowerCase();
    await this._validateStepXpathsCDP(tabId, step);
    switch (actionType) {
      case 'frame_switch':
      case 'frame_parent':
      case 'frame_main': {
        await this._executeFrameAction(tabId, { ...step, action_type: actionType });
        break;
      }

      case 'evaluate': {
        await this._executeEvaluateCDP(tabId, step);
        break;
      }

      case 'select_option': {
        actualLocator = await this._executeSelectOptionCDP(tabId, step, locale);
        break;
      }

      case 'combo_select': {
        actualLocator = await this._executeComboSelectCDP(tabId, step, locale);
        break;
      }

      case 'dialog_accept':
      case 'dialog_dismiss':
      case 'dialog_prompt': {
        await this._executeDialogActionCDP(tabId, { ...step, action_type: actionType }, nextStep);
        break;
      }

      case 'input_date': {
        actualLocator = await this._executeInputDateCDP(tabId, step);
        break;
      }

      case 'clear': {
        actualLocator = await this._executeClearCDP(tabId, step);
        break;
      }

      case 'file_upload':
      case 'certificate_upload': {
        actualLocator = await this._executeFileUploadCDP(tabId, step, hooks.executionCapability, hooks.executionBatchId);
        break;
      }

      case 'assert_text': {
        actualLocator = await this._executeAssertTextStepCDP(tabId, step);
        break;
      }

      case 'assert_element_match': {
        actualLocator = await this._executeAssertTextStepCDP(tabId, step);
        break;
      }

      case 'assert_text_not': {
        await this._executeAssertTextNotCDP(tabId, step);
        break;
      }

      case 'assert_attribute': {
        actualLocator = await this._executeAssertAttributeCDP(tabId, step);
        break;
      }

      case 'assert_script': {
        await this._executeAssertScriptCDP(tabId, step);
        break;
      }

      case 'assert_text_regex': {
        await this._executeAssertTextRegexCDP(tabId, step);
        break;
      }

      case 'implicit_wait': {
        this._setImplicitWaitTimeout(tabId, step);
        break;
      }

      case 'pointer_move': {
        await this._executePointerMoveCDP(tabId, step);
        break;
      }

      case 'scroll_to_element': {
        actualLocator = await this._scrollToElementCDP(tabId, step);
        break;
      }

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
        const looksLikeOverlay = PlayerManager._stepLooksLikeOverlay(step);

        let box;
        let virtualAligned = false;
        if (looksLikeOverlay) {
          box = await this._clickOverlayItem(tabId, step, locale, { hadReveal: !!revealTrigger });
          actualLocator = PlayerManager._actualLocatorFromVia(step, 'overlay-text');
        } else {
          // 普通点击：检查 disabled 状态，等待组件就绪（级联 Select 场景）
          const boxResult = await this._getElementBoxResult(
            tabId, step.target_selector, step.target_xpath, step.value || '', 6000, false, step.locator_meta, true
          );
          box = boxResult && boxResult.ok ? boxResult.box : null;
          const virtualBox = await this._findVirtualScrollTargetBoxCDP(tabId, step, { overlayOnly: false });
          if (virtualBox) {
            box = virtualBox;
            virtualAligned = true;
          }
          if (!box) {
            throw new Error(this._formatElementWaitFailure(boxResult, step.target_selector, step.target_xpath));
          }
          actualLocator = PlayerManager._actualLocatorFromVia(step, box?.via);
        }

        // scrollIntoView 后等一帧让浏览器重排，再重取坐标（防止滚动偏差）
        await this._sleep(120);
        let freshBox = null;
        if (!virtualAligned) {
          if (looksLikeOverlay) {
            freshBox = await this._cdpSend(tabId, 'Runtime.evaluate', {
              expression: PlayerManager._findInOverlayCode(step.value || ''),
              returnByValue: true,
            }).then(r => r?.result?.value || null);
          } else {
            const freshResult = await this._getElementBoxResult(
              tabId,
              step.target_selector,
              step.target_xpath,
              step.value || '',
              2500,
              false,
              step.locator_meta,
              true,
            );
            if (!freshResult || !freshResult.ok || !freshResult.box) {
              throw new Error(this._formatElementWaitFailure(freshResult, step.target_selector, step.target_xpath));
            }
            freshBox = freshResult.box;
          }
        }
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

        const clickWhen = PlayerManager._normalizeClickWhen(step.click_when ?? step.details?.click_when);
        if (!['always', 'off', 'on', 'element_exists'].includes(clickWhen)) {
          throw new Error(`click_when 配置不支持: ${clickWhen}`);
        }
        if (clickWhen === 'element_exists') {
          const conditionResult = await this._readClickConditionExistsCDP(tabId, step);
          if (conditionResult?.exists !== true) {
            const conditionLocator = PlayerManager._clickConditionLocatorFields(step);
            return {
              __cdpStepResult: true,
              status: 'skipped',
              locator: actualLocator,
              details: {
                click_condition: clickWhen,
                condition_locator: conditionLocator.xpath || conditionLocator.selector,
                actual_state: 'not_exists',
                state_source: conditionResult?.source || 'condition_locator',
                skip_reason: conditionResult?.reason === 'condition_locator_missing'
                  ? 'condition_locator_missing'
                  : 'condition_element_not_found',
              },
            };
          }
        } else if (clickWhen !== 'always') {
          // 条件点击必须先确认状态；无法识别时跳过，避免再次切换开关到错误状态。
          const stateResult = await this._readClickStateCDP(tabId, step);
          const actualState = String(stateResult?.state || 'unknown');
          if (actualState !== clickWhen) {
            return {
              __cdpStepResult: true,
              status: 'skipped',
              locator: actualLocator,
              details: {
                click_condition: clickWhen,
                actual_state: actualState,
                state_source: stateResult?.source || 'unknown',
                skip_reason: actualState === 'unknown' ? 'element_state_unknown' : 'click_condition_not_met',
              },
            };
          }
        }

        if (typeof hooks.beforeActionScreenshot === 'function') {
          await hooks.beforeActionScreenshot();
        }

        await this._cdpClick(tabId, x, y, {
          button: actionType === 'right_click' ? 'right' : 'left',
          clickCount: actionType === 'double_click' ? 2 : 1,
        });

        if (looksLikeOverlay) await this._sleep(400);
        break;
      }

      case 'input': {
        if (step.target_selector || step.target_xpath || step.locator_meta) {
          const probe = await this._getElementBoxResult(
            tabId, step.target_selector, step.target_xpath, '', 1600, false, step.locator_meta
          );
          if (probe?.ok) actualLocator = PlayerManager._actualLocatorFromVia(step, probe.box?.via);
        }
        const deadline = Date.now() + this._getEffectiveWaitTimeout(tabId, 8000);
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

      case 'select': {
        const deadline = Date.now() + 8000;
        let lastErr = null;
        while (Date.now() < deadline) {
          await this._throwIfPageError(tabId);
          try {
            await this._setSelectValueCDP(
              tabId,
              step.target_selector,
              step.target_xpath,
              step.value || '',
              step.value_text || '',
              step.locator_meta
            );
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            await this._sleep(400);
          }
        }
        if (lastErr) throw new Error(`选择失败（等待超时）\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}\n  ${lastErr.message}`);
        await this._sleep(120);
        break;
      }

      case 'key': {
        if (step.target_selector || step.target_xpath || step.locator_meta) {
          const probe = await this._getElementBoxResult(
            tabId, step.target_selector, step.target_xpath, '', 1200, true, step.locator_meta
          );
          if (probe?.ok) actualLocator = PlayerManager._actualLocatorFromVia(step, probe.box?.via);
        }
        const deadline = Date.now() + this._getEffectiveWaitTimeout(tabId, 6500);
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
        if (step.target_selector || step.target_xpath || step.locator_meta) {
          actualLocator = await this._scrollToElementCDP(tabId, step);
          break;
        }
        const scrollY = Number(step.delta_y ?? step.value ?? 300);
        if (!Number.isFinite(scrollY)) throw new Error('scroll 的 delta_y 必须是有效数字');
        const viewport = await this._getCurrentPointerViewport(tabId);
        await this._cdpSend(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(viewport.width / 2),
          y: Math.round(viewport.height / 2),
          deltaX: Number(step.delta_x) || 0,
          deltaY: scrollY,
        });
        break;
      }

      case 'hover': {
        const boxResult = await this._getElementBoxResult(
          tabId, step.target_selector, step.target_xpath, '', 5000, false, step.locator_meta
        );
        const box = boxResult?.ok ? boxResult.box : null;
        if (box) {
          actualLocator = PlayerManager._actualLocatorFromVia(step, box.via);
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
          this._rememberPointerPosition(tabId, merged.x, merged.y);
        }
        await this._sleep(300);
        break;
      }

      default:
        await this._executeStepDOM(tabId, step, locale);
    }
    return actualLocator;
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
      const err = new Error(localizePlaybackError(locale, errText));
      if (result?.error_code) err.code = result.error_code;
      if (result?.locator_error) err.locatorError = result.locator_error;
      if (result?.variable_extraction_error) err.variableExtraction = result.variable_extraction_error;
      throw err;
    }
  }

  // =========================================================
  // 工具方法
  // =========================================================
  async _waitWithCountdown(durationMs, onCountdown) {
    let remainingMs = Math.max(0, Number(durationMs) || 0);
    while (remainingMs > 0) {
      onCountdown?.(Math.ceil(remainingMs / 1000));
      const chunkMs = Math.min(1000, remainingMs);
      await this._sleep(chunkMs);
      remainingMs -= chunkMs;
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _waitForTabLoad(tabId, timeoutMs = DEFAULT_TAB_LOAD_TIMEOUT_MS) {
    const timeoutAt = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_TAB_LOAD_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const check = async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || tab.status === 'complete') { resolve(); return; }
        if (Date.now() >= timeoutAt) {
          reject(new Error('等待页面加载完成超时'));
          return;
        }
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
