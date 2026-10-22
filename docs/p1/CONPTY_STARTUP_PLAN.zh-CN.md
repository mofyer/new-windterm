# ConPTY 启动写入与 READY 分类诊断预注册

本方案是协议分类运行 `39828696609` 之后的新一次有限诊断。上一轮两个失败样本均停在 `await-ready`，未投递查询脚本；本轮仅检查启动输入与 READY 识别，不执行 `Get-Location`，不评估目录查询或模块限定性能，不修改旧预注册与历史失败。

## 固定范围

- Windows Server 2022/2025 每平台最多两个同构 fresh worker，顺序编号 1、2；首失败立即停止该平台，无反序 arm、额外环境组、重试或追加样本。
- 仍使用固定 Windows PowerShell 5.1、产品环境白名单、`-NoLogo -NoProfile` 真实交互 ConPTY、默认 progress 与自动加载；无 `Get-Command` / `Import-Module` 或目录查询预热。
- CPR 与 READY 共用原 5 秒启动期限：完整 split-aware CPR 请求、响应 FIFO 入队，再投递 READY 脚本，不重置时钟、不延长窗口。严格合法行首 READY 才完成启动；嵌入完整 READY 形状仅计数，不设版本通过或放行。
- 启动成功后单独请求 `exit 0`，仍须验证进程退出与有界清理；这不是产品退出码验收。失败后按原策略终止子进程，exit 1 不能视为脚本自行失败。
- 保持 ConPTY 合流 256 KiB、解析单行 16 KiB、JSON 4096 字节与 Rust 清理 5 秒。Node 单 worker 总窗沿用 45 秒，另有有界终止清理 2 秒；原 5 秒启动计时从 spawn 完成及 I/O 建立后开始，不包含此前 setup/进程创建，它们在外层总窗保护内。超限/未知协议/非零退出/清理失败首停，不临时扩大预算。

## 可辨识性与隐私

使用现有 `powershell_conpty_qualified_probe` 的独立 `--startup-only` 模式与 schema 1，不改变旧 `--sample` 的 schema 2。固定 21 个键为 `schema`、`mode`、`startupMs`、`wallMs`、`versionOk`、`exitCode`、`cprReplies`、`mergedBytes`、`startupComplete`、`complete`、`cleanupOk`、`failure`、`expectedStage`、`protocolReason`、`terminalCounters`、`killRequested`、`exitObservedBeforeKill`、`readyWriteCompleted`、`readyWriteMs`、`strictReadyCount`、`embeddedReadyCount`；不包含 arm、查询/cwd/host 字段。

`readyWriteCompleted` / `readyWriteMs` 记录 READY 实际 `write_all` 与 `flush` 完成确认及相对原启动时钟的时点，明确区分入队与实际写入。false/null 表示冻结时未确认原窗口内实际写入完成，不证明实际未写。`readyWriteMs` 仅在 true 时为大于等于 0、小于 5000 ms 且不超过 `startupMs` 的有限值；超时分支可在冻结前读到迟到 ACK，只保留实际完成时点在原窗内的值，因此 true 不证明宿主在 5 秒内收到 ACK。严格 READY 可能先于 writer ACK 被宿主读取，所以严格 READY 不自动蕴含写入确认。`startupComplete` 则要求宿主在原 deadline 前确认严格 READY 与 ACK，且实际完成时点也在原窗内；它与上述写入字段、严格/嵌入计数在 startup 结束时冻结，清理中迟到事件不回填成功。`complete` 还需尾部协议、exit 0 与 cleanup 成功；后续失败可保留 `startupComplete=true`、`complete=false`。

`strictReadyCount` / `embeddedReadyCount` 为 0–262144 饱和整数。嵌入形状在沿用 ANSI 剥离后的 LF 终结行中，要求非零 offset 的本次 nonce 前缀加 `READY|5.1.a.b` 精确后缀，其中 a/b 各为 1–10 位 ASCII 数字；不允许尾随文本或额外字段。普通前缀命中不等于完整形状；分类不作为放行。`expectedStage` 仅为 `not-started`、`await-cursor`、`await-ready`、`after-ready`；`after-ready` 说明合法 READY 已接受，不保证写入 ACK 或整体成功。`failure` 仅允许 null、`setup-error`、`startup-timeout`、`output-limit`、`protocol-error`、`read-error`、`write-error`、`command-error`、`exit-error`、`cleanup-failed`；`protocolReason` 为 null 或对应具体原因（不使用粗 `protocol-error`），另含 `line-limit`、`escape-limit`、`invalid-utf8`、`unexpected-record`、`invalid-version`、`incomplete-marker`、`eof-before-complete`、`late-cpr`。

八项 `terminalCounters` 沿用[上一轮精确定义](CONPTY_PROTOCOL_DIAGNOSTIC_PLAN.zh-CN.md#新字段与隐私边界)，各为 0–262144 的饱和整数，stage/reason/counters 沿用首错快照；若启动成功后清理才发生首错，它们可覆盖比 startup 字段更晚的窗口。`startupMs` 失败时可略超 5000 ms，成功需小于 5000 ms；startup/wall 均不得超过外层 45000 ms，CPR 不超过 65536、最终合流字节不超过 256 KiB 加一个 4096 字节读块。清理字段保留 null 未确认及 true/true 等旧合法组合，不以新分类改变终止策略。

固定字段、枚举与计数上限由 wrapper 严格校验；未知字段/值、矛盾状态与不完整协议首停。原文、nonce、路径、环境值、控制序列参数、错误消息与构建日志只在内存消费，不写工件。首错阶段/计数快照与最终合流字节不保证同一窗口；cleanup 未返回时保留最后可确认快照，null 调用历史不等于未发起终止。ConPTY 合流不能证明独立 stderr 为空。

## 验证、触发与停止

执行前先通过 Node 严格 schema/首停/隐私测试、Rust synthetic fixture、Windows cfg 检查及独立审查。fixture 不是 Windows 原始输出复现；Windows cfg 也不是 Windows 实跑。各平台在实际采样前先运行 Rust 专项测试并构建同一 bin，测试/构建共享 14 分钟预算，job 20 分钟；失败也保留初始或已确认记录。

新 wrapper 复用旧 qualified 的有界 `runProcess`，独立编排至多两个 worker，初始及每步更新均写报告。报告分别记录 `experimentComplete`（两个 worker 完整）、`startupSuccess`（两个 startup 均完成）和 `diagnosticPassed`（全部协议/进程/清理检查通过），样本保留独立启动完成证据；任一平台首失败时不把部分成功当全轮成功。

使用独立 workflow，仅上传 `.artifacts/p1/powershell-conpty-startup/report.json`；不上传终端或构建原文。现有 Rust 文件命中旧 qualified workflow 的 push 路径，因此审查后先将实现、wrapper/tests 与本方案作为 `[skip ci]` 提交推送，新 workflow 暂不纳入；再单独提交新 workflow 并推送，只有第二提交触发本轮一次 startup 诊断。新 workflow push 仅匹配自身与新 wrapper/test，限定 `p1/integration`，不修改旧 workflow。核对准确第二提交 SHA 的最先创建运行；若额外调度出现，取消后者并独立核验是否采样，不能拼接证据。未经独立审查不推送运行，不额外手动 dispatch。

本轮最多区分写入是否在原窗口内完成、是否出现严格或嵌入完整 READY 形状及失败位置，不证明终端布局、机器负载或任何模块缓存为根因。模块分析缓存变量对照是独立后续候选，本轮不混入环境矩阵。保留原生普通查询、首次/重开、中文空格 cwd、版本、退出与 30 秒断言；P1/第四批未验收，P2 仅准备，main 不合并。
