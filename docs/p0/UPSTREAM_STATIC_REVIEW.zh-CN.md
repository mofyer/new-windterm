# P0 上游静态证据复核（130 项逐条）

日期：2026-10-11。本文对[功能矩阵](../FEATURE_PARITY.zh-CN.md)、[基线台账](BASELINE.zh-CN.md)与 [baseline.json](baseline.json) 中的 130 个稳定 ID 逐条补充**上游静态证据**，并列出静态材料中出现、但 130 项未覆盖的“静态候选”。本文**不修改**三处台账，不新增、不改名任何 ID，也不改变任何一行的状态。

## 边界声明

- **静态证据不等于行为已验证。** 默认配置键、菜单动作、翻译字符串、链接符号或截图，只能说明上游发布包或文档里“有这个入口、字段或代码引用”，不能说明功能能用、语义正确、安全或与本项目对齐。
- **本文不把任何一行标为通过。** 130 项的上游行为与本项目对齐状态仍以[基线台账](BASELINE.zh-CN.md)和 [P0 结果](RESULTS.zh-CN.md)为准；本文的“支持/部分/矛盾/沉默”只是对静态材料的分类。
- 本轮没有启动上游应用，没有挂载 dmg，没有读取用户 profile、凭据或会话。没有把上游代码、图标、二进制或带专有标记的资源复制进仓库；`*.term`、`telnet.protocol` 等文件只按路径和键名引用。随包的 `vendors/lrzsz`（GPL）同样只作为存在性证据，不复制。
- 截图（`IMG/`）来自 2020 年左右的 Windows 构建（标题栏样式、`C:/Users/...` 路径、2020 年时间戳），不能代表 2.7.0 macOS 行为，只作为弱旁证。
- 若后续决定采纳本文发现（例如调整 G13 验收文字、拆分 F21），必须另行修改三处台账，并重跑[结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证)。

## 方法

### 材料与身份

| 材料 | 说明 |
| --- | --- |
| `WindTerm/README.md` | 上游 README，浅克隆 HEAD 为 `a8336c1d1e3dd1a981500dae8ef9eb42066de95f`（`.git/shallow`），SHA-256 `2e05e644…3d9c78` |
| `WindTerm/src/` | 部分开源源码（Pty、Telnet、Utility、Widgets、libssh、Onigmo） |
| `WindTerm/images/screenshots/` | README 引用的 3 张截图 |
| `WindTerm-P0.app` | 官方 2.7.0 macOS 便携包的隔离副本。主执行文件、`session.config`、`wind.keymaps`、`wind.actions`、`wind.config`、`menu.config`、`zh-CN.locale` 的 SHA-256 与[基线台账](BASELINE.zh-CN.md#固定来源与身份)和[证据记录](BASELINE_EVIDENCE.zh-CN.md#默认资源复核定位)一致 |
| `WindTerm_2.7.0_Mac_Portable_x86_64.dmg` | 未挂载；身份沿用台账记录 |

本轮新增引用的资源哈希（SHA-256）：`Frameworks/libssh.4.dylib` `e13a7680…e1ff83`，`Info.plist` `17e50067…beaba3`，`terminal/configs/toolbar.config` `22dd7bb6…26e26b`，`terminal/configs/statusbar.config` `a4f7df8f…fef25d`，`terminal/configs/triggers.config` `45bcdc7a…f87`，`terminal/protocols/telnet.protocol` `e627cfbd…c6`，`terminal/applets/sysmon/macos/sysmon.applet` `3f24d4d8…f8df`。

### 只读工具

`plutil -p`、`file`、`shasum -a 256`、`strings -a -n 4`（主执行文件）、`nm -u`（主执行文件导入符号）、`nm -gU`（随包 libssh 导出符号）、`otool -L`、`grep`/`sed`/`find`/`wc`，以及读取 JSON 类默认配置和查看截图。在主仓库根目录（`.reference/` 所在处）可复查关键结论：

```sh
R=.reference/WindTerm-P0.app/Contents
nm -u "$R/MacOS/WindTerm" | grep -x '_ssh_userauth_gssapi'           # C14：主程序引用 GSSAPI 认证
otool -L "$R/Frameworks/libssh.4.dylib" | grep Kerberos             # C14：随包 libssh 链接 Kerberos.framework
nm -u "$R/MacOS/WindTerm" | grep -c '^_sftp_'                       # F01–F07：47
nm -u "$R/MacOS/WindTerm" | grep -ci scp                            # F08/F09：0
nm -gU "$R/Frameworks/libssh.4.dylib" | grep -c '_ssh_scp_'         # F08/F09：22（库导出但主程序未引用）
grep -n '"<Ctrl+Enter>"\|"<Shift+Enter>"' "$R/MacOS/global/wind.keymaps"  # G13
```

### 路径缩写（均相对 `.reference/`）

| 缩写 | 实际路径 |
| --- | --- |
| `RD` | `WindTerm/README.md` |
| `SRC/` | `WindTerm/src/` |
| `IMG/` | `WindTerm/images/screenshots/` |
| `APP/` | `WindTerm-P0.app/Contents/MacOS/` |
| `FW/` | `WindTerm-P0.app/Contents/Frameworks/` |
| `PL` | `WindTerm-P0.app/Contents/Info.plist` |
| `BIN` | `APP/WindTerm`（`strings` 或 `nm -u` 输出） |
| `SCF` | `APP/terminal/configs/session.config` |
| `MNU` | `APP/terminal/configs/menu.config` |
| `TBR` / `SBR` / `TRG` | `APP/terminal/configs/toolbar.config` / `statusbar.config` / `triggers.config` |
| `GCF` / `ACT` / `KEY` | `APP/global/wind.config` / `wind.actions` / `wind.keymaps` |
| `LOC` | `APP/global/locales/zh-CN.locale`（行号指该条 `"en"` 所在行） |

`BIN` 的 `strings` 结果以原文短语引用，不给行号（行号依赖工具参数）。引文均为短键名或界面短语，不整段复制。

### 证据类型与结论分类

证据类型：**D** README 声明；**R** 发布包默认资源/配置；**L** 本地化字符串；**B** 主执行文件字符串；**I** 链接导入/导出符号；**S** 公开源码；**P** 截图；**M** bundle 元数据。

| 结论 | 含义 |
| --- | --- |
| 支持 | 除 README 外，还有发布包资源、字符串或符号表明该能力的入口、配置或代码引用存在 |
| 部分 | 只覆盖该行的一部分；或默认值、语义与本行措辞不同；或只有旧截图、字体、源码等间接旁证 |
| 矛盾 | 静态材料与 README 声明或本行验收措辞冲突（含“弱矛盾”） |
| 沉默 | 除 README 外未找到静态证据 |

## 结果概览

| 结论 | 数量 | ID |
| --- | --- | --- |
| 支持 | 101 | 见下表 |
| 部分 | 23 | C06、T02–T06、T09、T15、T21、T23、T24、F17、G03、G17、G21、G23、G31、S03、S11、Q02–Q05 |
| 矛盾 | 4 | F08、F09、G13、Q06（弱） |
| 沉默 | 2 | T14、S08 |

有静态旁证（支持+部分）的共 124 项。README 功能列表与路线图之间另有 3 处冲突：C14（GSSAPI，路线图称“延期”）和 G02（Auto Complete，2.x 路线图列为未来项）的静态证据都倾向功能列表；S11（Search in sessions）的含义仍无法界定。

### 最重要的矛盾与张力

1. **G13 本地/远程模式快捷键**：`RD:83` 写“Shift+Enter 切换”，但 `KEY:1082–1097` 的 `<Ctrl+Enter>` 才在 local↔remote（以及 normal↔command）之间切换。全文件唯一的 `<Shift+Enter>`（`KEY:2346`）绑定的是 `OutlinePane.RepeatedlyExecute`。本行验收要点“Shift+Enter 切换”与发布包默认键位冲突，需实机确认（macOS 上 Qt 的 Ctrl/Meta 映射也要一并记录）。
2. **F08/F09 SCP**：`RD:61` 写“Integrated sftp, scp client”。`nm -u BIN` 有 47 个 `_sftp_*`、70 个 `_ssh_*` 导入，`scp` 相关为 **0**；`FW/libssh.4.dylib` 导出 22 个 `_ssh_scp_*`，主程序未引用。`BIN` 字符串和 `LOC` 中都没有 “scp”（只在 `TRG` 的超链接正则里出现 `scp://`）。这只是静态弱反证，不能排除其他实现方式，但 2.7 macOS 包中没有可见的 SCP 入口。
3. **C14 GSSAPI 与路线图“延期”**：`RD:365` 称延期；但 `BIN` 导入 `_ssh_userauth_gssapi`，`FW/libssh.4.dylib` 导出 `_ssh_gssapi_auth_mic` 等符号，`otool -L` 显示链接 `/System/Library/Frameworks/Kerberos.framework`，`SCF:40` 默认 `ssh.authGssapiWithMic=true`。台账原先的“未获发布构建配置”问题在**链接层面**有了答案：发布构建启用了 GSSAPI，上层也有引用。是否能端到端认证成功，仍需 KDC 实验。
4. **G02 Auto Complete 与 2.x 路线图**：`RD:376` 把 “Auto Complete” 列为未来项，但 `GCF:44–52` 有完整的 `terminal.autoComplete.*` 设置，`APP/terminal/commands/` 下有 3809 个命令定义（cmd 32、linux 42、powershell 3696、git 39）。静态上入口存在。
5. **Q06 回滚上限（弱）**：`RD:195/206` 的基准表称 WindTerm 回滚 “unlimited”（1.72 版本），而 2.7 默认 `SCF:77` 为 `window.scrollbackLimit=999999`。是否能设为无限仍需实测。
6. **版本元数据**：`PL` 中 `CFBundleGetInfoString` 为 `2.6.0`，但 `ACT:364` 写 “&About WindTerm 2.7.0...”，`BIN` 也含 `2.7.0`。静态上支持产品为 2.7.0，与台账的入口观察一致。
7. **语义修正（非矛盾）**：G17 “大纲”在上游是**按命令生成的输出大纲**。`LOC:1936` 把 “Outline” 译为“历史命令”，大纲窗格提供 Execute/RepeatedlyExecute（`ACT:571/581`）。G33 的 README 写“隐藏鼠标指针”，而设置文案是 “Hide cursor when typing”（`LOC:1195`），指的是鼠标指针还是文本插入符需实测。

## 逐条静态证据（130 项）

### 协议、认证、代理与转发

| ID | 能力 | 类型 | 定位 · 引文/键名 | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| C01 | SSH v2 | D I R L B | `RD:51`；`nm -u BIN`：`_ssh_connect`、`_ssh_channel_request_pty_size`、`_ssh_channel_change_pty_size`、`_ssh_is_server_known`、`_ssh_write_knownhost`；`SCF:48` `ssh.verifyServerFingerprint=true`；`LOC:3064/3133` “Trust/Untrust this host”；`LOC:2938` 断线后 “press Enter to reconnect” | 支持 | 主机密钥变化时是否拒绝未知 |
| C02 | Telnet | D S R B | `SRC/Protocols/TelnetProtocol.h:74/81` `TELOPT_TTYPE`、`TELOPT_NAWS`；`APP/terminal/protocols/telnet.protocol` 键 `protocol.refs`/`match`（文件自带专有声明，仅引用键名）；`BIN`：`TelnetSession`、`telnet.port`、选项名 “NAWS”“TERMINAL TYPE”“NEW ENVIRON” | 支持 | 会话设置中 Telnet 专属项未单独定位 |
| C03 | Raw TCP | D B | `RD:51`；`BIN`：`TcpSession`、`ProtocolTCP`、`tcp.target`、`tcp.port`、“TCP connection options:” | 支持 | 编码与关闭语义未知 |
| C04 | 串口 | D R I B L | `SCF:6–10` `serial.baudRate=9600`/`dataBits=8`/`parity`/`stopBits`/`flowControl`；`FW/QtSerialPort.framework`；`nm -u BIN`：`QSerialPortInfo::availablePorts`；`BIN` “RTS/CTS”“XON/XOFF”；`LOC:361/1054` | 支持 | 有设备枚举引用；拔插行为未知 |
| C05 | SSH 认证后自动执行 | D R B L | `RD:52`；`SCF:13` `session.autoExecutionDelay=1`；`BIN` `session.autoExecution`、“&Execute command after authentication:”、“Delay:”；`LOC:937` | 支持 | 延迟单位、失败与重连是否重放未知 |
| C06 | SSH ControlMaster | D B R | `RD:53`；`BIN` 单独字符串 “ControlMaster”，与 “$SSH_AUTH_SOCK”“pageant”“ssh-agent” 相邻；未见 ControlPath/ControlPersist；`MNU:385`/`ACT:801` `Terminal.DuplicateSSHChannel` | 部分 | 可能以“同连接复制通道”实现，语义未定 |
| C07 | ProxyCommand | D B R L | `RD:54`；`BIN` `session.proxyCommand`、`ProxyCommandSocket`、代理类型 “Proxy command”、OpenSSH 导入正则键 `proxyCommand`；`SCF:25` `session.proxyWorkingDirectory=${HomeDir}`；`LOC:2137` | 支持 | — |
| C08 | ProxyJump | D B L | `RD:54`；`BIN` `session.proxyJumpServer1`…`4`、代理类型 “Jump servers”、OpenSSH 导入键 `proxyJump`；`LOC:3490` | 支持 | 以“跳板服务器”代理类型实现，静态最多 4 跳；与 C21 同一机制，ID 不合并但需联合测试 |
| C09 | SSH agent | D R I B L | `RD:55`；`SCF:39` `ssh.authAgent=false`；`nm -u BIN` `_ssh_userauth_agent`、`_ssh_agent_is_running`；`BIN` “Identity agent:” 选项 “&pageant”“&ssh-agent”“$SSH_AUTH_SOC&K”“&Unix domain socket”；`LOC:289` | 支持 | 默认关闭 |
| C10 | agent forwarding | D R I B | `RD:56`、`RD:362`（2.7 路线图项，未标延期）；`SCF:38` `ssh.agentForwarding=false`；`nm -u BIN` `_ssh_channel_request_auth_agent`、`_ssh_set_agent_channel`；`BIN` “Agent forwarding failed to allocate. The agent is not running.” | 支持 | 默认关闭，符合“明确授权” |
| C11 | 密码认证及自动登录 | D R I B L | `RD:57`；`SCF:42` `ssh.authPassword=true`；`nm -u BIN` `_ssh_userauth_password`；`BIN` `ssh.autoLogin`、“Saved automatic authentication:”；`LOC:316/55` | 支持 | 保存方式见 G06 |
| C12 | 公钥认证及自动登录 | D R I B L | `SCF:43`；`nm -u BIN` `_ssh_userauth_publickey`、`_ssh_pki_import_privkey_file`；`BIN` `ssh.identityFilePath`、公钥类型列表含 `ssh-ed25519`、`ecdsa-sha2-*`、`rsa-sha2-*`、`ssh-rsa`、`ssh-dss` 及 `*-cert-v01@openssh.com`；`LOC:1261` | 支持 | 证书类型见候选 8 |
| C13 | keyboard-interactive | D R I B L | `SCF:41`；`nm -u BIN` `_ssh_userauth_kbdint_getnprompts`/`getprompt`/`setanswer`；`BIN` “Keyboard interactive:”；`LOC:277/1384` | 支持 | — |
| C14 | gssapi-with-mic | D R L I B | `RD:57` vs `RD:365`；`SCF:40` `ssh.authGssapiWithMic=true`；`LOC:274`；`nm -u BIN` `_ssh_userauth_gssapi`；`nm -gU FW/libssh.4.dylib` `_ssh_gssapi_auth_mic`、`_ssh_gssapi_set_creds`；`otool -L` 链接 `Kerberos.framework` | 支持 | 矩阵状态为待实测；静态证据反驳路线图的“延期”，但仍无 KDC 认证记录；`LOC:1162` 把选项名误译为“带麦克风的 Gssapi” |
| C15 | X11 forwarding | D R B I | `RD:58`；`SCF:49` `ssh.x11=false`；`BIN` `ssh.x11Display`、`ssh.x11Protocol`、“&MIT-MAGIC-COOKIE-1”“&XDM-AUTHORIZATION-1”、“&Internal X display”“&External X display”；`nm -u BIN` `_ssh_channel_request_x11`、`_ssh_channel_accept_x11` | 支持 | 内置 X Server 见候选 5 |
| C16 | 本地/直接端口转发 | D B I L R | `RD:59`；`LOC:1492/121` “Local forwarding”“Accept local connections only”；`nm -u BIN` `_ssh_channel_open_forward`；`MNU:748` `Terminal.ManageTunnels`；`BIN` `ssh.tunnels`、导入键 `localForward` | 支持 | — |
| C17 | 远端/反向端口转发 | D B I L | `LOC:2242`；`nm -u BIN` `_ssh_channel_listen_forward`、`_ssh_channel_accept_forward`、`_ssh_channel_cancel_forward`；导入键 `remoteForward` | 支持 | — |
| C18 | 动态端口转发 | D B L | `LOC:856` “Dynamic forwarding”；`BIN` “Dynamic port allocation”、“SOCKS 5 handshake request is invalid …” 系列；导入键 `dynamicForward` | 支持 | SOCKS 错误串可作为错误路径测试样本 |
| C19 | HTTP 代理 | D B R L | `RD:105`；`BIN` 代理类型枚举 “Http”“Socks5”“ProxyCommand”“JumpServers”“Global”，`session.proxyHost/Port/User/Password`；`SCF:23–24` `session.proxy=None`、`session.proxyDns=true`；`LOC:3487` | 支持 | 应用级全局代理见候选 11 |
| C20 | SOCKS5 代理 | D B L | `LOC:3511` “Socks v5 proxy”；同 C19 键 | 支持 | — |
| C21 | Jump Server 会话代理 | D L B | `RD:106`；`LOC:1363`；`LOC:643` “Connection failed, jump server "%1" does not exist.”；`BIN` `session.proxyJumpServer1`…`4` | 支持 | 引用已保存会话，与 C08 同一机制 |

### 本地 Shell、终端与 tmux

| ID | 能力 | 类型 | 定位 · 引文/键名 | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| T01 | macOS bash/zsh/PowerShell Core | D B S L | `RD:65`；`BIN` “/etc/shells”、“SHELL”、“-i -l”、“pwsh”、“powershell”、“tcsh”、`COLORTERM`；`SRC/Pty/UnixPty.cpp`；`LOC:3118` | 支持 | “提示未安装依赖”未见文案 |
| T02 | Linux bash/zsh/PowerShell Core | D S R | `RD:64`；`SRC/Pty/UnixPty.cpp`；`APP/terminal/schemes/linux/`、`APP/terminal/applets/sysmon/linux/` | 部分 | 未检查 Linux 发布包 |
| T03 | Windows Cmd | D S R L P | `RD:63`；`SRC/Pty/ConPty.cpp`、`WinPty.cpp`；`APP/terminal/schemes/cmd/`、`APP/terminal/commands/cmd/winserver2022/`；`LOC:3253` “Windows 10 version below 19H1 … not supported.”；`IMG/WindTerm.png` 会话树 “cmd” | 部分 | 未检查 Windows 发布包 |
| T04 | Windows PowerShell | D R P | `APP/terminal/schemes/powershell/`、`APP/terminal/commands/powershell/`（3696 个）；`IMG/WindTerm.png` 标签 “powershell 6\|7” | 部分 | 同上 |
| T05 | Windows 管理员 Cmd | D B P | `BIN` “admin:”（位于 Shell 会话设置字符串区）；`IMG/WindTerm.png` 会话 “admin:cmd” | 部分 | 未见 runas/UAC 字符串，提权机制未知 |
| T06 | Windows 管理员 PowerShell | D B P | 同上；`IMG/WindTerm.png` “admin:powershell” | 部分 | 同上 |
| T07 | VT100 | D R B | `APP/terminal/terms/vt100.term`；`BIN` “vt100” | 支持 | 定义文件不等于序列通过 |
| T08 | VT220 | D R | `APP/terminal/terms/vt220.term` | 支持 | 同上 |
| T09 | VT340 | D R B | `APP/terminal/terms/vt340.term`（422 行，带专有声明）；`BIN` 未见 “sixel”，“regis” 只出现在 “register” 中 | 部分 | 图形能力静态未见 |
| T10 | VT420 | D R B | `vt420.term`；`BIN` “Horizontal Cursor-Coupling Mode (DECHCCM)”、“Key Position Mode (DECKPM)” | 支持 | — |
| T11 | VT520 | D R B | `vt520.term`；`BIN` “Select Active Status Display (DECSASD)”、“Restore Terminal State (DECRSTS)” | 支持 | — |
| T12 | xterm | D R B | `xterm.term`；`BIN` “XTerm Set Window Attributes {}”、“XTerm Request Termcap/Terminfo String {}”、括号粘贴标记 “[200~”“[201~” | 支持 | — |
| T13 | xterm-256-colors | D R | `SCF:31` 默认 `session.term=xterm-256color`；`xterm-256color.term` | 支持 | — |
| T14 | Unicode 13 与宽字符 | D | 仅 `RD:70`；`BIN`、`LOC` 均未见 Unicode 版本串 | 沉默 | 需列宽实测 |
| T15 | emoji | D P | `IMG/WindTerm.png` emoji 网格（2020 Windows）；随包字体（`APP/global/themes/default/fonts/`）不含 emoji 字体 | 部分 | 依赖系统字体回退 |
| T16 | true-color | D B P | `BIN` 环境变量 “COLORTERM”“truecolor”；`IMG/WindTerm.png` `./true_color.sh` 渐变 | 支持 | — |
| T17 | 终端鼠标协议 | D R L B | `GCF:60–65` `terminal.mouseTracking.click/doubleClick/middleClick/move/rightClick(false)/wheel`；`LOC:1678`；`BIN` tmux 字段 `mouse_sgr_flag` 等 | 支持 | 右键追踪默认关 |
| T18 | 自动换行模式 | D R L | `SCF:52` `terminal.autoWrapMode=true`；`LOC:319` “Auto Wrap Mode (DECAWM)” | 支持 | — |
| T19 | 自定义协议 | D R B | `RD:102`；`APP/terminal/protocols/telnet.protocol`（键 `protocol`/`refs`/`match`，基于正则）；`BIN` 加载串 “/protocols”“*.protocol” | 支持 | 矩阵状态为待实测；扩展点是正则协议定义文件，只随包提供 Telnet；可定制范围待实测 |
| T20 | 自定义终端类型 | D R B | `RD:102`；`APP/terminal/terms/*.term`（10 个，含 `tmux-256color`）；`BIN` “%1/terminal/terms”“*.term”、键 `deviceAttributes`/`input`/`output` | 支持 | 矩阵状态为待实测；用户目录是否也被扫描未知 |
| T21 | vttest 兼容范围 | D B | `RD:103`；`BIN` “Invoke Confidence Test {}”、大量 DEC 模式名；未见 Tektronix 相关串 | 部分 | 与“除 Tektronix 外”一致，但不能证明全部通过 |
| T22 | tmux 集成 | D R B | `RD:66`；`ACT:2144–2192` `Tmux.*`、`ACT:370–550` `Mux.*`；`MNU:62–74`；`BIN` 控制模式命令 “list-windows -a -F …”“capture-pane -peCqJ”“set-option synchronize-panes”、`%begin/%end/%error` 解析正则、“Press Enter to detach from the Tmux session.”；`tmux-256color.term` | 支持 | 发布说明称不支持嵌套和 Sender/Sync Input 组合 |
| T23 | Powerline / Oh-My-Zsh | D R P | `APP/global/themes/default/fonts/RobotoMonoNerdFont-Regular.ttf`；`IMG/WindTerm.png` powerline 分段与 git 分支 | 部分 | 截图为旧版本 |
| T24 | Powerline / Oh-My-Posh | D R | 同一 Nerd Font；`APP/terminal/schemes/powershell/` | 部分 | 无 Oh-My-Posh 专属证据 |
| T25 | VT52 | R B | `vt52.term`；`BIN` `vt52Mode`、`vt52MoveCursor`、`vt52Identify`、`vt52EnterGraphicsMode` | 支持 | 补强台账的入口观察 |
| T26 | VT102 | R | `vt102.term` | 支持 | — |
| T27 | 终端 Bell 与节流设置 | R B L | `SCF:54–55` `bellInterval=2`、`bellStyle=1`；`BIN` `terminal.bellFilePath`，“Bell styles:” 选项 “&Mute”“&Beep using the PC speaker”“&Play the custom sound”，以及 “&Ignore bells received more than once within:”；`APP/global/themes/default/audios/` 55 个 mp3；`LOC:3541` | 支持 | 静态可见 3 种样式，但 `bellStyle=1` 对应哪一种不能推断 |
| T28 | Big5 会话字符编码 | B R L | `BIN` 字符集分组 “Chinese Traditional” → “Big5,Big5-HKSCS”；`SCF:14` `session.charset=UTF-8`；`LOC:511` | 支持 | 另有 Big5-HKSCS；`BIN` 中 uchardet 类 `nsBig5Prober` 暗示自动检测 |
| T29 | EUC-JP 会话字符编码 | B | `BIN` “Japanese” → “EUC-JP,ISO-2022-JP,Shift-JIS” | 支持 | 其余字符集见候选 20 |

### 文件传输与本地文件管理

| ID | 能力 | 类型 | 定位 · 引文/键名 | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| F01 | SFTP 文件浏览 | D I R B | `RD:61`；`nm -u BIN` `_sftp_opendir`、`_sftp_readdir`、`_sftp_lstat`、`_sftp_canonicalize_path`；`SCF:46` `ssh.sftp=true`；`MNU:168–196` Filer Popup；`BIN` `SftpFileSystemItem` | 支持 | — |
| F02 | SFTP 下载 | D I R B P | `nm -u BIN` `_sftp_async_read`；`MNU:92/178` `FilerPane.Download`；`BIN` “Select Download Folder”；`IMG/WindTerm.png` 传输窗格 “97.7 MB downloaded” | 支持 | — |
| F03 | SFTP 上传 | D I R | `nm -u BIN` `_sftp_async_write`；`MNU:93/179`；`ACT:358` “&Upload To Current Folder...” | 支持 | — |
| F04 | SFTP 删除 | D I L | `nm -u BIN` `_sftp_unlink`、`_sftp_rmdir`；`LOC:247/250` 删除确认 | 支持 | — |
| F05 | SFTP 重命名 | D I R | `nm -u BIN` `_sftp_rename`；`MNU:98/175` | 支持 | — |
| F06 | SFTP 新建文件 | D R I | `MNU:102/184` `NewFile`/`MakeFile`；`nm -u BIN` `_sftp_open`；`SCF:32` `sftp.fileCreationPermissions=644` | 支持 | — |
| F07 | SFTP 新建目录 | D I R | `nm -u BIN` `_sftp_mkdir`；`SCF:33` `folderCreationPermissions=755` | 支持 | — |
| F08 | SCP 下载 | D I B L | `RD:61` 声称支持；`nm -u BIN` scp 相关符号 0 个（sftp 47 个）；`FW/libssh.4.dylib` 导出 22 个 `_ssh_scp_*`，主程序未引用；`BIN`/`LOC` 无 “scp” 文案 | 矛盾 | 静态弱反证，需实机确认是否真有 SCP 路径 |
| F09 | SCP 上传 | D I B L | 同 F08 | 矛盾 | 同上 |
| F10 | XModem | D R B L | `MNU:273/277`；`SCF:84–85` `xmodem.packetSize=128`、`uploadCommand`；`BIN` “128 (&XModem)”“1024 (&XModem-1K)”、`XModem`；`LOC:3301` 文件夹/4GB 限制 | 支持 | — |
| F11 | YModem | D R B | `SCF:86–87`；`BIN` “--ymodem”、`YModem` | 支持 | — |
| F12 | ZModem | D R B L | `SCF:4` `modem.defaultUploadProtocol=ZMODEM`、`SCF:88`；`APP/vendors/lrzsz/{rz,sz,COPYING}`；`BIN` “/vendors/lrzsz/sz”；`LOC:2914` “The lrzsz is not detected…” | 支持 | 随包 lrzsz 为 GPL，不得复制 |
| F13 | 本地文件浏览 | D R B | `KEY` 条件 `pane('filer').localSystemMode`；`BIN` `transfer.localFileSystem` | 支持 | — |
| F14 | 本地文件移动 | D R L | `MNU:99/176` `FilerPane.MoveTo`；`LOC:2902` “The destination folder is a subfolder of the source folder” | 支持 | — |
| F15 | 本地文件复制到目标 | D R | `MNU:94/180` `CopyTo` | 支持 | — |
| F16 | 本地文件从来源复制 | D R | `MNU:95/181` `CopyFrom` | 支持 | — |
| F17 | 本地删除 | D R | `ACT:327` `FilerPane.Remove`；`BIN` 与导入符号均无 “trash/recycle” | 部分 | 静态暗示可能为永久删除，需实测 |
| F18 | 本地重命名 | D R | `ACT:338` | 支持 | — |
| F19 | 本地新建文件 | D B | `ACT:271`；`BIN` “&Open file after created” | 支持 | — |
| F20 | 本地新建目录 | D B | `ACT:265`；`BIN` “&Open directory after created” | 支持 | — |
| F21 | 传输的其他实际选项 | R B L | `SCF:64–72` `transfer.handlers=8`、`maxHandlers=128`、`congestionStrategy=aggressive`、`enableAsyncFile`/`MappedFile`/`NullFile`、`maxLocal/RemoteChunkSize`；`SCF:34–36` 修复非法路径字符、保留修改时间；`MNU:241` `TransferPane.Pause`；`BIN` Modem 冲突策略 “Overwrite / … / Append / Rename / Resume / Skip”；`LOC:2704` 拖放协议 | 支持 | 矩阵状态为待实测；已能列出拆分清单（候选 18、19）；“续传”字符串只在 Modem 对话框附近，SFTP 是否续传未知 |

### GUI 与工作流

| ID | 能力 | 类型 | 定位 · 引文/键名 | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| G01 | 多语言界面 | D R B L | 34 个 `APP/global/locales/*.locale`；`GCF:3` `application.language=auto`；`BIN` “&Language:”；`LOC` 共 1414 条，其中 66 条 `tr` 为空 | 支持 | 空条目可用于测回退；存在误译（`LOC:1162`、`LOC:721` 把 DECCKM 译成“鼠标键模式”） |
| G02 | 自动补全 | D R | `RD:72` vs `RD:376`；`GCF:44–52` `terminal.autoComplete.*`；`APP/terminal/commands/` 3809 个；`APP/terminal/schemes/*/*.complete`；`MNU:463–465` IntelliSense | 支持 | 反驳路线图“未来项”；敏感输入是否被收集需测 |
| G03 | Free Type 模式 | D B R | `BIN` `isFreeTypeMode`、`cancelFreeTypeMode`、`eraseFreeTypeRange`；`KEY:310` Esc 取消；`KEY:1641–1647` Ctrl+Shift+X 在该模式下改为剪切 | 部分 | 动作表/菜单中未找到“进入”入口，进入手势未知 |
| G04 | Focus 模式 | D R B | `MNU:733–734`；`ACT:2597/2350`；`GCF:24–25`；`KEY:582` `<Alt+Enter>`；`BIN` 设置组 “Bars”“Panes”“Modes” | 支持 | — |
| G05 | 同步输入 | D R L B | `MNU:128–135` Channel A–D 与 Leave；`MNU:744` `Terminal.SyncInput`；`LOC:2812`；`BIN` “ [Synced]” | 支持 | 与 tmux 不可组合（发布说明） |
| G06 | 用户名/密码保护 | D B L R S | `BIN` `MasterPasswordDialog`、`application.masterPassword`；`LOC:100` 主密码说明；`LOC:3691` “Click the lock to make changes.”；`GCF:78` `terminal.usernameEchoMode=EchoNone`；`LOC:868` 随机回显；`SRC/Utility/Cryptographic.h`（PBKDF2，见 `SRC/README.md`） | 支持 | OneKey 另见候选 2 |
| G07 | 命令面板 | D R | `MNU:624–626`；`ACT:2473`；`KEY:500` | 支持 | — |
| G08 | 命令发送器 | D R B P | `MNU:40/57/663`；`TBR:35–42` Start/Stop/Add/Remove/Clear；`ACT:643–670`；`BIN` “&Hex”“&Line”“&Char”“&Count:”“&Interval:”“&Targets:”，目标 “Current Session”“Sessions In Current Group”“Selected Sessions”；`IMG/WindTerm_DigeWhite_Theme.png` | 支持 | 已可按文本/Hex、按行/按字符、次数、间隔、目标拆细项 |
| G09 | Explorer 面板 | D R | `MNU:37/54/108–167`；`ACT:35`；`TBR:12–14` 过滤框 | 支持 | — |
| G10 | Shell 面板 | D R | `MNU:42/59/665`；`ACT:77` | 支持 | 仅开关入口 |
| G11 | Quick Bar | D R B P | `MNU:52/657`；`GCF:30–32`；`BIN` “/quickbar.config”、“Quick Commands”；`IMG/WindTerm.png` 底部快捷栏 | 支持 | — |
| G12 | 粘贴对话框 | D R B | `GCF:68` 主屏开、`GCF:41` 备用屏关；`BIN` “C&onvert tab to spaces:”“Co&nvert CRLF and LF to CR”“&Send Line By Line”“You are sending a large amount of text (%1 bytes).” | 支持 | 括号粘贴见候选 7 |
| G13 | 本地/远程输入模式 | D R | `RD:83` “Shift+Enter”；`KEY:1082–1097` `<Ctrl+Enter>` 切换；`KEY:2346` 唯一 `<Shift+Enter>` 属于大纲；`MNU:724–725`；`SBR:6`；`GCF:58` | 矛盾 | 验收要点中的快捷键与默认键位冲突 |
| G14 | Vim 键位 | D R | `KEY:1` 起 `"modes": "command, local"` 移动正则、寄存器 `Key::VimInlineFinder`、`KEY:11–13` “.” 重复、`KEY:61–67` “i”；`GCF:18` `editor.commandModeEnabled` | 支持 | 实际有 normal/command/local/remote 四种模式 |
| G15 | 时间戳 | D R B P | `GCF:113` timestamp 边栏；`SCF:78–79` `[HH:mm:ss]` 与长格式；`MNU:308/680`；`BIN` “Timestamp of lines:” | 支持 | 终端隐藏边栏默认只列 `symbol`（`GCF:72`），编辑器还列 `timestamp`（`GCF:101`）；默认是否显示需实测 |
| G16 | 文本折叠 | D R | `MNU:326–335`；`APP/terminal/schemes/*/*.fold`；`GCF:104` | 支持 | — |
| G17 | 大纲 | D R L P | `MNU:197–211` Execute/RepeatedlyExecute/CopyOutput；`APP/terminal/schemes/*/*.outline`（键 `patterns`/`regions`）；`LOC:1936` “Outline”→“历史命令”；截图中大纲列出命令 | 部分 | 上游语义是“按命令的输出大纲”，验收描述应以此为准 |
| G18 | 分屏 | D R P | `MNU:29–30/146–157/762–771`；`ACT:2532–2570`；`IMG/SplitView.png` | 支持 | — |
| G19 | 输出配色方案 | D R | `APP/terminal/schemes/{cmd,dumb,linux,macos,powershell,routeros}/*.lexer`；`MNU:669–671` “Syntax Schemes”；`SBR:66–90` 方案按钮 | 支持 | — |
| G20 | 文本搜索 | D R B P | `MNU:467–479`；`BIN` 搜索选项 In Selection(Alt+N)/Incremental(Alt+I)/Wrap(Alt+O)/Context(Alt+T)，`text.matchRegex/matchCase/matchWholeWord`；截图 “Find All” | 支持 | — |
| G21 | 搜索预览 | D B R | `BIN` “&Preview All”“Find &All”“&Where:”；`GCF:26–27` `grep.leading/trailingContextLines=2` | 部分 | 这些可能属于编辑器的“在文件中查找”；终端预览形态未知 |
| G22 | 配对分隔符高亮 | D R | `GCF:105` `text.highlightPair=true`；`APP/terminal/schemes/*/*.pair`；`MNU:607–613`；`ACT:1305` | 支持 | — |
| G23 | 自定义分隔符 | D R | `*.pair` 键 `begin`/`end`/`blocks`/`ignoreString` | 部分 | 只看到资源文件定义，未见 UI 编辑入口 |
| G24 | UI 主题 | D R B P | `APP/global/themes/{dige-black,dige-white,dige-black-and-white}/gui.theme`；`GCF:15–16`；`BIN` “&Theme:”；`IMG/WindTerm_DigeWhite_Theme.png` | 支持 | — |
| G25 | 标签颜色 | D R | `MNU:109–126/356–373`；`ACT:2399–2463`（12 种预设 + 自定义 + 清空） | 支持 | — |
| G26 | 已打开标签搜索 | D R B L | `ACT:2318` `GotoSession` → `openCommandPalette('t')`；`BIN` “Show All Opened and Recent Terminals”；`KEY:712`；`LOC:1477` | 支持 | — |
| G27 | 关闭右侧标签 | D R | `MNU:162/409`；`ACT:2293` | 支持 | — |
| G28 | 窗口透明度 | D R | `MNU:715–721`；`ACT:14–26`（0.1/0.5/1.0/自定义）；`GCF:17` | 支持 | — |
| G29 | 选择即复制 | D R L | `GCF:81` `text.autoCopySelection=false`；`LOC:328` | 支持 | 默认关闭 |
| G30 | 右键粘贴 | D R B L | `GCF:67` `terminal.rightClickAction=ShowMenu`；`BIN` 枚举 “CopyOrPasteText”“PasteText”“ShowMenu”；`LOC:3721` | 支持 | 默认弹出菜单而不是粘贴 |
| G31 | 中键粘贴 | D R | `MNU:18/250/349` `Terminal.PasteSelectedText`；`GCF:62` 中键鼠标追踪；`GCF:35` `tabbar.middleClickAction=RenameTab` | 部分 | 未找到终端中键动作设置键 |
| G32 | 在线文本搜索 | D R B | `GCF:7–14` 六个引擎与 README 一致；`BIN` “&URL with {q} in place of query:” | 支持 | Stackoverflow 默认为 `http://`，实现时需注意 |
| G33 | 输入时隐藏鼠标指针 | D R L | `GCF:73` `terminal.text.hideCursorOnTyping=true`；`LOC:1195` “Hide cursor when typing” | 支持 | “cursor” 指鼠标还是插入符需实测 |
| G34 | 锁屏 | D R L | `MNU:739`；`ACT:2332`；`GCF:4` `lockScreenTimeout=30`；`SBR:104–112` 锁屏按钮；`LOC:2386` | 支持 | — |
| G35 | Hex 编辑模式 | R B | `MNU:727/628–646`；`ACT:1939`；`GCF:96–99` 进制/列数/分组；`BIN` 字符集列表含 “Hexadecimal” | 支持 | “Hexadecimal” 字符集项与 Hex 编辑的关系未确认 |
| G36 | 虚拟空间 | R | `GCF:124` `text.virtualSpaceEnabled=false`；`ACT:2004` | 支持 | — |
| G37 | 多插入符号 / 多光标 | R | `GCF:118` `text.multipleCaretEnabled=true`；`ACT:1986`；`KEY:297` `cancelMultipleSelections` | 支持 | — |
| G38 | 全屏模式 | R B | `ACT:2603` `window.fullScreen`；`KEY:378` 等；`BIN` “FullScreenMode” | 支持 | — |
| G39 | 窗口总是置顶 | R B | `ACT:2576` `window.alwaysOnTop`；`BIN` “AlwaysOnTopMode” | 支持 | — |
| G40 | 会话 Debug 模式 | R B | `ACT:2586` `terminal.activeView().debugMode`；`MNU:741` | 支持 | 作用范围仍未知 |

### 会话、平台与性能

| ID | 能力 | 类型 | 定位 · 引文/键名 | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| S01 | 会话配置对话框 | D R B | `MNU:415–416/441–446`；`BIN` 设置页 “Connection”“Bell”“Logging”“Mode”“Selection”“X/Y/Z Modem”“Authentication”“Agent”“Ciphers”“Key Exchange”“MAC Hashes”“Public Keys”“SFTP”“Protocol”“Process”；“The changes will be applied to NEW and all EXISTING sessions.” | 支持 | 已可按页盘点配置项 |
| S02 | 会话树与分组 | D R B P | `MNU:212–227` Session Popup；`BIN` `session.group`、“nesting groups”；`TBR:43–45` 过滤框；截图会话树分组 | 支持 | — |
| S03 | 会话重命名 | D R B | `ACT:2367` `Window.RenameView`；`GCF:35` 中键 `RenameTab`；`LOC:2284`；`BIN` `session.label`；但 `MNU:212–227` 会话树菜单没有重命名项 | 部分 | 静态只见标签重命名，会话树重命名路径未知 |
| S04 | 会话复制 | D R | `MNU:215/384`；`KEY:1061` `<Ctrl+D>` | 支持 | — |
| S05 | 手动会话日志 | D R | `MNU:284–295/428–439` Start/Stop/Pause/Resume/Open；`ACT:1016/1027/918/960` | 支持 | — |
| S06 | 自动会话日志 | D R B L | `SCF:18–22` `logFilePath=%n_%Y-%m-%d_%H-%M-%S.log`、`logFileSize`、`logPattern`、`logType`、`logOption`；`BIN` “Log &nothing/printable output/all session output”、覆盖/追加；`LOC:1516/1546` | 支持 | 秘密过滤未见 |
| S07 | 重启恢复会话 | D R B | `GCF:69` `terminal.startupSessions=LastSessions`；`BIN` “NoSessions”“LastSessions”“SpecificSessions”、“global/reopen.history”、“/user.sessions” | 支持 | — |
| S08 | 重启恢复布局 | D | 仅 `RD:109`；未找到布局持久化键或文件名 | 沉默 | — |
| S09 | 启动指定单会话 | D B L | `LOC:109` “A specific session or set of sessions”；`BIN` `kit.startupSession1`…`4`、`kit.startupSessions` | 支持 | — |
| S10 | 启动指定会话集合 | D B | 同 S09 | 支持 | 4 个槽位是否构成上限待测 |
| S11 | 会话搜索 | D R B P | `RD:366` 称延期；`TBR:43–45` SessionPane `FilterEdit`；截图 Session 窗格 “Filter”；`BIN` 在 “&Find:/&Replace:/&Where:” 之后紧邻 “&All Sessions” | 部分 | 矩阵状态为待实测；名称过滤已存在；路线图“Search in sessions”的含义（是否指跨会话输出搜索）仍不能确定 |
| S12 | 本地 Shell Sysmon | R B | `SCF:37` `shell.sysmon=true`；`APP/terminal/applets/sysmon/{linux,macos,windows}/sysmon.applet`（`name: sysmon`、`type: button`；解析 `top` 输出得到 Cpu/Memory/Network/Load average/Uptime，提示 “Click to start sysmon”）；`APP/terminal/schemes/{linux,macos,cmd,powershell}/*.appletbar` 导入；`BIN` “Sys&mon:”；`LOC:4249` | 支持 | 从静态候选升级为有资源旁证，但指标与平台仍需实测 |
| S13 | SSH 远端 Sysmon | R B | `SCF:47` `ssh.sysmon=false`；按 `session.system`（`SCF:26` 默认 `linux`）选择 appletbar；同 S12 的 applet | 支持 | 静态暗示会在远端运行 `top`/`uptime`，需在隔离端审计命令 |

| ID | 能力 | 类型 | 定位 · 引文/键名 | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Q01 | macOS 平台 | D M | `PL` `LSMinimumSystemVersion=10.13`、`CFBundleGetInfoString=2.6.0`；`file BIN`：仅 x86_64；`FW/QtCore` 为 x86_64，`FW/libssh.4.dylib` 为 x86_64+arm64；`ACT:364` “About WindTerm 2.7.0” | 支持 | 上游在 Apple Silicon 上依赖 Rosetta；基于 Qt5 |
| Q02 | Windows 平台 | D S L | `SRC/Pty/ConPty.cpp`、`WinPty.cpp`；`LOC:3253/3259` | 部分 | 未检查 Windows 包 |
| Q03 | Linux 平台 | D S R | `SRC/Pty/UnixPty.cpp`；linux 方案与 sysmon applet | 部分 | 未检查 Linux 包 |
| Q04 | 动态内存压缩 | D B | `RD:112`；`BIN` RTTI `CompressedGapBuffer` 系列模板（`Partitioning`/`RunStyles`） | 部分 | 有压缩缓冲类；是否用于回滚历史未知 |
| Q05 | 吞吐与低延迟 | D S | `RD:115–345` 基准表；`WindTerm/benchmark/urandom_test.sh` | 部分 | 基准来自 1.x 版本，不是 2.7 |
| Q06 | 大规模滚动历史 | D R B S | `SCF:77` `scrollbackLimit=999999`；`BIN` “&Lines of scrollback:”；`RD:195/206` “unlimited”；`SRC/Widgets/ScrollBar.h`（64 位范围） | 矛盾（弱） | 矩阵状态为待实测；默认有上限，与 README 基准的 “unlimited” 不一致 |

## 待实测行与第二轮新增行的静态结论摘要

| ID | 本轮静态补充 |
| --- | --- |
| C14 | 链接层证据表明发布构建启用了 GSSAPI（主程序导入、libssh 导出、链接 Kerberos），反驳“延期”；仍缺受控 KDC 实验 |
| T19 | 扩展点是 `terminal/protocols/*.protocol` 正则定义，随包只有 Telnet |
| T20 | 扩展点是 `terminal/terms/*.term`，含 `deviceAttributes/input/output` 段 |
| F21 | 可拆分为：并发/分块/异步文件参数、权限与修改时间保留、非法路径字符修复、传输暂停/移除、Modem 冲突策略与拖放协议、外部编辑回传、终端目录同步 |
| S11 | 会话树过滤框早已存在，路线图“Search in sessions”的含义未定 |
| Q06 | 默认 999999 行；是否可设为无限待实测 |
| T25/T26 | 定义文件以外，`BIN` 还有 VT52 状态与图形模式相关符号 |
| T27 | 静态可见三种样式与“忽略重复响铃”间隔 |
| T28/T29 | `BIN` 中有分组字符集表，含 Big5-HKSCS、ISO-2022-JP、Shift-JIS |
| S12/S13 | 有 linux/macos/windows sysmon applet，并按系统方案挂载；本地默认开、SSH 默认关、需点击启动 |
| G35–G40 | 动作与默认键齐备；G40 只作用于当前终端视图的 `debugMode` 属性 |

## 静态候选（不在 130 项内，未分配 ID）

以下序号只用于本文引用，**不是稳定 ID**。候选是否成立、是否与已有行合并，需要上游实测后另行决定。“低置信”表示动作只定义在通用资源中，终端菜单未暴露。

| 序号 | 候选能力 | 静态证据（相对 `.reference/`） | 可能关联 |
| --- | --- | --- | --- |
| 1 | 触发器（全局/会话级） | `MNU:747/270` `Terminal.ManageTriggers`/`ManageSessionTriggers`；`TRG` 默认 4 条（Decompressor、Hyperlink、Ip Address、Number Convertor）；`BIN` 类型 “Custom link”“Custom menu”“Highlight text”“Play sound”“Run command”“Send text”“Show tooltip”，事件 “Event: before/after connection/disconnection”；`LOC:4030` | `RD:389` v2.x 自动化方向 |
| 2 | OneKey 凭据模板与登录向导（expect/send） | `MNU:746` `Terminal.ManageOneKeys`；`GCF:56–57` `terminal.expect.username/password`、`GCF:59` `loginWizard.defaultAuthType=OneKey`、`GCF:66`；`BIN` `session.oneKey`、“OneKey Manager”；`LOC:1561/3880` | G06、C11 |
| 3 | 会话导入（OpenSSH config / PuTTY / Shell） | `MNU:220–224`；`BIN` 解析键 Host/HostName/Port/User/IdentityFile/ProxyCommand/ProxyJump/Local/Remote/DynamicForward，路径 “/etc/ssh/ssh_config”“/.ssh/config”“/.putty/sessions”，`terminal.reimportShellSessions`；`LOC:1273` | S01/S02 |
| 4 | 隧道管理器（独立对话框、与会话绑定、状态显示） | `MNU:748`；`LOC:3466` “Tunnels will be refreshed after closing the dialog”；`BIN` “Do you want to remove the selected %1 sessions and binding tunnels?”、“all related tunnels will be closed” | C16–C18 |
| 5 | 内置 X Server（Windows VcXsrv 包装） | `GCF:130–138` `xserver.*`；`BIN` “X Server &Settings...”、“-multiwindow”、“-xkblayout”；`LOC:3388` “Additional parameters for VcXsrv” | C15 |
| 6 | 远端读写剪贴板（OSC 52）权限 | `SCF:11–12` `allowRemoteReadClipboard/WriteClipboard=2`；`BIN` “]52;%c;%s;”、“&Ask/A&llow/&Forbit”；`LOC:2926` | 安全 |
| 7 | 括号粘贴与大段发送确认 | `BIN` “[200~”“[201~”、“You are sending a large amount of text (%1 bytes).” | G12、T12 |
| 8 | SSH 算法、重协商与证书公钥类型配置 | `BIN` `ssh.ciphers/keyExchange/macHashes/publicKeys` 及默认顺序串（含 `*-cert-v01@openssh.com`）；`SCF:44–45` `rekeyDataLimit=1000`、`rekeyTimeLimit=60`；`LOC:523/1603` | C01、C12 |
| 9 | 主机指纹信任管理（信任/取消信任/查看） | `LOC:3064/3133`；`BIN` `ssh.serverFingerprint`、“Failed to retrieve host fingerprint!”；`nm -u BIN` `_ssh_write_knownhost` | C01 |
| 10 | 连接超时、保活与 TCP 选项 | `SCF:15` `connectionTimeout=20`、`SCF:17` `keepAlive=60`、`SCF:27–30` TCP_NODELAY/SO_KEEPALIVE/缓冲区；`LOC:802/2497/1609` | C01–C03 |
| 11 | 应用级全局代理（无/系统/HTTP/SOCKS5，代理 DNS） | `GCF:5–6`；`BIN` `application.proxyHost/Port/User/Password`、“System proxy”、会话代理类型 “Global”；`LOC:3484` | C19/C20 |
| 12 | 终端键盘与初始模式设置 | `SCF:50–63` `altModifierKey`、`answerBack=Wind`、`backspaceKey`、`deleteKey`、`cursorKeysMode`、`numericKeypadMode`、`newLineMode`、`reverseScreenMode`、`formatOtherKeys`（XTerm/Fixterm）、`metaModifierKey`；`LOC:220/352/3523` | T07–T13 |
| 13 | 终端清屏与复位 | `MNU:260–262/297–301` Clear Scrollback/Screen/All，Hard/Soft Reset，Reset Character Set；`ACT:744/950` | — |
| 14 | 命令级导航、选择、复制与命令历史存储 | `MNU:246/265–268`；`GCF:53–55` `commandHistory.days=30/size=10000/storage=true`；`BIN` “%1/commands.history”、`supportsDetectShellCwd`；`LOC:3637/3811` | G02、G17 |
| 15 | 文件面板与终端当前目录同步 | `SCF:2` `filer.autoSyncTerminalFolder=false`；`ACT:172/348`；`BIN` tmux “pane-cwd-changed”；`LOC:3682` | F01、F13 |
| 16 | 远端文件用外部编辑器打开并回传 | `ACT:313/344`；`BIN` `filer.defaultEditor`（按 macOS/Linux/Windows）；`LOC:103` “A remote file has been modified … upload this file back” | F02/F03 |
| 17 | 文件面板辅助：新建链接、属性与权限编辑、复制路径/名称到终端、隐藏项 | `MNU:103/185/187–195/106`；`nm -u BIN` `_sftp_symlink`、`_sftp_chmod`、`_sftp_setstat`；`BIN` “&UID”“&GID”“&Sticky”“O&ctal”；`GCF:23`；`LOC:703` | F01–F07、F13–F20 |
| 18 | 传输队列暂停/恢复/移除与并发参数（F21 拆分候选） | `MNU:238–243`；`SCF:64–72`；`BIN` “&Open directory after download” | F21 |
| 19 | X/Y/Z Modem 冲突策略、填充与拖放协议（F21 拆分候选） | `BIN` “When destination file &exists:” 及 Overwrite/Append/Rename/Resume/Skip、“&Packet padding char:”；`SCF:3`；`LOC:2704/3199` | F10–F12、F21 |
| 20 | 其余会话字符集、十六进制显示与自动检测 | `BIN` 分组字符集表（Arabic、Baltic、Celtic、Central European、Chinese Simplified GB2312/GB18030/GBK、Cyrillic、Greek、Hebrew、Indian ISCII、Korean、Thai、Turkish、Vietnamese、Western、Unicode UTF-16/32 等）、“System”、“Hexadecimal”；uchardet 类 `nsBig5Prober` 等 | T28/T29（矩阵已注明“其他字符集仍待盘点”） |
| 21 | 地址栏快速连接与会话 URL | `TBR:9` `AddressBar`；`MNU:559`；`LOC:2416/3382`；`BIN` 会话 URL 正则；`ACT:771` `CopySessionUrl` | S01 |
| 22 | 断开/重连会话与回车重连 | `MNU:419–420`；`KEY:263` 未连接时 Enter→`ReconnectSession`；`LOC:2938` | C01–C04 |
| 23 | 重新打开已关闭视图与最近会话 | `MNU:75–81`；`ACT:2371`；`BIN` “global/reopen.history”；`LOC:2203` | S07 |
| 24 | 复制 SSH 通道（同连接新通道） | `MNU:385`；`ACT:801`；`LOC:3586` | C06 |
| 25 | 会话颜色/图标与标签标题跟随远端 | `BIN` `session.color`、`session.icon`；`SCF:16/75`；`LOC:2515/2521/3205` | G25 |
| 26 | 标签栏行为与关闭确认 | `GCF:33–40` `tabbar.*`（双击关闭、中键重命名、悬停 0.2 s、序号、省略、缩略图）；`GCF:42–43` | G26、G27 |
| 27 | 多窗口与窗口管理器 | `MNU:417/776–778`；`ACT:6/2697`；`ACT:370` `Mux.MovePaneToNewWindow`；`LOC:3256` | G18 |
| 28 | 停靠窗格布局、栏显隐、工具栏定制与状态栏项 | `MNU:33–61/648–658`；`ACT:2591/2688`；`SBR`（模式、行列、Ln/Ch、方案、时钟、锁屏） | G09–G11 |
| 29 | Anything 面板、跳转行/符号/会话与计算器面板 | `MNU:561–563/624`；`APP/global/palettes/{calculator,goto-line}.palette`；`LOC:226` | G07、G26 |
| 30 | 手动文本高亮标记（Text Marks） | `MNU:252–253/478`；`ACT:1308`；`LOC:3826/4018` | G19、G20 |
| 31 | 字体缩放与文本显示选项（行号、空白、行尾、缩进线、列标记） | `MNU:303–343/673–714`；`ACT:2134`；`GCF` `text.*` | G15、G16 |
| 32 | 列/块选择与高级选择（锁定、拆分、反选、分词符） | `MNU:480–557`；`ACT:1920` `ToggleColumnEdit`；`SCF:73/83` | G29、G37 |
| 33 | 用户自定义动作/键位脚本与配置目录 | `BIN` “user.actions”“user.keymaps”；`ACT`/`KEY` 以 JS `script` 定义；`ACT:10` 配置目录，`BIN` “&Application Directory”“&Home Directory”“.wind/”；`APP/profiles.config` 键 `path` | `RD:381` 脚本/宏/插件路线图 |
| 34 | 本地 Shell 会话启动参数 | `BIN` “&Working directory:”“&Execute command after start:”“&Environment variables:”“&Locale environment variables:”；`SCF:5` `process.locale=Automatic`；`LOC:940/3613` | T01–T06、C05 |
| 35 | 外部工具/方案工具（低置信） | `ACT:2193–2229` `Tool.*`（Build 标注 `"kits": ["Editor"]`）；终端 `MNU` 未暴露；`LOC:958` | `RD:371` 路线图 “External tools” |
| 36 | 内置文本编辑器套件（低置信） | `ACT:89–169` `Editor.*`、`ACT:2243` `Window.ActivateEditor`、`ACT:1179` FindInFiles、`ACT:1170` ExpandSnippet；`GCF:19–22`；发布包中没有编辑器菜单配置 | `RD:364` Command Snippet 延期（文本片段引擎不等于命令片段） |

共 36 项静态候选，其中 2 项低置信。README 路线图中的 Mosh、Rlogin、FTP/FTPS、Chat mode、Log viewer 在 `BIN` 和 `LOC` 中均未找到对应字符串（`ftp` 只出现在 `Sftp*` 类名中），与路线图的“未实现”一致，本文不列为候选。
