# 真实 ConPTY 限定模块命令对照预注册

本文固定本轮执行前设计，不含运行结果，不修改[stdio 阶段诊断方案](POWERSHELL_PHASE_PLAN.zh-CN.md)或其失败判断。此前观察到精确命令发现较慢、显式 Management 模块导入较快；本轮只检查真实交互 ConPTY 中未限定命令与模块限定命令的有限差异，不直接修改产品。

## 固定条件与两个 arm

- Windows PowerShell 5.1、真实交互 ConPTY，固定路径为 `SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`，参数为 `-NoLogo -NoProfile`，不使用 `-NonInteractive` 或 `-EncodedCommand`。固定既有产品白名单八项，不添加父 `PSModulePath` 或其他变量，不修改产品代码与环境策略。
- 保留默认 progress、自动模块加载及交互行为。不执行 `Import-Module`、`Get-Command` 或其他 cmdlet 预热；仅使用协议、身份/目录检查和计时所需的内建状态与 .NET 操作。
- 每平台两个 arm、正反两轮，共四个新进程；首轮未限定命令在先，次轮反序。每个新进程执行两次对应查询，分别记录内部耗时；第二次查询已被第一次预热。
- `unqualified` 执行两次 `(Get-Location).Path`；`module-qualified` 执行两次 `(Microsoft.PowerShell.Management\Get-Location).Path`。
- 模块限定名称指定命令来源，仍可能触发模块自动导入，不代表完全绕过发现、加载或初始化。PowerShell 5.1 官方[模块限定名称规则](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence?view=powershell-5.1#use-module-qualified-names)与[命令名称解析规则](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence?view=powershell-5.1#cmdlet-name-resolution)支持这一边界；限定与未限定的差异不能直接命名为某一内部组件成本，更不能推出产品修复。
- 新进程不清空系统缓存，正反两轮不能排除机器缓存、宿主负载或顺序影响，不能声称统计因果已证明。

## 期限、协议与失败停止

启动协议期限固定 5 秒；两次查询与所需命令协议共享 30 秒总窗口，不为第二次查询重置；Rust 清理期限为 5 秒。ConPTY 合流输出上限为 256 KiB，单行解析上限 16 KiB；超限字节计数最多保留到上限加一个 4096 字节读取块，不保留原文。Node 按固定正反顺序启动四个独立 `powershell_conpty_qualified_probe --sample <arm>` worker，每个最多 45 秒，覆盖 ConPTY 创建、进程 spawn、启动协议、命令和 Rust 清理。任一身份/cwd/协议错误、非预期退出、超时、容量或清理失败立即停止该平台剩余样本，不追加重试或变体。

同一 5 秒启动窗口内，先完整解析 ConPTY 的 `ESC[6n` 光标位置请求（允许跨读取块拆分），将 `ESC[1;1R` 响应成功加入 writer FIFO 后才投递 READY 脚本，保证响应先于 shell 输入；期限不重置。没有完整 CPR 请求、响应无法入队或未取得有效 READY 都使样本失败并停止平台；等待 CPR/READY 超时固定记为 `startup-timeout`，不降级跳过握手。

Rust 若无法确认子进程清理，先输出固定 `cleanup-failed` 记录并保持 worker 存活，以保留可由父进程终止的进程树根。Node 收到该记录立即请求该 worker PID 的 Windows tree kill，不等待 45 秒；未知 worker 协议、流错误、输出超限或 worker 超时同样触发有界终止。Node 终止清理最多 2 秒，分别记录 tree kill 请求结果、是否观察到 child close、是否释放本地管道，不能只因 taskkill 退出成功就声称 child close 已观察到。

协议只接受固定版本、阶段与完成标记，命令回显不得冒充完成记录。严格确认 PowerShell 5.1 身份，每次查询 cwd 在内存精确核对；两个 arm 的命令表达式固定，不运行额外命令发现来确认来源。首个失败保留固定原因与已验证的有限前缀，不把部分结果算完整样本。没有 command-not-found 特例。

`q1Ms` / `q2Ms` 只计内部 `(命令).Path` 操作，cwd 校验、协议输出在计时后；只保留已完整验证的 query 结果。`startupMs` 从 PowerShell spawn 完成及 I/O 线程启动后开始，到完整 READY / PowerShell 5.1 协议确认，不包含 ConPTY 分配或 spawn。`hostMs` 从构造/投递两个查询的脚本前开始，到完整 END 协议确认，包含 writer 队列、传输与执行。`wallMs` 为 Rust worker 从样本开始到退出清理完成的总耗时，包含 ConPTY 分配、spawn 与清理；Node 45 秒上限另覆盖整个 worker 进程。协议读写、启动、交互调度与清理不混称为 cmdlet 内部耗时；两个内部计时相加不等于 host/wall，也不能与 stdio 数据直接拼成同一门禁。

## 合流限制与验收边界

ConPTY 将终端输出合流，本实验只能观察合流中的协议和有界结构，不能独立测量 stderr，更不能把未观察到错误文本写成 stderr 为空。完整四样本、命令成功和诊断检查通过必须分别表述；任何诊断通过都不关闭旧 stdio 非空 stderr 失败、历史 ConPTY 超时或真实 WebView2 故障。

不会保存终端原文、命令回显、错误文本、路径、环境值或编译输出。每个 worker 只允许输出一行固定 schema JSON（最多 4096 字节），worker 自身的 stderr 必须为空；这只检查 Rust worker 外层协议，不能据此推断 ConPTY 内 PowerShell stderr 为空。未知字段、未知枚举、非法数值、重复记录或错误输出通道立即失败，保存已验证的有限样本前缀。报告仅保留固定 arm/轮次/阶段、有限计时、状态及固定失败原因；构建与子进程错误在内存消费，未知输出不透传到报告或 runner 日志，不能因为脱敏而忽略失败。

最终报告分别包含 `experimentComplete`、`commandSuccess`、`diagnosticPassed`；收齐四个有效完整样本、命令全部成功和 wrapper/清理/协议检查全部通过分别判断。`stderrObservedSeparately=false` 与 `outputMode=conpty-merged` 始终保留，诊断通过不是产品验收，也不覆盖旧独立 stderr 门禁。每个样本后保存更新；构建、测试或 worker 失败也保留固定失败报告，不仅在全成功后写文件。

## 工作流与后续判断

独立 [workflow](../../.github/workflows/p1-windows-conpty-qualified-diagnostic.yml) 在 Windows Server 2022/2025 使用固定 Rust 1.99.0、Node 26.0.0 与既有 action 提交 SHA；`fail-fast: false`、每 job 20 分钟。先运行全部 native Node helper，再由 `conpty-qualified-report.mjs` 在内存消费输出，依次执行新 dev-tools bin 的 `cargo test --locked`、`cargo build --locked`（均显式 `--target x86_64-pc-windows-msvc`、独立 target-dir），成功后才运行该精确新构建的 exe。Rust 测试/构建共享 14 分钟总预算，输出合计各限 4 MiB，不运行全 Rust suite。Windows 的专项编译及测试独立于 macOS 本地结果，不能互相替代。

唯一上传文件为 `.artifacts/p1/powershell-conpty-qualified/report.json`，通过 `always()` 上传；不上传 target-dir、原始编译或探针日志。缺失报告使上传步骤失败，不能把缺失样本记为通过。

本轮不改变旧矩阵文件或旧探针。新 Cargo bin 注册涉及的 manifest 会匹配旧工作流，因此采用两个提交/推送、一次实测：全部实现审查通过后，先将 Rust、Cargo、wrapper、测试与本预注册文档以 `[skip ci]` 提交并推送；再单独提交新 workflow 并推送，仅触发本轮新工作流。准确被测 HEAD 是第二个提交，不能把第一个提交冒称本次被测 HEAD；不再手动 dispatch 重复运行。

新 workflow 的 push 限定 `p1/integration`，路径只包括自身、新 Rust bin、新 wrapper 与其测试，不包含 Cargo manifest 或旧矩阵文件。之后 Cargo 或依赖变化如需复测，应先明确预注册范围，再人工 dispatch 对应 ref；不会因无关 manifest 更新自动重复实验。

结果只允许支持或削弱“未限定发现/自动加载与模块限定路径不同”的候选解释。即便限定命令更快，仍须区分指定模块解析、自动导入、缓存等候选机制；不从两轮样本确定具体模块扫描或网络原因。若下一步需要新干预，先预注册并独立审查，不事后修改本轮条件。P1 与第四批尚未通过，P2 仅准备，main 不合并。
