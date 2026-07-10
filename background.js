/**
 * Background Service Worker
 * 核心调度器：管理录制/回放状态、与中台 API 通信、调用 CDP 协议
 */

import { RecorderManager } from './modules/recorder-manager.js';
import { PlayerManager } from './modules/player-manager.js';
import { ApiClient } from './modules/api-client.js';

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
  recordingScreenshotMode: 'standard',
  recordingImport: null,
  recordingPaused: false,
  recordingStartedAt: 0,
  activePlayCount: 0,
};

const api = new ApiClient(() => state.apiBase, () => state.authToken);
const recorder = new RecorderManager(state, api);
const player = new PlayerManager(state, api);
const RECORDING_KEEPALIVE_ALARM = 'cc-recording-keepalive';

function armRecordingKeepalive() {
  chrome.alarms.create(RECORDING_KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

function clearRecordingKeepalive() {
  void chrome.alarms.clear(RECORDING_KEEPALIVE_ALARM);
}

void recorder.restoreSessionFromStorage()
  .then((restored) => {
    if (restored) {
      armRecordingKeepalive();
    }
  })
  .catch(() => {});
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
      recorder
        .start(message.testCaseId, message.startUrl, tabId, {
          insertAfterStepIndex: message.insertAfterStepIndex,
          screenshotMode: message.screenshotMode,
          recordingImport: message.recordingImport,
        })
        .then((response) => {
          if (response?.ok) {
            armRecordingKeepalive();
          }
          sendResponse(response);
        });
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

    // 来自中台或弹窗：开始回放（必须在短时间内 sendResponse，否则 MV3 消息通道会关闭，表现为点击无反应）
    case 'AT_PLATFORM_PLAY':
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      void player.start(message.testCaseId, message.startUrl, {
        backgroundTab: message.backgroundTab === true,
        reuseTabId: message.reuseTabId ?? null,
        startStepIndex: message.startStepIndex,
        locale: message.locale || 'zh',
        viewportMode: message.viewportMode,
        viewportWidth: message.viewportWidth,
        viewportHeight: message.viewportHeight,
        sourceWindowId: sender.tab?.windowId,
      });
      sendResponse({ ok: true, accepted: true });
      return false;

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

    // 来自弹窗：直接回放（同上，不可等整段回放结束再响应）
    case 'AT_POPUP_PLAY':
      state.apiBase = message.apiBase || state.apiBase;
      state.authToken = message.authToken || state.authToken;
      void player.start(message.testCaseId, null, { locale: message.locale || 'zh' });
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
          if (screenshotMode === SCREENSHOT_MODE_FULL_HD) {
            thumb = await captureVisibleFullHd(dataUrl);
          } else if (rect) {
            thumb = await cropVisibleToThumb(dataUrl, rect);
          }
          sendResponse({ ok: !!thumb, dataUrl: thumb });
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

async function injectBridgeIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch {
    return;
  }
  await Promise.all(tabs.map((tab) => injectBridgeIntoTab(tab.id)));
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
  void injectBridgeIntoOpenTabs();
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
  if (tabId === state.currentTabId && state.mode === 'recording') {
    recorder.handleRecordingTabClosed(tabId).catch(() => {});
    return;
  }
  void recorder.handleRecordingTabClosed(tabId).catch(() => {});
  player.handlePlayTabClosed(tabId);
});
