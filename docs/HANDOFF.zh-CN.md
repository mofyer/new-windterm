# New WindTerm 交接词

以下内容可直接复制给下一位模型，作为本项目继续工作的上下文。

---

你正在接手公开仓库 `https://github.com/mofyer/new-windterm`，本地目录为 `/Users/yafan/Workspace/www/new-windterm`。

- **目标**：使用 Rust + Tauri 2 + xterm.js，独立重构 WindTerm 2.7.0 的完整已有功能。
- **视觉方向**：现代苹果风。浅色为 Silver Soft UI，深色为中性 Carbon Dark。
- **许可证**：Apache-2.0。
- **平台**：macOS Apple Silicon 优先，但 Windows/Linux 从架构和测试层面同步考虑。

用户的明确要求：
- 功能一致，允许更新 UI 风格。
- 不能因为先做 macOS 就删减 Windows/Linux 或 WindTerm 的功能。
- P0 三个决策包已完成且技术出口独立评审 PASS，用户已确认关闭 P0；不能宣布完整重构完成、P1 通过或产品可用。

仓库根目录的 `CLAUDE.md` 汇总了命令、架构和约定，接手后先读。

2026-10-11 至 10-13 的进度、方案、过程和结论，以及在途任务所在的 worktree，归档在 [P0 工作归档](p0/P0_ARCHIVE_2026-10.zh-CN.md)。

## 当前仓库状态（2026-10-25，P0 已关闭，P1 第四批实施中）

P1 从已合并的 `a35582f` 开始，当前集成分支为 `p1/integration`。第一批修复本地终端失败/退出状态及显式重新打开，配套浏览器竞态和原生场景；第二批已交付启动目录配置，后续继续按切片推进。当前计划与新代码证据见 [P1 计划](p1/PLAN.zh-CN.md) 和 [P1 执行记录](p1/RESULTS.zh-CN.md)。下列 P0 记录保留作历史依据，P0 不再重开；P1 新批次合并 main 仍需用户确认。

第一批最新被测提交 `645ed38` 的第四轮 CI 7/7 通过，本机浏览器 376、Rust 211、真实 OpenSSH 11 项通过。`P1-PTY-CLOSE-001` 已通过确定性红绿回归与真实 A/B 定位并修复同路径的 Unix 资源等待机制：先释放全部 I/O 并回收 writer，再等待 child；两种后端在 macOS CI 的最大关闭等待降至 360/341ms。历史第二轮具体卡点因没有 trace 无法追溯，原失败记录仍保留。独立技术验证 PASS，P1 整阶段尚未完成。

用户随后明确选择「先定位并修复回收问题，再合并」；该条件已通过独立验证，第一批已快进合并并推送 main（`a35582f` → `165fceb`），补合并记录后为 `bdcbb3e`。2026-10-18 第二批 T34 启动目录完成验收后，用户单独确认「合并 main」，已快进合并并推送（`bdcbb3e` → `cf700c2`），合并记录为 `8823be4`。第三批 Shell 发现/选择及缺失反馈完成实现、本机门禁与本批 CI 后，用户单独确认「合并 main」；2026-10-18 main 已从 `8823be4` 快进至 `780a10e`，并完成推送与远端读回核对。本次授权仅限第三批。

第四批会话环境变量与 locale 已实现，环境配置实现基点为 `bea905f`，当时本机全量门禁、macOS 有限原生验收及本机独立复核通过；后续 `85ce71b` / `b3716ad` 还修改了前端早期输入门控，定向 145 项浏览器/stub 回归通过，不能继续把整个产品代码称为与 `bea905f` 相同。Windows 旧 Shell 场景的目录查询停滞仍未归因，后续测试追踪修复不等于该故障修复。最新已结束并核验的诊断为 `74c6bf9` 上的真实构建准备与 READY frame 运行 `40163001613`，两平台准备及 Cargo 步骤通过，四个 worker 均完整启动、exit 0；该有限诊断不运行查询，不代表第四批验收。旧 `40161857832` 前置失败和 `40160768631` 的有限成功/READY 超时结论保留；具体结果和下一步见下文及 [P1 执行记录](p1/RESULTS.zh-CN.md)。第三批已批准并合并；第四批尚未获 main 合并批准，须完成验收后单独取得用户确认。

### 分支

独立 framed 查询模式已完成一次双 Windows 验证：新增 `--sample-framed <arm>`，READY/START1/QUERY1/START2/QUERY2/END 严格 nonce frame 顺序，固定 25 键 worker 报告；每平台最多四个 fresh worker 按 U、Q、Q、U 比较普通与模块限定查询，每 worker 两查询共用原 30 秒。Node 专项 **64/64**、协调者全 native **375/375**、Rust 专项 **69/69**（旧 55 + 新 14）、check/clippy/fmt/Windows cfg 与独立审查通过；真实 Rust 报告交 Node 校验的四类案例 **4/4** 通过。Rust 集成 `d54bf6e` 与 Node/方案 `1f3d13b` 第一推均为 `[skip ci]`，新 workflow 第二推准确 HEAD 为 `8f976ea13003c523ffb9030273895391298f835b`；唯一 [push 运行 40164795306](https://github.com/mofyer/new-windterm/actions/runs/40164795306) 已 `completed/success`，两平台准备/Cargo 成功，合计 **8/8** 查询及退出样本完整通过，工件独立核验通过。普通首次 q1 为 **11.2995–27.5139 秒**，模块限定首次为 **22.3006–37.4313 ms**；两 arm 的第二次为 0.1351–0.2345 ms。该有限对照支持路径耗时差异，未确定内部根因，普通首次慢路径仍存在。见[查询预注册](p1/CONPTY_FRAMED_QUERY_PLAN.zh-CN.md)与[执行记录](p1/RESULTS.zh-CN.md#conpty-framed-查询对照工作流-40164795306)。

新入口复用既有真实前端准备，未修改旧 wrapper 默认行为；准备 3 分钟、Cargo 14 分钟、四 worker 各 45 秒的名义合计已为 20 分钟，不含工具链/调度开销，job 硬限仍 20 分钟，不能保证边界组合完成。本轮按首失败停止规则执行，无重试或补样本；诊断通过不等于普通查询性能问题解决或独立 stderr 为空。下一步先复核既有 ConPTY 环境干预，避免重复 spawn 前加回父 PSModulePath 的旧 A/B；仅评估启动后有效环境差异及有条件的单变量实验，不修改产品。P1/第四批未验收、P2 仅准备、main 不合并。

新的真实构建准备流程已独立审查并推送：实现第一推 `06e7768`（`[skip ci]`），新 workflow 第二推准确 HEAD `74c6bf97377810167fdb49af5b21016db303c7c1`，唯一 [push 运行 40163001613](https://github.com/mofyer/new-windterm/actions/runs/40163001613) 已 `completed/success`，两平台全部步骤成功，工件独立核验通过。新 wrapper 在干净 dist 前置条件下真实安装依赖、构建前端，然后复用原 framed runner 和所有时限；本机专项 18/18、全 native 311/311 与 Windows 结果分别记录。2022 两样本 startup 3508.3862/413.6288 ms，2025 为 2036.043/458.3029 ms；四样本均 CPR 1/frame 1、启动写入确认、startup/complete/cleanup true、exit 0、kill false，顶层与嵌套聚合均通过。无查询、无重试，不据此重判旧运行或确定历史根因。见[准备方案](p1/CONPTY_FRAMED_PREPARED_PLAN.zh-CN.md)与[本轮记录](p1/RESULTS.zh-CN.md#conpty-frame-真实构建准备与验证工作流-40163001613)。

该轮之后的独立 framed 查询方案与实现见上文，保留原未限定查询、产品白名单和两次查询共用的原 30 秒总窗，不按 frame/第二次查询重置；该启动验证本身不提供查询性能或独立 PowerShell stderr 结论，P1/第四批未验收，P2 仅准备，main 不合并。`CLAUDE.md` 的 all-features/wincheck 真实资产前置说明已补齐为 `3664ee2`，旧 framed workflow 的入口处置仍待后续。

2026-10-25 的后续本机对照已确认构建前置缺口：旧 wrapper 使用 `--features dev-tools`，新 frame wrapper 改为 `--all-features`，启用 `custom-protocol` 后需要真实 `frontendDist`，而新 workflow 未构建前端。在精确 `b0ee332` 的干净 macOS 副本中，无 `dist`、无 `TAURI_CONFIG` 时 `cargo check` 返回 101，固定分类 `frontend-dist-missing`，宏位置 `src/lib.rs:596`；另一干净副本通过真实 `npm ci` 与 TypeScript/Vite 构建后，`cargo test --locked --all-features` 专项 **55/55** 通过。两者分别是 check 与 test，不是完全同命令的红绿测试；本机证据不确定历史 Windows 失败原因。准备流程已另行预注册并完成上述新验证，旧失败不改；详细条件和证据见[本机对照记录](p1/RESULTS.zh-CN.md#2026-10-25ready-frame-构建前置条件的本机对照)。

独立 `--startup-framed` 诊断已经集成：parser/xterm 为 `9b25ab6`，宿主/Node/预注册为 `3fcf5d0`，实现第一推使用 `[skip ci]`；新 workflow 第二推的准确 HEAD 为 `b0ee3324ead6f18f243ab949837dde43fa0af86f`。唯一 push [运行 40161857832](https://github.com/mofyer/new-windterm/actions/runs/40161857832) 已 `completed/failure`。两平台均 `tests-failed`，Cargo test exit 101、`process-exit`；`build=null`、`samples=[]`、三个聚合字段 false，未构建独立 worker、未进入采样，不能称为 frame 协议失败。内容受限报告未保存原始输出，无法区分编译错误或测试断言失败。新模式按连续字节 frame 及 writer ACK 确认启动，不依赖 LF/可视行；旧模式与旧失败结论保留。

本机全 native **293/293**、Rust 专项 **55/55**（包含 parser **19/19**）、新 wrapper **56/56**、真实 xterm frame fixture **6/6**、check/clippy/fmt/Windows cfg 及独立审查通过。原 5 秒启动、500 ms 退出 ACK+退出共窗、4.5/5 秒 cleanup、45 秒外层预算保持。Windows cfg 与离线 fixture 不等于 Windows 实测。两平台 helper/工具链/报告上传成功，工件独立核验通过；Cargo test 进程均已观察到退出、未请求 tree kill、本地资源释放。下一步仅定位 Windows 前置测试失败，另开局部取证；本轮不重跑、不预写原因、不修改冻结代码或门禁。详见 [执行记录](p1/RESULTS.zh-CN.md#conpty-ready-frame-独立诊断工作流-40161857832)。

退出修复已按[新预注册](p1/CONPTY_EXIT_VALIDATION_PLAN.zh-CN.md)完成一次 Windows 实测：准确 HEAD `7d4d7bb2c0f192743aaf4038e7d71fb8a19e9f94` 的唯一 push [运行 40160768631](https://github.com/mofyer/new-windterm/actions/runs/40160768631) 已 `completed/failure`。2022 job 成功，2025 job 失败；两平台 helper、Rust 专项测试/构建和报告上传成功，报告独立 schema/隐私/状态核验通过。

2022 两样本均 startup/complete true、exit 0，startup 3616.3425/418.4354 ms；2025 首样本 startup/complete true、exit 0、startup 2123.8729 ms，第二样本 READY write 6.1119 ms 已确认但 strict 0/embedded 1，`await-ready/startup-timeout`，未进入成功启动后的退出修复路径。三个进入修复后退出路径的样本均完整成功，但不能证明历史根因或普遍修复。2022 三聚合字段 true、2025 三字段 false，整轮仍失败；失败样本 exit 1 可由诊断清理终止产生。精确数值与 SHA-256 见 [P1 执行记录](p1/RESULTS.zh-CN.md#conpty-退出修复的-windows-验证工作流-40160768631)。

该轮之后已完成独立 READY frame 模式的实现、离线验证、独立审查与[新预注册](p1/CONPTY_FRAMED_PLAN.zh-CN.md)，新运行见上文；旧严格行协议的 embedded 仍不放行，不重跑旧实验或混入查询/环境矩阵。原时间/输出/隐私门禁保持，P1/第四批未验收，P2 仅准备，main 不合并。以下离线与历史运行证据保留原判定。

2026-10-25 已完成两条离线验证并集成：`d85ed99` 加入共享合成 fixture、真实 xterm 测试与[专题记录](p1/CONPTY_OFFLINE_VALIDATION.zh-CN.md)，`5eed885` 修复 startup-only 诊断输入端过早关闭的时序。15 个固定案例分别经过 xterm（977 种分块）和实际 Rust Parser（962 种分块），确认屏幕行与 ANSI 剥离后的 LF 行不能互相替代；解析接受规则保持不变。生命周期测试恢复旧顺序即失败，修复后通过：退出命令 write/flush 确认与子进程退出共用原 500 ms，输入端保留到退出观测或有界终止后再关闭。

集成树 native helper **237/237**、Rust 专项 **31/31** 通过；xterm **15/15**、定向 TypeScript、Rust check/clippy/fmt 与 Windows cfg 检查及独立审查通过。Windows cfg 仅类型检查；该离线修复已在上述 `40160768631` 取得有限 Windows 样本，但仍不能认定历史根因或第四批验收通过。不以嵌入匹配放行、不扩展旧时间限制。P1/第四批未验收，P2 仅准备，main 不合并。

上一轮 startup-only 诊断按[预注册](p1/CONPTY_STARTUP_PLAN.zh-CN.md)分两次提交推送：实现 `7aadab600a7c89d4235df239c9c0bf4b12723e66` 使用 `[skip ci]`，随后仅新 workflow 的 `fc3ff2d199a6ec87749afc164a5f9eff917abdb9` 为准确被测 HEAD。本机完整 native **237/237**、startup 专项 **48/48**、Rust **19/19** 及 Windows cfg/独立审查通过；唯一 push 运行 [39833719372](https://github.com/mofyer/new-windterm/actions/runs/39833719372) 已 `completed/failure`，两 job 失败，两平台 helper/Rust 测试/构建通过。独立报告 schema/隐私/状态核验通过，诊断仍失败。

2022 首样本 startup/complete 均成功（write 146.6556 ms、startup 4483.0913 ms、exit 0）；第二样本 write 6.2963 ms 已确认，但 strict READY 0、完整 embedded READY 1，仍在原 5 秒 `await-ready` 超时，未放宽为包含即通过。2025 首样本在 4459.7464 ms 内启动成功（write 12.6397 ms、strict READY 1），随后 `after-ready/exit-error`、exit 3221225786，第二样本未运行，不能记成启动失败。其 kill false/退出前观测 true 只排除显式 child.kill，不排除清理关闭输入端的时序影响。两报告聚合三字段均 false；2025 因只完成一个预定启动而 `startupSuccess=false`，不抹去样本 `startupComplete=true`。精确计时、状态与 SHA-256 见 [P1 执行记录](p1/RESULTS.zh-CN.md#conpty-startup-only-写入与-ready-分类诊断工作流-39833719372)。无目录查询或产品修复结论。

该轮提出的两条离线验证已在上述 `d85ed99` / `5eed885` 完成；真实 Windows 的具体行布局及历史退出原因仍未确定，下次实测另行预注册，不重判该轮失败。缓存变量对照仍是独立后续候选，不混为同一根因。以下为上一轮协议分类证据。

上一轮测试侧实现为 `e3827ea33545c6e8c3922295a9b3bbfc5548977d`，按[协议诊断预注册](p1/CONPTY_PROTOCOL_DIAGNOSTIC_PLAN.zh-CN.md)增加 schema 2 的固定阶段/原因、有限终端计数及清理退出时序；原解析接受规则、两 arm、时限和首失败停止不变，未修复解析器或产品。本机完整 native **189/189**、wrapper **41/41**、Rust **15/15** 通过，Windows cfg 检查与独立审查通过；这些与 Windows 实跑分开。唯一新运行 [39828696609](https://github.com/mofyer/new-windterm/actions/runs/39828696609) 已 `completed/failure`，两 job 失败、helper/上传成功，两平台 Rust 测试和构建 exit 0；报告独立 schema 2/隐私/状态核验通过。

本轮 2022 首个 unqualified 完整成功，q1=28445.5897 ms、q2=0.1984 ms；随后 module-qualified 在 `await-ready` 启动超时。2025 首个 unqualified 即同阶段启动超时，限定 arm 未运行；两平台反序轮未执行，三个完成/成功字段 false。两失败均 CPR 1、version false、q/host null，查询脚本未投递；约 5.004/5.010 秒 startup 是轮询超时观测，不放宽 5 秒，不是查询 30 秒超时。2022 失败有 `embeddedMarkerLines=1/markerLines=0`，只能说被忽略行含 nonce 前缀，不能认定完整 READY 或重绘根因；2025 八计数为 0、最终合流 107 字节，窗口不同，不能称没有输出。两失败 kill true/退出前观测 false/cleanup true，exit 1 不能认定脚本自行失败。精确计时与工件 SHA-256 见 [P1 执行记录](p1/RESULTS.zh-CN.md#conpty-协议失败分类诊断工作流-39828696609)。

该轮提出的 startup-only 诊断已在上述 `fc3ff2d` 完成预注册及实测；原设计不执行目录查询，在原 5 秒窗口内记录 READY 脚本实际写入完成布尔值/时点，并区分严格行首与嵌入完整 READY 形状；先以有限 fixture 和独立审查确认分类，分类不作为放行、不延长门限；模块分析缓存路径变量可作为另一个单变量预注册候选，官方 5.1 与 runner-images 固定源码依据见上述记录，但实际 runner 值/缓存状态未知，不能称根因。本轮不追加实测、不改预注册，不替换旧普通查询或放宽门禁，P1/第四批未验收、P2 仅准备、main 不合并。以下为上一轮限定命令证据。

上一轮实现分两次推送：`0940bc365849cd724041cde204d19ac9e395cb57` 为 `[skip ci]` 的独立 ConPTY 限定命令探针，`a8e64c7260d5dfc306746b9304bbd6a3404eff9c` 为新 workflow、本轮准确被测 HEAD。[主运行 39824348485](https://github.com/mofyer/new-windterm/actions/runs/39824348485) 已 `completed/failure`，两 job 失败、上传成功。本机 native 184/184、wrapper 36/36、Rust 11/11、release bins 3/3 及 Windows cfg clippy/独立审查通过；实际 Windows 两平台的 Rust 专项测试及构建均 exit 0，随后采样首失败停止。

2022 首轮 unqualified 完整成功（q1=15406.5298 ms、q2=0.1818 ms），随后 module-qualified 出现 `protocol-error`，两次 q 均 null；2025 首个 unqualified 即 `command-timeout`、两次 q 均 null，限定 arm 未运行。两平台反序轮都未运行，三个完成/成功字段 false；2022 失败 arm 的约 518 ms wall 不能当成快查询，2025 约 30009.8 ms host 是超时观测而非放宽 30 秒。null 只说明没有合法完整 RESULT；exit 1 可能来自诊断清理终止，不证明脚本自行失败。ConPTY 合流不能判断独立 stderr。两报告独立 schema/隐私/顺序/状态核验通过，计时和文件指纹见 [P1 执行记录](p1/RESULTS.zh-CN.md#真实-conpty-模块限定命令对照工作流-39824348485)。

调度异常保留：同一 HEAD 出现两个 push event，均非手动 dispatch。后创建的 [39824353657](https://github.com/mofyer/new-windterm/actions/runs/39824353657) 已 `completed/cancelled`，两 job 取消、上传成功；组合步骤曾启动，工件停在 `tests=null/build=null/samples=[]`、三个完成/成功字段 false 的初始报告，未完成 Rust 测试、未进入采样，`failure=null` 非通过。只采用先创建主运行的实测，不拼接两个运行，也不改[预注册方案](p1/CONPTY_QUALIFIED_PLAN.zh-CN.md)。

上一轮提出的有限协议阶段/原因分类、终端控制计数与清理时序记录及 fixture 已在上述 `e3827ea` 实现并执行；CR/CSI 重绘处理只是代码候选，尚非本轮已证根因。先定位诊断失败，再预注册重做对照，不立即追加实验。产品仅配置 cwd，没有内置 `Get-Location`；普通查询来自原生验收场景，不能以限定命令替换旧查询掩盖慢路径。旧门禁和失败保留，P1/第四批未通过，P2 仅准备，main 不合并。

上一轮 stdio 阶段实现为 `66e237e8f11034d5c837f7d84ca2b280dff1d9e0`，按[阶段诊断预注册方案](p1/POWERSHELL_PHASE_PLAN.zh-CN.md)增加三 arm、六进程/平台的准备与两次查询分段计时。本机 native helper 148/148、独立专项 19/19 及独立审查通过；[Windows 阶段运行 39819222771](https://github.com/mofyer/new-windterm/actions/runs/39819222771) 已 `completed/failure`，两平台 helper/上传成功，报告独立 schema/边界/隐私核验通过。每平台六样本、16 阶段完整，exit 0、身份/cwd 正确，`experimentComplete=true`、`strictPassed=false`、`stopReason=null`；无超时或清理失败，未触发终止清理不等于该路径已实测。

cold 首次查询约 21–29 秒；精确 `Get-Command` 准备约 21–23 秒，之后首次查询约 2.36–3.01 ms；显式 Management 导入准备约 44–59 ms，之后首次查询约 2.52–2.60 ms、整个进程 wall 约 244–276 ms。cold/discover 仍有 392 字节旧指纹 stderr，显式 import 为空；整体仍严格失败。证据支持继续区分自动命令发现/导入与显式指定模块导入的路径差异，未确定内部扫描、缓存或网络机制，也不是产品修复。准备后查询均已预热，不相减归因，不把阶段相加当 wall。本轮仅一次新 phase push 运行，默认 progress、旧门禁与预注册不改；下一步候选是更窄的自动发现/指定模块解析导入对照，或真实 ConPTY 有限对照，均先预注册而非直接改产品。P1 与第四批未通过，P2 仅准备，main 不合并；精确计时及文件指纹见 [P1 执行记录](p1/RESULTS.zh-CN.md#命令准备与查询阶段诊断工作流-39819222771)。

上一轮测试侧有限因果对照已提交并推送为 `d2cee0ea84ce05a67b4d3cf313c1da268b11365f`，固定白名单五 arm 的[预注册方案](p1/POWERSHELL_CAUSAL_PLAN.zh-CN.md)保持执行前设计。本机 native helper 129/129、独立专项 18/18 通过，独立审查通过；[Windows 双平台运行 39816931188](https://github.com/mofyer/new-windterm/actions/runs/39816931188) 已 `completed/failure`，两 job 失败、helper 与工件上传成功，精确 `measurements.json` 均通过独立 schema/隐私核验。每平台十个观察完整（八个测量、两个类型化命令缺失），`experimentComplete=true`、`strictPassed=false`、`stopReason=null`，无超时或清理失败；未触发终止清理不等于该路径已实测。

抑制 progress 将 stderr 从 392 字节变为空，但查询内部耗时仍约 19.5–19.8 秒（2022）和 23.1–23.5 秒（2025），削弱可见 progress 解释全部延迟的假设，未锁根因。禁用自动加载的四次 exit 2、查询耗时/cwd 为 null，不能算性能改善；直接读取内部约 5–8 ms，但首进程 wall 分别为 3.049/4.233 秒。显式进度校准包含 Utility 命令发现与可能的初始化，不是纯序列化成本。该轮仅一次 push 运行，未改白名单、旧门禁或既定协议，未重跑 Rust/八环境矩阵；该轮提出的 cmdlet 发现、模块加载与初始化阶段诊断已在上述 `66e237e` 完成预注册及实测。P1 与第四批仍未通过，P2 仅准备，main 不合并。详细计时及文件指纹见 [P1 执行记录](p1/RESULTS.zh-CN.md#固定白名单的有限因果对照工作流-39816931188)。

- **集成分支 `p1/integration`**：最新核验为上述 `74c6bf9` 的准备与 frame 验证 `40163001613`，两平台准备/Cargo及四个样本通过；上一轮 `b0ee332` 的独立 READY frame 诊断 `40161857832` 两平台前置 Cargo test 失败、build null/samples 空，未采样；上一轮为 `7d4d7bb` 的退出修复验证 `40160768631`，2022 平台通过、2025 第二样本启动超时，整轮失败；前一轮为 `fc3ff2d` 的 startup-only 诊断 `39833719372`；之前协议分类为 `e3827ea` 的 `39828696609`；上一轮限定命令诊断为 `a8e64c7` 的 `39824348485`，之前 stdio 阶段诊断为 `66e237e` 的 `39819222771`，五 arm 对照为 `d2cee0e` 的 `39816931188`。最近一次旧八环境矩阵仍为 `67d7f37a4d1a40c6e027b0da28ae65fd76d29096` 的[工作流 39812975794](https://github.com/mofyer/new-windterm/actions/runs/39812975794)，整体失败：fixture 两平台通过，stdio 各 16/16 严格失败；旧 ConPTY 2022 为 16/16、2025 为 15/16，后者首轮产品白名单 marker timeout。后续补强 `81d109a` 不在该旧 Windows 被测提交中，新对照不重写其失败证据。分支头用远端 refs 核对，各轮证据见 [P1 执行记录](p1/RESULTS.zh-CN.md)及[stderr 诊断索引](p1/STDERR_DIAGNOSTIC_INDEX.zh-CN.md)。
- **远端 `main`**：2026-10-18 第三批获用户单独批准后，已从 `8823be4` 快进至 `780a10e` 并推送、读回核对。第三批被测代码为 `68808de`，合并记录 `40405d7` 已审阅、提交并推送，未修改产品代码；第四批尚未合入 main。接手时用远端 refs 核对最新文档提交。
- **集成分支 `p0/integration`**：10-15 的 T35–T37、虚拟串口、独立 GSSAPI 探针，以及此前冻结、E11、互操作修复和归档提交，均已同步到 `main`。被测提交 `fb824cf` 的 [CI 7/7 通过](https://github.com/mofyer/new-windterm/actions/runs/38691371347)，之后仅补证据文档、台账与合并记录。本轮新增[上游实测](p0/UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)、[原生实测](p0/NATIVE_ACCEPTANCE_2026-10-15.zh-CN.md)与[P0 出口结论](p0/P0_EXIT_REVIEW.zh-CN.md)，仅更新文档。本批收尾文档已获用户明确合并授权；后续新批次合并到 `main` 仍需用户明确同意。
- **推送范围**：延续已授权的集成工作流，当前推送 `p1/integration` 并手动触发 CI；main 合并仍须新一批的明确批准。
- **未跟踪目录 `.claude/`**：存放子代理的 worktree。此前三个被用量上限中断的任务已在 10-15 完成代码或文档收尾，macOS/Linux 虚拟串口实测通过，GSSAPI 首轮 CI 失败后已修复，第二轮四场景通过；历史位置见[归档](p0/P0_ARCHIVE_2026-10.zh-CN.md#5-未完成与在途事项)。删除之前，先用 `git worktree list` 确认里面的提交已经合并。
- **多代理工作方式与续做方法**：见 [AGENT_WORKFLOW](p0/AGENT_WORKFLOW.zh-CN.md)。

### CI 与文档

- **CI**：`.github/workflows/p0-cross-platform.yml`，覆盖 macOS arm64、Linux x64、Windows x64。工作分支上可以用 `gh workflow run p0-cross-platform.yml --ref <分支>` 手动触发。当前 P1 证据以 [P1 执行记录](p1/RESULTS.zh-CN.md) 为准。
- **结果与边界**：[P1 执行记录](p1/RESULTS.zh-CN.md)；下文 P0 历史成果对应 [P0 执行记录](p0/RESULTS.zh-CN.md)。
- **功能总矩阵**：[docs/FEATURE_PARITY.zh-CN.md](FEATURE_PARITY.zh-CN.md)。2026-10-12 由用户批准冻结，冻结时共 161 个 ID；用户随后批准 WL-1/2/3 为 T35–T37，10-15 收尾后共 164 个 ID。新增项未实现、行为未验证；原有行的状态未改变。
- **路线图**：[docs/ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)。

## 本轮完成且有证据的内容（集成分支）

每一项都只覆盖下表“证据”一栏写到的范围。

| 领域 | 内容 | 证据 | 主要边界 |
| --- | --- | --- | --- |
| 只读 SFTP 文件面板 | 指纹核对后签发短时授权；目录分页与截断；64 KiB 预览 | 真实 OpenSSH 夹具；浏览器测试 | 没有写操作、下载落盘或原生 WKWebView 实测；F01 未完成 |
| 主机信任 | `known_hosts`（OpenSSH 格式）；`new`/`known`/`changed` 三种状态；变化时阻断 | 单元与集成测试；系统 `ssh` 接受我们保存的条目 | 不导入用户的 `~/.ssh/known_hosts` |
| SSH 认证 | 私钥（可带口令）、密码、agent、keyboard-interactive；bcrypt 轮数上限 | loopback 与真实 OpenSSH | 只支持 Ed25519/ECDSA，没有 RSA |
| keyboard-interactive 实时提示 | 连接时逐轮弹窗作答；`ssh_auth_respond` 绑定窗口、操作和轮次；适用于终端标签页和 SFTP 面板 | loopback 夹具；浏览器测试 | 没有真实 PAM/OpenSSH 验证，没有原生手工测试 |
| 交互 SSH | Rust `ssh_open` 连接真实 OpenSSH shell | `tests/fixtures/ssh-terminal/rust-client.test.mjs` | 没有长期会话和断线恢复 |
| 转发 | 本地转发、SOCKS5 动态转发、跳板、远端转发、agent 转发；服务端主动打开的通道默认拒绝，`forwarded-tcpip` 最多 64 个；已打开的 SSH 终端可以在「端口转发」面板中增删本地、动态和远端转发 | loopback 夹具；浏览器测试 | 没有与 OpenSSH 的转发互操作；agent 转发没有界面；设置不保存 |
| 代理与跳板路线 | 连接对话框可选直连、HTTP CONNECT、SOCKS5、ProxyCommand（不经过 shell）、单跳跳板（两步信任）；路线绑定进 challenge 和 SFTP 授权 | loopback 代理；真实 OpenSSH 夹具 | 没有用真实代理软件或 OpenSSH 跳板验证；不支持多跳 |
| SFTP 写操作原型 | 新建目录、重命名、删除、chmod、上传、下载落盘；需先开启写入 | 真实 OpenSSH 夹具；浏览器测试 | 没有原生窗口实测；写入开关缺少原生确认 |
| 连接复用 | 应用内复用的探针，以及 ControlMaster 决策记录 | 测试与[决策记录](p0/CONTROLMASTER_ADR.zh-CN.md) | 不实现 OpenSSH ControlMaster socket |
| SCP | `scp -t -d/-f` 传单个文件；SFTP 面板中可选，上传需要先开启写入 | 真实 OpenSSH 夹具；浏览器测试 | 没有目录或递归；没有原生窗口实测 |
| agent 转发 | 终端连接对话框中按连接开启，默认关闭，不保存 | loopback 夹具与私有临时 ssh-agent | 没有与 OpenSSH 服务端互操作 |
| 原生 WebView 冒烟 | 用 tauri-driver 驱动真实应用：工作台、本地终端、SSH 终端 | CI：Linux WebKitGTK 2.52.6、Windows WebView2 131；macOS 另有 CUA 有限实测 | macOS 完整输入法、屏幕阅读器与性能验收未完成 |
| Telnet / Raw TCP | 编解码器，以及桌面终端标签页（五个 `net_*` 命令） | loopback 服务器；浏览器测试；真实 telnetd 308（6 项，本机） | 没有 login 认证、LINEMODE 或网络设备 |
| 输入路径 | 有序输入队列（16 MiB）；按 UTF-8 边界分块输出，绕过 xterm.js #6003；粘贴与拖放过滤控制字符；无按键输入的文本会转发；拦截 F 键默认动作 | 浏览器测试（CDP）；10-15 原生 PTY 大段粘贴/过滤、用户单轮拼音确认 | 完整 IME、VoiceOver、宽字符差异和前后台显示风险未关闭 |
| XMODEM/YMODEM | 不依赖 I/O 的发送与接收；评估了 ZMODEM 的 `zmodem2`，结论是不采用 | 单元测试；与真实 lrzsz 0.13.1 互操作 11/11 | 没有接入终端、SSH 或串口；ZMODEM 需要自行实现 |
| tmux 控制模式 | 解析器，跟踪窗口与窗格 | 单元测试；本机 tmux | 没有界面 |
| 终端概念验证 | 压缩历史、折叠/大纲、Free Type、VT52 | Playwright | 都是隔离原型，未接入生产终端 |
| VT 兼容矩阵与适配 | xterm.js 6.0.0 的 63 项探针；生产代码加了设备身份、DECRQSS、DECOM 下的 CPR、默认关闭的 OSC 52 写入。加适配后为支持 39、部分支持 15、不支持 12 → 9 | [矩阵](p0/VT_MATRIX.zh-CN.md) | 没有运行 vttest，没有与 WindTerm、xterm 或 DEC 对比 |
| Windows ConPTY | `cmd.exe` 生命周期：Job Object 回收进程树，关闭、ACK、Ctrl+C 等 | Windows CI（Server 2022 与 2025） | 只验证了 `cmd.exe`；Server 2022 系统自带的 ConPTY 每个会话泄漏 1 个句柄，Server 2025 上没有，本项目代码不额外泄漏 |
| 工作量估算 | 全项目分解与人周估算 | [估算](p0/EFFORT_ESTIMATE.zh-CN.md) | 只是估算，不是承诺 |
| 性能基线 | 本机 PTY、xterm、启动与内存基线 | [记录](p0/PERFORMANCE_BASELINE.zh-CN.md) | 测量环境嘈杂；没有 WKWebView 数字，没有与 WindTerm 对比 |
| 上游静态复核 | 130 项逐条对照上游静态材料 | [复核记录](p0/UPSTREAM_STATIC_REVIEW.zh-CN.md) | 静态证据不等于行为已验证 |
| 依赖与许可证 | 依赖清单 | [清单](p0/DEPENDENCIES.zh-CN.md) | — |
| 安全评审 | 网络探针没有 CRITICAL 或 HIGH 问题；MEDIUM 已修复或已写明不采纳的理由 | RESULTS「网络探针安全评审」一节 | — |

X11 转发已有 Rust 探针：采用假 cookie 替换，没有界面；与 Xvfb 和 OpenSSH 的真实互操作放在 Linux CI 上运行。GSSAPI 已有独立 [Rust 探针与隔离 KDC/sshd 夹具](../tools/gssapi-probe/README.zh-CN.md)（`7daa310`），3 项单元测试通过并完成独立安全审查，Linux 四场景及三次新 cache 健康复验已在 [修复版 CI](https://github.com/mofyer/new-windterm/actions/runs/38691371347/job/116277797906) 通过；没有接入产品认证。

## 绝对不能误报的边界

- 不能说 WindTerm 功能已经完整对齐或 P1 已通过；P0 技术评审已 PASS，用户已确认阶段关闭；这不代表任何完整功能或发行通过。
- 不能说 SFTP 已完成。现在只有只读浏览和写操作原型，没有以下能力：
  - 递归、目录传输、断点续传
  - 持久连接、断线恢复
  - 原生面板验收
- 不能说 Windows 终端完整可用：
  - `cmd.exe` 的 ConPTY 生命周期有 CI 证据；本批 Windows PowerShell 仅完成 WebView2 下的身份、目录、退出及重开场景。
  - PowerShell 7、完整 PowerShell 行为、输入法和真实用户环境尚未验收。
  - 已知限制见 [ConPTY 决策记录](p0/WINDOWS_CONPTY_ADR.zh-CN.md)：排空没有期限，Job 分配存在竞态。
- 测试替身的结果不能外推：
  - 浏览器 E2E 使用 IPC stub，不能外推为 Rust 或原生 GUI 成功。
  - loopback russh 或测试内 TCP 服务端，不能等同于真实 OpenSSH、telnetd 或网络设备。
- 构建结果不代表发行验收：
  - macOS arm64 CI 或本地 debug 构建，不等于真机 IME、高输出性能、签名、公证或发行验收。
- 概念验证与探针不改变功能矩阵中任何一行的状态。

## 需要用户提供或决定的事项

这些事项已向用户说明过，不要自行绕过：

- **合并**：2026-10-15 本批已获用户明确同意，CI 通过后已合并并推送 `main`；下一批仍需单独批准。
- **功能基线**：2026-10-12 已冻结，E1–E12 全部采用推荐选项。用户同时授权在隔离副本中运行上游 2.7.0 做实机盘点；Windows/Linux 上游包的静态核对放到冻结之后。见[冻结方案](p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md)的决定记录。
- **串口（C04）**：用户已确认暂时没有测试设备，先推进其他验收；真实 UART 参数与拔插保持阻塞，不重复询问现有设备。
- **X11 转发（C15）**：Linux CI 已用 Xvfb 验证；如果要在 macOS 上验证，需要批准安装 XQuartz。
- **GSSAPI（C14）**：用户已批准在 Linux CI 容器自建测试领域，本批已实现夹具；无需用户提供真实领域。Linux 四场景已通过；后续产品接入与其他平台认证仍未验证。
- **辅助功能与上游实机盘点**：协调者已用 CUA 执行有限操作；用户确认系统拼音候选窗与“你好”选字正常，也确认 Local 3 置前台后两条输出正常。临时添加的拼音已移除，输入法列表恢复 ABC 和豆包；用户现已确认最小 VoiceOver 标签与终端可达、能朗读且已关闭，完整读屏仍未验收。
- **发行**：签名与公证需要凭据。
- **旧版 Windows 的 ConPTY**：是否随应用分发新版 `conpty.dll` 和 `OpenConsole.exe`，以消除 Server 2022 这一代系统上的句柄泄漏。
- 当前 `p1/integration` 已包含测试侧 timing、阶段标记、fallback 覆盖、有限环境矩阵、受控 stderr fixture、早期输入门控与 P2 准备矩阵；最新 Windows 测量与工件绑定 `67d7f37` / `39812975794`，具体 HEAD 以远端 ref 为准。P2 准备文档不代表正式进入 P2。
- **SIXEL**：是否允许在 CSP 中加入 `wasm-unsafe-eval`。

## 推荐下一步顺序

**当前执行入口**：续做 [P1 第四批](p1/PLAN.zh-CN.md#第四批会话环境变量与-locale2026-10-18-开始)，先核对 `git status`、`git worktree list` 与 [RESULTS](p1/RESULTS.zh-CN.md)。最新证据是 [Windows 双平台取证 39812975794](https://github.com/mofyer/new-windterm/actions/runs/39812975794)，精确 HEAD 为 `67d7f37a4d1a40c6e027b0da28ae65fd76d29096`：所有测量与上传步骤已完成，工作流已结束、整体失败。

该提交加入有界 stderr 结构摘要与 ConPTY 内容受限报告，本机完整 native helper 110/110，通过独立复跑与审查。两平台 fixture 步骤通过；32 条 stdio 真实 392 字节流均命中有限 CLIXML 结构（16 节点、深度 5、仅 progress=1），指纹不变，完整测量、cwd 匹配、exit 0、无超时或截断，原分类仍为 unknown 且全部严格失败。结构不证明内容无害或慢路径根因，不能外推为 ConPTY 结果。ConPTY 2022 为 16/16，2025 为 15/16（首轮产品白名单 marker timeout），两个 artifact 均仅含固定字段 `report.json`，无原文或路径。后续本地 runner error-handler 补强 `81d109a` 已通过独立复跑 native helper 111/111 与审查，该后续本地验证不属于本次 Windows 被测 HEAD。

保持未知 stderr 严格失败、原时限和精确 cwd 断言；不能继续重复相同环境矩阵代替归因。该轮提出的固定慢环境、模块命令解析与进度产生对照已在后续 `d2cee0e` 完成预注册及实测（`39816931188`），观察收齐但严格判断失败，具体结果见上方；不得通过抑制 progress 绕过原验收。Windows 根因、第四批验收及 main 合并仍未完成，第四批 main 合并尚未授权。以下逐轮记录保留历史上下文。

全套 CI `39066177739`（`5fe00fd`）已结束为 6/7：四个 desktop、GSSAPI、Linux native 通过；Windows 四轮 Shell 功能断言完成，但在保存 trace 时超出 64 KiB 容量而失败。容量修复 `0906c85` 的 [native 补验 39067079503](https://github.com/mofyer/new-windterm/actions/runs/39067079503) 已完成成功，两平台各 7/7、无额外重复；helpers 分别为 Linux 35 passed / 1 skipped、Windows 34 passed / 2 skipped（各 36 项）。

两端 trace 均完整覆盖首次与重开两槽：Linux 44,810 字节 / 467 条、Data 38/41；Windows 85,251 字节 / 757 条、Data 32/33；均无 incomplete、truncated 或 dropped records。

原 Windows 目录停滞仍未归因。四份已有 trace 显示首次 `(Get-Location).Path` 回显及 ACK 完成后，距 cwd 输出约 20.8–27.1 秒；这是测试侧可见事件之间的间隔，不是 cmdlet 内部执行耗时，也不能说明原失败原因。隔离 `powershell-latency` 工作树的独立探针已集成并推送为 `7c9a14b`，双平台诊断 `39094470445` 已完成：两端各 6 个样本完整、exit 0，但均有 392 字节未知 stderr，因此两作业失败。独立脚本内首次 Get-Location 在继承环境下约 39–380 ms、白名单环境下约 11–27 秒；这只是环境策略与时延的明显关联，固定执行顺序和缓存未控制。提交 `96a3066` 的反向四组实验与 [39740945170](https://github.com/mofyer/new-windterm/actions/runs/39740945170) 已将候选缩小：白名单单独仍为约 19.6–28.1 秒，加回父 `PSModulePath` 后约 29–33 ms，继承环境移除该变量后约 50–92 ms；但 392 字节 stderr 仍未知，stdio/EncodedCommand 仍不能代表 ConPTY。`eea39b7` 的直接 `portable-pty` ConPTY 探针已在 [39749668866](https://github.com/mofyer/new-windterm/actions/runs/39749668866) 的 Windows 2022/2025 各 8/8 样本成功，白名单与继承 − `PSModulePath` 的差异仍复现；这证明相关性跨过 ConPTY 层，但不区分 Tauri/WebView 启动链、PowerShell 模块初始化或其他受控环境差异。`03ffcb9` 的复测 [39756049365](https://github.com/mofyer/new-windterm/actions/runs/39756049365) 为两个 stdio 作业继续未知失败；392 字节的 SHA-256 指纹在两平台一致，但原文未保存。该复测的 ConPTY 为 Windows 2022 8/8、Windows 2025 6/8，后者两次白名单样本超时；上一轮 Windows 2025 8/8 成功，故保留为间歇性诊断不稳定。`b0b8b54` 的真实 WebView timing 复测 [39759997877](https://github.com/mofyer/new-windterm/actions/runs/39759997877) 在 Windows WebView2 与 Linux WebKitGTK 两个 native job 均成功；Windows 基础场景加三次重复的 8 个初次/重开样本中，实际 PowerShell cwd 输出为 17.8–27.7 秒，`open→ready` 为 83.7–114.0ms。该结果证明延迟存在于产品 WebView2→PTY→PowerShell 可观测链路，但仍不能区分 Tauri IPC、ConPTY、PowerShell 初始化或环境策略中的具体环节。整条 workflow 不能写成整体通过。下一步是继续做 Windows 链路的最小组件分层复现，不得把结果写成产品根因或整批通过。产品代码仍为 `bea905f` 对应内容，不重复未受测试侧修复影响的 Rust 门禁。第三批已合并，第四批 main 合并仍须单独批准。下列 P0 五项是关闭依据及后续边界，不是重新开启 P0 的任务列表。

对同一工件的 8 份 Windows shell trace 只读复核显示，每个 cwd 回车事件之后，首个 `pty_write` 与首个数据回流分别在约 0–4 ms、约 2–4 ms 内出现；18–28 秒的主要间隔发生在 trace 捕获到回车之前。这排除了“回车已进入 WebView 后，ConPTY/PowerShell 执行到首个回流”作为该轮主要延迟段，但 trace 没有 Node WebDriver 调用起点，不能单独归因于 WebDriver、WebView 输入调度或前端事件循环。

提交 `564aa3a` 只在 timing 开关开启时记录 `typeInTerminal` 的 Node 侧输入调用时长，默认行为不变。对应的[真实 WebView 复测 39764709186](https://github.com/mofyer/new-windterm/actions/runs/39764709186) 中，Windows WebView2 与 Linux WebKitGTK native job 均成功；Windows 8 个初次/重开样本的 `cwd-typeInTerminal` 为 62.7–68.5 ms，而 `cwd-send-to-row` 为 21,783.2–30,204.8 ms。同批 Windows trace 的 cwd 回车事件后首个数据回流为 2.7–5.9 ms。该结果把主要间隔进一步收窄到输入调用返回之后、页面事件/回读之前，但没有 Node 与 WebView 共用的跨时钟标记，仍不能单独归因于 WebDriver、WebView 输入调度或前端事件循环。

提交 `263658e` 在同一 timing 开关下增加了可选的阶段标记：`webdriver-input-return`、`webview-keydown-enter`、`pty-write-enter` 与 `first-data-after-enter`；默认关闭，不记录终端原文，也不改变产品 Rust 门禁。带 `native_only=true`、`windows_shell_repeats=3`、`windows_webview_timing=true` 的[复测 39783803294](https://github.com/mofyer/new-windterm/actions/runs/39783803294) 中，Linux WebKitGTK 与 Windows WebView2 native job 均成功，10/10 场景通过。Windows 8 个初次/重开样本的 `cwd-typeInTerminal` 为 63.1–70.3 ms，`cwd-send-to-row` 为 21,596.8–27,648.6 ms，`open→ready` 约 110.9–132.6 ms。阶段标记显示页面输入调用返回及 PTY 写入均在延迟前发生，但 `first-data-after-enter` 定义为 Enter 后首个 PTY 数据，可能是命令回显或提示符，不等于精确 cwd 行；该标记没有跨 Node/WebView/PTY 的统一时钟，不能据此确定组件根因。

直接诊断[39782434106](https://github.com/mofyer/new-windterm/actions/runs/39782434106) 仍未通过：stdio 比较步骤提前失败，测量 JSON 没有可用样本，原始工件已保留；Windows Server 2022/2025 的 ConPTY 首轮产品白名单均出现 marker timeout，2025 首轮加回父 `PSModulePath` 也超时，后续轮次虽取得约 21–24 秒的慢样本，继承环境仍约 57–71 ms，工作流最终失败。未知 stderr 的严格检查与 ConPTY 首轮间歇超时仍是阻塞，Windows 目录停滞根因未定。

提交 `9288f78`、`9d0a51c` 将诊断扩展为八组有限环境矩阵。运行 [39788501384](https://github.com/mofyer/new-windterm/actions/runs/39788501384) 中，两端 stdio 各 16/16 样本仍因 392 字节未知 stderr 严格失败；两端 ConPTY 首轮产品白名单均超时，系统路径、身份、进程运行时和显式空 `PSModulePath` 组均取得约 17–25 秒慢样本，继承环境约 42–72 ms。新增变量组不能单独消除慢路径，未知 stderr、ConPTY 超时和 WebView 根因未定仍保留。

提交 `9be5c39` 在诊断报告中加入未知 stderr 的有界形状摘要，只保存结构计数，不保存原文，未知仍判失败；本机 native helper 为 68/68。P2 方面，`b9ad956` 新增隔离 OpenSSH 互操作夹具规格，限定临时 sshd、临时密钥/known_hosts、单一 forwarding 能力和脱敏证据；这只是准备工作，不代表正式进入 P2。

1. **本批已收口**：WL-1/2/3 为 T35–T37，虚拟串口与独立 GSSAPI 探针已合入、审查、本机门禁及修复版 CI 通过。当前重点转为[路线图](ROADMAP.zh-CN.md)的 P0 实机差异、原生风险和出口评审；历史 worktree 位置见[归档](p0/P0_ARCHIVE_2026-10.zh-CN.md#5-未完成与在途事项)。
2. **最小原生证据已齐**：[上游架构关键观察](p0/UPSTREAM_ARCHITECTURE_2026-10-15.zh-CN.md)已经成文，A2 SCP、A4 多窗口/活进程及全量兼容留后续对应交付。原生 1 MiB 粘贴完整性与过滤已测；[补充记录](p0/NATIVE_CLOSEOUT_2026-10-15.zh-CN.md)现已有 CUA Raise 后固定负载的可见结束、12 条有序编号及后续恢复截图，重新取得 30 个包含 WebKit 的负载前/中/后样本。不要重复执行负载或展开完整 IME/读屏/VT 调查。后台自动化截图差异没有定根因，本轮正向观察不等于修复。上游已退出，本轮新备份 `.reference/plist-backup-2026-10-15-closeout/` 恢复共用偏好并 cmp 一致；首轮使用 `.reference/plist-backup-2026-10-15/`，两轮各自验证。
   - 负载步骤已由协调者完成。用户对最小听测问项明确回复「标签与终端可达，能朗读，已关闭 VoiceOver」。这是用户回传，未指定朗读的是 HELLO 还是 RECOVERY，不扩写为两者均听测；无须重复本轮操作。
   - 新采样进程已 exit 0，阶段文件已生成，副本为 ignored `.artifacts/p0/closeout-20261015/load-phases.txt`，采样为 `load-resources.jsonl`。独立 verifier 已核对原始数据。用户回传已补入，三个包最终技术评审 PASS，不新增负载研究。完整 IME/读屏/VT 与长期性能留 P1 对应交付前。
3. **出口评审**：用户已批准[三个决策包](p0/P0_CLOSEOUT_PROPOSAL_2026-10-15.zh-CN.md)，按架构关键判断、最小原生可行性、ADR 与工期定稿收尾；真实串口验收 P2，完整 IME/读屏/VT 验收 P1 对应交付前。最终独立技术评审已 PASS，详见[出口结论](p0/P0_EXIT_REVIEW.zh-CN.md)。用户已明确回复「确认关闭 P0，并合并 main（推荐）」。下一步进入 P1 本地终端产品化，不再展开 P0 普查。
   - 用户已质疑 P0 迟迟不结束。执行[已批准的三个决策包](p0/P0_CLOSEOUT_PROPOSAL_2026-10-15.zh-CN.md)，停止普查式扩张；验收后移已获明确确认，但不能自动视为出口通过。
   - [164 项剩余估算](p0/EFFORT_ESTIMATE.zh-CN.md)与53包机器可复算覆盖已更新；已核对 G43 并入、四项暂缓及 ZMODEM 自研假设。新数字是资料基点的人工规划估计，不代表本轮已完成文档还要重复做，也不是代理耗时或交付日期；旧数字仅历史。纯文档不再重复触发全套构建。
4. **工程缺口**：ZMODEM 自研、tmux 界面、SCP 目录传输、完整 PowerShell 与管理员 shell、Wayland 等，见归档第 5 节；PowerShell 本批有限验收以 P1 记录为准。
5. **终端内核**：按[技术调整决策](p0/TERMINAL_CORE_ADR.zh-CN.md)推进。启用 SIXEL 之前，需要评审 CSP 中的 `wasm-unsafe-eval`。

## 本地验证命令

```sh
export PATH="$HOME/.cargo/bin:$PATH"
M=apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path $M -- --check
cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path $M --all-features            # 单元与集成测试；部分测试需要本机 tmux 或 ssh-agent，缺少时会跳过
node --test tests/fixtures/ssh-sftp/rust-client.test.mjs          # 真实 OpenSSH：SFTP 与 SCP
node --test tests/fixtures/ssh-sftp/fixture.test.mjs
node --test tests/fixtures/ssh-terminal/rust-client.test.mjs      # 真实 OpenSSH shell
(cd apps/desktop && npm run build && npx playwright test)        # 需要先另开 npm run dev
```

补充说明：
- **Windows 代码的本机检查**：运行 `tools/wincheck/wincheck.sh`，它对 `x86_64-pc-windows-msvc` 目标执行 clippy，用桩头文件、假 `ar` 和假 `rc` 跳过 C 依赖的链接。这只做类型检查，Windows 测试只能在 CI 上运行。
- **Playwright 开发服务器**：多个子代理并行时，各自用不同的 Vite 端口，例如 1431–1437，并使用不提交的本地 Playwright 配置，避免互相关闭对方的 1420 服务。

提交前执行 `git diff --check`。

## 交接后的工作方式

- 继续执行，不要只给计划；先检查现状，再做最小可验证改动。
- 进度用中文简短报告：当前动作、证据、未验证范围、下一步。
- 不要询问已经明确的技术路线或视觉方向。
- 不要重置工作区，不要覆盖其他模型或用户的未提交改动。
- 任何外部发布、删除、覆盖、发送消息等不可逆操作，都要在具体结果准备好后再确认；普通本地开发、测试、文档和提交可以直接继续。
- 代码改动后必须让 Rust reviewer 或 verifier 独立审查。审查结论与处理方式要写进 RESULTS。
- 新增 Tauri 命令要改三处：`lib.rs`、`build.rs`、`capabilities/main.json`。
- 只改文档的提交在标题末尾加 `[skip ci]`。
