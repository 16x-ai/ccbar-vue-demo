import { test } from "node:test";
import assert from "node:assert/strict";

test("发布包支持 Node/SSR 导入根入口和诊断子入口", async () => {
  const core = await import("@16x/webphone-sdk");
  const diagnostics = await import("@16x/webphone-sdk/diagnostics");
  assert.equal(typeof core.CCBarClient, "function");
  assert.equal(typeof diagnostics.redactValue, "function");
  assert.equal(typeof globalThis.window, "undefined");
});

test("取票链路需要的子入口可用：@16x/webphone-sdk/legacy 提供会话来源与解密", async () => {
  const legacy = await import("@16x/webphone-sdk/legacy");
  assert.equal(typeof legacy.createLegacySessionProvider, "function");
  assert.equal(typeof legacy.decryptSipPassword, "function");
});
