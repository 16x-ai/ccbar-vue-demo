<script setup lang="ts">
/**
 * 全屏加载遮罩：签入、以及设置坐席状态（空闲 / 置忙 / 休息）这类要等服务端回应、
 * 期间不该让人重复点的操作，都盖一层这个。
 * 文案由 usePhone 的 loading 决定，空字符串＝不显示。
 */
defineProps<{ text: string }>();
</script>

<template>
  <div class="ccbar-loading-overlay" role="status" aria-live="polite">
    <div class="ccbar-loading-box">
      <span class="ccbar-loading-spinner" aria-hidden="true"></span>
      <span class="ccbar-loading-text">{{ text }}</span>
    </div>
  </div>
</template>
