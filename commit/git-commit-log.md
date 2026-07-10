# 2026-07-10 CueCast 录制保存兼容修复

## 涉及文件

- `cuecast/modules/api-client.js`
- `cuecast/modules/recorder-manager.js`

## 变更内容

1. `cuecast/modules/api-client.js`
   - 将接口响应解析从直接 `res.json()` 调整为先读取文本再尝试 JSON 解析。
   - 成功判断从仅支持 `code === 0`，扩展为同时支持：
     - `code === 0`
     - `code === '0'`
     - `success === true`
   - 请求失败时错误信息包含 `HTTP 状态码`、`请求方法`、`完整 URL` 和后端返回消息，避免只显示“请求失败”。

2. `cuecast/modules/recorder-manager.js`
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
node --check cuecast/modules/api-client.js
node --check cuecast/modules/recorder-manager.js
```

结果：语法检查通过。

手动验证：

- 在 `sakura-admin-ui` 中发起 Chrome 扩展录制。
- 停止录制后可正常保存到 admin。
- 若保存失败，admin-ui 弹窗可显示扩展回传的真实错误信息和请求上下文。

## 具体代码改动

### `cuecast/modules/api-client.js`

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

### `cuecast/modules/recorder-manager.js`

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
