# P0 真实 SSH 交互通道

本轮新增独立的 `ssh_open`，在现有一次性指纹挑战被用户明确确认后请求 SSH PTY 与 shell。原有 `ssh_accept` 仍只执行固定 `fixture-check` 验证命令。这里的真实协议测试使用 loopback russh 服务端，其 shell 是有限命令状态机，不启动操作系统 shell；不能据此宣称 OpenSSH、tmux、真实远端系统 shell 或 SFTP 已验收。

## IPC 与生命周期

| 命令 | 参数 / 结果 |
|---|---|
| `ssh_open` | `challengeToken, operationId, scopeToken, cols, rows, onEvent` → `{id}`，id 等于 operationId |
| `ssh_write` | `id, data:number[]`，每次 1–4096 字节 |
| `ssh_resize` | `id, cols, rows`，各 1–1000 |
| `ssh_ack` | `id, sequence`，严格按序；重复 ACK 与同 owner 已结束会话的迟到 ACK 幂等 |
| `ssh_close` | `id`，取消活动连接 / 待打开操作；已结束会话幂等 |

事件复用 `PtyEvent`：`data` 携带原始字节、id、sequence；`exit` 携带可选退出码；`error` 携带固定描述。远端数据只交给 xterm 字节写入路径。退出和错误后后台移除会话。

一个窗口只能操作自己的会话；每次文档 reload 会撤销旧 scope、挑战和活动连接。关闭窗口、应用退出以及 `ssh_cancel` 都触发相同取消通道。打开后的 operation 保持占用原 SSH 服务的 4 个活动操作配额之一。打开前与握手完成后均核对取消状态 / scope；取消的迟到连接不交给前端。

TCP guard 在所有退出路径关闭底层 socket，包括等待认证、请求 shell、没有 ACK 和输出拥塞期间。Ctrl-C 是输入字节 `0x03`；不在客户端发送任意本机命令。输入控制和输出消费分别由独立 future 驱动，关闭不排在输入队列后面。

## 信任边界

- 未知 host 的 probe 拒绝握手，不读取私钥、不尝试用户认证。
- 用户确认只授权这次挑战；重新建立连接必须匹配所确认的 Ed25519 主机公钥。核对 russh 0.64.1 后发现 `check_server_key` 只在初始交换调用，rekey 路径不再调用。P0 因而在第二次 `kex_done` 回调、安装新 keys 之前明确拒绝并断开，错误提示重新连接以再次核验主机 key；暂不支持长期会话的 SSH 重协商，不能声称已经实现 rekey pin 验证。
- 只读取明确指定的绝对路径、未加密 Ed25519 私钥，沿用已审的文件类型 / 64 KiB / 有界 blocking-reader 限制；不读取个人 SSH config、默认 key 或 agent。
- 主机信任可在用户勾选后保存到应用数据目录的 `known_hosts`；已保存密钥变化时阻断，需独立替换（见 [RESULTS](RESULTS.zh-CN.md)）。认证支持私钥（Ed25519/ECDSA，可带口令）、密码与本机 SSH agent，凭据只在核对指纹后传入且不保存；不支持 RSA 私钥、keyboard-interactive、代理、跳板、端口转发；只读 SFTP 走文件面板独立入口。

## 有界输出的实际边界

| 层级 | 限额 / 行为 |
|---|---|
| 前端未 ACK 输出 | 最多 64 KiB 且最多 64 块，每块最多 4096 字节 |
| ACK 期限 | 最老未 ACK 块 15 秒；没有未确认数据时不会因空闲触发此期限 |
| backend bridge | 最多 64 条消息，每条数据不超过 4096 字节，即数据载荷最多 256 KiB，另有一个处理中的包 |
| russh channel | buffer 16 条，初始窗口 64 KiB，最大包 4096 字节；协议 / TCP 内部缓冲另计 |
| 输入 | 最多 16 条排队，每条最多 4096 字节，另有一个执行中的控制请求；请求发送等待最长 15 秒 |
| 打开 | TCP、握手、认证、PTY 与 shell 确认合计最长 15 秒 |

**这不是全链路由前端 ACK 驱动的 SSH 窗口流控。** 核对 russh 0.64.1 源码发现，自动 window adjustment 在 `chan.send(...).await` 前发生；只 `split()` 后停止读取，最终仍会阻塞协议循环，影响双向输入。因此桥接 reader 保持消费，按消息让出调度；桥接队列满时明确发送错误并关闭连接，不静默丢数据，也不以无界缓存掩盖拥塞。前端已经接收的输出上限与协议缓冲上限不能混为一谈。

短暂停止 ACK 可在桥接容量内恢复；持续消费不足或过快突发可能断开。要进一步支持长期背压中的输入响应，需要独立评估上游协议调度 / 接收 credit 机制，不能把这一阶段的有限突发测试当作性能出口完成。

PTY 与 shell 请求逐个等待成功；允许窗口调整和少量先期数据穿插，先期数据受 64 KiB / 64 消息上限约束，成功后按原顺序送出。拒绝、意外关闭或超限均失败。

## 可复现夹具

在 `apps/desktop/src-tauri` 执行：

```sh
cargo run --locked --features dev-tools --bin ssh_terminal_fixture
```

需要保持 stdin 打开。程序仅监听 `127.0.0.1` 随机端口，打印本次临时 key 路径与独立服务端指纹。桌面 SSH 终端入口填写这些值，并对照打印的指纹确认。用户名固定 `fixture`。

允许的输入只有：

- `unicode`：返回中文与 emoji。
- `size`：返回最近收到的 PTY / window-change 尺寸。
- `large`：有节奏地产生恰好 2 MiB `X`，随后 `LARGE_DONE`。
- `burst`：无刻意 sleep 的同样有限输出，用于及时 ACK / 慢消费测试。
- `exit`：SSH exit-status 7 后关闭。
- Ctrl-C：取消当前有限输出任务，返回 `INTERRUPTED`。

无 OS shell、子进程、SFTP、任意文件访问、转发或系统 sshd 配置。输入命令行最多 256 字节。每次生成独立 Ed25519 主机 / 客户端 key；Unix 临时目录 0700、私钥 0600。Enter 停止，600 秒自动停止；正常停止撤销连接并删除临时目录。强制杀进程 / 系统崩溃可能遗留临时目录，需要按打印路径检查后手动清理，不扫描或删除其他临时目录。原 `tests/fixtures/ssh-sftp` 的默认允许命令与清理实现完全不变。

## 验证与未验收项

自动测试位于 `apps/desktop/src-tauri/tests/ssh_terminal.rs`，使用真实 TCP、SSH host-key、签名认证、PTY / shell / window-change / channel data / exit-status 消息。覆盖 UTF-8、尺寸、退出码、owner 隔离、输入长度、2 MiB 精确字节数、300 ms ACK 暂停后恢复、输出期间 Ctrl-C、及时 ACK 的无 sleep 突发、慢消费错误关闭、host-key 变更时不认证、打开前及打开中取消、scope 失效、窗口 reload、应用 shutdown、请求拒绝、ACK 超时、已 ACK 后空闲，以及服务端短限制主动 rekey 被明确拒绝。测试按串行门控运行，避免测试进程自身同时打开超过 4 个有界私钥读取操作。

单元测试另覆盖 IPC 字节 / 块预算与 ACK 顺序。测试 server 与 client 同为 russh 0.64.1；测试中没有真正操作系统远端 PTY，也没有 IME、生产网络、OpenSSH 或允许 rekey 并重新验证主机 key 的端到端验收。主动 rekey 测试只证明当前策略明确拒绝并关闭连接，不证明支持重协商。

实际运行结果由本轮 [RESULTS](RESULTS.zh-CN.md) 汇总；此文不替代跨平台 CI 或 native GUI 验收记录。

## 官方源码核对

使用本机 Cargo 缓存中的精确版本官方 crate 源码核对，未新增依赖：

- [russh 0.64.1 channels/mod.rs](https://docs.rs/crate/russh/0.64.1/source/src/channels/mod.rs)：`request_pty`、`request_shell`、`window_change`、`split`、`ChannelReadHalf::wait`。
- [client/encrypted.rs](https://docs.rs/crate/russh/0.64.1/source/src/client/encrypted.rs)：`CHANNEL_DATA` / `CHANNEL_EXTENDED_DATA` 自动窗口调整及有界 channel 发送。
- [client/mod.rs](https://docs.rs/crate/russh/0.64.1/source/src/client/mod.rs)：`Config` 的窗口、包与 channel buffer、host-key 回调。
- [server/mod.rs](https://docs.rs/crate/russh/0.64.1/source/src/server/mod.rs)：`run_stream`、认证、PTY / shell 的显式 success / failure、window-change handler。
