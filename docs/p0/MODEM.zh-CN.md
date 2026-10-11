# X/Y/ZModem 文件传输可行性探针（F10、F11、F12）

日期：2026-10-11。状态：**XModem（F10）与 YModem（F11）只有与传输无关的 Rust 状态机和回环单元测试；ZModem（F12）只有下文的 ADR，没有代码。三项均无终端/串口接入、无界面、无真实对端互操作，均未完成，不代表验收。** [功能对齐矩阵](../FEATURE_PARITY.zh-CN.md)中 F10–F12 的状态仍是“未实现”，本次未改动。

## 代码位置

| 文件 | 内容 |
| --- | --- |
| [`modem.rs`](../../apps/desktop/src-tauri/src/modem.rs) | 公共常量、`Limits`/`Failure`/`Status`、CRC-16/XMODEM 与校验和、文件名校验、帧构造、发送端 `Sender` |
| [`modem/receiver.rs`](../../apps/desktop/src-tauri/src/modem/receiver.rs) | 接收端 `Receiver`、YMODEM 头解析 |
| [`modem/tests.rs`](../../apps/desktop/src-tauri/src/modem/tests.rs) | 23 项单元测试（回环与故障注入） |

`lib.rs` 只增加 `pub mod modem;`，未新增任何依赖，也没有新增 Tauri 命令。

状态机是 sans-IO 的：调用方把从对端读到的字节交给 `feed()`，按自定的时间单位调用 `tick()`（建议 1 tick = 1 秒），把 `take_output()` 返回的字节写给对端，用 `status()` 查询 `Running`/`Done`/`Failed(原因)`，`cancel()` 主动取消。状态机内部不读写任何 I/O、不睡眠，所以后续可以挂在 PTY、SSH channel 或串口上。构造函数：`Sender::xmodem` / `Sender::xmodem_1k` / `Sender::ymodem`，`Receiver::xmodem` / `Receiver::ymodem`。

## 已实现的协议行为

| 方面 | 行为 |
| --- | --- |
| 帧 | `SOH`（128 字节）或 `STX`（1024 字节）、块号、块号反码、数据、校验。块号按 256 回绕 |
| 校验 | CRC-16/XMODEM（多项式 0x1021、初值 0，`"123456789"` 得 0x31C3），大端两字节；或 8 位算术校验和 |
| 校验和回退 | XMODEM 接收端先发 `C` 请求 CRC，共 3 次无响应后改发 NAK 请求校验和；一旦收到过任何帧，CRC/校验和模式就固定，后续超时不再回退。发送端收到 NAK 启动时使用校验和并只用 128 字节块 |
| XMODEM-1K | 剩余数据多于 896 字节时用 1K 块，否则用 128 字节块（两种方式填充量相同） |
| YMODEM 批量 | 每个文件先发块 0：`文件名 NUL 十进制长度`，其余补 NUL；头超过 128 字节时用 1K 块。数据块用 1K。全部文件发完后发送全 NUL 的块 0 结束批量。接收端对第一个 EOT 回 NAK、第二个回 ACK，再发 `C` 请求下一个头。YMODEM 只支持 CRC |
| 填充 | YMODEM 按头中的长度截掉 0x1A 填充，文件真实结尾的 0x1A 会保留；XMODEM 没有长度信息，接收结果保留填充到 128 字节的整数倍，无法区分真实结尾的 0x1A 与填充 |
| 重传 | 由接收端驱动：坏帧回 NAK；超时回 NAK（文件尚未开始时重发 `C` 或 NAK）。发送端只在收到 NAK 时，或在文件头、EOT、文件首块未确认时收到 `C` 时重发；`C` 必须在发送该帧之后至少经过 1 个 tick 才生效，同一 tick 内到达的 `C` 视为与该帧在途中交错的过期请求。发送端自身超时只计数。重复块（之前的 ACK 丢失）再次 ACK，但不重复写入 |
| 过期应答 | 发送端根据某个应答发出新帧后，同一次 `feed()` 中剩余的字节一定是对端在看到新帧之前发出的，因此丢弃（仍识别 CAN CAN）；接收端回 NAK 后同理 |
| 重试上限 | 连续的 NAK 或超时超过 `max_retries`（默认 10）即失败，并向对端发送 CAN |
| 取消 | 连续两个 CAN 视为对端取消（双向都支持），单个 CAN 当作噪声；本端取消或出错时发送 5 个 CAN（X/YMODEM 需要 2 个，ZMODEM 需要 5 个）；收到对端取消时不回发 CAN |
| 超时 | 由调用方调用 `tick()` 推进，默认连续 10 个 tick 无有效输入算一次超时 |
| 大小上限 | `max_file_bytes` 默认 16 MiB（XMODEM 接收端按含填充的字节数计算），`max_files` 默认 64，整批内存上限 `max_total_bytes` 默认 64 MiB。发送端构造时检查；接收端在头中声明的长度超限、未声明长度时累计超限、文件数超限或整批超限时，用 CAN 终止。YMODEM 文件比声明的短，或在已收满后又收到数据块，报 `SizeMismatch` |
| 文件名 | 必须是 UTF-8，长度为 1–255 字节，不能为 `.`，不能含 `/`、`\`、NUL、控制字符或 `..` 子串。发送端构造时和接收端解析头时都会检查。规则偏保守：`a..b` 这类名称和非 UTF-8 名称（例如 GBK）都会被拒绝 |
| 块号错误 | 期望的块号会被接收；前一块的块号按重复块处理；其他块号报 `SequenceError`，并用 CAN 终止 |

## 已验证

环境：macOS 27.0.1 arm64，Rust 1.99.0（`rust-toolchain.toml`）。先按 CI 的做法在 `apps/desktop` 执行 `npm ci && npm run build` 生成 `dist`（已被 gitignore，否则 `tauri::generate_context!` 无法编译测试）。在仓库根目录执行：

```sh
M=apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path $M -- --check                                          # 通过
cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings  # 无警告
cargo test --locked --manifest-path $M --all-features --lib modem                # 23 passed
cargo test --locked --manifest-path $M --all-targets --all-features              # lib 53 passed、1 ignored（原有）；tests/ssh_terminal 10 passed
```

23 项测试（`modem::tests::`）：

| 测试 | 覆盖内容 |
| --- | --- |
| `crc_and_checksum_match_reference_values` | CRC-16/XMODEM 标准校验值 0x31C3、校验和、帧布局 |
| `xmodem_crc_loopback_keeps_data_with_sub_padding` | XMODEM-CRC：0、1、127、128、1024、1025、70 000 字节回环，结果等于原数据加 0x1A 填充到 128 的倍数；帧长均为 133，帧数为 ⌈n/128⌉。70 000 字节共 547 块，覆盖块号回绕 |
| `xmodem_1k_loopback_uses_long_blocks_and_keeps_padding` | XMODEM-1K：同样 7 种大小；大于 896 字节时确实使用 STX 帧 |
| `ymodem_batch_loopback_restores_two_files_exactly` | YMODEM：每种大小各传两个文件（其中一个文件名为 `中文 名-<n>.txt`），文件名、声明长度、内容逐字节一致；块 0 恰好发 3 次（两个头加批量结束） |
| `long_ymodem_header_uses_a_1k_block_0` | 255 字节的中文文件名使头超过 128 字节，块 0 改用 1K（STX）帧，回环结果一致 |
| `byte_by_byte_delivery_matches_bulk_results` | 三种模式 × 7 种大小 × 两个文件，双向逐字节投递，结果与整块投递一致 |
| `ymodem_size_trims_padding_but_keeps_real_trailing_sub_bytes` | YMODEM 保留文件真实结尾的 0x1A；XMODEM 下，以 0x1A 结尾的文件与不含这些字节的文件收到的结果完全相同（明确记录的局限） |
| `checksum_fallback_when_crc_requests_are_ignored` | 丢弃所有 `C` 后，XMODEM 和 XMODEM-1K 都回退到校验和 128 字节帧（132 字节），数据正确 |
| `crc_mode_is_kept_once_the_sender_has_answered` | 第 1 块连续 3 次损坏后又整块丢失，接收端超时：仍保持 CRC 模式（所有帧 133 字节），数据正确 |
| `corrupted_block_is_retransmitted_and_data_stays_exact` | 三种模式下第 2 块首次发送时篡改 1 字节：该块恰好发送 2 次，最终数据一致 |
| `dropped_ack_is_recovered_without_duplicating_data` | 丢弃 XMODEM/1K 的第 3 个 ACK，以及 YMODEM 的头 ACK 和数据块 ACK：均在接收端超时后靠 NAK 或 `C` 恢复，数据不重复 |
| `sender_cancel_aborts_receiver_with_can_can` | 传输中途发送端取消：接收端得到 `RemoteCancel`，不回发 CAN，不保留未完成文件 |
| `receiver_cancel_aborts_sender_with_can_can` | 传输中途接收端取消：发送端得到 `RemoteCancel`；之后的输入和 tick 不再产生输出 |
| `lone_can_is_treated_as_line_noise` | 双向各插入一个单独的 CAN，传输仍完成 |
| `silent_peer_exhausts_bounded_retries` | 对端无响应：发送端 110 tick 后失败并发出 CAN；接收端依次发出 3 次 `C`、若干 NAK，最后发出 CAN |
| `persistent_corruption_aborts_after_bounded_retries` | 同一块每次都损坏：接收端有限次重试后以 `RetriesExhausted` 终止，发送端收到 CAN，不保留文件 |
| `file_names_are_validated_on_both_sides` | 合法和非法文件名；发送端拒绝 `../x`；接收端遇到 `../etc/passwd`、`a/b`、非 UTF-8 头时用 CAN 终止 |
| `malformed_headers_and_wrong_block_numbers_abort` | 长度为负数、长度溢出、头无 NUL、块号错误 |
| `size_and_count_limits_are_enforced` | 发送端和接收端的单文件大小、文件数和整批总量上限 |
| `ymodem_receiver_confirms_eot_twice_and_rejects_short_files` | EOT 先 NAK 后 ACK；重复 EOT 再次确认；零字节文件；内容比声明短时报 `SizeMismatch` |
| `stale_reply_in_the_same_read_is_ignored_after_a_retransmit` | 同一次读取中收到 `NAK, ACK`：只重发一次，不误把过期的 ACK 当成新块的确认 |
| `lost_final_ack_is_reported_by_the_sender_not_hidden` | 最后一个 ACK 丢失：接收端已有完整文件，发送端如实报告 `RetriesExhausted`（固定这一已知局限） |
| `stale_start_request_does_not_duplicate_the_first_block` | 第 1 块发出后同一 tick 内又收到 `C`：不重发；经过 1 个 tick 后再收到 `C`：重发第 1 块 |

变异检查：用临时脚本（未提交）每次注入 1 个缺陷，运行上述测试，再恢复源码。13 个缺陷都至少让 1 项测试失败：重发不输出帧、跳过 CRC 校验、YMODEM 不按长度截断、单个 CAN 即终止、发送端不丢弃过期应答、CRC 多项式错误、重复块回 NAK、允许 `..`、不回退到校验和、YMODEM 对第一个 EOT 直接 ACK、发送端已应答后仍回退到校验和、过期 `C` 立即重发、取消整批总量上限。

独立审查：另一个只读审查代理没有发现 CRITICAL/HIGH 问题，指出了 3 个 MEDIUM 问题，均已修复并补了测试：发送端应答后接收端超时仍可能回退到校验和；跨读取的重复 `C` 会让发送端超前一块；整批内存没有上限。

### lrzsz 互操作：未进行

本机的 `which sz rz sx rx sb rb lsz lrz lsx lrx` 均找不到对应程序，按要求没有安装。因此**没有任何与真实 X/YMODEM 实现互操作的证据**，只有本仓库发送端与本仓库接收端之间的回环测试。两端使用同一份实现，对协议细节的误解（例如 YMODEM 头格式、EOT 两次确认、把 `C` 当作重发请求）会同时出现在两端，测试照样通过。下一步应由测试环境安装 lrzsz，作为外部对端单独运行，不随应用分发。分别通过管道和 PTY 运行它的 X/YMODEM 收发模式（sx/rx/sb/rb，或 sz/rz 的对应参数），双向比对哈希，并覆盖取消和中断。

## 终端集成设计（未实现）

1. **分流位置**：在 PTY 读线程（`pty.rs`）或 SSH channel 读取处（`ssh_terminal.rs`），在数据进入有界队列和 `Channel<PtyEvent>` 之前，增加一个按会话划分的路由：终端模式走现有 `data` 路径；传输模式把原始字节交给状态机。分流必须发生在任何文本解码和 xterm 之前，这与“Rust 不转 UTF-8、xterm 是唯一终端状态”的约定一致；串口同样如此。
2. **识别传输开始**：
   - X/YMODEM 没有自动启动序列，需要由用户在界面上选择“发送/接收 XModem/YModem”（WindTerm 2.7.0 的具体入口需对照上游）。用户先在远端运行接收或发送命令，再在本地选择对应操作；本地接收端创建后立即发出 `C`。
   - ZMODEM 可以自动识别：远端 `sz` 发出 ZRQINIT 十六进制头 `**\x18B00`，后跟 12 个十六进制字符，表示本地应接收；远端 `rz` 发出 ZRINIT 头 `**\x18B01…`，表示本地应选择文件发送。检测器要跨读取块保留尾部字节，命中后这些字节不能交给 xterm。`cat` 一个恰好包含该序列的文件会误触发，因此需要确认步骤或设置开关（对照上游设置）。
3. **暂停 xterm 输出**：进入传输模式后不再向前端发送 `data` 块，前端显示传输层和进度；键盘输入不再发往远端（只保留取消），避免按键混入二进制流。现有每块 ACK 流控只用于终端模式；传输模式下的读取由状态机同步消费，仍需保持有界。
4. **写出**：`take_output()` 通过同一个 writer 写到 PTY master、SSH channel 或串口。要求链路二进制透明：SSH channel 是透明的；远端 TTY 由 sz/rz 设为 raw 模式；本地 PTY 场景需确认行规程不改写字节；Telnet 需要把 0xFF 写成两次（IAC）；串口如果启用 XON/XOFF 软件流控，XMODEM 数据中的 0x11/0x13 会被吞掉，因此传输期间必须关闭软件流控，或改用会转义这两个字节的 ZMODEM。
5. **定时**：由异步定时器（例如每 1 秒）调用 `tick()`，状态机本身不睡眠。
6. **进度**：`Sender::transferred()`/`Receiver::transferred()` 加上 YMODEM 声明的长度即可得到进度。需要新增传输事件（新的 `PtyEvent` 变体或单独的 Channel），供前端传输队列使用；目前传输队列是模拟数据。
7. **取消**：用户取消时调用 `cancel()` 写出 CAN；对端取消时得到 `RemoteCancel` 并提示用户。之后切回终端模式。ZMODEM 的惯例是在 CAN 之后追加退格，以清除远端回显。
8. **结束后的剩余字节**：状态机结束后，同一次 `feed()` 中剩余的字节（例如 shell 提示符，或 ZMODEM 的 `OO`）目前会被丢弃。集成时需要让 `feed()` 返回已消费的字节数，把剩余部分交还给 xterm。
9. **落盘**：当前文件全部保存在内存中（受 `max_file_bytes` 与 `max_total_bytes` 限制）。正式实现应流式写入用户选择目录下的临时文件，校验文件名后再原子重命名，并处理覆盖确认、权限、Windows 保留名（CON、NUL 等）和末尾的点或空格。上游 2.7.0 的 release 记录过 Windows 下 ZModem 非 ASCII 文件名的问题（见 [BASELINE](BASELINE.zh-CN.md)），文件名正确与内容正确要分开验收。
10. **不可信数据**：文件名、远端提示都不能拼进 `innerHTML`。

## ADR：ZMODEM（F12）

状态：提议，未实现。

### ZMODEM 需要什么

- **帧头**：`ZPAD ZPAD ZDLE`（`**` 加 0x18）后跟格式字节：`A` 是 CRC-16 二进制头，`B` 是十六进制头（ASCII，以 CR、LF|0x80 结束，除 ZACK、ZFIN 外再加 XON），`C` 是 CRC-32 二进制头。头内容是 1 字节类型加 4 字节参数（文件偏移或标志位）。
- **帧类型**：会话协商用 ZRQINIT、ZRINIT、ZSINIT；文件传输用 ZFILE、ZSKIP、ZRPOS、ZDATA、ZEOF、ZFIN；控制与出错用 ZACK、ZNAK、ZABORT、ZFERR、ZCAN；可选的 ZCRC、ZCHALLENGE、ZCOMMAND、ZFREECNT 等。
- **数据子包**：数据以 `ZDLE` 加结束类型分段：ZCRCE（帧结束，不需要应答）、ZCRCG（帧继续，不需要应答）、ZCRCQ（帧继续，需要 ZACK）、ZCRCW（帧结束，需要 ZACK）。这是流式全双工设计，接收端在 ZRINIT 中通告缓冲区大小和能力位（全双工、可边收边写、CRC-32、转义控制字符等）。
- **ZDLE 转义**：ZDLE 本身、XON/XOFF（含高位版本）、DLE 等字节必须转义成 `ZDLE` 加 `字节 ^ 0x40`；可协商转义所有控制字符。正因如此，ZMODEM 能穿过 XON/XOFF 软件流控，而 XMODEM 不能；但 ZDLE 不转义 0xFF，经 Telnet 时仍需做 IAC 转义。
- **崩溃恢复**：ZFILE 的转换和管理选项包括续传、覆盖、追加、较新者优先等；接收端用 ZRPOS 指定从哪个偏移开始或重发。发送端需要能随机访问文件，接收端需要比对已有的部分文件。
- **CRC**：同时需要 CRC-16 与 CRC-32。
- **取消**：至少 5 个 CAN；会话结束时交换 ZFIN，最后发送 `OO`。
- **自动启动与终端切换**：如上文所述，在 xterm 之前检测 `**\x18B00`/`**\x18B01`，把字节流从 xterm 切到协议引擎，结束后再切回，并把剩余字节交还 xterm。

### 许可证约束

- 本仓库是 Apache-2.0。lrzsz 是 GPL（具体版本以所用 tar 包中的 COPYING 为准），**不得把 lrzsz 的源码复制、翻译或逐段改写进本仓库**，移植或翻译属于衍生作品。实现 ZMODEM 时，实现者不应参考 lrzsz 源码，只依据公开的协议说明（Forsberg 的 ZMODEM 协议文档以及 XMODEM/YMODEM 参考文档）描述的行为编写；这些文档本身的再分发条件也要核查，不能复制其中的示例代码。
- lrzsz 可以作为外部测试对端：在测试机上安装，作为独立进程运行，不随应用分发。是否随应用捆绑 GPL 二进制需要单独做法律评估，[可行性调查](FEASIBILITY.zh-CN.md)已注明尚未批准。
- 2026-10-11 用 `cargo search`/`cargo info` 查到的 crates.io 候选（只看了元数据，没有审查代码，也没有引入）：

| crate | 版本 / 声明许可证 | 结论 |
| --- | --- | --- |
| `zmodem2` | 0.7.3 / MIT OR Apache-2.0（codeberg jarkko/zmodem2，rust-version 1.85） | 许可证兼容，首选评估对象 |
| `lrzsz2` | 0.7.1 / GPL-3.0-or-later | 不可并入 |
| `rmodem` | 0.1.1 / AGPL-3.0-or-later | 不可并入 |
| `rzsz` | 0.1.5 / 声明 Apache-2.0，但自述为 “a modern Rust rewrite of lrzsz” | 如果是 GPL 代码的翻译，其许可证声明可能不成立；完成出处审查之前不得采用 |
| `ymodem` | 0.1.1 / MIT | 只覆盖 X/YMODEM；本探针未使用 |

### 推荐路径

1. F10/F11 继续以本探针（自研、无依赖、sans-IO）为基础，下一步做传输接入和 lrzsz 互操作测试。
2. ZMODEM 先评估 `zmodem2`：审查代码出处与质量，确认能否以 sans-IO 方式接入，检查 CRC-32、ZRPOS 续传、取消、维护状态，并与 lrzsz 做双向互操作。满足要求后按仓库约定精确锁定版本（`=x.y.z`）并提交 `Cargo.lock`。
3. 如果 `zmodem2` 不满足要求，就在本仓库按公开协议文档 clean-room 实现 sans-IO 的 ZMODEM，接口与本模块一致（`feed`/`tick`/`take_output`/`cancel`），实现者不参考 lrzsz、lrzsz2、rzsz 的源码。
4. 后备方案（不作为默认）：调用用户自行安装的本机 lrzsz 作为协议引擎。缺点是依赖用户环境、Windows 不可用、与会话字节流的桥接复杂；这种方式也不能随应用捆绑。
5. 无论选哪条路径，验收都必须包括：经 SSH 连接受控测试服务器和本地 PTY 时与 lrzsz `sz`/`rz` 双向互操作；中断后通过 ZRPOS 续传；自动启动检测及误报处理；取消后回到可用终端；哈希验证二进制完整性；中文和空格文件名；零字节和大文件；Windows 上非 ASCII 文件名。

## 未完成与不能误报的边界

- F10、F11、F12 均未完成，不能写成“已支持 X/Y/ZModem”。
- 没有接入 PTY、SSH、串口或 Telnet，没有 IPC 命令、前端、进度事件，也没有磁盘写入。
- 没有任何真实对端互操作（本机未安装 lrzsz）。
- 只在本机 macOS arm64 运行了单元测试；这次提交未推送，CI 尚未运行，Linux/Windows 没有实测（代码不含平台相关部分）。
- XMODEM 无法区分文件真实结尾的 0x1A 和填充。
- X/YMODEM 的应答不带块号。如果重复的控制字节在链路中积压（例如链路延迟接近超时时间，接收端超时发出的 NAK 与迟到的帧在途中交错），发送端可能“超前一块”。当前的缓解措施：发送端超时不重发；丢弃同一次读取中的过期应答；发出帧后同一 tick 内收到的 `C` 不触发重发；块号错位时用 CAN 终止。NAK 无法用同样方式过滤，因为正常的“坏帧 NAK”也会紧接着到达。但 XMODEM 在最坏情况下可能截断文件尾部而不报错（YMODEM 会因长度不符报错）。目前只在上面列出的故障注入场景下验证过。
- 最后一个 ACK 丢失时，接收端已有完整文件，但发送端报告 `RetriesExhausted`；接收端完成后不会继续等待并重发确认。
- 发送端以 CRC 帧开始后，如果接收端才改用校验和（发送端响应很慢时），发送端不会降级，传输会失败。
- 不支持 YMODEM-g，不支持 1K 块与校验和的组合；YMODEM 启动时收到 NAK 会被忽略；头中的修改时间、权限、序列号既不发送也不解析。
- 如果发送端在帧中途取消，接收端会把收到的 CAN 当作数据，只能等 CRC 失败或超时后结束。
- 状态机结束后，同一次 `feed()` 中剩余的字节会被丢弃（见集成设计第 8 条）。
- 文件全部保存在内存中（单文件和整批都有上限）；文件名规则偏保守，未检查 Windows 保留名。
- 默认超时（10 tick）、重试次数（10）和 `C` 请求次数（3）没有和 WindTerm 2.7.0 或 lrzsz 对照过。
