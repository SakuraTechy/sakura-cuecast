# 回演 CueCast - Chrome 扩展

Manifest V3 Chrome 扩展，用于在真实网页上录制和回放零代码 Web UI 测试。

The CueCast Manifest V3 extension records and replays codeless Web UI tests on real pages.

## 安装方法

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本目录（`/extension`）

## 目录结构

```
extension/
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
└── icons/                 - 插件图标
```

## 使用方式 / Usage

点击扩展图标后选择「打开工作台」，录制和回放均从 CueCast 中台发起。从 Chrome 应用商店安装的扩展默认打开海外 `https://app.icuecast.ai/dashboard`；通过开发者模式「加载已解压」安装的扩展默认打开国内 `https://app.icuecast.com/dashboard`。

Click the extension icon and choose **Open Dashboard**. Chrome Web Store installations open the overseas dashboard at `https://app.icuecast.ai/dashboard`; extensions loaded unpacked in Developer mode open the domestic dashboard at `https://app.icuecast.com/dashboard`.

### 通过中台联动（推荐）
1. 在管理中台的用例详情页点击「开始录制」
2. 中台通过 `window.postMessage` 发送指令
3. 插件的 `bridge.js` Content Script 接收并转发给 Service Worker
4. 录制完成后步骤自动上传到后端并刷新中台

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

## 回放引擎

- **CDP 模式（优先）**：使用 `chrome.debugger` + Chrome DevTools Protocol，模拟真实鼠标键盘输入，兼容 React/Vue 等框架
- **DOM 模式（降级）**：使用 `document.querySelector` + `element.click()` 等原生 DOM API

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
