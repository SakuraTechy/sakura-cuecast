const DOMESTIC_DASHBOARD_URL = 'https://app.icuecast.com';
const OVERSEAS_DASHBOARD_URL = 'https://app.icuecast.ai';
const STORAGE_KEY = 'cc-platform-config-v1';

const openDashboardBtn = document.getElementById('openDashboard');
const savePlatformBtn = document.getElementById('savePlatform');
const platformInput = document.getElementById('platformUrl');
const platformStatus = document.getElementById('platformStatus');
let defaultOrigin = DOMESTIC_DASHBOARD_URL;
let activeConfig = null;

function message(name, substitutions, fallback = '') {
  return chrome.i18n.getMessage(name, substitutions) || fallback;
}

function normalizeOrigin(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error(message('popupEnterAddress', undefined, 'Enter a CueCast instance URL'));
  if (!/^https?:\/\//i.test(raw)) {
    const host = raw.split('/')[0].split(':')[0];
    const isIpOrLocal = host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    raw = `${isIpOrLocal ? 'http' : 'https'}://${raw}`;
  }
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(message('popupHttpOnly', undefined, 'Only HTTP/HTTPS URLs are supported'));
  }
  return url.origin;
}

async function resolveDefaultOrigin() {
  try {
    const extensionInfo = await chrome.management.getSelf();
    return extensionInfo.installType === 'normal'
      ? OVERSEAS_DASHBOARD_URL
      : DOMESTIC_DASHBOARD_URL;
  } catch {
    return DOMESTIC_DASHBOARD_URL;
  }
}

function setStatus(message, isError = false) {
  platformStatus.textContent = message;
  platformStatus.style.color = isError ? '#fb7185' : '';
}

async function verifyInstance(origin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${origin}/api/system/instance`, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.code !== 0 || body?.data?.product !== 'cuecast' || !body?.data?.instance_id) {
      throw new Error(message('popupInvalidInstance', undefined, 'This is not a recognizable CueCast instance'));
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function savePlatform() {
  savePlatformBtn.disabled = true;
  setStatus(message('popupConnecting', undefined, 'Connecting and verifying…'));
  try {
    const origin = normalizeOrigin(platformInput.value);
    const instance = await verifyInstance(origin);
    if (activeConfig?.instanceId && activeConfig.instanceId !== instance.instance_id) {
      const accepted = confirm(message('popupDifferentInstance', undefined, 'The new URL belongs to another CueCast instance. Switch anyway?'));
      if (!accepted) return;
    }
    activeConfig = {
      origin,
      apiBase: `${origin}/api`,
      instanceId: instance.instance_id,
      deploymentMode: instance.deployment_mode || '',
      updatedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: activeConfig });
    await chrome.runtime.sendMessage({ type: 'AT_CONFIG_UPDATED' });
    platformInput.value = origin;
    setStatus(message('popupConnected', origin, `Connected: ${origin}`));
  } catch (error) {
    setStatus(error?.name === 'AbortError'
      ? message('popupTimeout', undefined, 'Connection timed out. Check the URL and network.')
      : (error?.message || message('popupConnectionFailed', undefined, 'Connection failed')), true);
  } finally {
    savePlatformBtn.disabled = false;
  }
}

async function init() {
  document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
  document.title = chrome.i18n.getMessage('extensionTitle') || 'CueCast';
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const message = chrome.i18n.getMessage(element.dataset.i18n);
    if (message) element.textContent = message;
  });

  defaultOrigin = await resolveDefaultOrigin();
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  activeConfig = stored?.[STORAGE_KEY] || null;
  platformInput.value = activeConfig?.origin || defaultOrigin;
  setStatus(activeConfig?.origin
    ? message('popupConnected', activeConfig.origin, `Connected: ${activeConfig.origin}`)
    : message('popupInstanceHint', undefined, 'You can start with an IP address and change it to a domain later.'));
  savePlatformBtn.addEventListener('click', savePlatform);
  platformInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void savePlatform();
  });
  openDashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: `${activeConfig?.origin || defaultOrigin}/dashboard` });
  });
}

void init();
