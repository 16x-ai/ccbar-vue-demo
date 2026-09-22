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

test("首通保护认得 CCBarError 的真实形状：480 藏在 cause 里，message 只有错误码", () => {
  // 形状来自 SDK：CCBarError 的 message 就是 code，真正的原因在 cause 上
  const remote480 = Object.assign(new Error("CALL_OPERATION_NOT_ALLOWED"), {
    code: "CALL_OPERATION_NOT_ALLOWED",
    retryable: false,
    cause: {
      originator: "remote",
      message: {
        status_code: 480,
        reason_phrase: "Temporarily Unavailable",
        data: 'SIP/2.0 480 Temporarily Unavailable\r\nReason: Q.850;cause=16;text="NORMAL_CLEARING"\r\n',
      },
      cause: "Unavailable",
    },
  });
  assert.equal(isTemporarySipFailure(remote480), true, "只传给 SDK 的 error 对象也应该认出来");

  // 真失败不能被误判成暂时性失败，否则会对错误号码反复重拨
  const remote403 = Object.assign(new Error("CALL_OPERATION_NOT_ALLOWED"), {
    cause: {
      originator: "remote",
      message: { status_code: 403, reason_phrase: "Forbidden", data: "SIP/2.0 403 Forbidden" },
      cause: "Rejected",
    },
  });
  assert.equal(isTemporarySipFailure(remote403), false);
  assert.equal(
    isTemporarySipFailure({ originator: "remote", message: { status_code: 486, reason_phrase: "Busy Here" }, cause: "Busy" }),
    false,
  );
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

test("JsSIP 的通话失败原因也要取出来（480 / 403 就在 cause.message 里）", () => {
  // 形状来自 JsSIP 的 RTCSession failed 事件
  const detail = sipEventDetail({
    callId: "call_1",
    error: {
      code: "CALL_OPERATION_NOT_ALLOWED",
      category: "call",
      retryable: false,
      message: "CALL_OPERATION_NOT_ALLOWED",
      cause: {
        originator: "remote",
        message: { status_code: 480, reason_phrase: "Temporarily Unavailable" },
        cause: "SIP Failure Code",
      },
    },
  });
  assert.match(detail, /"error\.cause\.status":"480 Temporarily Unavailable"/);
  assert.match(detail, /"error\.cause\.originator":"remote"/);
  assert.match(detail, /"error\.cause\.reason":"SIP Failure Code"/);
  assert.match(detail, /"error\.code":"CALL_OPERATION_NOT_ALLOWED"/);
});

test("连接类错误（InvalidStateError）也照旧认得出来", () => {
  const detail = sipEventDetail({
    callId: "call_2",
    error: { code: "CALL_OPERATION_NOT_ALLOWED", cause: { name: "InvalidStateError", message: "Not connected" } },
  });
  assert.match(detail, /"error\.cause\.name":"InvalidStateError"/);
  assert.match(detail, /"error\.cause\.message":"Not connected"/);
});
