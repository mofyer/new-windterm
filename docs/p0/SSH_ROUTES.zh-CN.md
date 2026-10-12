# SSH 连接路线：代理、ProxyCommand 与跳板（C07、C08、C19、C20）

日期：2026-10-12。状态：**SSH 连接对话框可以选择路线，路线已接入 `ssh_probe`、`ssh_accept`、`ssh_open` 与只读 SFTP（`ssh_sftp_open/list/metadata/read`）。只在本机测试代理、`/usr/bin/nc`、russh 回环夹具和系统 OpenSSH 受控夹具上验证；浏览器测试使用 IPC stub。没有保存配置，没有在原生桌面窗口、Windows/Linux 或真实代理软件上验收，不代表这些功能完成。**

代码：[`ssh_route.rs`](../../apps/desktop/src-tauri/src/ssh_route.rs)（路线校验、绑定、建立连接与两步探测）、[`ssh_proxy.rs`](../../apps/desktop/src-tauri/src/ssh_proxy.rs)（HTTP CONNECT、SOCKS5、ProxyCommand 协议，原探针见[转发说明](SSH_FORWARDING.zh-CN.md)）、前端 [`ssh-route.ts`](../../apps/desktop/src/ssh-route.ts) 与 [`ssh-verification.ts`](../../apps/desktop/src/ssh-verification.ts)。

## 路线与 IPC

`ssh_probe` 新增可选参数 `route`（省略或 `null` 即直连）。未知字段一律拒绝（`deny_unknown_fields`）。

| 路线 | `route` | 说明 |
| --- | --- | --- |
| 直连 | `{ kind: "direct" }` | 与原行为相同 |
| HTTP CONNECT 代理 | `{ kind: "httpConnect", host, port, username?, password? }` | 可选 Basic 认证；只报告状态码，不引用代理返回的原因短语 |
| SOCKS5 代理 | `{ kind: "socks5", host, port, username?, password? }` | RFC 1928 / 1929；目标主机名交给代理解析 |
| ProxyCommand | `{ kind: "proxyCommand", command, argv }` | `argv` 必须与预览结果完全一致，见下文 |
| 跳板主机（ProxyJump，一跳） | `{ kind: "jump", host, port, username, privateKeyPath }` | 不能携带任何秘密；跳板凭据在第 2 步单独发送 |

新增两个命令，均已登记在 `lib.rs` 的 `generate_handler!`、`build.rs` 与 `capabilities/main.json`：

- `ssh_proxy_command_preview { request, command }` → `string[]`：只计算将要执行的 argv，不启动任何程序。
- `ssh_probe_through { challengeToken, operationId, scopeToken, credential }` → 目标主机的 challenge：跳板路线的第 2 步。

`Challenge` 新增两个字段：`stage`（`"jump"` 表示这是跳板主机的密钥，`"target"` 表示目标主机）和 `route`（路线摘要：代理地址与是否带认证、ProxyCommand 的 argv、跳板主机及其已确认指纹）。摘要从不包含口令或凭据。

`ssh_accept`、`ssh_open`、`ssh_sftp_open` 与 `ssh_sftp_list/metadata/read` 的参数不变，**没有**路线参数。

## 路线绑定

- 探测经与之后操作相同的路线读取目标主机密钥：代理和 ProxyCommand 路线下，指纹来自穿过该代理的连接；跳板路线下，目标密钥经跳板主机的 `direct-tcpip` 通道读取。
- challenge 在 Rust 内存中保存已校验的路线（包括代理口令、跳板主机的固定密钥与凭据）。消费 challenge 的命令只能使用其中的路线，WebView 无法在之后换路线。
- 只读 SFTP 授权（grant）同样保存路线；之后每次 `list/metadata/read` 重新连接时都走同一路线，并照旧固定校验目标主机密钥。
- 主机密钥固定校验不变。known_hosts 按目标自己的主机名与端口记录（与 OpenSSH 经 ProxyJump 时一致），跳板主机按它自己的主机名与端口记录，两者互不影响。
- 失败分类沿用 SFTP 授权规则：跳板主机密钥变化、跳板凭据被拒属于“与已确认信任矛盾的证据”，会吊销授权并要求重新核对；代理不可达、代理拒绝隧道等只是传输失败，保留授权。

## 跳板主机的两步信任

1. **探测跳板主机。** `ssh_probe` 带 `kind: "jump"`：Rust 直连跳板主机，只读取它的主机密钥，不认证，不发送任何凭据。返回 `stage: "jump"` 的 challenge，其中 `host`、`port`、`fingerprint`、`trust`、`savedFingerprint` 都是跳板主机的。
2. **核对跳板主机指纹。** 与普通主机相同：`new` 时用户核对后可选择保存（`ssh_trust_save`）；`known` 时对话框自动继续；`changed` 时阻止，只能经单独确认后用 `ssh_trust_replace` 替换。
3. **经跳板探测目标。** `ssh_probe_through` 消费已确认的跳板 challenge，此时才发送跳板凭据。Rust 连接跳板主机并固定校验第 1 步确认的密钥，认证后打开到目标的 `direct-tcpip` 通道，在通道上读取目标主机密钥，返回 `stage: "target"` 的 challenge；其 `route` 摘要包含跳板主机与第 1 步确认的指纹。
4. **核对目标指纹并连接。** 规则同直连。之后的每次连接都先固定校验跳板主机密钥并用内存中的跳板凭据登录，再固定校验目标密钥、认证目标。

约束：

- 跳板 challenge 不能被 `ssh_accept/ssh_open/ssh_sftp_open` 消费（返回 `Confirm the jump host's key and then the target's key before connecting`）；目标 challenge 也不能用于 `ssh_probe_through`（返回 `This SSH challenge is not for a jump host`）。两种误用都在移除 challenge 之前拒绝，被拒的 challenge 保持待用。
- 任一主机的密钥变化都阻止连接：第 1 步为 `changed` 时不能进入第 2 步，跳板主机不会收到任何认证；目标为 `changed` 时不能连接；确认之后跳板主机若换了密钥，后续连接在跳板握手处失败（`Jump host key changed; authentication was not attempted`），目标不会收到认证。
- 后端的跳板凭据支持私钥（可带口令）、密码、SSH agent 和预填答案的 keyboard-interactive；对话框只提供前三种。不支持连接时逐轮提示（`keyboardInteractivePrompted`），后端在消费 challenge 之前拒绝。其它凭据校验失败（例如私钥方式却没有私钥路径）发生在消费之后，需要从表单重新开始。
- known_hosts 以目标主机名记录：经跳板时目标名由跳板主机解析，例如经不同跳板访问的 `10.0.0.5` 会共用同一条记录（与 OpenSSH 不设 `HostKeyAlias` 时相同），因此可能显示为 `changed` 并阻止连接，不会静默接受。
- 跳板主机本身总是直连；不支持多跳，也不支持“经代理到跳板主机”。跳板会话的 rekey 与目标会话一样被拒绝并提示重连。

## ProxyCommand：先确认 argv，再运行

- `ssh_proxy_command_preview` 不经 shell 拆分命令：按空白分隔，单引号内原样，双引号内支持 `\"` 与 `\\`；只替换 `%h`、`%p`、`%r`、`%%`，其它 `%` 序列和控制字符直接拒绝。命令 1–4096 字节、最多 64 个参数、替换后合计不超过 16 KiB；程序必须是绝对路径（不按 `PATH` 查找）。
- 对话框把预览出的每个参数逐项按纯文本显示，用户勾选确认后才允许检查指纹。修改命令、目标主机、端口或用户名都会使预览失效，需要重新预览和确认。
- **探测时就会运行 ProxyCommand**（必须穿过它才能看到主机密钥），因此 `ssh_probe` 必须带回用户确认过的 argv；Rust 按当前目标重新计算，与之不一致即拒绝，此时不会启动任何进程。之后的连接只运行 challenge 或授权中保存的那份 argv。
- 子进程的 stdin/stdout 作为 SSH 字节流，stderr 丢弃（不显示诊断信息）；环境变量从桌面进程继承。
- 进程清理：Unix 上子进程在自己的进程组中启动，连接结束时对整个进程组发送 `SIGKILL`，因此它在后台启动的辅助进程也一起结束；随后回收子进程，若子进程未能立即退出（例如卡在不可中断的 I/O），改由独立线程等待回收，不阻塞异步工作线程。用 `setsid` 脱离进程组的后代不受约束，并可能让读取线程一直等到它退出。
- Windows 上以 `CREATE_NO_WINDOW` 启动，并在启动后立即放入 kill-on-close Job Object，连接结束时终止整个 Job；放入失败则结束子进程并报错。子进程启动与放入 Job 之间有极短窗口，此间创建的孙进程不在 Job 中。Windows 代码只做过本机交叉类型检查（`cargo clippy --target x86_64-pc-windows-msvc`，不链接），尚未在 Windows 上运行。
- argv 会原样显示在对话框和 challenge 摘要中，也随 challenge / 授权留在内存里：不要把口令写进 ProxyCommand。

## 输入校验与秘密

- 目标、代理和跳板主机名：1–253 字节，只允许字母、数字与 `.-:`，不得以 `-` 开头；端口 1–65535。
- 代理用户名 1–255 字节、无控制字符，HTTP 用户名不得含 `:`（Basic 认证以 `:` 分隔）；代理口令最多 255 字节、不含 NUL；只有口令没有用户名会被拒绝。跳板主机的用户名与私钥路径沿用目标的校验规则，跳板凭据沿用目标凭据的长度限制。
- 代理口令和跳板凭据以 `Zeroizing` 保存在 challenge 与授权内存中，随过期、关闭授权、窗口重新加载或退出而释放；Basic 认证头与 SOCKS5 登录包在预先分配好容量的 `Zeroizing` 缓冲中构造，避免扩容时留下未清零的副本。不写入磁盘、known_hosts 或日志。
- 错误信息不含口令；测试逐一断言错误与路线摘要中没有测试口令。
- 前端在提交时读出所有口令后立即清空输入框。代理口令必须随探测发送（要穿过代理才能看到主机密钥）；跳板凭据只在第 2 步发送；目标凭据仍只在核对目标指纹之后发送。
- 清零的边界与原有密码路径相同：WebView 中的输入值、IPC JSON 及其反序列化中间副本无法保证清零。

## 证据（macOS arm64，本地）

- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --all-features ssh::route`：7 项通过，1 项需要外部夹具的保持 ignored。覆盖：各路线的 JSON 解析与未知字段拒绝（跳板路线不能带 `password`）；代理输入边界与摘要不含秘密；ProxyCommand 只接受与预览一致的 argv，换目标后旧 argv 失效（程序路径按平台取绝对路径，测试本身不启动程序）；跳板 challenge 与目标 challenge 不能互相顶替且被拒后仍待用；SFTP 授权保留路线与代理登录；跳板步骤先检查窗口归属和凭据类型，失败时不消费 challenge。
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --all-features ssh::proxy`：5 项通过。包括 HTTP 407 与错误口令的报错不含口令；ProxyCommand 结束后子进程被回收；新增的 `dropping_a_proxy_command_ends_the_processes_it_started` 以 `/bin/sh -c 'sleep 300 & echo $!; wait'` 作为程序，丢弃后子进程与其后台 `sleep` 都在 2 秒内消失。临时去掉 `killpg` 时该测试失败（后台进程存活），说明它确实覆盖进程组清理。
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test ssh_routes --all-features`：5 项通过（russh 回环夹具 + 测试代理，测试代理记录每条隧道）：
  1. HTTP CONNECT（Basic 认证）：探测指纹与真实密钥一致；之后固定命令 exit 7、交互终端 exit 7 都再次穿过同一代理（隧道计数 1 → 2 → 4）；错误代理口令返回 `HTTP proxy refused the tunnel (status 407)`，SSH 服务端没有收到连接。
  2. SOCKS5（用户名/密码）：SFTP 打开同样穿过代理并在认证后才因夹具没有 SFTP 服务而失败；错误口令和缺少登录都在代理处失败，错误不含口令。
  3. ProxyCommand（Unix，需要 `/usr/bin/nc` 与 `/usr/bin/touch`）：被改动的 argv、以及为另一端口预览的 argv 都在启动前被拒——作为标记的 `touch` 文件没有出现，服务端没有连接；确认过的 `/usr/bin/nc %h %p` 完成探测、固定命令与终端。
  4. 跳板：第 1 步返回跳板主机自己的指纹，跳板与目标都没有收到认证或连接；跳板 challenge 不能直接用于连接；保存跳板密钥后第 2 步用密码登录跳板，返回目标指纹与带跳板指纹的摘要（摘要不含密码）；固定命令与终端都经跳板完成（跳板 `direct-tcpip` 计数 1 → 2 → 4），再次探测时跳板为 `known`；跳板换密钥后为 `changed`，第 2 步被阻止且跳板认证计数不变。
  5. 跳板错误密码返回 `Jump host: ...` 且不含密码、目标没有连接；逐轮提示的跳板凭据被拒；目标确认后跳板换密钥，连接在跳板握手处失败，目标认证计数不变。
- `node --test tests/fixtures/ssh-sftp/rust-client.test.mjs`：5 项通过，其中新增第 5 项运行 ignored 测试 `ssh::route::tests::real_fixture_sftp_through_routes`：对系统 OpenSSH（10.3p1）的只读 SFTP，依次经 HTTP CONNECT 代理、SOCKS5 代理、russh 夹具作跳板主机和 `/usr/bin/nc` ProxyCommand 完成探测、打开（列出登录目录）、`stat` 与读取小文件；两个代理各记录 4 条隧道，跳板记录 4 个 `direct-tcpip` 通道，说明打开之后的授权操作每次都重新经过同一路线。
- 浏览器（IPC stub）：见下文前端一节。

## 前端（浏览器 IPC stub）

[`ssh-route.spec.ts`](../../apps/desktop/tests/e2e/ssh-route.spec.ts) 14 项，全部 stub IPC，只证明对话框发送和显示的内容，不证明 Rust 的代理、ProxyCommand 或跳板网络行为：

- 浏览器演示模式下路线选择不可用；直连显式发送 `{ kind: "direct" }`，目标请求不变。
- HTTP CONNECT：代理口令只随 `ssh_probe` 发送，提交后输入框清空；`ssh_accept` 不带 `route`、不含代理口令。SOCKS5：匿名路线不带登录字段；只有口令没有用户名时阻止提交，不发出任何 IPC。
- ProxyCommand：未预览或未勾选确认时阻止探测；修改命令、目标主机、端口或用户名都会清空预览和确认；预览返回前输入已变化时丢弃该结果；argv 中的 `<img onerror>` 按纯文本显示，页面中不产生元素。
- 跳板：第 1 步只发送不含秘密的跳板路线；确认后才以 `ssh_probe_through` 发送跳板密码；第 2 步显示目标指纹与跳板摘要；`ssh_accept` 只带目标凭据。跳板 `changed` 时阻止第 2 步，直到经单独确认 `ssh_trust_replace`；两者都 `known` 时按 `ssh_probe → ssh_probe_through → ssh_accept` 顺序自动继续；保存跳板密钥发生在第 2 步之前；跳板 challenge 过期后被 `ssh_reject`，不能继续。
- 终端交接：代理或跳板路线下，`ssh_open` 只带 challenge 与目标凭据，不含路线、代理地址或任何跳板秘密。第 2 步进行中取消会调用 `ssh_cancel`，迟到的目标 challenge 被 `ssh_reject`，再次打开对话框时路线重置为直连。

## 审查

- `rust-reviewer`（2026-10-12）：无 CRITICAL；HIGH 1 项（ProxyCommand 单元测试在 Windows 上会因 `/usr/bin/nc` 不是绝对路径而失败）与 MEDIUM 3 项（Windows Job 在子进程启动后才指定；`Drop` 中阻塞等待子进程；进程组清理没有测试）均已处理：测试按平台选路径，`Drop` 改为不阻塞回收，新增进程组测试，Windows 窗口写入本文与代码注释。
- `security-reviewer`（2026-10-12）：无 CRITICAL / HIGH / MEDIUM。唯一 LOW 是原有问题：`ssh_auth.rs` 把预填的 keyboard-interactive 答案转成普通 `String` 交给 russh，这些副本不清零；跳板凭据若使用该方式同样受影响。本次未修改。

## 未验证与未完成

- 只用测试内回环代理验证；Squid、Dante、企业代理，NTLM / Digest 认证，HTTPS 代理与 SOCKS4 均未测试。
- 跳板只用 russh 回环夹具验证（OpenSSH 受控夹具禁用了转发），OpenSSH 作为跳板主机未测；多跳、经代理连接跳板不支持。
- ProxyCommand 只在 macOS 上用 `/usr/bin/nc` 验证；Linux 与 Windows 未运行（CI 的 Linux 若有 `/usr/bin/nc` 会运行集成测试，Windows 跳过）；Windows 的 Job Object 清理未运行验证；`%n`、`%C` 等 OpenSSH 其它转义不支持。
- 路线与凭据都不保存；每次连接都要重新填写。
- 原生 WKWebView / WebView2 窗口中的对话框未手工验证；浏览器测试使用 IPC stub，不等于 Rust 或原生成功。
- 端口转发、SCP 等其它 SSH 功能尚未接入路线。
