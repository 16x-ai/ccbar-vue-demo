import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import {
  isTemporarySipFailure,
  migrateApiHost,
  validateApiHost,
  validateSipWs,
} from "./helpers";
import {
  SIP_ERROR_RE,
  SIP_LOG_RE,
  cleanJsSipText,
  sipEventDetail,
  stringifyLog,
  timeStamp,
} from "./logs";
import type {
  LogLevel,
  LogLine,
  LogPanel,
  ServiceStatus,
  SipStatus,
  WorkStatus,
} from "./logs";

const DEFAULT_HOST = "https://call-ng.innopaas.com";
// 与参考页一致：SIP 注册有效期留空按 600 秒，可填 10–3600
const REGISTER_EXPIRES_MIN = 10;
const REGISTER_EXPIRES_MAX = 3600;
const REGISTER_EXPIRES_DEFAULT = 600;
const SETTINGS_KEY = "ccbar.vueDemo.settings";
// 首通保护：刚注册完的一小段时间内平台可能还没准备好（回 480/Unavailable），
// 只在签入后的这个窗口里自动重拨，避免被当成「真的打不通」反复打扰。
const FIRST_CALL_GUARD_MS = 15000;
// SDK 自己会在失败后 800ms 补拨一次；以下是从「首次失败」起算的兜底重拨时刻（毫秒）。
// 平台侧首通 480（Q.850 cause=16）通常几秒内自愈，这几个点能尽早接上。
const CALL_RETRY_DELAYS = [1500, 3000, 6000];
// 参考页的日志 DOM 不设上限；Vue 里留一个足够大的窗口，避免长会话无限增长
const LOG_LIMIT = 500;

export type IncomingCall = { callid: string; callerName: string };

// 页面只直接调用这几个方法，其余按钮由 SDK 按 id 自行绑定（与参考页一致）
type LegacySdk = {
  // SDK 在构造时就固化了这两个（baseUrl = customUrl || isPre 默认域名），
  // 设置里改了 API 主机必须在签入前同步，否则账号接口还打老地址。
  baseUrl?: string;
  options?: Record<string, unknown>;
  getToken(fn: () => Promise<{ token: string; expires: number }>): Promise<unknown>;
  getAccount(): Promise<{ code: number; data?: Record<string, unknown>; message?: string }>;
  login(config: Record<string, unknown>): void;
  // 参考 SDK 没有 destroy()，卸载时只能退签
  signOut?(isLogin?: boolean): void;
  call(number: string): Promise<void>;
  answer(sessionId?: string): void;
  hangup(sessionId?: string): void;
  setError(message: string): void;
  clearError(): void;
  encryptPwd(value: string): string;
};

declare global {
  interface Window {
    CCBarSDK?: new (options: Record<string, unknown>) => LegacySdk;
    JsSIP?: { debug?: { enable(pattern: string): void; disable?(pattern: string): void } };
  }
}

type SavedSettings = {
  host?: string;
  extension?: string;
  appKey?: string;
  appSecret?: string;
  sipWs?: string;
  registerExpires?: number | string;
  sipDebug?: boolean;
};
function loadSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as SavedSettings) : {};
  } catch {
    return {};
  }
}

function legacyTokenRequest(input: {
  host: string;
  extension: string;
  appKey: string;
  appSecret: string;
}) {
  return fetch("/ccbar/get-token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(async (response) => {
    const result = (await response.json()) as {
      code?: number;
      data?: { token?: string; expires?: number };
      message?: string;
    };
    if (!response.ok || result.code !== 0 || !result.data?.token)
      throw new Error(result.message || `获取 token 失败（HTTP ${response.status}）`);
    return { token: result.data.token, expires: Number(result.data.expires) || 600 };
  });
}

function maskWsUrl(url: string): string {
  return String(url || "").replace(/([?&]token=)[^&]*/gi, "$1***");
}

// 与参考页 buildSipWsUrl 一致：软电话 WSS 由账号返回的 domain + wssPort 拼出（443 省略端口）
function buildAccountSipWs(data: Record<string, unknown>): string {
  const host = String(data.domain || "").trim();
  if (!host) return "";
  const port = Number(data.wssPort);
  return `wss://${host}${port && port !== 443 ? `:${port}` : ""}`;
}

// 设置里填了软电话 WSS 就用填的地址，并照 xcall 坐席条把 token 拼进查询串；留空则按账号域名自动拼。
function buildSipTarget(data: Record<string, unknown>, token: string, configured: string): string {
  const base = configured.trim();
  if (!base) return buildAccountSipWs(data);
  const url = new URL(base);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function usePhone() {
  const saved = loadSettings();
  const config = reactive<{
    host: string;
    appKey: string;
    appSecret: string;
    extension: string;
    sipWs: string;
    registerExpires: number | string;
    sipDebug: boolean;
  }>({
    host: migrateApiHost(saved.host || "") || DEFAULT_HOST,
    appKey: saved.appKey || "",
    appSecret: saved.appSecret || "",
    extension: saved.extension || "1000",
    // 留空＝按账号返回的 domain 自动拼（参考页做法）；填了就用填入地址（同 xcall 坐席条）
    sipWs: saved.sipWs || "",
    registerExpires: saved.registerExpires ?? REGISTER_EXPIRES_DEFAULT,
    // 演示亮点：日志面板能看到 REGISTER / INVITE 原文；给客户看时可一键关掉去噪
    sipDebug: saved.sipDebug ?? true,
  });
  const client = shallowRef<LegacySdk>();
  const work = ref<WorkStatus>("offline");
  const service = ref<ServiceStatus>("idle");
  const sip = ref<SipStatus>("unreg");
  // 已接通的会话；用于把 SDK 的 calling 拆成「呼出中 / 通话中」
  const establishedSessions = new Set<string>();
  const inCall = ref(false);
  const extension = ref("");
  const number = ref("");
  const logs = ref<LogLine[]>([]);
  const incoming = ref<IncomingCall[]>([]);
  // 与参考页一致：面板为空时显示占位文案，清空后换成「已清空」
  const placeholder = reactive<Record<LogPanel, string>>({
    flow: "等待签入。签入、取 token、坐席账号会写在这里。",
    sip: "等待话机登录。SIP / JsSIP 日志会写在这里。",
  });
  let logSequence = 0;
  const consoleMethods = new Map<string, (...args: unknown[]) => void>();
  let resolveRegistration: (() => void) | undefined;
  let rejectRegistration: ((error: Error) => void) | undefined;
  // 首通保护用：注册完成时刻 + 本次外呼的重拨时间线
  let registeredAt = 0;
  let callRetry = { target: "", attempt: 0, timer: 0, startedAt: 0, inFlight: false };

  function appendPanelLog(
    panel: LogPanel,
    level: LogLevel,
    source: string,
    message: unknown,
  ) {
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
  // 与参考页 appendFlowLog 一致：来源是 sip / jssip 时改写到 SIP 面板
  function appendFlowLog(level: LogLevel, source: string, message: unknown) {
    appendPanelLog(/^(sip|jssip)$/i.test(source) ? "sip" : "flow", level, source, message);
  }
  function clearLog(panel: LogPanel) {
    logs.value = logs.value.filter((line) => line.panel !== panel);
    placeholder[panel] = panel === "sip" ? "SIP 日志已清空。" : "日志已清空。";
  }

  // 与参考页 hookConsoleToFlowLog 一致，额外在卸载时还原 console
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

  // SIP 原文开关：开＝JsSIP debug + console 钩子（日志面板能看到 REGISTER / INVITE），关＝去噪
  function applySipDebug() {
    if (config.sipDebug) {
      if (consoleMethods.size === 0) hookConsole();
      window.JsSIP?.debug?.enable("*");
      return;
    }
    unhookConsole();
    window.JsSIP?.debug?.disable?.("*");
  }

  function saveSettings() {
    const host = validateApiHost(config.host);
    const sipWs = config.sipWs.trim();
    if (!config.appKey.trim() || !config.appSecret.trim())
      throw new Error("API KEY、API SECRET 均不能为空");
    // 与参考页一致：留空按 600 秒，填了必须是 10–3600 的整数
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
    config.host = host;
    config.extension = config.extension.trim() || "1000";
    config.sipWs = sipWs ? validateSipWs(sipWs) : "";
    config.registerExpires = expires;
    config.sipDebug = Boolean(config.sipDebug);
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...config,
        appKey: config.appKey.trim(),
        appSecret: config.appSecret.trim(),
      }),
    );
  }

  // 清空错误行（SDK 的 clearError 只管 DOM，不会回抛 onError）
  function clearError() {
    if (client.value) client.value.clearError();
    else {
      const el = document.getElementById("____ccbar_errori____");
      if (el) el.textContent = "";
    }
  }

  // 与参考页 showPageError 一致：错误写进 SDK 的错误行，同时进日志（SDK 会回抛 onError）；
  // 传入空消息表示清空，不要兜成「请求失败」。
  function showError(message: unknown) {
    const text = stringifyLog(message).trim();
    if (!text) {
      clearError();
      return;
    }
    if (client.value) client.value.setError(text);
    else {
      const el = document.getElementById("____ccbar_errori____");
      if (el) el.textContent = text;
      appendFlowLog("error", "ccbar", text);
    }
  }

  function createClient() {
    if (!window.CCBarSDK) throw new Error("旧版 CCBarSDK 未加载，请检查 index.html 的 script");
    const url = new URL(config.host);
    const eventHandle = {
      onRequestError: (type: unknown, data: unknown) =>
        appendFlowLog("error", "http", `${stringifyLog(type)} ${stringifyLog(data)}`),
      onError: (message: unknown) => {
        const text = stringifyLog(message);
        if (!text) return;
        appendPanelLog(SIP_ERROR_RE.test(text) ? "sip" : "flow", "error", "ccbar", text);
      },
      onRecviceCall: (caller: string, data?: { callid?: string }) => {
        const callid = data?.callid;
        appendFlowLog("info", "call", `来电 ${stringifyLog(caller)} ${stringifyLog(data)}`);
        if (!callid) {
          appendFlowLog("warn", "call", `来电缺少 callid，无法加入多路列表 ${stringifyLog(data)}`);
          return;
        }
        if (!incoming.value.some((call) => call.callid === callid)) {
          incoming.value = [
            ...incoming.value,
            { callid, callerName: caller || "未知号码" },
          ];
        }
      },
      onStatusChange: (
        workStatus: WorkStatus,
        serviceStatus: ServiceStatus,
        signin: boolean,
        sipStatus: SipStatus,
      ) => {
        work.value = workStatus;
        service.value = serviceStatus;
        sip.value = sipStatus;
        // SDK 回到 idle 说明没有会话了，会话表跟着清空，避免残留导致状态显示错
        if (serviceStatus === "idle") {
          establishedSessions.clear();
          inCall.value = false;
        }
        appendFlowLog(
          "info",
          "status",
          `work=${workStatus} service=${serviceStatus} signin=${signin} sip=${sipStatus}`,
        );
      },
      onWebPhoneHandle: (
        type: string,
        data?: { sessionId?: string; error?: unknown; cause?: string },
      ) => {
        const failed = Boolean(data?.error);
        const level: LogLevel =
          /fail|error/i.test(type) || (type === "ua.disconnected" && failed)
            ? "error"
            : type === "reg.registered" ||
                type === "ua.connected" ||
                type === "user.signout"
              ? "ok"
              : "info";
        const detail = sipEventDetail(data);
        appendPanelLog("sip", level, "sip", type + (detail ? ` ${detail}` : ""));
        if (type === "reg.registered") {
          registeredAt = Date.now();
          resolveRegistration?.();
        }
        if (type === "reg.failed" || (type === "ua.disconnected" && failed))
          rejectRegistration?.(new Error("SIP 注册失败"));
        if (type === "user.signout") {
          extension.value = "";
          registeredAt = 0;
          cancelCallRetry();
          callRetry.inFlight = false;
        }
        const sessionId = data?.sessionId;
        // 会话接通 / 结束：跟着更新「是否在通话中」（与 fork 版 talking 语义一致）
        const answered = type === "outgoing.accepted" || type === "incoming.accepted";
        const finished = /^(outgoing|incoming)\.(ended|failed|cancel)$/.test(type);
        if (sessionId && answered) establishedSessions.add(sessionId);
        if (sessionId && finished) establishedSessions.delete(sessionId);
        if (answered || finished) {
          inCall.value = establishedSessions.size > 0;
          if (answered) cancelCallRetry();
        }
        // 首通保护：电话有动静就说明在拨了，停掉重拨；失败则按「暂时不可用」排重拨
        if (
          type === "outgoing.retry" ||
          type === "outgoing.progress" ||
          type === "outgoing.accepted" ||
          type === "incoming.notify"
        ) {
          callRetry.inFlight = true;
          cancelCallRetry();
        }
        if (finished) callRetry.inFlight = false;
        if (type === "outgoing.failed") scheduleCallRetry(data?.cause);
        if (
          sessionId &&
          (type === "incoming.ended" || type === "incoming.failed" || type === "incoming.accepted")
        ) {
          incoming.value = incoming.value.filter((call) => call.callid !== sessionId);
        }
      },
    };
    client.value = new window.CCBarSDK({
      customUrl: `${url.host}/openapi/token/v1`,
      isHttp: url.protocol === "http:",
      isPre: false,
      debug: true,
      useExtraErrorHandle: true,
      outgoingType: "hand",
      eventHandle,
    });
  }

  // 与参考页一致：页面加载完成就建好 SDK，通话按钮由 SDK 按 id 绑定
  function mount() {
    applySipDebug();
    try {
      createClient();
    } catch (error) {
      showError(error);
      return;
    }
    appendFlowLog("info", "app", "页面已就绪");
  }
  function unmount() {
    unhookConsole();
    cancelCallRetry();
    try {
      client.value?.signOut?.();
    } catch {
      /* 页面卸载时的退签失败无需处理 */
    }
    client.value = undefined;
  }
  onMounted(mount);
  onBeforeUnmount(unmount);
  // 设置里勾掉/勾上要立刻生效，不用刷新页面
  watch(() => config.sipDebug, applySipDebug);

  async function signIn() {
    if (!client.value) throw new Error("CCBarSDK 未就绪，请刷新页面");
    saveSettings();
    const instance = client.value;
    // 让坐席账号等接口跟着「API 主机」走：{API主机}/openapi/token/v1/...
    const apiUrl = new URL(config.host);
    instance.baseUrl = `${apiUrl.host}/openapi/token/v1`;
    if (instance.options) instance.options.isHttp = apiUrl.protocol === "http:";
    appendFlowLog(
      "info",
      "http",
      `坐席账号接口 ${apiUrl.protocol}//${instance.baseUrl}`,
    );
    const registration = new Promise<void>((resolve, reject) => {
      resolveRegistration = resolve;
      rejectRegistration = reject;
      window.setTimeout(
        () => reject(new Error("SIP 注册超时，请检查软电话 WSS 配置")),
        20000,
      );
    });
    try {
      const token = await instance.getToken(() =>
        legacyTokenRequest({
          host: config.host,
          extension: config.extension,
          appKey: config.appKey,
          appSecret: config.appSecret,
        }),
      );
      const account = await instance.getAccount();
      if (account.code !== 0 || !account.data)
        throw new Error(account.message || "获取坐席账号失败");
      const data = account.data;
      // 与参考页一致：账号必须带 username/domain（软电话地址留空时由 domain 拼）
      const username = String(data.username || "").trim();
      const domain = String(data.domain || "").trim();
      if (!username || !domain) throw new Error("坐席账号缺少 username/domain，无法连接话机");
      const accessToken = String((token as { token?: string } | undefined)?.token || "");
      const wsUrl = buildSipTarget(data, accessToken, config.sipWs);
      const wsUrlPath = config.sipWs.trim() ? new URL(wsUrl).pathname : "";
      const wsHost = wsUrl ? new URL(wsUrl).hostname : domain;
      // 与 xcall 坐席条一致：账号 domain 不是 callapi-ng 时以它为准，否则跟随软电话 WSS 的主机
      const sipDomain =
        domain && !/callapi-ng\.innopaas\.com$/i.test(domain) ? domain : wsHost;
      const customerPrefix = String(data.customerPrefix || "").trim();
      const registerExpires = Number(config.registerExpires) || REGISTER_EXPIRES_DEFAULT;
      instance.login({
        url: domain,
        sipDomain,
        wsHost,
        wsUrl,
        wsPath: wsUrlPath,
        username,
        password: instance.encryptPwd(String(data.password || "")),
        type: "userinfo",
        turnPort: data.turnPort,
        turnIp: data.turnIp,
        apiKey: data.apiKey,
        register: true,
        prefix: customerPrefix,
        wssPort: data.wssPort,
        wsPort: data.wsPort,
        useWss: true,
        token: accessToken,
        registerExpires,
        registerExpries: registerExpires,
      });
      // 与参考页一致：坐席条显示账号全号（customerPrefix + 内部分机）
      extension.value = username;
      appendFlowLog(
        "info",
        "sip",
        `开始登录话机 username=${username} uri=sip:${username}@${sipDomain} ws=${maskWsUrl(wsUrl)} expires=${registerExpires}`,
      );
      appendPanelLog(
        "sip",
        "info",
        "sip",
        "开始登录话机 " +
          stringifyLog({
            uri: `sip:${username}@${sipDomain}`,
            ws: maskWsUrl(wsUrl),
            username,
            registerExpires,
          }),
      );
      await registration;
    } finally {
      resolveRegistration = undefined;
      rejectRegistration = undefined;
    }
  }

  function cancelCallRetry() {
    if (callRetry.timer) window.clearTimeout(callRetry.timer);
    callRetry.timer = 0;
  }

  // 排出下一次兜底重拨；时间点从「首次失败」起算，不因中间的失败层层顺延。
  function planNextCallRetry() {
    const offset = CALL_RETRY_DELAYS[callRetry.attempt];
    if (offset == null) return;
    const delay = Math.max(0, callRetry.startedAt + offset - Date.now());
    callRetry.timer = window.setTimeout(() => {
      callRetry.timer = 0;
      callRetry.attempt += 1;
      // 已经有呼叫在走（自己的或 SDK 的）就跳过这一次，只保留后面的时间点
      if (callRetry.inFlight) {
        planNextCallRetry();
        return;
      }
      appendFlowLog(
        "warn",
        "sip",
        `呼叫暂时不可用，自动重拨（第 ${callRetry.attempt} 次）${callRetry.target}`,
      );
      callRetry.inFlight = true;
      void client.value?.call(callRetry.target);
      planNextCallRetry();
    }, delay);
  }

  // 首通保护：平台在注册刚完成后会对首个 INVITE 回 480（Q.850 cause=16），
  // 只在签入窗口内兜底重拨，呼叫一起来就停。
  function scheduleCallRetry(cause: unknown) {
    if (!callRetry.target || !isTemporarySipFailure(cause)) return;
    if (Date.now() - registeredAt > FIRST_CALL_GUARD_MS) return;
    if (callRetry.timer || callRetry.attempt > 0) return; // 时间线已排好，不叠加
    callRetry.startedAt = Date.now();
    appendFlowLog(
      "warn",
      "sip",
      `呼叫暂时不可用（${stringifyLog(cause)}），${CALL_RETRY_DELAYS.map((ms) => `${ms / 1000}s`).join(" / ")} 处自动重拨`,
    );
    planNextCallRetry();
  }

  // 与参考页 callPhone 一致：号码校验和「未连接 / 休息状态」提示都在 SDK 里
  function callNumber() {
    cancelCallRetry();
    const target = number.value;
    callRetry = { target, attempt: 0, timer: 0, startedAt: 0, inFlight: true };
    void client.value?.call(target);
  }
  // 与参考页来电浮层的接听 / 拒接一致：操作后即从列表移除
  function answerCall(callid: string) {
    client.value?.answer(callid);
    incoming.value = incoming.value.filter((call) => call.callid !== callid);
  }
  function rejectCall(callid: string) {
    client.value?.hangup(callid);
    incoming.value = incoming.value.filter((call) => call.callid !== callid);
  }

  return {
    config,
    work,
    service,
    sip,
    inCall,
    extension,
    number,
    logs,
    incoming,
    placeholder,
    saveSettings,
    signIn,
    callNumber,
    answerCall,
    rejectCall,
    clearLog,
    showError,
    clearError,
  };
}
