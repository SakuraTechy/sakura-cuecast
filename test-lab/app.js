(function () {
  const STORAGE_KEY = 'cuecast-lab:settings:v3';
  const DEFAULT_API_BASE = `${location.origin}/api`;
  const DEFAULT_START_URL = `${location.origin}/test-lab/target.html`;

  const $ = (selector, root = document) => root.querySelector(selector);

  const refs = {
    apiBase: $('#apiBase'),
    authToken: $('#authToken'),
    testCaseId: $('#testCaseId'),
    startUrl: $('#startUrl'),
    insertAfterStepIndex: $('#insertAfterStepIndex'),
    screenshotMode: $('#screenshotMode'),
    locale: $('#locale'),
    startStepIndex: $('#startStepIndex'),
    runnerHeaded: $('#runnerHeaded'),
    runnerSlowMo: $('#runnerSlowMo'),
    runnerFinishDelay: $('#runnerFinishDelay'),
    bridgeStatus: $('#bridgeStatus'),
    caseIdLabel: $('#caseIdLabel'),
    caseName: $('#caseName'),
    caseStatus: $('#caseStatus'),
    startUrlText: $('#startUrlText'),
    descriptionText: $('#descriptionText'),
    screenshotModeText: $('#screenshotModeText'),
    windowSizeText: $('#windowSizeText'),
    workbench: $('.workbench'),
    sidePanelToggle: $('.side-panel-toggle'),
    stepCount: $('#stepCount'),
    stepCanvas: $('#stepCanvas'),
    historyList: $('#historyList'),
    runSummary: $('#runSummary'),
    eventFeed: $('#eventFeed'),
    toastZone: $('#toastZone'),
    caseDialog: $('#caseDialog'),
    editName: $('#editName'),
    editStartUrl: $('#editStartUrl'),
    editDescription: $('#editDescription'),
    editPageErrorCheckEnabled: $('#editPageErrorCheckEnabled'),
    editWindowSizeCustom: $('#editWindowSizeCustom'),
    editViewportWidth: $('#editViewportWidth'),
    editViewportHeight: $('#editViewportHeight'),
    stepDialog: $('#stepDialog'),
    stepForm: $('#stepForm'),
    stepDialogTitle: $('#stepDialogTitle'),
    editStepId: $('#editStepId'),
    editActionType: $('#editActionType'),
    editSelector: $('#editSelector'),
    editXPath: $('#editXPath'),
    editValue: $('#editValue'),
    editStepDescription: $('#editStepDescription'),
    stepTemplate: $('#stepTemplate'),
    thumbDialog: $('#thumbDialog'),
    thumbPreview: $('#thumbPreview'),
    thumbPreviewClose: $('#thumbPreviewClose'),
  };

  const state = {
    case: null,
    results: [],
    pending: new Map(),
    playTabId: null,
    lastRunnerJobId: null,
    bridgeVersion: '',
  };

  function readSettings() {
    try {
      const settings = { ...defaultSettings(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
      const caseIdFromPath = getCaseIdFromPath();
      if (caseIdFromPath) settings.testCaseId = caseIdFromPath;
      return settings;
    } catch {
      const settings = defaultSettings();
      const caseIdFromPath = getCaseIdFromPath();
      if (caseIdFromPath) settings.testCaseId = caseIdFromPath;
      return settings;
    }
  }

  function getCaseIdFromPath() {
    const match = location.pathname.match(/\/testcases\/(\d+)/);
    return match ? match[1] : '';
  }

  function defaultSettings() {
    return {
      apiBase: DEFAULT_API_BASE,
      authToken: '',
      testCaseId: '278',
      startUrl: DEFAULT_START_URL,
      insertAfterStepIndex: '',
      screenshotMode: 'standard',
      locale: 'zh',
      startStepIndex: '0',
      runnerHeaded: false,
      runnerSlowMo: '250',
      runnerFinishDelay: '5000',
    };
  }

  function settingsFromFields() {
    return {
      apiBase: refs.apiBase.value.trim() || DEFAULT_API_BASE,
      authToken: refs.authToken.value.trim(),
      testCaseId: refs.testCaseId.value.trim() || '278',
      startUrl: refs.startUrl.value.trim() || DEFAULT_START_URL,
      insertAfterStepIndex: refs.insertAfterStepIndex.value.trim(),
      screenshotMode: refs.screenshotMode.value,
      locale: refs.locale.value,
      startStepIndex: refs.startStepIndex.value.trim() || '0',
      runnerHeaded: refs.runnerHeaded.checked,
      runnerSlowMo: refs.runnerSlowMo.value.trim() || '0',
      runnerFinishDelay: refs.runnerFinishDelay.value.trim() || '0',
    };
  }

  function saveSettings() {
    const payload = settingsFromFields();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    localStorage.setItem('cc_auth_token', payload.authToken);
  }

  function toggleSidePanel() {
    const collapsed = refs.workbench.classList.toggle('is-side-collapsed');
    refs.sidePanelToggle.setAttribute('aria-expanded', String(!collapsed));
    refs.sidePanelToggle.title = collapsed ? '展开侧栏' : '收起侧栏';
    const icon = refs.sidePanelToggle.querySelector('span');
    if (icon) icon.textContent = collapsed ? '‹' : '›';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function apiRequest(method, path, body) {
    saveSettings();
    const headers = { 'Content-Type': 'application/json' };
    const token = refs.authToken.value.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${refs.apiBase.value.trim()}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) throw new Error(data.message || `HTTP ${res.status}`);
    return data.data;
  }

  function appendLog(kind, title, detail = '') {
    const item = document.createElement('li');
    item.className = kind;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    item.innerHTML = `<strong>${escapeHtml(time)} ${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
    refs.eventFeed.prepend(item);
    while (refs.eventFeed.children.length > 24) refs.eventFeed.lastElementChild.remove();
  }

  function showToast(title, detail = '', kind = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.dataset.kind = kind;
    toast.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}`;
    refs.toastZone.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(4px)';
      setTimeout(() => toast.remove(), 220);
    }, 2600);
  }

  function normalizeStatus(status) {
    const raw = String(status || '').toLowerCase();
    if (!raw || raw.includes('未执行') || raw === 'idle') return { text: status || '未执行', state: 'idle' };
    if (raw.includes('pass') || raw.includes('success') || raw.includes('通过')) return { text: '已通过', state: 'passed' };
    if (raw.includes('fail') || raw.includes('失败')) return { text: '失败', state: 'failed' };
    if (raw.includes('running') || raw.includes('执行')) return { text: '执行中', state: 'running' };
    return { text: status || '未执行', state: 'idle' };
  }

  function normalizeWindowSizeMode(mode) {
    const raw = String(mode || '').toLowerCase();
    if (['current', 'current_window', 'current-window'].includes(raw)) return 'current';
    if (['custom', 'custom_size', 'custom-size'].includes(raw)) return 'custom';
    return 'maximized';
  }

  function windowSizeLabel(testCase) {
    const mode = normalizeWindowSizeMode(testCase?.window_size_mode);
    const width = Number(testCase?.viewport_width);
    const height = Number(testCase?.viewport_height);
    if (mode === 'current') return width >= 320 && height >= 320 ? `当前窗口 ${Math.floor(width)} x ${Math.floor(height)}` : '当前窗口尺寸';
    if (mode === 'custom') return width >= 320 && height >= 320 ? `自定义 ${Math.floor(width)} x ${Math.floor(height)}` : '自定义尺寸';
    return '默认最大化';
  }

  function currentWindowSize() {
    return {
      width: Math.max(320, Math.floor(window.innerWidth || 1920)),
      height: Math.max(320, Math.floor(window.innerHeight || 1080)),
    };
  }

  function parseWindowSize(value, fallback) {
    const size = Number(value);
    return Number.isFinite(size) && size >= 320 ? Math.floor(size) : fallback;
  }

  function selectedEditWindowSizeMode() {
    return normalizeWindowSizeMode(document.querySelector('input[name="editWindowSizeMode"]:checked')?.value);
  }

  function setEditWindowSizeMode(mode) {
    const normalized = normalizeWindowSizeMode(mode);
    const input = document.querySelector(`input[name="editWindowSizeMode"][value="${normalized}"]`);
    if (input) input.checked = true;
  }

  function selectedEditScreenshotMode() {
    const value = document.querySelector('input[name="editScreenshotMode"]:checked')?.value;
    return value === 'full_hd' ? 'full_hd' : 'standard';
  }

  function setEditScreenshotMode(mode) {
    const normalized = String(mode || '').toLowerCase() === 'full_hd' ? 'full_hd' : 'standard';
    const input = document.querySelector(`input[name="editScreenshotMode"][value="${normalized}"]`);
    if (input) input.checked = true;
  }

  function updateWindowSizeInputsState() {
    const isCustom = selectedEditWindowSizeMode() === 'custom';
    refs.editWindowSizeCustom.dataset.disabled = isCustom ? 'false' : 'true';
    refs.editViewportWidth.disabled = !isCustom;
    refs.editViewportHeight.disabled = !isCustom;
  }

  function renderCase() {
    const testCase = state.case;
    if (!testCase) return;
    const status = normalizeStatus(testCase.status);
    refs.caseIdLabel.textContent = testCase.id || refs.testCaseId.value;
    refs.caseName.textContent = testCase.name || '未命名用例';
    refs.caseStatus.textContent = status.text;
    refs.caseStatus.dataset.state = status.state;
    refs.startUrlText.textContent = testCase.start_url || '-';
    refs.descriptionText.textContent = testCase.description || '-';
    const screenshotModeLabels = { standard: '标准', full_hd: '全高清' };
    refs.screenshotModeText.textContent = screenshotModeLabels[testCase.screenshot_mode] || screenshotModeLabels.standard;
    refs.windowSizeText.textContent = windowSizeLabel(testCase);
    refs.startUrl.value = testCase.start_url || DEFAULT_START_URL;
    refs.screenshotMode.value = testCase.screenshot_mode || refs.screenshotMode.value || 'standard';
    refs.stepCount.textContent = String((testCase.steps || []).length);
    renderSteps(testCase.steps || []);
    saveSettings();
  }

  function renderSteps(steps) {
    refs.stepCanvas.innerHTML = '';
    if (!steps.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-steps';
      empty.innerHTML = '<strong>暂无操作步骤</strong><span>开始录制后会自动生成步骤，也可以手动新增。</span>';
      refs.stepCanvas.appendChild(empty);
      return;
    }

    steps.forEach((step, index) => {
      const node = refs.stepTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.stepIndex = String(index);
      node.querySelector('.step-number').textContent = `#${index + 1}`;
      node.querySelector('.action-chip').textContent = step.action_type || 'click';
      node.querySelector('.step-title').textContent = step.description || step.value || step.target_selector || '未命名步骤';
      node.querySelector('.selector-line code').textContent = [
        step.target_selector ? `CSS: ${step.target_selector}` : '',
        step.target_xpath ? `XPath: ${step.target_xpath}` : '',
        step.url ? `URL: ${step.url}` : '',
      ].filter(Boolean).join('\n') || '无定位信息';
      const thumb = node.querySelector('.step-thumb');
      if (step.screenshot) {
        const img = document.createElement('img');
        img.alt = step.description || `Step ${index + 1}`;
        img.src = step.screenshot;
        thumb.classList.add('has-image');
        thumb.dataset.previewSrc = step.screenshot;
        thumb.dataset.previewAlt = img.alt;
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = '<div class="fake-shot"><div class="mini-title"></div><div class="mini-input"></div><div class="mini-input"></div><div class="mini-button"></div></div>';
      }
      refs.stepCanvas.appendChild(node);
    });
  }

  function renderHistory() {
    refs.historyList.innerHTML = '';
    const recentRuns = state.results.slice(0, 5);
    refs.runSummary.textContent = `最近 ${recentRuns.length || 0} 条`;
    if (!state.results.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-history';
      empty.textContent = '暂无执行记录';
      refs.historyList.appendChild(empty);
      return;
    }
    recentRuns.forEach((run) => {
      const item = document.createElement('article');
      item.className = 'history-item';
      item.dataset.status = run.success ? 'passed' : 'failed';
      const created = run.created_at ? new Date(run.created_at).toLocaleString() : '-';
      const detail = extractRunDetail(run);
      item.innerHTML = `
        <strong>${run.success ? '通过' : '失败'} · #${escapeHtml(run.id)}</strong>
        <span>${escapeHtml(created)}</span>
        <span>${escapeHtml(run.duration || run.duration_ms || 0)} ms ${run.error ? `· ${escapeHtml(run.error)}` : ''}</span>
        ${renderRunDetail(detail)}
      `;
      refs.historyList.appendChild(item);
    });
  }

  function extractRunDetail(run) {
    const raw = run.raw?.raw || run.raw || {};
    const failedStep = Array.isArray(raw.steps) ? raw.steps.find((step) => step.status === 'failed') : null;
    return {
      executor: raw.executor || 'playwright-runner',
      browser: raw.browser || '',
      headless: raw.headless,
      failedStep,
      artifacts: raw.artifacts || {},
      errorCode: raw.error_code || failedStep?.error_code || '',
      error: raw.error || failedStep?.error || run.error || '',
    };
  }

  function renderRunDetail(detail) {
    const links = artifactLinks(detail.artifacts);
    const failed = detail.failedStep;
    return `
      <details class="run-detail">
        <summary>Runner report</summary>
        <div class="run-grid">
          <span>Executor</span><strong>${escapeHtml(detail.executor)}</strong>
          <span>Browser</span><strong>${escapeHtml(detail.browser || '-')} ${detail.headless === false ? 'headed' : 'headless'}</strong>
          <span>Error</span><strong>${escapeHtml(detail.errorCode || detail.error || '-')}</strong>
          <span>Failed Step</span><strong>${failed ? `#${escapeHtml(failed.step_index)} ${escapeHtml(failed.action_type)}` : '-'}</strong>
          <span>Locator</span><strong>${failed ? escapeHtml(failed.locator_source || '-') : '-'}</strong>
        </div>
        ${links.length ? `<div class="artifact-links">${links.map((link) => `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>`).join('')}</div>` : ''}
      </details>
    `;
  }

  function artifactLinks(artifacts) {
    const items = [
      ['Report', artifacts.report_html],
      ['Result JSON', artifacts.result_json],
      ['Screenshot', artifacts.failure_screenshot],
      ['Trace', artifacts.trace],
      ['Video', artifacts.video],
      ['Console', artifacts.console_log],
      ['Failure HTML', artifacts.failure_html],
      ['Failure Text', artifacts.failure_text],
    ];
    return items
      .filter(([, value]) => value)
      .map(([label, value]) => ({ label, href: artifactHref(value) }));
  }

  function artifactHref(filePath) {
    const raw = String(filePath || '').replaceAll('\\', '/');
    const marker = '/artifacts/';
    const index = raw.lastIndexOf(marker);
    if (index >= 0) return raw.slice(index);
    return raw;
  }

  async function loadCase() {
    saveSettings();
    const id = refs.testCaseId.value.trim() || '278';
    appendLog('out', 'load case', id);
    const [testCase, results] = await Promise.all([
      apiRequest('GET', `/testcases/${encodeURIComponent(id)}?raw_values=1`),
      apiRequest('GET', `/testcases/${encodeURIComponent(id)}/results`),
    ]);
    state.case = testCase;
    state.results = Array.isArray(results) ? results : [];
    renderCase();
    renderHistory();
    appendLog('ack', 'case loaded', `${id}, ${(testCase.steps || []).length} steps`);
  }

  function captureCommandPayload(type, extra = {}) {
    const s = settingsFromFields();
    return {
      type,
      apiBase: s.apiBase,
      authToken: s.authToken,
      testCaseId: Number(s.testCaseId),
      startUrl: s.startUrl,
      insertAfterStepIndex: s.insertAfterStepIndex === '' ? null : Number(s.insertAfterStepIndex),
      screenshotMode: s.screenshotMode,
      locale: s.locale,
      startStepIndex: s.startStepIndex === '' ? 0 : Number(s.startStepIndex),
      ...extra,
    };
  }

  function nextNonce() {
    return crypto.randomUUID ? crypto.randomUUID() : `cuecast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function isBridgeConnected() {
    return refs.bridgeStatus.dataset.state === 'good';
  }

  function setBridgeConnected(version = state.bridgeVersion) {
    const normalizedVersion = String(version || '').trim();
    if (normalizedVersion && normalizedVersion !== 'unknown') {
      state.bridgeVersion = normalizedVersion;
    }
    refs.bridgeStatus.querySelector('.status-text').textContent = '插件已就绪';
    refs.bridgeStatus.querySelector('.version').textContent = `v${state.bridgeVersion}`;
    refs.bridgeStatus.dataset.state = 'good';
  }

  function responseOriginal(data) {
    if (data.original) return data.original;
    if (data.type === 'AT_PLATFORM_PONG') return 'AT_PLATFORM_PING';
    return data.type;
  }

  function findPending(data) {
    if (data.requestId && state.pending.has(data.requestId)) {
      return [data.requestId, state.pending.get(data.requestId)];
    }
    const original = responseOriginal(data);
    for (const [requestId, pending] of state.pending.entries()) {
      const sameOriginal = pending.original === original || pending.original === data.type;
      const sameNonce = !pending.nonce || pending.nonce === data.nonce;
      if (sameOriginal && sameNonce) return [requestId, pending];
    }
    return [null, null];
  }

  function waitForExtensionAck(original, requestId, nonce = null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = state.pending.get(requestId);
        if (!pending) return;
        state.pending.delete(requestId);
        refs.bridgeStatus.querySelector('.status-text').textContent = '连接超时，未检测到插件';
        refs.bridgeStatus.querySelector('.version').textContent = '';
        refs.bridgeStatus.dataset.state = 'warn';
        reject(new Error(`No response for ${original}`));
      }, 5000);
      state.pending.set(requestId, { original, nonce, resolve, reject, timer });
    });
  }

  async function sendExtensionCommand(type, extra = {}) {
    const payload = captureCommandPayload(type, extra);
    payload.requestId = nextNonce();
    if (type === 'AT_PLATFORM_PING') payload.nonce = payload.requestId;
    appendLog('out', `send ${type}`, JSON.stringify(payload));
    window.postMessage(payload, '*');
    refs.bridgeStatus.querySelector('.status-text').textContent = '已发送';
    refs.bridgeStatus.querySelector('.version').textContent = '';
    refs.bridgeStatus.dataset.state = 'warn';
    return waitForExtensionAck(type, payload.requestId, payload.nonce || null);
  }

  function settlePending(data, value) {
    const [requestId, pending] = findPending(data);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(requestId);
    pending.resolve(value);
  }

  function rejectPending(data, error) {
    const [requestId, pending] = findPending(data);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(requestId);
    pending.reject(error);
  }

  function rejectAllPending(error) {
    for (const [requestId, pending] of state.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      state.pending.delete(requestId);
    }
  }

  function handleBridgeMessage(event) {
    const data = event.data || {};
    if (data.type === 'CUECAST_RUNNER_JOB_STARTED') {
      state.lastRunnerJobId = data.job?.id || state.lastRunnerJobId;
      appendLog('out', 'runner job started', state.lastRunnerJobId || '');
      return;
    }
    if (data.type === 'CUECAST_RUNNER_JOB_DONE') {
      appendLog(data.job?.status === 'failed' ? 'warn' : 'ack', 'runner job done', `${data.job?.id || ''}: ${data.job?.status || ''}`);
      setTimeout(() => loadCase().catch((error) => appendLog('warn', 'reload failed', error.message)), 500);
      return;
    }
    if (data.type === 'CUECAST_RUNNER_JOB_LOG') {
      appendLog(data.kind || 'ack', data.title || 'runner', data.detail || '');
      return;
    }
    if (event.source !== window) return;
    if (data.type === 'AT_PLATFORM_PONG') {
      if (data.ok === false) {
        const error = new Error(data.error || 'Extension bridge is not available');
        refs.bridgeStatus.querySelector('.status-text').textContent = '未检测到插件';
        refs.bridgeStatus.querySelector('.version').textContent = '';
        refs.bridgeStatus.dataset.state = 'warn';
        rejectPending(data, error);
        appendLog('warn', 'pong failed', error.message);
        return;
      }
      setBridgeConnected(data.version);
      settlePending(data, data);
      appendLog('ack', 'pong', data.version || 'unknown');
      return;
    }
    if (data.type === 'AT_PLATFORM_ACK') {
      if (data.response?.ok === false) {
        const error = new Error(data.response.error || `${data.original || 'command'} failed`);
        refs.bridgeStatus.querySelector('.status-text').textContent = '指令失败';
        refs.bridgeStatus.querySelector('.version').textContent = '';
        refs.bridgeStatus.dataset.state = 'warn';
        rejectPending(data, error);
        appendLog('warn', data.original || 'ack failed', error.message);
        return;
      }
      setBridgeConnected();
      if (data.response?.tabId != null) state.playTabId = data.response.tabId;
      settlePending(data, data.response || {});
      appendLog('ack', data.original, JSON.stringify(data.response || {}));
      return;
    }
    if (data.type === 'AT_STATE_CHANGED') {
      appendLog('ack', 'state changed', JSON.stringify(data.state || {}));
      return;
    }
    if (data.type === 'AT_RECORDING_LIVE' || data.type === 'AT_PLAYBACK_LIVE') {
      appendLog('ack', data.type, JSON.stringify(data));
      return;
    }
    if (data.type === 'AT_RECORDING_END' || data.type === 'AT_PLAYBACK_END') {
      appendLog('ack', data.type, JSON.stringify(data));
      showToast('任务结束', data.type, 'info');
      setTimeout(() => loadCase().catch((error) => appendLog('warn', 'reload failed', error.message)), 500);
      return;
    }
    if (data.type === 'AT_EXTENSION_CONTEXT_INVALID') {
      refs.bridgeStatus.querySelector('.status-text').textContent = '连接丢失';
      refs.bridgeStatus.querySelector('.version').textContent = '';
      refs.bridgeStatus.dataset.state = 'danger';
      const error = new Error(data.error || 'Reload the extension or refresh this page.');
      rejectAllPending(error);
      appendLog('warn', 'bridge invalidated', error.message);
    }
  }

  function openCaseDialog() {
    const testCase = state.case || {};
    refs.editName.value = testCase.name || '';
    refs.editStartUrl.value = testCase.start_url || DEFAULT_START_URL;
    refs.editDescription.value = testCase.description || '';
    setEditScreenshotMode(testCase.screenshot_mode || 'standard');
    refs.editPageErrorCheckEnabled.checked = Number(testCase.page_error_check_enabled ?? 1) !== 0;
    setEditWindowSizeMode(normalizeWindowSizeMode(testCase.window_size_mode));
    const currentSize = currentWindowSize();
    refs.editViewportWidth.value = Number(testCase.viewport_width) >= 320 ? String(Math.floor(Number(testCase.viewport_width))) : String(currentSize.width);
    refs.editViewportHeight.value = Number(testCase.viewport_height) >= 320 ? String(Math.floor(Number(testCase.viewport_height))) : String(currentSize.height);
    updateWindowSizeInputsState();
    refs.caseDialog.showModal();
  }

  async function saveCaseDialog(returnValue) {
    if (returnValue !== 'save') return;
    const id = refs.testCaseId.value.trim() || '278';
    const windowMode = selectedEditWindowSizeMode();
    const currentSize = currentWindowSize();
    const customWidth = parseWindowSize(refs.editViewportWidth.value, currentSize.width);
    const customHeight = parseWindowSize(refs.editViewportHeight.value, currentSize.height);
    const viewport = windowMode === 'current'
      ? currentSize
      : windowMode === 'custom'
        ? { width: customWidth, height: customHeight }
        : { width: 0, height: 0 };
    const updated = await apiRequest('PUT', `/testcases/${encodeURIComponent(id)}`, {
      name: refs.editName.value.trim(),
      start_url: refs.editStartUrl.value.trim(),
      description: refs.editDescription.value.trim(),
      screenshot_mode: selectedEditScreenshotMode(),
      window_size_mode: windowMode,
      viewport_width: viewport.width,
      viewport_height: viewport.height,
      page_error_check_enabled: refs.editPageErrorCheckEnabled.checked ? 1 : 0,
    });
    state.case = updated;
    renderCase();
    showToast('已保存', '用例信息已更新。', 'info');
  }

  function getStepByIndex(index) {
    const steps = state.case?.steps || [];
    return steps[index] || null;
  }

  function openStepDialog(index = -1) {
    const step = index >= 0 ? getStepByIndex(index) : null;
    refs.stepDialogTitle.textContent = step ? `编辑步骤 #${index + 1}` : '新增步骤';
    refs.editStepId.value = index >= 0 ? String(index) : '';
    refs.editActionType.value = step?.action_type || 'click';
    refs.editSelector.value = step?.target_selector || '';
    refs.editXPath.value = step?.target_xpath || '';
    refs.editValue.value = step?.value || '';
    refs.editStepDescription.value = step?.description || '';
    refs.stepDialog.showModal();
  }

  function stepFromDialog() {
    return {
      action_type: refs.editActionType.value,
      target_selector: refs.editSelector.value.trim(),
      target_xpath: refs.editXPath.value.trim(),
      value: refs.editValue.value,
      description: refs.editStepDescription.value.trim(),
      url: refs.startUrl.value.trim() || DEFAULT_START_URL,
      wait_before: 0,
      value_masked: 0,
      screenshot: '',
    };
  }

  async function saveSteps(steps) {
    const id = refs.testCaseId.value.trim() || '278';
    const data = await apiRequest('POST', `/testcases/${encodeURIComponent(id)}/steps`, { steps });
    state.case.steps = data.steps || steps;
    renderCase();
  }

  async function saveStepDialog(returnValue) {
    if (returnValue !== 'save') return;
    const steps = [...(state.case?.steps || [])];
    const index = refs.editStepId.value === '' ? -1 : Number(refs.editStepId.value);
    const next = stepFromDialog();
    if (index >= 0) steps[index] = { ...steps[index], ...next };
    else steps.push(next);
    await saveSteps(steps);
    showToast('步骤已保存', `${steps.length} steps`, 'info');
  }

  async function duplicateStep(index) {
    const steps = [...(state.case?.steps || [])];
    const source = steps[index];
    if (!source) return;
    steps.splice(index + 1, 0, { ...source, id: undefined, description: `${source.description || source.action_type} copy` });
    await saveSteps(steps);
  }

  async function deleteStep(index) {
    const steps = [...(state.case?.steps || [])];
    steps.splice(index, 1);
    await saveSteps(steps);
  }

  async function resetLocal() {
    const id = refs.testCaseId.value.trim() || '278';
    await apiRequest('POST', `/testcases/${encodeURIComponent(id)}/reset`, {});
    await loadCase();
    showToast('已重置', '本地 mock 数据已恢复。', 'info');
  }

  function openThumbPreview(thumb) {
    const src = thumb?.dataset.previewSrc || '';
    if (!src) return;
    refs.thumbPreview.style.removeProperty('--preview-natural-width');
    refs.thumbPreview.style.removeProperty('--preview-natural-height');
    refs.thumbPreview.src = src;
    refs.thumbPreview.alt = thumb.dataset.previewAlt || 'Step screenshot';
    refs.thumbDialog.showModal();
  }

  function clearThumbPreview() {
    refs.thumbPreview.removeAttribute('src');
    refs.thumbPreview.alt = '';
    refs.thumbPreview.style.removeProperty('--preview-natural-width');
    refs.thumbPreview.style.removeProperty('--preview-natural-height');
  }

  function closeThumbPreview() {
    if (refs.thumbDialog.open) refs.thumbDialog.close();
    else clearThumbPreview();
  }

  function buildRunnerLauncherUrl(settings) {
    const params = new URLSearchParams({
      caseId: settings.testCaseId,
      apiBase: settings.apiBase,
      headed: String(settings.runnerHeaded),
      slowMo: settings.runnerHeaded ? settings.runnerSlowMo : '0',
      finishDelay: settings.runnerHeaded ? settings.runnerFinishDelay : '0',
    });
    return `/test-lab/runner-launch.html?${params.toString()}`;
  }

  function openRunnerLauncher(settings) {
    const win = window.open(buildRunnerLauncherUrl(settings), 'cuecast-runner-launch');
    if (!win) return false;
    win.focus?.();
    appendLog('out', 'runner launcher opened', `case ${settings.testCaseId}`);
    showToast('Runner 前台页已打开', `case ${settings.testCaseId}`, 'info');
    return true;
  }

  async function startRunnerPlayback(options = {}) {
    const s = settingsFromFields();
    if (s.runnerHeaded && options.foreground !== false && openRunnerLauncher(s)) return null;
    const job = await apiRequest('POST', '/runner/jobs', {
      case_id: Number(s.testCaseId) || s.testCaseId,
      api_base: s.apiBase,
      headed: s.runnerHeaded,
      slow_mo: s.runnerHeaded ? s.runnerSlowMo : 0,
      finish_delay: s.runnerHeaded ? s.runnerFinishDelay : 0,
      trace: 'retain-on-failure',
      video: 'retain-on-failure',
    });
    state.lastRunnerJobId = job.id;
    appendLog('out', 'runner job started', job.id);
    showToast('Runner 已启动', job.id, 'info');
    setTimeout(() => {
      focusRunnerWindow(job.id, { silent: true }).catch((error) => appendLog('warn', 'runner focus failed', error.message));
    }, 1400);
    await pollRunnerJob(job.id);
  }

  async function focusRunnerWindow(jobId = state.lastRunnerJobId, options = {}) {
    if (!jobId) throw new Error('No runner job to focus');
    const result = await apiRequest('POST', `/runner/jobs/${encodeURIComponent(jobId)}/focus`, {});
    appendLog('out', 'runner focus requested', `${jobId} pid=${result.pid || '-'}`);
    if (!options.silent) showToast('Runner 窗口定位已请求', jobId, 'info');
    return result;
  }

  async function pollRunnerJob(jobId) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 500 : 1000));
      const job = await apiRequest('GET', `/runner/jobs/${encodeURIComponent(jobId)}`);
      appendLog(job.status === 'failed' ? 'warn' : 'ack', 'runner job status', `${job.id}: ${job.status}`);
      if (!['queued', 'running'].includes(job.status)) {
        showToast(`Runner ${job.status}`, job.stdout || job.stderr || job.id, job.status === 'passed' ? 'info' : 'warn');
        await loadCase();
        return job;
      }
    }
    throw new Error(`Runner job timed out: ${jobId}`);
  }

  function bindEvents() {
    [refs.apiBase, refs.authToken, refs.testCaseId, refs.startUrl, refs.insertAfterStepIndex, refs.screenshotMode, refs.locale, refs.startStepIndex, refs.runnerHeaded, refs.runnerSlowMo, refs.runnerFinishDelay]
      .forEach((field) => {
        field.addEventListener('change', saveSettings);
        field.addEventListener('input', saveSettings);
      });
    refs.testCaseId.addEventListener('change', () => loadCase().catch(showError));
    window.addEventListener('message', handleBridgeMessage);

    refs.caseDialog.addEventListener('close', () => saveCaseDialog(refs.caseDialog.returnValue).catch(showError));
    refs.stepDialog.addEventListener('close', () => saveStepDialog(refs.stepDialog.returnValue).catch(showError));
    document.querySelectorAll('input[name="editWindowSizeMode"]').forEach((input) => {
      input.addEventListener('change', updateWindowSizeInputsState);
    });

    refs.stepCanvas.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-step-action]');
      if (!button) return;
      const card = button.closest('.step-card');
      const index = Number(card?.dataset.stepIndex);
      if (button.dataset.stepAction === 'edit') openStepDialog(index);
      if (button.dataset.stepAction === 'duplicate') duplicateStep(index).catch(showError);
      if (button.dataset.stepAction === 'delete') deleteStep(index).catch(showError);
    });
    refs.stepCanvas.addEventListener('dblclick', (event) => {
      const thumb = event.target.closest('.step-thumb.has-image');
      if (!thumb || !refs.stepCanvas.contains(thumb)) return;
      openThumbPreview(thumb);
    });
    refs.thumbPreview.addEventListener('load', () => {
      if (!refs.thumbPreview.naturalWidth || !refs.thumbPreview.naturalHeight) return;
      refs.thumbPreview.style.setProperty('--preview-natural-width', `${refs.thumbPreview.naturalWidth}px`);
      refs.thumbPreview.style.setProperty('--preview-natural-height', `${refs.thumbPreview.naturalHeight}px`);
    });
    refs.thumbPreviewClose.addEventListener('click', closeThumbPreview);
    refs.thumbPreview.addEventListener('dblclick', closeThumbPreview);
    refs.thumbDialog.addEventListener('click', (event) => {
      if (event.target === refs.thumbDialog) closeThumbPreview();
    });
    refs.thumbDialog.addEventListener('close', clearThumbPreview);

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      const command = button.dataset.command;
      try {
        if (command === 'refresh') await loadCase();
        if (command === 'ping') await sendExtensionCommand('AT_PLATFORM_PING');
        if (command === 'record') {
          await sendExtensionCommand('AT_PLATFORM_RECORD');
          showToast('录制已请求', '扩展已接收开始录制命令。', 'info');
        }
        if (command === 'play') {
          await sendExtensionCommand('AT_PLATFORM_PLAY');
          showToast('执行已请求', '扩展已接收执行命令。', 'info');
        }
        if (command === 'runner-play') await startRunnerPlayback();
        if (command === 'focus-runner') await focusRunnerWindow();
        if (command === 'stop') await sendExtensionCommand('AT_PLATFORM_STOP');
        if (command === 'open-play') await sendExtensionCommand('AT_PLATFORM_OPEN_PLAY_TAB');
        if (command === 'focus-play') await sendExtensionCommand('AT_PLATFORM_FOCUS_PLAY_TAB');
        if (command === 'edit-case') openCaseDialog();
        if (command === 'add-step') openStepDialog(-1);
        if (command === 'copy-steps') {
          await navigator.clipboard.writeText(JSON.stringify(state.case?.steps || [], null, 2));
          showToast('已复制', '步骤 JSON 已复制到剪贴板。', 'info');
        }
        if (command === 'export-steps') {
          const blob = new Blob([JSON.stringify(state.case?.steps || [], null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `cuecast-case-${refs.testCaseId.value || '278'}-steps.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
        if (command === 'clear-steps') await saveSteps([]);
        if (command === 'reset-local') await resetLocal();
        if (command === 'reset-logs') refs.eventFeed.innerHTML = '';
        if (command === 'open-target') window.open(refs.startUrl.value || DEFAULT_START_URL, '_blank', 'noopener');
        if (command === 'toggle-side-panel') toggleSidePanel();
      } catch (error) {
        showError(error);
      }
    });
  }

  function showError(error) {
    const message = error?.message || String(error);
    appendLog('warn', 'error', message);
    showToast('操作失败', message, 'warn');
  }

  async function bootstrap() {
    const settings = readSettings();
    refs.apiBase.value = settings.apiBase || DEFAULT_API_BASE;
    refs.authToken.value = settings.authToken || '';
    refs.testCaseId.value = settings.testCaseId || '278';
    refs.startUrl.value = settings.startUrl || DEFAULT_START_URL;
    refs.insertAfterStepIndex.value = settings.insertAfterStepIndex || '';
    refs.screenshotMode.value = settings.screenshotMode || 'standard';
    refs.locale.value = settings.locale || 'zh';
    refs.startStepIndex.value = settings.startStepIndex || '0';
    refs.runnerHeaded.checked = settings.runnerHeaded === true || settings.runnerHeaded === 'true';
    refs.runnerSlowMo.value = settings.runnerSlowMo || '250';
    refs.runnerFinishDelay.value = settings.runnerFinishDelay || '5000';
    localStorage.setItem('cc_auth_token', refs.authToken.value);
    bindEvents();
    appendLog('local', 'boot', 'CueCast testcase detail lab is ready.');
    await loadCase();
    sendExtensionCommand('AT_PLATFORM_PING').catch((error) => {
      if (!isBridgeConnected()) {
        refs.bridgeStatus.querySelector('.status-text').textContent = '未检测到插件';
        refs.bridgeStatus.querySelector('.version').textContent = '';
        refs.bridgeStatus.dataset.state = 'warn';
      }
      appendLog('warn', 'bridge ping failed', error.message);
    });
  }

  bootstrap().catch(showError);
})();
