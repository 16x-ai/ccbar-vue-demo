import type { SessionProvider } from "@16x/webphone-sdk";
import { createLegacySessionProvider } from "@16x/webphone-sdk/legacy";
import type { AgentState, LogLevel } from "./logs";
import type { PhoneConfig } from "./settings";

/** 写一行流程日志（由 usePhone 注入） */
export type LogFn = (level: LogLevel, source: string, message: unknown) => void;

/** 取票口地址：`VITE_REF_TOKEN_API` 优先；否则同源 `/get-token`（file:// 打开的页面用 API 主机拼） */
export function refTokenUrl(config: PhoneConfig): string {
  const configured = String(import.meta.env?.VITE_REF_TOKEN_API || "").trim();
  if (configured) return configured;
  const base = location.protocol === "file:" ? config.host.trim().replace(/\/+$/, "") : "";
  return `${base}/get-token`;
}

/**
 * 换一张 fs token：POST 取票口，按平台那层信封 `{ code: 0, data: { token, expires } }` 解析。
 * 失败时把服务端/平台那句原因原样抛出去（SDK 会包进 `CCBarError.cause`，页面用 causeText 取出来）。
 *
 * `credentials: "omit"`：取票服务只回显 Origin，这样把地址指到别的域、让页面直连也能用。
 */
async function fetchRefFsToken(config: PhoneConfig, log: LogFn) {
  const url = refTokenUrl(config);
  log("info", "seat", `请求取票口 ${url}`);

  const response = await fetch(url, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extension: config.extension,
      // 本示例把设置里的这几项也带上；换成你们自己的后端后可以都不发（分机与凭据应由登录态决定）
      ...(config.host ? { host: config.host } : {}),
      ...(config.appKey ? { appKey: config.appKey } : {}),
      ...(config.appSecret ? { appSecret: config.appSecret } : {}),
      ...(config.sipWs ? { sipWs: config.sipWs } : {}),
      ...(config.registerExpires ? { registerExpires: Number(config.registerExpires) } : {}),
    }),
  });

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${url} 返回了非 JSON 响应（HTTP ${response.status}）。` +
        `请确认这里是你们自己的接口地址，或者网关已经开通了对应接口`,
    );
  }

  const message = String(data.message ?? "").trim();
  if (!response.ok || Number(data.code) !== 0) {
    throw new Error(message || `取票失败（HTTP ${response.status}）`);
  }
  const envelope = (data.data ?? {}) as { token?: unknown; expires?: unknown };
  const token = String(envelope.token ?? "").trim();
  if (!token) throw new Error("取票失败：响应里没有 token");
  const expires = Number(envelope.expires);
  log("ok", "seat", `取票成功 expires=${expires > 0 ? expires : "-"}`);
  return { token, ...(expires > 0 ? { expires } : {}) };
}

/** 会话来源：`setAgentStatus` 是必需的（老版本 SDK 没有它，页面切不了坐席状态） */
export type SessionSource = SessionProvider & Required<Pick<SessionProvider, "setAgentStatus">>;

/** 坐席账号里页面用得到的两个字段：分机前缀给标题栏和内呼拼号码用 */
export type SeatAccount = { username?: string; customerPrefix?: string };

/** 造会话来源：换票口由页面提供，其余（取账号 / 解密 / 组装会话）交给 SDK */
export function createSdkSessionProvider(
  config: PhoneConfig,
  log: LogFn,
  onAccount?: (account: SeatAccount) => void,
): SessionSource {
  const provider = createLegacySessionProvider({
    host: config.host,
    getToken: () => fetchRefFsToken(config, log),
    // 软电话地址由页面提供（设置里必填）：SDK 只往上挂 ?token=，不按账号的 domain / wssPort 拼
    sipWsUrl: config.sipWs,
    ...(Number(config.registerExpires) > 0 ? { registerExpires: Number(config.registerExpires) } : {}),
    // 注：移动端来电策略 mobileIncomingEnabled 只在 platform: 'mobile-web' 时才有意义，
    // 而 usePhone 里固定用桌面形态 platform: 'web'（手机浏览器也按桌面策略接来电），所以这里不传
  });
  const { setAgentStatus } = provider;
  if (!setAgentStatus) {
    throw new Error("当前 SDK 版本没有 setAgentStatus：请升级 @16x/webphone-sdk");
  }

  return {
    ...provider,
    setAgentStatus,
    // 拿到会话后把坐席账号回报给页面：分机前缀只在账号里，会话对象没有这一项
    //（账号就在 provider 缓存里，这一下不会多发请求）
    createSession: async (request) => {
      const session = await provider.createSession(request);
      const account = await provider.getSeatAccount().catch(() => undefined);
      if (account) {
        onAccount?.({
          username: String(account.username ?? account.account ?? "").trim() || session.agent.extension,
          customerPrefix: String(account.customerPrefix ?? "").trim(),
        });
      }
      return session;
    },
  };
}

/**
 * 页面上的名字 → 平台的取值。注意「忙碌」和「休息」在平台上都是 `On Break`，靠 reason 区分；
 * `platform` 只用于写日志（平台只有三个状态值）。
 */
export const SEAT_STATUS: Record<
  AgentState,
  { status: "available" | "break" | "offline"; reason: string; platform: string }
> = {
  available: { status: "available", reason: "空闲", platform: "Available" },
  busy: { status: "break", reason: "忙碌", platform: "On Break" },
  break: { status: "break", reason: "休息", platform: "On Break" },
  offline: { status: "offline", reason: "", platform: "Logged Out" },
};

/** SDK 的错误码在 `message` 上、可读原因在 `cause` 上（平台回的话、换票失败的原因都在那儿） */
export function causeText(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const reason = cause instanceof Error ? cause.message : cause;
  return String(reason ?? (error instanceof Error ? error.message : error));
}

/**
 * 切坐席状态（空闲 / 置忙 / 休息 / 退签）：由 SDK 的实现去请求平台
 * `POST {API主机}/openapi/token/v1/seats/set-status`（Authorization 带 fs token）。
 *
 * 注意 `extension` 用的是平台给的「坐席账号」而不是用户填的分机号：账号可能带企业前缀
 * （例如账号 p8001、用户填 8001），平台按账号查坐席，传错会回「Data not found」。
 */
export async function setSeatStatus(
  provider: SessionSource,
  state: AgentState,
  log: LogFn,
): Promise<void> {
  const { status, reason, platform } = SEAT_STATUS[state];
  log("info", "seat", `设置坐席状态 ${platform}${reason ? `（${reason}）` : ""}`);
  try {
    await provider.setAgentStatus({ status, reason });
  } catch (error) {
    throw new Error(causeText(error));
  }
  log("ok", "seat", `坐席状态已更新：${reason || platform}`);
}
