# Windows PowerShell 诊断结果索引

本文只索引已经完成的诊断结果，并把下一次复测的停止条件写成预先约定。它不把测试侧取证增强或计划中的复测写成产品验证结果。

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

## 复测停止条件与后续取证边界

原先约定的包含 `9be5c39` 复测已执行，未知 stderr 阻塞仍未解除；后续受控取证继续保留以下边界：

1. 每个 Windows 版本仍只执行预先列出的有限矩阵和正反向两轮；不因慢样本临时增加重试，不改变 60 秒 stdio、30 秒 ConPTY 或精确 cwd 断言。
2. 任一样本出现未知 stderr、非零退出、marker timeout、输出解析失败或清理失败，立即记录该样本的有界摘要和阶段，整条诊断保持失败；不继续扩展变量组合，也不修改产品白名单来“修复”实验。
3. 若一轮已完成但仍有未知 stderr，停止把 stderr 当作已分类证据；下一步只能先改进不留原文的分类取证，再开新的受控运行。不得用重复运行把未知流稀释为通过。
4. 只有在有限矩阵完整结束、无未知 stderr、无超时且两平台结果可复核时，才进入真实 WebView/ConPTY 的候选环境复现；这仍只是根因定位门槛，不是第四批合并批准。

工件索引优先引用工作流的 `summary.json`、测量 JSON、fixture `report.json` 和独立审计报告。上述 JSON 不包含 stderr 原文；ConPTY `probe.log` 同时含编译日志和路径，不满足脱敏报告边界，不能宣称整个 artifact 已脱敏或将其作为脱敏报告采用。本索引仅引用其中固定 PASS/FAIL 测量行的计数，后续应单独输出内容受限的 ConPTY 摘要。当前证据仍支持“环境差异与慢路径相关、根因未定”，不支持产品修复、第四批验收或 main 合并结论。
