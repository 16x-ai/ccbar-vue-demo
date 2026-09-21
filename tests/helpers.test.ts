import { test } from "node:test";
import assert from "node:assert/strict";
import { prefixExtension, shortExtension, validateApiHost, validateSipWs } from "../src/lib/helpers.ts";

test("API 主机必须由用户填写（留空时报错，不替你猜环境）", () => {
  assert.throws(() => validateApiHost(""), /API 主机/);
  assert.throws(() => validateApiHost("   "), /API 主机/);
});

test("API 主机和软电话 WSS 校验与旧坐席条一致", () => {
  assert.equal(
    validateApiHost("https://call-ng.innopaas.com/"),
    "https://call-ng.innopaas.com",
  );
  // 不做域名改写：填什么就是什么（每个客户/环境不同，页面不替使用方换）
  assert.equal(
    validateApiHost("https://callapi-ng.innopaas.com"),
    "https://callapi-ng.innopaas.com",
  );
  assert.equal(
    validateApiHost("https://customer-gateway.example.com/"),
    "https://customer-gateway.example.com",
  );
  assert.throws(() => validateApiHost("call-ng.innopaas.com"), /API 主机/);
  assert.equal(
    validateSipWs("wss://call-ng.innopaas.com/api/fs/sip-ws"),
    "wss://call-ng.innopaas.com/api/fs/sip-ws",
  );
  assert.throws(() => validateSipWs("call-ng.innopaas.com"), /软电话/);
});

test("软电话 WSS 是必填项，且必须是 ws/wss 地址", () => {
  assert.throws(() => validateSipWs(""), /请填写软电话 WSS/);
  assert.throws(() => validateSipWs("   "), /请填写软电话 WSS/);
  assert.throws(() => validateSipWs("sip.example.test"), /软电话 WSS/);
  assert.equal(
    validateSipWs("  wss://sip.example.test/api/fs/sip-ws  "),
    "wss://sip.example.test/api/fs/sip-ws",
  );
});

test("内呼把企业前缀拼在号码前（与参考实现 insideCall 一致）", () => {
  assert.equal(prefixExtension("1002", "p"), "p1002");
  // 已经带前缀的不重复拼
  assert.equal(prefixExtension("p1002", "p"), "p1002");
  // 没配前缀就原样拨
  assert.equal(prefixExtension("1002", ""), "1002");
  assert.equal(prefixExtension(" 1002 ", " p "), "p1002");
  assert.equal(prefixExtension("", "p"), "");
});

test("显示分机去掉 customerPrefix（与参考页 shortExtension 一致）", () => {
  assert.equal(shortExtension("p8001", "p"), "8001");
  assert.equal(shortExtension("8001", "p"), "8001");
  assert.equal(shortExtension("p8001", ""), "p8001");
  // 只有前缀本身就是整个账号时才不切，避免显示空
  assert.equal(shortExtension("p", "p"), "p");
  assert.equal(shortExtension("", "p"), "");
});
