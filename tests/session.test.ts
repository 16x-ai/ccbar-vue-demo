import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEAT_STATUS_TEXT,
  createLegacySessionProvider,
  isLegacyPlatform,
  setSeatStatus,
} from "../src/lib/session.ts";

const config = {
  host: "https://api.example.test",
  appKey: "k",
  appSecret: "s",
  extension: "8001",
  sipWs: "wss://sip.example.test/api/fs/sip-ws",
  registerExpires: 600,
};

// 这些模块会读浏览器全局（判断是不是 file:// 打开的页面）；node --test 里补一个最小实现
(globalThis as { location?: unknown }).location = { protocol: "http:" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("坐席状态映射：忙碌与休息都是 On Break，用 reason 区分", () => {
  assert.deepEqual(SEAT_STATUS_TEXT.idle, ["Available", "空闲"]);
  assert.deepEqual(SEAT_STATUS_TEXT.busy, ["On Break", "忙碌"]);
  assert.deepEqual(SEAT_STATUS_TEXT.break, ["On Break", "休息"]);
  assert.deepEqual(SEAT_STATUS_TEXT.offline, ["Logged Out", ""]);
});

test("默认走旧平台形态（网关没有 /webphone/v1/*）", () => {
  assert.equal(isLegacyPlatform(), true);
});

test("置忙：页面打 /set-agent-status，把平台状态与原因带上", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  try {
    const logs: string[] = [];
    await setSeatStatus(config, ...SEAT_STATUS_TEXT.busy, (level, source, message) => {
      logs.push(`${level}/${source} ${String(message)}`);
    });

    assert.equal(request?.url, "/set-agent-status");
    assert.deepEqual(request?.body, {
      extension: "8001",
      status: "On Break",
      reason: "忙碌",
      host: "https://api.example.test",
      appKey: "k",
      appSecret: "s",
      sipWs: "wss://sip.example.test/api/fs/sip-ws",
      registerExpires: 600,
    });
    assert.ok(logs.some((line) => line.includes("设置坐席状态 On Break（忙碌）")));
    assert.ok(logs.some((line) => line.startsWith("ok/seat")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("平台报错时抛出去，页面会显示在红字行", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ code: -1, message: "坐席未签入" })) as typeof fetch;
  try {
    await assert.rejects(
      () => setSeatStatus(config, "On Break", "忙碌", () => undefined),
      /坐席未签入/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SDK 的 setAgentStatus 落到平台接口：空闲=Available、休息=On Break(休息)", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/get-session")) {
      return jsonResponse({
        sip: { uri: "sip:8001@sip.example.test" },
        customerPrefix: "p",
        username: "p8001",
      });
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  try {
    const provider = createLegacySessionProvider(config, () => undefined);
    await provider.setAgentStatus?.({ status: "available", reason: "" });
    await provider.setAgentStatus?.({ status: "break", reason: "" });

    assert.deepEqual(
      bodies.map((body) => [body.status, body.reason]),
      [
        ["Available", "空闲"],
        ["On Break", "休息"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
