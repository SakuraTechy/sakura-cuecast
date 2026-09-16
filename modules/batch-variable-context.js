import { CuecastVariableContext } from './variable-context.js';

/** 批次对象由后台鉴权后的会话管理器持有；原始快照不进入中台网页、日志或 chrome.storage。 */
export class BatchVariableContexts {
  constructor() {
    this._batches = new WeakMap();
  }

  beginCase(batch, { sceneKey, projectEnvironmentId }, initialValues = {}) {
    if (!batch || !batch.batchId || !sceneKey || projectEnvironmentId == null || projectEnvironmentId === '') {
      throw new Error('CDP 场景变量共享缺少受控批次、场景或产品环境');
    }
    let state = this._batches.get(batch);
    if (!state) {
      state = { snapshots: new Map(), active: null };
      this._batches.set(batch, state);
    }
    if (state.active) throw new Error('同一 CDP 批次必须等待前一用例结束后再共享变量');
    const scopeKey = JSON.stringify([String(sceneKey), String(projectEnvironmentId)]);
    const context = new CuecastVariableContext(initialValues);
    context.restore(state.snapshots.get(scopeKey) || []);
    const session = { batch, scopeKey, context };
    state.active = session;
    return session;
  }

  finishCase(session, success) {
    if (!session) return;
    const state = this._batches.get(session.batch);
    // 批次已清理或旧用例迟到时，不能重新建立状态或覆盖下一用例的变量。
    if (!state || state.active !== session) return;
    try {
      if (success) state.snapshots.set(session.scopeKey, session.context.snapshot());
    } finally {
      state.active = null;
    }
  }

  clearBatch(batch) {
    if (batch) this._batches.delete(batch);
  }
}
