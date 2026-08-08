import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PlayerManager } from '../modules/player-manager.js';
import { RecorderManager } from '../modules/recorder-manager.js';

const projectFile = (relativePath) => new URL(`../${relativePath}`, import.meta.url);

function createChromeStub() {
  const createEvent = () => {
    const listeners = [];
    return {
      listeners,
      addListener(listener) { listeners.push(listener); },
      removeListener(listener) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
  };
  const createStorageArea = () => ({
    async get() { return {}; },
    async set() {},
    async remove() {},
  });
  const runtimeOnMessage = createEvent();
  return {
    runtimeOnMessage,
    chrome: {
      alarms: {
        create() {},
        async clear() { return true; },
        onAlarm: createEvent(),
      },
      debugger: { onEvent: createEvent() },
      notifications: { create() {} },
      runtime: {
        id: 'cuecast-test-extension',
        getManifest() { return { version: '1.2.0' }; },
        onInstalled: createEvent(),
        onMessage: runtimeOnMessage,
        async sendMessage() {},
      },
      scripting: {},
      storage: {
        local: createStorageArea(),
        session: createStorageArea(),
        onChanged: createEvent(),
      },
      tabs: {
        onActivated: createEvent(),
        onCreated: createEvent(),
        onRemoved: createEvent(),
        onUpdated: createEvent(),
        async get(tabId) {
          return { id: tabId, windowId: 3, url: 'https://example.test/end', status: 'complete' };
        },
        async query(_queryInfo, callback) {
          const tabs = [];
          if (callback) callback(tabs);
          return tabs;
        },
        async sendMessage() { return { ok: true }; },
        async update(tabId, changes) {
          return { id: tabId, windowId: 3, url: changes.url || 'https://example.test/end', status: 'complete' };
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: createEvent(),
        async update(windowId) { return { id: windowId }; },
      },
    },
  };
}

test('background service worker 可启动并响应插件检测 PING', async () => {
  const originalChrome = globalThis.chrome;
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  try {
    await import(`${projectFile('background.js').href}?ping-contract-test`);
    const listener = stub.runtimeOnMessage.listeners.at(-1);
    assert.equal(typeof listener, 'function');

    let response = null;
    const keepChannelOpen = listener(
      { type: 'AT_PLATFORM_PING', nonce: 'merge-contract' },
      {},
      (payload) => { response = payload; },
    );
    assert.equal(keepChannelOpen, false);
    assert.deepEqual(response, {
      ok: true,
      version: '1.2.0',
      nonce: 'merge-contract',
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('v1.2 合并后 bridge 与 background 保持录制协议对称', async () => {
  const [background, bridge] = await Promise.all([
    readFile(projectFile('background.js'), 'utf8'),
    readFile(projectFile('content/bridge.js'), 'utf8'),
  ]);
  const commands = [
    'AT_PLATFORM_RECORDING_DRAFT_STATUS',
    'AT_PLATFORM_RETRY_RECORDING',
    'AT_PLATFORM_SAVE_RECORDING_TRIMMED',
    'AT_PLATFORM_DISCARD_RECORDING_SAVE',
    'AT_PLATFORM_CHECK_SELECTOR',
  ];
  for (const command of commands) {
    assert.match(bridge, new RegExp(command));
    assert.match(background, new RegExp(`case '${command}'`));
  }
  assert.match(background, /recordingImport:\s*message\.recordingImport/);
  assert.match(background, /windowPreference,\s*\n\s*reuseTabId/);
  assert.match(background, /injectBridgeIntoOpenTabs\(\{ force: true \}\)/);
});

test('录制结束事件携带唯一 eventId，便于中台多实例去重', () => {
  const manager = new RecorderManager({}, {});
  let message = null;
  manager._broadcastToContentScripts = (payload) => { message = payload; };

  manager._broadcastRecordingEnd({ testCaseId: 'CASE-1', saved: true });

  assert.equal(message.type, 'AT_RECORDING_END');
  assert.match(message.eventId, /^recording_end_/);
});

test('Admin 录制始终使用专用导入 DTO 并保留 locator_meta', async () => {
  let importedPayload = null;
  const api = {
    base: 'http://admin.local/api',
    importRecording(payload) {
      importedPayload = payload;
      return Promise.resolve({ code: 0 });
    },
    saveSteps() {
      throw new Error('Admin 录制不应降级到 testcases 保存');
    },
  };
  const recordingImport = {
    enabled: true,
    mode: 'createScene',
    scene: { sceneId: 'SCENE-1', name: '录制场景' },
    caseName: '录制用例',
    startUrl: 'https://example.test/start',
    persistScreenshots: false,
    keepRawScreenshotInStep: false,
  };
  const manager = new RecorderManager({ recordingImport, recordingScreenshotMode: 'standard' }, api);
  const locatorMeta = {
    version: 1,
    candidates: [{ type: 'role', value: 'button', name: '提交' }],
  };

  await manager._saveRecordedSteps('REC-1', [{ action_type: 'click', locator_meta: locatorMeta }], recordingImport);

  assert.equal(importedPayload.mode, 'createScene');
  assert.equal(importedPayload.recordedCase.id, 'REC-1');
  assert.deepEqual(importedPayload.recordedCase.steps[0].locator_meta, locatorMeta);
  assert.equal(importedPayload.recordedCase.steps[0].id, 1);
  assert.equal(importedPayload.persistScreenshots, false);
});

test('普通 CueCast 录制继续使用 testcases 保存并生成顺序步骤 ID', async () => {
  let saved = null;
  const api = {
    base: 'http://cuecast.local/api',
    saveSteps(testCaseId, steps) {
      saved = { testCaseId, steps };
      return Promise.resolve({ code: 0 });
    },
    importRecording() {
      throw new Error('普通录制不应调用 Admin 导入');
    },
  };
  const manager = new RecorderManager({ recordingImport: null, recordingScreenshotMode: 'standard' }, api);

  await manager._saveRecordedSteps('CASE-1', [
    { id: 99, action_type: 'click' },
    { id: 101, action_type: 'input', value: 'value' },
  ], null);

  assert.equal(saved.testCaseId, 'CASE-1');
  assert.deepEqual(saved.steps.map((step) => step.id), [1, 2]);
});

test('Admin 录制启动和停止不会访问官方 testcase 接口', async () => {
  const originalChrome = globalThis.chrome;
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  try {
    let getTestCaseCalls = 0;
    let importedPayload = null;
    const api = {
      base: 'http://admin.local/api',
      async getTestCase() {
        getTestCaseCalls += 1;
        throw new Error('Admin 录制不应读取官方 testcase');
      },
      async importRecording(payload) { importedPayload = payload; },
    };
    const state = { mode: 'idle', activePlayCount: 0 };
    const manager = new RecorderManager(state, api);
    manager._waitForTabLoad = async () => {};
    manager._reinjectRecorder = async () => {};
    manager._broadcastRecordingLive = () => {};
    manager._broadcastRecordingEnd = () => {};
    manager._broadcastStopAck = () => {};
    manager._notifyPopup = () => {};
    manager._showNotification = () => {};
    const recordingImport = {
      enabled: true,
      mode: 'createScene',
      scene: { sceneId: 'SCENE-2', name: '新场景' },
      screenshotMode: 'standard',
    };

    const started = await manager.start('REC-2', 'https://example.test/start', null, {
      recordingImport,
      screenshotMode: 'standard',
      reuseTabId: 7,
    });
    state.recordedSteps = [{ action_type: 'click', locator_meta: { version: 1 } }];
    const stopped = await manager.stop(7);

    assert.equal(started.ok, true);
    assert.equal(stopped.ok, true);
    assert.equal(getTestCaseCalls, 0);
    assert.equal(importedPayload.mode, 'createScene');
    assert.equal(importedPayload.recordedCase.end_url, 'https://example.test/end');
    assert.deepEqual(importedPayload.recordedCase.steps[0].locator_meta, { version: 1 });
    assert.equal(state.mode, 'idle');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('PlayerManager 在 ESM 测试环境中可加载', () => {
  assert.equal(typeof PlayerManager, 'function');
});

test('PlayerManager 预检失败仍广播带错误的结束事件', async () => {
  const originalChrome = globalThis.chrome;
  const stub = createChromeStub();
  globalThis.chrome = stub.chrome;
  try {
    const events = [];
    const manager = new PlayerManager(
      { mode: 'idle', activePlayCount: 0 },
      { async getTestCase() { return { data: { steps: [] } }; } },
    );
    manager._broadcastPlayback = (payload) => events.push(payload);
    manager._showNotification = () => {};

    const result = await manager.start('EMPTY-CASE', null);

    assert.equal(result.ok, false);
    assert.match(result.error, /用例没有步骤/);
    const endEvent = events.find((event) => event.type === 'AT_PLAYBACK_END');
    assert.equal(endEvent.ok, false);
    assert.match(endEvent.error, /用例没有步骤/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
