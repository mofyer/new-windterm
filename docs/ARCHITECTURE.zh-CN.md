# 架构候选与原型验证

状态：用户已确认 Rust + Tauri 2 + xterm.js 与 Apache-2.0；具体依赖及性能待 P0 验证，尚未实现产品代码。
调研日期：2026-10-11。本文记录候选方案和验证要求，不构成性能或兼容性承诺。

## 目标与范围

- 首发平台为 macOS Apple Silicon M 系列；按阶段实现完整功能基线。
- Rust 承担网络、会话生命周期、文件传输与持久化业务核心。
- 最终目标是完整重构 WindTerm 2.7.0 的现有全部功能；macOS 首发，Windows、Linux 为后续必做阶段。
- 阶段交付不缩减总范围；以 2.7.0 实际行为、官方功能说明和逐项验收形成完整功能基线。
- 实际最低 macOS 版本由选定依赖和测试矩阵确定，暂不提前承诺。

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

| 模块 | 职责 | 不承担的职责 |
| --- | --- | --- |
| 桌面 UI | 会话树、标签、连接表单、传输队列、用户操作 | 私钥文件读取和长期凭据持久化 |
| xterm.js | 终端解析、屏幕状态、选择、滚动、输入事件 | 建立 SSH 连接或启动本地 shell |
| Rust 会话层 | 状态机、取消、超时、资源释放、会话 ID 与所属窗口校验 | 绘制终端字符 |
| Rust SSH 层 | 基于 russh 候选实现认证、主机密钥验证、PTY 请求、SSH channel | 把远端输出当作可信 UI 内容 |
| Rust SFTP 层 | 基于 russh-sftp 候选实现列目录、上传下载、进度、取消与失败反馈 | 默认静默覆盖或删除远端文件 |
| Rust 本地 PTY 层 | portable-pty 候选；支持原型验证及后续本地 shell | SSH 协议或终端模拟 |
| Rust 存储层 | 会话元数据、设置、迁移与凭据引用 | 在普通配置、日志和仓库中写入明文秘密 |

russh 是 SSH 协议库候选，不代表已覆盖 WindTerm 的全部 SSH/OpenSSH 行为；差距必须逐项验证。[9]
portable-pty 提供跨平台系统 PTY 接口；它不是终端模拟器。[10]
会话元数据可采用 SQLite 或版本化配置文件，P0 根据迁移、并发和备份需求选定。
凭据计划使用系统安全存储；具体 Rust 适配库、访问策略与失败行为待验证。

## 终端状态只保留一份

Tauri 路线由 xterm.js 持有权威终端屏幕状态，Rust 转发字节流与管理连接。
不要在 Rust 再维护一份 vt100/alacritty 屏幕，再与前端逐格同步。
如果选择纯 Rust UI，则改由 alacritty_terminal 持有终端状态，GUI 读取其网格绘制。
alacritty_terminal 提供网格、终端状态和选择等组件，不等于现成桌面终端 UI。[11]
vt100 可用于受控场景的屏幕快照或测试辅助，不作为完整现代终端能力的默认承诺。[12]
测试辅助解析器不能成为与生产终端状态竞争的第二个数据源。

## 字节流、顺序与背压

计划数据路径：SSH/PTY → Rust 有界队列 → Tauri Channel → xterm.write → ACK。
终端输出保留字节语义，避免按网络块独立转 UTF-8 导致跨块字符损坏。
每个会话独立维护序号、待确认字节数、上下水位及关闭状态。
达到高水位时暂停读取或等待容量，将背压传到 PTY/SSH；不得无限缓存或静默丢字节。
xterm 完成解析后回传累计 ACK，低于低水位再恢复生产；ACK 不混入用户输入。
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
| 历史与内存 | 大规模历史、搜索、动态压缩与布局恢复须联合验证；存档与索引可独立存储，但不维护第二套实时终端屏幕状态 |
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

测量启动时间、输入延迟、输出吞吐、CPU、内存与空闲耗电，并记录机器、系统和构建条件。
P0 产出是证据及组件可行性决定，涵盖上述全量关卡；不能通过缩减用户目标来宣布验证成功。
代码构建、签名、公证、安装与全新机器运行是不同验收阶段。[16]

## 建议目录结构（尚未创建）

```text
apps/desktop/             # 候选 Tauri + TypeScript UI
crates/session-core/      # 会话状态机与框架无关接口
crates/transport-ssh/     # russh 适配与主机信任
crates/transfer-sftp/     # 文件传输任务
crates/transport-pty/     # 本地 PTY 适配
crates/storage/           # 元数据迁移与安全存储适配
tests/fixtures/           # 终端、SSH、SFTP 验证样本
benchmarks/               # 可复现压力和资源测量
```

以上是结构建议，不表示这些目录、模块或测试已经存在；后续补充通用 transport、串口、调制解调传输与 tmux 模块。

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
