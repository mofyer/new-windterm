# new-windterm

面向 Apple Silicon 优先交付的终端与远程连接工具，使用 **Rust + Tauri 2 + xterm.js** 独立重构 WindTerm 的完整功能。

An independent Rust-based reimplementation targeting full WindTerm feature parity, starting with Apple Silicon Macs.

**当前状态：仅完成规划，尚无应用代码、安装包或可下载版本。** 项目名称暂定，与 WindTerm 上游没有隶属关系。

## 目标与范围

最终目标是对齐 **WindTerm 2.7.0 的实际完整功能**：终端与多协议连接、认证和转发、文件传输、tmux 集成、会话管理及 GUI 工作流。macOS M 系列优先，Windows/Linux 随后交付；平台顺序和阶段性 alpha 不代表删减功能，基础连接可用也不代表全量重构完成。

功能以[逐项对齐矩阵](docs/FEATURE_PARITY.zh-CN.md)管理。上游 README 与实际版本有差异的项目先实测确认；上游尚未实现的路线图不自动计入基线。

**设计方向已确认：现代苹果风。** 功能语义、安全与操作效率保持对齐，界面可以重新设计，无需像素复刻旧版；专业功能和可调信息密度完整保留。布局、色彩等细节将在 P0 通过静态界面与交互原型确认，当前尚未制作效果图。[设计方向](docs/DESIGN.zh-CN.md)

## 为什么做

WindTerm 2.7.0 发布页提供 macOS x86_64 包，未提供 arm64 包。Apple 已说明 macOS 27 是 Rosetta 的最后一个通用支持版本，macOS 28 起仅为特定旧游戏保留相关能力。因此，现有 x86_64 版本在 Apple Silicon 上面临后续兼容性风险；这不是 macOS 28 实测结论。WindTerm 仓库未归档，不能据此认定作者停止开发。[WindTerm 发布页](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0) · [Apple 支持](https://support.apple.com/en-us/102527) · [Apple 开发者说明](https://developer.apple.com/news/?id=w5ngl9k2)

## 已确认路线

Rust 负责协议、PTY、文件传输和状态管理，Tauri 2 提供桌面集成，xterm.js 承担终端渲染。具体依赖在 P0 核验并锁定版本。原生 arm64 指构建和运行架构，不等于全部采用 AppKit 原生控件；输入法、终端兼容性和输出性能仍需真机验证。[Tauri 架构](https://v2.tauri.app/concept/architecture/) · [xterm.js](https://xtermjs.org/)

- [实施路线与验收标准](docs/ROADMAP.zh-CN.md)
- [完整功能对齐矩阵](docs/FEATURE_PARITY.zh-CN.md)
- [架构设计](docs/ARCHITECTURE.zh-CN.md)
- [界面与交互设计方向](docs/DESIGN.zh-CN.md)
- [现状核查与技术依据](docs/RESEARCH.zh-CN.md)

完整工期需在功能盘点、原型验证和人力确定后估算，当前不承诺全项目交付日期。

## 许可证

本项目采用 [Apache-2.0](LICENSE)。Copyright 2026 new-windterm contributors.

当前未引入 WindTerm 的代码、图标或二进制。上游为部分开源项目，源码与第三方依赖具有各自许可证；未来复用需逐文件核查授权并保留归属。[许可证核查依据](docs/RESEARCH.zh-CN.md)
