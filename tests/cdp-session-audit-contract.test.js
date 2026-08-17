import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('执行历史会话审计白名单不包含浏览器内部标识或认证状态', async () => {
  const source = await readFile(path.join(projectRoot, 'modules/player-manager.js'), 'utf8');
  const start = source.indexOf('function buildSessionTransitionAudit');
  const end = source.indexOf('\n}\n', start) + 3;
  const auditFunction = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  for (const field of [
    'requestedMode',
    'appliedMode',
    'browserSessionSource',
    'resetCount',
    'navigationDecision',
  ]) {
    assert.match(auditFunction, new RegExp(field));
  }
  assert.doesNotMatch(auditFunction, /contextId|targetId|tabId|cookie|snapshot/i);
});
