# P0 PTY 吞吐诊断：等待路径与短读候选

日期：2026-10-11。状态：原始数据、临时测量代码与结论边界已通过独立审查。本轮不修改生产 PTY、平台策略或已发布验收结论。目的为确定下一轮实验起点；单次功能探针不是性能基准。

## 已知结果与范围

生产基线为 `a82770db2dc5fc4ccc04ba3865ef18ff6168c614` 的探针修订；本次工作目录 HEAD 为 `eb2e3251caf87aabb1bb0bb85baa77937eca7ffc`。临时测量程序通过 path dependency 调用当前生产 `Session`，没有复制或修改读写循环。

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

## 下一轮可复现实验计划（尚未执行）

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
