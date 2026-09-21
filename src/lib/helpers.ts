// 页面实际用到的纯函数：API 主机 / 软电话 WSS 校验。
// 首通失败判定在 logs.ts 的 isTemporarySipFailure（需要对 CCBarError 做 stringify）。

// 只做规整（去掉尾部斜杠），**不改写域名**：每个客户/环境的主机由使用方自己填，页面不替他们换。
export function migrateApiHost(value: string): string {
  return value.trim().replace(/\/+$/, "");
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
  throw new Error("请填写 API 主机（接口网关地址，需以 http:// 或 https:// 开头）。");
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

// 显示分机时去掉坐席账号里的 customerPrefix（参考页 shortExtension 同款）。
// 例：账号 p8001 + 前缀 p → 8001；前缀不匹配就原样返回。
export function shortExtension(full: string, prefix: string): string {
  const value = String(full || "").trim();
  const head = String(prefix || "").trim();
  if (head && value.startsWith(head) && value.length > head.length) return value.slice(head.length);
  return value;
}
