import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  getCuecastActionRoute,
  isCuecastCdpAction,
} from '../modules/canonical-action-registry.js';
import { PlayerManager } from '../modules/player-manager.js';

const locatorContract = JSON.parse(fs.readFileSync(new URL(
  './fixtures/locator-contract-v1.json',
  import.meta.url,
), 'utf8'));

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

test('元素断言表达式按属性读取当前 DOM 属性并区分属性缺失', () => {
  const expression = PlayerManager._buildElementAssertionExpr('#state', '', 'attribute', null, 'class');

  assert.match(expression, /hasAttribute/);
  assert.match(expression, /getAttribute/);
  assert.match(expression, /attribute_present: false/);
  assert.match(expression, /"class"/);
});

test('括号 XPath 在所有 CDP 表达式中保持原样并复用 locator_meta 候选', () => {
  const xpath = "(//span[@class='user-title'])[1]";
  assert.equal(PlayerManager._normalizeXPath(xpath), xpath);
  assert.equal(PlayerManager._normalizeXPath('.//span[@class="user-title"]'), './/span[@class="user-title"]');
  assert.equal(PlayerManager._normalizeXPath('html/body/main/span[1]'), '/html/body/main/span[1]');

  const expression = PlayerManager._buildElementAssertionExpr(
    '',
    xpath,
    'text',
    { candidates: [{ type: 'css_attr_data-qa', value: "[data-qa='user-title']", score: 0.97 }] },
  );
  assert.match(expression, /data-qa/);
  assert.match(expression, /locator_meta|meta-css_attr_data-qa/);
  assert.doesNotMatch(expression, /\/\(\/\/span/);
});

test('XPath 校验表达式区分语法错误与非节点结果', () => {
  const expression = PlayerManager._xpathValidationExpr("(//span[@class='user-title'])[1]");
  assert.match(expression, /LOCATOR_XPATH_INVALID/);
  assert.match(expression, /LOCATOR_XPATH_UNSUPPORTED/);
});

test('CDP Runtime.evaluate 使用当前 iframe execution context', async () => {
  const manager = createManager();
  const originalChrome = globalThis.chrome;
  let sentParams = null;
  globalThis.chrome = {
    debugger: {
      sendCommand(_target, _method, params, callback) {
        sentParams = params;
        callback({ result: { value: true } });
      },
    },
    runtime: { lastError: null },
  };
  manager._frameContextByTab.set(7, { contextId: 42 });
  try {
    await manager._cdpSend(7, 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
    assert.equal(sentParams.contextId, 42);
    assert.equal(sentParams.expression, '1 + 1');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('录制器候选类型在 CDP 点击与断言 resolver 中都有明确处理', () => {
  const manager = createManager();
  const candidateTypes = locatorContract.candidates.map((candidate) => candidate.type);
  assert.deepEqual(candidateTypes, [
    ...locatorContract.recorder_candidate_types,
    ...locatorContract.compatibility_candidate_types,
  ]);

  for (const candidate of locatorContract.candidates) {
    const meta = { candidates: [candidate] };
    const clickExpression = manager._buildFindCode('', '', '', false, meta);
    const assertionExpression = PlayerManager._buildDomTargetResultChain('', '', meta);
    assert.notEqual(clickExpression, 'null', `click resolver 未处理 ${candidate.type}`);
    assert.notEqual(assertionExpression, 'null', `assert resolver 未处理 ${candidate.type}`);
  }
});

test('CDP 前置校验明确拒绝 jQuery、JS Path 和 testRigor 私有定位器', async () => {
  const manager = createManager();
  manager._cdpSend = async () => ({ result: { value: { ok: true } } });

  for (const targetSelector of [
    "jquery=$('.user-title')",
    "document.querySelector('.user-title')",
    'testrigor=click "登录"',
  ]) {
    await assert.rejects(
      () => manager._validateStepXpathsCDP(1, { target_selector: targetSelector }),
      (error) => error?.code === 'LOCATOR_STRATEGY_UNSUPPORTED',
    );
  }
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

test('统一元素断言按属性模式使用原始字符串匹配', async () => {
  const manager = createManager();
  manager._waitForElementAssertionCDP = async () => ({
    ok: true,
    visible: true,
    value: 'icon-inner  running',
    attribute_present: true,
    via: 'css',
    matched_count: 1,
    visible_count: 1,
  });
  manager._logAssertTextCdpDebug = () => {};

  const result = await manager._executeAssertTextStepCDP(5, {
    action_type: 'assert_element_match',
    target_selector: '#state',
    read_mode: 'attribute',
    attribute: 'class',
    match_mode: 'equals',
    expect: 'icon-inner  running',
  });
  assert.equal(result.operationAssertion.subject, '元素属性 class');

  manager._waitForElementAssertionCDP = async () => ({
    ok: true,
    visible: true,
    value: '',
    attribute_present: false,
    via: 'css',
    matched_count: 1,
    visible_count: 1,
  });
  await assert.rejects(() => manager._executeAssertTextStepCDP(5, {
    action_type: 'assert_element_match',
    target_selector: '#state',
    read_mode: 'attribute',
    attribute: 'data-status',
    match_mode: 'not_contains',
    expect: 'running',
  }), /属性名|属性不存在/);
});

test('CDP 条件点击仅在目标状态匹配时发送鼠标事件', async () => {
  assert.equal(PlayerManager._normalizeClickWhen('关闭'), 'off');
  assert.equal(PlayerManager._normalizeClickWhen('checked'), 'on');
  const stateExpression = PlayerManager._buildClickStateExpr('#toggle', '', '', null);
  assert.match(stateExpression, /aria-checked/);
  assert.match(stateExpression, /data-state/);
  const existsExpression = PlayerManager._buildElementExistsExpr('', "(//span[contains(text(),'OFF')])[2]", null);
  new Function(`return ${existsExpression}`);
  assert.deepEqual(PlayerManager._clickConditionLocatorFields({
    click_condition_ref: { strategy: 'xpath', value: "(//span[contains(text(),'OFF')])[2]" },
  }), { selector: '', xpath: "(//span[contains(text(),'OFF')])[2]" });

  const createClickManager = (state) => {
    const manager = createManager();
    let clickCount = 0;
    manager._validateStepXpathsCDP = async () => {};
    manager._getElementBoxResult = async () => ({
      ok: true,
      box: { x: 10, y: 20, via: 'css', hitOk: true },
    });
    manager._findVirtualScrollTargetBoxCDP = async () => null;
    manager._readClickStateCDP = async () => ({ ok: true, state, source: 'aria-pressed' });
    manager._cdpClick = async () => { clickCount += 1; };
    manager._sleep = async () => {};
    return { manager, getClickCount: () => clickCount };
  };

  const matched = createClickManager('off');
  const matchedResult = await matched.manager._executeStepCDP(1, {
    action_type: 'click',
    click_when: 'off',
    target_selector: '#toggle',
  });
  assert.equal(matched.getClickCount(), 1);
  assert.equal(matchedResult.source, 'target_selector');

  for (const state of ['on', 'unknown']) {
    const skipped = createClickManager(state);
    const skippedResult = await skipped.manager._executeStepCDP(1, {
      action_type: 'click',
      click_when: 'off',
      target_selector: '#toggle',
    });
    assert.equal(skipped.getClickCount(), 0);
    assert.equal(skippedResult.__cdpStepResult, true);
    assert.equal(skippedResult.status, 'skipped');
    assert.equal(skippedResult.details.actual_state, state);
  }

  const exists = createClickManager('unknown');
  exists.manager._readClickConditionExistsCDP = async () => ({
    ok: true,
    exists: true,
    source: 'xpath',
  });
  const existsResult = await exists.manager._executeStepCDP(1, {
    action_type: 'click',
    click_when: 'element_exists',
    click_condition_ref: { strategy: 'xpath', value: "(//span[contains(text(),'OFF')])[2]" },
    target_selector: '#toggle',
  });
  assert.equal(exists.getClickCount(), 1);
  assert.equal(existsResult.source, 'target_selector');

  const missing = createClickManager('unknown');
  missing.manager._readClickConditionExistsCDP = async () => ({
    ok: true,
    exists: false,
    source: 'xpath',
  });
  const missingResult = await missing.manager._executeStepCDP(1, {
    action_type: 'click',
    click_when: 'element_exists',
    click_condition_ref: { strategy: 'xpath', value: "(//span[contains(text(),'OFF')])[2]" },
    target_selector: '#toggle',
  });
  assert.equal(missing.getClickCount(), 0);
  assert.equal(missingResult.status, 'skipped');
  assert.equal(missingResult.details.actual_state, 'not_exists');
});
