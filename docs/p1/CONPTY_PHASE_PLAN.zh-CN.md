# 真实 ConPTY 命令准备阶段对照预注册

本轮在既有 framed 查询及运行时环境干预之后，独立观察真实交互 ConPTY 中精确命令发现与显式 Management 模块导入的准备阶段，以及各自随后两次普通目录查询。既有 stdio `39819222771` 的约 21–23 秒精确发现、44–59 ms 显式导入仅为跨层线索，不能作为本轮 ConPTY 的测量或对照样本。运行时恢复父 `PSModulePath` 未消除慢路径，本轮不继续添加环境 arm，不修改产品白名单、普通查询或原生验收门禁。

## 固定条件与两个 arm

每个平台 `windows-2022/windows-2025` 最多四个 fresh Windows PowerShell 5.1 worker，顺序固定为 **discover-query、import-query、import-query、discover-query**（D/I/I/D）。每 worker 一次对应准备操作，再两次原普通 `(Get-Location).Path`；首个准备、身份、协议、查询、退出或清理失败即停止该平台，无重试、补样本或额外变体。spawn 保留原八项产品白名单，不加入父 `PSModulePath`，不抑制默认 progress，不修改模块自动加载偏好。准备前仅运行必要协议、计时与内建/.NET 操作，不执行额外 cmdlet 预热。

准备操作及身份规则复用 `tests/native/powershell-phase-probe.mjs:25–40` 的语义，输出对象仅留内存：

- D：`Get-Command -Name Get-Location -CommandType Cmdlet -ErrorAction Stop`，数组结果必须恰好一个 `System.Management.Automation.CmdletInfo`，大小写敏感 Name 为 `Get-Location`、ModuleName 为 `Microsoft.PowerShell.Management`。
- I：`Import-Module -Name Microsoft.PowerShell.Management -PassThru -ErrorAction Stop`，结果必须恰好一个 `System.Management.Automation.PSModuleInfo`，大小写敏感 Name 为 `Microsoft.PowerShell.Management`，ExportedCommands 包含 `Get-Location`；对应导出项必须为 `CmdletInfo`，Name/ModuleName 同上。

身份错误固定为 `identity-mismatch`，操作异常为 `command-error`，均不继续查询，不增加 command-not-found 特例。两次普通查询仍在内存中将 cwd 与预设目录做 Ordinal 精确核对；不输出目录或编码路径。

精确发现可能自动导入/初始化模块，显式导入也可能包含发现、查找、加载和初始化；两 arm 都会改变后续查询状态。因此准备后 q1 已是经过该准备的查询，不是未经准备的首次调用。新进程不清机器缓存，D/I/I/D 不能排除顺序、缓存或宿主负载影响。本轮没有同提交的无准备 arm，不将以前不同 run 的普通查询当配对控制；不把准备耗时叫“纯发现”“纯导入”，不通过阶段或 arm 相减推导内部组件成本。

## 同一 30 秒窗口与准备计时

新 CLI 为 `--phase-framed discover-query|import-query`，mode=`phase-framed`；旧 CLI、模式、报告和失败判定不变。完整 CPR 后回复先入 writer FIFO，READY 脚本投递后 arm；READY frame 与实际 write/flush ACK 均必须在原同一 5 秒启动窗口内确认。

启动双确认成功后，从准备/查询脚本构造与投递前起算原 **30 秒 host 总窗口**。准备操作、身份校验、协议、writer 排队、传输以及后面两次普通查询全部共用此 deadline；不为准备结束、任何 frame 或第二次查询重置期限。准备 Stopwatch 包含固定准备操作及其身份校验，身份验证通过后停止计时，再输出 T 成功帧；查询 Stopwatch 仍只计 `(Get-Location).Path`，cwd 校验与协议输出在计时后。操作异常或身份错误都不保存成功 prepMs，不继续后续查询。

prepMs、q1Ms、q2Ms 用 F4 毫秒，只接受 1–5 位整数、恰好四位小数，无负数/指数/NaN/Infinity。Rust 与 Node 都按 1/10000 ms 整数刻度校验各项及已接受前缀总和不超过 30000 ms；成功 host 必须严格小于 30000 ms。宿主 startup/write/host/wall 保持原 f64。null 仅表示没有接受的成功记录，不是 0 ms，也不能从 command-timeout 或缺失 T 推断具体内部操作已执行多少时间。

成功 END 后由宿主发送 `exit 0`，write/flush ACK 与 child exit 共享原 500 ms，输入保留到退出观测或有界终止；cleanup 内部 4.5 秒、外层 5 秒，worker 外层 45 秒。wall 包含 ConPTY 创建、启动、host 与清理，不与 30 秒查询 host 窗口混用。首错冻结合法前缀；cleanup 继续验证尾部，不能补写准备/查询成功或用 kill 请求替代退出观测。

## 独立帧、阶段与报告

复用严格 nonce envelope `~B<32hex nonce>|payload|E<same nonce>~` 及有界 WireDecoder；生成脚本中 nonce/token 拆分，字面回显不能构成完整合法 frame。nonce 只排除陈旧输出/字面回显，不认证已知 nonce 的主动伪造进程。opaque 控制字符串不提供帧/CPR，frame 中真实控制字符拒绝。256 KiB wire 总上限、64 字节 escape、4 字节 UTF-8 缓冲、候选额外 84 字节硬限保持；不新增旧模式的 16 KiB 行语义。

成功顺序为 **R、P、T、S1、Q1、S2、Q2、D**，成功进度 count 为 0–8。R/S/Q/D 沿用 framed 查询语法；新 P 为准备开始，T payload 为 `T|<F4ms>|1`。T 只有在准备及身份校验成功后接受，count=3，prepMs 非 null、identityOk=true。`F|identity` 只在 await-prep-result，失败为 identity-mismatch，count 仍 2、identityOk=false、prepMs=null；`F|command` 同阶段失败 command-error，count 仍 2、identityOk/prepMs 均 null。查询错误仍用对应 X/command 或 X/cwd，不误归到准备错误。旧 mode 不接受新 P/T/F 准备记录。

阶段/count：not-started/await-cursor/await-frame=0，after-ready/await-prep-start=1，await-prep-result=2，await-start-1=3，await-result-1=4，await-start-2=5，await-result-2=6，await-end=7，after-end=8。P 仅证明准备开始标记已到，不是准备操作或身份校验完成；count≥3 才能保存 prepMs/identityOk=true，q1/cwd1 在 count≥5，q2/cwd2 在 count≥7。F 错误、超时或畸形只保留更早已接受前缀；complete 还须 END、退出、清理与外层进程全部正常。

worker schema 1 精确 **27 键**：

`schema, mode, arm, q1Ms, q2Ms, startupMs, hostMs, wallMs, versionOk, cwd1Ok, cwd2Ok, exitCode, cprReplies, mergedBytes, startupComplete, complete, cleanupOk, failure, expectedStage, protocolReason, killRequested, exitObservedBeforeKill, readyWriteCompleted, readyWriteMs, frameCount, prepMs, identityOk`。

新增 failure/reason 只有 `identity-mismatch`，其他沿用 framed 查询有限集合；身份字段为 bool/null，准备计时为有限 F4 数值/null。cleanup 未确认时 failure 可变为 cleanup-failed，但首 protocolReason 和前缀保持。Node 严格验证精确键、有限枚举、阶段/count/身份/cwd/计时/清理关系、4096 字节限制及 UTF-8；拒绝旧 mode/schema、私有字段、重复键、额外记录或 worker stderr。不保留 command/module 对象、列表、类型全文、路径、nonce、脚本、环境值或原始输出。

内层 mode=phase-framed，保留 `startupSuccess/experimentComplete/commandSuccess/diagnosticPassed` 四聚合。四个预定样本缺一不可通过；准备成功、身份通过或部分查询不能代替完整实验。每样本保存一次更新后判断首错，不拼接其他提交或运行的样本。ConPTY 合流不能证明 PowerShell 独立 stderr 为空，worker 外层 JSON/stderr 门禁与其分开。

## 准备、预算及唯一执行

新 Node 入口复用既有 prepared runner 注入，只固定转换外层 mode=phase-framed-prepared；旧准备实现与默认行为不改。fresh dist 检查、安全固定 npm CLI、真实 npm ci/TypeScript/Vite 构建与 `--logs-max=0` 保持，两个准备步骤共享 180 秒；不通过占位资产或删 feature 绕过前置条件。

Cargo test/build 保留 `--locked --all-features` 和独立 target-dir，共享 14 分钟；四 worker 各 45 秒。准备 3 分钟+Cargo 14 分钟+worker 3 分钟已等于 job 20 分钟硬限，尚不含 checkout/helper/工具链/调度与终止清理开销；不承诺最慢组合完成。缺样本、取消或缺工件保留未完成，不加时重跑。

先冻结 Rust/Node 合同，完成实际 emitter 防回显、操作/身份规则、异常后不查询、F4 总和、分块/乱序/畸形/首错前缀、宿主 ACK/共用期限/清理、真实 Rust JSON→Node 合成样本及独立审查。实现、测试、本计划先 `[skip ci]` 推送，再仅新 workflow 单独提交推送；触发路径只有新 workflow/Node wrapper/test，避免旧实验同时运行。准确被测 HEAD 是第二推；两平台各执行一次预注册 D/I/I/D 上限实验，无额外 dispatch、retry 或补样本。

唯一工件 `.artifacts/p1/powershell-conpty-phase/report.json` 保留固定准备进程、嵌套诊断与有限 worker 报告；编译/npm/终端原文只在有界 runner 内存消费，不落日志或工件。平台报告需独立核验准确 SHA/run、固定结构/隐私、顺序、首停、计时/状态/聚合、清理和文件 hash。历史失败不重判；产品白名单、原生普通查询、首次/重开、中文空格 cwd 和独立 stderr 门禁保持。P1/第四批未验收，P2 仅准备，main 不合并。
