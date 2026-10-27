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
  const runtimeVariables = Object.create(null);

  function pushUnique(list, value) {
    if (value && !list.includes(value)) list.push(value);
  }

  function escapeCssIdentifier(value) {
    const raw = String(value || '');
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(raw);
    return raw.replace(/([\\"'#.:\[\],>+~*^$|=()])/g, '\\$1');
  }

  /**
   * 组件库常把原生 checkbox/radio 设为透明，由 label/span 呈现真实视觉状态。
   * player.js 由 chrome.scripting 作为普通脚本注入，辅助逻辑必须内联，不能使用 import。
   */
  function resolveSemanticVisibilityTarget(element, isVisible, documentRef = document) {
    if (!element || typeof isVisible !== 'function') return null;
    if (isVisible(element)) return element;

    const tag = String(element.tagName || '').toLowerCase();
    const type = String(element.type || '').toLowerCase();
    if (tag !== 'input' || !['checkbox', 'radio'].includes(type)) return null;

    const candidates = [];
    if (element.labels) Array.from(element.labels).forEach((label) => pushUnique(candidates, label));
    if (element.closest) {
      pushUnique(candidates, element.closest(
        'label, .ivu-checkbox-wrapper, .ivu-radio-wrapper, .ant-checkbox-wrapper, .ant-radio-wrapper, '
        + '.el-checkbox, .el-radio, [role="checkbox"], [role="radio"]',
      ));
      pushUnique(candidates, element.closest(
        '.ivu-checkbox, .ivu-radio, .ant-checkbox, .ant-radio, .el-checkbox__input, .el-radio__input',
      ));
    }
    const id = String(element.id || '').trim();
    if (id && documentRef?.querySelector) {
      try {
        pushUnique(candidates, documentRef.querySelector(`label[for="${escapeCssIdentifier(id)}"]`));
      } catch {
        // 非法历史 id 不应导致诊断探针自身失败。
      }
    }
    return candidates.find((candidate) => isVisible(candidate)) || null;
  }

  // 上传按钮常由业务页面的普通按钮触发，再由页面脚本调用 input[type=file].click()。
  // 回放时保留按钮本身的业务状态切换，但阻止文件控件打开系统选择器；随后 upload_file
  // 步骤会把中台绑定的测试文件直接写入该控件并触发 input/change。
  function preventPlaybackFilePicker(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || String(target.type || '').toLowerCase() !== 'file') return;
    event.preventDefault();
  }
  document.addEventListener('click', preventPlaybackFilePicker, true);

  function normalizeLocale(locale) {
    const raw = String(locale || '').trim().toLowerCase();
    return raw.startsWith('zh') ? 'zh' : 'en';
  }

  function tr(zh, en) {
    return currentLocale === 'en' ? (en || zh) : zh;
  }

  function replaceRuntimeVariables(value) {
    if (typeof value !== 'string' || !value.includes('{{')) return value;
    return value.replace(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g, (all, name) => (
      Object.prototype.hasOwnProperty.call(runtimeVariables, name) ? String(runtimeVariables[name]) : all
    ));
  }

  function replaceRuntimeVariablesDeep(value) {
    if (typeof value === 'string') return replaceRuntimeVariables(value);
    if (Array.isArray(value)) return value.map((item) => replaceRuntimeVariablesDeep(item));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = replaceRuntimeVariablesDeep(item);
    }
    return out;
  }

  function resolveStepRuntimeVariables(step) {
    if (!step || typeof step !== 'object') return step;
    return {
      ...step,
      value: replaceRuntimeVariables(step.value),
      value_text: replaceRuntimeVariables(step.value_text),
      url: replaceRuntimeVariables(step.url),
      target_selector: replaceRuntimeVariables(step.target_selector),
      target_xpath: replaceRuntimeVariables(step.target_xpath),
      locator_meta: replaceRuntimeVariablesDeep(step.locator_meta),
      nl_instruction: replaceRuntimeVariables(step.nl_instruction),
    };
  }

  function normalizeVariableName(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/[^\w$]+/g, '_').replace(/^_+|_+$/g, '');
    if (!normalized) return '';
    return /^[A-Za-z_$]/.test(normalized) ? normalized : `v_${normalized}`;
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
    if (tag === 'textarea' || tag === 'input' || tag === 'select') {
      return el.value != null ? String(el.value) : '';
    }
    const t = el.textContent;
    return t != null ? String(t) : '';
  }

  function getElementAssertionValue(el, rawReadMode, rawAttribute) {
    const readMode = String(rawReadMode || 'auto').trim().toLowerCase();
    const attribute = String(rawAttribute || '').trim();
    if (!['auto', 'text', 'attribute', 'value'].includes(readMode)) {
      return { ok: false, error: `不支持的元素断言读取方式：${readMode || '(空)'}` };
    }
    if (readMode === 'attribute' && !attribute) {
      return { ok: false, error: '元素属性断言缺少属性名' };
    }
    const tag = String(el?.tagName || '').toLowerCase();
    const effectiveMode = readMode === 'auto' && ['input', 'textarea', 'select'].includes(tag) ? 'value' : readMode;
    if (effectiveMode === 'value') return { ok: true, value: 'value' in el ? String(el.value ?? '') : '' };
    if (effectiveMode === 'attribute') {
      if (!el.hasAttribute(attribute)) return { ok: false, attributeMissing: true, attribute };
      return { ok: true, value: el.getAttribute(attribute) ?? '', attribute };
    }
    return { ok: true, value: getElementRawTextForAssert(el) };
  }

  function getElementValueForVariable(el) {
    if (!el) return '';
    const tag = el.tagName && String(el.tagName).toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select') {
      return el.value != null ? String(el.value) : '';
    }
    if (el.isContentEditable || el.closest?.('[contenteditable="true"]')) {
      const editable = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
      return editable?.textContent != null ? String(editable.textContent) : '';
    }
    const text = el.innerText != null ? el.innerText : el.textContent;
    return text != null ? String(text) : '';
  }

  function getVariableMeta(step) {
    const raw = step?.locator_meta;
    let meta = null;
    if (raw && typeof raw === 'object') {
      meta = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      try { meta = JSON.parse(raw); } catch { meta = null; }
    }
    const variable = meta?.context?.variable;
    return variable && typeof variable === 'object' ? variable : {};
  }

  function applyVariableExtraction(rawValue, step) {
    const raw = String(rawValue ?? '');
    const meta = getVariableMeta(step);
    const extract = meta.extract && typeof meta.extract === 'object' ? meta.extract : { mode: 'full' };
    const mode = String(extract.mode || 'full');
    if (mode === 'regex') {
      const pattern = String(extract.pattern || '');
      const name = normalizeVariableName(step.value || step.variable_name || step.name);
      if (!pattern) {
        throw variableExtractionError({ name, raw, pattern, group: extract.group, status: 'empty_pattern', message: tr('保存变量失败：正则表达式为空', 'Set variable failed: regex pattern is empty'), suggestion: tr('请填写正则表达式，或把抽取方式改为完整值。', 'Enter a regex pattern or switch extraction to full value.') });
      }
      try {
        validateRegexSafety(pattern);
      } catch (err) {
        throw variableExtractionError({ name, raw, pattern, group: extract.group, status: 'unsafe_regex', message: err?.message || tr('保存变量失败：正则不安全', 'Set variable failed: unsafe regex'), suggestion: tr('请增加固定上下文并避免嵌套重复，例如使用 ^订单已提交：(.+)$。', 'Add fixed context and avoid nested repetition.') });
      }
      let re;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        throw variableExtractionError({ name, raw, pattern, group: extract.group, status: 'invalid_regex', message: tr(`保存变量失败：正则表达式无效（${err?.message || err}）`, `Set variable failed: invalid regex (${err?.message || err})`), suggestion: tr('请检查括号、转义字符和量词写法。', 'Check parentheses, escapes, and quantifiers.') });
      }
      const match = raw.match(re);
      if (!match) {
        throw variableExtractionError({ name, raw, pattern, group: extract.group, status: 'not_matched', message: tr(`保存变量失败：原始值未匹配正则 ${pattern}，原始值：${raw}`, `Set variable failed: raw value did not match regex ${pattern}. Raw value: ${raw}`), suggestion: suggestVariableRegexFix(raw) });
      }
      const group = Number.isInteger(Number(extract.group)) ? Number(extract.group) : (match.length > 1 ? 1 : 0);
      if (match[group] == null) {
        throw variableExtractionError({ name, raw, pattern, group, status: 'group_missing', match, message: tr(`保存变量失败：正则捕获组 ${group} 不存在，原始值：${raw}`, `Set variable failed: regex group ${group} does not exist. Raw value: ${raw}`), suggestion: tr(`当前匹配只有 ${Math.max(0, match.length - 1)} 个捕获组，请把捕获组改为 ${match.length > 1 ? 1 : 0}。`, `Current match has ${Math.max(0, match.length - 1)} capture groups. Set group to ${match.length > 1 ? 1 : 0}.`) });
      }
      return { value: String(match[group]), raw, extract: { mode: 'regex', pattern, group } };
    }
    if (mode === 'after_delimiter') {
      const delimiter = String(extract.delimiter || '');
      if (!delimiter) {
        throw new Error(tr('保存变量失败：分隔符为空', 'Set variable failed: delimiter is empty'));
      }
      const index = raw.indexOf(delimiter);
      if (index < 0) {
        throw new Error(tr(`保存变量失败：原始值中未找到分隔符 ${delimiter}，原始值：${raw}`, `Set variable failed: delimiter ${delimiter} was not found. Raw value: ${raw}`));
      }
      let value = raw.slice(index + delimiter.length);
      if (extract.trim !== false) value = value.trim();
      return { value, raw, extract: { mode: 'after_delimiter', delimiter, trim: extract.trim !== false } };
    }
    return { value: raw, raw, extract: { mode: 'full' } };
  }

  function previewValue(value, max = 1000) {
    const s = String(value ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function variableExtractionError({ name = '', raw = '', pattern = '', group = '', status = '', match = null, message = '', suggestion = '' }) {
    const err = new Error(message || tr('保存变量失败：变量抽取失败', 'Set variable failed: variable extraction failed'));
    const groups = Array.isArray(match) ? match.slice(0, 8).map((item) => String(item ?? '')) : [];
    err.variableExtraction = {
      variable_name: name,
      raw_value: previewValue(raw),
      pattern,
      group: Number.isInteger(Number(group)) ? Number(group) : group,
      match_status: status,
      matched_text: Array.isArray(match) && match[0] != null ? previewValue(match[0], 500) : '',
      capture_groups: groups,
      suggestion,
    };
    return err;
  }

  function suggestVariableRegexFix(rawValue) {
    const raw = String(rawValue || '');
    if (raw.includes('：')) {
      const [prefix] = raw.split('：');
      return tr(`当前原始值包含“${prefix}：”，可尝试使用 ^${prefix}：(.+)$ 并选择捕获组 1。`, `Raw value contains "${prefix}:". Try a regex anchored to that prefix and use capture group 1.`);
    }
    if (raw.includes(':')) {
      const [prefix] = raw.split(':');
      return tr(`当前原始值包含“${prefix}:”，可尝试使用 ^${prefix}:(.+)$ 并选择捕获组 1。`, `Raw value contains "${prefix}:". Try a regex anchored to that prefix and use capture group 1.`);
    }
    return tr('请根据原始值调整正则，确保正则能匹配并把目标片段放在捕获组中。', 'Adjust the regex so it matches the raw value and places the target segment in a capture group.');
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
    if (source.length > 300) {
      throw new Error(tr('保存变量失败：正则表达式过长，请缩短后再回放', 'Set variable failed: regex pattern is too long'));
    }
    if (hasNestedRegexQuantifier(source)) {
      throw new Error(tr('保存变量失败：正则存在嵌套重复结构，可能导致回放卡顿', 'Set variable failed: regex contains nested repetition and may hang playback'));
    }
    if (/(?:\.\*){2,}|(?:\.\+){2,}|\[[^\]]*\\s\\S[^\]]*\][*+][*+]?/.test(source)) {
      throw new Error(tr('保存变量失败：正则过宽，可能误匹配大段文本', 'Set variable failed: regex is too broad'));
    }
  }

  function getRecordedPointerPoint(el, locatorMeta) {
    try {
      const ctx = parseLocatorMeta(locatorMeta)?.context || {};
      const pointer = ctx.pointer;
      if (!pointer || pointer.use_recorded_point !== true) return null;
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      const xRatio = Number(pointer.x_ratio);
      const yRatio = Number(pointer.y_ratio);
      if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return null;
      if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return null;
      const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
      return {
        x: Math.round(Math.min(Math.max(r.left + r.width * xRatio, 1), Math.max(1, vw - 1))),
        y: Math.round(Math.min(Math.max(r.top + r.height * yRatio, 1), Math.max(1, vh - 1))),
      };
    } catch (e) {
      return null;
    }
  }

  function compositeControlRoot(node) {
    if (!node?.closest) return null;
    try {
      return node.closest([
        '.el-select', '.ivu-select', '.ant-select', '.v-select', '.vs__dropdown-toggle',
        '.el-cascader', '.ivu-cascader', '.ant-cascader', '.ant-cascader-picker',
        '.el-autocomplete', '.t-select', '.arco-select', '.n-select', '.MuiSelect-root',
        '[role="combobox"]',
      ].join(','));
    } catch {
      return null;
    }
  }

  function sameCompositeControlSurface(target, hit) {
    const root = compositeControlRoot(target);
    if (!root || root !== compositeControlRoot(hit)) return false;
    try {
      const independent = hit.closest?.([
        'button', 'a[href]', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="option"]', '[role="menuitem"]',
        '.el-select-dropdown__item', '.el-option', '.ivu-select-item', '.ant-select-item-option',
        '.el-tag__close', '.el-input__clear', '.el-select__caret.el-icon-circle-close',
        '.ant-select-clear', '.ivu-select-clear',
      ].join(','));
      return !independent || independent === root || !root.contains(independent);
    } catch {
      return false;
    }
  }

  function dispatchMouseLike(el, actionType, locatorMeta = null) {
    const r = el.getBoundingClientRect();
    const recordedPoint = getRecordedPointerPoint(el, locatorMeta);
    let cx = recordedPoint ? recordedPoint.x : Math.round(r.left + r.width / 2);
    let cy = recordedPoint ? recordedPoint.y : Math.round(r.top + r.height / 2);
    // 旧步骤或布局改变时，录制点可能落到遮挡物上。DOM 降级路径改用目标内
    // 离中心最近的可点击点，避免固定比例坐标误点到其它元素。
    const hitsTarget = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit) || hit.contains?.(el)
        || hit.closest?.('label')?.control === el || sameCompositeControlSurface(el, hit));
    };
    if (!hitsTarget(cx, cy)) {
      const points = [[.5, .5], [.35, .5], [.65, .5], [.5, .35], [.5, .65], [.2, .2], [.8, .2], [.2, .8], [.8, .8]];
      for (const [xRatio, yRatio] of points) {
        const x = Math.round(r.left + r.width * xRatio);
        const y = Math.round(r.top + r.height * yRatio);
        if (hitsTarget(x, y)) { cx = x; cy = y; break; }
      }
    }
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
    if (getNativeToggleControl(el)) {
      el.click();
      return;
    }
    el.click();
    el.dispatchEvent(new MouseEvent('click', common));
  }

  function preferTopmostSemanticClickTarget(el) {
    if (!el) return el;
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return el;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || hit === el || el.contains(hit)) return el;
      const ownerSel = 'a[href],button,label,[role="button"],[role="link"],[role="menuitem"],.xcomponent-btn,.next-btn,.ant-btn,.ivu-btn,.el-button';
      const hitOwner = hit.closest?.(ownerSel);
      const targetOwner = el.closest?.(ownerSel) || el;
      if (!hitOwner || !targetOwner) return el;
      const tagA = String(hitOwner.tagName || '').toLowerCase();
      const tagB = String(targetOwner.tagName || '').toLowerCase();
      if (tagA !== tagB) return el;
      if (tagA === 'a') {
        const ah = hitOwner.getAttribute?.('href');
        const bh = targetOwner.getAttribute?.('href');
        if (ah && bh && ah === bh) return hitOwner;
      }
      const text = (node) => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text(hitOwner) && text(hitOwner) === text(targetOwner)) return hitOwner;
      const labelA = hitOwner.getAttribute?.('aria-label') || hitOwner.getAttribute?.('title');
      const labelB = targetOwner.getAttribute?.('aria-label') || targetOwner.getAttribute?.('title');
      if (labelA && labelA === labelB) return hitOwner;
    } catch (e) { /* ignore */ }
    return el;
  }

  /**
   * 聚焦目标控件。文本类不用合成鼠标事件：mousedown/click 在捕获阶段会先经过表格 tr 等祖先，
   * 仅靠目标上的 stopPropagation 挡不住捕获监听，易误触行选、取消其它行勾选。
   */
  function activateFieldWithoutBubble(el) {
    if (isTextLikeField(el) || el?.isContentEditable) {
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

  function probeVisibleTarget(step) {
    const target = findElement(step.target_selector, step.target_xpath, step.locator_meta);
    const visibleTarget = resolveSemanticVisibilityTarget(target, isDomVisible, document);
    return { target, visibleTarget };
  }

  function describeProbeTarget(target) {
    return String(target?.getAttribute?.('aria-label') || target?.textContent || target?.tagName || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function probeOverlaySelection(step) {
    const expected = [step?.value_text, step?.value]
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!expected.length) return { observed: null, evidence: 'selection_value_unavailable' };
    const selectors = [
      'option:checked',
      '[role="option"][aria-selected="true"]',
      '.ivu-select-item-selected',
      '.el-select-dropdown__item.selected',
      '.ant-select-item-option-selected',
      '.arco-select-option-selected',
      '.n-base-select-option--selected',
      '.ivu-select-selected-value',
      '.ant-select-selection-item',
      '.el-select .el-input__inner',
      '.arco-select-view-value',
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    for (const node of nodes) {
      if (!isDomVisible(node)) continue;
      const actual = String(node.value || node.textContent || node.getAttribute?.('title') || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (expected.includes(actual)) {
        return { observed: true, actual: actual.slice(0, 180), evidence: 'selected_value_visible' };
      }
    }
    // Absence is inconclusive: many custom controls close and remove their
    // selected option without exposing a stable selected-value node.
    return { observed: null, evidence: 'selection_state_unavailable' };
  }

  // 断言“可见”采用布局可见语义：不把遮挡或是否处于视口内混入其中。
  // 这与点击步骤的可交互命中测试保持职责分离。
  function isElementLayoutVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    let cur = el;
    while (cur) {
      const style = window.getComputedStyle(cur);
      if (
        style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || parseFloat(style.opacity) <= 0.01
      ) return false;
      cur = cur.parentElement;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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
  function normalizeXPath(xpath) {
    let normalized = String(xpath || '').trim();
    if (/^xpath\s*=/i.test(normalized)) normalized = normalized.replace(/^xpath\s*=\s*/i, '').trim();
    if (!normalized || isVolatileRcXPath(normalized)) return '';
    return /^(?:html|body)\//i.test(normalized) ? `/${normalized}` : normalized;
  }

  function locatorError(code, message, details = {}) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    error.locatorError = { code, message, ...details };
    return error;
  }

  function unsupportedLocatorStrategy(value) {
    const raw = String(value || '').trim();
    const prefixed = /^(jquery|js(?:_path)?|jspath|testrigor)\s*=/i.exec(raw);
    if (prefixed) return prefixed[1].toLowerCase();
    if (/^\$\s*\(/.test(raw)) return 'jquery';
    if (/^(?:document|window)\s*\.\s*(?:querySelector|querySelectorAll)\s*\(/i.test(raw)) return 'js';
    return '';
  }

  function validateXPath(xpathRaw, source = 'target_xpath') {
    const normalized = normalizeXPath(xpathRaw);
    if (!normalized) return normalized;
    try {
      const result = document.evaluate(normalized, document, null, XPathResult.ANY_TYPE, null);
      const nodeResultTypes = [
        XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
        XPathResult.ORDERED_NODE_ITERATOR_TYPE,
        XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        XPathResult.ANY_UNORDERED_NODE_TYPE,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
      ];
      if (!nodeResultTypes.includes(result.resultType)) {
        throw locatorError('LOCATOR_XPATH_UNSUPPORTED', 'XPath result is not a node set', {
          source,
          raw_xpath: String(xpathRaw || '').trim(),
          normalized_xpath: normalized,
        });
      }
      return normalized;
    } catch (error) {
      if (error?.code) throw error;
      throw locatorError('LOCATOR_XPATH_INVALID', String(error?.message || error || 'XPath evaluation failed'), {
        source,
        raw_xpath: String(xpathRaw || '').trim(),
        normalized_xpath: normalized,
      });
    }
  }

  function findBestXPathMatch(xpRaw) {
    const x = normalizeXPath(xpRaw);
    if (!x) return null;
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
    } catch (error) {
      throw locatorError('LOCATOR_XPATH_INVALID', String(error?.message || error || 'XPath evaluation failed'), {
        source: 'xpath',
        raw_xpath: String(xpRaw || '').trim(),
        normalized_xpath: x,
      });
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

  /** DOM 降级回放与 CDP 使用同一集合项语义：未唯一命中时安全失败。 */
  function findCollectionItemByOrdinal(cfg, semanticPeers = null) {
    const visible = (node) => {
      const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
      return (rect.width > 0 || rect.height > 0) && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isNativeToggle = (node) => {
      if (!node || String(node.tagName || '').toLowerCase() !== 'input') return false;
      const type = String(node.type || '').toLowerCase();
      return type === 'radio' || type === 'checkbox';
    };
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const action = cfg.action || {}, scope = String(action.scope || '');
    // 保留集合行内的隐藏原生状态控件，交给 _buildFindCode 映射到
    // 可见 label/组件代理，同时继续以原始 input 做点击后状态校验。
    const matchesAction = (node) => node && (visible(node) || isNativeToggle(node))
      && (!action.tag || String(node.tagName || '').toLowerCase() === String(action.tag).toLowerCase())
      && (!action.text || norm(node.innerText || node.textContent) === norm(action.text));
    const targetIn = (item) => {
      if (!item) return null;
      let target = null;
      if (action.css) {
        try {
          if (scope !== 'descendant' && item.matches(action.css)) target = item;
          if (!target && scope !== 'self') target = item.querySelector(action.css);
        } catch { /* Invalid recorded selector: try the recorded action text in this row only. */ }
      }
      if (target && matchesAction(target)) return target;
      if (!action.text) return null;
      if (scope !== 'descendant' && matchesAction(item)) return item;
      const matches = scope === 'self' ? [] : [...item.querySelectorAll('a,button,[role="button"],[role="link"],span,div')].filter(matchesAction);
      return matches.length === 1 ? matches[0] : null;
    };
    if (cfg?.collection?.kind && cfg.collection.kind !== 'table') {
      const rootCfg = cfg.collection.root || {};
      let roots = [...document.querySelectorAll(rootCfg.selector || '[role="list"],ul,ol,div')];
      const rootIndex = Number(rootCfg.index);
      if (Number.isInteger(rootIndex) && rootIndex >= 0) roots = roots[rootIndex] ? [roots[rootIndex]] : [];
      const items = roots.flatMap((root) => [...root.querySelectorAll(`:scope > ${(cfg.collection.item || {}).selector || '[role="listitem"],li'}`)]).filter(visible);
      const index = Number(cfg.recorded_item_index);
      return targetIn(Number.isInteger(index) && index >= 0 ? items[index] : null);
    }
    const framework = String(cfg.collection?.root?.framework || cfg.framework || '');
    const selector = framework === 'el' ? '.el-table' : (framework === 'ant' ? '.ant-table' : (framework === 'ivu' ? '.ivu-table' : 'table,[role="grid"]'));
    const roots = [...document.querySelectorAll(selector)];
    const rootIndex = Number(cfg.collection?.root?.wrapper_index ?? cfg.wrapper_index);
    // An absent recorded wrapper must not redirect an action into another table.
    const root = Number.isInteger(rootIndex) && rootIndex >= 0 ? roots[rootIndex] : roots.length === 1 ? roots[0] : null;
    if (!root) return null;
    const fixedSelector = '.ivu-table-fixed,.ivu-table-fixed-right,.el-table__fixed,.el-table__fixed-right,.ant-table-fixed-left,.ant-table-fixed-right';
    const rows = [...root.querySelectorAll('tbody > tr,[role="rowgroup"] > [role="row"]')]
      .filter((row) => visible(row) && (!row.closest || row.closest(selector) === root));
    const fixedOwner = (row) => row.closest ? row.closest(fixedSelector) : null;
    const mainRows = rows.filter((row) => !fixedOwner(row));
    const index = Number(cfg.recorded_row_index);
    const row = Number.isInteger(index) && index >= 0 ? mainRows[index] : null;
    if (!row) return null;
    if (semanticPeers && semanticPeers[0] !== row) return null;
    const peers = semanticPeers && semanticPeers[0] === row ? semanticPeers : [row];
    const owners = [...new Set(rows.map(fixedOwner).filter(Boolean))];
    for (const owner of semanticPeers ? [] : owners) {
      const copies = rows.filter((candidate) => fixedOwner(candidate) === owner);
      // A fixed pane must represent the same row sequence, not another nested table.
      if (copies.length !== mainRows.length) continue;
      const copy = copies[index];
      const attrs = ['data-row-key', 'data-key', 'data-id', 'data-row-id', 'data-record-id'];
      if (attrs.some((attr) => row.getAttribute(attr) && copy.getAttribute(attr) && row.getAttribute(attr) !== copy.getAttribute(attr))) continue;
      const a = row.getBoundingClientRect(), b = copy.getBoundingClientRect();
      if (Math.abs(a.top - b.top) > 3 || Math.abs(a.bottom - b.bottom) > 3) continue;
      peers.push(copy);
    }
    const targets = peers.map(targetIn).filter(Boolean);
    if (!owners.length) return targets[0] || null;
    // Fixed copies are separate DOM nodes. Select only a node which receives its own hit-test.
    // Never deliver a synthetic DOM click through a real modal or to a same-label adjacent row.
    return targets.find((target) => {
      let hitTarget = target;
      if (!visible(hitTarget) && isNativeToggle(target)) {
        const labels = target.labels ? Array.from(target.labels) : [];
        hitTarget = labels.find((label) => label?.control === target && visible(label)) || null;
      }
      if (!hitTarget) return false;
      let r = hitTarget.getBoundingClientRect();
      const viewport = document.documentElement;
      if (viewport && (r.left + r.width / 2 < 0 || r.top + r.height / 2 < 0
        || r.left + r.width / 2 >= viewport.clientWidth || r.top + r.height / 2 >= viewport.clientHeight)) {
        hitTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        r = hitTarget.getBoundingClientRect();
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === hitTarget || (hit && hitTarget.contains(hit));
    }) || null;
  }

  function findCollectionItem(rawValue) {
    let cfg = rawValue;
    try { if (typeof cfg === 'string') cfg = JSON.parse(cfg); } catch { return null; }
    if (!cfg) return null;
    if (cfg._collection_locator_mode === 'ordinal') return findCollectionItemByOrdinal(cfg);
    if (Array.isArray(cfg?.identity?.selected) && cfg.identity.selected.length) cfg.fields = cfg.identity.selected;
    if (cfg?.collection?.root) {
      cfg.framework = cfg.collection.root.framework || cfg.framework;
      cfg.wrapper_index = cfg.collection.root.wrapper_index ?? cfg.wrapper_index;
    }
    if (cfg?.collection?.kind && !['table', 'list', 'card', 'menu'].includes(cfg.collection.kind)) return null;
    if (!Array.isArray(cfg.fields) || !cfg.fields.length) return null;
    try {
      if (cfg.collection?.kind && cfg.collection.kind !== 'table') {
        const rootCfg = cfg.collection.root || {};
        const allRoots = [...document.querySelectorAll(rootCfg.selector || '[role="list"],ul,ol,div')];
        const rootIndex = Number(rootCfg.index);
        const preferredRoot = Number.isInteger(rootIndex) && rootIndex >= 0 ? allRoots[rootIndex] : null;
        const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return (rect.width > 0 || rect.height > 0) && style.display !== 'none' && style.visibility !== 'hidden'; };
        const itemSelector = (cfg.collection.item || {}).selector || '[role="listitem"],li';
        const semanticTexts = (item) => [...new Set([
          norm(item.getAttribute?.('aria-label')),
          norm(item.innerText || item.textContent),
          ...[...item.querySelectorAll('h1,h2,h3,h4,h5,h6,[title],strong,b,.title,[class*="title"],[class*="name"]')]
            .map((node) => norm(node.innerText || node.textContent || node.getAttribute?.('title'))),
        ].filter(Boolean))];
        const itemMatches = (item) => {
          const values = semanticTexts(item);
          return visible(item) && cfg.fields.every((field) => field.kind === 'item_text' && values.indexOf(norm(field.value)) >= 0);
        };
        let matches = preferredRoot ? [...preferredRoot.querySelectorAll(`:scope > ${itemSelector}`)].filter(itemMatches) : [];
        if (!preferredRoot || matches.length === 0) {
          const fallbackRoots = allRoots.filter((root) => root !== preferredRoot);
          matches = [...document.querySelectorAll(itemSelector)].filter((item) => fallbackRoots.includes(item.parentElement) && itemMatches(item));
        }
        if (matches.length !== 1) return null;
        const action = cfg.action || {}; const scope = String(action.scope || ''); let target = null;
        if (action.css) { try { if (scope !== 'descendant' && matches[0].matches(action.css)) target = matches[0]; if (!target && scope !== 'self') target = matches[0].querySelector(action.css); } catch { /* ignore */ } }
        if (!target && action.text) { if (scope !== 'descendant' && (!action.tag || matches[0].tagName.toLowerCase() === String(action.tag).toLowerCase()) && norm(matches[0].innerText || matches[0].textContent) === norm(action.text)) target = matches[0]; if (!target && scope !== 'self') target = [...matches[0].querySelectorAll('a,button,[role="button"],[role="link"],span,div')].find((node) => (!action.tag || node.tagName.toLowerCase() === String(action.tag).toLowerCase()) && norm(node.innerText || node.textContent) === norm(action.text)) || null; }
        return target;
      }
      const framework = String(cfg.framework || '');
      const selector = framework === 'el'
        ? '.el-table'
        : (framework === 'ant' ? '.ant-table' : (framework === 'ivu' ? '.ivu-table' : 'table,[role="grid"]'));
      const all = [...document.querySelectorAll(selector)];
      const index = Number(cfg.wrapper_index);
      const roots = Number.isInteger(index) && index >= 0 && all[index] ? [all[index]] : all;
      const fixedSelector = '.ivu-table-fixed,.ivu-table-fixed-right,.el-table__fixed,.el-table__fixed-right,.ant-table-fixed-left,.ant-table-fixed-right';
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (rect.width > 0 || rect.height > 0) && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const cells = (row) => [...row.querySelectorAll(
        ':scope > td,:scope > th,:scope > .ant-table-cell,:scope > .el-table__cell,:scope > .ivu-table-cell,:scope > [role="gridcell"]',
      )];
      const groups = [];
      const mappedRows = new Set();
      const domMatches = [];
      const keyAttrs = ['data-row-key', 'data-key', 'data-id', 'data-row-id', 'data-record-id'];
      const fixedOwner = (row) => row.closest?.(fixedSelector) || null;
      const matchesIdentity = (row) => {
        const rowCells = cells(row);
        return cfg.fields.every((field) => {
          if (field.kind === 'row_attr') return norm(row.getAttribute(field.attr)) === norm(field.value);
          const colIndex = Number(field.col_index);
          return Number.isInteger(colIndex)
            && norm(rowCells[colIndex]?.innerText || rowCells[colIndex]?.textContent) === norm(field.value);
        });
      };
      for (const root of roots) {
        const rows = [...root.querySelectorAll('tbody > tr,.el-table__body-wrapper tbody > tr,.ant-table-tbody > tr,.ivu-table-tbody > tr,[role="rowgroup"] > [role="row"]')]
          .filter((row) => visible(row) && row.closest?.(selector) === root);
        const mainRows = rows.filter((row) => !fixedOwner(row));
        const rootGroups = mainRows.map((row, rowIndex) => ({ row, root, rowIndex, peers: [row] }));
        mainRows.forEach((row) => mappedRows.add(row));
        const owners = [...new Set(rows.map(fixedOwner).filter(Boolean))];
        for (const owner of owners) {
          const copies = rows.filter((row) => fixedOwner(row) === owner);
          for (const [copyIndex, copy] of copies.entries()) {
            const keyed = rootGroups.filter(({ row }) => keyAttrs.some((attr) => row.getAttribute(attr)
              && copy.getAttribute(attr) && row.getAttribute(attr) === copy.getAttribute(attr)));
            const candidate = keyed.length === 1 ? keyed[0]
              : keyed.length ? null : copies.length === mainRows.length ? rootGroups[copyIndex] : null;
            if (!candidate) continue;
            const row = candidate.row;
            if (keyAttrs.some((attr) => row.getAttribute(attr) && copy.getAttribute(attr)
              && row.getAttribute(attr) !== copy.getAttribute(attr))) continue;
            const a = row.getBoundingClientRect(); const b = copy.getBoundingClientRect();
            if (Math.abs(a.top - b.top) > 3 || Math.abs(a.bottom - b.bottom) > 3) continue;
            candidate.peers.push(copy);
            mappedRows.add(copy);
          }
        }
        groups.push(...rootGroups);
        domMatches.push(...rows.filter(matchesIdentity));
      }
      const matches = groups.filter(({ peers }) => peers.some(matchesIdentity));
      if (matches.length !== 1 || domMatches.some((row) => !mappedRows.has(row))) return null;
      // Use the matched business row's current index, never the recorded position.
      const match = matches[0];
      return findCollectionItemByOrdinal({
        ...cfg,
        wrapper_index: all.indexOf(match.root),
        collection: { ...cfg.collection, root: { ...cfg.collection?.root, wrapper_index: all.indexOf(match.root) } },
        recorded_row_index: match.rowIndex,
      }, match.peers);
    } catch {
      return null;
    }
  }

  function resolveAssertionConfig(step, hasLocator = false) {
    const meta = parseLocatorMeta(step?.locator_meta);
    const contextAssertion = meta?.context?.assertion && typeof meta.context.assertion === 'object' ? meta.context.assertion : {};
    const raw = meta?.assertion && typeof meta.assertion === 'object' ? meta.assertion : contextAssertion;
    const canonical = String(step?.action_type || '').trim().toLowerCase() === 'assert_element_match';
    const configuredTarget = canonical ? 'element' : raw.target;
    const configuredMatch = canonical ? step?.match_mode : raw.match;
    const target = ['page', 'element', 'error', 'url'].includes(String(configuredTarget || '')) ? String(configuredTarget) : (hasLocator ? 'element' : 'page');
    const rawMatch = ['contains', 'equals', 'not_contains', 'regex', 'visible'].includes(String(configuredMatch || '')) ? String(configuredMatch) : (hasLocator ? 'equals' : 'contains');
    const match = rawMatch === 'visible' && target !== 'element' ? 'contains' : rawMatch;
    const source = String(step?.read_mode || contextAssertion.source || 'auto').trim().toLowerCase();
    const readMode = source === 'contenteditable' ? 'text' : (['auto', 'text', 'attribute', 'value'].includes(source) ? source : 'auto');
    const attribute = String(step?.attribute || contextAssertion.attribute || '').trim();
    const waitMode = String(raw.wait_mode || '').trim().toLowerCase() === 'immediate'
      ? 'immediate'
      : 'eventually';
    return attribute ? { target, match, readMode, attribute, waitMode } : { target, match, readMode, waitMode };
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

  function matchRawAssertionValue(actual, expected, mode = 'contains') {
    const a = String(actual ?? '');
    const e = String(expected ?? '');
    if (mode === 'equals') return a === e;
    if (mode === 'not_contains') return !a.includes(e);
    if (mode === 'regex') {
      try { return new RegExp(e).test(a); } catch { return false; }
    }
    return a.includes(e);
  }

  function assertionMatchLabel(mode = 'contains') {
    if (mode === 'equals') return tr('等于', 'equals');
    if (mode === 'not_contains') return tr('不包含', 'does not contain');
    if (mode === 'regex') return tr('匹配正则', 'matches regex');
    if (mode === 'visible') return tr('可见', 'is visible');
    return tr('包含', 'contains');
  }

  function assertionTargetLabel(target = 'page') {
    if (target === 'element') return tr('指定元素', 'element');
    if (target === 'error') return tr('失败提示（错误/警告）', 'failure message (error/warning)');
    if (target === 'url') return 'URL';
    return tr('整页文本', 'page text');
  }

  function previewAssertionValue(value, max = 500) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return tr('（空）', '(empty)');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function formatAssertionFailure({ target, match, expected, actual, css, xpath }) {
    return [
      tr('断言失败：实际值不满足预期', 'Assertion failed: actual value does not match expectation'),
      `${tr('断言目标', 'Target')}: ${assertionTargetLabel(target)}`,
      `${tr('匹配方式', 'Match')}: ${assertionMatchLabel(match)}`,
      `${tr('期望值', 'Expected')}: ${previewAssertionValue(expected)}`,
      `${tr('实际值', 'Actual')}: ${previewAssertionValue(actual)}`,
      `CSS: ${css || '—'}`,
      `XPath: ${xpath || '—'}`,
    ].join('\n  ');
  }

  // 仅供用户显式配置的“失败提示”断言使用。warning 不参与全局页面错误中止判断。
  const FAILURE_PROMPT_SELECTOR = [
    '.ivu-message-error', '.ivu-message-warning', '.ivu-notice-error', '.ivu-notice-warning', '.ivu-alert-error', '.ivu-alert-warning',
    '.el-message--error', '.el-message--warning', '.el-notification--error', '.el-notification--warning', '.el-alert--error', '.el-alert--warning',
    '.ant-message-error', '.ant-message-warning', '.ant-notification-notice-error', '.ant-notification-notice-warning', '.ant-alert-error', '.ant-alert-warning',
    '.arco-message-error', '.arco-message-warning', '.arco-notification-notice-error', '.arco-notification-notice-warning', '.arco-alert-error', '.arco-alert-warning',
    '.t-message--error', '.t-message--warning', '.t-alert--error', '.t-alert--warning',
    '.alert-danger', '.alert-error', '.alert-warning',
  ].join(',');

  function collectFailurePromptText() {
    try {
      const seen = new Set();
      const texts = [];
      for (const el of document.querySelectorAll(FAILURE_PROMPT_SELECTOR)) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.05) continue;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 800);
        if (text && !seen.has(text)) {
          seen.add(text);
          texts.push(text);
        }
      }
      return texts.join('\n');
    } catch {
      return '';
    }
  }

  async function waitForElementAssertion(step, assertion, expected) {
    const timeout = 10000;
    const interval = 250;
    const eventually = assertion.waitMode !== 'immediate';
    const observeAbsence = eventually && assertion.match === 'not_contains';
    const deadline = Date.now() + timeout;
    let found = false;
    let lastActual = '';
    let lastElement = null;
    let attempts = 0;
    while (true) {
      attempts += 1;
      const el = findElement(step.target_selector, step.target_xpath, step.locator_meta);
      if (el) {
        found = true;
        lastElement = el;
        lastActual = getElementRawTextForAssert(el);
        const hit = assertion.match === 'visible'
          ? isElementLayoutVisible(el)
          : matchAssertionText(lastActual, expected, assertion.match);
        if (!observeAbsence && hit) return { hit: true, found, actual: lastActual, attempts, element: lastElement };
        if (observeAbsence && !hit) return { hit: false, found, actual: lastActual, attempts, element: lastElement };
      }
      if (!eventually || Date.now() >= deadline) {
        return { hit: observeAbsence, found, actual: lastActual, attempts, element: lastElement };
      }
      await sleep(interval);
    }
  }

  async function waitForTextAssertion(assertion, expected, readActual) {
    const eventually = assertion.waitMode !== 'immediate';
    const observeAbsence = eventually && assertion.match === 'not_contains';
    const deadline = Date.now() + 10000;
    let actual = '';
    while (true) {
      actual = String(readActual() ?? '');
      const hit = matchAssertionText(actual, expected, assertion.match);
      if (!observeAbsence && hit) return { hit: true, actual };
      if (observeAbsence && !hit) return { hit: false, actual };
      if (!eventually || Date.now() >= deadline) return { hit: observeAbsence, actual };
      await sleep(250);
    }
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
      // HTMLElement.click() 本身就会派发 click。再补发 MouseEvent 会让 toggle
      // 类菜单在一次 reveal 中开、关各一次，最终回到关闭状态。
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

  function revealTriggerReportsExpanded(trigger) {
    if (!trigger || String(trigger.action || 'hover').toLowerCase() !== 'click') return false;
    const el = findElement(
      trigger.target_selector || '',
      trigger.target_xpath || '',
      trigger.locator_meta ?? null,
    );
    if (!el) return false;
    const hosts = [el];
    const clickable = el.closest?.('button,[role="button"],[aria-haspopup],[aria-expanded],summary,a[href]');
    if (clickable && !hosts.includes(clickable)) hosts.push(clickable);
    for (let cur = el.parentElement, depth = 0; cur && depth < 3; cur = cur.parentElement, depth += 1) {
      if (!hosts.includes(cur)) hosts.push(cur);
    }
    return hosts.some((host) => {
      if (String(host.getAttribute?.('aria-expanded') || '').toLowerCase() === 'true') return true;
      if (String(host.getAttribute?.('data-state') || '').toLowerCase() === 'open') return true;
      if (String(host.getAttribute?.('data-open') || '').toLowerCase() === 'true') return true;
      if (host.hasAttribute?.('open')) return true;
      const className = typeof host.className === 'string' ? host.className : String(host.getAttribute?.('class') || '');
      if (/(^|[\s_-])(open|opened|expanded)(?=$|[\s_-])/i.test(className)) return true;
      const controlled = String(host.getAttribute?.('aria-controls') || host.getAttribute?.('aria-owns') || '').trim();
      return controlled.split(/\s+/).filter(Boolean).some((id) => isElementLayoutVisible(document.getElementById(id)));
    });
  }

  function isRevealAlreadySatisfied(step, trigger, looksLikeOverlay) {
    if (looksLikeOverlay && String(step?.value || '').trim()) {
      const option = findOverlayOptionByText(step.value);
      if (option && isElementLayoutVisible(option)) return true;
    }
    return revealTriggerReportsExpanded(trigger);
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
    let nodes = Array.from(document.querySelectorAll(
      '.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"], .ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]',
    ));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll(
      '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, ' +
      '[class*="-ant-tree-node-content-wrapper"], .ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"], [role="treeitem"]',
    ));
    const items = collectVisibleTreeItems(
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.('.ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"], .ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]') || node),
      (node) => node.querySelector?.('.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"], .ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"]') || node,
    );
    const node = pickBestTreeItem(items, cfg);
    if (!node) return null;
    let hosts = Array.from(node.querySelectorAll(
      '.tree-node-actions .data-source-icon, .tree-node-actions [class*="data-source-icon"], ' +
      '.tree-node-actions .action-icon-wrapper, .tree-node-actions [class*="action-icon"], ' +
      '[aria-haspopup="menu"], button, [role="button"], .teamNode > i',
    ));
    hosts = hosts.filter((host) => !host.closest?.([
      '.ant-tree-switcher', '.ec-ant-tree-switcher', '[class*="-ant-tree-switcher"]',
      '.ant-select-tree-switcher', '.ec-ant-select-tree-switcher', '[class*="-ant-select-tree-switcher"]',
      '.ant-tree-checkbox', '.ec-ant-tree-checkbox', '[class*="-ant-tree-checkbox"]',
      '.ant-select-tree-checkbox', '.ec-ant-select-tree-checkbox', '[class*="-ant-select-tree-checkbox"]',
    ].join(',')));
    return hosts[actionIndex] || hosts[0] || null;
  }

  function findAntTreeNodeByConfig(cfg) {
    const variant = String(cfg.variant || '').toLowerCase();
    let isSelectTree = variant === 'select';
    let nodeSelector = isSelectTree
      ? '.ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]'
      : '.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"]';
    let contentSelector = isSelectTree
      ? '.ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"]'
      : '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"]';
    let titleSelector = isSelectTree
      ? '.ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]'
      : '.ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"]';
    let nodes = Array.from(document.querySelectorAll(nodeSelector));
    // v1 TreeSelect 的展开/正文步骤曾遗漏 variant；页面未出现普通 Ant Tree
    // 时可安全推断为 TreeSelect，避免退回脆弱的 CSS/XPath。
    if (!nodes.length && variant !== 'tree') {
      const selectNodes = Array.from(document.querySelectorAll(
        '.ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]',
      ));
      if (selectNodes.length) {
        isSelectTree = true;
        nodeSelector = '.ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]';
        contentSelector = '.ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"]';
        titleSelector = '.ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]';
        nodes = selectNodes;
      }
    }
    if (!nodes.length) nodes = Array.from(document.querySelectorAll(`${contentSelector}, [role="treeitem"]`));
    const items = collectVisibleTreeItems(
      nodes,
      (node) => getTreeNodeVisibleTitle(node.querySelector?.(titleSelector) || node),
      (node) => node.querySelector?.(contentSelector) || node,
    );
    const node = pickBestTreeItem(items, cfg);
    return node ? { node, isSelectTree } : null;
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

  function findComponentTreeNodeByConfig(cfg, framework) {
    const isElement = framework === 'element-tree';
    const nodeSelector = isElement ? '.el-tree-node' : '.ivu-tree-title';
    const titleSelector = isElement ? '.el-tree-node__label' : '';
    const anchorSelector = isElement ? '.el-tree-node__content' : '';
    const nodes = Array.from(document.querySelectorAll(nodeSelector));
    const items = collectVisibleTreeItems(
      nodes,
      (node) => getTreeNodeVisibleTitle(titleSelector ? (node.querySelector?.(titleSelector) || node) : node),
      (node) => anchorSelector ? (node.querySelector?.(anchorSelector) || node) : node,
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
      const found = findAntTreeNodeByConfig(cfg);
      if (!found) return null;
      const { node, isSelectTree } = found;
      if (kind === 'expand_toggle') {
        return node.querySelector?.(isSelectTree
          ? '.ant-select-tree-switcher, .ec-ant-select-tree-switcher, [class*="-ant-select-tree-switcher"]'
          : '.ant-tree-switcher, .ec-ant-tree-switcher, [class*="-ant-tree-switcher"]') || null;
      }
      if (kind === 'node_content') {
        return node.querySelector?.(isSelectTree
          ? '.ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"], .ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]'
          : '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"], .ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"]') || node;
      }
      if (kind === 'checkbox') {
        return node.querySelector?.(isSelectTree
          ? '.ant-select-tree-checkbox, .ec-ant-select-tree-checkbox, [class*="-ant-select-tree-checkbox"]'
          : '.ant-tree-checkbox, .ec-ant-tree-checkbox, [class*="-ant-tree-checkbox"]') || null;
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
    if (framework === 'element-tree' || framework === 'iview-tree') {
      const node = findComponentTreeNodeByConfig(cfg, framework);
      if (!node) return null;
      if (framework === 'element-tree') {
        if (kind === 'expand_toggle') return node.querySelector?.('.el-tree-node__expand-icon') || null;
        if (kind === 'checkbox') return node.querySelector?.('.el-checkbox') || null;
        if (kind === 'node_content') return node.querySelector?.('.el-tree-node__content, .el-tree-node__label') || node;
      }
      if (framework === 'iview-tree') {
        const item = node.closest?.('li') || node.parentElement || node;
        if (kind === 'expand_toggle') return item.querySelector?.('.ivu-tree-arrow') || null;
        // 点击 View UI 的组件根节点而不是内部 input，避免将组件受控状态误按
        // input.checked 校验；部分版本中该属性不会随视觉状态同步。
        if (kind === 'checkbox') return item.querySelector?.('.ivu-checkbox') || null;
        if (kind === 'node_content') return node;
      }
    }
    return null;
  }

  function getTreeScrollContainers(cfg) {
    const framework = String(cfg?.framework || '').toLowerCase();
    const selector = framework === 'ant-tree'
      ? '.ant-select-tree-list-holder, .ec-ant-select-tree-list-holder, [class*="-ant-select-tree-list-holder"], .ant-tree-list-holder, .ec-ant-tree-list-holder, [class*="-ant-tree-list-holder"], .rc-virtual-list-holder, .ant-select-tree, .ec-ant-select-tree, [class$="-ant-select-tree"], .ant-tree, .ec-ant-tree, [class$="-ant-tree"]'
      : framework === 'element-tree'
        ? '.el-tree .el-scrollbar__wrap, .el-tree'
        : framework === 'iview-tree'
          ? '.ivu-tree, .ivu-select-dropdown'
          : '.vtree-tree, [role="tree"]';
    const result = [];
    const add = (node) => {
      if (!node || result.includes(node)) return;
      const rect = node.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (node.scrollHeight - node.clientHeight > 2) result.push(node);
    };
    document.querySelectorAll(selector).forEach((seed) => {
      add(seed);
      let parent = seed.parentElement;
      for (let i = 0; parent && i < 4; i += 1, parent = parent.parentElement) add(parent);
      seed.querySelectorAll?.('*').forEach(add);
    });
    return result.slice(0, 6);
  }

  // 与 CDP 主路径保持一致：树节点不在当前虚拟列表渲染窗口时，滚动树容器
  // 并重新通过 title + parentPath + level 匹配。不会滚动页面，也不会改变树的
  // 展开状态；展开仍应由录制到的 expand_toggle 步骤完成。
  async function findTreeInteractionWithScroll(metaRaw, timeout = 6000) {
    const cfg = getTreeInteractionConfig(metaRaw);
    if (!cfg) return null;
    const rawCfg = JSON.stringify(cfg);
    let target = findTreeInteraction(rawCfg);
    if (target) return target;

    const deadline = Date.now() + timeout;
    let attempts = 0;
    while (Date.now() < deadline && attempts < 14) {
      const containers = getTreeScrollContainers(cfg);
      let moved = false;
      containers.forEach((container) => {
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (maxTop <= 2) return;
        const before = container.scrollTop;
        const step = Math.max(48, Math.floor(container.clientHeight * 0.72));
        let next = before + step;
        if (next >= maxTop - 1 && before > 0) next = 0;
        else next = Math.min(maxTop, next);
        container.scrollTop = next;
        try { container.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { /* ignore */ }
        if (container.scrollTop !== before) moved = true;
      });
      if (!moved) break;
      await sleep(140);
      target = findTreeInteraction(rawCfg);
      if (target) return target;
      attempts += 1;
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
    const variant = String(cfg.variant || '').toLowerCase();
    const kind = String(cfg.kind || '').toLowerCase();
    const title = normLocatorText(cfg.title || '');
    if (!framework || !kind || !title) return null;
    const expectedParentPath = normalizePath(cfg.parentPath);
    const expectedLevel = Number.isInteger(Number(cfg.level)) ? Number(cfg.level) : null;
    const actionIndex = Math.max(0, Number(cfg.actionIndex || 0));
    let nodes = [];
    let items = [];
    if (framework === 'ant-tree') {
      const isSelectTree = variant === 'select';
      const nodeSelector = isSelectTree
        ? '.ant-select-tree-treenode, .ec-ant-select-tree-treenode, [class*="-ant-select-tree-treenode"]'
        : '.ant-tree-treenode, .ec-ant-tree-treenode, [class*="-ant-tree-treenode"]';
      const contentSelector = isSelectTree
        ? '.ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"]'
        : '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"]';
      const titleSelector = isSelectTree
        ? '.ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]'
        : '.ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"]';
      nodes = Array.from(document.querySelectorAll(nodeSelector));
      if (!nodes.length) nodes = Array.from(document.querySelectorAll(`${contentSelector}, [role="treeitem"]`));
      items = collectVisibleTreeItems(
        nodes,
        (node) => getTreeNodeVisibleTitle(node.querySelector?.(titleSelector) || node),
        (node) => node.querySelector?.(contentSelector) || node,
      );
    } else if (framework === 'vtree') {
      nodes = Array.from(document.querySelectorAll('.vtree-tree-node__indent-wrapper'));
      items = collectVisibleTreeItems(
        nodes,
        getVtreeNodeTitle,
        (node) => node.querySelector?.('.vtree-tree-node__title, .vtree-tree-node__node-body') || node,
      );
    } else if (framework === 'element-tree' || framework === 'iview-tree') {
      const isElementTree = framework === 'element-tree';
      const nodeSelector = isElementTree ? '.el-tree-node' : '.ivu-tree-title';
      const titleSelector = isElementTree ? '.el-tree-node__label' : '';
      const anchorSelector = isElementTree ? '.el-tree-node__content' : '';
      nodes = Array.from(document.querySelectorAll(nodeSelector));
      items = collectVisibleTreeItems(
        nodes,
        (node) => getTreeNodeVisibleTitle(titleSelector ? (node.querySelector?.(titleSelector) || node) : node),
        (node) => anchorSelector ? (node.querySelector?.(anchorSelector) || node) : node,
      );
    } else {
      return null;
    }
    const targetOf = (node) => {
      if (!node) return null;
      if (framework === 'ant-tree') {
        const isSelectTree = variant === 'select'
          || Array.from(node.classList || []).some((name) => /ant-select-tree-treenode$/.test(name));
        if (kind === 'expand_toggle') return node.querySelector?.(isSelectTree
          ? '.ant-select-tree-switcher, .ec-ant-select-tree-switcher, [class*="-ant-select-tree-switcher"]'
          : '.ant-tree-switcher, .ec-ant-tree-switcher, [class*="-ant-tree-switcher"]') || null;
        if (kind === 'node_content') return node.querySelector?.(isSelectTree
          ? '.ant-select-tree-node-content-wrapper, .ec-ant-select-tree-node-content-wrapper, [class*="-ant-select-tree-node-content-wrapper"], .ant-select-tree-title, .ec-ant-select-tree-title, [class*="-ant-select-tree-title"]'
          : '.ant-tree-node-content-wrapper, .ec-ant-tree-node-content-wrapper, [class*="-ant-tree-node-content-wrapper"], .ant-tree-title, .ec-ant-tree-title, [class*="-ant-tree-title"]') || node;
        if (kind === 'checkbox') return node.querySelector?.(isSelectTree
          ? '.ant-select-tree-checkbox, .ec-ant-select-tree-checkbox, [class*="-ant-select-tree-checkbox"]'
          : '.ant-tree-checkbox, .ec-ant-tree-checkbox, [class*="-ant-tree-checkbox"]') || null;
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
      if (framework === 'element-tree') {
        if (kind === 'expand_toggle') return node.querySelector?.('.el-tree-node__expand-icon') || null;
        if (kind === 'checkbox') return node.querySelector?.('.el-checkbox') || null;
        if (kind === 'node_content') return node.querySelector?.('.el-tree-node__content, .el-tree-node__label') || node;
      }
      if (framework === 'iview-tree') {
        const item = node.closest?.('li') || node.parentElement || node;
        if (kind === 'expand_toggle') return item.querySelector?.('.ivu-tree-arrow') || null;
        if (kind === 'checkbox') return item.querySelector?.('.ivu-checkbox') || null;
        if (kind === 'node_content') return node;
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
    const x = normalizeXPath(xpRaw);
    if (!x) return [];
    try {
      const result = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const n = result.snapshotItem(i);
        if (n && n.nodeType === Node.ELEMENT_NODE) nodes.push(n);
      }
      return nodes;
    } catch (error) {
      throw locatorError('LOCATOR_XPATH_INVALID', String(error?.message || error || 'XPath evaluation failed'), {
        source: 'xpath',
        raw_xpath: String(xpRaw || '').trim(),
        normalized_xpath: x,
      });
    }
  }

  function treeNodeTextMatchesRecordedTarget(el, ctx) {
    if (!el) return false;
    const recordedTag = String(ctx?.tag || '').trim().toLowerCase();
    const controlKind = String(ctx?.control_kind || '').trim().toLowerCase();
    const childControlTags = new Set(['a', 'button', 'input', 'label', 'select', 'textarea', 'i', 'svg', 'path', 'use']);
    const childControlKinds = new Set(['button', 'checkbox', 'radio', 'select', 'svg', 'switch', 'menu_trigger', 'node_action']);
    if (!childControlTags.has(recordedTag) && !childControlKinds.has(controlKind)) return true;
    return String(el.tagName || '').trim().toLowerCase() === recordedTag;
  }

  function findTreeChildActionHost(treeNode, ctx) {
    if (!treeNode?.querySelectorAll) return null;
    const recordedTag = String(ctx?.tag || '').trim().toLowerCase();
    if (!['a', 'button', 'i', 'svg', 'path', 'use'].includes(recordedTag)) return null;
    let hosts = Array.from(treeNode.querySelectorAll(
      'button, a[href], [role="button"], [aria-haspopup="menu"], [onclick], i',
    )).filter((host) => {
      if (host.closest?.([
        '.ant-tree-switcher', '.ec-ant-tree-switcher', '[class*="-ant-tree-switcher"]',
        '.ant-tree-checkbox', '.ec-ant-tree-checkbox', '[class*="-ant-tree-checkbox"]',
      ].join(','))) return false;
      const rect = host.getBoundingClientRect?.();
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return false;
      const style = window.getComputedStyle?.(host);
      return !style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0);
    });
    if (['svg', 'path', 'use'].includes(recordedTag)) {
      const svgHosts = hosts.filter((host) => host.querySelector?.('svg'));
      if (svgHosts.length) hosts = svgHosts;
    }
    if (hosts.length === 1) return hosts[0];
    const recordedRect = ctx?.rect;
    if (!hosts.length || !recordedRect || !Number.isFinite(Number(recordedRect.left)) || !Number.isFinite(Number(recordedRect.top))) return null;
    const expectedX = Number(recordedRect.left) + Number(recordedRect.width || 0) / 2;
    const expectedY = Number(recordedRect.top) + Number(recordedRect.height || 0) / 2;
    hosts.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.hypot(ar.left + ar.width / 2 - expectedX, ar.top + ar.height / 2 - expectedY)
        - Math.hypot(br.left + br.width / 2 - expectedX, br.top + br.height / 2 - expectedY);
    });
    return hosts[0] || null;
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
        if (type === 'tree_node_text' || type === 'tree_item_text') {
          const el = findTreeNodeByText(value);
          // tree_node_text 只能恢复节点正文。录制目标若是节点内部的图标、按钮
          // 或输入控件，只允许在该节点内恢复最近的可点击宿主，绝不点击整行。
          const childHost = el && !treeNodeTextMatchesRecordedTarget(el, ctx)
            ? findTreeChildActionHost(el, ctx)
            : null;
          if (childHost) return childHost;
          if (el && treeNodeTextMatchesRecordedTarget(el, ctx)) return el;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // 查找元素：非 #id 时优先 XPath；忽略 rc_* 自增 id（勾选后重渲染会变），必要时兜底 Ant Select 搜索框
  function findElement(selector, xpath, locatorMeta) {
    const meta = parseLocatorMeta(locatorMeta);
    const locatorValues = [
      { value: selector, source: 'target_selector' },
      { value: xpath, source: 'target_xpath' },
      ...(Array.isArray(meta?.candidates) ? meta.candidates : []).map((candidate) => ({
        value: candidate?.value,
        source: `locator_meta.${String(candidate?.type || 'unknown')}`,
        type: String(candidate?.type || '').trim().toLowerCase(),
      })),
    ];
    const privateTypes = new Set(['jquery', 'js', 'js_path', 'jspath', 'testrigor']);
    for (const item of locatorValues) {
      const strategy = privateTypes.has(item.type) ? item.type : unsupportedLocatorStrategy(item.value);
      if (!strategy) continue;
      throw locatorError('LOCATOR_STRATEGY_UNSUPPORTED', `Unsupported locator strategy: ${strategy}`, {
        source: item.source,
        strategy,
      });
    }
    const ctx = getLocatorContext(locatorMeta);
    const collectionCandidate = parseLocatorMeta(locatorMeta)?.candidates
      ?.find((candidate) => ['collection_item', 'table_row_semantic'].includes(String(candidate?.type || '')));
    // 有集合项语义候选时，禁止后续 CSS/XPath 回落到固定序号。
    if (collectionCandidate) return findCollectionItem(collectionCandidate.value);
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

  const OVERLAY_CONTAINER_SEL = [
    '.ivu-select-dropdown', '.el-select-dropdown', '.ant-select-dropdown',
    '.v-menu__content', '.vs__dropdown-menu', '.el-popper',
    '.ivu-cascader-menu', '.el-cascader__dropdown',
    '.ant-cascader-dropdown', '.ant-cascader-menus',
  ].join(',');
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
        'li, [role="option"], [role="menuitem"], .ivu-select-item, .el-select-dropdown__item, .el-option, .ant-select-item, .ant-select-item-option-content, .ivu-cascader-menu-item, .el-cascader-node, .ant-cascader-menu-item',
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

  function findVirtualScrollTarget(step, options = {}) {
    const meta = parseLocatorMeta(step?.locator_meta);
    const vs = meta?.context?.virtual_scroll;
    if (!vs || !['maybe', 'true'].includes(String(vs.hint || ''))) return null;
    const needle = String(step?.value || vs.item_text || vs.option_text || '').replace(/\s+/g, ' ').trim();
    if (!needle) return null;
    const overlayOnly = options.overlayOnly === true;
    const itemSelector = [
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
      '.ant-select-item-option-content',
      '.el-select-dropdown__item',
      '.el-option',
      '.ivu-select-item',
      '.ivu-cascader-menu-item',
      '.el-cascader-node',
      '.ant-cascader-menu-item',
      '[class*="virtual"]',
      '[class*="row"]',
      '[class*="item"]',
    ].join(',');
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.02;
    };
    const isScrollable = (el) => {
      if (!visible(el)) return false;
      const st = window.getComputedStyle(el);
      const overflow = [st.overflow, st.overflowY, st.overflowX].join(' ');
      return /(auto|scroll|overlay)/i.test(overflow)
        && ((el.scrollHeight - el.clientHeight > 2) || (el.scrollWidth - el.clientWidth > 2));
    };
    const itemText = (el) => {
      const title = el.querySelector?.('.truncate, [class*="font-medium"]');
      const titleText = String(title?.innerText || title?.textContent || '').replace(/\s+/g, ' ').trim();
      return titleText || String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const looksVirtual = (container) => {
      if (String(vs.hint || '') === 'true') return true;
      const cls = String([
        container.className,
        container.parentElement?.className,
        container.firstElementChild?.className,
      ].join(' ')).replace(/\s+/g, ' ').trim().toLowerCase();
      if (/virtual|virtual-list|virtual-scroll|rc-virtual-list|cdk-virtual|v-virtual/.test(cls)) return true;
      const rows = Array.from(container.querySelectorAll(itemSelector)).filter(visible);
      const ratio = container.clientHeight > 0 ? container.scrollHeight / container.clientHeight : 1;
      return ratio > 2.2 && rows.length > 0 && rows.length <= 80;
    };
    const findIn = (container) => {
      const rows = Array.from(container.querySelectorAll(itemSelector)).filter(visible);
      const row = rows.find((node) => itemText(node) === needle)
        || rows.find((node) => {
          const text = itemText(node);
          return needle.length >= 1 && text.includes(needle);
        });
      if (!row) return null;
      return row.matches?.('button,a,[role="button"],input[type="button"],input[type="submit"],li,[role="option"],[role="menuitem"],.ant-select-item,.el-select-dropdown__item,.el-option,.ivu-select-item,.ivu-cascader-menu-item,.el-cascader-node,.ant-cascader-menu-item')
        ? row
        : row.querySelector?.('button,a,[role="button"],input[type="button"],input[type="submit"]') || row;
    };
    const candidates = [];
    const add = (el) => {
      if (el && isScrollable(el) && !candidates.includes(el)) candidates.push(el);
    };
    if (vs.container_selector) {
      try { add(document.querySelector(vs.container_selector)); } catch (e) { /* ignore */ }
    }
    if (vs.container_xpath) {
      try { add(findXPathMatches(vs.container_xpath)[0]); } catch (e) { /* ignore */ }
    }
    if (overlayOnly) {
      const overlays = Array.from(document.querySelectorAll(OVERLAY_CONTAINER_SEL)).filter(visible);
      for (const overlay of overlays) {
        add(overlay);
        Array.from(overlay.querySelectorAll('*')).forEach(add);
      }
    } else {
      Array.from(document.querySelectorAll('*')).forEach(add);
    }
    const targets = candidates.filter(looksVirtual);
    for (const container of (targets.length ? targets : candidates).slice(0, 8)) {
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const stepSize = Math.max(40, Math.floor((container.clientHeight || 160) * 0.82));
      const positions = [];
      const push = (v) => {
        if (!Number.isFinite(Number(v))) return;
        const n = Math.max(0, Math.min(maxTop, Math.round(Number(v))));
        if (!positions.includes(n)) positions.push(n);
      };
      push(vs.scroll_top);
      push(container.scrollTop);
      push(0);
      for (let p = 0; p <= maxTop && positions.length < 16; p += stepSize) push(p);
      push(maxTop);
      for (const pos of positions) {
        container.scrollTop = pos;
        try { container.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { /* ignore */ }
        const found = findIn(container);
        if (found) return found;
      }
    }
    return null;
  }

  /** 与 extension/modules/player-manager.js 中 PAGE_LOADING_UI_CHECK 语义一致 */
  const LOADING_WAIT_WALL_MS = 90000;

  function isPageLoadingUi() {
    try {
      if (document.querySelector('[aria-busy="true"]')) return true;
      const nodes = document.querySelectorAll(
        '.ivu-spin-fix .ivu-spin-main,.ivu-table-wrapper .ivu-spin-main,.ivu-table-with-loading .ivu-spin,'
        + '.ivu-spin.ivu-spin-fix .ivu-spin-main,.ivu-load-loop,.ant-spin-spinning,.ant-spin-nested-loading .ant-spin,'
        + '.el-loading-mask,.el-loading-spinner,.el-icon-loading,.v-loading-parent--relative .v-loading,'
        + '.next-loading,.next-loading-mask,.next-loading-inline,.next-loading-fusion-reactor,.next-icon-loading,'
        + '.next-spin,.next-spin-spinning,.next-spin-dot,.next-spin-icon,'
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

  /** 须与 modules/player-manager.js 中 DEFAULT_PAGE_ERROR_KEYWORDS 保持一致 */
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

  function getActiveOverlayScrollContainers() {
    const zIndex = (el) => {
      let z = 0;
      for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
        const value = Number.parseInt(window.getComputedStyle(cur).zIndex, 10);
        if (Number.isFinite(value) && value > z) z = value;
      }
      return z;
    };
    const visible = (el) => {
      const rect = el?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.02;
    };
    const overlays = Array.from(document.querySelectorAll(OVERLAY_CONTAINER_SEL))
      .filter(visible)
      .map((el) => ({ el, z: zIndex(el) }))
      .sort((a, b) => b.z - a.z);
    if (!overlays.length) return [];
    const containers = [];
    const add = (el) => {
      if (!el || containers.includes(el) || !visible(el)) return;
      if (el.scrollHeight - el.clientHeight > 2) containers.push(el);
    };
    overlays.filter((item) => item.z === overlays[0].z).slice(0, 2).forEach(({ el }) => {
      add(el);
      el.querySelectorAll('*').forEach(add);
    });
    return containers.slice(0, 5);
  }

  // 无论录制时是否识别出 virtual class，浮层内按文本首次未命中后都可以
  // 受控地滚动当前最上层下拉 / 自动完成 / 级联面板再重试。
  async function findOverlayOptionByScrolling(text, timeout = 3800) {
    const needle = String(text || '').trim();
    if (!needle) return null;
    const deadline = Date.now() + timeout;
    let attempts = 0;
    while (Date.now() < deadline && attempts < 18) {
      const found = findOverlayOptionByText(needle);
      if (found) return found;
      let moved = false;
      getActiveOverlayScrollContainers().forEach((container) => {
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const before = container.scrollTop;
        const step = Math.max(40, Math.floor(container.clientHeight * 0.8));
        let next = before + step;
        if (next >= maxTop - 1 && before > 0) next = 0;
        else next = Math.min(maxTop, next);
        container.scrollTop = next;
        try { container.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) { /* ignore */ }
        if (container.scrollTop !== before) moved = true;
      });
      if (!moved) break;
      attempts += 1;
      await sleep(140);
    }
    return null;
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
    const loadingClassRe = /(?:^|\s)(?:is-)?(?:loading|spinning|pending|btn-loading|button-loading|ant-btn-loading|ivu-btn-loading|el-button--loading|arco-btn-loading)(?:\s|$)/i;
    const loadingIndicatorSel = [
      '.el-icon-loading', '.el-loading-spinner', '.is-loading',
      '.ivu-load-loop', '.ivu-icon-ios-loading', '.ivu-spin',
      '.ant-btn-loading-icon', '.anticon-loading', '.ant-spin-spinning',
      '.arco-icon-loading', '.arco-spin', '.n-spin',
      '[data-loading="true"]', '[aria-busy="true"]',
    ].join(',');
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
    const hasVisibleLoadingIndicator = (root) => {
      if (!root?.querySelectorAll) return false;
      const list = root.querySelectorAll(loadingIndicatorSel);
      for (const item of list) {
        if (!item || item === root) continue;
        if (item.getAttribute?.('aria-hidden') === 'true') continue;
        const st = window.getComputedStyle ? window.getComputedStyle(item) : null;
        if (st && (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) === 0)) continue;
        const r = item.getBoundingClientRect?.();
        if (r && (r.width > 0 || r.height > 0)) return true;
      }
      return false;
    };

    if (el.disabled || el.getAttribute?.('disabled') !== null) return true;
    if (el.getAttribute?.('aria-disabled') === 'true') return true;
    if (el.getAttribute?.('aria-busy') === 'true' || el.getAttribute?.('data-loading') === 'true') return true;
    if (loadingClassRe.test(String(el.className || ''))) return true;
    const ownerControl = el.closest?.(formControlSel);
    if (ownerControl) {
      if (ownerControl.disabled || ownerControl.getAttribute?.('disabled') !== null) return true;
      if (ownerControl.getAttribute?.('aria-disabled') === 'true') return true;
      if (ownerControl.getAttribute?.('aria-busy') === 'true' || ownerControl.getAttribute?.('data-loading') === 'true') return true;
      if (loadingClassRe.test(String(ownerControl.className || ''))) return true;
      if (hasVisibleLoadingIndicator(ownerControl)) return true;
      const fieldset = ownerControl.closest?.('fieldset[disabled]');
      if (fieldset) return true;
    }

    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.matches?.(componentRootSel)) {
        if (cur.disabled || cur.getAttribute?.('disabled') !== null) return true;
        if (cur.getAttribute?.('aria-disabled') === 'true') return true;
        if (disabledClassRe.test(String(cur.className || ''))) return true;
        if (cur.getAttribute?.('aria-busy') === 'true' || cur.getAttribute?.('data-loading') === 'true') return true;
        if (loadingClassRe.test(String(cur.className || ''))) return true;
        if (hasVisibleLoadingIndicator(cur)) return true;
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
  function resolveVisibleClickTarget(el, locatorMeta = null) {
    if (!el) return el;
    const tagName = (el.tagName || '').toLowerCase();
    const locatorContext = getLocatorContext(locatorMeta);
    if (['svg', 'path', 'use'].includes(tagName)) {
      const treeNode = el.closest?.([
        '.ant-tree-treenode', '.ec-ant-tree-treenode', '[class*="-ant-tree-treenode"]', '[role="treeitem"]',
      ].join(','));
      const host = treeNode && el.closest?.('button, a[href], [role="button"], [aria-haspopup="menu"], [onclick], i');
      if (host && treeNode.contains(host) && host !== treeNode) {
        const recovered = findTreeChildActionHost(treeNode, locatorContext);
        if (recovered === host) return host;
      }
    }
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
    const visibleToggleHost = findVisibleNativeToggleHost(el, locatorMeta);
    if (visibleToggleHost) return visibleToggleHost;
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

  function getNativeToggleControl(el) {
    if (!el) return null;
    if (el.tagName === 'INPUT') {
      const type = String(el.type || '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') return el;
    }
    if (el.tagName === 'LABEL' && el.control) return getNativeToggleControl(el.control);
    if (el.matches?.('.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, .ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox')) {
      return getNativeToggleControl(el.querySelector?.('input[type="radio"],input[type="checkbox"]'));
    }
    return null;
  }

  function getToggleCheckedState(control) {
    if (!control) return false;
    // View UI 的受控 checkbox 以组件 class 为准；其内部 input 在部分版本中
    // 不会同步 checked 属性，直接读取会把成功的点击判为失败。
    const iviewCheckbox = control.closest?.('.ivu-checkbox');
    if (iviewCheckbox) return iviewCheckbox.classList.contains('ivu-checkbox-checked');
    return Boolean(control.checked);
  }

  function findVisibleNativeToggleHost(input, locatorMeta = null) {
    const control = getNativeToggleControl(input);
    if (!control) return null;

    const usableHost = (host) => {
      if (!host || host === control || !host.getBoundingClientRect) return false;
      const rect = host.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) return false;
      const style = window.getComputedStyle(host);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      const nestedInteractive = Array.from(host.querySelectorAll?.('a[href],button,select,textarea,[role="button"]') || []);
      return !nestedInteractive.some((node) => {
        const nodeRect = node.getBoundingClientRect();
        return node !== control && nodeRect.width > 2 && nodeRect.height > 2;
      });
    };
    const activatesControl = (host) => {
      if (!host) return false;
      if (host.tagName === 'LABEL') {
        return host.control === control
          || host.contains(control)
          || Boolean(control.id && host.getAttribute('for') === control.id);
      }
      return Boolean(host.contains?.(control));
    };
    const activationMeta = parseLocatorMeta(locatorMeta)?.context?.activation_target;
    if (activationMeta && typeof activationMeta === 'object') {
      let recordedHost = null;
      try {
        if (activationMeta.selector) recordedHost = document.querySelector(String(activationMeta.selector));
      } catch (e) { /* ignore invalid historical selector */ }
      if (!recordedHost && activationMeta.xpath) {
        recordedHost = findXPathMatches(String(activationMeta.xpath))[0] || null;
      }
      if (activatesControl(recordedHost) && usableHost(recordedHost)) return recordedHost;
    }
    const inputRect = control.getBoundingClientRect();
    if (inputRect.width > 2 || inputRect.height > 2) return null;
    const labels = control.labels ? Array.from(control.labels) : [];
    for (const label of labels) {
      if (!label || label.control !== control) continue;
      if (usableHost(label)) return label;
    }
    const component = control.closest?.(
      '.ivu-radio-wrapper, .ant-radio-wrapper, .el-radio, .ivu-checkbox-wrapper, .ant-checkbox-wrapper, .el-checkbox',
    );
    if (usableHost(component)) return component;
    return null;
  }

  function expectedToggleState(step, control, fallback = null) {
    const recorded = parseLocatorMeta(step?.locator_meta)?.context?.toggle?.expected_checked;
    if (typeof recorded === 'boolean') return recorded;
    if (fallback != null) return Boolean(fallback);
    if (!control) return null;
    return String(control.type || '').toLowerCase() === 'radio' ? true : !getToggleCheckedState(control);
  }

  async function waitForNativeToggleState(control, expectedChecked, timeout = 900) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (control?.isConnected && getToggleCheckedState(control) === expectedChecked) return true;
      await sleep(100);
    }
    return false;
  }

  function waitForElement(selector, xpath, textFallback = '', timeout = 5000, skipDisabledCheck = false, locatorMeta = null, skipPageErrorCheck = false) {
    try {
      validateXPath(xpath, 'target_xpath');
    } catch (error) {
      return Promise.reject(error);
    }
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
          const clickEl = resolveVisibleClickTarget(el, locatorMeta);
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
    if (el?.isContentEditable || (el?.closest && el.closest('[contenteditable="true"]'))) {
      const target = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
      target.textContent = String(value ?? '');
      try {
        target.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: String(value ?? ''),
        }));
      } catch (e) {
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
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

  function triggerSelectEvent(el, value, valueText = '') {
    if (!el || el.tagName !== 'SELECT') return false;
    const rawValue = String(value ?? '');
    let matched = false;
    for (const option of Array.from(el.options || [])) {
      if (String(option.value) === rawValue) {
        el.value = option.value;
        matched = true;
        break;
      }
    }
    if (!matched && valueText) {
      const expectedText = String(valueText).trim();
      const option = Array.from(el.options || []).find((item) => String(item.text || '').trim() === expectedText);
      if (option) {
        el.value = option.value;
        matched = true;
      }
    }
    if (!matched) return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
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

  // 仅将原生 select 这类可稳定读取的控件升级为强校验；普通输入可能被
  // 掩码、格式化或异步联动，仍只采集观察证据，避免制造假失败。
  function collectStepOutcome(step) {
    const actionType = String(step?.action_type || '').trim().toLowerCase();
    const base = { mode: 'none', observed: null };
    if (!['input', 'select', 'click'].includes(actionType)) return { effect: base };
    const el = findElement(step.target_selector, step.target_xpath, step.locator_meta);
    if (!el) return { effect: { mode: 'observe', type: 'target_state', observed: null, evidence: 'target_not_available_after_action' } };

    if (actionType === 'click') {
      const toggle = getNativeToggleControl(el);
      if (!toggle) return { effect: base };
      const actualChecked = getToggleCheckedState(toggle);
      const expectedChecked = expectedToggleState(step, toggle, actualChecked);
      return {
        effect: {
          mode: 'observe',
          type: 'toggle_checked',
          observed: actualChecked === expectedChecked,
          actual: actualChecked ? 'checked' : 'unchecked',
          expected: expectedChecked ? 'checked' : 'unchecked',
        },
      };
    }

    const target = el.matches?.('input,textarea,select,[contenteditable="true"]')
      ? el
      : (el.querySelector?.('input,textarea,select,[contenteditable="true"]') || el);
    const actual = target?.isContentEditable
      ? String(target.textContent || '')
      : String(target?.value ?? '');
    const nativeSelect = target?.tagName === 'SELECT';
    const expected = String(actionType === 'select' || nativeSelect ? (step.value_text || step.value || '') : (step.value || ''));
    const normalizedActual = actual.trim();
    const normalizedExpected = expected.trim();
    const observed = nativeSelect
      ? (String(target.value || '') === String(step.value || '') || normalizedActual === normalizedExpected)
      : normalizedActual === normalizedExpected;
    return {
      effect: {
        mode: nativeSelect ? 'required' : 'observe',
        type: actionType === 'select' || nativeSelect ? 'select_value' : 'input_value',
        observed,
        expected: expected.slice(0, 240),
        actual: actual.slice(0, 240),
      },
    };
  }

  // 执行单步操作
  async function executeStep(step, nextStep = null) {
    step = resolveStepRuntimeVariables(step);
    nextStep = resolveStepRuntimeVariables(nextStep);
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
        // 自动识别浮层选项步骤（兼容旧版录制数据）
        // is_overlay 且 value 为空时勿走「按文案点下拉项」（Poptip 内 textarea 等易被误判为浮层）
        const locatorContext = parseLocatorMeta(step.locator_meta)?.context || {};
        const looksLikeOverlay = (step.is_overlay && String(step.value || '').trim() !== '')
          || (locatorContext.overlay === true && String(step.value || '').trim() !== '')
          || (!step.target_selector && step.value);
        const revealTrigger = extractRevealTriggerFromLocatorMeta(step.locator_meta);
        if (revealTrigger && !isRevealAlreadySatisfied(step, revealTrigger, looksLikeOverlay)) {
          try { await activateRevealTrigger(revealTrigger); } catch (e) { /* ignore */ }
          await sleep(450);
        }

        let el = null;
        const virtualMeta = parseLocatorMeta(step.locator_meta)?.context?.virtual_scroll;
        const hasVirtualContext = virtualMeta && ['maybe', 'true'].includes(String(virtualMeta.hint || ''));
        const treeTarget = await findTreeInteractionWithScroll(step.locator_meta, 6000);
        if (treeTarget) el = treeTarget;
        if (looksLikeOverlay && step.value) {
          el = el || await waitForOverlayOption(step.value, 2200);
          if (!el) el = await findOverlayOptionByScrolling(step.value, 3800);
          if (!el) el = findVirtualScrollTarget(step, { overlayOnly: true });
        }
        if (!el && !(looksLikeOverlay && hasVirtualContext)) {
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
        if (!looksLikeOverlay) {
          const virtualTarget = findVirtualScrollTarget(step, { overlayOnly: false });
          if (virtualTarget) el = virtualTarget;
        }
        const nativeToggle = actionType === 'click' ? getNativeToggleControl(el) : null;
        const expectedChecked = nativeToggle
          ? expectedToggleState(step, nativeToggle)
          : null;
        scrollIntoView(el);
        await sleep(200);
        el = preferTopmostSemanticClickTarget(el);
        dispatchMouseLike(el, actionType, step.locator_meta);
        if (nativeToggle) {
          // 保留短暂等待以采集异步组件的最终状态，但不以此阻断后续步骤。
          await waitForNativeToggleState(nativeToggle, expectedChecked, 250);
        }
        if (step.is_overlay) await sleep(300);
        break;
      }

      case 'input': {
        const el = await waitForElement(step.target_selector, step.target_xpath, '', 6000, false, step.locator_meta);
        if (!el) throw new Error(formatElementNotFound(step));
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(40);
        if (el.tagName === 'SELECT') {
          if (!triggerSelectEvent(el, step.value || '', step.value_text || '')) {
            throw new Error(tr(`无法选择下拉项: ${step.value || step.value_text || ''}`, `Cannot select option: ${step.value || step.value_text || ''}`));
          }
          await sleep(80);
          break;
        }
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

      case 'select': {
        const el = await waitForElement(step.target_selector, step.target_xpath, '', 6000, false, step.locator_meta);
        if (!el) throw new Error(formatElementNotFound(step));
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(40);
        if (el.tagName !== 'SELECT') {
          throw new Error(tr(`目标不是原生 select 元素\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}`, `Target is not a native select element\n  CSS: ${step.target_selector}\n  XPath: ${step.target_xpath}`));
        }
        if (!triggerSelectEvent(el, step.value || '', step.value_text || '')) {
          throw new Error(tr(`无法选择下拉项: ${step.value || step.value_text || ''}`, `Cannot select option: ${step.value || step.value_text || ''}`));
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

      case 'set_variable': {
        const name = normalizeVariableName(step.value || step.variable_name || step.name);
        if (!name) throw new Error(tr('保存变量失败：变量名为空', 'Set variable failed: variable name is empty'));
        const el = await waitForElement(step.target_selector, step.target_xpath, '', 6000, false, step.locator_meta, true);
        if (!el) throw new Error(formatElementNotFound(step));
        runtimeVariables[name] = applyVariableExtraction(getElementValueForVariable(el), step).value;
        break;
      }

      case 'hover': {
        const el = await waitForElement(step.target_selector, step.target_xpath, '', 5000, false, step.locator_meta);
        if (!el) throw new Error(formatElementNotFound(step));
        const pointer = parseLocatorMeta(step.locator_meta)?.context?.pointer;
        const hasRecordedPoint = pointer?.use_recorded_point === true
          && Number.isFinite(Number(pointer.x_ratio))
          && Number.isFinite(Number(pointer.y_ratio));
        let hoverAnchor = null;
        if (!hasRecordedPoint && el.querySelector) {
          try {
            hoverAnchor = el.querySelector(
              ':scope > .el-submenu__title, :scope > .ivu-menu-submenu-title, :scope > .ant-menu-submenu-title',
            );
            if (hoverAnchor) {
              const ar = hoverAnchor.getBoundingClientRect();
              if (ar.width <= 0 || ar.height <= 0) hoverAnchor = null;
            }
          } catch (e) { /* ignore unsupported :scope selectors */ }
        }
        (hoverAnchor || el).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(80);
        const r = el.getBoundingClientRect();
        let cx = r.left + r.width / 2;
        let cy = r.top + r.height / 2;
        if (hasRecordedPoint) {
          cx = r.left + r.width * Math.min(1, Math.max(0, Number(pointer.x_ratio)));
          cy = r.top + r.height * Math.min(1, Math.max(0, Number(pointer.y_ratio)));
        } else if (hoverAnchor) {
          const ar = hoverAnchor.getBoundingClientRect();
          cx = ar.left + ar.width / 2;
          cy = ar.top + ar.height / 2;
        }
        cx = Math.round(cx);
        cy = Math.round(cy);
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

      case 'assert_element_match':
      case 'assert_text': {
        const expected = step.expect != null ? String(step.expect) : (step.value != null ? String(step.value) : '');
        const hasLocator = String(step.target_selector || '').trim() !== ''
          || String(step.target_xpath || '').trim() !== ''
          || (Array.isArray(parseLocatorMeta(step.locator_meta)?.candidates)
            && parseLocatorMeta(step.locator_meta).candidates.length > 0);
        const PREVIEW_MAX = 8000;
        const assertion = resolveAssertionConfig(step, hasLocator);
        if (assertion.match !== 'visible' && expected.trim() === '') {
          throw new Error(tr('断言失败：未配置断言文本（「输入值」不能为空或仅空白）', 'Assertion failed: expected text is not configured (input value cannot be empty or whitespace only)'));
        }

        if (assertion.target === 'error') {
          const evaluation = await waitForTextAssertion(assertion, expected, collectFailurePromptText);
          try {
            chrome.runtime.sendMessage({
              type: 'AT_ASSERT_TEXT_DEBUG',
              payload: {
                mode: `failure_prompt_${assertion.match}_${assertion.waitMode}`,
                needleLen: expected.length,
                needlePreview: expected.length > PREVIEW_MAX ? expected.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expected,
                pageLen: evaluation.actual.length,
                pagePreview: evaluation.actual.length > PREVIEW_MAX ? evaluation.actual.slice(0, PREVIEW_MAX) + '\n…(已截断)' : evaluation.actual,
                hit: evaluation.hit,
                css: '',
                xpath: '',
                note: '失败提示断言：匹配常见 toast/message/notice/alert 的错误或警告区域',
              },
            }).catch(() => {});
          } catch (e) {
            /* ignore */
          }
          if (!evaluation.hit) {
            throw new Error(formatAssertionFailure({
              target: assertion.target,
              match: assertion.match,
              expected,
              actual: evaluation.actual,
              css: '',
              xpath: '',
            }));
          }
          break;
        }

        if (assertion.target === 'url') {
          const evaluation = await waitForTextAssertion(assertion, expected, () => window.location.href || '');
          if (!evaluation.hit) {
            throw new Error(formatAssertionFailure({
              target: assertion.target,
              match: assertion.match,
              expected,
              actual: evaluation.actual,
              css: '',
              xpath: '',
            }));
          }
          break;
        }

        if (assertion.target === 'element') {
          const evaluation = await waitForElementAssertion(step, assertion, expected);
          if (!evaluation.found) {
            throw new Error(tr(
              `断言失败：找不到目标元素${formatTreeWaitDiagnostic(step.locator_meta)}\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
              `Assertion failed: target element not found\n  CSS: ${step.target_selector || '—'}\n  XPath: ${step.target_xpath || '—'}`,
            ));
          }
          if (assertion.match === 'visible') {
            break;
          }
          const readResult = getElementAssertionValue(evaluation.element, assertion.readMode, assertion.attribute);
          if (!readResult.ok) {
            if (readResult.attributeMissing) {
              throw new Error(`断言失败：目标元素不存在属性 ${readResult.attribute}`);
            }
            throw new Error(`断言失败：${readResult.error}`);
          }
          const actual = String(readResult.value ?? '');
          const hit = assertion.readMode === 'attribute'
            ? matchRawAssertionValue(actual, expected, assertion.match)
            : matchAssertionText(actual, expected, assertion.match);

          console.log(
            '[AT assert_text] 元素断言 · 完整日志见扩展 Service Worker。预期',
            expected.length,
            '字 / 实际',
            actual.length,
            '字 / 匹配',
            hit,
          );

          try {
            chrome.runtime.sendMessage({
              type: 'AT_ASSERT_TEXT_DEBUG',
              payload: {
                mode: `element_${assertion.waitMode}`,
                needleLen: expected.length,
                needlePreview: expected.length > PREVIEW_MAX ? expected.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expected,
                pageLen: actual.length,
                pagePreview: actual.length > PREVIEW_MAX ? actual.slice(0, PREVIEW_MAX) + '\n…(已截断)' : actual,
                hit,
                css: step.target_selector || '',
                xpath: step.target_xpath || '',
                note: assertion.readMode === 'attribute'
                  ? `已按 CSS/XPath 定位元素；读取属性 ${assertion.attribute}；按原始属性值比对`
                  : '已按 CSS/XPath 定位元素；textarea/input 取 value，其它取 textContent；按断言匹配方式比对',
              },
            }).catch(() => {});
          } catch (e) {
            /* ignore */
          }

          if (!hit) {
            throw new Error(formatAssertionFailure({
              target: assertion.target,
              match: assertion.match,
              expected,
              actual,
              css: step.target_selector || '',
              xpath: step.target_xpath || '',
            }));
          }
          break;
        }

        // 未填选择器：兼容旧行为 — 整页 innerText 是否包含预期子串
        const evaluation = await waitForTextAssertion(assertion, expected, () => document.body?.innerText || '');
        const pageText = evaluation.actual;
        const needlePreview = expected.length > PREVIEW_MAX ? expected.slice(0, PREVIEW_MAX) + '\n…(已截断)' : expected;
        const pagePreview = pageText.length > PREVIEW_MAX
          ? pageText.slice(0, PREVIEW_MAX) + '\n…(已截断，共 ' + pageText.length + ' 字)'
          : pageText;
        const finalHit = evaluation.hit;

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
          throw new Error(formatAssertionFailure({
            target: assertion.target,
            match: assertion.match,
            expected,
            actual: pageText,
            css: '',
            xpath: '',
          }));
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
    let el = null;
    try {
      el = findElement(step.target_selector, step.target_xpath, step.locator_meta);
    } catch {
      // 高亮不能抢先吞掉真正执行阶段的结构化定位错误。
      return;
    }
    if (el && typeof el.animate === 'function') {
      // 高亮不能修改 class/style；精确属性 XPath 会因此在真正执行前失效。
      el.animate([
        { outline: '3px solid #4caf50', outlineOffset: '2px' },
        { outline: '3px solid #4caf50', outlineOffset: '2px' },
      ], { duration: 1000, easing: 'linear' });
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
    if (message.type === 'AT_PROBE_STEP_VISIBILITY') {
      const step = message.step && typeof message.step === 'object' ? message.step : null;
      if (!step) {
        sendResponse({ observed: null, evidence: 'invalid_step' });
        return false;
      }
      try {
        const { target, visibleTarget } = probeVisibleTarget(step);
        if (visibleTarget) {
          sendResponse({
            observed: true,
            actual: describeProbeTarget(visibleTarget),
            evidence: visibleTarget === target ? 'target_visible' : 'semantic_target_visible',
          });
        } else {
          sendResponse({ observed: false, evidence: 'target_not_visible' });
        }
      } catch (e) {
        sendResponse({ observed: null, evidence: 'probe_failed' });
      }
      return false;
    }
    if (message.type === 'AT_PROBE_REVEAL_DEPENDENCY') {
      const step = message.step && typeof message.step === 'object' ? message.step : null;
      const timeoutMs = Math.max(500, Math.min(3500, Number(message.timeoutMs) || 2200));
      (async () => {
        if (!step) {
          sendResponse({ observed: null, evidence: 'invalid_step' });
          return;
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { target, visibleTarget } = probeVisibleTarget(step);
          if (visibleTarget) {
            sendResponse({
              observed: true,
              actual: describeProbeTarget(visibleTarget),
              evidence: visibleTarget === target ? 'target_visible' : 'semantic_target_visible',
            });
            return;
          }
          await sleep(160);
        }
        sendResponse({ observed: false, evidence: 'target_not_visible_within_timeout' });
      })().catch(() => sendResponse({ observed: null, evidence: 'probe_failed' }));
      return true;
    }
    if (message.type === 'AT_PROBE_OVERLAY_SELECTION') {
      try {
        sendResponse(probeOverlaySelection(message.step));
      } catch {
        sendResponse({ observed: null, evidence: 'probe_failed' });
      }
      return false;
    }
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
          // executeStep 内部也会解析变量；这里提前解析一份仅用于回传观察证据，
          // 避免 detail.step_outcomes 中保存的是 {{变量}} 而非本次实际输入值。
          const resolvedStep = resolveStepRuntimeVariables(step);
          const resolvedNextStep = resolveStepRuntimeVariables(nextStep);
          await executeStep(resolvedStep, resolvedNextStep);
          const stepOutcome = collectStepOutcome(resolvedStep);
          if (stepOutcome?.effect?.mode === 'required' && stepOutcome.effect.observed === false) {
            done({
              ok: false,
              error: tr(
                '选择控件未保持录制时的目标值，请检查页面联动、选项状态或录制值。',
                'The select control did not retain the recorded target value. Check page dependencies, option state, or the recorded value.',
              ),
              step_outcome: stepOutcome,
            });
            return;
          }
          done({ ok: true, step_outcome: stepOutcome });
        } catch (err) {
          const msg = err && err.message != null ? String(err.message) : String(err);
          done({
            ok: false,
            error: msg,
            error_code: err?.code || '',
            locator_error: err?.locatorError || null,
            variable_extraction_error: err?.variableExtraction || null,
            variable_extraction_error: err?.variableExtraction || null,
            step_outcome: err?.stepOutcome || null,
          });
        }
      })();
      return true; // 异步响应
    }

    if (message.type === 'AT_EXTRACT_VARIABLE') {
      currentLocale = normalizeLocale(message.locale);
      const step = resolveStepRuntimeVariables(message.step);
      (async () => {
        try {
          const name = normalizeVariableName(step.value || step.variable_name || step.name);
          if (!name) throw new Error(tr('保存变量失败：变量名为空', 'Set variable failed: variable name is empty'));
          const el = await waitForElement(step.target_selector, step.target_xpath, '', 6000, false, step.locator_meta, true);
          if (!el) throw new Error(formatElementNotFound(step));
          const extracted = applyVariableExtraction(getElementValueForVariable(el), step);
          runtimeVariables[name] = extracted.value;
          sendResponse({ ok: true, name, value: extracted.value, raw_value: extracted.raw, extract: extracted.extract });
        } catch (err) {
          sendResponse({
            ok: false,
            error: err && err.message ? String(err.message) : String(err),
            error_code: err?.code || '',
            locator_error: err?.locatorError || null,
            variable_extraction_error: err?.variableExtraction || null,
          });
        }
      })();
      return true;
    }

    if (message.type === 'AT_PLAYER_CLEANUP') {
      document.querySelectorAll('.__at_playing__').forEach(el => el.classList.remove('__at_playing__'));
      document.removeEventListener('click', preventPlaybackFilePicker, true);
      for (const key of Object.keys(runtimeVariables)) delete runtimeVariables[key];
      window.__AT_PLAYER_ACTIVE__ = false;
      sendResponse({ ok: true });
    }
  });

})();
