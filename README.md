# CC Bar Vue 嵌入示例

给客户看的最小接入页：**Vue 3 + 坐席条 + 日志**。界面、日志与状态语义对齐 `D:\code\ccbar\index.html`（参考页），软电话用 **npm 上的 `@16x/webphone-sdk`**（`import { CCBarClient }`）。

> 交付给客户的完整文档在 **[docs/前端接入文档.md](docs/前端接入文档.md)**：目录、接口契约、部署反代、排障表。README 只留最短的上手与维护说明。

## 5 分钟上手

```powershell
cd D:\code\ccbar-vue-demo
copy .env.example .env     # 可选；默认配置就能跑通本地代理
npm install
npm run dev                # 页面 http://127.0.0.1:5173 ；取票服务 http://127.0.0.1:3100
```

打开页面 →「设置」填 **API 主机 / API KEY / API SECRET / 内部分机** →「保存」→「签入」。

> 页面只向同源的 `/ref/get-token` 换一张票（dev 由 Vite 转给取票服务），取坐席账号、解 SIP 密码、
> 拼会话都由 SDK 自己来；取票口不通时会在红字行给出服务端/平台的原话。

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
| 签入 | `client.connect()`（内部先 `initialize()`，再换票 → 取坐席账号 / 解密码 / 拼会话 → REGISTER） |
| 退签 | `client.disconnect()` |
| 外呼 | `client.dial({ destination })` |
| 外呼 / 内呼带自定义参数 | `client.dial({ destination, userdata })`：代码里的 `USERDATA` 常量非空时原样写进 INVITE 的 `X-User-Data` 头，由平台/服务端读。只能可见 ASCII，留空＝不带头（见下） |
| 内呼 | `client.dial({ destination: 前缀+分机号 })`：「内呼」就是把企业前缀（`customerPrefix`）拼在号码前，和参考实现 `insideCall` 一致 |
| 挂断 / 保持 / 恢复 / 转接 | 活动通话上的 `hangup()` / `hold()` / `resume()` / `transfer({ type: 'blind', target })` |
| 接听 / 拒接 | `client.answer(callId)` / `call.reject({ reason })` |
| 空闲 / 休息 | `client.setAgentStatus('available' \| 'break')` → 平台的 `Set Agent Status`（Available / On Break+休息） |
| 置忙 | 页面自己的 `setBusy()` → SDK 的会话来源从浏览器直接打平台的 `seats/set-status`（On Break + reason=忙碌；忙碌与休息平台用同一个状态、靠 reason 区分） |

按钮都带 busy / 连接 / 号码条件禁用。`dial` / `answer` 在未连接时是**同步抛错**，页面用 `try/catch` 包住。

### 自定义参数（`X-User-Data`）

外呼 / 内呼时可以带一段自定义参数出去，平台/服务端从 SIP 报文的 **`X-User-Data`** 头里读。
**页面上没有入口** —— 每个接入方要传的内容不一样，直接在代码里改一行：

```ts
// src/lib/usePhone.ts 顶部
const USERDATA = "";   // 例：'tenant=acme;agent=7'
```

改完这行，外呼 / 内呼都会带上。约束：

- 只能**可见 ASCII**：换行能伪造出新的 SIP 头（头注入），中文等非 ASCII 不合规。中文/JSON 请先
  `encodeURIComponent` / base64，平台侧解回来。写错了会在红字行给中文提示
  （`helpers.ts` 的 `normalizeUserdata` 先拦一道）；SDK 那边只回错误码 `CALL_INVALID_USERDATA`。
- 留空（或纯空白）＝**不带这个头**。
- 页面侧读不到这个值（SDK 不暴露 SIP 头）：要核对只能看 `SIP` 页的 `INVITE` 原文，或平台侧收到的报文。
- 依赖 `@16x/webphone-sdk` ≥ 3.1.5（版本以 `package.json` 为准）。

## 接口链路（页面只换票，会话由 SDK 拼）

页面只打**一个**同源接口：`POST /ref/get-token`（本地示例是 `server2/`，即 xcall 参考实现那套取票服务）。

1. 页面 → 取票服务：`POST /ref/get-token`，body `{ extension, host?, appKey?, appSecret?, sipWs?, registerExpires? }`
2. 取票服务按平台契约加签（`X-Ca-Key` / `X-Ca-Timestamp` / `X-Ca-Nonce` / `X-Ca-Signature`，HMAC-SHA256）
   打 `POST {API主机}/openapi/v1/token/fs` → `{ token, expires }`，原样回给页面（加签用的 SECRET 只在服务端）
3. 这条票之后交给 **SDK 的 legacy 实现**（`@16x/webphone-sdk/legacy` 的 `createLegacySessionProvider`）：
   它打 `POST {API主机}/openapi/token/v1/seat/account/get`（`Authorization: <票>`）取坐席账号
4. SDK 解出 SIP 密码（AES-128-CBC/Pkcs7，或直接用平台回的密文——SDK ≥3.1.10 在会话入口自动解），
   拼出 `wss://…/api/fs/sip-ws?token=<票>`，然后 REGISTER

坐席状态（空闲 / 置忙 / 休息 / 退签）同样由 SDK 从**浏览器直接**请求平台的
`POST {API主机}/openapi/token/v1/seats/set-status`，body `{ extension, status, reason }`，
其中 **extension 传坐席账号**（`username`，可能带企业前缀，不是用户填的分机号）；status 只有三个值：
`Available`(空闲) / `On Break`(置忙 reason=忙碌、休息 reason=休息) / `Logged Out`(退签)。
它优先用会话软电话地址里挂着的那张票（就是上面换来的那张），不会再多换一次。

这样页面不碰 AES 密钥、不依赖网关的跨域配置，平台侧也不用改造。相关环境变量：

| 变量 | 作用 |
|---|---|
| `VITE_REF_TOKEN_API` | 取票口地址，默认同源 `/ref/get-token` |
| `REF_TOKEN_PORT` | 本地取票服务端口，默认 3100（占用时自动往后找） |
| `CC_API_HOST` / `CC_API_APP_KEY` / `CC_API_APP_SECRET` | 取票服务打平台接口的兜底配置（页面设置里的值优先） |

**软电话 WSS 是必填项**（设置里填 `wss://…/api/fs/sip-ws`）：SDK 按坐席账号的域名拼地址时，这个值直接盖在会话的 `transport.wssUrl` 上；`SIP 注册有效期`由 SDK 写进会话的 `sip.registerExpires`（留空默认 600 秒；SDK 拿不到有效值时才回退 300 秒）。

SIP 保活默认与注册有效期一致（600 秒），即不额外发心跳、只由 JsSIP 每 10 分钟续一次注册；链路上有 nginx/NAT 空闲超时（nginx 默认 60 秒）时会被静默掐断长连接，把 `VITE_SIP_KEEPALIVE=25` 打开心跳即可。

### 换成你们自己的取票口

取票地址有两种改法（都不需要动 SDK 代码）：

- **代码里改**：`src/lib/session.ts` 的 `refTokenUrl()` —— 留空按约定拼同源路径，填了就原样使用。
- **部署时改**：环境变量 `VITE_REF_TOKEN_API=/your/token/path`（优先级高于常量，构建时注入）。

对端只要按同一契约实现：请求体 `{ extension, host?, appKey?, appSecret?, sipWs?, registerExpires? }`
（换成你们自己的后端后，后四项可以都不要，分机与凭据由服务端登录态决定），成功回平台那层信封
`{ code: 0, data: { token, expires } }`，失败回 `{ code: -1, message: "原因" }`（页面把 `message` 原样写到红字行）。
本仓库 `server2/get-token.js` 的加签可以直接抄。取票用 `credentials: "omit"`，所以直连别的地址也能用
（只要对方回 CORS 头、不发 `Access-Control-Allow-Credentials`）。页面里的 KEY / SECRET 那时也可以留空
（就不会再随请求发出去）。

## 部署注意（重要）

`npm run build` 产物是纯静态 `dist\`，但同源请求必须反代：

| 路径 | 转发到 |
|---|---|
| `/ref/get-token` | 你们的取票服务（本地开发是 `npm run dev` 起的 server2，端口 3100） |

dev 环境里 `/ref/get-token` 由 Vite 转给取票服务；线上用 nginx 做同样的反代 —— 或者构建时直接把
`VITE_REF_TOKEN_API` 指到你们的地址，省掉反代。没有反代时签入会卡在「取票」那一步，红字行给出原话。

## 已知环境行为

### 平台不回 ACK 时，通话会在 32 秒后被拆掉

有些平台（或中间的 SBC）收到 200 OK 之后**不回 ACK**。JsSIP 会一直重发 200 OK 等它，
**32 秒还没等到就自己结束这通电话**（`NO_ACK`）：表现是「聊到一半突然断」，日志里一条 `呼叫结束`，
`SIP` 面板里搜不到 `ACK`。这是平台侧的握手缺失，页面/SDK 不能替对端回 ACK —— 要在平台/SBC 侧补齐。

页面的状态标签**不受它影响**：SDK 3.1.7 起 `active`（「通话中」）由**媒体连接**驱动，不再依赖 ACK。

### 每次注册后的第一通外呼会回 480

平台在**每次注册完成后的首个外呼**会回 `480 Temporarily Unavailable`（带 `Reason: Q.850;cause=16;text="NORMAL_CLEARING"`，即对端振铃前被正常清除），几秒内自愈。
**页面不做任何兜底、不自动重拨**：失败就照常提示，坐席自己再拨一次即可（会自动重拨的那版已经删掉了）。
**根因在平台侧**，要彻底解决需平台方查同一次签入里失败/成功两条 INVITE 的 Call-ID。

## SIP 原文

页面**固定**打开 JsSIP 的调试命名空间（`localStorage.debug = 'JsSIP:*'`），日志面板的 **SIP 页**因此能看到 REGISTER / INVITE 原文。这是 SDK **未公开**的调试能力（SDK 没暴露 SIP 报文接口，官方途径是 `client.getDiagnostics()`，只有生命周期日志），演示页面不给开关：要在页面里排障就一定要有原文。

`enableJsSipDebug()` 在 `onMounted` 里第一时间执行 —— JsSIP 是首次 `connect()` 时懒加载的，debug 包在模块初始化时读一次 `localStorage.debug`，**晚于那一刻设置就不生效**（这也是为什么它不能做成「保存后再生效」的设置项）。

## SDK 来源与回退

- 页面 `import { CCBarClient } from "@16x/webphone-sdk"`。
- 本地若存在 `D:\code\ccbar-web-sdk\src`，Vite 会 alias 到**源码**（方便边改 SDK 边调）；客户机器上没有该目录时自动用 **npm 包**。强制走 npm 包验证：`CCBAR_LOCAL_SDK=0 npm run build`。
- 仓库里只有 npm 包这一条链，没有 `<script>` 加载的脚本版 SDK：`public\` 下不放 `ccbar.js` / `crypto.js` / `message.js` / `jssip-3.4.4.js`，交付包里不会混进另外一套 1.1MB 的文件。参考实现看 `D:\code\xcall\ccbar`（带 token 的 fork）和 `D:\code\ccbar`（能打通外呼的参考页）。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 页面 + 取票服务一起起 |
| `npm run dev:vite` | 只跑页面（取票服务要自己起：`CCBAR_DEMO=1 node server2/server.js`） |
| `npm test` | `node --test`，覆盖日志与状态文案、校验函数、会话链（换票 → 取账号 → 改状态）、Vue 组件编译 |
| `npm run typecheck` / `npm run build` | `vue-tsc` / 生产构建（Node ≥ 22.18） |
| `npm run preview` | 预览构建产物（注意上面的反代问题） |

## 代码放在哪

```
src/App.vue                     页面骨架：状态标签 + 按钮 + 日志卡片（薄，只做绑定）
src/components/                 设置弹窗、日志卡片、来电浮层
src/lib/usePhone.ts             页面逻辑：状态、按钮动作、SDK 事件 → 页面状态与日志
src/lib/session.ts              会话来源（页面只换票，会话由 SDK 自己拼）+ 坐席状态
src/lib/settings.ts             设置读、校验、写 localStorage
src/lib/sipDebug.ts             SIP 原文：打开 JsSIP debug 并接住 console
src/lib/logs.ts                 日志格式化与状态文案（纯函数，有单测）
src/lib/helpers.ts              地址校验、分机前缀处理
server/dev.mjs                  一条命令同时起取票服务与 Vite
server2/                        本地取票服务（xcall 参考实现那套；生产换成你们自己的）
```
