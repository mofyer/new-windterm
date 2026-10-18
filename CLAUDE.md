# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

用 Rust + Tauri 2 + xterm.js 独立重构 WindTerm 2.7.0 的**完整**功能（Apache-2.0）。macOS Apple Silicon 优先，但 Windows/Linux 在架构与测试层面同步考虑，不能因先做 macOS 删减平台或功能。**P0 已于 2026-10-15 经独立技术评审和用户确认关闭，当前进入 P1。** 已有实现仍多为原型或探针，不能视为完整产品验收：
- 真实本地 PTY（Windows 默认 `cmd.exe` ConPTY；P1 第三批已验收固定候选 Shell 的发现与选择，第四批已集成会话环境变量与 locale，正在完成跨平台验收，各平台实际验收范围以 P1 执行记录为准）。
- 受限交互 SSH。
- 只读 SFTP 文件面板。
- Telnet / Raw TCP 终端标签。
- 多个 SSH 网络探针（转发、代理、SCP 等）。
- 苹果风 UI 原型。

P0 已关闭并合并；P1 前三批已获单独批准并合并，main 产品基线为 `780a10e`。第三批 Shell 发现/选择已交付；第四批会话环境变量与 locale 已实现，本机门禁与 macOS 有限原生验收通过，但 Windows 旧 Shell 场景曾出现目录查询停滞，根因仍未确定。最新 CI、追踪与验收状态以 [P1 执行记录](docs/p1/RESULTS.zh-CN.md) 为准。第四批尚未获 main 合并批准，不能把第三批授权或“继续”当作第四批合并授权。切片范围见 [P1 计划](docs/p1/PLAN.zh-CN.md)。

当前优先级与交接要点见 [docs/HANDOFF.zh-CN.md](docs/HANDOFF.zh-CN.md)；当前测试结果与未完成项以 [P1 执行记录](docs/p1/RESULTS.zh-CN.md) 为准，[P0 记录](docs/p0/RESULTS.zh-CN.md)保留历史证据。

### 不能误报的边界

文档和提交说明必须区分“已验证”与“未验证”，不得写成：

- WindTerm 功能已对齐、P1 已通过或产品可用（P0 已获批准关闭，可如实记录）；
- SFTP 已完成（只读浏览面板加写操作原型，只对 OpenSSH 夹具与 IPC stub 验证；无原生 WKWebView 实测、递归、续传）；
- Windows 终端已完整可用（已有 cmd.exe 生命周期及 WebView2 原生冒烟证据，本批 Windows PowerShell 仅覆盖身份/目录/退出重开；PowerShell 7、完整 PowerShell、输入法和真实用户环境验收未完成）；
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

仓库根 `.cargo/config.toml` 默认设置 `RUST_TEST_THREADS=2`，CI 同样固定为 2：同一测试进程的 loopback 认证共享产品的 4 个密钥读取名额，不能按 CPU 数量无界并行独立测试。测试内部的通道并发、容量饱和与取消断言保持；产品容量不变。专门做压力诊断时可显式覆盖并发值，但不能把预期外的容量失败忽略后记为门禁通过。从仓库之外调用 `cargo --manifest-path` 不会自动读取这里的配置，此时须显式传 `RUST_TEST_THREADS=2`。

```sh
M=apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path $M -- --check
cargo check  --locked --manifest-path $M --all-targets --all-features
cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings
cargo test   --locked --manifest-path $M --lib --all-features            # 单元测试
cargo test   --locked --manifest-path $M --test ssh_terminal --all-features  # loopback SSH 协议集成测试
cargo test   --locked --manifest-path $M --lib --all-features <名称过滤>   # 单个测试
cargo run    --locked --manifest-path $M --features dev-tools --bin pty_probe   # 真实 Unix PTY 探针
cargo run    --locked --manifest-path $M --features dev-tools,pty-readiness --bin pty_probe
```

`src/bin` 下四个测试/探针二进制由 `dev-tools` feature 门控（`pty_diagnose` 另需 `pty-diagnostics`），release `.app` 不含它们；新增 `src/bin` 二进制要写显式 `[[bin]]` 并加同样门控（`tests/release_bins.rs` 检查），不要给 `tauri build` 传 `dev-tools`。`bundle.active` 为 false，在 `apps/desktop` 下 `npm run tauri build -- --bundles app` 才打 `.app`（未签名公证）；最低 macOS 13.3。见 [docs/p0/RELEASE.zh-CN.md](docs/p0/RELEASE.zh-CN.md)。

受控 SSH/SFTP 夹具（仓库根目录，Node 内置 test runner，无需 npm 依赖；需要系统 OpenSSH，仅 macOS/Linux 非 root，Windows 跳过）：

```sh
node --test tests/fixtures/ssh-sftp/fixture.test.mjs      # 夹具自身的启动/清理回归
node --test tests/fixtures/ssh-sftp/rust-client.test.mjs  # 自行以 dev-tools 构建 ssh_probe 与 lib 测试二进制；启动夹具并以 P0_SSH_FIXTURE_* 环境变量运行被 #[ignore] 的 Rust 真实夹具测试（含只读 SFTP 验收）
node --test tests/fixtures/ssh-terminal/fixture.test.mjs  # 系统 OpenSSH 交互 PTY 夹具自检
node --test tests/fixtures/ssh-terminal/rust-client.test.mjs  # Rust ssh_open 对真实 OpenSSH shell 的互操作（ignored 测试）
node --test tests/fixtures/ssh-terminal/x11-client.test.mjs    # X11 转发对 OpenSSH + Xvfb（仅 Linux，其它平台跳过）
P0_AGENT_HOME_SOCKET=1 node --test tests/fixtures/ssh-terminal/agent-client.test.mjs  # agent 转发对 OpenSSH；OpenSSH 10.1+ 会在真实 ~/.ssh/agent/ 下建临时套接字，默认跳过
```

VT 兼容矩阵：`tests/e2e/vt-matrix.spec.ts` 记录 xterm.js 6.0.0 的 63 项 VT 行为（结论见 `docs/p0/VT_MATRIX.zh-CN.md`）。

P0 概念验证（隔离，未接生产界面）：`src/terminal-compat/` 下的 `history-archive.ts`（压缩历史）、`fold-view.ts`（折叠/大纲）、`free-type.ts`（草稿编辑）、`vt52-stream.ts`，各有同名 Playwright spec；Rust 的 `tmux_control.rs` 有单元测试和 `tests/tmux_control.rs`（需要本机 tmux，否则跳过）。

桌面手工测 SSH 终端：在 `apps/desktop/src-tauri` 运行 `cargo run --locked --features dev-tools --bin ssh_terminal_fixture`（保持 stdin 打开），按打印的端口、临时 key 路径和指纹填入桌面「打开真实 SSH 终端」，用户名 `fixture`，支持输入 `unicode`/`size`/`large`/`burst`。夹具清理规则见 [docs/p0/SSH_SFTP_FIXTURE.zh-CN.md](docs/p0/SSH_SFTP_FIXTURE.zh-CN.md)：不要执行全局 `pkill sshd`，不要只凭旧 pid 文件杀进程。

Windows 专属代码在 macOS 上只能做类型检查：`tools/wincheck/wincheck.sh`（对 `x86_64-pc-windows-msvc` 执行 clippy，用桩头文件跳过链接）；Windows 测试只在 CI 上运行。多代理协作方式与续做中断任务的方法见 [docs/p0/AGENT_WORKFLOW.zh-CN.md](docs/p0/AGENT_WORKFLOW.zh-CN.md)。

提交前：`git diff --check`。

## 架构

当前只有一个 crate（`apps/desktop/src-tauri`，库名 `new_windterm_desktop`）和一个前端（`apps/desktop/src`）。[docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md) 末尾的 `crates/*` 分层只是后续建议，并不存在。

### IPC 与归属

- `src-tauri/src/lib.rs` 中的 Tauri 命令只是薄包装：每个命令接收 `WebviewWindow`，并把 `window.label()` 作为 owner 传入；所有会话都按窗口归属校验。页面开始加载时调用 `Sessions::reload_owner` 和 `Ssh::close_owner`，窗口销毁时关闭该窗口的会话，应用退出时 `shutdown()`。
- **新增命令要改三处**：`lib.rs` 的 `generate_handler!`、`build.rs` 的 `AppManifest::commands` 列表、`capabilities/main.json` 中的 `allow-<kebab-case 命令名>` 权限。只注册在 `generate_handler!` 而漏掉后两处时，Rust 测试照样通过，但 WebView 调用会被 ACL 拒绝。

### 终端字节流（PTY 与 SSH 共用）

PTY 或 SSH channel → Rust 有界队列 → `tauri::ipc::Channel<PtyEvent>` → 前端 `xterm.write` → 每块按 `sequence` 顺序调用 `pty_ack`/`ssh_ack`。`PtyEvent` 有 `data`/`exit`/`error` 三种，`data` 保持原始字节（每块 4096 字节，64 KiB / 64 块未 ACK 预算，ACK 超时 15 秒）。不要按网络块转 UTF-8，也不要在 Rust 再维护一份 vt100/alacritty 屏幕：xterm.js 是唯一的终端状态来源。

- `pty.rs`：`Sessions` 注册表（每窗口有代际 generation，最多 8 个会话）、reader/writer 线程、ACK 流控与子进程回收。
- `platform.rs`：按平台处理 shell、环境变量、Unix I/O 和 EOF（macOS zsh、Linux Bash、Windows `cmd.exe /D /Q /K`）。Windows 细节在 `platform_windows.rs`：kill-on-close Job Object 回收进程树；等待线程在子进程退出后关闭 pseudoconsole，使阻塞读取得到 EOF；会话关闭时终止 Job，而不是在 IPC 线程上关闭 pseudoconsole（可能阻塞）；reader 结束后要排空管道。ConPTY 启动时会发 `ESC[6n` 并等待回复，前端会暂存会话 ID 到达前的输入。Windows 测试在 `pty.rs` 的 `windows_tests` 中，只能在 Windows CI 上运行。
- Cargo features：`pty-readiness` 是默认关闭的 Unix poll/ACK 通知实验（默认构建仍是 5 ms 轮询）；`pty-diagnostics` 启用计时字段，并与 `dev-tools` 一起启用 `pty_diagnose` 二进制；`dev-tools` 只用于门控 `src/bin` 下的测试/探针二进制。

### 本地启动选项（第三批已验收，第四批集成中）

- 前两批已交付退出/失败后新建会话与可选绝对启动目录。第三批前端 `local-launch.ts` 通过 `pty_shells` 发现固定 ID 的候选，并将可选 `shell` 与 `cwd` 传给 `pty_open`；会话保留自己的启动选项，重新打开继承原选项，不读取后来修改的表单。默认按钮继续走原默认 Shell；浏览器演示不启动本机进程。
- 后端 `local_shell.rs` 负责固定路径发现、可执行文件检查和固定 argv，`LocalLaunchOptions` 将 Shell ID 与目录传到 `Sessions::open_with_options`，原入口保留为默认参数包装。Unix 候选为 `bash`、`zsh`、`pwsh`，Windows 为 `cmd`、`powershell`、`pwsh`；只检查列出的常见安装位置，不扫描 PATH，也不接受任意命令或可执行路径。发现列表报告不可用原因，每次打开/重开仍重新检查。
- 显式 Bash 使用 `--noprofile --norc -i`，Zsh 使用 `-f -i`，PowerShell 使用 `-NoLogo -NoProfile`，cmd 使用 `/D /Q /K`。Zsh 的系统 `zshenv` 仍会执行，PowerShell `-NoProfile` 不等于禁用历史记录。未配置新选项时，默认 Shell 的 argv/环境/cwd 保持原行为；用户自定义参数、启动配置持久化及 WSL/Git Bash/Cygwin/Clink 尚未交付。
- 第四批扩展 `pty_open` 的可选 `env` 条目数组与 `locale: { mode, variables }`。`local_environment.rs` 统一验证并仅修改子进程环境，值按字面传递，不作 shell 展开；普通变量最多 64 项，locale 最多 13 项，名称 64 字节、单值 4096 UTF-8 字节，两组按名称 + 值 + 2 的字节数合计最多 16 KiB。Unix 大小写敏感，Windows ASCII 大小写不敏感；拒绝重复、NUL、保留项和启动加载相关前缀，错误与 Debug 不输出变量值。`SHELL` 亦为保留项，防止 portable-pty 解析非法值时将其写入日志；具体名单以后端为准。
- locale 缺省或 `default` 加空列表保留原平台设置；`custom` 先移除默认 `LANG`/`LC_*` 再添加选定项，自定义空列表表示清空。`LC_ALL` 不能与其他 `LC_*` 并存，可与 `LANG` 并存且前者优先；不校验系统是否安装该 locale。Windows 只传递环境变量，不代表修改代码页或 PowerShell 显示语言。`PATH` 可覆盖，但不改变固定绝对路径的 Shell 选择。
- 前端以名称/值行编辑并为每个会话深复制配置；重开继承最初配置，不继承交互命令的修改、不重放输入。配置值只保留在应用内存，不进入状态文案、日志或持久设置；这不保证 Shell、后续用户命令或操作系统不会记录这些值，也不表示任意变量不会影响后续命令。
- 既有 cwd 校验、owner/generation、容量、ACK 与回收期限保持。Windows 继续采用产品既有的本地盘符目录限制，不能写成 PowerShell 本身不支持 UNC。目录或可执行文件最后校验与启动之间仍可能被外部改变，不能宣称消除 TOCTOU。第四批本机全量门禁及 macOS 有限原生验收已通过，第二轮跨平台 CI 因 Windows 旧 Shell 场景失败而未通过，根因诊断与最终综合验收尚待完成，实际结论以 P1 执行记录为准；T34 和 P1 整阶段未完成。

### SSH 流程（`ssh.rs`，交互通道在 `ssh_terminal.rs`，通过 `#[path]` 挂为 `ssh::terminal`）

1. `ssh_context` → 取得当前窗口代际的 `scopeToken`；
2. `ssh_probe` → 连接并返回实际 Ed25519 主机指纹及一次性 `challengeToken`（有 TTL）；
3. 用户确认后三选一：`ssh_accept`（固定命令，返回有界 stdout/stderr 与退出码）、`ssh_open`（PTY/shell 接入上述字节流）、`ssh_sftp_open`（列出登录目录，成功后签发窗口内、仅内存的 SFTP 浏览授权 `grantToken`）。之后的 `ssh_sftp_list/metadata/read` 与写操作 `ssh_sftp_set_writable/change/upload/download`（需先对授权开启写入，见 `ssh_sftp_write.rs`、`docs/p0/SFTP_WRITE.zh-CN.md`）使用授权，每次仍重新连接（经授权绑定的连接路线）、固定校验已确认的主机密钥并重新读取私钥；`ssh_sftp_close` 吊销授权。只有带安全证据的失败（主机密钥变化、公钥被拒、rekey）才吊销，错误信息以 `reconnect and verify the host again` 结尾，前端据此回到重新核对指纹；
4. 前端为每个操作生成 `operationId`，可用 `ssh_cancel` 取消；`ssh_reject` 丢弃 challenge。

主机信任：`ssh_probe` 的 Challenge 带 `trust: new | known | changed`，与应用数据目录下 OpenSSH 格式的 `known_hosts`（`known_hosts.rs`）比较；`changed` 的 challenge 不能被消费，只有独立命令 `ssh_trust_replace` 能更新，`ssh_trust_save` 只接受 `new`。前端对 `known` 自动继续。

认证（`ssh_auth.rs`）：`Credential` 为 `key`（可带口令）/ `password` / `agent` / `keyboardInteractive`（预填回答）/ `keyboardInteractivePrompted`（连接时经 `onAuth` 通道逐轮提示，前端用 `ssh_auth_respond` 按窗口、操作 ID、轮次作答，见 `ssh_kbdint.rs`），只在 `ssh_accept/ssh_open/ssh_sftp_open` 传入（probe 不认证），用 `Zeroizing` 持有。服务端拒绝凭据会吊销 SFTP 授权，本地失败（agent 不可用、口令错误）不吊销。Rust 侧保留无凭据的 `accept/open/sftp_open` 供测试使用，IPC 走 `*_with` 版本。

约束：私钥以绝对路径指定、由 Rust 有界读取，仅 Ed25519/ECDSA（未开启 russh `rsa` 特性）；不保存凭据；russh 重协商时不会重新检查主机密钥，因此 rekey 被显式拒绝。`sftp.rs` 直接驱动 `RawSftpSession`：目录在 4096 项或 1 MiB 文件名处提前停止（只约束保留部分，每页仍会完整解码）；读取最多 64 KiB 且长度须与 `stat` 一致。

### 其它模块

- `net_terminal.rs`：Telnet / Raw TCP 终端标签（`net_open/write/resize/ack/close`），复用同一 `PtyEvent` 字节流和 ACK；Telnet 协商在 `telnet.rs`。
- SSH 子模块（经 `#[path]` 挂在 `ssh` 下）：`ssh_forward.rs`（本地/动态/远端转发与跳板）、`ssh_proxy.rs`（HTTP CONNECT、SOCKS5、ProxyCommand）、`ssh_route.rs`（连接对话框选择的路线：直连、HTTP/SOCKS5 代理、ProxyCommand、单跳跳板；路线绑定进 challenge 与 SFTP 授权，见 `docs/p0/SSH_ROUTES.zh-CN.md`）、`ssh_scp.rs`。`KeyCheck` 的 `Routes` 拒绝服务端主动打开的通道，只放行登记过的 `forwarded-tcpip`（最多 64 个）与显式开启的 agent。端口转发已有界面（`ssh_tunnels.rs` 与前端 `port-forward.ts`，经 `ssh_forward_add/remove/list` 在已打开的 SSH 终端上增删），SCP 与 tmux 还没有界面。
- `modem.rs`：不依赖 I/O 的 XMODEM/YMODEM，未接入任何传输。`tmux_control.rs`：tmux 控制模式解析。

### 前端

- `main.ts` 用一个大的 `innerHTML` 模板构建整个工作台，并维护 `Session` Map（`mode`: `demo` | `pty` | `ssh`）。`isTauri()` 决定是走真实 IPC 还是浏览器演示。「新建连接」表单和传输队列是模拟数据；文件面板默认显示 `#file-demo` 模拟内容，只读 SFTP 连接后切换到 `sftp-panel.ts` 渲染的 `#sftp-view`。
- `ssh-verification.ts`：SSH 指纹确认与连接对话框流程；`terminal.ts`：xterm 工厂（启用 Unicode 11 宽度，并挂上 `terminal-compat/vt-adapters.ts` 的 VT 回复适配：设备身份、DECSCL、DECRQSS、DECOM 下的 CPR、默认关闭的 OSC 52 写入）；`terminal-compat/vt52-stream.ts`：隔离的 VT52 实验，未接入生产终端。
- 终端输出、文件名、窗口标题都是不可信数据，不能拼进 `innerHTML`。
- E2E 通过 `page.addInitScript` 注入 `window.__TAURI_INTERNALS__`（以及 `isTauri`）来 stub IPC；新增前端 IPC 调用时，相关 spec 中的 stub 也要同步更新。

## 约定

- 依赖全部精确锁定（Cargo 用 `=x.y.z`，npm 用精确版本），并提交 `Cargo.lock`/`package-lock.json`；构建统一使用 `--locked` / `npm ci`。
- 文档为中文（`*.zh-CN.md`）。改动代码后要同步更新相关文档，写明提交、测试范围、平台和未验收边界。提交使用 conventional 格式（`feat:`/`fix:`/`docs:`/`test:`/`ci:`）；记录 CI 证据这类只改文档的提交通常在标题末尾加 `[skip ci]`。CI（`.github/workflows/p0-cross-platform.yml`，macOS arm64 / Linux x64 / Windows x64）只在 `apps/desktop/**`、`rust-toolchain.toml` 或 workflow 变更时触发。
- 功能基线已于 2026-10-12 由用户批准冻结（`scope_frozen: true`），冻结时 161 个稳定 ID，随后用户批准 T35–T37，现共 164 个 ID，分布在 `docs/FEATURE_PARITY.zh-CN.md`、`docs/p0/BASELINE.zh-CN.md`、`docs/p0/baseline.json` 三处，三者必须一致；修改后运行 [docs/p0/BASELINE_EVIDENCE.zh-CN.md](docs/p0/BASELINE_EVIDENCE.zh-CN.md)「结构验证」一节的三段脚本。冻结后的变更规则见[冻结方案](docs/p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md)：新能力只能以新 ID 补入并需用户批准；不删除 ID，也不复用编号（已排除 G43，暂缓 C23、C28、G54、G55）；改措辞要附证据和理由。
- 视觉方向（浅色 Silver Soft UI、深色 Carbon Dark）已获用户认可，见 [docs/p0/DESIGN_SYSTEM.zh-CN.md](docs/p0/DESIGN_SYSTEM.zh-CN.md)。不要重新讨论技术路线或视觉方向。
- `.reference/`（已 gitignore）存放 WindTerm 上游源码/README 和 2.7.0 x86_64 dmg，仅用于行为对照；不得复制上游代码、图标或二进制（许可证尚未逐文件核查）。
