import test from 'node:test';
import assert from 'node:assert/strict';
import { runExecutionPlan } from '../modules/plan-runner.js';

function harness(overrides = {}) {
  const saved = [];
  const played = [];
  const closed = [];
  const progress = [];
  let tick = 1000;
  return {
    saved,
    played,
    closed,
    progress,
    options: {
      plan: { id: 7, stop_on_failure: 0, items: [] },
      playCase: async (item, options) => {
        played.push({ id: item.test_case_id, ...options });
        return { ok: true, resultId: item.test_case_id + 100 };
      },
      openSharedTab: async () => 99,
      closeSharedTab: async (tabId) => { closed.push(tabId); },
      checkLogin: async () => ({ found: true }),
      saveResult: async (result) => { saved.push(result); return { id: 501 }; },
      onProgress: async (value) => { progress.push(value); },
      now: () => { tick += 50; return tick; },
      ...overrides,
    },
  };
}

test('plan continues after a failure and persists an aggregate result', async () => {
  const h = harness({
    plan: {
      id: 7,
      stop_on_failure: 0,
      items: [
        { test_case_id: 1, test_case_name: 'one' },
        { test_case_id: 2, test_case_name: 'two' },
      ],
    },
    playCase: async (item) => (
      item.test_case_id === 1
        ? { ok: false, error: 'broken', resultId: 101 }
        : { ok: true, resultId: 102 }
    ),
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.ok, false);
  assert.equal(result.resultId, 501);
  assert.deepEqual(
    h.saved[0].detail.map((item) => item.status),
    ['failed', 'passed'],
  );
  assert.equal(h.saved[0].status, 'completed');
  assert.equal(h.saved[0].passed_count, 1);
  assert.equal(h.saved[0].failed_count, 1);
  assert.deepEqual(h.closed, [99]);
  assert.equal(h.progress.at(-1).phase, 'finished');
  assert.equal(h.progress.at(-1).completed_count, 2);
  assert.deepEqual(
    h.progress.filter((item) => item.phase === 'business' && item.status === 'running')
      .map((item) => item.test_case_id),
    [1, 2],
  );
  assert.deepEqual(h.progress.at(-1).items.map((item) => item.status), ['failed', 'passed']);
});

test('stop_on_failure leaves remaining cases pending', async () => {
  const h = harness({
    plan: {
      id: 7,
      stop_on_failure: 1,
      items: [
        { test_case_id: 1 },
        { test_case_id: 2 },
        { test_case_id: 3 },
      ],
    },
    playCase: async (item) => ({ ok: item.test_case_id !== 1, error: 'broken' }),
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.ok, false);
  assert.equal(result.summary.pending_count, 2);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['failed', 'pending', 'pending']);
  assert.equal(h.saved[0].status, 'stopped');
});

test('login readiness check skips the login case and runs business cases', async () => {
  const h = harness({
    plan: {
      id: 7,
      login_setup_enabled: 1,
      login_test_case_id: 9,
      login_skip_if_logged_in: 1,
      items: [{ test_case_id: 1 }],
    },
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.ok, true);
  assert.deepEqual(h.played.map((item) => item.id), [1]);
  assert.equal(h.saved[0].total_count, 1);
  assert.equal(h.saved[0].detail[0].kind, 'business');
  assert.equal(h.progress.find((item) => item.status === 'skipped')?.phase, 'login_setup');
});

test('failed login setup stops every business case and is included in the report', async () => {
  const h = harness({
    plan: {
      id: 7,
      login_setup_enabled: 1,
      login_test_case_id: 9,
      login_skip_if_logged_in: 0,
      items: [{ test_case_id: 1 }, { test_case_id: 2 }],
    },
    playCase: async (item) => (
      item.test_case_id === 9
        ? { ok: false, error: 'login failed', resultId: 109 }
        : { ok: true }
    ),
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.ok, false);
  assert.equal(h.saved[0].status, 'stopped');
  assert.equal(h.saved[0].total_count, 3);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['failed', 'pending', 'pending']);
});

test('remote cancellation stops the active plan before another case starts', async () => {
  let cancelled = false;
  const h = harness({
    plan: {
      id: 7,
      stop_on_failure: 0,
      items: [{ test_case_id: 1 }, { test_case_id: 2 }],
    },
    playCase: async () => {
      cancelled = true;
      return { ok: false, error: 'playback stopped' };
    },
    shouldStop: () => cancelled,
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.ok, false);
  assert.equal(result.error, '执行已取消');
  assert.equal(result.summary.failed_count, 0);
  assert.equal(result.summary.pending_count, 2);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['pending', 'pending']);
});

test('a case that cannot start stops the plan without marking cases failed', async () => {
  let attempts = 0;
  const h = harness({
    plan: { id: 7, stop_on_failure: 0, items: [{ test_case_id: 1 }, { test_case_id: 2 }] },
    playCase: async () => {
      attempts += 1;
      return { ok: false, error: 'fetch failed', executionStarted: false };
    },
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(attempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'fetch failed');
  assert.equal(h.saved[0].status, 'error');
  assert.equal(h.saved[0].failed_count, 0);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['pending', 'pending']);
  assert.equal(h.saved[0].detail[0].error, 'fetch failed');
  assert.equal(h.progress.at(-1).status, 'failed');
});

test('infrastructure failure retains earlier playback results', async () => {
  const h = harness({
    plan: { id: 7, stop_on_failure: 0, items: [{ test_case_id: 1 }, { test_case_id: 2 }] },
    playCase: async (item) => item.test_case_id === 1
      ? { ok: true, resultId: 101 }
      : { ok: false, error: 'fetch failed', executionStarted: false },
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.summary.status, 'error');
  assert.equal(result.summary.passed_count, 1);
  assert.equal(result.summary.failed_count, 0);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['passed', 'pending']);
  assert.equal(h.saved[0].detail[0].test_result_id, 101);
});

test('report save failure stops further cases without changing playback outcome', async () => {
  let attempts = 0;
  const h = harness({
    plan: { id: 7, stop_on_failure: 0, items: [{ test_case_id: 1 }, { test_case_id: 2 }] },
    playCase: async () => {
      attempts += 1;
      return { ok: true, resultSaveError: 'report unavailable', executionStarted: true };
    },
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(attempts, 1);
  assert.equal(result.summary.status, 'error');
  assert.equal(result.summary.passed_count, 1);
  assert.equal(result.summary.failed_count, 0);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['passed', 'pending']);
  assert.equal(h.saved[0].detail[0].result_save_error, 'report unavailable');
});

test('a later startup error is reported even after a case failure', async () => {
  const h = harness({
    plan: { id: 7, stop_on_failure: 0, items: [{ test_case_id: 1 }, { test_case_id: 2 }] },
    playCase: async (item) => item.test_case_id === 1
      ? { ok: false, error: 'assertion failed', executionStarted: true }
      : { ok: false, error: 'fetch failed', executionStarted: false },
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.error, 'fetch failed');
  assert.equal(result.summary.failed_count, 1);
  assert.equal(result.summary.pending_count, 1);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['failed', 'pending']);
});

test('login case fetch failure stops before business playback', async () => {
  const h = harness({
    plan: { id: 7, login_setup_enabled: 1, login_test_case_id: 9, login_skip_if_logged_in: 0, items: [{ test_case_id: 1 }] },
    playCase: async () => ({ ok: false, error: 'fetch failed', executionStarted: false }),
  });
  const result = await runExecutionPlan(h.options);

  assert.equal(result.summary.status, 'error');
  assert.equal(result.summary.failed_count, 0);
  assert.deepEqual(h.saved[0].detail.map((item) => item.status), ['pending', 'pending']);
});
