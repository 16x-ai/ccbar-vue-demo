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
import { normalizeUserdata, prefixExtension, shortExtension } from "./helpers";
import {
  agentStatus,
  callStatus,
  connectionStatus,
  isLocalFailure,
  messageText,
  sipEventDetail,
  stringifyLog,
  timeStamp,
} from "./logs";
import type { AgentState, CallState, ConnectionState, LogLevel, LogLine, LogPanel } from "./logs";
import {
  SEAT_STATUS_TEXT,
  createSessionProvider,
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

// 已知平台行为：每次注册完成后的**第一次外呼**会被回 480（Q.850 cause=16），几秒内自愈。
// 这是平台侧的毛病，页面**不兜底、不自动重拨**：照常提示失败，由坐席自己再拨一次。

// 自定义参数：外呼 / 内呼时随 INVITE 带上 X-User-Data 头，由平台/服务端从 SIP 报文里读
//（页面侧读不到 —— SDK 不暴露 SIP 头）。**改这里就行**：每个接入方要传的内容不一样，
// 所以不做成设置项。
//
//   留空      = 不带这个头（默认）
//   只能可见 ASCII —— 换行会构成 SIP 头注入，中文等非 ASCII 不合规。
//              要传中文/JSON 就先编码，平台侧解回来：encodeURIComponent(JSON.stringify(ctx))
//
// 需要「同一页面上按通话传不同参数」时，把它改成函数或给 dial 加参数即可。
const USERDATA = "";

// SIP 保活间隔（秒）。平台侧的注册有效期是 600 秒，这里也设 600：
// 等于不再额外发心跳，只由 JsSIP 在注册到期前续一次（约每 10 分钟一个 REGISTER）。
// 注意：这样 SIP 通道空闲时没有任何报文，nginx 默认 60 秒空闲会断开长连接
//（表现为「显示已注册但呼叫失败」）——除非把反向代理的 read timeout 放到 600 秒以上。
// 需要更密的保活就把 VITE_SIP_KEEPALIVE 设成 25（或 0 关闭）。
function sipKeepaliveSeconds(): number {
  const raw = String(import.meta.env?.VITE_SIP_KEEPALIVE ?? "").trim();
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 600;
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
  /** 全屏加载提示文案（空＝不显示）：签入、设置坐席状态这类要等服务的操作会用它 */
  const loading = ref("");
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
  /** 坐席前缀（customerPrefix）：标题栏要和分机一起显示，内呼时也要拼在号码前 */
  const customerPrefix = ref("");
  /** 平台认的坐席账号（取回会话后才知道，可能带企业前缀）；置忙 / 退签要用它 */
  let seatAccount = config.extension;
  let activeCallId = "";
  /** 上一次记过的通话快照：只在变化时写日志（见 refreshCallState） */
  let lastCallSnapshot = "";

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
    // 红字行给人看（错误码换成中文，见 logs.ts 的 errorText），日志里留原文给排障
    feedback.value = messageText(text);
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

    // 排障：标签只显示上面这一路的状态。出问题时（内呼的回调腿接通了、拨出去那一腿还挂着 ringing，
    // 或者某一路的状态压根没往前走）光看标签不知道说的是哪一路，所以把 SDK 里此刻的通话列表
    // 一并记下来 —— 只在快照变化时写一行，不刷屏。
    const view = `通话列表 ${stringifyLog({
      active: active?.id ?? null,
      target: target?.id ?? null,
      calls: calls.map((call) => `${call.id} ${call.state} ${call.destination}`),
    })}`;
    if (view !== lastCallSnapshot) {
      lastCallSnapshot = view;
      appendFlowLog("info", "call", view);
    }
  }
  function currentCall(): CCBarCall | undefined {
    return client.value?.getActiveCall() ?? client.value?.getCalls().find((call) => call.id === activeCallId);
  }
  function removeIncoming(callId: string) {
    incoming.value = incoming.value.filter((call) => call.callid !== callId);
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
    // 取会话 → 连 WSS → REGISTER 要几秒，期间盖全屏遮罩，别让人以为卡住了
    loading.value = "正在签入…";
    try {
      // SDK 会走 sessionProvider 拿会话，再发 REGISTER；坐席身份由服务端按登录态决定
      await instance.connect();
    } finally {
      loading.value = "";
    }
  }

  async function signOut() {
    await client.value?.disconnect();
    // 与旧版一致：退签时把坐席置为「退出登录」，否则平台上还挂着这个坐席。
    // 只是告知平台，失败不阻塞退签（页面状态照旧清空）
    const [status, reason] = SEAT_STATUS_TEXT.offline;
    void setSeatStatus(config, seatAccount, status, reason, appendFlowLog).catch((error: unknown) => {
      appendFlowLog("warn", "seat", `置离线失败：${error instanceof Error ? error.message : error}`);
    });
    connection.value = "offline";
    agent.value = "offline";
    callState.value = "idle";
    extension.value = "";
    customerPrefix.value = "";
    incoming.value = [];
  }

  /**
   * 真正拨出去：外呼与内呼都走这里。
   * 内呼在旧平台上的含义就是「企业前缀 + 分机号」（参考实现 insideCall 的拼法），
   * 不能只靠 SDK 的 type=extension —— 那只是在 INVITE 上加一个平台不认的头。
   */
  async function startCall(destination: string, extensionCall = false) {
    const instance = client.value;
    if (!instance) throw new Error("请先签入");
    // 常量先过一道校验：写错了（中文/换行）就在红字行给中文提示，别把 SDK 的错误码丢出来
    const data = normalizeUserdata(USERDATA);
    const target = extensionCall ? prefixExtension(destination, customerPrefix.value) : destination;
    const note = extensionCall && target !== destination ? `（拼前缀 ${customerPrefix.value}）` : "";
    const withData = data ? `（X-User-Data: ${data}）` : "";
    appendFlowLog(
      "info",
      "sip",
      `${extensionCall ? "内呼" : "外呼"} ${target}${note}${withData}（话机连接=${connection.value}）`,
    );
    await instance.dial({ destination: target, ...(data ? { userdata: data } : {}) });
  }

  /** 用户点「外呼 / 内呼」 */
  async function dial(destination: string, extensionCall = false) {
    await startCall(destination, extensionCall);
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
    loading.value = "正在设置坐席状态…";
    try {
      await client.value?.setAgentStatus(status);
    } finally {
      loading.value = "";
    }
    agent.value = status;
  }

  /**
   * 置忙：SDK 的 setAgentStatus 只有 空闲 / 休息 / 离线，没有「忙碌」，
   * 所以页面直接调服务端的坐席状态接口（平台侧是 On Break + reason=忙碌）。
   */
  async function setBusy() {
    const [status, reason] = SEAT_STATUS_TEXT.busy;
    loading.value = "正在设置坐席状态…";
    try {
      await setSeatStatus(config, seatAccount, status, reason, appendFlowLog);
    } finally {
      loading.value = "";
    }
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
        // 与旧版一致：注册成功即视为坐席「在线」（平台侧状态由服务端维护，这里只是本地标记）。
        // 重连后再次注册时不覆盖，免得把页面上的「忙碌 / 休息」冲掉
        if (agent.value === "offline") agent.value = "available";
        const account = instance.getAgent()?.extension || config.extension;
        // 坐席账号可能带企业前缀，显示时去掉（参考页 shortExtension）
        extension.value = shortExtension(account, customerPrefix.value);
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
        refreshCallState();
      }),
      instance.on("call.failed", (event) => {
        // 本机自己结束的（挂断 / 拒接 / 振铃中取消）不算失败：老 ccbar 就是这个规则
        //（`if (data.originator !== 'local') setError('呼叫失败')`）——点了挂断却弹一句
        // 「呼叫失败 / CALL_OPERATION_NOT_ALLOWED」就是这么来的。
        const local = isLocalFailure(event.error);
        if (local) {
          appendFlowLog("info", "call", `本机结束呼叫 ${sipEventDetail(event)}`);
        } else {
          appendFlowLog("error", "call", `呼叫失败 connection=${connection.value} ${sipEventDetail(event)}`);
        }
        // 只有「UA 的 WebSocket 已经没了」这一种情况才提示重签（JsSIP 抛 InvalidStateError/NotConnected）；
        // 平台回的 480 之类也会被 SDK 归到这个错误码上，不能一概而论
        const cause = (event.error as { cause?: { name?: string; message?: string } }).cause;
        const transportGone = /InvalidStateError|NotConnected|not connected/i.test(
          `${cause?.name ?? ""} ${cause?.message ?? ""}`,
        );
        if (!local && event.error.code === "CALL_OPERATION_NOT_ALLOWED" && transportGone) {
          appendFlowLog("warn", "sip", "话机连接可能已断开：请点退签再签入后重试");
        }
        removeIncoming(event.callId);
        if (!local) showError(event.error.message);
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
    const options: CCBarClientOptions = {
      locale: "zh-CN",
      platform: "web",
      // 与页面设置里的「SIP 注册有效期」一致：由 JsSIP 自己续注册，不再叠心跳
      sipKeepaliveSeconds: sipKeepaliveSeconds(),
      // 演示页单标签页，不启用 SharedWorker
      sharedWorker: { enabled: false, fallback: "single-tab" },
    };
    // 会话由我们自己的服务端拼好（server/get-session.js）
    const provider = createSessionProvider(config, appendFlowLog, (account: SeatAccount) => {
      customerPrefix.value = String(account.customerPrefix || "");
      seatAccount = String(account.username || seatAccount);
      appendFlowLog(
        "ok",
        "seat",
        `坐席账号就绪 ${stringifyLog({ username: account.username, prefix: account.customerPrefix || "-" })}`,
      );
    });
    return new CCBarClient({ ...options, sessionProvider: provider });
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
      "页面已就绪，等待签入",
    );
  }

  function disposeClient() {
    for (const off of subscriptions.splice(0)) off();
    void client.value?.dispose();
    client.value = undefined;
  }

  function unmount() {
    disposeClient();
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
    customerPrefix,
    number,
    feedback,
    busy,
    loading,
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
