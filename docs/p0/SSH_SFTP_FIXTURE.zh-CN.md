# 本机 SSH / SFTP 受控夹具

状态更新：2026-10-11。本页保存 macOS arm64、Node 26.0.0、系统 OpenSSH 10.3p1 / LibreSSL 3.3.6 的历史受控夹具证据：6 项协议检查与 2 项生命周期测试，以及前一轮固定命令 Rust SSH 客户端接入。**它不提供交互 PTY/shell，也不证明应用 SFTP 完成。** 固定命令入口及历史 CI 范围见 [SSH_CLIENT](SSH_CLIENT.zh-CN.md)；当前交互 SSH 使用另一个有限命令 russh 夹具，见 [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)。最新代码、原生与 CI 验收统一见 [RESULTS](RESULTS.zh-CN.md)，不把本页旧 OpenSSH 结果当成当前轮通过。

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
