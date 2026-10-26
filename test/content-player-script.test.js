import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content/player.js', import.meta.url), 'utf8');

test('player content script remains directly injectable without module syntax', () => {
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /^\s*export\s/m);
});

test('player content script keeps semantic visibility support inline', () => {
  assert.match(source, /function resolveSemanticVisibilityTarget\(/);
  assert.match(source, /semantic_target_visible/);
});

test('DOM fallback searches other collection roots only after the recorded root has no exact match', () => {
  assert.match(source, /const preferredRoot = Number\.isInteger\(rootIndex\)/);
  assert.match(source, /if \(!preferredRoot \|\| matches\.length === 0\)/);
  assert.match(source, /const semanticTexts = \(item\)/);
  assert.match(source, /values\.indexOf\(norm\(field\.value\)\) >= 0/);
  assert.doesNotMatch(source, /norm\(item\.innerText \|\| item\.textContent\)\.includes\(norm\(field\.value\)\)/);
});
