const PDF_MIME_TYPE = 'application/x-google-chrome-pdf';
const PDF_SELECTOR = `embed[type="${PDF_MIME_TYPE}"]`;
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
};

export function isPdfViewerAttributeTarget(step) {
  return /^\/\/embed\[@type\s*=\s*(['"])application\/x-google-chrome-pdf\1\]$/.test(
    String(step?.target_xpath || '').trim(),
  );
}

function nodeAttributes(node) {
  const attributes = new Map();
  const pairs = node?.attributes || [];
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    attributes.set(pairs[index], pairs[index + 1]);
  }
  return attributes;
}

function findPdfEmbed(root) {
  const pending = root ? [root] : [];
  while (pending.length) {
    const node = pending.pop();
    if (String(node.nodeName || '').toLowerCase() === 'embed'
      && nodeAttributes(node).get('type') === PDF_MIME_TYPE) return node;
    // CDP 的穿透 DOM 包含关闭的 Shadow Root 和同进程 frame，不能只遍历普通 children。
    const children = [...(node.children || []), ...(node.shadowRoots || [])];
    if (node.contentDocument) children.push(node.contentDocument);
    pending.push(...children.reverse());
  }
  return null;
}

async function readTargetAttribute(send, attribute, sessionId) {
  const document = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  const node = findPdfEmbed(document?.root);
  if (!node?.nodeId) return null;
  const attributes = nodeAttributes(await send('DOM.getAttributes', { nodeId: node.nodeId }, sessionId));
  // 再读一次真实节点，避免把已导航、已替换的节点或下载记录当成属性断言的证据。
  if (attributes.get('type') !== PDF_MIME_TYPE) return null;
  return {
    value: attributes.has(attribute) ? attributes.get(attribute) : null,
    locator: {
      source: 'pdf_viewer_frame',
      executionSource: 'cdp:pdf-viewer-frame',
      type: 'css',
      value: PDF_SELECTOR,
      matchedCount: 1,
    },
  };
}

export async function readPdfViewerAttribute({ tabId, attribute, timeoutMs, sendCommand }) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const sessions = new Map();
  const attaching = new Set();
  let closed = false;
  let lastError = 'not_found';
  const send = (method, params, sessionId) => sendCommand(method, params, {
    sessionId,
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
  const forgetSession = (sessionId) => {
    sessions.delete(sessionId);
    for (const [child, parent] of sessions) {
      if (parent === sessionId) forgetSession(child);
    }
  };
  const onEvent = (source, method, params) => {
    // 只接受当前 tab 根会话派生的 iframe；禁止扫描其他窗口或全局 debugger targets。
    if (closed || source?.tabId !== tabId || (source.sessionId && !sessions.has(source.sessionId))) return;
    if (method === 'Target.detachedFromTarget') {
      forgetSession(params.sessionId);
    } else if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      const sessionId = params.sessionId;
      if (!sessionId || sessions.has(sessionId)) return;
      sessions.set(sessionId, source.sessionId || '');
      const task = send('Target.setAutoAttach', AUTO_ATTACH, sessionId)
        .catch((error) => { lastError = error.message; })
        .finally(() => attaching.delete(task));
      attaching.add(task);
    }
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    // PDF Viewer 可能在独立进程，必须使用 Chrome 125+ 的 flat session 读取其真实 DOM。
    await send('Target.setAutoAttach', AUTO_ATTACH);
    do {
      for (const sessionId of [undefined, ...sessions.keys()]) {
        if (sessionId && !sessions.has(sessionId)) continue;
        try {
          const result = await readTargetAttribute(send, attribute, sessionId);
          if (result && (!sessionId || sessions.has(sessionId))) return result;
        } catch (error) {
          // 内部 frame 延迟创建或导航时节点会短暂失效；重试仍受当前步骤的总等待预算约束。
          lastError = error.message;
        }
        if (Date.now() >= deadline) break;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    } while (Date.now() < deadline);

    const error = new Error(`断言失败：当前标签页未找到 Chrome PDF Viewer 属性目标元素（${lastError}）；请确认已切换到 PDF 窗口且浏览器允许内置 PDF 预览`);
    error.locatorError = { code: 'LOCATOR_NOT_FOUND', reason: 'pdf_viewer_not_found' };
    throw error;
  } finally {
    closed = true;
    chrome.debugger.onEvent.removeListener(onEvent);
    await Promise.allSettled([...attaching]);
    // 临时自动附加仅服务本次断言；关闭后级联释放子会话，保留当前 tab 的主调试连接。
    await sendCommand('Target.setAutoAttach', {
      autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
    }, { timeoutMs: 1000 });
  }
}
