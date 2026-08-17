import { CdpAuthStateService, normalizeOrigin } from './cdp-auth-state.js';
import { CdpBrowserContextDriver } from './cdp-browser-context-driver.js';

const SESSION_METADATA_KEY = 'cuecastCdpBatchSession';
const AUTH_SNAPSHOT_KEY = 'cuecastCdpBatchAuthSnapshot';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const FAILED_CAPABILITY_TTL_MS = 30 * 1000;
const CAPABILITY_CACHE_KEY = 'cuecastCdpCapabilities';
const MANAGED_SESSION_MODES = new Set(['isolated', 'reuse-auth', 'reuse-browser']);

function messageOf(error) {
  return String(error?.message || error || '未知错误');
}

function isLoginUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /(^|[\/_-])(login|signin|sign-in|auth|sso)([\/_-]|$)/i.test(`${url.hostname}${url.pathname}`);
  } catch {
    return true;
  }
}

function assertManagedSessionConfig(source, mode) {
  if (source !== 'managed-context' || !MANAGED_SESSION_MODES.has(mode)) {
    const error = new Error(`CDP 批次会话配置无效：${source}/${mode}`);
    error.code = 'CDP_SESSION_CONFIG_INVALID';
    throw error;
  }
}

async function sha256(value) {
  if (!value || !globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

/**
 * 管理一个扩展 CDP 批次的浏览器状态边界。
 * Admin 只接收脱敏转换结果；受控无痕窗口、Cookie 和认证快照始终留在扩展本机内存/session storage。
 */
export class CdpBatchSessionManager {
  constructor(chromeApi = globalThis.chrome, dependencies = {}) {
    this.chrome = chromeApi;
    this.driverFactory = dependencies.driverFactory || (() => new CdpBrowserContextDriver(chromeApi));
    this.authState = dependencies.authState || new CdpAuthStateService(chromeApi);
    this.driver = null;
    this.batch = null;
    this.authSnapshot = null;
    this.cachedCapabilities = null;
    this.probePromise = null;
    this.cleanupPromise = null;
    this._onDebuggerEvent = this.handleDebuggerEvent.bind(this);
    this.chrome?.debugger?.onEvent?.addListener?.(this._onDebuggerEvent);
  }

  getCapabilities() {
    return this.cachedCapabilities || {
      ok: true,
      managedBrowserContext: false,
      managedSessionStrategy: 'exclusive-incognito',
      supportedSessionModes: ['legacy-profile'],
      reason: '受控无痕会话尚未验证',
    };
  }

  async probeCapabilities(sourceTabId, probeUrl = '') {
    if (this.cachedCapabilities?.managedBrowserContext) return this.cachedCapabilities;
    if (this.probePromise) return this.probePromise;
    this.probePromise = (async () => {
      const extensionVersion = this.chrome.runtime?.getManifest?.().version || '';
      const stored = await this.chrome.storage.session.get(CAPABILITY_CACHE_KEY).catch(() => ({}));
      const cached = stored?.[CAPABILITY_CACHE_KEY];
      const cacheTtl = cached?.result?.managedBrowserContext ? SESSION_TTL_MS : FAILED_CAPABILITY_TTL_MS;
      if (cached?.timestamp
        && cached.extensionVersion === extensionVersion
        && Date.now() - cached.timestamp < cacheTtl) {
        this.cachedCapabilities = cached.result;
        return this.cachedCapabilities;
      }
      const driver = this.driverFactory();
      const result = await driver.probe(sourceTabId, probeUrl);
      this.cachedCapabilities = result;
      await this.chrome.storage.session.set({
        [CAPABILITY_CACHE_KEY]: { timestamp: Date.now(), extensionVersion, result },
      }).catch(() => {});
      return result;
    })().finally(() => { this.probePromise = null; });
    return this.probePromise;
  }

  async beginBatch({
    batchId,
    sessionMode,
    browserSessionSource,
    sourceTabId,
    sourceUrl = '',
    executionCapability = '',
  }) {
    const normalizedBatchId = String(batchId || '').trim();
    const normalizedMode = String(sessionMode || '').trim().toLowerCase();
    const normalizedSource = String(browserSessionSource || '').trim().toLowerCase();
    if (!normalizedBatchId) throw new Error('CDP 批次缺少 batchId');
    assertManagedSessionConfig(normalizedSource, normalizedMode);
    const executionCapabilityHash = await sha256(executionCapability);
    if (!executionCapabilityHash) {
      const error = new Error('CDP 受控批次缺少有效 executionCapability');
      error.code = 'CDP_EXECUTION_CAPABILITY_MISSING';
      throw error;
    }

    if (this.batch) {
      if (this.batch.batchId === normalizedBatchId
        && this.batch.sessionMode === normalizedMode
        && this.batch.browserSessionSource === normalizedSource) {
        if (this.batch.executionCapabilityHash !== executionCapabilityHash) {
          const error = new Error('CDP 批次执行能力与已建立会话不一致');
          error.code = 'CDP_EXECUTION_CAPABILITY_MISMATCH';
          throw error;
        }
        return this.batchResponse();
      }
      const error = new Error(`已有其他 CDP 批次运行中：${this.batch.batchId}`);
      error.code = 'CDP_SESSION_CONFLICT';
      throw error;
    }

    const stored = await this.chrome.storage.session.get([SESSION_METADATA_KEY, AUTH_SNAPSHOT_KEY]).catch(() => ({}));
    if (stored?.[SESSION_METADATA_KEY]) {
      const recovery = await this.recoverOrCleanup(sourceTabId);
      if (!recovery.ok) {
        const error = new Error(`遗留 CDP 会话未能确认清理：${recovery.reason || '未知原因'}`);
        error.code = recovery.errorCode || 'CDP_SESSION_CLEANUP_FAILED';
        throw error;
      }
    }

    let capabilities = this.getCapabilities();
    if (!capabilities.managedBrowserContext) {
      capabilities = await this.probeCapabilities(sourceTabId, sourceUrl);
    }
    if (!capabilities.managedBrowserContext) {
      const error = new Error(`当前 Chrome 不支持受控用例会话：${capabilities.reason || '能力探测未通过'}`);
      error.code = capabilities.errorCode || 'CDP_BROWSER_CONTEXT_UNAVAILABLE';
      throw error;
    }

    this.driver = this.driverFactory();
    this.driver.setManagedTargetObserver?.((tab) => this.recordManagedTarget(tab));
    await this.driver.connect(sourceTabId);
    this.authSnapshot = null;
    this.batch = {
      batchId: normalizedBatchId,
      sessionMode: normalizedMode,
      browserSessionSource: normalizedSource,
      executionCapabilityHash,
      state: 'idle',
      browserContextId: '',
      caseContextId: '',
      activeTargetId: '',
      activeTabId: null,
      managedTabIds: new Set(),
      managedWindowIds: new Set(),
      pendingIncognitoTabIds: new Set(),
      contaminated: false,
      visitedOrigins: new Set(),
      lastSuccessfulUrl: '',
      resetCount: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.clearAuthSnapshot();
    await this.persistMetadata();
    return this.batchResponse();
  }

  async prepareCase({ batchId, sessionMode, browserSessionSource, executionCapability, startUrl, ignoreHttpsErrors }) {
    this.assertBatch(batchId, sessionMode, browserSessionSource);
    await this.assertExecutionCapability(executionCapability);
    await this.assertSessionIsolation();
    const start = String(startUrl || '').trim();
    if (!/^https?:\/\//i.test(start)) {
      const error = new Error(`CDP 受控回放缺少有效 start_url：${start || '-'}`);
      error.code = 'CDP_SESSION_START_URL_INVALID';
      throw error;
    }
    this.batch.state = 'preparing';
    this.batch.updatedAt = Date.now();
    const startOrigin = normalizeOrigin(start);
    if (startOrigin) this.batch.visitedOrigins.add(startOrigin);

    if (this.batch.sessionMode === 'reuse-browser' && this.batch.browserContextId) {
      const activeTab = await this.getLiveTab(this.batch.activeTabId);
      if (activeTab) {
        await this.reconcilePendingIncognitoTabs();
        await this.assertSessionIsolation();
        const currentOrigin = normalizeOrigin(activeTab.url);
        const skipInitialNavigation = Boolean(
          currentOrigin
          && currentOrigin === startOrigin
          && !isLoginUrl(activeTab.url),
        );
        this.batch.state = 'running';
        await this.persistMetadata();
        return {
          tabId: activeTab.id,
          keepTabOpenAfterPlayback: true,
          skipInitialNavigation,
          sessionTransition: skipInitialNavigation ? 'reused-browser-page' : 'reused-browser-navigated',
        };
      }
      await this.disposeActiveContext();
      this.batch.resetCount += 1;
    }

    const contextId = await this.driver.createBrowserContext();
    this.batch.caseContextId = contextId;
    if (this.batch.sessionMode === 'reuse-browser') this.batch.browserContextId = contextId;

    try {
      let launchUrl = start;
      let target = null;
      if (this.batch.sessionMode === 'reuse-auth' && this.authSnapshot) {
        target = await this.driver.createTarget(contextId, 'about:blank', {
          newWindow: true,
          background: false,
        });
        await this.authState.restore({
          browserContextId: contextId,
          driver: this.driver,
          snapshot: this.authSnapshot,
          target,
        });
        if (isLoginUrl(start)
          && this.authSnapshot.lastUrl
          && !isLoginUrl(this.authSnapshot.lastUrl)
          && normalizeOrigin(this.authSnapshot.lastUrl) === startOrigin) {
          launchUrl = this.authSnapshot.lastUrl;
        }
        if (ignoreHttpsErrors !== true) {
          target.tab = await this.driver.navigateTab(target.tab.id, launchUrl);
        }
      }

      if (!target) {
        target = await this.driver.createTarget(
          contextId,
          ignoreHttpsErrors === true ? 'about:blank' : launchUrl,
          { newWindow: true, background: false },
        );
      }
      this.batch.activeTargetId = target.targetId;
      this.batch.activeTabId = target.tab.id;
      this.batch.managedTabIds.add(target.tab.id);
      if (Number.isInteger(target.tab.windowId)) this.batch.managedWindowIds.add(target.tab.windowId);
      await this.reconcilePendingIncognitoTabs();
      await this.assertSessionIsolation();
      this.batch.state = 'running';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      return {
        tabId: target.tab.id,
        keepTabOpenAfterPlayback: true,
        skipInitialNavigation: ignoreHttpsErrors !== true,
        navigationUrl: launchUrl,
        sessionTransition: this.authSnapshot && this.batch.sessionMode === 'reuse-auth'
          ? 'auth-restored'
          : 'clean-context-created',
      };
    } catch (error) {
      await this.disposeActiveContext();
      this.batch.state = 'idle';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      throw error;
    }
  }

  async finalizeCase({
    batchId,
    success,
    finalActiveTabId,
    managedTabIds = [],
    finalUrl = '',
    navigationDecision = '',
    browserSessionPrepared = true,
  }) {
    this.assertBatch(batchId);
    this.batch.state = 'resetting';
    for (const tabId of managedTabIds || []) {
      if (!Number.isInteger(Number(tabId))) continue;
      const managedTab = await this.getLiveTab(tabId);
      if (!managedTab?.incognito) continue;
      this.batch.managedTabIds.add(Number(tabId));
      if (Number.isInteger(managedTab.windowId)) this.batch.managedWindowIds.add(managedTab.windowId);
      this.driver?.registerManagedTab?.(
        this.batch.caseContextId || this.batch.browserContextId,
        managedTab,
      );
    }
    await this.reconcilePendingIncognitoTabs();
    await this.assertSessionIsolation();
    const activeTab = await this.getLiveTab(finalActiveTabId)
      || await this.getLiveTab(this.batch.activeTabId);
    const tabs = await this.getManagedTabs();
    for (const tab of tabs) {
      if (Number.isInteger(tab.windowId)) this.batch.managedWindowIds.add(tab.windowId);
      this.driver?.registerManagedTab?.(this.batch.caseContextId || this.batch.browserContextId, tab);
    }
    const resolvedFinalUrl = String(activeTab?.url || finalUrl || '');
    for (const tab of tabs) {
      const origin = normalizeOrigin(tab?.url);
      if (origin) this.batch.visitedOrigins.add(origin);
    }
    const transition = {
      requestedMode: this.batch.sessionMode,
      appliedMode: this.batch.sessionMode,
      browserSessionSource: this.batch.browserSessionSource,
      finalActiveTabId: activeTab?.id ?? null,
      reset: false,
      resetCount: this.batch.resetCount,
      authStateCommitted: false,
      navigationDecision: String(navigationDecision || ''),
      resetReason: '',
    };

    if (success && browserSessionPrepared && !activeTab) {
      await this.disposeActiveContext();
      if (this.batch.sessionMode === 'reuse-browser') {
        this.batch.resetCount += 1;
        transition.reset = true;
        transition.resetCount = this.batch.resetCount;
        transition.resetReason = 'active-target-lost';
      }
      this.batch.state = 'idle';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      const error = new Error('CDP 批次受控活动标签页已关闭');
      error.code = 'CDP_SESSION_TARGET_LOST';
      error.sessionTransition = transition;
      throw error;
    }

    if (!browserSessionPrepared) {
      transition.navigationDecision = 'browser-not-required';
    }

    if (success && this.batch.sessionMode === 'reuse-browser') {
      this.batch.activeTabId = activeTab?.id ?? this.batch.activeTabId;
      this.batch.lastSuccessfulUrl = resolvedFinalUrl;
      this.batch.state = 'idle';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      return transition;
    }

    if (success && this.batch.sessionMode === 'reuse-auth') {
      try {
        const candidate = await this.authState.capture({
          browserContextId: this.batch.caseContextId,
          driver: this.driver,
          tabs,
          origins: [...this.batch.visitedOrigins],
          lastUrl: resolvedFinalUrl,
        });
        // 先得到完整候选快照再替换 current，捕获失败时上一条成功状态保持不变。
        this.authSnapshot = candidate;
        await this.persistAuthSnapshot(candidate);
        this.batch.lastSuccessfulUrl = resolvedFinalUrl;
        transition.authStateCommitted = true;
      } catch (error) {
        await this.disposeActiveContext();
        this.batch.state = 'idle';
        this.batch.updatedAt = Date.now();
        await this.persistMetadata();
        throw error;
      }
    }

    await this.disposeActiveContext();
    if (!success && this.batch.sessionMode === 'reuse-browser') {
      this.batch.resetCount += 1;
      transition.reset = true;
      transition.resetCount = this.batch.resetCount;
      transition.resetReason = 'case-failed-or-cancelled';
    }
    this.batch.state = 'idle';
    this.batch.updatedAt = Date.now();
    await this.persistMetadata();
    return transition;
  }

  async endBatch(batchId, executionCapability = '', sourceTabId = null) {
    if (!this.batch) {
      await this.cleanupStoredBatch(batchId, executionCapability, sourceTabId);
      return { ok: true, batchId: String(batchId || ''), state: 'closed' };
    }
    this.assertBatch(batchId);
    const response = this.batchResponse();
    await this.assertExecutionCapability(executionCapability);
    await this.cleanupBatch();
    return { ...response, state: 'closed' };
  }

  async abortBatch(batchId, executionCapability = '', sourceTabId = null) {
    if (!this.batch) {
      await this.cleanupStoredBatch(batchId, executionCapability, sourceTabId);
      return { ok: true, state: 'closed' };
    }
    this.assertBatch(batchId);
    const response = this.batchResponse();
    await this.assertExecutionCapability(executionCapability);
    await this.cleanupBatch();
    return { ...response, state: 'aborted' };
  }

  async cleanupStoredBatch(batchId, executionCapability, sourceTabId) {
    const stored = await this.chrome.storage.session.get(SESSION_METADATA_KEY).catch(() => ({}));
    const metadata = stored?.[SESSION_METADATA_KEY];
    if (!metadata) {
      await this.clearStoredSession();
      return;
    }
    if (String(batchId || '') !== String(metadata.batchId || '')) {
      const error = new Error(`CDP batchId 不匹配：${batchId || '-'}/${metadata.batchId || '-'}`);
      error.code = 'CDP_BATCH_MISMATCH';
      throw error;
    }
    const candidateHash = await sha256(executionCapability);
    if (!candidateHash || candidateHash !== metadata.executionCapabilityHash) {
      const error = new Error('CDP executionCapability 与遗留批次会话不匹配');
      error.code = 'CDP_EXECUTION_CAPABILITY_MISMATCH';
      throw error;
    }
    const recovery = await this.recoverOrCleanup(sourceTabId);
    if (!recovery.ok) {
      const error = new Error(`遗留 CDP 会话清理失败：${recovery.reason || '未知原因'}`);
      error.code = recovery.errorCode || 'CDP_SESSION_CLEANUP_FAILED';
      throw error;
    }
  }

  async cleanupBatch() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this._cleanupBatch().finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  async _cleanupBatch() {
    if (this.batch) this.batch.state = 'closing';
    try {
      await this.disposeActiveContext();
      if (this.driver) await this.driver.cleanup();
    } catch (error) {
      if (this.batch) {
        this.batch.state = 'cleanup-failed';
        this.batch.updatedAt = Date.now();
        await this.persistMetadata();
      }
      if (error?.code) throw error;
      const cleanupError = new Error(`CDP 受控会话清理失败：${messageOf(error)}`);
      cleanupError.code = 'CDP_SESSION_CLEANUP_FAILED';
      throw cleanupError;
    }
    this.driver = null;
    this.batch = null;
    this.authSnapshot = null;
    await this.clearStoredSession();
  }

  async disposeActiveContext() {
    if (!this.batch || !this.driver) return;
    const contextIds = new Set([
      this.batch.caseContextId,
      this.batch.browserContextId,
    ].filter(Boolean));
    const failures = [];
    for (const contextId of contextIds) {
      try {
        await this.driver.disposeBrowserContext(contextId);
      } catch (error) {
        failures.push(`${contextId}: ${messageOf(error)}`);
      }
    }
    if (failures.length) {
      const error = new Error(`CDP 受控会话清理失败：${failures.join('；')}`);
      error.code = 'CDP_SESSION_CLEANUP_FAILED';
      throw error;
    }
    this.batch.caseContextId = '';
    this.batch.browserContextId = '';
    this.batch.activeTargetId = '';
    this.batch.activeTabId = null;
    this.batch.managedTabIds.clear();
    this.batch.managedWindowIds.clear();
    this.batch.pendingIncognitoTabIds.clear();
  }

  async recoverOrCleanup(sourceTabId = null) {
    const stored = await this.chrome.storage.session.get(SESSION_METADATA_KEY).catch(() => ({}));
    const metadata = stored?.[SESSION_METADATA_KEY];
    if (!metadata) return { ok: true, cleaned: false };
    const age = Date.now() - Number(metadata.updatedAt || metadata.startedAt || 0);
    const recoveryDriver = this.driverFactory();
    let cleaned = false;
    try {
      // Service Worker 重启后内存中的 context 映射已丢失，只按持久化窗口 ID 清理受控无痕窗口。
      await recoveryDriver.cleanupRecoveredSession(metadata);
      cleaned = true;
      return { ok: true, cleaned: true, expired: age > SESSION_TTL_MS };
    } catch (error) {
      return {
        ok: false,
        cleaned: false,
        errorCode: error?.code || 'CDP_SESSION_CLEANUP_FAILED',
        reason: messageOf(error),
      };
    } finally {
      await recoveryDriver.disconnect().catch(() => {});
      if (cleaned) await this.clearStoredSession();
    }
  }

  handleDebuggerEvent(source, method, params) {
    if (!this.batch || method !== 'Page.frameNavigated' || params?.frame?.parentId) return;
    void this.trackManagedNavigation(source, params);
  }

  handleTabCreated(tab) {
    if (!this.batch || tab?.incognito !== true) return;
    void this.trackManagedTabCreated(tab);
  }

  async trackManagedTabCreated(tab) {
    const batchId = this.batch?.batchId;
    if (!batchId || !Number.isInteger(Number(tab?.id))) return;
    const openerTabId = Number(tab.openerTabId);
    const belongsToManagedWindow = this.batch.managedWindowIds.has(Number(tab.windowId));
    const openedByManagedTab = Number.isInteger(openerTabId) && this.batch.managedTabIds.has(openerTabId);
    if (!belongsToManagedWindow && !openedByManagedTab) {
      if (this.batch.state === 'preparing') {
        this.batch.pendingIncognitoTabIds.add(Number(tab.id));
        return;
      }
      this.batch.contaminated = true;
      this.batch.state = 'contaminated';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      return;
    }
    this.batch.managedTabIds.add(Number(tab.id));
    if (Number.isInteger(Number(tab.windowId))) this.batch.managedWindowIds.add(Number(tab.windowId));
    this.driver?.registerManagedTab?.(
      this.batch.caseContextId || this.batch.browserContextId,
      tab,
    );
    this.batch.updatedAt = Date.now();
    await this.persistMetadata();
  }

  async recordManagedTarget(tab) {
    if (!this.batch || tab?.incognito !== true || !Number.isInteger(Number(tab.id))) return;
    this.batch.managedTabIds.add(Number(tab.id));
    if (Number.isInteger(Number(tab.windowId))) this.batch.managedWindowIds.add(Number(tab.windowId));
    this.batch.pendingIncognitoTabIds.delete(Number(tab.id));
    this.batch.updatedAt = Date.now();
    await this.persistMetadata();
  }

  async reconcilePendingIncognitoTabs() {
    if (!this.batch?.pendingIncognitoTabIds.size) return;
    let contaminated = false;
    for (const tabId of this.batch.pendingIncognitoTabIds) {
      const tab = await this.getLiveTab(tabId);
      if (!tab?.incognito) continue;
      const belongsToManagedWindow = this.batch.managedWindowIds.has(Number(tab.windowId));
      const openedByManagedTab = Number.isInteger(Number(tab.openerTabId))
        && this.batch.managedTabIds.has(Number(tab.openerTabId));
      if (!belongsToManagedWindow && !openedByManagedTab) {
        contaminated = true;
        continue;
      }
      this.batch.managedTabIds.add(Number(tab.id));
      if (Number.isInteger(Number(tab.windowId))) this.batch.managedWindowIds.add(Number(tab.windowId));
      this.driver?.registerManagedTab?.(
        this.batch.caseContextId || this.batch.browserContextId,
        tab,
      );
    }
    this.batch.pendingIncognitoTabIds.clear();
    if (contaminated) {
      this.batch.contaminated = true;
      this.batch.state = 'contaminated';
    }
    this.batch.updatedAt = Date.now();
    await this.persistMetadata();
  }

  async trackManagedNavigation(source, params) {
    const batchId = this.batch?.batchId;
    const tabId = Number(source?.tabId);
    if (!batchId || !Number.isInteger(tabId)) return;
    let belongsToBatch = this.batch.managedTabIds.has(tabId);
    let candidate = belongsToBatch ? null : await this.getLiveTab(tabId);
    const inspected = new Set();
    while (!belongsToBatch && candidate?.openerTabId && !inspected.has(candidate.openerTabId)) {
      inspected.add(candidate.openerTabId);
      if (this.batch?.batchId !== batchId) return;
      if (this.batch.managedTabIds.has(candidate.openerTabId)) {
        belongsToBatch = true;
        this.batch.managedTabIds.add(tabId);
        if (Number.isInteger(candidate.windowId)) this.batch.managedWindowIds.add(candidate.windowId);
        this.driver?.registerManagedTab?.(
          this.batch.caseContextId || this.batch.browserContextId,
          candidate,
        );
        break;
      }
      candidate = await this.getLiveTab(candidate.openerTabId);
    }
    if (!belongsToBatch || this.batch?.batchId !== batchId) return;
    const managedTab = candidate || await this.getLiveTab(tabId);
    if (managedTab) {
      if (Number.isInteger(managedTab.windowId)) this.batch.managedWindowIds.add(managedTab.windowId);
      this.driver?.registerManagedTab?.(
        this.batch.caseContextId || this.batch.browserContextId,
        managedTab,
      );
    }
    const origin = normalizeOrigin(params?.frame?.url);
    if (origin) {
      this.batch.visitedOrigins.add(origin);
    }
    this.batch.updatedAt = Date.now();
    await this.persistMetadata();
  }

  assertBatch(batchId, sessionMode = '', browserSessionSource = '') {
    if (!this.batch) {
      const error = new Error('CDP 批次会话尚未开始');
      error.code = 'CDP_BATCH_NOT_STARTED';
      throw error;
    }
    if (String(batchId || '') !== this.batch.batchId) {
      const error = new Error(`CDP batchId 不匹配：${batchId || '-'}/${this.batch.batchId}`);
      error.code = 'CDP_BATCH_MISMATCH';
      throw error;
    }
    if (sessionMode && String(sessionMode) !== this.batch.sessionMode) {
      const error = new Error(`CDP sessionMode 不匹配：${sessionMode}/${this.batch.sessionMode}`);
      error.code = 'CDP_SESSION_MODE_MISMATCH';
      throw error;
    }
    if (browserSessionSource && String(browserSessionSource) !== this.batch.browserSessionSource) {
      const error = new Error(`CDP browserSessionSource 不匹配：${browserSessionSource}/${this.batch.browserSessionSource}`);
      error.code = 'CDP_SESSION_SOURCE_MISMATCH';
      throw error;
    }
  }

  async assertSessionIsolation() {
    if (this.batch?.contaminated) {
      const error = new Error('批次运行期间出现了非 CueCast 管理的无痕窗口；请关闭全部无痕窗口后中止并重试批次');
      error.code = 'CDP_INCOGNITO_SESSION_CONTAMINATED';
      throw error;
    }
    await this.driver?.assertNoForeignIncognitoWindows?.();
  }

  async assertExecutionCapability(executionCapability) {
    const expectedHash = this.batch?.executionCapabilityHash;
    const candidateHash = await sha256(executionCapability);
    if (!candidateHash || candidateHash !== expectedHash) {
      const error = new Error('CDP executionCapability 与批次会话不匹配');
      error.code = 'CDP_EXECUTION_CAPABILITY_MISMATCH';
      throw error;
    }
  }

  async getLiveTab(tabId) {
    const normalized = Number(tabId);
    if (!Number.isInteger(normalized) || normalized <= 0) return null;
    return this.chrome.tabs.get(normalized).catch(() => null);
  }

  async getManagedTabs() {
    if (!this.batch) return [];
    const tabs = await Promise.all([...this.batch.managedTabIds].map((tabId) => this.getLiveTab(tabId)));
    return tabs.filter(Boolean);
  }

  batchResponse() {
    return {
      ok: true,
      batchId: this.batch?.batchId || '',
      sessionMode: this.batch?.sessionMode || '',
      browserSessionSource: this.batch?.browserSessionSource || '',
      state: this.batch?.state || 'closed',
      resetCount: this.batch?.resetCount || 0,
    };
  }

  async persistMetadata() {
    if (!this.batch) return;
    const metadata = {
      batchId: this.batch.batchId,
      sessionMode: this.batch.sessionMode,
      browserSessionSource: this.batch.browserSessionSource,
      executionCapabilityHash: this.batch.executionCapabilityHash,
      state: this.batch.state,
      browserContextId: this.batch.browserContextId,
      caseContextId: this.batch.caseContextId,
      activeTargetId: this.batch.activeTargetId,
      activeTabId: this.batch.activeTabId,
      managedTabIds: [...this.batch.managedTabIds],
      managedWindowIds: [...this.batch.managedWindowIds],
      lastSuccessfulUrl: this.batch.lastSuccessfulUrl,
      resetCount: this.batch.resetCount,
      contaminated: this.batch.contaminated,
      startedAt: this.batch.startedAt,
      updatedAt: this.batch.updatedAt,
    };
    await this.chrome.storage.session.set({ [SESSION_METADATA_KEY]: metadata });
  }

  async persistAuthSnapshot(snapshot) {
    await this.chrome.storage.session.set({ [AUTH_SNAPSHOT_KEY]: snapshot });
  }

  async clearAuthSnapshot() {
    await this.chrome.storage.session.remove(AUTH_SNAPSHOT_KEY).catch(() => {});
  }

  async clearStoredSession() {
    await this.chrome.storage.session.remove([SESSION_METADATA_KEY, AUTH_SNAPSHOT_KEY]).catch(() => {});
  }
}

export { isLoginUrl };
