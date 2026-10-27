const AGENT_REF_ATTRIBUTE = 'data-cuecast-agent-ref';

async function executeInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  const value = results?.[0]?.result;
  if (value?.error) {
    const error = new Error(value.error);
    error.details = value.details || null;
    throw error;
  }
  return value;
}

export async function snapshotRecordingPage(tabId, recordingId, commandId, options = {}) {
  return executeInTab(tabId, (attribute, refPrefix, snapshotOptions) => {
    const normalize = (value, max = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const comparable = (value) => normalize(value, 500).toLocaleLowerCase();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
        && rect.width > 1 && rect.height > 1;
    };
    document.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute));
    const selectors = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
      '[contenteditable="true"]', '[onclick]', 'label', 'h1', 'h2', 'h3', '[aria-label]', '[data-testid]',
    ].join(',');
    const maxElements = Math.min(100, Math.max(10, Number(snapshotOptions?.max_elements) || 50));
    const requestedPageText = snapshotOptions?.max_page_text;
    const maxPageText = requestedPageText === undefined
      ? 1500
      : Math.min(5000, Math.max(0, Number(requestedPageText) || 0));
    const query = normalize(snapshotOptions?.query, 500);
    const queryTerms = comparable(query).split(/\s+/).filter((term) => term.length > 1);
    const elements = [...new Set(document.querySelectorAll(selectors))]
      .filter((element) => !element.closest('#__at_toolbar__,#__at_variable_dialog__,#__at_assertion_dialog__'))
      .filter(visible);
    const labelFor = (element) => {
      if (element.labels?.length) return normalize([...element.labels].map((label) => label.innerText || label.textContent).join(' '), 200);
      const id = element.getAttribute('id');
      if (id) {
        const label = [...document.querySelectorAll('label[for]')].find((candidate) => candidate.htmlFor === id);
        if (label) return normalize(label.innerText || label.textContent, 200);
      }
      return normalize(element.closest('label')?.innerText || '', 200);
    };
    const ranked = elements.map((element, sourceIndex) => {
      const label = labelFor(element);
      const haystack = comparable([
        element.innerText, element.textContent, element.getAttribute('aria-label'),
        element.getAttribute('placeholder'), element.getAttribute('name'),
        element.getAttribute('data-testid'), label,
      ].filter(Boolean).join(' '));
      const score = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { element, label, score, sourceIndex };
    }).sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
      .slice(0, maxElements);
    const items = ranked.map(({ element, label }, index) => {
      const ref = `${refPrefix}-${index + 1}`;
      element.setAttribute(attribute, ref);
      const rect = element.getBoundingClientRect();
      const inputType = element instanceof HTMLInputElement ? String(element.type || 'text').toLowerCase() : '';
      const safeValue = inputType === 'password' ? '' : normalize(element.value, 200);
      return {
        ref,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        type: inputType,
        text: normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('placeholder')),
        label,
        name: normalize(element.getAttribute('name'), 120),
        aria_label: normalize(element.getAttribute('aria-label'), 200),
        placeholder: normalize(element.getAttribute('placeholder'), 200),
        value: safeValue,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      elements: items,
      page_text: maxPageText ? normalize(document.body?.innerText, maxPageText) : '',
      query,
      limitations: document.querySelectorAll('iframe').length ? ['iframe content is not included in this MVP snapshot'] : [],
    };
  }, [AGENT_REF_ATTRIBUTE, `${String(recordingId).slice(-10)}-${String(commandId).slice(-10)}`, options]);
}

async function resolveRef(tabId, ref) {
  return executeInTab(tabId, (attribute, targetRef) => {
    const element = [...document.querySelectorAll(`[${attribute}]`)].find((candidate) => candidate.getAttribute(attribute) === targetRef);
    if (!element) return { error: '页面中找不到该 ref；页面可能已变化，请重新调用 browser_snapshot' };
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return { error: 'ref 对应元素当前不可见，请重新获取页面快照' };
    const centerX = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const centerY = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(centerX, centerY);
    if (!hit || (hit !== element && !element.contains(hit))) {
      return { error: 'ref 对应元素被其他内容遮挡，请等待页面稳定或重新获取页面快照' };
    }
    const cssEscape = (value) => {
      if (globalThis.CSS?.escape) return CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0).toString(16)} `);
    };
    const uniqueCss = (node) => {
      if (node.id) {
        const selector = `#${cssEscape(node.id)}`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
      const testId = node.getAttribute('data-testid');
      if (testId) {
        const selector = `[data-testid="${String(testId).replace(/["\\]/g, '\\$&')}"]`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
      const parts = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const peers = [...parent.children].filter((child) => child.tagName === current.tagName);
          if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        const selector = parts.join(' > ');
        if (document.querySelectorAll(selector).length === 1) return selector;
        current = parent;
      }
      return parts.join(' > ');
    };
    const xpath = (node) => {
      if (node.id) return `//*[@id=${JSON.stringify(node.id)}]`;
      const parts = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName)
          : [];
        const index = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${index}`);
        current = current.parentElement;
      }
      return `/${parts.join('/')}`;
    };
    return {
      x: centerX,
      y: centerY,
      selector: uniqueCss(element),
      xpath: xpath(element),
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      url: location.href,
    };
  }, [AGENT_REF_ATTRIBUTE, String(ref || '')]);
}

async function resolveSemanticTarget(tabId, target, action, timeoutMs = 10000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await executeInTab(tabId, (requestedTarget, requestedAction) => {
        const normalize = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        const comparable = (value) => normalize(value).toLocaleLowerCase();
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
            && rect.width > 1 && rect.height > 1;
        };
        const cssEscape = (value) => {
          if (globalThis.CSS?.escape) return CSS.escape(value);
          return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0).toString(16)} `);
        };
        const uniqueCss = (node) => {
          if (node.id) {
            const selector = `#${cssEscape(node.id)}`;
            if (document.querySelectorAll(selector).length === 1) return selector;
          }
          const testId = node.getAttribute('data-testid');
          if (testId) {
            const selector = `[data-testid="${String(testId).replace(/["\\]/g, '\\$&')}"]`;
            if (document.querySelectorAll(selector).length === 1) return selector;
          }
          const parts = [];
          let current = node;
          while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (parent) {
              const peers = [...parent.children].filter((child) => child.tagName === current.tagName);
              if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
            }
            parts.unshift(part);
            const selector = parts.join(' > ');
            if (document.querySelectorAll(selector).length === 1) return selector;
            current = parent;
          }
          return parts.join(' > ');
        };
        const xpath = (node) => {
          if (node.id) return `//*[@id=${JSON.stringify(node.id)}]`;
          const parts = [];
          let current = node;
          while (current && current.nodeType === Node.ELEMENT_NODE) {
            const siblings = current.parentElement
              ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName)
              : [];
            const index = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : '';
            parts.unshift(`${current.tagName.toLowerCase()}${index}`);
            current = current.parentElement;
          }
          return `/${parts.join('/')}`;
        };
        const labelFor = (element) => {
          if (element.labels?.length) return normalize([...element.labels].map((label) => label.innerText || label.textContent).join(' '), 200);
          const id = element.getAttribute('id');
          if (id) {
            const label = [...document.querySelectorAll('label[for]')].find((candidate) => candidate.htmlFor === id);
            if (label) return normalize(label.innerText || label.textContent, 200);
          }
          return normalize(element.closest('label')?.innerText || '', 200);
        };
        const roleFor = (element) => {
          const explicit = normalize(element.getAttribute('role'), 100);
          if (explicit) return explicit;
          const tag = element.tagName.toLowerCase();
          const type = normalize(element.getAttribute('type'), 50).toLowerCase();
          if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
          if (tag === 'a' && element.hasAttribute('href')) return 'link';
          if (tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type))) return 'textbox';
          if (tag === 'select') return 'combobox';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return '';
        };
        const describe = (element) => {
          element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const rect = element.getBoundingClientRect();
          const label = labelFor(element);
          const text = normalize(element.innerText || element.textContent || element.getAttribute('value'), 200);
          const name = normalize(element.getAttribute('aria-label') || label || text || element.getAttribute('placeholder'), 200);
          const point = {
            x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
            y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
          };
          const hit = document.elementFromPoint(point.x, point.y);
          if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
            return { error: '语义目标当前不可操作', details: { reason: 'target_disabled', candidate: { role: roleFor(element), name, text, label } } };
          }
          if (!hit || (hit !== element && !element.contains(hit))) {
            return { error: '语义目标被其他内容遮挡', details: { reason: 'target_obscured', candidate: { role: roleFor(element), name, text, label } } };
          }
          return {
            ...point,
            selector: uniqueCss(element),
            xpath: xpath(element),
            tag: element.tagName.toLowerCase(),
            text,
            url: location.href,
            summary: { role: roleFor(element), name, text, label },
          };
        };

        if (requestedTarget.selector) {
          try {
            const matches = [...document.querySelectorAll(requestedTarget.selector)].filter(visible);
            if (matches.length === 1) return describe(matches[0]);
            if (matches.length > 1) return { error: '语义目标 selector 匹配到多个可见元素', details: { reason: 'ambiguous_target', count: matches.length } };
          } catch {
            return { error: '语义目标 selector 无效', details: { reason: 'invalid_selector' } };
          }
        }

        const selectors = requestedAction === 'input'
          ? 'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]'
          : 'a[href],button,input,textarea,select,summary,[role],[contenteditable="true"],[onclick],[aria-label],[data-testid]';
        const candidates = [...new Set(document.querySelectorAll(selectors))]
          .filter((element) => !element.closest('#__at_toolbar__,#__at_variable_dialog__,#__at_assertion_dialog__'))
          .filter(visible)
          .map((element, sourceIndex) => {
            const label = labelFor(element);
            const text = normalize(element.innerText || element.textContent || element.getAttribute('value'), 200);
            const role = roleFor(element);
            const name = normalize(element.getAttribute('aria-label') || label || text || element.getAttribute('placeholder'), 200);
            const fields = {
              role,
              name,
              label,
              text,
              placeholder: normalize(element.getAttribute('placeholder'), 200),
              test_id: normalize(element.getAttribute('data-testid'), 200),
              name_attribute: normalize(element.getAttribute('name'), 200),
            };
            let score = 0;
            let compared = 0;
            let identityCompared = 0;
            let identityMatched = 0;
            for (const field of ['role', 'name', 'label', 'text', 'placeholder', 'test_id', 'name_attribute']) {
              const expected = comparable(requestedTarget[field]);
              if (!expected) continue;
              compared += 1;
              if (field !== 'role') identityCompared += 1;
              const actual = comparable(fields[field]);
              if (actual === expected) {
                score += field === 'role' ? 8 : 20;
                if (field !== 'role') identityMatched += 1;
              } else if (field !== 'role' && actual.includes(expected)) {
                score += 8;
                identityMatched += 1;
              }
              else if (field === 'role') score -= 100;
            }
            return { element, fields, score, compared, identityCompared, identityMatched, sourceIndex };
          })
          .filter((candidate) => candidate.compared > 0 && candidate.score > 0
            && (candidate.identityCompared === 0 || candidate.identityMatched > 0))
          .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex);
        if (!candidates.length) {
          return { error: '找不到语义目标', details: { reason: 'target_not_found', target: requestedTarget } };
        }
        const top = candidates[0];
        const tied = candidates.filter((candidate) => candidate.score === top.score);
        if (tied.length > 1) {
          return {
            error: '语义目标不唯一',
            details: {
              reason: 'ambiguous_target',
              candidates: tied.slice(0, 5).map((candidate) => candidate.fields),
            },
          };
        }
        return describe(top.element);
      }, [target || {}, action]);
    } catch (error) {
      lastError = error;
      if (error?.details?.reason === 'ambiguous_target' || error?.details?.reason === 'invalid_selector') throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('找不到语义目标');
}

async function withDebugger(tabId, action) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    return await action(target);
  } catch (error) {
    const message = String(error?.message || error || '');
    if (/already attached/i.test(message)) return action(target);
    throw error;
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function nativeClick(tabId, point) {
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  });
}

async function nativeReplaceInput(tabId, point, value) {
  const platform = await chrome.runtime.getPlatformInfo().catch(() => ({ os: '' }));
  const modifiers = platform?.os === 'mac' ? 4 : 2;
  await withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text: String(value ?? '') });
  });
}

function assertionStep(details, request) {
  const target = request.target === 'element' ? 'element' : 'page';
  const match = ['contains', 'equals', 'visible'].includes(request.match) ? request.match : 'contains';
  const expected = match === 'visible' ? '' : String(request.expected ?? '');
  const targetLabel = target === 'element' ? '元素' : '页面';
  const matchLabel = match === 'equals' ? '文本等于' : (match === 'visible' ? '可见' : '包含文本');
  const locatorMeta = {
    version: 1,
    candidates: target === 'element' && details?.selector ? [{ type: 'css', value: details.selector, score: 1 }] : [],
    context: {
      assertion: { target, match, source: target, preview: expected.trim().replace(/\s+/g, ' ').slice(0, 200) },
    },
    assertion: { target, match, wait_mode: 'eventually' },
  };
  return {
    action_type: 'assert_text',
    target_selector: target === 'element' ? details?.selector || '' : '',
    target_xpath: target === 'element' ? details?.xpath || '' : '',
    value: expected,
    value_text: expected,
    url: details?.url || '',
    description: `断言${targetLabel}${matchLabel}${expected ? `: "${expected.trim().replace(/\s+/g, ' ').slice(0, 50)}"` : ''}`,
    locator_meta: locatorMeta,
  };
}

function recordingRevision(recorder) {
  const steps = Array.isArray(recorder?.state?.recordedSteps) ? recorder.state.recordedSteps : [];
  const last = steps[steps.length - 1] || null;
  return `${steps.length}:${last?.timestamp || ''}:${last?.action_type || ''}:${last?.value || ''}`;
}

async function waitForRecorderCapture(recorder, previousRevision) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (recordingRevision(recorder) !== previousRevision) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('浏览器动作已发送，但录制器未捕获到可信事件；请重新获取快照后重试');
}

async function currentPageState(tabId) {
  return executeInTab(tabId, () => ({ url: location.href, title: document.title }));
}

async function waitForCondition(tabId, condition) {
  if (!condition) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return currentPageState(tabId);
  }
  const deadline = Date.now() + Math.min(30000, Math.max(1000, Number(condition.timeout_seconds || 10) * 1000));
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const state = await executeInTab(tabId, () => ({
        url: location.href,
        title: document.title,
        page_text: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000),
      }));
      lastState = state;
      const matches = (!condition.url_contains || state.url.includes(condition.url_contains))
        && (!condition.title_contains || state.title.includes(condition.title_contains))
        && (!condition.page_contains || state.page_text.includes(condition.page_contains))
        && (!condition.page_not_contains || !state.page_text.includes(condition.page_not_contains));
      if (matches) return { url: state.url, title: state.title };
    } catch {
      // Navigation can briefly make the page execution context unavailable.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const error = new Error('页面未在计划时间内达到预期状态');
  error.details = {
    reason: 'condition_timeout',
    expected: condition,
    actual: lastState ? { url: lastState.url, title: lastState.title } : null,
  };
  throw error;
}

async function verifyAssertion(tabId, details, step) {
  if (step.match === 'visible') return;
  const actual = await executeInTab(tabId, (selector, targetType) => {
    const source = targetType === 'element' ? document.querySelector(selector) : document.body;
    if (!source) return { error: '断言目标当前不存在', details: { reason: 'assertion_target_missing' } };
    return String(source.innerText || source.textContent || '').replace(/\s+/g, ' ').trim();
  }, [details?.selector || '', step.target_type]);
  const expected = String(step.expected || '');
  const passed = step.match === 'equals' ? actual === expected : actual.includes(expected);
  if (!passed) {
    const error = new Error('当前页面不满足计划中的业务断言');
    error.details = {
      reason: 'assertion_not_met',
      match: step.match,
      expected: expected.slice(0, 500),
      actual_preview: String(actual).slice(0, 500),
    };
    throw error;
  }
}

async function executeSemanticRecordingPlan({ steps, tabId, recorder, shouldStop }) {
  const completed = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (shouldStop?.()) {
      return { status: 'stopped', completed_steps: completed, next_step_index: index, ...(await currentPageState(tabId).catch(() => ({}))) };
    }
    try {
      if (step.wait_for && step.action === 'assert_text') await waitForCondition(tabId, step.wait_for);
      if (step.action === 'click' || step.action === 'input') {
        const timeoutMs = Number(step.wait_for?.timeout_seconds || 10) * 1000;
        const details = await resolveSemanticTarget(tabId, step.target, step.action, timeoutMs);
        const revision = recordingRevision(recorder);
        if (step.action === 'click') {
          await nativeClick(tabId, details);
          await waitForRecorderCapture(recorder, revision);
        } else {
          if (step.sensitive === true) recorder.armNextInputSensitive(tabId, details, step.value);
          let captured = false;
          try {
            await nativeReplaceInput(tabId, details, step.value);
            await waitForRecorderCapture(recorder, revision);
            captured = true;
          } finally {
            // 超时时保留短期标记，防止截图处理较慢导致延迟到达的步骤泄露。
            if (step.sensitive === true && captured) recorder.clearNextInputSensitive();
          }
        }
        const page = await waitForCondition(tabId, step.wait_for);
        completed.push({
          index,
          action: step.action,
          description: step.description || '',
          target: details.summary,
          url: page?.url || details.url,
          step_count: recorder?.state?.recordedSteps?.length || 0,
        });
        continue;
      }
      if (step.action === 'assert_text') {
        const details = step.target_type === 'element'
          ? await resolveSemanticTarget(tabId, step.target, 'assert_text', 10000)
          : await currentPageState(tabId);
        await verifyAssertion(tabId, details, step);
        const result = await recorder.addStep(assertionStep(details, {
          target: step.target_type,
          match: step.match,
          expected: step.expected,
        }), tabId);
        if (!result?.ok) throw new Error(result?.error || '添加断言失败');
        completed.push({
          index,
          action: step.action,
          description: step.description || '',
          target: details.summary || { page: true },
          url: details.url,
          step_count: result.stepCount,
        });
      }
    } catch (error) {
      return {
        status: 'needs_attention',
        completed_steps: completed,
        next_step_index: index,
        failed_step: {
          index,
          action: step.action,
          description: step.description || '',
          target: step.target || (step.target_type === 'page' ? { page: true } : null),
        },
        reason: error?.message || String(error),
        details: error?.details || null,
        ...(await currentPageState(tabId).catch(() => ({}))),
      };
    }
  }
  return {
    status: 'completed',
    completed_steps: completed,
    next_step_index: steps.length,
    step_count: recorder?.state?.recordedSteps?.length || 0,
    ...(await currentPageState(tabId).catch(() => ({}))),
  };
}

export async function executeAgentRecordingCommand({ command, recordingId, tabId, recorder, shouldStop }) {
  const request = command.request || {};
  if (command.type === 'snapshot') return snapshotRecordingPage(tabId, recordingId, command.id, request);
  if (command.type === 'click') {
    const details = await resolveRef(tabId, request.ref);
    const revision = recordingRevision(recorder);
    await nativeClick(tabId, details);
    await waitForRecorderCapture(recorder, revision);
    return { clicked: request.ref, url: details.url };
  }
  if (command.type === 'input') {
    const details = await resolveRef(tabId, request.ref);
    const revision = recordingRevision(recorder);
    if (request.sensitive === true) recorder.armNextInputSensitive(tabId, details, request.value);
    let captured = false;
    try {
      await nativeReplaceInput(tabId, details, request.value);
      await waitForRecorderCapture(recorder, revision);
      captured = true;
    } finally {
      if (request.sensitive === true && captured) recorder.clearNextInputSensitive();
    }
    return { input: request.ref, sensitive: request.sensitive === true, url: details.url };
  }
  if (command.type === 'assert_text') {
    const details = request.target === 'element'
      ? await resolveRef(tabId, request.ref)
      : await executeInTab(tabId, () => ({ url: location.href }));
    const result = await recorder.addStep(assertionStep(details, request), tabId);
    if (!result?.ok) throw new Error(result?.error || '添加断言失败');
    return { assertion_added: true, step_count: result.stepCount };
  }
  if (command.type === 'execute_plan') {
    return executeSemanticRecordingPlan({ steps: request.steps || [], tabId, recorder, shouldStop });
  }
  throw new Error(`不支持的浏览器录制指令：${command.type || 'unknown'}`);
}
