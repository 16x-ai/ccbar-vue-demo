# CC Bar Vue 嵌入示例

给客户看的最小接入页：**Vue 3 + 坐席条 + 日志**。布局、日志逻辑和通话状态对齐 `D:\code\ccbar\index.html`（坐席条参考页），软电话用旧版坐席 SDK `public\ccbar.js`（与 `D:\code\xcall\ccbar` 逐字节一致），通过 `window.CCBarSDK` 调用。

## 5 分钟上手

```powershell
cd D:\code\ccbar-vue-demo
npm install
npm run dev
```

- 页面：`http://127.0.0.1:5173`
- Token 代理：`http://127.0.0.1:3000`（由 `npm run dev` 一起启动）

打开页面 → 点「设置」填 **API 主机 / API KEY / API SECRET / 内部分机** → 「保存」→「签入」。软电话 WSS 留空即可（按账号返回的 `domain` + `wssPort` 自动拼）；只有要连别的环境（如 `wss://call-ng.innopaas.com/api/fs/sip-ws`）时才填，token 会自动拼成 `?token=`。

预期现象：

| 步骤 | 看到什么 |
|---|---|
| 签入 | 坐席条显示「分机 <账号全号>」，SIP 面板依次出现 `开始登录话机 …` → `ua.connected` → `reg.registered`，状态变「已注册」 |
| 外呼 | 状态「振铃中」→ 对方接听变「通话中」；SIP 面板能看到 `INVITE` 原文和响应 |
| 来电 | 弹出「来电（N）」浮层，接听 / 拒接 |
| 保持 / 恢复 / 转接 / 挂断 | 都在「通话」一行；转接读「号码」框里的号码 |

## 页面操作

- **签入 / 退签**：页面负责取 Token、取坐席账号、`login()`；退签由 SDK 绑定（与参考页一致）。
- **外呼 / 内呼 / 挂断 / 转接 / 保持 / 恢复**、**空闲 / 置忙 / 休息**：由 SDK 按元素 id 绑定，页面不重复绑。
- **号码**框：外呼 / 内呼 / 转接的目标；空号、格式、`SIP未连接`、休息状态的提示都由 SDK 给出。
- **设置**：API 主机、API KEY、API SECRET、内部分机、软电话 WSS（可留空）、SIP 注册有效期（留空＝600 秒）、记录 SIP 原文开关。KEY / SECRET 只 POST 给 Token 接口，不进日志。

## Token 链路

页面把设置 POST 给同源 `/ccbar/get-token`：

```json
{ "host": "https://…", "extension": "1000", "appKey": "你的 KEY", "appSecret": "你的 SECRET" }
```

Vite dev server 把它转给本地 Token 代理（`server/token-server.js`），代理按 host 选签名方式（`*.yundianlab.com` / `x.16x.tech` 用 MD5，其余 HMAC-SHA256）加签后请求 `POST {API主机}/openapi/v1/token/fs`，返回 `{ code: 0, data: { token, expires, extension } }`。SDK 拿 token 用于它自己的坐席账号等接口（`{API 主机}/openapi/token/v1/...`）。

自己接的话，把这个路径换成你们自己的服务端接口即可，页面只要求返回 `{ token, expires }`。

## 部署注意（重要）

`npm run build` 产出的是**纯静态** `dist\`，但页面仍然要 POST `/ccbar/get-token`：

- 用 nginx 之类托管 `dist\` 时，必须把 `/ccbar/` 反代到 Token 代理（`node server/token-server.js`），否则一签入就是「获取 token 失败」；
- 或者改写页面里的 token 请求，直连你们自己的接口。

## 已知环境行为

平台在**每次注册完成后的首个外呼**会回 `480 Temporarily Unavailable`（带 `Reason: Q.850;cause=16;text="NORMAL_CLEARING"`，即对端振铃前被正常清除），几秒内自愈。页面在签入后 15 秒内遇到这类暂时不可用会自动重拨（1.5s / 3s / 6s 各一次，呼叫一起来就停），日志里会写明。**根因在平台侧**，要彻底解决需平台方查同一次签入里失败/成功两条 INVITE 的 Call-ID。

## SDK 文件

`public\` 下的 `ccbar.js`、`crypto.js`、`message.js`、`jssip-3.4.4.js` 是旧版坐席 SDK（Vite 原样拷到 `dist\`，dev 和 build 都能用）。要改 SDK 源码：改 `D:\code\xcall\ccbar` 里的文件再复制到 `public\`；或把 `index.html` 里 `./ccbar.js` 换成 Vite 插件提供的 `/legacy/ccbar.js`（dev 下实时读源码，build 不产出）。

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 页面 + Token 代理一起起 |
| `npm run dev:vite` / `npm run token-server` | 只跑其中一个 |
| `npm test` | `node --test`，覆盖日志/状态文案、校验函数、Token 代理、Vue SFC 编译 |
| `npm run typecheck` / `npm run build` | `vue-tsc` / 生产构建（Node ≥ 22.18） |
| `npm run preview` | 预览构建产物（注意上面的 Token 代理问题） |

## 后续

要换成新 SDK（`@16x-ai/ccbar-sdk`，见 `D:\code\ccbar-web-sdk`）时：它是 `initialize / connect / dial` 一套 API，但需要自备 Token 服务和可达的 WebPhone 后端；本仓库的 `vite.config.ts` 里已经保留了把 `@16x/webphone-sdk` 指到本地源码的 alias，`server/get-token.js` 里也有对应的 webphone 签发分支。
