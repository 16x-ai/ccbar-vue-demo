import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { SEAT_STATUS, causeText, createSdkSessionProvider } from "../src/lib/session.ts";

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

/** 按平台同一套参数造 SIP 密码密文：AES-128-CBC / Pkcs7 / Base64（与 seat/account/get 返回的 password 同构） */
function encryptSeatPassword(plain: string): string {
  const cipher = createCipheriv(
    "aes-128-cbc",
    Buffer.from("q7X4p6MvK1z8Lb3A", "utf8"),
    Buffer.from("W9e2T4mN0aQ7Ru6C", "utf8"),
  );
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

/**
 * 假环境：页面只打 /ref/get-token（server2 那个口子），
 * 之后的 seat/account/get、seats/set-status 都是 SDK 直接从浏览器打平台的。
 */
function mockRefPlatform(onToken?: () => Response) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    authorization?: string;
    credentials?: RequestCredentials;
  }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({
      url,
      body,
      credentials: init?.credentials,
      ...(headers.Authorization ? { authorization: headers.Authorization } : {}),
    });
    if (url === "/ref/get-token") {
      return onToken?.() ?? jsonResponse({ code: 0, data: { token: "ref-token", expires: 600 } });
    }
    if (url.endsWith("/openapi/token/v1/seat/account/get")) {
      return jsonResponse({
        code: 0,
        data: {
          username: "p8001",
          customerPrefix: "p",
          domain: "sip.example.test",
          password: encryptSeatPassword("s3cret-pwd"),
          expiresIn: 600,
        },
      });
    }
    return jsonResponse({ code: 0 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("签入：页面只打一次 /ref/get-token，取账号与解密都由 SDK 自己做", async () => {
  const { calls, restore } = mockRefPlatform();
  try {
    const accounts: Array<Record<string, unknown>> = [];
    const provider = createSdkSessionProvider(config, () => undefined, (account) => {
      accounts.push({ ...account });
    });
    const session = await provider.createSession({ sdkVersion: "3.1.10", platform: "web" });

    // 页面上只出现一次取票；seat/account/get 是 SDK 自己打的
    assert.deepEqual(calls.map((call) => call.url), [
      "/ref/get-token",
      "https://api.example.test/openapi/token/v1/seat/account/get",
    ]);
    // 直连 server2 时也要能用：取票不带 cookie（它只回显 Origin，不发 Allow-Credentials）
    assert.equal(calls[0]?.credentials, "omit");
    // 平台约定：Authorization 是 token 原样（不带 Bearer），body 必须是 {}
    assert.equal(calls[1]?.authorization, "ref-token");
    assert.deepEqual(calls[1]?.body, {});
    // 会话是 SDK 拼的：密码已解密、软电话地址上挂着同一张票
    assert.equal(session.sip.uri, "sip:p8001@sip.example.test");
    assert.equal(session.sip.registerTicket, "s3cret-pwd");
    assert.equal(session.transport.wssUrl, "wss://sip.example.test/api/fs/sip-ws?token=ref-token");
    // 分机前缀：会话里没有，由 provider 缓存的账号回调上来（不会有第二次 seat/account/get）
    assert.deepEqual(accounts, [{ username: "p8001", customerPrefix: "p" }]);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("签入：置忙仍然打平台 seats/set-status，用的是坐席账号，且不再多换一次票", async () => {
  const { calls, restore } = mockRefPlatform();
  try {
    const provider = createSdkSessionProvider(config, () => undefined);
    await provider.createSession({ sdkVersion: "3.1.10", platform: "web" });
    await provider.setAgentStatus({ status: "break", reason: "忙碌" });

    const status = calls.filter((call) => call.url.endsWith("/seats/set-status"));
    assert.equal(status.length, 1);
    // 会话软电话地址里那张票就够用：全程只换过一次票
    assert.equal(status[0]?.authorization, "ref-token");
    assert.deepEqual(status[0]?.body, { extension: "p8001", status: "On Break", reason: "忙碌" });
    assert.equal(calls.filter((call) => call.url === "/ref/get-token").length, 1);
  } finally {
    restore();
  }
});

test("签入：取票失败时把服务端那句原话带给页面", async () => {
  const { restore } = mockRefPlatform(() =>
    jsonResponse({ code: -1, message: "请填写 API 主机（接口网关地址）" }),
  );
  try {
    const provider = createSdkSessionProvider(config, () => undefined);
    // SDK 会把 cause 包一层（错误码在 message 上），页面用 causeText() 取可读的那句
    const error = await provider
      .createSession({ sdkVersion: "3.1.10", platform: "web" })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    assert.notEqual(error, undefined);
    assert.match(causeText(error), /请填写 API 主机（接口网关地址）/);
  } finally {
    restore();
  }
});
