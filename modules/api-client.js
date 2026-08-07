/**
 * API 客户端：封装与中台后端的通信
 */
export class ApiClient {
  constructor(getBase, getToken) {
    this._getBase = getBase;
    this._getToken = getToken || (() => '');
  }

  get base() { return this._getBase(); }

  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] 超时后 Abort，抛出「请求超时（Nms）」
   */
  async request(method, path, body, opts = {}) {
    const { timeoutMs, executionCapability } = opts;
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    let timer;
    if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    const headers = { 'Content-Type': 'application/json' };
    const token = this._getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (executionCapability) headers['X-Execution-Capability'] = executionCapability;
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body != null ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        data = { message: text };
      }
      const hasCode = data && data.code !== undefined && data.code !== null;
      const hasSuccessFlag = data && data.success !== undefined && data.success !== null;
      const normalizedCode = hasCode ? Number(data.code) : null;
      const okByCode = !hasCode || normalizedCode === 0 || normalizedCode === 200;
      const explicitFailure = data?.success === false || !okByCode;
      const hasErrorMessage = data && typeof data === 'object'
        && ['message', 'msg', 'error'].some((key) => Boolean(data[key]));
      const acceptedByHttp = res.ok && !hasCode && !hasSuccessFlag && !hasErrorMessage;
      const acceptedByEnvelope = (hasCode && okByCode) || (hasSuccessFlag && data.success === true);
      if (!res.ok || (!acceptedByEnvelope && !acceptedByHttp) || explicitFailure) {
        const message = data.message || data.msg || data.error || text || '请求失败';
        throw new Error(`HTTP ${res.status} ${method} ${url}: ${message}`);
      }
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getTestCase(id) { return this.request('GET', `/testcases/${id}?raw_values=1`); }
  // 扩展 CDP 回放直接读取 admin 的统一 caseKey，避免在扩展侧重组 CaseDO/StepDO。
  getAdminPlaywrightCase(caseKey, projectEnvironmentId, batchId = '', executionCapability = '') {
    const query = new URLSearchParams();
    if (projectEnvironmentId != null && String(projectEnvironmentId).trim() !== '') {
      query.set('projectEnvironmentId', projectEnvironmentId);
    }
    if (batchId) query.set('batchId', batchId);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request('GET', `/automation/playwright/testcases/${encodeAdminCasePath(caseKey)}${suffix}`, null, {
      executionCapability,
    });
  }
  saveSteps(id, steps) { return this.request('POST', `/testcases/${id}/steps`, { steps }); }
  importRecording(payload) {
    return this.request('POST', '/automation/automationUiScene/recordings/import', payload, { timeoutMs: 60000 });
  }
  /**
   * 保存执行结果（30s 超时 + 1 次重试），避免大 payload 间歇性失败导致结果丢失。
   * 仅对超时和网络错误重试，业务错误（code !== 0）不重试。
   */
  async saveResult(id, result) {
    const maxAttempts = 2;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.request('POST', `/testcases/${id}/results`, result, { timeoutMs: 30000 });
      } catch (e) {
        lastError = e;
        const msg = String(e?.message || '');
        if (msg.includes('超时') || msg.includes('fetch') || msg.includes('Network') || msg.includes('abort')) {
          if (attempt < maxAttempts) {
            console.warn('[api-client] saveResult 第 %d 次失败，%d ms 后重试：%s', attempt, 500, msg.slice(0, 120));
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
        }
        throw lastError;
      }
    }
    throw lastError;
  }
  /**
   * 自然语言步骤：instruction + 页面结构 → 操作计划
   * @param {{ debug?: boolean, timeoutMs?: number }} opts debug=true 时请求 ?debug=1；默认 100s 超时
   */
  aiStepPlan(body, opts = {}) {
    const q = opts.debug ? '?debug=1' : '';
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 100000;
    return this.request('POST', `/ai/step-plan${q}`, body, { timeoutMs });
  }

  /**
   * JSON 断言：页面采集的 actual 与步骤中预存 value 在后端原样比对（大 JSON 可设长超时）
   */
  assertJson(caseId, body, opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 120000;
    return this.request('POST', `/testcases/${caseId}/assert-json`, body, { timeoutMs });
  }

  // admin 结果接口与旧 CueCast mock 结果接口分开，保留两条协议的兼容性。
  saveAdminPlaywrightResult(caseKey, result, executionCapability = '') {
    return this.request(
      'POST',
      `/automation/playwright/testcases/${encodeURIComponent(caseKey)}/results`,
      result,
      { timeoutMs: 30000, executionCapability },
    );
  }

  /**
   * 基础设施步骤只提交已冻结用例中的步骤身份；命令、SQL 和凭据始终由 admin/执行节点解析。
   */
  createInfrastructureTask(payload, executionCapability = '') {
    return this.request('POST', '/automation/infrastructure/tasks', payload, {
      timeoutMs: 30000,
      executionCapability,
    });
  }

  getInfrastructureTask(taskId, afterSequence = 0, executionCapability = '') {
    const query = afterSequence > 0 ? `?afterSequence=${encodeURIComponent(afterSequence)}` : '';
    return this.request('GET', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}${query}`, null, {
      timeoutMs: 30000,
      executionCapability,
    });
  }

  cancelInfrastructureTask(taskId, executionCapability = '') {
    return this.request('DELETE', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}`, null, {
      timeoutMs: 30000,
      executionCapability,
    });
  }

  /**
   * 上报 CueCast 当前真实可执行的 canonical action。
   * 旧 Admin 没有该接口时由 PlayerManager 捕获异常并继续回放。
   */
  registerOperationCapabilities(capabilities) {
    const payload = {
      executor_instance_id: capabilities?.executorInstanceId,
      executor_version: capabilities?.executorVersion,
      catalog_version: capabilities?.catalogVersion,
      project_environment_id: capabilities?.projectEnvironmentId,
      session_id: capabilities?.sessionId,
      actions: capabilities?.actions,
      features: capabilities?.features || [],
    };
    return this.request('POST', '/automation/operation-catalog/capabilities/cuecast', payload, { timeoutMs: 5000 });
  }
}

function encodeAdminCasePath(caseKey) {
  const parts = String(caseKey ?? '').split(':');
  if (parts.length < 2) return encodeURIComponent(caseKey);
  const sceneKey = parts.shift();
  return `${encodeURIComponent(sceneKey)}/${encodeURIComponent(parts.join(':'))}`;
}
