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