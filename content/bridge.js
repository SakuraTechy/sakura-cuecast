/**
 * Bridge Content Script
 * 桥接层：监听中台页面发来的消息，转发给 background Service Worker
 * 同时接收 background 发来的录制事件，回传给中台页面
 */

(function () {
  'use strict';

  function isTrustedPlatformLocation() {
    return window.location.protocol === 'http:' || window.location.protocol === 'https:';
  }

  // 本地 Hosts 调试使用正式域名的 HTTP 入口；其他站点不注册
  // bridge，也不会接收或转发任何中台消息。
  if (!isTrustedPlatformLocation()) return;
  if (window.__CC_BRIDGE_INSTALLED__) return;
  window.__CC_BRIDGE_INSTALLED__ = true;

  /**
   * 扩展重新加载后，本脚本会成为"孤儿"——仍在运行但 chrome API 已失效。
   * 不依赖 chrome.runtime.id 探测（不稳定），而是在实际调用时捕获错误并标记。
   */
  let invalidated = false;

  function onInvalidated() {
    if (invalidated) return;
    invalidated = true;
    window.__CC_BRIDGE_INSTALLED__ = false;
    window.postMessage({ type: 'AT_EXTENSION_CONTEXT_INVALID' }, '*');
  }

  function safeSend(msg, callback) {
    if (invalidated) return;
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          callback && callback({ ok: false, error: chrome.runtime.lastError.message || 'runtime unavailable' });
          return;
        }
        callback && callback(response);
      });
    } catch (e) {
      onInvalidated();
      callback && callback({ ok: false, error: e?.message || 'runtime unavailable' });
    }
  }

  // ── 监听中台页面通过 window.postMessage 发来的指令 ─────────────────────────
  window.addEventListener('message', (event) => {
    if (invalidated) return;
    if (event.source !== window) return;
    if (event.origin !== window.location.origin || !isTrustedPlatformLocation()) return;
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'AT_PLATFORM_PING') {
      // A browser profile may keep domestic, overseas and local CueCast tabs
      // open together. Only the visible platform tab may select the Runner's
      // API/auth context; hidden tabs still report that the extension exists.
      if (document.visibilityState === 'hidden') {
        window.postMessage(
          {
            type: 'AT_PLATFORM_PONG',
            nonce: data.nonce,
            ok: true,
            runnerReady: false,
          },
          '*',
        );
        return;
      }
      // A successful platform ping also establishes the authenticated
      // extension Runner. Keep this on the trusted platform origin only.
      let organizationUuid = '';
      try { organizationUuid = String(JSON.parse(localStorage.getItem('cc_auth_user') || '{}').organization_uuid || ''); }
      catch { /* Older or incomplete page session. */ }
      safeSend({
        type: 'AT_PLATFORM_PING',
        nonce: data.nonce,
        apiBase: `${window.location.origin}/api`,
        authToken: localStorage.getItem('cc_auth_token') || '',
        organizationUuid,
      }, (response) => {
        window.postMessage(
          {
            type: 'AT_PLATFORM_PONG',
            nonce: data.nonce,
            ok: response?.ok !== false,
            version: response?.version,
            runnerReady: response?.runnerReady === true,
            runnerId: response?.runnerId || '',
            runnerError: response?.runnerError || '',
          },
          '*',
        );
      });
      return;
    }

    if (data.type === 'AT_PLATFORM_FOCUS_RUN') {
      safeSend({ type: 'AT_PLATFORM_FOCUS_RUN', runId: data.runId }, (response) => {
        window.postMessage({ type: 'AT_PLATFORM_ACK', original: data.type, response }, '*');
      });
      return;
    }

    if (data.type === 'AT_PLATFORM_STOP_RUN') {
      safeSend({ type: 'AT_PLATFORM_STOP_RUN', runId: data.runId }, (response) => {
        window.postMessage({ type: 'AT_PLATFORM_ACK', original: data.type, response }, '*');
      });
      return;
    }

    if (data.type === 'AT_PLATFORM_FOCUS_PLAY_TAB') {
      safeSend(
        { type: 'AT_PLATFORM_FOCUS_PLAY_TAB', testCaseId: data.testCaseId },
        (response) => {
          window.postMessage(
            {
              type: 'AT_PLATFORM_ACK',
              original: data.type,
              nonce: data.nonce,
              requestId: data.requestId || '',
              response,
              testCaseId: data.testCaseId,
            },
            '*',
          );
        },
      );
      return;
    }

    if (
      data.type === 'AT_PLATFORM_RECORD'
      || data.type === 'AT_PLATFORM_RETRY_RECORDING'
      || data.type === 'AT_PLATFORM_RECORDING_DRAFT_STATUS'
      || data.type === 'AT_PLATFORM_PLAY'
      || data.type === 'AT_PLATFORM_STOP'
      || data.type === 'AT_PLATFORM_STOP_PLAYBACK'
      || data.type === 'AT_PLATFORM_CANCEL_RECORD'
      || data.type === 'AT_PLATFORM_SAVE_RECORDING_TRIMMED'
      || data.type === 'AT_PLATFORM_DISCARD_RECORDING_SAVE'
      || data.type === 'AT_PLATFORM_OPEN_PLAY_TAB'
      || data.type === 'AT_PLATFORM_CLOSE_PLAY_TAB'
      || data.type === 'AT_PLATFORM_CDP_CAPABILITIES'
      || data.type === 'AT_PLATFORM_BEGIN_PLAYBACK_BATCH'
      || data.type === 'AT_PLATFORM_END_PLAYBACK_BATCH'
      || data.type === 'AT_PLATFORM_ABORT_PLAYBACK_BATCH'
      || data.type === 'AT_PLATFORM_CHECK_SELECTOR'
      || data.type === 'AT_PLATFORM_OPEN_EXTENSION_SETTINGS'
      || data.type === 'AT_PLATFORM_CLOSE_INCOGNITO_WINDOWS'
    ) {
      // 统一在此注入 auth token，前端和 background 均无需感知 token 来源
      const authToken = localStorage.getItem('cc_auth_token') || '';
      safeSend({ ...data, authToken }, (response) => {
        window.postMessage(
          {
            type: 'AT_PLATFORM_ACK',
            original: data.type,
            nonce: data.nonce,
            response,
            testCaseId: data.testCaseId,
            purpose: data.purpose || '',
            requestId: data.requestId || '',
          },
          '*',
        );
      });
    }
  });

  // ── 监听来自 background 的消息，转发给页面 ────────────────────────────────
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (
        message.type === 'AT_RECORD_STEP'
        || message.type === 'AT_STATUS_UPDATE'
        || message.type === 'AT_RECORDING_LIVE'
        || message.type === 'AT_RECORDING_END'
        || message.type === 'AT_PLAYBACK_LIVE'
        || message.type === 'AT_PLAYBACK_PROGRESS'
        || message.type === 'AT_PLAYBACK_END'
      ) {
        window.postMessage(message, '*');
      }
      try { sendResponse({ ok: true }); } catch (_) { /* context may be gone */ }
    });
  } catch (e) {
    onInvalidated();
  }
})();
