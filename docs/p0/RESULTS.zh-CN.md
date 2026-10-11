# P0 本轮结果与下一步

日期：2026-10-11。**P0 进行中：本地原型可运行，但完整功能基线、关键可行性验证与 P0 验收尚未完成。** 最新 Silver Soft UI 已实现白色画布、银白浮层、24px 主面板圆角与双向柔影，完成 56 项浏览器回归及有限原生冒烟；用户已回复“接近了，按这个方向继续”，认可视觉方向。下文区分新版结果、旧 Mint 原生功能证据和后端诊断，不把方向认可或有限检查当作完整产品验收。

## 交付与证据

| 内容 | 本轮结果 | 证据与边界 |
| --- | --- | --- |
| 上游盘点 | 固定 2.7.0 发布样本与源码，记录 117 个初始 ID、静态资源和少量实际入口 | [BASELINE](BASELINE.zh-CN.md)、[结构化台账](baseline.json)；尚未冻结完整基线，入口可见不证明功能成功 |
| 技术调查 | 梳理 VT、编辑/折叠、历史压缩、SSH 高级能力、tmux 和 modem 缺口 | [FEASIBILITY](FEASIBILITY.zh-CN.md)；协议依赖候选不等于已实现或全部锁定 |
| Silver Soft UI 原型 | 白色画布、银白浮层、纯白终端、24px 主面板圆角与双向柔影；保留侧栏、标签/分屏、命令面板和连接/传输演示 | [设计系统](DESIGN_SYSTEM.zh-CN.md)、[UI_MAP](UI_MAP.zh-CN.md)；SSH 指纹、文件与传输均为模拟，无真实网络和文件落盘 |
| 最新浏览器验收 | 56 passed，16.2 秒，无测试放宽：53 项正向/契约（含 2 项对比度检查）、2 项 VT 缺口、1 项旧 Unicode 6 反例；0 failed/skipped/flaky | [WEB_QA](WEB_QA.zh-CN.md)；Chrome headless，不能替代原生 WKWebView/IME 验收 |
| Rust 检查 | `cargo check`、10 个单元测试、`clippy -D warnings` 通过 | [PTY_PROBE](PTY_PROBE.zh-CN.md)；涵盖 ACK、预算、关闭、尺寸、平台边界和生命周期规则 |
| 真实 PTY | 2,097,152 字节输出完整性、ACK 暂停/恢复、Ctrl-C、132×43 resize、退出码 7、重复关闭与关闭后拒绝输入 | [PTY_PROBE](PTY_PROBE.zh-CN.md)；是本机 PTY 探针，不是 SSH/SFTP 或完整图形链路验收 |
| 关闭与清理 | 12 轮真实 PTY 打开、输出、不发 ACK、关闭和等待回收；未发现该测试进程残留 | [PTY_PROBE](PTY_PROBE.zh-CN.md)；不覆盖守护化、双重 fork、脱离会话等进程 |
| 本地应用 | 已有 debug `.app` 构建产物，可用于继续原生补验 | 路径见下文；不是签名公证后的发行版 |
| 已测 Mint 原生补验 | WKWebView 中真实中文/emoji 回显、尺寸与退出码正确；大量输出中断存在待查延迟 | 见下节；不是新一轮样式、IME、长期性能或即时中断验收 |
| 新版原生冒烟 | arm64 debug `.app` 重打并启动，中文/emoji 命令回显与输出完整，`stty size` 为 `23 129`，`exit 7` 状态正确 | WKWebView 实际本地 PTY；仅为本轮冒烟，不是 IME、性能或全功能验收 |

PTY 报告记录宿主为 macOS 27.0.1、arm64。本轮已测未确认输出有效载荷峰值 61,607 字节，低于 65,536 字节预算；该数字只针对有效载荷，不能当作应用 RSS、吞吐或性能领先证据。

## 已测 Mint 构建的原生补验

主执行通道在 macOS 27.0.1 arm64 的已测 Mint debug `.app` 中，经 `tauri://localhost` WKWebView 记录以下真实 PTY 行为；这不覆盖随后用户要求的新一轮样式调整：

- 执行含 `P0_FINAL 中文🌏` 的 `printf`，命令回显和输出正确。此前 emoji 错列问题在接入 Unicode 11 宽度表后未复现；这不等于 Unicode 13/ZWJ 或中文 IME 组合输入通过。
- `stty size` 返回 `27 135`，即 27 行、135 列。
- 持续 `yes` 输出累计约 41.9 MB 后，多次触发 Ctrl-C 才观察到输出停止；随后 `printf P0_RESPONSIVE` 成功，`exit 7` 显示退出码 7。

该中断观察不能作为吞吐性能或即时 Ctrl-C 响应通过证据；辅助功能输入事件（AX）、输入排队与输出消费延迟需要专项定位。后端随后使用同一生产 Session 做独立真实 `yes` 诊断：输出 8,390,577 字节后注入 `0x03`，暂停 ACK 300ms，在 316.16ms 后收到恢复 `printf`（包含该 300ms 暂停），未确认有效载荷峰值 5,937 字节，正常回收，无生产代码修改。这支持该后端路径可中断，不能据 GUI/CUA 的未量化观察归因为 Rust 死锁；临时诊断也不是 GUI 性能基准。

## 最新白银浮层版视觉证据

三张文档截图均已更新并核对为最新 Silver Soft UI：[浅色工作台](../assets/p0-light-workspace.png)、[连接表单](../assets/p0-light-connection.png)、[深色工作台](../assets/p0-dark-workspace.png)。最新浏览器对比度抽检的最低值为浅色 4.674:1、深色 4.640:1；该结果仅覆盖所测颜色对，不是完整无障碍认证。用户随后明确认可继续沿该方向完善，认可范围不扩展为完整产品验收。

最终白银浮层版已重新构建、重启，构建约 9.7 秒，arm64 debug 产物约 31.76 MiB。主执行通道在 `tauri://localhost` WKWebView 的真实本地终端运行 `printf 'P0_SILVER_OK 中文 🌏\n'; stty size; exit 7`：命令回显与输出完整，尺寸为 23 行、129 列，界面退出码为 7。此处是新版原生冒烟；上文 41.9 MB 和 8,390,577 字节中断诊断仍保留为此前功能证据，不构成新版高负载性能验收。

## 跨平台边界

macOS、Windows、Linux 从 P0 共同进入架构设计，详见[跨平台计划](../CROSS_PLATFORM.zh-CN.md)。本轮将 shell、环境与工作目录、非阻塞 I/O 和 EOF 规则隔离到平台模块；尚未支持的平台在分配 PTY 前明确报错。Windows/Linux 的适配、构建与实机验收仍未完成；macOS 原生通过不向其他平台继承。

## 已确认的缺口与范围

浏览器独立序列探针确认：VT52 模式切换后的定位序列未按预期执行；DECSCL 选择 VT200 conformance 后，设备属性仍未报告目标 class。两项测试为 green 表示缺口可重复，**不表示对应兼容性通过**。这些证据限定于具体序列，不能外推为所有 VT 模式均不支持。

117 项只是初始清单。上游实际入口还观察到 VT52、VT102、Bell、Big5/EUC-JP 字符集、Sysmon、Hex 编辑、虚拟空间、多插入符号、全屏/置顶与调试模式等候选；需新增独立 ID 或拆分行为，保留旧 ID，不以实现难度删减范围。上游能力、候选入口及本项目实现应继续分开记录。

原型目前最多 8 个会话、5,000 行终端历史；这些是 P0 防护预算，不是最终功能上限，也不是动态压缩实现。真实 SSH/SFTP、主机信任与认证、tmux 集成、其他协议、完整 VT 方言和历史压缩尚未完成。未完成中文 IME、VoiceOver、Retina、完整原生交互、CPU/RSS/耗电/启动性能、签名公证或正式发行验收。原生补验应另记录实际动作和证据，不能从浏览器结果推断通过。

## 运行与复核

macOS 开发环境需 Node.js/npm、仓库指定 Rust 工具链和 Xcode Command Line Tools。在仓库根目录执行：

```sh
cd apps/desktop
npm ci
npm run tauri dev
```

`tauri dev` 自动启动前端服务。桌面窗口点击「本地终端」可启动原型限定的本机 `/bin/zsh -f -i`；不会加载用户 shell 配置或读取 SSH 凭据。纯浏览器演示改用 `npm run dev`，地址为 `http://127.0.0.1:1420`，不能启动真实 PTY。两种模式不要同时占用 1420 端口。

本机现有 debug 应用：`apps/desktop/src-tauri/target/debug/bundle/macos/New WindTerm P0.app`。这是忽略的本地构建产物，不随 Git 发布；当前默认配置关闭发行打包。

前端和浏览器测试在 `apps/desktop` 下运行；浏览器测试需另一个终端已有开发服务器，以及系统 Google Chrome：

```sh
npm run build
npx playwright test --config playwright.config.ts
```

Rust 检查在仓库根目录运行：

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin pty_probe
```

浏览器原始统计、探针附件和截图位于被忽略的 `apps/desktop/test-results/`，重跑可能覆盖；提交的报告记录范围与结果，不把本地工件目录当公开下载链接。

## 下一步与 P0 出口

1. 补齐上游实际行为与新增候选，明确 GSSAPI 等文档冲突，形成可追溯的完整基线。
2. 针对 VT52/DECSCL、其他 VT 方言以及 Free Type、折叠、压缩历史分别做概念验证和架构决策，保持全功能目标。
3. 沿用户已认可的白银浮层方向完善体验；定位大输出下 Ctrl-C 观察延迟，补验原生 IME、快捷键与资源，对 ACK 超时、页面刷新、窗口退出及资源耗尽增加故障场景。
4. 建立受控 SSH/SFTP、agent、跳板、转发及 tmux 测试夹具，保存对端与客户端证据；不接触私人连接配置。
5. 基于完整功能风险、实测预算和人力重估工期。满足[路线图](../ROADMAP.zh-CN.md)的 P0 门槛后再作阶段结论，当前不宣布 P0 完成。
