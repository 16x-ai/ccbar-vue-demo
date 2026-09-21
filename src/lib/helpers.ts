// 页面实际用到的纯函数：API 主机 / 软电话 WSS 校验、首通失败判定。
// （新 SDK 那条路的 Token 契约校验不在这里，需要时从 ccbar-web-sdk 的文档补回。）

export function migrateApiHost(value: string): string {
  const text = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\/callapi-ng\.innopaas\.com$/i.test(text)) {
    return "https://call-ng.innopaas.com";
  }
  return text;
}

export function validateApiHost(value: string): string {
  const text = migrateApiHost(value);
  try {
    const url = new URL(text);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    )
      return text.replace(/\/+$/, "");
  } catch {
    /* 与旧坐席条一致：必须带协议。 */
  }
  throw new Error("API 主机需以 http:// 或 https:// 开头。");
}

export function validateSipWs(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    if (url.protocol === "wss:" || url.protocol === "ws:") return text;
  } catch {
    /* 与旧坐席条一致。 */
  }
  throw new Error("软电话 WSS 需以 wss:// 或 ws:// 开头。");
}

// JsSIP 把 408/410/430/480 统一映射成 cause='Unavailable'（fork 版注释同样提到这点）。
// 这里只用来判断「值得再拨一次」，不做业务判断。
export function isTemporarySipFailure(cause: unknown): boolean {
  const text = String(cause == null ? "" : cause).trim();
  return /^(unavailable|request timeout)$/i.test(text) || /^(408|480)$/.test(text);
}
