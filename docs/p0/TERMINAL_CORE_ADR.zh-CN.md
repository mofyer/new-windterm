# 终端内核技术调整建议与条件门禁（决策记录）

状态：**收尾边界已于 2026-10-15 获用户批准；H1+H4 为当前保守路线建议，待最终出口独立评审**。初稿日期：2026-10-11；门禁修订：2026-10-15。P0 仅收尾“架构关键判断、最小原生可行性、ADR 与工期”三个决策包；生产插件启用、依赖升级、上游贡献和替换内核各有条件门禁，不再全部列作 P0 前置。完整 164 项目标不变；本修订不批准 CSP 放宽、替换内核或 P0 通过。决策摘要与剩余语义见[路线决定表](TERMINAL_ROUTE_DECISION_2026-10-15.zh-CN.md)。

下文版本、外部 issue 状态、源码比较、包体和工期数字保留为 **2026-10-11 的研究快照**，本轮没有重新联网核实，不能作为当前版本选择或新的工期承诺。实际升级前需重新核实。

## 背景

[VT 兼容矩阵](VT_MATRIX.zh-CN.md)用 63 项探针记录了 xterm.js 6.0.0 的原样行为。设备身份、DECRQSS、OSC 52 等回复类缺口可以用公开的解析器钩子补齐，其中设备身份、DECSCL 等级报告、DECRQSS SGR/DECSCUSR、DECOM 下的 CPR 与 OSC 52 策略已由生产适配器 `vt-adapters.ts` 处理（仅浏览器验证，见矩阵「生产 VT 适配器」一节）。以下缺口钩子无法关闭：

| 缺口 | 探针 | 影响的功能 ID | 为什么钩子不够 |
| --- | --- | --- | --- |
| 双宽/双高行 DECDWL/DECDHL | L01、H01 | T07 T21 | buffer 没有行属性，渲染器不能放大绘制；钩子能收到序列，但改不了列宽（H01） |
| 左右边距 DECSLRM/DECLRMM | S04 | T10 T11 T21 | 打印、换行、滚动、IL/DL/ICH/DCH、DECOM 都要尊重边距，只能在内核里实现 |
| VT420 矩形操作 DECCRA/DECFRA/DECERA/DECSERA/DECCARA/DECRARA/DECRQCRA | E07 | T10 T11 T21 | 要直接修改 buffer；在钩子里再写数据会排到当前数据块之后，顺序错乱 |
| SIXEL | P01 | T09 T12 | 核心把 DCS 吞掉，不绘制 |
| DECSC 不保存 DECOM 与自动换行 | C03 | T10 T11 T21 | 状态在 InputHandler 内部 |
| 闪烁只存储、不绘制 | R03 | T07 T21 | DOM 渲染器没有闪烁样式 |

“探针”列是 VT 矩阵的探针编号，“功能 ID”列是[功能对齐矩阵](../FEATURE_PARITY.zh-CN.md)的稳定 ID，两套编号互不相同（例如探针 G03 是 DECNRCM，功能 G03 是 Free Type）。

VT 矩阵还列出了 A02（47 备用屏保留）、W04（硬换行反向回绕）、G05（LS1R/LS2R/LS3R）、M05（1005/1015 鼠标编码）等同样位于内核内部的缺口。本文不逐项展开，它们与 C03 同属内核状态，处理路线与下文对 C03/S04 的建议相同：先查上游，再决定是否进受控分支。上游 beta 是否已修复它们，本轮**没有检查**。

另有三项 WindTerm 特有能力也受终端内核制约，原型分别见 [Free Type](FREE_TYPE.zh-CN.md)、[折叠/大纲](FOLDING.zh-CN.md)、[压缩历史](HISTORY_ARCHIVE.zh-CN.md)：

- **Free Type（功能 G03）**：在光标处叠加原生 textarea。可行，只依赖光标坐标和单元格尺寸。
- **折叠/大纲（G16/G17）**：xterm 不能在实时缓冲中隐藏行，原型只能在由逻辑行回放的只读视图里折叠。
- **压缩历史（Q04/Q06）**：原型是“有界热窗口 + WebView 内 deflate 冷归档”，只保存文本与 SGR。

上游 WindTerm 的 README 宣称支持 vt340/vt420/vt520，“除 Tektronix 4014 外 vttest 全部通过”，并支持动态内存压缩、时间戳、折叠与大纲。**这些专项声明尚未完成 WindTerm 2.7.0 实机验证**；已有[有限上游观察](UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)不等于完整 vttest、实时折叠或容量验收。未验证期间，上述冻结能力继续作为硬目标保守保留并估算补齐成本，不能因找不到入口或未测通过而删除。

[架构说明](../ARCHITECTURE.zh-CN.md)要求：发现不足时，用 ADR 在“扩展、受控分支、替换组件”之间做选择，并写明功能差距、证据、维护成本、迁移方式和重新验收条件。下面按这个要求展开。

## 方案一：官方 `@xterm/addon-image`（SIXEL）

来源：[npm](https://www.npmjs.com/package/@xterm/addon-image)、[源码 addons/addon-image](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-image)。

### 版本与体积

- **版本**：`@xterm/addon-image` **0.9.0**，MIT，2025-12-22 与 `@xterm/xterm` 6.0.0 同日发布，`package.json` 中的 `commit` 都是 `f447274f`。这是唯一与 6.0.0 配套的稳定版。
  - npm 上更新的版本只有 `0.10.0-beta.*`，与 xterm 6.1.0-beta 配套。
  - 本仓库以开发依赖精确锁定 0.9.0，记录见[依赖清单](DEPENDENCIES.zh-CN.md)。
- **依赖**：没有运行时依赖。发布包内联了两个 MIT 库编译的 WebAssembly：[`sixel`](https://github.com/jerch/node-sixel) 和 [`xterm-wasm-parts`](https://github.com/jerch/xterm-wasm-parts)。
- **体积**：
  - `lib/addon-image.mjs` 为 61,966 B，gzip -9 后 20,691 B。作为对照，`xterm.mjs` 是 344,970 B / 88,009 B，当前生产 JS 包是 415.84 kB（gzip 112.16 kB）。
  - 这些是包内产物的大小，没有在应用打包中实测。
  - 当前生产包没有引用该插件：构建产物中搜不到 `xterm-image-layer`。

### 原型

原型代码是 [`sixel-image.ts`](../../apps/desktop/src/terminal-compat/sixel-image.ts)，测试是 [`sixel-image.spec.ts`](../../apps/desktop/tests/e2e/sixel-image.spec.ts)，没有接入生产终端。

- 只启用 SIXEL，限额比插件默认值更紧。
- 只有在 WebAssembly 能编译时才加载插件，避免 DA1 宣称支持 SIXEL、实际却丢图。
- 等待解码器就绪时读取了插件的私有字段（见下文“安全与工程问题”）。超时则卸载插件，插件注册的 DA1 与 XTSMGRAPHICS 处理器随之移除。

实测环境：系统 Chrome、xterm DOM 渲染器、40×12 终端，单元格 9×17 px。

| 场景 | 结果 |
| --- | --- |
| `A` + 12×36 px 双色 SIXEL | 第 1–2 列、第 0–2 行共 6 个单元格带图块，`A` 所在格没有；光标停在 (1,2)，即图像最后一行的起始列；原图 12×36，左半红 `255,0,0,255`、右半蓝 `0,0,255,255`；图层 canvas 中红、蓝像素各 216 个；占用 0.001728 MB |
| 文本覆盖图块 | `CSI 1;2H Z` 只移除 (1,0) 一个图块，其余保留 |
| 回复 | DA1 被插件改写为 `CSI ?62;4;9;22c`；XTSMGRAPHICS `?1;1S` → `?1;0;256S`，`?2;1S` 返回几何尺寸；关闭 `enableSizeReports` 后 `CSI 14t`/`16t` 无回复 |
| 超出像素上限（64×64 上限，声明 100×100） | 不绘制，光标不前进，后续文本 `AB` 正常；控制台 `image exceeds memory limit` |
| 超出字节上限（2,048 B 上限，3,000+ B 负载） | 中止，0 图块，后续文本 `ABCD` 正常；控制台 `SIXEL: too much data, aborting`；同形状 200 B 负载正常解码 |
| OSC 1337（iTerm2 内联图片） | 原型配置下被忽略；对照组开启 `iipSupport` 后，同一 PNG 由浏览器解码并显示 |
| 解码器未就绪（等待预算 0 ms） | 返回 `decoder-timeout` 并卸载插件；DA1 回到 xterm 默认的 `CSI ?1;2c`，`?1;1S` 无回复，SIXEL 被吞掉，前后文本 `AB` 正常 |
| **生产 CSP** | `tauri.conf.json` 的 `script-src 'self'` **禁止编译 WebAssembly**。原型返回 `wasm-blocked`，Chrome 报 “Compiling or instantiating WebAssembly module violates … 'unsafe-eval' is not an allowed source of script”。绕过原型直接加载插件时，DA1 仍回复含 `4` 的 SIXEL 能力，图像却被静默丢弃 |
| 生产 CSP + `'wasm-unsafe-eval'` | 解码正常 |

运行结果：7 项通过；`--repeat-each=5` 共 35 项通过。CSP 测试由 Playwright 以 HTTP 头下发策略，不等于 Tauri 在 WKWebView、WebView2、WebKitGTK 中注入的 CSP。

### 安全与工程问题（源码核对）

- **解码限额**：

  | 选项 | 插件默认值 | 原型取值 | 作用 |
  | --- | --- | --- | --- |
  | `pixelLimit` | 16,777,216（4096×4096） | 4,194,304（2048×2048） | 解码内存上限 = 像素数 × 4。按声明尺寸或增长超限时抛错中止 |
  | `sixelSizeLimit` | 25,000,000 B | 4 MiB | 单条 DCS 原始字节上限 |
  | `storageLimit` | 128 MB | 32 MB | 每个终端的图像 FIFO 缓存 |
  | `sixelPaletteLimit` | 256 | 256 | 库编译期上限为 4096 |
  | `iipSupport` | 开 | **关** | 开启时 PNG/JPEG/GIF 交给 WebView 原生解码器（`createImageBitmap`），攻击面更大 |
  | `enableSizeReports` | 开 | **关** | 开启时插件会擅自打开 XTWINOPS 的像素/字符尺寸报告（与 D08 的策略冲突） |

  此外，宽度上限为 16,384 px；解码器在 4 MiB 以内的内存会常驻。上游计划提高默认值（[#5842](https://github.com/xtermjs/xterm.js/issues/5842)，7.0.0 里程碑：调色板 4096、各协议 32 MB），升级时必须显式传入本项目的限额。
- **主线程同步解码**：0.9.0 没有 Worker，SIXEL 在解析器的 `put` 中同步解码。大图会阻塞 UI，也会推迟 ACK。上限内的最坏耗时尚未测量。
- **依赖 xterm 私有 API**：插件使用 `_core._inputHandler`、内部 `_parser.registerDcsHandler`、`screenElement`、`_themeService` 等，所以必须与 xterm 核心锁在同一提交，不能单独升级。
- **没有就绪信号**：解码器经 `WebAssembly.instantiate` 异步创建，在它就绪前到达的 SIXEL 会被静默丢弃。原型因此读取私有字段等待就绪。生产环境需要上游提供就绪 API，或在启动 PTY 前完成预热。
- **DA1 冲突**：插件无条件把 DA1 改写为 VT220 + SIXEL，与按终端类型回复身份的适配层（D01）冲突，生产中应由身份适配层统一回复。身份适配层现已在 `terminal.ts` 工厂中注册；xterm.js 后注册的处理器先执行，插件若在工厂之后加载，它的 DA1 会抢先回复。
- **与 WindTerm 特性的交互**：
  - 图块存在 xterm 单元格的扩展属性里，滚出 scrollback 后，由 marker 触发删除。
  - [压缩历史](HISTORY_ARCHIVE.zh-CN.md)只归档文本与 SGR，[折叠视图](FOLDING.zh-CN.md)只回放文本，所以图片在两者中都会丢失。是否要求历史保留图片，需要另行决定。
- **上游演进**：7.0 周期内插件改动很大：
  - 新增 kitty 图形协议（[#5592](https://github.com/xtermjs/xterm.js/issues/5592)）。
  - 存储改为 ExtendedAttrs 负载（[#5879](https://github.com/xtermjs/xterm.js/pull/5879)）。
  - 一度出现“文本不能覆盖图块”的回归，已修复（[#5860](https://github.com/xtermjs/xterm.js/issues/5860) → [#6131](https://github.com/xtermjs/xterm.js/pull/6131)）。
  - 渲染重构仍在进行（[#6145](https://github.com/xtermjs/xterm.js/pull/6145)），HiDPI 分辨率问题尚未解决（[#5035](https://github.com/xtermjs/xterm.js/issues/5035)）。
- **CSP**：生产启用需要在 `script-src` 加 `'wasm-unsafe-eval'`。这会允许同源脚本编译任意 WebAssembly，但不放开 `eval`。
  - WebKit 通过 [bug 197759](https://bugs.webkit.org/show_bug.cgi?id=197759)（指向 235408）加入该关键字，具体对应哪个 Safari/macOS 版本，**未核实**。
  - 应用的最低系统是 macOS 12，该系统上 WKWebView 的支持情况必须实测。

**结论**：只有 SIXEL 能靠官方插件补上，代价可控。前提是 CSP 改动在三种 WebView 上验证通过并经过安全评审，DA1 由身份适配层接管，并按原型限额配置。

## 方案二：等待或推动上游 xterm.js

| 缺口 | 上游状态（截至 2026-10-11） | 维护者立场 |
| --- | --- | --- |
| DECSLRM/DECLRMM | [#4285](https://github.com/xtermjs/xterm.js/issues/4285) 开放，标签 `help wanted`、`area/parser`；没有 PR；master `c58ea36` 中没有实现 | jerch（2022-12）：左右边距“相当重要”，在长期待办中，欢迎有经验者实现，但不适合作为新手任务 |
| DECDWL/DECDHL/DECSWL | [#1175](https://github.com/xtermjs/xterm.js/issues/1175) 于 2018 年关闭（不支持） | 2025-01 再次讨论：jerch 认为“40 年没在真实应用里见过”；Tyriar 表示“欢迎 PR，但实现必须足够轻量” |
| 矩形操作 | [#2358](https://github.com/xtermjs/xterm.js/issues/2358)（2021 关闭）列出过 DECCARA/DECRARA/DECCRA/DECERA/DECSERA/DECRQCRA/DECFRA | jerch 投了反对票：“4 年来没有一个请求，不需要用古老的冷门功能把终端状态复杂化”。没有开放的 issue |
| SIXEL | 官方插件（方案一）；[#5644](https://github.com/xtermjs/xterm.js/issues/5644)“6.0 下不显示”经维护者复现为需要换行，已关闭 | 持续投入（kitty、渲染重构） |
| DECSC 保存 DECOM/换行（C03） | [#1526](https://github.com/xtermjs/xterm.js/issues/1526) 已由 [#5553](https://github.com/xtermjs/xterm.js/pull/5553) 修复（2025-12-30 合并，7.0.0 里程碑）：额外保存 G0–G3、GL 级别、DECOM、DECAWM | 已接受 |
| 闪烁（R03） | [#944](https://github.com/xtermjs/xterm.js/issues/944) 已由 [#5671](https://github.com/xtermjs/xterm.js/pull/5671) 实现（2026-02-03 合并，7.0.0 里程碑），新选项 `blinkIntervalDuration`，默认 0（关闭，出于无障碍考虑） | 已接受，默认关闭 |

本地观察：用临时、未提交的 spec 把 `6.1.0-beta.304`（即 master `c58ea36`，2026-08-30）的 `xterm.mjs` 注入页面，与 6.0.0 对比。序列与 [VT 矩阵](VT_MATRIX.zh-CN.md)的对应探针相同，前一轮与本轮复核各运行一次，结论一致：

| 项目 | 6.0.0 | 6.1.0-beta.304 |
| --- | --- | --- |
| C03 DECRQM ?6 / ?7 | `?6;2$y` / `?7;1$y` | `?6;1$y` / `?7;2$y`（已修复） |
| R03 闪烁（`blinkIntervalDuration: 100`，每 25 ms 采样，共 20 次） | 0 次隐藏 | 8–9 次带 `xterm-blink-hidden`（已修复） |
| S04、L01、E07 | 不支持 | 仍不支持（`?69;0$y`、单宽、矩形填充无效果） |

- 闪烁依赖终端在视口内：同一检查中，终端被追加在应用界面下方时，beta 的隐藏次数也是 0。这与 beta 闪烁服务里的视口可见性判断（`_isViewportVisible`）一致，但没有深入核实。
- 该检查没有纳入仓库测试，beta 也没有被锁进依赖。

节奏与风险：

- 发布节奏慢：5.5.0（2024-04-05）到 6.0.0（2025-12-22）间隔约 20 个月。7.0.0 里程碑有 464 项已关闭、7 项开放，没有截止日期；截至 beta.304，master 已领先 6.0.0 共 1,156 个提交。
- 维护者正在探索用 libghostty 取代 Buffer/BufferLine/解析器/InputHandler（[#5686](https://github.com/xtermjs/xterm.js/issues/5686)，提案阶段）。如果落地，解析器钩子与 addon-image 的私有 API 依赖都可能受到影响。
- 另有开放 PR [#6209](https://github.com/xtermjs/xterm.js/pull/6209)：滚动后 DECRC 恢复到屏幕行（可选开启）。

**结论**：

- C03 与 R03 优先采用已经包含修复的受支持正式版，但只有候选版本通过回归后才能升级；不能无限等待上游发布时间，交付受阻时按后文条件评估回移植。
- DECSLRM 适合走“上游优先”贡献，但合入和发布时间不可控。
- 本次快照没有找到 DECDWL 与矩形操作可直接采用的上游实现；估算保留自研或受控分支成本，不把未来上游实现视为保证。

## 方案三：补丁或受控分支（fork）xterm.js

- **改动方式**：npm 包里可执行的只有压缩后的 `lib/xterm.mjs`/`xterm.js`（随包的 `src/` 不参与运行），用 patch-package 之类的工具只能改压缩产物，无法维护。必须从[源码](https://github.com/xtermjs/xterm.js)分叉构建，再以自有 scope 发布或作为构建产物纳入仓库。MIT 许可允许这样做，需保留版权声明。
- **涉及范围**（6.0.0 非测试 TS：`src/common` 13,081 行，其中 `InputHandler.ts` 3,495 行；`src/browser` 8,490 行；不含 WebGL 插件）：
  - DECSLRM：print/自动换行、CR/LF/IND/RI/NEL、区域滚动、IL/DL/ICH/DCH/DECIC/DECDC/SL/SR、DECOM 光标钳制、DECRQSS/DECRQM ?69、DECSTR/RIS，以及“只有全宽边距才进入 scrollback”的规则。
  - DECDWL/DECDHL：BufferLine 加行属性，并在重排、裁剪、序列化、[压缩历史](HISTORY_ARCHIVE.zh-CN.md)中保留；打印与光标按半列数计算；DOM 渲染器（应用当前只用它）与 WebGL 插件都要放大绘制；选区、鼠标坐标、链接检测、无障碍行映射、Free Type 叠加层的定位都要按双宽计算。
  - 矩形操作：InputHandler 与 Buffer 的区域读写；DECSERA 复用已有的 DECSCA 保护属性；DECCARA/DECRARA 修改属性；DECSACE。**DECRQCRA 会把屏幕内容的校验和回报给主机，有逐格探测屏幕的风险**，应默认关闭（wezterm 同样默认关闭）。
- **粗估**（1 名熟悉 xterm.js 代码的工程师；只是量级，未经拆解评审）：
  - 首次实现：DECSLRM 3–5 人周，DECDWL/DECDHL 4–6 人周，矩形操作 2–3 人周，vttest 自动化与探针 1–2 人周，合计 **10–16 人周**。
  - 持续成本：每次合并上游版本约 **1–3 人周**（6.0.0 到 beta.304 改动 ≥ 300 个文件，buffer 扩展属性与渲染器都在重构），每次都要重跑 63 项探针、SIXEL 原型与 vttest。如果上游采用 libghostty（#5686），补丁可能要整体重写。
- **降低风险**：DECSLRM 先在 #4285 讨论设计并争取合入上游；分支只保留上游明确不要的补丁（DECDWL、矩形操作），并且每项补丁都附带对应的探针。

## 方案四：Rust 终端内核 + WebView 自绘渲染

源码核对的结果如下（核对日期 2026-10-11，路径相对于各 crate 或仓库根目录）。

| | [alacritty_terminal](https://crates.io/crates/alacritty_terminal) | [wezterm-term](https://github.com/wezterm/wezterm/tree/main/term)（+ [termwiz](https://crates.io/crates/termwiz)） | [vt100](https://crates.io/crates/vt100) | [libghostty-vt](https://github.com/ghostty-org/ghostty)（参考） |
| --- | --- | --- | --- | --- |
| 版本 / 许可 | 0.26.0（2026-04-06）/ Apache-2.0 | wezterm-term **未发布到 crates.io**，只能 git 依赖 wezterm 仓库（默认会拉 harfbuzz/freetype 等子模块），或用社区转发布的 `tattoy-wezterm-term`（0.1.0-fork.5）、`zeughaus-wezterm-term`（0.1.0）/ MIT。termwiz 0.23.3（2025-03-20，MIT）已发布，但只含解析器与 Surface，没有终端状态机 | 0.16.2（2025-07-12，仓库基本停更）/ MIT | Ghostty（Zig）/ MIT。crates.io 上的 Rust 绑定 `libghostty-vt` 0.2.2（MIT OR Apache-2.0）来自个人仓库 [Uzaaft/libghostty-rs](https://github.com/Uzaaft/libghostty-rs)，不在 ghostty-org 名下；构建需要 Zig |
| DECDWL/DECDHL | 否（只有 `ESC # 8`） | **存储**行属性，wezterm-gui 绘制时放大；**内核不按半列钳制光标和换行** | 否 | 否 |
| DECSLRM/DECLRMM | 否（[#160](https://github.com/alacritty/alacritty/issues/160) 开放） | **是**：打印、换行、IL/DL/ICH/DCH、SU/SD、IND/RI、DECRQSS | 否 | **是** |
| 矩形操作 | 否（[#6969](https://github.com/alacritty/alacritty/issues/6969) 维护者无意支持） | 只有 DECRQCRA（默认关闭） | 否 | 只有 DECRQCRA/XTCHECKSUM |
| 图像 | 否（SIXEL PR [#4763](https://github.com/alacritty/alacritty/pull/4763) 自 2021 未合并） | SIXEL（文档自称“初步”）、iTerm2、kitty（默认关闭） | 否 | 只有 kitty |
| DECSC 保存 DECOM / 换行 | 否 / 否 | 是 / 否 | 是 / 无 DECAWM | 是 / 否 |
| 闪烁 | 解析后丢弃（[#2365](https://github.com/alacritty/alacritty/issues/2365) 不支持） | 存储（wezterm-gui 绘制） | 不存储 | 存储，不绘制 |
| 历史 | 未压缩环形缓冲，默认 10,000 行；主屏重排 | 行滚入历史时压缩为 `ClusteredLine`，默认 3,500 行；主屏重排；有变更序号 | 无压缩，**不重排** | 按字节限额；冷页可用 LZ4 压缩；重排 |
| API 稳定性 | 正常版本发布 | 作者明确**不承诺 API 稳定**（[#2799](https://github.com/wezterm/wezterm/issues/2799)、[#6663](https://github.com/wezterm/wezterm/issues/6663)） | 稳定但功能少 | C API 仍在扩展 |
| IME / 无障碍 | 内核都不涉及，全部由渲染层负责 | 同左 | 同左 | 同左 |

结论与成本：

- **没有一个现成内核覆盖全部缺口**。DECDWL 的真实语义（半列）和 DECCRA/DECFRA/DECERA/DECSERA/DECCARA/DECRARA 在四个内核中都要自己写。换内核能带来的是 DECSLRM 与 SIXEL（wezterm-term），以及对 WindTerm 特性的完全控制，并不能省掉 VT 缺口的工作。alacritty_terminal 在这些缺口上不比 xterm.js 好；vt100 不适用。
- **有了自有渲染器，WindTerm 特有能力更顺手**：
  - 折叠、大纲、时间戳可以作为行元数据直接作用于实时屏幕。
  - 压缩历史可以放在 Rust 进程中（wezterm 的 `ClusteredLine`、Ghostty 的 LZ4 冷页思路），内存不再计入 WebView。
  - Free Type 叠加层可以沿用，只需由内核提供光标几何。
- **需要自建、目前由 xterm.js 提供的部分**：
  - 渲染器：字形图集、DPR、自定义框线/powerline 字形、光标样式、滚动条。
  - Unicode 宽度、字形簇与字体回退。
  - 输入：键盘编码（应用光标键、修饰键）和鼠标编码。
  - 选区（含矩形选区）、复制、OSC 8 与正则链接、搜索高亮、装饰、图像图层。
  - **IME**：隐藏 textarea、组合文本预览、候选框定位。xterm.js 在 WKWebView 上仍有未解决的输入问题，例如 [#5894](https://github.com/xtermjs/xterm.js/issues/5894) 死键问题，这类坑要重新踩一遍。
  - **无障碍**：xterm.js 的 `screenReaderMode` 会生成供 VoiceOver/NVDA 读取的 DOM 镜像，自绘 canvas 必须自建同等结构，否则会退化。
- **数据通路**：
  - 内核在 Rust 进程：每帧经 Tauri IPC 发送屏幕差量。本项目在 headless Chrome 中实测，经应用路径（IPC stub）约 10 MiB/s，直接写入 xterm 解析为 38–76 MiB/s（[结果](RESULTS.zh-CN.md)），原生 IPC 吞吐未测。参照 tuicommander 每格 24 字节的二进制帧，200×50 全屏一帧约 240 KB，60 fps 全量重绘约 14 MB/s，因此必须基于损伤区域发差量。
  - 内核编译为 WASM 在 WebView 内运行（ghostty-web、ThinkTerm 的做法）：可以免去逐帧 IPC，同样需要 `'wasm-unsafe-eval'`，并且能否把完整内核编译到 wasm32 尚未验证：ThinkTerm 的浏览器客户端 crate `thinkterm-web` 以 wasm32 为目标并依赖其分支中的 wezterm-term 与 termwiz（只读了 Cargo.toml 和构建脚本，未构建）；alacritty_terminal **未核实**。
- **已有的可行性旁证**（只读了公开文档，未运行）：
  - [sstraus/tuicommander](https://github.com/sstraus/tuicommander)（Tauri）：用打了补丁的 alacritty_terminal 0.26 + Canvas2D 完全替换了 xterm.js，补丁涉及私有 API、损伤跟踪，以及 IL/DL/ICH/DCH/ECH 的待换行语义修正。
  - [coder/ghostty-web](https://github.com/coder/ghostty-web)：MIT，0.4.0，Ghostty 内核 WASM + Canvas2D，提供兼容 xterm.js 的 API。
  - [RoversX/ThinkTerm](https://github.com/RoversX/ThinkTerm)（GPL-3.0，只能参考，不能借用代码）：基于 wezterm 分支的多路复用终端。桌面端原生 GPU 渲染，不用 WebView；另有 wasm32 + WebGPU 浏览器客户端连接 mux 服务端。据其 README，会话由 mux 服务端维护，浏览器端是否运行完整终端状态机未核实。
- **对现有架构的冲击**：
  - `CLAUDE.md` 与[架构说明](../ARCHITECTURE.zh-CN.md)规定“xterm.js 是唯一的终端状态来源，不要在 Rust 再维护一份屏幕”，采用本方案就要改写这一约定。
  - PTY/SSH/Telnet 的 ACK 改为在内核解析后确认。
  - 前端终端、Free Type、折叠、压缩历史四个原型都要迁移。
- **粗估**：达到当前 xterm.js 的基线（渲染、输入、选区、IME、无障碍、链接、搜索、图像、帧协议）约 **6–10 人月**，再加上内核未覆盖的缺口（DECDWL 半列语义与渲染、矩形操作约 1.5–2 人月），以及三平台 WebView 的 IME/无障碍实测。

## 方案五：混合方案

| 混合形态 | 判断 |
| --- | --- |
| **H1 xterm.js + 兼容层 + 上游优先**：方案一处理 SIXEL；钩子补回复；候选正式版经回归后修复 C03/R03；DECSLRM 优先考虑贡献上游；DECDWL/矩形操作按硬目标保留补齐路径 | **推荐作为当前路线**，改动小、可逆 |
| H2 按会话选内核：VT340/420/520 类型用 Rust 内核 + 自绘，xterm/xterm-256color 用 xterm.js | 不推荐。自绘渲染、IME、无障碍的成本一样都省不掉，Free Type、折叠、历史、搜索还要各做两套，体验也不一致 |
| H3 Rust 内核作权威，xterm.js 只渲染（把 Rust 屏幕重新合成为 CUP+SGR+文本写入 xterm） | 不推荐。DECDWL 仍然画不出来；xterm 仍持有自己的 buffer、重排与模式，形成两份状态；键盘和鼠标编码依赖 xterm 的模式镜像，容易漂移 |
| H4 xterm.js 前加一层终端内核边界：把 Free Type、折叠、历史依赖的能力（逻辑行读取、光标几何、marker、写入回调）收拢到一个接口，xterm.js 是它的第一个实现 | **推荐与 H1 同时做**。降低以后换内核（Rust 或 WASM）时的迁移成本 |

## 决策矩阵

缺口覆盖：

| 缺口 | 6.0.0 原样 | ① addon-image | ② 上游 7.0（beta.304 观察） | ③ 受控分支 | ④ wezterm-term | ④ alacritty_terminal | ⑤ 推荐（H1+H4） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L01 DECDWL/DECDHL | 否 | — | 否 | 自研 | 只存储，需自研半列语义与渲染 | 否 | 保留硬目标，条件分支估算 |
| S04 DECSLRM | 否 | — | 否（help wanted） | 自研 | 是 | 否 | 贡献上游；不被接受时转 ③ |
| E07 矩形操作 | 否 | — | 否 | 自研 | 仅 DECRQCRA | 否 | 保留硬目标，条件分支估算 |
| P01 SIXEL | 否 | 是（原型通过，需 CSP） | 插件持续演进 | 同 ① | 是（初步） | 否 | ① |
| C03 DECSC | 否 | — | 是 | 回移植 | 部分（无 DECAWM） | 否 | ② |
| R03 闪烁 | 否 | — | 是（默认关） | 回移植 | 存储，自绘 | 否 | ② |

代价与风险：

| 维度 | ① | ② | ③ | ④ | ⑤ |
| --- | --- | --- | --- | --- | --- |
| Free Type | 不变 | 不变 | 双宽行需重算定位 | 需内核提供光标几何，叠加层可复用 | 不变，经 H4 接口 |
| 折叠/大纲 | 不变 | 不变 | 本文 VT 补丁未实现折叠 | 可自行设计实时行映射，尚未实现验证 | 当前只读视图；活动行映射要求触发重评 |
| 压缩历史 | 图片不入归档 | 不变 | 行属性要入归档 | **可放进 Rust，内存脱离 WebView** | WebView 内归档；容量是切换闸门 |
| IME / 无障碍 | 不变 | 不变 | 双宽行需要无障碍映射 | **高风险，需自建** | 不变 |
| 安全面 | 新增 WASM 解码器，CSP 放宽 `'wasm-unsafe-eval'` | 无 | 自维护补丁需要审计 | 帧协议与图像解码移入 Rust | 同 ① |
| 首次工作量（粗估） | 1–2 人周 | DECSLRM PR 3–6 人周，发布时间不可控 | 10–16 人周 | 6–10 人月 + 1.5–2 人月 | 2–4 人周 + 2–3 周限时 spike |
| 持续维护 | 与 xterm 同提交锁定；7.0 改动大 | 低，受上游节奏限制 | 每次合并上游 1–3 人周；可能被 #5686 推翻 | 全部自有；wezterm-term 无 API 稳定承诺 | 低到中 |
| 架构影响 | 改 CSP | 升级后重跑探针 | 从源码构建 xterm | 改写“xterm.js 唯一状态来源”、ACK 链和前端终端 | 改 CSP（同 ①）；新增 H4 接口，不改状态归属 |
| 可逆性 | 高 | 高 | 中 | 低 | 高 |

## 当前路线建议

**保持 Rust + Tauri 2 + xterm.js；H1+H4 作为当前保守建议提交出口评审。** P0 不实现替换内核，不为得到“全部通过”而缩减冻结能力。H4 只约束后续接入边界，本轮没有新增通用接口或第二份终端状态。

1. 回复类缺口继续使用已存在的公开 parser 适配层。Free Type、折叠、压缩历史接入生产时按实际需要收拢公开能力边界；xterm 仍是唯一终端状态来源。
2. SIXEL 采用官方插件的候选方案保留，但生产仍关闭；完成下表 G-SIXEL 后才可提交启用变更。
3. C03/R03 优先通过经验证的正式版修复；未来版本及发布时间不作为承诺。不无限等待上游：若影响 P1 交付，比较受控回移植与升级代价后另作决定。
4. DECSLRM 优先考虑上游贡献，同时为未被接受或未及时发布保留受控分支成本。DECDWL/DECDHL、矩形操作继续按硬目标保留；没有上游实测结果也不能据此删除能力。
5. 现有只读历史折叠原型不能直接宣称实时折叠对齐。先区分“当前会话仍输出时折叠已完成逻辑块”与“修改活动终端行映射”；后一种若为硬要求，触发 G-CORE。时间戳装饰本身不自动要求换核。
6. 历史冷归档位置与终端内核可分别决定。容量不足时先评估归档移入 Rust、视口虚拟化及索引；不因归档位置变化就建立第二个屏幕状态。

## P0 决策门禁与后续启用门禁

用户批准后移的是完整验收的责任阶段，**不是取消验收**。下表的 G-* 为本文门禁代号，不是功能 ID；不修改三处冻结台账的 ID、验收或阶段字段。

| 门禁 | 何时必须关闭 | 要求的证据与决定 | 不满足时 |
| --- | --- | --- | --- |
| G-P0 | P0 最终出口评审前 | 集中记录双尺寸、边距、矩形、实时折叠的关键观察或明确未知；对未知保留硬目标、费用与重新评审触发。结合最小原生报告和更新估算，独立评审 H1+H4 是否仍可作为起点 | 有改变路线的反证则提交修复或路线建议；不能标为 P0 通过。未实施完整 vttest 不自动阻止保守条件结论 |
| G-SIXEL | P1 对应能力在产品中启用前 | 在支持的 WKWebView、WebView2、WebKitGTK 验证实际 CSP/WASM 支持；安全评审 CSP；核对最低支持系统；验证上限内解码耗时、ACK、缓存、HiDPI、备用屏/缩放；DA1 归属与失败不宣称能力；就绪 API 或启动前预热；图片历史/折叠保留策略 | 保持生产关闭，不放宽 CSP；记录 T09/T12 等未完成，不据浏览器原型宣布能力通过 |
| G-UPGRADE | 每次 xterm 或插件实际升级前 | 重新核实候选正式版、许可证、配套版本与私有 API；按当时矩阵重跑 VT、SIXEL、兼容原型及原生输入/读屏回归；审查默认值和身份报告 | 保持当前锁定版本；如阻塞交付，评估有限回移植。不能把历史 beta 观察当正式版验证 |
| G-CONTRIB | 提交上游设计/代码前，以及采用结果前 | 重新核实 DECSLRM 设计与接受条件；对外发帖/PR 按用户授权执行。内部明确等待上限和交付日期，采用前验证全部相关 VT 语义 | 未获接受或无法在交付前采用时评估受控分支；不等待无限期上游回复，P0 无需先取得维护者批准 |
| G-CORE | 采用受控分支、替换内核或改变状态归属前 | 由下面触发条件启动专项 ADR；比较覆盖、维护成本、输入/无障碍/安全影响与迁移。仅在需要比较时安排有预算的 spike，替换内核须用户确认 | 保持现有实现与未交付标记；不静默替换内核，不用同步两份状态规避缺口 |

G-SIXEL 的条件批准须明确 CSP 变更；本 ADR 和用户此次收尾确认均不构成该批准。DECRQCRA 继续默认关闭；如需启用，另行确定范围、风险与用户授权。

### 触发重新评审的具体条件

| 条件 | 重新评审范围 |
| --- | --- |
| 双尺寸半列语义、左右边距或矩形操作无法用公开 API 完整实现，且对应 P1 交付需要这些已冻结能力 | 优先比较受控分支的局部补齐；不能把现有探针缺口当作已关闭。即使上游实测尚无结论，也保留这笔工作 |
| 实时折叠确实需要修改活动终端行映射，而只读投影加持续输出不能满足冻结行为；或相关原型显示选区/光标/输入一致性不可达 | 比较扩展 buffer/渲染器与替换内核；“实时有输出”本身不足以直接证明只能换核 |
| 明确的历史容量/内存目标经产品测量不可达 | 先比较 Rust 冷归档、索引和虚拟化；若核心状态/渲染同时受限，再比较换核 |
| 候选升级破坏钩子/插件，或上游未及时提供交付必需修复 | 保持锁定版本，比较有限回移植与受控分支；不因上游探索新内核就立即跟随 |
| 上游拒绝 DECSLRM 设计，或接受但无法按项目交付计划采用 | 进入受控分支评估，费用不得和同一功能的上游贡献成本重复全额计算 |

触发只要求重新评审，不自动授权相应路线。专项 spike 的最小内容是所需 VT 语义、WKWebView 差量帧/输入、IME/读屏最小路径及依赖许可；原文 2–3 周仅是旧量级，不作为 P0 必须先执行的新研究包。

**重新验收条件**（采用分支或换内核时）：重跑当时完整 VT 探针、vttest、Free Type/折叠/压缩历史、PTY/SSH/Telnet 浏览器与 Rust 测试、性能基线，并在目标平台原生窗口中测 IME 与无障碍。完整 IME/读屏/VT 归 P1 对应终端交付前；真实 UART 归 P2 串口交付前，均不能用本次范围收口豁免。

## 复核

在 `apps/desktop` 下另起开发服务器（例如 `npx vite --host 127.0.0.1 --port 1446 --strictPort`），再用一个只把 `baseURL` 改成该端口的本地配置运行：

```sh
npx playwright test --config <本地配置> tests/e2e/sixel-image.spec.ts --reporter=list
npx playwright test --config <本地配置> tests/e2e/sixel-image.spec.ts --repeat-each=5
npx playwright test --config <本地配置>   # 全量
npm run build
```

本轮结果（2026-10-11，macOS，系统 Chrome）：

- `sixel-image.spec.ts`：7 项通过；`--repeat-each=5` 共 35 项通过。
- 全量 Playwright（同一本地配置）：218 项通过。
- `npm run build` 通过，JS 包 415.84 kB（gzip 112.16 kB）；产物中搜不到 `xterm-image-layer`、`sixelSizeLimit`，插件没有进入生产包。
- 原型代码经过独立代码审查，没有 CRITICAL/HIGH 问题。两项 MEDIUM 已处理：断言插件内部日志文本时改为子串匹配并加注释；负向断言使用固定等待，也加注释说明了原因。

2026-10-11 本轮未覆盖：Tauri/WKWebView、WebView2、WebKitGTK、真实 SIXEL 程序（如 `img2sixel`）、vttest、WindTerm 实机。后续有限原生与上游观察分别见[原生记录](NATIVE_ACCEPTANCE_2026-10-15.zh-CN.md)与[上游记录](UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)，不能追溯扩大本轮测试范围。本文原有工作量均为历史粗估，不是最新排期；费用取舍见[路线决定表](TERMINAL_ROUTE_DECISION_2026-10-15.zh-CN.md)。
