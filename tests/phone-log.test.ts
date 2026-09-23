import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentStatus,
  callStatus,
  connectionStatus,
  isLocalFailure,
  messageText,
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
  assert.equal(connectionStatus.connecting.text, "连接中");
  assert.equal(connectionStatus.connected.text, "已连接");
  assert.equal(connectionStatus.failed.text, "注册失败");
  assert.equal(callStatus.idle.text, "空闲");
  assert.equal(callStatus.dialing.text, "呼出中");
  assert.equal(callStatus.ringing.text, "振铃中");
  // 老 ccbar 没有「接通中」：200 OK 一到（isEstablished() 成立）就是 talking
  assert.equal(callStatus.connecting.text, "通话中");
  assert.equal(callStatus.connecting.tone, "talking");
  assert.equal(callStatus.active.text, "通话中");
  assert.equal(callStatus.held.text, "保持中");
  assert.equal(agentStatus.available.text, "在线");
  assert.equal(agentStatus.break.text, "休息");
  // 参考页 CSS 里存在的 serv class 就这几个
  for (const { tone } of Object.values(callStatus)) {
    assert.ok(["idle", "busy", "calling", "talking", "hold"].includes(tone), tone);
  }
});

test("SIP 标签对齐老 ccbar：只有「已注册」是绿的，断链显示「未注册」", () => {
  // ccbar.js updateUIStatus：`ccbar_sip_status_${status === 'registered' ? 'reg' : 'unreg'}`
  for (const [state, { tone }] of Object.entries(connectionStatus)) {
    assert.equal(tone === "reg", state === "registered", `${state} 的配色与 ccbar 不一致`);
  }
  // 连上了但还没注册成功（connected）仍然按灰的展示
  assert.equal(connectionStatus.connected.tone, "unreg");
  // SDK 的「重连中」在老 ccbar 里没有这个概念：断链统一显示「未注册」，细节只在日志里
  assert.deepEqual(connectionStatus.reconnecting, { text: "未注册", tone: "unreg" });
});

test("失败提示：错误码换成中文，其它文案原样（老 ccbar 的提示都是中文）", () => {
  assert.equal(messageText("CALL_OPERATION_NOT_ALLOWED"), "呼叫失败");
  assert.equal(messageText("CALL_BUSY"), "对方忙");
  assert.equal(messageText("MEDIA_PERMISSION_DENIED"), "麦克风权限被拒绝");
  // SDK 已经给中文的（例如坐席账号失败）原样透出
  assert.equal(messageText("获取坐席账号失败（HTTP 500）"), "获取坐席账号失败（HTTP 500）");
  assert.equal(messageText(""), "");
});

test("认得「本机自己结束的」呼叫：originator=local（挂断 / 拒接 / 振铃中取消）", () => {
  assert.equal(isLocalFailure({ originator: "local" }), true);
  // 真实形状：call.failed 的 error.cause 是 JsSIP 的失败对象
  assert.equal(
    isLocalFailure({ code: "CALL_OPERATION_NOT_ALLOWED", cause: { originator: "local", cause: "Canceled" } }),
    true,
  );
  // 对端导致的失败不算本地
  assert.equal(
    isLocalFailure({ cause: { originator: "remote", message: { status_code: 480 } } }),
    false,
  );
  assert.equal(isLocalFailure(undefined), false);
  assert.equal(isLocalFailure("local"), false);
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
