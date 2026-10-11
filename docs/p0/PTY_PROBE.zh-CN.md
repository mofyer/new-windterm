# P0 本地 PTY 原型与验证记录

日期：2026-10-11。范围：Rust/portable-pty 的本地字节链路及 Tauri IPC 接口；**不是完整 P0 通过报告，也不是 SSH/SFTP 实现**。

> 本文保留第一轮的实现与实测快照，并在下方标注当前平台边界。第二轮已新增 Linux 适配与三平台 CI，最新状态以[跨平台验证](CROSS_PLATFORM_VALIDATION.zh-CN.md)和[本轮结果](RESULTS.zh-CN.md)为准。

## 当前平台状态（2026-10-11）

当前代码在 macOS 和 Linux 进入同一 Unix PTY 数据路径：macOS 使用 zsh，Linux 使用 Bash；两端均已在对应 hosted runner 完成构建、真实 PTY 完整性和回收探针。Windows 仍在分配 PTY 前返回明确的 ConPTY 待适配错误，三平台结果不能解释为 Windows 终端已支持。

## 实现

位置：`apps/desktop/src-tauri/`。Tauri 2.12.3、tauri-build 2.7.2、portable-pty 0.9.0，以及其他直接依赖均固定精确版本；`Cargo.lock` 固定传递依赖。

平台边界位于 `src/platform.rs`：macOS/Linux shell 参数、环境、起始目录、非阻塞描述符设置与 PTY EOF 判断集中在这里，session/窗口授权/ACK 逻辑继续共享。第一轮快照中的 Linux 拒绝策略已被第二轮替换为 Bash + Unix PTY 适配；当前只有 Windows 在创建 PTY 之前返回明确的 ConPTY 待适配错误。`libc` 仅为 Unix target 的直接依赖，Windows 原生错误不会按 Unix EIO 解释为正常 EOF。

- 真实本地 `/bin/zsh -f -i`，不加载用户 shell 配置。固定 `ZDOTDIR=/var/empty`、`HISTFILE=/dev/null`、起始目录 `/tmp`，仅保留 HOME；PATH/TERM/语言/PROMPT 使用固定值。系统 `/etc/zshenv` 仍由 zsh 自身处理。应用没有读取用户 SSH 凭据或建立远端连接。
- Linux 使用 `/bin/bash --noprofile --norc -i`，清空继承环境并设置受限 PATH、TERM、`LANG/LC_ALL=C.UTF-8`、`PS1`、`HISTFILE=/dev/null`，起始目录为系统临时目录；缺失 Bash 时在创建 PTY 前明确报错。
- 输出始终是原始字节数组，最大块 4 KiB；前端须用 `xterm.write(Uint8Array, callback)`，禁止逐块独立 UTF-8 解码。
- 每会话最多 64 KiB 未确认输出、64 个待 ACK 块；达到任一上限就停止读取 PTY。最旧未确认块 15 秒未 ACK 时明确报错并关闭会话。该预算仅指原始有效载荷，**不是应用 RSS 上限**；JSON、IPC、WebView、终端历史和内核缓冲另有开销。
- 输入每条最多 4 KiB、队列最多 16 条，另有一个正在写入的块；队列满时返回错误，不能静默丢弃。前端须拆分并串行提交较长粘贴。写入持续阻塞 15 秒后报错关闭。
- 每个会话分配 UUID 并绑定 Tauri 提供的窗口 label，所有 IPC 操作验证所属窗口。仅 `main` capability 可调用五个 PTY 命令，无任意路径读写、插件 shell 命令或远程脚本权限。
- 读取和写入各有工作线程，Unix 原生描述符设为非阻塞以轮询取消；Tauri 命令异步执行。取消后读线程负责终止并等待 shell；写线程退出并释放句柄。关闭为幂等操作。窗口销毁和应用退出触发清理，并在同一注册表锁内禁止排队中的任务再开会话；页面刷新关闭旧会话并变更代次，旧页面排队的打开请求会被拒绝。回收错误明确报告，不标记为已回收。
- 应用最多 8 个运行/清理中的 PTY；已关闭且工作线程回收后才允许重用容量。此数值是 P0 防护预算，不能解释为最终产品能力限制。
- 原生窗口装饰，1400×900，最小 1000×650；开发地址 `http://127.0.0.1:1420`。发行打包关闭。32×32 纯色 PNG 仅满足 Tauri 上下文宏图标要求，不是正式图标；对应 ICO 封装供未来 Windows 资源编译使用，其存在不代表 Windows 构建已经通过。

## IPC 契约

| 调用 | 参数 | 返回 |
| --- | --- | --- |
| `pty_open` | `{ onEvent: Channel<PtyEvent>, cols, rows }` | `{ id }` |
| `pty_write` | `{ id, data: number[] }` | 成功或明确错误；成功表示已进入有界输入队列，不表示 shell 已执行 |
| `pty_resize` | `{ id, cols, rows }` | 成功或错误；列 2–1000、行 2–500 |
| `pty_ack` | `{ id, sequence }` | 成功或错误 |
| `pty_close` | `{ id }` | 请求取消；最终回收由 `exit` 事件指示 |

事件为 `kind` 标签联合：

```ts
type PtyEvent =
  | { kind: 'data'; id: string; sequence: number; data: number[] }
  | { kind: 'exit'; id: string; code: number | null }
  | { kind: 'error'; id: string; message: string };
```

数据序号从 1 递增，ACK 必须在 xterm 写入完成回调后按序串行提交；重复已确认 ACK 幂等，活动会话跳号、0 或超出已发送范围的 ACK 返回错误。关闭后接受不超过已发送序号的迟到 ACK，不重新释放预算。`onEvent` 可能先于 `pty_open` promise 完成，前端必须按事件携带的 ID 处理。退出不代表前端画面已完成最后一次绘制。

## 已执行检查

设备环境：`arm64`，macOS 27.0.1（26A434），Rust 1.99.0；debug 构建。`file target/debug/pty_probe` 结果为 `Mach-O 64-bit executable arm64`。

仓库根目录复现：

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin pty_probe
```

- `cargo check`、10 个当前 macOS Rust 单元测试、`clippy -D warnings` 通过。
- 单元测试覆盖 ACK 篡改/乱序/重复、字节预算及恢复、微小块数量上限、关闭释放、ACK 超时判定、尺寸限制，以及窗口销毁/应用停止/页面刷新后拒绝排队旧请求。
- 第一轮本机平台测试补充 macOS shell 参数/不继承 agent 与注入变量，以及 EOF/权限错误区分；其中的“未实现适配器拒绝创建会话”是当时快照。当前 Linux/Windows hosted 结果和测试范围见[跨平台验证](CROSS_PLATFORM_VALIDATION.zh-CN.md)，不能把本节历史计数外推为三端 GUI 验收。
- 真实 PTY probe 覆盖跨窗口拒绝、resize 到 132×43 后读取 `stty size`、中文/emoji/组合字符字节、暂停 ACK 后恢复的 2,097,152 字节完整输出、Ctrl-C 中断 `sleep`、正常退出码 7、重复关闭及关闭后拒绝输入。
- 修复生命周期竞态后重跑记录的未确认有效载荷峰值为 **61,607 字节**，低于 65,536 字节预算；调度不同会影响峰值，不能据此外推吞吐性能。
- 另完成 12 次真实 PTY 打开、持续输出、不发 ACK、关闭、等待工作线程回收循环；结束后未发现该测试的 `zsh -f -i`、`yes bounded-output`、`head -c 2097152` 进程残留。
- 测试探针最初在大输出检索中重复扫描全部累计内容，导致探针自身超时；已改为仅扫描新增尾部，重新验证通过。生产链路未因此放宽预算或删减完整性断言。

## 尚未验证与限制

- 本文不提供 WKWebView/xterm GUI 实机输入法、字体宽度、鼠标、粘贴、无障碍、Retina 或视觉验收结论；这些需单独执行。
- 15 秒 ACK 超时目前有逻辑单测；尚未记录完整 WebView 卡死 15 秒后的端到端恢复。缺失 ACK 时会话主动终止，UI 后续须提供清晰说明。
- 未进行 RSS/CPU/启动时间/耗电/帧率测量，没有与 WindTerm 的同负载性能比较。
- 关闭循环覆盖普通前台子进程；守护化、双重 fork、刻意忽略信号/脱离会话的用户进程不属于本次回收保证，需要进一步策略与测试。
- 系统耗尽线程资源时 `thread::spawn` 仍可能 panic；尚未完成线程创建失败的 RAII 回收和故障注入验收。此原型不是资源耗尽场景的生产级保证。
- portable-pty 0.9.0 源码提供 Unix 和 Windows ConPTY 后端；应用当前已启用 macOS/Linux Unix PTY，Windows 的可取消读写、ConPTY 关闭、shell/环境及进程树策略仍未实现。Linux 证据限于 Ubuntu 24.04 hosted runner，不外推所有发行版或桌面 GUI。禁止通过跳过平台检查来冒充支持。本次 arm64 结果不证明 macOS 28 兼容、最低系统版本或签名公证通过。配置中的 macOS 12.0 是候选编译下限，不是测试认证。
- 终端 VT 方言、动态压缩、长历史、tmux 控制模式、SSH/OpenSSH 高级能力、SFTP、其他协议和全部功能对齐仍待后续 P0 样本。

## API 核验依据

- [Tauri 官方 Channel 文档](https://v2.tauri.app/develop/calling-frontend/#channels)：采用 Channel 传送流式数据，应用自行实现 ACK 背压。
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/) 与 [tauri-build AppManifest](https://docs.rs/tauri-build/2.7.2/tauri_build/)：为应用命令生成权限，仅主窗口获授权。
- [portable-pty 0.9.0 API](https://docs.rs/portable-pty/0.9.0/portable_pty/) 及下载到 Cargo registry 的相同版本源码：核验 openpty、spawn、读写、resize、子进程终止与 wait 行为。
