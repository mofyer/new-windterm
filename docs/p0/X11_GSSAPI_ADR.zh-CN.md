# X11 转发（C15）与 GSSAPI 认证（C14）决策记录

状态：X11 **已有 Rust 协议层探针（无界面、无 IPC），只在本仓库的 russh 夹具上验证过；对 OpenSSH + Xvfb 的 Linux CI 步骤已加入但尚未运行**。GSSAPI 仍为**提议，未写实现代码**。日期：2026-10-11，2026-10-12 补充 X11 实现。

## X11 转发（C15）

**协议层可行。** russh 0.64.1 提供 `Channel::request_x11`（在会话通道上请求 X11 转发，携带认证协议与 cookie），服务端随后为每个远端 X 客户端打开 `x11` 通道。本项目已把客户端对服务端主动通道的默认策略改为“未登记即拒绝”（见[转发说明](SSH_FORWARDING.zh-CN.md)），X11 将作为第三种登记路由加入：只有用户为该连接显式开启 X11 后，才接受 `x11` 通道并连到本机 X 服务（macOS 为 XQuartz 的 `DISPLAY` socket，Linux 为 `/tmp/.X11-unix/X<n>`，Windows 为 VcXsrv/X410 的 TCP 端口）。

安全要求：

- 使用**不可信转发**（与 OpenSSH `ForwardX11Trusted no` 对应）：发给服务端的是随机生成的假 cookie，本端在 `x11` 通道的首个包中校验并替换为真实 cookie（通过 `xauth` 读取），从而不把本机真实凭据交给远端。
- 只在用户为单个连接开启时生效；连接关闭时撤销路由、关闭所有 `x11` 通道。

验证所需：本机安装 XQuartz（当前机器未安装 `/opt/X11`），或在 Linux CI 上用 Xvfb；对端需要允许 `X11Forwarding yes` 的 OpenSSH 夹具，并安装 `xauth` 与一个最小 X 客户端（如 `xdpyinfo`）。**安装 XQuartz 会修改系统，需要你同意后再进行。** 本轮选择 Linux CI + Xvfb，没有安装 XQuartz。

### 已实现（探针，2026-10-12）

代码在 [`ssh_x11.rs`](../../apps/desktop/src-tauri/src/ssh_x11.rs)（经 `#[path]` 挂为 `ssh::x11`），测试在 `ssh_x11_tests.rs`。`ssh.rs` 只增加了 `Routes` 的 X11 槽位、在 `end_relays` 中清空它、并让 `server_channel_open_x11` 交给 `x11::accept`；`ssh_terminal.rs` 只把 `open_with` 改为委托给可带 X11 选项的 `open_session`，并在 PTY 请求之后、shell 请求之前发送 `x11-req`。

- **入口**：只有 Rust 方法 `Ssh::open_with_x11(…, LocalDisplay)`；异步的 `LocalDisplay::from_env()` 在阻塞线程上读取本机 `$DISPLAY` 与真实 cookie。没有界面和 IPC 命令，现有 `ssh_open` 不请求 X11，行为不变。
- **请求**：在交互终端的会话通道上发送 `x11-req`：协议 `MIT-MAGIC-COOKIE-1`，cookie 为每条连接新生成的 16 字节随机假 cookie（按 OpenSSH 的惯例以十六进制发送），single-connection 关闭，screen 0。服务端拒绝时整个终端打开失败，错误为 `SSH server refused X11 forwarding`，不会静默降级为没有 X11 的终端。
- **第三种登记路由**：每条连接的 `Routes` 多了一个 X11 槽位，`x11-req` 发出前登记。槽位为空（未开启，或连接已结束）时，服务端打开的 `x11` 通道一律拒绝。每条连接最多 32 个并发 `x11` 通道，超出即拒绝，通道结束后归还名额。服务端主动打开的其它通道策略不变。
- **逐通道校验**：先从通道读取 X11 连接建立包，大端（`B`）和小端（`l`）都支持。协议名必须是 `MIT-MAGIC-COOKIE-1`，数据必须正好是这条连接的假 cookie。比较用逐字节的 volatile 读取，耗时与差异位置无关，对应 OpenSSH 的 `timingsafe_bcmp`。名称与数据长度在 12 字节头里就能判定，最多缓冲 64 KiB、等待 15 秒。不符合时关闭通道，**不连接本机 X 服务**。符合后才连接本机 X 服务（5 秒期限），把真实 cookie 写到假 cookie 的位置，连同之后已收到的字节一起发出，然后双向转发（复用端口转发的 `forward::pump`）。
- **本机显示**：
  - `:n`、`unix:n` → Unix socket `/tmp/.X11-unix/X<n>`；
  - `/路径:n`（XQuartz 的 launchd socket）→ 该 socket，只去掉 `.screen`；
  - `host:n` → TCP 端口 6000+n。`localhost:n` 与 OpenSSH 一样按 `unix:n` 查 cookie；
  - 没有 Unix socket 的平台（Windows）上，`:n` → `127.0.0.1:6000+n`。
- **真实 cookie**：按固定绝对路径查找 `xauth`（`/usr/bin`、`/usr/X11/bin`、`/opt/X11/bin`、`/usr/X11R6/bin`），不走 `PATH`，执行 `xauth list <display>` 时不经 shell，只传入 `XAUTHORITY` 与 `HOME`，输出上限 64 KiB、5 秒超时。缺少 `DISPLAY`、找不到 `xauth`、或没有 16 字节的 `MIT-MAGIC-COOKIE-1` 时返回明确错误，不发送 `x11-req`。真实 cookie 用 `Zeroizing` 持有，不出现在 `Debug` 输出和错误信息里。
- **结束**：复用端口转发的中继取消机制（`Routes::end_relays`）。终端因任何原因结束（shell 退出、`ssh_close`、窗口重载或关闭、应用退出）时，X11 槽位被清空（真实 cookie 随之释放），所有 X11 中继结束，空闲的也一样，本机 X 连接随之关闭。

### 与 OpenSSH `ssh -X` 的差异（安全边界）

- 真实 cookie 不离开本机，但**没有**像 `ForwardX11Trusted no` 那样用 `xauth generate … untrusted` 生成受 X SECURITY 扩展限制的 cookie。远端 X 程序对本机 X 服务的权限与本机程序相同，例如可以截屏、读取键盘输入，因此只应对可信服务器开启。
- `DISPLAY` 指向 TCP 主机时，真实 cookie 以明文发往该主机，与 `ssh -X` 相同。
- 与 OpenSSH 一样直接连接 `/tmp/.X11-unix/X<n>`，不检查 socket 的属主；`$DISPLAY` 与该目录被视为本机用户环境的一部分。
- 未实现 `ForwardX11Timeout`、`XDM-AUTHORIZATION-1`、single-connection 模式。
- 终端结束时中继被直接丢弃，不向服务端逐个发送通道关闭；连接随后关闭。

### 验证记录

**已验证**（本机 macOS arm64）：

- `cargo test --locked --lib --all-features ssh::x11`：11 项通过，1 项忽略（需要 OpenSSH + Xvfb 的 ignored 测试）。对端是本仓库的 russh 夹具（`tests/support/ssh_terminal_fixture.rs`，新增 `x11-req` 记录、`x11 B|l|bad|hold` 命令，由夹具扮演远端 X 客户端），本机 X 服务是测试里的假 X 服务器（Unix socket，记录建立包后回显）。覆盖：
  - 两种字节序下，假 X 服务器收到的建立包与“带真实 cookie 的建立包”逐字节一致，同包附带的数据被回显；
  - `x11-req` 的参数（协议名、single-connection 关闭、screen 0），以及 cookie 为 32 位十六进制、不等于真实 cookie、每条连接不同；
  - 错误 cookie 的通道被关闭，本机 X 连接数为 0，之后正确的客户端仍可使用；
  - 未开启 X11 时 `x11` 通道被拒绝；服务端拒绝 `x11-req` 时终端不会打开；
  - 上限设为 2 时第 3 个通道被拒绝；终端退出后本机 X 连接全部收到 EOF；
  - 连接仍存活时调用 `end_relays`：中继结束、名额全部归还、槽位清空、之后的 `x11` 通道被拒绝，shell 仍可用；远端关闭通道后名额归还；
  - `DISPLAY` 解析、`xauth list` 输出解析，以及 `xauth` 子进程：不经 shell、参数原样传递、非零退出报错、输出超限时立即终止。
- 变异检查：分别去掉 cookie 替换、cookie 比较、槽位清空、通道上限后，各至少有一项测试失败。
- 与本机自带 OpenSSH 10.3p1 `sshd` 的一次性互操作（临时实验，没有提交）：
  - X11 模式的夹具配置通过了 `sshd -t` 与夹具自检。
  - 用记录输入的替身 `xauth` 和 Python 编写的远端 X 客户端：真实 `sshd` 接受了我们的 `x11-req`（`DISPLAY=localhost:10.0`）；经 `sshd` 打开的 `x11` 通道在两种字节序下都被替换为真实 cookie 并回显；错误 cookie 被关闭，没有连接本机 X。
  - 这只说明报文能与真实 `sshd` 互通，不是 Xvfb/`xdpyinfo` 验证。

**Linux CI 已通过**：

- Linux CI 步骤 `Run X11 forwarding against OpenSSH and Xvfb (Linux only)`，运行 [`x11-client.test.mjs`](../../tests/fixtures/ssh-terminal/x11-client.test.mjs)，流程如下：
  1. 用 apt 安装 `openssh-server`、`xvfb`、`xauth`、`x11-utils`；
  2. 用生成的 cookie 启动私有 Xvfb，并先确认没有 cookie 时 `xdpyinfo` 被拒；
  3. 以 `--x11` 启动 OpenSSH 终端夹具：`X11Forwarding yes`，其它转发关闭，远端 `XAUTHORITY` 指向夹具私有文件，不碰真实 `~/.Xauthority`；
  4. 运行 ignored 测试 `ssh::x11::tests::real_openssh_x11_forwarding`：经我们的 Rust 客户端在远端执行 `xdpyinfo`，断言远端 `DISPLAY` 是 `localhost:N.0`、屏幕尺寸为 Xvfb 设定的 `1234x567`，且远端 xauth 中的 cookie 不是真实 cookie。
- 设置 `P0_X11_REQUIRED=1` 时，缺少前提条件算失败，而不是跳过。
- 结果：[run 38207141339](https://github.com/mofyer/new-windterm/actions/runs/38207141339) 通过，远端 `xdpyinfo` 输出 `P0_X11_OK localhost:10.0  dimensions: 1234x567 pixels`。
- 此前两次运行（38202512575、38206136775）中，`xdpyinfo` 已经读到 Xvfb，只因测试中两处字符串比对的写法问题被判失败：PTY 行尾的 CR，以及 xdpyinfo 在显示名后补的双空格。这两处已修正。

**未验证**：

- 真实 X 服务器上的真实 X 程序：窗口显示、`xclock` 一类图形程序、输入法、多窗口、大流量、长时间运行、断线。
- macOS XQuartz：未安装。XQuartz launchd socket 路径的连接，以及 `xauth list` 对该显示名的匹配，都没有验证。
- Windows：VcXsrv/X410 的 TCP 显示没有验证。Windows 上通常没有 `xauth`，目前会因找不到 `xauth` 而拒绝；不支持用 `-ac` 关闭认证的 X 服务器。
- Wayland/XWayland；经跳板或代理路线的 X11（代码路径相同，未单独测试）。
- 界面与 IPC：尚无入口。

运行：

```sh
cd apps/desktop/src-tauri && cargo test --locked --lib --all-features ssh::x11
node --test tests/fixtures/ssh-terminal/x11-client.test.mjs   # 仅 Linux，需要 sshd、Xvfb、xauth、xdpyinfo；其它平台跳过
```

## GSSAPI（gssapi-with-mic，C14）

**协议层可行，但需要平台 GSS 桥接。** russh 0.64.1 提供 `authenticate_gssapi_with_mic`，由调用方实现 `GssapiAuthenticator`（选择机制 OID、逐步生成令牌、计算 MIC）。也就是说 russh 只负责 SSH 报文，Kerberos 本身要接系统库：

- macOS：系统自带 `GSS.framework`（Heimdal）与 `kinit/klist`，可通过 FFI 调用 `gss_init_sec_context`/`gss_get_mic`；无需新 crate，但要写 unsafe 绑定并做独立审查。
- Linux：MIT krb5 或 Heimdal 的 `libgssapi`（动态链接，许可证需核查）。
- Windows：SSPI（`InitializeSecurityContext`），可经 windows-sys 调用。

验证所需：一个测试 Kerberos 领域（KDC）、服务主体 `host/<主机>@REALM` 的 keytab 和启用了 `GSSAPIAuthentication yes` 的 OpenSSH 服务端。本机没有 KDC（`/usr/libexec/kdc` 不存在）。可选路线：在 Linux CI 容器内启动 MIT krb5 KDC 与 sshd 做端到端测试，或由你提供企业测试领域。FEATURE_PARITY 已注明 2.7.0 的 README 与延期路线图在这一项上矛盾，**须先在上游实机确认该选项是否真的完成认证**，再决定投入。

## 结论

两项都不阻断 Rust + russh 路线：报文与通道已有库支持，剩余工作是平台集成与受控测试环境。X11 已有协议层探针，仍缺真实 X 服务器上的运行证据（Linux CI 结果待记录）、界面入口和 macOS/Windows 实测。GSSAPI 按上面所需条件准备好之后再实现。本轮没有改动功能矩阵中 C14、C15 的状态。
