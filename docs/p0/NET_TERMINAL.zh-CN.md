# Telnet 与 Raw TCP 终端标签（C02、C03）

日期：2026-10-11，2026-10-12 补充真实 telnetd 互操作。状态：**桌面端可从「新建连接」或命令面板打开 Telnet / Raw TCP 终端标签。Rust 侧用测试内 TCP 服务器验证，并在 macOS 本机以非 root 用户对 Apple telnetd 308（Homebrew）做了 loopback 互操作测试（被测程序是测试脚本，不是 login(1)）；前端用 IPC stub 验证；未与网络设备或其它 telnetd 实现互操作，不代表 C02/C03 验收。**

## 已实现

### 后端：[`net_terminal.rs`](../../apps/desktop/src-tauri/src/net_terminal.rs)

- `NetTerminals` 作为 Tauri 托管状态，提供 `net_open`、`net_write`、`net_resize`、`net_ack`、`net_close` 五个命令，已在 `lib.rs` 的 `generate_handler!`、`build.rs` 的 `AppManifest::commands` 和 `capabilities/main.json` 三处注册。
- `net_open({ target: { kind: "telnet" | "raw", host, port }, id, cols, rows, onEvent })`：`target` 拒绝未知字段；`id` 是前端生成的 UUID，open 一开始就登记，因此连接期间也能用 `net_close(id)` 取消。比 open 先到达的 close 会让随后的 open 直接失败。
- 主机和端口按 `ssh.rs` 的 `validate` 规则校验（仅字母、数字和 `.-:`，最长 253，端口非 0），终端尺寸 1–1000。TCP 连接超时 15 秒，超时、拒绝和取消分别返回 `… connection timed out / failed / cancelled`。
- 输出与 PTY、SSH 共用 `PtyEvent` 字节流：每块不超过 4096 字节，未 ACK 上限 64 KiB / 64 块，ACK 必须按序（重复 ACK 幂等），最早一块 15 秒未 ACK 即报错。预算用尽时不再读 socket，由 TCP 流控把压力传回对端，进程内不另外缓冲。
- 输入每次 1–4096 字节，进入 16 项有界队列；队列满时 `net_write` 等待（最多 15 秒），压力因此传回前端的有序输入队列（积压上限 16 MiB，见 [INPUT_PATHS](INPUT_PATHS.zh-CN.md)），而不是让大段粘贴失败。Telnet 协商应答和用户输入共用一个有界、有序的发送队列，单次 socket 写入超时 15 秒。
- Telnet 使用 [`telnet.rs`](../../apps/desktop/src-tauri/src/telnet.rs)：`receive` 拆出的数据交给终端，应答写回 socket；输入经 `send` 转义（0xFF 双写，非二进制模式下单独的 CR 发送为 CR LF）；服务器侧进入 BINARY 后，收到的 CR NUL 按两个数据字节保留，否则丢弃 CR 后的 NUL；`resize` 在协商 NAWS 后发送新尺寸。TTYPE 报告 `xterm-256color`，初始尺寸取 open 时的列数和行数。
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

Playwright（`tests/e2e/net-terminal-contract.spec.ts`）：浏览器入口仅提示不可用；`net_open` 参数形状；分块 UTF-8 先渲染再按序 `net_ack`，HTML 只作为文本显示；输入按 4096 字节有序拆分、超过 16 MiB 积压的单次输入整体拒绝；窗口尺寸变化走 `net_resize`；非法主机/端口不发起 IPC；连接中关闭与迟到结果的关闭；远端退出、open 前的错误和 open 失败后不再发送输入；关闭失败保留标签；卸载时关闭两种状态的会话；8 个会话上限；全程不调用 `pty_`/`ssh_` 命令。

## 真实 telnetd 互操作（2026-10-12）

### 环境与运行方式

- macOS 27.0.1 arm64，Rust 1.99.0，当前用户 uid 502（非 root），未使用 sudo。
- telnetd：Homebrew `telnetd` 308，路径 `/opt/homebrew/opt/telnetd/sbin/telnetd`（sha256 `9ef10439efdb1d887b0978ccdbecf7eb06407354d994e0fed2838a47e7a3a2c1`）。二进制自带标识 `PROGRAM:telnetd PROJECT:remote_cmds`，源码 ID 为 FreeBSD `telnetd.c 1.29`；man page 日期 2005-01-09。getopt 串为 `d:hknp:S:u:U46D:l`，即支持 `-p loginprog`、`-D options|report|netdata|ptydata`、`-h`。
- 运行方式：测试在 127.0.0.1 上建立一对 TCP 连接，把服务端那一端作为 telnetd 的 stdin/stdout（inetd 风格），每个测试一个 telnetd 进程。没有用 `-debug [port]` 独立模式：按 FreeBSD 源码它以 `AI_PASSIVE` 监听通配地址，违反“只绑定 loopback”的约束（未实测）。
- telnetd 默认 exec setuid root 的 `/usr/bin/login`，login 会以 euid 0 运行。测试一律用 `-p` 换成测试临时目录（0700）中的 `/bin/sh` 脚本，因此测试中没有任何进程获得 root。脚本有三种：仿 login 提示（`login: `，读入用户名后 `stty -echo` 再打印 `Password:`，读完后打印 `Login incorrect` 并退出）；raw 模式字节回显（`stty raw -echo` 后把收到的字节按十六进制打印）；交互 shell（`LC_ALL=en_US.UTF-8 PS1='p0$ ' exec /bin/sh -i`）。非 root 下得到真实 shell 的办法就是 `-p` 指向这个脚本：shell 运行在 telnetd 分配的 pty 上，但不经过 login(1)。脚本先把自己的 PID 写入文件，测试据此确认程序结束，失败时由测试结束 telnetd 和该进程组。
- 探索阶段（不属于自动化测试）曾手动让 telnetd 执行系统 `/usr/bin/login`：进程为 `login -p`，euid 0、ruid 502；看到 `login: `，不存在的用户名立即得到 `Login incorrect`，用户名 `nobody` 得到 `Password:` 且口令不回显。只用过不存在的用户名和 `nobody` 加错误口令，从未提供真实凭据；这些进程都已结束。

命令（仓库根目录；需要 `brew install telnetd`，或用 `P0_TELNETD=<路径>` 指定）：

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features --test telnetd_interop -- --ignored --nocapture
```

测试带 `#[ignore]`，默认 `cargo test` 只把它们记为 ignored；用 `--ignored` 运行时，找不到 telnetd 或以 root 运行会打印 `skipped: …` 后通过。整个文件 `#![cfg(unix)]`。

| 命令 | 结果 |
| --- | --- |
| 上面的 `--ignored` 命令 | 6 passed，约 1.1 秒；按评审意见修改夹具后又连续运行 11 次，全部通过，结束后没有残留的 telnetd、脚本进程或临时目录 |
| `P0_TELNETD=/nonexistent/telnetd … -- --ignored` | 6 passed，全部打印 `skipped: telnetd not found …` |
| `cargo test --locked … --lib --all-features telnet::` | 4 passed（含新回归测试） |
| `cargo fmt … -- --check`、`cargo clippy --locked … --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test --locked … --all-targets --all-features`（全量） | lib 132 passed / 6 ignored，`net_terminal` 7，`telnetd_interop` 6 ignored，`ssh_terminal` 14，`ssh_routes` 5，`ssh_kbdint` 5，`release_bins` 3，`tmux_control` 1 |

### 已验证（[`tests/telnetd_interop.rs`](../../apps/desktop/src-tauri/tests/telnetd_interop.rs)，夹具在 [`tests/support/telnetd.rs`](../../apps/desktop/src-tauri/tests/support/telnetd.rs)）

`telnet::Codec` 层（测试直接用 codec 读写 socket）：

- 协商不循环，`login: ` 完整到达：telnetd 依次请求 TTYPE、TSPEED、XDISPLOC、NEW-ENVIRON、OLD-ENVIRON，再提出 WILL SGA、DO ECHO、DO LINEMODE、DO NAWS、WILL STATUS、DO LFLOW，最后 WILL ECHO、DO TIMING-MARK。客户端应答逐条等于 `WILL TTYPE, WONT TSPEED, WONT XDISPLOC, WONT NEW-ENVIRON, WONT OLD-ENVIRON, SB TTYPE IS xterm-256color, DO SGA, WONT ECHO, WONT LINEMODE, WILL NAWS, SB NAWS 100×30, DONT STATUS, WONT LFLOW, DO ECHO, WONT TIMING-MARK`；双方都没有重复的选项命令，提示出现后 300 ms 内不再有任何字节。
- TTYPE：`-D options` 的带内调试输出显示 `td: recv suboption TERMINAL-TYPE IS "xterm-256color"`，且 `TERMINAL-TYPE SEND` 只出现一次，即第一次应答就被接受。shell 中 `$TERM` 为 `xterm-256color`。
- NAWS：在 telnetd 发出 DO NAWS 之前，codec 每收一个字节都先调用一次 `resize`，结果均为空；首个 NAWS 为 100×30（telnetd 报告 `NAWS 0 100 (100) 0 30 (30)`），调整到 132×43 后 telnetd 报告新尺寸。
- WILL ECHO / WILL SGA 分别以 DO ECHO / DO SGA 接受，`server_echoes()` 为真；用户名 `alice` 由服务器回显一次后出现 `Password:`，此时服务器回显仍为开，键入的口令不回显；回车后程序退出、telnetd 关闭连接。
- 字节路径（raw 模式回显程序）：输入 `x FF y CR z CR LF NUL w LF` 在线路上为 `x FF FF y CR LF z CR LF NUL w LF`，pty 实际读到 `78 ff 79 0d 7a 0d 00 77 0a`，即 telnetd 还原了 IAC 并去掉了 CR 后的 LF。程序输出 `a CR NUL b CR FF c CR LF` 在线路上为 `a CR NUL NUL b CR NUL FF FF c CR LF`，codec 还原为程序原样的字节。
- BINARY：telnetd 308 不会主动提出 BINARY，测试先发送 `IAC DO BINARY`、`IAC WILL BINARY`，codec 随后看到的 WILL/DO BINARY 与服务器主动提出时相同。此时输入 `x CR y CR LF FF` 只把 FF 双写，pty 读到 `78 0d 79 0d 0a ff`；telnetd 原样发送程序的 CR NUL，终端收到 `a CR NUL b`。

`NetTerminals` 层（`open/write/resize/ack/close` 与记录用 sink，中间加一个只监听 127.0.0.1 的记录代理）：

- 代理扣住 telnetd 的 `IAC DO NAWS`，此时 `net_resize(120, 40)` 不产生任何 NAWS 字节；放行后客户端的首个 NAWS 就是 120×40，之后 132×43 也送达。客户端应答序列与 codec 层相同，双方都没有重复命令。
- 横幅中的 CR NUL 到终端为 CR，终端输出不含 NUL 和 IAC，`login: ` 是最后的输出；用户名回显、`Password:` 与口令不回显同上；程序退出后终端收到 `exit`（远端关闭），之后的 ACK 和 close 幂等。
- 交互 shell：`stty size` 先报告 `30 100`，`net_resize(132, 43)` 后报告 `43 132`；在汉字中间切成两次写入的 `echo 中文🌏é` 回显和输出都完整；`printf 'a\rb\377c\n'` 在线路上是 `a CR NUL b FF FF c`，终端收到 `a CR b FF c`；在 shell 中切到 raw 模式后，输入 IAC、CR、CR LF、NUL 到 pty 的字节与 codec 层一致。
- 本地关闭：`net_close` 后终端收到 `exit`，代理看到客户端 FIN，telnetd 随即退出（状态码 1）。
- 大量输出：shell 以 raw 模式 `cat` 一个约 234 KiB 的文件（每个字节值，以及 CR NUL、CR LF、CR IAC、连续 IAC、单独 CR），在 64 KiB ACK 预算下逐字节一致到达（线路上约 248 KB）。Ctrl-C 作为普通数据经 telnetd 送到 pty，`sleep 30` 在 5 秒内被中断；`exit` 后终端收到 `exit`。

### 发现并修复的问题

- **BINARY 模式下丢弃 CR 后的 NUL**：`Codec` 接受服务器的 WILL BINARY，但仍把 CR NUL 中的 NUL 当作 RFC 854 的填充字节丢掉，二进制数据因此被改动。用 telnetd 复现：BINARY 下终端收到 `a CR b` 而不是 `a CR NUL b`。修复后只在服务器未进入 BINARY 时丢弃 CR 后的 NUL；回归测试为 `telnet::tests::binary_mode_keeps_nul_after_cr_and_sends_bare_cr`（未修复时失败）和上面的 BINARY 互操作测试。同时更正了 `send` 的文档注释（此前写成单独 CR 发送为 CR NUL，实际发送 CR LF）。

### 观察到的 telnetd 行为（不是本项目的问题）

- telnetd 308 把 pty 主端（`/dev/ptmx`）泄漏给了它启动的程序（`lsof` 显示 shell 持有 fd 3 = `/dev/ptmx`），因此客户端断开、telnetd 退出后 pty 不会挂断，程序收不到 SIGHUP 并继续运行。本地关闭测试中 shell 都是由测试结束的；程序自行退出的场景不受影响。以 root 经 inetd 运行时是否相同未验证。
- 非 BINARY 模式下 telnetd 总把不跟 LF 的 CR 发成 CR NUL，并把 0xFF 双写；客户端发来的 CR LF 和 CR NUL 都只把 CR 写入 pty。
- telnetd 退出码为 1（程序退出或客户端 FIN 两种情况都一样）。

### 仍未验证

- **真实 login(1) 认证和登录会话**：login 是 setuid root，自动化测试不执行它；`-p` 得到的是测试脚本启动的非登录 shell，不经过 login、PAM、utmpx、motd 和用户的 shell 配置。上面的 shell 结果说明的是 telnetd 的 pty 与协议层，不代表真实登录流程。
- LINEMODE 与 kludge linemode：客户端拒绝 LINEMODE、对 DO TIMING-MARK 回答 WONT，telnetd 因此停留在字符模式；`-l`、`-k` 未在测试中运行，也没有本地行编辑和本地回显。
- AUTHENTICATION、ENCRYPT：telnetd 308 在本机没有提出这两个选项，未验证。TSPEED、XDISPLOC、NEW-ENVIRON、OLD-ENVIRON 一律拒绝，所以 USER、LANG 等变量不会传给远端；测试中的 UTF-8 locale 由脚本自己设置。
- 服务器主动提出 BINARY 的情形只能由客户端先请求来模拟。
- 未与 GNU inetutils、BusyBox 等其它 telnetd，或交换机、路由器等网络设备互操作；没有在 Linux、Windows 上运行；CI 中没有安装 telnetd，这些测试不在 CI 中运行。
- 测试直接调用 Rust API，不经过 WebView、xterm.js 渲染、IME 或真实的前端 ACK 时序。

## 限制与未验收

- **未与交换机、路由器等网络设备或其它 telnetd 实现做互操作测试**；真实 telnetd 只测了 macOS 上的 Apple telnetd 308，且被测程序是测试脚本，不是 login(1)（见上节）。其余服务器是测试内协议夹具。浏览器测试使用 IPC stub，不代表 WebView 与原生端到端。
- **没有会话保存**，也没有 WindTerm 2.7.0 Telnet/TCP 配置项的对照；无代理、无 TLS、无自动重连。
- **只处理 UTF-8**：xterm.js 按 UTF-8 解码，GBK、Big5、Latin-1 等编码的远端会显示乱码；Telnet 未实现 CHARSET 等编码协商。
- 未实现 Telnet Linemode 和本地回显：服务器不回显时输入不可见。Raw TCP 不做本地回显，回车按 CR 发送。
- Telnet 输入按每次 IPC（最多 4096 字节）独立转义：粘贴内容恰好在 CR 与 LF 之间被切开时，会多发送一个 LF。
- 旧文档请求的防护与本机 PTY 相同：按窗口关闭，没有 SSH 的 scope token。页面重载后才到达的旧 `net_open` 仍会连接，只能等 ACK 超时、对端关闭或应用退出时结束。
- 主机名解析使用系统解析器；连接中取消时，解析线程可能继续运行到结束，但结果会被丢弃。
- 未在 Windows、Linux 本机运行；IME、VoiceOver 和高输出性能未验收。
