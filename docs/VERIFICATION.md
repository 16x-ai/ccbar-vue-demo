# 验证记录

日期：2026-09-20。环境：Windows / Node 24.10.0 / npm 11.18.0。

| 检查 | 结果 | 说明 |
|---|---|---|
| GitHub Packages 读取与安装 | 阻塞 | 网络可达；401 Unauthorized，未提供认证 Token |
| npm test | 通过 | 15 项：5 个 Vue SFC 编译、5 个接入与日志行为、5 个通话选择回归测试 |
| 本地 SDK 公开类型兼容性 | 通过 | 临时从 D:/code/ccbar-web-sdk/src 生成声明后用 vue-tsc 检查；不是发布包验证；临时声明未放入交付目录 |
| UI 静态审计 strict | 通过 | 0 errors / 0 warnings；不替代浏览器交互测试 |
| 代码格式化 / DESIGN.md lint | 通过 | Prettier 格式化；设计文档 0 errors / 0 warnings |
| npm run test:package | 阻塞 | 两项均因私有包未安装而报 ERR_MODULE_NOT_FOUND |
| 正式类型检查与生产构建 | 阻塞 | 私有 SDK 包未安装；不得据此宣称构建成功 |
| 浏览器运行、响应式与键盘验收 | 未执行 | 页面直接导入真实 SDK，不能在缺少包时启动完整页面 |
| 真实外呼、来电、媒体、转接、重连 | 未执行 | 还需 npm 包、有效测试 Token 接口、分机和通话终端 |

已经修复检查发现的 Vue 模板 Promise 引用问题，复查本地 SDK 类型兼容性通过。未使用 mock 页面、CDN SDK 或本地源码依赖代替用户指定的 GitHub Packages npm 包。

代码审查发现 SDK 活动通话不包含振铃/保持状态，已将界面选择与 SDK 活动通话解耦，并验证回归测试从 4 项失败变为全部通过。结束通话时清理相关集合，避免长期使用累积状态。

解除阻塞后：npm install → npm test → npm run test:package → npm run typecheck → npm run build → npm run dev；随后逐项执行页面中的 12 组验收清单。实际安装的发布包可能与本地源码有差异，须以发布包验证结果为准。
