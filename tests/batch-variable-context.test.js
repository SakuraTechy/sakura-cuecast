import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerManager } from '../modules/player-manager.js';
import { BatchVariableContexts } from '../modules/batch-variable-context.js';

test('CDP 变量预检接受同场景前序成功用例的变量', () => {
  const steps = [{ action_type: 'input', value: '{{passwd}}', target_selector: '#password' }];
  const result = PlayerManager._validateVariableReferencesForPlayback(steps, 0, null, ['passwd']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(PlayerManager._validateVariableReferencesForPlayback(steps).ok, false);
});

const scope = { sceneKey: 'SCENE_1', projectEnvironmentId: '47' };

test('CDP 成功变量跨用例传递并保留掩码、来源和嵌套类型', () => {
  const store = new BatchVariableContexts();
  const batch = { batchId: 'BATCH_1' };
  const first = store.beginCase(batch, scope);
  first.context.set('passwd', 'local-secret', { masked: true, source: 'locator' });
  first.context.set('query.rows', [{ id: 42, enabled: false }], { source: 'infrastructure' });
  store.finishCase(first, true);
  const next = store.beginCase(batch, scope, { passwd: 'old-default' });
  assert.equal(next.context.resolveText('{{passwd}}'), 'local-secret');
  assert.equal(next.context.resolveText('${query.rows[0].id}'), 42);
  assert.equal(next.context.resolveText('{{query.rows[0].enabled}}'), false);
  assert.deepEqual(next.context.describe('passwd'), { variable_name: 'passwd', value_masked: 1, source: 'locator' });
  assert.throws(() => next.context.set('passwd', 'new', { overwrite: false }), /不允许覆盖/);
});

test('CDP 变量按批次对象、场景和环境隔离，旧批次同名也不复用', () => {
  const store = new BatchVariableContexts();
  const batch = { batchId: 'BATCH_1' };
  const first = store.beginCase(batch, scope);
  first.context.set('passwd', 'local-secret');
  store.finishCase(first, true);
  for (const [targetBatch, targetScope] of [
    [batch, { ...scope, sceneKey: 'SCENE_2' }],
    [batch, { ...scope, projectEnvironmentId: '48' }],
    [{ batchId: 'BATCH_2' }, scope],
    [{ batchId: 'BATCH_1' }, scope],
  ]) {
    const current = store.beginCase(targetBatch, targetScope);
    assert.throws(() => current.context.get('passwd'), /变量不存在/);
    store.finishCase(current, false);
  }
});

test('失败候选的嵌套修改不会污染成功状态，结束批次后迟到提交无效', () => {
  const store = new BatchVariableContexts();
  const batch = { batchId: 'BATCH_1' };
  const first = store.beginCase(batch, scope);
  first.context.set('rows', [{ id: 42 }]);
  store.finishCase(first, true);
  const failed = store.beginCase(batch, scope);
  failed.context.get('rows')[0].id = 99;
  store.finishCase(failed, false);
  const next = store.beginCase(batch, scope);
  assert.equal(next.context.get('rows[0].id'), 42);
  assert.throws(() => store.beginCase(batch, scope), /必须等待前一用例/);
  store.clearBatch(batch);
  store.finishCase(next, true);
  assert.throws(() => store.beginCase(batch, scope).context.get('rows'), /变量不存在/);
});

test('真实 PlayerManager.start 跨用例使用变量，回传失败不提交且预检异常仍上报原日志', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { id: 'local-extension', getManifest: () => ({ version: 'test' }) },
    debugger: { onEvent: { addListener() {} } },
    tabs: { query: async () => [], remove: async () => {} },
  };
  const store = new BatchVariableContexts();
  const batch = { batchId: 'BATCH_1' };
  const reports = [];
  let failReport = false;
  let inherited;
  const cases = {
    SAVE: [{ action_type: 'global_variable_set', source_type: 'literal', variable_name: 'passwd', value: 'local-secret', value_masked: 1 }],
    USE: [{ action_type: 'global_variable_set', source_type: 'literal', variable_name: 'copy', value: '{{passwd}}', value_masked: 1 }],
    FAIL_REPORT: [{ action_type: 'global_variable_set', source_type: 'literal', variable_name: 'passwd', value: 'uncommitted', value_masked: 1 }],
  };
  const player = new PlayerManager({ mode: 'idle', activePlayCount: 0 }, {
    getAdminPlaywrightCase: async (key) => ({ data: {
      name: key, case_id: key.split(':')[1], project_environment_id: '47', steps: cases[key.split(':')[1]],
      effectiveExecutionConfig: { browser_bootstrap_mode: 'none', step_timeout_ms: 3000, case_timeout_ms: 60000 },
    } }),
    saveAdminPlaywrightResult: async (_key, result) => {
      reports.push(result);
      if (failReport) throw new Error('模拟回传失败');
    },
  });
  player._broadcastPlayback = () => {};
  player._notifyPopup = () => {};
  player._showNotification = () => {};
  player._sleep = async () => {};
  const run = (caseId, sceneKey = scope.sceneKey) => player.start(caseId, '', {
    adminCaseKey: `${sceneKey}:${caseId}`, batchId: batch.batchId, executionCapability: 'local-capability',
    projectEnvironmentId: '47', dataSource: 'admin',
    prepareVariableContext: ({ initialVariables, ...caseScope }) => {
      const session = store.beginCase(batch, caseScope, initialVariables);
      inherited = session.context.names().includes('passwd') ? session.context.get('passwd') : undefined;
      return session;
    },
    finalizeVariableContext: (session, success) => store.finishCase(session, success),
  });
  try {
    assert.equal((await run('SAVE')).ok, true);
    assert.equal((await run('USE')).ok, true);
    assert.equal(inherited, 'local-secret');
    assert.equal(reports.at(-1).raw.case_result.steps[0].details.variable_references[0].value_masked, 1);
    failReport = true;
    assert.equal((await run('FAIL_REPORT')).ok, false);
    failReport = false;
    assert.equal((await run('USE')).ok, true);
    assert.equal(inherited, 'local-secret');
    const missing = await run('USE', 'SCENE_2');
    assert.equal(missing.ok, false);
    assert.match(missing.error, /变量预检失败.*passwd/);
    assert.ok(reports.at(-1).raw.execution_logs.some(item => item.level === 'error' && item.message.includes(missing.error)));
    assert.ok(!JSON.stringify(reports).includes('local-secret'));
    assert.equal(player._playContexts.size, 0);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
