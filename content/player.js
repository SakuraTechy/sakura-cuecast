/**
 * Player Content Script
 * 注入到目标测试页面，用于基于 DOM 的回放（方案 A 降级）
 * CDP 方式的回放主要在 background.js 中通过 chrome.debugger 实现
 */

(function () {
  'use strict';

  if (window.__AT_PLAYER_ACTIVE__) return;
  window.__AT_PLAYER_ACTIVE__ = true;
  let currentLocale = 'zh';
  let pageErrorCheckEnabled = false;

  function normalizeLocale(locale) {
    const raw = String(locale || '').trim().toLowerCase();
    return raw.startsWith('en') ? 'en' : 'zh';
  }

  function tr(zh, en) {
    return currentLocale === 'en' ? (en || zh) : zh;
  }

  // 等待指定时间
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /** 仅文本类控件才 blur，避免 checkbox/radio 失焦触发组件库误同步 */
  function isTextLikeField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    const t = (el.type || 'text').toLowerCase();
    return ['text', 'search', 'email', 'password', 'number', 'tel', 'url', 'date', 'time', 'datetime-local', ''].includes(t);
  }

  function isKeyboardTarget(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isTextLikeField(el)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    return false;
  }

  function getFocusedKeyboardTarget() {
    const ae = document.activeElement;
    if (!isKeyboardTarget(ae)) return null;
    return ae.isContentEditable ? ae : (ae.closest?.('[contenteditable="true"]') || ae);
  }

  /** 断言/比对用：textarea、input 取 value，其它元素取 textContent（原样，不 trim） */
  function getElementRawTextForAssert(el) {
    if (!el) return '';
    const tag = el.tagName && String(el.tagName).toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      return el.value != null ? String(el.value) : '';
    }
    const t = el.textContent;
    return t != null ? String(t) : '';
  }

  function dispatchMouseLike(el, actionType) {
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const button = actionType === 'right_click' ? 2 : 0;
    const common = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button };
    if (actionType === 'right_click') {
      el.dispatchEvent(new MouseEvent('mousedown', common));
      el.dispatchEvent(new MouseEvent('mouseup', common));
      el.dispatchEvent(new MouseEvent('contextmenu', common));
      return;
    }
    if (actionType === 'double_click') {
      el.dispatchEvent(new MouseEvent('mousedown', common));
      el.dispatchEvent(new MouseEvent('mouseup', common));
      el.dispatchEvent(new MouseEvent('click', common));
      el.dispatchEvent(new MouseEvent('mousedown', common));
      el.dispatchEvent(new MouseEvent('mouseup', common));
      el.dispatchEvent(new MouseEvent('click', common));
      el.dispatchEvent(new MouseEvent('dblclick', common));
      return;
    }
    el.click();
    el.dispatchEvent(new MouseEvent('click', common));
  }

  /**
   * 聚焦目标控件。文本类不用合成鼠标事件：mousedown/click 在捕获阶段会先经过表格 tr 等祖先，
   * 仅靠目标上的 stopPropagation 挡不住捕获监听，易误触行选、取消其它行勾选。
   */
  function activateFieldWithoutBubble(el) {
    if (isTextLikeField(el)) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      return;
    }
    const opts = { bubbles: false, cancelable: true, view: window };
    const stop = (e) => { e.stopPropagation(); };
    el.addEventListener('mousedown', stop, { once: true });
    el.addEventListener('mouseup', stop, { once: true });
    el.addEventListener('click', stop, { once: true });
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    try { el.focus({ preventScroll: true }); } catch (e2) { /* ignore */ }
  }

  function isVolatileRcCss(sel) {
    return typeof sel === 'string' && /#rc_[a-z0-9_]+_\d+/i.test(sel);
  }

  function isVolatileRcXPath(xp) {
    return typeof xp === 'string' && /\/\/\*\[@id\s*=\s*['"]rc_[^'"]+['"]\]/.test(xp);
  }

  function findAntSelectSearchFallback() {
    const inputs = [...document.querySelectorAll('input.ant-select-selection-search-input')];
    const vis = inputs.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return vis.length === 1 ? vis[0] : null;
  }

  /**
   * iView Radio：完整 CSS/XPath 常因中间多包一层 div、nth-of-type 计数变化而失效。
   * 用「radio-group 容器 + 第 N 个选项」与录制意图对齐（label:nth-of-type(N) / /label[N]/）。
   */
  function findIvuRadioInputFallback(selector, xpath) {
    const sel = selector || '';
    const xp = xpath || '';
    if (!sel.includes('ivu-radio') && !xp.includes('ivu-radio') && !sel.includes('radio-group')) return null;

    let labelIdx = null;
    const mCss = sel.match(/label:nth-of-type\((\d+)\)/);
    if (mCss) labelIdx = parseInt(mCss[1], 10);
    if (labelIdx == null || Number.isNaN(labelIdx)) {
      const matches = [...xp.matchAll(/\/label\[(\d+)\]/g)];
      if (matches.length) labelIdx = parseInt(matches[matches.length - 1][1], 10);
    }
    if (!labelIdx || labelIdx < 1) return null;

    const pickNth = (container) => {
      if (!container) return null;
      const inputs = container.querySelectorAll(
        'input.ivu-radio-input, .ivu-radio-wrapper input[type="radio"], label.ivu-radio-wrapper input[type="radio"]',
      );
      if (inputs.length >= labelIdx) return inputs[labelIdx - 1];
      return null;
    };

    const stripToGroup = (css) => {
      const pos = css.lastIndexOf('> label');
      if (pos < 0) return '';
      return css.slice(0, pos).trim();
    };

    const candidates = [];
    const stripped = stripToGroup(sel);
    if (stripped) candidates.push(stripped);

    const mFormItem = sel.match(/(div\.ivu-form-item[\w.-]*:nth-of-type\(\d+\))/);
    if (mFormItem) {
      const base = mFormItem[1];
      candidates.push(`${base} .radio-group`);
      candidates.push(`${base} .mb-6.radio-group`);
      candidates.push(`${base} .ivu-radio-group`);
      candidates.push(`${base} [class*="radio-group"]`);
    }

    for (let i = 0; i < candidates.length; i++) {
      try {
        const container = document.querySelector(candidates[i]);
        const found = pickNth(container);
        if (found) return found;
      } catch (e) { /* ignore */ }
    }

    const mForm = xp.match(/\/form\[(\d+)\]/i);
    const formIdx = mForm ? parseInt(mForm[1], 10) : 1;
    const forms = document.querySelectorAll('form');
    const form = forms[formIdx - 1];
    if (form) {
      const mItem = sel.match(/ivu-form-item[^>]*:nth-of-type\((\d+)\)/);
      const itemN = mItem ? parseInt(mItem[1], 10) : null;
      if (itemN != null && !Number.isNaN(itemN)) {
        const items = form.querySelectorAll('.ivu-form-item');
        const itemEl = items[itemN - 1];
        if (itemEl) {
          const rg = itemEl.querySelector('.radio-group, .mb-6.radio-group, .ivu-radio-group, [class*="radio-group"]');
          const found = pickNth(rg || itemEl);
          if (found) return found;
        }
      }
    }

    return null;
  }

  /**
   * iView Table 单元格内图标：旧录制 XPath 含整页路径或 td 上 ivu-table-column-* 失效时，
   * 用 //tbody|thead/tr[n]/td[m] 在可见表格中重定位单元格，再取 a / svg use / .data-source-icon。
   */
  function pickTargetInTableCell(td) {
    if (!td) return null;
    const a = td.querySelector('a.ivu-poptip-rel, .ivu-poptip a, a[href], a');
    if (a) return a;
    const u = td.querySelector('svg use');
    if (u) return u;
    const ic = td.querySelector('[class*="data-source-icon"]');
    if (ic) return ic;
    return td;
  }

  function findIvuTableCellFallback(selector, xpath, locatorMeta) {
    const xp = xpath || '';
    const wrapM = xp.match(/\(\/\/div\[contains\(@class,'ivu-table'\)\]\)\[(\d+)\]/i);
    const m = xp.match(/\/(tbody|thead)\/tr\[(\d+)\]\/(?:td|th)\[(\d+)\]/i);
    if (!m) return null;
    const secName = (m[1] || 'tbody').toLowerCase();
    const trN = parseInt(m[2], 10);
    const tdN = parseInt(m[3], 10);
    if (trN < 1 || tdN < 1) return null;
    const ctx = getLocatorContext(locatorMeta);
    const expectedRowText = normLocatorText(ctx?.table?.row_text).toLowerCase();

    const wrappers = [];
    document.querySelectorAll('.ivu-table').forEach((w) => {
      const t = w.querySelector('table');
      if (t) wrappers.push({ wrap: w, table: t });
    });
    if (!wrappers.length) {
      document.querySelectorAll('table').forEach((t) => {
        if (t.closest && t.closest('.ivu-table')) wrappers.push({ wrap: t.closest('.ivu-table'), table: t });
      });
    }

    const pickInTable = (table) => {
      const section = secName === 'thead' ? table.querySelector('thead') : table.querySelector('tbody');
      if (!section) return null;
      const tr = section.querySelector(`:scope > tr:nth-of-type(${trN})`);
      if (!tr) return null;
      return tr.querySelector(
        `:scope > td:nth-of-type(${tdN}), :scope > th:nth-of-type(${tdN})`,
      );
    };

    const candidates = [];
    const wrapOnly = wrapM ? parseInt(wrapM[1], 10) : null;
    wrappers.forEach((item, wi) => {
      if (wrapOnly != null && wi + 1 !== wrapOnly) return;
      const td = pickInTable(item.table);
      if (!td) return;
      const r = td.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return;
      const target = pickTargetInTableCell(td);
      if (!target) return;
      let score = 0;
      if (wrapOnly != null) score += 30;
      if (expectedRowText) {
        const tr = td.closest('tr');
        const actual = normLocatorText(tr?.innerText || tr?.textContent || '').toLowerCase();
        if (actual === expectedRowText) score += 90;
        else {
          const tokens = expectedRowText.split(/\s+/).filter((x) => x.length >= 2).slice(0, 8);
          const hits = tokens.filter((x) => actual.includes(x)).length;
          if (hits) score += Math.min(70, hits * 15);
        }
      }
      if (Number.isInteger(ctx?.table?.row_index) && trN - 1 === ctx.table.row_index) score += 50;
      candidates.push({ target, score, ord: wi });
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.ord - b.ord));
    return candidates[0].target;
  }

  /** CSS 命中多个 Ant Select 搜索框时，用录制 XPath 中的 tbody|thead/tr/列号 锁定单元格 */
  function pickAntSelectInputByTableXPathHint(xpath, nodeList) {
    const arr = [...nodeList];
    if (arr.length <= 1) return arr[0] || null;
    const xp = xpath || '';
    const m = xp.match(/\/\/(?:tbody|thead)\/tr\[(\d+)\]\/(?:td|th)\[(\d+)\]/i);
    if (!m) return arr[0];
    const trN = parseInt(m[1], 10);
    const tdN = parseInt(m[2], 10);
    if (trN < 1 || tdN < 1) return arr[0];
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const body = table.querySelector('tbody') || table;
      const tr = body.querySelector(`:scope > tr:nth-of-type(${trN})`);
      if (!tr) continue;
      const cell = tr.querySelector(`:scope > td:nth-of-type(${tdN}), :scope > th:nth-of-type(${tdN})`);
      const inp = cell?.querySelector('input.ant-select-selection-search-input');
      if (inp && arr.includes(inp)) return inp;
    }
    return arr[0];
  }

  /**
   * 判断节点是否可视为「当前可见」（含祖先 display/aria-hidden）
   */
  function isDomVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    let cur = el;
    while (cur) {
      const st = window.getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.02) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 1 || r.height >= 1;
  }

  /**
   * 同一 CSS 命中多个节点时：优先弹窗/confirm 内、可见、堆叠最高（避免点到页面里隐藏的模板按钮或遮罩下的副本）
   */
  function pickTopmostDialogMatch(nodeList) {
    const nodes = [...nodeList];
    if (nodes.length <= 1) return nodes[0] || null;
    function inModal(el) {
      return el.closest(
        '[role="dialog"],[role="alertdialog"],dialog,'
          + '.ant-modal-root .ant-modal,.ant-modal-wrap,.ant-modal,.ant-modal-confirm,.el-message-box__wrapper,.el-dialog__wrapper,'
          + '.ivu-modal-wrap,.arco-modal-wrapper,.t-dialog__ctx,.n-dialog,.MuiDialog-root,.MuiModal-root,'
          + '[class*="modal-wrap"],[class*="Modal__"]',
      );
    }
    function zStackSum(el) {
      let z = 0;
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const st = window.getComputedStyle(cur);
        if (st.position !== 'static' || cur === el) {
          const zi = parseInt(st.zIndex, 10);
          if (!isNaN(zi) && zi > z) z = zi;
        }
        cur = cur.parentElement;
      }
      return z;
    }
    const vis = nodes.filter(isDomVisible);
    const pool = vis.length ? vis : nodes;
    const inD = pool.filter((n) => inModal(n));
    const scored = (inD.length ? inD : pool).map((n) => ({ n, z: zStackSum(n) }));
    scored.sort((a, b) => b.z - a.z);
    return scored[0]?.n || nodes[0];
  }

  /**
   * XPath 多匹配时不能用 FIRST_ORDERED_NODE（文档顺序第一个常为隐藏模板，弹窗内「确定」在后面）。
   * 例：//span[normalize-space()='确定'] 应对所有匹配做弹窗/堆叠优先。
   */
  function findBestXPathMatch(xpRaw) {
    let x = xpRaw;
    if (x && !x.startsWith('//') && !x.startsWith('/html') && !x.startsWith('/*')) {
      x = `/${x}`;
    }
    try {
      const result = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const n = result.snapshotItem(i);
        if (n && n.nodeType === Node.ELEMENT_NODE) nodes.push(n);
      }
      if (nodes.length === 0) return null;
      if (nodes.length === 1) return nodes[0];
      return pickTopmostDialogMatch(nodes);
    } catch (e) {
      return null;
    }
  }

  function parseLocatorMeta(metaRaw) {
    if (!metaRaw) return null;
    if (typeof metaRaw === 'object') return metaRaw;
    if (typeof metaRaw !== 'string') return null;
    try {
      const parsed = JSON.parse(metaRaw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function resolveAssertionConfig(step, hasLocator = false) {
    const meta = parseLocatorMeta(step?.locator_meta);
    const raw = meta?.assertion && typeof meta.assertion === 'object' ? meta.assertion : {};
    const target = ['page', 'element', 'error'].includes(String(raw.target || '')) ? String(raw.target) : (hasLocator ? 'element' : 'page');
    const match = ['contains', 'equals', 'not_contains', 'regex'].includes(String(raw.match || '')) ? String(raw.match) : (hasLocator ? 'equals' : 'contains');
    return { target, match };
  }

  function matchAssertionText(actual, expected, mode = 'contains') {
    const a = String(actual ?? '');
    const e = String(expected ?? '');
    if (mode === 'equals') return a === e;
    if (mode === 'not_contains') return !a.includes(e);
    if (mode === 'regex') {
      try {
        return new RegExp(e).test(a);
      } catch {
        return false;
      }
    }
    return a.includes(e);
  }

  async function waitForPageErrorText(timeout = 10000) {
    const end = Date.now() + timeout;
    let last = '';
    while (Date.now() < end) {
      const sig = detectPageErrorSignal(true);
      if (sig && sig.hit) {
        last = sig.snippet || sig.keyword || '';
        if (last) return last;
      }
      await sleep(300);
    }
    return last;
  }

  function extractRevealTriggerFromLocatorMeta(metaRaw) {
    const meta = parseLocatorMeta(metaRaw);
    const reveal = meta?.context?.reveal;
    if (!reveal || typeof reveal !== 'object') return null;
    const trigger = reveal.trigger && typeof reveal.trigger === 'object' ? reveal.trigger : null;
    if (!trigger) return null;
    const action = String(trigger.action || 'hover').trim().toLowerCase();
    const target_selector = String(trigger.target_selector || '').trim();
    const target_xpath = String(trigger.target_xpath || '').trim();
    const locator_meta = trigger.locator_meta ?? null;
    if (!target_selector && !target_xpath && !locator_meta) return null;
    const max_wait_ms = Number.isFinite(Number(reveal.max_wait_ms))
      ? Math.max(500, Math.min(10000, Number(reveal.max_wait_ms)))
      : 2200;
    return { action, target_selector, target_xpath, locator_meta, max_wait_ms };
  }

  async function activateRevealTrigger(trigger) {
    if (!trigger) return false;
    const action = String(trigger.action || 'hover').toLowerCase();
    const el = await waitForElement(
      trigger.target_selector || '',
      trigger.target_xpath || '',
      '',
      trigger.max_wait_ms || 2200,
      false,
      trigger.locator_meta ?? null,
    );
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(80);
    if (action === 'click') {
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(220);
      return true;
    }
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const common = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try {
      el.dispatchEvent(new PointerEvent('pointerover', { ...common, pointerId: 1, pointerType: 'mouse' }));
    } catch (e) { /* ignore */ }
    el.dispatchEvent(new MouseEvent('mousemove', common));
    el.dispatchEvent(new MouseEvent('mouseover', common));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...common, bubbles: false }));
    await sleep(380);
    return true;
  }

  function findByTagAndTextExact(tag, text) {
    if (!text) return null;
    const t = String(tag || '').trim().toLowerCase();
    const normalized = text.trim().replace(/\s+/g, ' ');
    const selector = t ? t : '*';
    const nodes = document.querySelectorAll(selector);
    const matched = [];
    for (const el of nodes) {
      const raw = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (raw === normalized) matched.push(el);
    }
    if (!matched.length) return null;
    return matched.length === 1 ? matched[0] : pickTopmostDialogMatch(matched);
  }

  function getLocatorContext(metaRaw) {
    const meta = parseLocatorMeta(metaRaw);
    return meta && typeof meta.context === 'object' ? meta.context : null;
  }

  function normLocatorText(s) {
    return String(s || '').trim().replace(/\s+/g, ' ');
  }

  function getTreeNodeVisibleTitle(treeNode) {
    if (!treeNode) return '';
    try {
      const clone = treeNode.cloneNode(true);
      clone.querySelectorAll(
        '.tree-node-actions,.action-icon-wrapper,.data-source-icon,[class*="action"],button,svg',
      ).forEach((node) => node.remove());
      return normLocatorText(clone.textContent || '').slice(0, 120);
    } catch {
      return normLocatorText(treeNode.textContent || '').slice(0, 120);
    }
  }

  function getElementLeft(el) {
    try {
      const r = el?.getBoundingClientRect?.();
      return r && (r.width > 0 || r.height > 0) ? r.left : 0;
    } catch {
      return 0;
    }
  }

  function getAriaLevel(el) {
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const raw = cur.getAttribute?.('aria-level') || cur.getAttribute?.('data-level') || cur.dataset?.level;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.max(0, n - 1);
      cur = cur.parentElement;
    }
    return -1;
  }

  function collectVisibleTreeItems(nodes, getTitle, getAnchor = (node) => node) {
    const items = nodes
      .map((node, order) => {
        const title = getTitle(node);
        if (!title) return null;
        const anchor = getAnchor(node) || node;
        return {
          node,
          order,
          title,
          ariaLevel: getAriaLevel(node),
          left: getElementLeft(anchor),
        };
      })
      .filter(Boolean);
    const leftBuckets = [];
    for (const item of items) {
      if (item.ariaLevel >= 0) continue;
      if (!leftBuckets.some((left) => Math.abs(left - item.left) <= 6)) {
        leftBuckets.push(item.left);
      }
    }
    leftBuckets.sort((a, b) => a - b);
    const stack = [];
    return items.map((item) => {
      const bucketLevel = item.ariaLevel >= 0
        ? item.ariaLevel
        : Math.max(0, leftBuckets.findIndex((left) => Math.abs(left - item.left) <= 6));
      const level = bucketLevel < 0 ? 0 : bucketLevel;
      stack[level] = item.title;
      stack.length = level + 1;
      return {
        ...item,
        level,
        parentPath: stack.slice(0, level),
      };
    });
  }

  function normalizePath(raw) {
    return Array.isArray(raw) ? raw.map(normLocatorText).filter(Boolean) : [];
  }

  function scoreTreeItem(item, cfg, sameTitleOrdinal) {
    const title = normLocatorText(cfg.title || '');
    if (!title || item.title !== title) return -1;
    let score = 1000;
    const expectedPath = normalizePath(cfg.parentPath);
    if (expectedPath.length) {
      const actualPath = normalizePath(item.parentPath);
      const same = expectedPath.length === actualPath.length
        && expectedPath.every((part, idx) => part === actualPath[idx]);
      if (same) {
        score += 260;
      } else {
        const expectedTail = expectedPath.slice(-2).join('/');
        const actualTail = actualPath.slice(-2).join('/');
        if (expectedTail && expectedTail === actualTail) score += 110;
        score -= Math.min(180, Math.abs(expectedPath.length - actualPath.length) * 45);
      }
    }
    const expectedLevel = Number(cfg.level);
    if (Number.isInteger(expectedLevel) && expectedLevel >= 0) {
      if (item.level === expectedLevel) score += 120;
      else score -= Math.min(160, Math.abs(item.level - expectedLevel) * 55);
    }
    const expectedSameTitleIndex = Number(cfg.sameTitleIndex);
    if (Number.isInteger(expectedSameTitleIndex) && expectedSameTitleIndex >= 0) {
      if (sameTitleOrdinal === expectedSameTitleIndex) score += 45;
      else score -= Math.min(80, Math.abs(sameTitleOrdinal - expectedSameTitleIndex) * 18);
    }
    return score;
  }

  function pickBestTreeItem(items, cfg) {
    let sameTitleOrdinal = 0;
    const scored = [];
    const expectedTitle = normLocatorText(cfg.title || '');
    for (const item of items) {
      if (item.title !== expectedTitle) continue;
      const ord = sameTitleOrdinal;
      sameTitleOrdinal += 1;
      const score = scoreTreeItem(item, cfg, ord);
      if (score >= 0) scored.push({ item, score, ord });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.ord - b.ord));
    return scored[0]?.item?.node || null;
  }

  function findAntTreeAction(value) {
    let cfg = null;
    try { cfg = typeof value === 'string' ? JSON.parse(value) : value; } catch { cfg = null; }
    if (!cfg || typeof cfg !== 'object') return null;
    const title = normLocatorText(cfg.title || '');
    if (!title) return null;
    const actionIndex = Math.max(0, Number(cfg.actionIndex || 0));
    let nodes = Array.from(document.querySelectorAll('.ant-tree-treenode'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
    const items = collectVisibleTreeItems(
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title') || node),
      (node) => node.querySelector?.('.ant-tree-node-content-wrapper') || node,
    );
    const node = pickBestTreeItem(items, cfg);
    if (!node) return null;
    let hosts = Array.from(node.querySelectorAll(
      '.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"]',
    ));
    if (!hosts.length) {
      hosts = Array.from(node.querySelectorAll(
        '.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"]',
      ));
    }
    return hosts[actionIndex] || hosts[0] || null;
  }

  function findAntTreeNodeByConfig(cfg) {
    let nodes = Array.from(document.querySelectorAll('.ant-tree-treenode'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
    const items = collectVisibleTreeItems(
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title') || node),
      (node) => node.querySelector?.('.ant-tree-node-content-wrapper') || node,
    );
    return pickBestTreeItem(items, cfg);
  }

  function findTreeNodeByText(value) {
    let cfg = null;
    try { cfg = typeof value === 'string' ? JSON.parse(value) : value; } catch { cfg = null; }
    if (!cfg || typeof cfg !== 'object') return null;
    const title = normLocatorText(cfg.title || '');
    if (!title) return null;
    const sameTitleIndex = Math.max(0, Number(cfg.sameTitleIndex || 0));
    const nodes = Array.from(document.querySelectorAll([
      '.el-tree-node__content',
      '.ivu-tree-title',
      '.arco-tree-node-title',
      '.n-tree-node-content',
      '[role="treeitem"]',
    ].join(',')));
    const matched = nodes.filter((node) => {
      const titleEl = node.querySelector?.('.node,.el-tree-node__label,.ivu-tree-title,.arco-tree-node-title,.n-tree-node-content__text') || node;
      return getTreeNodeVisibleTitle(titleEl) === title;
    });
    return matched[sameTitleIndex] || matched[0] || null;
  }

  function getVtreeNodeTitle(nodeRoot) {
    if (!nodeRoot) return '';
    const titleEl = nodeRoot.querySelector?.('.vtree-tree-node__title .node, .vtree-tree-node__title, .node') || nodeRoot;
    return getTreeNodeVisibleTitle(titleEl);
  }

  function findVtreeNodeByConfig(cfg) {
    const nodes = Array.from(document.querySelectorAll('.vtree-tree-node__indent-wrapper'));
    const items = collectVisibleTreeItems(
      nodes,
      getVtreeNodeTitle,
      (node) => node.querySelector?.('.vtree-tree-node__title, .vtree-tree-node__node-body') || node,
    );
    return pickBestTreeItem(items, cfg);
  }

  function findTreeInteraction(value) {
    let cfg = null;
    try { cfg = typeof value === 'string' ? JSON.parse(value) : value; } catch { cfg = null; }
    if (!cfg || typeof cfg !== 'object') return null;
    const framework = String(cfg.framework || '').toLowerCase();
    const kind = String(cfg.kind || '').toLowerCase();
    if (framework === 'ant-tree') {
      if (kind === 'node_action') {
        return findAntTreeAction(cfg);
      }
      const node = findAntTreeNodeByConfig(cfg);
      if (!node) return null;
      if (kind === 'expand_toggle') {
        return node.querySelector?.('.ant-tree-switcher') || null;
      }
      if (kind === 'node_content') {
        return node.querySelector?.('.ant-tree-node-content-wrapper, .ant-tree-title') || node;
      }
    }
    if (framework === 'vtree') {
      const node = findVtreeNodeByConfig(cfg);
      if (!node) return null;
      if (kind === 'expand_toggle') {
        return node.querySelector('.vtree-tree-node__square.vtree-tree-node__expand') || null;
      }
      if (kind === 'node_content') {
        return node.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || node;
      }
    }
    return null;
  }

  function getTreeInteractionConfig(metaRaw) {
    const meta = parseLocatorMeta(metaRaw);
    const candidates = Array.isArray(meta?.candidates) ? meta.candidates : [];
    for (const c of candidates) {
      if (String(c?.type || '') !== 'tree_interaction') continue;
      try {
        const cfg = typeof c.value === 'string' ? JSON.parse(c.value) : c.value;
        if (cfg && typeof cfg === 'object') return cfg;
      } catch {
        return null;
      }
    }
    const ctxCfg = meta?.context?.tree_interaction;
    return ctxCfg && typeof ctxCfg === 'object' ? ctxCfg : null;
  }

  function diagnoseTreeInteraction(metaRaw) {
    const cfg = getTreeInteractionConfig(metaRaw);
    if (!cfg) return null;
    const framework = String(cfg.framework || '').toLowerCase();
    const kind = String(cfg.kind || '').toLowerCase();
    const title = normLocatorText(cfg.title || '');
    if (!framework || !kind || !title) return null;
    const expectedParentPath = normalizePath(cfg.parentPath);
    const expectedLevel = Number.isInteger(Number(cfg.level)) ? Number(cfg.level) : null;
    const actionIndex = Math.max(0, Number(cfg.actionIndex || 0));
    let nodes = [];
    let items = [];
    if (framework === 'ant-tree') {
      nodes = Array.from(document.querySelectorAll('.ant-tree-treenode'));
      if (!nodes.length) nodes = Array.from(document.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
      items = collectVisibleTreeItems(
        nodes,
        (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title') || node),
        (node) => node.querySelector?.('.ant-tree-node-content-wrapper') || node,
      );
    } else if (framework === 'vtree') {
      nodes = Array.from(document.querySelectorAll('.vtree-tree-node__indent-wrapper'));
      items = collectVisibleTreeItems(
        nodes,
        getVtreeNodeTitle,
        (node) => node.querySelector?.('.vtree-tree-node__title, .vtree-tree-node__node-body') || node,
      );
    } else {
      return null;
    }
    const targetOf = (node) => {
      if (!node) return null;
      if (framework === 'ant-tree') {
        if (kind === 'expand_toggle') return node.querySelector?.('.ant-tree-switcher') || null;
        if (kind === 'node_content') return node.querySelector?.('.ant-tree-node-content-wrapper, .ant-tree-title') || node;
        if (kind === 'node_action') {
          let hosts = Array.from(node.querySelectorAll('.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"]'));
          if (!hosts.length) {
            hosts = Array.from(node.querySelectorAll('.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"]'));
          }
          return hosts[actionIndex] || hosts[0] || null;
        }
      }
      if (framework === 'vtree') {
        if (kind === 'expand_toggle') return node.querySelector?.('.vtree-tree-node__square.vtree-tree-node__expand') || null;
        if (kind === 'node_content') return node.querySelector?.('.vtree-tree-node__title, .vtree-tree-node__node-body') || node;
      }
      return null;
    };
    const samePath = (actualPath) => {
      const actual = normalizePath(actualPath);
      return expectedParentPath.length === 0
        || (actual.length === expectedParentPath.length && expectedParentPath.every((part, idx) => part === actual[idx]));
    };
    const sameTitle = items.filter((item) => item.title === title);
    const pathMatched = sameTitle.filter((item) => samePath(item.parentPath));
    const levelMatched = pathMatched.filter((item) => expectedLevel === null || item.level === expectedLevel);
    const targetPool = levelMatched.length ? levelMatched : pathMatched.length ? pathMatched : sameTitle;
    const withTarget = targetPool.filter((item) => !!targetOf(item.node));
    return {
      framework,
      kind,
      title,
      expectedParentPath,
      expectedLevel,
      treeNodeCount: items.length,
      sameTitleCount: sameTitle.length,
      pathMatchedCount: pathMatched.length,
      levelMatchedCount: levelMatched.length,
      targetMatchedCount: withTarget.length,
    };
  }

  function formatTreeWaitDiagnostic(metaRaw) {
    const tree = diagnoseTreeInteraction(metaRaw);
    if (!tree) return '';
    const title = tree.title ? `「${tree.title}」` : '目标节点';
    const path = Array.isArray(tree.expectedParentPath) && tree.expectedParentPath.length
      ? `\n  录制父路径: ${tree.expectedParentPath.join(' / ')}`
      : '';
    const level = tree.expectedLevel !== null && tree.expectedLevel !== undefined
      ? `\n  录制层级: ${tree.expectedLevel}`
      : '';
    if (Number(tree.treeNodeCount || 0) <= 0) {
      return `\n  Tree 诊断: 当前页面未找到 ${tree.framework} 树节点，可能页面状态或前置步骤不一致。`;
    }
    if (Number(tree.sameTitleCount || 0) <= 0) {
      return `\n  Tree 诊断: 当前树中找不到标题为 ${title} 的节点，可能节点未展开、未加载或已被前序步骤改名/删除。${path}${level}`;
    }
    if (Array.isArray(tree.expectedParentPath) && tree.expectedParentPath.length && Number(tree.pathMatchedCount || 0) <= 0) {
      return `\n  Tree 诊断: 找到 ${tree.sameTitleCount} 个同名节点，但父路径与录制时不匹配，可能点击到了另一棵分支或树结构已变化。${path}${level}`;
    }
    if (tree.expectedLevel !== null && tree.expectedLevel !== undefined && Number(tree.levelMatchedCount || 0) <= 0) {
      return `\n  Tree 诊断: 找到同名节点且父路径接近，但层级与录制时不一致，可能目标节点层级发生变化。${path}${level}`;
    }
    if (Number(tree.targetMatchedCount || 0) <= 0) {
      const kindText = tree.kind === 'expand_toggle'
        ? '展开/收起按钮'
        : tree.kind === 'node_action'
          ? '节点操作图标'
          : '节点内容区域';
      return `\n  Tree 诊断: 已找到目标节点 ${title}，但未找到可点击的${kindText}，可能图标需要先 hover、节点不可展开，或组件 DOM 已变化。${path}${level}`;
    }
    return `\n  Tree 诊断: 已找到候选 Tree 节点，但目标元素仍未通过可见性/可点击性检查，可能被遮挡、未渲染完成或页面状态变化。${path}${level}`;
  }

  function formatElementNotFound(step, includeText = false) {
    const treeDiag = formatTreeWaitDiagnostic(step?.locator_meta);
    const textLine = includeText ? `\n  文本: ${step?.value || ''}` : '';
    return tr(
      `找不到元素（等待超时；全页 loading 时计时会暂停）${treeDiag}\n  CSS: ${step?.target_selector}\n  XPath: ${step?.target_xpath}${textLine}`,
      `Element not found (wait timed out; timer pauses while full-page loading is active)\n  CSS: ${step?.target_selector}\n  XPath: ${step?.target_xpath}${includeText ? `\n  Text: ${step?.value || ''}` : ''}`,
    );
  }

  function getContextControlRoot(el) {
    const componentRoot = el?.closest?.('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]');
    if (componentRoot) return componentRoot;
    return el?.closest?.('select,textarea,input,button,a,[role="button"]') || el;
  }

  function getContextControlKind(el) {
    const root = getContextControlRoot(el);
    if (!root) return '';
    const tag = (root.tagName || '').toLowerCase();
    if (
      tag === 'select'
      || root.getAttribute?.('role') === 'combobox'
      || root.matches?.('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle')
    ) {
      return 'combobox';
    }
    if (tag === 'input') return `input:${(root.type || 'text').toLowerCase()}`;
    if (tag === 'textarea') return 'textarea';
    if (tag === 'button' || root.getAttribute?.('role') === 'button') return 'button';
    if (tag === 'a') return 'link';
    return tag;
  }

  function getContextLabelText(el) {
    const parts = [];
    const push = (v) => {
      const t = normLocatorText(v);
      if (t && !parts.includes(t)) parts.push(t);
    };
    try {
      if (el.labels && el.labels.length) Array.from(el.labels).forEach((label) => push(label.textContent));
      const labelledBy = el.getAttribute?.('aria-labelledby');
      if (labelledBy) labelledBy.split(/\s+/).forEach((id) => push(document.getElementById(id)?.textContent));
      push(el.getAttribute?.('aria-label'));
      const ownLabel = el.closest?.('label');
      if (ownLabel) push(ownLabel.textContent);
      const formItem = el.closest?.(
        '.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,.mapping-row,.map-row,[class*="mapping-row"],[class*="map-row"]',
      );
      const label = formItem?.querySelector?.(
        'label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"]',
      );
      if (label) push(label.textContent);
    } catch (e) { /* ignore */ }
    return parts.join(' | ');
  }

  function getContextContainerText(el) {
    try {
      const container = el?.closest?.(
        '.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"],.mapping-row,.map-row,[class*="mapping-row"],[class*="map-row"]',
      );
      return normLocatorText(container?.innerText || container?.textContent || '').slice(0, 300);
    } catch {
      return '';
    }
  }

  function resolveTableCellPosition(el) {
    if (!el || !el.closest) return null;
    let row = el.closest('tr');
    let cell = el.closest('td, th');
    if (!row) {
      row = el.closest('.ant-table-row, .el-table__row, .ivu-table-row, [role="row"]');
      if (row) {
        cell = cell || el.closest(
          '.ant-table-cell, .el-table__cell, .ivu-table-cell, [role="gridcell"], td, th',
        );
      }
    }
    if (!row || !cell) return null;
    const section = row.closest('tbody') || row.closest('thead');
    if (!section) return null;
    const rows = Array.from(section.querySelectorAll(':scope > tr'));
    const row_index = rows.indexOf(row);
    const cells = Array.from(row.querySelectorAll(
      ':scope > td, :scope > th, :scope > .ant-table-cell, :scope > .el-table__cell, :scope > .ivu-table-cell, :scope > [role="gridcell"]',
    ));
    const col_index = cells.indexOf(cell);
    if (row_index < 0 || col_index < 0) return null;
    const row_text = normLocatorText(row.innerText || row.textContent || '').slice(0, 160);
    return { row_index, col_index, row_text, section: section.tagName.toLowerCase() };
  }

  function scoreTableContext(el, ctx) {
    if (!ctx?.table || !el) return 0;
    let score = 0;
    const pos = resolveTableCellPosition(el);
    const t = ctx.table;
    if (pos) {
      if (Number.isInteger(t.row_index) && pos.row_index === t.row_index) score += 85;
      else if (Number.isInteger(t.row_index) && pos.row_index >= 0) {
        score -= Math.min(40, Math.abs(pos.row_index - t.row_index) * 12);
      }
      if (Number.isInteger(t.col_index) && pos.col_index === t.col_index) score += 35;
    }
    const expectedRow = normLocatorText(t.row_text).toLowerCase();
    if (expectedRow) {
      const row = el.closest('tr, .ant-table-row, .el-table__row, .ivu-table-row, [role="row"]');
      const actual = normLocatorText(row?.innerText || row?.textContent || '').toLowerCase();
      if (actual === expectedRow) score += 70;
      else if (actual && expectedRow) {
        const tokens = expectedRow.split(/\s+/).filter((x) => x.length >= 2).slice(0, 8);
        const hits = tokens.filter((x) => actual.includes(x)).length;
        if (hits) score += Math.min(50, hits * 12);
      }
    }
    return score;
  }

  function getContextSiblingIndex(el) {
    const root = getContextControlRoot(el);
    if (!root || !root.parentElement) return -1;
    const kind = getContextControlKind(root);
    const selector = kind === 'combobox'
      ? '.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"],select'
      : root.tagName.toLowerCase();
    try {
      const list = Array.from(root.parentElement.querySelectorAll(`:scope > ${selector}`));
      const idx = list.indexOf(root);
      if (idx >= 0) return idx;
    } catch (e) { /* ignore */ }
    try {
      const scope = root.closest('.ant-form,.ivu-form,.el-form,form,[role="form"]') || root.parentElement;
      const list = Array.from(scope.querySelectorAll(selector)).filter(isDomVisible);
      return list.indexOf(root);
    } catch {
      return -1;
    }
  }

  function scoreElementAgainstContext(el, ctx) {
    if (!el || !ctx) return 0;
    let score = 0;
    const root = getContextControlRoot(el);
    if (isDomVisible(root || el)) score += 100;
    const kind = getContextControlKind(el);
    if (ctx.control_kind && kind === ctx.control_kind) score += 16;

    const expectedLabel = normLocatorText(ctx.label_text).toLowerCase();
    if (expectedLabel) {
      const actualLabel = getContextLabelText(el).toLowerCase();
      const container = getContextContainerText(el).toLowerCase();
      if (actualLabel === expectedLabel) score += 80;
      else if (actualLabel && (actualLabel.includes(expectedLabel) || expectedLabel.includes(actualLabel))) score += 45;
      if (container.includes(expectedLabel)) score += 30;
    }

    const expectedContainer = normLocatorText(ctx.container_text).toLowerCase();
    if (expectedContainer) {
      const actualContainer = getContextContainerText(el).toLowerCase();
      if (actualContainer === expectedContainer) score += 45;
      else {
        const tokens = expectedContainer.split(/\s+/).filter((t) => t.length >= 2).slice(0, 10);
        const hits = tokens.filter((t) => actualContainer.includes(t)).length;
        if (hits) score += Math.min(35, hits * 7);
      }
    }

    const expectedIndex = Number(ctx.sibling_index);
    if (Number.isInteger(expectedIndex) && expectedIndex >= 0) {
      const actualIndex = getContextSiblingIndex(el);
      if (actualIndex === expectedIndex) score += 55;
      else if (actualIndex >= 0) score -= Math.min(24, Math.abs(actualIndex - expectedIndex) * 8);
    }

    if (ctx.rect && root?.getBoundingClientRect) {
      const r = root.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const ecx = Number(ctx.rect.left || 0) + Number(ctx.rect.width || 0) / 2;
      const ecy = Number(ctx.rect.top || 0) + Number(ctx.rect.height || 0) / 2;
      const vw = Number(ctx.rect.viewportWidth || window.innerWidth || 1);
      const vh = Number(ctx.rect.viewportHeight || window.innerHeight || 1);
      const dist = Math.sqrt(Math.pow((cx - ecx) / vw, 2) + Math.pow((cy - ecy) / vh, 2));
      score += Math.max(0, 28 - dist * 80);
    }
    if (Array.isArray(ctx.state_classes) && ctx.state_classes.length) {
      const classSet = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      const rootClassSet = root && root !== el
        ? new Set(String(root.className || '').split(/\s+/).filter(Boolean))
        : classSet;
      let hits = 0;
      for (const cls of ctx.state_classes) {
        if (classSet.has(cls) || rootClassSet.has(cls)) hits += 1;
      }
      if (hits) score += Math.min(12, hits * 4);
    }
    score += scoreTableContext(el, ctx);
    return score;
  }

  function pickBestContextMatch(nodes, ctx) {
    const arr = [...nodes].filter(Boolean);
    if (!arr.length) return null;
    if (!ctx) return pickTopmostDialogMatch(arr);
    const scored = arr.map((node, ord) => ({ node, score: scoreElementAgainstContext(node, ctx), ord }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.ord - b.ord;
    });
    return scored[0]?.node || pickTopmostDialogMatch(arr);
  }

  function findXPathMatches(xpRaw) {
    let x = xpRaw;
    if (x && !x.startsWith('//') && !x.startsWith('/html') && !x.startsWith('/*')) {
      x = `/${x}`;
    }
    try {
      const result = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const n = result.snapshotItem(i);
        if (n && n.nodeType === Node.ELEMENT_NODE) nodes.push(n);
      }
      return nodes;
    } catch {
      return [];
    }
  }

  function findByLocatorMeta(metaRaw) {
    const meta = parseLocatorMeta(metaRaw);
    const ctx = getLocatorContext(metaRaw);
    const candidates = Array.isArray(meta?.candidates) ? [...meta.candidates] : [];
    if (!candidates.length) return null;
    candidates.sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
    for (const c of candidates) {
      const type = String(c?.type || '');
      const value = String(c?.value || '');
      if (!value) continue;
      try {
        if (type.startsWith('css_') || type.startsWith('component_root_') || type === 'table_cell_css') {
          const list = document.querySelectorAll(value);
          if (list.length === 1) return list[0];
          if (list.length > 1) {
            const best = pickBestContextMatch(list, ctx);
            if (best) return best;
          }
          continue;
        }
        if (type === 'table_cell_xpath' || type === 'xpath_fallback') {
          const matches = findXPathMatches(value);
          const el = matches.length > 1 ? pickBestContextMatch(matches, ctx) : matches[0];
          if (el) return el;
          continue;
        }
        if (type === 'text_exact') {
          const el = findByTextExact(value);
          if (el) return el;
          continue;
        }
        if (type === 'text_exact_tag') {
          const idx = value.indexOf('::');
          if (idx > 0) {
            const el = findByTagAndTextExact(value.slice(0, idx), value.slice(idx + 2));
            if (el) return el;
          }
        }
        if (type === 'tree_interaction') {
          const el = findTreeInteraction(value);
          if (el) return el;
        }
        if (type === 'tree_node_text') {
          const el = findTreeNodeByText(value);
          if (el) return el;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // 查找元素：非 #id 时优先 XPath；忽略 rc_* 自增 id（勾选后重渲染会变），必要时兜底 Ant Select 搜索框
  function findElement(selector, xpath, locatorMeta) {
    const ctx = getLocatorContext(locatorMeta);
    const fromMeta = findByLocatorMeta(locatorMeta);
    if (fromMeta) return fromMeta;

    const hadVolatileRc = isVolatileRcCss(selector || '') || isVolatileRcXPath(xpath || '');
    let sel = selector || '';
    let xp = xpath || '';
    if (isVolatileRcCss(sel)) sel = '';
    if (isVolatileRcXPath(xp)) xp = '';

    let el = null;
    const cssIsId = sel && /^#[\w-]+$/.test(sel);
    if (cssIsId && sel) {
      try { el = document.querySelector(sel); } catch (e) {}
    }
    if (!el && xp) {
      const matches = findXPathMatches(xp);
      el = matches.length > 1 ? pickBestContextMatch(matches, ctx) : matches[0];
    }
    if (!el && sel && !cssIsId) {
      try {
        const list = document.querySelectorAll(sel);
        if (list.length === 1) el = list[0];
        else if (list.length > 1) {
          el = pickBestContextMatch(list, ctx);
        }
      } catch (e) {}
    }
    if (!el && hadVolatileRc) el = findAntSelectSearchFallback();
    if (!el) el = findIvuTableCellFallback(selector, xpath, locatorMeta);
    if (!el) el = findIvuRadioInputFallback(selector, xpath);
    // 先 XPath 命中、后有多条 CSS 时：用弹窗/堆叠优先（全局 confirm 与页面内同文案按钮共存）
    if (el && sel && !cssIsId) {
      try {
        const nl = document.querySelectorAll(sel);
        if (nl.length > 1) {
          const best = ctx ? pickBestContextMatch(nl, ctx) : (
            sel.includes('ant-select-selection-search-input')
              ? pickAntSelectInputByTableXPathHint(xp, nl)
              : pickTopmostDialogMatch(nl)
          );
          if (best) el = best;
        } else if (nl.length === 1 && nl[0] !== el && isDomVisible(nl[0]) && !isDomVisible(el)) {
          el = nl[0];
        }
      } catch (e) { /* ignore */ }
    }
    // XPath 先命中但已过时、与「多匹配 CSS」不一致时，用表格行列提示纠正
    if (el && sel && !cssIsId && sel.includes('ant-select-selection-search-input')) {
      try {
        const nl = document.querySelectorAll(sel);
        if (nl.length > 1 && ![...nl].includes(el)) {
          const hinted = pickAntSelectInputByTableXPathHint(xp, nl);
          if (hinted) el = hinted;
        }
      } catch (e) { /* ignore */ }
    }
    return el;
  }

  const OVERLAY_CONTAINER_SEL = '.ivu-select-dropdown,.el-select-dropdown,.ant-select-dropdown,.v-menu__content,.vs__dropdown-menu,.el-popper';
  /** iView Poptip / Modal：确定、取消等按钮不在下拉 li 里，需单独扫描 */
  const POPUP_OVERLAY_SEL = '.ivu-tooltip-popper, .ivu-poptip-popper, .ivu-modal-wrap .ivu-modal';

  function collectCustomOverlayContainers() {
    const seen = new Set();
    const out = [];
    const add = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || seen.has(el)) return;
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') return;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) return;
      seen.add(el);
      out.push(el);
    };
    for (const child of document.body.children) {
      add(child);
      if (child.children) {
        for (const inner of child.children) add(inner);
      }
    }
    for (const btn of document.querySelectorAll('button, [role="menuitem"]')) {
      let cur = btn.parentElement;
      while (cur && cur !== document.body) {
        const p = window.getComputedStyle(cur).position;
        if (p === 'fixed' || p === 'absolute') {
          add(cur);
          break;
        }
        cur = cur.parentElement;
      }
    }
    return out;
  }

  function overlayItemTexts(el) {
    const full = el.textContent.trim().replace(/\s+/g, ' ');
    const texts = [full];
    try {
      const title = el.querySelector('.truncate, [class*="font-medium"]');
      if (title) {
        const t = title.textContent.trim().replace(/\s+/g, ' ');
        if (t && !texts.includes(t)) texts.push(t);
      }
    } catch (e) { /* ignore */ }
    return texts;
  }

  function textsMatchItem(texts, needle) {
    for (const t2 of texts) {
      if (t2 === needle) return { exact: true };
      if (needle.length >= 1 && t2.includes(needle)) return { exact: false };
    }
    return null;
  }

  /** 多下拉同时展开时按 z-index、精确匹配优先 */
  function findOverlayOptionByText(text) {
    if (!text) return null;
    const needle = text.trim().replace(/\s+/g, ' ');
    function zIndex(el) {
      let z = 0;
      let cur = el;
      while (cur && cur !== document.body) {
        const zi = parseInt(window.getComputedStyle(cur).zIndex, 10);
        if (!isNaN(zi) && zi > z) z = zi;
        cur = cur.parentElement;
      }
      return z;
    }
    const candidates = [];
    let order = 0;

    const dropdownContainers = Array.from(document.querySelectorAll(OVERLAY_CONTAINER_SEL)).filter((container) => {
      const r = container.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    for (const container of dropdownContainers) {
      const cz = zIndex(container);
      const items = container.querySelectorAll(
        'li, [role="option"], [role="menuitem"], .ivu-select-item, .el-select-dropdown__item, .el-option, .ant-select-item, .ant-select-item-option-content',
      );
      for (const item of items) {
        const t2 = item.textContent.trim().replace(/\s+/g, ' ');
        const exact = t2 === needle;
        const inc = !exact && needle.length >= 1 && t2.includes(needle);
        if (exact || inc) {
          const r = item.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            candidates.push({ item, exact, score: cz + zIndex(item), ord: order++ });
          }
        }
      }
    }

    const popupContainers = Array.from(document.querySelectorAll(POPUP_OVERLAY_SEL)).filter((container) => {
      const r = container.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const popupItemSel = 'button, .ivu-btn, a.ivu-btn, .el-button, [role="button"]';
    for (const container of popupContainers) {
      const cz = zIndex(container);
      for (const item of container.querySelectorAll(popupItemSel)) {
        const t2 = item.textContent.trim().replace(/\s+/g, ' ');
        const exact = t2 === needle;
        const inc = !exact && needle.length >= 1 && t2.includes(needle);
        if (exact || inc) {
          const r = item.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            candidates.push({ item, exact, score: cz + zIndex(item), ord: order++ });
          }
        }
      }
    }

    // 自定义浮层 / 二次子菜单（Teleport + Transition 内层 fixed 面板）
    const customItemSel = 'button, [role="menuitem"], li, [role="option"]';
    for (const ccontainer of collectCustomOverlayContainers()) {
      const cz = zIndex(ccontainer);
      for (const item of ccontainer.querySelectorAll(customItemSel)) {
        const m = textsMatchItem(overlayItemTexts(item), needle);
        if (m) {
          const r = item.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            candidates.push({ item, exact: !!m.exact, score: cz + zIndex(item), ord: order++ });
          }
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return b.ord - a.ord;
    });
    return candidates[0]?.item || null;
  }

  /** 与 cuecast/modules/player-manager.js 中 PAGE_LOADING_UI_CHECK 语义一致 */
  const LOADING_WAIT_WALL_MS = 180000;

  function isPageLoadingUi() {
    try {
      if (document.querySelector('[aria-busy="true"]')) return true;
      const nodes = document.querySelectorAll(
        '.ivu-spin-fix .ivu-spin-main,.ivu-table-wrapper .ivu-spin-main,.ivu-table-with-loading .ivu-spin,'
        + '.ivu-spin.ivu-spin-fix .ivu-spin-main,.ivu-load-loop,.ant-spin-spinning,.ant-spin-nested-loading .ant-spin,'
        + '.el-loading-mask,.el-loading-spinner,.el-icon-loading,.v-loading-parent--relative .v-loading,'
        + '[data-loading="true"]',
      );
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) continue;
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 须与 cuecast/modules/player-manager.js 中 DEFAULT_PAGE_ERROR_KEYWORDS 保持一致 */
  const PAGE_ERROR_KEYWORDS = [
    '请求失败', '加载失败', '网络错误', '网络异常', '系统异常', '操作失败', '登录失败',
    '权限不足', '无权限', '访问被拒绝', '服务异常', '服务器错误', '请稍后重试', '接口异常',
    'Internal Server Error', 'Bad Gateway', 'Network Error', 'Failed to fetch', 'Gateway Timeout',
  ];

  function detectPageErrorSignal(force = false) {
    if (!force && !pageErrorCheckEnabled) return null;
    try {
      const text = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 24000) : '';
      for (const k of PAGE_ERROR_KEYWORDS) {
        if (!k) continue;
        const idx = text.toLowerCase().indexOf(k.toLowerCase());
        if (idx >= 0) {
          const snip = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + k.length + 120)).replace(/\s+/g, ' ').trim();
          return { hit: true, keyword: k, snippet: snip };
        }
      }
      const errSel = '.ivu-message-error,.ivu-notice-error,.el-message--error,.ant-message-error,.ant-message-error .ant-message-content,.arco-message-error,.alert-danger,.alert-error,.ivu-alert-error,.t-message--error';
      const nodes = document.querySelectorAll(errSel);
      for (let j = 0; j < nodes.length; j++) {
        const el = nodes[j];
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) continue;
        const t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 400);
        if (t.length > 0) return { hit: true, keyword: '[页面错误提示]', snippet: t };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function waitForOverlayOption(text, timeout = 6000) {
    return new Promise((resolve) => {
      let remaining = timeout;
      const wallEnd = Date.now() + LOADING_WAIT_WALL_MS;
      const check = () => {
        const pe = detectPageErrorSignal();
        if (pe && pe.hit) {
          throw new Error(
            tr(
              `页面出现错误提示，已中止回放：${pe.keyword}\n${pe.snippet ? `摘录：${pe.snippet}` : ''}`,
              `Page error detected, playback stopped: ${pe.keyword}\n${pe.snippet ? `Snippet: ${pe.snippet}` : ''}`,
            ),
          );
        }
        const loading = isPageLoadingUi();
        const el = findOverlayOptionByText(text);
        if (el) { resolve(el); return; }
        if (Date.now() >= wallEnd || remaining <= 0) { resolve(null); return; }
        setTimeout(check, 400);
        if (!loading) remaining -= 400;
      };
      check();
    });
  }

  // 非浮层场景：仅精确文本匹配（避免 includes 误命中）
  function findByTextExact(text) {
    if (!text) return null;
    const normalized = text.trim().replace(/\s+/g, ' ');
    const candidates = document.querySelectorAll('li, option, [role="option"], [role="menuitem"]');
    for (const el of candidates) {
      if (el.textContent.trim().replace(/\s+/g, ' ') === normalized) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) return el;
      }
    }
    return null;
  }

  function isDisabled(el) {
    if (!el) return false;
    const disabledClassRe = /(?:^|\s)(?:[a-z]+-)?disabled(?:\s|$)/i;
    const formControlSel = 'button,input,select,textarea,option,optgroup';
    const componentRootSel = [
      '.el-select', '.ivu-select', '.ant-select', '.v-select', '.vs__dropdown-toggle', '[role="combobox"]',
      '.el-button', '.ivu-btn', '.ant-btn', '[role="button"]',
      '.el-radio', '.ivu-radio-wrapper', '.ant-radio-wrapper',
      '.el-checkbox', '.ivu-checkbox-wrapper', '.ant-checkbox-wrapper',
      '.el-input', '.ivu-input-wrapper', '.ant-input-affix-wrapper',
      '.el-cascader', '.ivu-cascader', '.ant-cascader', '.ant-cascader-picker',
      '.el-switch', '.ivu-switch', '.ant-switch',
      '.el-slider', '.ivu-slider', '.ant-slider',
      '.el-date-editor', '.ivu-date-picker', '.ant-picker',
      '.el-input-number', '.ivu-input-number', '.ant-input-number',
      '.el-autocomplete', '.el-upload',
      '.t-select', '.t-button', '.t-radio', '.t-checkbox', '.t-switch',
      '.arco-select', '.arco-btn', '.arco-radio', '.arco-checkbox', '.arco-switch',
      '.n-select', '.n-button', '.n-radio', '.n-checkbox', '.n-switch',
      '.MuiButton-root', '.MuiSelect-root', '.MuiInputBase-root', '.MuiSwitch-root',
    ].join(',');

    if (el.disabled || el.getAttribute?.('disabled') !== null) return true;
    if (el.getAttribute?.('aria-disabled') === 'true') return true;
    const ownerControl = el.closest?.(formControlSel);
    if (ownerControl) {
      if (ownerControl.disabled || ownerControl.getAttribute?.('disabled') !== null) return true;
      if (ownerControl.getAttribute?.('aria-disabled') === 'true') return true;
      const fieldset = ownerControl.closest?.('fieldset[disabled]');
      if (fieldset) return true;
    }

    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.matches?.(componentRootSel)) {
        if (cur.disabled || cur.getAttribute?.('disabled') !== null) return true;
        if (cur.getAttribute?.('aria-disabled') === 'true') return true;
        if (disabledClassRe.test(String(cur.className || ''))) return true;
      }
      cur = cur.parentElement;
    }

    if (disabledClassRe.test(String(el.className || ''))) return true;
    return false;
  }

  /**
   * iView/Ant 等将原生 radio/checkbox 设为 0×0 时，用外层可点击块参与等待滚动与点击。
   * disabled 仍以原生 input 为准（在 waitForElement 里先校验再替换）。
   */
  function resolveVisibleClickTarget(el) {
    if (!el) return el;
    const tagName = (el.tagName || '').toLowerCase();
    const vtreeExpandToggle = el.closest?.('.vtree-tree-node__square.vtree-tree-node__expand');
    if (vtreeExpandToggle) {
      const tr = vtreeExpandToggle.getBoundingClientRect();
      if (tr.width > 0 || tr.height > 0) return vtreeExpandToggle;
    }
    if (tagName === 'use' || tagName === 'path') {
      const svg = el.closest?.('svg');
      if (svg) {
        const sr = svg.getBoundingClientRect();
        if (sr.width > 0 || sr.height > 0) return svg;
      }
    }
    if (el.matches?.('.ivu-select,.ant-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]')) {
      const inner = el.querySelector(
        '.ivu-select-selection,.ant-select-selector,.el-input,.el-select__wrapper,.vs__dropdown-toggle,[role="textbox"],input',
      );
      if (inner) {
        const ir = inner.getBoundingClientRect();
        if (ir.width > 0 || ir.height > 0) return inner;
      }
    }
    let r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return el;
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'radio' || t === 'checkbox') {
        const wrap = el.closest(
          '.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, label, .ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox',
        );
        if (wrap) {
          const r2 = wrap.getBoundingClientRect();
          if (r2.width > 0 || r2.height > 0) return wrap;
        }
      }
    }
    return el;
  }

  function waitForElement(selector, xpath, textFallback = '', timeout = 5000, skipDisabledCheck = false, locatorMeta = null, skipPageErrorCheck = false) {
    return new Promise((resolve) => {
      let remaining = timeout;
      const wallEnd = Date.now() + LOADING_WAIT_WALL_MS;
      const check = () => {
        const pe = skipPageErrorCheck ? null : detectPageErrorSignal();
        if (pe && pe.hit) {
          throw new Error(
            tr(
              `页面出现错误提示，已中止回放：${pe.keyword}\n${pe.snippet ? `摘录：${pe.snippet}` : ''}`,
              `Page error detected, playback stopped: ${pe.keyword}\n${pe.snippet ? `Snippet: ${pe.snippet}` : ''}`,
            ),
          );
        }
        const loading = isPageLoadingUi();
        let el = findElement(selector, xpath, locatorMeta);
        if (!el && textFallback) el = findByTextExact(textFallback);
        if (el) {
          if (!skipDisabledCheck && isDisabled(el)) {
            if (Date.now() < wallEnd && remaining > 0) {
              setTimeout(check, 400);
              if (!loading) remaining -= 400;
              return;
            }
            resolve(null);
            return;
          }
          const clickEl = resolveVisibleClickTarget(el);
          const r = clickEl.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            clickEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            resolve(clickEl);
            return;
          }
        }
        if (Date.now() >= wallEnd || remaining <= 0) {
          resolve(null);
          return;
        }
        setTimeout(check, 400);
        if (!loading) remaining -= 400;
      };
      check();
    });
  }

  // 滚动元素到视口
  function scrollIntoView(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function isAntSelectSearchInput(el) {
    return el && el.tagName === 'INPUT' && el.classList?.contains('ant-select-selection-search-input');
  }

  function sameRecordedTarget(a, b) {
    if (!a || !b) return false;
    const sa = String(a.target_selector || '').trim();
    const sb = String(b.target_selector || '').trim();
    const xa = String(a.target_xpath || '').trim();
    const xb = String(b.target_xpath || '').trim();
    if (sa && sb && sa === sb) return true;
    if (xa && xb && xa === xb) return true;
    return false;
  }

  function stepLooksLikeAntSelectSearch(step) {
    const raw = [
      step?.target_selector,
      step?.target_xpath,
      typeof step?.locator_meta === 'string' ? step.locator_meta : JSON.stringify(step?.locator_meta || ''),
    ].join(' ');
    return raw.includes('ant-select-selection-search-input');
  }

  function stepLooksLikeMonacoEditor(step) {
    const meta = parseLocatorMeta(step?.locator_meta);
    if (meta?.context?.editor === 'monaco') return true;
    const raw = [
      step?.target_selector,
      step?.target_xpath,
      typeof step?.locator_meta === 'string' ? step.locator_meta : JSON.stringify(step?.locator_meta || ''),
    ].join(' ');
    return raw.includes('monaco-editor') || raw.includes('monaco-diff-editor');
  }

  function nextStepIsSameTargetEnter(step, nextStep) {
    return String(step?.action_type || '').toLowerCase() === 'input'
      && String(nextStep?.action_type || '').toLowerCase() === 'key'
      && String(nextStep?.value || 'Enter') === 'Enter'
      && sameRecordedTarget(step, nextStep);
  }

  /** Ant Select 可搜索场景下，输入后常需 Enter 确认；漏录 key 步时由回放补发 */
  function dispatchEnterConfirm(el) {
    const k = 'Enter';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    try {
      el.dispatchEvent(new KeyboardEvent('keypress', { key: k, keyCode: 13, bubbles: true, cancelable: true }));
    } catch (e) { /* ignore */ }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
  }

  // 触发 React/Vue 兼容的 input 事件
  function triggerInputEvent(el, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dispatchKeyboardKey(el, key, options = {}) {
    const init = {
      key,
      code: options.code || key,
      keyCode: options.keyCode || 0,
      which: options.keyCode || 0,
      ctrlKey: !!options.ctrlKey,
      metaKey: !!options.metaKey,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function triggerMonacoInput(el, value) {
    const root = el?.closest?.('.monaco-editor, .monaco-diff-editor') || el;
    const target = root?.querySelector?.('textarea.inputarea, textarea') || root;
    if (!target) return false;
    try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) { /* ignore */ } }
    dispatchKeyboardKey(target, 'a', { code: 'KeyA', keyCode: 65, metaKey: true });
    dispatchKeyboardKey(target, 'a', { code: 'KeyA', keyCode: 65, ctrlKey: true });
    dispatchKeyboardKey(target, 'Backspace', { code: 'Backspace', keyCode: 8 });
    const text = String(value || '');
    if (text) {
      try { document.execCommand('insertText', false, text); } catch (e) { /* ignore */ }
    }
    return true;
  }

  // 执行单步操作
  async function executeStep(step, nextStep = null) {
    if (step.wait_before && step.wait_before > 0) {
      await sleep(step.wait_before);
    }

    const actionType = String(step.action_type || '').trim().toLowerCase();
    const errSig = actionType === 'assert_text' ? null : detectPageErrorSignal();
    if (errSig && errSig.hit) {
      throw new Error(
        tr(
          `页面出现错误提示，已中止回放：${errSig.keyword}\n${errSig.snippet ? `摘录：${errSig.snippet}` : ''}`,
          `Page error detected, playback stopped: ${errSig.keyword}\n${errSig.snippet ? `Snippet: ${errSig.snippet}` : ''}`,
        ),
      );
    }

    switch (actionType) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        const revealTrigger = extractRevealTriggerFromLocatorMeta(step.locator_meta);
        if (revealTrigger) {
          try { await activateRevealTrigger(revealTrigger); } catch (e) { /* ignore */ }
          await sleep(450);
        }
        // 自动识别浮层选项步骤（兼容旧版录制数据）
        // is_overlay 且 value 为空时勿走「按文案点下拉项」（Poptip 内 textarea 等易被误判为浮层）
        const looksLikeOverlay = (step.is_overlay && String(step.value || '').trim() !== '')
          || (!step.target_selector && step.value)
          || (step.target_xpath && step.target_xpath.includes('normalize-space()'));

        let el = null;
        if (looksLikeOverlay && step.value) {
          el = await waitForOverlayOption(step.value, 6000);
        }
        if (!el) {
          el = await waitForElement(
            step.target_selector,
            step.target_xpath,
            looksLikeOverlay ? '' : '',
            6000,
            looksLikeOverlay,
            step.locator_meta
          );
        }
        if (!el) throw new Error(formatElementNotFound(step, true));
        scrollIntoView(el);
        await sleep(200);
        dispatchMouseLike(el, actionType);
        if (step.is_overlay) await sleep(300);
        break;
      }

      case 'input': {
        const el = await waitForElement(step.target_selector, step.target_xpath, '', 6000, false, step.locator_meta);
        if (!el) throw new Error(formatElementNotFound(step));
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(40);
        if (stepLooksLikeMonacoEditor(step)) {
          triggerMonacoInput(el, step.value || '');
          await sleep(120);
          break;
        }
        const ae = document.activeElement;
        if (ae && ae !== el && isTextLikeField(ae)) {
          try { ae.blur(); } catch (e) { /* ignore */ }
        }
        activateFieldWithoutBubble(el);
        await sleep(60);
        triggerInputEvent(el, step.value || '');
        if (isAntSelectSearchInput(el) && !nextStepIsSameTargetEnter(step, nextStep)) {
          await sleep(100);
          dispatchEnterConfirm(el);
        }
        await sleep(80);
        break;
      }

      case 'key': {
        let el = await waitForElement(step.target_selector, step.target_xpath, '', 6000, false, step.locator_meta);
        if (!el) el = getFocusedKeyboardTarget();
        if (!el) throw new Error(formatElementNotFound(step));
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(40);
        const aek = document.activeElement;
        if (aek && aek !== el && isTextLikeField(aek)) {
          try { aek.blur(); } catch (e) { /* ignore */ }
        }
        activateFieldWithoutBubble(el);
        await sleep(50);
        const k = step.value || 'Enter';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        if (k === 'Enter') {
          try {
            el.dispatchEvent(new KeyboardEvent('keypress', { key: k, keyCode: 13, bubbles: true, cancelable: true }));
          } catch (e) { /* ignore */ }
        }
        el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
        await sleep(60);
        break;
      }

      case 'scroll': {
        const el = findElement(step.target_selector, step.target_xpath, step.locator_meta);
        if (el) {
          scrollIntoView(el);
        } else {
          window.scrollTo(0, step.value ? parseInt(step.value) : 500);
        }
        await sleep(500);
        break;
      }

      case 'navigate': {
        if (step.value) window.location.href = step.value;
        else if (step.url) window.location.href = step.url;
        await sleep(1000);
        break;
      }

      case 'hover': {
        const el = await waitForElement(step.target_selector, step.target_xpath, '', 5000, false, step.locator_meta);
        if (!el) throw new Error(formatElementNotFound(step));
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(80);
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const common = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        try {
          el.dispatchEvent(new PointerEvent('pointerover', { ...common, pointerId: 1, pointerType: 'mouse' }));
        } catch (e) { /* ignore */ }
        el.dispatchEvent(new MouseEvent('mousemove', common));
        el.dispatchEvent(new MouseEvent('mouseover', common));
        el.dispatchEvent(new MouseEvent('mouseenter', { ...common, bubbles: false }));
        await sleep(350);
        break;
      }

      case 'assert_text': {
        const expected = step.value != null ? String(step.value) : '';
        if (expected.trim() === '') {
          throw new Error(tr('断言失败：未配置断言文本（「输入值」不能为空或仅空白）', 'Assertion failed: expected text is not configured (input value cannot be empty or whitespace only)'));
        }

        const hasLocator = String(step.target_selector || '').trim() !== '' || String(step.target_xpath || '').trim() !== '';
        const PREVIEW_MAX = 8000;
        const assertion = resolveAssertionConfig(step, hasLocator);

        if (assertion.target === 'error') {
          const actual = await waitForPageErrorText(10000);
          const hit = matchAssertionText(actual, expected, assertion.match);
          try {
            chrome.runtime.sendMessage({
              type: 'AT_ASSERT_TEXT_DEBUG',
              payload: {
                mode: `error_${assertion.match}`,
                needleLen: expected.length,
                needlePreview: expected.length > PREVIEW_MAX ? expected.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expected,
                pageLen: actual.length,
                pagePreview: actual.length > PREVIEW_MAX ? actual.slice(0, PREVIEW_MAX) + '\n…(已截断)' : actual,
                hit,
                css: '',
                xpath: '',
                note: '错误提示断言：匹配常见 toast/message/dialog 错误区域',
              },
            }).catch(() => {});
          } catch (e) {
            /* ignore */
          }
          if (!hit) {
            throw new Error(tr(`断言失败：错误提示未满足预期 "${expected.slice(0, 200)}"`, `Assertion failed: error message did not match "${expected.slice(0, 200)}"`));
          }
          break;
        }

        if (assertion.target === 'element') {
          const el = await waitForElement(step.target_selector, step.target_xpath, '', 10000, false, step.locator_meta, true);
          if (!el) {
            throw new Error(tr(
              `断言失败：找不到目标元素${formatTreeWaitDiagnostic(step.locator_meta)}\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
              `Assertion failed: target element not found\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
            ));
          }
          const actual = getElementRawTextForAssert(el);
          const hit = matchAssertionText(actual, expected, assertion.match);

          console.log(
            '[AT assert_text] 元素断言 · 完整日志见扩展 Service Worker。预期',
            expected.length,
            '字 / 实际',
            actual.length,
            '字 / 全等',
            hit,
          );

          try {
            chrome.runtime.sendMessage({
              type: 'AT_ASSERT_TEXT_DEBUG',
              payload: {
                mode: 'element',
                needleLen: expected.length,
                needlePreview: expected.length > PREVIEW_MAX ? expected.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expected,
                pageLen: actual.length,
                pagePreview: actual.length > PREVIEW_MAX ? actual.slice(0, PREVIEW_MAX) + '\n…(已截断)' : actual,
                hit,
                css: step.target_selector || '',
                xpath: step.target_xpath || '',
                note: '已按 CSS/XPath 定位元素；textarea/input 取 value，其它取 textContent；按断言匹配方式比对',
              },
            }).catch(() => {});
          } catch (e) {
            /* ignore */
          }

          if (!hit) {
            throw new Error(tr('断言失败：元素内容与「输入值」不一致', 'Assertion failed: element content does not match input value'));
          }
          break;
        }

        // 未填选择器：兼容旧行为 — 整页 innerText 是否包含预期子串
        const pageText = document.body.innerText || '';
        const needlePreview = expected.length > PREVIEW_MAX ? expected.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expected;
        const pagePreview = pageText.length > PREVIEW_MAX
          ? pageText.slice(0, PREVIEW_MAX) + '\n…(已截断，共 ' + pageText.length + ' 字)'
          : pageText;
        const finalHit = matchAssertionText(pageText, expected, assertion.match);

        console.log(
          '[AT assert_text] 整页子串 · 完整日志见扩展 Service Worker。预期',
          expected.length,
          '字 / 页',
          pageText.length,
          '字 / 包含',
          finalHit,
        );

        try {
          chrome.runtime.sendMessage({
            type: 'AT_ASSERT_TEXT_DEBUG',
            payload: {
              mode: 'whole_page_substring',
              needleLen: expected.length,
              needlePreview,
              pageLen: pageText.length,
              pagePreview,
              hit: finalHit,
              css: '',
              xpath: '',
              note: '未填 CSS/XPath：整页 innerText 是否包含「输入值」子串；需要按元素比对时请填写选择器',
            },
          }).catch(() => {});
        } catch (e) {
          /* ignore */
        }

        if (!finalHit) {
          const preview = expected.length > 200 ? `${expected.slice(0, 200)}…` : expected;
          throw new Error(tr(`断言失败：页面中未找到文本 "${preview}"`, `Assertion failed: text not found on page "${preview}"`));
        }
        break;
      }

      case 'wait': {
        await sleep(step.value ? parseInt(step.value) : 1000);
        break;
      }

      case 'ai_natural': {
        throw new Error(tr('「智能自然语言」步骤需由扩展后台以 CDP 模式执行，当前为纯 DOM 降级路径', 'AI natural-language step must run via extension background in CDP mode; current path is DOM fallback'));
      }

      case 'assert_json': {
        throw new Error(tr('「JSON 断言」步骤需由扩展后台以 CDP 执行并在后端比对，当前为纯 DOM 降级路径', 'JSON assertion step must run via extension background in CDP mode and be compared on backend; current path is DOM fallback'));
      }

      default:
        throw new Error(tr(`未知或不支持的操作类型: ${step.action_type || '(空)'}`, `Unknown or unsupported action type: ${step.action_type || '(empty)'}`));
    }
  }

  // 高亮当前执行的元素
  function highlightElement(step) {
    document.querySelectorAll('.__at_playing__').forEach(el => el.classList.remove('__at_playing__'));
    const el = findElement(step.target_selector, step.target_xpath, step.locator_meta);
    if (el) {
      el.classList.add('__at_playing__');
      setTimeout(() => el.classList.remove('__at_playing__'), 1000);
    }
  }

  // 注入高亮样式
  if (!document.getElementById('__at_player_style__')) {
    const style = document.createElement('style');
    style.id = '__at_player_style__';
    style.textContent = `.__at_playing__ { outline: 3px solid #4caf50 !important; outline-offset: 2px !important; transition: outline 0.1s; }`;
    document.head.appendChild(style);
  }

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AT_EXECUTE_STEP') {
      currentLocale = normalizeLocale(message.locale);
      pageErrorCheckEnabled = message.pageErrorCheckEnabled === true;
      const step = message.step;
      const nextStep = message.nextStep || null;
      highlightElement(step);
      let responded = false;
      const done = (payload) => {
        if (responded) return;
        responded = true;
        try {
          sendResponse(payload);
        } catch (e) {
          /* 通道已关闭等 */
        }
      };
      (async () => {
        try {
          await executeStep(step, nextStep);
          done({ ok: true });
        } catch (err) {
          const msg = err && err.message != null ? String(err.message) : String(err);
          done({ ok: false, error: msg });
        }
      })();
      return true; // 异步响应
    }

    if (message.type === 'AT_PLAYER_CLEANUP') {
      document.querySelectorAll('.__at_playing__').forEach(el => el.classList.remove('__at_playing__'));
      window.__AT_PLAYER_ACTIVE__ = false;
      sendResponse({ ok: true });
    }
  });

})();
