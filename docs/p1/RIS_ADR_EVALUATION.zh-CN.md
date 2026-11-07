# 主机 RIS 两项 xterm.js 缺陷：终端内核 ADR 评估

日期：2026-11-07。分支 `p1/ris-adr`，基于 `p1/integration` 的 `35aee13`。**只写评估文档**：没有改产品代码、测试、依赖或 VT 矩阵状态。依据是用户 2026-11-07 决定第 3 项（[执行记录](RESULTS.zh-CN.md#2026-11-07-用户决定15-项全部采用推荐项)）：两项 RIS 缺陷进入[终端内核 ADR](../p0/TERMINAL_CORE_ADR.zh-CN.md#p0-决策门禁与后续启用门禁) 门禁，先评估，再在“上游修复后升级 / 受控补丁 / 字节流改写”等路线中选择。

范围只限**主机发来的 RIS**（`ESC c`）。T32 用户硬复位在本地写入中补写 `CSI ? 25 h CSI 20 l`，不改主机字节，用户已认定它不触及 ADR（同表第 6 项，见 [T32 预案第 5 节](CLEAR_RESET_PLAN.zh-CN.md#5-硬复位补写与-adr请审查者重点核对)），本文不重新讨论。

证据范围：

- **源码只读核对**：本仓库锁定的 `@xterm/xterm` 6.0.0（`package.json` 中 commit `f447274f`）。运行时执行的是包内 `lib/` 压缩产物，下文行号指同包随附的 `src/`。只引用位置与行为，不复制代码。
- **Node 探针**：在本机 Node v26.0.0 中加载同一 `lib/xterm.js`，不调用 `open()`（没有 DOM 和渲染器），通过 DECRQM 回复、屏幕行和一个返回 `false` 的 `ESC c` 计数观察者判断。脚本是临时文件，未提交。它只证明解析器与模式状态，**不**证明 DOM 光标绘制、浏览器或原生 WebView 的行为。
- **浏览器**：沿用第 4 片已有的 [`terminal-regressions-reset.spec.ts`](../../apps/desktop/tests/e2e/terminal-regressions-reset.spec.ts)（IPC stub），本次没有新跑浏览器测试。
- **上游**：2026-11-07 用 `gh` 检索 xtermjs/xterm.js 的 issue/PR，读取 master `08829c7`（2026-10-29）的对应源码，并查看 npm dist-tags。
- **规范**：vt100.net 上的 VT100 用户指南第 3 章，VT510 程序员参考的 RIS、DECTCEM、LNM 条目；xterm 的 `charproc.c`（ThomasDickey/xterm-snapshots，xterm-411e 快照 `a73913e`）。
- **terminfo**：本机 macOS 自带的 ncurses 6.0.20150808。

没有与 WindTerm 2.7.0、真实 xterm 或 DEC 实机对照，没有运行 vttest，原生 WebView 未测。

## 1. 缺陷、根因与影响

### 1.1 复现

| 缺陷 | 主机序列 | 预期（VT100/VT510 文档与 xterm） | xterm.js 6.0.0 观察 | 固定位置 |
| --- | --- | --- | --- | --- |
| D1：DECTCEM | `CSI ? 25 l`，之后 `ESC c` | 光标可见，`CSI ? 25 $ p` 回复 `CSI ? 25 ; 1 $ y` | 仍隐藏：回复 `CSI ? 25 ; 2 $ y`，DOM 渲染器不画 `.xterm-cursor`，直到收到 `CSI ? 25 h` 或 DECSTR | 本地 PTY 会话路径，spec 第 110–125 行 `test.fail` |
| D2：LNM | `CSI 20 h`、`ESC c`，然后 `A LF B` | LNM 复位，LF 只换行，`B` 在第 2 列；`CSI 20 $ p` 回复 `CSI 20 ; 2 $ y` | 仍置位：回复 `CSI 20 ; 1 $ y`，`B` 回到第 1 列 | spec 第 127–137 行 `test.fail` |

同一 spec 第 159–169 行用原样 xterm.js（`vt: false`，不挂应用和适配器）固定了根因：`CSI ? 25 l CSI 20 h ESC c` 之后回复仍是 `?25;2$y`、`20;1$y`。所以缺陷不是 VT 适配器造成的。本地、SSH、Telnet 与 Raw TCP 会话使用同一套 xterm.js 实现和会话写入路径，在这一点上没有差别（两项 `test.fail` 只在 pty 会话上运行）。

### 1.2 根因（6.0.0 源码）

- **D1**：`CoreService.isCursorHidden`（`src/common/services/CoreService.ts:33`）是单独的字段，不在 `modes`/`decPrivateModes` 里；`CoreService.reset()`（`:56`）只重建这两组模式。RIS 的执行路径是：`ESC c` 在 `InputHandler.ts:351` 注册为 `fullReset()`（`:3324`），后者调用 `_parser.reset()` 并触发 `onRequestReset`，`CoreBrowserTerminal`（`:166` 订阅）随即执行 `reset()`（`:1268`），即 `_setup()` 加 `CoreTerminal.reset()`（`CoreTerminal.ts:244`，复位 InputHandler 属性、缓冲区、字符集、CoreService 模式与鼠标）。这些都不碰 `isCursorHidden`。只有 DECSET 25（`InputHandler.ts:1953`）和 DECSTR `softReset()`（`:2720`）会把它设为 false。DOM 渲染器靠它决定是否画光标（`DomRendererRowFactory.ts:241`），DECRQM `?25` 也靠它回复（`InputHandler.ts:2286`）。
- **D2**：LNM 没有独立的模式位。`setMode` 20（`:1756`）和 `resetMode` 20（`:2008`）直接修改 `optionsService.options.convertEol`，LF 处理（`lineFeed`，`:714`）和 DECRQM 20（`:2275`）都读这个选项。`convertEol` 同时也是嵌入方使用的公开选项（`typings/xterm.d.ts:58`，默认 false，`OptionsService.ts:56`），而 RIS/`reset()` 路径不恢复任何选项。
- 公开的 `Terminal.reset()` 自称执行 “full reset (RIS)”（`xterm.d.ts:1294`），走的是同一个 `CoreBrowserTerminal.reset()`，只是不复位解析器。Node 探针中它同样两项都不恢复。
- 上游 master `08829c7` 中，`CoreService.reset()`、`CoreTerminal.reset()`、`fullReset()` 的结构不变（只多了 kitty 键盘状态，鼠标服务改了名），`isCursorHidden` 与 `convertEol` 的处理也不变。

### 1.3 与规范和 xterm 的差异

- VT100 用户指南第 3 章：RIS “Reset the VT100 to its initial state, i.e., the state it has after it is powered on”。表 3-1 把 New Line（即 LNM）列为可由主机修改、存入 NVR 的 SET-UP 特性；LNM 的复位态是 LF 只做纵向移动。
- VT510 程序员参考：RIS “Sets all features listed on set-up screens to their saved settings”，并建议改用 DECSTR 复位终端；DECTCEM 默认 Visible；LNM 默认 Line feed（即复位态）。RIS 条目没有逐项点名 DECTCEM，所以“RIS 后光标可见”是根据上电默认值的推断。
- xterm（xterm-411e `charproc.c` 的 `ReallyReset`）：硬复位和软复位都先让光标可见；硬复位还把模式标志恢复为初始值（含 LINEFEED，并刷新自动换行与 LNM），所以 RIS 后 LNM 回到初始资源值（默认关闭）。
- 结论：这两项在 VT100/VT510 文档和 xterm 中都应当恢复，xterm.js 6.0.0 没有恢复。WindTerm 2.7.0 的行为未测（上游实机核对见用户决定第 15 项，尚未进行）。
- 相关但不同的上游问题：[#4119](https://github.com/xtermjs/xterm.js/issues/4119)（2022 年开放，标签 `type/bug`、`needs more info`、`area/parser`）记录 xterm.js 的 LNM 下回车不发送 CR LF。它与 RIS 无关，但说明 LNM 在 xterm.js 中本身就只实现了一部分。

### 1.4 影响面

**已核实**（本机，`TERM=xterm-256color`）：

1. `tput reset` 输出 `ESC c`、`CSI ! p`、`CSI ? 3 ; 4 l`、`CSI 4 l`、`ESC >`（terminfo 的 rs1 加 rs2）。`reset`（tset，经 `script` 分配 PTY 运行）先设置制表位，再输出同一串（前后各有一个 CR）。`clear` 输出 `CSI 3 J CSI H CSI 2 J`，不含 RIS。把 `tput reset` 的字节送进 xterm.js 6.0.0（Node 探针）后，DECTCEM 恢复可见（由紧跟的 DECSTR 完成），LNM 仍然置位。也就是说，最常用的 `reset` 命令掩盖了 D1，但没有掩盖 D2。
2. 本机 terminfo 的复位串：`xterm`、`xterm-256color` 的 rs1 为 `\Ec`，rs2 以 `\E[!p` 开头；`linux` 的 rs1 为 `\Ec\E]R`，不含 DECSTR，也不含 `?25h`；`vt100`、`vt220` 的复位串不含 RIS。据此推断，在 `TERM=linux` 下执行 `reset`/`tput reset` 会暴露 D1（只读了 terminfo，没有经产品端到端测试）。
3. `xterm-256color` 的 `cnorm` 为 `\E[?12l\E[?25h`，`rmcup` 为 `\E[?1049l`。按这些能力退出的全屏程序用 `cnorm` 显示光标，不依赖 RIS。

**推测**（没有抓包或实测）：

- 用户手动执行 `printf '\033c'` 一类的“清屏”，而前一个程序异常退出时留下了隐藏光标：xterm 会恢复光标，本产品仍隐藏，直到执行 `tput cnorm`、`reset` 或 T32 硬复位。
- 部分 Telnet/BBS 主机、网络设备 CLI 和串口设备在登录或切换菜单时会发送裸 RIS（相关场景在 Telnet 与 P2 串口交付中）。
- 在 tmux/screen 中执行 `reset`，RIS 由 tmux/screen 自己解释，本产品收到的是它们的重绘输出，不受这两项缺陷影响。
- vttest 的复位和 LNM 子项可能依赖 RIS 清除 LNM。本仓库尚未运行 vttest。
- D2 的实际损害：主机很少置位 LNM（上面几个 terminfo 条目都没有设置 LNM 的能力）。一旦置位，又依赖 RIS 清除，之后每个 LF 都会回到第 1 列。经 PTY `onlcr` 转成 CR LF 的普通输出看不出差别；关闭了 `onlcr` 的原始模式程序如果用 LF 下移光标（`xterm-256color` 的 `cud1` 与 `ind` 都是 `^J`），列位置会被错误归零。
- 生产配置没有开启 `windowOptions.setWinLines`，所以 DECCOLM 触发的整机复位（`InputHandler.ts:1898`、`:2139` 同样触发 `onRequestReset`）目前不可达；将来若开启，这条路径有同样的两项缺陷。

现有缓解：用户可以执行 T32 硬复位（终端工具栏「清除与复位」或命令面板），它补写 `CSI ? 25 h CSI 20 l`，能手动恢复两项状态。主机 RIS 的结果不受影响。综合判断严重程度为低到中：D1 在常见的 `reset` 中被掩盖，裸 RIS 时可见；D2 很少触发，但触发后的影响一直持续到再次复位。

## 2. xterm.js 6.0.0 在什么时候执行 RIS（各方案共用的事实）

`src/common/parser/EscapeSequenceParser.ts` 的状态表：

- 任何状态下收到 ESC 都转入 ESCAPE（`:105`）。在 OSC 字符串中，ESC 先把 OSC 当作**成功结束**处理（`:129`，`:600`/`:777` 只把 CAN、SUB 当作中止）；在 DCS 透传中先成功 unhook（`:189`）；在 SOS/PM/APC 中直接转入 ESCAPE。
- ESCAPE 状态下，C0 可执行字符（0x00–0x17、0x19、0x1C–0x1F）立即执行，状态仍为 ESCAPE（`:113`），DEL 被忽略（`:114`）；CAN、SUB（`:101`）与 C1（0x80–0x9F）离开 ESCAPE；0x20–0x2F 进入中间字节状态（`:154`）。
- 因此，在 xterm 收到的码位流中，只要 ESC 之后只隔着若干 C0 可执行字符或 DEL，紧接着是 `c`（没有中间字节），解析器就执行 RIS，**紧跟在 OSC/DCS/SOS/PM/APC 字符串内容之后的 `ESC c` 也一样**。“字符串内部的 `ESC c`”在 xterm.js 里并不存在，因为 ESC 本身就结束了字符串。
- UTF-8 会话把原始字节交给 xterm。xterm 的 UTF-8 解码器（`src/common/input/TextDecoder.ts` 的 `Utf8ToUtf32.decode`）遇到错误的续字节会回退一个字节重新读取，不会吞掉 ASCII，所以 ESC 与 `c` 一定作为码位到达解析器。非 UTF-8 会话由 WHATWG `TextDecoder` 先解码，ESC 与 `c` 不会成为多字节字符的一部分（见 `session-encoding.ts` 注释）。
- 处理器的执行顺序是后注册的先执行。生产中 `vt-adapters.ts` 的 `resetAll` 和 `terminal-core.ts` 的复位观察者都返回 `false`，最后执行内置的 `fullReset`。

Node 探针（每例先写入 `XYZ CSI ? 25 l CSI 20 h`）：

| 写入 | RIS 是否执行 | 备注 |
| --- | --- | --- |
| `ESC c` | 是 | |
| `ESC` 与 `c` 分两次写入 | 是 | 解析器状态跨写入保持 |
| `ESC ] 0 ; t ESC c` | 是 | 标题变为 `t`，OSC 按成功结束 |
| `U+009D 0 ; t ESC c`（C1 形式的 OSC） | 是 | 同上 |
| `ESC P $ q m ESC c` | 是 | |
| `ESC _ abc ESC c`、`ESC ^ abc ESC c` | 是 | |
| `ESC LF c`、`ESC BEL c`、`ESC DEL c` | 是 | LF、BEL 在 RIS 之前执行 |
| `ESC ESC c`、`CSI 1 ESC c` | 是 | |
| 字节 `E4 1B 63`（不完整的 UTF-8 前导字节后接 `ESC c`） | 是 | |
| `ESC CAN c`、`ESC SUB c` | 否 | `c` 作为文本显示 |
| `ESC # c` | 否 | 中间字节 |
| `ESC U+0085 c` | 否 | C1 NEL 结束 ESC |

推论：任何在 xterm 之外识别 RIS 的实现都必须复刻这组规则，并在每次升级时重新核对，否则识别结果会与 xterm 实际执行 RIS 的位置不一致，多判或漏判都有可能。

## 3. 方案比较

### 3.1 (a) 等上游修复后升级

- **上游现状**（2026-11-07 检索，检索词包括 `RIS cursor`、`reset cursor hidden`、`convertEol`、`fullReset`、`DECTCEM`、`LNM`、`cursor disappears`、`softReset`，以及 PR 中的 `isCursorHidden`、`RIS`、`full reset`）：**没有找到**描述“RIS 不恢复 DECTCEM 或 LNM”的 issue 或 PR。历史上的 [#814](https://github.com/xtermjs/xterm.js/issues/814)（2017）和 [#1532](https://github.com/xtermjs/xterm.js/issues/1532)（2018）也是 RIS 后光标消失，但原因是当时 `_setup()` 覆盖了光标/焦点状态，两者都已关闭，与本缺陷不同。开放 PR [#6278](https://github.com/xtermjs/xterm.js/pull/6278)（2026-10-30，新增 `parser.isInSequence`）与本缺陷无关，尚未合并。master `08829c7` 未修复。检索只覆盖所列词语，不能证明上游不存在相关讨论。
- **版本时间线**：npm `latest` 仍是 6.0.0（2025-12-22），`beta` 是 `6.1.0-beta.336`（2026-10-29）。5.5.0 到 6.0.0 间隔约 20 个月；7.0.0 里程碑现有 12 项开放、503 项已关闭，没有截止日期。既然没有找到对应的 issue，也就没有可以期待的修复排期。
- **门禁**：G-UPGRADE——“重新核实候选正式版、许可证、配套版本与私有 API；按当时矩阵重跑 VT、SIXEL、兼容原型及原生输入/读屏回归；审查默认值和身份报告”；不满足时“保持当前锁定版本；如阻塞交付，评估有限回移植。不能把历史 beta 观察当正式版验证”。ADR 的触发条件“上游未及时提供交付必需修复”要求比较有限回移植与受控分支，但目前上游没有可回移植的修复。
- **成本与风险**：现在没有成本；风险是无限期等待。X02 保持 partial，两项 `test.fail` 不变。锁定版本自行修复时，原样固定测试（spec 第 159–169 行）会失败，提醒删除 `test.fail`。无需回滚。
- **结论**：只能作为长期出口，不能单独成为方案。

### 3.2 (b) 向上游贡献修复

- **门禁**：G-CONTRIB——“对外发帖/PR 按用户授权执行。内部明确等待上限和交付日期，采用前验证全部相关 VT 语义”；不满足时“未获接受或无法在交付前采用时评估受控分支；不等待无限期上游回复”。该行证据列是按 DECSLRM 写的，本项按同一门禁类推。
- **修复设想**（只描述，不写代码）：D1 只需在 RIS 路径把 `isCursorHidden` 复位为 false，改动小，有 xterm 和 VT510 的依据，推测较容易被接受（未与维护者沟通）。D2 涉及设计：LNM 目前就是 `convertEol` 选项，RIS 如果直接改写选项，会覆盖嵌入方有意设置的 `convertEol: true`（`xterm.d.ts` 说明它适用于非 PTY 数据源）。较合理的做法是把 LNM 拆成独立的模式位，以选项值为初值，这需要维护者确认设计，可以与 #4119 一并讨论。
- **采用**：合入后还要等正式版（6.1/7.0 没有日期），再过 G-UPGRADE。ADR 已记录 7.0 周期改动很大，维护者还在探索 libghostty（#5686）。
- **成本与风险**（粗估，未经拆解评审）：写 issue 约 0.5 人日；D1 的 PR 连同测试约 1–2 人日；D2 的设计讨论无法估计。发布时间不可控。在采用之前 X02 不变。无需回滚。
- **结论**：建议在取得对外授权后作为并行动作，不作为交付路径。

### 3.3 (c) 受控补丁或分支

- **门禁**：G-CORE——“采用受控分支、替换内核或改变状态归属前”，由触发条件启动专项 ADR；不满足时“保持现有实现与未交付标记；不静默替换内核，不用同步两份状态规避缺口”。每次合并上游还要过 G-UPGRADE。
- **补丁方式**：ADR 方案三已经判断，npm 包里可执行的只有压缩后的 `lib/xterm.mjs`/`xterm.js`，patch-package 之类的工具只能改压缩产物，无法维护，必须从源码分叉构建，再以自有 scope 发布或作为构建产物纳入仓库。就本项而言，相关私有名字在 `lib/` 和本应用的生产包中都没有被混淆（`npm run build` 后，生产 JS 中能检索到 `isCursorHidden`、`coreService`、`_core`），所以对压缩产物打补丁在技术上做得到。但这需要新增 patch-package 类开发依赖或自写 postinstall；`npm ci` 的完整性校验只覆盖打补丁前的 tarball，补丁本身另需锁定和审查；源码映射和随包 `src/` 不再与运行代码对应；每次升级都要重做补丁。这与 ADR 已有结论冲突。
- **源码分叉**：从 6.0.0 的 `f447274f` 起分支，加两处修改，自建构建与发布（或入库），保留 MIT 声明。首次搭建粗估 1–2 人周（含构建链、来源记录与回归），之后每次合并上游按 ADR 的 1–3 人周计；上游若采用 libghostty，补丁可能要重写。
- **判断**：只为两个状态位建分支，成本和风险都不成比例。若将来因 DECSLRM、DECDWL 或矩形操作进入 G-CORE 受控分支，这项修复可以随之并入（ADR 方案三：分支只保留上游明确不要的补丁）。采用后 X02 可改为 supported；回滚方式是换回上游包。

### 3.4 (d) 经评审的字节流改写

设计：在 `terminalChannel` 中，对 `s.codec.decode` 的结果（UTF-8 会话是字节，其他编码是文本）按第 2 节规则识别 RIS，在 `terminal.write` 之前于 `c` 之后插入 `CSI ? 25 h CSI 20 l`（与 T32 补写相同；若将来有会话以 `convertEol: true` 为初值，就要改为插入 `CSI 20 h`）。必须满足：

1. **跨块识别**：保存一个跨块的“ESC 待定”标志。C0 可执行字符与 DEL 保持待定，ESC 重新开始待定，`c` 命中，其他字符清除待定。只匹配相邻的 `1B 63` 会漏掉 `ESC LF c` 一类情形。
2. **编码**：扫描的必须是 xterm 实际收到的数据。UTF-8 会话扫描原始字节（理由见第 2 节；`Utf8Boundary` 只扣留不完整的多字节尾部，不会扣留 ESC 或 `c`）；非 UTF-8 会话扫描解码后的文本。
3. **所有写入路径**：结束时的尾部（`endOutput`）、切换编码时的尾部（`setEncoding`）、启动或连接失败提示、T32 本地动作都直接写入 xterm，并改变解析器状态。扫描器必须经过同一个写入入口，否则“ESC 待定”会与 xterm 不一致。例如：主机块以 ESC 结尾，接着 T32 写入以 CAN 开头，解析器回到地面状态；下一个主机块以 `c` 开头时，xterm 把它显示为文本，扫描器却会插入修正。
4. **ACK 按原始块**：每个主机块仍只调用一次带回调的 `terminal.write`，写入插入后的数据。`pty_ack`/`ssh_ack`/`net_ack` 只带 `sequence`，`s.bytes` 与诊断按原始 `event.data.length` 计数，插入的字节不影响后端 64 KiB / 64 块的预算。不能为了插入把一块拆成多次带回调的写入，否则会重复 ACK。
5. **取消与关闭**：扫描状态属于会话。`s.disposed` 之后不再处理；重开是新会话，状态也是新的；不跨会话共享。
6. **字符串内不能误判**：按第 2 节，xterm 会在字符串之后的 `ESC c` 上执行 RIS，扫描器也必须当作 RIS 处理。如果扫描器把 OSC/DCS 内部“保护”起来，反而会与 xterm 不一致。真正不能命中的是 `ESC CAN c`、`ESC SUB c`、ESC 加中间字节再加 `c`，以及 ESC 加 C1 再加 `c`。
7. **冷归档顺序**：插入的序列不含 `ESC c` 或 `CSI 3 J`，所以 `terminal-core.ts` 的观察者对每个主机 RIS 仍只计 1 次清除。这两个序列不滚动屏幕，不影响写入回调中的 `history.capture()`。
8. **VT 适配器**：`CSI ? 25 h` 会经过适配器的 `CSI ? h` 观察者（参数 25 不改变影子状态），`CSI 20 l` 没有适配器处理器；DECRQM 回复仍由 xterm 生成；适配器在主机 RIS 上执行的 `resetAll` 不变。
9. **不放进 H4 边界**：`terminal-core.ts` 约定不接收字节流，也不写终端。

**门禁判断**：ADR 五道门禁的字面定义都不直接覆盖“字节流改写”：不升级（G-UPGRADE），不向上游提交（G-CONTRIB），不分叉、不换内核（G-CORE）。把它列为需要评审的路线的，是 [P1 计划](PLAN.zh-CN.md)第 4 片第二步和用户决定第 3 项。按 T32 第 5 节使用过的四条标准逐条看：不改 xterm 的版本、代码或配置；不改变状态归属，但扫描器保存的“ESC 待定”是解析器状态的一个镜像位，需要评审确认它不属于 G-CORE 所禁止的“同步两份状态规避缺口”；**改写了**送进 xterm 的主机数据（T32 正是以“主机块原样到达 xterm”为依据判断自己不触及 ADR 的）；只用公开 API。

**成本与风险**（粗估）：实现 1–2 人日，测试与差分验证 1–2 人日，另加审查；每次升级都要对照新的解析器状态表复核第 2 节规则（属于 G-UPGRADE 的“重跑兼容原型”）。风险包括规则复刻错误或随升级漂移、遗漏写入路径，以及热路径开销：每块都要扫描是否有 ESC，只有命中时才分配新缓冲区，开销未测。**X02**：两项 `test.fail` 可以转为通过，生产列可以提请改为 supported（原样 xterm.js 列不变）。**回滚**：去掉扫描调用，恢复原来的写入。

### 3.5 (e) 公开解析器钩子

机制：`terminal.parser.registerEscHandler({ final: "c" }, …)` 返回 `false`，在 xterm 执行 RIS 的同一个解析时刻同步运行，位于内置 `fullReset` 之前。执行时机由 xterm 自己的解析器决定，所以第 2 节的各种情形（跨块、字符串结束、中间夹 C0、各种编码、任意写入路径）都自动一致。它不读、不改主机字节，与 ACK、冷归档和适配器都没有交集。钩子里能同步修改的状态如下：

- **E1（LNM，公开 API）**：`terminal.options.convertEol = <会话初值>`。这与 xterm 处理 `CSI 20 l` 走的是同一个选项设置器：值不变时不触发事件，值改变时与主机发 `CSI 20 h/l` 一样触发渲染器的选项刷新（`OptionsService.ts:127–136`）。RIS 不修改选项，所以设置会保留下来。Node 探针：`CSI 20 h … ESC c A LF B` 之后 DECRQM 20 回复 `;2$y`，`B` 在第 2 列；同一块中 `ESC c CSI 20 h` 之后仍为置位，顺序正确。
- **E2（DECTCEM，私有字段）**：没有公开 API 能同步清除 `isCursorHidden`，在解析器之内只有 DECSET 25 与 DECSTR 两条路径。唯一可行的是写私有字段 `terminal._core.coreService.isCursorHidden = false`。Node 探针：裸 RIS 之后回复 `?25;1$y`；同一块中 `ESC c CSI ? 25 l` 之后仍隐藏，顺序正确。这些名字在 6.0.0 的 `lib/` 和本应用生产包中都能检索到。DOM 中是否立即画出光标未测（RIS 随后会整屏刷新，推测会画出）。
- **E3（在钩子里 `terminal.write` 修正序列）：不可行**。新写入会排在当前块剩余部分以及已排队的块之后（`WriteBuffer.ts:127–129`）。Node 探针：`ESC c CSI ? 25 l A LF B` 执行完后光标反而可见，`B` 在第 1 列，两项都错。ADR 背景表对矩形操作记录过同样的顺序问题。异步处理器（返回 Promise）只能暂停解析，同样不能把数据插到当前块剩余部分之前。
- 公开的 `terminal.reset()` 两项都不恢复（探针），不能用来替代。

**门禁判断**：

- **E1**：不改 xterm 版本或代码；不新增状态（钩子什么也不保存，只把 xterm 自己的选项恢复为初值）；不改主机字节；只用公开 API。它与 ADR 当前路线“回复类缺口继续使用已存在的公开 parser 适配层”（H1）属于同一类，按 T32 的四条标准不触及 G-UPGRADE、G-CONTRIB 或 G-CORE。灰色地带是它在运行时修改了一个嵌入方选项：本产品不设置 `convertEol`（默认 false）；将来若按会话设置，钩子必须恢复该会话的初值。归类需用户或审查者确认。
- **E2**：同样不改代码、不改状态归属、不改字节，但依赖私有字段，违反适配层“只用公开 API”的约定（`vt-adapters.ts` 头注释，以及 VT 矩阵“生产 VT 适配器”一节）。它不属于 G-CORE 的分支、换核或改变归属，但每次升级都要按 G-UPGRADE 的“重新核实……私有 API”复核：上游内部名字确实会变，例如 master 已把 6.0.0 的 `coreMouseService` 改名为 `mouseStateService`。这将是生产包第一次引入 xterm 私有 API，需要用户明确批准。

**放置**：不放进 `terminal-core.ts`，因为 H4 边界约定只读，从不写终端。E1 可以放进 `vt-adapters.ts`，与已有的 `ESC c` 观察者放在一起，VT 矩阵探针会自动覆盖。E2 宜单独做成一个小模块，在名字与注释中标明使用私有 API，并带特性检测（字段不存在或不是布尔值时不写入，退回已知缺陷）；该模块由工作区工厂与 VT 矩阵探针共同挂载。

**成本与风险**（粗估）：E1 含测试约 0.5 人日；E2 另加 0.5–1 人日（含守护测试）。E1 风险低；E2 的风险是升级时私有字段失效。守护测试与原样固定测试会在 G-UPGRADE 回归中发现失效，失效时退回已知缺陷而不报错。**X02**：只做 E1 只修复 D2，X02 仍为 partial；E1 与 E2 一起做，两项 `test.fail` 可以转为通过，生产列可以提请改为 supported。**回滚**：删除钩子注册（一处 import），没有数据迁移。

### 3.6 对照表

| | (a) 等上游 | (b) 贡献上游 | (c) 补丁/分支 | (d) 字节流改写 | (e) E1 | (e) E2 |
| --- | --- | --- | --- | --- | --- | --- |
| 触及门禁 | G-UPGRADE | G-CONTRIB（需对外授权），采用时 G-UPGRADE | G-CORE，每次合并 G-UPGRADE | 字面上不触及 G-*；按用户决定须经评审；改写主机数据 | 按 T32 标准不触及（待确认） | 私有 API，每次升级按 G-UPGRADE 复核；需用户批准 |
| 修复 D1 / D2 | 视上游 | 视上游 | 是 / 是 | 是 / 是 | 否 / 是 | 是 / — |
| 首次成本（粗估） | 0 | 0.5–2 人日，另加等待 | 1–2 人周起 | 2–4 人日 | 0.5 人日 | 另加 0.5–1 人日 |
| 持续成本 | 升级回归 | 跟进讨论 | 每次合并 1–3 人周 | 每次升级复核规则 | 低 | 每次升级复核私有字段 |
| 主要风险 | 无限期 | 发布不可控；D2 需要设计 | 补丁难维护，与 ADR 结论冲突 | 规则复刻与漂移、遗漏写入路径 | 选项初值的语义 | 私有字段变动 |
| X02 | 不变 | 升级前不变 | 可改回 supported | 可改回 supported | 仍为 partial | 与 E1 一起可改回 supported |
| 回滚 | — | — | 换回上游包 | 去掉扫描 | 删除注册 | 删除模块 |

成本均为粗估量级，未经拆解评审，不是排期。

## 4. 推荐方案与理由

**推荐 (e)：E1 与 E2 一起做；取得对外授权后并行开展 (b)，向上游提 issue；以 (a) 作为最终出口。**

1. RIS 的执行时机由 xterm 自己的解析器决定，第 2 节列出的边界情形天然一致；(d) 则要在 xterm 之外复刻并长期维护这套规则，还要求所有写入路径都经过同一个入口。
2. 不改主机字节，保持 T32 与第 4 片测试依赖的不变式：主机块原样到达 xterm，ACK 按原始块确认；冷归档与适配器也不受影响。
3. 改动最小，可以单点回滚；E1 只用公开 API。
4. E2 的私有 API 风险明确、局部、可以检测；xterm 已精确锁定版本，升级必须过 G-UPGRADE。与 (d) 的规则漂移相比，这种风险更容易被发现。
5. (c) 为两个状态位建分支不成比例；(a) 和 (b) 都给不出交付时间。

如果用户不接受 E2 的私有 API：退而只做 E1。D1 保留为已知缺陷（`test.fail` 保持，X02 仍为 partial，用户可用 T32 硬复位手动恢复），等待上游。只有当 D1 被认定阻塞交付时，再在只插入 `CSI ? 25 h` 的 (d) 与 (c) 之间另作决定。

不建议：E3（顺序错误）；只为本项做 (c)；用 patch-package 修改压缩产物（ADR 已否定）。

上游修复发布并按 G-UPGRADE 升级之后，原样固定测试会开始失败，此时删除 E1/E2，两项测试改回普通断言。

## 5. 测试清单

采用 (e) 时，经生产会话路径（stub IPC → Channel → `session-lifecycle` → xterm + 适配器 → 按序 ACK），覆盖 pty、ssh、net：

1. 现有两项 `test.fail` 去掉标注后通过；原样固定测试（`vt: false`）仍然通过，证明修复来自兼容层而不是 xterm 本身。
2. **跨块逐字节**：先 `CSI ? 25 l CSI 20 h`，再把 `ESC c`、`ESC LF c` 分别按整块、逐切点、逐字节送入，结果一致：光标可见、LNM 关闭、DOM 中有光标。
3. **同块顺序**：`ESC c CSI ? 25 l`、`ESC c CSI 20 h` 之后保留主机的设置；连续两次 RIS 正常。
4. **字符串之后的 RIS**：`OSC 0;t ESC c`（含 C1 形式的 OSC）、`DCS $ q m ESC c`、APC/PM 之后的 `ESC c`，修复生效，并且 RIS 的执行情况与原样 xterm 一致；DCS 情形下 DECRQSS 是否应答与现状相同（只记录，不改变）。
5. **不是 RIS 的情形**：`ESC CAN c`、`ESC SUB c`、`ESC # c`、`ESC U+0085 c` 不触发修复，状态与原样 xterm 相同。
6. **非 UTF-8 会话**：在 GBK、Big5、Shift_JIS 会话中，让多字节字符紧挨 RIS、让前导字节后接 `ESC c`，并在任意位置跨块切开，结果与 UTF-8 一致。
7. **ACK 与主机字节**：逐次记录 `terminal.write`，主机块原样到达，ACK 每块一次且按序；ACK 挂起期间 RIS 前后的输入顺序不变（沿用 spec 第 89 行用例的做法）。
8. **冷归档计数**：每个主机 RIS 只计 1 次清除、0 次缺口；RIS 之前已归档的行保留；与 T32 硬复位组合时计数正确。
9. **VT 适配器**：RIS 之后的 DA、DECRQSS、CPR、DECSCL 结果不变（沿用现有用例）；OSC 52 策略不变。
10. **T32 与 DECSTR**：用户硬复位的结果不变，与修复叠加没有副作用；DECSTR 行为不变。
11. **渲染**：RIS 之后 DOM 中出现 `.xterm-cursor`；读屏模式下没有异常。仅限浏览器，原生未测。
12. **E2 守护**：断言私有字段存在且为布尔值；在单元级模拟字段缺失，确认不抛错、退回已知缺陷。
13. **反向验证**：临时去掉钩子，第 1–4 项应失败；还原后通过。
14. **VT 矩阵与回归**：X02 探针补充 DECRQM `?25` 与 `20` 的断言（原样列保持 partial，生产列按用户决定更新）；新增项 `--repeat-each 5`；本机全量浏览器 E2E。

若改为采用 (d)，还要追加：规则差分测试（随机与穷举短序列，扫描器命中数与 xterm 观察者计数逐块一致）；在各本地写入路径（结束尾部、切换编码、失败提示、T32 动作）之后，下一个主机块的识别仍正确；不出现重复 ACK；大流量吞吐对比。

上述测试都只是浏览器 IPC stub 证据，不代表原生 WKWebView/WebView2/WebKitGTK、真实 Shell/SSH/Telnet 主机程序、vttest 或 WindTerm 2.7.0 对照的结论。

## 6. 需要用户决定的事项

1. **选择路线**：
   - **R1（推荐）**：E1 + E2。在浏览器证据范围内两项缺陷都修复，两项 `test.fail` 转为通过；生产包第一次依赖一个 xterm 私有字段，每次升级按 G-UPGRADE 复核，失效时退回已知缺陷。
   - **R2**：只做 E1。修复 LNM；DECTCEM 保留为已知缺陷，X02 仍为 partial，不引入私有 API。
   - **R3**：(d) 字节流插入。两项都修复，只用公开 API，但要改写送进 xterm 的主机数据，并在应用中复刻解析规则。
   - **R4**：只等上游 (a)。不改代码，两项缺陷保持现状。
   - **R5**：(c) 受控补丁或分支。不推荐。
2. **是否授权向 xterm.js 上游提交 issue**（G-CONTRIB 的对外授权）。推荐授权：issue 描述两项缺陷及其与 #4119 的关系，是否提交 D1 的 PR 视维护者回复再定；内部等待上限推荐定为 P1 第 6 片组合验收，到期上游仍未发布时继续沿用所选路线。选“不授权”则不对外发言，只走本地路线。
3. **E1 的门禁归类**：是否同意 E1 不触及 ADR 门禁（与第 6 项认定 T32 补写时的标准相同）。推荐同意；若不同意，E1 也要走专项评审。
4. **X02 状态**：实施后两项都修复并通过测试时，是否把 VT 矩阵 X02 的生产列改回 supported（原样 xterm.js 列保持 partial）。推荐两项都修复后再改；只做 E1 时保持 partial。

本文不实施任何方案；上述决定作出前，产品行为、测试与 X02 状态保持不变。

## 7. 未验证与边界

- Node 探针没有 DOM 渲染器，也不是浏览器或原生 WebView；本次没有新跑浏览器测试；原生 WebView、真实 Shell/SSH/Telnet 程序、vttest 与 WindTerm 2.7.0 均未对照。
- 1.4 节标为推测的影响面没有抓包或实测；`TERM=linux` 的结论只来自 terminfo。
- 上游检索限于所列词语，结论是“没有找到”，不是“不存在”；6.1.0-beta 只读了 master 源码，没有实测。
- E2 只在 Node 中验证了模式状态，私有字段写入后 DOM 是否立即绘制光标未测。
- 所有成本都是粗估，不是排期。

## 8. 引用

- 本仓库：[ADR](../p0/TERMINAL_CORE_ADR.zh-CN.md)、[路线决定表](../p0/TERMINAL_ROUTE_DECISION_2026-10-15.zh-CN.md)、[VT 矩阵](../p0/VT_MATRIX.zh-CN.md) X02、[T32 预案](CLEAR_RESET_PLAN.zh-CN.md)、[历史预算预案](HISTORY_BUDGET_PLAN.zh-CN.md)第 11 节（RIS 计为清除）、[`session-lifecycle.ts`](../../apps/desktop/src/session-lifecycle.ts)（`terminalChannel`、`acknowledge`）、[`session-encoding.ts`](../../apps/desktop/src/session-encoding.ts)、[`utf8-boundary.ts`](../../apps/desktop/src/utf8-boundary.ts)、[`terminal-core.ts`](../../apps/desktop/src/terminal-core.ts)、[`vt-adapters.ts`](../../apps/desktop/src/terminal-compat/vt-adapters.ts)、[`terminal-actions.ts`](../../apps/desktop/src/terminal-actions.ts)。
- xterm.js：[#814](https://github.com/xtermjs/xterm.js/issues/814)、[#1532](https://github.com/xtermjs/xterm.js/issues/1532)、[#4119](https://github.com/xtermjs/xterm.js/issues/4119)、[#6278](https://github.com/xtermjs/xterm.js/pull/6278)、[#5686](https://github.com/xtermjs/xterm.js/issues/5686)；master [`08829c7`](https://github.com/xtermjs/xterm.js/commit/08829c7eb6279dda2a9e86df901353a1a89858ca)。
- 规范：[VT100 用户指南第 3 章](https://vt100.net/docs/vt100-ug/chapter3.html)、[VT510 RIS](https://vt100.net/docs/vt510-rm/RIS.html)、[VT510 DECTCEM](https://vt100.net/docs/vt510-rm/DECTCEM.html)、[VT510 LNM](https://vt100.net/docs/vt510-rm/LNM.html)；xterm [`charproc.c`](https://github.com/ThomasDickey/xterm-snapshots/blob/a73913e0e5435f24d530336f90822d21e7afdd08/charproc.c)（`ReallyReset`）。
