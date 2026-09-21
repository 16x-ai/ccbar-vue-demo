# CCBar Vue 示例实施计划

目标：通过 GitHub Packages 的 @16x-ai/ccbar-sdk 3.0.1 创建可逐项操作和验收的中文 Vue + Vite 示例。

架构：App 持有 usePhone 容器；SDK 实例保持 shallowRef，不被 Vue 深度代理。Core 和 Legacy 互斥；默认 UI 复用 Core。Token 仅来自可配置的服务端接口。

- [x] 阅读 SDK README、API、类型和旧版示例，使用 create-vite 创建 Vue TS 模板。
- [x] helpers.ts：Token 校验、地址限制、日志白名单、请求失败；已运行 node --test。请求配置 15 秒超时。
- [x] usePhone.ts：实现应用级生命周期、状态事件、操作防重入、清理、Legacy 延迟导入。
- [x] App.vue 与功能组件：连接设置、呼叫、音频、官方 UI、Legacy、诊断、验收清单。
- [ ] 从 GitHub Packages 安装 SDK，运行 vue-tsc、Vite build、单元测试和浏览器验收。
- [ ] 保存到 D:/code/ccbar-vue-demo，交付中文 README 和功能覆盖表。

验证重点：过期/错误 Token；日志凭证泄露；并发点击；销毁时释放所有订阅；失败时保留配置；移动端不提供未承诺能力。真实通话需有效测试 Token 接口、测试分机、麦克风和另一呼叫终端，未执行的项目不可标为通过。

范围决策：直接使用用户指定的 GitHub Packages npm 包，不切换本地源码依赖；npm 凭证缺失时仍完成独立工作，并明确标注依赖安装和真机联调阻塞。不修改 SDK 和参考项目，不执行 git 提交。

已验证：npm test 15 项通过；Vue SFC 编译、静态 UI 审计、本地源码公开类型兼容性通过。已修复代码审查发现的振铃/保持通话无法选择问题，补充失败到通过的回归测试。正式包安装 401，test:package 和生产构建被缺包阻断，详见 VERIFICATION.md。
