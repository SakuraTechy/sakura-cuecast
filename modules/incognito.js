export async function inspectIncognitoAvailability() {
  const allowed = await new Promise((resolve) => {
    try {
      chrome.extension.isAllowedIncognitoAccess((result) => resolve(result === true));
    } catch {
      resolve(false);
    }
  });
  if (!allowed) return { allowed: false, existingWindowCount: 0 };

  const windows = await chrome.windows.getAll({ populate: false }).catch(() => []);
  return {
    allowed: true,
    existingWindowCount: windows.filter((win) => win?.incognito === true).length,
  };
}
