# WindTerm 完整功能对齐矩阵

基线：WindTerm 2.7.0 实际行为。下表从[该版本 README](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#features)逐项展开，尚未完成上游实机盘点；README 描述不能代替行为验收。每项测试记录应包含 ID、上游步骤与结果、本项目步骤与结果、平台、版本和证据。目前尚无条目完成全项对齐验收；已有局部 UI 与真实本地 PTY 原型，见[P0 结果](p0/RESULTS.zh-CN.md)。

对齐要求覆盖功能语义、安全与操作效率，不要求旧界面像素一致。采用[现代苹果风设计](DESIGN.zh-CN.md)，新入口映射到现有功能 ID，保持可搜索、可键盘触达；不得以视觉简化为由隐藏或删除能力。功能验收与视觉验收分别记录，原始 117 个 ID 保持不变；第二轮 P0 新增 13 个稳定 ID，当前共追踪 **130 项**，仍未完整冻结。

下表保留初始规划状态：“未实现”表示尚未交付可按该行完整验收的功能；“待实测”表示上游文档存在冲突或能力边界尚不明确。局部原型不将整行标为完成。证据分为产品实测支持、文档宣称或矛盾待核、路线图未确认三类；P0 的有限入口观察另记于[基线台账](p0/BASELINE.zh-CN.md)，不因出现在路线图就认定产品没有该功能。P0 已把入口观察和默认资源发现补为下方独立新增 ID；其行为边界仍须实测，后续继续补齐遗漏。阶段对应[实施路线](ROADMAP.zh-CN.md)，不是删减范围；P5 对所有适用平台重新验收。

各表末列“证据索引”只做索引（2026-10-11 建立，2026-10-12 按其后合入的原型刷新），三部分含义如下：

- **静态**：链接[上游静态复核](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md)对该行的结论（支持、部分、矛盾或沉默）。
- **P0**：标明当前原型或探针记录属于哪一组（原型/探针、仅静态、皆无），并链接对应文档。
- **待决**：链接[基线冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md)中需要用户决定的措辞。

该列不改变“状态”列；原型或探针有运行证据，也不代表该行对齐或验收通过。三处台账的索引必须一致，见[结构验证](p0/BASELINE_EVIDENCE.zh-CN.md#结构验证)。

## 协议、认证、代理与转发

来源：[README 协议功能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#ssh-telnet-tcp-shell-serial-tmux)、[会话功能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#session)。

| ID | 能力 | 阶段 | 验收要点 | 状态 | 证据索引 |
| --- | --- | --- | --- | --- | --- |
| C01 | SSH v2 | P2 | 交互、缩放、退出码、断线状态；首次主机密钥确认和变化拒绝 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_TERMINAL](p0/SSH_TERMINAL.zh-CN.md#验证与未验收项)、[OPENSSH_INTERACTIVE](p0/OPENSSH_INTERACTIVE.zh-CN.md#rust-ssh_open-互操作)、[RESULTS](p0/RESULTS.zh-CN.md#持久化主机信任) |
| C02 | Telnet | P2 | 协议协商、交互和断线；匹配上游配置项 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [NET_TERMINAL](p0/NET_TERMINAL.zh-CN.md#证据)、[TRANSPORTS](p0/TRANSPORTS.zh-CN.md#telnetc02)、[NET_TERMINAL](p0/NET_TERMINAL.zh-CN.md#真实-telnetd-互操作2026-10-12) |
| C03 | Raw TCP | P2 | 双向字节流、编码及关闭行为 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [NET_TERMINAL](p0/NET_TERMINAL.zh-CN.md#证据) |
| C04 | 串口 | P2 | 设备枚举、波特率等串口配置、读写和拔插 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：仅静态，另有方案记录 [TRANSPORTS](p0/TRANSPORTS.zh-CN.md#串口c04)（无运行证据） |
| C05 | SSH 认证后自动执行 | P2 | 显式启用、执行顺序、失败及重连策略；不误重放输入 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：仅静态 |
| C06 | SSH ControlMaster | P2 | 复用连接、主从生命周期及退出隔离 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [CONTROLMASTER_ADR](p0/CONTROLMASTER_ADR.zh-CN.md#证据) |
| C07 | ProxyCommand | P2 | 命令参数、代理进程关闭和错误反馈 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#经代理连接与-proxycommandc07c19c20)、[SSH_ROUTES](p0/SSH_ROUTES.zh-CN.md#证据macos-arm64本地) |
| C08 | ProxyJump | P2 | 跳转链路、逐跳认证和失败定位 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_ROUTES](p0/SSH_ROUTES.zh-CN.md#证据macos-arm64本地) |
| C09 | SSH agent | P2 | agent 发现、选钥、不可用和取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [RESULTS](p0/RESULTS.zh-CN.md#ssh-认证方式) |
| C10 | agent forwarding | P2 | 明确授权、转发可用、关闭后失效 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#远端转发与-agent-转发c17c10) |
| C11 | 密码认证及自动登录 | P2 | 正误密码、取消、可选安全保存和再次登录 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [RESULTS](p0/RESULTS.zh-CN.md#ssh-认证方式) |
| C12 | 公钥认证及自动登录 | P2 | 带口令/无口令密钥、错误密钥及安全存储 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [RESULTS](p0/RESULTS.zh-CN.md#ssh-认证方式)、[OPENSSH_INTERACTIVE](p0/OPENSSH_INTERACTIVE.zh-CN.md#rust-ssh_open-互操作) |
| C13 | keyboard-interactive | P2 | 多轮提示、隐藏输入和取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_KBDINT](p0/SSH_KBDINT.zh-CN.md#证据macos-arm64本地) |
| C14 | gssapi-with-mic | P0→P2 | 2.7 UI选项可见；README与延期路线图冲突未解，需受控KDC、票据与认证结果核对，不能用默认勾选代替成功认证 | 待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：仅静态，另有方案记录 [X11_GSSAPI_ADR](p0/X11_GSSAPI_ADR.zh-CN.md#gssapigssapi-with-micc14)（无运行证据）；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a4-c14gssapi-已随发布包链接) |
| C15 | X11 forwarding | P2 | 本地 X 服务依赖、远端窗口与连接清理 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：仅静态，另有方案记录 [X11_GSSAPI_ADR](p0/X11_GSSAPI_ADR.zh-CN.md#x11-转发c15)（无运行证据） |
| C16 | 本地/直接端口转发 | P2 | 监听地址、端到端通信、端口冲突及停止 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) |
| C17 | 远端/反向端口转发 | P2 | 远端监听、服务端限制及关闭 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#远端转发与-agent-转发c17c10)、[SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) |
| C18 | 动态端口转发 | P2 | SOCKS 流量、目标解析、错误和停止 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) |
| C19 | HTTP 代理 | P2 | 代理连接、认证、拒绝和断线 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#经代理连接与-proxycommandc07c19c20)、[SSH_ROUTES](p0/SSH_ROUTES.zh-CN.md#证据macos-arm64本地) |
| C20 | SOCKS5 代理 | P2 | 代理认证、地址解析和不可达反馈 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#经代理连接与-proxycommandc07c19c20)、[SSH_ROUTES](p0/SSH_ROUTES.zh-CN.md#证据macos-arm64本地) |
| C21 | Jump Server 会话代理 | P2 | 可复用跳板会话配置、认证链及生命周期 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发)；P0：原型/探针 [SSH_FORWARDING](p0/SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_ROUTES](p0/SSH_ROUTES.zh-CN.md#证据macos-arm64本地) |

## 本地 Shell、终端与 tmux

来源：[README 协议功能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#ssh-telnet-tcp-shell-serial-tmux)、[终端功能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#term)、[tmux 集成说明](https://kingtoolbox.github.io/2025/01/05/tmux-integration/)。

| ID | 能力 | 阶段 | 验收要点 | 状态 | 证据索引 |
| --- | --- | --- | --- | --- | --- |
| T01 | macOS bash/zsh/PowerShell Core | P1 | 各 shell 启动、PTY、环境、缩放和退出；提示未安装依赖 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [PTY_PROBE](p0/PTY_PROBE.zh-CN.md#已执行检查)、[RESULTS](p0/RESULTS.zh-CN.md#当前轮原生-pty-数据路径冒烟) |
| T02 | Linux bash/zsh/PowerShell Core | P5 | 各 shell 的 PTY、信号和生命周期 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [CROSS_PLATFORM_VALIDATION](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md#平台边界) |
| T03 | Windows Cmd | P5 | 命令交互、编码、窗口缩放和退出 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [WINDOWS_CONPTY_ADR](p0/WINDOWS_CONPTY_ADR.zh-CN.md#实现结果更新)、[CROSS_PLATFORM_VALIDATION](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md#windows-conpty-生命周期工作分支第六次尝试通过)、[WINDOWS_CONPTY_ADR](p0/WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位) |
| T04 | Windows PowerShell | P5 | 交互、渲染、环境和退出 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T05 | Windows 管理员 Cmd | P5 | 明确提权、授权取消及权限隔离 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T06 | Windows 管理员 PowerShell | P5 | 明确提权、授权取消及权限隔离 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T07 | VT100 | P1 | 针对该模式的控制序列和 vttest 用例 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#按终端类型的结论) |
| T08 | VT220 | P1 | 针对该模式的控制序列和 vttest 用例 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#按终端类型的结论) |
| T09 | VT340 | P1 | 图形/控制序列支持边界与上游逐项对照 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#图形)、[TERMINAL_CORE_ADR](p0/TERMINAL_CORE_ADR.zh-CN.md#原型) |
| T10 | VT420 | P1 | 针对该模式的控制序列和 vttest 用例 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#按终端类型的结论) |
| T11 | VT520 | P1 | 针对该模式的控制序列和 vttest 用例 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#按终端类型的结论) |
| T12 | xterm | P1 | 控制序列、备用屏幕和应用交互 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#按终端类型的结论)、[VT_MATRIX](p0/VT_MATRIX.zh-CN.md#osc-52-剪贴板)、[INPUT_PATHS](p0/INPUT_PATHS.zh-CN.md#按键input-keysspects12-项) |
| T13 | xterm-256-colors | P1 | TERM 设置、256 色及应用颜色输出 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#sgr-与颜色) |
| T14 | Unicode 13 与宽字符 | P1 | 中英文、组合字符、列宽、选区和光标 | 未实现 | 静态：[沉默](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#unicode-列宽回归与-ipc-契约审查)、[INPUT_PATHS](p0/INPUT_PATHS.zh-CN.md#探针覆盖与结论)；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#c1-t14-unicode-13-与宽字符) |
| T15 | emoji | P1 | 字形回退、组合 emoji、宽度和复制 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#unicode-列宽回归与-ipc-契约审查)、[OPENSSH_INTERACTIVE](p0/OPENSSH_INTERACTIVE.zh-CN.md#rust-ssh_open-互操作)、[INPUT_PATHS](p0/INPUT_PATHS.zh-CN.md#宽字符input-widespects27-项) |
| T16 | true-color | P1 | 24 位颜色与重绘一致 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#sgr-与颜色) |
| T17 | 终端鼠标协议 | P1 | 点击、拖动、滚轮、应用捕获与释放 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#鼠标与焦点) |
| T18 | 自动换行模式 | P1 | 边界列、长行、开关和窗口缩放 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#自动换行与反向换行) |
| T19 | 自定义协议 | P0→P2 | 实测上游扩展入口、配置格式和行为，再建立等价接口 | 待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T20 | 自定义终端类型 | P0→P1 | 实测配置入口及可定制范围，验证序列行为 | 待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#适配钩子可行性公开-api)、[VT_MATRIX](p0/VT_MATRIX.zh-CN.md#终端类型与身份回复) |
| T21 | vttest 兼容范围 | P1 | 对照上游宣称的除 Tektronix 4014 外测试范围，逐项保存差异 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#阻断-windterm-对齐的缺口) |
| T22 | tmux 集成 | P4 | 按官方演示盘点窗口/窗格映射、同步和重连，区别于仅运行 tmux | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [TMUX_CONTROL](p0/TMUX_CONTROL.zh-CN.md#实测) |
| T23 | Powerline / Oh-My-Zsh | P1 | Linux/macOS 提示符、图标和列宽 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T24 | Powerline / Oh-My-Posh | P1/P5 | PowerShell 提示符、字体及多平台布局 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |

## 文件传输与本地文件管理

来源：[README 文件功能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#ssh-telnet-tcp-shell-serial-tmux)、[官方传输说明](https://kingtoolbox.github.io/tags/transfer/)。

| ID | 能力 | 阶段 | 验收要点 | 状态 | 证据索引 |
| --- | --- | --- | --- | --- | --- |
| F01 | SFTP 文件浏览 | P3 | 目录、属性、权限、中文/空格路径和错误 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SSH_SFTP_FIXTURE](p0/SSH_SFTP_FIXTURE.zh-CN.md#真实-openssh-验收)、[RESULTS](p0/RESULTS.zh-CN.md#只读-sftp-文件面板闭环) |
| F02 | SFTP 下载 | P3 | 文件完整性、覆盖确认、取消及部分文件状态 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SFTP_WRITE](p0/SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) |
| F03 | SFTP 上传 | P3 | 文件完整性、覆盖确认、取消及部分文件状态 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SFTP_WRITE](p0/SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) |
| F04 | SFTP 删除 | P3 | 文件/目录类型、明确确认和权限失败 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SFTP_WRITE](p0/SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) |
| F05 | SFTP 重命名 | P3 | 冲突、中文路径和失败反馈 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SFTP_WRITE](p0/SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) |
| F06 | SFTP 新建文件 | P3 | 内容/空文件、权限及名称冲突 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SFTP_WRITE](p0/SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) |
| F07 | SFTP 新建目录 | P3 | 权限、名称冲突及刷新 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SFTP_WRITE](p0/SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) |
| F08 | SCP 下载 | P3 | 协议兼容、路径和完整性、取消 | 未实现 | 静态：[矛盾](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SSH_SFTP_FIXTURE](p0/SSH_SFTP_FIXTURE.zh-CN.md#scpf08f09)；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a2-f08f09scp-是否属于-27-实际功能) |
| F09 | SCP 上传 | P3 | 协议兼容、路径和完整性、覆盖 | 未实现 | 静态：[矛盾](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [SSH_SFTP_FIXTURE](p0/SSH_SFTP_FIXTURE.zh-CN.md#scpf08f09)；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a2-f08f09scp-是否属于-27-实际功能) |
| F10 | XModem | P3 | 收发、校验、失败重试及取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [MODEM](p0/MODEM.zh-CN.md#已验证) |
| F11 | YModem | P3 | 收发、批量和文件元信息、取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：原型/探针 [MODEM](p0/MODEM.zh-CN.md#已验证) |
| F12 | ZModem | P3 | 收发协商、终端切换、完整性及取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态，另有方案记录 [MODEM](p0/MODEM.zh-CN.md#adrzmodemf12)（无运行证据） |
| F13 | 本地文件浏览 | P3 | 目录、属性、中文路径和权限 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F14 | 本地文件移动 | P3 | 目标、冲突确认及失败不误报 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F15 | 本地文件复制到目标 | P3 | 完整性、冲突和取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F16 | 本地文件从来源复制 | P3 | 来源选择、完整性及权限 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F17 | 本地删除 | P3 | 确认、权限和上游删除语义盘点 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F18 | 本地重命名 | P3 | 冲突、中文路径及刷新 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F19 | 本地新建文件 | P3 | 名称、权限及冲突 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F20 | 本地新建目录 | P3 | 名称、权限及冲突 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态 |
| F21 | 传输的其他实际选项 | P0→P3 | 盘点递归、续传等是否真实存在；确认后拆分为独立 ID | 待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理)；P0：仅静态；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a6-其他需要同步决定的措辞) |

## GUI 与工作流

来源：[README GUI 功能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#gui)。具体功能的官方演示链接见该段；验收时固定版本行为，不能仅凭同名控件判定通过。

| ID | 能力 | 阶段 | 验收要点 | 状态 | 证据索引 |
| --- | --- | --- | --- | --- | --- |
| G01 | 多语言界面 | P4 | 盘点上游语言，切换、回退及布局无截断 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G02 | 自动补全 | P4 | 来源、候选、选择、取消；敏感输入不收集 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a5-g02自动补全已有完整资源) |
| G03 | Free Type 模式 | P4 | 按官方演示验证编辑与发送边界 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [FREE_TYPE](p0/FREE_TYPE.zh-CN.md#实测headless-chrome真实键盘事件) |
| G04 | Focus 模式 | P4 | 进入退出、面板状态和快捷键 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G05 | 同步输入 | P4 | 目标集合清晰、显式启用、退出和断线隔离 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G06 | 用户名/密码保护 | P4 | 遮罩、保存与解锁；秘密不进明文或日志 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G07 | 命令面板 | P4 | 搜索、执行、快捷键和焦点返回 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围) |
| G08 | 命令发送器 | P4 | 编辑、目标、发送与取消；按上游实测拆分细项 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G09 | Explorer 面板 | P4 | 导航、展开折叠、定位及会话联动 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G10 | Shell 面板 | P4 | 面板开关、实例生命周期与焦点 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G11 | Quick Bar | P4 | 配置、调用、持久化及快捷操作 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G12 | 粘贴对话框 | P4 | 多行预览、编辑、确认、取消和换行处理 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G13 | 本地/远程输入模式 | P4 | Shift+Enter 切换，当前模式可见且输入不误发送 | 未实现 | 静态：[矛盾](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a1-g13本地远程模式快捷键) |
| G14 | Vim 键位 | P4 | 本地编辑、导航及模式切换，匹配上游键表 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G15 | 时间戳 | P4 | 显示、开关、格式和日志关联 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G16 | 文本折叠 | P4 | 折叠展开、搜索及复制边界 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [FOLDING](p0/FOLDING.zh-CN.md#实测headless-chrome) |
| G17 | 大纲 | P4 | 结构生成、导航与输出更新 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [FOLDING](p0/FOLDING.zh-CN.md#实测headless-chrome)；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a6-其他需要同步决定的措辞) |
| G18 | 分屏 | P4 | 创建、关闭、缩放、焦点和会话隔离 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围) |
| G19 | 输出配色方案 | P4 | 配色规则、切换、持久化与渲染 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G20 | 文本搜索 | P4 | 命中、跳转、范围及历史输出 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [HISTORY_ARCHIVE](p0/HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机)、[FOLDING](p0/FOLDING.zh-CN.md#实测headless-chrome) |
| G21 | 搜索预览 | P4 | 上下文预览、定位与主视图一致 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G22 | 配对分隔符高亮 | P4 | 圆/方/花括号匹配及不配对情况 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G23 | 自定义分隔符 | P4 | 配置、匹配及持久化 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G24 | UI 主题 | P4 | 切换、系统缩放、各面板和可读性 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#最终白银浮层配色与正文对比度) |
| G25 | 标签颜色 | P4 | 设置、区分和恢复 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G26 | 已打开标签搜索 | P4 | 搜索、选择和焦点切换 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G27 | 关闭右侧标签 | P4 | 正确范围、连接关闭及未完成操作提示 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G28 | 窗口透明度 | P4 | 调节、重启恢复及平台行为 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G29 | 选择即复制 | P4 | 选区、剪贴板、开关及应用鼠标模式冲突 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G30 | 右键粘贴 | P4 | 设置、菜单冲突与粘贴安全确认 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G31 | 中键粘贴 | P4 | 平台支持、设置及内容正确 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G32 | 在线文本搜索 | P4 | Google/Bing/GitHub/StackOverflow/Wikipedia/DuckDuckGo 地址编码与用户主动触发 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G33 | 输入时隐藏鼠标指针 | P4 | 输入隐藏、移动恢复和设置 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a6-其他需要同步决定的措辞) |
| G34 | 锁屏 | P4 | 锁定、解锁、隐藏秘密和后台连接行为 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |

## 会话、平台与性能

来源：[README 会话](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#session)、[GUI](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#gui)、[性能](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#performance)。

| ID | 能力 | 阶段 | 验收要点 | 状态 | 证据索引 |
| --- | --- | --- | --- | --- | --- |
| S01 | 会话配置对话框 | P2/P4 | 创建、编辑、校验及每协议配置项盘点 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围)、[UI_MAP](p0/UI_MAP.zh-CN.md#已实现的原型行为) |
| S02 | 会话树与分组 | P4 | 层级管理、选择、持久化和批量行为盘点 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S03 | 会话重命名 | P4 | 冲突、引用和持久化 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S04 | 会话复制 | P4 | 独立配置、命名和凭据引用策略 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S05 | 手动会话日志 | P4 | 开始停止、保存路径、内容和秘密过滤 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S06 | 自动会话日志 | P4 | 配置、命名、断线和重连边界 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S07 | 重启恢复会话 | P4 | 保存、选择、恢复失败与不自动重放输入 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S08 | 重启恢复布局 | P4 | 分屏、标签和面板位置 | 未实现 | 静态：[沉默](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：皆无；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#c2-s08-重启恢复布局) |
| S09 | 启动指定单会话 | P4 | 配置、认证和失败提示 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S10 | 启动指定会话集合 | P4 | 集合、顺序、局部失败和取消 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S11 | 会话搜索 | P0→P4 | 2.7 路线图标延期；与已打开标签搜索区分，实测确定基线 | 待实测 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [WEB_QA](p0/WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围)；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a6-其他需要同步决定的措辞) |
| Q01 | macOS 平台 | P5 | 全部适用项真机回归，arm64 依赖、安装和签名公证 | 未实现 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [PERFORMANCE_BASELINE](p0/PERFORMANCE_BASELINE.zh-CN.md#3-桌面应用release-包)、[RESULTS](p0/RESULTS.zh-CN.md#当前轮原生交互-ssh-冒烟)、[RELEASE](p0/RELEASE.zh-CN.md#4-本地验证) |
| Q02 | Windows 平台 | P5 | 全部适用项实机回归、安装与升级 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [CROSS_PLATFORM_VALIDATION](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md#windows-conpty-生命周期工作分支第六次尝试通过)、[WINDOWS_CONPTY_ADR](p0/WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位) |
| Q03 | Linux 平台 | P5 | 确定发行版矩阵，全部适用项回归、包和升级 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [CROSS_PLATFORM_VALIDATION](p0/CROSS_PLATFORM_VALIDATION.zh-CN.md#平台边界) |
| Q04 | 动态内存压缩 | P1 | 压缩/解压后内容、搜索一致，固定负载测量空间和 CPU | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [HISTORY_ARCHIVE](p0/HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机) |
| Q05 | 吞吐与低延迟 | P0→P5 | 建立同负载基线和预算；持续输出背压、交互延迟和峰值内存 | 未实现 | 静态：[部分](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [PERFORMANCE_BASELINE](p0/PERFORMANCE_BASELINE.zh-CN.md#1-rust-pty-吞吐与-ctrl-c-延迟)、[PTY_READINESS](p0/PTY_READINESS.zh-CN.md#本机配对结果) |
| Q06 | 大规模滚动历史 | P0→P1 | 盘点上游容量行为，验证检索、压缩和资源上限，不静默丢数据 | 待实测 | 静态：[矛盾（弱）](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：原型/探针 [HISTORY_ARCHIVE](p0/HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机)；待决：[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a3-q06unlimited与默认-999999-行) |

## P0 第二轮新增追踪项（13 项，行为尚未验证）

来源：[隔离官方 2.7 默认资源与已有 UI 观察记录](p0/BASELINE_EVIDENCE.zh-CN.md)。T25–T29、G35–G40 共 **11 项入口已观察**；S12–S13 为 **2 项静态候选**（通用 Sysmon 入口可见，但本地/远端的分别入口尚未确认）。全部13项尚未完成上游行为测试，也未交付本项目对齐实现。稳定 ID 用于跟踪验收，不表示候选已经证实支持；若后续范围修正，保留 ID 和证据理由。

| ID | 能力 | 阶段 | 验收要点 | 状态 | 证据索引 |
| --- | --- | --- | --- | --- | --- |
| T25 | VT52 | P0→P1 | 同一隔离会话输出光标移动/直接地址/擦除/反向滚屏/图形字符集/设备标识序列，记录屏幕与回复字节；再验证方向键、小键盘及退出到ANSI后的状态 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [TERMINAL_COMPAT](p0/TERMINAL_COMPAT.zh-CN.md#验证) |
| T26 | VT102 | P0→P1 | 选择VT102，核对设备属性、插入/删除字符和行、光标/滚动区、键盘输出及vttest相关子项；与VT100分别保存差异 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：原型/探针 [VT_MATRIX](p0/VT_MATRIX.zh-CN.md#插入删除重复与-vt220vt420-编辑) |
| T27 | 终端 Bell 与节流设置 | P0→P1 | 发送单次与连续BEL；逐个实际样式检查声音/视觉行为、关闭、间隔节流、非活动标签与持久化；先盘点确有的样式 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T28 | Big5 会话字符编码 | P0→P1 | 输入输出分别验证已知Big5字节和中文样本、跨块多字节、不完整/非法序列、编码切换、复制搜索列宽；文件传输字节不经终端解码 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| T29 | EUC-JP 会话字符编码 | P0→P1 | 输入输出分别验证EUC-JP日文/半角假名样本、跨块多字节、不完整/非法序列、编码切换、复制搜索列宽；原始文件传输不损坏 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux)；P0：仅静态 |
| S12 | 本地 Shell Sysmon | P0→P4 | 确认Shell侧入口及支持平台，盘点实际指标、采样来源/间隔，核对受控本地负载变化、权限失败、关闭与会话退出清理 | 静态候选；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| S13 | SSH 远端 Sysmon | P0→P2/P4 | 确认SSH侧入口，盘点远端实际命令与指标；测试显式启用、权限不足/缺少命令、不支持系统、断线/重连、关闭后停止采样 | 静态候选；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能)；P0：仅静态 |
| G35 | Hex 编辑模式 | P0→P4 | 盘点Hex针对显示/本地草稿/发送中哪些对象；使用00/7f/80/ff及中文样本切换、编辑、撤销、复制与发送，在受控端核对原始字节 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G36 | 虚拟空间 | P0→P4 | 开启/关闭后在短行末尾与空行移动、选择、插入、撤销；验证填充语义、宽字符、换行和Hex模式限制以及持久化 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G37 | 多插入符号 / 多光标 | P0→P4 | 盘点光标创建/移除手势与快捷键，测试多点输入/删除/粘贴/撤销、选择重叠及取消；确认本地/远程输入发送次数和范围 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G38 | 全屏模式 | P0→P4/P5 | 菜单/快捷键进入与退出全屏，检查焦点、终端行列resize、分屏/侧栏布局、窗口恢复和macOS Spaces；其他平台分别验收 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G39 | 窗口总是置顶 | P0→P4/P5 | 开启后与普通窗口切换，关闭恢复层级；核对新窗口、重启持久化、全屏/Spaces及系统模态窗口的实际边界 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |
| G40 | 会话 Debug 模式 | P0→P4 | 在无秘密本地回显会话启停，盘点显示内容/控制序列表示、输出是否改写、保存行为和范围；退出后回到正常显示 | 入口可见；行为待实测 | 静态：[支持](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流)；P0：仅静态 |

VT52 与 VT102 分别验收，不能通过更改 TERM 名称或沿用 VT100 结果判定支持；现有 VT52 适配实验的有限结果见[终端兼容报告](p0/TERMINAL_COMPAT.zh-CN.md)，它不是上游行为验证，也未代表应用接入完成。Hex/多光标/虚拟空间须与 Free Type G03、本地/远程输入 G13 分别核对；全屏/置顶不能合并为专注模式 G04。编码条目针对会话终端字节，不把 SFTP/SCP 文件内容经文本转换。其他字符集仍待完整盘点，不因本轮只列两项而排除。

## 文档冲突与上游未实现路线图

[上游 2.7/2.x 路线图](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#roadmap-of-v27-february-2025-for-reference-only)将 GSSAPI、命令片段和会话搜索列为延期，其中 GSSAPI 又出现在功能支持声明中。GSSAPI 和会话搜索保留待实测项，不擅自宣称已有或删除。C14目前确认的是2.7认证UI入口；随仓库提供的libssh还有条件编译依赖，不能据此确认发布包已启用并成功调用。详见[证据与冲突范围](p0/BASELINE_EVIDENCE.zh-CN.md#c14-gssapi-证据范围)。

2026-10-11 的[上游静态复核](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#最重要的矛盾与张力)有以下补充：

- **C14**：主程序导入 GSSAPI 认证函数，随包 libssh 链接 Kerberos.framework。这在链接层面说明发布构建启用了 GSSAPI，但仍没有端到端认证记录。
- **G13、F08/F09、Q06**：README 中的 Shift+Enter 切换、SCP 客户端和“unlimited”回滚，与发布包静态证据冲突。

这些措辞是否调整，见[冻结提议](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md#a-矛盾与路线图不一致验收措辞选项)；本矩阵暂不修改。

Mosh、Rlogin、FTP、FTPS、外部工具、聊天模式、日志查看器、脚本、宏和插件系统属于上游路线图候选，不能直接标为 2.7.0 已实现能力。命令片段也先作为延期候选。Auto Complete 同时出现在功能与路线图中，已作为 G02 保留，具体行为待实测；静态复核显示发布包已有完整的 `terminal.autoComplete.*` 设置和命令定义资源。实机若确认候选中某项已存在，应补入基线并赋予独立 ID；否则后续另行排期。用户要求的“完整重构”针对已有功能，不能用这些候选替代已有功能的验收。

## 本项目必要的补充验收

上述对齐之外，还必须完成中文 IME、凭据安全存储、配置版本迁移、非秘密 WindTerm 配置导入预览与冲突处理、arm64 运行依赖、签名公证、安装升级和回退测试。详见[实施路线](ROADMAP.zh-CN.md)。不解密旧凭据；用户可重新提供凭据以恢复对应认证功能。
