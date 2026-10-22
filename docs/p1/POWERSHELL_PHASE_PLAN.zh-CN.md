# PowerShell 命令准备与首次查询：阶段诊断预注册

本文在执行前固定实验设计，不包含本轮结果，也不修改[上一轮因果对照方案](POWERSHELL_CAUSAL_PLAN.zh-CN.md)或其判定。已有结果见 [P1 执行记录](RESULTS.zh-CN.md#固定白名单的有限因果对照工作流-39816931188)。实验限于 Windows PowerShell 5.1 的 stdio / `-EncodedCommand`，不能替代 ConPTY、WebView2 或产品验收。

## 问题与固定条件

上一轮抑制 progress 后 stderr 归零，但首次目录查询仍慢。本轮只比较显式命令发现、显式模块导入与无准备操作之间的阶段耗时，观察慢区间是否随准备操作发生变化；不预设具体模块或内部组件为根因。

- 固定既有 `productEnvironment` 白名单：`SystemRoot`、`PATH`、`ComSpec`、`USERPROFILE`、`TEMP`、`TMP`、`APPDATA`、`LOCALAPPDATA`。不补入父 `PSModulePath` 或其他变量，不修改产品环境。
- 固定 Windows PowerShell 可执行路径、argv、工作目录与 PowerShell 5.1 身份检查。保留默认 progress 与模块自动加载偏好，不抑制 progress，不增加 command-not-found 特例。
- Windows Server 2022 和 2025 独立运行。每平台三个 arm、两轮，首轮正序、次轮反序，最多六个新进程，每 arm/轮独占新进程；不追加重试、变体或样本。
- 被测阶段前只允许协议、编码、计时所需的 .NET / PowerShell 内建状态访问。不运行未列入 arm 的 cmdlet、命令发现、模块导入或其他预热。
- 新进程不清空机器缓存，反序两轮也不足以建立统计结论；固定 runner 镜像不代表宿主负载与系统缓存完全相同。

## 三个 arm 与固定阶段

| 首轮顺序 / arm ID | 准备阶段 | 后续两个查询阶段 | 解释限制 |
| --- | --- | --- | --- |
| 1 / `cold-query` | 无 cmdlet 准备 | 连续两次 `(Get-Location).Path`，分别计时 | cold 只表示该进程未显式准备，不表示机器冷缓存；第二次查询已被第一次预热。 |
| 2 / `discover-query` | 精确执行 `Get-Command -Name Get-Location -CommandType Cmdlet`，结果只在内存验证，不输出对象 | 准备完成后连续两次 `(Get-Location).Path`，分别计时 | 精确命令发现可能触发模块自动加载与初始化；两个查询均属于准备后的预热查询。 |
| 3 / `import-query` | 执行 `Import-Module Microsoft.PowerShell.Management` | 准备完成后连续两次 `(Get-Location).Path`，分别计时 | 导入可能包含发现、文件查找、加载和初始化；两个查询均属于准备后的预热查询。 |

PowerShell 5.1 官方文档明确说明：[Get-Command](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-5.1) 使用无通配符的精确命令名可自动导入包含该命令的模块，相关导入可能加载类型/格式文件和运行脚本；`-CommandType Cmdlet` 只是限制命令类别，不使准备变成纯发现。[Import-Module](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/import-module?view=powershell-5.1) 将模块的导出成员加入当前会话。因此两个准备 arm 都是会改变后续查询状态的预热干预。

只比较完整的阶段观察，不用 arm 之间或阶段之间相减求“纯发现”“纯导入”或“纯初始化”成本。准备后查询变快只能支持相关工作可能在准备阶段发生，不足以区分准备内部的组件。发现和导入同时影响进程状态，因此这些 arm 并非只改变单一内部机制的实验。

## 计时、协议与有限记录

固定阶段序列为：`cold-query` 的 `query-1 → query-2`；`discover-query` 的 `discover → query-1 → query-2`；`import-query` 的 `import → query-1 → query-2`。协议先输出 `P1_PHASE_VERSION|5.1.x.y`，每个阶段前后分别为 `P1_PHASE_START|name` 与 `P1_PHASE_DONE|name|milliseconds|payload`，最后为 `P1_PHASE_COMPLETE`。阶段顺序、名称、数量和成功结束必须严格匹配 arm；版本身份不符、协议与普通输出混杂、重复或缺失标记、错误阶段顺序均为失败。

准备结果只在内存做固定名称与类型身份校验，协议 payload 仅允许 `identity-ok`；查询 payload 是 cwd 的 Base64 编码，仅在内存解码并精确匹配预设 cwd，不进入 JSON。每个报告阶段只有固定字段 `{phase, started, complete, elapsedMs, cwdMatches, identityMatches}`。已验证完成的阶段前缀可保留；未完成阶段的计时与身份/cwd 字段为 `null`。后续阶段一旦失败，整个样本的 `measurementComplete`、`observationComplete` 与 `strictPassed` 均为 false，并停止该平台。

各阶段操作使用脚本内部 Stopwatch 计时：准备阶段包括对应发现/导入操作及其固定身份校验；查询阶段只包括 `(Get-Location).Path`，不包含随后 Base64 编码与父进程 cwd 检查。所有阶段的协议写出均不计入阶段计时。`wallMilliseconds` 使用父进程单调时钟，从 spawn 前到 close / 清理结束，包含启动、协议和清理；阶段计时相加不等于 wall，不能替代进程总耗时，也不能代表 WebView2 / ConPTY 的端到端延迟。失败前观察到的固定阶段仅用于说明停止位置，不能把未结束阶段视为成功计时或从部分阶段推出完整 arm 成功。

每进程固定 60 秒上限，覆盖准备与两个查询的总过程，不为每阶段重置。stdout/stderr 各 16 KiB，超限立即终止。清理命令最多 5 秒，终止后的 close 等待总窗口最多 6 秒（两者并发计时）；不因等待子进程而无限延长，所有清理状态仅按实际观察记录。

## 停止条件与严格判断

任一启动/执行异常、非零退出、身份或 cwd 不匹配、协议失败、输出或结构超限、超时、清理失败及无法确认关闭，均停止该平台剩余样本，不重试。command-not-found 在本轮没有特殊继续规则；即使捕获为固定错误，也不得算完成观察或性能改善。

stderr 仅允许空流或完整的受限 CLIXML，且每个顶层记录都必须标为 progress、内部不得另挂流类型。未知文本、其他流、非法/未完成结构及截断均停止该平台。完整 progress-only 结构只允许继续有限采集，任何非空 stderr 仍使严格判断失败；允许采集不证明内容无害，也不改变旧诊断 unknown 分类。

`experimentComplete` 只表示六个预定样本完整、协议有效且目录匹配；`strictPassed` 还要求所有严格条件满足，非空 stderr 不能通过。严格失败时入口返回非零。独立探针完整或严格通过均不等于旧诊断、第四批或 P1 通过；旧失败证据保持。

## 工作流、工件与后续边界

新工作流 [p1-windows-phase-diagnostic.yml](../../.github/workflows/p1-windows-phase-diagnostic.yml) 只跑双 Windows 平台的 `node --test tests/native/*.test.mjs` 与 `node tests/native/powershell-phase-probe.mjs`，不编译 Rust、不重跑旧八环境矩阵或上一轮五 arm。固定 Node 26.0.0、既有 action 提交 SHA、`fail-fast: false` 和每 job 15 分钟上限。触发为 `workflow_dispatch` 加限定 `p1/integration` 的 push，路径只包括新工作流、`powershell-phase-probe.mjs` 及其 `.test.mjs` 三文件；首次 push 后不重复手动触发同一提交。

报告只保留固定 arm/阶段、计数、计时、布尔值、固定失败原因、stderr 形状/指纹与受限结构摘要。不保存命令对象、模块列表、stdout/stderr 原文、错误文本、路径或环境值。唯一工件为 `.artifacts/p1/powershell-phase/measurements.json`；workflow 通过 `always()` 始终尝试上传此精确文件，缺失工件使上传失败，不将缺失样本当成通过。

采集完成后按准确提交、运行 ID、平台和工件指纹记录结果。若出现未预注册的现象，先保留失败并独立审查新的实验设计，不能追加重试、放宽协议或事后修改本方案的通过条件。模块发现/加载/初始化仍需证据区分；保持产品白名单、既定协议与原生门禁，P1 未通过、P2 仅准备、main 不合并。
