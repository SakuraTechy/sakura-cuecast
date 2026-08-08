const ACTION_PROFILES = Object.freeze({
  navigate: 'navigation',
  switch_page: 'navigation',
  close_page: 'navigation',
  close_all_pages: 'navigation',
  reload: 'navigation',
  frame_switch: 'navigation',
  frame_parent: 'navigation',
  frame_main: 'navigation',
  click: 'element_interaction',
  double_click: 'element_interaction',
  right_click: 'element_interaction',
  select_option: 'element_interaction',
  combo_select: 'element_interaction',
  input: 'element_interaction',
  input_date: 'element_interaction',
  file_upload: 'element_interaction',
  certificate_upload: 'element_interaction',
  clear: 'element_interaction',
  key: 'element_interaction',
  hover: 'element_interaction',
  scroll: 'element_interaction',
  scroll_to_element: 'element_interaction',
  pointer_move: 'element_interaction',
  dialog_accept: 'dialog',
  dialog_dismiss: 'dialog',
  dialog_prompt: 'dialog',
  assert_text: 'assertion',
  assert_text_not: 'assertion',
  assert_attribute: 'assertion',
  assert_script: 'assertion',
  assert_database_value: 'assertion',
  assert_variable_list: 'assertion',
  assert_variable_list_not: 'assertion',
  assert_text_regex: 'assertion',
  assert_element_match: 'assertion',
  wait: 'wait',
  implicit_wait: 'wait',
  captcha_ocr: 'variable',
  global_variable_set: 'variable',
  global_variable_date: 'variable',
  global_variable_formula: 'variable',
  global_variable_system_info: 'variable',
  global_variable_available_ip: 'variable',
  global_variable_property: 'variable',
  evaluate: 'script',
  server_command: 'infrastructure',
  database_sql: 'infrastructure',
  database_native: 'infrastructure',
  host_command: 'infrastructure',
  host_file_lookup: 'infrastructure',
  host_file_delete: 'infrastructure',
  host_pointer_move: 'infrastructure',
  server_file_upload: 'infrastructure',
});

const INPUT_KEYS = Object.freeze([
  'url', 'target_ref', 'target_selector', 'target_xpath', 'value', 'option', 'key', 'modifier', 'modifiers',
  'index', 'duration_ms', 'wait_before', 'attribute', 'expect', 'regex', 'variable_name', 'source_type',
  'file_ref', 'certificate_ref', 'path', 'remote_path', 'x', 'y', 'format', 'date_mode', 'info_type',
  'property_key', 'expression', 'scale', 'timeout_ms', 'sql', 'command', 'script', 'read_mode',
  'regex_group', 'replace_from', 'replace_to', 'datetime', 'offset_seconds', 'timestamp_unit',
  'keep_trailing_zeros', 'ip_prefix', 'start', 'end', 'profile',
]);

const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|authorization|api[_-]?key|private[_-]?key|credential)/i;
const RESTRICTED_KEY = /^(sql|command|script)$/i;
const PATH_KEY = /(^|_)(path|file_ref|certificate_ref|remote_path)$/i;
const URL_KEY = /(^|_)url$/i;
const SOURCE_LABELS = Object.freeze({
  variable_reference: '引用变量',
  literal: '固定值',
  runtime: '运行时',
  definition_snapshot: '定义快照',
  executor: '执行器返回',
});
const RESULT_FACT_LABELS = Object.freeze({
  reloaded: '刷新结果',
  wait_duration_ms: '实际等待时长',
  implicit_wait_ms: '隐式等待时长',
  previous_implicit_wait_ms: '原隐式等待时长',
  exit_code: '退出码',
  affected_rows: '影响行数',
  row_count: '返回行数',
  selected_option: '最终选项',
  filename: '文件名',
  file_count: '文件数量',
  opened_page_url: '新页面地址',
  active_page_url: '当前页面地址',
});

export function attachOperationDiagnostic(result, definitionStep = {}, runtimeStep = definitionStep, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const details = result.details && typeof result.details === 'object' ? result.details : {};
  const { operation_assertion: _operationAssertion, ...cleanResult } = result;
  return {
    ...cleanResult,
    details: {
      ...details,
      operation: buildOperationDiagnostic(definitionStep, runtimeStep, result, options),
    },
  };
}

export function buildOperationDiagnostic(definitionStep = {}, runtimeStep = {}, result = {}, options = {}) {
  const actionType = normalize(result.action_type || runtimeStep.action_type || definitionStep.action_type);
  const profile = String(
    definitionStep.diagnostic_profile || definitionStep.diagnosticProfile || ACTION_PROFILES[actionType] || 'generic',
  );
  const operation = {
    schema_version: 1,
    ...(firstText(definitionStep.catalog_version, runtimeStep.catalog_version)
      ? { catalog_version: firstText(definitionStep.catalog_version, runtimeStep.catalog_version) } : {}),
    profile,
    executor: String(options.executor || 'extension-cdp'),
    method: {
      ...(firstText(definitionStep.type_code, definitionStep.typeCode)
        ? { type_code: firstText(definitionStep.type_code, definitionStep.typeCode) } : {}),
      ...(firstText(definitionStep.type_label, definitionStep.typeLabel)
        ? { type_label: firstText(definitionStep.type_label, definitionStep.typeLabel) } : {}),
      ...(firstText(definitionStep.method_code, definitionStep.methodCode)
        ? { method_code: firstText(definitionStep.method_code, definitionStep.methodCode) } : {}),
      ...(firstText(definitionStep.method_label, definitionStep.methodLabel)
        ? { method_label: firstText(definitionStep.method_label, definitionStep.methodLabel) } : {}),
      action_type: actionType || 'custom',
    },
    summary: summaryFor(actionType),
    inputs: collectInputs(definitionStep, runtimeStep),
    outcome: {
      kind: profile,
      status: result.status || 'unknown',
      summary: summaryFor(actionType),
      facts: collectFacts(result),
      ...(result.operation_assertion ? { assertion: safeAssertion(result.operation_assertion) } : {}),
    },
  };
  const target = buildTarget(definitionStep, result);
  if (target) operation.target = target;
  return operation;
}

function collectInputs(definitionStep, runtimeStep) {
  const fields = Array.isArray(definitionStep.diagnostic_fields)
    ? definitionStep.diagnostic_fields.filter((field) => field && typeof field === 'object' && field.name)
    : [];
  const descriptors = fields.length
    ? fields.map((field) => ({ key: String(field.name), field }))
    : INPUT_KEYS.map((key) => ({ key, field: null }));
  return descriptors.map(({ key, field }) => {
    const configured = readValue(definitionStep, key);
    const effective = readValue(runtimeStep, key);
    if (configured === undefined && effective === undefined) return null;
    const source = inputSource(key, configured, effective, field);
    return {
      key,
      ...(field?.label ? { label: String(field.label) } : {}),
      role: inputRole(key, field),
      ...(configured !== undefined ? { configured: display(key, configured, definitionStep, field) } : {}),
      ...(effective !== undefined ? { effective: display(key, effective, runtimeStep, field) } : {}),
      ...(source ? { source } : {}),
    };
  }).filter(Boolean);
}

function inputSource(key, configured, effective, field = null) {
  if (typeof configured === 'string' && (/\$\{[^{}]+}/.test(configured) || /\{\{[^{}]+}}/.test(configured))) {
    const reference = configured.match(/\$\{([^{}]+)}/)?.[1]
      || configured.match(/\{\{([^{}]+)}}/)?.[1];
    return sourceObject('variable_reference', reference ? `引用变量：${reference}` : null);
  }
  if (configured !== undefined && effective !== undefined) {
    if (JSON.stringify(configured) !== JSON.stringify(effective)) return sourceObject('runtime');
    return sourceObject(isRestrictedField(key, field) ? 'definition_snapshot' : 'literal');
  }
  if (configured !== undefined) return sourceObject(isRestrictedField(key, field) ? 'definition_snapshot' : 'literal');
  if (effective !== undefined) return sourceObject('runtime');
  return '';
}

function sourceObject(code, label = null) {
  return { code, label: label || SOURCE_LABELS[code] || code };
}

function buildTarget(definitionStep, result) {
  const configured = firstText(
    definitionStep.target_selector,
    definitionStep.target_xpath,
    definitionStep.target_ref,
    definitionStep.locator,
  );
  const actual = firstText(result.locator_value, result.locatorValue);
  const source = firstText(result.locator_source, result.locatorSource);
  if (!configured && !actual && !source) return null;
  return {
    kind: 'element',
    ...(configured ? { configured_summary: safeText(configured) } : {}),
    ...(actual ? { actual_summary: safeText(actual) } : {}),
    ...(source ? { source } : {}),
    ...(result.matched_count != null ? { matched_count: result.matched_count } : {}),
  };
}

function collectFacts(result) {
  return ['reloaded', 'wait_duration_ms', 'implicit_wait_ms', 'previous_implicit_wait_ms', 'exit_code', 'affected_rows',
    'row_count', 'selected_option', 'filename', 'file_count', 'opened_page_url', 'active_page_url']
    .filter((key) => result[key] != null)
    .map((key) => ({
      key,
      ...(RESULT_FACT_LABELS[key] ? { label: RESULT_FACT_LABELS[key] } : {}),
      value: display(key, result[key], {}),
    }));
}

function safeAssertion(assertion) {
  const output = { subject: safeText(assertion.subject || '断言对象'), operator: safeText(assertion.operator || 'equals'), passed: assertion.passed === true };
  for (const key of ['expected', 'actual']) {
    const value = assertion[key];
    if (!value || typeof value !== 'object') continue;
    const state = String(value.value_state || 'visible');
    output[key] = state === 'visible' || state === 'truncated'
      ? { value_state: state, ...(value.preview != null ? { preview: safeText(value.preview) } : {}) }
      : { value_state: state };
  }
  return output;
}

function display(key, value, step, field = null) {
  if (step.value_masked === true || step.value_masked === 1 || SENSITIVE_KEY.test(key)) return { value_state: 'masked' };
  if (field?.result_display === 'basename' || PATH_KEY.test(key)) return { value_state: 'visible', preview: basename(value) };
  if (field?.sensitivity === 'restricted' || field?.result_display === 'definition_endpoint' || RESTRICTED_KEY.test(key)) return { value_state: 'restricted' };
  if (URL_KEY.test(key)) return { value_state: 'visible', preview: safeUrl(value) };
  return { value_state: 'visible', preview: safeText(value) };
}

function inputRole(key, field = null) {
  if (field?.diagnostic_role) return String(field.diagnostic_role);
  if (['target_ref', 'target_selector', 'target_xpath'].includes(key)) return 'target';
  if (['expect', 'regex', 'attribute'].includes(key)) return 'expected';
  if (key === 'variable_name') return 'binding';
  if (RESTRICTED_KEY.test(key)) return 'definition';
  return 'input';
}

function isRestrictedField(key, field = null) {
  return field?.sensitivity === 'restricted'
    || field?.result_display === 'definition_endpoint'
    || RESTRICTED_KEY.test(key);
}

function readValue(step, key) {
  const aliases = {
    target_ref: ['target_ref', 'targetRef', 'target_selector', 'targetSelector', 'target_xpath', 'targetXpath'],
    target_selector: ['target_selector', 'targetSelector', 'target_ref', 'targetRef'],
    target_xpath: ['target_xpath', 'targetXpath'],
    value: ['value', 'input_value', 'inputValue'],
  }[key] || [key];
  return aliases.reduce((value, name) => value === undefined ? step[name] : value, undefined);
}

function summaryFor(actionType) {
  const labels = {
    navigate: '页面导航完成', click: '点击完成', input: '输入完成', select_option: '选项选择完成',
    wait: '固定等待完成', assert_text: '文本检查通过', assert_attribute: '属性检查通过',
    global_variable_set: '全局变量设置完成', evaluate: '脚本执行完成', server_command: '服务器命令执行完成',
    database_sql: '数据库操作完成',
  };
  return labels[actionType] || `动作 ${actionType || 'custom'} 执行完成`;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key) || /^(code|key)$/i.test(key)) url.searchParams.set(key, '******');
    }
    url.username = '';
    url.password = '';
    return safeText(url.toString());
  } catch {
    return safeText(value).replace(/([?&](?:token|key|code|password|secret)=[^&]*)/gi, '$1******');
  }
}

function basename(value) {
  return String(value).split(/[\\/]/).filter(Boolean).at(-1) || String(value);
}

function safeText(value) {
  return String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value)
    .replace(/[\r\n]+/g, ' ').slice(0, 512);
}

function firstText(...values) {
  const value = values.find((item) => item != null && String(item).trim() !== '');
  return value == null ? '' : String(value).trim();
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}
