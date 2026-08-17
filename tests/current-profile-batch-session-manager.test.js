import assert from 'node:assert/strict';
import test from 'node:test';

import { CurrentProfileBatchSessionManager } from '../modules/current-profile-batch-session-manager.js';

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
  const tabs = new Map([
    [1, { id: 1, windowId: 10, url: 'https://admin.example/scenes', status: 'complete', incognito: false }],
  ]);
  const windows = new Map([
    [10, { id: 10, incognito: false }],
  ]);
  const removedTabIds = [];
  const createdTabs = [];
  const createdWindows = [];
  const removedWindows = [];
  const storage = createStorageArea();
  let tabSequence = 1;
  const chrome = {
    storage: { session: storage },
    windows: {
      async get(windowId) {
        const win = windows.get(Number(windowId));
        if (!win) throw new Error(`window missing: ${windowId}`);
        return { ...win };
      },
      async create(createData) {
        const windowId = 10 + createdWindows.length + 1;
        const tab = {
          id: ++tabSequence,
          windowId,
          url: String(createData.url),
          status: 'complete',
          active: true,
          incognito: false,
        };
        windows.set(windowId, { id: windowId, incognito: false });
        tabs.set(tab.id, tab);
        createdTabs.push({ ...tab });
        createdWindows.push({ id: windowId, ...createData, tabs: [{ ...tab }] });
        return { id: windowId, incognito: false, tabs: [{ ...tab }] };
      },
      async remove(windowId) {
        removedWindows.push(Number(windowId));
        windows.delete(Number(windowId));
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error(`tab missing: ${tabId}`);
        return { ...tab };
      },
      async remove(tabId) {
        removedTabIds.push(Number(tabId));
        tabs.delete(Number(tabId));
      },
    },
  };
  return {
    manager: new CurrentProfileBatchSessionManager(chrome),
    tabs,
    windows,
    storage,
    removedTabIds,
    createdTabs,
    createdWindows,
    removedWindows,
  };
}

async function begin(manager) {
  return manager.beginBatch({
    batchId: 'batch-legacy',
    sessionMode: 'legacy-profile',
    browserSessionSource: 'current-profile',
    sourceTabId: 1,
    executionCapability: EXECUTION_CAPABILITY,
  });
}

test('当前 Profile 批次创建普通浏览器窗口并连续复用', async () => {
  const harness = createHarness();
  await begin(harness.manager);

  const first = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    sessionMode: 'legacy-profile',
    browserSessionSource: 'current-profile',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.tabs.get(first.tabId).url = 'https://app.example/home';
  await harness.manager.finalizeCase({
    batchId: 'batch-legacy',
    success: true,
    finalActiveTabId: first.tabId,
    managedTabIds: [first.tabId],
    finalUrl: 'https://app.example/home',
  });
  const second = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    sessionMode: 'legacy-profile',
    browserSessionSource: 'current-profile',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  assert.equal(harness.createdTabs.length, 1);
  assert.equal(first.tabId, second.tabId);
  assert.equal(second.skipInitialNavigation, true);
  assert.notEqual(harness.createdTabs[0].windowId, 10);
  assert.equal(harness.createdTabs[0].incognito, false);

  await harness.manager.endBatch('batch-legacy', EXECUTION_CAPABILITY);
  assert.deepEqual(harness.removedTabIds, [first.tabId]);
  assert.equal(harness.tabs.has(1), true);
});

test('忽略 HTTPS 证书错误时先创建空白页并交给 Player 导航', async () => {
  const harness = createHarness();
  await begin(harness.manager);

  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://self-signed.example/login',
    ignoreHttpsErrors: true,
  });

  assert.equal(harness.createdWindows[0].url, 'about:blank');
  assert.equal(prepared.skipInitialNavigation, false);
  assert.equal(prepared.navigationUrl, 'https://self-signed.example/login');
});

test('当前 Profile 用例失败后只重建普通回放窗口', async () => {
  const harness = createHarness();
  await begin(harness.manager);
  const first = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  const transition = await harness.manager.finalizeCase({
    batchId: 'batch-legacy',
    success: false,
    finalActiveTabId: first.tabId,
    managedTabIds: [first.tabId],
  });
  const second = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });

  assert.equal(transition.reset, true);
  assert.equal(transition.resetReason, 'case-failed-or-cancelled');
  assert.notEqual(second.tabId, first.tabId);
  assert.deepEqual(harness.removedTabIds, [first.tabId]);
  assert.equal(harness.tabs.has(1), true);
  assert.equal(harness.createdTabs.every((tab) => tab.windowId !== 10 && tab.incognito === false), true);

  await harness.manager.abortBatch('batch-legacy', EXECUTION_CAPABILITY);
});

test('当前 Profile 批次拒绝从无痕 Admin 页面启动', async () => {
  const harness = createHarness();
  harness.tabs.set(1, {
    id: 1,
    windowId: 20,
    url: 'https://admin.example/scenes',
    status: 'complete',
    incognito: true,
  });
  harness.windows.set(20, { id: 20, incognito: true });

  await assert.rejects(
    () => begin(harness.manager),
    (error) => error.code === 'CDP_CURRENT_PROFILE_SOURCE_INVALID',
  );
});

test('Service Worker 重启后只清理持久化的回放标签页', async () => {
  const harness = createHarness();
  await begin(harness.manager);
  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  const recovered = new CurrentProfileBatchSessionManager(harness.manager.chrome);

  const result = await recovered.recoverOrCleanup();

  assert.equal(result.cleaned, true);
  assert.deepEqual(harness.removedTabIds, [prepared.tabId]);
  assert.equal(harness.tabs.has(1), true);
});

test('Service Worker 恢复时不关闭无法通过窗口归属证明的普通标签页', async () => {
  const harness = createHarness();
  await begin(harness.manager);
  const prepared = await harness.manager.prepareCase({
    batchId: 'batch-legacy',
    executionCapability: EXECUTION_CAPABILITY,
    startUrl: 'https://app.example/login',
  });
  harness.tabs.get(prepared.tabId).windowId = 99;
  const recovered = new CurrentProfileBatchSessionManager(harness.manager.chrome);

  const result = await recovered.recoverOrCleanup();

  assert.equal(result.cleaned, true);
  assert.deepEqual(harness.removedTabIds, []);
  assert.equal(harness.tabs.has(prepared.tabId), true);
});
