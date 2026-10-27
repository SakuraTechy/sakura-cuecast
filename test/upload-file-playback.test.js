import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  debugger: {
    onEvent: { addListener() {} },
  },
};

const { PlayerManager, assignPlaybackFileToInput } = await import('../modules/player-manager.js');

class FakeFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type || '';
  }
}

class FakeDataTransfer {
  constructor() {
    this.files = [];
    this.items = {
      add: (file) => {
        this.files.push(file);
        return file;
      },
    };
  }
}

function withPageGlobals(documentMock, run) {
  const previous = {
    document: globalThis.document,
    XPathResult: globalThis.XPathResult,
    File: globalThis.File,
    DataTransfer: globalThis.DataTransfer,
    Event: globalThis.Event,
  };
  globalThis.document = documentMock;
  globalThis.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  globalThis.File = FakeFile;
  globalThis.DataTransfer = FakeDataTransfer;
  globalThis.Event = class FakeEvent {
    constructor(type, options) { this.type = type; this.bubbles = options?.bubbles === true; }
  };
  try {
    return run();
  } finally {
    Object.assign(globalThis, previous);
  }
}

function fileInput() {
  const prototype = {};
  Object.defineProperty(prototype, 'files', {
    configurable: true,
    get() { return this._files || []; },
    set(value) { this._files = value; },
  });
  const input = Object.create(prototype);
  Object.assign(input, {
    tagName: 'INPUT',
    type: 'file',
    events: [],
    dispatchEvent(event) { this.events.push(event.type); },
    querySelector() { return null; },
  });
  return input;
}

test('upload injection assigns a file and dispatches framework-observable events', () => {
  const input = fileInput();
  const documentMock = {
    querySelector: (selector) => selector === '#upload' ? input : null,
    querySelectorAll: () => [],
    evaluate: () => ({ singleNodeValue: null }),
  };

  const result = withPageGlobals(documentMock, () => assignPlaybackFileToInput(
    '#upload',
    '',
    'sample.png',
    'image/png',
    'YWJj',
    null,
  ));

  assert.deepEqual(result, { ok: true, fileName: 'sample.png', fileCount: 1 });
  assert.equal(input.files[0].type, 'image/png');
  assert.deepEqual(input.events, ['input', 'change']);
});

test('upload injection keeps its result when a component clears the live FileList', () => {
  const input = fileInput();
  input.dispatchEvent = function dispatchEvent(event) {
    this.events.push(event.type);
    if (event.type === 'change') this._files.length = 0;
  };
  const documentMock = {
    querySelector: (selector) => selector === '.ivu-upload-input' ? input : null,
    querySelectorAll: () => [],
    evaluate: () => ({ singleNodeValue: null }),
  };

  const result = withPageGlobals(documentMock, () => assignPlaybackFileToInput(
    '.ivu-upload-input',
    '',
    'sample.png',
    'image/png',
    'YWJj',
  ));

  assert.deepEqual(result, { ok: true, fileName: 'sample.png', fileCount: 1 });
  assert.equal(input.files.length, 0);
  assert.deepEqual(input.events, ['input', 'change']);
});

test('upload execution preserves the page-side injection error', async () => {
  const manager = new PlayerManager({}, {
    downloadStepFileAsset: async () => ({
      name: 'sample.png',
      mimeType: 'image/png',
      buffer: new Uint8Array([1, 2, 3]).buffer,
    }),
  });
  globalThis.chrome.scripting = {
    executeScript: async () => [{ result: { ok: false, error: '未找到可上传文件的 input 元素' } }],
  };

  await assert.rejects(
    manager._executeUploadFileStep(12, 34, {
      id: 56,
      file_asset: { version_id: 78 },
      target_selector: '#upload',
    }),
    /测试文件注入失败：未找到可上传文件的 input 元素/,
  );
});
