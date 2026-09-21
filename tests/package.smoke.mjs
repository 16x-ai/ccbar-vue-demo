import { test } from "node:test";
import assert from "node:assert/strict";

test("发布包支持 Node/SSR 导入根入口和诊断子入口", async () => {
  const core = await import("@16x/webphone-sdk");
  const diagnostics = await import("@16x/webphone-sdk/diagnostics");
  assert.equal(typeof core.CCBarClient, "function");
  assert.equal(typeof diagnostics.redactValue, "function");
  assert.equal(typeof globalThis.window, "undefined");
});

test("Legacy setBu 明确抛出弃用错误；signOut 可清理未连接实例", async () => {
  const { CCBarSDK, DeprecatedError } =
    await import("@16x/webphone-sdk/legacy");
  const legacy = new CCBarSDK({
    platform: "web",
    tokenProvider: async () => {
      throw new Error("本测试不得获取 Token");
    },
  });
  assert.throws(() => legacy.setBu(), DeprecatedError);
  await legacy.signOut();
});
