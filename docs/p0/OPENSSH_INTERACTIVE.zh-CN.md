# OpenSSH 交互终端夹具

`tests/fixtures/ssh-terminal/` 是独立的 macOS/Linux OpenSSH 交互 PTY 回归夹具。它只监听 `127.0.0.1` 的随机高端口，不安装或修改系统 `sshd`，也不读取用户的 SSH 配置、agent、密钥或 Remote Login 设置。

## 信任边界

夹具创建 0700 临时根目录，并为 host/client/wrong-client 生成临时 Ed25519 密钥；密钥、known_hosts、配置和连接元数据均为 0600。客户端固定使用 `-F /dev/null`、`IdentityAgent=none`、`IdentitiesOnly=yes`、严格 host-key 校验、关闭转发和密码认证。授权 key 仅关闭 agent、端口、X11 和 user-rc 转发，保留 PTY；`PermitTTY yes` 由临时 sshd 配置显式启用。

`ForceCommand` 拒绝任何非空 `SSH_ORIGINAL_COMMAND`。无远程命令时只进入受控交互 wrapper；zsh 使用 `-f -i`、Bash 使用 `--noprofile --norc -i` 启动（跳过启动文件、保留 PTY 交互），并设置临时 `HOME`/`ZDOTDIR`/`HISTFILE=/dev/null`。命令白名单为：

- `printf`：验证 UTF-8 中文和 emoji；
- `stty size`：验证 PTY 行列；
- `generate`：最多生成 2 MiB 的固定 `X` 数据，并可通过 Ctrl-C 中断；
- `exit`：以退出码 7 结束。

测试客户端只发送以上固定字符串和单个 Ctrl-C，不接受用户输入作为远程命令，也不提供任意 OS shell 或外部 API。`generate` 使用临时目录内的 Node 子进程，收到 SIGINT 后退出；活跃客户端、临时 sshd 进程组及确认属于本夹具的同 UID 子进程树在测试结束时受监管并清理。

## 运行

默认执行一次完整自检：

```sh
node tests/fixtures/ssh-terminal/fixture.mjs
```

Node 回归测试：

```sh
node --test tests/fixtures/ssh-terminal/fixture.test.mjs
```

需要给手工客户端读取连接元数据时使用 `--serve`。元数据只供本机当前用户的临时测试读取；终止进程会删除临时目录和凭据：

```sh
node tests/fixtures/ssh-terminal/fixture.mjs --serve
```

仅支持非 root 的 macOS/Linux 环境；Windows 会跳过。没有系统 OpenSSH `sshd`、`ssh` 或 `ssh-keygen` 时同样跳过。该夹具目前独立验证系统 OpenSSH 的 PTY 行为，尚未接入 Tauri/Rust `ssh_open` IPC；Rust 客户端接入仍需单独的协议回归。
