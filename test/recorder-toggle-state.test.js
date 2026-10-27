import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorderSource = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');

test('checkbox state is captured before native click activation', () => {
  assert.match(recorderSource, /document\.addEventListener\('pointerdown', rememberNativeToggleStateBeforeActivation, true\)/);
  assert.match(recorderSource, /checkedBefore: recordedToggleCheckedState\(control\)/);
  assert.match(recorderSource, /const checkedBefore = consumeNativeToggleStateBeforeClick\(control\)/);
  assert.match(recorderSource, /expected_checked: kind === 'radio' \? true : !checkedBefore/);
});

test('keyboard activation and recording lifecycle clear the pending toggle snapshot', () => {
  assert.match(recorderSource, /event\.key === ' ' \|\| event\.key === 'Spacebar' \|\| event\.key === 'Enter'/);
  assert.match(recorderSource, /document\.removeEventListener\('pointerdown', rememberNativeToggleStateBeforeActivation, true\)/);
  assert.match(recorderSource, /pendingNativeToggleActivation = null/);
});
