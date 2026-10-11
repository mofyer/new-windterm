# 跨平台架构与验收计划

状态：P0 进行中，2026-10-11。**macOS、Windows、Linux 从当前阶段共同作为架构目标；Apple Silicon 优先验证和交付。** 后续平台通过适配层接入同一核心，不在 macOS 产品完成后另写一套协议与业务逻辑。

当前 macOS arm64 有本机原生与 PTY 证据，Linux Bash/Unix PTY 已有 hosted 编译和运行记录；Windows 已有历史编译/链接、平台拒绝策略及当前有限 loopback SSH 协议测试证据，ConPTY 尚未实现。Windows 的阻塞读取消、子进程回收和真实探针门槛见[P0 ConPTY 决策记录](p0/WINDOWS_CONPTY_ADR.zh-CN.md)。依赖支持、代码适配、CI 编译与实机运行必须分开记录，不能直接宣称三端可用。完整范围按[功能矩阵](FEATURE_PARITY.zh-CN.md)跟踪：当前 130 项，完整基线尚未冻结。
当前轮交互 SSH 已通过浏览器契约、macOS Rust 独立复验及 WKWebView 有限命令冒烟；PTY readiness 仍是默认关闭的实验，原生高输出性能未验收。最终提交 `8ee49a4` 的 CI 三端检查、链接、SSH target 通过，Mac/Linux 默认与 readiness PTY 通过；Windows PTY 仍跳过。前两次失败及最小修订均保留，不能将最终 CI 成功当作三端 GUI 或完整功能验收。历史 macOS 总期限失败、修订成功及各轮范围保留在[跨平台验证](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md)，最新验收统一见 [P0 结果](p0/RESULTS.zh-CN.md)。

## 共享核心与平台边界

| 层 | 共同职责 | 平台差异的放置位置 |
| --- | --- | --- |
| 会话与任务核心 | 生命周期、取消、超时、状态、ACK/背压、权限检查与稳定错误类型 | 不依赖 AppKit、Win32、具体 shell 或文件描述符；由适配器提供资源操作 |
| 协议核心 | SSH/SFTP/SCP、Telnet/Raw TCP、代理/转发、tmux 解析及传输状态 | 系统 agent、GSSAPI、外部 OpenSSH 进程等走独立接口，不能硬编码 Unix socket/命令路径 |
| 终端与前端 | 字节流、终端状态、布局、命令 ID、功能入口及测试样本 | 系统快捷键、菜单、窗口、字体与 WebView 能力通过平台配置处理 |
| 系统适配 | PTY、shell、凭据库、文件系统、串口、安装与系统集成 | 按 macOS/Windows/Linux 实现并分别验证；不支持时返回明确能力状态 |

这些是模块边界要求，不要求立即拆成多个 crate。当前代码集中在 `apps/desktop`；先消除跨层平台假设，再按实际复杂度拆分。协议原始字节、取消语义和错误事件应共享，不在 UI 内复制三套业务流程。

## PTY、shell 与凭据

| 能力 | macOS | Windows | Linux | 共同验收 |
| --- | --- | --- | --- | --- |
| PTY | Unix PTY 适配，宿主与 hosted 修订分别记录 | ConPTY 适配待实现，当前明确拒绝 | Bash + Unix PTY，已有 Ubuntu hosted 探针记录 | 输入/输出完整性、resize、Ctrl-C、退出码、背压、关闭与无残留 |
| shell 发现 | 检测可用 zsh/bash/PowerShell Core 等 | 检测 Cmd、Windows PowerShell/PowerShell；管理员模式独立授权 | 检测 bash/zsh/PowerShell Core 等 | 显示实际路径与可用状态；参数使用结构化 argv，缺失明确报错，不拼接 shell 字符串 |
| 凭据库候选 | Keychain | Credential Manager | Secret Service | 写入、读取、删除、锁定、取消和不可用；失败不得静默退回明文 |

现有 P0 shell 是受限测试配置，不是最终 shell 发现策略；不得把固定 `/bin/zsh`、`/tmp`、Unix 环境变量或 `fcntl` 传播到共享核心。Windows 的输入与终止策略不能直接套用 Unix 信号；ConPTY 的创建、缩放、关闭与管道生命周期需单独实现和测试。[Microsoft ConPTY 说明](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)

平台规则位于 `apps/desktop/src-tauri/src/platform.rs`，共享 UUID、窗口归属、页面代次与 ACK 状态保留。第二轮 Linux 检查 Bash 后使用隔离参数、环境和系统临时目录，复用 Unix I/O；Windows 仍在分配 PTY 前返回待适配错误。`libc` 限于 Unix target。历史第二轮 Mac 的 12 项单测含 Linux 命令策略检查，其本身不能证明 Linux 已运行；当轮另取得 Linux runner 的编译与真实 PTY 回执，以及 Windows runner 的编译和拒绝策略回执。Windows 真实 PTY 仍未实现。

凭据适配器只向业务层提供受控操作及引用，普通配置不保存秘密。Linux 须检测会话服务是否存在及是否锁定；未安装服务时可保持本次会话不保存凭据，并明确提示。三个候选均需锁定 Rust 接入库和核查授权，当前不声称已经接通。[Apple Keychain](https://developer.apple.com/documentation/security/keychain-services) · [Windows Credential Management API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/) · [Secret Service 规范](https://specifications.freedesktop.org/secret-service/latest/)

## WebView、键盘与文件系统

Tauri 在 macOS 使用 WKWebView，Windows 使用 WebView2，Linux 使用 WebKitGTK；浏览器 E2E 可以复用，但必须补各原生运行时的字体、IME、剪贴板、焦点及辅助功能验证。[Tauri WebView 文档](https://v2.tauri.app/reference/webview-versions/)

- **快捷键**：共享命令 ID 与动作，按平台映射 Cmd/Ctrl，终端焦点下保留 Ctrl-C 等控制序列；测试应用菜单、终端模式与本地编辑模式的冲突。Windows/Linux 使用本地窗口控制，不复制 Mac 按钮。
- **路径**：本地路径使用平台路径类型，区分盘符、UNC、分隔符、大小写及 Unicode；远端路径依据协议/远端语义处理，不能用本机路径规则改写。所有路径操作验证权限与目标归属。
- **权限与链接**：分别处理 Unix mode/可执行位、Windows 权限与链接语义，覆盖拒绝访问、符号链接和名称冲突；不能声称跨平台无损保留不存在的属性。
- **换行与编码**：终端和二进制文件默认保留原始字节，不能全局执行 LF/CRLF 转换。文本导出或显式转换单独配置；验证中文、空格、组合字符及不同本地编码边界。
- **串口**：共享配置模型，设备枚举、权限、名称、驱动及拔插行为由平台适配；每个平台用真实设备或回环夹具验证，PTY 不替代串口驱动测试。
- **运行环境**：Linux 记录发行版、桌面会话、X11/Wayland 和 WebKitGTK 版本；Windows 记录 WebView2 与 shell 版本；macOS 记录系统与 WKWebView 版本。系统升级后保留回归记录。

## CI 与实际验收

下表仍包含后续验收计划，不是三端产品验收通过记录。第二轮已新增 `.github/workflows/p0-cross-platform.yml`：macos-15、ubuntu-24.04、windows-2022，固定工具链与锁文件，Unix 执行真实 PTY 探针、Windows 执行拒绝策略。历史修订后的运行已成功；当前轮已增加 loopback SSH 协议集成与 Unix 两种 PTY 策略，执行状态、逐项范围和原失败见[专项报告](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md)。

| 通道 | macOS | Windows | Linux | 通过意味着什么 |
| --- | --- | --- | --- | --- |
| 共享检查 | Rust fmt/check/test/clippy，前端类型与构建 | 同左 | 同左 | 对应目标的代码检查通过；不等于运行验收 |
| 本地 PTY 集成 | arm64 原生 runner 优先 | 选定 Windows runner 上实际执行 ConPTY | 选定发行版 runner 上实际执行 PTY | 本平台的字节、生命周期和故障样本通过 |
| 协议夹具 | SSH/SFTP 与转发受控对端 | 同一行为用例和断言 | 同一行为用例和断言 | 对应客户端与服务端证据一致；未覆盖用例明确标记 |
| 浏览器回归 | 可复用现有 E2E | 可复用同一套入口测试 | 可复用同一套入口测试 | 浏览器交互结果，不替代原生 WebView |
| 桌面实机 | WKWebView、IME、快捷键与辅助功能 | WebView2、IME、提权、快捷键与辅助功能 | WebKitGTK、IME、桌面会话与权限 | 记录实际设备的适用功能；不可跨平台继承结论 |
| 安装与升级 | app/DMG 候选 | EXE/MSI 候选 | DEB/RPM/AppImage 候选 | 仅经过安装、升级、卸载及安全验证的具体包可发布 |

每项记录分开标注：`实现状态`、`目标平台`、`宿主实测`、`CI 构建/运行`、`原生 UI`、`安装包验收`、`未覆盖项`。证据应包含提交、操作系统、CPU 架构、运行时、命令、结果与脱敏工件；编译成功、交叉编译成功、远程 CI 成功与本机实际运行不得混写。

当前宿主证据见 [PTY 记录](p0/PTY_PROBE.zh-CN.md)及 [P0 结果](p0/RESULTS.zh-CN.md)。本计划不会把当前 Unix 实现推断为 Linux 已验证，更不会因 portable-pty 提供 ConPTY 接口而宣布 Windows 已支持。

## 打包与阶段门槛

macOS 的 `.app`/DMG、Windows 的 EXE/MSI、Linux 的 DEB/RPM/AppImage 先作为候选形式，按用户安装体验、系统依赖、签名和升级路径完成选型。需逐个验证新安装、运行时依赖、升级、卸载与配置保留；macOS 签名公证、Windows 签名及 Linux 分发校验分别制定，当前没有三端正式发行包。[Tauri 分发文档](https://v2.tauri.app/distribute/)

不在本轮承诺最低 macOS/Windows 版本、Linux 发行版集合或全部 CPU 架构。Apple Silicon arm64 是已优先运行的方向，其余目标需完成依赖、工具链、构建与实机验证后写入支持矩阵；配置中的编译下限不等于支持声明。

P0 即开始共享核心审计、平台接口和 CI 矩阵，优先消除 macOS 假设；P1–P4 新能力同步保留三端适配与测试路径；P5 集中完成各平台兼容和发行验收。允许按平台分批交付，不允许把 Windows/Linux 留成事后另写项目。详见[总体架构](ARCHITECTURE.zh-CN.md)和[路线图](ROADMAP.zh-CN.md)。
