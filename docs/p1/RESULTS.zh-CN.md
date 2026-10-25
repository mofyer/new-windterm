# P1 执行记录

## 2026-10-15：第一批启动

从已合并的 `a35582f` 创建 `p1/integration`，按[计划](PLAN.zh-CN.md)推进本地终端失败/退出/重新打开。前端与原生场景在独立 worktree 并行；本批是 A1/A2 的局部交付，没有声称 P1 或 T01/T34 全项通过。

沿用 `.github/workflows/p0-cross-platform.yml` 的已有跨平台门禁。文件名保留以减少无关变化，P1 在自己的分支手动触发；执行证据须记录实际提交和作业结果，不复用 P0 结果冒充新代码验证。

## 第一批实现与评审

- `bd44492`（来源 `937ebb8`）：启动失败进入终态，清空早期输入队列；初次 resize 与启动错误分离，晚到错误不覆盖退出/销毁状态；结束态提示不再发送输入。
- 已退出/启动失败的本地终端提供“重新打开”，创建新的标签、PTY 和输入队列，旧输出保留；同步切换活动标签避免连续点击重复创建，不自动重放旧输入。
- `f8eeba2`（来源 `598e7c9`）：新增原生 `local-terminal-reopen` 场景，真实独立输出行→exit 7→新标签输出→新旧输出隔离→旧退出状态保留→关闭两个标签。测试不把输入回显当作命令执行结果。
- CI 路径过滤新增 `tests/native/**`，让后续单改原生场景也会触发 main/PR 检查；现有 P1 集成分支用手动 dispatch。

独立 code-reviewer 对前端三文件、原生场景、CI 与阶段文档给出 APPROVE，无阻塞发现；两个低优先级 CLAUDE 旧阶段/Windows 证据指向问题已修正。审查采用 TypeScript、Node 语法和文件链接检查；没有可调用 LSP/AST 工具，不声称运行这些工具。

TDD：原实现上原 6 项契约通过，新增用例中 4 项失败，复现终态/提示及晚到错误问题；实现后 12 项契约全过。测试边界仍是 IPC stub。

## 集成验证

| 门禁 | 本轮结果 | 边界 |
| --- | --- | --- |
| 前端 TypeScript / Vite build | 通过 | 不代表原生运行 |
| Rust fmt / Clippy all targets、all features | 回收修复集成后通过 | 生产入口保留全局容量池 |
| Rust all targets、all features | 本机 211 passed / 0 failed / 33 ignored | 含容量及 Unix 资源释放回归；ignored 不算通过 |
| Windows wincheck | 通过 | 只做类型检查，不是运行 |
| Native runner helper | 15 passed / 0 failed | 不代表新增原生场景已执行 |
| 浏览器全套 | 376 passed / 0 failed（2.2 分钟） | IPC stub；含 12 项本地生命周期契约 |
| 真实 OpenSSH 夹具 | 11 passed / 0 failed / 0 skipped | 受控本机夹具 |
| macOS 原生退出/重开 | 单轮通过，见[专题记录](NATIVE_LIFECYCLE_2026-10-15.zh-CN.md) | CUA 真实 WKWebView；不覆盖失败注入、完整 IME/读屏/VT |
| 跨平台 CI 与新增原生场景 | 修复后的第四轮 7/7 作业通过；两平台原生 4/4 均通过 | 资源等待机制已修复；历史第二轮具体卡点无法追溯 |

本轮不改变默认 Shell、启动参数、凭据、协议或终端屏幕状态来源；功能台账保持原状态。用户「先修复，再合并」的条件授权已满足，实际合并另记于本文末尾。

## 首轮 CI 发现与修复

[首轮 CI](https://github.com/mofyer/new-windterm/actions/runs/38706436663) 被测提交为 `ed6501d`。Linux 原生作业的前三个场景通过，新增第四个场景在标签名称比较处失败：WebDriver `getText` 返回空串，同一失败工件的 DOM JSON 和截图却显示 Local 4、Local 5 两个标签及新 Shell 提示符。失败发生在新会话输出与旧会话回看之前，因此不能据此宣布第四场景通过。

`09a0362`（来源 `5ddaa49`）将标签读回改为 DOM `textContent`，断言非空、旧标签位置与名称保持、新标签名称不同且已选中。真实输出、双向隔离、旧退出码和关闭检查全部保留；独立 code-reviewer APPROVE，Node 语法、helper 15/15 和 diff 检查通过，原生运行待下一轮 CI。

同轮 Linux desktop 的 `cancelled_reader_holds_capacity_until_blocking_work_really_ends` 在等待启动信号时出现 `RecvError`，Rust lib 结果 159 passed / 1 failed / 7 ignored；后续 lrzsz 等步骤未执行，不能算通过。测试先占用全局池的大部分许可，其他并发认证可能抢走最后一个许可；容量拒绝会丢弃未启动闭包，使通知接收端得到 `RecvError`。具体争用者无法从日志确定。

`13c9aee`（来源 `7eeb760`）保留生产 `KEY_READS` 全局池和原入口，将同一读取算法抽为接收容量池的内部函数；原测试使用独立池，继续验证取消后阻塞读取实际结束前不能释放容量。新增确定性满池回归验证上述错误链及另一个池的独立执行。定向 3/3、10 轮并发回归 30/30；独立 Rust reviewer APPROVE，check / fmt / Clippy / 全 Rust 测试 210 passed、33 ignored。

修复合入 `13c9aee` 后重新完成集成门禁：fmt、Clippy、Rust 210 passed / 33 ignored、wincheck、前端 build、浏览器 376 passed（2.2 分钟）、真实 OpenSSH 11 passed / 0 skipped。原生 helper 在 `09a0362` 上为 15/15，后续 Rust 修复没有改动原生脚本。日志保留在本机 ignored `.artifacts/p1/batch1/*-final.log`。跨平台修复复验仍待运行。

首轮最终为 5 个作业成功、2 个失败，整体失败。Windows 原生四个场景通过，独立复核 summary 与第四场景文本确认新旧输出隔离、退出码 7 保留、关闭后仅剩初始标签；Windows helper 为 14 passed / 1 skipped。Linux GSSAPI 3 个单元测试、四认证场景与三次新 cache 健康复验通过。macOS desktop 为 209 passed / 33 ignored，两种真实 PTY 探针通过；Windows 2022、2025 desktop 均为 203 passed / 7 ignored，另 2 项隔离 ConPTY 诊断通过。Server 2022 保留每轮一个句柄的系统基线增长，不代表零泄漏；Server 2025 该检查稳定。

## 第二轮 CI

[修复后 CI](https://github.com/mofyer/new-windterm/actions/runs/38708582959) 在首轮完全结束后手动触发，被测提交 `3050635df1e27abaa1b2497a758a5e642b80f6ac`（产品/测试代码基点 `13c9aee`）。本轮出现 macOS readiness PTY 关闭超时，不能作为合并 main 的通过证据。

已独立复核 Linux 原生 summary：4/4 场景通过，新增场景 Local 4→Local 5、独立 marker、旧 exit 7 保留、关闭后 remainingTabs=1，夹具清理后 active=0。CI 原生 helper 为 14 passed / 1 skipped；本机 helper 的 15 passed 属于不同平台结果。GSSAPI 再次通过 3 项单元、4 个认证场景与 3 次新 cache 健康检查。

Windows 原生同样 4/4 通过；Linux desktop 的 lrzsz 实跑 11 passed / 0 skipped，默认与 readiness PTY 均通过，X11/agent 各 1 passed / 0 skipped。macOS desktop 的 readiness 探针已通过 2 MiB 输出、UTF-8、退出码 7，随后重复关闭报 `PTY cleanup did not finish within the shutdown deadline` / `Repeated close failed to reap worker`；此时 Rust 测试已通过，但关闭回收门禁失败，正在诊断。

第二轮最终为 6 个作业成功、1 个失败。Rust 总数分平台为 Linux 209 passed / 33 ignored、macOS 210 passed / 33 ignored、Windows 2022 和 2025 各 204 passed / 7 ignored；均为 0 failed。Windows 各自另有 2 项隔离 ConPTY 检查通过。这些通过项不覆盖失败的 macOS readiness 关闭周期。

对失败的只读诊断未找到确定的 readiness 丢失唤醒：flow 条件变量在同锁下检查/等待，poll 有取消通道且单轮最长 250ms。原周期探针丢弃全部 Error/Exit，`done=false` 同时可能表示线程阻塞或回收已经报错，故现有日志无法判定根因。本机额外单轮 12 周期通过；自身进程栈采样主要观察到 child wait，只是成功运行中的等待位置，不等于失败原因。正在补充有界诊断，未扩大期限或改动回收算法。

## P1-PTY-CLOSE-001：第三轮结束时的未关闭记录

macOS CI 的间歇关闭回收失败保留为待定位问题。readiness 默认关闭，但 child cleanup 与默认路径共用，尚不能证明问题只影响可选后端。关闭条件是取得失败阶段/根因证据、完成相应修复及有针对性的回归，并通过跨平台门禁；后续单轮 CI 绿灯不能单独关闭该问题。main 合并评审必须明确呈现这项风险。

诊断提交 `c824b2f`（来源 `c860af3`）保留每轮编号、会话关联、close/wait 耗时及 Error/Exit；只有 `dev-tools` 且显式 `P0_PTY_CLEANUP_TRACE=1` 时输出静态回收阶段与随机会话 ID，不输出终端内容、凭据或环境值。两项 Unix CI 探针启用该变量。原超时、kill、ACK、回收次序保持不变。独立 Rust 审阅 PASS，仅批准诊断增强，不是根因修复。

诊断版本机连续 5 轮、60/60 关闭周期通过，最大 wait 841ms，未复现；日志在 `/tmp/p1-readiness-diagnostic-run-{1..5}.log`，已独立核对。本机成功结果不覆盖第二轮 CI 失败。诊断合入后的门禁与下一轮 CI 另记。

`c824b2f` 集成后本机门禁再次通过：fmt / Clippy / Rust 210 passed、33 ignored / wincheck / 前端 build / 浏览器 376 passed（2.1 分钟）/ 真实 OpenSSH 11 passed、0 skipped。本机日志为 `.artifacts/p1/batch1/*-diagnostic.log`；默认产品构建不启用诊断输出。下一轮 CI 将显式打开探针 trace，完整保留成功与失败阶段。

## 第三轮 CI（诊断增强）

[第三轮 CI](https://github.com/mofyer/new-windterm/actions/runs/38711086052)，被测提交 `c18dba0fb895b05f1da678917bdaaf45e68e8af3`，第二轮完全结束后手动触发。最终 7/7 作业成功，已独立核对日志与工件；`P1-PTY-CLOSE-001` 仍未关闭，结果必须区分本次门禁与根因修复。

macOS 本轮作业通过，两个探针均为 12/12 周期回收成功；每种后端各 13 个会话（主流程 1 + 周期 12）均到达 `done.reaped`，未见清理超时或错误。默认探针最大 wait/总周期为 1297/1397ms，readiness 为 1285/1386ms。两平台原生场景再次各 4/4 通过。以上证明本轮成功，不解释第二轮间歇失败原因。

| 第三轮作业 | 独立核对的实际结果 |
| --- | --- |
| Linux GSSAPI | 3 项单测、4 个认证场景、3 次新 cache 健康检查通过 |
| Linux 原生 WebKitGTK | 4/4 场景；helper 14 passed / 1 skipped；新旧输出、exit 7 与关闭回收通过 |
| Windows 原生 WebView2 | 4/4 场景；helper 14 passed / 1 skipped；同样完成真实 Shell 读回与隔离 |
| Linux desktop | Rust 209 passed / 33 ignored；lrzsz 另 11 passed / 0 skipped；两种 PTY 各 12 周期通过；X11/agent 各 1 passed / 0 skipped |
| macOS desktop | Rust 210 passed / 33 ignored；两种 PTY 及完整诊断阶段通过，见上文 |
| Windows Server 2022 | Rust 204 passed / 7 ignored；另 2 项 ConPTY 诊断通过；bare 与 Session 的 24 周期都增长 24 个句柄，保留系统基线限制 |
| Windows Server 2025 | Rust 204 passed / 7 ignored；另 2 项 ConPTY 诊断通过；bare 增长 0，Session 维持 117 |

本批结论：本地终端生命周期切片及第三轮门禁已通过；P1 整阶段未完成，既有间歇回收问题仍需定位。本批 main 合并决策必须明确保留 `P1-PTY-CLOSE-001`，不能把诊断增强说成回收故障修复。当前仅推送 `p1/integration`，main 保持 `a35582f`，等待用户明确确认。

## 用户决定：先修复回收问题

2026-10-15 用户明确选择「先定位并修复回收问题，再合并」。因此 main 继续冻结；调查共同的 Unix 子进程终止/等待链路，默认与 readiness 均纳入回归，不用成功重跑、放宽超时或风险接受代替修复。

## Unix 回收顺序修复

`7d17178`（来源 `cfbfc75`）修正共同的 Unix 清理路径：原先在 reader/readiness 副本和 writer 仍存活时等待 child，这时读取循环已停止排空。现在先关闭 flow，释放 reader/readiness、join writer，再等待 child；Windows 顺序、原 2 秒关闭期限和错误处理不变。独立 Rust 审阅批准该单文件修复。

固定相同 readiness 负载、ACK 行为和期限，对原顺序与新顺序各跑三轮；每轮含基本流程及 12 个关闭周期：

| 证据 | 原顺序 | 修复顺序 |
| --- | --- | --- |
| 确定性资源生命周期回归 | RED：`PTY I/O still held at child.wait` | GREEN |
| 三轮真实探针 | 每轮 10.836–10.896 秒，36/36 周期通过 | 每轮 1.956–2.002 秒，36/36 周期通过 |
| 探针内部最大关闭等待 | 822–823ms | 83–84ms |
| 日志观察的 child wait 阶段间隔 | 中位约 602ms，最大 602.63ms | 最大 0.269ms |

阶段时间来自外部 collector 接收日志时的单调时钟，不是函数或内核精密计时；主要证据为资源顺序、确定性红绿回归与探针内部 `wait_ms`。六轮均保留 2MiB 精确输出、UTF-8、Ctrl+C、自然 exit 7；默认后端另 12/12 周期通过，最大关闭等待 85ms。mock 直接检查 reader/writer Drop，readiness 释放由代码及真实阶段日志佐证。

Apple XNU 的 [进程退出路径](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_exit.c) 在 session leader 退出时处理 TTY 排空；[PTY 关闭路径](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/tty_dev.c) 说明最后 master 关闭会解除连接并清理队列，与实际 A/B 机制相符。引用的是上游主线源码，不是 runner 精确内核版本。真实旧顺序没有在这些 A/B 中超时；结论是修复了可复现的同路径资源等待机制，第二轮 CI 的具体卡点因缺少 trace 无法追溯，不能写成精确重建历史故障。

证据保留于 `/tmp/p1-reap-before-{1..3}.log`、`/tmp/p1-reap-after-{1..3}.log`、`/tmp/p1-reap-order-{red,green}.log`、`/tmp/p1-reap-default-after.log`，均经独立复核。

协调者另将上述日志、预算 2 的门禁日志及原始 collector 命令回执复制到本机 ignored `.artifacts/p1/batch1/reap-ab/`。`p1-reap-collector-command-evidence.md` 含实际命令、执行回执和二进制 SHA256；stdout/stderr 分别按行接收，外部单调时钟前缀存在调度/缓冲影响。整轮耗时从 spawn 前到子进程 exit 后，包含少量启动开销。这些是本机留存工件，不冒称公开 CI 附件。

全量 Rust 首次验证另外发现 `remote_forward_routes_only_registered_ports` 返回 `Private key reader capacity reached`（lib 162 passed / 1 failed / 7 ignored）。并行的独立 loopback 测试共用产品四槽池，生产容量行为正确；采用测试 harness 并发预算 2，根 Cargo 配置与 CI 一致，不修改生产容量、测试内部并发或容量负例，不重试吞掉错误。已核实当前相关测试的 key-auth 顺序执行，forward 并发发生在已认证连接内，integration 自有测试锁。最终门禁另记，失败原始日志保留于 `/tmp/p1-reap-all-tests.log`。

预算配置提交 `dfb574f`（来源 `e4048b8`）及 CI 配套经独立审阅；根/子目录 Cargo 实测默认预算均为 2，显式环境覆盖仍有效。完整集成门禁通过：Rust 211 passed / 0 failed / 33 ignored、fmt / Clippy / wincheck、前端 build、浏览器 376 passed（2.2 分钟）、真实 OpenSSH 11 passed / 0 skipped。新结果保留在本机 `.artifacts/p1/batch1/*-reap-fix.log`；后续跨平台 CI 须验证准确提交。

## 第四轮 CI（回收顺序修复）

[修复后 CI](https://github.com/mofyer/new-windterm/actions/runs/38718601579) 被测提交 `645ed38d46bf52457d12075bfe95745ebd474f25`，最终 7/7 作业成功。独立核对两个 Unix 后端的资源释放顺序、原期限下的关闭周期、自然退出与输出完整性，以及其余平台门禁。

macOS 与 Linux desktop 已通过。macOS 默认/readiness 均为 12/12 周期回收成功，内部最大 wait 为 360/341ms、最大总周期 411/490ms；实际 `child.wait` 前已释放 reader、join writer，readiness 还已释放 poll 引用。两种后端均保留 2MiB 输出、UTF-8、Ctrl+C、exit 7，无错误或超时。Linux 两种后端最大内部 wait 均 70ms；lrzsz 实跑 11 passed / 0 skipped，X11/agent 各 1 passed / 0 skipped。readiness 有一行 stdout/stderr 在合并流中拼接，但成功标志仍完整存在，未将日志排版问题算作未完成。

第四轮 Rust 结果：macOS 211 passed / 33 ignored、Linux 210 passed / 33 ignored、Windows 2022/2025 各 204 passed / 7 ignored，均为 0 failed。两 Windows 平台另各 2 项 ConPTY 检查通过，2022 的系统基线句柄增长仍保留，2025 保持稳定。两平台原生各 4/4；GSSAPI 为 3 单元、4 认证场景、3 次新 cache 健康检查通过。

最终独立验证 PASS：真实 A/B、确定性红绿回归、默认/readiness 新资源顺序、本机全门禁与准确修复 SHA 的跨平台 CI 已共同满足技术关闭条件。`P1-PTY-CLOSE-001` 按「修复已验证的同路径资源等待机制」关闭；第二轮历史超时的具体卡点无法追溯，原失败记录保留，不声称精确重建历史故障。可执行用户已确认的「先修复，再合并」条件授权。P1 仅完成本批生命周期切片，完整阶段与 164 项功能对齐仍按计划推进。

### 实际合并记录

2026-10-15，独立代码审查与最终证据复核均 PASS 后，按用户「先定位并修复回收问题，再合并」的条件授权执行 `git merge --ff-only p1/integration`。main 已从 `a35582f` 快进至 `165fceb` 并成功推送远端。最终被测代码为 `645ed38`，`165fceb` 与本次合并记录仅更新文档，未修改代码；不重复触发代码 CI。`p1/integration` 同步合并记录，具体最新 SHA 以远端 refs 为准。

本批本地终端生命周期、重新打开及 Unix 回收修复已交付；P1 整阶段尚未完成。下一切片为 T34 启动目录，后续批次仍须单独取得 main 合并批准。

## 2026-10-18：第二批 T34 启动目录

从 `bdcbb3e` 开始，在 `p1/cwd-backend`、`p1/cwd-ui`、`p1/cwd-native` 三个隔离 worktree 并行实现，集成到 `p1/integration`。本批只覆盖 T34 的启动目录部分，不改变冻结台账中的整项状态，也不代表 P1 或完整功能对齐通过。

- `fe258ba`（来源 `8140c64`）：保留默认本地终端按钮，新增启动目录选项；空输入传 `null`，合法路径原样传递。每个会话保存启动目录，重新打开继承原配置，结束态可修改目录后新建；浏览器演示禁用真实启动。
- `304dc3e`（来源 `b631c7f`）：`pty_open` 增加可选 cwd，保留原 Sessions API，新增 `open_with_cwd` / `open_at_generation_with_cwd`。按平台校验绝对路径、存在且为目录，通过 `CommandBuilder::cwd` 传递，不经过 shell、不修改父进程 cwd，也不展开变量或 `~`。保留原代际/容量约束和回收顺序、关闭期限。
- `8c3e5d3`（来源 `26a5838`）：Unix 真实 PTY 探针新增两次独立会话的指定目录、`pwd -P`、exit 7 和 worker 回收；原生第五场景 `local-terminal-cwd` 验证含中文/空格目录实际读回、退出及重开。Windows 测试 shell 先执行固定 `chcp 65001` 再用无参数 `cd` 读目录，不将路径拼入命令。

独立 code-reviewer 审查界面及原生 JS，独立 rust-reviewer 审查 Rust/探针，两者均 APPROVE、无阻塞。界面审查额外执行键盘 Enter/Escape、焦点返回与单次 IPC 冒烟。Rust 新测试先在旧行为下得到 3 项失败，再在实现后通过；完整测试结果如下。

### 本机集成门禁

| 门禁 | 结果 | 范围 |
| --- | --- | --- |
| 前端 TypeScript / Vite build | 通过 | 构建，不是原生运行 |
| 浏览器全套 | 384 passed / 0 failed，2.3 分钟 | 含 20 项本地终端 IPC 契约；仍为 stub |
| Rust fmt / Clippy all targets、all features | 通过 | 锁定依赖，保留测试并发 2 |
| Rust all targets、all features | 219 passed / 0 failed / 33 ignored | 未把 ignored 算成通过 |
| Windows wincheck | 通过 | 类型检查，实际运行待 CI |
| 原生 helper | 16 passed / 0 failed / 0 skipped | 输出匹配拒绝提示符、回显与不完整路径 |
| 真实 OpenSSH | 11 passed / 0 failed / 0 skipped | Rust 客户端 7 项与夹具自检 4 项，两份日志分别留存 |
| macOS 默认 / readiness 真实 PTY | 两种后端均通过 | 各两次指定目录实际读回、exit 7、worker 回收；既有 2 MiB、UTF-8、Ctrl-C、12 次关闭回归保留并通过 |
| macOS WKWebView 单轮原生操作 | 通过 | 启动目录弹窗、真实 `pwd -P`、exit 7、重新打开后实际目录；见下文 |

本机日志保留在 ignored `.artifacts/p1/batch2/`，包括集成日志、后端红绿回归及独立审查的 Rust 门禁日志。不能把这些本地文件当作已上传的 CI 工件。

### 已知范围与后续门禁

- Windows 当前使用 cmd.exe，明确拒绝 UNC、设备/verbatim 输入、盘符相对/根相对路径和会被 Win32 归一化的尾空格/尾点组件；这不是完整 Windows Shell 支持。
- portable-pty 0.9.0 会在 cwd 失效时回退到 HOME/USERPROFILE。本批初检并在 spawn 前再次校验；外部进程在最后检查与库内检查之间删除、重命名或改变符号链接目标仍有竞态。没有更改 HOME、固定目录句柄或修改上游库，不能宣称彻底消除此窗口。
- macOS 本批完成下述有限 WKWebView GUI 验收；Linux/Windows 原生第五场景及平台专属路径测试以本批 CI 为准。完整输入法/读屏、Shell 配置与发行仍未验收。
- 本批在完整门禁与独立验收通过后取得用户单独批准，已于 2026-10-18 合并并推送 main，详见下文合并记录。后续新批次仍需单独确认。

### macOS 原生单轮操作与本批 CI

协调者在 `8c3e5d3`（工作区仅文档差异）执行 `npm run tauri build -- --debug --bundles app`，通过 CUA 操作实际 WKWebView。二进制 SHA-256 为 `abe59398f09931aff5c71e5b66d3e449898039018144223d467e40d1c0de78f1`，构建日志为 `.artifacts/p1/batch2/native-build.log`。

先通过“本地终端启动选项”输入临时目录；CUA `typeText` 未输入中文，读回表单实际是不存在的 `/tmp/p1-cwd-ui-pIaGgF/ project`，应用明确显示不存在错误。点击“修改启动目录”，使用 `paste` 后表单准确显示 `/tmp/p1-cwd-ui-pIaGgF/中文 project`，新建 Local 3 成功。执行固定 `pwd -P`，截图显示独立结果行 `/private/tmp/p1-cwd-ui-pIaGgF/中文 project`。exit 7 后点击“重新打开”，Local 4 再次读回同一路径，并以 code 7 退出。首次缺字属于自动化输入记录，不据此宣称中文输入法验收成功或失败。

两次完整输出截图与 AX 文本保存为 `.artifacts/p1/batch2/mac-cwd-{first,reopen}.{png,txt}`，最终退出记录为 `mac-cwd-exit.txt`。操作只涉及本轮创建的终端、临时目录和本轮启动的应用；结束后已退出应用并删除该临时目录。未改变输入法配置。截图/日志为本机证据，不含在提交中。

首轮跨平台 [CI 39051867574](https://github.com/mofyer/new-windterm/actions/runs/39051867574) 验证精确代码提交 `8c3e5d383a02a77cb5ef3ee8abd45df248d1db0d`；结果及后续修正如下。

### 第二批首轮 CI：Windows 原生 cwd 失败

Windows 原生作业 `117451925058` 的原四个场景通过，第五场景在首次实际 cwd 输出等待 30 秒后失败；不能算新增 Windows 功能验收通过。失败已进入“本机 shell 已启动”，没有直接收到目录校验拒绝。原脚本 `finally` 在外层截图前关闭新标签，导致失败工件只剩演示标签，无法从旧现场精确区分路径拼写、代码页或产品行为。

脚本修正使用 `realpath(directory)` 同时作为输入与精确比较目标，排除 Windows `RUNNER~1` 这类短名与长名的拼写差异；仍拒绝短长路径混判，没有放宽完整行断言或超时。新增 `catch` 在清理前保存 expected、实际填值、阶段、状态、终端输出及截图。独立审查 APPROVE，helper 16/16 通过；这里只能证明测试输入与取证改善，不能断言已追溯历史超时根因。是否通过以修正后的原生 CI 为准。

首轮最终 6/7 作业成功，整体失败。macOS Rust 219/0/33、Linux 218/0/33、Windows 2022 与 2025 各 212/0/7（依次为 passed/failed/ignored）；Windows 专属路径校验已实际执行。Linux 原生 5/5，Unix 两个平台的默认/readiness 均完成指定目录两次读回与 12 次回收。Linux lrzsz 实跑 11 项、X11/agent 各 1 项；GSSAPI 3 单测、4 认证及 3 次健康复验通过。Windows 独立 ConPTY 诊断各 2 项通过，2022 仍有系统既有句柄增长基线，2025 稳定。macOS 默认 2 MiB 探针 31.40 秒、readiness 0.48 秒，均在既定 60 秒预算内；仅诊断，不作性能达标声明。首轮日志及工件已本机留存 `.artifacts/p1/batch2/ci-first/`。

测试修正集成为 `44f8816`（来源 `ea46cb0`），根目录 helper 16/16 复验通过；只改原生测试，不修改产品/Rust/前端，因此保留已完成的对应本机门禁。待首轮完全结束后触发第二轮 [CI 39052866884](https://github.com/mofyer/new-windterm/actions/runs/39052866884)，精确提交 `db335d3a4f838fab783315a05f0f06f5f0566c46`（在修正后补失败记录），最终 7/7 作业成功。

第二轮 Linux、Windows 原生均 5/5 通过。Windows 工件明确记录临时路径为 `C:\Users\RUNNER~1\AppData\Local\Temp\p1 中文-n79gDJ`，实际传入的规范路径与初开/重开两次独立 `cd` 输出均为 `C:\Users\runneradmin\AppData\Local\Temp\p1 中文-n79gDJ`，关闭后剩 1 个初始标签。没有用提示符、命令回显或放宽比较来判定通过。该证据证明统一夹具路径拼写后当前功能通过，首轮失败时具体输出仍无法追溯。

### 第二批最终验收：通过，已获 main 合并批准

独立 verifier 核对第二轮精确 SHA、七个作业及行级工件后给出 **PASS / APPROVE，0 个技术阻塞**。macOS Rust 219/0/33，Linux 218/0/33，Windows 2022/2025 各 212/0/7；Windows 专属路径规则测试实际通过，独立 ConPTY 诊断各 2/0/0。Linux lrzsz 11、X11/agent 各 1、GSSAPI 3 单测/4 认证/3 健康复验均通过；Linux/Windows 原生各 5/5。Unix 四组默认/readiness 探针全部读回指定目录两次并完成 12 次关闭回归；macOS 单轮 WKWebView 证据已独立看图复核。

第二轮 macOS 默认 2 MiB 为 33.57 秒、readiness 0.64 秒，保留为预算内诊断，不替代 P1 性能专项。Windows 2022 的既有 ConPTY 系统句柄增长与 portable-pty 最后校验后的目录竞态仍按上文保留；不宣称完整 Windows、T34、P1 或产品发行通过。第二轮工件本机归档到 `.artifacts/p1/batch2/ci-second/`。

本批实现、独立审查、本机门禁、三端有限原生验证及跨平台 CI 均完成。用户已单独批准本批合并；后续仅补文档不重复触发代码 CI。下一切片为 Shell 发现/选择及缺失反馈，尚未开始，启动参数/env/locale 后续分批验收。

### 第二批 main 合并记录

2026-10-18，用户明确回复「合并 main」后，协调者重新 fetch 并核对分支关系，确认 [CI 39052866884](https://github.com/mofyer/new-windterm/actions/runs/39052866884) 对 `db335d3a4f838fab783315a05f0f06f5f0566c46` 成功，通过 `git merge --ff-only p1/integration` 将 main 从 `bdcbb3e` 快进至 `cf700c2396fca4bf40b5fc161b2ff15b53930b8f`，并成功推送 origin main。

`db335d3` 至 `cf700c2` 仅修改交接、计划与验收记录三份文档，本次后续提交也仅记录合并事实；不重复运行代码门禁或触发代码 CI。`p1/integration` 将同步本次合并记录，最终提交与远端分支一致性在推送后现场核对，具体 SHA 以远端 refs 为准。本批只交付启动目录切片，T34 整项、P1 整阶段及 164 项完整功能对齐均未完成；首轮失败证据和平台限制继续保留。

## 2026-10-18：第三批 Shell 发现、选择与缺失反馈

从已合并的 `8823be4` 开始，在 `p1/shell-backend`、`p1/shell-ui`、`p1/shell-native` 隔离工作树并行推进，再分别独立审查。实现、本机集成门禁与 `68808de` 对应的本批 CI 已完成；2026-10-18 用户单独批准第三批，main 已从 `8823be4` 快进至 `780a10e` 并推送，详见本节合并记录。第二批 CI 不作为本批通过证据。

### 实现范围

- 前端 `b7bb69b`（来源 `76046be`）：在既有本地启动选项中加入 Shell 列表、发现状态与不可用原因。默认本地终端按钮仍使用原默认 Shell。每会话保留 `shell`/`cwd`，退出或失败后重新打开继承原选项，修改启动选项只创建新会话；浏览器演示禁用真实启动。
- 后端 `bb9a261`（来源 `39bea30`）：新增 `local_shell.rs`，以 `pty_shells` 返回固定 ID、名称、路径及不可用原因；`pty_open` 接收可选 Shell ID，通过 `LocalLaunchOptions` / `Sessions::open_with_options` 传入。只选择受支持 ID，不把用户输入当作可执行路径或 shell 命令；打开/重开时重新检查，保留原 cwd、窗口归属、代际、容量和回收约束。
- 原生验收 `dbe43eb`（来源 `d3cc992`）：Unix 探针新增 Bash/Zsh 身份、目录及重开回收；第六原生 WebView 场景验证 Linux Bash / Windows PowerShell 的真实版本、目录和两次 exit 7，清理前保存失败现场。`68808de` 随后仅修复 Windows 条件分支的 Clippy `needless_return`。
- Unix 候选为 Bash/Zsh/PowerShell 7，Windows 候选为 Command Prompt/Windows PowerShell/PowerShell 7。发现只覆盖代码列出的常见安装位置；没有遍历 PATH 或覆盖所有安装方式。
- 显式 Bash 使用 `--noprofile --norc -i`，Zsh 使用 `-f -i`，PowerShell 使用 `-NoLogo -NoProfile`，cmd 使用 `/D /Q /K`。默认 Shell 的 argv、环境和目录行为不变。Shell 身份与实际目录由独立输出验证，不仅看提示符或命令回显。

### 本机集成门禁

前端相关工作树测试 72 项通过，独立 code-reviewer 另跑 12 项 Shell 浏览器契约；Rust 独立审查修复了一项公有 API 注释问题后 APPROVE。以下是合并到 `p1/integration` 后的本机门禁。

| 检查 | 当前结果 | 边界 |
| --- | --- | --- |
| 前端 TypeScript / Vite build | 通过 | 构建，不代表原生成功 |
| 全套浏览器回归 | 396 passed / 0 failed | IPC stub，不代表 Rust 或原生成功 |
| 独立 Rust / 前端与原生 JS 审查 | APPROVE，0 个未解决阻塞 | Windows 单行 lint 修复亦经独立复核 |
| Rust all-targets / all-features | 228 passed / 0 failed / 33 ignored | 19 suites；忽略测试不能视为通过 |
| fmt / Clippy（all-targets / all-features） | 通过 | Windows lint 修复后又检查格式和 macOS Clippy |
| Windows 目标类型检查 / Clippy | 修正后通过 | 不在本机执行 Windows 测试 |
| 真实 OpenSSH 客户端及夹具 | 7 + 4 passed，0 failed / 0 skipped | 独立临时服务与文件，按夹具规则清理 |
| Native helper | 17 passed / 0 failed | helper 测试，不等于原生 WebView 场景执行 |
| macOS 默认/readiness 真实 PTY 探针 | 两种后端均通过 | 既有 12 次关闭、2 MiB、UTF-8、Ctrl-C、两次 cwd 验证，以及显式 Bash/Zsh 初开和重开 |

macOS 显式 Bash/Zsh 探针分别读回 `3.2.57(1)-release` 与 `5.9`；每种 Shell 均验证初次与重开后的版本、实际 cwd、exit 7 与 worker 回收。默认/readiness 的 2 MiB 探针分别为 8.16/0.41 秒，仅作为既定 60 秒预算内诊断，不代表 GUI 性能达标。原始日志保存于 `.artifacts/p1/batch3/`：`rust.log`、`playwright.log`、`openssh*.log`、`native-helpers.log`、`pty-default.log`、`pty-readiness.log` 等。

首轮 Windows 本机类型检查因 `local_absolute_path` 的 Windows 条件分支含多余 `return`，被 Clippy `-D warnings` 阻断；去掉 `return` 与分号后语义不变，独立 Rust reviewer 复核通过，`wincheck-rerun.log` 记录修正后通过。第一次独立工作树构建因缺少 `dist` 失败，复制已构建前端产物后重验通过，没有修改 Tauri 配置绕过检查。

### macOS 原生窗口单轮验收

协调者构建 debug `.app`，二进制 SHA-256 为 `d40382403a94f4d81ff467b383999bdf22a5cf4e7af985a2bce47e07412478e4`。通过 CUA 操作实际 WKWebView，Shell 列表中 Bash/Zsh 可用，未安装的 PowerShell 7 被标为不可用并显示原因。选择 Bash 和 `/tmp/p1-shell-ui-YdhD4E/中文 project` 后，Local 2 独立输出行显示 `P1_SHELL=3.2.57(1)-release` 与 `/private/tmp/p1-shell-ui-YdhD4E/中文 project`；exit 7 后重新打开生成 Local 3，同样读回 Bash 版本及实际目录，再次 exit 7。

原生窗口置前后观察完整输出；中间即时 AX 快照曾只包含部分输出，不将后台自动化快照延迟当作完整显示性能结论。证据为 `mac-shell-options.png`、`mac-shell-{initial,reopen}.{png,txt}` 与 `mac-shell-exit.txt`。本轮应用和临时目录已清理，未更改输入法或用户 Shell 设置。该验收不覆盖完整 IME/读屏/长期输出，也未运行本机 PowerShell。

独立 verifier 已看图并核对实际二进制哈希、Local 2/3 的独立版本/目录输出和 Local 3 code 7。列表展开时 Zsh 可用、Local 2 code 7 及点击重开的过程来自协调者 CUA 操作记录，没有另存这些中间步骤截图；不将两张终端截图单独表述为完整过渡证明。真实 PTY 两轮退出和 worker 回收另有完整日志。

### 第三批跨平台 CI

[CI 39060515987](https://github.com/mofyer/new-windterm/actions/runs/39060515987) 验证精确提交 `68808dea7e54943a0c2eb2c069418d795f58db10`，最终 **7/7 作业成功**。独立代理分别读取 Windows 与 Unix/GSSAPI 原始日志及工件，均给出 PASS、0 阻塞；不只依据作业绿色状态判断。

| 本轮 CI 范围 | 实际结果 |
| --- | --- |
| macOS arm64 Rust | 228 passed / 0 failed / 33 ignored；格式、check、Clippy、前端及桌面链接通过 |
| Linux x64 Rust | 227 passed / 0 failed / 33 ignored；格式、check、Clippy、前端及桌面链接通过 |
| Windows Server 2022 / 2025 Rust | 各 222 passed / 0 failed / 7 ignored；新 Shell 路径/参数与 owner/cwd/拒绝测试实际执行，格式、check、Clippy、前端及链接通过 |
| Windows 独立 ConPTY | 两平台各 2/2；2022 裸 ConPTY +24、会话 191→215 的既有系统基线保留；2025 裸增长 0、会话 117 稳定 |
| Unix 默认与 readiness PTY | 四条 lane 均完成 2 MiB 完整性、UTF-8、Ctrl-C、12 次关闭回收和两次默认 cwd；macOS Bash/Zsh、Linux Bash 各完成两次身份/cwd/exit 7/回收 |
| Linux 原生 WebKitGTK | 6/6；真实 Bash `5.2.21(1)-release`，初开和重开实际 cwd 均为 `/tmp/p1 中文-JLROjT`，清理后剩 1 标签 |
| Windows 原生 WebView2 | 6/6；实际 Windows PowerShell `5.1.20348.5622`，初开和重开独立版本行、中文 cwd 一致，两次 exit 7 后清到 1 标签，SSH 夹具 active=0 |
| Linux 互操作 | lrzsz 11、X11 1、agent 1，均 0 failed / 0 skipped；非阻塞步骤已独立读日志 |
| Linux GSSAPI | 3 单元、4 认证、3 健康复验，均通过；仍仅隔离 KDC/OpenSSH 探针 |

Linux runner 未安装 Zsh，两条探针均明确 SKIP；PowerShell 7 未完成实际启动验收，不能由发现/命令构造测试外推。Windows native helper 为 16 passed / 0 failed / 1 macOS-only skipped，本机 helper 17/17；不得把平台跳过计为执行通过。macOS CI 默认/readiness 2 MiB 分别为 31.24/0.64 秒，仅预算内诊断，不替代 P1 性能验收。

本轮日志、原生截图和行级文本已保存到 `.artifacts/p1/batch3/ci-first/`，其中 Unix/GSSAPI 与 Windows 分目录归档，`run-final.json` 固定精确 SHA、作业状态及结果。后续提交只补本批证据与计划文档，不重复触发代码 CI。

### 保留的边界与待办

- Zsh 的 `-f` 不能跳过系统 `zshenv`；PowerShell 的 `-NoProfile` 只控制 profile 加载，不表示禁用历史记录，参见 [PowerShell 启动参数](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.5)。
- Windows 的启动目录继续受产品既有本地盘符规则约束。这是本批实现边界，不是 PowerShell 自身不支持 UNC 的结论。
- 目录和可执行文件在最后检查与实际启动之间仍可被外部删除、替换或改变目标；第二批记录的 cwd TOCTOU 限制继续成立，未以额外检查宣称消除竞态。
- 用户任意命令/路径、启动参数编辑、env/locale 配置、持久化、WSL、Git Bash/Cygwin 和 Clink 均未在本批交付。完整 T34、相关 Shell 功能项、P1 和 164 项功能对齐不因本切片而更新为完成。
- 本机、跨平台与独立验收已完成；本批已获用户单独批准并合入 main，产品基线为 `780a10e`。

### 第三批最终验收：通过，已获批准并合入 main

独立 verifier 重新核对本轮 CI 精确 SHA、四平台 Rust 实际计数、Linux/Windows 原生身份和目录输出、Unix 回收日志、本机图像与二进制哈希，以及远端分支和五份文档的一致性，给出 **PASS / APPROVE，0 个技术阻塞**。本批候选代码为 `68808de`，其后仅更新文档；`p1/integration` 的最终文档提交以远端 refs 为准。Linux Zsh 缺失、PowerShell 7 未实测、Windows 2022 系统句柄基线、TOCTOU 与完整 P1/发行验收边界均保留。本批已获用户单独授权并完成合并，第四批不在授权范围。

### 第三批 main 合并记录

2026-10-18，用户针对第三批候选 `780a10e` 明确回复「合并 main」后，协调者在隔离 main 工作树中以 fast-forward 将 main 从 `8823be4` 推进至 `780a10e686d7c02c968a38e1ab63cd110408d093`，已推送并读回远端核对。被测产品代码仍为 `68808de`，其后的第三批提交仅补证据文档；本次记录也只更新文档，不重复触发代码 CI。合并记录文档经独立审阅后提交并推送为 `40405d7`，已通过 `3aaa783` 同步到集成分支；产品代码未改变。最新分支位置以远端 refs 为准。

此次仅合并第三批 Shell 发现、选择与缺失反馈及其证据；环境变量与 locale 属于第四批，未包含在本次 main 产品基线中，后续仍须完成本批验收并单独取得合并批准。P1 整阶段与完整功能对齐未完成。

## 2026-10-18：第四批会话环境变量与 locale

从第三批证据文档 `780a10e` 开始，在 `p1/env-backend`、`p1/env-ui`、`p1/env-native` 三个隔离工作树并行实施。后端、界面及原生验收代码已分别审查、集成并推送至 `bea905f`；本机全套门禁与 macOS 有限原生验收已通过，首轮 CI 的 Linux 第七原生场景因 WebDriver 空输入失败，夹具修复已集成为 `eb76e4b`。首轮已结束，6/7 作业成功，唯一失败为 Linux native；第二轮 `39063630062` 已结束，同为 6/7 作业成功、整体失败，唯一失败为 Windows native 旧第六 Shell 场景；新增环境场景及其余作业通过。Windows 根因诊断与最终验收未完成。第三批已获单独批准并合入 main，产品基线为 `780a10e`；第四批尚未获合并授权，不沿用第三批授权或 CI 宣称第四批已批准或通过。

### 已集成实现与契约

- 后端 `333b2b7`（来源 `e7b1d6e`）：扩展 `pty_open` / `LocalLaunchOptions`，由 `local_environment.rs` 验证每会话环境条目与 locale，只修改当前子进程的 `CommandBuilder`，不修改应用全局环境。缺省参数兼容原入口；打开与重新打开均校验，保留 cwd、owner/generation、容量、ACK 与回收约束。
- 前端 `b0a9d16`（来源 `1957b7f`）：名称/值行编辑、独立 locale 模式、清晰错误反馈；每会话深复制启动配置，重开使用原始配置，后续表单修改只影响新会话，终端内交互修改不会成为重开配置。默认一键入口保持原行为，不自动重放输入。
- 原生探针与场景 `bea905f`（来源 `826f1ea`）：加入实际环境/locale 读回、会话隔离、空值与字面值、退出重开和默认兼容验证；Rust probe 经独立审查及固定退出 deadline 修复复核后 APPROVE，本批原生 WebView 的实际结果见下文，不能由代码审查代替。
- 值按字面传递，保留空字符串、Unicode、空格和等号，不解释 shell 语法；禁止 NUL。普通环境最多 64 项，locale 最多 13 项；名称匹配 `[A-Za-z_][A-Za-z0-9_]*` 且最多 64 字节，单值最多 4096 UTF-8 字节；两组合计按每项名称 + 值 + 2 的字节数计，不超过 16 KiB。Windows ASCII 大小写不敏感、Unix 大小写敏感，重复和冲突明确拒绝。
- locale 缺省或 `default` 加空列表保留原平台设置；默认模式带非空变量报错。`custom` 先清除默认注入的 `LANG`/`LC_*` 再添加选定项，自定义空列表表示全部清除。允许 `LANG`、`LC_ALL` 和 11 个分类变量；拒绝 `LC_ALL` 与其他 `LC_*` 并存，允许 `LANG` 与 `LC_ALL` 并存且后者优先。不验证系统是否安装指定 locale；Windows 仅传递变量，不代表改变代码页或 PowerShell 显示语言。
- 普通变量不能写入 locale 名称、运行/提示符/历史路径保留项或启动加载相关前缀，具体名单以后端为准。`PATH` 可显式覆盖，但 Shell 仍从固定绝对路径选择。保留名单是本切片支持范围，不删减最终功能目标；不能由此宣称任意变量对后续用户命令没有影响。
- 配置值只留在应用内存，应用不将其写入状态文案、日志或持久设置；反序列化、验证、Debug 和自定义环境的启动错误均防止回显值。这不保证 Shell、用户命令或操作系统不会记录这些值，也不代表提供持久凭据管理。

### 工作树定向验证与审查

下表是各工作树的实施证据，**不是最终集成树门禁或跨平台原生验收**；精确集成提交、原始日志和计数见下文集成树及 CI 记录。

| 检查 | 当前证据 | 适用边界 |
| --- | --- | --- |
| 后端独立 Rust 与安全审查 | APPROVE；已处理变量值泄露问题 | 不替代全量门禁或真实平台执行 |
| 前端与原生 JS 独立审查 | APPROVE | Rust probe 亦已独立复核 APPROVE；不代表原生场景已执行 |
| UI build / 新增浏览器契约 | build 通过；新增 17 项通过 | IPC stub；不是原生子进程 |
| 既有浏览器定向回归 | 32 项通过 | 不是全套浏览器回归 |
| 独立 Node helper | 19 项通过 | 不是原生 WebView 执行 |
| Rust library | 独立默认特性 188 passed / 0 failed / 7 ignored；实现者 all-features 190 passed / 0 failed / 7 ignored | 两种特性与执行者分开记录；不是 all-targets 全量结果 |
| 默认/readiness 真实 PTY 工作树探针 | 两种后端通过既有 12 次关闭、2 MiB、cwd、Bash/Zsh，以及新增环境/locale 场景 | 集成树复验见下文；不能代替 Windows 或 GUI |

新增 PTY 场景验证字面值与空值、两会话隔离、运行时修改后 exit 7 再重开恢复初始配置、自定义空 locale 和父进程环境不变。工作树测试保留初次失败：UI 两项断言预期经修正后通过；native probe 首次编译的闭包类型推断错误修正后通过，不将失败从记录中删除。

独立 Rust 审查发现 HIGH：portable-pty 即使采用显式 argv，也可能解析 `SHELL`，并在值非法时记录该值。后端已将 `SHELL` 列为保留项并增加回归测试，Rust 与安全审查分别复核后 APPROVE。另一次独立 Rust probe 审查发现 MEDIUM：退出接收循环每收到一条 Data 便重新等待 5 秒，持续输出时可能没有总期限；协调者已改为固定 `Instant` 的 5 秒 deadline，每轮仅使用剩余预算，超时返回错误并由外层 shutdown 清理。该探针修复已获独立复核 APPROVE，集成树默认与 readiness 两种后端实跑均通过。

### 集成树本机门禁

当前集成代码为 `bea905f419c42b50155328b108b8af1ae423c2be`，本机门禁脚本 exit 0。以下结果不等于原生 GUI 或跨平台 CI 验收。

| 检查 | 已完成结果 | 边界 |
| --- | --- | --- |
| 前端 TypeScript / Vite build | 通过 | 不等于原生运行 |
| 全套浏览器回归 | 413 passed / 0 failed / 0 skipped / 0 flaky；无重跑 | IPC stub |
| Rust all-targets / all-features | 19 suites，共 238 passed / 0 failed / 33 ignored | 忽略测试不计为通过 |
| fmt / Clippy all-targets / all-features | 通过 | 静态检查 |
| Windows 交叉 all-targets / all-features Clippy | 通过，5.42 秒 | 仅类型与 lint 检查，不执行 Windows 测试 |
| 真实 OpenSSH 客户端与夹具 | 7 + 4 passed / 0 failed / 0 skipped | 独立临时服务与文件 |
| Native helper | 19 passed / 0 failed | 不等于原生 WebView 执行 |
| 默认/readiness 真实 PTY 探针 | 两种后端均通过，包括最终 deadline 修复 | 既有生命周期/完整性、Shell/cwd 及新增环境/locale 验证；不代替 GUI |

本机原始日志在 `.artifacts/p1/batch4/`：`fmt.log`、`clippy.log`、`frontend.log`、`playwright.log` 与 `playwright-results.json`、`rust.log`、`wincheck.log`、`openssh-clients.log`、`openssh-fixtures.log`、`native-helpers.log`、`pty-default.log`、`pty-readiness.log`；首轮 UI 与探针编译失败分别保留于 `ui-first/` 和 `probe-initial-compile-failure.log`。

代码已推送 `p1/integration`；[首轮 CI 39062783489](https://github.com/mofyer/new-windterm/actions/runs/39062783489) 已结束，失败与修复、第二轮进展见下文。本机默认/readiness 的 2 MiB 分别为 7.66/0.42 秒，仅保留为既定预算内诊断，不代表 GUI 性能验收。

### macOS 原生窗口有限验收

协调者构建 debug `.app`，二进制 SHA-256 为 `9c7a6ddff804bb007a0c831edecfcf47d8ac4cb79b68aab54fa7f3c4cab46d2e`。通过 CUA 操作真实 WKWebView，选择 Bash，填写 `P1_ENV_SAMPLE=中文 space=one`、空值 `P1_ENV_EMPTY` 与自定义 `LANG=en_US.UTF-8`。Local 2 的独立输出行读回原字面值、空值存在标志 `yes` 与长度 `0`、LANG，以及已清除的 LC_ALL/LC_CTYPE。随后交互改为 `runtime_changed`，读回新值并 exit 7。

点击“重新打开”生成 Local 3，独立输出恢复 `中文 space=one`，空值仍存在、长度 0，LANG 保留而 LC_CTYPE 未设置，再次 exit 7。一键打开默认 Local 4，两个测试变量均不存在，默认 LANG=en_US.UTF-8、LC_CTYPE=UTF-8 保持；exit 0 后退出应用，进程核对未残留。默认入口的 Zsh 身份来自平台策略，本轮 GUI 没有另读其版本，不能由提示符独立证明身份。本轮没有修改用户 Shell 设置或输入法。

证据保存于 `mac-env-{options,initial,first-exit,reopen,default}.{png,txt}`、`mac-env-reopen-exit.txt`、`macos-build.log` 与 `macos-binary.sha256`。部分即时 AX 快照曾只显示命令前几个字符，窗口 Raise 后完整输出可见，未将该快照现象外推为产品性能结论。此单轮 GUI 没有同时打开两个不同自定义配置的活动会话，该项由真实 PTY 与后续 Linux/Windows 原生场景验证；完整 IME、读屏、长期输出及发行验收不在本次范围。独立 verifier 实际查看五张截图与六份 AX 文本、核对二进制哈希、逐项汇总本机原始日志后给出本机阶段 PASS / APPROVE，0 个阻塞；跨平台最终结论另行核验。

### 第四批首轮 CI：Linux 原生空输入失败及夹具修复

[首轮 CI 39062783489](https://github.com/mofyer/new-windterm/actions/runs/39062783489) 最终 **6/7 作业成功、1 个失败，整体失败**，唯一失败为 Linux native。该作业前六场景 PASS，第七环境变量场景在 `phase=open` 填写空 cwd 时返回 WebDriver `Missing text parameter`。失败发生在创建该场景的环境变量 PTY 之前，不能将其写成环境传递失败，也不能用其余六个绿色作业代表整轮通过。

根因是 `fill` 清空字段后继续对空字符串调用 `sendKeys`，该驱动拒绝空输入。修复 `eb76e4b`（来源 `5bcb228`）在值为空时不发送按键，保留清空后的读回检查与必要的 DOM fallback。fake-driver 回归先红后绿，分别覆盖 clear 有效与无效两条路径；两个文件经独立 JS review APPROVE，集成后的 native helper 为 **20 passed / 0 failed / 0 skipped**，日志为 `.artifacts/p1/batch4/native-helpers-fixed.log`。产品源码未改，先前 Rust、浏览器及 macOS 原生证据继续适用；修正版 CI 的 Linux 第七场景已通过；Windows 旧第六场景另有未定位失败，详见下文。

首轮失败现场保留于 `.artifacts/p1/batch4/ci-first/unix/linux-native/` 的 `summary.json`、`07-local-terminal-environment-failure.json` 与同名 `.png`。Linux runner 截图因缺少 CJK 字体出现方块；Unicode 文本读回正确与字形视觉验收是两项不同证据，不能由文本读回宣称中文字形显示已验收。

首轮通过范围按原始日志与工件分别记录：

| 首轮范围 | 实际结果与边界 |
| --- | --- |
| macOS / Linux desktop Rust | 分别 238 / 237 passed，均 0 failed / 33 ignored |
| Unix 默认/readiness PTY | 四条 lane 全部通过，包含新增环境/locale 阶段及既有生命周期、完整性验证 |
| Unix 2 MiB 诊断 | macOS 默认/readiness 33.26/0.57 秒；Linux 0.53/0.38 秒；仅预算内诊断，不作 GUI 性能结论 |
| Linux 互操作与 GSSAPI | lrzsz 11、X11 1、agent 1；GSSAPI 3 单元、4 认证、3 健康复验，均通过；仍保留对应探针范围 |
| Windows Server 2022 / 2025 Rust | 各 232 passed / 0 failed / 7 ignored；新增 9 项环境测试与 1 项 PTY 拒绝测试均实际执行通过 |
| Windows 独立 ConPTY | 两平台各 2 项通过；2022 裸 ConPTY +24、session 191→215 的既有系统基线保留；2025 裸增长 0、session 117 稳定 |
| Windows native helper | 17 passed / 0 failed / 2 skipped，共 19 项；真实 Bash 辅助测试与 macOS 专有测试跳过，不能计为执行通过 |
| Windows native | 7/7；Windows PowerShell `5.1.20348.5622`，WebView2/driver `131.0.2903.86`；独立读回空值存在 `yes` 与空内容、两个会话不同中文字面值、运行时修改后重开恢复原值；默认 cmd 无测试变量，关闭后 `remainingTabs=1`，SSH 夹具 `active=0` |

### 第四批第二轮 CI：6/7 作业通过，Windows 旧 Shell 场景失败

首轮完全结束后已触发 [第二轮 CI 39063630062](https://github.com/mofyer/new-windterm/actions/runs/39063630062)，验证精确提交 `eb76e4b6f3e2c12b09cf6ad4e1fd872296e8bd27`。产品代码仍为 `bea905f` 对应内容，后续 `eb76e4b` 只改原生测试夹具与其回归测试。第二轮已结束，**6/7 作业成功、1 个失败，整体失败**。唯一失败为 Windows native 的旧第六 Shell 场景，新增环境场景通过；Linux native、四个 desktop 作业与 GSSAPI 均通过，不能据此宣布整批验收完成。

Linux native **7/7** 实际执行通过，第七场景耗时 32.034 秒。逐行核对 `initial`、`independent`、`retained`、`modified`、`reopened`、`defaults`：两个活动会话分别读回含 one/two 的中文字面值，空变量存在且内容为空；自定义 `LANG=C.UTF-8` 且 `LC_ALL` 未设置。第一会话运行时修改为 `runtime-change`，exit 7 后重开恢复原配置，第二会话仍保持独立值；默认会话没有 sample/empty 测试变量，`LANG`/`LC_ALL` 均保留 `C.UTF-8`。清理后 `remainingTabs=1`，SSH 夹具 `active=0`。原始工件与作业日志保存于 `.artifacts/p1/batch4/ci-second/unix/linux-native/` 及对应 job log。

Linux native helper 实际为 **19 passed / 0 failed / 1 skipped**，共 20 项，macOS 专有测试跳过，新增空 fill 回归通过；不能将 20 项总数写成 20 项执行通过。首轮 Linux 第七场景失败已由修复提交的第二轮实际执行关闭，首轮失败工件及 CJK 字形边界继续保留。

第二轮其他已核验结果如下，原始日志与工件保存在 `.artifacts/p1/batch4/ci-second/`：

| 第二轮范围 | 实际结果与边界 |
| --- | --- |
| macOS / Linux desktop Rust | 分别 238 / 237 passed，均 0 failed / 33 ignored；构建与静态检查通过 |
| Windows Server 2022 / 2025 Rust | 各 232 passed / 0 failed / 7 ignored；构建与静态检查通过 |
| Windows 独立 ConPTY | 两平台各 2 项通过；2022 裸 ConPTY +24、session 191→215 的既有系统基线保留；2025 裸增长 0、session 117 稳定 |
| Unix 默认/readiness PTY | 四条 lane 均通过，包括新增环境/locale、既有生命周期、完整性、cwd 和可用 Shell；Linux Zsh 缺失仍为跳过 |
| Unix 2 MiB 诊断 | macOS 默认/readiness 31.21/0.58 秒；Linux 0.56/0.44 秒；仅预算内诊断，不作 GUI 性能结论 |
| Linux 互操作与 GSSAPI | lrzsz 11、X11 1、agent 1；GSSAPI 3 单元、4 认证、3 健康复验，均通过；仍为对应探针范围 |
| Windows native helper | 18 passed / 0 failed / 2 skipped，共 20 项；真实 Bash 辅助测试与 macOS 专有测试跳过 |
| Windows native | 6/7；旧第六 Shell 场景失败。新增第七环境场景通过，两个会话字面值与空值、运行时修改、重开恢复和默认无测试变量均读回；清理后 `remainingTabs=1`，SSH 夹具 `active=0` |

第二轮新增阻塞：Windows 原生旧第六场景 `local-terminal-shell` 在 `initial cwd query` 等待实际目录输出 30 秒超时，第七环境场景通过。失败记录在 `.artifacts/p1/batch4/ci-second/windows-native/06-local-terminal-shell-failure.{json,png}`；版本 `P1_SHELL=5.1.20348.5622` 已读回，随后只见 `(Get-Location).Path` 命令回显和下一行光标，没有目录输出或新提示符。不能据此认定 Enter 丢失、脚本抖动或产品无问题；现有工件没有原始 PTY 输入输出，根因未定。

### 待完成与保留边界

`p1/native-trace` 与 `p1/native-diagnostic-ci` 的测试侧有界追踪和可选重复诊断，经组合独立审查集成为 `2225103` 与 `ab0ee0b`，当时 Node helper 34/34 通过。诊断保留原三条命令、严格 cwd 断言及超时，不合并命令、放宽比较或以重跑掩盖失败；仅追踪受控测试会话，不记录启动环境配置。`pty_write` 成功仍只证明入队，不证明实际 ConPTY 写入完成。

[诊断 CI 39064960825](https://github.com/mofyer/new-windterm/actions/runs/39064960825) 验证 `ab0ee0b66ebd55dcddb49c0921380aac2520f049`，参数为 `native_only=true`、`windows_shell_repeats=10`；仅运行 Linux/Windows 两个 native 作业，Windows 标准场景后追加 10 次 Shell 诊断，不能替代七作业全套门禁。Linux native 7/7，但 `ci-diagnostic/linux-native/06-local-terminal-shell-trace.json` 只有 82 字节且 `records=[]`，追踪无效，不能用于根因判断。Windows 基础 7/7、追加 10/10，均无失败或跳过；11 轮 Shell 的首次与重开目录、PowerShell 5.1.20348.5622 身份均通过，所有 11 份 trace 同样为 82 字节空记录。两端功能成功仅证明本轮未复现，不能关闭原停滞；Windows 独立审计在 `ci-diagnostic/windows-native/independent-audit.json`。

已定位的是**测试追踪工具缺陷**：Tauri runtime 的只读 global/invoke 使原包装赋值静默失败。测试侧修复 `5fe00fd` 改用 fetch 与 callbackMap，已获独立安全与 JS 审查 APPROVE，组合 helper 35/35 通过；真实 SDK 脚本红绿证据 `trace-real-sdk-red-green.json` 显示旧版 records/data 为 0/0，修正版为 6/2 且 `incomplete=false`。该结果只验证追踪修复，产品代码仍为 `bea905f` 对应内容，Windows 目录查询停滞根因未定。修正版[全套 CI 39066177739](https://github.com/mofyer/new-windterm/actions/runs/39066177739) 验证精确 SHA `5fe00fdfc7c44ad025385374fdae1ee0f9a81b7a`，七作业门禁、Windows 另加 3 次重复诊断，已结束为 **6/7 作业成功、整体失败**，最终状态保存在 `ci-trace-fixed/run-final.json`。四个 desktop、GSSAPI 与 Linux native 成功，唯一失败为 Windows native 的 trace 容量不足。Linux native 已核验 7/7，`ci-trace-fixed/unix/linux-native/06-local-terminal-shell-trace.json` 为 42,098 字节、440 条记录，覆盖首次与重开两个会话槽，无 incomplete/truncated，证明修正版在本轮 Linux 原生环境实际取得追踪。GSSAPI 3 单元、4 认证、3 健康复验通过；各通过项仍保留其平台与探针范围，不推断 Windows 根因或整批通过。

Windows native 基础场景为 6/7、额外诊断为 0/3。四轮 Shell 均完成版本、实际 cwd、exit 7 与重新打开断言，并生成成功 TXT/PNG；随后在 `finally` 中因 64 KiB trace 截断判为失败。四份 trace 分别为 64,623 / 64,673 / 64,668 / 64,628 字节，丢弃 159 / 167 / 174 / 164 条记录，详见 `ci-trace-fixed/windows-native/independent-audit.json`。每轮首次会话槽的 136 次 write 均 fulfilled，4 个 CR、CPR 应答及对应 ACK 成功，Data/ACK 数分别为 29 / 31 / 33 / 31；这些是成功会话的完整片段。第二会话槽已截断，缺失记录不能推断丢失 IPC 或复现原停滞，也不能把追踪容量失败改写为产品功能通过的整轮 CI。

另一个测试追踪容量回归模拟完整诊断负载：原 64 KiB 上限丢弃 813 条记录；调整为有界 256 KiB 后完整保留 1,390 条、156,281 字节。该测试侧修复经独立审查 APPROVE，组合 helper 36/36 通过，日志为 `native-diagnostic-capacity-helpers.log`，已集成并推送 `0906c85`。该提交只修改两份测试文件；[native 补验 39067079503](https://github.com/mofyer/new-windterm/actions/runs/39067079503) 已完成成功，被测 SHA 为 `0906c85fd3abbe772f29a25c5a464b710f4fbd52`，两平台各默认七场景 7/7、无额外重复。Linux helpers 35 passed / 0 failed / 1 skipped，Windows 34 passed / 0 failed / 2 skipped，各 36 项；跳过项不计为通过。两端 trace 均完整覆盖首次与重开两个槽：Linux 44,810 字节、467 条记录，Data 分别 38/41；Windows 85,251 字节、757 条记录，Data 分别 32/33；两端均 `incomplete=false`、`truncated=false`、`droppedRecords=0`。证据保存在 `.artifacts/p1/batch4/ci-capacity/`，Windows 独立复核见其 `windows-native/independent-audit.json`。这仅证明本轮追踪容量修复和七场景通过，不能关闭原 Windows 目录查询停滞。产品代码仍为 `bea905f` 对应内容，不重复未受影响的 Rust 门禁；补验与上一轮各自记录，不能拼写成某单轮 CI 7/7。默认配置路径的静态对比只确认新增 apply 在缺省配置下不改环境，不能据此排除产品影响或确定原停滞根因。整批验收与 main 合并请求继续暂缓。

### 独立 PowerShell 延迟诊断：已取得环境差异，严格检查失败

四份已有原始追踪位于 `.artifacts/p1/batch4/ci-trace-fixed/windows-native/06-local-terminal-shell-trace.json` 及同目录 `diag-shell-01-06-local-terminal-shell-trace.json`、`diag-shell-02-06-local-terminal-shell-trace.json`、`diag-shell-03-06-local-terminal-shell-trace.json`。首次 `(Get-Location).Path` 回显及 ACK 完成后，距 cwd 输出约 20.8–27.1 秒。这是测试侧可见事件之间的间隔，不是 cmdlet 内部执行耗时；只能作为进一步分离 Shell 初始化与产品链路的调查线索，不能据此解释原 CI 的目录查询停滞。

独立探针已集成并推送为 `7c9a14b`，经独立代码审查 APPROVE，本机 12/12 回归通过；[双平台诊断 39094470445](https://github.com/mofyer/new-windterm/actions/runs/39094470445) 验证该提交，**两个作业均失败**。两端各 12/12 helper 通过、各完成 6 个测量样本，所有样本三阶段 cwd 校验成立、exit 0、无超时；但每个样本均有 392 字节 stderr，按严格规则判为失败。只保存了字节数，未保存内容，因此不能将 stderr 解释为无害进度提示。`cleanupSucceeded=null` 表示未触发超时清理，不是清理测试通过。

| 独立 stdio 测量 | 继承环境：首次 Get-Location | 产品白名单环境：首次 Get-Location |
| --- | --- | --- |
| Windows Server 2022，分别 3 个新进程 | 53.8–380.2 ms | 21,299.5–27,214.0 ms |
| Windows Server 2025，分别 3 个新进程 | 38.9–251.9 ms | 11,187.2–26,948.5 ms |

12 个样本的 .NET 路径参照为 3.65–6.39 ms，第二次 Get-Location 为 0.1435–0.296 ms。这些是独立脚本内 Stopwatch 计时，与上面的原生前端事件间隔是不同证据。原始报告与最终 CI 状态保存在 `.artifacts/p1/batch4/powershell-latency-ci/`，已有独立审查逐项核对。

本轮支持环境策略与首次 cmdlet 延迟存在明显关联，但继承环境先执行、白名单随后执行，顺序和缓存未控制；stdio/EncodedCommand 与交互 ConPTY 不同，尚未定位具体变量或初始化机制，也不能解释历史 30 秒停滞。产品启动路径和原场景断言未改，整批验收仍未完成。

下一步最小诊断：先在内存中对有界 stderr 作结构分类，只保存已知流类型计数及未知标志，不保存内容或路径；未知仍判失败。然后仅在诊断中比较继承、白名单、白名单加入父 PSModulePath、继承移除 PSModulePath 四组，反转区组顺序、每样本新进程，首样本单列。PSModulePath 只是候选因子，未证实；锁定因子后还须在 ConPTY 验证，不能直接修改产品白名单或提高原 30 秒断言。Windows 新实验结果见下文。

### 诊断实验实现与直接 ConPTY 复现（仅测试侧）

当前 `p1/integration` 已将上述实验落到 `tests/native/powershell-latency-probe.mjs`：每轮以新进程比较继承环境、产品白名单、白名单加回父 `PSModulePath`、继承环境移除 `PSModulePath` 四组，第二轮反向排列，第一项另标 `firstSample`。stderr 只在内存中按已知 PowerShell 流/错误类型累计字节数，并记录未知标志；报告不保存 stderr 内容，未知 stderr 继续使样本失败，原 60 秒进程期限和严格退出检查保持不变。对应 Node helper 已覆盖环境隔离、正反顺序、stderr 隐私与未知失败语义。

这只是可复现性和取证改进；本机 macOS 只能运行 schema/helper 测试，不能替代 Windows 实验。尚未据此修改产品白名单、放宽原生 30 秒断言、关闭旧 Shell 停滞，第四批仍未完成验收。

[反向四组实验 39740945170](https://github.com/mofyer/new-windterm/actions/runs/39740945170) 验证精确提交 `96a30660663263bf4e3cf9ae9fd93ee84bedd551`。Windows 2022/2025 两个作业均在 schema/helper 通过后完成 8/8 新进程样本；每个样本三阶段 cwd 匹配、exit 0，stderr 均为 392 字节未知内容，所以严格门禁仍失败。环境差异如下（首次 `Get-Location`，单位毫秒）：

| 环境 | Windows 2022 | Windows 2025 |
| --- | ---: | ---: |
| 继承 | 56.3–407.6 | 50.7–263.5 |
| 产品白名单 | 21,177.0–28,064.6 | 19,605.6–26,389.0 |
| 白名单 + 父 `PSModulePath` | 29.2–30.0 | 31.8–32.8 |
| 继承 − `PSModulePath` | 89.8–92.2 | 83.4–83.7 |

这轮支持 `PSModulePath` 与 stdio 首次 cmdlet 延迟存在强关联，并消除了固定执行顺序的混淆；它仍不是产品根因或 ConPTY 证据。未知 stderr 尚未分类，不能把作业失败改写成通过；下一步应在不保存原文的前提下继续分类该流，再用真实 Windows WebView/ConPTY 重现候选环境，之后才评估产品白名单是否需要改动。

提交 `6746cf5` 新增仅 `dev-tools` 可用的 `powershell_conpty_probe`，直接通过 `portable-pty` 创建 Windows ConPTY，沿用四组环境、正反顺序和每样本新进程；`a73fbf5` 修正 ConPTY 控制序列解析，`eea39b7` 修正命令回显抢先匹配 marker 的探针 framing。它不改产品白名单或 `local_shell.rs`。准确提交 `eea39b7` 的[诊断工作流 39749668866](https://github.com/mofyer/new-windterm/actions/runs/39749668866) 中，Windows Server 2022/2025 各 8/8 ConPTY 样本均 `PASS`、exit 0；整条工作流仍因原 stdio job 的 392 字节未知 stderr 严格检查失败，不能记作整体通过。

| 直接 ConPTY 测量 | Windows 2022，首次 Get-Location | Windows 2025，首次 Get-Location |
| --- | ---: | ---: |
| 继承 | 53.9–281.8 ms | 35.2–165.9 ms |
| 产品白名单 | 26,259.7–28,182.8 ms | 11,294.0–15,891.9 ms |
| 白名单 + 父 `PSModulePath` | 20,808.8–20,837.7 ms | 11,004.3–11,100.1 ms |
| 继承 − `PSModulePath` | 54.0–54.8 ms | 34.8–35.3 ms |

这证明此前的白名单与继承环境差异可在真实 Windows ConPTY 层复现；但 ConPTY 中仅加回父 `PSModulePath` 仍保持高延迟，不能把 stdio 实验里的 `PSModulePath` 关联当成已锁定因果。它仍不能区分 Tauri/WebView 启动链、PowerShell 模块初始化或其他受控环境差异，也不等于产品场景已经通过。下一步应继续对未知 stderr 做不留原文的分类，并在真实 WebView 场景做最小候选复现；在此之前不改产品白名单、不放宽 30 秒断言、不请求合并第四批。

提交 `8785f0d`、`03ffcb9` 仅增强诊断侧 stderr 取证：按有界行缓冲处理跨 chunk 数据，规范化 BOM/NUL/CSI 控制序列和 CR，并加入长度之外的 SHA-256 指纹；不保存 stderr 原文，未知仍严格失败。Node helper 为 16/16。准确提交 `03ffcb9` 的[复测 39756049365](https://github.com/mofyer/new-windterm/actions/runs/39756049365) 中，两个 stdio 作业的正常样本仍为 392 字节未知 stderr、`knownBytes={}`，且 Windows 2022/2025 的指纹均为 `a3639af5e23464fc391dae127fd5493f02c8178068a35866d9c7fdd35dcd623f`；这证明输出在本轮跨平台、跨环境一致，但没有原文就不能判断来源或安全性。Windows 2022 另有一个白名单样本 60 秒超时且无 stderr，仍判失败。

同一复测的直接 ConPTY job：Windows 2022 为 8/8 成功；Windows 2025 为 6/8 成功，首轮白名单与加回父 `PSModulePath` 各有一次 30 秒 marker timeout，反向轮仍取得约 22.95–23.84 秒结果。上一轮 `39749668866` 的 Windows 2025 ConPTY 为 8/8 成功，因此当前应记录为间歇性诊断不稳定，而不是产品行为已回归或已稳定通过。两轮均没有改变产品代码、白名单或 30 秒断言。

提交 `b0b8b54` 增加显式 workflow 选项 `windows_webview_timing`，只在真实 native WebView runner 中记录单调时钟差值，不记录终端原文；默认关闭，生产代码与默认 native 输出不变。带 `native_only=true`、`windows_shell_repeats=3`、`windows_webview_timing=true` 的[真实 WebView 复测 39759997877](https://github.com/mofyer/new-windterm/actions/runs/39759997877) 在 Linux WebKitGTK 和 Windows WebView2 两个 job 均成功。Windows 基础场景加三次重复共 8 个初次/重开样本，PowerShell `5.1.20348.5622` 身份与精确中文 cwd 均通过：

| Windows WebView2 计时 | 样本范围 |
| --- | ---: |
| `open → 本机 shell 已启动` | 83.7–114.0 ms |
| 版本命令发送 → 精确版本行 | 522.8–766.4 ms |
| `(Get-Location).Path` 发送 → 精确 cwd 行 | 17,814.4–27,672.2 ms |

这把延迟定位到真实 WebView2→产品 PTY→Windows PowerShell 的可观测链路，且与历史 20 秒级目录停滞一致；它仍不区分 Tauri IPC、ConPTY、PowerShell 初始化或环境策略中的具体环节，也不等于根因已确定。Linux WebKitGTK 同轮成功只证明该平台原生 smoke 通过，不外推 Windows 时延结论。

对同一工件中的 8 份 Windows shell trace 做了只读复核：每个初次/重开样本的 cwd 回车事件之后，首个 `pty_write` 与首个数据回流分别在约 0–4 ms、约 2–4 ms 内出现；18–28 秒的主要间隔发生在 trace 捕获到回车之前。这个结果排除了“回车已进入 WebView 后，ConPTY/PowerShell 执行到首个回流”作为该轮主要延迟段，但 trace 没有 Node WebDriver 调用的起点，不能单独归因于 WebDriver、WebView 输入调度或前端事件循环。下一步仍是针对 Windows 输入/IPC/PTY 边界做最小组件分层复现，不改产品白名单或放宽原断言。

提交 `564aa3a` 只在 timing 开关开启时记录 `typeInTerminal` 的 Node 侧输入调用时长，默认行为不变。对应的[真实 WebView 复测 39764709186](https://github.com/mofyer/new-windterm/actions/runs/39764709186) 中，Windows WebView2 与 Linux WebKitGTK native job 均成功；Windows 8 个初次/重开样本的 `cwd-typeInTerminal` 为 62.7–68.5 ms，而 `cwd-send-to-row` 为 21,783.2–30,204.8 ms。同批 Windows trace 的 cwd 回车事件后首个数据回流为 2.7–5.9 ms。该结果把主要间隔进一步收窄到输入调用返回之后、页面事件/回读之前，但没有 Node 与 WebView 共用的跨时钟标记，仍不能单独归因于 WebDriver、WebView 输入调度或前端事件循环。

提交 `263658e` 在 timing 开关下增加可选的输入边界阶段标记：`webdriver-input-return`、`webview-keydown-enter`、`pty-write-enter`、`first-data-after-enter`；默认关闭，不记录终端原文，也不改变产品门禁。对应的[真实 WebView 复测 39783803294](https://github.com/mofyer/new-windterm/actions/runs/39783803294) 使用 `native_only=true`、`windows_shell_repeats=3`、`windows_webview_timing=true`，Linux WebKitGTK 与 Windows WebView2 native job 均成功，10/10 场景通过。Windows 8 个初次/重开样本的 `cwd-typeInTerminal` 为 63.1–70.3 ms，`cwd-send-to-row` 为 21,596.8–27,648.6 ms，`open→ready` 约 110.9–132.6 ms。标记表明输入调用返回和 PTY 写入发生在主要延迟之前，但 `first-data-after-enter` 只表示 Enter 后首个 PTY 数据，可能是命令回显或提示符，不是精确 cwd 行；它没有统一跨 Node/WebView/PTY 时钟，不能据此归因具体组件。

直接诊断[39782434106](https://github.com/mofyer/new-windterm/actions/runs/39782434106) 仍为失败：stdio 比较步骤提前失败，测量 JSON 无可用样本但工件保留；ConPTY 在 Windows Server 2022/2025 首轮产品白名单均出现 marker timeout，2025 的首轮白名单加回父 `PSModulePath` 也超时，后续轮次出现约 21–24 秒慢样本而继承环境约 57–71 ms。未知 stderr 仍按严格规则阻塞，ConPTY 首轮现象为间歇性诊断不稳定，Windows 目录停滞根因仍未确定。该轮不能改写为诊断通过、产品根因已定或第四批已完成。

提交 `9288f78`、`9d0a51c` 将有限环境矩阵扩展为 8 组（原四组加系统路径、身份、进程运行时、显式空 `PSModulePath`），两轮正反序、每组新进程，保留 stdio 60 秒与 ConPTY 30 秒门限、未知 stderr 严格失败和无重试。报告与 `summary.json` 只保存模式名、计数、计时、失败原因，不保存环境值；Node helper 与 Rust ConPTY 变体顺序一致，本机 67/67 helper 通过。矩阵运行 [39788501384](https://github.com/mofyer/new-windterm/actions/runs/39788501384) 已完成：Windows 2022/2025 的 stdio 各 16/16 样本均因 392 字节未知 stderr 失败；两平台 ConPTY 首轮 `product-whitelist` 均 marker timeout，其余新增变量组约 17–25 秒，继承环境约 42–72 ms。该结果说明新增四类变量不能单独消除慢路径，但仍不能归因具体变量、组件或产品根因；未知 stderr 与 ConPTY 间歇超时继续阻塞第四批验收。

提交 `9be5c39` 为未知 stderr 增加不保存原文的有界形状摘要（UTF-8、ASCII、可打印字节、控制字节、ESC、NUL、换行与回车计数），并补充隐私测试；未知类型仍严格判失败。该提交只有测试/诊断侧变更，本机 native helper 全套 68/68 通过；当时尚未取得新的 Windows 运行结果，后续实测见下文工作流 `39799065768` 与 `39804296453`。

- 原生探针已独立复核并集成，本机全套门禁与 macOS 原生操作已完成且本机独立复核 PASS；Linux native 首轮空输入失败已由第二轮 7/7 实际验证关闭。第二轮整体仍因 Windows 旧第六场景失败而未通过，根因诊断和最终综合验收未完成，两轮失败证据保留。
- Zsh 系统 `zshenv`、PowerShell 历史行为、固定 Shell 候选范围、Windows 本地盘符目录规则和 cwd/可执行文件 TOCTOU 限制继续保留。PowerShell 7 仍未完成实际启动验收；locale 变量可传递不等于所有 locale 行为已验证。
- 本批不交付任意启动参数、启动后命令、持久化、WSL、Git Bash/Cygwin 或 Clink；完整 T34、P1、164 项功能对齐与发行验收均未完成，P0 不重开。
- 推进范围为 `p1/integration`。第三批已单独批准并合并；第四批技术验收完成后另行请求 main 批准，不能复用第三批授权。

### 早期输入来源门控（`b3716ad`）

在 `pty_open` 尚未返回本地 PTY ID 时，用户按键、粘贴、`insertText` 和二进制输入不再进入 early FIFO，避免连接建立后被延迟重放；本地 shell 的显式 CPR reply 仍通过有界 FIFO 保留，并在退出、启动失败、关闭和重开时清空。VT adapter 通过公开的同步 `onReply` hook 标记协议回复，CPR 在 normal/DECOM 两种状态下均由 adapter 显式应答，未使用 xterm 私有 `_core` API。实现提交为 `85ce71b`、`b3716ad`。

本机 `apps/desktop` 构建通过；在 Vite ready 后运行的定向回归共 **145 passed / 0 failed**，覆盖 `pty-ui-contract`、VT adapter contract/spec、VT52、keys、paste、wide 和 IME。该证据仍是浏览器与 stub 契约级验证，不等于真实 PTY、WebView、Windows ConPTY、IME 或启动后命令验收；Windows 目录停滞、392 字节未知 stderr 和 ConPTY 间歇超时仍未解决，第四批仍不得宣称完成或请求合并 `main`。

### 八组环境矩阵复测（工作流 `39799065768`）

从包含 `9be5c39` 的 `a598a6a` 手动触发同一双平台诊断，保持八组环境、正反顺序、每样本新进程、60 秒 stdio/30 秒 ConPTY 门限、未知 stderr 严格失败和无重试。工作流整体失败，但取得了可复核的新样本：

- Windows 2022 与 2025 的 stdio 均完成 16/16 样本，均因 392 字节未知 stderr 严格失败。两平台的每个正常样本都为 2 个 chunks、392 字节、全为有效 UTF-8/ASCII，390 个可打印字节，控制字节/ESC/NUL 为 0，CR/LF 各 1，SHA-256 均为 `a3639af5e23464fc391dae127fd5493f02c8178068a35866d9c7fdd35dcd623f`；报告未保存原文。
- stdio 首次 `Get-Location` 在 Windows 2022 的继承环境为 42.7–686.3 ms，产品白名单为 16.95–27.70 秒；白名单加回父 `PSModulePath` 为 23.5–23.6 ms，继承环境移除该变量为 69.8–70.1 ms。Windows 2025 继承环境为 53.8–360.6 ms，白名单有一次 17.74 秒样本和一次 60 秒超时；加回父 `PSModulePath` 为 26.1–28.7 ms，移除该变量为 81.2–90.7 ms。系统路径、身份和进程运行时组仍为约 16.9–23.4 秒，显式空 `PSModulePath` 为约 24.8–33.3 ms。
- 直接 ConPTY 的 Windows 2022 取得 16/16，继承环境约 56–359 ms，产品白名单约 20.9–28.6 秒，白名单加回父 `PSModulePath` 仍约 21.0–21.3 秒，系统路径/身份/进程运行时/显式空变量组也约 21.0–21.2 秒；继承移除 `PSModulePath` 约 57 ms。Windows 2025 取得 15/16，首轮产品白名单 marker 超时，其余白名单相关组约 22.0–25.5 秒，继承与移除 `PSModulePath` 仍约 68–77 ms。

这轮进一步确认 stdio 中的慢路径与环境策略存在稳定关联，并显示直接 ConPTY 中“加回父 `PSModulePath`”不能消除慢路径，因此尚未锁定具体变量或组件因果。未知 stderr、ConPTY 超时和 WebView2 cwd 延迟仍是未完成边界；没有修改产品白名单、门限或原生验收断言，第四批仍未完成，`main` 仍不应合并。

### 受控 stderr 对照与矩阵复测（工作流 `39804296453`）

提交 `aa75269` 新增独立 PowerShell stderr fixture，使用固定的 warning、error、empty 和 unknown 四个命令，设置 30 秒 timeout timer、16 KiB 捕获上限，只输出分类、计数、字节形状与 SHA-256。该版本超时后只请求 `child.kill`，不是已验证的有界终止保证。初次对照 `39803261358` 的 warning/error 预期不符；`7c06cab` 将 Windows PowerShell 5.1 的这两类输出继续保留为 `unknown`，使对照断言准确描述已观测行为，没有改变 latency 探针对未知 stderr 的失败规则，也没有把包装结构认定为已解码。

[复测 39804296453](https://github.com/mofyer/new-windterm/actions/runs/39804296453) 验证精确提交 `7c06cab290aa09cb916f603f9d15892d811a1a26`，最终整体失败：两个 stdio 作业失败，ConPTY Windows 2022 失败、Windows 2025 成功。两平台 stdio 作业内独立的 fixture 步骤均通过，上传的 `report.json` 完全一致，各 case 无超时、无截断、`failure=null`：

| 受控 case | 分类 | 进程退出码 | stderr 字节数 | SHA-256 |
| --- | --- | ---: | ---: | --- |
| warning | unknown | 0 | 426 | `c72fff80a021a02549cd8561cb4261c31b80a5ddbe33c87438b82e739078855b` |
| error | unknown | 1 | 789 | `20e5257b8744ac22edb102e4b9228c9c55d658c3a4d6f48e96d6757634873f5f` |
| empty | empty | 0 | 0 | 无 |
| unknown | unknown | 0 | 17 | `9fd7b1f9094853adcefaf5c57b05184379e9acdcb7988cd6e1889a4a9c16dbd9` |

三个非空 case 均为 ASCII、CR/LF 各 1、其他控制字节为 0，可打印字节分别为 424、787、15。fixture 通过只表示已知受控输入符合上述预期；不能把 error 的 exit 1 或 unknown 分类视为 latency 主测量的允许结果，也不能据此解释真实测量中不同指纹的 392 字节 stderr。

该提交本机 fixture / latency 两份定向 Node 测试为 21 passed / 0 failed。本轮 Windows fixture 未触发 timeout，不证明超时子进程已终止或 kill 失败时父进程可退出；后续独立审查发现 `child.kill` 失败时可能遗留活跃管道，后续本地修复另记如下，不能用本轮成功 case 关闭此清理缺口。

同轮两个 stdio 平台各完成 16/16 条完整测量，三阶段 cwd 均匹配、exit 0、无超时；32 条记录均为 `Process exit or stderr failure`，具体阻塞为 392 字节未知 stderr，`knownBytes={}`，形状及指纹与 `39799065768` 的正常样本一致。Windows 2022 产品白名单首次 `Get-Location` 为 20.95–29.19 秒；Windows 2025 为 21.93–57.15 秒，后者首轮仍在原 60 秒进程期限内，不能记作超时或性能通过。`cleanupSucceeded=null` 仅表示没有触发超时清理。

直接 ConPTY 的 Windows 2022 为 15/16，首轮 `product-whitelist` marker timeout；其余白名单相关组约 21.2–24.7 秒，继承与继承移除 `PSModulePath` 约 56–358 ms。Windows 2025 为 16/16，产品白名单约 17.8–24.5 秒，其他白名单相关组约 17.3–17.7 秒，继承与继承移除 `PSModulePath` 约 51–215 ms。单个平台本轮全过不关闭历史间歇超时，也不证明加回父 `PSModulePath` 已消除 ConPTY 慢路径。

本次核对使用上传的 fixture `report.json`、stdio `summary.json` / `measurements.json` 及 ConPTY 固定 PASS/FAIL 测量行。fixture 与 stdio JSON 不含 stderr 原文；ConPTY `probe.log` 同时包含编译日志和路径，不能声称整个工件已脱敏，也不把原始编译日志列为脱敏报告。下一步应对受控包装结构做独立、有界且不落原文的解析取证，再判断能否解释 392 字节流；未知流在证据充分前继续严格失败。Windows 目录停滞根因、第四批综合验收与 main 合并仍未完成。

后续本地修复 `30d294d` 仅调整 fixture lifecycle：timeout 先锁定失败结果，再请求 kill，销毁本地 stdio 并 `unref`，避免活跃句柄继续牵住诊断父进程；报告明确保留 `termination=unconfirmed`，不声称子进程已终止。本地定向测试 25/25、完整 native helper 75/75 通过；独立 reviewer 复跑定向测试并审查通过，0 阻塞。当时尚未对该修复执行 Windows CI，以上本地结果不属于 `7c06cab` 的被测结果，也不改变 `39804296453` 整体失败、未知 stderr 与 Windows 根因未定的结论。

### 有界 stderr 结构与 ConPTY 内容受限报告（工作流 `39812975794`）

本轮仅增强测试侧取证。`tests/native/stderr-structure.mjs` 在内存中识别有限 CLIXML 子集，最多保留 16 KiB，限制深度 32、节点 512、单元素属性 8；完整 UTF-8、单一固定 header/root/namespace/version 及受限语法全部满足后，才输出固定流类型计数。报告仅含固定状态、布尔值和计数，不返回原文、标签、属性值、路径或错误文本；DTD、实体声明、未知结构、拼接垃圾及非法 UTF-8 保守拒绝，超限或未观测完整结束标为截断。该字段用于比较受控 fixture 与真实 392 字节流，既不预设真实流是 CLIXML，也不改变现有 unknown 分类或任何非空 stderr 失败规则。这是有限结构识别器，不是通用 XML/CLIXML 解析器或 stderr 安全判定；格式参考 Microsoft 的 [PowerShell.exe 文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1) 与官方仓库中的 [EncodedCommand stderr 示例](https://github.com/PowerShell/PowerShell/issues/16678)，对[重复 header/root 破损情况](https://github.com/PowerShell/PowerShell/issues/12489)保守拒绝。

`tests/native/conpty-report.mjs` 将编译与探针执行分开，编译输出只在内存消费；报告只接受固定环境模式、轮次、有限计时及允许的失败类型，并保留缺样本、重复、顺序、退出码和未知输出检查。workflow 改为上传单独 `report.json`，不再上传含编译路径的原始 `probe.log`。新 runner 不修改 Rust 探针、产品白名单、八组正反序矩阵、30 秒单样本 ConPTY 或 60 秒 stdio 期限。

上述测试侧实现及 workflow 已提交并推送为 `67d7f37`；本机完整 native helper **110/110 通过**，独立 reviewer 复跑同套测试通过并审查通过。Windows 2022/2025 [新取证 39812975794](https://github.com/mofyer/new-windterm/actions/runs/39812975794) 的精确 HEAD 为 `67d7f37a4d1a40c6e027b0da28ae65fd76d29096`；两个 stdio 作业已结束并失败，独立 fixture 步骤通过；两平台 ConPTY 测量与上传步骤均已完成，Windows 2022 成功、Windows 2025 失败。所有测量与上传步骤已完成；API 已确认 `status=completed`、`conclusion=failure`，整条工作流已结束、整体失败。本地 helper 通过不等于真实 Windows 验收通过。即使结构识别成功或某平台 ConPTY 样本完整，也不能据此关闭未知 stderr、历史间歇超时、Windows 目录停滞或第四批验收；`main` 合并仍未授权。

后续本地提交 `81d109a` 补强 ConPTY runner error-handler 及对应测试，独立 reviewer 完整 native helper 111/111 通过；该后续本地验证不属于上述 Windows 被测 HEAD。此本地结果不回填至 `39812975794`，不声称补强已在 Windows 执行。

本轮 stdio 与 fixture 已上传工件的结构字段经独立复核和固定 schema 检查：

- 两平台 stdio 各 16/16 条完整测量，三阶段 cwd 匹配、exit 0，无超时、无截断；32 条真实 392 字节 stderr 均符合有限 CLIXML 子集：`status=clixml`、16 个节点、最大深度 5，仅 `streams.progress=1`，其余流计数为 0；SHA-256 均为历史同一指纹 `a3639af5e23464fc391dae127fd5493f02c8178068a35866d9c7fdd35dcd623f`。原分类仍为 unknown，所有测量仍按非空 stderr 严格失败。
- 两平台受控 fixture 结构一致：warning 为 `warning=1` 加 `progress=1`；error 为 `error=4` 加 `progress=1`；empty 为空；17 字节 unknown 无 CLIXML header。各 case 的字节数、指纹、原分类及退出码保持上一轮预期，fixture 通过没有改变主测量规则。
- Windows 2022 最大首次 `Get-Location` 为 17,782.9911 ms；Windows 2025 为 42,757.5942 ms，后者最大 wall 为 42,908.7877 ms，均未触发原 60 秒进程期限；期限内完成不代表性能验收。

本次新增证据将 392 字节流限定为该有限语法下含单一 progress 标记的完整结构，但未保留或解释其文本、未证明无害，也未证明它导致首次目录查询变慢。stdio/EncodedCommand 结果不能替代 ConPTY 或真实 WebView 证据，现有 unknown 与失败门禁保持。ConPTY 的独立报告结果如下，不沿用历史样本数推断本轮。

本轮两个 ConPTY artifact 各只包含 `report.json`，经独立固定 schema 与字段检查，未包含原始输出或路径；均有完整的 16 个唯一环境/轮次样本。Windows 2022 构建、探针均 exit 0，16/16 通过；Windows 2025 构建 exit 0、探针 exit 1，15/16 通过，首轮 `product-whitelist` 为 marker timeout。两个报告中 build/probe 的 cleanup 均为 `termination=observed`、`treeKill=not-requested`、`localResources=released`；这些字段只证明对应 wrapper 观察到的退出与本地清理状态。

ConPTY Windows 2022 产品白名单首次测量为 21.53–29.46 秒，加回父 `PSModulePath` 仍为 21.45–21.48 秒；Windows 2025 产品白名单仅成功样本为 19.41 秒，加回父 `PSModulePath` 为 19.40–26.40 秒。两平台继承环境及继承移除 `PSModulePath` 仍为约 53–364 ms。因此新 runner 已在真实 Windows 生成内容受限报告，但慢路径及间歇 marker timeout 仍存在，不能归因具体模块、变量或产品组件，也不能将第四批标为通过。

该轮结束时的下一步候选为固定慢环境，先预注册模块命令解析与进度产生的少量因果对照及错误停止条件；后续实现见下节，不得通过抑制 progress 绕过原验收。

### 固定白名单的有限因果对照（工作流 `39816931188`）

准确提交 `d2cee0ea84ce05a67b4d3cf313c1da268b11365f` 已提交并推送至 `p1/integration`，新增独立测试侧 `powershell-causal-probe.mjs`、专项测试、双 Windows 平台工作流及[执行前预注册方案](POWERSHELL_CAUSAL_PLAN.zh-CN.md)。本机 `node --test tests/native/*.test.mjs` **129/129 通过**，独立专项复跑 **18/18 通过**，代码及实验边界审查通过；这些是本地 helper 验证，不是 Windows 实测结果。

实验固定产品白名单、PowerShell 5.1、五个 arm、正反两轮、每样本新进程，最多十个观察；比较直接目录读取、固定 `Write-Progress` 校准、默认 `Get-Location`、抑制 progress 的 `Get-Location` 和禁用自动模块导入的 `Get-Location`。严格区分内部 `elapsedMs` 与父进程 `wallMilliseconds`；类型确认的 command-not-found 仅计为观察，查询计时与 cwd 为 `null`。非空 stderr 继续严格失败，完整 progress-only 结构仅允许继续有限采集，`experimentComplete` 不等于 `strictPassed` 或产品验收。超时、协议、容量、清理或非允许结构错误停止剩余样本，无追加重试。

工作流仅对 `p1/integration` 的三个新诊断文件路径触发 push，并保留手动 dispatch；本轮首次 push 启动该准确 HEAD 的[双平台运行 39816931188](https://github.com/mofyer/new-windterm/actions/runs/39816931188)，未重复 dispatch，未编译 Rust 或重跑旧八环境矩阵。运行已 `completed/failure`，Windows Server 2022/2025 两个作业均失败，helper 检查和工件上传均成功。

两平台各取得十个预定观察：八个有效测量、两个类型确认的 command-not-found；均为 `experimentComplete=true`、`strictPassed=false`、`stopReason=null`。无超时、输出截断、协议或清理失败；所有 `cleanupSucceeded=null` 仅表示未触发终止清理，不能视为清理路径实测通过。非空 stderr 以及非成功查询的类型化缺失观察仍按预注册规则阻止严格通过。

| 平台 | 默认 `Get-Location`，第 1 / 2 轮 | 抑制 progress，第 1 / 2 轮 | stderr 变化 |
| --- | --- | --- | --- |
| Windows 2022 | 19.682 / 19.476 秒 | 19.776 / 19.656 秒 | 392 字节、progress=1 → 空 |
| Windows 2025 | 23.480 / 23.121 秒 | 23.240 / 23.120 秒 | 392 字节、progress=1 → 空 |

表中均为操作内部 `elapsedMs`。默认查询的 stderr 指纹仍为 `a3639af5e23464fc391dae127fd5493f02c8178068a35866d9c7fdd35dcd623f`。抑制 progress 后 stderr 归零，慢路径仍存在；这削弱“可见 progress 输出解释全部时延”的候选解释，但没有锁定模块加载、初始化或其他组件根因，也不构成采用抑制 progress 作为产品修复的依据。

直接目录读取的内部耗时为 5.28–8.30 ms，但两平台首进程 `wallMilliseconds` 分别为 3.049 秒和 4.233 秒；不能据此称端到端启动或查询仅需毫秒。禁用自动加载的四个观察均 exit 2，`elapsedMs`、`cwdMatches` 均为 `null`，wall 为约 187–347 ms；这是命令缺失，不是查询性能改善。固定 `progress-only` 校准在 Windows 2022 两轮为 27.507 / 19.776 秒，2025 为 37.064 / 23.362 秒，均有 830 字节、progress=3 的有限 CLIXML；它包含 Utility 命令发现与可能的模块加载/初始化，不能解读为纯输出或序列化成本。跨轮差异未排除顺序、机器缓存或负载因素。

两份 artifact 各仅包含精确 `measurements.json`，独立 schema 与隐私核验通过，未包含原文、错误文本、环境值或路径。文件 SHA-256：Windows 2022 为 `7504def2caf105402efa3ac83aeb656f16cf17292537047e1b883a3691e04231`；Windows 2025 为 `4e42c2b71c3b2c9cef5474a7f2be02dfdcaf638a5f737aeaf9f622146e052a2e`。这些是报告文件指纹，不是 stderr 指纹。

下一步限定为 cmdlet 发现、模块加载与初始化阶段的预注册诊断候选，先定义有限干预及停止条件，再执行；本轮预注册方案不按结果改判。既定协议、产品白名单和旧门禁保持；stdio 证据不外推 ConPTY/WebView2，Windows 根因与第四批验收仍未完成，P1 未通过，P2 仅可准备，main 不合并。

### 命令准备与查询阶段诊断（工作流 `39819222771`）

准确提交 `66e237e8f11034d5c837f7d84ca2b280dff1d9e0` 已提交并推送至 `p1/integration`，新增独立 `powershell-phase-probe.mjs`、专项测试、双平台阶段工作流及[执行前预注册方案](POWERSHELL_PHASE_PLAN.zh-CN.md)。本机完整 native helper **148/148 通过**，独立阶段专项复跑 **19/19 通过**，实现与方案独立审查通过；这些是本地验证。该准确 HEAD 的[Windows 阶段运行 39819222771](https://github.com/mofyer/new-windterm/actions/runs/39819222771) 已 `completed/failure`，两平台 helper 与工件上传成功，两个报告均已取得。

本轮固定 PowerShell 5.1、产品白名单与默认 progress，三个 arm（无准备、精确 `Get-Command` 准备、显式 Management 模块导入准备），各在准备后执行两个独立计时的 `Get-Location`；每平台正反两轮、六个新进程，单进程总期限 60 秒。准备耗时包含固定身份校验，查询计时不含后续编码/父进程 cwd 校验；阶段之和不作为 wall。发现/导入均可能产生预热，不能相减求纯发现或初始化成本。

任意异常、非零退出、身份/cwd/协议/容量/清理或非允许 stderr 结构错误即停止该平台，无 command-not-found 继续例外，无追加重试；完整 progress-only 结构仅允许继续采集，任何非空 stderr 仍严格失败。首次 push 只触发新阶段工作流，未重跑 Rust、旧八环境矩阵或上一轮五 arm，未重复手动 dispatch；仅上传精确 `.artifacts/p1/powershell-phase/measurements.json`。

两平台各六个预定样本完整、exit 0，所有查询 cwd 与准备身份校验均成立；`experimentComplete=true`、`strictPassed=false`、`stopReason=null`。无超时、截断、协议或清理失败，`cleanupSucceeded=null` 仅表示未触发终止清理。每平台 cold/discover 四个样本仍有 392 字节、16 节点、深度 5、仅 progress=1 的有限 CLIXML，指纹仍为 `a3639af5e23464fc391dae127fd5493f02c8178068a35866d9c7fdd35dcd623f`，严格判断失败；两个 import 样本 stderr 为空，样本严格判断通过，但不改变整个实验失败。

| 阶段或样本总耗时 | Windows 2022，第 1 / 2 轮 | Windows 2025，第 1 / 2 轮 |
| --- | --- | --- |
| cold `query-1` | 29.322 / 21.396 秒 | 28.074 / 22.752 秒 |
| discover 准备（含身份校验） | 21.381 / 21.281 秒 | 22.738 / 22.699 秒 |
| discover 后 `query-1` | 2.600 / 2.358 ms | 2.592 / 3.007 ms |
| import 准备（含身份校验） | 48.665 / 44.236 ms | 59.024 / 49.369 ms |
| import 后 `query-1` | 2.575 / 2.516 ms | 2.598 / 2.583 ms |
| import 整个进程 wall | 248.247 / 243.965 ms | 276.046 / 265.583 ms |

所有 arm 的第二次查询均为 0.232–0.374 ms。阶段内部 elapsed 不包含协议写出，查询计时不包含后续编码/父进程 cwd 校验，阶段之和不等于 wall；例如首轮 cold 的 wall 为 32.445 秒（2022）和 29.961 秒（2025），高于内部首查区间。

本轮在固定条件下观察到：精确 `Get-Command` 的准备阶段承载了约 21–23 秒慢区间，后续查询为毫秒级；显式 Management 导入及其后查询则均较快且 stderr 为空。该差异支持进一步检查命令发现/自动加载路径与显式导入路径的区别，不能把准备耗时拆成纯发现、导入或初始化成本，也不能据此宣布具体模块/变量根因。两个准备 arm 的查询均已预热，机器缓存、执行顺序与负载仍未排除；不能直接将显式导入写入产品启动或据此关闭 ConPTY/WebView2 故障。

两份精确 `measurements.json` 已通过独立 schema、边界及隐私核验，每平台 16 个阶段完整，未包含原文、路径、模块对象或环境值。报告文件 SHA-256：Windows 2022 为 `e889aa4b4bdfe7893abb8e8a383ddc13012aa1b4d460df808deea49e4617aff5`；Windows 2025 为 `a62cab7ff42fd3c4024e394a260bc76941e103e96f0733b4b575cb0721465373`。这是文件指纹，不是 stderr 指纹。本轮预注册条件保持，下一步候选为区分自动发现扫描与指定模块解析/导入，或增加真实 ConPTY 的有限对照；均须先预注册范围与停止条件，不直接改产品，不追加本轮样本或改判。P1 与第四批仍未通过，P2 仅准备，main 不合并。

### 真实 ConPTY 模块限定命令对照（工作流 `39824348485`）

本轮按[执行前预注册方案](CONPTY_QUALIFIED_PLAN.zh-CN.md)完成独立 dev-tools bin、内容受限 wrapper 与双平台 workflow。实现提交 `0940bc365849cd724041cde204d19ac9e395cb57` 以 `[skip ci]` 推送，避免 Cargo 新 bin 注册意外触发旧矩阵；再单独推送 workflow 提交 `a8e64c7260d5dfc306746b9304bbd6a3404eff9c`。本轮被测准确 HEAD 是第二提交；两个推送原计划安排一次新实验，未手动 dispatch，未改旧矩阵/产品；额外 push 调度与取消事实另记如下。

本机完整 native helper **184/184**、wrapper 专项 **36/36**、Rust 专项 **11/11**、release bin 门控 **3/3** 通过，Windows cfg clippy 与独立审查通过。Windows cfg 仅为交叉编译检查，不是 Windows 实跑。主运行 [39824348485](https://github.com/mofyer/new-windterm/actions/runs/39824348485) 已 `completed/failure`，两 job 失败、上传成功；两平台新 bin 的 Rust 专项测试及构建均 exit 0，之后实测按首失败停止规则结束，未完成四样本/平台的对照。

调度与原计划不同：同一 `a8e64c7` 出现两个 push event 运行，均不是手动 dispatch。保留先创建的 `39824348485` 为唯一主运行。后创建的 [39824353657](https://github.com/mofyer/new-windterm/actions/runs/39824353657) 已独立核验为 `completed/cancelled`，两 job 均取消、上传成功。其组合测试/构建/采样步骤确曾启动，不能写成步骤未启动；两份上传文件均是 wrapper 初始报告：`tests=null`、`build=null`、`samples=[]`，`experimentComplete`、`commandSuccess`、`diagnosticPassed` 均为 false，`failure=null`。结合先测试、后构建、再采样的代码顺序，只能确认未完成 Rust 测试、未进入采样；初始 `failure=null` 不代表通过。两文件 SHA-256 均为 `4e85bba9c94adf2aa6c31e085224065a8834cf2159a2728939153aa33feaa068`。不合并两个运行的任何证据，不将额外调度改写为预注册计划；下列实测与工件只取主运行。

固定 PowerShell 5.1、产品白名单、默认 progress，两 arm 分别调用未限定与 `Microsoft.PowerShell.Management\Get-Location`，每进程查询两次，无导入/发现预热。启动在同一 5 秒期限内先完整 CPR/响应入队再 READY；命令总窗口 30 秒、Rust 清理 5 秒、外层 worker 45 秒，首失败即停止该平台，无重试。ConPTY 合流不能判断独立 stderr 是否为空，报告明确 `stderrObservedSeparately=false`，采集完整、命令成功、诊断检查分别记录。唯一工件为 `.artifacts/p1/powershell-conpty-qualified/report.json`，不含原始终端或编译输出；旧失败、P1 未验收与 main 未授权合并边界保持。

| 平台 / 第一轮 arm | 已验证内部 q1 / q2 | startup / host / wall（ms） | 实际结果 |
| --- | --- | --- | --- |
| 2022 / unqualified | 15406.5298 / 0.1818 ms | 2180.8673 / 15700.7500 / 17911.3880 | complete、exit 0，版本/两次 cwd/清理正确 |
| 2022 / module-qualified | null / null | 216.8395 / 292.2649 / 518.1522 | `protocol-error`、exit 1、cleanup true |
| 2025 / unqualified | null / null | 2596.5489 / 30009.8372 / 32619.5311 | `command-timeout`、exit 1、cleanup true |

Windows 2022 仅取得两条记录，第二条失败后停止，反序第二轮未运行；Windows 2025 在首条失败后停止，限定 arm 及第二轮均未运行。两报告的 `experimentComplete`、`commandSuccess`、`diagnosticPassed` 全为 false，`failure=sample-failed`。失败记录确认了 PowerShell 5.1 和一次 CPR 响应，但没有收到完整合法的 RESULT，cwd 标志均 false；q1/q2 为 null 不证明命令未执行。诊断错误后清理会终止子进程，Windows 终止码可能为 1，因此失败记录的 exit 1 不能直接解释为脚本自行报错退出。2022 限定 arm 的约 518 ms wall 是失败样本总耗时，不能称为快速目录查询，也不能与成功 arm 做性能对照；2025 的约 30009.8 ms host 是轮询观察到的超时，不是查询耗时，也不表示放宽原 30 秒窗口。

所有已启动 worker 的外层清理均为 `termination=observed`、`treeKill=not-requested`、`localResources=released`，Rust 样本 `cleanupOk=true`；这说明本次已观察到退出与清理，不覆盖未触发的外层超时 tree-kill 路径。两份报告经过独立 schema、隐私、顺序及状态/计时一致性核验。文件 SHA-256：2022 为 `22a69f777ac8436bfbe6aac223dadc93ab6759ff96b510aa12ef94a686d7eeac`；2025 为 `a53f29fb7fbdc2e6a18fe11f2a192973e8c3422f02b10a77e9b86eeba863cc0e`。无完整对照结论，无根因归因。

下一步先为协议错误增加不留原文的有限阶段分类/计数，例如固定 `expectedStage` / `protocolReason`、CR/LF/光标移动/清行计数，以及 `killRequested` / `exitObservedBeforeKill`，区分解析停止位置与诊断主动终止；先补终端布局 fixture、界定解析范围并独立审查，再预注册重做对照。只读代码检查提出 CR 被忽略、CSI 光标移动被剥除而未维护屏幕行的候选解析缺口，可能影响合法终端重绘；这是待验证的代码假设，不是本轮已证根因。本轮不追加实验、不修改预注册或放宽门禁。产品启动链本身没有内置 `Get-Location` 查询，目录通过 `CommandBuilder.cwd` 配置；普通 `(Get-Location).Path` 是原生验收场景输入的命令。不能用限定命令直接替换旧验收查询掩盖慢路径，也不能称为产品修复。保留普通查询、首次/重开、中文空格路径、版本、退出及原 30 秒断言；P1 与第四批仍未通过，P2 仅准备，main 不合并。

### ConPTY 协议失败分类诊断（工作流 `39828696609`）

实现已提交推送为 `e3827ea33545c6e8c3922295a9b3bbfc5548977d`，按[本轮执行前预注册](CONPTY_PROTOCOL_DIAGNOSTIC_PLAN.zh-CN.md)在既有 worker/wrapper 增加 schema 2：固定 `expectedStage` / `protocolReason`、八项有限终端计数与 `killRequested` / `exitObservedBeforeKill`。仅提高失败可辨识性，未修改旧协议接受规则、CR/CSI 处理、arm、时限或首失败停止，也不修改旧预注册与产品。首错快照计数与最终 `mergedBytes` 的采集窗口不同；cleanup 未返回时保存入口最后可确认快照，null 清理字段不能解读为未请求终止。

本机完整 native helper **189/189**、wrapper 专项 **41/41**、Rust 专项 **15/15** 通过，Windows cfg 检查与独立审查通过。synthetic 终端 fixture 只证明解析能力与分类规则，不是真实 Windows 原始输出复现；Windows cfg 也不是 Windows 实跑。唯一新运行 [39828696609](https://github.com/mofyer/new-windterm/actions/runs/39828696609) 已 `completed/failure`，两平台失败；两报告均确认 Rust 专项测试及构建 exit 0，采样按首失败停止。

| 平台 / 第一轮 arm | 已验证内部 q1 / q2（ms） | startup / host / wall（ms） | 阶段与结果 |
| --- | --- | --- | --- |
| 2022 / unqualified | 28445.5897 / 0.1984 | 3225.1286 / 28869.7066 / 32147.0608 | `after-end`、reason null，完整成功、exit 0 |
| 2022 / module-qualified | null / null | 5004.2264 / null / 5015.7247 | `await-ready`、`startup-timeout`，exit 1 |
| 2025 / unqualified | null / null | 5009.8068 / null / 5148.2511 | `await-ready`、`startup-timeout`，exit 1 |

2022 仅两样本，限定 arm 在启动阶段失败；2025 仅首个未限定样本，限定 arm 未执行，两平台反序轮都未运行。两报告三个完成/成功字段均 false，`failure=sample-failed`。本轮两个失败样本都已有一次 CPR 响应入队，但未取得合法 READY，`versionOk=false`、q 与 host 均 null；查询脚本未进入投递阶段，不能拿失败 wall 当目录查询耗时，也不能将此轮启动失败解释成上一轮已确认版本后的协议错误或命令超时。约 5.004/5.010 秒是轮询观察到的启动超时，5 秒期限未放宽。

2022 失败首错快照为 CR/LF 各 2、`csiCursor=4`、`csiErase=0`、`markerLines=0`、`duplicateMarkers=0`、`embeddedMarkerLines=1`、`ignoredLines=2`；最终 `mergedBytes=1014`。这只表明有一条被旧解析器忽略的非空行包含 nonce 前缀，不证明它是完整 READY、真实输出而非回显，或某种重绘就是根因。2025 失败快照八计数均为 0，最终 `mergedBytes=107`；两者窗口不同，不能由零计数推断完全没有输出。成功样本版本/两次 cwd 正确，`markerLines=6`，两个失败样本未取得这些验证。

两个失败样本均 `killRequested=true`、`exitObservedBeforeKill=false`、`cleanupOk=true`，说明诊断终止前实际观察到子进程仍存活；exit 1 不能据此认定脚本自行失败。成功样本为 false/true/true。所有 worker 外层均观察到退出、未请求 tree kill、本地资源释放；不覆盖未触发的外层超时清理路径。有限分类缩小了本轮失败位置，仍没有完整性能对照或根因结论。

两平台 helper 与上传成功，唯一报告已通过独立 schema 2、隐私、顺序、状态/计时及清理字段核验。报告 SHA-256：2022 为 `44a94b4497cf66eb40d903ee7000407af8809fc45e8dac9a45cf291e88f131f7`；2025 为 `641f0dc20c49f243aa2f53d78ded1dece9351633cde30b038cd8b2f4acc3f41f`。下一步先预注册独立 startup-only 诊断，不执行 `Get-Location`：在原 5 秒窗口内记录 READY 脚本实际写入完成布尔值/时点，区分严格行首 READY 与嵌入完整 READY 形状；先补有限 fixture、独立审查，仅增加分类，不作为放行或延长门限，不扩大查询/环境矩阵；本轮不回填成功、不改预注册、不追加运行。

本轮沿用现有 workflow 的 push 触发，已核对该准确 HEAD 只有一个 push 运行，无重复调度，不再使用旧两次推送策略或额外手动触发；每平台仍最多四个 fresh worker、正反两轮，每 worker 两查询，首失败即停止且不追加重试。两 arm 的 READY 启动脚本相同，查询差异只在 READY 后，因此不能把本轮限定 arm 的启动失败归因于限定语法或模块加载。唯一上传文件仍为内容受限 `report.json`，不保存原始终端或构建输出。ConPTY 合流仍不能证明独立 stderr 为空；旧失败、普通原生验收查询及全部门禁保持，P1/第四批未验收，P2 仅准备，main 不合并。

下一轮另一个待预注册候选是模块分析缓存路径变量：Microsoft 说明 Windows PowerShell 5.1 的模块分析缓存保存模块导出命令信息，`PSModuleAnalysisCachePath` 须在 PowerShell 启动前设置；runner-images 固定源码设置该变量，脚本提示缓存预热可改善首次调用约 20 秒的等待。[Microsoft 5.1 文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1?view=powershell-5.1#module-analysis-cache)、[runner-images 固定提交](https://github.com/actions/runner-images/blob/416ad027415129c880fc76669a2c063b0a39b4a0/images/windows/scripts/build/Configure-PowerShell.ps1#L12-L20)。产品白名单未保留该变量、既有矩阵未单独检验；当前 runner 的实际值及缓存状态尚未核实，源码及其提示不是本轮根因证据。可另行预注册仅记录存在性布尔值、单变量加回/移除的有限对照，并与协议解析失败隔离，不在本轮临时追加样本或修改产品。

### ConPTY startup-only 写入与 READY 分类诊断（工作流 `39833719372`）

按[启动诊断预注册](CONPTY_STARTUP_PLAN.zh-CN.md)，实现与方案提交 `7aadab600a7c89d4235df239c9c0bf4b12723e66` 使用 `[skip ci]` 推送，避免同 Rust 文件触发旧 qualified 矩阵；随后仅推送独立 startup workflow，准确被测 HEAD 为 `fc3ff2d199a6ec87749afc164a5f9eff917abdb9`。本机完整 native helper **237/237**、startup wrapper 专项 **48/48**、Rust 专项 **19/19** 通过，Windows cfg 与独立审查通过；交叉编译与 synthetic fixture 不等于 Windows 实跑。唯一 push 运行 [39833719372](https://github.com/mofyer/new-windterm/actions/runs/39833719372) 已 `completed/failure`，两 job 失败；两平台 helper、Rust 测试与构建通过，实际采样随后按首失败停止。

已复核实现提交 `7aadab6` 没有运行，准确 workflow HEAD 只有上述一个 push 运行，无重复调度或额外 dispatch。本轮每平台最多两个同构 fresh worker，固定产品白名单与 PowerShell 5.1，不执行 `Get-Location` 或其他查询/模块预热，不混入缓存变量矩阵；同一 5 秒窗口内 CPR 响应先于 READY，外层 45 秒总保护覆盖此前 setup。实际 write/flush 完成时点与宿主收到确认分别解释，严格 READY 与 ACK 均在原 deadline 前确认才记 `startupComplete=true`；嵌入完整 READY 只计数、不放行。整体 `complete` 还要求退出与清理成功，报告分别汇总 `startupSuccess`、`experimentComplete`、`diagnosticPassed`，第二 worker 启动后失败也保留已取得的启动成功证据。首失败停止，不追加重试。

| 平台 / 样本序号 | 实际 READY write/flush 时点（ms） | startup / wall（ms） | strict / embedded READY | 实际结果 |
| --- | --- | --- | --- | --- |
| 2022 / 1 | 146.6556 | 4483.0913 / 4577.8201 | 1 / 0 | `startupComplete=true`、`complete=true`，exit 0 |
| 2022 / 2 | 6.2963 | 5004.5062 / 5015.0771 | 0 / 1 | `await-ready`、`startup-timeout`，startup/complete false，exit 1 |
| 2025 / 1 | 12.6397 | 4459.7464 / 4477.8013 | 1 / 0 | `startupComplete=true`、`complete=false`，`after-ready` / `exit-error`，exit 3221225786 |

三个样本均 `readyWriteCompleted=true`、CPR 1、`cleanupOk=true`。2022 第二样本的脚本实际写入/flush 早于原 5 秒 deadline，但没有严格行首 READY；`embeddedReadyCount=1` 只证明 ANSI 剥离后的 LF 终结行中，在非零 offset 出现完整 nonce + `READY|5.1.a.b` 后缀，仍未放行。其首错计数为 CR/LF 各 2、CSI cursor 4、erase 0、marker 0、duplicate 0、embedded marker 1、ignored 2；最终合流 1014 字节。它比上一轮“只含 nonce 前缀”的观测更具体，但没有保存行内容或控制序列参数，不能据此确定屏幕布局、回显或解析根因。约 5004.5 ms 是轮询超时观测，不放宽原 5 秒限制。

2025 首样本已在原窗口内完成严格 READY 与写入确认，必须记为启动成功后的退出异常，不能称启动失败或查询超时。其 `killRequested=false`、`exitObservedBeforeKill=true`，说明诊断清理未调用 kill 且先已观察到退出；这只排除显式 child.kill，不排除清理关闭输入端的时序影响，只凭 exit 3221225786 不能归因终止来源或底层机制。2022 成功样本同为 false/true；2022 超时样本为 true/false，exit 1 可由诊断清理终止产生，不能认定脚本自行失败。三个 worker 外层均观察到退出、本地资源释放、未请求 tree kill；这不覆盖未触发的外层终止路径。

2022 保留两样本，2025 首错后停止、第二样本未运行。两报告 `experimentComplete`、`startupSuccess`、`diagnosticPassed` 均 false，`failure=sample-failed`；2025 聚合 `startupSuccess=false` 因未完成两个预定启动，不抹去首样本 `startupComplete=true`。没有完整双平台启动验收，更无目录查询或产品修复结论。

两报告已通过独立 21 键 schema、八计数边界、隐私、样本顺序/首停、状态聚合与清理字段核验。文件 SHA-256：2022 为 `f2059d53e451756369382778bcd171897cefbe66575e40c3c05da45e1b007bd5`；2025 为 `e7494b7cb6edf928a7086dd672549198cde86287596f7b3504a39f98ceaed42d`。报告结构核验通过不等于诊断通过，本轮预注册不按结果改判。

下一步分开处理两类现象，先离线验证：2022 用既有 xterm 的固定合成 fixture 核定行边界、CR/CSI 处理能力，再评估严格解析修复，不能直接把“包含完整 READY”改为通过；2025 审计 `exit 0` 的实际 write/flush 确认与 writer 关闭先后，建立有界生命周期 fixture。当前实现只将 `exit 0` 入队而无专门 ACK，cleanup 先 `drop(io.input)` 再等待退出，writer 排空后关闭输入端；这是待验证的生命周期候选，不是本次退出原因已定。任何下一次 CI 均另行预注册，本轮不改不重跑，也不承诺新增计数或环境矩阵。模块分析缓存仍为独立后续候选，不能把它与 READY/退出异常混为同一根因。

唯一上传 `.artifacts/p1/powershell-conpty-startup/report.json`，原文、nonce、路径、环境值和构建输出不落工件。ConPTY 合流不能证明独立 stderr 为空；本轮不评价查询耗时、不回填旧失败、不修改产品或原生普通查询门禁。P1/第四批未验收，P2 仅准备，main 不合并。

### 2026-10-25：离线行布局验证与诊断退出时序修复

集成提交 `d85ed99c3321a5f11df798d89103b537f7666866` 增加共享固定 fixture、真实 xterm 测试及[离线专题](CONPTY_OFFLINE_VALIDATION.zh-CN.md)；`5eed8850aefb802d244e1507a37c6d1f050977fb` 修复 startup-only 诊断的退出时序。两提交使用 `[skip ci]`，本轮不触发新 Windows 实测，旧运行 `39833719372` 保持失败。

15 个固定人工案例分别通过真实 xterm 6.0.0 的 977 种分块和实际 Rust Parser 的 962 种分块。CR/CSI 可使屏幕独立行与字节行不同；反向案例也显示屏幕已清除而流解析器仍保留记录。该证据不能确定 Windows 2022 的实际控制序列，不改变严格 READY 接受规则，不以包含 marker 替代协议边界。

生命周期 fixture 使用实际 writer 队列和受控子进程状态。将同一测试临时恢复旧关闭顺序后，`!closed_while_running` 断言失败；恢复修复后全部通过。新策略仅用于成功启动后的 startup-only 清理：确认 `exit 0` 的 write/flush，并在等待退出期间保留输入端；ACK 与退出共用原 500 ms，原内部 4.5 秒/外部 5 秒清理界限不变。未确认写入保留 `write-error`，未退出沿用有界终止，非零退出仍失败。旧 `--sample`、JSON schema、产品和原生验收逻辑未改。此修复消除已复现的诊断关闭顺序，不证明历史 `3221225786` 的具体来源。

作者与独立审查均确认本机 Rust **31/31**；check、clippy（warnings 为错误）、fmt 与 Windows cfg 全目标检查通过，后者仅类型检查。真实 xterm Playwright **15/15**、定向 TypeScript 检查通过。集成树再次运行 native helper **237/237**、Rust 专项 **31/31** 通过，diff check 通过，冻结代码与专题均获独立 APPROVE。Rust 文件 SHA-256 为 `6c2733be2edfe49da7639d751b025a52d76d55ed28e2e2c00cbc82949c54c05b`。

下一步评估明确协议记录边界的方案，并另行预注册 Windows 退出修复验证；本轮没有新 runner 工件或查询性能结论。旧失败、5 秒启动、30 秒查询及 stderr 门禁保持；P1/第四批未验收，P2 仅准备，main 未合并。

### ConPTY 退出修复的 Windows 验证（工作流 `40160768631`）

按[退出验证预注册](CONPTY_EXIT_VALIDATION_PLAN.zh-CN.md)，方案与 workflow 的标签/注释调整在同一提交推送，准确被测 HEAD 为 `7d4d7bb2c0f192743aaf4038e7d71fb8a19e9f94`。唯一 push [运行 40160768631](https://github.com/mofyer/new-windterm/actions/runs/40160768631) 已 `completed/failure`：2022 job 成功，2025 job 失败；两平台 helper、Rust 专项测试/构建与报告上传成功。实际命令、矩阵、权限与预算未变，无额外 dispatch、重复运行或追加样本。

本轮仅验证已离线审查的 `5eed885` startup-only 退出修复：两平台各最多两个同构 fresh worker、首失败停止。原 5 秒启动、500 ms 退出 ACK 与退出等待共享、4.5 秒/5 秒清理和 45 秒外层总窗不变，严格 READY 与 schema 1 的 21 键保持。`readyWriteCompleted` / `readyWriteMs` 仍只描述 READY 写入，不是 `exit 0` 的 ACK 或耗时；退出确认须结合冻结实现及最终退出/清理结果解释。

| 平台 / 样本 | READY write/flush 时点（ms） | startup / wall（ms） | strict / embedded READY | 样本结果 |
| --- | --- | --- | --- | --- |
| 2022 / 1 | 24.3591 | 3616.3425 / 3721.0963 | 1 / 0 | startup/complete true，exit 0 |
| 2022 / 2 | 6.7666 | 418.4354 / 449.793 | 1 / 0 | startup/complete true，exit 0 |
| 2025 / 1 | 7.0373 | 2123.8729 / 2197.545 | 1 / 0 | startup/complete true，exit 0 |
| 2025 / 2 | 6.1119 | 5009.9274 / 5020.9624 | 0 / 1 | `await-ready/startup-timeout`，startup/complete false，exit 1 |

四个样本均 READY write 已确认、CPR 1、cleanup true。三个成功启动样本均 `after-ready`、reason null、版本正确，完整退出成功，kill false/退出前观测 true；最终合流分别为 748、748、1102 字节。本次取得三个进入修复后退出路径并完成退出的样本，不能据此确定历史退出码来源、一般故障率或完整 Windows 修复；这些也不是目录查询测量。

2025 第二样本虽在 6.1119 ms 完成 READY 实际 write/flush，但未取得严格行首 READY；version false、strict 0、embedded 完整形状 1。首错终端计数为 CR/LF 各 2、cursor 3、erase 0、marker 0、duplicate 0、embedded marker 1、ignored 2；最终合流 773 字节。约 5009.9 ms 是轮询观察到的超时，不放宽原 5 秒期限；计数仍不能复原屏幕行或确定控制序列原因。其 kill true/退出前观测 false，exit 1 可来自诊断清理终止；成功启动后的退出修复路径未进入，不能用此失败判断该路径修复无效。

2022 的 `experimentComplete`、`startupSuccess`、`diagnosticPassed` 均 true，`failure=null`；2025 三字段均 false、`failure=sample-failed`。2025 第二样本首错后即停止，无补样本。所有外层 worker 均观察到退出、本地资源释放、未请求 tree kill；这不覆盖未触发的外层终止路径。2022 的有限平台诊断通过不等于双平台诊断或第四批通过，运行整体仍失败。

两份报告已独立核验准确 SHA/run、schema/隐私、顺序/首停、状态聚合与清理字段。SHA-256：2022 为 `7bfb06cae36f706b31df0662833a500bcd280128a1e249680e72fa5e4fb847b1`；2025 为 `12454eb038c6b6ed8c79a0aa4eb1e765bb495a2444ff7ce69403afd4667ed220`。唯一上传内容受限的 `report.json`，终端与构建原文不落工件；ConPTY 合流仍不能证明独立 stderr 为空。历史各轮结论保持，不拼接不同提交的样本或把有限成功作为根因证明。

下一步集中评估独立定界帧的 READY 方案，先离线验证防回显、控制字符串隔离、分块及重复/畸形帧，再独立审查并另行预注册；该轮结束时方案尚未实现；后续新模式见下节，本轮不改严格行首接受、不临时放行 embedded、不追加查询或环境矩阵。退出修复获得有限真实样本证据，启动行边界仍阻塞整轮；普通目录查询、首次/重开、中文空格 cwd、原 30 秒及 stderr 门禁保持。P1/第四批未验收，P2 仅准备，main 未合并。

### ConPTY READY frame 独立诊断（工作流 `40161857832`）

按[新模式预注册](CONPTY_FRAMED_PLAN.zh-CN.md)，parser 与 xterm fixture 集成提交为 `9b25ab64b1eea23107e170dc3a316e960ed9dcbf`，宿主、Node wrapper 与方案为 `3fcf5d078af00195fb41ee55933362f6140af19a`；实现第一推使用 `[skip ci]`。新 workflow 第二推的准确被测 HEAD 为 `b0ee3324ead6f18f243ab949837dde43fa0af86f`，唯一 push [运行 40161857832](https://github.com/mofyer/new-windterm/actions/runs/40161857832) 已 `completed/failure`，两平台均在前置 Cargo test 步骤失败。helper、工具链安装与报告上传成功；未进行额外 dispatch、重试或补样本。

新 `--startup-framed` 使用独立 schema 1/mode `startup-framed` 的固定 19 键报告。完整 nonce 绑定 frame 不出现在实际输入脚本回显中；CPR 回复先入 writer FIFO，READY 脚本入队成功后才 arm，合法完整 frame 与实际 write/flush ACK 均须在原同一 5 秒内确认。frame 是连续输出事件，不以 LF 或屏幕独立行判断，实际插入控制字符仍拒绝；新模式没有旧模式 16 KiB 行语义，使用最长 97 ASCII frame、有限 UTF-8/64 字节 escape 状态及 256 KiB 总输出预算。退出沿用已修复的 ACK 与 child exit 共用 500 ms、保留输入直到退出观测或有界终止；cleanup 4.5/5 秒、worker 外层 45 秒保持。startup 的 `versionOk/frameCount` 冻结，cleanup 继续拒绝重复/不完整 frame 和控制序列，不补写启动成功。nonce 不认证已知 nonce 且主动生成 frame 的进程。

作者和独立审查已通过本机全 native **293/293**、Rust 专项 **55/55**（含 parser **19/19**）、新 Node wrapper **56/56**、真实 xterm frame fixture **6/6**、Rust check/clippy/fmt 与 Windows cfg 检查。脚本回显覆盖所有切分点及逐字节，宿主测试覆盖 CPR/FIFO/arm、首错快照和 cleanup 尾部失败；这些离线检查不替代实际 Windows 结果。

本轮预注册每平台最多两个 fresh worker、首失败停止，无查询、无环境矩阵或模块预热；实际两平台都在 Cargo test 前置检查失败，因此 worker 运行数为 **0**，不能把上限记成已完成样本。

| 平台 | 报告 failure | tests exit / failure | tests outputBytes | build / samples | experimentComplete / startupSuccess / diagnosticPassed |
| --- | --- | --- | --- | --- | --- |
| Windows 2022 | `tests-failed` | `101 / process-exit` | 22846 | `null / []` | false / false / false |
| Windows 2025 | `tests-failed` | `101 / process-exit` | 22814 | `null / []` | false / false / false |

两平台 tests 进程 cleanup 均为 `termination=observed`、`treeKill=not-requested`、`localResources=released`。这只是前置 Cargo 进程退出/资源释放的证据，不是 PowerShell worker 的 cleanup 实测。`build=null` 表示 wrapper 的独立 cargo build 步骤未运行；cargo test 本身也可能包含编译过程，不能由此推断完全没有编译。没有任何 startup/frame/READY ACK/退出测量，不能称为启动超时、frame 协议失败或退出修复失败。`exitCode=101` 和输出字节数不能区分 Cargo 编译错误、测试断言失败或其他前置测试原因；原始编译/测试输出未写入工件，因此本轮尚不能定因。

两份内容受限 `powershell-conpty-framed-windows-{2022,2025}/report.json` 已独立核验准确 run/SHA、精确结构/隐私、前置失败停止、聚合与 cleanup。SHA-256：2022 为 `2fa333b5d2f3fb9865d8096879b9e885187933ceb1dd6a4b43357b4d24003441`；2025 为 `3d2c0e09b221e2796e67cd68e07fa6e50edcb122f9122d0886cbe7164c8d0e47`。报告结构核验通过不等于诊断通过，也不以本机或 Windows cfg 通过覆盖实际平台失败。

下一步只定位 Windows Cargo test 前置失败，另开局部取证，不预写原因、不重跑本轮或修改冻结代码/预注册来补成功。旧 `--sample` schema 2 与 `--startup-only` schema 1 的接受规则/结果保留，不倒推旧 embedded 已通过，不改产品白名单或原生普通查询。ConPTY 合流仍不能证明独立 stderr 为空；P1/第四批未验收，P2 仅准备，main 不合并。

### 2026-10-25：READY frame 构建前置条件的本机对照

对比上一轮 `7d4d7bb` 与本轮 `b0ee332`，旧 `conpty-startup-report.mjs` 使用 `--features dev-tools`，新 `conpty-framed-report.mjs` 使用 `--all-features`；Cargo manifest/lock、目标 bin、Windows target、Rust 1.99.0 和构建并发数 2 未改变。新增启用的 package features 为 `custom-protocol`、`pty-diagnostics`、`pty-readiness`，未发现新增外部链接库的直接证据。`custom-protocol` 经 `tauri/custom-protocol` 开启资源嵌入，`src/lib.rs:596` 的 `tauri::generate_context!()` 按 `tauri.conf.json` 读取 `../dist`；新 workflow 没有前端安装/构建步骤，`dist` 不在提交中。

锁定的 `tauri-macros 2.7.2` 在 `src/context.rs:155` 将 `custom-protocol` 下的 `dev` 设为 false；`tauri-codegen 2.7.2` 在 `src/context.rs:178–190` 跳过开发服务器路径并检查 `frontendDist`，目录不存在即报错。这是构建前置条件的源码证据，不能仅凭该分支推断历史 Windows Cargo 进程实际报错内容。

执行代理使用两个独立、精确提交均为 `b0ee3324ead6f18f243ab949837dde43fa0af86f` 的干净 macOS worktree 完成本机对照；各自开始时确认 `apps/desktop/dist` 不存在且无 `TAURI_CONFIG` 注入。使用 `rustc 1.99.0 (b940084d7 2026-09-28)`、构建并发数 2，复用本机 Cargo 缓存但切换 crate 路径。未修改受跟踪文件，未运行 Windows worker，也未创建占位资源。

| 本机条件 | 执行命令与结果 | 可以支持的结论 |
| --- | --- | --- |
| 未准备前端资产 | `cargo check --locked --all-features --bin powershell_conpty_qualified_probe` 返回 101；内存分类为 `frontend-dist-missing`，宏位置 `src/lib.rs:596` | 干净副本可复现缺少前端资产的编译前置失败；这是 check，不是测试运行或链接结果 |
| 真实准备前端资产 | Node 26.0.0 / npm 12.0.2；`npm ci` 返回 0，`npm run build`（`tsc --noEmit && vite build`）返回 0，`dist/index.html` 存在；随后 `cargo test --locked --all-features --bin powershell_conpty_qualified_probe` 返回 0，`RUST_TEST_THREADS=2`，55 passed / 0 failed | 真实前端构建后，本机同功能开关的专项测试通过；不是 Windows 链接、执行或产品验收证据 |

两条 Cargo 命令均显式指定相同 manifest 与 bin；负向运行是 `cargo check`、正向运行是 `cargo test`，不称为完全同命令的红绿测试。正向准备的 npm ci、前端构建和 Cargo test 输出字节分别为 355、440、5090；原始输出只在内存中分类，npm 文件日志关闭，未保存编译/测试原文。本机内容受限记录为 `/tmp/p1-frame-assets-positive-evidence.json`，临时路径不是公开 CI 工件。

新增 24 个 Rust 测试包括 19 个纯 parser 测试、3 个脚本/快照/schema 测试和 2 个宿主流程测试；未发现新增 Windows 专属断言。宿主测试仍有线程同步与时限，但没有证据将其认定为该轮失败原因。当前已确认一个本机可复现的构建前置缺口；历史 `40161857832` 未保留原始 Cargo 输出，仍不能确定其编译、链接或测试运行失败类别，更不能把本机对照写成 Windows 历史根因已确认。

本机对照后的独立准备流程与 Windows 验证见下节：先真实构建前端资产，再执行相同 Rust 功能开关与原 frame/ACK/退出门禁，另一次验证绑定新的准确 SHA 与唯一运行。不改旧实验判定，不放宽时限、输出或 stderr 门禁；P1/第四批未验收，P2 仅准备，main 不合并。

### ConPTY frame 真实构建准备与验证（工作流 `40163001613`）

按[独立准备预注册](CONPTY_FRAMED_PREPARED_PLAN.zh-CN.md)，新 wrapper/专项测试/方案第一推为 `06e77682b88c96b95105bcbcf5b4dc3822db1535`，使用 `[skip ci]`；新 workflow 第二推的准确被测 HEAD 为 `74c6bf97377810167fdb49af5b21016db303c7c1`，唯一 [push 运行 40163001613](https://github.com/mofyer/new-windterm/actions/runs/40163001613) 已 `completed/success`，两平台全部步骤成功，报告完成独立核验。未执行额外 dispatch、重试或补样本。

新准备 wrapper 的专项测试 **18/18**、协调者本机全 native **311/311** 通过，实现已经独立审查。准备先拒绝已有 dist，再通过已验证 npm CLI 真实执行依赖安装与 TypeScript/Vite 构建，成功后确认非软链 dist 及非空普通入口文件；两个准备步骤共享 180 秒期限，npm 文件日志关闭，原文只在内存消费。准备失败不调用 Cargo 或 worker。准备成功后复用原 framed runner：Cargo 仍为 `--locked --all-features`，测试/构建共享 14 分钟，原 frame、READY ACK、退出、清理和输出门禁不变。

新顶层 `startup-framed-prepared` 报告分别保存准备与嵌套诊断状态，准备成功不等于 startup 成功。实际两平台均取得两个顺序 worker，四个均 startup/complete true、exit 0；没有查询或环境矩阵。

| 平台 | dependencyInstall exit / outputBytes | frontendBuild exit / outputBytes | tests exit / outputBytes | build exit / outputBytes | distReady / prepared diagnosticPassed |
| --- | --- | --- | --- | --- | --- |
| Windows 2022 | 0 / 141 | 0 / 447 | 0 / 27410 | 0 / 499 | true / true |
| Windows 2025 | 0 / 141 | 0 / 447 | 0 / 27410 | 0 / 499 | true / true |

上述准备、Cargo 和四个外层 worker 进程均为 `failure=null`，cleanup 为 `termination=observed`、`treeKill=not-requested`、`localResources=released`。Windows 工件只保留 Cargo 进程结果与输出字节数，不保存测试原文，因此这里记录 tests exit 0，不把本机 55 项计数冒充为 Windows 工件中的测试计数。

| 平台 / 顺序 | startupMs | READY writeMs | wallMs | mergedBytes | 外层 worker outputBytes |
| --- | --- | --- | --- | --- | --- |
| Windows 2022 / 1 | 3508.3862 | 33.293499999999995 | 3601.8237 | 885 | 392 |
| Windows 2022 / 2 | 413.6288 | 7.152699999999999 | 445.2767 | 941 | 389 |
| Windows 2025 / 1 | 2036.043 | 8.7918 | 2110.4822 | 946 | 379 |
| Windows 2025 / 2 | 458.3029 | 7.9164 | 486.174 | 1377 | 378 |

四个测量均为 `cprReplies=1/frameCount=1/versionOk=true/readyWriteCompleted=true/startupComplete=true/complete=true/cleanupOk=true/exitCode=0`；`expectedStage=after-frame`、`failure/protocolReason=null`、`killRequested=false/exitObservedBeforeKill=true`。READY writeMs 是启动脚本 write/flush ACK 时点，不是退出 ACK。两平台嵌套 `experimentComplete/startupSuccess/diagnosticPassed` 均 true；顶层 `phase=done/status=pass/failure=null/diagnosticPassed=true`。这些结果确认本次四个有限样本的帧启动与有界退出，不证明普遍稳定、旧行协议已通过或历史退出原因。

独立审查核对了准确 run/SHA、固定 8 键顶层、准备字段、嵌套诊断及每个 19 键 worker 记录、顺序/聚合/cleanup 与隐私边界。唯一上传内容为 `powershell-conpty-framed-prepared-windows-{2022,2025}/report.json`，SHA-256：2022 为 `f27bd7189d95e636034d4fcc3ce5159839f056f5e0129afa2feeb9864fe8a482`；2025 为 `34d857fad11b71f545ab6ca5bc2ed5f01c7c094730daf74b530c39f5c26614a3`。新运行通过不改写旧 `40161857832` 的前置失败，也不补出其缺失的编译/测试原因。

下一步独立预注册严格的 frame 查询协议，分别定义 READY、查询结果与结束事件的阶段、顺序、重复及残缺规则，先完成离线和独立审查，再决定一次有限查询对照。原未限定 `(Get-Location).Path`、产品白名单、默认 progress 和精确 cwd 断言保留；两次查询及其协议仍共享从构造/投递查询脚本前开始的原 **30 秒总窗口**，不按新 frame 或第二次查询重置。模块限定命令只能作为独立对照，不能替代原生普通查询。本轮没有查询性能或独立 PowerShell stderr 证据，不解除旧未知 stderr、目录慢路径或第四批验收门禁；P1/第四批未验收，P2 仅准备，main 不合并。

协调者并行审计保留了未在本轮修复或复测的入口：旧 `.github/workflows/p1-windows-conpty-framed-diagnostic.yml` 仍可由其路径或手动 dispatch 触发，且没有资产准备；`tools/wincheck/wincheck.sh:15–16` 虽不链接，启用全部功能时仍需满足宏资产前置条件。主 `p0-cross-platform.yml` 已先执行真实前端安装/构建；本轮只隔离新 prepared 触发路径，没有统一改造其他入口。`CLAUDE.md` 的 all-features/wincheck 真实资产前置说明已另行审查并集成为 `3664ee2`；旧 frame workflow 的入口处置仍待后续，不能把文档说明补齐写成所有独立调用入口均已自动准备资产。

### ConPTY framed 查询对照（工作流 `40164795306`）

按[独立查询预注册](CONPTY_FRAMED_QUERY_PLAN.zh-CN.md)，新增 `--sample-framed <arm>` 和独立 query-framed schema 1 的 25 键报告，旧 `--sample`、startup-only 与 startup-framed 接受规则/报告保留。Rust 集成为 `d54bf6e3383552db00cd10fbe0b3cf1f8868ac5c`，Node wrapper/测试/方案集成为 `1f3d13b922ed407bdce9bf19082c6d3c487e9791`，第一推均使用 `[skip ci]`；新 workflow 第二推准确被测 HEAD 为 `8f976ea13003c523ffb9030273895391298f835b`，唯一 [push 运行 40164795306](https://github.com/mofyer/new-windterm/actions/runs/40164795306) 已 `completed/success`，两平台全部步骤成功，报告已独立核验；准确 SHA 下只有这一条 push 运行，无额外 dispatch、retry 或补样本。Node 专项 **64/64**、协调者全 native **375/375**、Rust 专项 **69/69**（旧 55 + 新 14）通过；Rust check、clippy（`-D warnings`）、fmt 与 Windows cfg 全目标/全部 feature 检查通过，Rust/Node/方案/workflow 已独立审查。真实 `Report::json` 的成功、部分前缀、READY ACK 超时和 cleanup 失败四类合成报告经 Node 接受且 deepEqual **4/4**，不把合成报告、离线或类型检查当 Windows 运行结果。

每平台最多四个 fresh worker，固定顺序 U、Q、Q、U，每 worker 两次同 arm `Get-Location`，共同使用产品白名单、精确 cwd 与默认 progress。U 保留普通查询，Q 仅作模块限定对照。READY+实际 writer ACK 均须在原 5 秒内确认；后续 START1/QUERY1/START2/QUERY2/END 共享从查询脚本构造/投递前起算的原 30 秒，不按记录或第二次调用重置。q 数值为 F4 毫秒，单次与两次合计以整数刻度验证不超过 30000 ms；startup/host/write/wall 保持宿主 f64。错误 cwd 不保存该 q 的成功测量，首错前缀保留、cleanup 不补写成功；完整成功 frameCount=6。

新入口只用既有 prepared runner 注入并映射固定外层 mode=query-framed-prepared，真实 npm ci/TypeScript/Vite 构建及日志关闭、fresh dist 检查保持，旧默认行为未改。Cargo `--locked --all-features` 共享 14 分钟，退出 ACK+child exit 共用 500 ms、cleanup 4.5/5 秒、worker 外层 45 秒保持。准备 3 分钟+Cargo 14 分钟+四 worker 3 分钟的名义上限已等于 job 20 分钟硬限，工具链、调度和清理仍占时间，可能缺样本或工件；不因此加时或补跑。

两平台均完成真实 npm ci/前端构建、Cargo test/build 与预注册的四个 fresh worker，共 **8/8 完整诊断样本**。准备的两进程均 exit 0、输出字节 141/447、distReady=true；Cargo test/build 均 exit 0、输出字节 28637/499。所有这些进程均 `failure=null`、退出已观察、本地资源释放、未请求 tree kill。Windows 固定报告只保留 Cargo 进程结果，没有逐项测试计数；本机 69/69 不写成 Windows 独立计数。两个平台顶层均 `phase=done/status=pass/diagnosticPassed=true`；内层 `startupSuccess/experimentComplete/commandSuccess/diagnosticPassed` 四字段均 true、failure null。

以下按实际 U、Q、Q、U 顺序列出；U 为普通查询，Q 为模块限定查询。表中宿主 f64 计时显示至四位小数，q 仍为本轮固定 F4 值：

| 平台 | 轮次/次序 | arm | q1 ms | q2 ms | startup ms | host ms | wall ms | READY write ms | 合流 bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2022 | 1/1 | U | 17342.7422 | 0.1699 | 3211.9918 | 17619.4187 | 20896.7053 | 22.1843 | 8653 |
| 2022 | 1/2 | Q | 22.3096 | 0.1674 | 211.6912 | 297.3112 | 528.0230 | 4.5454 | 11412 |
| 2022 | 2/1 | Q | 22.3006 | 0.1586 | 212.9802 | 296.9831 | 534.0697 | 4.4529 | 8523 |
| 2022 | 2/2 | U | 11299.5118 | 0.1351 | 207.9351 | 11572.2590 | 11814.3620 | 4.5764 | 8685 |
| 2025 | 1/1 | U | 27513.9404 | 0.1489 | 1989.8074 | 27918.6845 | 29964.2423 | 8.9844 | 14994 |
| 2025 | 1/2 | Q | 35.6962 | 0.2345 | 373.5853 | 466.8965 | 868.1061 | 7.7187 | 20283 |
| 2025 | 2/1 | Q | 37.4313 | 0.2049 | 356.8155 | 465.0755 | 849.3298 | 8.4756 | 17771 |
| 2025 | 2/2 | U | 23134.2943 | 0.1438 | 357.3973 | 23532.9733 | 23919.6881 | 7.7731 | 14481 |

八个样本均 version/cwd1/cwd2/startupComplete/complete/cleanupOk=true、CPR=1、frameCount=6、stage=after-end、failure/protocolReason=null、exitCode=0、killRequested=false、exitObservedBeforeKill=true。READY 实际 write/flush 均已确认且在原同一 5 秒内；host 均严格小于原 30000 ms。2025 第一普通样本 host 27918.6845 ms、wall 29964.2423 ms；30 秒门禁约束查询 host 窗口，wall 还包含启动和清理，两者不能混用。外层八 worker 均 exit 0、failure null，退出已观察、本地资源释放、未请求 tree kill；其固定 stdout 报告字节按平台顺序分别为 2022 的 487/475/487/487、2025 的 504/476/476/498。

本轮普通首次 q1 为 **11299.5118–27513.9404 ms**，模块限定首次 q1 为 **22.3006–37.4313 ms**；两 arm 的第二次 q2 均在 **0.1351–0.2345 ms**。这组真实 ConPTY 有限顺序对照支持未限定解析/自动加载路径与模块限定路径存在明显耗时差异，不能定位具体命令发现、模块扫描、缓存或网络根因，也不能从 q2 的可能预热表现推断首次调用已修复。模块限定只作诊断对照，不替换产品或原生普通查询；普通首次慢路径仍存在，诊断在原期限内通过不等于产品性能问题解决。

内容受限工件为 `powershell-conpty-framed-query-windows-{2022,2025}/report.json`，不保存原文、nonce、路径或环境值。独立核验包含准确 SHA/run、精确 schema/模式、准备前置、U/Q/轮次顺序、首停、数值/状态、聚合和清理。文件 SHA-256：2022 为 `92cca76e2c3cd9b39e6a36853e2450570e135849287e4a7e0b5ebf3df33d451d`；2025 为 `db2c98c0d50dc8c475d2b54abd830f99c5fa4769cc3638ef38c84bca013f239e`。不与旧提交样本拼接，不重判旧失败；ConPTY 合流仍不证明 PowerShell 独立 stderr 为空。

下一步先对照既有 ConPTY 环境干预证据，选择尚未重复的最小归因实验。历史 spawn 前加回父 `PSModulePath` 已有多轮仍慢的记录，不能将同一 A/B 再称为首次验证。候选是先以不落原值的布尔证据确认启动后实际环境是否与父值不同，再判断运行时单变量干预是否有比较意义；若无差异，不据此重复已有矩阵。该候选尚未预注册或执行，不修改产品白名单或普通查询。原生首次/重开、中文空格 cwd、原 30 秒及独立 stderr 门禁保持；P1/第四批未验收，P2 仅准备，main 不合并。

### ConPTY 运行时环境有限干预（工作流 `40166224227`）

按[独立运行时预注册](CONPTY_RUNTIME_ENV_PLAN.zh-CN.md)，新增 `--runtime-env-framed control|parent` 与固定 31 键 worker schema。观察和干预合并在同一 worker 内但拆为两个宿主门控脚本，共用从第一段构造前开始的原 30 秒窗口；READY/ACK 同 5 秒，O 观察有效且不同后才投递第二段赋值/回读/普通查询脚本。成功顺序 R/O/V/S1/Q1/S2/Q2/D，共 8 frame；O 完整不等于可干预，V 成功不等于查询或完整样本成功。

父参考值来自 worker 启动器 Process 环境，父/child 值都必须存在、非空、合法且不超过 4096 UTF-16 units，比较为 Ordinal；父缺失/空值在 spawn 前 `contrast-absent`，child 缺失/空值或相同在 O 后 `contrast-absent`，均不查询、不放行平台后续样本。非法值为 `environment-invalid`；读取异常 `environment-read-error` 保留未观察 null；赋值/回读异常 `assignment-failed` 保留 assignmentVerified=null，明确 V0 保存 false。只保存布尔状态、计时与有限原因，不保留原值或路径。Ordinal 比较仅针对整个字符串，不解析/规范化路径段、顺序或大小写，不核目录可访问性或网络；false 不证明缺少某个目录。父参考不是 PowerShell 默认值或推荐产品策略，V 只确认当次 Process 回读与目标相符，不保证跨时间状态。

每平台最多四个 fresh worker，control/parent/parent/control（ABBA）。control 赋回实际原值，parent 只替换当前 child 的 `PSModulePath`，两者都用相同 .NET Process API 并回读验证，然后执行原两次普通 `(Get-Location).Path`。`environment=spawn-product-whitelist` 仅指 spawn 八项白名单，不误称 parent arm 的查询时环境完全未变。本轮不重复已做的 spawn 前父值矩阵，不修改产品；即便有差异也只支持整个变量替换的有限效果，不定位路径段、扫描、缓存或网络机制。

Node 新专项 **96/96**、协调者全 native **471/471**、语法/diff 检查及 Node/方案/workflow 独立审查通过；实现/测试/方案来源 `ffe828c`，Rust 集成 `02218642f56aa3610bafd541f32441bd8c262e7f` 与 Node/方案集成 `ae796f5ede95635251d1414b33028bf50d2f874f` 首推均 `[skip ci]`；新 workflow 第二推准确测试 HEAD 为 `fa2a09ba9d7bbda5a0cae55dc8168a6c0729ca97`，唯一 [push 运行 40166224227](https://github.com/mofyer/new-windterm/actions/runs/40166224227) 已 `completed/success`，两平台全部步骤成功；准确 SHA 下 run list 仅此一条 push，无额外 dispatch、重试或补样本。Rust 专项 **77/77** 在审查修正前通过；审查发现赋值异常 catch 必须阻止后续查询、生产序列化不能依赖仅 dev 可用的 serde_json，两项均在 Windows 实测前修正，未改 Cargo 依赖。修正后脚本门控定向 **1/1**、固定 JSON 序列化定向 **1 test / 13 cases**，真实 Rust JSON→冻结 Node 接受与 deepEqual **13/13**；check/clippy（`-D warnings`）/fmt 及最终 Windows cfg 全目标/全部 feature clippy 通过，Rust 最终独立审查批准。没有把审查前 77/77 写成最终哈希完整重跑，也不把离线/类型检查当 Windows 运行。Windows 工件及实际观察/赋值/查询状态已独立核验，有限结果见下表。新入口复用原 prepared 层且不修改其默认行为，真实前端准备 3 分钟、Cargo `--locked --all-features` 14 分钟、四 worker 各 45 秒的名义总上限已到 job 20 分钟，工具链/调度/清理还占时间；硬限不扩，缺样本不补跑。首失败保留合法前缀、不追加观测轮，旧实验结论不变。ConPTY 合流仍不证明独立 stderr 为空，P1/第四批未验收，P2 仅准备，main 不合并。

两平台均完成真实 npm ci/前端构建、Cargo test/build 和预注册的四个 fresh worker，共 **8/8 完整诊断样本**。准备进程 exit 0、输出字节 141/447、distReady=true；Cargo test/build exit 0、输出字节 29371/499。各进程均 failure null、退出已观察、本地资源释放、未请求 tree kill。Windows 工件只有 Cargo 进程结果，没有逐项测试计数，不能补写 Windows 77/77。

八个样本的环境六字段均为 `parentPresent=true,parentUsable=true,effectivePresent=true,effectiveNonempty=true,effectiveEqualsParent=false,assignmentVerified=true`：完整 O 证明当次父/实际字符串有效且 Ordinal 不同，V 证明各 arm 目标值已在 child Process 中回读确认。parent arm 实际完成运行时替换，control 实际赋回原值；本轮未触发 contrast-absent、值无效或赋值失败路径。以下按 ABBA 原顺序列出，宿主 f64 显示至四位小数，q 保留 F4：

| 平台 | 轮次/次序 | arm | q1 ms | q2 ms | startup ms | host ms | wall ms | READY write ms | 合流 bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2022 | 1/1 | control | 16859.9057 | 0.1520 | 2940.8183 | 17581.7745 | 20588.5628 | 20.3695 | 38901 |
| 2022 | 1/2 | parent | 11405.0151 | 0.1336 | 225.4758 | 12099.2211 | 12364.4862 | 5.2175 | 35050 |
| 2022 | 2/1 | parent | 11615.0356 | 0.1557 | 207.1660 | 12286.2783 | 12517.7345 | 4.6952 | 40262 |
| 2022 | 2/2 | control | 11578.1321 | 0.1346 | 217.2241 | 12299.5081 | 12556.8397 | 4.9832 | 32926 |
| 2025 | 1/1 | control | 28551.4060 | 0.2974 | 2177.7939 | 29669.0781 | 31907.8537 | 11.6208 | 66902 |
| 2025 | 1/2 | parent | 22326.6272 | 0.3239 | 425.2677 | 23410.3500 | 23872.4836 | 9.3978 | 62480 |
| 2025 | 2/1 | parent | 22985.8476 | 0.3291 | 422.9253 | 24067.3103 | 24527.5739 | 11.5402 | 65751 |
| 2025 | 2/2 | control | 22421.7305 | 0.2688 | 431.8012 | 23495.5045 | 23962.0467 | 11.4074 | 65079 |

所有样本 version/cwd1/cwd2/startupComplete/complete/cleanupOk=true、CPR=1、frameCount=8、stage=after-end、failure/protocolReason=null、exitCode=0、killRequested=false、exitObservedBeforeKill=true。READY write/flush 均在原启动 5 秒内，host 均小于原 30000 ms；2025 首 control 的 q1=28551.4060 ms、host=29669.0781 ms、wall=31907.8537 ms。wall 包含启动、host 与退出清理，超过 30 秒不等于查询超时；外层 worker 原上限是 45 秒，本轮没有放宽门限。八个外层 worker 均 exit 0、failure null、退出已观察、本地资源释放、未请求 tree kill；stdout 固定报告字节为 2022 的 635/633/632/642、2025 的 638/643/634/638。

两平台顶层 `phase=done/status=pass/diagnosticPassed=true/failure=null`，内层 `startupSuccess/experimentComplete/commandSuccess/diagnosticPassed` 均 true。此处通过的是有限观察、宿主门控、赋值、普通查询、退出和清理诊断，不表示慢路径已修复或所有边界已由 Windows 触发。

运行时 parent 替换后，2022 首次 q1 仍为 **11405.0151/11615.0356 ms**，2025 为 **22326.6272/22985.8476 ms**；各平台第二个 control 分别为 **11578.1321/22421.7305 ms**，与 parent 样本接近。各平台第一个 control 更慢（16859.9057/28551.4060 ms），不能把第一次与后续样本的差异直接当替换效果，顺序/缓存/宿主负载等仍可能影响。两 arm 第二次 q2 为 0.1336–0.3291 ms，可能已被第一次预热。本轮已验证存在可用差异并确实赋值，但 **没有消除秒级首次慢路径**，削弱“单独运行时恢复父 PSModulePath 足以修复或充分解释该延迟”的候选；不等于完全排除该变量及其与其他因素的交互，也不定位具体路径或内部机制。

内容受限工件 `powershell-conpty-runtime-env-windows-{2022,2025}/report.json` 已独立核验准确 run/SHA、固定 schema/枚举、环境三态与阶段/count/cwd 关系、ABBA 顺序、准备前置、首停、聚合与清理。SHA-256：2022 为 `6c2a7537630539c5e6206517914c29e6d5628f76d4aaacbbb34cc4671ac8af21`；2025 为 `63a7e55e97d456d4e73771953179fadee2e4f6aca18d8491dc4470359883ace5`。工件不保留值、路径、脚本或原始输出；ConPTY 合流仍不能证明 PowerShell 独立 stderr 为空，不重判历史失败或拼接不同提交样本。

下一步候选转向尚未在真实 ConPTY 完成的精确命令发现/显式 Management 模块导入阶段对照。既有 stdio `39819222771` 的精确 Get-Command 约 21–23 秒、显式导入约 44–59 ms，仅是跨层线索；若立项，应先独立预注册 D/I/I/D 的准备阶段及随后原两普通查询，共用原 30 秒窗口，不把 stdio 数值移作 ConPTY 证据，不把操作时间称为纯发现/纯加载或通过相减归因。该候选本轮未实施、未预注册，不再追加环境 arm 或重跑已完成 ABBA。产品白名单、普通原生查询与首次/重开、中文空格 cwd、独立 stderr 门禁保持；P1/第四批未验收，P2 仅准备，main 不合并。
