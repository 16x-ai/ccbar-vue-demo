import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedTokenHost,
  getWebPhoneToken,
  formatTokenError,
  hmacSha256,
  webPhoneCanonicalRequest,
  isBlockedApiHost,
  migrateApiHost,
  toWebPhoneToken,
} from "../server/get-token.js";

test("SDK token requests use the webphone signing contract", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(
      JSON.stringify({
        code: "OK",
        data: { accessToken: "short-lived", expiresAt: 2000000000 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const token = await getWebPhoneToken({
      extension: "1000",
      platform: "web",
      host: "https://api.example.test",
      appKey: "demo-key",
      appSecret: "demo-secret",
    });
    assert.deepEqual(token, {
      accessToken: "short-lived",
      expiresAt: 2000000000,
      extension: "1000",
    });
    assert.equal(request.input, "https://api.example.test/openapi/v1/webphone/tokens");
    assert.equal(request.init.method, "POST");
    const body = String(request.init.body);
    assert.deepEqual(JSON.parse(body), {
      subject: { type: "extension", extension: "1000" },
      client: { id: "ccbar-vue-demo", platform: "web" },
    });
    const headers = request.init.headers;
    assert.equal(headers["X-Ca-Signature-Method"], "HMAC-SHA256");
    assert.equal(
      headers["X-Ca-Signature"],
      hmacSha256(
        webPhoneCanonicalRequest(
          "POST",
          "/openapi/v1/webphone/tokens",
          body,
          headers["X-Ca-Timestamp"],
          headers["X-Ca-Nonce"],
        ),
        "demo-secret",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

test("callapi-ng 会改写成 call-ng", () => {
  assert.equal(
    migrateApiHost("https://callapi-ng.innopaas.com"),
    "https://call-ng.innopaas.com",
  );
  assert.equal(
    migrateApiHost("https://call-ng.innopaas.com"),
    "https://call-ng.innopaas.com",
  );
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

test("把旧 token/fs 响应映射成 SDK 的 accessToken", () => {
  assert.equal(
    toWebPhoneToken({
      code: 0,
      data: { token: "fs-token", expires: 2000000000, extension: "1000" },
    }).accessToken,
    "fs-token",
  );
  assert.equal(
    toWebPhoneToken({
      code: 0,
      data: { token: "fs-token", expires: 2000000000, extension: "1000" },
    }).expiresAt,
    2000000000,
  );
  assert.throws(() => toWebPhoneToken({ code: 0, data: {} }), /token/);
});
