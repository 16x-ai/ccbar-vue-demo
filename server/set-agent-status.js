import { getToken } from "./get-token.js";

// 设置坐席状态：对齐 xcall fork 的 ccbar.js（setSeatStatus）。
// 平台只认三个字符串，忙碌与休息都是 On Break，用 reason 区分：
//   空闲 Available（空闲） / 置忙 On Break（忙碌） / 休息 On Break（休息） / 退签 Logged Out
const SEAT_STATUS_PATH_DEFAULT = "/openapi/token/v1/seats/set-status";

function seatStatusPath() {
  return process.env.CC_SEAT_STATUS_PATH || SEAT_STATUS_PATH_DEFAULT;
}

export const SEAT_STATUSES = new Set(["Available", "On Break", "Logged Out"]);

/**
 * 带 fs token 请求平台：POST {API主机}/openapi/token/v1/seats/set-status
 */
export async function setSeatStatus({
  host,
  appKey,
  appSecret,
  extension,
  status,
  reason = "",
  fetchImpl = fetch,
} = {}) {
  const seat = String(extension || "").trim();
  if (!seat) throw new Error("分机号 extension 不能为空");
  if (!SEAT_STATUSES.has(status)) throw new Error(`不支持的坐席状态：${status}`);

  const tokenResult = await getToken({ isPublic: true, extension: seat, host, appKey, appSecret });
  const fsToken = String(tokenResult?.data?.token || "").trim();
  if (!fsToken) throw new Error("Token 接口没有返回 token");

  const base = String(host || "").trim().replace(/\/+$/, "");
  const apiUrl = `${base}${seatStatusPath()}`;
  console.log(`[ccbar-seat-status] POST ${apiUrl} status=${status}`);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      // 与坐席账号接口一致：fs token 原样放在 Authorization 上
      Authorization: fsToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ extension: seat, status, reason }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      `坐席状态接口返回了非 JSON 响应（HTTP ${response.status}）：${text.trim().slice(0, 200)}` +
        `。请求地址：POST ${apiUrl}`,
    );
  }
  if (!response.ok || result.code !== 0) {
    throw new Error(result?.message || `设置坐席状态失败（HTTP ${response.status}）`);
  }
  return { status, reason };
}
