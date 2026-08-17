import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient } from '../modules/api-client.js';
import {
  PlayerManager,
  resolvePlaybackBrowserBootstrap,
  resolvePlaybackRuntimeConfig,
} from '../modules/player-manager.js';

test('Admin batch uses only the frozen EffectiveExecutionConfig', () => {
  const effectiveExecutionConfig = {
    start_url: 'https://server.example/login',
    browser_bootstrap_mode: 'launch',
    window_size_mode: 'custom',
    viewport_width: 1440,
    viewport_height: 900,
    page_error_check_enabled: false,
    ignore_https_errors: true,
    screenshot_mode: 'full_hd',
    step_timeout_ms: 4200,
    case_timeout_ms: 180000,
    sources: {
      start_url: 'case-default',
      window_size_mode: 'execution-override',
    },
  };

  const resolved = resolvePlaybackRuntimeConfig({
    start_url: 'https://stale-current-definition.example',
    effectiveExecutionConfig,
  }, {
    batchId: 'BATCH_001',
    startUrl: 'https://client-override.example',
    viewportMode: 'current',
    viewportWidth: 800,
    viewportHeight: 600,
    pageErrorCheckEnabled: true,
  }, true);

  assert.equal(resolved.frozen, true);
  assert.equal(resolved.startUrl, 'https://server.example/login');
  assert.equal(resolved.windowSizeMode, 'custom');
  assert.equal(resolved.ignoreHttpsErrors, true);
  assert.equal(resolved.viewportWidth, 1440);
  assert.equal(resolved.viewportHeight, 900);
  assert.equal(resolved.pageErrorCheckEnabled, false);
  assert.equal(resolved.screenshotMode, 'full_hd');
  assert.equal(resolved.stepTimeoutMs, 4200);
  assert.equal(resolved.caseTimeoutMs, 180000);
  assert.deepEqual(resolved.executionConfig, effectiveExecutionConfig);
});

test('CDP debugger applies HTTPS certificate policy before enabling the page domain', async () => {
  const originalChrome = globalThis.chrome;
  const commands = [];
  globalThis.chrome = {
    debugger: {
      async attach() {},
      async detach() {},
      sendCommand(_target, method, params, callback) {
        commands.push({ method, params });
        callback({});
      },
    },
    runtime: {},
  };
  try {
    const player = new PlayerManager({}, {});
    const context = { debuggerAttached: false, ignoreHttpsErrors: true };

    assert.equal(await player._attachDebugger(42, context), true);
    assert.deepEqual(commands.slice(0, 2), [
      { method: 'Security.setIgnoreCertificateErrors', params: { ignore: true } },
      { method: 'Page.enable', params: {} },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('新建标签页 target 尚未就绪时有限重试 debugger attach', async () => {
  const originalChrome = globalThis.chrome;
  let attachCount = 0;
  globalThis.chrome = {
    debugger: {
      onEvent: { addListener() {}, removeListener() {} },
      async attach() {
        attachCount += 1;
        if (attachCount < 3) throw new Error('Cannot attach to this target.');
      },
      async detach() {},
      sendCommand(_target, _method, _params, callback) { callback({}); },
    },
    runtime: { lastError: null },
    tabs: { async get(tabId) { return { id: tabId, url: 'about:blank', status: 'complete' }; } },
  };
  try {
    const player = new PlayerManager({}, {});
    player._sleep = async () => {};
    const context = { debuggerAttached: false, ignoreHttpsErrors: true };

    assert.equal(await player._attachDebugger(42, context), true);
    assert.equal(attachCount, 3);
    assert.equal(context.debuggerAttached, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('旧版 Chrome debugger 协议使用证书错误事件兜底', async () => {
  const originalChrome = globalThis.chrome;
  const commands = [];
  const listeners = [];
  let unsupported = true;
  globalThis.chrome = {
    debugger: {
      onEvent: {
        addListener(listener) { listeners.push(listener); },
        removeListener() {},
      },
      async attach() {},
      async detach() {},
      sendCommand(_target, method, params, callback) {
        commands.push({ method, params });
        if (unsupported && method === 'Security.setIgnoreCertificateErrors') {
          unsupported = false;
          globalThis.chrome.runtime.lastError = { message: "'Security.setIgnoreCertificateErrors' wasn't found" };
        }
        callback({});
        globalThis.chrome.runtime.lastError = null;
      },
    },
    runtime: { lastError: null },
  };
  try {
    const player = new PlayerManager({}, {});
    const context = { debuggerAttached: false, ignoreHttpsErrors: true };
    assert.equal(await player._attachDebugger(42, context), true);
    assert.deepEqual(commands.slice(0, 3), [
      { method: 'Security.setIgnoreCertificateErrors', params: { ignore: true } },
      { method: 'Security.setOverrideCertificateErrors', params: { override: true } },
      { method: 'Page.enable', params: {} },
    ]);
    assert.ok(listeners.length >= 1);
    for (const listener of listeners) {
      listener({ tabId: 42 }, 'Security.certificateError', { eventId: 7 });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(commands.at(-1), {
      method: 'Security.handleCertificateError',
      params: { eventId: 7, action: 'continue' },
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('Chrome debugger 不开放 Security 命令时快速失败并提示替代方案', async () => {
  const originalChrome = globalThis.chrome;
  const commands = [];
  let detachCount = 0;
  globalThis.chrome = {
    debugger: {
      onEvent: { addListener() {}, removeListener() {} },
      async attach() {},
      async detach() { detachCount += 1; },
      sendCommand(_target, method, params, callback) {
        commands.push({ method, params });
        if (['Security.setIgnoreCertificateErrors', 'Security.setOverrideCertificateErrors'].includes(method)) {
          globalThis.chrome.runtime.lastError = { message: `'${method}' wasn't found` };
        }
        callback({});
        globalThis.chrome.runtime.lastError = null;
      },
    },
    runtime: { lastError: null },
  };
  try {
    const player = new PlayerManager({}, {});
    const context = { debuggerAttached: false, ignoreHttpsErrors: true };
    assert.equal(await player._attachDebugger(42, context), false);
    assert.match(context.cdpAttachError, /当前 Chrome 不允许扩展忽略 HTTPS 证书错误/);
    assert.match(context.cdpAttachError, /Playwright Runner\/安装受信任证书/);
    assert.deepEqual(commands.map((item) => item.method), [
      'Security.setIgnoreCertificateErrors',
      'Security.setOverrideCertificateErrors',
    ]);
    assert.equal(detachCount, 1);
    assert.equal(context.debuggerAttached, false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('Admin batch rejects a case response without frozen config', () => {
  assert.throws(
    () => resolvePlaybackRuntimeConfig({ start_url: 'https://current.example' }, {
      batchId: 'BATCH_002',
      startUrl: 'https://client.example',
    }, true),
    /未返回 EffectiveExecutionConfig/,
  );
});

test('popup and test-lab playback retain legacy option compatibility', () => {
  const resolved = resolvePlaybackRuntimeConfig({
    start_url: 'https://case.example',
    window_size_mode: 'maximized',
  }, {
    startUrl: 'https://popup.example',
    viewportMode: 'current',
    pageErrorCheckEnabled: true,
  }, false);

  assert.equal(resolved.frozen, false);
  assert.equal(resolved.startUrl, 'https://popup.example');
  assert.equal(resolved.windowSizeMode, 'current');
  assert.equal(resolved.pageErrorCheckEnabled, true);
});

test('pure infrastructure batch skips browser bootstrap and rejects unknown modes', () => {
  const resolved = resolvePlaybackRuntimeConfig({
    effectiveExecutionConfig: {
      browser_bootstrap_mode: 'none',
      step_timeout_ms: 5000,
      case_timeout_ms: 60000,
    },
  }, { batchId: 'BATCH_INFRA' }, true);

  assert.equal(resolved.browserBootstrapMode, 'none');
  assert.deepEqual(resolvePlaybackBrowserBootstrap(resolved.browserBootstrapMode), {
    mode: 'none',
    initializeBrowser: false,
  });
  assert.throws(() => resolvePlaybackBrowserBootstrap('guess'), /不支持的 browser_bootstrap_mode/);
});

test('infrastructure task lifecycle carries execution capability only in headers', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = new ApiClient(() => 'http://admin.local', () => 'admin-token');
    const capability = 'execution-capability-token';
    await client.createInfrastructureTask({ caseKey: 'SCENE:CASE', stepId: 'STEP' }, capability);
    await client.getInfrastructureTask('TASK', 3, capability);
    await client.cancelInfrastructureTask('TASK', capability);

    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.options.headers['X-Execution-Capability'], capability);
      assert.equal(request.options.headers.Authorization, 'Bearer admin-token');
      assert.doesNotMatch(String(request.options.body || ''), /execution-capability-token/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pure infrastructure playback completes without creating a browser session', async () => {
  const originalChrome = globalThis.chrome;
  let windowCreateCount = 0;
  let scriptInjectionCount = 0;
  let debuggerAttachCount = 0;
  let savedResult;
  let createCapability;
  globalThis.chrome = {
    debugger: {
      onEvent: { addListener() {} },
      attach() { debuggerAttachCount += 1; return Promise.resolve(); },
    },
    notifications: { create() { return Promise.resolve(); } },
    runtime: {
      id: 'cuecast-test-extension',
      getManifest() { return { version: 'test' }; },
      sendMessage() { return Promise.resolve(); },
    },
    scripting: {
      executeScript() { scriptInjectionCount += 1; return Promise.resolve(); },
    },
    tabs: {
      query(_query, callback) {
        if (typeof callback === 'function') {
          callback([]);
          return undefined;
        }
        return Promise.resolve([]);
      },
      sendMessage() { return Promise.resolve(); },
      remove() { return Promise.resolve(); },
    },
    windows: {
      create() { windowCreateCount += 1; return Promise.reject(new Error('纯基础设施不应创建窗口')); },
    },
  };
  const api = {
    registerOperationCapabilities() { return Promise.resolve({}); },
    getAdminPlaywrightCase() {
      return Promise.resolve({
        data: {
          case_id: 'CASE_INFRA',
          name: '纯基础设施用例',
          project_environment_id: 9,
          effectiveExecutionConfig: {
            browser_bootstrap_mode: 'none',
            window_size_mode: 'maximized',
            page_error_check_enabled: false,
            screenshot_mode: 'standard',
            step_timeout_ms: 5000,
            case_timeout_ms: 60000,
            sources: { browser_bootstrap_mode: 'platform-policy' },
          },
          steps: [{ id: 'STEP_INFRA', action_type: 'server_command', description: '受控命令' }],
        },
      });
    },
    createInfrastructureTask(_payload, capability) {
      createCapability = capability;
      return Promise.resolve({
        data: {
          taskId: 'TASK_INFRA',
          status: 'passed',
          executor: 'infrastructure-service',
          result: { infrastructure: { schemaVersion: 2 }, variables: {} },
        },
      });
    },
    saveAdminPlaywrightResult(_caseKey, result) {
      savedResult = result;
      return Promise.resolve({});
    },
  };
  try {
    const player = new PlayerManager({ mode: 'idle', activePlayCount: 0, authToken: 'token' }, api);
    const result = await player.start('CASE_INFRA', '', {
      adminCaseKey: 'SCENE:CASE_INFRA',
      batchId: 'BATCH_INFRA',
      executionId: 'EXEC_INFRA',
      executionCapability: 'capability',
      projectEnvironmentId: 9,
      dataSource: 'admin',
    });

    assert.equal(result.ok, true);
    assert.equal(windowCreateCount, 0);
    assert.equal(scriptInjectionCount, 0);
    assert.equal(debuggerAttachCount, 0);
    assert.equal(createCapability, 'capability');
    assert.equal(savedResult.status, 'passed');
    assert.equal(savedResult.raw.detail.cdp_mode, false);
    assert.equal(savedResult.raw.execution_config.browser_bootstrap_mode, 'none');
  } finally {
    globalThis.chrome = originalChrome;
  }
});
