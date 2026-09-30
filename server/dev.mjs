import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 让取票服务等 node 侧配置也能从 .env 读（Vite 只负责 VITE_ 前缀的那些）
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

// 取票服务：server/index.js 是本仓库的示例实现（独立端口），页面只对它换一次票。
// 两处顺序有讲究：
//   1) CCBAR_DEMO=1 必须在 import 之前设 —— 服务在模块加载时就读它，否则 /get-token 一律 403
//   2) import 必须在 loadEnvFile 之后 —— 服务也从环境变量读兜底配置
process.env.CCBAR_DEMO = "1";
const ref = await import(pathToFileURL(path.join(root, "server/index.js")).href);
const refTokenServer = await ref.startServer(
  ref.server,
  ref.BIND,
  Number(process.env.REF_TOKEN_PORT) || 3100,
  { fallback: true }, // 端口被占用时自动往后找
);
process.env.REF_TOKEN_PROXY_ORIGIN = refTokenServer.url;

const vite = spawn(process.execPath, [viteBin, "--configLoader", "runner"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

function shutdown(code = 0) {
  if (!vite.killed) vite.kill();
  if (!ref.server.listening) {
    process.exit(code);
    return;
  }
  ref.server.close(() => process.exit(code));
}

vite.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`页面: http://127.0.0.1:5173  ·  取票口: ${refTokenServer.url}  (端口 ${refTokenServer.port})`);
