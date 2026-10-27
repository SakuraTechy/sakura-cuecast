import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.chrome = { debugger: { onEvent: { addListener() {} } } };
const { PlayerManager } = await import('../modules/player-manager.js');

const TARGET_CODE = '45138100001327000001-LAB-A';

function fixedPaneFixture(duplicateBusinessRow = false, options = {}) {
  const { framework = 'el', panes = ['main', 'left', 'right'], identityPanes = panes, misalignFixed = false } = options;
  const root = {};
  const fixedLeft = {};
  const fixedRight = {};
  const rows = [];
  const buttons = {};
  const codes = [TARGET_CODE, duplicateBusinessRow ? TARGET_CODE : '42011300001327000002-LAB-B'];
  const fixedSelector = '.ivu-table-fixed,.ivu-table-fixed-right,.el-table__fixed,.el-table__fixed-right,.ant-table-fixed-left,.ant-table-fixed-right';
  for (const pane of panes) {
    codes.forEach((code, index) => {
      const top = 48 + index * 48 + (misalignFixed && pane === 'left' ? 12 : 0);
      const button = {
        tagName: 'BUTTON', innerText: '手动派发', textContent: '手动派发',
        getBoundingClientRect: () => ({ left: 820, top: top + 12, width: pane === 'left' ? 0 : 70, height: 24 }),
        contains: (node) => node === button,
        scrollIntoView() {},
      };
      const cells = [
        { innerText: '在线' },
        { innerText: identityPanes.includes(pane) ? code : `other-${pane}-${index}` },
        { innerText: `设备 ${index + 1}` },
        { innerText: '手动派发' },
      ];
      const row = {
        innerText: `在线 ${code} 设备 ${index + 1} 手动派发`,
        textContent: `在线 ${code} 设备 ${index + 1} 手动派发`,
        tagName: 'TR',
        getBoundingClientRect: () => ({ left: pane === 'right' ? 780 : 0, top, bottom: top + 48, width: pane === 'left' ? 300 : 900, height: 48 }),
        getAttribute: () => null,
        closest: (selector) => selector === `.${framework}-table` ? root
          : selector === fixedSelector ? (pane === 'left' ? fixedLeft : pane === 'right' ? fixedRight : null) : null,
        querySelectorAll: (selector) => selector.startsWith(':scope >') ? cells : [button],
        querySelector: () => button,
        matches: () => false,
      };
      rows.push(row);
      buttons[`${pane}-${index}`] = button;
    });
  }
  root.querySelectorAll = () => rows;
  const documentMock = {
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    querySelectorAll: (selector) => selector === `.${framework}-table` ? [root] : [],
    elementFromPoint: (_x, y) => buttons[`${panes.includes('right') ? 'right' : 'main'}-${y < 96 ? 0 : 1}`],
  };
  const style = (node) => ({ display: node === buttons['left-0'] || node === buttons['left-1'] ? 'none' : 'block', visibility: 'visible' });
  const config = {
    collection: { kind: 'table', root: { framework, wrapper_index: 0 } },
    fields: [{ header: '设备编码', col_index: 1, value: TARGET_CODE }],
    identity: { mode: 'semantic', selected: [{ header: '设备编码', col_index: 1, value: TARGET_CODE }] },
    action: { css: 'td:last-child button', text: '手动派发', tag: 'button', scope: 'descendant' },
    recorded_row_index: 0,
    recorded_item_summary: `在线 ${TARGET_CODE}`,
    _collection_locator_mode: 'semantic',
  };
  return { config, documentMock, style, buttons };
}

test('semantic table locator treats fixed pane copies as one business row and clicks the hit-tested action', () => {
  const { config, documentMock, style, buttons } = fixedPaneFixture();
  const pick = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  const target = Function('document', 'getComputedStyle', `return (${pick});`)(documentMock, style);
  assert.equal(target, buttons['right-0']);

  const diagnostic = PlayerManager._collectionItemDiagnosticExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${diagnostic});`)(documentMock, style);
  assert.equal(result.status, 'matched');
  assert.equal(result.match_count, 1);
  assert.equal(result.dom_match_count, 3);
  assert.equal(result.fixed_copy_count, 2);
});

test('semantic table locator still rejects two distinct main rows with the same business code', () => {
  const { config, documentMock, style } = fixedPaneFixture(true);
  const pick = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  const target = Function('document', 'getComputedStyle', `return (${pick});`)(documentMock, style);
  assert.equal(target, null);

  const diagnostic = PlayerManager._collectionItemDiagnosticExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${diagnostic});`)(documentMock, style);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.match_count, 2);
  assert.equal(result.dom_match_count, 6);
});

test('semantic table locator directly resolves one ordinary row without fixed panes', () => {
  const { config, documentMock, style, buttons } = fixedPaneFixture(false, { panes: ['main'] });
  const pick = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  assert.equal(Function('document', 'getComputedStyle', `return (${pick});`)(documentMock, style), buttons['main-0']);
});

test('semantic table locator maps a fixed-only identity to the logical row and clicks its right action', () => {
  const { config, documentMock, style, buttons } = fixedPaneFixture(false, { framework: 'ivu', identityPanes: ['left'] });
  const pick = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  const target = Function('document', 'getComputedStyle', `return (${pick});`)(documentMock, style);
  assert.equal(target, buttons['right-0']);

  const diagnostic = PlayerManager._collectionItemDiagnosticExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${diagnostic});`)(documentMock, style);
  assert.equal(result.status, 'matched');
  assert.equal(result.match_count, 1);
  assert.equal(result.dom_match_count, 1);
  assert.equal(result.fixed_copy_count, 1);
  assert.equal(result.unmapped_match_count, 0);
});

test('semantic table locator refuses a fixed-only identity when pane rows are not aligned', () => {
  const { config, documentMock, style } = fixedPaneFixture(false, { framework: 'ivu', identityPanes: ['left'], misalignFixed: true });
  const diagnostic = PlayerManager._collectionItemDiagnosticExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${diagnostic});`)(documentMock, style);
  assert.equal(result.status, 'unmapped');
  assert.equal(result.unmapped_match_count, 1);
});

test('semantic table locator rejects two logical rows whose identity appears only in fixed panes', () => {
  const { config, documentMock, style } = fixedPaneFixture(true, { framework: 'ivu', identityPanes: ['left'] });
  const diagnostic = PlayerManager._collectionItemDiagnosticExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${diagnostic});`)(documentMock, style);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.match_count, 2);
  assert.equal(result.dom_match_count, 2);
});

function domFallbackFinder(documentMock, style) {
  const source = readFileSync(new URL('../content/player.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function findCollectionItemByOrdinal(');
  const end = source.indexOf('  function resolveAssertionConfig(', start);
  return Function('document', 'window', 'getComputedStyle',
    `${source.slice(start, end)}\nreturn findCollectionItem;`)(documentMock, { getComputedStyle: style }, style);
}

test('DOM fallback uses the same logical row when only its fixed pane has the identity', () => {
  const { config, documentMock, style, buttons } = fixedPaneFixture(false, { framework: 'ivu', identityPanes: ['left'] });
  assert.equal(domFallbackFinder(documentMock, style)(config), buttons['right-0']);
});

test('DOM fallback refuses duplicate or unmapped fixed-only identities', () => {
  for (const [duplicate, misalignFixed] of [[true, false], [false, true]]) {
    const { config, documentMock, style } = fixedPaneFixture(duplicate, { framework: 'ivu', identityPanes: ['left'], misalignFixed });
    assert.equal(domFallbackFinder(documentMock, style)(config), null);
  }
});
