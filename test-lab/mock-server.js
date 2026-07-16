#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { focusProcessTreeWindows, isTruthy } = require('./window-focus');

const projectRoot = path.resolve(__dirname, '..');
const sakuraPlaywrightRoot = path.resolve(projectRoot, '..', 'sakura-playwright');
const dataDir = path.join(__dirname, 'mock-data');
const dbPath = path.join(dataDir, 'cases.json');
const portArgIndex = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
const port = Number(portArgIndex >= 0 ? process.argv[portArgIndex + 1] : process.env.PORT) || 4173;
const runnerJobs = new Map();
const runnerBatches = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ cases: {}, results: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return {
      cases: parsed.cases && typeof parsed.cases === 'object' ? parsed.cases : {},
      results: parsed.results && typeof parsed.results === 'object' ? parsed.results : {},
    };
  } catch {
    return { cases: {}, results: {} };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function responseJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function hostOrigin(req) {
  const host = req.headers.host || `127.0.0.1:${port}`;
  return `http://${host}`;
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 30 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function normalizeStatus(status) {
  const raw = String(status || '').toLowerCase();
  if (raw === 'passed' || raw === 'success' || raw === 'ok' || raw.includes('通过')) return 'passed';
  if (raw === 'failed' || raw.includes('失败')) return 'failed';
  if (raw === 'running' || raw.includes('执行')) return 'running';
  return status || '未执行';
}

function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step, index) => ({
    id: step.id ?? index + 1,
    action_type: step.action_type || 'click',
    target_selector: step.target_selector ?? '',
    target_xpath: step.target_xpath ?? '',
    locator_meta: step.locator_meta ?? null,
    value: step.value ?? '',
    value_masked: step.value_masked === true || step.value_masked === 1 || step.value_masked === '1' ? 1 : 0,
    url: step.url ?? '',
    description: step.description ?? '',
    wait_before: Number(step.wait_before) || 0,
    nl_instruction: step.nl_instruction ?? '',
    screenshot: step.screenshot ?? '',
    screenshot_focus: step.screenshot_focus ?? '',
    screenshot_focus_rect: step.screenshot_focus_rect ?? '',
    is_overlay: step.is_overlay === true || step.is_overlay === 1 ? 1 : 0,
  }));
}

function seedCase(id, req) {
  if (String(id) === '279') return seedM2Case(id, req);
  if (String(id) === '280') return seedAmbiguousCase(id, req);
  if (String(id) === '281') return seedM5Case(id, req);
  if (String(id) === '282') return seedM5BCase(id, req);
  if (String(id) === '283') return seedM5CCase(id, req);
  if (String(id) === '284') return seedM5FCase(id, req);
  if (String(id) === '285') return seedM5GCase(id, req);
  if (String(id) === '286') return seedM5HCase(id, req);
  if (String(id) === '287') return seedM5ICase(id, req);
  if (String(id) === '288') return seedM5JCase(id, req);
  if (String(id) === '289') return seedM5KCase(id, req);
  if (String(id) === '290') return seedM5LCase(id, req);
  if (String(id) === '291') return seedM5NCase(id, req);
  if (String(id) === '292') return seedM5OPageCase(id, req);
  if (String(id) === '293') return seedM5OTreeCase(id, req);
  if (String(id) === '294') return seedM5OMonacoCase(id, req);
  if (String(id) === '295') return seedM5OUploadDownloadCase(id, req);
  if (String(id) === '296') return seedM5OExportSmokeCase(id, req);

  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: '测试',
    status: '未执行',
    start_url: target,
    description: '本地复刻 app.icuecast.com/testcases/278 的用例详情、录制和执行入口。',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click',
        target_selector: '#username',
        target_xpath: '',
        value: '',
        url: target,
        description: '点击用户名输入框',
      },
      {
        id: 2,
        action_type: 'input',
        target_selector: '#password',
        target_xpath: '',
        value: 'cuecast',
        value_masked: 1,
        url: target,
        description: '输入密码到 password',
      },
      {
        id: 3,
        action_type: 'click',
        target_selector: '[data-testid="submit-login"]',
        target_xpath: '',
        value: '',
        url: target,
        description: '提交表单',
      },
      {
        id: 4,
        action_type: 'assert_text',
        target_selector: '#statusText',
        target_xpath: '',
        value: 'Submitted',
        url: target,
        description: '断言提交状态',
      },
    ]),
  };
}

function seedM5OPageCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-O multi-popup disambiguation mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-O mock case for opening two popups and selecting the intended page by title and URL.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click_open_page',
        target_selector: '[data-testid="m5o-open-alpha-popup"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Open Alpha popup'
      },
      {
        id: 2,
        action_type: 'switch_page',
        target_selector: '',
        target_xpath: '',
        value: '{"target":"main"}',
        url: target,
        description: 'Return to main page before opening another popup'
      },
      {
        id: 3,
        action_type: 'click_open_page',
        target_selector: '[data-testid="m5o-open-beta-popup"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Open Beta popup'
      },
      {
        id: 4,
        action_type: 'switch_page',
        target_selector: '',
        target_xpath: '',
        value: '{"titleContains":"Alpha Popup"}',
        url: target,
        description: 'Switch to Alpha popup by title'
      },
      {
        id: 5,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Alpha Ready',
        url: target,
        description: 'Assert Alpha popup selected'
      },
      {
        id: 6,
        action_type: 'switch_page',
        target_selector: '',
        target_xpath: '',
        value: '{"urlContains":"name=Beta"}',
        url: target,
        description: 'Switch to Beta popup by URL'
      },
      {
        id: 7,
        action_type: 'click',
        target_selector: '[data-testid="popup-action"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click Beta popup action'
      },
      {
        id: 8,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Beta Clicked',
        url: target,
        description: 'Assert Beta popup action'
      },
      {
        id: 9,
        action_type: 'close_page',
        target_selector: '',
        target_xpath: '',
        value: '{"urlContains":"name=Beta","fallback":{"titleContains":"Alpha Popup"}}',
        url: target,
        description: 'Close Beta and fallback to Alpha'
      },
      {
        id: 10,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Alpha Ready',
        url: target,
        description: 'Assert Alpha remains active after Beta close'
      },
      {
        id: 11,
        action_type: 'close_page',
        target_selector: '',
        target_xpath: '',
        value: '{"target":"current","fallback":"main"}',
        url: target,
        description: 'Close Alpha and return to main'
      },
      {
        id: 12,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5o-window-status"]',
        target_xpath: '',
        value: 'Beta Requested',
        url: target,
        description: 'Assert main page active after closing popups'
      },
    ]),
  };
}

function seedM5OTreeCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-O advanced tree mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-O mock case for expandable tree and checkbox tree item selection.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click',
        target_selector: '[data-testid="m5o-expand-tree"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Expand advanced tree nodes'
      },
      {
        id: 2,
        action_type: 'click',
        target_selector: '',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click Ops Alerts checkbox tree node semantically',
        locator_meta: {
          candidates: [
            { type: 'tree_item_text', value: 'Ops Alerts', score: 0.99 }
          ],
          context: {
            tree: {
              selector: '[data-testid="m5o-tree"]',
              item_selector: '[data-tree-node="true"]'
            }
          }
        }
      },
      {
        id: 3,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5o-tree-status"]',
        target_xpath: '',
        value: 'Tree Checked Ops Alerts',
        url: target,
        description: 'Assert checkbox tree node changed state'
      },
    ]),
  };
}

function seedM5OMonacoCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-O Monaco shortcut mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-O mock case for multiline Monaco-like input and keyboard shortcut handling.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'input',
        target_selector: '[data-testid="m5o-monaco"]',
        target_xpath: '',
        value: 'function run() {\n  return "M5-O";\n}',
        url: target,
        description: 'Input multiline editor content',
        locator_meta: {
          candidates: [
            { type: 'css_attr_data-testid', value: '[data-testid="m5o-monaco"]', score: 0.99 }
          ],
          context: {
            control_kind: 'monaco'
          }
        }
      },
      {
        id: 2,
        action_type: 'key',
        target_selector: '',
        target_xpath: '',
        value: 'Control+S',
        url: target,
        description: 'Trigger save shortcut in editor'
      },
      {
        id: 3,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5o-editor-status"]',
        target_xpath: '',
        value: 'Saved',
        url: target,
        description: 'Assert editor shortcut feedback'
      },
    ]),
  };
}

function seedM5OUploadDownloadCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-O hidden upload and binary download mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-O mock case for proxy hidden file input and binary download metadata assertion.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'file_upload',
        target_selector: '[data-testid="m5o-upload-proxy"]',
        target_xpath: '',
        value: '{"files":["test-lab/upload-fixtures/m5-upload.txt"],"inputSelector":"[data-testid=\\"m5o-hidden-upload-input\\"]"}',
        url: target,
        description: 'Upload through hidden input proxy button'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5o-upload-status"]',
        target_xpath: '',
        value: 'Proxy Uploaded m5-upload.txt',
        url: target,
        description: 'Assert proxy upload status'
      },
      {
        id: 3,
        action_type: 'assert_download',
        target_selector: '[data-testid="m5o-binary-download"]',
        target_xpath: '',
        value: '{"filename":"m5o-binary.bin","mime":"application/octet-stream","minBytes":70,"maxBytes":90,"sha256":"805b36dafcef1f12e4c8ca3e9b6b5eb1673e7eaca5047509f6103d202d05f60b"}',
        url: target,
        description: 'Assert binary download metadata and hash'
      },
    ]),
  };
}

function seedM5OExportSmokeCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-O export e2e smoke mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-O mock case used to execute exported Playwright script end to end.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'input',
        target_selector: '[data-testid="username"]',
        target_xpath: '',
        value: 'export-smoke',
        url: target,
        description: 'Input username for export e2e smoke'
      },
      {
        id: 2,
        action_type: 'click',
        target_selector: '[data-testid="submit-login"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Submit form in export e2e smoke'
      },
      {
        id: 3,
        action_type: 'assert_text',
        target_selector: '#statusText',
        target_xpath: '',
        value: 'Submitted',
        url: target,
        description: 'Assert export e2e smoke result'
      },
    ]),
  };
}

function seedM5NCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-N multi-window switching mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-N mock case for switching between main and popup pages, then closing popup and returning to main page.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click_open_page',
        target_selector: '[data-testid="m5b-open-popup"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Open popup page and switch active page'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Popup Ready',
        url: target,
        description: 'Assert popup page is active'
      },
      {
        id: 3,
        action_type: 'switch_page',
        target_selector: '',
        target_xpath: '',
        value: '{"target":"main"}',
        url: target,
        description: 'Switch back to main page'
      },
      {
        id: 4,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5b-editor-status"]',
        target_xpath: '',
        value: 'Editor Empty',
        url: target,
        description: 'Assert main page is active again'
      },
      {
        id: 5,
        action_type: 'switch_page',
        target_selector: '',
        target_xpath: '',
        value: '{"urlContains":"popup.html"}',
        url: target,
        description: 'Switch to popup by URL substring'
      },
      {
        id: 6,
        action_type: 'click',
        target_selector: '[data-testid="popup-action"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click popup action after explicit switch'
      },
      {
        id: 7,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Popup Clicked',
        url: target,
        description: 'Assert popup action result'
      },
      {
        id: 8,
        action_type: 'close_page',
        target_selector: '',
        target_xpath: '',
        value: '{"target":"current","fallback":"main"}',
        url: target,
        description: 'Close popup and return to main page'
      },
      {
        id: 9,
        action_type: 'assert_text',
        target_selector: '#statusText',
        target_xpath: '',
        value: 'Ready',
        url: target,
        description: 'Assert main page remains active after popup close'
      }
    ]),
  };
}

function seedM5LCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-L advanced upload and download mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-L mock case for multi-file upload and advanced download assertions.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'file_upload',
        target_selector: '[data-testid="m5-file-input"]',
        target_xpath: '',
        value: '{"files":["test-lab/upload-fixtures/m5-upload.txt","test-lab/upload-fixtures/m5-upload-extra.txt"]}',
        url: target,
        description: 'Upload two fixture files'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5-upload-status"]',
        target_xpath: '',
        value: 'Uploaded 2 files: m5-upload.txt, m5-upload-extra.txt',
        url: target,
        description: 'Assert multi-file upload status'
      },
      {
        id: 3,
        action_type: 'assert_download',
        target_selector: '[data-testid="m5-advanced-download"]',
        target_xpath: '',
        value: '{"filename":"m5-advanced.txt","contains":"M5-L advanced download fixture","mime":"text/plain","minBytes":80,"sha256":"ff4e7777939bfad25b12ea6b64ed5bbcab2e1bd7e87fe834a980efc18f593e36"}',
        url: target,
        description: 'Assert advanced download metadata and hash'
      }
    ]),
  };
}

function seedM5KCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-K network replay mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-K mock case for replaying multiple network responses from a fixture file.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'network_replay',
        target_selector: '',
        target_xpath: '',
        value: '{"path":"test-lab/network-fixtures/m5k-replay.json"}',
        url: target,
        description: 'Register network replay fixture'
      },
      {
        id: 2,
        action_type: 'click',
        target_selector: '[data-testid="m5k-fetch-replay"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Fetch replayed profile and settings'
      },
      {
        id: 3,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5k-replay-status"]',
        target_xpath: '',
        value: 'Replay Ada Replay Enabled',
        url: target,
        description: 'Assert replayed responses rendered'
      },
      {
        id: 4,
        action_type: 'assert_request_count',
        target_selector: '',
        target_xpath: '',
        value: '{"url":"**/api/m5k/*","method":"GET","count":2}',
        url: target,
        description: 'Assert both replayed requests were sent'
      }
    ]),
  };
}

function seedM5JCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-J response baseline mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-J mock case for comparing response body against a baseline file.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'assert_response',
        target_selector: '[data-testid="m5j-fetch-profile"]',
        target_xpath: '',
        value: '{"url":"**/api/m5j/profile","method":"GET","status":200,"baselinePath":"test-lab/response-baselines/m5j-profile.json","baselineMode":"exact","snapshot":true,"snapshotName":"m5j-profile"}',
        url: target,
        description: 'Assert profile response matches baseline and save snapshot'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5j-profile-status"]',
        target_xpath: '',
        value: 'Baseline Ada M5-J',
        url: target,
        description: 'Assert baseline response rendered'
      }
    ]),
  };
}

function seedM5ICase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-I response snapshot mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-I mock case for saving response body and metadata snapshots.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'assert_response',
        target_selector: '[data-testid="m5i-fetch-profile"]',
        target_xpath: '',
        value: '{"url":"**/api/m5i/profile","method":"GET","status":200,"json":{"code":0,"data":{"stage":"M5-I","name":"Snapshot Ada"}},"snapshot":true,"snapshotName":"m5i-profile"}',
        url: target,
        description: 'Assert profile response and save snapshot'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5i-profile-status"]',
        target_xpath: '',
        value: 'Snapshot Ada M5-I',
        url: target,
        description: 'Assert snapshot response rendered'
      }
    ]),
  };
}

function seedM5HCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-H response assertion and abort mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-H mock case for response body assertion and network abort failure injection.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'assert_response',
        target_selector: '[data-testid="m5h-fetch-health"]',
        target_xpath: '',
        value: '{"url":"**/api/m5h/health","method":"GET","status":200,"json":{"code":0,"data":{"stage":"M5-H","healthy":true}}}',
        url: target,
        description: 'Assert health response JSON while clicking fetch button'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5h-health-status"]',
        target_xpath: '',
        value: 'M5-H healthy',
        url: target,
        description: 'Assert health response rendered'
      },
      {
        id: 3,
        action_type: 'network_mock',
        target_selector: '',
        target_xpath: '',
        value: '{"url":"**/api/m5h/fail","abort":"failed"}',
        url: target,
        description: 'Abort failure API request'
      },
      {
        id: 4,
        action_type: 'click',
        target_selector: '[data-testid="m5h-fetch-fail"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Trigger aborted API request'
      },
      {
        id: 5,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5h-fail-status"]',
        target_xpath: '',
        value: 'Abort handled',
        url: target,
        description: 'Assert aborted request handled by page'
      }
    ]),
  };
}

function seedM5GCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-G network delay and request count mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-G mock case for delayed network mock and request count assertion.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'network_mock',
        target_selector: '',
        target_xpath: '',
        value: '{"url":"**/api/m5g/delayed","status":200,"delayMs":120,"json":{"message":"Delayed Mock"}}',
        url: target,
        description: 'Mock delayed API response'
      },
      {
        id: 2,
        action_type: 'click',
        target_selector: '[data-testid="m5g-fetch-delayed"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Fetch delayed mocked API'
      },
      {
        id: 3,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5g-delay-status"]',
        target_xpath: '',
        value: 'Delayed Mock',
        url: target,
        description: 'Assert delayed mock response'
      },
      {
        id: 4,
        action_type: 'click',
        target_selector: '[data-testid="m5g-send-pings"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Send two ping requests'
      },
      {
        id: 5,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5g-ping-status"]',
        target_xpath: '',
        value: 'Pings sent 2',
        url: target,
        description: 'Assert pings completed'
      },
      {
        id: 6,
        action_type: 'assert_request_count',
        target_selector: '',
        target_xpath: '',
        value: '{"url":"**/api/m5g/ping","method":"POST","postDataContains":"ping-m5g","count":2}',
        url: target,
        description: 'Assert exactly two ping POST requests'
      }
    ]),
  };
}

function seedM5FCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-F request assertion mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-F mock case for asserting outbound request URL, method, and body.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'assert_request',
        target_selector: '[data-testid="m5f-send-audit"]',
        target_xpath: '',
        value: '{"url":"**/api/m5f/audit","method":"POST","postDataContains":"audit-m5f"}',
        url: target,
        description: 'Assert audit POST request while clicking send button'
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5f-request-status"]',
        target_xpath: '',
        value: 'Audit accepted audit-m5f',
        url: target,
        description: 'Assert request response rendered'
      }
    ]),
  };
}

function seedM5CCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-C export and network mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-C mock case for network mock and API JSON assertion with POST body.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'network_mock',
        target_selector: '',
        target_xpath: '',
        value: '{"url":"**/api/m5c/profile","status":200,"json":{"name":"Mocked Ada","tier":"Pro"}}',
        url: target,
        description: 'Mock profile API response'
      },
      {
        id: 2,
        action_type: 'click',
        target_selector: '[data-testid="m5c-fetch-profile"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Fetch mocked profile'
      },
      {
        id: 3,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5c-network-status"]',
        target_xpath: '',
        value: 'Mocked Ada Pro',
        url: target,
        description: 'Assert mocked profile rendered'
      },
      {
        id: 4,
        action_type: 'assert_json',
        target_selector: '',
        target_xpath: '',
        value: '{"path":"/m5c/echo","method":"POST","json":{"requestId":"m5c","enabled":true},"expected":{"code":0,"data":{"requestId":"m5c","enabled":true}}}',
        url: target,
        description: 'Assert POST API JSON subset'
      }
    ]),
  };
}

function seedM5BCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5-B advanced capability mock',
    status: 'not_run',
    start_url: target,
    description: 'M5-B mock case for Monaco-like editor input, tree semantic locator, and popup page switching.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'input',
        target_selector: '[data-testid="m5b-monaco"]',
        target_xpath: '',
        value: 'const stage = "M5-B";',
        url: target,
        description: 'Input Monaco-like editor',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'css_attr_data-testid', value: '[data-testid="m5b-monaco"]', score: 0.99 }
          ],
          context: {
            control_kind: 'monaco'
          }
        }
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5b-editor-status"]',
        target_xpath: '',
        value: 'M5-B',
        url: target,
        description: 'Assert editor input status'
      },
      {
        id: 3,
        action_type: 'click',
        target_selector: '',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click Settings tree node semantically',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'tree_item_text', value: 'Settings', score: 0.99 }
          ],
          context: {
            tree: {
              selector: '[data-testid="m5b-tree"]',
              item_selector: '[data-tree-node="true"]'
            }
          }
        }
      },
      {
        id: 4,
        action_type: 'assert_text',
        target_selector: '#statusText',
        target_xpath: '',
        value: 'Tree Selected Settings',
        url: target,
        description: 'Assert tree click result'
      },
      {
        id: 5,
        action_type: 'click_open_page',
        target_selector: '[data-testid="m5b-open-popup"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Open popup page and switch active page'
      },
      {
        id: 6,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Popup Ready',
        url: target,
        description: 'Assert popup page status'
      },
      {
        id: 7,
        action_type: 'click',
        target_selector: '[data-testid="popup-action"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click popup action'
      },
      {
        id: 8,
        action_type: 'assert_text',
        target_selector: '[data-testid="popup-status"]',
        target_xpath: '',
        value: 'Popup Clicked',
        url: target,
        description: 'Assert popup action result'
      }
    ]),
  };
}

function seedM5Case(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M5 advanced capability mock',
    status: 'not_run',
    start_url: target,
    description: 'M5 mock case for iframe locator context, file upload, download assertion, and JSON/API assertion.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click',
        target_selector: '[data-testid="iframe-run"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click button inside iframe',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'css_attr_data-testid', value: '[data-testid="iframe-run"]', score: 0.99 }
          ],
          context: {
            frame: {
              selector: '[data-testid="m5-iframe"]'
            }
          }
        }
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '[data-testid="iframe-status"]',
        target_xpath: '',
        value: 'Iframe Clicked',
        url: target,
        description: 'Assert iframe status',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'css_attr_data-testid', value: '[data-testid="iframe-status"]', score: 0.99 }
          ],
          context: {
            frame: {
              selector: '[data-testid="m5-iframe"]'
            }
          }
        }
      },
      {
        id: 3,
        action_type: 'file_upload',
        target_selector: '[data-testid="m5-file-input"]',
        target_xpath: '',
        value: 'test-lab/upload-fixtures/m5-upload.txt',
        url: target,
        description: 'Upload fixture file'
      },
      {
        id: 4,
        action_type: 'assert_text',
        target_selector: '[data-testid="m5-upload-status"]',
        target_xpath: '',
        value: 'm5-upload.txt',
        url: target,
        description: 'Assert uploaded filename'
      },
      {
        id: 5,
        action_type: 'assert_download',
        target_selector: '[data-testid="m5-download"]',
        target_xpath: '',
        value: '{"filename":"m5-sample.txt","contains":"CueCast M5 download fixture"}',
        url: target,
        description: 'Assert download file'
      },
      {
        id: 6,
        action_type: 'assert_json',
        target_selector: '[data-testid="json-payload"]',
        target_xpath: '',
        value: '{"caseId":278,"status":"ready"}',
        url: target,
        description: 'Assert page JSON subset'
      },
      {
        id: 7,
        action_type: 'assert_json',
        target_selector: '',
        target_xpath: '',
        value: '{"path":"/m5/status","expected":{"code":0,"data":{"stage":"M5","ready":true}}}',
        url: target,
        description: 'Assert API JSON subset'
      }
    ]),
  };
}

function seedM2Case(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M2 locator enhancement mock',
    status: 'not_run',
    start_url: target,
    description: 'M2 mock case for table context, overlay scoping, and custom select input.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click',
        target_selector: 'button',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click Beta row Run button via table context',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'table_cell_css', value: 'button', score: 0.98 },
            { type: 'text_exact', value: 'Run', score: 0.4 }
          ],
          context: {
            table: {
              framework: 'table',
              wrapper_index: 0,
              row_index: 1,
              col_index: 3,
              row_text: 'Beta mapping Lin'
            }
          }
        }
      },
      {
        id: 2,
        action_type: 'assert_text',
        target_selector: '#statusText',
        target_xpath: '',
        value: 'Ran Beta mapping',
        url: target,
        description: 'Assert table context click result'
      },
      {
        id: 3,
        action_type: 'click',
        target_selector: '[data-testid="open-m2-dialog"]',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Open M2 dialog'
      },
      {
        id: 4,
        action_type: 'click',
        target_selector: '',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Click Confirm inside overlay',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'text_exact', value: 'Confirm', score: 0.95 }
          ],
          context: {
            overlay: true
          }
        }
      },
      {
        id: 5,
        action_type: 'assert_text',
        target_selector: '#statusText',
        target_xpath: '',
        value: 'M2 Dialog Confirmed',
        url: target,
        description: 'Assert overlay scoped click result'
      },
      {
        id: 6,
        action_type: 'input',
        target_selector: '[data-testid="m2-custom-select"]',
        target_xpath: '',
        value: 'Enterprise',
        url: target,
        description: 'Select custom Ant style option',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'css_attr_data-testid', value: '[data-testid="m2-custom-select"]', score: 0.99 }
          ],
          context: {
            control_kind: 'custom-select'
          }
        }
      },
      {
        id: 7,
        action_type: 'assert_text',
        target_selector: '[data-testid="json-payload"]',
        target_xpath: '',
        value: 'Enterprise',
        url: target,
        description: 'Assert custom select value'
      }
    ]),
  };
}

function seedAmbiguousCase(id, req) {
  const origin = hostOrigin(req);
  const target = `${origin}/test-lab/target.html`;
  return {
    id: Number(id),
    name: 'M2 ambiguous locator mock',
    status: 'not_run',
    start_url: target,
    description: 'M2 mock case that should fail with LOCATOR_AMBIGUOUS.',
    screenshot_mode: 'standard',
    page_error_check_enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: normalizeSteps([
      {
        id: 1,
        action_type: 'click',
        target_selector: '',
        target_xpath: '',
        value: '',
        url: target,
        description: 'Ambiguous Run button should fail',
        locator_meta: {
          version: 1,
          candidates: [
            { type: 'text_exact', value: 'Run', score: 0.9 }
          ],
          context: {}
        }
      }
    ]),
  };
}

function getCase(db, id, req) {
  if (!db.cases[id]) {
    db.cases[id] = seedCase(id, req);
    writeDb(db);
  }
  const current = db.cases[id];
  const origin = hostOrigin(req);
  current.id = Number(current.id || id);
  current.name = current.name || '测试';
  current.status = current.status || '未执行';
  current.start_url = current.start_url || `${origin}/test-lab/target.html`;
  current.description = current.description || '';
  current.screenshot_mode = current.screenshot_mode || 'standard';
  current.window_size_mode = normalizeWindowSizeMode(current.window_size_mode);
  current.viewport_width = normalizeViewportSize(current.viewport_width, 0);
  current.viewport_height = normalizeViewportSize(current.viewport_height, 0);
  current.page_error_check_enabled = current.page_error_check_enabled ?? 1;
  current.steps = normalizeSteps(current.steps || []);
  return current;
}

function resetCase(db, id, req) {
  db.cases[id] = applyCaseDefaults(seedCase(id, req), id, req);
  db.results[id] = [];
  writeDb(db);
  return db.cases[id];
}

function applyCaseDefaults(testCase, id, req) {
  const origin = hostOrigin(req);
  testCase.id = Number(testCase.id || id);
  testCase.name = testCase.name || '测试';
  testCase.status = testCase.status || '未执行';
  testCase.start_url = testCase.start_url || `${origin}/test-lab/target.html`;
  testCase.description = testCase.description || '';
  testCase.screenshot_mode = testCase.screenshot_mode || 'standard';
  testCase.window_size_mode = normalizeWindowSizeMode(testCase.window_size_mode);
  testCase.viewport_width = normalizeViewportSize(testCase.viewport_width, 0);
  testCase.viewport_height = normalizeViewportSize(testCase.viewport_height, 0);
  testCase.page_error_check_enabled = testCase.page_error_check_enabled ?? 1;
  testCase.steps = normalizeSteps(testCase.steps || []);
  return testCase;
}

function normalizeWindowSizeMode(mode) {
  const raw = String(mode || '').toLowerCase();
  if (['current', 'current_window', 'current-window'].includes(raw)) return 'current';
  if (['custom', 'custom_size', 'custom-size'].includes(raw)) return 'custom';
  return 'maximized';
}

function normalizeViewportSize(value, fallback = 0) {
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? Math.floor(size) : fallback;
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded)
    .replace(/^[/\\]+/, '')
    .replace(/^(\.\.[/\\])+/, '');
  const staticRoot = normalized.startsWith(`artifacts${path.sep}`) ? sakuraPlaywrightRoot : projectRoot;
  const fullPath = path.join(staticRoot, normalized);
  const relativePath = path.relative(staticRoot, fullPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return fullPath;
}

function compareJsonSubset(expected, actual) {
  if (expected == null) return true;
  if (typeof expected !== 'object') return Object.is(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((item, index) => compareJsonSubset(item, actual[index]));
  }
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => compareJsonSubset(value, actual[key]));
}

async function handleAiStepPlan(req, res) {
  const body = await requestBody(req);
  const instruction = String(body.instruction || body.nl_instruction || '').toLowerCase();
  const operations = [];
  if (instruction.includes('toast') || instruction.includes('提示')) {
    operations.push({ action_type: 'click', target_selector: '[data-testid="show-toast"]', value: '', description: '显示提示' });
  } else if (instruction.includes('dialog') || instruction.includes('弹窗')) {
    operations.push({ action_type: 'click', target_selector: '[data-testid="open-dialog"]', value: '', description: '打开弹窗' });
    operations.push({ action_type: 'click', target_selector: 'dialog[open] button.primary', value: '', description: '确认弹窗' });
  } else {
    operations.push({ action_type: 'click', target_selector: '[data-testid="submit-login"]', value: '', description: '执行智能点击' });
  }
  responseJson(res, 200, {
    code: 0,
    data: {
      operations,
      debug: { provider: 'local-mock', instruction: body.instruction || body.nl_instruction || '' },
    },
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    responseJson(res, 204, {});
    return true;
  }

  if (url.pathname === '/api/extension/version' && req.method === 'GET') {
    responseJson(res, 200, { code: 0, data: { version: '1.0.7-local' } });
    return true;
  }

  if (url.pathname === '/api/ai/step-plan' && req.method === 'POST') {
    await handleAiStepPlan(req, res);
    return true;
  }

  if (url.pathname === '/api/m5/status' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        stage: 'M5',
        ready: true,
        capabilities: ['iframe', 'file_upload', 'assert_download', 'assert_json'],
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5c/profile' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        name: 'Live User',
        tier: 'Starter',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5c/echo' && req.method === 'POST') {
    const body = await requestBody(req);
    responseJson(res, 200, {
      code: 0,
      data: body,
    });
    return true;
  }

  if (url.pathname === '/api/m5f/audit' && req.method === 'POST') {
    const body = await requestBody(req);
    responseJson(res, 200, {
      code: 0,
      data: {
        accepted: true,
        requestId: body.requestId || '',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5g/delayed' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        message: 'Live Delayed',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5g/ping' && req.method === 'POST') {
    const body = await requestBody(req);
    responseJson(res, 200, {
      code: 0,
      data: {
        pong: true,
        requestId: body.requestId || '',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5h/health' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        stage: 'M5-H',
        healthy: true,
        message: 'M5-H healthy',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5h/fail' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        message: 'Unexpected live fallback',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5i/profile' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        stage: 'M5-I',
        name: 'Snapshot Ada',
        role: 'Snapshot Verifier',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5j/profile' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        stage: 'M5-J',
        name: 'Baseline Ada',
        role: 'Baseline Verifier',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5k/profile' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        stage: 'M5-K',
        name: 'Live Replay Fallback',
      },
    });
    return true;
  }

  if (url.pathname === '/api/m5k/settings' && req.method === 'GET') {
    responseJson(res, 200, {
      code: 0,
      data: {
        enabled: false,
        mode: 'Live',
      },
    });
    return true;
  }

  const runnerMatch = url.pathname.match(/^\/api\/runner\/jobs(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (runnerMatch) {
    await handleRunnerJobs(req, res, runnerMatch[1] || '', runnerMatch[2] || '');
    return true;
  }

  const batchMatch = url.pathname.match(/^\/api\/runner\/batches(?:\/([^/]+))?$/);
  if (batchMatch) {
    await handleRunnerBatches(req, res, batchMatch[1] || '');
    return true;
  }

  const match = url.pathname.match(/^\/api\/testcases\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/);
  if (!match) return false;

  const id = String(match[1]);
  const child = match[2] || '';
  const childId = match[3] || '';
  const db = readDb();
  const testCase = getCase(db, id, req);

  try {
    if (!child && req.method === 'GET') {
      responseJson(res, 200, { code: 0, data: testCase });
      return true;
    }

    if (!child && req.method === 'PUT') {
      const body = await requestBody(req);
      Object.assign(testCase, {
        name: body.name ?? testCase.name,
        start_url: body.start_url ?? testCase.start_url,
        description: body.description ?? testCase.description,
        screenshot_mode: body.screenshot_mode ?? testCase.screenshot_mode,
        window_size_mode: body.window_size_mode == null ? testCase.window_size_mode : normalizeWindowSizeMode(body.window_size_mode),
        viewport_width: body.viewport_width == null ? testCase.viewport_width : normalizeViewportSize(body.viewport_width, 0),
        viewport_height: body.viewport_height == null ? testCase.viewport_height : normalizeViewportSize(body.viewport_height, 0),
        page_error_check_enabled: body.page_error_check_enabled ?? testCase.page_error_check_enabled,
        updated_at: new Date().toISOString(),
      });
      testCase.status = normalizeStatus(body.status ?? testCase.status);
      db.cases[id] = testCase;
      writeDb(db);
      responseJson(res, 200, { code: 0, data: testCase });
      return true;
    }

    if (child === 'reset' && req.method === 'POST') {
      responseJson(res, 200, { code: 0, data: resetCase(db, id, req) });
      return true;
    }

    if (child === 'steps' && req.method === 'GET') {
      responseJson(res, 200, { code: 0, data: testCase.steps || [] });
      return true;
    }

    if (child === 'steps' && req.method === 'POST') {
      const body = await requestBody(req);
      testCase.steps = normalizeSteps(body.steps).map((step, index) => ({ ...step, id: index + 1 }));
      testCase.status = '未执行';
      testCase.updated_at = new Date().toISOString();
      db.cases[id] = testCase;
      writeDb(db);
      responseJson(res, 200, { code: 0, data: { steps: testCase.steps } });
      return true;
    }

    if (child === 'steps' && childId && req.method === 'PUT') {
      const body = await requestBody(req);
      const index = testCase.steps.findIndex((step) => Number(step.id) === Number(childId));
      if (index < 0) throw new Error('step not found');
      testCase.steps[index] = normalizeSteps([{ ...testCase.steps[index], ...body, id: testCase.steps[index].id }])[0];
      testCase.updated_at = new Date().toISOString();
      db.cases[id] = testCase;
      writeDb(db);
      responseJson(res, 200, { code: 0, data: testCase.steps[index] });
      return true;
    }

    if (child === 'steps' && childId && req.method === 'DELETE') {
      testCase.steps = testCase.steps.filter((step) => Number(step.id) !== Number(childId));
      testCase.steps = normalizeSteps(testCase.steps).map((step, index) => ({ ...step, id: index + 1 }));
      db.cases[id] = testCase;
      writeDb(db);
      responseJson(res, 200, { code: 0, data: { steps: testCase.steps } });
      return true;
    }

    if (child === 'results' && req.method === 'GET') {
      responseJson(res, 200, { code: 0, data: db.results[id] || [] });
      return true;
    }

    if (child === 'results' && req.method === 'POST') {
      const body = await requestBody(req);
      const rawStatus = String(body.status || '').toLowerCase();
      const success = body.success === true || rawStatus === 'passed' || rawStatus === 'success' || rawStatus === 'ok';
      const result = {
        id: Date.now(),
        test_case_id: Number(id),
        status: body.status || (success ? 'passed' : 'failed'),
        success,
        duration: body.duration ?? body.duration_ms ?? 0,
        error: body.error || body.error_message || '',
        created_at: new Date().toISOString(),
        raw: body,
      };
      db.results[id] = [result, ...(db.results[id] || [])].slice(0, 10);
      testCase.status = success ? 'passed' : 'failed';
      testCase.updated_at = new Date().toISOString();
      db.cases[id] = testCase;
      writeDb(db);
      responseJson(res, 200, { code: 0, data: result });
      return true;
    }

    if (child === 'assert-json' && req.method === 'POST') {
      const body = await requestBody(req);
      let expected = body.expected ?? body.value;
      if (typeof expected === 'string' && expected.trim()) {
        try { expected = JSON.parse(expected); } catch { /* compare as plain string */ }
      }
      const ok = compareJsonSubset(expected, body.actual);
      responseJson(res, 200, { code: ok ? 0 : 1, data: { ok }, message: ok ? '' : 'JSON assertion failed' });
      return true;
    }
  } catch (error) {
    responseJson(res, 400, { code: 1, message: error.message || 'Bad request' });
    return true;
  }

  responseJson(res, 404, { code: 1, message: 'Not found' });
  return true;
}

async function handleRunnerJobs(req, res, jobId, action = '') {
  if (!jobId && req.method === 'POST') {
    const body = await requestBody(req);
    const caseId = String(body.case_id || body.caseId || body.testCaseId || '278');
    const id = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const job = {
      id,
      case_id: Number(caseId) || caseId,
      status: 'queued',
      started_at: '',
      finished_at: '',
      exit_code: null,
      stdout: '',
      stderr: '',
      command: '',
      pid: null,
    };
    runnerJobs.set(id, job);
    startRunnerJob(job, body);
    responseJson(res, 200, { code: 0, data: job });
    return;
  }

  if (jobId && req.method === 'GET') {
    const job = runnerJobs.get(jobId);
    if (!job) {
      responseJson(res, 404, { code: 1, message: 'runner job not found' });
      return;
    }
    responseJson(res, 200, { code: 0, data: job });
    return;
  }

  if (jobId && action === 'focus' && req.method === 'POST') {
    const job = runnerJobs.get(jobId);
    if (!job) {
      responseJson(res, 404, { code: 1, message: 'runner job not found' });
      return;
    }
    if (!job.pid) {
      responseJson(res, 400, { code: 1, message: 'runner process pid is not available' });
      return;
    }
    focusProcessTreeWindows(job.pid, {
      attempts: [0, 250, 800, 1600],
      onOutput: (line) => { job.stdout += line; },
    });
    responseJson(res, 200, { code: 0, data: { ok: true, job_id: job.id, pid: job.pid } });
    return;
  }

  responseJson(res, 405, { code: 1, message: 'Method not allowed' });
}

function startRunnerJob(job, options) {
  const runnerPath = path.join(sakuraPlaywrightRoot, 'src', 'index.js');
  const apiBase = options.api_base || options.apiBase || `http://127.0.0.1:${port}/api`;
  const headed = isTruthy(options.headed);
  const args = [
    runnerPath,
    '--case-id', String(job.case_id),
    '--api-base', String(apiBase),
    '--headed', String(headed),
    '--slow-mo', String(options.slow_mo || options.slowMo || 0),
    '--finish-delay', String(options.finish_delay || options.finishDelay || 0),
    '--trace', String(options.trace || 'retain-on-failure'),
    '--video', String(options.video || 'retain-on-failure'),
  ];
  job.command = `${process.execPath} ${args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`;
  job.status = 'running';
  job.started_at = new Date().toISOString();

  const child = spawn(process.execPath, args, {
    cwd: sakuraPlaywrightRoot,
    env: { ...process.env },
    windowsHide: !headed,
  });
  job.pid = child.pid || null;
  if (headed && child.pid) {
    focusProcessTreeWindows(child.pid, {
      attempts: [0, 120, 220, 360, 520, 760, 1100, 1600, 2400],
      onOutput: (line) => { job.stdout += line; },
    });
  }
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    job.stdout += text;
  });
  child.stderr.on('data', (chunk) => { job.stderr += chunk.toString(); });
  child.on('error', (error) => {
    job.status = 'infrastructure_failed';
    job.stderr += error.message || String(error);
    job.finished_at = new Date().toISOString();
  });
  child.on('close', (code) => {
    job.exit_code = code;
    job.status = code === 0 ? 'passed' : 'failed';
    job.finished_at = new Date().toISOString();
  });
}

async function handleRunnerBatches(req, res, batchId) {
  if (!batchId && req.method === 'POST') {
    const body = await requestBody(req);
    const caseIds = String(body.case_ids || body.caseIds || body.caseId || '278,279');
    const id = `batch_job_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const batch = {
      id,
      case_ids: caseIds.split(',').map((item) => item.trim()).filter(Boolean),
      status: 'queued',
      started_at: '',
      finished_at: '',
      exit_code: null,
      stdout: '',
      stderr: '',
      command: '',
    };
    runnerBatches.set(id, batch);
    startRunnerBatch(batch, body);
    responseJson(res, 200, { code: 0, data: batch });
    return;
  }

  if (batchId && req.method === 'GET') {
    const batch = runnerBatches.get(batchId);
    if (!batch) {
      responseJson(res, 404, { code: 1, message: 'runner batch not found' });
      return;
    }
    responseJson(res, 200, { code: 0, data: batch });
    return;
  }

  responseJson(res, 405, { code: 1, message: 'Method not allowed' });
}

function startRunnerBatch(batch, options) {
  const batchPath = path.join(sakuraPlaywrightRoot, 'src', 'batch.js');
  const apiBase = options.api_base || options.apiBase || `http://127.0.0.1:${port}/api`;
  const headed = isTruthy(options.headed);
  const args = [
    batchPath,
    '--case-ids', batch.case_ids.join(','),
    '--api-base', String(apiBase),
    '--workers', String(options.workers || 1),
    '--headed', String(headed),
    '--slow-mo', String(options.slow_mo || options.slowMo || 0),
    '--finish-delay', String(options.finish_delay || options.finishDelay || 0),
    '--trace', String(options.trace || 'retain-on-failure'),
    '--video', String(options.video || 'retain-on-failure'),
  ];
  batch.command = `${process.execPath} ${args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`;
  batch.status = 'running';
  batch.started_at = new Date().toISOString();

  const child = spawn(process.execPath, args, {
    cwd: sakuraPlaywrightRoot,
    env: { ...process.env },
    windowsHide: !headed,
  });
  if (headed) focusProcessTreeWindows(child.pid, {
    onOutput: (line) => { batch.stdout += line; },
  });
  child.stdout.on('data', (chunk) => { batch.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { batch.stderr += chunk.toString(); });
  child.on('error', (error) => {
    batch.status = 'infrastructure_failed';
    batch.stderr += error.message || String(error);
    batch.finished_at = new Date().toISOString();
  });
  child.on('close', (code) => {
    batch.exit_code = code;
    batch.status = code === 0 ? 'passed' : 'failed';
    batch.finished_at = new Date().toISOString();
  });
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === '/') {
    res.writeHead(302, { Location: '/test-lab/' });
    res.end();
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (/^\/testcases\/\d+\/?$/.test(pathname)) {
    pathname = '/test-lab/index.html';
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = safeStaticPath(pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (handled) return;
  }
  serveStatic(req, res, url);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`CueCast mock lab: http://127.0.0.1:${port}/test-lab/`);
  console.log(`Mock API: http://127.0.0.1:${port}/api`);
});
