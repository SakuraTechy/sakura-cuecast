/**
 * CueCast 单次回放变量上下文。
 *
 * 变量仅存在于当前 PlayerManager.start 调用期间；不能写入 extension storage、日志或跨用例 Map。
 * 与 Playwright Runner 共享 ${name}、${object.key}、${list[0]} 的替换契约，但不依赖 Node API。
 */

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const RESERVED_PREFIXES = ['system.', 'secret.', 'execution.'];
const STEP_IDENTITY_KEYS = new Set([
  'id',
  'original_step_id',
  'step_index',
  'action_type',
  'source',
  'schema_version',
  'catalog_version',
  'canonical_digest',
]);

export const LOCAL_VARIABLE_ACTION_TYPES = new Set([
  'global_variable_set',
  'global_variable_date',
  'global_variable_formula',
  'assert_variable_list',
  'assert_variable_list_not',
  'assert_database_value',
]);

export function isCuecastLocalVariableAction(actionType) {
  return LOCAL_VARIABLE_ACTION_TYPES.has(String(actionType || '').trim().toLowerCase());
}

export class CuecastVariableContext {
  constructor(initialValues = {}) {
    this._values = new Map();
    this._metadata = new Map();
    if (initialValues && typeof initialValues === 'object' && !Array.isArray(initialValues)) {
      for (const [name, value] of Object.entries(initialValues)) {
        this.set(name, value, { source: 'initial', overwrite: true, allowReserved: true });
      }
    }
  }

  set(name, value, options = {}) {
    const normalized = validateVariableName(name, options.allowReserved === true);
    if (this._values.has(normalized) && options.overwrite === false) {
      throw new Error(`变量已存在且不允许覆盖：${normalized}`);
    }
    this._values.set(normalized, value);
    this._metadata.set(normalized, {
      masked: Boolean(options.masked),
      source: String(options.source || 'step'),
    });
    return this.describe(normalized);
  }

  get(reference) {
    const normalized = String(reference || '').trim();
    if (!normalized) throw new Error('变量引用不能为空');
    if (this._values.has(normalized)) return this._values.get(normalized);

    const { root, segments } = this._parseReference(normalized);
    if (!this._values.has(root)) throw new Error(`变量不存在：${root}`);
    let value = this._values.get(root);
    for (const segment of segments) {
      if (value == null || !Object.prototype.hasOwnProperty.call(Object(value), segment)) {
        throw new Error(`变量引用不存在：${normalized}`);
      }
      value = value[segment];
    }
    return value;
  }

  resolveText(value) {
    if (typeof value !== 'string' || !value.includes('${')) return value;
    const whole = value.match(/^\$\{([^{}]+)}$/);
    if (whole) return this.get(whole[1].trim());
    return value.replace(/\$\{([^{}]+)}/g, (_all, expression) => stringifyValue(this.get(String(expression).trim())));
  }

  resolveStep(step) {
    return resolveRuntimeValue(step, this, true);
  }

  referencesInStep(step) {
    const references = new Set();
    collectReferences(step, references, true);
    return [...references];
  }

  bindingsForStep(step) {
    const bindings = {};
    for (const reference of this.referencesInStep(step)) {
      const { root } = this._parseReference(reference);
      // Admin 只接收根变量，冻结步骤仍由后端按原始嵌套引用解析。
      bindings[root] = this.get(root);
    }
    return bindings;
  }

  describe(name) {
    const normalized = String(name || '').trim();
    const meta = this._metadata.get(normalized) || {};
    const value = this._values.get(normalized);
    return {
      variable_name: normalized,
      value_masked: meta.masked ? 1 : 0,
      ...(meta.masked ? {} : { value_preview: previewValue(value) }),
      source: meta.source || '',
    };
  }

  describeReferencesForStep(step) {
    return this.referencesInStep(step).map((reference) => {
      const { root } = this._parseReference(reference);
      const meta = this._metadata.get(root) || {};
      const description = this.describe(reference);
      return {
        reference,
        variable_name: root,
        value_masked: meta.masked ? 1 : 0,
        ...(meta.masked ? {} : { value_preview: description.value_preview }),
        source: meta.source || '',
      };
    });
  }

  _parseReference(reference) {
    const candidates = [...this._values.keys()]
      .filter((name) => reference === name || reference.startsWith(`${name}.`) || reference.startsWith(`${name}[`))
      .sort((left, right) => right.length - left.length);
    if (candidates.length) {
      const root = candidates[0];
      return { root, segments: parseSegments(reference.slice(root.length), reference) };
    }
    const rootMatch = reference.match(/^([A-Za-z_][A-Za-z0-9_.-]*)(.*)$/);
    if (!rootMatch) throw new Error(`变量引用格式不合法：${reference}`);
    const root = rootMatch[1].split('.')[0];
    return { root, segments: parseSegments(reference.slice(root.length), reference) };
  }
}

export function validateVariableName(name, allowReserved = false) {
  const normalized = String(name || '').trim();
  if (!VARIABLE_NAME.test(normalized)) throw new Error(`变量名不合法：${normalized || '(空)'}`);
  if (!allowReserved && RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`变量名不允许使用保留前缀：${normalized}`);
  }
  return normalized;
}

/** 只支持四则运算、括号和替换后的数字，不能以变量公式执行任意 JavaScript。 */
export function evaluateArithmeticExpression(expression, context) {
  const resolved = String(context?.resolveText(expression) ?? expression ?? '').trim();
  if (!resolved || /[^0-9+\-*/%().\s]/.test(resolved)) {
    throw new Error('计算公式只支持数字、+、-、*、/、%、括号和变量引用');
  }
  const parser = new ArithmeticParser(resolved);
  const value = parser.parse();
  if (!Number.isFinite(value)) throw new Error('计算公式结果不是有限数字');
  return value;
}

export function formatVariableDate(date, pattern) {
  const values = {
    yyyy: String(date.getFullYear()).padStart(4, '0'),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    M: String(date.getMonth() + 1),
    dd: String(date.getDate()).padStart(2, '0'),
    d: String(date.getDate()),
    HH: String(date.getHours()).padStart(2, '0'),
    H: String(date.getHours()),
    mm: String(date.getMinutes()).padStart(2, '0'),
    m: String(date.getMinutes()),
    ss: String(date.getSeconds()).padStart(2, '0'),
    s: String(date.getSeconds()),
    SSS: String(date.getMilliseconds()).padStart(3, '0'),
  };
  return String(pattern || 'yyyy-MM-dd HH:mm:ss')
    .replace(/yyyy|SSS|MM|dd|HH|mm|ss|M|d|H|m|s/g, (token) => values[token]);
}

export function formatFormulaValue(value, step = {}) {
  const scale = Number(step.scale);
  if (Number.isInteger(scale) && scale >= 0 && scale <= 20) {
    return step.keep_trailing_zeros === true || step.keep_trailing_zeros === 'true'
      ? value.toFixed(scale)
      : Number(value.toFixed(scale));
  }
  return value;
}

export function toBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function resolveRuntimeValue(value, context, isRoot = false) {
  if (typeof value === 'string') return context.resolveText(value);
  if (Array.isArray(value)) return value.map((item) => resolveRuntimeValue(item, context));
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((copy, [key, item]) => {
    copy[key] = isRoot && STEP_IDENTITY_KEYS.has(key)
      ? item
      : resolveRuntimeValue(item, context);
    return copy;
  }, {});
}

function collectReferences(value, references, isRoot = false) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([^{}]+)}/g)) references.add(String(match[1]).trim());
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, references));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    if (!(isRoot && STEP_IDENTITY_KEYS.has(key))) collectReferences(item, references);
  });
}

function parseSegments(suffix, reference) {
  const segments = [];
  let cursor = suffix;
  while (cursor) {
    const dot = cursor.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/);
    const index = cursor.match(/^\[(\d+|"[^"]+"|'[^']+')]/);
    if (dot) {
      segments.push(dot[1]);
      cursor = cursor.slice(dot[0].length);
    } else if (index) {
      const raw = index[1];
      segments.push(/^\d+$/.test(raw) ? Number(raw) : raw.slice(1, -1));
      cursor = cursor.slice(index[0].length);
    } else {
      throw new Error(`变量引用格式不合法：${reference}`);
    }
  }
  return segments;
}

function stringifyValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function previewValue(value) {
  const text = stringifyValue(value).replace(/[\r\n]+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

class ArithmeticParser {
  constructor(source) {
    this.source = source;
    this.position = 0;
  }

  parse() {
    const value = this._expression();
    this._skipWhitespace();
    if (this.position !== this.source.length) throw new Error('计算公式包含无法解析的内容');
    return value;
  }

  _expression() {
    let value = this._term();
    while (true) {
      this._skipWhitespace();
      if (this._consume('+')) value += this._term();
      else if (this._consume('-')) value -= this._term();
      else return value;
    }
  }

  _term() {
    let value = this._factor();
    while (true) {
      this._skipWhitespace();
      if (this._consume('*')) value *= this._factor();
      else if (this._consume('/')) {
        const divisor = this._factor();
        if (divisor === 0) throw new Error('计算公式不能除以 0');
        value /= divisor;
      } else if (this._consume('%')) {
        const divisor = this._factor();
        if (divisor === 0) throw new Error('计算公式不能对 0 取模');
        value %= divisor;
      } else return value;
    }
  }

  _factor() {
    this._skipWhitespace();
    if (this._consume('+')) return this._factor();
    if (this._consume('-')) return -this._factor();
    if (this._consume('(')) {
      const value = this._expression();
      this._skipWhitespace();
      if (!this._consume(')')) throw new Error('计算公式括号不匹配');
      return value;
    }
    const number = this.source.slice(this.position).match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
    if (!number) throw new Error('计算公式缺少数字');
    this.position += number[0].length;
    return Number(number[0]);
  }

  _consume(character) {
    if (this.source[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  _skipWhitespace() {
    while (/\s/.test(this.source[this.position] || '')) this.position += 1;
  }
}
