# ControlMaster（C06）决策记录

状态：**提议，待与 WindTerm 2.7.0 实机行为对照后定稿**。日期：2026-10-11。

## 背景

功能矩阵 C06 要求“复用连接、主从生命周期及退出隔离”。FEASIBILITY 指出 russh 的多通道不等于 OpenSSH 的 ControlMaster：后者通过 ControlPath 上的本地 socket 和 OpenSSH 专用的多路复用协议，让**其它进程**（例如另开的 `ssh`、`scp`）复用已认证的连接。

## 决策

1. **应用内复用采用 russh 多通道实现**：同一主机的终端标签、SFTP、端口转发共用一条已认证的会话。会话按引用计数管理：最后一个使用者关闭后，按“持续时间”（对应 ControlPersist）保留或断开；主连接断开时所有通道同时结束并逐个报告状态。
2. **P0 不实现 OpenSSH 多路复用协议的服务端**（不创建可供外部 `ssh -S` 使用的 ControlPath socket）。若实机确认 WindTerm 2.7.0 允许外部程序复用其连接，再单独评估：实现 OpenSSH mux 协议，或改用受控的系统 OpenSSH 进程。
3. 复用只在同一主机、端口、用户名与已确认主机密钥完全一致时发生；认证方式不同的会话不合并。

## 证据

`ssh_forward.rs` 的探针 `one_connection_multiplexes_independent_shells`（russh 夹具）：一条连接、一次认证上同时开 3 个 PTY shell，各自报告自己的窗口尺寸；关闭其中一个后其余两个继续响应；主连接断开后所有通道在期限内结束；服务端全程只看到 1 条连接。只读 SFTP 已证明 SFTP subsystem 可作为同一会话上的另一个通道。

## 未完成

- 引用计数、持续时间、断线重连与状态显示尚未实现；目前终端与 SFTP 仍各自连接。
- 与 WindTerm 2.7.0 的 ControlMaster 选项实际语义对照（是否涉及外部进程复用、默认持续时间）。
- OpenSSH 服务端 `MaxSessions` 限制下的行为（超过上限时应新开连接还是报错）。
