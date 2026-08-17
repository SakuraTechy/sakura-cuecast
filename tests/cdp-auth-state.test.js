import assert from 'node:assert/strict';
import test from 'node:test';

import { CdpAuthStateService } from '../modules/cdp-auth-state.js';

test('reuse-auth 在同一候选标签页依次恢复各 origin 的 sessionStorage', async () => {
  const navigations = [];
  const closedTargets = [];
  const chrome = {
    scripting: {
      async executeScript(options) {
        assert.equal(options.target.tabId, 101);
        return [{ result: { ok: true } }];
      },
    },
  };
  const driver = {
    async sendBrowserCommand(method) {
      assert.equal(method, 'Storage.setCookies');
      return {};
    },
    async navigateTargetToInertOrigin(target, origin) {
      navigations.push({ targetId: target.targetId, tabId: target.tab.id, origin });
      return { ...target.tab, url: `${origin}/__cuecast_auth_state_bridge__` };
    },
    async createInertOriginTarget() {
      throw new Error('传入候选 target 后不应创建额外标签页');
    },
    async closeTarget(targetId) { closedTargets.push(targetId); },
  };
  const service = new CdpAuthStateService(chrome);
  const target = { targetId: 'target-1', tab: { id: 101, url: 'about:blank' } };

  await service.restore({
    browserContextId: 'context-1',
    driver,
    target,
    snapshot: {
      version: 1,
      cookies: [{ name: 'sid', value: 'masked', domain: '.example', path: '/' }],
      origins: [
        { origin: 'https://app.example', localStorage: [], sessionStorage: [], indexedDB: [] },
        { origin: 'https://account.example', localStorage: [], sessionStorage: [], indexedDB: [] },
      ],
    },
  });

  assert.deepEqual(navigations.map((item) => item.origin), [
    'https://app.example',
    'https://account.example',
  ]);
  assert.ok(navigations.every((item) => item.targetId === 'target-1' && item.tabId === 101));
  assert.deepEqual(closedTargets, []);
});

test('认证快照超过本地会话上限时显式失败且不返回截断数据', async () => {
  const chrome = {
    scripting: {
      async executeScript() {
        return [{ result: {
          origin: 'https://app.example',
          localStorage: [['large', 'x'.repeat(200)]],
          sessionStorage: [],
          indexedDB: [],
        } }];
      },
    },
  };
  const driver = {
    async sendBrowserCommand() { return { cookies: [] }; },
    async waitForTabLoad() { return { id: 101, status: 'complete' }; },
  };
  const service = new CdpAuthStateService(chrome, { snapshotLimitBytes: 64 });

  await assert.rejects(() => service.capture({
    browserContextId: 'context-1',
    driver,
    tabs: [{ id: 101, url: 'https://app.example/home' }],
    origins: ['https://app.example'],
    lastUrl: 'https://app.example/home',
  }), (error) => error.code === 'CDP_AUTH_STATE_TOO_LARGE');
});

test('认证快照按批次实际访问 URL 读取受控无痕 Cookie', async () => {
  let cookieOptions;
  const chrome = {
    scripting: {
      async executeScript() {
        return [{ result: {
          origin: 'https://app.example',
          localStorage: [],
          sessionStorage: [],
          indexedDB: [],
        } }];
      },
    },
  };
  const driver = {
    async sendBrowserCommand(method, options) {
      assert.equal(method, 'Storage.getCookies');
      cookieOptions = options;
      return { cookies: [] };
    },
    async waitForTabLoad() { return { id: 101, status: 'complete' }; },
  };
  const service = new CdpAuthStateService(chrome);

  await service.capture({
    browserContextId: 'context-1',
    driver,
    tabs: [
      { id: 101, url: 'https://app.example/account' },
      { id: 102, url: 'https://account.example/profile' },
    ],
    origins: ['https://account.example'],
    lastUrl: 'https://app.example/home',
  });

  assert.deepEqual(cookieOptions.urls, [
    'https://app.example/account',
    'https://account.example/profile',
    'https://app.example/home',
    'https://account.example',
    'https://app.example',
  ]);
});
