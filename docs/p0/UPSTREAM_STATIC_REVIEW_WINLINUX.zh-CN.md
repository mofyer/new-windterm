# P0 上游 Windows/Linux 发布包静态核对（E11）

日期：2026-10-12，在功能基线冻结之后。本文执行[冻结决定](BASELINE_FREEZE_PROPOSAL.zh-CN.md#决定记录2026-10-12)中的 E11：对官方 WindTerm 2.7.0 的 Windows x86_64 与 Linux x86_64 便携包做只读静态核对，并与 [macOS 包的静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md)对照。重点是 T02–T06、Q02、Q03，暂缓候选 C23，F08/F09（E3），以及 G13。

本文**不修改**三处台账（[功能矩阵](../FEATURE_PARITY.zh-CN.md)、[基线台账](BASELINE.zh-CN.md)、[baseline.json](baseline.json)），不新增、不改名任何 ID，也不改变任何一行的状态或计数标记。冻结后的变更规则要求新能力经用户批准才能补入，所以下文的平台专属能力只作为**提议**列出，没有分配 ID。

## 边界声明

- **静态证据不等于行为已验证。** 配置键、字符串、导入符号和随包文件只说明发布包里有入口、代码引用或组件，不能说明功能可用、语义正确或安全。文中标为“推断”的结论尤其需要实机确认。
- 本轮**没有执行**包内任何文件：没有用 wine，没有运行任何二进制或脚本，也没有安装任何东西。两个 zip 只用 `unzip` 解到全新的空目录中。
- 没有把上游代码、图标、二进制或带专有标记的资源复制进仓库。文中只按路径、键名和短语引用。随包第三方组件（VcXsrv、gsudo、Clink、lrzsz、winpty）只作为存在性证据，其许可证见下文，本轮没有做分发评估。
- 本轮只检查 x86_64 包。release 中还有 `WindTerm_2.7.0_Windows_Portable_x86_32.zip`，没有下载，也没有核对。
- 本文的“支持/部分/矛盾/沉默”沿用 [macOS 复核的分类](UPSTREAM_STATIC_REVIEW.zh-CN.md#证据类型与结论分类)，只是对静态材料的分类。台账中各行的静态结论列仍指向 macOS 复核；要改指向本文或改结论，须按变更规则另行修改三处台账。

## 方法

### 材料与身份

来源是 `kingToolbox/WindTerm` 的[官方 2.7.0 release](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0)（release id 204976447，发布于 2025-03-11T19:12:09Z）。2026-10-12 用 `gh release download 2.7.0 -R kingToolbox/WindTerm` 下载。GitHub API 对这些资产不提供 `digest` 字段，下表的哈希是本地下载后计算的，没有发布方摘要可以对照；`WindTerm.exe` 的 PE 安全目录为空，即没有 Authenticode 签名。

| 资产 | 大小（字节） | SHA-256 | 本轮处理 |
| --- | ---: | --- | --- |
| `WindTerm_2.7.0_Windows_Portable_x86_64.zip` | 32678162 | `b05c3c7371340ff1302967247ffcd3a3ba27b237f72010e9157086143c453e50` | 下载、解包、静态核对 |
| `WindTerm_2.7.0_Linux_Portable_x86_64.zip` | 39102499 | `7797697eeb60239020512e2b549695a60c39b3fd01fe7ebb047fd50a2889103c` | 下载、解包、静态核对 |
| `WindTerm_2.7.0_Mac_Portable_x86_64.dmg` | 29737609 | `8c1bc1363e01df5b06f45019da934752f5f29e8603cc843bd38e59bdff121bf7` | 未重新下载；本地副本重算哈希，与[基线台账](BASELINE.zh-CN.md#固定来源与身份)一致 |
| `WindTerm_2.7.0_Windows_Portable_x86_32.zip` | 28769873 | — | 未下载 |

本地位置（主仓库 `.reference/` 下，已被 gitignore）：`upstream-2.7.0-other/downloads/`（两个 zip）、`win-x64/`、`linux-x64/`（各自的解包结果）。

解包前检查了 zip 条目：没有绝对路径，没有 `..`，没有符号链接，顶层只有 `WindTerm_2.7.0/`。Windows 包 4921 条（其中 280 个目录），Linux 包 4271 条（其中 197 个目录）。Linux zip 是在 FAT 文件系统上打包的，条目不带 Unix 权限位，所以解包后 `WindTerm` 和 `vendors/lrzsz/{rz,sz}` 都没有执行位。

关键文件 SHA-256（前 16 位；完整值可用 `shasum -a 256` 复算）：

| 文件 | Windows | Linux | 与 macOS 副本比较 |
| --- | --- | --- | --- |
| 主执行文件 | `WindTerm.exe` `7b10531dccc7cd61` | `WindTerm` `9491b87eec5c4482` | 不同（平台二进制） |
| libssh | `ssh.dll` `1308ce9cc94cbb90` | `lib/libssh.so.4` `7c9c57f5c9f1bb49` | 不同；三者都是 libssh 0.9.6 |
| `global/wind.keymaps` | `a755cee3ea8853d9` | 同 Windows | 仅 10 行行尾为 CRLF，`diff -w` 无差异 |
| `global/wind.config` | `0a4f02250b855e92` | 同 Windows | 仅 BOM 与 `text.fontSize` 不同 |
| `terminal/configs/menu.config` | `3d73970309df346d` | 同 Windows | 仅 BOM 不同 |
| `terminal/configs/session.config` | `e97009e1c57ba177` | 同 Windows | 相同 |
| `global/wind.actions` | `b04eb0101e6d652a` | 同 Windows | 相同 |
| `global/locales/zh-CN.locale` | `43fe4e285fe8718b` | 同 Windows | 相同（34 个 locale 全部相同） |
| `license.txt` | `b1020c9fca7f1ee7` | 同 Windows | 相同 |
| `vendors/vcxsrv/vcxsrv.exe` | `a00a750402f99400` | — | 只在 Windows |
| `vendors/gsudo/gsudo.exe` | `f84ab92aa9648c23` | — | 只在 Windows |
| `vendors/clink/clink_x64.exe` | `d3e2a189bfcc7549` | — | 只在 Windows |
| `terminal/applets/sysmon/windows/WinTop.exe` | `4cda0b74c5baf0da` | — | 只在 Windows |

### 只读工具

`unzip -Z`/`unzip -q`、`file`、`shasum -a 256`、`strings -a`、`xcrun llvm-objdump -p`（PE 导入/导出表、ELF `NEEDED`）、`xcrun llvm-nm -D`（ELF 动态符号）、`nm -u`（macOS 对照）、`diff`、`grep`。Qt 的 `QStringLiteral` 在 MSVC/GCC 下可能是 UTF-16，所以另用一个临时 Python 脚本（`python3 -I`，脚本放在包目录之外，未提交）提取 ASCII 与 UTF-16LE 字符串，合并后再检索；下文“`WBIN` 字符串 0 处”指两种编码合计。

在主仓库根目录可复查关键结论：

```sh
O=.reference/upstream-2.7.0-other; W=$O/win-x64/WindTerm_2.7.0; L=$O/linux-x64/WindTerm_2.7.0
M=.reference/WindTerm-P0.app/Contents/MacOS
shasum -a 256 $O/downloads/*.zip
xcrun llvm-objdump -p "$W/WindTerm.exe" | sed -n '/DLL Name: ssh.dll/,/DLL Name: libcrypto/p' | grep -c ' sftp_'  # 47
xcrun llvm-objdump -p "$W/WindTerm.exe" | sed -n '/DLL Name: ssh.dll/,/DLL Name: libcrypto/p' | grep -ci scp       # 0
xcrun llvm-objdump -p "$W/ssh.dll" | grep -c ' ssh_scp_'                      # 18（库导出，主程序未引用）
xcrun llvm-nm -D --undefined-only "$L/WindTerm" | grep -c ' U sftp_'          # 47
xcrun llvm-nm -D --undefined-only "$L/WindTerm" | grep -ci scp                # 0
xcrun llvm-nm -D --defined-only "$L/lib/libssh.so.4" | grep -c ' ssh_scp_'    # 18
strings -a "$W/WindTerm.exe" | grep -ci scp; strings -a "$L/WindTerm" | grep -ci scp   # 0、0
xcrun llvm-nm -D --undefined-only "$L/lib/libssh.so.4" | grep -c ' gss_'      # 0（macOS libssh：nm -u … | grep -c '^_gss_' 为 18）
diff -w "$M/global/wind.keymaps" "$W/global/wind.keymaps"                     # 无输出
grep -n '"<Ctrl+Enter>"\|"<Shift+Enter>"\|"<Meta+Enter>"' "$W/global/wind.keymaps"   # 1082/1086/1090/1094 与 2346
```

### 路径缩写

均相对主仓库 `.reference/`。macOS 侧的 `RD`、`IMG/`、`BIN`、`FW/`、`KEY`、`GCF`、`ACT`、`SCF`、`MNU`、`TRG`、`LOC` 与 [macOS 复核的路径缩写](UPSTREAM_STATIC_REVIEW.zh-CN.md#路径缩写均相对-reference)相同。由于 `KEY`、`GCF`、`ACT`、`SCF`、`MNU`、`TRG`、`LOC` 在三个平台上内容相同（差异只在 BOM、行尾和一处字号），**这些行号对三个平台都适用**。

| 缩写 | 实际路径 |
| --- | --- |
| `WIN/` | `upstream-2.7.0-other/win-x64/WindTerm_2.7.0/` |
| `LNX/` | `upstream-2.7.0-other/linux-x64/WindTerm_2.7.0/` |
| `WBIN` / `LBIN` | `WIN/WindTerm.exe` / `LNX/WindTerm`（字符串或导入表） |
| `WSSH` / `LSSH` | `WIN/ssh.dll` / `LNX/lib/libssh.so.4` |
| `WV/` | `WIN/vendors/` |

## 结果概览

| ID | macOS 复核结论 | Windows/Linux 静态结论 | 一句话 |
| --- | --- | --- | --- |
| T02 | 部分 | 支持 | `LBIN` 与 macOS 同一套 Unix shell 发现（`/etc/shells`、`SHELL`、`-i -l`、`pwsh`）与 `UnixPty` |
| T03 | 部分 | 支持 | `WBIN` 按 `ComSpec` 启动 cmd，并注入随包 Clink；ConPTY 优先，WinPty 回退 |
| T04 | 部分 | 支持 | 同时发现 Windows PowerShell（`system32/WindowsPowerShell/v1.0`）与 PowerShell 6/7（`App Paths\pwsh.exe`） |
| T05 | 部分 | 支持（机制为推断） | 管理员会话经随包 gsudo 启动，标签前缀 `admin:`；主程序清单为 `asInvoker` |
| T06 | 部分 | 支持（机制为推断） | 同 T05 |
| Q02 | 部分 | 支持 | Windows x86_64 便携包存在；Qt 5.15.2/MSVC 2019；ConPTY 需 Windows 10 19H1，另带 WinPty |
| Q03 | 部分 | 支持 | Linux x86_64 便携包存在；Qt 5.15.2/GCC 5.3.1；只有 xcb 平台插件；glibc ≥ 2.17（推断） |
| C23（暂缓） | 只见设置键 | 证据见下 | Windows 包随附 VcXsrv 1.20.14.0（16 MB、571 个文件），`WBIN` 引用其路径；Linux/macOS 不随附 X Server |
| F08/F09 | 矛盾 | 矛盾（三平台一致） | 三个主程序导入同一组 117 个 libssh 符号，scp 为 0；字符串中也没有 scp |
| G13 | 矛盾 | 矛盾（三平台一致） | 三个平台同一份键位表：`<Ctrl+Enter>` 切换 local↔remote，唯一的 `<Shift+Enter>` 属于大纲 |
| C14 | 支持 | 矛盾（弱，仅 Windows/Linux） | `WSSH`/`LSSH` 都没有链接 GSSAPI/Kerberos 库，macOS 的 libssh 链接了；推断 Windows/Linux 构建未启用 GSSAPI |

另有 9 项平台专属能力或差异，列在[平台专属候选](#平台专属候选提议未分配-id)中，均为提议。

## 三平台默认资源比较

对三个包的 `global/` 与 `terminal/` 逐文件计算 SHA-256（macOS 4012 个，Windows 4022 个，Linux 4020 个），差异只有：

| 差异 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| `GCF:95` `text.fontSize` | 13 | 10 | 10 |
| `global/themes/*/gui.theme` 字号 | 12/13/14pt，另有 `ButtonGroup` 样式 | 9/10/11pt | 同 Windows，多一处 9pt |
| `global/themes/*/scheme.theme` 的 `fontSize` | 13 | 10 | 11 |
| `terminal/schemes/wsl/`（8 个文件，`System: wsl`，“Windows Subsystem for Linux”，`supportsDetectShellCwd: true`） | 无 | 有 | 有（与 Windows 相同） |
| `terminal/applets/sysmon/windows/WinTop.exe` | 无（有同名目录下的 `sysmon.applet`） | 有 | 无 |
| `terminal/applets/sysmon/wsl/sysmon.applet` | 无 | 有 | 无 |

另有只影响格式的差异：Windows/Linux 的 `wind.config`、`menu.config` 带 UTF-8 BOM，`wind.keymaps` 有 10 行以 CRLF 结尾；Linux 的 `tmux-256color.term` 末尾多一个换行。

由此可得：

- **默认资源里没有平台专属的菜单、动作、键位或设置键。** `MNU`、`ACT`、`SCF`、`TRG`、全部 34 个 locale、3809 个命令定义、`*.term`、`*.protocol` 在三个平台上内容相同。G13 的键位、F08/F09 的菜单、X Server 的 `GCF:130–138` 设置键也都一样。
- 平台差异集中在主执行文件和随包组件中，见下一节。
- `license.txt` 三个平台相同。它列出 JsonCpp、Onigmo、cpp-btree、dtl、Boost、PCRE2、ZStandard、Scintilla、Qt、ptyqt、spdlog、breakpad、yaml-cpp、xxHash、Mixkit 音效与 Nerd Fonts，但**没有**列出 libssh、OpenSSL、zlib、winpty、VcXsrv、gsudo、Clink、lrzsz。
- macOS 隔离副本中的 `APP/profiles.config` 在 Windows/Linux 包里没有。该文件在副本中的修改时间是 2026-10-11，可能是入口观察时生成的，因此不作为平台差异。

## 主执行文件与随包组件

| 项 | Windows | Linux |
| --- | --- | --- |
| 主执行文件 | PE32+ x86-64 GUI；链接时间 2025-03-11；子系统版本 6.0；清单 `requestedExecutionLevel level="asInvoker"`；无 VERSIONINFO 资源，无签名 | ELF x86-64，stripped；`RPATH $ORIGIN/lib/` |
| 工具链与 Qt | Qt 5.15.2，MSVC 2019（`Qt5Core.dll` 版本串） | Qt 5.15.2，GCC 5.3.1（Red Hat） |
| 版本串 | `WBIN` 在应用名后有 `2.7.0` | `LBIN` 同 |
| libssh | `ssh.dll`，0.9.6，导出 450 个符号，其中 18 个 `ssh_scp_*`；导入只有 WS2_32、libcrypto、zlib1、KERNEL32、USER32、SHELL32、ADVAPI32 与 CRT | `libssh.so.4`，0.9.6；`NEEDED` 只有 librt、libcrypto 1.1、libz、libc；18 个 `ssh_scp_*` 导出 |
| 主程序对 libssh 的导入 | 117 个（47 个 `sftp_*`、70 个 `ssh_*`），名称集合与 macOS `nm -u BIN` **完全相同** | 同左，集合相同 |
| 本地 PTY | `ConPty`、`WinPty` 两个类；`CreatePseudoConsole`/`ResizePseudoConsole`/`ClosePseudoConsole` 只作为字符串出现，不在导入表和延迟导入表中（推断为运行时解析）；导入 `InitializeProcThreadAttributeList`/`UpdateProcThreadAttribute`/`CreateProcessW`；导入 14 个 `winpty_*`，随包 `winpty.dll`、`winpty-agent.exe` | `UnixPty`，“UnixPty: shell file path must be absolute” |
| 其他系统依赖 | IPHLPAPI `GetTcpTable`、USER32 `SendInput`、ole32 `OleGetClipboard`、`QOperatingSystemVersion::Windows7` | `NEEDED` libX11、libXtst、libGL、libQt5X11Extras；随包 Qt 平台插件中桌面窗口系统只有 xcb（其余为 eglfs、linuxfb、minimal、offscreen、vnc），没有 Wayland 插件；输入法插件 fcitx、ibus、compose；平台主题 gtk3、xdg-desktop-portal；音频 ALSA、媒体 GStreamer |
| glibc | — | 主程序最高 `GLIBC_2.14`，随包库最高 `GLIBC_2.17`、`GLIBCXX_3.4.18`（libstdc++ 不随包） |
| 随包第三方组件 | `WV/vcxsrv`（1.20.14.0，571 个文件）、`WV/gsudo`（1.2.0，.NET 程序集，`LICENSE.txt` 为 MIT）、`WV/clink`（1.3.15，`LICENSE` 为 GPLv3）、`WV/lrzsz`（0.12.20，PE32 i386，`COPYING` 为 GPLv2） | `vendors/lrzsz/{rz,sz}`（ELF x86-64，**没有** COPYING） |
| 安装与集成 | 便携 zip，无安装器；随包 MSVC 运行库；Breakpad 崩溃转储（`%s\%s.dmp`） | 便携 zip，无安装脚本；`windterm.desktop` 的 `Exec=/usr/bin/windterm`，包内没有放置该路径的步骤；`StartupWMClass=Code` |

用 Qt 助记符（`&` 加字母）提取三个主执行文件的界面标签并比较集合，没有发现某个平台独有的菜单或对话框标签（差异只是提取噪声）。与平台相关的字符串只有下面这些：

| 用途 | macOS（`BIN`） | Windows（`WBIN`） | Linux（`LBIN`） |
| --- | --- | --- | --- |
| 点击提示 | “Command+Click to follow link / execute command / send text” | “Ctrl+Click …”（同三条） | 同 Windows |
| 在文件管理器中显示 | AppleScript `tell application "Finder" to reveal …` | `explorer.exe` | `dbus-send … org.freedesktop.FileManager1` |
| 在系统终端打开目录 | AppleScript `tell application "Terminal" to do script "cd %1"` | 未见 | 未见 |
| 本地 shell 发现 | `/etc/shells`、`SHELL`、`-i -l` | 见 T03–T06 | 同 macOS |
| PuTTY 会话导入来源 | `/.putty/sessions` | `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions` | `/.putty/sessions` |
| OpenSSH 配置 | `/etc/ssh/ssh_config`、`/.ssh/config` | 只有 `/.ssh/config` | 同 macOS |
| X11 本地套接字 | `/tmp/.X11-unix/X%1` | 未见；改用 `localhost:%1` 与随包 VcXsrv | `/tmp/.X11-unix/X%1` |
| 列选择剪贴板格式 | Scintilla `…rectangular` | `MSDEVColumnSelect` | `text/x-rectangular-marker` |

`LOC:712/3730/3733` 是 Ctrl+Click 三条，`LOC:4159/4162/4165` 是 Command+Click 三条，locale 两套都有，但每个平台的二进制只含其中一套。

## 逐 ID 发现

### 本地 Shell：T02–T06

| ID | Windows/Linux 静态证据 | 结论 | 备注 |
| --- | --- | --- | --- |
| T02 Linux bash/zsh/PowerShell Core | `RD:64`；`LBIN` “/etc/shells”、“SHELL”、“-i -l”、“pwsh”、“tcsh”，`UnixPty`；`LNX/terminal/schemes/linux/`、`LNX/terminal/applets/sysmon/linux/` | 支持 | 与 T01（macOS）同一类证据；bash、zsh 不是硬编码名称，而是从 `/etc/shells` 发现 |
| T03 Windows Cmd | `RD:63`；`WBIN` “ComSpec”，cmd 参数 `/s /k "${AppDir}/vendors/clink/clink_x64.exe" inject`；`WV/clink/`；PTY 证据见上表；`LOC:3253` “Windows 10 version below 19H1 (build 18309) is not supported.” 与 `LOC:3259` “Winpty-agent.exe or winpty.dll not found!.” 两句都出现在 `WBIN` 中 | 支持 | 上游 cmd 会话默认注入 Clink（Clink 提供行编辑、历史与补全增强）。P0 原型用的是 `cmd.exe /D /Q /K`，不带 Clink，也关闭了 AutoRun。19H1 提示与 WinPty 回退并存，哪些 Windows 版本实际可用需实机确认 |
| T04 Windows PowerShell | `WBIN` “system32/WindowsPowerShell/v1.0”、“powershell”；`HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\pwsh.exe` 与标签 “powershell 6\|7”；正则 `[\\/](wsl\|cmd\|pwsh\|powershell)\.exe\s*$`；`WIN/terminal/schemes/powershell/` 与 3696 个命令定义（三平台相同） | 支持 | 上游区分 Windows PowerShell 5.1 与 PowerShell 6/7 两种会话；`IMG/WindTerm.png` 标签 “powershell 6\|7” 与此一致 |
| T05 Windows 管理员 Cmd | `WBIN` “${AppDir}/vendors/gsudo/gsudo.exe”、“gsudo.exe”、第二条以空格开头的 Clink 注入参数、标签前缀 “admin:”；`WV/gsudo/`（含 `Invoke-gsudo.ps1` 与 PowerShell 模块）；主程序清单 `asInvoker`，导入表没有 `ShellExecuteExW`，字符串没有 “runas” | 支持（机制为推断） | 推断：管理员会话由随包 gsudo 提权后启动 cmd（并注入 Clink），WindTerm 本身不提权。UAC 提示、拒绝提权后的反馈与权限隔离（T05 验收要点）都需实机 |
| T06 Windows 管理员 PowerShell | 同 T05；`IMG/WindTerm.png` “admin:powershell” | 支持（机制为推断） | 同上 |

除 T03–T06 外，`WBIN` 还会发现 WSL 发行版、Git Bash 与 Cygwin，见[候选 WL-1、WL-2](#平台专属候选提议未分配-id)。`WBIN` 与 `LBIN` 中还有 T34 的全部启动参数字符串（“&Working directory:”“&Execute command after start:”“&Environment variables:”“&Locale environment variables:”），与 macOS 相同。

### 平台：Q02、Q03

| ID | 静态证据 | 结论 | 对“安装、升级、发行版矩阵”的提示 |
| --- | --- | --- | --- |
| Q02 Windows 平台 | `RD:68`；Windows x86_64 与 x86_32 两个便携包；见上表 | 支持 | 上游只有便携 zip，没有安装器，也未见更新检查字符串；ConPTY 要求 Windows 10 19H1（build 18309）及以上，另带 WinPty；导入 `QOperatingSystemVersion::Windows7`，推断有按系统版本的分支；主程序无签名 |
| Q03 Linux 平台 | `RD:68`；Linux x86_64 便携包；见上表 | 支持 | 只有 x86_64，没有 arm64；只带 xcb 平台插件，推断 Wayland 下需经 XWayland；推断最低 glibc 2.17、libstdc++ `GLIBCXX_3.4.18`；系统需提供 libX11、libXtst、libGL；随包 fcitx/ibus 输入法插件；`.desktop` 指向包内未提供的 `/usr/bin/windterm`；zip 无执行位 |

### C23 内置 X Server（暂缓候选，只列证据）

C23 仍是暂缓候选，本文**不做决定**，只记录证据。

- **只有 Windows 包随附 X Server。** `WV/vcxsrv/` 共 571 个文件、约 16 MB：`vcxsrv.exe`（PE32+ x86-64，`version.txt` 为 `1.20.14.0`）、`xkbcomp.exe`、`xrdb.exe`、`libX11.dll`、`libxcb.dll` 等 X 库、`libcrypto-1_1-x64.dll`、MSVC 运行库、`xkbdata/`、`locale/`、`bitmaps/`、`X0.hosts`（内容为 `localhost` 与 `inet6:localhost`）、`system.XWinrc`、`help.md`、`protocol.txt`。没有字体目录。
- **只有 `WBIN` 会启动它。** `WBIN` 有 “/vendors/vcxsrv/vcxsrv.exe”、“XServer failed to start.”，启动参数串 “-multiwindow”“-fullscreen”“-xkblayout”“-xkbmodel”“-keyhook”“-nokeyhook”“-noprimary”“-noclipboard”“-notrayicon”“+extension”，以及 “DISPLAY”“localhost:%1”。没有 “-ac”（关闭访问控制）。IPHLPAPI `GetTcpTable` 可能用于 `xserver.displayNumber=-1` 时找空闲显示号（推断）。
- **三平台共有的部分。** `GCF:130–138` 的 `xserver.*` 默认值（`autoStart=false`、`clipboard=true`、`displayNumber=-1`、`keyhook=false`、`primarySelection=true`、`trayIcon=false`、`xkbLayout=auto`、`xkbModel=pc105`、`windowMode=MultiWindows`）三平台相同。“&X Server”“X Server &Settings...”“Additional parameters for &VcXsrv:”（`LOC:3388`）、“/vendors/vcxsrv/help.md”、C15 的 “&Internal X display / &External X display” 也在 `BIN`、`WBIN`、`LBIN` 中都有。`MNU` 和 `ACT` 中没有 X Server 条目，菜单项由代码创建。
- **推断。** Linux/macOS 包里有 X Server 设置界面的字符串，却没有可启动的 X Server，也没有 “XServer failed to start.”；这两个平台上是隐藏该菜单还是只用系统 X 服务器（`/tmp/.X11-unix/X%1`），需实机确认。
- **许可证证据。**
  - `WV/vcxsrv/` 里没有 VcXsrv 自身的顶层许可证或 COPYING，只有 `bitmaps/COPYING`（The Open Group 的宽松许可声明）和 `xkbdata/*/README`；顶层 `license.txt` 也没有列出 VcXsrv。
  - VcXsrv 上游项目的许可证本轮没有核对。在 C23 做分发决定之前，需要单独核查其许可证与随包依赖（含 OpenSSL 1.1）。
  - 同目录的 Clink 为 GPLv3、lrzsz 为 GPLv2、gsudo 为 MIT。

### F08/F09 SCP

- **导入。** `WBIN` 与 `LBIN` 对 libssh 的导入和 macOS `BIN` 是同一组 117 个名称：47 个 `sftp_*`、70 个 `ssh_*`，scp 为 0。
- **随包 libssh 的导出。** `WSSH` 与 `LSSH` 各导出 18 个 `ssh_scp_*`，主程序都没有引用；macOS 的 `FW/libssh.4.dylib` 导出 22 个（多 4 个内部符号）。
- **字符串。** `WBIN`、`LBIN` 的 ASCII 与 UTF-16LE 字符串中，不分大小写的 “scp” 都是 0 处，所以也没有 `scp -t`/`scp -f` 这类远端命令串。macOS `BIN` 的 11 处匹配都是二进制噪声或无关的 OpenSSL 格式串。
- **资源。** `MNU`、`ACT`、`LOC` 三平台相同，都没有 SCP 文案。“scp” 只出现在 `TRG` 的超链接正则 `scp://` 中。
- **结论：矛盾，三平台一致。** 2.7.0 的三个 x86_64 官方包都没有可见的 SCP 入口或 SCP 代码引用。这仍是静态弱反证：不能排除运行时拼接命令或其他实现方式。

### G13 本地/远程模式快捷键

- **三平台同一份键位表。** `diff -w` 无差异，Windows 与 Linux 完全相同。
  - `KEY:1082–1097`：`<Ctrl+Enter>` 在 normal↔command、local↔remote 之间切换。
  - `KEY:65`：local 模式下 `i` 切到 remote。`KEY:285`：normal 模式下 `<Esc>` 切到 command。
  - `KEY:2346`：全文件唯一的 `<Shift+Enter>`，限定在大纲树（`OutlinePane.RepeatedlyExecute`）。
  - 没有 `<Meta+Enter>`。键位表本身没有按平台区分的条件。
- **Windows/Linux。** Qt 的 Ctrl 就是物理 Ctrl 键，所以静态默认键是 Ctrl+Enter。`RD:83` 的 Shift+Enter 与两个平台的默认键位都冲突。
- **macOS。** macOS 二进制把三条点击提示写成 “Command+Click”，Windows/Linux 写成 “Ctrl+Click”。这是弱旁证：上游在 macOS 上沿用 Qt 默认的 Ctrl→⌘ 映射，`<Ctrl+Enter>` 在 macOS 上可能是 ⌘↩。仍需实机确认。
- **结论：矛盾，三平台一致。**

### 其他受影响的行

| ID | Windows/Linux 静态证据 | 说明 |
| --- | --- | --- |
| C14 gssapi-with-mic | `SCF:40` 默认 `ssh.authGssapiWithMic=true` 三平台相同；三个主程序都导入 `ssh_userauth_gssapi`；但 `WSSH` 不导入任何 GSSAPI/SSPI 库，`LSSH` 的 `NEEDED` 没有 libgssapi_krb5、未定义符号中 `gss_` 为 0；macOS libssh 未定义 18 个 `_gss_*` 并链接 `Kerberos.framework` | 推断 Windows/Linux 的 libssh 编译时未启用 GSSAPI，这两个平台上 gssapi-with-mic 可能无法成功。C14 的 KDC 实验应分平台记录 |
| C15 X11 forwarding | Windows 的 “Internal X display” 对应随包 VcXsrv；Linux/macOS 引用 `/tmp/.X11-unix/X%1`，Windows 没有 | “本地 X 服务依赖”在三个平台上来源不同 |
| C09 SSH agent | “&pageant”“$SSH_AUTH_SOCK”“&Unix domain socket” 三平台都有；未见 Windows OpenSSH agent 命名管道串 | Windows 上是否支持 OpenSSH for Windows 的 agent 未知 |
| F12 ZModem | `WBIN` “/vendors/lrzsz/sz.exe”“/vendors/lrzsz/rz.exe”；`WV/lrzsz` 为 PE32 i386 0.12.20，带 GPLv2 `COPYING`；`LNX/vendors/lrzsz` 为 ELF，不带 COPYING | 与 macOS 一样随包 lrzsz，不得复制 |
| S12 本地 Shell Sysmon | `WIN/terminal/applets/sysmon/windows/sysmon.applet` 运行 `properties.dirName + '/wintop.exe'`，对应随包 `WinTop.exe`（PE32+ 控制台程序）；WSL applet 运行 `wsl sh -c "… top -b -n 2 …; free …"` | macOS 包有 windows applet 但没有 `WinTop.exe`；Windows 本地 sysmon 依赖上游私有辅助程序 |
| S14 会话导入 | PuTTY 来源 Windows 为注册表，macOS/Linux 为 `~/.putty/sessions`；`/etc/ssh/ssh_config` 只在 macOS/Linux；Windows 的 Shell 会话导入（`LOC:2563` “Shell sessions”，`terminal.reimportShellSessions`）覆盖 cmd、PowerShell、pwsh、WSL、Git Bash、Cygwin 与 admin 变体 | 导入来源按平台不同 |
| G24、G51 主题与字号 | 默认字号 macOS 13，Windows/Linux 10；主题 GUI 字号相差 3pt | 只是默认值差异 |
| G52 列/块选择 | 列选择剪贴板格式按平台不同（见上表） | 与其他编辑器互通的格式按平台不同 |
| G01、G02、T23、T24 | locale、命令定义、Nerd Font 三平台相同 | 无平台差异 |

## 平台专属候选（提议，未分配 ID）

下列序号只供本文引用，**不是稳定 ID**。按冻结的变更规则，新能力须附证据并经用户批准，才能以新 ID 补入，且须同步三处台账并重跑[结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证)。“建议”一列只是提议。

| 序号 | 候选能力 | 静态证据 | 可能关联 | 建议 |
| --- | --- | --- | --- | --- |
| WL-1 | WSL 发行版作为本地 Shell 会话（枚举、启动、当前目录检测、wsl 方案与 sysmon） | `WBIN` “wsl.exe”“--list”“--quiet”“~ -d %1”，`wsl.exe sh -c "…readlink /proc/%1/cwd…"`，`\\wsl$\%1`；`WIN/terminal/schemes/wsl/`；`WIN/terminal/applets/sysmon/wsl/` | T03、T04、T34、S12、F22 | 纳入新 ID（T 系列，Windows）；README 未列出，属于静态发现 |
| WL-2 | Git Bash 与 Cygwin 本地 Shell 自动发现 | `WBIN` `HKEY_LOCAL_MACHINE\SOFTWARE\GitForWindows`、“InstallPath”、“gitbash”、“--login -i”；`HKEY_LOCAL_MACHINE\SOFTWARE\Cygwin\setup`、“rootdir”、“/bin”、“bash.exe”、“cygwin” | T02、T03、S14 | 纳入新 ID，或与 WL-1 合并为“Windows 其他本地 shell 自动发现” |
| WL-3 | cmd 会话注入 Clink 行编辑 | `WV/clink/`（1.3.15，GPLv3）；`WBIN` `/s /k "${AppDir}/vendors/clink/clink_x64.exe" inject`（两条，推断分别用于普通与管理员会话） | T03、T05、G02 | 暂缓：随附 GPLv3 组件需许可证与分发评估；T03 验收不依赖它，但实机对照时要记录上游 cmd 带 Clink |
| WL-4 | Windows PTY 后端（ConPTY 优先，WinPty 回退）与最低 Windows 版本 | `WBIN` `ConPty`/`WinPty`、`LOC:3253/3259`；随包 `winpty.dll`、`winpty-agent.exe` | Q02、T03 | 不单列；建议在 Q02 措辞中写明最低 Windows 版本以实机为准 |
| WL-5 | 管理员会话经随包 gsudo 提权 | 见 T05 | T05、T06 | 不单列；作为 T05/T06 的上游机制记录 |
| WL-6 | Windows 本地 sysmon 辅助程序与 WSL sysmon | 见 S12 行 | S12 | 不单列；并入 S12 的平台范围 |
| WL-7 | Linux 输入法插件与 X11 依赖 | `LNX/lib/platforminputcontexts/` fcitx、ibus、compose；只有 xcb 平台插件 | Q03 | 不单列；并入 Q03 的发行版矩阵与输入法验收 |
| WL-8 | 系统文件管理器/系统终端集成 | Windows `explorer.exe`；Linux `dbus-send … FileManager1`；macOS AppleScript Finder/Terminal；`ACT:881` “Open Log &Folder” | S05、F13 | 不单列；低优先 |
| WL-9 | 列选择剪贴板格式互通 | `MSDEVColumnSelect`、`text/x-rectangular-marker`、Scintilla `rectangular` | G52 | 不单列；并入 G52 的跨应用粘贴验收 |

**2026-10-12 处理结果**：用户批准把 WL-1、WL-2、WL-3 以新 ID 补入三处台账，分别为 T35、T36、T37（见[冻结后新增记录](BASELINE_FREEZE_PROPOSAL.zh-CN.md#冻结后新增2026-10-12-用户批准)）。WL-3 原建议为“暂缓”，现仅作为上游能力记录，不承诺捆绑 Clink，实现前须先做 GPLv3 许可证与分发评估。WL-4–WL-9 仍不单列。上表“建议”列保留静态复核时的原文，不代表当前处理。

**反向差异**（macOS 有、Windows/Linux 没有）只有平台集成层面的几项：AppleScript 的 Finder 与 Terminal 集成，macOS libssh 的 GSSAPI/Kerberos 链接，以及 “Command+Click” 提示。默认资源中没有只属于 macOS 的菜单、动作、键位或设置。

## 对冻结台账措辞条件的影响

本文不改台账。以下是需要协调者知道、但须另行按变更规则处理的点：

1. **F08/F09（E3）。** 验收要点的前置条件是“先在 2.7 各平台发布包与实机确认 SCP 入口”。
   - 其中“各平台发布包”一半，现在三个 x86_64 包都已静态核对，结果一致为没有 SCP 入口或代码引用。
   - “实机”一半还没做，所以计数标记应保持 `conditional_upstream_check`。
   - 实机若也确认不存在，按 E3 改为 `project_enhancement`。静态结果本身不触发这一改动。
2. **G13（E2）。** 现行措辞已与具体键位解耦，写的是“以上游 2.7 各平台实测为准”，无需修改。
   - 静态上，三个平台的默认键位表都是 Ctrl+Enter；Windows/Linux 就是物理 Ctrl+Enter。
   - 只有 macOS 的物理按键仍待实机，弱旁证指向 ⌘↩。
3. **T04–T06（可选措辞澄清，需批准）。**
   - T04 可写明覆盖 Windows PowerShell 5.1 与 PowerShell 6/7 两种会话。
   - T05/T06 可把“上游经随包 gsudo 提权”记为对照基准。
4. **C14。** Windows/Linux 很可能没有 GSSAPI 支持。决定 C14 的状态时，宜按平台分别记录，避免把 macOS 的链接证据推广到三个平台。
5. **C23（暂缓）。** 已有 Windows 随包 VcXsrv 的证据与许可证缺口（包内没有 VcXsrv 许可证文本）。按冻结决定，C23 在实机盘点与 E11 之后再定；本文只完成 E11 的静态部分。
6. **静态结论列。** T02–T06、Q02、Q03 在台账中的静态结论仍是“部分”，链接指向 macOS 复核。是否改为指向本文、改为“支持”，需另行修改三处台账。

## 未做与后续

- 没有运行上游 Windows/Linux 程序，没有在 Windows 或 Linux 实机或虚拟机中做任何观察。T03–T06 的提权与取消流程、19H1 以下的 WinPty 回退、Linux Wayland 与输入法、C23 菜单在 Linux/macOS 上的表现，都只是静态推断。
- 没有检查 Windows x86_32 包。
- 没有对 VcXsrv、Clink、gsudo、winpty、lrzsz 做许可证与分发评估，也没有核对 VcXsrv 上游许可证原文。
- 没有反汇编，也没有分析控制流；所有“推断”都只基于导入表、字符串与随包文件。
