import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorderSource = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');

function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = recorderSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist in recorder.js`);
  const bodyStart = recorderSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < recorderSource.length; index += 1) {
    if (recorderSource[index] === '{') depth += 1;
    if (recorderSource[index] === '}') depth -= 1;
    if (depth === 0) return recorderSource.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

function makeDetector(getOverlayAncestor) {
  const source = extractFunctionSource('isInsideDropdownMenuLayer');
  return Function('getOverlayAncestor', `return (${source});`)(getOverlayAncestor);
}

test('persistent ARIA navigation menu is not treated as a dropdown overlay', () => {
  const menu = { id: 'sidebar-menu' };
  const item = {
    closest(selector) {
      if (selector === '[role="menu"],[role="listbox"]') return menu;
      return null;
    },
  };
  const isInsideDropdownMenuLayer = makeDetector(() => null);

  assert.equal(isInsideDropdownMenuLayer(item), false);
});

test('ARIA menu inside a portal overlay still suppresses internal hover recording', () => {
  const menu = { id: 'portal-menu' };
  const portal = { id: 'portal-root' };
  const item = {
    closest(selector) {
      if (selector === '[role="menu"],[role="listbox"]') return menu;
      return null;
    },
  };
  const isInsideDropdownMenuLayer = makeDetector((node) => node === menu ? portal : null);

  assert.equal(isInsideDropdownMenuLayer(item), true);
});

test('known component dropdown class remains an overlay without an ARIA role', () => {
  const knownOverlay = { id: 'element-popper' };
  const item = {
    closest(selector) {
      if (selector.includes('.el-popper')) return knownOverlay;
      return null;
    },
  };
  const isInsideDropdownMenuLayer = makeDetector(() => null);

  assert.equal(isInsideDropdownMenuLayer(item), true);
});
