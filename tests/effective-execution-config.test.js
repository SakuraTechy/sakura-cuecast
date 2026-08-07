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
  assert.equal(resolved.viewportWidth, 1440);
  assert.equal(resolved.viewportHeight, 900);
  assert.equal(resolved.pageErrorCheckEnabled, false);
  assert.equal(resolved.screenshotMode, 'full_hd');
  assert.equal(resolved.stepTimeoutMs, 4200);
  assert.equal(resolved.caseTimeoutMs, 180000);
  assert.deepEqual(resolved.executionConfig, effectiveExecutionConfig);
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
