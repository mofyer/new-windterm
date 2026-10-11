# Telnet 与 Raw TCP 终端标签（C02、C03）

日期：2026-10-11。状态：**桌面端可从「新建连接」或命令面板打开 Telnet / Raw TCP 终端标签。Rust 侧用测试内 TCP 服务器验证，前端用 IPC stub 验证；未与真实 telnetd 或网络设备互操作，不代表 C02/C03 验收。**

## 已实现

### 后端：[`net_terminal.rs`](../../apps/desktop/src-tauri/src/net_terminal.rs)

- `NetTerminals` 作为 Tauri 托管状态，提供 `net_open`、`net_write`、`net_resize`、`net_ack`、`net_close` 五个命令，已在 `lib.rs` 的 `generate_handler!`、`build.rs` 的 `AppManifest::commands` 和 `capabilities/main.json` 三处注册。
- `net_open({ target: { kind: "telnet" | "raw", host, port }, id, cols, rows, onEvent })`：`target` 拒绝未知字段；`id` 是前端生成的 UUID，open 一开始就登记，因此连接期间也能用 `net_close(id)` 取消。比 open 先到达的 close 会让随后的 open 直接失败。
- 主机和端口按 `ssh.rs` 的 `validate` 规则校验（仅字母、数字和 `.-:`，最长 253，端口非 0），终端尺寸 1–1000。TCP 连接超时 15 秒，超时、拒绝和取消分别返回 `… connection timed out / failed / cancelled`。
- 输出与 PTY、SSH 共用 `PtyEvent` 字节流：每块不超过 4096 字节，未 ACK 上限 64 KiB / 64 块，ACK 必须按序（重复 ACK 幂等），最早一块 15 秒未 ACK 即报错。预算用尽时不再读 socket，由 TCP 流控把压力传回对端，进程内不另外缓冲。
- 输入每次 1–4096 字节，进入 16 项有界队列；队列满时 `net_write` 等待（最多 15 秒），压力因此传回前端的 64 KiB 输入上限，而不是让大段粘贴失败。Telnet 协商应答和用户输入共用一个有界、有序的发送队列，单次 socket 写入超时 15 秒。
- Telnet 使用 [`telnet.rs`](../../apps/desktop/src-tauri/src/telnet.rs)：`receive` 拆出的数据交给终端，应答写回 socket；输入经 `send` 转义（0xFF 双写，非二进制模式下单独的 CR 发送为 CR LF）；`resize` 在协商 NAWS 后发送新尺寸。TTYPE 报告 `xterm-256color`，初始尺寸取 open 时的列数和行数。
- Raw TCP 双向原样传字节；`net_resize` 只做校验，不发送任何内容。
- 生命周期：对端关闭和本地关闭都报告 `exit`（code 为 null），读写失败或 ACK 超时报告 `error`；结束时立即关闭写方向（发送 FIN）再释放 socket。`write/resize/ack/close` 都校验所属窗口；含连接中在内最多 8 个会话；页面开始加载和窗口销毁时调用 `close_owner`，应用退出时调用 `shutdown`。会话结束后的 ACK 和 close 按最近 128 个 ID 幂等成功，ID 不能重复使用。

### 前端

- 「新建连接」对话框新增「打开 Telnet / Raw TCP 终端 · 仅桌面」，命令面板也有同名入口。对话框在 [`net-terminal.ts`](../../apps/desktop/src/net-terminal.ts)：类型、主机、端口（默认 23），按与后端相同的字符集先行校验，不保存任何输入。浏览器中显示“仅在 Tauri 桌面程序中可用”，字段和连接按钮禁用。
- `main.ts` 增加第三种远程会话模式 `net`，复用 `terminalChannel`、`sendInput` 和按序 ACK 路径，仅按模式选择 `pty_`/`ssh_`/`net_` 命令前缀。标签名、状态和错误都通过 `textContent` 写入，远端输出只进入 xterm。连接中关闭标签会调用 `net_close(id)`，open 迟到返回时再关闭一次；`beforeunload` 关闭已连接和连接中的会话。

## 证据

macOS arm64 本机（Rust 1.99.0）：

| 命令 | 结果 |
| --- | --- |
| `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --all-features net_terminal` | 6 passed |
| `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test net_terminal --all-features` | 7 passed（其中一项在 macOS 按设计跳过，见下） |
| `npx playwright test tests/e2e/net-terminal-contract.spec.ts` | 10 passed（IPC stub） |
| `cargo fmt … -- --check`、`cargo clippy --locked … --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test --locked … --all-targets --all-features`（全量） | lib 71 passed / 4 ignored，`net_terminal` 7，`ssh_terminal` 14，`tmux_control` 1 |
| `npm run build`；全量 Playwright（独立 Vite 端口） | 通过；143 passed |

单元测试（`net_terminal.rs`）：流控边界、乱序与重复 ACK；主机/端口/尺寸/类型校验；用永不完成的连接器验证连接中关闭、页面重载（`close_owner`）、先 close 后 open、`shutdown` 后拒绝 open 并释放名额；连接超时；不再有网络输出时扣住 ACK 仍会在超时后报错并关闭 socket。

集成测试（[`tests/net_terminal.rs`](../../apps/desktop/src-tauri/tests/net_terminal.rs)，测试内 loopback 服务器）：

- Telnet 服务器主动提出 WILL ECHO/SGA、DO NAWS/TTYPE 并回显：收到 TTYPE `xterm-256color` 和 NAWS 100×30；在一个汉字中间切成两次写入的 UTF-8 原样往返；含 0xFF 的数据在两个方向都按协议转义并还原；终端输出逐字节等于“问候 + 回显”，没有协商字节；调整到 255×40 时 NAWS 中的 255 被正确双写；其它窗口的 write/resize/ack/close 被拒绝；`quit` 后服务器关闭，终端收到 `exit`，之后的 ACK/close 幂等。
- Raw TCP 回显服务器：0x00–0xFF 全部字节与 UTF-8 文本双向原样；resize 不产生任何字节；本地关闭后服务器读到 EOF（FIN）。
- 背压：服务器持续写 16 MiB，扣住 ACK 800 ms 期间送达终端不超过 64 KiB / 64 块且之后不再增加，服务器因 TCP 流控停在约 0.8 MiB；恢复 ACK 后 16 MiB 按内容逐字节完整到达，随后对端关闭报告 `exit`。
- 输入背压：对端从不读取时，约 0.66 MiB 被 socket 缓冲和有界队列接收后，下一次 `write` 进入等待而不是报错；关闭后等待的写入方返回 `Network terminal is closed`。
- 对端主动关闭报告 `exit`；8 个会话后第 9 个被拒绝；`close_owner` 关闭全部 8 个会话（服务器看到 8 次 FIN），之后同一窗口可以重新打开；`shutdown` 后关闭现有会话并拒绝新会话；连接被拒绝、非法主机、端口 0 和非法尺寸都不建立会话。
- 连接中关闭：Linux 在监听端口 accept 队列占满时丢弃新的 SYN，`connect` 卡在内核中，测试在此期间关闭并断言 open 返回 `cancelled`。macOS（以及 Windows）对溢出连接直接回 RST，无法制造卡住的连接，该测试跳过，由上面的单元测试覆盖；Linux 上的结果尚待 CI。

Playwright（`tests/e2e/net-terminal-contract.spec.ts`）：浏览器入口仅提示不可用；`net_open` 参数形状；分块 UTF-8 先渲染再按序 `net_ack`，HTML 只作为文本显示；输入按 4096 字节有序拆分、64 KiB 上限；窗口尺寸变化走 `net_resize`；非法主机/端口不发起 IPC；连接中关闭与迟到结果的关闭；远端退出、open 前的错误和 open 失败后不再发送输入；关闭失败保留标签；卸载时关闭两种状态的会话；8 个会话上限；全程不调用 `pty_`/`ssh_` 命令。

## 限制与未验收

- **未与真实 telnetd、交换机或路由器等网络设备做互操作测试**；测试服务器只是测试内协议夹具。浏览器测试使用 IPC stub，不代表 WebView 与原生端到端。
- **没有会话保存**，也没有 WindTerm 2.7.0 Telnet/TCP 配置项的对照；无代理、无 TLS、无自动重连。
- **只处理 UTF-8**：xterm.js 按 UTF-8 解码，GBK、Big5、Latin-1 等编码的远端会显示乱码；Telnet 未实现 CHARSET 等编码协商。
- 未实现 Telnet Linemode 和本地回显：服务器不回显时输入不可见。Raw TCP 不做本地回显，回车按 CR 发送。
- Telnet 输入按每次 IPC（最多 4096 字节）独立转义：粘贴内容恰好在 CR 与 LF 之间被切开时，会多发送一个 LF。
- 旧文档请求的防护与本机 PTY 相同：按窗口关闭，没有 SSH 的 scope token。页面重载后才到达的旧 `net_open` 仍会连接，只能等 ACK 超时、对端关闭或应用退出时结束。
- 主机名解析使用系统解析器；连接中取消时，解析线程可能继续运行到结束，但结果会被丢弃。
- 未在 Windows、Linux 本机运行；IME、VoiceOver 和高输出性能未验收。
