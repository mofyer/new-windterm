# ConPTY framed 查询对照预注册

本轮在已独立验证的 READY frame 与真实前端构建准备之上，增加独立 `--sample-framed <arm>` 查询模式，测量固定产品白名单下普通与模块限定 `Get-Location` 的首次/第二次调用。启动 frame 通过不代表查询通过；本轮不是产品验收，不替换原生普通查询、首次/重开、中文空格 cwd 或原 30 秒门禁，不修改产品环境白名单。旧模式、历史失败与原预注册保持。

## 样本与因果边界

两个平台为 `windows-2022/windows-2025`。每个平台仅一次实验，最多四个 fresh PowerShell worker，固定顺序 **U、Q、Q、U**：第一轮 unqualified/module-qualified，第二轮 module-qualified/unqualified。每 worker 仅两次同 arm 查询，共用原 30 秒 host 窗口、不重置 deadline；每平台首个准备、构建、协议、查询、退出或清理失败即停止，不补样本、不 retry。

U 使用普通 `Get-Location`，Q 使用 `Microsoft.PowerShell.Management\Get-Location`；两 arm 的其他环境、cwd、启动脚本、期限和报告相同。内部计时仅覆盖各次目录查询，不以 worker wall 代替；第二次调用可能预热，分别记录，不与首次混合。首次独立进程受 runner 历史状态影响，四个样本只是有限顺序对照，不足以证明一般故障率、缓存/扫描/网络内部机制或历史慢路径根因。任何 null 查询只表示没有接受到完整合法成功记录，不能当作 0 ms 或性能改善。

## 新 frame 与计时合同

新模式复用 nonce 绑定连续字节 frame，不依赖 LF、终端列宽或屏幕独立行。实际输入脚本通过源码碎片拼接 nonce/token，字面回显不能生成完整 frame；nonce 排除陈旧输出和生成脚本回显，不认证已知 nonce 且主动生成 frame 的进程。opaque 控制字符串不提供 frame/CPR，真实插入 frame 的控制字符、错误版本、乱序/重复/缺尾均拒绝。

完整 envelope 为 `~B<32 位小写十六进制 nonce>|payload|E<同 nonce>~`。payload 只允许 `R|5.1.<1–10 位数字>.<1–10 位数字>`、`S|1`/`S|2`、`Q|1`/`Q|2` 后接 `<1–5 位整数>.<恰好 4 位小数>|1`、`D`，或当前查询对应的 `X|1`/`X|2` 后接 `command`/`cwd`。最后一类只在相应 await-result 阶段接受并记失败；Q 的 cwd 位必须为 1，实际 cwd 不符由脚本发 X/cwd。成功顺序为 READY、START1、QUERY1、START2、QUERY2、END，完整有效进度 `frameCount` 从 0 到 6；错误记录不增加成功计数。错误 cwd 不计入该次查询的成功值，保留更早合法前缀。首错冻结阶段、计数和查询结果，cleanup 仍检查尾部错误但不补写成功。只有完整 CPR 后回复先入 writer FIFO、READY 脚本入队成功后才 arm；合法 READY 与实际 write/flush ACK 必须在原同一个 5 秒窗口内确认。QUERY 脚本只在启动双确认成功后投递。

仅查询脚本的 q 数字采用固定四位小数 F4 毫秒，startup/host/READY write/wall 保持原宿主 f64 计时。查询数字不接受指数、负数、NaN、Infinity 或额外精度；单次和两次合计均不得超过 30000 ms。Rust 用 1/10000 ms 整数刻度验证，Node 对固定四位小数回读一致性校验后以 `Math.round(q * 10000)` 的整数和复核，避免二进制浮点相加误拒合法边界。成功 host 时间必须严格小于 30000 ms；失败时接近或略超期限的观测只表示轮询/调度，不能放宽 deadline。READY write 字段只描述 READY，不描述退出 ACK。

成功 END 后退出由宿主发出，不由查询脚本提前自行退出；沿用 `exit 0` write/flush ACK 与 child exit 共享原 500 ms、输入保留到退出观测或有界终止的路径。cleanup 内部 4.5 秒、外层 5 秒、每 worker 外层 45 秒不变，kill 请求成功不能替代退出确认。新 parser 共享 256 KiB wire 总预算、64 字节 escape 上限、4 字节 UTF-8 增量缓冲；begin 后候选额外硬限 84 字节，使任意候选 wire 小于 120 字节，合法 grammar 最长为 97 字节（READY；S 为 73、Q 最长 86、D 为 71、X/command 为 81、X/cwd 为 77）。旧模式的 16 KiB 行规则不移植到新模式。

## 固定报告与失败前缀

worker 为 schema 1、mode `query-framed`，精确 25 键：

`schema, mode, arm, q1Ms, q2Ms, startupMs, hostMs, wallMs, versionOk, cwd1Ok, cwd2Ok, exitCode, cprReplies, mergedBytes, startupComplete, complete, cleanupOk, failure, expectedStage, protocolReason, killRequested, exitObservedBeforeKill, readyWriteCompleted, readyWriteMs, frameCount`。

阶段/成功计数对应：not-started、await-cursor、await-frame 为 0；after-ready、await-start-1 为 1；await-result-1 为 2；await-start-2 为 3；await-result-2 为 4；await-end 为 5；after-end 为 6。`versionOk` 等价于已接受 READY；q1/cwd1 成功等价于至少 3 个有效 frame，q2/cwd2 等价于至少 5 个。READY 已到而 ACK 超时允许 count=1/startupComplete=false；查询入队失败允许 after-ready/count=1 且 hostMs 有值。完整 END 后 cleanup 失败可保留 count=6/两次查询前缀，但 complete 仍 false。

failure 仅 setup-error/startup-timeout/command-timeout/output-limit/protocol-error/read-error/write-error/command-error/cwd-mismatch/exit-error/cleanup-failed；protocolReason 除对应宿主原因外，仅允许 invalid-frame/frame-control/incomplete-frame/duplicate-frame/unexpected-frame/unsupported-control/incomplete-control/invalid-utf8/escape-limit/invalid-number/timing-bound/unexpected-record/duplicate-record/eof-before-complete/late-cpr。精确键、有限枚举、类型、计数、时间、cwd/进度/清理关系由 Node 强校验，拒绝旧 mode/schema、stderr、重复键、额外记录、非法 UTF-8、残缺或超过 4096 字节的 worker 报告。frame 字节与构建输出不保留。

内层汇总 mode=`query-framed`，分别保存 `startupSuccess`、`experimentComplete`、`commandSuccess`、`diagnosticPassed`，每次采样后更新再执行首错停止。四个预定启动都完成才 startupSuccess；四个完整记录/退出/清理都符合要求才实验和命令成功，外层 process/解析也正常才 diagnosticPassed。第四样本若查询或退出失败，可以 startupSuccess=true 但其余 false。未运行样本不填零、不从其他 run 拼接。

## 准备、预算与工件

新 Node 入口复用既有 prepared wrapper 的 runner 注入，只将固定外层 mode 映射为 `query-framed-prepared`，不修改旧默认行为或其准备实现。首次 onUpdate、后续更新和返回都使用同一新 mode。准备前拒绝已有 dist；只使用经固定位置/package/bin/canonical 检查的 npm-cli.js，由当前 Node 启动，无 shell/npm.cmd。真实 npm ci 与 tsc/Vite build 使用 `--logs-max=0`，共用 180 秒，生成非软链的真实非空 dist/index.html；准备失败不进入 Cargo/worker。原文只在有界进程 runner 内存计数并丢弃，不落 npm debug 日志。

Cargo test/build 保持 `--locked --all-features` 并共享 14 分钟；新查询 worker 外层各 45 秒。准备 3 分钟 + Cargo 14 分钟 + 四 worker 共 3 分钟的名义上限已经 **20 分钟**，不含 checkout/helper、工具链、调度和终止清理开销。job 仍硬限 20 分钟，不承诺最慢组合可完成；可能中止、缺样本或缺工件，必须保留未完成状态，不加时或补跑。

只上传 `.artifacts/p1/powershell-conpty-framed-query/report.json`：外层固定准备过程结果及完整内层诊断，禁止 raw stdout/stderr、nonce、脚本、路径、环境值或控制参数。ConPTY 合流不能证明 PowerShell 独立 stderr 为空。工件模式、schema、状态与隐私核验通过不等于诊断或产品通过。

## 审查与一次执行

先冻结 Rust/Node 合同与代码，完成实际 emitter 回显、顺序/畸形/分块/边界和生命周期 fixture，Node 精确 schema/计时/首停/准备复用测试，再独立审查。实现、测试和本计划先 `[skip ci]` 提交推送；仅新 query workflow 单独提交，触发路径仅其自身和新 wrapper/test，不触发旧实验。协调者核准唯一准确 SHA/run 后执行双平台一次并独立下载报告。实施代理不自行 push 或执行 Windows。

若再次遇到前置构建失败或新协议失败，本轮立即按既定规则保留结果，下一步另行局部取证；不原地降 feature、替换 cwd 查询、放宽门限或接受不完整 frame。P1/第四批未验收，P2 仅准备，main 不合并。
