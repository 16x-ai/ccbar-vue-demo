import { test } from "node:test";
import assert from "node:assert/strict";
import { SEAT_STATUSES, setSeatStatus } from "../server/set-agent-status.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("置忙/休息都走 seats/set-status，用 reason 区分，Authorization 带 fs token", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string; auth: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/openapi/v1/token/fs")) {
      return jsonResponse({ code: 0, data: { token: "fs-token", expires: 600 } });
    }
    requests.push({
      url,
      body: String(init?.body ?? ""),
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
    });
    return jsonResponse({ code: 0, message: "ok" });
  }) as typeof fetch;
  try {
    await setSeatStatus({
      host: "https://api.example.test",
      appKey: "k",
      appSecret: "s",
      extension: "8001",
      status: "On Break",
      reason: "忙碌",
    });
    await setSeatStatus({
      host: "https://api.example.test",
      appKey: "k",
      appSecret: "s",
      extension: "8001",
      status: "Available",
      reason: "空闲",
    });

    assert.equal(requests[0]?.url, "https://api.example.test/openapi/token/v1/seats/set-status");
    assert.deepEqual(JSON.parse(requests[0]!.body), {
      extension: "8001",
      status: "On Break",
      reason: "忙碌",
    });
    assert.deepEqual(JSON.parse(requests[1]!.body), {
      extension: "8001",
      status: "Available",
      reason: "空闲",
    });
    assert.equal(requests[0]?.auth, "fs-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("平台只认三个状态值，其余直接拒绝", async () => {
  assert.deepEqual([...SEAT_STATUSES], ["Available", "On Break", "Logged Out"]);
  await assert.rejects(
    () =>
      setSeatStatus({
        host: "https://api.example.test",
        appKey: "k",
        appSecret: "s",
        extension: "8001",
        status: "Busy",
      }),
    /不支持的坐席状态/,
  );
});

test("平台报错时把 message 透传给页面", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/openapi/v1/token/fs")) {
      return jsonResponse({ code: 0, data: { token: "fs-token" } });
    }
    return jsonResponse({ code: 1101, message: "坐席未签入" });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        setSeatStatus({
          host: "https://api.example.test",
          appKey: "k",
          appSecret: "s",
          extension: "8001",
          status: "On Break",
          reason: "忙碌",
        }),
      /坐席未签入/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
