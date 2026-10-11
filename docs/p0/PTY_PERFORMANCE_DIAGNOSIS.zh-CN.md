# P0 PTY 吞吐诊断：等待路径与短读候选

日期：2026-10-11。首轮为已审查的临时消费侧测量；下方追加第二轮可公开复现的诊断构建与九次有界样本。默认生产 PTY 读取、ACK 与平台策略保持不变；诊断计数只在显式 `pty-diagnostics` feature 下编译。本文不是性能达标声明。

## 已知结果与范围

首轮历史测量的生产基线为 `a82770db2dc5fc4ccc04ba3865ef18ff6168c614` 的探针修订；当时工作目录 HEAD 为 `eb2e3251caf87aabb1bb0bb85baa77937eca7ffc`。临时测量程序通过 path dependency 调用当时生产 `Session`，没有复制或修改读写循环。

| 样本 | 2 MiB 完整性阶段 | 已知范围 |
| --- | --- | --- |
| hosted macOS arm64，[run 38108375014](https://github.com/mofyer/new-windterm/actions/runs/38108375014/job/114378599131) | 35.51 s，57.7 KiB/s | 一次 debug CLI 功能探针，含 300 ms 人工 ACK 暂停 |
| hosted Linux x64，[同 run](https://github.com/mofyer/new-windterm/actions/runs/38108375014/job/114378599215) | 0.55 s，3701.7 KiB/s | 不同 OS、硬件、调度、shell 和工具实现，不能直接作平台性能比较 |
| 前轮本机修订验证 | 6.65 s | 前轮执行回执；本轮未重复该完整测试套件 |
| 本轮本机一次有限测量 | 7.45 s，274.8 KiB/s | macOS 27.0.1 arm64，debug，增加消费侧计时，数据完整 |

两次本机与 hosted 的差异说明结果对环境敏感，不能单凭比值断言 Rust、macOS 或某个系统调用是根因。首次 hosted Mac 的 10 秒功能期限失败仍保留在[跨平台报告](CROSS_PLATFORM_VALIDATION.zh-CN.md)。

CLI 探针直接使用 `Session`、同步事件通道和 Rust ACK，不经过 Tauri IPC、JSON 序列化、xterm.js 或 WebView。因此这些界面层不能解释这次 CLI 测得的延迟；它们可能另有成本，须独立实验。

## 一次有界测量

临时文件及回执位于本地忽略目录 `.artifacts/p0/performance-diag/`：`src/main.rs`、Cargo 清单/锁文件、`build.log`、`result.log`、`time.log`。输入仅包含既有探针生成的测试字符，不读取私有配置、不连接 SSH、不运行无界输出。保留 2 MiB 断言、60 秒负载期限、2 秒无进展期限、8 MiB 接收上限、Ctrl-C/退出与回收；省略额外 12 次关闭压力循环。

诊断只在消费侧记录每个 `Data` 大小、`recv_timeout` 墙钟耗时、`Session::ack` 调用墙钟耗时；不记录终端内容。输出总字节含负载标记及少量终端控制字节。

消费侧 `Instant` 计时、直方图及扫描也会扰动调度；尚未进行同环境有、无计时的对照。

| 指标 | 本次结果 |
| --- | --- |
| 负载有效字节 | 2,097,152，完整性断言通过 |
| 接收总字节 / Data 块数 | 2,097,331 B / 2,051 块 |
| 平均 Data 大小 | 1,022.6 B |
| 大小分布：≤64 / 65–256 / 257–512 / 513–1024 B | 2 / 1 / 0 / 2,048 块 |
| 大小分布：1025–2048 / 2049–4095 / 4096 B | 0 / 0 / 0 块 |
| 消费阶段墙钟时间 | 7,106.068 ms；不包含此前 300 ms 人工暂停 |
| `recv_timeout` 调用累计 / 最大耗时 | 7,066.142 ms / 7.577 ms |
| 单次接收等待 ≥4 ms | 1,043 次 |
| ACK 调用累计 / 最大耗时 | 0.932 ms / 0.056 ms |
| 全会话未确认字节峰值 | 54,439 B，低于 65,536 B 上限；不是负载专属峰值 |
| `/usr/bin/time -l` 整个命令 | real 7.67 s，user 0.20 s，sys 0.05 s；最大 RSS 13,221,888 B |

可确认本次消费循环约 99.4% 的墙钟时间花在等待下一条事件返回，直接 ACK 调用耗时很小。不能把接收等待直接解释为 worker sleep：它同时包含生产者、内核 PTY、调度、读线程和同步队列没有数据的时间。`time` 是整个命令的资源报告，没有逐线程 CPU 或全机负载采样。

## 候选原因与证据强度

1. **优先测量：非阻塞读的固定 5 ms 重试。** `pty.rs:461` 起的 `reader_loop` 在 `WouldBlock` 后睡 5 ms；在预算不足时也睡 5 ms。`platform.rs:17` 为 master 及其复制描述符设置 `O_NONBLOCK`。本次上千次 ≥4 ms 的接收等待与这种轮询模式相容，但没有内部计数，尚不能证明是哪一个分支或其占比。下一轮应先量化这两个分支，避免直接改 sleep 数值。
2. **短读增加事件与轮询次数。** 缓冲上限 4096 B，而本次 2048 个块落在 513–1024 B，生产代码每次 read 后立刻分配 `Vec`、复制 session id、发一个事件。`portable-pty 0.9.0` 本地依赖源码 `unix.rs` 的 `PtyFd::read` 直接转交底层读取；未发现其主动强制 1024 B。短块可能来自生成工具、终端行规程、内核或调度，本轮未分离。消费侧扫描/ACK开销小，不能据此排除生产侧分配或锁成本。
3. **64 块限制与 ACK 唤醒机制。** `Flow::has_room` 同时检查 64 KiB 和 64 块。小块时即使字节峰值较低，也可能撞到块数上限；Mac hosted 峰值 24,743 B 不足以证明“从未背压”。`ack` 只释放预算，没有通知读线程提前醒来，预算分支须等轮询重试。外部没有 pending 块数与 budget-stall 计数，不能从当前日志量化这部分。
4. **生成工具、locale 与 runner 调度仍是混杂因素。** 命令使用 `head -c ... | tr '\000' x`；Mac 与 Linux 的 shell、环境 locale、工具实现不同。当前只证明 Session 端接收到短块，不证明 `tr` 一定是瓶颈。hosted Mac 比本机慢约数倍，也可能受调度/资源影响；尚无实际 CPU 或系统调用 trace。

写线程的 `recv_timeout(25 ms)` 在有消息时可立即返回，并非每次输入固定延迟 25 ms；大输出经读线程传输，不能将它当作此次吞吐的直接根因。关闭/进程回收位于负载计时之后，也不能解释 35.51 秒的负载耗时。

## 首轮提出的下一轮实验计划（历史记录，执行进展见后文）

先在相同机器、相同 commit、同一构建模式运行有限重复样本，分别记录冷/热启动及当时系统负载，禁止跨机器单次比值作为优化结论。每项保留 2 MiB、退出回收、完整性、超时和预算检查。

1. 在隔离诊断构建增加 reader 的 `read_ok` 大小直方图、`WouldBlock` 次数、预算不足次数（分字节/块）、两种 sleep 实际时长、sink 时长及 flow 锁等待；只记录计数/时长，不记录用户终端内容。与本次消费侧结果一起分析是否主要等待在固定轮询。此步骤需要单独审查，尚未改生产代码。
2. 固定同一平台，用有限 Rust 字节生成器控制每次写入块大小，替换 `head|tr` 做对照；另测相同工具在管道上的生成时间，以分开生成工具、PTY 与事件传输成本。保持总量和数据断言相同。
3. 若计数确认 poll-wait 主导，再在实验分支比较可取消的 readiness 等待/ACK 通知与当前轮询；若确认小块主导，再评估有界合并。先定义交互首字节延迟、Ctrl-C 响应、关闭回收与 CPU 指标，不能只提高吞吐而破坏交互或取消能力。
4. 待原生层定位后再独立测量 Tauri/xterm 全链路；本次 CLI 结果不能替代 GUI 性能验收。

本机复现命令（临时诊断目录需保留；该目录未公开，单独 clone 仓库不能运行此临时测量）：

```sh
cargo build --locked --offline --manifest-path .artifacts/p0/performance-diag/Cargo.toml --target-dir apps/desktop/src-tauri/target
/usr/bin/time -l apps/desktop/src-tauri/target/debug/new-windterm-sustained-probe > .artifacts/p0/performance-diag/result.log 2> .artifacts/p0/performance-diag/time.log
```

本轮结论是优先量化“短读 + 两种 5 ms 等待”的贡献；尚未完成根因归属，没有修改 PTY 策略，也没有新的性能达标声明。


## 第二轮：仓库内可复现的分支计量

本轮新增 [pty_diagnose.rs](../../apps/desktop/src-tauri/src/bin/pty_diagnose.rs) 与 `pty.rs` 内仅由 `pty-diagnostics` feature 编译的聚合计数器。不增加依赖、不改变默认循环、5 ms sleep、64 KiB/64 块预算、15 秒 ACK 超时或关闭策略。CI 的 check/test/clippy 新增 `--all-features` 以编译检查诊断代码；默认应用构建与原有真实 PTY 探针不启用诊断计时。

记录 `read` 调用次数/累计耗时、成功读取总字节与七段大小直方图、`WouldBlock` 次数、分别由字节/块预算触发的停顿、两种 sleep 的实际时长、Data sink 时长（含事件分配）、所有线程取得 flow 锁的等待累计。不保存输入、终端正文、路径或会话 ID；计数器仅存在于内存，通过显式 Rust 方法读取，没有新增 Tauri 命令。默认构建编译掉这些计数、原子操作和额外时钟调用。

### 方法与边界

- 同一 macOS 27.0.1 arm64、debug 构建，`head|tr`、Rust 每次 `write_all` 1024 B、Rust 每次 `write_all` 4096 B，各三次，轮换顺序，共九个新建会话。Rust 生成器只产出固定 2 MiB 的 `x`，写入调用大小不等同于已追踪的内核 write 系统调用大小。
- 每次保留 300 ms 人工 ACK 暂停、60 秒 drain 期限、2 秒无进展期限、8 MiB 接收上限，精确验证两标记之间只有 2,097,152 个 `x`；随后 Ctrl-C 中断有限 `sleep 30`、等待恢复标记、退出码 7、关闭与 worker 回收。预算峰值不超过 65,536 B。Ctrl-C 是负载完成后的检查，不是大输出中的交互验收。
- `load_counters` 是发送负载命令前、收到结束标记后的差值；`load_ms` 包含 300 ms 暂停。快照逐项读取原子数值，并非暂停 worker 的一致切面；跨边界的 read/sleep 可能整笔记入某侧，通常涉及一次轮询及调度延迟。不能把各计时直接相加当成精确墙钟分解，尤其 flow 锁来自多个线程。
- `counters` 在退出并完成回收后读取，为整会话稳定快照，包含启动、负载、100 ms Ctrl-C 准备等待、退出等。**整会话 sleep 不除以负载墙钟时间。** 表格仅列近似 load 差值。
- 三个额外 pipe 对照各一次：`/bin/sh -c`、固定 PATH，locale 与对应 PTY 平台策略一致（本机 `LANG=en_US.UTF-8` / `LC_CTYPE=UTF-8`）。计时含进程启动、完整输出收集和校验；不是纯生成 CPU 时间。
- 本轮不是安静环境基准：测量期间有并行项目构建，`uptime` 采样 load averages 为 6.48 / 5.29 / 5.30，未做逐线程 CPU、冷/热启动或无计数构建 A/B；原子操作、时钟与消费侧也会扰动调度。原始日志本地保留于 `.artifacts/p0/pty-diagnostics/result.log`，首版仅整会话计数的九次开发验证另存 `initial-whole-session.log`，不混入下表。

### 九次有界样本（全部完整性、取消与回收通过）

所有时长单位 ms；WB 为 `WouldBlock` 重试。预算次数全部为字节预算，块预算次数全部为 0。

| 来源 / 次序 | load 墙钟 | WB 次数 | WB sleep | 预算次数 / sleep | sink | flow 锁等待 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| head-tr / 1 | 6591.288 | 1085 | 6534.490 | 3 / 18.116 | 15.903 | 2.383 |
| rust-1024 / 1 | 6553.128 | 1071 | 6452.957 | 10 / 59.265 | 16.467 | 2.056 |
| rust-4096 / 1 | 6619.031 | 1082 | 6556.339 | 5 / 28.711 | 13.834 | 2.115 |
| rust-1024 / 2 | 5959.516 | 967 | 5860.456 | 12 / 73.851 | 10.763 | 1.890 |
| rust-4096 / 2 | 7233.053 | 1151 | 7133.154 | 11 / 66.019 | 14.336 | 2.007 |
| head-tr / 2 | 6909.200 | 1131 | 6870.187 | 1 / 5.431 | 13.747 | 1.895 |
| rust-4096 / 3 | 6655.815 | 1088 | 6575.591 | 7 / 43.845 | 14.968 | 2.143 |
| head-tr / 3 | 6881.967 | 1124 | 6837.266 | 2 / 12.251 | 12.626 | 1.692 |
| rust-1024 / 3 | 6170.972 | 992 | 6081.265 | 11 / 65.494 | 9.917 | 1.488 |

九次都记录到 2048 个 513–1024 B 的成功读块，1025–4096 B 各桶均为 0，其余少量短块是命令标记/提示符。全会话未 ACK 字节峰值范围为 61,614–62,464 B；Ctrl-C 到恢复标记为 13.666–18.909 ms。load 内 read 系统调用包装计时累计 9.438–17.984 ms。

Pipe 对照均通过精确字节校验：head-tr 84.337 ms；rust-1024 14.521 ms；rust-4096 13.992 ms。它只能说明这些有界生产者在 pipe 中没有出现秒级成本；管道与 PTY 的调度和背压条件不同。

### 能确认与仍未确认

1. 原先仅凭消费侧等待推测的分支现已计量：这九次负载窗口的主要可见等待来自 `WouldBlock` 后 sleep，预算等待明显较小；本机这些样本没有触及 64 块限制。不能推广到 hosted runner 或其他输出形态。
2. 换成 Rust 生成器、改变名义写入块大小后，短读仍存在，负载时间仍在同一秒级范围；因此不能仅归因于 `tr`。尚未识别为什么本机 PTY 返回这一读块形态，也未证明调整重试策略可以安全提高吞吐。
3. 下一步应在隔离可审查的实验中比较可取消 readiness 等待与当前轮询，分别验证首字节延迟、持续输出中的 Ctrl-C、CPU、ACK 唤醒与关闭回收；也可进一步用系统调用追踪定位短读。尚未做任何生产优化，没有 Tauri/xterm 全链路结论。

### 公开复现与本机验证

正常 clone 仓库即可构建本轮诊断，不再依赖首轮未公开临时程序；需本项目 Rust/桌面依赖环境。默认运行共九次有限 PTY 样本与三次 pipe 对照，不接受任意命令。Windows 明确拒绝真实诊断，Linux 路径本轮未实机运行。

```sh
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features pty-diagnostics --bin pty_diagnose
apps/desktop/src-tauri/target/debug/pty_diagnose
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features pty-diagnostics --bin pty_diagnose -- -D warnings
```

本机 build、诊断最终九次运行与专用 clippy `-D warnings` 均通过；修改的两份 Rust 文件已 rustfmt，`git diff --check` 无误。跨平台 CI 与整仓 Rust 检查由本轮集成统一验收，不能用这里的本机诊断替代。
