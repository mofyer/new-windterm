# Windows PowerShell 诊断结果索引

本文区分已完成的诊断结果与待验证的取证实现，并把下一次复测的停止条件写成预先约定。它不把测试侧取证增强或计划中的复测写成产品验证结果。

## 已完成：有限环境矩阵 `39788501384`

[P1 Windows Shell Latency Diagnostic 39788501384](https://github.com/mofyer/new-windterm/actions/runs/39788501384) 运行于提交 `9d0a51c`。该提交包含八组受控环境、正反向顺序、每样本新进程以及原有 60 秒 stdio / 30 秒 ConPTY 门限。

- Windows Server 2022 与 2025 的 stdio lane 各完成 16/16 个样本，但每个样本都因 **392 字节未知 stderr** 失败；报告保留 `knownBytes={}`、未知标志和失败原因，不能把这些样本算作通过。
- 两个平台 ConPTY 的首轮 `product-whitelist` 均出现 marker timeout。其余新增变量组仍约 17–25 秒，继承环境约 42–72 ms；这说明新增四类变量没有单独消除慢路径，但没有锁定变量、组件或产品根因。
- 该运行的 `headSha` 是 `9d0a51c`，早于提交 `9be5c39`。因此本次 Windows 工件**没有**执行后来加入的 stderr 形状摘要；不能把摘要字段回填为本次运行的实测结果。

已有较早复测曾观察到相同的 392 字节未知流及跨环境一致的指纹，但指纹、字节数和形状都不能说明其来源或安全性。未知 stderr 继续按严格规则阻塞诊断通过和第四批验收。

## 取证边界：提交 `9be5c39`

`9be5c39` 只改测试/诊断侧，在内存中对未知 stderr 计算有界结构摘要：总字节数、chunk 数、UTF-8 有效/无效字节、ASCII、可打印字节、控制字节、ESC、NUL、换行和回车计数。报告不写入 stderr 原文，也不写入环境值、路径或命令内容；未知类型仍将样本标为失败。Node helper 已覆盖摘要字段及“结果 JSON 不包含输入秘密”的隐私断言。

该提交的形状摘要已在后续 Windows 工作流 `39799065768`（HEAD `a598a6a`）及 `39804296453`（HEAD `7c06cab`）实际执行。摘要是取证工具的结构信息，不是 stderr 的分类结论；即使摘要在多次运行中相同，也不能据此将未知流改判为无害或通过。

## 已完成：形状摘要复测 `39799065768`

[复测 39799065768](https://github.com/mofyer/new-windterm/actions/runs/39799065768) 整体失败。两平台 stdio 各保留 16 条记录；正常样本均为 392 字节未知 stderr、2 个 chunks、有效 UTF-8/ASCII 392 字节、可打印 390 字节、CR/LF 各 1、其他控制字节/ESC/NUL 为 0，指纹均为 `a3639af5e23464fc391dae127fd5493f02c8178068a35866d9c7fdd35dcd623f`。Windows 2025 另有一次产品白名单 60 秒超时，不能把正常样本摘要回填到超时样本。ConPTY Windows 2022 为 16/16，Windows 2025 为 15/16，首轮产品白名单 marker timeout。详细计时见 [P1 执行记录](RESULTS.zh-CN.md#八组环境矩阵复测工作流-39799065768)。

## 已完成：受控 stderr 对照 `39804296453`

[复测 39804296453](https://github.com/mofyer/new-windterm/actions/runs/39804296453) 对应 `7c06cab290aa09cb916f603f9d15892d811a1a26`，整体失败。两平台的独立 fixture 步骤均通过，`powershell-stderr-fixture-windows-{2022,2025}/report.json` 完全一致：warning 为 unknown / exit 0 / 426 字节，error 为 unknown / exit 1 / 789 字节，empty 为 empty / exit 0 / 0 字节，unknown 为 unknown / exit 0 / 17 字节；各 case 无超时、无截断。该通过仅验证受控预期，未将 unknown 或非零退出加入 latency 的允许规则；包装结构尚未解码，真实 392 字节流的来源仍未确定。

两平台 `powershell-latency-windows-{2022,2025}/summary.json` 各为 16 条记录、16 条失败。`measurements.json` 核实所有样本完整、三阶段 cwd 匹配、exit 0、无超时，失败均由 392 字节未知 stderr 触发，形状与指纹同上。Windows 2025 首轮产品白名单首次 `Get-Location` 为 57.149 秒，仍未触发原 60 秒进程期限；期限内完成不等于性能通过。

ConPTY Windows 2025 为 16/16，Windows 2022 为 15/16，后者首轮产品白名单 marker timeout；加回父 `PSModulePath` 的白名单样本仍有约 17–25 秒慢路径。完整字段、指纹和证据边界见 [P1 执行记录](RESULTS.zh-CN.md#受控-stderr-对照与矩阵复测工作流-39804296453)。

## 取证结果：有界结构摘要与 ConPTY 报告 `39812975794`

本轮测试侧新增 `stderr.structure`，仅在完整、有界的固定 CLIXML 子集满足全部检查后输出固定流类型计数；非法 UTF-8、未知/恶意结构、拼接垃圾与截断保守拒绝，不保存原文或路径，也不提升现有 unknown 分类和非空 stderr 失败门禁。ConPTY 新 runner 将编译与测量输出分开，只生成固定字段的 `report.json`，workflow 不再上传原始 `probe.log`；历史工件仍保留其原有隐私限制。

实现与 workflow 已提交并推送为 `67d7f37`；本机完整 native helper 110/110，通过独立复跑与审查。[Windows 双平台取证 39812975794](https://github.com/mofyer/new-windterm/actions/runs/39812975794) 的精确 HEAD 为 `67d7f37a4d1a40c6e027b0da28ae65fd76d29096`。两个 stdio 作业已失败，fixture 步骤通过；ConPTY 测量与上传步骤已完成，Windows 2022 成功、Windows 2025 失败，工作流已结束、整体失败；后续本地 runner 补强 `81d109a` 独立复跑 native helper 111/111，通过审查，该后续本地验证不属于该被测 HEAD。原八组矩阵、正反序、每样本新进程、stdio 60 秒及 ConPTY 单样本 30 秒边界保持。实现说明见 [P1 执行记录](RESULTS.zh-CN.md#有界-stderr-结构与-conpty-内容受限报告工作流-39812975794)。

已取得的 32 条 stdio 测量均完整、cwd 匹配、exit 0、无超时和截断；真实 392 字节流的结构均为 `clixml`、16 节点、深度 5、仅 `progress=1`，指纹与历史 `a3639af5…623f` 一致。原分类仍为 unknown，32 条仍全部严格失败。两平台 fixture 的 warning 为 `warning=1/progress=1`，error 为 `error=4/progress=1`，empty 为空，17 字节 unknown 无 header；原字节数、指纹、分类与退出码预期不变。结构只说明允许语法中的流标记，不证明内容无害、慢路径根因或 ConPTY 行为。两个 ConPTY artifact 各仅有内容受限的 `report.json`，固定 schema 检查未发现原文或路径，均包含 16 个唯一完整样本；2022 为 16/16，2025 为 15/16，首轮产品白名单 marker timeout。两平台 build/probe 均观察到退出，未请求 tree kill，本地资源释放。该轮结束时提出的固定慢环境、模块命令解析与进度产生对照在后续 `d2cee0e` 完成实现，见下节；不得通过抑制 progress 绕过原验收。

## 已完成、严格失败：有限因果对照 `39816931188`

准确提交 `d2cee0ea84ce05a67b4d3cf313c1da268b11365f` 已推送至 `p1/integration`，实现[预注册的固定白名单五 arm 对照](POWERSHELL_CAUSAL_PLAN.zh-CN.md)。本机全 native helper 129/129、独立专项 18/18 通过，独立审查通过；对应的 [Windows 双平台运行 39816931188](https://github.com/mofyer/new-windterm/actions/runs/39816931188) 已 `completed/failure`，两个作业均失败，helper 检查及两份工件上传成功。

每平台正反两轮均取得十个预定观察，其中八个有效测量、两个类型化 command-not-found；报告均为 `experimentComplete=true`、`strictPassed=false`、`stopReason=null`。无超时、截断或清理失败，`cleanupSucceeded=null` 表示未触发终止清理。默认 `Get-Location` 与抑制 progress 后的内部操作耗时分别为：Windows 2022 的 19.682 / 19.476 秒与 19.776 / 19.656 秒；Windows 2025 的 23.480 / 23.121 秒与 23.240 / 23.120 秒。stderr 从 392 字节、progress=1 变为空，但慢路径仍在，削弱可见 progress 解释全部时延的假设，未锁定根因。

类型化缺失的四个观察均 exit 2、`elapsedMs` 与 cwd 为 `null`，wall 187–347 ms 不是成功查询耗时；直接读取内部约 5–8 ms 也不能掩盖首进程 wall 为 3.049 / 4.233 秒。显式 `Write-Progress` 校准包含 Utility 命令发现与可能的初始化，不能当作纯序列化基准。两份 `measurements.json` 均通过独立 schema/隐私核验，文件 SHA-256 和完整计时见 [P1 执行记录](RESULTS.zh-CN.md#固定白名单的有限因果对照工作流-39816931188)。

本轮只执行一次 push 触发，无追加重试，不改变旧门禁或产品白名单，不重跑原八环境矩阵。下一步仅准备 cmdlet 发现、模块加载与初始化阶段的预注册诊断候选；本轮方案不事后改判。P1 与第四批仍未通过，P2 仅准备，main 不合并。

## 已完成、严格失败：阶段诊断 `39819222771`

准确提交 `66e237e8f11034d5c837f7d84ca2b280dff1d9e0` 已推送，实现[命令准备与查询阶段预注册方案](POWERSHELL_PHASE_PLAN.zh-CN.md)。本机 native helper 148/148、独立专项 19/19 通过，独立审查通过；对应[Windows 阶段运行 39819222771](https://github.com/mofyer/new-windterm/actions/runs/39819222771) 已 `completed/failure`，两平台 helper 与精确 JSON 上传成功，工件独立 schema/边界/隐私核验通过。

每平台三 arm、正反两轮六个样本及 16 个阶段均完整，exit 0、身份/cwd 均匹配；`experimentComplete=true`、`strictPassed=false`、`stopReason=null`。无超时、截断、协议或清理失败，cleanup null 仅表示未触发终止清理。每平台四个 cold/discover 样本仍为旧指纹的 392 字节 progress=1 CLIXML 并严格失败，两个 import 样本为空 stderr 且样本严格通过，不能改写实验整体失败。

cold 首次查询为 21.396–29.322 秒（2022）及 22.752–28.074 秒（2025）；discover 准备为 21.281–21.381 秒及 22.699–22.738 秒，后续首次查询约 2.36–3.01 ms。显式 Management import 准备为 44.236–48.665 ms 及 49.369–59.024 ms，后续首次查询约 2.52–2.60 ms，整个进程 wall 约 244–276 ms。这支持进一步区分自动命令发现/导入路径与显式指定模块导入路径；并未确定具体扫描、缓存或网络机制。准备包含身份校验，之后查询已预热，阶段不能相减归因或相加代替 wall。

本轮只执行一次 push 运行，不改预注册方案或旧门禁；精确计时及报告 SHA-256 见 [P1 执行记录](RESULTS.zh-CN.md#命令准备与查询阶段诊断工作流-39819222771)。下一步候选为更窄的自动发现与指定模块解析/导入对照，或真实 ConPTY 有限对照，均先预注册、不直接修改产品。P1 与第四批仍未通过，P2 仅准备，main 不合并。

## 已结束、对照未完成：真实 ConPTY 限定命令 `39824348485`

按[预注册方案](CONPTY_QUALIFIED_PLAN.zh-CN.md)，实现 `0940bc365849cd724041cde204d19ac9e395cb57` 先 `[skip ci]` 推送，新 workflow 单独提交为 `a8e64c7260d5dfc306746b9304bbd6a3404eff9c` 并推送，第二提交是本轮准确被测 HEAD。两次推送原计划安排一次实测，未重跑旧矩阵；额外调度及取消如下。

本机 native helper 184/184、wrapper 36/36、Rust 专项 11/11、release bin 门控 3/3 及 Windows cfg clippy/独立审查通过；这些与平台实跑分开。[主运行 39824348485](https://github.com/mofyer/new-windterm/actions/runs/39824348485) 已 `completed/failure`，两 job 失败、上传成功。两平台 Rust 专项测试及构建 exit 0；2022 只取得首轮两条记录：unqualified 成功 q1=15406.5298 ms、q2=0.1818 ms，module-qualified 为 `protocol-error`、q1/q2=null，随后停止。2025 首轮 unqualified 为 `command-timeout`、q1/q2=null，限定 arm 根本未运行。两平台第二轮均未执行，三个完成/成功字段均 false，首失败停止规则生效。

2022 限定 arm 的 518.1522 ms wall 是失败样本，不能称快查询；2025 的 30009.8372 ms host 是轮询超时观测，原 30 秒窗口未放宽。null 只表示没有完整合法 RESULT，不证明命令没执行；错误后清理可产生 exit 1，不能认定脚本自行失败。合流仍不能判断独立 stderr 是否为空。主运行两份报告独立 schema/隐私/顺序/状态核验通过，精确计时与文件 SHA-256 见 [P1 执行记录](RESULTS.zh-CN.md#真实-conpty-模块限定命令对照工作流-39824348485)。没有完整性能对照或根因结论。

同一 HEAD 意外出现两个 push event 调度，均非手动 dispatch：后创建的 [39824353657](https://github.com/mofyer/new-windterm/actions/runs/39824353657) 已 `completed/cancelled`，两 job 取消、上传成功。其组合步骤曾启动，但两工件均为 `tests=null/build=null/samples=[]` 初始报告，三个完成/成功字段 false；按代码顺序未完成 Rust 测试、未采样，`failure=null` 不是通过。取消工件同指纹见上述执行记录，仅用于取消审计，不拼接主运行证据，不事后修改方案。

下一步先加有限协议阶段分类/计数，查明诊断为何失败再预注册重做；CR/CSI 重绘处理仅为待验证代码候选。产品没有内置目录查询，不能替换原生验收中的普通 `Get-Location` 掩盖慢路径。旧门禁与失败保持，P1/第四批未通过，P2 仅准备，main 不合并。

## 已结束、对照未完成：ConPTY 协议诊断 `39828696609`

新实现 `e3827ea33545c6e8c3922295a9b3bbfc5548977d` 已提交推送，按[新预注册](CONPTY_PROTOCOL_DIAGNOSTIC_PLAN.zh-CN.md)只增加 schema 2 固定阶段/原因、有限终端计数和清理退出时序，保留旧协议接受规则、两 arm 正反四 worker 上限、原时限与首失败停止。完整 native **189/189**、wrapper **41/41**、本机 Rust **15/15** 及 Windows cfg/独立审查通过，不等于 Windows 实跑。

唯一新运行 [39828696609](https://github.com/mofyer/new-windterm/actions/runs/39828696609) 已 `completed/failure`，两 job 失败、helper/上传成功；两平台 Rust 测试与构建 exit 0。2022 首个 unqualified 完整成功（q1=28445.5897 ms、q2=0.1984 ms），随后限定 arm 在 `await-ready` 发生 `startup-timeout`；2025 首个 unqualified 即同阶段启动超时，限定 arm 未运行。两平台反序轮未执行，三个完成/成功字段 false；失败样本 q/host 为 null、version false、CPR 1，查询脚本未投递，不是本轮查询 30 秒超时。

2022 失败快照 `embeddedMarkerLines=1/markerLines=0`，只证明一条被忽略行含 nonce 前缀，不证明完整 READY、输出而非回显或布局根因；2025 八项计数为 0 而最终合流 107 字节，首错计数与最终字节窗口不同，不能称无输出。两失败均 kill true、退出前观测 false、cleanup true，exit 1 不能称脚本自行失败。两报告独立 schema/隐私/状态核验通过，精确计时与 SHA-256 见 [P1 执行记录](RESULTS.zh-CN.md#conpty-协议失败分类诊断工作流-39828696609)。下一步先预注册无查询的 startup-only 诊断，在原 5 秒窗口记录 READY 实际写入完成/时点，区分行首与嵌入完整 READY 形状；先 fixture 和独立审查，分类不放行、不延长门限；模块分析缓存变量的单变量对照只是另一个待预注册候选，实际 runner 值/状态未知，官方依据见该执行记录，不作为本轮根因。原失败保留，ConPTY 合流仍不能证明 stderr 为空，P1/第四批未验收，P2 仅准备，main 不合并。

## 已结束、诊断失败：ConPTY startup-only `39833719372`

按[启动诊断预注册](CONPTY_STARTUP_PLAN.zh-CN.md)，实现 `7aadab600a7c89d4235df239c9c0bf4b12723e66` 使用 `[skip ci]` 推送后，单独推送新 workflow，准确被测 HEAD 为 `fc3ff2d199a6ec87749afc164a5f9eff917abdb9`。本机完整 native **237/237**、startup 专项 **48/48**、Rust **19/19** 及 Windows cfg/独立审查通过；这些与 Windows 实跑分开。唯一 push 运行 [39833719372](https://github.com/mofyer/new-windterm/actions/runs/39833719372) 已 `completed/failure`，两平台 job 失败，helper/Rust 测试/构建通过。

2022 首样本 startup/complete 均成功；第二样本实际 write/flush 在 6.2963 ms 完成，但 strict READY 0、完整 embedded READY 1，仍 `await-ready/startup-timeout`。2025 首样本严格 READY 与写入确认在原窗内完成，`startupComplete=true`，随后 `after-ready/exit-error`、exit 3221225786；不能记为启动失败。第二样本未运行，所以聚合 `startupSuccess=false` 不否定已取得的单样本启动成功。两平台 `experimentComplete/startupSuccess/diagnosticPassed` 均 false，首失败停止、无追加样本。工件独立 schema/隐私/状态核验通过；精确数值与文件 hash 见 [P1 执行记录](RESULTS.zh-CN.md#conpty-startup-only-写入与-ready-分类诊断工作流-39833719372)。

本轮无查询、无新环境 arm，原 5 秒门限保持，嵌入形状只分类不放行。下一步先离线核定 xterm 行边界/CR/CSI fixture，并独立审计退出写入确认/输入端关闭生命周期；2025 kill false 不能排除 cleanup 影响，退出码不能证明终止原因。之后如需实测另行预注册，本轮不改不重跑。ConPTY 合流不证明 stderr 为空，没有查询性能或产品根因结论，旧失败与未验收边界保持。

## 2026-10-25 离线验证与诊断修复

2026-10-25 离线补充：`d85ed99` / `5eed885` 已集成共享 xterm/Rust 行布局 fixture 与 startup-only 退出时序修复，详见[专题](CONPTY_OFFLINE_VALIDATION.zh-CN.md)及[执行记录](RESULTS.zh-CN.md#2026-10-25离线行布局验证与诊断退出时序修复)。xterm 15/15（977 分块）、Rust 31/31（其中同源解析 962 分块）、集成 native helper 237/237 通过，Windows cfg 仅类型检查。旧关闭顺序的 mutation 在同一等待中子进程 fixture 明确失败；修复在原共用 500 ms 内确认退出写入并保留输入端至退出观测或有界终止。旧协议接受、schema 和产品未改，本轮无新 Windows 实测，最近诊断 `39833719372` 仍失败；不能据离线结果关闭 stderr、目录延迟或第四批验收问题。

## 已结束、整轮失败：退出修复验证 `40160768631`

准确 HEAD `7d4d7bb2c0f192743aaf4038e7d71fb8a19e9f94` 的唯一 [push 运行 40160768631](https://github.com/mofyer/new-windterm/actions/runs/40160768631) 按[新预注册](CONPTY_EXIT_VALIDATION_PLAN.zh-CN.md)完成，整体 `failure`：2022 job 成功、两样本 startup/complete true、exit 0，三个聚合字段 true；2025 首样完整成功，第二样本 READY write 6.1119 ms 已确认但 strict 0/embedded 1，`await-ready/startup-timeout`，三个聚合字段 false。两平台 helper、Rust 专项测试/构建、报告上传成功，工件已独立 schema/隐私/顺序/聚合/清理核验；精确计时与文件 hash 见 [执行记录](RESULTS.zh-CN.md#conpty-退出修复的-windows-验证工作流-40160768631)。

本次三个进入成功启动后退出路径的样本均 exit 0，提供有限修复后证据；2025 第二样本未进入该路径，不能据此称退出修复无效，也不能把三个成功当历史根因证明或双平台通过。READY 写入字段不是退出 ACK，kill false 不排除所有系统影响。旧失败、原 5 秒启动/500 ms 共用退出/30 秒查询及 stderr 门禁不变，无重试或补样本。下一步仅评估独立定界帧，先离线验证防回显、控制字符串隔离与分块等边界，另行审查/预注册；该轮结束时方案未实现，后续新模式见下节，本轮不接受嵌入 marker、不修改产品。P1/第四批未验收，P2 仅准备，main 不合并。

## 已结束、前置测试失败：READY frame 独立诊断 `40161857832`

按[独立预注册](CONPTY_FRAMED_PLAN.zh-CN.md)，parser/xterm `9b25ab6` 与宿主/Node `3fcf5d0` 先 `[skip ci]` 推送，随后仅新 workflow 推送为准确 HEAD `b0ee3324ead6f18f243ab949837dde43fa0af86f`。唯一 [push 运行 40161857832](https://github.com/mofyer/new-windterm/actions/runs/40161857832) 已 `completed/failure`：两平台均 `tests-failed`，Cargo test exit 101 / `process-exit`，`build=null`、`samples=[]`、三个聚合字段 false。helper/工具链/报告上传成功，两份工件已独立核验；没有运行 PowerShell worker，不是 frame 协议实测失败。本机 native 293/293、Rust 55/55（含 parser 19/19）、新 wrapper 56/56、xterm frame fixture 6/6 及 check/clippy/fmt/Windows cfg/独立审查通过；离线和类型检查不等于 Windows 实测。

新 `startup-framed` 用连续字节的 nonce frame 与原 5 秒内 READY writer ACK 双确认，独立 19 键 schema；旧模式的严格 LF 行规则与旧失败不改。CPR FIFO/入队后 arm、实际脚本回显隔离、控制字符串隔离、重复/残缺尾部及原预算均已离线验证。本轮无查询、无产品环境变更，每平台最多两个 worker、首失败停止，不追加重试。两平台 tests 输出字节为 22846/22814，进程均观察到退出、未请求 tree kill、本地资源释放；这些不是 worker cleanup 结果。原始输出未落工件，exit 101 不能区分编译错误或测试断言失败。下一步另开局部取证定位此前置失败，不预写原因、不重跑本轮或改冻结代码；文件 SHA-256 及完整状态见[执行记录](RESULTS.zh-CN.md#conpty-ready-frame-独立诊断工作流-40161857832)。这不解除 stderr 或普通目录查询门禁；P1/第四批未验收，P2 仅准备，main 不合并。

## 本机已复现：READY frame 构建前置条件缺口

在精确 `b0ee3324ead6f18f243ab949837dde43fa0af86f` 的两个干净 macOS worktree 中分别验证：无 `dist`/无 `TAURI_CONFIG` 时，`cargo check --locked --all-features --bin powershell_conpty_qualified_probe` 返回 101，内存分类为 `frontend-dist-missing`，宏位置 `src/lib.rs:596`；另一副本真实 `npm ci`、`npm run build`（TypeScript/Vite）均返回 0、前端入口存在后，`cargo test --locked --all-features` 专项 **55/55** 通过。使用 Node 26.0.0、npm 12.0.2、Rust 1.99.0；测试线程数 2。未修改受跟踪文件或创建占位资产，原始输出未落盘。

已核对旧 wrapper 的 `--features dev-tools` 与新 wrapper 的 `--all-features` 差异：后者启用 `custom-protocol`，锁定 Tauri 宏要求 `frontendDist`，而新 workflow 未构建前端。这个本机可复现的编译前置缺口不等于 Windows 历史失败已定因；负向是 check、正向是 test，不能称为完全同命令的红绿测试，也不提供 Windows 链接或执行证据。随后独立预注册的真实资产准备与 Windows 验证见下节，历史运行与门禁保持。详细证据见[执行记录](RESULTS.zh-CN.md#2026-10-25ready-frame-构建前置条件的本机对照)。

## 已完成、有限诊断通过：真实构建准备与 frame 验证 `40163001613`

按[新预注册](CONPTY_FRAMED_PREPARED_PLAN.zh-CN.md)，准备 wrapper/测试/方案第一推 `06e7768` 使用 `[skip ci]`，新 workflow 第二推准确 HEAD 为 `74c6bf97377810167fdb49af5b21016db303c7c1`。唯一 [push 运行 40163001613](https://github.com/mofyer/new-windterm/actions/runs/40163001613) 已 `completed/success`，两平台全部步骤成功，报告独立核验通过；本机专项 18/18、全 native 311/311 与 Windows 进程结果分别记录。

两平台 npm 安装/前端构建、Cargo tests/build 均 exit 0，输出字节分别为 141/447/27410/499，`distReady=true`。2022 两个 worker 的 startup 为 3508.3862/413.6288 ms，2025 为 2036.043/458.3029 ms；四样本均 CPR 1/frame 1、READY write/flush 已确认、startup/complete/cleanup true、exit 0、kill false、`exitObservedBeforeKill=true`、`after-frame` 且无失败。两平台顶层 `phase=done/status=pass/diagnosticPassed=true`，嵌套三个聚合字段均 true。所有外层进程 cleanup 均 observed/not-requested/released；没有重试或补样本。工件只存 Cargo 进程结果，没有 Windows 测试计数原文。完整计时、8 键顶层/19 键 worker 核验及报告 SHA-256 见[执行记录](RESULTS.zh-CN.md#conpty-frame-真实构建准备与验证工作流-40163001613)。

本轮只证明准备后四个有限样本的 frame 启动与有界退出通过。旧实验不重跑、旧失败不重判，无查询或产品环境修改；ConPTY 合流不证明 PowerShell 独立 stderr 为空，也不确定旧 Cargo 失败根因。下一步独立预注册严格 frame 查询协议，保留原未限定查询、白名单及两次查询共用原 30 秒总窗。all-features/wincheck 资产前置说明已另行补齐 `CLAUDE.md`（`3664ee2`），旧 frame workflow 仍待处置。P1/第四批未验收，P2 仅准备，main 不合并。

## 有限诊断通过：framed 查询对照 `40164795306`

[新查询预注册](CONPTY_FRAMED_QUERY_PLAN.zh-CN.md)采用严格 READY/START1/QUERY1/START2/QUERY2/END nonce frame 顺序，每平台最多四个 fresh worker、U/Q/Q/U 正反序，每 worker 两查询共享原 30 秒；首失败停止，不把启动通过当查询通过。新 25 键 worker 报告分别保留合法查询前缀与退出/清理状态，F4 数字按整数刻度校验，不接收错误 cwd。Node 专项 64/64、全 native 375/375、Rust 专项 69/69、check/clippy/fmt/Windows cfg 与独立审查通过，真实 Rust 报告跨 Node 四案例 4/4；Rust/Node 第一推 `d54bf6e`/`1f3d13b` 使用 `[skip ci]`，新 workflow 第二推准确 HEAD `8f976ea13003c523ffb9030273895391298f835b` 的唯一 [push 运行 40164795306](https://github.com/mofyer/new-windterm/actions/runs/40164795306) 已 `completed/success`，两平台准备/Cargo 与合计 8/8 worker 完整通过，固定工件已独立核验，详见[执行记录](RESULTS.zh-CN.md#conpty-framed-查询对照工作流-40164795306)。

真实前端准备复用原安全流程，旧默认行为、产品白名单、普通原生查询、5 秒启动/500 ms 退出/30 秒查询/45 秒 worker 均保持。准备 3 分钟 + Cargo 14 分钟 + 四 worker 3 分钟已占满 20 分钟名义预算，job 硬限不扩，缺样本不补跑。普通首次 q1 为 11299.5118–27513.9404 ms，模块限定为 22.3006–37.4313 ms，第二次均 0.1351–0.2345 ms；所有样本 frameCount=6、cwd 正确、exit 0、未请求 kill、`exitObservedBeforeKill=true`，各 host 均在原 30 秒内。这只支持有限路径耗时差异，普通首次慢路径与具体根因仍未解决。下一步先核对既有 ConPTY 父 PSModulePath 干预证据，避免重做已有 spawn 前 A/B；运行时有效环境差异仅为待评估候选，未预注册/执行。ConPTY 合流不证明独立 stderr 为空，旧失败不改判；P1/第四批未验收，P2 仅准备，main 不合并。

## 有限诊断通过：运行时 PSModulePath 干预 `40166224227`

[新预注册](CONPTY_RUNTIME_ENV_PLAN.zh-CN.md)在同一原 30 秒内由宿主先接收实际环境 O 观察，再仅在父/实际值有效非空且不同的情况下投递 V 赋值验证与普通两查询；固定 ABBA 最多四个 fresh worker。父参考来自 worker 启动器，spawn 白名单不变；control 赋回实际值，parent 只改当前 child 的 Process 变量，二者读写 API 相同。缺失/空值/相同为 contrast-absent 非通过，非法与读写异常分别保留固定原因及 null/false 区别，不查询或追加样本。

新 31 键 schema、Node 专项 96/96、全 native 471/471 与 Node/方案/workflow 独立审查已完成，Rust 最终独立审查通过：77/77 为审查修正前结果，修正后定向脚本与序列化各 1/1、真实 JSON→Node 13/13、check/clippy/fmt/Windows cfg 通过，未重称最终全套。首推 Rust/Node `0221864`/`ae796f5` 使用 `[skip ci]`，新 workflow 第二推准确 HEAD `fa2a09ba9d7bbda5a0cae55dc8168a6c0729ca97` 的唯一 [push 运行 40166224227](https://github.com/mofyer/new-windterm/actions/runs/40166224227) 已 `completed/success`，两平台准备/Cargo 与 8/8 worker 完整通过，工件独立核验，详见[执行记录](RESULTS.zh-CN.md#conpty-运行时环境有限干预工作流-40166224227)。八样本均父/实际值有效非空、Ordinal 不同、assignmentVerified=true、frameCount=8、cwd 正确、exit 0、未请求 kill、cleanup true；parent 替换后 q1 仍 11405.0151–22985.8476 ms，未消除首次慢路径，不能将更慢的首 control 与后续样本差异当稳定效果。该结果削弱单变量替换足以修复的解释，不全面排除 PSModulePath 交互。2025 首 control host 29669.0781 ms 符合原 30 秒，wall 31907.8537 ms 属启动+host+清理总量，仍受原 45 秒 worker 上限；没有放宽门禁。下一步候选是真实 ConPTY 精确发现/显式导入阶段对照，当前未预注册/实施，不以 stdio 替代或相减归因。产品白名单与普通查询保持，ConPTY 合流不证明独立 stderr 为空；P1/第四批未验收，P2 仅准备，main 不合并。

## 有限诊断通过：ConPTY 准备阶段对照 `40167503032`

[新预注册](CONPTY_PHASE_PLAN.zh-CN.md)固定 D/I/I/D 四 worker 上限，精确 Get-Command 与显式 Import-Module 各完成固定身份验证后，再执行原两普通查询；准备及校验计入 prepMs，所有阶段共用原 30 秒 host 窗口。27 键报告严格区分 T 成功、F/identity 的 false 和 F/command 的 null，失败不进入后续查询。Node 88/88、全 native 559/559 与 Node/方案/workflow 独立审查通过，Rust 82/82、check/clippy/fmt/Windows cfg 与最终独立审查通过，真实报告跨 Node 8/8；Rust/Node 首推 `afbacd4`/`8564ebd` 使用 `[skip ci]`，新 workflow 第二推准确 HEAD `f616d18185a32f58b1aab400d15f7fe80938e7dd`，唯一 [push 运行 40167503032](https://github.com/mofyer/new-windterm/actions/runs/40167503032) 已 `completed/success`，准确 SHA 下仅此一条 push；两平台准备/Cargo 与 8/8 worker 完整通过，工件独立核验，见[执行记录](RESULTS.zh-CN.md#conpty-准备阶段对照工作流-40167503032)。

八样本均 identityOk=true、frameCount=8、cwd 正确、exit 0、未请求 kill、cleanup true；D 准备 11847.4912–29484.9300 ms，I 准备 24.4259–38.1349 ms，准备后 q1 为 1.7095–13.5463 ms、q2 为 0.1563–0.2610 ms。本轮无同提交的无准备控制，旧 stdio 仅为跨层线索；两种准备都影响查询状态，不称纯组件时间、作差值归因或称产品冷查询改善。2025 首 D host=29878.5284 ms 符合原 30 秒，wall=31800.6866 ms 仍受原 45 秒 worker 门限；启动/退出/job 硬限保持，缺样本不补跑。下一步候选为当前树有限原生验收刷新，历史已知原生同症；[既有入口](../../.github/workflows/p0-cross-platform.yml)的 native_only 实际双平台各 7 场景，本轮未预注册/执行，不自动追加样本或泛增诊断矩阵。产品白名单、普通查询不改，显式导入未加入产品。ConPTY 合流不证明独立 stderr 为空，P1/第四批未验收，P2 仅准备，main 不合并。

## 历史矩阵停止条件与后续取证边界

原先约定的包含 `9be5c39` 复测已执行，未知 stderr 阻塞仍未解除；后续受控取证继续保留以下边界：

1. 每个 Windows 版本仍只执行预先列出的有限矩阵和正反向两轮；不因慢样本临时增加重试，不改变 60 秒 stdio、30 秒 ConPTY 或精确 cwd 断言。
2. 任一样本出现未知 stderr、非零退出、marker timeout、输出解析失败或清理失败，立即记录该样本的有界摘要和阶段，整条诊断保持失败；不继续扩展变量组合，也不修改产品白名单来“修复”实验。
3. 若一轮已完成但仍有未知 stderr，停止把 stderr 当作已分类证据；下一步只能先改进不留原文的分类取证，再开新的受控运行。不得用重复运行把未知流稀释为通过。
4. 只有在有限矩阵完整结束、无未知 stderr、无超时且两平台结果可复核时，才进入真实 WebView/ConPTY 的候选环境复现；这仍只是根因定位门槛，不是第四批合并批准。

工件索引优先引用工作流的 `summary.json`、测量 JSON、fixture `report.json` 和独立审计报告。上述 JSON 不包含 stderr 原文；ConPTY `probe.log` 同时含编译日志和路径，不满足脱敏报告边界，不能宣称整个 artifact 已脱敏或将其作为脱敏报告采用。本索引仅引用其中固定 PASS/FAIL 测量行的计数，本轮已为后续运行加入单独的内容受限 ConPTY 报告，本轮 Windows 上传报告已核对，不能据此改写历史工件的隐私限制。当前证据仍支持“环境差异与慢路径相关、根因未定”，不支持产品修复、第四批验收或 main 合并结论。
