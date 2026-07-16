# 录制、回放与元素定位原理

本文整理 CueCast 当前项目的录制、回放链路，重点说明元素定位策略，以及为什么页面发生轻微变化后回放仍有机会正常执行。

## 总体架构

CueCast 是一个 Chrome Manifest V3 扩展，核心由三层组成：

- `background.js`：Service Worker，负责消息调度、录制/回放状态、API 通信和 CDP 调用。
- `modules/`：业务管理层，`recorder-manager.js` 管录制流程，`player-manager.js` 管回放流程，`api-client.js` 管后端 API。
- `content/`：注入到目标页面的脚本，`recorder.js` 采集用户操作，`player.js` 执行 DOM 降级回放，`selector-core.js` 提供选择器生成能力。

## 录制流程

录制入口在 `modules/recorder-manager.js`。

1. `RecorderManager.start()` 接收用例 ID、起始 URL 和录制选项。
2. 如果传入起始 URL，会新开一个最大化窗口；否则复用当前活动标签页。
3. 等待目标页加载完成后，注入：
   - `content/selector-core.js`
   - `content/recorder.js`
4. 向目标页发送 `AT_START_RECORDING`，页面脚本开始监听用户交互。
5. `content/recorder.js` 监听以下事件：
   - `click`
   - `dblclick`
   - `contextmenu`
   - `input`
   - `change`
   - `keydown`
   - `mouseover`
6. 每次捕获操作后生成 step，通过 `AT_STEP_CAPTURED` 发回后台。
7. `RecorderManager.addStep()` 将步骤放入内存和 session draft；连续编辑同一个输入框时，只保留最后一条 input step。
8. 停止录制时，`RecorderManager.stop()` 调用 `api.saveSteps()` 将步骤保存到后端。

录制期间还有 keepalive 机制：如果目标页跳转或 content script 丢失，`RecorderManager` 会尝试重新注入 recorder，并恢复录制工具栏和当前步数。

## 录制出的 Step 数据

一次普通操作会保存以下核心字段：

- `action_type`：操作类型，例如 `click`、`input`、`key`、`hover`、`assert_text`。
- `target_selector`：主 CSS 定位器。
- `target_xpath`：主 XPath 定位器。
- `value`：输入值、按键值、断言文本或下拉选项文本。
- `url`：录制时页面 URL。
- `description`：步骤描述。
- `locator_meta`：智能定位元信息，是抗页面变化的关键。
- `screenshot` / `screenshot_focus`：步骤截图和焦点信息。

## 回放流程

回放入口在 `modules/player-manager.js`。

1. `PlayerManager.start()` 从后端读取用例和步骤。
2. 根据用例的起始 URL 新开或复用回放标签页。
3. 优先通过 `chrome.debugger` 附加 CDP。
4. 向页面注入 `content/player.js`，作为 DOM 降级执行路径。
5. 逐步执行用例：
   - CDP 可用且该步骤支持 CDP 时，走 `_executeStepCDP()`。
   - CDP 不可用或遇到受限页面时，降级走 `_executeStepDOM()`。
   - `assert_text`、`assert_json`、`ai_natural` 等特殊步骤有额外分支。
6. 执行过程中会按步骤截图、检测页面错误、等待页面加载，并将执行结果回传后端。

CDP 模式更接近真实用户行为，会通过 Chrome DevTools Protocol 发送鼠标、键盘、输入事件。DOM 模式则由 `content/player.js` 在页面内调用 DOM API 执行，是兜底路径。

## 元素定位的核心思路
#### 用例步骤的定位信息示例
```json
{
    "id": 22240,
    "test_case_id": 275,
    "step_index": 6,
    "action_type": "click",
    "target_selector": "div.el-table__body-wrapper.is-scrolling-none:nth-of-type(3) > table.el-table__body > tbody > tr.el-table__row:nth-of-type(3) > td.el-table_1_column_8.el-table__cell > div.cell > span.el-tooltip.text",
    "target_xpath": "(//div[contains(@class,'el-table')])[1]//tbody/tr[3]/td[8]/div/span",
    "value": "",
    "value_masked": 0,
    "url": "https://172.19.5.47/search?page=1&size=10",
    "description": "点击 span: root",
    "wait_before": 0,
    "nl_instruction": "",
    "screenshot": "data:image/jpeg;base64,/xx",
    "screenshot_focus": {
        "x": 0.5036537380550872,
        "y": 0.49387755102040815
    },
    "screenshot_focus_rect": {
        "x": 0.4197114483792393,
        "y": 0.42857142857142855,
        "w": 0.16057710324152144,
        "h": 0.14285714285714285
    },
    "locator_meta": {
        "version": 1,
        "generated_at": 1783067038902,
        "candidates": [
            {
                "type": "table_cell_xpath",
                "value": "(//div[contains(@class,'el-table')])[1]//tbody/tr[3]/td[8]/div/span",
                "score": 0.94
            },
            {
                "type": "table_cell_css",
                "value": ".el-table:nth-of-type(1) tbody > tr:nth-of-type(3) > td:nth-of-type(8) div.cell > span.el-tooltip.text",
                "score": 0.82
            },
            {
                "type": "css_fallback",
                "value": "div.el-table__body-wrapper.is-scrolling-none:nth-of-type(3) > table.el-table__body > tbody > tr.el-table__row:nth-of-type(3) > td.el-table_1_column_8.el-table__cell > div.cell > span.el-tooltip.text",
                "score": 0.72
            },
            {
                "type": "text_exact_tag",
                "value": "span::root",
                "score": 0.7
            },
            {
                "type": "text_exact",
                "value": "root",
                "score": 0.66
            },
            {
                "type": "xpath_fallback",
                "value": "(//div[contains(@class,'el-table')])[1]//tbody/tr[3]/td[8]/div/span",
                "score": 0.42
            }
        ],
        "context": {
            "tag": "span",
            "overlay": false,
            "control_kind": "span",
            "label_text": "",
            "container_text": "root",
            "sibling_index": 0,
            "rect": {
                "left": 987,
                "top": 566,
                "width": 28,
                "height": 23,
                "viewportWidth": 1920,
                "viewportHeight": 929
            },
            "table": {
                "framework": "el",
                "wrapper_index": 0,
                "section": "tbody",
                "row_index": 2,
                "col_index": 7,
                "row_text": "3 | 2026-04-17 17:37:08 | 信息 | 172.18.1.128 | 172.19.3.52 | select | create materialized view view1 as select a1 from t1 where aaa | 失败 | 详情"
            }
        }
    },
    "value_encrypted": 0,
    "value_redacted": 0
}
```

项目不是只依赖一个 CSS 或 XPath，而是采用：

> 主 CSS + 主 XPath + 多候选 locator_meta + 场景上下文 + 组件兜底

这套组合定位策略让回放在页面轻微变化后仍能尽量找到正确元素。

### 1. 主 CSS 选择器

录制时通过 `getUniqueSelector()` 生成 `target_selector`。

优先级大致是：

1. 稳定 id。
2. 语义属性，如 `data-testid`、`data-test`、`data-id`、`name`、`aria-label`、`role`。
3. 表格内行列路径。
4. 按钮、链接的稳定 class 或父级组合。
5. tag + class。
6. 最后降级为结构路径 `a > b:nth-of-type(n)`。

生成时会尽量保证选择器唯一，避免 `querySelector()` 总是命中第一个相似元素。

### 2. 主 XPath

录制时通过 `getXPath()` 生成 `target_xpath`。

XPath 主要用于：

- CSS 不适合表达的结构路径。
- 浮层选项的文本定位。
- 表格单元格内元素定位。
- 弹窗、Poptip、Modal 内部控件定位。
- iView、Ant Design 等组件库的特殊结构。

### 3. 智能定位元信息 locator_meta

`locator_meta` 由 `buildSmartLocatorMeta()` 生成，里面包含多个候选定位器和上下文信息。

候选定位器会按分数排序，常见类型包括：

- `css_attr_data-testid`
- `css_attr_data-test`
- `css_attr_name`
- `css_attr_aria-label`
- `css_attr_placeholder`
- `css_id`
- `css_fallback`
- `xpath_fallback`
- `component_root_class`
- `table_cell_xpath`
- `table_cell_css`
- `text_exact`
- `text_exact_tag`
- `tree_interaction`
- `tree_node_text`

回放时会先尝试 `locator_meta.candidates`，再尝试主 XPath 和主 CSS。

### 4. 上下文信息

`locator_meta.context` 会记录元素所处场景，用于多个候选元素同时命中时做二次选择。

典型上下文包括：

- 控件类型，例如 input、textarea、combobox、button、link。
- 表格信息，例如表格框架、wrapper 序号、行号、列号、行文本。
- 树节点信息，例如节点标题、父路径、层级、同名节点序号。
- 浮层 reveal 信息，例如某个菜单项需要先 hover 或 click 才出现。
- Monaco 编辑器等特殊控件标记。

这使得“相同选择器命中多个元素”时，不必直接选第一个，而是结合录制时的语义环境选最接近的那个。

## 为什么页面变化后还能回放

当前项目主要靠以下策略提升鲁棒性。

### 1. 避开动态 id 和状态 class

录制器会识别并排除常见不稳定 id：

- 纯数字 id。
- 长 hash id。
- `rc_*_数字` 这类 Ant Design / rc 运行时 id。
- React `useId` 形式，例如 `:r0:`。
- `radix-*`、`headlessui*` 等运行时生成 id。

也会过滤状态 class：

- focus / focused
- hover / hovered
- active / selected
- current / checked
- open / expanded
- `is-active`、`is-open` 等

这些值经常随着重渲、交互状态或组件库版本变化而变化，不适合作为稳定定位依据。

### 2. 优先使用语义属性

如果页面上有 `data-testid`、`data-test`、`name`、`aria-label`、`title` 等语义属性，录制器会优先记录。

这类属性通常比 DOM 层级、样式 class、位置索引更稳定，因此页面结构调整时仍可能命中正确元素。

### 3. 表格使用行列和行文本定位

表格内控件很容易出现“所有行按钮 class 一样”的情况。项目会记录：

- 当前行序号。
- 当前列序号。
- 所在表格 wrapper。
- 行文本摘要。
- 单元格内相对路径。

回放时如果选择器命中多个元素，会结合行文本和行列信息选目标，避免总是点到第一行。

### 4. 浮层和下拉选项按文本与可见层定位

下拉框、菜单、Tooltip、Poptip、Modal 等浮层经常被 teleport 到 `body` 下，结构路径很不稳定。

项目对这类元素会：

- 避免强行记录脆弱 CSS 结构路径。
- 优先使用选项文本生成 XPath。
- 回放时扫描可见浮层。
- 按 z-index、dialog/modal 优先级、可见性选择最上层目标。
- 支持先 hover/click 触发 reveal，再查找目标。

这可以避免点到隐藏模板、旧浮层、页面底部同名按钮。

### 5. 树组件使用节点语义定位

对 Ant Tree、虚拟树和通用 Tree，项目会记录：

- 节点标题。
- 父路径。
- 层级。
- 同名节点序号。
- 点击的是节点内容、展开按钮还是节点操作图标。

回放时会重新扫描当前可见树节点，并按标题、父路径、层级评分。只要树的语义结构没有大变，即使 DOM 重渲或节点 id 改变，也可能重新找到目标节点。

### 6. 多候选定位器逐级兜底

回放查找顺序大致是：

1. `locator_meta` 高分候选。
2. 表格、树、文本等语义候选。
3. 主 XPath。
4. 主 CSS。
5. 特殊组件兜底，例如 Ant Select 搜索框、iView Radio、iView Table 单元格。
6. 文本 fallback 或当前焦点元素。

单一定位器失效时，其他候选仍可能命中。

### 7. 等待异步加载和禁用态恢复

`waitForElement()` 和 CDP 查找逻辑会轮询等待元素出现。页面存在 loading UI 时，等待计时会暂停扣减，避免接口加载稍慢就误判失败。

如果元素还处于 disabled 状态，也会继续等待一段时间，直到控件可操作或超时。

## 能覆盖的变化范围

这套策略对以下变化相对友好：

- React/Vue 重渲导致 DOM 节点重建。
- 动态 id 变化。
- 状态 class 变化。
- 弹窗、下拉、菜单重新挂载。
- 表格中存在多个相同按钮或输入框。
- 表格 wrapper 或组件库 class 有轻微变化。
- 树节点 DOM 重渲。
- 页面异步加载变慢。
- 同名按钮同时存在于页面和弹窗中。

## 仍然无法保证的情况

当前实现不是绝对稳定，以下变化仍可能导致回放失败或点错：

- 页面语义属性被移除或改名，例如 `data-testid`、`name`、`aria-label`。
- 按钮文案、选项文本、树节点标题发生变化。
- 表格行文本变化，或目标行被排序、过滤、删除。
- 树的父路径或层级发生明显变化。
- 前置步骤没有把页面带到录制时的状态。
- 目标元素被不可预期弹窗、遮罩、权限页覆盖。
- 页面组件结构大改，现有特殊兜底逻辑不再适配。
- 业务数据变化导致目标元素根本不存在。

更准确地说，项目当前是在“页面轻微变化”下尽量恢复目标定位，而不是从任意页面变化中自动推断用户意图。

## 关键代码位置

- `modules/recorder-manager.js`：录制生命周期、注入 recorder、保存步骤、keepalive。
- `content/recorder.js`：事件监听、步骤构建、选择器生成、`locator_meta` 生成。
- `content/selector-core.js`：选择器核心工具，包含稳定 id/class 过滤、CSS/XPath 生成。
- `modules/player-manager.js`：回放生命周期、CDP 执行、截图、断言、DOM 降级调度。
- `content/player.js`：DOM 降级回放、元素查找、候选定位器匹配、浮层/树/表格兜底。
