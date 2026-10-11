# P0 技术可行性与依赖调查

核查日期：2026-10-11。技术路线仍为 **Rust + Tauri 2 + xterm.js**；本报告是基于官方资料的风险结论，不是架构变更批准，也不是功能实测通过。现有 117 项不能因依赖缺口删减。查阅了本仓库规划；环境未发现 `chub`，使用 agent-reach 的 GitHub `gh` 后端和官方 API 文档补齐。依赖表是候选，不代表全部已加入或锁定。

## 先给结论

基础终端与 SSH/SFTP 有可用依赖路径；**直接组合这些库不能满足完整 WindTerm 对齐**。P0 的关键门槛是 VT 模式差异、Free Type/折叠/压缩历史与选择搜索的一致性、SSH 高级能力的对接，以及 WKWebView 中真实输入法和有界数据流。功能原型跑通后仍需逐项上游对照。

| 风险 / 功能 ID | 官方资料能确认的能力 | 缺口与 P0 出口 |
| --- | --- | --- |
| VT 模式 T07–T13、T19–T21 | xterm 6.0.0 发布了逐序列支持表；SIXEL 为外部扩展 | **阻断“原样 xterm 即全兼容”的假设**。DECSCL 未支持，VT52 切换未支持（上游2.7真实UI已观察到VT52选项，需新增基线ID），部分模式仅部分支持；先对照上游运行序列与 vttest 子项。无法用公开扩展覆盖时提交终端内核/渲染适配 ADR |
| Free Type / 折叠 G03、G16–G17、G20–G23 | public API 提供选区、buffer、marker、decorations 与 parser hooks | 文档未提供 WindTerm 式任意行编辑、折叠映射或压缩历史后端。**需要 ADR 和概念验证**：独立输入编辑层/历史模型如何保留选区、搜索、复制、resize 与备用屏幕语义；不能把 CSS 隐藏行当功能完成 |
| 历史压缩 Q04/Q06 | scrollback 是保留行数，默认 1000 | 增大 scrollback 不等于动态压缩。Rust 历史存储若与 xterm 内存重复，会增加总占用；需证明有限热窗口+冷历史的检索、恢复、行号/marker 一致性。压缩比只能实测 |
| 数据流 Q05 | Tauri 推荐 Channel 流式传输；xterm write callback 可反馈处理完成 | Channel `send` 成功不等于渲染完成或天然背压。构造 chunk序号/字节数→Channel→write回调 ACK→有限在途窗口，暂停 Rust PTY 读取；测吞吐、Ctrl-C响应、丢字节、关闭/重开、ACK丢失和退出清理 |
| SSH agent C09/C10 | russh 有 agent Signer 与转发相关 API | 认证 agent 与 agent forwarding 是两项：受控 agent socket、远端通道、取消授权、生命周期均需实测，不能仅测公钥成功 |
| GSSAPI C14 | russh 0.64.1 已有 `authenticate_gssapi_with_mic` / `GssapiAuthenticator` | **不是“russh 不支持”**；它要求应用提供平台/机制实现、OID、continuation tokens、MIC。须有测试 KDC/票据与 macOS GSS 桥；目前未证实端到端完成 |
| ControlMaster C06 | OpenSSH 有标准 ControlMaster/ControlPath/ControlPersist | russh 多 channel 并不等于 OpenSSH 控制 socket 与主从生命周期；公开 Handle API 未给现成等价方案。提交连接 broker 或 system OpenSSH 适配 ADR，并保留用户要求的复用语义 |
| ProxyCommand / Jump C07/C08/C21 | russh-config 声明两项字段，russh 支持自定义流与 direct-tcpip | 配置字段不证明完整 ProxyJump 链执行；ProxyCommand 命令参数引用及安全取消需探针。受控两跳验证逐跳主机密钥、独立认证、失败定位与清理 |
| 端口/X11/代理 C15–C20 | russh 有 direct-tcpip、tcpip_forward、X11通道等原语 | SOCKS/HTTP CONNECT、监听、X11 cookie与本地X服务仍需集成；分别测双向数据、拒绝、冲突、关闭，不能把 API 存在当用户功能 |
| SFTP/SCP F01–F09/F21 | russh-sftp 提供 raw/high-level、异步文件I/O及部分 OpenSSH扩展 | SCP是独立验收对象，不可用SFTP上传冒充SCP协议。对端扩展可选；续传、递归、链接的基线需先盘点。哈希应在测试夹具两端取样 |
| tmux T22 | tmux control mode 输出命令响应与窗口/窗格事件 | **运行 tmux 不等于集成**。需 control-mode解析器、窗格/窗口ID模型、布局同步和detach/reconnect。先测分包、转义、事件与命令响应交错。上游2.7不支持嵌套/Sender Pane/Sync Input组合 |
| 串口 C04 / modem F10–F12 | serialport跨平台枚举与blocking I/O；xmodem只覆盖XMODEM | USB真机拔插/流控不可用PTY替代。Y/Z modem 尚无选定 Rust 实现；lrzsz是GPL外部程序候选，不能按Apache原创代码并入。串行二进制分流须在文本解码前，测取消后回到终端 |

VT边界依据：[支持序列表](https://xtermjs.org/docs/api/vtfeatures/)；扩展依据：[IParser](https://xtermjs.org/docs/api/terminal/interfaces/iparser/)；数据流依据：[Tauri Channel](https://v2.tauri.app/develop/calling-rust/#channels)、[xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/)。

xterm 的 CSI/DCS/ESC/OSC hooks 可注册处理器，不能因此推断任意内部 buffer 操作都可实现；异步 handler 会暂停解析并影响吞吐，resize/reset仍可发生。DCS/OSC大负载与APC等不可hook范围应以实际锁定版本复查。Free Type 是产品的输入编辑模式，**不是 FreeType 字体库**；[上游演示文档（2022，历史资料）](https://kingtoolbox.github.io/2022/04/12/free_type_mode/)仍需以2.7行为验证。

## 候选依赖与版本边界

| 组件 | 本次查到的版本 / 许可证 | 来源与采用前条件 |
| --- | --- | --- |
| xterm.js | 6.0.0 / MIT；2025-12-22 release | [release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)、[LICENSE](https://github.com/xtermjs/xterm.js/blob/6.0.0/LICENSE)。addons分别锁版本；Unicode13、Search、WebGL、Image不可假设自动包含 |
| Tauri | 2.x / Apache-2.0 OR MIT；API与CLI分开发版 | [workspace manifest](https://github.com/tauri-apps/tauri/blob/dev/Cargo.toml)、[CLI 2.12.2](https://github.com/tauri-apps/tauri/releases/tag/tauri-cli-v2.12.2)。dev manifest当前tauri为2.12.3不等于发布版，采用以package registry+锁文件为准 |
| portable-pty | 0.9.0 / MIT | [crate](https://docs.rs/portable-pty/0.9.0/portable_pty/)、[manifest](https://github.com/wezterm/wezterm/blob/main/pty/Cargo.toml)。macOS PTY/ConPTY分别真机；PTY退出不能留下子进程 |
| russh | 0.64.1 / Apache-2.0；Rust 1.89 minimum | [版本manifest](https://github.com/Eugeny/russh/blob/v0.64.1/russh/Cargo.toml)、[Handle API](https://docs.rs/russh/latest/russh/client/struct.Handle.html)。default crypto有aws-lc-rs与rsa；存在RC依赖pin，需要原生arm64构建/供应链审查，不把Rust实现等同无C依赖 |
| russh-sftp | 3.0.1 / Apache-2.0 | [API](https://docs.rs/russh-sftp/3.0.1/russh_sftp/)、[manifest](https://github.com/AspectUnk/russh-sftp/blob/master/Cargo.toml)。raw stream可接russh；当前dev-dependency为russh0.63.2，0.64.1组合须编译和传输验证 |
| serialport | 4.10.1发布文档 / MPL-2.0 | [API](https://docs.rs/serialport/latest/serialport/)、[manifest](https://github.com/serialport/serialport-rs/blob/main/Cargo.toml)。主分支4.10.2-alpha0不是稳定候选；保留第三方许可并审查修改文件的MPL义务 |
| xmodem | 0.4.0 / MIT；2025-07-31 | [crate](https://docs.rs/crate/xmodem/0.4.0)、[manifest](https://github.com/awelkie/xmodem.rs/blob/master/Cargo.toml)。仅XMODEM；YMODEM/ZMODEM仍是未选定依赖的阻断项 |
| lrzsz（备选对端/外部程序） | 官方当前0.13.1 / GPL | [维护者官网](https://www.ohse.de/uwe/software/lrzsz.html)。2026-09/10恢复更新并修复安全问题，不能沿用“1998后未更新”的旧结论；新旧系列互操作仍需测。GPL版本/打包义务按实际tar包COPYING核查，尚未批准随应用分发 |
| system OpenSSH（备选） | 系统供应版本，非应用锁定依赖 | [ssh_config](https://man.openbsd.org/ssh_config)、[官方manual入口](https://www.openssh.com/manual.html)。保留argv结构、隔离known_hosts与配置、PTY/ASKPASS交互和子进程清理；验证宿主版本支持，不默认其功能跨平台相同 |
| tmux（测试对端） | 版本由受控fixture固定 / ISC样式许可 | [control mode](https://github.com/tmux/tmux/wiki/Control-Mode)、[COPYING](https://github.com/tmux/tmux/blob/master/COPYING)。作为外部远端程序不等于应用内依赖；测试报告记录准确版本 |

维护状态只用于风险判断：本次GitHub元数据russh最近release为2026-10-05、russh-sftp最近push为2026-10-07、serialport最近push为2026-09-08；这不代替安全审计、故障处理或完整依赖许可证清单。锁定阶段须保存Cargo.lock、前端lockfile、直接/传递依赖许可和漏洞核查结果。本报告没有宣称这些候选均已锁定或已编译。

## Apple Silicon 与系统兼容

Tauri支持 `aarch64-apple-darwin` 和 universal 构建，见[官方macOS bundle文档](https://v2.tauri.app/distribute/macos-application-bundle/)。应检查最终Mach-O与所有sidecar/native dylib，而非只检查Rust target；WKWebView运行在系统框架上，中文IME、合成事件、emoji、WebGL退化与辅助功能必须在原生.app内测，浏览器/无头测试不能替代。

最低支持系统版本尚未冻结，不能从依赖能编译倒推出全部输入/图形特性在旧系统可用。macOS28尚未进行真实系统验收；是否涉及Rosetta支持变化应另核对Apple公告，不能将用户担忧写成已发生的兼容性事实。

## 首轮必须优先运行的探针

1. **PTY闭环与背压**：原生arm64 Tauri→Rust PTY→Channel→xterm；ASCII/中文二进制分块、resize、Ctrl-C、exit、连续输出。保存生产/消费字节计数与ACK，记录峰值内存、延迟和收尾无孤儿进程。
2. **全量路线的最大不确定性**：VT模式差异表，优先VT52 parser扩展探针/ADR（不得删除基线）；Free Type草稿编辑/发送/取消；输出折叠后跨区选择、复制、搜索、resize；Rust压缩历史与xterm热窗口的一致性。任何失败都保留在ADR门槛，不用基本Shell成功掩盖。
3. **SSH独立夹具**：临时host key+user key、独立agent、受控sshd；首次信任/密钥变化拒绝、keyboard-interactive、agent forwarding、两跳与本地/远端转发。GSS需专门KDC；ControlMaster需明确协议与生命周期实现方案。
4. **tmux/串口/modem**：先control-mode事件回放，随后真实tmux；串口回环/拔插和X/Y/Z传输对端分开验证。

完成这些探针之后才能冻结完整架构与全量工期；当前结论允许继续P0实施，不构成P0通过。
