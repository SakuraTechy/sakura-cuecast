export class RunnerRunContext {
  constructor(config, onInvalidate) {
    this.config = { ...config };
    this.onInvalidate = onInvalidate;
    this.invalidated = false;
    this.completionStarted = false;
    this.invalidation = null;
  }

  async update(config, reason = 'Runner 所属实例或组织已切换') {
    if (config.apiBase !== this.config.apiBase || config.runnerId !== this.config.runnerId
      || (config.organizationUuid && this.config.organizationUuid
        && config.organizationUuid !== this.config.organizationUuid)) {
      return this.invalidate(reason);
    }
    // Re-registering the same Runner rotates its credential. A refreshed page
    // login must also be usable by a run that was already claimed.
    this.config.token = config.token;
    this.config.platformAuthToken = config.platformAuthToken;
    this.config.organizationUuid = config.organizationUuid || this.config.organizationUuid;
    return null;
  }

  invalidate(reason) {
    if (this.invalidation) return this.invalidation;
    this.invalidated = true;
    if (this.completionStarted) return Promise.resolve();
    this.completionStarted = true;
    this.invalidation = Promise.resolve().then(() => this.onInvalidate(reason));
    return this.invalidation;
  }

  beginCompletion() {
    if (this.completionStarted) return false;
    this.completionStarted = true;
    return true;
  }
}

export function normalizeRunnerCaseResult(result) {
  if (!result?.resultSaveError) return result;
  const saveMessage = `用例结果保存失败：${result.resultSaveError}`;
  const message = result.ok === false && result.error
    ? `${result.error}；${saveMessage}`
    : saveMessage;
  return { ...result, ok: false, error: message, message };
}
