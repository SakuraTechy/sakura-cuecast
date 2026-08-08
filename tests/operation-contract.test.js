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
  assert.equal(fieldCount, 117);
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

  const assertion = PlayerManager._adaptRecordedStep({
    action_type: 'assert_text',
    value: '{{test}}',
    locator_meta: { context: { assertion: { target: 'element', match: 'contains', source: 'text' } } },
  });
  assert.equal(assertion.action_type, 'assert_element_match');
  assert.equal(assertion.original_action_type, 'assert_text');
  assert.equal(assertion.expect, '{{test}}');
});

test('CueCast CDP 定位诊断可以从真实 via 生成定位摘要', () => {
  assert.deepEqual(PlayerManager._actualLocatorFromVia({ target_selector: '#login' }, 'css'), {
    source: 'cdp:css',
    type: 'css',
    value: '#login',
    matchedCount: 1,
  });
});

test('CueCast 元素断言比较会忽略展示文本中的不可见差异', () => {
  assert.equal(PlayerManager._matchAssertionText(' 防统方系统\u00a0-\n系统管理平台 ', '防统方系统 - 系统管理平台', 'contains'), true);
  assert.equal(PlayerManager._matchAssertionText('防统方系统 - 系统管理平台', '防统方系统 - 系统管理平台', 'equals'), true);
  assert.equal(PlayerManager._matchAssertionText('防统方系统\u2013系统管理平台', '防统方系统 - 系统管理平台', 'contains'), false);
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
