import { test } from "node:test";
import assert from "node:assert/strict";
import { SEAT_STATUS, createSessionProvider, setSeatStatus } from "../src/lib/session.ts";

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

test("坐席状态映射：忙碌与休息都是 break，用 reason 区分", () => {
  assert.deepEqual(SEAT_STATUS.available.request, { status: "available", reason: "空闲" });
  assert.deepEqual(SEAT_STATUS.busy.request, { status: "break", reason: "忙碌" });
  assert.deepEqual(SEAT_STATUS.break.request, { status: "break", reason: "休息" });
  assert.deepEqual(SEAT_STATUS.offline.request, { status: "offline", reason: "" });
});

const HOST = "https://api.example.test";

/**
 * 假「同源接口 + 平台」：/get-session 取会话 → /get-token 取票 → seat/account/get 取账号 → seats/set-status 改状态。
 * 记下每次请求的地址、请求体与 Authorization，供断言「是谁在打这些接口」。
 */
function mockPlatform(onStatus?: (body: Record<string, unknown>) => Response | undefined) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body, ...(headers.Authorization ? { authorization: headers.Authorization } : {}) });
    if (url.endsWith("/get-session")) {
      return jsonResponse({
        sip: { uri: "sip:p8001@sip.example.test" },
        agent: { extension: "p8001" },
        // 服务端拼好的会话：软电话地址上就带着 fs token，切状态直接用它
        transport: { wssUrl: "wss://sip.example.test:7443/api/fs/sip-ws?token=session-token" },
        username: "p8001",
        customerPrefix: "p",
      });
    }
    if (url.endsWith("/get-token")) {
      return jsonResponse({ code: 0, data: { token: "fs-token", expires: 600 } });
    }
    if (url.endsWith("/seat/account/get")) {
      return jsonResponse({ code: 0, data: { username: "p8001", customerPrefix: "p" } });
    }
    return onStatus?.(body) ?? jsonResponse({ code: 0 });
  }) as typeof fetch;
  return {
    calls,
    statusCalls: () => calls.filter((call) => call.url.endsWith("/seats/set-status")),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("置忙 / 退签：由 npm 包从浏览器直接打平台接口，不再经过服务端路由", async () => {
  const { calls, statusCalls, restore } = mockPlatform();
  try {
    const logs: string[] = [];
    const provider = createSessionProvider(config, () => undefined);
    const log = (level: string, source: string, message: unknown) => {
      logs.push(`${level}/${source} ${String(message)}`);
    };
    await setSeatStatus(provider, "busy", log);
    await setSeatStatus(provider, "offline", log);

    // 页面只打自己服务端的取票口子，其余都是 SDK 直接打平台
    assert.deepEqual(calls.map((call) => call.url), [
      "/get-token",
      `${HOST}/openapi/token/v1/seat/account/get`,
      `${HOST}/openapi/token/v1/seats/set-status`,
      `${HOST}/openapi/token/v1/seats/set-status`,
    ]);
    assert.equal(calls[0]?.body.extension, "8001");
    // 平台取值（Available / On Break / Logged Out）由 npm 包映射；
    // extension 用坐席账号（p8001）而不是用户填的分机号（8001）
    assert.deepEqual(statusCalls().map((call) => call.body), [
      { extension: "p8001", status: "On Break", reason: "忙碌" },
      { extension: "p8001", status: "Logged Out", reason: "" },
    ]);
    assert.equal(calls[1]?.authorization, "fs-token");
    assert.ok(statusCalls().every((call) => call.authorization === "fs-token"));
    // 服务端那条 /set-agent-status 路由不再被页面调用
    assert.ok(calls.every((call) => !call.url.includes("/set-agent-status")));
    assert.ok(logs.some((line) => line.includes("设置坐席状态 On Break（忙碌）")));
    assert.ok(logs.some((line) => line.startsWith("ok/seat")));
  } finally {
    restore();
  }
});

test("取回会话后：切状态直接用软电话地址里的 token，不再打 /get-token", async () => {
  const { calls, statusCalls, restore } = mockPlatform();
  try {
    const provider = createSessionProvider(config, () => undefined);
    await provider.createSession({ sdkVersion: "3.1.9", platform: "web" });
    await setSeatStatus(provider, "busy", () => undefined);

    assert.ok(calls.every((call) => !call.url.endsWith("/get-token")));
    assert.deepEqual(
      statusCalls().map((call) => [call.authorization, call.body.status, call.body.reason]),
      [["session-token", "On Break", "忙碌"]],
    );
    // 会话带回来的账号只有一份，不再回落到 /get-token 换的那张
    assert.equal(calls.filter((call) => call.url.includes("/seat/account/get")).length, 1);
  } finally {
    restore();
  }
});

test("平台报错时把平台的话透给页面（SDK 的错误码在 message 上、原因在 cause 上）", async () => {
  const { statusCalls, restore } = mockPlatform(() => jsonResponse({ code: -1, message: "坐席未签入" }));
  try {
    const provider = createSessionProvider(config, () => undefined);
    await assert.rejects(() => setSeatStatus(provider, "busy", () => undefined), /坐席未签入/);
    assert.equal(statusCalls().length, 1);
  } finally {
    restore();
  }
});

test("换票失败时把服务端那句原因报给页面（不再被 SDK 归一成「返回里没有 token」）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse({ code: -1, message: "请填写 API 主机（接口网关地址）" })) as typeof fetch;
  try {
    const provider = createSessionProvider(config, () => undefined);
    await assert.rejects(
      () => setSeatStatus(provider, "busy", () => undefined),
      /请填写 API 主机（接口网关地址）/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("取会话：页面打同源 /get-session，账号与分机前缀交给页面显示", async () => {
  const { calls, restore } = mockPlatform();
  try {
    const accounts: Array<Record<string, unknown>> = [];
    const provider = createSessionProvider(config, () => undefined, (account) => {
      accounts.push({ ...account });
    });
    const session = (await provider.createSession({ sdkVersion: "3.1.9", platform: "web" })) as {
      agent?: { extension?: string };
    };

    // 页面只打自己服务端的 /get-session（服务端拼会话、解密码都在那边）
    assert.deepEqual(calls.map((call) => call.url), ["/get-session"]);
    assert.equal(calls[0]?.body.extension, "8001");
    assert.equal(session.agent?.extension, "p8001");
    assert.deepEqual(accounts, [{ username: "p8001", customerPrefix: "p" }]);
  } finally {
    restore();
  }
});

test("SDK 的 setAgentStatus（空闲 / 休息）落到平台接口，且用坐席账号而不是用户填的分机号", async () => {
  const { statusCalls, restore } = mockPlatform();
  try {
    const provider = createSessionProvider(config, () => undefined);
    await provider.setAgentStatus({ status: "available", reason: "" });
    await provider.setAgentStatus({ status: "break", reason: "" });

    // reason 传空就按 npm 包里的默认原因（空闲 / 休息）
    assert.deepEqual(
      statusCalls().map((call) => [call.body.extension, call.body.status, call.body.reason]),
      [
        ["p8001", "Available", "空闲"],
        ["p8001", "On Break", "休息"],
      ],
    );
  } finally {
    restore();
  }
});
