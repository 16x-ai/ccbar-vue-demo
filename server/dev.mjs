import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listen, server } from "./token-server.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 让 Token 代理解析等 node 侧配置也能从 .env 读（Vite 只负责 VITE_ 前缀的那些）
try {
  process.loadEnvFile?.(path.join(root, ".env"));
} catch {
  /* 没有 .env 就用现有环境变量 */
}
const viteBin = path.join(root, "node_modules/vite/bin/vite.js");

const noProxy = new Set(
  String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
for (const host of ["127.0.0.1", "localhost", "::1"]) noProxy.add(host);
process.env.NO_PROXY = [...noProxy].join(",");
process.env.no_proxy = process.env.NO_PROXY;

const { port, url } = await listen();
process.env.TOKEN_PROXY_ORIGIN = url;

const vite = spawn(process.execPath, [viteBin, "--configLoader", "runner"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

function shutdown(code = 0) {
  if (!vite.killed) vite.kill();
  if (server.listening) {
    server.close(() => process.exit(code));
    return;
  }
  process.exit(code);
}

vite.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`页面: http://127.0.0.1:5173  ·  Token 代理: ${url}  (端口 ${port})`);
