<script setup lang="ts">
/**
 * 设置弹窗。
 *
 * 输入框直接绑在 page.config 上（同一个响应式对象），点「保存」时由 usePhone 校验并写盘；
 * 校验不通过会在页面上显示红字，弹窗不关。
 */
import type { PhoneConfig } from "../lib/settings";

defineProps<{ open: boolean; config: PhoneConfig }>();
const emit = defineEmits<{ close: []; save: [] }>();
</script>

<template>
  <div v-if="open" id="ccbar-settings-mask" @click.self="emit('close')">
    <div class="ccbar-settings-dialog" role="dialog" aria-labelledby="ccbar-settings-title">
      <h3 id="ccbar-settings-title">设置</h3>

      <label for="ccbar-setting-host">API 主机</label>
      <input
        id="ccbar-setting-host"
        v-model="config.host"
        type="text"
        placeholder="https://你们的接口网关"
        autocomplete="off"
      />

      <label for="ccbar-setting-key">API KEY</label>
      <input
        id="ccbar-setting-key"
        v-model="config.appKey"
        type="text"
        placeholder="请输入 API KEY"
        autocomplete="off"
      />

      <label for="ccbar-setting-secret">API SECRET</label>
      <input
        id="ccbar-setting-secret"
        v-model="config.appSecret"
        type="password"
        placeholder="请输入 API SECRET"
        autocomplete="off"
      />

      <label for="ccbar-setting-extension">内部分机</label>
      <input
        id="ccbar-setting-extension"
        v-model="config.extension"
        type="text"
        placeholder="例如 8001，不含企业前缀"
        inputmode="numeric"
        autocomplete="off"
      />

      <label for="ccbar-setting-sipws">软电话 WSS</label>
      <input
        id="ccbar-setting-sipws"
        v-model="config.sipWs"
        type="text"
        placeholder="wss://你们的软电话地址/api/fs/sip-ws"
        autocomplete="off"
      />

      <label for="ccbar-setting-expires">SIP 注册有效期（覆盖项，可留空）</label>
      <input
        id="ccbar-setting-expires"
        v-model="config.registerExpires"
        type="number"
        min="10"
        max="3600"
        step="1"
        placeholder="默认 600"
        inputmode="numeric"
      />

      <p class="ccbar-settings-hint">注册有效期会交给服务端写进会话（留空默认 600 秒） </p>

      <div class="ccbar-settings-actions">
        <button type="button" id="ccbar-settings-cancel" @click="emit('close')">取消</button>
        <button type="button" id="ccbar-settings-save" @click="emit('save')">保存</button>
      </div>
    </div>
  </div>
</template>
