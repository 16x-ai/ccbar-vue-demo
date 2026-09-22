import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildSipWsUrl,
  decryptSeatPassword,
  getLegacySession,
  getSeatAccount,
} from "../server/get-session.js";

const AES_KEY = "q7X4p6MvK1z8Lb3A";
const AES_IV = "W9e2T4mN0aQ7Ru6C";

// 参考实现（ccbar.js encryptPwd）就是 CryptoJS.AES.decrypt：CBC + Pkcs7，密文按 Base64
function encryptLikeLegacy(plain: string): string {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(AES_KEY, "utf8"),
    Buffer.from(AES_IV, "utf8"),
  );
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("解开坐席密码：AES-128-CBC/Pkcs7，密文是 Base64", () => {
  const encrypted = encryptLikeLegacy("s3cret-pwd");
  assert.equal(decryptSeatPassword(encrypted), "s3cret-pwd");
  assert.equal(decryptSeatPassword(""), "");
});

test("WSS 地址：挂 ?token=，相对路径按 API 主机解析", () => {
  assert.equal(
    buildSipWsUrl({ configured: "", domain: "sip.example.test", wssPort: 7443, host: "https://api.example.test", token: "fs-t" }),
    "wss://sip.example.test:7443/api/fs/sip-ws?token=fs-t",
  );
  assert.equal(
    buildSipWsUrl({ configured: "", domain: "sip.example.test", wssPort: 443, host: "https://api.example.test", token: "fs-t" }),
    "wss://sip.example.test/api/fs/sip-ws?token=fs-t",
  );
  assert.equal(
    buildSipWsUrl({ configured: "/fs/sip-ws", domain: "sip.example.test", wssPort: 7443, host: "https://api.example.test", token: "fs-t" }),
    "wss://api.example.test/fs/sip-ws?token=fs-t",
  );
  assert.equal(
    buildSipWsUrl({ configured: "wss://custom.example.test:9443/ws", domain: "sip.example.test", wssPort: 7443, host: "https://api.example.test", token: "fs-t" }),
    "wss://custom.example.test:9443/ws?token=fs-t",
  );
});

test("坐席账号：fs token 放在 Authorization 上打 seat/account/get", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (requests.length === 1)
      return jsonResponse({ code: 0, data: { token: "fs-token", expires: 600 } });
    return jsonResponse({
      code: 0,
      data: { username: "p8001", password: encryptLikeLegacy("pwd"), domain: "sip.example.test" },
    });
  }) as typeof fetch;
  try {
    const { seat, fsToken } = await getSeatAccount({
      host: "https://api.example.test",
      appKey: "k",
      appSecret: "s",
      extension: "8001",
    });
    assert.equal(fsToken, "fs-token");
    assert.equal(seat.username, "p8001");
    assert.equal(requests[0]?.url, "https://api.example.test/openapi/v1/token/fs");
    assert.equal(requests[1]?.url, "https://api.example.test/openapi/token/v1/seat/account/get");
    assert.equal(requests[1]?.headers.Authorization, "fs-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("拼出 SDK 能用的会话：注册密码是解出来的明文", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/openapi/v1/token/fs"))
      return jsonResponse({ code: 0, data: { token: "fs-token", expires: 600 } });
    return jsonResponse({
      code: 0,
      data: {
        username: "p8001",
        password: encryptLikeLegacy("sip-password"),
        domain: "sip.example.test",
        wssPort: 7443,
        customerPrefix: "p",
        turnIp: "turn.example.test",
        turnPort: 3478,
      },
    });
  }) as typeof fetch;
  try {
    const session = (await getLegacySession({
      host: "https://api.example.test",
      appKey: "k",
      appSecret: "s",
      extension: "8001",
      registerExpires: 600,
    })) as Record<string, any>;

    assert.equal(session.sip.uri, "sip:p8001@sip.example.test");
    assert.equal(session.sip.registerTicket, "sip-password");
    assert.equal(session.transport.wssUrl, "wss://sip.example.test:7443/api/fs/sip-ws?token=fs-token");
    // 旧平台的凭据在 URL 上，没有 ticket 子协议
    assert.equal(session.transport.ticket, "");
    assert.deepEqual(session.iceServers, [{ urls: ["stun:turn.example.test"] }]);
    assert.ok(session.capabilities.includes("outbound"));
    assert.ok(session.expiresAt > Math.floor(Date.now() / 1000));
    // 给页面显示分机用的附加字段（SDK 不读）
    assert.equal(session.customerPrefix, "p");
    assert.equal(session.username, "p8001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("会话 TTL 按密码票的 expiresIn 算（票先过期会导致 REGISTER 401）", async () => {
  const originalFetch = globalThis.fetch;
  let seatExpiresIn = 600;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/openapi/v1/token/fs"))
      return jsonResponse({ code: 0, data: { token: "fs-token", expires: 7200 } });
    return jsonResponse({
      code: 0,
      data: {
        username: "p8001",
        password: encryptLikeLegacy("sip-password"),
        domain: "sip.example.test",
        expiresIn: seatExpiresIn,
      },
    });
  }) as typeof fetch;
  try {
    const short = (await getLegacySession({
      host: "https://api.example.test",
      appKey: "k",
      appSecret: "s",
      extension: "8001",
      sipWs: "wss://sip.example.test/api/fs/sip-ws",
    })) as Record<string, any>;
    const shortTtl = Math.round(short.expiresAt - Date.now() / 1000);
    // 票 600 秒（token 更长时也按票算），并留 180 秒刷新缓冲；±1 秒容忍跨秒边界
    assert.ok(Math.abs(shortTtl - 420) <= 1, `TTL=${shortTtl}，期望 420`);

    seatExpiresIn = 120;
    const shorter = (await getLegacySession({
      host: "https://api.example.test2",
      appKey: "k",
      appSecret: "s",
      extension: "8001",
      sipWs: "wss://sip.example.test/api/fs/sip-ws",
    })) as Record<string, any>;
    const shorterTtl = Math.round(shorter.expiresAt - Date.now() / 1000);
    // 票很短时至少留 60 秒，别把 SDK 逼到疯狂刷新
    assert.ok(shorterTtl <= 60 && shorterTtl >= 59, `TTL=${shorterTtl}，期望 60`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("网关报错时透传 message，不把半成品会话给页面", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ code: 1101, message: "坐席不存在" })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        getLegacySession({
          host: "https://api.example.test",
          appKey: "k",
          appSecret: "s",
          extension: "8001",
        }),
      /坐席不存在/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
