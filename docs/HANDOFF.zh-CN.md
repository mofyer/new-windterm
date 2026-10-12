# New WindTerm 交接词

以下内容可直接复制给下一位模型，作为本项目继续工作的上下文。

---

你正在接手公开仓库 `https://github.com/mofyer/new-windterm`，本地目录为 `/Users/yafan/Workspace/www/new-windterm`。

- **目标**：使用 Rust + Tauri 2 + xterm.js，独立重构 WindTerm 2.7.0 的完整已有功能。
- **视觉方向**：现代苹果风。浅色为 Silver Soft UI，深色为中性 Carbon Dark。
- **许可证**：Apache-2.0。
- **平台**：macOS Apple Silicon 优先，但 Windows/Linux 从架构和测试层面同步考虑。

用户的明确要求：
- 功能一致，允许更新 UI 风格。
- 不能因为先做 macOS 就删减 Windows/Linux 或 WindTerm 的功能。
- 目前仍处于 P0，不能宣布完整重构完成、P1 通过或产品可用。

仓库根目录的 `CLAUDE.md` 汇总了命令、架构和约定，接手后先读。

## 当前仓库状态（2026-10-11）

### 分支

- **远端 `main`**：仍是 `9afcafe docs: add model handoff brief [skip ci]`，本轮没有改动。
- **本地 `main`**：比远端多一个未推送的提交 `107c012 feat: wire read-only sftp into the file panel`，它已包含在集成分支中。
- **集成分支 `p0/integration`**：本轮全部工作都在这里，已推送。它把各个 `p0/*` 工作分支，以及子代理在 `.claude/worktrees/` 下的分支合并在一起。
- **合并到 `main`**：必须先取得用户的明确同意。用户授权的推送范围只有 `p0/*` 工作分支和手动触发的 CI，`main` 不能动。
- **已推送的工作分支**：
  - `p0/sftp-panel`、`p0/openssh-shell`、`p0/ssh-auth`、`p0/ssh-kbdint`
  - `p0/ssh-forward`、`p0/ssh-proxy`、`p0/ssh-remote-forward`
  - `p0/scp`、`p0/telnet`、`p0/terminal-history`、`p0/windows-conpty`
- **未跟踪目录**：`.claude/` 中是子代理的 worktree，属于过程产物。删除前先用 `git worktree list` 确认其中的提交已经合并。

### CI 与文档

- **CI**：`.github/workflows/p0-cross-platform.yml`，覆盖 macOS arm64、Linux x64、Windows x64。工作分支上可以用 `gh workflow run p0-cross-platform.yml --ref <分支>` 手动触发。最近的证据以 [RESULTS](p0/RESULTS.zh-CN.md) 顶部各节为准。
- **结果与边界**：[docs/p0/RESULTS.zh-CN.md](p0/RESULTS.zh-CN.md)。
- **功能总矩阵**：[docs/FEATURE_PARITY.zh-CN.md](FEATURE_PARITY.zh-CN.md)。2026-10-12 由用户批准冻结，共 161 个 ID（原 130 个，加上 31 个采纳的候选）。冻结没有改变任何原有行的状态。
- **路线图**：[docs/ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)。

## 本轮完成且有证据的内容（集成分支）

每一项都只覆盖下表“证据”一栏写到的范围。

| 领域 | 内容 | 证据 | 主要边界 |
| --- | --- | --- | --- |
| 只读 SFTP 文件面板 | 指纹核对后签发短时授权；目录分页与截断；64 KiB 预览 | 真实 OpenSSH 夹具；浏览器测试 | 没有写操作、下载落盘或原生 WKWebView 实测；F01 未完成 |
| 主机信任 | `known_hosts`（OpenSSH 格式）；`new`/`known`/`changed` 三种状态；变化时阻断 | 单元与集成测试；系统 `ssh` 接受我们保存的条目 | 不导入用户的 `~/.ssh/known_hosts` |
| SSH 认证 | 私钥（可带口令）、密码、agent、keyboard-interactive；bcrypt 轮数上限 | loopback 与真实 OpenSSH | 只支持 Ed25519/ECDSA，没有 RSA |
| keyboard-interactive 实时提示 | 连接时逐轮弹窗作答；`ssh_auth_respond` 绑定窗口、操作和轮次；适用于终端标签页和 SFTP 面板 | loopback 夹具；浏览器测试 | 没有真实 PAM/OpenSSH 验证，没有原生手工测试 |
| 交互 SSH | Rust `ssh_open` 连接真实 OpenSSH shell | `tests/fixtures/ssh-terminal/rust-client.test.mjs` | 没有长期会话和断线恢复 |
| 转发 | 本地转发、SOCKS5 动态转发、跳板、远端转发、agent 转发；服务端主动打开的通道默认拒绝，`forwarded-tcpip` 最多 64 个；已打开的 SSH 终端可以在「端口转发」面板中增删本地、动态和远端转发 | loopback 夹具；浏览器测试 | 没有与 OpenSSH 的转发互操作；agent 转发没有界面；设置不保存 |
| 代理与跳板路线 | 连接对话框可选直连、HTTP CONNECT、SOCKS5、ProxyCommand（不经过 shell）、单跳跳板（两步信任）；路线绑定进 challenge 和 SFTP 授权 | loopback 代理；真实 OpenSSH 夹具 | 没有用真实代理软件或 OpenSSH 跳板验证；不支持多跳 |
| SFTP 写操作原型 | 新建目录、重命名、删除、chmod、上传、下载落盘；需先开启写入 | 真实 OpenSSH 夹具；浏览器测试 | 没有原生窗口实测；写入开关缺少原生确认 |
| 连接复用 | 应用内复用的探针，以及 ControlMaster 决策记录 | 测试与[决策记录](p0/CONTROLMASTER_ADR.zh-CN.md) | 不实现 OpenSSH ControlMaster socket |
| SCP | `scp -t -d/-f` 传单个文件；SFTP 面板中可选，上传需要先开启写入 | 真实 OpenSSH 夹具；浏览器测试 | 没有目录或递归；没有原生窗口实测 |
| agent 转发 | 终端连接对话框中按连接开启，默认关闭，不保存 | loopback 夹具与私有临时 ssh-agent | 没有与 OpenSSH 服务端互操作 |
| 原生 WebView 冒烟 | 用 tauri-driver 驱动真实应用：工作台、本地终端、SSH 终端 | CI：Linux WebKitGTK 2.52.6、Windows WebView2 131 | 没有 macOS WKWebView、输入法和屏幕阅读器 |
| Telnet / Raw TCP | 编解码器，以及桌面终端标签页（五个 `net_*` 命令） | loopback 服务器；浏览器测试；真实 telnetd 308（6 项，本机） | 没有 login 认证、LINEMODE 或网络设备 |
| 输入路径 | 有序输入队列（16 MiB）；按 UTF-8 边界分块输出，绕过 xterm.js #6003；粘贴与拖放过滤控制字符；无按键输入的文本会转发；拦截 F 键默认动作 | 浏览器测试（CDP） | 没有原生输入法、VoiceOver 或 WebView 实测 |
| XMODEM/YMODEM | 不依赖 I/O 的发送与接收；评估了 ZMODEM 的 `zmodem2`，结论是不采用 | 单元测试；与真实 lrzsz 0.13.1 互操作 11/11 | 没有接入终端、SSH 或串口；ZMODEM 需要自行实现 |
| tmux 控制模式 | 解析器，跟踪窗口与窗格 | 单元测试；本机 tmux | 没有界面 |
| 终端概念验证 | 压缩历史、折叠/大纲、Free Type、VT52 | Playwright | 都是隔离原型，未接入生产终端 |
| VT 兼容矩阵与适配 | xterm.js 6.0.0 的 63 项探针；生产代码加了设备身份、DECRQSS、DECOM 下的 CPR、默认关闭的 OSC 52 写入。加适配后为支持 39、部分支持 15、不支持 12 → 9 | [矩阵](p0/VT_MATRIX.zh-CN.md) | 没有运行 vttest，没有与 WindTerm、xterm 或 DEC 对比 |
| Windows ConPTY | `cmd.exe` 生命周期：Job Object 回收进程树，关闭、ACK、Ctrl+C 等 | Windows CI（Server 2022 与 2025） | 只验证了 `cmd.exe`；Server 2022 系统自带的 ConPTY 每个会话泄漏 1 个句柄，Server 2025 上没有，本项目代码不额外泄漏 |
| 工作量估算 | 全项目分解与人周估算 | [估算](p0/EFFORT_ESTIMATE.zh-CN.md) | 只是估算，不是承诺 |
| 性能基线 | 本机 PTY、xterm、启动与内存基线 | [记录](p0/PERFORMANCE_BASELINE.zh-CN.md) | 测量环境嘈杂；没有 WKWebView 数字，没有与 WindTerm 对比 |
| 上游静态复核 | 130 项逐条对照上游静态材料 | [复核记录](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md) | 静态证据不等于行为已验证 |
| 依赖与许可证 | 依赖清单 | [清单](p0/DEPENDENCIES.zh-CN.md) | — |
| 安全评审 | 网络探针没有 CRITICAL 或 HIGH 问题；MEDIUM 已修复或已写明不采纳的理由 | RESULTS「网络探针安全评审」一节 | — |

X11 转发已有 Rust 探针：采用假 cookie 替换，没有界面；与 Xvfb 和 OpenSSH 的真实互操作放在 Linux CI 上运行。GSSAPI 只有[决策记录](p0/X11_GSSAPI_ADR.zh-CN.md)。

## 绝对不能误报的边界

- 不能说 WindTerm 功能已经完整对齐，也不能说 P0 或 P1 已通过。
- 不能说 SFTP 已完成。现在只有只读浏览和写操作原型，没有以下能力：
  - 递归、目录传输、断点续传
  - 持久连接、断线恢复
  - 原生面板验收
- 不能说 Windows 终端可用：
  - 只在 CI 上验证了 `cmd.exe` 的 ConPTY 生命周期。
  - PowerShell、WebView2 原生窗口、输入法和真实用户环境都没有验收。
  - 已知限制见 [ConPTY 决策记录](p0/WINDOWS_CONPTY_ADR.zh-CN.md)：排空没有期限，Job 分配存在竞态。
- 测试替身的结果不能外推：
  - 浏览器 E2E 使用 IPC stub，不能外推为 Rust 或原生 GUI 成功。
  - loopback russh 或测试内 TCP 服务端，不能等同于真实 OpenSSH、telnetd 或网络设备。
- 构建结果不代表发行验收：
  - macOS arm64 CI 或本地 debug 构建，不等于真机 IME、高输出性能、签名、公证或发行验收。
- 概念验证与探针不改变功能矩阵中任何一行的状态。

## 需要用户提供或决定的事项

这些事项已向用户说明过，不要自行绕过：

- **合并**：同意把 `p0/integration` 合并到 `main`（需要在 CI 通过之后）。
- **功能基线**：2026-10-12 已冻结，E1–E12 全部采用推荐选项。用户同时授权在隔离副本中运行上游 2.7.0 做实机盘点；Windows/Linux 上游包的静态核对放到冻结之后。见[冻结方案](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md)的决定记录。
- **串口（C04）**：需要一个真实的 USB 串口设备。
- **X11 转发（C15）**：Linux CI 已用 Xvfb 验证；如果要在 macOS 上验证，需要批准安装 XQuartz。
- **GSSAPI（C14）**：需要一个测试用的 Kerberos 领域。
- **辅助功能**：输入法与 VoiceOver 需要在真机上测试。
- **发行**：签名与公证需要凭据。
- **旧版 Windows 的 ConPTY**：是否随应用分发新版 `conpty.dll` 和 `OpenConsole.exe`，以消除 Server 2022 这一代系统上的句柄泄漏。
- **SIXEL**：是否允许在 CSP 中加入 `wasm-unsafe-eval`。

## 推荐下一步顺序

1. **合并到 `main`**：取得一次全绿的集成 CI 后，向用户申请把 `p0/integration` 合并到 `main`。Windows 句柄泄漏已定位，见 [ConPTY 决策记录](p0/WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位)。
2. **把探针接入界面**：SCP、agent 转发和 tmux 还只有 Rust 侧。每个新增的 IPC 命令都要在三处登记。
3. **原生验收**：Linux 和 Windows 的原生 WebView 冒烟已经在 CI 上跑通。macOS WKWebView 只能在真机上手工验证，例如 SFTP 面板和 Telnet 标签页。
4. **互操作**：
   - Linux CI 上卡住连接的取消测试。
5. **VT 差距**：设备身份、DECSCL 与 OSC 52 已用解析器钩子补上；其余按[终端内核决策](p0/TERMINAL_CORE_ADR.zh-CN.md)推进。
6. **终端内核**：按[技术调整决策](p0/TERMINAL_CORE_ADR.zh-CN.md)推进。启用 SIXEL 需要先评审 CSP 中的 `wasm-unsafe-eval`。
7. **功能矩阵**：静态复核发现 G13 的快捷键、F08/F09（SCP）、Q06 的“无限”与上游 README 的说法矛盾。如果决定调整验收文字，三处台账要一起修改，并重跑结构验证。

## 本地验证命令

```sh
export PATH="$HOME/.cargo/bin:$PATH"
M=apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path $M -- --check
cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path $M --all-features            # 单元与集成测试；部分测试需要本机 tmux 或 ssh-agent，缺少时会跳过
node --test tests/fixtures/ssh-sftp/rust-client.test.mjs          # 真实 OpenSSH：SFTP 与 SCP
node --test tests/fixtures/ssh-sftp/fixture.test.mjs
node --test tests/fixtures/ssh-terminal/rust-client.test.mjs      # 真实 OpenSSH shell
(cd apps/desktop && npm run build && npx playwright test)        # 需要先另开 npm run dev
```

补充说明：
- **Windows 代码的本机检查**：可以对 `x86_64-pc-windows-msvc` 目标运行 clippy，用桩头文件、假 `ar` 和假 `rc` 跳过 C 依赖的链接。这只做类型检查，Windows 测试只能在 CI 上运行。本机的辅助脚本在临时目录中，不会长期保留，需要时重新搭建。
- **Playwright 开发服务器**：多个子代理并行时，各自用不同的 Vite 端口，例如 1431–1437，并使用不提交的本地 Playwright 配置，避免互相关闭对方的 1420 服务。

提交前执行 `git diff --check`。

## 交接后的工作方式

- 继续执行，不要只给计划；先检查现状，再做最小可验证改动。
- 进度用中文简短报告：当前动作、证据、未验证范围、下一步。
- 不要询问已经明确的技术路线或视觉方向。
- 不要重置工作区，不要覆盖其他模型或用户的未提交改动。
- 任何外部发布、删除、覆盖、发送消息等不可逆操作，都要在具体结果准备好后再确认；普通本地开发、测试、文档和提交可以直接继续。
- 代码改动后必须让 Rust reviewer 或 verifier 独立审查。审查结论与处理方式要写进 RESULTS。
- 新增 Tauri 命令要改三处：`lib.rs`、`build.rs`、`capabilities/main.json`。
- 只改文档的提交在标题末尾加 `[skip ci]`。
