# 文本输入路径浏览器探针（输入法、宽字符、输出分块、粘贴、按键）

日期：2026-10-12。范围：HANDOFF 列为 P0 优先级的“输入法、中文组合态、emoji、宽字符和粘贴路径”。

## 先说边界

- **CDP 模拟的输入法不等于 macOS 原生输入法或 VoiceOver 验证。** 组合态用 Chrome DevTools Protocol 的 `Input.imeSetComposition` / `Input.insertText` 驱动，是 Chromium 对输入法事件的模拟；没有经过 macOS 输入法框架、候选窗、按住选字母（press-and-hold）、听写或 VoiceOver，也没有在 WKWebView、WebView2、WebKitGTK 中运行。
- 按键由 Playwright/CDP 注入到 macOS 上的系统 Chrome：不经过系统键盘布局、macOS 全局快捷键（例如 Ctrl+Space 切换输入法）或原生 WebView 的加速键处理。
- `pty`、`ssh` 模式是真实应用页面加浏览器内 IPC stub（见 `tests/e2e/input-harness.ts`）：stub 记录交给 `*_write` 的字节，并立即确认输出；不启动 PTY、shell、SSH 服务器，也不经过 Rust。浏览器测试通过不代表 Rust/原生链路通过。
- 单元宽度是 xterm.js 6.0.0 + Unicode 11 插件在本页面上的结果，没有与 shell 的 `wcwidth`、macOS 字体渲染或上游 WindTerm 对照。
- 本文不表示输入法、粘贴或键盘已经验收，也不表示与 WindTerm 对齐。

## 发现并修复的缺陷

每项都有回归测试；把对应修复临时撤掉后重跑，下表“回归测试”列的测试全部失败（2026-10-12 在本工作树实测，撤销后已还原）。

| # | 缺陷 | 影响 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | xterm.js 6.0.0 的 UTF-8 解码缺陷：一次 `write()` 结尾留下的不完整序列若以 `0x80` 续字节结束，下一次 `write()` 时整个字符被丢弃（上游 [#6003](https://github.com/xtermjs/xterm.js/issues/6003)，[#6004](https://github.com/xtermjs/xterm.js/pull/6004) 已修复，但截至 2026-10-12 只进入 6.1.0 beta，稳定版仍是 6.0.0）。我们的后端按 4096 字节原样分块，所以会在真实输出里触发 | `、。「」『』【】`（U+3000–U+303F）、`— “ ” … ‰ ※`、ZWJ（U+2000–U+203F）、U+4000/5000/…/9000 起各 64 个汉字、U+E000–U+E03F 私用区图标、U+1F000 起的麻将牌等，恰好在块边界被切在第二（或第三）字节后时**静默消失**；宽字符消失还会让本行后续内容左移两列 | 新增 `src/utf8-boundary.ts`：每个会话的输出通道把块尾未完整的 UTF-8 序列（最多 3 字节）暂留，拼到下一块前面再交给 `xterm.write`。不解码、不校验，非法字节原样按序传给 xterm.js；仍由 xterm.js 负责解码。会话退出（或 SSH/网络终端致命错误）时仍未完成的尾部显示为一个 U+FFFD，而不是悄悄消失 | `output-utf8.spec.ts` 的逐字节切分（pty/ssh）、3,000 行标点密集中文 4 KiB 分块、随机切分；流在字符中间结束时显示 U+FFFD（pty 退出、ssh 错误）；`input-wide.spec.ts` 的 1 字节分块宽度 |
| 2 | 大段粘贴：原前端未完成输入上限 64 KiB，单次超过 64 KiB 的粘贴整体被拒绝；而 Rust 端 PTY/SSH 输入队列为 16 条 × 4 KiB，满了就报错，前端把这个错误当作致命错误，若放宽前端上限，粘贴会在中途被截断 | 超过 64 KiB 的粘贴完全发不出去；放宽后则可能只发出一部分（bracketed paste 缺少结束标记，或非 bracketed 模式下执行半截命令） | 新增 `src/input-queue.ts`：按键与粘贴共用一个有序队列，4096 字节分块、同一时间只有一个写入在途、积压上限 16 MiB（超过则整次拒绝并提示）；只有后端返回“input queue is full”时才在 15 秒内退避（2–50 ms）重发**同一块**，其它错误丢弃其后输入并提示丢弃字节数。Rust 端把“队列满”和“已关闭”拆成两条错误：`PTY/SSH input queue is full; retry after drain` 与 `PTY session is closed` / `SSH terminal is closed`（`pty.rs`、`ssh_terminal.rs`，各有单元测试） | `input-paste.spec.ts`：>1 MiB 粘贴经模拟的 16 × 4 KiB 有界后端，逐字节一致、无重复、无乱序，期间确有“队列满”被拒并重发；失败写入后丢弃其余；超过 16 MiB 整体拒绝；队列单元测试（只重试队列满、保序、到期放弃） |
| 3 | 粘贴内容中的控制字符原样发送：xterm.js 6.0.0 的 `paste()` 只把 CR LF / LF 换成 CR 并加 bracketed paste 标记，不处理 ESC；拖放到隐藏 textarea 的文本则不经清洗留在其中（xterm.js 6.0.0 不发送它，但读屏 textarea 被污染） | 粘贴文本中的 `ESC[201~` 会提前结束 bracketed paste，其后内容被 shell 当作键入执行；Ctrl-C、Ctrl-D、C1 CSI 等也会生效 | `src/terminal-input.ts` 的粘贴守卫（终端面板上的捕获阶段监听）：仿 XTerm `allowPasteControls: false`，只保留 HT、LF、CR，删除其它 C0、DEL 和全部 C1（U+0080–U+009F），并提示删除了几个；随后交给 `terminal.paste()` 做换行规范化和加标记。拖放文本按粘贴处理：同样清洗后经 `terminal.paste()` 发送，面板任意位置都接受文本拖放 | `input-paste.spec.ts`：伪造结束标记、C0/C1、全控制字符粘贴、拖放到屏幕与 textarea（三种模式）；另有一项固定 xterm.js 自身不清洗的行为 |
| 4 | 应用开启 `screenReaderMode`，此时 xterm.js 6.0.0 忽略不伴随按键的 `insertText` 输入事件 | macOS 表情与符号面板、听写等不经按键插入的文本不会发送 | `attachInsertTextBridge`：只转发 xterm.js 在非读屏模式下本会转发的那类事件（有数据、非组合中、之前没有对应 keydown） | `input-ime.spec.ts` 的“无按键插入文本只发送一次” |
| 5 | `screenReaderMode` 下 xterm.js 发送 F1–F24 和 Shift+Tab 的序列，但不取消 keydown 默认动作 | Chrome 中 F3 打开查找并夺走焦点、F5 重载页面（关闭全部会话）；Shift+Tab 把焦点移出终端，之后的按键全部丢失。普通 Tab 由 xterm.js 自己取消 | `attachKeyDefaultGuard`：序列发送后对这些键 `preventDefault()` | `input-keys.spec.ts` 的“功能键与 Tab 保持焦点和页面”；撤掉守卫后键位矩阵也因页面被重载或失焦而失败 |
| 6 | xterm.js 6.0.0 对 Ctrl+/ 不发送任何字节 | readline/Emacs 的撤销（`C-_`）在常用键位上不可用 | 与 XTerm 一致发送 US（0x1F）。Ctrl+_（key 为 `_`）xterm.js 已映射，不重复处理 | `input-keys.spec.ts` 的 Ctrl 组合键 |
| 7 | 演示模式行编辑：Backspace 按码点删除；行因宽字符折行后只重绘最后一行 | ZWJ 家庭、旗帜、肤色、组合附加符、天城文连写删一半留下残骸；折行后重绘错位 | 按字素簇删除（`Intl.Segmenter`），向上找到折行起点整体重绘；4096 字符上限按字素截断 | `input-wide.spec.ts` 演示行编辑 15 项 |

### 上游缺陷最小复现（xterm.js 6.0.0，不经过本应用的拼接）

```js
const term = new Terminal();
term.open(element);
term.write(new Uint8Array([0x41, 0xe3, 0x80]));   // "A" + "。"(U+3002 = E3 80 82) 的前两个字节
term.write(new Uint8Array([0x82, 0x5a]));         // 剩余字节 + "Z"
// 结果行内容为 "AZ"：。丢失。
// 若切在 E3 之后：write([0x41, 0xe3]); write([0x80, 0x82, 0x5a]) → "A。Z"，正常。
```

原因：`Utf8ToUtf32.decode` 用 `interim[++pos] & 0x3F` 判断暂存槽是否为空，值为 `0x80` 的续字节低 6 位为 0，被当成空槽，于是下一块把续字节写到错误位置并最终丢弃整个字符。`output-utf8.spec.ts` 中有一项固定这一上游行为：升级到含 #6004 的 xterm.js 后该项会失败，届时可以评估去掉 `Utf8Boundary`。

## 探针覆盖与结论

以下“通过”均指上节所述浏览器 + CDP + IPC stub 环境。

### 组合输入（`input-ime.spec.ts`，24 项）

- 中文拼音（`n → ni → ni h → ni hao → 你好`）和日文（`k → か → かn → かんj → かんじ → 漢字`）：组合过程中 `onData` 为 0、`*_write` 为 0；提交后恰好一次 `onData`，IPC 字节等于提交文本的 UTF-8；组合期间缓冲区和光标不动，组合视图左上角与光标单元格偏差小于 1 px。
- 取消（Escape 后清空组合）：什么都不发送，连取消用的 Escape 也不发送；之后的普通键入正常。
- 用 Enter 选候选：该 Enter 不发送，下一次 Enter 发送 `\r`。
- 连续多次组合按顺序提交，无丢失或重复；含 emoji 组合。
- 输出移动光标后，组合视图跟随到新光标位置（含宽字符行）。
- pty/ssh 在 3 万行持续输出（4 KiB 分块，含中文和 emoji）期间组合并提交两次：只发送提交文本各一次，输出最后几行逐行完整；演示模式在 `stress` 样本输出中组合也只提交一次。

### 宽字符（`input-wide.spec.ts`，27 项）

Unicode 11 插件下的单元宽度（pty/ssh 以 1 字节分块写入，演示模式直接写入）：

| 文本 | xterm.js 6.0.0 结果 | 备注 |
|---|---|---|
| 中、ア、한、Ａ、🌏、가（连写字母） | 1 个单元，宽 2 | |
| ｱ（半角片假名） | 宽 1 | |
| 👨‍👩‍👧（ZWJ 家庭） | 3 个宽 2 单元，共 6 列 | 无字素簇合并，已知差距 |
| 🇨🇳（旗帜） | 2 个宽 1 的区域指示符 | 已知差距 |
| 👍🏽（肤色） | 2 个宽 2 单元，共 4 列 | 已知差距 |
| ❤️（VS16）、1️⃣（键帽） | 宽 1 | VS16 不加宽，已知差距 |
| é（e + 组合锐音符） | 并入基字符，宽 1 | |

- 光标前进列数与上表一致；`CUB` 落在宽字符右半格、在该处写入会拆开宽字符；`CUP` 按列寻址，ZWJ 家庭占 6 列。
- shell 风格擦除（两次 BS、两个空格、两次 BS）擦掉一个宽字符。
- 键入的宽字符、emoji、组合序列按原样（不做 Unicode 规范化）以 UTF-8 送达传输层。
- pty/ssh 的 Backspace 无论前面是什么都只发一个 DEL（Ctrl+Backspace 发 BS），删除多少由 shell 决定；ZWJ、旗帜、肤色等的列宽若与 shell 的 `wcwidth` 不一致，shell 行编辑会错位——这一点本轮没有对真实 shell 验证。

### 输出分块（`output-utf8.spec.ts`，7 项）

- pty/ssh：9 组样本（`、。`、`「」`、`—“”`、ZWJ 家庭、U+E000、U+10000、🀄、U+20000、普通中文与 emoji）在每一个字节位置切成两块、相邻切成三块、以及每字节一块，渲染结果和光标位置都与整块发送一致；每块数据（包括整块被暂留的块）恰好 ACK 一次且按序。
- 3,000 行“`「第n行」。、—“引号”…完`”按 4 KiB 分块经 IPC，逐行一致。
- pty 退出、ssh 致命错误时，最后一块停在“中”的前两个字节：行尾显示 U+FFFD。
- `Utf8Boundary` 300 轮随机切分（一半混入非法字节）：输出字节序列与输入完全相同，合法文本的每块都不以未完成序列结尾，暂留不超过 3 字节。
- 前端没有把网络块转成字符串；Rust 端仍只转发原始字节，与 ARCHITECTURE 的约定一致。

### 粘贴（`input-paste.spec.ts`，26 项）

- bracketed paste 关闭：CR LF、LF 都变为 CR，单独的 CR 保留，HT 保留，一次 `onData`。
- `ESC[?2004h` 开启：恰好一对 `ESC[200~ … ESC[201~`；`ESC[?2004l` 后不再加标记。
- 安全：粘贴 `harmless ESC[201~ \n rm -rf ~ \n` 时 ESC 被删除，发送结果只有末尾一个 `ESC[201~`，并提示删除了 1 个控制字符。xterm.js 6.0.0 的 `Terminal.paste()` 本身会原样转发 ESC、ETX 等（有一项测试固定这一点）。
- 拖放：在屏幕区域上 `dragover` 被接受；把含 `ESC[201~` 和 ETX 的文本拖放到屏幕或隐藏 textarea，都清洗后作为一次 bracketed paste 发送，textarea 中不留文本。
- C0/C1：NUL、ETX、EOT、BS、ESC、DEL、NEL(U+0085)、CSI(U+009B)、ST(U+009C) 被删除，HT/LF/CR 保留；只含控制字符的粘贴什么也不发送。
- 大段粘贴：约 1.07 MiB（28,000 行中文、emoji、ASCII）在 bracketed 模式下经模拟的 16 × 4 KiB 后端队列（每毫秒取走 1 块，满则拒绝）完整送达，每次写入不超过 4096 字节，粘贴后键入的字符排在粘贴之后；pty 与 ssh 两条命令路径各一次。
- 非“队列满”的写入失败：已发送部分保留，其余丢弃并提示字节数，不会隔着缺口继续发送；之后的新输入可以继续发送。
- 超过 16 MiB 的单次粘贴整体拒绝并提示，一个字节也不发送。

### 按键（`input-keys.spec.ts`，12 项）

普通光标键模式与应用光标键模式（`ESC[?1h`）下 xterm.js 6.0.0 的发送结果（三种模式一致）：

| 键 | 普通模式 | 应用模式 |
|---|---|---|
| ↑ ↓ → ← | `ESC[A` `ESC[B` `ESC[C` `ESC[D` | `ESC OA` `ESC OB` `ESC OC` `ESC OD` |
| Home / End | `ESC[H` / `ESC[F` | `ESC OH` / `ESC OF` |
| F1–F4 | `ESC OP` … `ESC OS` | 同左 |
| F5–F12 | `ESC[15~` `[17~` `[18~` `[19~` `[20~` `[21~` `[23~` `[24~` | 同左 |
| Insert / Delete / PageUp / PageDown | `ESC[2~` / `ESC[3~` / `ESC[5~` / `ESC[6~` | 同左 |
| Shift+F1、Ctrl+F5、Shift+F12 | `ESC[1;2P`、`ESC[15;5~`、`ESC[24;2~` | 同左 |
| Ctrl+←、Shift+↑、Ctrl+Shift+→、Ctrl+Home | `ESC[1;5D`、`ESC[1;2A`、`ESC[1;6C`、`ESC[1;5H` | 同左 |
| Esc、Tab、Shift+Tab、Enter、Backspace | `ESC`、`HT`、`ESC[Z`、`CR`、`DEL` | 同左 |

- `ESC=`（DECKPAM）被接受，但 xterm.js 6.0.0 没有应用小键盘编码，小键盘数字仍发送数字。
- Ctrl 组合：Ctrl+A…Z → 0x01…0x1A，Ctrl+Space 与 Ctrl+@ → NUL，Ctrl+[ / 3 → ESC，Ctrl+\ / 4 → FS，Ctrl+] / 5 → GS，Ctrl+6 → RS，Ctrl+7 / Ctrl+_ / Ctrl+/ → US，Ctrl+8 → DEL，Ctrl+Backspace → BS。Ctrl+K 发送 VT；Cmd+K 与 Ctrl+Shift+K 打开命令面板且不发送。
- F3、F5、F7、F11、F12、Tab、Shift+Tab 后焦点仍在终端，序列各发送一次。

### Option / Alt 作为 Meta

- 当前配置：`createWorkspaceTerminal` 没有设置 `macOptionIsMeta`，xterm.js 默认 `false`。
- macOS（`navigator.platform` 为 `MacIntel`）：Option+F 发送键盘布局的第三层字符 `ƒ`，不是 `ESC f`；因此 zsh/bash 的 Meta 绑定（Alt+B/F/D/.）在 macOS 上不可用，用户只能用 Esc 前缀。xterm.js 6.0.0 也不再把 Option+←/→ 改写成 `ESC b` / `ESC f`，而是发送 `ESC[1;3D` / `ESC[1;3C`，zsh 与 bash 默认都没有绑定这两个序列。
- 若开启 `macOptionIsMeta`（仅测试中运行时切换，未改产品配置）：Option+F 发送 `ESC f`；代价是德语、法语等布局依赖 Option 输入的 `@ [ ] { } | ~` 等字符将无法输入，Option 死键（如美式布局 Option+E）也会变成 `ESC e`。
- Windows / Linux（`Win32`、`Linux x86_64`）：Alt 即 Meta，Alt+F 发送 `ESC f`，Alt+← 发送 `ESC[1;3D`。
- 建议后续做成设置项（可参考常见终端“左 Option 作 Meta、右 Option 输入字符”的做法），并在 macOS 原生窗口中用真实键盘布局验证；本轮未修改该配置，也没有核对 WindTerm 2.7.0 的对应行为。

## 测试与命令

在 `apps/desktop` 下另开本工作树的 Vite（`npx vite --port <端口> --strictPort`），用指向该端口的本地 Playwright 配置运行：

```sh
npm run build
npx playwright test tests/e2e/input-ime.spec.ts tests/e2e/input-wide.spec.ts tests/e2e/input-paste.spec.ts tests/e2e/input-keys.spec.ts tests/e2e/output-utf8.spec.ts
npx playwright test          # 全量
```

Rust 端新增两项单元测试：`pty::tests::full_input_queue_is_retryable_and_a_closed_one_is_final`、`ssh::terminal::tests::full_input_queue_is_retryable_and_a_closed_one_is_final`。

## 未验证与限制

- 原生 macOS 输入法（拼音、注音、日文候选窗位置、按住选字母、听写、表情面板）、VoiceOver 朗读、WKWebView / WebView2 / WebKitGTK 的组合事件顺序都未测试；`insertText` 桥接与默认动作守卫只在 Chrome 中验证。
- F5 等键在 WKWebView、WebView2 中的默认动作未实测；守卫在 Chrome 中阻止了重载与失焦。
- 大段粘贴只经过模拟的有界后端；真实 PTY（macOS 的 TTY 输入缓冲很小）、真实 SSH 窗口、Telnet 下的吞吐和耗时未测。大段粘贴之后输入的 Ctrl-C 会排在粘贴之后发送，不能中断尚未发出的粘贴。
- SSH 的 `ssh_resize` 与输入共用 16 条队列；大段粘贴期间调整窗口可能收到“队列满”，前端目前不重试尺寸调整，只在状态栏显示错误。
- 粘贴清洗不区分 bracketed paste 是否开启，也没有“多行粘贴确认”；有意粘贴转义序列的用法因此不可用。拖放只用合成的 `DragEvent` 验证；Tauri 默认开启原生拖放处理（`dragDropEnabled`），原生窗口中文本或文件拖放是否还会到达页面未实测。
- ZWJ、旗帜、肤色、VS16 的列宽仍是 xterm.js 6.0.0 + Unicode 11 的结果，与 macOS 字体实际字形宽度和 shell 的 `wcwidth` 可能不一致；没有引入字素簇宽度方案。
- 没有对照 WindTerm 2.7.0 的输入法、粘贴或按键行为。
