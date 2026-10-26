import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../modules/agent-recording-browser.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

test('agent recording sends click and input through CDP trusted input', () => {
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /Input\.insertText/);
  assert.doesNotMatch(source, /dispatchEvent\s*\(/);
});

test('agent snapshot excludes the recorder toolbar from selectable refs', () => {
  assert.match(source, /#__at_toolbar__/);
  assert.match(source, /data-cuecast-agent-ref/);
});

test('agent recording supports compact snapshots and semantic batch plans', () => {
  assert.match(source, /max_elements/);
  assert.match(source, /max_page_text/);
  assert.match(source, /resolveSemanticTarget/);
  assert.match(source, /executeSemanticRecordingPlan/);
  assert.match(source, /needs_attention/);
  assert.match(source, /command\.type === 'execute_plan'/);
});

test('agent sensitive inputs arm recorder masking before trusted input is dispatched', () => {
  assert.match(source, /armNextInputSensitive\(tabId, details, step\.value\)/);
  assert.match(source, /armNextInputSensitive\(tabId, details, request\.value\)/);
});

test('agent recording retries start confirmation from persisted active state', () => {
  assert.match(backgroundSource, /startConfirmed: false/);
  assert.match(backgroundSource, /active\.startConfirmed !== true/);
  assert.match(backgroundSource, /active\.startConfirmed = true/);
});
