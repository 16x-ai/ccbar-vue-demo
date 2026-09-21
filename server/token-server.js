import http from "node:http";
import { pathToFileURL } from "node:url";
import { getToken, getWebPhoneToken, toWebPhoneToken } from "./get-token.js";

const BIND = process.env.CCBAR_BIND || "127.0.0.1";
const MAX_BODY = 64 * 1024;
let listenPort = Number(process.env.TOKEN_PORT || process.env.PORT) || 3000;

const TOKEN_PATHS = new Set([
  "/api/webphone-token",
  "/api/xcall/webphone-token",
  "/get-token",
  "/ccbar/get-token",
  "/demo/get-token",
]);

function corsHeaders(req) {
  const origin = req?.headers?.origin || "";
  return {
    "Access-Control-Allow-Origin": origin || `http://127.0.0.1:${listenPort}`,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    Vary: "Origin",
  };
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(req),
  });
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

export const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "GET" && urlPath === "/health") {
    sendJson(req, res, 200, { ok: true, port: listenPort });
    return;
  }

  if (req.method === "POST" && TOKEN_PATHS.has(urlPath)) {
    try {
      const body = await readBody(req, MAX_BODY);
      const isPublic = body.isPublic !== false;
      if (!String(body.host || "").trim()) {
        throw new Error("请填写 API 主机");
      }
      if (!String(body.appKey || "").trim() || !String(body.appSecret || "").trim()) {
        throw new Error("请填写 API KEY 和 API SECRET");
      }
      const params = {
        isPublic,
        host: body.host,
        appKey: body.appKey,
        appSecret: body.appSecret,
      };
      if (isPublic) params.extension = body.extension;
      else {
        params.userId = body.userId;
        params.departmentId = body.departmentId;
      }
      if (urlPath === "/api/xcall/webphone-token") {
        sendJson(req, res, 200, await getWebPhoneToken({
          extension: body.extension,
          platform: body.platform,
          host: body.host,
          appKey: body.appKey,
          appSecret: body.appSecret,
        }));
        return;
      }
      const result = await getToken(params);
      if (urlPath === "/api/webphone-token") {
        sendJson(req, res, 200, toWebPhoneToken(result));
        return;
      }
      sendJson(req, res, 200, result);
    } catch (error) {
      sendJson(req, res, 500, { code: -1, message: error.message });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

export function preferredPort(startPort) {
  const n = Number(startPort);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const fromEnv = Number(process.env.TOKEN_PORT || process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 3000;
}

export function startServer(httpServer, bind, port, { fallback = true } = {}) {
  const preferred = preferredPort(port);
  const last = fallback ? preferred + 19 : preferred;
  return new Promise((resolve, reject) => {
    let current = preferred;
    const attempt = () => {
      const onError = (err) => {
        httpServer.off("listening", onListening);
        if (err?.code === "EADDRINUSE" && current < last) {
          console.warn(`端口 ${current} 已被占用，改用 ${current + 1}`);
          current += 1;
          attempt();
          return;
        }
        if (err?.code === "EADDRINUSE") {
          reject(
            new Error(
              `端口 ${preferred} 已被占用。请关掉占用该端口的进程，或执行 TOKEN_PORT=${preferred + 1} npm run dev`,
            ),
          );
          return;
        }
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        listenPort = current;
        console.log(`Token 代理已启动: http://${bind}:${current}`);
        resolve({ port: current, url: `http://${bind}:${current}` });
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(current, bind);
    };
    attempt();
  });
}

export function listen(startPort) {
  const preferred = preferredPort(startPort);
  const pinned =
    startPort == null && String(process.env.TOKEN_PORT || process.env.PORT || "").trim() !== "";
  return startServer(server, BIND, preferred, { fallback: !pinned });
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  listen().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
