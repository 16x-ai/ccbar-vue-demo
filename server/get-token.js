import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = process.env.CC_API_HOST || "https://x.16x.tech";

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

export function migrateApiHost(raw) {
  let host = String(raw || "").trim().replace(/\/+$/, "");
  if (!host) return host;
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  if (/^https?:\/\/callapi-ng\.innopaas\.com$/i.test(host)) {
    return "https://call-ng.innopaas.com";
  }
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

export function createWebPhoneAuthentication(body, appKey, appSecret, now = Date.now()) {
  const timestamp = String(now);
  const nonce = crypto.randomBytes(16).toString("hex");
  return {
    "X-Ca-Key": appKey,
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature": hmacSha256(
      webPhoneCanonicalRequest(
        "POST",
        "/openapi/v1/webphone/tokens",
        body,
        timestamp,
        nonce,
      ),
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

export function toWebPhoneToken(result) {
  const data = result?.data;
  if (!data || typeof data !== "object") {
    throw new Error("获取 token 失败：响应没有 data");
  }
  const accessToken = String(data.token || data.accessToken || "").trim();
  if (!accessToken) {
    throw new Error("获取 token 失败：响应没有 token");
  }
  const raw = data.expiresAt ?? data.expires;
  let expiresAt;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) expiresAt = Math.floor(raw / 1000);
    else if (raw > 1e9) expiresAt = Math.floor(raw);
    else expiresAt = Math.floor(Date.now() / 1000) + Math.floor(raw);
  }
  return {
    accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(data.extension ? { extension: data.extension } : {}),
  };
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
    throw new Error("请填写 API 主机，必须与 D:\\code\\xcall\\ccbar 设置里的 API 主机一致");
  }
  const resolvedHost = migrateApiHost(host);
  const server = assertAllowedTokenHost(resolvedHost);
  let apiPath;
  let body;
  if (isPublic) {
    if (!extension) {
      throw new Error("分机号 extension 不能为空");
    }
    apiPath = "/openapi/v1/token/fs";
    body = JSON.stringify({ extension: String(extension).trim() });
  } else {
    if (!userId || !departmentId) {
      throw new Error("userId 和 departmentId 均不能为空");
    }
    apiPath = "/openapi/v1/token/fs/third";
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
    throw new Error(formatTokenError(apiUrl, response.status, result));
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
  if (!cleanCredential(host)) throw new Error("璇峰～鍐?API 涓绘満");
  const server = assertAllowedTokenHost(migrateApiHost(host));
  const resolvedExtension = cleanCredential(extension);
  if (!resolvedExtension) throw new Error("鍒嗘満鍙?extension 涓嶈兘涓虹┖");

  const apiPath = "/openapi/v1/webphone/tokens";
  const body = JSON.stringify({
    subject: { type: "extension", extension: resolvedExtension },
    client: { id: "ccbar-vue-demo", platform },
  });
  const apiUrl = `${server.protocol}://${server.host}${apiPath}`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      ...createWebPhoneAuthentication(body, resolvedKey, resolvedSecret),
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
    throw new Error(`Token 鎺ュ彛杩斿洖浜嗛潪 JSON 鍝嶅簲锛圚TTP ${response.status}锛夛細${responseText}`);
  }
  if (!response.ok || result.code !== "OK") {
    throw new Error(formatTokenError(apiUrl, response.status, result));
  }
  const data = result.data;
  if (!data || typeof data.accessToken !== "string" || !data.accessToken.trim()) {
    throw new Error("Token 鎺ュ彛娌℃湁杩斿洖 accessToken");
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
