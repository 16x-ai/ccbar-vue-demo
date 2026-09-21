<script setup lang="ts">
/**
 * 来电浮层：可能同时有多路来电，所以按列表渲染，每路一组「接听 / 拒接」。
 */
import type { IncomingCall } from "../lib/usePhone";

defineProps<{ calls: IncomingCall[]; busy: boolean }>();
const emit = defineEmits<{ answer: [callId: string]; reject: [callId: string] }>();
</script>

<template>
  <div class="call-modal-overlay">
    <div class="call-modal call-modal-multi">
      <div class="call-modal-title">来电（{{ calls.length }}）</div>
      <div v-for="call in calls" :key="call.callid" class="ccbar-incoming-item">
        <div class="caller-name">{{ call.callerName }}</div>
        <div class="button-container">
          <button
            type="button"
            class="call-button answer-button"
            :disabled="busy"
            @click="emit('answer', call.callid)"
          >
            接听
          </button>
          <button
            type="button"
            class="call-button cancel-button"
            :disabled="busy"
            @click="emit('reject', call.callid)"
          >
            拒接
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
