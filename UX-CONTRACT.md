# 操作与状态约定

页面是 Vue 3 复刻的坐席条，结构与样式对齐 `D:/code/ccbar/index.html`（下称参考页）；软电话能力来自旧版坐席 SDK `public/ccbar.js`（与 `D:/code/xcall/ccbar` 逐字节一致，挂在 `window.CCBarSDK`）。

| 操作 | 行为 |
|---|---|
| 签入 | 页面：校验设置 → `POST /ccbar/get-token` → SDK `getAccount()` → `login()`；等 `reg.registered`，20 秒未注册即报错 |
| 退签 / 挂断 / 内呼 / 转接 / 保持 / 恢复 / 空闲 / 置忙 / 休息 | 和参考页一样，由 SDK 按元素 id 自行绑定，页面不重复绑定 |
| 外呼 | 页面读「号码」输入框后调 `ccbar.call(number)`；空号、格式、`SIP未连接`、休息状态的提示都在 SDK 里 |
| 接听 / 拒接 | 来电浮层按 `callid` 调 `answer` / `hangup`，操作后立即从列表移除 |

## 日志

- 两个面板：`日志`（流程）与 `SIP`，可切换；`清空` 只清当前面板。空面板显示占位文案，清空后显示「已清空」。
- 每行格式 `HH:MM:SS.mmm [来源] 内容`；来源：`app` / `sip` / `jssip` / `http` / `ccbar` / `call` / `status`。
- 级别决定颜色：`ok` 绿、`warn` 黄、`error` 红、`info` 默认。SDK 事件级别规则与参考页一致（`fail|error` 或 `ua.disconnected` 带 error 记 error）。
- 拦截 console（`log/info/warn/error/debug`），命中 `JsSIP|WebSocket|Registration|registrar|sip:|UA[|transport|WebPhone` 的输出写进 `SIP` 面板（来源 `jssip`）——REGISTER / INVITE 原文因此在页面上可见。
- 写日志前对 `token=`、`"password"` 打码；`Error` 取 message，对象转 JSON。

## 状态标签

- 工作：离线 / 在线 / 忙碌 / 休息；服务：空闲 / 振铃中（未接通）/ 呼出中（拨号重试窗口）/ 通话中（已接通）/ 保持中 / 转接中；SIP：未注册 / 连接中 / 已连接 / 已注册 / 注册失败 / 错误。
- 文案与 class 与 SDK `getStatusText`、`updateUIStatus` 一致；页面通过 `onStatusChange(work, service, signedIn, sip)` 渲染，不由 SDK 直接写 DOM。
- 与 fork 版一致：**以是否已接通为准**。页面用 `outgoing.accepted` / `incoming.accepted` 与 ended/failed/cancel 维护会话表，只要有已接通会话就显示 `talking`（通话中）——参考 SDK 在内呼等时机对已接通会话仍报 `busy`（振铃中），所以不能只认 `calling`。保持/转接仍按 SDK 状态显示。

## 接口地址

- Token 请求：页面 POST 给本地代理 `/ccbar/get-token`，代理用请求体里的 `host` 拼 `{host}/openapi/v1/token/fs`。
- 坐席账号等 SDK 接口：SDK 在 **构造时**把 `baseUrl` 固化成 `customUrl`（或 isPre 默认域名），之后 `post()` 才读它。页面在**签入前**同步成 `{API 主机}/openapi/token/v1`（连同 http/https），所以设置里改主机后不用刷新页面。签入日志会打一行 `坐席账号接口 https://<主机>/openapi/token/v1` 便于核对。

## 首通保护

实测平台在每次注册完成后的**首个外呼**会回 `480 Temporarily Unavailable`，且带 `Reason: Q.850;cause=16;text="NORMAL_CLEARING"`（对端振铃前正常挂断被 FS 映射成 480），几秒后自愈。JsSIP 把 408/410/430/480 统一报成 cause `Unavailable`。

因此页面加了首通兜底（SDK 自己只有失败后 800ms 的一次补拨）：

- 仅在**签入后 15 秒窗口内**、且原因为 `Unavailable` / `Request Timeout` / 408 / 480 时重拨；
- 时间点从**首次失败**起算：1.5s / 3s / 6s，各最多一次，不因中间失败层层顺延；
- 某一时刻若已有呼叫在走（`outgoing.retry` / `progress` / 接通 / 来电）则跳过该次，只留后面的时间点；
- 一旦接通或退签立即停止；
- 日志：`呼叫暂时不可用（Unavailable），1.5s / 3s / 6s 处自动重拨`，每次实拨再记 `呼叫暂时不可用，自动重拨（第 N 次）<号码>`。

窗口外的失败不重拨，避免把「真的打不通」反复骚扰。根因在平台侧（中继/主叫号码绑定在注册后才就绪），如需彻底解决应让平台查 FS 日志：同一次签入里失败与成功的两个 Call-ID。

## 其它

设置含：API 主机、API KEY、API SECRET、内部分机、软电话 WSS、SIP 注册有效期。软电话 WSS **留空**时按账号返回的 `domain` + `wssPort` 自动拼（参考页 `buildSipWsUrl`）；**填了**就用填入地址并拼 `?token=`，`sipDomain` 也照 xcall 坐席条的兜底逻辑（账号 domain 非 callapi-ng 时以账号为准，否则跟随 WSS 主机）。号码和配置失败后保留。KEY / SECRET 只出现在设置框和 Token 请求体，不进日志。设置写入 `localStorage` 的 `ccbar.vueDemo.settings`。无 alert/confirm。远端媒体输出到 `#remoteAudio`（缺它接通后没有声音）。
