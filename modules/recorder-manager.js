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
      saveFailed: this.state.recordingSaveFailed === true,
      saveError: this.state.recordingSaveError || '',
      testCaseId: this.state.testCaseId ?? null,
      apiBase: this.state.apiBase ?? '',
      authToken: this.state.authToken ?? '',
      currentTabId: this.state.currentTabId ?? null,
      recordingOpenedNewTab: this.state.recordingOpenedNewTab === true,
      recordingWindowId: this.state.recordingWindowId ?? null,
      recordingScreenshotMode: this.state.recordingScreenshotMode || 'standard',
      recordingImport: this.state.recordingImport || null,
      recordingEndUrl: this.state.recordingEndUrl || '',
      recordingPaused: this.state.recordingPaused === true,
      recordedSteps: Array.isArray(this.state.recordedSteps) ? [...this.state.recordedSteps] : [],
      insertAfterIndex: this._insertAfterIndex,
      existingStepsSnapshot: Array.isArray(this._existingStepsSnapshot) ? [...this._existingStepsSnapshot] : null,
      savedAt: Date.now(),
    };
  }

  _getRecordedStepCount() {
    return Array.isArray(this.state.recordedSteps) ? this.state.recordedSteps.length : 0;
  }

  _recordingImportIdentity(recordingImport) {
    if (!recordingImport || typeof recordingImport !== 'object') return '';
    return JSON.stringify({
      mode: recordingImport.mode || '',
      targetSceneDbId: recordingImport.targetSceneDbId ?? '',
      expectedDefinitionVersion: recordingImport.expectedDefinitionVersion ?? '',
      targetCaseId: recordingImport.targetCaseId ?? '',
      targetStepId: recordingImport.targetStepId ?? '',
      appendPosition: recordingImport.appendPosition ?? '',
      appendAfterCaseId: recordingImport.appendAfterCaseId ?? '',
      stepAppendPosition: recordingImport.stepAppendPosition ?? '',
      appendAfterStepId: recordingImport.appendAfterStepId ?? '',
      sceneId: recordingImport.scene?.sceneId || '',
    });
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
    return !!(session && typeof session === 'object' && (session.active === true || session.saveFailed === true));
  }

  _pickNewestSessionDraft(...sessions) {
    const usable = sessions.filter((s) => this._isSessionDraftUsable(s));
    if (!usable.length) return null;
    usable.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return usable[0];
  }

  async _readNewestSessionDraft() {
    const [sessionStore, localStore] = await Promise.all([
      this._readFromArea(chrome.storage.session || null).catch(() => null),
      this._readFromArea(chrome.storage.local || null).catch(() => null),
    ]);
    return this._pickNewestSessionDraft(sessionStore, localStore);
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

  async _markSessionDraftSaveFailed(error) {
    try {
      const draft = await this._readNewestSessionDraft();
      if (!draft) return;
      const failedDraft = {
        ...draft,
        active: false,
        saveFailed: true,
        saveError: String(error || '录制导入失败'),
        savedAt: Date.now(),
      };
      await Promise.all(this._storageAreas().map((area) => this._saveToArea(area, failedDraft)));
    } catch (e) {
      console.warn('[Recorder] 标记录制失败草稿失败:', e?.message || e);
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
      const session = await this._readNewestSessionDraft();
      if (!session) return false;
      // 失败草稿只供 admin-ui 重试，不恢复成正在录制，避免误触发停止/心跳流程。
      if (session.saveFailed === true) return false;
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
      this.state.recordingScreenshotMode = String(session.recordingScreenshotMode || 'standard').trim().toLowerCase() === 'full_hd'
        ? 'full_hd'
        : 'standard';
      this.state.recordingImport = session.recordingImport || null;
      this.state.recordingEndUrl = session.recordingEndUrl || '';
      this.state.recordingSaveFailed = false;
      this.state.recordingSaveError = '';
      this.state.recordingPaused = session.recordingPaused === true;
      this.state.recordingStartedAt = Number(session.savedAt || Date.now()) || Date.now();
      this.state.recordedSteps = Array.isArray(session.recordedSteps) ? [...session.recordedSteps] : [];
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

  async getSessionDraftSummary() {
    const session = await this._readNewestSessionDraft();
    if (!session || session.saveFailed !== true) {
      return { ok: true, available: false };
    }
    const recordingImport = session.recordingImport || {};
    return {
      ok: true,
      available: true,
      testCaseId: session.testCaseId ?? null,
      stepCount: Array.isArray(session.recordedSteps) ? session.recordedSteps.length : 0,
      mode: recordingImport.mode || 'legacySaveSteps',
      targetSceneDbId: recordingImport.targetSceneDbId ?? null,
      targetCaseId: recordingImport.targetCaseId ?? null,
      savedAt: session.savedAt ?? null,
      error: session.saveError || '',
    };
  }

  _clearMergeContext() {
    this._insertAfterIndex = null;
    this._existingStepsSnapshot = null;
  }

  _stepToSaveShape(s) {
    return {
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
  _mergeRecordedWithSnapshot(recorded, snapshot = this._existingStepsSnapshot, insertAfter = this._insertAfterIndex) {
    const snap = snapshot;
    if (insertAfter == null || !Array.isArray(snap) || snap.length === 0) {
      return recorded;
    }
    if (!recorded.length) return null;
    const idx = Math.max(0, Math.min(Math.floor(insertAfter), snap.length - 1));
    const head = snap.slice(0, idx + 1);
    const tail = snap.slice(idx + 1);
    return [...head, ...recorded, ...tail];
  }

  _withSequentialStepIds(steps) {
    return (Array.isArray(steps) ? steps : []).map((step, index) => ({
      ...step,
      id: index + 1,
    }));
  }

  _getRecordingImportOptions(recordingImport = this.state.recordingImport) {
    const options = recordingImport;
    if (!options || typeof options !== 'object' || options.enabled !== true) return null;
    if (!options.scene || typeof options.scene !== 'object') return null;
    return options;
  }

  _buildRecordingImportPayload(testCaseId, steps, options) {
    const scene = options.scene;
    const normalizedSteps = this._withSequentialStepIds(steps);
    return {
      mode: options.mode || 'createScene',
      targetSceneDbId: options.targetSceneDbId,
      // 替换和追加必须透传启动录制时读取的定义版本，避免绕过并发修改校验。
      expectedDefinitionVersion: options.expectedDefinitionVersion,
      targetCaseId: options.targetCaseId,
      targetStepId: options.targetStepId,
      appendPosition: options.appendPosition,
      appendAfterCaseId: options.appendAfterCaseId,
      stepAppendPosition: options.stepAppendPosition,
      appendAfterStepId: options.appendAfterStepId,
      scene,
      recordedCase: {
        id: testCaseId,
        name: options.caseName || scene.name || `录制用例 ${testCaseId || ''}`.trim(),
        start_url: options.startUrl || '',
        description: options.caseDescription || 'Chrome 扩展录制生成',
        screenshot_mode: options.screenshotMode || this.state.recordingScreenshotMode || 'standard',
        window_size_mode: options.windowSizeMode || 'maximized',
        viewport_width: options.viewportWidth,
        viewport_height: options.viewportHeight,
        end_url: options.recordingEndUrl || '',
        steps: normalizedSteps,
      },
      persistScreenshots: options.persistScreenshots === true,
      keepRawScreenshotInStep: options.keepRawScreenshotInStep === true,
    };
  }

  async _saveRecordedSteps(testCaseId, steps, recordingImport = this.state.recordingImport) {
    const importOptions = this._getRecordingImportOptions(recordingImport);
    if (importOptions) {
      return this.api.importRecording(this._buildRecordingImportPayload(testCaseId, steps, importOptions));
    }
    return this.api.saveSteps(testCaseId, this._withSequentialStepIds(steps));
  }

  /**
   * 使用保存失败时保留的 session draft 重试导入；失败时不清理草稿，便于再次点击重试。
   */
  async retrySaveDraft() {
    const session = await this._readNewestSessionDraft();
    if (!session) {
      return { ok: false, saved: false, retryable: false, error: '没有可重试的录制草稿' };
    }

    const recorded = Array.isArray(session.recordedSteps) ? [...session.recordedSteps] : [];
    const testCaseId = session.testCaseId;
    const toSave = this._mergeRecordedWithSnapshot(
      recorded,
      Array.isArray(session.existingStepsSnapshot) ? session.existingStepsSnapshot : null,
      session.insertAfterIndex,
    );
    if (!testCaseId || !toSave || toSave.length === 0) {
      return { ok: false, saved: false, retryable: false, error: '录制草稿没有可上传的步骤' };
    }

    const recordingImport = session.recordingImport || null;
    const recordingEndUrl = session.recordingEndUrl || await this._getRecordingTabUrl(session.currentTabId);
    const saveOptions = recordingImport
      ? { ...recordingImport, recordingEndUrl }
      : recordingImport;
    const saveContext = {
      mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
      apiBase: this.api.base,
      appendPosition: recordingImport?.appendPosition,
      appendAfterCaseId: recordingImport?.appendAfterCaseId,
      targetStepId: recordingImport?.targetStepId,
      stepAppendPosition: recordingImport?.stepAppendPosition,
      appendAfterStepId: recordingImport?.appendAfterStepId,
      recordingEndUrl,
      replaceOldStepCount: recordingImport?.replaceOldStepCount,
      stepCount: toSave.length,
      recordedStepCount: recorded.length,
    };

    try {
      await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
      await this._clearSessionDraft();
      this.state.recordingSaveFailed = false;
      this.state.recordingSaveError = '';
      this._showNotification('录制重试成功', `已保存 ${toSave.length} 个操作步骤`);
      this._broadcastRecordingEnd({
        testCaseId,
        reason: 'retry_completed',
        stepCount: recorded.length,
        saved: true,
        retryable: false,
        saveContext,
      });
      this._notifyPopup();
      return { ok: true, saved: true, retryable: false, stepCount: recorded.length, saveContext };
    } catch (err) {
      const error = err?.message || String(err);
      await this._markSessionDraftSaveFailed(error);
      this._showNotification('录制重试失败', error);
      this._broadcastRecordingEnd({
        testCaseId,
        reason: 'retry_failed',
        stepCount: recorded.length,
        saved: false,
        retryable: true,
        error,
        saveContext,
      });
      this._notifyPopup();
      return { ok: false, saved: false, retryable: true, error, saveContext };
    }
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

  _buildRecordingWindowCreateData(url, preference) {
    const data = { url, focused: true };
    if (preference?.mode === 'custom' || preference?.mode === 'current') {
      data.state = 'normal';
      data.width = preference.width;
      data.height = preference.height;
      if (preference.left != null) data.left = preference.left;
      if (preference.top != null) data.top = preference.top;
      return data;
    }
    data.state = 'maximized';
    return data;
  }

  async _getRecordingTabUrl(tabId) {
    if (!tabId) return '';
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = String(tab?.url || '').trim();
      return /^https?:\/\//i.test(url) ? url : '';
    } catch {
      return '';
    }
  }

  async start(testCaseId, startUrl, sourceTabId, options = {}) {
    if (this.state.mode === 'recording') {
      const activeImportKey = this._recordingImportIdentity(this.state.recordingImport);
      const nextImportKey = this._recordingImportIdentity(options.recordingImport);
      const sameRecordingIntent = String(this.state.testCaseId ?? '') === String(testCaseId ?? '')
        && activeImportKey === nextImportKey;
      if (!sameRecordingIntent) {
        return {
          ok: false,
          active: true,
          tabId: this.state.currentTabId,
          error: '已有录制进行中，请先停止或取消当前录制后再开始新的导入模式录制',
          activeMode: this.state.recordingImport?.mode || 'legacySaveSteps',
          requestedMode: options.recordingImport?.mode || 'legacySaveSteps',
        };
      }
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
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingImport = options.recordingImport || null;
    this.state.recordingEndUrl = '';
    this.state.recordingSaveFailed = false;
    this.state.recordingSaveError = '';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = Date.now();
    this.state.currentTabId = null;

    this._clearMergeContext();
    let resolvedScreenshotMode = 'standard';
    const requestedScreenshotMode = String(options.screenshotMode || '').trim().toLowerCase();
    if (requestedScreenshotMode === 'full_hd') {
      resolvedScreenshotMode = 'full_hd';
    }
    const rawInsert = options.insertAfterStepIndex;
    if (rawInsert != null && rawInsert !== '') {
      const n = Number(rawInsert);
      if (Number.isFinite(n)) {
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

    try {
      let tab;
      if (startUrl) {
        const win = await chrome.windows.create(this._buildRecordingWindowCreateData(startUrl, options.windowPreference));
        tab = win.tabs[0];
        this.state.recordingOpenedNewTab = true;
        this.state.recordingWindowId = win.id ?? null;
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = activeTab;
        this.state.recordingWindowId = null;
      }
      this.state.currentTabId = tab.id;
      this.state.recordingScreenshotMode = resolvedScreenshotMode;

      await this._waitForTabLoad(tab.id);
      await this._reinjectRecorder(tab.id, resolvedScreenshotMode);
      await this._saveSessionDraft();

      this._broadcastRecordingLive();
      this._notifyPopup();
      return { ok: true, tabId: tab.id };
    } catch (err) {
      this.state.mode = 'idle';
      this.state.recordingOpenedNewTab = false;
      this.state.recordingWindowId = null;
      this.state.recordingScreenshotMode = 'standard';
      this.state.recordingImport = null;
      this.state.recordingEndUrl = '';
      this.state.recordingSaveFailed = false;
      this.state.recordingSaveError = '';
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
    const last = list[list.length - 1];

    // 输入框连续编辑时，只保留同一目标的最后一条 input 步骤。
    if (
      step.action_type === 'input'
      && last
      && last.action_type === 'input'
      && this._sameInputTarget(step, last)
    ) {
      list[list.length - 1] = step;
    } else {
      list.push(step);
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
      this.state.currentTabId = Number(tabIdHint);
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
    const recordingImport = this.state.recordingImport;
    const recordingEndUrl = await this._getRecordingTabUrl(recordingTabId);
    const saveOptions = recordingImport
      ? { ...recordingImport, recordingEndUrl }
      : recordingImport;
    const toSave = this._mergeRecordedWithSnapshot(recorded);
    const saveContext = {
      mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
      apiBase: this.api.base,
      appendPosition: recordingImport?.appendPosition,
      appendAfterCaseId: recordingImport?.appendAfterCaseId,
      targetStepId: recordingImport?.targetStepId,
      stepAppendPosition: recordingImport?.stepAppendPosition,
      appendAfterStepId: recordingImport?.appendAfterStepId,
      recordingEndUrl,
      replaceOldStepCount: recordingImport?.replaceOldStepCount,
      stepCount: Array.isArray(toSave) ? toSave.length : 0,
      recordedStepCount: recorded.length,
    };
    // 停止录制前把最终地址写入草稿，上传失败后重试仍能复用完整导入上下文。
    this.state.recordingEndUrl = recordingEndUrl;
    await this._saveSessionDraft();
    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingImport = null;
    this.state.recordingEndUrl = '';
    this.state.recordingSaveFailed = false;
    this.state.recordingSaveError = '';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = 0;

    let saved = false;
    if (testCaseId && toSave && toSave.length > 0) {
      try {
        await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
        saved = true;
        await this._clearSessionDraft();
        const msg =
          recorded.length === toSave.length
            ? `已保存 ${recorded.length} 个操作步骤`
            : `已保存 ${toSave.length} 步（含插入的 ${recorded.length} 步新录制）`;
        this._showNotification('录制完成', msg);
      } catch (err) {
        const error = err?.message || String(err);
        await this._markSessionDraftSaveFailed(error);
        this._showNotification('保存失败', error);
        this.state.recordedSteps = [];
        this._broadcastRecordingEnd({
          testCaseId,
          reason: 'completed',
          stepCount: recorded.length,
          saved: false,
          retryable: true,
          error,
          saveContext,
        });
        this._notifyPopup();
        if (closeTabAfterStop) {
          this._closeRecordingTarget(recordingWindowId, recordingTabId);
        }
        return { ok: false, error: err.message };
      }
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
      saveContext,
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

    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordedSteps = [];
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingImport = null;
    this.state.recordingEndUrl = '';
    this.state.recordingSaveFailed = false;
    this.state.recordingSaveError = '';
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
    if (tabIdHint != null && Number(this.state.currentTabId) !== Number(tabIdHint)) return;

    const recorded = [...this.state.recordedSteps];
    const testCaseId = this.state.testCaseId;
    const recordingImport = this.state.recordingImport;
    const recordingWindowId = this.state.recordingWindowId;
    const recordingEndUrl = await this._getRecordingTabUrl(this.state.currentTabId);
    const saveOptions = recordingImport
      ? { ...recordingImport, recordingEndUrl }
      : recordingImport;
    const toSave = this._mergeRecordedWithSnapshot(recorded);
    const saveContext = {
      mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
      apiBase: this.api.base,
      appendPosition: recordingImport?.appendPosition,
      appendAfterCaseId: recordingImport?.appendAfterCaseId,
      targetStepId: recordingImport?.targetStepId,
      stepAppendPosition: recordingImport?.stepAppendPosition,
      appendAfterStepId: recordingImport?.appendAfterStepId,
      recordingEndUrl,
      replaceOldStepCount: recordingImport?.replaceOldStepCount,
      stepCount: Array.isArray(toSave) ? toSave.length : 0,
      recordedStepCount: recorded.length,
    };
    // 标签页关闭也要先保存最终地址，便于导入失败后从草稿重试。
    this.state.recordingEndUrl = recordingEndUrl;
    await this._saveSessionDraft();
    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordingOpenedNewTab = false;
    this.state.recordingWindowId = null;
    this.state.recordingScreenshotMode = 'standard';
    this.state.recordingImport = null;
    this.state.recordingEndUrl = '';
    this.state.recordingSaveFailed = false;
    this.state.recordingSaveError = '';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = 0;

    let saved = false;
    let saveError = '';
    if (testCaseId && toSave && toSave.length > 0) {
      try {
        await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
        saved = true;
        await this._clearSessionDraft();
        this._showNotification('录制标签页已关闭', `已保存 ${toSave.length} 个操作步骤`);
      } catch (err) {
        saveError = err?.message || String(err);
        this._showNotification('保存失败', saveError);
      }
    } else {
      saveError = '录制标签页已关闭，但没有可保存的步骤。';
    }
    if (!saved && saveError && recorded.length > 0) {
      await this._markSessionDraftSaveFailed(saveError);
    } else if (!saved) {
      await this._clearSessionDraft();
    }
    if (recordingWindowId) {
      chrome.windows.remove(recordingWindowId).catch(() => {});
    }

    this.state.recordedSteps = [];
    this._broadcastRecordingEnd({
      testCaseId,
      reason: 'tab_closed',
      stepCount: recorded.length,
      saved,
      retryable: !saved && Boolean(saveError) && recorded.length > 0,
      error: saved ? undefined : saveError,
      saveContext,
    });
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
    if (this.state.mode !== 'recording' || this.state.currentTabId !== tabId) {
      const restored = await this._restoreSessionDraft(tabId);
      if (!restored || this.state.currentTabId !== tabId) return;
    }
    if ((Date.now() - Number(this.state.recordingStartedAt || 0)) < 4000 && this.state.recordedSteps.length === 0) return;
    if (!tabUrl || !(String(tabUrl).startsWith('http://') || String(tabUrl).startsWith('https://'))) return;
    try {
      await this._waitForTabLoad(tabId);
      await this._reinjectRecorder(tabId, this.state.recordingScreenshotMode || 'standard');
      await this._saveSessionDraft();
      this._showNotification('录制已续接', `页面跳转后已恢复录制工具栏，当前已捕获 ${this.state.recordedSteps.length} 步`);
    } catch (e) {
      console.warn('[Recorder] 页面跳转后恢复录制失败:', e?.message || e);
    }
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
