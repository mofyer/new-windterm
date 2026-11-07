# T32 终端清屏与复位：盘点、语义与实施记录

日期：2026-11-07。分支 `p1/clear-reset`，基于 `p1/integration` 的 `c24f732`。只改前端，没有改 Rust、Tauri 命令、ACL 或依赖。验收口径是[功能对齐矩阵](../FEATURE_PARITY.zh-CN.md) T32 行：通过菜单与快捷键执行清回滚、清屏、全部清除、软复位、硬复位与复位字符集；每个动作后的屏幕、回滚、光标、模式与字符集与上游一致；动作只作用于当前会话，不向远端发送数据。

本记录的证据全部来自浏览器 IPC stub（系统 Chrome + Vite 开发服务器），**没有**实测 WindTerm 2.7.0 各动作的结果，没有原生 WebView、Rust、CI、IME 或读屏验收。下文“上游”只指静态资源中的入口与启用条件。T32 的台账状态不改（见第 10 节）。

## 1. 上游盘点（静态，未实测）

来源：`.reference/WindTerm-P0.app` 的 `terminal/configs/menu.config`（`MNU`）、`global/wind.actions`（`ACT`）、`global/wind.keymaps`（`KEY`）、`global/locales/zh-CN.locale`（`LOC`），缩写同[静态复核](../p0/UPSTREAM_STATIC_REVIEW.zh-CN.md)。只记录入口名称与启用条件，没有复制脚本或资源。

| 上游动作 | 英文 / 中文语言包 | 入口 | 启用条件（`state` 脚本） |
| --- | --- | --- | --- |
| `Terminal.ClearScrollback` | Clear Scrollback / 清除回滚 | 终端视图右键菜单 `View Popup`（`MNU:260`）；`KEY` 中 `<Ctrl+Shift+L>` 与 `<Meta+Shift+L>`，模式 `local, remote`，作用域 `terminal.view.text` | 存在终端窗格即可，**备用屏中也可用**（`ACT:744`） |
| `Terminal.ClearScreen` | Clear Screen / 清屏 | `MNU:261`；`<Ctrl+L>` 与 `<Meta+L>`，同上模式与作用域 | 不在备用屏（`ACT:722`） |
| `Terminal.ClearScreenAndScrollback` | Clear All / 全部清除 | `MNU:262`；无快捷键 | 不在备用屏（`ACT:733`） |
| `Terminal.ResetHard` | Hard Reset / 硬复位 | 同一菜单的「Reset / 重置」子菜单（`MNU:297–301`）；无快捷键 | 存在活动视图（`ACT:950`） |
| `Terminal.ResetSoft` | Soft Reset / 软复位 | 同上 | 同上（`ACT:955`） |
| `Terminal.ResetCharacterSet` | Reset Character Set / 重置字符集 | 同上 | 同上（`ACT:945`） |

上游只有这 6 个动作，没有“复位并清除”（那是 VTE 等终端的做法）。Qt 在 macOS 上把 `Ctrl` 映射为 Command、`Meta` 映射为 Control，所以 macOS 上的 `KEY` 绑定对应 Cmd+L、Control+L、Cmd+Shift+L、Control+Shift+L；Windows/Linux 上对应 Ctrl+L 与 Ctrl+Shift+L。**静态材料不能回答的问题**：清屏时是否保留光标所在行、是否把屏幕推入回滚、是否同时向 Shell 发送 `^L`；硬复位是否清除回滚；重置字符集只复位 G0–G3 还是也涉及会话编码；`remote` 模式下按 Ctrl+L 时 Shell 是否还能收到 `^L`。[2026-10-15 上游实测记录](../p0/UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)没有涉及 T32，[基线](../p0/BASELINE.zh-CN.md) 记为“仅有菜单与动作定义；未实测上游各动作的结果”。

## 2. 用户触发的动作与主机发来的 RIS / DECSTR

| | 主机发来的 RIS（`ESC c`）、DECSTR（`CSI ! p`）、ED 3 等 | 用户触发的动作（本次） |
| --- | --- | --- |
| 字节来源 | 主机输出：Channel → `Utf8Boundary` → `xterm.write(块, 回调)`，每块解析后按序 ACK | 应用生成的固定序列，经 `Terminal.write` 写入**本会话的本地 xterm**；是一次独立的写入，不拼进任何主机块，不经 `*_write`，不进入输入队列或早期 FIFO，没有 ACK |
| 时序 | 按到达顺序 | 排在已经交给 xterm、尚未解析的主机输出之后；在两个主机块之间生效 |
| xterm.js 6.0.0 的两个 RIS 缺陷 | 照旧：RIS 后 DECTCEM 隐藏的光标仍隐藏，LNM 仍开启（第 4 片 `test.fail` 未改；本次新测试另有正向断言） | 硬复位在同一次写入里补写 `CSI ? 25 h` 与 `CSI 20 l`，结果与新会话一致（第 5 节） |
| 冷归档 | RIS 与 ED 3 计为“清除”，已归档行保留（[历史预案](HISTORY_BUDGET_PLAN.zh-CN.md)第 11 节） | 清除回滚 / 全部清除另外清空本会话冷归档；其余动作同主机规则（第 6 节） |
| VT 适配器与历史观察者 | 解析器钩子照常观察 | 同样经解析器，钩子看到的序列与主机发来的相同，不需要带外 `vt.reset()` |

## 3. 动作定义与影响

| 动作 | 写入本地 xterm 的序列 | 屏幕 | 热历史（xterm 回滚） | 冷归档 | 模式 | 光标 | 字符集 | SGR | 输入 | 备用屏 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 清除回滚 | `CAN CSI 3 J` | 保留 | 清空 | 清空（第 6 节） | 不变 | 不变 | 不变 | 不变 | 编码与队列不变 | 不提供 |
| 清屏 | `CAN CSI H CSI 2 J` | 可见行擦除，不推入回滚（与主机 Ctrl-L 相同） | 保留 | 保留；被擦除的屏幕行不入归档 | 不变 | 回到左上（DECOM 下为上边距） | 不变 | 不变（擦除使用当前背景色） | 不变；Shell 不会收到通知，也不会重绘提示符；演示会话正在编辑的行保留 | 不提供 |
| 全部清除 | `CAN CSI H CSI 2 J CSI 3 J` | 擦除 | 清空 | 清空 | 不变 | 回到左上 | 不变 | 不变 | 同上 | 不提供 |
| 硬复位 | `CAN ESC c CSI ? 25 h CSI 20 l` | 清空，回到主屏 | 清空（xterm.js RIS 重建两个缓冲区） | 保留，计 1 次清除（同主机 RIS） | 与新会话初始值相同，包括 DECTCEM 显示、LNM 关闭 | 左上，显示 | ASCII | 默认 | 键盘模式、鼠标跟踪、括号粘贴与焦点报告回到初始；输入队列、ACK 不受影响；OSC 52 授权与终端类型保持 | 可用 |
| 软复位 | `CAN CSI ! p` | 保留（含备用屏） | 保留 | 不变 | 与主机 DECSTR 相同：xterm.js 6.0.0 保留鼠标跟踪、重新开启自动换行、关闭括号粘贴与焦点报告（第 4 片观测） | 显示；位置不变；DECSC 保存点回到左上 | 复位 | 默认 | 同主机 DECSTR | 可用 |
| 重置字符集 | `CAN ESC ( B ESC ) B ESC * B ESC + B SI` | 保留 | 保留 | 不变 | 不变 | 不变 | G0–G3 指定为 ASCII，GL 回到 G0；DECSC 保存的字符集不变 | 不变 | 不变 | 可用 |

所有动作只作用于活动标签的本地 xterm，已退出或仍在启动的会话也能执行。备用屏中不提供三个清除动作，菜单项置灰并在悬停说明原因，命令面板执行时提示“不可用”。上游在备用屏中仍提供清除回滚；xterm.js 的 ED 3 只作用于活动缓冲区，备用屏期间无法经公开 API 清除主屏回滚，所以这里不提供（差异，待上游实测与用户决定）。

完成后用 toast 说明结果，并写明“只在本地执行 / 不发送任何数据”；会话名只以文本写入。

## 4. 实现

- [`terminal-actions.ts`](../../apps/desktop/src/terminal-actions.ts)：6 个动作的序列、可用性（无会话、正在关闭、备用屏）与 `runTerminalAction`。写入回调在该序列解析后、下一个主机块解析前同步执行：先 `history.capture()`（让 H4 边界记下这次复位或清除，从清除之后继续），清除类动作再调用 `history.clear()`，最后滚到底部。
- [`terminal-actions-ui.ts`](../../apps/desktop/src/terminal-actions-ui.ts)：终端工具栏的「清除与复位」菜单按钮（菜单项顺序同上游：清除一组，分隔线，复位一组）和 6 个命令面板条目，共用同一个 `run`，执行时再检查一次可用性。菜单支持方向键、Home/End、Esc（焦点回到按钮）、Tab 与点击外部关闭；选择后焦点回到终端。
- `main.ts` 只加了 import、创建菜单的一行和命令数组里展开的一行；`demo-session.ts` 的 `clear` 改走同一动作；`style.css` 加了菜单样式（中性色，同命令面板）。没有改 `session-lifecycle.ts`、`terminal-core.ts`、`vt-adapters.ts`。
- **为什么经解析器而不用 `terminal.reset()` / `terminal.clear()`**：两者都是带外调用。`reset()` 不复位解析器、不经 VT 适配器（影子状态会过期，第 4 片已有测试），也不让 H4 边界知道缓冲区已替换；`clear()` 会调用 `clearAllMarkers()` 销毁冷归档的续读 marker，下一次读取被误判为缺口。xterm.js 自己的文档也建议需要与输入同步复位时写入 RIS / DECSTR。经解析器后，生产代码不再调用 `terminal.clear()`（此前只有演示会话的 `clear` 用它）。
- **CAN 前缀**：最后一个主机块可能停在控制序列或控制字符串中间（例如跨块的 DECRQSS、OSC 标题或 OSC 52）。此时动作开头的 ESC 会让 xterm 把未完成的 OSC/DCS 当作已结束执行。CAN（0x18）按 VT 解析器规则取消它而不执行：未完成的 DECRQSS 不会应答，OSC 不生效；该主机序列随后到达的剩余字节按普通文本显示，与任何收到 CAN 的终端相同。地面状态下 CAN 没有作用（xterm.js 没有它的处理器）。反向验证：去掉 CAN 后，跨动作的 `ESC P $ q` + `m ESC \` 让会话向主机发出了 `ESC P 0 $ r ESC \`，违反“不向远端发送数据”。
- **剩余竞态**：可用性在点击时检查；若已收到但尚未解析的主机输出恰好切换到备用屏，动作会在备用屏上解析。回调里检测到这一点：清除回滚不清冷归档（ED 3 在备用屏什么也没做），清屏 / 全部清除会擦除全屏程序的当前画面，toast 会说明“程序可能需要重绘”。这只在高输出且积压时才可能发生，测试用同一任务内送块并点击来确定性复现。

## 5. 硬复位补写与 ADR（请审查者重点核对）

xterm.js 6.0.0 的 RIS 不恢复 DECTCEM 隐藏的光标、不清除 LNM（第 4 片回归已固定，根因在 `CoreService.isCursorHidden` 与 `options.convertEol` 不随 `reset()` 恢复）。用户硬复位在 `ESC c` 之后、同一次本地写入里补写 `CSI ? 25 h` 与 `CSI 20 l`。判断它**不触及** [ADR](../p0/TERMINAL_CORE_ADR.zh-CN.md) 的内核改动定义，理由：

1. **不是升级、贡献或分支**（G-UPGRADE、G-CONTRIB、G-CORE）：xterm.js 版本、代码与配置不变。
2. **不改状态归属**（G-CORE）：xterm.js 仍是唯一终端状态，没有新增影子状态；补写的是两个标准序列，进入的是同一个解析器。
3. **不是字节流预处理**：第 4 片列出的修复路线里，“经评审的字节流预处理”指检查或改写主机字节。这里不读取、不过滤、不改写也不向主机块插入任何字节；主机发来的 RIS 仍保持两个缺陷（`terminal-regressions-reset.spec.ts` 的两项 `test.fail` 未改，新 spec 对同一路径另有正向断言），写入记录测试逐块核对主机块原样到达 xterm。
4. **只用公开 API**：`Terminal.write`，是 xterm.js 文档建议的同步复位方式。补写只在用户自己的动作里发生，与应用写入演示文本、启动失败提示属于同一类本地写入。

需要审查者判断的灰色地带：CAN 会取消动作时恰好未完成的主机序列。这改变的是“该序列在用户复位那一刻如何结束”，不是改写主机字节；主机 RIS 本身也会让解析器回到初始状态（xterm.js 的 `fullReset` 调用 `parser.reset()`）。若审查者或用户认为这仍属 ADR 范围，可以去掉补写，只保留差异记录：届时用户硬复位与主机 RIS 一样，光标保持隐藏、LNM 保持开启。主机 RIS 的两个缺陷是否处理仍待用户在 ADR 门禁下决定，本次没有处理。

2026-11-07 补记（T31 第一部分，分支 `p1/keyboard-modes`）：会话选了非默认的初始光标键模式时，用户硬复位在上述序列之后、同一次写入里再补写 `CSI ? 1 h`，使结果仍与该会话的新会话一致；默认会话的硬复位序列不变，主机 RIS 仍按 xterm.js 6.0.0 回到常规模式。理由与本节相同（公开 `Terminal.write`、不读取或改写主机字节），见 [T31 计划](KEYBOARD_MODES_PLAN.zh-CN.md#52-语义细则)。

另一个观测差异没有补写：OSC 4/10/11/12 改过的颜色经 RIS 仍保留（第 4 片记录）。新会话使用主题颜色；若希望用户硬复位也恢复，可补写 OSC 104/110/111/112，需用户决定。

## 6. 与冷归档的关系

- **清除回滚、全部清除**：用户明确要求删除历史，因此同时清空本会话冷归档（方案 A，待用户确认）。新增 `HistoryArchive.clear()`：丢弃已完成的块、仍在压缩的块（完成后按代次丢弃，不再触发预算回调）和未封块的行；行号继续递增，`lines()` 不再返回被清除的行；统计新增 `clearedLines`、`userClears`。已丢弃 + 已清除始终是最早的一段连续行，所以第一行保留行号为二者之和。`SessionHistory.clear()` 同时把“已丢弃最早 N 行”的计数归零并刷新状态栏（被丢弃的行属于已清除的历史），行数目标在清除后只计之后封块的行。
- **计数**：动作写入的 ED 3 被 H4 观察者看到，计为 1 次“清除”（`clears`，主机与用户动作都计），不计缺口；用户清除另计 `userClears` 与 `clearedLines`。开发诊断新增 `historyUserClears`、`historyUserClearedLines`，生产构建中检索 34 个诊断字段名均未出现。
- **不重复、不缺口**：动作回调里先 `capture()` 再清除，H4 边界已从清除后的第 0 行继续；清除时仍在屏幕上的行以后滚出时归档一次。测试逐行核对。
- **其余动作**：硬复位与主机 RIS 相同（保留已归档行，计 1 次清除，从第 0 行继续）；清屏、软复位、重置字符集不改归档，清屏擦除的屏幕行不入归档。
- **用户可见提示**：清除类 toast 写明“全部回滚历史”；冷归档仍没有浏览界面，不显示归档行数。

## 7. 入口与理由

- **终端工具栏**：在每会话动作所在的 `.terminal-tools` 行增加一个「清除与复位」文字按钮，展开 6 项菜单。理由：工作台没有菜单栏，也还没有终端右键菜单；这一行已有“重新打开”“端口转发”等当前会话动作；一个按钮加菜单对应上游右键菜单的分组，不必加 6 个按钮，也不新增营销式界面。菜单由新模块用 DOM API 插入，未改 `main.ts` 模板。
- **命令面板**：6 个条目，名称为“动作 · 当前会话 · 说明”，例如“清除回滚 · 当前会话 · 保留屏幕，删除全部回滚历史”。
- **快捷键：未添加**（待用户决定）。上游在 Windows/Linux 把 Ctrl+L 绑定为清屏，会与 Shell 的 `^L` 冲突，而现有键盘测试要求 Ctrl+L 发送 `0x0c`；上游 Ctrl+L 是否同时把 `^L` 发给 Shell 未实测。
- **终端右键菜单：未添加**，以免替换 WebView 的复制粘贴菜单与 xterm 的右键选词，留待后续。

## 8. 演示会话

演示会话的 `clear` 命令改为执行与「全部清除」相同的本地写入，再在第一行显示提示符，与真实 Shell 的 `clear` 一致。此前它调用 `terminal.clear()`，会把输入 `clear` 的那一行留在第一行、提示符在第二行。菜单和命令面板对演示会话执行相同的序列，不产生任何 IPC 调用；清屏不改变正在编辑的行（与真实 Shell 的行编辑器一致）。

## 9. 验证

- `npm run build` 通过；生产 JS 中检索 34 个诊断字段名、诊断对象名与开发查询参数，均未出现；菜单文案在生产构建中。
- 新增 [`terminal-clear-reset.spec.ts`](../../apps/desktop/tests/e2e/terminal-clear-reset.spec.ts) 22 项，经生产会话路径（stub IPC → Channel → `session-lifecycle` → xterm + VT 适配器 → 按序 ACK）：入口 2 项（菜单顺序、键盘与关闭、命令面板各一条；无会话时全部置灰并提示）；6 个动作依次作用于 pty、ssh、net 与演示会话各 1 项；本地 PTY 细节 4 项（清屏保留回滚、模式、字符集与输入编码；硬复位与新会话一致、光标显示、LNM 关闭，同一状态下主机 RIS 两个缺陷照旧；软复位与主机 DECSTR 逐项相同，含备用屏；重置字符集复位 G0–G3 与 GL 而 SGR 不变）；主机字节、输入与 ACK 4 项（逐次记录 `Terminal.write`，主机块原样、按序，动作是独立的本地写入；CAN 取消跨动作的 DECRQSS、OSC 标题与已授权的 OSC 52；写入与 ACK 被挂起时动作前后的输入顺序与 ACK 序号连续；启动中与已退出时动作只在本地、早期 FIFO 为空）；备用屏 2 项；冷归档 5 项；演示会话 `clear` 1 项。`history-archive.spec.ts` 新增 `clear` 单元测试 1 项。所有动作之后都断言 `*_write` 为空。
- **反向验证**（逐项临时修改后运行，随后还原并逐字节核对）：去掉 CAN → CAN 测试失败（会话向主机发出 DECRQSS 应答）、写入记录与演示测试失败；去掉硬复位补写 → 硬复位测试失败；行数目标不扣除 `clearedLines` → 行数目标测试失败；压缩回调不检查代次 → `clear` 单元测试失败；回调中不检查备用屏 → 备用屏竞态测试失败；不调用 `history.clear()` → 3 项冷归档测试失败。
- 新增 23 项 `--repeat-each 5` 与本机全量浏览器 E2E 的数量见第 11 节。

## 10. 未验证与剩余风险

- **上游结果未实测**，T32 的“与上游一致”无法判断，台账状态保持“未实现”，不改 ID。清屏语义（擦除并回到左上，不保留提示符行、不推入回滚）、硬复位清空 xterm 回滚、备用屏中不提供清除回滚，都需要上游实测后核对。
- 原生 WKWebView、WebView2、WebKitGTK 未测；没有改 Rust，未跑 Rust 门禁与 CI；IME、读屏（toast 是 live region，菜单未经读屏验收）未测。
- 快捷键与右键菜单未实现。
- CAN 取消未完成的主机序列后，该序列剩余字节显示为文本；清屏擦除的内容不进入回滚；备用屏竞态下全屏程序画面被擦除，需程序重绘。
- 硬复位不恢复 OSC 改过的颜色（观测差异）；软复位沿用 xterm.js DECSTR 的观测差异。
- 浏览器 stub 通过不代表真实 Shell、SSH 或 Telnet 主机程序的行为。

## 11. 结果与待决问题

本机（macOS arm64，系统 Chrome，Vite 开发服务器端口 1439，IPC stub，workers 2）：

- 基线：在 `c24f732` 的干净导出副本上实测全量浏览器 E2E **537/537**。
- 改动后全量浏览器 E2E **560/560**（537 + 新增 23）。其后只把 CAN 测试中一条断言改得更严格（未改产品代码），该 spec 重跑通过。
- 新增 23 项 `--repeat-each 5`：`terminal-clear-reset.spec.ts` 110/110，`history-archive.spec.ts` 的 `clear` 单元测试 5/5。
- 未运行 Rust 门禁、wincheck、真实 OpenSSH 夹具、原生 WebView 与任何 CI（未改 Rust）。
- 独立审查（只读 `code-reviewer`，审查提交 `c376d27`）：APPROVE，无 CRITICAL/HIGH；审查者自行构建并重跑本 spec（含 `--repeat-each 5`）、`history-archive`、`terminal-regressions-reset`，独立判定补写与 CAN 前缀**不触及** ADR（理由同第 5 节：主机输出路径未改，补写只在用户动作里，不改状态归属；若去掉 CAN，未完成的 DECRQSS 会被应答，违反“不向远端发送数据”）。2 项 MEDIUM 已修：`uncompressedBlocks`、`compressMs` 注明为累计值（不随 `clear`/`dropOldest` 减少）；`runTerminalAction` 改为绝不拒绝（xterm 拒绝写入时按“未执行”返回），会话先关闭时 toast 说明未执行。2 项 LOW 未改：菜单打开期间不随主机输出刷新可用性（执行时会再检查，属保守行为）；累计字段注释（随 MEDIUM 一并补充）。修正后相关 6 个 spec 94/94、本 spec `--repeat-each 5` 110/110，全量浏览器 E2E 见下一条。
- 审查修正后再跑全量浏览器 E2E：**560/560**（同一端口与配置）。

待用户决定：

1. 清除回滚 / 全部清除是否同时清空冷归档（已按方案 A 实现：清空；方案 B 为只清 xterm 回滚、保留冷归档）。
2. 硬复位是否保留冷归档（已实现：保留，同主机 RIS），或另增“复位并清除”。
3. 硬复位补写 `CSI ? 25 h`、`CSI 20 l` 是否认可为不触及 ADR；是否也补写 OSC 104/110/111/112 恢复颜色。
4. 快捷键方案：照搬上游（Ctrl+L 清屏，与 Shell `^L` 冲突）、只在 macOS 用 Cmd+L / Cmd+Shift+L、或先实测上游再定。
5. 清屏语义与备用屏中的清除回滚，是否等上游实测后再调整。
6. 主机 RIS 两个缺陷的 ADR 决定（既有待决项，本次未处理）。

**用户决定（2026-11-07）**：用户硬复位补写与 CAN 前缀认定不触及 ADR，暂不补写颜色恢复；清除回滚 / 全部清除一并清空冷归档，硬复位保留冷归档，暂不另加“复位并清除”；快捷键仅 macOS 提供 Cmd+L / Cmd+Shift+L，Windows/Linux 待上游实测。详见 [2026-11-07 用户决定](RESULTS.zh-CN.md#2026-11-07-用户决定15-项全部采用推荐项)。
