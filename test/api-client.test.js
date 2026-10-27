import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../modules/api-client.js';

test('getTestCase retries a transient fetch failed error', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return { json: async () => ({ code: 0, data: { id: 7 } }) };
  };

  const client = new ApiClient(() => 'https://example.test/api', () => 'token');
  const result = await client.getTestCase(7);

  assert.equal(attempts, 2);
  assert.equal(result.data.id, 7);
});
