/**
 * 页面的全部逻辑：签入 / 通话 / 日志 / 状态。
 *
 * 用法（见 App.vue）：
 *   const phone = usePhone();          // 组件 setup 里调用一次
 *   模板里绑 phone.xxx.value           // 状态是 ref，动作是函数
 *
 * 它做三件事：
 *   1. 建一个 CCBarClient（会话来源见 session.ts）并把 SDK 事件翻译成页面状态与日志；
 *   2. 把「按钮点击」变成 SDK 调用（签入、外呼、保持、转接……）；
 *   3. 维护两个日志面板的数据。
 */

import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { CCBarClient } from "@16x/webphone-sdk";
import type { CCBarCall, CCBarClientOptions } from "@16x/webphone-sdk";
import { shortExtension } from "./helpers";
import {
  agentStatus,
  callStatus,
  connectionStatus,
  isTemporarySipFailure,
  sipEventDetail,
  stringifyLog,
  timeStamp,
} from "./logs";
import type { AgentState, CallState, ConnectionState, LogLevel, LogLine, LogPanel } from "./logs";
import {
  SEAT_STATUS_TEXT,
  createLegacySessionProvider,
  createTokenProvider,
  isLegacyPlatform,
  setSeatStatus,
} from "./session";
import type { SeatAccount } from "./session";
import { createConfig, normalizeConfig, persistConfig } from "./settings";
import type { PhoneConfig } from "./settings";
import { enableJsSipDebug } from "./sipDebug";

/** 来电浮层里的一路来电 */
export type IncomingCall = { callid: string; callerName: string };

// 日志最多留多少行：参考页的 DOM 不设上限，Vue 里给个上限避免长会话把内存撑大
const LOG_LIMIT = 500;

// 首通保护：平台在每次注册刚完成时的第一个外呼会回 480（暂时不可用），几秒内自愈。
// 只在签入后的这个时间窗里兜底重拨，避免把真正的失败也一遍遍重试。
const FIRST_CALL_GUARD_MS = 15000;
const CALL_RETRY_DELAYS = [1500, 3000, 6000];

// 可选：WebPhone API 的基地址。留空＝同源，由 Vite / nginx 把 /webphone/v1/* 转给平台
function webphoneBaseUrl(): string {
  return String(import.meta.env?.VITE_WEBPHONE_API_BASE || "")
    .trim()
    .replace(/\/+$/, "");
}

export function usePhone() {
  // ---------- 状态 ----------
  const config = reactive<PhoneConfig>(createConfig());
  const client = shallowRef<CCBarClient>();
  const connection = ref<ConnectionState | "registered">("offline");
  const callState = ref<CallState | "idle">("idle");
  const agent = ref<AgentState>("offline");
  /** 当前分机（签入成功后显示在标题右边） */
  const extension = ref("");
  /** 「号码」输入框的内容：外呼 / 内呼 / 转接都用它 */
  const number = ref("");
  /** 页面上那一行红色错误提示 */
  const feedback = ref("");
  /** 正在执行的动作名，用来禁用按钮防重复点击 */
  const busy = ref("");
  const logs = ref<LogLine[]>([]);
  const incoming = ref<IncomingCall[]>([]);
  const placeholder = reactive<Record<LogPanel, string>>({
    flow: "等待签入。签入、取 Token、坐席账号会写在这里。",
    sip: "等待话机登录。连接与通话事件会写在这里。",
  });

  const connected = computed(
    () => connection.value === "registered" || connection.value === "connected",
  );

  // ---------- 内部记账 ----------
  let logSequence = 0;
  let unsubscribeSipDebug: (() => void) | undefined;
  const subscriptions: Array<() => void> = [];
  let registeredAt = 0;
  /** 网关是旧平台还是新平台（构建时决定，见 session.ts） */
  const legacyPlatform = isLegacyPlatform();
  /** 旧平台账号里的分机前缀，显示分机时要去掉 */
  let customerPrefix = "";
  let activeCallId = "";
  let callRetry = { target: "", attempt: 0, timer: 0, startedAt: 0, inFlight: false };

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
  /** 写流程日志；来源是 sip/jssip 时自动落到 SIP 面板（与参考页一致） */
  function appendFlowLog(level: LogLevel, source: string, message: unknown) {
    appendPanelLog(/^(sip|jssip)$/i.test(source) ? "sip" : "flow", level, source, message);
  }
  function clearLog(panel: LogPanel) {
    logs.value = logs.value.filter((line) => line.panel !== panel);
    placeholder[panel] = panel === "sip" ? "SIP 日志已清空。" : "日志已清空。";
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
  /**
   * 保存设置：校验 → 写盘。
   * 校验失败会抛错，由页面显示到错误行（App.vue 的 saveSettings）。
   */
  function saveSettings() {
    const next = normalizeConfig(config);
    Object.assign(config, next);
    persistConfig(next);
  }

  // ---------- 通话状态 ----------
  /** 从 SDK 的通话列表里挑出「当前这一路」，页面状态标签与按钮都用它 */
  function refreshCallState() {
    const calls = client.value?.getCalls() ?? [];
    const active = client.value?.getActiveCall();
    // 来电在接通之前不算 active call，所以退回到第一路还没结束的通话
    const target =
      active ?? calls.find((call) => call.state !== "ended" && call.state !== "failed");
    activeCallId = target?.id ?? "";
    callState.value = target ? target.state : "idle";
  }
  function currentCall(): CCBarCall | undefined {
    return client.value?.getActiveCall() ?? client.value?.getCalls().find((call) => call.id === activeCallId);
  }
  function removeIncoming(callId: string) {
    incoming.value = incoming.value.filter((call) => call.callid !== callId);
  }

  // ---------- 首通保护：注册后第一个外呼回 480 时兜底重拨 ----------
  function armAutoRedial(target: string) {
    callRetry.target = target;
    callRetry.attempt = 0;
    callRetry.startedAt = Date.now();
    appendFlowLog(
      "warn",
      "sip",
      `呼叫暂时不可用，${CALL_RETRY_DELAYS.map((ms) => `${ms / 1000}s`).join(" / ")} 处自动重拨`,
    );
    planNextRetry();
  }
  function planNextRetry() {
    const offset = CALL_RETRY_DELAYS[callRetry.attempt];
    if (offset == null) return;
    // 从「第一次失败」起算固定时间点，前面的尝试花掉的时间不算在内
    const delay = Math.max(0, callRetry.startedAt + offset - Date.now());
    callRetry.timer = window.setTimeout(() => {
      callRetry.timer = 0;
      callRetry.attempt += 1;
      // 已经有呼叫在走（用户手动重拨成功）就跳过这个时间点
      if (callRetry.inFlight) {
        planNextRetry();
        return;
      }
      appendFlowLog("warn", "sip", `自动重拨（第 ${callRetry.attempt} 次）${callRetry.target}`);
      callRetry.inFlight = true;
      void dial(callRetry.target).catch(() => undefined);
      planNextRetry();
    }, delay);
  }
  function stopAutoRedial() {
    if (callRetry.timer) window.clearTimeout(callRetry.timer);
    callRetry.timer = 0;
  }

  // ---------- 动作：给页面按钮调用 ----------
  /** 统一包一层：防重复点击、清掉上一次的错误、结束刷新通话状态 */
  async function run(name: string, action: () => unknown | Promise<unknown>) {
    if (busy.value) return;
    busy.value = name;
    clearError();
    try {
      await action();
    } catch (error) {
      // dial / answer 在未连接时是同步抛错，所以 try 必须包住调用本身
      showError(error instanceof Error ? error.message : error);
    } finally {
      busy.value = "";
      refreshCallState();
    }
  }

  async function signIn() {
    // 先保存：设置里换过平台形态的话会重建客户端，所以实例要在保存之后再取
    saveSettings();
    const instance = client.value;
    if (!instance) throw new Error("SDK 未就绪，请刷新页面");
    extension.value = config.extension;
    appendFlowLog("info", "sip", `开始签入 extension=${config.extension} host=${config.host}`);
    // 后面 SDK 会自己走 tokenProvider / sessionProvider 去拿会话，再发 REGISTER
    await instance.connect({ extension: config.extension });
  }

  async function signOut() {
    stopAutoRedial();
    callRetry.inFlight = false;
    await client.value?.disconnect();
    // 与旧版一致：退签时把坐席置为「退出登录」，否则平台上还挂着这个坐席。
    // 只是告知平台，失败不阻塞退签（页面状态照旧清空）
    if (legacyPlatform) {
      const [status, reason] = SEAT_STATUS_TEXT.offline;
      void setSeatStatus(config, status, reason, appendFlowLog).catch((error: unknown) => {
        appendFlowLog("warn", "seat", `置离线失败：${error instanceof Error ? error.message : error}`);
      });
    }
    connection.value = "offline";
    agent.value = "offline";
    callState.value = "idle";
    extension.value = "";
    incoming.value = [];
  }

  /** 外呼；extensionCall=true 时是内呼（SDK 会按平台的内部呼叫方式处理） */
  async function dial(destination: string, extensionCall = false) {
    const instance = client.value;
    if (!instance) throw new Error("请先签入");
    stopAutoRedial();
    callRetry = { target: destination, attempt: 0, timer: 0, startedAt: 0, inFlight: true };
    appendFlowLog(
      "info",
      "sip",
      `${extensionCall ? "内呼" : "外呼"} ${destination}${extensionCall ? "（type=extension）" : ""}`,
    );
    await instance.dial(extensionCall ? { destination, type: "extension" } : { destination });
  }

  async function hangup() {
    await currentCall()?.hangup();
  }
  async function hold() {
    await currentCall()?.hold();
  }
  async function resume() {
    await currentCall()?.resume();
  }
  async function transfer(target: string) {
    const call = currentCall();
    if (!call) throw new Error("没有可转接的通话");
    await call.transfer({ type: "blind", target });
  }
  async function answerCall(callId: string) {
    await client.value?.answer(callId);
    removeIncoming(callId);
    // 浏览器可能拦掉自动播放：在用户点击的这一次手势里手动放一下远端声音
    void client.value?.media?.playRemoteAudio?.(callId).catch(() => undefined);
  }
  async function rejectCall(callId: string) {
    const call = client.value?.getCalls().find((item) => item.id === callId);
    await call?.reject({ reason: "已拒接" });
    removeIncoming(callId);
  }
  /** 空闲 / 休息：走 SDK 的 setAgentStatus（最终由会话来源落到平台接口） */
  async function setAgent(status: "available" | "break") {
    await client.value?.setAgentStatus(status);
    agent.value = status;
  }

  /**
   * 置忙：SDK 的 setAgentStatus 只有 空闲 / 休息 / 离线，没有「忙碌」，
   * 所以页面直接调服务端的坐席状态接口（平台侧是 On Break + reason=忙碌）。
   */
  async function setBusy() {
    if (!legacyPlatform) {
      showError("新平台形态请在平台侧管理坐席状态（当前 SDK 只提供 空闲 / 休息）");
      return;
    }
    const [status, reason] = SEAT_STATUS_TEXT.busy;
    await setSeatStatus(config, status, reason, appendFlowLog);
    agent.value = "busy";
  }

  // ---------- SDK 事件 → 页面状态 + 日志 ----------
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
        // 坐席账号可能带企业前缀，显示时去掉（参考页 shortExtension）
        extension.value = shortExtension(account, customerPrefix);
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
        appendPanelLog("sip", event.to === "failed" ? "error" : "info", "call", `call.stateChanged ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.activeChanged", (event) => {
        appendFlowLog("info", "call", `call.activeChanged ${sipEventDetail(event)}`);
        refreshCallState();
      }),
      instance.on("call.ended", (event) => {
        appendFlowLog("info", "call", `呼叫结束 ${sipEventDetail(event)}`);
        removeIncoming(event.callId);
        stopAutoRedial();
        callRetry.inFlight = false;
        refreshCallState();
      }),
      instance.on("call.failed", (event) => {
        appendFlowLog("error", "call", `呼叫失败 ${sipEventDetail(event)}`);
        removeIncoming(event.callId);
        callRetry.inFlight = false;
        showError(event.error.message);
        // 刚签入就碰到「暂时不可用」：按固定时间点兜底重拨一次
        const inGuardWindow = Date.now() - registeredAt <= FIRST_CALL_GUARD_MS;
        if (callRetry.target && inGuardWindow && isTemporarySipFailure(event.error)) {
          armAutoRedial(callRetry.target);
        }
        refreshCallState();
      }),
      instance.on("error", (event) => {
        appendFlowLog("error", "ccbar", `SDK 错误 ${sipEventDetail(event)}`);
        showError(event.error.message);
      }),
    );
  }

  // ---------- 客户端生命周期 ----------
  function createClient(): CCBarClient {
    const baseUrl = webphoneBaseUrl();
    const options: CCBarClientOptions = {
      locale: "zh-CN",
      platform: "web",
      ...(baseUrl ? { baseUrl } : {}),
      // 演示页单标签页，不启用 SharedWorker
      sharedWorker: { enabled: false, fallback: "single-tab" },
    };
    if (legacyPlatform) {
      // 旧平台：会话由我们自己的服务端拼好（server/get-session.js）
      const provider = createLegacySessionProvider(config, appendFlowLog, (account: SeatAccount) => {
        customerPrefix = String(account.customerPrefix || "");
        appendFlowLog(
          "ok",
          "seat",
          `坐席账号就绪 ${stringifyLog({ username: account.username, prefix: account.customerPrefix || "-" })}`,
        );
      });
      return new CCBarClient({ ...options, sessionProvider: provider });
    }
    // 新平台：SDK 拿 token 去换会话
    return new CCBarClient({ ...options, tokenProvider: createTokenProvider(config, appendFlowLog) });
  }

  function mount() {
    // 必须在 SDK 第一次 connect（懒加载 JsSIP）之前打开 SIP 原文
    unsubscribeSipDebug = enableJsSipDebug((level, text) => appendPanelLog("sip", level, "jssip", text));
    try {
      client.value = createClient();
    } catch (error) {
      // 例如 SDK 版本太老、没有旧平台需要的 sessionProvider：提示清楚，别白屏
      client.value = undefined;
      showError(error instanceof Error ? error.message : error);
      return;
    }
    subscribe(client.value);
    appendFlowLog(
      "info",
      "app",
      `页面已就绪，等待签入（会话来源：${legacyPlatform ? "旧平台 seat/account/get" : "新平台 webphone/v1"}）`,
    );
  }

  function disposeClient() {
    for (const off of subscriptions.splice(0)) off();
    void client.value?.dispose();
    client.value = undefined;
  }

  function unmount() {
    disposeClient();
    stopAutoRedial();
    unsubscribeSipDebug?.();
    unsubscribeSipDebug = undefined;
  }

  onMounted(mount);
  onBeforeUnmount(unmount);

  return {
    // 设置
    config,
    saveSettings,
    // 状态
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
    connected,
    incoming,
    logs,
    placeholder,
    // 动作
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
    setBusy,
    clearLog,
    run,
    showError,
    clearError,
  };
}
