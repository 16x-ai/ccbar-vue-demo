<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { usePhone } from "./lib/usePhone";

const phone = usePhone();
const settingsOpen = ref(false);
const logPanel = ref<"flow" | "sip">("flow");
const logBody = ref<HTMLElement>();
const activeLog = computed(() => phone.logs.value.filter((line) => line.panel === logPanel.value));
const logPlaceholder = computed(() => phone.placeholder[logPanel.value]);

const agentLabel = computed(() => phone.agentText[phone.agent.value]);
const callLabel = computed(() => phone.callStatusText[phone.callState.value]);
const connectionLabel = computed(() => phone.connectionText[phone.connection.value]);
// 有未结束的通话（含未接听的来电）——用来决定通话那一行按钮的可用性
const hasCall = computed(
  () => !["idle", "ended", "failed"].includes(phone.callState.value),
);

// 与参考页 appendPanelLog 一致：新日志写入后滚到底部
watch([() => phone.logs.value.length, logPanel], () => {
  void nextTick(() => {
    const el = logBody.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});

function saveSettings() {
  try {
    phone.saveSettings();
    settingsOpen.value = false;
    phone.clearError();
  } catch (error) {
    phone.showError(error instanceof Error ? error.message : String(error));
  }
}
</script>

<template>
  <div class="page">
    <div class="____ccbar____">
      <div class="bar-head">
        <div>
          <strong>CC Bar</strong>
          <span> · Vue 嵌入示例</span>
        </div>
        <div class="bar-head-right">
          <span v-if="phone.extension.value" id="ccbar-extension" class="ext-chip"
            >分机 <b>{{ phone.extension.value }}</b></span
          >
          <button type="button" id="ccbar-settings-btn" aria-label="设置" @click="settingsOpen = true">
            设置
          </button>
        </div>
      </div>

      <div class="bar-row">
        <div class="k">状态</div>
        <div class="chips">
          <span class="ccbar_status" :class="`ccbar_work_status_${agentLabel.tone}`">{{
            agentLabel.text
          }}</span>
          <span class="ccbar_status" :class="`ccbar_serv_status_${callLabel.tone}`">{{
            callLabel.text
          }}</span>
          <span class="ccbar_status" :class="`ccbar_sip_status_${connectionLabel.tone}`">{{
            connectionLabel.text
          }}</span>
        </div>
      </div>

      <div class="bar-row">
        <div class="k">号码</div>
        <input
          id="____ccbar_numb_input____"
          v-model="phone.number.value"
          class="ccbar_number_input"
          placeholder="输入号码后外呼或转接"
          autocomplete="off"
        />
      </div>

      <div class="bar-row">
        <div class="k">签入</div>
        <div class="btns">
          <button
            type="button"
            id="____ccbar_signin____"
            class="ccbar_items btn-primary"
            :disabled="!!phone.busy.value || phone.connected.value"
            @click="phone.run('签入', phone.signIn)"
          >
            签入
          </button>
          <button
            type="button"
            id="____ccbar_signou____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || !phone.connected.value"
            @click="phone.run('退签', phone.signOut)"
          >
            退签
          </button>
        </div>
      </div>

      <div class="bar-row">
        <div class="k">通话</div>
        <div class="btns">
          <button
            type="button"
            class="ccbar_items"
            :disabled="!!phone.busy.value || !phone.connected.value || !phone.number.value.trim()"
            @click="phone.run('外呼', () => phone.dial(phone.number.value))"
          >
            外呼
          </button>
          <button
            type="button"
            id="____ccbar_inside____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || !phone.connected.value || !phone.number.value.trim()"
            @click="phone.run('内呼', () => phone.dial(phone.number.value, true))"
          >
            内呼
          </button>
          <button
            type="button"
            id="____ccbar_hangup____"
            class="ccbar_items btn-danger"
            :disabled="!!phone.busy.value || !hasCall"
            @click="phone.run('挂断', phone.hangup)"
          >
            挂断
          </button>
          <button
            type="button"
            id="____ccbar_transo____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || !hasCall || !phone.number.value.trim()"
            @click="phone.run('转接', () => phone.transfer(phone.number.value))"
          >
            转接
          </button>
          <button
            type="button"
            id="____ccbar_cahold____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || phone.callState.value !== 'active'"
            @click="phone.run('保持', phone.hold)"
          >
            保持
          </button>
          <button
            type="button"
            id="____ccbar_unhold____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || phone.callState.value !== 'held'"
            @click="phone.run('恢复', phone.resume)"
          >
            恢复
          </button>
        </div>
      </div>

      <div class="bar-row">
        <div class="k">坐席</div>
        <div class="btns">
          <button
            type="button"
            id="____ccbar_set_id____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || !phone.connected.value"
            @click="phone.run('空闲', () => phone.setAgent('available'))"
          >
            空闲
          </button>
          <button
            type="button"
            id="____ccbar_set_bu____"
            class="ccbar_items"
            @click="phone.setBusyUnsupported()"
          >
            置忙
          </button>
          <button
            type="button"
            id="____ccbar_set_re____"
            class="ccbar_items"
            :disabled="!!phone.busy.value || !phone.connected.value"
            @click="phone.run('休息', () => phone.setAgent('break'))"
          >
            休息
          </button>
        </div>
      </div>

      <div id="____ccbar_errori____">{{ phone.feedback.value }}</div>
    </div>

    <section class="log-card">
      <div class="bar-head">
        <div class="log-tabs" role="tablist" aria-label="日志类型">
          <button
            type="button"
            role="tab"
            :aria-selected="logPanel === 'flow'"
            @click="logPanel = 'flow'"
          >
            日志
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="logPanel === 'sip'"
            @click="logPanel = 'sip'"
          >
            SIP
          </button>
        </div>
        <button type="button" id="ccbar-log-clear" @click="phone.clearLog(logPanel)">清空</button>
      </div>
      <div ref="logBody" class="log-body" :data-empty="activeLog.length ? '0' : '1'">
        <template v-if="activeLog.length">
          <div v-for="line in activeLog" :key="line.id" class="log-line" :class="line.level">
            <span class="log-time">{{ line.time }}</span>
            <span class="log-src">[{{ line.source }}]</span>
            <span class="log-msg">{{ line.message }}</span>
          </div>
        </template>
        <template v-else>{{ logPlaceholder }}</template>
      </div>
    </section>

    <div v-if="settingsOpen" id="ccbar-settings-mask" @click.self="settingsOpen = false">
      <div class="ccbar-settings-dialog" role="dialog" aria-labelledby="ccbar-settings-title">
        <h3 id="ccbar-settings-title">设置</h3>
        <label for="ccbar-setting-host">API 主机</label>
        <input
          id="ccbar-setting-host"
          v-model="phone.config.host"
          type="text"
          placeholder="https://你们的接口网关"
          autocomplete="off"
        />
        <label for="ccbar-setting-key">API KEY</label>
        <input
          id="ccbar-setting-key"
          v-model="phone.config.appKey"
          type="text"
          placeholder="请输入 API KEY"
          autocomplete="off"
        />
        <label for="ccbar-setting-secret">API SECRET</label>
        <input
          id="ccbar-setting-secret"
          v-model="phone.config.appSecret"
          type="password"
          placeholder="请输入 API SECRET"
          autocomplete="off"
        />
        <label for="ccbar-setting-extension">内部分机</label>
        <input
          id="ccbar-setting-extension"
          v-model="phone.config.extension"
          type="text"
          placeholder="例如 8001，不含企业前缀"
          inputmode="numeric"
          autocomplete="off"
        />
        <label for="ccbar-setting-sipws">软电话 WSS（覆盖项，可留空）</label>
        <input
          id="ccbar-setting-sipws"
          v-model="phone.config.sipWs"
          type="text"
          placeholder="留空＝按会话里的地址"
          autocomplete="off"
        />
        <label for="ccbar-setting-expires">SIP 注册有效期（覆盖项，可留空）</label>
        <input
          id="ccbar-setting-expires"
          v-model="phone.config.registerExpires"
          type="number"
          min="10"
          max="3600"
          step="1"
          placeholder="默认 600"
          inputmode="numeric"
        />
        <label for="ccbar-setting-legacy" class="ccbar-settings-check">
          <input id="ccbar-setting-legacy" v-model="phone.config.legacyPlatform" type="checkbox" />
          旧平台形态（token/fs + seat/account/get 取会话；不勾＝走新平台 /webphone/v1）
        </label>
        <p class="ccbar-settings-hint">
          Token 请求打同源的 <code>/get-token</code>（与 xcall 坐席条一致）：dev 由 Vite 转给本地代理加签，
          线上把同一路径反代到你们的签发服务即可 —— 只要返回 <code>{ accessToken, expiresAt? }</code>，
          KEY / SECRET 就可以只在服务端。WSS 由 SDK 从会话的 <code>transport.wssUrl</code> 取；
          注册有效期按这里填的值走（服务端写进会话的 <code>sip.registerExpires</code>，留空默认 600，
          SDK 拿不到时才回退 300）。SIP 原文固定记录（JsSIP 的 debug 命名空间，SDK 未公开的调试能力），
          SIP 面板能看到 REGISTER / INVITE。<br />
          勾了「旧平台形态」时改打 <code>/get-session</code>（
          <code>server/get-session.js</code>）：服务端取 fs token → 坐席账号 → 解出 SIP 密码 →
          拼好会话给 SDK，页面不碰 AES 密钥，也不依赖网关的跨域配置。
        </p>
        <div class="ccbar-settings-actions">
          <button type="button" id="ccbar-settings-cancel" @click="settingsOpen = false">
            取消
          </button>
          <button type="button" id="ccbar-settings-save" @click="saveSettings">保存</button>
        </div>
      </div>
    </div>

    <div v-if="phone.incoming.value.length" class="call-modal-overlay">
      <div class="call-modal call-modal-multi">
        <div class="call-modal-title">来电（{{ phone.incoming.value.length }}）</div>
        <div v-for="call in phone.incoming.value" :key="call.callid" class="ccbar-incoming-item">
          <div class="caller-name">{{ call.callerName }}</div>
          <div class="button-container">
            <button
              type="button"
              class="call-button answer-button"
              :disabled="!!phone.busy.value"
              @click="phone.run('接听', () => phone.answerCall(call.callid))"
            >
              接听
            </button>
            <button
              type="button"
              class="call-button cancel-button"
              :disabled="!!phone.busy.value"
              @click="phone.run('拒接', () => phone.rejectCall(call.callid))"
            >
              拒接
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
