/**
 * 会话从哪来、坐席状态从哪走。
 *
 * 会话：SDK 要的「会话」= 坐席账号 + SIP 密码 + 软电话 WSS 地址 + 一堆策略，
 * 由我们自己的服务端拼好后交给 SDK（sessionProvider）。
 * 见 server/get-session.js：token/fs → seat/account/get → 解出 SIP 密码（用 npm 包的 decryptSipPassword）→ 拼 WSS。
 *
 * 坐席状态：走 **npm 包里的实现**（`@16x/webphone-sdk/legacy` 的 createLegacySessionProvider）——
 * 由它从**浏览器**直接请求平台的 `seats/set-status`，不再经过本仓库的服务端路由；
 * 它优先用会话软电话地址里拼着的那张 fs token，拿不到时才回落到取票口子（同源 /get-token）。
 *
 * 中间经过同源代理接口，所以 API KEY / API SECRET 这类凭据不会下发到浏览器。
 * 换成你们自己的后端时，只要按同样的请求/返回契约实现，这个文件就只改地址。
 */

import type { SessionProvider, WebPhoneSession } from "@16x/webphone-sdk";
import { createLegacySessionProvider } from "@16x/webphone-sdk/legacy";
import type { AgentState, LogLevel } from "./logs";
import type { PhoneConfig } from "./settings";

/** 写一行流程日志（由 usePhone 注入） */
export type LogFn = (level: LogLevel, source: string, message: unknown) => void;

/** 取会话的地址：VITE_SESSION_API > 同源 /get-session */
export function sessionUrl(config: PhoneConfig): string {
  return endpoint(String(import.meta.env?.VITE_SESSION_API || "").trim(), config, "/get-session");
}

/** 取 fs token 的地址：VITE_TOKEN_API > 同源 /get-token（坐席状态拿不到会话里那张票时的兜底） */
export function tokenUrl(config: PhoneConfig): string {
  return endpoint(String(import.meta.env?.VITE_TOKEN_API || "").trim(), config, "/get-token");
}

function endpoint(configured: string, config: PhoneConfig, path: string): string {
  if (configured) return configured;
  // file:// 打开的页面没有同源后端，退回到「API 主机」拼
  const base = location.protocol === "file:" ? config.host.trim().replace(/\/+$/, "") : "";
  return `${base}${path}`;
}

// 本地代理模式需要的字段（host / KEY / SECRET / WSS / 注册有效期）。
// 换成你们自己的后端后，这些都可以不发——分机与凭据应该由服务端登录态决定。
function gatewayFields(config: PhoneConfig): Record<string, unknown> {
  return {
    ...(config.host ? { host: config.host } : {}),
    ...(config.appKey ? { appKey: config.appKey } : {}),
    ...(config.appSecret ? { appSecret: config.appSecret } : {}),
    ...(config.sipWs ? { sipWs: config.sipWs } : {}),
    ...(config.registerExpires ? { registerExpires: Number(config.registerExpires) } : {}),
  };
}

/** 发一个 JSON POST，把响应解析成对象；响应不是 JSON（例如打到了文档站）时给出可读的报错 */
async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `${url} 返回了非 JSON 响应（HTTP ${response.status}）。` +
        `请确认这里是你们自己的接口地址，或者网关已经开通了对应接口`,
    );
  }
  return { ok: response.ok, status: response.status, data: (data ?? {}) as Record<string, unknown> };
}

/** SDK 的 setAgentStatus 请求：平台取值（Available / On Break / Logged Out）由 npm 包内部映射 */
export type AgentStatusRequest = { status: "available" | "break" | "offline"; reason: string };

/**
 * 页面上的名字 → SDK 的请求 + 日志里那个平台取值。
 * 注意「忙碌」和「休息」在平台上都是 On Break，靠 reason 区分——所以 reason 一定要传下去。
 */
export const SEAT_STATUS: Record<
  AgentState,
  { request: AgentStatusRequest; platform: string }
> = {
  available: { request: { status: "available", reason: "空闲" }, platform: "Available" },
  break: { request: { status: "break", reason: "休息" }, platform: "On Break" },
  busy: { request: { status: "break", reason: "忙碌" }, platform: "On Break" },
  offline: { request: { status: "offline", reason: "" }, platform: "Logged Out" },
};

/** SDK 带下来的会话线索：软电话地址里本来就拼着 fs token（老平台同一张票两用） */
export type AgentStatusContext = { wssUrl?: string };

/** 能切坐席状态的东西：SDK 的 sessionProvider（就是 npm 包里那个实现） */
export type SeatStatusTarget = {
  setAgentStatus(request: AgentStatusRequest, context?: AgentStatusContext): Promise<void>;
};

/**
 * 切坐席状态（空闲 / 置忙 / 休息 / 退签）：由 npm 包的实现去请求平台
 * `POST {API主机}/openapi/token/v1/seats/set-status`（Authorization 带 fs token）。
 *
 * 注意 extension 用的是平台给的「坐席账号」而不是用户填的分机号：账号可能带企业前缀
 * （例如账号 p8001、用户填 8001），平台按账号查坐席，传错会回「Data not found」——
 * 这一步现在由 SDK 自己取坐席账号完成。
 */
export async function setSeatStatus(
  target: SeatStatusTarget,
  agent: AgentState,
  log: LogFn,
): Promise<void> {
  const { request, platform } = SEAT_STATUS[agent];
  log("info", "seat", `设置坐席状态 ${platform}${request.reason ? `（${request.reason}）` : ""}`);
  try {
    await target.setAgentStatus(request);
  } catch (error) {
    // SDK 的 message 是错误码，可读原因放在 cause 上（平台回的话、换票失败的原因都在那儿）
    const cause = (error as { cause?: unknown } | null)?.cause;
    const reason = cause instanceof Error ? cause.message : cause;
    throw new Error(String(reason ?? (error instanceof Error ? error.message : error)));
  }
  log("ok", "seat", `坐席状态已更新：${request.reason || platform}`);
}

/** 坐席账号里多带的字段：分机前缀给页面显示用，username 用来打日志 */
export type SeatAccount = { username?: string; customerPrefix?: string };

/**
 * 会话由我们自己的服务端拼好，页面只负责交给 SDK。
 * SDK 在注册有效期将到时调 refreshSession，这里顺带重新取一次账号（等价于换一次 SIP 密码）。
 */
export type DemoSessionProvider = SessionProvider & SeatStatusTarget;

export function createSessionProvider(
  config: PhoneConfig,
  log: LogFn,
  onAccount?: (account: SeatAccount) => void,
): DemoSessionProvider {
  // 坐席状态交给 npm 包：它优先用会话软电话地址里的 token 打平台接口（并自己取坐席账号）
  let statusTarget: SeatStatusTarget | undefined;
  let sessionWssUrl = "";
  const seatStatus = (): SeatStatusTarget => (statusTarget ??= createSeatStatusTarget(config));

  async function fetchSession(): Promise<WebPhoneSession> {
    log("info", "seat", `开始获取坐席账号 ${sessionUrl(config)}`);
    const url = sessionUrl(config);
    const { ok, status, data } = await postJson(url, {
      extension: config.extension,
      ...gatewayFields(config),
    });
    const session = data as Partial<WebPhoneSession> & { message?: string } & SeatAccount;
    // 最小校验：有 sip.uri 才算真的拿到了会话
    if (!ok || !session.sip?.uri) {
      throw new Error(String(session.message || `获取坐席账号失败（HTTP ${status}）`));
    }
    onAccount?.({ username: session.username, customerPrefix: session.customerPrefix });
    // 会话里的软电话地址带着 fs token：留着给切坐席状态用（页面直接调时没有 context）
    sessionWssUrl = String(session.transport?.wssUrl ?? "");
    return session as WebPhoneSession;
  }
  return {
    createSession: fetchSession,
    refreshSession: fetchSession,
    setAgentStatus: (request: AgentStatusRequest, context?: AgentStatusContext) => {
      // SDK 有会话时会带 context 上来；页面自己调的（置忙 / 退签）用取会话时记住的那个地址
      const carried = context ?? (sessionWssUrl ? { wssUrl: sessionWssUrl } : undefined);
      return seatStatus().setAgentStatus(request, carried);
    },
  };
}

/**
 * 坐席状态的目标：npm 包里的实现（`@16x/webphone-sdk/legacy` 的 createLegacySessionProvider）。
 * 它优先用会话软电话地址里拼着的那张 fs token（`?token=`）去打平台的 seat/account/get 与
 * seats/set-status —— 不用再多一个接口、也不用再换一次票；只有拿不到那张票时才会走
 * getToken 回调（同源 /get-token，服务端加签、SECRET 不下发）。
 */
function createSeatStatusTarget(config: PhoneConfig): SeatStatusTarget {
  const provider = createLegacySessionProvider({
    host: config.host,
    getToken: () => fetchFsToken(config),
  });
  const { setAgentStatus } = provider;
  if (!setAgentStatus) {
    throw new Error("当前 SDK 版本没有 setAgentStatus：请升级 @16x/webphone-sdk");
  }
  // 实现内部不依赖 this，这里直接当普通函数用
  return { setAgentStatus };
}

/**
 * 换一张 fs token：POST 同源的 /get-token（服务端加签，API SECRET 不下发）。
 * 失败时把服务端/平台那句原因原样抛出去 —— SDK 会把它包进 CCBarError.cause。
 */
async function fetchFsToken(config: PhoneConfig): Promise<{ token: string; expires?: number }> {
  const { ok, status, data } = await postJson(tokenUrl(config), {
    extension: config.extension,
    ...gatewayFields(config),
  });
  const message = String(data.message ?? "").trim();
  if (!ok || Number(data.code) !== 0) {
    throw new Error(message || `取 fs token 失败（HTTP ${status}）`);
  }
  // 服务端回的是平台那层信封：{ code: 0, data: { token, expires } }
  const envelope = (data.data ?? {}) as { token?: unknown; expires?: unknown };
  const token = String(envelope.token ?? "").trim();
  if (!token) throw new Error("取 fs token 失败：响应里没有 token");
  const expires = Number(envelope.expires);
  return { token, ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}) };
}
