const SETTINGS_KEY = 'cuecastSettings';
const DEFAULT_SETTINGS = Object.freeze({
  apiBase: 'http://localhost:3000/api',
  authToken: '',
  dashboardUrl: 'https://app.icuecast.com/dashboard',
  cleanupExecutionFilesOnBatchEnd: true,
});

const refs = {
  form: document.getElementById('settingsForm'),
  apiBase: document.getElementById('apiBase'),
  authToken: document.getElementById('authToken'),
  dashboardUrl: document.getElementById('dashboardUrl'),
  cleanupExecutionFilesOnBatchEnd: document.getElementById('cleanupExecutionFilesOnBatchEnd'),
  reset: document.getElementById('resetSettings'),
  status: document.getElementById('status'),
};

function normalizeUrl(value, fallback) {
  const text = String(value ?? '').trim();
  return text ? text.replace(/\/+$/, '') : fallback;
}

function normalizedSettings(raw = {}) {
  return {
    apiBase: normalizeUrl(raw.apiBase, DEFAULT_SETTINGS.apiBase),
    authToken: String(raw.authToken ?? '').trim(),
    dashboardUrl: normalizeUrl(raw.dashboardUrl, DEFAULT_SETTINGS.dashboardUrl),
    cleanupExecutionFilesOnBatchEnd: raw.cleanupExecutionFilesOnBatchEnd !== false,
  };
}

function setStatus(message, type = 'success') {
  refs.status.textContent = message;
  refs.status.dataset.type = type;
}

function fillForm(settings) {
  refs.apiBase.value = settings.apiBase;
  refs.authToken.value = settings.authToken;
  refs.dashboardUrl.value = settings.dashboardUrl;
  refs.cleanupExecutionFilesOnBatchEnd.checked = settings.cleanupExecutionFilesOnBatchEnd;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  fillForm(normalizedSettings(result?.[SETTINGS_KEY]));
}

async function saveSettings(event) {
  event.preventDefault();
  const settings = normalizedSettings({
    apiBase: refs.apiBase.value,
    authToken: refs.authToken.value,
    dashboardUrl: refs.dashboardUrl.value,
    cleanupExecutionFilesOnBatchEnd: refs.cleanupExecutionFilesOnBatchEnd.checked,
  });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  fillForm(settings);
  setStatus('已保存，后台请求会立即使用新配置。');
}

async function resetSettings() {
  fillForm(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  setStatus('已恢复默认配置。');
}

refs.form.addEventListener('submit', (event) => {
  saveSettings(event).catch((error) => setStatus(`保存失败：${error.message || error}`, 'error'));
});
refs.reset.addEventListener('click', () => {
  resetSettings().catch((error) => setStatus(`恢复失败：${error.message || error}`, 'error'));
});

loadSettings().catch((error) => setStatus(`读取配置失败：${error.message || error}`, 'error'));
