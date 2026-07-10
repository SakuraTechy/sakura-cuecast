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
  let highlightEl = null;

  // =========================================================
  // 元素选择器生成算法
  // =========================================================
  /** React/Ant Design/rc 组件等运行时自增 id，重渲染后会变，不能用于稳定定位 */
  function isVolatileAutoId(id) {
    if (!id || typeof id !== 'string') return true;
    if (/^\d+$/.test(id)) return true;
    if (/[a-f0-9]{8,}/i.test(id)) return true;
    // ant-design / rc-select / rc-input 等：rc_xxx_数字
    if (/^rc_[a-z0-9_]+_\d+$/i.test(id)) return true;
    // React useId 常见形式
    if (/^:r[a-z0-9]*:$/i.test(id)) return true;
    if (/^radix-/i.test(id)) return true;
    if (/^headlessui/i.test(id)) return true;
    return false;
  }

  const selectorCore = window.__AT_SELECTOR_CORE__ || {};
  const isVolatileStateClass = typeof selectorCore.isVolatileStateClass === 'function'
    ? selectorCore.isVolatileStateClass.bind(selectorCore)
    : (cls) => !!cls && /(?:^|[-_])(focus|focused|focusing|hover|hovered|active|activated|selected|selecting|current|checked|open|opened|expanded)(?:$|[-_])/i.test(cls);
  const cleanClasses = typeof selectorCore.cleanClasses === 'function'
    ? selectorCore.cleanClasses.bind(selectorCore)
    : function fallbackCleanClasses(el) {
      if (!el.className || typeof el.className !== 'string') return [];
      return el.className.trim().split(/\s+/).filter(c =>
        c
        && !c.startsWith('__at_')
        && !/^[a-f0-9]{6,}$/.test(c)
        && !/(?:^|[-_])(focus|focused|focusing|hover|hovered|active|activated|selected|selecting|current|checked|open|opened|expanded)(?:$|[-_])/i.test(c)
        && !/^is-(focused|active|selected|current|checked|open|expanded)$/i.test(c)
        && !/^has-(focus|focused)$/i.test(c)
      );
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
    const actionHost = el.closest('.data-source-icon, [class*="data-source-icon"]')
      || el.closest('.action-icon-wrapper, [class*="action-icon"]');
    if (!actionHost) return null;
    const treeNode = actionHost.closest('.ant-tree-node-content-wrapper, .ant-tree-treenode, [role="treeitem"]');
    if (!treeNode) return null;
    const titleEl = treeNode.querySelector('.ant-tree-title') || treeNode;
    const title = getTreeNodeVisibleTitle(titleEl);
    let hosts = Array.from(treeNode.querySelectorAll(
      '.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"]',
    ));
    if (!hosts.length) {
      hosts = Array.from(treeNode.querySelectorAll(
        '.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"]',
      ));
    }
    hosts = hosts.filter((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 0 || r.height > 0 || node.contains(actionHost);
    });
    const actionIndex = Math.max(0, hosts.indexOf(actionHost));
    const treeRoot = treeNode.closest('.ant-tree') || document;
    let antNodes = Array.from(treeRoot.querySelectorAll('.ant-tree-treenode'));
    if (!antNodes.length) {
      antNodes = Array.from(treeRoot.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
    }
    const pathInfo = buildVisibleTreePathInfo(
      treeNode,
      antNodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title') || node),
      (node) => node.querySelector?.('.ant-tree-node-content-wrapper') || node,
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
    const nodeRoot = el.closest('.ant-tree-treenode');
    const content = el.closest('.ant-tree-node-content-wrapper');
    if (!nodeRoot && !content) return null;
    const treeNode = nodeRoot || content;
    const treeRoot = treeNode.closest('.ant-tree') || document;
    const titleEl = treeNode.querySelector?.('.ant-tree-title') || treeNode;
    const title = getTreeNodeVisibleTitle(titleEl);
    if (!title) return null;
    let nodes = Array.from(treeRoot.querySelectorAll('.ant-tree-treenode'));
    if (!nodes.length) nodes = Array.from(treeRoot.querySelectorAll('.ant-tree-node-content-wrapper, [role="treeitem"]'));
    const sameTitleIndex = nodes
      .filter((node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title') || node) === title)
      .indexOf(treeNode);
    const pathInfo = buildVisibleTreePathInfo(
      treeNode,
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title') || node),
      (node) => node.querySelector?.('.ant-tree-node-content-wrapper') || node,
    );
    return {
      framework: 'ant-tree',
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
      if (el.closest?.('.ant-tree-switcher')) {
        return {
          framework: 'ant-tree',
          kind: 'expand_toggle',
          title: antInfo.title,
          sameTitleIndex: antInfo.sameTitleIndex,
          parentPath: antInfo.parentPath,
          level: antInfo.level,
        };
      }
      if (el.closest?.('.ant-tree-node-content-wrapper, .ant-tree-title')) {
        return {
          framework: 'ant-tree',
          kind: 'node_content',
          title: antInfo.title,
          sameTitleIndex: antInfo.sameTitleIndex,
          parentPath: antInfo.parentPath,
          level: antInfo.level,
        };
      }
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
      ['name', 0.92],
      ['aria-label', 0.9],
      ['placeholder', 0.82],
      ['title', 0.8],
      ['role', 0.76],
    ];
    for (const [attr, rawBaseScore] of attrs) {
      const v = el?.getAttribute?.(attr);
      if (!v) continue;
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
    if (treeNodeInfo?.title) {
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
    if (tablePos) {
      if (tablePos.scoped_xpath) {
        pushLocatorCandidate(candidates, {
          type: 'table_cell_xpath',
          value: tablePos.scoped_xpath,
          score: 0.94,
        });
      }
      if (tablePos.scoped_css) {
        const unique = selectorUnique(tablePos.scoped_css);
        pushLocatorCandidate(candidates, {
          type: 'table_cell_css',
          value: tablePos.scoped_css,
          score: unique ? 0.93 : 0.82,
        });
      }
    }

    // 文本候选：用于按钮、链接、菜单项等语义动作的回退定位
    const text = safeText(stepValue || el?.textContent || '');
    if (text && ['button', 'a', 'li', 'label', 'span', 'div'].includes(tag)) {
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
      version: 1,
      generated_at: Date.now(),
      candidates: candidates.slice(0, 12),
      context: {
        ...buildLocatorContext(el),
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

  function getUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    // 浮层选项（teleport 下拉框）：CSS 结构路径不稳定，留空让 XPath 定位
    if (getOverlayAncestor(el)) return '';

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
    for (const attr of ['data-testid', 'data-test', 'data-id', 'name', 'aria-label', 'role']) {
      const val = el.getAttribute(attr);
      if (val) {
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
            if (table && table.id && !/^\d+$/.test(table.id) && !/[a-f0-9]{8,}/i.test(table.id)) {
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
      if (title) {
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

  // 检测元素是否在被 teleport 到 body 的浮层里（iView/Element UI/Ant Design 下拉框等）
  // 这类元素在 DOM 中只有浮层展开时才存在，结构路径极度不稳定
  const OVERLAY_CLASSES = [
    'ivu-select-dropdown', 'ivu-dropdown-menu', 'ivu-transfer-list',
    'ivu-tooltip-popper',
    'el-select-dropdown', 'el-dropdown-menu', 'el-cascader__dropdown',
    'ant-select-dropdown', 'ant-dropdown', 'ant-cascader-menus',
    'v-menu__content', 'vs__dropdown-menu',
  ];

  function getOverlayAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (OVERLAY_CLASSES.some(cls => cur.classList?.contains(cls))) return cur;
      // 兜底：body 直系子元素且 position fixed/absolute 通常是 teleport 浮层
      if (cur.parentElement === document.body) {
        const style = window.getComputedStyle(cur);
        if (['fixed', 'absolute'].includes(style.position)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
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

    // 浮层选项：用文本内容生成可跨状态定位的 XPath
    const overlay = getOverlayAncestor(el);
    if (overlay) {
      const text = getOptionText(el);
      if (text) {
        // 找最近的 li / 选项容器
        const itemEl = el.closest('li, [class*="select-item"], [class*="option-item"]') || el;
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
      const siblings = Array.from(cur.parentNode?.children || []).filter(s => s.tagName === cur.tagName);
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

  function captureStepThumbnailByCrop(crop) {
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
            resolve(resp && resp.dataUrl ? resp.dataUrl : '');
          },
        );
      } catch (e) {
        resolve('');
      }
    });
  }

  /** 截取当前视口内目标元素区域缩略图（由 background 裁剪整页截图） */
  function captureStepThumbnail(el) {
    return captureStepThumbnailByCrop(getThumbCropRect(el));
  }

  let pendingClickRecordTimer = null;
  let toolbarActionTimer = null;
  let heartbeatTimer = null;

  function preparePointerStepScreenshot(step, visualEl, clientX, clientY) {
    const crop = getThumbCropRect(visualEl);
    const focus = crop ? focusInCrop(crop, clientX, clientY) : null;
    const fr = crop ? focusRectInCrop(crop, visualEl, 6) : null;
    return (async () => {
      try {
        const thumb = await captureStepThumbnailByCrop(crop);
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

  function scheduleClickStep(step, visualEl, clientX, clientY, screenshotTask = null) {
    if (pendingClickRecordTimer) clearTimeout(pendingClickRecordTimer);
    pendingClickRecordTimer = setTimeout(() => {
      pendingClickRecordTimer = null;
      sendPointerStepWithScreenshot(step, visualEl, clientX, clientY, screenshotTask);
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
    if (!pendingClickRecordTimer) return;
    clearTimeout(pendingClickRecordTimer);
    pendingClickRecordTimer = null;
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
    if (stopBtn) {
      stopBtn.disabled = false;
      stopBtn.textContent = '停止并保存';
    }
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = '取消录制';
    }
    if (pauseBtn) pauseBtn.disabled = false;
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

    // 忽略录制工具栏自身的点击
    if (raw.closest && raw.closest('#__at_toolbar__')) return null;

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

    const rawOverlay = !!getOverlayAncestor(raw);
    const inTooltipPopper = !!(raw.closest && raw.closest('.ivu-tooltip-popper'));
    let optionText = rawOverlay ? getOptionText(raw) : '';
    if (rawOverlay && isTextFieldLikeClick(el)) {
      optionText = '';
    }
    const inOverlay = (rawOverlay && String(optionText || '').trim() !== '') || inTooltipPopper;
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
        ? `选择选项: "${optionText.slice(0, 40)}"`
        : `${actionType === 'double_click' ? '双击' : actionType === 'right_click' ? '右键点击' : '点击'} ${el.tagName.toLowerCase()}${displayText ? ': ' + displayText : ''}`,
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, optionText || displayText || ''),
    };
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
    flushPendingHoverStepForReveal(reveal, true);
    const screenshotTask = preparePointerStepScreenshot(built.step, built.visualEl, built.clientX, built.clientY);
    scheduleClickStep(built.step, built.visualEl, built.clientX, built.clientY, screenshotTask);
  }

  function handleDoubleClick(event) {
    clearPendingClickStep();
    const built = buildPointerStep(event, 'double_click');
    if (!built) return;
    flushPendingHoverStepForReveal(getStepReveal(built.step), true);
    sendPointerStepWithScreenshot(built.step, built.visualEl, built.clientX, built.clientY);
  }

  function handleContextMenu(event) {
    clearPendingClickStep();
    const built = buildPointerStep(event, 'right_click');
    if (!built) return;
    flushPendingHoverStepForReveal(getStepReveal(built.step), true);
    sendPointerStepWithScreenshot(built.step, built.visualEl, built.clientX, built.clientY);
  }

  let inputTimer = null;
  let pendingInputEl = null;
  let pendingMonacoSelectAll = null;
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
    return !!el.closest(
      '.ivu-select-dropdown,.ivu-dropdown-menu,.el-select-dropdown,.ant-select-dropdown,.el-popper,.v-menu__content,.vs__dropdown-menu,.rc-virtual-list-holder,.ant-cascader-menus',
    );
  }

  function findTreeHoverTrigger(el) {
    if (!el || !el.closest) return null;
    let content = null;
    let treeNode = null;

    const antNode = el.closest('.ant-tree-treenode, .ant-tree-node-content-wrapper');
    if (antNode?.closest?.('.ant-tree')) {
      treeNode = antNode.closest('.ant-tree-treenode') || antNode;
      content = treeNode.querySelector('.ant-tree-node-content-wrapper') || treeNode;
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

  function buildRevealTriggerRef(el, action = 'hover') {
    if (!el) return null;
    try {
      const selector = ensureUniqueSelector(el, getUniqueSelector(el));
      const xpath = getXPath(el);
      if (!selector && !xpath) return null;
      const text = safeText(el.textContent || '').slice(0, 64);
      return {
        action,
        captured_at: Date.now(),
        target_selector: selector || '',
        target_xpath: xpath || '',
        locator_meta: buildSmartLocatorMeta(el, selector || '', xpath || '', text),
      };
    } catch {
      return null;
    }
  }

  function rememberRevealTrigger(el, action = 'hover') {
    const ref = buildRevealTriggerRef(el, action);
    if (ref) lastRevealTrigger = { ...ref, _el: el };
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
        rememberRevealTrigger(el, 'hover');
        return;
      }
      lastHoverDedupeAt = now;
      lastHoverDedupeKey = dedupeKey;
      rememberRevealTrigger(el, 'hover');

      const displayText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      const visualEl = resolveVisualHighlightForClick(el);
      const step = {
        action_type: 'hover',
        target_selector: sel,
        target_xpath: xp,
        value: '',
        url: location.href,
        description: `悬浮 ${el.tagName.toLowerCase()}${displayText ? ': ' + displayText : ''}`,
        locator_meta: buildSmartLocatorMeta(el, sel, xp, displayText || ''),
      };

      const crop = getThumbCropRect(visualEl);
      const screenshotTask = (async () => {
        try {
          const thumb = await captureStepThumbnail(visualEl);
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
    const node = trigger?.closest?.('.ant-tree-treenode,.vtree-tree-node__indent-wrapper,.el-tree-node__content,.ivu-tree-title,.arco-tree-node,.n-tree-node,[role="treeitem"]') || trigger;
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
    const rawValue = el.value ?? '';
    const nameHint = el.name ? `[name=${el.name}]` : (el.id ? `[id=${el.id}]` : '');
    return {
      action_type: 'input',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: rawValue,
      value_masked: sensitive ? 1 : 0,
      url: location.href,
      description: sensitive
        ? `输入密码到 ${el.tagName.toLowerCase()}${nameHint}`
        : `输入 "${String(el.value || '').slice(0, 50)}" 到 ${el.tagName.toLowerCase()}${nameHint}`,
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
      description: value ? `输入 "${String(value).slice(0, 50)}" 到 Monaco 编辑器` : '清空 Monaco 编辑器',
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
        const thumb = await captureStepThumbnail(root);
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
    if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
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
        const thumb = await captureStepThumbnail(visualEl);
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
    if (!isRecording || isPaused) return;
    const el = event.target;
    if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
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
    if (!isRecording || isPaused) return;
    const el = event.target;
    if (!el || el.tagName !== 'SELECT') return;
    const targetSelector = ensureUniqueSelector(el, getUniqueSelector(el));
    const targetXpath = getXPath(el);
    const step = {
      action_type: 'input',
      target_selector: targetSelector,
      target_xpath: targetXpath,
      value: el.value,
      url: location.href,
      description: `选择 "${el.options[el.selectedIndex]?.text}" 从 select`,
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, el.value),
    };
    const visualEl = resolveVisualHighlightForFormControl(el);
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl);
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
    if (!isRecording || isPaused) return;
    if (event.isComposing) return;
    const el = event.target;
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
      description: `按键 ${k}`,
      locator_meta: buildSmartLocatorMeta(el, targetSelector, targetXpath, k),
    };
    const visualEl = resolveVisualHighlightForFormControl(el);
    const crop = getThumbCropRect(visualEl);
    const r = visualEl.getBoundingClientRect();
    void (async () => {
      try {
        const thumb = await captureStepThumbnail(visualEl);
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
    if (!isRecording || isPaused) return;
    let t = event.target;
    if (t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    if (highlightEl) highlightEl.classList.remove('__at_hover__');
    highlightEl = t;
    if (highlightEl?.closest && !highlightEl.closest('#__at_toolbar__')) {
      highlightEl.classList.add('__at_hover__');
    }
    handleHoverRecord(event);
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
    blinkStyle.textContent = '@keyframes at-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }';
    document.head.appendChild(blinkStyle);

    const toolbar = document.createElement('div');
    toolbar._atBlinkStyleEl = blinkStyle;
    toolbar.id = '__at_toolbar__';
    toolbar.innerHTML = `
        <div id="__at_toolbar_drag__" title="拖动移动" style="
          display:flex;align-items:center;gap:8px;margin-bottom:10px;
          cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;
          pointer-events:auto
        ">
          <span style="width:8px;height:8px;background:#ff5722;border-radius:50%;animation:at-blink 1s infinite;display:inline-block;flex-shrink:0"></span>
          <strong style="font-size:13px;flex:1">录制中…</strong>
          <span style="font-size:10px;color:#888;letter-spacing:0.02em">⠿</span>
        </div>
        <div id="__at_step_count__" style="font-size:12px;color:#aaa;margin-bottom:10px">已捕获: 0 步</div>
        <button id="__at_pause_btn__" type="button" style="
          width:100%;background:#303047;color:#fff;border:1px solid #5a5a7a;
          border-radius:6px;padding:6px 0;cursor:pointer;font-size:12px;font-weight:600;
          pointer-events:auto;margin-bottom:8px
        ">暂停录制</button>
        <button id="__at_stop_btn__" type="button" style="
          width:100%;background:#ff5722;color:#fff;border:none;
          border-radius:6px;padding:6px 0;cursor:pointer;font-size:13px;font-weight:600;
          pointer-events:auto
        ">停止并保存</button>
        <button id="__at_cancel_btn__" type="button" style="
          width:100%;margin-top:8px;background:transparent;color:#aaa;border:1px solid #444;
          border-radius:6px;padding:6px 0;cursor:pointer;font-size:12px;
          pointer-events:auto
        ">取消录制</button>
    `;

    toolbar.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'background:#1a1a2e',
      'color:#fff',
      'border-radius:10px',
      'padding:12px 16px',
      'font-family:system-ui,sans-serif',
      'box-shadow:0 4px 20px rgba(0,0,0,0.4)',
      'min-width:200px',
      'border:1px solid #ff5722',
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
    pauseBtn.addEventListener('click', () => {
      setPaused(!isPaused);
    });
    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      armToolbarActionTimeout();
      const sendStop = (retried = false) => {
        chrome.runtime.sendMessage({ type: 'AT_STOP_RECORDING' }, (response) => {
          if (chrome.runtime.lastError || response?.ok === false) {
            retryAfterHeartbeat(retried, sendStop, resetToolbarButtons);
          }
        });
      };
      sendStop(false);
    });
    cancelBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      cancelBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
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
    if (el) el.textContent = `已捕获: ${count} 步`;
  }

  function setPaused(paused) {
    isPaused = !!paused;
    try {
      chrome.runtime.sendMessage({ type: 'AT_RECORDING_PAUSE_STATE', paused: isPaused });
    } catch {
      // ignore
    }
    if (isPaused) {
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
      pauseBtn.textContent = isPaused ? '继续录制' : '暂停录制';
      pauseBtn.style.background = isPaused ? '#1f4d2b' : '#303047';
      pauseBtn.style.borderColor = isPaused ? '#2d8a47' : '#5a5a7a';
      pauseBtn.style.color = '#fff';
    }
    if (dragTitle) {
      dragTitle.textContent = isPaused ? '录制已暂停' : '录制中…';
    }
  }

  // =========================================================
  // 监听 background 消息
  // =========================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AT_START_RECORDING') {
      isRecording = true;
      screenshotMode = String(message.screenshotMode || '').trim().toLowerCase() === 'full_hd' ? 'full_hd' : 'standard';
      lastToggleDedupeAt = 0;
      lastToggleDedupeKey = '';
      lastHoverDedupeAt = 0;
      lastHoverDedupeKey = '';
      createToolbar();
      setPaused(message.paused === true);
      startHeartbeat();
      document.addEventListener('click', handleClick, true);
      document.addEventListener('dblclick', handleDoubleClick, true);
      document.addEventListener('contextmenu', handleContextMenu, true);
      document.addEventListener('input', handleInput, true);
      document.addEventListener('change', handleChange, true);
      document.addEventListener('keydown', handleKeyDown, true);
      document.addEventListener('mouseover', handleMouseOver, true);
      sendResponse({ ok: true });
    }

    if (message.type === 'AT_STOP_RECORDING_ACK') {
      clearToolbarActionTimer();
      stopHeartbeat();
      isRecording = false;
      isPaused = false;
      flushPendingInputFor();
      clearPendingClickStep();
      clearPendingTreeHover();
      clearPendingHoverStep();
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('dblclick', handleDoubleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('change', handleChange, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mouseover', handleMouseOver, true);
      const stopBtn = document.getElementById('__at_stop_btn__');
      const cancelBtn = document.getElementById('__at_cancel_btn__');
      const pauseBtn = document.getElementById('__at_pause_btn__');
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.textContent = '正在保存…';
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      setTimeout(() => {
        removeToolbar();
      }, 450);
      sendResponse({ ok: true });
    }

    if (message.type === 'AT_CANCEL_RECORDING_ACK') {
      clearToolbarActionTimer();
      stopHeartbeat();
      isRecording = false;
      isPaused = false;
      clearTimeout(inputTimer);
      inputTimer = null;
      pendingInputEl = null;
      clearPendingClickStep();
      clearPendingTreeHover();
      clearPendingHoverStep();
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('dblclick', handleDoubleClick, true);
      document.removeEventListener('contextmenu', handleContextMenu, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('change', handleChange, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mouseover', handleMouseOver, true);
      const stopBtn2 = document.getElementById('__at_stop_btn__');
      const cancelBtn2 = document.getElementById('__at_cancel_btn__');
      const pauseBtn2 = document.getElementById('__at_pause_btn__');
      if (stopBtn2) stopBtn2.disabled = true;
      if (cancelBtn2) {
        cancelBtn2.disabled = true;
        cancelBtn2.textContent = '已取消';
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
