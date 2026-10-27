import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  debugger: {
    onEvent: { addListener() {}, removeListener() {} },
  },
  runtime: {
    id: 'cuecast-test',
    sendMessage: async () => {},
    getManifest: () => ({ version: 'test' }),
  },
  storage: {
    local: {
      get: async () => ({}),
    },
  },
  tabs: {
    query: (query, callback) => {
      if (typeof callback === 'function') {
        callback([]);
        return undefined;
      }
      return Promise.resolve([]);
    },
  },
  notifications: {
    create: async () => {},
  },
};

const { PlayerManager } = await import('../modules/player-manager.js');
const playerManagerSource = readFileSync(new URL('../modules/player-manager.js', import.meta.url), 'utf8');

test('CDP playback starts without referencing the step loop index during initialization', async () => {
  const state = { mode: 'idle', activePlayCount: 0 };
  const api = {
    getAdminPlaywrightCase: async () => ({
      data: {
        case_id: 'case-1',
        steps: [{ action_type: 'wait', value: 0 }],
        effective_execution_config: {
          browser_bootstrap_mode: 'none',
          start_url: '',
          page_error_check_enabled: 0,
          screenshot_mode: 'standard',
          step_timeout_ms: 6000,
          case_timeout_ms: 600000,
        },
      },
    }),
  };
  const player = new PlayerManager(state, api);
  player._sleep = async () => {};

  const result = await player.start('case-1', '', {
    adminCaseKey: 'case-1',
    batchId: 'batch-1',
    dataSource: 'admin',
    executionId: 'run-1',
    keepTabOpenAfterPlayback: true,
    suppressResultSave: true,
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(player.getActiveRuns().length, 0);
});

test('CDP element assertion reports the actual value instead of a temporal-dead-zone error', async () => {
  const player = new PlayerManager({}, {});
  player._waitForElementAssertionCDP = async () => ({
    via: 'css',
    matched_count: 1,
    visible_count: 1,
    value: 'actual text',
    attribute_present: true,
  });
  player._logAssertTextCdpDebug = () => {};

  await assert.rejects(
    () => player._executeAssertTextStepCDP(1, {
      action_type: 'assert_element_match',
      target_selector: '#target',
      match_mode: 'contains',
      expect: 'missing text',
    }, 'en_US'),
    (error) => {
      assert.equal(error?.operationAssertion?.actual?.preview, 'actual text');
      assert.equal(String(error?.message || '').includes("Cannot access 'evaluation' before initialization"), false);
      return true;
    },
  );
});

test('CDP assertion results are forwarded into the typed operation diagnostic', () => {
  assert.match(playerManagerSource, /let executionOperationAssertion = null;/);
  assert.match(playerManagerSource, /const assertionResult = await this\._executeAssertTextStepCDP\(/);
  assert.match(playerManagerSource, /const returnedAssertion = executionOutcome\?\.operationAssertion \|\| executionOutcome\?\.locator\?\.operationAssertion/);
  assert.match(playerManagerSource, /\.\.\.\(executionOperationAssertion \? \{ operation_assertion: executionOperationAssertion \} : \{\}\)/);
});

test('CDP action results retain the actual locator for the playback summary', async () => {
  const player = new PlayerManager({}, {});
  player._validateStepXpathsCDP = async () => {};
  player._getElementBoxResult = async () => ({
    ok: true,
    box: { via: 'meta-css_fallback' },
  });
  player._throwIfPageError = async () => {};
  player._setInputValueCDP = async () => {};
  player._getEffectiveWaitTimeout = () => 1;
  player._sleep = async () => {};

  const result = await player._executeStepCDP(1, {
    action_type: 'input',
    target_selector: '#name',
    locator_meta: {
      candidates: [{ type: 'css_fallback', value: '#name', score: 0.72 }],
    },
    value: 'Sakura',
  });

  assert.equal(result.locator.source, 'locator_meta.candidates[0]');
  assert.equal(result.locator.type, 'css_fallback');
  assert.equal(result.locator.value, '#name');
  assert.equal(result.locator.matchedCount, 1);
});

test('CDP locator diagnostics preserve collection candidates and recorded order', () => {
  const collectionValue = JSON.stringify({
    collection: { kind: 'table', root: { framework: 'html', wrapper_index: -1 } },
    fields: [{ kind: 'item_text', header: '业务对象', value: '编辑' }],
    recorded_row_index: 0,
    action: { css: 'td:last-child button', scope: 'descendant' },
  });
  const locatorMeta = {
    candidates: [
      { type: 'collection_item', value: collectionValue, score: 0.99 },
      { type: 'css_fallback', value: 'tbody > tr:first-child button', score: 0.72 },
      { type: 'text_exact_tag', value: 'button::编辑', score: 0.70 },
      { type: 'text_exact', value: '编辑', score: 0.66 },
      { type: 'xpath_fallback', value: "//button[normalize-space()='编辑']", score: 0.42 },
      { type: 'table_cell_xpath', value: '/html/body/table/tbody/tr[1]/td[3]', score: 0.34 },
      { type: 'table_cell_css', value: 'tbody > tr:nth-of-type(1) > td:nth-of-type(3)', score: 0.33 },
    ],
    context: {},
  };

  const diagnostics = PlayerManager._buildCdpLocatorDiagnostics(
    { locator_meta: locatorMeta, target_selector: '', target_xpath: '' },
    {
      source: 'locator_meta.candidates[0]',
      executionSource: 'cdp:meta-collection-item',
      type: 'collection_item',
      value: collectionValue,
      recordingScore: 0.99,
    },
    'passed',
    120,
  );

  assert.deepEqual(diagnostics.configured_locators.map((candidate) => candidate.type), [
    'collection_item',
    'css_fallback',
    'text_exact_tag',
    'text_exact',
    'xpath_fallback',
    'table_cell_xpath',
    'table_cell_css',
  ]);
  assert.equal(diagnostics.configured_candidate_count, 7);
  assert.equal(diagnostics.configured_locators[0].value, collectionValue);
});

test('historical collection identity in locator context is restored for CDP lookup and diagnostics', () => {
  const collectionConfig = {
    collection: { kind: 'table', root: { framework: 'html', wrapper_index: -1 } },
    fields: [{ kind: 'item_text', header: '业务对象', value: '编辑' }],
    recorded_row_index: 0,
    action: { css: 'td:last-child button', scope: 'descendant' },
  };
  const locatorMeta = {
    candidates: [{ type: 'css_fallback', value: 'tbody > tr:first-child button', score: 0.72 }],
    context: {
      collection_item_identity: {
        mode: 'semantic',
        semantic_config: collectionConfig,
      },
    },
  };

  const collectionCandidate = PlayerManager._collectionItemCandidate(locatorMeta);
  assert.equal(collectionCandidate.type, 'collection_item');
  const restoredConfig = JSON.parse(collectionCandidate.value);
  assert.equal(restoredConfig.fields[0].value, '编辑');
  assert.equal(restoredConfig.action.css, collectionConfig.action.css);

  const actual = PlayerManager._actualLocatorFromVia(
    { locator_meta: locatorMeta },
    'meta-collection-item',
  );
  assert.equal(actual.type, 'collection_item');
  assert.equal(actual.source, 'cdp:meta-collection-item');
  assert.equal(JSON.parse(actual.value).fields[0].value, '编辑');

  const diagnostics = PlayerManager._buildCdpLocatorDiagnostics(
    { locator_meta: locatorMeta },
    actual,
    'passed',
    80,
  );
  assert.deepEqual(diagnostics.configured_locators.map((candidate) => candidate.type), [
    'collection_item',
    'css_fallback',
  ]);
});
