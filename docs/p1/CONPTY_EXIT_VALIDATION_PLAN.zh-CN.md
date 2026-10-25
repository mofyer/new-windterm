# ConPTY startup-only 退出时序修复的 Windows 验证预注册

本方案承接失败运行 [`39833719372`](https://github.com/mofyer/new-windterm/actions/runs/39833719372) 与[离线验证](CONPTY_OFFLINE_VALIDATION.zh-CN.md)。历史 Windows 2022 样本在严格 READY 识别处超时，Windows 2025 样本在启动完成后出现退出异常；它们不是已确定的同一根因。`5eed885` 仅修复 startup-only 诊断的输入端关闭时序，离线同一生命周期 fixture 恢复旧顺序即失败、修复后通过。本轮在真实 Windows 上有限检查该修订，不追认历史失败、不修改旧预注册。

## 固定实现与范围

- 基点为 `27697b03c1e4d5f3bfe822174958600b761a280a`，包含已审查的 `5eed885` 修复和 `d85ed99` 共享 fixture。Rust 文件 SHA-256 为 `6c2733be2edfe49da7639d751b025a52d76d55ed28e2e2c00cbc82949c54c05b`。本轮不改 Rust、wrapper、schema、解析器或产品；准确被测 SHA 为本方案与 workflow 一同集成后触发运行的提交，运行结束后另记结果。
- Windows Server 2022/2025 每平台最多两个同构 fresh worker，顺序编号 1、2。任何样本失败立即停止该平台；不重试、不补足样本、不加环境组、查询或反向 arm。
- 固定 Windows PowerShell 5.1、产品环境白名单、`-NoLogo -NoProfile`、真实交互 ConPTY、默认 progress 与自动加载。仅运行 `--startup-only`；不执行 `Get-Location`、`Get-Command`、`Import-Module` 或缓存变量对照。
- CPR 与 READY 仍共用原 5 秒启动窗口，从 spawn 完成及 I/O 建立后计时。严格合法行首 READY 与实际 READY write/flush ACK 均在原 deadline 前确认才记启动完成；嵌入完整 READY 仅分类，不放行。此前 setup/进程创建仍受 45 秒 worker 总窗保护。
- 成功启动后的 `exit 0` write/flush ACK 与子进程退出共用原 500 ms 优雅退出窗口，期间保留输入 sender；退出被观察或有界终止回退之后才关闭输入。写入未确认仍失败，未退出仍走原有终止回退，非零退出不通过。清理内部 4.5 秒、外部等待 5 秒、Node 终止清理 2 秒不变；不为取得成功增加等待。
- 保持 ConPTY 合流 256 KiB、解析行 16 KiB、单 worker JSON 4096 字节；超限、未知协议、非零退出或清理失败均首停。

## 固定报告与判断

沿用[启动分类预注册的 schema 1 与 21 键定义](CONPTY_STARTUP_PLAN.zh-CN.md#可辨识性与隐私)，不新增退出 ACK 输出字段。退出写入确认是本轮内部实现约束，`readyWriteCompleted` / `readyWriteMs` 仍只描述 READY 写入，不能当成 `exit 0` 的测量值。`startupComplete` 与 `complete` 分开，完整成功还需尾部协议、exit 0 与清理成功；报告 `startupSuccess`、`experimentComplete`、`diagnosticPassed` 分别保留既有聚合规则。

| 本轮可观察结果 | 允许结论与停止条件 |
| --- | --- |
| 在严格 READY 前失败 | 如实记录阶段、原因、写入与有限计数；成功启动后的退出修复路径未完成验证，不将其视为退出修复无效或通过 |
| 启动完成，随后退出/清理失败 | 保留 `startupComplete=true` 与失败的 `complete`，记录非零退出及清理字段；不把它称为启动超时，也不猜测终止来源 |
| 单样本完整成功 | 只证明该样本的启动、退出与清理完成；如后一例失败，保留首错与部分成功，不补样本 |
| 两平台各两样本完整成功 | 只说明本次有限 startup-only 诊断通过；不能由四样本确定历史根因、一般故障率、目录查询性能或产品验收 |

写入字段、strict/embedded READY 计数在 startup 结束冻结，阶段/原因/终端计数沿用首错快照，最终合流字节可覆盖更晚窗口，不能混成同一时点。`killRequested=false` 只排除该字段记录的显式 kill，不证明没有其他清理或系统影响。缺失/无效工件保持未验证，不拼接历史运行或不同 SHA 的样本作完整对照。

## 执行与工件

前序离线证据已具备：本机 Rust 31/31、native helper 237/237、xterm 15/15、定向 TypeScript、Rust check/clippy/fmt、Windows cfg 检查及独立审查通过。这些不是本轮 Windows 实跑，本轮也不因纯方案/workflow 标签改动而重复全部离线测试。

本方案与既有 startup workflow 的步骤标签/注释调整作为同一提交集成，独立审查后只推送 `p1/integration` 一次；该提交仅改这两文件，匹配 startup workflow 自身路径，不命中旧 qualified 诊断路径。实际命令、矩阵、权限、固定 action/toolchain、输出与时间预算均不变。采用准确 SHA 最先创建的一次 push 运行；若出现重复调度，取消后创建运行，并分别检查其是否已采样，不合并证据。不得再手动 dispatch、重跑 job 或更改方案追求通过。

两平台均先执行 Node helpers，再运行同一 bin 的 Rust 专项测试与构建，测试/构建共用 14 分钟、每 job 20 分钟；失败也保留初始或已确认的报告。唯一上传文件为 `.artifacts/p1/powershell-conpty-startup/report.json`。终端/构建原文、nonce、路径、环境值、控制参数或动态错误消息不写工件；ConPTY 合流不能证明独立 stderr 为空。报告须独立核对准确 SHA/run、schema/隐私、顺序/首停、聚合/清理状态与文件指纹后写入结果文档。

本轮不修改原生普通查询、首次/重开、中文空格 cwd、版本与退出断言，也不放宽原 30 秒查询或 stderr 门禁。P1/第四批仍未验收，P2 仅准备，main 不合并。后续 READY 行边界方案与缓存变量诊断分别评估，不在本轮临时加入。
