# 其它连接类型：Telnet、Raw TCP、串口（C02、C03、C04）

日期：2026-10-11；串口探针更新于 2026-10-15。状态：**Telnet 与 Raw TCP 已接入桌面终端标签（见 [NET_TERMINAL](NET_TERMINAL.zh-CN.md)），只用测试内 TCP 服务器和 IPC stub 验证；串口新增真实 SerialPort API 的虚拟 PTY 探针，未接入产品会话。均不代表验收。**

## Telnet（C02）

[`telnet.rs`](../../apps/desktop/src-tauri/src/telnet.rs) 是与传输无关的编解码器：输入服务端字节，输出终端数据和需要回发的协商应答；输出时转义数据。

- 接受服务端执行 ECHO、SGA、BINARY；本端执行 SGA、BINARY、TTYPE（回报终端类型，过滤为可打印 ASCII、最长 40 字符）、NAWS（窗口尺寸，大于等于 255 的字节按协议双写）。其它选项一律拒绝；已处于某状态时不重复应答，避免协商循环。
- 数据中的 `IAC IAC` 还原为 0xFF；`CR NUL` 去掉 NUL；子协商最多保留 256 字节，超出则整段忽略，不缓存服务端任意长度的数据。
- 发送时双写 0xFF；非二进制模式下单独的 CR 发送为 CR LF。窗口变化时，只在已协商 NAWS 后发送更新。
- 记录服务端是否回显（ECHO），供界面决定本地是否回显。

单元测试（3 项）：一段混合了协商、文本、0xFF、`CR NUL`、TTYPE 请求、未知选项和 UTF-8 的服务端数据，在每个切分点和逐字节输入下结果完全一致，应答序列逐字节符合预期；重复请求不循环、ECHO 状态可跟踪、NAWS 只在协商后发送；输出转义正确，超长子协商被忽略。

TCP 传输与终端标签已由 `net_terminal.rs` 接入，见 [NET_TERMINAL](NET_TERMINAL.zh-CN.md)。未完成：对真实 telnetd 与网络设备（交换机、路由器登录）的互操作、Linemode、编码选项，以及 WindTerm 2.7.0 的 Telnet 配置项对照。

## Raw TCP（C03）

Raw TCP 是在 TCP 连接与终端之间原样搬运字节，不做协议处理。`net_terminal.rs` 复用现有终端数据路径（有界队列、Channel、逐块 ACK），对 0x00–0xFF 的二进制完整性、对端关闭提示和本地关闭发送 FIN 有测试内服务器验证，见 [NET_TERMINAL](NET_TERMINAL.zh-CN.md)。仍未完成：UTF-8 以外的编码、会话保存，以及与真实服务的互操作。

## 串口（C04）

`serialport =4.10.1`（MPL-2.0，见[依赖清单](DEPENDENCIES.zh-CN.md)）现为**开发依赖**，禁用默认 `libudev` 特性。没有新增产品串口模块、Tauri 命令、UI、设备枚举或会话保存。

[`serial_virtual_pair.rs`](../../apps/desktop/src-tauri/tests/serial_virtual_pair.rs) 用上游 `TTYPort::pair()` 创建进程自己的 Unix PTY 对，再通过公开的 `serialport::new(...).open()` 打开该 slave；不读取用户配置、不扫描或打开真实设备、不调用外部工具，也不需 `sudo`。测试结束由所有权释放句柄。4 项测试覆盖：

1. 0x00–0xFF 全字节双向完整性（包含 NUL、CR/LF、XON/XOFF 与非 UTF-8 字节）。
2. PTY 的 8 数据位、无校验、1 停止位、无流控参数回读，以及 API 超时参数变更。
3. 空闲读返回 `TimedOut` 后仍可正常读取后续数据。
4. PTY master 关闭后 slave 读返回 `BrokenPipe`。

macOS PTY 不支持设置实际波特率所用的 `IOSSIOSPEED` ioctl。探针在 builder 传入 0 以跳过该 ioctl；这不是建议的真实 UART 设置，也不构成波特率验证。参数回读只证明 PTY 接受/回报相应设置，不能证明线上数据帧、时序或硬件流控效果。

运行方式（无需额外系统包）：

```sh
cd apps/desktop/src-tauri
cargo test --locked --all-features --test serial_virtual_pair
```

2026-10-15 本机 macOS arm64 实际运行：**4 passed / 0 failed / 0 ignored**。该文件受 `cfg(unix)` 限制：macOS/Linux 的全套 `cargo test --locked --all-features` 自动包含它；Windows 此测试目标是 0 项，**不算 Windows 串口验证**。Linux 运行结果以新 CI 回执为准。

串口的设备枚举、实际波特率、数据位/校验/流控的电气效果以及拔插都依赖真实硬件；Unix PTY 只能模拟字节流，不能代替 UART。**需要用户提供 USB 串口设备（最好包含一对互连的串口或一台串口设备）后才能做真机验证。** 尚未验证：真实设备权限错误、占用错误、断开恢复、Windows COM 端口、持续吞吐与背压、与终端 UI 的连接。后续顺序：产品会话与设备枚举 → 真机回环与参数变更 → 拔插报错与恢复；X/Y/ZModem（F10–F12）在此之后。
