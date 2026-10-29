/**
 * Background Service Worker
 * 核心调度器：管理录制/回放状态、与中台 API 通信、调用 CDP 协议
 */

import { RecorderManager } from './modules/recorder-manager.js';
import { PlayerManager } from './modules/player-manager.js';
import { ApiClient } from './modules/api-client.js';
import { CdpBatchSessionManager } from './modules/cdp-batch-session-manager.js';
import { CurrentProfileBatchSessionManager } from './modules/current-profile-batch-session-manager.js';
import { BatchVariableContexts } from './modules/batch-variable-context.js';
import { RunnerWindowRegistry } from './modules/runner-windows.js';
import { runExecutionPlan } from './modules/plan-runner.js';
import { executeAgentRecordingCommand } from './modules/agent-recording-browser.js';
import { ensurePlaybackWindowMaximized } from './modules/playback-window.js';
import { RunnerRunContext, normalizeRunnerCaseResult } from './modules/runner-run-context.js';

function normalizeExtensionLocale(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const PLATFORM_CONFIG_STORAGE_KEY = 'cc-platform-config-v1';
let configuredPlatformOrigin = '';

function normalizePlatformOrigin(input) {
  try {
    const url = new URL(String(input || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function isPrivateIpv4Host(hostname) {
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isTrustedPlatformUrl(input) {
  try {
    const url = new URL(String(input || ''));
    // 显式配置优先锁定正式实例；私网部署地址允许在同一浏览器中切换，避免旧的本地配置阻断服务器页面。
    if (configuredPlatformOrigin && url.origin === configuredPlatformOrigin) return true;
    // 支持通过 Hosts 将正式域名映射至本机的 HTTP 调试环境，以及 RFC1918 私网部署地址。
    if (
      (url.hostname === 'app.icuecast.com' || url.hostname === 'app.icuecast.ai')
      && (url.protocol === 'https:' || url.protocol === 'http:')
    ) return true;
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || isPrivateIpv4Host(url.hostname));
  } catch {
    return false;
  }
}

async function loadPlatformConfig() {
  const stored = await chrome.storage.local.get(PLATFORM_CONFIG_STORAGE_KEY);
  const config = stored?.[PLATFORM_CONFIG_STORAGE_KEY] || null;
  configuredPlatformOrigin = normalizePlatformOrigin(config?.origin);
  if (configuredPlatformOrigin) {
    const nextApiBase = `${configuredPlatformOrigin}/api`;
    if (activeRunnerRun && activeRunnerRun.config.apiBase !== nextApiBase) {
      await activeRunnerRun.invalidate('CueCast 实例已切换，原执行任务已终止')
        .catch((error) => console.warn('[CueCast Runner] could not report instance switch:', error?.message || error));
    }
    await suspendRunnerConfigForContext(nextApiBase, state.organizationUuid);
    state.apiBase = nextApiBase;
  }
  return config;
}

function resolvePlatformApiBase(input, senderUrl) {
  if (!isTrustedPlatformUrl(senderUrl)) return '';
  try {
    const senderOrigin = new URL(senderUrl).origin;
    const apiUrl = new URL(String(input || '/api'), `${senderOrigin}/`);
    const sender = new URL(senderUrl);
    // Admin 可能使用 /api、/dev-api 或部署自定义前缀，保留完整 API base 路径。
    const normalizedPath = apiUrl.pathname.replace(/\/+$/, '') || '/';
    if (
      !(
        apiUrl.origin === senderOrigin
        || (apiUrl.protocol === sender.protocol && apiUrl.hostname === sender.hostname)
      )
      || apiUrl.username
      || apiUrl.password
      || apiUrl.search
      || apiUrl.hash
    ) return '';
    return normalizedPath === '/' ? apiUrl.origin : `${apiUrl.origin}${normalizedPath}`;
  } catch {
    return '';
  }
}

const state = {
  mode: 'idle',       // idle | recording（回放中仅用 activePlayCount 表示，见 AT_GET_STATE）
  testCaseId: null,
  apiBase: 'https://app.icuecast.com/api',
  authToken: '',
  organizationUuid: '',
  recordedSteps: [],
  currentTabId: null,
  /** 本次录制是否由扩展新开标签页（停止录制后自动关闭） */
  recordingOpenedNewTab: false,
  recordingWindowId: null,
  recordingTabs: [],
  currentRecordingTabIndex: 0,
  recordingScreenshotMode: 'standard',
  recordingImport: null,
  recordingEndUrl: '',
  recordingSaveFailed: false,
  recordingSaveError: '',
  recordingPaused: false,
  recordingStartedAt: 0,
  recordingLocale: normalizeExtensionLocale(chrome.i18n.getUILanguage()),
  recordingSessionId: '',
  recordingSessionEnabled: false,
  recordingSessionHealthy: false,
  pendingQuotaSave: null,
  activePlayCount: 0,
  cleanupExecutionFilesOnBatchEnd: true,
};

const EXTENSION_SETTINGS_KEY = 'cuecastSettings';
const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
  apiBase: 'http://localhost:3000/api',
  authToken: '',
  dashboardUrl: 'https://app.icuecast.com/dashboard',
  cleanupExecutionFilesOnBatchEnd: true,
});

function normalizeApiBase(value) {
  const text = String(value ?? '').trim();
  return text ? text.replace(/\/+$/, '') : DEFAULT_EXTENSION_SETTINGS.apiBase;
}

function applyExtensionSettings(settings = {}) {
  state.apiBase = normalizeApiBase(settings.apiBase);
  state.authToken = String(settings.authToken ?? '').trim();
  state.cleanupExecutionFilesOnBatchEnd = settings.cleanupExecutionFilesOnBatchEnd !== false;
}

async function restoreExtensionSettings() {
  const stored = await chrome.storage.local.get(EXTENSION_SETTINGS_KEY).catch(() => ({}));
  applyExtensionSettings(stored?.[EXTENSION_SETTINGS_KEY] || DEFAULT_EXTENSION_SETTINGS);
}

const api = new ApiClient(() => state.apiBase, () => state.authToken);
const recorder = new RecorderManager(state, api);
const player = new PlayerManager(state, api);
const cdpBatchSessions = new CdpBatchSessionManager(chrome);
const currentProfileBatchSessions = new CurrentProfileBatchSessionManager(chrome);
const batchVariables = new BatchVariableContexts();
let activeRunnerPlayer = null;
let activeRunnerRun = null;
const runnerWindows = new RunnerWindowRegistry(chrome.storage.local, chrome.windows);
const trackRunnerWindow = (runId, windowId, tabId) => runnerWindows.track(runId, windowId, tabId);
const closeRunnerWindows = (runId) => runnerWindows.close(runId);
const startupEventWindow = new Promise((resolve) => setTimeout(resolve, 100));
let startupCleanup = Promise.resolve();
const RECORDING_KEEPALIVE_ALARM = 'cc-recording-keepalive';
const RUNNER_POLL_ALARM = 'cc-runner-poll';
const RUNNER_POLL_PERIOD_MINUTES = 0.5;
const RUNNER_STORAGE_KEY = 'cc-extension-runner-v1';
const AGENT_RECORDING_STORAGE_KEY = 'cc-agent-recording-v1';
let runnerPollInFlight = false;
let agentRecordingCommandInFlight = false;
let agentRecordingPollTimer = null;
let lastRunnerAuthToken = '';
let runnerRegistrationInFlight = null;
let runnerRegistrationKey = '';

function armRunnerPolling() {
  chrome.alarms.create(RUNNER_POLL_ALARM, {
    delayInMinutes: 0.05,
    periodInMinutes: RUNNER_POLL_PERIOD_MINUTES,
  });
}

async function getRunnerConfig() {
  const stored = await chrome.storage.local.get(RUNNER_STORAGE_KEY);
  let config = stored?.[RUNNER_STORAGE_KEY];
  if (!config?.deviceId) {
    config = {
      deviceId: crypto.randomUUID(),
      apiBase: '',
      token: '',
      runnerId: '',
      platformAuthToken: '',
      organizationUuid: '',
    };
    await chrome.storage.local.set({ [RUNNER_STORAGE_KEY]: config });
  }
  return config;
}

async function suspendRunnerConfigForContext(apiBase, organizationUuid) {
  const config = await getRunnerConfig();
  if (!config.apiBase || (config.apiBase === apiBase
    && (!organizationUuid || config.organizationUuid === organizationUuid))) return;
  await chrome.storage.local.set({
    [RUNNER_STORAGE_KEY]: {
      ...config, apiBase, organizationUuid: organizationUuid || config.organizationUuid,
      token: '', runnerId: '', platformAuthToken: '',
    },
  });
  lastRunnerAuthToken = '';
}

async function clearRunnerPlaybackContext() {
  const config = await getRunnerConfig();
  if (!config.platformAuthToken) return;
  await chrome.storage.local.set({
    [RUNNER_STORAGE_KEY]: { ...config, platformAuthToken: '' },
  });
  lastRunnerAuthToken = '';
}

async function restoreRunnerPlaybackContext() {
  const config = await getRunnerConfig();
  if (!config.apiBase || !config.token) throw new Error('Runner is not registered');
  if (!config.platformAuthToken) {
    throw new Error('Runner 回放凭证不可用，请打开已登录的 CueCast 页面刷新连接');
  }
  state.apiBase = config.apiBase;
  state.authToken = config.platformAuthToken;
  return config;
}

async function runnerFetch(path, options = {}) {
  const config = options.config || await getRunnerConfig();
  if (!config.token || !config.apiBase) throw new Error('Runner is not registered');
  const requestToken = config.token;
  const response = await fetch(`${config.apiBase.replace(/\/api$/, '')}/api/runner-agent${path}`, {
    method: options.method || 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CueCast-Runner-Token': requestToken },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.status === 401 && options.config && options.retryCredential !== false) {
    // A same-organization page login rotates the Runner token. A request
    // already in flight can reach the server after the old token is revoked.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (config.token && config.token !== requestToken) {
      return runnerFetch(path, { ...options, retryCredential: false });
    }
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) throw new Error(body.message || `Runner request failed (${response.status})`);
  return body.data;
}

async function completeRunnerTask(taskId, result, config = null) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runnerFetch(`/runs/${encodeURIComponent(taskId)}/complete`, {
        body: result,
        config,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function getActiveAgentRecording() {
  const stored = await chrome.storage.local.get(AGENT_RECORDING_STORAGE_KEY);
  return stored?.[AGENT_RECORDING_STORAGE_KEY] || null;
}

async function saveActiveAgentRecording(value) {
  await chrome.storage.local.set({ [AGENT_RECORDING_STORAGE_KEY]: value });
}

async function clearActiveAgentRecording() {
  await chrome.storage.local.remove(AGENT_RECORDING_STORAGE_KEY);
  if (agentRecordingPollTimer) clearInterval(agentRecordingPollTimer);
  agentRecordingPollTimer = null;
}

function armAgentRecordingPolling() {
  if (agentRecordingPollTimer) return;
  agentRecordingPollTimer = setInterval(() => { void pollAgentRecordingOnce().catch(() => {}); }, 750);
}

async function reportAgentRecordingComplete(active, outcome) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runnerFetch(`/recordings/${encodeURIComponent(active.id)}/complete`, { body: outcome });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function finishAgentRecordingCommand(active, command, outcome) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runnerFetch(
        `/recordings/${encodeURIComponent(active.id)}/commands/${encodeURIComponent(command.id)}/complete`,
        { body: outcome },
      );
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function stopAgentRecordingFromControl(active, status = 'cancelled') {
  const result = status === 'cancelled'
    ? await recorder.cancel(active.tabId).catch((error) => ({ ok: false, error: error?.message || String(error) }))
    : { ok: false };
  await reportAgentRecordingComplete(active, {
    status,
    step_count: result?.discardedCount || 0,
    message: status === 'cancelled' ? '录制已取消' : '录制已终止',
  }).catch(() => {});
  await clearActiveAgentRecording();
}

async function pollAgentRecordingOnce() {
  let active = await getActiveAgentRecording();
  if (agentRecordingCommandInFlight) return Boolean(active);
  agentRecordingCommandInFlight = true;
  try {
    await restoreRunnerPlaybackContext();
    active = await getActiveAgentRecording();
    if (!active) {
      if (state.mode === 'recording' || (state.activePlayCount || 0) > 0) return false;
      const recovered = await recorder.heartbeat(null).catch(() => null);
      if (recovered?.active === true) return false;
      const task = await runnerFetch('/recordings/claim');
      if (!task) return false;
      const started = await recorder.start(task.test_case_id, task.start_url || '', null, {
        locale: normalizeExtensionLocale(chrome.i18n.getUILanguage()),
      });
      if (!started?.ok) {
        await reportAgentRecordingComplete(task, {
          status: 'failed',
          step_count: 0,
          message: started?.error || 'Runner 启动录制失败',
        }).catch(() => {});
        return true;
      }
      active = {
        id: task.id,
        testCaseId: task.test_case_id,
        tabId: started.tabId,
        lastHeartbeatAt: 0,
        startConfirmed: false,
      };
      await saveActiveAgentRecording(active);
      armAgentRecordingPolling();
      try {
        await runnerFetch(`/recordings/${encodeURIComponent(active.id)}/start`);
        active.startConfirmed = true;
        await saveActiveAgentRecording(active);
      } catch {
        // active 已持久化，让后续轮询重试幂等的 /start。
      }
      return true;
    }

    armAgentRecordingPolling();
    if (state.mode !== 'recording') {
      const recovered = await recorder.heartbeat(active.tabId).catch(() => null);
      if (!recovered?.active) {
        await reportAgentRecordingComplete(active, { status: 'failed', step_count: 0, message: '录制页面或本地录制上下文已丢失' }).catch(() => {});
        await clearActiveAgentRecording();
        return true;
      }
    }
    active.tabId = state.currentTabId || active.tabId;
    if (active.startConfirmed !== true) {
      try {
        await runnerFetch(`/recordings/${encodeURIComponent(active.id)}/start`);
        active.startConfirmed = true;
        await saveActiveAgentRecording(active);
      } catch {
        // 启动租约若已失效，heartbeat 会返回 stop 并清理本地录制。
        const control = await runnerFetch(`/recordings/${encodeURIComponent(active.id)}/heartbeat`).catch(() => null);
        if (control?.stop) await stopAgentRecordingFromControl(active, 'cancelled');
        return true;
      }
    }
    const now = Date.now();
    if (!active.lastHeartbeatAt || now - active.lastHeartbeatAt >= 5000) {
      const control = await runnerFetch(`/recordings/${encodeURIComponent(active.id)}/heartbeat`);
      if (control?.stop) {
        await stopAgentRecordingFromControl(active, 'cancelled');
        return true;
      }
      active.lastHeartbeatAt = now;
      await saveActiveAgentRecording(active);
    }

    const command = await runnerFetch(`/recordings/${encodeURIComponent(active.id)}/commands/claim`);
    if (!command) return true;
    try {
      if (command.type === 'finish') {
        const recordedSteps = Array.isArray(state.recordedSteps) ? state.recordedSteps : [];
        if (recordedSteps.length === 0) throw new Error('录制中没有可提交的步骤');
        if (!recordedSteps.some((step) => String(step?.action_type || '').startsWith('assert_'))) {
          throw new Error('自动录制至少需要一个明确断言，请先调用 add_recording_assertion');
        }
        const result = await recorder.stop(active.tabId);
        if (!result?.ok) throw new Error(result?.error || '提交录制失败');
        const response = { test_case_id: active.testCaseId, step_count: result.stepCount || 0 };
        await reportAgentRecordingComplete(active, {
          status: 'completed', step_count: result.stepCount || 0, message: '录制已提交',
          command_id: command.id, command_ok: true, command_data: response,
        });
        await clearActiveAgentRecording();
        return true;
      }
      if (command.type === 'cancel') {
        const result = await recorder.cancel(active.tabId);
        const response = { test_case_id: active.testCaseId, discarded_step_count: result?.discardedCount || 0 };
        await reportAgentRecordingComplete(active, {
          status: 'cancelled', step_count: 0, message: '录制已取消',
          command_id: command.id, command_ok: true, command_data: response,
        });
        await clearActiveAgentRecording();
        return true;
      }
      let commandStopRequested = false;
      const commandHeartbeat = setInterval(() => {
        void runnerFetch(`/recordings/${encodeURIComponent(active.id)}/heartbeat`)
          .then((control) => { if (control?.stop) commandStopRequested = true; })
          .catch(() => {});
      }, 5000);
      let data;
      try {
        data = await executeAgentRecordingCommand({
          command,
          recordingId: active.id,
          tabId: state.currentTabId || active.tabId,
          recorder,
          shouldStop: () => commandStopRequested,
        });
      } finally {
        clearInterval(commandHeartbeat);
      }
      active.tabId = state.currentTabId || active.tabId;
      await saveActiveAgentRecording(active);
      await finishAgentRecordingCommand(active, command, { ok: true, data });
    } catch (error) {
      await finishAgentRecordingCommand(active, command, { ok: false, error: error?.message || String(error) }).catch(() => {});
    }
    return true;
  } finally {
    agentRecordingCommandInFlight = false;
  }
}

async function ensureExtensionRunner() {
  const authToken = String(state.authToken || '');
  const apiBase = String(state.apiBase || '').replace(/\/$/, '');
  const organizationUuid = String(state.organizationUuid || '');
  if (!authToken) throw new Error('页面登录凭证为空，请重新登录 CueCast 后刷新页面');
  if (!apiBase) throw new Error('CueCast API 地址为空');

  const config = await getRunnerConfig();
  if (lastRunnerAuthToken === authToken && config.apiBase === apiBase
    && config.organizationUuid === organizationUuid && config.token) {
    armRunnerPolling();
    return { id: config.runnerId, reused: true };
  }

  const registrationKey = `${apiBase}\n${organizationUuid}\n${authToken}`;
  if (runnerRegistrationInFlight) {
    if (runnerRegistrationKey === registrationKey) return runnerRegistrationInFlight;
    await runnerRegistrationInFlight.catch(() => {});
  }

  // Registering is idempotent for one organization/device and rotates the
  // device credential when a user re-authenticates. Serialize registrations
  // so concurrent platform pings cannot leave an older rotated token stored.
  const registration = (async () => {
    const response = await fetch(`${apiBase}/runner/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        device_id: config.deviceId,
        name: `CueCast Extension ${chrome.runtime.getManifest().version}`,
        capabilities: {
          browser: true,
          replay: true,
          plan: true,
          schedule_cancel_recovery: true,
          recording: true,
          agent_recording: true,
          extension_version: chrome.runtime.getManifest().version,
        },
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0) throw new Error(body.message || `Runner 注册失败（${apiBase}，HTTP ${response.status}）`);
    if (!body.data?.token || !body.data?.id) throw new Error('Runner 注册响应缺少凭证');
    if (state.apiBase !== apiBase || state.organizationUuid !== organizationUuid) {
      throw new Error('Runner 上下文已切换，忽略旧注册结果');
    }
    await chrome.storage.local.set({
      [RUNNER_STORAGE_KEY]: {
        ...config,
        apiBase,
        token: body.data.token,
        runnerId: body.data.id,
        organizationUuid,
        // PlayerManager still uses the regular CueCast APIs in the first
        // browser Runner implementation. Persist the page session in the
        // extension's isolated storage so an MV3 service-worker wake can
        // fetch the case and save its result after the page is no longer
        // keeping the worker alive.
        platformAuthToken: authToken,
      },
    });
    const nextRunnerConfig = { ...config, apiBase, token: body.data.token,
      runnerId: body.data.id, platformAuthToken: authToken, organizationUuid };
    if (activeRunnerRun) {
      await activeRunnerRun.update(nextRunnerConfig)
        .catch((error) => console.warn('[CueCast Runner] could not report context switch:', error?.message || error));
    }
    lastRunnerAuthToken = authToken;
    armRunnerPolling();
    return body.data;
  })();
  runnerRegistrationInFlight = registration;
  runnerRegistrationKey = registrationKey;
  try {
    return await registration;
  } finally {
    if (runnerRegistrationInFlight === registration) {
      runnerRegistrationInFlight = null;
      runnerRegistrationKey = '';
    }
  }
}

async function executeRunnerPlan(task, options = {}) {
  const taskApi = options.api || api;
  const taskPlayer = options.player || player;
  let plan;
  if (task.type === 'batch') {
    const ids = Array.isArray(task.params?.case_ids) ? task.params.case_ids : [];
    if (!ids.length) throw new Error('批量执行没有可运行的用例');
    const cases = await Promise.all(ids.map(async (id) => (await taskApi.getTestCase(id))?.data));
    plan = {
      items: cases.map((item) => ({
        ...item,
        test_case_id: item?.id,
        test_case_name: item?.name,
      })),
      stop_on_failure: false,
      login_setup_enabled: false,
    };
  } else {
    const response = await taskApi.getPlan(task.plan_id);
    plan = response?.data;
  }
  if (!plan) throw new Error('执行计划不存在或无法读取');
  const locale = normalizeExtensionLocale(chrome.i18n.getUILanguage());

  return runExecutionPlan({
    plan,
    playCase: (item, options = {}) => taskPlayer.start(item.test_case_id, item.start_url || '', {
      backgroundTab: true,
      reuseTabId: options.reuseTabId ?? null,
      locale,
      purpose: options.kind === 'login_setup' ? 'runner_plan_login' : 'runner_plan',
      viewportMode: item.viewport_mode,
      viewportWidth: item.viewport_width,
      viewportHeight: item.viewport_height,
      executionSource: task.source || 'api',
      runId: task.id,
      onWindowCreated: (windowId, tabId) => trackRunnerWindow(task.id, windowId, tabId),
    }),
    openSharedTab: async (seedCase) => {
      const preference = await resolveWindowPreference({
        viewportMode: seedCase?.viewport_mode,
        viewportWidth: seedCase?.viewport_width,
        viewportHeight: seedCase?.viewport_height,
      });
      const win = await createSharedPlaybackWindow(preference);
      await trackRunnerWindow(task.id, win?.id, win?.tabs?.[0]?.id);
      const tabId = win?.tabs?.[0]?.id;
      if (tabId == null) throw new Error('无法创建执行计划回放窗口');
      return tabId;
    },
    closeSharedTab: (tabId) => chrome.tabs.remove(tabId),
    checkLogin: ({ tabId, url, selector }) => checkSelectorInTab({
      tabId,
      url,
      selector,
      timeoutMs: 12000,
    }),
    saveResult: async (result) => {
      if (task.type === 'batch') return null;
      const saved = await taskApi.savePlanResult(task.plan_id, { ...result, run_id: task.id,
        trigger_source: task.source || 'api' });
      return saved?.data || null;
    },
    onProgress: (progress) => runnerFetch(`/runs/${encodeURIComponent(task.id)}/progress`, {
      body: progress, config: options.runnerConfig,
    }),
    shouldStop: options.shouldStop,
  });
}

async function executeRunnerTask(task, options = {}) {
  if (task.type === 'plan' || task.type === 'batch') return executeRunnerPlan(task, options);
  if (task.type !== 'testcase') throw new Error(`Runner 不支持任务类型：${task.type || 'unknown'}`);
  const result = await (options.player || player).start(task.test_case_id, task.params?.start_url || '', {
    backgroundTab: true,
    locale: normalizeExtensionLocale(chrome.i18n.getUILanguage()),
    purpose: 'runner',
    executionSource: task.source || 'api',
    runId: task.id,
    onWindowCreated: (windowId, tabId) => trackRunnerWindow(task.id, windowId, tabId),
    startStepIndex: task.params?.start_step_index || 0,
    onProgress: (progress) => runnerFetch(`/runs/${encodeURIComponent(task.id)}/progress`, { body: progress, config: options.runnerConfig }),
  });
  return normalizeRunnerCaseResult(result);
}

async function pollRunnerOnce() {
  if (runnerPollInFlight || (state.activePlayCount || 0) > 0) return;
  runnerPollInFlight = true;
  let task = null;
  let taskPlayer = player;
  let runnerRunContext = null;
  let runnerConfig = null;
  let remoteStopRequested = false;
  try {
    await startupEventWindow;
    await startupCleanup;
    // Restore the playback API context before claiming. A Manifest V3 service
    // worker loses in-memory state whenever Chrome suspends it.
    runnerConfig = await restoreRunnerPlaybackContext();
    if (await pollAgentRecordingOnce()) return;
    if (state.mode === 'recording') return;
    task = await runnerFetch('/claim', { config: runnerConfig });
    if (!task) return;
    const latestRunnerConfig = await getRunnerConfig();
    if (latestRunnerConfig.apiBase !== runnerConfig.apiBase
      || latestRunnerConfig.runnerId !== runnerConfig.runnerId
      || (latestRunnerConfig.organizationUuid && runnerConfig.organizationUuid
        && latestRunnerConfig.organizationUuid !== runnerConfig.organizationUuid)) {
      await completeRunnerTask(task.id, {
        status: 'failed', message: 'CueCast 实例或组织已切换，原执行任务已终止',
      }, runnerConfig);
      return;
    }
    Object.assign(runnerConfig, latestRunnerConfig);
    if (task.status === 'cancel_requested') {
      await closeRunnerWindows(task.id);
      await completeRunnerTask(task.id, { status: 'cancelled', message: 'Runner 已确认停止执行' }, runnerConfig);
      return;
    }
    runnerRunContext = new RunnerRunContext(runnerConfig, async (reason) => {
      void taskPlayer.stop(task.id).catch(() => {});
      void closeRunnerWindows(task.id).catch(() => {});
      await completeRunnerTask(task.id, { status: 'failed', message: reason }, runnerRunContext.config);
    });
    activeRunnerRun = runnerRunContext;
    let scheduledSessionToken = '';
    if (task.source === 'schedule') {
      const session = await runnerFetch(`/runs/${encodeURIComponent(task.id)}/session`, { config: runnerRunContext.config });
      scheduledSessionToken = session.token;
    }
    const taskApi = new ApiClient(
      () => runnerRunContext.config.apiBase,
      () => task.source === 'schedule' ? scheduledSessionToken : runnerRunContext.config.platformAuthToken,
    );
    taskPlayer = new PlayerManager(state, taskApi);
    activeRunnerPlayer = taskPlayer;
    let heartbeatInFlight = false;
    const checkRunnerControl = async () => {
      if (heartbeatInFlight || runnerRunContext.invalidated) return;
      heartbeatInFlight = true;
      try {
        const control = await runnerFetch(`/runs/${encodeURIComponent(task.id)}/heartbeat`, { config: runnerRunContext.config });
        if (control?.stop) {
          remoteStopRequested = true;
          await taskPlayer.stop(task.id).catch(() => {});
        }
      } finally { heartbeatInFlight = false; }
    };
    await checkRunnerControl();
    const heartbeat = setInterval(() => { void checkRunnerControl().catch(() => {}); }, 5 * 1000);
    try {
      const result = remoteStopRequested || runnerRunContext.invalidated
        ? { ok: false, resultId: null, message: '执行已取消' }
        : await executeRunnerTask(task, { shouldStop: () => remoteStopRequested || runnerRunContext.invalidated,
          api: taskApi, player: taskPlayer, runnerConfig: runnerRunContext.config });
      if (remoteStopRequested) await closeRunnerWindows(task.id);
      if (runnerRunContext.beginCompletion()) await completeRunnerTask(task.id, {
        status: remoteStopRequested ? 'cancelled' : (result?.ok ? 'succeeded' : 'failed'),
        result_id: result?.resultId || null,
        message: remoteStopRequested ? '执行已取消' : (result?.message || (result?.ok ? '执行完成' : (result?.error || '执行失败'))),
        duration_ms: result?.duration || null,
        ...(result?.summary ? { summary: result.summary } : {}),
      }, runnerRunContext.config);
    } finally { clearInterval(heartbeat); }
  } catch (error) {
    console.warn('[CueCast Runner] poll failed:', error?.message || error);
    if (task?.id && task.status !== 'cancel_requested' && !remoteStopRequested
      && !runnerRunContext?.invalidated) {
      await completeRunnerTask(task.id, {
        status: 'failed',
        result_id: null,
        message: error?.message || 'Runner 执行异常',
        duration_ms: null,
      }, runnerRunContext?.config || runnerConfig).catch((completeError) => {
        console.warn('[CueCast Runner] failure report failed:', completeError?.message || completeError);
      });
    }
  } finally {
    if (task && task.status !== 'cancel_requested') await closeRunnerWindows(task.id).catch(() => {});
    if (taskPlayer !== player) taskPlayer.dispose();
    activeRunnerPlayer = null;
    if (activeRunnerRun === runnerRunContext) activeRunnerRun = null;
    runnerPollInFlight = false;
    if (task) setTimeout(() => { void pollRunnerOnce(); }, task.status === 'cancel_requested' ? 5000 : 0);
  }
}

async function activeCueCastIncognitoWindowIds() {
  const ids = new Set(await player.getActiveIncognitoWindowIds());
  if (activeRunnerPlayer) {
    for (const id of await activeRunnerPlayer.getActiveIncognitoWindowIds()) ids.add(id);
  }
  for (const id of await recorder.getActiveIncognitoWindowIds()) ids.add(id);
  return [...ids].filter((id) => Number.isInteger(id) && id > 0);
}

async function closeFailedPreparedIncognitoWindow(message, response) {
  if (
    response?.ok !== false
    || message.closeReusedTabAfterStop !== true
    || !Number.isInteger(Number(message.reuseTabId))
  ) return;
  await player.discardPreparedIncognitoWindowForTab(Number(message.reuseTabId));
}

function finishPlaybackBatch(batchManager, method, message, sourceTabId) {
  const batch = batchManager.batch;
  return batchManager[method](message.batchId, message.executionCapability, sourceTabId)
    .then(async (response) => {
      batchVariables.clearBatch(batch);
      // 网页可能在步骤结束后才真正提交文件，必须等批次成功结束再删除下载文件。
      await player.cleanupExecutionFiles(message.batchId, {
        removeFiles: state.cleanupExecutionFilesOnBatchEnd,
      });
      return response;
    });
}

function armRecordingKeepalive() {
  chrome.alarms.create(RECORDING_KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

function clearRecordingKeepalive() {
  void chrome.alarms.clear(RECORDING_KEEPALIVE_ALARM);
}

void restoreExtensionSettings()
  .then(() => recorder.restoreSessionFromStorage())
  .then((restored) => {
    if (restored) {
      armRecordingKeepalive();
    }
  })
  .catch(() => {});
// MV3 Service Worker 重启后不恢复无法证明归属的敏感会话，只清理遗留 Context 与快照。
void cdpBatchSessions.recoverOrCleanup().catch(() => {});
void currentProfileBatchSessions.recoverOrCleanup().catch(() => {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[EXTENSION_SETTINGS_KEY]) return;
  applyExtensionSettings(changes[EXTENSION_SETTINGS_KEY].newValue || DEFAULT_EXTENSION_SETTINGS);
});
void player.reconcileIncognitoState();
const SCREENSHOT_MODE_FULL_HD = 'full_hd';
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

async function resolveWindowPreference(message, sourceWindowId) {
  const mode = normalizeViewportMode(message.viewportMode || message.viewport_mode, 'maximized');
  if (mode === 'custom') {
    return {
      mode,
      width: normalizeViewportDimension(message.viewportWidth || message.viewport_width, DEFAULT_VIEWPORT_WIDTH),
      height: normalizeViewportDimension(message.viewportHeight || message.viewport_height, DEFAULT_VIEWPORT_HEIGHT),
    };
  }
  if (mode === 'current') {
    const bounds = await readWindowBounds(sourceWindowId);
    if (bounds) return { mode, ...bounds };
  }
  return { mode: 'maximized' };
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onUpdated = (updatedTabId, changeInfo) => {
      if (Number(updatedTabId) === Number(tabId) && changeInfo.status === 'complete') {
        finish(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish(true);
      })
      .catch(() => finish(false));
  });
}

async function checkSelectorInTab({ tabId, url, selector, timeoutMs = 12000 }) {
  const tid = Number(tabId);
  const css = String(selector || '').trim();
  if (!tid) return { ok: false, found: false, error: 'tabId is required' };
  if (url && String(url).trim()) {
    await chrome.tabs.update(tid, { url: String(url).trim(), active: true });
    await waitForTabComplete(tid, 30000);
  }
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 12000);
  let lastError = '';
  let autoLoggedInSince = 0;
  let autoLoggedInHref = '';
  let autoLoggedOutSince = 0;
  const AUTO_LOGGED_IN_STABLE_MS = 2500;
  const AUTO_LOGGED_OUT_STABLE_MS = 800;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: (s) => {
          try {
            if (!s) {
              var href = String(location.href || '').toLowerCase();
              var bodyText = String(document.body ? document.body.innerText || '' : '').trim();
              var loweredText = bodyText.toLowerCase();
              var hasContent = bodyText.length > 0 || Boolean(document.querySelector('#app,#root,main,[role="main"]'));
              if (!hasContent) return { found: false, mode: 'auto', waitingForContent: true };
              var hasPassword = Boolean(document.querySelector('input[type="password"]'));
              var loginUrlHit = /(^|[/?#&])(login|signin|sign-in|auth|sso)([/?#&=]|$)/i.test(href);
              var loginButtonHit = false;
              var buttons = document.querySelectorAll('button,input[type="submit"],a,[role="button"]');
              for (var i = 0; i < Math.min(buttons.length, 80); i++) {
                var text = String(buttons[i].innerText || buttons[i].value || buttons[i].getAttribute('aria-label') || '').trim().toLowerCase();
                if (/^(登录|登陆|log in|login|sign in|signin)$/.test(text)) {
                  loginButtonHit = true;
                  break;
                }
              }
              var titleText = String(document.title || '').trim();
              var headingText = '';
              var headings = document.querySelectorAll('h1,h2,h3,[role="heading"],form legend,form [class*="title"],form [class*="header"]');
              for (var j = 0; j < Math.min(headings.length, 20); j++) {
                headingText += ' ' + String(headings[j].innerText || headings[j].textContent || '').trim();
              }
              var loginPageTextHit = /(登录|登陆|用户登录|账号登录|密码登录|sign in|log in|login)/i.test(titleText + ' ' + headingText);
              var unauthorizedHit = /(unauthorized|forbidden|session expired|please sign in|please log in|登录已失效|请先登录|未登录|无权限|会话过期)/i.test(loweredText);
              var passwordLoginFormHit = hasPassword && (loginButtonHit || loginPageTextHit);
              var loggedOut = loginUrlHit || unauthorizedHit || passwordLoginFormHit;
              return {
                found: !loggedOut,
                visible: true,
                mode: 'auto',
                loggedOut,
                href,
                signals: { hasPassword, loginUrlHit, loginButtonHit, loginPageTextHit, unauthorizedHit },
              };
            }
            const el = document.querySelector(s);
            if (!el) return { found: false };
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible = rect.width > 0
              && rect.height > 0
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && Number(style.opacity || 1) > 0.05;
            return {
              found: true,
              visible,
              text: String(el.textContent || el.value || '').trim().slice(0, 120),
            };
          } catch (e) {
            return { found: false, error: e?.message || String(e) };
          }
        },
        args: [css],
      });
      if (result?.error) lastError = result.error;
      if (result?.mode === 'auto') {
        const now = Date.now();
        if (result.waitingForContent) {
          autoLoggedInSince = 0;
          autoLoggedOutSince = 0;
        } else if (result.loggedOut) {
          autoLoggedInSince = 0;
          if (!autoLoggedOutSince) autoLoggedOutSince = now;
          if (now - autoLoggedOutSince >= AUTO_LOGGED_OUT_STABLE_MS) {
            return { ok: true, found: false, mode: 'auto', signals: result.signals || null };
          }
        } else if (result.found) {
          autoLoggedOutSince = 0;
          if (!autoLoggedInSince || autoLoggedInHref !== result.href) {
            autoLoggedInSince = now;
            autoLoggedInHref = result.href || '';
          }
          if (now - autoLoggedInSince >= AUTO_LOGGED_IN_STABLE_MS) {
            return { ok: true, found: true, mode: 'auto', signals: result.signals || null };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      if (result?.found && result?.visible !== false) {
        return { ok: true, found: true, text: result.text || '' };
      }
    } catch (e) {
      lastError = e?.message || String(e);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { ok: true, found: false, error: lastError };
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
  data.state = focused ? 'maximized' : 'normal';
  return data;
}

async function createSharedPlaybackWindow(preference) {
  const win = await chrome.windows.create(buildWindowCreateData('about:blank', false, preference));
  if (win?.id != null && preference?.mode === 'maximized') {
    try {
      await ensurePlaybackWindowMaximized(win.id);
    } catch (error) {
      await chrome.windows.remove(win.id).catch(() => {});
      throw error;
    }
  }
  return win;
}

/**
 * 从整页截图中裁剪元素区域，输出 JPEG data URL（限制最大宽度以控制体积）
 */
async function cropVisibleToThumb(dataUrl, rect) {
  const { left, top, width, height, viewportWidth, viewportHeight } = rect;
  if (!viewportWidth || !viewportHeight || width < 1 || height < 1) return '';

  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const img = await createImageBitmap(blob);

  let sx = (left / viewportWidth) * img.width;
  let sy = (top / viewportHeight) * img.height;
  let sw = (width / viewportWidth) * img.width;
  let sh = (height / viewportHeight) * img.height;

  if (sx < 0) {
    sw += sx;
    sx = 0;
  }
  if (sy < 0) {
    sh += sy;
    sy = 0;
  }
  sw = Math.min(sw, img.width - sx);
  sh = Math.min(sh, img.height - sy);
  if (sw < 2 || sh < 2) {
    img.close?.();
    return '';
  }

  const maxW = 960;
  let outW = sw;
  let outH = sh;
  if (sw > maxW) {
    outW = maxW;
    outH = (sh * maxW) / sw;
  }

  const canvas = new OffscreenCanvas(Math.round(outW), Math.round(outH));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    img.close?.();
    return '';
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
  img.close?.();

  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result || '');
    reader.onerror = reject;
    reader.readAsDataURL(outBlob);
  });
}

/**
 * 输出整屏高清截图（JPEG）
 */
async function captureVisibleFullHd(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const img = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(Math.max(1, img.width), Math.max(1, img.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    img.close?.();
    return '';
  }
  ctx.drawImage(img, 0, 0, img.width, img.height);
  img.close?.();
  const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.96 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result || '');
    reader.onerror = reject;
    reader.readAsDataURL(outBlob);
  });
}

// =========================================================
// 消息路由
// =========================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (String(message?.type || '').startsWith('AT_PLATFORM_') && !isTrustedPlatformUrl(sender.url)) {
    sendResponse({ ok: false, error: 'untrusted_platform_origin' });
    return false;
  }

  const platformApiBase = resolvePlatformApiBase(message?.apiBase, sender.url);
  if (String(message?.type || '').startsWith('AT_PLATFORM_') && message.apiBase && !platformApiBase) {
    sendResponse({ ok: false, error: 'invalid_api_base' });
    return false;
  }

  switch (message.type) {
    case 'AT_CONFIG_UPDATED':
      loadPlatformConfig()
        .then(async (config) => {
          await injectBridgeIntoOpenTabs();
          sendResponse({ ok: true, config });
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;

    case 'AT_PLATFORM_PING':
      Promise.resolve()
        .then(async () => {
          const organizationUuid = String(message.organizationUuid || '');
          const instanceChanged = activeRunnerRun && platformApiBase
            && activeRunnerRun.config.apiBase !== platformApiBase;
          const organizationChanged = activeRunnerRun && organizationUuid
            && activeRunnerRun.config.organizationUuid
            && activeRunnerRun.config.organizationUuid !== organizationUuid;
          if (instanceChanged || organizationChanged) {
            await activeRunnerRun.invalidate('CueCast 实例或组织已切换，原执行任务已终止')
              .catch((error) => console.warn('[CueCast Runner] could not report instance switch:', error?.message || error));
          }
          await suspendRunnerConfigForContext(platformApiBase || state.apiBase, organizationUuid);
          state.apiBase = platformApiBase || state.apiBase;
          state.authToken = String(message.authToken || '');
          state.organizationUuid = organizationUuid;
          if (!state.authToken) {
            await clearRunnerPlaybackContext().catch(() => {});
            return null;
          }
          return ensureExtensionRunner();
        })
        .then((runner) => {
          sendResponse({
            ok: true,
            version: chrome.runtime.getManifest().version,
            nonce: message.nonce,
            runnerReady: Boolean(runner),
            runnerId: runner?.id || '',
          });
          // Do not wait for the first one-minute alarm when a queued MCP task
          // may already exist.
          if (runner) void pollRunnerOnce();
        })
        .catch((error) => {
          const messageText = error?.message || String(error);
          console.warn('[CueCast Runner] registration failed:', messageText);
          sendResponse({
            ok: true,
            version: chrome.runtime.getManifest().version,
            nonce: message.nonce,
            runnerReady: false,
            runnerError: messageText,
          });
        });
      return true;

    case 'AT_PLATFORM_OPEN_EXTENSION_SETTINGS':
      chrome.tabs.create({
        url: `chrome://extensions/?id=${chrome.runtime.id}`,
        active: true,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message || 'Unable to open extension settings' }));
      return true;

    case 'AT_PLATFORM_CLOSE_INCOGNITO_WINDOWS':
      activeCueCastIncognitoWindowIds()
        .then(async (activeIds) => {
          if (activeIds.length > 0) {
            sendResponse({
              ok: false,
              code: 'incognito_session_active',
              error: 'CueCast is currently using an incognito window. Stop the active recording or playback before closing incognito windows.',
            });
            return;
          }
          const preparedIds = await player.closePreparedIncognitoWindows();
          const windows = await chrome.windows.getAll({ populate: false });
          const ids = windows.filter((win) => win?.incognito === true && win.id != null).map((win) => win.id);
          await Promise.all(ids.map((id) => chrome.windows.remove(id).catch(() => {})));
          sendResponse({ ok: true, closed: preparedIds.length + ids.length });
        })
        .catch((e) => sendResponse({ ok: false, error: e?.message || 'Unable to close incognito windows' }));
      return true;

    // 来自中台或弹窗：开始录制
    case 'AT_PLATFORM_RECORD':
      state.apiBase = platformApiBase || message.apiBase || state.apiBase;
      state.authToken = String(message.authToken || state.authToken);
      void ensureExtensionRunner().catch((error) => console.warn('[CueCast Runner] registration failed:', error?.message || error));
      (async () => {
        const windowPreference = await resolveWindowPreference(message, sender.tab?.windowId);
        try {
          const response = await recorder.start(message.testCaseId, message.startUrl, tabId, {
            insertAfterStepIndex: message.insertAfterStepIndex,
            insertAfterStepId: message.insertAfterStepId,
            screenshotMode: message.screenshotMode,
            recordingImport: message.recordingImport,
            windowPreference,
            reuseTabId: message.reuseTabId,
            closeReusedTabAfterStop: message.closeReusedTabAfterStop === true,
            runInIncognito: message.runInIncognito === true,
            locale: message.locale || normalizeExtensionLocale(chrome.i18n.getUILanguage()),
          });
          await closeFailedPreparedIncognitoWindow(message, response);
          if (response?.ok && message.reuseTabId != null) {
            await player.claimPreparedIncognitoWindowForTab(Number(message.reuseTabId));
          }
          if (response?.ok) {
            armRecordingKeepalive();
          }
          sendResponse(response);
        } catch (e) {
          const response = { ok: false, error: e?.message || 'Unable to start recording' };
          await closeFailedPreparedIncognitoWindow(message, response);
          sendResponse(response);
        }
      })();
      return true;

    case 'AT_RECORDING_HEARTBEAT':
      recorder.heartbeat(tabId).then((response) => {
        if (response?.ok && response?.active) {
          armRecordingKeepalive();
        }
        sendResponse(response);
      });
      return true;

    case 'AT_RECORDING_PAUSE_STATE':
      recorder.setPausedState(message.paused === true).then(sendResponse);
      return true;

    case 'AT_PLATFORM_RECORDING_DRAFT_STATUS':
      recorder.getSessionDraftSummary().then(sendResponse);
      return true;

    // 中台导入失败时复用扩展草稿，不能把失败录制降级为官方 testcases 保存。
    case 'AT_PLATFORM_RETRY_RECORDING':
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      recorder.retrySaveDraft().then(sendResponse);
      return true;

    case 'AT_AI_VARIABLE_EXTRACT_RULE':
      api.aiVariableExtractRule({
        raw_value: message.rawValue,
        instruction: message.instruction,
      })
        .then((res) => sendResponse({ ok: true, rule: res.data }))
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true;

    case 'AT_PLATFORM_CDP_CAPABILITIES':
      cdpBatchSessions.probeCapabilities(tabId, sender.tab?.url)
        .then(sendResponse)
        .catch((e) => sendResponse({
          ok: false,
          managedBrowserContext: false,
          managedSessionStrategy: 'exclusive-incognito',
          supportedSessionModes: ['legacy-profile'],
          errorCode: e.code,
          error: e.message || String(e),
        }));
      return true;

    case 'AT_PLATFORM_BEGIN_PLAYBACK_BATCH':
      (message.browserSessionSource === 'current-profile'
        ? currentProfileBatchSessions
        : cdpBatchSessions).beginBatch({
        batchId: message.batchId,
        sessionMode: message.sessionMode,
        browserSessionSource: message.browserSessionSource,
        sourceTabId: tabId,
        sourceUrl: sender.tab?.url,
        executionCapability: message.executionCapability,
      })
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, errorCode: e.code, error: e.message || String(e) }));
      return true;

    case 'AT_PLATFORM_END_PLAYBACK_BATCH':
      finishPlaybackBatch(message.browserSessionSource === 'current-profile'
        ? currentProfileBatchSessions
        : cdpBatchSessions, 'endBatch', message, tabId)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, errorCode: e.code, error: e.message || String(e) }));
      return true;

    case 'AT_PLATFORM_ABORT_PLAYBACK_BATCH':
      finishPlaybackBatch(message.browserSessionSource === 'current-profile'
        ? currentProfileBatchSessions
        : cdpBatchSessions, 'abortBatch', message, tabId)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, errorCode: e.code, error: e.message || String(e) }));
      return true;

    // 来自中台或弹窗：开始回放（必须在短时间内 sendResponse，否则 MV3 消息通道会关闭，表现为点击无反应）
    case 'AT_PLATFORM_PLAY': {
      state.apiBase = platformApiBase || message.apiBase || state.apiBase;
      state.authToken = String(message.authToken || state.authToken);
      void ensureExtensionRunner().catch((error) => console.warn('[CueCast Runner] registration failed:', error?.message || error));
      const batchSessionManager = message.browserSessionSource === 'managed-context'
        ? cdpBatchSessions
        : message.browserSessionSource === 'current-profile' && message.sessionMode === 'legacy-profile'
          && currentProfileBatchSessions.ownsBatch(message.batchId)
          ? currentProfileBatchSessions
          : null;
      void player.start(message.testCaseId, message.startUrl, {
        adminCaseKey: message.adminCaseKey || message.caseKey,
        batchId: message.batchId,
        executionCapability: message.executionCapability,
        executionId: message.executionId,
        projectEnvironmentId: message.projectEnvironmentId,
        dataSource: message.dataSource || message.executionSource,
         backgroundTab: message.purpose === 'record_context_prepare'
           ? false
           : (message.backgroundTab === true || message.backgroundTab == null),
         runInIncognito: message.runInIncognito === true,
        reuseTabId: message.reuseTabId ?? null,
        startStepIndex: message.startStepIndex,
        stopAfterStepIndex: message.stopAfterStepIndex,
        keepTabOpenAfterPlayback: message.keepTabOpenAfterPlayback === true,
        suppressResultSave: message.suppressResultSave === true,
        purpose: message.purpose,
        locale: message.locale || normalizeExtensionLocale(chrome.i18n.getUILanguage()),
        viewportMode: message.viewportMode,
        viewportWidth: message.viewportWidth,
        viewportHeight: message.viewportHeight,
        pageErrorCheckEnabled: message.pageErrorCheckEnabled,
        sourceWindowId: sender.tab?.windowId,
        sessionMode: message.sessionMode,
        browserSessionSource: message.browserSessionSource,
        ...(batchSessionManager ? {
          prepareVariableContext: async ({ sceneKey, projectEnvironmentId, initialVariables }) => {
            batchSessionManager.assertBatch(message.batchId, message.sessionMode, message.browserSessionSource);
            await batchSessionManager.assertExecutionCapability(message.executionCapability);
            return batchVariables.beginCase(batchSessionManager.batch, { sceneKey, projectEnvironmentId }, initialVariables);
          },
          finalizeVariableContext: (session, success) => batchVariables.finishCase(
            session, success && session?.batch === batchSessionManager.batch,
          ),
          prepareBrowserSession: ({ startUrl, ignoreHttpsErrors }) => batchSessionManager.prepareCase({
            batchId: message.batchId,
            sessionMode: message.sessionMode,
            browserSessionSource: message.browserSessionSource,
            executionCapability: message.executionCapability,
            startUrl,
            ignoreHttpsErrors,
          }),
          finalizeBrowserSession: (result) => batchSessionManager.finalizeCase({
            batchId: message.batchId,
            ...result,
          }),
        } : {}),
      });
      sendResponse({ ok: true, accepted: true });
      return false;
    }

    // 计划批量执行：提前开好一个窗口，返回 tabId 供后续复用
    case 'AT_PLATFORM_OPEN_PLAY_TAB':
      resolveWindowPreference(message, sender.tab?.windowId)
        .then((preference) => createSharedPlaybackWindow(preference))
        .then((win) => sendResponse({ ok: true, tabId: win.tabs[0].id }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    // 计划批量执行完毕：关闭复用的标签页
    case 'AT_PLATFORM_CLOSE_PLAY_TAB':
      chrome.tabs.remove(message.tabId).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'AT_PLATFORM_CHECK_SELECTOR':
      checkSelectorInTab({
        tabId: message.tabId,
        url: message.url,
        selector: message.selector,
        timeoutMs: message.timeoutMs,
      })
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, found: false, error: e.message || String(e) }));
      return true;

    // 来自弹窗：直接回放（同上，不可等整段回放结束再响应）
    case 'AT_POPUP_PLAY':
      state.apiBase = platformApiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      void player.start(message.testCaseId, null, {
        adminCaseKey: message.adminCaseKey || message.caseKey,
        dataSource: message.dataSource || message.executionSource,
        locale: message.locale || normalizeExtensionLocale(chrome.i18n.getUILanguage()),
        backgroundTab: message.backgroundTab !== false,
      });
      sendResponse({ ok: true, accepted: true });
      return false;

    case 'AT_PLATFORM_FOCUS_PLAY_TAB':
      player.focusPlayTab(Number(message.testCaseId))
        .then((result) => result.ok || !activeRunnerPlayer
          ? result : activeRunnerPlayer.focusPlayTab(Number(message.testCaseId)))
        .then(sendResponse);
      return true;

    case 'AT_PLATFORM_FOCUS_RUN':
      player.focusRun(String(message.runId || ''))
        .then((result) => result.ok || !activeRunnerPlayer
          ? result : activeRunnerPlayer.focusRun(String(message.runId || '')))
        .then(sendResponse);
      return true;

    case 'AT_PLATFORM_STOP_RUN':
      Promise.all([player.stop(String(message.runId || '')), activeRunnerPlayer?.stop(String(message.runId || ''))]).then(() => sendResponse({ ok: true }));
      return true;

    // 来自中台：停止当前所有回放（含批量顺序执行中的当前用例）
    case 'AT_PLATFORM_STOP_PLAYBACK':
      Promise.all([player.stop(), activeRunnerPlayer?.stop()]).then(() => sendResponse({ ok: true }));
      return true;

    // 来自录制页：截取当前视口内元素区域缩略图（先于 AT_STEP_CAPTURED）
    case 'AT_CAPTURE_STEP_THUMB': {
      const rect = message.rect;
      const winId = sender.tab?.windowId;
      const screenshotMode = String(message.screenshotMode || '').trim().toLowerCase();
      if (!winId) {
        sendResponse({ ok: false, dataUrl: '' });
        return false;
      }
      (async () => {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
          let thumb = '';
          let fullDataUrl = '';
          try {
            fullDataUrl = await captureVisibleFullHd(dataUrl);
          } catch (e) {
            fullDataUrl = '';
          }
          if (screenshotMode === SCREENSHOT_MODE_FULL_HD) {
            thumb = fullDataUrl;
          } else if (rect) {
            thumb = await cropVisibleToThumb(dataUrl, rect);
          }
          sendResponse({ ok: !!thumb || !!fullDataUrl, dataUrl: thumb, fullDataUrl });
        } catch (e) {
          console.warn('[AT_CAPTURE_STEP_THUMB]', e);
          sendResponse({ ok: false, dataUrl: '' });
        }
      })();
      return true;
    }

    // 来自录制内容脚本：捕获到新步骤
    case 'AT_STEP_CAPTURED':
      recorder.addStep(message.step, tabId).then((response) => {
        if (response?.ok && response?.active) {
          armRecordingKeepalive();
        }
        sendResponse(response);
      });
      return true;

    // 来自录制工具栏 / 中台：手动停止录制（保存并覆盖服务端步骤）
    case 'AT_STOP_RECORDING':
    case 'AT_PLATFORM_STOP':
      // AT_STOP_RECORDING 来自被录制页面，sender.url 是业务页地址，不能据此覆盖中台 API。
      // 例如录制 localhost:5180 时，覆盖后会把未完成的 steps 和 commit 发往 localhost:5180/api。
      if (message.type === 'AT_PLATFORM_STOP') {
        state.apiBase = platformApiBase || state.apiBase;
        state.authToken = String(message.authToken || '');
      }
      recorder.stop(tabId).then((response) => {
        clearRecordingKeepalive();
        sendResponse(response);
      });
      return true;

    // 来自录制工具栏 / 中台：取消录制（不保存，服务端步骤不变）
    case 'AT_CANCEL_RECORDING':
    case 'AT_PLATFORM_CANCEL_RECORD':
      if (message.type === 'AT_PLATFORM_CANCEL_RECORD') {
        state.apiBase = platformApiBase || state.apiBase;
        state.authToken = String(message.authToken || '');
      }
      recorder.cancel(tabId).then((response) => {
        clearRecordingKeepalive();
        sendResponse(response);
      });
      return true;

    // 来自中台：步骤数超额后，仅保留套餐允许的前 N 步并保存
    case 'AT_PLATFORM_SAVE_RECORDING_TRIMMED':
      state.apiBase = platformApiBase || state.apiBase;
      state.authToken = String(message.authToken || '');
      recorder.savePendingQuotaSteps(message.pendingSaveId, message.limit).then((response) => {
        sendResponse(response);
      });
      return true;

    // 来自中台：步骤数超额后，放弃保存本次录制
    case 'AT_PLATFORM_DISCARD_RECORDING_SAVE':
      state.apiBase = platformApiBase || state.apiBase;
      state.authToken = String(message.authToken || '');
      recorder.discardPendingQuotaSteps(message.pendingSaveId).then((response) => {
        sendResponse(response);
      });
      return true;

    // 来自弹窗：查询状态
    case 'AT_GET_STATE':
      sendResponse({
        mode:
          state.mode === 'recording'
            ? 'recording'
            : (state.activePlayCount || 0) > 0
              ? 'playing'
              : 'idle',
        testCaseId: state.testCaseId,
        recordedSteps: state.recordedSteps.length,
        recordingPaused: state.recordingPaused === true,
        activePlayCount: Number(state.activePlayCount || 0),
      });
      return false;

    // 来自弹窗：停止所有操作（录制中 = 停止并保存）
    case 'AT_STOP_ALL':
      if (state.mode === 'recording') recorder.stop().then(sendResponse);
      else if ((state.activePlayCount || 0) > 0) Promise.all([player.stop(), activeRunnerPlayer?.stop()]).then(() => sendResponse({ ok: true }));
      else sendResponse({ ok: true });
      return true;

    // 来自回放页 content/player：普通 assert_text 比对详情（在 Service Worker 打印，避免只看错控制台）
    case 'AT_ASSERT_TEXT_DEBUG': {
      const p = message.payload || {};
      const title = String(p.mode || '').startsWith('element')
        ? '普通断言（按选择器 · 元素内容与输入值全等）'
        : '普通断言（未选元素 · 整页子串包含）';
      console.log('[AT assert_text] ========== ' + title + ' ==========');
      console.log('[AT assert_text] 说明:', p.note || '');
      if (p.css || p.xpath) {
        console.log('[AT assert_text] CSS:', p.css || '—', 'XPath:', p.xpath || '—');
      }
      console.log('[AT assert_text] 预期长度:', p.needleLen);
      console.log('[AT assert_text] 预期内容:\n' + (p.needlePreview != null ? p.needlePreview : ''));
      console.log('[AT assert_text] 实际长度:', p.pageLen);
      console.log('[AT assert_text] 实际内容:\n' + (p.pagePreview != null ? p.pagePreview : ''));
      console.log('[AT assert_text] 比对结果:', String(p.mode || '').startsWith('element') ? '元素匹配' : '整页匹配', '=', p.hit);
      console.log('[AT assert_text] ==========================================');
      sendResponse({ ok: true });
      return false;
    }
  }
});

// =========================================================
// 向已打开页面注入 bridge（manifest content_scripts 不会回填已打开标签页）
// =========================================================
const BRIDGE_SCRIPT = 'content/bridge.js';

function isInjectableHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

async function isBridgeInstalledInTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__CC_BRIDGE_INSTALLED__),
    });
    return result === true;
  } catch {
    return false;
  }
}

/** 扩展上下文失效后需强制重装 bridge；日常勿清除 manifest 已注入的实例，否则会叠两套监听器。 */
async function clearBridgeInstallFlag(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__CC_BRIDGE_INSTALLED__ = false;
      },
    });
  } catch {
    // ignore
  }
}

async function injectBridgeIntoTab(tabId, { force = false } = {}) {
  if (!tabId) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isTrustedPlatformUrl(tab.url)) return false;
    if (!force) {
      if (await isBridgeInstalledInTab(tabId)) return true;
    } else {
      await clearBridgeInstallFlag(tabId);
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [BRIDGE_SCRIPT],
    });
    return true;
  } catch {
    return false;
  }
}

async function injectBridgeIntoOpenTabs({ force = false } = {}) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(tabs.map((tab) => injectBridgeIntoTab(tab.id, { force })));
}

let injectOnActivateTimer = null;
function scheduleInjectActiveTab(tabId) {
  if (!tabId) return;
  if (injectOnActivateTimer != null) clearTimeout(injectOnActivateTimer);
  injectOnActivateTimer = setTimeout(() => {
    injectOnActivateTimer = null;
    void injectBridgeIntoTab(tabId);
  }, 60);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleInjectActiveTab(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  cdpBatchSessions.handleTabCreated(tab);
  currentProfileBatchSessions.handleTabCreated(tab);
  void recorder.handleRecordingTabCreated(tab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isInjectableHttpUrl(tab?.url)) {
    if (isTrustedPlatformUrl(tab?.url)) scheduleInjectActiveTab(tabId);
    void recorder.handleRecordingTabLoadComplete(tabId, tab?.url);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    scheduleInjectActiveTab(tab?.id);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  // 扩展升级后页面中的旧 bridge 已失效，首次回填必须清除旧版本留下的安装标记。
  void injectBridgeIntoOpenTabs({ force: true });
  void player.reconcileIncognitoState();
  void loadPlatformConfig().then(() => injectBridgeIntoOpenTabs());
  setTimeout(() => loadPlatformConfig().then(() => injectBridgeIntoOpenTabs()), 400);
  setTimeout(() => loadPlatformConfig().then(() => injectBridgeIntoOpenTabs()), 1200);
});

chrome.runtime.onStartup.addListener(() => {
  startupCleanup = runnerWindows.clearAll();
  void player.reconcileIncognitoState();
  void loadPlatformConfig().then(() => injectBridgeIntoOpenTabs());
  armRunnerPolling();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('cc-prepared-incognito-window:')) {
    void player.handlePreparedIncognitoAlarm(alarm.name.slice('cc-prepared-incognito-window:'.length));
    return;
  }
  if (alarm.name === RUNNER_POLL_ALARM) {
    void pollRunnerOnce();
    return;
  }
  if (alarm.name !== RECORDING_KEEPALIVE_ALARM) return;
  void recorder.keepAliveTick().then((result) => {
    if (!result?.ok || result?.active !== true) {
      clearRecordingKeepalive();
    }
  }).catch(() => {});
});

// This module is evaluated on extension reload and on every service-worker
// wake. Re-arm polling from persisted registration state and make one claim
// immediately so queued MCP work does not have to wait for a page ping.
void getRunnerConfig()
  .then((config) => {
    if (!config.apiBase || !config.token) return;
    armRunnerPolling();
    if (config.platformAuthToken) void pollRunnerOnce();
  })
  .catch((error) => console.warn('[CueCast Runner] bootstrap failed:', error?.message || error));

void loadPlatformConfig()
  .then(() => injectBridgeIntoOpenTabs())
  .catch((error) => console.warn('[CueCast] platform config load failed:', error?.message || error));

// =========================================================
// 标签页关闭时清理状态
// =========================================================
chrome.tabs.onRemoved.addListener((tabId) => {
  currentProfileBatchSessions.handleTabRemoved(tabId);
  if (state.mode === 'recording') {
    recorder.handleRecordingTabClosed(tabId).catch(() => {});
    return;
  }
  void recorder.handleRecordingTabClosed(tabId).catch(() => {});
  void player.handlePlayTabClosed(tabId).catch(() => {});
  if (activeRunnerPlayer) void activeRunnerPlayer.handlePlayTabClosed(tabId).catch(() => {});
});
