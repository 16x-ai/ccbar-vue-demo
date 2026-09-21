# CC Bar Vue 嵌入示例

给客户看的最小接入页：**Vue 3 + 坐席条 + 日志**。界面、日志与状态语义对齐 `D:\code\ccbar\index.html`（参考页），软电话用 **npm 上的 `@16x/webphone-sdk`**（`import { CCBarClient }`），不再用 `<script>` 加载全局对象。

## 5 分钟上手

```powershell
cd D:\code\ccbar-vue-demo
copy .env.example .env     # 编辑 WEBPHONE_PROXY_TARGET=https://<你们的 API 主机>
npm install
npm run dev                # 页面 http://127.0.0.1:5173 ；Token 代理 http://127.0.0.1:3000
```

打开页面 →「设置」填 **API 主机 / API KEY / API SECRET / 内部分机** →「保存」→「签入」。

> `WEBPHONE_PROXY_TARGET` 不配的话，SDK 拿不到会话，签入会失败（见下面「接口链路」）。

预期现象：

| 步骤 | 看到什么 |
|---|---|
| 签入 | `日志` 页出现 `开始签入 …` → `connection=connecting` → `connection.registered`，状态标签变「已注册」 |
| 外呼 | 服务标签 振铃中 → 通话中；SIP 页能看到 `INVITE` 原文与响应 |
| 来电 | 弹出「来电（N）」浮层，接听 / 拒接 |
| 保持 / 恢复 / 转接 / 挂断 | 认当前活动通话；转接读「号码」框里的号码 |

## 页面操作与对应 SDK 调用

| 操作 | 调用 |
|---|---|
| 签入 | `client.connect({ extension })`（内部先 `initialize()`，再取 Token、建会话、REGISTER） |
| 退签 | `client.disconnect()` |
| 外呼 | `client.dial({ destination })` |
| 内呼 | `client.dial({ destination, type: 'extension' })` |
| 挂断 / 保持 / 恢复 / 转接 | 活动通话上的 `hangup()` / `hold()` / `resume()` / `transfer({ type: 'blind', target })` |
| 接听 / 拒接 | `client.answer(callId)` / `call.reject({ reason })` |
| 空闲 / 休息 | `client.setAgentStatus('available' \| 'break')` |
| 置忙 | **新 SDK 不提供 busy**（`setBu()` 已废弃），按钮保留但点击会提示 |

按钮都带 busy / 连接 / 号码条件禁用（旧脚本版没有，这次补上了）。`dial` / `answer` 在未连接时是**同步抛错**，页面用 `try/catch` 包住。

## 接口链路（两条都要通）

1. **Token**：页面 `POST /get-token`（同源，body：`host / appKey / appSecret / extension / platform`）→ Vite 转给本地 Token 代理（`server/token-server.js`）→ 代理用 X-Ca + HMAC-SHA256 签名请求 `POST {API主机}/openapi/v1/webphone/tokens` → 返回 `{ accessToken, expiresAt, extension }`。路径与 xcall 坐席条的 `{base}/get-token` 一致；用 `file://` 打开页面时 base 取「API 主机」，否则取页面同源。
2. **WebPhone API（会话）**：SDK 自己请求同源 `POST /webphone/v1/sessions` → Vite 的 `/webphone` 代理 → `WEBPHONE_PROXY_TARGET` → 平台返回会话（SIP URI、`transport.wssUrl` + 一次性 ticket、iceServers、policy）。

SDK 从会话里取 WSS，所以**页面不需要填软电话 WSS**（设置里那项是覆盖项）。`SIP 注册有效期`会随请求交给服务端，由服务端写进会话的 `sip.registerExpires`（留空默认 600 秒；SDK 拿不到有效值时才回退 300 秒）。

### 旧平台形态（设置里勾「旧平台形态」）

网关只有 `token/fs` + `seat/account/get` 那一套（没有 `/webphone/v1/*`）时用这个模式：页面改打同源
`POST /get-session`，由 `server/get-session.js` 在服务端按参考页 D:\code\xcall\ccbar\index.html 的顺序拼会话：

1. `POST {API主机}/openapi/v1/token/fs`（X-Ca 签名，同 `/get-token`）→ `{ token, expires }`
2. `POST {API主机}/openapi/token/v1/seat/account/get`，`Authorization: <上面那个 token>` → 坐席账号
3. AES-128-CBC/Pkcs7 解出 SIP 密码（密钥只在服务端）→ 拼 `wss://…/api/fs/sip-ws?token=…`
4. 返回 SDK 的 `WebPhoneSession`，页面用 SDK 的 `sessionProvider` 交给 SDK

这样页面不碰 AES 密钥，也不依赖网关的 CORS 配置。SDK 侧对应 3.1.0 新增的 `sessionProvider` 钩子
（`/api/webphone-token`、`sessionProvider` 都不需要平台改造）。相关环境变量：

| 变量 | 作用 |
|---|---|
| `VITE_LEGACY_PLATFORM=1` | 构建时把默认形态设成旧平台（用户仍可在设置里改） |
| `VITE_SESSION_API` | 会话接口地址，默认同源 `/get-session` |
| `CC_SEAT_ACCOUNT_PATH` | 坐席账号路径，默认 `/openapi/token/v1/seat/account/get` |
| `CC_SIP_WS_PATH` | 软电话路径，默认 `/api/fs/sip-ws` |

旧平台没有坐席状态接口：点「空闲 / 休息」会提示「旧平台模式没有坐席状态接口」，而不会静默成功。

### 换成你们自己的 Token 签发接口

Token 地址有两种改法（都不需要动 SDK 代码，和旧 ccbar.js 页面的 `TOKEN_API` 一个套路）：

- **代码里改**：`src/lib/usePhone.ts` 顶部的 `const TOKEN_API = ""` —— 留空按约定拼同源 `/get-token`，填了就原样使用（可以填 `/api/xxx`、`http://127.0.0.1:3002/get-token` 或你们自己的域名）。
- **部署时改**：环境变量 `VITE_TOKEN_API=/your/path`（优先级高于常量，构建时注入）。

或者最省事：把 `/get-token` 这一个路径反代到你们的签发服务。只要你们后端满足：

- `POST <该地址>`，请求体至少 `{ platform: 'web', extension }`（分机建议由服务端登录态决定，不采信浏览器传值），可带 Cookie（页面用 `credentials: 'include'`）
- 返回 `{ accessToken: string, expiresAt?: number（秒）, extension?: string }`，非 200 视为失败
- 服务端自己用 APP KEY/SECRET 做 X-Ca + HMAC-SHA256 签名，请求 `POST {API主机}/openapi/v1/webphone/tokens`

改完之后页面里的 KEY / SECRET 可以留空（就不会再随请求发出去）。参考实现：`D:\code\ccbar-web-sdk\examples\token-server\node-express`（零依赖，就是同一契约）；本仓库的 `server/token-server.js` + `server/get-token.js` 里那套签名代码也可以直接抄。

## 部署注意（重要）

`npm run build` 产物是纯静态 `dist\`，但有两个**同源**请求必须反代：

| 路径 | 转发到 |
|---|---|
| `/get-token` | 本地 Token 代理（`node server/token-server.js`），或你们自己的签发服务 |
| `/get-session` | 同上（只勾了「旧平台形态」时才用） |
| `/webphone/v1/*` | 平台的 WebPhone API（旧平台形态用不到） |

dev 环境用 `.env` 里的 `WEBPHONE_PROXY_TARGET` 配；线上用 nginx 做同样的反代。否则签入会卡在「获取 Token 失败」或「会话创建失败」。

## 已知环境行为

平台在**每次注册完成后的首个外呼**会回 `480 Temporarily Unavailable`（带 `Reason: Q.850;cause=16;text="NORMAL_CLEARING"`，即对端振铃前被正常清除），几秒内自愈。页面在签入后 15 秒窗口内遇到这类暂时性失败（`call.failed` 且错误里含 480 / 超时 / 网络类）会自动重拨 1.5s / 3s / 6s 各一次，呼叫一起来就停。**根因在平台侧**，要彻底解决需平台方查同一次签入里失败/成功两条 INVITE 的 Call-ID。

## SIP 原文开关

页面默认打开 JsSIP 的调试命名空间（`localStorage.debug = 'JsSIP:*'`），日志面板的 **SIP 页**因此能看到 REGISTER / INVITE 原文。这是 SDK **未公开**的调试能力（SDK 没暴露 SIP 报文接口，官方途径是 `client.getDiagnostics()`，只有生命周期日志）。设置里可关掉去噪；**改完要重新签入才生效**（JsSIP 在首次连接时懒加载，debug 开关在那之前读一次）。

## SDK 来源与回退

- 页面 `import { CCBarClient } from "@16x/webphone-sdk"`。
- 本地若存在 `D:\code\ccbar-web-sdk\src`，Vite 会 alias 到**源码**（方便边改 SDK 边调）；客户机器上没有该目录时自动用 **npm 包**。强制走 npm 包验证：`CCBAR_LOCAL_SDK=0 npm run build`。
- `public\` 下的 `ccbar.js` / `crypto.js` / `message.js` / `jssip-3.4.4.js` 是**旧版脚本式 SDK**，页面已不再引用，暂时留着做回退；确认新链路稳定后可删。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 页面 + Token 代理一起起 |
| `npm run dev:vite` / `npm run token-server` | 只跑其中一个 |
| `npm test` | `node --test`，覆盖日志与状态文案、校验函数、Token 代理、Vue SFC 编译 |
| `npm run typecheck` / `npm run build` | `vue-tsc` / 生产构建（Node ≥ 22.18） |
| `npm run preview` | 预览构建产物（注意上面的反代问题） |
