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
    const { timeoutMs } = opts;
    const url = `${this.base}${path}`;
    const controller = new AbortController();
    let timer;
    if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    const headers = { 'Content-Type': 'application/json' };
    const token = this._getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body != null ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.code !== 0) throw new Error(data.message || '请求失败');
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
  saveSteps(id, steps) { return this.request('POST', `/testcases/${id}/steps`, { steps }); }
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
}
