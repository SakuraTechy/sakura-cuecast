import test from 'node:test';
import assert from 'node:assert/strict';
import { RecorderManager } from '../modules/recorder-manager.js';

test('explicit agent sensitivity is applied before a captured input step is persisted', () => {
  const manager = new RecorderManager({ recordingLocale: 'zh' }, {});
  manager.armNextInputSensitive(17, { selector: '#api-key', xpath: '//*[@id="api-key"]' }, 'top-secret');
  const step = {
    action_type: 'input',
    target_selector: '#api-key',
    target_xpath: '//*[@id="api-key"]',
    value: 'top-secret',
    value_masked: 0,
    description: '输入 "top-secret" 到 input',
    locator_meta: {
      candidates: [{ type: 'text', value: 'top-secret' }],
      context: { preview: 'prefix top-secret suffix' },
    },
    screenshot: 'data:image/jpeg;base64,sensitive',
  };

  manager._applyPendingSensitiveInput(step, 17);

  assert.equal(step.value_masked, 1);
  assert.equal(step.description, '输入敏感值');
  assert.doesNotMatch(JSON.stringify(step.locator_meta), /top-secret/);
  assert.equal(step.screenshot, '');
  assert.equal(manager._pendingSensitiveInput, null);
});

test('explicit sensitivity does not mask an unrelated captured input', () => {
  const manager = new RecorderManager({ recordingLocale: 'en' }, {});
  manager.armNextInputSensitive(17, { selector: '#api-key' }, 'top-secret');
  const step = { action_type: 'input', target_selector: '#search', value: 'public', value_masked: 0 };

  manager._applyPendingSensitiveInput(step, 17);

  assert.equal(step.value_masked, 0);
  assert.notEqual(manager._pendingSensitiveInput, null);
});
