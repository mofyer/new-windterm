# T31 终端键盘与初始模式：上游盘点、实现路径与第一部分

日期：2026-11-07。分支：`p1/keyboard-modes`，基于 `p1/integration` 的 `dd11418`。对应功能 ID：T31（终端键盘与初始模式设置），不新增、不修改 ID，台账状态保持“未实现”。

## 1. 边界

- 上游只有**静态证据**：发布包默认配置、主执行文件字符串与 zh-CN 语言包文案。没有启动上游，也没有实测任何一项设置的发送字节或回复；[实机记录](../p0/UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)未涉及键盘设置。下表“推断”列都需要实机核对，不能当作上游行为。
- 本项目的验证只在 Chrome + 浏览器 IPC stub 中进行：Playwright/CDP 注入按键，`navigator.platform` 冒充 macOS / Windows / Linux，不经过系统键盘布局、原生输入法、WKWebView / WebView2 / WebKitGTK、Rust、PTY、SSH 或 TCP。浏览器测试通过不代表原生输入或真实主机程序（vim、tmux、readline）的行为。
- 第一部分只交付第 5 节的四个选项。T31 其余验收要点（answerBack、小键盘、换行模式、反显、Alt/Meta 的 8 位字符、formatOtherKeys、vim/tmux 核对、上游对照）未完成，T31 未完成。

## 2. 上游静态盘点

材料与缩写同[静态复核](../p0/UPSTREAM_STATIC_REVIEW.zh-CN.md#路径缩写均相对-reference)：`SCF` 为 macOS 包 `terminal/configs/session.config`，`LOC` 为 `global/locales/zh-CN.locale`（行号为 `"en"` 所在行），`BIN` 为主执行文件 `strings -a -n 4` 的输出（只引短语，不给行号）。Windows x86_64 与 Linux x86_64 便携包的 `session.config` 第 50–63 行取值与 macOS 包相同，三个平台没有按平台区分的默认值。

设置界面在 `BIN` 中依次出现这些标签：`Backspace sends:`、`Delete sends:`、`&Alt modifier key sends:`、`&Meta modifier key sends:`、`Modified other keys sends:`，随后是 `Initial modes:` 分组下的 `Cursor Keys mode (DECCKM):`、`Numeric keypad mode (DECNKM):`、`&Auto Wrap Mode (DECAWM)`、`&New Line Mode (LNM)`、`&Reverse Screen Mode (DECSCNM)`、`&Use background color to erase screen`、`&Answer back:`。各选项的单选文字集中出现在另一处：`&Backspace` + `Ctrl+H (Ascii 0x08)`、`&Delete` + `Ctrl+? (Ascii 0x7F)`、`&XTerm format` + `CSI 27;<mod>;<char>~`、`&Fixterm format` + `CSI <char>;<mod>u`、`8-bit characters`、`Characters preceded by ESC`、`&Normal`、`&Application`。它们之前紧挨着一个 `&Automatic`，但再之前是 `&Identity file for authentication:`，归属无法从字符串顺序判断。

| 配置键（`SCF:50–63`） | 默认值 | 界面文案（`LOC` 译文） | 静态可见取值 | 推断（待实机） |
| --- | --- | --- | --- | --- |
| `terminal.backspaceKey` | `0` | `Backspace sends`（`LOC:352` 退格键发送） | `Backspace` = Ctrl+H 0x08；`Delete` = Ctrl+? 0x7F | 两个取值；`0` 对应哪一个、是否另有“自动”未知。若按字符串顺序，`0` 会是 ^H，与多数终端默认 DEL 相反，因此不能按顺序推定 |
| `terminal.deleteKey` | `0` | `Delete sends`（`LOC:775` 删除键发送） | 未见单独的转义序列文案；推测与退格键共用上面两个单选 | 默认是否为 `ESC [ 3 ~`、可选值集合均未知 |
| `terminal.altModifierKey` | `0` | `Alt modifier key sends`（`LOC:3523` 按下Alt修饰键发送） | `8-bit characters`（`LOC:3520` 8位字符）/ `Characters preceded by ESC`（`LOC:3547` 由ESC键作为前导的字符） | `0`/`1` 与两项的对应未知；UTF-8 下“8 位字符”发原始高位字节还是 U+0080+c 的 UTF-8 未知 |
| `terminal.metaModifierKey` | `1` | `Meta modifier key sends`（`LOC:3616`） | 同上 | 默认与 Alt 不同。上游为 Qt 程序，Qt 在 macOS 上的 Meta 修饰默认对应物理 Control 键，在 Windows 上对应 Win 键；实际按哪个键生效需实机 |
| `terminal.formatOtherKeys` | `0` | `Modified other keys sends`（`LOC:1660` 其他修饰键发送） | `XTerm format`（`CSI 27;<mod>;<char>~`）/ `Fixterm format`（`CSI <char>;<mod>u`） | 与 xterm 的同名资源一致（0 为 `CSI 27 ; m ; c ~`），推断默认 XTerm 格式；只在 modifyOtherKeys 开启时生效。`BIN` 有 `setKeyModifier` / `resetKeyModifier` / `requestKeyModifier`，推测支持主机用 XTMODKEYS 开启 |
| `terminal.cursorKeysMode` | `0` | `Cursor Keys mode (DECCKM)`（`LOC:721` 译文“鼠标键模式（DECCKM）”，疑为误译） | `Normal` / `Application` | `0` 为常规（推断），为初始模式 |
| `terminal.numericKeypadMode` | `0` | `Numeric keypad mode (DECNKM)`（`LOC:1837` 数字键盘模式） | `Normal` / `Application` | `0` 为常规（推断） |
| `terminal.newLineMode` | `false` | `New Line Mode (LNM)`（`LOC:1708` 新命令行模式（LNM）） | 复选框 | 初始 LNM；是否同时影响回车键发送 CR LF 未知 |
| `terminal.reverseScreenMode` | `false` | `Reverse Screen Mode (DECSCNM)`（`LOC:2329` 屏幕反色模式） | 复选框 | 初始反显 |
| `terminal.answerBack` | `"Wind"` | `Answer back`（`LOC:220` 回复） | 文本框 | 收到 ENQ（0x05）时回复该字符串（推断）；上游默认会回复 `Wind` |

同一“初始模式”分组里还有 `terminal.autoWrapMode: true`（DECAWM，归 T18 自动换行的“开关”）与 `terminal.eraseWithBackground: true`（背景色擦除），不在 T31 验收列表中，本文不处理。没有找到“回车发送 CR / CR LF”“Home/End 模式”或左右 Option 分别设置的配置键或文案；`Convert CRLF and LF to CR`（`LOC:658`）属于粘贴，不是键盘设置。

复查命令（主仓库根目录，只读）：

```sh
R=.reference/WindTerm-P0.app/Contents/MacOS
sed -n '50,63p' "$R/terminal/configs/session.config"
strings -a -n 4 "$R/WindTerm" | grep -n 'Backspace sends\|Ctrl+H (Ascii\|Ctrl+? (Ascii\|8-bit characters\|preceded by ESC\|Fixterm format\|CSI 27;\|KeyModifier'
grep -n -A1 '"en": "Backspace sends"\|"en": "Delete sends"\|"en": "Alt modifier key sends"\|"en": "Meta modifier key sends"' "$R/global/locales/zh-CN.locale"
```

## 3. 当前实现（xterm.js 6.0.0）

已有探针见 [INPUT_PATHS](../p0/INPUT_PATHS.zh-CN.md#按键input-keysspects12-项) 与 `terminal-regressions-keys.spec.ts`，摘要：

- Backspace 发送 DEL，Ctrl+Backspace 发送 BS，Alt+Backspace 加 ESC 前缀；Delete 发送 `ESC [ 3 ~`，带修饰键为 `ESC [ 3 ; n ~`；Home/End 随 DECCKM 为 `ESC [ H/F` 或 `ESC O H/F`；回车始终发送 CR。
- macOS 上 `macOptionIsMeta` 默认关闭，Option+F 输入布局字符 `ƒ`；Windows / Linux 上 Alt 即 Meta（ESC 前缀），Windows 把 Ctrl+Alt 当作 AltGr。xterm.js 没有关闭这一行为、也没有“8 位字符”的选项。
- DECCKM 由主机切换；RIS 与 DECSTR 都恢复为常规模式。DECKPAM/DECKPNM 只记录模式（DECRQM `?66`），小键盘没有应用模式编码。LNM（`CSI 20 h`）只实现显示的一半（`options.convertEol`，LF 回到第 1 列），且 RIS 不清除（已知缺陷）。DECSCNM 不支持（[VT_MATRIX](../p0/VT_MATRIX.zh-CN.md) D07）。ENQ 没有回复。不支持 XTMODKEYS（`CSI > 4 ; n m`）与 DECBKM（`CSI ? 67 h/l`）。
- xterm.js 公开的 parser 钩子只有 CSI、DCS、ESC、OSC 四类，没有 C0 控制字符（如 ENQ）的钩子，也没有“内置处理之后”运行的钩子。

## 4. 实现路径分类

| 项 | 手段 | 对默认行为的影响 | 本次 |
| --- | --- | --- | --- |
| macOS Option 作 Meta | xterm.js 公开选项 `macOptionIsMeta`，按会话设置 | 默认不设置 | **交付** |
| 初始 DECCKM | 会话开始时对本地 xterm 写入 `CSI ? 1 h`（公开 `write`，与 T32 动作同一做法），不经 `*_write` | 默认不写入 | **交付** |
| Backspace / Delete 发送值 | 输入路径映射：xterm.js 先按自身规则决定是否发送，经 `onKey` 报告后，在会话的 `onData` 中只替换这两个键的字节 | 默认不挂监听 | **交付** |
| 初始 LNM | 本地 `CSI 20 h` 或公开 `options.convertEol` 可设显示一半；回车发送 CR LF 需输入映射。若对所有会话按 LNM 改发 CR LF，默认会话在主机设置 LNM 后的按键字节会变 | 见 Q2 | 不交付 |
| 初始 DECNKM 与应用小键盘编码 | 公开 `modes.applicationKeypadMode` + `KeyboardEvent.code` 映射 `ESC O p…y` 等。vim、less 的 `smkx` 常发 `ESC =`，实现编码会改变默认会话的小键盘字节；只设初始模式而不实现编码则没有可观察效果 | 见 Q3 | 不交付 |
| DECSCNM 反显（含初始反显） | 公开 CSI 钩子接管 `CSI ? 5 h/l` 与 DECRQM，并交换主题前景/背景（渲染层近似，需核对选区、光标与 SGR 7） | 默认不变 | 后续 |
| answerBack | 需要处理 C0 ENQ：公开 API 没有该钩子，只能用内部 API、受控分支或字节流预处理，均触及[终端内核 ADR](../p0/TERMINAL_CORE_ADR.zh-CN.md) 门禁；另外上游默认 `Wind` 与“默认零变化”冲突 | 见 Q4 | 只写文档 |
| Alt/Meta 发送“8 位字符” | 输入映射可做；UTF-8 / 其他会话编码下的字节语义需先实机核对上游 | 默认不变 | 见 Q5 |
| Meta 修饰键（Qt Meta） | 浏览器的 `metaKey` 在 macOS 是 Cmd，已用于应用快捷键（⌘K 命令面板等）；上游的 Meta 在 macOS 推测是 Control 键 | — | 待实机 |
| formatOtherKeys（modifyOtherKeys） | 公开 CSI 钩子处理 `CSI > 4 ; n m`（及查询），再在输入路径编码带修饰键的普通键。不必改内核，但主机（如 vim 9 对 xterm 类 `TERM`）开启后默认会话的字节会改变 | 见 Q6 | 后续 |
| DECBKM 主机切换退格 | 公开 CSI 钩子 + 映射 | 默认不变 | 后续 |
| 主机 RIS 后恢复会话初始模式 | xterm 的 `appcursorDefault` 等会在 RIS 后恢复；xterm.js 没有“内置 RIS 之后”的公开钩子，在 RIS 后的同一块里按顺序补设只能靠字节流预处理或内核改动，触及 ADR | 默认不变 | 见 Q1，只写文档 |

## 5. 第一部分交付

### 5.1 选项

| 选项 | 取值（默认在前） | 对应上游 | 实现 |
| --- | --- | --- | --- |
| 退格键（Backspace）发送 | DEL 0x7F / BS 0x08 | `backspaceKey` 的两个单选 | 映射。选 BS 时：Backspace、Shift+Backspace、Cmd+Backspace 发 BS；Ctrl+Backspace 发 DEL（与默认的“Ctrl 发另一个”对称）；Alt 组合保留 ESC 前缀（ESC BS / Ctrl+Alt 为 ESC DEL） |
| 删除键（Delete）发送 | `ESC [ 3 ~` / DEL 0x7F / BS 0x08 | `deleteKey`（默认值与取值集合待核） | 映射。只替换不带修饰键的 Delete；Shift/Ctrl/Alt/Meta+Delete 仍为 `ESC [ 3 ; n ~`，因为单字节无法表达修饰键 |
| macOS Option 键 | 输入键盘布局字符 / 作为 Meta 发送 ESC 前缀 | `altModifierKey` 的“由 ESC 作为前导的字符” | `macOptionIsMeta`。仅 macOS 可选；其他平台控件禁用并说明 Alt 始终为 Meta |
| 初始光标键模式（DECCKM） | 常规 / 应用 | `cursorKeysMode` | 会话开始时本地写入 `CSI ? 1 h` |

上游默认值与本项目默认值的关系：本项目默认值保持现有行为。退格键 DEL、删除键 `ESC [ 3 ~`、macOS Option 不作 Meta 是否与上游 `0`/`1` 默认一致，需实机核对；DECCKM 默认常规与上游推断一致。

### 5.2 语义细则

- **默认零变化**：默认会话不设置 `macOptionIsMeta`、不写入任何初始序列、不注册 `onKey` 监听，`onData` 原样发送。浏览器测试逐项对比了默认会话与改动前的键表。
- **映射不截获组合键**：自定义按键处理（⌘K / Ctrl+Shift+K、Ctrl+/）未改动；映射发生在 xterm.js 已决定发送之后，输入法组字（keyCode 229）、死键、AltGr / 第三层键、读屏模式下的 textarea 默认动作均仍由 xterm.js 处理，Ctrl+C、Ctrl+H、Ctrl+8 等不受影响（Ctrl+H 与 Ctrl+8 不是 Backspace 键，不交换）。组字期间 xterm.js 不报告 `onKey`，因此不会发生映射。
- **不向主机多发字节**：映射只替换同一次按键的字节，数量为一次写入；初始模式只写本地 xterm。早期输入 FIFO、编码、ACK 与关闭路径不变。初始模式在会话创建时排入 xterm 写入队列，早于第一块主机输出（主机输出只能在原生 open 返回之后到达）。
- **主机切换优先**：初始 DECCKM 之后，主机的 `CSI ? 1 l/h`、DECSTR、RIS 照常生效；RIS 与 DECSTR 恢复常规模式而不是会话的初始模式（xterm 会恢复初始资源值，差异见 Q1）。本应用自己的「硬复位」（T32）在同一写入末尾补写会话的初始模式，与“新会话一致”的承诺保持一致；默认会话的硬复位序列不变。软复位按 DECSTR 语义不补写。
- **快照**：选项属于会话。本地会话放入启动选项快照（仅前端，`nativeLaunchArguments` 白名单不变，不进入 `pty_open`），重新打开继承原快照，「修改启动选项」预填会话自己的选项；SSH / Telnet / Raw TCP 随打开请求传入，不进入 `ssh_open` / `net_open`。只存内存，不持久化。运行中不可切换（未做命令面板入口）。
- **入口**：本地启动选项、SSH 终端、Telnet / Raw TCP 对话框中各有一个默认折叠的「键盘与初始模式」区域，位于字符编码之后，摘要显示“默认”或“已修改 N 项”；SSH 只在终端用途中显示，与编码字段一致。

### 5.3 已知限制

- macOS Option 作 Meta 后，美式等布局的 Option 死键（如 Option+E）和依赖 Option 的 `@ [ ] { } | ~` 无法输入；不区分左右 Option。
- 组字中若浏览器给 Backspace 报告真实 keyCode 8（而非 229），xterm.js 先结束组字再发送，映射照常替换；此路径只在 Chrome + CDP 下观察，原生输入法未测。
- 初始模式写入在下一个任务中被 xterm 解析；在此之前会话尚无原生 ID，用户按键本来就不发送，因此不影响已发送的字节。

## 6. 测试

新增 [`terminal-keyboard-modes.spec.ts`](../../apps/desktop/tests/e2e/terminal-keyboard-modes.spec.ts) 25 项与 `support/keyboard-harness.ts`，经生产路径（对话框 → 会话快照 → `session-lifecycle` → `terminal-keyboard` → xterm.js → `queueInput` → stub 的 `*_write`）断言发送字节：

- **默认零变化**（4 项）：三类对话框的字段默认折叠、显示“默认”、四个控件为默认值；未改动直接打开的 pty / ssh / net 会话与一键本地终端，开始时 `*_write` 为空、`macOptionIsMeta` 为 false、DECRQM `?1` 为 2，28 个键（Backspace / Delete 及其修饰组合、方向键、Home/End、Enter、Tab、Esc、F1、Insert、PageUp、Ctrl+C/H/8/L/D/Z/斜杠）每键恰好一次写入且字节与 xterm.js 6.0.0 相同。
- **选项生效**（7 项）：三种传输上 BS / DEL / 应用光标键只改变对应键，其余键不变、每键一次写入、开始时不发送任何字节而 DECRQM `?1` 为 1；Delete 选 BS 时带修饰键的 Delete 保留 `CSI 3 ; n ~`；macOS / Windows / Linux 三个平台上 BS 模式恰好把默认结果的末字节 BS↔DEL 互换并保留 ESC 前缀。
- **不截获**（3 项）：有选区时 Ctrl+C 仍发 ETX，Ctrl+Shift+C/V、Ctrl+Insert、Cmd+C 不发送，⌘K 打开命令面板且不发送；CDP 组字期间被输入法消耗的 Backspace / Delete / ↑（keyCode 229）不发送，提交只发送一次，之后 Backspace 发 BS；macOS Option 死键之后的 Backspace 与默认一样不发送，下一次才发送。
- **平台差异**（3 项）：macOS 选 Option 作 Meta 后 Option+F 发 `ESC f`、Option+Backspace / ← / Enter 与默认相同，同窗口另一个默认会话仍输入 `ƒ`；Windows / Linux 控件禁用并提示仅适用于 macOS，Alt+F 仍发 `ESC f`。
- **主机切换**（4 项）：三种传输上初始应用模式被主机逐字节的 `CSI ? 1 l` 关闭、`CSI ? 1 h` 再开启，DECSTR、RIS 恢复常规；本应用硬复位恢复初始模式，之后主机的切换仍优先；默认会话的硬复位本地写入与 T32 完全相同，非默认会话只在同一写入末尾多 `CSI ? 1 h`，且不向主机写入。
- **快照与重开**（4 项）：打开后修改并取消表单不影响已开会话；退出后「修改启动选项」预填会话自己的选项（展开、显示“已修改 2 项”）；重新打开从原快照开始，开始时不发送、两次 `pty_open` 参数相同；三种传输的 open 参数名与值（除随机 ID）与默认相同且不含任何选项字样；SSH 只在终端用途显示字段，关闭后与 Telnet 对话框再次打开时恢复默认；快照只接受列出的值并冻结，`remapKey` 只处理 keydown 的 Backspace（keyCode 8）与无修饰 Delete（keyCode 46），Ctrl+H（72）、Ctrl+8（56）不处理。

## 7. 未验证

原生 WebView（WKWebView / WebView2 / WebKitGTK）中的按键与输入法、真实键盘布局（德语、法语等）、Rust/PTY/SSH/TCP、vim / tmux / readline 中的实际效果、上游 WindTerm 对照、CI 均未运行。

## 8. 待用户决定

| # | 问题 | 选项 | 推荐 |
| --- | --- | --- | --- |
| Q1 | 主机 RIS 后是否恢复会话的初始模式（xterm 的做法） | A. 保持 xterm.js 行为，RIS / DECSTR 回到常规（当前）；B. 恢复初始模式，需要经评审的字节流预处理或内核改动，触及 ADR | A，待上游实机确认后再议 |
| Q2 | 初始 LNM 与回车键 | A. 只交付显示一半，回车仍发 CR；B. 仅在开启初始 LNM 的会话中按 VT100 在 LNM 生效时回车发 CR LF；C. 所有会话在 LNM 生效时回车发 CR LF（默认会话在主机设置 LNM 后的字节会变） | B，先实机核对上游 |
| Q3 | 应用小键盘编码 | A. 实现编码（主机发 `ESC =` 后默认会话小键盘字节会变，vim/less 常见）；B. 仅对开启初始应用小键盘的会话实现；C. 暂不做 | 先实机核对上游后选 A 或 B |
| Q4 | answerBack | A. 暂不做；B. 走 ADR 评审后实现，默认空（不回复，保持现状）；C. 默认 `Wind`（与上游一致，改变默认行为） | A；若做则 B |
| Q5 | Alt/Meta “8 位字符” | A. 实机核对上游字节语义后实现；B. 不做 | A |
| Q6 | modifyOtherKeys / formatOtherKeys | A. 实现（主机开启后默认会话字节会变）；B. 仅响应主机开启、默认 XTerm 格式；C. 暂不做 | 先实机核对上游后选 B |

## 9. 实施记录

改动只在前端：新增 `src/terminal-keyboard.ts`（选项快照、`remapKey`、`attachKeyboard`、初始模式序列）与 `src/terminal-keyboard-ui.ts`（三类对话框共用的折叠字段，DOM API 构建，不拼 HTML）；`session-lifecycle.ts` 在会话创建时调用 `attachKeyboard`，在 `onData` 编码前调用 `rewrite`；`local-launch.ts`、`ssh-verification.ts`、`net-terminal.ts` 加字段并把选项放入快照或打开请求；`terminal-actions.ts` 的硬复位追加会话初始模式；`style.css` 加字段样式。未改 Rust、Tauri 命令、ACL、IPC 参数、`terminal.ts` 工厂与依赖。

验证（本机 macOS，系统 Chrome，Vite 端口 1442，浏览器 IPC stub）：

- `npm run build`（`tsc --noEmit` + Vite 构建）通过。
- 新增 25 项 `--repeat-each 5`：125/125 通过。
- 全量浏览器 E2E：623/623 通过（`dd11418` 实测基线 598 + 新增 25），既有键盘、输入法、粘贴、T32 清屏与复位、编码与启动选项测试未改动且全部通过。
- 反向验证：临时让 `rewrite` 原样返回、不写入初始模式、硬复位不追加后，新 spec 25 项中 15 项失败（其余 10 项为默认零变化、Option 作 Meta、字段显示与参数不外泄，本就不依赖这三处），已还原。

未运行：Rust 门禁（未改 Rust）、原生 WebView、CI、上游对照。
