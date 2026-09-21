import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { CCBarClient } from "@16x/webphone-sdk";
import type { CCBarCall, CCBarClientOptions, SessionProvider, WebPhoneSession } from "@16x/webphone-sdk";
import { migrateApiHost, shortExtension, validateApiHost, validateSipWs } from "./helpers";
import {
  SIP_LOG_RE,
  agentStatus,
  callStatus,
  cleanJsSipText,
  connectionStatus,
  isTemporarySipFailure,
  sipEventDetail,
  stringifyLog,
  timeStamp,
} from "./logs";
import type {
  AgentState,
  CallState,
  ConnectionState,
  LogLevel,
  LogLine,
  LogPanel,
} from "./logs";

// API 主机：每个客户/环境都不一样，所以代码里没有固定默认值。
// 交付时可用构建变量按客户注入默认值（不设就留空，用户必须在设置里填）：
//   VITE_API_HOST=https://<客户的接口网关> npm run build
function defaultApiHost(): string {
  return String(import.meta.env.VITE_API_HOST || "").trim();
}
// 与参考页一致：SIP 注册有效期留空按 600 秒（两种形态都会把它交给会话：新平台随 token 请求透传，
// 旧平台由 /get-session 写进 session.sip.registerExpires；SDK 没拿到值时才回退 300）
const REGISTER_EXPIRES_MIN = 10;
const REGISTER_EXPIRES_MAX = 3600;
const REGISTER_EXPIRES_DEFAULT = 600;
const SETTINGS_KEY = "ccbar.vueDemo.settings";
// 参考页的日志 DOM 不设上限；Vue 里留一个足够大的窗口，避免长会话无限增长
const LOG_LIMIT = 500;
// 首通保护：刚注册完的短时间内平台可能还没准备好（回 480），只在这个窗口里自动重拨
const FIRST_CALL_GUARD_MS = 15000;
const CALL_RETRY_DELAYS = [1500, 3000, 6000];

type SavedSettings = {
  host?: string;
  extension?: string;
  appKey?: string;
  appSecret?: string;
  sipWs?: string;
  registerExpires?: number | string;
  legacyPlatform?: boolean;
};
function loadSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as SavedSettings) : {};
  } catch {
    return {};
  }
}

export type IncomingCall = { callid: string; callerName: string };

// 旧平台兼容模式的会话来源用 SDK 的 sessionProvider（@16x/webphone-sdk 3.1.0 起）
// 参考页同款：显示分机时去掉坐席账号里的 customerPrefix（实现见 helpers.ts）

// Token 接口地址（与旧 ccbar.js 页面里的 TOKEN_API 一个用法，是页面级常量）：
//   留空 = 按约定拼：同源 `/get-token`；用 file:// 直接打开页面时拼「API 主机 + /get-token」
//   填了 = 原样使用，例如 '/your/token/path'、'http://127.0.0.1:3002/get-token'、'https://自己的域名/get-token'
// 部署时也可以不改代码，用环境变量覆盖：VITE_TOKEN_API=/your/path
const TOKEN_API = "";

// 可选：WebPhone API 的基地址（可带前缀）。留空＝同源，由 Vite / nginx 把 /webphone/v1/* 转给平台；
// 平台若挂在别的前缀，除了改了代理重写（WEBPHONE_API_PREFIX），也可以直接配 VITE_WEBPHONE_API_BASE 直连。
function webphoneBaseUrl(): string {
  return String(import.meta.env.VITE_WEBPHONE_API_BASE || "")
    .trim()
    .replace(/\/+$/, "");
}

export function usePhone() {
  const saved = loadSettings();
  const config = reactive<{
    /** API 主机（接口网关）。空字符串表示还没填，签入前会提示 */
    host: string;
    appKey: string;
    appSecret: string;
    extension: string;
    sipWs: string;
    registerExpires: number | string;
    /** true = 旧平台：token/fs + seat/account/get 取会话（server/get-session.js） */
    legacyPlatform: boolean;
  }>({
    // 已保存的值优先；没有就用构建时注入的默认值（可能为空）
    host: migrateApiHost(saved.host || defaultApiHost()),
    appKey: saved.appKey || "",
    appSecret: saved.appSecret || "",
    extension: saved.extension || "1000",
    // 新 SDK 自己从会话里取 WSS 与注册有效期；这两个字段只作为覆盖项一起发给 Token 服务端
    sipWs: saved.sipWs || "",
    registerExpires: saved.registerExpires ?? REGISTER_EXPIRES_DEFAULT,
    // 平台形态也是按客户部署来的：交付时可注入默认值 VITE_LEGACY_PLATFORM=1
    legacyPlatform: saved.legacyPlatform ?? String(import.meta.env.VITE_LEGACY_PLATFORM || "") === "1",
  });

  const client = shallowRef<CCBarClient>();
  const connection = ref<ConnectionState | "registered">("offline");
  const callState = ref<CallState | "idle">("idle");
  const agent = ref<AgentState>("offline");
  const extension = ref("");
  const number = ref("");
  const feedback = ref("");
  const busy = ref("");
  const logs = ref<LogLine[]>([]);
  const incoming = ref<IncomingCall[]>([]);
  const placeholder = reactive<Record<LogPanel, string>>({
    flow: "等待签入。签入、取 Token、坐席账号会写在这里。",
    sip: "等待话机登录。连接与通话事件会写在这里。",
  });
  let logSequence = 0;
  const consoleMethods = new Map<string, (...args: unknown[]) => void>();
  const subscriptions: Array<() => void> = [];
  let registeredAt = 0;
  // 当前客户端实际用的会话来源（用于判断设置里的平台形态有没有变）
  let activeLegacy = false;
  let callRetry = { target: "", attempt: 0, timer: 0, startedAt: 0, inFlight: false };
  let activeCallId = "";

  const connected = computed(
    () => connection.value === "registered" || connection.value === "connected",
  );
  const activeCall = computed(() => client.value?.getActiveCall());

  // ---------- 日志 ----------
  function appendPanelLog(panel: LogPanel, level: LogLevel, source: string, message: unknown) {
    logs.value = [
      ...logs.value,
      {
        id: ++logSequence,
        panel,
        level,
        source,
        message: stringifyLog(message),
        time: timeStamp(),
      },
    ].slice(-LOG_LIMIT);
  }
  function appendFlowLog(level: LogLevel, source: string, message: unknown) {
    appendPanelLog(/^(sip|jssip)$/i.test(source) ? "sip" : "flow", level, source, message);
  }
  function clearLog(panel: LogPanel) {
    logs.value = logs.value.filter((line) => line.panel !== panel);
    placeholder[panel] = panel === "sip" ? "SIP 日志已清空。" : "日志已清空。";
  }
  function hookConsole() {
    (["log", "info", "warn", "error", "debug"] as const).forEach((method) => {
      const original = console[method].bind(console);
      consoleMethods.set(method, original);
      console[method] = (...args: unknown[]) => {
        try {
          const text = cleanJsSipText(args);
          if (text && SIP_LOG_RE.test(text)) {
            const level: LogLevel =
              method === "error" ? "error" : method === "warn" ? "warn" : "info";
            appendPanelLog("sip", level, "jssip", text);
          }
        } catch {
          /* 记日志本身不能影响业务 */
        }
        original(...args);
      };
    });
  }
  function unhookConsole() {
    for (const [method, original] of consoleMethods)
      (console as unknown as Record<string, unknown>)[method] = original;
    consoleMethods.clear();
  }

  // SDK 没有公开的 SIP 报文接口，JsSIP 的 debug 命名空间是唯一能拿到 REGISTER/INVITE 原文的途径。
  // 演示页面固定开启（不再做成设置项）：debug 包在模块初始化时读 localStorage.debug，
  // 所以必须在首次 connect（懒加载 JsSIP）之前设置 —— 也就是 mount 里第一时间调用。
  function enableSipDebug() {
    try {
      localStorage.setItem("debug", "JsSIP:*");
    } catch {
      /* 隐私模式下写不了 localStorage，忽略 */
    }
    if (consoleMethods.size === 0) hookConsole();
  }

  // ---------- 错误行 ----------
  function clearError() {
    feedback.value = "";
  }
  function showError(message: unknown) {
    const text = stringifyLog(message).trim();
    if (!text) {
      clearError();
      return;
    }
    feedback.value = text;
    appendFlowLog("error", "ccbar", text);
  }

  // ---------- 设置 ----------
  function saveSettings() {
    const host = validateApiHost(config.host);
    if (!config.appKey.trim() || !config.appSecret.trim())
      throw new Error("API KEY、API SECRET 均不能为空");
    const raw = String(config.registerExpires ?? "").trim();
    const expires = raw ? Number(raw) : REGISTER_EXPIRES_DEFAULT;
    if (
      !Number.isInteger(expires) ||
      expires < REGISTER_EXPIRES_MIN ||
      expires > REGISTER_EXPIRES_MAX
    )
      throw new Error(
        `SIP 注册有效期须为 ${REGISTER_EXPIRES_MIN}–${REGISTER_EXPIRES_MAX} 的整数，或留空使用默认 ${REGISTER_EXPIRES_DEFAULT} 秒`,
      );
    const sipWs = config.sipWs.trim();
    const legacy = Boolean(config.legacyPlatform);
    const modeChanged = legacy !== activeLegacy;
    // 会话来源换了就得重建客户端，通话中重建会丢话路，所以先要求挂断签出
    if (modeChanged && (connected.value || callState.value !== "idle"))
      throw new Error("切换平台形态前请先挂断通话并签出");
    config.host = host;
    config.extension = config.extension.trim() || "1000";
    config.sipWs = sipWs ? validateSipWs(sipWs) : "";
    config.registerExpires = expires;
    config.legacyPlatform = legacy;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...config,
        appKey: config.appKey.trim(),
        appSecret: config.appSecret.trim(),
      }),
    );
    if (modeChanged) rebuildClient();
  }

  // ---------- Token：SDK 的 tokenProvider ----------
  // 地址优先级：VITE_TOKEN_API > TOKEN_API 常量 > 按约定拼（同源 /get-token）。
  // 请求体里的 host/KEY/SECRET 是本地代理模式用的；换成你们自己的签发后端后，只要按同一契约返回
  // { accessToken, expiresAt?, extension? } 即可，这几项可以留空（就不会再发出去）。
  function tokenUrl(): string {
    const configured = String(import.meta.env.VITE_TOKEN_API || TOKEN_API || "").trim();
    if (configured) return configured;
    const base = location.protocol === "file:" ? config.host.trim().replace(/\/+$/, "") : "";
    return `${base}/get-token`;
  }

  async function tokenProvider(request?: { extension?: string }) {
    const extensionValue = request?.extension || config.extension;
    const response = await fetch(tokenUrl(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 最小契约：后端只需这两项（分机通常由服务端登录态决定，不采信浏览器传值）
        platform: "web",
        extension: extensionValue,
        // 本地代理模式才需要的字段；自有后端可以忽略
        ...(config.host ? { host: config.host } : {}),
        ...(config.appKey ? { appKey: config.appKey } : {}),
        ...(config.appSecret ? { appSecret: config.appSecret } : {}),
        ...(config.sipWs ? { sipWs: config.sipWs } : {}),
        ...(config.registerExpires ? { registerExpires: Number(config.registerExpires) } : {}),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      accessToken?: string;
      expiresAt?: number;
      extension?: string;
      message?: string;
    };
    if (!response.ok || !body.accessToken)
      throw new Error(body.message || `获取 Token 失败（HTTP ${response.status}）`);
    return {
      accessToken: body.accessToken,
      ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
      ...(body.extension ? { extension: body.extension } : {}),
    };
  }

  // ---------- 会话：旧平台（sessionProvider） ----------
  // 地址与 Token 同规矩：VITE_SESSION_API > 同源 /get-session（file:// 时拼 API 主机）。
  // 服务端那步见 server/get-session.js：token/fs → seat/account/get → AES 解出 SIP 密码 → 拼会话。
  function sessionUrl(): string {
    const configured = String(import.meta.env.VITE_SESSION_API || "").trim();
    if (configured) return configured;
    const base = location.protocol === "file:" ? config.host.trim().replace(/\/+$/, "") : "";
    return `${base}/get-session`;
  }

  let legacyCustomerPrefix = "";

  async function legacyCreateSession(): Promise<WebPhoneSession> {
    appendFlowLog("info", "seat", `开始获取坐席账号 ${sessionUrl()}`);
    const response = await fetch(sessionUrl(), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extension: config.extension,
        // 本地代理模式才需要的字段；
        // 换成你们自己的后端后，分机和安全凭据都应该由服务端登录态决定
        ...(config.host ? { host: config.host } : {}),
        ...(config.appKey ? { appKey: config.appKey } : {}),
        ...(config.appSecret ? { appSecret: config.appSecret } : {}),
        ...(config.sipWs ? { sipWs: config.sipWs } : {}),
        ...(config.registerExpires ? { registerExpires: Number(config.registerExpires) } : {}),
      }),
    });
    // 会话由我们自己的 /get-session 拼好（server/get-session.js），这里只做最小校验：
    // 有 sip.uri 才算拿到了会话；customerPrefix / username 是服务端额外给页面显示用的字段
    const body = (await response.json().catch(() => ({}))) as Partial<WebPhoneSession> & {
      message?: string;
      customerPrefix?: string;
      username?: string;
    };
    if (!response.ok || !body.sip?.uri) {
      throw new Error(body.message || `获取坐席账号失败（HTTP ${response.status}）`);
    }
    legacyCustomerPrefix = String(body.customerPrefix || "");
    appendFlowLog(
      "ok",
      "seat",
      `坐席账号就绪 ${stringifyLog({ username: body.username, prefix: body.customerPrefix || "-" })}`,
    );
    return body as WebPhoneSession;
  }

  const legacySessionProvider: SessionProvider = {
    createSession: () => legacyCreateSession(),
    // SDK 刷新会话时（注册有效期将到）重新取一次坐席账号，等价于参考页的换密码逻辑
    refreshSession: () => legacyCreateSession(),
  };

  // ---------- 通话状态 ----------
  function refreshCallState() {
    const calls = client.value?.getCalls() ?? [];
    const active = client.value?.getActiveCall();
    // 来电在接通前不是 active call，所以退回到第一路未结束的通话
    const target =
      active ??
      calls.find((call) => call.state !== "ended" && call.state !== "failed") ??
      undefined;
    activeCallId = target?.id ?? "";
    callState.value = target ? target.state : "idle";
  }
  function callById(callId: string): CCBarCall | undefined {
    return client.value?.getCalls().find((call) => call.id === callId);
  }
  function removeIncoming(callId: string) {
    incoming.value = incoming.value.filter((call) => call.callid !== callId);
  }

  // 首通保护：平台在注册后首个外呼回 480，签名到就按固定时间点兜底重拨
  function autoRedial(target: string) {
    callRetry.target = target;
    callRetry.attempt = 0;
    callRetry.startedAt = Date.now();
    appendFlowLog(
      "warn",
      "sip",
      `呼叫暂时不可用，${CALL_RETRY_DELAYS.map((ms) => `${ms / 1000}s`).join(" / ")} 处自动重拨`,
    );
    planNextCallRetry();
  }
  function planNextCallRetry() {
    const offset = CALL_RETRY_DELAYS[callRetry.attempt];
    if (offset == null) return;
    const delay = Math.max(0, callRetry.startedAt + offset - Date.now());
    callRetry.timer = window.setTimeout(() => {
      callRetry.timer = 0;
      callRetry.attempt += 1;
      if (callRetry.inFlight) {
        planNextCallRetry();
        return;
      }
      appendFlowLog("warn", "sip", `自动重拨（第 ${callRetry.attempt} 次）${callRetry.target}`);
      callRetry.inFlight = true;
      void dial(callRetry.target).catch(() => undefined);
      planNextCallRetry();
    }, delay);
  }
  function cancelCallRetry() {
    if (callRetry.timer) window.clearTimeout(callRetry.timer);
    callRetry.timer = 0;
  }

  // ---------- 动作 ----------
  async function run(name: string, action: () => unknown | Promise<unknown>) {
    if (busy.value) return;
    busy.value = name;
    clearError();
    try {
      await action();
    } catch (error) {
      // dial/answer/setActiveCall 在未连接时是同步抛错，try/catch 必须包住调用本身
      showError(error instanceof Error ? error.message : error);
    } finally {
      busy.value = "";
      refreshCallState();
    }
  }

  async function signIn() {
    const instance = client.value;
    if (!instance) throw new Error("SDK 未就绪，请刷新页面");
    saveSettings();
    extension.value = config.extension;
    appendFlowLog("info", "sip", `开始签入 extension=${config.extension} host=${config.host}`);
    await instance.connect({ extension: config.extension });
  }

  async function signOut() {
    cancelCallRetry();
    callRetry.inFlight = false;
    await client.value?.disconnect();
    connection.value = "offline";
    agent.value = "offline";
    callState.value = "idle";
    extension.value = "";
    incoming.value = [];
  }

  async function dial(destination: string, extensionCall = false) {
    const instance = client.value;
    if (!instance) throw new Error("请先签入");
    cancelCallRetry();
    callRetry = {
      target: destination,
      attempt: 0,
      timer: 0,
      startedAt: 0,
      inFlight: true,
    };
    appendFlowLog(
      "info",
      "sip",
      `${extensionCall ? "内呼" : "外呼"} ${destination}${extensionCall ? "（type=extension）" : ""}`,
    );
    await instance.dial(
      extensionCall ? { destination, type: "extension" } : { destination },
    );
  }

  async function hangup() {
    const call = client.value?.getActiveCall() ?? callById(activeCallId);
    await call?.hangup();
  }
  async function hold() {
    await (client.value?.getActiveCall() ?? callById(activeCallId))?.hold();
  }
  async function resume() {
    await (client.value?.getActiveCall() ?? callById(activeCallId))?.resume();
  }
  async function transfer(target: string) {
    const call = client.value?.getActiveCall() ?? callById(activeCallId);
    if (!call) throw new Error("没有可转接的通话");
    await call.transfer({ type: "blind", target });
  }
  async function answerCall(callId: string) {
    await client.value?.answer(callId);
    removeIncoming(callId);
    // 自动播放被拦时需要在用户手势里手动放一下远端音频
    void client.value?.media?.playRemoteAudio?.(callId).catch(() => undefined);
  }
  async function rejectCall(callId: string) {
    await callById(callId)?.reject({ reason: "已拒接" });
    removeIncoming(callId);
  }
  async function setAgent(status: "available" | "break") {
    try {
      await client.value?.setAgentStatus(status);
    } catch (error) {
      // 旧平台没有坐席状态接口：说清楚，而不是把能力错误原样抛给客户
      if (error && typeof error === "object" && "code" in error && error.code === "CAPABILITY_NOT_SUPPORTED")
        throw new Error("旧平台模式没有坐席状态接口（服务端按签入/通话自动置忙置闲）");
      throw error;
    }
    agent.value = status;
  }
  function setBusyUnsupported() {
    showError("当前 SDK 只支持 空闲 / 休息，不支持置忙（busy 由通话与服务端策略决定）");
  }

  // ---------- 生命周期 ----------
  function subscribe(instance: CCBarClient) {
    subscriptions.push(
      instance.on("connection.stateChanged", (event) => {
        connection.value = event.state;
        appendFlowLog("info", "status", `connection=${event.state}`);
      }),
      instance.on("connection.registered", () => {
        connection.value = "registered";
        registeredAt = Date.now();
        const account = instance.getAgent()?.extension || config.extension;
        // 旧平台的坐席账号可能带 customerPrefix，显示时去掉（参考页 shortExtension）
        extension.value = activeLegacy ? shortExtension(account, legacyCustomerPrefix) : account;
        appendPanelLog("sip", "ok", "sip", "connection.registered");
      }),
      instance.on("connection.reconnecting", (event) => {
        appendFlowLog("warn", "status", `重连中（第 ${event.attempt} 次）`);
      }),
      instance.on("connection.failed", (event) => {
        appendFlowLog("error", "ccbar", event.error.message);
        showError(event.error.message);
      }),
      instance.on("token.expiring", (event) => {
        appendFlowLog("info", "token", `Token 将过期 expiresAt=${event.expiresAt}`);
      }),
      instance.on("token.refreshed", (event) => {
        appendFlowLog("ok", "token", `Token 已刷新 expiresAt=${event.expiresAt}`);
      }),
      instance.on("agent.statusChanged", (event) => {
        const status = event.status as AgentState;
        if (status in agentStatus) agent.value = status;
        appendFlowLog("info", "status", `坐席=${event.status}`);
      }),
      instance.on("call.created", (event) => {
        appendFlowLog("info", "call", `call.created ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.incoming", (event) => {
        if (!incoming.value.some((call) => call.callid === event.callId)) {
          incoming.value = [
            ...incoming.value,
            { callid: event.callId, callerName: event.from || "未知号码" },
          ];
        }
        appendFlowLog("info", "call", `来电 ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.stateChanged", (event) => {
        const level: LogLevel = event.to === "failed" ? "error" : event.to === "ended" ? "info" : "info";
        appendPanelLog("sip", level, "call", `call.stateChanged ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.activeChanged", (event) => {
        appendFlowLog("info", "call", `call.activeChanged ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.ended", (event) => {
        appendFlowLog("info", "call", `呼叫结束 ${sipEventDetail(event)}`);
        removeIncoming(event.callId);
        cancelCallRetry();
        callRetry.inFlight = false;
        refreshCallState();
      }),
      instance.on("call.failed", (event) => {
        appendFlowLog("error", "call", `呼叫失败 ${sipEventDetail(event)}`);
        removeIncoming(event.callId);
        callRetry.inFlight = false;
        showError(event.error.message);
        // 首通 480：注册后 15 秒窗口内兜底重拨
        if (
          callRetry.target &&
          isTemporarySipFailure(event.error) &&
          Date.now() - registeredAt <= FIRST_CALL_GUARD_MS
        )
          autoRedial(callRetry.target);
        refreshCallState();
      }),
      instance.on("error", (event) => {
        appendFlowLog("error", "ccbar", `SDK 错误 ${sipEventDetail(event)}`);
        showError(event.error.message);
      }),
    );
  }

  function createClient(): CCBarClient {
    const baseUrl = webphoneBaseUrl();
    const options: CCBarClientOptions = {
      locale: "zh-CN",
      platform: "web",
      ...(baseUrl ? { baseUrl } : {}),
      // demo 单标签页，不启用 SharedWorker
      sharedWorker: { enabled: false, fallback: "single-tab" },
    };
    activeLegacy = config.legacyPlatform;
    try {
      // 会话来源二选一：新平台给 tokenProvider，旧平台给 sessionProvider（SDK 3.1.0 起）
      return config.legacyPlatform
        ? new CCBarClient({ ...options, sessionProvider: legacySessionProvider })
        : new CCBarClient({ ...options, tokenProvider });
    } catch (error) {
      if (!config.legacyPlatform) throw error;
      throw new Error(
        "当前 @16x/webphone-sdk 版本不支持旧平台会话（sessionProvider）：请升级到 3.1.0 以上。" +
          `（原始错误：${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }

  function mount() {
    // 必须在 SDK 首次 connect（懒加载 JsSIP）之前打开 SIP 原文
    enableSipDebug();
    try {
      client.value = createClient();
    } catch (error) {
      // 例如选了旧平台但当前 SDK 版本还没有 sessionProvider：提示清楚，页面别直接白屏
      client.value = undefined;
      showError(error instanceof Error ? error.message : error);
      return;
    }
    subscribe(client.value);
    appendFlowLog(
      "info",
      "app",
      `页面已就绪，等待签入（会话来源：${activeLegacy ? "旧平台 seat/account/get" : "新平台 webphone/v1"}）`,
    );
  }

  // 会话来源只能在构造时决定，所以切换平台形态就重建一个客户端
  function rebuildClient() {
    if (!client.value) return;
    for (const off of subscriptions.splice(0)) off();
    void client.value.dispose();
    client.value = undefined;
    mount();
  }

  function unmount() {
    for (const off of subscriptions.splice(0)) off();
    cancelCallRetry();
    void client.value?.dispose();
    client.value = undefined;
    unhookConsole();
  }
  onMounted(mount);
  onBeforeUnmount(unmount);

  return {
    config,
    connection,
    connectionText: connectionStatus,
    callState,
    callStatusText: callStatus,
    agent,
    agentText: agentStatus,
    extension,
    number,
    feedback,
    busy,
    logs,
    incoming,
    placeholder,
    connected,
    activeCall,
    saveSettings,
    signIn,
    signOut,
    dial,
    hangup,
    hold,
    resume,
    transfer,
    answerCall,
    rejectCall,
    setAgent,
    setBusyUnsupported,
    run,
    clearLog,
    showError,
    clearError,
  };
}
