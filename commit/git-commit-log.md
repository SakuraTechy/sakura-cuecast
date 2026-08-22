# 2026-08-21 修复 CDP SQL 参数缺少任务定义快照

## 涉及文件

- modules/player-manager.js
- commit/git-commit-log.md

## 变更原因

CDP 基础设施步骤的任务 ID仅写在步骤结果顶层，历史分层详情在部分载荷路径中无法稳定恢复该 ID，导致 Admin 无法请求 SQL 定义快照，执行参数一直显示为“需通过定义快照查看”。

## 变更内容

1. 基础设施步骤诊断 `details` 同步保存 `infrastructure_task_id`，与顶层任务 ID保持兼容。
2. Admin 历史详情可从步骤诊断、嵌套 details 和顶层结果兼容恢复任务 ID，再读取受控 SQL 定义快照。
3. SQL 任务执行失败时也把已创建任务 ID附加到错误结果，确保开启失败后继续的失败步骤仍可读取 SQL 定义。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/*.test.js`：99/99 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
         const details = {
           ...(executorResult?.infrastructure ? { infrastructure: executorResult.infrastructure } : {}),
+          ...(executorResult?.taskId ? { infrastructure_task_id: executorResult.taskId } : {}),
           ...persistedStepDetails,
```

### modules/player-manager.js（失败任务）

```diff
@@
       if (status !== 'passed') {
-        throw new Error(task.errorMessage || task.error || `基础设施任务执行失败：${status}`);
+        const error = new Error(task.errorMessage || task.error || `基础设施任务执行失败：${status}`);
+        error.infrastructureTaskId = taskId;
+        throw error;
       }
```

# 2026-08-21 CDP 失败后继续按通过结果汇总

## 涉及文件

- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更原因

步骤开启“失败后继续”后，CueCast 虽然执行了后续步骤，但仍因保留错误消息把整个用例和批次汇总为失败，与 Playwright Runner 的继续执行语义不一致。

## 变更内容

1. 区分阻断性步骤失败与已配置跳过的步骤失败；只有阻断性失败、手动停止或会话提交失败才会使 CDP 用例失败。
2. 继续执行的失败步骤保持 `skipped` 明细和错误诊断，但用例、批次最终结果可以正常汇总为通过。
3. 更新 CDP 契约测试，验证继续执行后用例结果为通过且跳过步骤仍保留。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/effective-execution-config.test.js --test-name-pattern="CDP 播放步骤开启失败后继续"`：通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+      let blockingStepFailure = false;
@@
-      let success = !errorMsg;
+      // 失败后继续的步骤只记录为 skipped，不阻断用例最终通过；其他步骤失败仍判定用例失败。
+      let success = !blockingStepFailure;
```

### tests/effective-execution-config.test.js

```diff
@@
-    assert.equal(result.ok, false);
+    assert.equal(result.ok, true);
@@
-    assert.equal(savedResult.status, 'failed');
+    assert.equal(savedResult.status, 'passed');
```

# 2026-08-21 CDP 回放支持步骤失败后继续

## 涉及文件

- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更原因

Admin 已保存步骤级“失败后继续”配置，但 CueCast CDP 回放仍会在第一个失败步骤后中断，导致后续步骤无法执行。

## 变更内容

1. CDP 回放统一识别 `continue_on_failure` 和 `continueOnFailure` 两种字段格式，覆盖所有经过 `PlayerManager.start()` 的操作类型。
2. 开启配置的步骤失败后记录为 `skipped` 并保留错误信息，广播“已跳过并继续”日志，然后继续执行后续步骤。
3. 用例最终仍按失败处理，保留首个失败步骤索引，避免把“失败后继续”误报为成功；步骤结果附带 `continue_on_failure` 标记。
4. 增加 CDP 基础设施步骤契约测试，验证失败步骤跳过、后续步骤执行和用例最终失败状态。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/effective-execution-config.test.js --test-name-pattern="CDP 播放步骤开启失败后继续"`：通过。
- `node --test tests/effective-execution-config.test.js`：11/11 通过。
- `node --test tests/*.test.js`：99/99 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+function continueOnFailureEnabled(step) {
+  if (!step || typeof step !== 'object') return false;
+  return enabledFlag(step.continue_on_failure ?? step.continueOnFailure);
+}
@@
-          appendStepResult(runtimeStep, i, 'failed', stepStartedAt, errorMsg, assertionLocator, null, {
+          appendStepResult(runtimeStep, i, shouldContinue ? 'skipped' : 'failed', stepStartedAt, stepErrorMsg, assertionLocator, null, {
@@
+          if (shouldContinue) {
+            broadcastProgress('log', {
+              log: {
+                level: 'warning',
+                phase: 'step',
+                message: `步骤 ${i + 1}: ${runtimeStep.description || runtimeStep.action_type || ''} 执行失败，已跳过并继续执行`,
+              },
+            });
+            continue;
+          }
           break;
```

### tests/effective-execution-config.test.js

```diff
@@
+test('CDP 播放步骤开启失败后继续时跳过当前步骤并执行后续步骤', async () => {
+  assert.equal(result.ok, false);
+  assert.equal(executionCount, 2);
+  assert.equal(savedResult.status, 'failed');
+  assert.deepEqual(
+    savedResult.raw.case_result.steps.map((step) => [step.step_id, step.status]),
+    [['STEP_FAIL', 'skipped'], ['STEP_PASS', 'passed']],
+  );
+  assert.equal(savedResult.raw.case_result.step_fail, 0);
+  assert.equal(savedResult.raw.case_result.step_skip, 1);
+  assert.equal(savedResult.raw.failed_step_index, 0);
+});
```

# 2026-08-17 统一变量引用语法并回传 CDP 保存变量定位器

## 涉及文件

- modules/player-manager.js
- modules/variable-context.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

保存变量步骤和后续引用步骤同时出现 `${name}`、`{{name}}` 两套展示方式，容易让用户误以为必须手工转换。CDP 从页面元素保存变量时虽然已读取到元素值，但步骤结果没有携带实际命中的定位器，导致报告中的候选策略无法标记选中状态。

## 变更内容

1. 新录制和页面提示统一使用 `{{name}}`，CueCast 继续兼容历史 `${name}`，避免旧用例失效。
2. CDP 从页面元素保存变量时返回实际命中的定位器、命中数量和可见数量，并写入公共步骤定位诊断。
3. 增加保存变量定位器契约测试，验证配置来源、CDP 执行通道和录制候选评分均可正确回传。

## 验证

- `node --check modules/player-manager.js`、`node --check modules/variable-context.js`：通过。
- `node --test tests/operation-contract.test.js`：20/20 通过。
- `sakura-admin-ui: pnpm typecheck`：通过。
- `sakura-admin: mvn -pl continew-automation -am "-DskipTests=false" "-Dtest=AutomationInfrastructureRuntimeBindingResolverTest" "-Dsurefire.failIfNoSpecifiedTests=false" test`：3/3 通过，构建成功。

## 具体代码改动

### modules/player-manager.js

```diff
@@
-            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, null, {
+            appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', localResult?.locator || null, null, {
@@
-        value = await this._readVariableFromLocatorCDP(tabId, step);
+        const captured = await this._readVariableFromLocatorCDP(tabId, step);
+        value = captured.value;
+        locator = captured.locator;
@@
-      return { variable };
+      return { variable, ...(locator ? { locator } : {}) };
@@
-      if (v && v.ok && typeof v.value === 'string') return v.value;
+      if (v && v.ok && typeof v.value === 'string') return returnDetails ? v : v.value;
```

### modules/variable-context.js

```diff
@@
- * 与 Playwright Runner 共享 ${name}、${object.key}、${list[0]} 的替换契约，但不依赖 Node API。
+ * 新步骤统一使用 {{name}}、{{object.key}}、{{list[0]}}；历史 ${name} 继续兼容，但不依赖 Node API。
```

### tests/operation-contract.test.js

```diff
@@
+test('CueCast CDP 从页面保存变量时返回实际命中定位器', async () => {
+  const manager = Object.create(PlayerManager.prototype);
+  manager._waitForVariableValueCDP = async () => ({
+    ok: true,
+    value: '防统方系统 - 系统管理平台',
+    via: 'meta-css_fallback',
+    matched_count: 1,
+    visible_count: 1,
+  });
+  const context = new CuecastVariableContext();
+  const result = await manager._executeLocalVariableAction(5, {
+    action_type: 'global_variable_set',
+    variable_name: 'test',
+    source_type: 'locator',
+    target_selector: 'span.user-title',
+    locator_meta: {
+      candidates: [{ type: 'css_fallback', value: 'span.user-title', score: 0.72 }],
+    },
+  }, context);
+
+  assert.equal(result.variable.value_preview, '防统方系统 - 系统管理平台');
+  assert.equal(result.locator.source, 'locator_meta.candidates[0]');
+  assert.equal(result.locator.executionSource, 'cdp:meta-css_fallback');
+  assert.equal(result.locator.recordingScore, 0.72);
+});
```

# 2026-08-17 对齐 CDP 定位来源并保留完整操作输入

## 涉及文件

- modules/player-manager.js
- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

CDP 报告把 `cdp:meta-css_fallback` 作为定位来源，而 Playwright 报告使用 `locator_meta.candidates[0]`，两者实际描述的是执行通道和配置来源两个不同层级。录制候选已经包含 0 到 1 的置信分，但该分数也不能冒充 Playwright 运行时 `semantic-v1` 语义评分。另外，统一操作输入原来只保存 512 字符预览，前端即使增加提示也无法复制完整值。

## 变更内容

1. CDP 公共定位来源统一为 `locator_meta.candidates[index]`、`target_selector` 或 `target_xpath`，原 `cdp:*` 信息独立保存为执行定位通道。
2. CDP 命中录制候选时输出原始候选分数和 `recording_candidate` 类型，报告可明确展示“录制候选评分”。
3. 配置值和执行值保留完整的非敏感文本；断言摘要、结果事实等其他预览仍保持长度限制。
4. 增加 CDP 来源/评分和超过 512 字符完整输入契约测试。

## 验证

- `node --check modules/player-manager.js`、`node --check modules/operation-diagnostics.js`：通过。
- `node --test tests/operation-contract.test.js`：19/19 通过。
- `sakura-playwright: node --test tests/unit/operation-diagnostics.test.js`：15/15 通过。
- `sakura-admin-ui: pnpm typecheck`：通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
   static _actualLocatorFromVia(step, via, matchedCount = 1, visibleCount = null) {
     const source = String(via || '').trim();
     if (!source) return null;
     const candidates = PlayerManager._normalizeLocatorMetaCandidates(step?.locator_meta);
+    const locatorMeta = PlayerManager._parseLocatorMetaObject(step?.locator_meta);
+    const recordedCandidates = Array.isArray(locatorMeta?.candidates) ? locatorMeta.candidates : [];
@@
-    return {
-      source: `cdp:${source}`,
+    const canonicalSource = recordedCandidate
+      ? `locator_meta.candidates[${recordedCandidate.index}]`
+      : source === 'css'
+        ? 'target_selector'
+        : source === 'xpath'
+          ? 'target_xpath'
+          : `cdp:${source}`;
+    const recordingScore = Number(recordedCandidate?.score);
+    return {
+      source: canonicalSource,
+      executionSource: `cdp:${source}`,
       type,
       value,
       matchedCount,
+      ...(visibleCount != null ? { visibleCount } : {}),
+      ...(Number.isFinite(recordingScore) ? { recordingScore } : {}),
@@
       selected: {
         source: actualLocator.source || '',
+        execution_source: actualLocator.executionSource || '',
         type: actualLocator.type || '',
         value: actualLocator.value || '',
         decision: 'ordered-first-match',
+        ...(Number.isFinite(actualLocator.recordingScore)
+          ? { score: actualLocator.recordingScore, score_kind: 'recording_candidate' }
+          : {}),
       },
```

### modules/operation-diagnostics.js

```diff
@@
-      ...(configured !== undefined ? { configured: display(key, configured, definitionStep, field) } : {}),
-      ...(effective !== undefined ? { effective: display(key, effective, runtimeStep, field) } : {}),
+      ...(configured !== undefined ? { configured: display(key, configured, definitionStep, field, false) } : {}),
+      ...(effective !== undefined ? { effective: display(key, effective, runtimeStep, field, false) } : {}),
@@
-function display(key, value, step, field = null) {
+function display(key, value, step, field = null, truncate = true) {
@@
-  return { value_state: 'visible', preview: safeText(value) };
+  const text = truncate ? safeText : fullText;
+  if (URL_KEY.test(key)) return { value_state: 'visible', preview: safeUrl(value, truncate) };
+  if (Array.isArray(value)) return { value_state: 'visible', preview: text(value.join(', ')) };
+  return { value_state: 'visible', preview: text(value) };
@@
 function safeText(value) {
-  return String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value)
-    .replace(/[\r\n]+/g, ' ').slice(0, 512);
+  return fullText(value).slice(0, 512);
+}
+
+function fullText(value) {
+  return String(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value)
+    .replace(/[\r\n]+/g, ' ');
 }
```

### tests/operation-contract.test.js

```diff
@@
-      assert.equal(error.actualLocator.source, 'cdp:meta-css_fallback');
+      assert.equal(error.actualLocator.source, 'locator_meta.candidates[0]');
+      assert.equal(error.actualLocator.executionSource, 'cdp:meta-css_fallback');
+      assert.equal(error.actualLocator.recordingScore, 0.72);
@@
-test('CueCast CDP 输出可验证的定位诊断且不伪造语义评分', () => {
+test('CueCast CDP 显示录制候选评分而不冒充执行语义评分', () => {
@@
+  assert.equal(diagnostics.selected.source, 'locator_meta.candidates[0]');
+  assert.equal(diagnostics.selected.execution_source, 'cdp:meta-css_fallback');
+  assert.equal(diagnostics.selected.score, 0.72);
+  assert.equal(diagnostics.selected.score_kind, 'recording_candidate');
+});
+
+test('CueCast 操作输入保留超过 512 字符的完整配置值和执行值', () => {
+  const longValue = `locator-${'x'.repeat(700)}`;
+  const result = attachOperationDiagnostic(
+    { action_type: 'click', status: 'passed' },
+    { action_type: 'click', target_ref: longValue },
+    { action_type: 'click', target_ref: longValue },
+  );
+  const target = result.details.operation.inputs.find((item) => item.key === 'target_ref');
+  assert.equal(target.configured.preview, longValue);
+  assert.equal(target.effective.preview, longValue);
 });
```

# 2026-08-17 统一变量断言值并补齐 CDP 定位诊断

## 涉及文件

- modules/player-manager.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

CDP 回放在生成统一操作详情时把已经解析变量的运行步骤同时当成配置步骤，导致配置值丢失 `{{变量名}}`；同时 CDP 结果只有扁平定位字段，没有 Playwright 报告所使用的定位诊断结构。报告因此无法一致地区分配置值、解析后的期望值和页面实际值，也无法展示 CDP 的候选定位决策。

## 变更内容

1. CDP 结果使用原始定义步骤生成配置值，使用运行步骤生成执行值，页面读取结果继续单独保存为实际值。
2. CDP 命中定位器后输出候选数量、定位来源、定位类型、定位结果和步骤耗时。
3. CDP 不执行 Playwright 的语义评分，定位诊断不写入虚假 `score`，由报告明确显示“未评分”。
4. 增加变量断言三值契约和 CDP 定位诊断契约测试，并同步目录当前 125 个表单字段基线。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/operation-contract.test.js`：18/18 通过。
- `sakura-playwright: node --test tests/unit/operation-diagnostics.test.js`：14/14 通过。
- `sakura-admin-ui: pnpm typecheck`：通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
       const appendStepResult = (step, index, status, startedAt, error = '', locator = null, executorResult = null, stepDetails = {}) => {
+        const definitionStep = PlayerManager._adaptRecordedStep(steps[index] || step);
@@
-        result = attachOperationDiagnostic(result, step, step, { executor: 'extension-cdp' });
+        result = attachOperationDiagnostic(result, definitionStep, step, { executor: 'extension-cdp' });
@@
+  static _buildCdpLocatorDiagnostics(step, actualLocator, status, durationMs) {
+    if (!actualLocator?.source) return null;
+    const configuredLocators = PlayerManager._normalizeLocatorMetaCandidates(step?.locator_meta);
+    [
+      { type: 'css', value: step?.target_selector },
+      { type: 'xpath', value: step?.target_xpath },
+    ].forEach((candidate) => {
+      const value = String(candidate.value || '').trim();
+      if (value && !configuredLocators.some((item) => item.type === candidate.type && item.value === value)) {
+        configuredLocators.push({ type: candidate.type, value });
+      }
+    });
+    return {
+      version: 1,
+      mode: 'cdp-ordered-candidate',
+      outcome: status === 'passed' ? 'resolved' : 'action-failed',
+      configured_candidate_count: configuredLocators.length,
+      selected: {
+        source: actualLocator.source || '',
+        type: actualLocator.type || '',
+        value: actualLocator.value || '',
+        decision: 'ordered-first-match',
+      },
+      // CDP 当前只返回步骤总耗时，不能伪装成 Playwright 的语义定位等待耗时。
+      wait: { wall_ms: Math.max(0, Number(durationMs) || 0), measurement: 'step_total' },
+    };
+  }
```

### tests/operation-contract.test.js

```diff
@@
-test('CueCast 断言输入执行值使用实际读取结果', () => {
+test('CueCast 变量断言区分配置值、解析后的期望值和页面实际值', () => {
@@
+  assert.equal(expectedInput.configured.preview, '{{test}}1');
+  assert.equal(expectedInput.effective.preview, '防统方系统 - 系统管理平台1');
+  assert.deepEqual(expectedInput.actual, { value_state: 'visible', preview: '防统方系统 - 系统管理平台' });
+  assert.deepEqual(expectedInput.source, { code: 'variable_reference', label: '引用变量：test' });
+});
+
+test('CueCast CDP 输出可验证的定位诊断且不伪造语义评分', () => {
+  const diagnostics = PlayerManager._buildCdpLocatorDiagnostics(
+    {
+      target_selector: 'span.user-title',
+      target_xpath: '/html/body/div[1]/span',
+      locator_meta: {
+        candidates: [
+          { type: 'css_fallback', value: 'span.user-title', score: 0.7 },
+          { type: 'text_exact', value: '{{test}}', score: 0.6 },
+        ],
+      },
+    },
+    {
+      source: 'cdp:meta-css_fallback',
+      type: 'css_fallback',
+      value: 'span.user-title',
+      matchedCount: 1,
+      visibleCount: 1,
+    },
+    'failed',
+    465,
+  );
+  assert.equal(diagnostics.mode, 'cdp-ordered-candidate');
+  assert.equal(diagnostics.outcome, 'action-failed');
+  assert.equal('score' in diagnostics.selected, false);
+  assert.deepEqual(diagnostics.wait, { wall_ms: 465, measurement: 'step_total' });
 });
@@
-  assert.equal(fieldCount, 124);
+  assert.equal(fieldCount, 125);
```

# 2026-08-17 Chrome 不开放证书控制命令时快速失败

## 涉及文件

- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更原因

目标 Chrome 的扩展 debugger 同时过滤 `Security.setIgnoreCertificateErrors` 和 `Security.setOverrideCertificateErrors`。原证书拦截页键盘绕过会让页面变成不可调试目标，最终产生误导性的 `Cannot attach to this target`，不能作为可靠兜底。

## 变更内容

1. 保留 Chrome 实际支持两种 Security 协议时的正常忽略证书能力。
2. 两种协议均不可用时立即停止 CDP 初始化，提示关闭该选项、改用 Playwright Runner 或安装受信任证书。
3. 删除证书拦截页的 `thisisunsafe` 键盘绕过，避免导航后 target 失去调试能力。
4. 将 admin 执行错误从“无法附加”调整为更准确的“无法初始化”，覆盖附加成功但协议初始化失败的情况。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/effective-execution-config.test.js tests/current-profile-batch-session-manager.test.js tests/cdp-batch-session-manager.test.js`：33/33 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
-        } else if (ctx.certificateErrorMode === 'interstitial-bypass') {
-          await this._navigateWithCertificateInterstitialBypass(playTabId, initialNavigationUrl);
         } else {
           await chrome.tabs.update(playTabId, { url: initialNavigationUrl, active: true });
@@
-          throw new Error(`admin 扩展 CDP 无法附加到回放标签页：${ctx.cdpAttachError || '未知错误'}`);
+          throw new Error(`admin 扩展 CDP 无法初始化回放标签页：${ctx.cdpAttachError || '未知错误'}`);
@@
-      // Chrome 扩展 debugger 可能过滤整个证书控制接口；保留 debugger 附加，导航时处理证书拦截页。
-      ctx.certificateErrorMode = 'interstitial-bypass';
-      return;
+      // 证书拦截页会变成扩展不可调试目标，不能用键盘序列规避；直接提示可执行的替代方案。
+      throw new Error(
+        '当前 Chrome 不允许扩展忽略 HTTPS 证书错误，请关闭该选项后重试，或改用 Playwright Runner/安装受信任证书',
+      );
@@
-  async _navigateWithCertificateInterstitialBypass(tabId, url) {
-    const result = await this._cdpSend(tabId, 'Page.navigate', { url });
-    if (!/^net::ERR_CERT_/i.test(String(result?.errorText || ''))) return;
-    await this._waitForTabLoad(tabId);
-    await this._sleep(150);
-    for (const key of 'thisisunsafe') {
-      await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...payload });
-      await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
-    }
-    await this._sleep(250);
-  }
```

### tests/effective-execution-config.test.js

```diff
@@
-test('Chrome debugger 不开放 Security 命令时改用证书拦截页继续访问序列', async () => {
+test('Chrome debugger 不开放 Security 命令时快速失败并提示替代方案', async () => {
@@
-    assert.equal(await player._attachDebugger(42, context), true);
-    assert.equal(context.certificateErrorMode, 'interstitial-bypass');
-    await player._navigateWithCertificateInterstitialBypass(42, 'https://self-signed.example/login');
-    assert.equal(keyDownText, 'thisisunsafe');
+    assert.equal(await player._attachDebugger(42, context), false);
+    assert.match(context.cdpAttachError, /当前 Chrome 不允许扩展忽略 HTTPS 证书错误/);
+    assert.match(context.cdpAttachError, /Playwright Runner\/安装受信任证书/);
+    assert.deepEqual(commands.map((item) => item.method), [
+      'Security.setIgnoreCertificateErrors',
+      'Security.setOverrideCertificateErrors',
+    ]);
+    assert.equal(detachCount, 1);
+    assert.equal(context.debuggerAttached, false);
```

# 2026-08-17 重试尚未就绪的 Chrome debugger target

## 涉及文件

- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更原因

回放窗口创建后，`about:blank` 标签页已经由 tabs/windows API 返回，但 Chrome debugger target 可能仍未注册完成。立即附加会返回 `Cannot attach to this target`，现有单次尝试会直接结束 CDP 执行。

## 变更内容

1. 仅对 `Cannot attach to this target` 和标签页尚未注册错误执行最多四次短间隔重试。
2. 每次重试前确认标签页仍存在，不对“其他 debugger 已附加”等非瞬时错误重试。
3. 区分 debugger 附加失败与附加后的 CDP 初始化失败，便于后续定位真实阶段。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/effective-execution-config.test.js tests/current-profile-batch-session-manager.test.js tests/cdp-batch-session-manager.test.js`：33/33 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
   async _attachDebugger(tabId, ctx) {
+    let attachError = null;
+    for (let attempt = 0; attempt < 4; attempt += 1) {
+      try {
+        await chrome.debugger.attach({ tabId }, '1.3');
+        ctx.debuggerAttached = true;
+        attachError = null;
+        break;
+      } catch (error) {
+        attachError = error;
+        const retryable = /Cannot attach to this target|No tab with given id/i
+          .test(String(error?.message || error));
+        if (!retryable || attempt >= 3) break;
+        // 新建 about:blank 标签页的 debugger target 可能晚于 tabs/windows API 返回，短暂等待后重试。
+        await this._sleep(150 * (attempt + 1));
+        const tab = await chrome.tabs.get(tabId).catch(() => null);
+        if (!tab) break;
+      }
+    }
+    if (!ctx.debuggerAttached) {
+      ctx.cdpAttachError = attachError?.message || String(attachError || '未知错误');
+      return false;
+    }
```

### tests/effective-execution-config.test.js

```diff
@@
+test('新建标签页 target 尚未就绪时有限重试 debugger attach', async () => {
+  const context = { debuggerAttached: false, ignoreHttpsErrors: true };
+  assert.equal(await player._attachDebugger(42, context), true);
+  assert.equal(attachCount, 3);
+  assert.equal(context.debuggerAttached, true);
+});
```

# 2026-08-17 兼容 Chrome debugger 完全禁用证书控制命令

## 涉及文件

- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更原因

目标 Chrome 不仅不支持 `Security.setIgnoreCertificateErrors`，也过滤了旧版 `Security.setOverrideCertificateErrors`。第二层兜底仍会让 debugger 附加失败，CDP 无法进入实际导航。

## 变更内容

1. 两套 Security 命令均返回 `-32601` 时不再中止 debugger 附加，标记为证书拦截页兼容模式。
2. 兼容模式使用 `Page.navigate` 识别 `net::ERR_CERT_*`，确认发生证书错误后才发送 Chrome 内置继续访问序列，避免向正常页面误输入。
3. 增加两套 Security 命令都不可用的契约测试，并验证继续访问序列完整发送。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/effective-execution-config.test.js tests/current-profile-batch-session-manager.test.js tests/cdp-batch-session-manager.test.js`：32/32 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+        } else if (ctx.certificateErrorMode === 'interstitial-bypass') {
+          await this._navigateWithCertificateInterstitialBypass(playTabId, initialNavigationUrl);
@@
+    try {
+      await this._cdpSend(tabId, 'Security.setOverrideCertificateErrors', { override: true });
+    } catch (error) {
+      if (!/wasn't found|not found/i.test(String(error?.message || error))) throw error;
+      // Chrome 扩展 debugger 可能过滤整个证书控制接口；保留 debugger 附加，导航时处理证书拦截页。
+      ctx.certificateErrorMode = 'interstitial-bypass';
+      return;
+    }
@@
+  async _navigateWithCertificateInterstitialBypass(tabId, url) {
+    const result = await this._cdpSend(tabId, 'Page.navigate', { url });
+    if (!/^net::ERR_CERT_/i.test(String(result?.errorText || ''))) return;
+    await this._waitForTabLoad(tabId);
+    for (const key of 'thisisunsafe') {
+      const code = `Key${key.toUpperCase()}`;
+      const windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
+      const payload = {
+        key,
+        code,
+        text: key,
+        unmodifiedText: key,
+        windowsVirtualKeyCode,
+      };
+      await this._cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...payload });
+      await this._cdpSend(tabId, 'Input.dispatchKeyEvent', {
+        type: 'keyUp',
+        key,
+        code,
+        windowsVirtualKeyCode,
+      });
+    }
+  }
```

### tests/effective-execution-config.test.js

```diff
@@
+test('Chrome debugger 不开放 Security 命令时改用证书拦截页继续访问序列', async () => {
+  assert.equal(await player._attachDebugger(42, context), true);
+  assert.equal(context.certificateErrorMode, 'interstitial-bypass');
+  await player._navigateWithCertificateInterstitialBypass(42, 'https://self-signed.example/login');
+  const keyDownText = commands
+    .filter((item) => item.method === 'Input.dispatchKeyEvent' && item.params.type === 'keyDown')
+    .map((item) => item.params.text)
+    .join('');
+  assert.equal(keyDownText, 'thisisunsafe');
+});
```

# 2026-08-17 兼容 Chrome debugger 证书错误协议并调整 CDP 配置布局

## 涉及文件

- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更原因

部分 Chrome 的扩展 debugger 目标不支持 `Security.setIgnoreCertificateErrors`，直接调用会把 CDP 附加误报为失败。CDP 配置中的浏览器和证书开关也需要保持同一行展示。

## 变更内容

1. `Security.setIgnoreCertificateErrors` 不可用时，回退到 `Security.setOverrideCertificateErrors` 与证书错误事件继续处理，避免阻断 debugger 附加。
2. CDP 配置把浏览器选择和“忽略 HTTPS 证书错误”开关放到同一行。
3. 增加旧版 debugger 协议兜底测试。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test tests/effective-execution-config.test.js tests/current-profile-batch-session-manager.test.js tests/cdp-batch-session-manager.test.js`：31/31 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
-      await this._cdpSend(tabId, 'Security.setIgnoreCertificateErrors', {
-        ignore: ctx.ignoreHttpsErrors === true,
-      });
+      await this._configureCertificateErrors(tabId, ctx);
@@
+    // 部分 Chrome 的扩展 debugger 不暴露 setIgnoreCertificateErrors，使用旧版事件协议兜底。
+    await this._cdpSend(tabId, 'Security.setOverrideCertificateErrors', { override: true });
+    const listener = (source, method, params) => {
+      if (source?.tabId !== tabId || method !== 'Security.certificateError') return;
+      void this._cdpSend(tabId, 'Security.handleCertificateError', {
+        eventId: params?.eventId,
+        action: 'continue',
+      });
+    };
```

### tests/effective-execution-config.test.js

```diff
@@
+test('旧版 Chrome debugger 协议使用证书错误事件兜底', async () => {
+  assert.equal(await player._attachDebugger(42, context), true);
+  assert.deepEqual(commands.slice(0, 3), [
+    { method: 'Security.setIgnoreCertificateErrors', params: { ignore: true } },
+    { method: 'Security.setOverrideCertificateErrors', params: { override: true } },
+    { method: 'Page.enable', params: {} },
+  ]);
+});
```

# 2026-08-17 为 CDP 回放接入忽略 HTTPS 证书错误配置

## 涉及文件

- background.js
- modules/player-manager.js
- modules/current-profile-batch-session-manager.js
- modules/cdp-batch-session-manager.js
- tests/effective-execution-config.test.js
- tests/current-profile-batch-session-manager.test.js
- tests/cdp-batch-session-manager.test.js
- commit/git-commit-log.md

## 变更原因

Admin 的 Playwright Runner 已支持“忽略 HTTPS 证书错误”，但 CDP 回放既没有读取批次冻结配置，也是在业务页加载完成后才附加 debugger。自签名或内部 CA 页面会先进入 Chrome 证书错误页，导致 CDP 用例无法执行。

## 变更内容

1. CueCast 从 Admin 冻结的 `ignore_https_errors` 读取证书策略，并随浏览器会话准备参数传递。
2. 当前 Profile 和受控无痕会话在开启该策略时先创建 `about:blank`，再由 Player 附加 debugger、调用 `Security.setIgnoreCertificateErrors`，最后导航业务 URL。
3. 新增当前 Profile、受控无痕会话及 debugger 命令顺序测试，覆盖配置透传和首次导航时序。

## 验证

- 分别执行 `node --check` 检查 `modules/player-manager.js`、`modules/cdp-batch-session-manager.js`、`modules/current-profile-batch-session-manager.js` 和 `background.js`：通过。
- `node --test tests/effective-execution-config.test.js tests/current-profile-batch-session-manager.test.js tests/cdp-batch-session-manager.test.js`：30/30 通过。

## 具体代码改动

### background.js

```diff
@@
-          prepareBrowserSession: ({ startUrl }) => batchSessionManager.prepareCase({
+          prepareBrowserSession: ({ startUrl, ignoreHttpsErrors }) => batchSessionManager.prepareCase({
@@
             startUrl,
+            ignoreHttpsErrors,
```

### modules/player-manager.js

```diff
@@
       browserBootstrapMode: browserBootstrap.mode,
+      ignoreHttpsErrors: enabledFlag(rawEffectiveConfig.ignore_https_errors),
@@
+        cdpAvailable = await this._attachDebugger(playTabId, ctx);
+        if (skipInitialNavigation) {
+          await chrome.tabs.update(playTabId, { active: true });
+        } else {
+          await chrome.tabs.update(playTabId, { url: initialNavigationUrl, active: true });
+        }
@@
       await chrome.debugger.attach({ tabId }, '1.3');
       ctx.debuggerAttached = true;
+      // 必须在业务页面首次导航前设置；否则自签名证书页面会先落入 Chrome 错误页。
+      await this._cdpSend(tabId, 'Security.setIgnoreCertificateErrors', {
+        ignore: ctx.ignoreHttpsErrors === true,
+      });
```

### modules/current-profile-batch-session-manager.js

```diff
@@
-        url: start,
+        // 开关开启时必须先创建空白页，由 Player 附加 CDP 并设置证书策略后再导航。
+        url: ignoreHttpsErrors === true ? 'about:blank' : start,
@@
-        skipInitialNavigation: true,
+        skipInitialNavigation: ignoreHttpsErrors !== true,
+        navigationUrl: start,
```

### modules/cdp-batch-session-manager.js

```diff
@@
-        target = await this.driver.createTarget(contextId, launchUrl, { newWindow: true, background: false });
+        target = await this.driver.createTarget(
+          contextId,
+          ignoreHttpsErrors === true ? 'about:blank' : launchUrl,
+          { newWindow: true, background: false },
+        );
@@
-        skipInitialNavigation: true,
+        skipInitialNavigation: ignoreHttpsErrors !== true,
+        navigationUrl: launchUrl,
```

### tests/effective-execution-config.test.js

```diff
@@
+test('CDP debugger applies HTTPS certificate policy before enabling the page domain', async () => {
+  const context = { debuggerAttached: false, ignoreHttpsErrors: true };
+  assert.equal(await player._attachDebugger(42, context), true);
+  assert.deepEqual(commands.slice(0, 2), [
+    { method: 'Security.setIgnoreCertificateErrors', params: { ignore: true } },
+    { method: 'Page.enable', params: {} },
+  ]);
+});
```

### tests/current-profile-batch-session-manager.test.js

```diff
@@
+test('忽略 HTTPS 证书错误时先创建空白页并交给 Player 导航', async () => {
+  const prepared = await harness.manager.prepareCase({
+    startUrl: 'https://self-signed.example/login',
+    ignoreHttpsErrors: true,
+  });
+  assert.equal(harness.createdWindows[0].url, 'about:blank');
+  assert.equal(prepared.skipInitialNavigation, false);
+});
```

### tests/cdp-batch-session-manager.test.js

```diff
@@
+test('受控会话忽略 HTTPS 证书错误时先创建空白页', async () => {
+  const prepared = await harness.manager.prepareCase({
+    startUrl: 'https://self-signed.example/login',
+    ignoreHttpsErrors: true,
+  });
+  assert.equal(harness.tabs.get(prepared.tabId).url, 'about:blank');
+  assert.equal(prepared.navigationUrl, 'https://self-signed.example/login');
+});
```

# 2026-08-17 展示证书文件名和上传交互事实

## 涉及文件

- modules/operation-diagnostics.js
- modules/player-manager.js
- tests/execution-file-upload.test.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

环境证书在执行前会被物化为包含 `file_name` 的对象引用，原诊断格式化直接对对象执行字符串转换，导致报告显示 `[object Object]`。同时 CDP 上传成功只回传命中定位器，没有返回文件名、文件数量和上传结果，交互结果区域为空。

## 变更内容

1. 证书和文件引用优先提取安全文件名；引用尚未物化时显示环境证书角色，不展示下载地址、本机路径或证书内容。
2. CDP 上传完成后返回文件名、文件数量、上传状态和证书文件列表，并由步骤结果写入统一诊断。
3. 上传交互事实增加中文标签，文件列表使用可读文本展示。
4. 增加证书上传结果和诊断展示契约测试。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --check modules/operation-diagnostics.js`：通过。
- `node --test tests/execution-file-upload.test.js`：10/10 通过。
- `node --test --test-name-pattern="证书角色显示文件名" tests/operation-contract.test.js`：1/1 通过。

## 具体代码改动

### modules/operation-diagnostics.js

```diff
@@
   filename: '文件名',
   file_count: '文件数量',
+  upload_status: '上传结果',
+  certificate_uploaded: '证书上传',
+  uploaded_certificate_files: '已上传证书文件',
@@
-function basename(value) {
-  return String(value).split(/[\\/]/).filter(Boolean).at(-1) || String(value);
+function basename(value) {
+  if (value && typeof value === 'object') {
+    const fileName = value.file_name || value.fileName || value.original_name || value.originalName
+      || value.name || value.path || value.local_path || value.localPath;
+    if (fileName) return basename(fileName);
+    if (value.scope === 'project_environment') {
+      const slot = value.slot_id || value.slotId;
+      return slot ? `环境证书角色（${slot}）` : '环境证书角色';
+    }
+    return safeText(JSON.stringify(value));
+  }
+  const text = String(value);
+  return text.split(/[\\/]/).filter(Boolean).at(-1) || text;
 }
```

### modules/player-manager.js

```diff
@@
+        const operationFacts = locator?.operationFacts && typeof locator.operationFacts === 'object'
+          ? locator.operationFacts
+          : {};
@@
+          ...operationFacts,
@@
-            return PlayerManager._actualLocatorFromVia(step, step?.target_xpath ? 'xpath' : 'css');
+            const fileNames = staged.files.map(PlayerManager._fileNameFromPath);
+            const locator = PlayerManager._actualLocatorFromVia(step, step?.target_xpath ? 'xpath' : 'css');
+            return {
+              ...(locator || {}),
+              operationFacts: {
+                filename: fileNames.length === 1 ? fileNames[0] : fileNames.join(', '),
+                file_count: fileNames.length,
+                upload_status: '上传控件已设置',
+                ...(String(step?.action_type || '').toLowerCase() === 'certificate_upload' ? {
+                  certificate_uploaded: true,
+                  uploaded_certificate_files: fileNames,
+                } : {}),
+              },
+            };
```

### tests/execution-file-upload.test.js

```diff
@@
+test('CDP certificate upload reports filename and interaction result without local path', async () => {
+  const result = await manager._executeFileUploadCDP(5, {
+    action_type: 'certificate_upload',
+    target_selector: '#license-file',
+    certificate_ref: {
+      type: 'admin_execution_file',
+      file_name: '172_19_5_45_audit.lic',
+      download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
+    },
+  });
+  assert.equal(result.operationFacts.filename, '172_19_5_45_audit.lic');
+  assert.equal(result.operationFacts.file_count, 1);
+  assert.equal(result.operationFacts.upload_status, '上传控件已设置');
+  assert.deepEqual(result.operationFacts.uploaded_certificate_files, ['172_19_5_45_audit.lic']);
+  assert.equal(JSON.stringify(result).includes('C:\\Temp'), false);
+});
```

### tests/operation-contract.test.js

```diff
@@
+test('CueCast 证书角色显示文件名并输出上传交互结果', () => {
+  const certificateReference = {
+    type: 'admin_execution_file',
+    asset_id: 123,
+    file_name: '172_19_5_45_audit.lic',
+    download_path: '/automation/playwright/testcases/SCENE/CASE/execution-file',
+  };
+  const result = attachOperationDiagnostic(
+    {
+      action_type: 'certificate_upload',
+      status: 'passed',
+      filename: '172_19_5_45_audit.lic',
+      file_count: 1,
+      upload_status: '上传控件已设置',
+      certificate_uploaded: true,
+      uploaded_certificate_files: ['172_19_5_45_audit.lic'],
+    },
+    { action_type: 'certificate_upload', certificate_ref: certificateReference },
+    { action_type: 'certificate_upload', certificate_ref: certificateReference },
+  );
+  const certificateInput = result.details.operation.inputs.find((item) => item.key === 'certificate_ref');
+  assert.equal(certificateInput.configured.preview, '172_19_5_45_audit.lic');
+  assert.equal(certificateInput.effective.preview, '172_19_5_45_audit.lic');
+});
```

# 2026-08-17 将断言实际值写入执行参数诊断

## 涉及文件

- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

成功断言的 `operation_assertion` 虽然已经生成，但执行参数表仍只读取配置值和运行时期望值。旧目录字段缺少 `role` 时，前端无法稳定识别期望参数，导致“执行值”继续显示预取值。

## 变更内容

1. CueCast 统一诊断把断言实际值写入期望参数的 `actual` 字段，并保留断言判定中的实际值。
2. 管理端报告优先展示参数 `actual`，同时兼容旧目录没有 `role` 的 `expect/regex/attribute` 字段。
3. 增加成功断言执行参数实际值契约测试；Playwright 诊断同步使用同一字段，保持两种执行器协议一致。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test --test-name-pattern="成功断言也保留|断言输入执行值|CDP 断言失败将页面实际值" tests/operation-contract.test.js`：通过。
- `node --test --test-name-pattern="断言详情保留期望值" ../sakura-playwright/tests/unit/operation-diagnostics.test.js`：通过。

## 具体代码改动

### modules/operation-diagnostics.js

```diff
@@
   const profile = String(
     definitionStep.diagnostic_profile || definitionStep.diagnosticProfile || ACTION_PROFILES[actionType] || 'generic',
   );
+  const assertion = result.operation_assertion ? safeAssertion(result.operation_assertion) : null;
@@
-    inputs: collectInputs(definitionStep, runtimeStep),
+    inputs: applyAssertionActual(collectInputs(definitionStep, runtimeStep), profile, assertion),
@@
-      ...(result.operation_assertion ? { assertion: safeAssertion(result.operation_assertion) } : {}),
+      ...(assertion ? { assertion } : {}),
@@
+function applyAssertionActual(inputs, profile, assertion) {
+  if (profile !== 'assertion' || !assertion?.actual || assertion.actual.value_state === 'unavailable') {
+    return inputs;
+  }
+  return inputs.map((input) => {
+    const key = String(input?.key || '').toLowerCase();
+    const expected = input?.role === 'expected' || ['expect', 'regex', 'attribute'].includes(key);
+    return expected ? { ...input, actual: assertion.actual } : input;
+  });
+}
```

### tests/operation-contract.test.js

```diff
@@
+test('CueCast 断言输入执行值使用实际读取结果', () => {
+  const result = attachOperationDiagnostic(
+    { action_type: 'assert_element_match', status: 'passed', operation_assertion: {
+      subject: '指定元素', operator: 'contains',
+      expected: { value_state: 'visible', preview: '上传' },
+      actual: { value_state: 'visible', preview: '上传成功' }, passed: true,
+    } },
+    { action_type: 'assert_element_match', expect: '上传', match_mode: 'contains' },
+  );
+  const expectedInput = result.details.operation.inputs.find((item) => item.key === 'expect');
+  assert.deepEqual(expectedInput.actual, { value_state: 'visible', preview: '上传成功' });
+});
```

# 2026-08-17 补齐 CDP 成功断言的实际值诊断

## 涉及文件

- modules/player-manager.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

CDP 失败断言已经能保存实际值，但成功断言只回传定位器，没有生成 `operation_assertion`。统一报告因此在成功场景仍把期望值显示为执行值，无法在断言配置表中展示真实页面值。

## 变更内容

1. 步骤结果组装兼容从定位器结果中提取成功断言诊断，同时不把无定位器的断言结果误记为元素定位器。
2. CDP 的错误提示、URL、整页文本、元素文本和元素可见断言成功时统一写入实际值。
3. 增加成功断言实际值契约测试。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test --test-name-pattern="五种元素断言|元素断言失败仍保留|成功断言也保留|CDP 断言失败将页面实际值" tests/operation-contract.test.js`：4/4 通过。
- `node --test tests/execution-file-upload.test.js`：9/9 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
-        const { operation_assertion: operationAssertion, ...persistedStepDetails } = normalizedStepDetails;
+        const { operation_assertion: configuredOperationAssertion, ...persistedStepDetails } = normalizedStepDetails;
+        const operationAssertion = configuredOperationAssertion || locator?.operationAssertion;
+        const resultLocator = locator && typeof locator === 'object' && locator.source ? locator : null;
@@
-          ...(locator ? {
-            locator_source: locator.source || '',
+          ...(resultLocator ? {
+            locator_source: resultLocator.source || '',
@@
+  static _buildAssertionDiagnostic(payload) {
+    return {
+      subject: PlayerManager._assertionTargetLabel(payload.target),
+      operator: String(payload.match || 'equals'),
+      expected: { value_state: 'visible', preview: String(payload.expected ?? '') },
+      actual: { value_state: 'visible', preview: String(payload.actual ?? '') },
+      passed: payload.passed === true,
+    };
+  }
@@
+  static _createAssertionResult(locator, payload) {
+    return {
+      ...(locator && typeof locator === 'object' ? locator : {}),
+      operationAssertion: PlayerManager._buildAssertionDiagnostic({ ...payload, passed: true }),
+    };
+  }
@@
-      return actualLocator;
+      return PlayerManager._createAssertionResult(actualLocator, {
+        target: assertion.target,
+        match: assertion.match,
+        expected,
+        actual,
+      });
```

### tests/operation-contract.test.js

```diff
@@
+test('CueCast CDP 成功断言也保留统一实际值', async () => {
+  const manager = Object.create(PlayerManager.prototype);
+  manager._waitForElementAssertionCDP = async () => ({
+    ok: true,
+    visible: true,
+    value: '上传成功',
+    via: 'meta-css_fallback',
+    matched_count: 1,
+    visible_count: 1,
+  });
+  manager._logAssertTextCdpDebug = () => {};
+
+  const result = await manager._executeAssertTextStepCDP(5, {
+    action_type: 'assert_element_match',
+    target_selector: 'p.el-message__content',
+    locator_meta: { candidates: [{ type: 'css_fallback', value: 'p.el-message__content' }] },
+    match_mode: 'contains',
+    expect: '上传',
+  });
+
+  assert.equal(result.operationAssertion.expected.preview, '上传');
+  assert.equal(result.operationAssertion.actual.preview, '上传成功');
+  assert.equal(result.operationAssertion.passed, true);
+  assert.equal(result.type, 'css_fallback');
+});
```

# 2026-08-17 保留失败断言的实际命中定位器

## 涉及文件

- modules/player-manager.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

CDP 元素断言已经找到元素但文本比较失败时，异常只保留期望值和实际值，步骤失败结果的定位器参数固定传入 `null`。Admin 报告因此显示“仅有配置定位器”，无法标识真正读取到文本的候选策略。

## 变更内容

1. 元素文本或可见性断言失败时，把实际命中的定位器附加到断言异常。
2. 步骤失败结果优先上报该定位器，保留来源、类型、值、匹配数量和可见数量。
3. 增加包含、等于、不包含、正则匹配和元素可见五种方式的语义测试，并覆盖失败断言定位器上报。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test --test-name-pattern="五种元素断言|元素断言失败仍保留|CDP 断言失败将页面实际值" tests/operation-contract.test.js`：3/3 通过。
- `node --test tests/execution-file-upload.test.js`：9/9 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+          const assertionLocator = err?.actualLocator && typeof err.actualLocator === 'object'
+            ? err.actualLocator
+            : null;
@@
-          appendStepResult(runtimeStep, i, 'failed', stepStartedAt, errorMsg, null, null, {
+          appendStepResult(runtimeStep, i, 'failed', stepStartedAt, errorMsg, assertionLocator, null, {
@@
+    if (payload.actualLocator && typeof payload.actualLocator === 'object') {
+      error.actualLocator = payload.actualLocator;
+    }
@@
+      const actualLocator = PlayerManager._actualLocatorFromVia(
+        step,
+        result.via,
+        result.matched_count,
+        result.visible_count,
+      );
       const hit = PlayerManager._matchAssertionText(actual, expected, assertion.match);
@@
+          actualLocator,
         });
```

### tests/operation-contract.test.js

```diff
@@
+test('CueCast 五种元素断言匹配方式保持实际值对期望值的比较语义', () => {
+  assert.equal(PlayerManager._matchAssertionText('上传成功', '上传成功1', 'contains'), false);
+  assert.equal(PlayerManager._matchAssertionText('上传成功1', '上传成功', 'contains'), true);
+  assert.equal(PlayerManager._matchAssertionText('上传成功', '上传成功', 'equals'), true);
+  assert.equal(PlayerManager._matchAssertionText('上传成功1', '上传成功', 'equals'), false);
+  assert.equal(PlayerManager._matchAssertionText('上传失败', '成功', 'not_contains'), true);
+  assert.equal(PlayerManager._matchAssertionText('上传成功', '^上传.*成功$', 'regex'), true);
+  assert.deepEqual(
+    PlayerManager._resolveAssertionConfig({ action_type: 'assert_element_match', match_mode: 'visible' }, true),
+    { target: 'element', match: 'visible', readMode: 'auto' },
+  );
+});
@@
+test('CueCast CDP 元素断言失败仍保留实际命中的候选定位器', async () => {
+  const manager = Object.create(PlayerManager.prototype);
+  manager._waitForElementAssertionCDP = async () => ({
+    ok: true,
+    visible: true,
+    value: '上传成功',
+    via: 'meta-css_fallback',
+    matched_count: 1,
+    visible_count: 1,
+  });
+  manager._logAssertTextCdpDebug = () => {};
+
+  await assert.rejects(
+    () => manager._executeAssertTextStepCDP(5, {
+      action_type: 'assert_element_match',
+      target_selector: 'p.el-message__content',
+      target_xpath: '/html/body/div[6]/p',
+      locator_meta: {
+        candidates: [{ type: 'css_fallback', value: 'p.el-message__content' }],
+      },
+      match_mode: 'contains',
+      expect: '上传成功1',
+    }),
+    (error) => {
+      assert.equal(error.actualLocator.source, 'cdp:meta-css_fallback');
+      assert.equal(error.actualLocator.type, 'css_fallback');
+      assert.equal(error.actualLocator.value, 'p.el-message__content');
+      assert.equal(error.actualLocator.matchedCount, 1);
+      assert.equal(error.operationAssertion.actual.preview, '上传成功');
+      return true;
+    },
+  );
+});
```

# 2026-08-17 按批次保存 CDP 临时文件并支持配置清理

## 涉及文件

- modules/api-client.js
- modules/player-manager.js
- background.js
- options/options.html
- options/options.js
- options/options.css
- tests/execution-file-upload.test.js
- commit/git-commit-log.md

## 变更原因

CDP 执行文件原先使用“时间戳-原文件名”，不便于按批次定位和排查。批次结束后是否删除文件也需要由扩展用户控制，同时不能因保留文件而长期保留 Service Worker 的下载跟踪记录。

## 变更内容

1. 有批次 ID 时，证书下载到 Chrome 下载根目录下的 `sakura-cuecast/execution-files/<batchId>/<原文件名>`。
2. 无批次 ID 的旧回放链路继续使用时间戳文件名，避免同名覆盖。
3. 扩展配置页增加“批次结束后自动清理证书临时文件”，默认开启。
4. 关闭自动清理后保留磁盘文件，但仍删除内存与 `chrome.storage.session` 中的批次下载记录。

## 验证

- `node --check background.js; node --check modules/api-client.js; node --check modules/player-manager.js; node --check options/options.js`：通过。
- `node --test tests/execution-file-upload.test.js`：9/9 通过。
- `node --test tests/cdp-batch-session-manager.test.js tests/current-profile-batch-session-manager.test.js`：21/21 通过。

## 具体代码改动

### modules/api-client.js

```diff
@@
-  async downloadExecutionFile(reference, executionCapability = '') {
+  async downloadExecutionFile(reference, executionCapability = '', executionBatchId = '') {
@@
+    const batchId = String(executionBatchId || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
+    const relativePath = batchId && !/^\.+$/.test(batchId)
+      ? `sakura-cuecast/execution-files/${batchId}/${originalName}`
+      : `sakura-cuecast/execution-files/${Date.now()}-${originalName}`;
@@
-      filename: `sakura-cuecast/execution-files/${Date.now()}-${originalName}`,
+      filename: relativePath,
```

### modules/player-manager.js

```diff
@@
-  async cleanupExecutionFiles(batchId) {
+  async cleanupExecutionFiles(batchId, options = {}) {
     const normalizedBatchId = String(batchId || '').trim();
     if (!normalizedBatchId) return;
+    const removeFiles = options.removeFiles !== false;
@@
-    if (!downloadIds.length) return;
-    await Promise.all(downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
+    if (removeFiles && downloadIds.length) {
+      await Promise.all(downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
+    }
@@
-          const downloaded = await this.api.downloadExecutionFile(candidate, executionCapability);
+          const downloaded = await this.api.downloadExecutionFile(candidate, executionCapability, executionBatchId);
```

### background.js

```diff
@@
+  cleanupExecutionFilesOnBatchEnd: true,
 };
@@
+  cleanupExecutionFilesOnBatchEnd: true,
 });
@@
+  state.cleanupExecutionFilesOnBatchEnd = settings.cleanupExecutionFilesOnBatchEnd !== false;
@@
-      await player.cleanupExecutionFiles(message.batchId);
+      await player.cleanupExecutionFiles(message.batchId, {
+        removeFiles: state.cleanupExecutionFilesOnBatchEnd,
+      });
```

### options/options.html

```diff
@@
+      <label class="checkbox-setting">
+        <input id="cleanupExecutionFilesOnBatchEnd" name="cleanupExecutionFilesOnBatchEnd" type="checkbox">
+        <span>
+          <strong>批次结束后自动清理证书临时文件</strong>
+          <small>关闭后，文件保留在 Chrome 下载目录的 <code>sakura-cuecast/execution-files/&lt;batchId&gt;</code> 中。</small>
+        </span>
+      </label>
```

### options/options.js

```diff
@@
+  cleanupExecutionFilesOnBatchEnd: true,
 });
@@
+  cleanupExecutionFilesOnBatchEnd: document.getElementById('cleanupExecutionFilesOnBatchEnd'),
@@
+    cleanupExecutionFilesOnBatchEnd: raw.cleanupExecutionFilesOnBatchEnd !== false,
@@
+  refs.cleanupExecutionFilesOnBatchEnd.checked = settings.cleanupExecutionFilesOnBatchEnd;
@@
+    cleanupExecutionFilesOnBatchEnd: refs.cleanupExecutionFilesOnBatchEnd.checked,
```

### options/options.css

```diff
@@
+.checkbox-setting {
+  grid-template-columns: 18px 1fr;
+  align-items: start;
+  cursor: pointer;
+}
+
+.checkbox-setting input {
+  width: 18px;
+  height: 18px;
+  margin: 2px 0 0;
+  accent-color: var(--primary);
+}
+
+.checkbox-setting > span {
+  display: grid;
+  gap: 4px;
+}
```

### tests/execution-file-upload.test.js

```diff
@@
-    }, 'execution-capability-token');
+    }, 'execution-capability-token', 'batch-20260817-001');
@@
+    assert.equal(downloadOptions.filename, 'sakura-cuecast/execution-files/batch-20260817-001/client.lic');
@@
-    async downloadExecutionFile() {
+    async downloadExecutionFile(_reference, _capability, batchId) {
+      assert.equal(batchId, 'batch-retain');
       return { downloadId: 94, localPath: 'C:\\Temp\\client.lic' };
@@
+test('CDP batch cleanup can retain files while clearing persisted tracking', async () => {
+  const originalChrome = globalThis.chrome;
+  const sessionState = {};
+  globalThis.chrome = downloadChrome();
+  globalThis.chrome.storage = {
+    session: {
+      async get() {
+        return sessionState;
+      },
+      async set(value) {
+        Object.assign(sessionState, value);
+      },
+    },
+  };
+  const cleanupIds = [];
+  const api = {
+    async cleanupExecutionFile(downloadId) {
+      cleanupIds.push(downloadId);
+    },
+  };
+  try {
+    const manager = new PlayerManager({}, api);
+    await manager._registerExecutionFileDownloads('batch-keep-files', [95]);
+    await manager.cleanupExecutionFiles('batch-keep-files', { removeFiles: false });
+
+    assert.deepEqual(cleanupIds, []);
+    assert.deepEqual(sessionState.cuecastExecutionFileDownloadsByBatch, {});
+  } finally {
+    globalThis.chrome = originalChrome;
+  }
+});
```

# 2026-08-17 修复 CDP 断言报告缺少页面实际值

## 涉及文件

- modules/player-manager.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

CDP 元素断言失败时，页面实际文本仅拼接到错误消息，未进入统一操作诊断。Admin 报告因此只能在“断言配置”中展示运行时解析后的期望值，无法生成包含真实实际值的“断言判定”。

## 变更内容

1. CDP 文本断言失败对象附带结构化 `operationAssertion`，分别保存断言对象、匹配方式、期望值、实际值和判定结果。
2. 步骤失败结果将该结构传给 `attachOperationDiagnostic`，生成 `details.operation.outcome.assertion` 后移除内部临时字段。
3. 增加证书上传失败提示场景的契约测试，验证报告实际值为页面返回文本。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --test --test-name-pattern="CDP 断言失败将页面实际值" tests/operation-contract.test.js`：1/1 通过。
- 完整 `tests/operation-contract.test.js`：本次新增用例通过；现有目录字段计数断言仍为 124，而当前目录实际为 125，结果为 11/12，通过项之外的失败与本次修复无关。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+        const normalizedStepDetails = stepDetails && typeof stepDetails === 'object' ? stepDetails : {};
+        const { operation_assertion: operationAssertion, ...persistedStepDetails } = normalizedStepDetails;
         const details = {
           ...(executorResult?.infrastructure ? { infrastructure: executorResult.infrastructure } : {}),
-          ...(stepDetails && typeof stepDetails === 'object' ? stepDetails : {}),
+          ...persistedStepDetails,
         };
@@
+          ...(operationAssertion && typeof operationAssertion === 'object' ? { operation_assertion: operationAssertion } : {}),
@@
+          const operationAssertion = err?.operationAssertion && typeof err.operationAssertion === 'object'
+            ? err.operationAssertion
+            : null;
@@
+            ...(operationAssertion ? { operation_assertion: operationAssertion } : {}),
@@
+  static _createAssertionFailureError(payload) {
+    const error = new Error(PlayerManager._formatAssertionFailure(payload));
+    // 错误文本用于日志；结构化字段用于报告准确区分期望值和页面实际值。
+    error.operationAssertion = {
+      subject: PlayerManager._assertionTargetLabel(payload.target),
+      operator: String(payload.match || 'equals'),
+      expected: { value_state: 'visible', preview: String(payload.expected ?? '') },
+      actual: { value_state: 'visible', preview: String(payload.actual ?? '') },
+      passed: false,
+    };
+    return error;
+  }
@@
-        throw new Error(PlayerManager._formatAssertionFailure({
+        throw PlayerManager._createAssertionFailureError({
```

### tests/operation-contract.test.js

```diff
@@
+test('CueCast CDP 断言失败将页面实际值写入统一诊断详情', () => {
+  const failure = PlayerManager._createAssertionFailureError({
+    target: 'element',
+    match: 'contains',
+    expected: '上传成功',
+    actual: '网卡校验异常，请重新申请证书',
+    css: 'p.el-message__content',
+    xpath: '/html/body/div[6]/p',
+  });
+  const result = attachOperationDiagnostic(
+    {
+      action_type: 'assert_element_match',
+      status: 'failed',
+      error: failure.message,
+      operation_assertion: failure.operationAssertion,
+    },
+    {
+      action_type: 'assert_element_match',
+      expect: '上传成功',
+      match_mode: 'contains',
+      target_selector: 'p.el-message__content',
+    },
+  );
+
+  assert.equal(result.details.operation.outcome.assertion.expected.preview, '上传成功');
+  assert.equal(result.details.operation.outcome.assertion.actual.preview, '网卡校验异常，请重新申请证书');
+  assert.equal(result.details.operation.outcome.assertion.passed, false);
+  assert.equal('operation_assertion' in result, false);
+});
```

# 2026-08-14 延迟 CDP 执行文件到批次结束清理

## 涉及文件

- modules/player-manager.js
- background.js
- tests/execution-file-upload.test.js
- commit/git-commit-log.md

## 变更原因

`DOM.setFileInputFiles` 设置的是文件控件状态，页面可能在后续步骤或表单提交时才真正读取文件。原实现按步骤 `finally` 删除下载文件，可能导致网页提交阶段找不到证书文件。

## 变更内容

1. 带批次 ID 的 Admin 执行文件下载记录到批次，不再在步骤结束时删除。
2. `END/ABORT` 成功后统一清理该批次所有下载文件。
3. 下载 ID 写入 `chrome.storage.session`，Service Worker 重启后仍可清理。
4. 无批次的旧本地回放链路继续按步骤清理。

## 验证

- `node --check modules/player-manager.js; node --check background.js`：通过。
- `node --test tests/cdp-batch-session-manager.test.js tests/current-profile-batch-session-manager.test.js tests/execution-file-upload.test.js`：29/29 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+    /** Admin 执行文件按批次保留到 END/ABORT，避免网页后续提交时文件已被删除。 */
+    this._executionFileDownloadsByBatch = new Map();
@@
+  async cleanupExecutionFiles(batchId) {
+    const normalizedBatchId = String(batchId || '').trim();
+    if (!normalizedBatchId) return;
+    const session = chrome.storage?.session;
+    const stored = session?.get
+      ? await session.get(EXECUTION_FILE_DOWNLOADS_KEY).catch(() => ({}))
+      : {};
+    const persisted = stored?.[EXECUTION_FILE_DOWNLOADS_KEY] || {};
+    const downloadIds = [...new Set([
+      ...(this._executionFileDownloadsByBatch.get(normalizedBatchId) || []),
+      ...(persisted[normalizedBatchId] || []),
+    ])];
+    if (!downloadIds.length) return;
+    await Promise.all(downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
+    this._executionFileDownloadsByBatch.delete(normalizedBatchId);
+  }
@@
-    const staged = await this._stageFilePathsFromStep(step, executionCapability);
+    const staged = await this._stageFilePathsFromStep(step, executionCapability, executionBatchId);
@@
+      if (String(executionBatchId || '').trim()) {
+        await this._registerExecutionFileDownloads(executionBatchId, downloadIds);
+        return { files, downloadIds: [] };
+      }
```

### background.js

```diff
@@
+function finishPlaybackBatch(batchManager, method, message, sourceTabId) {
+  return batchManager[method](message.batchId, message.executionCapability, sourceTabId)
+    .then(async (response) => {
+      // 网页可能在步骤结束后才真正提交文件，必须等批次成功结束再删除下载文件。
+      await player.cleanupExecutionFiles(message.batchId);
+      return response;
+    });
+}
@@
-        : cdpBatchSessions).endBatch(message.batchId, message.executionCapability, tabId)
+        : cdpBatchSessions, 'endBatch', message, tabId)
@@
-        : cdpBatchSessions).abortBatch(message.batchId, message.executionCapability, tabId)
+        : cdpBatchSessions, 'abortBatch', message, tabId)
```

### tests/execution-file-upload.test.js

```diff
@@
+test('CDP execution file remains until batch cleanup, including Service Worker restart', async () => {
+  const originalChrome = globalThis.chrome;
+  const sessionState = {};
+  globalThis.chrome = downloadChrome();
+  globalThis.chrome.storage = {
+    session: {
+      async get() {
+        return sessionState;
+      },
+      async set(value) {
+        Object.assign(sessionState, value);
+      },
+    },
+  };
+  const cleanupIds = [];
+  const api = {
+    async downloadExecutionFile() {
+      return { downloadId: 94, localPath: 'C:\\Temp\\client.lic' };
+    },
+    async cleanupExecutionFile(downloadId) {
+      cleanupIds.push(downloadId);
+    },
+  };
+  try {
+    const manager = new PlayerManager({}, api);
+    await manager._executeFileUploadCDP(5, {
+      action_type: 'certificate_upload',
+      target_selector: '#license-file',
+      certificate_ref: {
+        type: 'admin_execution_file',
+        download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
+      },
+    }, 'capability', 'batch-retain');
+    assert.deepEqual(cleanupIds, []);
+
+    const restartedManager = new PlayerManager({}, api);
+    await restartedManager.cleanupExecutionFiles('batch-retain');
+    assert.deepEqual(cleanupIds, [94]);
+    assert.deepEqual(sessionState.cuecastExecutionFileDownloadsByBatch, {});
+  } finally {
+    globalThis.chrome = originalChrome;
+  }
+});
```

# 2026-08-14 修复 CDP 上传时文件控件节点失效

## 涉及文件

- modules/player-manager.js
- tests/execution-file-upload.test.js
- commit/git-commit-log.md

## 变更原因

动态页面在定位文件控件后可能立即重渲染，旧实现把 `DOM.describeNode` 返回的 `nodeId` 传给 `DOM.setFileInputFiles`，此时 Chrome 会返回 `Could not find node with given id` 并直接结束步骤。

## 变更内容

1. 文件上传改用本轮 `Runtime.evaluate` 返回的 `objectId`，避免额外复用易失效的 `nodeId`。
2. 仅对节点或对象失效的 CDP 协议错误重新定位并重试，其他错误仍立即返回。
3. 新增首次节点失效、第二次重新定位成功并清理临时文件的测试。

## 验证

- `node --test tests/execution-file-upload.test.js`：7/7 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+  /** 页面异步重渲染会使 DOM nodeId/objectId 失效，文件上传可重新定位后安全重试。 */
+  static _isCdpStaleFileInputError(err) {
+    const message = String(err?.message || err).toLowerCase();
+    return message.includes('could not find node with given id')
+      || message.includes('could not find object with given id');
+  }
@@
-          await this._cdpSend(tabId, 'DOM.setFileInputFiles', { nodeId: node.nodeId, files: staged.files });
-          return PlayerManager._actualLocatorFromVia(step, step?.target_xpath ? 'xpath' : 'css');
+            await this._cdpSend(tabId, 'DOM.setFileInputFiles', { objectId, files: staged.files });
+            return PlayerManager._actualLocatorFromVia(step, step?.target_xpath ? 'xpath' : 'css');
+          } catch (error) {
+            if (!PlayerManager._isCdpStaleFileInputError(error)) throw error;
+            lastError = '文件控件在上传时已刷新，正在重新定位';
+          }
```

### tests/execution-file-upload.test.js

```diff
@@
+test('CDP upload re-locates file input when its DOM node is refreshed', async () => {
+  const originalChrome = globalThis.chrome;
+  globalThis.chrome = downloadChrome();
+  const cleanupIds = [];
+  let uploadAttempts = 0;
+  const api = {
+    async downloadExecutionFile() {
+      return { downloadId: 89, localPath: 'C:\\Temp\\client.lic' };
+    },
+    async cleanupExecutionFile(downloadId) {
+      cleanupIds.push(downloadId);
+    },
+  };
+  try {
+    const manager = new PlayerManager({}, api);
+    manager._cdpSend = async (_tabId, method, params) => {
+      if (method === 'Runtime.evaluate') return { result: { objectId: `input-${uploadAttempts + 1}` } };
+      if (method === 'DOM.describeNode') {
+        return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
+      }
+      if (method === 'DOM.setFileInputFiles') {
+        uploadAttempts += 1;
+        if (uploadAttempts === 1) {
+          throw new Error('{"code":-32000,"message":"Could not find node with given id"}');
+        }
+        assert.equal(params.objectId, 'input-2');
+        return {};
+      }
+      return {};
+    };
+
+    await manager._executeFileUploadCDP(5, {
+      action_type: 'certificate_upload',
+      target_selector: '#license-file',
+      certificate_ref: {
+        type: 'admin_execution_file',
+        download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
+      },
+    });
+
+    assert.equal(uploadAttempts, 2);
+    assert.deepEqual(cleanupIds, [89]);
+  } finally {
+    globalThis.chrome = originalChrome;
+  }
+});
```

# 2026-08-14 完善 CDP 环境证书引用解析与失败清理

## 涉及文件

- modules/player-manager.js
- tests/execution-file-upload.test.js
- commit/git-commit-log.md

## 变更原因

Admin 返回的环境证书下载引用可能经过 JSON 序列化，或因兼容链路缺少 `type` 字段。原实现会把这类引用当作普通文件路径，最终报“缺少 file_ref 本机绝对路径”。同时，下载成功但路径无效时需要清理 Chrome 临时文件。

## 变更内容

1. CDP 暂存流程支持 JSON 字符串形式和带 `download_path` 的 Admin 下载引用。
2. 未被 Admin 物化的环境资源引用输出明确错误，避免误报本机路径错误。
3. 下载后继续使用统一路径校验；暂存或路径校验失败时清理已下载文件。
4. 新增三项解析、未物化引用和无效本机路径清理测试。

## 验证

- `node --test tests/execution-file-upload.test.js`：6/6 通过。

## 具体代码改动

### modules/player-manager.js

```diff
@@
-    for (const candidate of candidates) {
+    try {
+      for (const rawCandidate of candidates) {
+        const candidate = PlayerManager._parseFileReference(rawCandidate);
+        if (candidate && typeof candidate === 'object' && candidate.download_path) {
+          const downloaded = await this.api.downloadExecutionFile(candidate, executionCapability);
+          downloadIds.push(downloaded.downloadId);
+          localCandidates.push(downloaded.localPath);
+        } else if (candidate && typeof candidate === 'object'
+          && candidate.scope === 'project_environment') {
+          throw new Error(`${actionType || 'file_upload'} 的环境文件引用未由 Admin 物化为下载引用`);
+        }
+      }
+    } catch (error) {
+      await Promise.all(downloadIds.map((id) => this.api.cleanupExecutionFile(id)));
+      throw error;
```

### tests/execution-file-upload.test.js

```diff
@@
+test('CDP staging accepts serialized Admin execution file reference without type field', async () => {
+  const originalChrome = globalThis.chrome;
+  globalThis.chrome = downloadChrome();
+  const cleanupIds = [];
+  const api = {
+    async downloadExecutionFile(reference) {
+      assert.equal(reference.download_path, '/automation/playwright/testcases/100/CASE_001/execution-files/STEP_CERT');
+      return { downloadId: 92, localPath: 'C:\\Temp\\client.lic' };
+    },
+    async cleanupExecutionFile(downloadId) {
+      cleanupIds.push(downloadId);
+    },
+  };
+  try {
+    const manager = new PlayerManager({}, api);
+    const staged = await manager._stageFilePathsFromStep({
+      action_type: 'certificate_upload',
+      certificate_ref: JSON.stringify({
+        download_path: '/automation/playwright/testcases/100/CASE_001/execution-files/STEP_CERT',
+        file_name: 'client.lic',
+      }),
+    });
+
+    assert.deepEqual(staged.files, ['C:\\Temp\\client.lic']);
+    assert.deepEqual(staged.downloadIds, [92]);
+    assert.deepEqual(cleanupIds, []);
+  } finally {
+    globalThis.chrome = originalChrome;
+  }
+});
+
+test('CDP staging reports unmaterialized environment certificate reference', async () => {
+  const originalChrome = globalThis.chrome;
+  globalThis.chrome = downloadChrome();
+  try {
+    const manager = new PlayerManager({}, {});
+
+    await assert.rejects(() => manager._stageFilePathsFromStep({
+      action_type: 'certificate_upload',
+      certificate_ref: {
+        scope: 'project_environment',
+        kind: 'certificate',
+        slot_id: '878671771996430365',
+      },
+    }), /环境文件引用未由 Admin 物化为下载引用/);
+  } finally {
+    globalThis.chrome = originalChrome;
+  }
+});
```

# 2026-08-14 支持环境证书受控下载后执行 CDP 上传

## 涉及文件

- modules/api-client.js
- modules/player-manager.js
- tests/execution-file-upload.test.js
- commit/git-commit-log.md

## 变更原因

Admin 与 Playwright Runner 部署在远程执行环境，CueCast CDP 在用户电脑的 Chrome 中执行。环境证书不能把 Runner 路径直接交给 Chrome，必须通过 Admin 的批次受控下载接口传输到扩展所在电脑，并在上传完成或失败后清理本机临时文件。下载接口同时要求短期 `executionCapability`，不能写入步骤 JSON 或下载 URL。

## 变更内容

1. 执行文件下载请求同时携带 Admin 登录令牌和 `X-Execution-Capability`。
2. PlayerManager 将当前批次 capability 传入证书暂存流程，下载完成后再调用 `DOM.setFileInputFiles`。
3. 无论 CDP 上传成功或失败，均在 `finally` 中清理 Chrome 下载记录和本机临时文件。
4. 新增下载成功、下载失败和 CDP 上传失败清理测试。

## 验证

- `node --test tests/execution-file-upload.test.js`：3/3 通过。
- `node --test tests/*.test.js`：76/76 通过。

## 具体代码改动

### modules/api-client.js

```diff
@@
-  async downloadExecutionFile(reference) {
+  async downloadExecutionFile(reference, executionCapability = '') {
@@
+    const capability = String(executionCapability || '').trim();
@@
-      ...(token ? { headers: [{ name: 'Authorization', value: `Bearer ${token}` }] } : {}),
+      ...(token || capability ? {
+        headers: [
+          ...(token ? [{ name: 'Authorization', value: `Bearer ${token}` }] : []),
+          ...(capability ? [{ name: 'X-Execution-Capability', value: capability }] : []),
+        ],
+      } : {}),
```

### modules/player-manager.js

```diff
@@
               actualLocator = await this._executeStepCDP(playTabId, executableStep, targetUrl, ctx.locale, runtimeNextStep, {
                 beforeActionScreenshot: captureCurrentStep,
+                executionCapability: ctx.executionCapability,
               });
@@
-  async _executeFileUploadCDP(tabId, step) {
-    const staged = await this._stageFilePathsFromStep(step);
+  async _executeFileUploadCDP(tabId, step, executionCapability = '') {
+    const staged = await this._stageFilePathsFromStep(step, executionCapability);
@@
-        const downloaded = await this.api.downloadExecutionFile(candidate);
+        const downloaded = await this.api.downloadExecutionFile(candidate, executionCapability);
```

### tests/execution-file-upload.test.js

```diff
@@
+test('Admin execution file downloads to a local path with execution capability header', async () => {
+  const client = new ApiClient(() => 'http://admin.local', () => 'admin-token');
+  const result = await client.downloadExecutionFile({
+    type: 'admin_execution_file',
+    download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file?projectEnvironmentId=7',
+    file_name: 'client.lic',
+  }, 'execution-capability-token');
+  assert.deepEqual(result, { downloadId: 71, localPath: 'C:\\Temp\\client.lic' });
+});
+
+test('Admin execution file download failure is reported', async () => {
+  const client = new ApiClient(() => 'http://admin.local', () => '');
+  await assert.rejects(() => client.downloadExecutionFile({
+    download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
+  }, 'capability'), /NETWORK_FAILED/);
+});
+
+test('CDP upload failure still cleans the staged execution file', async () => {
+  await assert.rejects(() => manager._executeFileUploadCDP(5, {
+    action_type: 'certificate_upload',
+    target_selector: '#license-file',
+    certificate_ref: {
+      type: 'admin_execution_file',
+      download_path: '/automation/playwright/testcases/SCENE/CASE/steps/STEP/execution-file',
+    },
+  }, 'execution-capability-token'), /CDP upload failed/);
+  assert.deepEqual(cleanupIds, [88]);
+});
```

# 2026-08-13 兼容模式改为新建普通 Chrome 回放窗口

## 涉及文件

- modules/current-profile-batch-session-manager.js
- tests/current-profile-batch-session-manager.test.js
- ../sakura-admin-ui/src/views/automation/automationUiScene/components/AutomationExecutionCaseModal.vue
- ../sakura-admin-ui/src/views/test/testPlan/index.vue
- ../docs/cdp-playback-case-session-modes-implementation-plan.md
- commit/git-commit-log.md

## 变更原因

兼容模式需要以独立浏览器窗口运行，避免回放标签页与 Admin 当前窗口混在一起。窗口仍属于用户当前 Chrome Profile，保留登录态和下载设置，但不是无痕窗口。

## 变更内容

1. `legacy-profile` 批次首次回放改为 `chrome.windows.create` 新建普通窗口。
2. 后续用例继续复用该窗口的最终活动页；失败后关闭受控页签，并在下一条用例创建新的普通回放窗口。
3. Service Worker 恢复时用 `managedWindowId + activeTabId` 证明新窗口首个标签页的归属；无法证明时不关闭页面。
4. 场景执行、测试计划和实施方案同步改为“新建普通 Chrome 回放窗口”。

## 验证

- `node --test tests/current-profile-batch-session-manager.test.js`：通过。
- `node --check modules/current-profile-batch-session-manager.js`：通过。
- admin-ui `pnpm run typecheck`：通过。
- `git diff --check`：通过。

## 具体代码改动

### modules/current-profile-batch-session-manager.js

```diff
@@
- * 管理普通 Chrome Profile 中的批次回放标签页。
+ * 管理普通 Chrome Profile 中的批次回放窗口。
@@
-      activeTab = await this.chrome.tabs.create({
-        windowId: this.batch.sourceWindowId,
-        openerTabId: this.batch.sourceTabId,
+      const playbackWindow = await this.chrome.windows.create({
         url: start,
-        active: true,
+        focused: true,
       });
+      activeTab = playbackWindow?.tabs?.[0];
+      this.batch.managedWindowId = Number(playbackWindow.id ?? activeTab.windowId);
```

### tests/current-profile-batch-session-manager.test.js

```diff
@@
-test('当前 Profile 批次在 Admin 普通窗口创建标签页并连续复用', async () => {
+test('当前 Profile 批次创建普通浏览器窗口并连续复用', async () => {
@@
+      async create(createData) {
+        const windowId = 10 + createdWindows.length + 1;
+        windows.set(windowId, { id: windowId, incognito: false });
+        return { id: windowId, incognito: false, tabs: [{ ...tab }] };
+      },
```

### ../sakura-admin-ui/src/views/automation/automationUiScene/components/AutomationExecutionCaseModal.vue

```diff
@@
-                              <div><strong>当前浏览器兼容模式：</strong>在 Admin 当前普通窗口创建一个回放标签页，批次内持续复用并共享 Chrome Profile。</div>
+                              <div><strong>当前浏览器兼容模式：</strong>新建普通 Chrome 回放窗口，批次内持续复用并共享 Chrome Profile。</div>
```

### ../sakura-admin-ui/src/views/test/testPlan/index.vue

```diff
@@
-                  ? '默认在当前普通 Chrome 窗口中创建并复用一个回放标签页；共享登录态和站点存储，不提供无痕隔离。'
+                  ? '默认新建并复用一个普通 Chrome 回放窗口；共享登录态和站点存储，不提供无痕隔离。'
```

### ../docs/cdp-playback-case-session-modes-implementation-plan.md

```diff
@@
-| `legacy-profile` | 批次首次执行时在当前普通 Chrome 窗口新建回放标签页，后续用例复用同一最终活动页并共享用户当前 Chrome Profile | 作为默认的“当前浏览器兼容模式（非隔离）”保留；用于下载、系统确认、旧用例兼容和连续业务流程 |
+| `legacy-profile` | 批次首次执行时新建普通 Chrome 回放窗口，后续用例复用同一最终活动页并共享用户当前 Chrome Profile | 作为默认的“当前浏览器兼容模式（非隔离）”保留；用于下载、系统确认、旧用例兼容和连续业务流程 |
```

# 2026-08-13 默认使用当前 Chrome Profile 并复用批次回放标签页

## 涉及文件

- background.js
- modules/player-manager.js
- modules/current-profile-batch-session-manager.js
- tests/current-profile-batch-session-manager.test.js
- ../sakura-admin-ui/src/views/automation/automationUiScene/extensionPlayback.ts
- ../sakura-admin-ui/src/views/automation/automationUiScene/components/AutomationExecutionCaseModal.vue
- ../sakura-admin-ui/src/views/test/testPlan/index.vue
- ../sakura-admin/continew-automation/src/main/java/top/continew/admin/automation/model/req/playwright/AutomationCdpPlaybackOptionsReq.java
- ../docs/cdp-playback-case-session-modes-implementation-plan.md
- commit/git-commit-log.md

## 变更原因

`legacy-profile` 虽然使用普通 Chrome Profile，但此前每条用例仍由 PlayerManager 新建窗口，无法继承 `reuse-browser` 的批次连续状态。用户要求将当前浏览器兼容模式设为 CDP 默认，并在普通 Profile 中复用同一回放页签，同时避免无痕窗口、重复新建窗口和误关闭用户页面。

## 变更内容

1. 新增普通 Profile 批次管理器，在 Admin 当前普通窗口首次创建一个回放标签页，成功用例之间复用最终活动页。
2. 用例失败、取消或活动页丢失时只重建本批次回放标签页；批次结束关闭 CueCast 创建的标签页，不关闭 Admin 标签页或 Chrome 窗口。
3. 普通 Profile 与受控无痕批次统一使用 BEGIN/PLAY/END/ABORT 生命周期，并使用 `executionCapability` 校验批次归属。
4. Service Worker 恢复时只关闭可由 Admin 标签页 `opener` 链证明归属的普通标签页，无法证明时保留用户页面。
5. 场景执行、测试计划和后端 CDP DTO 默认改为 `current-profile/legacy-profile`，受控无痕三模式仍可手动选择。
6. END/ABORT 显式携带 `browserSessionSource`，Admin 同时校验返回的来源和模式，拒绝静默协议错配。

## 验证

- `node --test`：73/73 通过。
- `node --test tests/current-profile-batch-session-manager.test.js`：5/5 通过。
- `node --check modules/current-profile-batch-session-manager.js background.js modules/player-manager.js`：通过。
- admin-ui `pnpm run typecheck`：通过。
- admin-ui `pnpm exec eslint src/views/automation/automationUiScene/extensionPlayback.ts`：通过。
- Admin Maven 已进入 Reactor 编译，但被既有 `continew-module-system` 缺失 `top.continew.admin.common.enums`、`RoleContext` 等类型阻断；本次 DTO 未出现编译错误。
- `git diff --check`：通过。

## 具体代码改动

### background.js

```diff
@@
+import { CurrentProfileBatchSessionManager } from './modules/current-profile-batch-session-manager.js';
@@
+const currentProfileBatchSessions = new CurrentProfileBatchSessionManager(chrome);
@@
-      cdpBatchSessions.beginBatch({
+      (message.browserSessionSource === 'current-profile'
+        ? currentProfileBatchSessions
+        : cdpBatchSessions).beginBatch({
@@
+      const batchSessionManager = message.browserSessionSource === 'managed-context'
+        ? cdpBatchSessions
+        : message.browserSessionSource === 'current-profile' && message.sessionMode === 'legacy-profile'
+          && currentProfileBatchSessions.ownsBatch(message.batchId)
+          ? currentProfileBatchSessions
+          : null;
```

### modules/player-manager.js

```diff
@@
         sessionNavigationDecision = String(preparedSession?.sessionTransition || '');
+        for (const managedTabId of preparedSession?.managedTabIds || []) {
+          if (Number.isInteger(Number(managedTabId))) ctx.managedTabIds.add(Number(managedTabId));
+        }
```

### modules/current-profile-batch-session-manager.js

```diff
@@
+export class CurrentProfileBatchSessionManager {
+  async prepareCase({ batchId, sessionMode, browserSessionSource, executionCapability, startUrl }) {
+    this.assertBatch(batchId, sessionMode, browserSessionSource);
+    await this.assertExecutionCapability(executionCapability);
+    let activeTab = await this.getOwnedTab(this.batch.activeTabId);
+    if (!activeTab) {
+      activeTab = await this.chrome.tabs.create({
+        windowId: this.batch.sourceWindowId,
+        openerTabId: this.batch.sourceTabId,
+        url: start,
+        active: true,
+      });
+    }
+    return {
+      tabId: Number(activeTab.id),
+      keepTabOpenAfterPlayback: true,
+      skipInitialNavigation,
+    };
+  }
+}
```

### tests/current-profile-batch-session-manager.test.js

```diff
@@
+test('当前 Profile 批次在 Admin 普通窗口创建标签页并连续复用', async () => {
+  const first = await harness.manager.prepareCase({
+    batchId: 'batch-legacy',
+    startUrl: 'https://app.example/login',
+  });
+  const second = await harness.manager.prepareCase({
+    batchId: 'batch-legacy',
+    startUrl: 'https://app.example/login',
+  });
+  assert.equal(harness.createdTabs.length, 1);
+  assert.equal(first.tabId, second.tabId);
+  assert.equal(harness.tabs.has(1), true);
+});
```

### ../sakura-admin-ui/src/views/automation/automationUiScene/extensionPlayback.ts

```diff
@@
-export const endExtensionCdpBatch = async (batchId: string, executionCapability?: string) => {
+export const endExtensionCdpBatch = async (
+  batchId: string,
+  browserSessionSource: AutomationCdpPlaybackOptions['browserSessionSource'],
+  executionCapability?: string,
+) => {
   const response = await waitForExtensionAck('AT_PLATFORM_END_PLAYBACK_BATCH', {
     batchId,
+    browserSessionSource,
     executionCapability,
   }, 30000)
```

### ../sakura-admin-ui/src/views/automation/automationUiScene/components/AutomationExecutionCaseModal.vue

```diff
@@
 const cdpSessionModeOptions = computed(() => [
+  { label: '当前浏览器兼容模式（非隔离）', value: 'legacy-profile' },
   ...(cdpManagedContextAvailable.value && cdpGrayEnabled.value ? runnerSessionModeOptions : []),
-  { label: '当前浏览器兼容模式（非隔离）', value: 'legacy-profile' },
 ])
@@
-    browserSessionSource: cdpManagedContextAvailable.value && cdpGrayEnabled.value ? 'managed-context' : 'current-profile',
-    sessionMode: cdpManagedContextAvailable.value && cdpGrayEnabled.value ? 'isolated' : 'legacy-profile',
+    browserSessionSource: 'current-profile',
+    sessionMode: 'legacy-profile',
```

### ../sakura-admin-ui/src/views/test/testPlan/index.vue

```diff
@@
 const execCdpSessionModeOptions = computed(() => [
+  { label: '当前浏览器兼容模式（非隔离）', value: 'legacy-profile' },
   ...(execCdpManagedContextAvailable.value && execCdpGrayEnabled.value ? runnerSessionModeOptions : []),
-  { label: '当前浏览器兼容模式（非隔离）', value: 'legacy-profile' },
 ])
@@
-      browserSessionSource: execCdpManagedContextAvailable.value && execCdpGrayEnabled.value ? 'managed-context' : 'current-profile',
-      sessionMode: execCdpManagedContextAvailable.value && execCdpGrayEnabled.value ? 'isolated' : 'legacy-profile',
+      browserSessionSource: 'current-profile',
+      sessionMode: 'legacy-profile',
```

### ../sakura-admin/continew-automation/src/main/java/top/continew/admin/automation/model/req/playwright/AutomationCdpPlaybackOptionsReq.java

```diff
@@
-    private String browserSessionSource = "managed-context";
+    private String browserSessionSource = "current-profile";
@@
-    private String sessionMode = "isolated";
+    private String sessionMode = "legacy-profile";
```

### ../docs/cdp-playback-case-session-modes-implementation-plan.md

```diff
@@
-| `legacy-profile` | 每条用例新建窗口，但共享用户当前 Chrome Profile | 始终作为“当前浏览器兼容模式（非隔离）”保留；用于下载、系统确认、旧用例兼容和历史展示 |
+| `legacy-profile` | 批次首次执行时在当前普通 Chrome 窗口新建回放标签页，后续用例复用同一最终活动页并共享用户当前 Chrome Profile | 作为默认的“当前浏览器兼容模式（非隔离）”保留；用于下载、系统确认、旧用例兼容和连续业务流程 |
```

# 2026-08-13 明确 CDP 下载确认边界并保证失败后会话销毁

## 涉及文件

- modules/cdp-browser-context-driver.js
- tests/cdp-browser-context-driver.test.js
- commit/git-commit-log.md

## 变更原因

关闭 Chrome 的“下载前询问每个文件的保存位置”后，受控无痕会话仍可能弹出 Chrome 下载确认窗口。真实 Chrome 已证明页签级 `chrome.debugger` 无权调用 browser-level 下载策略；`automaticDownloads` 仅管理站点连续下载许可，不能绕过危险、不安全或其他浏览器级确认。扩展不能把人工确认静默视为成功，但必须取消下载并销毁自有窗口，避免阻塞后续批次。

## 变更内容

1. 移除页签级 debugger 不支持的 `Page.setDownloadBehavior`，恢复正常 CDP 附加。
2. 撤销无效的 `contentSettings.automaticDownloads` 方案和对应 Manifest 权限。
3. 清理阶段主动查询 `in_progress` 无痕下载，输出 `state/danger/error/paused/filename/url` 诊断。
4. 危险或暂停下载立即返回 `CDP_DOWNLOAD_REQUIRES_CONFIRMATION`，明确要求切换 Playwright Runner。
5. 普通下载等待终态，超时返回 `CDP_DOWNLOAD_TIMEOUT`。
6. 两类下载失败都会先取消下载、关闭受控窗口并删除 Context，再把错误回传，防止后续批次被残留窗口阻塞。

## 验证

- `node --test`：68/68 通过。
- CDP 专项测试：28/28 通过。
- `node --check modules/player-manager.js modules/cdp-browser-context-driver.js`：通过。
- `git diff --check`：通过。

## 具体代码改动

### modules/cdp-browser-context-driver.js

```diff
@@
-      const activeIds = [...this.activeDownloads.entries()]
+      const trackedIds = [...this.activeDownloads.entries()]
         .filter(([, tracked]) => tracked.contextId === browserContextId)
         .map(([downloadId]) => downloadId);
+      const queried = await Promise.resolve(
+        this.chrome.downloads.search ? this.chrome.downloads.search({ state: 'in_progress' }) : [],
+      ).catch(() => []);
+      const queriedIds = queried
+        .filter((item) => item?.incognito === true)
+        .map((item) => item.id)
+        .filter((id) => id != null);
+      const activeIds = [...new Set([...trackedIds, ...queriedIds])];
@@
+      const blocked = activeIds
+        .map((downloadId) => this.activeDownloads.get(downloadId)?.item)
+        .filter((item) => item && ((item.danger && item.danger !== 'safe') || item.paused === true));
+      if (blocked.length) {
+        await this.cancelDownloads(activeIds);
+        throw new CdpBrowserContextError(
+          'CDP_DOWNLOAD_REQUIRES_CONFIRMATION',
+          `Chrome 要求人工确认该下载，扩展 CDP 无法绕过；${blocked.map(downloadDiagnostic).join('；')}。请改用 Playwright Runner`,
+        );
+      }
```

### tests/cdp-browser-context-driver.test.js

```diff
@@
+test('下载超时后仍关闭受控窗口并清除 Context 归属', async () => {
+  await assert.rejects(
+    () => driver.disposeBrowserContext(contextId),
+    (error) => error.code === 'CDP_DOWNLOAD_TIMEOUT',
+  );
+  assert.equal(driver.contexts.has(contextId), false);
+  assert.equal(harness.windows.has(target.tab.windowId), false);
+});
```

# 2026-08-13 修复 CDP 探测、下载与受控无痕窗口清理闭环

## 涉及文件

- manifest.json
- modules/cdp-browser-context-driver.js
- modules/cdp-batch-session-manager.js
- tests/cdp-browser-context-driver.test.js
- tests/cdp-batch-session-manager.test.js
- ../sakura-admin-ui/src/views/automation/automationUiScene/extensionPlayback.ts
- commit/git-commit-log.md

## 变更原因

CDP 配置页重复触发 A/B 无痕会话能力探测；下载未结束时批次立即关闭窗口，且 Context 归属在窗口确认消失前被删除，导致自有残留窗口被误判为外部无痕窗口。END 超时后的 ABORT 还可能与原清理并发，使批次停在 `cleanup-failed` 并阻塞后续执行。

## 变更内容

1. 能力探测增加 single-flight 和版本化 session 缓存，成功缓存 2 小时、失败缓存 30 秒；探测窗口改为后台创建。
2. 增加 Chrome downloads 权限，受控 Context 跟踪下载开始与终态；清理前等待下载，超时尝试取消并返回可操作错误。
3. 只在受控窗口确认消失且不存在外部无痕窗口后删除 Context 归属，失败时保留归属供 ABORT 重试。
4. END/ABORT 共享单次清理 Promise，并冻结 capability 比对目标，避免并发清理和批次清空竞态。
5. Admin 清理 ACK 超时提高到 30 秒，覆盖 15 秒下载等待和 8 秒窗口关闭确认。
6. 清理失败时保留下载监听器和驱动连接，确保后续 ABORT 能继续观察下载终态并完成重试。

## 验证

- `node --test`：67/67 通过。
- `node --test tests/cdp-browser-context-driver.test.js tests/cdp-batch-session-manager.test.js`：27/27 通过。
- `node --check modules/cdp-browser-context-driver.js; node --check modules/cdp-batch-session-manager.js`：通过。
- admin-ui `pnpm run typecheck`：通过。
- admin-ui `pnpm exec eslint src/views/automation/automationUiScene/extensionPlayback.ts`：通过。

## 具体代码改动

### manifest.json

```diff
@@
     "debugger",
+    "downloads",
     "notifications",
```

### modules/cdp-browser-context-driver.js

```diff
@@
-    this.contexts.delete(browserContextId);
-    let foreign = await this.getIncognitoWindows();
-    while (foreign.length > 0 && Date.now() < deadline) {
+    await this.waitForDownloads(browserContextId);
+    let owned = await this.getContextWindows(context);
+    while (owned.length > 0 && Date.now() < deadline) {
       await sleep(TARGET_POLL_INTERVAL_MS);
-      foreign = await this.getIncognitoWindows();
+      owned = await this.getContextWindows(context);
     }
+    if (owned.length > 0) {
+      throw new CdpBrowserContextError(
+        'CDP_SESSION_CLEANUP_FAILED',
+        `受控无痕窗口仍未关闭：${owned.map((item) => item.id).join(',')}`,
+      );
+    }
+    const foreign = await this.getIncognitoWindows();
+    if (foreign.length > 0) {
+      throw new CdpBrowserContextError(
+        'CDP_INCOGNITO_SESSION_CONTAMINATED',
+        '批次运行期间出现了非 CueCast 管理的无痕窗口，无法证明测试状态已销毁；请关闭全部无痕窗口后重试',
+      );
+    }
+    this.contexts.delete(browserContextId);
@@
-    await this.disconnect();
     if (failures.length) {
       throw new CdpBrowserContextError(
         'CDP_SESSION_CLEANUP_FAILED',
         `受控无痕会话清理失败：${failures.join('；')}`,
       );
     }
+    await this.disconnect();
@@
-      const targetA = await this.createTarget(contextA, url);
+      const targetA = await this.createTarget(contextA, url, { background: true });
```

### modules/cdp-batch-session-manager.js

```diff
@@
-    const driver = this.driverFactory();
-    const result = await driver.probe(sourceTabId, probeUrl);
-    this.cachedCapabilities = result;
-    return result;
+    if (this.probePromise) return this.probePromise;
+    this.probePromise = (async () => {
+      const cached = stored?.[CAPABILITY_CACHE_KEY];
+      if (cached?.timestamp && cached.extensionVersion === extensionVersion) return cached.result;
+      const result = await this.driverFactory().probe(sourceTabId, probeUrl);
+      await this.chrome.storage.session.set({ [CAPABILITY_CACHE_KEY]: { timestamp: Date.now(), extensionVersion, result } });
+      return result;
+    })().finally(() => { this.probePromise = null; });
+    return this.probePromise;
@@
   async cleanupBatch() {
+    if (this.cleanupPromise) return this.cleanupPromise;
+    this.cleanupPromise = this._cleanupBatch().finally(() => { this.cleanupPromise = null; });
+    return this.cleanupPromise;
+  }
```

### tests/cdp-browser-context-driver.test.js

```diff
@@
+test('受控下载未完成时保留 Context 归属并尝试取消下载', async () => {
+  harness.emitDownloadCreated({ id: 77, incognito: true, state: 'in_progress' });
+  await assert.rejects(
+    () => driver.waitForDownloads(contextId, 1),
+    (error) => error.code === 'CDP_DOWNLOAD_IN_PROGRESS',
+  );
+  assert.equal(driver.contexts.has(contextId), true);
+  assert.deepEqual(harness.cancelledDownloads, [77]);
+});
```

### tests/cdp-batch-session-manager.test.js

```diff
@@
+test('并发能力探测共享一次真实探测并持久化结果', async () => {
+  const [first, second] = await Promise.all([
+    harness.manager.probeCapabilities(1, 'https://admin.example/scenes'),
+    harness.manager.probeCapabilities(1, 'https://admin.example/scenes'),
+  ]);
+  assert.equal(harness.probeCount, 1);
+  assert.deepEqual(first, second);
+});
+
+test('并发 END 和 ABORT 共享同一次批次清理', async () => {
+  await Promise.all([
+    harness.manager.endBatch('batch-isolated', EXECUTION_CAPABILITY),
+    harness.manager.abortBatch('batch-isolated', EXECUTION_CAPABILITY),
+  ]);
+  assert.deepEqual(harness.disposed, ['context-1']);
+});
```

### ../sakura-admin-ui/src/views/automation/automationUiScene/extensionPlayback.ts

```diff
@@
-  const response = await waitForExtensionAck('AT_PLATFORM_END_PLAYBACK_BATCH', { batchId, executionCapability }, 8000)
+  const response = await waitForExtensionAck('AT_PLATFORM_END_PLAYBACK_BATCH', { batchId, executionCapability }, 30000)
@@
-  const response = await waitForExtensionAck('AT_PLATFORM_ABORT_PLAYBACK_BATCH', { batchId, executionCapability }, 8000)
+  const response = await waitForExtensionAck('AT_PLATFORM_ABORT_PLAYBACK_BATCH', { batchId, executionCapability }, 30000)
```

# 2026-08-13 修复能力探测命令处理期间提前 detach

## 涉及文件

- modules/cdp-browser-context-driver.js
- modules/cdp-auth-state.js
- tests/cdp-browser-context-driver.test.js
- tests/cdp-auth-state.test.js
- commit/git-commit-log.md

## 变更原因

真实 Chrome 能力探测已进入扩展独占无痕会话，但 Cookie CDP 命令返回 `Detached while handling command`。根因不是 Chrome 不支持，而是 `sendBrowserCommand()` 在 `try` 中直接返回 `chrome.debugger.sendCommand()` 的 Promise，JavaScript 会先执行 `finally`，导致命令尚未完成就主动调用 `chrome.debugger.detach()`。

## 变更内容

1. 所有临时 debugger 命令显式 `await`，只在命令完成或失败后执行 detach。
2. Cookie 读取从已废弃的 `Network.getAllCookies` 改为页签范围 `Network.getCookies({ urls })`。
3. 认证快照只读取本批次实际访问 URL 和 origin 可见的 Cookie，不扩大到整个浏览器。
4. `Detached while handling command` 等瞬时断连会重新 attach 并重试一次，第二次失败仍明确返回错误。
5. 能力探测继续验证 Cookie 捕获/恢复，不通过降低门禁掩盖 `reuse-auth` 问题。

## 验证

- `node --test tests/cdp-browser-context-driver.test.js tests/cdp-auth-state.test.js tests/cdp-batch-session-manager.test.js`：27/27 通过。
- `node --test`：64/64 通过。
- `node --check background.js modules/cdp-browser-context-driver.js modules/cdp-auth-state.js modules/cdp-batch-session-manager.js modules/player-manager.js`：通过。
- admin-ui `npm run typecheck`：通过。
- admin-ui `extensionPlayback.ts` 精确 ESLint：通过。

## 具体代码改动

### modules/cdp-browser-context-driver.js

```diff
@@
-          return this.chrome.debugger.sendCommand(debuggee, 'Network.getAllCookies');
+          return await this.chrome.debugger.sendCommand(debuggee, 'Network.getCookies', {
+            urls: Array.isArray(params.urls) ? params.urls : [],
+          });
@@
-        return this.chrome.debugger.sendCommand(debuggee, method, commandParams);
+        // 必须等待命令完成后再进入 finally detach，否则 Chrome 会报 Detached while handling command。
+        return await this.chrome.debugger.sendCommand(debuggee, method, commandParams);
+      } catch (error) {
+        if (!isDetachedCommandError(error) || attempt > 0) throw error;
+        await sleep(TARGET_POLL_INTERVAL_MS);
       } finally {
         if (attachedHere) await this.chrome.debugger.detach(debuggee).catch(() => {});
       }
```

### modules/cdp-auth-state.js

```diff
@@
-      const cookieResult = await driver.sendBrowserCommand('Storage.getCookies', { browserContextId });
       const originSet = new Set([
@@
+      const cookieUrls = [...new Set([
+        ...tabs.map((tab) => String(tab?.url || '')),
+        String(lastUrl || ''),
+        ...originSet,
+      ].filter((url) => /^https?:\/\//i.test(url)))];
+      const cookieResult = await driver.sendBrowserCommand('Storage.getCookies', {
+        browserContextId,
+        urls: cookieUrls,
+      });
```

### tests/cdp-browser-context-driver.test.js

```diff
@@
+test('认证状态 Cookie 命令瞬时 detach 时重新附加并重试一次', async () => {
+  const harness = createHarness({ detachCookieOnce: true });
+  const result = await driver.sendBrowserCommand('Storage.getCookies', {
+    browserContextId: contextId,
+    urls: ['https://app.example/home'],
+  });
+  assert.equal(result.cookies[0].name, 'sid');
+  assert.equal(harness.commands.filter((item) => item.method === 'Network.getCookies').length, 2);
+  assert.equal(harness.commands.filter((item) => item.method === 'attach').length, 2);
+});
```

### tests/cdp-auth-state.test.js

```diff
@@
+test('认证快照按批次实际访问 URL 读取受控无痕 Cookie', async () => {
+  await service.capture({
+    browserContextId: 'context-1',
+    driver,
+    tabs: [
+      { id: 101, url: 'https://app.example/account' },
+      { id: 102, url: 'https://account.example/profile' },
+    ],
+    origins: ['https://account.example'],
+    lastUrl: 'https://app.example/home',
+  });
+  assert.deepEqual(cookieOptions.urls, [
+    'https://app.example/account',
+    'https://account.example/profile',
+    'https://app.example/home',
+    'https://account.example',
+    'https://app.example',
+  ]);
+});
```

---

# 2026-08-13 修正 CDP 三模式为扩展独占无痕会话

## 涉及文件

- README.md
- background.js
- modules/cdp-batch-session-manager.js
- modules/cdp-browser-context-driver.js
- modules/player-manager.js
- tests/cdp-batch-session-manager.test.js
- tests/cdp-browser-context-driver.test.js
- commit/git-commit-log.md

## 变更原因

真实 Chrome 151 已在开启 CueCast 无痕权限后返回 `Target.attachToBrowserTarget: {"code":-32000,"message":"Not allowed"}`。Chromium 只允许 browser-wide CDP 连接创建 BrowserContext，扩展页签 debugger 无法取得该权限。原实现会永久回退为当前 Profile 兼容模式，三种会话无法落地。需要改为 Chrome 实际允许的扩展独占无痕会话，同时保护用户默认 Profile 和用户自行打开的无痕窗口。

## 变更内容

1. 删除 browser target attach/create/dispose 路径，改用 `chrome.windows.create({ incognito: true })` 管理受控无痕会话生命周期。
2. `isolated` 和 `reuse-auth` 在用例间关闭最后一个受控无痕窗口再重建；`reuse-browser` 保留同一窗口和最终活动页。
3. Cookie 捕获/恢复通过受控无痕页签的 CDP Network 域完成，不新增 `cookies`/`browsingData` 权限。
4. 批次开始前检测用户无痕窗口；存在时明确拒绝且绝不关闭。Service Worker 重启后只清理仍可由持久化 tabId 证明归属的窗口。
5. 弹窗/派生页出现时即时写入 tab/window 元数据；认证快照前先释放 PlayerManager debugger，避免重复附加冲突。
6. 能力响应增加 `managedSessionStrategy=exclusive-incognito`，保留 `managedBrowserContext`/`managed-context` 兼容字段。

## 验证

- `node --test`：62/62 通过。
- `node --check background.js modules/cdp-browser-context-driver.js modules/cdp-batch-session-manager.js modules/player-manager.js`：通过。
- admin-ui `npm run typecheck`：通过。
- admin-ui 改动文件 `npx eslint --no-fix ...`：通过。
- `git diff --check`：通过，仅有工作区 LF/CRLF 提示。
- 真实 Chrome 替代路线仍需重载扩展后完成业务矩阵，本记录未把 Node 模拟测试计为真实 Chrome 验收。

## 具体代码改动

### README.md

```diff
@@
-- **每条用例独立登录（默认）**：每条用例创建独立 BrowserContext，用例结束后销毁，登录态和站点存储不跨用例保留。
+- **每条用例独立登录（默认）**：每条用例创建扩展独占的无痕会话，用例结束后关闭全部受控无痕窗口，登录态和站点存储不跨用例保留。
@@
-受管 BrowserContext 仍需在真实 Chrome 125+ 环境完成一次门禁验证。
+Chrome 扩展页签调试会话无权调用 `Target.attachToBrowserTarget` 和 `Target.createBrowserContext`。CueCast 改用扩展独占无痕会话实现三种语义。
```

### background.js

```diff
@@
+        .catch((e) => sendResponse({
+          ok: false,
+          managedBrowserContext: false,
+          managedSessionStrategy: 'exclusive-incognito',
+          supportedSessionModes: ['legacy-profile'],
+          errorCode: e.code,
+          error: e.message || String(e),
+        }));
@@
 chrome.tabs.onCreated.addListener((tab) => {
+  cdpBatchSessions.handleTabCreated(tab);
   void recorder.handleRecordingTabCreated(tab).catch(() => {});
 });
```

### modules/cdp-batch-session-manager.js

```diff
@@
       activeTabId: null,
       managedTabIds: new Set(),
+      managedWindowIds: new Set(),
+      pendingIncognitoTabIds: new Set(),
+      contaminated: false,
@@
+  handleTabCreated(tab) {
+    if (!this.batch || tab?.incognito !== true) return;
+    void this.trackManagedTabCreated(tab);
+  }
@@
-      await recoveryDriver.connect(anchorTabId);
-      await recoveryDriver.disposeBrowserContext(contextId);
+      // Service Worker 重启后只按持久化窗口和标签页归属清理。
+      await recoveryDriver.cleanupRecoveredSession(metadata);
@@
+  async assertSessionIsolation() {
+    if (this.batch?.contaminated) {
+      const error = new Error('批次运行期间出现了非 CueCast 管理的无痕窗口');
+      error.code = 'CDP_INCOGNITO_SESSION_CONTAMINATED';
+      throw error;
+    }
+    await this.driver?.assertNoForeignIncognitoWindows?.();
+  }
```

### modules/cdp-browser-context-driver.js

```diff
@@
- * 通过 chrome.debugger 的 browser target session 管理独立 BrowserContext。
+ * 通过扩展独占的无痕会话提供受控状态边界。
+ * chrome.debugger 的页签会话没有 browser-wide 权限，不能调用 Target.createBrowserContext。
@@
-      const attached = await this.chrome.debugger.sendCommand(
-        { tabId: normalizedTabId },
-        'Target.attachToBrowserTarget',
-      );
+    await this.assertIncognitoAccessAllowed();
+    await this.assertNoForeignIncognitoWindows();
+    this.anchorTabId = normalizedTabId;
@@
-      const result = await this.sendBrowserCommand('Target.createBrowserContext', {
-        disposeOnDetach,
-      });
+      const createdWindow = await this.chrome.windows.create({
+        url: targetUrl,
+        incognito: true,
+        focused: !background,
+        type: 'normal',
+      });
@@
+      managedSessionStrategy: 'exclusive-incognito',
@@
+    const recordedTabIds = new Set([
+      ...(metadata.managedTabIds || []),
+      metadata.activeTabId,
+    ].map(Number).filter(Number.isInteger));
+    // 只有仍可由持久化 tabId 证明归属的窗口才自动关闭。
+    for (const tabId of recordedTabIds) {
+      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
+      if (tab?.incognito && recordedWindowIds.has(tab.windowId)) provenWindowIds.add(tab.windowId);
+    }
```

### modules/player-manager.js

```diff
@@
       let success = !errorMsg;
       if (typeof opts.finalizeBrowserSession === 'function') {
+        const debuggerTabId = ctx.activeTabId ?? playTabId;
+        if (ctx.debuggerAttached && debuggerTabId != null) {
+          await this._detachDebugger(debuggerTabId, ctx);
+        }
         const managedTabs = await this._refreshManagedTabs(ctx).catch(() => []);
```

### tests/cdp-batch-session-manager.test.js

```diff
@@
+    async cleanupRecoveredSession(metadata) {
+      for (const contextId of new Set([
+        metadata.caseContextId,
+        metadata.browserContextId,
+      ].filter(Boolean))) {
+        await this.disposeBrowserContext(contextId);
+      }
+    }
@@
-test('isolated 每条用例创建并销毁独立 BrowserContext', async () => {
+test('isolated 每条用例创建并销毁独立受控会话', async () => {
@@
+test('批次中出现非受控无痕窗口后阻断 reuse-browser 快速复用', async () => {
+  await assert.rejects(() => harness.manager.prepareCase({
+    batchId: 'batch-reuse-browser',
+    executionCapability: EXECUTION_CAPABILITY,
+    startUrl: 'https://app.example/login',
+  }),
+    (error) => error.code === 'CDP_INCOGNITO_SESSION_CONTAMINATED');
+});
```

### tests/cdp-browser-context-driver.test.js

```diff
@@
-test('能力探测通过 browser child session 创建并清理两个 BrowserContext', async () => {
+test('能力探测通过两个顺序无痕会话验证状态销毁', async () => {
@@
+test('存在用户无痕窗口时拒绝能力探测且不关闭用户窗口', async () => {
+  const harness = createHarness({ foreignIncognito: true });
+  const result = await new CdpBrowserContextDriver(harness.chrome)
+    .probe(1, 'https://admin.example/scenes');
+  assert.equal(result.errorCode, 'CDP_INCOGNITO_SESSION_CONFLICT');
+  assert.equal(harness.windows.has(9), true);
+});
@@
+test('Service Worker 重启后不凭旧 windowId 关闭无法证明归属的用户无痕窗口', async () => {
+  await assert.rejects(() => recoveryDriver.cleanupRecoveredSession(metadata),
+    (error) => error.code === 'CDP_INCOGNITO_SESSION_CONTAMINATED');
+});
```

---

# 2026-08-13 补齐受控 BrowserContext 无痕权限门禁

## 涉及文件

- modules/cdp-browser-context-driver.js
- tests/cdp-browser-context-driver.test.js
- README.md
- commit/git-commit-log.md

## 变更原因

受控 BrowserContext 属于无痕上下文。如果用户未在 Chrome 扩展详情中开启“允许在无痕模式下运行”，CueCast 无法通过 `tabs` 和 `scripting` 接管新 Context 页面，原实现却会继续执行完整探测并返回下游模糊错误，admin-ui 只能显示“扩展 CDP 能力探测失败”。需要在连接 browser target 前建立明确的权限门禁，并提供可直接操作的修复提示。

## 变更内容

1. 能力探测首先通过 `chrome.extension.isAllowedIncognitoAccess()` 检查无痕访问权限。
2. 未授权时返回 `CDP_INCOGNITO_ACCESS_REQUIRED`，提示在 CueCast 扩展详情中开启“允许在无痕模式下运行”并刷新页面。
3. Chrome 无法提供权限检查 API 时返回独立错误码，避免误判为 BrowserContext 或页面脚本故障。
4. 新增未授权契约测试，并确保权限失败时不会附着调试器或创建任何 Context。
5. 安装说明补充“允许在无痕模式下运行”的必要配置，避免加载扩展后遗漏能力前置条件。

## 验证

- `node --test tests/cdp-browser-context-driver.test.js`：5/5 通过。
- `node --experimental-default-type=module --test tests/*.test.js`：55/55 通过。
- `node --check modules/cdp-browser-context-driver.js`：通过。
- `git diff --check`：通过，仅有工作区既有 LF/CRLF 提示。

## 具体代码改动

### modules/cdp-browser-context-driver.js

```diff
@@
-  async probe(anchorTabId, probeUrl) {
+  async assertIncognitoAccessAllowed() {
+    const checkAccess = this.chrome?.extension?.isAllowedIncognitoAccess;
+    if (typeof checkAccess !== 'function') {
+      throw new CdpBrowserContextError(
+        'CDP_INCOGNITO_ACCESS_CHECK_UNAVAILABLE',
+        '当前 Chrome 无法检查 CueCast 的无痕模式访问权限，请升级 Chrome 后重新加载扩展',
+      );
+    }
+    const allowed = await checkAccess.call(this.chrome.extension);
+    if (!allowed) {
+      throw new CdpBrowserContextError(
+        'CDP_INCOGNITO_ACCESS_REQUIRED',
+        'CueCast 未获准在无痕模式下运行。请在 chrome://extensions 打开 CueCast 详情，开启“允许在无痕模式下运行”，然后刷新当前页面',
+      );
+    }
+  }
+
+  async probe(anchorTabId, probeUrl) {
@@
-    try {
-      await this.connect(anchorTabId);
+    try {
+      // 受控 BrowserContext 属于无痕上下文；未授权时 tabs/scripting 无法接管其页面。
+      await this.assertIncognitoAccessAllowed();
+      await this.connect(anchorTabId);
```

### tests/cdp-browser-context-driver.test.js

```diff
@@
-function createHarness({ leakState = false, failDispose = false } = {}) {
+function createHarness({ leakState = false, failDispose = false, incognitoAllowed = true } = {}) {
@@
-  const chrome = {
+  const chrome = {
+    extension: {
+      async isAllowedIncognitoAccess() { return incognitoAllowed; },
+    },
@@
+test('未开启无痕访问时返回可操作的能力门禁原因', async () => {
+  const harness = createHarness({ incognitoAllowed: false });
+  const driver = new CdpBrowserContextDriver(harness.chrome);
+
+  const result = await driver.probe(1, 'https://admin.example/scenes');
+
+  assert.equal(result.managedBrowserContext, false);
+  assert.equal(result.errorCode, 'CDP_INCOGNITO_ACCESS_REQUIRED');
+  assert.match(result.reason, /允许在无痕模式下运行/);
+  assert.equal(harness.commands.length, 0);
+});
```

### README.md

```diff
@@
 3. 点击「加载已解压的扩展程序」
 4. 选择扩展目录（`D:\King\sakura\sakura-cuecast`）
+5. 打开 CueCast 的“详情”，开启“允许在无痕模式下运行”；三种受控 BrowserContext 会话依赖此权限，未开启时只保留当前浏览器兼容模式。
```

---

# 2026-08-12 统一定位器跨执行器适配

## 涉及文件

- modules/player-manager.js
- content/player.js
- tests/cuecast-recording-compatibility.test.js
- tests/operation-contract.test.js
- tests/fixtures/locator-contract-v1.json
- commit/git-commit-log.md

## 变更原因

`extension-cdp` 会把 `(//span[@class='user-title'])[1]` 错误改写为 `/(//span[@class='user-title'])[1]`，并且 `assert_element_match` 没有与点击、输入共用完整的 `locator_meta` 候选链。需要让 CueCast CDP 和 DOM 降级路径保持 XPath 原语义，统一断言定位器，并与 Playwright 的候选类型契约对齐。

## 变更内容

1. XPath 只移除显式 `xpath=` 前缀，并仅为历史 `html/...`、`body/...` 裸路径补 `/`；括号 XPath、相对 XPath、绝对 XPath和函数表达式均原样执行。
2. CDP 在执行前校验主 XPath 和 `locator_meta` XPath，区分 `LOCATOR_XPATH_INVALID`、`LOCATOR_XPATH_UNSUPPORTED`，并明确拒绝 jQuery、JS Path、testRigor 私有定位策略。
3. `assert_element_match`、变量读取、输入和按键复用 `locator_meta -> 稳定 id -> XPath -> CSS` 元素解析链，回传来源、类型、命中数和可见数。
4. DOM 降级路径采用同一 XPath 保留规则和错误结构；高亮改用 Web Animations，避免临时修改 `class` 导致精确属性 XPath 在真正执行前失效。
5. 新增共享定位契约 fixture，区分录制器当前候选类型和历史 `tree_item_text` 兼容类型；CueCast 与 Playwright 测试共同读取该文件。
6. 录制动作契约测试锁定 `target_xpath` 和 `locator_meta` 在运行时 canonical action 转换后不丢失。

## 验证

- `node --experimental-default-type=module --test tests/*.test.js`：54/54 通过。
- `node --check modules/player-manager.js`、`node --check content/player.js`：通过。
- Playwright Runner `npm run check`：通过。
- Playwright Runner `npm run test:unit`：87/87 通过。
- Playwright Runner `npm run test:locator`：21/21 通过，包含真实 Chromium 下 legacy、semantic-v1、CDP 表达式和 CueCast DOM 降级验证。
- 真实已加载扩展的 Chrome 回放仍需人工验收；自动化测试结果未替代该环境门禁。

## 具体代码改动

### modules/player-manager.js

```diff
@@
+  /**
+   * XPath 必须原样交给浏览器。仅兼容旧数据中的 html/...、body/... 裸绝对路径，
+   * 不能给括号 XPath、.// 相对 XPath或函数表达式擅自补斜杠。
+   */
+  static _normalizeXPath(xpath) {
+    let normalized = String(xpath || '').trim();
+    if (/^xpath\s*=/i.test(normalized)) normalized = normalized.replace(/^xpath\s*=\s*/i, '').trim();
+    if (!normalized || PlayerManager._isVolatileRcXPath(normalized)) return '';
+    return /^(?:html|body)\//i.test(normalized) ? `/${normalized}` : normalized;
+  }
@@
-  static _buildElementAssertionExpr(selector, xpath, readMode = 'auto') {
-    const chain = PlayerManager._buildDomTargetChain(selector, xpath);
+  static _buildElementAssertionExpr(selector, xpath, readMode = 'auto', locatorMeta = null) {
+    const resultChain = PlayerManager._buildDomTargetResultChain(selector, xpath, locatorMeta);
@@
+    await this._validateStepXpathsCDP(tabId, step);
     switch (actionType) {
```

### content/player.js

```diff
@@
-  function findBestXPathMatch(xpRaw) {
-    let x = xpRaw;
-    if (x && !x.startsWith('//') && !x.startsWith('/html') && !x.startsWith('/*')) {
-      x = `/${x}`;
-    }
+  function normalizeXPath(xpath) {
+    let normalized = String(xpath || '').trim();
+    if (/^xpath\s*=/i.test(normalized)) normalized = normalized.replace(/^xpath\s*=\s*/i, '').trim();
+    if (!normalized || isVolatileRcXPath(normalized)) return '';
+    return /^(?:html|body)\//i.test(normalized) ? `/${normalized}` : normalized;
   }
@@
-    if (el) {
-      el.classList.add('__at_playing__');
-      setTimeout(() => el.classList.remove('__at_playing__'), 1000);
+    if (el && typeof el.animate === 'function') {
+      // 高亮不能修改 class/style；精确属性 XPath 会因此在真正执行前失效。
+      el.animate([
+        { outline: '3px solid #4caf50', outlineOffset: '2px' },
+        { outline: '3px solid #4caf50', outlineOffset: '2px' },
+      ], { duration: 1000, easing: 'linear' });
     }
```

### tests/cuecast-recording-compatibility.test.js

```diff
@@
+const locatorContract = JSON.parse(fs.readFileSync(new URL(
+  './fixtures/locator-contract-v1.json',
+  import.meta.url,
+), 'utf8'));
@@
+test('括号 XPath 在所有 CDP 表达式中保持原样并复用 locator_meta 候选', () => {
+  const xpath = "(//span[@class='user-title'])[1]";
+  assert.equal(PlayerManager._normalizeXPath(xpath), xpath);
+  assert.equal(PlayerManager._normalizeXPath('.//span[@class="user-title"]'), './/span[@class="user-title"]');
+  const expression = PlayerManager._buildElementAssertionExpr(
+    '',
+    xpath,
+    'text',
+    { candidates: [{ type: 'css_attr_data-qa', value: "[data-qa='user-title']", score: 0.97 }] },
+  );
+  assert.match(expression, /data-qa/);
+  assert.match(expression, /locator_meta|meta-css_attr_data-qa/);
+  assert.doesNotMatch(expression, /\/\(\/\/span/);
+});
```

### tests/operation-contract.test.js

```diff
@@
+  const assertionLocatorMeta = {
+    candidates: [{ type: 'xpath_fallback', value: "(//span[@class='user-title'])[1]", score: 0.42 }],
+    context: { assertion: { target: 'element', match: 'contains', source: 'text' } },
+  };
   const assertion = PlayerManager._adaptRecordedStep({
     action_type: 'assert_text',
     value: '{{test}}',
-    locator_meta: { context: { assertion: { target: 'element', match: 'contains', source: 'text' } } },
+    target_xpath: "(//span[@class='user-title'])[1]",
+    locator_meta: assertionLocatorMeta,
   });
+  assert.equal(assertion.target_xpath, "(//span[@class='user-title'])[1]");
+  assert.deepEqual(assertion.locator_meta, assertionLocatorMeta);
```

### tests/fixtures/locator-contract-v1.json

```diff
@@
+{
+  "version": 1,
+  "recorder_candidate_types": [
+    "css_attr_data-testid",
+    "css_attr_data-test",
+    "css_attr_data-qa",
+    "css_attr_data-cy",
+    "xpath_fallback",
+    "tree_interaction",
+    "tree_node_text",
+    "text_exact",
+    "text_exact_tag"
+  ],
+  "compatibility_candidate_types": [
+    "tree_item_text"
+  ],
+  "candidates": [
+    {
+      "type": "xpath_fallback",
+      "value": "(//span[@class='user-title'])[1]",
+      "score": 0.42
+    }
+  ]
+}
```

# 2026-08-11 实现 CDP 批量回放三种用例会话

## 涉及文件

- README.md
- docs/changelog.md
- manifest.json
- background.js
- content/bridge.js
- modules/player-manager.js
- modules/cdp-browser-context-driver.js
- modules/cdp-auth-state.js
- modules/cdp-batch-session-manager.js
- tests/v1_2_merge_contract.test.js
- tests/cdp-browser-context-driver.test.js
- tests/cdp-auth-state.test.js
- tests/cdp-batch-session-manager.test.js
- tests/cdp-session-audit-contract.test.js
- commit/git-commit-log.md

## 变更原因

Admin 的 CDP 回放批量执行原先只能沿用当前 Chrome Profile，无法像 Playwright Runner 一样明确控制用例间的登录态和页面上下文。需要在不清理用户 Profile、不泄漏认证数据且保留旧执行入口的前提下，提供独立会话、成功登录态复用和同一浏览器连续执行三种模式。

## 变更内容

1. 使用 Chrome 125+ 的 CDP browser child session 创建、验证和销毁受控 BrowserContext；能力探测验证 Cookie、localStorage、sessionStorage 和 IndexedDB 隔离，失败时只声明旧版兼容模式。
2. 实现 isolated、reuse-auth、reuse-browser 三种批次会话。批次配置与短期 executionCapability 绑定，配置不一致、目标丢失或清理失败均返回明确错误码。
3. reuse-auth 仅原子提交上一条成功用例的 Cookie、Web Storage 和 IndexedDB；通过同源空白主文档在业务脚本执行前恢复，快照限制为 5 MiB 且只存放在 chrome.storage.session。
4. PlayerManager 接入批次 prepare/finalize 生命周期，执行历史只保存模式、重置次数和导航决策，不保存 Context、target、tab、Cookie 或快照。
5. Service Worker 增加能力探测及 BEGIN/END/ABORT 协议，并在重启后先校验 batchId 与 executionCapability、再清理遗留 Context；清理不能确认时保留元数据供重试。
6. 扩展 ACK 回传请求 nonce，前端可精确匹配并发消息，同时兼容未回传 nonce 的旧扩展。
7. 增加驱动、认证状态、三模式生命周期、故障恢复及审计脱敏测试，并补充 README 和产品更新日志。

## 验证

- node --test tests/*.test.js：53/53 通过。
- node --check 对 background.js、content/bridge.js、modules/player-manager.js 和三个新增 CDP 模块检查通过。
- git diff --check：通过。
- Playwright Runner `npm run check`、87 个单元测试和 3 个会话集成测试通过。
- Admin 主代码打包通过；两个目标测试类受模块内既有测试源码编译错误阻断，未开始执行。
- admin-ui `pnpm typecheck` 与生产构建通过。
- 真实 Chrome 125+ BrowserContext 门禁尚未执行：Chrome 正在运行且 Native Host 正常，但 ChatGPT Chrome 扩展已被禁用，自动化连接不可用。未将模拟测试结果记作真实浏览器验收通过。

## 具体代码改动

### README.md

```diff
@@
 ## 安装方法

+三种批量回放用例会话依赖 Chrome 125 及以上版本提供的 CDP flat session。低版本 Chrome 或能力探测未通过时，只保留“使用当前浏览器”的旧版兼容回放，不会静默降级为其他会话模式。
@@
+### Admin 批量回放用例会话
+
+- **每条用例独立登录（默认）**：每条用例创建独立 BrowserContext，用例结束后销毁，登录态和站点存储不跨用例保留。
+- **复用上一条用例的登录态**：每条用例仍使用新的 BrowserContext；仅在上一条用例成功时，将 Cookie、localStorage、sessionStorage 和 IndexedDB 快照恢复到下一条用例。
+- **同一浏览器窗口连续执行**：批次内复用同一个 BrowserContext 和活动标签页；用例失败或目标页丢失时重置上下文。
```

### docs/changelog.md

```diff
@@
 ## 2026-08

+- CDP 批量回放新增“每条用例独立登录”“复用上一条用例的登录态”“同一浏览器窗口连续执行”三种用例会话模式；失败时重置受影响上下文，认证快照仅在扩展会话内保存，并保留旧版当前浏览器兼容模式。
 - 修复步骤数量超出限额时，保存步骤变少的问题。
```

### manifest.json

```diff
@@
 {
   "manifest_version": 3,
+  "minimum_chrome_version": "125",
   "name": "CueCast",
```

### background.js

```diff
@@
 import { ApiClient } from './modules/api-client.js';
+import { CdpBatchSessionManager } from './modules/cdp-batch-session-manager.js';
@@
 const player = new PlayerManager(state, api);
+const cdpBatchSessions = new CdpBatchSessionManager(chrome);
@@
+    case 'AT_PLATFORM_CDP_CAPABILITIES':
+      cdpBatchSessions.probeCapabilities(tabId, sender.tab?.url)
+        .then(sendResponse)
+        .catch((e) => sendResponse({
+          ok: false,
+          managedBrowserContext: false,
+          supportedSessionModes: ['legacy-profile'],
+          error: e.message || String(e),
+        }));
+      return true;
@@
-      cdpBatchSessions.endBatch(message.batchId, message.executionCapability)
+      cdpBatchSessions.endBatch(message.batchId, message.executionCapability, tabId)
```

### content/bridge.js

```diff
@@
       || data.type === 'AT_PLATFORM_CLOSE_PLAY_TAB'
+      || data.type === 'AT_PLATFORM_CDP_CAPABILITIES'
+      || data.type === 'AT_PLATFORM_BEGIN_PLAYBACK_BATCH'
+      || data.type === 'AT_PLATFORM_END_PLAYBACK_BATCH'
+      || data.type === 'AT_PLATFORM_ABORT_PLAYBACK_BATCH'
       || data.type === 'AT_PLATFORM_CHECK_SELECTOR'
@@
-          { type: 'AT_PLATFORM_ACK', original: data.type, response, testCaseId: data.testCaseId, purpose: data.purpose || '' },
+          { type: 'AT_PLATFORM_ACK', original: data.type, nonce: data.nonce, response, testCaseId: data.testCaseId, purpose: data.purpose || '' },
```

### modules/player-manager.js

```diff
@@
+/** 执行历史只保存会话决策，不保存 Context、target、tab 或认证状态标识。 */
+function buildSessionTransitionAudit(transition, opts = {}) {
+  const source = transition && typeof transition === 'object' ? transition : {};
+  const requestedMode = String(source.requestedMode || opts.sessionMode || '');
+  const appliedMode = String(source.appliedMode || opts.sessionMode || '');
+  const browserSessionSource = String(source.browserSessionSource || opts.browserSessionSource || '');
+  if (!requestedMode && !appliedMode && !browserSessionSource) return null;
+  return {
+    requestedMode,
+    appliedMode,
+    browserSessionSource,
+    reset: source.reset === true,
+    resetCount: Number(source.resetCount) || 0,
+    resetReason: String(source.resetReason || ''),
+    navigationDecision: String(source.navigationDecision || opts.navigationDecision || ''),
+    authStateCommitted: source.authStateCommitted === true,
+  };
+}
```

### modules/cdp-browser-context-driver.js

```diff
@@
+/**
+ * 通过 chrome.debugger 的 browser target session 管理独立 BrowserContext。
+ * 该驱动不会调用 browsingData，也不会删除用户当前 Profile 中的任何状态。
+ */
+export class CdpBrowserContextDriver {
+  constructor(chromeApi = globalThis.chrome) {
+    this.chrome = chromeApi;
+    this.anchorTabId = null;
+    this.browserSessionId = '';
+    this.contextIds = new Set();
+    this.targetIds = new Set();
+  }
```

### modules/cdp-auth-state.js

```diff
@@
+const DEFAULT_SNAPSHOT_LIMIT_BYTES = 5 * 1024 * 1024;
@@
+export class CdpAuthStateService {
+  constructor(chromeApi = globalThis.chrome, { snapshotLimitBytes = DEFAULT_SNAPSHOT_LIMIT_BYTES } = {}) {
+    this.chrome = chromeApi;
+    this.snapshotLimitBytes = snapshotLimitBytes;
+  }
```

### modules/cdp-batch-session-manager.js

```diff
@@
+const MANAGED_SESSION_MODES = new Set(['isolated', 'reuse-auth', 'reuse-browser']);
@@
+/**
+ * 管理一个扩展 CDP 批次的浏览器状态边界。
+ * Admin 只接收脱敏转换结果；Context、Cookie 和认证快照始终留在扩展本机内存/session storage。
+ */
+export class CdpBatchSessionManager {
+  constructor(chromeApi = globalThis.chrome, dependencies = {}) {
+    this.chrome = chromeApi;
+    this.driverFactory = dependencies.driverFactory || (() => new CdpBrowserContextDriver(chromeApi));
+    this.authState = dependencies.authState || new CdpAuthStateService(chromeApi);
+    this.driver = null;
+    this.batch = null;
+    this.authSnapshot = null;
+    this.cachedCapabilities = null;
+  }
@@
+  async cleanupStoredBatch(batchId, executionCapability, sourceTabId) {
+    const stored = await this.chrome.storage.session.get(SESSION_METADATA_KEY).catch(() => ({}));
+    const metadata = stored?.[SESSION_METADATA_KEY];
+    if (!metadata) {
+      await this.clearStoredSession();
+      return;
+    }
+    const candidateHash = await sha256(executionCapability);
+    if (!candidateHash || candidateHash !== metadata.executionCapabilityHash) {
+      const error = new Error('CDP executionCapability 与遗留批次会话不匹配');
+      error.code = 'CDP_EXECUTION_CAPABILITY_MISMATCH';
+      throw error;
+    }
+  }
```

### tests/v1_2_merge_contract.test.js

```diff
@@
   const commands = [
     'AT_PLATFORM_DISCARD_RECORDING_SAVE',
+    'AT_PLATFORM_CDP_CAPABILITIES',
+    'AT_PLATFORM_BEGIN_PLAYBACK_BATCH',
+    'AT_PLATFORM_END_PLAYBACK_BATCH',
+    'AT_PLATFORM_ABORT_PLAYBACK_BATCH',
     'AT_PLATFORM_CHECK_SELECTOR',
   ];
@@
+  assert.match(bridge, /original: data\.type, nonce: data\.nonce/);
```

### tests/cdp-browser-context-driver.test.js

```diff
@@
+test('能力探测通过 browser child session 创建并清理两个 BrowserContext', async () => {
+  const harness = createHarness();
+  const driver = new CdpBrowserContextDriver(harness.chrome);
+
+  const result = await driver.probe(1, 'https://admin.example/scenes');
+
+  assert.equal(result.managedBrowserContext, true);
+  assert.deepEqual(result.supportedSessionModes, ['isolated', 'reuse-auth', 'reuse-browser']);
+  assert.deepEqual(harness.disposed, ['context-2', 'context-1']);
```

### tests/cdp-auth-state.test.js

```diff
@@
+test('reuse-auth 在同一候选标签页依次恢复各 origin 的 sessionStorage', async () => {
+  const navigations = [];
+  const closedTargets = [];
+  const chrome = {
+    scripting: {
+      async executeScript(options) {
+        assert.equal(options.target.tabId, 101);
+        return [{ result: { ok: true } }];
+      },
+    },
+  };
```

### tests/cdp-batch-session-manager.test.js

```diff
@@
+test('reuse-browser 成功复用最终活动页，失败后整 Context 重建', async () => {
+  const harness = createHarness();
+  await begin(harness.manager, 'reuse-browser');
+
+  const first = await harness.manager.prepareCase({
+    batchId: 'batch-reuse-browser',
+    executionCapability: EXECUTION_CAPABILITY,
+    startUrl: 'https://app.example/login',
+  });
+  harness.tabs.get(first.tabId).url = 'https://app.example/home';
@@
+test('Service Worker 重启后的 END 先校验执行能力再清理遗留 Context', async () => {
+  const harness = createHarness();
+  await begin(harness.manager, 'isolated');
+  await harness.manager.prepareCase({
+    batchId: 'batch-isolated',
+    executionCapability: EXECUTION_CAPABILITY,
+    startUrl: 'https://app.example/login',
+  });
+  harness.manager.batch = null;
+  harness.manager.driver = null;
@@
+test('reuse-auth 将成功注销后的空认证状态传播给下一条用例', async () => {
+  const harness = createHarness();
+  harness.manager.authState.capture = async ({ lastUrl }) => ({
+    version: 1,
+    marker: lastUrl.endsWith('/logged-out') ? 'logged-out' : 'logged-in',
+    lastUrl,
+    cookies: lastUrl.endsWith('/logged-out') ? [] : [{ name: 'sid', value: 'active' }],
+    origins: [],
+  });
@@
+  assert.equal(harness.restores.at(-1).marker, 'logged-in');
+  harness.tabs.get(second.tabId).url = 'https://app.example/logged-out';
```

### tests/cdp-session-audit-contract.test.js

```diff
@@
+test('执行历史会话审计白名单不包含浏览器内部标识或认证状态', async () => {
+  const source = await readFile(path.join(projectRoot, 'modules/player-manager.js'), 'utf8');
+  const start = source.indexOf('function buildSessionTransitionAudit');
+  const end = source.indexOf('\n}\n', start) + 3;
+  const auditFunction = source.slice(start, end);
+
+  assert.ok(start >= 0 && end > start);
@@
+  assert.doesNotMatch(auditFunction, /contextId|targetId|tabId|cookie|snapshot/i);
+});
```

# 2026-08-11 新增 CueCast 产品更新日志

## 涉及文件

- docs/changelog.md
- README.md
- commit/git-commit-log.md

## 变更原因

CueCast 项目缺少面向使用者的产品更新日志，2026 年 5 月至 8 月的功能新增、体验优化和问题修复没有统一的仓库内文档入口。

## 变更内容

1. 新增产品更新日志，按时间倒序记录 2026-08、2026-07、2026-06 和 2026-05 的更新内容。
2. 在 README 文档区增加更新日志和录制、回放与定位说明入口，方便从项目首页访问文档。

## 验证

- 本地 Markdown 结构校验通过：一级标题正确，月份按 `2026-08` 至 `2026-05` 倒序排列，各月条目数分别为 6、26、21、11。
- README 中 `docs/changelog.md` 链接目标存在。
- `git diff --check -- README.md` 通过；当前会话未连接 VibeAround，未执行浏览器 Markdown 预览。

## 具体代码改动

### `docs/changelog.md`

```diff
@@
+# 官方更新日志
+
+## 2026-08
+
+- 修复步骤数量超出限额时，保存步骤变少的问题。
+- 优化分组卡片 Base URL 展示：仅在超出宽度时省略。
+- 修复视觉隐藏的单选框和复选框回放。
+- 录制面板支持「记录悬浮」，可为需要 hover 才显示的菜单或浮层手动生成悬浮步骤。
+- 支持在创建用例时设置执行窗口尺寸。
+- 支持在用例列表页编辑分组详情。
@@
+## 2026-07
@@
+## 2026-06
@@
+## 2026-05
```

### `README.md`

```diff
@@
 Manifest V3 Chrome 扩展，实现录制与回放功能。

+## 文档
+
+- [更新日志](docs/changelog.md)
+- [录制、回放与定位说明](docs/recording-playback-and-locators.md)
+
 ## 安装方法
```

# 2026-08-11 修复通知断言 XPath 偏移与 Runner 浮层过滤

## 涉及文件

- content/recorder.js
- tests/v1_2_merge_contract.test.js
- ../sakura-playwright/src/runner/semantic-locator-resolver.js
- ../sakura-playwright/tests/integration/semantic-locator.test.js
- ../sakura-playwright/docs/playwright-runner-stage-completion.md
- commit/git-commit-log.md

## 变更原因

用户提供的真实 Trace 显示，Element UI toast 在断言步骤开始后曾经可见，`p.el-message__content` 首轮查询实际命中 1 个元素，但 Runner 因录制端保存的 `overlay=true` 与自身浮层识别规则不一致而将其过滤；toast 消失后最终诊断只保留了 0/0。与此同时，CueCast 录制工具栏是 `body` 直属 `div`，被绝对 XPath 计算计入下标，导致同一通知在录制页为 `/html/body/div[6]/p`、回放页为 `/html/body/div[5]/p`。

## 变更内容

1. CueCast 计算 XPath 时忽略扩展自身 `__at_*` 节点，保持录制定位与无扩展回放 DOM 的下标一致。
2. CueCast 为 `p` 通知元素增加精确文本候选，保留 CSS/XPath 之外的回退定位事实。
3. Runner 补齐 Element/Ant/Naive 通知类浮层，并兼容直属 `body` 的 fixed/absolute 浮层判定，使已命中的通知不再被错误过滤。
4. 增加录制器契约测试和 Runner 固定通知浮层集成测试，并同步阶段完成记录。

## 验证

- `node --test tests/*.test.js`：CueCast 31/31 通过。
- `npm run check`：Runner 通过。
- `npm run test:unit`：86/86 通过。
- `npm run test:locator`：15/15 通过。
- 独立 CLI 真实复跑因 Admin 返回 401 登录态过期未进入浏览器步骤；未将该环境阻塞误判为代码结果。

## 具体代码改动

### `content/recorder.js`

```diff
@@
-    // 文本候选：用于按钮、链接、菜单项等语义动作的回退定位
+    // 文本候选：用于按钮、链接、菜单项和通知文本等语义动作的回退定位
@@
-    if (text && ['button', 'a', 'li', 'label', 'span', 'div'].includes(tag)) {
+    if (text && ['button', 'a', 'li', 'label', 'span', 'div', 'p'].includes(tag)) {
@@
+  function isRecorderOwnedElement(node) {
+    return node?.nodeType === Node.ELEMENT_NODE
+      && String(node.id || '').startsWith('__at_');
+  }
@@
-      const siblings = Array.from(cur.parentNode?.children || []).filter(s => s.tagName === cur.tagName);
+      const siblings = Array.from(cur.parentNode?.children || [])
+        .filter(s => s.tagName === cur.tagName && !isRecorderOwnedElement(s));
```

### `tests/v1_2_merge_contract.test.js`

```diff
@@
+test('录制器定位信息不受扩展 UI 干扰并支持通知文本回退', async () => {
+  const recorder = await readFile(projectFile('content/recorder.js'), 'utf8');
+  assert.match(recorder, /function isRecorderOwnedElement\(node\)/);
+  assert.match(recorder, /!isRecorderOwnedElement\(s\)/);
+  assert.match(recorder, /\['button', 'a', 'li', 'label', 'span', 'div', 'p'\]\.includes\(tag\)/);
+});
```

### `../sakura-playwright/src/runner/semantic-locator-resolver.js`

```diff
@@
-    const overlay = element.closest?.('[role="dialog"],[role="alertdialog"],dialog,.ant-modal,.ant-modal-wrap,.el-dialog,.el-overlay,.el-popper,.ant-select-dropdown,.ivu-select-dropdown,.n-modal,[data-overlay="true"]');
+    let overlay = element.closest?.('[role="dialog"],[role="alertdialog"],dialog,.ant-modal,.ant-modal-wrap,.el-dialog,.el-overlay,.el-popper,.el-message,.ivu-select-dropdown,.ivu-message-notice,.ant-select-dropdown,.ant-message-notice,.n-modal,.n-message,[data-overlay="true"]');
+    if (!overlay) {
+      // Element UI Message 等通知直接挂在 body 且使用 fixed/absolute，录制端也按此规则标记浮层。
+      let current = element;
+      while (current && current !== document.body) {
+        if (current.parentElement === document.body) {
+          const style = window.getComputedStyle(current);
+          if (['fixed', 'absolute'].includes(style.position)) {
+            overlay = current;
+            break;
+          }
+        }
+        current = current.parentElement;
+      }
+    }
```

### `../sakura-playwright/tests/integration/semantic-locator.test.js`

```diff
@@
+test('Element Message fixed overlay remains eligible for an element assertion', async () => {
+  const page = await browser.newPage();
+  await page.setContent(`
+    <div class="el-message" style="position: fixed; top: 20px; left: 20px; display: block;">
+      <p class="el-message__content">系统无证书，请上传证书</p>
+    </div>
+  `);
+  const step = {
+    action_type: 'assert_element_match',
+    target_selector: 'p.el-message__content',
+    target_xpath: '/html/body/div[5]/p',
+    value: '系统无证书，请上传证书',
+    read_mode: 'text',
+    match_mode: 'contains',
+  };
+  const meta = {
+    version: 1,
+    candidates: [
+      { type: 'css_fallback', value: 'p.el-message__content', score: 0.72 },
+      { type: 'xpath_fallback', value: '/html/body/div[6]/p', score: 0.42 },
+    ],
+    context: { overlay: true, tag: 'p' },
+  };
+
+  const resolved = await resolveSemanticLocator(page, step, { timeoutMs: 500 }, meta);
+
+  assert.equal(resolved.matchedCount, 1);
+  assert.equal(resolved.visibleCount, 1);
+  assert.equal(await resolved.locator.textContent(), '系统无证书，请上传证书');
+  assert.equal(resolved.diagnostics.selected.source, 'locator_meta.candidates[0]');
+  await page.close();
+});
```

### `../sakura-playwright/docs/playwright-runner-stage-completion.md`

```diff
@@
+## 2026-08-11：Element Message 断言定位一致性修复
+
+### 完成情况
+
+| 事项 | 结果 |
+| --- | --- |
+| Element UI 通知浮层识别 | Runner 与 CueCast 对直属 `body` 的 `fixed/absolute` 通知使用同一浮层规则，`el-message` 不再因 `overlay=true` 被错误过滤 |
+| 录制 XPath 稳定性 | CueCast 计算绝对 XPath 时忽略自身 `__at_*` 工具栏和弹窗节点，避免录制页与回放页产生 `/div[6]` 与 `/div[5]` 的下标偏移 |
+| 通知文本回退 | `p` 元素断言保存 `text_exact` 和 `text_exact_tag` 候选，CSS/XPath 变化时仍可按通知文本定位 |
+
+### 验证
+
+- CueCast `node --test tests/*.test.js`：31/31 通过。
+- Runner `npm run check`：通过。
+- Runner `npm run test:unit`：86/86 通过。
+- Runner `npm run test:locator`：15/15 通过，新增固定 Element Message 浮层断言回归用例通过。
+- 用户执行 Trace `data/file/automation/playwright/AAS_P/V6.5B06D011/AAS_P_SMOKE_001/SCENE_CASE_006/20260811/20260811150048` 已确认 CSS 首轮命中但被浮层语义过滤；修复后本地回归复现为 `1/1`。
```

# 2026-08-10 同步 Playwright 专属下载断言目录字段契约

## 涉及文件

- .gitattributes
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

Admin 操作目录新增仅由 Playwright Runner 执行的“点击并校验浏览器下载文件”方法，目录表单字段总数由 117 增加到 124。CueCast 仍只执行原 63 个跨执行器方法，但通用执行详情契约会遍历完整目录表单，因此需要同步字段总数断言，避免把合法的 Playwright 专属字段误判为目录回归。真实 Runner 验证同时发现文本下载 fixture 会被 Windows 自动转换为 CRLF，导致固定 SHA256 与仓库 LF blob 不一致，因此需要固定测试下载文件的行尾规则。

## 变更内容

1. 将完整操作目录的 `form_schema` 字段总数断言更新为 124。
2. 不修改 CueCast action 注册表、播放器或 Chrome 扩展执行能力，`assert_download` 仍仅由 Playwright Runner 执行。
3. 固定 test-lab 文本下载 fixture 使用 LF，并明确二进制下载 fixture 不参与文本行尾转换，保证下载摘要跨平台一致。

## 验证

- `node --test tests/operation-contract.test.js`：通过，11/11。
- Playwright Runner case 290：通过；文件名、MIME、大小、文本内容和 SHA256 校验均成功。

## 具体代码改动

### `.gitattributes`

```diff
@@
+/test-lab/downloads/*.txt text eol=lf
+/test-lab/downloads/*.bin binary
```

### `tests/operation-contract.test.js`

```diff
@@
-  assert.equal(fieldCount, 117);
+  assert.equal(fieldCount, 124);
```

# 2026-08-08 修复录制动作运行适配、变量解析与 Admin 回传重试

## 涉及文件

- modules/player-manager.js
- modules/recorder-manager.js
- modules/variable-context.js
- modules/api-client.js
- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- tests/v1_2_merge_contract.test.js
- ../sakura-playwright/src/runner/step-runner.js
- ../sakura-playwright/tests/unit/operation-diagnostics.test.js
- commit/git-commit-log.md

## 变更原因

v1.2.0 录制数据仍保留 `set_variable`、`assert_text` 等原始 action，但 CDP 回放和 Admin 结果契约使用 canonical action。旧运行路径直接执行原始动作，导致定位适配方法缺失、变量步骤无法执行、`{{name}}` 被误判为变量名，以及结构化结果缺步被错误显示为跳过。变量生产步骤还会在写入上下文前预解析下一步引用，导致旧录制在保存变量后仍报变量不存在。

## 变更内容

1. `PlayerManager` 在运行副本中将录制变量和元素断言转换为 `global_variable_set`、`assert_element_match`，保留原始步骤和来源标记。
2. 恢复 CDP `via` 定位摘要生成，并让运行态变量解析同时兼容 `${name}` 和 `{{name}}`。
3. 变量上下文忽略诊断描述等步骤身份字段，避免把说明文本中的占位符当成运行引用。
4. 执行详情来源识别同时支持 `${name}` 和 `{{name}}`，避免双花括号引用显示为普通字面量。
5. Admin Playwright 结果回传仅对网络/超时故障重试，业务错误保持立即失败。
6. 变量、基础设施和验证码步骤不再提前解析下一步，确保当前步骤完成后再解析后置变量引用。
7. CDP 与 Playwright 元素文本断言统一忽略不可见字符、非断行空格和连续展示空白；正则仍使用原始文本。
8. 录制结束事件增加唯一 `eventId`，中台多实例只处理一次成功/失败提示。
9. CDP 导航开始日志显示实际起始 URL。
10. 增加录制动作适配、双格式变量、后置引用和文本断言契约测试。

## 验证

- `node --check modules/player-manager.js && node --check modules/variable-context.js && node --check modules/api-client.js`：通过。
- `node --test tests/*.test.js`：30/30 通过；保存变量后置引用、文本规范化和结束事件去重回归测试通过。
- `node --test`（sakura-playwright 变量与诊断单元测试）：25/25 通过。
- `node --test tests/v1_2_merge_contract.test.js`：8/8 通过；结束事件 `eventId` 契约通过。
- Admin `AutomationPlaywrightCaseServiceImplTest`：24/24 通过；结构化结果缺步会标记失败而非跳过。
- admin-ui `pnpm typecheck`：通过；目标组件 ESLint 仍报告文件原有模板缩进/风格问题，本轮新增逻辑无类型错误。

## 具体代码改动

### `modules/player-manager.js`

```diff
@@
-        const runtimeVariableReferences = variableContext.describeReferencesForStep(step);
-        const localResolvedStep = variableContext.resolveStep(PlayerManager._resolveDynamicStepValue(step));
+        const executableDefinitionStep = PlayerManager._adaptRecordedStep(step);
+        const runtimeVariableReferences = variableContext.describeReferencesForStep(executableDefinitionStep);
+        const localResolvedStep = variableContext.resolveStep(PlayerManager._resolveDynamicStepValue(executableDefinitionStep));
@@
+  static _adaptRecordedStep(step) {
+    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
+    const action = String(step.action_type || '').trim().toLowerCase();
+    const meta = PlayerManager._parseLocatorMetaObject(step.locator_meta);
+    if (action === 'set_variable') {
+      const variable = meta?.context?.variable;
+      if (!variable || typeof variable !== 'object' || Array.isArray(variable)) return { ...step };
+      return {
+        ...step,
+        action_type: 'global_variable_set',
+        original_action_type: 'set_variable',
+        recording_source: 'cuecast-v1.2',
+        variable_name: String(variable.name ?? step.value ?? '').trim(),
+      };
+    }
```

```diff
@@
-        const runtimeNextStep = steps[i + 1]
+        const runtimeNextStep = steps[i + 1] && PlayerManager._shouldResolveNextStepBeforeCurrent(executableDefinitionStep)
           ? PlayerManager._resolveRuntimeVariablesWithTrace(
```

```diff
@@
-    const a = String(actual ?? '');
-    const e = String(expected ?? '');
+    const a = PlayerManager._normalizeAssertionText(rawActual);
+    const e = PlayerManager._normalizeAssertionText(rawExpected);
@@
+      `原始长度: 期望 ${String(expected ?? '').length}，实际 ${String(actual ?? '').length}`,
```

### `modules/recorder-manager.js`

```diff
@@
     this._broadcastToContentScripts({
       type: 'AT_RECORDING_END',
+      eventId: payload?.eventId || `recording_end_${Date.now()}_${Math.random().toString(16).slice(2)}`,
       ...payload,
     });
```

### `tests/v1_2_merge_contract.test.js`

```diff
@@
+test('录制结束事件携带唯一 eventId，便于中台多实例去重', () => {
+  const manager = new RecorderManager({}, {});
+  let message = null;
+  manager._broadcastToContentScripts = (payload) => { message = payload; };
+  manager._broadcastRecordingEnd({ testCaseId: 'CASE-1', saved: true });
+  assert.match(message.eventId, /^recording_end_/);
+});
```

### `modules/variable-context.js`

```diff
@@
   'step_index',
   'action_type',
+  'original_action_type',
+  'recording_source',
+  'description',
@@
-    if (typeof value !== 'string' || !value.includes('${')) return value;
-    const whole = value.match(/^\$\{([^{}]+)}$/);
+    if (typeof value !== 'string' || (!value.includes('${') && !value.includes('{{'))) return value;
+    const whole = value.match(/^\$\{([^{}]+)}$/) || value.match(/^\{\{([^{}]+)}}$/);
```

### `modules/api-client.js`

```diff
@@
-  saveAdminPlaywrightResult(caseKey, result, executionCapability = '') {
-    return this.request(
+  async saveAdminPlaywrightResult(caseKey, result, executionCapability = '') {
+    const maxAttempts = 2;
+    let lastError;
+    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
+      try {
+        return await this.request(
@@
-    );
+      } catch (error) {
+        lastError = error;
+        const message = String(error?.message || '');
+        const retryable = message.includes('超时')
+          || message.includes('fetch')
+          || message.includes('Network')
+          || message.includes('abort');
+        if (!retryable || attempt >= maxAttempts) throw error;
+        await new Promise((resolve) => setTimeout(resolve, 500));
+      }
+    }
+    throw lastError;
```

### `modules/operation-diagnostics.js`

```diff
@@
-  if (typeof configured === 'string' && /\$\{[^{}]+}/.test(configured)) {
-    const reference = configured.match(/\$\{([^{}]+)}/)?.[1];
+  if (typeof configured === 'string' && (/\$\{[^{}]+}/.test(configured) || /\{\{[^{}]+}}/.test(configured))) {
+    const reference = configured.match(/\$\{([^{}]+)}/)?.[1]
+      || configured.match(/\{\{([^{}]+)}}/)?.[1];
     return sourceObject('variable_reference', reference ? `引用变量：${reference}` : null);
```

### `tests/operation-contract.test.js`

```diff
@@
+test('CueCast 变量上下文兼容双花括号并忽略步骤描述', () => {
+  const context = new CuecastVariableContext({ order: { id: 42 }, token: 'abc' });
+
+  assert.equal(context.resolveText('{{order.id}} / ${token}'), '42 / abc');
+  assert.deepEqual(context.referencesInStep({
+    action_type: 'assert_element_match',
+    description: '断言元素包含 {{token}}',
+    expect: '{{order.id}}-${token}',
+  }), ['order.id', 'token']);
+});
```

# 2026-08-07 统一录制变量与元素断言的 CueCast CDP 执行契约

## 涉及文件

- modules/player-manager.js
- modules/canonical-action-registry.js
- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- tests/cuecast-recording-compatibility.test.js
- test-lab/mock-data/cases.json
- commit/git-commit-log.md

## 变更原因

录制插件的新版本会生成 `set_variable` 和带 `locator_meta.context.assertion` 的 `assert_text`。后端将它们投影为统一动作后，CueCast 需要继续以 CDP 作为默认执行方式，并与 Playwright Runner 共用 `global_variable_set`、`assert_element_match` 契约。旧代码只允许少量交互动作进入 CDP，元素断言也没有统一处理真实可见性、输入控件 value 和非法正则，导致同一录制步骤在不同执行器中的结果不一致。

## 变更内容

1. CueCast 动作注册表升级到 `2026-08-07.1`，注册 `assert_element_match` 并声明 CDP 路由。
2. `PlayerManager` 改为依据统一动作注册表判断 CDP 能力，元素定位、变量读取和断言复用同一 CSS/XPath 回退链。
3. 元素断言支持 `contains`、`equals`、`not_contains`、`regex`、`visible`，支持 `auto/text/value` 读取模式，并检查元素及祖先的实际可见性。
4. 兼容录制原始 `locator_meta.context.assertion` 和标准化后的 `match_mode/read_mode/expect`，非法正则在执行前返回明确错误。
5. 契约测试同步 63 操作目录，并新增 CueCast 录制变量与断言兼容测试。
6. 新增 test-lab case 298，使用录制原始步骤验证 Runner 变量输入和五种元素断言。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --check modules/canonical-action-registry.js`：通过。
- `node --check modules/operation-diagnostics.js`：通过。
- `node --test tests/operation-contract.test.js tests/cuecast-recording-compatibility.test.js tests/v1_2_merge_contract.test.js tests/effective-execution-config.test.js`：24/24 通过。
- `node --test tests/integration/cuecast-recording-mock-case.test.js`（在 `sakura-playwright` 执行）：通过；真实 Chromium 从 CueCast `cases.json` 读取 case 298，变量保存、变量引用和五种元素断言共 8 个步骤全部成功，结果仅回传内存 mock 服务，未改写测试数据。

## 具体代码改动

### `modules/player-manager.js`

```diff
@@
   _canUseCDP(step) {
-    return [
-      'click',
-      'double_click',
-      'right_click',
-      'input',
-      'select',
-      'key',
-      'scroll',
-      'hover',
-    ].includes(step.action_type);
+    return isCuecastCdpAction(step?.action_type);
   }
@@
+  static _buildElementAssertionExpr(selector, xpath, readMode = 'auto') {
+    const chain = PlayerManager._buildDomTargetChain(selector, xpath);
+    const normalizedReadMode = ['auto', 'text', 'value'].includes(String(readMode)) ? String(readMode) : 'auto';
+    return `(function(){
+      try {
+        var el = ${chain};
+        if (!el) return { ok: false, err: 'not_found' };
+        var visible = true;
+        var current = el;
+        while (current && current.nodeType === 1) {
+          var style = window.getComputedStyle(current);
+          if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) <= 0) {
+            visible = false;
+            break;
+          }
+          current = current.parentElement;
+        }
+        var rect = el.getBoundingClientRect();
+        if (el.hidden || !rect || rect.width <= 0 || rect.height <= 0 || el.getClientRects().length === 0) visible = false;
+        var tag = el.tagName && String(el.tagName).toLowerCase() || '';
+        var mode = ${JSON.stringify(normalizedReadMode)};
+        if (mode === 'auto') mode = (tag === 'input' || tag === 'textarea' || tag === 'select') ? 'value' : 'text';
+        var value = '';
+        if (mode === 'value') {
+          value = 'value' in el && el.value != null ? String(el.value) : '';
+        } else {
+          var text = el.innerText != null ? el.innerText : el.textContent;
+          value = text != null ? String(text) : '';
+        }
+        return { ok: true, visible: visible, value: value };
+      } catch (e) {
+        return { ok: false, err: e && e.message ? String(e.message) : 'error' };
+      }
+    })()`;
+  }
@@
+      case 'assert_element_match': {
+        await this._executeAssertTextStepCDP(tabId, step);
+        break;
+      }
```

### `modules/canonical-action-registry.js`

```diff
@@
-export const OPERATION_CATALOG_VERSION = '2026-07-30.1';
+export const OPERATION_CATALOG_VERSION = '2026-08-07.1';
@@
   { actionType: 'assert_text_regex', route: 'cdp' },
+  { actionType: 'assert_element_match', route: 'cdp' },
   { actionType: 'wait', route: 'content_player' },
```

### `modules/operation-diagnostics.js`

```diff
@@
   assert_text_regex: 'assertion',
+  assert_element_match: 'assertion',
   wait: 'wait',
```

### `tests/operation-contract.test.js`

```diff
@@
-  '../../sakura-admin/continew-automation/src/test/resources/automation/automation-operation-62-fixture.json',
+  '../../sakura-admin/continew-automation/src/test/resources/automation/automation-operation-63-fixture.json',
@@
-test('CueCast registry covers every canonical action in the 62-method fixture', () => {
+test('CueCast registry covers every canonical action in the 63-method fixture', () => {
   assert.equal(fixture.catalog_version, OPERATION_CATALOG_VERSION);
-  assert.equal(fixture.methods.length, 62);
+  assert.equal(fixture.methods.length, 63);
@@
-  assert.equal(fieldCount, 113);
+  assert.equal(fieldCount, 117);
```

### `tests/cuecast-recording-compatibility.test.js`

```diff
@@
+test('统一元素断言注册为 CDP action 并由 PlayerManager 使用同一注册表路由', () => {
+  const manager = createManager();
+
+  assert.equal(getCuecastActionRoute('assert_element_match'), 'cdp');
+  assert.equal(isCuecastCdpAction('assert_element_match'), true);
+  assert.equal(manager._canUseCDP({ action_type: 'assert_element_match' }), true);
+});
+
+test('隐藏元素不能通过 CueCast CDP 可见性断言', async () => {
+  const manager = createManager();
+  manager._waitForElementAssertionCDP = async () => ({ ok: true, visible: false, value: 'secret' });
+
+  await assert.rejects(() => manager._executeAssertTextStepCDP(1, {
+    action_type: 'assert_element_match',
+    target_selector: '#hidden',
+    read_mode: 'auto',
+    match_mode: 'visible',
+  }), /实际值: hidden/);
+});
```

### `test-lab/mock-data/cases.json`

```diff
@@
+    "298": {
+      "id": 298,
+      "name": "CueCast recording variable and assertion mock",
+      "status": "not_run",
+      "start_url": "http://127.0.0.1:4173/test-lab/target.html",
+      "description": "Raw CueCast v1.2 recording steps for Runner variable and five-mode assertion compatibility.",
+      "steps": [
+        {
+          "id": 1,
+          "action_type": "set_variable",
+          "target_selector": "#statusText",
+          "locator_meta": {
+            "context": {
+              "variable": {
+                "name": "recorded_status",
+                "source": "text",
+                "extract": { "mode": "regex", "pattern": "^(Ready)$", "group": 1 }
+              }
+            }
+          },
+          "value": "recorded_status",
+          "value_text": "Ready"
+        },
+        {
+          "id": 3,
+          "action_type": "assert_text",
+          "target_selector": "#username",
+          "locator_meta": {
+            "context": {
+              "assertion": { "target": "element", "source": "value", "match": "equals" }
+            }
+          },
+          "value": "${recorded_status}"
+        }
+      ]
+    },
@@
-    "297": []
+    "297": [],
+    "298": []
```

# 2026-08-07 合并官方 v1.2.0 并修复扩展检测、录制与回放回归

## 涉及文件

- README.md
- background.js
- content/bridge.js
- content/player.js
- content/recorder.js
- content/selector-core.js
- manifest.json
- modules/api-client.js
- modules/player-manager.js
- modules/recorder-manager.js
- tests/v1_2_merge_contract.test.js
- commit/git-commit-log.md

## 变更原因

合并官方 `v1.2.0` 时，`PlayerManager.start()` 的两套浏览器初始化和状态模型被错误拼接，产生 ESM 语法错误，导致 Manifest V3 Service Worker 无法加载，`AT_PLATFORM_PING` 监听器未注册，Admin 因而显示“未检测到”。同时合并结果还丢失了 Admin 录制导入、草稿重试、失败结果回传等既有链路，并出现重复响应、未定义保存上下文、预检失败不广播结束事件等回归。

## 变更内容

1. 修复 Service Worker 依赖模块语法错误和重复录制响应，恢复 `recordingImport`、窗口配置、草稿状态、失败重试及插件检测协议。
2. 合并官方 v1.2.0 的多标签录制、录制会话、运行时变量、AI/验证码、选择器稳定性和回放标签页管理能力。
3. 保留 Admin 专用录制导入和执行结果接口；Admin 录制不再访问官方 `/testcases/{id}`，失败草稿也不会降级写入错误数据源。
4. 统一 Player 预检失败的异常收尾，确保已接受的回放始终广播包含真实错误的 `AT_PLAYBACK_END`。
5. 扩展更新时强制替换已打开页面中的失效 bridge，后续重试保持幂等注入，减少必须手动刷新页面的情况。
6. 增加 v1.2 合并契约测试，覆盖后台真实加载/PING、bridge 协议、Admin/普通录制分流、Admin 录制完整保存和回放预检失败收尾。

## 验证

- `node --experimental-default-type=module --check` 检查 5 个 ESM 文件：通过。
- `node --check` 检查 8 个传统脚本文件：通过。
- `node --experimental-default-type=module --test tests/*.test.js`：19/19 通过。
- `git diff --check`、`git diff --cached --check`：通过，仅有工作区 LF/CRLF 转换提示。
- `rg -n "^(<<<<<<<|=======|>>>>>>>)"`：未发现冲突标记。

## 具体代码改动

### `README.md`

```diff
@@
-./
+sakura-cuecast/
 ├── manifest.json          - 插件配置（Manifest V3）
```

### `background.js`

```diff
@@
-async function injectBridgeIntoOpenTabs() {
+async function injectBridgeIntoOpenTabs({ force = false } = {}) {
@@
-  await Promise.all(tabs.map((tab) => injectBridgeIntoTab(tab.id)));
+  await Promise.all(tabs.map((tab) => injectBridgeIntoTab(tab.id, { force })));
@@
-  void injectBridgeIntoOpenTabs();
+  // 扩展升级后页面中的旧 bridge 已失效，首次回填必须清除旧版本留下的安装标记。
+  void injectBridgeIntoOpenTabs({ force: true });
```

### `content/bridge.js`

```diff
@@
       || data.type === 'AT_PLATFORM_CANCEL_RECORD'
+      || data.type === 'AT_PLATFORM_SAVE_RECORDING_TRIMMED'
+      || data.type === 'AT_PLATFORM_DISCARD_RECORDING_SAVE'
       || data.type === 'AT_PLATFORM_OPEN_PLAY_TAB'
       || data.type === 'AT_PLATFORM_CLOSE_PLAY_TAB'
+      || data.type === 'AT_PLATFORM_CHECK_SELECTOR'
@@
-          { type: 'AT_PLATFORM_ACK', original: data.type, response, testCaseId: data.testCaseId },
+          { type: 'AT_PLATFORM_ACK', original: data.type, response, testCaseId: data.testCaseId, purpose: data.purpose || '' },
```

### `content/player.js`

```diff
@@
-    if (isTextLikeField(el)) {
+    if (isTextLikeField(el) || el?.isContentEditable) {
@@
-    const target = ['page', 'element', 'error'].includes(String(raw.target || '')) ? String(raw.target) : (hasLocator ? 'element' : 'page');
-    const match = ['contains', 'equals', 'not_contains', 'regex'].includes(String(raw.match || '')) ? String(raw.match) : (hasLocator ? 'equals' : 'contains');
+    const target = ['page', 'element', 'error', 'url'].includes(String(raw.target || '')) ? String(raw.target) : (hasLocator ? 'element' : 'page');
+    const rawMatch = ['contains', 'equals', 'not_contains', 'regex', 'visible'].includes(String(raw.match || '')) ? String(raw.match) : (hasLocator ? 'equals' : 'contains');
+    const match = rawMatch === 'visible' && target !== 'element' ? 'contains' : rawMatch;
```

### `content/recorder.js`

```diff
@@
-  /** React/Ant Design/rc 组件等运行时自增 id，重渲染后会变，不能用于稳定定位 */
+  /** React/Vue/组件库等运行时自增 id，重渲染后会变，不能用于稳定定位 */
   function isVolatileAutoId(id) {
-    if (!id || typeof id !== 'string') return true;
-    if (/^\d+$/.test(id)) return true;
-    if (/[a-f0-9]{8,}/i.test(id)) return true;
+    const v = normalizeAttrValue(id);
+    if (!v) return true;
+    if (/^\d+$/.test(v)) return true;
+    if (/^[0-9]{10,}$/.test(v)) return true;
+    if (/^[a-f0-9]{8,}$/i.test(v)) return true;
@@
-    if (getOverlayAncestor(el)) return '';
+    if (getOptionItemElement(el)) return '';
```

### `content/selector-core.js`

```diff
@@
-    for (const attr of ['data-testid', 'data-test', 'data-id', 'name', 'aria-label', 'role']) {
+    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name', 'aria-label', 'role']) {
       const val = el.getAttribute(attr);
-      if (val) {
+      if (val && !isVolatileAttributeValue(attr, val)) {
@@
-            if (table && table.id && !/^\d+$/.test(table.id) && !/[a-f0-9]{8,}/i.test(table.id)) {
+            if (table && table.id && !isVolatileAutoId(table.id)) {
```

### `manifest.json`

```diff
@@
-  "version": "1.1.0",
+  "version": "1.2.0",
```

### `modules/api-client.js`

```diff
@@
-        throw new Error(`HTTP ${res.status} ${method} ${url}: ${message}`);
+        const err = new Error(`HTTP ${res.status} ${method} ${url}: ${message}`);
+        err.response = { status: res.status, data };
+        err.apiData = data;
+        if (data?.data && typeof data.data === 'object' && data.data.resource) {
+          err.quotaDetails = data.data;
+        }
+        throw err;
@@
+  createRecordingSession(id, body) { return this.request('POST', `/testcases/${id}/recording-sessions`, body || {}); }
+  saveRecordingSessionStep(id, sessionId, body) {
+    return this.request('POST', `/testcases/${id}/recording-sessions/${encodeURIComponent(sessionId)}/steps`, body || {});
+  }
```

### `modules/player-manager.js`

```diff
@@
       if (!steps.length) {
-        playbackOutcome = { ok: false, error: trByLocale(runLocale, '用例没有步骤', 'Case has no steps') };
-        return playbackOutcome;
+        throw new Error(trByLocale(runLocale, '用例没有步骤', 'Case has no steps'));
       }
@@
-        playbackOutcome = { ok: false, error: trByLocale(runLocale, '正在录制，无法回放', 'Recording in progress, playback is unavailable') };
-        return playbackOutcome;
+        throw new Error(trByLocale(runLocale, '正在录制，无法回放', 'Recording in progress, playback is unavailable'));
```

### `modules/recorder-manager.js`

```diff
@@
-    } else if (resolvedScreenshotMode === 'standard') {
+    } else if (resolvedScreenshotMode === 'standard' && !this._getRecordingImportOptions()) {
       // 未显式传入模式时，回退读取用例配置，兼容弹窗/旧调用链。
@@
-        await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
+        if (importOptions) {
+          await this._saveRecordedSteps(testCaseId, toSave, saveOptions);
+        } else if (this.state.recordingSessionEnabled && this.state.recordingSessionId && this.state.recordingSessionHealthy !== false) {
+          await this._commitRecordingSession(testCaseId);
+        } else {
+          await this._discardRecordingSession(testCaseId);
+          await this._saveRecordedSteps(testCaseId, toSave, null);
+        }
```

### `tests/v1_2_merge_contract.test.js`

```diff
--- /dev/null
+++ b/tests/v1_2_merge_contract.test.js
@@
+test('background service worker 可启动并响应插件检测 PING', async () => {
+  const originalChrome = globalThis.chrome;
+  const stub = createChromeStub();
+  globalThis.chrome = stub.chrome;
+  try {
+    await import(`${projectFile('background.js').href}?ping-contract-test`);
+    const listener = stub.runtimeOnMessage.listeners.at(-1);
+    assert.equal(typeof listener, 'function');
+  } finally {
+    globalThis.chrome = originalChrome;
+  }
+});
+
+test('Admin 录制启动和停止不会访问官方 testcase 接口', async () => {
+  const originalChrome = globalThis.chrome;
+  const stub = createChromeStub();
+  globalThis.chrome = stub.chrome;
+  try {
+    let getTestCaseCalls = 0;
+    let importedPayload = null;
+    const api = {
+      base: 'http://admin.local/api',
+      async getTestCase() {
+        getTestCaseCalls += 1;
+        throw new Error('Admin 录制不应读取官方 testcase');
+      },
+      async importRecording(payload) { importedPayload = payload; },
+    };
```

# 2026-08-06 CueCast 执行详情统一来源对象与目录字段

## 涉及文件

- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更原因

统一 CueCast 与 Playwright、Selenium 的 `details.operation` 参数来源结构，支持 Admin 下发的目录诊断字段元数据，避免同一个 `method_code` 在不同执行器中使用不同的来源格式和参数角色。

## 变更内容

1. `source` 统一输出 `{code,label}`，变量引用保留变量名提示，旧输入仍可由 Admin 兼容处理。
2. 优先读取 `diagnostic_fields` 生成字段标签、角色和受限展示，未下发时保留旧字段列表兼容。
3. 执行结果补充状态和事实中文标签，脚本、SQL、命令等受限内容继续不输出原值。
4. 兼容目录字段未下发时的回退字段列表，补齐 IP 范围和运行属性参数。
5. 增加 113 个 `form_schema` 字段的逐字段执行详情契约测试。

## 验证

- `node --check modules/operation-diagnostics.js`：通过。
- `node --experimental-default-type=module --test tests/*.test.js`：12/12 通过。

## 具体代码改动

### `modules/operation-diagnostics.js`

```diff
@@
 const URL_KEY = /(^|_)url$/i;
+const SOURCE_LABELS = Object.freeze({
+  variable_reference: '引用变量',
+  literal: '固定值',
+  runtime: '运行时',
+  definition_snapshot: '定义快照',
+  executor: '执行器返回',
+});
@@
     outcome: {
       kind: profile,
+      status: result.status || 'unknown',
@@
-  return INPUT_KEYS.map((key) => {
+  const fields = Array.isArray(definitionStep.diagnostic_fields)
+    ? definitionStep.diagnostic_fields.filter((field) => field && typeof field === 'object' && field.name)
+    : [];
+  const descriptors = fields.length
+    ? fields.map((field) => ({ key: String(field.name), field }))
+    : INPUT_KEYS.map((key) => ({ key, field: null }));
+  return descriptors.map(({ key, field }) => {
@@
-      role: inputRole(key),
+      ...(field?.label ? { label: String(field.label) } : {}),
+      role: inputRole(key, field),
@@
-    if (JSON.stringify(configured) !== JSON.stringify(effective)) return 'runtime';
+    if (JSON.stringify(configured) !== JSON.stringify(effective)) return sourceObject('runtime');
@@
+function sourceObject(code, label = null) {
+  return { code, label: label || SOURCE_LABELS[code] || code };
+}
+  'keep_trailing_zeros', 'ip_prefix', 'start', 'end', 'profile',
+]);
```

### `tests/operation-contract.test.js`

```diff
@@
-  assert.equal(command.source, 'definition_snapshot');
+  assert.deepEqual(command.source, { code: 'definition_snapshot', label: '定义快照' });
@@
-  assert.equal(result.details.operation.inputs.find((item) => item.key === 'format').source, 'literal');
+  assert.deepEqual(result.details.operation.inputs.find((item) => item.key === 'format').source, {
+    code: 'literal',
+    label: '固定值',
+  });
```

```diff
@@
 test('全部 62 个目录方法在 CueCast 中保持方法身份和 profile 契约', () => {
@@
 });
+
+test('所有目录 form_schema 字段都进入 CueCast 执行详情', () => {
+  let fieldCount = 0;
+  for (const type of catalog.types) {
+    for (const method of type.methods) {
+      const values = Object.fromEntries(method.form_schema.map((field) => [field.name, 'configured']));
+      const result = attachOperationDiagnostic(
+        { action_type: method.action_type, status: 'passed' },
+        { ...values, method_code: method.method_code, diagnostic_fields: method.form_schema },
+        { ...values, action_type: method.action_type },
+      );
+      assert.deepEqual(result.details.operation.inputs.map((input) => input.key), method.form_schema.map((field) => field.name));
+      fieldCount += method.form_schema.length;
+    }
+  }
+  assert.equal(fieldCount, 113);
+});
```

# 2026-08-06 CueCast 统一执行参数来源

## 涉及文件

- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更内容

1. 为所有 CueCast `details.operation.inputs` 增加统一 `source` 来源字段。
2. 变量引用、运行时解析、普通字面量和 SQL/命令/脚本定义快照分别使用稳定来源代码。
3. 增加变量参数和受限基础设施参数的来源契约断言。

## 验证

- `node --check modules/operation-diagnostics.js`：通过。
- `node --experimental-default-type=module --test tests/*.test.js`：11/11 通过。

## 具体代码改动

### `modules/operation-diagnostics.js`

```diff
@@
     const configured = readValue(definitionStep, key);
     const effective = readValue(runtimeStep, key);
     if (configured === undefined && effective === undefined) return null;
+    const source = inputSource(key, configured, effective);
@@
+      ...(source ? { source } : {}),
@@
+function inputSource(key, configured, effective) {
+  if (typeof configured === 'string' && /\$\{[^{}]+}/.test(configured)) return 'variable_reference';
+  if (configured !== undefined && effective !== undefined) {
+    if (JSON.stringify(configured) !== JSON.stringify(effective)) return 'runtime';
+    return RESTRICTED_KEY.test(key) ? 'definition_snapshot' : 'literal';
+  }
+  if (configured !== undefined) return RESTRICTED_KEY.test(key) ? 'definition_snapshot' : 'literal';
+  if (effective !== undefined) return 'runtime';
+  return '';
+}
```

### `tests/operation-contract.test.js`

```diff
@@
   const command = result.details.operation.inputs.find((item) => item.key === 'command');
   assert.equal(command.effective.value_state, 'restricted');
+  assert.equal(command.source, 'definition_snapshot');
@@
   assert.deepEqual(
     result.details.operation.inputs.map((item) => item.key),
     ['variable_name', 'format', 'date_mode', 'datetime', 'offset_seconds', 'timestamp_unit'],
   );
+  assert.equal(result.details.operation.inputs.find((item) => item.key === 'format').source, 'literal');
```

# 2026-08-06 CueCast 补齐变量步骤详情与等待倒计时日志

## 涉及文件

- modules/variable-context.js
- modules/player-manager.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更内容

1. 将全局变量执行结果和当前步骤引用变量的脱敏预览写入步骤级 `details`，Admin 执行详情可以直接展示变量名、实际值预览和来源。
2. 固定等待由回放管理器按秒广播倒计时日志，并将等待时长保留为结果事实；不再依赖内容脚本内部等待才能产生历史日志。
3. 增加变量引用详情契约测试，确认敏感变量不输出原值。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --check modules/variable-context.js`：通过。
- `node --experimental-default-type=module --test tests/*.test.js`：10/10 通过。

## 具体代码改动

### `modules/variable-context.js`

```diff
@@
   describe(name) {
@@
   }
+
+  describeReferencesForStep(step) {
+    return this.referencesInStep(step).map((reference) => {
+      const { root } = this._parseReference(reference);
+      const meta = this._metadata.get(root) || {};
+      const description = this.describe(reference);
+      return {
+        reference,
+        variable_name: root,
+        value_masked: meta.masked ? 1 : 0,
+        ...(meta.masked ? {} : { value_preview: description.value_preview }),
+        source: meta.source || '',
+      };
+    });
+  }
```

### `modules/player-manager.js`

```diff
@@
-      const appendStepResult = (step, index, status, startedAt, error = '', locator = null, executorResult = null) => {
+      const appendStepResult = (step, index, status, startedAt, error = '', locator = null, executorResult = null, stepDetails = {}) => {
@@
+          ...(Object.keys(details).length ? { details } : {}),
@@
+          if (actionType === 'wait') {
+            const configuredWait = executableStep.duration_ms ?? executableStep.value;
+            const waitDurationMs = configuredWait == null || configuredWait === ''
+              ? 1000
+              : Math.max(0, Number(configuredWait) || 0);
+            await this._waitWithCountdown(waitDurationMs, (remainingSeconds) => {
+              broadcastProgress('log', {
+                log: { level: 'info', phase: 'step', message: `步骤 ${i + 1}: ${runtimeStep.description || runtimeStep.action_type || '等待'}，正在执行：倒计时<${remainingSeconds}s>` },
+              });
+            });
+          }
```

### `tests/operation-contract.test.js`

```diff
@@
 import { attachOperationDiagnostic } from '../modules/operation-diagnostics.js';
+import { CuecastVariableContext } from '../modules/variable-context.js';
@@
+test('CueCast 变量引用详情只输出脱敏预览并保留来源', () => {
+  const context = new CuecastVariableContext({ order: 'ORD-001' });
+  context.set('token', 'secret-token', { source: 'step', masked: true });
+  assert.deepEqual(context.describeReferencesForStep({ action_type: 'input', value: '${order}-${token}' }), [
+    { reference: 'order', variable_name: 'order', value_masked: 0, value_preview: 'ORD-001', source: 'initial' },
+    { reference: 'token', variable_name: 'token', value_masked: 1, source: 'step' },
+  ]);
+});
```

# 2026-08-06 CueCast 执行摘要补充操作类型标签

## 涉及文件

- modules/operation-diagnostics.js
- commit/git-commit-log.md

## 变更内容

1. 统一执行摘要从 Admin 步骤快照透传 `type_label`，使 UI 能同时展示操作类型和操作方法。
2. 未提供类型标签的历史步骤继续只展示 `type_code` 或旧 action，不改变原有回放行为。

## 验证

- `node --check modules/operation-diagnostics.js`：通过。
- `node --experimental-default-type=module --test tests/*.test.js`：通过。

## 具体代码改动

### `modules/operation-diagnostics.js`

```diff
@@
       ...(firstText(definitionStep.type_code, definitionStep.typeCode)
         ? { type_code: firstText(definitionStep.type_code, definitionStep.typeCode) } : {}),
+      ...(firstText(definitionStep.type_label, definitionStep.typeLabel)
+        ? { type_label: firstText(definitionStep.type_label, definitionStep.typeLabel) } : {}),
       ...(firstText(definitionStep.method_code, definitionStep.methodCode)
```

# 2026-08-06 CueCast 全操作统一执行摘要适配

## 涉及文件

- modules/operation-diagnostics.js
- modules/player-manager.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更内容

1. 新增 CueCast/CDP 的统一 `details.operation` builder，按 8 类 profile 生成方法身份、输入摘要、目标摘要和有限结果事实。
2. 回放结果保留既有 `details.infrastructure` 等 typed facet，同时对 SQL、命令、脚本、路径、URL 敏感参数执行受限展示和脱敏。
3. 回放步骤统一附加 `executor=extension-cdp` 的执行摘要，旧 test-lab 与非 Admin 保存链路仍保留原结果字段。
4. 增加命令脱敏和 typed facet 保留契约测试。
5. 契约测试直接读取 Admin 目录的 62 个方法和 8 个 profile，逐方法校验 CueCast 的 method identity、profile 与 outcome kind。

## 验证

- `node --check modules/operation-diagnostics.js`：通过。
- `node --check modules/player-manager.js`：通过。
- `node --experimental-default-type=module --test tests/operation-contract.test.js`：3/3 通过。

## 具体代码改动

### `modules/operation-diagnostics.js`

```diff
--- /dev/null
+++ b/modules/operation-diagnostics.js
@@
+const ACTION_PROFILES = Object.freeze({
+  navigate: 'navigation',
+  switch_page: 'navigation',
+  close_page: 'navigation',
+  close_all_pages: 'navigation',
+  reload: 'navigation',
+});
+
+export function attachOperationDiagnostic(result, definitionStep = {}, runtimeStep = definitionStep, options = {}) {
+  if (!result || typeof result !== 'object') return result;
+  const details = result.details && typeof result.details === 'object' ? result.details : {};
+  const { operation_assertion: _operationAssertion, ...cleanResult } = result;
+  return {
+    ...cleanResult,
+    details: {
+      ...details,
+      operation: buildOperationDiagnostic(definitionStep, runtimeStep, result, options),
+    },
+  };
+}
```

### `modules/player-manager.js`

```diff
@@
 import {
   CuecastVariableContext,
@@
 } from './variable-context.js';
+import { attachOperationDiagnostic } from './operation-diagnostics.js';
@@
-        const result = {
+        let result = {
@@
           ...(error ? { error } : {}),
         };
+        result = attachOperationDiagnostic(result, step, step, { executor: 'extension-cdp' });
         stepResults.push(result);
```

### `tests/operation-contract.test.js`

```diff
@@
 import {
@@
 } from '../modules/canonical-action-registry.js';
+import { attachOperationDiagnostic } from '../modules/operation-diagnostics.js';
@@
 test('CueCast registry covers every canonical action in the 62-method fixture', () => {
@@
 });
+
+test('CueCast execution result adds the shared operation detail without exposing restricted input', () => {
+  const result = attachOperationDiagnostic(
+    {
+      action_type: 'server_command',
+      status: 'passed',
+      details: { infrastructure: { kind: 'SERVER_COMMAND', exitCode: 0 } },
+      exit_code: 0,
+    },
+    {
+      action_type: 'server_command',
+      method_code: 'server.shell',
+      command: 'curl -H "Authorization: Bearer secret-token" /health',
+    },
+  );
+  assert.equal(result.details.infrastructure.kind, 'SERVER_COMMAND');
+  assert.equal(result.details.operation.profile, 'infrastructure');
+  const command = result.details.operation.inputs.find((item) => item.key === 'command');
+  assert.equal(command.effective.value_state, 'restricted');
+  assert.equal(JSON.stringify(result).includes('secret-token'), false);
+});
```

### `tests/operation-contract.test.js`（62 方法合同补充）

```diff
@@
 const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
+const catalog = JSON.parse(fs.readFileSync(new URL(
+  '../../sakura-admin/continew-automation/src/main/resources/automation/automation-operation-catalog.json',
+  import.meta.url,
+), 'utf8'));
+const profileByMethod = Object.fromEntries(Object.entries(catalog.diagnostic_profiles)
+  .flatMap(([profile, methods]) => methods.map((methodCode) => [methodCode, profile])));
@@
+test('全部 62 个目录方法在 CueCast 中保持方法身份和 profile 契约', () => {
+  assert.equal(fixture.methods.length, 62);
+  for (const method of fixture.methods) {
+    const result = attachOperationDiagnostic(
+      { action_type: method.action_type, status: 'passed' },
+      {
+        catalog_version: fixture.catalog_version,
+        method_code: method.method_code,
+        action_type: method.action_type,
+      },
+    );
+    const operation = result.details.operation;
+    assert.equal(operation.catalog_version, fixture.catalog_version);
+    assert.equal(operation.method.method_code, method.method_code);
+    assert.equal(operation.profile, profileByMethod[method.method_code]);
+    assert.equal(operation.outcome.kind, profileByMethod[method.method_code]);
+  }
+});
```

# 2026-08-04 CueCast 批次冻结配置单一事实源

## 涉及文件

- modules/api-client.js
- modules/player-manager.js
- tests/effective-execution-config.test.js
- commit/git-commit-log.md

## 变更内容

1. Admin 批次回放强制读取绑定 revision 返回的 `EffectiveExecutionConfig`，缺失时明确拒绝，不再使用消息中的 URL、窗口或页面检测参数重算配置。
2. `browser_bootstrap_mode=none` 的纯基础设施用例完全跳过窗口、标签页、脚本注入和 debugger；混合用例继续按原步骤顺序执行浏览器与委派步骤。
3. 基础设施任务创建、轮询和取消统一携带短时 `X-Execution-Capability`，capability 不进入任务请求体或日志。
4. 服务端冻结的 step/case timeout 进入 CDP 定位等待和基础设施任务轮询上限，并在受控标签页切换后继续生效。
5. 执行结果原样回传冻结配置及 `sources`，保留 popup/test-lab 无批次回放的旧兼容行为。
6. 新增六项冻结配置契约测试，覆盖服务端配置优先、缺失拒绝、旧链路兼容、纯基础设施和 capability 传递。

## 验证

- `node --check modules/player-manager.js`：通过。
- `node --experimental-default-type=module --test tests/effective-execution-config.test.js tests/operation-contract.test.js`：7/7 通过。
- `sakura-admin-ui pnpm typecheck`：通过。
- `sakura-admin-ui pnpm build`：通过。
- Admin 全量回归：147/147 通过（automation 141 + project 6）；TestPlan 16/16 通过。

## 具体代码改动

### `modules/api-client.js`

```diff
-  createInfrastructureTask(payload) {
-    return this.request('POST', '/automation/infrastructure/tasks', payload, { timeoutMs: 30000 });
+  createInfrastructureTask(payload, executionCapability = '') {
+    return this.request('POST', '/automation/infrastructure/tasks', payload, {
+      timeoutMs: 30000,
+      executionCapability,
+    });
   }
-  getInfrastructureTask(taskId, afterSequence = 0) {
+  getInfrastructureTask(taskId, afterSequence = 0, executionCapability = '') {
     const query = afterSequence > 0 ? `?afterSequence=${encodeURIComponent(afterSequence)}` : '';
-    return this.request('GET', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}${query}`, null, { timeoutMs: 30000 });
+    return this.request('GET', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}${query}`, null, {
+      timeoutMs: 30000,
+      executionCapability,
+    });
   }
```

### `modules/player-manager.js`

```diff
-      const windowPreference = await resolveWindowPreference({
-        viewportMode: opts.viewportMode ?? testCase.window_size_mode ?? testCase.viewport_mode,
-        viewportWidth: opts.viewportWidth ?? testCase.viewport_width,
-        viewportHeight: opts.viewportHeight ?? testCase.viewport_height,
-        sourceWindowId: opts.sourceWindowId,
-      });
-      const pageErrorCheckEnabled = Number(opts.pageErrorCheckEnabled ?? testCase.page_error_check_enabled ?? 0) !== 0;
+      const windowPreference = browserBootstrap.initializeBrowser
+        ? await resolveWindowPreference({
+            viewportMode: runtimeConfig.windowSizeMode,
+            viewportWidth: runtimeConfig.viewportWidth,
+            viewportHeight: runtimeConfig.viewportHeight,
+            sourceWindowId: opts.sourceWindowId,
+          })
+        : { mode: 'none', width: null, height: null };
+      const pageErrorCheckEnabled = runtimeConfig.pageErrorCheckEnabled;
```

```diff
-    if (!this._implicitWaitMsByTab.has(tabId)) return fallback;
-    return this._implicitWaitMsByTab.get(tabId);
+    const implicit = this._implicitWaitMsByTab.has(tabId)
+      ? this._implicitWaitMsByTab.get(tabId)
+      : fallback;
+    const stepTimeout = this._stepTimeoutMsByTab.has(tabId)
+      ? this._stepTimeoutMsByTab.get(tabId)
+      : implicit;
+    const caseRemaining = this._caseDeadlineByTab.has(tabId)
+      ? Math.max(0, this._caseDeadlineByTab.get(tabId) - Date.now())
+      : stepTimeout;
+    return Math.max(0, Math.min(implicit, stepTimeout, caseRemaining));
```

### `tests/effective-execution-config.test.js`

```diff
+test('Admin batch rejects a case response without frozen config', () => {
+  assert.throws(
+    () => resolvePlaybackRuntimeConfig({ start_url: 'https://current.example' }, {
+      batchId: 'BATCH_002',
+      startUrl: 'https://client.example',
+    }, true),
+    /未返回 EffectiveExecutionConfig/,
+  );
+});
+
+test('popup and test-lab playback retain legacy option compatibility', () => {
+  const resolved = resolvePlaybackRuntimeConfig({
+    start_url: 'https://case.example',
+    window_size_mode: 'maximized',
+  }, {
+    startUrl: 'https://popup.example',
+    viewportMode: 'current',
+    pageErrorCheckEnabled: true,
+  }, false);
+
+  assert.equal(resolved.frozen, false);
+  assert.equal(resolved.startUrl, 'https://popup.example');
+  assert.equal(resolved.windowSizeMode, 'current');
+  assert.equal(resolved.pageErrorCheckEnabled, true);
+});
```

# 2026-08-04 统一 62 条操作目录 CueCast 契约测试

## 涉及文件

- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更内容

1. 新增直接读取 Admin 统一 62 条操作目录 fixture 的 CueCast 契约测试。
2. 校验目录版本、方法总数、每个 canonical action 的注册和非空执行路由，避免仅凭目录登记宣称扩展支持。

## 验证

执行 `node --experimental-default-type=module --test tests/operation-contract.test.js`，退出码为 0。

## 具体代码改动

### `tests/operation-contract.test.js`

```diff
+import assert from 'node:assert/strict';
+import fs from 'node:fs';
+import test from 'node:test';
+
+import {
+  CUECAST_ACTION_TYPES,
+  OPERATION_CATALOG_VERSION,
+  getCuecastActionRoute,
+} from '../modules/canonical-action-registry.js';
+
+const fixturePath = new URL(
+  '../../sakura-admin/continew-automation/src/test/resources/automation/automation-operation-62-fixture.json',
+  import.meta.url,
+);
+const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
+
+test('CueCast registry covers every canonical action in the 62-method fixture', () => {
+  assert.equal(fixture.catalog_version, OPERATION_CATALOG_VERSION);
+  assert.equal(fixture.methods.length, 62);
+
+  const fixtureActions = [...new Set(fixture.methods.map((method) => method.action_type))];
+  const missing = fixtureActions.filter((actionType) => !CUECAST_ACTION_TYPES.has(actionType));
+  assert.deepEqual(missing, []);
+  for (const actionType of fixtureActions) {
+    assert.notEqual(getCuecastActionRoute(actionType), '', `CueCast action has no route: ${actionType}`);
+  }
+});
```

# 2026-08-04 CueCast CDP 批次 capability 透传

## 涉及文件

- background.js
- modules/api-client.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. Admin-ui 发起 extension-cdp 批次回放时，将当前批次的短期 `executionCapability` 传入扩展。
2. 扩展读取 Admin case 和回传结果时通过 `X-Execution-Capability` 请求头传递 capability，并在读取 URL 中携带 `batchId`。
3. 非 Admin/test-lab 回放仍沿用原 API 协议，不改变旧链路。

## 验证

已完成扩展脚本静态检查、admin-ui typecheck、Playwright Runner 单元测试及 Admin 后端全 reactor 测试；真实 Admin/Chrome 批次回放仍待服务启动后手工验收。

## 具体代码改动

### `background.js`

```diff
       void player.start(message.testCaseId, message.startUrl, {
         adminCaseKey: message.adminCaseKey || message.caseKey,
         batchId: message.batchId,
+        executionCapability: message.executionCapability,
         executionId: message.executionId,
```

### `modules/api-client.js`

```diff
     const token = this._getToken();
     if (token) headers['Authorization'] = `Bearer ${token}`;
+    if (executionCapability) headers['X-Execution-Capability'] = executionCapability;
```

```diff
-  getAdminPlaywrightCase(caseKey, projectEnvironmentId) {
+  getAdminPlaywrightCase(caseKey, projectEnvironmentId, batchId = '', executionCapability = '') {
```

### `modules/player-manager.js`

```diff
       const res = useAdminCase
-        ? await this.api.getAdminPlaywrightCase(sourceCaseKey, opts.projectEnvironmentId)
+        ? await this.api.getAdminPlaywrightCase(sourceCaseKey, opts.projectEnvironmentId, opts.batchId, opts.executionCapability)
         : await this.api.getTestCase(testCaseId);
```

```diff
-        });
+        }, opts.executionCapability);
```

# 2026-08-03 CueCast 恢复失败草稿状态查询与重试入口

## 涉及文件

- background.js
- modules/recorder-manager.js
- content/bridge.js
- commit/git-commit-log.md

## 变更内容

1. 为失败草稿增加 `saveFailed` 标记和错误摘要，避免 Service Worker 重启后把失败草稿误恢复成正在录制。
2. 新增脱敏的草稿状态查询消息，admin-ui 重新打开录制弹窗时仍能显示重试入口。
3. 修复目标标签页关闭后导入失败会清理草稿的问题；连续失败仍保留步骤和导入上下文。

## 验证

已执行扩展脚本语法检查、admin-ui `pnpm typecheck`，以及失败停止、标签页关闭、状态查询、Service Worker 恢复和重试清理契约测试，全部通过。

## 具体代码改动

### `background.js`

```diff
   recordingImport: null,
   recordingEndUrl: '',
+  recordingSaveFailed: false,
+  recordingSaveError: '',
@@
+    case 'AT_PLATFORM_RECORDING_DRAFT_STATUS':
+      recorder.getSessionDraftSummary().then(sendResponse);
+      return true;
```

### `modules/recorder-manager.js`

```diff
       active: this.state.mode === 'recording',
+      saveFailed: this.state.recordingSaveFailed === true,
+      saveError: this.state.recordingSaveError || '',
@@
+  async getSessionDraftSummary() {
+    const session = await this._readNewestSessionDraft();
+    if (!session || session.saveFailed !== true) {
+      return { ok: true, available: false };
+    }
+    const recordingImport = session.recordingImport || {};
+    return {
+      ok: true,
+      available: true,
+      testCaseId: session.testCaseId ?? null,
+      stepCount: Array.isArray(session.recordedSteps) ? session.recordedSteps.length : 0,
+      mode: recordingImport.mode || 'legacySaveSteps',
+      targetSceneDbId: recordingImport.targetSceneDbId ?? null,
+      targetCaseId: recordingImport.targetCaseId ?? null,
+      savedAt: session.savedAt ?? null,
+      error: session.saveError || '',
+    };
+  }
@@
-    if (!saved) await this._clearSessionDraft();
+    if (!saved && saveError && recorded.length > 0) {
+      await this._markSessionDraftSaveFailed(saveError);
+    } else if (!saved) {
+      await this._clearSessionDraft();
+    }
```

### `content/bridge.js`

```diff
       || data.type === 'AT_PLATFORM_RETRY_RECORDING'
+      || data.type === 'AT_PLATFORM_RECORDING_DRAFT_STATUS'
       || data.type === 'AT_PLATFORM_PLAY'
```

# 2026-08-03 CueCast 增加录制导入失败草稿重试

## 涉及文件

- background.js
- modules/recorder-manager.js
- content/bridge.js
- README.md
- 使用说明.md
- commit/git-commit-log.md

## 变更内容

1. 录制停止或目标标签页关闭后导入失败时，保留包含步骤、导入模式、目标上下文和最终页面地址的 session draft。
2. 新增扩展重试消息，后台从草稿恢复完整导入 payload；重试失败继续保留草稿，成功后清理草稿并通知 admin-ui。
3. admin-ui 录制结果增加“重试上传草稿”入口，文档同步说明失败恢复流程。

## 验证

已执行：

```powershell
node --check background.js
node --check modules/recorder-manager.js
node --check content/bridge.js
node --experimental-default-type=module --input-type=module <recording-draft-retry-contract>
```

结果：扩展脚本语法检查通过；重试契约测试确认失败保留草稿、成功清理草稿、步骤合并和最终地址未丢失。

## 具体代码改动

### `background.js`

```diff
   recordingImport: null,
+  recordingEndUrl: '',
   recordingPaused: false,
@@
+    case 'AT_PLATFORM_RETRY_RECORDING':
+      state.apiBase = message.apiBase || state.apiBase;
+      state.authToken = message.authToken || state.authToken;
+      recorder.retrySaveDraft().then(sendResponse);
+      return true;
```

### `modules/recorder-manager.js`

```diff
       recordingImport: this.state.recordingImport || null,
+      recordingEndUrl: this.state.recordingEndUrl || '',
@@
+  async retrySaveDraft() {
+    const session = await this._readNewestSessionDraft();
+    if (!session) {
+      return { ok: false, saved: false, retryable: false, error: '没有可重试的录制草稿' };
+    }
+    const recorded = Array.isArray(session.recordedSteps) ? [...session.recordedSteps] : [];
+    const toSave = this._mergeRecordedWithSnapshot(
+      recorded,
+      Array.isArray(session.existingStepsSnapshot) ? session.existingStepsSnapshot : null,
+      session.insertAfterIndex,
+    );
+    const recordingImport = session.recordingImport || null;
+    const recordingEndUrl = session.recordingEndUrl || await this._getRecordingTabUrl(session.currentTabId);
+    const saveOptions = recordingImport
+      ? { ...recordingImport, recordingEndUrl }
+      : recordingImport;
+    try {
+      await this._saveRecordedSteps(session.testCaseId, toSave, saveOptions);
+      await this._clearSessionDraft();
+      return { ok: true, saved: true, retryable: false, stepCount: recorded.length, saveContext };
+    } catch (err) {
+      return { ok: false, saved: false, retryable: true, error, saveContext };
+    }
+  }
@@
+    // 停止录制前把最终地址写入草稿，上传失败后重试仍能复用完整导入上下文。
+    this.state.recordingEndUrl = recordingEndUrl;
+    await this._saveSessionDraft();
```

### `content/bridge.js`

```diff
       data.type === 'AT_PLATFORM_RECORD'
+      || data.type === 'AT_PLATFORM_RETRY_RECORDING'
       || data.type === 'AT_PLATFORM_PLAY'
```

### `README.md`

```diff
 4. 录制完成后步骤自动上传到后端并刷新中台
+
+如果导入请求失败，扩展会保留本次录制 session draft；admin-ui 录制结果中点击“重试上传草稿”即可继续使用原步骤和导入上下文上传。
```

### `使用说明.md`

```diff
 - 将步骤发送到后台并保存到后端
+
+如果录制导入请求失败，后台会保留 session draft。通过 admin-ui 录制结果中的“重试上传草稿”可以再次提交；重试成功后草稿自动清理，连续失败时不会丢失步骤。
```

# 2026-08-03 CueCast 增加 Admin 中台配置页

## 涉及文件

- manifest.json
- background.js
- options/options.html
- options/options.css
- options/options.js
- popup/popup.html
- popup/popup.css
- popup/popup.js
- README.md
- 使用说明.md
- commit/git-commit-log.md

## 变更内容

1. 新增扩展选项页，支持配置 Admin API Base、鉴权 Token 和控制台地址，并保存到当前 Chrome 用户的 `chrome.storage.local`。
2. Service Worker 启动时加载中台配置，监听配置变更并即时更新 API 客户端；中台页面临时传入的鉴权参数仍保持会话级覆盖。
3. Popup 展示当前中台配置状态，并提供打开选项页入口；README 和使用说明同步更新安装后配置步骤。

## 验证

已执行扩展脚本语法检查和 Popup/Options 配置契约测试，确认配置规范化、保存、重载恢复和入口跳转行为正常。

```powershell
node --check background.js
node --check popup/popup.js
node --check options/options.js
```
## 具体代码改动

### `manifest.json`

```diff
   "action": {
     "default_popup": "popup/popup.html"
   },
+  "options_page": "options/options.html",
   "content_scripts": [
```

### `background.js`

```diff
 const state = {
   apiBase: 'http://localhost:3000/api',
   authToken: '',
 };
+const EXTENSION_SETTINGS_KEY = 'cuecastSettings';
+const DEFAULT_EXTENSION_SETTINGS = Object.freeze({
+  apiBase: 'http://localhost:3000/api',
+  authToken: '',
+  dashboardUrl: 'https://app.icuecast.com/dashboard',
+});
+
+function applyExtensionSettings(settings = {}) {
+  state.apiBase = normalizeApiBase(settings.apiBase);
+  state.authToken = String(settings.authToken ?? '').trim();
+}
+
+void restoreExtensionSettings()
+  .then(() => recorder.restoreSessionFromStorage());
```

### `options/options.html`

```diff
+<form id="settingsForm" class="card">
+  <label><span>Admin API Base</span><input id="apiBase" name="apiBase" type="url" required></label>
+  <label><span>鉴权 Token</span><input id="authToken" name="authToken" type="password" autocomplete="off"></label>
+  <button type="submit" class="primary">保存配置</button>
+</form>
```

### `options/options.css`

```diff
+.card {
+  display: grid;
+  gap: 18px;
+  padding: 24px;
+  border: 1px solid var(--border);
+  border-radius: 12px;
+  background: var(--card);
+}
```

### `options/options.js`

```diff
+const SETTINGS_KEY = 'cuecastSettings';
+
+async function saveSettings(event) {
+  event.preventDefault();
+  const settings = normalizedSettings({
+    apiBase: refs.apiBase.value,
+    authToken: refs.authToken.value,
+    dashboardUrl: refs.dashboardUrl.value,
+  });
+  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
+  setStatus('已保存，后台请求会立即使用新配置。');
+}
```

### `popup/popup.html`

```diff
+<section class="card config-card">
+  <span>Admin 中台</span>
+  <span id="configState" class="config-state">读取中</span>
+  <p id="adminApiBase" class="config-value">-</p>
+  <button type="button" class="btn-secondary" id="openOptions">配置 API 和 Token</button>
+</section>
```

### `popup/popup.css`

```diff
+.config-card {
+  display: grid;
+  gap: 8px;
+}
+
+.btn-secondary {
+  width: 100%;
+  border: 1px solid var(--border);
+  background: transparent;
+  color: var(--text);
+}
```

### `popup/popup.js`

```diff
-const DEFAULT_DASHBOARD_URL = 'https://app.icuecast.com/dashboard';
+const SETTINGS_KEY = 'cuecastSettings';
+const DEFAULT_SETTINGS = {
+  apiBase: 'http://localhost:3000/api',
+  authToken: '',
+  dashboardUrl: 'https://app.icuecast.com/dashboard',
+};
+
+const result = await chrome.storage.local.get(SETTINGS_KEY);
+const settings = normalizedSettings(result?.[SETTINGS_KEY]);
+adminApiBase.textContent = settings.apiBase;
+configState.textContent = settings.authToken ? '已配置 Token' : '未配置 Token';
```

### `README.md`

```diff
 ├── popup/
 │   ├── popup.html         - 弹窗页面
 │   └── popup.js           - 弹窗逻辑
+├── options/
+│   ├── options.html       - Admin 中台配置页
+│   ├── options.css        - 配置页样式
+│   └── options.js         - 配置保存逻辑
```

### `使用说明.md`

```diff
 - `popup/`：扩展弹窗
+- `options/`：Admin 中台 API、Token 和控制台地址配置页
 - `test-lab/`：本地实验室与 mock 数据
```

# 2026-08-03 CueCast 基础设施结果预览写入步骤详情

## 涉及文件

- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. CueCast 委托基础设施任务后读取 Admin 返回的受限结果预览，并写入步骤详情。
2. 结果预览只包含脱敏摘要、影响行数、返回行数、stdout/stderr 预览和截断标记；命令、SQL、目标与凭据仍由 Admin 从冻结 revision 解析，扩展不接触原始执行事实。

## 验证

已执行模块语法检查，确认基础设施结果预览透传和步骤详情写入无语法错误；与 Playwright Runner 的结果契约保持一致。

```powershell
node --check modules/player-manager.js
```

## 具体代码改动

### `modules/player-manager.js`

```diff
 return {
   executor: task.executor || 'infrastructure-service',
   taskId,
   exitCode: task.exitCode ?? task.exit_code,
   affectedRows: task.affectedRows ?? task.affected_rows,
++  // 受限结果预览进入步骤详情；完整输出和大结果只能通过 Admin 受鉴权附件读取。
++  infrastructure: task.result?.infrastructure && typeof task.result.infrastructure === 'object'
++    ? task.result.infrastructure
++    : null,
   // Admin 只对白名单基础设施动作返回受限变量快照；扩展不会读取命令输出或凭据。

 ...(executorResult ? {
   executor: executorResult.executor || 'infrastructure-service',
   infrastructure_task_id: executorResult.taskId || '',
   exit_code: executorResult.exitCode ?? null,
   affected_rows: executorResult.affectedRows ?? null,
++  ...(executorResult.infrastructure
++    ? { details: { infrastructure: executorResult.infrastructure } }
++    : {}),
 } : {}),
```
# 2026-08-03 修复 replaceCase 录制导入缺少定义版本

## 涉及文件

- modules/recorder-manager.js
- commit/git-commit-log.md

## 变更内容

1. CueCast 组装录制导入请求时透传 Admin UI 提供的 `expectedDefinitionVersion`，修复 `replaceCase`、追加及步骤修改模式被后端拒绝的问题。
2. 将定义版本加入录制意图标识；同一目标在版本变化后不再错误复用旧录制会话。

## 验证

已执行模块语法检查和 payload 契约验证，确认 `replaceCase` 请求保留版本号，且不同版本的录制意图标识不同。

```powershell
node --check modules/recorder-manager.js
node --experimental-default-type=module --input-type=module -e "import { RecorderManager } from './modules/recorder-manager.js'; /* payload/identity assertions */"
```

## 具体代码改动

### `modules/recorder-manager.js`

```diff
 return JSON.stringify({
   mode: recordingImport.mode || '',
   targetSceneDbId: recordingImport.targetSceneDbId ?? '',
+  expectedDefinitionVersion: recordingImport.expectedDefinitionVersion ?? '',
   targetCaseId: recordingImport.targetCaseId ?? '',
 });

 return {
   mode: options.mode || 'createScene',
   targetSceneDbId: options.targetSceneDbId,
+  // 替换和追加必须透传启动录制时读取的定义版本，避免绕过并发修改校验。
+  expectedDefinitionVersion: options.expectedDefinitionVersion,
   targetCaseId: options.targetCaseId,
 };
```

# 2026-08-01 CueCast 能力快照按环境与扩展会话隔离

## 涉及文件

- modules/api-client.js
- modules/canonical-action-registry.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. 能力上报改用受控 `capabilities/cuecast` 路径，不再由请求体决定执行器类型。
2. 上报稳定扩展实例 ID、项目环境、当前回放会话和真实 feature，使 Admin 能按环境与用户会话隔离短租约快照。
3. 会话 ID 仅保存在当前扩展后台内存中，不持久化认证信息；环境切换会形成新的握手限频键。

## 验证

待与 Admin 批次 A 契约一起执行：

```powershell
node --check modules/api-client.js
node --check modules/canonical-action-registry.js
node --check modules/player-manager.js
```

## 具体代码改动

### `modules/api-client.js`

```diff
- return this.request('POST', '/automation/operation-catalog/capabilities', capabilities, { timeoutMs: 5000 });
+ return this.request('POST', '/automation/operation-catalog/capabilities/cuecast', {
+   executor_instance_id: capabilities?.executorInstanceId,
+   project_environment_id: capabilities?.projectEnvironmentId,
+   session_id: capabilities?.sessionId,
+   actions: capabilities?.actions,
+   features: capabilities?.features || [],
+ }, { timeoutMs: 5000 });
```

### `modules/canonical-action-registry.js`

```diff
 export function getCuecastCapabilities({
+  executorInstanceId = '',
+  projectEnvironmentId = '',
+  sessionId = '',
+  features = ['browser', 'cdp'],
 } = {}) {
```

### `modules/player-manager.js`

```diff
- void this._reportOperationCapabilities();
+ void this._reportOperationCapabilities(opts);

+ const capabilities = getCuecastCapabilities({
+   executorInstanceId: String(chrome.runtime?.id || 'cuecast-extension'),
+   projectEnvironmentId,
+   sessionId: this._getCapabilitySessionId(),
+   features: ['browser', 'cdp'],
+ });
```

# 2026-07-31 CueCast 文件上传与验证码 OCR 受控链路

## 涉及文件

- modules/canonical-action-registry.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. 将普通文件上传、证书上传登记为 Chrome CDP 动作：只允许执行端可读的绝对文件路径，使用 `DOM.setFileInputFiles` 写入真实 `input[type=file]`，不向页面脚本文本注入路径。
2. 将验证码 OCR 登记为 CDP 动作：CueCast 仅截取目标验证码元素，图片 base64 只随本次基础设施任务短时传递；不会写入场景、截图工件或回放结果。
3. 对运行时属性与验证码变量增加任务结果强校验，Agent 没有返回声明变量时直接失败，避免后续步骤使用空变量继续执行。

## 验证

已执行：

```powershell
node --check modules/canonical-action-registry.js
node --check modules/player-manager.js
node --experimental-default-type=module --input-type=module -e "import { PlayerManager } from './modules/player-manager.js'; const cases=[['file_upload',{file_ref:{path:'C:\\work\\upload.txt'}}],['certificate_upload',{certificate_ref:{path:'/tmp/client.pem'}}]]; for(const [type, step] of cases){ const files=PlayerManager._filePathsFromStep({action_type:type,...step}); if(!files[0]) throw new Error(type); } console.log('cuecast file reference contract passed');"
```

结果：两个模块语法检查通过；普通文件和证书引用均可被受控解析。验证码截图和 OCR 任务转发由同一受限基础设施通道处理。

## 具体代码改动

### `modules/canonical-action-registry.js`

```diff
  { actionType: 'assert_variable_list_not', route: 'runner_local' },
+ { actionType: 'file_upload', route: 'cdp' },
+ { actionType: 'certificate_upload', route: 'cdp' },
+ { actionType: 'captcha_ocr', route: 'cdp' },
  { actionType: 'assert_database_value', route: 'runner_local' },
```

### `modules/player-manager.js`

```diff
+ async _executeFileUploadCDP(tabId, step) {
+   const files = PlayerManager._filePathsFromStep(step);
+   await this._cdpSend(tabId, 'DOM.setFileInputFiles', { files, backendNodeId });
+ }

+ if (actionType === 'captcha_ocr') {
+   const imageBase64 = await this._captureCaptchaTargetBase64(playTabId, executableStep);
+   await this._executeInfrastructureStep(sourceCaseKey, executableStep, {
+     runtimeInput: { captcha_image_base64: imageBase64 },
+   });
+ }
```

# 2026-07-31 CueCast 数据库变量断言与基础设施绑定收口

## 涉及文件

- modules/canonical-action-registry.js
- modules/variable-context.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. 将 `assert_database_value` 登记为 `runner_local`：断言只读取本次 CDP 回放的变量上下文，不访问浏览器、扩展存储或历史报告。
2. 基础设施步骤继续只提交冻结步骤中实际出现的 `${变量}` 根变量；数据库、文件查询等返回值仅在当前回放上下文回写。
3. 能力目录只有在 CueCast 上报该 action 后才会启用相应人工步骤，避免将 CDP 不具备的动作误报为可执行。

## 验证

已执行：

```powershell
node --check modules/canonical-action-registry.js
node --check modules/variable-context.js
node --check modules/player-manager.js
node --experimental-default-type=module --input-type=module -e "import { CuecastVariableContext } from './modules/variable-context.js'; import { CUECAST_ACTION_TYPES } from './modules/canonical-action-registry.js'; const variables = new CuecastVariableContext({ rows: [{ id: '7', status: 'READY' }] }); const reference = String.fromCharCode(36) + '{rows[0].id}'; const bindings = variables.bindingsForStep({ sql: reference }); if (bindings.rows[0].id !== '7' || !CUECAST_ACTION_TYPES.has('assert_database_value') || !CUECAST_ACTION_TYPES.has('host_file_lookup')) process.exit(1);"
```

结果：三个模块语法检查通过；嵌套数据库结果只生成根变量绑定，数据库断言和文件查询动作均在实际注册表中。

## 具体代码改动

### `modules/canonical-action-registry.js`

```diff
  { actionType: 'assert_variable_list', route: 'runner_local' },
  { actionType: 'assert_variable_list_not', route: 'runner_local' },
+ { actionType: 'assert_database_value', route: 'runner_local' },
  { actionType: 'assert_json', route: 'cdp_admin' },
```

### `modules/variable-context.js`

```diff
  'global_variable_formula',
  'assert_variable_list',
  'assert_variable_list_not',
+ 'assert_database_value',
]);
```

### `modules/player-manager.js`

```diff
  if (isInfrastructureStep(executableStep)) {
    const infrastructureResult = await this._executeInfrastructureStep(sourceCaseKey, executableStep, {
+     runtimeBindings: variableContext.bindingsForStep(step),
    });
  }

+ if (isCuecastLocalVariableAction(actionType)) {
+   await this._executeLocalVariableAction(playTabId, executableStep, variableContext);
+ }
```

# 2026-07-30 CueCast canonical action 注册表与 Admin 能力握手

## 涉及文件

- modules/canonical-action-registry.js
- modules/api-client.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. 新增 CueCast 独立的 canonical action 注册表，逐项标明真实路由：`chrome.debugger/CDP`、`content/player.js`、CDP 采集后 Admin 比对/规划，以及只按冻结步骤身份委托 Admin/Agent 的基础设施动作。
2. API 客户端新增 `POST /automation/operation-catalog/capabilities` 调用，超时限制为 5 秒。
3. Admin 用例回放开始时异步上报 `executor=cuecast`、manifest 版本、目录版本和实际 action 集合；同一 Admin 会话内 60 秒限频。旧 Admin 的 404、目录版本不一致和网络异常只记录告警，不会中断既有 CDP 回放。
4. `PlayerManager._canUseCDP()` 改为复用注册表，防止能力上报和真实 CDP 路由漂移。

## 修改原因

Admin 新增步骤页需要按照三执行器真实能力交集开放方法。CueCast 不能被当作 Playwright Runner，也不能把由内容脚本或 Admin/Agent 执行的动作误报为纯 CDP；因此将实际路由集中登记，并在建立 Admin 回放会话时以 `cuecast` 身份完成兼容握手。

## 验证

已执行：

```powershell
node --check modules/canonical-action-registry.js
node --check modules/api-client.js
node --check modules/player-manager.js
node --experimental-default-type=module --input-type=module -e "import { CUECAST_ACTION_TYPES, CUECAST_CDP_ACTION_TYPES, getCuecastCapabilities, getCuecastActionRoute } from './modules/canonical-action-registry.js'; const payload = getCuecastCapabilities({ executorVersion: '1.1.0' }); if (payload.executor !== 'cuecast' || payload.catalogVersion !== '2026-07-30.1' || !payload.actions.includes('navigate') || !payload.actions.includes('server_command') || CUECAST_CDP_ACTION_TYPES.has('navigate') || getCuecastActionRoute('server_command') !== 'admin_infrastructure' || !CUECAST_ACTION_TYPES.has('assert_text')) process.exit(1); console.log(JSON.stringify(payload));"
node --experimental-default-type=module --input-type=module -e "import { PlayerManager } from './modules/player-manager.js'; globalThis.chrome = { runtime: { getManifest: () => ({ version: '1.1.0' }) } }; let payload; const manager = new PlayerManager({ apiBase: 'http://admin/api', authToken: 'token' }, { registerOperationCapabilities: async (body) => { payload = body; } }); const report = await manager._reportOperationCapabilities(); if (!report.ok || payload.executor !== 'cuecast' || payload.executorVersion !== '1.1.0' || !payload.actions.includes('click') || !payload.actions.includes('navigate')) process.exit(1); const fallback = new PlayerManager({ apiBase: 'http://old-admin/api', authToken: 'token' }, { registerOperationCapabilities: async () => { throw new Error('HTTP 404'); } }); const failed = await fallback._reportOperationCapabilities(); if (failed.ok || !failed.error) process.exit(1); console.log('capability handshake contract passed');"
```

结果：三个扩展模块语法检查通过；注册表契约验证通过；正常上报与旧 Admin 失败降级均通过，不会阻断回放。

## 具体代码改动

### `modules/canonical-action-registry.js`

```diff
+export const OPERATION_CATALOG_VERSION = '2026-07-30.1';
+
+export const CUECAST_ACTION_REGISTRY = Object.freeze([
+  { actionType: 'navigate', route: 'content_player' },
+  { actionType: 'click', route: 'cdp' },
+  { actionType: 'double_click', route: 'cdp' },
+  { actionType: 'right_click', route: 'cdp' },
+  { actionType: 'input', route: 'cdp' },
+  { actionType: 'key', route: 'cdp' },
+  { actionType: 'scroll', route: 'cdp' },
+  { actionType: 'hover', route: 'cdp' },
+  { actionType: 'assert_text', route: 'cdp' },
+  { actionType: 'wait', route: 'content_player' },
+  { actionType: 'assert_json', route: 'cdp_admin' },
+  { actionType: 'ai_natural', route: 'cdp_admin' },
+  { actionType: 'server_command', route: 'admin_infrastructure' },
+  { actionType: 'database_sql', route: 'admin_infrastructure' },
+  { actionType: 'database_native', route: 'admin_infrastructure' },
+].map((entry) => Object.freeze(entry)));
+
+export const CUECAST_ACTION_TYPES = new Set(
+  CUECAST_ACTION_REGISTRY.map((entry) => entry.actionType),
+);
+
+export const CUECAST_CDP_ACTION_TYPES = new Set(
+  CUECAST_ACTION_REGISTRY
+    .filter((entry) => entry.route === 'cdp')
+    .map((entry) => entry.actionType),
+);
+
+export function isCuecastCdpAction(actionType) {
+  return CUECAST_CDP_ACTION_TYPES.has(normalizeActionType(actionType));
+}
+
+export function getCuecastCapabilities({ executorVersion = 'unknown', catalogVersion = OPERATION_CATALOG_VERSION } = {}) {
+  return {
+    executor: 'cuecast',
+    executorVersion: String(executorVersion || 'unknown').trim() || 'unknown',
+    catalogVersion: String(catalogVersion || OPERATION_CATALOG_VERSION).trim(),
+    actions: [...CUECAST_ACTION_TYPES],
+  };
+}
```

### `modules/api-client.js`

```diff
   cancelInfrastructureTask(taskId) {
     return this.request('DELETE', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}`, null, { timeoutMs: 30000 });
   }
+
+  registerOperationCapabilities(capabilities) {
+    return this.request('POST', '/automation/operation-catalog/capabilities', capabilities, { timeoutMs: 5000 });
+  }
 }
```

### `modules/player-manager.js`

```diff
+import {
+  getCuecastCapabilities,
+  isCuecastCdpAction,
+} from './canonical-action-registry.js';
+
 export class PlayerManager {
   constructor(state, api) {
     this.state = state;
     this.api = api;
+    this._capabilityHandshake = null;
   }
@@
   async start(testCaseId, startUrl, opts = {}) {
     const adminCaseKey = String(opts.adminCaseKey || '').trim();
     const useAdminCase = Boolean(adminCaseKey) || String(opts.dataSource || '').trim().toLowerCase() === 'admin';
+    if (useAdminCase) {
+      void this._reportOperationCapabilities();
+    }
@@
+  _reportOperationCapabilities() {
+    if (typeof this.api?.registerOperationCapabilities !== 'function') {
+      return Promise.resolve({ ok: false, skipped: true });
+    }
+    const extensionVersion = this._getExtensionVersion();
+    const sessionKey = `${String(this.state?.apiBase || '').trim()}\n${this.state?.authToken ? 'authenticated' : 'anonymous'}\n${extensionVersion}`;
+    const capabilities = getCuecastCapabilities({ executorVersion: extensionVersion });
+    const promise = Promise.resolve()
+      .then(() => this.api.registerOperationCapabilities(capabilities))
+      .catch((error) => {
+        console.warn('[Player] CueCast 能力上报未完成，继续回放：', error?.message || String(error));
+        return { ok: false, error };
+      });
+    this._capabilityHandshake = { sessionKey, attemptedAt: Date.now(), promise };
+    return promise;
+  }
@@
   _canUseCDP(step) {
-    return ['click', 'double_click', 'right_click', 'input', 'key', 'scroll', 'hover'].includes(step.action_type);
+    return isCuecastCdpAction(step?.action_type);
   }
 }
```

# 2026-07-28 CueCast 基础设施步骤后台委托与统一回放进度

## 涉及文件

- modules/api-client.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. API 客户端新增基础设施任务创建、按 `nextSequence` 轮询和取消接口，调用方只传 `caseKey`、`stepId`、`executionId`、`projectEnvironmentId`、`attempt`，不提交命令、SQL、目标或凭据。
2. CDP 回放识别 `server_command`、`database_sql`、`database_native`；这些步骤只在扩展后台创建和轮询 admin 基础设施任务，不会发给 `content/player.js`、CDP 页面上下文或 DOM 回放脚本。
3. 基础设施任务日志以统一 `AT_PLAYBACK_PROGRESS` 回传；步骤结果补充执行器、任务 ID、退出码和影响行数。用户停止回放时会请求取消正在执行的基础设施任务。

## 修改原因

浏览器扩展不具备 SSH/JDBC 执行边界，且内容脚本不能接触服务器命令、SQL 或凭据。通过 admin 受控任务接口委托执行，才能保持浏览器步骤与基础设施步骤的顺序回放，同时保留鉴权、脱敏、审计和取消能力。

## 验证

已执行：

```bash
node --check modules/api-client.js
node --check modules/player-manager.js
```

结果：语法检查通过。

## 具体代码改动

### `modules/api-client.js`

```diff
-}
+  createInfrastructureTask(payload) {
+    return this.request('POST', '/automation/infrastructure/tasks', payload, { timeoutMs: 30000 });
+  }
+  getInfrastructureTask(taskId, afterSequence = 0) {
+    const query = afterSequence > 0 ? `?afterSequence=${encodeURIComponent(afterSequence)}` : '';
+    return this.request('GET', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}${query}`, null, { timeoutMs: 30000 });
+  }
+  cancelInfrastructureTask(taskId) {
+    return this.request('DELETE', `/automation/infrastructure/tasks/${encodeURIComponent(taskId)}`, null, { timeoutMs: 30000 });
+  }
+}
```

### `modules/player-manager.js`

```diff
+function isInfrastructureStep(step) {
+  return ['server_command', 'database_sql', 'database_native'].includes(
+    String(step?.action_type ?? '').trim().toLowerCase(),
+  );
+}
```

```diff
         const executableStep = waitBefore ? { ...runtimeStep, wait_before: 0 } : runtimeStep;
+      if (isInfrastructureStep(executableStep)) {
+        const infrastructureResult = await this._executeInfrastructureStep(sourceCaseKey, executableStep, {
+          ctx,
+          executionId: opts.executionId || runId,
+          projectEnvironmentId: executionSnapshot.project_environment_id,
+          onProgress: (phase, payload) => broadcastProgress(phase, payload),
+        });
+        appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', null, infrastructureResult);
+        continue;
+      }
```

```diff
   async stop() {
     for (const ctx of this._playContexts) {
       ctx.stopped = true;
+    const taskIds = Array.from(ctx.infrastructureTaskIds || []);
+    await Promise.all(taskIds.map(taskId => this.api.cancelInfrastructureTask(taskId).catch(() => {})));
    }
  }
```

`_executeInfrastructureStep()` 只使用步骤身份创建任务，并按 `taskId` 与 `nextSequence` 轮询服务端已脱敏日志；终态结果回写为统一步骤结果。扩展不会读取、缓存或展示 `target_ref`、原始命令、SQL 或凭据。

# 2026-07-23 CDP 日志契约与历史完整性统一

## 变更内容

1. CDP 回放按照与 Playwright Runner 对齐的生命周期生成结构化日志：任务入队、用例读取、配置、浏览器初始化、起始页、步骤开始/完成、定位详情和用例结束。
2. 每条实时进度事件携带完整日志对象，同一事件同时进入 `progressLogs`；执行结束后通过 `execution_logs` 回传 admin，确保实时视图与历史视图使用同一份日志。
3. 详细定位日志增加实际定位来源、定位类型、具体定位元素和命中数量，简洁日志继续隐藏该诊断信息。
4. 修正启动失败分支引用步骤循环局部变量的问题，启动阶段异常也会生成并保存完整的 CDP 失败日志。
5. 用例完成耗时统一从 CDP 任务开始时间计算，步骤耗时合计另存为 `step_duration_ms`，避免页面总耗时与完成日志不一致。

## 涉及文件

- `modules/player-manager.js`
- `commit/git-commit-log.md`

## 变更原因

CDP 与 Playwright Runner 原先输出的阶段和信息粒度不同，且 CDP 历史记录没有保存实时事件，导致运行期间看到的日志在稍后读取历史记录时被不完整摘要替换。详细视图也只有定位来源，无法确认实际命中的元素。

## 验证方式与结果

```powershell
node --check modules/player-manager.js
node --check content/bridge.js
```

结果：两个扩展脚本语法检查通过；`sakura-admin-ui` 的 `pnpm typecheck` 通过；`sakura-playwright` 的 `pnpm check` 和 21 项单元测试全部通过；admin `continew-automation` reactor 编译通过。

## 具体代码改动

### `modules/player-manager.js`

实时事件与持久化日志共用序号、时间和消息，并补齐生命周期与实际定位详情：

```diff
-    let broadcastProgress = () => {};
+    let progressSequence = 0;
+    let progressStepTotal = 0;
+    const progressLogs = [];
+    const broadcastProgress = (phase, payload = {}) => {
+      if (!useAdminCase) return;
+      const timestamp = new Date().toISOString();
+      const sequence = ++progressSequence;
+      if (payload.log?.message) {
+        progressLogs.push({
+          sequence,
+          timestamp,
+          level: payload.log.level || 'info',
+          phase: payload.log.phase || phase,
+          message: payload.log.message,
+          detail: Boolean(payload.log.detail),
+        });
+      }
+      this._broadcastPlayback({
+        type: 'AT_PLAYBACK_PROGRESS',
+        sequence,
+        phase,
+        timestamp,
+        stepTotal: progressStepTotal,
+        ...payload,
+      });
+    };
+    broadcastProgress('log', {
+      log: { level: 'info', phase: 'admin', message: 'CDP 任务已加入执行队列' },
+    });
@@
+        if (result.locator_source) {
+          broadcastProgress('log', {
+            log: {
+              level: 'info',
+              phase: 'locator',
+              message: [
+                `步骤 ${index + 1}: ${result.description || result.action_type}`,
+                `定位来源=${result.locator_source}`,
+                result.locator_type ? `定位类型=${result.locator_type}` : '',
+                result.locator_value ? `定位元素=${result.locator_value}` : '',
+                result.matched_count != null ? `命中=${result.matched_count}` : '',
+              ].filter(Boolean).join('，'),
+              detail: true,
+            },
+          });
+        }
@@
+            execution_logs: progressLogs,
+      const stepDuration = stepResults.reduce(
+        (total, item) => total + Math.max(0, Number(item.duration_ms) || 0),
+        0,
+      );
-      const duration = Date.now() - startTime;
+      const duration = Date.now() - runStartedAt;
```

# 2026-07-23 CDP 回放运行日志实时进度修复

## 变更内容

1. 扩展 CDP 回放新增 `AT_PLAYBACK_PROGRESS` 事件，按用例开始、用例加载、步骤开始、步骤完成和用例结束顺序发送真实进度。
2. bridge 放行步骤进度事件，admin-ui 可以在执行期间持续显示步骤日志和状态，不再等待 `AT_PLAYBACK_END` 后生成一次性摘要。

## 涉及文件

- `modules/player-manager.js`
- `content/bridge.js`
- `commit/git-commit-log.md`

## 变更原因

运行过程中日志必须随真实步骤稳定追加和更新；原链路只广播 `AT_PLAYBACK_END`，导致中台只能使用不完整结果生成“0 个步骤、执行完成 0ms”等错误日志。

## 验证方式与结果

```powershell
node --check modules/player-manager.js
node --check content/bridge.js
```

结果：两个扩展脚本语法检查通过；admin-ui 类型检查在 `sakura-admin-ui` 目录执行通过。

## 具体代码改动

### `modules/player-manager.js`

新增带序号的实时进度事件，并在每个步骤开始和完成时发送真实状态：

```diff
+      let progressSequence = 0;
+      broadcastProgress = (phase, payload = {}) => {
+        if (!useAdminCase) return;
+        this._broadcastPlayback({
+          type: 'AT_PLAYBACK_PROGRESS',
+          adminCaseKey: sourceCaseKey,
+          batchId: opts.batchId || '',
+          executionId: opts.executionId || runId,
+          sequence: ++progressSequence,
+          phase,
+          timestamp: new Date().toISOString(),
+          stepTotal: steps.length,
+          ...payload,
+        });
+      };
+      broadcastProgress('case-started');
+      broadcastProgress('case-loaded');
@@
+        broadcastProgress('step-finished', {
+          stepIndex: index,
+          status,
+          durationMs: result.duration_ms,
+        });
```

### `content/bridge.js`

允许步骤进度事件从扩展后台转发到 admin 页面：

```diff
         || message.type === 'AT_PLAYBACK_LIVE'
+        || message.type === 'AT_PLAYBACK_PROGRESS'
         || message.type === 'AT_PLAYBACK_END'
```

# 2026-07-19 Playwright Runner 录制定位语义回归样本

## 变更内容

1. test-lab 新增 Element 风格语义复选框：原生 `input` 不可见，用户可交互目标为外层 `label`，用于复现 CDP 能通过组件代理点击而旧 Runner 直接点击原生节点失败的场景。
2. 新增 mock case `297`，保留录制格式的 CSS/XPath 候选与 `control_kind`、标签、容器、状态类上下文，验证 Runner `semantic-v1` 能把隐藏原生节点规范化为可见组件代理。
3. 本轮只扩充 test-lab 回归样本，不修改 CueCast 扩展生产代码，也不改变现有 CDP 回放能力。

## 涉及文件

- `test-lab/target.html`
- `test-lab/mock-data/cases.json`
- `commit/git-commit-log.md`

## 变更原因

同一条录制步骤在扩展 CDP 回放中可通过组件语义找到可交互包装器，但旧 Playwright Runner 只按原始 selector 点击隐藏 `input`，会出现定位存在却无法操作的差异。该样本为 Runner 语义对齐提供稳定、可重复的端到端验收入口。

## 验证方式与结果

```powershell
node --check test-lab/mock-server.js
Get-Content -Raw -Encoding utf8 test-lab/mock-data/cases.json | ConvertFrom-Json | Out-Null
node src/index.js --case-id 297 --api-base http://127.0.0.1:4173/api --headed false --locator-mode semantic-v1 --trace off --video off
```

结果：mock server 语法检查和 JSON 解析通过；case `297` 端到端执行通过。第一步实际命中 `locator_meta.candidates[0]`，原始目标为隐藏 `input.el-checkbox__original`，有效目标转换为可见 `label.semantic-checkbox`，结果记录 `normalization_rule: checkbox-visible-wrapper`、最高分 `255`。

## 具体代码改动

### `test-lab/target.html`

新增隐藏原生 checkbox、可见组件包装器及状态反馈：

```diff
+    .semantic-checkbox {
+      position: relative;
+      display: inline-flex;
+    }
+    .semantic-checkbox .el-checkbox__original {
+      position: absolute;
+      width: 0;
+      height: 0;
+      opacity: 0;
+      z-index: -1;
+    }
-      <strong data-testid="m5o-upload-status">Proxy Upload Idle</strong>
+      <strong data-testid="m5o-upload-status">Proxy Upload Idle</strong>
+      <label class="semantic-checkbox el-checkbox fs-checkbox" data-testid="semantic-hidden-checkbox-label">
+        <span class="el-checkbox__input">
+          <input class="el-checkbox__original" type="checkbox" data-testid="semantic-hidden-checkbox-input">
+        </span>
+        <span>语义复选框</span>
+      </label>
+      <strong data-testid="semantic-hidden-checkbox-status">Semantic Checkbox Idle</strong>
+    document.querySelector('[data-testid="semantic-hidden-checkbox-input"]').addEventListener('change', (event) => {
+      document.querySelector('[data-testid="semantic-hidden-checkbox-status"]').textContent = event.target.checked
+        ? 'Semantic Checkbox Checked'
+        : 'Semantic Checkbox Unchecked';
+    });
```

### `test-lab/mock-data/cases.json`

新增保留 CSS/XPath 候选和录制上下文的语义回归用例，并初始化结果列表：

```diff
+    "297": {
+      "id": 297,
+      "name": "Locator semantic hidden checkbox mock",
+      "page_error_check_enabled": 0,
+      "steps": [
+        {
+          "action_type": "click",
+          "target_selector": "[data-testid=\"semantic-hidden-checkbox-input\"]",
+          "locator_meta": {
+            "version": 1,
+            "candidates": [
+              {
+                "type": "css_fallback",
+                "value": "[data-testid=\"semantic-hidden-checkbox-input\"]",
+                "score": 0.72
+              }
+            ],
+            "context": {
+              "tag": "input",
+              "control_kind": "input:checkbox",
+              "label_text": "语义复选框",
+              "container_text": "语义复选框",
+              "state_classes": ["el-checkbox__original"]
+            }
+          }
+        }
+      ]
+    }
-    "296": []
+    "296": [],
+    "297": []
```

# 2026-07-17 CueCast 批次标识与实际定位结果回传

## 变更内容

1. admin 发起 CDP 批量回放时透传服务端生成的 `batchId` 和稳定 `executionId`，成功、失败以及结束广播始终使用同一运行标识。
2. CDP 点击、输入、键盘和悬停步骤回传实际命中的定位来源、类型、值与匹配数量；没有经过定位器确认的 DOM 降级路径不伪造实际定位。
3. 纯键盘或无定位配置的输入步骤不会额外执行元素探测，保持原有执行语义和响应速度。

## 涉及文件

- `background.js`
- `modules/player-manager.js`
- `commit/git-commit-log.md`

## 验证

已执行：

    node --check background.js
    node --check modules/player-manager.js

结果：扩展脚本语法检查通过；服务端批次标识、运行标识和实际定位字段已具备端到端回传契约，真实 Chrome CDP 操作仍需在扩展重新加载后做现场回放验证。

## 具体代码改动

### `background.js`

`AT_PLATFORM_PLAY` 将批次与运行标识原样传入 `PlayerManager`：

```diff
       void player.start(message.testCaseId, message.startUrl, {
         adminCaseKey: message.adminCaseKey || message.caseKey,
+        batchId: message.batchId,
+        executionId: message.executionId,
         projectEnvironmentId: message.projectEnvironmentId,
```

### `modules/player-manager.js`

优先采用服务端运行 ID，并把批次 ID 写入成功与失败结果；步骤只在 CDP 确认实际命中后附加定位诊断：

```diff
-    const runId = `${safeCaseKey}-${runStartedAt}`;
+    const runId = String(opts.executionId || '').trim() || `${safeCaseKey}-${runStartedAt}`;
     const executionSnapshot = {
       project_environment_id: opts.projectEnvironmentId ?? '',
+      batch_id: opts.batchId ?? '',
@@
-      const appendStepResult = (step, index, status, startedAt, error = '') => {
+      const appendStepResult = (step, index, status, startedAt, error = '', locator = null) => {
         stepResults.push({
@@
+          ...(locator ? {
+            locator_source: locator.source || '',
+            locator_type: locator.type || '',
+            locator_value: locator.value || '',
+            matched_count: locator.matchedCount ?? null,
+          } : {}),
@@
-              await this._executeStepCDP(playTabId, executableStep, targetUrl, ctx.locale, runtimeNextStep, {
+              actualLocator = await this._executeStepCDP(playTabId, executableStep, targetUrl, ctx.locale, runtimeNextStep, {
@@
-          appendStepResult(runtimeStep, i, 'passed', stepStartedAt);
+          appendStepResult(runtimeStep, i, 'passed', stepStartedAt, '', actualLocator);
```

定位来源由 `_buildFindCode` 的真实 `via` 结果转换，输入和键盘步骤仅在存在定位配置时探测：

```diff
+  static _actualLocatorFromVia(step, via, matchedCount = 1) {
+    const source = String(via || '').trim();
+    if (!source) return null;
+    const candidates = PlayerManager._normalizeLocatorMetaCandidates(step?.locator_meta);
+    let type = '';
+    let value = '';
+    if (source.startsWith('meta-')) {
+      const sourceType = source.slice(5);
+      const candidate = sourceType === 'xpath'
+        ? candidates.find((item) => ['table_cell_xpath', 'xpath_fallback'].includes(String(item?.type || '')))
+        : sourceType === 'text'
+          ? candidates.find((item) => String(item?.type || '') === 'text_exact')
+          : candidates.find((item) => String(item?.type || '') === sourceType);
+      type = String(candidate?.type || sourceType);
+      value = String(candidate?.value || '');
+    } else if (source === 'css') {
+      type = 'css';
+      value = String(step?.target_selector || '');
+    } else if (source === 'xpath') {
+      type = 'xpath';
+      value = String(step?.target_xpath || '');
+    } else if (source === 'text' || source === 'overlay-text') {
+      type = 'text_exact';
+      value = String(step?.value || '');
+    } else {
+      type = source;
+      value = String(step?.target_selector || step?.target_xpath || step?.value || '');
+    }
+    return { source: `cdp:${source}`, type, value, matchedCount };
+  }
@@
       case 'input': {
+        if (step.target_selector || step.target_xpath || step.locator_meta) {
+          const probe = await this._getElementBoxResult(
+            tabId, step.target_selector, step.target_xpath, '', 1600, false, step.locator_meta
+          );
+          if (probe?.ok) actualLocator = PlayerManager._actualLocatorFromVia(step, probe.box?.via);
+        }
@@
-    }
+    }
+    return actualLocator;
   }
```

# 2026-07-16 CueCast CDP 执行时间格式统一

## 变更内容

1. CDP 回放成功与启动失败结果中的 `started_at`、`finished_at` 统一为北京时间 `yyyy-MM-dd HH:mm:ss`。
2. 不修改耗时毫秒值、回放逻辑、原始用例或 Jenkins 执行链路。

## 涉及文件

- `modules/player-manager.js`
- `commit/git-commit-log.md`

## 变更原因

旧实现使用 UTC ISO 字符串，admin 执行记录会混入 `2026-07-15T09:15:34.971Z` 一类时间。CDP 与 Runner 需要使用一致的平台时间格式，便于展示、入库和人工排查。

## 验证

已执行：

```bash
node --check modules/player-manager.js
```

结果：扩展脚本语法检查通过；admin 后端同时对旧版扩展传入的 ISO 时间做入库规范化。

## 具体代码改动

### `modules/player-manager.js`

新增 `formatPlatformDateTime`，显式使用 `Asia/Shanghai` 时区生成 `yyyy-MM-dd HH:mm:ss`，并替换成功、失败回传中的 ISO 时间生成逻辑。

```diff
+function formatPlatformDateTime(value = new Date()) {
+  const date = value instanceof Date ? value : new Date(value);
+  const parts = new Intl.DateTimeFormat('zh-CN', {
+    timeZone: 'Asia/Shanghai',
+    year: 'numeric',
+    month: '2-digit',
+    day: '2-digit',
+    hour: '2-digit',
+    minute: '2-digit',
+    second: '2-digit',
+    hourCycle: 'h23',
+  }).formatToParts(date);
+  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
+  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
+}
```

```diff
-            started_at: new Date(runStartedAt).toISOString(),
-            finished_at: new Date().toISOString(),
+            started_at: formatPlatformDateTime(runStartedAt),
+            finished_at: formatPlatformDateTime(),
```

```diff
-            started_at: new Date(runStartedAt).toISOString(),
-            finished_at: new Date(finishedAt).toISOString(),
+            started_at: formatPlatformDateTime(runStartedAt),
+            finished_at: formatPlatformDateTime(finishedAt),
```

# 2026-07-15 CueCast CDP 执行记录标识与时间补全

## 变更内容

1. 扩展 CDP 回放在任务启动时生成稳定的 `run_id`，并在成功、步骤失败和启动失败结果中统一回传。
2. 回传结果补齐 `started_at`、`finished_at`，启动失败时也按真实起止时间计算 `duration_ms`。
3. `AT_PLAYBACK_END` 事件携带同一个 `runId`，便于 admin 页面把异步结束事件与执行记录关联。

## 涉及文件

- `modules/player-manager.js`
- `commit/git-commit-log.md`

## 验证

执行：

    node --check modules/player-manager.js

结果：扩展回放脚本语法检查通过；真实 Chrome CDP 端到端结果将在本轮 admin-ui 联调中继续验证。

## 具体代码改动

### `modules/player-manager.js`

在 `start` 生命周期入口记录 `runStartedAt` 并生成文件系统与 URL 安全的 `runId`。admin 成功结果和启动失败结果均写入以下字段：

```js
{
  executor: 'extension-cdp',
  run_id: runId,
  started_at: new Date(runStartedAt).toISOString(),
  finished_at: new Date().toISOString(),
}
```

结束广播增加 `runId`，保持页面状态、执行历史和后端记录使用同一执行标识。

# 2026-07-15 CueCast CDP 产品环境回放配置

## 变更内容

1. admin 用例读取请求增加 `projectEnvironmentId`，使用后端生成的产品环境执行快照回放。
2. `AT_PLATFORM_PLAY` 透传产品环境、窗口模式/宽高和页面错误检测开关。
3. CDP 弹窗覆盖值优先于录制值，并使用空值安全判断，保证 `false` 和 `0` 不被忽略。
4. CDP 执行结果新增产品环境、有效起始地址、窗口配置和页面错误检测快照，便于复现。

## 涉及文件

- `background.js`
- `modules/api-client.js`
- `modules/player-manager.js`
- `commit/git-commit-log.md`

## 变更原因

扩展 CDP 回放需要与 Playwright Runner 使用同一个产品环境执行快照，并允许 admin 弹窗覆盖录制时的窗口和页面检测设置。地址替换由 admin 后端集中完成，CueCast 只消费响应副本，避免扩展自行修改或丢失 `playwright_step`、`locator_meta` 等执行事实字段。

## 验证

已执行：

```bash
node --check background.js
node --check modules/api-client.js
node --check modules/player-manager.js
```

结果：三个扩展脚本语法检查均通过。真实 `.45/.47` 产品环境的 CDP 回放仍需在安装扩展并登录 admin 后人工验收。

## 具体代码改动

### `background.js`

平台回放消息增加 `projectEnvironmentId` 和 `pageErrorCheckEnabled`，继续交由 `PlayerManager.play` 统一执行。

### `modules/api-client.js`

`getAdminPlaywrightCase` 按场景 ID 与用例 ID 使用双路径请求，并在查询参数中携带 `projectEnvironmentId`，获取后端只读环境快照。

### `modules/player-manager.js`

窗口模式、宽高和页面错误检测采用 `??` 合并弹窗值与录制值；执行开始和结束结果记录 `environment_origin`、有效起始地址、窗口参数及检测开关。该逻辑只影响本次回放，不修改 admin 主数据。

# 2026-07-15 CueCast test-lab 适配 Sakura Playwright 根目录

## 变更内容

1. test-lab 从兄弟仓库 `../sakura-playwright/src/` 启动单用例和批量 Runner，不再引用已移除的 `playwright-runner/src/`。
2. Runner 子进程工作目录切换为 `sakura-playwright` 根目录，确保根级 `package.json`、`node_modules`、`.env` 和 artifact 相对路径正常生效。
3. test-lab 静态资源服务新增 `sakura-playwright/artifacts/` 安全映射，执行历史中的报告、截图、trace 和日志链接继续可访问。

## 涉及文件

- `test-lab/mock-server.js`
- `test-lab/app.js`
- `commit/git-commit-log.md`

## 变更原因

`sakura-playwright` 已将 `playwright-runner/src` 提升并分类到仓库根级 `src`，同时把 Node 项目配置提升到仓库根目录。test-lab 必须同步 Runner 入口、工作目录和 artifact URL 映射，否则本地 Runner Job、Batch Job 和产物链接会失效。

## 验证

已执行：

```bash
node --check test-lab/mock-server.js
node --check test-lab/app.js
```

端到端验证：

- `POST /api/runner/jobs` 执行 case `278`：通过，命令指向 `D:\King\sakura\sakura-playwright\src\index.js`。
- `POST /api/runner/batches` 执行 case `278`：通过，命令指向 `D:\King\sakura\sakura-playwright\src\batch.js`。
- `GET /artifacts/batches/<batchId>/report.html`：返回 HTTP `200` 和 `text/html`，兄弟仓库产物映射可访问。

结果：语法检查、单用例任务和批量任务均通过。

## 具体代码改动

### `test-lab/mock-server.js`

新增 Sakura Playwright 兄弟仓库根目录，并将 Runner 入口与子进程工作目录切换到新项目结构：

```diff
 const projectRoot = path.resolve(__dirname, '..');
+const sakuraPlaywrightRoot = path.resolve(projectRoot, '..', 'sakura-playwright');

-const runnerPath = path.join(projectRoot, 'playwright-runner', 'src', 'index.js');
+const runnerPath = path.join(sakuraPlaywrightRoot, 'src', 'index.js');

-const batchPath = path.join(projectRoot, 'playwright-runner', 'src', 'batch.js');
+const batchPath = path.join(sakuraPlaywrightRoot, 'src', 'batch.js');

-cwd: projectRoot,
+cwd: sakuraPlaywrightRoot,
```

静态文件解析先移除 URL 的前导分隔符，对 `/artifacts/` 使用 `sakuraPlaywrightRoot`，并通过 `path.relative` 限制访问范围。

### `test-lab/app.js`

artifact 绝对路径统一转换为 mock server 可访问的 `/artifacts/...` URL：

```diff
-const marker = 'playwright-runner/artifacts/';
-const index = raw.indexOf(marker);
-if (index >= 0) return `/${raw.slice(index)}`;
+const marker = '/artifacts/';
+const index = raw.lastIndexOf(marker);
+if (index >= 0) return raw.slice(index);
```

# 2026-07-14 CueCast admin 数据源 CDP 回放接入

## 变更内容

1. CueCast API 客户端新增 admin Playwright case 读取和结果回传接口，使用 `sceneDbId:caseId` 作为唯一 case key。
2. `PlayerManager` 在收到 `adminCaseKey` 或 `dataSource=admin` 时，从 admin 读取完整 `playwright_step`，继续复用现有 CDP 优先、DOM 降级和复杂定位逻辑。
3. 扩展回放结果按 `extension-cdp` executor 回写 admin，保留失败步骤、截图计数、定位和诊断信息；admin 结果 JSON 不直接写入截图 base64，未携带 admin 标记的旧 mock/legacy 回放路径不变。
4. admin-ui 场景编辑页新增“扩展 CDP 回放”入口，选中用例后通过 `AT_PLATFORM_PLAY` 将 case key 和当前登录 token 传给 CueCast。

## 涉及文件

- modules/api-client.js
- modules/player-manager.js
- background.js
- ../sakura-admin-ui/src/views/automation/automationUiScene/components/AddOrEditForm.vue
- commit/git-commit-log.md

## 验证

已执行：

    node --check modules/api-client.js
    node --check modules/player-manager.js
    node --check background.js

结果：扩展脚本语法检查、admin-ui `typecheck`/生产构建、Runner `npm run check`、admin `continew-automation` `compile`/`test-compile` 均通过；登录浏览器端回放验证仍需在真实环境手动执行。

## 具体代码改动

### `modules/api-client.js`

新增 admin case 读取与结果回传：

```js
getAdminPlaywrightCase(caseKey) {
  return this.request('GET', `/automation/playwright/testcases/${encodeURIComponent(caseKey)}`);
}

saveAdminPlaywrightResult(caseKey, result) {
  return this.request(
    'POST',
    `/automation/playwright/testcases/${encodeURIComponent(caseKey)}/results`,
    result,
    { timeoutMs: 30000 },
  );
}
```

### `modules/player-manager.js`

扩展回放根据 admin case key 选择数据源，执行完成后将 `raw.executor` 标记为 `extension-cdp`。原始 `playwright_step` 由 admin 后端返回，扩展不重组 admin 内部 `caseList` 结构。

### `background.js`

`AT_PLATFORM_PLAY` 和 `AT_POPUP_PLAY` 透传 `adminCaseKey`、`caseKey`、`dataSource` 和 `executionSource` 到 `PlayerManager`。

# 2026-07-14 CueCast CDP 回放失败诊断补强

## 变更内容

1. `PlayerManager` 保存回放结果，在 admin case 读取、起始页校验或 CDP attach 阶段异常时也回传 `failed`，避免中台只显示“已接受”而没有最终错误。
2. `AT_PLAYBACK_END` 增加 `ok`、`error`、`adminCaseKey`、`executor` 和 `cdp_attach_error` 诊断信息，便于管理页与扩展后台定位失败点。
3. admin-ui 监听扩展回放结束事件，失败时直接显示实际错误，不再把异步启动确认误认为执行成功。
4. admin 来源要求 `chrome.debugger.attach` 成功；仅旧本地 mock/legacy 来源允许继续 DOM 降级。

## 涉及文件

- modules/player-manager.js
- ../sakura-admin-ui/src/views/automation/automationUiScene/components/AddOrEditForm.vue
- commit/git-commit-log.md

## 验证

已执行：

    node --check modules/player-manager.js
    node --check background.js
    node --check modules/api-client.js
    npm run typecheck（sakura-admin-ui）

结果：扩展脚本语法检查和 admin-ui 类型检查通过；真实 Chrome CDP attach 与目标页面操作仍需根据新增错误信息进行现场复现。

## 具体代码改动

### `modules/player-manager.js`

回放异常时回传：

```js
{
  type: 'AT_PLAYBACK_END',
  ok: false,
  error: msg,
  adminCaseKey: sourceCaseKey,
  executor: 'extension-cdp',
}
```

并将 `chrome.debugger.attach` 的异常写入 `cdp_attach_error`；admin 读取失败也尝试保存启动失败结果，且 admin 来源不会在 CDP 失败后静默改走 DOM。

### `AddOrEditForm.vue`

监听匹配当前 `adminCaseKey` 的 `AT_PLAYBACK_END`，收到失败事件后显示扩展实际错误。
同时在发送 `AT_PLATFORM_PLAY` 前通过当前 admin 会话预检 case，校验步骤并传递起始 URL、窗口和视口参数。

# 2026-07-14 CueCast 回放用例与步骤结果回传

## 变更内容

1. `PlayerManager` 在扩展回放过程中逐步骤记录 `passed`、`failed`、`skipped`，并回传用例汇总、步骤明细、持续时间和错误信息。
2. admin 结果接口解析 `case_result`，保存用例/步骤统计到 `debugRecord`，同时更新场景最近一次执行结果，保留旧 Runner 结果格式兼容。
3. admin-ui 执行历史新增 Playwright 用例执行明细，展示用例结果以及每个步骤的通过、失败、跳过和错误信息。

## 涉及文件

- `modules/player-manager.js`
- `../sakura-admin/continew-automation/src/main/java/top/continew/admin/automation/service/impl/AutomationPlaywrightCaseServiceImpl.java`
- `../sakura-admin-ui/src/views/automation/automationUiScene/components/AutomationUiSceneDetailDrawer.vue`
- `commit/git-commit-log.md`

## 验证

已执行：

    node --check modules/player-manager.js
    npm run typecheck（sakura-admin-ui）
    mvn -pl continew-automation -am -DskipTests compile（sakura-admin）

结果：扩展脚本语法检查、admin-ui 类型检查和 admin 后端编译通过；真实 Chrome CDP 回放仍需在扩展重新加载后执行一条 admin 用例确认端到端结果。

## 具体代码改动

### `modules/player-manager.js`

新增 `step_results` 和 `case_result` 回传。步骤执行成功、失败或被停止/前置失败跳过时均生成明细，未识别动作仍沿用原始步骤执行路径，不丢弃 `playwright_step` 和定位信息。

### `AutomationPlaywrightCaseServiceImpl.java`

解析扩展上报的用例/步骤结果，生成兼容现有 `debugRecord` 的统计字段和明细字段，并更新场景最近一次执行的通过率、用例统计和步骤统计。

### `AutomationUiSceneDetailDrawer.vue`

从最近一次回放记录读取 `caseResults` 和 `stepResults`，在执行历史中展示用例汇总与步骤级结果。


# 2026-07-13 CueCast 用例内步骤追加与替换模式

## 变更内容

1. 录制导入上下文新增 `appendStep`、`replaceStep` 所需的目标步骤和步骤追加位置字段。
2. 停止录制与标签页关闭自动保存的 `saveContext` 同步回传目标步骤、步骤追加位置和步骤锚点。
3. 导入身份判断纳入目标步骤和步骤锚点，避免同一场景同名步骤操作被错误复用为旧录制会话。
4. 停止录制时读取当前标签页最终页面地址，通过 `recordedCase.end_url` 传给 admin，支持下一次追加或替换恢复真实页面上下文。

## 涉及文件

- modules/recorder-manager.js
- commit/git-commit-log.md

## 验证

已执行：

    node --check modules/recorder-manager.js
    node --check modules/api-client.js

结果：语法检查通过。

## 具体代码改动

### `modules/recorder-manager.js`

将步骤层定位字段加入录制导入身份、后端请求和录制结束上下文：

```diff
       targetCaseId: recordingImport.targetCaseId ?? '',
+      targetStepId: recordingImport.targetStepId ?? '',
       appendPosition: recordingImport.appendPosition ?? '',
       appendAfterCaseId: recordingImport.appendAfterCaseId ?? '',
+      stepAppendPosition: recordingImport.stepAppendPosition ?? '',
+      appendAfterStepId: recordingImport.appendAfterStepId ?? '',
```

```diff
       targetCaseId: options.targetCaseId,
+      targetStepId: options.targetStepId,
       appendPosition: options.appendPosition,
       appendAfterCaseId: options.appendAfterCaseId,
+      stepAppendPosition: options.stepAppendPosition,
+      appendAfterStepId: options.appendAfterStepId,
```

```diff
       const recordingImport = this.state.recordingImport;
+      const recordingEndUrl = await this._getRecordingTabUrl(recordingTabId);
+      const saveOptions = recordingImport
+        ? { ...recordingImport, recordingEndUrl }
+        : recordingImport;
```

```diff
       recordedCase: {
         id: testCaseId,
         name: options.caseName || scene.name || `录制用例 ${testCaseId || ''}`.trim(),
+        end_url: options.recordingEndUrl || '',
```

# 2026-07-13 CueCast replaceCaseSteps 破坏性确认与替换差异上下文

## 变更内容

1. admin-ui 在 `replaceCaseSteps` 启动录制前增加破坏性操作确认，显示旧步骤数；录制中显示当前捕获的新步骤数，保存结果显示“将替换 X 个旧步骤为 Y 个新步骤”。
2. replaceCaseSteps 直接透传弹窗当前的 `caseName`；未修改时保持原用例名称，修改后覆盖原用例名称，目标用例备注继续保留。
3. CueCast 在停止录制和标签页关闭自动保存的 `saveContext` 中透传替换前步骤数，供 admin-ui 展示差异。

## 涉及文件

- modules/recorder-manager.js
- commit/git-commit-log.md

## 验证

已执行：

    node --check modules/recorder-manager.js

结果：语法检查通过。

## 具体代码改动

### `modules/recorder-manager.js`

替换差异上下文随录制结束事件回传，避免 admin-ui 无法显示替换前步骤数：

```diff
       apiBase: this.api.base,
       appendPosition: recordingImport?.appendPosition,
       appendAfterCaseId: recordingImport?.appendAfterCaseId,
+      replaceOldStepCount: recordingImport?.replaceOldStepCount,
       stepCount: Array.isArray(toSave) ? toSave.length : 0,
```

# 2026-07-13 CueCast 录制导入成功响应兼容

## 涉及文件

- modules/api-client.js
- modules/recorder-manager.js

## 变更内容

1. API 客户端兼容 HTTP 200 且无标准 code/success 包装的成功响应，同时继续拦截带有错误信息的响应、success=false 和明确的失败业务码。
2. 停止录制成功分支补充回传 saveContext，确保 admin-ui 能显示实际的追加位置。
3. 标签页关闭自动保存分支补充回传 appendPosition 和 appendAfterCaseId。
4. admin-ui 的 FIRST 请求同时携带旧协议 __FIRST__ 锚点，兼容后端灰度升级期间的前后端版本差异。

## 修改原因

部分运行环境的录制导入接口虽然 HTTP 状态为 200，但返回包装与标准 code=0/success=true 不一致，旧客户端会误报“保存失败/请求失败”，导致最前面、末尾和指定用例后三种位置都无法确认保存结果。

## 验证

已执行：

    node --check modules/api-client.js
    node --check modules/recorder-manager.js

结果：语法检查通过。

## 具体代码改动

### `modules/api-client.js`

录制导入请求的响应判定改为同时支持标准业务包装和实际部署中的 HTTP 200 成功响应：

```diff
-      const okByCode = data.code === 0 || data.code === '0';
-      const okBySuccess = data.success === true;
-      if (!res.ok || (!okByCode && !okBySuccess)) {
+      const hasCode = data && data.code !== undefined && data.code !== null;
+      const hasSuccessFlag = data && data.success !== undefined && data.success !== null;
+      const normalizedCode = hasCode ? Number(data.code) : null;
+      const okByCode = !hasCode || normalizedCode === 0 || normalizedCode === 200;
+      const explicitFailure = data?.success === false || !okByCode;
+      const hasErrorMessage = data && typeof data === 'object'
+        && ['message', 'msg', 'error'].some((key) => Boolean(data[key]));
+      const acceptedByHttp = res.ok && !hasCode && !hasSuccessFlag && !hasErrorMessage;
+      const acceptedByEnvelope = (hasCode && okByCode) || (hasSuccessFlag && data.success === true);
+      if (!res.ok || (!acceptedByEnvelope && !acceptedByHttp) || explicitFailure) {
```

### `modules/recorder-manager.js`

录制导入意图、导入请求和录制结束通知均透传追加位置字段，并在停止录制成功与失败场景返回完整 `saveContext`：

```diff
     return JSON.stringify({
       mode: recordingImport.mode || '',
       targetSceneDbId: recordingImport.targetSceneDbId ?? '',
       targetCaseId: recordingImport.targetCaseId ?? '',
+      appendPosition: recordingImport.appendPosition ?? '',
+      appendAfterCaseId: recordingImport.appendAfterCaseId ?? '',
       sceneId: recordingImport.scene?.sceneId || '',
     });
```

```diff
       mode: options.mode || 'createScene',
       targetSceneDbId: options.targetSceneDbId,
       targetCaseId: options.targetCaseId,
+      appendPosition: options.appendPosition,
+      appendAfterCaseId: options.appendAfterCaseId,
       scene,
```

```diff
     const saveContext = {
       mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
       apiBase: this.api.base,
+      appendPosition: recordingImport?.appendPosition,
+      appendAfterCaseId: recordingImport?.appendAfterCaseId,
       stepCount: Array.isArray(toSave) ? toSave.length : 0,
     };
```

```diff
       reason: 'completed',
       stepCount: recorded.length,
       saved,
+      saveContext,
```

标签页关闭自动保存使用同一组 `saveContext` 字段，保证异常结束时前端仍能定位实际追加位置。

# 2026-07-13 CueCast appendCase 显式追加位置支持

## 涉及文件

- `modules/recorder-manager.js`

## 变更内容

1. 录制会话去重意图新增 `appendPosition` 和 `appendAfterCaseId`，相同 `testCaseId` 在不同追加位置下不会被误判为同一次录制。
2. `_buildRecordingImportPayload` 新增透传 `appendPosition` 和 `appendAfterCaseId`，确保停止录制后的导入请求保留用户选择的位置。
3. 录制结束事件的 `saveContext` 新增 `appendPosition` 和 `appendAfterCaseId`，供 admin-ui 显示实际导入参数。

## 协议约定

- `appendPosition=FIRST`：将新录制用例插入场景最前面。
- `appendPosition=LAST`：将新录制用例追加到场景末尾。
- `appendPosition=AFTER` 且携带 `appendAfterCaseId`：将新录制用例插入指定用例之后。

CueCast 不解释位置语义，只负责在录制会话、导入请求和结束事件间完整透传。位置校验和最终排序由 admin 后端处理。

## 修改原因

旧方案用空字符串表示末尾、用特殊值表示最前面，且日志无法确认扩展实际提交的参数。显式位置协议可消除三类位置的歧义，并让前端能够诊断导入结果。

## 验证

已执行：

```bash
node --check modules/recorder-manager.js
```

结果：语法检查通过。

## 具体代码改动

### `modules/recorder-manager.js`

```diff
       mode: recordingImport.mode || '',
       targetSceneDbId: recordingImport.targetSceneDbId ?? '',
       targetCaseId: recordingImport.targetCaseId ?? '',
+      appendPosition: recordingImport.appendPosition ?? '',
+      appendAfterCaseId: recordingImport.appendAfterCaseId ?? '',
       sceneId: recordingImport.scene?.sceneId || '',
```

```diff
       mode: options.mode || 'createScene',
       targetSceneDbId: options.targetSceneDbId,
       targetCaseId: options.targetCaseId,
+      appendPosition: options.appendPosition,
+      appendAfterCaseId: options.appendAfterCaseId,
       scene,
```

```diff
     const saveContext = {
       mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
       apiBase: this.api.base,
+      appendPosition: recordingImport?.appendPosition,
+      appendAfterCaseId: recordingImport?.appendAfterCaseId,
       stepCount: Array.isArray(toSave) ? toSave.length : 0,
```

# 2026-07-13 CueCast 录制导入模式去重防错

## 涉及文件

- `modules/recorder-manager.js`

## 变更内容

1. 新增录制导入意图识别逻辑，比较 `mode`、`targetSceneDbId`、`targetCaseId` 和 `scene.sceneId`。
2. 当前已有录制会话时，仅允许相同 `testCaseId` 和相同导入意图的重复消息走原有 dedupe。
3. 如果新的录制请求与当前会话不一致，直接返回错误，提示先停止或取消当前录制，避免复用旧 `createScene` 会话保存追加/替换录制。

## 修改原因

admin-ui 在 `appendCase` 或 `replaceCaseSteps` 模式下启动录制时，如果扩展后台仍认为旧录制会话处于 `recording`，原逻辑会直接返回 `deduped=true`，不会更新 `recordingImport`。这会导致停止保存时仍使用旧会话的 `createScene` payload，后端进入新建场景分支并报“场景ID已存在”。

## 验证

已执行：

```bash
node --check modules/recorder-manager.js
```

结果：语法检查通过。

## 具体代码改动

### `modules/recorder-manager.js`

```diff
+  _recordingImportIdentity(recordingImport) {
+    if (!recordingImport || typeof recordingImport !== 'object') return '';
+    return JSON.stringify({
+      mode: recordingImport.mode || '',
+      targetSceneDbId: recordingImport.targetSceneDbId ?? '',
+      targetCaseId: recordingImport.targetCaseId ?? '',
+      sceneId: recordingImport.scene?.sceneId || '',
+    });
+  }
```

```diff
   async start(testCaseId, startUrl, sourceTabId, options = {}) {
     if (this.state.mode === 'recording') {
+      const activeImportKey = this._recordingImportIdentity(this.state.recordingImport);
+      const nextImportKey = this._recordingImportIdentity(options.recordingImport);
+      const sameRecordingIntent = String(this.state.testCaseId ?? '') === String(testCaseId ?? '')
+        && activeImportKey === nextImportKey;
+      if (!sameRecordingIntent) {
+        return {
+          ok: false,
+          active: true,
+          tabId: this.state.currentTabId,
+          error: '已有录制进行中，请先停止或取消当前录制后再开始新的导入模式录制',
+          activeMode: this.state.recordingImport?.mode || 'legacySaveSteps',
+          requestedMode: options.recordingImport?.mode || 'legacySaveSteps',
+        };
+      }
       return { ok: true, tabId: this.state.currentTabId, deduped: true };
     }
```

# 2026-07-11 CueCast 录制窗口尺寸偏好接入

## 涉及文件

- `background.js`
- `modules/recorder-manager.js`

## 变更内容

1. `background.js`
   - `AT_PLATFORM_RECORD` 收到 admin-ui 发来的 `viewportMode/viewportWidth/viewportHeight` 后，解析为 `windowPreference`。
   - 将 `windowPreference` 传入 `RecorderManager.start`。
2. `modules/recorder-manager.js`
   - 新增录制窗口创建参数转换逻辑。
   - `custom/current` 使用普通窗口并设置宽高；默认模式仍打开最大化窗口。
   - 构造 admin 导入 payload 时优先使用 `recordingImport.screenshotMode`，避免绕过 `start` 的调用路径丢失截图策略。

## 修改原因

admin-ui Chrome 录制弹窗已新增执行窗口尺寸设置。如果 CueCast 仍固定用最大化窗口打开录制页，则“使用当前窗口尺寸”和“自定义尺寸”只能被保存到 payload，不能真正影响录制窗口，导致录制上下文与入库配置不一致。

## 验证

已执行：

```bash
node --check background.js
node --check modules/recorder-manager.js
```

结果：语法检查通过。

## 具体代码改动

### `background.js`

```diff
@@
       state.apiBase = message.apiBase || state.apiBase;
       state.authToken = message.authToken || state.authToken;
-      recorder
-        .start(message.testCaseId, message.startUrl, tabId, {
+      (async () => {
+        const windowPreference = await resolveWindowPreference(message, sender.tab?.windowId);
+        const response = await recorder.start(message.testCaseId, message.startUrl, tabId, {
           insertAfterStepIndex: message.insertAfterStepIndex,
           screenshotMode: message.screenshotMode,
           recordingImport: message.recordingImport,
-        })
-        .then((response) => {
+          windowPreference,
+        });
           if (response?.ok) {
             armRecordingKeepalive();
           }
           sendResponse(response);
-        });
+      })();
```

### `modules/recorder-manager.js`

```diff
@@
+  _buildRecordingWindowCreateData(url, preference) {
+    const data = { url, focused: true };
+    if (preference?.mode === 'custom' || preference?.mode === 'current') {
+      data.state = 'normal';
+      data.width = preference.width;
+      data.height = preference.height;
+      if (preference.left != null) data.left = preference.left;
+      if (preference.top != null) data.top = preference.top;
+      return data;
+    }
+    data.state = 'maximized';
+    return data;
+  }
+
   async start(testCaseId, startUrl, sourceTabId, options = {}) {
```

```diff
@@
         description: options.caseDescription || 'Chrome 扩展录制生成',
-        screenshot_mode: this.state.recordingScreenshotMode || 'standard',
+        screenshot_mode: options.screenshotMode || this.state.recordingScreenshotMode || 'standard',
         window_size_mode: options.windowSizeMode || 'maximized',
```

```diff
@@
       let tab;
       if (startUrl) {
-        const win = await chrome.windows.create({ url: startUrl, focused: true, state: 'maximized' });
+        const win = await chrome.windows.create(this._buildRecordingWindowCreateData(startUrl, options.windowPreference));
         tab = win.tabs[0];
```

# 2026-07-11 CueCast admin 导入 payload 与 step id 契约修复

## 涉及文件

- `modules/recorder-manager.js`

## 变更内容

1. `_buildRecordingImportPayload` 生成 admin 录制导入 payload 时，透传：
   - `mode`
   - `targetSceneDbId`
   - `targetCaseId`
2. 新增上传前步骤标准化逻辑，为 `steps[]` 写入从 1 开始、按当前展示顺序连续递增的 `id`。
3. admin 导入和旧 `saveSteps` 保存路径都使用标准化后的步骤列表，保证录制端按契约传入 `playwright_step.id`。

## 修改原因

admin-ui 已支持 `createScene`、`appendCase`、`replaceCaseSteps` 三种导入模式，CueCast 上传 payload 必须把目标场景和目标用例透传给后端，否则真实录制只能落到默认 `createScene` 路径。

同时，`playwright_step.id` 应由录制端生成，并作为后端生成 `StepDO.order` 的依据；不能依赖后端用 admin 的 `order` 反向伪造原始 step id。

## 验证

已执行：

```bash
node --check modules/recorder-manager.js
```

结果：语法检查通过。

手动脚本验证：

- `_buildRecordingImportPayload` 可输出 `mode=appendCase`、`targetSceneDbId`、`targetCaseId`。
- `recordedCase.steps[]` 会被标准化为连续 `id: 1..N`。

## 具体代码改动

### `modules/recorder-manager.js`

```diff
@@
+  _withSequentialStepIds(steps) {
+    return (Array.isArray(steps) ? steps : []).map((step, index) => ({
+      ...step,
+      id: index + 1,
+    }));
+  }
+
   _getRecordingImportOptions(recordingImport = this.state.recordingImport) {
```

```diff
@@
   _buildRecordingImportPayload(testCaseId, steps, options) {
     const scene = options.scene;
+    const normalizedSteps = this._withSequentialStepIds(steps);
     return {
-      mode: 'createScene',
+      mode: options.mode || 'createScene',
+      targetSceneDbId: options.targetSceneDbId,
+      targetCaseId: options.targetCaseId,
       scene,
@@
-        steps,
+        steps: normalizedSteps,
       },
```

```diff
@@
     if (importOptions) {
       return this.api.importRecording(this._buildRecordingImportPayload(testCaseId, steps, importOptions));
     }
-    return this.api.saveSteps(testCaseId, steps);
+    return this.api.saveSteps(testCaseId, this._withSequentialStepIds(steps));
   }
```

# 2026-07-10 CueCast 录制保存兼容修复

## 涉及文件

- `modules/api-client.js`
- `modules/recorder-manager.js`

## 变更内容

1. `modules/api-client.js`
   - 将接口响应解析从直接 `res.json()` 调整为先读取文本再尝试 JSON 解析。
   - 成功判断从仅支持 `code === 0`，扩展为同时支持：
     - `code === 0`
     - `code === '0'`
     - `success === true`
   - 请求失败时错误信息包含 `HTTP 状态码`、`请求方法`、`完整 URL` 和后端返回消息，避免只显示“请求失败”。

2. `modules/recorder-manager.js`
   - 录制停止保存失败时，在 `AT_RECORDING_END` 消息中回传 `error`。
   - 回传 `saveContext`，包含：
     - `mode`
     - `apiBase`
     - `stepCount`
     - `recordedStepCount`
   - 录制标签页关闭后自动保存失败时，同样透传真实错误和保存上下文。

## 修改原因

`sakura-admin-ui` 接入 Chrome 扩展录制后，保存链路是：

`sakura-admin-ui -> CueCast Chrome 扩展 -> sakura-admin 录制导入接口`

原 `CueCast` API 客户端只认 `data.code === 0` 作为成功条件；而 `sakura-admin` 的统一响应协议以 `success === true` 表示成功，部分响应的 `code` 也可能是字符串。这样会导致后端实际保存成功时，扩展仍误判为失败。

同时，原录制管理器在保存失败时只向页面广播 `saved=false` 和 `tab_closed/completed`，没有把真实异常传回页面，导致 admin-ui 只能看到“录制保存失败”，无法定位是鉴权、代理地址、响应协议还是后端错误。

本次改动只增强 CueCast 的通用 HTTP 响应兼容和错误诊断能力，不在扩展中拼装 sakura-admin 内部数据结构，也不改变录制步骤采集逻辑。

## 验证

已执行：

```bash
node --check modules/api-client.js
node --check modules/recorder-manager.js
```

结果：语法检查通过。

手动验证：

- 在 `sakura-admin-ui` 中发起 Chrome 扩展录制。
- 停止录制后可正常保存到 admin。
- 若保存失败，admin-ui 弹窗可显示扩展回传的真实错误信息和请求上下文。

## 具体代码改动

### `modules/api-client.js`

```diff
@@
-      const data = await res.json();
-      if (data.code !== 0) throw new Error(data.message || '请求失败');
+      const text = await res.text();
+      let data;
+      try {
+        data = text ? JSON.parse(text) : {};
+      } catch (_) {
+        data = { message: text };
+      }
+      const okByCode = data.code === 0 || data.code === '0';
+      const okBySuccess = data.success === true;
+      if (!res.ok || (!okByCode && !okBySuccess)) {
+        const message = data.message || data.msg || data.error || text || '请求失败';
+        throw new Error(`HTTP ${res.status} ${method} ${url}: ${message}`);
+      }
       return data;
```

### `modules/recorder-manager.js`

```diff
@@
     const testCaseId = this.state.testCaseId;
     const recordingImport = this.state.recordingImport;
     const toSave = this._mergeRecordedWithSnapshot(recorded);
+    const saveContext = {
+      mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
+      apiBase: this.api.base,
+      stepCount: Array.isArray(toSave) ? toSave.length : 0,
+      recordedStepCount: recorded.length,
+    };
     this._clearMergeContext();
@@
-        this._showNotification('保存失败', err.message);
+        const error = err?.message || String(err);
+        this._showNotification('保存失败', error);
         this.state.recordedSteps = [];
         this._broadcastRecordingEnd({
           testCaseId,
           reason: 'completed',
           stepCount: recorded.length,
           saved: false,
+          error,
+          saveContext,
         });
@@
     const recordingImport = this.state.recordingImport;
     const recordingWindowId = this.state.recordingWindowId;
     const toSave = this._mergeRecordedWithSnapshot(recorded);
+    const saveContext = {
+      mode: recordingImport?.mode || (recordingImport ? 'recordingImport' : 'legacySaveSteps'),
+      apiBase: this.api.base,
+      stepCount: Array.isArray(toSave) ? toSave.length : 0,
+      recordedStepCount: recorded.length,
+    };
     this._clearMergeContext();
@@
     let saved = false;
+    let saveError = '';
     if (testCaseId && toSave && toSave.length > 0) {
@@
-        this._showNotification('保存失败', err.message);
+        saveError = err?.message || String(err);
+        this._showNotification('保存失败', saveError);
       }
+    } else {
+      saveError = '录制标签页已关闭，但没有可保存的步骤。';
     }
@@
       reason: 'tab_closed',
       stepCount: recorded.length,
       saved,
+      error: saved ? undefined : saveError,
+      saveContext,
     });
```
# 2026-07-31 CueCast 基础设施变量绑定与高权限动作扩展

## 涉及文件

- modules/canonical-action-registry.js
- modules/variable-context.js
- modules/player-manager.js
- commit/git-commit-log.md

## 变更内容

1. 将 `host_command`、`host_file_lookup`、`host_file_delete`、`server_file_upload` 明确登记为 `admin_infrastructure`，不会落入 CDP 或内容脚本。
2. 每次回放变量上下文新增步骤引用扫描和 `runtimeBindings` 生成；基础设施任务只携带当前冻结步骤实际引用的根变量。
3. 文件查询、数据库查询和系统/IP 步骤在 Admin 返回显式变量结果时写回当前回放变量上下文；任务结果不会写入扩展存储或回放报告。

## 修改原因

浏览器回放端不能把已经解析出的变量值直接拼进命令、SQL 或文件配置，也不能把本机/服务器动作误当作 CDP 操作。此次补齐与 Playwright Runner 相同的“一次性绑定、后端冻结步骤解析、用例内存变量回写”边界。

## 验证

已执行：

```powershell
node --check modules/canonical-action-registry.js
node --check modules/variable-context.js
node --check modules/player-manager.js
node --experimental-default-type=module --input-type=module -e "import { CuecastVariableContext } from './modules/variable-context.js'; const variables = new CuecastVariableContext({ rows: [{ id: '7' }] }); const reference = String.fromCharCode(36) + '{rows[0].id}'; const bindings = variables.bindingsForStep({ sql: reference }); if (bindings.rows[0].id !== '7') process.exit(1);"
```

结果：三个模块语法检查通过；嵌套变量引用能只生成根变量绑定。

## 具体代码改动

### `modules/canonical-action-registry.js`

```diff
   { actionType: 'database_native', route: 'admin_infrastructure' },
+  { actionType: 'host_command', route: 'admin_infrastructure' },
+  { actionType: 'host_file_lookup', route: 'admin_infrastructure' },
+  { actionType: 'host_file_delete', route: 'admin_infrastructure' },
+  { actionType: 'server_file_upload', route: 'admin_infrastructure' },
 ].map((entry) => Object.freeze(entry)));
```

### `modules/variable-context.js`

```diff
   resolveStep(step) {
     return resolveRuntimeValue(step, this, true);
   }
+
+  bindingsForStep(step) {
+    const bindings = {};
+    for (const reference of this.referencesInStep(step)) {
+      const { root } = this._parseReference(reference);
+      bindings[root] = this.get(root);
+    }
+    return bindings;
+  }
```

### `modules/player-manager.js`

```diff
   if (isInfrastructureStep(executableStep)) {
     const infrastructureResult = await this._executeInfrastructureStep(sourceCaseKey, executableStep, {
       projectEnvironmentId: executionSnapshot.project_environment_id,
+      runtimeBindings: variableContext.bindingsForStep(step),
     });
   }
+  ...(options.runtimeBindings && Object.keys(options.runtimeBindings).length > 0
+    ? { runtimeBindings: options.runtimeBindings }
+    : {}),
```
# 2026-08-06 CueCast 补齐目录参数的统一执行详情

## 涉及文件

- modules/operation-diagnostics.js
- tests/operation-contract.test.js
- commit/git-commit-log.md

## 变更内容

1. 将目录中变量操作的读取模式、正则替换、日期时间、时间戳单位、计算尾零策略等参数加入统一执行详情。
2. 让 CueCast 详情字段与 Admin `automation-operation-catalog.json` 的参数定义保持一致，便于手动添加和录制步骤使用相同展示模型。
3. 增加目录参数完整性契约测试，确认日期变量的全部参数进入步骤详情。

## 验证

- `node --check modules/operation-diagnostics.js`：通过。
- `node --experimental-default-type=module --test tests/operation-contract.test.js`：待本轮执行。

## 具体代码改动

### `modules/operation-diagnostics.js`

```diff
@@
-  'property_key', 'expression', 'scale', 'timeout_ms', 'sql', 'command', 'script',
+  'property_key', 'expression', 'scale', 'timeout_ms', 'sql', 'command', 'script', 'read_mode',
+  'regex_group', 'replace_from', 'replace_to', 'datetime', 'offset_seconds', 'timestamp_unit',
+  'keep_trailing_zeros',
 ]);
```

### `tests/operation-contract.test.js`

```diff
@@
 test('CueCast execution result adds the shared operation detail without exposing restricted input', () => {
@@
 });
+
+test('CueCast 目录参数完整进入变量执行详情', () => {
+  const result = attachOperationDiagnostic(
+    { action_type: 'global_variable_date', status: 'passed' },
+    {
+      method_code: 'global.variable.date',
+      action_type: 'global_variable_date',
+      variable_name: 'run.date',
+      date_mode: 'offset',
+      format: 'yyyy-MM-dd',
+      datetime: '2026-08-06T00:00:00+08:00',
+      offset_seconds: 60,
+      timestamp_unit: 'second',
+    },
+  );
+  assert.deepEqual(
+    result.details.operation.inputs.map((item) => item.key),
+    ['variable_name', 'format', 'date_mode', 'datetime', 'offset_seconds', 'timestamp_unit'],
+  );
+});
```
