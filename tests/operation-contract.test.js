import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  CUECAST_ACTION_TYPES,
  OPERATION_CATALOG_VERSION,
  getCuecastActionRoute,
} from '../modules/canonical-action-registry.js';
import { attachOperationDiagnostic } from '../modules/operation-diagnostics.js';
import { PlayerManager } from '../modules/player-manager.js';
import { CuecastVariableContext } from '../modules/variable-context.js';

const fixturePath = new URL(
  '../../sakura-admin/continew-automation/src/test/resources/automation/automation-operation-63-fixture.json',
  import.meta.url,
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(new URL(
  '../../sakura-admin/continew-automation/src/main/resources/automation/automation-operation-catalog.json',
  import.meta.url,
), 'utf8'));
const profileByMethod = Object.fromEntries(Object.entries(catalog.diagnostic_profiles)
  .flatMap(([profile, methods]) => methods.map((methodCode) => [methodCode, profile])));

test('CueCast registry covers every canonical action in the 63-method fixture', () => {
  assert.equal(fixture.catalog_version, OPERATION_CATALOG_VERSION);
  assert.equal(fixture.methods.length, 63);

  const fixtureActions = [...new Set(fixture.methods.map((method) => method.action_type))];
  const missing = fixtureActions.filter((actionType) => !CUECAST_ACTION_TYPES.has(actionType));
  assert.deepEqual(missing, []);
  for (const actionType of fixtureActions) {
    assert.notEqual(getCuecastActionRoute(actionType), '', `CueCast action has no route: ${actionType}`);
  }
});

test('CueCast execution result adds the shared operation detail without exposing restricted input', () => {
  const result = attachOperationDiagnostic(
    {
      action_type: 'server_command',
      status: 'passed',
      details: { infrastructure: { kind: 'SERVER_COMMAND', exitCode: 0 } },
      exit_code: 0,
    },
    {
      action_type: 'server_command',
      method_code: 'server.shell',
      command: 'curl -H "Authorization: Bearer secret-token" /health',
    },
  );

  assert.equal(result.details.infrastructure.kind, 'SERVER_COMMAND');
  assert.equal(result.details.operation.profile, 'infrastructure');
  const command = result.details.operation.inputs.find((item) => item.key === 'command');
  assert.equal(command.effective.value_state, 'restricted');
  assert.deepEqual(command.source, { code: 'definition_snapshot', label: '定义快照' });
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('CueCast 目录参数完整进入变量执行详情', () => {
  const result = attachOperationDiagnostic(
    { action_type: 'global_variable_date', status: 'passed' },
    {
      method_code: 'global.variable.date',
      action_type: 'global_variable_date',
      variable_name: 'run.date',
      date_mode: 'offset',
      format: 'yyyy-MM-dd',
      datetime: '2026-08-06T00:00:00+08:00',
      offset_seconds: 60,
      timestamp_unit: 'second',
    },
  );

  assert.deepEqual(
    result.details.operation.inputs.map((item) => item.key),
    ['variable_name', 'format', 'date_mode', 'datetime', 'offset_seconds', 'timestamp_unit'],
  );
  assert.deepEqual(result.details.operation.inputs.find((item) => item.key === 'format').source, {
    code: 'literal',
    label: '固定值',
  });
});

test('全部 63 个目录方法在 CueCast 中保持方法身份和 profile 契约', () => {
  assert.equal(fixture.methods.length, 63);
  for (const method of fixture.methods) {
    const result = attachOperationDiagnostic(
      { action_type: method.action_type, status: 'passed' },
      {
        catalog_version: fixture.catalog_version,
        method_code: method.method_code,
        action_type: method.action_type,
      },
    );
    const operation = result.details.operation;
    assert.equal(operation.catalog_version, fixture.catalog_version);
    assert.equal(operation.method.method_code, method.method_code);
    assert.equal(operation.profile, profileByMethod[method.method_code]);
    assert.equal(operation.outcome.kind, profileByMethod[method.method_code]);
  }
});

test('所有目录 form_schema 字段都进入 CueCast 执行详情', () => {
  let fieldCount = 0;
  for (const type of catalog.types) {
    for (const method of type.methods) {
      const values = Object.fromEntries(method.form_schema.map((field) => [
        field.name,
        field.name === 'variable_name' ? 'run.value' : 'configured',
      ]));
      const result = attachOperationDiagnostic(
        { action_type: method.action_type, status: 'passed' },
        {
          ...values,
          catalog_version: catalog.catalog_version,
          method_code: method.method_code,
          action_type: method.action_type,
          diagnostic_profile: profileByMethod[method.method_code],
          diagnostic_fields: method.form_schema,
        },
        { ...values, action_type: method.action_type },
      );
      assert.deepEqual(
        result.details.operation.inputs.map((input) => input.key),
        method.form_schema.map((field) => field.name),
      );
      fieldCount += method.form_schema.length;
    }
  }
  assert.equal(fieldCount, 127);
});

test('CueCast 变量引用详情只输出脱敏预览并保留来源', () => {
  const context = new CuecastVariableContext({ order: 'ORD-001' });
  context.set('token', 'secret-token', { source: 'step', masked: true });

  assert.deepEqual(context.describeReferencesForStep({
    action_type: 'input',
    value: '${order}-${token}',
  }), [
    {
      reference: 'order',
      variable_name: 'order',
      value_masked: 0,
      value_preview: 'ORD-001',
      source: 'initial',
    },
    {
      reference: 'token',
      variable_name: 'token',
      value_masked: 1,
      source: 'step',
    },
  ]);
});

test('CueCast 变量上下文兼容双花括号并忽略步骤描述', () => {
  const context = new CuecastVariableContext({ order: { id: 42 }, token: 'abc' });

  assert.equal(context.resolveText('{{order.id}} / ${token}'), '42 / abc');
  assert.deepEqual(context.referencesInStep({
    action_type: 'assert_element_match',
    description: '断言元素包含 {{token}}',
    expect: '{{order.id}}-${token}',
  }), ['order.id', 'token']);
});

test('CueCast 录制动作只在运行副本中转换为 canonical action', () => {
  const variable = PlayerManager._adaptRecordedStep({
    action_type: 'set_variable',
    value: 'test',
    locator_meta: { context: { variable: { name: 'test', source: 'text', extract: { mode: 'full' } } } },
  });
  assert.equal(variable.action_type, 'global_variable_set');
  assert.equal(variable.original_action_type, 'set_variable');
  assert.equal(variable.variable_name, 'test');
  const variableDiagnostic = attachOperationDiagnostic(
    { action_type: variable.action_type, status: 'passed' },
    { ...variable, method_code: 'global.variable.set', method_version: 1 },
    variable,
    { executor: 'extension-cdp' },
  );
  assert.equal(variableDiagnostic.details.operation.method.action_type, 'global_variable_set');

  const assertionLocatorMeta = {
    candidates: [{ type: 'xpath_fallback', value: "(//span[@class='user-title'])[1]", score: 0.42 }],
    context: { assertion: { target: 'element', match: 'contains', source: 'text' } },
  };
  const assertion = PlayerManager._adaptRecordedStep({
    action_type: 'assert_text',
    value: '{{test}}',
    target_xpath: "(//span[@class='user-title'])[1]",
    locator_meta: assertionLocatorMeta,
  });
  assert.equal(assertion.action_type, 'assert_element_match');
  assert.equal(assertion.original_action_type, 'assert_text');
  assert.equal(assertion.expect, '{{test}}');
  assert.equal(assertion.target_xpath, "(//span[@class='user-title'])[1]");
  assert.deepEqual(assertion.locator_meta, assertionLocatorMeta);
});

test('CueCast CDP 定位诊断可以从真实 via 生成定位摘要', () => {
  assert.deepEqual(PlayerManager._actualLocatorFromVia({ target_selector: '#login' }, 'css'), {
    source: 'target_selector',
    executionSource: 'cdp:css',
    type: 'css',
    value: '#login',
    matchedCount: 1,
  });
});

test('CueCast CDP 从页面保存变量时返回实际命中定位器', async () => {
  const manager = Object.create(PlayerManager.prototype);
  manager._waitForVariableValueCDP = async () => ({
    ok: true,
    value: '防统方系统 - 系统管理平台',
    via: 'meta-css_fallback',
    matched_count: 1,
    visible_count: 1,
  });
  const context = new CuecastVariableContext();
  const result = await manager._executeLocalVariableAction(5, {
    action_type: 'global_variable_set',
    variable_name: 'test',
    source_type: 'locator',
    target_selector: 'span.user-title',
    locator_meta: {
      candidates: [{ type: 'css_fallback', value: 'span.user-title', score: 0.72 }],
    },
  }, context);

  assert.equal(result.variable.value_preview, '防统方系统 - 系统管理平台');
  assert.equal(result.locator.source, 'locator_meta.candidates[0]');
  assert.equal(result.locator.executionSource, 'cdp:meta-css_fallback');
  assert.equal(result.locator.recordingScore, 0.72);
});

test('CueCast 元素断言比较会忽略展示文本中的不可见差异', () => {
  assert.equal(PlayerManager._matchAssertionText(' 防统方系统\u00a0-\n系统管理平台 ', '防统方系统 - 系统管理平台', 'contains'), true);
  assert.equal(PlayerManager._matchAssertionText('防统方系统 - 系统管理平台', '防统方系统 - 系统管理平台', 'equals'), true);
  assert.equal(PlayerManager._matchAssertionText('防统方系统\u2013系统管理平台', '防统方系统 - 系统管理平台', 'contains'), false);
});

test('CueCast 五种元素断言匹配方式保持实际值对期望值的比较语义', () => {
  assert.equal(PlayerManager._matchAssertionText('上传成功', '上传成功1', 'contains'), false);
  assert.equal(PlayerManager._matchAssertionText('上传成功1', '上传成功', 'contains'), true);
  assert.equal(PlayerManager._matchAssertionText('上传成功', '上传成功', 'equals'), true);
  assert.equal(PlayerManager._matchAssertionText('上传成功1', '上传成功', 'equals'), false);
  assert.equal(PlayerManager._matchAssertionText('上传失败', '成功', 'not_contains'), true);
  assert.equal(PlayerManager._matchAssertionText('上传成功', '^上传.*成功$', 'regex'), true);
  assert.deepEqual(
    PlayerManager._resolveAssertionConfig({ action_type: 'assert_element_match', match_mode: 'visible' }, true),
    { target: 'element', match: 'visible', readMode: 'auto' },
  );
});

test('CueCast CDP 元素断言失败仍保留实际命中的候选定位器', async () => {
  const manager = Object.create(PlayerManager.prototype);
  manager._waitForElementAssertionCDP = async () => ({
    ok: true,
    visible: true,
    value: '上传成功',
    via: 'meta-css_fallback',
    matched_count: 1,
    visible_count: 1,
  });
  manager._logAssertTextCdpDebug = () => {};

  await assert.rejects(
    () => manager._executeAssertTextStepCDP(5, {
      action_type: 'assert_element_match',
      target_selector: 'p.el-message__content',
      target_xpath: '/html/body/div[6]/p',
      locator_meta: {
        candidates: [{ type: 'css_fallback', value: 'p.el-message__content', score: 0.72 }],
      },
      match_mode: 'contains',
      expect: '上传成功1',
    }),
    (error) => {
      assert.equal(error.actualLocator.source, 'locator_meta.candidates[0]');
      assert.equal(error.actualLocator.executionSource, 'cdp:meta-css_fallback');
      assert.equal(error.actualLocator.recordingScore, 0.72);
      assert.equal(error.actualLocator.type, 'css_fallback');
      assert.equal(error.actualLocator.value, 'p.el-message__content');
      assert.equal(error.actualLocator.matchedCount, 1);
      assert.equal(error.operationAssertion.actual.preview, '上传成功');
      return true;
    },
  );
});

test('CueCast CDP 成功断言也保留统一实际值', async () => {
  const manager = Object.create(PlayerManager.prototype);
  manager._waitForElementAssertionCDP = async () => ({
    ok: true,
    visible: true,
    value: '上传成功',
    via: 'meta-css_fallback',
    matched_count: 1,
    visible_count: 1,
  });
  manager._logAssertTextCdpDebug = () => {};

  const result = await manager._executeAssertTextStepCDP(5, {
    action_type: 'assert_element_match',
    target_selector: 'p.el-message__content',
    locator_meta: { candidates: [{ type: 'css_fallback', value: 'p.el-message__content' }] },
    match_mode: 'contains',
    expect: '上传',
  });

  assert.equal(result.operationAssertion.expected.preview, '上传');
  assert.equal(result.operationAssertion.actual.preview, '上传成功');
  assert.equal(result.operationAssertion.passed, true);
  assert.equal(result.type, 'css_fallback');
});

test('CueCast 变量断言区分配置值、解析后的期望值和页面实际值', () => {
  const result = attachOperationDiagnostic(
    {
      action_type: 'assert_element_match',
      status: 'failed',
      operation_assertion: {
        subject: '指定元素',
        operator: 'contains',
        expected: { value_state: 'visible', preview: '防统方系统 - 系统管理平台1' },
        actual: { value_state: 'visible', preview: '防统方系统 - 系统管理平台' },
        passed: false,
      },
    },
    {
      action_type: 'assert_element_match',
      expect: '{{test}}1',
      match_mode: 'contains',
    },
    {
      action_type: 'assert_element_match',
      expect: '防统方系统 - 系统管理平台1',
      match_mode: 'contains',
    },
  );
  const expectedInput = result.details.operation.inputs.find((item) => item.key === 'expect');
  assert.equal(expectedInput.configured.preview, '{{test}}1');
  assert.equal(expectedInput.effective.preview, '防统方系统 - 系统管理平台1');
  assert.deepEqual(expectedInput.actual, { value_state: 'visible', preview: '防统方系统 - 系统管理平台' });
  assert.deepEqual(expectedInput.source, { code: 'variable_reference', label: '引用变量：test' });
});

test('CueCast 证书角色显示文件名并输出上传交互结果', () => {
  const certificateReference = {
    type: 'admin_execution_file',
    asset_id: 123,
    file_name: '172_19_5_45_audit.lic',
    download_path: '/automation/playwright/testcases/SCENE/CASE/execution-file',
  };
  const result = attachOperationDiagnostic(
    {
      action_type: 'certificate_upload',
      status: 'passed',
      filename: '172_19_5_45_audit.lic',
      file_count: 1,
      upload_status: '上传控件已设置',
      certificate_uploaded: true,
      uploaded_certificate_files: ['172_19_5_45_audit.lic'],
    },
    { action_type: 'certificate_upload', certificate_ref: certificateReference },
    { action_type: 'certificate_upload', certificate_ref: certificateReference },
  );

  const certificateInput = result.details.operation.inputs.find((item) => item.key === 'certificate_ref');
  assert.equal(certificateInput.configured.preview, '172_19_5_45_audit.lic');
  assert.equal(certificateInput.effective.preview, '172_19_5_45_audit.lic');
  assert.deepEqual(
    result.details.operation.outcome.facts.map((item) => [item.key, item.value.preview]),
    [
      ['filename', '172_19_5_45_audit.lic'],
      ['file_count', '1'],
      ['upload_status', '上传控件已设置'],
      ['certificate_uploaded', '成功'],
      ['uploaded_certificate_files', '172_19_5_45_audit.lic'],
    ],
  );
});

test('CueCast CDP 断言失败将页面实际值写入统一诊断详情', () => {
  const failure = PlayerManager._createAssertionFailureError({
    target: 'element',
    match: 'contains',
    expected: '上传成功',
    actual: '网卡校验异常，请重新申请证书',
    css: 'p.el-message__content',
    xpath: '/html/body/div[6]/p',
    actualLocator: {
      source: 'cdp:meta-css_fallback',
      type: 'css_fallback',
      value: 'p.el-message__content',
      matchedCount: 1,
      visibleCount: 1,
    },
  });
  const result = attachOperationDiagnostic(
    {
      action_type: 'assert_element_match',
      status: 'failed',
      error: failure.message,
      operation_assertion: failure.operationAssertion,
    },
    {
      action_type: 'assert_element_match',
      expect: '上传成功',
      match_mode: 'contains',
      target_selector: 'p.el-message__content',
    },
  );

  assert.equal(result.details.operation.outcome.assertion.expected.preview, '上传成功');
  assert.equal(result.details.operation.outcome.assertion.actual.preview, '网卡校验异常，请重新申请证书');
  assert.equal(result.details.operation.outcome.assertion.passed, false);
  assert.equal('operation_assertion' in result, false);
  assert.equal(failure.actualLocator.type, 'css_fallback');
});

test('CueCast CDP 显示录制候选评分而不冒充执行语义评分', () => {
  const step = {
    target_selector: 'span.user-title',
    target_xpath: '/html/body/div[1]/span',
    locator_meta: {
      candidates: [
        { type: 'css_fallback', value: 'span.user-title', score: 0.72 },
        { type: 'text_exact', value: '{{test}}', score: 0.66 },
      ],
    },
  };
  const actualLocator = PlayerManager._actualLocatorFromVia(step, 'meta-css_fallback', 1, 1);
  const diagnostics = PlayerManager._buildCdpLocatorDiagnostics(step, actualLocator, 'failed', 465);

  assert.equal(diagnostics.mode, 'cdp-ordered-candidate');
  assert.equal(diagnostics.outcome, 'action-failed');
  assert.equal(diagnostics.configured_candidate_count, 4);
  assert.equal(diagnostics.selected.source, 'locator_meta.candidates[0]');
  assert.equal(diagnostics.selected.execution_source, 'cdp:meta-css_fallback');
  assert.equal(diagnostics.selected.type, 'css_fallback');
  assert.equal(diagnostics.selected.score, 0.72);
  assert.equal(diagnostics.selected.score_kind, 'recording_candidate');
  assert.deepEqual(diagnostics.wait, { wall_ms: 465, measurement: 'step_total' });
});

test('CueCast 操作输入保留超过 512 字符的完整配置值和执行值', () => {
  const longValue = `locator-${'x'.repeat(700)}`;
  const result = attachOperationDiagnostic(
    { action_type: 'click', status: 'passed' },
    { action_type: 'click', target_ref: longValue },
    { action_type: 'click', target_ref: longValue },
  );
  const target = result.details.operation.inputs.find((item) => item.key === 'target_ref');

  assert.equal(target.configured.preview, longValue);
  assert.equal(target.effective.preview, longValue);
});

test('CueCast 变量生产步骤不会提前解析下一步引用', () => {
  assert.equal(PlayerManager._shouldResolveNextStepBeforeCurrent({ action_type: 'global_variable_set' }), false);
  assert.equal(PlayerManager._shouldResolveNextStepBeforeCurrent({ action_type: 'global_variable_date' }), false);
  assert.equal(PlayerManager._shouldResolveNextStepBeforeCurrent({ action_type: 'click' }), true);

  const context = new CuecastVariableContext();
  assert.throws(() => context.resolveStep({ expect: '{{test}}' }), /变量不存在：test/);
  context.set('test', '已登录');
  assert.equal(context.resolveStep({ expect: '{{test}}' }).expect, '已登录');
});
