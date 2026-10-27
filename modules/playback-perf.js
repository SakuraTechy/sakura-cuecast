// Opt-in developer trace. Keep only timings and bounded, sanitized state:
// no URLs, selectors, values, screenshots, or response payloads belong here.
export const PLAYBACK_PERF_ENABLED_KEY = 'cuecastPlaybackPerfEnabled';
export const PLAYBACK_PERF_LAST_KEY = 'cuecastPlaybackPerfLast';

const now = () => performance.now();
const rounded = (value) => Math.round(Math.max(0, value) * 10) / 10;
const diagnosticNumber = (value) => typeof value === 'number' && Number.isFinite(value)
  ? Math.round(Math.max(-1e7, Math.min(1e7, value)) * 10) / 10 : null;
const diagnosticOpacity = (value) => typeof value === 'number' && Number.isFinite(value)
  ? Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000 : null;
const diagnosticRect = (rect) => rect && typeof rect === 'object' ? {
  left: diagnosticNumber(rect.left),
  top: diagnosticNumber(rect.top),
  width: diagnosticNumber(rect.width),
  height: diagnosticNumber(rect.height),
} : null;
const diagnosticStyle = (style) => style && typeof style === 'object' ? {
  display: ['none', 'rendered'].includes(style.display) ? style.display : 'unknown',
  visibility: ['visible', 'hidden', 'other'].includes(style.visibility) ? style.visibility : 'other',
  opacity: diagnosticOpacity(style.opacity),
  effective_opacity: diagnosticOpacity(style.effective_opacity),
  pointer_events: ['none', 'auto', 'other'].includes(style.pointer_events) ? style.pointer_events : 'other',
  z_index: diagnosticNumber(style.z_index),
} : null;
const diagnosticHit = (hit) => hit && typeof hit === 'object' ? {
  viewport_width: diagnosticNumber(hit.viewport_width),
  viewport_height: diagnosticNumber(hit.viewport_height),
  target_rect: diagnosticRect(hit.target_rect),
  blocker_rect: diagnosticRect(hit.blocker_rect),
  blocker_style: diagnosticStyle(hit.blocker_style),
  dropdown_rect: diagnosticRect(hit.dropdown_rect),
  dropdown_style: diagnosticStyle(hit.dropdown_style),
  blocker_owner_found: hit.blocker_owner_found === true,
  blocker_owner_open: typeof hit.blocker_owner_open === 'boolean' ? hit.blocker_owner_open : null,
  target_owner_found: hit.target_owner_found === true,
  target_owner_open: typeof hit.target_owner_open === 'boolean' ? hit.target_owner_open : null,
  same_control: typeof hit.same_control === 'boolean' ? hit.same_control : null,
  open_select_count: Number.isInteger(hit.open_select_count)
    ? Math.max(0, Math.min(1000, hit.open_select_count)) : null,
} : null;
const networkKind = (rawUrl) => {
  let path = '';
  try { path = new URL(String(rawUrl || '')).pathname.toLowerCase(); } catch { return 'other_api'; }
  if (path.endsWith('/datasource/table/listnew')) return 'table_list';
  if (path.endsWith('/constant/ds/tablemappingrule')) return 'table_mapping_rule';
  if (path.endsWith('/datajob/precheck/steptwo')) return 'precheck_step_two';
  return 'other_api';
};
const networkErrorKind = (value) => {
  const error = String(value || '').toLowerCase();
  if (/abort|cancel/.test(error)) return 'aborted';
  if (/timed?_?out/.test(error)) return 'timeout';
  if (/name_not_resolved|dns/.test(error)) return 'dns';
  if (/connection|network_changed|internet_disconnected/.test(error)) return 'connection';
  return 'other';
};

export class PlaybackPerfTrace {
  constructor({ runId, testCaseId, source }) {
    this.runId = String(runId);
    this.testCaseId = Number(testCaseId);
    this.source = String(source || 'web');
    this.startedAt = now();
    this.phases = Object.create(null);
    this.steps = [];
    this.networkRequests = [];
    this.networkRequestsDropped = 0;
    this.pendingNetwork = new Map();
    this.nextNetworkNumber = 1;
    this.scriptExceptions = [];
    this.scriptExceptionsDropped = 0;
    this.networkCaptureEnabled = null;
    this.visiblePageEmulation = 'disabled';
    this.playbackWindow = null;
  }

  notePlaybackWindow(preference, windowInfo) {
    const requestedMode = String(preference?.mode || '');
    const actualState = String(windowInfo?.state || '');
    this.playbackWindow = {
      requested_mode: ['maximized', 'current', 'custom'].includes(requestedMode) ? requestedMode : 'unknown',
      actual_state: ['normal', 'maximized', 'minimized', 'fullscreen'].includes(actualState) ? actualState : 'unknown',
      outer_width: diagnosticNumber(windowInfo?.width),
      outer_height: diagnosticNumber(windowInfo?.height),
      focused: typeof windowInfo?.focused === 'boolean' ? windowInfo.focused : null,
    };
  }

  beginStep(index, action, engine) {
    const step = {
      index,
      action: String(action || 'unknown'),
      engine: String(engine || 'unknown'),
      startedAt: now(),
      phases: Object.create(null),
      nested: Object.create(null),
      nestedCounts: Object.create(null),
      pageStateEvents: [],
      pageStateEventsDropped: 0,
      uncoveredChecks: [],
      uncoveredChecksDropped: 0,
      screenshotBytes: 0,
      screenshotCount: 0,
      status: 'running',
    };
    this.steps.push(step);
    return step;
  }

  async measure(phase, task, step = null, nested = false) {
    const startedAt = now();
    try {
      return await task();
    } finally {
      const target = step ? (nested ? step.nested : step.phases) : this.phases;
      target[phase] = (target[phase] || 0) + (now() - startedAt);
      if (step && nested) step.nestedCounts[phase] = (step.nestedCounts[phase] || 0) + 1;
    }
  }

  endStep(step, status) {
    if (!step || step.endedAt != null) return;
    step.endedAt = now();
    step.status = status;
  }

  noteScreenshot(step, dataUrl) {
    if (!step || !dataUrl) return;
    const payload = (String(dataUrl).split(',', 2)[1] || '').replace(/=+$/, '');
    step.screenshotBytes += Math.floor(payload.length * 3 / 4);
    step.screenshotCount += 1;
  }

  notePageState(step, event, state) {
    if (!step || !state || typeof state !== 'object') return;
    const atMs = rounded(now() - this.startedAt);
    const entry = {
      event: String(event),
      at_ms: atMs,
      last_at_ms: atMs,
      samples: 1,
      loading_ui: typeof state.loading === 'boolean' ? state.loading : null,
      loading_marker: ['none', 'aria_busy', 'ivu_spin', 'ant_spin', 'el_loading', 'next_loading', 'data_loading', 'unknown'].includes(state.loading_marker)
        ? state.loading_marker : 'unknown',
      spinner_marker: ['none', 'ivu_spin', 'ant_spin', 'el_loading', 'next_loading', 'data_loading'].includes(state.spinner_marker)
        ? state.spinner_marker : 'none',
      marker_effectively_visible: typeof state.marker_effectively_visible === 'boolean'
        ? state.marker_effectively_visible : null,
      spinner_effectively_visible: typeof state.spinner_effectively_visible === 'boolean'
        ? state.spinner_effectively_visible : null,
      target_present: typeof state.target_present === 'boolean' ? state.target_present : null,
      visibility_state: ['visible', 'hidden', 'prerender'].includes(state.visibility_state)
        ? state.visibility_state : 'unknown',
      document_has_focus: typeof state.document_has_focus === 'boolean'
        ? state.document_has_focus : null,
    };
    const events = step.pageStateEvents;
    const last = events[events.length - 1];
    if (event === 'loading_poll' && last?.event === event
      && last.loading_ui === entry.loading_ui
      && last.loading_marker === entry.loading_marker
      && last.spinner_marker === entry.spinner_marker
      && last.marker_effectively_visible === entry.marker_effectively_visible
      && last.spinner_effectively_visible === entry.spinner_effectively_visible
      && last.target_present === entry.target_present
      && last.visibility_state === entry.visibility_state
      && last.document_has_focus === entry.document_has_focus) {
      last.last_at_ms = atMs;
      last.samples += 1;
      return;
    }
    // Keep a bounded trace even if a page alternates rapidly between states.
    if (events.length >= 64) {
      events.splice(1, 1);
      step.pageStateEventsDropped += 1;
    }
    events.push(entry);
  }

  noteNetworkStart(tabId, params, stepIndex = null) {
    const type = String(params?.type || '');
    const requestId = String(params?.requestId || '');
    if (!['XHR', 'Fetch'].includes(type) || !requestId) return;
    const key = `${tabId}:${requestId}`;
    if (this.pendingNetwork.has(key)) return;
    const method = String(params?.request?.method || '').toUpperCase();
    const entry = {
      request_no: this.nextNetworkNumber++,
      started_at_ms: rounded(now() - this.startedAt),
      step_index: Number.isInteger(stepIndex) ? stepIndex : null,
      kind: networkKind(params?.request?.url),
      type,
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'other',
      status: null,
      state: 'pending',
    };
    if (this.networkRequests.length >= 80) {
      const removed = this.networkRequests.shift();
      for (const [pendingKey, pending] of this.pendingNetwork) {
        if (pending === removed) this.pendingNetwork.delete(pendingKey);
      }
      this.networkRequestsDropped += 1;
    }
    this.networkRequests.push(entry);
    this.pendingNetwork.set(key, entry);
  }

  noteNetworkResponse(tabId, params) {
    const entry = this.pendingNetwork.get(`${tabId}:${String(params?.requestId || '')}`);
    if (!entry) return;
    const status = Number(params?.response?.status);
    entry.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    entry.response_at_ms = rounded(now() - this.startedAt);
  }

  noteNetworkEnd(tabId, params, failed = false) {
    const key = `${tabId}:${String(params?.requestId || '')}`;
    const entry = this.pendingNetwork.get(key);
    if (!entry) return;
    entry.ended_at_ms = rounded(now() - this.startedAt);
    entry.duration_ms = rounded(entry.ended_at_ms - entry.started_at_ms);
    entry.state = failed ? 'failed' : 'finished';
    if (failed) entry.error_kind = networkErrorKind(params?.errorText);
    const bytes = Number(params?.encodedDataLength);
    if (!failed && Number.isFinite(bytes)) entry.encoded_bytes = Math.round(Math.max(0, Math.min(1e8, bytes)));
    this.pendingNetwork.delete(key);
  }

  noteScriptException(stepIndex, details) {
    const name = String(details?.exception?.className || '');
    const entry = {
      at_ms: rounded(now() - this.startedAt),
      step_index: Number.isInteger(stepIndex) ? stepIndex : null,
      type: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(name) ? name : 'other',
    };
    if (this.scriptExceptions.length >= 16) {
      this.scriptExceptions.shift();
      this.scriptExceptionsDropped += 1;
    }
    this.scriptExceptions.push(entry);
  }

  noteUncoveredCheck(step, check) {
    if (!step || !check || typeof check !== 'object') return;
    const hit = String(check.hit || '').toLowerCase();
    const blocker = !hit ? 'none'
      : /(?:ivu-select-item|el-select-dropdown__item|el-option|ant-select-item-option|\[role="option"\])/.test(hit) ? 'select_option'
      : /(?:select-dropdown|popper|popover)/.test(hit) ? 'dropdown'
      : /(?:loading|spinner)/.test(hit) ? 'loading'
      : /(?:modal|dialog|mask|backdrop)/.test(hit) ? 'modal_or_mask'
      : 'other';
    const via = String(check.via || '');
    const reason = String(check.reason || '');
    const hitTag = hit.match(/^[a-z][a-z0-9-]{0,15}/)?.[0] || '';
    const entry = {
      at_ms: rounded(now() - this.startedAt),
      elapsed_ms: rounded(Number(check.elapsedMs) || 0),
      attempt: Math.max(0, Math.floor(Number(check.attempt) || 0)),
      phase: ['initial', 'loading', 'recheck', 'final'].includes(check.phase) ? check.phase : 'unknown',
      loading_ui: typeof check.loadingUi === 'boolean' ? check.loadingUi : null,
      target_found: typeof check.targetFound === 'boolean' ? check.targetFound : null,
      hit_ok: typeof check.hitOk === 'boolean' ? check.hitOk : null,
      blocker,
      hit_tag: hitTag,
      locator_via: /^[a-z][a-z0-9_-]{0,48}$/.test(via) ? via : 'unknown',
      reason: ['not_found', 'hidden', 'disabled', 'lookup_error', 'loading', 'timeout', 'uncovered'].includes(reason)
        ? reason : '',
      cached_box: check.cachedBox === true,
      hit_sample_age_ms: rounded(Number(check.hitSampleAgeMs) || 0),
      ...(check.hitDiagnostic ? { hit_diagnostic: diagnosticHit(check.hitDiagnostic) } : {}),
    };
    const checks = step.uncoveredChecks;
    if (checks.length >= 64) {
      checks.splice(1, 1);
      step.uncoveredChecksDropped += 1;
    }
    checks.push(entry);
  }

  snapshot(status) {
    const finishedAt = now();
    const phaseMs = (phases) => Object.fromEntries(
      Object.entries(phases).map(([name, value]) => [name, rounded(value)]),
    );
    const stepPhaseTotals = Object.create(null);
    const nestedTotals = Object.create(null);
    const steps = this.steps.map((step) => {
      const wallMs = step.endedAt == null ? finishedAt - step.startedAt : step.endedAt - step.startedAt;
      for (const [name, value] of Object.entries(step.phases)) {
        stepPhaseTotals[name] = (stepPhaseTotals[name] || 0) + value;
      }
      for (const [name, value] of Object.entries(step.nested)) {
        nestedTotals[name] = (nestedTotals[name] || 0) + value;
      }
      const measuredMs = Object.values(step.phases).reduce((sum, value) => sum + value, 0);
      return {
        index: step.index,
        action: step.action,
        engine: step.engine,
        status: step.status,
        wall_ms: rounded(wallMs),
        phase_ms: phaseMs(step.phases),
        nested_ms: phaseMs(step.nested),
        nested_count: { ...step.nestedCounts },
        ...(step.pageStateEvents.length ? {
          page_state_events: step.pageStateEvents.map((event) => ({ ...event })),
          ...(step.pageStateEventsDropped ? { page_state_events_dropped: step.pageStateEventsDropped } : {}),
        } : {}),
        ...(step.uncoveredChecks.length ? {
          uncovered_checks: step.uncoveredChecks.map((check) => ({ ...check })),
          ...(step.uncoveredChecksDropped ? { uncovered_checks_dropped: step.uncoveredChecksDropped } : {}),
        } : {}),
        screenshot_count: step.screenshotCount,
        screenshot_bytes: step.screenshotBytes,
        other_ms: rounded(wallMs - measuredMs),
      };
    });
    const wallMs = finishedAt - this.startedAt;
    const stepWallMs = steps.reduce((sum, step) => sum + step.wall_ms, 0);
    const runPhaseMs = Object.values(this.phases).reduce((sum, value) => sum + value, 0);
    const screenshotBytes = steps.reduce((sum, step) => sum + step.screenshot_bytes, 0);
    return {
      schema: 'cuecast.playback.perf.v1',
      run_id: this.runId,
      test_case_id: this.testCaseId,
      source: this.source,
      status,
      wall_ms: rounded(wallMs),
      phase_ms: phaseMs(this.phases),
      step_wall_total_ms: rounded(stepWallMs),
      other_ms: rounded(wallMs - stepWallMs - runPhaseMs),
      step_phase_totals_ms: phaseMs(stepPhaseTotals),
      nested_totals_ms: phaseMs(nestedTotals),
      screenshot_bytes_total: screenshotBytes,
      network_capture_enabled: this.networkCaptureEnabled,
      visible_page_emulation: this.visiblePageEmulation,
      ...(this.playbackWindow ? { playback_window: this.playbackWindow } : {}),
      ...(this.networkRequests.length ? {
        network_requests: this.networkRequests.map((request) => ({
          ...request,
          ...(request.state === 'pending' ? { pending_age_ms: rounded(finishedAt - this.startedAt - request.started_at_ms) } : {}),
        })),
        ...(this.networkRequestsDropped ? { network_requests_dropped: this.networkRequestsDropped } : {}),
      } : {}),
      ...(this.scriptExceptions.length ? {
        script_exceptions: this.scriptExceptions.map((entry) => ({ ...entry })),
        ...(this.scriptExceptionsDropped ? { script_exceptions_dropped: this.scriptExceptionsDropped } : {}),
      } : {}),
      steps,
    };
  }
}
