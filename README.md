# CC Bar Vue 嵌入示例

给客户看的最小接入页：**Vue 3 + 坐席条 + 日志**。界面、日志与状态语义对齐 `D:\code\ccbar\index.html`（参考页），软电话用 **npm 上的 `@16x/webphone-sdk`**（`import { CCBarClient }`），不再用 `<script>` 加载全局对象。

> 交付给客户的完整文档在 **[docs/前端接入文档.md](docs/前端接入文档.md)**：目录、接口契约、部署反代、排障表、与旧版脚本 SDK 的 API 对照。README 只留最短的上手与维护说明。

## 5 分钟上手

```powershell
cd D:\code\ccbar-vue-demo
copy .env.example .env     # 编辑 WEBPHONE_PROXY_TARGET=https://<你们的 API 主机>
npm install
npm run dev                # 页面 http://127.0.0.1:5173 ；Token 代理 http://127.0.0.1:3000
```

打开页面 →「设置」填 **API 主机 / API KEY / API SECRET / 内部分机** →「保存」→「签入」。

> 页面要能访问到同源的 `/get-session`（dev 由 Vite 转给本地代理），否则签入会卡在「获取坐席账号失败」。

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
| 外呼 / 内呼带自定义参数 | `client.dial({ destination, userdata })`：代码里的 `USERDATA` 常量非空时原样写进 INVITE 的 `X-User-Data` 头，由平台/服务端读。只能可见 ASCII，留空＝不带头（见下） |
| 内呼 | `client.dial({ destination: 前缀+分机号 })`：旧平台的「内呼」就是把企业前缀（`customerPrefix`）拼在号码前，和参考实现 `insideCall` 一致 |
| 挂断 / 保持 / 恢复 / 转接 | 活动通话上的 `hangup()` / `hold()` / `resume()` / `transfer({ type: 'blind', target })` |
| 接听 / 拒接 | `client.answer(callId)` / `call.reject({ reason })` |
| 空闲 / 休息 | `client.setAgentStatus('available' \| 'break')` → 平台的 `Set Agent Status`（Available / On Break+休息） |
| 置忙 | 页面自己的 `setBusy()` → `POST /set-agent-status`（平台侧是 On Break + reason=忙碌；忙碌与休息平台用同一个状态、靠 reason 区分） |

按钮都带 busy / 连接 / 号码条件禁用（旧脚本版没有，这次补上了）。`dial` / `answer` 在未连接时是**同步抛错**，页面用 `try/catch` 包住。

### 自定义参数（`X-User-Data`）

外呼 / 内呼时可以带一段自定义参数出去，平台/服务端从 SIP 报文的 **`X-User-Data`** 头里读
（旧版脚本 SDK 的 `userdata`，3.1.5 起重新支持；头名与含义没变，平台侧不用改）。
**页面上没有入口** —— 每个接入方要传的内容不一样，直接在代码里改一行：

```ts
// src/lib/usePhone.ts 顶部
const USERDATA = "";   // 例：'tenant=acme;agent=7'
```

改完这行，外呼 / 内呼（含首通保护的自动重拨）都会带上。约束：

- 只能**可见 ASCII**：换行能伪造出新的 SIP 头（头注入），中文等非 ASCII 不合规。中文/JSON 请先
  `encodeURIComponent` / base64，平台侧解回来。写错了会在红字行给中文提示
  （`helpers.ts` 的 `normalizeUserdata` 先拦一道）；SDK 那边只回错误码 `CALL_INVALID_USERDATA`。
- 留空（或纯空白）＝**不带这个头**，与旧版一致。
- 页面侧读不到这个值（SDK 不暴露 SIP 头）：要核对只能看 `SIP` 页的 `INVITE` 原文，或平台侧收到的报文。
- 依赖 `@16x/webphone-sdk` ≥ 3.1.5（`package.json` 已锁 `^3.1.5`）。

## 接口链路（默认形态：会话由服务端拼好）

页面只打两个同源接口（`server/token-server.js` 是本地示例）。服务端按参考页
D:\code\xcall\ccbar\index.html 的顺序把会话拼好：

1. `POST {API主机}/openapi/v1/token/fs`（X-Ca + HMAC-SHA256 签名）→ `{ token, expires }`
2. `POST {API主机}/openapi/token/v1/seat/account/get`，`Authorization: <上面那个 token>` → 坐席账号
3. AES-128-CBC/Pkcs7 解出 SIP 密码（密钥只在服务端）→ 拼 `wss://…/api/fs/sip-ws?token=…`
4. 返回 SDK 的 `WebPhoneSession`，页面用 SDK 的 `sessionProvider` 交给 SDK（SDK 3.1.0 起支持）

坐席状态走 `POST /set-agent-status` → `POST {API主机}/openapi/token/v1/seats/set-status`，
body `{ extension, status, reason }`，其中 **extension 传坐席账号**（会取回会话里的 `username`，可能带企业前缀，不是用户填的分机号）；
status 只有三个值：`Available`(空闲) / `On Break`(置忙 reason=忙碌、休息 reason=休息) / `Logged Out`(退签)。

这样页面不碰 AES 密钥、不依赖网关的跨域配置，平台侧也不用改造。相关环境变量：

| 变量 | 作用 |
|---|---|
| `VITE_SESSION_API` | 会话接口地址，默认同源 `/get-session` |
| `VITE_AGENT_STATUS_API` | 坐席状态接口地址，默认同源 `/set-agent-status` |
| `CC_SEAT_ACCOUNT_PATH` | 坐席账号路径，默认 `/openapi/token/v1/seat/account/get` |
| `CC_SEAT_STATUS_PATH` | 坐席状态路径，默认 `/openapi/token/v1/seats/set-status` |
| `CC_SIP_WS_PATH` | 软电话路径，默认 `/api/fs/sip-ws` |

**软电话 WSS 是必填项**（设置里填 `wss://…/api/fs/sip-ws`），服务端会带上它去拼会话里的 WSS 地址；`SIP 注册有效期`会随请求交给服务端，由服务端写进会话的 `sip.registerExpires`（留空默认 600 秒；SDK 拿不到有效值时才回退 300 秒）。

SIP 保活默认与注册有效期一致（600 秒），即不额外发心跳、只由 JsSIP 每 10 分钟续一次注册；链路上有 nginx/NAT 空闲超时（nginx 默认 60 秒）时会被静默掐断长连接，把 `VITE_SIP_KEEPALIVE=25` 打开心跳即可。

### 换成新平台网关（可选）

网关若部署了 `/webphone/v1/*`（新 SDK 的会话接口），构建时设 `VITE_LEGACY_PLATFORM=0` 切过去：
页面改打同源 `/get-token` 拿 accessToken，SDK 自己请求 `/webphone/v1/sessions` 换会话。
dev 环境需要配 `WEBPHONE_PROXY_TARGET`（Vite 的 `/webphone` 代理目标）。

### 换成你们自己的会话接口

会话地址有两种改法（都不需要动 SDK 代码，和旧 ccbar.js 页面的 `TOKEN_API` 一个套路）：

- **代码里改**：`src/lib/session.ts` 顶部的 `const TOKEN_API = ""`（会话地址同理，见 `sessionUrl()`）—— 留空按约定拼同源路径，填了就原样使用。
- **部署时改**：环境变量 `VITE_SESSION_API=/your/session/path`（优先级高于常量，构建时注入）。

最省事的做法：把 `/get-session` 反代到你们自己的服务，按同一契约返回会话即可 —— 请求体
`{ extension, host?, appKey?, appSecret?, sipWs?, registerExpires? }`（换成你们后端后，后四项可以都不要，
分机与凭据由服务端登录态决定），响应是一份 `WebPhoneSession`（字段见 `server/get-session.js` 末尾）。
页面里的 KEY / SECRET 那时也可以留空（就不会再随请求发出去）。本仓库 `server/get-session.js` +
`server/get-token.js` 那套签名与解密代码可以直接抄。

## 部署注意（重要）

`npm run build` 产物是纯静态 `dist\`，但同源请求必须反代：

| 路径 | 转发到 | 什么时候用 |
|---|---|---|
| `/get-session` | 你们的会话服务（本地开发是 `node server/token-server.js`） | 默认形态（旧平台） |
| `/set-agent-status` | 同上（空闲 / 置忙 / 休息 / 退签） | 默认形态（旧平台） |
| `/get-token` | 你们的签发服务（同上） | 只有切到新平台形态时 |
| `/webphone/v1/*` | 平台的 WebPhone API | 只有切到新平台形态时 |

dev 环境里 `/get-session`、`/set-agent-status`、`/get-token` 由 Vite 转给本地代理；线上用 nginx 做同样的反代。
没有反代时签入会卡在「获取坐席账号失败」。

## 已知环境行为

### 平台不回 ACK 时，通话会在 32 秒后被拆掉

有些平台（或中间的 SBC）收到 200 OK 之后**不回 ACK**。JsSIP 会一直重发 200 OK 等它，
**32 秒还没等到就自己结束这通电话**（`NO_ACK`）：表现是「聊到一半突然断」，日志里一条 `呼叫结束`，
`SIP` 面板里搜不到 `ACK`。这是平台侧的握手缺失，页面/SDK 不能替对端回 ACK —— 要在平台/SBC 侧补齐。

页面的状态标签**不受它影响**：SDK 3.1.7 起 `active`（「通话中」）由**媒体连接**驱动，不再依赖 ACK。

平台在**每次注册完成后的首个外呼**会回 `480 Temporarily Unavailable`（带 `Reason: Q.850;cause=16;text="NORMAL_CLEARING"`，即对端振铃前被正常清除），几秒内自愈。页面遇到这类暂时性失败（`call.failed` 且错误里含 480 / 超时 / 网络类）会**在 0.8 秒后自动重拨一次**（对齐老 ccbar 的「首通 480 Temporarily Unavailable，自动重拨一次」）：**额度按每次签入记账，一次签入只重拨 1 次**，重拨自己再失败既不会重置次数也不会重新计时；某一路接通、退签、或额度用完即停止；到那一刻已经有呼叫在响或在通话就跳过；用户手动拨号会取消当前链条。节奏与计数在 `src/lib/callRetry.ts`（有单测；默认一档时间点，需要多档例如 1.5s / 3s / 6s 时用 `options.delays` 显式传），页面只负责日志与「拨哪儿」。**根因在平台侧**，要彻底解决需平台方查同一次签入里失败/成功两条 INVITE 的 Call-ID。

## SIP 原文

页面**固定**打开 JsSIP 的调试命名空间（`localStorage.debug = 'JsSIP:*'`），日志面板的 **SIP 页**因此能看到 REGISTER / INVITE 原文。这是 SDK **未公开**的调试能力（SDK 没暴露 SIP 报文接口，官方途径是 `client.getDiagnostics()`，只有生命周期日志），演示页面不再提供开关：要在页面里排障就一定要有原文。

`enableJsSipDebug()` 在 `onMounted` 里第一时间执行 —— JsSIP 是首次 `connect()` 时懒加载的，debug 包在模块初始化时读一次 `localStorage.debug`，**晚于那一刻设置就不生效**（这也是为什么它不能做成「保存后再生效」的设置项）。

## SDK 来源与回退

- 页面 `import { CCBarClient } from "@16x/webphone-sdk"`。
- 本地若存在 `D:\code\ccbar-web-sdk\src`，Vite 会 alias 到**源码**（方便边改 SDK 边调）；客户机器上没有该目录时自动用 **npm 包**。强制走 npm 包验证：`CCBAR_LOCAL_SDK=0 npm run build`。
- 仓库里**不再有**旧版脚本式 SDK（`public\` 下的 `ccbar.js` / `crypto.js` / `message.js` / `jssip-3.4.4.js` 已删）：页面只走 npm 包，交付包里也就不会混进另一套 1.1MB 的旧 SDK。需要对照旧实现时看 `D:\code\xcall\ccbar`（带 token 的 fork）和 `D:\code\ccbar`（能打通外呼的参考页）。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 页面 + Token 代理一起起 |
| `npm run dev:vite` / `npm run token-server` | 只跑其中一个 |
| `npm test` | `node --test`，覆盖日志与状态文案、校验函数、Token 代理与会话接口、Vue 组件编译 |
| `npm run typecheck` / `npm run build` | `vue-tsc` / 生产构建（Node ≥ 22.18） |
| `npm run preview` | 预览构建产物（注意上面的反代问题） |

## 代码放在哪

```
src/App.vue                     页面骨架：状态标签 + 按钮 + 日志卡片（薄，只做绑定）
src/components/                 设置弹窗、日志卡片、来电浮层
src/lib/usePhone.ts             页面逻辑：状态、按钮动作、SDK 事件 → 页面状态与日志
src/lib/callRetry.ts            首通保护：480 后的重拨节奏与额度（纯函数，有单测）
src/lib/session.ts              会话来源（默认 sessionProvider）+ 坐席状态
src/lib/settings.ts             设置读、校验、写 localStorage
src/lib/sipDebug.ts             SIP 原文：打开 JsSIP debug 并接住 console
src/lib/logs.ts                 日志格式化与状态文案（纯函数，有单测）
src/lib/helpers.ts              地址校验、分机前缀处理
server/                         本地演示代理（生产换成你们自己的后端）
```
