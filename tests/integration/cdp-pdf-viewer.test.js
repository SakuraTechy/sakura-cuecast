import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 复用工作区 Runner 的浏览器测试依赖；实际断言仍由扩展 chrome.debugger 执行。
const { chromium } = createRequire(new URL('../../../sakura-playwright/package.json', import.meta.url))('playwright');
const extensionRoot = path.resolve(import.meta.dirname, '../..');

test('真实扩展 CDP 在有头和无头模式完成 PDF 八步回放与失败反例', { timeout: 120000 }, async (t) => {
  const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cuecast-cdp-pdf-'));
  t.diagnostic(`验证产物：${artifactsRoot}`);
  const fixtureBrowser = await chromium.launch({ channel: 'chromium', headless: true });
  t.after(() => fixtureBrowser.close());
  const fixturePage = await fixtureBrowser.newPage();
  await fixturePage.setContent('<h1>CueCast CDP PDF regression</h1><p>This is the help manual.</p>');
  const pdf = await fixturePage.pdf();
  const serverErrors = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(fixtureHtml(pdf));
    } else if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
    } else {
      // 未知路径不能返回成功，避免测试在空页面上假通过。
      serverErrors.push(request.url);
      response.writeHead(404);
      response.end('Unknown fixture request');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;

  for (const headed of [false, true]) {
    await t.test(headed ? 'headed' : 'headless', { timeout: 55000 }, async (modeTest) => {
      const context = await chromium.launchPersistentContext('', {
        channel: 'chromium', headless: !headed,
        args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
      });
      modeTest.after(() => context.close());
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const control = await context.newPage();
      await control.goto(new URL('popup/popup.html', worker.url()).href);
      const report = await control.evaluate(runExtensionCase, fixtureUrl);
      const modeDir = path.join(artifactsRoot, headed ? 'headed' : 'headless');
      await fs.mkdir(modeDir);
      const { frames, ...result } = report;
      await fs.writeFile(path.join(modeDir, 'result.json'), JSON.stringify(result, null, 2));
      for (const frame of frames) {
        await fs.writeFile(path.join(modeDir, `step-${frame.step}.jpg`), Buffer.from(frame.data, 'base64'));
      }
      assert.equal(result.fatalError, undefined, result.fatalError);
      assert.equal(result.steps.length, 8);
      assert.ok(result.steps.every((step) => step.status === 'passed'));
      const assertion = result.steps[7];
      assert.equal(assertion.locator_source, 'pdf_viewer_frame');
      assert.equal(assertion.details.operation.executor, 'extension-cdp');
      assert.equal(assertion.details.operation.outcome.assertion.actual.preview, 'application/x-google-chrome-pdf');
      assert.equal(assertion.details.operation.summary, '属性检查通过');
      assert.equal(result.originalStepPreserved, true);
      assert.equal(result.mainSessionStillAttached, true);
      assert.equal(result.childSessionsReleased, true);
      assert.equal(result.wrongExpected.status, 'failed');
      assert.equal(result.wrongExpected.details.operation.summary, '属性检查失败');
      assert.equal(result.wrongExpected.details.operation.outcome.assertion.actual.preview, 'application/x-google-chrome-pdf');
      assert.equal(result.otherTab.status, 'failed');
      assert.equal(result.otherTab.details.operation.summary, '属性检查失败');
      assert.deepEqual(result.otherTab.details.operation.outcome.assertion.actual, { value_state: 'unavailable' });
      assert.equal(result.delayedFrame.operationAssertion.actual.preview, 'application/x-google-chrome-pdf');
      assert.deepEqual(frames.map((frame) => frame.step), [6, 7, 8]);
      assert.ok(result.steps[6].duration_ms >= 3000 && result.steps[6].duration_ms < 5000);
      modeTest.diagnostic(`八步回放通过，切页=${result.steps[5].duration_ms}ms，等待=${result.steps[6].duration_ms}ms，属性断言=${assertion.duration_ms}ms`);
    });
  }
  assert.deepEqual(serverErrors, []);
});

function fixtureHtml(pdf) {
  return `<!doctype html><html><body style="background:#803070;color:white">
    <form><label>用户<input id="user"></label><label>密码<input id="password" type="password"></label><button id="login">登录</button></form>
    <button id="help" hidden>帮助手册</button>
    <script>
      document.querySelector('form').onsubmit = (event) => {
        event.preventDefault();
        if (document.querySelector('#user').value === 'local-user' && document.querySelector('#password').value === 'local-password') {
          document.querySelector('form').hidden = true;
          document.querySelector('#help').hidden = false;
        }
      };
      document.querySelector('#help').onclick = () => {
        const bytes = Uint8Array.from(atob('${pdf.toString('base64')}'), character => character.charCodeAt(0));
        window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), '_blank');
      };
    </script></body></html>`;
}

async function runExtensionCase(fixtureUrl) {
  const { PlayerManager } = await import(chrome.runtime.getURL('modules/player-manager.js'));
  const { attachOperationDiagnostic } = await import(chrome.runtime.getURL('modules/operation-diagnostics.js'));
  const manager = new PlayerManager({}, {});
  const tab = await chrome.tabs.create({ url: fixtureUrl, active: true });
  await manager._waitForTabLoad(tab.id);
  const ctx = {
    testCaseId: 'local-cdp-pdf', tabId: tab.id, activeTabId: tab.id,
    initialManagedTabId: tab.id, managedTabIds: new Set([tab.id]),
    debuggerAttached: false, pageErrorCheckEnabled: false,
  };
  const report = { steps: [], frames: [] };
  const attachedSessions = new Set();
  const onEvent = (source, method, params) => {
    if (!ctx.managedTabIds.has(source.tabId)) return;
    if (method === 'Target.attachedToTarget') attachedSessions.add(params.sessionId);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  const pdfStep = {
    action_type: 'assert_attribute',
    target_xpath: "//embed[@type='application/x-google-chrome-pdf']",
    attribute: 'type', expect: 'application/x-google-chrome-pdf',
    locator_meta: { candidates: [{ type: 'xpath_fallback', value: "//embed[@type='application/x-google-chrome-pdf']" }] },
  };
  const originalStep = JSON.stringify(pdfStep);
  const steps = [
    { action_type: 'input', target_selector: '#user', value: 'local-user' },
    { action_type: 'key', value: 'Tab' },
    { action_type: 'input', target_selector: '#password', value: 'local-password' },
    { action_type: 'click', target_selector: '#login' },
    { action_type: 'click', target_selector: '#help' },
    { action_type: 'switch_page', value: '' },
    { action_type: 'wait', duration_ms: 3000 },
    pdfStep,
  ];
  const failedAssertion = async (step) => {
    try {
      await manager._executeStepCDP(ctx.tabId, step);
      return { status: 'passed' };
    } catch (error) {
      return attachOperationDiagnostic({
        action_type: step.action_type, status: 'failed', error: error.message,
        operation_assertion: error.operationAssertion,
      }, step);
    }
  };
  try {
    if (!await manager._attachDebugger(tab.id, ctx)) throw new Error(ctx.cdpAttachError);
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const started = Date.now();
      manager._stepTimeoutMsByTab.set(ctx.tabId, 5000);
      let locator;
      if (step.action_type === 'switch_page') {
        await manager._executeManagedTabAction(ctx.tabId, step, ctx, { cdpAvailable: true, useAdminCase: true });
      } else if (step.action_type === 'wait') {
        await manager._waitWithCountdown(step.duration_ms);
      } else {
        locator = await manager._executeStepCDP(ctx.tabId, step);
      }
      report.steps.push(attachOperationDiagnostic({
        step_index: index, action_type: step.action_type, status: 'passed', duration_ms: Date.now() - started,
        ...(locator?.source ? { locator_source: locator.source } : {}),
        ...(locator?.operationAssertion ? { operation_assertion: locator.operationAssertion } : {}),
      }, step));
      if (index >= 5) {
        // 截图仅写入临时产物文件，不进入 caseList 或原始 playwright_step。
        const screenshot = await manager._cdpSend(ctx.tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 75 });
        report.frames.push({ step: index + 1, data: screenshot.data });
      }
    }
    report.originalStepPreserved = JSON.stringify(pdfStep) === originalStep;
    report.mainSessionStillAttached = Boolean((await manager._cdpSend(ctx.tabId, 'Runtime.evaluate', {
      expression: 'document.URL', returnByValue: true,
    })).result?.value);
    // Chrome 只通知直接子会话脱离；通过真实命令确认所有后代会话均已失效。
    report.childSessionsReleased = attachedSessions.size > 0;
    for (const sessionId of attachedSessions) {
      try {
        await manager._cdpSend(ctx.tabId, 'DOM.getDocument', { depth: 0 }, { sessionId, timeoutMs: 1000 });
        report.childSessionsReleased = false;
      } catch (error) {
        if (!/Session with given id not found/i.test(error.message)) throw error;
      }
    }
    report.wrongExpected = await failedAssertion({ ...pdfStep, expect: 'wrong' });

    // PDF 仍在另一个标签页打开，当前普通页面不得借用该 PDF 让断言通过。
    await manager._activateManagedTab(tab.id, ctx, { cdpAvailable: true, useAdminCase: true });
    manager._stepTimeoutMsByTab.set(ctx.tabId, 350);
    report.otherTab = await failedAssertion(pdfStep);

    await manager._cdpSend(ctx.tabId, 'Runtime.evaluate', {
      expression: `setTimeout(() => {
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        const host = frame.contentDocument.createElement('div');
        frame.contentDocument.body.appendChild(host);
        host.attachShadow({ mode: 'closed' }).innerHTML = '<embed type="application/x-google-chrome-pdf">';
      }, 250)`,
    });
    manager._stepTimeoutMsByTab.set(ctx.tabId, 3000);
    report.delayedFrame = await manager._executeStepCDP(ctx.tabId, pdfStep);
  } catch (error) {
    report.fatalError = `${error.message}\n${error.stack || ''}`;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await manager._detachDebugger(ctx.tabId, ctx).catch(() => {});
  }
  return report;
}
