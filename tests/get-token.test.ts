import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedTokenHost,
  getFsToken,
  formatTokenError,
  hmacSha256,
  isBlockedApiHost,
  migrateApiHost,

} from "../server/get-token.js";


test("blocks metadata and unspecified hosts", () => {
  assert.equal(isBlockedApiHost("169.254.169.254"), true);
  assert.equal(isBlockedApiHost("169.254.1.1"), true);
  assert.equal(isBlockedApiHost("metadata.google.internal"), true);
  assert.equal(isBlockedApiHost("0.0.0.0"), true);
  assert.equal(isBlockedApiHost("x.16x.tech"), false);
  assert.equal(isBlockedApiHost("127.0.0.1"), false);
});

test("assertAllowedTokenHost rejects metadata URLs", () => {
  assert.throws(() => assertAllowedTokenHost("http://169.254.169.254"), /not allowed/);
  assert.doesNotThrow(() => assertAllowedTokenHost("https://x.16x.tech"));
});

test("API 主机只做规整，不改写域名", () => {
  assert.equal(
    migrateApiHost("https://callapi-ng.innopaas.com"),
    "https://callapi-ng.innopaas.com",
  );
  assert.equal(migrateApiHost("https://customer-gateway.example.com/"), "https://customer-gateway.example.com");
  assert.equal(migrateApiHost("customer-gateway.example.com"), "https://customer-gateway.example.com");
  assert.equal(migrateApiHost(""), "");
});

test("透传后端 token 错误信息", () => {
  assert.equal(
    formatTokenError("https://call-ng.innopaas.com/openapi/v1/token/fs", 200, {
      message: "Invalid secret key",
      traceID: "abc",
    }),
    "Invalid secret key",
  );
});



test("fs token 缓存只活 2 分钟：不能拿 18 小时前的旧票去换坐席账号", async (t) => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (async () => {
    tokenCalls += 1;
    return new Response(
      JSON.stringify({ code: 0, data: { token: `t${tokenCalls}`, expires: 64800 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const params = { extension: "8001", host: "https://api.example.test", appKey: "k", appSecret: "s" };
  try {
    t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
    // 同一时刻连着两次 → 命中缓存，只取一次票
    assert.equal((await getFsToken(params)).data.token, "t1");
    assert.equal((await getFsToken(params)).data.token, "t1");
    assert.equal(tokenCalls, 1);

    // 过了缓存寿命（2 分钟）→ 重新取票；否则 18 小时的票会把过期密码一直带下去
    t.mock.timers.tick(3 * 60_000);
    assert.equal((await getFsToken(params)).data.token, "t2");
    assert.equal(tokenCalls, 2);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});
