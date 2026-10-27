function flag(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function caseId(item) {
  const value = Number(item?.test_case_id ?? item?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function caseName(item, fallback) {
  return String(item?.test_case_name || item?.name || fallback || '');
}

function businessDetail(item, status, result = {}) {
  return {
    kind: 'business',
    test_case_id: caseId(item),
    test_case_name: caseName(item),
    group_name: String(item?.group_name || ''),
    status,
    error: result.error || null,
    test_result_id: result.resultId ?? null,
    result_save_error: result.resultSaveError || null,
  };
}

function loginCaseFromPlan(plan) {
  const id = Number(plan?.login_test_case_id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    test_case_id: id,
    test_case_name: caseName({ test_case_name: plan.login_test_case_name }, '登录用例'),
    group_name: String(plan.login_test_case_group_name || ''),
    start_url: String(plan.login_test_case_start_url || ''),
    viewport_mode: plan.login_test_case_viewport_mode,
    viewport_width: plan.login_test_case_viewport_width,
    viewport_height: plan.login_test_case_viewport_height,
    run_in_incognito: flag(plan.login_test_case_run_in_incognito) ? 1 : 0,
  };
}

function completionMessage({ passed, failed, pending }) {
  return `执行计划完成：通过 ${passed}，失败 ${failed}，未执行 ${pending}`;
}

async function emitProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try { await onProgress(payload); } catch { /* Progress must not interrupt playback. */ }
}

/**
 * Execute one plan using the same sequential semantics as the CueCast page.
 * Browser and API operations are injected so orchestration remains testable.
 */
export async function runExecutionPlan({
  plan,
  playCase,
  openSharedTab,
  closeSharedTab,
  checkLogin,
  saveResult,
  onProgress,
  shouldStop,
  now = Date.now,
}) {
  const items = Array.isArray(plan?.items) ? plan.items.filter((item) => caseId(item) != null) : [];
  const stopOnFailure = flag(plan?.stop_on_failure);
  const loginEnabled = flag(plan?.login_setup_enabled);
  const loginCase = loginEnabled ? loginCaseFromPlan(plan) : null;
  const hasIncognitoCase = items.some((item) => flag(item.run_in_incognito));
  const loginRunsInIncognito = flag(loginCase?.run_in_incognito);
  const startedAt = now();
  const details = [];
  let passed = 0;
  let failed = 0;
  let stopped = false;
  let infrastructureError = false;
  let sharedTabId = null;
  let failureMessage = '';
  const progressTotal = items.length + (loginEnabled ? 1 : 0);

  const reportProgress = (phase, current = {}) => emitProgress(onProgress, {
    phase,
    completed_count: passed + failed,
    total_count: progressTotal,
    passed_count: passed,
    failed_count: failed,
    items: details.map((item) => ({
      kind: item.kind,
      test_case_id: item.test_case_id,
      test_case_name: item.test_case_name,
      status: item.status,
      test_result_id: item.test_result_id,
      error: item.error,
      result_save_error: item.result_save_error,
    })),
    ...current,
  });
  const stopRequested = async () => typeof shouldStop === 'function' && await shouldStop();

  await reportProgress('starting', { message: `正在准备执行计划（0/${progressTotal}）` });

  if (!items.length) {
    stopped = true;
    failureMessage = '执行计划没有可运行的用例';
  } else if (loginEnabled && !loginCase) {
    stopped = true;
    failed = 1;
    failureMessage = '执行计划已启用登录准备，但未配置有效的登录用例';
  } else if (loginEnabled && (hasIncognitoCase || loginRunsInIncognito)) {
    stopped = true;
    failed = 1;
    failureMessage = '计划包含无痕用例时不能复用登录准备会话';
  }

  try {
    if (!stopped && await stopRequested()) {
      stopped = true;
      failureMessage = '执行已取消';
    }
    if (!stopped && !hasIncognitoCase) {
      sharedTabId = await openSharedTab(items[0] || loginCase);
      if (sharedTabId == null) throw new Error('无法创建执行计划回放窗口');
    }

    if (!stopped && loginEnabled) {
      const checkUrl = String(
        plan.login_check_url
        || items[0]?.start_url
        || loginCase.start_url
        || '',
      );
      const selector = String(plan.login_success_selector || '');
      let alreadyLoggedIn = false;
      if (flag(plan.login_skip_if_logged_in, true)) {
        const check = await checkLogin({ tabId: sharedTabId, url: checkUrl, selector });
        alreadyLoggedIn = check?.found === true;
      }

      if (alreadyLoggedIn) {
        await reportProgress('login_setup', {
          completed_count: passed + failed + 1,
          test_case_id: caseId(loginCase),
          status: 'skipped',
          message: '登录状态已就绪，跳过登录准备用例',
        });
      } else {
        await reportProgress('login_setup', {
          test_case_id: caseId(loginCase),
          test_case_name: caseName(loginCase, '登录用例'),
          status: 'running',
          message: '正在执行登录准备用例',
        });
        const loginPlayback = await playCase(loginCase, {
          reuseTabId: sharedTabId,
          kind: 'login_setup',
        });
        if (await stopRequested()) {
          stopped = true;
          failureMessage = '执行已取消';
        } else if (loginPlayback?.ok === false) {
          stopped = true;
          failureMessage = loginPlayback.error || '登录准备用例执行失败';
          infrastructureError = loginPlayback.executionStarted === false;
          if (!infrastructureError) failed += 1;
          details.push({
            kind: 'login_setup',
            test_case_id: caseId(loginCase),
            test_case_name: caseName(loginCase, '登录用例'),
            group_name: String(loginCase.group_name || ''),
            status: infrastructureError ? 'pending' : 'failed',
            error: failureMessage,
            test_result_id: loginPlayback.resultId ?? null,
            result_save_error: loginPlayback.resultSaveError || null,
          });
        } else {
          const verify = await checkLogin({ tabId: sharedTabId, url: checkUrl, selector });
          if (verify?.found !== true) {
            failed += 1;
            stopped = true;
            failureMessage = verify?.error || '登录用例执行后未检测到登录成功状态';
            details.push({
              kind: 'login_setup',
              test_case_id: caseId(loginCase),
              test_case_name: caseName(loginCase, '登录用例'),
              group_name: String(loginCase.group_name || ''),
              status: 'failed',
              error: failureMessage,
              test_result_id: loginPlayback?.resultId ?? null,
              result_save_error: loginPlayback?.resultSaveError || null,
            });
          } else {
            passed += 1;
            details.push({
              kind: 'login_setup',
              test_case_id: caseId(loginCase),
              test_case_name: caseName(loginCase, '登录用例'),
              group_name: String(loginCase.group_name || ''),
              status: 'passed',
              error: null,
              test_result_id: loginPlayback?.resultId ?? null,
              result_save_error: loginPlayback?.resultSaveError || null,
            });
          }
        }
        if (loginPlayback?.resultSaveError && failureMessage !== '执行已取消') {
          infrastructureError = true;
          stopped = true;
          failureMessage = `登录准备用例结果保存失败：${loginPlayback.resultSaveError}`;
        }
        await reportProgress('login_setup', {
          test_case_id: caseId(loginCase),
          status: infrastructureError ? 'error' : (stopped ? 'failed' : 'passed'),
          message: stopped ? failureMessage : '登录准备用例执行完成',
        });
      }
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!stopped && await stopRequested()) {
        stopped = true;
        failureMessage = '执行已取消';
      }
      if (stopped) {
        details.push(businessDetail(item, 'pending'));
        continue;
      }
      await reportProgress('business', {
        case_index: index,
        test_case_id: caseId(item),
        test_case_name: caseName(item),
        status: 'running',
        message: `正在执行用例 ${index + 1}/${items.length}：${caseName(item, `#${caseId(item)}`)}`,
      });
      let playback;
      try {
        playback = await playCase(item, {
          reuseTabId: sharedTabId,
          kind: 'business',
          index,
        });
      } catch (error) {
        playback = { ok: false, error: error?.message || String(error), executionStarted: false };
      }
      if (await stopRequested()) {
        stopped = true;
        failureMessage = '执行已取消';
        details.push(businessDetail(item, 'pending'));
      } else if (playback?.ok === false) {
        if (playback.executionStarted === false) {
          infrastructureError = true;
          stopped = true;
          failureMessage = playback.error || `用例 ${caseName(item, `#${caseId(item)}`)} 无法启动`;
          details.push(businessDetail(item, 'pending', playback));
        } else {
          failed += 1;
          failureMessage ||= playback.error || `用例 ${caseName(item, `#${caseId(item)}`)} 执行失败`;
          details.push(businessDetail(item, 'failed', playback));
          if (stopOnFailure) stopped = true;
        }
      } else {
        passed += 1;
        details.push(businessDetail(item, 'passed', playback));
      }
      if (playback?.resultSaveError && failureMessage !== '执行已取消') {
        infrastructureError = true;
        stopped = true;
        failureMessage = `用例结果保存失败：${playback.resultSaveError}`;
      }
      await reportProgress('business', {
        test_case_id: caseId(item),
        test_case_name: caseName(item),
        status: stopped && failureMessage === '执行已取消' ? 'cancelled' : (infrastructureError ? 'error' : (playback?.ok === false ? 'failed' : 'passed')),
        message: stopped && failureMessage === '执行已取消'
          ? '执行计划已取消'
          : infrastructureError ? failureMessage : `已执行用例 ${index + 1}/${items.length}：${caseName(item, `#${caseId(item)}`)}`,
      });
    }
  } catch (error) {
    stopped = true;
    infrastructureError = true;
    failureMessage = error?.message || String(error);
    let firstPending = true;
    for (const item of items.slice(details.filter((detail) => detail.kind === 'business').length)) {
      details.push(businessDetail(item, 'pending', firstPending ? { error: failureMessage } : {}));
      firstPending = false;
    }
  } finally {
    if (sharedTabId != null) await closeSharedTab(sharedTabId).catch(() => {});
  }

  const duration = Math.max(0, now() - startedAt);
  const pending = details.filter((detail) => detail.kind === 'business' && detail.status === 'pending').length;
  const planResult = await saveResult({
    status: infrastructureError ? 'error' : (stopped ? 'stopped' : 'completed'),
    passed_count: passed,
    failed_count: failed,
    total_count: items.length + details.filter((detail) => detail.kind === 'login_setup').length,
    duration_ms: duration,
    detail: details,
  });
  const ok = failed === 0 && !stopped;
  await reportProgress('finished', {
    completed_count: passed + failed,
    status: ok ? 'succeeded' : 'failed',
    message: infrastructureError ? `执行计划异常：${failureMessage}` : completionMessage({ passed, failed, pending }),
  });
  return {
    ok,
    resultId: planResult?.id ?? null,
    duration,
    error: ok ? '' : (failureMessage || completionMessage({ passed, failed, pending })),
    summary: {
      status: infrastructureError ? 'error' : (stopped ? 'stopped' : 'completed'),
      passed_count: passed,
      failed_count: failed,
      pending_count: pending,
      total_count: items.length + details.filter((detail) => detail.kind === 'login_setup').length,
      detail: details,
    },
    message: infrastructureError ? `执行计划异常：${failureMessage}` : completionMessage({ passed, failed, pending }),
  };
}

export const planRunnerInternals = { flag, caseId, businessDetail, loginCaseFromPlan };
