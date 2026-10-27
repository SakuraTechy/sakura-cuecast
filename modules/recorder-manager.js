/**
 * 录制管理器
 */
import { inspectIncognitoAvailability } from './incognito.js';

const RECORDER_SESSION_KEY = '__cc_recording_session_v1';
const RECORD_TAB_LOAD_TIMEOUT_MS = 90000;
const RECORD_RECOVERY_TAB_LOAD_TIMEOUT_MS = 300000;

function normalizeLocale(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function trByLocale(locale, zh, en) {
  return normalizeLocale(locale) === 'en' ? (en || zh) : zh;
}

export class RecorderManager {
  constructor(state, api) {
    this.state = state;
    this.api = api;
    /** @type {number|null} 与某步之间插入录制时：在该步索引之后拼接（null 表示整表覆盖为本次录制） */
    this._insertAfterIndex = null;
    /** @type {number|null} 插入锚点的服务端步骤 ID，提交时优先于序号定位。 */
    this._insertAfterStepId = null;
    /** @type {object[]|null} 开始录制时拉取的已有步骤快照（不含 DB id，仅保存用字段） */
    this._existingStepsSnapshot = null;
    // 会话步骤必须按录制顺序写入；停止录制前会等待此队列清空。
    this._recordingSessionSyncTail = Promise.resolve();
    // Agent 可显式声明普通文本框中的下一次输入为敏感值。该标记只留在内存，
    // 并在步骤进入本地草稿或服务端同步队列前消费。
    this._pendingSensitiveInput = null;
  }

  _storageAreas() {
    const areas = [];
    if (chrome.storage.session) areas.push(chrome.storage.session);
    return areas;
  }

  _tr(zh, en) {
    return trByLocale(this.state.recordingLocale, zh, en);
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
      recordingTabs: Array.isArray(this.state.recordingTabs) ? [...this.state.recordingTabs] : [],
      currentRecordingTabIndex: Number.isInteger(Number(this.state.currentRecordingTabIndex))
        ? Number(this.state.currentRecordingTabIndex)
        : 0,
      recordingScreenshotMode: this.state.recordingScreenshotMode || 'standard',
      recordingImport: this.state.recordingImport || null,
      recordingEndUrl: this.state.recordingEndUrl || '',
      recordingPaused: this.state.recordingPaused === true,
      recordingLocale: normalizeLocale(this.state.recordingLocale),
      recordedSteps: Array.isArray(this.state.recordedSteps) ? [...this.state.recordedSteps] : [],
      insertAfterIndex: this._insertAfterIndex,
      insertAfterStepId: this._insertAfterStepId,
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
      this.state.recordingImport = session.recordingImport || null;
      this.state.recordingEndUrl = session.recordingEndUrl || '';
      this.state.recordingSaveFailed = false;
      this.state.recordingSaveError = '';
      this.state.recordingPaused = session.recordingPaused === true;
      this.state.recordingLocale = normalizeLocale(session.recordingLocale || chrome.i18n.getUILanguage());
      this.state.recordingStartedAt = Number(session.savedAt || Date.now()) || Date.now();
      this.state.recordedSteps = Array.isArray(session.recordedSteps) ? [...session.recordedSteps] : [];
      this.state.recordingSessionId = session.recordingSessionId || '';
      this.state.recordingSessionEnabled = session.recordingSessionEnabled === true;
      this.state.recordingSessionHealthy = session.recordingSessionHealthy !== false;
      this._insertAfterIndex = session.insertAfterIndex ?? null;
      this._insertAfterStepId = Number.isInteger(Number(session.insertAfterStepId))
        ? Number(session.insertAfterStepId)
        : null;
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
    await chrome.storage.local?.remove(RECORDER_SESSION_KEY).catch(() => {});
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

  async getActiveIncognitoWindowIds() {
    const ids = new Set();
    if (this.state.mode === 'recording' && this.state.recordingWindowId != null) {
      ids.add(Number(this.state.recordingWindowId));
    }
    const sessionStore = await this._readFromArea(chrome.storage.session || null).catch(() => null);
    const session = this._pickNewestSessionDraft(sessionStore);
    if (session?.active === true && session.recordingWindowId != null) {
      ids.add(Number(session.recordingWindowId));
    }
    const liveIds = [];
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0) continue;
      const win = await chrome.windows.get(id).catch(() => null);
      if (win?.incognito === true) liveIds.push(id);
    }
    return liveIds;
  }

  _clearMergeContext() {
    this._insertAfterIndex = null;
    this._insertAfterStepId = null;
    this._existingStepsSnapshot = null;
  }

  _stepToSaveShape(s) {
    const payload = {
      id: s.id ?? null,
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

  async _createRecordingSession(testCaseId, mode, insertAfterStepIndex, insertAfterStepId = null) {
    try {
      const res = await this.api.createRecordingSession(testCaseId, {
        mode,
        insert_after_step_index: insertAfterStepIndex,
        insert_after_step_id: insertAfterStepId,
      });
      const sessionId = res?.data?.session_id;
      if (!sessionId) throw new Error(this._tr('录制会话创建失败', 'Failed to create recording session.'));
      this.state.recordingSessionId = sessionId;
      this.state.recordingSessionEnabled = true;
      this.state.recordingSessionHealthy = true;
      this._recordingSessionSyncTail = Promise.resolve();
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
    const testCaseId = this.state.testCaseId;
    const sessionId = this.state.recordingSessionId;
    const payload = this._stepToSaveShape(step);
    const clientStepId = this._ensureClientStepId(step);
    const sync = async () => {
      try {
        await this.api.saveRecordingSessionStep(testCaseId, sessionId, {
          step_index: index,
          client_step_id: clientStepId,
          step: payload,
        });
      } catch (e) {
        console.warn('[Recorder] 同步录制步骤失败，将回退旧保存方式:', e?.message || e);
        if (this.state.recordingSessionId === sessionId) {
          this.state.recordingSessionHealthy = false;
        }
      }
    };
    const task = this._recordingSessionSyncTail.then(sync, sync);
    // 失败由 sync 记录并回退，队列本身始终继续，避免某一步失败阻塞后续步骤。
    this._recordingSessionSyncTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async _flushRecordingSessionSteps() {
    // 等到队列稳定，覆盖等待期间刚刚入队的步骤。
    let tail;
    do {
      tail = this._recordingSessionSyncTail;
      await tail;
    } while (tail !== this._recordingSessionSyncTail);
  }

  _savedStepCount(response, fallback) {
    const count = Number(response?.data?.step_count);
    return Number.isInteger(count) && count >= 0 ? count : fallback;
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
      description: this._tr(
        `切换到标签页 #${index}${url ? ` · ${url}` : ''}`,
        `Switch to tab #${index}${url ? ` · ${url}` : ''}`,
      ),
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

  armNextInputSensitive(tabId, target = {}, value = '') {
    this._pendingSensitiveInput = {
      tabId: this._normalizeTabId(tabId),
      targetSelector: String(target?.selector || '').trim(),
      targetXpath: String(target?.xpath || '').trim(),
      value: String(value ?? ''),
      expiresAt: Date.now() + 30000,
    };
  }

  clearNextInputSensitive() {
    this._pendingSensitiveInput = null;
  }

  _redactSensitiveMetadata(value, secret) {
    if (!secret || value == null) return value;
    if (typeof value === 'string') return value.split(secret).join('');
    if (Array.isArray(value)) return value.map((item) => this._redactSensitiveMetadata(item, secret));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this._redactSensitiveMetadata(item, secret)]));
    }
    return value;
  }

  _applyPendingSensitiveInput(step, tabId) {
    const pending = this._pendingSensitiveInput;
    if (!pending) return;
    if (pending.expiresAt <= Date.now()) {
      this._pendingSensitiveInput = null;
      return;
    }
    if (step?.action_type !== 'input') return;
    const stepTabId = this._normalizeTabId(tabId);
    if (pending.tabId != null && stepTabId != null && pending.tabId !== stepTabId) return;
    const selector = String(step.target_selector || '').trim();
    const xpath = String(step.target_xpath || '').trim();
    const selectorMatches = pending.targetSelector && selector && pending.targetSelector === selector;
    const xpathMatches = pending.targetXpath && xpath && pending.targetXpath === xpath;
    const valueMatches = String(step.value ?? '') === pending.value;
    if (!selectorMatches && !xpathMatches && !valueMatches) return;
    step.value_masked = 1;
    step.description = this._tr('输入敏感值', 'Enter sensitive value');
    step.locator_meta = this._redactSensitiveMetadata(step.locator_meta, pending.value);
    // 普通文本框不会像 password 控件一样在画面上自动遮罩，因此敏感输入步骤不保留截图。
    step.screenshot = '';
    step.screenshot_full = '';
    step.screenshot_focus = '';
    step.screenshot_focus_rect = '';
    this._pendingSensitiveInput = null;
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
    return {
      mode: options.mode || 'createScene',
      targetSceneDbId: options.targetSceneDbId,
      // 替换和追加必须透传录制开始时的定义版本，避免覆盖并发修改。
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
        steps: this._withSequentialStepIds(steps),
      },
      persistScreenshots: options.persistScreenshots === true,
      keepRawScreenshotInStep: options.keepRawScreenshotInStep === true,
    };
  }

  async _saveRecordedSteps(testCaseId, steps, recordingImport = this.state.recordingImport) {
    const importOptions = this._getRecordingImportOptions(recordingImport);
    if (importOptions) {
      // Admin 是录制主数据源，原始 locator_meta 和 Playwright step 由后端转换并完整保存。
      return this.api.importRecording(this._buildRecordingImportPayload(testCaseId, steps, importOptions));
    }
    return this.api.saveSteps(testCaseId, this._withSequentialStepIds(steps));
  }

  /**
   * 使用失败草稿重试原保存目标；Admin 导入失败时不能降级写入官方 testcases 接口。
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
    const saveOptions = recordingImport ? { ...recordingImport, recordingEndUrl } : null;
    const saveContext = this._buildSaveContext(recordingImport, recordingEndUrl, toSave, recorded);
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

  _buildSaveContext(recordingImport, recordingEndUrl, steps, recorded) {
    return {
      mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
      apiBase: this.api.base,
      appendPosition: recordingImport?.appendPosition,
      appendAfterCaseId: recordingImport?.appendAfterCaseId,
      targetStepId: recordingImport?.targetStepId,
      stepAppendPosition: recordingImport?.stepAppendPosition,
      appendAfterStepId: recordingImport?.appendAfterStepId,
      recordingEndUrl,
      replaceOldStepCount: recordingImport?.replaceOldStepCount,
      stepCount: Array.isArray(steps) ? steps.length : 0,
      recordedStepCount: Array.isArray(recorded) ? recorded.length : 0,
    };
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
      eventId: payload?.eventId || `recording_end_${Date.now()}_${Math.random().toString(16).slice(2)}`,
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
      return { ok: false, error: this._tr('待保存的录制步骤已失效，请重新录制', 'Pending recording steps have expired. Record the case again.') };
    }
    const max = Math.max(0, Math.floor(Number(limit || 0)));
    if (!max) return { ok: false, error: this._tr('保留步数无效', 'The number of steps to keep is invalid.') };
    const steps = pending.steps.slice(0, max);
    try {
      await this._flushRecordingSessionSteps();
      // 配额兜底必须保存本地截断快照，不能再次从临时会话读取步骤。
      // 否则异步会话写入与页面录制结果不一致时会丢失步骤。
      const response = await this.api.saveSteps(pending.testCaseId, steps);
      if (pending.recordingSessionEnabled && pending.recordingSessionId && pending.recordingSessionHealthy) {
        await this.api.discardRecordingSession(pending.testCaseId, pending.recordingSessionId).catch(() => {});
      }
      const savedStepCount = this._savedStepCount(response, steps.length);
      await this._clearSessionDraft();
      this.state.pendingQuotaSave = null;
      this._showNotification(
        this._tr('录制完成', 'Recording completed'),
        this._tr(`已保留前 ${savedStepCount} 步并保存`, `Kept and saved the first ${savedStepCount} steps.`),
      );
      this._broadcastRecordingEnd({
        testCaseId: pending.testCaseId,
        reason: 'completed',
        stepCount: savedStepCount,
        saved: true,
        trimmed: true,
      });
      this._notifyPopup();
      return { ok: true, testCaseId: pending.testCaseId, stepCount: savedStepCount };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || this._tr('保存失败', 'Save failed'),
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
      return { ok: false, error: this._tr('当前有回放任务进行中，无法开始录制', 'Playback is running. Recording cannot start.') };
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
    this.state.recordingImport = options.recordingImport || null;
    this.state.recordingEndUrl = '';
    this.state.recordingSaveFailed = false;
    this.state.recordingSaveError = '';
    this.state.recordingPaused = false;
    this.state.recordingLocale = normalizeLocale(options.locale || chrome.i18n.getUILanguage());
    this.state.recordingStartedAt = Date.now();
    this.state.currentTabId = null;
    this.state.pendingQuotaSave = null;
    this.state.recordingSessionId = '';
    this.state.recordingSessionEnabled = false;
    this.state.recordingSessionHealthy = false;

    this._clearMergeContext();
    let resolvedScreenshotMode = 'standard';
    let runInIncognito = options.runInIncognito === true;
    let testCaseConfig = null;
    const rawInsert = options.insertAfterStepIndex;
    const insertRequiresSnapshot = rawInsert != null
      && rawInsert !== ''
      && Number.isFinite(Number(rawInsert));
    try {
      const res = await this.api.getTestCase(testCaseId);
      testCaseConfig = res?.data || null;
      runInIncognito = Number(testCaseConfig?.run_in_incognito || 0) !== 0;
      const modeFromCase = String(testCaseConfig?.screenshot_mode || '').trim().toLowerCase();
      if (modeFromCase === 'full_hd') resolvedScreenshotMode = 'full_hd';
    } catch (e) {
      if (insertRequiresSnapshot) {
        this.state.mode = 'idle';
        this.state.testCaseId = null;
        return {
          ok: false,
          error: e.message || this._tr('拉取已有步骤失败，无法从该位置插入录制', 'Failed to load existing steps. Recording cannot be inserted at this position.'),
        };
      }
      // A normal recording can still use the mode sent by the trusted
      // platform page and fall back to the legacy save path if the network
      // briefly fails. Insert recording is different: it needs the snapshot.
      console.warn('[Recorder] 读取用例配置失败，将使用请求中的录制设置:', e?.message || e);
    }
    const requestedScreenshotMode = String(options.screenshotMode || '').trim().toLowerCase();
    if (requestedScreenshotMode === 'full_hd') {
      resolvedScreenshotMode = 'full_hd';
    }
    let sessionMode = 'replace';
    let sessionInsertAfter = null;
    let sessionInsertAfterStepId = null;
    if (rawInsert != null && rawInsert !== '') {
      const n = Number(rawInsert);
      if (Number.isFinite(n)) {
        sessionMode = 'insert';
        sessionInsertAfter = Math.max(0, Math.floor(n));
        const list = testCaseConfig?.steps;
        if (!Array.isArray(list) || list.length === 0) {
          this._clearMergeContext();
        } else {
          this._existingStepsSnapshot = list.map((s) => this._stepToSaveShape(s));
          this._insertAfterIndex = Math.max(0, Math.min(Math.floor(n), this._existingStepsSnapshot.length - 1));
          sessionInsertAfter = this._insertAfterIndex;
          const anchorId = Number(list[this._insertAfterIndex]?.id);
          if (Number.isInteger(anchorId) && anchorId > 0) {
            this._insertAfterStepId = anchorId;
            sessionInsertAfterStepId = anchorId;
          }
        }
      }
    } else if (resolvedScreenshotMode === 'standard' && !this._getRecordingImportOptions()) {
      // 未显式传入模式时，回退读取用例配置，兼容弹窗/旧调用链。
      try {
        const res = await this.api.getTestCase(testCaseId);
        const modeFromCase = String(res?.data?.screenshot_mode || '').trim().toLowerCase();
        if (modeFromCase === 'full_hd') resolvedScreenshotMode = 'full_hd';
      } catch {
        // ignore
      }
    }
    // Admin 导入使用专用 DTO，不为 synthetic case ID 创建官方 recording session。
    if (!this._getRecordingImportOptions()) {
      await this._createRecordingSession(testCaseId, sessionMode, sessionInsertAfter, sessionInsertAfterStepId);
    }

    let createdWindowId = null;
    try {
      let tab;
      const reuseTabId = Number(options.reuseTabId);
      if (Number.isInteger(reuseTabId) && reuseTabId > 0) {
        tab = await chrome.tabs.get(reuseTabId);
        if (runInIncognito && tab.incognito !== true) {
          throw new Error(this._tr('该用例需要无痕窗口录制，不能复用常规浏览器标签页。', 'This case requires incognito recording and cannot reuse a regular browser tab.'));
        }
        await chrome.tabs.update(reuseTabId, { active: true }).catch(() => {});
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        this.state.recordingOpenedNewTab = options.closeReusedTabAfterStop === true;
        this.state.recordingWindowId = tab.windowId ?? null;
      } else if (runInIncognito) {
        const availability = await inspectIncognitoAvailability();
        if (!availability.allowed) {
          const error = new Error(this._tr('此用例需要在无痕模式录制。请在 Chrome 扩展详情中开启“允许在无痕模式下运行”后重试。', 'This case requires incognito recording. Enable “Allow in Incognito” in the CueCast extension details, then try again.'));
          error.code = 'incognito_access_required';
          throw error;
        }
        if (availability.existingWindowCount > 0) {
          const error = new Error(this._tr('检测到已有无痕窗口。为保证干净的登录状态，请先关闭所有无痕窗口后再录制。', 'Existing incognito windows were detected. Close all incognito windows before recording to ensure a clean sign-in state.'));
          error.code = 'incognito_windows_open';
          throw error;
        }
        const win = await chrome.windows.create({
          url: startUrl || 'about:blank',
          focused: true,
          state: 'maximized',
          incognito: true,
        });
        createdWindowId = win.id ?? null;
        tab = win.tabs[0];
        this.state.recordingOpenedNewTab = true;
        this.state.recordingWindowId = createdWindowId;
      } else if (startUrl) {
        const win = await chrome.windows.create({ url: startUrl, focused: true, state: 'maximized' });
        createdWindowId = win.id ?? null;
        tab = win.tabs[0];
        this.state.recordingOpenedNewTab = true;
        this.state.recordingWindowId = createdWindowId;
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
      if (createdWindowId != null) {
        await chrome.windows.remove(createdWindowId).catch(() => {});
      }
      await this._discardRecordingSession(testCaseId);
      this.state.mode = 'idle';
      this.state.recordingOpenedNewTab = false;
      this.state.recordingWindowId = null;
      this.state.recordingTabs = [];
      this.state.currentRecordingTabIndex = 0;
      this.state.recordingScreenshotMode = 'standard';
      this.state.recordingImport = null;
      this.state.recordingEndUrl = '';
      this.state.recordingSaveFailed = false;
      this.state.recordingSaveError = '';
      this.state.recordingPaused = false;
      this.state.recordingStartedAt = 0;
      this._clearMergeContext();
      await this._clearSessionDraft();
      return { ok: false, error: err.message, code: err?.code || '' };
    }
  }

  async addStep(step, tabId) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabId);
      if (!restored) return { ok: false, active: false, error: 'not_recording' };
    }
    this._applyPendingSensitiveInput(step, tabId);
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
        await this._waitForTabLoad(tabId, RECORD_RECOVERY_TAB_LOAD_TIMEOUT_MS);
        await this._reinjectRecorder(tabId, this.state.recordingScreenshotMode || 'standard');
      } catch (e) {
        console.warn('[Recorder] keepalive 重建录制工具栏失败:', e?.message || e);
        this._showNotification(
          this._tr('录制恢复失败', 'Recording recovery failed'),
          this._tr('页面加载时间过长，录制工具栏未能恢复。请刷新页面或结束后重新录制。', 'The page took too long to load and the recorder toolbar could not be restored. Refresh the page or finish and start a new recording.'),
        );
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
      if (!restored) return { ok: false, error: this._tr('未在录制', 'Recording is not active.') };
    }

    const recordingTabId = this.state.currentTabId;
    const recordingWindowId = this.state.recordingWindowId;
    const closeTabAfterStop = this.state.recordingOpenedNewTab === true
      || (tabIdHint != null && recordingTabId != null && Number(recordingTabId) !== Number(tabIdHint));

    if (recordingTabId) {
      await chrome.tabs.sendMessage(recordingTabId, { type: 'AT_STOP_RECORDING_ACK' }).catch(() => {});
    }
    this._broadcastStopAck();
    await this._flushRecordingSessionSteps();

    const recorded = [...this.state.recordedSteps];
    const testCaseId = this.state.testCaseId;
    const recordingImport = this.state.recordingImport;
    const importOptions = this._getRecordingImportOptions(recordingImport);
    const recordingEndUrl = await this._getRecordingTabUrl(recordingTabId);
    const saveOptions = recordingImport ? { ...recordingImport, recordingEndUrl } : null;
    const toSave = this._mergeRecordedWithSnapshot(recorded);
    const saveContext = this._buildSaveContext(recordingImport, recordingEndUrl, toSave, recorded);
    // 先持久化最终 URL 和导入上下文，保存失败后仍可按原目标重试。
    this.state.recordingEndUrl = recordingEndUrl;
    await this._saveSessionDraft();
    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordingTabs = [];
    this.state.currentRecordingTabIndex = 0;
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
    let savedStepCount = recorded.length;
    if (testCaseId && toSave && toSave.length > 0) {
      try {
        if (importOptions) {
          const response = await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
          savedStepCount = this._savedStepCount(response, toSave.length);
        } else if (this.state.recordingSessionEnabled && this.state.recordingSessionId && this.state.recordingSessionHealthy !== false) {
          const response = await this._commitRecordingSession(testCaseId);
          savedStepCount = this._savedStepCount(response, toSave.length);
        } else {
          await this._discardRecordingSession(testCaseId);
          const response = await this.api.saveSteps(testCaseId, toSave);
          savedStepCount = this._savedStepCount(response, toSave.length);
        }
        saved = true;
        await this._clearSessionDraft();
        const msg = recorded.length === savedStepCount
          ? this._tr(`已保存 ${savedStepCount} 个操作步骤`, `Saved ${savedStepCount} action steps.`)
          : this._tr(
            `已保存 ${savedStepCount} 步（本次新录制 ${recorded.length} 步）`,
            `Saved ${savedStepCount} steps (${recorded.length} newly recorded).`,
          );
        this._showNotification(this._tr('录制完成', 'Recording completed'), msg);
      } catch (err) {
        const error = err?.message || String(err);
        this._showNotification(this._tr('保存失败', 'Save failed'), error);
        const quotaDetails = err?.quotaDetails || err?.apiData?.data || null;
        const pendingSaveId = !importOptions && quotaDetails?.resource === 'steps_per_case'
          ? this._createPendingQuotaSave(testCaseId, toSave, recorded.length)
          : '';
        const retryable = !pendingSaveId && recorded.length > 0;
        if (retryable) {
          await this._markSessionDraftSaveFailed(error);
        } else {
          await this._clearSessionDraft();
        }
        this.state.recordingSessionId = '';
        this.state.recordingSessionEnabled = false;
        this.state.recordingSessionHealthy = false;
        this.state.recordedSteps = [];
        // 配额确认期间只保留内存中的完整快照。若此时关闭录制标签页，
        // 不能再从草稿恢复后走“标签页关闭自动保存”路径。
        if (pendingSaveId) await this._clearSessionDraft();
        this._broadcastRecordingEnd({
          testCaseId,
          reason: 'completed',
          stepCount: recorded.length,
          saved: false,
          retryable,
          error,
          quotaDetails,
          pendingSaveId,
          saveContext,
        });
        this._notifyPopup();
        if (closeTabAfterStop) {
          this._closeRecordingTarget(recordingWindowId, recordingTabId);
        }
        return { ok: false, error, retryable, quotaDetails, pendingSaveId, testCaseId, saveContext };
      }
    } else {
      await this._discardRecordingSession(testCaseId);
    }
    await this._clearSessionDraft();
    this.state.recordingSessionId = '';
    this.state.recordingSessionEnabled = false;
    this.state.recordingSessionHealthy = false;

    if (closeTabAfterStop) {
      this._closeRecordingTarget(recordingWindowId, recordingTabId);
    }

    this.state.recordedSteps = [];
    this._broadcastRecordingEnd({
      testCaseId,
      reason: 'completed',
      stepCount: saved ? savedStepCount : recorded.length,
      saved,
      saveContext,
    });
    this._notifyPopup();

    return { ok: true, stepCount: saved ? savedStepCount : recorded.length };
  }

  /**
   * 取消录制：丢弃本次会话中的步骤，不调用 API，服务端用例步骤保持不变。
   */
  async cancel(tabIdHint = null) {
    if (this.state.mode !== 'recording') {
      const restored = await this._restoreSessionDraft(tabIdHint);
      if (!restored) return { ok: false, error: this._tr('未在录制', 'Recording is not active.') };
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
    this.state.recordingImport = null;
    this.state.recordingEndUrl = '';
    this.state.recordingSaveFailed = false;
    this.state.recordingSaveError = '';
    this.state.recordingPaused = false;
    this.state.recordingStartedAt = 0;
    this.state.recordingSessionId = '';
    this.state.recordingSessionEnabled = false;
    this.state.recordingSessionHealthy = false;
    this.state.pendingQuotaSave = null;
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
    // 等待用户选择保留或放弃超额步骤时，禁止关闭事件触发自动保存。
    if (this.state.pendingQuotaSave) return;
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

    await this._flushRecordingSessionSteps();

    const recorded = [...this.state.recordedSteps];
    const testCaseId = this.state.testCaseId;
    const recordingImport = this.state.recordingImport;
    const importOptions = this._getRecordingImportOptions(recordingImport);
    const recordingWindowId = this.state.recordingWindowId;
    const recordingEndUrl = this.state.recordingEndUrl
      || await this._getRecordingTabUrl(this.state.currentTabId)
      || String(recorded.at(-1)?.url || '');
    const saveOptions = recordingImport
      ? { ...recordingImport, recordingEndUrl }
      : null;
    const toSave = this._mergeRecordedWithSnapshot(recorded);
    const saveContext = this._buildSaveContext(recordingImport, recordingEndUrl, toSave, recorded);
    // 主录制页关闭前保留完整导入上下文；子标签页关闭仅更新标签注册表。
    this.state.recordingEndUrl = recordingEndUrl;
    await this._saveSessionDraft();
    this._clearMergeContext();
    this.state.mode = 'idle';
    this.state.currentTabId = null;
    this.state.recordingTabs = [];
    this.state.currentRecordingTabIndex = 0;
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
    let quotaDetails = null;
    let pendingSaveId = '';
    let savedStepCount = recorded.length;
    if (testCaseId && toSave && toSave.length > 0) {
      try {
        if (importOptions) {
          const response = await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
          savedStepCount = this._savedStepCount(response, toSave.length);
        } else if (this.state.recordingSessionEnabled && this.state.recordingSessionId && this.state.recordingSessionHealthy !== false) {
          const response = await this._commitRecordingSession(testCaseId);
          savedStepCount = this._savedStepCount(response, toSave.length);
        } else {
          await this._discardRecordingSession(testCaseId);
          const response = await this.api.saveSteps(testCaseId, toSave);
          savedStepCount = this._savedStepCount(response, toSave.length);
        }
        saved = true;
        await this._clearSessionDraft();
        this._showNotification(
          this._tr('录制标签页已关闭', 'Recording tab closed'),
          this._tr(`已保存 ${savedStepCount} 个操作步骤`, `Saved ${savedStepCount} action steps.`),
        );
      } catch (err) {
        saveError = err?.message || String(err);
        this._showNotification(this._tr('保存失败', 'Save failed'), saveError);
        quotaDetails = err?.quotaDetails || err?.apiData?.data || null;
        pendingSaveId = !importOptions && quotaDetails?.resource === 'steps_per_case'
          ? this._createPendingQuotaSave(testCaseId, toSave, recorded.length)
          : '';
        saved = false;
        this.state.lastRecordingSaveError = {
          message: saveError,
          quotaDetails,
          pendingSaveId,
        };
      }
    } else {
      saveError = '录制标签页已关闭，但没有可保存的步骤。';
      await this._discardRecordingSession(testCaseId);
    }
    const retryable = !saved && !pendingSaveId && Boolean(saveError) && recorded.length > 0;
    if (retryable) {
      await this._markSessionDraftSaveFailed(saveError);
    } else if (!saved) {
      await this._clearSessionDraft();
    }
    this.state.recordingSessionId = '';
    this.state.recordingSessionEnabled = false;
    this.state.recordingSessionHealthy = false;
    if (recordingWindowId) {
      chrome.windows.remove(recordingWindowId).catch(() => {});
    }

    this.state.recordedSteps = [];
    this._broadcastRecordingEnd({
      testCaseId,
      reason: 'tab_closed',
      stepCount: saved ? savedStepCount : recorded.length,
      saved,
      retryable,
      error: saved ? undefined : saveError,
      quotaDetails,
      pendingSaveId,
      saveContext,
    });
    this._notifyPopup();
  }

  _waitForTabLoad(tabId, timeoutMs = RECORD_TAB_LOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const check = async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          finish(new Error(this._tr('录制页面已关闭，无法开始录制', 'The recording page was closed before recording could start.')));
          return;
        }
        if (tab.status === 'complete') {
          finish();
          return;
        }
        setTimeout(check, 300);
      };
      const timeout = setTimeout(() => {
        finish(new Error(this._tr('录制页面加载超时，无法开始录制', 'Recording page load timed out. Recording could not start.')));
      }, timeoutMs);
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
      locale: normalizeLocale(this.state.recordingLocale),
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
      await this._waitForTabLoad(tabId, RECORD_RECOVERY_TAB_LOAD_TIMEOUT_MS);
      await this._reinjectRecorder(tabId, this.state.recordingScreenshotMode || 'standard');
      await this._saveSessionDraft();
      this._showNotification(
        tabInfo.index === 0
          ? this._tr('录制已续接', 'Recording resumed')
          : this._tr(`已接管新标签页 #${tabInfo.index}`, `New tab #${tabInfo.index} added to recording`),
        this._tr(
          `当前已捕获 ${this.state.recordedSteps.length} 步`,
          `${this.state.recordedSteps.length} steps captured.`,
        ),
      );
    } catch (e) {
      console.warn('[Recorder] 页面跳转后恢复录制失败:', e?.message || e);
      this._showNotification(
        this._tr('录制恢复失败', 'Recording recovery failed'),
        this._tr('页面加载时间过长，录制工具栏未能恢复。请刷新页面或结束后重新录制。', 'The page took too long to load and the recorder toolbar could not be restored. Refresh the page or finish and start a new recording.'),
      );
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
      .sendMessage({
        type: 'AT_STATE_CHANGED',
        state: {
          mode: this.state.mode,
          testCaseId: this.state.testCaseId,
          recordedSteps: this.state.recordedSteps.length,
          recordingPaused: this.state.recordingPaused === true,
          activePlayCount: Number(this.state.activePlayCount || 0),
        },
      })
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
