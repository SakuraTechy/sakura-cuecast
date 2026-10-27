/**
 * Recorder Content Script
 * 注入到目标测试页面，监听用户操作并生成步骤数据
 * 由 background.js 通过 chrome.scripting.executeScript 动态注入
 */

(function () {
  'use strict';

  if (window.__AT_RECORDER_ACTIVE__) return;
  window.__AT_RECORDER_ACTIVE__ = true;

  let isRecording = false;
  let isPaused = false;
  let screenshotMode = 'standard';
  let currentLocale = String(chrome.i18n?.getUILanguage?.() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  let highlightEl = null;

  function normalizeLocale(locale) {
    return String(locale || '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function tr(zh, en) {
    return currentLocale === 'en' ? (en || zh) : zh;
  }

  // =========================================================
  // 元素选择器生成算法
  // =========================================================
  function normalizeAttrValue(value) {
    return String(value || '').trim();
  }

  function hasLongRandomSegment(value) {
    const v = normalizeAttrValue(value);
    if (!v) return false;
    if (/[a-f0-9]{8,}/i.test(v)) return true;
    if (/[a-z0-9]{10,}/i.test(v) && /\d/.test(v) && /[a-z]/i.test(v)) return true;
    return false;
  }

  /** React/Vue/组件库等运行时自增 id，重渲染后会变，不能用于稳定定位 */
  function isVolatileAutoId(id) {
    const v = normalizeAttrValue(id);
    if (!v) return true;
    if (/^\d+$/.test(v)) return true;
    if (/^[0-9]{10,}$/.test(v)) return true;
    if (/^[a-f0-9]{8,}$/i.test(v)) return true;
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)) return true;
    if (/^(?:id|input|select|dropdown|listbox|menu|tooltip|popover|dialog|panel|option|item|field|label|form)[-_]?\d+$/i.test(v)) return true;
    if (/^(?:input|select|dropdown|listbox|menu|tooltip|popover|dialog|panel|option|item|field|label|form)[-_][a-z0-9]{6,}$/i.test(v)) return true;
    if (/^(?:el-id|el-popper|el-tooltip|el-popover|el-select|el-cascader|el-date-picker)-\d+(?:-\d+)*$/i.test(v)) return true;
    // ant-design / rc-select / rc-input 等：rc_xxx_数字
    if (/^rc_[a-z0-9_]+_\d+$/i.test(v)) return true;
    if (/^rc_[a-z0-9_]+_\d+(?:_[a-z0-9]+)*$/i.test(v)) return true;
    // React useId 常见形式
    if (/^:r[a-z0-9]*:$/i.test(v)) return true;
    if (/^radix-/i.test(v)) return true;
    if (/^headlessui/i.test(v)) return true;
    if (/^(?:mui|mantine|chakra|react-select|downshift|reach|floating-ui|tippy)-/i.test(v) && hasLongRandomSegment(v)) return true;
    return false;
  }

  function isVolatileAttributeValue(attr, value) {
    const name = String(attr || '').toLowerCase();
    const v = normalizeAttrValue(value);
    if (!v) return true;
    if (name === 'role') return false;
    if (['aria-controls', 'aria-describedby', 'aria-labelledby', 'aria-owns', 'aria-activedescendant', 'for'].includes(name)) {
      return v.split(/\s+/).some((token) => isVolatileAutoId(token));
    }
    if (['id', 'data-id'].includes(name)) return isVolatileAutoId(v);
    if (name.startsWith('data-v-')) return true;
    if (['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title'].includes(name)) {
      return false;
    }
    return isVolatileAutoId(v);
  }

  const selectorCore = window.__AT_SELECTOR_CORE__ || {};
  const isVolatileStateClass = typeof selectorCore.isVolatileStateClass === 'function'
    ? selectorCore.isVolatileStateClass.bind(selectorCore)
    : (cls) => !!cls && /(?:^|[-_])(focus|focused|focusing|hover|hovered|active|activated|selected|selecting|current|checked|open|opened|expanded)(?:$|[-_])/i.test(cls);
  const isVolatileClass = typeof selectorCore.isVolatileClass === 'function'
    ? selectorCore.isVolatileClass.bind(selectorCore)
    : function fallbackIsVolatileClass(cls) {
      const c = String(cls || '').trim();
      if (!c) return true;
      if (c.startsWith('__at_')) return true;
      if (isVolatileStateClass(c)) return true;
      if (/^[a-f0-9]{6,}$/i.test(c)) return true;
      if (/^css-[a-z0-9]{5,}$/i.test(c)) return true;
      if (/^sc-[a-z0-9]{5,}$/i.test(c)) return true;
      if (/^[a-z0-9]+-[a-z0-9]{8,}$/i.test(c) && /\d/.test(c)) return true;
      if (/^[A-Za-z0-9_-]+__[A-Za-z0-9_-]{5,}$/i.test(c) && /\d/.test(c)) return true;
      if (/^(?:ivu-table-column|el-table_\d+_column|ant-table-cell-[a-z0-9]+|v-\d+)-/i.test(c)) return true;
      return false;
    };
  const cleanClasses = typeof selectorCore.cleanClasses === 'function'
    ? selectorCore.cleanClasses.bind(selectorCore)
    : function fallbackCleanClasses(el) {
      if (!el.className || typeof el.className !== 'string') return [];
      return el.className.trim().split(/\s+/).filter(c => !isVolatileClass(c));
    };

  function getStateClasses(el) {
    if (!el || !el.className || typeof el.className !== 'string') return [];
    return el.className.trim().split(/\s+/)
      .filter((c) => c && isVolatileStateClass(c))
      .slice(0, 8);
  }

  /** 若选择器匹配多个节点，改用结构路径，避免 querySelector 总点到第一个 */
  function ensureUniqueSelector(el, sel) {
    if (!sel) return sel;
    try {
      const list = document.querySelectorAll(sel);
      if (list.length === 1 && list[0] === el) return sel;
      if (list.length === 1 && list[0] !== el) return getCSSPath(el);
      if (list.length > 1) {
        const idx = Array.from(list).indexOf(el);
        if (idx < 0) return getCSSPath(el);
        const path = getCSSPath(el);
        try {
          const p2 = document.querySelectorAll(path);
          if (p2.length === 1 && p2[0] === el) return path;
        } catch (e) { /* ignore */ }
        return path;
      }
    } catch (e) { /* ignore */ }
    return sel;
  }

  function safeText(s) {
    return String(s || '').trim().replace(/\s+/g, ' ');
  }

  function selectorMatchCount(sel) {
    if (!sel) return 0;
    try { return document.querySelectorAll(sel).length; } catch { return 0; }
  }

  function selectorUnique(sel) {
    return selectorMatchCount(sel) === 1;
  }

  function cssAttrSelector(tag, attr, val) {
    const t = tag && String(tag).trim() ? String(tag).toLowerCase() : '*';
    return `${t}[${attr}="${CSS.escape(String(val))}"]`;
  }

  function pushLocatorCandidate(candidates, item) {
    if (!item || !item.value) return;
    const key = `${item.type}::${item.value}`;
    if (candidates.some((c) => `${c.type}::${c.value}` === key)) return;
    candidates.push(item);
  }

  function getTreeNodeVisibleTitle(treeNode) {
    if (!treeNode) return '';
    try {
      const clone = treeNode.cloneNode(true);
      clone.querySelectorAll(
        '.tree-node-actions,.action-icon-wrapper,.data-source-icon,[class*="action"],button,svg',
      ).forEach((node) => node.remove());
      return safeText(clone.textContent || '').slice(0, 120);
    } catch {
      return safeText(treeNode.textContent || '').slice(0, 120);
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

  function buildVisibleTreePathInfo(targetNode, nodes, getTitle, getAnchor = (node) => node) {
    const visibleNodes = nodes
      .map((node, order) => {
        const title = getTitle(node);
        if (!title) return null;
        const anchor = getAnchor(node) || node;
        const ariaLevel = getAriaLevel(node);
        return {
          node,
          order,
          title,
          ariaLevel,
          left: getElementLeft(anchor),
        };
      })
      .filter(Boolean);
    if (!visibleNodes.length) return { parentPath: [], level: 0 };

    const leftBuckets = [];
    for (const item of visibleNodes) {
      if (item.ariaLevel >= 0) continue;
      if (!leftBuckets.some((left) => Math.abs(left - item.left) <= 6)) {
        leftBuckets.push(item.left);
      }
    }
    leftBuckets.sort((a, b) => a - b);
    const stack = [];
    let targetInfo = { parentPath: [], level: 0 };
    for (const item of visibleNodes) {
      const bucketLevel = item.ariaLevel >= 0
        ? item.ariaLevel
        : Math.max(0, leftBuckets.findIndex((left) => Math.abs(left - item.left) <= 6));
      const level = bucketLevel < 0 ? 0 : bucketLevel;
      stack[level] = item.title;
      stack.length = level + 1;
      if (item.node === targetNode) {
        targetInfo = {
          parentPath: stack.slice(0, level),
          level,
        };
        break;
      }
    }
    return targetInfo;
  }

  function getGenericTreeNodeInfo(el) {
    if (!el || !el.closest) return null;
    const treeNode = el.closest([
      '.el-tree-node__content',
      '.ivu-tree-title',
      '.arco-tree-node-title',
      '.arco-tree-node',
      '.n-tree-node-content',
      '.n-tree-node',
      '[role="treeitem"]',
    ].join(','));
    if (!treeNode) return null;
    const titleEl = treeNode.querySelector?.(
      '.node,.el-tree-node__label,.ivu-tree-title,.arco-tree-node-title,.n-tree-node-content__text,[role="treeitem"]',
    ) || treeNode;
    const title = getTreeNodeVisibleTitle(titleEl);
    if (!title) return null;
    const root = treeNode.closest?.('.el-tree,.ivu-tree,.arco-tree,.n-tree,[role="tree"]') || null;
    const nodes = root
      ? Array.from(root.querySelectorAll('.el-tree-node__content,.ivu-tree-title,.arco-tree-node-title,.n-tree-node-content,[role="treeitem"]'))
      : [];
    const sameTitleIndex = nodes
      .filter((node) => getTreeNodeVisibleTitle(node.querySelector?.('.node,.el-tree-node__label,.ivu-tree-title,.arco-tree-node-title,.n-tree-node-content__text') || node) === title)
      .indexOf(treeNode);
    return {
      treeNode,
      title,
      sameTitleIndex: Math.max(0, sameTitleIndex),
    };
  }

  function getAntTreeActionInfo(el) {
    if (!el || !el.closest) return null;
    const treeNode = el.closest([
      '.ant-tree-treenode',
      '.ec-ant-tree-treenode',
      '[class*="-ant-tree-treenode"]',
      '.ant-select-tree-treenode',
      '.ec-ant-select-tree-treenode',
      '[class*="-ant-select-tree-treenode"]',
      '[role="treeitem"]',
    ].join(',')) || el.closest([
      '.ant-tree-node-content-wrapper',
      '.ec-ant-tree-node-content-wrapper',
      '[class*="-ant-tree-node-content-wrapper"]',
      '.ant-select-tree-node-content-wrapper',
      '.ec-ant-select-tree-node-content-wrapper',
      '[class*="-ant-select-tree-node-content-wrapper"]',
    ].join(','));
    if (!treeNode) return null;
    let actionHost = el.closest('.data-source-icon, [class*="data-source-icon"]')
      || el.closest('.action-icon-wrapper, [class*="action-icon"]')
      || el.closest('button, [role="button"], [aria-haspopup="menu"], .teamNode > i');
    if (actionHost && !treeNode.contains(actionHost)) actionHost = null;
    if (actionHost?.closest?.([
      '.ant-tree-switcher', '.ec-ant-tree-switcher', '[class*="-ant-tree-switcher"]',
      '.ant-select-tree-switcher', '.ec-ant-select-tree-switcher', '[class*="-ant-select-tree-switcher"]',
      '.ant-tree-checkbox', '.ec-ant-tree-checkbox', '[class*="-ant-tree-checkbox"]',
      '.ant-select-tree-checkbox', '.ec-ant-select-tree-checkbox', '[class*="-ant-select-tree-checkbox"]',
    ].join(','))) actionHost = null;
    if (!actionHost) return null;
    const titleEl = treeNode.querySelector('.ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"], .ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]') || treeNode;
    const title = getTreeNodeVisibleTitle(titleEl);
    let hosts = Array.from(treeNode.querySelectorAll(
      '.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"], ' +
      '.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"], ' +
      '[aria-haspopup="menu"], button, [role="button"], .teamNode > i',
    ));
    hosts = hosts.filter((node) => !node.closest?.([
      '.ant-tree-switcher', '.ec-ant-tree-switcher', '[class*="-ant-tree-switcher"]',
      '.ant-select-tree-switcher', '.ec-ant-select-tree-switcher', '[class*="-ant-select-tree-switcher"]',
      '.ant-tree-checkbox', '.ec-ant-tree-checkbox', '[class*="-ant-tree-checkbox"]',
      '.ant-select-tree-checkbox', '.ec-ant-select-tree-checkbox', '[class*="-ant-select-tree-checkbox"]',
    ].join(',')));
    if (!hosts.includes(actionHost)) hosts.push(actionHost);
    hosts = hosts.filter((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || node.contains(actionHost);
    });
    const actionIndex = Math.max(0, hosts.indexOf(actionHost));
    const treeRoot = treeNode.closest('.ant-tree, .ec-ant-tree, [class$="-ant-tree"], .ant-select-tree, .ec-ant-select-tree, [class$="-ant-select-tree"], [role="tree"]') || document;
    let antNodes = Array.from(treeRoot.querySelectorAll(
      '.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"], .ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]',
    ));
    if (!antNodes.length) {
      antNodes = Array.from(treeRoot.querySelectorAll(
        '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, ' +
        '[class*="-ant-tree-node-content-wrapper"], .ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"], [role="treeitem"]',
      ));
    }
    const pathInfo = buildVisibleTreePathInfo(
      treeNode,
      antNodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"], .ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]') || node),
      (node) => node.querySelector?.('.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"], .ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"]') || node,
    );
    return {
      treeNode,
      titleEl,
      actionHost,
      title,
      actionIndex,
      parentPath: pathInfo.parentPath,
      level: pathInfo.level,
    };
  }

  function getAntTreeNodeInfo(el) {
    if (!el || !el.closest) return null;
    // Ant TreeSelect 复用 Ant Tree 的层级结构，但使用 ant-select-tree-* 类名，且
    // 下拉层会 Teleport 到 body。两者必须走同一套节点语义，而非 nth-of-type。
    const nodeRoot = el.closest([
      '.ant-tree-treenode', '.ec-ant-tree-treenode', '[class*="-ant-tree-treenode"]',
      '.ant-select-tree-treenode', '.ec-ant-select-tree-treenode', '[class*="-ant-select-tree-treenode"]',
    ].join(','));
    const content = el.closest([
      '.ant-tree-node-content-wrapper', '.ec-ant-tree-node-content-wrapper', '[class*="-ant-tree-node-content-wrapper"]',
      '.ant-select-tree-node-content-wrapper', '.ec-ant-select-tree-node-content-wrapper', '[class*="-ant-select-tree-node-content-wrapper"]',
    ].join(','));
    if (!nodeRoot && !content) return null;
    const treeNode = nodeRoot || content;
    const classText = Array.from(treeNode.classList || []).join(' ');
    const isSelectTree = /(?:^|\s)[^\s]*ant-select-tree-(?:treenode|node-content-wrapper)(?:\s|$)/.test(classText);
    const treeRoot = treeNode.closest([
      '.ant-tree', '.ec-ant-tree', '[class$="-ant-tree"]',
      '.ant-select-tree', '.ec-ant-select-tree', '[class$="-ant-select-tree"]', '[role="tree"]',
    ].join(',')) || document;
    const titleSelector = isSelectTree
      ? '.ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]'
      : '.ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"]';
    const contentSelector = isSelectTree
      ? '.ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"]'
      : '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"]';
    const nodeSelector = isSelectTree
      ? '.ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]'
      : '.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"]';
    const titleEl = treeNode.querySelector?.(titleSelector) || treeNode;
    const title = getTreeNodeVisibleTitle(titleEl);
    if (!title) return null;
    let nodes = Array.from(treeRoot.querySelectorAll(nodeSelector));
    if (!nodes.length) nodes = Array.from(treeRoot.querySelectorAll(`${contentSelector}, [role="treeitem"]`));
    const sameTitleIndex = nodes
      .filter((node) => getTreeNodeVisibleTitle(node.querySelector?.(titleSelector) || node) === title)
      .indexOf(treeNode);
    const pathInfo = buildVisibleTreePathInfo(
      treeNode,
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.(titleSelector) || node),
      (node) => node.querySelector?.(contentSelector) || node,
    );
    return {
      framework: 'ant-tree',
      variant: isSelectTree ? 'select' : 'tree',
      nodeRoot: treeNode,
      title,
      sameTitleIndex: Math.max(0, sameTitleIndex),
      parentPath: pathInfo.parentPath,
      level: pathInfo.level,
    };
  }

  function getVtreeNodeTitle(nodeRoot) {
    if (!nodeRoot) return '';
    const titleEl = nodeRoot.querySelector?.('.vtree-tree-node__title .node, .vtree-tree-node__title, .node') || nodeRoot;
    return getTreeNodeVisibleTitle(titleEl);
  }

  function getElementTreeNodeInfo(el) {
    if (!el || !el.closest) return null;
    const treeNode = el.closest('.el-tree-node');
    if (!treeNode) return null;
    const treeRoot = treeNode.closest('.el-tree') || document;
    const titleEl = treeNode.querySelector?.('.el-tree-node__label') || treeNode;
    const title = getTreeNodeVisibleTitle(titleEl);
    if (!title) return null;
    const nodes = Array.from(treeRoot.querySelectorAll('.el-tree-node'));
    const sameTitleIndex = nodes
      .filter((node) => getTreeNodeVisibleTitle(node.querySelector?.('.el-tree-node__label') || node) === title)
      .indexOf(treeNode);
    const pathInfo = buildVisibleTreePathInfo(
      treeNode,
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.el-tree-node__label') || node),
      (node) => node.querySelector?.('.el-tree-node__content') || node,
    );
    return { framework: 'element-tree', nodeRoot: treeNode, title, sameTitleIndex: Math.max(0, sameTitleIndex), ...pathInfo };
  }

  function getIviewTreeNodeInfo(el) {
    if (!el || !el.closest) return null;
    // View UI 的 checkbox / 展开箭头与标题是同一 li 下的兄弟节点，不能只从
    // 事件目标向上寻找 title；否则点 checkbox 时会退回到易变的 CSS/XPath。
    const item = el.closest('li');
    const titleEl = el.closest('.ivu-tree-title') || item?.querySelector?.('.ivu-tree-title');
    if (!titleEl) return null;
    const treeRoot = titleEl.closest('.ivu-tree') || document;
    const title = getTreeNodeVisibleTitle(titleEl);
    if (!title) return null;
    const nodes = Array.from(treeRoot.querySelectorAll('.ivu-tree-title'));
    const sameTitleIndex = nodes.filter((node) => getTreeNodeVisibleTitle(node) === title).indexOf(titleEl);
    const pathInfo = buildVisibleTreePathInfo(titleEl, nodes, getTreeNodeVisibleTitle, (node) => node);
    return { framework: 'iview-tree', nodeRoot: titleEl, title, sameTitleIndex: Math.max(0, sameTitleIndex), ...pathInfo };
  }

  function treeCheckboxState(host) {
    const input = host?.matches?.('input[type="checkbox"]') ? host : host?.querySelector?.('input[type="checkbox"]');
    return Boolean(input?.checked)
      || host?.classList?.contains('is-checked')
      || host?.classList?.contains('ivu-checkbox-checked')
      // View UI 会用内部 span 的 class 表示受控 checkbox 状态，input.checked
      // 在部分版本中不会与视觉状态同步。
      || Boolean(host?.querySelector?.('.ivu-checkbox.ivu-checkbox-checked'));
  }

  function getVtreeNodeInfo(el) {
    if (!el || !el.closest) return null;
    const nodeRoot = el.closest('.vtree-tree-node__indent-wrapper');
    if (!nodeRoot) return null;
    const treeRoot = nodeRoot.closest('.vtree-tree, .vtree-tree__wrapper') || document;
    const title = getVtreeNodeTitle(nodeRoot);
    if (!title) return null;
    const nodes = Array.from(treeRoot.querySelectorAll('.vtree-tree-node__indent-wrapper'));
    const sameTitleIndex = nodes
      .filter((node) => getVtreeNodeTitle(node) === title)
      .indexOf(nodeRoot);
    const pathInfo = buildVisibleTreePathInfo(
      nodeRoot,
      nodes,
      getVtreeNodeTitle,
      (node) => node.querySelector?.('.vtree-tree-node__title, .vtree-tree-node__node-body') || node,
    );
    return {
      framework: 'vtree',
      nodeRoot,
      title,
      sameTitleIndex: Math.max(0, sameTitleIndex),
      parentPath: pathInfo.parentPath,
      level: pathInfo.level,
      contentTarget: nodeRoot.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || nodeRoot,
      expandToggle: nodeRoot.querySelector('.vtree-tree-node__square.vtree-tree-node__expand'),
    };
  }

  function getTreeInteractionInfo(el) {
    const antAction = getAntTreeActionInfo(el);
    if (antAction?.title) {
      return {
        framework: 'ant-tree',
        kind: 'node_action',
        title: antAction.title,
        actionIndex: antAction.actionIndex,
        parentPath: antAction.parentPath,
        level: antAction.level,
      };
    }
    const antInfo = getAntTreeNodeInfo(el);
    if (antInfo?.title) {
      const checkbox = el.closest?.([
        '.ant-tree-checkbox', '.ec-ant-tree-checkbox', '[class*="-ant-tree-checkbox"]',
        '.ant-select-tree-checkbox', '.ec-ant-select-tree-checkbox', '[class*="-ant-select-tree-checkbox"]',
      ].join(','));
      if (checkbox) {
        const checkedBefore = Array.from(checkbox.classList || []).some((name) => /ant-(?:select-)?tree-checkbox-checked$/.test(name))
          || checkbox.getAttribute('aria-checked') === 'true';
        return {
          framework: 'ant-tree',
          variant: antInfo.variant,
          kind: 'checkbox',
          title: antInfo.title,
          sameTitleIndex: antInfo.sameTitleIndex,
          parentPath: antInfo.parentPath,
          level: antInfo.level,
          checkedBefore,
          checkedAfter: !checkedBefore,
        };
      }
      if (el.closest?.('.ant-tree-switcher, .ec-ant-tree-switcher, [class*="-ant-tree-switcher"], .ant-select-tree-switcher, .ec-ant-select-tree-switcher, [class*="-ant-select-tree-switcher"]')) {
        return {
          framework: 'ant-tree',
          variant: antInfo.variant,
          kind: 'expand_toggle',
          title: antInfo.title,
          sameTitleIndex: antInfo.sameTitleIndex,
          parentPath: antInfo.parentPath,
          level: antInfo.level,
        };
      }
      if (el.closest?.('.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"], .ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"], .ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"], .ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]')) {
        return {
          framework: 'ant-tree',
          variant: antInfo.variant,
          kind: 'node_content',
          title: antInfo.title,
          sameTitleIndex: antInfo.sameTitleIndex,
          parentPath: antInfo.parentPath,
          level: antInfo.level,
        };
      }
    }
    const elementInfo = getElementTreeNodeInfo(el);
    if (elementInfo?.title) {
      const checkbox = el.closest?.('.el-checkbox');
      const kind = checkbox ? 'checkbox'
        : el.closest?.('.el-tree-node__expand-icon') ? 'expand_toggle'
          : el.closest?.('.el-tree-node__content, .el-tree-node__label') ? 'node_content' : '';
      if (kind) return {
        framework: elementInfo.framework, kind, title: elementInfo.title,
        sameTitleIndex: elementInfo.sameTitleIndex, parentPath: elementInfo.parentPath, level: elementInfo.level,
        ...(checkbox ? { checkedBefore: treeCheckboxState(checkbox), checkedAfter: !treeCheckboxState(checkbox) } : {}),
      };
    }
    const iviewInfo = getIviewTreeNodeInfo(el);
    if (iviewInfo?.title) {
      const checkbox = el.closest?.('.ivu-checkbox-wrapper, .ivu-checkbox');
      const kind = checkbox ? 'checkbox'
        : el.closest?.('.ivu-tree-arrow') ? 'expand_toggle'
          : el.closest?.('.ivu-tree-title') ? 'node_content' : '';
      if (kind) return {
        framework: iviewInfo.framework, kind, title: iviewInfo.title,
        sameTitleIndex: iviewInfo.sameTitleIndex, parentPath: iviewInfo.parentPath, level: iviewInfo.level,
        ...(checkbox ? { checkedBefore: treeCheckboxState(checkbox), checkedAfter: !treeCheckboxState(checkbox) } : {}),
      };
    }
    const vtreeInfo = getVtreeNodeInfo(el);
    if (vtreeInfo?.title) {
      if (el.closest?.('.vtree-tree-node__square.vtree-tree-node__expand')) {
        return {
          framework: 'vtree',
          kind: 'expand_toggle',
          title: vtreeInfo.title,
          sameTitleIndex: vtreeInfo.sameTitleIndex,
          parentPath: vtreeInfo.parentPath,
          level: vtreeInfo.level,
        };
      }
      if (el.closest?.('.vtree-tree-node__title, .vtree-tree-node__node-body')) {
        return {
          framework: 'vtree',
          kind: 'node_content',
          title: vtreeInfo.title,
          sameTitleIndex: vtreeInfo.sameTitleIndex,
          parentPath: vtreeInfo.parentPath,
          level: vtreeInfo.level,
        };
      }
    }
    return null;
  }

  function getVisibleRect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return null;
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  const TABLE_WRAPPER_SELECTORS = [
    { framework: 'ivu', wrap: '.ivu-table' },
    { framework: 'ant', wrap: '.ant-table' },
    { framework: 'el', wrap: '.el-table' },
  ];

  function resolveTableRowAndCell(el) {
    if (!el || !el.closest) return { row: null, cell: null };
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
    return { row, cell };
  }

  function getTableWrapperInfo(row) {
    if (!row || !row.closest) return null;
    for (const { framework, wrap } of TABLE_WRAPPER_SELECTORS) {
      const wrapper = row.closest(wrap);
      if (!wrapper) continue;
      const wrappers = Array.from(document.querySelectorAll(wrap));
      const wrapper_index = wrappers.indexOf(wrapper);
      return { framework, wrapper, wrapper_index };
    }
    const table = row.closest('table');
    if (table) return { framework: 'html', wrapper: table, wrapper_index: -1 };
    return null;
  }

  function getTableRowSignature(row, el) {
    if (!row) return '';
    const parts = [];
    const cells = row.querySelectorAll(
      ':scope > td, :scope > th, :scope > .ant-table-cell, :scope > .el-table__cell, :scope > .ivu-table-cell, :scope > [role="gridcell"]',
    );
    for (const cell of cells) {
      const t = safeText(cell.innerText || cell.textContent || '');
      if (!t) continue;
      if (el && cell.contains(el) && t.length <= 4) continue;
      if (!parts.includes(t)) parts.push(t);
    }
    if (parts.length) return parts.join(' | ').slice(0, 160);
    return safeText(row.innerText || row.textContent || '').slice(0, 160);
  }

  function relativeCssFromAncestor(ancestor, el) {
    if (!ancestor || !el || el === ancestor) return '';
    const parts = [];
    let cur = el;
    while (cur && cur !== ancestor && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const cls = cleanClasses(cur).filter((c) => !/^ivu-table-column-/.test(c));
      if (cls.length) part += `.${cls.slice(0, 2).map(CSS.escape).join('.')}`;
      const sibs = Array.from(cur.parentNode?.children || []).filter((s) => s.tagName === cur.tagName);
      if (sibs.length > 1) {
        const idx = sibs.indexOf(cur);
        if (idx >= 0) part += `:nth-of-type(${idx + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /** 表格单元格行列锚点（录制写入 locator_meta，回放用于区分「总点到第一行」） */
  function resolveTableCellPosition(el) {
    const { row, cell } = resolveTableRowAndCell(el);
    if (!row || !cell) return null;
    const section = row.closest('tbody') || row.closest('thead');
    if (!section) return null;
    const rows = Array.from(section.querySelectorAll(':scope > tr'));
    const row_index = rows.indexOf(row);
    const cells = Array.from(row.querySelectorAll(':scope > td, :scope > th, :scope > .ant-table-cell, :scope > .el-table__cell, :scope > .ivu-table-cell, :scope > [role="gridcell"]'));
    const col_index = cells.indexOf(cell);
    if (row_index < 0 || col_index < 0) return null;
    const wrapInfo = getTableWrapperInfo(row);
    const sectionName = section.tagName.toLowerCase();
    const cellTag = cell.tagName.toLowerCase();
    const rel = getRelativeXPathFromAncestor(cell, el);
    const innerCss = relativeCssFromAncestor(cell, el);
    const rowN = row_index + 1;
    const colN = col_index + 1;
    let scoped_xpath = `//${sectionName}/tr[${rowN}]/${cellTag}[${colN}]${rel}`;
    let scoped_css = `${sectionName} > tr:nth-of-type(${rowN}) > ${cellTag}:nth-of-type(${colN})${innerCss ? ` ${innerCss}` : ''}`;
    if (wrapInfo && wrapInfo.wrapper_index >= 0) {
      if (wrapInfo.framework === 'ivu') {
        scoped_xpath = `(//div[contains(@class,'ivu-table')])[${wrapInfo.wrapper_index + 1}]//${scoped_xpath.replace(/^\/\//, '')}`;
        scoped_css = `.ivu-table:nth-of-type(${wrapInfo.wrapper_index + 1}) table ${scoped_css}`;
      } else if (wrapInfo.framework === 'ant') {
        scoped_xpath = `(//div[contains(@class,'ant-table')])[${wrapInfo.wrapper_index + 1}]//${scoped_xpath.replace(/^\/\//, '')}`;
        scoped_css = `.ant-table:nth-of-type(${wrapInfo.wrapper_index + 1}) ${scoped_css}`;
      } else if (wrapInfo.framework === 'el') {
        scoped_xpath = `(//div[contains(@class,'el-table')])[${wrapInfo.wrapper_index + 1}]//${scoped_xpath.replace(/^\/\//, '')}`;
        scoped_css = `.el-table:nth-of-type(${wrapInfo.wrapper_index + 1}) ${scoped_css}`;
      }
    }
    return {
      framework: wrapInfo?.framework || 'html',
      wrapper_index: wrapInfo?.wrapper_index ?? -1,
      section: sectionName,
      row_index,
      col_index,
      row_text: getTableRowSignature(row, el),
      scoped_xpath,
      scoped_css: scoped_css.trim(),
      cell,
      row,
    };
  }

  /**
   * 表格中的操作不能只依赖第 N 行：排序、分页或残留数据都会让 N 失去业务含义。
   * 按稳定 ID、业务语义单列、业务语义双列的顺序选择身份条件，
   * 并保存候选集合及“在该行内点哪个操作”的相对信息。
   * 找不到唯一值时返回 null，调用方仍保留旧的行号定位，避免猜测用户意图。
   */
  function buildTableRowSemanticLocator(el, tablePos) {
    if (!tablePos?.row || !tablePos?.cell) return null;
    const row = tablePos.row;
    const section = row.closest('tbody');
    if (!section) return null;
    const rows = Array.from(section.querySelectorAll(':scope > tr')).filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    });
    const cellsOf = (item) => Array.from(item.querySelectorAll(
      ':scope > td, :scope > th, :scope > .ant-table-cell, :scope > .el-table__cell, :scope > .ivu-table-cell, :scope > [role="gridcell"]',
    ));
    const cells = cellsOf(row);
    if (!rows.length || !cells.length) return null;

    const tableRoot = row.closest('.el-table,.ant-table,.ivu-table,table,[role="grid"]');
    const headerRow = tableRoot?.querySelector('thead tr:last-child, [role="rowgroup"] [role="row"]');
    const headers = headerRow ? cellsOf(headerRow).map((cell) => safeText(cell.innerText || cell.textContent || '')) : [];
    const ignoredHeader = /^(?:序号|操作|action|index|#)$/i;
    const normalized = (value) => safeText(value).replace(/\s+/g, ' ').trim();
    const stableRowAttrs = ['data-row-key', 'data-key', 'data-id', 'data-row-id', 'data-record-id'];
    const rowAttr = stableRowAttrs
      .map((attr) => ({ attr, value: normalized(row.getAttribute(attr)) }))
      .find((item) => item.value && item.value.length <= 160
        && rows.filter((candidate) => normalized(candidate.getAttribute(item.attr)) === item.value).length === 1);
    const isLowSemantic = (header, value) => (
      /(?:状态|启用|禁用|时间|日期|金额|价格|数量|比例|percent|status|time|date|amount|price|count)/i.test(header)
      || /^(?:true|false|是|否|启用|禁用|正常|停用|已?开启|已?关闭)$/i.test(value)
      || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value)
    );
    const semanticScore = (header, value) => {
      let score = 10;
      if (/(?:^|[_\s])id$|编号|编码|订单号|单号|账号|唯一标识|code/i.test(header)) score += 90;
      else if (/(?:名称|名字|角色名|用户名|标题|name)/i.test(header)) score += 80;
      else if (/(?:组织|项目|分类|类型|部门|group|project|type)/i.test(header)) score += 40;
      if (/^\d+$/.test(value) && !/(?:id|编号|编码|订单号|单号)/i.test(header)) score -= 18;
      if (isLowSemantic(header, value)) score -= 80;
      return score;
    };
    const columnCandidates = [];
    for (let index = 0; index < cells.length; index += 1) {
      const value = normalized(cells[index].innerText || cells[index].textContent || '');
      const header = normalized(headers[index] || `col_${index + 1}`);
      if (!value || value.length > 120 || ignoredHeader.test(header) || isLowSemantic(header, value)) continue;
      const matches = rows.filter((candidate) => normalized(cellsOf(candidate)[index]?.innerText || cellsOf(candidate)[index]?.textContent || '') === value);
      columnCandidates.push({ header, value, col_index: index, unique_count: matches.length, score: semanticScore(header, value) });
    }
    const identityCandidates = [];
    if (rowAttr) {
      identityCandidates.push({
        kind: 'row_attr', fields: [{ kind: 'row_attr', attr: rowAttr.attr, value: rowAttr.value }],
        unique_count: 1, score: 200, reason: 'stable_row_attribute',
      });
    }
    columnCandidates.filter((candidate) => candidate.unique_count === 1).forEach((candidate) => {
      identityCandidates.push({
        kind: 'single', fields: [{ header: candidate.header, value: candidate.value, col_index: candidate.col_index }],
        unique_count: 1, score: candidate.score, reason: 'unique_business_column',
      });
    });
    const pairPool = columnCandidates.filter((candidate) => candidate.score >= 20).sort((a, b) => b.score - a.score).slice(0, 6);
    for (let left = 0; left < pairPool.length; left += 1) {
      for (let right = left + 1; right < pairPool.length; right += 1) {
        const pair = [pairPool[left], pairPool[right]];
        const count = rows.filter((candidate) => {
          const rowCells = cellsOf(candidate);
          return pair.every((field) => normalized(rowCells[field.col_index]?.innerText || rowCells[field.col_index]?.textContent || '') === field.value);
        }).length;
        if (count === 1) {
          identityCandidates.push({
            kind: 'pair', fields: pair.map(({ header, value, col_index }) => ({ header, value, col_index })),
            unique_count: 1, score: Math.round((pair[0].score + pair[1].score) / 2) - 5, reason: 'unique_business_pair',
          });
        }
      }
    }
    identityCandidates.sort((a, b) => b.score - a.score || a.fields.length - b.fields.length);
    const selectedIdentity = identityCandidates[0];
    if (!selectedIdentity) return null;

    const relativeActionCss = relativeCssFromAncestor(row, el);
    const actionText = safeText(el.innerText || el.textContent || '').slice(0, 120);
    if (!relativeActionCss && !actionText) return null;
    return {
      version: 3,
      collection: {
        kind: 'table',
        root: { framework: tablePos.framework, wrapper_index: tablePos.wrapper_index },
        item: { selector: 'tbody > tr', role: 'row' },
      },
      // fields 保留在顶层，供 v2 回放兼容；统一模型优先读取 identity.selected。
      framework: tablePos.framework,
      wrapper_index: tablePos.wrapper_index,
      section: 'tbody',
      fields: selectedIdentity.fields,
      action: {
        css: relativeActionCss,
        text: actionText,
        tag: (el.tagName || '').toLowerCase(),
        scope: row === el ? 'self' : 'descendant',
      },
      recorded_row_index: tablePos.row_index,
      // 仅用于运行诊断：固定序号模式下可对比本次命中的业务项，不能参与定位。
      recorded_item_summary: safeText(tablePos.row_text || '').slice(0, 360),
      identity: {
        mode: 'semantic',
        selected: selectedIdentity.fields,
        selected_reason: selectedIdentity.reason,
        candidates: identityCandidates.slice(0, 8),
      },
      fallback: { mode: 'none' },
    };
  }

  // 非表格集合：仅接受有明确重复项结构的 list/card，避免把普通布局容器误识别为集合。
  function buildListCardSemanticLocator(el) {
    if (!el?.closest || resolveTableCellPosition(el)) return null;
    const item = el.closest('[role="menuitem"],.ant-menu-item,[class*="-ant-menu-item"],[class*="-ant-dropdown-menu-item"],.ivu-menu-item,.el-menu-item,[role="listitem"],.ant-list-item,[class*="-ant-list-item"],.el-card,.ivu-card,li,[class*="card"], [class*="list-item"], [class*="list_item"]');
    if (!item || !item.parentElement) return null;
    const root = item.parentElement;
    const tag = item.tagName.toLowerCase();
    const itemClass = cleanClasses(item).find((name) => /(?:card|item|list)/i.test(name));
    const itemSelector = itemClass ? `${tag}.${CSS.escape(itemClass)}` : tag;
    const items = Array.from(root.querySelectorAll(`:scope > ${itemSelector}`)).filter((node) => {
      const rect = node.getBoundingClientRect(); return rect.width > 0 || rect.height > 0;
    });
    if (items.length < 2 || !items.includes(item)) return null;
    const rootTag = root.tagName.toLowerCase();
    const rootClass = cleanClasses(root).find((name) => /(?:list|grid|cards|content)/i.test(name));
    const rootSelector = rootClass ? `${rootTag}.${CSS.escape(rootClass)}` : rootTag;
    const rootIndex = Array.from(document.querySelectorAll(rootSelector)).indexOf(root);
    const norm = (value) => safeText(value).replace(/\s+/g, ' ').trim();
    const texts = [norm(item.getAttribute('aria-label') || ''), norm(item.innerText || item.textContent || ''), ...Array.from(item.querySelectorAll('h1,h2,h3,h4,h5,h6,[title],strong,b,.title,[class*="title"],[class*="name"]'))
      .map((node) => norm(node.innerText || node.textContent || node.getAttribute('title') || ''))
      ].filter((value) => value && value.length <= 120);
    const value = texts.find((text) => items.filter((node) => norm(node.innerText || node.textContent || '').includes(text)).length === 1);
    if (!value) return null;
    const actionCss = relativeCssFromAncestor(item, el);
    const actionText = safeText(el.innerText || el.textContent || '').slice(0, 120);
    if (!actionCss && !actionText) return null;
    const itemIndex = items.indexOf(item);
    const fields = [{ kind: 'item_text', header: '业务对象', value }];
    const kind = item.matches('[role="menuitem"],.ant-menu-item,[class*="-ant-menu-item"],[class*="-ant-dropdown-menu-item"],.ivu-menu-item,.el-menu-item') ? 'menu' : (/card/i.test(itemClass || '') || item.matches('.el-card,.ivu-card,[class*="card"]') ? 'card' : 'list');
    return { version: 3, collection: { kind, root: { selector: rootSelector, index: rootIndex }, item: { selector: itemSelector } }, fields, action: { css: actionCss, text: actionText, tag: (el.tagName || '').toLowerCase(), scope: item === el ? 'self' : 'descendant' }, recorded_item_index: itemIndex, recorded_item_summary: norm(item.innerText || item.textContent || '').slice(0, 360), identity: { mode: 'semantic', selected: fields, selected_reason: 'unique_business_item_text', candidates: [{ kind: 'single', fields, unique_count: 1, score: 90, reason: 'unique_business_item_text' }] }, fallback: { mode: 'none' } };
  }

  function getControlRoot(el) {
    if (!el || !el.closest) return el;
    const componentRoot = el.closest('.ant-select,.ivu-select,.el-select,.v-select,.vs__dropdown-toggle,[role="combobox"]');
    if (componentRoot) return componentRoot;
    return el.closest('select,textarea,input,button,a,[role="button"]') || el;
  }

  function getControlKind(el) {
    const root = getControlRoot(el);
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

  function isStableComponentClass(cls) {
    return !!cls
      && !cls.startsWith('__at_')
      && !/^[a-f0-9]{6,}$/i.test(cls)
      && !/^(?:ivu|ant|el|v|vs|rc)-/.test(cls);
  }

  function selectorFromClassList(el, classes) {
    if (!el || !classes.length) return '';
    return `${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
  }

  function addControlRootCandidates(candidates, el) {
    const root = getControlRoot(el);
    if (!root || root === el || !['combobox'].includes(getControlKind(root))) return;
    const tag = root.tagName.toLowerCase();
    const allClasses = cleanClasses(root);
    const stableClasses = allClasses.filter(isStableComponentClass);
    const frameworkClasses = allClasses.filter((c) => /^(?:ivu|ant|el)-select/.test(c));

    for (const cls of stableClasses) {
      const sel = `${tag}.${CSS.escape(cls)}`;
      pushLocatorCandidate(candidates, {
        type: 'component_root_class',
        value: sel,
        score: selectorUnique(sel) ? 0.91 : 0.76,
      });
    }

    if (stableClasses.length && frameworkClasses.length) {
      const sel = selectorFromClassList(root, [...frameworkClasses.slice(0, 2), stableClasses[0]]);
      if (sel) {
        pushLocatorCandidate(candidates, {
          type: 'component_root_combo',
          value: sel,
          score: selectorUnique(sel) ? 0.9 : 0.74,
        });
      }
    }

    const parent = root.parentElement;
    if (parent) {
      const peers = Array.from(parent.querySelectorAll(':scope > .ivu-select, :scope > .ant-select, :scope > .el-select, :scope > [role="combobox"], :scope > select'));
      const idx = peers.indexOf(root);
      if (idx >= 0) {
        const parentPath = getCSSPath(parent);
        if (parentPath) {
          const sel = `${parentPath} > ${tag}:nth-of-type(${Array.from(parent.children).filter((n) => n.tagName === root.tagName).indexOf(root) + 1})`;
          pushLocatorCandidate(candidates, {
            type: 'component_root_sibling',
            value: sel,
            score: 0.73,
          });
        }
      }
    }
  }

  function getAssociatedLabelText(el) {
    if (!el) return '';
    const parts = [];
    const push = (v) => {
      const t = safeText(v);
      if (t && !parts.includes(t)) parts.push(t);
    };
    try {
      if (el.labels && el.labels.length) {
        Array.from(el.labels).forEach((label) => push(label.textContent));
      }
      const ariaLabelledBy = el.getAttribute?.('aria-labelledby');
      if (ariaLabelledBy) {
        ariaLabelledBy.split(/\s+/).forEach((id) => push(document.getElementById(id)?.textContent));
      }
      push(el.getAttribute?.('aria-label'));
      const ownLabel = el.closest?.('label');
      if (ownLabel) push(ownLabel.textContent);
      const formItem = el.closest?.(
        '.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset',
      );
      if (formItem) {
        const label = formItem.querySelector(
          'label,.ant-form-item-label,.ivu-form-item-label,.el-form-item__label,.form-label,[class*="label"]',
        );
        if (label) push(label.textContent);
      }
    } catch (e) { /* ignore */ }
    return parts.join(' | ').slice(0, 160);
  }

  function getNearestContainerText(el) {
    try {
      const container = el?.closest?.(
        '.ant-form-item,.ivu-form-item,.el-form-item,.form-item,[class*="form-item"],[role="group"],fieldset,td,th,tr,[role="row"],.mapping-row,.map-row,[class*="mapping"],[class*="map-row"]',
      );
      if (!container) return '';
      return safeText(container.innerText || container.textContent || '').slice(0, 300);
    } catch {
      return '';
    }
  }

  function getSiblingIndexInScope(el) {
    const root = getControlRoot(el);
    if (!root || !root.parentElement) return -1;
    const kind = getControlKind(root);
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
      const list = Array.from(scope.querySelectorAll(selector)).filter((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 || r.height > 0;
      });
      return list.indexOf(root);
    } catch {
      return -1;
    }
  }

  function buildLocatorContext(el) {
    const root = getControlRoot(el);
    const tablePos = resolveTableCellPosition(el);
    const ctx = {
      tag: (el?.tagName || '').toLowerCase(),
      overlay: !!getOverlayAncestor(el),
      control_kind: getControlKind(el),
      has_popup: Boolean(el?.hasAttribute?.('aria-haspopup') || root?.hasAttribute?.('aria-haspopup')),
      popup_controls: String(el?.getAttribute?.('aria-controls') || root?.getAttribute?.('aria-controls') || ''),
      label_text: getAssociatedLabelText(el),
      container_text: getNearestContainerText(el),
      sibling_index: getSiblingIndexInScope(el),
      rect: getVisibleRect(root || el),
      state_classes: getStateClasses(el),
    };
    if (tablePos) {
      ctx.table = {
        framework: tablePos.framework,
        wrapper_index: tablePos.wrapper_index,
        section: tablePos.section,
        row_index: tablePos.row_index,
        col_index: tablePos.col_index,
        row_text: tablePos.row_text,
      };
    }
    return ctx;
  }

  function isSelectLikeElement(el) {
    return getControlKind(el) === 'combobox';
  }

  function buildSmartLocatorMeta(el, fallbackSelector, fallbackXpath, stepValue = '') {
    const candidates = [];
    const tag = (el?.tagName || '').toLowerCase();

    const attrs = [
      ['data-testid', 1.0],
      ['data-test', 0.98],
      ['data-qa', 0.97],
      ['data-cy', 0.97],
      ['name', 0.92],
      ['aria-label', 0.9],
      ['placeholder', 0.82],
      ['title', 0.8],
      ['role', 0.76],
    ];
    for (const [attr, rawBaseScore] of attrs) {
      const v = el?.getAttribute?.(attr);
      if (!v) continue;
      if (isVolatileAttributeValue(attr, v)) continue;
      const baseScore = attr === 'placeholder' && isSelectLikeElement(el)
        ? 0.58
        : rawBaseScore;
      const sel = cssAttrSelector(tag || '*', attr, v);
      const unique = selectorUnique(sel);
      pushLocatorCandidate(candidates, {
        type: `css_attr_${attr}`,
        value: sel,
        score: unique ? baseScore : Math.max(0.45, baseScore - 0.22),
      });
    }

    if (el?.id && !isVolatileAutoId(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      const unique = selectorUnique(sel);
      pushLocatorCandidate(candidates, {
        type: 'css_id',
        value: sel,
        score: unique ? 0.88 : 0.62,
      });
    }

    if (fallbackSelector) {
      const unique = selectorUnique(fallbackSelector);
      pushLocatorCandidate(candidates, {
        type: 'css_fallback',
        value: fallbackSelector,
        score: unique ? 0.72 : 0.48,
      });
    }

    if (fallbackXpath) {
      pushLocatorCandidate(candidates, {
        type: 'xpath_fallback',
        value: fallbackXpath,
        score: 0.42,
      });
    }

    addControlRootCandidates(candidates, el);

    const treeInteraction = getTreeInteractionInfo(el);
    if (treeInteraction?.title) {
      pushLocatorCandidate(candidates, {
        type: 'tree_interaction',
        value: JSON.stringify(treeInteraction),
        score: 0.98,
      });
    }

    const treeNodeInfo = getGenericTreeNodeInfo(el);
    // tree_node_text 表示“点击节点正文”，不能作为节点内菜单按钮、复选框等
    // 子操作的降级目标；否则专用定位失败时会静默改成点击整行。
    if (treeNodeInfo?.title && (!treeInteraction || treeInteraction.kind === 'node_content')) {
      pushLocatorCandidate(candidates, {
        type: 'tree_node_text',
        value: JSON.stringify({
          title: treeNodeInfo.title,
          sameTitleIndex: treeNodeInfo.sameTitleIndex,
        }),
        score: 0.95,
      });
    }

    const tablePos = resolveTableCellPosition(el);
    let tableRowSemantic = null;
    if (tablePos) {
      tableRowSemantic = buildTableRowSemanticLocator(el, tablePos);
      if (tableRowSemantic) {
        tableRowSemantic._collection_locator_mode = 'semantic';
        pushLocatorCandidate(candidates, {
          type: 'collection_item',
          value: JSON.stringify(tableRowSemantic),
          score: 0.99,
        });
      }
      if (tablePos.scoped_xpath) {
        pushLocatorCandidate(candidates, {
          type: 'table_cell_xpath',
          value: tablePos.scoped_xpath,
          score: tableRowSemantic ? 0.34 : 0.94,
        });
      }
      if (tablePos.scoped_css) {
        const unique = selectorUnique(tablePos.scoped_css);
        pushLocatorCandidate(candidates, {
          type: 'table_cell_css',
          value: tablePos.scoped_css,
          score: tableRowSemantic ? 0.33 : (unique ? 0.93 : 0.82),
        });
      }
    }
    const collectionSemantic = tableRowSemantic || buildListCardSemanticLocator(el);
    if (collectionSemantic && !tableRowSemantic) {
      collectionSemantic._collection_locator_mode = 'semantic';
      pushLocatorCandidate(candidates, { type: 'collection_item', value: JSON.stringify(collectionSemantic), score: 0.99 });
    }

    // 文本候选：用于按钮、链接、菜单项和通知文本等语义动作的回退定位
    const text = safeText(stepValue || el?.textContent || '');
    if (text && ['button', 'a', 'li', 'label', 'span', 'div', 'p'].includes(tag)) {
      pushLocatorCandidate(candidates, {
        type: 'text_exact',
        value: text.slice(0, 120),
        score: 0.66,
      });
      if (tag) {
        pushLocatorCandidate(candidates, {
          type: 'text_exact_tag',
          value: `${tag}::${text.slice(0, 120)}`,
          score: 0.7,
        });
      }
    }

    candidates.sort((a, b) => (b.score - a.score));
    return {
      version: collectionSemantic ? 3 : 1,
      generated_at: Date.now(),
      candidates: candidates.slice(0, 12),
      context: {
        ...buildLocatorContext(el),
        ...(collectionSemantic ? {
          // 新录制的集合项默认按业务对象回放；仍保留录制序号，供用户在步骤编辑中显式切换。
          collection_item_identity: {
            ...(collectionSemantic.identity || {}),
            mode: 'semantic',
            semantic_config: collectionSemantic,
          },
        } : {}),
        ...(treeNodeInfo && treeNodeInfo.title ? {
          tree_node: {
            title: treeNodeInfo.title,
            same_title_index: treeNodeInfo.sameTitleIndex,
          },
        } : {}),
        ...(treeInteraction && treeInteraction.title ? {
          tree_interaction: treeInteraction,
        } : {}),
      },
    };
  }

  function attachPointerContext(step, el, clientX, clientY, actionType = 'click') {
    if (!step || !el || typeof el.getBoundingClientRect !== 'function') return;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const clickXRatio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const clickYRatio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    // 坐标不是 locator，而是“已定位到同一元素后”的真实落点。对全部鼠标动作
    // 保留元素内比例坐标；回放会先校验该点仍命中目标，否则回退到智能可点击点。
    const useRecordedPoint = ['click', 'double_click', 'right_click', 'hover'].includes(actionType);

    if (!step.locator_meta || typeof step.locator_meta !== 'object') {
      step.locator_meta = { version: 1, candidates: [], context: {} };
    }
    if (!step.locator_meta.context || typeof step.locator_meta.context !== 'object') {
      step.locator_meta.context = {};
    }
    step.locator_meta.context.pointer = {
      x_ratio: Number(clickXRatio.toFixed(4)),
      y_ratio: Number(clickYRatio.toFixed(4)),
      client_x: Math.round(clientX),
      client_y: Math.round(clientY),
      target_width: Math.round(rect.width),
      target_height: Math.round(rect.height),
      viewport_width: vw,
      viewport_height: vh,
      use_recorded_point: useRecordedPoint,
      reason: useRecordedPoint ? 'recorded_element_point' : '',
    };
  }

  function getUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    // 浮层选项（teleport 下拉框/菜单）：CSS 结构路径不稳定，留空让 XPath/文本定位
    if (getOptionItemElement(el)) return '';

    const tablePosEarly = resolveTableCellPosition(el);
    if (tablePosEarly?.scoped_css) {
      try {
        if (document.querySelectorAll(tablePosEarly.scoped_css).length === 1) {
          return tablePosEarly.scoped_css;
        }
      } catch (e) { /* ignore */ }
    }

    // 1. 优先使用稳定 ID（排除 rc_* 自增 id、纯数字、长 hex）
    if (el.id && !isVolatileAutoId(el.id)) {
      const sel = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // Ant Design Select 内搜索框：不要用 rc_select_*，用所属 .ant-select 的结构路径 + 固定 class
    const antSelectRoot = el.closest('.ant-select');
    if (antSelectRoot && el.tagName === 'INPUT' && el.classList.contains('ant-select-selection-search-input')) {
      const antPath = getCSSPath(antSelectRoot);
      if (antPath) {
        const combo = `${antPath} .ant-select-selection-search-input`;
        try {
          if (document.querySelectorAll(combo).length === 1) return combo;
        } catch (e) { /* ignore */ }
      }
      const path = getCSSPath(el);
      if (path) return path;
    }

    // 2. 语义化属性
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name', 'aria-label', 'role']) {
      const val = el.getAttribute(attr);
      if (val && !isVolatileAttributeValue(attr, val)) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 3. 表格行选择框：仅在 tbody（或 thead）内算行号，避免 thead+tbody 混算导致指到第一行
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      const tr = el.closest('tr');
      if (tr) {
        const section = tr.closest('tbody') || tr.closest('thead') || tr.parentElement;
        const table = tr.closest('table');
        if (section) {
          const rows = Array.from(section.querySelectorAll(':scope > tr'));
          const rowIdx = rows.indexOf(tr);
          if (rowIdx >= 0) {
            const tag = section.tagName.toLowerCase();
            let prefix = '';
            if (table && table.id && !isVolatileAutoId(table.id)) {
              const tid = '#' + CSS.escape(table.id);
              try {
                if (document.querySelectorAll(tid).length === 1) prefix = tid + ' ';
              } catch (e0) { /* ignore */ }
            }
            const sel = `${prefix}${tag} > tr:nth-of-type(${rowIdx + 1}) input[type="checkbox"]`;
            try {
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (e) { /* ignore */ }
            const cls = cleanClasses(el);
            if (cls.length) {
              const sel2 = `${prefix}${tag} > tr:nth-of-type(${rowIdx + 1}) input.${cls.map(CSS.escape).join('.')}`;
              try {
                if (document.querySelectorAll(sel2).length === 1) return sel2;
              } catch (e2) { /* ignore */ }
            }
          }
        }
      }
      // 非表格：同一表单项内有多个 checkbox 时用结构路径区分（避免短选择器总命中第一个）
      const scope = el.closest('.ivu-form-item, .el-form-item, fieldset, [class*="form-item"], .ant-form-item');
      if (scope && scope.querySelectorAll('input[type="checkbox"]').length > 1) {
        const path = getCSSPath(el);
        if (path) return path;
      }
    }

    // 4. 按钮/链接：用文本内容 + tag 辅助定位
    if (['BUTTON', 'A'].includes(el.tagName)) {
      const title = el.getAttribute('title');
      if (title && !isVolatileAttributeValue('title', title)) {
        const sel = `${el.tagName.toLowerCase()}[title="${CSS.escape(title)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      const classes = cleanClasses(el);
      if (classes.length) {
        const sel = `${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
        const matched = document.querySelectorAll(sel);
        if (matched.length === 1) return sel;
        if (matched.length > 1) {
          const idx = Array.from(matched).indexOf(el);
          if (idx >= 0) {
            const parentSel = el.parentElement ? getUniqueSelector(el.parentElement) : '';
            if (parentSel) {
              const combined = `${parentSel} > ${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
              if (document.querySelectorAll(combined).length === 1) return combined;
            }
            // 禁止用「文档中第 N 个匹配」拼 :nth-of-type(N)——nth-of-type 是父级内同标签序号，会指到错误元素
            return getCSSPath(el);
          }
        }
      }
    }

    // 5. tag + class 组合
    const classes = cleanClasses(el);
    if (classes.length) {
      const sel = `${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
      const matched = document.querySelectorAll(sel);
      if (matched.length === 1) return sel;
      if (matched.length > 1) {
        const idx = Array.from(matched).indexOf(el);
        if (idx >= 0) {
          const parentSel = el.parentElement ? getUniqueSelector(el.parentElement) : '';
          if (parentSel) {
            const combined = `${parentSel} > ${el.tagName.toLowerCase()}.${classes.map(CSS.escape).join('.')}`;
            if (document.querySelectorAll(combined).length === 1) return combined;
          }
          return getCSSPath(el);
        }
      }
    }

    // 6. 最终降级：结构路径
    return getCSSPath(el);
  }

  /** 从祖先到后代生成相对 XPath 段，如 /div[1]/span[2]/a（不含祖先自身） */
  function getRelativeXPathFromAncestor(ancestor, el) {
    if (!el || !ancestor || !ancestor.contains || !ancestor.contains(el)) return '';
    const parts = [];
    let cur = el;
    while (cur && cur !== ancestor && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      const sibs = Array.from(cur.parentNode?.children || []).filter(s => s.tagName === cur.tagName);
      const idx = sibs.indexOf(cur);
      parts.unshift(sibs.length > 1 && idx >= 0 ? `${tag}[${idx + 1}]` : tag);
      cur = cur.parentElement;
    }
    return parts.length ? `/${parts.join('/')}` : '';
  }

  function getCSSPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      // iView Table 列 class（ivu-table-column-xxxxx）随构建变化，仅用 nth-of-type 更稳
      const isIvuCell = (cur.tagName === 'TD' || cur.tagName === 'TH') && cur.closest('.ivu-table');
      const cls = isIvuCell ? [] : cleanClasses(cur);
      if (cls.length && cls.length <= 3) {
        part += '.' + cls.map(CSS.escape).join('.');
      }
      const siblings = Array.from(cur.parentNode?.children || []).filter(s => s.tagName === cur.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur);
        // idx === -1 表示元素已卸载，跳过 nth-of-type（避免生成 :nth-of-type(0)）
        if (idx >= 0) part += `:nth-of-type(${idx + 1})`;
      }
      parts.unshift(part);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // 检测元素是否在被 teleport 到 body 的浮层里。广义浮层包含下拉、菜单、tooltip、弹窗等。
  const OVERLAY_CLASSES = [
    'ivu-select-dropdown', 'ivu-dropdown-menu', 'ivu-transfer-list',
    'ivu-tooltip-popper',
    'el-select-dropdown', 'el-dropdown-menu', 'el-cascader__dropdown',
    'ant-select-dropdown', 'ant-dropdown', 'ant-cascader-menus',
    'v-menu__content', 'vs__dropdown-menu',
  ];
  const OPTION_OVERLAY_CLASSES = [
    'ivu-select-dropdown', 'ivu-dropdown-menu', 'ivu-transfer-list',
    'el-select-dropdown', 'el-dropdown-menu', 'el-cascader__dropdown',
    'ant-select-dropdown', 'ant-dropdown', 'ant-cascader-menus',
    'v-menu__content', 'vs__dropdown-menu',
  ];
  const OPTION_ITEM_SELECTOR = [
    'li',
    'option',
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '.ivu-select-item',
    '.ivu-dropdown-item',
    '.el-select-dropdown__item',
    '.el-option',
    '.el-dropdown-menu__item',
    '.el-cascader-node',
    '.ant-select-item',
    '.ant-select-item-option',
    '.ant-dropdown-menu-item',
    '.ant-cascader-menu-item',
    '[class*="-ant-select-item"]',
    '[class*="-ant-dropdown-menu-item"]',
    '[class*="-ant-cascader-menu-item"]',
  ].join(', ');

  function isAntOverlayClass(el) {
    return Array.from(el?.classList || []).some((name) => (
      /(?:^|-)ant-(?:select-dropdown|dropdown|dropdown-menu|cascader-dropdown|cascader-menus)$/.test(name)
    ));
  }

  function getOverlayAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (OVERLAY_CLASSES.some(cls => cur.classList?.contains(cls)) || isAntOverlayClass(cur)) return cur;
      // 兜底：body 直系子元素且 position fixed/absolute 通常是 teleport 浮层
      if (cur.parentElement === document.body) {
        const style = window.getComputedStyle(cur);
        if (['fixed', 'absolute'].includes(style.position)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function getOptionOverlayAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (OPTION_OVERLAY_CLASSES.some(cls => cur.classList?.contains(cls)) || isAntOverlayClass(cur)) return cur;
      const role = String(cur.getAttribute?.('role') || '').toLowerCase();
      if (['listbox', 'menu', 'tree', 'grid'].includes(role)) {
        const broad = getOverlayAncestor(cur);
        if (broad && broad.contains(cur)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function getOptionItemElement(el) {
    const optionOverlay = getOptionOverlayAncestor(el);
    if (!optionOverlay) return null;
    const item = el?.closest?.(OPTION_ITEM_SELECTOR);
    return item && optionOverlay.contains(item) ? item : null;
  }

  /** 可见的自定义浮层根节点（含二次子菜单独立面板） */
  function getVisibleCustomOverlayRoots() {
    const seen = new Set();
    const roots = [];
    const add = (el) => {
      if (!el || seen.has(el)) return;
      const style = window.getComputedStyle(el);
      if (!['fixed', 'absolute'].includes(style.position)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      const vp = window.innerWidth * window.innerHeight;
      if (vp > 0 && r.width * r.height > vp * 0.88) return;
      seen.add(el);
      roots.push({ el, left: r.left });
    };
    for (const child of document.body.children) add(child);
    for (const btn of document.querySelectorAll('button, [role="menuitem"]')) {
      let cur = btn.parentElement;
      while (cur && cur !== document.body) {
        const style = window.getComputedStyle(cur);
        if (['fixed', 'absolute'].includes(style.position)) {
          add(cur);
          break;
        }
        cur = cur.parentElement;
      }
    }
    return roots.sort((a, b) => a.left - b.left);
  }

  /** 一级菜单中带箭头的项（hover 展开二次子菜单），仅左侧面板 */
  function findCustomMenuHoverTrigger(el) {
    const btn = el?.closest?.('button, [role="menuitem"]');
    if (!btn) return null;
    const roots = getVisibleCustomOverlayRoots();
    if (!roots.length) return null;
    const leftmost = roots[0].el;
    if (!leftmost.contains(btn)) return null;
    const ap = btn.getAttribute('aria-haspopup');
    if (ap === 'true' || ap === 'menu') return btn;
    const lastWrap = btn.querySelector(':scope > div:last-child');
    const trailingSvg = lastWrap?.querySelector('svg');
    const trailingText = (lastWrap?.textContent || '').trim();
    if (trailingSvg && trailingText.length <= 2) return btn;
    return null;
  }

  // 从元素或其祖先中提取选项文本（去掉子图标、子元素纯取文本）
  function getOptionText(el) {
    const btn = el?.closest?.('button, [role="menuitem"]');
    if (btn) {
      const title = btn.querySelector('.truncate, [class*="font-medium"]');
      if (title) {
        const t = (title.textContent || '').trim().replace(/\s+/g, ' ');
        if (t) return t;
      }
    }
    const item = el.closest('li, option, [class*="item"], [class*="option"]') || el;
    return (item.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function normalizeRecordText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isScrollableContainer(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const st = window.getComputedStyle(el);
    const overflow = `${st.overflow || ''} ${st.overflowY || ''} ${st.overflowX || ''}`;
    return /(auto|scroll|overlay)/i.test(overflow)
      && ((el.scrollHeight - el.clientHeight > 2) || (el.scrollWidth - el.clientWidth > 2));
  }

  function getVirtualItemText(el) {
    const item = el?.closest?.([
      'li',
      '[role="option"]',
      '[role="row"]',
      '[role="treeitem"]',
      '[role="menuitem"]',
      'tr',
      '[data-index]',
      '[aria-rowindex]',
      '.ant-select-item',
      '.ant-select-item-option',
      '.el-select-dropdown__item',
      '.el-option',
      '.ivu-select-item',
      '[class*="virtual"]',
      '[class*="row"]',
      '[class*="item"]',
    ].join(','));
    return normalizeRecordText((item || el)?.innerText || (item || el)?.textContent || '').slice(0, 220);
  }

  function findVirtualScrollContainer(el) {
    let cur = el && el.nodeType === Node.ELEMENT_NODE ? el : el?.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isScrollableContainer(cur)) return cur;
      cur = cur.parentElement;
    }
    const overlay = getOverlayAncestor(el);
    if (overlay) {
      const scrollable = Array.from(overlay.querySelectorAll('*')).find(isScrollableContainer);
      if (scrollable) return scrollable;
      if (isScrollableContainer(overlay)) return overlay;
    }
    return null;
  }

  function detectVirtualHint(container) {
    if (!container) return { hint: 'false', reasons: [] };
    const reasons = [];
    const rawClass = normalizeRecordText([
      container.className,
      container.parentElement?.className,
      container.firstElementChild?.className,
    ].join(' ')).toLowerCase();
    if (/virtual|virtual-list|virtual-scroll|rc-virtual-list|cdk-virtual|v-virtual/.test(rawClass)) {
      reasons.push('virtual-class');
    }
    const items = Array.from(container.querySelectorAll([
      'li',
      '[role="option"]',
      '[role="row"]',
      '[data-index]',
      '[aria-rowindex]',
      '.ant-select-item',
      '.el-select-dropdown__item',
      '.el-option',
      '.ivu-select-item',
    ].join(','))).filter((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
    const scrollRatio = container.clientHeight > 0 ? container.scrollHeight / container.clientHeight : 1;
    if (scrollRatio > 2.2 && items.length > 0 && items.length <= 80) reasons.push('large-scroll-few-items');
    const positioned = items.some((node) => {
      const st = window.getComputedStyle(node);
      const inline = String(node.getAttribute('style') || '').toLowerCase();
      return st.position === 'absolute'
        || st.transform !== 'none'
        || inline.includes('translate')
        || node.hasAttribute('data-index')
        || node.hasAttribute('aria-rowindex');
    });
    if (positioned) reasons.push('positioned-items');
    const hint = reasons.includes('virtual-class')
      || (reasons.includes('large-scroll-few-items') && reasons.includes('positioned-items'))
      ? 'true'
      : reasons.includes('large-scroll-few-items') || reasons.includes('positioned-items')
        ? 'maybe'
        : 'false';
    return { hint, reasons, item_count: items.length, scroll_ratio: scrollRatio };
  }

  function attachVirtualScrollContext(step, targetEl, rawEl, textFallback = '') {
    if (!step || !targetEl) return;
    const container = findVirtualScrollContainer(rawEl || targetEl);
    if (!container) return;
    const analysis = detectVirtualHint(container);
    if (analysis.hint === 'false' && !getOverlayAncestor(container)) return;
    let selector = '';
    let xpath = '';
    try { selector = ensureUniqueSelector(container, getUniqueSelector(container)); } catch (e) { selector = ''; }
    try { xpath = getXPath(container); } catch (e) { xpath = ''; }
    const itemText = getVirtualItemText(rawEl || targetEl) || normalizeRecordText(textFallback);
    if (!itemText) return;
    if (!step.locator_meta || typeof step.locator_meta !== 'object') {
      step.locator_meta = { version: 1, candidates: [], context: {} };
    }
    if (!step.locator_meta.context || typeof step.locator_meta.context !== 'object') {
      step.locator_meta.context = {};
    }
    step.locator_meta.context.virtual_scroll = {
      hint: analysis.hint,
      reasons: analysis.reasons || [],
      item_text: itemText,
      option_text: normalizeRecordText(textFallback),
      container_selector: selector,
      container_xpath: xpath,
      scroll_top: Number(container.scrollTop || 0),
      scroll_left: Number(container.scrollLeft || 0),
      scroll_height: Number(container.scrollHeight || 0),
      client_height: Number(container.clientHeight || 0),
      item_count: analysis.item_count || 0,
      scroll_ratio: Number((analysis.scroll_ratio || 0).toFixed(2)),
      overlay: !!getOverlayAncestor(container),
    };
  }

  /** Poptip/Modal 内文本框、富文本：不应记成「浮层选择选项」（无选项文案） */
  function isTextFieldLikeClick(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'password', 'number', 'email', 'tel', 'url', 'date', 'time', 'datetime-local', ''].includes(t);
    }
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    return false;
  }

  function isRecorderOwnedElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE
      && String(node.id || '').startsWith('__at_');
  }

  function getXPath(el) {
    // 易变 id 不用 //*[@id=]，否则勾选后重渲染 id 变了永远找不到
    if (el.id && !isVolatileAutoId(el.id)) {
      const safeId = String(el.id).replace(/'/g, "\\'");
      return `//*[@id='${safeId}']`;
    }

    // 表格单元格内 Ant Design Select 搜索框：按 tbody/thead 行列生成 XPath，避免 CSS 多行共用一个 class 时回放总点到第一个
    if (
      el.tagName === 'INPUT'
      && el.classList
      && el.classList.contains('ant-select-selection-search-input')
    ) {
      const td = el.closest('td, th');
      const tr = el.closest('tr');
      const section = tr?.closest('tbody') || tr?.closest('thead');
      if (td && tr && section) {
        const rows = Array.from(section.querySelectorAll(':scope > tr'));
        const rowIdx = rows.indexOf(tr);
        const cells = Array.from(tr.querySelectorAll(':scope > td, :scope > th'));
        const colIdx = cells.indexOf(td);
        if (rowIdx >= 0 && colIdx >= 0) {
          const sec = section.tagName.toLowerCase();
          const cellTag = td.tagName.toLowerCase();
          return `//${sec}/tr[${rowIdx + 1}]/${cellTag}[${colIdx + 1}]//input[contains(@class,'ant-select-selection-search-input')]`;
        }
      }
    }

    // 表格行 checkbox：tbody/thead 内行号，避免 //tr[2] 匹配到页面上第一个表格的第二行
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      const tr = el.closest('tr');
      if (tr) {
        const section = tr.closest('tbody') || tr.closest('thead');
        if (section) {
          const rows = Array.from(section.querySelectorAll(':scope > tr'));
          const rowIdx = rows.indexOf(tr);
          if (rowIdx >= 0) {
            const sec = section.tagName.toLowerCase();
            const cls = cleanClasses(el);
            const clsFilter = cls.length ? ` and contains(@class,'${cls[0]}')` : '';
            return `//${sec}/tr[${rowIdx + 1}]//input[@type='checkbox'${clsFilter}]`;
          }
        }
      }
    }

    // iView Tooltip / Poptip / Modal 内交互：锚在 teleport 弹层上，避免整页绝对路径失效
    const popper = el.closest('.ivu-tooltip-popper, .ivu-poptip-popper, .ivu-modal .ivu-modal-body');
    if (popper) {
      const anchor = popper.classList?.contains('ivu-tooltip-popper')
        ? "div[contains(@class,'ivu-tooltip-popper')]"
        : popper.classList?.contains('ivu-poptip-popper')
          ? "div[contains(@class,'ivu-poptip-popper')]"
          : "div[contains(@class,'ivu-modal-body')]";
      if (el.tagName === 'TEXTAREA') {
        const list = Array.from(popper.querySelectorAll('textarea'));
        const idx = list.indexOf(el);
        if (idx >= 0) return `//${anchor}//textarea[${idx + 1}]`;
      }
      const ce = el.nodeType === Node.ELEMENT_NODE && el.isContentEditable
        ? el
        : (el.closest && el.closest('[contenteditable="true"]'));
      if (ce && popper.contains(ce)) {
        const list = Array.from(popper.querySelectorAll('[contenteditable="true"]'));
        const idx = list.indexOf(ce);
        if (idx >= 0) return `//${anchor}//*[@contenteditable='true'][${idx + 1}]`;
      }
      if (el.tagName === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        if (['text', 'search', 'password', 'number', 'email', 'tel', 'url', 'date', 'time', 'datetime-local', ''].includes(t)) {
          const inputs = Array.from(popper.querySelectorAll('input')).filter((inp) => {
            const tt = (inp.type || 'text').toLowerCase();
            return ['text', 'search', 'password', 'number', 'email', 'tel', 'url', 'date', 'time', 'datetime-local', ''].includes(tt);
          });
          const idx = inputs.indexOf(el);
          if (idx >= 0) return `//${anchor}//input[${idx + 1}]`;
        }
      }
      const btnEl = el.tagName === 'BUTTON' ? el : el.closest('button');
      if (btnEl && popper.contains(btnEl)) {
        const buttons = Array.from(popper.querySelectorAll('button'));
        const idx = buttons.indexOf(btnEl);
        if (idx >= 0) return `//${anchor}//button[${idx + 1}]`;
      }
      const ivuBtnEl = el.closest('.ivu-btn');
      if (ivuBtnEl && popper.contains(ivuBtnEl)) {
        const nodes = Array.from(popper.querySelectorAll('.ivu-btn'));
        const idx = nodes.indexOf(ivuBtnEl);
        if (idx >= 0) return `//${anchor}//*[contains(@class,'ivu-btn')][${idx + 1}]`;
      }
    }

    // 浮层选项：仅对真实下拉/菜单项用文本内容生成可跨状态定位的 XPath。
    // Dialog/Modal 内的普通 button 不能走这里，否则会把弹窗正文拼进 normalize-space。
    const optionItem = getOptionItemElement(el);
    if (optionItem) {
      const text = getOptionText(el);
      if (text && text.length <= 160) {
        // 找最近的 li / 选项容器
        const itemEl = optionItem;
        const itemTag = itemEl.tagName.toLowerCase();
        const itemCls = Array.from(itemEl.classList).find(c =>
          c.includes('item') || c.includes('option')
        );
        if (itemCls) {
          // 精确文本匹配：normalize-space 处理首尾空白
          return `//${itemTag}[contains(@class,'${itemCls}') and normalize-space()='${text.replace(/'/g, "\\'")}']`;
        }
        return `//${itemTag}[normalize-space()='${text.replace(/'/g, "\\'")}']`;
      }
    }

    const tablePosXp = resolveTableCellPosition(el);
    if (tablePosXp?.scoped_xpath) return tablePosXp.scoped_xpath;

    const parts = [];
    let cur = el;
    let reachedRoot = false;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const tag = cur.tagName.toLowerCase();
      // 录制工具栏/弹窗属于扩展 UI，回放页面不存在，不能参与业务元素下标计算。
      const siblings = Array.from(cur.parentNode?.children || [])
        .filter(s => s.tagName === cur.tagName && !isRecorderOwnedElement(s));
      const idx = siblings.indexOf(cur);
      // idx === -1：元素已卸载，兄弟列表中找不到自己，不加位置索引
      parts.unshift(siblings.length > 1 && idx >= 0 ? `${tag}[${idx + 1}]` : tag);
      if (cur === document.documentElement) { reachedRoot = true; break; }
      cur = cur.parentElement;
    }
    // 路径没到文档根（元素被卸载/detached），改用 // 作为模糊搜索前缀
    // 比直接截断的相对路径更可靠
    return (reachedRoot ? '/' : '//') + parts.join('/');
  }

  // =========================================================
  // 事件处理
  // =========================================================
  function sendHeartbeat(callback) {
    try {
      chrome.runtime.sendMessage({ type: 'AT_RECORDING_HEARTBEAT' }, (hbResp) => {
        if (chrome.runtime.lastError) {
          callback?.(null);
          return;
        }
        if (hbResp?.ok === true && hbResp?.active === true && Number.isFinite(Number(hbResp.stepCount))) {
          updateStepCount(Number(hbResp.stepCount));
        }
        callback?.(hbResp);
      });
    } catch {
      callback?.(null);
    }
  }

  function retryAfterHeartbeat(retried, retryFn, fallbackFn) {
    if (retried) {
      fallbackFn?.();
      return;
    }
    sendHeartbeat((hbResp) => {
      if (hbResp?.ok !== true || hbResp?.active !== true) {
        fallbackFn?.();
        return;
      }
      retryFn?.(true);
    });
  }

  function attemptStepRecovery(step, attempt = 0) {
    retryAfterHeartbeat(
      attempt >= 1,
      () => sendStep(step, attempt + 1),
      () => {},
    );
  }

  function sendStep(step, attempt = 0) {
    try {
      chrome.runtime.sendMessage({ type: 'AT_STEP_CAPTURED', step }, (response) => {
        if (chrome.runtime.lastError) {
          attemptStepRecovery(step, attempt);
          return;
        }
        if (response?.ok !== true || response?.active !== true) {
          attemptStepRecovery(step, attempt);
          return;
        }
        if (Number.isFinite(Number(response.stepCount))) {
          updateStepCount(Number(response.stepCount));
        }
      });
    } catch {
      attemptStepRecovery(step, attempt);
    }
  }

  /** 点击目标可能是文本/SVG 子节点，归一化为元素节点 */
  function normalizeToElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
    return null;
  }

  function isRecorderUiElement(node) {
    const el = normalizeToElement(node);
    return !!el?.closest?.('#__at_toolbar__,#__at_variable_dialog__,#__at_assertion_dialog__');
  }

  function isRecorderUiEvent(event) {
    return isRecorderUiElement(event?.target);
  }

  function isTrustedRecordingEvent(event) {
    return event?.isTrusted !== false;
  }

  /**
   * 截图/遮罩用：从真实点击节点向上解析「整颗按钮」「下拉/菜单一整行」等，
   * 避免镂空只圈到文字或图标。录制选择器仍用真实 target，避免改变回放。
   */
  /** 组件库常把原生 radio/checkbox 设为 0×0，截图需用外层可点击块 */
  function bumpInvisibleRadioForThumb(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return el;
    if (el.tagName !== 'INPUT') return el;
    const t = (el.type || '').toLowerCase();
    if (t !== 'radio' && t !== 'checkbox') return el;
    const r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) return el;
    const wrap = el.closest(
      '.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, label, .ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox',
    );
    return wrap || el;
  }

  function resolveVisualHighlightForClick(el) {
    if (!el || !el.closest) return el;

    // 1) 下拉/菜单「整行」优先（不依赖浮层 class，避免只圈到文字；需在按钮匹配之前）
    const menuOrOption = el.closest(
      [
        '[role="option"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '.ant-select-item',
        '.ant-select-item-option',
        '.ant-cascader-menu-item',
        '.ant-dropdown-menu-item',
        '.ant-dropdown-menu-submenu-title',
        '.el-select-dropdown__item',
        '.el-dropdown-menu__item',
        '.el-cascader-node',
        '.el-cascader-menu__item',
        '.ivu-select-item',
        '.ivu-dropdown-menu .ivu-dropdown-item',
        '.rc-select-item',
        '.rc-virtual-list-holder-inner .rc-select-item',
        '.vs__dropdown-option',
        'li[role="option"]',
      ].join(', '),
    );
    if (menuOrOption) return menuOrOption;

    const interactive = el.closest(
      [
        'button',
        'a[href]',
        '[role="button"]',
        '[role="tab"]',
        '[role="switch"]',
        'input[type="button"]',
        'input[type="submit"]',
        'input[type="reset"]',
        'input[type="checkbox"]',
        'input[type="radio"]',
        '.ant-btn',
        '.ant-radio-wrapper',
        '.ant-checkbox-wrapper',
        '.el-button',
        '.ivu-btn',
        '.ivu-radio-wrapper',
        'label',
      ].join(', '),
    );
    if (interactive) {
      if (interactive.tagName === 'LABEL') {
        const fid = interactive.getAttribute('for');
        if (fid) {
          const byId = document.getElementById(fid);
          if (byId && byId.getBoundingClientRect) return bumpInvisibleRadioForThumb(byId);
        }
      }
      return bumpInvisibleRadioForThumb(interactive);
    }

    return bumpInvisibleRadioForThumb(el);
  }

  /** 输入类步骤：Ant/Element 内层 input 时，用外层选择器/输入框整块区域做截图与镂空 */
  function resolveVisualHighlightForFormControl(el) {
    if (!el || !el.closest) return el;
    const antSelect = el.closest('.ant-select');
    if (antSelect) return antSelect;
    const elField = el.closest('.el-input, .el-textarea, .el-select');
    if (elField) return elField;
    const ivu = el.closest('.ivu-input-wrapper, .ivu-select');
    if (ivu) return ivu;
    return el;
  }

  /** 与截图裁剪一致的区域，用于计算聚焦点（相对裁切图 0~1） */
  function getThumbCropRect(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return null;
    /** 视口短边的 12% 作为边距，多截一些页面上下文；限制在 80~200px */
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    const pad = Math.max(80, Math.min(200, Math.round(vmin * 0.12)));
    const left = Math.max(0, rect.left - pad);
    const top = Math.max(0, rect.top - pad);
    const width = Math.min(rect.width + pad * 2, window.innerWidth - left);
    const height = Math.min(rect.height + pad * 2, window.innerHeight - top);
    if (width < 2 || height < 2) return null;
    return {
      left,
      top,
      width,
      height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  function focusInCrop(crop, clientX, clientY) {
    const x = (clientX - crop.left) / crop.width;
    const y = (clientY - crop.top) / crop.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  }

  /** 目标元素在裁切图内的归一化矩形（0~1），用于前端矩形镂空遮罩 */
  function focusRectInCrop(crop, el, padPx) {
    const r = el.getBoundingClientRect();
    const pad = padPx;
    let left = r.left - pad;
    let top = r.top - pad;
    let right = r.right + pad;
    let bottom = r.bottom + pad;
    left = Math.max(crop.left, left);
    top = Math.max(crop.top, top);
    right = Math.min(crop.left + crop.width, right);
    bottom = Math.min(crop.top + crop.height, bottom);
    let w = right - left;
    let h = bottom - top;
    if (w < 2 || h < 2) {
      left = Math.max(crop.left, r.left);
      top = Math.max(crop.top, r.top);
      right = Math.min(crop.left + crop.width, r.right);
      bottom = Math.min(crop.top + crop.height, r.bottom);
      w = right - left;
      h = bottom - top;
    }
    if (w < 1 || h < 1) return null;
    const x = (left - crop.left) / crop.width;
    const y = (top - crop.top) / crop.height;
    const nw = w / crop.width;
    const nh = h / crop.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      w: Math.min(1, Math.max(0.015, nw)),
      h: Math.min(1, Math.max(0.015, nh)),
    };
  }

  function captureStepThumbnailByCrop(crop, step = null) {
    return new Promise((resolve) => {
      try {
        if (!crop) {
          resolve('');
          return;
        }
        chrome.runtime.sendMessage(
          {
            type: 'AT_CAPTURE_STEP_THUMB',
            rect: crop,
            screenshotMode,
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve('');
              return;
            }
            if (step && resp?.fullDataUrl) step.screenshot_full = resp.fullDataUrl;
            resolve(resp && resp.dataUrl ? resp.dataUrl : '');
          },
        );
      } catch (e) {
        resolve('');
      }
    });
  }

  /** 截取当前视口内目标元素区域缩略图（由 background 裁剪整页截图） */
  function captureStepThumbnail(el, step = null) {
    return captureStepThumbnailByCrop(getThumbCropRect(el), step);
  }

  let pendingClickRecordTimer = null;
  let toolbarActionTimer = null;
  let heartbeatTimer = null;
  let variableCaptureMode = false;
  let assertionCaptureMode = false;
  let hoverCaptureMode = false;
  let pendingVariableTarget = null;
  let pendingAssertionTarget = null;
  const recordedVariableNames = new Set();

  function preparePointerStepScreenshot(step, visualEl, clientX, clientY) {
    const crop = getThumbCropRect(visualEl);
    const focus = crop ? focusInCrop(crop, clientX, clientY) : null;
    const fr = crop ? focusRectInCrop(crop, visualEl, 6) : null;
    return (async () => {
      try {
        const thumb = await captureStepThumbnailByCrop(crop, step);
        if (thumb) {
          step.screenshot = thumb;
          if (focus) step.screenshot_focus = focus;
          if (fr) step.screenshot_focus_rect = fr;
        }
      } catch (e) { /* ignore */ }
    })();
  }

  function sendPointerStepWithScreenshot(step, visualEl, clientX, clientY, screenshotTask = null) {
    void (async () => {
      await (screenshotTask || preparePointerStepScreenshot(step, visualEl, clientX, clientY));
      sendStep(step);
    })();
  }

  function setVariableCaptureMode(enabled) {
    variableCaptureMode = !!enabled;
    if (variableCaptureMode) {
      setAssertionCaptureMode(false);
      setHoverCaptureMode(false);
    }
    const btn = document.getElementById('__at_save_var_btn__');
    if (btn) {
      btn.classList.toggle('__at_active__', variableCaptureMode);
      const label = btn.querySelector('.__at_btn_label__');
      if (label) label.textContent = tr('保存变量', 'Save variable');
    }
    const dragTitle = document.querySelector('#__at_toolbar_drag__ strong');
    if (dragTitle) {
      dragTitle.textContent = variableCaptureMode
        ? tr('选择变量来源', 'Select variable source')
        : (isPaused ? tr('录制已暂停', 'Recording paused') : tr('录制中', 'Recording'));
    }
  }

  function setAssertionCaptureMode(enabled) {
    assertionCaptureMode = !!enabled;
    if (assertionCaptureMode && variableCaptureMode) {
      variableCaptureMode = false;
      const varBtn = document.getElementById('__at_save_var_btn__');
      varBtn?.classList.toggle('__at_active__', false);
    }
    if (assertionCaptureMode) setHoverCaptureMode(false);
    const btn = document.getElementById('__at_add_assert_btn__');
    if (btn) btn.classList.toggle('__at_active__', assertionCaptureMode);
    const dragTitle = document.querySelector('#__at_toolbar_drag__ strong');
    if (dragTitle) {
      dragTitle.textContent = assertionCaptureMode
        ? tr('选择断言元素', 'Select assertion element')
        : (isPaused ? tr('录制已暂停', 'Recording paused') : tr('录制中', 'Recording'));
    }
  }

  function setHoverCaptureMode(enabled) {
    hoverCaptureMode = !!enabled;
    if (hoverCaptureMode) {
      if (variableCaptureMode) {
        variableCaptureMode = false;
        document.getElementById('__at_save_var_btn__')?.classList.toggle('__at_active__', false);
      }
      if (assertionCaptureMode) {
        assertionCaptureMode = false;
        document.getElementById('__at_add_assert_btn__')?.classList.toggle('__at_active__', false);
      }
      flushPendingInputFor();
      clearPendingClickStep();
      clearPendingTreeHover();
      clearPendingHoverStep();
    }
    const btn = document.getElementById('__at_hover_btn__');
    if (btn) btn.classList.toggle('__at_active__', hoverCaptureMode);
    const dragTitle = document.querySelector('#__at_toolbar_drag__ strong');
    if (dragTitle) {
      dragTitle.textContent = hoverCaptureMode
        ? tr('选择悬浮元素', 'Select hover element')
        : (isPaused ? tr('录制已暂停', 'Recording paused') : tr('录制中', 'Recording'));
    }
  }

  function normalizeVariableName(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const normalized = raw
      .replace(/[^\w$]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!normalized) return '';
    return /^[A-Za-z_$]/.test(normalized) ? normalized : `v_${normalized}`;
  }

  function isValidVariableName(input) {
    return /^[A-Za-z_$][\w$]*$/.test(String(input || '').trim());
  }

  function getVariableSourceValue(el) {
    if (!el) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return String(el.value ?? '');
    }
    if (el.isContentEditable || el.closest?.('[contenteditable="true"]')) {
      const editable = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
      return String(editable?.textContent ?? '');
    }
    return String(el.innerText ?? el.textContent ?? '');
  }

  function getAssertionSourceValue(el) {
    return getAssertionReadValue(el, 'auto').value;
  }

  function normalizeAssertionReadMode(input) {
    const mode = String(input || '').trim().toLowerCase();
    return ['auto', 'text', 'attribute', 'value'].includes(mode) ? mode : 'auto';
  }

  function getAssertionReadValue(el, rawReadMode = 'auto', rawAttribute = '') {
    const readMode = normalizeAssertionReadMode(rawReadMode);
    const attribute = String(rawAttribute || '').trim();
    if (readMode === 'attribute') {
      if (!attribute) return { ok: false, value: '', attributeMissing: true, attribute };
      if (!el?.hasAttribute?.(attribute)) return { ok: false, value: '', attributeMissing: true, attribute };
      return { ok: true, value: String(el.getAttribute(attribute) ?? ''), attribute };
    }
    if (readMode === 'value') {
      return { ok: true, value: 'value' in (el || {}) ? String(el.value ?? '') : '' };
    }
    if (readMode === 'auto') return { ok: true, value: getVariableSourceValue(el) };
    return { ok: true, value: String(el?.innerText ?? el?.textContent ?? '') };
  }

  function assertionReadModeLabel(mode) {
    if (mode === 'text') return '元素文本';
    if (mode === 'attribute') return '元素属性';
    if (mode === 'value') return '输入值';
    return '自动';
  }

  function defaultAssertionMatchFromElement(el) {
    const tag = String(el?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'equals';
    return 'contains';
  }

  function normalizeAssertionTarget(target) {
    return ['element', 'page', 'url'].includes(String(target || '')) ? String(target) : 'element';
  }

  function normalizeAssertionMatch(match, target = 'element') {
    const raw = String(match || '');
    if (raw === 'visible') return target === 'element' ? 'visible' : 'contains';
    return ['contains', 'equals', 'not_contains', 'regex'].includes(raw) ? raw : 'contains';
  }

  function assertionTargetLabel(target) {
    if (target === 'page') return tr('整页文本', 'page text');
    if (target === 'url') return 'URL';
    return tr('指定元素', 'selected element');
  }

  function assertionMatchLabel(match) {
    if (match === 'equals') return tr('等于', 'equals');
    if (match === 'not_contains') return tr('不包含', 'does not contain');
    if (match === 'regex') return tr('正则匹配', 'matches regex');
    if (match === 'visible') return tr('元素可见', 'is visible');
    return tr('包含', 'contains');
  }

  function applyVariableExtraction(rawValue, extract) {
    const raw = String(rawValue ?? '');
    const mode = String(extract?.mode || 'full');
    if (mode === 'regex') {
      const pattern = String(extract?.pattern || '');
      if (!pattern) return { ok: false, error: tr('请填写正则表达式。', 'Enter a regular expression.'), value: '' };
      const safetyError = validateRegexSafety(pattern);
      if (safetyError) return { ok: false, error: safetyError, value: '' };
      let re;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return { ok: false, error: tr(`正则表达式无效：${e?.message || e}`, `Invalid regular expression: ${e?.message || e}`), value: '' };
      }
      const match = raw.match(re);
      if (!match) return { ok: false, error: tr('当前抽取值未匹配该正则。', 'The current value does not match this regular expression.'), value: '' };
      const group = Number.isInteger(Number(extract?.group)) ? Number(extract.group) : (match.length > 1 ? 1 : 0);
      if (match[group] == null) return { ok: false, error: tr(`捕获组 ${group} 不存在。`, `Capture group ${group} does not exist.`), value: '' };
      return { ok: true, value: String(match[group]) };
    }
    return { ok: true, value: raw };
  }

  function hasNestedRegexQuantifier(pattern) {
    const source = String(pattern || '');
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== '(' || source[i + 1] === '?') continue;
      let escaped = false;
      let depth = 0;
      let innerHasQuantifier = false;
      for (let j = i; j < source.length; j++) {
        const ch = source[j];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '(') depth += 1;
        if (depth > 0 && ['*', '+'].includes(ch)) innerHasQuantifier = true;
        if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            const next = source[j + 1] || '';
            if (innerHasQuantifier && ['*', '+'].includes(next)) return true;
            if (innerHasQuantifier && next === '{') return true;
            break;
          }
        }
      }
    }
    return false;
  }

  function validateRegexSafety(pattern) {
    const source = String(pattern || '');
    if (source.length > 300) return tr('正则表达式过长，请缩短后再保存。', 'The regular expression is too long. Shorten it before saving.');
    if (hasNestedRegexQuantifier(source)) return tr('正则存在嵌套重复结构，可能导致页面或回放卡顿，请改写后再保存。', 'The regular expression contains nested repetition and may hang playback. Rewrite it before saving.');
    if (/(?:\.\*){2,}|(?:\.\+){2,}|\[[^\]]*\\s\\S[^\]]*\][*+][*+]?/.test(source)) {
      return tr('正则过宽，可能误匹配大段文本，请增加固定上下文后再保存。', 'The regular expression is too broad. Add fixed context before saving.');
    }
    return '';
  }

  function normalizeVariableExtractConfig(config) {
    const mode = String(config?.mode || 'full');
    if (mode === 'regex') {
      return {
        mode,
        pattern: String(config?.pattern || ''),
        group: Number.isInteger(Number(config?.group)) ? Number(config.group) : 0,
      };
    }
    return { mode: 'full' };
  }

  function applyGeneratedVariableRule(rule, controls) {
    const mode = String(rule?.mode || 'full');
    if (mode === 'regex') {
      controls.regexInput.value = String(rule.pattern || '');
      controls.groupInput.value = String(Number.isInteger(Number(rule.group)) ? Number(rule.group) : 0);
      return true;
    }
    if (mode === 'full') {
      return true;
    }
    return false;
  }

  function requestVariableExtractRule(rawValue, instruction) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'AT_AI_VARIABLE_EXTRACT_RULE', rawValue: String(rawValue ?? ''), instruction: String(instruction || '') },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: tr('智能抽取服务无响应', 'The AI extraction service did not respond.') });
        },
      );
    });
  }

  function buildSetVariableStep(el, variableName, rawValue, extractConfig = { mode: 'full' }) {
    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const raw = String(rawValue ?? '');
    const extract = normalizeVariableExtractConfig(extractConfig);
    const extracted = applyVariableExtraction(raw, extract);
    const value = extracted.ok ? extracted.value : raw;
    const meta = buildSmartLocatorMeta(el, targetSelector, targetXpath, value);
    if (!meta.context || typeof meta.context !== 'object') meta.context = {};
    meta.context.variable = {
      name: variableName,
      source: getVariableSourceKind(el),
      raw_preview: raw.trim().replace(/\s+/g, ' ').slice(0, 200),
      preview: value.trim().replace(/\s+/g, ' ').slice(0, 200),
      extract,
      duplicate_at_recording: recordedVariableNames.has(variableName),
    };
    return {
      action_type: 'set_variable',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: variableName,
      value_text: raw,
      url: location.href,
      description: tr(
        `保存变量 {{${variableName}}}: "${value.trim().replace(/\s+/g, ' ').slice(0, 50)}"`,
        `Save variable {{${variableName}}}: "${value.trim().replace(/\s+/g, ' ').slice(0, 50)}"`,
      ),
      locator_meta: meta,
    };
  }

  function buildAssertionStep(el, target, match, expectedValue, rawReadMode = 'auto', rawAttribute = '') {
    const assertionTarget = normalizeAssertionTarget(target);
    const assertionMatch = normalizeAssertionMatch(match, assertionTarget);
    const usesElement = assertionTarget === 'element';
    const readMode = usesElement && assertionMatch !== 'visible' ? normalizeAssertionReadMode(rawReadMode) : 'auto';
    const attribute = readMode === 'attribute' ? String(rawAttribute || '').trim() : '';
    if (readMode === 'attribute' && !attribute) return null;
    const targetSelector = usesElement ? ensureUniqueSelector(el, getUniqueSelector(el)) : '';
    const targetXpath = usesElement ? getXPath(el) : '';
    const expected = assertionMatch === 'visible' ? '' : String(expectedValue ?? '');
    const meta = usesElement
      ? buildSmartLocatorMeta(el, targetSelector, targetXpath, expected)
      : { version: 1, candidates: [], context: {} };
    if (!meta.context || typeof meta.context !== 'object') meta.context = {};
    // 文本断言默认采用“等待成立”语义：异步 toast / 列表刷新等目标可能先挂载后写入文本。
    // 用户仍可在中台将 wait_mode 改为 immediate，以校验严格的瞬时状态。
    meta.assertion = { target: assertionTarget, match: assertionMatch, wait_mode: 'eventually' };
    meta.context.assertion = {
      target: assertionTarget,
      match: assertionMatch,
      source: usesElement ? readMode : assertionTarget,
      ...(attribute ? { attribute } : {}),
      // 定位元数据会作为执行定义回传，不能截断 data URL 等断言期望值。
      preview: String(expectedValue ?? '').trim().replace(/\s+/g, ' '),
    };
    const targetLabel = assertionTargetLabel(assertionTarget);
    const matchLabel = assertionMatchLabel(assertionMatch);
    return {
      action_type: 'assert_text',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: expected,
      value_text: expected,
      ...(usesElement ? { read_mode: readMode, ...(attribute ? { attribute } : {}) } : {}),
      url: location.href,
      description: assertionMatch === 'visible'
        ? tr(`断言${targetLabel}可见`, `Assert ${targetLabel} is visible`)
        : tr(
          `断言${targetLabel}${matchLabel}: "${expected.trim().replace(/\s+/g, ' ').slice(0, 50)}"`,
          `Assert ${targetLabel} ${matchLabel}: "${expected.trim().replace(/\s+/g, ' ').slice(0, 50)}"`,
        ),
      locator_meta: meta,
    };
  }

  function getVariableSourceKind(el) {
    if (!el) return 'text';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'value';
    if (el.isContentEditable || el.closest?.('[contenteditable="true"]')) return 'contenteditable';
    return 'text';
  }

  function closeVariableDialog() {
    const dialog = document.getElementById('__at_variable_dialog__');
    if (dialog) dialog.remove();
    pendingVariableTarget = null;
  }

  function closeAssertionDialog() {
    const dialog = document.getElementById('__at_assertion_dialog__');
    if (dialog) dialog.remove();
    pendingAssertionTarget = null;
  }

  function defaultVariableNameFromElement(el) {
    const raw = [
      el?.getAttribute?.('data-testid'),
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('name'),
      el?.id,
    ].find((x) => String(x || '').trim());
    return normalizeVariableName(raw || 'test') || 'test';
  }

  function showVariableDialog(el, rawValue) {
    closeVariableDialog();
    pendingVariableTarget = { el, rawValue };
    const preview = String(rawValue ?? '').trim().replace(/\s+/g, ' ');
    const defaultName = defaultVariableNameFromElement(el);
    const overlay = document.createElement('div');
    overlay.id = '__at_variable_dialog__';
    overlay.innerHTML = `
      <div class="__at_var_card__" role="dialog" aria-modal="true" aria-labelledby="__at_var_title__">
        <div class="__at_var_head__">
          <div>
            <div class="__at_var_kicker__">Runtime variable</div>
            <div id="__at_var_title__" class="__at_var_title__">${escapeHtml(tr('保存变量', 'Save variable'))}</div>
          </div>
          <button type="button" class="__at_icon_btn__" id="__at_var_close__" aria-label="${escapeHtml(tr('关闭', 'Close'))}">×</button>
        </div>
        <label class="__at_var_field__">
          <span class="__at_var_label__">${escapeHtml(tr('变量名', 'Variable name'))}</span>
          <input id="__at_var_name__" value="${escapeHtml(defaultName)}" autocomplete="off" spellcheck="false" />
        </label>
        <div class="__at_var_preview__">
          <span class="__at_var_label__">${escapeHtml(tr('原始值', 'Raw value'))}</span>
          <code id="__at_assert_current_value__">${escapeHtml(preview || '(empty)')}</code>
        </div>
        <div class="__at_var_field__">
          <span class="__at_var_label__">${escapeHtml(tr('抽取方式', 'Extraction method'))}</span>
          <input id="__at_var_extract_mode__" type="hidden" value="full" />
          <div class="__at_select__" id="__at_extract_select__">
            <button type="button" class="__at_select_trigger__" id="__at_extract_select_trigger__" aria-haspopup="listbox" aria-expanded="false">
              <span id="__at_extract_select_label__">${escapeHtml(tr('完整值', 'Full value'))}</span>
              <span class="__at_select_chevron__">⌄</span>
            </button>
            <div class="__at_select_menu__" id="__at_extract_select_menu__" role="listbox" hidden>
              <button type="button" class="__at_select_option__ __at_selected__" data-extract-mode="full" role="option" aria-selected="true">${escapeHtml(tr('完整值', 'Full value'))}</button>
              <button type="button" class="__at_select_option__" data-extract-mode="regex" role="option" aria-selected="false">${escapeHtml(tr('正则匹配', 'Regular expression'))}</button>
            </div>
          </div>
        </div>
        <div id="__at_var_regex_fields__" class="__at_var_extract_fields__" hidden>
          <div class="__at_var_ai_box__" id="__at_var_ai_box__">
            <label class="__at_var_field__">
              <span class="__at_var_label__">${escapeHtml(tr('智能抽取', 'AI extraction'))}</span>
              <input id="__at_var_ai_instruction__" placeholder="${escapeHtml(tr('例如：只取括号前面的内容', 'Example: extract only the text before the parentheses'))}" autocomplete="off" spellcheck="false" />
            </label>
            <button type="button" class="__at_ai_btn__" id="__at_var_ai_generate__">${escapeHtml(tr('生成规则', 'Generate rule'))}</button>
          </div>
          <label class="__at_var_field__">
            <span class="__at_var_label__">${escapeHtml(tr('正则表达式', 'Regular expression'))}</span>
            <input id="__at_var_regex__" placeholder="${escapeHtml(tr('例如：ORD-\\d+', 'Example: ORD-\\d+'))}" autocomplete="off" spellcheck="false" />
          </label>
          <label class="__at_var_field__">
            <span class="__at_var_label__">${escapeHtml(tr('捕获组', 'Capture group'))}</span>
            <input id="__at_var_group__" value="0" inputmode="numeric" autocomplete="off" spellcheck="false" />
          </label>
        </div>
        <div class="__at_var_preview__">
          <span class="__at_var_label__">${escapeHtml(tr('变量值预览', 'Variable value preview'))}</span>
          <code id="__at_var_result__">${escapeHtml(preview || '(empty)')}</code>
        </div>
        <div class="__at_var_usage__">${escapeHtml(tr('后续步骤可使用', 'Use in later steps'))} <code>{{${escapeHtml(defaultName)}}}</code></div>
        <div class="__at_var_error__" id="__at_var_error__"></div>
        <div class="__at_var_actions__">
          <button type="button" class="__at_secondary_btn__" id="__at_var_cancel__">${escapeHtml(tr('取消', 'Cancel'))}</button>
          <button type="button" class="__at_primary_btn__" id="__at_var_confirm__">${escapeHtml(tr('保存变量', 'Save variable'))}</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target === overlay) closeVariableDialog();
    });
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#__at_var_name__');
    const modeInput = overlay.querySelector('#__at_var_extract_mode__');
    const selectRoot = overlay.querySelector('#__at_extract_select__');
    const selectTrigger = overlay.querySelector('#__at_extract_select_trigger__');
    const selectLabel = overlay.querySelector('#__at_extract_select_label__');
    const selectMenu = overlay.querySelector('#__at_extract_select_menu__');
    const modeButtons = Array.from(overlay.querySelectorAll('[data-extract-mode]'));
    const regexFields = overlay.querySelector('#__at_var_regex_fields__');
    const regexInput = overlay.querySelector('#__at_var_regex__');
    const groupInput = overlay.querySelector('#__at_var_group__');
    const aiInstructionInput = overlay.querySelector('#__at_var_ai_instruction__');
    const aiGenerateButton = overlay.querySelector('#__at_var_ai_generate__');
    const resultPreview = overlay.querySelector('#__at_var_result__');
    const usage = overlay.querySelector('.__at_var_usage__ code');
    const error = overlay.querySelector('#__at_var_error__');
    const currentExtractConfig = () => {
      const mode = String(modeInput.value || 'full');
      if (mode === 'regex') {
        return { mode, pattern: String(regexInput.value || ''), group: Number(groupInput.value || 0) || 0 };
      }
      return { mode: 'full' };
    };
    const setMode = (mode) => {
      modeInput.value = mode;
      const selectedText = mode === 'regex' ? tr('正则匹配', 'Regular expression') : tr('完整值', 'Full value');
      selectLabel.textContent = selectedText;
      modeButtons.forEach((btn) => {
        const selected = btn.dataset.extractMode === mode;
        btn.classList.toggle('__at_selected__', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      updateUsage();
    };
    const closeSelect = () => {
      selectMenu.hidden = true;
      selectTrigger.setAttribute('aria-expanded', 'false');
    };
    const toggleSelect = () => {
      const open = selectMenu.hidden;
      selectMenu.hidden = !open;
      selectTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const updateUsage = () => {
      const raw = String(input.value || '').trim();
      const normalized = normalizeVariableName(raw) || 'name';
      usage.textContent = `{{${normalized}}}`;
      const mode = String(modeInput.value || 'full');
      regexFields.hidden = mode !== 'regex';
      const config = currentExtractConfig();
      const extracted = applyVariableExtraction(rawValue, config);
      resultPreview.textContent = extracted.ok ? (extracted.value || '(empty)') : '—';
      error.style.color = '#dc2626';
      if (raw && !isValidVariableName(raw)) {
        error.textContent = tr('变量名只能包含字母、数字、下划线或 $，且不能以数字开头。', 'Variable names may contain letters, numbers, underscores, or $, and cannot start with a number.');
        return;
      }
      if (recordedVariableNames.has(normalized)) {
        error.textContent = tr('该变量名已在本次录制中使用，保存后会覆盖运行时变量值。', 'This variable name is already used in this recording. Saving it will overwrite the runtime value.');
        return;
      }
      if (!extracted.ok) {
        error.textContent = extracted.error;
        return;
      }
      error.textContent = '';
    };
    input.addEventListener('input', updateUsage);
    selectTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSelect();
    });
    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        setMode(btn.dataset.extractMode || 'full');
        closeSelect();
      });
    });
    overlay.addEventListener('click', (event) => {
      if (!selectRoot.contains(event.target)) closeSelect();
    });
    regexInput.addEventListener('input', updateUsage);
    groupInput.addEventListener('input', updateUsage);
    aiInstructionInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        aiGenerateButton?.click();
      }
    });
    aiGenerateButton.addEventListener('click', async () => {
      const instruction = String(aiInstructionInput.value || '').trim();
      if (!instruction) {
        error.textContent = tr('请描述你想保存哪一部分。', 'Describe which part you want to save.');
        aiInstructionInput.focus();
        return;
      }
      aiGenerateButton.disabled = true;
      aiGenerateButton.textContent = tr('生成中...', 'Generating...');
      error.style.color = '#dc2626';
      error.textContent = '';
      try {
        const response = await requestVariableExtractRule(rawValue, instruction);
        if (!response?.ok) {
          error.textContent = response?.error || tr('智能抽取规则生成失败。', 'Failed to generate an AI extraction rule.');
          return;
        }
        const applied = applyGeneratedVariableRule(response.rule, {
          regexInput,
          groupInput,
        });
        if (!applied) {
          error.textContent = tr('智能抽取返回了不支持的规则。', 'AI extraction returned an unsupported rule.');
          return;
        }
        setMode(response.rule?.mode === 'full' ? 'full' : 'regex');
        updateUsage();
        if (response.rule?.reason) {
          error.style.color = '#15803d';
          error.textContent = response.rule?.mode === 'full'
            ? tr(`已生成规则：${response.rule.reason}；将保存完整值。`, `Rule generated: ${response.rule.reason}. The full value will be saved.`)
            : tr(`已生成规则：${response.rule.reason}；正则和捕获组已填入下方。`, `Rule generated: ${response.rule.reason}. The expression and capture group are filled in below.`);
        }
      } finally {
        aiGenerateButton.disabled = false;
        aiGenerateButton.textContent = tr('生成规则', 'Generate rule');
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        overlay.querySelector('#__at_var_confirm__')?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (!selectMenu.hidden) closeSelect();
        else closeVariableDialog();
      }
    });
    overlay.querySelector('#__at_var_close__')?.addEventListener('click', closeVariableDialog);
    overlay.querySelector('#__at_var_cancel__')?.addEventListener('click', closeVariableDialog);
    overlay.querySelector('#__at_var_confirm__')?.addEventListener('click', () => {
      const rawName = String(input.value || '').trim();
      if (!rawName) {
        error.textContent = tr('请输入变量名。', 'Enter a variable name.');
        input.focus();
        return;
      }
      if (!isValidVariableName(rawName)) {
        error.textContent = tr('变量名只能包含字母、数字、下划线或 $，且不能以数字开头。', 'Variable names may contain letters, numbers, underscores, or $, and cannot start with a number.');
        input.focus();
        return;
      }
      const name = normalizeVariableName(rawName);
      const extractConfig = currentExtractConfig();
      const extracted = applyVariableExtraction(rawValue, extractConfig);
      if (!extracted.ok) {
        error.textContent = extracted.error;
        return;
      }
      const target = pendingVariableTarget;
      closeVariableDialog();
      if (target?.el) createVariableStepFromTarget(target.el, name, target.rawValue, extractConfig);
    });
    updateUsage();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  function createVariableStepFromTarget(el, name, value, extractConfig) {
    const step = buildSetVariableStep(el, name, value, extractConfig);
    recordedVariableNames.add(name);
    const visualEl = resolveVisualHighlightForFormControl(el) || el;
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, r.left + r.width / 2, r.top + r.height / 2);
            const fr = focusRectInCrop(crop, visualEl, 4);
            if (fr) step.screenshot_focus_rect = fr;
          }
        }
      } catch (e) { /* ignore */ }
      sendStep(step);
    })();
  }

  function showAssertionDialog(el, rawValue) {
    closeAssertionDialog();
    pendingAssertionTarget = { el, rawValue };
    const preview = String(rawValue ?? '').trim().replace(/\s+/g, ' ');
    const defaultMatch = defaultAssertionMatchFromElement(el);
    const overlay = document.createElement('div');
    overlay.id = '__at_assertion_dialog__';
    overlay.innerHTML = `
      <div class="__at_var_card__" role="dialog" aria-modal="true" aria-labelledby="__at_assert_title__">
        <div class="__at_var_head__">
          <div>
            <div class="__at_var_kicker__">Assertion</div>
            <div id="__at_assert_title__" class="__at_var_title__">${escapeHtml(tr('添加断言', 'Add assertion'))}</div>
          </div>
          <button type="button" class="__at_icon_btn__" id="__at_assert_close__" aria-label="${escapeHtml(tr('关闭', 'Close'))}">×</button>
        </div>
        <div class="__at_var_preview__ __at_assert_preview__">
          <span class="__at_var_label__">${escapeHtml(tr('当前值', 'Current value'))}</span>
          <code>${escapeHtml(preview || '(empty)')}</code>
        </div>
        <div class="__at_var_field__" id="__at_assert_read_mode_wrap__">
          <span class="__at_var_label__">读取方式</span>
          <input id="__at_assert_read_mode__" type="hidden" value="auto" />
          <div class="__at_select__" id="__at_assert_read_mode_select__">
            <button type="button" class="__at_select_trigger__" id="__at_assert_read_mode_trigger__" aria-haspopup="listbox" aria-expanded="false">
              <span id="__at_assert_read_mode_label__">自动</span>
              <span class="__at_select_chevron__">⌄</span>
            </button>
            <div class="__at_select_menu__" id="__at_assert_read_mode_menu__" role="listbox" hidden>
              <button type="button" class="__at_select_option__" data-assert-read-mode="auto" role="option">自动</button>
              <button type="button" class="__at_select_option__" data-assert-read-mode="text" role="option">元素文本</button>
              <button type="button" class="__at_select_option__" data-assert-read-mode="attribute" role="option">元素属性</button>
              <button type="button" class="__at_select_option__" data-assert-read-mode="value" role="option">输入值</button>
            </div>
          </div>
        </div>
        <label class="__at_var_field__" id="__at_assert_attribute_wrap__" hidden>
          <span class="__at_var_label__">属性名</span>
          <input id="__at_assert_attribute__" value="" autocomplete="off" spellcheck="false" placeholder="例如：class" />
        </label>
        <div class="__at_var_field__">
          <span class="__at_var_label__">${escapeHtml(tr('匹配方式', 'Match method'))}</span>
          <input id="__at_assert_match__" type="hidden" value="${escapeHtml(defaultMatch)}" />
          <div class="__at_select__" id="__at_assert_match_select__">
            <button type="button" class="__at_select_trigger__" id="__at_assert_match_trigger__" aria-haspopup="listbox" aria-expanded="false">
              <span id="__at_assert_match_label__">${escapeHtml(assertionMatchLabel(defaultMatch))}</span>
              <span class="__at_select_chevron__">⌄</span>
            </button>
            <div class="__at_select_menu__" id="__at_assert_match_menu__" role="listbox" hidden>
              <button type="button" class="__at_select_option__" data-assert-match="contains" role="option">${escapeHtml(tr('包含', 'Contains'))}</button>
              <button type="button" class="__at_select_option__" data-assert-match="equals" role="option">${escapeHtml(tr('等于', 'Equals'))}</button>
              <button type="button" class="__at_select_option__" data-assert-match="not_contains" role="option">${escapeHtml(tr('不包含', 'Does not contain'))}</button>
              <button type="button" class="__at_select_option__" data-assert-match="regex" role="option">${escapeHtml(tr('正则匹配', 'Regular expression'))}</button>
              <button type="button" class="__at_select_option__" data-assert-match="visible" role="option">${escapeHtml(tr('元素可见', 'Element is visible'))}</button>
            </div>
          </div>
        </div>
        <label class="__at_var_field__" id="__at_assert_expected_wrap__">
          <span class="__at_var_label__">${escapeHtml(tr('期望值', 'Expected value'))}</span>
          <input id="__at_assert_expected__" value="${escapeHtml(preview)}" autocomplete="off" spellcheck="false" />
        </label>
        <div class="__at_var_error__" id="__at_assert_error__"></div>
        <div class="__at_var_actions__">
          <button type="button" class="__at_secondary_btn__" id="__at_assert_cancel__">${escapeHtml(tr('取消', 'Cancel'))}</button>
          <button type="button" class="__at_primary_btn__" id="__at_assert_confirm__">${escapeHtml(tr('保存断言', 'Save assertion'))}</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target === overlay) closeAssertionDialog();
    });
    document.body.appendChild(overlay);

    const matchInput = overlay.querySelector('#__at_assert_match__');
    const matchSelectRoot = overlay.querySelector('#__at_assert_match_select__');
    const matchTrigger = overlay.querySelector('#__at_assert_match_trigger__');
    const matchLabel = overlay.querySelector('#__at_assert_match_label__');
    const matchMenu = overlay.querySelector('#__at_assert_match_menu__');
    const matchButtons = Array.from(overlay.querySelectorAll('[data-assert-match]'));
    const expectedWrap = overlay.querySelector('#__at_assert_expected_wrap__');
    const expectedInput = overlay.querySelector('#__at_assert_expected__');
    const error = overlay.querySelector('#__at_assert_error__');
    const currentValue = overlay.querySelector('#__at_assert_current_value__');
    const readModeWrap = overlay.querySelector('#__at_assert_read_mode_wrap__');
    const readModeInput = overlay.querySelector('#__at_assert_read_mode__');
    const readModeSelectRoot = overlay.querySelector('#__at_assert_read_mode_select__');
    const readModeTrigger = overlay.querySelector('#__at_assert_read_mode_trigger__');
    const readModeLabel = overlay.querySelector('#__at_assert_read_mode_label__');
    const readModeMenu = overlay.querySelector('#__at_assert_read_mode_menu__');
    const readModeButtons = Array.from(overlay.querySelectorAll('[data-assert-read-mode]'));
    const attributeWrap = overlay.querySelector('#__at_assert_attribute_wrap__');
    const attributeInput = overlay.querySelector('#__at_assert_attribute__');
    let expectedTouched = false;
    const closeMatchSelect = () => {
      matchMenu.hidden = true;
      matchTrigger.setAttribute('aria-expanded', 'false');
    };
    const closeReadModeSelect = () => {
      readModeMenu.hidden = true;
      readModeTrigger.setAttribute('aria-expanded', 'false');
    };
    const refreshReadValue = () => {
      const target = pendingAssertionTarget;
      const result = getAssertionReadValue(target?.el, readModeInput.value, attributeInput.value);
      if (currentValue) currentValue.textContent = result.ok ? (result.value || '(empty)') : (result.attributeMissing ? '属性不存在' : '读取失败');
      if (!expectedTouched && expectedInput && result.ok) expectedInput.value = result.value;
      if (!result.ok && result.attributeMissing && readModeInput.value === 'attribute') {
        error.textContent = attributeInput.value.trim() ? `目标元素不存在属性“${attributeInput.value.trim()}”。` : '请输入属性名。';
      }
    };
    const updateReadMode = (mode) => {
      const normalizedMode = normalizeAssertionReadMode(mode);
      readModeInput.value = normalizedMode;
      readModeLabel.textContent = assertionReadModeLabel(normalizedMode);
      readModeButtons.forEach((btn) => {
        const selected = btn.dataset.assertReadMode === normalizedMode;
        btn.classList.toggle('__at_selected__', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      attributeWrap.hidden = normalizedMode !== 'attribute' || matchInput.value === 'visible';
      refreshReadValue();
    };
    const updateMatch = (match) => {
      const normalizedMatch = normalizeAssertionMatch(match, 'element');
      matchInput.value = normalizedMatch;
      matchLabel.textContent = assertionMatchLabel(normalizedMatch);
      matchButtons.forEach((btn) => {
        const selected = btn.dataset.assertMatch === normalizedMatch;
        btn.classList.toggle('__at_selected__', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
      expectedWrap.hidden = normalizedMatch === 'visible';
      readModeWrap.hidden = normalizedMatch === 'visible';
      attributeWrap.hidden = readModeInput.value !== 'attribute' || normalizedMatch === 'visible';
      error.textContent = '';
      if (normalizedMatch !== 'visible') refreshReadValue();
    };
    readModeTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = readModeMenu.hidden;
      readModeMenu.hidden = !open;
      readModeTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    readModeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        updateReadMode(btn.dataset.assertReadMode || 'auto');
        closeReadModeSelect();
      });
    });
    matchTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = matchMenu.hidden;
      matchMenu.hidden = !open;
      matchTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    matchButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        updateMatch(btn.dataset.assertMatch || 'contains');
        closeMatchSelect();
      });
    });
    overlay.addEventListener('click', (event) => {
      if (!matchSelectRoot.contains(event.target)) closeMatchSelect();
      if (!readModeSelectRoot.contains(event.target)) closeReadModeSelect();
    });
    attributeInput.addEventListener('input', () => {
      refreshReadValue();
    });
    expectedInput.addEventListener('input', () => {
      expectedTouched = true;
    });
    expectedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        overlay.querySelector('#__at_assert_confirm__')?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (!matchMenu.hidden) closeMatchSelect();
        else closeAssertionDialog();
      }
    });
    overlay.querySelector('#__at_assert_close__')?.addEventListener('click', closeAssertionDialog);
    overlay.querySelector('#__at_assert_cancel__')?.addEventListener('click', closeAssertionDialog);
    overlay.querySelector('#__at_assert_confirm__')?.addEventListener('click', () => {
      const targetName = 'element';
      const match = normalizeAssertionMatch(matchInput.value, targetName);
      const expected = String(expectedInput.value || '');
      const readMode = normalizeAssertionReadMode(readModeInput.value);
      const attribute = String(attributeInput.value || '').trim();
      if (readMode === 'attribute' && !attribute) {
        error.textContent = '请输入属性名。';
        attributeInput.focus();
        return;
      }
      if (match !== 'visible' && expected.trim() === '') {
        error.textContent = tr('请输入期望值，或改用元素可见断言。', 'Enter an expected value or use the element visibility assertion.');
        expectedInput.focus();
        return;
      }
      const target = pendingAssertionTarget;
      closeAssertionDialog();
      if (target?.el) createAssertionStepFromTarget(target.el, targetName, match, expected, readMode, attribute);
    });
    updateReadMode('auto');
    updateMatch(defaultMatch);
    setTimeout(() => {
      if (!expectedWrap.hidden) {
        expectedInput.focus();
        expectedInput.select();
      } else {
        matchTrigger.focus();
      }
    }, 0);
  }

  function createAssertionStepFromTarget(el, target, match, expectedValue, readMode = 'auto', attribute = '') {
    const step = buildAssertionStep(el, target, match, expectedValue, readMode, attribute);
    if (!step) return;
    const visualEl = resolveVisualHighlightForFormControl(el) || el;
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, r.left + r.width / 2, r.top + r.height / 2);
            const fr = focusRectInCrop(crop, visualEl, 4);
            if (fr) step.screenshot_focus_rect = fr;
          }
        }
      } catch (e) { /* ignore */ }
      sendStep(step);
    })();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function handleVariableCaptureClick(event) {
    if (!variableCaptureMode || !isRecording || isPaused) return false;
    let el = normalizeToElement(event.target);
    if (!el || el.closest?.('#__at_toolbar__')) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    setVariableCaptureMode(false);
    el.classList.remove('__at_hover__');
    const value = getVariableSourceValue(el);
    showVariableDialog(el, value);
    return true;
  }

  function handleAssertionCaptureClick(event) {
    if (!assertionCaptureMode || !isRecording || isPaused) return false;
    let el = normalizeToElement(event.target);
    if (!el || el.closest?.('#__at_toolbar__') || el.closest?.('#__at_assertion_dialog__')) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    setAssertionCaptureMode(false);
    el.classList.remove('__at_hover__');
    const value = getAssertionSourceValue(el);
    showAssertionDialog(el, value);
    return true;
  }

  function handleHoverCaptureClick(event) {
    if (!hoverCaptureMode || !isRecording || isPaused) return false;
    let el = normalizeToElement(event.target);
    if (!el || el.closest?.('#__at_toolbar__')) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    clearPendingClickStep();
    clearPendingTreeHover();
    clearPendingHoverStep();
    lastHoverDedupeAt = 0;
    lastHoverDedupeKey = '';
    el.classList.remove('__at_hover__');
    setHoverCaptureMode(false);
    recordHoverStepForTrigger(el, event.clientX, event.clientY);
    sendPendingHoverStep(true);
    return true;
  }

  let pendingClickRecord = null;

  function sendPendingClickRecord(awaitScreenshot = false) {
    if (!pendingClickRecord) return false;
    if (pendingClickRecordTimer) {
      clearTimeout(pendingClickRecordTimer);
      pendingClickRecordTimer = null;
    }
    const pending = pendingClickRecord;
    pendingClickRecord = null;
    if (awaitScreenshot) {
      sendPointerStepWithScreenshot(
        pending.step,
        pending.visualEl,
        pending.clientX,
        pending.clientY,
        pending.screenshotTask,
      );
    } else {
      sendStep(pending.step);
    }
    return true;
  }

  function sendPendingHoverStep(awaitScreenshot = false) {
    if (!pendingHoverStep) return false;
    const pending = pendingHoverStep;
    pendingHoverStep = null;
    pending.sent = true;
    void (async () => {
      if (awaitScreenshot) {
        try { await pending.screenshotTask; } catch (e) { /* ignore */ }
      }
      sendStep(pending.step);
    })();
    return true;
  }

  function scheduleClickStep(step, visualEl, clientX, clientY, screenshotTask = null) {
    if (pendingClickRecordTimer) clearTimeout(pendingClickRecordTimer);
    pendingClickRecord = { step, visualEl, clientX, clientY, screenshotTask };
    pendingClickRecordTimer = setTimeout(() => {
      pendingClickRecordTimer = null;
      const pending = pendingClickRecord;
      pendingClickRecord = null;
      if (!pending) return;
      sendPointerStepWithScreenshot(
        pending.step,
        pending.visualEl,
        pending.clientX,
        pending.clientY,
        pending.screenshotTask,
      );
    }, 260);
  }

  function looksLikePageNavigationClick(event, targetEl, rawEl) {
    const source = rawEl && rawEl.closest ? rawEl : targetEl;
    if (!source || !source.closest) return false;
    const link = source.closest('a[href],area[href]');
    if (link) {
      const rawHref = String(link.getAttribute('href') || '').trim();
      if (!rawHref || rawHref === '#' || /^javascript:/i.test(rawHref)) return false;
      try {
        const u = new URL(rawHref, location.href);
        if (u.href === location.href || (u.pathname === location.pathname && u.search === location.search && u.hash)) {
          return false;
        }
      } catch (e) {
        // 非标准 href 仍可能触发导航，按需立即保存。
      }
      return true;
    }
    const submitter = source.closest('button,input');
    if (submitter) {
      const type = String(submitter.getAttribute('type') || (submitter.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();
      if (type === 'submit' && submitter.closest('form')) return true;
    }
    return false;
  }

  function clearPendingClickStep() {
    if (pendingClickRecordTimer) {
      clearTimeout(pendingClickRecordTimer);
      pendingClickRecordTimer = null;
    }
    pendingClickRecord = null;
  }

  function flushPendingClickStepForNavigation() {
    if (!isRecording || isPaused) return false;
    return sendPendingClickRecord(false);
  }

  function handlePossibleNavigationAfterClick() {
    flushPendingClickStepForNavigation();
  }

  function installNavigationFlushHooks() {
    if (window.__AT_NAVIGATION_FLUSH_HOOKED__) return;
    window.__AT_NAVIGATION_FLUSH_HOOKED__ = true;
    const wrapHistoryMethod = (name) => {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function wrappedHistoryMethod(...args) {
        const ret = original.apply(this, args);
        try {
          handlePossibleNavigationAfterClick();
        } catch (e) { /* ignore */ }
        return ret;
      };
    };
    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
  }

  function clearPendingTreeHover() {
    if (!pendingTreeHoverTimer) return;
    clearTimeout(pendingTreeHoverTimer);
    pendingTreeHoverTimer = null;
    pendingTreeHoverKey = '';
  }

  function clearPendingHoverStep() {
    pendingHoverStep = null;
  }

  function clearToolbarActionTimer() {
    if (!toolbarActionTimer) return;
    clearTimeout(toolbarActionTimer);
    toolbarActionTimer = null;
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!isRecording) return;
      sendHeartbeat();
    }, 25000);
  }

  function resetToolbarButtons() {
    clearToolbarActionTimer();
    const stopBtn = document.getElementById('__at_stop_btn__');
    const cancelBtn = document.getElementById('__at_cancel_btn__');
    const pauseBtn = document.getElementById('__at_pause_btn__');
    const saveVarBtn = document.getElementById('__at_save_var_btn__');
    const addAssertBtn = document.getElementById('__at_add_assert_btn__');
    if (stopBtn) {
      stopBtn.disabled = false;
      stopBtn.classList.remove('__at_saving__');
      stopBtn.textContent = tr('停止并保存', 'Stop and save');
    }
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = tr('取消录制', 'Cancel recording');
    }
    if (pauseBtn) {
      pauseBtn.disabled = false;
      const label = pauseBtn.querySelector('.__at_btn_label__');
      if (label) label.textContent = isPaused ? tr('继续', 'Resume') : tr('暂停', 'Pause');
    }
    if (saveVarBtn) {
      saveVarBtn.disabled = false;
      setVariableCaptureMode(false);
    }
    if (addAssertBtn) {
      addAssertBtn.disabled = false;
      setAssertionCaptureMode(false);
    }
  }

  function armToolbarActionTimeout() {
    clearToolbarActionTimer();
    toolbarActionTimer = setTimeout(() => {
      resetToolbarButtons();
    }, 10000);
  }

  function buildPointerStep(event, actionType) {
    if (!isRecording || isPaused) return;
    const raw = normalizeToElement(event.target);
    if (!raw || raw.tagName === 'BODY' || raw.tagName === 'HTML') return null;

    // 忽略录制工具栏和录制配置弹窗自身的交互。
    if (isRecorderUiElement(raw)) return null;

    // 生成选择器前先移除高亮 class，避免被录入选择器
    raw.classList.remove('__at_hover__');

    const el = resolveClickTargetForRecording(raw);

    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') {
        try {
          const sel = ensureUniqueSelector(el, getUniqueSelector(el));
          // iView 等可能对同一选项连续派发两次 click；用 name+value（radio）更稳，避免 XPath 因重排略有差异
          let dedupeKey = `${getXPath(el)}|${sel}`;
          if (t === 'radio' && el.name) {
            dedupeKey = `radio:${el.name}:${el.value || ''}`;
          } else if (t === 'checkbox' && el.name) {
            dedupeKey = `checkbox:${el.name}:${sel}`;
          }
          const now = Date.now();
          if (dedupeKey === lastToggleDedupeKey && now - lastToggleDedupeAt < 400) {
            return null;
          }
          lastToggleDedupeAt = now;
          lastToggleDedupeKey = dedupeKey;
        } catch (e) {
          /* ignore */
        }
      }
    }

    const rawOptionOverlay = !!getOptionItemElement(raw);
    const inTooltipPopper = !!(raw.closest && raw.closest('.ivu-tooltip-popper'));
    let optionText = rawOptionOverlay ? getOptionText(raw) : '';
    if (rawOptionOverlay && isTextFieldLikeClick(el)) {
      optionText = '';
    }
    const inOverlay = (rawOptionOverlay && String(optionText || '').trim() !== '') || inTooltipPopper;
    let displayText = '';
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el.type || '').toLowerCase())) {
      const aria = el.getAttribute('aria-label');
      const fromLabel = el.labels && el.labels[0] ? el.labels[0].textContent : '';
      displayText = (aria || fromLabel || el.name || el.value || '').trim().slice(0, 30);
    } else {
      displayText = raw.textContent.trim().slice(0, 30);
    }

    const visualEl = resolveVisualHighlightForClick(el);

    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const step = {
      action_type: actionType,
      target_selector: targetSelector,
      target_xpath: targetXpath,
      // 浮层选项把文本存入 value，回放时可用文本兜底查找
      value: optionText,
      is_overlay: inOverlay,
      url: location.href,
      description: inOverlay
        ? tr(`选择选项: "${optionText.slice(0, 40)}"`, `Select option: "${optionText.slice(0, 40)}"`)
        : `${actionType === 'double_click'
          ? tr('双击', 'Double-click')
          : actionType === 'right_click'
            ? tr('右键点击', 'Right-click')
            : tr('点击', 'Click')} ${el.tagName.toLowerCase()}${displayText ? ': ' + displayText : ''}`,
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, optionText || displayText || ''),
    };
    if (actionType === 'click') attachNativeToggleInteractionContext(step, el, raw);
    attachPointerContext(step, el, event.clientX, event.clientY, actionType);
    attachVirtualScrollContext(step, el, raw, optionText || displayText || '');
    if (inOverlay) {
      const reveal = getRevealDependencyForClick(el, raw, true);
      if (reveal) {
        if (!step.locator_meta || typeof step.locator_meta !== 'object') {
          step.locator_meta = { version: 1, candidates: [], context: {} };
        }
        if (!step.locator_meta.context || typeof step.locator_meta.context !== 'object') {
          step.locator_meta.context = {};
        }
        step.locator_meta.context.reveal = reveal;
      }
    } else {
      const reveal = getRevealDependencyForClick(el, raw, false);
      if (reveal) {
        if (!step.locator_meta || typeof step.locator_meta !== 'object') {
          step.locator_meta = { version: 1, candidates: [], context: {} };
        }
        if (!step.locator_meta.context || typeof step.locator_meta.context !== 'object') {
          step.locator_meta.context = {};
        }
        step.locator_meta.context.reveal = reveal;
      }
    }
    return { step, visualEl, clientX: event.clientX, clientY: event.clientY, targetEl: el, rawEl: raw };
  }

  function handleClick(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (isRecorderUiEvent(event)) return;
    if (handleHoverCaptureClick(event)) return;
    if (handleVariableCaptureClick(event)) return;
    if (handleAssertionCaptureClick(event)) return;
    const rawTarget = normalizeToElement(event.target);
    const clickTarget = rawTarget ? resolveClickTargetForRecording(rawTarget) : null;
    const labelControl = rawTarget?.closest?.('label')?.control
      || rawTarget?.closest?.('label')?.querySelector?.('input[type="file"]');
    const fileInput = clickTarget?.tagName === 'INPUT' && String(clickTarget.type || '').toLowerCase() === 'file'
      ? clickTarget
      : labelControl;
    if (fileInput?.tagName === 'INPUT' && String(fileInput.type || '').toLowerCase() === 'file') {
      // 保留目标网页的原生文件选择和上传流程；真正选中文件后由 change 事件记录上传步骤。
      // 此处只跳过普通 click 步骤，避免与随后生成的 upload_file 步骤重复。
      clearPendingClickStep();
      return;
    }
    if (event.detail && event.detail > 1) return;
    const built = buildPointerStep(event, 'click');
    if (!built) return;
    const reveal = getStepReveal(built.step);
    if (looksLikePageNavigationClick(event, built.targetEl, built.rawEl)) {
      clearPendingClickStep();
      flushPendingHoverStepForReveal(reveal, true);
      sendStep(built.step);
      return;
    }
    if (!built.step.is_overlay && isLikelyClickRevealTrigger(built.targetEl, built.rawEl)) {
      rememberRevealTrigger(built.targetEl, 'click', built.clientX, built.clientY);
    }
    flushPendingHoverStepForReveal(reveal, true);
    const screenshotTask = preparePointerStepScreenshot(built.step, built.visualEl, built.clientX, built.clientY);
    scheduleClickStep(built.step, built.visualEl, built.clientX, built.clientY, screenshotTask);
  }

  function handleDoubleClick(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (isRecorderUiEvent(event)) return;
    clearPendingClickStep();
    const built = buildPointerStep(event, 'double_click');
    if (!built) return;
    flushPendingHoverStepForReveal(getStepReveal(built.step), true);
    sendPointerStepWithScreenshot(built.step, built.visualEl, built.clientX, built.clientY);
  }

  function handleContextMenu(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (isRecorderUiEvent(event)) return;
    clearPendingClickStep();
    const built = buildPointerStep(event, 'right_click');
    if (!built) return;
    flushPendingHoverStepForReveal(getStepReveal(built.step), true);
    sendPointerStepWithScreenshot(built.step, built.visualEl, built.clientX, built.clientY);
  }

  let inputTimer = null;
  let pendingInputEl = null;
  let pendingMonacoSelectAll = null;
  /**
   * 原生 checkbox 的默认激活行为会在 click 事件分发前翻转 checked。
   * click（包括 capture 阶段）中读取 checked 已经太晚，因此在按下/键盘激活
   * 时保留点击前的状态，供随后生成 click 步骤时消费。
   */
  let pendingNativeToggleActivation = null;
  /** 避免 label+checkbox 连续两次 click、或同控件极短时间内重复派发 */
  let lastToggleDedupeAt = 0;
  let lastToggleDedupeKey = '';
  /** 悬停录制：同目标短时间内去重；从控件内部子节点间移动不重复录 */
  let lastHoverDedupeAt = 0;
  let lastHoverDedupeKey = '';
  let pendingTreeHoverTimer = null;
  let pendingTreeHoverKey = '';
  let pendingHoverStep = null;
  /** 最近一次悬浮触发器快照，用于给后续浮层点击绑定触发关系 */
  let lastRevealTrigger = null;

  /** 已展开的下拉菜单内移动不录 hover（点选项会录 click） */
  function isInsideDropdownMenuLayer(el) {
    if (!el || !el.closest) return false;
    const knownOverlay = el.closest(
      '.ivu-select-dropdown,.ivu-dropdown-menu,.ivu-cascader-menu,.el-select-dropdown,.el-cascader__dropdown,.ant-select-dropdown,.ant-dropdown-menu,.ant-cascader-dropdown,.ant-cascader-menus,[class*="-ant-select-dropdown"],[class*="-ant-dropdown-menu"],[class*="-ant-cascader-dropdown"],[class*="-ant-cascader-menus"],.el-popper,.v-menu__content,.vs__dropdown-menu,.rc-virtual-list-holder',
    );
    if (knownOverlay) return true;

    // role 只描述控件语义：常驻侧边栏和顶部导航同样可能使用 role=menu。
    // 只有该 ARIA 菜单同时位于已知浮层或 body Portal 的定位容器中，才跳过内部 hover。
    const ariaMenu = el.closest('[role="menu"],[role="listbox"]');
    return Boolean(ariaMenu && getOverlayAncestor(ariaMenu));
  }

  function findTreeHoverTrigger(el) {
    if (!el || !el.closest) return null;
    let content = null;
    let treeNode = null;

    const antNode = el.closest('.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"], .ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"]');
    if (antNode?.closest?.('.ant-tree, .ec-ant-tree, [class$="-ant-tree"], [role="tree"]')) {
      treeNode = antNode.closest('.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"]') || antNode;
      content = treeNode.querySelector('.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"]') || treeNode;
    }

    if (!content) {
      const vtreeNode = el.closest('.vtree-tree-node__indent-wrapper');
      if (vtreeNode?.closest?.('.vtree-tree, .vtree-tree__wrapper')) {
        treeNode = vtreeNode;
        content = vtreeNode.querySelector('.vtree-tree-node__title, .vtree-tree-node__node-body') || vtreeNode;
      }
    }

    if (!content) {
      const genericNode = el.closest('.el-tree-node__content,.ivu-tree-title,.arco-tree-node,.arco-tree-node-title,.n-tree-node,.n-tree-node-content,[role="treeitem"]');
      if (genericNode?.closest?.('.el-tree,.ivu-tree,.arco-tree,.n-tree,[role="tree"]')) {
        treeNode = genericNode;
        content = genericNode;
      }
    }

    if (!content || !treeNode) return null;
    const r = content.getBoundingClientRect();
    const vp = window.innerWidth * window.innerHeight;
    if (vp > 0 && r.width * r.height > vp * 0.38) return null;
    return content;
  }

  function hasVisibleTreeAction(node) {
    if (!node || !node.querySelectorAll) return false;
    const actions = node.querySelectorAll('.tree-node-actions,.action-icon-wrapper,[class*="action-icon"],.data-source-icon,[class*="data-source-icon"],[class*="tree-node-actions"],[class*="node-actions"],[class*="operation"],[class*="toolbar"]');
    for (const action of actions) {
      const r = action.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) continue;
      const st = window.getComputedStyle(action);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) continue;
      return true;
    }
    return false;
  }

  /**
   * 仅当为「需悬停展开的下拉 / 选择器」触发器时返回该元素，否则 null。
   * 不包含普通 button、链接、role=button，避免划向确定/取消/导航时录一堆无效 hover。
   */
  function findStrictHoverTrigger(el) {
    if (!el || !el.closest) return null;
    const t = el.closest(
      [
        '[aria-haspopup="true"]',
        '[aria-haspopup="menu"]',
        '.el-dropdown',
        '.ivu-dropdown',
        '.ant-dropdown-trigger',
        '[class*="-ant-dropdown-trigger"]',
        '.el-dropdown-link',
        '.el-popover__reference',
      ].join(','),
    );
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const vp = window.innerWidth * window.innerHeight;
    if (vp > 0 && r.width * r.height > vp * 0.38) {
      return null;
    }
    return t;
  }

  /** iView Tooltip：悬停 rel 后 teleport 出操作面板（表格行内 data-source-icon 等） */
  function isActionableIvuTooltip(tip, rel) {
    if (!tip || !rel) return false;
    if (rel.querySelector('.data-source-icon, [class*="data-source-icon"]')) return true;
    if (rel.querySelector('svg, .iconfont, .icon, [class*="icon"]')) return true;
    const row = tip.closest('tr, .ivu-table-row, .ant-table-row, .el-table__row, [role="row"]');
    if (row && rel.querySelector('[style*="cursor: pointer"], [style*="cursor:pointer"]')) return true;
    return false;
  }

  function findTooltipHoverTrigger(el) {
    if (!el || !el.closest) return null;
    const tip = el.closest('.ivu-tooltip');
    if (!tip) return null;
    const rel = tip.querySelector('.ivu-tooltip-rel');
    if (!rel) return null;
    if (!isActionableIvuTooltip(tip, rel)) return null;
    const r = rel.getBoundingClientRect();
    const vp = window.innerWidth * window.innerHeight;
    if (vp > 0 && r.width * r.height > vp * 0.38) return null;
    return rel;
  }

  function buildRevealTriggerRef(el, action = 'hover', clientX = null, clientY = null) {
    if (!el) return null;
    try {
      const selector = ensureUniqueSelector(el, getUniqueSelector(el));
      const xpath = getXPath(el);
      if (!selector && !xpath) return null;
      const text = safeText(el.textContent || '').slice(0, 64);
      const ref = {
        action,
        captured_at: Date.now(),
        target_selector: selector || '',
        target_xpath: xpath || '',
        locator_meta: buildSmartLocatorMeta(el, selector || '', xpath || '', text),
      };
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
        attachPointerContext(ref, el, clientX, clientY, action);
      }
      return ref;
    } catch {
      return null;
    }
  }

  function rememberRevealTrigger(el, action = 'hover', clientX = null, clientY = null) {
    const ref = buildRevealTriggerRef(el, action, clientX, clientY);
    if (ref) lastRevealTrigger = { ...ref, _el: el };
  }

  /**
   * 只记住高概率会打开浮层的点击控件。后续若录到菜单/列表框选项，会把该选项
   * 与触发点击建立显式因果关系，回放时即可校验“点击后浮层确实出现”。
   */
  function isLikelyClickRevealTrigger(targetEl, rawEl) {
    const el = targetEl || rawEl;
    if (!el || !el.closest) return false;
    if (el.matches?.('input[type="checkbox"],input[type="radio"],select,option')) return false;
    const host = el.closest([
      '[aria-haspopup]', '[aria-controls]', '[aria-expanded]',
      'button', '[role="button"]', 'summary',
      '.ant-dropdown-trigger', '[class*="-ant-dropdown-trigger"]',
      '.ant-select-selector', '[class*="-ant-select-selector"]',
      '.el-dropdown', '.ivu-dropdown', '.el-popover__reference',
      '.data-source-icon', '[class*="data-source-icon"]',
      '.action-icon-wrapper', '[class*="action-icon"]',
    ].join(','));
    if (!host || host.hasAttribute?.('disabled') || host.getAttribute?.('aria-disabled') === 'true') return false;
    const rect = host.getBoundingClientRect?.();
    const viewportArea = window.innerWidth * window.innerHeight;
    return !rect || viewportArea <= 0 || rect.width * rect.height <= viewportArea * 0.38;
  }

  function getRevealDependencyForClick(targetEl, rawEl, inOverlay = false) {
    const treeAction = getAntTreeActionInfo(targetEl) || getAntTreeActionInfo(rawEl);
    if (treeAction?.treeNode && !inOverlay) {
      const lastEl = lastRevealTrigger?._el || null;
      const lastAge = Date.now() - Number(lastRevealTrigger?.captured_at || 0);
      if (
        lastEl
        && lastAge >= 0
        && lastAge <= 8000
        && (treeAction.treeNode.contains(lastEl) || lastEl.contains(treeAction.treeNode))
      ) {
        return {
          version: 1,
          strategy: 'trigger-first',
          trigger: {
            action: lastRevealTrigger.action || 'hover',
            target_selector: lastRevealTrigger.target_selector || '',
            target_xpath: lastRevealTrigger.target_xpath || '',
            locator_meta: lastRevealTrigger.locator_meta || null,
          },
          max_wait_ms: 3200,
          // 新录制的显式 reveal 关系可作为强效果探针；历史步骤未带该字段时只保留观察语义。
          effect_required: true,
        };
      }
      const ref = buildRevealTriggerRef(treeAction.treeNode, 'hover');
      if (ref) {
        return {
          version: 1,
          strategy: 'trigger-first',
          trigger: {
            action: 'hover',
            target_selector: ref.target_selector || '',
            target_xpath: ref.target_xpath || '',
            locator_meta: ref.locator_meta || null,
          },
          max_wait_ms: 4200,
          effect_required: true,
        };
      }
    }
    if (!lastRevealTrigger) return null;
    const age = Date.now() - Number(lastRevealTrigger.captured_at || 0);
    if (age < 0 || age > 8000) return null;
    const triggerEl = lastRevealTrigger._el || null;
    if (!inOverlay && triggerEl) {
      if (triggerEl === targetEl) return null;
      const directRelated = triggerEl.contains(targetEl) || triggerEl.contains(rawEl);
      const rowSel = 'tr,[role="row"],.ant-table-row,.el-table__row,.ivu-table-row,li,[role="menuitem"],[role="option"]';
      const targetRow = targetEl?.closest ? targetEl.closest(rowSel) : null;
      const triggerRow = triggerEl?.closest ? triggerEl.closest(rowSel) : null;
      const sameRow = targetRow && triggerRow && targetRow === triggerRow;
      if (!directRelated && !sameRow) return null;
    }
    return {
      version: 1,
      strategy: 'trigger-first',
      trigger: {
        action: lastRevealTrigger.action || 'hover',
        target_selector: lastRevealTrigger.target_selector || '',
        target_xpath: lastRevealTrigger.target_xpath || '',
        locator_meta: lastRevealTrigger.locator_meta || null,
      },
      max_wait_ms: 3200,
      effect_required: true,
    };
  }

  function recordHoverStepForTrigger(trigger, clientX, clientY) {
    if (!trigger) return;
    const el = resolveClickTargetForRecording(trigger);
    try {
      const sel = ensureUniqueSelector(el, getUniqueSelector(el));
      const xp = getXPath(el);
      const dedupeKey = `${xp}|${sel}`;
      const now = Date.now();
      if (dedupeKey === lastHoverDedupeKey && now - lastHoverDedupeAt < 550) {
        rememberRevealTrigger(el, 'hover', clientX, clientY);
        return;
      }
      lastHoverDedupeAt = now;
      lastHoverDedupeKey = dedupeKey;
      rememberRevealTrigger(el, 'hover', clientX, clientY);

      const displayText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      const visualEl = resolveVisualHighlightForClick(el);
      const step = {
        action_type: 'hover',
        target_selector: sel,
        target_xpath: xp,
        value: '',
        url: location.href,
        description: `${tr('悬浮', 'Hover')} ${el.tagName.toLowerCase()}${displayText ? ': ' + displayText : ''}`,
        locator_meta: buildSmartLocatorMeta(el, sel, xp, displayText || ''),
      };
      attachPointerContext(step, el, clientX, clientY, 'hover');

      const crop = getThumbCropRect(visualEl);
      const screenshotTask = (async () => {
        try {
          const thumb = await captureStepThumbnail(visualEl, step);
          if (thumb) {
            step.screenshot = thumb;
            if (crop) {
              step.screenshot_focus = focusInCrop(crop, clientX, clientY);
              const fr = focusRectInCrop(crop, visualEl, 6);
              if (fr) step.screenshot_focus_rect = fr;
            }
          }
        } catch (e) { /* ignore */ }
      })();
      pendingHoverStep = {
        step,
        triggerEl: el,
        dedupeKey,
        createdAt: Date.now(),
        screenshotTask,
        sent: false,
      };
    } catch (e) { /* ignore */ }
  }

  function revealMatchesPendingHover(reveal) {
    if (!pendingHoverStep || pendingHoverStep.sent || !reveal?.trigger) return false;
    const trigger = reveal.trigger || {};
    const step = pendingHoverStep.step || {};
    if (trigger.target_selector && step.target_selector && trigger.target_selector === step.target_selector) return true;
    if (trigger.target_xpath && step.target_xpath && trigger.target_xpath === step.target_xpath) return true;
    return false;
  }

  function flushPendingHoverStepForReveal(reveal, immediate = false) {
    if (!revealMatchesPendingHover(reveal)) return null;
    const pending = pendingHoverStep;
    pendingHoverStep = null;
    pending.sent = true;
    const send = async () => {
      if (!immediate) {
        try { await pending.screenshotTask; } catch (e) { /* ignore */ }
      }
      sendStep(pending.step);
    };
    void send();
    return pending.step;
  }

  function getStepReveal(step) {
    const reveal = step?.locator_meta?.context?.reveal;
    return reveal && typeof reveal === 'object' ? reveal : null;
  }

  function scheduleTreeHoverRecord(trigger, event) {
    const node = trigger?.closest?.('.ant-tree-treenode,.ec-ant-tree-treenode,[class*="-ant-tree-treenode"],.vtree-tree-node__indent-wrapper,.el-tree-node__content,.ivu-tree-title,.arco-tree-node,.n-tree-node,[role="treeitem"]') || trigger;
    if (!node) return;
    const key = getXPath(node);
    if (!key) return;
    if (pendingTreeHoverTimer && pendingTreeHoverKey !== key) {
      clearTimeout(pendingTreeHoverTimer);
      pendingTreeHoverTimer = null;
    }
    pendingTreeHoverKey = key;
    const cx = event.clientX;
    const cy = event.clientY;
    pendingTreeHoverTimer = setTimeout(() => {
      pendingTreeHoverTimer = null;
      if (!isRecording || isPaused) return;
      if (!node.isConnected || !hasVisibleTreeAction(node)) return;
      recordHoverStepForTrigger(trigger, cx, cy);
    }, 120);
  }

  function handleHoverRecord(event) {
    if (!isRecording || isPaused) return;
    let raw = event.target;
    if (raw.nodeType === Node.TEXT_NODE) raw = raw.parentElement;
    if (!raw || raw.tagName === 'BODY' || raw.tagName === 'HTML') return;
    if (raw.closest && raw.closest('#__at_toolbar__')) return;
    if (isInsideDropdownMenuLayer(raw)) return;

    let trigger = findTreeHoverTrigger(raw);
    if (trigger) {
      if (event.relatedTarget && trigger.contains(event.relatedTarget)) return;
      scheduleTreeHoverRecord(trigger, event);
      return;
    }
    if (!trigger) trigger = findStrictHoverTrigger(raw);
    if (!trigger) trigger = findTooltipHoverTrigger(raw);
    if (!trigger) trigger = findCustomMenuHoverTrigger(raw);
    if (!trigger) return;

    // 从同一触发器内部子节点间移动不新录一步
    if (event.relatedTarget && trigger.contains(event.relatedTarget)) return;

    recordHoverStepForTrigger(trigger, event.clientX, event.clientY);
  }

  /**
   * 点击落在 label 文字上时，将目标归一为关联的 checkbox/radio，与后续派发到控件上的 click 合并去重。
   */
  function resolveClickTargetForRecording(el) {
    if (!el || !el.closest) return el;
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return el;
    }
    const tagn = (el.tagName || '').toLowerCase();
    const ownerButton = el.closest('button');
    if (ownerButton) return ownerButton;
    const vtreeExpandToggle = el.closest('.vtree-tree-node__square.vtree-tree-node__expand');
    if (vtreeExpandToggle) return vtreeExpandToggle;
    const treeAction = getAntTreeActionInfo(el);
    if (treeAction?.actionHost) return treeAction.actionHost;
    if ((tagn === 'use' || tagn === 'svg' || tagn === 'path') && el.closest('.ivu-table, .ivu-table-row')) {
      const a = el.closest('a');
      if (a) return a;
      const wrap = el.closest('.data-source-icon, [class*="data-source-icon"]');
      if (wrap) {
        const aa = wrap.closest('a');
        if (aa) return aa;
      }
    }
    if (tagn === 'use' || tagn === 'path') {
      const svg = el.closest('svg');
      if (svg) return svg;
    }
    const poptipPop = el.closest('.ivu-poptip-popper, .ivu-tooltip-popper');
    if (poptipPop) {
      const b = el.closest('button');
      if (b) return b;
      const ivuBtn = el.closest('.ivu-btn');
      if (ivuBtn) return ivuBtn;
      const actionIcon = el.closest('.data-source-icon, [class*="data-source-icon"]');
      if (actionIcon) return actionIcon;
    }
    const lab = el.closest('label');
    if (!lab) return el;
    const fid = lab.getAttribute('for');
    if (fid) {
      const byId = document.getElementById(fid);
      if (byId && byId.tagName === 'INPUT') {
        const t = (byId.type || '').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return byId;
      }
    }
    const inner = lab.querySelector('input[type="checkbox"], input[type="radio"]');
    if (inner) return inner;
    // iView / Ant Design：点击落在 wrapper 或装饰节点上时归一到原生 input
    const ivuRadio = el.closest('.ivu-radio-wrapper');
    if (ivuRadio) {
      const inp = ivuRadio.querySelector('input.ivu-radio-input, input[type="radio"]');
      if (inp) return inp;
    }
    const antRadio = el.closest('.ant-radio-wrapper');
    if (antRadio) {
      const inp = antRadio.querySelector('input[type="radio"]');
      if (inp) return inp;
    }
    const elRadio = el.closest('.el-radio');
    if (elRadio) {
      const inp = elRadio.querySelector('input[type="radio"]');
      if (inp) return inp;
    }
    return el;
  }

  function recordedToggleCheckedState(control) {
    if (!control) return false;
    const iviewCheckbox = control.closest?.('.ivu-checkbox');
    if (iviewCheckbox) return iviewCheckbox.classList.contains('ivu-checkbox-checked');
    return Boolean(control.checked);
  }

  function isNativeToggleControl(control) {
    if (!control || control.tagName !== 'INPUT') return false;
    const kind = String(control.type || '').toLowerCase();
    return kind === 'checkbox' || kind === 'radio';
  }

  function rememberNativeToggleStateBeforeActivation(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (!isRecording || isPaused || isRecorderUiEvent(event)) return;
    const raw = normalizeToElement(event.target);
    const control = resolveClickTargetForRecording(raw);
    if (!isNativeToggleControl(control)) return;
    pendingNativeToggleActivation = {
      control,
      checkedBefore: recordedToggleCheckedState(control),
      at: Date.now(),
    };
  }

  function consumeNativeToggleStateBeforeClick(control) {
    const snapshot = pendingNativeToggleActivation;
    pendingNativeToggleActivation = null;
    if (snapshot?.control === control && Date.now() - snapshot.at <= 2000) {
      return snapshot.checkedBefore;
    }
    // 兼容脚本触发、历史页面行为或缺少 pointerdown 的场景。此时无法可靠
    // 还原 pre-click 状态，仍保留现有的 best-effort 记录，而不是丢弃该步骤。
    return recordedToggleCheckedState(control);
  }

  function visibleToggleActivationTarget(raw, control) {
    if (!raw || !control) return null;
    const label = raw.closest?.('label');
    if (label && (label.control === control || label.contains(control))) return label;
    const labels = control.labels ? Array.from(control.labels) : [];
    const visibleLabel = labels.find((item) => {
      if (!item || item.control !== control) return false;
      const rect = item.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });
    if (visibleLabel) return visibleLabel;
    const component = control.closest?.(
      '.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, .ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox',
    );
    if (component) {
      const rect = component.getBoundingClientRect();
      if (rect.width > 2 && rect.height > 2) return component;
    }
    return control;
  }

  /**
   * 原生 checkbox/radio 常只是状态载体，真正接收用户点击的是可见 label 或组件外壳。
   * 两者分开保存，避免回放把隐藏 input 同时当作定位、点击和效果验证目标。
   */
  function attachNativeToggleInteractionContext(step, control, raw) {
    if (!step || !control || control.tagName !== 'INPUT') return;
    const kind = String(control.type || '').toLowerCase();
    if (kind !== 'checkbox' && kind !== 'radio') return;
    const activation = visibleToggleActivationTarget(raw, control);
    const checkedBefore = consumeNativeToggleStateBeforeClick(control);

    if (!step.locator_meta || typeof step.locator_meta !== 'object') {
      step.locator_meta = { version: 1, candidates: [], context: {} };
    }
    if (!step.locator_meta.context || typeof step.locator_meta.context !== 'object') {
      step.locator_meta.context = {};
    }
    step.locator_meta.context.activation_target = {
      type: activation?.tagName === 'LABEL'
        ? 'label'
        : activation === control ? 'native_control' : 'component_root',
      selector: activation ? ensureUniqueSelector(activation, getUniqueSelector(activation)) : '',
      xpath: activation ? getXPath(activation) : '',
    };
    step.locator_meta.context.state_target = {
      type: 'native_toggle',
      selector: step.target_selector || '',
      xpath: step.target_xpath || '',
    };
    step.locator_meta.context.toggle = {
      kind,
      checked_before: checkedBefore,
      expected_checked: kind === 'radio' ? true : !checkedBefore,
    };
  }

  function isSensitivePasswordInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const type = String(el.type || 'text').toLowerCase();
    if (type === 'password') return true;
    const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'current-password' || ac === 'new-password') return true;
    const key = `${el.name || ''} ${el.id || ''}`.toLowerCase();
    if (/(?:^|[-_.])(?:password|passwd|pwd)(?:$|[-_.])/i.test(key)) return true;
    if (/\bpassword\b/.test(key)) return true;
    return false;
  }

  function buildInputStep(el) {
    el.classList.remove('__at_hover__');
    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const sensitive = isSensitivePasswordInput(el);
    const isEditable = !!(el.isContentEditable || (el.closest && el.closest('[contenteditable="true"]')));
    const rawValue = isEditable ? (el.textContent ?? '') : (el.value ?? '');
    const nameHint = el.name ? `[name=${el.name}]` : (el.id ? `[id=${el.id}]` : '');
    return {
      action_type: 'input',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: rawValue,
      value_masked: sensitive ? 1 : 0,
      url: location.href,
      description: sensitive
        ? tr(`输入密码到 ${el.tagName.toLowerCase()}${nameHint}`, `Enter password into ${el.tagName.toLowerCase()}${nameHint}`)
        : tr(
          `输入 "${String(rawValue || '').slice(0, 50)}" 到 ${isEditable ? 'contenteditable' : el.tagName.toLowerCase()}${nameHint}`,
          `Enter "${String(rawValue || '').slice(0, 50)}" into ${isEditable ? 'contenteditable' : el.tagName.toLowerCase()}${nameHint}`,
        ),
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, sensitive ? '' : rawValue),
    };
  }

  function getMonacoEditorRoot(el) {
    if (!el || !el.closest) return null;
    return el.closest('.monaco-editor, .monaco-diff-editor');
  }

  function buildMonacoInputStep(root, value) {
    root.classList.remove('__at_hover__');
    const targetSelector = ensureUniqueSelector(root, getUniqueSelector(root));
    const targetXpath = getXPath(root);
    const meta = buildSmartLocatorMeta(root, targetSelector, targetXpath, value);
    if (!meta.context || typeof meta.context !== 'object') meta.context = {};
    meta.context.editor = 'monaco';
    return {
      action_type: 'input',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value,
      value_masked: 0,
      url: location.href,
      description: value
        ? tr(`输入 "${String(value).slice(0, 50)}" 到 Monaco 编辑器`, `Enter "${String(value).slice(0, 50)}" into the Monaco editor`)
        : tr('清空 Monaco 编辑器', 'Clear the Monaco editor'),
      locator_meta: meta,
    };
  }

  function sendMonacoInputStep(root, value, withScreenshot = true) {
    if (!root) return;
    const step = buildMonacoInputStep(root, value);
    if (!withScreenshot) {
      sendStep(step);
      return;
    }
    const crop = getThumbCropRect(root);
    const r = root.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(root, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, r.left + r.width / 2, r.top + r.height / 2);
            const fr = focusRectInCrop(crop, root, 4);
            if (fr) step.screenshot_focus_rect = fr;
          }
        }
      } catch (e) { /* ignore */ }
      sendStep(step);
    })();
  }

  function sendInputStep(el, withScreenshot = true) {
    if (!el || (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable)) return;
    const step = buildInputStep(el);
    if (!withScreenshot) {
      sendStep(step);
      return;
    }
    const visualEl = resolveVisualHighlightForFormControl(el);
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, r.left + r.width / 2, r.top + r.height / 2);
            const fr = focusRectInCrop(crop, visualEl, 4);
            if (fr) step.screenshot_focus_rect = fr;
          }
        }
      } catch (e) { /* ignore */ }
      sendStep(step);
    })();
  }

  function sendUploadFileStep(el, selectedFile = null) {
    const file = selectedFile || el?.files?.[0] || null;
    if (!el) return;
    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const locatorMeta = buildSmartLocatorMeta(el, targetSelector, targetXpath, '');
    if (!locatorMeta.context || typeof locatorMeta.context !== 'object') locatorMeta.context = {};
    locatorMeta.context.upload_file = file
      ? {
        name: String(file.name || ''),
        mime_type: String(file.type || 'application/octet-stream'),
        byte_size: Number(file.size || 0),
      }
      : { name: '', mime_type: '', byte_size: 0 };
    const step = {
      action_type: 'upload_file',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: '',
      url: location.href,
      description: file
        ? `选择文件 "${String(file.name || '未命名文件').slice(0, 100)}"`
        : '选择测试文件',
      locator_meta: locatorMeta,
    };
    const visualEl = resolveVisualHighlightForFormControl(el);
    const crop = getThumbCropRect(visualEl);
    const rect = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, rect.left + rect.width / 2, rect.top + rect.height / 2);
            const focusRect = focusRectInCrop(crop, visualEl, 4);
            if (focusRect) step.screenshot_focus_rect = focusRect;
          }
        }
      } catch (e) { /* ignore screenshot failures */ }
      sendStep(step);
    })();
  }

  function flushPendingInputFor(el) {
    if (!pendingInputEl) return false;
    if (el && pendingInputEl !== el) return false;
    clearTimeout(inputTimer);
    inputTimer = null;
    const target = pendingInputEl;
    pendingInputEl = null;
    sendInputStep(target, false);
    return true;
  }

  function handleInput(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (!isRecording || isPaused) return;
    if (isRecorderUiEvent(event)) return;
    let el = event.target;
    if (el && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable) {
      el = el.closest?.('[contenteditable="true"]') || el;
    }
    if (!el || (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable)) return;
    // 原生 select 的 input/change 语义不同于文本输入；统一交给 change 录成 select 动作。
    if (el.tagName === 'SELECT') return;
    // 勾选/单选由 click 记录；勾选后会触发 input，value 常为 "on"，避免多记一步「输入 on」
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (
        t === 'checkbox'
        || t === 'radio'
        || t === 'button'
        || t === 'submit'
        || t === 'reset'
        || t === 'file'
        || t === 'image'
        || t === 'hidden'
      ) {
        return;
      }
    }
    clearTimeout(inputTimer);
    pendingInputEl = el;
    inputTimer = setTimeout(() => {
      pendingInputEl = null;
      sendInputStep(el, true);
    }, 600);
  }

  function handleChange(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (!isRecording || isPaused) return;
    if (isRecorderUiEvent(event)) return;
    const el = event.target;
    if (el?.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file') {
      sendUploadFileStep(el);
      return;
    }
    if (!el || el.tagName !== 'SELECT') return;
    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const step = {
      action_type: 'select',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: el.value,
      value_text: el.options[el.selectedIndex]?.text || '',
      url: location.href,
      description: tr(
        `选择 "${el.options[el.selectedIndex]?.text}" 从 select`,
        `Select "${el.options[el.selectedIndex]?.text}" from select`,
      ),
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, el.value),
    };
    const visualEl = resolveVisualHighlightForFormControl(el);
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, r.left + r.width / 2, r.top + r.height / 2);
            const fr = focusRectInCrop(crop, visualEl, 4);
            if (fr) step.screenshot_focus_rect = fr;
          }
        }
      } catch (e) { /* ignore */ }
      sendStep(step);
    })();
  }

  function handleKeyDown(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (!isRecording || isPaused) return;
    if (isRecorderUiEvent(event)) return;
    if (event.isComposing) return;
    const el = event.target;
    // Space 是原生 checkbox/radio 的键盘激活动作；在默认行为翻转状态前缓存。
    if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
      rememberNativeToggleStateBeforeActivation(event);
    }
    const monacoRoot = getMonacoEditorRoot(el);
    if (monacoRoot) {
      const k = String(event.key || '');
      const isSelectAll = (event.ctrlKey || event.metaKey) && k.toLowerCase() === 'a';
      if (isSelectAll) {
        pendingMonacoSelectAll = { root: monacoRoot, at: Date.now() };
        return;
      }
      if (
        pendingMonacoSelectAll
        && pendingMonacoSelectAll.root === monacoRoot
        && Date.now() - pendingMonacoSelectAll.at <= 2500
        && (k === 'Backspace' || k === 'Delete')
      ) {
        pendingMonacoSelectAll = null;
        sendMonacoInputStep(monacoRoot, '', true);
        return;
      }
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(k)) pendingMonacoSelectAll = null;
      return;
    }
    if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
    if (el.closest && el.closest('#__at_toolbar__')) return;
    const k = event.key;
    if (!['Enter', 'Escape', 'Tab'].includes(k)) return;
    flushPendingInputFor(el);
    el.classList.remove('__at_hover__');
    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const step = {
      action_type: 'key',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: k,
      url: location.href,
      description: tr(`按键 ${k}`, `Press ${k}`),
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, k),
    };
    const visualEl = resolveVisualHighlightForFormControl(el);
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl, step);
        if (thumb) {
          step.screenshot = thumb;
          if (crop) {
            step.screenshot_focus = focusInCrop(crop, r.left + r.width / 2, r.top + r.height / 2);
            const fr = focusRectInCrop(crop, visualEl, 4);
            if (fr) step.screenshot_focus_rect = fr;
          }
        }
      } catch (e) { /* ignore */ }
      sendStep(step);
    })();
  }

  // =========================================================
  // 悬停高亮效果
  // =========================================================
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = `.__at_hover__ { outline: 2px solid #ff5722 !important; outline-offset: 2px !important; }`;

  function handleMouseOver(event) {
    if (!isTrustedRecordingEvent(event)) return;
    if (!isRecording || isPaused) return;
    if (isRecorderUiEvent(event)) return;
    let t = event.target;
    if (t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    if (highlightEl) highlightEl.classList.remove('__at_hover__');
    highlightEl = t;
    if (highlightEl?.closest && !highlightEl.closest('#__at_toolbar__')) {
      highlightEl.classList.add('__at_hover__');
    }
    if (!hoverCaptureMode) handleHoverRecord(event);
  }

  // =========================================================
  // 录制工具栏 UI（可拖动标题栏，位置持久化）
  // =========================================================
  const TOOLBAR_POS_KEY = '__at_recorder_toolbar_pos';

  function loadToolbarPos() {
    try {
      const s = localStorage.getItem(TOOLBAR_POS_KEY);
      if (!s) return null;
      const p = JSON.parse(s);
      if (typeof p.left === 'number' && typeof p.top === 'number') return p;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveToolbarPos(left, top) {
    try {
      localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify({ left, top }));
    } catch (e) { /* ignore */ }
  }

  function clampToolbarPos(left, top, el) {
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 80;
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    return {
      left: Math.min(maxL, Math.max(8, left)),
      top: Math.min(maxT, Math.max(8, top)),
    };
  }

  function bindToolbarDrag(panel) {
    const handle = panel.querySelector('#__at_toolbar_drag__');
    if (!handle) return;

    let dragging = false;
    let start = {};

    function onMove(e) {
      if (!dragging) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      const dx = e.clientX - start.mx;
      const dy = e.clientY - start.my;
      const c = clampToolbarPos(start.sl + dx, start.st + dy, panel);
      panel.style.left = `${c.left}px`;
      panel.style.top = `${c.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
    }

    function onTouchEnd() {
      onUp();
    }

    function onTouchMove(e) {
      if (!e.touches?.length) return;
      const te = e.touches[0];
      onMove({ clientX: te.clientX, clientY: te.clientY, preventDefault: () => e.preventDefault() });
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const r = panel.getBoundingClientRect();
      dragging = true;
      start = { mx: e.clientX, my: e.clientY, sl: r.left, st: r.top };
      handle.style.cursor = 'grabbing';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });

    handle.addEventListener('touchstart', (e) => {
      if (!e.touches?.length) return;
      const te = e.touches[0];
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      dragging = true;
      start = { mx: te.clientX, my: te.clientY, sl: r.left, st: r.top };
      document.addEventListener('touchmove', onTouchMove, true);
      document.addEventListener('touchend', onTouchEnd, true);
    }, { passive: false });
  }

  function createToolbar() {
    if (document.getElementById('__at_toolbar__')) return;
    document.head.appendChild(highlightStyle);

    const blinkStyle = document.createElement('style');
    blinkStyle.textContent = `
      @keyframes at-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.45;transform:scale(.78)} }
      @keyframes at-spin { to { transform:rotate(360deg); } }
      #__at_toolbar__, #__at_toolbar__ * { box-sizing:border-box; letter-spacing:0 !important; }
      #__at_toolbar__ {
        position:fixed; z-index:2147483647; width:min(320px,calc(100vw - 16px)); color:#f8fafc;
        border:1px solid rgba(148,163,184,.26); border-radius:12px;
        background:rgba(15,23,42,.94); box-shadow:0 18px 48px rgba(15,23,42,.32);
        font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        pointer-events:none; overflow:hidden; backdrop-filter:blur(14px);
      }
      #__at_toolbar_drag__ {
        display:flex; align-items:center; gap:10px; padding:12px 12px 10px;
        cursor:grab; user-select:none; -webkit-user-select:none; touch-action:none; pointer-events:auto;
        border-bottom:1px solid rgba(148,163,184,.16);
      }
      .__at_status_dot__ {
        width:9px; height:9px; border-radius:999px; background:#22c55e;
        box-shadow:0 0 0 4px rgba(34,197,94,.16); animation:at-pulse 1.2s infinite;
        flex:none;
      }
      .__at_title_stack__ { min-width:0; flex:1; display:grid; gap:2px; }
      .__at_title_stack__ strong { font-size:13px; line-height:1.2; color:#fff; font-weight:750; }
      .__at_drag_mark__ { color:#64748b; font-size:14px; line-height:1; }
      .__at_toolbar_body__ { padding:12px; display:grid; gap:10px; }
      #__at_step_count__ {
        min-height:38px; display:flex; align-items:center; justify-content:space-between; gap:10px;
        border:1px solid rgba(148,163,184,.16); border-radius:10px; background:rgba(15,23,42,.58);
        padding:8px 10px; color:#cbd5e1; font-size:12px; line-height:1.2;
      }
      #__at_step_count__ b { color:#fff; font-size:18px; line-height:1; font-weight:780; }
      .__at_btn_grid__ { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      #__at_hover_btn__ { grid-column:1 / -1; }
      .__at_btn_row__ { display:grid; grid-template-columns:1fr; gap:8px; }
      .__at_btn__ {
        min-height:36px; border:1px solid rgba(148,163,184,.24); border-radius:9px;
        background:rgba(30,41,59,.82); color:#f8fafc; cursor:pointer; pointer-events:auto;
        display:flex; align-items:center; justify-content:center; gap:6px;
        font-size:12px; line-height:1.2; font-weight:720; padding:7px 8px;
        white-space:normal; overflow:visible; text-align:center;
      }
      .__at_btn__ span { white-space:normal; overflow-wrap:anywhere; }
      .__at_btn__:hover { background:rgba(51,65,85,.92); border-color:rgba(203,213,225,.34); }
      .__at_btn__:disabled { cursor:not-allowed; opacity:.58; }
      .__at_btn__.__at_active__ { background:#1d4ed8; border-color:#60a5fa; color:#fff; }
      .__at_btn_primary__ { width:100%; background:#f97316; border-color:#fb923c; color:#fff; }
      .__at_btn_primary__:hover { background:#ea580c; border-color:#fdba74; }
      .__at_btn_primary__.__at_saving__ { opacity:1; cursor:wait; }
      .__at_btn_primary__.__at_saving__::before {
        content:''; width:13px; height:13px; flex:none; border:2px solid rgba(255,255,255,.42);
        border-top-color:#fff; border-radius:999px; animation:at-spin .75s linear infinite;
      }
      .__at_btn_danger__ { width:100%; background:transparent; color:#cbd5e1; border-color:rgba(148,163,184,.22); }
      #__at_variable_dialog__, #__at_variable_dialog__ *,
      #__at_assertion_dialog__, #__at_assertion_dialog__ * { box-sizing:border-box; letter-spacing:0 !important; }
      #__at_variable_dialog__, #__at_assertion_dialog__ {
        position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center;
        background:rgba(15,23,42,.26); pointer-events:auto; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      .__at_var_card__ {
        width:min(420px, calc(100vw - 32px)); border:1px solid rgba(229,231,235,.95); border-radius:12px;
        background:#ffffff; color:#111827; box-shadow:0 24px 72px rgba(15,23,42,.20); padding:18px;
      }
      .__at_var_head__ { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:16px; }
      .__at_var_kicker__ { color:#111827; font-size:11px; font-weight:820; text-transform:uppercase; line-height:1.2; }
      .__at_var_title__ { color:#111827; font-size:17px; font-weight:820; line-height:1.3; margin-top:3px; }
      .__at_icon_btn__ {
        width:30px; height:30px; border:1px solid #e5e7eb; border-radius:8px; background:#f9fafb; color:#6b7280;
        cursor:pointer; font-size:18px; line-height:1;
      }
      .__at_icon_btn__:hover { color:#111827; border-color:#111827; background:#f4f4f5; }
      .__at_var_field__ { display:grid; gap:7px; margin-top:14px; color:#374151; font-size:13px; font-weight:760; }
      .__at_var_field__[hidden] { display:none; }
      .__at_var_head__ + .__at_var_field__ { margin-top:0; }
      .__at_var_label__ { color:#374151; font-size:13px; line-height:1.25; font-weight:760; }
      .__at_var_field__ input,
      .__at_var_field__ select {
        width:100%; height:40px; border:1px solid #d1d5db; border-radius:9px; color:#111827; background:#fff;
        padding:0 11px; outline:none; font:600 14px/1.2 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      }
      .__at_var_field__ input[type="hidden"] { display:none; }
      .__at_var_field__ select { font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; appearance:auto; }
      .__at_var_field__ input:focus,
      .__at_var_field__ select:focus { border-color:#111827; box-shadow:0 0 0 3px rgba(250,255,105,.55); }
      .__at_select__ { position:relative; width:100%; }
      .__at_select_trigger__ {
        width:100%; height:40px; display:flex; align-items:center; justify-content:space-between; gap:10px;
        border:1px solid #d1d5db; border-radius:9px; background:#fff; color:#111827;
        padding:0 11px; font-size:14px; line-height:1.2; font-weight:760; cursor:pointer;
      }
      .__at_select_trigger:hover { border-color:#9ca3af; background:#f9fafb; }
      .__at_select_trigger[aria-expanded="true"] { border-color:#111827; box-shadow:0 0 0 3px rgba(250,255,105,.55); }
      .__at_select_chevron__ { color:#6b7280; font-size:14px; line-height:1; transform:translateY(-1px); }
      .__at_select_menu__ {
        position:absolute; left:0; right:0; top:calc(100% + 6px); z-index:1;
        display:grid; gap:3px; border:1px solid #d1d5db; border-radius:10px; background:#fff;
        padding:5px; box-shadow:0 14px 34px rgba(15,23,42,.16);
      }
      .__at_select_menu__[hidden] { display:none; }
      .__at_select_option__ {
        height:34px; border:0; border-radius:7px; background:transparent; color:#374151; cursor:pointer;
        padding:0 9px; text-align:left; font-size:13px; font-weight:760;
      }
      .__at_select_option__:hover { background:#f3f4f6; color:#111827; }
      .__at_select_option__.__at_selected__ { background:#111827; color:#fff; }
      .__at_var_ai_box__ {
        display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:end; margin-top:12px;
        border:1px solid #e5e7eb; border-radius:10px; background:#f9fafb; padding:10px;
      }
      .__at_var_ai_box__ .__at_var_field__ { margin-top:0; }
      .__at_ai_btn__ {
        height:40px; min-width:86px; border:1px solid #111827; border-radius:9px; background:#111827; color:#fff;
        padding:0 12px; font-size:13px; font-weight:820; cursor:pointer; white-space:nowrap;
      }
      .__at_ai_btn__:disabled { opacity:.58; cursor:wait; }
      .__at_ai_btn__:not(:disabled):hover { background:#27272a; border-color:#27272a; }
      .__at_var_extract_fields__ { display:grid; gap:10px; margin-top:0; }
      .__at_var_extract_fields__[hidden] { display:none; }
      .__at_var_preview__ { display:grid; gap:7px; margin-top:14px; color:#6b7280; font-size:12px; font-weight:720; }
      .__at_assert_preview__ { margin-top:0; }
      .__at_var_preview__ code {
        display:block; max-height:92px; overflow:auto; white-space:pre-wrap; word-break:break-word;
        border:1px solid #e5e7eb; border-radius:9px; background:#f9fafb; color:#111827; padding:10px;
        font:700 13px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      }
      .__at_var_usage__ { margin-top:10px; color:#6b7280; font-size:12px; line-height:1.5; }
      .__at_var_usage__ code { color:#111827; background:#faff69; border-radius:5px; padding:1px 4px; font-weight:800; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
      .__at_var_error__ { min-height:18px; margin-top:8px; color:#dc2626; font-size:12px; line-height:1.4; }
      .__at_var_actions__ { display:flex; justify-content:flex-end; gap:8px; margin-top:8px; }
      .__at_secondary_btn__, .__at_primary_btn__ {
        height:36px; border-radius:9px; padding:0 14px; cursor:pointer; font-size:13px; font-weight:760;
      }
      .__at_secondary_btn__ { border:1px solid #d1d5db; background:#fff; color:#374151; }
      .__at_secondary_btn__:hover { border-color:#111827; color:#111827; background:#f4f4f5; }
      .__at_primary_btn__ { border:1px solid #111827; background:#111827; color:#fff; }
      .__at_primary_btn__:hover { background:#000; border-color:#000; box-shadow:0 0 0 3px rgba(250,255,105,.55); }
    `;
    document.head.appendChild(blinkStyle);

    const toolbar = document.createElement('div');
    toolbar._atBlinkStyleEl = blinkStyle;
    toolbar.id = '__at_toolbar__';
    toolbar.innerHTML = `
        <div id="__at_toolbar_drag__" title="${escapeHtml(tr('拖动移动', 'Drag to move'))}">
          <span class="__at_status_dot__"></span>
          <div class="__at_title_stack__">
            <strong>${escapeHtml(tr('录制中', 'Recording'))}</strong>
          </div>
          <span class="__at_drag_mark__">⠿</span>
        </div>
        <div class="__at_toolbar_body__">
          <div id="__at_step_count__"><span>${escapeHtml(tr('已捕获步骤', 'Captured steps'))}</span><b>0</b></div>
          <div class="__at_btn_row__">
            <button id="__at_pause_btn__" class="__at_btn__" type="button"><span class="__at_btn_label__">${escapeHtml(tr('暂停', 'Pause'))}</span></button>
          </div>
          <div class="__at_btn_grid__">
            <button id="__at_save_var_btn__" class="__at_btn__" type="button"><span class="__at_btn_label__">${escapeHtml(tr('保存变量', 'Save variable'))}</span></button>
            <button id="__at_add_assert_btn__" class="__at_btn__" type="button"><span class="__at_btn_label__">${escapeHtml(tr('添加断言', 'Add assertion'))}</span></button>
            <button id="__at_hover_btn__" class="__at_btn__" type="button"><span class="__at_btn_label__">${escapeHtml(tr('记录悬浮', 'Record hover'))}</span></button>
          </div>
          <button id="__at_stop_btn__" class="__at_btn__ __at_btn_primary__" type="button">${escapeHtml(tr('停止并保存', 'Stop and save'))}</button>
          <button id="__at_cancel_btn__" class="__at_btn__ __at_btn_danger__" type="button">${escapeHtml(tr('取消录制', 'Cancel recording'))}</button>
        </div>
    `;

    toolbar.style.cssText = [
      'pointer-events:none',
    ].join(';');

    toolbar.style.bottom = '24px';
    toolbar.style.right = '16px';
    toolbar.style.top = 'auto';
    toolbar.style.left = 'auto';

    document.body.appendChild(toolbar);

    bindToolbarDrag(toolbar);

    const stopBtn = document.getElementById('__at_stop_btn__');
    const cancelBtn = document.getElementById('__at_cancel_btn__');
    const pauseBtn = document.getElementById('__at_pause_btn__');
    const saveVarBtn = document.getElementById('__at_save_var_btn__');
    const addAssertBtn = document.getElementById('__at_add_assert_btn__');
    const hoverBtn = document.getElementById('__at_hover_btn__');
    pauseBtn.addEventListener('click', () => {
      setPaused(!isPaused);
    });
    saveVarBtn.addEventListener('click', () => {
      if (isPaused) return;
      flushPendingInputFor();
      clearPendingClickStep();
      setVariableCaptureMode(!variableCaptureMode);
    });
    addAssertBtn.addEventListener('click', () => {
      if (isPaused) return;
      flushPendingInputFor();
      clearPendingClickStep();
      setAssertionCaptureMode(!assertionCaptureMode);
    });
    hoverBtn.addEventListener('click', () => {
      if (isPaused) return;
      flushPendingInputFor();
      clearPendingClickStep();
      setHoverCaptureMode(!hoverCaptureMode);
    });
    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      stopBtn.classList.add('__at_saving__');
      stopBtn.textContent = tr('正在保存…', 'Saving...');
      if (cancelBtn) cancelBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      if (saveVarBtn) saveVarBtn.disabled = true;
      if (addAssertBtn) addAssertBtn.disabled = true;
      if (hoverBtn) hoverBtn.disabled = true;
      armToolbarActionTimeout();
      const sendStop = (retried = false) => {
        chrome.runtime.sendMessage({ type: 'AT_STOP_RECORDING' }, (response) => {
          if (chrome.runtime.lastError || response?.ok === false) {
            retryAfterHeartbeat(retried, sendStop, resetToolbarButtons);
            return;
          }
          clearToolbarActionTimer();
          removeToolbar();
        });
      };
      sendStop(false);
    });
    cancelBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      cancelBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      if (saveVarBtn) saveVarBtn.disabled = true;
      if (addAssertBtn) addAssertBtn.disabled = true;
      if (hoverBtn) hoverBtn.disabled = true;
      armToolbarActionTimeout();
      const sendCancel = (retried = false) => {
        chrome.runtime.sendMessage({ type: 'AT_CANCEL_RECORDING' }, (response) => {
          if (chrome.runtime.lastError || response?.ok === false) {
            retryAfterHeartbeat(retried, sendCancel, resetToolbarButtons);
          }
        });
      };
      sendCancel(false);
    });
  }

  function removeToolbar() {
    closeVariableDialog();
    closeAssertionDialog();
    setHoverCaptureMode(false);
    const el = document.getElementById('__at_toolbar__');
    if (el?._atBlinkStyleEl?.parentNode) {
      el._atBlinkStyleEl.remove();
    }
    if (el) el.remove();
    if (highlightEl) { highlightEl.classList.remove('__at_hover__'); highlightEl = null; }
    if (highlightStyle.parentNode) highlightStyle.remove();
    window.__AT_RECORDER_ACTIVE__ = false;
  }

  function updateStepCount(count) {
    const el = document.getElementById('__at_step_count__');
    const num = el?.querySelector?.('b');
    if (num) num.textContent = String(count);
    else if (el) el.textContent = tr(`已捕获: ${count} 步`, `Captured: ${count} steps`);
  }

  function setPaused(paused) {
    isPaused = !!paused;
    try {
      chrome.runtime.sendMessage({ type: 'AT_RECORDING_PAUSE_STATE', paused: isPaused });
    } catch {
      // ignore
    }
    if (isPaused) {
      setVariableCaptureMode(false);
      setAssertionCaptureMode(false);
      setHoverCaptureMode(false);
      flushPendingInputFor();
      clearPendingClickStep();
      clearPendingTreeHover();
      clearPendingHoverStep();
      if (highlightEl) {
        highlightEl.classList.remove('__at_hover__');
        highlightEl = null;
      }
    }
    const pauseBtn = document.getElementById('__at_pause_btn__');
    const dragTitle = document.querySelector('#__at_toolbar_drag__ strong');
    if (pauseBtn) {
      const label = pauseBtn.querySelector('.__at_btn_label__');
      if (label) label.textContent = isPaused ? tr('继续', 'Resume') : tr('暂停', 'Pause');
      pauseBtn.classList.toggle('__at_active__', isPaused);
    }
    if (dragTitle) {
      dragTitle.textContent = isPaused ? tr('录制已暂停', 'Recording paused') : tr('录制中', 'Recording');
    }
  }

  // =========================================================
  // 监听 background 消息
  // =========================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AT_START_RECORDING') {
      isRecording = true;
      currentLocale = normalizeLocale(message.locale || chrome.i18n?.getUILanguage?.());
      recordedVariableNames.clear();
      closeVariableDialog();
      closeAssertionDialog();
      setVariableCaptureMode(false);
      setAssertionCaptureMode(false);
      setHoverCaptureMode(false);
      screenshotMode = String(message.screenshotMode || '').trim().toLowerCase() === 'full_hd' ? 'full_hd' : 'standard';
      lastToggleDedupeAt = 0;
      lastToggleDedupeKey = '';
      pendingNativeToggleActivation = null;
      lastHoverDedupeAt = 0;
      lastHoverDedupeKey = '';
      createToolbar();
      setPaused(message.paused === true);
      startHeartbeat();
      installNavigationFlushHooks();
      document.addEventListener('click', handleClick, true);
      document.addEventListener('pointerdown', rememberNativeToggleStateBeforeActivation, true);
      document.addEventListener('dblclick', handleDoubleClick, true);
      document.addEventListener('contextmenu', handleContextMenu, true);
      document.addEventListener('input', handleInput, true);
      document.addEventListener('change', handleChange, true);
      document.addEventListener('keydown', handleKeyDown, true);
      document.addEventListener('mouseover', handleMouseOver, true);
      window.addEventListener('pagehide', handlePossibleNavigationAfterClick, true);
      window.addEventListener('beforeunload', handlePossibleNavigationAfterClick, true);
      window.addEventListener('hashchange', handlePossibleNavigationAfterClick, true);
      window.addEventListener('popstate', handlePossibleNavigationAfterClick, true);
      sendResponse({ ok: true });
    }

    if (message.type === 'AT_STOP_RECORDING_ACK') {
      clearToolbarActionTimer();
      stopHeartbeat();
      isRecording = false;
      isPaused = false;
      recordedVariableNames.clear();
      closeVariableDialog();
      closeAssertionDialog();
      setVariableCaptureMode(false);
      setAssertionCaptureMode(false);
      setHoverCaptureMode(false);
      flushPendingInputFor();
      clearPendingClickStep();
      pendingNativeToggleActivation = null;
      clearPendingTreeHover();
      clearPendingHoverStep();
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('pointerdown', rememberNativeToggleStateBeforeActivation, true);
      document.removeEventListener('dblclick', handleDoubleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('change', handleChange, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mouseover', handleMouseOver, true);
      window.removeEventListener('pagehide', handlePossibleNavigationAfterClick, true);
      window.removeEventListener('beforeunload', handlePossibleNavigationAfterClick, true);
      window.removeEventListener('hashchange', handlePossibleNavigationAfterClick, true);
      window.removeEventListener('popstate', handlePossibleNavigationAfterClick, true);
      const stopBtn = document.getElementById('__at_stop_btn__');
      const cancelBtn = document.getElementById('__at_cancel_btn__');
      const pauseBtn = document.getElementById('__at_pause_btn__');
      const hoverBtn = document.getElementById('__at_hover_btn__');
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.classList.add('__at_saving__');
        stopBtn.textContent = tr('正在保存…', 'Saving...');
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      if (hoverBtn) hoverBtn.disabled = true;
      sendResponse({ ok: true });
    }

    if (message.type === 'AT_CANCEL_RECORDING_ACK') {
      clearToolbarActionTimer();
      stopHeartbeat();
      isRecording = false;
      isPaused = false;
      recordedVariableNames.clear();
      closeVariableDialog();
      closeAssertionDialog();
      setVariableCaptureMode(false);
      setAssertionCaptureMode(false);
      setHoverCaptureMode(false);
      clearTimeout(inputTimer);
      inputTimer = null;
      pendingInputEl = null;
      clearPendingClickStep();
      pendingNativeToggleActivation = null;
      clearPendingTreeHover();
      clearPendingHoverStep();
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('pointerdown', rememberNativeToggleStateBeforeActivation, true);
      document.removeEventListener('dblclick', handleDoubleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('change', handleChange, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mouseover', handleMouseOver, true);
      window.removeEventListener('pagehide', handlePossibleNavigationAfterClick, true);
      window.removeEventListener('beforeunload', handlePossibleNavigationAfterClick, true);
      window.removeEventListener('hashchange', handlePossibleNavigationAfterClick, true);
      window.removeEventListener('popstate', handlePossibleNavigationAfterClick, true);
      const stopBtn2 = document.getElementById('__at_stop_btn__');
      const cancelBtn2 = document.getElementById('__at_cancel_btn__');
      const pauseBtn2 = document.getElementById('__at_pause_btn__');
      if (stopBtn2) stopBtn2.disabled = true;
      if (cancelBtn2) {
        cancelBtn2.disabled = true;
        cancelBtn2.textContent = tr('已取消', 'Cancelled');
      }
      if (pauseBtn2) pauseBtn2.disabled = true;
      setTimeout(() => {
        removeToolbar();
      }, 220);
      sendResponse({ ok: true });
    }

    if (message.type === 'AT_UPDATE_STEP_COUNT') {
      updateStepCount(message.count);
      sendResponse({ ok: true });
    }
  });

})();
