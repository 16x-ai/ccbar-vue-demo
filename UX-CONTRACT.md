# 操作与状态约定

页面是 Vue 3 复刻的坐席条，结构与样式对齐 `D:/code/ccbar/index.html`（参考页）；软电话用 **npm 上的 `@16x/webphone-sdk`**（`CCBarClient` 核心 API，不用 SDK 自带 UI、不注册自定义元素、不需要引样式）。

| 操作 | 行为 |
|---|---|
| 签入 | `client.connect({ extension })`：内部 `initialize()` → 会话来源（默认 `sessionProvider` → 本地 `/get-session`；新平台形态才是 `tokenProvider`）→ REGISTER |
| 退签 | `client.disconnect()`（挂断所有通话、删会话） |
| 外呼 / 内呼 | `client.dial({ destination })`；内呼时号码先拼企业前缀（`prefixExtension`，与参考实现 `insideCall` 一致） |
| 外呼 / 内呼（带参数） | 代码里的 `USERDATA` 常量非空时随 INVITE 带上 `X-User-Data` 头：`client.dial({ destination, userdata })`（需 SDK ≥ 3.1.5）。页面上没有输入框；只放行可见 ASCII，非法值由 `normalizeUserdata` 拦下并在红字行给中文提示；平台/服务端读这个头，页面侧读不到 |
| 挂断 / 保持 / 恢复 / 转接 | 活动通话上 `hangup()` / `hold()` / `resume()` / `transfer({ type: 'blind', target })` |
| 接听 / 拒接 | `client.answer(callId)` / `call.reject({ reason })`（来电在接通前不是 active call，靠 `call.incoming` 的 callId 定位） |
| 空闲 / 休息 | `client.setAgentStatus('available' \| 'break')` → 平台的 `seats/set-status`（`Available` / `On Break`+reason=休息） |
| 置忙 | 页面直接调 `setSeatStatus(config, 'On Break', '忙碌')`（SDK 的 `setAgentStatus` 没有 busy 取值），用 reason 与「休息」区分 |

`dial` / `answer` / `setActiveCall` 在未连接时**同步抛错**，调用点必须 `try/catch`。按钮统一带 busy / 连接 / 号码条件禁用。

**全屏加载**：签入（取会话 → 连 WSS → REGISTER，几秒钟）与设置坐席状态（空闲 / 置忙 / 休息）期间盖上全屏遮罩 + 转圈 + 文案（「正在签入…」「正在设置坐席状态…」），避免重复点击；操作结束（成功或失败）立即撤掉。

**SIP 保活**：默认与注册有效期一致（600 秒），即不额外发心跳、只由 JsSIP 在到期前续注册。若链路上有 nginx/NAT 的空闲超时（nginx 默认 60 秒），SIP 通道会被静默掐断（页面仍显示已注册、但呼叫失败），这时把 `VITE_SIP_KEEPALIVE` 设成 25 恢复心跳。

## 日志

- 两个面板：`日志`（流程）与 `SIP`，可切换；`清空` 只清当前面板。空面板显示占位文案，清空后显示「已清空」。
- 每行格式 `HH:MM:SS.mmm [来源] 内容`；来源：`app` / `token` / `status` / `call` / `sip` / `jssip` / `ccbar`。
- 外呼 / 内呼那行会带上自定义参数：`外呼 <号码>（X-User-Data: <值>）（话机连接=…）`（`USERDATA` 留空时中间那段省略）。
- 级别决定颜色：`ok` 绿、`warn` 黄、`error` 红、`info` 默认。
- SDK 事件（`connection.*` / `call.*` / `agent.*` / `error`）经 `sipEventDetail` 只留排障字段后入日志；`call.failed`、`connection.failed`、`error` 记 error 级。
- 拦截 console（`log/info/warn/error/debug`），命中 `JsSIP|WebSocket|Registration|registrar|sip:|UA[|transport|WebPhone` 的输出写进 `SIP` 面板（来源 `jssip`）。SIP 原文靠 `localStorage.debug='JsSIP:*'`（见 README「SIP 原文开关」）。
- 写日志前对 `token=`、`"password"` 打码；`Error` 取 message，对象转 JSON。
- **提示分两层**（对齐老 ccbar）：红字行给人看 —— 错误码换成中文（`logs.ts` 的 `errorText`：`CALL_OPERATION_NOT_ALLOWED` → 「呼叫失败」，`CALL_BUSY` → 「对方忙」…），日志里保留原文（错误码 / SIP 原因）给排障。
- **本机自己结束的呼叫不算失败**：`call.failed` 的 `error.cause.originator === 'local'`（挂断、拒接、振铃中取消）时只写一行 `本机结束呼叫`，不弹红字 —— 老 ccbar 的规则是 `if (data.originator !== 'local') setError('呼叫失败')`。只有对端导致的失败（480 / 拒接 / 忙 …）才提示「呼叫失败」。
- **失败不自动重拨**：`call.failed` 只写日志、弹红字，页面不做任何重试（老 ccbar 有一层「首通 480 后 0.8s 重拨一次」，本示例不要）。

## 状态标签

- 工作（坐席）：`agent.statusChanged` → 在线 / 休息 / 离线（class `ccbar_work_status_online|reset|offline`）。
- 服务（通话）：`call.stateChanged` 等事件 → 空闲 / 新建 / 呼出中 / 振铃中 / 通话中 / 保持中 / 已结束 / 失败，映射到参考页的 class `ccbar_serv_status_idle|busy|calling|talking|hold`。**没有「接通中」**：老 ccbar 的 serv 词表里就没有这一档，`_refreshServiceStatus` 是「`isEstablished()` 成立即 talking」，200 OK 一到就成立，所以 SDK 的 `connecting`（已应答、媒体还没连上）也显示「通话中」（绿色 `talking`），与 `active` 同文案 —— 两个状态在 SDK 里仍然分着。
- SIP（连接）：`connection.*` → 未注册 / 连接中 / 已连接 / 注册失败；收到 `connection.registered` 后显示「已注册」。文案与配色对齐老 ccbar（`getStatusText` + `updateUIStatus`）：**只有「已注册」是绿的**（`ccbar_sip_status_reg`），连上了但还没注册成功（已连接）仍是灰的；SDK 的 `reconnecting`（老 ccbar 没有这个概念）显示「未注册」，重连次数只写日志（`重连中（第 N 次）`）。
- 通话标签取「当前活动通话」，来电在接通前退回到第一路未结束的通话，所以振铃中也能正确显示。
- 标题栏的分机 chip：签入后显示 `前缀 <customerPrefix> · 分机 <分机号>`（前缀取自坐席账号，旧平台才有；分机号是去掉前缀后的部分），退签后隐藏。

## 设置

API 主机、API KEY、API SECRET、内部分机、软电话 WSS（都必填；WSS 需 `wss://` 开头）与 SIP 注册有效期（默认 600 秒，交给服务端写进会话的 `sip.registerExpires`）。SIP 原文固定记录，不做成设置项（见 README「SIP 原文」）。KEY / SECRET 只出现在设置框和会话请求体里，不进日志；设置写入 `localStorage` 的 `ccbar.vueDemo.settings`。会话形态（默认旧平台 `token/fs` + `seat/account/get`，见 README）由构建变量 `VITE_LEGACY_PLATFORM` 决定，页面里不切换。无 alert/confirm。
