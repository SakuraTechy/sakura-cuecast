// Maximize background playback windows when Chrome permits it. A window-size
// preference must not prevent a case from starting or steal another app's focus.
export async function ensurePlaybackWindowMaximized(windowId, { settleMs = 100 } = {}) {
  const id = Number(windowId);
  if (!Number.isInteger(id) || id < 0) throw new Error('无效的回放窗口 ID');

  const readWindow = () => chrome.windows.get(id).catch(() => null);
  let windowInfo = await readWindow();
  if (!windowInfo) throw new Error('回放窗口已关闭，无法设置最大化');
  if (windowInfo.state === 'maximized') return windowInfo;

  let directError = null;
  try {
    await chrome.windows.update(id, { state: 'maximized' });
  } catch (error) {
    directError = error;
  }
  windowInfo = await readWindow();
  if (windowInfo?.state === 'maximized') return windowInfo;
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  windowInfo = await readWindow();
  if (windowInfo?.state === 'maximized') return windowInfo;
  if (!windowInfo) throw new Error('回放窗口已关闭，无法设置最大化');

  // Some desktop builds only apply maximize after the target gets focus.
  // Restore the previously focused Chrome window immediately afterward.
  const previous = await chrome.windows.getLastFocused().catch(() => null);
  const restoreId = previous?.focused === true && previous.id !== id ? previous.id : null;
  if (!windowInfo.focused && restoreId == null) {
    console.warn('[CueCast playback] background maximize unavailable; continuing at current window size:', directError?.message || 'Chrome did not apply maximized state');
    return windowInfo;
  }
  let recoveryError = null;
  try {
    await chrome.windows.update(id, { state: 'maximized', focused: true });
  } catch (error) {
    recoveryError = error;
  } finally {
    if (restoreId != null) {
      await chrome.windows.update(restoreId, { focused: true }).catch((error) => {
        console.warn('[CueCast playback] could not restore previous Chrome window focus:', error?.message || error);
      });
    }
  }
  windowInfo = await readWindow();
  if (!windowInfo) throw new Error('回放窗口已关闭，无法设置最大化');
  if (windowInfo.state !== 'maximized') console.warn('[CueCast playback] maximize unavailable; continuing at current window size:', recoveryError?.message || 'Chrome still reports a normal window');
  return windowInfo;
}
