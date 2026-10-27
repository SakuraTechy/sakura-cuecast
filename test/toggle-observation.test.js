import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cdpPlayer = readFileSync(new URL('../modules/player-manager.js', import.meta.url), 'utf8');
const domPlayer = readFileSync(new URL('../content/player.js', import.meta.url), 'utf8');

test('native toggle state mismatch is diagnostic observation, not a blocking failure', () => {
  assert.match(cdpPlayer, /const toggleResult = await this\._waitForNativeToggleState\(tabId, step, expectedChecked, 250\)/);
  assert.match(cdpPlayer, /mode: 'observe',[\s\S]*?type: 'toggle_checked'/);
  assert.doesNotMatch(cdpPlayer, /Selection control did not reach the expected state/);
  assert.match(domPlayer, /await waitForNativeToggleState\(nativeToggle, expectedChecked, 250\)/);
  assert.doesNotMatch(domPlayer, /Selection control did not reach the expected state/);
});
