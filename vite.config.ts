import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";

// 逐跳（hop-by-hop）头：h1 里可以转发，h2 里是禁止的
const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

/**
 * 把一份 Node 头对象整理成可以在 h1 / h2 之间搬运的样子：剔除伪头与逐跳头。
 *
 * HTTPS 模式才暴露（H5 那边踩到的）：Vite 的 HTTPS dev server 是
 * `http2.createSecureServer`（带 allowHTTP1），浏览器一上 https 就走 h2，
 *   1. 请求方向：h2 的 `req.headers` 带 `:method` / `:path` 等伪头，透传给 http.request() 会
 *      抛 `Header name must be a valid HTTP token [":method"]` → 接口 500；
 *   2. 响应方向：h1 响应里的 `keep-alive` 写回 h2 响应会抛 `ERR_HTTP2_INVALID_CONNECTION_HEADERS`
 *      —— 未捕获异常，直接把 Vite 进程带崩。
 */
function forwardHeaders(source: Record<string, string | string[] | undefined>) {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (name.startsWith(":") || DROP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

/** 一条代理规则：`prefix` 命中后转发到 `target`；`stripPrefix` 用于去掉前缀（server2 的路由不带前缀） */
type ProxyRoute = { prefix: string; target: string; stripPrefix?: string };

function refTokenProxyPlugin(refOrigin: string): Plugin {
  // /ref/：取票口 —— 转发到 server2（xcall 参考实现那套服务）并把 /ref 去掉，server2 自己认 /get-token
  const routes: ProxyRoute[] = [{ prefix: "/ref/", target: refOrigin, stripPrefix: "/ref" }];

  return {
    name: "ccbar-ref-token-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        const route = routes.find((item) => url === item.prefix || url.startsWith(item.prefix));
        if (route === undefined) {
          next();
          return;
        }
        const forwardedUrl = route.stripPrefix ? url.replace(route.stripPrefix, "") : url;
        const target = new URL(forwardedUrl, route.target);
        const headers = forwardHeaders(req.headers);
        headers.host = target.host;
        const proxyReq = http.request(
          target,
          { method: req.method, headers },
          (proxyRes) => {
            // 响应方向同样要过滤：h1 的 keep-alive / connection 写进 h2 响应会直接抛异常
            res.writeHead(proxyRes.statusCode || 500, forwardHeaders(proxyRes.headers));
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (error) => {
          console.error(`[ref-token-proxy] ${refOrigin} ${error.message}`);
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              code: -1,
              message: `页面 5173 连不上取票服务 ${refOrigin}：${error.message}`,
            }),
          );
        });
        req.pipe(proxyReq);
      });
    },
  };
}

const sdkRoot = fileURLToPath(new URL("../ccbar-web-sdk", import.meta.url));
const sdkSrc = path.join(sdkRoot, "src");
// 本地有 SDK 源码时优先用源码（方便调 SDK），没有就用 npm 上的 @16x/webphone-sdk —— 客户机器上只有后者。
// 想强制走 npm 包（例如验证客户那台机器的行为）：CCBAR_LOCAL_SDK=0 npm run build
const useLocalSdk = process.env.CCBAR_LOCAL_SDK !== "0" && fs.existsSync(sdkSrc);

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 取票口（server2）：npm run dev 时由 dev.mjs 注入实际地址（端口冲突会自动 +1）；
  // 单独跑 `npm run dev:vite` 时按默认端口找它
  const refOrigin =
    process.env.REF_TOKEN_PROXY_ORIGIN || "http://127.0.0.1:3100";
  return {
    define: {
      __CCBAR_DEV__: mode !== "production",
    },
    resolve: {
      alias: [
        ...(useLocalSdk
          ? [
              {
                find: "@16x/webphone-sdk/styles.css",
                replacement: path.join(sdkSrc, "ui/styles/index.css"),
              },
              {
                find: "@16x/webphone-sdk/shared-worker",
                replacement: path.join(sdkSrc, "shared-worker.ts"),
              },
              {
                find: "@16x/webphone-sdk/diagnostics",
                replacement: path.join(sdkSrc, "diagnostics/index.ts"),
              },
              {
                find: "@16x/webphone-sdk/legacy",
                replacement: path.join(sdkSrc, "legacy/index.ts"),
              },
              {
                find: "@16x/webphone-sdk/ui",
                replacement: path.join(sdkSrc, "ui/index.ts"),
              },
              {
                find: "@16x/webphone-sdk",
                replacement: path.join(sdkSrc, "index.ts"),
              },
            ]
          : []),
      ],
    },
    optimizeDeps: {
      // 只有走本地源码时才需要排除预打包；用 npm 包时要让 Vite 正常预打包
      ...(useLocalSdk ? { exclude: ["@16x/webphone-sdk"] } : {}),
    },
    plugins: [
      refTokenProxyPlugin(refOrigin),
      vue({
        template: {
          compilerOptions: { isCustomElement: (tag) => tag === "xcall-ccbar" },
        },
      }),
    ],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      fs: {
        allow: [searchForWorkspaceRoot(process.cwd()), sdkRoot],
      },
    },
  };
});
