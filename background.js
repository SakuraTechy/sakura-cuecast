/**
 * Background Service Worker
 * 核心调度器：管理录制/回放状态、与中台 API 通信、调用 CDP 协议
 */

import { RecorderManager } from './modules/recorder-manager.js';
import { PlayerManager } from './modules/player-manager.js';
import { ApiClient } from './modules/api-client.js';
import { CdpBatchSessionManager } from './modules/cdp-batch-session-manager.js';
import { CurrentProfileBatchSessionManager } from './modules/current-profile-batch-session-manager.js';

const state = {
  mode: 'idle',       // idle | recording（回放中仅用 activePlayCount 表示，见 AT_GET_STATE）
  testCaseId: null,
  apiBase: 'http://localhost:3000/api',
  authToken: '',
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
const RECORDING_KEEPALIVE_ALARM = 'cc-recording-keepalive';

function finishPlaybackBatch(batchManager, method, message, sourceTabId) {
  return batchManager[method](message.batchId, message.executionCapability, sourceTabId)
    .then(async (response) => {
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
  data.state = 'maximized';
  return data;
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

  switch (message.type) {
    case 'AT_PLATFORM_PING':
      sendResponse({
        ok: true,
        version: chrome.runtime.getManifest().version,
        nonce: message.nonce,
      });
      return false;

    // 来自中台或弹窗：开始录制
    case 'AT_PLATFORM_RECORD':
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      (async () => {
        const windowPreference = await resolveWindowPreference(message, sender.tab?.windowId);
        const response = await recorder.start(message.testCaseId, message.startUrl, tabId, {
          insertAfterStepIndex: message.insertAfterStepIndex,
          screenshotMode: message.screenshotMode,
          recordingImport: message.recordingImport,
          windowPreference,
          reuseTabId: message.reuseTabId,
          closeReusedTabAfterStop: message.closeReusedTabAfterStop === true,
        });
        if (response?.ok) {
          armRecordingKeepalive();
        }
        sendResponse(response);
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
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
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
        backgroundTab: message.backgroundTab === true,
        reuseTabId: message.reuseTabId ?? null,
        startStepIndex: message.startStepIndex,
        stopAfterStepIndex: message.stopAfterStepIndex,
        keepTabOpenAfterPlayback: message.keepTabOpenAfterPlayback === true,
        suppressResultSave: message.suppressResultSave === true,
        purpose: message.purpose,
        locale: message.locale || 'zh',
        viewportMode: message.viewportMode,
        viewportWidth: message.viewportWidth,
        viewportHeight: message.viewportHeight,
        pageErrorCheckEnabled: message.pageErrorCheckEnabled,
        sourceWindowId: sender.tab?.windowId,
        sessionMode: message.sessionMode,
        browserSessionSource: message.browserSessionSource,
        ...(batchSessionManager ? {
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
        .then((preference) => chrome.windows.create(buildWindowCreateData('about:blank', true, preference)))
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
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      void player.start(message.testCaseId, null, {
        adminCaseKey: message.adminCaseKey || message.caseKey,
        dataSource: message.dataSource || message.executionSource,
        locale: message.locale || 'zh',
      });
      sendResponse({ ok: true, accepted: true });
      return false;

    case 'AT_PLATFORM_FOCUS_PLAY_TAB':
      player.focusPlayTab(Number(message.testCaseId)).then(sendResponse);
      return true;

    // 来自中台：停止当前所有回放（含批量顺序执行中的当前用例）
    case 'AT_PLATFORM_STOP_PLAYBACK':
      player.stop().then(sendResponse);
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
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      recorder.stop(tabId).then((response) => {
        clearRecordingKeepalive();
        sendResponse(response);
      });
      return true;

    // 来自录制工具栏 / 中台：取消录制（不保存，服务端步骤不变）
    case 'AT_CANCEL_RECORDING':
    case 'AT_PLATFORM_CANCEL_RECORD':
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      recorder.cancel(tabId).then((response) => {
        clearRecordingKeepalive();
        sendResponse(response);
      });
      return true;

    // 来自中台：步骤数超额后，仅保留套餐允许的前 N 步并保存
    case 'AT_PLATFORM_SAVE_RECORDING_TRIMMED':
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      recorder.savePendingQuotaSteps(message.pendingSaveId, message.limit).then((response) => {
        sendResponse(response);
      });
      return true;

    // 来自中台：步骤数超额后，放弃保存本次录制
    case 'AT_PLATFORM_DISCARD_RECORDING_SAVE':
      recorder.discardPendingQuotaSteps(message.pendingSaveId).then((response) => {
        sendResponse(response);
      });
      return true;

    // 来自弹窗：查询状态
    case 'AT_GET_STATE':
      sendResponse({
        ...state,
        mode:
          state.mode === 'recording'
            ? 'recording'
            : (state.activePlayCount || 0) > 0
              ? 'playing'
              : 'idle',
        recordedSteps: state.recordedSteps.length,
      });
      return false;

    // 来自弹窗：停止所有操作（录制中 = 停止并保存）
    case 'AT_STOP_ALL':
      if (state.mode === 'recording') recorder.stop().then(sendResponse);
      else if ((state.activePlayCount || 0) > 0) player.stop().then(sendResponse);
      else sendResponse({ ok: true });
      return true;

    // 来自回放页 content/player：普通 assert_text 比对详情（在 Service Worker 打印，避免只看错控制台）
    case 'AT_ASSERT_TEXT_DEBUG': {
      const p = message.payload || {};
      const title = p.mode === 'element'
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
      console.log('[AT assert_text] 比对结果:', p.mode === 'element' ? '全等 ===' : '整页 includes', '=', p.hit);
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

function isInjectablePlatformUrl(url) {
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
    if (!isInjectablePlatformUrl(tab.url)) return false;
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
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
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
  if (changeInfo.status === 'complete' && isInjectablePlatformUrl(tab?.url)) {
    scheduleInjectActiveTab(tabId);
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
  setTimeout(() => injectBridgeIntoOpenTabs(), 400);
  setTimeout(() => injectBridgeIntoOpenTabs(), 1200);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECORDING_KEEPALIVE_ALARM) return;
  void recorder.keepAliveTick().then((result) => {
    if (!result?.ok || result?.active !== true) {
      clearRecordingKeepalive();
    }
  }).catch(() => {});
});

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
});
