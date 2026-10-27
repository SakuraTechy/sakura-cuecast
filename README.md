# 回演 CueCast - Chrome 扩展

Manifest V3 Chrome 扩展，用于在真实网页上录制和回放零代码 Web UI 测试。

The CueCast Manifest V3 extension records and replays codeless Web UI tests on real pages.

## 文档

- [更新日志](docs/changelog.md)
- [录制、回放与定位说明](docs/recording-playback-and-locators.md)

## 安装方法

三种批量回放用例会话依赖 Chrome 125 及以上版本提供的 CDP flat session。低版本 Chrome 或能力探测未通过时，只保留“使用当前浏览器”的旧版兼容回放，不会静默降级为其他会话模式。

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择扩展目录（`D:\King\sakura\sakura-cuecast`）
5. 打开 CueCast 的“详情”，开启“允许在无痕模式下运行”；三种受控用例会话依赖此权限，未开启时只保留当前浏览器兼容模式。

## 目录结构

```
sakura-cuecast/
├── manifest.json          - 插件配置（Manifest V3）
├── background.js          - Service Worker 核心调度器
├── modules/
│   ├── api-client.js      - 与后端 API 通信
│   ├── recorder-manager.js - 录制逻辑管理
│   └── player-manager.js  - 回放逻辑（CDP + DOM 双模式）
├── content/
│   ├── bridge.js          - 桥接层（所有页面常驻）
│   ├── recorder.js        - 录制内容脚本（按需注入）
│   └── player.js          - 回放内容脚本（按需注入）
├── popup/
│   ├── popup.html         - 弹窗页面
│   ├── popup.css          - 弹窗样式
│   └── popup.js           - 弹窗逻辑
├── options/
│   ├── options.html       - Admin 中台配置页
│   ├── options.css        - 配置页样式
│   └── options.js         - 配置保存逻辑
└── icons/                 - 插件图标
```

## 使用方式 / Usage

### 通过弹窗操作（独立使用）
1. 点击浏览器右上角插件图标
2. 点击「配置 API 和 Token」，打开扩展选项页
3. 配置 Admin API Base、鉴权 Token 和控制台地址并保存
4. 返回弹窗确认 Admin 中台状态，再打开控制台

配置保存在当前 Chrome 用户的扩展本地存储中。中台页面临时传入的 API 地址和 Token 仍只对当前录制/回放会话生效，不会覆盖选项页配置。
点击扩展图标后选择「打开工作台」，录制和回放均从 CueCast 中台发起。从 Chrome 应用商店安装的扩展默认打开海外 `https://app.icuecast.ai/dashboard`；通过开发者模式「加载已解压」安装的扩展默认打开国内 `https://app.icuecast.com/dashboard`。

Click the extension icon and choose **Open Dashboard**. Chrome Web Store installations open the overseas dashboard at `https://app.icuecast.ai/dashboard`; extensions loaded unpacked in Developer mode open the domestic dashboard at `https://app.icuecast.com/dashboard`.

### 通过中台联动（推荐）
1. 在管理中台的用例详情页点击「开始录制」
2. 中台通过 `window.postMessage` 发送指令
3. 插件的 `bridge.js` Content Script 接收并转发给 Service Worker
4. 录制完成后步骤自动上传到后端并刷新中台

如果导入请求失败，扩展会保留本次录制 session draft；admin-ui 录制结果中点击“重试上传草稿”即可继续使用原步骤和导入上下文上传。
## 国际化 / Internationalization

- Manifest 与 Popup 使用 Chrome `_locales`，默认语言为英文，当前提供 `en` 与 `zh_CN`。
- 录制器和回放器跟随中台传入的 `locale`；非中文环境默认使用英文。
- 新增语言时复制 `_locales/en/messages.json`，并同步扩展内录制/回放文案。

## 商店打包 / Store package

```bash
cd extension
npm ci
./package.sh
```

打包会先将扩展构建到 `extension/dist/`：后台模块会合并为一个压缩的 Service Worker，内容脚本与 Popup 脚本也会压缩；不会生成 source map，也不会将 `modules/` 原始源码放入发布 ZIP。内容脚本的文件路径及 `selector-core.js → recorder.js` 的注入顺序保持不变。

产物写入 `artifacts/cuecast-extension-v<version>.zip`，并同步更新官网手动安装包 `marketing/public/extension/cuecast-extension.zip`。脚本会校验 Manifest、本地化 JSON、远程资源、ZIP 根目录，以及是否意外包含源码模块或 source map。

如果导入请求失败，扩展会保留本次录制 session draft；admin-ui 录制结果中点击“重试上传草稿”即可继续使用原步骤和导入上下文上传。

## 回放引擎

- **CDP 模式（优先）**：使用 `chrome.debugger` + Chrome DevTools Protocol，模拟真实鼠标键盘输入，兼容 React/Vue 等框架
- **DOM 模式（降级）**：使用 `document.querySelector` + `element.click()` 等原生 DOM API

### CDP 回放 PDF 帮助手册

需要 Chrome 125+，并允许浏览器使用内置 PDF Viewer。更新扩展文件后，在 `chrome://extensions/` 重新加载 CueCast，刷新中台页面，再创建一次新的 CDP 执行；历史失败记录不会自动变为成功。

- 保持原来的“打开帮助手册 → 切换当前最新窗口 → 等待 → 检查属性”步骤，无需重录或修改用例。
- 对 `assert_attribute` 的 `//embed[@type='application/x-google-chrome-pdf']` 定位，CDP 会在当前标签页的内部 iframe / Shadow DOM 中读取真实属性，并等待延迟加载的 Viewer；原始 `playwright_step` 与 `locator_meta` 不变。
- 该能力是 PDF Viewer 专项兼容，不是任意 XPath 的跨 frame 定位。其他窗口中的 PDF、下载记录和文件名都不能代替当前页面的属性断言。
- 报告应显示 `pdf_viewer_frame` 定位来源和实际属性值；定位失败时实际值不可用，错误期望时保留真实值，失败摘要不再显示“属性检查通过”。

本地回归（从 `sakura-cuecast` 目录执行）：

```bash
node --test tests/cdp-pdf-viewer.test.js
node --test --test-name-pattern "执行摘要遵循实际状态" tests/operation-contract.test.js
node --test tests/integration/cdp-pdf-viewer.test.js
```

真实浏览器测试复用相邻 `sakura-playwright` 已安装的 `playwright` 依赖和完整 Chromium；缺失时先在该目录运行 `npm install`、`npm exec -- playwright install chromium`。测试使用全新临时浏览器配置和本地页面，覆盖有头、无头八步回放、错误期望、其他窗口反例和延迟 frame。日志打印 `%TEMP%/cuecast-cdp-pdf-*/` 产物目录，含每种模式的 `result.json` 与步骤 6–8 的 JPEG，不替代真实产品环境验收。

### Admin 批量回放用例会话

Admin 的 CDP 批量执行支持以下三种受管会话模式：

- **每条用例独立登录（默认）**：每条用例创建扩展独占的无痕会话，用例结束后关闭全部受控无痕窗口，登录态和站点存储不跨用例保留。
- **复用上一条用例的登录态**：每条用例仍使用新的受控无痕会话；仅在上一条用例成功时，将 Cookie、localStorage、sessionStorage 和 IndexedDB 快照恢复到下一条用例。失败用例不会污染后续登录态。
- **同一浏览器窗口连续执行**：批次内复用同一个受控无痕窗口和活动标签页；用例失败或目标页丢失时重置会话，避免继续使用不可信页面状态。

三种模式都要求扩展能力探测通过。批次开始时配置会被冻结，单条用例不能覆盖；批次结束或中止时必须执行清理。认证快照只保存在 `chrome.storage.session`，不通过 Admin API、执行日志或测试报告持久化。

#### 同一批次跨用例变量与异常日志

- 同一 CDP 批次、场景和产品环境中，前序成功用例保存的变量可由后续用例使用 `{{passwd}}` 或 `${passwd}` 引用；三种受管模式和当前 Profile 兼容模式均通过后台批次入口处理。预检会识别前序变量，但真正缺失的变量仍会报错。
- 完整变量快照只保存在扩展后台内存中，不写入 `chrome.storage` 或消息响应；展示诊断仅返回脱敏预览和元数据。只有执行成功、结果回传成功且未取消才提交；失败候选不覆盖上一份成功状态。结束/中止批次会清理变量，重新加载扩展也不会恢复旧变量。
- 必须在同一批次顺序选择保存和引用变量的用例；单独执行用例 004 不继承其他批次或其他执行方式的变量。
- Admin 会把 CDP 上报的原始 `execution_logs` 保存为受鉴权日志 artifact，保留异常及毫秒时间；前端从实时切换历史不再以步骤摘要覆盖异常。旧记录无原始日志时只能展示含用例级错误的结果摘要，不会伪造跳过步骤已经执行。
- 生效需要同步更新并重启 Admin、更新 admin-ui、在 `chrome://extensions/` 重新加载 CueCast，随后刷新中台页面。日志文件要求 `automation.playwright-artifact.unified-storage-enabled=true`（默认开启）及可用的系统文件存储；无需数据库迁移或重新录制。

本地回归命令：`node --test tests/batch-variable-context.test.js`。前端日志回归在相邻 `sakura-admin-ui` 执行 `node --test scripts/test-execution-log.mjs`。本轮端到端产品验收按用户安排交人工执行，步骤见工作区 `docs/sakura-playwright-recording-admin-stage4-manual-verification.md` 第 6.3 节。

扩展自动化验证：

```powershell
node --test tests/*.test.js
```

Chrome 扩展页签调试会话无权调用 `Target.attachToBrowserTarget` 和 `Target.createBrowserContext`。CueCast 改用扩展独占无痕会话实现三种语义，不增加 `cookies`/`browsingData` 权限，也不清理用户默认 Profile。启动批次前必须关闭用户自行打开的全部无痕窗口；批次中若出现非 CueCast 管理的无痕窗口，扩展不会关闭用户窗口，而会阻止继续执行并要求人工关闭后重试。
CDP 回放默认尝试让页面在切换到其他浏览器标签后仍按可见页面调度，避免目标站点在 `requestAnimationFrame` 中等待业务流程时永久停在 Loading。它不会把回放窗口抢到前台，但页面的 `visibilityState`、焦点事件及后台资源消耗可能与真实隐藏标签不同。需要测试网站自身的后台行为时，可在扩展 Service Worker 控制台执行 `await chrome.storage.local.set({ cuecastPlaybackVisiblePageEnabled: false })` 后重新运行；删除该键即可恢复默认行为。若浏览器不支持该 CDP 命令，回放自动沿用原有路径。

### 开发调试：回放耗时分段

此诊断默认关闭，只在扩展 Service Worker 控制台和 `chrome.storage.local` 中保存最近一次回放的计时 JSON。它不进入测试结果、后端 API 或用户界面；记录仅含用例 ID、运行 ID、动作类型、耗时、截图字节数、页面加载/可见性/焦点状态、遮挡时的几何与样式状态，以及分类后的请求状态和脚本异常类型，不含 URL、选择器、输入值、响应内容或图片。

在 `chrome://extensions/` 找到 CueCast，点击 **Service Worker → 检查**，在打开的控制台执行：

```js
await chrome.storage.local.set({ cuecastPlaybackPerfEnabled: true });
```

重新执行一条用例。控制台会输出一条以 `[CueCast PERF]` 开头的 JSON；也可用下面的命令打印格式化后的最近一次记录，再从控制台复制，发给开发人员或 AI 分析：

```js
console.log(JSON.stringify((await chrome.storage.local.get('cuecastPlaybackPerfLast')).cuecastPlaybackPerfLast, null, 2));
```

调试结束后关闭并清除本地记录：

```js
await chrome.storage.local.set({ cuecastPlaybackPerfEnabled: false });
await chrome.storage.local.remove('cuecastPlaybackPerfLast');
```

`playback_window` 记录请求的窗口模式，以及浏览器实际报告的窗口状态、外框宽高和焦点，可用于核对“默认最大化”是否生效。

JSON 的 `wall_ms` 是扩展开始回放到清理完成的墙钟时间；`visible_page_emulation` 为 `enabled`、`unavailable` 或 `disabled`，表示最后一个回放标签的 CDP 可见性模拟状态。`phase_ms` 为用例级阶段，`steps[].phase_ms` 为每步阶段，`step_phase_totals_ms` 是逐步合计。`nested_ms` 细分定位、截图、树查找、虚拟列表扫描、浮层选项查找、遮挡等待，以及 `cdp_mouse_move`、`cdp_mouse_press`、`cdp_mouse_release` 三段鼠标命令耗时，可能包含在 `action`、`target_diagnostics` 等阶段中；管线化点击的鼠标移动与按下计时也可能重叠，分析时不要重复相加。`nested_count` 可看重复次数。`steps[].page_state_events` 按回放开始后的 `at_ms` 记录步骤开始、动作完成、步骤结束和加载轮询中的状态变化；连续相同的轮询会合并，并保留 `last_at_ms` 和 `samples`。`steps[].uncovered_checks` 只在点击遇到遮挡时出现，依次记录初始命中、Loading 跳过、重新定位和最终判断；`target_found` 表示这次是否找到目标，`hit_ok` 表示当前命中是否可点击，`blocker` 是不含选择器或页面文字的遮挡类型，`cached_box=true` 表示这次沿用了较早的坐标/遮挡结果，`hit_sample_age_ms` 表示该结果距上次实际命中检查已过多久。开发诊断开启时，遮挡检查中的 `hit_diagnostic` 只记录视口、目标/遮挡项/下拉容器的矩形和有限的样式状态，以及所属选择框展开状态、是否与目标同属一个选择框、当前展开选择框数量；`blocker_owner_open=null` 表示无法可靠判断（例如下拉层挂在页面顶层）。这些字段不含页面文字或选择器，可用来区分真实展开、透明层仍拦截点击和位置重叠。该数组最多保留 64 条，超出数量见 `uncovered_checks_dropped`。`other_ms` 是尚未单独分段的时间。Runner 等待领取任务的排队时间不在此记录内。单步非加载定位链路从首次实际定位起有 15 秒墙钟上限；Loading 期间暂停这项预算，并受 90 秒单步加载上限约束。

排查持续 Loading 时，`page_state_events` 还会记录 `loading_marker`（触发 Loading 判断的标记类型）、`spinner_marker`、`marker_effectively_visible` 与 `spinner_effectively_visible`（包含祖先节点后的实际可见性），以及 `target_present`（当前步骤的录制目标是否存在）。用例级 `network_requests` 保存最近 80 条 XHR/Fetch 的分类、发起步骤、开始/响应/结束时间、HTTP 状态和 `pending`/`finished`/`failed` 状态；`table_list` 对应表列表接口，其余未知接口统一为 `other_api`，不记录 URL 和参数。`network_capture_enabled` 表示 CDP 网络事件是否成功开启；超出记录上限见 `network_requests_dropped`。`script_exceptions` 只记录异常类型与发生步骤。`finished` 表示浏览器完成请求传输，不代表页面已成功处理响应。
