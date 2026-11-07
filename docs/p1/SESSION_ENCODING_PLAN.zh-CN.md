# P1 会话字符编码：设计与第一部分实施记录

日期：2026-11-07。分支 `p1/session-encoding`，基于 `p1/integration` 的 `c24f732`。第 1–13 节是设计，第 14 节是第一部分的实施记录与证据，第 15 节是需要用户决定的问题。本文不改功能矩阵状态，不新增、删除或改写功能 ID。

## 1. 范围、功能 ID 与上游依据

- **T28 Big5 会话字符编码**、**T29 EUC-JP 会话字符编码**：冻结验收要点为“输入输出分别验证已知字节与样本、跨块多字节、不完整/非法序列、编码切换、复制搜索列宽；文件传输字节不经终端解码 / 原始文件传输不损坏”。
- **T33 其余会话字符集、十六进制显示与自动检测**：要求先盘点上游实际提供的字符集、“System”“Hexadecimal”与自动检测，按 T28/T29 方法验证，盘点后按字符集分组拆分为新 ID。本次只做其中可复用同一机制的东亚多字节编码，**不代表 T33 盘点完成**，也不拆分新 ID（新 ID 需用户批准）。
- 上游证据只有入口与静态资源：[基线证据](../p0/BASELINE_EVIDENCE.zh-CN.md#e-ui-settings) 记录会话设置中看到 Big5、EUC-JP 入口；[静态复核](../p0/UPSTREAM_STATIC_REVIEW.zh-CN.md) 记录 `session.charset=UTF-8` 默认值、分组字符集表（Chinese Traditional：Big5、Big5-HKSCS；Japanese：EUC-JP、ISO-2022-JP、Shift-JIS；Chinese Simplified：GB2312、GB18030、GBK；Korean；Cyrillic；Western；Unicode UTF-16/32 等）、“System”“Hexadecimal”和 uchardet 类 `nsBig5Prober`。**上游行为一项也没有实测**：例如上游在运行中切换时是否重绘已有内容、无法编码的输入怎么处理、Hexadecimal 显示什么，都未知。本文的语义是本项目的选择，不是对上游行为的复述；`.reference/` 未用于本切片。

## 2. 现状（`c24f732`）

- Rust 端 `PtyEvent::data` 是原始字节，每块最多 4096 字节，前端逐块 ACK；Rust 不解码、不维护屏幕。Telnet 在 Rust 侧只剥离 IAC 协商并在输入方向把 0xFF 转义为 IAC IAC；Raw TCP 原样收发；SSH `pty-req` 的终端模式列表为空。
- 前端唯一输出点是 `session-lifecycle.ts` 的 `terminalChannel`：`Utf8Boundary` 保留块尾未完的 UTF-8 序列（绕开 xterm.js 6.0.0 的 0x80 续字节缺陷），再把字节交给 `xterm.write`，由 xterm.js 解码。
- 唯一输入点是 `terminal.onData` → `TextEncoder` → `queueInput` → `InputQueue` → `*_write`；`onBinary`（X10 鼠标等）按字节原样发送；启动后执行命令按 UTF-8 编码。
- 冷归档在每块写入回调后从 xterm 缓冲区读取已离开屏幕的逻辑行，保存的是 Unicode 文本与 SGR，不是原始字节。

## 3. 设计原则

1. **Rust 不变**：字节流、ACK、预算、背压、owner/generation 全部不动；不新增 Tauri 命令。编码只发生在前端两个点：输出进入 xterm 之前、输入进入队列之前。xterm.js 仍是唯一屏幕状态，不保存第二份屏幕或原始字节副本。
2. **默认 UTF-8 路径逐字节不变**：UTF-8 会话继续走 `Utf8Boundary` → `xterm.write(Uint8Array)`，输入继续是 `TextEncoder`（孤立代理项仍变成 U+FFFD）。编码选项不进入任何 IPC 参数。
3. **只支持 ASCII 兼容、无状态的编码**：ASCII 字节在两个方向上始终表示 ASCII，因此 ESC、CR、LF 与所有 VT 控制序列在解码前后不变。
4. **输入宁可不发也不发错**：一个字符只在“本会话的解码器会把这串字节解回同一个字符”时才发送；否则整段输入不发送并提示。

## 4. 每会话编码选项与配置入口

- 每个本地、SSH、Telnet、Raw TCP 会话有一个编码，默认 UTF-8。演示会话不适用。
- 选择在打开会话时快照进会话对象，只存内存，不持久化，不发送给 Rust。
- 配置入口与现有设计一致，都放在“打开这个会话”的表单里，紧邻同类的每连接终端选项：
  - 本地：「本地终端启动选项」对话框，位于“启动后执行命令”说明之后（两者都决定送进 Shell 的字节）。值是 `LaunchOptions.encoding`，与 `command` 一样只在前端，`nativeLaunchArguments` 的显式白名单不含它。重新打开继承启动快照中的编码。工具栏的一键「本地终端」仍是 UTF-8。
  - SSH：「连接 SSH 终端」对话框，仅终端用途显示，放在 agent 转发选项之后；验证与 SFTP 用途不显示（它们不经终端解码）。与其他字段一样在检查指纹时读取，交接给标签时带上。
  - Telnet / Raw TCP：连接对话框的说明文字之后。
  - 运行中切换：命令面板「切换当前会话字符编码 · 之后的输出与输入」，打开一个小对话框（见第 8 节）。没有在标签栏加按钮，避免扩大工作台改动面。
- 状态栏尺寸栏在非 UTF-8 时追加“ · Big5”等标签；UTF-8 会话的状态文字与以前完全相同。
- 每处选择附同一段说明：只决定本应用如何解码与编码，不修改远端或 Shell 的 locale；无法表示的输入整段不发送；默认 UTF-8 与原行为一致；只存于内存。本地对话框另提示 locale 须在下方 Locale 中另设（如 `zh_TW.Big5`）。

## 5. 支持的编码清单与依据

全部使用 WebView 自带的 WHATWG Encoding Standard `TextDecoder`（Chromium/WebView2、WebKit 均实现该标准的全部编码；本次只在 Chrome 中实测）。下拉框对构造失败的编码显示“此 WebView 不支持”并禁用。

| 选项 | WHATWG 名称 | 输出解码 | 输入编码（与 WHATWG 编码器的差异） |
| --- | --- | --- | --- |
| UTF-8（默认） | — | 原路径（`Utf8Boundary` + xterm.js） | 原路径（`TextEncoder`） |
| Big5 · 繁体中文 | `big5` | 含 HKSCS 扩展（WHATWG 的 Big5 即 Big5-HKSCS 解码） | 不发 HKSCS 首字节 0x81–0xA0 的序列（与标准编码器一致）；6 个码位取最后一个指针（同标准） |
| EUC-JP · 日文 | `euc-jp` | JIS X 0208、半角片假名（0x8E）、JIS X 0212（0x8F，仅解码） | 不产生 0x8F；**不采用** U+00A5→0x5C、U+203E→0x7E、U+2212→U+FF0D 三个兼容映射 |
| Shift_JIS · 日文（Windows-31J） | `shift_jis` | WHATWG（实为 Windows-31J，含 NEC/IBM 扩展、用户区→PUA） | 排除指针 8272–10715（同标准，另含用户区）；**不采用** ¥、‾、U+2212 兼容映射 |
| GBK · 简体中文 | `gbk` | 与 GB18030 解码器相同（WHATWG 规定） | 无四字节；U+20AC 发 0x80（同标准）；U+E5E5 拒绝（同标准） |
| GB18030 · 简体中文 | `gb18030` | 双字节与四字节 | 双字节优先，BMP 其余用四字节，平面 1–16 按算法生成并逐个解码校验；U+E5E5、U+FFFD 拒绝 |
| EUC-KR · 韩文（Windows-949） | `euc-kr` | WHATWG（实为 UHC/CP949 超集） | 同解码表；KS X 1001 以外的 UHC 音节会以扩展字节发出 |

明确排除（本次不做，理由）：

- **ISO-2022-JP**（及其他 ISO-2022 系）：有状态，以 `ESC $ B` / `ESC ( B` 切换字符集；WHATWG 解码器把其他 ESC 序列当错误，会破坏全部 VT 控制序列。若以后支持，必须由一个同时理解 VT 转义与 ISO-2022 指定序列的专用解析器实现，不能直接用 `TextDecoder`。
- **UTF-16/UTF-32**：不 ASCII 兼容，控制序列本身会被编码成多字节。终端场景几乎不用，留待盘点上游后再定。
- **单字节编码**（Windows-125x、ISO-8859-x、KOI8、Mac 等）：技术上可用同一机制（每个编码只有 128 个高位字节），但 ISO-8859-x 把 0x80–0x9F 解码为 C1 控制字符，xterm.js 会把 U+009B 当 CSI 执行，而 Windows-125x 把同一字节解成可见字符。这涉及 8 位 C1 控制是否应生效（与 T31/DECSCL 的 8 位控制设置相关），见第 15 节问题 Q3，本次不交付。
- **System**：需要按操作系统当前代码页/locale 选择，Windows ANSI 代码页与 WebView 进程环境的关系未核实，留待后续。
- **Hexadecimal 与自动检测**：见第 11、12 节，只写设计。

各编码的“厂商变体”差异是固有风险：远端 iconv 的 Big5 可能是 CP950 或 Big5-2003，Shift_JIS 可能不是 Windows-31J，EUC-JP 可能是 eucJP-ms，EUC-KR 服务器可能不认 UHC 扩展。WHATWG 名称在下拉框中按实际行为注明。

## 6. 输出解码

- UTF-8：不变。
- 其他编码：每会话一个 `TextDecoder(编码, { fatal: false })`，每块调用 `decode(chunk, { stream: true })`，得到的字符串交给 `xterm.write`。流式解码保证结果与切块无关：块尾的首字节由下一块补全；一块只含一个首字节时解码为空串，xterm 仍回调，ACK 照常逐块、按序发出。
- 非法序列：按 WHATWG 替换模式输出 U+FFFD。规范规定：首字节后跟非尾字节时，若该字节是 ASCII 则“放回”重新处理。因此首字节后的 ESC、CR、LF、数字等不会被吞掉，控制序列照常执行；例如 Big5 `A4 1B 5B 33 31 6D` 显示为 � 后接红色文字。GB18030 不完整四字节前缀 `81 30` 后跟 CR，得到 � + “0” + CR（规范行为）。0x80、0xFF 等永不合法的字节各成一个 �。
- 输出结束（本地退出、SSH/Telnet 断开）时调用无参 `decode()`，未完的字符显示为一个 �，与 UTF-8 的 `Utf8Boundary.flush()` 一致。
- 与 VT 的交互：先解码、后解析。所列编码的尾字节都 ≥ 0x30（GB18030 第 2/4 字节为 0x30–0x39，其余 ≥ 0x40），永远不是 C0 控制字符；Big5/Shift_JIS/GBK 的尾字节可以是 `\`（0x5C）、`[`、`@` 等 ASCII 字母符号，但它们在解码后成为汉字，不会被 VT 解析器看到。OSC 标题、DCS 等字符串里的多字节文字解码后以 Unicode 进入 xterm（标题为 Unicode）。8 位 C1 字节在这些多字节编码中是首字节或非法字节，不会作为 C1 控制执行（Shift_JIS 0x80 解为 U+0080，xterm 当作无动作的 C1）。
- 引擎差异：GB18030-2022 调整了少数码位，WHATWG 于 2024 年同步；不同 WebView 版本的解码结果可能不同。本次只在 Chrome 验证。

## 7. 输入编码

### 7.1 方案比较与选择

| 方案 | 体积/依赖 | 正确性 | 维护 |
| --- | --- | --- | --- |
| Rust `encoding_rs` + 新命令或扩展 `*_write` 参数 | 需新增直接依赖与 Tauri 命令（三处登记）；每次按键多一次 IPC 或改三种传输的写入协议 | 标准实现，但输入与前端输出解码分属两套表，引擎差异处可能不对称 | 改 Rust、ACL 与 stub；浏览器测试无法覆盖真实编码路径 |
| JS 库（`iconv-lite` 需 Buffer 垫片；`text-encoding` 已停止维护；`encoding-japanese` 只含日文） | 数百 KB 表数据进入前端包 | 各库表与 WHATWG/WebView 解码器不完全一致 | 新增精确锁定依赖与审计负担 |
| **由 WebView 自身解码器反推（采用）** | 无新依赖；前端包增加约 8 KB；表在首次使用该编码时生成，Chrome 实测 2–12 ms | 发送的每串字节都由同一个解码器验证能解回原字符；双射选择规则照 WHATWG 编码器 | 规则写在一个模块里，约 250 行 |

采用第三种：**不新增任何依赖**，也不改 Rust。

### 7.2 规则

1. ASCII（U+0000–U+007F）按原字节发送。
2. 对每个编码，按 WHATWG 指针顺序枚举其合法字节序列族（例如 Big5 首字节 0xA1–0xFE × 尾字节 0x40–0x7E、0xA1–0xFE），每串后接 LF 一次性解码；LF 不是任何尾字节，因此非法序列不会吞掉分隔符。解码为单个非 ASCII 字符（非 U+FFFD、非代理项、非显式拒绝码位）的，记为“字符 → 字节”。同一字符多次出现时取第一个（Big5 的 6 个码位取最后一个），与 WHATWG 编码器一致。
3. 规范编码器中会让远端读到**不同字符**的兼容映射不采用（EUC-JP/Shift_JIS 的 ¥→`\`、‾→`~`、U+2212→U+FF0D），这些字符视为无法编码。理由：Shell 会把 0x5C 当作反斜杠，静默改变命令含义。
4. GB18030 平面 1–16 用规范算法计算四字节，再用解码器解回比对，一致才发送。
5. 任何一个字符无法编码时，**整段输入不发送**：一次按键、一次 IME 提交、一次粘贴（含括号粘贴标记）是一个整体，不会只发前半段。提示框只给数量和编码名，不回显输入（输入可能是密码）。UTF-8 不受此规则影响，行为不变。
6. xterm 自动回复（DA、CPR、DECRQSS 等）全为 ASCII，各编码下不变；`onBinary` 的原始字节不经编码。
7. 启动后执行命令：在启动选项表单中先按原规则校验（换行、控制字符、孤立代理项、双向控制、纯空白），再检查能否用所选编码表示；1000 字节上限按**会话编码后的字节数**计算（它对应 Shell 收到的行长度；UTF-8 会话与以前完全相同）。不满足时表单报错，不打开会话。会话打开后以会话编码发送“命令 + CR”。

### 7.3 粘贴与 IME

- 粘贴先经现有控制字符过滤，再整体编码；括号粘贴标记是 ASCII，不受影响；LF 仍由 xterm 转为 CR。
- IME 提交的字符串作为一次输入整体编码；组字过程中的预编辑文字不发送（与现状相同）。无法编码时提示并丢弃本次提交。原生输入法未实测。

## 8. 运行中切换编码

- 入口：命令面板 → 「切换当前会话字符编码」。只对运行中的本地、SSH、Telnet、Raw TCP 会话可用；演示、已结束或正在关闭的会话提示不可用。
- 输出：先结束旧解码器（若停在一个字符中间，该字符写出一个 �），再为之后到达的字节启用新解码器。切换发生在 JS 事件之间，已交给 xterm 的块按旧编码解析；**屏幕与历史中已显示的内容不重新解码**（不保存原始字节，xterm 仍是唯一状态）。ACK 序列不受影响。
- 输入：之后产生的输入用新编码；已在 `InputQueue` 中排队的字节不再改变。
- 不修改远端 locale，不发送任何字节。
- 本地会话重新打开时使用**启动快照中的编码**，不继承运行中切换，与环境变量、启动命令的“重开继承最初配置”一致；需要改时用「修改启动选项」。这是第 15 节 Q2 的推荐项，待确认。

## 9. 与冷归档、复制、搜索、列宽的关系

- 冷归档：读取的是 xterm 缓冲区的 Unicode 行，非 UTF-8 会话与 UTF-8 会话的归档内容格式相同；切换编码不改写归档。
- 复制：xterm 选区与 `copy` 事件给出 Unicode 文本，剪贴板始终是 Unicode。
- 搜索：产品目前没有终端搜索界面；缓冲区文本是 Unicode，未来的搜索按 Unicode 匹配即可，不需要感知会话编码。
- 列宽：由 xterm.js Unicode 11 宽度决定，与编码无关：汉字、全角空格 2 列，半角片假名 1 列。**东亚“宽度不明确”字符**（Big5/GBK 中的制表符 `─`、希腊/西里尔字母、部分符号）在 xterm.js 中为 1 列，而部分旧 CJK 终端或远端程序按 2 列计算，可能导致对齐错位。是否提供“模糊宽度按双宽”选项见 Q4，本次不实现。

## 10. 传输适用性

- 本地 PTY、SSH、Telnet、Raw TCP 共用同一字节流与解码点，全部适用。
- Telnet：所列编码的字节都不含 0xFF，输入方向的 IAC 转义不会被触发；未协商 BINARY 时 8 位数据的处理取决于服务器，未与真实 telnetd 验证。
- SSH：`pty-req` 未发送 IUTF8 等模式，远端行规程的退格处理取决于服务器默认与远端 locale；未验证。
- 本地：选择编码不自动修改 `LANG`/`LC_*`；用户需在 Locale 中另设，且系统须安装该 locale（例如 Linux 往往需要 `locale-gen`）。Windows 只传递变量，不切换控制台代码页。
- 文件传输：SFTP 浏览/预览/读写和 SCP 走各自的 IPC 与字节数组，不经过终端 Channel，也不读取会话编码，因此“文件传输字节不经终端解码”在结构上成立；本次没有新增文件传输测试。ZMODEM/XMODEM 等带内传输尚未接入终端；将来接入时必须在解码点之前截取原始字节，并在传输期间停止解码。

## 11. 十六进制显示（设计，未实现）

上游字符集表中有“Hexadecimal”，与模式菜单的 Hex 编辑（G35）关系未确认。候选语义：

- A：把会话的“编码”设为 Hexadecimal 时，输出不进 VT 解析，每个字节显示为两位十六进制加空格，按固定列数换行；输入仍按 UTF-8 或上一个文本编码发送。用途是排查远端发送的原始字节。
- B：保持终端正常解析，同时在旁路面板显示最近 N KiB 原始字节的十六进制视图（不改变屏幕）。

两者都需要在解码点之前保留有界原始字节，且 A 会使屏幕失去终端语义。建议在上游实机盘点 Hexadecimal 的实际行为后再定（Q5），本次不实现。

## 12. 自动检测（设计，未实现）

- 只做可解释、可关闭的启发式，默认关闭；不自动切换，只提示。
- 候选规则：会话开始后的前 64 KiB 输出中，若出现非法 UTF-8 序列（排除被切块截断的尾部），则以各候选解码器统计 U+FFFD 数与常用字覆盖率，给出“可能是 Big5 / EUC-JP / Shift_JIS / GBK”的提示和一键切换；用户确认前不改变解码。
- 不承诺准确率：短文本、纯 ASCII、混合编码时无法判断；uchardet 类统计模型需要新增依赖或数据，需另行评估。见 Q6。

## 13. 不承诺什么

- 不修改远端或本地 Shell 的 locale，不保证远端程序按所选编码输出或读取输入。
- 不保证与 WindTerm 2.7.0 行为一致（上游未实测）；不称“已对齐”。
- 不对已显示内容重新解码；不保存原始字节。
- 不保证各 WebView 的解码表一致；只在 Chrome 验证。
- 不处理东亚模糊宽度、组合字符在旧编码中的特殊宽度、厂商变体表差异。
- 不交付 ISO-2022、UTF-16/32、单字节编码、System、Hexadecimal、自动检测和持久化设置。
- 浏览器 IPC stub 测试不等于原生 WebView、真实 PTY、真实 SSH/Telnet 服务器或原生 IME 通过。

## 14. 分步实施与第一部分实施记录

### 14.1 分步

1. **第一部分（本次）**：编码模块、三类入口与运行中切换、UTF-8 以外 6 种东亚多字节编码、浏览器 stub 测试。
2. 单字节编码与 8 位 C1 处理（取决于 Q3），以及“System”。
3. 上游实机盘点（字符集清单、Hexadecimal、自动检测、切换语义），据此拆分 T33 新 ID（需用户批准）。
4. Hexadecimal 与自动检测（取决于 Q5、Q6）。
5. 原生 WebView（WKWebView、WebView2、WebKitGTK）解码表抽样核对；真实 Big5/EUC-JP locale 的本地 Shell、OpenSSH 与 telnetd 往返验收。

### 14.2 第一部分已实现

- `src/text-encoding.ts`：编码清单、`encodeText`（由解码器反推的编码表，按需生成并缓存）。
- `src/session-encoding.ts`：`SessionCodec`，每会话一个，提供 `decode`/`end`/`encode`/`switchTo`；UTF-8 时内部就是原 `Utf8Boundary` 与 `TextEncoder`。
- `src/session-encoding-ui.ts`：编码下拉框与说明、命令面板的切换对话框；全部用 DOM API 与固定清单构建，不把会话名、主机名或终端文本拼进 HTML。
- `session-lifecycle.ts`：`Session.codec`；`terminalChannel` 的解码点与 `endOutput`、`onData` 的编码点、启动命令的编码点；新增 `setEncoding`。其余逻辑未动。
- `local-launch.ts`（`LaunchOptions.encoding`、表单字段与启动命令可编码校验）、`ssh-verification.ts`、`net-terminal.ts`（表单字段与请求字段）、`startup-command.ts`（`startupCommandLine`；`validateStartupCommand` 增加可选编码参数，默认 UTF-8）、`main.ts`（状态栏后缀、命令面板一项、切换对话框实例、关于对话框一句说明）。
- 未改 Rust、Tauri 命令、ACL、`pty_open`/`ssh_open`/`net_open` 参数；未新增依赖。

### 14.3 验证（Chrome + Vite 开发服务器 + IPC stub）

- `npm run build`（`tsc --noEmit` + Vite）通过；生产包 JS 482.99 → 491.07 KB（gzip 135.86 → 139.12 KB）。
- 新增 3 个 spec 共 24 项：`session-encoding-codec.spec.ts` 5 项、`session-encoding-output.spec.ts` 8 项、`session-encoding-input.spec.ts` 11 项，辅助 `support/encoding-harness.ts`。`--repeat-each 5` 共 120/120 通过。
- 本机全量浏览器 E2E：`c24f732` 实测基线 537/537；改动后 **561/561**（537 + 24），既有测试未修改。
- 独立审查（只读 code-reviewer）：0 个 CRITICAL/HIGH；1 个 MEDIUM 已修正：非 UTF-8 会话的启动命令曾先按 UTF-8 字节数检查 1000 字节上限（例如 334 个汉字在 Big5 下只有 668 字节却被拒绝），现改为只按会话编码后的字节数检查，并新增 1 项测试（501 个汉字按 Big5 为 1,002 字节被拒，334 个汉字以 Big5 发出）。UTF-8 的校验顺序与提示文字不变，既有 43 项启动命令测试通过。
- 覆盖内容：
  - 编码表：12 组已知字节样本（Big5 含 0x5C 尾字节的“許功”，EUC-JP 含半角片假名，Shift_JIS 含 0x5C 尾字节的“ソ表”，GBK 的 0x80 €，GB18030 的 U+0080 与 😀 四字节，EUC-KR，控制字符）编码结果与预期一致且解回原文；平面 0–2 每个可编码字符都解回自身，6 个编码 0 处不一致；Chrome 中各表生成 1.8–12 ms，Big5 14,653、EUC-JP 7,389、Shift_JIS 7,390、GBK 23,939、EUC-KR 17,048、GB18030 BMP 63,340 个非 ASCII 字符，平面 1–2 共 131,072 个四字节字符全部往返；编码结果从不以 Big5 HKSCS 首字节或 EUC-JP 0x8F 开头；¥、‾、U+2212、JIS X 0212、😀（Big5/GBK）、半角片假名（Big5/EUC-KR）、孤立代理项、U+FFFD、U+E5E5 均被拒绝；UTF-8 与 `TextEncoder` 完全相同。
  - 输出：本地 Big5、本地 EUC-JP、SSH Big5、Telnet EUC-JP 四组样本（SGR、OSC 标题、宽字符、0x5C 尾字节、半角片假名、JIS X 0212）按整块、每个单切点、逐字节和 8 组固定种子随机切分送入，屏幕、单元属性、光标、模式、标题与回复都与整块一致，ACK 逐块、按序、各一次；只含首字节的块也 ACK；非法与不完整序列显示 �，后续 ESC 序列、CR、LF、数字照常生效；本地退出、SSH 与 Telnet 断开时未完字符显示 �。
  - 列宽、复制与缓冲区：“中文ab　─|” 的单元宽度为 2,0,2,0,1,1,2,0,1,1，光标在第 10 列；`copy` 事件与选区都给出同一 Unicode 文本；EUC-JP 半角片假名各占 1 列。
  - 冷归档：本地 Big5 会话以 4096 字节块（任意切开多字节字符与转义序列）送入 6,000 行，超出 5,000 行热窗口后，归档与预期 Unicode 文本逐行一致，无缺口、无 �。
  - 输入：Big5 下按键、CDP 插入文本、CDP 组字提交与括号粘贴分别发出预期字节（粘贴标记保持 ASCII，LF 转为 CR）；含无法编码字符的粘贴、插入整段不发送，提示只含数量与编码名，之后的可编码输入照常发送；EUC-JP 拒绝 ¥、‾、丂、U+2212，发送“日本ｱ”；DA/CPR 回复为原 ASCII；SSH EUC-JP 与 Telnet Shift_JIS 输入经各自的 `*_write` 发出；启动命令以 Big5 发出“echo 中文 + CR”，含 😀 的命令在表单报错且不调用 `pty_open`。
  - 切换：Big5 → EUC-JP 时未完的 Big5 首字节显示为 �，已显示的文字不变，之后的输出和输入使用 EUC-JP，ACK 连续；UTF-8 会话可切到 Big5；本地重开使用启动快照的编码（UTF-8 启动的仍为 UTF-8，Big5 启动的切换后重开仍为 Big5）；演示与已结束会话拒绝切换。
  - 默认不变：三种传输默认会话状态栏无编码后缀，UTF-8 跨块仍正确；`pty_open`、`ssh_open`、`net_open` 的参数名在默认与 Big5 会话中相同，参数值不含编码。
- 反向验证：把非 UTF-8 解码临时改为非流式 `decode(chunk)` 后，6 项（codec 1、跨块 3、非法序列 1、冷归档 1）失败，已还原。
- 观察到的既有行为（与编码无关）：CDP `Input.imeSetComposition` 在此前用 `Input.insertText` 插入过文字后开始组字时，xterm.js 会把文本框中残留的上一个字符再次发送；UTF-8 会话同样发生（发出 `E6 96 87` “文”）。这是 Chromium 模拟输入下的观察，未在原生输入法上验证，本次未修改。

### 14.4 未验证

- WKWebView、WebView2、WebKitGTK 的 `TextDecoder` 是否支持全部所列编码及其解码表是否与 Chrome 一致；Tauri 真实 IPC。
- 真实远端程序：Big5/EUC-JP locale 下的本地 Shell、OpenSSH 服务器、telnetd、Raw TCP 设备；远端行编辑（退格删除多字节字符）、IUTF8、Telnet BINARY。
- 原生输入法组字与候选、原生粘贴、读屏。
- Windows 控制台代码页与本地 Shell 的交互。
- Rust 未改，未运行 Rust 门禁与 `tools/wincheck/wincheck.sh`；未运行 CI。
- 与 WindTerm 2.7.0 的行为对照（上游未实测）。

## 15. 需要用户决定的问题

1. **Q1 支持清单**：本次除 Big5、EUC-JP 外，同一机制还提供 Shift_JIS、GBK、GB18030、EUC-KR。A：保留（推荐，机制与测试相同，各有已知字节样本与往返证据）；B：只保留 Big5、EUC-JP，其余待上游盘点后再开放。
2. **Q2 本地重开的编码**：A：用启动快照中的编码，运行中切换不继承（推荐，已实现，与环境变量、启动命令的重开语义一致，需要时用「修改启动选项」）；B：继承最后一次运行中切换。
3. **Q3 单字节编码与 8 位 C1**：A：照 WHATWG 解码结果，ISO-8859-x 的 0x80–0x9F 成为 C1 控制并由 xterm 执行，Windows-125x 为可见字符（推荐，与 UTF-8 会话已接受 U+0080–U+009F 的现状一致）；B：解码后把 C1 一律替换为 �，不执行 8 位控制；C：暂不提供单字节编码。
4. **Q4 东亚模糊宽度**：A：维持 xterm.js Unicode 11 单宽（推荐本阶段，现状）；B：增加每会话“模糊宽度按双宽”，需要自定义 xterm 宽度提供者，触及终端内核 ADR 门禁，建议在 P1 第 6 片组合验收时与复杂字符一起评估。
5. **Q5 Hexadecimal**：A：作为一种“编码”，输出显示为十六进制文本；B：保持终端解析，另加旁路十六进制视图；C：先实机盘点上游 Hexadecimal 的行为再定（推荐）。
6. **Q6 自动检测**：A：不做；B：只在出现非法 UTF-8 时提示可能的候选编码，默认关闭、从不自动切换（推荐）；C：引入 uchardet 类统计检测（需评估新增依赖）。
7. **Q7 无法编码的输入**：A：整段不发送并提示数量（推荐，已实现，不会静默发错字节）；B：替换为“?”后发送并提示；C：删除该字符、其余照发。
8. **Q8 EUC-JP / Shift_JIS 的 ¥ 与 ‾**：A：拒绝（推荐，已实现：WHATWG 映射到 0x5C/0x7E，Shell 会读成 `\` 与 `~`）；B：按 WHATWG 发送 0x5C/0x7E。
9. **Q9 Big5-HKSCS 输入**：A：不提供（推荐暂不，WHATWG 编码器不产生 HKSCS 首字节，远端多为 CP950）；B：增加“Big5-HKSCS”选项，允许发送首字节 0x87–0xA0 的序列。

**用户决定（2026-11-07）**：第 15 节 Q1–Q9 全部采用推荐项。详见 [2026-11-07 用户决定](RESULTS.zh-CN.md#2026-11-07-用户决定15-项全部采用推荐项)。
