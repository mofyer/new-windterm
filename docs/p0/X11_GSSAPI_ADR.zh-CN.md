# X11 转发（C15）与 GSSAPI 认证（C14）决策记录

状态：**提议；两项都需要外部环境才能验证，本轮未写实现代码**。日期：2026-10-11。

## X11 转发（C15）

**协议层可行。** russh 0.64.1 提供 `Channel::request_x11`（在会话通道上请求 X11 转发，携带认证协议与 cookie），服务端随后为每个远端 X 客户端打开 `x11` 通道。本项目已把客户端对服务端主动通道的默认策略改为“未登记即拒绝”（见[转发说明](SSH_FORWARDING.zh-CN.md)），X11 将作为第三种登记路由加入：只有用户为该连接显式开启 X11 后，才接受 `x11` 通道并连到本机 X 服务（macOS 为 XQuartz 的 `DISPLAY` socket，Linux 为 `/tmp/.X11-unix/X<n>`，Windows 为 VcXsrv/X410 的 TCP 端口）。

安全要求：

- 使用**不可信转发**（与 OpenSSH `ForwardX11Trusted no` 对应）：发给服务端的是随机生成的假 cookie，本端在 `x11` 通道的首个包中校验并替换为真实 cookie（通过 `xauth` 读取），从而不把本机真实凭据交给远端。
- 只在用户为单个连接开启时生效；连接关闭时撤销路由、关闭所有 `x11` 通道。

验证所需：本机安装 XQuartz（当前机器未安装 `/opt/X11`），或在 Linux CI 上用 Xvfb；对端需要允许 `X11Forwarding yes` 的 OpenSSH 夹具，并安装 `xauth` 与一个最小 X 客户端（如 `xdpyinfo`）。**安装 XQuartz 会修改系统，需要你同意后再进行。**

## GSSAPI（gssapi-with-mic，C14）

**协议层可行，但需要平台 GSS 桥接。** russh 0.64.1 提供 `authenticate_gssapi_with_mic`，由调用方实现 `GssapiAuthenticator`（选择机制 OID、逐步生成令牌、计算 MIC）。也就是说 russh 只负责 SSH 报文，Kerberos 本身要接系统库：

- macOS：系统自带 `GSS.framework`（Heimdal）与 `kinit/klist`，可通过 FFI 调用 `gss_init_sec_context`/`gss_get_mic`；无需新 crate，但要写 unsafe 绑定并做独立审查。
- Linux：MIT krb5 或 Heimdal 的 `libgssapi`（动态链接，许可证需核查）。
- Windows：SSPI（`InitializeSecurityContext`），可经 windows-sys 调用。

验证所需：一个测试 Kerberos 领域（KDC）、服务主体 `host/<主机>@REALM` 的 keytab 和启用了 `GSSAPIAuthentication yes` 的 OpenSSH 服务端。本机没有 KDC（`/usr/libexec/kdc` 不存在）。可选路线：在 Linux CI 容器内启动 MIT krb5 KDC 与 sshd 做端到端测试，或由你提供企业测试领域。FEATURE_PARITY 已注明 2.7.0 的 README 与延期路线图在这一项上矛盾，**须先在上游实机确认该选项是否真的完成认证**，再决定投入。

## 结论

两项都不阻断 Rust + russh 路线：报文与通道已有库支持，剩余工作是平台集成与受控测试环境。按上面所需条件准备好之后再实现；在那之前，功能矩阵中的 C14、C15 保持原状态。
