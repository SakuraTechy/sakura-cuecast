import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('popup verifies and persists a configurable CueCast instance', () => {
  const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
  assert.match(source, /cc-platform-config-v1/);
  assert.match(source, /\/api\/system\/instance/);
  assert.match(source, /instanceId/);
  assert.match(source, /chrome\.storage\.local\.set/);
});

test('background trusts the configured exact origin and dynamically injects the bridge', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(source, /url\.origin === configuredPlatformOrigin/);
  assert.match(source, /loadPlatformConfig/);
  assert.match(source, /injectBridgeIntoOpenTabs/);
  assert.match(source, /AT_CONFIG_UPDATED/);
});
