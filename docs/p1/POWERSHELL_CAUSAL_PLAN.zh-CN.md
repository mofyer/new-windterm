# PowerShell 首次目录查询：有限因果对照预注册

本文定义执行前固定的实验与判断边界，不包含本轮测量结果。既有证据见 [P1 执行记录](RESULTS.zh-CN.md)和 [stderr 诊断索引](STDERR_DIAGNOSTIC_INDEX.zh-CN.md)。本实验仅针对 Windows PowerShell 的 stdio / `-EncodedCommand` 探针，不能替代 ConPTY 或真实 WebView2 验收。

## 问题与固定条件

已观察到产品白名单环境下首次 `Get-Location` 较慢，以及 stderr 中有限 CLIXML 结构的 progress 标记；两者的因果关系尚未确定。本轮分别改变目录读取方式、显式进度产生、进度显示偏好和模块自动加载偏好，收集足以区分部分候选解释的有限证据，不预设结果。

- 所有样本都使用既有 `productEnvironment` 生成的同一产品白名单：`SystemRoot`、`PATH`、`ComSpec`、`USERPROFILE`、`TEMP`、`TMP`、`APPDATA`、`LOCALAPPDATA`；不添加父 `PSModulePath` 或其他环境变量，不修改产品白名单。
- 固定 Windows PowerShell 路径、参数、临时工作目录和协议，并严格确认 PowerShell 5.1 版本身份。每个 arm、每轮都是新进程，不在同一 PowerShell 会话里串联多个 arm。
- Windows Server 2022 和 2025 独立执行。每平台固定五个 arm、两轮：首轮正序，次轮反序，最多十个样本，不追加重试或临时变体。
- 被测操作前只允许协议与计时所需的 .NET / PowerShell 内建状态访问，不执行 cmdlet、`Get-Command`、`Import-Module` 或其他预热。各 arm 的偏好变量赋值属于预注册干预。
- 新进程与反序不能消除系统级缓存、runner 镜像差异或宿主机负载；两个平台也不能当成同一运行条件的重复样本。

## 五个 arm

| 顺序 / arm ID | 操作 | 用途与限制 |
| --- | --- | --- |
| 1 / `direct-location` | 直接读取 `$ExecutionContext.SessionState.Path.CurrentLocation.Path` | 不调用 `Get-Location` 的目录读取参照；与 cmdlet 路径语义不同，不据此直接归因模块加载。 |
| 2 / `progress-only` | 固定参数的两次 `Write-Progress`，随后直接读取 SessionState 目录 | 为显式进度命令建立有界结构与计时参照；该命令本身可能涉及命令发现、模块加载与初始化，不能把耗时全归给输出，也不是纯序列化成本基准。 |
| 3 / `get-location` | 默认偏好的 `(Get-Location).Path` | 保留慢环境下待解释的基准操作。 |
| 4 / `progress-suppressed` | `$ProgressPreference = 'SilentlyContinue'` 后执行 `(Get-Location).Path` | 比较进度显示偏好变化；抑制显示不能证明底层工作没有执行，也不是产品修复或验收豁免。 |
| 5 / `autoload-disabled` | `$PSModuleAutoLoadingPreference = 'None'` 后执行 `(Get-Location).Path` | 比较禁止自动模块导入的行为；若命令不存在，作为非可比的类型化观察，不计算成功查询耗时。 |

每个成功的目录操作必须精确匹配该进程预设 cwd；不会将路径保存到工件。校准固定执行 `Write-Progress -Activity 'P1_CAUSAL_FIXED' -Status 'P1_CAUSAL_FIXED' -PercentComplete 50`，再执行 `Write-Progress -Activity 'P1_CAUSAL_FIXED' -Completed`，随后直接读取 SessionState 目录。其 `elapsedMs` 包含这两次调用与目录读取；固定内容不包含环境值、机器身份或目录。其他 arm 的 `elapsedMs` 只覆盖对应目录读取。偏好赋值在计时前；`elapsedMs` 是脚本内部 Stopwatch 区间，不是完整进程启动耗时，更不是 WebView2 / ConPTY 延迟。

另记录 `wallMilliseconds`：使用父进程单调时钟，从 spawn 前到 close / 清理结束的样本总耗时。该值包含启动、协议与清理等工作，不等同于内部操作耗时；即使结果为 command-not-found，仍保留此样本总耗时，但不能把它当作成功目录查询耗时。

上述干预按 PowerShell 5.1 官方语义解释：[ProgressPreference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-5.1#progresspreference) 的 `SilentlyContinue` 仍执行操作，只抑制进度显示；[PSModuleAutoLoadingPreference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-5.1#psmoduleautoloadingpreference) 默认 `All`，`None` 禁止自动导入，不卸载已加载模块；[Write-Progress](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/write-progress?view=powershell-5.1) 属于 Utility 模块。因此 `None` 下仍成功不能排除模块已加载，显式进度校准也可能经历模块解析与初始化。

## 有界执行与停止规则

入口为 `node tests/native/powershell-causal-probe.mjs`。单样本进程期限为 60 秒；清理命令最多 5 秒，终止后的 close 等待总窗口最多 6 秒（两者并发计时）；stdout 与 stderr 各最多保留 16 KiB。越界即终止采集并进行有界清理。

遇到以下任一情况，保存已完成样本和固定停止原因，停止该平台剩余样本，不追加重试：

- 超时、启动失败、进程清理失败或无法确认关闭；
- stdout 协议损坏、标记缺失、非预期退出码或 cwd 不匹配；
- 输出字节、解析结构或其他固定容量上限触发；
- stderr 不符合允许采集的完整结构：只允许空流或受限 CLIXML 中仅含 progress 标记的结构；未知文本、其他流、非法结构和截断均停止。

只有自动加载禁用 arm 中被异常类型确认的 command-not-found 可以作为特殊观察继续下一样本：按官方 [typed catch](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_try_catch_finally?view=powershell-5.1#using-multiple-catch-statements) 方式捕获 `System.Management.Automation.CommandNotFoundException`，脚本退出码为 2，`observationComplete=true`、`measurementComplete=false`、`elapsedMs` 与 cwd 结果均为 `null`，不可加入成功查询的快慢比较；保留的 `wallMilliseconds` 仅描述失败观察的样本总耗时。该观察不能标成查询成功或验收通过。不能仅按错误文本、退出码或“不耗时”推断这种结果。

完整且仅含 progress 的受限 CLIXML 可继续收集后续样本，但任何非空 stderr 仍令严格判断失败；结构允许采集不代表其内容无害或已解释来源。现有 unknown 分类、旧 stdio / ConPTY 时限与验收断言均不改变。

## 完整采集与验收分开

唯一上传文件为 `.artifacts/p1/powershell-causal/measurements.json`，顶层汇总 `experimentComplete`、`strictPassed` 和 `stopReason`，并包含有限样本记录。仅保留固定 arm 名、计数、计时、布尔值、固定失败原因、stderr 形状/指纹与受限结构计数；不保存 stdout/stderr 原文、错误文本、路径或环境值。

- `experimentComplete=true`：十个预注册样本均已取得允许的观察；不等于十次查询成功。
- `strictPassed=true`：独立严格条件满足；非空 stderr 或 command-not-found 观察均不能通过此判断。探针严格判断失败时退出非零。
- 即使独立探针严格通过，也不代表旧诊断、Windows 产品场景、第四批或 P1 通过；本实验没有覆盖产品链路。

工作流 [p1-windows-causal-diagnostic.yml](../../.github/workflows/p1-windows-causal-diagnostic.yml) 固定两平台、`fail-fast: false`、每 job 20 分钟。先运行 `node --test tests/native/*.test.mjs`，再执行探针；无论探针成败均尝试上传上述精确文件。它不编译 Rust，也不重跑旧八环境矩阵。缺失报告使上传步骤失败，不把缺失样本当成通过。

触发方式为 `workflow_dispatch` 加严格限定的 `push`：仅 `p1/integration` 分支且变更本工作流、`powershell-causal-probe.mjs` 或对应 `.test.mjs` 三个文件之一时自动运行，不包括文档或既有诊断文件。[GitHub 官方触发规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch) 对尚未运行且未出现在默认分支的新工作流有注册限制，因此首次使用该最小 push 触发，不为注册而合并 main 或改变默认分支。本轮 push 后不再手动 dispatch 同一提交；首次运行后可按官方规则通过 CLI/API 指定 ref 复用，但新的测量仍需保持预注册范围。

## 结果解读与后续边界

预先只允许以下程度的判断：同平台同轮中不同 arm 的差异可以支持或削弱候选解释；跨轮反序用于观察顺序敏感性，两个样本不足以建立统计证明。`SilentlyContinue` 改变流量但耗时保持，只能削弱“可见进度输出本身解释全部时延”；若耗时改变，仅支持进度处理可能参与，不证明模块加载因果。禁用自动加载后命令不存在，只能说明该操作在该状态下不可用，不能比较命令执行耗时；禁用后仍成功且耗时改变，也不能单凭两个样本确定具体模块或内部阶段。

显式 `Write-Progress` 与真实目录查询出现相同流类型，并不能证明真实进度的文本、来源或工作负载相同。没有内部阶段证据时，不宣布模块自动加载、progress、`PSModulePath` 或某个环境变量为根因。后续若需新的 arm、重试或放宽采集允许结构，先更新实验设计并独立审查，不能为获得绿色结果临时改变规则。

本轮完成后按准确提交、运行 ID、平台分别记录结果；保持代码提交、Windows 实测、独立审查与产品验收的区别。第四批 main 合并仍需单独授权。
