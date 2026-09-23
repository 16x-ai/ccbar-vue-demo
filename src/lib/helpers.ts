// 页面实际用到的纯函数：API 主机 / 软电话 WSS 校验。

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

// 软电话地址是必填项：它决定了话机连哪里，留空只会让签入在更晚的地方失败
export function validateSipWs(value: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error("请填写软电话 WSS（wss:// 开头，例如 wss://你们的域名/api/fs/sip-ws）");
  }
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

// 内呼：平台靠「企业前缀 + 分机号」认内线（参考实现 insideCall 就是这么拼的，没有别的标记）。
// 已经带前缀的不重复拼；没配前缀就原样拨。
export function prefixExtension(number: string, prefix: string): string {
  const value = String(number || "").trim();
  const head = String(prefix || "").trim();
  if (!head || !value || value.startsWith(head)) return value;
  return `${head}${value}`;
}

// 自定义参数（userdata）：会随 INVITE 带上 X-User-Data 头，由平台/服务端读。
// 限制与 SDK 一致（只能可见 ASCII），页面先拦一道是为了给中文提示 ——
// SDK 那边只回错误码 CALL_INVALID_USERDATA，直接显示在红字行上看不懂。
export const USERDATA_HINT =
  "自定义参数只能是可见 ASCII（不能有换行或中文）；中文/JSON 请先 encodeURIComponent 再传";

export function normalizeUserdata(value: string): string {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  if (/[^\x20-\x7E]/.test(text)) throw new Error(USERDATA_HINT);
  return text;
}
