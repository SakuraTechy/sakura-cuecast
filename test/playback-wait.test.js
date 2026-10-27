import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  debugger: {
    onEvent: { addListener() {} },
  },
};

const { PlayerManager } = await import('../modules/player-manager.js');

function collectionRootDriftFixture() {
  const visibleRect = { left: 100, top: 100, width: 180, height: 36 };
  const staleItem = {
    tagName: 'LI', innerText: '门诊日志', textContent: '门诊日志', parentElement: null,
    getBoundingClientRect: () => visibleRect,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const targetItem = {
    tagName: 'LI', innerText: '处方开具', textContent: '处方开具', parentElement: null,
    getBoundingClientRect: () => visibleRect,
    matches: (selector) => selector === 'li.el-menu-item',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const staleRoot = { querySelectorAll: () => [staleItem] };
  const liveRoot = { querySelectorAll: () => [targetItem] };
  staleItem.parentElement = staleRoot;
  targetItem.parentElement = liveRoot;
  return {
    targetItem,
    documentMock: {
      querySelectorAll: (selector) => selector === 'ul'
        ? [staleRoot, liveRoot]
        : selector === 'li.el-menu-item' ? [staleItem, targetItem] : [],
    },
    style: () => ({ display: 'block', visibility: 'visible' }),
    config: {
      collection: { kind: 'menu', root: { selector: 'ul', index: 0 }, item: { selector: 'li.el-menu-item' } },
      fields: [{ kind: 'item_text', header: '业务对象', value: '处方开具' }],
      action: { css: '', text: '处方开具', tag: 'li', scope: 'self' },
      recorded_item_index: 0,
      recorded_item_summary: '处方开具',
      _collection_locator_mode: 'semantic',
    },
  };
}

test('semantic menu locator recovers when a teleported popup root changes index', () => {
  const { config, documentMock, style, targetItem } = collectionRootDriftFixture();
  const expression = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${expression});`)(documentMock, style);

  assert.equal(result, targetItem);
});

test('semantic menu diagnostics report recovery from teleported root drift', () => {
  const { config, documentMock, style } = collectionRootDriftFixture();
  const expression = PlayerManager._collectionItemDiagnosticExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${expression});`)(documentMock, style);

  assert.equal(result.status, 'matched');
  assert.equal(result.match_count, 1);
  assert.equal(result.recorded_root_index, 0);
  assert.equal(result.matched_root_index, 1);
  assert.equal(result.recovered_from_root_drift, true);
});

test('semantic menu locator keeps the recorded root when another visible root has the same exact text', () => {
  const { config, documentMock, style, targetItem } = collectionRootDriftFixture();
  const duplicate = {
    ...targetItem,
    parentElement: null,
  };
  const duplicateRoot = { querySelectorAll: () => [duplicate] };
  duplicate.parentElement = duplicateRoot;
  config.collection.root.index = 1;
  documentMock.querySelectorAll = (selector) => selector === 'ul'
    ? [duplicateRoot, targetItem.parentElement]
    : selector === 'li.el-menu-item' ? [duplicate, targetItem] : [];
  const expression = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${expression});`)(documentMock, style);

  assert.equal(result, targetItem);
});

test('semantic menu locator rejects containing text and only accepts normalized equality', () => {
  const { config, documentMock, style, targetItem } = collectionRootDriftFixture();
  targetItem.innerText = '处方开具（快捷入口）';
  targetItem.textContent = '处方开具（快捷入口）';
  documentMock.querySelectorAll = (selector) => selector === 'ul'
    ? [targetItem.parentElement]
    : selector === 'li.el-menu-item' ? [targetItem] : [];
  config.collection.root.index = 0;
  const expression = PlayerManager._collectionItemPickExpr(JSON.stringify(config));
  const result = Function('document', 'getComputedStyle', `return (${expression});`)(documentMock, style);

  assert.equal(result, null);
});

test('ordinal list diagnostics do not report a different object without stable identity evidence', () => {
  const item = {
    innerText: 'Order A Open',
    textContent: 'Order A Open',
    getBoundingClientRect: () => ({ width: 120, height: 32 }),
  };
  const config = {
    collection: { kind: 'list', root: { selector: 'ul', index: 0 }, item: { selector: 'li' } },
    fields: [{ kind: 'item_text', header: 'Business object', value: 'Order A' }],
    identity: { selected: [{ kind: 'item_text', header: 'Business object', value: 'Order A' }] },
    recorded_item_index: 0,
    recorded_item_summary: 'Order A Open',
    _collection_locator_mode: 'ordinal',
  };
  const expression = PlayerManager._collectionOrdinalDiagnosticExpr(config);
  const evaluate = (currentItem) => Function(
    'document',
    'getComputedStyle',
    `return (${expression});`,
  )({ querySelectorAll: () => [{ querySelectorAll: () => [currentItem] }] }, () => ({ display: 'block', visibility: 'visible' }));

  const sameObject = evaluate(item);
  assert.equal(sameObject.identity_comparison, 'matched');
  assert.equal(sameObject.status, 'matched');

  const uncertainObject = evaluate({ ...item, innerText: 'Order B Open', textContent: 'Order B Open' });
  assert.equal(uncertainObject.identity_comparison, 'unavailable');
  assert.equal(uncertainObject.status, 'content_changed');
});

function managerHarness(treeResult) {
  const manager = new PlayerManager({}, {});
  const waits = [];
  manager._findTreeInteractionBoxWithScrollCDP = async () => treeResult;
  manager._findVirtualScrollTargetBoxCDP = async () => null;
  manager._getElementBoxResult = async (...args) => {
    waits.push(args[4]);
    return { ok: false, reason: 'not_found' };
  };
  return { manager, waits };
}

const clickStep = {
  action_type: 'click',
  target_selector: '#create-button',
  target_xpath: '/html/body/button',
  value: '',
  locator_meta: null,
};

function compositeControlHitResult({ separateRoot = false, independentAction = false, captureHitDiagnostic = false } = {}) {
  const manager = new PlayerManager({}, {});
  const rect = { left: 818, top: 261, width: 350, height: 30 };
  const selectRoot = {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    className: 'el-select select-validation',
    parentElement: null,
    contains: (node) => node === target || node === hit,
    closest: (selector) => selector.includes('.el-select') ? selectRoot : null,
    querySelectorAll: () => [],
    getAttribute: () => '',
    getBoundingClientRect: () => rect,
  };
  const otherRoot = {
    ...selectRoot,
    className: 'el-select other-field',
  };
  otherRoot.closest = (selector) => selector.includes('.el-select') ? otherRoot : null;
  otherRoot.contains = (node) => node === hit;
  const target = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'select-input',
    className: 'el-input el-input--mini',
    innerText: '',
    textContent: '',
    parentElement: selectRoot,
    value: '',
    contains: () => false,
    closest: (selector) => selector.includes('.el-select') ? selectRoot : null,
    matches: () => false,
    querySelectorAll: () => [],
    getAttribute: () => '',
    getBoundingClientRect: () => rect,
    scrollIntoView() {},
  };
  const hitRoot = separateRoot ? otherRoot : selectRoot;
  const hit = {
    nodeType: 1,
    tagName: independentAction ? 'BUTTON' : 'DIV',
    id: '',
    className: independentAction ? 'el-input__clear' : 'el-select__tags',
    innerText: '',
    textContent: '',
    parentElement: hitRoot,
    contains: () => false,
    closest: (selector) => {
      if (independentAction && (selector.includes('button') || selector.includes('.el-input__clear'))) return hit;
      if (selector.includes('.el-select')) return hitRoot;
      return null;
    },
    querySelectorAll: () => [],
    getAttribute: () => '',
    getBoundingClientRect: () => rect,
  };
  const documentMock = {
    documentElement: { clientWidth: 1920, clientHeight: 911 },
    querySelector: (selector) => selector === '#select-input' ? target : null,
    querySelectorAll: () => [],
    getElementById: () => null,
    elementFromPoint: () => hit,
  };
  const windowMock = {
    innerWidth: 1920,
    innerHeight: 911,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto' }),
  };
  const expression = manager._buildFindCode('#select-input', '', '', true, {
    context: {
      control_kind: 'combobox',
      pointer: { x_ratio: 0.4196, y_ratio: 0.612, use_recorded_point: true },
    },
  }, true, 'click', captureHitDiagnostic);
  return Function('document', 'window', `return (${expression});`)(documentMock, windowMock);
}

test('ordinary CDP click waits six seconds for late SPA elements', async () => {
  const { manager, waits } = managerHarness(null);

  await assert.rejects(
    manager._executeStepCDP(1, clickStep, 'https://example.test'),
    /找不到元素/,
  );

  assert.deepEqual(waits, [6000]);
});

test('Tree click keeps a short fallback after its dedicated search window', async () => {
  const { manager, waits } = managerHarness({ ok: false, reason: 'not_found' });

  await assert.rejects(
    manager._executeStepCDP(1, clickStep, 'https://example.test'),
    /找不到元素/,
  );

  assert.deepEqual(waits, [800]);
});

test('composite control siblings share one click surface', () => {
  const result = compositeControlHitResult();

  assert.equal(result.ok, true);
  assert.equal(result.hitOk, true);
  assert.equal(result.hit_same_component, true);
  assert.equal(result.used_recorded_pointer, true);
});

test('a different composite control remains a real blocker', () => {
  const result = compositeControlHitResult({ separateRoot: true, captureHitDiagnostic: true });

  assert.equal(result.ok, true);
  assert.equal(result.hitOk, false);
  assert.equal(result.hit_same_component, false);
  assert.equal(result.hit_diagnostic.viewport_width, 1920);
  assert.equal(result.hit_diagnostic.viewport_height, 911);
  assert.deepEqual(result.hit_diagnostic.target_rect, { left: 818, top: 261, width: 350, height: 30 });
  assert.equal(result.hit_diagnostic.blocker_style.visibility, 'visible');
  assert.equal(result.hit_diagnostic.same_control, false);
});

test('independent actions inside a composite control remain blocked', () => {
  const result = compositeControlHitResult({ independentAction: true });

  assert.equal(result.ok, true);
  assert.equal(result.hitOk, false);
  assert.equal(result.hit_same_component, false);
});

test('tree node text cannot replace a recorded child action control', () => {
  assert.equal(PlayerManager._treeNodeTextMayBeFinalTarget({ context: { tag: 'svg', control_kind: 'svg' } }), false);
  assert.equal(PlayerManager._treeNodeTextMayBeFinalTarget({ context: { tag: 'button', control_kind: 'button' } }), false);
  assert.equal(PlayerManager._treeNodeTextMayBeFinalTarget({ context: { tag: 'li', control_kind: '' } }), true);

  const expression = new PlayerManager({}, {})._buildFindCode(
    '.teamNode > i > svg',
    '',
    '',
    true,
    {
      candidates: [
        { type: 'tree_node_text', value: JSON.stringify({ title: '胡一波多团队', sameTitleIndex: 0 }), score: 0.95 },
        { type: 'css_fallback', value: '.teamNode > i > svg', score: 0.72 },
      ],
      context: { tag: 'svg', control_kind: 'svg' },
    },
    true,
  );

  assert.equal(expression.includes('meta-tree-node-text'), false);
  assert.equal(expression.includes('meta-tree-node-child-action'), true);
  assert.equal(expression.includes('meta-css_fallback'), true);
});

test('historical SVG locator recovers the nearest clickable host inside the same tree node', () => {
  const host = {
    closest: () => null,
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 302, top: 270, width: 18, height: 18 }),
  };
  const title = {
    cloneNode: () => ({ textContent: '胡一波多团队', querySelectorAll: () => [] }),
    textContent: '胡一波多团队',
  };
  const treeNode = {
    querySelector: () => title,
    querySelectorAll: (selector) => selector.includes('[aria-haspopup="menu"]') ? [host] : [],
  };
  const documentMock = {
    querySelectorAll: (selector) => selector.includes('[role="treeitem"]') ? [treeNode] : [],
  };
  const windowMock = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  const expression = PlayerManager._treeNodeChildActionPickExpr(
    JSON.stringify({ title: '胡一波多团队', sameTitleIndex: 0 }),
    {
      context: {
        tag: 'svg',
        control_kind: 'svg',
        rect: { left: 305, top: 272, width: 12, height: 12 },
      },
    },
  );

  const result = Function('document', 'window', `return (${expression});`)(documentMock, windowMock);

  assert.equal(result, host);
});

test('custom-prefixed Ant tree interaction resolves the node action instead of the tree row', () => {
  const action = {
    closest: () => null,
  };
  const title = {
    textContent: '胡一波多团队',
    cloneNode: () => ({
      textContent: '胡一波多团队',
      querySelectorAll: () => [],
    }),
  };
  const content = {
    getBoundingClientRect: () => ({ left: 54, top: 260, width: 270, height: 32 }),
  };
  const treeNode = {
    nodeType: 1,
    parentElement: null,
    getAttribute: (name) => name === 'aria-level' ? '2' : '',
    querySelector: (selector) => selector.includes('tree-title') ? title : content,
    querySelectorAll: (selector) => selector.includes('.teamNode > i') ? [action] : [],
  };
  const documentMock = {
    querySelectorAll: (selector) => selector.includes('ec-ant-tree-treenode') ? [treeNode] : [],
  };
  const expression = PlayerManager._treeInteractionPickExpr(JSON.stringify({
    framework: 'ant-tree',
    kind: 'node_action',
    title: '胡一波多团队',
    sameTitleIndex: 0,
    actionIndex: 0,
  }));

  const result = Function('document', `return (${expression});`)(documentMock);

  assert.equal(result, action);
});

test('historical tree child action only observes whether the following overlay option appears', async () => {
  const step = {
    action_type: 'click',
    target_selector: '.teamNode > i > svg',
    locator_meta: {
      candidates: [
        { type: 'tree_node_text', value: JSON.stringify({ title: '胡一波多团队', sameTitleIndex: 0 }), score: 0.95 },
      ],
      context: {
        tag: 'svg',
        control_kind: 'svg',
        tree_node: { title: '胡一波多团队', same_title_index: 0 },
      },
    },
  };
  const nextStep = {
    action_type: 'click',
    value: '编辑',
    target_selector: '',
    locator_meta: { context: { overlay: true } },
    description: '选择选项: "编辑"',
  };
  const dependency = PlayerManager._explicitRevealDependency(step, nextStep);

  assert.deepEqual(dependency, {
    mode: 'observe',
    wait_ms: 2200,
    expected: '选择选项: "编辑"',
    inferred: true,
  });

  const manager = new PlayerManager({}, {});
  manager._probeStepVisibility = async () => ({ observed: false, evidence: 'target_not_visible' });
  globalThis.chrome.tabs = {
    sendMessage(_tabId, _message, callback) {
      callback({ observed: false, evidence: 'target_not_visible' });
    },
  };
  globalThis.chrome.runtime = { lastError: null };
  const outcome = await manager._probeExplicitRevealDependency(1, step, nextStep);

  assert.equal(outcome.mode, 'observe');
  assert.equal(outcome.observed, false);
  assert.equal(outcome.inferred, true);
});

test('historical generic menu button only observes the following overlay option', () => {
  const step = {
    action_type: 'click',
    target_selector: 'button.ec-ant-dropdown-trigger',
    target_xpath: '/html/body/button',
    locator_meta: { context: { tag: 'button', control_kind: 'button' } },
  };
  const nextStep = {
    action_type: 'click',
    value: '编辑',
    target_selector: '',
    locator_meta: { context: { overlay: true } },
    description: '选择选项: "编辑"',
  };

  assert.deepEqual(PlayerManager._explicitRevealDependency(step, nextStep), {
    mode: 'observe',
    wait_ms: 2200,
    expected: '选择选项: "编辑"',
    inferred: true,
  });
});

test('historical combobox only observes the following option', () => {
  const step = {
    action_type: 'click',
    target_selector: 'div.validation-wrap > div.el-select > div.el-select__tags',
    target_xpath: '/html/body/div/div/div[1]',
    locator_meta: { context: { tag: 'div', control_kind: 'combobox' } },
  };
  const nextStep = {
    action_type: 'click',
    value: '高风险',
    target_selector: '',
    target_xpath: "//li[contains(@class,'el-select-dropdown__item') and normalize-space()='高风险']",
    locator_meta: { context: { overlay: true } },
    description: '选择选项: "高风险"',
  };

  assert.deepEqual(PlayerManager._explicitRevealDependency(step, nextStep), {
    mode: 'observe',
    wait_ms: 2200,
    expected: '选择选项: "高风险"',
    inferred: true,
  });
});

test('recorded required reveal metadata is downgraded to non-blocking observation', () => {
  const trigger = { target_selector: '#open-menu', action: 'click' };
  const step = { action_type: 'click', target_selector: '#open-menu' };
  const nextStep = {
    action_type: 'click',
    value: '编辑',
    locator_meta: {
      context: {
        overlay: true,
        reveal: { trigger, effect_required: true, max_wait_ms: 1200 },
      },
    },
  };

  assert.equal(PlayerManager._explicitRevealDependency(step, nextStep)?.mode, 'observe');
});

test('overlay locator metadata prioritizes exact option text over component roots', () => {
  const locatorMeta = {
    candidates: [
      { type: 'component_root_sibling', value: '.ivu-select', score: 0.73 },
      { type: 'text_exact_tag', value: 'li::待创建表', score: 0.70 },
      { type: 'text_exact', value: '待创建表', score: 0.66 },
      { type: 'xpath_fallback', value: "//li[normalize-space()='待创建表']", score: 0.42 },
    ],
    context: { overlay: true },
  };

  assert.deepEqual(
    PlayerManager._orderedLocatorMetaCandidates(locatorMeta).map((candidate) => candidate.type),
    ['text_exact_tag', 'text_exact', 'xpath_fallback', 'component_root_sibling'],
  );

  const expression = new PlayerManager({}, {})._buildFindCode('', '', '', true, locatorMeta, true, 'click');
  assert.ok(expression.indexOf('meta-text-tag') < expression.indexOf('meta-component_root_sibling'));
});

function modalTargetResult({ visible = true, present = true, selector = '.ant-modal-body .small-tag-tree-select' } = {}) {
  const rect = (left, top, width, height) => ({ left, top, width, height });
  const contains = (root, node) => {
    for (let current = node; current; current = current.parentElement) {
      if (current === root) return true;
    }
    return false;
  };
  const page = { parentElement: null };
  const modal = {
    nodeType: 1, tagName: 'DIV', className: 'ant-modal', parentElement: page,
    getAttribute: () => '', getBoundingClientRect: () => rect(500, 120, 700, 500),
    contains(node) { return contains(this, node); },
  };
  function control(label, parentElement, left, top) {
    return {
      nodeType: 1, tagName: 'DIV', className: 'small-tag-tree-select', id: '',
      innerText: label, textContent: label, parentElement,
      getAttribute: () => '', matches: () => false, closest: () => null,
      querySelector: () => null, querySelectorAll: () => [],
      contains(node) { return contains(this, node); },
      getBoundingClientRect: () => rect(left, top, 560, 32),
      scrollIntoView() {},
    };
  }
  const backgroundControl = control('Rename Index Remove Partition', page, 100, 250);
  const modalControl = control('操作黑名单', modal, 680, 229);
  const documentMock = {
    documentElement: { clientWidth: 1920, clientHeight: 958 },
    querySelectorAll: (query) => {
      if (query.includes('[role="dialog"]')) return present ? [modal] : [];
      if (query === 'div.small-tag-tree-select') return [backgroundControl, modalControl];
      if (query === selector) return [modalControl];
      return [];
    },
    getElementById: () => null,
    elementFromPoint: (x) => x >= 500 ? modalControl : modal,
  };
  const windowMock = {
    innerWidth: 1920, innerHeight: 958,
    getComputedStyle: (node) => ({
      display: node === modal && !visible ? 'none' : 'block',
      visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto',
    }),
  };
  const locatorMeta = {
    context: { overlay: false, tag: 'div', control_kind: 'combobox' },
    candidates: [
      { type: 'component_root_class', value: 'div.small-tag-tree-select', score: 0.76 },
      { type: 'css_fallback', value: selector, score: 0.72 },
    ],
  };
  const expression = new PlayerManager({}, {})._buildFindCode(
    selector, '', '', true, locatorMeta, true, 'click',
  );
  return Function('document', 'window', `return (${expression});`)(documentMock, windowMock);
}

test('modal target resolves the matching component inside the visible dialog', () => {
  const result = modalTargetResult();

  assert.equal(result.ok, true);
  assert.equal(result.via, 'meta-component_root_class');
  assert.equal(result.target_summary.label, '操作黑名单');
  assert.equal(result.hitOk, true);
});

test('modal target never falls back to a background control when its dialog is gone or hidden', () => {
  assert.equal(modalTargetResult({ present: false }), null);
  assert.equal(modalTargetResult({ visible: false }), null);
});

test('dropdown option inside a dialog keeps its portal overlay lookup', () => {
  assert.equal(PlayerManager._recordedModalScope('.ant-modal-body .ant-select-item', {
    context: { overlay: true },
  }), false);
});

test('page text assertion after a button is not inferred as an overlay dependency', () => {
  const step = {
    action_type: 'click',
    target_selector: 'button[data-testid="submit-release-button"]',
    target_xpath: '/html/body/main/form/button',
    locator_meta: { context: { tag: 'button', control_kind: 'button', overlay: false } },
  };
  const nextStep = {
    action_type: 'assert_text',
    target_selector: '',
    target_xpath: '',
    value: 'CueCast 首条用例演示已完成',
    description: '断言页面包含文本: "CueCast 首条用例演示已完成"',
    locator_meta: {
      context: {
        assertion: { target: 'page', match: 'contains', source: 'page' },
      },
      assertion: { target: 'page', match: 'contains', wait_mode: 'eventually' },
    },
  };

  assert.equal(PlayerManager._stepLooksLikeOverlay(nextStep), false);
  assert.equal(PlayerManager._explicitRevealDependency(step, nextStep), null);
});

test('ordinal menu diagnostics preserve the collection kind instead of reporting table', () => {
  const item = {
    innerText: '编辑',
    textContent: '编辑',
    getBoundingClientRect: () => ({ width: 80, height: 32 }),
  };
  const root = {
    querySelectorAll: (selector) => selector.includes('ec-ant-dropdown-menu-item') ? [item] : [],
  };
  const documentMock = {
    querySelectorAll: (selector) => selector === '.ec-ant-dropdown-menu' ? [root] : [],
  };
  const config = {
    collection: {
      kind: 'menu',
      root: { selector: '.ec-ant-dropdown-menu', index: 0 },
      item: { selector: 'li.ec-ant-dropdown-menu-item' },
    },
    recorded_item_index: 0,
    recorded_item_summary: '编辑',
    fields: [{ kind: 'item_text', header: '业务对象', value: '编辑' }],
  };
  const expression = PlayerManager._collectionOrdinalDiagnosticExpr(config);
  const result = Function('document', 'getComputedStyle', `return (${expression});`)(
    documentMock,
    () => ({ display: 'block', visibility: 'visible' }),
  );

  assert.equal(result.kind, 'menu');
  assert.equal(result.mode, 'ordinal');
  assert.equal(result.status, 'matched');
  assert.equal(result.identity_comparison, 'matched');
});

test('Ant tree scrolling includes custom CSS prefixes', () => {
  const expression = PlayerManager._treeScrollStepExpr({ framework: 'ant-tree' });

  assert.equal(expression.includes('.ec-ant-tree-list-holder'), true);
  assert.equal(expression.includes('[class*="-ant-select-tree-list-holder"]'), true);
});

test('CDP lookup maps a display-none native checkbox to its visible label', () => {
  const manager = new PlayerManager({}, {});
  const input = {
    nodeType: 1,
    tagName: 'INPUT',
    type: 'checkbox',
    checked: false,
    id: 'accept',
    className: '',
    value: 'on',
    labels: [],
    parentElement: null,
    matches: () => false,
    closest: () => null,
    getAttribute: (name) => name === 'type' ? 'checkbox' : '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    scrollIntoView() {},
  };
  const label = {
    nodeType: 1,
    tagName: 'LABEL',
    id: '',
    className: 'checkbox-inner',
    control: input,
    innerText: '',
    textContent: '',
    parentElement: null,
    contains: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    getAttribute: (name) => name === 'for' ? 'accept' : '',
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 16, height: 16 }),
    scrollIntoView() {},
  };
  input.labels = [label];
  const documentMock = {
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    querySelector: (selector) => {
      if (selector === '#accept') return input;
      if (selector === 'label[for="accept"]') return label;
      return null;
    },
    querySelectorAll: () => [],
    elementFromPoint: () => label,
  };
  const windowMock = {
    innerWidth: 1280,
    innerHeight: 720,
    getComputedStyle: (node) => node === input
      ? { display: 'none', visibility: 'visible', opacity: '1' }
      : { display: 'block', visibility: 'visible', opacity: '1' },
  };
  const expression = manager._buildFindCode(
    '#accept',
    '',
    '',
    true,
    {
      context: {
        activation_target: { type: 'label', selector: 'label[for="accept"]', xpath: '' },
        toggle: { kind: 'checkbox', checked_before: false, expected_checked: true },
      },
    },
    true,
  );

  const result = Function('document', 'window', `return (${expression});`)(documentMock, windowMock);

  assert.equal(result.ok, true);
  assert.equal(result.x, 28);
  assert.equal(result.y, 38);
  assert.equal(result.hitOk, true);
  assert.deepEqual(result.native_toggle, {
    type: 'checkbox',
    checked: false,
    state_source: 'native_input',
  });
});

test('collection lookup keeps a display-none row checkbox for label proxy mapping', () => {
  const manager = new PlayerManager({}, {});
  const input = {
    nodeType: 1,
    tagName: 'INPUT',
    type: 'checkbox',
    checked: true,
    id: 'row-toggle',
    className: '',
    value: 'rule-audit',
    labels: [],
    parentElement: null,
    matches: () => false,
    closest: () => null,
    getAttribute: (name) => name === 'type' ? 'checkbox' : '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    scrollIntoView() {},
  };
  const label = {
    nodeType: 1,
    tagName: 'LABEL',
    id: '',
    className: 'hidden-toggle-label',
    control: input,
    innerText: '',
    textContent: '',
    parentElement: null,
    contains: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    getAttribute: (name) => name === 'for' ? 'row-toggle' : '',
    getBoundingClientRect: () => ({ left: 24, top: 48, width: 18, height: 18 }),
    scrollIntoView() {},
  };
  input.labels = [label];
  const table = {
    querySelectorAll: (selector) => selector.includes('tbody > tr') ? [row] : [],
  };
  const row = {
    matches: () => false,
    closest: (selector) => selector === 'table,[role="grid"]' ? table : null,
    querySelector: () => input,
    querySelectorAll: () => [],
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 40, width: 500, height: 36, bottom: 76 }),
  };
  const documentMock = {
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    querySelector: (selector) => selector === 'label.hidden-toggle-label' ? label : null,
    querySelectorAll: (selector) => selector === 'table,[role="grid"]' ? [table] : [],
    elementFromPoint: () => label,
  };
  const windowMock = {
    innerWidth: 1280,
    innerHeight: 720,
    getComputedStyle: (node) => node === input
      ? { display: 'none', visibility: 'visible', opacity: '1' }
      : { display: 'block', visibility: 'visible', opacity: '1' },
  };
  const collectionConfig = {
    collection: { kind: 'table', root: { framework: 'html', wrapper_index: -1 } },
    action: { css: 'td:first-child input', tag: 'input', scope: 'descendant' },
    recorded_row_index: 0,
    _collection_locator_mode: 'ordinal',
  };
  const expression = manager._buildFindCode(
    'tbody > tr:first-child input',
    '',
    '',
    true,
    {
      candidates: [{ type: 'collection_item', value: JSON.stringify(collectionConfig), score: 1 }],
      context: {
        activation_target: { type: 'label', selector: 'label.hidden-toggle-label', xpath: '' },
        toggle: { kind: 'checkbox', checked_before: true, expected_checked: false },
      },
    },
    true,
  );

  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = windowMock.getComputedStyle;
  try {
    const result = Function('document', 'window', `return (${expression});`)(documentMock, windowMock);

    assert.equal(result.ok, true);
    assert.equal(result.x, 33);
    assert.equal(result.y, 57);
    assert.equal(result.hitOk, true);
    assert.equal(result.via, 'meta-collection-item');
    assert.deepEqual(result.native_toggle, {
      type: 'checkbox',
      checked: true,
      state_source: 'native_input',
    });
  } finally {
    globalThis.getComputedStyle = previousGetComputedStyle;
  }
});

test('recorded toggle expectation overrides runtime inversion', () => {
  const step = {
    locator_meta: {
      context: {
        toggle: { kind: 'checkbox', checked_before: false, expected_checked: true },
      },
    },
  };

  assert.equal(PlayerManager._recordedExpectedToggleState(step, false), true);
  assert.equal(PlayerManager._recordedExpectedToggleState({ locator_meta: null }, false), false);
});

test('toggle observation reports a missing post-click control as unmatched', async () => {
  const manager = new PlayerManager({}, {});

  const result = await manager._waitForNativeToggleState(1, clickStep, true, 0);

  assert.deepEqual(result, { supported: true, matched: false, actual_checked: null });
});

test('historical hover on an expanded submenu uses the direct title instead of the parent center', () => {
  const manager = new PlayerManager({}, {});
  const menu = {
    nodeType: 1,
    tagName: 'LI',
    id: '',
    className: 'el-submenu is-opened',
    innerText: '人群健康管理 计划任务执行 完成计划分析',
    textContent: '人群健康管理 计划任务执行 完成计划分析',
    parentElement: null,
    matches: () => false,
    closest: () => null,
    contains: (node) => node === title || node === child,
    getAttribute: (name) => name === 'role' ? 'menuitem' : '',
    querySelector: () => title,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 284, width: 190, height: 556 }),
    scrollIntoView() {},
  };
  const title = {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    className: 'el-submenu__title',
    innerText: '人群健康管理',
    textContent: '人群健康管理',
    parentElement: menu,
    closest: () => null,
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 284, width: 190, height: 56 }),
    scrollIntoView() {},
  };
  const child = {
    nodeType: 1,
    tagName: 'LI',
    id: '',
    className: 'el-menu-item',
    parentElement: menu,
    closest: () => null,
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 540, width: 190, height: 50 }),
  };
  const documentMock = {
    documentElement: { clientWidth: 1707, clientHeight: 781 },
    querySelector: (selector) => selector === '#menu' ? menu : null,
    querySelectorAll: () => [],
    getElementById: () => null,
    elementFromPoint: (_x, y) => y < 340 ? title : child,
  };
  const windowMock = { innerWidth: 1707, innerHeight: 781 };
  const expression = manager._buildFindCode('#menu', '', '', true, null, true, 'hover');

  const result = Function('document', 'window', `return (${expression});`)(documentMock, windowMock);

  assert.equal(result.ok, true);
  assert.equal(result.x, 95);
  assert.equal(result.y, 312);
  assert.equal(result.hitOk, true);
  assert.equal(result.used_hover_anchor, true);
});

test('overlay failure is recovered only when the next target becomes visible', async () => {
  const manager = new PlayerManager({}, {});
  const overlayStep = {
    action_type: 'click',
    value: 'Numeric',
    target_selector: '',
    locator_meta: { context: { overlay: true } },
  };
  const nextStep = {
    action_type: 'click',
    description: 'Click the dialog input',
    target_selector: 'input[placeholder="Name"]',
  };
  manager._probeStepVisibility = async () => ({
    observed: true,
    actual: 'Name',
    evidence: 'target_visible',
  });

  const effect = await manager._recoverOverlayPostState(
    1,
    overlayStep,
    nextStep,
    { observed: false },
    new Error('Option "Numeric" not found in dropdown'),
  );

  assert.equal(effect.mode, 'observe');
  assert.equal(effect.type, 'next_target_visible');
  assert.equal(effect.observed, true);
  assert.equal(effect.evidence, 'target_became_visible_after_overlay_action');
});

test('overlay recovery does not accept a next target that was already visible', async () => {
  const manager = new PlayerManager({}, {});
  manager._probeStepVisibility = async () => ({ observed: true, actual: 'Name' });

  const effect = await manager._recoverOverlayPostState(
    1,
    { action_type: 'click', value: 'Numeric', locator_meta: { context: { overlay: true } } },
    { action_type: 'click', target_selector: 'input[placeholder="Name"]' },
    { observed: true },
    new Error('Option "Numeric" not found in dropdown'),
  );

  assert.equal(effect, null);
});

test('ordinary click failures are never recovered by overlay post-state logic', async () => {
  const manager = new PlayerManager({}, {});
  manager._probeStepVisibility = async () => ({ observed: true, actual: 'Name' });

  const effect = await manager._recoverOverlayPostState(
    1,
    { action_type: 'click', value: '', target_selector: '#save', locator_meta: null },
    { action_type: 'click', target_selector: '#next' },
    { observed: false },
    new Error('Option "Numeric" not found in dropdown'),
  );

  assert.equal(effect, null);
});

test('successful overlay delivery observes the next target becoming visible', async () => {
  const manager = new PlayerManager({}, {});
  const observations = [
    { observed: false, evidence: 'target_not_visible' },
    { observed: true, actual: 'Measurement name', evidence: 'target_visible' },
  ];
  manager._probeStepVisibility = async () => observations.shift();
  manager._sleep = async () => {};

  const effect = await manager._observeOverlayPostState(
    1,
    { action_type: 'click', value: 'Numeric', locator_meta: { context: { overlay: true } } },
    { action_type: 'click', description: 'Measurement name', target_selector: '#measurement-name' },
    { observed: false },
    120,
    120,
  );

  assert.equal(effect.mode, 'observe');
  assert.equal(effect.type, 'next_target_visible');
  assert.equal(effect.observed, true);
  assert.equal(effect.evidence, 'target_became_visible_after_overlay_action');
});

test('overlay delivery reports but does not require a hidden next target', async () => {
  const manager = new PlayerManager({}, {});
  manager._probeStepVisibility = async () => ({ observed: false, evidence: 'target_not_visible' });

  const effect = await manager._observeOverlayPostState(
    1,
    { action_type: 'click', value: 'Numeric', locator_meta: { context: { overlay: true } } },
    { action_type: 'click', description: 'Measurement name', target_selector: '#measurement-name' },
    { observed: false },
    0,
  );

  assert.equal(effect.mode, 'observe');
  assert.equal(effect.observed, false);
  assert.equal(effect.evidence, 'target_remained_hidden_after_overlay_action');
});

test('overlay selected value is recorded as direct non-blocking evidence', async () => {
  const manager = new PlayerManager({}, {});
  globalThis.chrome.tabs = {
    sendMessage(_tabId, message, callback) {
      assert.equal(message.type, 'AT_PROBE_OVERLAY_SELECTION');
      callback({ observed: true, actual: '待创建表', evidence: 'selected_value_visible' });
    },
  };
  globalThis.chrome.runtime = { lastError: null };

  const effect = await manager._probeOverlaySelectionEffect(1, {
    action_type: 'click',
    value: '待创建表',
    locator_meta: { context: { overlay: true } },
  });

  assert.deepEqual(effect, {
    mode: 'observe',
    type: 'overlay_selection',
    observed: true,
    expected: '待创建表',
    actual: '待创建表',
    evidence: 'selected_value_visible',
  });
});

test('overlay post-state retries after page load before reporting a slow target as missing', async () => {
  const manager = new PlayerManager({}, {});
  const effects = [
    { mode: 'observe', observed: false, evidence: 'target_remained_hidden_after_overlay_action' },
    { mode: 'observe', observed: true, evidence: 'target_became_visible_after_overlay_action' },
  ];
  const observeTimeouts = [];
  let loadWaits = 0;
  manager._observeOverlayPostState = async (_tabId, _step, _nextStep, _before, timeoutMs = 1500) => {
    observeTimeouts.push(timeoutMs);
    return effects.shift();
  };
  manager._waitForTabLoad = async () => { loadWaits += 1; };

  const result = await manager._observeOverlayPostStateWithLoadRetry(
    1,
    { action_type: 'click', value: 'Numeric', locator_meta: { context: { overlay: true } } },
    { action_type: 'click', target_selector: '#measurement-name' },
    { observed: false },
    12000,
  );

  assert.equal(result.effect.observed, true);
  assert.equal(result.tab_load_waited, true);
  assert.equal(loadWaits, 1);
  assert.deepEqual(observeTimeouts, [1500, 4500]);
});

test('overlay post-state keeps an unavailable retry inconclusive instead of failing', async () => {
  const manager = new PlayerManager({}, {});
  const effects = [
    { mode: 'observe', observed: false, evidence: 'target_remained_hidden_after_overlay_action' },
    null,
  ];
  manager._observeOverlayPostState = async () => effects.shift();
  manager._waitForTabLoad = async () => {};

  const result = await manager._observeOverlayPostStateWithLoadRetry(
    1,
    { action_type: 'click', value: 'Numeric', locator_meta: { context: { overlay: true } } },
    { action_type: 'click', target_selector: '#measurement-name' },
    { observed: false },
    12000,
  );

  assert.equal(result.effect, null);
  assert.equal(result.tab_load_waited, true);
});

test('overlay click never falls back to stale coordinates after the option disappears', async () => {
  const manager = new PlayerManager({}, {});
  let clicked = false;
  manager._clickOverlayItem = async () => ({ x: 120, y: 80, hitOk: true });
  manager._cdpSend = async () => ({ result: { value: null } });
  manager._cdpClick = async () => { clicked = true; };
  manager._sleep = async () => {};

  await assert.rejects(
    manager._executeStepCDP(1, {
      action_type: 'click',
      value: 'Numeric',
      target_selector: '',
      target_xpath: '',
      locator_meta: { context: { overlay: true } },
    }, 'https://example.test', 'en'),
    /disappeared before it could be clicked/,
  );

  assert.equal(clicked, false);
});

test('revealed overlay waits for the recorded option instead of a second container', async () => {
  const manager = new PlayerManager({}, {});
  const waits = [];
  const expectedBox = { x: 120, y: 80, hitOk: true, via: 'overlay-scored' };
  manager._cdpSend = async () => ({ result: { value: expectedBox } });
  manager._waitForOverlay = async () => { throw new Error('visible option should skip container wait'); };
  manager._sleep = async (ms) => { waits.push(ms); };

  const box = await manager._clickOverlayItem(
    1,
    { action_type: 'click', value: 'Any option', locator_meta: null },
    'en',
    { hadReveal: true },
  );

  assert.deepEqual(box, expectedBox);
  assert.deepEqual(waits, []);
});

test('visible custom overlay option skips an unrelated page Loading indicator', async () => {
  const manager = new PlayerManager({}, {});
  const expectedBox = { x: 120, y: 80, hitOk: true, via: 'overlay-scored' };
  manager._cdpSend = async () => ({ result: { value: expectedBox } });
  manager._waitForOverlay = async () => { throw new Error('visible option should skip container wait'); };
  manager._isPageLoadingUi = async () => { throw new Error('visible option should skip global Loading'); };

  const box = await manager._clickOverlayItem(1, {
    action_type: 'click', value: 'Any option', locator_meta: null,
  });

  assert.deepEqual(box, expectedBox);
});

test('custom overlay option can appear while unrelated Loading stays visible', async () => {
  const manager = new PlayerManager({}, {});
  const expectedBox = { x: 120, y: 80, hitOk: true, via: 'overlay-scored' };
  let probes = 0;
  manager._cdpSend = async () => ({ result: { value: ++probes >= 3 ? expectedBox : null } });
  manager._throwIfPageError = async () => {};
  manager._isPageLoadingUi = async () => true;
  manager._sleep = () => new Promise(resolve => setTimeout(resolve, 5));
  manager._waitForOverlay = async () => { throw new Error('option should appear before container wait'); };

  const box = await manager._clickOverlayItem(1, {
    action_type: 'click', value: 'Any option', locator_meta: null,
  });

  assert.deepEqual(box, expectedBox);
  assert.equal(probes, 3);
});

test('virtual scroll finds the recorded container before scanning the page', async () => {
  const manager = new PlayerManager({}, {});
  const rect = { left: 20, top: 30, width: 100, height: 24 };
  const row = {
    innerText: 'Target option', textContent: 'Target option',
    getBoundingClientRect: () => rect,
    querySelector: () => null,
    matches: () => true,
    scrollIntoView() {},
  };
  const container = {
    className: 'virtual-list', parentElement: null, firstElementChild: null,
    clientHeight: 100, scrollHeight: 500, clientWidth: 100, scrollWidth: 100, scrollTop: 0,
    getBoundingClientRect: () => ({ width: 120, height: 100 }),
    querySelectorAll: () => [row],
    dispatchEvent() {},
  };
  const documentMock = {
    body: {},
    querySelector: (selector) => selector === '#recorded-list' ? container : null,
    querySelectorAll: () => { throw new Error('full-page scan should not run'); },
    elementFromPoint: () => row,
  };
  const windowMock = { getComputedStyle: () => ({
    display: 'block', visibility: 'visible', opacity: '1',
    overflow: 'auto', overflowY: 'auto', overflowX: 'hidden',
  }) };
  manager._cdpSend = async (_tabId, _method, params) => ({ result: {
    value: Function('document', 'window', 'Event', `return ${params.expression}`)(documentMock, windowMock, Event),
  } });

  const found = await manager._findVirtualScrollTargetBoxCDP(1, {
    action_type: 'click', value: 'Target option',
    locator_meta: { context: { virtual_scroll: {
      hint: 'true', container_selector: '#recorded-list', scroll_top: 0,
    } } },
  });

  assert.equal(found?.via, 'virtual-scroll-text');
  assert.equal(found?.hitOk, true);

  const fallback = { ...container, querySelectorAll: () => [row] };
  container.querySelectorAll = () => [];
  documentMock.querySelectorAll = (selector) => selector === '*' ? [fallback] : [];
  const foundAfterContainerDrift = await manager._findVirtualScrollTargetBoxCDP(1, {
    action_type: 'click', value: 'Target option',
    locator_meta: { context: { virtual_scroll: {
      hint: 'true', container_selector: '#recorded-list', scroll_top: 0,
    } } },
  });
  assert.equal(foundAfterContainerDrift?.via, 'virtual-scroll-text');
});

test('click reveal is skipped when the overlay option is already visible', async () => {
  const manager = new PlayerManager({}, {});
  const optionBox = { x: 120, y: 80, hitOk: true, via: 'overlay-scored' };
  let revealActivations = 0;
  let deliveredClicks = 0;
  let clickOptions = null;
  manager._isRevealAlreadySatisfiedCDP = async () => true;
  manager._activateRevealTriggerCDP = async () => { revealActivations += 1; return true; };
  manager._clickOverlayItem = async () => optionBox;
  manager._cdpSend = async () => ({ result: { value: optionBox } });
  manager._waitForClickUncoveredCDP = async (_tabId, _step, box) => box;
  manager._cdpClick = async (_tabId, _x, _y, options) => { deliveredClicks += 1; clickOptions = options; };
  manager._sleep = async () => {};

  await manager._executeStepCDP(1, {
    action_type: 'click',
    value: '编辑',
    target_selector: '',
    target_xpath: '',
    locator_meta: {
      context: {
        overlay: true,
        reveal: {
          trigger: {
            action: 'click',
            target_selector: 'i[data-testid="custom-ant-tree-menu-trigger"]',
          },
        },
      },
    },
  }, 'https://example.test');

  assert.equal(revealActivations, 0);
  assert.equal(deliveredClicks, 1);
  assert.equal(clickOptions.pipelineMove, false);
});

test('ordinary recorded click enables the mouse move pipeline', async () => {
  const manager = new PlayerManager({}, {});
  const box = { x: 120, y: 80, hitOk: true };
  let clickOptions = null;
  manager._findTreeInteractionBoxWithScrollCDP = async () => null;
  manager._getElementBoxResult = async () => ({ ok: true, box });
  manager._findVirtualScrollTargetBoxCDP = async () => null;
  manager._cdpClick = async (_tabId, _x, _y, options) => { clickOptions = options; };
  manager._sleep = async () => {};

  await manager._executeStepCDP(1, clickStep, 'https://example.test');

  assert.equal(clickOptions.pipelineMove, true);
});

test('click reveal is activated when the dependent target is not visible', async () => {
  const manager = new PlayerManager({}, {});
  const optionBox = { x: 120, y: 80, hitOk: true, via: 'overlay-scored' };
  let revealActivations = 0;
  manager._isRevealAlreadySatisfiedCDP = async () => false;
  manager._activateRevealTriggerCDP = async () => { revealActivations += 1; return true; };
  manager._clickOverlayItem = async () => optionBox;
  manager._cdpSend = async () => ({ result: { value: optionBox } });
  manager._waitForClickUncoveredCDP = async (_tabId, _step, box) => box;
  manager._cdpClick = async () => {};
  manager._sleep = async () => {};

  await manager._executeStepCDP(1, {
    action_type: 'click',
    value: '编辑',
    target_selector: '',
    target_xpath: '',
    locator_meta: {
      context: {
        overlay: true,
        reveal: {
          trigger: { action: 'click', target_selector: 'button.menu-trigger' },
        },
      },
    },
  }, 'https://example.test');

  assert.equal(revealActivations, 1);
});

test('click reveal recognizes generic expanded state and custom Ant open classes', () => {
  const host = {
    className: 'ec-ant-dropdown-trigger ec-ant-dropdown-open',
    parentElement: null,
    closest: () => null,
    getAttribute: (name) => name === 'class' ? 'ec-ant-dropdown-trigger ec-ant-dropdown-open' : '',
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
  };
  const documentMock = {
    querySelector: (selector) => selector === '.menu-trigger' ? host : null,
    getElementById: () => null,
  };
  const windowMock = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  const expression = PlayerManager._revealTriggerExpandedExpr({
    action: 'click',
    target_selector: '.menu-trigger',
  });

  const expanded = Function('document', 'window', 'XPathResult', `return (${expression});`)(
    documentMock,
    windowMock,
    { FIRST_ORDERED_NODE_TYPE: 0 },
  );

  assert.equal(expanded, true);
});

test('playback tab ownership includes background descendants that were never focused', () => {
  const owned = PlayerManager._ownedPlaybackTabIds([
    { id: 10 },
    { id: 11, openerTabId: 10, active: false },
    { id: 12, openerTabId: 11, active: false },
    { id: 99, openerTabId: 98, active: false },
  ], 10, []);

  assert.deepEqual(owned.sort((a, b) => a - b), [10, 11, 12]);
});

test('dedicated playback window owns an unfocused tab even without opener metadata', () => {
  const owned = PlayerManager._ownedPlaybackTabIds([
    { id: 10, windowId: 7 },
    { id: 11, windowId: 7, active: false },
    { id: 99, windowId: 8, active: false },
  ], 10, [], 7);

  assert.deepEqual(owned.sort((a, b) => a - b), [10, 11]);
});

test('reused playback tab is preserved while newly opened background tabs are closed', async () => {
  const manager = new PlayerManager({}, {});
  const removed = [];
  globalThis.chrome.tabs = {
    query: async () => [
      { id: 20 },
      { id: 21, openerTabId: 20, active: false },
      { id: 22, openerTabId: 21, active: false },
      { id: 30 },
    ],
    remove: async (tabId) => { removed.push(tabId); },
  };

  await manager._cleanupPlaybackTabs({
    rootTabId: 20,
    reusedTab: true,
    keepTabOpenAfterPlayback: false,
    incognitoWindowId: null,
    tabRegistry: new Map([[0, { tabId: 20 }]]),
  });

  assert.deepEqual(removed.sort((a, b) => a - b), [21, 22]);
});

test('CDP playback intercepts the native file chooser before trusted clicks', async () => {
  const manager = new PlayerManager({}, {});
  const commands = [];
  globalThis.chrome.debugger.attach = async () => {};
  manager._cdpSend = async (_tabId, method, params = {}) => {
    commands.push({ method, params });
    return {};
  };
  const ctx = { debuggerAttached: false };

  const attached = await manager._attachDebugger(42, ctx);

  assert.equal(attached, true);
  assert.equal(ctx.debuggerAttached, true);
  assert.equal(ctx.networkDiagnosticsEnabled, true);
  assert.deepEqual(
    commands.find((command) => command.method === 'Page.setInterceptFileChooserDialog'),
    { method: 'Page.setInterceptFileChooserDialog', params: { enabled: true } },
  );
});

test('CDP playback keeps a background page renderer-visible and restores it on detach', async () => {
  const manager = new PlayerManager({}, {});
  const events = [];
  globalThis.chrome.debugger.attach = async () => { events.push('attach'); };
  globalThis.chrome.debugger.detach = async () => { events.push('detach'); };
  manager._cdpSend = async (_tabId, method, params = {}) => {
    if (method === 'Emulation.setFocusEmulationEnabled') events.push(`emulation:${params.enabled}`);
    return {};
  };
  const ctx = { debuggerAttached: false, emulateVisiblePage: true };

  assert.equal(await manager._attachDebugger(42, ctx), true);
  assert.equal(ctx.visiblePageEmulationActive, true);
  assert.deepEqual(events.slice(0, 2), ['attach', 'emulation:true']);

  await manager._detachDebugger(42, ctx);
  assert.equal(ctx.visiblePageEmulationActive, false);
  assert.equal(ctx.debuggerAttached, false);
  assert.deepEqual(events.slice(-2), ['emulation:false', 'detach']);
});

test('unsupported CDP focus emulation leaves normal playback available', async () => {
  const manager = new PlayerManager({}, {});
  globalThis.chrome.debugger.attach = async () => {};
  manager._cdpSend = async (_tabId, method) => {
    if (method === 'Emulation.setFocusEmulationEnabled') throw new Error('Method not found');
    return {};
  };
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const ctx = { debuggerAttached: false, emulateVisiblePage: true };
    assert.equal(await manager._attachDebugger(42, ctx), true);
    assert.equal(ctx.visiblePageEmulationActive, false);
    assert.equal(ctx.networkDiagnosticsEnabled, true);
  } finally {
    console.warn = previousWarn;
  }
});
