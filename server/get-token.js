import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// 没有默认主机：每个客户/环境不同，由请求体或 CC_API_HOST 提供
const DEFAULT_HOST = process.env.CC_API_HOST || "";

// 平台接口路径可配：不同环境/版本可能挂在别的路径上（.env 或 shell 环境变量）。
// 注意要在调用时读 —— .env 由 dev.mjs 在 import 之后才加载，写成模块级常量会读不到。
function webphoneTokenPath() {
  return process.env.CC_WEBPHONE_TOKEN_PATH || "/openapi/v1/webphone/tokens";
}
function fsTokenPath() {
  return process.env.CC_FS_TOKEN_PATH || "/openapi/v1/token/fs";
}

export function cleanCredential(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

export function requireCredential(value, envName, label) {
  const resolved = cleanCredential(value || process.env[envName] || "");
  if (!resolved) {
    throw new Error(`请填写 ${label}，或设置环境变量 ${envName}`);
  }
  return resolved;
}

// 只做规整（补协议、去尾斜杠），不改写域名
export function migrateApiHost(raw) {
  let host = String(raw || "").trim().replace(/\/+$/, "");
  if (!host) return host;
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  return host;
}

export function parseServer(input) {
  let raw = String(input || DEFAULT_HOST).trim();
  let protocol = "http";
  if (/^https:\/\//i.test(raw)) {
    protocol = "https";
    raw = raw.replace(/^https:\/\//i, "");
  } else if (/^http:\/\//i.test(raw)) {
    raw = raw.replace(/^http:\/\//i, "");
  }
  raw = raw.replace(/\/+$/, "");
  return { host: raw || DEFAULT_HOST, protocol };
}

function hostnameOf(serverHost) {
  const h = String(serverHost || "").split("/")[0];
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end).toLowerCase() : h.toLowerCase();
  }
  return h.split(":")[0].toLowerCase();
}

export function isBlockedApiHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "169.254.169.254" || h.startsWith("169.254.")) return true;
  if (h === "metadata.google.internal") return true;
  if (h === "0.0.0.0" || h === "::") return true;
  return false;
}

export function assertAllowedTokenHost(host) {
  const server = parseServer(host);
  if (isBlockedApiHost(hostnameOf(server.host))) {
    throw new Error("API host not allowed");
  }
  return server;
}

export function md5(value) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

export function hmacSha256(value, appSecret) {
  return crypto.createHmac("sha256", appSecret).update(value, "utf8").digest("hex");
}

export function webPhoneBodyDigest(body) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

export function webPhoneCanonicalRequest(method, path, body, timestamp, nonce) {
  return `${method.toUpperCase()}\n${path}\n${webPhoneBodyDigest(body)}\n${timestamp}\n${nonce}`;
}

export function createWebPhoneAuthentication(
  body,
  appKey,
  appSecret,
  now = Date.now(),
  path = webphoneTokenPath(),
) {
  const timestamp = String(now);
  const nonce = crypto.randomBytes(16).toString("hex");
  return {
    "X-Ca-Key": appKey,
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature": hmacSha256(
      webPhoneCanonicalRequest("POST", path, body, timestamp, nonce),
      appSecret,
    ),
    "X-Ca-Signature-Method": "HMAC-SHA256",
  };
}

export function openAPICanonical(treeMap) {
  return Object.keys(treeMap)
    .sort()
    .map((key) => treeMap[key])
    .join("");
}

export function pickSignMethod(host) {
  const override = String(process.env.CC_API_SIGN || "").trim().toLowerCase();
  if (override === "md5" || override === "hmac") return override;
  const hostname = hostnameOf(parseServer(host).host);
  if (hostname === "x.16x.tech" || hostname.endsWith(".yundianlab.com")) return "md5";
  return "hmac";
}

export function createAuthentication(content, appKey, appSecret, now = Date.now(), method = "hmac") {
  if (!appKey) {
    throw new Error("请填写 API KEY，或设置环境变量 CC_API_APP_KEY");
  }
  if (!appSecret) {
    throw new Error("请填写 API SECRET，或设置环境变量 CC_API_APP_SECRET");
  }
  const timestamp = String(now);
  const nonce = crypto.randomBytes(8).toString("hex");
  const contentDigest = md5(content);
  const canonical = openAPICanonical({
    appKey,
    content: contentDigest,
    nonce,
    timestamp,
  });
  const signature =
    method === "md5" ? md5(canonical + appSecret) : hmacSha256(canonical, appSecret);
  return {
    "X-Ca-Key": appKey,
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature": signature,
  };
}

export function formatTokenError(apiUrl, httpStatus, result) {
  const message = String(result?.message || "").trim();
  if (message) return message;
  if (result?.error && typeof result.error === "string") return result.error.trim();
  try {
    const body = JSON.stringify(result);
    if (body && body !== "{}") return body;
  } catch {
    // Fall back to the HTTP status below when the response cannot be serialized.
  }
  return `HTTP ${httpStatus}`;
}

// fs token 缓存：参考实现（ccbar.js）是一次签入用同一张票、按有效期换新的，
// 不是每次调用都重新签。这里做同样的事，顺带减少平台的 token 请求量。
const fsTokenCache = new Map();

function expiresToMs(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 600_000;
  return raw > 86400 ? raw : raw * 1000;
}

/**
 * 取 fs token（带缓存）。三次调用（取会话、刷新会话、设置坐席状态）共用同一张票。
 */
export async function getFsToken({ extension, host, appKey, appSecret } = {}) {
  const key = `${host}|${extension}|${appKey}`;
  const cached = fsTokenCache.get(key);
  // 提前 2 分钟换新，避免贴着过期用
  if (cached && cached.expiresAt - Date.now() > 120_000) {
    return { code: 0, data: { token: cached.token, expires: cached.expires } };
  }
  const result = await getToken({ isPublic: true, extension, host, appKey, appSecret });
  const token = String(result?.data?.token || "");
  const expires = Number(result?.data?.expires) || 0;
  if (token) {
    fsTokenCache.set(key, { token, expires, expiresAt: Date.now() + expiresToMs(expires) });
  }
  return result;
}

export async function getToken({
  isPublic = true,
  extension,
  userId,
  departmentId,
  host,
  appKey,
  appSecret,
} = {}) {
  const resolvedKey = requireCredential(appKey, "CC_API_APP_KEY", "API KEY");
  const resolvedSecret = requireCredential(appSecret, "CC_API_APP_SECRET", "API SECRET");
  if (!cleanCredential(host)) {
    throw new Error("请填写 API 主机（接口网关地址）");
  }
  const resolvedHost = migrateApiHost(host);
  const server = assertAllowedTokenHost(resolvedHost);
  let apiPath;
  let body;
  if (isPublic) {
    if (!extension) {
      throw new Error("分机号 extension 不能为空");
    }
    apiPath = fsTokenPath();
    body = JSON.stringify({ extension: String(extension).trim() });
  } else {
    if (!userId || !departmentId) {
      throw new Error("userId 和 departmentId 均不能为空");
    }
    apiPath = `${fsTokenPath()}/third`;
    body = JSON.stringify({ userId, departmentId });
  }
  const apiUrl = `${server.protocol}://${server.host}${apiPath}`;
  const signMethod = pickSignMethod(resolvedHost);
  const authentication = createAuthentication(
    body,
    resolvedKey,
    resolvedSecret,
    Date.now(),
    signMethod,
  );
  console.log(`[ccbar-token] ${apiUrl} sign=${signMethod} keyLen=${resolvedKey.length}`);
  const timeoutMs = 20_000;
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        ...authentication,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || /aborted due to timeout/i.test(error.message))) {
      throw new Error(`获取 token 超时：连不上 ${apiUrl}（${timeoutMs / 1000} 秒）。请确认该地址可达`);
    }
    throw new Error(`获取 token 失败：无法请求 ${apiUrl}（${error?.message || "网络错误"}）`);
  }
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）：${responseText}`);
  }
  if (!response.ok || result.code !== 0) {
    throw new Error(`${formatTokenError(apiUrl, response.status, result)}（POST ${apiUrl}）`);
  }
  return result;
}

export async function getWebPhoneToken({
  extension,
  platform = "web",
  host,
  appKey,
  appSecret,
} = {}) {
  const resolvedKey = requireCredential(appKey, "CC_API_APP_KEY", "API KEY");
  const resolvedSecret = requireCredential(appSecret, "CC_API_APP_SECRET", "API SECRET");
  if (!cleanCredential(host)) throw new Error("请填写 API 主机（接口网关地址，不要填文档站）");
  const server = assertAllowedTokenHost(migrateApiHost(host));
  const resolvedExtension = cleanCredential(extension);
  if (!resolvedExtension) throw new Error("分机号 extension 不能为空");

  const apiPath = webphoneTokenPath();
  const body = JSON.stringify({
    subject: { type: "extension", extension: resolvedExtension },
    client: { id: "ccbar-vue-demo", platform },
  });
  const apiUrl = `${server.protocol}://${server.host}${apiPath}`;
  console.log(`[ccbar-webphone-token] POST ${apiUrl}`);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      // 签名里的 path 必须和实际请求路径一致（自定义 CC_WEBPHONE_TOKEN_PATH 时尤其重要）
      ...createWebPhoneAuthentication(body, resolvedKey, resolvedSecret, Date.now(), apiPath),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    const preview = responseText.trim().slice(0, 200);
    throw new Error(
      `Token 接口返回了非 JSON 响应（HTTP ${response.status}）：${preview}` +
        `。请求地址：POST ${apiUrl}` +
        `；请确认这是接口网关地址（不是文档站），且该环境已开通 /openapi/v1/webphone/tokens`,
    );
  }
  if (!response.ok || result.code !== "OK") {
    throw new Error(formatTokenError(apiUrl, response.status, result));
  }
  const data = result.data;
  if (!data || typeof data.accessToken !== "string" || !data.accessToken.trim()) {
    throw new Error("Token 接口没有返回 accessToken");
  }
  return { accessToken: data.accessToken, expiresAt: data.expiresAt, extension: resolvedExtension };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  getToken({
    isPublic: (process.env.CC_IS_PUBLIC || "1") !== "0",
    extension: process.env.CC_EXTENSION,
    userId: process.env.CC_USER_ID,
    departmentId: process.env.CC_DEPARTMENT_ID,
    host: process.env.CC_API_HOST,
    appKey: process.env.CC_API_APP_KEY,
    appSecret: process.env.CC_API_APP_SECRET,
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
