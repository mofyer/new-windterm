# ConPTY 运行时 PSModulePath 有限干预预注册

本轮在 `40164795306` 的 framed 查询证据基础上，仅检查 PowerShell 启动后实际进程 `PSModulePath` 与 worker 启动器环境中的父参考值是否存在可用差异，并在确有差异时比较保留原值与替换父参考值的有限效果。历史多轮 ConPTY 在 spawn 前加回父值仍慢，不能把本轮称为首次加回父变量，也不重跑该旧矩阵。本轮不修改产品或 spawn 的八项白名单，不替换普通 `(Get-Location).Path`，不使用模块限定查询作为修复。

## 条件、顺序与解释边界

每平台 `windows-2022/windows-2025` 最多四个 fresh PowerShell worker，顺序固定为 **control、parent、parent、control**（ABBA）。两 arm 都先从子进程读取同一变量，经宿主门控后使用相同 `.NET Environment.SetEnvironmentVariable` Process API 写入并回读验证：control 赋回观察到的原值，parent 只将当前 PowerShell child 的该变量替换为 worker 启动器中的父参考值。它不是读取整个父环境，也不修改 Node、Rust worker、系统或用户级变量。赋值后的两次查询均为原普通查询，精确 cwd 仍在 PowerShell 内用 Ordinal 校验。

报告 `environment=spawn-product-whitelist` 只说明 spawn 时八项白名单；parent arm 的查询时环境含上述受控运行时替换，不能表述为整个执行过程的环境未变。父参考值只代表本 worker 的启动器 Process 环境，不等于 PowerShell 启动后的实际值。即使 parent arm 更快，也只能支持替换整个变量在本组有限样本中的效果，不能定位某个路径段、模块扫描、缓存、网络或历史故障根因，更不是产品修复或完整性能验收。

父值必须存在、非空、合法 Unicode、无 NUL 且不超过 4096 UTF-16 code units。缺失或空值在 spawn 前返回 `contrast-absent`；非法或过长返回 `environment-invalid`，均为未通过，且不启动 PowerShell。报告仅保留 `parentPresent/parentUsable`，不保留原值、长度、路径片段或哈希。

PowerShell 的实际值也必须存在、非空、合法且在同一容量上限内，并与父参考值按 Ordinal 不同，才可进入干预。实际缺失/空值或与父值相同，返回 `contrast-absent`，不赋值、不查询；非法或过长返回 `environment-invalid`。缺失和空值不作为可用干预，避免 Windows/.NET 将空串写入转成删除而改变 control 语义。对比条件缺失不是成功或性能改善，任一此类结果停止该平台剩余 worker，不补样本或另跑观测轮。

## 两段脚本与单一查询窗口

新 CLI 为 `--runtime-env-framed control|parent`，mode 为 `runtime-env-framed`，旧 CLI、协议、默认行为与历史结果保持。READY 使用原 nonce frame 与 writer ACK，二者仍须在同一个 5 秒窗口确认；完整 CPR 回复先入 FIFO，再投递 READY 脚本。

启动双确认后，从构造第一段观察脚本前开始原 **30 秒 host 总窗口**。第一段只用 .NET 读取实际进程值，输出 O 观察帧；宿主完整接受 O 且确认实际/父值均有效非空、Ordinal 不同后，才构造并投递第二段赋值/回读/两查询脚本。第二段投递成功才 arm assignment；不能仅凭预先在 shell 中写了条件分支视为宿主门控。两个脚本构造、排队、传输、执行、所有协议等待与两次查询都共享原 deadline，O、V 或第二次查询均不重置期限。父/实际字符串及脚本只在内存保留，不打印到诊断日志或工件。

第二段先用相同 Process API 写入各 arm 的目标值，再用存在性与 Ordinal 回读验证。V 成功后才进入两次普通查询；验证 false 或赋值/回读异常均不查询。计时仍只覆盖每次 `(Get-Location).Path`，不包含观察、赋值和协议开销；host 覆盖全部这些开销。q 用 F4 毫秒，以 1/10000 ms 整数刻度验证单次和两次合计不超过 30000，成功 host 严格小于 30000 ms。第二次查询可能预热，不与首次混称；null q 只表示没有被接受的成功测量，不能当作零耗时或具体内部阶段超时。

END 后由宿主发送 `exit 0`，沿用 ACK+child exit 共享 500 ms、输入保持到退出观测或有界终止的路径。cleanup 内部 4.5 秒、外层 5 秒；worker 外层 45 秒。失败保留首错和合法前缀；cleanup 扫尾不能补写成功。ConPTY wire 总上限 256 KiB、escape 上限 64 字节、UTF-8 增量缓冲 4 字节、候选额外硬限 84 字节保持；nonce frame 不依赖 LF/可视行，frame 中实际控制字符拒绝，opaque 字符串不提供帧或 CPR。旧模式 16 KiB 行规则不移植到本模式。

## 帧与固定报告

成功顺序为 **R、O、V、S1、Q1、S2、Q2、D**，成功进度 count 为 0–8，复用 `~B<32hex nonce>|payload|E<same nonce>~`。R/S/Q/D 与原查询模式语法一致，新增 O、V、E 只在新模式接受：

- O payload 为 `O|p|n|v|e`。canonical 组合仅 missing=`0|0|1|x`、empty=`1|0|1|x`、invalid/oversize=`1|1|0|x`、合法非空=`1|1|1|0` 或 `1|1|1|1`；e 的 0/1 为 Ordinal 比较结果，x 表示不可比较。完整 O 计入 count 2，表示观察记录完整，不表示值可用于干预。
- V payload 为 `V|0` 或 `V|1`。V1 接受后 count 3；V0 不增加成功 count，保存 `assignmentVerified=false`，在 await-assignment/count 2 失败 `assignment-failed`。
- `E|read` 仅在 await-observation/count 1，失败为 `environment-read-error`，实际值三字段均 null；`E|assign` 仅在 await-assignment/count 2，失败 `assignment-failed` 且 `assignmentVerified=null`，与明确 V0 的 false 区分。查询已开始后的错误沿用对应查询 X/command 或 X/cwd，不能误归类为赋值异常。

worker schema 1，精确 **31 键**：

`schema, mode, arm, q1Ms, q2Ms, startupMs, hostMs, wallMs, versionOk, cwd1Ok, cwd2Ok, exitCode, cprReplies, mergedBytes, startupComplete, complete, cleanupOk, failure, expectedStage, protocolReason, killRequested, exitObservedBeforeKill, readyWriteCompleted, readyWriteMs, frameCount, parentPresent, parentUsable, effectivePresent, effectiveNonempty, effectiveEqualsParent, assignmentVerified`。

前两个 parent 字段始终为 bool；其余四个环境字段为 bool 或 null。实际三字段在完整 O 前为 null，O 后映射上述 canonical 组合；assignmentVerified 在 V 前为 null，V0 为 false，V1 为 true。stage/count：not-started/await-cursor/await-frame=0，after-ready/await-observation=1，after-observation/await-assignment=2，await-start-1=3，await-result-1=4，await-start-2=5，await-result-2=6，await-end=7，after-end=8。q1/cwd1 成功只在 count≥5，q2/cwd2 只在 count≥7；count≥3 必须存在有效差异且 assignmentVerified=true。after-observation/count 2 的无对比值失败不得进入赋值或查询。

新增有限 failure/reason 仅 `contrast-absent/environment-invalid/environment-read-error/assignment-failed`，其余沿用 framed 查询的固定集合。cleanup 未确认可将 failure 提升为 cleanup-failed，但 protocolReason 与有限前缀保留首错。Node 严格验证键、类型、枚举、阶段、计数、三态布尔关系、计时/cwd/清理一致性；拒绝原始字段、旧 mode/schema、重复键、额外记录、非法 UTF-8、stderr 或超过 4096 字节的报告。worker 外层 stderr 空不代表 ConPTY 内 PowerShell stderr 空。

内层保留 `startupSuccess/experimentComplete/commandSuccess/diagnosticPassed` 四聚合。四个预定样本缺一不可通过；对比不存在时也保存失败样本但不增加后续 worker。准备成功、启动成功、观察成功、赋值成功、查询成功与最终退出/清理分别判断，不能互相替代。

## 准备、预算与唯一验证

新 Node 入口复用既有 prepared runner 注入，只固定转换外层 mode 为 `runtime-env-framed-prepared`；旧准备层无修改。fresh dist 检查、固定安全 npm CLI、真实 `npm ci`/TypeScript/Vite build、`--logs-max=0`、准备共 180 秒均保持。准备失败不进入 Cargo/worker；无占位文件或 feature 缩减。

Cargo test/build 使用 `--locked --all-features`，共享 14 分钟；四 worker 外层各 45 秒。准备 3 分钟 + Cargo 14 分钟 + worker 3 分钟已经等于 job 20 分钟硬限，尚未计 checkout/helper/工具链/调度/清理开销；不能保证最慢边界组合完成，不扩大 job 期限。缺样本、缺工件或取消都保留未完成结论，不加时重跑。

先冻结 Rust/Node 合同并完成真实 emitter 防回显、按块/乱序/错误帧、三态 bool、宿主两次门控与共用期限、退出扫尾、真实 Rust JSON→Node fixture 和独立审查。全部实现、测试和本预注册先 `[skip ci]` 推送，随后仅新 workflow 单独推送，触发路径只包括新 workflow/Node wrapper/测试。准确测试 SHA 为第二推；Windows 两平台各执行一次 ABBA 上限实验，首错停止，无额外 dispatch、retry 或补样本。

只上传 `.artifacts/p1/powershell-conpty-runtime-env/report.json`，不保存原始终端/编译/npm 输出、nonce、父或实际环境值、路径、脚本、控制参数。准备与进程失败只保留固定分类、退出码、字节数和清理状态。结果须独立下载核验准确 SHA/run、schema/状态/顺序/聚合、隐私与工件 hash。

本轮候选不改产品，不将实验通过当作原生首次/重开、中文空格 cwd 或独立 stderr 验收。P1/第四批未验收，P2 仅准备，main 不合并；历史失败不重判，不拼接其他提交样本。
