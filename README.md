# 回演 - Chrome 插件

Manifest V3 Chrome 扩展，实现录制与回放功能。

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

## 使用方式

### 通过弹窗操作（独立使用）
1. 点击浏览器右上角插件图标
2. 点击「配置 API 和 Token」，打开扩展选项页
3. 配置 Admin API Base、鉴权 Token 和控制台地址并保存
4. 返回弹窗确认 Admin 中台状态，再打开控制台

配置保存在当前 Chrome 用户的扩展本地存储中。中台页面临时传入的 API 地址和 Token 仍只对当前录制/回放会话生效，不会覆盖选项页配置。

### 通过中台联动（推荐）
1. 在管理中台的用例详情页点击「开始录制」
2. 中台通过 `window.postMessage` 发送指令
3. 插件的 `bridge.js` Content Script 接收并转发给 Service Worker
4. 录制完成后步骤自动上传到后端并刷新中台

如果导入请求失败，扩展会保留本次录制 session draft；admin-ui 录制结果中点击“重试上传草稿”即可继续使用原步骤和导入上下文上传。

## 回放引擎

- **CDP 模式（优先）**：使用 `chrome.debugger` + Chrome DevTools Protocol，模拟真实鼠标键盘输入，兼容 React/Vue 等框架
- **DOM 模式（降级）**：使用 `document.querySelector` + `element.click()` 等原生 DOM API

### Admin 批量回放用例会话

Admin 的 CDP 批量执行支持以下三种受管会话模式：

- **每条用例独立登录（默认）**：每条用例创建扩展独占的无痕会话，用例结束后关闭全部受控无痕窗口，登录态和站点存储不跨用例保留。
- **复用上一条用例的登录态**：每条用例仍使用新的受控无痕会话；仅在上一条用例成功时，将 Cookie、localStorage、sessionStorage 和 IndexedDB 快照恢复到下一条用例。失败用例不会污染后续登录态。
- **同一浏览器窗口连续执行**：批次内复用同一个受控无痕窗口和活动标签页；用例失败或目标页丢失时重置会话，避免继续使用不可信页面状态。

三种模式都要求扩展能力探测通过。批次开始时配置会被冻结，单条用例不能覆盖；批次结束或中止时必须执行清理。认证快照只保存在 `chrome.storage.session`，不通过 Admin API、执行日志或测试报告持久化。

扩展自动化验证：

```powershell
node --test tests/*.test.js
```

Chrome 扩展页签调试会话无权调用 `Target.attachToBrowserTarget` 和 `Target.createBrowserContext`。CueCast 改用扩展独占无痕会话实现三种语义，不增加 `cookies`/`browsingData` 权限，也不清理用户默认 Profile。启动批次前必须关闭用户自行打开的全部无痕窗口；批次中若出现非 CueCast 管理的无痕窗口，扩展不会关闭用户窗口，而会阻止继续执行并要求人工关闭后重试。
