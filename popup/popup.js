const SETTINGS_KEY = 'cuecastSettings';
const DEFAULT_SETTINGS = {
  apiBase: 'http://localhost:3000/api',
  authToken: '',
  dashboardUrl: 'https://app.icuecast.com/dashboard',
};

const openDashboardBtn = document.getElementById('openDashboard');
const openOptionsBtn = document.getElementById('openOptions');
const configState = document.getElementById('configState');
const adminApiBase = document.getElementById('adminApiBase');

function normalizedSettings(raw = {}) {
  const normalize = (value, fallback) => {
    const text = String(value ?? '').trim();
    return text ? text.replace(/\/+$/, '') : fallback;
  };
  return {
    apiBase: normalize(raw.apiBase, DEFAULT_SETTINGS.apiBase),
    authToken: String(raw.authToken ?? '').trim(),
    dashboardUrl: normalize(raw.dashboardUrl, DEFAULT_SETTINGS.dashboardUrl),
  };
}

async function init() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = normalizedSettings(result?.[SETTINGS_KEY]);
  adminApiBase.textContent = settings.apiBase;
  configState.textContent = settings.authToken ? '已配置 Token' : '未配置 Token';
  openDashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: settings.dashboardUrl });
  });
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init().catch((error) => {
  configState.textContent = `读取失败：${error.message || error}`;
});
