/**
 * 示例取票服务：把页面递过来的分机号换成一张 fs token（`POST /get-token`）。
 *
 * 页面只调这一个接口；拿到的票交给 SDK，后面「取坐席账号 → 解 SIP 密码 → 组装会话」都由 SDK 完成。
 * 加签用的 API SECRET 只在这个进程里，不下发到浏览器。
 *
 * 单独跑：CCBAR_DEMO=1 node server/index.js        （默认 http://127.0.0.1:3000）
 * 跟页面一起跑：npm run dev                        （由 server/dev.mjs 起在 3100，端口占用时自动往后找）
 *
 * 换成你们自己的后端时，照这个文件实现同一个请求/返回契约即可（见 docs/前端接入文档.md）。
 */
import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const BIND = process.env.CCBAR_BIND || "127.0.0.1";
/** 不设 CCBAR_DEMO=1 就拒绝服务：这个示例服务不该直接放到公网 */
const DEMO = process.env.CCBAR_DEMO === "1";
const MAX_BODY = 64 * 1024;
const DEFAULT_HOST = process.env.CC_API_HOST || "https://x.16x.tech";
const TOKEN_PATH = "/openapi/v1/token/fs";
let listenPort = Number(process.env.PORT) || 3000;

// ---------- 平台接口的加签（X-Ca-*）----------

function requireCredential(value, envName, label) {
  const resolved = String(value || process.env[envName] || "").trim();
  if (!resolved) throw new Error(`请填写 ${label}，或设置环境变量 ${envName}`);
  return resolved;
}

function parseServer(input) {
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

/** 只放行 http(s) 主机，挡掉回环、云元数据这类明显不该打的地址 */
function isBlockedApiHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "169.254.169.254" || h.startsWith("169.254.")) return true;
  if (h === "metadata.google.internal") return true;
  if (h === "0.0.0.0" || h === "::") return true;
  return false;
}

function assertAllowedTokenHost(host) {
  const server = parseServer(host);
  if (isBlockedApiHost(hostnameOf(server.host))) throw new Error("API host not allowed");
  return server;
}

function createAuthentication(content, appKey, appSecret, now = Date.now()) {
  if (!appKey) throw new Error("请填写 API KEY，或设置环境变量 CC_API_APP_KEY");
  if (!appSecret) throw new Error("请填写 API SECRET，或设置环境变量 CC_API_APP_SECRET");

  // 平台契约：content = MD5(请求体原文)，四个值按 key 升序仅拼值，再 HMAC-SHA256 取十六进制小写
  const timestamp = String(now);
  const nonce = crypto.randomBytes(8).toString("hex");
  const contentDigest = crypto.createHash("md5").update(content, "utf8").digest("hex");
  const signature = crypto
    .createHmac("sha256", appSecret)
    .update(`${appKey}${contentDigest}${nonce}${timestamp}`, "utf8")
    .digest("hex");

  return {
    "X-Ca-Key": appKey,
    "X-Ca-Timestamp": timestamp,
    "X-Ca-Nonce": nonce,
    "X-Ca-Signature": signature,
  };
}

/** 打平台接口换一张 fs token，把平台的响应原样回给调用方 */
async function getToken({ extension, host, appKey, appSecret } = {}) {
  const resolvedKey = requireCredential(appKey, "CC_API_APP_KEY", "API KEY");
  const resolvedSecret = requireCredential(appSecret, "CC_API_APP_SECRET", "API SECRET");
  const server = assertAllowedTokenHost(host);

  if (!extension) throw new Error("分机号 extension 不能为空");
  const body = JSON.stringify({ extension: String(extension).trim() });
  const API_URL = `${server.protocol}://${server.host}${TOKEN_PATH}`;

  const timeoutMs = 20_000;
  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { ...createAuthentication(body, resolvedKey, resolvedSecret), "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === "TimeoutError" || /aborted due to timeout/i.test(error.message))) {
      throw new Error(`获取 token 超时：连不上 ${API_URL}（${timeoutMs / 1000} 秒）。请确认该地址可达`);
    }
    throw new Error(`获取 token 失败：无法请求 ${API_URL}（${(error && error.message) || "网络错误"}）`);
  }

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）：${responseText}`);
  }
  if (!response.ok || result.code !== 0) {
    const traceId = result.traceID ? `，traceID：${result.traceID}` : "";
    throw new Error(`获取 token 失败（HTTP ${response.status}）：${result.message || responseText}${traceId}`);
  }
  return result;
}

// ---------- HTTP ----------

function corsHeaders(req) {
  const origin = (req && req.headers && req.headers.origin) || "";
  // 同源（nginx 反代）场景不依赖 CORS；file:// 或跨源本地调试时回显 Origin
  return {
    "Access-Control-Allow-Origin": origin || `http://127.0.0.1:${listenPort}`,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) });
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// 只做一件事：POST /get-token —— 页面请求体里的分机号优先，环境变量仅兜底
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "POST" && urlPath === "/get-token") {
    if (!DEMO) {
      sendJson(req, res, 403, { code: -1, message: "get-token disabled; set CCBAR_DEMO=1 for local demo" });
      return;
    }
    try {
      const body = await readBody(req, MAX_BODY);
      const result = await getToken({
        extension: body.extension,
        host: body.host || process.env.CC_API_HOST,
        appKey: body.appKey || process.env.CC_API_APP_KEY,
        appSecret: body.appSecret || process.env.CC_API_APP_SECRET,
      });
      sendJson(req, res, 200, result);
    } catch (error) {
      sendJson(req, res, 500, { code: -1, message: error.message });
    }
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

function preferredPort(startPort) {
  const n = Number(startPort);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const fromEnv = Number(process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 3000;
}

/** 起服务；端口被占用时（fallback）自动往后找，最多试 20 个 */
function startServer(httpServer, bind, port, { fallback = true } = {}) {
  const preferred = preferredPort(port);
  const last = fallback ? preferred + 19 : preferred;
  return new Promise((resolve, reject) => {
    let current = preferred;
    const attempt = () => {
      const onError = (err) => {
        httpServer.off("listening", onListening);
        if (err && err.code === "EADDRINUSE" && current < last) {
          console.warn(`端口 ${current} 已被占用，改用 ${current + 1}`);
          current += 1;
          attempt();
          return;
        }
        if (err && err.code === "EADDRINUSE") {
          reject(new Error(`端口 ${preferred} 已被占用。请关掉占用该端口的进程，或执行 PORT=${preferred + 1} npm run dev`));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        listenPort = current;
        console.log(`本地服务已启动: http://${bind}:${current}`);
        resolve({ port: current, url: `http://${bind}:${current}` });
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(current, bind);
    };
    attempt();
  });
}

function listen(startPort) {
  const pinned = startPort == null && String(process.env.PORT || "").trim() !== "";
  startServer(server, BIND, preferredPort(startPort), { fallback: !pinned }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
  return server;
}

// 直接 `node server/index.js` 时起服务；被 dev.mjs import 时由它来起
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) listen();

export { BIND, DEMO, createAuthentication, getToken, listen, preferredPort, server, startServer };
