---
version: alpha
colors:
  primary: "#1864ab"
  surface: "#ffffff"
  background: "#f3f4f6"
  ink: "#1a1d23"
  muted: "#5c6370"
  danger: "#c92a2a"
typography:
  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
  data:
    fontFamily: ui-monospace, Consolas, monospace
rounded:
  panel: "10px"
  control: "6px"
---

## Overview
给客户看的 CC Bar 嵌入示例。单栏坐席条加日志，对齐 `D:/code/xcall/ccbar/index.html`。不展示实验台、验收清单、Legacy、官方组件或诊断导出。

## Layout
页面最大 880px。上卡片为状态、号码、签入、通话、坐席；下来电时多一行接听/拒接；下卡片为日志。设置用遮罩对话框。

## Components
原生 button/input。签入蓝色，挂断浅红色，状态用圆点标签。日志等宽字体、浅底。
