import { test } from "node:test";
import assert from "node:assert/strict";
import { isTemporarySipFailure, validateApiHost, validateSipWs } from "../src/lib/helpers.ts";

test("暂时性呼叫失败（Unavailable / 408 / 480）才值得重拨", () => {
  // JsSIP 把 408/410/430/480 都报成 Unavailable
  assert.equal(isTemporarySipFailure("Unavailable"), true);
  assert.equal(isTemporarySipFailure("Request Timeout"), true);
  assert.equal(isTemporarySipFailure("480"), true);
  assert.equal(isTemporarySipFailure("408"), true);
  assert.equal(isTemporarySipFailure("Busy"), false);
  assert.equal(isTemporarySipFailure("Rejected"), false);
  assert.equal(isTemporarySipFailure(undefined), false);
  assert.equal(isTemporarySipFailure(""), false);
});

test("API 主机和软电话 WSS 校验与旧坐席条一致", () => {
  assert.equal(
    validateApiHost("https://call-ng.innopaas.com/"),
    "https://call-ng.innopaas.com",
  );
  assert.equal(
    validateApiHost("https://callapi-ng.innopaas.com"),
    "https://call-ng.innopaas.com",
  );
  assert.throws(() => validateApiHost("call-ng.innopaas.com"), /API 主机/);
  assert.equal(
    validateSipWs("wss://call-ng.innopaas.com/api/fs/sip-ws"),
    "wss://call-ng.innopaas.com/api/fs/sip-ws",
  );
  assert.throws(() => validateSipWs("call-ng.innopaas.com"), /软电话/);
});
