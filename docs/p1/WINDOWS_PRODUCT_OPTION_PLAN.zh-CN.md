# Windows PowerShell 首次目录查询停滞：单个产品方案评估与预注册

本文按 [2026-11-07 用户决定](RESULTS.zh-CN.md#2026-11-07-用户决定15-项全部采用推荐项)第 2 项撰写：不再增加诊断实验，先评估单个产品方案并写成执行前预注册，交用户审阅后再决定是否实施。本文只做评估与预注册，**不修改代码、不推送、不 dispatch**；方案的实施、推送和运行分别需要用户批准（第 6 节）。撰写依据为 `p1/integration` 的 `35aee13`。

数值和结论措辞均摘自 [P1 执行记录](RESULTS.zh-CN.md) 原文。标注“由表逐行读出”的范围，是作者从记录表格各行读取的，记录正文没有给出这个区间。本文不重新解释根因：所有已有记录都写明根因未定，下列方案都不是根因修复。

## 1. 问题与已有证据

第四批 Windows 原生场景 6 `local-terminal-shell` 显式选择 Windows PowerShell 5.1，依次输入 `[Console]::OutputEncoding` 设置、版本表达式和普通 `(Get-Location).Path`。`39063630062` 与 `42268048590` 都在首次目录查询处 30 秒超时；成功的历史运行也记录了 17–30 秒级的同类延迟。产品启动链只设置 cwd，不内置 `Get-Location`；该查询来自原生验收场景。

| 运行（层） | 条件 | 原文数值 | 原文结论（节选） |
| --- | --- | --- | --- |
| `39740945170`（stdio） | 首次 `Get-Location`：产品白名单 / 白名单 + 父 `PSModulePath` / 继承 − `PSModulePath` | 2022：21,177.0–28,064.6 / 29.2–30.0 / 89.8–92.2 ms；2025：19,605.6–26,389.0 / 31.8–32.8 / 83.4–83.7 ms | “支持 `PSModulePath` 与 stdio 首次 cmdlet 延迟存在强关联……它仍不是产品根因或 ConPTY 证据” |
| [`39749668866`](RESULTS.zh-CN.md#诊断实验实现与直接-conpty-复现仅测试侧)（直接 ConPTY） | 同上四组 | 2022：白名单 26,259.7–28,182.8、加回父值 20,808.8–20,837.7、继承 − 54.0–54.8 ms；2025：11,294.0–15,891.9、11,004.3–11,100.1、34.8–35.3 ms；继承 53.9–281.8 / 35.2–165.9 ms | “ConPTY 中仅加回父 `PSModulePath` 仍保持高延迟，不能把 stdio 实验里的 `PSModulePath` 关联当成已锁定因果” |
| `39799065768`（直接 ConPTY，八组） | 加回父值、系统路径、身份、进程运行时、显式空值 | 2022：加回父值“仍约 21.0–21.3 秒”，系统路径/身份/进程运行时/显式空变量组“也约 21.0–21.2 秒”，继承移除 `PSModulePath`“约 57 ms”；2025：其余白名单相关组“约 22.0–25.5 秒” | “直接 ConPTY 中‘加回父 `PSModulePath`’不能消除慢路径，因此尚未锁定具体变量或组件因果” |
| `39812975794`（直接 ConPTY） | 产品白名单 / 加回父值 | 2022：21.53–29.46 / 21.45–21.48 秒；2025：19.41 秒（仅成功样本）/ 19.40–26.40 秒；继承及继承移除 `PSModulePath`“约 53–364 ms” | “慢路径及间歇 marker timeout 仍存在，不能归因具体模块、变量或产品组件” |
| [`39816931188`](RESULTS.zh-CN.md#固定白名单的有限因果对照工作流-39816931188)（stdio） | 默认 / 抑制 progress / 禁用自动加载 | 默认 19.682 / 19.476、23.480 / 23.121 秒；抑制 progress 19.776 / 19.656、23.240 / 23.120 秒；禁用自动加载的四个观察均 exit 2；`progress-only` 校准 27.507 / 19.776、37.064 / 23.362 秒 | 抑制 progress “削弱‘可见 progress 输出解释全部时延’的候选解释”；禁用自动加载“是命令缺失，不是查询性能改善”；`progress-only`“包含 Utility 命令发现与可能的模块加载/初始化” |
| [`39819222771`](RESULTS.zh-CN.md#命令准备与查询阶段诊断工作流-39819222771)（stdio） | 无准备 / 精确 `Get-Command` / 显式导入 Management | cold `query-1` 29.322 / 21.396、28.074 / 22.752 秒；discover 准备 21.381 / 21.281、22.738 / 22.699 秒；import 准备 48.665 / 44.236、59.024 / 49.369 ms；import 后 `query-1` 2.575 / 2.516、2.598 / 2.583 ms；import 进程 wall 248.247 / 243.965、276.046 / 265.583 ms；import 样本 stderr 为空 | “不能直接将显式导入写入产品启动或据此关闭 ConPTY/WebView2 故障” |
| [`40164795306`](RESULTS.zh-CN.md#conpty-framed-查询对照工作流-40164795306)（ConPTY） | 普通 / 模块限定查询 | 普通首次 q1 11299.5118–27513.9404 ms；模块限定首次 q1 22.3006–37.4313 ms | “模块限定只作诊断对照，不替换产品或原生普通查询；普通首次慢路径仍存在” |
| [`40166224227`](RESULTS.zh-CN.md#conpty-运行时环境有限干预工作流-40166224227)（ConPTY） | 运行时把 `PSModulePath` 替换为父值 | parent 首次 q1：2022 为 11405.0151 / 11615.0356 ms，2025 为 22326.6272 / 22985.8476 ms；八个样本均 `effectivePresent=true,effectiveNonempty=true,effectiveEqualsParent=false` | “没有消除秒级首次慢路径……不等于完全排除该变量及其与其他因素的交互” |
| [`40167503032`](RESULTS.zh-CN.md#conpty-准备阶段对照工作流-40167503032)（ConPTY） | D：精确 `Get-Command`；I：`Import-Module -Name Microsoft.PowerShell.Management -PassThru -ErrorAction Stop` 加身份校验；之后各两次普通查询 | D 准备 11847.4912–29484.9300 ms；I 准备 24.4259–38.1349 ms；准备后 q1 1.7095–13.5463 ms（其中 I 的四行为 1.7383–2.3481 ms，由表逐行读出）；q2 0.1563–0.2610 ms | “两 arm 都先改变了会话状态……不能据此宣称产品冷查询改善” |
| 原生 `39759997877` / `39764709186` / `39783803294`（WebView2，均成功） | 产品场景 6 | `cwd-send-to-row` 分别为 17,814.4–27,672.2、21,783.2–30,204.8、21,596.8–27,648.6 ms；`39759997877` 的版本行为 522.8–766.4 ms | “这把延迟定位到真实 WebView2→产品 PTY→Windows PowerShell 的可观测链路……仍不区分 Tauri IPC、ConPTY、PowerShell 初始化或环境策略中的具体环节” |
| 原生 [`42268048590`](RESULTS.zh-CN.md#当前产品树有限原生验收刷新工作流-42268048590)（WebView2） | 当前产品树刷新 | 场景 6 首次 cwd `timed out after 30000 ms`；`version-send-to-row` 为 `801.4940000000024`；同轮场景 5（cmd）`cwd-send-to-row` 为 `291.15399999999863` / `290.3919999999998`；`P1_SHELL=5.1.20348.5773` | “只能记为与 `39063630062`……同类的现象……不确定根因”；“显式导入等候选产品方案未因此获得支持” |

模块分析缓存变量 `PSModuleAnalysisCachePath` 只有文档和 runner-images 源码依据，执行记录写明：“产品白名单未保留该变量、既有矩阵未单独检验；当前 runner 的实际值及缓存状态尚未核实，源码及其提示不是本轮根因证据。”

## 2. 当前产品启动契约（源码核对，`35aee13`）

- 八项白名单和 PowerShell 固定 argv 都在 `apps/desktop/src-tauri/src/local_shell.rs` 的 `command_at`。`pty.rs` 只经 `platform::command_with_options`（`pty.rs:580`）取得构造好的命令，没有 PowerShell 专属逻辑。
- `command_at` 的 argv：`bash` 为 `--noprofile --norc -i`，`zsh` 为 `-f -i`，`"pwsh" | "powershell"` 共用 `-NoLogo -NoProfile`，`cmd` 为 `/D /Q /K`。随后 `env_clear()`。Windows 非 cmd 分支中，`SystemRoot`、`PATH` 必须存在（缺失即报错），`ComSpec`、`USERPROFILE`、`TEMP`、`TMP`、`APPDATA`、`LOCALAPPDATA` 六项存在时才复制，最多合计八项；cwd 默认为 `temp_dir()`。
- Windows 候选只有 `cmd`、`powershell`、`pwsh`，Unix 候选只有 `bash`、`zsh`、`pwsh`。Windows 默认一键入口是 `platform::local_command` 的 cmd（`SystemRoot`、`ComSpec`、`PATH` 加 `PROMPT`），不经过 `command_at`。
- `platform::command_with_options` 依次执行：校验 env/locale、校验 cwd、`command_at` 或 `local_command`、设置 cwd，最后 `local_environment::apply`。用户 env 条目在产品环境之后写入，可以覆盖未保留的名称。
- `local_environment.rs` 的 `RESERVED` 含 `PSModulePath`，保留前缀含 `DOTNET_`、`CORECLR_`、`COR_`、`COMPlus_`；`PSModuleAnalysisCachePath` 不在保留名单中。
- 测试 `explicit_shells_use_fixed_argv_and_controlled_environment` 断言五个 ID 的精确 argv，并断言 `PSModulePath` 等变量不会被继承。该测试用临时文件调用 `command_at`，所有平台都会运行。
- 原生场景 7 的 Windows PowerShell 输入只有 `$env:`、.NET 方法调用以及 `if`/`exit` 关键字，没有 cmdlet；它在 `42268048590` 中通过（41440 ms）。这里只描述测试输入，不据此推断原因。

## 3. 候选方案逐项评估

### 方案 0：保持现状（对照）

不改产品，把 Windows PowerShell 5.1 首次 cmdlet 停滞写成第四批已知限制。场景 6 预计继续可能超时，也可能在 17–30 秒间通过，与第 1 节一致。不影响任何其他 Shell 或契约。

### 方案 A：启动时显式导入 `Microsoft.PowerShell.Management`

- **改动点**（只描述）：在 `local_shell.rs::command_at` 中拆开 `"pwsh" | "powershell"`。`pwsh` 保持 `-NoLogo -NoProfile`；`powershell` 在其后追加 `-NoExit -Command` 和固定文本 `Import-Module -Name Microsoft.PowerShell.Management -ErrorAction Stop`。文本是编译期常量，不含用户输入、路径或环境值。同文件测试改为对 `powershell` 断言新 argv，其余 ID 的 argv 和环境断言不变。
- **argv 形式**：建议把命令文本拆成多个不含空白的 argv 元素。锁定的 portable-pty 0.9.0 中，`src/cmdbuilder.rs:702` 起的 `append_quoted` 对不含空格、制表符、换行、垂直制表符和双引号的参数原样拼接，否则加引号转义（只读核对，未复制代码）。按 [about_PowerShell_exe](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)，`-Command` 必须是最后一个参数，其后的参数都作为要执行的命令；`-NoExit` 让会话在执行完启动命令后继续交互。5.1 实际得到的命令行只能由 Windows 原生运行确认。
- **依据**：真实 ConPTY `40167503032` 中，I（显式导入加身份校验）准备为 24.4259–38.1349 ms，随后普通 q1 的四行为 1.7383–2.3481 ms（由表逐行读出）；stdio `39819222771` 的方向一致（import 准备 44.236–59.024 ms，import 后 `query-1` 2.516–2.598 ms，均由表逐行读出；stderr 为空）。同层的普通首次查询为 11299.5118–27513.9404 ms（`40164795306`）。这些是有限顺序对照，执行记录明确不把它们称为产品冷查询改善。
- **与证据的差异**（均未验证）：证据形式带 `-PassThru` 和身份校验，是 READY 之后的交互输入（ConPTY）或 `-NonInteractive -EncodedCommand`（stdio）；产品形式没有 `-PassThru` 与校验，通过 `-NoExit -Command` 在首个提示符之前执行，经过 Tauri 产品 PTY 链路。证据运行的 runner 镜像也可能与下次验证不同（`42268048590` 读回 `5.1.20348.5773`，历史为 `5.1.20348.5622`）。
- **执行策略与模块加载**：固定 `-Command` 文本不是脚本文件。导入的是 Windows PowerShell 自带模块；首次使用 `Get-Location` 时的自动加载也会加载同名模块（两轮身份校验只核对名称和类型，没有核对文件路径）。执行策略对脚本、模块脚本和配置文件的适用范围，实施前按 [about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1) 核对。已有工件没有记录 runner 的执行策略；用户机器上的 Restricted/AllSigned、组策略、AppLocker/WDAC 或受限语言模式下导入是否报错，均未验证。自动加载偏好不变，其他模块仍按需加载。
- **失败行为**：不用 `SilentlyContinue` 隐藏错误。导入失败时，PowerShell 自己的错误文本会出现在终端；预期在 `-NoExit` 下会话仍进入交互，查询退回现状（未验证，原生场景不覆盖该路径）。
- **名称解析**：按名称导入会在子进程实际的模块搜索路径中解析。`40166224227` 记录该值在子进程中存在、非空且与父参考值不同，但没有保存内容。如果搜索路径靠前的位置有同名模块，导入可能选中它；首次自动加载依赖同一搜索路径。方案不新增环境来源，但会让每个会话启动时都触发这次解析，即使用户从不调用该模块的命令。改为 `$PSHOME` 下绝对路径导入可以避开名称解析，但这个变体没有实测证据（见第 6 节 A2）。
- **环境与隐私**：不新增父环境变量，八项白名单和保留名单不变，命令文本不含用户数据。进程命令行对同一用户的其他进程可见，其中只有该常量。组策略开启脚本块日志或转录时，可能记录这段固定文本（未验证）。`-NoProfile` 不等于禁用历史；`-Command` 文本是否进入 PSReadLine 历史，以及 `-NoExit -Command` 下 PSReadLine 是否照常加载，均未验证。
- **启动成本**：每个 Windows PowerShell 会话启动时多一次导入。runner 上的数值是 24.4259–38.1349 ms（ConPTY）和 44.236–59.024 ms（stdio，由表逐行读出），都包含身份校验，不外推到用户机器。
- **受控启动策略**：argv 仍是固定常量，不接受自由命令。但产品第一次在 PowerShell 启动链中内置一条命令，执行记录中“产品启动链本身没有内置 `Get-Location` 查询”应改写为“内置一条导入命令，仍无 `Get-Location`”，并同步 `CLAUDE.md`、[P1 计划](PLAN.zh-CN.md)和[启动后执行命令预案](STARTUP_COMMAND_PLAN.zh-CN.md)中“参数 `-NoLogo -NoProfile`”的表述。
- **对 cmd / pwsh / 非 Windows**：默认和显式 cmd 的 argv 与环境不变；Windows 和 Unix 的 `pwsh` 不变；`powershell` 不在 Unix 候选中，macOS 和 Linux 不受影响。只有用户显式选择 Windows PowerShell 时才生效。
- **与已交付行为**：第三批已合入 main 的 Windows PowerShell 固定 argv `-NoLogo -NoProfile` 会改变，后续合并请求须写明。第四批的 env/locale 仍在 `command_at` 之后应用，八项白名单与 `PSModulePath` 保留不受影响。用户 env 仍可设置未保留的 PowerShell 相关变量（例如 `PSModuleAnalysisCachePath`），与启动导入的交互未验证。启动后命令（`1c60af2`）在 `pty_open` 返回后经输入队列发送，PowerShell 在 `-Command` 完成后才读取交互输入；该切片在 Windows 上本来就未验证。重开继承原选项，每次 argv 相同。

### 方案 B：把父进程 `PSModulePath` 加入白名单

- **改动点**：在 `command_at` Windows 非 cmd 分支的复制列表中加入 `PSModulePath`（也可限于 `powershell`），删除同名测试中“不得继承 `PSModulePath`”的断言；`RESERVED` 不变，用户仍不能设置。
- **依据**：只有 stdio 支持（`39740945170`：29.2–30.0 / 31.8–32.8 ms）。真实 ConPTY 反复不支持：`39749668866` 为 20,808.8–20,837.7 / 11,004.3–11,100.1 ms，`39799065768` 为“仍约 21.0–21.3 秒”，`39812975794` 为 21.45–21.48 / 19.40–26.40 秒；运行时替换 `40166224227` 后仍为 11405.0151 / 11615.0356 ms（2022）和 22326.6272 / 22985.8476 ms（2025）。执行记录还写明“父参考不是 PowerShell 默认值或推荐产品策略”。
- **副作用**：父进程的值取决于应用的启动方式（资源管理器、其他终端、PowerShell 7 会话等），内容不受产品控制，可能包含用户可写目录、第三方模块或网络路径，自动加载可能从这些目录载入模块代码。只继承一个变量也会削弱 `local_shell.rs` 文档“the complete parent environment is never inherited”的受控意图。保留名单的语义变得不一致：产品继承父值，用户却不能设置。白名单由八项变为九项，而既有诊断和文档都把“八项白名单”当作固定条件。若 `pwsh` 也继承，Windows PowerShell 与 PowerShell 7 的模块路径不同，可能加载不兼容的模块（未验证）。
- **影响范围**：cmd 不受影响；`pwsh` 是否受影响取决于范围；非 Windows 不受影响。
- **结论**：ConPTY 与运行时证据都不支持，不推荐。

### 方案 C：由产品设置 `PSModuleAnalysisCachePath`

- **改动点**：在 `command_at` 中为 `powershell` 设置该变量，指向产品控制的目录（例如应用数据目录下），并决定是否加入 `RESERVED`。
- **依据**：没有实测，只有第 1 节引用的文档和源码依据，执行记录明确它“不是本轮根因证据”。要采用它，必须先做诊断证实，这与 11-07 决定第 2 项冲突。
- **副作用**：产品需要创建并写入缓存文件，处理多会话并发、清理和损坏；缓存会反映搜索路径中的模块与命令名，属于新增的持久数据。该变量目前不在 `RESERVED` 中，而 `apply` 在 `command_at` 之后执行，用户条目会覆盖产品值；若加入保留名单，此前可接受的用户输入会被拒绝，改变第四批契约。
- **结论**：缺少证据且需要先做诊断，不推荐。

### 方案 D：放宽为继承父环境

- **D1 完整继承**，**D2 继承后只移除 `PSModulePath`**：ConPTY 证据显示两者都快（继承 53.9–281.8 / 35.2–165.9 ms，继承 − 54.0–54.8 / 34.8–35.3 ms，`39749668866`；`39812975794` 约 53–364 ms）。但这会推翻第三、四批“受控启动参数和环境”的契约，把保留前缀所防范的加载相关变量（`LD_*`、`DOTNET_*`、`COR_*`、`COMPlus_*` 等）以及父环境中可能存在的令牌一并传给子进程，也失去可复现性。第四批“默认保留平台现有设置”的 locale 语义也会改变。不推荐。
- **D3 只加入系统路径、身份或进程运行时变量组**：`39799065768` 中这些组在 ConPTY 仍“约 21.0–21.2 秒”（2022），`39788501384` 的 ConPTY 中“其余新增变量组约 17–25 秒”。证据不支持，不推荐。

### 已有证据排除的做法

| 做法 | 证据 | 排除理由 |
| --- | --- | --- |
| 抑制 progress | `39816931188`：19.776 / 19.656、23.240 / 23.120 秒 | 慢路径仍在 |
| 禁用模块自动加载 | `39816931188`：四个观察均 exit 2 | 命令缺失，不是性能改善 |
| 启动时用精确 `Get-Command` 预热 | `40167503032` D 准备 11847.4912–29484.9300 ms；`39819222771` discover 准备 21.381 / 21.281、22.738 / 22.699 秒 | 较长时间出现在准备区间，等于把等待移到启动 |
| 改用模块限定命令 | `40164795306`：22.3006–37.4313 ms | 产品不发出 `Get-Location`，也不改写用户命令；执行记录明确它不替换普通查询 |
| 导入更多模块（如 Utility） | 无实测 | 没有证据，不属于本方案 |

### 对比摘要

| 方案 | 改动 | 真实 ConPTY 证据 | 环境与隐私 | 与受控启动 / 保留名单 | 影响范围 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 保持现状 | 无 | —（问题仍在） | 无变化 | 无冲突 | — | 对照 |
| A 显式导入 | `command_at` 中 `powershell` 的 argv | 支持（I：24.4259–38.1349 ms 准备，其后 q1 为毫秒级） | 不新增变量 | argv 仍固定，但新增一条内置命令 | 仅显式 Windows PowerShell | **推荐** |
| B 父 `PSModulePath` | 白名单变九项 | 不支持（多轮约 11–26 秒） | 引入父进程值 | 与保留名单语义冲突 | powershell，或含 pwsh | 不推荐 |
| C 分析缓存路径 | 新增产品变量和缓存目录 | 无 | 新增持久数据 | 可被用户覆盖，或改变保留名单 | powershell | 不推荐 |
| D1/D2 继承 | 取消 `env_clear` 或大幅扩展 | 快 | 父环境整体进入子进程 | 推翻第三、四批契约 | 所有显式 Shell | 不推荐 |
| D3 变量组 | 白名单扩展 | 不支持（约 17–25 秒） | 引入部分父值 | 改变八项契约 | powershell | 不推荐 |

## 4. 推荐方案 A 及其边界

**推荐**：只对 `powershell` ID 实施方案 A，即按名称导入（与已测形式相同的模块名和 `-ErrorAction Stop`），通过 `-NoExit -Command` 在启动时执行。实施时只改 `local_shell.rs`（含同文件测试）和相关文档，不改 `platform.rs`、`pty.rs`、`local_environment.rs`、前端、Tauri 命令/ACL 或依赖。

理由：

1. 在真实 ConPTY 上，只有它在产品白名单下有“干预之后首个普通 `Get-Location` 为毫秒级”的证据（`40167503032` 的 I 行），stdio `39819222771` 的方向也一致。B、D3 在 ConPTY 中不支持；C 没有实测；D1/D2 虽然快，但与受控启动契约冲突。
2. 不改变环境白名单、保留名单或任何父环境的传递，不新增隐私面。
3. 只作用于显式选择的 Windows PowerShell，cmd 默认入口、`pwsh` 和 Unix 都不变。
4. 改动只有一处固定 argv，可以用一个 revert 提交完整撤回。

**它不是根因修复**，边界如下：

- 根因仍未定。方案只是改变首个 `Get-Location` 之前的会话状态，不解释慢路径的内部机制，也不关闭 `39063630062` 或 `42268048590` 的失败记录。
- 证据只覆盖 `Get-Location` 所在的 Management 模块。其他模块的命令首次调用没有在导入后测过；`39816931188` 的 `progress-only` 校准在 stdio 中为 27.507 / 19.776 秒（2022）和 37.064 / 23.362 秒（2025），执行记录写明它“包含 Utility 命令发现与可能的模块加载/初始化”。用户第一次使用其他模块的命令时，仍可能出现同类等待。
- 产品形式与证据形式不同（第 3 节 A 的“与证据的差异”），二者等效未经验证。下一次原生运行是产品形式的第一份证据。
- 不覆盖 PowerShell 7、Windows Server 2025 原生（原生作业只有 windows-2022）、用户机器的执行策略/组策略/模块路径/网络环境、PSReadLine 与历史行为、IME、读屏或性能验收。
- 每个 Windows PowerShell 会话都要承担导入成本，即使用户从不调用该模块的命令。
- 不涉及 stdio 诊断中的 392 字节未知 stderr；原生 runner 不单独采集 stderr，不能据此得出任何 stderr 结论。

## 5. 预注册验证（实施获批后适用）

### 5.1 被测对象与 dispatch 前核对

- `<BASE>`：实施分支的起点，必须是远端 `p1/integration` 上已存在的提交，执行时填写。`<HEAD>`：协调者集成并推送到远端 `p1/integration` 的 40 位提交，执行时填写，不得预先编造；它必须同时包含本方案文件和实现提交，以证明方案先于执行。
- `git diff --stat <BASE> <HEAD> -- apps/desktop` 只允许出现 `apps/desktop/src-tauri/src/local_shell.rs`；`tests/native/` 和 `.github/workflows/p0-cross-platform.yml` 不得有差异（撰写时 `e7faa0f..35aee13` 在这两处也无差异）。出现其他差异时，本方案的判据和解读不再自动适用，须先修订、复审再 dispatch。若 `<BASE>` 相对 `35aee13` 还含其他产品提交，结果记录须逐项列出，并且不能把与历史运行的差异归于本方案。
- 推送前的本机门禁（macOS，不是 Windows 证据）：先在 `apps/desktop` 执行 `npm ci`、`npm run build`；然后在仓库根执行 `cargo fmt --check`，以及 `--locked --all-targets --all-features` 的 `cargo check` 与 `cargo clippy -D warnings`；`RUST_TEST_THREADS=2 cargo test --locked --lib --all-features`；`tools/wincheck/wincheck.sh`；`node --test tests/native/webdriver.test.mjs tests/native/support.test.mjs tests/native/runner-config.test.mjs`；`git diff --check`。实现还须通过独立 Rust 审查。结果原样记录，不能代替 Windows 实测。
- 推送 `p1/integration` 不会触发 `p0-cross-platform.yml`（push 只针对 `main`）。撰写时核对，各 `p1-windows-*` workflow 的 push 路径都不含 `local_shell.rs` 或 `docs/`。若推送后仍出现其他运行，单独记录，不并入本验证。
- dispatch 执行者先记录 UTC 时间，再只读核对：`git rev-parse origin/p1/integration` 等于 `<HEAD>`；`gh run list --workflow p0-cross-platform.yml --branch p1/integration` 中没有 queued 或 in_progress 的运行。撰写时（2026-11-07）该分支上有一条进行中的 `workflow_dispatch` 运行 `42340067995`（headSha `35aee13…`，对应用户决定第 1 项的完整 CI），其结果以执行记录为准，本方案不引用也不预判。workflow 的并发设置为 `cancel-in-progress: true`，同一 ref 上的新 dispatch 会取消进行中的运行，因此必须等它结束。

### 5.2 工作流、输入与作业（按 workflow 文件核实）

- 复用 `.github/workflows/p0-cross-platform.yml` 的 `workflow_dispatch`。三个输入：`native_only`（boolean，默认 false；为 true 时 `gssapi` 与 `desktop` 因 `if: ${{ !inputs.native_only }}` 跳过）、`windows_shell_repeats`（number，0–10，只传给 Windows 原生步骤）、`windows_webview_timing`（boolean，只映射为 Windows 的 `P1_NATIVE_WEBVIEW_TIMING`）。
- 本验证取 `native_only=false`，共 7 个作业：`gssapi` 1 个（20 分钟）；`desktop` 4 个（macOS arm64 `macos-15`、Linux x64 `ubuntu-24.04`、Windows `windows-2022`、Windows Server 2025 `windows-2025`，各 35 分钟，都运行 `cargo test --all-features --locked --all-targets`）；`native-webview` 2 个（Linux WebKitGTK `ubuntu-24.04`、Windows WebView2 `windows-2022`，各 40 分钟）。全部为 `fail-fast: false`。Linux desktop 的 lrzsz 步骤是 `continue-on-error: true`，只记录结果，不计入作业结论。
- 选完整门禁，是因为改动的是 Rust 产品代码，需要 4 个 desktop 作业运行更新后的 argv 测试；`native_only=true` 会跳过它们。
- 两个原生作业各跑既有 7 个场景，顺序、断言和时间门限见[原生验收刷新预注册](NATIVE_REFRESH_PLAN.zh-CN.md#两平台实际运行的-7-个场景)，本验证不改。要点：终端输出行等待 30 秒，从输入调用返回后开始计时；场景 6 的 trace 只追踪两次 `pty_open`，容量 256 KiB，incomplete 或 truncated 即失败。
- `windows_webview_timing=true` 与 `42268048590`、`39783803294` 相同，使场景 5、6 的证据带 `timings`，场景 6 的 trace 带 stage 记录；这与 push/PR 默认门禁不是同一配置，结果中须注明。`windows_shell_repeats=0`。
- 工件 7 个，只接受 attempt 1：`p0-gssapi-1`、`p0-aarch64-apple-darwin-macos-15-1`、`p0-x86_64-unknown-linux-gnu-ubuntu-24.04-1`、`p0-x86_64-pc-windows-msvc-windows-2022-1`、`p0-x86_64-pc-windows-msvc-windows-2025-1`、`p0-native-webview-x86_64-unknown-linux-gnu-ubuntu-24.04-1`、`p0-native-webview-x86_64-pc-windows-msvc-windows-2022-1`，保留 14 天。

### 5.3 唯一 dispatch（待用户批准，尚未执行）

```sh
gh workflow run p0-cross-platform.yml --repo mofyer/new-windterm --ref p1/integration \
  -f native_only=false -f windows_shell_repeats=0 -f windows_webview_timing=true
```

`<RUN_ID>` 是记录时间之后新出现、`event=workflow_dispatch`、`headSha=<HEAD>` 的唯一一条运行，用 `gh run watch <RUN_ID> --exit-status` 等待结束。新运行多于一条、headSha 不符或运行被取消，都记为无效，不再 dispatch 补救。

### 5.4 预先声明的判据

**门禁判据 G**（全部满足）：

1. 运行绑定：`event=workflow_dispatch`、`headBranch=p1/integration`、`headSha=<HEAD>`、`attempt=1`、`conclusion=success`；7 个作业均为 success，没有 skipped。
2. desktop：4 个作业的 `rust-tests.log` 都是 0 failed；4 个平台都出现 `explicit_shells_use_fixed_argv_and_controlled_environment ... ok`。通过数与忽略数原样记录。
3. 原生 `summary.json`（两平台）：`result=passed`，没有顶层 `error`；`shellRepeats=0`；`counts.base` 为 7/7/7/0/0，`counts.diagnostic` 为 0/0；场景名称与顺序同既有 7 项。
4. 原生 `06-local-terminal-shell-trace.json`（两平台）：`schema=1`、`limitBytes=262144`、`incomplete=false`、`truncated=false`、`droppedRecords=0`、`incompleteReasons=[]`。
5. 两个原生作业的 helper 单测均为 0 failed；跳过项不计为通过。

**效果判据 E**（Windows 场景 6，来自 summary 证据中的 `timings` 与 `identities`，全部满足）：

1. `initial cwd query` 与 `reopened cwd query` 各有 `open-to-ready`、`version-typeInTerminal`、`version-send-to-row`、`cwd-typeInTerminal`、`cwd-send-to-row` 五条记录，共 10 条。
2. 两个样本的 `cwd-send-to-row` 都 ≤ 5,000 ms。
3. 两个样本的 `version-send-to-row` 都 ≤ 5,000 ms，防止等待只是从目录查询移到了启动后的第一条输入。
4. 两个 `identities` 相同，都以 `P1_SHELL=5.1.` 开头，确认被测的是 Windows PowerShell 5.1。

5,000 ms 是执行前固定的解读门槛，不是 runner 门限，也不修改任何代码断言。它只用已记录的数值来定：低于第 1 节所列原生成功运行的 `cwd-send-to-row` 最小值 17,814.4 ms（`39759997877`），也低于第 1 节所列 ConPTY 慢样本的最低值 11,004.3 ms（`39749668866`）；同时是 `42268048590` 同轮 PowerShell `version-send-to-row`（`801.4940000000024`）和 cmd `cwd-send-to-row`（约 290 ms）的数倍。它只用来区分“与历史慢样本同量级”和“明显更快”，不代表性能验收。历史成功运行中，旧产品也常在 30 秒内通过场景 6，所以只看 G 不足以说明方案的作用。

**结论分类**：

| 分类 | 条件 | 记录方式 |
| --- | --- | --- |
| 通过 | G1–G5 与 E1–E4 全部满足 | 按 5.6 的允许解读记录 |
| 效果未达 | G 满足，E 任一不满足 | 记为方案未通过：“未观察到预注册效果” |
| 场景失败 | 任一原生场景失败（含场景 6 在 30 秒等待中超时） | 记为方案未通过，原样记录阶段与错误 |
| 作业失败 | 场景以外的作业或步骤失败（含 desktop Rust 测试、GSSAPI） | 记为整体未通过；E 只作单次描述，不得据此判方案有效 |
| 前置失败 | 安装、构建等步骤失败，未进入测试 | 记为未通过，不推断方案效果 |
| 无效 | 取消、绑定不符、多余运行、工件缺失或 digest 不符 | 记为无效 |

`driverExit`、`fixtureExit.report`、`remainingTabs` 与 `versions.log` 原样记录；出现异常值时须报告，不能写“清理正常”，但不改变上表结论。

### 5.5 停止规则

- 只 dispatch 一次，只采用 attempt 1。第一次未通过（含效果未达和无效）即停止：不执行 `gh run rerun`（含 `--failed`），不再次 dispatch，不把 `windows_shell_repeats` 改为非 0 来补样本，不用后来的成功覆盖这次结果。
- 不放宽 30 秒行等待、trace 容量、任何断言或 5,000 ms 效果门槛。除方案 A 的 argv 外，不改八项白名单、保留名单、`pwsh`/cmd 的 argv、普通查询或场景；不改用模块限定查询，不增加导入的模块，不临时改为绝对路径导入。
- 运行中不主动取消；因外部原因被取消，记为无效，不自动重新 dispatch。
- 未通过后的任何变体或后续运行，都要先另行预注册并取得用户决定；新运行单独记录，不与本次拼接。实现是否撤回见第 6 节决定 3。

### 5.6 允许与禁止的解读

**通过时允许写**：在本次 GitHub runner 的 Windows Server 2022 WebView2 上，精确 `<HEAD>` 的 Windows PowerShell 5.1 会话（启动时显式导入 `Microsoft.PowerShell.Management`）首次与重开的普通 `(Get-Location).Path` 都在原 30 秒等待内出现期望目录行，满足预注册效果判据（附 `cwd-send-to-row` 与 `version-send-to-row` 原值）；完整 7 作业一次通过。结果与 `40167503032` 的显式导入 arm 方向一致。可以与 `42268048590`、`39783803294` 并列展示，但它们不是配对对照（SHA、runner 镜像、repeats 与时间都不同）。

**通过时禁止写**：

- 根因已定，或慢路径已修复、Windows 终端已完整可用；`39063630062`、`42268048590` 的失败已被解释或关闭；
- 其他模块命令的首次调用也已变快；
- PowerShell 7、Windows Server 2025 原生、macOS WKWebView、用户真实桌面（执行策略、组策略、模块路径、网络）、PSReadLine/历史、IME、读屏或性能已验收；
- 单次通过证明稳定，或可以排除间歇失败；
- 第四批已验收、P1 已通过，或可以合并 main；
- 显式导入的内部机制已明确，或 392 字节未知 stderr 已解决。

**未通过时**：原样记录失败的作业、场景、阶段、错误文本、`timings` 原值和 failure 工件。不归因于 Enter 丢失、WebDriver、IPC、ConPTY、PowerShell 初始化、执行策略、早期输入门控或 runner 负载，不称偶发或 flaky，不用历史成功抵消。效果未达时，只能写“本次未观察到预注册效果”，不得据此断言显式导入无效或有害。

### 5.7 工件独立核验与记录

由 dispatch 执行者以外的独立核验者在 14 天保留期内完成，结果写入[执行记录](RESULTS.zh-CN.md)新小节“Windows PowerShell 启动导入方案验证（工作流 `<RUN_ID>`）”：

1. **run/SHA 绑定**：`gh run view <RUN_ID> --json headSha,headBranch,event,status,conclusion,attempt,jobs,createdAt,updatedAt`；用 `gh run list --commit <HEAD>` 列出同一 SHA 的全部运行，其他 workflow 的运行单独列出。REST 不返回 dispatch 输入，按 `42268048590` 记录的方式从作业日志和工件间接核实三项输入。
2. **下载与 SHA-256**：用 `gh api repos/mofyer/new-windterm/actions/runs/<RUN_ID>/artifacts` 记录 7 个工件的 id、name、size 和 digest。逐个下载到新建的空目录，`shasum -a 256` 结果须与 digest 去掉 `sha256:` 前缀后按小写完全一致，否则记为核验失败。解压到 `.artifacts/p1/windows-product-option/<RUN_ID>/<name>/`。工件按不可信数据处理：核验脚本放在其他目录，以 `python3 -I` 或只读命令通过路径参数读取。
3. **固定字段**：逐项核对 G1–G5 与 E1–E4。原生部分按[原生刷新方案](NATIVE_REFRESH_PLAN.zh-CN.md#工件独立核验与记录)第 3 步核对场景证据，另外原样记录 Windows 场景 5、6 的全部 `timings`（保留原浮点值）和两次 `identities`。desktop 部分从各 `rust-tests.log` 记录通过、失败和忽略数，以及 argv 测试所在行；GSSAPI 记录作业结论与日志摘要。
4. **文件哈希**：记录 7 个 zip，以及每个原生平台的 `summary.json`、`06-local-terminal-shell-trace.json`、`07-local-terminal-environment.json` 和 4 个 `rust-tests.log` 的 SHA-256；若有 failure JSON，一并记录。
5. **记录内容**：`<BASE>`、`<HEAD>` 及其产品差异、`<RUN_ID>`、三项输入、7 个作业的结论与时长、两平台 7 个场景的状态与耗时、G/E 判据逐项结果、结论分类、清理附记、核验者与核验结论。工件不提交进仓库。

## 6. 需要用户决定的事项

本方案的本地提交不代表下列任何一项已获批准。

1. **是否实施方案 A**
   - **A1（推荐）**：按第 4 节实施：只改 `powershell` 的 argv（追加 `-NoExit -Command Import-Module -Name Microsoft.PowerShell.Management -ErrorAction Stop`），更新同文件测试和文档；完成本机门禁与独立审查后集成到本地 `p1/integration`，暂不推送，等待决定 2。
   - **A2**：同 A1，但改为按 `$PSHOME` 下的绝对路径导入。可以避开名称解析，但与已测形式不同，没有实测证据，结果不能引用 `40167503032` 作为同形证据。
   - **A3**：不实施，保持现状，把“Windows PowerShell 5.1 首次 cmdlet 可能等待 17–30 秒或超时”写成第四批已知限制，再由用户决定第四批的验收口径。没有代码改动。
   - 不推荐另行预注册新的诊断实验，那与 11-07 决定第 2 项相反。
2. **实施后是否推送并执行唯一一次 dispatch**
   - **B1（推荐）**：推送含实现与本方案的 `p1/integration`；等 `42340067995` 等同 ref 运行结束后，执行 5.3 的完整 7 作业 dispatch，由独立核验者按第 5 节记录。
   - **B2**：改用 `native_only=true`（只有 2 个原生作业）。更快，但不运行 4 个 desktop 作业的 Rust 测试（含更新后的 argv 测试）和 GSSAPI；即使通过，产品代码改动仍需另一次完整运行。采用前须先修订本方案的 G1、G2。
   - **B3**：暂不推送。
3. **未通过（含效果未达、场景失败、无效）时如何处置**
   - **C1（推荐）**：用一个 revert 提交从 `p1/integration` 撤回实现，不改写历史，保留本方案与结果记录；后续任何运行或变体（A2、更多模块等）都另行预注册并由用户决定。
   - **C2**：把实现保留在集成分支，等待后续决定。风险是后续运行会把一个未通过的产品改动当成基线。
4. **通过后是否以此处置第四批的 Windows 旧 Shell 场景**
   - **D1（推荐）**：作为该场景的产品处置进入第四批综合验收，同时在文档写明第 4 节的边界（其他模块首次命令、Server 2025 原生、PowerShell 7 均未测）。第四批合并 main 仍须综合验收后单独批准，不在本项决定。
   - **D2**：通过结果只作记录，第四批仍按 A3 的已知限制口径验收。

P1 与第四批均未验收，P2 仅在准备，main 不合并。
