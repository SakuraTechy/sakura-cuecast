import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackPerfTrace } from '../modules/playback-perf.js';

test('developer playback trace records run and step phases in machine-readable form', async () => {
  const trace = new PlaybackPerfTrace({ runId: 'run-1', testCaseId: 12, source: 'web' });
  await trace.measure('fetch_case', async () => {});
  const step = trace.beginStep(0, 'click', 'cdp');
  await trace.measure('action', async () => {
    await trace.measure('screenshot', async () => {}, step, true);
  }, step);
  trace.noteScreenshot(step, 'data:image/jpeg;base64,YWJj');
  trace.endStep(step, 'success');

  const result = trace.snapshot('passed');
  assert.equal(result.schema, 'cuecast.playback.perf.v1');
  assert.equal(result.visible_page_emulation, 'disabled');
  assert.equal(result.test_case_id, 12);
  assert.equal(result.steps[0].engine, 'cdp');
  assert.equal(result.steps[0].screenshot_bytes, 3);
  assert.equal(result.steps[0].screenshot_count, 1);
  assert.ok(result.steps[0].phase_ms.action >= 0);
  assert.ok(result.steps[0].nested_ms.screenshot >= 0);
  assert.ok(result.phase_ms.fetch_case >= 0);
  assert.equal(JSON.stringify(result).includes('data:image'), false);
});

test('developer playback trace retains elapsed time when a measured phase fails', async () => {
  const trace = new PlaybackPerfTrace({ runId: 'run-2', testCaseId: 13 });
  const step = trace.beginStep(1, 'input', 'dom');
  await assert.rejects(trace.measure('action', async () => { throw new Error('failed'); }, step));
  trace.endStep(step, 'failed');
  const result = trace.snapshot('failed');
  assert.equal(result.steps[0].status, 'failed');
  assert.ok(result.steps[0].phase_ms.action >= 0);
});

test('developer trace reports requested and applied playback window size', () => {
  const trace = new PlaybackPerfTrace({ runId: 'run-window', testCaseId: 14 });
  trace.notePlaybackWindow({ mode: 'maximized' }, {
    state: 'maximized', width: 1512, height: 982, focused: false, title: 'private page title',
  });
  const result = trace.snapshot('passed');
  assert.deepEqual(result.playback_window, {
    requested_mode: 'maximized', actual_state: 'maximized',
    outer_width: 1512, outer_height: 982, focused: false,
  });
  assert.equal(JSON.stringify(result).includes('private page title'), false);
});

test('developer trace coalesces repeated page loading polls and keeps state transitions', () => {
  const trace = new PlaybackPerfTrace({ runId: 'run-state', testCaseId: 13 });
  const step = trace.beginStep(19, 'click', 'cdp');
  const hiddenLoading = {
    loading: true, loading_marker: 'ivu_spin', spinner_marker: 'ivu_spin',
    marker_effectively_visible: true, spinner_effectively_visible: true, target_present: false,
    visibility_state: 'hidden', document_has_focus: false,
  };
  trace.notePageState(step, 'step_start', hiddenLoading);
  trace.notePageState(step, 'loading_poll', hiddenLoading);
  trace.notePageState(step, 'loading_poll', hiddenLoading);
  trace.notePageState(step, 'loading_poll', { ...hiddenLoading, target_present: true });
  trace.notePageState(step, 'loading_poll', {
    ...hiddenLoading, loading: false, loading_marker: 'none', spinner_marker: 'none',
    marker_effectively_visible: null, spinner_effectively_visible: null, target_present: true,
  });
  trace.endStep(step, 'success');

  const events = trace.snapshot('passed').steps[0].page_state_events;
  assert.deepEqual(events.map(({ event, loading_ui, samples }) => [event, loading_ui, samples]), [
    ['step_start', true, 1],
    ['loading_poll', true, 2],
    ['loading_poll', true, 1],
    ['loading_poll', false, 1],
  ]);
  assert.equal(events[0].visibility_state, 'hidden');
  assert.equal(events[0].document_has_focus, false);
  assert.equal(events[1].loading_marker, 'ivu_spin');
  assert.equal(events[1].target_present, false);
  assert.equal(events[2].target_present, true);
  assert.ok(events.every(({ at_ms, last_at_ms }) => last_at_ms >= at_ms));
});

test('developer trace keeps request completion and early failures without URLs or response bodies', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const trace = new PlaybackPerfTrace({ runId: 'run-network', testCaseId: 13 });
  const step20 = trace.beginStep(19, 'click', 'cdp');
  player._perfTraceByTab.set(1, trace);
  player._perfStepByTab.set(1, { perf: trace, step: step20 });
  player._cdpDiagnosticsByTab.set(1, { network: [], console: [], active_step: null, last_step: null });
  const event = (method, params) => player._recordCdpDiagnosticEvent({ tabId: 1 }, method, params);
  event('Network.requestWillBeSent', {
    requestId: 'secret-cdp-id', type: 'XHR',
    request: { method: 'POST', url: 'https://test.local/datasource/table/listNew?token=secret-token' },
  });
  trace.endStep(step20, 'success');
  const step21 = trace.beginStep(20, 'click', 'cdp');
  player._perfStepByTab.set(1, { perf: trace, step: step21 });
  event('Network.responseReceived', {
    requestId: 'secret-cdp-id', type: 'XHR', response: { status: 200 },
  });
  event('Network.loadingFinished', { requestId: 'secret-cdp-id', encodedDataLength: 621 });
  event('Network.requestWillBeSent', {
    requestId: 'second-id', type: 'Fetch',
    request: { method: 'GET', url: 'https://test.local/private?secret=another-secret' },
  });
  event('Network.loadingFailed', { requestId: 'second-id', type: 'Fetch', errorText: 'net::ERR_TIMED_OUT' });
  event('Network.requestWillBeSent', {
    requestId: 'pending-id', type: 'XHR',
    request: { method: 'POST', url: 'https://test.local/datasource/table/listNew?token=pending-secret' },
  });
  event('Runtime.exceptionThrown', { exceptionDetails: {
    exception: { className: 'TypeError', description: 'secret exception details' },
  } });
  trace.endStep(step21, 'failed');

  const result = trace.snapshot('failed');
  assert.deepEqual(result.network_requests.map(({ kind, state, status, step_index }) =>
    [kind, state, status, step_index]), [
    ['table_list', 'finished', 200, 19],
    ['other_api', 'failed', null, 20],
    ['table_list', 'pending', null, 20],
  ]);
  assert.equal(result.network_requests[0].encoded_bytes, 621);
  assert.equal(result.network_requests[1].error_kind, 'timeout');
  assert.ok(result.network_requests[2].pending_age_ms >= 0);
  assert.equal(result.script_exceptions[0].type, 'TypeError');
  assert.equal(result.script_exceptions[0].step_index, 20);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|another-secret|pending-secret|secret-cdp-id|secret exception details/);
});

test('developer trace records bounded hit-test checks without exposing selector text', () => {
  const trace = new PlaybackPerfTrace({ runId: 'run-hit', testCaseId: 13 });
  const step = trace.beginStep(23, 'click', 'cdp');
  for (let i = 0; i < 70; i++) {
    trace.noteUncoveredCheck(step, {
      phase: 'recheck', attempt: i, elapsedMs: i * 300,
      loadingUi: false, targetFound: true, hitOk: false,
      hit: 'li.ivu-select-item.secret-value', via: 'meta-component_root_sibling',
      hitDiagnostic: {
        viewport_width: 1440, viewport_height: 900,
        target_rect: { left: 100, top: 200, width: 80, height: 32, text: 'secret-value' },
        blocker_rect: { left: 95, top: 195, width: 200, height: 300 },
        blocker_style: { display: 'rendered', visibility: 'visible', opacity: 0.5,
          effective_opacity: 0.25, pointer_events: 'auto', z_index: 1000 },
        dropdown_rect: null, dropdown_style: null,
        blocker_owner_found: true, blocker_owner_open: true,
        target_owner_found: true, target_owner_open: false,
        same_control: false, open_select_count: 1,
        raw_selector: '#secret-value',
      },
    });
  }
  trace.endStep(step, 'failed');

  const result = trace.snapshot('failed').steps[0];
  assert.equal(result.uncovered_checks.length, 64);
  assert.equal(result.uncovered_checks_dropped, 6);
  assert.equal(result.uncovered_checks[0].blocker, 'select_option');
  assert.equal(result.uncovered_checks.at(-1).attempt, 69);
  assert.equal(result.uncovered_checks[0].locator_via, 'meta-component_root_sibling');
  assert.equal(result.uncovered_checks[0].hit_diagnostic.blocker_owner_open, true);
  assert.equal(result.uncovered_checks[0].hit_diagnostic.target_owner_open, false);
  assert.equal(result.uncovered_checks[0].hit_diagnostic.blocker_style.effective_opacity, 0.25);
  assert.deepEqual(result.uncovered_checks[0].hit_diagnostic.target_rect,
    { left: 100, top: 200, width: 80, height: 32 });
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('developer hit-test trace distinguishes stale locator results from persistent loading', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const originalLimit = PlayerManager.CLICK_COVERED_RETRY_MS;
  PlayerManager.CLICK_COVERED_RETRY_MS = 55;
  try {
    const run = async (loading) => {
      const player = new PlayerManager({}, {});
      const trace = new PlaybackPerfTrace({ runId: 'run-covered', testCaseId: 13 });
      const step = trace.beginStep(23, 'click', 'cdp');
      player._perfStepByTab.set(1, { perf: trace, step });
      player._sleep = () => new Promise(resolve => setTimeout(resolve, 25));
      player._isPageLoadingUi = async () => loading;
      player._getElementBoxResult = async () => ({ ok: false, reason: 'not_found' });
      const box = { hitOk: false, hit: 'li.ivu-select-item', via: 'meta-component_root_sibling' };
      await player._waitForClickUncoveredCDP(1, { target_selector: '#target' }, box);
      trace.endStep(step, 'failed');
      return trace.snapshot('failed').steps[0].uncovered_checks;
    };

    const stale = await run(false);
    assert.ok(stale.some(check => check.phase === 'recheck' && check.target_found === false && check.cached_box));
    assert.equal(stale.at(-1).reason, 'timeout');
    const loading = await run(true);
    assert.ok(loading.some(check => check.phase === 'loading' && check.loading_ui === true));
    assert.equal(loading.at(-1).cached_box, true);
  } finally {
    PlayerManager.CLICK_COVERED_RETRY_MS = originalLimit;
  }
});

test('developer trace separates CDP mouse command timings without changing click order', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const trace = new PlaybackPerfTrace({ runId: 'run-mouse', testCaseId: 14 });
  const step = trace.beginStep(0, 'click', 'cdp');
  player._perfStepByTab.set(1, { perf: trace, step });
  const sent = [];
  player._cdpSend = async (_tabId, method, params) => { sent.push([method, params.type]); return {}; };
  player._sleep = async () => {};

  await player._cdpClick(1, 10, 20);
  trace.endStep(step, 'success');

  assert.deepEqual(sent.map(([, type]) => type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  const snapshot = trace.snapshot('passed').steps[0];
  assert.equal(snapshot.nested_count.cdp_mouse_move, 1);
  assert.equal(snapshot.nested_count.cdp_mouse_press, 1);
  assert.equal(snapshot.nested_count.cdp_mouse_release, 1);
  assert.ok(snapshot.nested_ms.cdp_mouse_move >= 0);
});

test('ordinary click dispatches press before a delayed mouse move ACK and still releases', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const sent = [];
  let finishMove;
  player._cdpSend = async (_tabId, _method, params) => {
    sent.push(params.type);
    if (params.type === 'mouseMoved') return new Promise(resolve => { finishMove = resolve; });
    return {};
  };
  player._sleep = async () => {};

  const click = player._cdpClick(1, 10, 20, { pipelineMove: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  finishMove({});
  await click;
});

test('pipelined click releases the button when press reports an error', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const sent = [];
  player._cdpSend = async (_tabId, _method, params) => {
    sent.push(params.type);
    if (params.type === 'mousePressed') throw new Error('press failed');
    return {};
  };
  player._sleep = async () => {};

  await assert.rejects(player._cdpClick(1, 10, 20, { pipelineMove: true }), (error) => {
    assert.match(error.message, /press failed/);
    assert.equal(error.cdpClickDeliveryUncertain, true);
    return true;
  });
  assert.deepEqual(sent, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('non-pipelined click waits for mouse move before pressing', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const sent = [];
  let finishMove;
  player._cdpSend = async (_tabId, _method, params) => {
    sent.push(params.type);
    if (params.type === 'mouseMoved') return new Promise(resolve => { finishMove = resolve; });
    return {};
  };
  player._sleep = async () => {};

  const click = player._cdpClick(1, 10, 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['mouseMoved']);
  finishMove({});
  await click;
  assert.deepEqual(sent, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('developer loading probe records visibility while preserving its boolean result', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const trace = new PlaybackPerfTrace({ runId: 'run-probe', testCaseId: 15 });
  const step = trace.beginStep(0, 'click', 'cdp');
  player._perfStepByTab.set(1, { perf: trace, step });
  player._cdpSend = async (_tabId, _method, params) => {
    assert.match(params.expression, /visibility_state: document\.visibilityState/);
    return { result: { value: { loading: true, visibility_state: 'hidden', document_has_focus: false } } };
  };

  assert.equal(await player._isPageLoadingUi(1, 'step_start'), true);
  assert.equal(trace.snapshot('passed').steps[0].page_state_events[0].visibility_state, 'hidden');
});

test('developer loading probe identifies a spinner and a missing target without changing loading detection', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const hiddenParent = { parentElement: null, getAttribute: () => '' };
  const spinner = {
    parentElement: hiddenParent, getAttribute: () => '',
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
  };
  let targetPresent = false;
  const documentMock = {
    visibilityState: 'hidden', hasFocus: () => true,
    querySelector: (selector) => selector === '#target' && targetPresent ? {} : null,
    querySelectorAll: (selector) => selector.includes('.ivu-spin-main') ? [spinner] : [],
  };
  const windowMock = { getComputedStyle: (node) => ({
    display: 'block', visibility: 'visible', opacity: node === hiddenParent ? '0' : '1',
  }) };
  const evaluate = () => Function('document', 'window',
    `return ${PlayerManager._pageLoadingUiStateCheck('#target')}`)(documentMock, windowMock);

  const loading = evaluate();
  assert.equal(loading.loading, true);
  assert.equal(loading.loading_marker, 'ivu_spin');
  assert.equal(loading.marker_effectively_visible, false);
  assert.equal(loading.spinner_effectively_visible, false);
  assert.equal(loading.target_present, false);
  targetPresent = true;
  assert.equal(evaluate().target_present, true);
});

test('CDP locator attempts are attributed to the active developer trace step', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const trace = new PlaybackPerfTrace({ runId: 'run-3', testCaseId: 14 });
  const step = trace.beginStep(0, 'click', 'cdp');
  player._perfStepByTab.set(1, { perf: trace, step });
  player._throwIfPageError = async () => {};
  player._isPageLoadingUi = async () => false;
  player._buildFindCode = () => '';
  player._cdpSend = async () => ({ result: { value: { x: 10, y: 20 } } });

  const result = await player._getElementBoxResult(1, '#button');
  trace.endStep(step, 'success');
  assert.equal(result.ok, true);
  assert.equal(trace.snapshot('passed').steps[0].nested_count.locator, 1);
});

test('runtime target diagnostics probe once without entering the locator retry loop', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  let probes = 0;
  player._buildFindCode = () => 'find target';
  player._getElementBoxResult = async () => { throw new Error('retry loop should not run'); };
  player._cdpSend = async () => { probes += 1; return { result: { value: null } }; };

  const result = await player._collectRuntimeStepTarget(1, {
    action_type: 'click', target_selector: '#missing', target_xpath: '', locator_meta: null,
  }, true);

  assert.equal(result, null);
  assert.equal(probes, 1);
});

test('locator respects an expired shared step deadline when loading is not being waited on', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  player._locatorDeadlineByTab.set(1, { ctx: {}, deadline: Date.now() - 1 });
  player._cdpSend = async () => { throw new Error('deadline should stop lookup'); };

  const result = await player._getElementBoxResult(1, '#missing');
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
});

test('an actionable target is found even while another part of the page is loading', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  player._throwIfPageError = async () => {};
  player._isPageLoadingUi = async () => { throw new Error('actionable target should not wait for global Loading'); };
  player._cdpSend = async () => ({ result: { value: { x: 10, y: 20, hitOk: true } } });

  const result = await player._getElementBoxResult(1, '#button');
  assert.equal(result.ok, true);
  assert.equal(result.box.hitOk, true);
});

test('locator waits for Loading to clear when the target is still absent', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const budget = { ctx: {}, deadline: Date.now() + 20, loadingWallEnd: Date.now() + 500 };
  const initialDeadline = budget.deadline;
  player._locatorDeadlineByTab.set(1, budget);
  player._throwIfPageError = async () => {};
  let loadingPolls = 0;
  player._isPageLoadingUi = async () => ++loadingPolls <= 2;
  player._sleep = () => new Promise(resolve => setTimeout(resolve, 50));
  player._buildFindCode = () => 'find target';
  let findProbes = 0;
  player._cdpSend = async () => {
    findProbes += 1;
    return { result: { value: loadingPolls >= 3 ? { x: 10, y: 20 } : null } };
  };

  const result = await player._getElementBoxResult(1, '#button');
  assert.equal(result.ok, true);
  assert.ok(findProbes >= 2);
  assert.ok(budget.deadline >= initialDeadline + 50, 'Loading should extend the shared locator deadline');
});

test('locator resumes when its target appears while unrelated Loading remains', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  player._locatorDeadlineByTab.set(1, {
    ctx: {}, deadline: null, loadingWallEnd: null,
  });
  player._throwIfPageError = async () => {};
  player._isPageLoadingUi = async () => true;
  player._sleep = () => new Promise(resolve => setTimeout(resolve, 5));
  let probes = 0;
  player._cdpSend = async () => ({ result: {
    value: ++probes >= 3 ? { x: 10, y: 20, hitOk: true } : null,
  } });

  const result = await player._getElementBoxResult(1, '#button');
  assert.equal(result.ok, true);
  assert.equal(probes, 3);
});

test('locator stops with a Loading-specific error when the step loading limit expires', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  player._locatorDeadlineByTab.set(1, {
    ctx: {}, deadline: Date.now() + 100, loadingWallEnd: Date.now() + 20,
  });
  player._throwIfPageError = async () => {};
  player._isPageLoadingUi = async () => true;
  player._sleep = () => new Promise(resolve => setTimeout(resolve, 5));
  player._cdpSend = async () => ({ result: { value: null } });

  await assert.rejects(player._getElementBoxResult(1, '#button'), /页面加载未结束/);
});

test('step locator budget begins with the first locator after slow diagnostics', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const originalLimit = PlayerManager.STEP_LOCATOR_WALL_MS;
  PlayerManager.STEP_LOCATOR_WALL_MS = 20;
  try {
    const budget = { ctx: {}, deadline: null, loadingWallEnd: null };
    player._locatorDeadlineByTab.set(1, budget);
    await new Promise(resolve => setTimeout(resolve, 35));
    player._throwIfPageError = async () => {};
    player._cdpSend = async () => ({ result: { value: { x: 10, y: 20, hitOk: true } } });

    const firstLocatorAt = Date.now();
    const result = await player._getElementBoxResult(1, '#button');
    assert.equal(result.ok, true);
    assert.ok(budget.deadline >= firstLocatorAt + PlayerManager.STEP_LOCATOR_WALL_MS);
  } finally {
    PlayerManager.STEP_LOCATOR_WALL_MS = originalLimit;
  }
});

test('developer trace clears visible emulation status when CDP falls back', async () => {
  globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const trace = new PlaybackPerfTrace({ runId: 'run-cdp-fallback', testCaseId: 15 });
  const ctx = { emulateVisiblePage: true, visiblePageEmulationActive: true, networkDiagnosticsEnabled: true };

  PlayerManager._syncPerfCdpState(trace, ctx, true);
  assert.equal(trace.visiblePageEmulation, 'enabled');
  assert.equal(trace.networkCaptureEnabled, true);
  PlayerManager._syncPerfCdpState(trace, ctx, false);
  assert.equal(trace.visiblePageEmulation, 'unavailable');
  assert.equal(trace.networkCaptureEnabled, false);
});

test('failed tab switch clears the previous tab visibility state after detach', async () => {
  globalThis.chrome = {
    debugger: { onEvent: { addListener() {} } },
    tabs: { update: async () => {} },
  };
  const { PlayerManager } = await import('../modules/player-manager.js');
  const player = new PlayerManager({}, {});
  const trace = new PlaybackPerfTrace({ runId: 'run-switch', testCaseId: 15 });
  const ctx = {
    debuggerAttached: true, emulateVisiblePage: true,
    visiblePageEmulationActive: true, networkDiagnosticsEnabled: true,
    tabRegistry: new Map(),
  };
  PlayerManager._syncPerfCdpState(trace, ctx, true);
  player._perfTraceByTab.set(1, trace);
  player._findPlaybackTabForContext = async () => ({ id: 2, url: 'https://example.test' });
  player._detachDebugger = async () => {
    ctx.debuggerAttached = false;
    ctx.visiblePageEmulationActive = false;
    player._perfTraceByTab.delete(1);
  };
  player._waitForTabLoad = async () => { throw new Error('target tab load failed'); };

  await assert.rejects(player._switchPlaybackContext(1, { value: '1' }, ctx, true, 'standard'),
    /target tab load failed/);
  assert.equal(trace.visiblePageEmulation, 'unavailable');
  assert.equal(trace.networkCaptureEnabled, false);
});
