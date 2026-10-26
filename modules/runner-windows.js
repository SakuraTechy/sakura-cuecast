const STORAGE_KEY = 'cc-runner-active-windows-v1';

export class RunnerWindowRegistry {
  constructor(storage, windowsApi) {
    this.storage = storage;
    this.windowsApi = windowsApi;
  }

  async track(runId, windowId, tabId) {
    if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
      throw new Error('Runner 执行窗口未正确创建');
    }
    const stored = await this.storage.get(STORAGE_KEY);
    const windows = stored[STORAGE_KEY] || {};
    windows[runId] = [...(windows[runId] || []).filter((item) => Number(item.windowId) !== windowId),
      { windowId, tabId }];
    await this.storage.set({ [STORAGE_KEY]: windows });
  }

  async close(runId) {
    const stored = await this.storage.get(STORAGE_KEY);
    const windows = stored[STORAGE_KEY] || {};
    const owned = windows[runId] || [];
    await Promise.all(owned.map(async ({ windowId }) => {
      try {
        await this.windowsApi.get(windowId);
      } catch (error) {
        if (/No window with id/i.test(String(error?.message || error))) return;
        throw error;
      }
      await this.windowsApi.remove(windowId);
    }));
    delete windows[runId];
    await this.storage.set({ [STORAGE_KEY]: windows });
  }

  async clearAll() {
    await this.storage.set({ [STORAGE_KEY]: {} });
  }
}
