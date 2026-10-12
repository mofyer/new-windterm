# Windows ConPTY 适配决策记录

状态：**已实现并通过 `windows-2022` CI（cmd.exe）**。日期：2026-10-11。

## 实现结果（更新）

本记录下文保留原有分析。实现采用与原“CancelSynchronousIo”建议不同、但满足同一门槛的方案：不跨线程取消 `ReadFile`，而是让等待线程在子进程退出后关闭 pseudoconsole，由 conhost 关闭管道产生 EOF；关闭会话时终止 kill-on-close Job Object 以回收整个进程树；reader 结束后排空管道直到 EOF。原文列出的验收顺序（空闲关闭、输出中关闭、自然退出、重复关闭/刷新、ACK 超时、12 轮循环、`cmd /c start` 子进程树）与 Ctrl+C 均在 [run 38134532830](https://github.com/mofyer/new-windterm/actions/runs/38134532830) 通过，详见 [RESULTS](RESULTS.zh-CN.md)。仍未覆盖 PowerShell、WebView2 原生窗口、输入法与真实用户环境。

### 评审后的调整与已知限制

独立评审后补充：
- **自然退出时的处理顺序**：等待线程先终止整个 Job，再关闭 pseudoconsole。这样，忽略控制台关闭的后代进程不会继续占住管道、让 reader 一直阻塞。
- **终止 Job 失败时**：`TerminateJobObject` 失败会回退为直接终止 shell 进程，因此等待线程仍会醒来。为此 `ProcessTree` 额外持有一份复制的 shell 句柄。
- **Ctrl+C 恢复**：`SetConsoleCtrlHandler(None, FALSE)` 是进程级设置，进程内只执行一次。
- **句柄泄漏检查**：改为与裸 ConPTY 开关做相对比较，详见下文“句柄泄漏定位”。
- **脱离 shell 的后代进程**：例如 `start /B` 启动的进程，现在会在 shell 退出时随 Job 一并终止，之后不再输出。
- **前端早期输入暂存**：只作用于本地 PTY，不作用于 SSH。会话退出、PTY 启动失败或关闭时会清空暂存。

已知限制，尚未消除：
- **回退的作用范围**：回退为终止 shell 只在关闭一个仍在运行的 shell 时有效。在自然退出路径上，shell 已经结束，如果此时 `TerminateJobObject` 失败，`TerminateProcess` 也无法终止任何进程，存活的后代进程仍会占住管道。
- **排空没有期限**：reader 在会话结束后读到 EOF 为止才结束，排空本身不设超时。正常路径下，终止 Job 再关闭 pseudoconsole 就会产生 EOF。但如果某个进程脱离了 Job 却仍持有管道写端，reader 线程会一直阻塞。这种情况在 CI 中没有出现，也没有专门的测试覆盖。
- **Job 分配存在竞态**：portable-pty 创建 shell 时没有使用 `CREATE_SUSPENDED`，shell 是在启动后才被加入 Job 的。如果 shell 在这段时间里启动了子进程，这个子进程不在 Job 中。当前用 `cmd.exe /D` 禁用 AutoRun，shell 在收到输入前不会启动子进程，所以这个窗口实际不可利用。如果以后改为用户自定义 shell 或启动参数，需要改成挂起创建、加入 Job、再恢复运行。

### 句柄泄漏定位

**结论：** 每个会话多出的 1 个句柄，来自 Windows Server 2022（build 20348）系统自带的 ConPTY，不是本项目的代码。Windows Server 2025（build 26100）上没有这个泄漏。

| 运行 | 方法 | 结果 |
| --- | --- | --- |
| [38136357458](https://github.com/mofyer/new-windterm/actions/runs/38136357458) | 12 轮循环，第一轮之后断言句柄增长不超过 8 | 第 9 轮从 120 涨到 129，测试失败；看不出是泄漏还是惰性分配 |
| [38137592323](https://github.com/mofyer/new-windterm/actions/runs/38137592323) | 4 轮预热，再测 24 轮；每次取 10 个样本的最小值 | 123、124、……、147，每轮正好多 1 个，严格线性 |
| [38138657734](https://github.com/mofyer/new-windterm/actions/runs/38138657734) | 分步诊断，按对象类型统计 | 空闲时增长为 0；只做 openpty 再关闭（不启动 shell）、裸 shell、加 Job、完整会话这四步，每轮都多 1 个 `Process` 句柄，没有其它类型 |
| [38153032998](https://github.com/mofyer/new-windterm/actions/runs/38153032998) | 列出新增句柄指向的进程；增加 windows-2025 作业 | Server 2022：新增句柄指向的进程都已退出（退出码 0），与 conhost 的生命周期一致。Server 2025：所有步骤增长都为 0，24 轮完整会话的句柄数始终是 117 |

第一次把测试改成整个进程计数之后，同一测试二进制里并行运行的 SSH 测试会干扰计数。所以这两项测试在常规测试中都标为 ignored，由 CI 在单独的步骤里依次运行，并把数据打印到日志中。

**现在的检查方式：** 先测 24 轮裸 ConPTY 开关的增长，再测 24 轮完整会话的增长，断言后者不超过前者加 8。系统 ConPTY 自身的泄漏不计入，而本项目只要每个会话多泄漏 1 个句柄，就会多出 24 个，触发断言。两个 Windows 版本上，这项检查都已通过。

**影响：** 在 Server 2022 这一代系统上，每打开一个本地终端，进程里就会留下一个指向已退出 conhost 的句柄，直到应用退出才释放。按正常使用频率，影响很小，但它确实存在。Windows 10 很可能用的是同一代 ConPTY，尚未验证。

**可选缓解：** portable-pty 会优先加载应用目录下的 `conpty.dll` 和 `OpenConsole.exe`。可以随应用一起分发 Windows Terminal 发布的新版 ConPTY（MIT 许可）。这样做会多出需要随包发布和签名的二进制，需要用户决定，目前没有采用。

## 原始记录

## 决策

当前不解除 `platform::ensure_supported()` 的 Windows 拒绝。`portable-pty 0.9.0` 已提供 ConPTY 创建、缩放、读写和子进程接口，但这不等于现有 P0 会话生命周期已经支持 Windows。

当前代码已加入 Windows-only 的 `ChildKiller` 生命周期钩子：`Session::close()` 会在释放 master 前尝试终止直接子进程，Unix 构建和行为不变。这只是为后续验证准备的取消入口，尚未证明同步 reader 会返回，也没有解除平台拒绝或声称 Windows PTY 可用。

同时已把未来 Windows shell 契约单独写入 `platform.rs`：使用校验过的 `ComSpec`、`cmd.exe /D /Q /K`，清空继承环境后只保留 `SystemRoot`、`ComSpec`、`PATH`、固定 `PROMPT` 和临时工作目录。该命令构造目前只用于后续适配与条件编译测试；由于 ConPTY reader 生命周期尚未通过实机验收，平台 gate 仍然拒绝创建会话。

现有 `pty.rs` 的 reader worker 在 Unix 上依靠非阻塞描述符、`WouldBlock` 和 EIO EOF 约定运行。portable-pty 的 Windows ConPTY reader 使用匿名管道上的同步 `ReadFile`；`filedescriptor` 文档也明确指出 Windows 的 readiness 检查只适用于 socket。当前 `Session::close()` 会释放 master、标记 flow 并唤醒 Unix readiness，但 reader 可能仍阻塞在同步读，随后 `cleanup_child()` 才会执行。因此仅把 `configure_io()` 改成 no-op、或让 readiness 在 Windows 睡眠轮询，都会产生关闭超时、worker 残留或把未验证路径误报为支持。

本轮源码核查进一步确认：`try_clone_reader()` 只是复制匿名管道句柄；`WinChildKiller` 只终止直接子进程，不处理子进程树。当前 reader worker 必须先从 `ReadFile` 返回，才会进入 `cleanup_child()`、释放 reader、join writer 并设置 `done`。因此现有 `ChildKiller + master.take()` 即使杀掉 `cmd.exe`，也无法证明 `wait_closed(2s)` 会收敛。可行的 Windows 专用原型需要在 reader 线程上持有可取消的线程句柄，关闭时调用 `CancelSynchronousIo`，将 `ERROR_OPERATION_ABORTED` 映射为取消，再完成 join；正式产品还需 Job Object 或等价的进程树治理。

## 允许的实现方向

下一次实现必须先拆出 Windows 专用的取消生命周期：

1. 保存可克隆的 Windows child killer/进程句柄，并定义 `close`、ACK 超时、自然退出和窗口销毁的顺序。
2. 证明终止子进程后同步管道读会在固定期限内返回；若系统 API 需要 `CancelSynchronousIo` 或关闭读句柄，必须把线程/句柄所有权写入平台模块，不用未定义的跨线程 drop 假设。
3. reader 返回后再 join writer、wait child，并对每次超时报告明确错误；不能用 `wait_closed` 超时后把 session 标记成已回收。
4. Windows readiness 继续关闭，直到有真实可取消的等待机制；Unix 的 `pty-readiness` 行为不能复制到匿名管道。

建议的 Windows runner 验收顺序为：空闲 `cmd.exe` close、输出中 close、自然 `exit /B 7`、重复 close/reload、ACK 超时、12 次 open/write/close/reap，以及 `cmd /c start` 子进程树清理；每项都必须记录 reader 返回、worker join、child wait、2 秒期限和进程/句柄残留。只在这组结果和 Unix 回归都通过后，才考虑解除 `ensure_supported()`。

## 验收门槛

解除拒绝策略前，必须在 `windows-2022` runner 实际执行独立的 Windows 探针。现有 `pty_probe` 使用 `stty`、`head|tr`、`sleep` 和 Unix Ctrl-C，属于 macOS/Linux 探针，不能通过替换平台 gate 后直接复用。

Windows 探针至少需要覆盖：

- `cmd.exe` 交互启动、UTF-8/控制字节、resize、退出码 7；
- 精确 2 MiB 有界输出、ACK 预算不超过 65,536 B、输出中 Ctrl-C 或等价取消；
- 空闲 shell 的 close、重复 close、ACK 超时、窗口 reload、自然退出，均在固定期限内收敛；
- 至少 12 次打开/输出/关闭/reap 循环，无 worker、子进程或句柄残留；
- `cargo fmt/check/test/clippy/link` 全部通过，Unix 回归保持原有结果；
- 单独记录 `cmd.exe` 已验证的范围，不把 PowerShell、IME、WebView、GUI、终端兼容性或完整 WindTerm 功能算作完成。

在上述证据出现前，Windows CI 继续运行编译、平台拒绝策略和 SSH 协议测试；真实 PTY 探针保持 skipped。Linux 的 Bash/Unix PTY 与 macOS 的 zsh/Unix PTY 不受此决策影响。

## 相关代码与证据

- `apps/desktop/src-tauri/src/platform.rs`：平台能力检查、shell 策略、Unix readiness。
- `apps/desktop/src-tauri/src/pty.rs`：共享 reader/writer、ACK、close 和 child reap 生命周期。
- [跨平台验证](CROSS_PLATFORM_VALIDATION.zh-CN.md)：当前三端 CI 范围与 Windows skipped 证据。
- [P0 结果](RESULTS.zh-CN.md)：当前交互 SSH、Unix PTY 和原生冒烟边界。

