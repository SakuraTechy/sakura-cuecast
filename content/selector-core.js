(function () { 'use strict'; if (window.__AT_SELECTOR_CORE__) return;
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

  function isVolatileStateClass(cls) {
    if (!cls || typeof cls !== 'string') return false;
    return [
      /(?:^|[-_])(focus|focused|focusing)(?:$|[-_])/i,
      /(?:^|[-_])(hover|hovered)(?:$|[-_])/i,
      /(?:^|[-_])(active|activated)(?:$|[-_])/i,
      /(?:^|[-_])(selected|selecting)(?:$|[-_])/i,
      /(?:^|[-_])(current|checked)(?:$|[-_])/i,
      /(?:^|[-_])(open|opened|expanded)(?:$|[-_])/i,
      /^is-focused$/i,
      /^is-(active|selected|current|checked|open|expanded)$/i,
      /^has-(focus|focused)$/i,
    ].some((re) => re.test(cls));
  }

  // 过滤掉录制工具临时注入的 class、纯随机 hash class，以及 focus/hover 等瞬时状态 class
  function cleanClasses(el) {
    if (!el.className || typeof el.className !== 'string') return [];
    return el.className.trim().split(/\s+/).filter(c =>
      c && !c.startsWith('__at_') && !/^[a-f0-9]{6,}$/.test(c) && !isVolatileStateClass(c)
    );
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

  function getUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

    // 浮层选项（teleport 下拉框）：CSS 结构路径不稳定，留空让 XPath 定位
    if (getOverlayAncestor(el)) return '';

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

  // 从元素或其祖先中提取选项文本（去掉子图标、子元素纯取文本）
  function getOptionText(el) {
    // 先找最近的 li / option 祖先
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

    // iView Poptip / Modal 内 textarea、文本 input、富文本：锚在弹层上，避免 teleport 到 body 后整页绝对路径失效
    const popper = el.closest('.ivu-poptip-popper, .ivu-modal .ivu-modal-body');
    if (popper) {
      const anchor = popper.classList?.contains('ivu-poptip-popper')
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

    // iView Table 单元格内：按 thead/tbody 行列 + 相对路径，避免 td 上 ivu-table-column-* 与整页绝对路径失效
    if (el.closest('.ivu-table')) {
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
          let target = el;
          const link = el.closest('a');
          if (link && td.contains(link)) target = link;
          const rel = getRelativeXPathFromAncestor(td, target);
          return `//${sec}/tr[${rowIdx + 1}]/${cellTag}[${colIdx + 1}]${rel}`;
        }
      }
    }

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
window.__AT_SELECTOR_CORE__ = {
  ensureUniqueSelector,
  getUniqueSelector,
  getXPath,
  cleanClasses,
  isVolatileStateClass,
};
})();
