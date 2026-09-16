import assert from 'node:assert/strict';
import test from 'node:test';
import { isPdfViewerAttributeTarget, readPdfViewerAttribute } from '../modules/cdp-pdf-viewer.js';
import { attachOperationDiagnostic } from '../modules/operation-diagnostics.js';
import { PlayerManager } from '../modules/player-manager.js';

const pdfType = 'application/x-google-chrome-pdf';
const pdfStep = {
  action_type: 'assert_attribute',
  target_xpath: `//embed[@type='${pdfType}']`,
  attribute: 'type',
  expect: pdfType,
  locator_meta: { candidates: [{ type: 'xpath_fallback', value: `//embed[@type='${pdfType}']` }] },
};
const emptyDocument = { root: { nodeName: '#document', children: [] } };
const pdfDocument = {
  root: {
    nodeName: '#document',
    children: [{
      nodeName: 'IFRAME',
      contentDocument: {
        nodeName: '#document',
        children: [{
          nodeName: 'PDF-VIEWER',
          shadowRoots: [{
            nodeName: '#document-fragment', shadowRootType: 'closed',
            children: [{ nodeName: 'EMBED', nodeId: 17, attributes: ['type', pdfType] }],
          }],
        }],
      },
    }],
  },
};

function createHarness(t, handle) {
  const originalChrome = globalThis.chrome;
  const listeners = new Set();
  const calls = [];
  const emit = (sessionId, parentSessionId = '', tabId = 5) => {
    const source = { tabId, ...(parentSessionId ? { sessionId: parentSessionId } : {}) };
    for (const listener of listeners) listener(source, 'Target.attachedToTarget', {
      sessionId, targetInfo: { type: 'iframe' },
    });
  };
  const detach = (sessionId) => {
    for (const listener of listeners) listener({ tabId: 5 }, 'Target.detachedFromTarget', { sessionId });
  };
  const sendCommand = async (method, params = {}, options = {}) => {
    calls.push({ method, params, options });
    const custom = await handle?.({ method, params, options, emit, detach });
    if (custom !== undefined) return custom;
    if (method === 'Target.setAutoAttach') return {};
    if (method === 'DOM.getDocument') return emptyDocument;
    if (method === 'DOM.getAttributes') return { attributes: ['type', pdfType] };
    throw new Error(`测试未实现 CDP 命令：${method}`);
  };
  globalThis.chrome = {
    debugger: {
      onEvent: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
    },
    runtime: { id: 'local-cdp-pdf-test' },
  };
  t.after(() => { globalThis.chrome = originalChrome; });
  return { calls, listeners, emit, sendCommand };
}

function assertCleaned(harness, expectedListeners = 0) {
  assert.equal(harness.listeners.size, expectedListeners);
  assert.deepEqual(harness.calls.at(-1), {
    method: 'Target.setAutoAttach',
    params: { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
    options: { timeoutMs: 1000 },
  });
}

function createManager(harness, timeoutMs = 500) {
  const manager = new PlayerManager({}, {});
  manager._cdpSend = (_tabId, method, params, options) => harness.sendCommand(method, params, options);
  manager._getEffectiveWaitTimeout = () => timeoutMs;
  return manager;
}

test('PDF 适配只接受明确等价的 XPath，不改写原始定位数据', () => {
  const original = structuredClone(pdfStep);
  assert.equal(isPdfViewerAttributeTarget(pdfStep), true);
  assert.equal(isPdfViewerAttributeTarget({ target_xpath: `  //embed[@type = "${pdfType}"]  ` }), true);
  for (const target_xpath of ['//embed', '//iframe', '//embed[@type="application/pdf"]', `${pdfStep.target_xpath}[2]`, `//embed[@type='${pdfType}"]`]) {
    assert.equal(isPdfViewerAttributeTarget({ target_xpath }), false);
  }
  assert.deepEqual(pdfStep, original);
});

test('CDP PDF 属性读取穿透同进程 frame 和关闭的 Shadow Root', async (t) => {
  const harness = createHarness(t, ({ method }) => method === 'DOM.getDocument' ? pdfDocument : undefined);
  const result = await readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 500, sendCommand: harness.sendCommand });
  assert.equal(result.value, pdfType);
  assert.equal(result.locator.source, 'pdf_viewer_frame');
  assert.equal(result.locator.executionSource, 'cdp:pdf-viewer-frame');
  assert.ok(harness.calls.some((call) => call.method === 'DOM.getAttributes' && call.params.nodeId === 17));
  assertCleaned(harness);
});

test('CDP PDF 递归附加当前标签页的跨进程 iframe 子会话', async (t) => {
  const harness = createHarness(t, ({ method, params, options, emit }) => {
    if (method === 'Target.setAutoAttach' && params.autoAttach) {
      if (!options.sessionId) emit('outer');
      if (options.sessionId === 'outer') emit('viewer', 'outer');
    }
    if (method === 'DOM.getDocument' && options.sessionId === 'viewer') return pdfDocument;
  });
  const result = await readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 500, sendCommand: harness.sendCommand });
  assert.equal(result.value, pdfType);
  assert.ok(harness.calls.some((call) => call.method === 'DOM.getAttributes' && call.options.sessionId === 'viewer'));
  for (const call of harness.calls.filter((entry) => entry.params.autoAttach)) {
    assert.deepEqual(call.params.filter, [{ type: 'iframe', exclude: false }, { exclude: true }]);
    assert.equal(call.params.waitForDebuggerOnStart, false);
  }
  assertCleaned(harness);
});

test('CDP PDF 等待内部 frame 延迟出现', async (t) => {
  let polls = 0;
  const harness = createHarness(t, ({ method, options, emit }) => {
    if (method === 'DOM.getDocument' && !options.sessionId && ++polls === 2) emit('delayed');
    if (method === 'DOM.getDocument' && options.sessionId === 'delayed') return pdfDocument;
  });
  const result = await readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 1000, sendCommand: harness.sendCommand });
  assert.equal(result.value, pdfType);
  assert.ok(polls >= 2);
  assertCleaned(harness);
});

test('CDP PDF 不接受其他标签页或未知父会话中的 PDF', async (t) => {
  const harness = createHarness(t, ({ method, params, options, emit }) => {
    if (method === 'Target.setAutoAttach' && params.autoAttach && !options.sessionId) {
      emit('other-tab', '', 6);
      emit('unrelated-session', 'unknown-parent');
    }
    if (method === 'DOM.getDocument' && options.sessionId) return pdfDocument;
  });
  await assert.rejects(readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 10, sendCommand: harness.sendCommand }),
    (error) => error.locatorError.code === 'LOCATOR_NOT_FOUND');
  assert.equal(harness.calls.some((call) => call.options.sessionId), false);
  assertCleaned(harness);
});

test('CDP PDF 不使用已经脱离当前页面的旧子会话', async (t) => {
  const harness = createHarness(t, ({ method, params, options, emit, detach }) => {
    if (method === 'Target.setAutoAttach' && params.autoAttach && !options.sessionId) emit('stale');
    if (method === 'DOM.getDocument' && options.sessionId === 'stale') {
      detach('stale');
      return pdfDocument;
    }
  });
  await assert.rejects(readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 10, sendCommand: harness.sendCommand }),
    /当前标签页未找到/);
  assertCleaned(harness);
});

test('CDP PDF 重读属性，拒绝已经被替换的 embed 节点', async (t) => {
  const harness = createHarness(t, ({ method }) => {
    if (method === 'DOM.getDocument') return pdfDocument;
    if (method === 'DOM.getAttributes') return { attributes: ['type', 'text/plain'] };
  });
  await assert.rejects(readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 10, sendCommand: harness.sendCommand }),
    /当前标签页未找到/);
  assertCleaned(harness);
});

test('CDP PDF 初始化失败也清理监听和临时自动附加', async (t) => {
  const harness = createHarness(t, ({ method, params }) => {
    if (method === 'Target.setAutoAttach' && params.autoAttach) throw new Error('CDP 权限不可用');
  });
  await assert.rejects(readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 10, sendCommand: harness.sendCommand }),
    /CDP 权限不可用/);
  assertCleaned(harness);
});

test('CDP PDF 成功和错误期望均保留真实属性与定位来源', async (t) => {
  const harness = createHarness(t, ({ method }) => method === 'DOM.getDocument' ? pdfDocument : undefined);
  const manager = createManager(harness);
  const original = structuredClone(pdfStep);
  const result = await manager._executeAssertAttributeCDP(5, pdfStep);
  assert.equal(result.operationAssertion.actual.preview, pdfType);
  assert.equal(result.operationAssertion.passed, true);
  assert.equal(result.source, 'pdf_viewer_frame');
  await assert.rejects(manager._executeAssertAttributeCDP(5, { ...pdfStep, expect: 'wrong' }), (error) => {
    assert.equal(error.operationAssertion.actual.preview, pdfType);
    assert.equal(error.operationAssertion.passed, false);
    assert.equal(error.actualLocator.source, 'pdf_viewer_frame');
    return true;
  });
  assert.deepEqual(pdfStep, original);
  assertCleaned(harness, 1);
});

test('CDP PDF 清理失败不得静默报告成功，监听仍必须移除', async (t) => {
  const harness = createHarness(t, ({ method, params }) => {
    if (method === 'DOM.getDocument') return pdfDocument;
    if (method === 'Target.setAutoAttach' && !params.autoAttach) throw new Error('子会话清理失败');
  });
  await assert.rejects(readPdfViewerAttribute({ tabId: 5, attribute: 'type', timeoutMs: 500, sendCommand: harness.sendCommand }),
    /子会话清理失败/);
  assertCleaned(harness);
});

test('CDP PDF 属性缺失不能与空字符串期望产生假通过', async (t) => {
  const harness = createHarness(t, ({ method }) => method === 'DOM.getDocument' ? pdfDocument : undefined);
  const manager = createManager(harness);
  await assert.rejects(manager._executeAssertAttributeCDP(5, { ...pdfStep, attribute: 'missing', expect: '' }), (error) => {
    assert.equal(error.operationAssertion.actual.preview, 'null');
    assert.equal(error.operationAssertion.passed, false);
    return true;
  });
  assertCleaned(harness, 1);
});

test('CDP PDF 定位失败将实际值标为不可用，不复制期望值', async (t) => {
  const harness = createHarness(t);
  const manager = createManager(harness, 10);
  await assert.rejects(manager._executeAssertAttributeCDP(5, pdfStep), (error) => {
    assert.deepEqual(error.operationAssertion.actual, { value_state: 'unavailable' });
    assert.equal(error.operationAssertion.expected.preview, pdfType);
    assert.equal(error.operationAssertion.passed, false);
    return true;
  });
  assertCleaned(harness, 1);
});

test('普通 CDP 属性断言保留原读取路径，并对新增实际值脱敏', async (t) => {
  const harness = createHarness(t);
  const manager = createManager(harness);
  manager._waitForTargetAttributeCDP = async () => 'local-secret';
  const step = { action_type: 'assert_attribute', target_selector: '#input', attribute: 'value', expect: 'local-secret', value_masked: 1 };
  const result = await manager._executeAssertAttributeCDP(5, step);
  const diagnostic = attachOperationDiagnostic({ status: 'passed', operation_assertion: result.operationAssertion }, step);
  assert.equal(harness.calls.length, 0);
  assert.equal(JSON.stringify(diagnostic).includes('local-secret'), false);
  assert.deepEqual(result.operationAssertion.actual, { value_state: 'masked' });
});

test('CDP 子会话发送不混用主 iframe contextId，也不改变原上下文', async (t) => {
  createHarness(t);
  const manager = new PlayerManager({}, {});
  manager._frameContextByTab.set(5, { contextId: 123 });
  const calls = [];
  chrome.debugger.sendCommand = (target, method, params, callback) => {
    calls.push({ target, method, params });
    callback({});
  };
  const params = { expression: 'document.URL' };
  await manager._cdpSend(5, 'Runtime.evaluate', params, { sessionId: 'viewer', timeoutMs: 500 });
  await manager._cdpSend(5, 'Runtime.evaluate', params);
  assert.deepEqual(calls[0].target, { tabId: 5, sessionId: 'viewer' });
  assert.equal(calls[0].params.contextId, undefined);
  assert.deepEqual(calls[1].target, { tabId: 5 });
  assert.equal(calls[1].params.contextId, 123);
  assert.equal(manager._frameContextByTab.get(5).contextId, 123);
  assert.equal(params.contextId, undefined);
});

test('CDP PDF 命令受传入的剩余步骤超时限制', async (t) => {
  createHarness(t);
  const manager = new PlayerManager({}, {});
  chrome.debugger.sendCommand = () => {};
  const started = Date.now();
  await assert.rejects(manager._cdpSend(5, 'DOM.getDocument', {}, { timeoutMs: 10 }), /CDP 命令超时/);
  assert.ok(Date.now() - started < 1000);
});
