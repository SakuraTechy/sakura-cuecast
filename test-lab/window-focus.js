const { spawn } = require('child_process');
const path = require('path');

const focusScript = path.join(__dirname, 'focus-window.ps1');

function isTruthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function focusProcessTreeWindows(rootPid, options = {}) {
  if (process.platform !== 'win32' || !rootPid) return;
  const attempts = Array.isArray(options.attempts) && options.attempts.length
    ? options.attempts
    : [500, 1100, 2000, 3600, 6000];
  let focused = false;

  function runAttempt(index) {
    if (focused || index >= attempts.length) return;
    const delayMs = Math.max(0, Number(attempts[index]) || 0);
    const timer = setTimeout(() => {
      if (focused) return;
      let sawOutput = false;
      let foundWindow = false;
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        focusScript,
        '-RootPid',
        String(rootPid),
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        sawOutput = true;
        options.onOutput?.(`[runner-focus] ${text}\n`);
        if (/focused\s+[1-9]\d*\s+window/i.test(text)) {
          foundWindow = true;
        }
      });
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) options.onOutput?.(`[runner-focus] ${text}\n`);
      });
      child.on('close', () => {
        if (foundWindow) {
          focused = true;
          return;
        }
        if (sawOutput || index < attempts.length - 1) runAttempt(index + 1);
      });
      child.unref();
    }, delayMs);
    timer.unref?.();
  }

  runAttempt(0);
}

module.exports = {
  focusProcessTreeWindows,
  isTruthy,
};
