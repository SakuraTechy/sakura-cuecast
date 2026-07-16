(function () {
  const params = new URLSearchParams(location.search);
  const $ = (selector) => document.querySelector(selector);

  const refs = {
    status: $('#status'),
    caseId: $('#caseId'),
    jobId: $('#jobId'),
    pid: $('#pid'),
    mode: $('#mode'),
    log: $('#log'),
    focusBtn: $('#focusBtn'),
    refreshBtn: $('#refreshBtn'),
    caseLink: $('#caseLink'),
  };

  const state = {
    apiBase: params.get('apiBase') || `${location.origin}/api`,
    caseId: params.get('caseId') || '278',
    headed: parseBoolean(params.get('headed'), true),
    slowMo: Number(params.get('slowMo') || 0) || 0,
    finishDelay: Number(params.get('finishDelay') || 0) || 0,
    job: null,
    polling: false,
  };

  function parseBoolean(value, fallback) {
    if (value == null || value === '') return fallback;
    return value === true || value === 'true' || value === '1';
  }

  function apiUrl(path) {
    return `${state.apiBase.replace(/\/+$/, '')}${path}`;
  }

  async function apiRequest(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('cc_auth_token') || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(apiUrl(path), {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) throw new Error(data.message || `HTTP ${response.status}`);
    return data.data;
  }

  function postToOpener(type, payload = {}) {
    try {
      window.opener?.postMessage({ type, ...payload }, location.origin);
    } catch {
      // The opener may have been closed or isolated.
    }
  }

  function setStatus(status) {
    const text = status || 'running';
    refs.status.textContent = text;
    refs.status.dataset.state = text;
  }

  function appendLog(message) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    refs.log.textContent = `${refs.log.textContent}\n${time} ${message}`.trim();
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function renderJob(job) {
    if (!job) return;
    refs.jobId.textContent = job.id || '-';
    refs.pid.textContent = job.pid || '-';
    setStatus(job.status || 'running');
    refs.focusBtn.disabled = !job.id || !job.pid;
    const output = [job.stdout, job.stderr].filter(Boolean).join('\n').trim();
    if (output) {
      refs.log.textContent = output.slice(-5000);
      refs.log.scrollTop = refs.log.scrollHeight;
    }
  }

  async function focusRunnerWindow() {
    if (!state.job?.id) return;
    const result = await apiRequest('POST', `/runner/jobs/${encodeURIComponent(state.job.id)}/focus`, {});
    appendLog(`已请求定位 Runner 窗口 pid=${result.pid || '-'}`);
    postToOpener('CUECAST_RUNNER_JOB_LOG', {
      kind: 'out',
      title: 'runner focus requested',
      detail: `${state.job.id} pid=${result.pid || '-'}`,
    });
  }

  async function refreshJob() {
    if (!state.job?.id) return null;
    state.job = await apiRequest('GET', `/runner/jobs/${encodeURIComponent(state.job.id)}`);
    renderJob(state.job);
    return state.job;
  }

  async function pollJob() {
    if (state.polling) return;
    state.polling = true;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 500 : 1000));
      const job = await refreshJob();
      if (!job || !['queued', 'running'].includes(job.status)) {
        postToOpener('CUECAST_RUNNER_JOB_DONE', { job });
        appendLog(`Runner 已结束: ${job?.status || 'unknown'}`);
        state.polling = false;
        return;
      }
    }
    state.polling = false;
    appendLog('Runner job polling timed out');
  }

  async function startRunner() {
    refs.caseId.textContent = state.caseId;
    refs.mode.textContent = state.headed ? 'headed' : 'headless';
    refs.caseLink.href = `/testcases/${encodeURIComponent(state.caseId)}`;
    setStatus('starting');
    state.job = await apiRequest('POST', '/runner/jobs', {
      case_id: Number(state.caseId) || state.caseId,
      api_base: state.apiBase,
      headed: state.headed,
      slow_mo: state.headed ? state.slowMo : 0,
      finish_delay: state.headed ? state.finishDelay : 0,
      trace: 'retain-on-failure',
      video: 'retain-on-failure',
    });
    renderJob(state.job);
    appendLog(`Runner job started: ${state.job.id}`);
    postToOpener('CUECAST_RUNNER_JOB_STARTED', { job: state.job });
    appendLog('如果 Chromium 没有切到前台，请点击任务栏中的 Runner Chromium 图标。');
    pollJob().catch((error) => {
      setStatus('failed');
      appendLog(error.message || String(error));
    });
  }

  refs.focusBtn.addEventListener('click', () => {
    focusRunnerWindow().catch((error) => appendLog(`定位失败: ${error.message}。请点击任务栏中的 Runner Chromium 图标。`));
  });
  refs.refreshBtn.addEventListener('click', () => {
    refreshJob().catch((error) => appendLog(`刷新失败: ${error.message}`));
  });

  startRunner().catch((error) => {
    setStatus('failed');
    appendLog(error.message || String(error));
  });
})();
