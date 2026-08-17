import assert from 'node:assert/strict';
import test from 'node:test';

import { CdpBrowserContextDriver } from '../modules/cdp-browser-context-driver.js';

function createHarness({
  leakState = false,
  failRemove = false,
  incognitoAllowed = true,
  foreignIncognito = false,
  detachCookieOnce = false,
} = {}) {
  const commands = [];
  const removedWindows = [];
  const windows = new Map([[1, { id: 1, incognito: false, type: 'normal' }]]);
  const tabs = new Map([[1, {
    id: 1,
    status: 'complete',
    url: 'https://admin.example/scenes',
    windowId: 1,
    incognito: false,
  }]]);
  if (foreignIncognito) windows.set(9, { id: 9, incognito: true, type: 'normal' });
  let windowSequence = 10;
  let tabSequence = 100;
  let persistedState = false;
  let probeCookieName = '';
  let restoredCookie = false;
  let cookieDetached = false;
  const eventListeners = new Set();
  const downloadCreatedListeners = new Set();
  const downloadChangedListeners = new Set();
  const cancelledDownloads = [];
  const downloads = new Map();

  const chrome = {
    downloads: {
      onCreated: {
        addListener(listener) { downloadCreatedListeners.add(listener); },
        removeListener(listener) { downloadCreatedListeners.delete(listener); },
      },
      onChanged: {
        addListener(listener) { downloadChangedListeners.add(listener); },
        removeListener(listener) { downloadChangedListeners.delete(listener); },
      },
      async cancel(downloadId) { cancelledDownloads.push(downloadId); downloads.delete(downloadId); },
      async search() { return [...downloads.values()].map((item) => ({ ...item })); },
    },
    extension: {
      async isAllowedIncognitoAccess() { return incognitoAllowed; },
    },
    windows: {
      async getAll() { return [...windows.values()].map((window) => ({ ...window })); },
      async get(windowId) {
        const window = windows.get(Number(windowId));
        if (!window) throw new Error(`window missing: ${windowId}`);
        return { ...window };
      },
      async create(options) {
        commands.push({ method: 'windows.create', params: options });
        const windowId = ++windowSequence;
        const tabId = ++tabSequence;
        const window = { id: windowId, incognito: true, type: 'normal' };
        const tab = {
          id: tabId,
          status: 'complete',
          url: options.url,
          windowId,
          incognito: true,
        };
        windows.set(windowId, window);
        tabs.set(tabId, tab);
        return { ...window, tabs: [{ ...tab }] };
      },
      async remove(windowId) {
        if (failRemove) throw new Error('forced remove failure');
        const normalized = Number(windowId);
        windows.delete(normalized);
        for (const [tabId, tab] of tabs) {
          if (tab.windowId === normalized) tabs.delete(tabId);
        }
        removedWindows.push(normalized);
        if (![...windows.values()].some((window) => window.incognito)) persistedState = false;
      },
    },
    debugger: {
      onEvent: {
        addListener(listener) { eventListeners.add(listener); },
        removeListener(listener) { eventListeners.delete(listener); },
      },
      async attach(debuggee, version) { commands.push({ debuggee, method: 'attach', params: { version } }); },
      async detach(debuggee) { commands.push({ debuggee, method: 'detach' }); },
      async sendCommand(debuggee, method, params = {}) {
        commands.push({ debuggee, method, params });
        if (method === 'Page.navigate') {
          const tab = tabs.get(debuggee.tabId);
          tab.url = params.url;
          tab.status = 'loading';
          queueMicrotask(() => {
            for (const listener of eventListeners) {
              listener(debuggee, 'Fetch.requestPaused', { requestId: `request-${debuggee.tabId}` });
            }
          });
          return { frameId: `frame-${debuggee.tabId}` };
        }
        if (method === 'Fetch.fulfillRequest') {
          tabs.get(debuggee.tabId).status = 'complete';
          return {};
        }
        if (method === 'Network.getCookies') {
          if (detachCookieOnce && !cookieDetached) {
            cookieDetached = true;
            throw new Error('Detached while handling command.');
          }
          return { cookies: [{
            name: probeCookieName || 'sid',
            value: 'value',
            domain: 'admin.example',
            path: '/',
          }] };
        }
        if (method === 'Network.setCookies') {
          restoredCookie = params.cookies?.[0]?.name === probeCookieName;
          return {};
        }
        return {};
      },
    },
    tabs: {
      async get(tabId) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error(`tab missing: ${tabId}`);
        return { ...tab };
      },
      async query({ windowId } = {}) {
        return [...tabs.values()]
          .filter((tab) => windowId == null || tab.windowId === windowId)
          .map((tab) => ({ ...tab }));
      },
      async create(options) {
        const tab = {
          id: ++tabSequence,
          status: 'complete',
          url: options.url,
          windowId: options.windowId,
          incognito: true,
        };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId, options) {
        const tab = tabs.get(Number(tabId));
        Object.assign(tab, options, { status: 'complete' });
        return { ...tab };
      },
      async remove(tabId) { tabs.delete(Number(tabId)); },
    },
    scripting: {
      async executeScript(options) {
        if (options.files) return [];
        if (String(options.func).includes('localStorage.setItem')) {
          persistedState = true;
          probeCookieName = options.args[0];
          return [{ result: { clicked: true } }];
        }
        if (String(options.func).includes('document.cookie.includes')
          && !String(options.func).includes('indexedDB.databases')) {
          return [{ result: restoredCookie }];
        }
        const leaked = leakState || persistedState;
        return [{ result: leaked
          ? { localStorage: 'local', sessionStorage: null, cookie: false, indexedDB: false }
          : { localStorage: null, sessionStorage: null, cookie: false, indexedDB: false } }];
      },
    },
  };
  return {
    chrome,
    commands,
    removedWindows,
    windows,
    tabs,
    cancelledDownloads,
    emitDownloadCreated(item) {
      downloads.set(item.id, item);
      for (const listener of downloadCreatedListeners) listener(item);
    },
    emitDownloadChanged(delta) {
      for (const listener of downloadChangedListeners) listener(delta);
    },
  };
}

test('未开启无痕访问时返回可操作的能力门禁原因', async () => {
  const harness = createHarness({ incognitoAllowed: false });
  const driver = new CdpBrowserContextDriver(harness.chrome);

  const result = await driver.probe(1, 'https://admin.example/scenes');

  assert.equal(result.managedBrowserContext, false);
  assert.equal(result.errorCode, 'CDP_INCOGNITO_ACCESS_REQUIRED');
  assert.match(result.reason, /允许在无痕模式下运行/);
  assert.equal(harness.commands.length, 0);
});

test('存在用户无痕窗口时拒绝能力探测且不关闭用户窗口', async () => {
  const harness = createHarness({ foreignIncognito: true });
  const driver = new CdpBrowserContextDriver(harness.chrome);

  const result = await driver.probe(1, 'https://admin.example/scenes');

  assert.equal(result.managedBrowserContext, false);
  assert.equal(result.errorCode, 'CDP_INCOGNITO_SESSION_CONFLICT');
  assert.match(result.reason, /用户已打开无痕窗口/);
  assert.equal(harness.windows.has(9), true);
  assert.deepEqual(harness.removedWindows, []);
});

test('能力探测通过两个顺序无痕会话验证状态销毁', async () => {
  const harness = createHarness();
  const driver = new CdpBrowserContextDriver(harness.chrome);

  const result = await driver.probe(1, 'https://admin.example/scenes');

  assert.equal(result.managedBrowserContext, true);
  assert.equal(result.managedSessionStrategy, 'exclusive-incognito');
  assert.deepEqual(result.supportedSessionModes, ['isolated', 'reuse-auth', 'reuse-browser']);
  assert.equal(harness.removedWindows.length, 2);
  assert.equal(harness.commands.some((item) => item.method === 'Target.attachToBrowserTarget'), false);
  assert.equal(harness.commands.some((item) => item.method === 'Target.createBrowserContext'), false);
});

test('探测到跨无痕会话状态泄漏时只上报 legacy-profile 并完成清理', async () => {
  const harness = createHarness({ leakState: true });
  const driver = new CdpBrowserContextDriver(harness.chrome);

  const result = await driver.probe(1, 'https://admin.example/scenes');

  assert.equal(result.managedBrowserContext, false);
  assert.deepEqual(result.supportedSessionModes, ['legacy-profile']);
  assert.match(result.reason, /状态泄漏/);
  assert.equal(harness.removedWindows.length, 2);
});

test('能力探测窗口清理失败时不开放正式会话模式', async () => {
  const harness = createHarness({ failRemove: true });
  const driver = new CdpBrowserContextDriver(harness.chrome);

  const result = await driver.probe(1, 'https://admin.example/scenes');

  assert.equal(result.managedBrowserContext, false);
  assert.equal(result.errorCode, 'CDP_SESSION_CLEANUP_FAILED');
  assert.deepEqual(result.supportedSessionModes, ['legacy-profile']);
});

test('认证状态 Cookie 命令只路由到受控无痕页签 CDP', async () => {
  const harness = createHarness();
  const driver = new CdpBrowserContextDriver(harness.chrome);
  await driver.connect(1);
  const contextId = await driver.createBrowserContext();
  await driver.createTarget(contextId, 'https://app.example');

  const result = await driver.sendBrowserCommand('Storage.getCookies', { browserContextId: contextId });

  assert.equal(result.cookies[0].name, 'sid');
  assert.ok(harness.commands.some((item) => item.method === 'Network.getCookies'));
  assert.ok(harness.commands.some((item) => item.method === 'detach'));
  await driver.disposeBrowserContext(contextId);
});

test('认证状态 Cookie 命令瞬时 detach 时重新附加并重试一次', async () => {
  const harness = createHarness({ detachCookieOnce: true });
  const driver = new CdpBrowserContextDriver(harness.chrome);
  await driver.connect(1);
  const contextId = await driver.createBrowserContext();
  await driver.createTarget(contextId, 'https://app.example');

  const result = await driver.sendBrowserCommand('Storage.getCookies', {
    browserContextId: contextId,
    urls: ['https://app.example/home'],
  });

  assert.equal(result.cookies[0].name, 'sid');
  assert.equal(harness.commands.filter((item) => item.method === 'Network.getCookies').length, 2);
  assert.equal(harness.commands.filter((item) => item.method === 'attach').length, 2);
  await driver.disposeBrowserContext(contextId);
});

test('认证状态桥接页在同源主文档请求阶段返回空 HTML', async () => {
  const harness = createHarness();
  const driver = new CdpBrowserContextDriver(harness.chrome);
  await driver.connect(1);
  const contextId = await driver.createBrowserContext();
  await driver.createTarget(contextId, 'about:blank');

  const target = await driver.createInertOriginTarget(contextId, 'https://app.example');

  assert.match(target.tab.url, /^https:\/\/app\.example\/__cuecast_auth_state_bridge__/);
  assert.ok(harness.commands.some((item) => item.method === 'Fetch.enable'));
  assert.ok(harness.commands.some((item) => item.method === 'Fetch.fulfillRequest'
    && item.params.responseCode === 200));
  assert.ok(harness.commands.some((item) => item.method === 'Fetch.disable'));
  await driver.closeTarget(target.targetId);
  await driver.disposeBrowserContext(contextId);
  await driver.disconnect();
});

test('Service Worker 重启后只清理元数据标记的受控无痕窗口', async () => {
  const harness = createHarness();
  const driver = new CdpBrowserContextDriver(harness.chrome);
  await driver.connect(1);
  const contextId = await driver.createBrowserContext();
  const target = await driver.createTarget(contextId, 'https://app.example');
  const windowId = target.tab.windowId;

  const recoveryDriver = new CdpBrowserContextDriver(harness.chrome);
  await recoveryDriver.cleanupRecoveredSession({
    activeTabId: target.tab.id,
    managedTabIds: [target.tab.id],
    managedWindowIds: [windowId],
  });

  assert.equal(harness.windows.has(windowId), false);
});

test('Service Worker 重启后不凭旧 windowId 关闭无法证明归属的用户无痕窗口', async () => {
  const harness = createHarness({ foreignIncognito: true });
  const recoveryDriver = new CdpBrowserContextDriver(harness.chrome);

  await assert.rejects(() => recoveryDriver.cleanupRecoveredSession({
    activeTabId: 999,
    managedTabIds: [999],
    managedWindowIds: [9],
  }), (error) => error.code === 'CDP_INCOGNITO_SESSION_CONTAMINATED');

  assert.equal(harness.windows.has(9), true);
  assert.deepEqual(harness.removedWindows, []);
});

test('受控下载未完成时保留 Context 归属并尝试取消下载', async () => {
  const harness = createHarness();
  const driver = new CdpBrowserContextDriver(harness.chrome);
  await driver.connect(1);
  const contextId = await driver.createBrowserContext();
  await driver.createTarget(contextId, 'https://app.example/download', { background: true });
  harness.emitDownloadCreated({
    id: 77,
    incognito: true,
    state: 'in_progress',
    danger: 'dangerous_file',
    filename: 'D:\\Downloads\\fixture.exe',
    url: 'https://app.example/fixture.exe',
  });

  await assert.rejects(
    () => driver.waitForDownloads(contextId, 1),
    (error) => error.code === 'CDP_DOWNLOAD_REQUIRES_CONFIRMATION'
      && /danger=dangerous_file/.test(error.message)
      && /fixture\.exe/.test(error.message),
  );

  assert.equal(driver.contexts.has(contextId), true);
  assert.deepEqual(harness.cancelledDownloads, [77]);
  harness.emitDownloadChanged({ id: 77, state: { current: 'interrupted' } });
  await driver.disposeBrowserContext(contextId);
  assert.equal(driver.contexts.has(contextId), false);
});

test('下载超时后仍关闭受控窗口并清除 Context 归属', async () => {
  const harness = createHarness();
  const driver = new CdpBrowserContextDriver(harness.chrome);
  await driver.connect(1);
  const contextId = await driver.createBrowserContext();
  const target = await driver.createTarget(contextId, 'https://app.example/download', { background: true });
  harness.emitDownloadCreated({ id: 88, incognito: true, state: 'in_progress', danger: 'safe' });
  driver.waitForDownloads = (id) => CdpBrowserContextDriver.prototype.waitForDownloads.call(driver, id, 1);

  await assert.rejects(
    () => driver.disposeBrowserContext(contextId),
    (error) => error.code === 'CDP_DOWNLOAD_TIMEOUT',
  );

  assert.equal(driver.contexts.has(contextId), false);
  assert.equal(harness.windows.has(target.tab.windowId), false);
  assert.deepEqual(harness.cancelledDownloads, [88]);
});
