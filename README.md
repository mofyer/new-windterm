# new-windterm

面向 Apple Silicon 优先交付的终端与远程连接工具，使用 **Rust + Tauri 2 + xterm.js** 独立重构 WindTerm 的完整功能。

An independent Rust-based reimplementation targeting full WindTerm feature parity, starting with Apple Silicon Macs.

**当前状态：P0 已于 2026-10-15 通过技术出口评审并获用户确认关闭，下一阶段为 P1 本地终端产品化；完整功能尚未交付，没有正式发行版。** 项目名称暂定，与 WindTerm 上游没有隶属关系。

## 目标与范围

最终目标是对齐 **WindTerm 2.7.0 的实际完整功能**：终端与多协议连接、认证和转发、文件传输、tmux 集成、会话管理及 GUI 工作流。macOS M 系列优先，Windows/Linux 随后交付；平台顺序和阶段性 alpha 不代表删减功能，基础连接可用也不代表全量重构完成。

功能以[逐项对齐矩阵](docs/FEATURE_PARITY.zh-CN.md)管理。当前追踪 164 项：原 117 + 第二轮 13 + 冻结候选 31 + 后增 T35–T37 共 3 项。基线已按用户批准冻结和扩展，功能对齐尚未完成；探针和原型不计为产品交付。上游 README 与实际版本有差异的项目先实测确认；上游尚未实现的路线图不自动计入基线。

**浅色白银浮层与深色中性炭灰方向均已获用户认可。** 浅色保留白色画布、银白浮层、24px 主面板圆角与双向柔影；侧栏、标签/分屏、命令面板和模拟文件传输保持。深色截图已更新，方向认可不代表完整功能验收。[设计系统](docs/p0/DESIGN_SYSTEM.zh-CN.md) · [原型入口说明](docs/p0/UI_MAP.zh-CN.md)

![P0 Silver Soft UI 浅色工作台](docs/assets/p0-light-workspace.png)

[浅色连接表单](docs/assets/p0-light-connection.png) · [深色工作台](docs/assets/p0-dark-workspace.png) · [深色连接表单](docs/assets/p0-dark-connection.png)

## 本地开发与本轮结果

在 macOS 开发环境安装 Node.js/npm、Rust 工具链及 Xcode Command Line Tools，然后选择桌面模式或浏览器模式运行：

```sh
cd apps/desktop
npm ci
npm run tauri dev   # 桌面窗口，点击「本地终端」启动真实本机 shell
# 或使用 npm run dev，仅打开 http://127.0.0.1:1420 浏览器演示
```

`tauri dev` 会启动开发服务器，不要同时另开占用 1420 端口的 `npm run dev`。前端检查与构建使用 `npm run build`；Rust 与浏览器测试命令见[本轮结果](docs/p0/RESULTS.zh-CN.md)。

本机已生成的 debug 应用位于 `apps/desktop/src-tauri/target/debug/bundle/macos/New WindTerm P0.app`，属于本地构建产物，不随 Git 分发，也不是签名公证后的发行包。

已有本地 PTY、交互 SSH、SFTP 读写、代理与转发、Telnet/Raw TCP 等原型。P0 完成范围盘点、架构风险判断、最小原生可行性及 164 项剩余工作估算；完整会话、传输、兼容与跨平台产品验收仍按 P1–P5 交付。具体实现与未完成边界以[交接文档](docs/HANDOFF.zh-CN.md)和[P0 出口结论](docs/p0/P0_EXIT_REVIEW.zh-CN.md)为准。

最新已核对 CI 为 `a9049a4` 的 7/7 作业成功，产品实现基点仍为 `fb824cf`，覆盖 macOS arm64、Linux、Windows Server 2022/2025 及 Linux/Windows 原生 WebView 冒烟。macOS 另取得有限原生输入、固定负载与恢复、资源归属及用户最小 VoiceOver 听测。浏览器 IPC stub、协议夹具、原生冒烟和完整验收分别记录，详情见[P0 结果](docs/p0/RESULTS.zh-CN.md)。

PTY 新增默认关闭的 `pty-readiness` 实验：本机三组配对均通过精确 2 MiB 与回收检查，负载中位数从 6898.175 ms 降为 342.195 ms（含 300 ms 人工 ACK 暂停）。这是直接调用 Rust PTY 的 CLI 实验，不代表默认应用或 WebView 性能达标；默认仍使用原读取策略。[实验方法与限制](docs/p0/PTY_READINESS.zh-CN.md)

完整 IME、读屏、VT、持续性能与内存预算在 P1 对应交付前验收，真实串口在 P2 串口交付前验收。阶段关闭不代表这些项目通过。

## 为什么做

WindTerm 2.7.0 发布页提供 macOS x86_64 包，未提供 arm64 包。Apple 已说明 macOS 27 是 Rosetta 的最后一个通用支持版本，macOS 28 起仅为特定旧游戏保留相关能力。因此，现有 x86_64 版本在 Apple Silicon 上面临后续兼容性风险；这不是 macOS 28 实测结论。WindTerm 仓库未归档，不能据此认定作者停止开发。[WindTerm 发布页](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0) · [Apple 支持](https://support.apple.com/en-us/102527) · [Apple 开发者说明](https://developer.apple.com/news/?id=w5ngl9k2)

## 已确认路线

Rust 负责协议、PTY、文件传输和状态管理，Tauri 2 提供桌面集成，xterm.js 承担终端渲染。当前原型依赖已锁定，后续新增依赖仍须在采用前核验。原生 arm64 指构建和运行架构，不等于全部采用 AppKit 原生控件；输入法、终端兼容性和输出性能仍需真机验证。[Tauri 架构](https://v2.tauri.app/concept/architecture/) · [xterm.js](https://xtermjs.org/)

- [实施路线与验收标准](docs/ROADMAP.zh-CN.md)
- [完整功能对齐矩阵](docs/FEATURE_PARITY.zh-CN.md)
- [架构设计](docs/ARCHITECTURE.zh-CN.md)
- [跨平台架构与分平台验收](docs/CROSS_PLATFORM.zh-CN.md)
- [界面与交互设计方向](docs/DESIGN.zh-CN.md)
- [现状核查与技术依据](docs/RESEARCH.zh-CN.md)
- [P0 本轮结果与未完成项](docs/p0/RESULTS.zh-CN.md)
- [本机 SSH/SFTP 受控夹具](docs/p0/SSH_SFTP_FIXTURE.zh-CN.md)：为固定命令 Rust SSH 验证提供 OpenSSH 受控对端；[OpenSSH 交互终端夹具](docs/p0/OPENSSH_INTERACTIVE.zh-CN.md)用于独立系统 PTY 回归；同一夹具也用于 SFTP 读写原型验证，完整传输产品仍待交付。

[164 项剩余工作估算](docs/p0/EFFORT_ESTIMATE.zh-CN.md)已按 53 个包拆分，属于未按团队实绩校准的人力规划，不承诺全项目交付日期。

## 许可证

本项目采用 [Apache-2.0](LICENSE)。Copyright 2026 new-windterm contributors.

当前未引入 WindTerm 的代码、图标或二进制。上游为部分开源项目，源码与第三方依赖具有各自许可证；未来复用需逐文件核查授权并保留归属。[许可证核查依据](docs/RESEARCH.zh-CN.md)
