# ConPTY READY frame 独立实验预注册

本实验只验证新 `--startup-framed` 模式能否在 Windows ConPTY 中观察到可靠的 READY 输出事件，并完成有界退出。它不运行目录查询，不评价首次查询性能，不证明产品验收，不改变 P1 未验收及 P2 仅准备的状态。本轮不修改产品环境白名单或 30 秒原生查询路径。旧 `--sample`（schema 2）和 `--startup-only`（schema 1）的接受规则与报告保留。

## 协议与输入顺序

新模式使用连续字节流中的 nonce 绑定 frame：`~B<nonce>|R|5.1.<build>.<revision>|E<nonce>~`。nonce 为本次进程独立生成的 32 位小写十六进制 UUID，build/revision 各为 1–10 位十进制数字。完整 frame 最长 97 个 ASCII 字节。输入脚本将 nonce 分为两段，并在 PowerShell 中拼接 begin/end；实际脚本源码及其回显均不包含完整 nonce 或完整 frame token。离线测试覆盖实际脚本回显的所有切分点与逐字节输入。nonce 仅用于排除陈旧输出及生成脚本的字面回显，不能认证已经知道 nonce 且主动生成完整 frame 的进程。

只有收到完整、独立的 `ESC [ 6 n` CPR 请求后，宿主先把 CPR 回复放入单一 FIFO writer，再把 READY 脚本入队，入队成功后才 arm frame parser。arm 前出现完整 frame 为 `unexpected-frame`。启动成功要求完整 frame 与 READY write/flush ACK 都在同一个原始 5 秒启动窗口内确认；收到 frame 不等于写入已确认。时间窗口不会因 CPR、脚本入队或 frame 到达而重置。

这是输出事件协议，不依赖 LF、提示符位置、终端可视行或“独占行”。连续字节在窄屏产生的隐式换行可接受；frame 内实际出现 CR/LF、ESC、其他控制字节或非 ASCII 字符则拒绝。新模式没有旧模式的 16 KiB 行缓冲语义；旧模式仍保留该限制。frame 候选只保存有限匹配状态；版本数字有上述长度上限。增量 UTF-8 解码最多暂存 4 字节，非法序列和 EOF 截断拒绝；CSI 参数/中间字节及 ESC 中间序列上限为 64 字节；总输出上限仍为 256 KiB。OSC/DCS/SOS/PM/APC 内容不提供 frame 或 CPR，使用有限状态扫描且受总输出预算限制，EOF 未闭合拒绝。只支持 parser 明确识别的 7-bit 控制序列，C1 控制拒绝。完整 frame 后继续检查重复 frame、残缺候选、残缺控制序列和读取错误，包括 cleanup 阶段。

## 退出与预算

复用已修复的启动退出路径：`exit 0` 写入/flush ACK 与 child exit 共享原始 500 ms，输入句柄保持到 child exit 被观察或有界 kill fallback 完成。cleanup 内部上限 4.5 秒、外层确认上限 5 秒、worker 外层 45 秒；不会把 kill 请求成功当成 child 已退出。构建与测试共享 14 分钟，job 20 分钟，所有 Cargo 调用使用 `--locked --all-features`。旧流程的接受语义与预算保持不变。

## 固定报告与失败口径

worker 新报告为 schema 1、mode `startup-framed`，严格且仅有 19 个键：

`schema, mode, startupMs, wallMs, versionOk, exitCode, cprReplies, mergedBytes, startupComplete, complete, cleanupOk, failure, expectedStage, protocolReason, killRequested, exitObservedBeforeKill, readyWriteCompleted, readyWriteMs, frameCount`。

`versionOk` 与 `frameCount` 在启动等待返回时冻结；`frameCount` 为 0 或 1，表示已接受的完整 frame 数。后续 cleanup 重复 frame 可以导致失败而保留 `frameCount=1`。`readyWriteCompleted/readyWriteMs` 只指 READY write/flush ACK，不指 exit ACK。`expectedStage` 仅为 `not-started/await-cursor/await-frame/after-frame`；首个错误连同当时宿主阶段冻结，后续 cleanup 不覆盖。setup 阶段没有输出、CPR、frame 或写入确认。

parser 原因只允许 `invalid-frame/frame-control/incomplete-frame/duplicate-frame/unexpected-frame/unsupported-control/incomplete-control/invalid-utf8/escape-limit/output-limit`；宿主原因只允许 `setup-error/startup-timeout/read-error/write-error/command-error/exit-error/cleanup-failed/eof-before-complete/late-cpr`。Node 校验精确键、有限原因、类型、计数、时间、退出和成功关系，拒绝旧 schema、未知字段、重复键、stderr、额外记录和残缺 JSON。首错停止平台后续 worker。完整诊断成功要求两个 worker 均 startupComplete、exitCode=0、cleanupOk、complete 且外层进程正常；仅 startupSuccess 不足以通过。

工件只保存固定结构和有限枚举，不保存 nonce、脚本、原始终端字节、环境值、路径、版本全文或控制序列参数；不增加旧模式的 strict/embedded 行计数到新 schema。ConPTY 输出合流，不能声称 PowerShell stderr 独立为空。

## 一次 Windows 验证与停止条件

先完成 parser、实际脚本回显、宿主顺序/ACK/cleanup、Node 精确 schema 的离线测试和独立审查，再由协调者决定是否执行一次新模式实验。本文件不是已经执行或通过的证据。

仅对同一个事先冻结的完整 SHA，在 `windows-2022` 和 `windows-2025` 各最多运行两个顺序 worker；平台首错即停，不替换失败样本，不通过反复重跑凑成功。workflow matrix 的 fail-fast=false 只让另一个平台独立完成预注册样本。只上传 `.artifacts/p1/powershell-conpty-framed/report.json`。首次结果如失败，保留错误及缺失证据，下一步单独立项，不原地放宽接受标准。

发布分两步：实现、测试和本计划以 `[skip ci]` 提交；新 workflow 单独提交，只有新 workflow 路径触发本实验，避免同一 bin 变更触发旧诊断。协调者记录最终完整 SHA、run URL、平台结果和工件审查；实施代理不自行 push 或执行 Windows。旧实验失败证据仍保留，任何新模式成功均不倒推旧行协议已通过。
