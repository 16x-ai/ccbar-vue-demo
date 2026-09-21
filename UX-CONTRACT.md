# 操作与状态约定

页面是 Vue 3 复刻的坐席条，结构与样式对齐 `D:/code/ccbar/index.html`（参考页）；软电话用 **npm 上的 `@16x/webphone-sdk`**（`CCBarClient` 核心 API，不用 SDK 自带 UI、不注册自定义元素、不需要引样式）。

| 操作 | 行为 |
|---|---|
| 签入 | `client.connect({ extension })`：内部 `initialize()` → `tokenProvider` → `POST /webphone/v1/sessions` → REGISTER |
| 退签 | `client.disconnect()`（挂断所有通话、删会话） |
| 外呼 / 内呼 | `client.dial({ destination })` / `client.dial({ destination, type: 'extension' })` |
| 挂断 / 保持 / 恢复 / 转接 | 活动通话上 `hangup()` / `hold()` / `resume()` / `transfer({ type: 'blind', target })` |
| 接听 / 拒接 | `client.answer(callId)` / `call.reject({ reason })`（来电在接通前不是 active call，靠 `call.incoming` 的 callId 定位） |
| 空闲 / 休息 | `client.setAgentStatus('available' \| 'break')`；旧平台形态没有这个接口，点击提示「旧平台模式没有坐席状态接口」 |
| 置忙 | 新 SDK 无 busy（`setBu()` 已废弃），按钮保留但点击提示不支持 |

`dial` / `answer` / `setActiveCall` 在未连接时**同步抛错**，调用点必须 `try/catch`。按钮统一带 busy / 连接 / 号码条件禁用。

## 日志

- 两个面板：`日志`（流程）与 `SIP`，可切换；`清空` 只清当前面板。空面板显示占位文案，清空后显示「已清空」。
- 每行格式 `HH:MM:SS.mmm [来源] 内容`；来源：`app` / `token` / `status` / `call` / `sip` / `jssip` / `ccbar`。
- 级别决定颜色：`ok` 绿、`warn` 黄、`error` 红、`info` 默认。
- SDK 事件（`connection.*` / `call.*` / `agent.*` / `error`）经 `sipEventDetail` 只留排障字段后入日志；`call.failed`、`connection.failed`、`error` 记 error 级。
- 拦截 console（`log/info/warn/error/debug`），命中 `JsSIP|WebSocket|Registration|registrar|sip:|UA[|transport|WebPhone` 的输出写进 `SIP` 面板（来源 `jssip`）。SIP 原文靠 `localStorage.debug='JsSIP:*'`（见 README「SIP 原文开关」）。
- 写日志前对 `token=`、`"password"` 打码；`Error` 取 message，对象转 JSON。

## 状态标签

- 工作（坐席）：`agent.statusChanged` → 在线 / 休息 / 离线（class `ccbar_work_status_online|reset|offline`）。
- 服务（通话）：`call.stateChanged` 等事件 → 空闲 / 新建 / 呼出中 / 振铃中 / 接通中 / 通话中 / 保持中 / 已结束 / 失败，映射到参考页的 class `ccbar_serv_status_idle|busy|calling|talking|hold`。
- SIP（连接）：`connection.*` → 未注册 / 连接中 / 已连接 / 重连中 / 注册失败；收到 `connection.registered` 后显示「已注册」（class `ccbar_sip_status_reg|unreg`）。
- 通话标签取「当前活动通话」，来电在接通前退回到第一路未结束的通话，所以振铃中也能正确显示。

## 首通保护

平台在注册后的首个外呼会回 480（`Q.850;cause=16`），新 SDK 把它包成 `call.failed` 的 `CCBarError`。页面在**签入后 15 秒窗口**内、且错误内容命中 480 / 暂时不可用 / 超时 / 网络类时，按「首次失败」起算的 1.5s / 3s / 6s 三个时间点自动重拨（有呼叫在走就跳过该时间点）；接通或退签立即停止。日志会写 `呼叫暂时不可用，1.5s / 3s / 6s 处自动重拨`。

## 设置

API 主机、API KEY、API SECRET、内部分机（必填），软电话 WSS 与 SIP 注册有效期（覆盖项，可留空：SDK 默认从会话取 WSS、注册策略），**旧平台形态**（勾上＝会话改由服务端 `/get-session` 拼：`token/fs` + `seat/account/get` + AES 解密码，见 README），记录 SIP 原文（默认开，改完下次签入生效）。KEY / SECRET 只出现在设置框和 Token 请求体，不进日志；设置写入 `localStorage` 的 `ccbar.vueDemo.settings`。切换平台形态会重建客户端，通话中或已签入时保存会被拒绝（先挂断签出）。无 alert/confirm。
