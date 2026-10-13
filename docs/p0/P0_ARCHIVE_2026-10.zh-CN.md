# P0 工作归档（2026-10-11 至 2026-10-13）

本文归档这一轮 P0 工作的进度、方案、过程和结论，便于用户回顾，也便于下一位接手者快速了解全貌。

每项能力的详细证据、测试计数和边界，以 [RESULTS](RESULTS.zh-CN.md) 和各专题文档为准；接手方式见[交接文档](../HANDOFF.zh-CN.md)。本文只做汇总和索引，不新增任何验收结论。

**不能误报的边界仍然有效**：P0 没有通过，WindTerm 功能没有对齐，产品不可用。下文的“完成”都是指原型或探针有了运行证据，不是验收通过。

## 1. 结论：P0 出口条件现状

| 出口条件（[路线图](../ROADMAP.zh-CN.md)） | 状态 | 依据 |
| --- | --- | --- |
| 依赖与许可证清单 | 完成 | [DEPENDENCIES](DEPENDENCIES.zh-CN.md) |
| 性能基线 | 完成；没有 WKWebView 数字 | [PERFORMANCE_BASELINE](PERFORMANCE_BASELINE.zh-CN.md) |
| 完整工作量估算 | 完成；只是估算，不是承诺 | [EFFORT_ESTIMATE](EFFORT_ESTIMATE.zh-CN.md) |
| 无法满足时的技术调整建议 | 完成 | [TERMINAL_CORE_ADR](TERMINAL_CORE_ADR.zh-CN.md)、[WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md)、[MODEM](MODEM.zh-CN.md) 的 ZMODEM 决策 |
| 用户确认界面与交互方向 | 完成 | [DESIGN_SYSTEM](DESIGN_SYSTEM.zh-CN.md) |
| 冻结功能基线 | 完成：2026-10-12 用户批准，共 161 个 ID | [冻结方案与决定记录](BASELINE_FREEZE_PROPOSAL.zh-CN.md) |
| 高风险能力有验证结论 | 大部分有；原生输入法、VoiceOver、macOS WKWebView、真实串口、签名公证尚缺 | 见第 5 节 |
| 实机差异记录 | 未完成：E1 已授权，但当前会话不能操作原生窗口 | [手工清单](HANDS_ON_CHECKLIST.zh-CN.md) |

截至 2026-10-13 的关键数字：

| 项目 | 数值 |
| --- | --- |
| 功能基线 | 161 个 ID |
| 有原型或探针证据的 ID | 67 个；其中真实对端 23、真实平台 7、loopback 夹具 8、浏览器 29 |
| 仅有静态证据的 ID | 93 个 |
| 两类证据都没有的 ID | 1 个（S08） |
| 集成分支 CI | 最近一次 [run 38230376894](https://github.com/mofyer/new-windterm/actions/runs/38230376894) 的六个作业全部通过：macOS、Linux、Windows Server 2022、Windows Server 2025，以及 Linux 和 Windows 的原生 WebView 冒烟 |
| `main` | 2026-10-12 经用户同意快进到 `e0dd423`；`main` 上的 CI（[run 38212737595](https://github.com/mofyer/new-windterm/actions/runs/38212737595)）通过 |
| `p0/integration` 领先 `main` | 7 个主线提交：冻结、E11、agent 转发互操作、lrzsz 修复、手工清单，以及相关文档 |

## 2. 进度时间线

时间为 2026-10-11 至 10-12 的本机时间。括号内是合并到 `p0/integration` 的主线提交。

### 阶段一（10-11 下午）：P0 主体原型

| 内容 | 提交 |
| --- | --- |
| 只读 SFTP 文件面板 | `107c012` |
| Rust `ssh_open` 对真实 OpenSSH shell | `35eeff4` |
| 持久化主机信任与密钥变化阻断 | `9df6721` |
| 密码、带口令私钥、agent 认证 | `daf7490` |
| bcrypt 轮数上限 | `c2fb850` |
| 压缩历史、折叠/大纲、Free Type 三个隔离 PoC | `e5f0c89`、`25de1a8`、`82027de` |
| tmux 控制模式解析 | `4c12dcc` |
| 本地、动态、跳板转发 | `760221c` |
| keyboard-interactive | `3238c3f` |
| 连接复用探针 | `97ad093` |
| HTTP/SOCKS5/ProxyCommand | `3a72716` |
| 远端与 agent 转发，以及服务端通道拒绝 | `e17cbb6` |
| Telnet 编解码 | `7cab5b8` |
| SCP 探针 | `56390e1` |
| Windows ConPTY 生命周期 | `fb57aa6` |

### 阶段二（10-11 晚）：评审修复与扩展

- **评审与安全修复**（`7e20e1d`）：Windows 评审修复；网络探针安全评审修复，包括远端转发通道上限 64、HTTP CONNECT 主机名校验、SCP 大小转换。
- **新合入的内容**：
  - 上游静态复核（`6a3be1f`）
  - Telnet / Raw TCP 标签（`8db62ae`）
  - 性能基线（`88f9393`）
  - XMODEM/YMODEM（`087a6a3`）
  - keyboard-interactive 实时提示（`eb7284a`）
  - VT 兼容矩阵（`1c89e83`）
- **Windows 句柄泄漏排查**：第一版检查失败；改为预热加稳定采样（`55a55a8`），再做分步诊断（`31532ae`）。

### 阶段三（10-12 凌晨）：P0 出口文档与根因定位

- 冻结方案与证据链接（`da0479b`）
- 终端内核调整 ADR 与隔离 SIXEL 原型（`13f49a9`）
- 工作量估算（`3f4b984`）
- release 包排除测试二进制，声明最低 macOS 13.3（`1849e67`）
- **ConPTY 句柄泄漏定位**（`d3917d8`）：泄漏来自 Windows Server 2022 系统自带的 ConPTY；Server 2025 上不泄漏；本项目代码不额外泄漏。

### 阶段四（10-12 上午）：功能原型与真实互操作

- 连接路线：代理、ProxyCommand、跳板（`d9ce55e`）
- SFTP 写操作原型（`166f6de`）
- 生产 VT 适配：设备身份、DECSCL、DECRQSS、CPR、OSC 52（`fb5d14c`）
- 端口转发界面（`b7d209e`）
- 输入路径：粘贴注入、分块 UTF-8 丢字、F 键默认动作等 7 个缺陷（`d7f318e`）
- 真实 telnetd 互操作（`7af6f5d`）
- lrzsz 互操作，以及 `zmodem2` 评估，结论是不采用（`2fa0a4c`）
- X11 转发探针（`69e9e2e`）
- 台账证据刷新（`519078e`）

### 阶段五（10-12 下午）：原生 WebView 与冻结

- **原生 WebView 冒烟**：经 tauri-driver 在 Linux WebKitGTK 和 Windows WebView2 上运行（`c78227b`、`2b336a9`）。
- **SFTP 面板内的 SCP 与按连接开启的 agent 转发**（`e602945`）。
- **`main` 快进到 `e0dd423`**，经用户同意。
- **基线冻结**：用户对 E1–E12 全部采用推荐选项，基线冻结为 161 个 ID（`894723a`）。
- **其它合入**：
  - E11：Windows/Linux 上游包静态核对（`96aa930`）；
  - agent 转发对 OpenSSH 的互操作；
  - lrzsz 0.12 的计时根因修复（`0f7d222`）。

### 阶段六（10-12 傍晚至 10-13）：待用户条件的事项

- 写了手工清单（`92d2cda`）。
- 隔离上游副本已准备好。
- 三个代理被会话用量上限中断，见第 5 节。

## 3. 方案与决策

### 技术方案结论

| 主题 | 结论 | 文档 |
| --- | --- | --- |
| Windows ConPTY 生命周期 | Job Object 回收进程树；等待线程在子进程退出后关闭 pseudoconsole；reader 排空 | [WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md) |
| ConPTY 句柄泄漏 | 系统组件问题，只出现在 Server 2022；可选缓解是随包分发新版 conpty.dll，需用户决定 | 同上，“句柄泄漏定位”一节 |
| 终端内核 | P1 前继续使用 xterm.js，按缺口分别处理；SIXEL 需要先评审 CSP `wasm-unsafe-eval` | [TERMINAL_CORE_ADR](TERMINAL_CORE_ADR.zh-CN.md) |
| ZMODEM | 不采用 `zmodem2`（损坏后失去同步、无边界、不处理 CAN）；按公开规范自研 | [MODEM](MODEM.zh-CN.md) |
| X11 | 不可信转发：线上发假 cookie，本地换成真 cookie；不生成受限 cookie | [X11_GSSAPI_ADR](X11_GSSAPI_ADR.zh-CN.md) |
| 发行 | 测试二进制由 `dev-tools` 门控；声明最低 macOS 13.3（未实测） | [RELEASE](RELEASE.zh-CN.md) |
| 原生 WebView 验证 | tauri-driver 只支持 Linux 和 Windows；macOS WKWebView 只能手工验证 | [NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md) |

### 用户决定与授权（均由用户在会话中明确给出）

| 日期 | 内容 |
| --- | --- |
| 10-11 | 可以推送 `p0/*` 工作分支并手动触发 CI；不动 `main`，合并前要先询问 |
| 10-11 | 多派子代理并行工作 |
| 10-11 | 允许用 Homebrew 安装 lrzsz、telnetd，仅作测试对端；未安装 XQuartz |
| 10-12 | 同意把 `p0/integration` 合并到 `main`，一次性授权，以后仍需再问 |
| 10-12 | E1–E12 全部采用推荐选项：先冻结，同时授权在隔离副本中做上游实机盘点；G13、F08/F09、Q06 采用 B；C14、G02 采用 A；四项措辞全部采纳；纳入 31 个候选；T14 措辞采纳；S08 标为“上游未证实”；E11 放到冻结之后；批准变更规则并冻结 |
| 10-12 | 同意把 WL-1、WL-2、WL-3 加为新 ID，执行被中断，见第 5 节 |
| 10-12 | 第 3 项：Kerberos 改为在 Linux CI 容器中自建 KDC；串口先用虚拟串口对；两项执行都被中断 |

## 4. 过程与方法

### 工作方式

- **协调方式**：协调方负责审查、合并、跑门禁和写文档；具体功能交给后台子代理。
- **子代理的约束**：
  - 每个代理在独立的 git worktree（`.claude/worktrees/agent-*`）中工作，使用各自的 Vite 端口（14xx）。
  - 共用一份规则文件：
    - 只在自己的分支上提交，不推送；
    - 文档用中文；
    - 依赖精确锁版本；
    - 新命令在三处登记；
    - 提交前要等独立评审给出结论，并修复 CRITICAL、HIGH、MEDIUM 级问题。
- **合并前的门禁**：
  - `cargo fmt`、clippy（`-D warnings`）、本机 Windows 目标交叉类型检查；
  - Rust 全套测试；
  - 真实 OpenSSH 夹具；
  - `npm run build` 与 Playwright 全套；
  - 改到代码时，提交前还要跑 `/verify`。
- **合并后**：推送 `p0/integration`，手动触发 CI，根据日志迭代。
- **台账一致性**：三处台账由三段结构验证脚本守护；每次改证据或 ID 后都要重跑。

### 过程中的问题与教训

1. **用量上限**：一次并行 9–12 个代理，至少 4 次撞上会话或每周上限，所有代理被同时中断。之后改为每批约 4 个，按接近完成的程度排序；中断的代理在原 worktree 中续做，半成品不会丢。
2. **评审结果送错了对象**：子代理请求的评审，结果多次送到了协调方，而不是请求它的代理，需要协调方手工转发。
3. **语义合并冲突**：
   - 两条分支都改了授权接口（`issue_grant` 加了 `Route`，`use_grant` 加了可写参数）；
   - 两条分支都改了 `ssh_open` 的连接方式（路线载体，以及转发需要的 `Routes`）。

   都由协调方手工合并；后者另做了独立评审。
4. **测试写法导致的失败**，均已修正：
   - CI 上的 X11 测试：PTY 行尾的 CR、xdpyinfo 输出的双空格；
   - 转发停顿测试的等待时间：Linux 和 Windows 的 socket 缓冲区更大；
   - SFTP 夹具自检：sshd 子进程退出稍晚于夹具本身；
   - 原生 SSH 场景：夹具输出前有提示符 `> `。
5. **协调方自己的失误与更正**：
   - lrzsz 的 CI 步骤设为不阻塞，协调方只看步骤状态就报告“通过”，事后已更正；
   - 一次提交漏跑了 `cargo fmt`，随后补了格式化提交；
   - 会话重启后，临时目录中的 Windows 交叉检查工具丢失，已重建。
6. **需要告知用户的副作用**：
   - OpenSSH 10.1+ 会在真实的 `~/.ssh/agent/` 下创建转发 agent 的套接字。代理在本机跑 agent 互操作测试时，打开了显式开关：sshd 每次都删除了自己的套接字，目录原有内容不变，只有修改时间变了。该测试现在默认跳过。
   - 代理为排查 lrzsz 读过它的 GPL 源码，已在 MODEM 中注明：自研 ZMODEM 的人不应读过它。
7. **第三段验证脚本过严**：它原先连冻结前各行的证据字段也一并锁定，与冻结规则不符（冻结的是 ID、名称、阶段、状态和措辞），已收窄为只检查这些字段。

## 5. 未完成与在途事项

### 被会话用量上限中断（10-12 约 18:00），可在原 worktree 中续做

| 任务 | worktree | 状态 |
| --- | --- | --- |
| 把 WL-1/2/3 加为 T35–T37，总数变为 164 | `.claude/worktrees/agent-a0c8a2739d862c6d3` | 已有 4 个未提交的修改，需要续做并通过三段验证 |
| GSSAPI：Linux 上的实现，以及 CI 容器中的 KDC 与 sshd | `.claude/worktrees/agent-a2bfa5e7569a82fc6` | 尚无修改 |
| 串口终端探针（虚拟串口对） | `.claude/worktrees/agent-a68e9cce8e90bbabf` | 尚无修改 |

### 需要用户提供条件

- **上游实机盘点和本机原生验收**：按[手工清单](HANDS_ON_CHECKLIST.zh-CN.md)执行，或在 Claude 桌面应用中打开 Computer use 后由代理执行。
  - 隔离副本：`.reference/WindTerm-Isolated.app`，profile 指向 `.reference/upstream-isolated-profile`。
  - 共用偏好设置的备份在 `.reference/plist-backup-2026-10-12/`，执行完毕后还原。截至归档时原文件没有任何改动。
- **签名与公证凭据**、**真实 USB 串口设备**（虚拟串口不能代替真实 UART）。
- **是否随包分发新版 conpty.dll**（只影响 Server 2022 这一代 Windows）、**是否允许在 CSP 中加入 `wasm-unsafe-eval`**（SIXEL 需要）。
- **把 `p0/integration` 的 7 个新提交同步到 `main`**：需要再次征得同意。

### 工程上的已知缺口（不需要用户条件）

- ZMODEM 自研；SCP 的目录与递归；端口转发和代理路线都没有与 OpenSSH 的转发策略、真实代理软件互操作。
- tmux 控制模式、agent 转发签名、经代理或跳板的 X11，都还没有界面或验证。
- 对 Windows 上 PowerShell 和管理员 shell 的验证；Wayland。
- WindTerm 上游的行为差异，要等实机盘点后才能确定。

## 6. 文档索引

| 类别 | 文档 |
| --- | --- |
| 总入口 | [交接](../HANDOFF.zh-CN.md)、[RESULTS](RESULTS.zh-CN.md)、[路线图](../ROADMAP.zh-CN.md)、[功能矩阵](../FEATURE_PARITY.zh-CN.md) |
| 基线 | [BASELINE](BASELINE.zh-CN.md)、[baseline.json](baseline.json)、[BASELINE_EVIDENCE](BASELINE_EVIDENCE.zh-CN.md)、[冻结方案与决定](BASELINE_FREEZE_PROPOSAL.zh-CN.md)、[上游静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md)、[Windows/Linux 复核](UPSTREAM_STATIC_REVIEW_WINLINUX.zh-CN.md) |
| P0 出口文档 | [工作量估算](EFFORT_ESTIMATE.zh-CN.md)、[终端内核 ADR](TERMINAL_CORE_ADR.zh-CN.md)、[性能基线](PERFORMANCE_BASELINE.zh-CN.md)、[依赖](DEPENDENCIES.zh-CN.md)、[发行](RELEASE.zh-CN.md) |
| SSH 与传输 | [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)、[SSH_ROUTES](SSH_ROUTES.zh-CN.md)、[SSH_FORWARDING](SSH_FORWARDING.zh-CN.md)、[SSH_KBDINT](SSH_KBDINT.zh-CN.md)、[SFTP_WRITE](SFTP_WRITE.zh-CN.md)、[SCP](SCP.zh-CN.md)、[NET_TERMINAL](NET_TERMINAL.zh-CN.md)、[TRANSPORTS](TRANSPORTS.zh-CN.md)、[MODEM](MODEM.zh-CN.md)、[X11_GSSAPI_ADR](X11_GSSAPI_ADR.zh-CN.md)、[CONTROLMASTER_ADR](CONTROLMASTER_ADR.zh-CN.md) |
| 终端 | [VT_MATRIX](VT_MATRIX.zh-CN.md)、[INPUT_PATHS](INPUT_PATHS.zh-CN.md)、[HISTORY_ARCHIVE](HISTORY_ARCHIVE.zh-CN.md)、[FOLDING](FOLDING.zh-CN.md)、[FREE_TYPE](FREE_TYPE.zh-CN.md)、[TMUX_CONTROL](TMUX_CONTROL.zh-CN.md) |
| 平台 | [WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md)、[NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md)、[跨平台验证](CROSS_PLATFORM_VALIDATION.zh-CN.md) |
| 手工验证 | [HANDS_ON_CHECKLIST](HANDS_ON_CHECKLIST.zh-CN.md) |
