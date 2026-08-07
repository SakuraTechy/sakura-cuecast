/**
 * 录制管理器
 */
const RECORDER_SESSION_KEY = '__cc_recording_session_v1';

export class RecorderManager {
  constructor(state, api) {
    this.state = state;
    this.api = api;
    /** @type {number|null} 与某步之间插入录制时：在该步索引之后拼接（null 表示整表覆盖为本次录制） */
    this._insertAfterIndex = null;
    /** @type {object[]|null} 开始录制时拉取的已有步骤快照（不含 DB id，仅保存用字段） */
    this._existingStepsSnapshot = null;
  }

  _storageAreas() {
    const areas = [];
    if (chrome.storage.session) areas.push(chrome.storage.session);
    if (chrome.storage.local) areas.push(chrome.storage.local);
    return areas;
  }

  _buildSessionDraft() {
    return {
      active: this.state.mode === 'recording',
      testCaseId: this.state.testCaseId ?? null,
      apiBase: this.state.apiBase ?? '',
      authToken: this.state.authToken ?? '',
      currentTabId: this.state.currentTabId ?? null,
      recordingOpenedNewTab: this.state.recordingOpenedNewTab === true,
      recordingWindowId: this.state.recordingWindowId ?? null,
      recordingTabs: Array.isArray(this.state.recordingTabs) ? [...this.state.recordingTabs] : [],
      currentRecordingTabIndex: Number.isInteger(Number(this.state.currentRecordingTabIndex))
        ? Number(this.state.currentRecordingTabIndex)
        : 0,
      recordingScreenshotMode: this.state.recordingScreenshotMode || 'standard',
      recordingPaused: this.state.recordingPaused === true,
      recordedSteps: Array.isArray(this.state.recordedSteps) ? [...this.state.recordedSteps] : [],
      insertAfterIndex: this._insertAfterIndex,
      existingStepsSnapshot: Array.isArray(this._existingStepsSnapshot) ? [...this._existingStepsSnapshot] : null,
      recordingSessionId: this.state.recordingSessionId || '',
      recordingSessionEnabled: this.state.recordingSessionEnabled === true,
      recordingSessionHealthy: this.state.recordingSessionHealthy !== false,
      savedAt: Date.now(),
    };
  }

  _getRecordedStepCount() {
    return Array.isArray(this.state.recordedSteps) ? this.state.recordedSteps.length : 0;
  }

  async setPausedState(paused) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(null);
      if (!restored) return { ok: false, active: false };
    }
    this.state.recordingPaused = paused === true;
    await this._saveSessionDraft();
    this._notifyPopup();
    return { ok: true, active: true, paused: this.state.recordingPaused };
  }

  async _saveToArea(area, value) {
    if (!area) return;
    await area.set({ [RECORDER_SESSION_KEY]: value });
  }

  async _removeFromArea(area) {
    if (!area) return;
    await area.remove(RECORDER_SESSION_KEY);
  }

  async _readFromArea(area) {
    if (!area) return null;
    const stored = await area.get(RECORDER_SESSION_KEY);
    return stored?.[RECORDER_SESSION_KEY] || null;
  }

  _isSessionDraftUsable(session) {
    return !!(session && typeof session === 'object' && session.active === true);
  }

  _pickNewestSessionDraft(...sessions) {
    const usable = sessions.filter((s) => this._isSessionDraftUsable(s));
    if (!usable.length) return null;
    usable.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return usable[0];
  }

  async _saveSessionDraft() {
    const payload = this._buildSessionDraft();
    try {
      const areas = this._storageAreas();
      await Promise.all(areas.map((area) => this._saveToArea(area, payload)));
    } catch (e) {
      console.warn('[Recorder] 保存录制草稿失败:', e?.message || e);
    }
  }

  async _clearSessionDraft() {
    try {
      const areas = this._storageAreas();
      await Promise.all(areas.map((area) => this._removeFromArea(area)));
    } catch (e) {
      console.warn('[Recorder] 清理录制草稿失败:', e?.message || e);
    }
  }

  async _restoreSessionDraft(tabIdHint = null) {
    if (this.state.mode === 'recording') return true;
    try {
      const [sessionStore, localStore] = await Promise.all([
        this._readFromArea(chrome.storage.session || null).catch(() => null),
        this._readFromArea(chrome.storage.local || null).catch(() => null),
      ]);
      const session = this._pickNewestSessionDraft(sessionStore, localStore);
      if (!session) return false;
      const restoredTabId = Number.isInteger(Number(session.currentTabId))
        ? Number(session.currentTabId)
        : (Number.isInteger(Number(tabIdHint)) ? Number(tabIdHint) : null);
      if (restoredTabId == null) return false;
      this.state.mode = 'recording';
      this.state.testCaseId = session.testCaseId ?? null;
      this.state.apiBase = session.apiBase || this.state.apiBase;
      this.state.authToken = session.authToken || this.state.authToken;
      this.state.currentTabId = restoredTabId;
      this.state.recordingOpenedNewTab = session.recordingOpenedNewTab === true;
      this.state.recordingWindowId = Number.isInteger(Number(session.recordingWindowId))
        ? Number(session.recordingWindowId)
        : null;
      this.state.recordingTabs = Array.isArray(session.recordingTabs) ? [...session.recordingTabs] : [];
      this.state.currentRecordingTabIndex = Number.isInteger(Number(session.currentRecordingTabIndex))
        ? Number(session.currentRecordingTabIndex)
        : 0;
      if (!this.state.recordingTabs.length && restoredTabId != null) {
        this.state.recordingTabs = [{
          tabId: restoredTabId,
          index: 0,
          openerTabId: null,
          openerIndex: null,
          url: '',
        }];
      }
      this.state.recordingScreenshotMode = String(session.recordingScreenshotMode || 'standard').trim().toLowerCase() === 'full_hd'
        ? 'full_hd'
        : 'standard';
      this.state.recordingPaused = session.recordingPaused === true;
      this.state.recordingStartedAt = Number(session.savedAt || Date.now()) || Date.now();
      this.state.recordedSteps = Array.isArray(session.recordedSteps) ? [...session.recordedSteps] : [];
      this.state.recordingSessionId = session.recordingSessionId || '';
      this.state.recordingSessionEnabled = session.recordingSessionEnabled === true;
      this.state.recordingSessionHealthy = session.recordingSessionHealthy !== false;
      this._insertAfterIndex = session.insertAfterIndex ?? null;
      this._existingStepsSnapshot = Array.isArray(session.existingStepsSnapshot)
        ? [...session.existingStepsSnapshot]
        : null;
      return true;
    } catch (e) {
      console.warn('[Recorder] 恢复录制草稿失败:', e?.message || e);
      return false;
    }
  }

  async restoreSessionFromStorage() {
    return this._restoreSessionDraft(null);
  }

  _clearMergeContext() {
    this._insertAfterIndex = null;
    this._existingStepsSnapshot = null;
  }

  _stepToSaveShape(s) {
    const payload = {
      action_type: s.action_type || 'click',
      target_selector: s.target_selector ?? '',
      target_xpath: s.target_xpath ?? '',
      locator_meta: s.locator_meta ?? null,
      value: s.value ?? '',
      value_masked: s.value_masked === true || s.value_masked === 1 || s.value_masked === '1' ? 1 : 0,
      url: s.url ?? '',
      description: s.description ?? '',
      wait_before: Number(s.wait_before) || 0,
      nl_instruction: s.nl_instruction ?? '',
      screenshot: s.screenshot ?? '',
      screenshot_focus: s.screenshot_focus ?? '',
      screenshot_focus_rect: s.screenshot_focus_rect ?? '',
    };
    if (s.screenshot_full !== undefined) {
      payload.screenshot_full = s.screenshot_full ?? '';
    }
    return payload;
  }

  _ensureClientStepId(step) {
    if (!step || typeof step !== 'object') return '';
    if (!step.client_step_id) {
      step.client_step_id = `step_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
    return step.client_step_id;
  }

  async _createRecordingSession(testCaseId, mode, insertAfterStepIndex) {
    try {
      const res = await this.api.createRecordingSession(testCaseId, {
        mode,
        insert_after_step_index: insertAfterStepIndex,
      });
      const sessionId = res?.data?.session_id;
      if (!sessionId) throw new Error('录制会话创建失败');
      this.state.recordingSessionId = sessionId;
      this.state.recordingSessionEnabled = true;
      this.state.recordingSessionHealthy = true;
      return true;
    } catch (e) {
      console.warn('[Recorder] 创建录制会话失败，将回退旧保存方式:', e?.message || e);
      this.state.recordingSessionId = '';
      this.state.recordingSessionEnabled = false;
      this.state.recordingSessionHealthy = false;
      return false;
    }
  }

  async _syncRecordingSessionStep(index, step) {
    if (!this.state.recordingSessionEnabled || !this.state.recordingSessionId || this.state.recordingSessionHealthy === false) return;
    try {
      const payload = this._stepToSaveShape(step);
      await this.api.saveRecordingSessionStep(this.state.testCaseId, this.state.recordingSessionId, {
        step_index: index,
        client_step_id: this._ensureClientStepId(step),
        step: payload,
      });
    } catch (e) {
      console.warn('[Recorder] 同步录制步骤失败，将回退旧保存方式:', e?.message || e);
      this.state.recordingSessionHealthy = false;
    }
  }

  async _commitRecordingSession(testCaseId, options = {}) {
    if (!this.state.recordingSessionEnabled || !this.state.recordingSessionId || this.state.recordingSessionHealthy === false) return null;
    return this.api.commitRecordingSession(testCaseId, this.state.recordingSessionId, options);
  }

  async _discardRecordingSession(testCaseId = null) {
    if (!this.state.recordingSessionEnabled || !this.state.recordingSessionId) return;
    try {
      await this.api.discardRecordingSession(testCaseId || this.state.testCaseId, this.state.recordingSessionId);
    } catch {
      // 临时会话会由后端过期清理兜底。
    }
  }

  _isInjectableUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
  }

  _normalizeTabId(tabId) {
    const n = Number(tabId);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  _getRecordingTabs() {
    if (!Array.isArray(this.state.recordingTabs)) this.state.recordingTabs = [];
    return this.state.recordingTabs;
  }

  _findRecordingTabById(tabId) {
    const tid = this._normalizeTabId(tabId);
    if (tid == null) return null;
    return this._getRecordingTabs().find((t) => Number(t.tabId) === tid) || null;
  }

  _registerRecordingTab(tab, { openerTabId = null } = {}) {
    const tabId = this._normalizeTabId(tab?.id ?? tab);
    if (tabId == null) return null;
    const tabs = this._getRecordingTabs();
    let existing = tabs.find((t) => Number(t.tabId) === tabId);
    const normalizedOpenerId = this._normalizeTabId(openerTabId ?? tab?.openerTabId);
    const opener = normalizedOpenerId != null ? this._findRecordingTabById(normalizedOpenerId) : null;
    const url = typeof tab?.url === 'string' ? tab.url : (existing?.url || '');
    if (existing) {
      existing.url = url || existing.url || '';
      if (normalizedOpenerId != null) existing.openerTabId = normalizedOpenerId;
      if (opener) existing.openerIndex = opener.index;
      return existing;
    }
    const index = tabs.reduce((max, item) => Math.max(max, Number(item.index) || 0), -1) + 1;
    existing = {
      tabId,
      index,
      openerTabId: normalizedOpenerId,
      openerIndex: opener ? opener.index : null,
      url: url || '',
    };
    tabs.push(existing);
    return existing;
  }

  _buildSwitchContextStep(tabInfo, reason = 'tab_change') {
    const index = Number(tabInfo?.index) || 0;
    const url = tabInfo?.url || '';
    return {
      action_type: 'switch_context',
      target_selector: '',
      target_xpath: '',
      locator_meta: {
        version: 1,
        candidates: [],
        context: {
          tab: {
            index,
            url,
            opener_index: tabInfo?.openerIndex ?? null,
            reason,
          },
        },
      },
      value: String(index),
      url,
      description: `切换到标签页 #${index}${url ? ` · ${url}` : ''}`,
      wait_before: 0,
    };
  }

  _attachTabContext(step, tabInfo) {
    if (!step || !tabInfo) return step;
    if (!step.locator_meta || typeof step.locator_meta !== 'object') {
      step.locator_meta = { version: 1, candidates: [], context: {} };
    }
    if (!step.locator_meta.context || typeof step.locator_meta.context !== 'object') {
      step.locator_meta.context = {};
    }
    step.locator_meta.context.tab = {
      index: Number(tabInfo.index) || 0,
      url: tabInfo.url || step.url || '',
      opener_index: tabInfo.openerIndex ?? null,
    };
    return step;
  }

  _ensureStepTabContext(tabId, step) {
    const tid = this._normalizeTabId(tabId);
    if (tid == null) return null;
    let tabInfo = this._findRecordingTabById(tid);
    if (!tabInfo) tabInfo = this._registerRecordingTab({ id: tid, url: step?.url || '' });
    if (step?.url) tabInfo.url = step.url;
    this._attachTabContext(step, tabInfo);
    const currentIndex = Number(this.state.currentRecordingTabIndex || 0);
    if (Number(tabInfo.index) !== currentIndex) {
      this.state.currentRecordingTabIndex = Number(tabInfo.index) || 0;
      this.state.currentTabId = tid;
      return this._buildSwitchContextStep(tabInfo);
    }
    this.state.currentTabId = tid;
    return null;
  }

  _sameInputTarget(a, b) {
    if (!a || !b) return false;
    const selA = String(a.target_selector || '').trim();
    const selB = String(b.target_selector || '').trim();
    const xpA = String(a.target_xpath || '').trim();
    const xpB = String(b.target_xpath || '').trim();
    if (selA && selB) return selA === selB;
    if (xpA && xpB) return xpA === xpB;
    return false;
  }

  /**
   * @param {object[]} recorded 本次会话录到的步骤
   * @returns {object[]|null} 要 POST 的完整列表；null 表示不调用保存（保持服务端不变）
   */
  _mergeRecordedWithSnapshot(recorded) {
    const snap = this._existingStepsSnapshot;
    const insertAfter = this._insertAfterIndex;
    if (insertAfter == null || !Array.isArray(snap) || snap.length === 0) {
      return recorded;
    }
    if (!recorded.length) return null;
    const idx = Math.max(0, Math.min(Math.floor(insertAfter), snap.length - 1));
    const head = snap.slice(0, idx + 1);
    const tail = snap.slice(idx + 1);
    return [...head, ...recorded, ...tail];
  }

  _broadcastToContentScripts(message) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        const u = tab.url;
        if (
          u.startsWith('chrome://')
          || u.startsWith('chrome-extension://')
          || u.startsWith('edge://')
          || u.startsWith('about:')
        ) {
          continue;
        }
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
  }

  _broadcastRecordingLive() {
    this._broadcastToContentScripts({
      type: 'AT_RECORDING_LIVE',
      testCaseId: this.state.testCaseId,
      stepCount: this.state.recordedSteps.length,
    });
  }

  _broadcastRecordingEnd(payload) {
    this._broadcastToContentScripts({
      type: 'AT_RECORDING_END',
      ...payload,
    });
  }

  _createPendingQuotaSave(testCaseId, toSave, recordedCount) {
    const id = `rq_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.state.pendingQuotaSave = {
      id,
      testCaseId,
      steps: Array.isArray(toSave) ? [...toSave] : [],
      recordedCount: Number(recordedCount || 0),
      recordingSessionId: this.state.recordingSessionId || '',
      recordingSessionEnabled: this.state.recordingSessionEnabled === true,
      recordingSessionHealthy: this.state.recordingSessionHealthy !== false,
      createdAt: Date.now(),
    };
    return id;
  }

  async savePendingQuotaSteps(pendingSaveId, limit) {
    const pending = this.state.pendingQuotaSave;
    if (!pending || pending.id !== pendingSaveId) {
      return { ok: false, error: '待保存的录制步骤已失效，请重新录制' };
    }
    const max = Math.max(0, Math.floor(Number(limit || 0)));
    if (!max) return { ok: false, error: '保留步数无效' };
    const steps = pending.steps.slice(0, max);
    try {
      if (pending.recordingSessionEnabled && pending.recordingSessionId && pending.recordingSessionHealthy) {
        this.state.recordingSessionId = pending.recordingSessionId;
        this.state.recordingSessionEnabled = true;
        this.state.recordingSessionHealthy = true;
        await this.api.commitRecordingSession(pending.testCaseId, pending.recordingSessionId, { limit: max });
      } else {
        await this.api.saveSteps(pending.testCaseId, steps);
      }
      await this._clearSessionDraft();
      this.state.pendingQuotaSave = null;
      this._showNotification('录制完成', `已保留前 ${steps.length} 步并保存`);
      this._broadcastRecordingEnd({
        testCaseId: pending.testCaseId,
        reason: 'completed',
        stepCount: steps.length,
        saved: true,
        trimmed: true,
      });
      this._notifyPopup();
      return { ok: true, testCaseId: pending.testCaseId, stepCount: steps.length };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || '保存失败',
        quotaDetails: err?.quotaDetails || err?.apiData?.data || null,
      };
    }
  }

  async discardPendingQuotaSteps(pendingSaveId) {
    const pending = this.state.pendingQuotaSave;
    if (pending && pending.id === pendingSaveId) {
      if (pending.recordingSessionEnabled && pending.recordingSessionId) {
        try {
          await this.api.discardRecordingSession(pending.testCaseId, pending.recordingSessionId);
        } catch {
          // 后端会由过期清理兜底。
        }
      }
      this.state.pendingQuotaSave = null;
      await this._clearSessionDraft();
      this._notifyPopup();
    }
    return { ok: true };
  }

  _broadcastStopAck() {
    this._broadcastToContentScripts({ type: 'AT_STOP_RECORDING_ACK' });
  }

  _broadcastCancelAck() {
    this._broadcastToContentScripts({ type: 'AT_CANCEL_RECORDING_ACK' });
  }

  _closeRecordingTarget(recordingWindowId, recordingTabId) {
    if (recordingWindowId) {
      chrome.windows.remove(recordingWindowId).catch(() => {});
      return;
    }
    if (recordingTabId) {
      chrome.tabs.remove(recordingTabId).catch(() => {});
    }
  }

  async start(testCaseId, startUrl, sourceTabId, options = {}) {
    if (this.state.mode === 'recording') {
      return { ok: true, tabId: this.state.currentTabId, deduped: true };
    }
    if ((this.state.activePlayCount || 0) > 0) {
      return { ok: false, error: '当前有回放任务进行中，无法开始录制' };
    }

    // 在 await 之前占位，避免 bridge 重复转发时并发打开多个窗口
    this.state.mode = 'recording';
    this.state.testCaseId = testCaseId;
    this.state.recordedSteps = [];
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingTabs = [];
    this.state.currentRecordingTabIndex = 0;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = Date.now();
    this.state.currentTabId = null;
    this.state.pendingQuotaSave = null;
    this.state.recordingSessionId = '';
    this.state.recordingSessionEnabled = false;
    this.state.recordingSessionHealthy = false;

    this._clearMergeContext();
    let resolvedScreenshotMode = 'standard';
    const requestedScreenshotMode = String(options.screenshotMode || '').trim().toLowerCase();
    if (requestedScreenshotMode === 'full_hd') {
      resolvedScreenshotMode = 'full_hd';
    }
    const rawInsert = options.insertAfterStepIndex;
    let sessionMode = 'replace';
    let sessionInsertAfter = null;
    if (rawInsert != null && rawInsert !== '') {
      const n = Number(rawInsert);
      if (Number.isFinite(n)) {
        sessionMode = 'insert';
        sessionInsertAfter = Math.max(0, Math.floor(n));
        try {
          const res = await this.api.getTestCase(testCaseId);
          const modeFromCase = String(res?.data?.screenshot_mode || '').trim().toLowerCase();
          if (modeFromCase === 'full_hd') resolvedScreenshotMode = 'full_hd';
          const list = res?.data?.steps;
          if (!Array.isArray(list) || list.length === 0) {
            this._clearMergeContext();
          } else {
            this._existingStepsSnapshot = list.map((s) => this._stepToSaveShape(s));
            this._insertAfterIndex = Math.max(0, Math.min(Math.floor(n), this._existingStepsSnapshot.length - 1));
            sessionInsertAfter = this._insertAfterIndex;
          }
        } catch (e) {
          this.state.mode = 'idle';
          this.state.testCaseId = null;
          return { ok: false, error: e.message || '拉取已有步骤失败，无法从该位置插入录制' };
        }
      }
    } else if (resolvedScreenshotMode === 'standard') {
      // 未显式传入模式时，回退读取用例配置，兼容弹窗/旧调用链。
      try {
        const res = await this.api.getTestCase(testCaseId);
        const modeFromCase = String(res?.data?.screenshot_mode || '').trim().toLowerCase();
        if (modeFromCase === 'full_hd') resolvedScreenshotMode = 'full_hd';
      } catch {
        // ignore
      }
    }
    await this._createRecordingSession(testCaseId, sessionMode, sessionInsertAfter);

    try {
      let tab;
      const reuseTabId = Number(options.reuseTabId);
      if (Number.isInteger(reuseTabId) && reuseTabId > 0) {
        tab = await chrome.tabs.get(reuseTabId);
        await chrome.tabs.update(reuseTabId, { active: true }).catch(() => {});
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        this.state.recordingOpenedNewTab = options.closeReusedTabAfterStop === true;
        this.state.recordingWindowId = tab.windowId ?? null;
      } else if (startUrl) {
        const win = await chrome.windows.create({ url: startUrl, focused: true, state: 'maximized' });
        tab = win.tabs[0];
        this.state.recordingOpenedNewTab = true;
        this.state.recordingWindowId = win.id ?? null;
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = activeTab;
        this.state.recordingWindowId = null;
      }
      this.state.currentTabId = tab.id;
      this.state.recordingTabs = [];
      this.state.currentRecordingTabIndex = 0;
      this._registerRecordingTab(tab);
      this.state.recordingScreenshotMode = resolvedScreenshotMode;

      await this._waitForTabLoad(tab.id);
      await this._reinjectRecorder(tab.id, resolvedScreenshotMode);
      await this._saveSessionDraft();

      this._broadcastRecordingLive();
      this._notifyPopup();
      return { ok: true, tabId: tab.id };
    } catch (err) {
      await this._discardRecordingSession(testCaseId);
      this.state.mode = 'idle';
      this.state.recordingOpenedNewTab = false;
      this.state.recordingWindowId = null;
      this.state.recordingTabs = [];
      this.state.currentRecordingTabIndex = 0;
      this.state.recordingScreenshotMode = 'standard';
      this.state.recordingPaused = false;
      this.state.recordingStartedAt = 0;
      this._clearMergeContext();
      await this._clearSessionDraft();
      return { ok: false, error: err.message };
    }
  }

  async addStep(step, tabId) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabId);
      if (!restored) return { ok: false, active: false, error: 'not_recording' };
    }
    step.timestamp = Date.now();
    const list = this.state.recordedSteps;
    const switchStep = this._ensureStepTabContext(tabId, step);
    if (switchStep) {
      switchStep.timestamp = Date.now();
      this._ensureClientStepId(switchStep);
      list.push(switchStep);
      await this._syncRecordingSessionStep(list.length - 1, switchStep);
    }
    const last = list[list.length - 1];

    // 输入框连续编辑时，只保留同一目标的最后一条 input 步骤。
    if (
      step.action_type === 'input'
      && last
      && last.action_type === 'input'
      && this._sameInputTarget(step, last)
    ) {
      step.client_step_id = last.client_step_id || this._ensureClientStepId(last);
      list[list.length - 1] = step;
      await this._syncRecordingSessionStep(list.length - 1, step);
    } else {
      this._ensureClientStepId(step);
      list.push(step);
      await this._syncRecordingSessionStep(list.length - 1, step);
    }

    if (this.state.currentTabId) {
      chrome.tabs.sendMessage(this.state.currentTabId, {
        type: 'AT_UPDATE_STEP_COUNT',
        count: list.length,
      }).catch(() => {});
    }
    await this._saveSessionDraft();
    this._broadcastRecordingLive();
    this._notifyPopup();
    return {
      ok: true,
      active: true,
      stepCount: this._getRecordedStepCount(),
      testCaseId: this.state.testCaseId ?? null,
    };
  }

  async heartbeat(tabIdHint = null) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabIdHint);
      if (!restored) return { ok: false, active: false };
    }
    if (Number.isInteger(Number(tabIdHint))) {
      const tabId = Number(tabIdHint);
      this.state.currentTabId = tabId;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) this._registerRecordingTab(tab);
    }
    await this._saveSessionDraft();
    return {
      ok: true,
      active: true,
      stepCount: this._getRecordedStepCount(),
      testCaseId: this.state.testCaseId ?? null,
    };
  }

  async keepAliveTick() {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(null);
      if (!restored) return { ok: false, active: false };
    }

    const tabId = Number.isInteger(Number(this.state.currentTabId))
      ? Number(this.state.currentTabId)
      : null;
    if (tabId == null) return { ok: false, active: false, error: 'missing_tab' };

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return { ok: false, active: false, error: 'tab_unavailable' };
    }
    if (!tab?.id || !tab.url || !(String(tab.url).startsWith('http://') || String(tab.url).startsWith('https://'))) {
      return { ok: false, active: false, error: 'tab_not_injectable' };
    }

    let recorderAlive = false;
    try {
      const ack = await chrome.tabs.sendMessage(tabId, {
        type: 'AT_UPDATE_STEP_COUNT',
        count: this._getRecordedStepCount(),
      });
      recorderAlive = ack?.ok === true;
    } catch {
      recorderAlive = false;
    }

    if (!recorderAlive) {
      try {
        await this._waitForTabLoad(tabId);
        await this._reinjectRecorder(tabId, this.state.recordingScreenshotMode || 'standard');
      } catch (e) {
        console.warn('[Recorder] keepalive 重建录制工具栏失败:', e?.message || e);
      }
    }

    await this._saveSessionDraft();
    this._broadcastRecordingLive();
    this._notifyPopup();
    return {
      ok: true,
      active: true,
      stepCount: this._getRecordedStepCount(),
      testCaseId: this.state.testCaseId ?? null,
      recorderAlive,
    };
  }

  async stop(tabIdHint = null) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabIdHint);
      if (!restored) return { ok: false, error: '未在录制' };
    }

    const recordingTabId = this.state.currentTabId;
    const recordingWindowId = this.state.recordingWindowId;
    const closeTabAfterStop = this.state.recordingOpenedNewTab === true
      || (tabIdHint != null && recordingTabId != null && Number(recordingTabId) !== Number(tabIdHint));

    if (recordingTabId) {
      await chrome.tabs.sendMessage(recordingTabId, { type: 'AT_STOP_RECORDING_ACK' }).catch(() => {});
    }
    this._broadcastStopAck();

    const recorded = [...this.state.recordedSteps];
    const testCaseId = this.state.testCaseId;
    const toSave = this._mergeRecordedWithSnapshot(recorded);
    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordingTabs = [];
    this.state.currentRecordingTabIndex = 0;
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = 0;

    let saved = false;
    if (testCaseId && toSave && toSave.length > 0) {
      try {
        if (this.state.recordingSessionEnabled && this.state.recordingSessionId && this.state.recordingSessionHealthy !== false) {
          await this._commitRecordingSession(testCaseId);
        } else {
          await this._discardRecordingSession(testCaseId);
          await this.api.saveSteps(testCaseId, toSave);
        }
        saved = true;
        await this._clearSessionDraft();
        const msg =
          recorded.length === toSave.length
            ? `已保存 ${recorded.length} 个操作步骤`
            : `已保存 ${toSave.length} 步（含插入的 ${recorded.length} 步新录制）`;
        this._showNotification('录制完成', msg);
      } catch (err) {
        this._showNotification('保存失败', err.message);
        const quotaDetails = err?.quotaDetails || err?.apiData?.data || null;
        const pendingSaveId = quotaDetails?.resource === 'steps_per_case'
          ? this._createPendingQuotaSave(testCaseId, toSave, recorded.length)
          : '';
        this.state.recordedSteps = [];
        this._broadcastRecordingEnd({
          testCaseId,
          reason: 'completed',
          stepCount: recorded.length,
          saved: false,
          error: err?.message || '保存失败',
          quotaDetails,
          pendingSaveId,
        });
        this._notifyPopup();
        if (closeTabAfterStop) {
          this._closeRecordingTarget(recordingWindowId, recordingTabId);
        }
        return { ok: false, error: err.message, quotaDetails, pendingSaveId, testCaseId };
      }
    } else {
      await this._discardRecordingSession(testCaseId);
    }
    await this._clearSessionDraft();

    if (closeTabAfterStop) {
      this._closeRecordingTarget(recordingWindowId, recordingTabId);
    }

    this.state.recordedSteps = [];
    this._broadcastRecordingEnd({
      testCaseId,
      reason: 'completed',
      stepCount: recorded.length,
      saved,
    });
    this._notifyPopup();

    return { ok: true, stepCount: recorded.length };
  }

  /**
   * 取消录制：丢弃本次会话中的步骤，不调用 API，服务端用例步骤保持不变。
   */
  async cancel(tabIdHint = null) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabIdHint);
      if (!restored) return { ok: false, error: '未在录制' };
    }

    const recordingTabId = this.state.currentTabId;
    const recordingWindowId = this.state.recordingWindowId;
    const closeTabAfterCancel = this.state.recordingOpenedNewTab === true
      || (tabIdHint != null && recordingTabId != null && Number(recordingTabId) !== Number(tabIdHint));
    const testCaseId = this.state.testCaseId;
    const discardedCount = this.state.recordedSteps.length;

    if (recordingTabId) {
      await chrome.tabs.sendMessage(recordingTabId, { type: 'AT_CANCEL_RECORDING_ACK' }).catch(() => {});
    }
    this._broadcastCancelAck();
    await this._discardRecordingSession(testCaseId);

    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordedSteps = [];
    this.state.recordingTabs = [];
    this.state.currentRecordingTabIndex = 0;
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = 0;
    await this._clearSessionDraft();

    this._broadcastRecordingEnd({
      testCaseId,
      reason: 'cancelled',
      stepCount: discardedCount,
      saved: false,
    });
    this._notifyPopup();

    if (closeTabAfterCancel) {
      this._closeRecordingTarget(recordingWindowId, recordingTabId);
    }

    return { ok: true, discardedCount };
  }

  /**
   * 录制目标标签页被关闭：尽力保存已录步骤并通知中台页面
   */
  async handleRecordingTabClosed(tabIdHint = null) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabIdHint);
      if (!restored) return;
    }
    const closedTabInfo = tabIdHint != null ? this._findRecordingTabById(tabIdHint) : null;
    if (tabIdHint != null && !closedTabInfo) return;
    if (closedTabInfo && Number(closedTabInfo.index) !== 0) {
      this.state.recordingTabs = this._getRecordingTabs().filter((t) => Number(t.tabId) !== Number(tabIdHint));
      await this._saveSessionDraft();
      this._notifyPopup();
      return;
    }

    const recorded = [...this.state.recordedSteps];
    const testCaseId = this.state.testCaseId;
    const recordingWindowId = this.state.recordingWindowId;
    const toSave = this._mergeRecordedWithSnapshot(recorded);
    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordingTabs = [];
    this.state.currentRecordingTabIndex = 0;
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = 0;

    let saved = false;
    if (testCaseId && toSave && toSave.length > 0) {
      try {
        if (this.state.recordingSessionEnabled && this.state.recordingSessionId && this.state.recordingSessionHealthy !== false) {
          await this._commitRecordingSession(testCaseId);
        } else {
          await this._discardRecordingSession(testCaseId);
          await this.api.saveSteps(testCaseId, toSave);
        }
        saved = true;
        await this._clearSessionDraft();
        this._showNotification('录制标签页已关闭', `已保存 ${toSave.length} 个操作步骤`);
      } catch (err) {
        this._showNotification('保存失败', err.message);
        saved = false;
        const quotaDetails = err?.quotaDetails || err?.apiData?.data || null;
        const pendingSaveId = quotaDetails?.resource === 'steps_per_case'
          ? this._createPendingQuotaSave(testCaseId, toSave, recorded.length)
          : '';
        this.state.lastRecordingSaveError = {
          message: err?.message || '保存失败',
          quotaDetails,
          pendingSaveId,
        };
      }
    } else {
      await this._discardRecordingSession(testCaseId);
    }
    if (!saved && !this.state.lastRecordingSaveError?.pendingSaveId) await this._clearSessionDraft();
    if (recordingWindowId) {
      chrome.windows.remove(recordingWindowId).catch(() => {});
    }

    this.state.recordedSteps = [];
    this._broadcastRecordingEnd({
      testCaseId,
      reason: 'tab_closed',
      stepCount: recorded.length,
      saved,
      error: this.state.lastRecordingSaveError?.message || '',
      quotaDetails: this.state.lastRecordingSaveError?.quotaDetails || null,
      pendingSaveId: this.state.lastRecordingSaveError?.pendingSaveId || '',
    });
    this.state.lastRecordingSaveError = null;
    this._notifyPopup();
  }

  _waitForTabLoad(tabId) {
    return new Promise((resolve) => {
      const check = async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          resolve();
          return;
        }
        if (tab.status === 'complete') {
          resolve();
          return;
        }
        setTimeout(check, 300);
      };
      setTimeout(check, 500);
    });
  }

  async _reinjectRecorder(tabId, screenshotMode = 'standard') {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selector-core.js', 'content/recorder.js'],
    });
    await chrome.tabs.sendMessage(tabId, {
      type: 'AT_START_RECORDING',
      screenshotMode,
      paused: this.state.recordingPaused === true,
    }).catch(() => {});
    await chrome.tabs.sendMessage(tabId, {
      type: 'AT_UPDATE_STEP_COUNT',
      count: this._getRecordedStepCount(),
    }).catch(() => {});
  }

  async handleRecordingTabLoadComplete(tabId, tabUrl = '') {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabId);
      if (!restored) return;
    }
    if (!tabUrl || !this._isInjectableUrl(String(tabUrl))) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const existing = this._findRecordingTabById(tabId);
    const opener = tab.openerTabId != null ? this._findRecordingTabById(tab.openerTabId) : null;
    if (!existing && !opener) return;
    const isInitialRecordingTab = existing && Number(existing.index) === 0;
    if (
      isInitialRecordingTab
      && (Date.now() - Number(this.state.recordingStartedAt || 0)) < 4000
      && this.state.recordedSteps.length === 0
    ) {
      return;
    }
    const tabInfo = this._registerRecordingTab(tab);
    if (!tabInfo) return;
    try {
      await this._waitForTabLoad(tabId);
      await this._reinjectRecorder(tabId, this.state.recordingScreenshotMode || 'standard');
      await this._saveSessionDraft();
      this._showNotification(
        tabInfo.index === 0 ? '录制已续接' : `已接管新标签页 #${tabInfo.index}`,
        `当前已捕获 ${this.state.recordedSteps.length} 步`,
      );
    } catch (e) {
      console.warn('[Recorder] 页面跳转后恢复录制失败:', e?.message || e);
    }
  }

  async handleRecordingTabCreated(tab) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(null);
      if (!restored) return;
    }
    const opener = tab?.openerTabId != null ? this._findRecordingTabById(tab.openerTabId) : null;
    if (!opener) return;
    const tabInfo = this._registerRecordingTab(tab);
    if (!tabInfo) return;
    await this._saveSessionDraft();
  }

  _notifyPopup() {
    chrome.runtime
      .sendMessage({ type: 'AT_STATE_CHANGED', state: { ...this.state, recordedSteps: this.state.recordedSteps.length } })
      .catch(() => {});
  }

  _showNotification(title, message) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message,
    });
  }
}
