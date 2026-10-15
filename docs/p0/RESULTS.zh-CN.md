# P0 结果与下一步

初建于 2026-10-11，最新续做记录见下方 2026-10-15 一节。**P0 仍在进行中**：功能基线已冻结并按用户批准扩展为 164 项，关键实机风险与阶段出口尚未收口。浅色白银浮层、深色中性炭灰方向已获认可；原型与有限测试不代表完整功能或发行验收。


本轮（2026-10-11 至 10-13）的汇总归档见 [P0 工作归档](P0_ARCHIVE_2026-10.zh-CN.md)。
## 2026-10-15：上游与 macOS 原生有限实测

本轮只新增证据与出口草案，产品实现仍为 `fb824cf`；本机从 `63a1b3e` 打包的 arm64 debug 应用构建成功。详见[上游报告](UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)、[原生报告](NATIVE_ACCEPTANCE_2026-10-15.zh-CN.md)和[出口草案](P0_EXIT_REVIEW.zh-CN.md)。

- 上游：本地 shell 主终端 Ctrl+Return 切换模式；回滚设置 0 / 1000000 / 99999999 可保存后读回；两标签、上下分屏与隐藏文件面板重启后恢复。SCP 入口仅部分检查，多窗口/活进程恢复、实际历史容量与内核行为未确认。上游已退出，共享偏好已恢复并逐字节比较一致。
- 原生输入：用户确认系统拼音候选窗正常并选中“你好”，真实 shell 出现中文；临时输入法已移除。1 MiB UTF-8 粘贴经真实 PTY 接收并逐字节匹配；含 ESC 的粘贴过滤一个控制字符、接收结果匹配。这些不等于完整 IME、宽字符或 VoiceOver 通过。
- 有限输出：一次完成、一次单 Ctrl-C 观察到中断；418 ms 是工具动作加 AX 观察耗时，不是实际按键延迟。40 个主进程 RSS 样本峰值 118944 KiB，不包含 WebKit，不构成全应用性能验收。
- 显示差异：自动化观察中输出字节/AX 前进而截图停旧内容；用户手动将 Local 3 置前台后确认两条 marker 正常显示，随后 AX 和截图也均可见。支持前后台状态差异待查，不能认定前台故障或宣布修复。旗帜 emoji 字形与 shell 编辑回显仍有异常观察，待独立复现。
- 阶段边界：用户暂无串口设备，真实硬件保持阻塞；VoiceOver、完整 IME、前台固定负载/内存、上游关键行为、ADR 定稿及 164 项工期重估仍待完成。未提升三处台账状态，未批准 P0 出口。

本轮证据文档已由独立 verifier 审查通过：8 份文档、126 处本地链接、三段台账结构检查通过，台账无改动；两份粘贴载荷摘要、40 个 RSS 样本、被测二进制摘要及共享偏好恢复均复核一致。修正了输出命令版本与历史限制标题两处表述。此审查只批准证据文档发布，不是 GUI 重测或 P0 出口批准；本轮未因纯文档修改重复运行本机代码门禁。

随后新增[164 项重估准备方案](EFFORT_REESTIMATE_PLAN_2026-10-15.zh-CN.md)：164 = 原 130 + 冻结候选 31 + 后增 3；旧估算不能再叠加原 36 项候选风险，也不能按 ID 比例放大。已指出直接采用 zmodem2 的旧乐观假设失效，旧数字保留为历史；新的逐包估值尚未完成。针对用户关于 P0 拖长的反馈，另有[三个决策包收尾提议](P0_CLOSEOUT_PROPOSAL_2026-10-15.zh-CN.md)，验收后移和出口决定仍待用户确认。

手动复跑 [CI 38697787649](https://github.com/mofyer/new-windterm/actions/runs/38697787649)，head `a9049a4`，结果 **success，7/7 作业成功**。实现与此前 `fb824cf` 相同，本轮只是文档后的重复验证，不是新增功能。随后 `71f1f8c`、`4c323b6` 只补重估准备和待批准收尾提议；这些文档不重复触发全套构建，main 保持 `63a1b3e`。

独立复核本次日志：macOS Rust 209 passed / 33 ignored，Linux 208 / 33，Windows Server 2022/2025 各 203 / 7；两 Unix 虚拟串口各 4/4；Linux lrzsz 非阻塞步骤实际 11/11，X11/agent 对 OpenSSH 各 1/1、0 skip；GSSAPI 单测 3/3、四场景 4/4、三次 fresh-cache 复验；Linux/Windows 原生冒烟各三场景通过。Windows 独立 ConPTY 各 2/2，但 Server 2022 的已知系统泄漏仍在：bare 24 轮增长 24 handles，Session 191→215，检查是相对 bare 基线加容差，不是零泄漏验收；Server 2025 bare 增长为 0。ignored 均不计通过。

## 2026-10-15：中断任务收尾与集成 CI 通过

- **WL-1/2/3**：`831b354` 将用户已批准的三个 Windows shell 能力补为 T35–T37，基线共 164 项；三段结构验证通过。新增项仍为未实现、行为未验证，冻结字段未变。
- **C04 虚拟串口**：`c6cc289` 新增仅开发依赖 `serialport =4.10.1`（关闭默认特性），通过真实 SerialPort API 对私有 PTY 做 4 项测试。macOS arm64 4/4；读写、配置读取、超时恢复、对端关闭。独立 Rust 评审发现 macOS `ptsname` 共享缓冲的并发风险，已用静态 Mutex 保护 PTY 分配与路径获取，复审通过。属于 loopback 夹具证据，不是 UART、设备枚举、热插拔或产品串口会话验收。首轮 CI 的 macOS/Linux 均为 4/4，Windows 不运行该 Unix 测试。
- **C14 GSSAPI**：`7daa310` 的独立 Rust crate 实现 Kerberos GSS 桥接、固定主机指纹和认证后远端证明；容器覆盖有效、缺失、过期、错误服务主体。评审指出缓存服务票据会掩盖 KDC 故障，现每个负例后用新 cache 重新 kinit 再正向认证，复审通过。3 项单测通过；修复版 Linux 四场景及三次健康复验通过，C14 更新为真实对端探针证据，功能状态不变。容器预检另发现 Debian `kadmin.local` 需要 `krb5-admin-server`，已补安装与工具存在性检查。
- **证据台账**：C04 与 C14 从仅静态更新为原型/探针，计数为 69 / 94 / 1；层级为真实对端 24、真实平台 7、loopback 夹具 9、浏览器 29。三段结构校验再次通过，功能实现状态不变。
- **CI 门禁**：新增 GSSAPI 隔离容器作业，并补齐原工作流中 X11、agent、非阻塞 lrzsz 的结果摘要。独立工作流审查指出探针路径过滤遗漏，已修复；`wincheck.sh` 在 Cargo 参数区固定 `--locked`，复审通过。

本机已完成的门禁：

| 门禁 | 2026-10-15 结果 |
| --- | --- |
| Rust fmt / Clippy 全 targets、全 features | 通过 |
| Rust `cargo test --locked --all-features` | 209 passed / 0 failed / 33 ignored；ignored 不算通过 |
| Windows 目标 wincheck | 通过；仅类型检查，不是 Windows 运行 |
| OpenSSH/SFTP 四个 Node 测试入口 | 11 passed / 0 failed / 0 skipped |
| 前端 build / Playwright 全套 | 通过 / 370 passed |
| 台账三段结构验证 | 通过 |

浏览器测试使用 IPC stub，不代表原生窗口；真实 OpenSSH 证据只覆盖夹具运行的路径。

首轮 CI：[run 38690044571](https://github.com/mofyer/new-windterm/actions/runs/38690044571)，head `31bcdf8`。GSSAPI 镜像构建、Rust 编译与单测通过，但 `valid` 场景返回 10，GSS 错误 `major=0xd0000 minor=0x96c73a07`（服务主体不存在）；其余三场景未执行。MIT 短主机名可能被补上容器 resolver 搜索域；修复 `0212e9e` 固定 `qualify_shortname = ""` 并以独立 cache 的 `kvno` 预检精确主体，不预热 Rust 客户端 cache。该候选根因与修复已做独立代码审查，下一轮四场景通过，支持该修复；首轮失败记录保留，不把首轮未执行场景计为通过。

该轮已核对的独立结果：macOS/Linux desktop 作业成功，串口各 4/4；Linux lrzsz `0.12.21-11build1` 实际 11 passed / 0 failed / 0 ignored（非阻塞步骤的真实 outcome 为 success），X11/agent 对 OpenSSH 各 1 passed / 0 skipped。Linux WebKitGTK、Windows WebView2 三个原生冒烟场景各自通过。Windows Server 2022/2025 desktop 均成功，Rust 各 203 passed / 7 ignored，独立 ConPTY 检查各 2 passed；macOS Rust 209 passed / 33 ignored，Linux Rust 208 passed / 33 ignored。整次 run 仍为 failure，仅 GSSAPI 作业失败。

修复版 [run 38691371347](https://github.com/mofyer/new-windterm/actions/runs/38691371347)，head `fb824cf`，在旧 run 全部结束后触发。GSSAPI job `116277797906` 已成功：服务主体预检通过，四场景 `4 passed; 0 skipped`，三次 fresh-cache 健康复验通过，最终远端执行次数 4；MIT Kerberos `1.20.1-2+deb12u5`、OpenSSH `1:9.2p1-2+deb12u10`。整次 workflow **success，7/7 作业成功**：GSSAPI、macOS desktop、Linux desktop、Windows Server 2022/2025 desktop、Linux WebKitGTK 和 Windows WebView2。原始日志确认 Linux 串口 4/4、lrzsz 11/11（实际 outcome success）、X11/agent 各 1/1；不以整体绿色代替非阻塞步骤核查。

测试代码提交为 `fb824cf`；此后本批只补证据文档与台账，没有改变被测实现。三处台账及冻结提议结构验证通过。

**合并记录（2026-10-15）**：用户在获知 CI 7/7 通过后明确回复「合并」。独立复核远端分支为 0/26、无分叉，`fb824cf..f964239` 仅有文档与台账变更；随后以 `--ff-only` 将 `main` 从 `e0dd423` 快进到 `f964239`，并成功推送 `origin/main`。本记录为后续文档补充，没有改变被测代码，也没有重复执行 CI。P0 仍在进行中，本次合并不代表阶段出口或产品验收通过。

## 输入路径：输入法、宽字符、粘贴与按键

用浏览器层探针（Playwright 加 CDP 模拟输入法）检查了输入路径，见[说明](INPUT_PATHS.zh-CN.md)。共找到并修复 7 个真实缺陷，每个都附了回归测试；拿掉修复后，对应测试都会失败。

1. **xterm.js 6.0.0 的 UTF-8 解码缺陷（上游 #6003）**
   - 现象：一次写入恰好结束在某个续字节之后时，会整字丢失。我们的 4096 字节输出分块会触发它，`、。「」— “ ” …`、ZWJ 等字符会在块边界消失，宽字符丢失后整行错位两列。
   - 修复：前端扣住每块末尾不完整的 1–3 个字节，拼到下一块前面再交给 xterm.js；会话结束时写出剩余字节，xterm 会显示替换字符。前端不做 UTF-8 解码。
2. **大段粘贴无法送达**
   - 现象：前端原来直接拒绝超过 64 KiB 的粘贴，并把后端“队列已满”当作致命错误。
   - 修复：前端改为有序输入队列（积压上限 16 MiB，同时只有一个写入在途），只在后端返回“队列已满”时重发同一块，最多重试 15 秒。Rust 侧区分“已满”与“已关闭”两种错误。
3. **粘贴注入**
   - 现象：xterm.js 会原样转发粘贴内容里的 ESC，粘贴的 `ESC[201~` 可以提前结束 bracketed paste，把其余内容当作按键执行。
   - 修复：粘贴和拖放的文本都会去掉 C0（制表符、LF、CR 除外）、DEL 和 C1，并提示去掉了多少个字符。
4. **无按键输入的文本被忽略**：屏幕阅读器模式下，表情选择器、听写这类没有按键的输入原来不会送出，现在会转发。
5. **F 键和 Shift+Tab 触发浏览器默认动作**：屏幕阅读器模式下，F5 会刷新页面并关闭所有会话，F3 会抢走焦点，Shift+Tab 会把焦点移出终端。现已拦截这些默认动作。
6. **Ctrl+/**：原来不发送任何内容，现在发送 0x1F。
7. **演示行编辑器的退格**：现在按完整的可见字符删除，宽字符折行时也能正确重绘。

保持不变的决定：macOS 上 Option 默认不作为 Meta 键，文档建议做成设置项。

合并时，VT 适配器已经改变了 `terminal.ts` 的返回值，输入测试工具查找插入点的写法随之失效，已改为同时匹配两种形式。

| 检查 | 结果 |
| --- | --- |
| 新增输入 spec | 96 项 |
| 浏览器全套 | 364/364 |
| Rust 单元 | 137 passed |

两项评审都已通过；其中前端评审提出的两个 MEDIUM（拖放绕过过滤、会话结束时尾部字节丢失）都已修复。

边界：
- CDP 模拟的输入法不等于原生 macOS 输入法、候选窗、听写或 VoiceOver。
- 没有在 WKWebView、WebView2 或 WebKitGTK 中测试。
- 1 MiB 粘贴只走过模拟的有界后端。
- Tauri 原生拖放没有测试。
- 宽字符宽度按 xterm.js 加 Unicode 11 计算，可能与 shell 的 `wcwidth` 不一致。

## 真实 telnetd 互操作（C02）

与 Homebrew 安装的 Apple network_cmds telnetd 308 做了 6 项互操作测试，以普通用户 uid 502 运行，不用 sudo，见[说明](NET_TERMINAL.zh-CN.md)。

运行方式：
- 测试把一个回环 TCP 连接按 inetd 的方式交给 telnetd。
- 用 `-p` 指定启动脚本，不执行需要 root 的 login(1)。
- 同一方式下还能得到真实 shell，用来核对窗口尺寸和 UTF-8 回显。

已验证：
- **协商**：选项协商不循环，`login:` 提示完整到达。
- **TTYPE**：telnetd 的调试输出显示接受了我们的 TTYPE 回复。
- **NAWS**：
  - 在 telnetd 发出 `DO NAWS` 之前不发送。
  - 首次报告带上了之前调整过的尺寸。
  - shell 中 `stty size` 先报 `30 100`，调整后报 `43 132`。
- **ECHO / SGA**：两项都被接受；输入用户名后出现 `Password:`，输入的密码没有回显。
- **转义**：IAC 加倍、CR NUL、CR LF 双向都正确。
- **数据完整性**：约 234 KiB 的全字节值数据在 64 KiB ACK 预算下完整到达，Ctrl-C 能中断 `sleep`。
- **关闭**：双向关闭都正常。

找到并修复 1 个编解码器缺陷：服务器进入二进制模式后，收到的 CR NUL 中的 NUL 原来被丢弃，会破坏二进制数据。

| 检查 | 结果 |
| --- | --- |
| telnetd 互操作 | 6/6，合并后复跑也通过 |
| 未安装 telnetd 时 | 6 项均自动跳过 |
| Rust 单元 | 138 passed |

Rust 评审的 3 个 MEDIUM 已修复。

没有验证：
- login(1) 的真实认证。
- LINEMODE、AUTHENTICATION 与 ENCRYPT。
- 其它 telnetd 实现和网络设备。
- Linux、Windows。

CI runner 上没有 telnetd，所以这些测试不在 CI 中运行。

## CI：端口转发测试在 Linux 与 Windows 上的失败

[run 38200206689](https://github.com/mofyer/new-windterm/actions/runs/38200206689) 中，`a_local_client_that_stops_reading_does_not_stall_the_shared_connection` 在 Linux 与 Windows 上失败，macOS 上通过。

原因是测试的等待时间设短了：
- 这项测试先确认共享连接上的另一个转发能完成往返，然后最多等 3 秒，检查不读数据的那个连接是否已被断开。
- Linux 和 Windows 的内核 socket 缓冲区更大，另一个转发在停顿的连接还没填满时就完成了往返，此时 5 秒的停顿上限仍在计时，3 秒等不到。

修复：把这一步的等待放宽到 15 秒。本机连跑 3 次，8/8 全部通过。

另外，Windows 作业的日志里有一条 cargo 的 bin 与 lib 输出文件名冲突警告。它只是警告，不是失败原因，尚未处理。

## SSH 端口转发界面（C08/C16/C17）

在已打开的 SSH 终端上，可以从「端口转发」面板增删转发，见[说明](SSH_FORWARDING.zh-CN.md)：
- **支持的类型**：本地、动态（SOCKS5）、远端。
- **新增命令**：`ssh_forward_add/remove/list`，三处都已登记。
- **约束**：
  - 每次调用都核对窗口归属。
  - 本地和动态监听只允许回环地址。
  - 每个会话最多 16 个转发。
- **随终端关闭**：关闭标签、刷新页面、关闭窗口、shell 退出或应用退出时，转发都会一起关闭；已建立的远端转发连接也会随终端结束。

合并时，路线分支和转发分支都改了 `ssh_open` 的连接方式。现在 `ssh_open` 先经所选路线取得连接，再用自己的 `Routes` 认证，这样才能登记远端转发。这部分合并结果做了独立评审，结论是可以安全提交。

评审还指出，转发测试并行运行时，可能耗尽进程内的私钥读取上限，导致偶发失败。已在测试里让打开操作依次进行；修复后连跑 6 次，8/8 全部通过。

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 135 passed |
| `ssh_forwarding` 集成 | 8/8 |
| 真实 OpenSSH 夹具 | 6/6 与 1/1 |
| 浏览器全套 | 268/268 |

两项评审中的 MEDIUM 都已修复。

边界：
- 转发只对测试内的 SSH 服务端验证过，没有与 OpenSSH 的转发策略互操作。
- 没有测试经代理或跳板路线的转发。
- 一个不读数据的本地客户端，可能让共享连接停顿约 5 秒。
- 转发设置不保存。

## VT 回复适配（生产代码）

`terminal-compat/vt-adapters.ts` 已挂到每个终端上，见 [VT 矩阵](VT_MATRIX.zh-CN.md)：
- **设备身份**：DA1、DA2、DA3、XTVERSION 按终端类型回复。默认类型 `xterm-256color` 下，DA1、DA2、DA3 与原来逐字节相同。XTVERSION 现在回复 `new-windterm(0.0.1)`，原来不回复。
- **DECSCL**：只改变上报的一致性级别。
- **DECRQSS**：报告真实的 SGR 和 DECSCUSR。
- **CPR**：在 DECOM 下按上边距换算。
- **OSC 52**：
  - 读取一律拒绝。
  - 写入默认关闭，需要在命令面板中按会话开启，并显示通知。
  - 上限 1 MiB，内容不写入日志。

VT 矩阵的统计：

| | 支持 | 部分支持 | 不支持 |
| --- | ---: | ---: | ---: |
| 加适配后 | 39 | 15 | 9 |
| 原始 xterm.js | 35 | 16 | 12 |

测试结果：
- 适配器、契约和矩阵三个 spec 共 80 项通过。
- 契约测试证明回复只到达本会话的 `pty_write`、`ssh_write` 或 `net_write`。
- 浏览器全套 256/256。
- 代码评审的 MEDIUM 已修复。

边界：
- 没有运行 vttest，没有在原生 WebView 中测试剪贴板权限，也没有在真实主机上测试。
- 选择终端类型只改变回复内容，`TERM` 仍是 `xterm-256color`。

## SSH 连接路线（C07/C16/C19/C20）

连接对话框现在可以选择连接路线，见[说明](SSH_ROUTES.zh-CN.md)。可选的路线：
- 直连；
- HTTP CONNECT 代理，可选 Basic 认证；
- SOCKS5 代理，可选用户名和密码；
- ProxyCommand：只按 argv 执行，不经过 shell。确认前展示完整 argv，用户确认之前不执行，探测阶段同样如此。
- 单跳跳板主机：两步信任，跳板主机和目标主机的指纹分别在 `known_hosts` 中核对，任一方的密钥变化都会阻断连接。

路线绑定进 challenge 和 SFTP 授权，之后的操作不能悄悄换成别的路线。新增命令 `ssh_probe_through` 和 `ssh_proxy_command_preview`，三处都已登记。

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 110 passed |
| `ssh_routes` 集成 | 5/5 |
| 真实 OpenSSH 夹具 | 只读 SFTP 依次经 HTTP、SOCKS5、russh 跳板和 `/usr/bin/nc` ProxyCommand 到达系统 OpenSSH，通过 |
| 浏览器全套 | 232/232，新增 14 项 |

Rust 评审的 1 个 HIGH 和 3 个 MEDIUM 已修复并复核。安全评审没有 CRITICAL、HIGH 或 MEDIUM。

边界：
- 只用过测试代理、`nc` 和 russh 跳板，没有用过真实代理软件，也没有用 OpenSSH 作跳板。
- 不支持多跳，不支持经代理到达跳板主机，也不保存路线。
- ProxyCommand 的 stderr 被丢弃。

## SFTP 写操作原型（F02–F07）

在只读授权模型之上增加了以下操作，见[说明](SFTP_WRITE.zh-CN.md)：
- **新建目录、重命名、删除**：删除只限文件和空目录。chmod 也在其中（属于候选 F24）。
- **上传**：
  - 默认只新建，覆盖需要显式开关，且只覆盖已有的普通文件。
  - 新文件先写到隐藏的 `.part`，校验大小后再改名。
- **下载落盘**：
  - 保存到“下载”文件夹。
  - 文件名经过清理，用 `create_new` 加“ (n)”后缀，不覆盖、不跟随符号链接。
  - 失败时删除不完整的文件。
- **写入开关**：写操作需要先对授权开启写入。删除、覆盖和 chmod 每次都要确认。
- **连接与取消**：每次操作都重新连接，并经授权绑定的路线。支持取消。
- **新增命令**：4 个，三处都已登记。

合并时，两边都改过授权接口：路线分支给 `issue_grant` 增加了 `Route` 参数，写操作分支给 `use_grant` 增加了“可写”参数。已更新只有一边知道的两处测试调用。

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 131 passed / 6 ignored |
| 集成测试 | 7、3、5、5、14、1 |
| 真实 OpenSSH 夹具 | 6/6，写操作用例含 64 MiB 下载；真实“下载”文件夹前后未变 |
| 浏览器全套 | 239/239 |

两项评审（Rust 和前端）都已复核通过。

尚未处理的问题：
- **写入开关缺少原生确认**：目前只是在 WebView 内表达意图，不是安全边界。对使用密码认证的主机，它确实会增加一项权限，发行前需要原生确认。
- **下载**：没有配额，也没有给下载的文件设置 macOS quarantine 标记。
- **覆盖**：直接改写原文件，失败或取消时文件可能不完整。
- **取消新上传**：可能留下 `.part` 文件。
- **改名**：只有 OpenSSH 服务端保证不会替换已存在的目标。

还没有验证：
- 原生窗口中的上传 IPC、文件选择器和“下载”文件夹定位。
- 非 OpenSSH 的服务端。
- Linux 与 Windows。

功能矩阵中 F02–F07 的状态不变。

## 集成分支 CI（合并发行包清理与终端内核决策后）

[run 38197476061](https://github.com/mofyer/new-windterm/actions/runs/38197476061) 的四个作业全部通过：macOS、Linux、Windows Server 2022、Windows Server 2025。

## Windows 句柄泄漏定位

每个本地终端会话多出的 1 个句柄，来自 Windows Server 2022（build 20348）系统自带的 ConPTY，不是本项目的代码。依据如下：
- **分步诊断**：只做 ConPTY 的打开和关闭、不启动 shell，每轮就多 1 个 `Process` 句柄；它指向的进程都已退出，与 conhost 的生命周期一致。
- **其余各步**：启动 shell、加 Job、完整会话都没有在此之上增加句柄。
- **新系统对照**：在 Server 2025（build 26100）上，所有步骤的增长都为 0，24 轮完整会话的句柄数始终是 117。

现在的泄漏检查断言：完整会话的句柄增长不超过裸 ConPTY 开关的增长再加 8。[run 38153032998](https://github.com/mofyer/new-windterm/actions/runs/38153032998) 的四个作业全部通过：

| 作业 | Rust 单元 | 其它测试 |
| --- | --- | --- |
| macOS | 102 passed | 集成 7、5、14、1 |
| Linux | 101 passed | 集成 7、5、14、1 |
| Windows Server 2022 | 106 passed / 6 ignored | 集成 7、5、13、1；诊断与相对泄漏检查 2/2 |
| Windows Server 2025 | 106 passed / 6 ignored | 集成 7、5、13、1；诊断与相对泄漏检查 2/2 |

可选缓解：随应用一起分发新版 `conpty.dll` 和 `OpenConsole.exe`，portable-pty 会优先使用它们。需要用户决定，目前没有采用。详见[决策记录](WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位)。

## 终端内核技术调整决策

[决策记录](TERMINAL_CORE_ADR.zh-CN.md)的建议是：P1 之前不更换终端内核，继续使用 xterm.js，按缺口分别处理。

| 缺口 | 处理方式 |
| --- | --- |
| SIXEL | 使用官方 `@xterm/addon-image` 0.9.0（MIT），并收紧限制 |
| DECSC、闪烁 | 上游 xterm 7.0 已修复，等待升级 |
| DECSLRM | 先向上游提出设计 |
| 双宽行、矩形操作 | 等实际 vttest 与 WindTerm 2.7.0 的对比结果再定 |
| Free Type、折叠、压缩历史 | 收到一个小的终端内核接口之后，降低以后更换内核的成本 |

另外建议用 2–3 周、限定时长，试做一次 Rust 内核方案。

同时提交了隔离的 SIXEL 原型。它只作为开发依赖，生产构建中没有它。SIXEL 原型 7 项测试通过，浏览器全套 218/218 通过。

最大的阻碍是 CSP：生产 CSP 不允许 addon 的 WebAssembly 解码器加载。启用它需要 `'wasm-unsafe-eval'`，必须先在 WKWebView、WebView2、WebKitGTK 中测试，并通过安全评审。

更换内核的粗略量级如下，都只是量级，不是排期：
- 更换 xterm.js：约 6–10 人月，补齐缺口另需 1.5–2 人月。
- 维护 xterm.js 分叉：前期约 10–16 人周。

## 完整工作量估算

[估算](EFFORT_ESTIMATE.zh-CN.md)只是估算，不是承诺。

全项目工作量（人周，最好 / 可能 / 最差）为 248 / 408 / 673，PERT 期望值 426。

日历时间（阶段允许重叠）：

| 人数 | 时间 |
| --- | --- |
| 1 人 | 约 9.3 年 |
| 2 人 | 约 5.2 年 |
| 4 人 | 约 2.9 年 |

关键路径是：上游盘点 → 应用架构 → VT 内核 → 压缩历史 → 折叠/大纲 → 搜索 → 三平台最终回归。约 38 / 60 / 98 个工作周，即使人手不限也约需 16 个月。路线图要求 P0 结束时重新估算。

## 发行包与最低 macOS 版本

测试和探针二进制改为需要 `dev-tools` feature 才会构建，包括 `pty_probe`、`ssh_probe`、`ssh_terminal_fixture`、`pty_diagnose`。效果如下：
- release `.app` 从 23.3 MiB 降到 14.6 MiB，`Contents/MacOS` 中只剩主程序。
- 新增守护测试 `tests/release_bins.rs`，发现有未加门槛的二进制就失败。
- CI、夹具运行脚本和文档中的命令都已同步更新。

最低 macOS 版本定为 13.3，见[说明](RELEASE.zh-CN.md)：
- 理由：前端构建目标是 Safari 16.4，已在 `vite.config.ts` 中固定，避免升级时悄悄抬高。
- 只是声明：没有在 13.3 上实际运行过，`.app` 也没有签名或公证。

集成分支上的检查结果：

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 102 passed |
| 集成测试 | `net_terminal` 7、`release_bins` 3、`ssh_kbdint` 5、`ssh_terminal` 14、`tmux_control` 1 |
| 真实 OpenSSH 夹具 | 4/4 与 1/1 |
| `pty_probe` | 加 `dev-tools` 时三项 PASS；不加时 Cargo 拒绝构建 |

## CI：六个作业全绿，并新增互操作证据（2026-10-12）

[run 38230376894](https://github.com/mofyer/new-windterm/actions/runs/38230376894) 的六个作业全部通过：
- macOS、Linux、Windows Server 2022、Windows Server 2025 四个常规作业；
- Linux 与 Windows 的原生 WebView 冒烟。

其中 Linux 作业里的三项互操作：

| 步骤 | 结果 |
| --- | --- |
| X/YMODEM 对 Ubuntu lrzsz 0.12.21rc | 11/11。上次失败的“对端中途被杀”一项也通过，根因与修复得到确认 |
| X11 转发对 OpenSSH 加 Xvfb | 通过 |
| agent 转发对 OpenSSH（首次在 Linux 上运行） | 通过：远端 `ssh-add -l` 只在开启转发时列出私有 agent 中的那把密钥 |

台账中 C10 的证据层级随之从 loopback 夹具升为真实对端，“原型/探针”组的层级计数变为：真实对端 23、真实平台 7、loopback 夹具 8、浏览器 29。

第三段结构验证原先把冻结前各行的证据字段也锁定为不可变，这与冻结规则不符：冻结锁定的是 ID、名称、阶段、状态与验收措辞，P0 证据可以随后更新。现已改为只核对被冻结的字段。

## E11：Windows 与 Linux 上游包静态核对

对官方 2.7.0 的 Windows 与 Linux 便携包做了只读静态核对，没有运行包内任何内容，见[记录](UPSTREAM_STATIC_REVIEW_WINLINUX.zh-CN.md)：
- **默认资源**：三个平台的默认资源几乎完全相同，菜单、动作、键位、设置都没有平台专属项。
- **G13**：三端默认键位都是 Ctrl+Enter；macOS 二进制中的文案暗示那里可能是 ⌘↩。
- **F08/F09**：三端主程序都没有引用 scp 函数，Windows 和 Linux 二进制中甚至没有 “scp” 字样。E3 条件中“各平台发布包”这一半结果为否，实机确认还没做，计数标记保持不变。
- **C23**：只有 Windows 包附带 VcXsrv 1.20.14.0，包内没有它的许可证文本。
- **C14**：Windows 与 Linux 的 libssh 没有链接 GSSAPI，这两个平台上 gssapi-with-mic 很可能不可用。
- **新候选**：WL-1 WSL 发行版作为本地 shell、WL-2 自动发现 Git Bash 与 Cygwin、WL-3 Clink 注入。都只是提议，按冻结规则需要用户批准才能新增 ID。

## agent 转发与真实 OpenSSH 互操作（C10）

新增 ignored 测试和夹具 `--agent` 模式，测试对象是本机 OpenSSH 10.3p1，使用私有临时 ssh-agent：
- 不开启转发时，远端拿不到 agent；
- 开启后，远端 `ssh-add -l` 正好列出私有 agent 中的那把密钥；
- 本机连续 3 次通过。Linux CI 新增一个步骤，尚待运行。

需要说明的一点：从 OpenSSH 10.1 起，sshd 会把转发的 agent 套接字建在账户真实的 `~/.ssh/agent/` 下，无法改到别处。所以在本机运行这项测试需要显式开关 `P0_AGENT_HOME_SOCKET=1`，默认会跳过。代理在本机运行时开了这个开关：sshd 每次都删除了自己建的套接字，目录中原有内容不变，只有目录的修改时间变了。

只验证了列出密钥，没有验证经转发的 agent 签名。

## lrzsz 0.12.21 失败的根因

Ubuntu 上的 lrzsz 0.12.21 以整秒计时，`rb` 在每次请求文件头之前都会等满 1 秒，而“对端中途被杀”测试的快速超时只能容忍 0.8 秒的静默。测试已改为在杀掉对端之后才开始计时，断言不变，并补充了诊断输出。

根因来自阅读 lrzsz 源码和本机模拟，尚待 CI 在 Ubuntu 上确认。读过 GPL 源码这一点已写进 [MODEM](MODEM.zh-CN.md)：将来自研 ZMODEM 的人不应读过它。

## 功能基线已冻结（2026-10-12）

用户对[冻结方案](BASELINE_FREEZE_PROPOSAL.zh-CN.md)中的 E1–E12 全部采用推荐选项，基线已冻结（`scope_frozen: true`）：

| 项目 | 结果 |
| --- | --- |
| ID 总数 | 161：原 130 个，加上 31 个采纳的候选；G43 排除，C23、C28、G54、G55 暂缓，这 5 个编号不再复用 |
| 措辞修改 | G13、F08/F09、Q06、C14、G02、S11、G17、G33、F21、T14、S08，以及因 G43 合并而调整的 T12、G12，共 13 行 |
| 计数标记 | S08 标为“上游未证实”，不计入对齐完成率；F08/F09 照常计入，待确认上游是否存在 SCP |
| 状态 | 冻结前的 130 行状态全部不变；新增 31 行均为“未实现” |
| P0 证据（161 项） | 原型/探针 67、仅静态 93、皆无 1 |

三段结构验证都通过，其中第三段核对冻结前各行的状态没有改动。

后续：
- 在隔离副本中运行上游 2.7.0 做实机盘点（E1 已授权）；
- 对 Windows/Linux 上游包做只读静态核对（E11）。

下文保留冻结前的方案说明。

## 功能基线冻结方案（2026-10-11 至 12 日，已决定）

[冻结方案](BASELINE_FREEZE_PROPOSAL.zh-CN.md)已经准备好。三处台账中的 130 个 ID 都补上了三类链接：静态证据、P0 原型或探针证据、冻结方案中对应的章节。两个结构验证脚本都通过。基线**尚未冻结**（`scope_frozen` 仍为 `false`），也没有改动任何一行的状态。

按 P0 证据分组：

| 分组 | ID 数 |
| --- | ---: |
| 有原型或探针 | 57 |
| 仅有静态证据 | 72 |
| 都没有（S08） | 1 |

57 项有原型或探针的 ID，按证据层级再分：

| 证据层级 | ID 数 |
| --- | ---: |
| 真实对端 | 6 |
| 真实平台 | 7 |
| loopback 夹具 | 17 |
| 浏览器 | 27 |

方案还为 36 个静态候选项提出了新 ID 建议，只是建议，没有写入台账：
- 建议纳入 31 项；
- 建议排除 1 项；
- 建议暂缓 4 项。

需要用户做出 E1–E12 共 12 项决定，其中 11 项会阻塞冻结。最关键的一项是：直接以 README 和静态证据为基准冻结，还是先允许在隔离环境中实际运行上游 2.7.0、记录与本项目的差异。

## 集成分支 `p0/integration`

合并 SFTP 面板、主机信任、认证方式、转发/代理/SCP/Telnet/tmux 探针与 Windows ConPTY 后，三平台 CI [run 38135518719](https://github.com/mofyer/new-windterm/actions/runs/38135518719) 为 **success**：

| 平台 | Rust 单元 | SSH | tmux |
| --- | --- | --- | --- |
| macOS | 66 passed / 4 ignored | 14/14 | 1 |
| Linux | 65 passed / 4 ignored | 14/14 | 1 |
| Windows | 71 passed / 4 ignored，含 ConPTY 生命周期 | 13/13，agent 测试仅 Unix | 1 |

本机浏览器全套 134/134 通过。下文的评审修复在此次运行之后提交，需要以新的 CI 运行为准。

## xterm.js 6.0.0 VT 兼容矩阵

针对锁定版本 xterm.js 6.0.0 编写了 63 项 VT 探针，逐项记录实际行为，见[矩阵](VT_MATRIX.zh-CN.md)。

| 状态 | 项数 | 说明 |
| --- | --- | --- |
| 支持 | 35 | 其中 3 项只说明可以用解析器钩子做适配 |
| 部分支持 | 16 | — |
| 不支持 | 12 | — |

浏览器全套 211/211 通过，其中新增 63 项。VT 矩阵单独重复运行 4 遍，252 次全部通过。

主要差距：
- **需要改动渲染器或内核**：双宽/双高行（DECDWL/DECDHL）、左右边距（DECSLRM/DECLRMM）、VT420 矩形操作、SIXEL，以及 DECSC 不保存原点模式和自动换行。
- **设备身份固定**：DA1/DA2 总是回复 VT100 级 xterm，DECSCL 无法改变一致性级别，因此选择 VT220/VT420/VT520 终端类型对主机不可见。这部分可以通过解析器钩子补上回复。
- **较小的 DEC 差异**：
  - 光标位置报告忽略原点模式。
  - 没有 SS2/SS3，没有 8 位回复（S8C1T）。
  - DECALN 保留滚动边距。
  - DECRQSS 报告的 SGR 和光标样式不正确。
  - 闪烁属性只存储、不绘制。
  - OSC 52 剪贴板被内核忽略。

两项因为无法确认而标为“部分支持”：
- DECSTR 后自动换行仍保持开启。
- SGR 像素鼠标模式发送的是从 0 开始的坐标。

边界：没有运行 vttest，没有与 WindTerm 2.7.0、真实 xterm 或 DEC 硬件对比；只是对 xterm.js 行为的记录，不代表 T 系列验收。

## keyboard-interactive 实时提示（C13）

连接过程中，服务端每一轮 keyboard-interactive 提示都会在发起操作的窗口中弹出对话框，用户回答后再继续，见[说明](SSH_KBDINT.zh-CN.md)。

覆盖范围与约束：
- **适用操作**：指纹确认、终端标签页、SFTP 面板。
- **命令绑定**：新增 `ssh_auth_respond`。回答只接受同一窗口、同一操作 ID、当前轮次。
- **上限**：最多 8 轮、每轮 16 个提示；回答不超过 1024 字节；每轮最长等待 120 秒，超时即失败。
- **等待计时**：用户作答的时间不计入网络期限。
- **中止**：取消、页面刷新或应用退出时，正在等待的一轮会被中止。
- **SFTP 授权**：不保存回答，之后每次 SFTP 操作都会重新提示。
- **服务端文本**：只用 `textContent` 渲染，控制字符和双向覆盖字符会被替换。

在集成分支上的检查结果：

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 102 passed / 4 ignored |
| `ssh_kbdint` 集成 | 5/5 |
| `ssh_terminal` 集成 | 14/14 |
| `net_terminal` 集成 | 7/7 |
| 浏览器全套 | 148/148 |
| 真实 OpenSSH 夹具 | 4/4 与 1/1，用于回归 |

独立评审结论为 APPROVE。它提出的唯一一项 MEDIUM 已在合并时修复：两条连接路径原先各自构造客户端配置，现在共用 `base_config()`。

边界与限制：
- 没有在真实 PAM 或 OpenSSH 的 keyboard-interactive 下验证，包括 OpenSSH 的 `LoginGraceTime`。
- 没有在原生窗口中手工操作。
- WebView、IPC JSON 以及 russh 内部持有的回答副本没有清零。

## Telnet 与 Raw TCP 终端标签（C02/C03）

桌面端现在可以从「新建连接」或命令面板打开 Telnet / Raw TCP 终端标签，见[说明](NET_TERMINAL.zh-CN.md)：
- **后端**：新增 `net_open/write/resize/ack/close` 五个命令，三处都已登记。输出与 PTY、SSH 共用同一套有界 ACK 字节流。
- **Telnet**：使用已有的 `telnet.rs` 编解码器。
- **输入**：Rust 侧每次写入在有界队列满时最多等待 15 秒。前端的有序输入队列（积压上限 16 MiB）后来才加入，见下文“输入路径”；在此之前，前端会直接拒绝超过 64 KiB 的粘贴。
- **连接中关闭**：可以直接取消连接。

在集成分支上的检查结果：

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 73 passed / 4 ignored |
| `net_terminal` 集成 | 7/7 |
| 浏览器全套 | 144/144，新增 10 项 |
| Windows 交叉类型检查 | 通过 |

边界与限制：
- 测试服务端都是测试内的 loopback TCP 服务器，没有与真实 telnetd 或网络设备互操作。
- 浏览器测试使用 IPC stub。
- 只处理 UTF-8。没有 Linemode，没有本地回显，没有保存会话。
- 真实内核连接卡住时的取消测试在 macOS 上会自行跳过，要等 Linux CI 才有结果。

## XMODEM/YMODEM 探针与 ZMODEM 决策（F10–F12）

新增不依赖 I/O 的 `modem` 模块（发送方与接收方），覆盖以下协议变体，见[说明](MODEM.zh-CN.md)：
- XMODEM 校验和、CRC 与 1K。
- YMODEM 批量传输。

测试结果：
- 23 项单元测试覆盖各尺寸与协议变体、逐字节送达，以及损坏、丢 ACK、取消等情况。
- 逐个注入 13 种错误时，每一种都至少让一项测试失败。
- 独立评审提出的 3 项 MEDIUM 已修复，并补了测试：中途误回退到校验和模式、残留 `C` 导致跳块、批量传输没有总内存上限。

与真实 lrzsz 0.13.1（经 Homebrew 安装）的互操作：
- **XMODEM/YMODEM**：经管道互操作 11/11。覆盖校验和、CRC、1K、YMODEM 批量（空文件、非 ASCII 文件名、非 128 整数倍的大小），以及双向 CAN 取消、对端中途退出、对端晚启动 2 秒。
- **找到并修复的 2 个接收方缺陷**：
  - 对端晚启动时，会把我们排队的每个 `C` 都当成一次请求，重发块 0。我们原来每份都 ACK，导致对端跑到前面，我们报序号错误，而对端却报告成功。
  - 我们回退到校验和模式之后，对端仍发来 CRC 帧，原来一直被拒收。
- **ZMODEM**：评估了 `zmodem2 =0.7.3`（MIT/Apache-2.0），评估用的 8 项全部完成，结论是**不采用**：
  - 发送端出现一个损坏字节后会失去同步，6 次试验 6 次复现；
  - 文件名和大小都没有上限；
  - 不处理对方的 CAN 取消，传输开始后也没有超时。

  它只作为开发依赖，供被忽略的评估测试使用；它的 `build.rs` 只在 PATH 中查找 `rz`/`sz`。准备按公开规范自行实现 ZMODEM，见[说明](MODEM.zh-CN.md)。
- **CI**：Linux 作业新增一个不阻塞的步骤，安装 apt 版 lrzsz 后运行 X/YMODEM 互操作测试。
  - Ubuntu 上的 lrzsz 是 0.12.21rc，11 项中 10 项通过（[run 38202512575](https://github.com/mofyer/new-windterm/actions/runs/38202512575)、[run 38206136775](https://github.com/mofyer/new-windterm/actions/runs/38206136775)）。
  - “对端中途被杀”一项两次都失败，报错是传输在干预前就已结束。可能的原因是这项测试为了快速超时，把重试参数设得很短，而旧版 `rb` 启动较慢；尚未查实。
  - 这一步设为 `continue-on-error`，所以步骤结论显示为 success，要以日志中的测试结果为准。

边界与限制：
- **只经过管道**：没有经过 PTY、SSH 或串口链路，也没有与 WindTerm 对比。
- **尚未接入任何链路**：没有接终端、SSH、串口或界面，也不写入磁盘。

ZMODEM 建议先评估 `zmodem2` crate（MIT/Apache-2.0），否则按公开规范自行实现。lrzsz 是 GPL 许可，不得复制。

## 性能基线（macOS arm64）

本机测得的基线见[记录](PERFORMANCE_BASELINE.zh-CN.md)。测量期间有其他代理并行运行，环境嘈杂；数字不代表性能关卡通过，也没有与 WindTerm 对比。

| 项目 | 结果 |
| --- | --- |
| PTY 2 MiB（debug） | 默认 5 ms 轮询 6.9 s，readiness 0.34 s（readiness 受测试内置的 300 ms 停顿限制） |
| Ctrl-C | 默认 18 ms，readiness 0.8 ms |
| xterm 解析（headless Chrome） | 38–76 MiB/s |
| 经应用路径（IPC stub） | 约 10 MiB/s，约为直接写入 xterm 的 1/4，原因未查 |
| `.app` | 21.7 MiB，仅 arm64，ad-hoc 签名 |
| 启动 | 到窗口出现约 268 ms，到界面就绪约 487 ms（中位数，非严格冷启动） |
| 空闲 RSS | 进程合计约 266 MiB（上界） |

发现的问题：release 包里混入了 `pty_probe`、`ssh_probe`、`ssh_terminal_fixture` 三个测试二进制，约 8 MB。已修复，见下文“发行包与最低 macOS 版本”。

未测：
- WKWebView 内的数字。
- GUI 全链路高输出测试。
- Linux 和 Windows。

## 上游静态证据复核

对 130 个 ID 逐条检查了上游 WindTerm 2.7.0 发布包与 README 的静态材料，只读取，没有运行、挂载或复制任何内容，见[复核记录](UPSTREAM_STATIC_REVIEW.zh-CN.md)。分类结果：

| 分类 | 行数 | 说明 |
| --- | --- | --- |
| 有支持证据 | 124 | 其中直接证据 101 行，部分或间接证据 23 行 |
| 证据矛盾 | 4 | F08、F09、G13、Q06（Q06 证据较弱） |
| 无静态证据 | 2 | T14、S08 |

值得注意的矛盾与发现：
- **G13**：README 写的是 Shift+Enter 切换本地/远端模式，默认按键表实际绑定的是 Ctrl+Enter。
- **F08/F09（SCP）**：主程序没有引用任何 SCP 函数，只引用了 SFTP 函数。
- **C14（GSSAPI）**：README 路线图写的是“推迟”，但发布包实际已调用 GSSAPI 认证，并链接了 Kerberos。
- **Q06**：README 称滚动历史“无限”，默认值实际为 999,999 行。

另外列出 36 项不在 130 个 ID 内的静态候选，未分配新 ID。静态证据不代表行为已验证，本文不改变任何一行的状态，台账也没有修改。

## 网络探针安全评审

独立安全评审覆盖以下模块，结论为没有 CRITICAL 或 HIGH 问题：
- 转发、通道路由、代理与 ProxyCommand
- SCP
- Telnet
- keyboard-interactive

已修复的问题：
- **远端转发通道数**：服务端主动打开的 `forwarded-tcpip` 通道原来没有并发上限，现在与本地转发一样最多 64 个，超出的直接拒绝。新增测试：上限设为 1 时第二个通道被拒，第一个结束后名额可以复用；反向检查（取消上限）下该测试失败。
- **HTTP CONNECT 主机名**：主机名中出现控制字符或空格时直接拒绝，防止拆分请求行或注入请求头。
- **SCP 文件大小**：下载大小改用 `usize::try_from` 转换。

未采纳的问题：
- **Telnet 拒绝回复**：评审认为对不支持的选项每次都回 `DONT` / `WONT` 会被放大。这一条未采纳：RFC 1143 要求在 him=NO 时以 `DONT` 回复 `WILL`；回复字节数不超过请求，不构成放大，也不会形成循环。已在代码中注明理由。

仍是低风险项：ProxyCommand 子进程不关闭 stdout 时，读取线程会一直阻塞；`Drop` 时会结束子进程。

## 原生 WebView 冒烟（Linux WebKitGTK、Windows WebView2）

此前所有界面测试都在 Chrome 加 IPC stub 下进行。现在 CI 新增 `native-webview` 作业：
- 构建真实的 Tauri 应用（生产前端，`custom-protocol`）；
- 经官方 tauri-driver 2.0.6 驱动真实原生 WebView，在 Linux 上是 WebKitGTK 2.52.6（xvfb），在 Windows 上是 WebView2 131.0.2903.86（msedgedriver 版本与之完全一致）；
- 不引入任何 npm 依赖，WebDriver 客户端只用 Node 内置的 `fetch` 实现。

三个场景在 [run 38211278428](https://github.com/mofyer/new-windterm/actions/runs/38211278428) 中两个平台都通过：

| 场景 | 证明的内容 |
| --- | --- |
| 工作台 | 页面从打包源 `tauri://localhost` 加载，Tauri IPC 存在，xterm 正常渲染 |
| 本地终端 | 真实 PTY（Linux bash、Windows `cmd.exe`），经真实 IPC 与 ACL 完成输入和回显，用带随机标记的 `echo` 判定 |
| SSH 终端 | 走真实的连接对话框，核对夹具指纹后，连上 loopback russh 夹具，`size` 与 `unicode` 往返成功，`exit` 退出码为 7 |

第一次运行时，三个场景里的 SSH 场景失败了。证据显示终端已经出现 `> SIZE 136 24`，失败只是因为匹配没有考虑夹具输出前的提示符 `> `，已修正。截图、日志和版本信息都作为 CI 附件上传。

没有验证：
- macOS WKWebView：tauri-driver 不支持 macOS。
- 输入法：按键是经 WebDriver 合成的，不是经系统输入法输入。
- 屏幕阅读器、签名、release 构建、高输出性能、PowerShell、Wayland，以及真实 OpenSSH。

另外，Tauri 只要设置了 `TAURI_WEBVIEW_AUTOMATION=true`，任何构建都会开启 WebView 自动化，包括 release 构建。这一点需要在发行前做安全评审。见[说明](NATIVE_WEBVIEW_SMOKE.zh-CN.md)。

## SCP 界面与 agent 转发（F08/F09、C10）

**SCP（F08/F09）**：SFTP 面板新增“用旧版 SCP 协议传输单个文件”选项，默认关闭，每次新授权时重置。
- **新增命令**：`ssh_scp_upload` 和 `ssh_scp_download`，三处都已登记。
- **连接**：经授权绑定的路线重新连接，并固定校验主机密钥。
- **上传**：需要先开启授权的写入，远端命令为 `scp -t -d`。没有 `-d` 时，如果父路径是普通文件或不存在，OpenSSH 可能把父路径本身当作目标写入。这是评审提出的 HIGH，已修复。
- **下载**：规则与 SFTP 下载相同（“下载”文件夹、文件名清理、`create_new`、上限 64 MiB、失败时删除不完整的文件）。

**agent 转发（C10）**：连接对话框新增“转发本机 ssh-agent（仅对信任的主机）”。
- 默认关闭，不保存，勾选后显示警告。
- 本机 agent 的路径只读取一次，并在连接前检查。只有这一条连接接受 `auth-agent` 通道。
- 服务端拒绝转发时，终端不会打开。

| 检查 | 结果 |
| --- | --- |
| Rust 单元 | 161 passed |
| `ssh_agent_forwarding` | 1 项，使用私有临时 ssh-agent |
| 真实 OpenSSH 夹具 | 6/6，含 SCP 直连、经授权和 `-d` 父路径用例 |
| 浏览器全套 | 370/370 |

Rust 评审的 HIGH、3 个 MEDIUM 和 5 个 LOW 都已修复。代码评审结论为 APPROVE。

没有验证：
- 原生窗口中的 SCP 上传和下载。
- agent 转发与 OpenSSH 服务端的互操作，目前只对 russh 夹具测过。
- SCP 只能传单个普通文件。

## X11 转发探针（C15）

按[决策记录](X11_GSSAPI_ADR.zh-CN.md)实现了 X11 转发，暂时只有 Rust 入口 `Ssh::open_with_x11`，没有界面，也没有 IPC。

**机制：**
- 在会话通道上发送 `x11-req`，携带随机生成的 16 字节假 cookie，屏幕 0。
- 只有对这条连接开启了 X11，才接受 x11 通道，同时最多 32 个。
- 对每个通道：
  - 按两种字节序解析连接建立报文；
  - 用不随差异位置变化耗时的方式比对假 cookie，不匹配就直接关闭，不连接本地显示；
  - 匹配时换成从 `xauth` 读出的真实 cookie，再开始转发。
- 终端结束时，所有 X11 中继随之结束。

**安全限制：** 与 `ssh -X` 不同，这里没有生成受限的 untrusted cookie，远端 X 程序拥有与本地程序相同的显示权限。

**测试：**

| 检查 | 结果 |
| --- | --- |
| X11 模块单元测试 | 11 项通过（loopback 夹具加假 X server） |
| 变异检查 | 拿掉 cookie 替换、cookie 比对、通道上限或槽位释放中的任一项，都会有测试失败 |
| 合并后 Rust 单元 | 151 passed |
| 本机一次性互操作 | OpenSSH 10.3p1 sshd 接受了 `x11-req`，cookie 替换和错误 cookie 拒绝都正确；只到消息层 |
| Linux CI 步骤 | 安装 Xvfb、xauth、x11-utils，经真实 OpenSSH 在远端运行 `xdpyinfo`，[run 38207141339](https://github.com/mofyer/new-windterm/actions/runs/38207141339) 通过：远端 `xdpyinfo` 经我们的转发读到带 cookie 保护的 Xvfb 的 `1234x567`。此前两次失败只因测试中的字符串比对（PTY 行尾的 CR、双空格） |

两项评审的 MEDIUM 都已修复。

**没有验证：**
- 真实 X 程序和 XQuartz。
- Windows：没有 xauth，目前拒绝 X11。
- Wayland。
- 经代理或跳板的 X11。

该阶段 GSSAPI（C14）只有决策记录；2026-10-15 已新增独立探针，见本文顶部续做记录。

## X11 转发与 GSSAPI（C15/C14）早期决策记录

russh 0.64.1 已提供 `request_x11` 与 `authenticate_gssapi_with_mic`，两项都不阻断当前路线。X11 将作为显式开启的第三种路由，采用不可信转发（假 cookie 替换）；GSSAPI 需要接系统 GSS（macOS GSS.framework、Linux libgssapi、Windows SSPI）。验证分别需要 XQuartz/Xvfb 与测试 Kerberos 领域，本机均不具备，未写实现代码。[决策记录与所需条件](X11_GSSAPI_ADR.zh-CN.md)

## Windows ConPTY 本地终端（工作分支 `p0/windows-conpty`）

`platform::ensure_supported()` 不再拒绝 Windows。按 [ConPTY 决策记录](WINDOWS_CONPTY_ADR.zh-CN.md) 实现的生命周期：shell（`cmd.exe /D /Q /K`）启动后立即加入 kill-on-close Job Object；等待线程持有子进程，子进程退出后关闭 pseudoconsole，使阻塞的 `ReadFile` 在 conhost 刷完输出后得到 EOF；关闭会话即终止整个 Job；reader 结束后继续读取并丢弃输出直到 EOF，避免 portable-pty 自持读句柄时 conhost 卡在写满的管道上；启动 shell 前恢复正常 Ctrl+C 处理，防止继承“忽略 Ctrl+C”属性。前端在会话 ID 到达前暂存输入（≤ 4 KiB），保证 xterm 对 ConPTY 启动时光标位置查询（`ESC[6n`）的回复不会丢失，否则 Windows shell 会卡在启动阶段。私钥读取在 Windows 上拒绝设备命名空间路径，并要求打开后 `GetFileType == FILE_TYPE_DISK`。

三平台 CI [run 38134532830](https://github.com/mofyer/new-windterm/actions/runs/38134532830) **success**：Windows 48 passed / 2 ignored，其中 10 项 ConPTY 生命周期测试全部通过（exit 7、UTF-8、窗口尺寸、空闲与重复关闭、输出中关闭、Ctrl+C、ACK 预算与超时、页面刷新、Job Object 回收脱离子进程、12 轮循环），SSH 10/10；macOS 41、Linux 40 passed。诊断日志记录原始 `0x03` 与 win32-input-mode 编码都能中断 `ping -t` 与 `for /L`。此前 5 次失败依次暴露并修复了：启动光标查询、清空环境后的测试标记、ACK 超时后的管道死锁、`ping -t` 起始判据、继承的 Ctrl+C 忽略属性。本机另有 Windows 目标的交叉 clippy 检查（使用桩头文件，仅类型检查）。

独立 Rust 评审后补充：
- 自然退出时先终止整个 Job，再关闭 pseudoconsole。
- 终止 Job 失败时回退为终止 shell 进程。
- Ctrl+C 恢复只执行一次。
- 句柄泄漏检查改为与裸 ConPTY 开关做相对比较，在 CI 中单独运行。泄漏已定位到 Server 2022 系统自带的 ConPTY，见下文“Windows 句柄泄漏定位”。
- 前端早期输入暂存只作用于本地 PTY，并在退出、启动失败或关闭时清空。

排空无期限与 Job 分配竞态两项已知限制见[决策记录](WINDOWS_CONPTY_ADR.zh-CN.md)。

边界：只验证了 `cmd.exe`；PowerShell、WebView2 原生窗口、输入法、高输出性能与真实 Windows 用户环境（非 CI runner）尚未验收；`pty-readiness` 在 Windows 上不使用（ConPTY 管道为阻塞读取）。

## SCP 上传与下载（F08/F09）

传统 `scp -t/-f` 协议在 exec 通道上实现，与 SFTP 分开验收。对真实 OpenSSH（夹具白名单只放行目录内的 `scp -f|-t -- '<路径>'`）上传并下载 1 MiB 的中文文件名文件，字节一致；缺失文件、大小上限、非法文件名与越界路径均被拒绝。夹具运行脚本 4/4 通过。集成分支上，SFTP 夹具 `fixture.test.mjs` 在紧接 Rust 客户端脚本之后运行时失败过一次（1/2）。之后连续 3 次都通过，原因未查明，记为偶发。目录、递归与时间戳未实现，也没有界面。[说明](SSH_SFTP_FIXTURE.zh-CN.md)

## Telnet 编解码器（C02）与其它连接类型

Rust 编解码器处理 IAC 协商（ECHO/SGA/BINARY/TTYPE/NAWS，其余拒绝、不循环）、0xFF 转义、`CR NUL`、有界子协商；3 项单元测试在任意切分下结果一致。Raw TCP 复用现有数据路径，串口需要真实 USB 设备才能验证。[说明与计划](TRANSPORTS.zh-CN.md)

## 远端转发与 agent 转发（C17/C10）

修正了一处安全默认值：russh 客户端默认接受服务端主动打开的任意通道，现在只接受登记过路由的 `forwarded-tcpip` 和显式开启的 agent 通道，其余一律拒绝。远端转发往返一致、未登记端口被拒、取消后停止监听；agent 转发默认拒绝、开启后可查到临时 agent 的公钥。[说明](SSH_FORWARDING.zh-CN.md)

## 经代理连接与 ProxyCommand（C07/C19/C20）

HTTP CONNECT（含 Basic 认证与 407 报告）、SOCKS5（含用户名/密码）和不经 shell 的 ProxyCommand（仅 `%h %p %r %%` 替换，释放即结束子进程）都产出字节流，再走与直连相同的固定主机密钥与认证流程。4 项测试通过，均能完成认证并在 shell 中 exit 7。尚无界面与配置。[说明](SSH_FORWARDING.zh-CN.md)

## 连接复用（C06）

探针证明一条已认证的 russh 连接可同时承载多个独立 PTY shell：各自尺寸正确，关闭一个不影响其余，主连接断开时全部结束，服务端只看到 1 条连接、1 次认证。据此提出 ADR：应用内复用用 russh 多通道实现，P0 不实现供外部进程使用的 OpenSSH ControlPath 多路复用协议，待上游对照后定稿。测试夹具改为按通道保存 shell 状态。[决策记录](CONTROLMASTER_ADR.zh-CN.md)

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
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features dev-tools --bin pty_probe
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features dev-tools,pty-readiness --bin pty_probe
```

本机 debug 产物位于 `apps/desktop/src-tauri/target/debug/bundle/macos/New WindTerm P0.app`，不随 Git 分发，无签名公证。浏览器临时回执位于被忽略的 `apps/desktop/test-results/`，后续运行会覆盖。

## 未完成与下一步（2026-10-15）

1. 本批 CI、失败修复和证据归档已完成；继续按下列实机风险与出口条件收口 P0。
2. 按 [HANDS_ON_CHECKLIST](HANDS_ON_CHECKLIST.zh-CN.md)完成上游实机差异，尤其是影响范围或[终端内核决策](TERMINAL_CORE_ADR.zh-CN.md#决策前必须验证)的行为。功能基线已为 164 项，不再把“冻结 130 项”作为待办。
3. 补原生 IME、VoiceOver、WKWebView 输出/输入延迟与资源测量。真实 UART 参数与拔插仍需硬件，不能以虚拟 PTY 通过替代。
4. 汇总风险和技术调整方案，更新估算并进行 P0 出口评审。完整 SSH/SFTP、ZMODEM、全部终端兼容实现与签名发行按 P1–P5 推进；不因阶段划分删减最终功能。
5. 本批 CI 已通过，2026-10-15 经用户明确同意已合并并推送 `main`；后续批次合并仍需另行批准。
