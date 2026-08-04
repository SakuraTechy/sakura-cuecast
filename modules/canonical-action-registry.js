/**
 * CueCast 可执行的 canonical action 注册表。
 *
 * 这里只登记 PlayerManager 已有实际执行分支的动作。route 用于说明实际边界：
 * - cdp：由 chrome.debugger 直接发送 CDP 命令；
 * - content_player：由现有 content/player.js 执行；
 * - runner_local：仅在本次 CueCast 回放内存中执行变量计算和替换；
 * - cdp_admin：CDP 采集页面数据后由 Admin 完成比对或规划；
 * - admin_infrastructure：只按冻结步骤身份委托 Admin/Agent，绝不把命令或凭据带入浏览器。
 *
 * 该模块不引入 Playwright；CueCast 的浏览器执行始终基于 Chrome CDP 或内容脚本。
 */

// 与 Admin automation-operation-catalog.json 保持一致；版本不匹配时 Admin 会拒绝更新能力快照。
export const OPERATION_CATALOG_VERSION = '2026-07-30.1';

export const CUECAST_ACTION_REGISTRY = Object.freeze([
  { actionType: 'navigate', route: 'content_player' },
  { actionType: 'close_page', route: 'chrome_tabs' },
  { actionType: 'close_all_pages', route: 'chrome_tabs' },
  { actionType: 'reload', route: 'chrome_tabs' },
  { actionType: 'captcha_ocr', route: 'cdp' },
  { actionType: 'switch_page', route: 'chrome_tabs' },
  { actionType: 'frame_switch', route: 'cdp' },
  { actionType: 'frame_parent', route: 'cdp' },
  { actionType: 'frame_main', route: 'cdp' },
  { actionType: 'evaluate', route: 'cdp' },
  { actionType: 'click', route: 'cdp' },
  { actionType: 'double_click', route: 'cdp' },
  { actionType: 'right_click', route: 'cdp' },
  { actionType: 'select_option', route: 'cdp' },
  { actionType: 'combo_select', route: 'cdp' },
  { actionType: 'dialog_accept', route: 'cdp' },
  { actionType: 'dialog_dismiss', route: 'cdp' },
  { actionType: 'dialog_prompt', route: 'cdp' },
  { actionType: 'input', route: 'cdp' },
  { actionType: 'input_date', route: 'cdp' },
  { actionType: 'file_upload', route: 'cdp' },
  { actionType: 'certificate_upload', route: 'cdp' },
  { actionType: 'clear', route: 'cdp' },
  { actionType: 'key', route: 'cdp' },
  { actionType: 'scroll', route: 'cdp' },
  { actionType: 'scroll_to_element', route: 'cdp' },
  { actionType: 'pointer_move', route: 'cdp' },
  { actionType: 'hover', route: 'cdp' },
  { actionType: 'assert_text', route: 'cdp' },
  { actionType: 'assert_text_not', route: 'cdp' },
  { actionType: 'assert_attribute', route: 'cdp' },
  { actionType: 'assert_script', route: 'cdp' },
  { actionType: 'assert_text_regex', route: 'cdp' },
  { actionType: 'wait', route: 'content_player' },
  { actionType: 'implicit_wait', route: 'cdp' },
  { actionType: 'global_variable_set', route: 'runner_local' },
  { actionType: 'global_variable_date', route: 'runner_local' },
  { actionType: 'global_variable_formula', route: 'runner_local' },
  { actionType: 'assert_variable_list', route: 'runner_local' },
  { actionType: 'assert_variable_list_not', route: 'runner_local' },
  { actionType: 'assert_database_value', route: 'runner_local' },
  { actionType: 'assert_json', route: 'cdp_admin' },
  { actionType: 'ai_natural', route: 'cdp_admin' },
  { actionType: 'global_variable_system_info', route: 'admin_infrastructure' },
  { actionType: 'global_variable_available_ip', route: 'admin_infrastructure' },
  { actionType: 'global_variable_property', route: 'admin_infrastructure' },
  { actionType: 'server_command', route: 'admin_infrastructure' },
  { actionType: 'database_sql', route: 'admin_infrastructure' },
  { actionType: 'database_native', route: 'admin_infrastructure' },
  { actionType: 'host_command', route: 'admin_infrastructure' },
  { actionType: 'host_file_lookup', route: 'admin_infrastructure' },
  { actionType: 'host_file_delete', route: 'admin_infrastructure' },
  { actionType: 'host_pointer_move', route: 'admin_infrastructure' },
  { actionType: 'server_file_upload', route: 'admin_infrastructure' },
].map((entry) => Object.freeze(entry)));

export const CUECAST_ACTION_TYPES = new Set(
  CUECAST_ACTION_REGISTRY.map((entry) => entry.actionType),
);

export const CUECAST_CDP_ACTION_TYPES = new Set(
  CUECAST_ACTION_REGISTRY
    .filter((entry) => entry.route === 'cdp')
    .map((entry) => entry.actionType),
);

const actionByType = new Map(CUECAST_ACTION_REGISTRY.map((entry) => [entry.actionType, entry]));

export function normalizeActionType(actionType) {
  return String(actionType || '').trim().toLowerCase();
}

export function isCuecastActionSupported(actionType) {
  return CUECAST_ACTION_TYPES.has(normalizeActionType(actionType));
}

export function isCuecastCdpAction(actionType) {
  return CUECAST_CDP_ACTION_TYPES.has(normalizeActionType(actionType));
}

export function getCuecastActionRoute(actionType) {
  return actionByType.get(normalizeActionType(actionType))?.route || '';
}

/**
 * 返回每次握手使用的新对象，避免调用方修改模块内固定注册表。
 */
export function getCuecastCapabilities({
  executorVersion = 'unknown',
  catalogVersion = OPERATION_CATALOG_VERSION,
  executorInstanceId = '',
  projectEnvironmentId = '',
  sessionId = '',
  features = ['browser', 'cdp'],
} = {}) {
  return {
    executor: 'cuecast',
    executorInstanceId: String(executorInstanceId || '').trim(),
    executorVersion: String(executorVersion || 'unknown').trim() || 'unknown',
    catalogVersion: String(catalogVersion || OPERATION_CATALOG_VERSION).trim(),
    projectEnvironmentId: String(projectEnvironmentId || '').trim(),
    sessionId: String(sessionId || '').trim(),
    actions: [...CUECAST_ACTION_TYPES],
    features: [...features],
  };
}
