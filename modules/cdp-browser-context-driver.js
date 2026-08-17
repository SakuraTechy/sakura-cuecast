const CDP_VERSION = '1.3';
const TARGET_POLL_INTERVAL_MS = 50;
const TARGET_POLL_TIMEOUT_MS = 8000;
const DOWNLOAD_POLL_TIMEOUT_MS = 15000;
const MANAGED_TARGET_PREFIX = 'incognito-tab:';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function asErrorMessage(error) {
  return String(error?.message || error || '未知错误');
}

function downloadDiagnostic(item) {
  if (!item) return 'download=unknown';
  return [
    `id=${item.id ?? '-'}`,
    `state=${item.state || '-'}`,
    `danger=${item.danger || '-'}`,
    `error=${item.error || '-'}`,
    `paused=${item.paused === true}`,
    `filename=${item.filename || '-'}`,
    `url=${item.finalUrl || item.url || '-'}`,
  ].join(', ');
}

function isDetachedCommandError(error) {
  return /(Detached while handling command|Debugger is not attached|No tab with given id)/i
    .test(asErrorMessage(error));
}

function managedTargetId(tabId) {
  return `${MANAGED_TARGET_PREFIX}${tabId}`;
}

function targetTabId(targetId) {
  const value = String(targetId || '');
  if (!value.startsWith(MANAGED_TARGET_PREFIX)) return null;
  const tabId = Number(value.slice(MANAGED_TARGET_PREFIX.length));
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
}

function cookieForSet(cookie) {
  const output = {};
  for (const key of [
    'name', 'value', 'url', 'domain', 'path', 'secure', 'httpOnly', 'sameSite',
    'expires', 'priority', 'sameParty', 'sourceScheme', 'sourcePort', 'partitionKey',
  ]) {
    if (cookie?.[key] !== undefined) output[key] = cookie[key];
  }
  if (cookie?.session === true) delete output.expires;
  return output;
}

export class CdpBrowserContextError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'CdpBrowserContextError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * 通过扩展独占的无痕会话提供受控状态边界。
 * chrome.debugger 的页签会话没有 browser-wide 权限，不能调用 Target.createBrowserContext；
 * 因此这里用“关闭全部受控无痕窗口即销毁站点状态”的 Chrome 生命周期实现三种会话语义。
 */
export class CdpBrowserContextDriver {
  constructor(chromeApi = globalThis.chrome) {
    this.chrome = chromeApi;
    this.anchorTabId = null;
    this.contexts = new Map();
    this.contextSequence = 0;
    this.managedTargetObserver = null;
    this.activeDownloads = new Map();
    this._onDownloadCreated = this.handleDownloadCreated.bind(this);
    this._onDownloadChanged = this.handleDownloadChanged.bind(this);
    this.chrome?.downloads?.onCreated?.addListener?.(this._onDownloadCreated);
    this.chrome?.downloads?.onChanged?.addListener?.(this._onDownloadChanged);
  }

  get connected() {
    return Number.isInteger(this.anchorTabId);
  }

  async connect(anchorTabId) {
    const normalizedTabId = Number(anchorTabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) {
      throw new CdpBrowserContextError('CDP_CONTEXT_ANCHOR_MISSING', '缺少可连接的 Admin 标签页');
    }
    await this.assertIncognitoAccessAllowed();
    await this.assertNoForeignIncognitoWindows();
    this.anchorTabId = normalizedTabId;
  }

  async createBrowserContext() {
    if (!this.connected) {
      throw new CdpBrowserContextError('CDP_BROWSER_SESSION_MISSING', '受控无痕会话驱动尚未连接');
    }
    await this.assertNoForeignIncognitoWindows();
    const liveContexts = [...this.contexts.values()].filter((context) => context.windowIds.size > 0);
    if (liveContexts.length > 0) {
      throw new CdpBrowserContextError(
        'CDP_INCOGNITO_SESSION_CONFLICT',
        '已有受控无痕会话正在运行，无法并行创建隔离会话',
      );
    }
    const contextId = `incognito-session-${Date.now()}-${++this.contextSequence}`;
    this.contexts.set(contextId, { windowIds: new Set(), tabIds: new Set() });
    return contextId;
  }

  async createTarget(browserContextId, url, { newWindow = true, background = false } = {}) {
    const context = this.requireContext(browserContextId);
    const targetUrl = String(url || 'about:blank');
    try {
      await this.assertNoForeignIncognitoWindows();
      let tab;
      if (newWindow || context.windowIds.size === 0) {
        const createdWindow = await this.chrome.windows.create({
          url: targetUrl,
          incognito: true,
          focused: !background,
          type: 'normal',
        });
        if (!createdWindow?.id || createdWindow.incognito !== true) {
          throw new Error('chrome.windows.create 未返回无痕窗口');
        }
        context.windowIds.add(createdWindow.id);
        tab = createdWindow.tabs?.[0]
          || (await this.chrome.tabs.query({ windowId: createdWindow.id }))[0];
      } else {
        const [windowId] = context.windowIds;
        tab = await this.chrome.tabs.create({
          windowId,
          url: targetUrl,
          active: !background,
        });
      }
      if (!tab?.id || tab.incognito !== true) throw new Error('受控无痕页面创建失败');
      this.registerManagedTab(browserContextId, tab);
      if (typeof this.managedTargetObserver === 'function') {
        // 在继续加载业务页面前持久化归属，缩小 MV3 Service Worker 重启后的清理盲区。
        await this.managedTargetObserver({ ...tab });
      }
      return { targetId: managedTargetId(tab.id), tab: await this.waitForTabLoad(tab.id) };
    } catch (error) {
      throw new CdpBrowserContextError(
        'CDP_BROWSER_TARGET_CREATE_FAILED',
        `创建受控无痕页面失败：${asErrorMessage(error)}`,
        error,
      );
    }
  }

  registerManagedTab(browserContextId, tab) {
    const context = this.contexts.get(browserContextId);
    if (!context || !tab?.incognito) return;
    if (Number.isInteger(Number(tab.id))) context.tabIds.add(Number(tab.id));
    if (Number.isInteger(Number(tab.windowId))) context.windowIds.add(Number(tab.windowId));
  }

  setManagedTargetObserver(observer) {
    this.managedTargetObserver = typeof observer === 'function' ? observer : null;
  }

  /** 创建同源空白文档，供认证状态在业务脚本执行前恢复。 */
  async createInertOriginTarget(browserContextId, origin) {
    const target = await this.createTarget(browserContextId, 'about:blank', {
      newWindow: false,
      background: true,
    });
    try {
      const tab = await this.navigateTargetToInertOrigin(target, origin);
      return { ...target, tab };
    } catch (error) {
      await this.closeTarget(target.targetId);
      throw error;
    }
  }

  async navigateTargetToInertOrigin(target, origin) {
    const normalizedOrigin = new URL(String(origin || '')).origin;
    const debuggee = { tabId: target.tab.id };
    const probeUrl = `${normalizedOrigin}/__cuecast_auth_state_bridge__?nonce=${Date.now()}`;
    const blankBody = btoa('<!doctype html><meta charset="utf-8"><title>CueCast state bridge</title>');
    let listener;
    let timer;
    let attachedHere = false;
    try {
      await this.chrome.debugger.attach(debuggee, CDP_VERSION);
      attachedHere = true;
      await this.chrome.debugger.sendCommand(debuggee, 'Page.enable');
      await this.chrome.debugger.sendCommand(debuggee, 'Fetch.enable', {
        patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
      });
      const intercepted = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`同源空白文档请求拦截超时：${normalizedOrigin}`)), TARGET_POLL_TIMEOUT_MS);
        listener = (source, method, params) => {
          if (source?.tabId !== target.tab.id || method !== 'Fetch.requestPaused') return;
          void this.chrome.debugger.sendCommand(debuggee, 'Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/html; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: blankBody,
          }).then(resolve, reject);
        };
        this.chrome.debugger.onEvent.addListener(listener);
      });
      await this.chrome.debugger.sendCommand(debuggee, 'Page.navigate', { url: probeUrl });
      await intercepted;
      await this.waitForTabLoad(target.tab.id);
      return this.chrome.tabs.get(target.tab.id);
    } catch (error) {
      throw new CdpBrowserContextError(
        'CDP_AUTH_STATE_RESTORE_FAILED',
        `创建同源认证状态桥接页失败：${asErrorMessage(error)}`,
        error,
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (listener) this.chrome.debugger.onEvent.removeListener(listener);
      await this.chrome.debugger.sendCommand(debuggee, 'Fetch.disable').catch(() => {});
      if (attachedHere) await this.chrome.debugger.detach(debuggee).catch(() => {});
    }
  }

  async navigateTab(tabId, url) {
    await this.chrome.tabs.update(tabId, { url: String(url), active: false });
    return this.waitForTabLoad(tabId);
  }

  async waitForTabLoad(tabId, timeoutMs = TARGET_POLL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error(`受控标签页已关闭：${tabId}`);
      if (tab.status === 'complete') return tab;
      await sleep(TARGET_POLL_INTERVAL_MS);
    }
    throw new Error(`等待受控标签页加载超时：${tabId}`);
  }

  async closeTarget(targetId) {
    const tabId = targetTabId(targetId);
    if (!tabId) return;
    await this.chrome.tabs.remove(tabId).catch(() => {});
    for (const context of this.contexts.values()) context.tabIds.delete(tabId);
  }

  /**
   * 兼容认证状态服务的既有接口；Cookie 命令改在该无痕会话的页签 CDP 上执行。
   * 不增加 cookies 权限，也不会读取或改写用户默认 Profile。
   */
  async sendBrowserCommand(method, params = {}) {
    const browserContextId = params.browserContextId;
    const context = this.requireContext(browserContextId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tab = await this.findLiveContextTab(context);
      if (!tab) break;
      const debuggee = { tabId: tab.id };
      let attachedHere = false;
      try {
        await this.chrome.debugger.attach(debuggee, CDP_VERSION);
        attachedHere = true;
        if (method === 'Storage.getCookies') {
          // 页签 debugger 只读取当前会话可见 Cookie，避免 browser-wide getAllCookies 触发 Chrome 主动 detach。
          return await this.chrome.debugger.sendCommand(debuggee, 'Network.getCookies', {
            urls: Array.isArray(params.urls) ? params.urls : [],
          });
        }
        if (method === 'Storage.setCookies') {
          return await this.chrome.debugger.sendCommand(
            debuggee,
            'Network.setCookies',
            { cookies: params.cookies || [] },
          );
        }
        const commandParams = { ...params };
        delete commandParams.browserContextId;
        // 必须等待命令完成后再进入 finally detach，否则 Chrome 会报 Detached while handling command。
        return await this.chrome.debugger.sendCommand(debuggee, method, commandParams);
      } catch (error) {
        if (!isDetachedCommandError(error) || attempt > 0) throw error;
        await sleep(TARGET_POLL_INTERVAL_MS);
      } finally {
        if (attachedHere) await this.chrome.debugger.detach(debuggee).catch(() => {});
      }
    }
    throw new Error('受控无痕会话没有可用于认证状态操作的稳定标签页');
  }

  async findLiveContextTab(context) {
    for (const tabId of context.tabIds) {
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (tab?.incognito) return tab;
    }
    return null;
  }

  async disposeBrowserContext(browserContextId) {
    if (!browserContextId) return;
    const context = this.contexts.get(browserContextId);
    if (!context) {
      const remaining = await this.getIncognitoWindows();
      if (remaining.length > 0) {
        throw new CdpBrowserContextError(
          'CDP_INCOGNITO_SESSION_CONTAMINATED',
          '仍有无痕窗口存活，无法证明测试状态已销毁；请关闭全部无痕窗口后重试',
        );
      }
      return;
    }
    const failures = [];
    let downloadError = null;
    try {
      await this.waitForDownloads(browserContextId);
    } catch (error) {
      if (!['CDP_DOWNLOAD_REQUIRES_CONFIRMATION', 'CDP_DOWNLOAD_TIMEOUT'].includes(error?.code)) throw error;
      // 下载确认框无法由扩展点击；取消下载后仍必须继续关闭自有窗口，避免阻塞后续批次。
      downloadError = error;
    }
    for (const windowId of [...context.windowIds]) {
      try {
        const window = await this.chrome.windows.get(windowId).catch(() => null);
        if (window?.incognito) await this.chrome.windows.remove(windowId);
      } catch (error) {
        failures.push(`${windowId}: ${asErrorMessage(error)}`);
      }
    }
    if (failures.length) {
      throw new CdpBrowserContextError(
        'CDP_SESSION_CLEANUP_FAILED',
        `受控无痕窗口清理失败：${failures.join('；')}`,
      );
    }
    const deadline = Date.now() + TARGET_POLL_TIMEOUT_MS;
    let owned = await this.getContextWindows(context);
    while (owned.length > 0 && Date.now() < deadline) {
      await sleep(TARGET_POLL_INTERVAL_MS);
      owned = await this.getContextWindows(context);
    }
    if (owned.length > 0) {
      throw new CdpBrowserContextError(
        'CDP_SESSION_CLEANUP_FAILED',
        `受控无痕窗口仍未关闭：${owned.map((item) => item.id).join(',')}`,
      );
    }
    const foreign = await this.getIncognitoWindows();
    if (foreign.length > 0) {
      throw new CdpBrowserContextError(
        'CDP_INCOGNITO_SESSION_CONTAMINATED',
        '批次运行期间出现了非 CueCast 管理的无痕窗口，无法证明测试状态已销毁；请关闭全部无痕窗口后重试',
      );
    }
    this.contexts.delete(browserContextId);
    // windows API 已不可见后再让出一个事件循环，确保下一次会话不复用正在销毁的 OTR Profile。
    await sleep(TARGET_POLL_INTERVAL_MS);
    if (downloadError) throw downloadError;
  }

  async cleanupRecoveredSession(metadata = {}) {
    const recordedWindowIds = new Set(
      (metadata.managedWindowIds || []).map(Number).filter(Number.isInteger),
    );
    const recordedTabIds = new Set([
      ...(metadata.managedTabIds || []),
      metadata.activeTabId,
    ].map(Number).filter(Number.isInteger));
    const provenWindowIds = new Set();
    for (const tabId of recordedTabIds) {
      const tab = await this.chrome.tabs.get(Number(tabId)).catch(() => null);
      if (tab?.incognito
        && Number.isInteger(tab.windowId)
        && (recordedWindowIds.size === 0 || recordedWindowIds.has(tab.windowId))) {
        provenWindowIds.add(tab.windowId);
      }
    }
    for (const windowId of provenWindowIds) {
      const window = await this.chrome.windows.get(windowId).catch(() => null);
      if (window?.incognito) await this.chrome.windows.remove(windowId);
    }
    const remaining = await this.getIncognitoWindows();
    if (remaining.length > 0) {
      throw new CdpBrowserContextError(
        'CDP_INCOGNITO_SESSION_CONTAMINATED',
        '仍有无法通过批次 tabId 证明归属的无痕窗口；为避免关闭用户窗口，请手动关闭全部无痕窗口后重试',
      );
    }
  }

  async disconnect() {
    this.anchorTabId = null;
    this.chrome?.downloads?.onCreated?.removeListener?.(this._onDownloadCreated);
    this.chrome?.downloads?.onChanged?.removeListener?.(this._onDownloadChanged);
  }

  async cleanup() {
    const failures = [];
    for (const contextId of [...this.contexts.keys()]) {
      try {
        await this.disposeBrowserContext(contextId);
      } catch (error) {
        failures.push(`${contextId}: ${asErrorMessage(error)}`);
      }
    }
    if (failures.length) {
      throw new CdpBrowserContextError(
        'CDP_SESSION_CLEANUP_FAILED',
        `受控无痕会话清理失败：${failures.join('；')}`,
      );
    }
    await this.disconnect();
  }

  handleDownloadCreated(item) {
    if (!item?.incognito || item.state !== 'in_progress') return;
    const liveContextIds = [...this.contexts.entries()]
      .filter(([, context]) => context.windowIds.size > 0)
      .map(([contextId]) => contextId);
    if (liveContextIds.length === 1) {
      // 严格隔离模式同一时刻只允许一个受控无痕 Context，下载据此绑定归属。
      this.activeDownloads.set(item.id, { contextId: liveContextIds[0], item });
    }
  }

  handleDownloadChanged(delta) {
    const state = delta?.state?.current;
    if (state && state !== 'in_progress') this.activeDownloads.delete(delta.id);
  }

  async waitForDownloads(browserContextId, timeoutMs = DOWNLOAD_POLL_TIMEOUT_MS) {
    const context = this.contexts.get(browserContextId);
    if (!context || !this.chrome?.downloads) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const trackedIds = [...this.activeDownloads.entries()]
        .filter(([, tracked]) => tracked.contextId === browserContextId)
        .map(([downloadId]) => downloadId);
      const queried = await Promise.resolve(
        this.chrome.downloads.search ? this.chrome.downloads.search({ state: 'in_progress' }) : [],
      ).catch(() => []);
      const queriedIds = queried
        .filter((item) => item?.incognito === true)
        .map((item) => item.id)
        .filter((id) => id != null);
      const activeIds = [...new Set([...trackedIds, ...queriedIds])];
      if (!activeIds.length) return;
      for (const downloadId of queriedIds) {
        this.activeDownloads.set(downloadId, { contextId: browserContextId, item: queried.find((item) => item.id === downloadId) });
      }
      const blocked = activeIds
        .map((downloadId) => this.activeDownloads.get(downloadId)?.item)
        .filter((item) => item && ((item.danger && item.danger !== 'safe') || item.paused === true));
      if (blocked.length) {
        await this.cancelDownloads(activeIds);
        throw new CdpBrowserContextError(
          'CDP_DOWNLOAD_REQUIRES_CONFIRMATION',
          `Chrome 要求人工确认该下载，扩展 CDP 无法绕过；${blocked.map(downloadDiagnostic).join('；')}。请改用 Playwright Runner`,
        );
      }
      await sleep(TARGET_POLL_INTERVAL_MS);
    }
    const activeEntries = [...this.activeDownloads.entries()]
      .filter(([, tracked]) => tracked.contextId === browserContextId)
    const activeIds = activeEntries.map(([downloadId]) => downloadId);
    await this.cancelDownloads(activeIds);
    const detail = activeEntries.map(([, tracked]) => downloadDiagnostic(tracked.item)).join('；');
    throw new CdpBrowserContextError(
      'CDP_DOWNLOAD_TIMEOUT',
      `下载在 ${timeoutMs}ms 内未完成；${detail || '未取得下载详情'}。已取消下载并释放受控窗口，请检查网络或改用 Playwright Runner`,
    );
  }

  async getContextWindows(context) {
    const windows = await this.getIncognitoWindows();
    return windows.filter((item) => context.windowIds.has(item.id));
  }

  async cancelDownloads(downloadIds) {
    await Promise.all(downloadIds.map((downloadId) => Promise.resolve(
      this.chrome.downloads.cancel ? this.chrome.downloads.cancel(downloadId) : undefined,
    ).catch(() => {})));
  }

  requireContext(browserContextId) {
    const context = this.contexts.get(browserContextId);
    if (!context) {
      throw new CdpBrowserContextError(
        'CDP_BROWSER_CONTEXT_MISSING',
        `受控无痕会话不存在：${browserContextId || '-'}`,
      );
    }
    return context;
  }

  async getIncognitoWindows() {
    const windows = await this.chrome.windows.getAll({ populate: false, windowTypes: ['normal'] });
    return windows.filter((window) => window.incognito === true);
  }

  async assertNoForeignIncognitoWindows() {
    const incognitoWindows = await this.getIncognitoWindows();
    const ownedWindowIds = new Set(
      [...this.contexts.values()].flatMap((context) => [...context.windowIds]),
    );
    const foreign = incognitoWindows.filter((window) => !ownedWindowIds.has(window.id));
    if (foreign.length > 0) {
      throw new CdpBrowserContextError(
        'CDP_INCOGNITO_SESSION_CONFLICT',
        '检测到用户已打开无痕窗口。Chrome 的无痕窗口共享同一会话；请先关闭全部无痕窗口，再使用三种受控用例会话',
      );
    }
  }

  async assertIncognitoAccessAllowed() {
    const checkAccess = this.chrome?.extension?.isAllowedIncognitoAccess;
    if (typeof checkAccess !== 'function') {
      throw new CdpBrowserContextError(
        'CDP_INCOGNITO_ACCESS_CHECK_UNAVAILABLE',
        '当前 Chrome 无法检查 CueCast 的无痕模式访问权限，请升级 Chrome 后重新加载扩展',
      );
    }
    const allowed = await checkAccess.call(this.chrome.extension);
    if (!allowed) {
      throw new CdpBrowserContextError(
        'CDP_INCOGNITO_ACCESS_REQUIRED',
        'CueCast 未获准在无痕模式下运行。请在 chrome://extensions 打开 CueCast 详情，开启“允许在无痕模式下运行”，然后刷新当前页面',
      );
    }
  }

  async probe(anchorTabId, probeUrl) {
    const url = /^https?:\/\//i.test(String(probeUrl || ''))
      ? String(probeUrl)
      : 'https://example.com/';
    const probeKey = `__cuecast_context_probe_${Date.now()}`;
    let contextA = '';
    let contextB = '';
    let probeResult;
    try {
      await this.connect(anchorTabId);
      contextA = await this.createBrowserContext();
      const targetA = await this.createTarget(contextA, url, { background: true });
      await this.chrome.scripting.executeScript({ target: { tabId: targetA.tab.id }, files: ['content/player.js'] });
      const writeResult = await this.chrome.scripting.executeScript({
        target: { tabId: targetA.tab.id },
        func: async (key) => {
          localStorage.setItem(key, 'local');
          sessionStorage.setItem(key, 'session');
          document.cookie = `${key}=cookie; Path=/; SameSite=Lax`;
          await new Promise((resolve, reject) => {
            const request = indexedDB.open(key, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('state');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction('state', 'readwrite');
              tx.objectStore('state').put('indexed-db', 'value');
              tx.oncomplete = () => { db.close(); resolve(); };
              tx.onerror = () => reject(tx.error);
            };
          });
          const button = document.createElement('button');
          button.id = key;
          let clicked = false;
          button.addEventListener('click', () => { clicked = true; });
          document.documentElement.appendChild(button);
          button.click();
          button.remove();
          return { clicked };
        },
        args: [probeKey],
      });
      if (writeResult?.[0]?.result?.clicked !== true) throw new Error('受控页面脚本点击验证失败');
      const capturedCookies = await this.sendBrowserCommand('Storage.getCookies', {
        browserContextId: contextA,
        urls: [url],
      });
      const capturedProbeCookie = (capturedCookies?.cookies || []).find((cookie) => cookie.name === probeKey);
      if (!capturedProbeCookie) throw new Error('页签 CDP 未能捕获受控无痕会话 Cookie');
      // 无痕状态只有在最后一个窗口关闭时销毁，必须先结束 A 再创建 B。
      await this.disposeBrowserContext(contextA);
      contextA = '';
      contextB = await this.createBrowserContext();
      const targetB = await this.createTarget(contextB, url, { background: true });
      const readResult = await this.chrome.scripting.executeScript({
        target: { tabId: targetB.tab.id },
        func: async (key) => {
          if (typeof indexedDB.databases !== 'function') {
            throw new Error('CDP_AUTH_STATE_UNSUPPORTED: indexedDB.databases unavailable');
          }
          const databaseExists = (await indexedDB.databases()).some((item) => item.name === key);
          return {
            localStorage: localStorage.getItem(key),
            sessionStorage: sessionStorage.getItem(key),
            cookie: document.cookie.includes(`${key}=`),
            indexedDB: databaseExists,
          };
        },
        args: [probeKey],
      });
      const isolated = readResult?.[0]?.result;
      if (!isolated
        || isolated.localStorage !== null
        || isolated.sessionStorage !== null
        || isolated.cookie !== false
        || isolated.indexedDB !== false) {
        throw new Error('两个受控无痕会话之间存在浏览器状态泄漏');
      }
      await this.sendBrowserCommand('Storage.setCookies', {
        browserContextId: contextB,
        cookies: [cookieForSet(capturedProbeCookie)],
      });
      const restoredCookie = await this.chrome.scripting.executeScript({
        target: { tabId: targetB.tab.id },
        func: (key) => document.cookie.includes(`${key}=`),
        args: [probeKey],
      });
      if (restoredCookie?.[0]?.result !== true) throw new Error('页签 CDP 未能恢复受控无痕会话 Cookie');
      probeResult = {
        ok: true,
        managedBrowserContext: true,
        managedSessionStrategy: 'exclusive-incognito',
        supportedSessionModes: ['isolated', 'reuse-auth', 'reuse-browser'],
      };
    } catch (error) {
      probeResult = {
        ok: false,
        managedBrowserContext: false,
        managedSessionStrategy: 'exclusive-incognito',
        supportedSessionModes: ['legacy-profile'],
        errorCode: error?.code || 'CDP_BROWSER_CONTEXT_PROBE_FAILED',
        reason: asErrorMessage(error),
      };
    } finally {
      const cleanupFailures = [];
      for (const contextId of [contextB, contextA].filter(Boolean)) {
        try {
          await this.disposeBrowserContext(contextId);
        } catch (error) {
          cleanupFailures.push(`${contextId}: ${asErrorMessage(error)}`);
        }
      }
      await this.disconnect();
      if (cleanupFailures.length) {
        probeResult = {
          ok: false,
          managedBrowserContext: false,
          managedSessionStrategy: 'exclusive-incognito',
          supportedSessionModes: ['legacy-profile'],
          errorCode: 'CDP_SESSION_CLEANUP_FAILED',
          reason: `能力探测会话清理失败：${cleanupFailures.join('；')}`,
        };
      }
    }
    return probeResult;
  }
}
