import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient } from '../modules/api-client.js';
import { PlayerManager } from '../modules/player-manager.js';

function downloadChrome(overrides = {}) {
  return {
    debugger: { onEvent: { addListener() {} } },
    runtime: { id: 'cuecast-execution-file-test' },
    downloads: {
      download: async () => 71,
      search: async () => [{ id: 71, state: 'complete', filename: 'C:\\Temp\\client.lic' }],
      removeFile: async () => {},
      erase: async () => [],
      onChanged: {
        addListener() {},
        removeListener() {},
      },
      ...overrides,
    },
  };
}

test('Admin execution file downloads to a local path with execution capability header', async () => {
  const originalChrome = globalThis.chrome;
  let downloadOptions;
  globalThis.chrome = downloadChrome({
    download: async (options) => {
      downloadOptions = options;
      return 71;
    },
  });
  try {
    const client = new ApiClient(() => 'http://admin.local', () => 'admin-token');
    const result = await client.downloadExecutionFile({
      type: 'admin_execution_file',
      download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file?projectEnvironmentId=7',
      file_name: 'client.lic',
    }, 'execution-capability-token', 'batch-20260817-001');

    assert.deepEqual(result, { downloadId: 71, localPath: 'C:\\Temp\\client.lic' });
    assert.equal(downloadOptions.url, 'http://admin.local/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file?projectEnvironmentId=7');
    assert.equal(downloadOptions.filename, 'sakura-cuecast/execution-files/batch-20260817-001/client.lic');
    assert.deepEqual(downloadOptions.headers, [
      { name: 'Authorization', value: 'Bearer admin-token' },
      { name: 'X-Execution-Capability', value: 'execution-capability-token' },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('Admin execution file download failure is reported', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome({
    download: async () => {
      throw new Error('NETWORK_FAILED');
    },
  });
  try {
    const client = new ApiClient(() => 'http://admin.local', () => '');
    await assert.rejects(() => client.downloadExecutionFile({
      download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
    }, 'capability'), /NETWORK_FAILED/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP upload failure still cleans the staged execution file', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome();
  const cleanupIds = [];
  let receivedCapability;
  const api = {
    async downloadExecutionFile(_reference, capability) {
      receivedCapability = capability;
      return { downloadId: 88, localPath: 'C:\\Temp\\client.lic' };
    },
    async cleanupExecutionFile(downloadId) {
      cleanupIds.push(downloadId);
    },
  };
  try {
    const manager = new PlayerManager({}, api);
    manager._cdpSend = async (_tabId, method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input-1' } };
      if (method === 'DOM.describeNode') {
        return { node: { nodeId: 9, nodeName: 'INPUT', attributes: ['type', 'file'] } };
      }
      if (method === 'DOM.setFileInputFiles') throw new Error('CDP upload failed');
      return {};
    };

    await assert.rejects(() => manager._executeFileUploadCDP(5, {
      action_type: 'certificate_upload',
      target_selector: '#license-file',
      certificate_ref: {
        type: 'admin_execution_file',
        download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
      },
    }, 'execution-capability-token'), /CDP upload failed/);

    assert.equal(receivedCapability, 'execution-capability-token');
    assert.deepEqual(cleanupIds, [88]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP certificate upload reports filename and interaction result without local path', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome();
  const cleanupIds = [];
  const api = {
    async downloadExecutionFile() {
      return { downloadId: 96, localPath: 'C:\\Temp\\172_19_5_45_audit.lic' };
    },
    async cleanupExecutionFile(downloadId) {
      cleanupIds.push(downloadId);
    },
  };
  try {
    const manager = new PlayerManager({}, api);
    manager._cdpSend = async (_tabId, method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input-1' } };
      if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      return {};
    };

    const result = await manager._executeFileUploadCDP(5, {
      action_type: 'certificate_upload',
      target_selector: '#license-file',
      certificate_ref: {
        type: 'admin_execution_file',
        file_name: '172_19_5_45_audit.lic',
        download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
      },
    });

    assert.equal(result.operationFacts.filename, '172_19_5_45_audit.lic');
    assert.equal(result.operationFacts.file_count, 1);
    assert.equal(result.operationFacts.upload_status, '上传控件已设置');
    assert.deepEqual(result.operationFacts.uploaded_certificate_files, ['172_19_5_45_audit.lic']);
    assert.equal(JSON.stringify(result).includes('C:\\Temp'), false);
    assert.deepEqual(cleanupIds, [96]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP upload re-locates file input when its DOM node is refreshed', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome();
  const cleanupIds = [];
  let uploadAttempts = 0;
  const api = {
    async downloadExecutionFile() {
      return { downloadId: 89, localPath: 'C:\\Temp\\client.lic' };
    },
    async cleanupExecutionFile(downloadId) {
      cleanupIds.push(downloadId);
    },
  };
  try {
    const manager = new PlayerManager({}, api);
    manager._cdpSend = async (_tabId, method, params) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: `input-${uploadAttempts + 1}` } };
      if (method === 'DOM.describeNode') {
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      }
      if (method === 'DOM.setFileInputFiles') {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw new Error('{"code":-32000,"message":"Could not find node with given id"}');
        }
        assert.equal(params.objectId, 'input-2');
        return {};
      }
      return {};
    };

    await manager._executeFileUploadCDP(5, {
      action_type: 'certificate_upload',
      target_selector: '#license-file',
      certificate_ref: {
        type: 'admin_execution_file',
        download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
      },
    });

    assert.equal(uploadAttempts, 2);
    assert.deepEqual(cleanupIds, [89]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP execution file remains until batch cleanup, including Service Worker restart', async () => {
  const originalChrome = globalThis.chrome;
  const sessionState = {};
  globalThis.chrome = downloadChrome();
  globalThis.chrome.storage = {
    session: {
      async get() {
        return sessionState;
      },
      async set(value) {
        Object.assign(sessionState, value);
      },
    },
  };
  const cleanupIds = [];
  const api = {
    async downloadExecutionFile(_reference, _capability, batchId) {
      assert.equal(batchId, 'batch-retain');
      return { downloadId: 94, localPath: 'C:\\Temp\\client.lic' };
    },
    async cleanupExecutionFile(downloadId) {
      cleanupIds.push(downloadId);
    },
  };
  try {
    const manager = new PlayerManager({}, api);
    manager._cdpSend = async (_tabId, method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input-1' } };
      if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
      return {};
    };

    await manager._executeFileUploadCDP(5, {
      action_type: 'certificate_upload',
      target_selector: '#license-file',
      certificate_ref: {
        type: 'admin_execution_file',
        download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
      },
    }, 'capability', 'batch-retain');
    assert.deepEqual(cleanupIds, []);

    const restartedManager = new PlayerManager({}, api);
    await restartedManager.cleanupExecutionFiles('batch-retain');
    assert.deepEqual(cleanupIds, [94]);
    assert.deepEqual(sessionState.cuecastExecutionFileDownloadsByBatch, {});
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP batch cleanup can retain files while clearing persisted tracking', async () => {
  const originalChrome = globalThis.chrome;
  const sessionState = {};
  globalThis.chrome = downloadChrome();
  globalThis.chrome.storage = {
    session: {
      async get() {
        return sessionState;
      },
      async set(value) {
        Object.assign(sessionState, value);
      },
    },
  };
  const cleanupIds = [];
  const api = {
    async cleanupExecutionFile(downloadId) {
      cleanupIds.push(downloadId);
    },
  };
  try {
    const manager = new PlayerManager({}, api);
    await manager._registerExecutionFileDownloads('batch-keep-files', [95]);
    await manager.cleanupExecutionFiles('batch-keep-files', { removeFiles: false });

    assert.deepEqual(cleanupIds, []);
    assert.deepEqual(sessionState.cuecastExecutionFileDownloadsByBatch, {});
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP staging accepts serialized Admin execution file reference without type field', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome();
  const cleanupIds = [];
  const api = {
    async downloadExecutionFile(reference) {
      assert.equal(reference.download_path, '/automation/playwright/testcases/100/CASE_001/execution-files/STEP_CERT');
      return { downloadId: 92, localPath: 'C:\\Temp\\client.lic' };
    },
    async cleanupExecutionFile(downloadId) {
      cleanupIds.push(downloadId);
    },
  };
  try {
    const manager = new PlayerManager({}, api);
    const staged = await manager._stageFilePathsFromStep({
      action_type: 'certificate_upload',
      certificate_ref: JSON.stringify({
        download_path: '/automation/playwright/testcases/100/CASE_001/execution-files/STEP_CERT',
        file_name: 'client.lic',
      }),
    });

    assert.deepEqual(staged.files, ['C:\\Temp\\client.lic']);
    assert.deepEqual(staged.downloadIds, [92]);
    assert.deepEqual(cleanupIds, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP staging reports unmaterialized environment certificate reference', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome();
  try {
    const manager = new PlayerManager({}, {});

    await assert.rejects(() => manager._stageFilePathsFromStep({
      action_type: 'certificate_upload',
      certificate_ref: {
        scope: 'project_environment',
        kind: 'certificate',
        slot_id: '878671771996430365',
      },
    }), /环境文件引用未由 Admin 物化为下载引用/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('CDP staging cleans downloaded file when Chrome returns an invalid local path', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = downloadChrome();
  const cleanupIds = [];
  try {
    const manager = new PlayerManager({}, {
      async downloadExecutionFile() {
        return { downloadId: 93, localPath: '' };
      },
      async cleanupExecutionFile(downloadId) {
        cleanupIds.push(downloadId);
      },
    });

    await assert.rejects(() => manager._stageFilePathsFromStep({
      action_type: 'certificate_upload',
      certificate_ref: {
        type: 'admin_execution_file',
        download_path: '/automation/playwright/testcases/100/CASE_001/execution-files/STEP_CERT',
      },
    }), /certificate_upload 缺少 file_ref 本机绝对路径/);
    assert.deepEqual(cleanupIds, [93]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
