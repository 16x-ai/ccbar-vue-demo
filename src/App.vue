<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { statusText } from "./lib/logs";
import { usePhone } from "./lib/usePhone";

const phone = usePhone();
const settingsOpen = ref(false);
const logPanel = ref<"flow" | "sip">("flow");
const logBody = ref<HTMLElement>();
const activeLog = computed(() => phone.logs.value.filter((line) => line.panel === logPanel.value));
const workLabel = computed(() => statusText.work[phone.work.value]);
// 与 fork 版一致：以「是否已接通」为准 —— 接通即通话中，未接通才看 SDK 的 calling(呼出中)/busy(振铃中)。
// 参考 SDK 在内呼等时机对已接通会话仍报 busy，所以这里不能只认 calling。
const serviceDisplay = computed(() => {
  const service = phone.service.value;
  if (phone.inCall.value && service !== "hold" && service !== "transferring") return "talking";
  return service;
});
const serviceLabel = computed(() => statusText.serv[serviceDisplay.value]);
const serviceClass = computed(() => `ccbar_serv_status_${serviceDisplay.value}`);
const sipLabel = computed(() => statusText.sip[phone.sip.value]);
const sipClass = computed(() =>
  phone.sip.value === "registered" ? "ccbar_sip_status_reg" : "ccbar_sip_status_unreg",
);
const logPlaceholder = computed(() => phone.placeholder[logPanel.value]);

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

async function signIn() {
  try {
    await phone.signIn();
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
          <span class="ccbar_status" :class="`ccbar_work_status_${phone.work.value}`">{{
            workLabel
          }}</span>
          <span class="ccbar_status" :class="serviceClass">{{ serviceLabel }}</span>
          <span class="ccbar_status" :class="sipClass">{{ sipLabel }}</span>
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
            @click="signIn"
          >
            签入
          </button>
          <button type="button" id="____ccbar_signou____" class="ccbar_items">退签</button>
        </div>
      </div>

      <div class="bar-row">
        <div class="k">通话</div>
        <div class="btns">
          <button type="button" class="ccbar_items" @click="phone.callNumber()">外呼</button>
          <button type="button" id="____ccbar_inside____" class="ccbar_items">内呼</button>
          <button type="button" id="____ccbar_hangup____" class="ccbar_items btn-danger">
            挂断
          </button>
          <button type="button" id="____ccbar_transo____" class="ccbar_items">转接</button>
          <button type="button" id="____ccbar_cahold____" class="ccbar_items">保持</button>
          <button type="button" id="____ccbar_unhold____" class="ccbar_items">恢复</button>
        </div>
      </div>

      <div class="bar-row">
        <div class="k">坐席</div>
        <div class="btns">
          <button type="button" id="____ccbar_set_id____" class="ccbar_items">空闲</button>
          <button type="button" id="____ccbar_set_bu____" class="ccbar_items">置忙</button>
          <button type="button" id="____ccbar_set_re____" class="ccbar_items">休息</button>
        </div>
      </div>

      <div id="____ccbar_errori____"></div>
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
          <div
            v-for="line in activeLog"
            :key="line.id"
            class="log-line"
            :class="line.level"
          >
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
          placeholder="https://call-ng.innopaas.com"
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
          placeholder="例如 1000，不含企业前缀"
          inputmode="numeric"
          autocomplete="off"
        />
        <label for="ccbar-setting-sipws">软电话 WSS</label>
        <input
          id="ccbar-setting-sipws"
          v-model="phone.config.sipWs"
          type="text"
          placeholder="wss://call-ng.innopaas.com/api/fs/sip-ws"
          autocomplete="off"
        />
        <label for="ccbar-setting-expires">SIP 注册有效期（秒）</label>
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
        <label for="ccbar-setting-debug" class="ccbar-settings-check">
          <input id="ccbar-setting-debug" v-model="phone.config.sipDebug" type="checkbox" />
          记录 SIP 原文（JsSIP 调试：日志面板能看到 REGISTER / INVITE，给客户演示时可关掉去噪）
        </label>
        <p class="ccbar-settings-hint">
          软电话 WSS <b>留空</b>则按账号返回的 domain + wssPort 自动拼（参考页做法）；填了就用填入地址，并把
          token 拼成 <code>?token=</code>（同 xcall 坐席条）。KEY / SECRET 只 POST 给 Token
          接口，不进日志；SIP 注册有效期留空则用 600 秒。
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
        <div
          v-for="call in phone.incoming.value"
          :key="call.callid"
          class="ccbar-incoming-item"
        >
          <div class="caller-name">{{ call.callerName }}</div>
          <div class="button-container">
            <button
              type="button"
              class="call-button answer-button"
              @click="phone.answerCall(call.callid)"
            >
              接听
            </button>
            <button
              type="button"
              class="call-button cancel-button"
              @click="phone.rejectCall(call.callid)"
            >
              拒接
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 远端媒体输出：SDK 按 id 取用，缺了它接通后没有声音 -->
  <audio id="remoteAudio" autoplay playsinline></audio>
</template>
