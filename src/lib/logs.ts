// 日志与状态文案：日志部分逐条对齐 D:\code\ccbar\index.html（参考页）；
// 状态文案对到 npm 版 SDK（@16x/webphone-sdk）的连接/通话/坐席三套状态，class 仍沿用参考页的 ccbar_*_status_*。
// 这里保持纯函数、不依赖 vue，便于 node --test 直接覆盖。

export type LogPanel = "flow" | "sip";
export type LogLevel = "info" | "ok" | "warn" | "error";

// SDK：ConnectionStateEvent.state
export type ConnectionState = "offline" | "connecting" | "connected" | "reconnecting" | "failed";
// SDK：CallState（types.ts）
export type CallState =
  | "new"
  | "dialing"
  | "ringing"
  | "connecting"
  | "active"
  | "held"
  | "ended"
  | "failed";
// SDK：setAgentStatus 的取值；busy 由页面自己调平台的坐席状态接口得到（SDK 没有这个取值）
export type AgentState = "available" | "break" | "busy" | "offline";

// 与参考页 hookConsoleToFlowLog 一致：只有命中这些关键字的 console 输出才进 SIP 面板
export const SIP_LOG_RE = /JsSIP|WebSocket|Registration|registrar|sip:|UA\[|transport|WebPhone/i;

export type LogLine = {
  id: number;
  panel: LogPanel;
  level: LogLevel;
  source: string;
  message: string;
  time: string;
};

// 工作（坐席）标签：值 / 文案 / 参考页的 class 后缀
export const agentStatus: Record<AgentState, { text: string; tone: string }> = {
  available: { text: "在线", tone: "online" },
  break: { text: "休息", tone: "reset" },
  busy: { text: "忙碌", tone: "busy" },
  offline: { text: "离线", tone: "offline" },
};

// 服务（通话）标签：把 SDK 的 8 个 CallState 归到参考页的 class 词汇上。
//
// 老 ccbar 没有「接通中」这一档（serv 只有 空闲/振铃中/呼出中/通话中/保持中/转接中）：
// `_refreshServiceStatus` 里 isEstablished() 一成立就是 talking，而 200 OK 一到
// isEstablished() 就为真 —— 所以「已应答但媒体还没连上」这段（SDK 的 connecting）
// 在 ccbar 那边显示的就是「通话中」，这里照做，别自作主张加一档。
export const callStatus: Record<CallState | "idle", { text: string; tone: string }> = {
  idle: { text: "空闲", tone: "idle" },
  new: { text: "新建", tone: "idle" },
  dialing: { text: "呼出中", tone: "calling" },
  ringing: { text: "振铃中", tone: "busy" },
  connecting: { text: "通话中", tone: "talking" },
  active: { text: "通话中", tone: "talking" },
  held: { text: "保持中", tone: "hold" },
  ended: { text: "已结束", tone: "idle" },
  failed: { text: "失败", tone: "busy" },
};

// SIP / 连接标签：文案与配色对齐老 ccbar 的 getStatusText + updateUIStatus：
//   文案：unreg/unregistered=未注册、connecting=连接中、connected=已连接、registered=已注册、
//         failed=注册失败、error=错误
//   配色：`ccbar_sip_status_${status === 'registered' ? 'reg' : 'unreg'}` —— **只有「已注册」是绿的**，
//         连上了但还没注册成功（connected）仍然是灰的。
// 两点与 SDK 状态的对应：SDK 的 offline 对应老 ccbar 的 unreg/unregistered；
// 「重连中」（SDK 的 reconnecting）在老 ccbar 里没有这个概念 —— 断链时它显示「未注册」，
// 重连过程只写进日志（见 usePhone 的「重连中（第 N 次）」）。所以这里也按「未注册」展示。
export const connectionStatus: Record<ConnectionState | "registered", { text: string; tone: string }> =
  {
    registered: { text: "已注册", tone: "reg" },
    offline: { text: "未注册", tone: "unreg" },
    connecting: { text: "连接中", tone: "unreg" },
    connected: { text: "已连接", tone: "unreg" },
    reconnecting: { text: "未注册", tone: "unreg" },
    failed: { text: "注册失败", tone: "unreg" },
  };

// 失败提示：老 ccbar 的提示都是中文（`if (data.originator !== 'local') setError('呼叫失败')`），
// 不把 SDK 的错误码丢给用户 —— CCBarError 的 message 就是错误码，直接显示在红字行没人看得懂。
// 错误码本身仍然留在日志里（showError 双写：红字行给中文、日志给原文）。
export const errorText: Record<string, string> = {
  CALL_OPERATION_NOT_ALLOWED: "呼叫失败",
  CALL_INVALID_DESTINATION: "号码格式不正确",
  CALL_REJECTED: "对方拒接",
  CALL_BUSY: "对方忙",
  CALL_ALREADY_EXISTS: "已有通话在进行",
  CALL_NOT_CONNECTED: "话机未连接，请先签入",
  MEDIA_PERMISSION_DENIED: "麦克风权限被拒绝",
  MEDIA_DEVICE_NOT_FOUND: "找不到麦克风设备",
  MEDIA_DEVICE_IN_USE: "麦克风被其它程序占用",
  MEDIA_PLAYBACK_BLOCKED: "浏览器拦截了声音播放",
  NETWORK_OFFLINE: "网络已断开",
  NETWORK_TIMEOUT: "网络超时",
  SIP_WS_UNAVAILABLE: "软电话连接不可用",
  REGISTRATION_FAILED: "注册失败",
  REGISTRATION_REJECTED: "注册被拒绝",
  CAPABILITY_NOT_SUPPORTED: "当前不支持该操作",
  H5_BACKGROUND_NOT_SUPPORTED: "后台不支持外呼",
  AUTH_TOKEN_EXPIRED: "会话已过期，请重新签入",
  AUTH_TOKEN_UNAVAILABLE: "取不到会话，请重新签入",
  SDK_INTERNAL_ERROR: "SDK 内部错误",
  SDK_ALREADY_DISPOSED: "SDK 已销毁，请刷新页面",
};

/** 给用户看的文案：错误码换成中文；已经是中文的（例如「获取坐席账号失败」）原样返回 */
export function messageText(message: string): string {
  const text = String(message ?? "").trim();
  return errorText[text] || text;
}

/**
 * 这通呼叫是不是「本机自己结束的」（挂断 / 拒接 / 振铃中取消）。
 * JsSIP 把本机取消也归到 failed 事件上（cause.originator === 'local'），
 * 老 ccbar 就是靠它区分「自己挂的」和「真失败」：只有后者才提示「呼叫失败」。
 */
export function isLocalFailure(value: unknown, depth = 0): boolean {
  if (value == null || depth > 3 || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.originator === "local") return true;
  return isLocalFailure(record.cause, depth + 1) || isLocalFailure(record.error, depth + 1);
}

// 参考页只对 JSON 分支打码；本页的会话票据/软电话 WSS 自带 token，字符串也要打
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

// 事件详情：只留排障需要的字段，原始 SIP 原文交给 console 钩子（来源 jssip）
export function sipEventDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const detail: Record<string, string | number | boolean> = {};
  for (const key of ["code", "category", "retryable", "callId", "from", "to", "state", "reason", "status", "serverCode", "attempt", "expiresAt"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      detail[key] = value;
  }
  const error = record.error as Record<string, unknown> | undefined;
  if (error && typeof error === "object") {
    for (const key of ["code", "category", "retryable", "status", "serverCode", "message"])
      if (typeof error[key] === "string" || typeof error[key] === "number" || typeof error[key] === "boolean")
        detail[`error.${key}`] = error[key] as string | number | boolean;
    // 底层原因藏在 cause 里，两种形状都要认：
    //   1) JsSIP 的异常（InvalidStateError 之类）：name / message / code
    //   2) JsSIP 的通话失败原因：{ originator, message: SIP 响应, cause: 'SIP 错误码' }
    //      —— 这一种最关键：480 / 403 这些真正的失败原因就在这里，不取出来只能去翻 SIP 原文
    const cause = error.cause as Record<string, unknown> | undefined;
    if (cause && typeof cause === "object") {
      for (const key of ["name", "code", "originator"]) {
        const value = cause[key];
        if (typeof value === "string" || typeof value === "number") detail[`error.cause.${key}`] = value;
      }
      const inner = cause.message;
      if (inner && typeof inner === "object") {
        const response = inner as { status_code?: unknown; reason_phrase?: unknown };
        const status = typeof response.status_code === "number" ? String(response.status_code) : "";
        const phrase = typeof response.reason_phrase === "string" ? response.reason_phrase : "";
        if (status || phrase) detail["error.cause.status"] = `${status} ${phrase}`.trim();
      } else if (typeof inner === "string" && inner !== "") {
        detail["error.cause.message"] = inner;
      }
      if (typeof cause.cause === "string") detail["error.cause.reason"] = cause.cause;
    } else if (typeof cause === "string") {
      detail["error.cause"] = cause;
    }
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

