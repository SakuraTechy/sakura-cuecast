# 回演 - Chrome 插件

Manifest V3 Chrome 扩展，实现录制与回放功能。

## 安装方法

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择扩展目录（`D:\King\sakura\sakura-cuecast`）

## 目录结构

```
./
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
