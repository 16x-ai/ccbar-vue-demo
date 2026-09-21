import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";

function tokenProxyPlugin(tokenOrigin: string): Plugin {
  const prefixes = ["/api/webphone-token", "/api/xcall/webphone-token", "/ccbar/", "/get-token"];
  return {
    name: "ccbar-token-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        if (!prefixes.some((prefix) => url === prefix || url.startsWith(prefix))) {
          next();
          return;
        }
        const target = new URL(url, tokenOrigin);
        const headers = { ...req.headers, host: target.host };
        delete headers.connection;
        const proxyReq = http.request(
          target,
          { method: req.method, headers },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (error) => {
          console.error(`[token-proxy] ${tokenOrigin} ${error.message}`);
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              code: -1,
              message: `页面 5173 连不上 Token 代理 ${tokenOrigin}：${error.message}`,
            }),
          );
        });
        req.pipe(proxyReq);
      });
    },
  };
}

function legacyCcbarAssetsPlugin(legacyRoot: string): Plugin {
  const assets = new Map([
    ["/legacy/ccbar.js", "ccbar.js"],
    ["/legacy/crypto.js", "crypto.js"],
    ["/legacy/message.js", "message.js"],
    ["/legacy/jssip.js", "jssip-3.4.4.js"],
  ]);
  return {
    name: "ccbar-legacy-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const filename = assets.get((req.url || "").split("?")[0]);
        if (!filename) {
          next();
          return;
        }
        const file = path.join(legacyRoot, filename);
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.end(fs.readFileSync(file));
      });
    },
  };
}

const sdkRoot = fileURLToPath(new URL("../ccbar-web-sdk", import.meta.url));
const sdkSrc = path.join(sdkRoot, "src");
const legacyRoot = fileURLToPath(new URL("../xcall/ccbar", import.meta.url));

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.WEBPHONE_PROXY_TARGET;
  const tokenOrigin =
    process.env.TOKEN_PROXY_ORIGIN || "http://127.0.0.1:3000";
  return {
    define: {
      __CCBAR_DEV__: mode !== "production",
    },
    resolve: {
      alias: [
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
      ],
    },
    optimizeDeps: {
      exclude: ["@16x/webphone-sdk"],
    },
    plugins: [
      legacyCcbarAssetsPlugin(legacyRoot),
      tokenProxyPlugin(tokenOrigin),
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
      ...(target
        ? {
            proxy: {
              "/openapi": { target, changeOrigin: true, ws: true },
            },
          }
        : {}),
    },
  };
});
