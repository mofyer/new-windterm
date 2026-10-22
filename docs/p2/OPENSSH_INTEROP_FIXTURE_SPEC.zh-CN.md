# OpenSSH 互操作夹具规格（P2 准备）

状态：**准备中；仅定义 L2 互操作夹具，不代表 P2 已进入，也不代表任何产品能力已验收。**

本规格为 P2 的 SSH、端口转发和认证验收准备一个可重复的隔离 OpenSSH 场景。它只约束测试夹具和证据格式，不修改产品连接代码，不放宽 P1 的门禁。正式进入 P2 仍以 [`P2_ACCEPTANCE_MATRIX.zh-CN.md`](P2_ACCEPTANCE_MATRIX.zh-CN.md) 的前置条件为准。

## 现有夹具边界

当前 [`tests/fixtures/ssh-terminal/fixture.mjs`](../../tests/fixtures/ssh-terminal/fixture.mjs) 已提供系统 OpenSSH PTY、X11 和 agent forwarding 的独立场景。它只在非 root 的 macOS/Linux 运行，并且要求 `/usr/sbin/sshd`、`/usr/bin/ssh` 与 `ssh-keygen`。每次启动都会：

- 在临时目录创建独立的 host、client、wrong-client Ed25519 key，目录 0700，私钥和公钥文件 0600；
- 使用临时 `sshd_config`、随机回环端口和临时 `authorized_keys`，不读取用户 SSH 配置、用户 agent、用户 key 或系统 sshd 配置；
- 写入仅包含本次回环主机的 `known_hosts`，并通过 metadata 文件向测试进程交付端口、用户名和 SHA256 指纹；
- 退出时终止由本次配置创建的 sshd/通道进程并删除临时目录。强制杀进程或系统崩溃后的遗留目录必须按打印路径人工清理，不能按通配符删除其它临时目录。

这些现有场景是 P0/P1 的证据。它们没有证明端口转发、真实生产网络、真实设备或原生 WebView 产品验收。

## P2 最小夹具形态

每个互操作用例启动一个**单能力**的临时 sshd。能力开关互斥；一次进程只允许下列其中一项：

- `local-forward`：仅允许本地 `-L` 转发，用于 C16；
- `remote-forward`：仅允许远端 `-R` 转发，用于 C17；
- `dynamic-forward`：仅允许 SOCKS5 `-D`，用于 C18；
- `agent-forward` 或 `x11-forward`：沿用现有独立场景，用于 C10/C15。

没有选择能力时，转发全部关闭。禁止把本地、远端、动态、agent 和 X11 转发合并到同一个成功样本；这样可把“某个开关意外放行其它能力”变成单独的拒绝断言。每个能力模式都要同时保留一个负向连接尝试。

临时 sshd 的最低配置约束如下：

```text
ListenAddress 127.0.0.1
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
UsePAM no
StrictModes yes
AllowUsers <temporary-user>
PermitTTY no
X11Forwarding no
AllowAgentForwarding no
GatewayPorts no
PermitUserEnvironment no
PermitUserRC no
```

转发模式再增加一条能力白名单：

- `local-forward` 使用 `AllowTcpForwarding local`，`PermitOpen 127.0.0.1:<target-port>`，不设置 `PermitListen`；
- `remote-forward` 使用 `AllowTcpForwarding remote`，只允许测试声明的 `PermitListen 127.0.0.1:<listen-port>`，不设置 `PermitOpen`；
- `dynamic-forward` 只使用客户端的 SOCKS5 监听，服务端仍只允许 `AllowTcpForwarding local`，`PermitOpen` 绑定回环目标白名单。

具体 OpenSSH 版本若不接受某个细粒度选项，夹具必须在启动前报告“环境不支持”并跳过；不能删除限制后继续测试。所有目标服务和监听都绑定 127.0.0.1，禁止把 `GatewayPorts` 或 `*` 监听作为默认值。

## 临时 key 与 known_hosts

密钥和信任文件必须在同一个临时根目录或测试专用临时目录内产生：

1. 生成独立 Ed25519 host key、client key 和 wrong-client key，不使用 `~/.ssh`、SSH agent 或仓库内的固定 key。
2. `authorized_keys` 只收录本次 client 公钥，并保留能力相关的限制；非对应模式明确写入 `no-port-forwarding`、`no-agent-forwarding` 或 `no-X11-forwarding`。
3. `known_hosts` 只写入 `[127.0.0.1]:<port>` 的本次 host 公钥。客户端一律使用 `-F /dev/null`、`GlobalKnownHostsFile=/dev/null`、显式 `UserKnownHostsFile=<temporary-known-hosts>`、`IdentitiesOnly=yes`、`IdentityAgent=none`、`StrictHostKeyChecking=yes` 和 `UpdateHostKeys=no`。
4. 负向用例使用空 known_hosts、错误 key 或替换后的 host key，分别证明未知、认证失败和指纹变化不会被静默接受。不要用 `StrictHostKeyChecking=accept-new` 代替确认路径。
5. 测试结束后确认 sshd、转发通道、目标服务和临时 agent 均退出，再删除目录；删除失败算清理失败，不能只报告主断言通过。

metadata 只向测试进程传递最小字段：`scope`、角色、回环端口、临时用户名、SHA256 指纹和能力名。私钥内容、完整 known_hosts 行、认证口令和 agent socket 路径不能写入标准输出或 CI 摘要。

## 单一 forwarding 能力的最小场景

以 `local-forward` 为最小首个实现，目标服务也是夹具的一部分：目标服务随机绑定回环端口，接受一次连接，读取带 nonce 的有限字节帧并回写固定响应和 SHA256。测试步骤为：

1. 创建临时目录、key、known_hosts 和目标服务；确认权限后再启动 sshd。
2. 以 `-N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:<local-port>:127.0.0.1:<target-port>` 建立 SSH 隧道。连接必须使用显式临时 key 和 known_hosts。
3. 通过本地监听端口发送固定长度的二进制帧（包含 `0x00`、非 ASCII 字节和随机 nonce），核对目标端收到的 SHA256 与回写响应。不要把帧原文写入日志。
4. 断开 SSH 进程后，确认本地监听不再接受新连接、目标服务没有残留连接，且其它转发模式的负向尝试被服务端拒绝。
5. 重复一次连接，使用新的 nonce 和新的临时 SSH 进程；不能把第一次连接存活当作重连通过。

`remote-forward` 和 `dynamic-forward` 复用相同的目标服务、nonce、哈希和清理契约，只改变一个能力开关与连接方向。C16/C17/C18 必须分别记录，不得用本地转发通过推断其它两项。

## 失败计数与状态

一个**尝试**是一次完整的“创建临时服务 → 建立 SSH → 执行目标动作 → 关闭并清理”生命周期。建议每个场景运行三次独立尝试；每次尝试重新生成端口、key、known_hosts 和 nonce。

- `failure_count` 每次尝试最多增加 1：任一强制断言失败、超时、意外退出、错误的转发方向、字节哈希不一致或清理残留都算该尝试失败。附加断言失败写入诊断列表，不重复增加场景失败数。
- `skip_count` 只记录缺少系统 OpenSSH、root 账户、平台不支持或版本不接受安全配置；跳过不能计入通过，也不能计入失败。
- `infra_error` 单独记录测试运行器崩溃、无法收集退出状态或宿主环境被外部终止；出现时场景状态为“阻塞”，不能用剩余样本宣称通过。
- 三次尝试全部通过且没有清理失败，才能写“互操作通过（L2，列出的平台和 OpenSSH 版本）”。任何一次失败都保持“阻塞/失败”，重跑只能产生新证据，不能覆盖旧失败。
- 失败原因只使用稳定分类：`host-key-rejected`、`auth-rejected`、`forwarding-rejected`、`target-unreachable`、`byte-mismatch`、`timeout`、`unexpected-exit`、`cleanup-failed`、`infra-error`。原始 stderr 作为受控附件保存前必须脱敏。

## 秘密与日志脱敏

脱敏必须在写日志和上传 artifact 之前完成，不能依赖事后删除。规则如下：

- 禁止输出私钥、公钥完整 base64、`authorized_keys`、完整 known_hosts、口令、token、nonce 原文、agent 协议数据和环境变量快照；匹配 `BEGIN .* PRIVATE KEY`、`ssh-ed25519 AAAA`、`password=`、`token=` 等模式的内容统一替换为 `<redacted>`。
- 允许输出协议、能力名、平台/版本、失败分类、退出码、耗时、字节数、哈希前 12 位、host key SHA256 指纹前 16 位和端口是否为回环；完整路径只保留 `<fixture-root>/...`，不保留用户名家目录。
- SSH 命令行和环境变量使用 allowlist 组装；不能使用 `set -x`、`ssh -vvv` 或把带秘密的 argv 直接打印。代理/跳板口令不进入命令行。
- stderr 只在经过同一脱敏函数后保存。若无法证明脱敏完整，则保存分类和退出码，丢弃原始 stderr，并将证据标为“不完整”。
- CI artifact 必须包含 manifest：提交、平台、OpenSSH 版本、能力、尝试编号、状态、脱敏规则版本。manifest 不得包含私钥、完整主机 key 或认证材料。

## 证据与验收边界

该夹具属于 L2 外部进程互操作证据。它可以支持“本提交在记录的平台、OpenSSH 版本和单一能力下完成隔离往返”，不能支持以下结论：

- 原生 WebView、Tauri IPC、UI 状态或产品配置已验收；
- 真实公网 SSH、企业代理、多跳生产网络或真实网络设备已通过；
- 未运行的 forwarding 能力、Windows OpenSSH 或真实硬件已通过；
- P1 的 Windows 首次目录查询、未知 stderr 或 ConPTY 首轮超时已经归因。

每次运行应按 [`P2_ACCEPTANCE_MATRIX.zh-CN.md`](P2_ACCEPTANCE_MATRIX.zh-CN.md) 的模板记录 C ID、提交、平台、服务端版本、能力、尝试数、`failure_count`、`skip_count`、清理结果、脱敏 artifact 索引和未覆盖项。只有在相同证据层级完成独立复核后，才能关闭对应的准备项。

## 当前下一步

1. 保持现有 `ssh-terminal`、`agent` 和 `x11` 场景不变，先为 `local-forward` 增加单能力临时 sshd 与回环目标服务的设计评审。
2. 评审通过后再实现夹具和负向断言；实现阶段不得修改产品连接代码或放宽现有 OpenSSH 信任策略。
3. 在 macOS/Linux 的受控环境分别复跑三次，随后再决定是否需要 Windows 专用 OpenSSH 夹具；未完成的平台保持“未准备/阻塞”。
4. P1 未关闭前，所有结果继续标记为 P2 准备，不得据此合并 `main` 或宣布进入 P2。
