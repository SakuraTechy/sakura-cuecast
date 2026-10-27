import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.chrome = {
  debugger: { onEvent: { addListener() {} } },
  tabs: {
    get: async (id) => ({ id, windowId: 7 }),
    update: async (id, options) => { calls.push(['tab', id, options]); },
    remove: async (id) => { calls.push(['remove', id]); },
  },
  windows: {
    update: async (id, options) => { calls.push(['window', id, options]); },
  },
  scripting: { executeScript: async () => {} },
};

const { PlayerManager } = await import('../modules/player-manager.js');

test('playback activates its tab without focusing the window; explicit view focuses it', async () => {
  calls.length = 0;
  const player = new PlayerManager({}, {});
  await player._bringTabToForeground(11);
  assert.deepEqual(calls, [['tab', 11, { active: true }]]);

  player._playTabByCaseId.set(42, 11);
  assert.deepEqual(await player.focusPlayTab(42), { ok: true });
  assert.deepEqual(calls.slice(1), [
    ['tab', 11, { active: true }],
    ['window', 7, { focused: true }],
  ]);
});

test('switch_context keeps the target tab active without focusing its window', async () => {
  calls.length = 0;
  const player = new PlayerManager({}, {});
  player._extractTabContext = () => ({ index: 1, url: 'https://example.com/next' });
  player._findPlaybackTabForContext = async () => ({ id: 12, windowId: 8, url: 'https://example.com/next' });
  player._waitForTabLoad = async () => {};
  player._attachDebugger = async () => true;
  const ctx = {
    debuggerAttached: false,
    tabRegistry: new Map([[0, { tabId: 11 }]]),
    pageErrorCheckEnabled: false,
  };

  assert.deepEqual(await player._switchPlaybackContext(11, {}, ctx, false, ''), {
    tabId: 12,
    cdpAvailable: true,
  });
  assert.deepEqual(calls, [['tab', 12, { active: true }]]);
});

test('stopping a Runner run closes its playback tab and leaves other runs alone', async () => {
  calls.length = 0;
  const player = new PlayerManager({}, {});
  const runner = { runId: 'run_1', playbackPurpose: 'runner_plan', tabId: 11, stopped: false };
  const other = { runId: 'run_2', playbackPurpose: 'runner_plan', tabId: 12, stopped: false };
  const interactive = { runId: 'run_1', playbackPurpose: 'web', tabId: 13, stopped: false };
  player._playContexts.add(runner);
  player._playContexts.add(other);
  player._playContexts.add(interactive);
  assert.deepEqual(await player.stop('run_1'), { ok: true });
  assert.equal(runner.stopped, true);
  assert.equal(interactive.stopped, true);
  assert.equal(other.stopped, false);
  assert.deepEqual(calls, [['remove', 11]]);
});
