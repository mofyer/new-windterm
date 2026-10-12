# P0 VT 兼容矩阵（xterm.js 6.0.0 + 生产 VT 适配器）

日期：2026-10-12（接入生产 VT 适配器；原样行为首测于 2026-10-11）。依赖：`@xterm/xterm 6.0.0`（`package-lock.json` 精确锁定）。状态：**63 项浏览器探针全部按"当前观察值"断言通过**。探针默认挂载与工作区工厂相同的[生产 VT 适配器](#生产-vt-适配器)；与适配器相关的 8 项（S03、K02、R06、D01–D04、O04）同时断言 `vt: false` 下的原样 xterm.js 证据。这只是浏览器中的行为证据，不是 VT 兼容验收：**未运行 vttest**，未与 WindTerm 2.7.0 实机或真实 xterm/DEC 硬件逐项对照，"期望"一列来自公开文档而非实测；适配器未在 Tauri 原生 WebView、真实 PTY/SSH 主机程序上验证。

## 方法与边界

- 探针：[`vt-matrix.spec.ts`](../../apps/desktop/tests/e2e/vt-matrix.spec.ts)，页面侧夹具：[`support/vt-harness.ts`](../../apps/desktop/tests/e2e/support/vt-harness.ts)。每项在页面中以 `/node_modules/@xterm/xterm/lib/xterm.mjs` 新建一个独立 `Terminal`，写入控制序列后，只通过以下途径观察：公开 buffer API（`cursorX/Y`、`translateToString`、`isWrapped`、`IBufferCell` 属性与颜色模式）、`onData`/`onBinary` 回复、`onTitleChange`、`modes`、DOM 渲染器输出的行元素 class/样式，以及派发到 `.xterm-screen` 的合成鼠标/滚轮事件。
- 适配器开关：夹具默认对每个探针终端调用生产代码 `attachVtAdapters`（与 `terminal.ts` 工厂相同）；传 `vt: false` 得到原样 xterm.js（保留原样证据），传 `vt: { terminalType, clipboardWrite }` 选择终端类型或打开 OSC 52 写入。夹具把剪贴板写入接到桩函数，不碰真实剪贴板。H01–H03 是钩子可行性实验，始终在原样 xterm.js 上运行。
- 状态定义：**supported** 对所测案例符合所引资料；**partial** 部分符合，缺口写在标题 `known gap:` 之后；**unsupported** 序列被忽略或回答错误。状态按"生产配置"（挂适配器）判定。缺口测试断言的是"今天的错误行为"，依赖升级改变行为时会失败，需要人工重新判定，不能当作已对齐。
- 每项测试都把 `{id, sequence, expected, observed, features, xterm, adapters}` 作为 JSON 附件写入 Playwright 报告；`adapters` 说明本项是否挂了适配器。
- 环境：系统 Chrome（Playwright `channel: 'chrome'`）+ xterm DOM 渲染器（应用未使用 WebGL addon）。未覆盖 Tauri WKWebView、真实输入设备、IME。探针使用 xterm 默认选项加适配器；生产工厂 `createWorkspaceSession`（`createWorkspaceTerminal` 是它的包装）另启用 Unicode 11 宽度与 `screenReaderMode`，这两项不影响本表的控制序列语义，但未在生产工厂上重复测量。
- 参考资料：[xterm ctlseqs](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)、[VT100 用户指南第 3 章](https://vt100.net/docs/vt100-ug/chapter3.html)、[VT510 程序员参考](https://vt100.net/docs/vt510-rm/)（DECSC、DECSTR、DECALN 等条目）、xterm.js 6.0.0 源码 `src/common/InputHandler.ts` 中的 `@vt` 支持标注。**本轮未取得 DEC STD 070 原文，表中未直接引用它**；DEC 语义以 VT100 UG / VT510 RM 为准。
- VT52（T25）不在本表，见 [终端兼容报告](TERMINAL_COMPAT.zh-CN.md) 与 `vt52-compat.spec.ts`。

## 统计

| 状态 | 数量 | 探针 |
| --- | --- | --- |
| supported | 39（其中 3 项是钩子可行性 H01–H03；4 项依赖适配器：S03 K02 R06 D01） | C01 C02 C04 S01 S02 S03 W01 W03 E01–E06 B01 G01 G02 A01 A03 M01–M03 M06 K01 K02 R01 R02 R04 R05 R06 D01 D06 X02 O01–O03 H01–H03 |
| partial | 15（D02 D03 O04 由适配器从 unsupported 改为 partial） | C03 W02 W04 G03 G05 L02 A02 M04 R03 D02 D03 D05 D08 X01 O04 |
| unsupported | 9 | S04 E07 B02 G04 L01 M05 D04 D07 P01 |

原样 xterm.js 6.0.0（`vt: false`）仍为 supported 35、partial 16、unsupported 12；上一版（2026-10-11）的统计就是这一组。

## 生产 VT 适配器

代码在 `src/terminal-compat/`：入口 [`vt-adapters.ts`](../../apps/desktop/src/terminal-compat/vt-adapters.ts)，终端类型身份 [`vt-profiles.ts`](../../apps/desktop/src/terminal-compat/vt-profiles.ts)，SGR 影子状态 [`sgr-state.ts`](../../apps/desktop/src/terminal-compat/sgr-state.ts)，OSC 52 策略 [`osc52-clipboard.ts`](../../apps/desktop/src/terminal-compat/osc52-clipboard.ts)。`terminal.ts` 的 `createWorkspaceSession` 为每个工作区终端挂载一份，会话关闭时随终端一起释放。

- **只用公开 API**：xterm.js 6.0.0 的 `parser.registerCsiHandler/registerDcsHandler/registerEscHandler/registerOscHandler`、`modes`、`buffer`、`onResize`。只需观察的序列（SGR、DECSTBM、DECSCUSR、DECSC/DECRC、备用屏、DECSTR、RIS）处理器返回 `false`，仍由 xterm.js 执行。
- **回复路径**：回复用公开的 `Terminal.input(data, false)` 发出，经 `onData` 与键盘输入走同一条 `pty_write`/`ssh_write`/`net_write` 路径，不另开 IPC。[`vt-adapters-contract.spec.ts`](../../apps/desktop/tests/e2e/vt-adapters-contract.spec.ts) 用 IPC 桩验证回复只到达本会话的 `pty_write`、`ssh_write` 或 `net_write`（Telnet 标签）。
- **输入不可信**：所有参数先校验再使用，只回答第一个参数为 0（或省略）的身份请求，其余吞掉；回复长度固定或有界；OSC 52 负载有上限且内容不记录。

### 终端类型与身份回复

会话级选项 `terminalType`（`attachVtAdapters` / `createWorkspaceSession` 的参数，运行中可用 `vt.setTerminalType` 切换），默认 `xterm-256color`；没有界面入口，未知值回落到默认。

| 类型 | DA1 `CSI c` | DA2 `CSI > c` | DA3 `CSI = c` | XTVERSION `CSI > 0 q` | DECSCL 上限（RIS 后的等级） |
| --- | --- | --- | --- | --- | --- |
| `xterm-256color`（默认） | `CSI ?1;2c`（与原样逐字节相同） | `CSI >0;276;0c`（相同） | 不回复（相同） | `DCS >\|new-windterm(0.0.1) ST`（原样不回复） | 61，不可提升；DECRQSS `61;1"p`（相同） |
| `vt100` | `CSI ?1;2c` | 不回复（真实 VT100 不认识 DA2） | 不回复 | 不回复 | 61 |
| `vt220` | `CSI ?62;6;9;22c` | `CSI >1;10;0c` | 不回复 | 不回复 | 62 |
| `vt420` | `CSI ?64;6;9;22c` | `CSI >41;10;0c` | `DCS !\|00000000 ST` | 不回复 | 64 |
| `vt520` | `CSI ?65;6;9;22c` | `CSI >64;10;0c` | `DCS !\|00000000 ST` | 不回复 | 65 |

- 默认类型下 DA1、DA2、DA3（无回复）与 DECRQSS `"p` 都与原样 xterm.js 逐字节相同；唯一变化是 XTVERSION 由"无回复"变为回复应用名与 `package.json` 版本（测试会核对版本一致）。
- DA1 的功能参数只列当前确实具备的：6 选择性擦除（E05）、9 NRCS 字符表（G03：表可用但不受 DECNRCM 控制）、22 ANSI 颜色；不宣称 132 列、打印机、UDK、矩形编辑、SIXEL。DA2 的固件版本 10 是自定值，DA3 的单元 ID 固定为 0，均未对照真实硬件。
- **只发 7 位回复，不支持 S8C1T**：`ESC SP G` 仍被 xterm.js 忽略，所有回复以 7 位 `ESC [`/`ESC P` 开头（D04）；DECSCL 的 8 位参数（Pc = 0 或 2）被忽略，DECRQSS 始终报告 `;1"p`。
- **DECSCL 只改报告的等级**：接受 61 到类型上限，超出或非法参数保持不变；不执行 DECSTR 式软复位，也不按等级开关任何功能（D02 仍是 partial）。DECSTR 不改等级，RIS 与切换类型恢复为类型上限。DA1 始终报告类型的最高等级，与 xterm 相同。
- **只改回复**：`TERM`、SSH `pty-req`、Telnet TTYPE 仍是 `xterm-256color`，主机端 terminfo 不随类型变化；键盘映射、VT52、字符集与各模式也不随类型变化。没有 `vt102`/`vt320`/`vt340` 类型。

### DECRQSS 与 CPR

- **SGR**（`DCS $ q m ST`，R06）：影子状态移植 xterm.js 6.0.0 `charAttributes` 的语义，包括 38/48/58 的分号与冒号形式；跟踪 DECSC/DECRC、SCOSC/SCORC、1048/1049/47/1047（每个缓冲区各有保存值）、DECSTR、RIS，以及开启 `windowOptions.setWinLines` 后 DECCOLM 引起的整体复位。报告以 `0;` 开头。[`vt-adapters.spec.ts`](../../apps/desktop/tests/e2e/vt-adapters.spec.ts) 把 38 种状态的报告回放到原样 xterm.js 上，单元格属性与 DOM 下划线样式全部一致。已知近似：OSC 8 超链接会改动 xterm 的私有扩展位，影子不跟踪；xterm.js 把 SGR 59 画成白色下划线，报告给出的是请求的默认色；直接调用公开的 `terminal.reset()` 会绕过解析器，必须同时调用 `vt.reset()`（当前生产代码没有这种调用）。
- **DECSCUSR**（`DCS $ q SP q ST`，K02）：主机设置过 DECSCUSR 时报告该值，包括只改闪烁的 7、8 等参数；`CSI 0 SP q`、DECSTR、RIS 之后回到 xterm.js 内置回复（来自 `cursorStyle`/`cursorBlink` 选项）。
- `DCS $ q " p ST` 由适配器回答；`r`、`" q` 与未知请求仍由 xterm.js 内置回答。
- **CPR / DECXCPR**（`CSI 6 n`、`CSI ? 6 n`，S03）：只在 DECOM 开启时由适配器回答，行号相对影子上边距；DECOM 关闭时仍由 xterm.js 回答。影子边距按缓冲区分别记录，DECSTBM 参数校验与 xterm.js 相同，DECSTR、RIS、任何尺寸变化与离开备用屏都会复位。列号与 xterm.js 相同，因此待换行时仍报告 cols+1（W02 未修）；DECXCPR 不带页码参数，也与 xterm.js 相同。

### OSC 52 剪贴板

- **读取**（`Pd = ?`）始终拒绝、从不回复；提示一次"已拒绝读取"。
- **写入默认关闭**：序列被吞掉，不回显、不回复、不解码负载；提示一次"已拦截"。这类重复提示（拦截、拒绝读取、负载无效）每个会话只出现一次，切换授权后重新计数。
- **会话级授权**：命令面板「切换当前会话 OSC 52 剪贴板写入 · 默认关闭」；开启后状态栏显示"OSC 52 可写剪贴板"。授权只在内存里，不持久化，新会话一律默认关闭。
- **可见提示**：授权后每次真正写入剪贴板都弹出提示，只含字节数、不含内容。同一批输出里的连续写入最多保留一个在途、一个等待（新的覆盖旧的），被覆盖的写入不会到达剪贴板。关闭授权或关闭会话时丢弃等待中的写入，在途写入执行前会再检查一次授权。
- **限制**：base64 最多 1 MiB 字符（解码后最多 768 KiB）；必须是规范 base64、合法 UTF-8，并且不含 TAB/CR/LF 以外的 C0、DEL 或 C1 控制字符，防止植入粘贴后才生效的转义序列；选区参数只接受 xterm 定义的 `c p q s 0–7`，最多 16 个；空负载（清除选区）不支持。超出 xterm.js 自身 10 MB OSC 上限的序列不会交给处理器，同样被吞掉。
- **不记录内容**：负载与解码文本不写日志、不进入提示；测试拦截 `console` 验证。
- 写入使用 `navigator.clipboard.writeText`。Tauri WKWebView、WebView2、WebKitGTK 是否允许在没有用户手势时写入**未验证**；失败时提示"写入失败"。

### 开销与其它边界

- 解析层开销（Chrome + Vite 开发服务器，不打开渲染器，10 MiB，4 次）：[性能基线](PERFORMANCE_BASELINE.zh-CN.md)的混合负载约 126 ms → 146 ms；每 2 个字符就插一个 256 色 SGR 的极端负载约 100 ms → 160 ms，其中约 15 ms 是公开钩子本身的派发开销。没有在 app 全链路、WKWebView 中测量，性能基线文档的数字未重测。
- 处理器后注册的先执行。隔离的 SIXEL 原型（`@xterm/addon-image`）也注册 DA1；如果将来在工厂之后加载插件，插件的 DA1 会抢在适配器前回复。接入前必须让身份由适配器统一回答，见[终端内核技术调整建议](TERMINAL_CORE_ADR.zh-CN.md)。
- 未验证：Tauri 原生 WebView、真实 PTY/SSH/Telnet 主机上的应用（vim、tmux 等查询 DA/XTVERSION 的行为）、IME、Windows/Linux。

## 按终端类型的结论

| 终端类型 | 功能 ID | 可用（原样或经适配器） | 缺口 | 判断 |
| --- | --- | --- | --- | --- |
| VT100 | T07 | 光标定位、DECSTBM、DECOM（CPR 相对行靠适配器，S03）、自动换行、制表位、DEC 特殊图形、SO/SI、基本 SGR、DECSC、RIS；`vt100` 类型 DA1 `?1;2c`、不回复 DA2（D01） | DECDWL/DECDHL（L01）、DECALN 不复位边距（L02）、DECSCNM/DECCOLM（D07/D08）、闪烁不渲染（R03）、待换行列号（W02） | 部分；行属性需渲染器/内核 |
| VT102 | T26 | IL/DL/ICH/DCH/IRM（E01–E03） | 适配器没有 `vt102` 类型，DA1 不能报告 VT102（`?6c`），见 D01 | 编辑功能原样可用；身份仍缺 |
| VT220 | T08 | DECSCA/DECSEL、ECH、DECSTR 主体、DEC 图形；`vt220` 类型的 DA1/DA2 与 DECSCL 等级报告（D01/D02，适配器） | NRCS 不受 DECNRCM 控制（G03）、SS2/SS3（G04）、LS1R 等落到 GL（G05）、S8C1T（D04，适配器按设计只发 7 位）、DECSCL 不软复位也不切换功能（D02）、DECDSR 打印机/键盘（D05）、DECSTR 后自动换行仍开启（X01） | 部分；8 位 C1、单次切换、级别行为仍缺 |
| VT320（无独立 ID） | — | 本表未单独区分 VT320 引入的序列；报告类结果见 D06（DECRQM 已识别模式）、S01（DECRQSS 边距），DECRQSS SGR/光标样式/一致性等级由适配器回答（R06、K02、D02） | 多个模式回 0（D07、G03、S04）；状态行 DECSSDT/DECSASD 未测；没有 `vt320` 类型 | 未单独判定，按 VT220/VT420 结论处理 |
| VT340 | T09 | — | SIXEL 被吞掉不绘制、DA1 不含 `4`（P01）；ReGIS 未测 | 需 `@xterm/addon-image`：0.9.0 已作为开发依赖做隔离原型，生产 CSP 会阻止其 WebAssembly 解码器，见[终端内核技术调整建议](TERMINAL_CORE_ADR.zh-CN.md) |
| VT420 | T10 | DECIC/DECDC（E06）；`vt420` 类型的 DA1/DA2/DA3（D01/D03，适配器） | DECSLRM/DECLRMM（S04）、矩形操作（E07）、DECSC 不保存 DECOM/换行（C03） | 需内核改动 |
| VT520 | T11 | DECSCUSR 渲染（K01）与 DECRQSS 报告（K02，适配器）、DECRQM；`vt520` 类型的身份与 DECSCL 等级报告 | DECST8C（B02）、DECSCL 只改报告（D02） | 部分 |
| xterm | T12 | 1049/1047（A01）、括号粘贴、鼠标 1000/1002/1003/1006、焦点 1004、OSC 0/2/4/10/11/12/8、REP、SCOSC；XTVERSION 与会话授权后的 OSC 52 写入（D03/O04，适配器） | 47 退出即丢弃内容（A02）、1016 像素坐标起点未核对（M04）、1005/1015（M05）、OSC 52 读取按策略拒绝（O04）、XTGETTCAP（D03）、XTWINOPS 需显式开放（D08）、反向换行只撤销软换行（W04） | 大部分可用 |
| xterm-256color | T13 | 16/256 色 SGR、OSC 4 查询/设置/复位（R04、O02） | — | 原样可用 |
| true-color | T16 | `38;2`、`48;2`、`38:2::r:g:b`、`38:2:Pi:r:g:b`（R05）；DECRQSS 报告颜色（R06，适配器） | — | 可用（报告靠适配器） |
| 鼠标协议 | T17 | M01–M03 | 1016 像素坐标为 0 基、与 xterm 是否一致未核对（M04）；urxvt/UTF-8 编码（M05） | 基本可用（缺旧编码，像素模式待核对） |
| 自动换行 | T18 | W01、W03 | W02 列号、W04 反向换行 | 部分 |
| 自定义终端类型 | T20 | 会话级 `terminalType`（`xterm-256color`/`vt100`/`vt220`/`vt420`/`vt520`）决定 DA1/DA2/DA3/XTVERSION 与 DECSCL 等级报告（D01–D03，适配器） | 没有界面入口；只改回复，`TERM`/SSH pty-req/Telnet TTYPE 不变；DECSCL 不切换功能；XTGETTCAP 无回复；不能自定义回复内容 | 回复层已接入；"自定义"本身未实现 |
| vttest 范围 | T21 | — | 本表覆盖的只是若干 vttest 相关序列的样本 | **vttest 未运行**，不能据此判定 |

## 明细

列说明：序列使用 7 位表示；"观察值"均为本轮实测，未注明时原样与挂适配器结果相同，不同时分别写"原样"与"适配器"；光标坐标为 0 基 `(x, y)`，CPR 为 1 基。

### 光标移动与保存/恢复

| ID | 序列 | 期望（依据） | xterm.js 6.0.0 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| C01 | `CSI 3;5H`、CUU/CUD/CUF/CUB/CNL/CPL/CHA/VPA/HPR/VPR，`CSI 6n` | ECMA-48/VT100 光标寻址，CPR `CSI r;c R` | 每步位置符合（终点 (8,5)）；CPR `CSI 6;9R` | supported | T07 T12 T21 |
| C02 | `CSI 2;3H` SGR 1;31 `ESC ( 0` `ESC 7` … `ESC 8` `q` | VT510 DECSC 保存位置、SGR、字符集 | 回到 (2,1)，`q` 显示为 `─`、粗体、前景 16 色 1 | supported | T07 T21 |
| C03 | `CSI ?6h ESC 7 CSI ?6l ESC 8`；`CSI ?7l ESC 7 CSI ?7h ESC 8` | VT510 DECSC 还保存"origin mode 状态"和"wrap flag" | DECRQM ?6 → `?6;2$y`（期望 1）；?7 → `?7;1$y`（期望 2） | partial | T10 T11 T21 |
| C04 | `CSI 3;4H CSI s CSI 1;1H X CSI u Y` | ctlseqs：DECLRMM 关闭时 `CSI s` 为 SCOSC | `Y` 落在 (3,2)，光标 (4,2)；上游源码仍标 `#P[TODO]` | supported | T12 |

### 滚动区域与原点模式

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| S01 | `CSI 2;4r`，下边距 LF，上边距 `ESC M`，`DCS $ q r ST` | VT100 DECSTBM；DECRQSS `2;4r` | 光标归位 (0,0)；LF 后 `1,3,4,_,5,6`；RI 后 `1,_,3,4,5,6`；`DCS 1$r2;4r ST` | supported | T07 T21 |
| S02 | `CSI 3;5r CSI ?6h`，`CSI 2;3H`，`CSI 9;1H` | VT100 UG DECOM：原点在边距内，光标不能离开边距 | (0,2)、(2,3)、钳制到 (0,4) | supported | T07 T21 |
| S03 | `CSI 3;5r CSI ?6h CSI 1;1H`，`CSI 6n`、`CSI ?6n`；`CSI 2;4H CSI 6n`；`CSI ?6l CSI 4;2H CSI 6n` | VT100 UG CPR："行号取决于 Origin Mode" → `CSI 1;1R` | 原样：`CSI 3;1R`、`CSI ?3;1R`、`CSI 4;4R`（绝对行）；适配器：`CSI 1;1R`、`CSI ?1;1R`、`CSI 2;4R`；关闭 DECOM 后两者都是 `CSI 4;2R` | supported（适配器） | T07 T21 |
| S04 | DECRQM ?69；`CSI ?69h CSI 3;6s CSI 1;3H ABCDEFGH` | ctlseqs：DECLRMM 开启时 `CSI Pl;Pr s` 为 DECSLRM（VT420） | `?69;0$y`（未识别）；`CSI 3;6s` 当作 SCOSC，文本 `  ABCDEFGH` 不在第 6 列换行 | unsupported | T10 T11 T21 |

### 自动换行与反向换行

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| W01 | 10 列写 12 字符 | VT100 DECAWM 默认开启 | `0123456789` / `AB`，第 2 行 `isWrapped=true`，光标 (2,1) | supported | T07 T18 T21 |
| W02 | 10 列写满 10 字符，`CSI 6n` | DEC 末列标志：光标停在第 10 列，CPR `1;10R` | `cursorX=10`，CPR `CSI 1;11R` | partial | T07 T18 T21 |
| W03 | `CSI ?7l` 后 10 列写 12 字符 | VT100 DECAWM 关闭：后续字符覆盖末列 | `012345678B`，不换行；光标/CPR 同 W02（x=10、`1;11R`） | supported | T07 T18 |
| W04 | `CSI ?45h` 软换行后 BS×3；硬行首 BS | ctlseqs XTREVWRAP；xterm.js 源码注释明言"有意偏离 xterm"，只撤销软换行 | 软换行回到 (9,0)；硬行首停在 (0,2) | partial | T12 T18 T21 |

### 插入、删除、重复与 VT220/VT420 编辑

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| E01 | `CSI 2;5r CSI 3;1H CSI L`，`CSI 2M` | VT102 IL/DL 限于滚动区 | `1,2,_,3,4,6` → `1,2,4,_,_,6` | supported | T26 T07 T21 |
| E02 | `ABCDEF`，`CSI 2@`、`CSI 3P`、`CSI 2X` | VT102 ICH/DCH，VT220 ECH | `AB  CDEF` → `ABDEF` → `AB  F` | supported | T26 T08 |
| E03 | `CSI 4h`/`4l`，DECRQM 4；`CSI 20h` + LF | ECMA-48 IRM、LNM | `XYABC`、`4;2$y`；LNM 下 LF 回第 1 列，`20;1$y` | supported | T26 T07 |
| E04 | `A CSI 3b` | ECMA-48 REP | `AAAA`，光标 x=4 | supported | T12 |
| E05 | `CSI 1"q PP CSI 0"q xx`，`CSI ?2K`，再 `CSI 2K` | VT220 DECSCA/DECSEL 保留受保护字符，EL 不保留 | `PP` → 空行 | supported | T08 |
| E06 | `CSI 1;2H`，`CSI ' }`、`CSI ' ~` | VT420 DECIC/DECDC | `A BCD/E FGH` → 还原 | supported | T10 |
| E07 | DECFRA `CSI 88;1;1;2;2$x`、DECERA `CSI 1;3;2;4$z`、DECCRA `$v` | VT420 矩形填充/擦除/复制 | 屏幕不变 `ABCD/EFGH` | unsupported | T10 T11 T21 |

### 制表位

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| B01 | HT；`ESC H`；`CSI 3g`；`CSI 2I`；`CSI Z`；`CSI g` | VT100 HTS/TBC，ECMA-48 CHT/CBT | x = 8、3、39、12、4、12 | supported | T07 T21 |
| B02 | `CSI 3g CSI ?5W CR HT` | VT510 DECST8C 恢复每 8 列制表位 → x=8 | x=39（无制表位） | unsupported | T11 |

### 字符集

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| G01 | `ESC ( 0 lqqk ESC ( B xq` | VT100 DEC 特殊图形 | `┌──┐xq` | supported | T07 T21 |
| G02 | `ESC ) 0 a SO ax SI x` | G1 经 SO 调入、SI 回 G0 | `a▒│x` | supported | T07 T21 |
| G03 | `ESC ( K [\]{\|}~`，DECRQM ?42 | VT220 德语 NRCS；DECNRCM 可查询 | `ÄÖÜäöüß[`（未开 DECNRCM 也替换）；`?42;0$y` | partial | T08 T21 |
| G04 | `ESC * 0 ESC N qq`，`ESC + 0 ESC O qq` | VT220 SS2/SS3 只影响下一字符 → `─q─q` | `qqqq` | unsupported | T08 T21 |
| G05 | `ESC * 0 ESC n q SI q ESC ) 0 ESC ~ q` | LS2 → `─`；LS1R 只改 GR，7 位 `q` 不变 → `─qq` | `─q─`（LS1R 被当成 GL 锁定切换） | partial | T08 T21 |

### 行属性与对齐图样

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| L01 | `ESC # 6 ABCDEFG`，`ESC # 3 abcdefg`（10 列） | VT100 UG DECDWL/DECDHL：双宽行只容纳一半列，`FG` 应换行 | 两行仍单宽 `ABCDEFG`/`abcdefg`，cell width=1 | unsupported | T07 T21 |
| L02 | `CSI 2;3r ESC # 8`，DECRQSS r | VT510 DECALN："将边距设为页面极限并把光标移到原点" | 全屏 `E`、光标 (0,0)；边距仍 `2;3r`（期望 `1;4r`） | partial | T07 T21 |

### 备用屏幕与括号粘贴

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| A01 | `CSI 2;3H CSI ?1049h ALT`，DECRQM，`CSI ?1049l` | ctlseqs 1049 = DECSC + 清空备用屏 | 备用屏为空、`?1049;1$y`；退出恢复 `normal` 与 (2,1) | supported | T12 |
| A02 | `CSI ?47h KEEP CSI ?47l CSI ?47h` | ctlseqs：只有 1049 进入时清屏、只有 1047 退出时清屏，47 应保留 `KEEP` | 重入后备用屏为空（退出即丢弃）；主屏内容保留 | partial | T12 |
| A03 | `CSI ?2004h`，`paste("a\nb")`，`CSI ?2004l` | xterm 2004：`CSI 200~ … CSI 201~` | `CSI 200~a\rbCSI 201~`（LF 转 CR）、`?2004;1$y`；关闭后为 `c` | supported | T12 G12 |

### 鼠标与焦点

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| M01 | `CSI ?1000h`，第 5 列第 3 行按下/释放 | ctlseqs X11 鼠标：`CSI M Cb Cx Cy` | `onBinary`：`CSI M SP%#`、`CSI M #%#`；`onData` 为空 | supported | T17 |
| M02 | `CSI ?1002h CSI ?1006h`，移动/按下/拖动/释放 | 只在按住按钮时报告拖动 | 空闲移动无报告；`<0;2;2M`、`<32;4;2M`、`<0;4;2m` | supported | T17 |
| M03 | `CSI ?1003h CSI ?1006h`，移动、滚轮 | 无按钮移动 `<35;x;yM`；滚轮 64/65 | `<35;3;1M`；`<64;3;1M`/`<65;3;1M` | supported | T17 |
| M04 | `CSI ?1000h CSI ?1016h`，按下 | ctlseqs 1016："与 1006 相同的响应格式"，以像素代替字符格；未写明像素起点 | `<0;px;pyM`，像素为相对 `.xterm-screen` 的 0 基偏移，而格坐标模式为 1 基；xterm 的像素起点本轮未核对；`?1016;1$y` | partial | T17 |
| M05 | `CSI ?1000h CSI ?1015h CSI ?1005h`，按下 | urxvt `CSI 32;5;3M`；UTF-8 坐标 | 仍为默认编码 `CSI M SP%#`；DECRQM ?1015/?1005 → `4`（永久重置） | unsupported | T17 |
| M06 | `CSI ?1004h`，focus/blur | ctlseqs 1004：`CSI I`/`CSI O` | 开启时立即报告当前状态 `CSI O`；focus `CSI I`；blur `CSI O` | supported | T12 |

### 光标样式

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| K01 | `CSI 4 SP q`，`CSI 5 SP q`（聚焦后） | VT520 DECSCUSR | DOM class `xterm-cursor-underline`；`xterm-cursor-bar` + `xterm-cursor-blink` | supported | T11 T12 |
| K02 | `CSI 4 SP q`、`CSI 5 SP q`、`CSI 0 SP q` 后各发 `DCS $ q SP q ST` | VT520 DECRPSS 应报告 `4 SP q` | 原样：三次都是 `DCS 1$r2 SP q ST`（选项值）；适配器：`4 SP q`、`5 SP q`，`CSI 0 SP q` 后回到选项值 `2 SP q` | supported（适配器） | T11 |

### SGR 与颜色

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| R01 | SGR 1、2、22;3、23;4、24;7、27;8、28;9、29;53、55 | ECMA-48/xterm SGR | 粗体、暗淡、斜体、下划线、反显、隐藏、删除线、上划线逐项正确，22–29/55 清除 | supported | T07 T12 |
| R02 | SGR `4:1`…`4:5`、`4:0`、21、`58:2::255:0:0` | xterm.js 文档的下划线扩展 | DOM class `xterm-underline-1..5`；`4:0` 无；21 → 双下划线；58 → `rgb(255, 0, 0)` | supported | T12 |
| R03 | SGR 5 `A`，SGR 25;6 `B` | VT100 闪烁属性应可见地闪烁 | `isBlink` A=true、B=false；DOM 无闪烁 class，`animation-name: none` | partial | T07 T21 |
| R04 | SGR 31、91、`38;5;196`、`38:5:202`、`48;5;21` | xterm 256 色、ITU T.416 冒号形式 | p16:1、p16:9、p256:196、p256:202、背景 p256:21 | supported | T13 |
| R05 | `38;2;1;2;3`、`48;2;250;128;0`、`38:2::10:20:30`、`38:2:9:40:50:60`、`38:2:1:2:3` | ctlseqs 直接色；T.416 冒号形式含色彩空间 Pi（xterm 忽略 Pi） | rgb 010203、背景 fa8000、0a141e、28323c；无 Pi 的 `38:2:1:2:3` 被读成 Pi=1 → 020300 | supported | T16 |
| R06 | SGR 1;31，`DCS $ q m ST`；SGR `0;3;4:3;58:5:9;38;5;196;48;2;1;2;3`；SGR 0 | VT420 DECRPSS 报告当前属性 | 原样：恒为 `DCS 1$r0m ST`；适配器：`0;1;31m`、`0;3;4:3;38;5;196;48;2;1;2;3;58;5;9m`、`0m` | supported（适配器） | T10 T16 T21 |

### 设备标识、一致性等级与报告

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| D01 | `CSI c`，`CSI > c`，五种终端类型各测一次 | ctlseqs：VT220+ 的 DA1 为 `CSI ? 6x;… c`，含功能参数；VT220+ 的 DA2 Pp > 0 | 原样与 `xterm-256color`：DA1 `CSI ?1;2c`、DA2 `CSI >0;276;0c`（逐字节相同）；`vt100`：`?1;2c`，DA2 不回复；`vt220`：`?62;6;9;22c`、`>1;10;0c`；`vt420`：`?64;6;9;22c`、`>41;10;0c`；`vt520`：`?65;6;9;22c`、`>64;10;0c` | supported（适配器） | T07 T08 T10 T11 T20 |
| D02 | `DCS $ q " p ST`；`CSI 62;1"p` 后 DECRQSS 与 `CSI c`；`CSI 65;2"p`；`CSI 62"p ESC c` | VT520 DECSCL 切换级别并具备该级别行为（含软复位）；VT100 忽略 DECSCL | 原样与 `xterm-256color`：始终 `DCS 1$r61;1"p ST`，DA1 不变（原样结论与 `terminal-probes.spec.ts` 一致）；`vt520`：`65;1"p` → `62;1"p`（DA1 仍为 `?65;6;9;22c`）→ `65;1"p`（8 位请求只改等级）→ RIS 后 `65;1"p` | partial（只改报告：不软复位、不按等级开关功能） | T08 T10 T11 T20 T21 |
| D03 | `CSI = c`，`CSI > 0 q`，`DCS + q 544e ST` | DA3、XTVERSION `DCS >\|… ST`、XTGETTCAP | 原样：均无回复；`xterm-256color`：XTVERSION `DCS >\|new-windterm(0.0.1) ST`，DA3 不回复；`vt420`：DA3 `DCS !\|00000000 ST`，XTVERSION 不回复；XTGETTCAP 一律无回复 | partial（XTGETTCAP 缺） | T10 T12 T20 |
| D04 | `ESC SP G` 后 `CSI c`（原样、`xterm-256color`、`vt220`） | VT220 S8C1T：回复改用 8 位 CSI（0x9B） | 仍为 7 位：`ESC [ ?1;2c`（原样与 `xterm-256color`）、`ESC [ ?62;6;9;22c`（`vt220`） | unsupported（适配器按设计只发 7 位） | T08 T21 |
| D05 | `CSI 5n`、`CSI 6n`、`CSI ?6n`、`CSI ?15n`、`CSI ?26n` | VT220+ 还回答打印机、键盘状态 | `CSI 0n`、`CSI 2;3R`、`CSI ?2;3R`；?15/?26 无回复 | partial | T08 T10 T21 |
| D06 | DECRQM 4、20、?1、?7、?25、?2004、?2026、?1049；再设 ?1、?2026 | VT520 DECRQM → DECRPM | 2、2、2、1、1、2、2、2；设置后 ?1、?2026 → 1 | supported | T11 T12 |
| D07 | DECRQM ?5、?3、2；`CSI ?5h CSI ?3h` | VT100 DECSCNM 反显、DECCOLM 132 列 | `?5;0`、`?3;0`、`2;4`（KAM 永久重置）；设置后无效果，列数不变 | unsupported | T07 T21 |
| D08 | `CSI 18t`；开启 `windowOptions.setWinLines/getWinSizeChars` 后再测 `CSI 18t`、`CSI ?3h` | xterm XTWINOPS 尺寸报告、132 列 | 默认无回复；开启后 `CSI 8;6;20t`、列数 132、`?3;1$y` | partial | T07 T12 |

### 软复位与硬复位

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| X01 | 设置边距/DECOM/IRM/SGR/G0/隐藏光标/关闭换行后 `CSI ! p` | VT510 DECSTR 表：不清屏，DECOM 绝对、IRM 替换、光标可见、边距全屏、"Autowrap: No autowrap" | 屏幕保留、?6→2、4→2、?25→1、边距 `1;6r`、SGR/字符集复位；**?7→1（自动换行重新开启）**，xterm 本身的取值未核对 | partial | T08 T11 T21 |
| X02 | 文本 + 2004 + 1000 + 1049 + 边距后 `ESC c` | VT100 RIS | 主屏、全空、(0,0)、括号粘贴关、鼠标 none、边距 `1;6r` | supported | T07 T21 |

### OSC

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| O01 | `OSC 0;zero`、`OSC 1;icon`、`OSC 2;two`，`CSI 21t` | ctlseqs OSC 0/1/2；标题报告受 allowWindowOps 控制 | `onTitleChange` 收到 `zero`、`two`；OSC 1 图标名不对外暴露；`CSI 21t` 默认无回复 | supported | T12 |
| O02 | `OSC 4;1;?`、`OSC 10/11/12;?`、`OSC 4;1;#123456`、`OSC 104;1` | ctlseqs 动态颜色：`OSC Ps;rgb:rrrr/gggg/bbbb ST` | `rgb:cccc/0000/0000`、`ffff/ffff/ffff`、`0000/0000/0000`、`ffff/ffff/ffff`；设置后 `1212/3434/5656`；104 复位；回复以 `ESC \` 结束 | supported | T12 T13 |
| O03 | `OSC 8;id=x;https://example.com/a ST link OSC 8;; ST`；再写 `file:///tmp/x` 链接 | OSC 8 超链接规范 | 悬停时 `linkHandler.hover` 收到 URL，范围 x 1–4；`file://` 默认被丢弃（需 `allowNonHttpProtocols`） | supported | T12 |
| O04 | `OSC 52;c;aGVsbG8=`、`OSC 52;c;?`（原样、适配器默认、会话授权后） | ctlseqs OSC 52：设置选区；`?` 时回复选区数据 | 三种情况都无回复、无屏幕残留。原样：核心没有 OSC 52 处理器；适配器默认：不写剪贴板，"已拦截"与"已拒绝读取"提示各一次；授权后：剪贴板收到 `hello`，提示含字节数；读取始终拒绝 | partial（读取按 P0 安全策略拒绝） | T12 G29 |

### 图形

| ID | 序列 | 期望（依据） | 观察值 | 状态 | 影响 |
| --- | --- | --- | --- | --- | --- |
| P01 | `A`、`DCS q #0;2;0;0;0#0~~~~ ST`、`B`，`CSI c` | VT340/xterm SIXEL 绘图；DA1 含参数 4 | 行为 `AB`，光标 (2,0)，DCS 被吞掉；DA1 `?1;2c` 不含 4 | unsupported | T09 T12 |

### 适配钩子可行性（公开 API）

| ID | 方法 | 观察值 | 结论 | 影响 |
| --- | --- | --- | --- | --- |
| H01 | `parser.registerEscHandler({intermediates:'#', final:'6'})` | 钩子被调用，但 cell width 仍为 1、光标 x=2 | 能感知 DECDWL，**不能**改变列宽/绘制，需要渲染器与 buffer 行属性 | T07 T21 |
| H02 | `parser.registerCsiHandler({prefix:'>', final:'q'})` + `terminal.input(…, false)` | `CSI > 0 q` 得到 `DCS >\|new-windterm-probe ST` | 回复类缺口可在应用层补齐 | T12 T20 |
| H03 | `parser.registerOscHandler(52, …)` | 收到负载 `c;aGVsbG8=` | OSC 52 可由应用接管（仍需剪贴板安全策略） | T12 G29 |

## 结论

### 阻断 WindTerm 对齐的缺口

上游宣称除 Tektronix 4014 外覆盖 vttest（T21），并提供 VT100/VT220/VT340/VT420/VT520 模式（T07–T11）。在这一前提下，以下缺口会阻断对齐，必须在 P1 前定方案（第 3、4 项已部分由生产适配器处理，见各项说明）：

1. **行属性 DECDWL/DECDHL（L01）**：vttest 有专门的双尺寸字符测试项，VT100 手册也将其列为标准功能；xterm.js 没有行属性模型。
2. **左右边距 DECSLRM/DECLRMM（S04）与 VT420 矩形操作（E07）**：VT420/VT520 模式的核心能力，全部未实现。
3. **终端身份与一致性等级（D01–D03）**：原样 xterm.js 的 DA1/DA2 固定为 VT100 类，DECSCL 不生效，DA3/XTVERSION 无回复。生产适配器已按会话终端类型回复 DA1/DA2/DA3/XTVERSION 与 DECSCL 等级报告（仅浏览器验证）。仍缺：选择终端类型的界面入口、`TERM`/TTYPE 随类型变化、DECSCL 按等级切换功能、XTGETTCAP，以及与真实终端/WindTerm 的回复对照。
4. **DEC 细节语义**：DECSC 不保存 DECOM/换行（C03）、DECALN 不复位边距（L02）、SS2/SS3（G04）、S8C1T（D04，适配器按设计只发 7 位）、DECSCNM（D07）、闪烁不渲染（R03）、DECSTR 后自动换行状态（X01）。这些都对应 vttest 子项或 VT 手册明确条目。DECOM 下的 CPR（S03）已由适配器修正。
5. **SIXEL（P01）**：VT340（T09）的必要能力；官方 `@xterm/addon-image` 0.9.0 的隔离原型与限额评估见[终端内核技术调整建议](TERMINAL_CORE_ADR.zh-CN.md)，未接入生产，原生 WebView 未验证。

xterm/256 色/真彩/鼠标/括号粘贴/OSC 颜色与标题这一类（T12/T13/T16/T17 主体）原样基本可用，不是 P0 阻断项。

### 可用公开 parser 钩子（或字节流适配器）关闭的缺口

| 缺口 | 手段 | 状态 | 说明 |
| --- | --- | --- | --- |
| D01 DA1/DA2、D03 DA3/XTVERSION、D02 的 DECRQSS `"p` 回复 | `registerCsiHandler`/`registerDcsHandler` + `terminal.input(…, false)` | **已接入生产适配器**（浏览器验证） | 回复只列当前确实具备的功能，见[终端类型与身份回复](#终端类型与身份回复) |
| D03 XTGETTCAP、D05 DECDSR 打印机/键盘 | 同上 | 未做 | XTGETTCAP 需要与真实 terminfo 一致的能力表 |
| O04 OSC 52 | `registerOscHandler(52)`（H03） | **已接入**：写入需会话授权、读取始终拒绝 | 原生 WebView 的剪贴板权限未验证，见 [OSC 52 剪贴板](#osc-52-剪贴板) |
| K02 光标样式报告、R06 SGR 报告 | 钩子返回 `false` 透传给内置处理器，同时维护影子状态，再接管 DECRQSS | **已接入** | 影子状态覆盖 RIS/DECSTR/备用屏/DECSC；OSC 8 扩展位与带外 `terminal.reset()` 是已知漂移点 |
| S03 DECOM 下的 CPR | 接管 `CSI 6 n`/`CSI ? 6 n`，用影子 DECSTBM 与公开 `modes.originMode` 换算相对行 | **已接入** | 依赖影子边距状态 |
| W02 待换行时的 CPR 列号 | 接管 `CSI 6 n`，用公开 `cursorX` 钳制列号 | 未做 | 本轮任务范围外；DECOM 下的回复与 xterm.js 一样报告 cols+1 |
| G03 DECNRCM | 接管 `CSI ?42 h/l` 与 DECRQM，并在未开启时忽略 NRCS 指定 | 未做 | 只影响 7 位 NRCS |
| D07 DECSCNM | 接管 `CSI ?5 h/l` 并交换主题前景/背景 | 未做 | 渲染层近似，需验证选区与光标颜色 |
| L02 DECALN 边距、G04 SS2/SS3 | 字节流预处理（与 `Vt52Stream` 同类）：把 `ESC # 8` 改写为 `CSI r ESC # 8`，SS2/SS3 时只对下一个字符改用 G2/G3 | 未做 | 必须保持原始字节 ACK 语义，跨块与取消规则需单独测试 |
| D02 DECSCL 真正切换级别、D04 S8C1T | 钩子 + 输出层转换（7 位回复改写为 C1） | 未做；S8C1T 按 P0 决定不支持 | 级别切换还要求关闭/打开对应功能，钩子只能解决回复层 |

注意：钩子处理器在解析过程中同步运行，不能直接改写任意 cell；异步处理器会暂停解析并影响吞吐（见 [可行性报告](FEASIBILITY.zh-CN.md)）。在处理器里再 `terminal.write` 会排在当前数据块之后，不能用来实现需要按顺序修改屏幕的序列。

### 需要渲染器或内核改动

- **DECDWL/DECDHL/DECSWL（L01，H01）**：buffer 需要行属性，渲染器需要横向/纵向放大绘制，换行、光标钳制、选区与复制都要按半列数计算。
- **DECSLRM/DECLRMM（S04）**：打印、换行、滚动、IL/DL/ICH/DCH、DECOM 都要尊重左右边距，只能在内核实现。
- **矩形操作 DECFRA/DECERA/DECCRA/DECCARA 等（E07）**：需要直接操作 buffer；钩子内再写数据会乱序。
- **DECSC 保存 DECOM/换行（C03）、47 备用屏保留（A02）、硬换行反向回绕（W04）、LS1R/LS2R/LS3R 进 GR（G05）**：状态位于 InputHandler/BufferSet/CharsetService 内部，公开 API 无法修补。
- **闪烁（R03）**：DOM 渲染器没有文本闪烁样式，需要渲染器支持。
- **SIXEL（P01）**：优先评估官方 `@xterm/addon-image`（锁版本、DOM 渲染器兼容性、内存上限），不满足时再立渲染 ADR。

以上各项的方案比较（官方插件、上游、受控分支、Rust 内核、混合）与建议见[终端内核技术调整建议](TERMINAL_CORE_ADR.zh-CN.md)。
- **1005/1015 鼠标编码（M05）**：编码表在 CoreMouseService 内部；1006 已覆盖现代应用，优先级低，若上游 WindTerm 实测支持再决定。

## 验证

在 `apps/desktop` 执行：

```sh
npm run dev   # 127.0.0.1:1420，另开终端
npx playwright test --config playwright.config.ts tests/e2e/vt-matrix.spec.ts
npx playwright test --config playwright.config.ts tests/e2e/vt-adapters.spec.ts tests/e2e/vt-adapters-contract.spec.ts
npx playwright test --config playwright.config.ts   # 全量
npm run build
```

本轮结果（2026-10-12，macOS，系统 Chrome）：在本工作树另起 `vite --port 1441`，用一个未提交的本地配置（只把 `baseURL` 改为 1441）运行，其余配置与 `playwright.config.ts` 相同。

- `vt-matrix.spec.ts` + `vt-adapters.spec.ts` + `vt-adapters-contract.spec.ts`：**80 passed**（63 + 13 + 4）；`--repeat-each=4`：**320 passed**。
- 全量 Playwright：**235 passed**（含上述 80 项）。
- `npm run build`（`tsc --noEmit` + Vite 构建）通过；新 spec 与夹具另用 `tsc --strict --noUnusedLocals --noUnusedParameters` 单独检查通过（项目 tsconfig 只包含 `src`）。

上一轮（2026-10-11，原样 xterm.js，端口 1431）：`vt-matrix.spec.ts` 63 passed、`--repeat-each=4` 252 passed、全量 161 passed。

未运行：vttest、WindTerm 2.7.0 实机对照、真实 xterm 对照、Tauri/WKWebView/WebView2 中的适配器与剪贴板、真实 PTY/SSH/Telnet 主机程序、Windows/Linux。本表通过不代表 T07–T13、T16–T18、T20、T21、T26 中任何一项验收通过。
