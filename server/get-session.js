import crypto from "node:crypto";
import { getFsToken } from "./get-token.js";

// 旧平台（vxapi / call-ng 这一套）拿会话的三步，全部对齐参考实现 D:\code\xcall\ccbar\index.html：
//   1) POST {API主机}/openapi/v1/token/fs   → { token, expires }（已有 getToken 负责加签）
//   2) POST {API主机}/openapi/token/v1/seat/account/get（Authorization 带上面的 token）→ 坐席账号
//   3) AES-128-CBC/Pkcs7 解出 SIP 密码，再拼出 WSS 地址（?token=）给 SDK 注册
// 放在服务端做：浏览器不用管跨域，AES 密钥也不下发到页面。

const SEAT_ACCOUNT_PATH_DEFAULT = "/openapi/token/v1/seat/account/get";
const SIP_WS_PATH_DEFAULT = "/api/fs/sip-ws";
const SIP_WS_PORT_DEFAULT = 7443;
const AES_KEY = "q7X4p6MvK1z8Lb3A"; // 16 字节
const AES_IV = "W9e2T4mN0aQ7Ru6C"; // 16 字节
const SESSION_TTL_FALLBACK = 600;
// 提前这么久换票：SDK 自己还会在会话到期前 60 秒刷新，两层加起来留够余量
const PASSWORD_REFRESH_BUFFER = 180;

// 与参考实现里的 capabilities 一致：旧平台这六项都支持
const CAPABILITIES = ["outbound", "inbound", "mute", "dtmf", "hold", "blind_transfer"];

// .env 由 dev.mjs 在 import 之后加载，所以要在调用时读
function seatAccountPath() {
  return process.env.CC_SEAT_ACCOUNT_PATH || SEAT_ACCOUNT_PATH_DEFAULT;
}
function sipWsPath() {
  return process.env.CC_SIP_WS_PATH || SIP_WS_PATH_DEFAULT;
}

// CryptoJS.AES.decrypt(密文, key, {iv, mode: CBC, padding: Pkcs7})：字符串密文按 Base64 处理
export function decryptSeatPassword(encrypted) {
  if (!encrypted) return "";
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(AES_KEY, "utf8"),
    Buffer.from(AES_IV, "utf8"),
  );
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(encrypted), "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

// 参考页 buildSipWsUrl：留空按账号的 domain 拼，配了就当基地址（可以只写 /path），最后统一挂 ?token=
export function buildSipWsUrl({ configured, domain, wssPort, host, token }) {
  const base = String(configured || "").trim();
  const fallback = buildDefaultSipWsUrl(domain, wssPort);
  const url = new URL(base || fallback, host);
  // 相对路径按 API 主机解析会继承 https:，软电话要的是 wss:
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

function buildDefaultSipWsUrl(domain, wssPort) {
  const host = String(domain || "").trim();
  if (!host) throw new Error("坐席账号里没有 domain，无法拼软电话 WSS 地址");
  const port = Number(wssPort) || SIP_WS_PORT_DEFAULT;
  const portPart = port === 443 ? "" : `:${port}`;
  return `wss://${host}${portPart}${sipWsPath()}`;
}

// 参考页做过的兜底：这个网关给的 domain 是内网名，实际要用 WSS 的主机名
function sipDomainOf(accountDomain, wssUrl) {
  const domain = String(accountDomain || "").trim();
  if (domain && !/callapi-ng\.innopaas\.com$/i.test(domain)) return domain;
  return new URL(wssUrl).hostname;
}

/**
 * token 接口返回的 expires 换算成秒。
 * 平台有的回秒、有的回毫秒（旧 SDK 的默认值 3600000 就是毫秒写法），
 * 大于一天的一律按毫秒处理，避免把 1 小时算成 1000 小时、导致会话永不刷新。
 */
export function expiresToSeconds(value, fallback = SESSION_TTL_FALLBACK) {
  let seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds > 86400) seconds /= 1000;
  return Math.min(Math.max(Math.floor(seconds), 60), 86400);
}

export async function getSeatAccount({
  host,
  appKey,
  appSecret,
  extension,
  fetchImpl = fetch,
} = {}) {
  const tokenResult = await getFsToken({ extension, host, appKey, appSecret });
  const fsToken = String(tokenResult?.data?.token || "").trim();
  if (!fsToken) throw new Error("Token 接口没有返回 token");

  const base = String(host || "").trim().replace(/\/+$/, "");
  const apiUrl = `${base}${seatAccountPath()}`;
  console.log(`[ccbar-seat-account] POST ${apiUrl}`);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      // 旧平台约定：把 fs token 原样放在 Authorization 上（没有 Bearer 前缀）
      Authorization: fsToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      `坐席账号接口返回了非 JSON 响应（HTTP ${response.status}）：${text.trim().slice(0, 200)}` +
        `。请求地址：POST ${apiUrl}；请确认 API 主机填的是接口网关（不是文档站）`,
    );
  }
  if (!response.ok || result.code !== 0) {
    throw new Error(
      `${result?.message || `获取坐席账号失败（HTTP ${response.status}）`}（POST ${apiUrl}）`,
    );
  }
  if (!result.data) throw new Error("坐席账号接口没有返回 data");
  return { seat: result.data, fsToken, tokenExpires: tokenResult?.data?.expires };
}

/**
 * 按旧平台的接口拼出一个 WebPhoneSession（SDK 的 sessionProvider 契约）。
 * 多带的 username / customerPrefix 只是给页面显示分机用，SDK 不读。
 */
export async function getLegacySession({
  host,
  appKey,
  appSecret,
  extension,
  sipWs,
  registerExpires,
  fetchImpl,
} = {}) {
  const { seat, fsToken, tokenExpires } = await getSeatAccount({
    host,
    appKey,
    appSecret,
    extension,
    fetchImpl,
  });
  const username = String(seat.username || seat.account || extension || "").trim();
  if (!username) throw new Error("坐席账号里没有 username");
  const password = decryptSeatPassword(seat.password);
  if (!password) throw new Error("坐席账号里的 password 解密后为空");

  // SIP 密码是「票」，有效期由坐席账号接口的 expiresIn 决定（参考实现 _accountRefreshDelayMs 的默认值也是 600）。
  // 会话 TTL 必须按这张票算、并留出刷新缓冲，否则票先过期、后续 REGISTER 会 401。
  const seatTtl = expiresToSeconds(seat.expiresIn ?? seat.expires_in, SESSION_TTL_FALLBACK);
  const tokenTtl = expiresToSeconds(tokenExpires);
  const ttl = Math.max(60, Math.min(tokenTtl, seatTtl) - PASSWORD_REFRESH_BUFFER);
  console.log(
    `[ccbar-seat-account] 票有效期 seat=${seatTtl}s token=${tokenTtl}s → 会话 TTL=${ttl}s`,
  );

  const wssUrl = buildSipWsUrl({
    configured: sipWs,
    domain: seat.domain,
    wssPort: seat.wssPort,
    host,
    token: fsToken,
  });
  const sipDomain = sipDomainOf(seat.domain, wssUrl);
  const turnIp = String(seat.turnIp || "").trim();

  return {
    sessionId: `legacy-${Date.now().toString(36)}`,
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
    agent: {
      id: username,
      externalUserId: username,
      displayName: username,
      extension: username,
      status: "Available",
    },
    sip: {
      uri: `sip:${username}@${sipDomain}`,
      registrar: sipDomain,
      // 旧平台：解密出来的就是 SIP 注册密码
      registerTicket: password,
      registerExpires: Number(registerExpires) > 0 ? Number(registerExpires) : SESSION_TTL_FALLBACK,
      ticketExpiresIn: ttl,
    },
    transport: {
      wssUrl,
      // 旧平台的凭据在 URL 的 ?token= 上，没有 ticket 子协议
      ticket: "",
      ticketExpiresIn: ttl,
    },
    // STUN 只带 IP、不带端口：平台下发的 turnPort 不加（带上那个端口反而连不上，
    // 浏览器要等 ICE 收集超时，出局就慢了）
    iceServers: turnIp ? [{ urls: [`stun:${turnIp}`] }] : [],
    policy: {
      maxConcurrentCalls: 2,
      incomingEnabled: true,
      mobileIncomingEnabled: false,
      backgroundCallingSupported: false,
    },
    capabilities: [...CAPABILITIES],
    // 页面显示分机时要去掉的前缀（参考页 shortExtension）
    customerPrefix: String(seat.customerPrefix || "").trim(),
    username,
  };
}
