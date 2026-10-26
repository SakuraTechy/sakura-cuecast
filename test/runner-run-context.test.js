import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerRunContext, normalizeRunnerCaseResult } from '../modules/runner-run-context.js';

const initial = {
  apiBase: 'https://one.example/api',
  runnerId: 'runner_one',
  organizationUuid: 'org_one',
  token: 'runner-token-old',
  platformAuthToken: 'page-token-old',
};

test('a report save failure fails a standalone Runner case without changing playback outcome', () => {
  const result = normalizeRunnerCaseResult({ ok: true, resultSaveError: 'fetch failed', executionStarted: true });
  assert.equal(result.ok, false);
  assert.equal(result.executionStarted, true);
  assert.match(result.message, /结果保存失败.*fetch failed/);
  assert.deepEqual(normalizeRunnerCaseResult({ ok: true, resultId: 12 }), { ok: true, resultId: 12 });
  const failedPlayback = normalizeRunnerCaseResult({
    ok: false, error: '断言失败', resultSaveError: 'fetch failed',
  });
  assert.match(failedPlayback.message, /断言失败.*结果保存失败/);
});

test('refreshing credentials for the same Runner updates an active run', async () => {
  let invalidations = 0;
  const context = new RunnerRunContext(initial, async () => { invalidations += 1; });
  await context.update({ ...initial, token: 'runner-token-new', platformAuthToken: 'page-token-new' });
  assert.equal(context.config.token, 'runner-token-new');
  assert.equal(context.config.platformAuthToken, 'page-token-new');
  assert.equal(context.invalidated, false);
  assert.equal(invalidations, 0);
});

test('switching instance or organization invalidates the old run only once', async () => {
  for (const changed of [
    { apiBase: 'https://two.example/api' },
    { runnerId: 'runner_two' },
    { organizationUuid: 'org_two' },
  ]) {
    const reasons = [];
    const context = new RunnerRunContext(initial, async (reason) => { reasons.push(reason); });
    await context.update({ ...initial, ...changed });
    await context.invalidate('duplicate switch');
    assert.equal(context.invalidated, true);
    assert.equal(context.beginCompletion(), false);
    assert.equal(reasons.length, 1);
    assert.equal(context.config.apiBase, initial.apiBase);
    assert.equal(context.config.token, initial.token);
  }
});
