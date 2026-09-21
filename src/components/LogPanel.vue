<script setup lang="ts">
/**
 * 日志卡片：两个页签（日志 / SIP），点「清空」只清当前页签。
 *
 * 数据全部来自 usePhone：logs 是全部行，按 panel 分流；placeholder 是空面板时的提示语。
 */
import { computed, nextTick, ref, watch } from "vue";
import type { LogLine, LogPanel as Panel } from "../lib/logs";

const props = defineProps<{
  logs: LogLine[];
  placeholder: Record<Panel, string>;
  clear: (panel: Panel) => void;
}>();

const panel = ref<Panel>("flow");
const body = ref<HTMLElement>();
const lines = computed(() => props.logs.filter((line) => line.panel === panel.value));

// 与参考页一致：新日志进来、或切换页签后滚到底
watch([() => props.logs.length, panel], () => {
  void nextTick(() => {
    const el = body.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});
</script>

<template>
  <section class="log-card">
    <div class="bar-head">
      <div class="log-tabs" role="tablist" aria-label="日志类型">
        <button type="button" role="tab" :aria-selected="panel === 'flow'" @click="panel = 'flow'">
          日志
        </button>
        <button type="button" role="tab" :aria-selected="panel === 'sip'" @click="panel = 'sip'">
          SIP
        </button>
      </div>
      <button type="button" id="ccbar-log-clear" @click="clear(panel)">清空</button>
    </div>

    <div ref="body" class="log-body" :data-empty="lines.length ? '0' : '1'">
      <template v-if="lines.length">
        <div v-for="line in lines" :key="line.id" class="log-line" :class="line.level">
          <span class="log-time">{{ line.time }}</span>
          <span class="log-src">[{{ line.source }}]</span>
          <span class="log-msg">{{ line.message }}</span>
        </div>
      </template>
      <template v-else>{{ placeholder[panel] }}</template>
    </div>
  </section>
</template>
