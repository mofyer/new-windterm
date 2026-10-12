# X/Y/ZModem 文件传输可行性探针（F10、F11、F12）

日期：2026-10-11；2026-10-12 补充 lrzsz 互操作测试、`zmodem2` 评估，以及 Ubuntu lrzsz 0.12.21rc 上一项测试失败的原因与测试修复。状态：**XModem（F10）与 YModem（F11）只有与传输无关的 Rust 状态机，已在 macOS arm64 上经 stdin/stdout 管道与真实 lrzsz 0.13.1 双向互操作，并据此修复了 2 个协议缺陷；Ubuntu 的 lrzsz 0.12.21rc 只在 CI 上运行过；ZModem（F12）仍没有产品代码，只有下文的 ADR 和一个只在测试中使用的第三方 `zmodem2` 评估探针。三项均未接入终端、PTY、SSH 或串口，没有界面，均未完成，不代表验收。** [功能对齐矩阵](../FEATURE_PARITY.zh-CN.md)中 F10–F12 的状态仍是“未实现”，本次未改动。三处基线台账中 F10–F12 的“无 lrzsz 互操作”“无代码”说明也未改动，需由台账维护者统一更新。

## 代码位置

| 文件 | 内容 |
| --- | --- |
| [`modem.rs`](../../apps/desktop/src-tauri/src/modem.rs) | 公共常量、`Limits`/`Failure`/`Status`、CRC-16/XMODEM 与校验和、文件名校验、帧构造、发送端 `Sender` |
| [`modem/receiver.rs`](../../apps/desktop/src-tauri/src/modem/receiver.rs) | 接收端 `Receiver`、YMODEM 头解析 |
| [`modem/tests.rs`](../../apps/desktop/src-tauri/src/modem/tests.rs) | 25 项单元测试（回环、故障注入、互操作发现的回归） |
| [`tests/modem_lrzsz.rs`](../../apps/desktop/src-tauri/tests/modem_lrzsz.rs) | 11 项与 lrzsz `sx`/`rx`/`sb`/`rb` 的互操作测试（默认 `#[ignore]`） |
| [`tests/support/lrzsz.rs`](../../apps/desktop/src-tauri/tests/support/lrzsz.rs) | 查找并启动 lrzsz、管道泵、私有临时目录、超时与清理；中断测试用的 `Held`（暂缓 `tick()`）与 `Watch`（记录对端节奏） |
| [`tests/zmodem_lrzsz.rs`](../../apps/desktop/src-tauri/tests/zmodem_lrzsz.rs) | 8 项 `zmodem2` 与 lrzsz `sz`/`rz` 的评估测试（默认 `#[ignore]`） |
| [`tests/support/zmodem2_probe.rs`](../../apps/desktop/src-tauri/tests/support/zmodem2_probe.rs) | 评估用驱动：把 `zmodem2` 接到同一个管道泵，并补上它不提供的取消检测、超时上限、文件名与大小检查；只是测试脚手架，不是产品集成设计 |

`lib.rs` 只有 `pub mod modem;`，没有新增 Tauri 命令。产品代码没有新增依赖；`zmodem2 =0.7.3` 只是开发依赖（`[dev-dependencies]`），只被 `tests/zmodem_lrzsz.rs` 使用，不进入库、应用或发行包（见[依赖清单](DEPENDENCIES.zh-CN.md)）。

状态机是 sans-IO 的：调用方把从对端读到的字节交给 `feed()`，按自定的时间单位调用 `tick()`（建议 1 tick = 1 秒），把 `take_output()` 返回的字节写给对端，用 `status()` 查询 `Running`/`Done`/`Failed(原因)`，`cancel()` 主动取消。状态机内部不读写任何 I/O、不睡眠，所以后续可以挂在 PTY、SSH channel 或串口上。构造函数：`Sender::xmodem` / `Sender::xmodem_1k` / `Sender::ymodem`，`Receiver::xmodem` / `Receiver::ymodem`。

## 已实现的协议行为

| 方面 | 行为 |
| --- | --- |
| 帧 | `SOH`（128 字节）或 `STX`（1024 字节）、块号、块号反码、数据、校验。块号按 256 回绕 |
| 校验 | CRC-16/XMODEM（多项式 0x1021、初值 0，`"123456789"` 得 0x31C3），大端两字节；或 8 位算术校验和 |
| 校验和回退 | XMODEM 接收端先发 `C` 请求 CRC，共 3 次无响应后改发 NAK 请求校验和；一旦收到过任何帧，就不再因超时回退。回退之后，如果第一块按校验和不通过，会多读 1 个字节再按 CRC 校验：对端可能是在我们回退后才读到更早的 `C`，于是发来 CRC 帧（lrzsz `sx --delay-startup` 实测会这样）；校验通过就改用 CRC。代价：真正以校验和发送、且首块损坏的对端，要等一次超时后才收到 NAK。发送端收到 NAK 启动时使用校验和，并只用 128 字节块 |
| XMODEM-1K | 剩余数据多于 896 字节时用 1K 块，否则用 128 字节块（两种方式填充量相同） |
| YMODEM 批量 | 每个文件先发块 0：`文件名 NUL 十进制长度`，其余补 NUL；头超过 128 字节时用 1K 块。数据块用 1K。全部文件发完后发送全 NUL 的块 0 结束批量。接收端对第一个 EOT 回 NAK、第二个回 ACK，再发 `C` 请求下一个头。YMODEM 只支持 CRC |
| 填充 | YMODEM 按头中的长度截掉 0x1A 填充，文件真实结尾的 0x1A 会保留；XMODEM 没有长度信息，接收结果保留填充到 128 字节的整数倍，无法区分真实结尾的 0x1A 与填充 |
| 重传 | 由接收端驱动：坏帧回 NAK；超时回 NAK（文件尚未开始时重发 `C` 或 NAK）。发送端只在收到 NAK 时，或在文件头、EOT、文件首块未确认时收到 `C` 时重发；`C` 必须在发送该帧之后至少经过 1 个 tick 才生效，同一 tick 内到达的 `C` 视为与该帧在途中交错的过期请求。发送端自身超时只计数。重复块（之前的 ACK 丢失）再次 ACK，但不重复写入 |
| 过期应答 | 发送端根据某个应答发出新帧后，同一次 `feed()` 中剩余的字节一定是对端在看到新帧之前发出的，因此丢弃（仍识别 CAN CAN）；接收端回 NAK 后同理 |
| 多余请求的回声 | 接收端记录已发出、尚未被完整帧应答的请求（`C`、NAK）。收到一个新块时，其余未应答的请求都可能让发送端再发一份该块；这些副本直接丢弃，不再 ACK。否则发送端会把多出来的 ACK 当成后续块的确认，从而“超前”（lrzsz `sb --delay-startup` 实测：每读到一个排队的 `C` 就重发一次块 0；旧实现最终以 `SequenceError` 失败，而 `sb` 报告成功）。回声紧跟在新块之后到达，所以任何一次超时都会把回声计数清零；之后再收到重复块，仍按“ACK 丢失”处理并再次 ACK。没有多余请求时行为与以前相同 |
| 重试上限 | 连续的 NAK 或超时超过 `max_retries`（默认 10）即失败，并向对端发送 CAN |
| 取消 | 连续两个 CAN 视为对端取消（双向都支持），单个 CAN 当作噪声；本端取消或出错时发送 5 个 CAN（X/YMODEM 需要 2 个，ZMODEM 需要 5 个）；收到对端取消时不回发 CAN |
| 超时 | 由调用方调用 `tick()` 推进，默认连续 10 个 tick 无有效输入算一次超时 |
| 大小上限 | `max_file_bytes` 默认 16 MiB（XMODEM 接收端按含填充的字节数计算），`max_files` 默认 64，整批内存上限 `max_total_bytes` 默认 64 MiB。发送端构造时检查；接收端在头中声明的长度超限、未声明长度时累计超限、文件数超限或整批超限时，用 CAN 终止。YMODEM 文件比声明的短，或在已收满后又收到数据块，报 `SizeMismatch` |
| 文件名 | 必须是 UTF-8，长度为 1–255 字节，不能为 `.`，不能含 `/`、`\`、NUL、控制字符或 `..` 子串。发送端构造时和接收端解析头时都会检查。规则偏保守：`a..b` 这类名称和非 UTF-8 名称（例如 GBK）都会被拒绝 |
| 块号错误 | 期望的块号会被接收；前一块的块号按重复块处理；其他块号报 `SequenceError`，并用 CAN 终止 |

## 已验证

环境：macOS 27.0.1 arm64，Rust 1.99.0（`rust-toolchain.toml`）。先按 CI 的做法在 `apps/desktop` 执行 `npm ci && npm run build` 生成 `dist`（已被 gitignore，否则 `tauri::generate_context!` 无法编译测试）。2026-10-12 在仓库根目录执行：

```sh
M=apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path $M -- --check                                          # 通过
cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings  # 无警告
cargo test --locked --manifest-path $M --all-features --lib modem                # 25 passed
cargo test --locked --manifest-path $M --all-targets --all-features              # lib 133 passed、6 ignored；modem_lrzsz 11 ignored、zmodem_lrzsz 8 ignored；其余集成测试全部通过
```

单元测试（`modem::tests::`）共 25 项。下表前 23 项是 2026-10-11 的原有测试，最后 2 项是根据 lrzsz 互操作发现补充的回归测试：

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
| `surplus_start_requests_do_not_ack_echoed_first_blocks` | YMODEM：先超时 2 次（共 3 个 `C`），再收到 3 份块 0，只回一次 `ACK C`；之后重复的数据块仍按 ACK 丢失再次 ACK。XMODEM：2 个 `C` 后收到 2 份块 1 只 ACK 一次，第 3 份按 ACK 丢失再 ACK；3 个 `C`、块 1、一次超时（NAK）之后再到的副本也会被 ACK（超时清零回声计数） |
| `crc_frame_after_the_checksum_fallback_is_accepted` | 回退到 NAK 后收到 CRC 帧：第 132 字节时不回应，第 133 字节到达后 ACK，并改用 CRC；随后 3 份回声被丢弃。首块是损坏的校验和帧时，等一次超时后发 NAK，之后正确的校验和帧照常 ACK |

新增的 2 项单元回归测试和下文的 `late_lrzsz_senders_reading_queued_requests_stay_in_step` 都已确认：把 `receiver.rs` 换回修复前（`HEAD`）的版本时失败（后者报 `SequenceError`），换回修复后通过。删去“超时清零回声计数”这一行时，`surplus_start_requests_do_not_ack_echoed_first_blocks` 失败。

2026-10-11 的变异检查（针对当时的 23 项）：用临时脚本（未提交）每次注入 1 个缺陷，运行上述测试，再恢复源码。13 个缺陷都至少让 1 项测试失败：重发不输出帧、跳过 CRC 校验、YMODEM 不按长度截断、单个 CAN 即终止、发送端不丢弃过期应答、CRC 多项式错误、重复块回 NAK、允许 `..`、不回退到校验和、YMODEM 对第一个 EOT 直接 ACK、发送端已应答后仍回退到校验和、过期 `C` 立即重发、取消整批总量上限。

独立审查（2026-10-11）：另一个只读审查代理没有发现 CRITICAL/HIGH 问题，指出了 3 个 MEDIUM 问题，均已修复并补了测试：发送端应答后接收端超时仍可能回退到校验和；跨读取的重复 `C` 会让发送端超前一块；整批内存没有上限。

独立审查（2026-10-12，`rust-reviewer` 只读代理）：没有 CRITICAL/HIGH 问题。1 个 MEDIUM：回声计数不随时间失效，真正的 ACK 丢失可能要多等几轮重传。已改为“任何一次超时都清零回声计数”（没有采用设上限，因为 `sb --delay-startup 2` 配合 300 ms 超时时会排队 7 个 `C`、产生 6 份回声），补了测试，复审确认已解决。LOW 项中，测试脚手架的阻塞写、`P0_LRZSZ_REQUIRED` 取任意值都算“必需”、跳过的测试显示为通过，已写入代码注释；探针发送端在提交文件数据时会重置空闲计时；其余两项记入下文边界。

### lrzsz 互操作（2026-10-12）

**对端与环境**：用户批准后通过 Homebrew 安装的 lrzsz 0.13.1（`/opt/homebrew/Cellar/lrzsz/0.13.1`），macOS 27.0.1 arm64，Rust 1.99.0。`lrx --version` 输出 `lrx (GNU lrzsz) 0.13.1`，`lsx --version` 输出 `lsx (lrzsz) 0.13.1`。Homebrew 只提供带 `l` 前缀的 `lsx`/`lrx`/`lsb`/`lrb`，`sz`/`rz` 两种名字都有；测试先找 `l<角色>`，再找 `<角色>`（Debian 两种名字都装）。lrzsz 是 GPL：只作为独立进程从 `PATH` 启动，没有链接、复制或改写它的任何代码。上述互操作工作中没有阅读它的源码，行为依据 man page 和黑盒观察；后来为诊断 Ubuntu 上的失败，阅读过 0.12.21 中与定时有关的源码片段（见下文“Ubuntu lrzsz 0.12.21rc”）。

**做法**：每个测试在 `std::env::temp_dir()` 下新建私有目录（结束时删除），以 `LC_ALL=C`、去掉 `ZMODEM_RESTRICTED` 的环境启动对端，经 stdin/stdout 管道收发。泵循环把我们状态机的 `take_output()` 写给对端，把对端输出交给 `feed()`，每 100 ms 实时调用一次 `tick()`（默认 10 tick 超时，即 1 秒）。对端输出由一个线程读入**有界**队列（4 块 × 8 KiB），流式对端会像真实链路一样被反压。单次传输超过 60 秒判失败；对端结束时最多再等 20 秒（期间继续读走它的输出），否则强制结束。所有收发结果都与原始数据逐字节比较。

**门控**：测试都标了 `#[ignore]`，默认的 `cargo test` 不运行它们。找不到 lrzsz 时打印 `skipped: lrzsz ... was not found on PATH (...)` 并按通过返回；设置环境变量 `P0_LRZSZ_REQUIRED`（任意值）时改为失败。本机已验证这三种情况：默认运行显示 11/8 项 ignored；`PATH=/usr/bin:/bin` 时 11/8 项“通过”（跳过）；同时设置 `P0_LRZSZ_REQUIRED=1` 时全部失败。

```sh
M=apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path $M --all-features --test modem_lrzsz -- --ignored    # 11 passed
cargo test --locked --manifest-path $M --all-features --test zmodem_lrzsz -- --ignored   # 8 passed（zmodem2 评估，见 ADR）
```

两组测试都在默认并行模式下连续运行 5 次全部通过，`--test-threads=1` 下也通过。

| 测试（`tests/modem_lrzsz.rs`） | 对端与参数 | 覆盖内容与结果 |
| --- | --- | --- |
| `xmodem_send_to_rx_in_checksum_crc_and_1k_modes` | `rx --binary out.bin`（校验和）、`rx --with-crc --binary out.bin`（CRC、1K） | 0、1、128、1000、70 001 字节 × 三种模式。落盘内容等于原数据加 0x1A 填充到 128 的倍数；帧长分别为 132/133 字节；1K 模式只在剩余量大于 896 字节时使用 STX 帧。70 001 字节共 547 块，覆盖块号回绕 |
| `xmodem_receive_from_sx_in_checksum_crc_and_1k_modes` | `sx in.bin`、`sx --1k in.bin` | 同样 5 种大小。校验和模式通过丢弃我们发出的 `C` 来触发回退。每块恰好一个 ACK，没有 NAK（校验和模式只有启动用的 1 个 NAK）；`sx -k` 同样对不超过 896 字节的尾部改用 128 字节块 |
| `ymodem_batch_send_to_rb_keeps_names_and_exact_bytes` | `rb`（无参数） | 一批 5 个文件：零字节、`中文 名.txt`（1000 字节）、以 3 个 0x1A 结尾的文件、70 001 字节、1 000 003 字节。文件名、内容逐字节一致，干净管道上没有重传 |
| `ymodem_batch_receive_from_sb_in_128_and_1k_blocks` | `sb <5 个文件>`、`sb --1k <5 个文件>` | 同一批文件；文件名、声明长度、内容一致；唯一的 NAK 是每个文件第一个 EOT 的应答；1K 模式的 ACK 数明显更少 |
| `corrupted_blocks_are_rejected_and_resent_in_both_directions` | `rx`/`rb` 与 `sx --1k`/`sb --1k`，1 000 003 字节 | 我们发出的第 2 块首份被篡改 1 字节：lrzsz 拒收，我们恰好重发一次。lrzsz 发来的流第 2000 字节被篡改：我们 NAK 一次后得到正确数据（YMODEM 另有 EOT 的 NAK） |
| `our_can_can_cancel_stops_every_lrzsz_peer` | `rx`/`rb`/`sx`/`sb`，传到 64 KiB 后 `cancel()` | 4 个对端都自行以退出码 128 结束；`rx`/`rb` 没有留下文件 |
| `lrzsz_interrupt_sends_can_and_cancels_us` | 同上，传到 64 KiB 后向对端发 SIGINT | lrzsz 发出 CAN 序列，我们在约 2–4 ms 内报 `RemoteCancel`；对端退出码 130；`rx`/`rb` 留下 65 536 字节的部分文件（lrzsz 的 man page 说明中断时保留部分文件），我们侧不报告完成 |
| `peer_killed_mid_transfer_fails_within_the_retry_budget` | 同上，SIGKILL | `timeout_ticks=2`、`max_retries=3` 时，我们在约 0.79 秒（预算 0.8 秒）后报 `RetriesExhausted` 并发出 CAN。2026-10-12 起这组短限值只从杀死对端时开始计时，见下文“Ubuntu lrzsz 0.12.21rc” |
| `ymodem_receiver_refuses_a_path_sent_by_sb_full_path` | `sb --full-path sub/x.bin` | 头中的 `sub/x.bin` 被拒绝（`InvalidFileName`），我们发出 5 个 CAN，`sb` 以非 0 退出 |
| `late_lrzsz_senders_reading_queued_requests_stay_in_step` | `sb --delay-startup 2 <2 个文件>`、`sx [--1k] --delay-startup 2`，超时 300 ms | 回归测试，见下。修复前 `sb` 一项失败为 `SequenceError`；修复后两种对端都完成，内容一致 |
| `long_ymodem_name_reaches_rb_in_a_1k_block_0` | `rb` | 244 字节的 UTF-8 文件名使块 0 改用 STX 帧，`rb` 按原名保存，内容一致 |

**互操作发现并已修复的协议缺陷**（各有单元回归测试和上面的互操作回归测试）：

1. **接收端把多余请求引出的重复块也 ACK，导致发送端超前。** 发送端晚于我们的请求开始读输入时（这里用 `--delay-startup` 模拟），会一次读到多个排队的 `C`。`sb` 每读到一个就重发一次块 0，我们对每份都回 `ACK C`。多出来的 ACK 被 `sb` 当作后续数据块的确认，最终在我们还没确认最后一块时就发了 EOT 和下一个头：我们以 `SequenceError` 失败，而 `sb` 以 0 退出并报告成功。修复见上文“多余请求的回声”。
2. **回退到校验和之后，收不了 CRC 帧。** 我们发了 3 个 `C` 后改发 NAK；`sx` 稍后开始读输入时先读到 `C`，于是用 CRC 发送，而我们按校验和解析，每次都 NAK，直到重试耗尽。修复见上文“校验和回退”。

**观察到、但未固化为测试的 lrzsz 0.13.1 行为**（一次性实验）：`sx` 读到块 1 之后的多余 `C` 会忽略，读到 NAK 会重发块 1。`lsb` 拒绝发送 64 字节及以上的文件名（试过 64/94/112/124/184/244 字节，加不加 `--1k` 都一样），提示 `filename too long for YMODEM subpacket`，之后以 128 退出，**不发 CAN**，我们的接收端只能等重试耗尽。14 字节的名称正常；更精确的阈值没有测。

**仍未验证**：只在 macOS 上通过管道测试，没有经过 PTY/TTY 行规程、SSH channel、Telnet 或串口；本机只测了 lrzsz 0.13.1，Ubuntu 的 0.12.21rc 只在 CI 上运行过（见下文）；没有与 WindTerm 2.7.0 对照；默认超时、重试次数也没有与 lrzsz 对照调优。

**CI**：`.github/workflows/p0-cross-platform.yml` 新增一个只在 Linux 上运行的步骤：`sudo apt-get install -y lrzsz`，记录 `dpkg-query -W lrzsz`，再以 `P0_LRZSZ_REQUIRED=1` 运行 `--test modem_lrzsz -- --ignored --nocapture --test-threads=1`，日志写入上传的 `p0-logs/lrzsz-interop.log`。该步骤设为 `continue-on-error: true`（不阻塞），步骤结论总是 success，要以日志为准。`zmodem_lrzsz` 评估测试不进 CI。已运行的两次（run 38202512575、38206136775，Ubuntu lrzsz 0.12.21rc）都是 11 项中 10 项通过，`peer_killed_mid_transfer_fails_within_the_retry_budget` 失败，原因与修复见下节；**修复后还没有在 CI 上运行过**，首次全部通过后可以去掉 `continue-on-error`。

### Ubuntu lrzsz 0.12.21rc：`rb` 请求文件头前约 1 秒的静默（2026-10-12）

**现象**：CI 两次运行中，“对端中途被杀”一项都以 `rb: transfer ended before the intervention` 失败：传输在 64 KiB 的干预点之前就结束了。同一项中排在前面的 `rx` 通过；其余用默认限值的 `rb` 测试（批量发送、CAN 取消、SIGINT）都通过。

**原因**（依据源码与本机计时，没有在 Ubuntu 上复现）：

- Ubuntu 24.04 的 lrzsz 是 `0.12.21-11build1`，源码为 Debian 的 `lrzsz_0.12.21.orig.tar.gz`（版本串 0.12.21rc）。它的 `src/Makefile.am` 总是定义 `-DNFGVMIN`；在这个宏下，`rb` 取 YMODEM 文件头的函数 `wcrxpn()` 先读一次线路、丢弃杂散输入，然后才发出 `C`。`src/zreadline.c` 的读超时用 `alarm()` 实现，以整秒计，最短 1 秒，所以 `rb` 每次请求文件头之前（每个文件开始时和批量结束时）都会静默约 1 秒。Debian 0.12.21-10 的补丁没有改动这部分；Ubuntu `-11build1` 的补丁没有逐一核对。
- `rx` 带文件名启动时不经过 `wcrxpn()`，立即发 `C`，所以 `rx` 一项通过。
- lrzsz 0.13 系列的读超时改用 `select()`，以 0.1 秒计。本机实测（独立的计时脚本，未提交）：`lrb` 启动约 105 ms 后发出第一个 `C`，`lrx` 约 2 ms。
- 这项测试为了尽快结束，把限值设为 `timeout_ticks=2`、`max_retries=3`，每 tick 100 ms，同一步最多容忍 (3+1)×2×100 ms = 0.8 秒的静默。我们的发送端等 `C` 时超时只计数，0.8 秒后以 `RetriesExhausted` 失败，进度为 0，所以没走到干预点。默认限值能容忍 11 秒，其余 `rb` 测试因此不受影响。
- 0.12.21 确认 EOT 时同样以整秒等待（收到 EOT 后再等约 1 秒没有数据才认）。这项测试走不到那一步，没有观察。

这是对端的定时差异，不是线上格式差异。产品含义：如果调用方给每一步的静默容忍低于约 1 秒，与 0.12.21 的 `rb` 交换每个文件头时都会失败；建议的 1 tick = 1 秒、10 tick 超时不受影响。

**修复（只改测试，状态机代码未动）**：`tests/modem_lrzsz.rs` 的 `interrupt()` 增加 `Timers` 参数。“对端被杀”一项改用 `Timers::FromIntervention`：干预之前，状态机收不到 `tick()`（`tests/support/lrzsz.rs` 的 `Held` 包装）；从杀死对端那一刻起，短限值照常计时。断言不变：仍要求 `RetriesExhausted`，并在 (3+1)×2 tick 加 1 秒调度余量内结束。如果干预之前对端连续 10 秒（`STUCK`）没有任何输出，就视为卡死而不是慢，计时器提前启动，测试很快失败并给出完整诊断，而不是空等 60 秒的传输上限。CAN 取消和 SIGINT 两项仍用 `Timers::Always` 和默认限值。代价：这一项在干预之前不再覆盖我们的超时与重发请求，这些由其他测试覆盖。

**诊断**：每一侧都在 `--nocapture` 输出中打印对端首字节的时间、干预前等待对端的最长时间，以及限值能容忍的静默。没有走到干预点时，panic 信息包含我们最终的状态、已传字节、从对端启动起的耗时、上述计时，以及对端的退出状态和 stderr。下次 Linux CI 日志中 `rb` 一行预计显示首字节约 1 秒，可据此确认上面的原因（尚未运行）。

**本机验证**（macOS，lrzsz 0.13.1；用 `--delay-startup` 模拟启动静默的修改都是临时的，未提交）：

| 场景 | 结果 |
| --- | --- |
| 当前代码，`P0_LRZSZ_REQUIRED=1 ... --test modem_lrzsz -- --ignored --nocapture --test-threads=1` | 11 passed；被杀一项四个对端都在约 0.79 秒后报 `RetriesExhausted` |
| 给 `lrb` 加 `--delay-startup 1`，计时器全程运行（即修复前的做法） | 失败，报错与 CI 相同：`rb: transfer ended before the intervention: ours Failed(RetriesExhausted) at 0 bytes, 805ms after the peer started ...; first peer byte after None; longest wait ... 804ms (our limits tolerate 800ms of silence per step)` |
| 同上，改用 `Timers::FromIntervention` | 通过；`rb` 的首字节在 1.106 秒后到达，被杀后 0.786 秒报 `RetriesExhausted` |
| 再给 `lsx`/`lsb` 也加 1 秒启动延迟 | 通过（接收端只发一次初始 `C`，对端醒来后读到它） |
| 给 `lrb` 加 `--delay-startup 15`（模拟卡死的对端） | 约 10.7 秒后失败，报错中包含 `timers started after 10s of peer silence` |

**关于阅读源码**：为找出原因，本次阅读了 Debian 源码包中 lrzsz 0.12.21 的相关片段（`src/Makefile.am`，`src/lrz.c` 的 `wcreceive`、`wcrxpn`、`wcrx`、`wcgetsec`、`procheader`，`src/zreadline.c`，`src/lsz.c` 的启动部分），并查看了 0.13 系列 `zreadline.c` 读超时的实现方式。只用于解释对端的定时，没有复制、翻译或改写其中任何代码。按上文 ADR，日后自研 ZMODEM 的实现者仍不应参考 lrzsz 源码；读过这些片段的人不宜担任实现者。

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

状态：提议，未实现。2026-10-12 已对 `zmodem2` 做了与 lrzsz 的实测评估（见下文），结论是不直接采用。

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
- 2026-10-11 用 `cargo search`/`cargo info` 查到的 crates.io 候选（当时只看了元数据；`zmodem2` 已于 2026-10-12 实测评估，其余仍未审查代码，也没有引入）：

| crate | 版本 / 声明许可证 | 结论 |
| --- | --- | --- |
| `zmodem2` | 0.7.3 / MIT OR Apache-2.0（codeberg jarkko/zmodem2，rust-version 1.85） | 许可证兼容；已实测评估，发送方向有协议缺陷，不直接采用（见下节） |
| `lrzsz2` | 0.7.1 / GPL-3.0-or-later | 不可并入 |
| `rmodem` | 0.1.1 / AGPL-3.0-or-later | 不可并入 |
| `rzsz` | 0.1.5 / 声明 Apache-2.0，但自述为 “a modern Rust rewrite of lrzsz” | 如果是 GPL 代码的翻译，其许可证声明可能不成立；完成出处审查之前不得采用 |
| `ymodem` | 0.1.1 / MIT | 只覆盖 X/YMODEM；本探针未使用 |

### `zmodem2` 评估（2026-10-12）

| 方面 | 结论 |
| --- | --- |
| 精确版本 | `zmodem2 =0.7.3`（crates.io，2026-10-10 发布）。`.crate` 的 SHA-256 为 `2a4c6cda9d8fd2379ce54d171a1a3a387ff6789b4c9de140586b91a217749ff1`，与 `Cargo.lock` 中的 checksum 一致；VCS 提交 `2728ac6a1f571c5eded016f81decd780e6188589`；仓库 `codeberg.org/jarkko/zmodem2`；rust-version 1.85，edition 2024 |
| 许可证 | MIT OR Apache-2.0。crate 内附 LICENSE-MIT 与 LICENSE-APACHE，源文件 SPDX 头一致；版权人为 Alexey Arbuzov（2017–2020）与 Jarkko Sakkinen（2023–2026）；README 说明它基于 Arbuzov 的 `zmodem` crate。crate 还附带 Forsberg 的 `docs/zmodem.txt`，该文档声明可以不加修改地自由再分发；它不进入编译产物 |
| 依赖与构建 | 依赖 `bitflags` 2、`hex` 0.4、`thiserror` 1，这些都已在本仓库锁文件中，所以引入后锁文件只多了 `zmodem2` 一项。`build.rs` 只在 `PATH` 中查找 `rz`/`sz`，用来决定是否编译它自带的集成测试；不下载，也不执行程序 |
| 出处 | 读了 crate 源码（约 3000 行库代码，另有约 1900 行测试），没有做逐文件出处审查。注释多处与 lrzsz 的行为对照，例如取消序列“与 lrzsz `canit()` 相同的字节”，测试中用了从 `sz -b -e` 抓取的 ZSINIT 线上字节。这些是行为和线上字节层面的对照，无法据此判断作者是否参考过 lrzsz 源码 |
| 维护 | 从 2024-05 的 0.1.0 到 2026-10-10 的 0.7.3 共 26 个版本，2025-11 起发布频繁，仍处于 0.x 阶段，接口稳定性没有承诺；单一维护者；0.7.3 发布两天，下载 14 次 |
| sans-IO 还是阻塞 | **sans-IO，调用方驱动**：`poll()` 返回 `Action::{WriteWire, ReadFile, WriteFile, Event, Idle}`，调用方用 `submit_wire`/`wire_written`/`submit_file`/`file_written`/`timeout`/`abort` 推进。`no_std`、无堆分配（固定缓冲区），不阻塞、不做 I/O、不读时钟，可以挂在现有字节流上。这一点满足要求 |
| 文件名与大小的边界 | 文件名是原始字节，最多 256 字节（超出报 `OutOfMemory`），库不做任何校验，`sz --full-path` 发来的 `sub/x.bin` 会原样交给调用方。文件大小和偏移都是 `u32`（上限 4 GiB）；库不设大小上限，接收端也不检查数据是否超过声明长度。子包固定为 1024 字节，更大的子包报错（`sz --try-8k` 这类 8K 子包不受支持，未实测） |
| 超时、重试、取消 | 接收端对连续损坏的子包最多发 10 次 ZRPOS。发送端没有重试上限。两端的 `timeout()` 都只在文件开始前重发 ZRINIT/ZRQINIT，传输中途没有超时处理，对端消失就一直等待。取消只识别 ZABORT/ZCAN 帧头，**不识别对端发来的连续 5 个 CAN** |

探针驱动（`tests/support/zmodem2_probe.rs`）补上了库不提供的部分：5 个 CAN 检测、超时次数上限、文件名（与 X/YMODEM 相同规则）、大小与文件数检查、按声明长度检查数据。它把整个文件放在内存里，只是评估用的测试脚手架。8 项互操作测试（`tests/zmodem_lrzsz.rs`，对端 lrzsz 0.13.1 的 `lsz`/`lrz`，管道，有界读取队列；连续 5 次全部通过）：

| 测试 | 覆盖内容与结果 |
| --- | --- |
| `zmodem2_receives_a_batch_from_sz` | `sz --binary`，以及加 `--escape`（先发 ZSINIT，转义所有控制字符）；同一批 5 个文件（零字节、`中文 名.txt`、以 0x1A 结尾、70 001 字节、1 000 003 字节）。文件名、声明长度、内容逐字节一致，每个文件恰好一个 ZRPOS |
| `zmodem2_sends_a_batch_to_rz` | `rz --binary`，库默认窗口和窗口 1 各一次；`rz` 落盘的文件名和内容一致 |
| `zmodem2_receiver_recovers_corrupted_data_with_zrpos` | `sz` 发来的流在第 5000 或第 300 000 字节处被篡改：库发出第 2 个 ZRPOS，`sz` 回退重发，结果逐字节一致 |
| `zmodem2_sender_recovers_from_rz_rewinds_only_in_stop_and_wait` | 我们发给 `rz` 的流在第 50 000 或第 300 000 字节处被篡改。**库默认窗口（每个 ZACK 10 个子包）和不停顿流式都失败**：`rz` 发 ZRPOS 要求回退后，库每个数据帧只读一个帧头，于是一直按上一个过期的 ZRPOS/ZACK 回退，落后一帧；`rz` 反复发 ZRPOS，最后报 `out of sync` 并发出 CAN，删掉文件。窗口 1（每 1 KiB 等一次 ZACK）能恢复且内容一致。本机重复 6 次，结果都相同 |
| `sz_full_path_names_are_refused_by_the_driver_not_the_library` | `sz --full-path sub/x.bin`：库把 `sub/x.bin` 原样交出，由驱动拒绝并发送取消序列，`sz` 以非 0 退出 |
| `our_abort_sequence_stops_sz_and_rz` | 传到约 128 KiB 时调用库的 `abort()`（10 个 CAN 加 10 个退格）：`lsz`、`lrz` 都自行以退出码 128 结束 |
| `interrupted_lrzsz_is_caught_by_the_driver_not_the_library` | `rz` 收到 SIGINT 后发出 CAN 序列：驱动报告对端取消；关闭驱动的 CAN 检测后，库自己没有察觉，最后由超时上限结束。`sz`（lsz 0.13.1，ZMODEM，管道）收到 SIGINT 后只是停止发送，**不发 CAN**，所以只能靠超时上限结束 |
| `killed_lrzsz_ends_through_the_drivers_timeout_budget` | SIGKILL 对端：两个方向都在超时预算（约 0.8 秒）内结束 |

**结论：0.7.3 不适合直接作为产品依赖。** 许可证兼容，sans-IO 接口也合适，接收方向和干净链路上的发送方向都能与 lrzsz 互通。但存在以下问题：

1. 发送方向有协议缺陷。默认窗口和流式模式下，无法从接收端的 ZRPOS 回退中恢复，与 `rz` 实测失败。只有每 1 KiB 一次往返的停等模式可用，这在高延迟的 SSH 链路上吞吐会很差。
2. 取消检测、中途超时与重试上限、文件名与大小检查都要由调用方补上。这些可以写在驱动里，但第 1 点必须改库本身。
3. 单一维护者，0.x 阶段 API 变化频繁，刚发布的版本几乎没有使用量。

`zmodem2` 目前只作为开发依赖保留，用于复现上面的证据，不进入库或应用。后续有两条路：向上游报告第 1 点，修复后改版本号即可复用同一组测试重新评估；或者采用下面的自研方案（推荐作为默认路径）。

### 按协议文档自研的提纲（未实现）

- **依据**：只依据公开的协议说明（Forsberg 的 ZMODEM 文档以及 X/YMODEM 参考文档）描述的行为编写，不参考 lrzsz、lrzsz2、rzsz 的源码。`zmodem2` 是宽松许可，可以参考，但如果复制其代码，需要保留它的版权和许可声明。
- **接口**：与 X/YMODEM 模块一致，sans-IO：`feed(&[u8])` 返回已消耗的字节数（剩余字节交还终端），`tick()`、`take_output()`、`cancel()`、`status()`；文件数据通过按偏移请求和交付的接口进出，状态机本身不打开文件。
- **结构**：帧头编解码（十六进制、CRC-16 二进制、CRC-32 二进制）与 CRC-16/CRC-32；ZDLE 转义表（可选择转义全部控制字符）；数据子包编解码；发送端；接收端；单元测试。每个文件都控制在 800 行以内。
- **接收端**：ZRINIT 通告 CANFDX、CANOVIO、CANFC32，缓冲区设为 0 或有界窗口。解析 ZFILE 时，文件名按 X/YMODEM 的规则校验，并检查大小上限和文件数上限。ZRPOS 的偏移等于已写入长度；数据超过声明长度即失败。任何时候收到连续 5 个 CAN 都按对端取消处理。超时策略：会话开始阶段重发 ZRINIT，数据阶段重发 ZRPOS（当前偏移），都计入重试上限。收到 ZFIN 后回 ZFIN，消费 `OO`，再把剩余字节交还。
- **发送端**：先发 ZRQINIT，再按 ZRINIT 的能力选择 CRC-32 和窗口；数据用 ZDATA 加 ZCRCG…ZCRCW/ZCRCQ 子包。**收到 ZRPOS 时丢弃尚未发出的数据，先读完已经到达的所有帧头，只采用最新的 ZRPOS，并忽略偏移早于已确认位置的 ZACK**，这正是 `zmodem2` 出错的地方。等待 ZACK、ZRINIT、ZFIN 时都有超时和重试上限。结束时依次发送 ZEOF、ZFIN、`OO`。
- **自动启动**：跨读取块匹配 `**\x18B00` 和 `**\x18B01`，确认后再切换到协议引擎（见集成设计第 2 条）。
- **测试计划**：
  - 回环测试加故障注入：损坏、丢字节、丢帧头、CAN、超时。
  - 复用 `tests/support/lrzsz.rs`，与 `sz`/`rz` 做管道互操作。覆盖本次让 `zmodem2` 失败的“损坏后回退”场景，以及 `--escape`、零字节、非 ASCII 文件名、1 MB 以上文件、SIGINT、SIGKILL。
  - 再经 PTY 和受控 SSH 服务器测试。
  - 最后与 WindTerm 2.7.0 实机对照。

### 推荐路径

1. F10/F11 继续以本探针（自研、无依赖、sans-IO）为基础。管道上的 lrzsz 互操作已完成，下一步是传输接入（PTY、SSH channel），并在 PTY/TTY 和受控 SSH 服务器上重复互操作测试。
2. ZMODEM：`zmodem2` 0.7.3 已评估，不直接采用（发送方向无法从 ZRPOS 回退中恢复，见上节）。如果上游修复，用同一组 `tests/zmodem_lrzsz.rs` 重新评估；否则按上节提纲，在本仓库依据公开协议文档自研 sans-IO 的 ZMODEM。
3. 自研时的接口与本模块一致（`feed`/`tick`/`take_output`/`cancel`），实现者不参考 lrzsz、lrzsz2、rzsz 的源码。
4. 后备方案（不作为默认）：调用用户自行安装的本机 lrzsz 作为协议引擎。缺点是依赖用户环境、Windows 不可用、与会话字节流的桥接复杂；这种方式也不能随应用捆绑。
5. 无论选哪条路径，验收都必须包括：经 SSH 连接受控测试服务器和本地 PTY 时与 lrzsz `sz`/`rz` 双向互操作；中断后通过 ZRPOS 续传；自动启动检测及误报处理；取消后回到可用终端；哈希验证二进制完整性；中文和空格文件名；零字节和大文件；Windows 上非 ASCII 文件名。

## 未完成与不能误报的边界

- F10、F11、F12 均未完成，不能写成“已支持 X/Y/ZModem”。
- 没有接入 PTY、SSH、串口或 Telnet，没有 IPC 命令、前端、进度事件，也没有磁盘写入。
- 真实对端互操作只有 macOS arm64 上经 stdin/stdout 管道的 lrzsz 0.13.1；没有经过 PTY/TTY 行规程、SSH、Telnet 或串口；没有与 WindTerm 2.7.0 对照。
- Linux CI 上的 lrzsz 互操作步骤是非阻塞的。Ubuntu 的 lrzsz 0.12.21rc 在修复前的两次 CI 运行中 10/11 通过；修复后尚未运行，原因分析也还没有经 CI 日志确认。Windows 上没有运行互操作测试（测试只在 Unix 上编译）。
- ZMODEM 没有产品代码；`zmodem2` 探针只在测试中运行，评估结论是不直接采用。
- XMODEM 无法区分文件真实结尾的 0x1A 和填充。
- X/YMODEM 的应答不带块号。如果重复的控制字节在链路中积压（例如链路延迟接近超时时间，接收端超时发出的 NAK 与迟到的帧在途中交错），发送端可能“超前一块”。当前的缓解措施：发送端超时不重发；丢弃同一次读取中的过期应答；发出帧后同一 tick 内收到的 `C` 不触发重发；接收端丢弃多余请求引出的回声（lrzsz 实测场景）；块号错位时用 CAN 终止。仍未覆盖的情况：数据阶段的超时 NAK 与迟到的原帧交错；晚于一次超时才到的回声，会再被 ACK。NAK 无法用同样方式过滤，因为正常的“坏帧 NAK”也会紧接着到达。XMODEM 在最坏情况下可能截断文件尾部而不报错（YMODEM 会因长度不符报错）。目前只在上面列出的故障注入场景和 lrzsz 管道场景下验证过。
- 回退到校验和后，如果首块按校验和不通过，接收端会等第 133 个字节去试 CRC。如果这个字节晚于一次超时才到，会被当作帧间杂散字节；恰好是 0x04（EOT）时，XMODEM 接收端会提前结束。帧间杂散的 SOH/STX/EOT 本来就有同样的风险。
- 最后一个 ACK 丢失时，接收端已有完整文件，但发送端报告 `RetriesExhausted`；接收端完成后不会继续等待并重发确认。
- 发送端以 CRC 帧开始后，如果接收端才改用校验和（发送端响应很慢时），发送端不会降级，传输会失败。
- 不支持 YMODEM-g；发送端不支持 1K 块与校验和的组合（接收端可以接收，一次性实验中 `sx --1k` 配合校验和成功，未固化为测试）；YMODEM 启动时收到 NAK 会被忽略；头中的修改时间、权限、序列号既不发送也不解析。
- 如果发送端在帧中途取消，接收端会把收到的 CAN 当作数据，只能等 CRC 失败或超时后结束。
- 状态机结束后，同一次 `feed()` 中剩余的字节会被丢弃（见集成设计第 8 条）。
- 文件全部保存在内存中（单文件和整批都有上限）；文件名规则偏保守，未检查 Windows 保留名。
- 默认超时（10 tick）、重试次数（10）和 `C` 请求次数（3）没有和 WindTerm 2.7.0 或 lrzsz 对照调优。互操作测试用 100 ms 的 tick，与产品建议的 1 秒不同。
