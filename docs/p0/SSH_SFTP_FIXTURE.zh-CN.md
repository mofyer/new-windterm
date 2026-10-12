# 本机 SSH / SFTP 受控夹具

状态更新：2026-10-11。本页保存 macOS arm64、Node 26.0.0、系统 OpenSSH 10.3p1 / LibreSSL 3.3.6 的历史受控夹具证据：6 项协议检查与 2 项生命周期测试，以及前一轮固定命令 Rust SSH 客户端接入。**它不提供交互 PTY/shell，也不证明应用 SFTP 完成。** 固定命令入口及历史 CI 范围见 [SSH_CLIENT](SSH_CLIENT.zh-CN.md)；当前交互 SSH 使用另一个有限命令 russh 夹具，见 [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)。最新代码、原生与 CI 验收统一见 [RESULTS](RESULTS.zh-CN.md)，不把本页旧 OpenSSH 结果当成当前轮通过。

## 当前 Rust SFTP 只读切片

[`src/sftp.rs`](../../apps/desktop/src-tauri/src/sftp.rs) 的 `ReadOnlySftp` 接收**已经完成主机指纹确认和公钥认证的 `russh` channel**，显式请求 `sftp` subsystem 后直接驱动 `russh-sftp 3.0.1` 的 raw 协议会话，只开放四类操作：

- `canonicalize(path)`：解析登录目录等路径；
- `list(path)`：逐页 `readdir`，返回文件名、类型、大小、权限/模式和修改时间（路径只在列表头出现一次）。保留条目达到 4,096 项或文件名累计达到 1 MiB 时**立即停止读取**、关闭目录句柄并返回 `truncated: true`；含 `/`、NUL 或为空的文件名视为服务端协议错误；
- `metadata(path)`：单路径 `stat`，跟随符号链接；
- `read(path)`：仅打开普通文件，按 32 KiB 分块读取，最多 64 KiB；读取中文件增长超过上限即报错。路径长度与控制字符在请求前拒绝。

内存边界：保留部分为最多 4,096 条元数据加 1 MiB 文件名；另有一个正在检查的协议包（russh-sftp 默认包上限 256 KiB）。russh 通道自身的接收缓冲不在该预算内，不能把它写成完整的恶意服务端内存保证。

### Tauri IPC 与浏览授权

前端通过五个命令访问，均在 `build.rs` 和 `capabilities/main.json` 登记，仅 `main` 窗口可调用：

| 命令 | 输入 | 行为 |
| --- | --- | --- |
| `ssh_sftp_open` | 一次性 challenge、scope、operation ID | 消费已确认的 challenge，重新连接并固定校验主机密钥，认证后列出登录目录；成功后才签发浏览授权 |
| `ssh_sftp_list` / `ssh_sftp_metadata` / `ssh_sftp_read` | 授权、scope、operation ID、路径 | 每次重新连接、固定校验同一主机密钥并重新读取所选私钥文件，操作后断开 |
| `ssh_sftp_close` | 授权 | 吊销授权；重复调用无副作用 |

浏览授权只存在于 Rust 内存，绑定窗口与页面 scope，空闲 5 分钟或签发 30 分钟后失效，全应用最多 4 个；页面刷新、窗口关闭和应用退出时清除，不写入 known_hosts、配置或日志。连接阶段失败（传输、握手、主机密钥变化、私钥读取、认证、rekey）会立即吊销授权，并在错误末尾附加 `reconnect and verify the host again`，前端据此回到重新核对指纹；文件级错误、超时和用户取消保留授权。没有写入、删除、重命名或权限修改接口，也不保持长连接。

### SCP（F08/F09）

SCP 与 SFTP 是两套协议，单独实现和验收。[`ssh_scp.rs`](../../apps/desktop/src-tauri/src/ssh_scp.rs) 在 exec 通道上运行传统的 `scp -t`（上传）与 `scp -f`（下载），一次处理一个普通文件：远端路径按 sh 单引号转义后交给服务端；文件名不得含 `/`、NUL、换行；下载有大小上限，超限时向服务端发送错误并中止；服务端的 1/2 响应码连同消息原样报告。目录、递归与 `-p` 时间戳尚未实现。

夹具的命令白名单只额外允许 `scp -f|-t -- '<路径>'` 这一种形式，且路径解析后必须位于该次夹具的 `remote/` 目录内，越出目录、未加引号、附加参数或拼接命令都被拒绝。`rust-client.test.mjs` 的第 4 个用例在独立实例上运行 ignored 测试 `real_fixture_scp_round_trip`：上传 1,048,583 字节、文件名含中文、空格与单引号的文件，磁盘上的字节逐一一致；下载回来的名称与内容一致；服务端 umask 使权限从请求的 0640 变为 0600，测试只要求权限不超出请求值；不存在的文件返回服务端错误；超出大小上限被拒；非法文件名在本地拒绝；目录之外的路径被夹具拒绝。

### 真实 OpenSSH 验收

`node --test tests/fixtures/ssh-sftp/rust-client.test.mjs` 的第三个用例在独立夹具实例的远端目录写入小文本、符号链接、子目录和含 4,097 个文件的目录，然后显式运行 ignored 测试 `real_fixture_sftp_read_only_browse`。它通过 Rust `Ssh` 服务（不经过 WebView）对系统 OpenSSH `sftp-server` 验证：一次性 challenge 被消费；登录目录解析与列表；符号链接 `stat` 跟随到文件；小文件逐字节一致；夹具自检留下的 1 MiB+ 文件被 64 KiB 上限拒绝；目录读取与不存在路径报错且授权保留；子目录列表；4,097 项目录截断为 4,096 项；关闭授权后再操作返回过期。结束时 Rust 侧无残留操作、授权或 challenge，夹具删除全部临时文件。

第五个用例（2026-10-12）在另一个独立实例上写入同样的远端目录，运行 ignored 测试 `ssh::route::tests::real_fixture_sftp_through_routes`：只读 SFTP 依次经本机测试 HTTP CONNECT 代理、SOCKS5 代理、russh 回环夹具作跳板主机（本夹具 `DisableForwarding yes`，不能当跳板）和 `/usr/bin/nc` ProxyCommand 到达系统 OpenSSH，完成探测、打开、`stat` 与读取；打开之后的授权操作每次都重新经过同一路线。说明见 [SSH 连接路线](SSH_ROUTES.zh-CN.md)。

它没有写入、删除、重命名、权限修改或持久化凭据，也没有把认证绕过为独立 SFTP 登录。`from_channel` 与协议方法已通过本机 Rust `check --all-targets --all-features`，单测覆盖路径边界与元数据投影；尚未以 OpenSSH 夹具作为该 Rust wrapper 的网络验收。因此不能把本切片描述为 WindTerm SFTP 已完成。当前 `russh-sftp` 的 `read_dir` 会先接收对端目录结果，再由 wrapper 限制返回最多 4,096 项；这限制了下游结果，不等于对恶意超大目录的内存峰值提供完整预算，正式 IPC 前需改为可中止/分页的传输层。

依赖选择：当前工程把 `serde` 精确 pin 升至 `1.0.229`，以满足 `russh-sftp 3.0.1` 的最小版本约束；`Cargo.lock` 已同步。macOS arm64 本地通过不等于 Windows/Linux SFTP 运行通过；三端仍需真实 subsystem、取消、错误和大文件预算验收。

## 运行与清理

从仓库根目录运行，不需安装 npm 依赖：

```sh
# 一次验证，结束后停止全部受控服务进程并删除临时文件
node tests/fixtures/ssh-sftp/fixture.mjs

# 验证正常关闭及 listener 异常退出的进程、端口与文件清理
node --test tests/fixtures/ssh-sftp/fixture.test.mjs

# 为后续客户端调试保留对端，最多 600 秒
node tests/fixtures/ssh-sftp/fixture.mjs --serve
```

`--serve` 先完成同样的自检，然后输出临时 `connection.json` 的路径。该文件记录 loopback 地址、随机端口、当前系统用户名、临时私钥路径、独立 known_hosts 路径和测试目录；不包含私钥内容。客户端须显式使用这些测试材料。允许的 SSH 命令只有 `fixture-check`（返回一行 UTF-8 文本并以 7 退出）；SFTP subsystem 另行允许，普通 shell、PTY 和其他命令不开放。

正常完成、Ctrl-C、SIGTERM、600 秒期限及自检失败都会触发清理。受控命令/SFTP session 通过临时目录内的私有 Unix socket 连接监督进程；停止请求或通道断开会令 session wrapper 结束自己启动的 SFTP 子进程。正常关闭还冻结仍存活的监听器，枚举并冻结当前同 UID 子进程，再逐个终止这些已冻结的 PID。不会对历史 PID 或退出会话的旧进程组发信号；PID 小于等于 1、异常 UID 会被拒绝。进程枚举失败会导致非零退出，仍尽力终止已确认进程并删除测试材料，不应把失败当作完整回收证据。

**仅监听器意外退出时，OpenSSH 子进程会被重新托管，不能再靠旧 PPID 查全它们。** 已进入 ForceCommand 的会话由上述生命周期通道回收；未进入命令的连接则受 OpenSSH 自身 `LoginGraceTime 10` 与 `UnusedConnectionTimeout 2` 限制。异常退出路径等候 12.25 秒上界后才删除测试材料并以非零状态结束。回归测试实际同时保留 SFTP、已认证但没有 channel 的 `ssh -N`、尚未认证的 TCP 连接，然后只终止监听器，确认全部已观察到的服务 PID 消失。短超时专为本地自动化测试设置，不能用来推断正式产品交互超时策略；首次信任弹窗若等待超过认证期限需要重新连接。

SIGKILL、系统崩溃或断电无法运行清理。发生这类中断时，先根据本次终端输出的 `connection.json` 路径及目录中的 `sshd.pid` 核对残留进程，再只停止该次夹具的进程树，最后删除该临时目录。PID 可能被复用，不能仅凭旧 pid 文件杀进程；不要执行全局 `pkill sshd`，不要批量删除其他 SSH 配置。

## 隔离范围

- 系统 `sshd` 使用独立 `-f` 配置，不启动 Remote Login、systemd 或其他系统 SSH 服务，不修改系统配置、不需要 sudo，也拒绝以 root 运行。
- 仅绑定 `127.0.0.1` 随机非特权端口，禁用 IPv6 监听、密码、交互式认证、用户 rc、用户环境注入、TTY、X11、agent/TCP/Unix socket 转发。
- 每次生成新的 Ed25519 host key、合法 client key 和错误 client key。权限为目录 `0700`、文件 `0600`；私钥和测试文件只保存在临时目录，不写入仓库、不输出秘密内容。
- `ssh` / `sftp` 使用 `-F /dev/null`、`IdentityAgent=none`、`IdentitiesOnly=yes` 和独立 known_hosts，不读取个人 SSH 配置、密钥或 agent。受信主机公钥来自本次生成的 host key，不通过网络扫描自动接受。
- 不创建系统账号；认证使用当前非 root 系统账号，但只接受本次生成的授权公钥。ForceCommand 仍经账号登录 shell 执行，因此本轮只允许已实跑的 `/bin/zsh`，并设置临时 `ZDOTDIR`、空 `BASH_ENV` / `ENV`。其他 shell 直接拒绝，不自动修改账号；特别是 Bash 在 SSH 非交互场景可能读取 `.bashrc`，尚未验证这种边界。系统级 zsh 启动文件和系统 OpenSSH 策略仍适用。
- **SFTP 的 `-d` 只设置起始目录，不是 chroot，也不是文件系统沙箱。** 对端保留当前 UID 的文件权限；只能连接自己控制的客户端，测试只使用 `remoteDirectory` 及夹具生成文件。不要让不可信客户端、路径遍历测试或私人目录操作使用本夹具。需要强文件系统隔离的恶意路径/多用户测试，应另用容器或专用 VM。

OpenSSH `StrictModes` 保持开启。macOS 使用系统提供的用户临时目录；Linux 使用用户 home 下新建的 `.new-windterm-ssh-*` 临时目录，避免 `/tmp` 的可写祖先目录导致授权文件被拒绝。该目录会自动删除，不使用 `~/.ssh`。根路径包含空格或 shell/config 特殊字符时直接拒绝；不尝试拼接或执行不受控路径。

## 已验证内容与应用侧待验收内容

| 场景 | 本夹具证据 | 后续应用仍需验证 |
| --- | --- | --- |
| SSH 公钥认证、文本和退出 | 真实系统 ssh → 临时 sshd；精确 UTF-8 文本 `P0_SSH_OK 中文 🌏`、退出码 7 | Rust 认证、Channel/退出状态、UI 错误反馈和取消 |
| 未记录主机 | 空 known_hosts + strict checking，CLI 拒绝，退出 255 | 首次信任弹窗、拒绝后无连接、持久化与窗口权限 |
| 错误公钥认证 | 独立错误 key 被拒绝，退出 255 | 应用认证失败语义、重试、秘密生命周期 |
| 不匹配的已记录主机 key | 在独立 known_hosts 放置错误 pin，真实握手被拒绝，退出 255 | 应用保存 pin、对端真实轮换/重启后的阻断及显式更新；此处没有声称做过在线 host key 轮换 |
| 命令边界 | 未列入 allowlist 的命令返回 126 | 正式 SSH 客户端的完整 shell/PTY 行为不在该夹具范围 |
| SFTP 往返一致性 | 上传、对端文件读取、下载三份 SHA-256 一致；二进制 1,048,596 字节，远端中文/emoji 文件名 | Rust SFTP、进度、取消、冲突、错误、完整大文件及 GUI 验收 |
| 主动关闭 | 保持已认证 SFTP 会话，再终止夹具；验证已观察到的服务 PID 消失、客户端下一请求发现断连、端口关闭、临时文件删除 | 正式客户端断网/唤醒、重连、取消、资源和 UI 状态 |
| 监听器异常退出 | 仅结束监听器，同时保留 SFTP、已认证 `ssh -N`、未认证连接；在 12.25 秒清理等待后确认服务 PID、连接、端口、临时文件均回收，夹具非零退出 | 应用自身意外退出、网络故障和远端进程管理是另一套验收 |

测试数据包含随机二进制，因此每次 SHA-256 都不同；校验的是同次上传源、服务端文件与下载结果一致，而非固定 hash。默认标准输出仅包含工具版本、范围、布尔检查、字节数与测试内容 hash。回归测试为 2 项集成测试，每次启动都包含 6 项真实 SSH/SFTP 协议检查，分别覆盖正常关闭与监听器异常退出；不计入浏览器 E2E 数量。

密码/keyboard-interactive、SSH agent/转发、ProxyJump、端口转发、SCP、断点续传、超大文件、恶意文件名、网络故障和应用主机信任持久化仍需独立夹具或扩展，不能从本轮成功推断支持。

## 跨平台与可重复性

脚本仅使用 Node 内置模块和系统 OpenSSH，不改变应用 `package.json` / Cargo 依赖。macOS 已实跑；Linux 分支包含常见系统 `sftp-server` 路径，但未在 Linux 实机运行，且同样要求账号 shell 为 `/bin/zsh`，常见默认 Bash 账号会明确拒绝。宿主 sshd 安装、账号锁定、`/run/sshd`、系统策略等也可能阻断非 root 启动，应保留失败并另用隔离 VM，不自动修改系统来绕过。Windows 直接明确拒绝，等待专门的 OpenSSH/隔离对端适配。无 Docker/Podman 的本机环境未安装或启动额外守护程序。

实现依据为本机 OpenSSH 10.3p1 的 `sshd(8)`、`sshd_config(5)`、`ssh_config(5)`、`sftp(1)` 和 `sftp-server(8)` 手册。在线官方入口：[OpenSSH manuals](https://www.openssh.com/manual.html)。关键边界对应 `-f` / `-D`、`AuthorizedKeysFile`、`ForceCommand`、`DisableForwarding`、`StrictModes`、`ChrootDirectory`、`LoginGraceTime` 和 `UnusedConnectionTimeout`；换平台需按该平台实际安装版本重新预检和实跑。不支持这些选项的旧版本会在启动预检明确失败。
