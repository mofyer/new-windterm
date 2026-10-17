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
- 本批尚未合并 main，第一批条件授权不延伸到本批。完整门禁与独立验收通过后再请求合并确认。

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

### 第二批最终验收：通过，等待 main 合并批准

独立 verifier 核对第二轮精确 SHA、七个作业及行级工件后给出 **PASS / APPROVE，0 个技术阻塞**。macOS Rust 219/0/33，Linux 218/0/33，Windows 2022/2025 各 212/0/7；Windows 专属路径规则测试实际通过，独立 ConPTY 诊断各 2/0/0。Linux lrzsz 11、X11/agent 各 1、GSSAPI 3 单测/4 认证/3 健康复验均通过；Linux/Windows 原生各 5/5。Unix 四组默认/readiness 探针全部读回指定目录两次并完成 12 次关闭回归；macOS 单轮 WKWebView 证据已独立看图复核。

第二轮 macOS 默认 2 MiB 为 33.57 秒、readiness 0.64 秒，保留为预算内诊断，不替代 P1 性能专项。Windows 2022 的既有 ConPTY 系统句柄增长与 portable-pty 最后校验后的目录竞态仍按上文保留；不宣称完整 Windows、T34、P1 或产品发行通过。第二轮工件本机归档到 `.artifacts/p1/batch2/ci-second/`。

本批实现、独立审查、本机门禁、三端有限原生验证及跨平台 CI 均完成。`main` 仍为 `bdcbb3e`，尚未取得本批合并授权；已推送的集成代码及本记录供用户确认，后续仅补文档不重复触发代码 CI。下一切片按计划推进 Shell 发现/选择及缺失反馈，启动参数/env/locale 分批验收。
