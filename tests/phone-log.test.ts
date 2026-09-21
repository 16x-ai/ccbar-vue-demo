import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentStatus,
  callStatus,
  connectionStatus,
  isTemporarySipFailure,
  sipEventDetail,
  stringifyLog,
} from "../src/lib/logs.ts";

test("日志文本与参考页 stringifyLog 一致，token 打码", () => {
  assert.equal(stringifyLog(null), "");
  assert.equal(stringifyLog("hello"), "hello");
  assert.equal(stringifyLog(new Error("boom")), "boom");
  assert.equal(stringifyLog({ a: 1 }), '{"a":1}');
  assert.equal(
    stringifyLog("wss://call-ng.innopaas.com/api/fs/sip-ws?token=SECRET&x=1"),
    "wss://call-ng.innopaas.com/api/fs/sip-ws?token=***&x=1",
  );
});

test("连接 / 通话 / 坐席三套状态文案齐备，class 沿用参考页词汇", () => {
  assert.deepEqual(connectionStatus.registered, { text: "已注册", tone: "reg" });
  assert.equal(connectionStatus.reconnecting.text, "重连中");
  assert.equal(connectionStatus.failed.text, "注册失败");
  assert.equal(callStatus.idle.text, "空闲");
  assert.equal(callStatus.dialing.text, "呼出中");
  assert.equal(callStatus.ringing.text, "振铃中");
  assert.equal(callStatus.active.text, "通话中");
  assert.equal(callStatus.held.text, "保持中");
  assert.equal(agentStatus.available.text, "在线");
  assert.equal(agentStatus.break.text, "休息");
  // 参考页 CSS 里存在的 serv class 就这几个
  for (const { tone } of Object.values(callStatus)) {
    assert.ok(["idle", "busy", "calling", "talking", "hold"].includes(tone), tone);
  }
});

test("只有暂时性失败（480 / 超时 / 网络）才值得重拨", () => {
  assert.equal(isTemporarySipFailure({ code: "CALL_REJECTED", status: 480 }), true);
  assert.equal(isTemporarySipFailure({ message: "Temporarily Unavailable" }), true);
  assert.equal(isTemporarySipFailure({ code: "NETWORK_TIMEOUT", retryable: true }), true);
  assert.equal(isTemporarySipFailure({ code: "CALL_BUSY" }), false);
  assert.equal(isTemporarySipFailure({ code: "MEDIA_PERMISSION_DENIED" }), false);
  assert.equal(isTemporarySipFailure(undefined), false);
});

test("事件详情只留排障字段，token 打码", () => {
  assert.equal(
    sipEventDetail({ callId: "c1", from: "ringing", to: "active", unrelated: "x" }),
    '{"callId":"c1","from":"ringing","to":"active"}',
  );
  assert.equal(
    sipEventDetail({ error: { code: "REGISTRATION_FAILED", retryable: true } }),
    '{"error.code":"REGISTRATION_FAILED","error.retryable":true}',
  );
  assert.equal(sipEventDetail({ unrelated: 1 }), "");
  assert.equal(sipEventDetail(undefined), "");
});
