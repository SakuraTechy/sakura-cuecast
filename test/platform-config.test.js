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
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /url\.origin === configuredPlatformOrigin/);
  assert.match(source, /isPrivateIpv4Host/);
  assert.match(source, /loadPlatformConfig/);
  assert.match(source, /injectBridgeIntoOpenTabs/);
  assert.match(source, /AT_CONFIG_UPDATED/);
});

test('background trusts private deployment origins but rejects public HTTP origins', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function isPrivateIpv4Host(');
  const end = source.indexOf('\n}\n\nasync function loadPlatformConfig', start) + 2;
  assert.ok(start >= 0 && end > start, 'platform trust helpers must remain testable');
  const isTrustedPlatformUrl = new Function(
    `let configuredPlatformOrigin = '';\n${source.slice(start, end)}; return isTrustedPlatformUrl;`,
  )();

  assert.equal(isTrustedPlatformUrl('http://172.19.5.228:5183/automation/automationUiScene'), true);
  assert.equal(isTrustedPlatformUrl('https://192.168.1.20/automation'), true);
  assert.equal(isTrustedPlatformUrl('http://10.20.30.40/automation'), true);
  assert.equal(isTrustedPlatformUrl('http://172.32.5.228:5183/automation'), false);
  assert.equal(isTrustedPlatformUrl('https://203.0.113.20/automation'), false);
});

test('manifest injects the bridge on HTTP and HTTPS deployment pages', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://*/*', 'https://*/*']);
});

test('background accepts same-origin root and /api platform bases', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('function resolvePlatformApiBase(');
  const end = source.indexOf('\n}\n\nconst state =', start) + 2;
  assert.ok(start >= 0 && end > start, 'resolvePlatformApiBase function must remain testable');
  const resolvePlatformApiBase = new Function(
    'isTrustedPlatformUrl',
    `${source.slice(start, end)}; return resolvePlatformApiBase;`,
  )(() => true);

  assert.equal(
    resolvePlatformApiBase('http://172.19.5.51:22', 'http://172.19.5.51:22/automation'),
    'http://172.19.5.51:22',
  );
  assert.equal(
    resolvePlatformApiBase('http://172.19.5.51:22/api/', 'http://172.19.5.51:22/automation'),
    'http://172.19.5.51:22/api',
  );
  assert.equal(
    resolvePlatformApiBase('/dev-api', 'http://172.19.5.51:22/automation'),
    'http://172.19.5.51:22/dev-api',
  );
  assert.equal(
    resolvePlatformApiBase('http://172.19.5.51:8000/api', 'http://172.19.5.51:22/automation'),
    'http://172.19.5.51:8000/api',
  );
  assert.equal(
    resolvePlatformApiBase('http://172.19.5.52:8000/api', 'http://172.19.5.51:22/automation'),
    '',
  );
  assert.equal(
    resolvePlatformApiBase('https://172.19.5.51:8000/api', 'http://172.19.5.51:22/automation'),
    '',
  );
  assert.equal(
    resolvePlatformApiBase('http://172.19.5.51:8000/dev-api?x=1', 'http://172.19.5.51:22/automation'),
    '',
  );
});
