import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerWindowRegistry } from '../modules/runner-windows.js';

function storage() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(items) { Object.assign(values, items); },
  };
}

test('Runner recovery closes every recorded window after a tab switch', async () => {
  const saved = storage();
  const closed = [];
  const registry = new RunnerWindowRegistry(saved, {
    async get(id) { return { tabs: [{ id: id === 10 ? 101 : 999 }] }; },
    async remove(id) { closed.push(id); },
  });
  await registry.track('run_1', 10, 101);
  await registry.track('run_1', 20, 202);
  await registry.close('run_1');
  assert.deepEqual(closed, [10, 20]);
  assert.deepEqual(saved.values['cc-runner-active-windows-v1'], {});
});

test('a new browser session discards old window identifiers', async () => {
  const saved = storage();
  const registry = new RunnerWindowRegistry(saved, { async get() { throw new Error('unexpected'); } });
  await registry.track('run_1', 10, 101);
  await registry.clearAll();
  await registry.close('run_1');
  assert.deepEqual(saved.values['cc-runner-active-windows-v1'], {});
});

test('Runner recovery retains its marker when closing the window fails', async () => {
  const saved = storage();
  const registry = new RunnerWindowRegistry(saved, {
    async get() { return { tabs: [{ id: 101 }] }; },
    async remove() { throw new Error('window is busy'); },
  });
  await registry.track('run_1', 10, 101);
  await assert.rejects(() => registry.close('run_1'), /window is busy/);
  assert.equal(saved.values['cc-runner-active-windows-v1'].run_1.length, 1);
});
