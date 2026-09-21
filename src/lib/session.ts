/**
 * 会话从哪来。
 *
 * SDK 要的「会话」= 坐席账号 + SIP 密码 + 软电话 WSS 地址 + 一堆策略。按网关能力有两种拿法：
 *
 *   旧平台（默认） 页面给 SDK 一个 sessionProvider：由我们自己的服务端把会话拼好
 *                 （见 server/get-session.js：token/fs → seat/account/get → 解出 SIP 密码）。
 *   新平台        页面给 SDK 一个 tokenProvider：SDK 自己拿 token 去换会话
 *                 （网关需要有 /webphone/v1/sessions；构建时带 VITE_LEGACY_PLATFORM=0 启用）。
 *
 * 两种都先经过同源代理接口，所以 API KEY / API SECRET 这类凭据不会下发到浏览器。
 * 换成你们自己的后端时，只要按同样的请求/返回契约实现，这个文件就只改地址。
 */

import type { SessionProvider, TokenProvider, WebPhoneSession } from "@16x/webphone-sdk";
import type { LogLevel } from "./logs";
import type { PhoneConfig } from "./settings";

/** 写一行流程日志（由 usePhone 注入） */
export type LogFn = (level: LogLevel, source: string, message: unknown) => void;

/**
 * 当前网关是旧平台还是新平台。
 * 默认旧平台（网关只有 token/fs + seat/account/get）；网关部署了 /webphone/v1/* 时，
 * 构建带上 VITE_LEGACY_PLATFORM=0 切到新平台。运行期不切换，所以不需要重启客户端。
 */
export function isLegacyPlatform(): boolean {
  return String(import.meta.env?.VITE_LEGACY_PLATFORM ?? "1") !== "0";
}

// Token 接口地址，和旧 ccbar.js 页面里的 TOKEN_API 一个用法：
//   留空 = 按约定拼同源 /get-token；用 file:// 直接打开页面时拼「API 主机 + /get-token」
//   填了 = 原样使用，例如 '/your/path'、'https://你们的域名/get-token'
// 也可以不改代码，用构建变量覆盖：VITE_TOKEN_API=/your/path
const TOKEN_API = "";

/** 取 Token 的地址（新平台形态用） */
export function tokenUrl(config: PhoneConfig): string {
  return endpoint(String(import.meta.env?.VITE_TOKEN_API || TOKEN_API || "").trim(), config, "/get-token");
}

/** 取会话的地址（默认形态用），规则与 Token 一致：VITE_SESSION_API > 同源 /get-session */
export function sessionUrl(config: PhoneConfig): string {
  return endpoint(String(import.meta.env?.VITE_SESSION_API || "").trim(), config, "/get-session");
}

/** 设置坐席状态的地址：VITE_AGENT_STATUS_API > 同源 /set-agent-status */
export function agentStatusUrl(config: PhoneConfig): string {
  return endpoint(
    String(import.meta.env?.VITE_AGENT_STATUS_API || "").trim(),
    config,
    "/set-agent-status",
  );
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

/**
 * 新平台形态：SDK 拿这个 token 去换会话。
 * 后端只要返回 { accessToken, expiresAt? } 就算接上了（分机通常由服务端登录态决定）。
 */
export function createTokenProvider(config: PhoneConfig, log: LogFn): TokenProvider {
  return async (request) => {
    const extension = request?.extension || config.extension;
    const { ok, status, data } = await postJson(tokenUrl(config), {
      // 最小契约：这两项就够了
      platform: "web",
      extension,
      ...gatewayFields(config),
    });
    const token = String(data.accessToken || "");
    if (!ok || !token) {
      throw new Error(String(data.message || `获取 Token 失败（HTTP ${status}）`));
    }
    log("ok", "token", `Token 就绪${data.expiresAt ? ` expiresAt=${data.expiresAt}` : ""}`);
    return {
      accessToken: token,
      ...(typeof data.expiresAt === "number" ? { expiresAt: data.expiresAt } : {}),
      ...(typeof data.extension === "string" ? { extension: data.extension } : {}),
    };
  };
}

/**
 * 坐席状态：平台只认这三个字符串（对齐 xcall fork 的 ccbar.js）。
 * 注意「忙碌」和「休息」都是 On Break，靠 reason 区分。
 */
export type SeatStatus = "Available" | "On Break" | "Logged Out";

/** 页面上的名字 → 平台的状态 + 原因 */
export const SEAT_STATUS_TEXT: Record<"idle" | "busy" | "break" | "offline", [SeatStatus, string]> = {
  idle: ["Available", "空闲"],
  busy: ["On Break", "忙碌"],
  break: ["On Break", "休息"],
  offline: ["Logged Out", ""],
};

/**
 * 调服务端设置坐席状态（空闲 / 置忙 / 休息 / 退签）。
 * 服务端再带 fs token 去请求平台：POST {API主机}/openapi/token/v1/seats/set-status。
 *
 * 注意 extension 要传「坐席账号」而不是用户填的分机号：账号可能带企业前缀
 * （例如账号 p8001、用户填 8001），平台按账号查坐席，传错会回「Data not found」。
 */
export async function setSeatStatus(
  config: PhoneConfig,
  account: string,
  status: SeatStatus,
  reason: string,
  log: LogFn,
): Promise<void> {
  log("info", "seat", `设置坐席状态 ${status}${reason ? `（${reason}）` : ""}`);
  const { ok, status: httpStatus, data } = await postJson(agentStatusUrl(config), {
    extension: account,
    status,
    reason,
    ...gatewayFields(config),
  });
  if (!ok || data.code !== 0) {
    throw new Error(String(data.message || `设置坐席状态失败（HTTP ${httpStatus}）`));
  }
  log("ok", "seat", `坐席状态已更新：${reason || status}`);
}

/** 旧平台的坐席账号里多带的字段：分机前缀给页面显示用，username 用来打日志 */
export type SeatAccount = { username?: string; customerPrefix?: string };

/**
 * 默认形态（旧平台）：会话由我们自己的服务端拼好，页面只负责交给 SDK。
 * SDK 在注册有效期将到时调 refreshSession，这里顺带重新取一次账号（等价于换一次 SIP 密码）。
 */
export function createLegacySessionProvider(
  config: PhoneConfig,
  log: LogFn,
  onAccount?: (account: SeatAccount) => void,
): SessionProvider {
  // 平台按「坐席账号」认坐席：取回会话后就用它，别再退回用户填的分机号
  let account = config.extension;

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
    account = String(session.username || account);
    onAccount?.({ username: session.username, customerPrefix: session.customerPrefix });
    return session as WebPhoneSession;
  }

  return {
    createSession: fetchSession,
    refreshSession: fetchSession,
    // SDK 只表达「空闲 / 休息」，都走同一个平台接口；置忙 SDK 没有对应取值，页面直接调 setSeatStatus
    setAgentStatus: ({ status }) => {
      const [seatStatus, reason] = SEAT_STATUS_TEXT[status === "available" ? "idle" : "break"];
      return setSeatStatus(config, account, seatStatus, reason, log);
    },
  };
}
