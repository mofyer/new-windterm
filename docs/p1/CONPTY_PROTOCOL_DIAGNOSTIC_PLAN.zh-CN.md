# ConPTY 协议失败可辨识性诊断预注册

本方案是旧运行 `39824348485` 失败后的新一轮有限诊断，不修改[旧限定命令预注册](CONPTY_QUALIFIED_PLAN.zh-CN.md)或其判定。旧结果仅有 Windows 2022 一条未限定命令成功记录，随后限定命令协议失败；Windows 2025 首个未限定命令超时，完整对照未完成。本轮只增加阶段/原因分类、有限终端计数和清理时序字段，帮助区分诊断停止的位置；没有修复解析器，也未确定慢路径或协议失败根因。

## 固定实验与不变门禁

- 复用现有 qualified workflow 与独立 Rust dev-tools worker。Windows Server 2022/2025 每平台最多四个新进程，固定顺序 `unqualified → module-qualified → module-qualified → unqualified`，对应两 arm 正反两轮。每进程两次查询，第二次已被第一次预热，不追加重试或变体。
- 固定 Windows PowerShell 5.1、产品白名单、`-NoLogo -NoProfile`、默认 progress 与自动模块加载，不添加 `Get-Command` / `Import-Module` 预热，不改产品或原生验收查询。
- 同一 5 秒启动窗口先完整 CPR 请求、响应 FIFO 入队，再 READY；两个查询共用 30 秒命令窗口，Rust 清理 5 秒、Node worker 45 秒、Node 终止清理 2 秒。ConPTY 合流 256 KiB、单行 16 KiB、worker JSON 4096 字节上限保持。
- 现有协议匹配、CR/CSI 处理、有效 RESULT 条件、版本/cwd 校验和完成规则不变。任一异常、协议/容量/超时/清理失败立即停止该平台，不用新字段豁免旧失败。
- ConPTY 合流不能独立证明 stderr 为空；`experimentComplete`、`commandSuccess` 与 `diagnosticPassed` 分开，诊断通过不等于产品验收。

## 新字段与隐私边界

Rust worker 改用 schema 2，在原有有限结果上增加固定阶段、固定协议原因、终端控制计数以及 `killRequested` / `exitObservedBeforeKill`。wrapper 严格核验固定键集、枚举、数值上限及阶段与已验证查询前缀的一致性；拒绝把 schema 1 历史记录作为本轮新记录，历史报告与结论原样保留。

- `expectedStage` 仅允许 `not-started`、`await-cursor`、`await-ready`、`await-start-1`、`await-result-1`、`await-start-2`、`await-result-2`、`await-end`、`after-end`。它表示宿主等待阶段，不是 PowerShell 内部执行位置；例如旧解析器可在等待完整 CPR 的同一数据块里先看见 READY，所以 `await-cursor` 不要求 `versionOk=false`。
- `protocolReason` 仅允许 null 或 `setup-error`、`startup-timeout`、`command-timeout`、`output-limit`、`line-limit`、`escape-limit`、`invalid-utf8`、`unexpected-record`、`invalid-version`、`invalid-number`、`timing-bound`、`cwd-mismatch`、`command-error`、`incomplete-marker`、`eof-before-complete`、`read-error`、`write-error`、`exit-error`、`cleanup-failed`、`late-cpr`。`late-cpr` 包括清理尾部 CPR 或 CPR 数量超过 65536；`setup-error` 也可来自最后临时目录删除失败，不能据名称断言发生在启动前。
- `terminalCounters` 只含 `cr`、`lf`、`csiCursor`、`csiErase`、`markerLines`、`duplicateMarkers`、`embeddedMarkerLines`、`ignoredLines`，各为 0–262144 的饱和整数。CR/LF 计已消费的原始字节，包括 OSC 等控制序列内部，不代表屏幕换行；`csiCursor` 只计完整 CSI 的 final byte 属于集合 `ABCDEFGHfade` 加反引号的情况，`csiErase` 只计 J/K，均不是所有光标/清屏行为。
- 行计数沿用现有 LF 消费规则：`markerLines` 计以固定 nonce 前缀开头的行（含无效记录）；`duplicateMarkers` 计重复的已识别 READY、START 1/2、RESULT 1/2、END、ERROR 类别；`ignoredLines` 计不以该前缀开头的非空行，`embeddedMarkerLines` 计其中仍包含此前缀的行。计数不保存 nonce 或任何行内容。

首次可确认失败冻结阶段、原因和这些计数；成功则为 `after-end`、null 原因与最终计数。若未收到 cleanup 线程结果，保留进入清理前最后可确认快照：已有首错不覆盖，否则以该入口阶段/计数配 `cleanup-failed`。因此不能无条件称为超时瞬间的全量状态。最终 `failure` 可被清理失败覆盖，但 `protocolReason` 仍保留此前首错。`mergedBytes` 保持原有最终输出量语义，和首错终端计数不一定覆盖同一时间窗口。

新增信息仅为允许列表中的枚举、布尔值与有界计数。不包含原文、控制序列参数、屏幕文本、命令回显、路径、环境值、错误消息或动态标签；未知字段/值或矛盾状态立即停止。计数用于描述解析器看见的控制类别，不能复原终端内容，也不能单独证明某类控制序列造成失败。

`killRequested` 描述 Rust 清理实际是否调用 kill；`exitObservedBeforeKill` 来自调用前的退出查询，true 为已退出、false 为仍存活、null 为查询失败。未创建子进程或 cleanup 线程未返回时，两者均为 null，表示调用历史未确认，不能断言未发起终止；此组合仅允许 `not-started` 或 `cleanupOk=false`。`not-started` 必须为 `setup-error`、零终端计数且没有已验证版本/查询。允许的非空组合为 false/true、true/true、true/false、true/null；true/true 保留失败分支原有 kill 策略，仅新增退出观测。它们用于避免把清理产生的 exit 1 当成脚本自行失败，不证明所有后代已退出，也不能替代原有 cleanup 检查。没有完整合法 RESULT 时 q 仍为 null，新增分类不能补造查询耗时或证明查询未执行。

## 执行前验证与一次运行

先为拆分控制序列、CR/LF、光标移动、清行、正常协议和错误前缀增加有限终端布局 fixture，验证新增字段与原判定一致；这不等于真实 Windows 原始输出复现。先完成 Rust/Node 专项测试、Windows cfg 检查与独立审查，再执行本轮一次运行。

Cargo 注册不变，本轮修改既有新 bin/wrapper，由现有 workflow 的 push 路径直接触发；不使用旧轮的两次推送注册策略，也不再手动 dispatch 同一提交。只采用该准确 HEAD 的单一运行证据；如发生重复调度，保留最先创建运行并取消重复运行，分别核验是否进入采样，不合并证据，不将调度异常当作追加样本许可。

现有 workflow 在各平台先运行 Node helper，再在内存消费新 bin 的 Windows Rust 测试/构建输出，成功后才开始样本。测试/构建共享 14 分钟预算，每 job 20 分钟；唯一上传文件仍为 `.artifacts/p1/powershell-conpty-qualified/report.json`，不上传原始构建或终端日志。失败也保存已验证前缀，缺失工件不能当通过。

## 允许的结论与后续停止

本轮最多说明失败发生在何种预期阶段、对应固定原因和有限控制类别、退出是否先于清理请求。即使新字段指向 CR/CSI 或布局问题，也须结合 fixture 与独立审查，不能据此宣称解析已修复、限定命令更快或产品根因已定。先解释诊断失败，再另行预注册需要改变解析行为的实验；本轮不临时修解析、放宽协议或重跑到通过。

原生验收中的普通 `Get-Location`、首次/重开、中文空格 cwd、版本、退出与原 30 秒断言保持；不以限定命令替换旧查询。旧失败证据不回填，P1/第四批未验收，P2 仅准备，main 不合并。
