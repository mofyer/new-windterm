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

## 历史矩阵停止条件与后续取证边界

原先约定的包含 `9be5c39` 复测已执行，未知 stderr 阻塞仍未解除；后续受控取证继续保留以下边界：

1. 每个 Windows 版本仍只执行预先列出的有限矩阵和正反向两轮；不因慢样本临时增加重试，不改变 60 秒 stdio、30 秒 ConPTY 或精确 cwd 断言。
2. 任一样本出现未知 stderr、非零退出、marker timeout、输出解析失败或清理失败，立即记录该样本的有界摘要和阶段，整条诊断保持失败；不继续扩展变量组合，也不修改产品白名单来“修复”实验。
3. 若一轮已完成但仍有未知 stderr，停止把 stderr 当作已分类证据；下一步只能先改进不留原文的分类取证，再开新的受控运行。不得用重复运行把未知流稀释为通过。
4. 只有在有限矩阵完整结束、无未知 stderr、无超时且两平台结果可复核时，才进入真实 WebView/ConPTY 的候选环境复现；这仍只是根因定位门槛，不是第四批合并批准。

工件索引优先引用工作流的 `summary.json`、测量 JSON、fixture `report.json` 和独立审计报告。上述 JSON 不包含 stderr 原文；ConPTY `probe.log` 同时含编译日志和路径，不满足脱敏报告边界，不能宣称整个 artifact 已脱敏或将其作为脱敏报告采用。本索引仅引用其中固定 PASS/FAIL 测量行的计数，本轮已为后续运行加入单独的内容受限 ConPTY 报告，本轮 Windows 上传报告已核对，不能据此改写历史工件的隐私限制。当前证据仍支持“环境差异与慢路径相关、根因未定”，不支持产品修复、第四批验收或 main 合并结论。
