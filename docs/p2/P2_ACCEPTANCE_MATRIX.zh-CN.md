# P2 连接、认证、代理与转发验收矩阵

状态：**准备文档，不是 P2 入口批准，也不代表任何产品能力已验收。**

P2 的正式前置条件是 P1 的数据流和状态模型稳定。当前 P1 仍有终端兼容性、输入/显示、持续输出背压、历史/资源边界，以及 Windows 首次目录查询停滞等未关闭问题；这些问题不因本矩阵建立而自动解除。P1 的实时状态以 [`p1/RESULTS.zh-CN.md`](../p1/RESULTS.zh-CN.md) 和交接文档为准。

本文件把 [`ROADMAP.zh-CN.md`](../ROADMAP.zh-CN.md) 的 P2 范围拆成可执行的验收单元，并引用 [`FEATURE_PARITY.zh-CN.md`](../FEATURE_PARITY.zh-CN.md) 中的 C 类 ID。它用于准备夹具、测试顺序和证据格式，保留现有 P0 探针与产品验收之间的边界。

## 使用规则

一次验收只关闭一个矩阵行或一组明确声明的联合场景。测试记录至少包含：

- C ID、测试版本和提交；客户端平台、系统版本、运行时、服务端版本与配置；
- 服务端/代理/目标地址是否为回环夹具、隔离测试服务还是实际设备；
- 正常、拒绝、取消、超时、断线、重连和资源清理结果；
- 主机密钥、认证方式、代理链和转发监听的实际状态；
- 日志、服务端确认或哈希等可复核证据，且不包含密码、私钥、令牌或完整票据。

矩阵中的“证据要求”是最低要求。单元测试、IPC stub 或静态配置只能证明对应层级，不能替代更高层级的互操作或产品验收。

## 状态词与证据分层

| 状态词 | 含义 | 可以支持的结论 |
| --- | --- | --- |
| 未准备 | 尚未有可重复的测试步骤或夹具 | 不能宣称实现或通过 |
| 探针通过 | 库、Rust 模块或受控夹具场景通过 | 只证明该探针范围 |
| 互操作通过 | 与隔离的真实进程/服务（例如系统 OpenSSH）完成端到端往返 | 只覆盖记录中的平台、版本和配置 |
| 产品验收通过 | 原生 WebView、真实 IPC、UI 状态与后端结果一起通过，且有失败路径 | 可关闭该行在所测平台的验收 |
| 阻塞 | 依赖缺失、环境不稳定、证据不足或已知 P1 门禁未关闭 | 必须记录阻塞原因和下一步 |
| 关闭 | 通过产品验收、独立复核和必要的跨平台复跑 | 仅对明确的平台/场景生效 |

证据按强度分层：

1. **L0 规划/静态**：路线图、上游 README、配置或源码观察。用于定义范围，不证明行为。
2. **L1 模块/夹具**：Rust 单元测试、loopback russh、IPC stub、虚拟 PTY。用于验证边界和错误处理，不证明真实服务或硬件。
3. **L2 外部进程互操作**：本机隔离 OpenSSH、telnetd、代理进程、Xvfb 等。用于验证协议链路，但仍不代表生产网络。
4. **L3 产品/平台**：原生 WebView、真实 Tauri IPC、会话 UI、平台权限和资源清理；需要在目标平台复跑。
5. **L4 真实服务/硬件**：真实 SSH 服务器、网络设备、USB 串口和拔插。涉及设备的行必须达到 L4 才能关闭“真实设备”部分。

同一行可同时保留多个层级结果。较低层级通过不能覆盖较高层级的失败或缺失。

## 协议矩阵

| ID | 协议/目标 | 最小场景 | 必须覆盖的结果 | 现有路径与证据目标 |
| --- | --- | --- | --- | --- |
| C01 | SSH v2 | 首次信任、交互 PTY、窗口变化、退出、断线/重连 | 指纹确认后连接；指纹变化阻断；断线有状态；重连不重放输入 | `tests/fixtures/ssh-terminal/`、`apps/desktop/src-tauri/tests/ssh_terminal.rs`；先 L1/L2，再 L3 |
| C02 | Telnet | 协商、UTF-8/二进制字节、NAWS、断线 | 未知选项拒绝且不循环；协商后尺寸更新；真实 telnetd 错误可见 | `apps/desktop/src-tauri/tests/net_terminal.rs`、`apps/desktop/src-tauri/tests/telnetd_interop.rs` 与 `apps/desktop/src-tauri/tests/support/telnetd.rs`；L1 已有，L2/L3 待补 |
| C03 | Raw TCP | 0x00–0xFF 双向流、半关闭、对端关闭 | 字节不变；FIN/错误状态可见；不把二进制误当文本命令 | `apps/desktop/src-tauri/tests/net_terminal.rs`；L1 已有，真实服务 L2 待补 |
| C04 | 串口 | 设备枚举、参数、读写、拔插恢复 | 设备权限/占用/断开有明确反馈；参数真正作用于设备；重连不丢状态 | `apps/desktop/src-tauri/tests/serial_virtual_pair.rs` 仅为虚拟 PTY L1；真实 USB 串口、COM 端口和拔插必须 L4 |

## 认证矩阵

| ID | 认证/连接状态 | 最小场景 | 必须覆盖的结果 | 证据目标 |
| --- | --- | --- | --- | --- |
| C05 | 认证后自动执行 | 显式开启、正常执行、命令失败、断线重连 | 顺序可见；失败不吞掉；重连是否执行有明确策略；不重放用户此前输入 | 隔离 SSH 服务端日志 + L3 UI 状态；当前未关闭 |
| C06 | ControlMaster | 主连接、从连接、主连接退出、并发关闭 | 复用关系可见；从连接独立退出；主连接结束后从连接得到明确错误 | `docs/p0/CONTROLMASTER_ADR.zh-CN.md` 作为设计输入；需 L2/L3 |
| C09 | SSH agent | agent 存在/不存在、选钥、取消 | 不读取未授权密钥；agent 不可用时不回退成静默成功；取消清理连接 | `tests/fixtures/ssh-terminal/agent-client.test.mjs`、`apps/desktop/src-tauri/tests/ssh_agent_openssh.rs`；L2/L3 |
| C10 | agent forwarding | 明确开启/关闭、远端签名、会话结束 | 默认拒绝；开启前有警告；关闭后通道失效；私钥不离开本机 | `apps/desktop/src-tauri/tests/ssh_agent_forwarding.rs` + OpenSSH agent fixture；L1/L2 已有探针，L3 待补 |
| C11 | 密码认证 | 正误密码、取消、可选保存、再次登录 | 错误可区分；取消不继续尝试；秘密不进入日志/历史；保存由安全存储授权 | `apps/desktop/src-tauri/tests/ssh_terminal.rs` 的认证测试；L3 安全存储待补 |
| C12 | 公钥认证 | 无口令/带口令、错误密钥、拒绝 | 口令只在需要时提示；错误密钥不重试越权；凭据不落普通配置 | `apps/desktop/src-tauri/tests/ssh_terminal.rs`、`tests/fixtures/ssh-terminal/rust-client.test.mjs`；L2/L3 |
| C13 | keyboard-interactive | 多轮提示、隐藏输入、错误/取消 | 提示顺序保留；隐藏输入不回显；取消终止认证而非回退 | `apps/desktop/src-tauri/tests/ssh_kbdint.rs`；L1/L2，产品 UI 仍待验收 |
| C14 | GSSAPI | 有效、过期、缺失票据、错误服务主体 | 服务端日志明确最终认证方式；不能由密码/公钥回退掩盖失败；票据和日志脱敏 | `docs/p0/BASELINE_EVIDENCE.zh-CN.md` 定义的隔离 KDC/sshd；需 L2，当前为待实测 |

## 代理与跳板矩阵

| ID | 路径 | 最小场景 | 必须覆盖的结果 | 证据目标 |
| --- | --- | --- | --- | --- |
| C07 | ProxyCommand | 正常代理、代理退出、参数错误、目标拒绝 | 参数按白名单传递；代理进程关闭；stderr/退出码可见；不执行未授权命令 | `apps/desktop/src-tauri/src/ssh_proxy.rs` 及 `SSH_FORWARDING` 设计记录；隔离代理进程 L2 + L3 |
| C08 | ProxyJump | 单跳、多跳、逐跳认证、第二跳指纹变化 | 每跳独立信任和认证；失败定位到具体跳；不把跳板当目标主机信任 | `apps/desktop/src-tauri/tests/ssh_forwarding.rs`、`docs/p0/SSH_FORWARDING.zh-CN.md`；L1 有探针，L2/L3 待补 |
| C19 | HTTP 代理 | 无认证/认证、拒绝、断线、DNS 策略 | CONNECT 结果准确；认证失败不泄露秘密；断线能清理代理连接 | 需要隔离 HTTP proxy fixture；当前无关闭的 L2/L3 证据 |
| C20 | SOCKS5 代理 | IPv4/IPv6/域名、代理认证、不可达 | 目标解析位置符合设置；认证/不可达可区分；不越过代理直连 | `apps/desktop/src-tauri/tests/ssh_forwarding.rs` 的 SOCKS 探针仅覆盖受控路径；需独立代理互操作 |
| C21 | Jump Server 会话代理 | 可复用跳板会话、目标会话关闭、跳板关闭 | 复用边界明确；目标关闭不误杀其它会话；跳板结束向所有从属会话报告错误 | 需 L2 多会话夹具 + L3 会话状态；当前未关闭 |
| C27 | 全局代理 | 无/系统/HTTP/SOCKS5、代理 DNS 开关、会话级覆盖 | Global 继承关系明确；系统代理平台差异有记录；会话代理不被全局设置意外覆盖 | 需平台代理配置 fixture；当前仅规划 |

## 转发、隧道与 SSH 连接策略矩阵

| ID | 能力 | 最小场景 | 必须覆盖的结果 | 现有路径与证据目标 |
| --- | --- | --- | --- | --- |
| C15 | X11 forwarding | 私有 Xvfb、cookie、远端窗口、关闭 | 未授权 X11 默认拒绝；cookie 不泄露；终端结束后连接清理 | `tests/fixtures/ssh-terminal/x11-client.test.mjs`、`apps/desktop/src-tauri/src/ssh_x11_tests.rs`；L2 Linux，L3 待补 |
| C16 | 本地端口转发 | 回环监听、并发数据、端口冲突、停止 | 双向字节一致；只监听允许地址；停止后新连接拒绝；不拖住终端 | `apps/desktop/src-tauri/tests/ssh_forwarding.rs`；L1 已有，OpenSSH/L3 互操作待补 |
| C17 | 远端/反向端口转发 | 远端监听、服务端限制、目标不可达、取消 | 服务器选择端口可见；取消无残留监听；目标失败不阻塞主会话 | `apps/desktop/src-tauri/tests/ssh_forwarding.rs`；L1 已有，服务端策略 L2 待补 |
| C18 | 动态端口转发 | SOCKS5 CONNECT、域名、IPv4/IPv6、停止 | 只允许支持的命令；解析策略可见；关闭后无连接残留 | `apps/desktop/src-tauri/tests/ssh_forwarding.rs`；L1 已有，L2/L3 待补 |
| C22 | 隧道管理器 | 新建/编辑/删除、绑定会话、状态刷新 | UI 状态与实际监听一致；会话关闭清理；配置边界和权限一致 | `docs/p0/SSH_FORWARDING.zh-CN.md` 的 IPC/面板记录；需 L3 |
| C24 | 算法、重协商、证书公钥类型 | 算法白名单、重协商阈值、证书/普通公钥 | 服务端日志核对协商结果；重协商不绕过主机信任；不支持项明确失败 | 需受控 OpenSSH 配置 + 安全复核；当前未关闭 |
| C25 | 主机指纹信任管理 | 查看、信任、取消信任、变化拒绝 | 取消后重新确认；变化立即阻断；存储格式和权限可审计 | `apps/desktop/src-tauri/tests/ssh_routes.rs`、`ssh_terminal.rs`；L1/L2 有基础，L3 待补 |
| C26 | 超时、保活、TCP 选项 | 不可达、空闲保活、断线发现、参数变化 | 超时有界且可见；保活不制造假在线；平台差异记录 | 需隔离网络故障夹具 + L3；当前未关闭 |

## 串口真实硬件边界

`serial_virtual_pair.rs` 只创建进程内 Unix PTY 对，证明字节完整性、API 参数回读、超时读和关闭错误。它不能证明真实 UART 的波特率时序、电气流控、设备权限、占用冲突、USB 转串口驱动、Windows COM 端口或拔插恢复。

关闭 C04 的真实设备部分前，必须登记设备型号、驱动/系统版本、端口、波特率/数据位/校验/停止位/流控，使用一对互连设备或明确的回环设备完成发送与接收哈希核对，再执行占用、断开、重新插入和权限失败场景。没有用户提供的真实设备时，C04 只能保持“探针通过”或“阻塞”，不能写成串口验收通过。

## P1 阻塞边界与进入 P2 的条件

本矩阵允许提前准备夹具、协议测试数据和安全审查，但不改变 P1 的阶段门槛。正式进入 P2 需要同时满足：

1. P1 数据流和状态模型经独立复核，包含输入/输出队列、ACK、关闭、重连和会话归属；
2. P1 的终端兼容、输入法/显示、持续输出背压、历史与资源边界有明确的通过或保留阻塞结论；
3. Windows 首次目录查询停滞的诊断完成归因，或由用户明确接受带证据的已知限制；未知 stderr、ConPTY 首轮超时和间歇性慢路径不能被测试重跑掩盖；
4. 第四批 `p1/integration` 仍需单独审查和合并批准；本文件不授予合并 `main` 的权限；
5. P2 每个已实现行均有与其目标平台匹配的 L2/L3 证据，C04 的真实设备部分另需 L4。

在上述条件满足前，P2 工作应标记为“准备中”，不标记为“P2 已进入”或“功能对齐完成”。

## 记录模板

```text
C ID / 场景：
提交 / 构建：
客户端平台与版本：
服务端、代理或硬件：
证据层级（L0-L4）：
步骤与输入摘要：
正常结果：
拒绝/取消/超时/断线结果：
清理与重连结果：
日志/截图/哈希索引（脱敏）：
状态：未准备 / 探针通过 / 互操作通过 / 产品验收通过 / 阻塞 / 关闭
未覆盖项与下一步：
```
