// 日志与状态文案：逐条对齐 D:\code\ccbar\index.html（参考页）与 SDK 的 getStatusText。
// 这里保持纯函数、不依赖 vue，便于 node --test 直接覆盖。

export type LogPanel = "flow" | "sip";
export type LogLevel = "info" | "ok" | "warn" | "error";
export type WorkStatus = "offline" | "online" | "busy" | "reset";
export type ServiceStatus = "idle" | "busy" | "calling" | "hold" | "transferring";
export type SipStatus =
  | "unreg"
  | "connecting"
  | "connected"
  | "registered"
  | "unregistered"
  | "failed"
  | "error";

// 与参考页 hookConsoleToFlowLog 一致：只有命中这些关键字的 console 输出才进 SIP 面板
export const SIP_LOG_RE = /JsSIP|WebSocket|Registration|registrar|sip:|UA\[|transport|WebPhone/i;
// 与参考页 onError 一致：这些话机相关的错误写进 SIP 面板
export const SIP_ERROR_RE = /话机|WebSocket|ws:|wss:|SIP|注册/i;

export const statusText = {
  work: { offline: "离线", online: "在线", busy: "忙碌", reset: "休息" },
  serv: {
    idle: "空闲",
    busy: "振铃中",
    calling: "呼出中",
    // 参考 SDK 把「已接通」也记作 calling；页面按会话是否 established 显示成「通话中」
    talking: "通话中",
    hold: "保持中",
    transferring: "转接中",
  },
  sip: {
    unreg: "未注册",
    connecting: "连接中",
    connected: "已连接",
    registered: "已注册",
    unregistered: "未注册",
    failed: "注册失败",
    error: "错误",
  },
} as const;

export type LogLine = {
  id: number;
  panel: LogPanel;
  level: LogLevel;
  source: string;
  message: string;
  time: string;
};

// 参考页只对 JSON 分支打码；本页的软电话 WSS 自带 ?token=，字符串也要打
const TOKEN_RE = /([?&]token=)[^&"]*/gi;

// 与参考页 stringifyLog 一致：字符串原样、Error 取 message、其余 JSON，token 打码
export function stringifyLog(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(TOKEN_RE, "$1***");
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value).replace(TOKEN_RE, "$1***");
  } catch {
    return String(value).replace(TOKEN_RE, "$1***");
  }
}

// 与参考页 cleanJsSipText 一致：丢掉 %c 的颜色参数，password / token 打码，压平空白
export function cleanJsSipText(args: unknown[]): string {
  return args
    .filter((arg) => typeof arg !== "string" || !/^color:\s/i.test(arg))
    .map(stringifyLog)
    .join(" ")
    .replace(/%c/g, "")
    .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"')
    .replace(/\s+/g, " ")
    .trim();
}

// SDK 事件的详情：只留排障字段，并把 SIP 响应码/原因从 message 里提出来。
// 原始 SIP 原文仍由 console 钩子（来源 jssip）记录，这里不再重复整条报文。
export function sipEventDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const detail: Record<string, string | number | boolean> = {};
  for (const key of ["cause", "desc", "reason", "code", "originator", "status", "sessionId"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      detail[key] = value;
  }
  const response = record.message as
    | { status_code?: unknown; reason_phrase?: unknown }
    | undefined;
  if (response && typeof response === "object") {
    if (typeof response.status_code === "number") detail.status = response.status_code;
    if (typeof response.reason_phrase === "string" && response.reason_phrase)
      detail.reason = response.reason_phrase;
  }
  return Object.keys(detail).length ? stringifyLog(detail) : "";
}

// 与参考页 appendPanelLog 一致：HH:MM:SS.mmm
export function timeStamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}
