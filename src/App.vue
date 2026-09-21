<script setup lang="ts">
/**
 * 页面骨架：上半部分是坐席条，下半部分是日志卡片，中间夹设置弹窗与来电浮层。
 *
 * 这里只做两件事：
 *   1. 把 usePhone 的状态绑到标签上（状态文案与配色见 lib/logs.ts）；
 *   2. 把按钮点击交给 usePhone 的动作（按钮 → SDK 调用的对照表见 docs/前端接入文档.md）。
 * 真正的逻辑都在 src/lib 里，页面本身尽量薄。
 */
import { computed, ref } from "vue";
import IncomingCallModal from "./components/IncomingCallModal.vue";
import LogPanel from "./components/LogPanel.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import { usePhone } from "./lib/usePhone";

const phone = usePhone();
const settingsOpen = ref(false);

// 三个状态标签：坐席 / 通话 / SIP，各自取自 SDK 的状态
const agentLabel = computed(() => phone.agentText[phone.agent.value]);
const callLabel = computed(() => phone.callStatusText[phone.callState.value]);
const connectionLabel = computed(() => phone.connectionText[phone.connection.value]);

// 有未结束的通话（含还没接听的来电）——决定「通话」那一行按钮是否可用
const hasCall = computed(() => !["idle", "ended", "failed"].includes(phone.callState.value));

// 保存设置失败时，错误会显示在坐席条下方的红字行里，弹窗保持打开
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
          <!-- 外呼 / 内呼用「号码」框里的号码 -->
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
            :disabled="!!phone.busy.value || !phone.connected.value"
            @click="phone.run('置忙', phone.setBusy)"
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

    <LogPanel
      :logs="phone.logs.value"
      :placeholder="phone.placeholder"
      :clear="phone.clearLog"
    />

    <SettingsDialog
      :open="settingsOpen"
      :config="phone.config"
      @close="settingsOpen = false"
      @save="saveSettings"
    />

    <IncomingCallModal
      v-if="phone.incoming.value.length"
      :calls="phone.incoming.value"
      :busy="!!phone.busy.value"
      @answer="(callId) => phone.run('接听', () => phone.answerCall(callId))"
      @reject="(callId) => phone.run('拒接', () => phone.rejectCall(callId))"
    />
  </div>
</template>
