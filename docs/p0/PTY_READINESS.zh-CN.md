# P0 PTY readiness 有界实验

本轮保留默认 5 ms 轮询，新增显式 `pty-readiness` feature 实验。实验不代表默认应用性能提升，也未启用 Windows PTY。

## 变更与保护条件

- Unix 非阻塞读遇到 `WouldBlock` 时用 `poll` 等待可读或取消 socket；250 ms 上限再受最老未 ACK 块剩余期限限制。亚毫秒期限至少等待 1 ms，避免零超时忙轮询。
- `F_DUPFD_CLOEXEC` 复制 master 描述符，由读 worker 持有并在回收前释放，避免关闭原 master 后 poll 使用已复用的 fd，也避免被 shell exec 继承。取消通过独立 UnixStream 的幂等 shutdown 唤醒，不写入可塞满的通知管道。
- 容量不足时使用同一 flow mutex 下的 Condvar 条件等待；ACK 释放容量或 close 时通知。闭锁状态、字节/块预算、顺序 ACK、15 秒最老 ACK 期限仍由原 Flow 控制。
- `64 KiB / 64 块 / 4096 B 单块`、输入队列与写线程策略、PTY EIO/EOF 策略、子进程清理不变。默认构建不分配取消 socket、不执行 poll/Condvar 实验代码。
- 诊断新增 `readiness_waits/ns` 与 `capacity_waits/ns`；feature 开启时原 `read_sleep_ns`、`budget_sleep_ns` 为 0，不将 poll/Condvar 等待冒充 sleep。

实现依据是本地 `portable-pty 0.9.0` 的 Unix `try_clone_reader`/`as_raw_fd` 与锁定 `libc 0.2.180` API；未新增依赖。Windows 的 feature stub 编译后仍在分配 PTY 前由既有策略拒绝，不能据 all-features 编译通过宣称 ConPTY 可用。

## 预先约定的本机门槛

1. 三组交替配对，同机 debug、相同固定 Rust 4096 B 写入生成器，每组精确 2,097,152 字节，含 300 ms 暂停 ACK；全部完整性、ACK 顺序、预算、退出码 7 与 worker 回收通过。
2. 实验负载中位数不超过基线的 50%；每次首标记完整读回与输出中的 Ctrl-C 恢复标记均小于 100 ms，且无超过对应基线 50 ms 的退化。首标记读回为首字节延迟的上界，并非单独打点的首字节。
3. 实验 idle 读调用不超过每秒 10 次；这是等待/唤醒代理指标，不等于 idle CPU 或实际系统调用计数。`/usr/bin/time -l` 单独记录整命令 user/sys 与上下文切换；未做逐线程 CPU、功耗或系统调用 trace。
4. poll 可读/取消通知在 1 秒内完成（测试使用 5 秒 poll 期限区分通知与超时）；真实 PTY 满预算后 ACK 恢复、满预算取消回收在 2 秒内完成。

这些门槛只判断下一轮实验是否值得继续，切默认还需要独立 Rust 审查、Linux 行为验证、GUI 全链路与更多负载样本。

## 诊断方法与已修正的测量缺陷

`pty_diagnose --sample` 每次新建真实 PTY：关闭 echo → READY 标记 → 约一秒 idle、持续 ACK 提示符尾部 → FIRST 标记 → 2 MiB 有界负载 → 慢速有界输出中 Ctrl-C → exit 7 → 回收。

idle 差值从 READY_OK 后开始，包含可能的提示符尾部和一次跨边界 read；它不是完全隔离的稳态 CPU 区间。每次负载的 live counters 也可能有一个跨边界等待；整会话 counters 在回收后稳定。

第一次尝试仅在发送慢速生产者命令后等待 50 ms 即发 Ctrl-C，readiness 样本触发“生产者已输出完”断言，不能确保中断落在前台生成器启动之后。该失败被保留，不混入最终配对。修正后由生成器自身输出并 flush `INTERRUPT_BEGIN`，消费端确认后再等 50 ms 发 Ctrl-C；要求确实收到超过 4096 B 数据且未完成 2 MiB。修正触发路径先连续三次通过，随后才重跑配对。

原始日志、两种 feature 二进制与源码 SHA-256 保留在本地忽略目录 `.artifacts/p0/pty-readiness/`。这些日志不包含终端正文、输入或会话 ID。公开源文件可构建复现，原始本机日志不随 Git 发布。

## 本机配对结果

2026-10-11，同一 macOS arm64、debug，两种 feature 二进制分别保存；PTY 相关源码相同，只有 feature 策略不同。协调暂停项目 Cargo/浏览器重测试，开始时 load averages 为 5.01 / 5.02 / 5.24，仍有常驻应用与操作系统调度，不是严格安静基准。顺序 A/B、B/A、A/B；A 为默认轮询，B 为 readiness。所有时长单位 ms。

| 配对 / 策略 | 2 MiB 负载 | 首标记读回 | 输出中 Ctrl-C | idle 读调用 | 未 ACK 字节峰值 | 整命令 user + sys 秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 / A | 6757.899 | 8.851 | 17.770 | 169 | 57579 | 0.13 + 0.06 |
| 1 / B | 342.195 | 0.369 | 0.908 | 6 | 62464 | 0.07 + 0.03 |
| 2 / B | 341.704 | 0.550 | 0.730 | 6 | 62464 | 0.07 + 0.03 |
| 2 / A | 6957.390 | 7.811 | 18.790 | 168 | 61675 | 0.12 + 0.06 |
| 3 / A | 6898.175 | 11.524 | 13.584 | 171 | 60651 | 0.14 + 0.07 |
| 3 / B | 356.781 | 0.171 | 0.951 | 6 | 62464 | 0.08 + 0.03 |

六次均通过精确字节、预算、顺序 ACK、Ctrl-C 恢复、退出码 7 和 worker 回收。Ctrl-C 样本中实际读到的新增字节为 A 9659–11707 B、B 62822–62926 B，均已输出且远小于 2 MiB；不同策略在 50 ms 内传递的字节量不同，不能当成完全相等的已传输负载。

负载中位数 A 为 6898.175 ms、B 为 342.195 ms，B 约为 A 的 4.96%，通过预设的本机筛选门槛。负载含 300 ms 人工暂停，B 接近这个下限，不能把比例直接推广为真实应用提速倍数。

计量与策略相符：A 负载窗口 WouldBlock 为 1119–1142 次，sleep 累计 6727.296–6908.566 ms；B 为 198–294 次 readiness 等待，累计 12.225–17.782 ms。B 的容量等待有 1794–1871 次，累计 321.473–332.420 ms，包含人工 ACK 暂停与恢复后的短容量等待；每次均触发一次块数预算，其余主要为字节预算。次数增加并不等于 CPU 自旋，Condvar 等待时间和整体 CPU 应结合阅读。

本机结果支持继续评估 readiness/ACK 通知，不能排除其他机器、负载形态、release 构建或 GUI 全链路退化。未测独立 idle CPU、系统调用 trace、长时功耗、hosted runner 吞吐或 Linux 性能，**本轮不切默认策略**。

## 本机代码验证

- 两种 feature 的诊断二进制均构建成功，`--sample` 最终六次通过；修正 Ctrl-C 触发后另有三次 readiness 预验通过，不混入配对统计。
- `cargo test --lib --all-features` 本次检查点为 28 passed / 1 ignored（忽略项需真实 SSH fixture 单独运行），包含新增 poll 输入/幂等取消、真实 PTY 满容量 ACK 恢复及取消回收两项测试。
- 修改文件 rustfmt 与 `git diff --check` 通过。整仓 clippy 首次被并行开发的 SSH 命令参数数目告警阻挡。最终代码的 fmt/check/clippy（all-targets/all-features、`-D warnings`）与独立 Rust 审查已通过，详见 [当前 P0 结果](RESULTS.zh-CN.md)；三平台 CI 另以对应提交的回执为准，不由本机结果外推。


## 复现

分别构建后复制到独立路径，避免第二次构建覆盖第一种策略；生成器使用当前二进制的固定 `--generate 4096` 模式，不接受任意命令。然后交替运行三次 `--sample` 并保留 time 输出：

```sh
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features dev-tools,pty-diagnostics --bin pty_diagnose
# 将 target/debug/pty_diagnose 保存为独立 baseline 路径
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features dev-tools,pty-diagnostics,pty-readiness --bin pty_diagnose
# 将 target/debug/pty_diagnose 保存为独立 readiness 路径
# 各二进制执行 --sample；顺序 baseline/readiness、readiness/baseline、baseline/readiness
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --all-features
```

默认无参数仍运行九次轮换来源的诊断；本轮为少量配对使用新增 `--sample`，不重跑九次历史组合。最终 `8ee49a4` 的 [跨平台 CI](CROSS_PLATFORM_VALIDATION.zh-CN.md) 已验证 macOS/Linux 默认与 readiness 探针的字节完整性和回收；Windows 仅编译/策略与协议测试通过，两种 PTY 均跳过。hosted 单次耗时不是配对性能基准，默认 feature 仍关闭。CLI 直接走 Session 与内存 channel，未包含 Tauri IPC、xterm.js 或 WebView。
