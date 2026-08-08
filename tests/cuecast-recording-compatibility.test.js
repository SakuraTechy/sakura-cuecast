import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCuecastActionRoute,
  isCuecastCdpAction,
} from '../modules/canonical-action-registry.js';
import { PlayerManager } from '../modules/player-manager.js';

function createManager() {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    debugger: { onEvent: { addListener() {} } },
    runtime: { id: 'cuecast-contract-test' },
  };
  try {
    return new PlayerManager({}, {});
  } finally {
    globalThis.chrome = originalChrome;
  }
}

test('统一元素断言注册为 CDP action 并由 PlayerManager 使用同一注册表路由', () => {
  const manager = createManager();

  assert.equal(getCuecastActionRoute('assert_element_match'), 'cdp');
  assert.equal(isCuecastCdpAction('assert_element_match'), true);
  assert.equal(manager._canUseCDP({ action_type: 'assert_element_match' }), true);
});

test('元素断言表达式检查真实可见性并按 read_mode 读取值', () => {
  const expression = PlayerManager._buildElementAssertionExpr('#account', '', 'value');

  assert.match(expression, /window\.getComputedStyle\(current\)/);
  assert.match(expression, /style\.display === 'none'/);
  assert.match(expression, /style\.visibility === 'hidden'/);
  assert.match(expression, /Number\(style\.opacity\) <= 0/);
  assert.match(expression, /rect\.width <= 0 \|\| rect\.height <= 0/);
  assert.match(expression, /'value' in el/);
});

test('统一元素断言复用 CDP 文本断言语义并读取 expect 字段', async () => {
  const manager = createManager();
  manager._waitForElementAssertionCDP = async () => ({ ok: true, visible: true, value: '防统方系统 - 系统管理平台' });
  manager._logAssertTextCdpDebug = () => {};

  for (const [matchMode, expect] of [
    ['contains', '系统管理平台'],
    ['equals', '防统方系统 - 系统管理平台'],
    ['not_contains', '登录失败'],
    ['regex', '^防统方系统.*平台$'],
    ['visible', ''],
  ]) {
    await manager._executeAssertTextStepCDP(1, {
      action_type: 'assert_element_match',
      target_selector: '#title',
      read_mode: 'text',
      match_mode: matchMode,
      expect,
    });
  }
});

test('隐藏元素不能通过 CueCast CDP 可见性断言', async () => {
  const manager = createManager();
  manager._waitForElementAssertionCDP = async () => ({ ok: true, visible: false, value: 'secret' });

  await assert.rejects(() => manager._executeAssertTextStepCDP(1, {
    action_type: 'assert_element_match',
    target_selector: '#hidden',
    read_mode: 'auto',
    match_mode: 'visible',
  }), /实际值: hidden/);
});

test('非法正则在 CueCast CDP 执行前返回明确错误', async () => {
  const manager = createManager();

  await assert.rejects(() => manager._executeAssertTextStepCDP(1, {
    action_type: 'assert_element_match',
    target_selector: '#title',
    match_mode: 'regex',
    expect: '[invalid',
  }), /正则表达式不合法/);
});
