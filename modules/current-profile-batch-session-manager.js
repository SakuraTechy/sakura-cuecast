const SESSION_METADATA_KEY = 'cuecastCurrentProfileBatchSession';

function normalizeOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

function isLoginUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /(^|[\/_-])(login|signin|sign-in|auth|sso)([\/_-]|$)/i.test(`${url.hostname}${url.pathname}`);
  } catch {
    return true;
  }
}

async function sha256(value) {
  if (!value || !globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

/**
 * 管理普通 Chrome Profile 中的批次回放窗口。
 * 只关闭 CueCast 创建的标签页，不接管或关闭用户原有页面。
 */
export class CurrentProfileBatchSessionManager {
  constructor(chromeApi = globalThis.chrome) {
    this.chrome = chromeApi;
    this.batch = null;
    this.cleanupPromise = null;
    this.recoveryPromise = null;
  }

  ownsBatch(batchId) {
    return Boolean(this.batch && this.batch.batchId === String(batchId || ''));
  }

  async beginBatch({
    batchId,
    sessionMode,
    browserSessionSource,
    sourceTabId,
    executionCapability = '',
  }) {
    const normalizedBatchId = String(batchId || '').trim();
    const normalizedMode = String(sessionMode || '').trim().toLowerCase();
    const normalizedSource = String(browserSessionSource || '').trim().toLowerCase();
    if (!normalizedBatchId) throw new Error('CDP 批次缺少 batchId');
    if (normalizedSource !== 'current-profile' || normalizedMode !== 'legacy-profile') {
      const error = new Error(`CDP 当前 Profile 批次配置无效：${normalizedSource}/${normalizedMode}`);
      error.code = 'CDP_SESSION_CONFIG_INVALID';
      throw error;
    }
    const executionCapabilityHash = await sha256(executionCapability);
    if (!executionCapabilityHash) {
      const error = new Error('CDP 当前 Profile 批次缺少有效 executionCapability');
      error.code = 'CDP_EXECUTION_CAPABILITY_MISSING';
      throw error;
    }
    const sourceTab = await this.getLiveTab(sourceTabId);
    if (!sourceTab || sourceTab.incognito === true || !Number.isInteger(Number(sourceTab.windowId))) {
      const error = new Error('当前浏览器兼容模式必须从普通 Chrome 窗口中的 Admin 页面启动');
      error.code = 'CDP_CURRENT_PROFILE_SOURCE_INVALID';
      throw error;
    }

    if (this.batch) {
      if (this.batch.batchId === normalizedBatchId
        && this.batch.executionCapabilityHash === executionCapabilityHash) {
        return this.batchResponse();
      }
      const error = new Error(`已有其他当前 Profile CDP 批次运行中：${this.batch.batchId}`);
      error.code = 'CDP_SESSION_CONFLICT';
      throw error;
    }

    await this.recoverOrCleanup();
    this.batch = {
      batchId: normalizedBatchId,
      sessionMode: normalizedMode,
      browserSessionSource: normalizedSource,
      executionCapabilityHash,
      sourceTabId: Number(sourceTab.id),
      sourceWindowId: Number(sourceTab.windowId),
      managedWindowId: null,
      activeTabId: null,
      managedTabIds: new Set(),
      lastSuccessfulUrl: '',
      resetCount: 0,
      state: 'idle',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.persistMetadata();
    return this.batchResponse();
  }

  async prepareCase({ batchId, sessionMode, browserSessionSource, executionCapability, startUrl, ignoreHttpsErrors }) {
    this.assertBatch(batchId, sessionMode, browserSessionSource);
    await this.assertExecutionCapability(executionCapability);
    const start = String(startUrl || '').trim();
    if (!/^https?:\/\//i.test(start)) {
      const error = new Error(`CDP 当前 Profile 回放缺少有效 start_url：${start || '-'}`);
      error.code = 'CDP_SESSION_START_URL_INVALID';
      throw error;
    }

    let activeTab = await this.getOwnedTab(this.batch.activeTabId);
    if (!activeTab && this.batch.managedTabIds.size) {
      this.batch.state = 'resetting';
      await this.closeManagedTabs();
      this.batch.resetCount += 1;
    }
    if (!activeTab) {
      const playbackWindow = await this.chrome.windows.create({
        // 开关开启时必须先创建空白页，由 Player 附加 CDP 并设置证书策略后再导航。
        url: ignoreHttpsErrors === true ? 'about:blank' : start,
        focused: true,
      });
      activeTab = playbackWindow?.tabs?.[0];
      if (!activeTab?.id || activeTab.incognito === true || playbackWindow.incognito === true) {
        throw new Error('无法创建当前 Profile 的普通 Chrome 回放窗口');
      }
      this.batch.activeTabId = Number(activeTab.id);
      this.batch.managedWindowId = Number(playbackWindow.id ?? activeTab.windowId);
      this.batch.managedTabIds.add(Number(activeTab.id));
      this.batch.state = 'running';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      return {
        tabId: Number(activeTab.id),
        managedTabIds: [...this.batch.managedTabIds],
        keepTabOpenAfterPlayback: true,
        skipInitialNavigation: ignoreHttpsErrors !== true,
        navigationUrl: start,
        sessionTransition: 'current-profile-window-created',
      };
    }

    const currentOrigin = normalizeOrigin(activeTab.url);
    const startOrigin = normalizeOrigin(start);
    const skipInitialNavigation = Boolean(
      currentOrigin
      && currentOrigin === startOrigin
      && !isLoginUrl(activeTab.url),
    );
    this.batch.state = 'running';
    this.batch.updatedAt = Date.now();
    await this.persistMetadata();
    return {
      tabId: Number(activeTab.id),
      managedTabIds: [...this.batch.managedTabIds],
      keepTabOpenAfterPlayback: true,
      skipInitialNavigation,
      sessionTransition: skipInitialNavigation
        ? 'current-profile-page-reused'
        : 'current-profile-page-navigated',
    };
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
    for (const tabId of managedTabIds) {
      const tab = await this.getLiveTab(tabId);
      if (!tab || tab.incognito === true || Number(tab.id) === this.batch.sourceTabId) continue;
      this.batch.managedTabIds.add(Number(tab.id));
    }
    const activeTab = await this.getOwnedTab(finalActiveTabId)
      || await this.getOwnedTab(this.batch.activeTabId);
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

    if (!browserSessionPrepared) {
      transition.navigationDecision = 'browser-not-required';
      this.batch.state = 'idle';
      await this.persistMetadata();
      return transition;
    }
    if (success && activeTab) {
      this.batch.activeTabId = Number(activeTab.id);
      this.batch.lastSuccessfulUrl = String(activeTab.url || finalUrl || '');
      this.batch.state = 'idle';
      this.batch.updatedAt = Date.now();
      await this.persistMetadata();
      return transition;
    }

    this.batch.state = 'resetting';
    await this.closeManagedTabs();
    this.batch.resetCount += 1;
    this.batch.state = 'idle';
    this.batch.updatedAt = Date.now();
    transition.reset = true;
    transition.resetCount = this.batch.resetCount;
    transition.resetReason = success ? 'active-target-lost' : 'case-failed-or-cancelled';
    await this.persistMetadata();
    if (success) {
      const error = new Error('CDP 当前 Profile 批次活动标签页已关闭');
      error.code = 'CDP_SESSION_TARGET_LOST';
      error.sessionTransition = transition;
      throw error;
    }
    return transition;
  }

  async endBatch(batchId, executionCapability = '') {
    return this.finishBatch(batchId, executionCapability, 'closed');
  }

  async abortBatch(batchId, executionCapability = '') {
    return this.finishBatch(batchId, executionCapability, 'aborted');
  }

  async finishBatch(batchId, executionCapability, state) {
    if (!this.batch) {
      await this.cleanupStoredBatch(batchId, executionCapability);
      return { ok: true, batchId: String(batchId || ''), state };
    }
    this.assertBatch(batchId);
    await this.assertExecutionCapability(executionCapability);
    const response = this.batchResponse();
    await this.cleanupBatch();
    return { ...response, state };
  }

  async cleanupBatch() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      if (this.batch) this.batch.state = 'closing';
      await this.closeManagedTabs();
      this.batch = null;
      await this.chrome.storage.session.remove(SESSION_METADATA_KEY).catch(() => {});
    })().finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  async recoverOrCleanup() {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this._recoverOrCleanup()
      .finally(() => { this.recoveryPromise = null; });
    return this.recoveryPromise;
  }

  async _recoverOrCleanup() {
    const stored = await this.chrome.storage.session.get(SESSION_METADATA_KEY).catch(() => ({}));
    const metadata = stored?.[SESSION_METADATA_KEY];
    if (!metadata) return { ok: true, cleaned: false };
    await this.removeTabs(metadata.managedTabIds || [], metadata, true);
    await this.chrome.storage.session.remove(SESSION_METADATA_KEY).catch(() => {});
    return { ok: true, cleaned: true };
  }

  async cleanupStoredBatch(batchId, executionCapability) {
    const stored = await this.chrome.storage.session.get(SESSION_METADATA_KEY).catch(() => ({}));
    const metadata = stored?.[SESSION_METADATA_KEY];
    if (!metadata) return;
    if (String(batchId || '') !== String(metadata.batchId || '')) {
      const error = new Error(`CDP batchId 不匹配：${batchId || '-'}/${metadata.batchId || '-'}`);
      error.code = 'CDP_BATCH_MISMATCH';
      throw error;
    }
    const candidateHash = await sha256(executionCapability);
    if (!candidateHash || candidateHash !== metadata.executionCapabilityHash) {
      const error = new Error('CDP executionCapability 与遗留当前 Profile 批次不匹配');
      error.code = 'CDP_EXECUTION_CAPABILITY_MISMATCH';
      throw error;
    }
    await this.removeTabs(metadata.managedTabIds || [], metadata, true);
    await this.chrome.storage.session.remove(SESSION_METADATA_KEY).catch(() => {});
  }

  handleTabCreated(tab) {
    if (!this.batch || tab?.incognito === true || !Number.isInteger(Number(tab?.id))) return;
    if (!this.batch.managedTabIds.has(Number(tab.openerTabId))) return;
    this.batch.managedTabIds.add(Number(tab.id));
    this.batch.updatedAt = Date.now();
    void this.persistMetadata();
  }

  handleTabRemoved(tabId) {
    if (!this.batch || ['closing', 'resetting'].includes(this.batch.state)) return;
    this.batch.managedTabIds.delete(Number(tabId));
    if (Number(this.batch.activeTabId) === Number(tabId)) this.batch.activeTabId = null;
    this.batch.updatedAt = Date.now();
    void this.persistMetadata();
  }

  assertBatch(batchId, sessionMode = '', browserSessionSource = '') {
    if (!this.batch) {
      const error = new Error('CDP 当前 Profile 批次会话尚未开始');
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

  async assertExecutionCapability(executionCapability) {
    const candidateHash = await sha256(executionCapability);
    if (!candidateHash || candidateHash !== this.batch?.executionCapabilityHash) {
      const error = new Error('CDP executionCapability 与当前 Profile 批次不匹配');
      error.code = 'CDP_EXECUTION_CAPABILITY_MISMATCH';
      throw error;
    }
  }

  async getLiveTab(tabId) {
    const normalized = Number(tabId);
    if (!Number.isInteger(normalized) || normalized <= 0) return null;
    return this.chrome.tabs.get(normalized).catch(() => null);
  }

  async getOwnedTab(tabId) {
    const normalized = Number(tabId);
    if (!this.batch?.managedTabIds.has(normalized)) return null;
    const tab = await this.getLiveTab(normalized);
    return tab && tab.incognito !== true ? tab : null;
  }

  async closeManagedTabs() {
    if (!this.batch) return;
    await this.removeTabs([...this.batch.managedTabIds], this.batch);
    this.batch.managedTabIds.clear();
    this.batch.activeTabId = null;
    this.batch.managedWindowId = null;
  }

  async removeTabs(tabIds, ownership, requireOwnershipProof = false) {
    const protectedTabId = Number(ownership?.sourceTabId);
    const managedWindowId = Number(ownership?.managedWindowId);
    const candidates = new Map();
    for (const tabId of new Set(tabIds.map(Number))) {
      if (!Number.isInteger(tabId) || tabId <= 0 || tabId === Number(protectedTabId)) continue;
      const tab = await this.getLiveTab(tabId);
      if (tab && tab.incognito !== true) candidates.set(tabId, tab);
    }
    const proven = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [tabId, tab] of candidates) {
        if (proven.has(tabId)) continue;
        const rootTabInManagedWindow = tab.windowId === managedWindowId
          && Number(tab.id) === Number(ownership?.activeTabId);
        if (rootTabInManagedWindow
          || Number(tab.openerTabId) === protectedTabId
          || proven.has(Number(tab.openerTabId))) {
          proven.add(tabId);
          changed = true;
        }
      }
    }
    const removable = [];
    for (const tabId of candidates.keys()) {
      if (!requireOwnershipProof || proven.has(tabId)) removable.push(tabId);
    }
    await Promise.all(removable.map((tabId) => this.chrome.tabs.remove(tabId).catch(() => {})));
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
    await this.chrome.storage.session.set({
      [SESSION_METADATA_KEY]: {
        ...this.batch,
        managedTabIds: [...this.batch.managedTabIds],
      },
    });
  }
}
