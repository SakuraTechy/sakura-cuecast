import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlaybackWindowMaximized } from '../modules/playback-window.js';

test('maximizes a background window without changing focus when Chrome accepts it', async () => {
  const previousChrome = globalThis.chrome;
  const calls = [];
  const playback = { id: 20, state: 'normal', focused: false };
  globalThis.chrome = {
    windows: {
      get: async () => ({ ...playback }),
      update: async (id, changes) => {
        calls.push({ id, changes });
        Object.assign(playback, changes);
        return { ...playback };
      },
      getLastFocused: async () => { throw new Error('focus lookup should not run'); },
    },
  };
  try {
    const result = await ensurePlaybackWindowMaximized(20, { settleMs: 0 });
    assert.equal(result.state, 'maximized');
    assert.equal(playback.focused, false);
    assert.deepEqual(calls, [{ id: 20, changes: { state: 'maximized' } }]);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('recovers an ignored background maximize and restores the original focus', async () => {
  const previousChrome = globalThis.chrome;
  const calls = [];
  const playback = { id: 20, state: 'normal', focused: false };
  const original = { id: 10, state: 'normal', focused: true };
  globalThis.chrome = {
    windows: {
      get: async () => ({ ...playback }),
      getLastFocused: async () => ({ ...original }),
      update: async (id, changes) => {
        calls.push({ id, changes });
        if (id === 20 && changes.focused !== true) return { ...playback };
        if (id === 20) {
          Object.assign(playback, changes);
          original.focused = false;
          return { ...playback };
        }
        original.focused = true;
        playback.focused = false;
        return { ...original };
      },
    },
  };
  try {
    const result = await ensurePlaybackWindowMaximized(20, { settleMs: 0 });
    assert.equal(result.state, 'maximized');
    assert.equal(original.focused, true);
    assert.equal(playback.focused, false);
    assert.deepEqual(calls, [
      { id: 20, changes: { state: 'maximized' } },
      { id: 20, changes: { state: 'maximized', focused: true } },
      { id: 10, changes: { focused: true } },
    ]);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('continues at the available size without stealing focus from another application', async () => {
  const previousChrome = globalThis.chrome;
  const playback = { id: 20, state: 'normal', focused: false };
  let focusedUpdate = false;
  globalThis.chrome = {
    windows: {
      get: async () => ({ ...playback }),
      getLastFocused: async () => ({ id: 10, focused: false }),
      update: async (_id, changes) => {
        if (changes.focused) focusedUpdate = true;
        return { ...playback };
      },
    },
  };
  try {
    const result = await ensurePlaybackWindowMaximized(20, { settleMs: 0 });
    assert.equal(result.state, 'normal');
    assert.equal(focusedUpdate, false);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('continues if focus-assisted maximize is rejected after restoring the original window', async () => {
  const previousChrome = globalThis.chrome;
  const playback = { id: 20, state: 'normal', focused: false };
  const original = { id: 10, state: 'normal', focused: true };
  let restored = false;
  globalThis.chrome = {
    windows: {
      get: async () => ({ ...playback }),
      getLastFocused: async () => ({ ...original }),
      update: async (id, changes) => {
        if (id === 20 && changes.focused) throw new Error('maximize denied');
        if (id === 10 && changes.focused) restored = true;
        return id === 20 ? { ...playback } : { ...original };
      },
    },
  };
  try {
    const result = await ensurePlaybackWindowMaximized(20, { settleMs: 0 });
    assert.equal(result.state, 'normal');
    assert.equal(restored, true);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
