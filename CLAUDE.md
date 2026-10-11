# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

用 Rust + Tauri 2 + xterm.js 独立重构 WindTerm 2.7.0 的**完整**功能（Apache-2.0）。macOS Apple Silicon 优先，但 Windows/Linux 在架构与测试层面同步考虑，不能因先做 macOS 删减平台或功能。当前处于 **P0**：只有真实本地 PTY、受限交互 SSH、只读 SFTP IPC 和苹果风 UI 原型。

当前优先级与交接要点见 [docs/HANDOFF.zh-CN.md](docs/HANDOFF.zh-CN.md)；测试结果与未完成项以 [docs/p0/RESULTS.zh-CN.md](docs/p0/RESULTS.zh-CN.md) 为准。

### 不能误报的边界

文档和提交说明必须区分“已验证”与“未验证”，不得写成：

- WindTerm 功能已对齐、P0/P1 已通过、产品可用；
- SFTP 已完成（只有 Rust 只读 IPC，无前端面板、无真实 OpenSSH subsystem 验收、无写操作）；
- Windows 终端已支持（ConPTY 未实现，`platform::ensure_supported()` 明确拒绝 Windows PTY）；
- 浏览器 E2E 通过等于 Rust/原生成功（浏览器测试使用 IPC stub）；
- loopback russh 测试服务端通过等于真实 OS shell / OpenSSH 互操作通过；
- CI 或本地 debug 构建通过等于 IME、高输出性能、签名公证或发行验收。

## 常用命令

前端（在 `apps/desktop` 下）：

```sh
npm ci
npm run tauri dev   # 桌面窗口，自带 1420 开发服务器
npm run dev         # 仅浏览器演示 http://127.0.0.1:1420；不要与 tauri dev 同时运行
npm run build       # tsc --noEmit + vite build，即前端类型检查
```

浏览器 E2E（Playwright 配置没有 `webServer`，须先另开 `npm run dev`；使用系统 Chrome `channel: 'chrome'`）：

```sh
npx playwright test --config playwright.config.ts
npx playwright test tests/e2e/workspace.spec.ts -g "<测试标题>"   # 单个测试
```

Rust（在仓库根目录执行；工具链由 `rust-toolchain.toml` 固定为 1.99.0，本机可能需要 `export PATH="$HOME/.cargo/bin:$PATH"`）。始终带 `--all-features`，否则 `pty-diagnostics`/`pty-readiness` 下的代码不会被编译检查，CI 也是这样跑的：

```sh
M=apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path $M -- --check
cargo check  --locked --manifest-path $M --all-targets --all-features
cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings
cargo test   --locked --manifest-path $M --lib --all-features            # 单元测试
cargo test   --locked --manifest-path $M --test ssh_terminal --all-features  # loopback SSH 协议集成测试
cargo test   --locked --manifest-path $M --lib --all-features <名称过滤>   # 单个测试
cargo run    --locked --manifest-path $M --bin pty_probe                     # 真实 Unix PTY 探针
cargo run    --locked --manifest-path $M --features pty-readiness --bin pty_probe
```

受控 SSH/SFTP 夹具（仓库根目录，Node 内置 test runner，无需 npm 依赖；需要系统 OpenSSH，仅 macOS/Linux 非 root，Windows 跳过）：

```sh
node --test tests/fixtures/ssh-sftp/fixture.test.mjs      # 夹具自身的启动/清理回归
node --test tests/fixtures/ssh-sftp/rust-client.test.mjs  # 先 cargo build --bin ssh_probe；启动夹具并以 P0_SSH_FIXTURE_* 环境变量运行被 #[ignore] 的 Rust 真实夹具测试（含只读 SFTP 验收）
node --test tests/fixtures/ssh-terminal/fixture.test.mjs  # 系统 OpenSSH 交互 PTY 夹具自检
node --test tests/fixtures/ssh-terminal/rust-client.test.mjs  # Rust ssh_open 对真实 OpenSSH shell 的互操作（ignored 测试）
```

桌面手工测 SSH 终端：在 `apps/desktop/src-tauri` 运行 `cargo run --bin ssh_terminal_fixture`（保持 stdin 打开），按打印的端口、临时 key 路径和指纹填入桌面「打开真实 SSH 终端」，用户名 `fixture`，支持输入 `unicode`/`size`/`large`/`burst`。夹具清理规则见 [docs/p0/SSH_SFTP_FIXTURE.zh-CN.md](docs/p0/SSH_SFTP_FIXTURE.zh-CN.md)：不要执行全局 `pkill sshd`，不要只凭旧 pid 文件杀进程。

提交前：`git diff --check`。

## 架构

当前只有一个 crate（`apps/desktop/src-tauri`，库名 `new_windterm_desktop`）和一个前端（`apps/desktop/src`）。[docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md) 末尾的 `crates/*` 分层只是后续建议，并不存在。

### IPC 与归属

- `src-tauri/src/lib.rs` 中的 Tauri 命令只是薄包装：每个命令接收 `WebviewWindow`，并把 `window.label()` 作为 owner 传入；所有会话都按窗口归属校验。页面开始加载时调用 `Sessions::reload_owner` 和 `Ssh::close_owner`，窗口销毁时关闭该窗口的会话，应用退出时 `shutdown()`。
- **新增命令要改三处**：`lib.rs` 的 `generate_handler!`、`build.rs` 的 `AppManifest::commands` 列表、`capabilities/main.json` 中的 `allow-<kebab-case 命令名>` 权限。只注册在 `generate_handler!` 而漏掉后两处时，Rust 测试照样通过，但 WebView 调用会被 ACL 拒绝。

### 终端字节流（PTY 与 SSH 共用）

PTY 或 SSH channel → Rust 有界队列 → `tauri::ipc::Channel<PtyEvent>` → 前端 `xterm.write` → 每块按 `sequence` 顺序调用 `pty_ack`/`ssh_ack`。`PtyEvent` 有 `data`/`exit`/`error` 三种，`data` 保持原始字节（每块 4096 字节，64 KiB / 64 块未 ACK 预算，ACK 超时 15 秒）。不要按网络块转 UTF-8，也不要在 Rust 再维护一份 vt100/alacritty 屏幕：xterm.js 是唯一的终端状态来源。

- `pty.rs`：`Sessions` 注册表（每窗口有代际 generation，最多 8 个会话）、reader/writer 线程、ACK 流控与子进程回收。
- `platform.rs`：按平台处理 shell、环境变量、Unix I/O 和 EOF（macOS zsh、Linux Bash）；Windows 被拒绝，实现前须遵循 [docs/p0/WINDOWS_CONPTY_ADR.zh-CN.md](docs/p0/WINDOWS_CONPTY_ADR.zh-CN.md)。
- Cargo features：`pty-readiness` 是默认关闭的 Unix poll/ACK 通知实验（默认构建仍是 5 ms 轮询）；`pty-diagnostics` 启用 `pty_diagnose` 二进制与计时字段。

### SSH 流程（`ssh.rs`，交互通道在 `ssh_terminal.rs`，通过 `#[path]` 挂为 `ssh::terminal`）

1. `ssh_context` → 取得当前窗口代际的 `scopeToken`；
2. `ssh_probe` → 连接并返回实际 Ed25519 主机指纹及一次性 `challengeToken`（有 TTL）；
3. 用户确认后三选一：`ssh_accept`（固定命令，返回有界 stdout/stderr 与退出码）、`ssh_open`（PTY/shell 接入上述字节流）、`ssh_sftp_open`（列出登录目录，成功后签发窗口内、仅内存的 SFTP 浏览授权 `grantToken`）。之后的 `ssh_sftp_list/metadata/read` 使用授权，每次仍重新连接、固定校验已确认的主机密钥并重新读取私钥；`ssh_sftp_close` 吊销授权。只有带安全证据的失败（主机密钥变化、公钥被拒、rekey）才吊销，错误信息以 `reconnect and verify the host again` 结尾，前端据此回到重新核对指纹；
4. 前端为每个操作生成 `operationId`，可用 `ssh_cancel` 取消；`ssh_reject` 丢弃 challenge。

主机信任：`ssh_probe` 的 Challenge 带 `trust: new | known | changed`，与应用数据目录下 OpenSSH 格式的 `known_hosts`（`known_hosts.rs`）比较；`changed` 的 challenge 不能被消费，只有独立命令 `ssh_trust_replace` 能更新，`ssh_trust_save` 只接受 `new`。前端对 `known` 自动继续。

认证（`ssh_auth.rs`）：`Credential` 为 `key`（可带口令）/ `password` / `agent`，只在 `ssh_accept/ssh_open/ssh_sftp_open` 传入（probe 不认证），用 `Zeroizing` 持有。服务端拒绝凭据会吊销 SFTP 授权，本地失败（agent 不可用、口令错误）不吊销。Rust 侧保留无凭据的 `accept/open/sftp_open` 供测试使用，IPC 走 `*_with` 版本。

约束：私钥以绝对路径指定、由 Rust 有界读取，仅 Ed25519/ECDSA（未开启 russh `rsa` 特性）；不保存凭据；russh 重协商时不会重新检查主机密钥，因此 rekey 被显式拒绝。`sftp.rs` 直接驱动 `RawSftpSession`：目录在 4096 项或 1 MiB 文件名处提前停止（只约束保留部分，每页仍会完整解码）；读取最多 64 KiB 且长度须与 `stat` 一致。

### 前端

- `main.ts` 用一个大的 `innerHTML` 模板构建整个工作台，并维护 `Session` Map（`mode`: `demo` | `pty` | `ssh`）。`isTauri()` 决定是走真实 IPC 还是浏览器演示。「新建连接」表单和传输队列是模拟数据；文件面板默认显示 `#file-demo` 模拟内容，只读 SFTP 连接后切换到 `sftp-panel.ts` 渲染的 `#sftp-view`。
- `ssh-verification.ts`：SSH 指纹确认与连接对话框流程；`terminal.ts`：xterm 工厂（启用 Unicode 11 宽度）；`terminal-compat/vt52-stream.ts`：隔离的 VT52 实验，未接入生产终端。
- 终端输出、文件名、窗口标题都是不可信数据，不能拼进 `innerHTML`。
- E2E 通过 `page.addInitScript` 注入 `window.__TAURI_INTERNALS__`（以及 `isTauri`）来 stub IPC；新增前端 IPC 调用时，相关 spec 中的 stub 也要同步更新。

## 约定

- 依赖全部精确锁定（Cargo 用 `=x.y.z`，npm 用精确版本），并提交 `Cargo.lock`/`package-lock.json`；构建统一使用 `--locked` / `npm ci`。
- 文档为中文（`*.zh-CN.md`）。改动代码后要同步更新相关文档，写明提交、测试范围、平台和未验收边界。提交使用 conventional 格式（`feat:`/`fix:`/`docs:`/`test:`/`ci:`）；记录 CI 证据这类只改文档的提交通常在标题末尾加 `[skip ci]`。CI（`.github/workflows/p0-cross-platform.yml`，macOS arm64 / Linux x64 / Windows x64）只在 `apps/desktop/**`、`rust-toolchain.toml` 或 workflow 变更时触发。
- 功能对齐矩阵共 130 个稳定 ID，分布在 `docs/FEATURE_PARITY.zh-CN.md`、`docs/p0/BASELINE.zh-CN.md`、`docs/p0/baseline.json` 三处，三者必须一致；修改后运行 [docs/p0/BASELINE_EVIDENCE.zh-CN.md](docs/p0/BASELINE_EVIDENCE.zh-CN.md)「结构验证」一节的 Python 脚本。不要更改原有 117 个 ID。
- 视觉方向（浅色 Silver Soft UI、深色 Carbon Dark）已获用户认可，见 [docs/p0/DESIGN_SYSTEM.zh-CN.md](docs/p0/DESIGN_SYSTEM.zh-CN.md)。不要重新讨论技术路线或视觉方向。
- `.reference/`（已 gitignore）存放 WindTerm 上游源码/README 和 2.7.0 x86_64 dmg，仅用于行为对照；不得复制上游代码、图标或二进制（许可证尚未逐文件核查）。
