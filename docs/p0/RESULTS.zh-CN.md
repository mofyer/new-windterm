# P0 结果与下一步

日期：2026-10-11。**P0 仍在进行中**，完整功能基线、关键可行性与阶段验收均未完成。浅色白银浮层方向保持用户认可；用户随后明确回复“沿这个中性炭灰方向继续”，认可深色方向。本轮将真实 SSH 接入交互终端，并进行默认关闭的 PTY readiness 实验；方向认可与有限测试均不代表 IME、高输出性能或完整功能验收。

## keyboard-interactive 认证（C13）

认证模块新增 RFC 4256 多轮问答：服务端每轮的提示交给回调回答（最多 8 轮、每轮 16 个提示，空轮自动应答，回调返回空即取消）。当前界面提供“按提示顺序预填答案”的方式（两个密码型输入框，覆盖“密码 + 动态码”常见组合），答案与其它秘密一样只在核对指纹后发送。russh 集成测试：夹具两轮提示（密码、验证码）正确时进入 shell 并 exit 7，验证码错误被拒，答案不足时在发出猜测前停止；浏览器契约 1 项。尚缺实时显示服务端提示的对话框（提示文本须按纯文本渲染）与对真实 PAM/OpenSSH 的验证。

## 端口转发与跳板概念验证（C08/C16/C18）

Rust 协议层探针：本地转发（4 路并发各 256 KiB 往返一致、端口冲突、仅回环、目的地失败只影响该连接、停止后关闭）、SOCKS5 动态转发（IPv4/域名 CONNECT，BIND 返回 0x07）、跳板（经第一跳读取并固定第二跳密钥、第二跳独立认证、错误固定密钥在认证前失败）。连续 3 轮通过。对端为 russh 夹具，尚无界面与配置；远端转发、agent/X11 转发、代理与 ControlMaster 未做。[探针与排查记录](SSH_FORWARDING.zh-CN.md)

## tmux 控制模式概念验证（T22）

Rust 解析器把 `tmux -C/-CC` 字节流解析为命令响应与通知，按 tmux 规则解码窗格输出，解析并校验布局，维护窗口/窗格模型。单元测试在任意切分（含逐字节）下结果一致；对真实 tmux 3.6b 的集成测试验证了中文窗口名、分屏布局、命令/错误响应、输出字节解码、键入回显与 `%exit`，并做了反向验证。界面映射、流控与上游对照仍待完成。[实验与约束](TMUX_CONTROL.zh-CN.md)

## Free Type 草稿编辑概念验证（G03）

在终端光标处叠加原生 textarea 作为草稿：激活后按键、粘贴与输入法只进入草稿，终端 `onData` 为 0；Enter 一次性提交，Shift+Enter 换行，Esc 丢弃，输入法组合中的 Enter 不提交；草稿随光标和尺寸重新定位。浏览器 5 项通过（真实键盘事件）。编辑已发送到 shell 的命令行、上游交互对照与原生 IME 仍待验证。[实验与约束](FREE_TYPE.zh-CN.md)

## 文本折叠与大纲概念验证（G16/G17）

xterm 不能在实时缓冲中隐藏行，所以折叠放在由逻辑行渲染的只读历史视图中。隔离实验 4 项通过：按提示符生成大纲；折叠为一行摘要；复制跨摘要行时展开原始 300 行；搜索命中折叠区时只展开该折叠并选中命中词；重排后行映射自动重建；可直接作用于压缩归档读回的行（含颜色）。实时屏幕折叠、视图虚拟化、列级复制与上游行为对照仍待完成。[实验与约束](FOLDING.zh-CN.md)

## 压缩滚动历史概念验证（Q04/Q06）

隔离实验证明 xterm.js 路线可以用公开 API 实现“有界热窗口 + 压缩冷历史”：滚出屏幕的逻辑行连同颜色属性按 512 行一块压缩归档，归档前沿由 marker 跟踪，行在归档前被裁掉会报告缺口而不是静默丢失。浏览器 5 项实测：5 万行逐行一致、0 缺口、热缓冲恒为 1,024 行、1.79 MB 压缩至 243 KB、写入开销约 +5%；跨 78 个压缩块搜索 35 ms；两次重排后长行完整；颜色与宽字符可回放；备用屏幕不入历史。尚未接入生产终端，也缺少浏览冷历史的界面、超链接与时间戳、原生 WKWebView 测量和上游对照。[实验与约束](HISTORY_ARCHIVE.zh-CN.md)

## SSH 认证方式

三个真实入口（固定命令验证、交互终端、只读 SFTP）共用新的认证模块 `ssh_auth.rs`：私钥文件（Ed25519/ECDSA，可带口令）、密码、本机 SSH agent（Unix `SSH_AUTH_SOCK`；Windows OpenSSH agent 命名管道 `\\.\pipe\openssh-ssh-agent`）。probe 不认证，也不携带密码或口令；凭据只在核对指纹后的 `ssh_accept / ssh_open / ssh_sftp_open` 中传入，后端以 `Zeroizing` 持有并在用完后清零，不保存、不写日志、不回显到错误信息。SFTP 浏览授权在有效期内保留凭据，用于每次重连。服务端拒绝凭据会吊销 SFTP 授权；agent 不可用、口令错误等本地失败不会吊销。agent 最多尝试 4 把公钥，避免耗尽服务端 `MaxAuthTries`。

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 凭据按方法解析并拒绝多余字段（含 agent 携带密码）、私钥方式必须有路径、秘密 ≤ 1 KiB 且不含 NUL |
| russh 集成（真实 TCP/SSH） | 密码正确/错误；加密私钥口令正确、缺失、错误（后两者在本地失败，服务端认证计数不变）；临时 `ssh-agent` 无密钥时报错、`ssh-add` 后认证成功；SSH target 13/13 |
| 浏览器（IPC stub） | 密码与口令不进入 probe 请求、probe 后清空输入框、只在 accept 时发送一次；agent 与私钥方式的请求形状；终端与文件面板交接只带凭据、不带路径；全套 118/118 |

独立安全审查无 CRITICAL/HIGH。已修复：加密私钥的 bcrypt 轮数超过 512 时在解密前拒绝（解密无法取消，避免恶意文件长期占用读取线程）。已接受并记录的风险：russh `authenticate_password` 接口与 serde/IPC 解析各会产生一份未清零的密码副本；Windows agent 命名管道可被同用户进程抢先创建，与 OpenSSH 客户端的信任模型相同；SFTP 授权在有效期内持有凭据。

边界：RSA 私钥需开启 russh `rsa` 特性（会引入新 crate），本轮未启用；不支持证书认证、Pageant；agent 认证只在 macOS 本机验证，Windows 命名管道路径只经交叉编译检查。密码与口令会经过 WebView，这是 ROADMAP 已说明的边界。

## 依赖与许可证清单

锁文件中的 527 个 Rust crate 与 80 个 npm 包无 GPL/AGPL 依赖、无缺失许可证；MPL-2.0 仅为 Tauri CSS 解析等 5 个 crate 与构建期 `lightningcss`，LGPL 只作为 `r-efi` 的可选项。运行时 npm 依赖仅 xterm.js 三个包与 `@tauri-apps/api`。发行前仍需生成随包的第三方许可证汇编。[清单与复核方法](DEPENDENCIES.zh-CN.md)

## 持久化主机信任

本轮实现 ROADMAP 安全验收中的 TOFU 主机信任：首次连接显示主机、端口、密钥类型与指纹，用户勾选「保存此主机密钥」并确认后才写入；之后指纹一致的主机直接继续；已保存密钥变化时阻止连接，并同时显示保存的与新出现的指纹，只有勾选「已通过可信渠道核实」后执行独立的「替换已保存的密钥」才能继续。

- 存储：应用数据目录下的 `known_hosts`，OpenSSH 行格式（端口 22 为 `host`，其余为 `[host]:port`），先写临时文件再原子替换，Unix 权限 0600；上限 1 MiB / 4,096 条。哈希主机与 `@marker` 行不产生、不作为信任，但原样保留。存储不可读、过大或不是普通文件时拒绝连接（失败即关闭），不会降级成“未保存”。
- 后端：`ssh_probe` 返回 `trust: new | known | changed` 与保存的指纹；`changed` 的 challenge 无法被 `ssh_accept/ssh_open/ssh_sftp_open` 消费；`ssh_trust_save` 只接受 `new`，`ssh_trust_replace` 只接受 `changed`。保存与替换都不改变“重新连接并固定校验确认字节”的既有路径。
- 证据：`known_hosts` 单元 3 项；russh 集成测试 `saved_trust_is_reused_and_a_changed_key_needs_explicit_replacement`（服务端换钥后在认证前被拒、认证次数不变、替换后同一 challenge 可继续、文件不累积）；OpenSSH 用例中系统 `ssh` 以 `StrictHostKeyChecking=yes` 接受应用保存的文件；浏览器 6 项信任状态契约（IPC stub）。

独立安全审查无 CRITICAL/HIGH；已修复其 TOCTOU（改为单次打开并基于句柄检查）与手工多主机行替换。边界：Windows 上文件继承 `%APPDATA%` 用户配置文件 ACL（本用户、SYSTEM、Administrators），未另行收紧 DACL；进程内互斥加原子替换，未做跨进程文件锁（应用按单实例运行）；只保存 Ed25519 主机密钥；没有导入用户 `~/.ssh/known_hosts`、证书主机密钥、`@revoked` 语义或管理界面（查看/删除已保存主机）。

## Rust `ssh_open` 与真实 OpenSSH 交互 shell

`node --test tests/fixtures/ssh-terminal/rust-client.test.mjs` 经 Rust `Ssh` 服务对系统 OpenSSH 10.3p1 的 PTY shell 包装完成指纹比对、一次性信任、`ssh_open`、输入、逐块 ACK、中文与 emoji、window-change（`stty size` 由强制的 `24 80` 变为 `40 120`）、输出中 Ctrl-C 与 exit 7。macOS arm64 本机连续 **4/4** 通过，0 残留。此前交互 SSH 只在有限命令 russh 服务端验证；本轮仍不涉及 WebView、vim/tmux、长期背压或 Linux/Windows 客户端。[夹具说明](OPENSSH_INTERACTIVE.zh-CN.md)

## 只读 SFTP 文件面板闭环

本轮把只读 SFTP 接入桌面文件面板。用户在独立入口核对一次真实指纹后，Rust 签发窗口内、仅内存的短时浏览授权（空闲 5 分钟、最长 30 分钟、最多 4 个）；之后每次列目录、读属性或预览仍重新连接、固定校验已确认的主机密钥并重新读取所选私钥。主机密钥变化、公钥被拒或 rekey 立即吊销授权，前端回到重新核对指纹；传输、文件级错误、超时和取消保留授权。目录读取改为 raw SFTP 逐页读取，达到 4,096 项或 1 MiB 文件名即停止并标记截断；预览最多 64 KiB 且长度须与 `stat` 一致。此前三个 SFTP 命令未登记到 `build.rs` 与 capability，WebView 调用会被 ACL 拒绝；本轮五个命令均已登记。

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| Rust 单元 | **40 passed / 2 ignored**；fmt、check、clippy `-D warnings`、桌面可执行文件链接通过；SSH 集成 10/10 | ignored 项需真实夹具，见下行 |
| 真实 OpenSSH 夹具 | `rust-client.test.mjs` **3/3 passed**，0 残留临时目录/进程；SFTP 用例覆盖 challenge 一次消费、登录目录、符号链接 `stat`、逐字节读取、1 MiB+ 文件拒绝、目录/缺失路径报错不吊销、子目录、4,097 项截断为 4,096、关闭后过期、主机密钥变化即吊销 | 经 Rust `Ssh` 服务直连系统 OpenSSH `sftp-server`，不经过 WebView；原始日志在被忽略的 `.artifacts/p0/sftp-grant-round/` |
| 浏览器全套 | **108/108**（新增 `sftp-panel.spec.ts` 10 项）；TypeScript/build 通过 | IPC stub，验证令牌归属、取消与晚到结果、授权失效、远端名称文本渲染和 1000px 布局；不代表原生 WKWebView |
| 独立审查 | Rust 与前端审查均无 CRITICAL/HIGH；MEDIUM（吊销分类、内存说明、容量预检）与 LOW 已修复并复测 | — |

三平台 CI [run 38130138348](https://github.com/mofyer/new-windterm/actions/runs/38130138348)（工作分支 `p0/sftp-panel`）**success**：Rust 单元 macOS 40、Linux 39、Windows 38 passed，均 2 ignored；SSH target 三端 10/10，macOS/Linux 默认与 readiness PTY 通过。

仍未完成：原生 WKWebView 中的面板实测、下载落盘与全部写操作（F02–F07）、非 UTF-8 文件名（当前整页报错）、持久连接与断线恢复。授权可读取远端账户可读的任意路径，与文件浏览语义一致，仅限主窗口调用。功能矩阵 F01 仍为“未实现”，局部原型不改变整行状态。

## 上一提交：只读 SFTP IPC 与 Windows shell 契约

提交 `3216339` 已推送公开仓库。新增 `ReadOnlySftp` Rust 抽象，并通过 Tauri 暴露 `ssh_sftp_list`、`ssh_sftp_metadata`、`ssh_sftp_read` 三个受限 IPC 命令；每次操作重新完成当前 challenge 绑定的 Ed25519 认证并在操作后断开，没有写入/删除/重命名接口。依赖 `russh-sftp 3.0.1`，`serde` pin 至 `1.0.229`。macOS 本机单元测试 30 passed/1 ignored、SSH 集成 10/10；前端文件面板、真实 OpenSSH SFTP、取消/断线、大目录内存预算和跨平台运行时仍待验收。

同步补充 Windows future shell contract：校验 `ComSpec` 后使用 `cmd.exe /D /Q /K`，保留 `SystemRoot`、`ComSpec`、`PATH`，但 `ensure_supported()` 仍拒绝创建 Windows PTY。三平台 CI [run 38126837364](https://github.com/mofyer/new-windterm/actions/runs/38126837364) **success**：macOS 30 passed/1 ignored、Linux 29 passed/1 ignored、Windows 28 passed/1 ignored；三端 SSH target 均 10/10，macOS/Linux 默认与 readiness PTY 通过，Windows PTY skipped。该回执证明条件编译、SFTP IPC 接线和现有 gate 健康，不证明 ConPTY reader 生命周期或真实 SFTP 网络互操作。

## 当前轮：交互 SSH 与 PTY readiness 实验

| 内容 | 当前结果 | 边界与证据 |
| --- | --- | --- |
| 交互 SSH 入口 | 确认实际指纹后请求 SSH PTY/shell，将原始输出接入 xterm；已接输入、尺寸、ACK、取消和关闭 | [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)；只支持本次信任与明确指定的未加密 Ed25519 测试密钥，不保存长期凭据 |
| 浏览器独立全套 | **98/98，27.95 秒，0 failed/skipped/flaky**；严格 TypeScript/build 通过；新增 14 项交互 SSH 契约 | [WEB_QA](WEB_QA.zh-CN.md)；IPC stub，未运行 Rust/网络；含历史兼容缺口与隔离 PoC，不能全部计作生产功能完成 |
| 浅深色独立复核 | 1000×650 的连接表单、指纹确认、SSH stub 终端共 6 态，无区域 overflow 或 pageerror | 本地回执 `.artifacts/p0/ssh-terminal-round/`；保持白银与中性炭灰方向，不是原生视觉/IME 验收 |
| PTY 配对实验 | 三组交替配对 **6/6** 精确 2 MiB；负载中位数 6898.175 → 342.195 ms，含 300 ms 人工 ACK 暂停；顺序、预算、Ctrl-C、exit 7 与回收通过 | [PTY_READINESS](PTY_READINESS.zh-CN.md)；CLI 直接调用 Rust PTY，默认 feature 关闭，不代表默认 GUI 性能改善或性能出口通过 |
| 本轮系统 OpenSSH 交互夹具 | **2/2 Node tests passed；自检连续 3 次通过；0 残留进程/临时目录**；随机 loopback sshd、临时 Ed25519/known_hosts、UTF-8、PTY 尺寸、有限输出 Ctrl-C、exit 7、错误 key/未知 host 和 `--serve` 清理均通过 | [OPENSSH_INTERACTIVE](OPENSSH_INTERACTIVE.zh-CN.md)；独立验证系统 OpenSSH，不接入 Tauri/Rust `ssh_open`，不代表完整远端 shell、SFTP 或 Windows 互操作已完成 |
| 本轮首个提交本机 Rust 独立复验 | **28 单元 passed、1 explicit ignored；9 真实 SSH 集成 passed，26.85 秒**；fmt/check all-targets/all-features/clippy `-D warnings` 通过；独立 Rust 审查 APPROVE，未发现 critical/high | 代码 `807e0eb` 已在夹具辅助模块最终路径下复验；集成测试包含主动 rekey 拒绝。后续仅测试扫描器修订已独立 APPROVE，target 10/10（9 真实协议 + 1 helper），20.34 秒，fmt/target check/clippy 通过。真实 TCP/SSH 对端为有限命令 russh 服务端，不是 OS shell/OpenSSH；ignored 不计入通过 |
| 当前共享 SSH 回归 | 代码 `807e0eb` 的 `ssh_probe --locked` 独立构建 7.04 秒；OpenSSH Node harness **2/2 passed、0 skipped，3.507 秒**，显式运行所需对端的 ignored 测试 | 本机固定命令入口：明确指纹、UTF-8、exit 7、错误客户端密钥与重连密钥不匹配路径；两次临时材料读取均为 ENOENT，额外确认无当前夹具目录/进程；不代表交互 OpenSSH 或应用 SFTP 验收 |
| 本轮原生 GUI | arm64 debug 构建成功；WKWebView 完成实际指纹、本次信任、中文/emoji 输出、尺寸变化、输出中 Ctrl-C、exit 7、关闭和夹具清理 | 主任务 CUA 实测，详见下节；默认 readiness 关闭。仅为有限 russh 命令状态机的真实网络/native 链路，不代表 OS shell/OpenSSH、IME 或性能验收 |
| 本轮三平台 CI | `9dbf8ac` 的 [run 38116705227](https://github.com/mofyer/new-windterm/actions/runs/38116705227) **success**：三端前端/fmt/check/test/clippy/link 通过；Mac/Linux 默认及 readiness PTY 通过，Windows 两种 PTY 均 skipped | 三端各 10 项 SSH target 为 9 协议 + 1 helper；Windows-only `ChildKiller` 预备钩子通过条件编译，ConPTY 仍未实现，test/link 的非阻塞 PDB 同名 warning 保留。[最终成功及前两次失败](CROSS_PLATFORM_VALIDATION.zh-CN.md)；Windows 保持拒绝策略的原因与门槛见[ConPTY 决策记录](WINDOWS_CONPTY_ADR.zh-CN.md)；不代表三端 GUI、OpenSSH 交互或性能验收 |

普通「新建连接」仍是演示；只读 SFTP 与持久化主机信任见本页顶部。交互 SSH 不支持完整认证、代理/跳板、转发或 SFTP。当前接收队列有界，慢消费超过 bridge 容量时明确报错断开；尚不是前端 ACK 驱动的完整 SSH 窗口流控。russh 0.64.1 的重协商主机检查限制以显式拒绝 rekey 处理，用户需重连重新确认；不宣称透明重协商已实现。

## 当前轮三平台结果（`8ee49a4`）

| 平台 | Rust 单元 passed / failed / ignored | SSH target（9 协议 + 1 helper） | 默认 / readiness 真实 PTY |
| --- | --- | --- | --- |
| macOS arm64 | 28 / 0 / 1 | 10/10，20.88 秒 | 均通过 |
| Linux x64 | 27 / 0 / 1 | 10/10，22.96 秒 | 均通过 |
| Windows x64 | 25 / 0 / 1 | 10/10，25.44 秒 | 均跳过，ConPTY 未实现 |

四个 Unix 探针各自通过精确 2 MiB、含 300 ms ACK 暂停、Ctrl-C、退出与 12 次关闭回收；这是功能检查，不是配对性能比较。默认策略不变。系统 OpenSSH 夹具 ignored 项未在三端 CI 激活，本机固定命令回归另列。完整耗时、峰值、原始日志和前两次 CI 失败保留于[跨平台回执](CROSS_PLATFORM_VALIDATION.zh-CN.md)。

## 当前轮原生交互 SSH 冒烟

主任务使用新构建的 macOS WKWebView `.app` 经 CUA 操作。最终 debug 构建用时 8.80 秒，产物 71.12 MiB，`file` 确认为 Mach-O 64-bit arm64；默认未启用 `pty-readiness`。构建中曾发现 `src/bin/support` 被 bundler 误认为独立 binary，辅助夹具已移动至 `tests/support`，最终路径的构建和 Rust 检查均通过。

- 对照独立服务端指纹后明确确认；夹具记录只有 1 次成功认证。
- `unicode` 返回完整中文与 🌏；初始尺寸 129×23，打开文件面板后为 98×23，服务端 `size` 返回 `SIZE 98 23`，证明尺寸消息穿过原生链路。
- `large` 已接收 229,518 B 后，下一次 CUA 操作发送 Ctrl-C 和 `unicode`；最终可见 `INTERRUPTED` 与中文/emoji，累计 1,855,662 B 小于 2 MiB，未出现 `LARGE_DONE`。这证明有限输出被中断并可继续输入；跨 CUA 调用没有量化 GUI 延迟，不能作为响应预算通过依据。
- `exit` 返回退出码 7；关闭 SSH 标签后只剩原有 1 个演示标签。停止夹具时 `active=0/auth=1`，检查确认临时目录已删除。

该服务端不启动操作系统 shell。以上不证明 OpenSSH、vim/tmux、系统中文输入法或持续高输出性能通过，也不替代独立 Rust 审查与跨平台 CI。

## 当前轮原生 PTY 数据路径冒烟

本轮另外构建了两个 macOS arm64 debug `.app`：默认 feature 关闭的生产路径，以及显式启用 `pty-readiness` 的实验路径。通过 CUA 在真实 WKWebView 窗口打开本地 PTY，分别运行仓库内固定的 `pty-readiness` 生成器，并以独立标记确认命令结束：

- 默认路径显示 `NW_BEGIN`、有限 2 MiB 生成器输出和 `NW_DONE`，退出码 0；应用状态显示退出、`129 × 23`，随后关闭标签回到原有 1 个会话。
- readiness 路径显示 `RD_BEGIN`、同一有限 2 MiB 生成器输出和 `RD_DONE`，退出码 0；应用状态显示退出、`129 × 23`，随后关闭标签回到原有 1 个会话。

状态栏字节数包含 shell 命令和标记（分别为 2,098,534 B 与 2,098,531 B），不能从中反推出生成器精确 payload；本次也没有测量 GUI 吞吐、输入法或键盘事件延迟。因此这只是原生默认/可选 readiness 数据路径和回收冒烟，不是性能或 IME 通过结论。readiness 构建命令为：

```sh
env PATH="$HOME/.cargo/bin:$PATH" npm run tauri build -- --debug --bundles app --features custom-protocol,pty-readiness
```

## 前一轮历史：固定命令 SSH 与 PTY 分支计量

- 浏览器 **84/84，24.6 秒**；Rust all-targets/all-features **24 passed、0 failed、1 explicit ignored**，真实 OpenSSH Node harness **2/2**。当轮 fmt/check/clippy 与独立审查通过。依赖对端的 ignored 项由 harness 显式激活，不能算作常规单测通过。
- 原生 arm64 debug 构建 12.72 秒、58.47 MiB；WKWebView 指纹与独立 known_hosts 一致，固定 `fixture-check` 返回 `P0_SSH_OK 中文 🌏` 加换行共 22 字节、stderr 0、exit 7；正常关闭与夹具清理完成。只证明当轮固定命令成功路径。
- 提交 `84c24df` 的 [run 38110885626](https://github.com/mofyer/new-windterm/actions/runs/38110885626) 三端 success：Mac 24、Linux/Windows 各 23 passed，均 0 failed、1 ignored；Mac/Linux 真实 PTY 通过，Windows PTY skipped。未运行真实 SSH 夹具或 GUI；Windows 有非阻塞 PDB 同名 warning。[平台回执](CROSS_PLATFORM_VALIDATION.zh-CN.md)
- 九次 2 MiB 分支诊断为 5.960–7.233 秒，主要等待为 WouldBlock sleep；当轮没有修改默认 I/O 或 ACK。[诊断报告](PTY_PERFORMANCE_DIAGNOSIS.zh-CN.md)

## 第二轮历史交付与证据

| 内容 | 当前结果 | 边界与证据 |
| --- | --- | --- |
| 高输出状态更新 | 专项 Chrome 512 块输出中状态控件 DOM 写入从 2,560 次降至 4 次；最终全套观察 3 次；512 块 ACK 顺序与有界窗口保留 | [RESPONSIVENESS](RESPONSIVENESS.zh-CN.md)、[WEB_QA](WEB_QA.zh-CN.md)；IPC stub，无 Rust/PTY/WKWebView，不宣称原生性能解决 |
| 开发诊断 | 仅开发模式按参数启用，固定 13 个聚合数字；无输入/输出/路径/会话 ID 或采样数组 | 同上；无查询参数不安装，生产产物删除诊断表面 |
| 开发服务隔离 | Vite 忽略 `src-tauri` 变更，专项验证不再发送相应 full-reload 消息 | 同上；旧日志消息不等于页面实际导航，不以假设替代观察 |
| VT52 隔离实验 | 6 项有限实验通过，验证跨块基本输出转换、有界状态和未实现诊断 | [TERMINAL_COMPAT](TERMINAL_COMPAT.zh-CN.md)；没有接生产 UI/PTY，非完整 VT52 或 WindTerm 对齐 |
| DECSCL 缺口判据 | 改为 DECRQSS 查询 conformance 的前后响应，并核对 xterm 源码 | 同上；移除以 primary DA class 判断切换成功的旧断言 |
| 跨平台 CI | 修订后三个任务均成功；Mac 12 项、Linux/Windows 各 11 项单测；Mac/Linux 真实 PTY 通过，Windows 真实 PTY 跳过 | [CROSS_PLATFORM_VALIDATION](CROSS_PLATFORM_VALIDATION.zh-CN.md)保留原失败与成功回执；ConPTY 未实现，CI 成功不等于三端产品可用或性能达标 |
| 当轮本机 Rust | 当轮 Mac 单测为 12 项，含 Linux 命令/环境及缺失 shell 策略；检查和探针按专项报告记录 | 各目标条件测试数可不同，不把未运行的 Windows/Linux 测试计入 |
| 界面与全套浏览器验收 | 70/70，18.5 秒，0 failed/skipped/flaky；67 正向/契约含 6 项隔离 VT52 PoC，另 2 项原始 VT 缺口及 1 项旧 Unicode 反例；build 通过 | [WEB_QA](WEB_QA.zh-CN.md)、[设计系统](DESIGN_SYSTEM.zh-CN.md)；浅深色方向均获认可，反例与 PoC 不算生产兼容通过 |
| 当轮原生冒烟 | 当轮 arm64 debug 构建约 11.89 秒、31.76 MiB；中性灰深色下真实 PTY 粘贴中文/emoji 回显和输出完整，23 行/129 列、exit 7 | WKWebView 实测；只证明粘贴路径，不证明键盘中文/IME或高输出响应 |
| SSH/SFTP 受控夹具 | macOS `/bin/zsh` 下 6 项真实协议检查与 2 项生命周期测试经独立复验通过；1,048,596 字节源/服务器/下载 SHA-256 一致，正常及监听器异常退出均完成清理 | [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md)；loopback 与临时密钥，无 chroot、保留同 UID 文件权限；这组历史证据来自系统 OpenSSH；此后用于固定命令 Rust/桌面接入，当前交互通道另见上表，应用 SFTP 仍未实现 |
| 原生 PTY 等待诊断 | 一次本机有界 2 MiB 输出为 7.45 秒；消费阶段 99.4% 时间等待事件，ACK 调用累计 0.932 ms；报告通过独立核对 | [PTY_PERFORMANCE_DIAGNOSIS](PTY_PERFORMANCE_DIAGNOSIS.zh-CN.md)；候选为短读与两处 5 ms 轮询，尚未认定根因，未改生产策略，不是性能基准 |

状态 DOM 合并不改变终端内容、ACK 或输入时序，不关闭 screenReaderMode。诊断只是观测，Chrome 单次耗时与 keydown→stub 延迟不能用于宣布 WKWebView 的 Ctrl-C 延迟已解决。详见[响应专项](RESPONSIVENESS.zh-CN.md)。

## 终端兼容边界

原始 xterm 的 VT52 地址序列缺口继续保留。隔离 PoC 只处理干净 ANSI 初态下的一组基本 VT52 输出；污染 origin/滚动区域、图形字符集、输入键映射、身份响应等仍未完成。未来接入时 ACK 必须按原输入块与字节计数，不能按转换长度或等待后续块补齐控制序列；当前生产终端不经过该适配器。

DECSCL 的旧 primary DA 判据已撤回。新探针先查询 `DCS $ q " p ST`，发送 `CSI 62 ; 1 " p` 后再查询，实际前后均为 `DCS 1 $ r 61 ; 1 " p ST`；结合 xterm 6.0.0 源码硬编码与未支持说明确认缺口。DA 仅作身份观察。实验通过和缺口复现均不等于完整兼容性验收。

## 历史跨平台执行状态（`a82770d`）

- macOS arm64：当轮 Rust/PTY 检查及 Carbon 原生粘贴、尺寸和退出冒烟已有记录，高输出与 IME 未验收。
- Linux：Bash/Unix PTY 已在 Ubuntu 24.04 hosted 完成编译、链接、单测与真实 PTY 探针；GUI、其他发行版和完整功能仍未验收。
- Windows：hosted 编译/链接及拒绝策略已有通过记录；ConPTY 的可取消 I/O、句柄与进程树尚未实现，真实 PTY 明确跳过。

`.github/workflows/p0-cross-platform.yml` 使用 macos-15、ubuntu-24.04、windows-2022。首轮 Mac hosted 负载探针触及旧 10 秒总期限失败；修订探针总期限后，三平台编译/检查/链接及各自测试范围均成功，Windows 真实 PTY 仍明确跳过。原失败、取消运行和成功 commit/run 统一记录在[执行回执](CROSS_PLATFORM_VALIDATION.zh-CN.md)。Mac/Linux 的 2 MiB 探针耗时分别为 35.51 秒和 0.55 秒，来自不同 runner 并含人工 ACK 暂停，仅作功能诊断，不能用作公平吞吐对比或性能通过结论。[跨平台计划](../CROSS_PLATFORM.zh-CN.md)

## 上一轮保留证据

以下仅作为历史，不冒充本轮新代码、深色主题或原生性能验收：

- 56 项浏览器通过：53 正向/契约（含 2 项对比度）、2 项终端缺口、1 项旧 Unicode6 反例；原 DECSCL 断言在第二轮纠正。该轮 Rust 为 10 项，第二轮 Mac 增至 12 项；本轮计数另行记录。
- 真实 PTY 探针完成 2 MiB 字节完整性、背压、Ctrl-C、resize、exit 7 与 12 轮关闭；普通前台进程未见该探针残留，不覆盖守护化/脱离会话进程。[PTY_PROBE](PTY_PROBE.zh-CN.md)
- 旧 Mint 原生窗口持续 `yes` 累计约 41.9 MB 后，多次 Ctrl-C 才观察停止，随后恢复 `printf` 与 exit 7 成功；AX/GUI 输入与队列延迟尚未量化。
- 同生产 Session 独立后端诊断在 8,390,577 字节后注入 `0x03`，暂停 ACK 300ms，316.16ms 后收到恢复 `printf`（包含暂停），pending 峰值 5,937 字节，正常回收；不代表 GUI 性能，也不足以将此前延迟归因为 Rust 死锁。
- 上一轮白银原生 `.app` 在 WKWebView 中完成 `P0_SILVER_OK 中文 🌏` 回显/输出、`stty size`=`23 129` 与 exit 7。仅为当时版本冒烟，不是 IME、Unicode13/ZWJ 或本轮全量验收。

## Carbon 视觉与原生冒烟（历史版本）

浅色方向保持：[工作台](../assets/p0-light-workspace.png)、[连接表单](../assets/p0-light-connection.png)。中性炭灰深色已更新并获用户方向认可：[工作台](../assets/p0-dark-workspace.png)、[连接表单](../assets/p0-dark-connection.png)。浏览器正文/控件所测最低对比度为浅色 4.674:1、深色 6.321:1，1000×650 分屏与文件面板无几何越界或 pageerror；这不是完整可访问性认证。

当轮构建在 `tauri://localhost` WKWebView 的真实本地终端粘贴 `printf 'P0_CARBON_PASTE 中文 🌏\n'; stty size; exit 7`，AX 可见命令与输出均含完整中文/emoji，尺寸 23 行、129 列，退出码 7。首次 CUA `typeText` 通道未送出 Unicode，改为 paste 后才成功；因此仅记录**粘贴回显成功**，不称为中文键盘或 IME 通过。该轮没有重测原生高输出，不解决旧 Ctrl-C 延迟。

## 复核入口

macOS 开发环境需 Node.js/npm、仓库 Rust 工具链及 Xcode Command Line Tools：

```sh
cd apps/desktop
npm ci
npm run tauri dev
```

桌面模式自动启动开发服务器。纯浏览器演示改用 `npm run dev`；两者不要同时占用 1420。前端检查为 `npm run build`，浏览器全套为 `npx playwright test --config playwright.config.ts`（需服务已运行和系统 Chrome）。

仓库根目录执行 Rust 检查和真实 PTY 探针：

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin pty_probe
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features pty-readiness --bin pty_probe
```

本机 debug 产物位于 `apps/desktop/src-tauri/target/debug/bundle/macos/New WindTerm P0.app`，不随 Git 分发，无签名公证。浏览器临时回执位于被忽略的 `apps/desktop/test-results/`，后续运行会覆盖。

## 未完成与下一步

1. 在当前三平台 CI、Rust 独立复验与 macOS 原生冒烟基础上继续平台专项；Windows ConPTY 先按[决策记录](WINDOWS_CONPTY_ADR.zh-CN.md)完成可取消 reader/child 生命周期，再解除拒绝策略。保留两次失败与修订成功记录，沿已认可的浅深色方向完善。
2. 完成原生 IME、Ctrl-C 分层延迟、资源与可访问性专项，不能以 Chrome 状态优化代替。
3. 继续 VT52 接入策略、其他 VT 方言、Free Type、折叠与压缩历史验证；当前台账为130项：原117项保留，新增13项（11项入口已观察、2项静态候选），新增项行为均未实测；完整基线尚未冻结、功能对齐未完成，不降低完整功能目标。
4. 在交互 SSH 通道基础上继续 OpenSSH/真实系统 shell 互操作、rekey、安全主机信任持久化、完整认证、长期背压与 Rust SFTP；再扩展 agent、跳板/转发及 tmux，不能将有限命令协议测试等同远程连接产品。
5. 完成功能基线、平台运行与风险预算后才重估工期、判断 P0 出口；当前没有正式发行版，P0 未完成。
