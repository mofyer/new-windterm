# Windows ConPTY 适配决策记录

状态：**待实现，当前保留明确拒绝策略**。日期：2026-10-11。

## 决策

当前不解除 `platform::ensure_supported()` 的 Windows 拒绝。`portable-pty 0.9.0` 已提供 ConPTY 创建、缩放、读写和子进程接口，但这不等于现有 P0 会话生命周期已经支持 Windows。

当前代码已加入 Windows-only 的 `ChildKiller` 生命周期钩子：`Session::close()` 会在释放 master 前尝试终止直接子进程，Unix 构建和行为不变。这只是为后续验证准备的取消入口，尚未证明同步 reader 会返回，也没有解除平台拒绝或声称 Windows PTY 可用。

现有 `pty.rs` 的 reader worker 在 Unix 上依靠非阻塞描述符、`WouldBlock` 和 EIO EOF 约定运行。portable-pty 的 Windows ConPTY reader 使用匿名管道上的同步 `ReadFile`；`filedescriptor` 文档也明确指出 Windows 的 readiness 检查只适用于 socket。当前 `Session::close()` 会释放 master、标记 flow 并唤醒 Unix readiness，但 reader 可能仍阻塞在同步读，随后 `cleanup_child()` 才会执行。因此仅把 `configure_io()` 改成 no-op、或让 readiness 在 Windows 睡眠轮询，都会产生关闭超时、worker 残留或把未验证路径误报为支持。

## 允许的实现方向

下一次实现必须先拆出 Windows 专用的取消生命周期：

1. 保存可克隆的 Windows child killer/进程句柄，并定义 `close`、ACK 超时、自然退出和窗口销毁的顺序。
2. 证明终止子进程后同步管道读会在固定期限内返回；若系统 API 需要 `CancelSynchronousIo` 或关闭读句柄，必须把线程/句柄所有权写入平台模块，不用未定义的跨线程 drop 假设。
3. reader 返回后再 join writer、wait child，并对每次超时报告明确错误；不能用 `wait_closed` 超时后把 session 标记成已回收。
4. Windows readiness 继续关闭，直到有真实可取消的等待机制；Unix 的 `pty-readiness` 行为不能复制到匿名管道。

## 验收门槛

解除拒绝策略前，必须在 `windows-2022` runner 实际执行：

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

