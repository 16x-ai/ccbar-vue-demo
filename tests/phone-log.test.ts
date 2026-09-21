import { test } from "node:test";
import assert from "node:assert/strict";
import { sipEventDetail, statusText, stringifyLog } from "../src/lib/logs.ts";

test("日志文本与参考页 stringifyLog 一致，token 打码", () => {
  assert.equal(stringifyLog(null), "");
  assert.equal(stringifyLog(undefined), "");
  assert.equal(stringifyLog("hello"), "hello");
  assert.equal(stringifyLog(new Error("boom")), "boom");
  assert.equal(stringifyLog({ a: 1 }), '{"a":1}');
  assert.equal(
    stringifyLog("wss://call-ng.innopaas.com/api/fs/sip-ws?token=SECRET&x=1"),
    "wss://call-ng.innopaas.com/api/fs/sip-ws?token=***&x=1",
  );
});

test("事件详情只留排障字段，并从响应里提出状态码", () => {
  assert.equal(
    sipEventDetail({
      cause: "Unavailable",
      originator: "remote",
      sessionId: "abc",
      message: { status_code: 480, reason_phrase: "Temporarily Unavailable" },
      extra: "不该出现",
    }),
    '{"cause":"Unavailable","originator":"remote","sessionId":"abc","status":480,"reason":"Temporarily Unavailable"}',
  );
  assert.equal(sipEventDetail({ business: "x" }), "");
  assert.equal(sipEventDetail(undefined), "");
  assert.equal(sipEventDetail("reg.registered"), "");
});

test("状态文案逐条对齐 SDK getStatusText", () => {
  assert.deepEqual(statusText.work, {
    offline: "离线",
    online: "在线",
    busy: "忙碌",
    reset: "休息",
  });
  assert.deepEqual(statusText.serv, {
    idle: "空闲",
    busy: "振铃中",
    calling: "呼出中",
    talking: "通话中",
    hold: "保持中",
    transferring: "转接中",
  });
  assert.deepEqual(statusText.sip, {
    unreg: "未注册",
    connecting: "连接中",
    connected: "已连接",
    registered: "已注册",
    unregistered: "未注册",
    failed: "注册失败",
    error: "错误",
  });
});
