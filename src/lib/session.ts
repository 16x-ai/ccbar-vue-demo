/**
 * 会话从哪来、坐席状态从哪走。
 *
 * 会话：SDK 要的「会话」= 坐席账号 + SIP 密码 + 软电话 WSS 地址 + 一堆策略。
 * 页面只提供一个「换票口」（`/ref/get-token` → server2，加签用的 SECRET 留在服务端），
 * 剩下的「取坐席账号（seat/account/get）→ 解 SIP 密码 → 拼软电话地址」全部由 SDK 自己完成
 * （createSdkSessionProvider）。
 *
 * 坐席状态：走 **npm 包里的实现**（`@16x/webphone-sdk/legacy` 的 createLegacySessionProvider）——
 * 由它从**浏览器**直接请求平台的 `seats/set-status`；它优先用会话软电话地址里拼着的那张 fs token，
 * 也就是换票口发出去的那一张，不再多换一次票。
 *
 * 加签只在服务端做：换成你们自己的后端后，KEY / SECRET 可以完全不进浏览器（页面设置里留空即可）；
 * 只要按同样的请求/返回契约实现，这个文件就只改地址。
 */

import type { CreateSessionRequest, SessionProvider, WebPhoneSession } from "@16x/webphone-sdk";
import { createLegacySessionProvider } from "@16x/webphone-sdk/legacy";
import type { AgentState, LogLevel } from "./logs";
import type { PhoneConfig } from "./settings";

/** 写一行流程日志（由 usePhone 注入） */
export type LogFn = (level: LogLevel, source: string, message: unknown) => void;

/**
 * 取票口：VITE_REF_TOKEN_API > 同源 /ref/get-token。
 * `/ref/` 由 Vite 代理转发到 server2（xcall 参考实现那套服务，另一个端口），页面只出这一张票。
 */
export function refTokenUrl(config: PhoneConfig): string {
  return endpoint(String(import.meta.env?.VITE_REF_TOKEN_API || "").trim(), config, "/ref/get-token");
}

function endpoint(configured: string, config: PhoneConfig, path: string): string {
  if (configured) return configured;
  // file:// 打开的页面没有同源后端，退回到「API 主机」拼
  const base = location.protocol === "file:" ? config.host.trim().replace(/\/+$/, "") : "";
  return `${base}${path}`;
}

// 本地取票服务需要的字段（host / KEY / SECRET / WSS / 注册有效期）。
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
async function postJson(
  url: string,
  body: unknown,
  credentials: RequestCredentials = "include",
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    credentials,
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

/** SDK 带下来的会话线索：软电话地址里就拼着 fs token（同一张票两用） */
export type AgentStatusContext = { wssUrl?: string };

/** 能切坐席状态的东西：SDK 的 sessionProvider（就是 npm 包里那个实现） */
export type SeatStatusTarget = {
  setAgentStatus(request: AgentStatusRequest, context?: AgentStatusContext): Promise<void>;
};

/**
 * SDK 的错误码在 `message` 上、可读原因在 `cause` 上（平台回的话、换票失败的原因都在那儿），
 * 这里取可读的那句 —— 页面上才不会只显示 `LEGACY_PLATFORM_REJECTED`。
 */
export function causeText(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const reason = cause instanceof Error ? cause.message : cause;
  return String(reason ?? (error instanceof Error ? error.message : error));
}

/**
 * 切坐席状态（空闲 / 置忙 / 休息 / 退签）：由 npm 包的实现去请求平台
 * `POST {API主机}/openapi/token/v1/seats/set-status`（Authorization 带 fs token）。
 *
 * 注意 extension 用的是平台给的「坐席账号」而不是用户填的分机号：账号可能带企业前缀
 * （例如账号 p8001、用户填 8001），平台按账号查坐席，传错会回「Data not found」——
 * 这一步由 SDK 自己取坐席账号完成。
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
    throw new Error(causeText(error));
  }
  log("ok", "seat", `坐席状态已更新：${request.reason || platform}`);
}

/** 坐席账号里多带的字段：分机前缀给页面显示用，username 用来打日志 */
export type SeatAccount = { username?: string; customerPrefix?: string };

/**
 * 会话来源：页面只提供换票口（`/ref/get-token` → server2），
 * 后面「取坐席账号（`POST {API主机}/openapi/token/v1/seat/account/get`）→ 解 SIP 密码 → 拼软电话地址」
 * 全部由 SDK 自己完成。
 */
export type DemoSessionProvider = SessionProvider & SeatStatusTarget;

export function createSdkSessionProvider(
  config: PhoneConfig,
  log: LogFn,
  onAccount?: (account: SeatAccount) => void,
): DemoSessionProvider {
  const provider = createLegacySessionProvider({
    host: config.host,
    getToken: () => fetchRefFsToken(config, log),
    // 设置里的软电话地址直接交给 SDK：它按账号 domain 自己拼时，没有服务端那层「内网域名换成 WSS 主机名」的兜底
    ...(config.sipWs ? { sipWsUrl: config.sipWs } : {}),
    ...(Number(config.registerExpires) > 0 ? { registerExpires: Number(config.registerExpires) } : {}),
    mobileIncomingEnabled: false, // 会话策略：移动端形态不接来电
  });
  const { setAgentStatus, invalidateToken } = provider;
  if (!setAgentStatus) {
    throw new Error("当前 SDK 版本没有 setAgentStatus：请升级 @16x/webphone-sdk");
  }

  /** 上一次 createSession 收到的请求：刷新时复用它（provider 不读这个参数，只是类型上需要一个） */
  let lastRequest: CreateSessionRequest | undefined;

  async function buildSession(request: CreateSessionRequest): Promise<WebPhoneSession> {
    const session = await provider.createSession(request);
    lastRequest = request;
    // 会话里没有 customerPrefix（分机前缀只是页面显示用的）——账号原文就在 provider 缓存里，这一下不会多发请求
    const account = await provider.getSeatAccount().catch(() => undefined);
    if (account) {
      onAccount?.({
        username: String(account.username ?? account.account ?? "").trim() || session.agent.extension,
        customerPrefix: String(account.customerPrefix ?? "").trim(),
      });
    }
    return session;
  }

  return {
    createSession: buildSession,
    // 刷新 = 整条链重跑一遍（等于换一次 SIP 密码）。
    // SDK 传进来的是 sessionId，provider 不看它；没请求过时补一个占位对象，provider 不会读里面的字段。
    refreshSession: async (): Promise<WebPhoneSession> =>
      buildSession(lastRequest ?? { sdkVersion: "", platform: "web" }),
    setAgentStatus,
    invalidateToken,
  };
}

/**
 * 换票的公共实现：POST 一个「换票口」，按平台那层信封 `{ code: 0, data: { token, expires } }` 解析。
 * 失败时把服务端/平台那句原因原样抛出去 —— SDK 会把它包进 CCBarError.cause。
 */
async function postFsToken(
  url: string,
  config: PhoneConfig,
  credentials: RequestCredentials,
  label: string,
): Promise<{ token: string; expires?: number }> {
  const { ok, status, data } = await postJson(
    url,
    { extension: config.extension, ...gatewayFields(config) },
    credentials,
  );
  const message = String(data.message ?? "").trim();
  if (!ok || Number(data.code) !== 0) {
    throw new Error(message || `${label}失败（HTTP ${status}）`);
  }
  // 服务端回的是平台那层信封：{ code: 0, data: { token, expires } }
  const envelope = (data.data ?? {}) as { token?: unknown; expires?: unknown };
  const token = String(envelope.token ?? "").trim();
  if (!token) throw new Error(`${label}失败：响应里没有 token`);
  const expires = Number(envelope.expires);
  return { token, ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}) };
}

/**
 * 换一张 fs token：POST /ref/get-token，由 Vite 代理转到 server2（参考实现那套服务）。
 * 用 `credentials: "omit"` —— server2 只回显 Origin、不发 Access-Control-Allow-Credentials，
 * 这样以后把 VITE_REF_TOKEN_API 指到别的地址、让页面直连它也能用。
 */
async function fetchRefFsToken(
  config: PhoneConfig,
  log: LogFn,
): Promise<{ token: string; expires?: number }> {
  const url = refTokenUrl(config);
  log("info", "seat", `请求取票口 ${url}`);
  const result = await postFsToken(url, config, "omit", "取票");
  log("ok", "seat", `取票成功 expires=${result.expires ?? "-"}`);
  return result;
}
