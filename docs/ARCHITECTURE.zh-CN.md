# 架构候选与原型验证

状态：P0 进行中；用户已确认 Rust + Tauri 2 + xterm.js 与 Apache-2.0。`apps/desktop` 已有可运行交互原型和 Rust 本地 PTY，原型依赖已锁定，已接入受限 SSH 协议验证，完整产品能力尚未实现。
调研日期：2026-10-11。本文保留后续架构候选与验证要求；当前实现和验证边界见 [P0 结果](p0/RESULTS.zh-CN.md)，不构成性能或全量兼容性承诺。
浅色白银浮层与深色中性炭灰方向均已获用户认可，不代表完整功能验收。浏览器、Rust、平台 CI 与原生证据统一见 [P0 结果](p0/RESULTS.zh-CN.md)及[浏览器报告](p0/WEB_QA.zh-CN.md)，此处不重复易变化的测试数量。原生中文/emoji 粘贴冒烟不等于 IME 通过，Chrome 状态更新优化不等于原生高输出响应已解决，隔离 VT52 实验也未接生产终端。

## 目标与范围

- 首发平台为 macOS Apple Silicon M 系列；按阶段实现完整功能基线。
- Rust 承担网络、会话生命周期、文件传输与持久化业务核心。
- 最终目标是完整重构 WindTerm 2.7.0 的现有全部功能；macOS 优先验证和交付，Windows、Linux 从当前阶段共同作为架构目标。
- 阶段交付不缩减总范围；以 2.7.0 实际行为、官方功能说明和逐项验收形成完整功能基线。
- 实际最低 macOS 版本由选定依赖和测试矩阵确定，暂不提前承诺。
- 界面采用[现代苹果风设计](DESIGN.zh-CN.md)，保留完整功能语义、安全与效率；苹果风不代表改用 SwiftUI/AppKit，已确认的 Rust/Tauri/xterm.js 路线保持。

共享核心和协议逻辑保持平台无关，PTY、shell、凭据库、快捷键、文件系统和系统集成通过平台适配；Windows/Linux 不是 macOS 完成后另写的产品。已有 macOS 宿主和部分 hosted 证据，不能据此宣称三端完整兼容。具体差异、CI 与实机验收边界见[跨平台计划](CROSS_PLATFORM.zh-CN.md)。

## 桌面路线比较

| 路线 | 官方资料确认的能力 | 本项目的取舍建议 |
| --- | --- | --- |
| Rust + Tauri 2 + xterm.js | Rust 后端、系统 WebView；xterm 提供终端模拟和可选 GPU 渲染 | 已确认技术方向；须验证全量功能可行性，控制 IPC、WebView 与依赖安全风险 |
| Rust + GPUI + alacritty_terminal | GPU UI，macOS 使用 Metal；GPUI 仍为 pre-1.0，可能频繁破坏兼容 | 全 Rust UI 候选；需自行集成终端画布、输入、选择与可访问性，先做原型 |
| SwiftUI/AppKit + Rust | SwiftUI 面向 Apple 平台且可与 AppKit 集成；Rust 可通过 FFI 连接 | 适合优先系统交互；增加 Swift/Rust 桥接与终端视图工作，其他桌面系统需另一套 UI |
| Iced + alacritty_terminal | Rust 跨平台 GUI，wgpu 支持 Metal；官方仍标记 experimental | 备选；终端组件和交互仍须实现 |
| egui + alacritty_terminal | Rust immediate-mode GUI；官方说明接口仍变化，不追求系统原生外观 | 适合原型或调试工具；精致终端产品不是本轮首选 |

这些排序是工程判断，并非已测量的性能结论。官方依据见文末 [1]—[8]。
Tauri 的 WebView 不等于依赖 Rosetta：官方构建示例支持 `aarch64-apple-darwin`。[1][2]
ARM64 原生机器码、Rust 业务核心、系统原生控件是不同维度，应分别说明。
GPUI/egui/Iced 自绘界面也不能自动等同于 AppKit 原生控件。

## 推荐候选的职责边界

以下以已确认的 Tauri 路线展开；核心业务接口应避免绑定某个 UI 框架。
当前实现集中在 `apps/desktop/src` 和 `apps/desktop/src-tauri/src`，已接入 portable-pty、Tauri Channel 与顺序 ACK；`platform.rs` 已隔离 macOS zsh 与 Linux Bash 的 shell/环境/Unix I/O/EOF，Linux 运行证据以[跨平台验证](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md)为准，不能由代码适配推断通过。Windows ConPTY 未实现，创建 PTY 前明确拒绝。`ssh.rs` 管理一次性主机信任与固定命令验证，`ssh_terminal.rs` 将 SSH PTY/shell channel 接入同一终端字节流；`sftp.rs` 提供只读、有界的 raw SFTP 浏览，由 `ssh.rs` 的窗口内短时授权驱动；SFTP 写操作、长期凭据与完整持久化层仍为计划，普通连接及文件界面仍是演示。`pty-readiness` 为默认关闭的 Unix poll/ACK 通知实验，不改变默认构建的 5 ms 轮询策略。

| 模块 | 职责 | 不承担的职责 |
| --- | --- | --- |
| 桌面 UI | 会话树、标签、连接表单、传输队列、用户操作 | 私钥文件读取和长期凭据持久化 |
| xterm.js | 终端解析、屏幕状态、选择、滚动、输入事件 | 建立 SSH 连接或启动本地 shell |
| Rust 会话层 | 状态机、取消、超时、资源释放、会话 ID 与所属窗口校验 | 绘制终端字符 |
| Rust SSH 层 | russh 0.64.1 用于指纹、本次或持久化主机信任（`known_hosts.rs`）、测试密钥、固定命令及交互 PTY/shell channel；完整认证与互操作待验证 | 把远端输出当作可信 UI 内容 |
| Rust SFTP 层 | 基于 russh-sftp 候选实现列目录、上传下载、进度、取消与失败反馈 | 默认静默覆盖或删除远端文件 |
| Rust 本地 PTY 层 | P0 已采用 portable-pty 0.9.0，支持受限本地 shell；完整平台支持待验证 | SSH 协议或终端模拟 |
| Rust 存储层 | 会话元数据、设置、迁移与凭据引用 | 在普通配置、日志和仓库中写入明文秘密 |

russh 0.64.1（ring 后端）已锁定用于受限 SSH 验证，依赖 tokio 1.50.0 与 zeroize 1.9.1；不代表覆盖 WindTerm 的全部 SSH/OpenSSH 行为。`russh-sftp 3.0.1` 仅用于只读浏览切片，差距必须逐项验证。[9]
portable-pty 提供跨平台系统 PTY 接口；它不是终端模拟器。[10]
会话元数据可采用 SQLite 或版本化配置文件，P0 根据迁移、并发和备份需求选定。
凭据计划使用系统安全存储；具体 Rust 适配库、访问策略与失败行为待验证。

## 本轮受限 SSH 交互边界

`src/ssh-verification.ts` 通过 `ssh_context` 取得窗口代际的 `scopeToken`，再调用 `ssh_probe` 获取实际 Ed25519 主机指纹。明确确认一次性 challenge 后，固定命令模式调用 `ssh_accept`，交互终端模式调用 `ssh_open`；两者都重新连接并固定校验已确认的主机密钥。未加密 Ed25519 私钥仅传绝对文件路径，由 Rust 有界读取，不写日志或持久化配置。

`ssh_open` 请求 PTY/shell 后返回会话 ID，复用 `PtyEvent` 和 xterm 的原始字节写入/顺序 ACK 路径；输入、尺寸、ACK、关闭分别使用 `ssh_write/resize/ack/close`。输入与输出独立驱动，关闭和取消不排在输入队列后面；归属、scope 失效、晚到打开结果、超时、窗口/应用退出均有清理路径。前端远程标签禁用演示样本与压力命令，不自动向远端发送它们。

真实协议测试使用有限命令 loopback russh 服务端，与客户端同为 0.64.1；不启动 OS shell，不能据此宣称 OpenSSH、vim/tmux 或真实远端 shell 互操作通过。本轮针对 russh 重协商不重新调用主机密钥检查的问题，采用显式拒绝 rekey、提示重连重新确认的受限策略；该拒绝策略已通过真实服务端发起重协商的集成测试与独立审查，仍不支持透明 rekey。主机信任可在明确确认后保存（变化即阻断、需独立替换）；认证支持 Ed25519/ECDSA 私钥（可带口令）、密码与 SSH agent（`ssh_auth.rs`）；当前不支持 RSA 私钥、keyboard-interactive、代理/跳板、转发或 SFTP 写操作；只读 SFTP 浏览见[受控夹具与 IPC](p0/SSH_SFTP_FIXTURE.zh-CN.md)。[交互通道与生命周期](p0/SSH_TERMINAL.zh-CN.md) · [固定命令入口](p0/SSH_CLIENT.zh-CN.md)

## 终端状态只保留一份

Tauri 路线由 xterm.js 持有权威终端屏幕状态，Rust 转发字节流与管理连接。
不要在 Rust 再维护一份 vt100/alacritty 屏幕，再与前端逐格同步。
如果选择纯 Rust UI，则改由 alacritty_terminal 持有终端状态，GUI 读取其网格绘制。
alacritty_terminal 提供网格、终端状态和选择等组件，不等于现成桌面终端 UI。[11]
vt100 可用于受控场景的屏幕快照或测试辅助，不作为完整现代终端能力的默认承诺。[12]
测试辅助解析器不能成为与生产终端状态竞争的第二个数据源。
当前工作区统一启用 `@xterm/addon-unicode11@0.9.0` 的 Unicode 11 宽度表，修正已发现的部分 emoji 列宽问题；这不代表 Unicode 13、较新 emoji/ZWJ 或中文输入法已验收，详见[原型说明](p0/UI_MAP.zh-CN.md)。

## 字节流、顺序与背压

当前 PTY 数据路径：PTY → Rust 有界队列 → Tauri Channel → xterm.write → ACK。交互 SSH 复用 Channel/xterm/ACK 路径，协议接收桥接层独立管理。固定命令 SSH 验证返回有界 stdout/stderr 字节与退出状态，在独立对话框显示，不接 xterm 或 PTY ACK 链。原型具体预算、超时和清理证据见 [PTY 记录](p0/PTY_PROBE.zh-CN.md)，下列要求继续约束后续实现。
终端输出保留字节语义，避免按网络块独立转 UTF-8 导致跨块字符损坏。
每个会话独立维护序号、待确认字节数、上下水位及关闭状态。
PTY 达到高水位时等待容量；不得无限缓存或静默丢字节。当前 SSH IPC 未 ACK 预算为 64 KiB/64 块，接收 bridge 为 64 条、每条数据最多 4096 字节，协议内部缓冲另计。由于 russh 自动窗口调整与共享传输循环的限制，桥接需持续读取，过载时明确报错并关闭；这尚不是由前端 ACK 驱动的端到端 SSH 窗口流控，长期慢消费可用性仍待改进。
当前 xterm 完成每块解析后逐块顺序 ACK，释放对应预算后允许继续输出；ACK 不混入用户输入。
Channel 保证有序交付的能力不等于应用已经具备背压，仍需显式有界队列与 ACK。
批处理大小、水位与刷新节奏通过实测决定，不能把文档示例常量直接当作产品指标。
Tauri 官方说明普通事件系统不适合低延迟高吞吐，流式数据应考虑 Channel。[13]
xterm 官方也要求控制高速生产者，并提示错误流控可能死锁或丢弃数据。[14]
连接关闭、前端销毁、ACK 超时和取消必须解除等待、释放资源并报告明确状态。
文件传输使用独立任务与受限并发，不挤占交互终端的数据队列。

## 全量重构的可行性关卡

已确认存在的功能全部必做，文档矛盾项在 P0 核实；不能因阶段性交付而移出总范围，具体行为以功能基线验收为准。[17]

| 能力组 | 架构约束与验证重点 |
| --- | --- |
| 可插拔连接 | 抽象异步字节流、窗口尺寸、取消、连接元数据及能力声明；实现 SSH、Telnet、Raw TCP、串口、本地 Shell，避免假定所有协议都具备 PTY |
| SSH/OpenSSH 差距 | 验证 ControlMaster、ProxyCommand/ProxyJump、SSH agent/agent 转发、X11、本地/远端/动态转发与 HTTP/SOCKS5 代理；GSSAPI 现有能力待实测确认，不把路线图自动计入已有能力；不能从 russh 有 channel 推断全部支持 |
| SSH 扩展路径 | 必要时评估受控系统 OpenSSH 适配或其他库；覆盖版本检测、取消、凭据及进程边界，不把外部命令拼接为 shell 字符串 |
| 文件传输 | SFTP、SCP、本地文件管理，以及串口/会话 X/Y/ZModem；验证流量解复用、二进制完整性、恢复、取消和冲突语义 |
| tmux 集成 | 验证 control mode 的协议解析、窗口/面板映射、事件同步、重连与恢复；能运行 tmux 不等于完成集成 |
| 高级终端体验 | 时间戳、折叠/大纲、Free Type、Sync Input、自动补全、命令发送器、快捷栏、命令面板、搜索预览和本地/远端 Vim 模式需单独设计 |
| 终端兼容性 | VT100/220/340/420/520、xterm、256 色及自定义协议/终端；按功能基线和测试集验证，不能把 xterm.js 视为所有 VT 方言的现成实现 |
| 历史与内存 | 大规模历史、搜索、动态压缩与布局恢复须联合验证；存档与索引可独立存储，但不维护第二套实时终端屏幕状态。热窗口 + 压缩冷归档已有隔离实验，见[压缩历史](p0/HISTORY_ARCHIVE.zh-CN.md) |
| 跨平台与界面 | Windows shell/管理员模式、Linux/macOS shell、多语言、主题、锁屏、日志、会话恢复等按矩阵补齐，平台差异显式记录 |

xterm.js 的高级 UI、历史压缩与多种终端方言适配属于 P0 阻断性问题，不能仅靠外围界面承诺解决。
P0 必须完成困难能力的验证样本；不足时通过 ADR 决定扩展、受控分支或替换组件，保持完整功能目标。
组件替换不意味着删功能；ADR 必须记录功能差距、证据、维护成本、迁移方式和重新验收条件。

## 安全与凭据边界

- 主机密钥首次连接展示指纹并请求信任；已记录密钥变化时阻断，提供显式处理入口。
- 私钥与已存凭据由 Rust 读取和使用，向 UI 返回引用或必要状态，不返回完整秘密。
- 用户在连接表单或终端输入的密码仍可能经过 WebView/JavaScript，不能承诺前端永远不接触秘密。
- 因此 UI 资产随应用打包，不加载远程脚本；禁用秘密日志，减少敏感值驻留和依赖数量。
- 终端输出、窗口标题、超链接和文件名均视为不可信数据，不直接注入 HTML 或执行脚本。
- IPC 按会话及窗口授权，使用最小权限；不向前端开放任意系统命令或任意路径读写接口。
- OSC 剪贴板、外部 URL 打开和多行粘贴制定明确策略，避免远端输出越权触发本地行为。
- 依赖审计、主机密钥测试、更新签名与发布凭据隔离纳入后续实现验收。

xterm 官方安全指南明确：同一页面中的 JavaScript 能访问终端输入，应特别防范 XSS 与外部代码。[15]

## P0 原型验证关卡

1. ARM64 构建：真实 M 系列机器启动；核对主程序、动态库和 sidecar 架构，无 Rosetta 必需依赖。
2. 终端正确性：中文 IME、CJK 宽字符、emoji、组合字符、vim/tmux、鼠标、选择、粘贴与 resize。
3. 输出压力：持续大量输出仍能响应 Ctrl-C；验证顺序、完整性、有界内存与 ACK 死锁恢复。
4. SSH：密码和密钥认证、首次信任、密钥变更、取消、断网、休眠唤醒及会话关闭。
5. SFTP：中文文件名、大文件、进度、取消、传输失败、同名文件冲突；失败不能误报成功。
6. 资源：多会话打开关闭，检测进程、文件句柄、任务及内存是否持续增长。
7. 系统体验：快捷键、输入焦点、Retina 缩放、字体回退、复制粘贴及无障碍基本行为。
8. 设计确认：制作关键界面静态稿和交互原型供用户确认；新入口映射功能 ID，并验证可发现性、键盘触达和终端快捷键边界，P4 分别开展视觉与功能验收。

测量启动时间、输入延迟、输出吞吐、CPU、内存与空闲耗电，并记录机器、系统和构建条件。
P0 产出是证据及组件可行性决定，涵盖上述全量关卡；不能通过缩减用户目标来宣布验证成功。
代码构建、签名、公证、安装与全新机器运行是不同验收阶段。[16]

## 当前目录与后续拆分建议

`apps/desktop` 已创建：`src` 包含前端原型，`src-tauri/src` 包含 Rust PTY、受限 SSH 验证与 IPC，`tests/e2e` 包含浏览器验收；`tests/fixtures/ssh-sftp` 提供本机受控对端与 Rust 客户端集成测试。当前没有下列独立 `crates` 分层，按后续复杂度再拆分，不能从建议目录推断模块已实现。

```text
apps/desktop/             # 已有 P0 Tauri + TypeScript UI 与内置 Rust PTY
crates/session-core/      # 会话状态机与框架无关接口
crates/transport-ssh/     # russh 适配与主机信任
crates/transfer-sftp/     # 文件传输任务
crates/transport-pty/     # 本地 PTY 适配
crates/storage/           # 元数据迁移与安全存储适配
tests/fixtures/           # 终端、SSH、SFTP 验证样本
benchmarks/               # 可复现压力和资源测量
```

除已说明的 `apps/desktop` 和 `tests/fixtures/ssh-sftp` 外，以上为后续结构建议；当前交互 SSH 集中于 `apps/desktop/src-tauri/src/ssh_terminal.rs`，通用 transport 拆分、完整 SSH 能力、SFTP、串口、调制解调传输与 tmux 模块尚待实现。

## 依赖版本与官方依据

实施时固定 Rust 工具链、直接依赖和锁文件；应用提交 Cargo.lock 与前端包管理器锁文件。
依赖升级独立提交并重跑相关兼容性测试；不要照搬主分支示例中的 `version = "*"`。
本次查询 docs.rs 显示 portable-pty 0.9.0、alacritty_terminal 0.26.0；这不是最终选定版本。
主分支 README 可能领先发布版本，必须与实际锁定版本的 API 和最低系统要求交叉核对。

- [1] [Tauri 架构与 WKWebView](https://github.com/tauri-apps/tauri#introduction)
- [2] [Tauri 官方 ARM64 CI 示例](https://github.com/tauri-apps/tauri-action)；[Rust Apple Silicon 目标](https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html)
- [3] [xterm.js 功能与组件边界](https://github.com/xtermjs/xterm.js)
- [4] [GPUI README：Metal、版本与平台要求](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)
- [5] [SwiftUI 与 AppKit 集成](https://developer.apple.com/swiftui/)
- [6] [Rust FFI：ABI、所有权和安全边界](https://doc.rust-lang.org/nomicon/ffi.html)
- [7] [Iced 官方项目](https://github.com/iced-rs/iced)
- [8] [egui 官方项目](https://github.com/emilk/egui)
- [9] [russh 与 SFTP 生态](https://github.com/Eugeny/russh)
- [10] [portable-pty API](https://docs.rs/portable-pty/latest/portable_pty/)
- [11] [alacritty_terminal API](https://docs.rs/alacritty_terminal/latest/alacritty_terminal/)
- [12] [vt100 官方项目](https://github.com/doy/vt100-rust)
- [13] [Tauri Channel 与事件系统区别](https://v2.tauri.app/develop/calling-frontend/#channels)
- [14] [xterm.js 流控指南](https://xtermjs.org/docs/guides/flowcontrol/)
- [15] [xterm.js 安全指南](https://xtermjs.org/docs/guides/security/)
- [16] [Tauri 分发与 macOS 签名、公证](https://v2.tauri.app/distribute/)
- [17] [WindTerm 官方功能说明](https://github.com/kingToolbox/WindTerm#features)；[2.7.0 发布基线](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0)。当前 README 需与该版本实测交叉核对。
