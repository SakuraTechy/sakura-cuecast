import assert from 'node:assert/strict';
import test from 'node:test';

import { CdpBatchSessionManager } from '../modules/cdp-batch-session-manager.js';

const EXECUTION_CAPABILITY = 'short-lived-capability';

function createStorageArea() {
  const values = {};
  return {
    values,
    async get(keys) {
      if (keys == null) return { ...values };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(entries) { Object.assign(values, entries); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function createHarness() {
  const tabs = new Map([[1, { id: 1, url: 'https://admin.example/scenes', status: 'complete', windowId: 1 }]]);
  const storage = createStorageArea();
  const events = { addListener() {} };
  const chrome = {
    runtime: { getManifest: () => ({ version: 'test-version' }) },
    debugger: { onEvent: events },
    storage: { session: storage },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error(`tab missing: ${tabId}`);
        return { ...tab };
      },
      async query() { return [...tabs.values()].map((tab) => ({ ...tab })); },
    },
  };
  let contextSequence = 0;
  let targetSequence = 0;
  const contexts = new Map();
  const disposed = [];
  const drivers = [];
  const failureState = { disposeCount: 0 };
  let probeCount = 0;
  class FakeDriver {
    constructor() {
      this.connected = false;
      drivers.push(this);
    }

    async probe() {
      probeCount += 1;
      return {
        ok: true,
        managedBrowserContext: true,
        supportedSessionModes: ['isolated', 'reuse-auth', 'reuse-browser'],
      };
    }

    async connect() { this.connected = true; }

    setManagedTargetObserver(observer) { this.managedTargetObserver = observer; }

    async createBrowserContext() {
      const id = `context-${++contextSequence}`;
      contexts.set(id, new Set());
      return id;
    }

    async createTarget(contextId, url) {
      const tabId = 100 + ++targetSequence;
      const targetId = `target-${targetSequence}`;
      tabs.set(tabId, { id: tabId, url, status: 'complete', windowId: tabId });
      contexts.get(contextId).add(tabId);
      await this.managedTargetObserver?.({ ...tabs.get(tabId), incognito: true });
      return { targetId, tab: { ...tabs.get(tabId) } };
    }

    async assertNoForeignIncognitoWindows() {}

    async navigateTab(tabId, url) {
      const tab = tabs.get(tabId);
      tab.url = url;
      return { ...tab };
    }

    async disposeBrowserContext(contextId) {
      if (failureState.disposeCount > 0) {
        failureState.disposeCount -= 1;
        const error = new Error('forced cleanup failure');
        error.code = 'CDP_SESSION_CLEANUP_FAILED';
        throw error;
      }
      disposed.push(contextId);
      for (const tabId of contexts.get(contextId) || []) tabs.delete(tabId);
      contexts.delete(contextId);
    }

    async cleanup() {
      for (const contextId of [...contexts.keys()]) await this.disposeBrowserContext(contextId);
      this.connected = false;
    }

    async cleanupRecoveredSession(metadata) {
      for (const contextId of new Set([
        metadata.caseContextId,
        metadata.browserContextId,
      ].filter(Boolean))) {
        await this.disposeBrowserContext(contextId);
      }
    }

    async disconnect() { this.connected = false; }
  }
  const captures = [];
  const restores = [];
  const authState = {
    async capture(options) {
      const snapshot = {
        version: 1,
        marker: `snapshot-${captures.length + 1}`,
        lastUrl: options.lastUrl,
        cookies: [],
        origins: [],
      };
      captures.push({ options, snapshot });
      return snapshot;
    },
    async restore(options) { restores.push(options.snapshot); },
  };
  const manager = new CdpBatchSessionManager(chrome, {
    driverFactory: () => new FakeDriver(),
    authState,
  });
  manager.cachedCapabilities = {
    ok: true,
    managedBrowserContext: true,
    supportedSessionModes: ['isolated', 'reuse-auth', 'reuse-browser'],
  };
  return {
    manager,
    tabs,
    storage,
    disposed,
    drivers,
    captures,
    restores,
    failureState,
    get probeCount() { return probeCount; },
  };
}

async function begin(manager, mode) {
  return manager.beginBatch({
    batchId: `batch-${mode}`,
    sessionMode: mode,
    browserSessionSource: 'managed-context',
    sourceTabId: 1,
    sourceUrl: 'https://admin.example/scenes',
    executionCapability: EXECUTION_CAPABILITY,
  });
}

test('isolated 每条用例创建并销毁独立受控会话', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');

  const first = await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  await harness.manager.finalizeCase({
    batchId: 'batch-isolated',
    success: true,
    finalActiveTabId: first.tabId,
    managedTabIds: [first.tabId],
    finalUrl: 'https://app.example/home',
  });
  const second = await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  assert.notEqual(first.tabId, second.tabId);
  assert.deepEqual(harness.disposed, ['context-1']);
  await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY);
  assert.deepEqual(harness.disposed, ['context-1', 'context-2']);
});

test('受控会话忽略 HTTPS 证书错误时先创建空白页', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');

  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://self-signed.example/login',
    ignoreHttpsErrors: true,
  });

  assert.equal(harness.tabs.get(prepared.tabId).url, 'about:blank');
  assert.equal(prepared.skipInitialNavigation, false);
  assert.equal(prepared.navigationUrl, 'https://self-signed.example/login');
});

test('reuse-auth 只恢复上一条成功用例原子提交的快照', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'reuse-auth');

  const first = await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-auth',
    success: true,
    finalActiveTabId: first.tabId,
    managedTabIds: [first.tabId],
    finalUrl: 'https://app.example/home',
  });
  const second = await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  assert.equal(harness.restores[0].marker, 'snapshot-1');
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-auth',
    success: false,
    finalActiveTabId: second.tabId,
    managedTabIds: [second.tabId],
    finalUrl: 'https://app.example/broken',
  });
  await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  assert.equal(harness.captures.length, 1);
  assert.deepEqual(harness.restores.map((item) => item.marker), ['snapshot-1', 'snapshot-1']);
  await harness.manager.abortBatch('batch-reuse-auth', EXECUTION_CAPABILITY);
});

test('reuse-auth 将成功注销后的空认证状态传播给下一条用例', async () => {
  const harness = createHarness();
  harness.manager.authState.capture = async ({ lastUrl }) => ({
    version: 1,
    marker: lastUrl.endsWith('/logged-out') ? 'logged-out' : 'logged-in',
    lastUrl,
    cookies: lastUrl.endsWith('/logged-out') ? [] : [{ name: 'sid', value: 'active' }],
    origins: [],
  });
  await begin(harness.manager, 'reuse-auth');

  const first = await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-auth',
    success: true,
    finalActiveTabId: first.tabId,
    managedTabIds: [first.tabId],
    finalUrl: 'https://app.example/home',
  });
  const second = await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/logout',
  });
  assert.equal(harness.restores.at(-1).marker, 'logged-in');
  harness.tabs.get(second.tabId).url = 'https://app.example/logged-out';
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-auth',
    success: true,
    finalActiveTabId: second.tabId,
    managedTabIds: [second.tabId],
    finalUrl: 'https://app.example/logged-out',
  });
  await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  assert.equal(harness.restores.at(-1).marker, 'logged-out');
  assert.deepEqual(harness.restores.at(-1).cookies, []);
  await harness.manager.abortBatch('batch-reuse-auth', EXECUTION_CAPABILITY);
});

test('reuse-browser 成功复用最终活动页，失败后整会话重建', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'reuse-browser');

  const first = await harness.manager.prepareCase({
    batchId: 'batch-reuse-browser',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.tabs.get(first.tabId).url = 'https://app.example/home';
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-browser',
    success: true,
    finalActiveTabId: first.tabId,
    managedTabIds: [first.tabId],
    finalUrl: 'https://app.example/home',
  });
  const second = await harness.manager.prepareCase({
    batchId: 'batch-reuse-browser',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  assert.equal(second.tabId, first.tabId);
  assert.equal(second.skipInitialNavigation, true);
  const failedTransition = await harness.manager.finalizeCase({
    batchId: 'batch-reuse-browser',
    success: false,
    finalActiveTabId: second.tabId,
    managedTabIds: [second.tabId],
    finalUrl: 'https://app.example/error',
    navigationDecision: second.sessionTransition,
  });
  const third = await harness.manager.prepareCase({
    batchId: 'batch-reuse-browser',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  assert.equal(failedTransition.reset, true);
  assert.equal(failedTransition.resetCount, 1);
  assert.equal(failedTransition.resetReason, 'case-failed-or-cancelled');
  assert.equal(failedTransition.navigationDecision, 'reused-browser-page');
  assert.notEqual(third.tabId, first.tabId);
  await harness.manager.abortBatch('batch-reuse-browser', EXECUTION_CAPABILITY);
});

test('批次内 sessionMode 不一致时拒绝执行', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');

  await assert.rejects(() => harness.manager.prepareCase({
    batchId: 'batch-isolated',
    sessionMode: 'reuse-browser',
    browserSessionSource: 'managed-context',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  }), /sessionMode 不匹配/);
  await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY);
});

test('弹窗导航通过 opener 链纳入 reuse-auth 成功快照来源', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'reuse-auth');
  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-reuse-auth',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.tabs.set(222, {
    id: 222,
    url: 'https://account.example/callback',
    status: 'complete',
    windowId: 222,
    openerTabId: prepared.tabId,
  });

  await harness.manager.trackManagedNavigation(
    { tabId: 222 },
    { frame: { url: 'https://account.example/callback' } },
  );
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-auth',
    success: true,
    finalActiveTabId: 222,
    managedTabIds: [prepared.tabId, 222],
    finalUrl: 'https://account.example/callback',
  });

  assert.ok(harness.captures[0].options.origins.includes('https://account.example'));
  await harness.manager.abortBatch('batch-reuse-auth', EXECUTION_CAPABILITY);
});

test('END/ABORT 幂等且清理失败保留批次供重试', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');
  await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.failureState.disposeCount = 1;

  await assert.rejects(
    () => harness.manager.endBatch('batch-isolated', EXECUTION_CAPABILITY),
    (error) => error.code === 'CDP_SESSION_CLEANUP_FAILED',
  );
  assert.equal(harness.manager.batch.state, 'cleanup-failed');
  assert.ok(harness.storage.values.cuecastCdpBatchSession);

  const aborted = await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY);
  assert.equal(aborted.state, 'aborted');
  assert.equal(harness.storage.values.cuecastCdpBatchSession, undefined);
  assert.equal((await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY)).state, 'closed');
  assert.equal((await harness.manager.endBatch('batch-isolated', EXECUTION_CAPABILITY)).state, 'closed');
});

test('同 batchId 的 BEGIN/PLAY 必须使用相同 executionCapability', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');

  await assert.rejects(() => harness.manager.beginBatch({
    batchId: 'batch-isolated',
    sessionMode: 'isolated',
    browserSessionSource: 'managed-context',
    sourceTabId: 1,
    executionCapability: 'different-capability',
  }), (error) => error.code === 'CDP_EXECUTION_CAPABILITY_MISMATCH');
  await assert.rejects(() => harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: 'different-capability',
    startUrl: 'https://app.example/login',
  }), (error) => error.code === 'CDP_EXECUTION_CAPABILITY_MISMATCH');

  await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY);
});

test('reuse-browser 最终活动页丢失时失败并重置会话', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'reuse-browser');
  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-reuse-browser',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.tabs.delete(prepared.tabId);

  await assert.rejects(() => harness.manager.finalizeCase({
    batchId: 'batch-reuse-browser',
    success: true,
    finalActiveTabId: prepared.tabId,
    managedTabIds: [prepared.tabId],
    navigationDecision: prepared.sessionTransition,
    browserSessionPrepared: true,
  }), (error) => {
    assert.equal(error.code, 'CDP_SESSION_TARGET_LOST');
    assert.equal(error.sessionTransition.reset, true);
    assert.equal(error.sessionTransition.resetReason, 'active-target-lost');
    return true;
  });
  assert.deepEqual(harness.disposed, ['context-1']);
  await harness.manager.abortBatch('batch-reuse-browser', EXECUTION_CAPABILITY);
});

test('Service Worker 无清理锚点时仍按持久化窗口契约清理遗留会话', async () => {
  const harness = createHarness();
  harness.tabs.clear();
  await harness.storage.set({
    cuecastCdpBatchSession: {
      batchId: 'stale-batch',
      browserContextId: 'stale-context',
      updatedAt: Date.now(),
    },
    cuecastCdpBatchAuthSnapshot: { version: 1, cookies: [] },
  });

  const result = await harness.manager.recoverOrCleanup();

  assert.equal(result.ok, true);
  assert.equal(result.cleaned, true);
  assert.deepEqual(harness.disposed, ['stale-context']);
  assert.equal(harness.storage.values.cuecastCdpBatchSession, undefined);
  assert.equal(harness.storage.values.cuecastCdpBatchAuthSnapshot, undefined);
});

test('Service Worker 重启后的 END 先校验执行能力再清理遗留会话', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');
  await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.manager.batch = null;
  harness.manager.driver = null;

  await assert.rejects(
    () => harness.manager.endBatch('batch-isolated', 'wrong-capability', 1),
    (error) => error.code === 'CDP_EXECUTION_CAPABILITY_MISMATCH',
  );
  assert.ok(harness.storage.values.cuecastCdpBatchSession);

  const ended = await harness.manager.endBatch('batch-isolated', EXECUTION_CAPABILITY, 1);
  assert.equal(ended.state, 'closed');
  assert.deepEqual(harness.disposed, ['context-1']);
  assert.equal(harness.storage.values.cuecastCdpBatchSession, undefined);
});

test('批次中出现非受控无痕窗口后阻断 reuse-browser 快速复用', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'reuse-browser');
  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-reuse-browser',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  await harness.manager.finalizeCase({
    batchId: 'batch-reuse-browser',
    success: true,
    finalActiveTabId: prepared.tabId,
    managedTabIds: [prepared.tabId],
    finalUrl: 'https://app.example/home',
  });

  await harness.manager.trackManagedTabCreated({
    id: 999,
    windowId: 999,
    incognito: true,
  });

  await assert.rejects(() => harness.manager.prepareCase({
    batchId: 'batch-reuse-browser',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  }), (error) => error.code === 'CDP_INCOGNITO_SESSION_CONTAMINATED');
  assert.equal(harness.storage.values.cuecastCdpBatchSession.contaminated, true);
  await harness.manager.abortBatch('batch-reuse-browser', EXECUTION_CAPABILITY);
});

test('preparing 阶段先到达的受控 tab 事件在窗口登记后不误判污染', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');
  harness.manager.batch.state = 'preparing';
  harness.tabs.set(777, {
    id: 777,
    windowId: 777,
    url: 'https://app.example/login',
    status: 'complete',
    incognito: true,
  });
  await harness.manager.trackManagedTabCreated(harness.tabs.get(777));
  assert.equal(harness.manager.batch.contaminated, false);

  harness.manager.batch.managedWindowIds.add(777);
  await harness.manager.reconcilePendingIncognitoTabs();

  assert.equal(harness.manager.batch.contaminated, false);
  assert.equal(harness.manager.batch.managedTabIds.has(777), true);
  await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY);
});

test('受控窗口创建回调在 prepareCase 返回前持久化恢复归属', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');

  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  const metadata = harness.storage.values.cuecastCdpBatchSession;
  assert.ok(metadata.managedTabIds.includes(prepared.tabId));
  assert.ok(metadata.managedWindowIds.includes(prepared.tabId));
  await harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY);
});

test('并发能力探测共享一次真实探测并持久化结果', async () => {
  const harness = createHarness();
  harness.manager.cachedCapabilities = null;

  const [first, second] = await Promise.all([
    harness.manager.probeCapabilities(1, 'https://admin.example/scenes'),
    harness.manager.probeCapabilities(1, 'https://admin.example/scenes'),
  ]);

  assert.equal(harness.probeCount, 1);
  assert.deepEqual(first, second);
  assert.equal(harness.storage.values.cuecastCdpCapabilities.result.managedBrowserContext, true);
});

test('并发 END 和 ABORT 共享同一次批次清理', async () => {
  const harness = createHarness();
  await begin(harness.manager, 'isolated');
  await harness.manager.prepareCase({
    batchId: 'batch-isolated',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  await Promise.all([
    harness.manager.endBatch('batch-isolated', EXECUTION_CAPABILITY),
    harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY),
  ]);

  assert.deepEqual(harness.disposed, ['context-1']);
  assert.equal(harness.storage.values.cuecastCdpBatchSession, undefined);
});
