# 现状核查与技术依据

核查日期：2026-10-11。本文区分公开事实、兼容性推断和项目决策。

## 上游与 macOS 兼容性

| 项目 | 核查结果 | 官方来源 |
| --- | --- | --- |
| WindTerm 正式版 | 最新正式版为 2.7.0，GitHub `published_at` 为 2025-03-11T19:12:09Z；发布间隔不证明开发停止 | [版本页](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0)、[发布 API](https://api.github.com/repos/kingToolbox/WindTerm/releases/latest) |
| macOS 包 | 2.7.0 包含 `WindTerm_2.7.0_Mac_Portable_x86_64.dmg`，未提供 arm64 包 | [发布附件](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0) |
| 仓库状态 | 未归档；不能据此判断作者未来发布计划 | [仓库 API](https://api.github.com/repos/kingToolbox/WindTerm) |
| Rosetta | macOS 27 为最后一个通用支持版本；macOS 28 起仅为特定旧游戏保留相关能力 | [Apple 支持](https://support.apple.com/en-us/102527)、[Apple 开发者公告](https://developer.apple.com/news/?id=w5ngl9k2) |
| 开源范围 | 部分开源；README 的 Apache-2.0 总述不能代替实际文件许可，第三方组件不都放在名为 `thirdparty` 的目录 | [版本 README](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#source-code) |

合理推断：依赖 Rosetta 的现有 x86_64 包会受到未来通用支持退出的影响，arm64 实现具有明确价值。当前没有 macOS 28 实测结果；若上游发布 arm64 版本，应重新评估该风险。

## 参考源码与功能基线

已获取本地只读参考副本，commit 为 `a8336c1d1e3dd1a981500dae8ef9eb42066de95f`，与 2.7.0 标签对应提交一致。参考目录不纳入本项目 Git 仓库，也不是产品依赖或 vendor 代码。[固定版本源码](https://github.com/kingToolbox/WindTerm/tree/a8336c1d1e3dd1a981500dae8ef9eb42066de95f)

公开树主要包含可独立使用的组件及第三方库，未提供足够的完整应用入口、终端和会话 GUI 产品层，不能把“拉取源码”视为可直接编译完整 WindTerm。当前仅完成静态盘点，未运行上游二进制。

实际许可包括：[`src/LICENSE`](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/LICENSE) 为 Apache-2.0，[libssh COPYING](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/libssh/COPYING) 为 LGPL-2.1，[agent.c](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/libssh/src/agent.c) 标注 2.1 或后续版本，[Onigmo COPYING](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/Onigmo/COPYING) 为 BSD 式许可，[ptyqt LICENSE](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/Pty/ptyqt%20LICENSE) 为 MIT。不能概括为全库 Apache-2.0。当前不复用上游代码、图标和二进制；未来若复用，需逐文件核查并保留原授权和归属。

最终目标是完整重构 **WindTerm 2.7.0 实际已有功能**。README 的 GSSAPI 支持声明与版本路线图延期说明存在冲突；会话搜索、命令片段也有延期说明。尚未完成上游实机盘点，因此先建立[逐项矩阵](FEATURE_PARITY.zh-CN.md)，由 P0 补齐证据。Mosh、Rlogin、FTP/FTPS、脚本、宏、插件等上游路线图能力不自动计入已实现基线。[版本功能与路线图](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md)

## 已确认路线与取舍

用户已确认 **Rust + Tauri 2 + xterm.js** 和 **Apache-2.0**。Rust 承担 PTY、协议连接、文件传输、配置和状态；Tauri 负责桌面集成；xterm.js 处理终端渲染及输入，本身不提供 SSH 或 shell。具体库版本仍需在 P0 核查能力、维护状态、许可证和平台支持后锁定。[Tauri 架构](https://v2.tauri.app/concept/architecture/) · [xterm.js](https://xtermjs.org/)

Tauri 在 macOS 使用系统 WebView。原生 arm64 指程序和运行组件的架构，不等于使用全套 AppKit 控件。中文输入法、WebView 差异、持续输出时的数据传输和背压均须实测；xterm.js 也不能直接等同于上游宣称的全部 VT 模式兼容能力。[Tauri WebView 说明](https://v2.tauri.app/reference/webview-versions/)

| 方案 | 工程取舍 | 本项目定位 |
| --- | --- | --- |
| Rust + Tauri 2 + xterm.js | 可复用跨平台核心；需证明输入法、数据传输和终端兼容性 | 已确认路线，P0 验证其满足完整范围的能力 |
| Rust + Swift/AppKit | 更深入使用 macOS 控件；增加语言边界和其他平台前端工作 | 仅在现路线遇到实证阻碍时重新提议，不自动更换 |
| Rust + 自绘/GPU 终端 | 可控制渲染路径；输入法、无障碍和完整兼容工程量较大 | 作为风险备选，不宣称未经测量的性能优势 |

以上属于工程判断，不是实测排名。上游历史性能表使用旧硬件和旧版本，不是本项目性能保证；动态内存压缩是需实现并实测的基线功能，不直接承诺上游所报压缩比例。

## 发布与数据边界

macOS 凭据采用 Keychain，后续 Windows/Linux 适配对应安全存储。配置迁移处理可识别的非秘密字段，提供预览与冲突处理；不解密旧凭据，认证功能通过用户重新提供凭据继续支持。[Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)

arm64 安装包对外分发需落实 Developer ID 签名、公证和真实 M 系列设备验收。开发者账号与权限是待落实条件，不能仅以编译通过宣布可用。[Apple 公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

阶段性 alpha 可用于验证；全部功能和对应平台验收前，不称为完整重构完成。完整工期需功能盘点、原型与人力确定后估算，详见[路线图](ROADMAP.zh-CN.md)及[架构](ARCHITECTURE.zh-CN.md)。
