# 当前产品树有限原生验收刷新预注册

本方案是 P1 第四批“当前产品树的有限原生验收刷新”的执行前预注册。只复用既有 [`p0-cross-platform.yml`](../../.github/workflows/p0-cross-platform.yml) 的手动 `native_only` 入口与[原生 runner](../../tests/native/run.mjs)，不新增 workflow、场景、诊断 arm、产品或测试代码，不修改任何门限。撰写依据为 `p1/integration` 的 `c3b3a68`（2026-11-07 核对远端 ref 一致）；本文件的提交不包含推送或 dispatch。

撰写时的源码与运行核对：

- 本 workflow 最近一次运行是 [`39783803294`](https://github.com/mofyer/new-windterm/actions/runs/39783803294)：`workflow_dispatch`、`headSha=263658e718824d15bd6ca82946cd2da4d0ef1c87`、attempt 1、success。前端早期输入门控 `85ce71b`/`b3716ad` 是 `263658e` 之后的提交，该运行不含当前前端产品代码；macOS 有限原生验收在 `bea905f`，同样早于门控。按 run 列表与执行记录，撰写时未见包含这两个提交的真实 WebKitGTK/WebView2 运行。
- `b3716ad..c3b3a68` 在 `apps/desktop` 下只改动 `dev-tools` 门控的诊断 bin 及 `src/bin/support`、`Cargo.toml` 中对应的 `[[bin]]`，以及两个浏览器 spec。Rust 非 bin 产品源码最后改动为 `333b2b7`，前端产品源码最后改动为 `b3716ad`。`tests/native/scenarios.mjs` 与 `terminal-trace.mjs` 最后改动为 `263658e`，`run.mjs` 与 workflow 为 `b0b8b54`，`runner-config.mjs` 为 `ab0ee0b`，`webdriver.mjs` 与 `processes.mjs` 为 `fbabc9d`。
- `39783803294` 的 GitHub 工件已过 14 天保留期，API 返回 `total_count=0`，本地 `.artifacts/p1/` 也没有该运行副本。下文引用的历史数值只来自[执行记录](RESULTS.zh-CN.md)文字，已无法独立复核。

因此本刷新只回答：精确 HEAD 的当前产品树，能否在两平台既有的 7 个原生场景中一次通过。它不是首次确认 Windows 原生是否慢（`39783803294` 已记录 21.6–27.6 秒同症），也不是根因诊断。历史运行只作参照，不作配对控制。

## 被测对象与 dispatch 前核对

被测 HEAD 记为 `<HEAD>`：协调者集成后推送到远端 `p1/integration` 的 40 位提交，执行时填写，不得预先编造。它必须包含本预注册文件，以证明方案先于执行。dispatch 执行者先记录当前 UTC 时间，再做以下只读核对：

```sh
git fetch origin
git rev-parse origin/p1/integration    # 必须等于 <HEAD>
git diff --stat c3b3a68 <HEAD> -- apps/desktop .github/workflows/p0-cross-platform.yml \
  tests/native/run.mjs tests/native/scenarios.mjs tests/native/terminal-trace.mjs \
  tests/native/runner-config.mjs tests/native/webdriver.mjs tests/native/processes.mjs \
  tests/native/msedgedriver.mjs tests/native/webdriver.test.mjs \
  tests/native/support.test.mjs tests/native/runner-config.test.mjs
node --test tests/native/webdriver.test.mjs tests/native/support.test.mjs tests/native/runner-config.test.mjs
gh run list --repo mofyer/new-windterm --workflow p0-cross-platform.yml --branch p1/integration \
  --limit 5 --json databaseId,status,conclusion,headSha,event
```

- diff 若涉及该 workflow 或上列 runner、场景、helper 文件，本方案对场景和判据的描述不再自动适用，须先修订、复审再 dispatch。diff 若涉及产品源码，结果记录须逐项列出被测树相对 `c3b3a68` 的产品差异。
- 撰写时，本机 macOS（Node 26.0.0）在 `c3b3a68` 上运行该 helper 命令为 40 passed / 0 failed / 0 skipped。这只是本机 helper 结果，不代表 Linux 或 Windows 上的执行。
- 方案集成时（2026-11-07）被测树相对 `c3b3a68` 已多一个产品提交 `734d98b`（界面去模板化打磨：样式、图标、标签与侧栏状态点、状态栏去掉 `●` / `◌` 前缀、连接弹窗入口改为分组列表，DOM id 不变）。协调者已只读核对：它未改上列 workflow、runner、场景或 helper 文件；场景使用的 `#tabs .tab`、`[role="tab"]`、`.tab-close`、`#terminal-state`、`#local-open`、`#local-options-open`、`#connect-open`、`#ssh-terminal-open` 等选择器均保留，状态判断只用 `includes` 匹配的「本机 shell 已启动」等子串未变。本条只是静态兼容核对，不代表这些场景已在新树上通过；若集成时又加入其他产品提交，仍按上一条逐项列出。
- 本 workflow 在 `p1/integration` 上不得有 queued 或 in_progress 的运行。若存在，等待其结束或由用户决定，不得用新 dispatch 取消它（见下文并发规则）。

## 入口、输入与并发（按 workflow 文件核实）

- `workflow_dispatch.inputs`：
  - `native_only`：boolean，默认 `false`，说明为 “Diagnostic run: only the two native WebView jobs (not the full acceptance gate)”。取 `true` 时，`gssapi` 和四个 `desktop` matrix 作业因 `if: ${{ !inputs.native_only }}` 跳过。
  - `windows_shell_repeats`：number，默认 `0`。安装和构建之前，“Validate native diagnostic inputs before installing or building” 步骤用 `parseShellRepeats` 校验它是 0–10 的整数（输入声明为 number，经环境变量传递后为字符串，函数按字符串 `^(?:[0-9]|10)$` 校验）。该值只作为 `P1_NATIVE_SHELL_REPEATS` 传给 Windows 运行步骤；Linux 步骤不传，runner 视为 0。非 Windows 平台传入大于 0 的值会被 `scenarioPlan` 拒绝。
  - `windows_webview_timing`：boolean，默认 `false`，只映射为 Windows 步骤的 `P1_NATIVE_WEBVIEW_TIMING`（`1` 或 `0`），对 Linux 无作用。
- `native-webview` 作业没有 `if`，matrix 为：
  - `ubuntu-24.04` / `x86_64-unknown-linux-gnu`，作业名 “Linux x64 — native WebKitGTK smoke (tauri-driver)”；
  - `windows-2022` / `x86_64-pc-windows-msvc`，作业名 “Windows x64 — native WebView2 smoke (tauri-driver)”。

  作业设置 `fail-fast: false`、`timeout-minutes: 40`，使用 Node 26.0.0、Rust 1.99.0 和 `--locked` 安装的 `tauri-driver` 2.0.6。Linux 把 `webkit2gtk-driver` 精确钉在与 `libwebkit2gtk-4.1-0` 相同的版本，在 Xvfb `1600x1000x24` 下运行；Windows 安装与 WebView2 Runtime 匹配的 msedgedriver。步骤顺序为：helper 单测 → 生产前端 build → `--features custom-protocol` 链接 debug 桌面程序 → 以 `dev-tools` 构建 loopback russh `ssh_terminal_fixture` → `cargo install` 固定版本 tauri-driver → Windows 安装匹配的 msedgedriver → 记录 WebView 运行时与驱动版本（`versions.log`）→ 运行 runner → `if: always()` 上传。
- 并发：`group: p0-platform-${{ github.workflow }}-${{ github.ref }}`，`cancel-in-progress: true`。同一 `refs/heads/p1/integration` 上再次 dispatch 会取消进行中的运行，因此本刷新期间不得再 dispatch 本 workflow。本 workflow 的 push 触发只针对 `main`，推送 `p1/integration` 不会触发它。各 `p1-windows-*` workflow 只在推送 `p1/integration` 且改动其列出的路径时触发，这些路径均不含 `docs/`。撰写时没有开放的 PR。
- 上传的工件为 `p0-native-webview-x86_64-unknown-linux-gnu-ubuntu-24.04-<run_attempt>` 和 `p0-native-webview-x86_64-pc-windows-msvc-windows-2022-<run_attempt>`，内容是 `$RUNNER_TEMP/p0-native/`，设置 `if-no-files-found: warn`，保留 14 天。本刷新只接受 attempt 1，两个名称都应以 `-1` 结尾。

`windows_webview_timing=true` 与 `39783803294` 的设置相同，是测试侧的有界插桩，具体作用如下：

- Windows 场景 5、6 的 summary 证据附加 `timings`（`open-to-ready`、`*-typeInTerminal`、`*-send-to-row`）。
- 场景 6 每次版本或 cwd 输入返回后，多一次页面内的 `mark('webdriver-input-return')` 调用，trace 增加 `stage` 记录。

它不改产品，也不记录终端原文，但与 push/PR 默认原生门禁不是同一配置，结果中须注明这个开关。

## 唯一 dispatch（待用户批准，尚未执行）

```sh
gh workflow run p0-cross-platform.yml --repo mofyer/new-windterm --ref p1/integration \
  -f native_only=true -f windows_shell_repeats=0 -f windows_webview_timing=true
```

dispatch 后，只读定位运行并等待结束：

```sh
gh run list --repo mofyer/new-windterm --workflow p0-cross-platform.yml --branch p1/integration \
  --event workflow_dispatch --limit 3 --json databaseId,headSha,status,createdAt
gh run watch <RUN_ID> --repo mofyer/new-windterm --exit-status
```

`<RUN_ID>` 是记录时间之后新出现、`headSha=<HEAD>` 的唯一一条运行。新运行多于一条、headSha 不符或运行被取消，本刷新都记为无效，不再 dispatch 补救。

## 两平台实际运行的 7 个场景

`SCENARIOS` 的顺序固定。repeats 为 0 时，`scenarioPlan` 只生成这 7 个条目，均为 `kind=base`、`artifactPrefix=''`。某个场景失败后，runner 仍会继续执行后续场景，最终整体失败。这是既有行为，不是重试，后续场景通过也不能抵消前面的失败。默认本地 Shell 在 Linux 上是 Bash，在 Windows 上是 `cmd.exe`。

| 序 | 场景 | 平台差异 | 通过判据（均为既有代码断言） | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `workbench` | 两平台相同 | 60 秒内页面 `complete`、至少 1 个标签，且 xterm 读屏树含 `Terminal workspace`；地址为 `tauri://localhost` 或 `http(s)://tauri.localhost`；`__TAURI_INTERNALS__.invoke` 为函数；`#runtime-note` 以“桌面原型”开头 | `01-workbench.png`；summary 中的 href、title、userAgent、windowTitle |
| 2 | `local-terminal` | Linux 默认 Bash 执行 `help help`；Windows 默认 cmd 执行 `ver` | 新标签出现，状态为“本机 shell 已启动”；`echo p0native<12 位 hex>` 后出现与标记完全相等的独立输出行；Linux 身份行以 `help: help [` 开头，Windows 匹配 `^Microsoft Windows \[Version \d+\.\d+\.\d+`；关闭后标签数恢复 | `02-local-terminal.{txt,png}` |
| 3 | `ssh-terminal` | 两平台相同，连接 loopback russh 夹具 | `ssh_probe` 显示的指纹等于夹具的 `SHA256:` 指纹；接受后状态为“SSH 已连接”，出现 `P0 SSH terminal fixture` 横幅；`size` 回复匹配 `^(?:> )?SIZE \d+ \d+$`；`unicode` 回复行含“中文”与 🌏；`exit` 后为“已退出 · code 7” | `03-ssh-terminal.{txt,png}`；`ssh-fixture.log` |
| 4 | `local-terminal-reopen` | 默认 Shell | `echo p1old…` 输出独立行；`exit 7` 后为“已退出 · code 7”；“重新打开本地终端”按钮可见且可用；重开是新增标签而非替换，新旧 DOM 标签均非空且不同，新标签被选中；`echo p1new…` 输出独立行，新会话中没有旧标记；回到旧标签仍为“已退出 · code 7”，旧输出可读且没有新标记 | `04-local-terminal-reopen.{txt,png}` |
| 5 | `local-terminal-cwd` | 默认 Shell；Windows 先执行 `chcp 65001` 再执行 `cd`，Linux 执行 `pwd -P` | 目录为 `mkdtemp(tmpdir, 'p1 中文-')` 的 `realpath`，含中文和空格，只经表单 `#local-cwd-input` 和 IPC 传入；首次打开和 `#local-reopen` 重开各查询一次，都必须出现与期望完全相等的整行（Windows 按 `win32.normalize` 后不区分大小写比较，Linux 严格相等）；两次 `exit 7` 都显示“已退出 · code 7”；不安装 trace | `05-local-terminal-cwd.{txt,png}`；Windows 另有 `timings` |
| 6 | `local-terminal-shell` | 显式 Shell：Linux 为 `bash`，Windows 为 `powershell`（Windows PowerShell 5.1） | cwd 与场景 5 同类；PowerShell 先将 `[Console]::OutputEncoding` 设为 UTF-8；版本行在 PowerShell 上匹配 `^P1_SHELL=\d+\.\d+\.\d+(?:\.\d+)?$`，在 Bash 上匹配 `^P1_SHELL=\d+\.\d+\.\d+(?:\(\d+\))?(?:-release)?$`；目录查询为普通 `(Get-Location).Path`（PowerShell）或 `pwd -P`（Bash），首次与重开的结果都必须精确等于期望；两次版本相同；两次 `exit 7`；功能断言成功后，trace 不得为 `incomplete` 或 `truncated` | `06-local-terminal-shell.{txt,png}`、`06-local-terminal-shell-trace.json`；Windows 另有 `timings` 与 stage 记录 |
| 7 | `local-terminal-environment` | 显式 Shell 同场景 6；默认会话核对在 Linux 用 Bash，在 Windows 用 cmd | 打开两个配置会话：`P1_ENV_SAMPLE` 分别为 `中文 space=one` 和 `独立 space=two`，`P1_ENV_EMPTY` 为空值，locale 为 `custom` 且 `LANG=C.UTF-8`。`initial`、`independent`、`retained`、`modified`（交互改为 `runtime-change`）、`reopened` 五个阶段各读回 10 个 `P1_<phase>_<字段>=[值]` 精确行；`exit 7` 后重开恢复 `中文 space=one`；第二会话仍输出 `P1_SECOND_STILL=[独立 space=two]`。新开默认会话：Linux 没有两个测试变量，`LANG` 和 `LC_ALL` 为 `C.UTF-8`，没有 `LC_CTYPE`；Windows cmd 对五个名称的 `if defined` 均为 absent，`set P1_ENV_` 扫描没有合成条目。结束时标签数恢复到场景开始前 | `07-local-terminal-environment.{json,png}` |

**时间门限**（runner 既有值，本刷新不改）：

| 等待对象 | 门限 |
| --- | --- |
| tauri-driver 与原生驱动就绪 | 30 秒 |
| SSH 夹具横幅 | 30 秒 |
| WebDriver `script` / `pageLoad` | 30 秒 / 60 秒 |
| `workbench` 页面渲染 | 60 秒 |
| 会话状态（出现“错误”即提前失败） | 30 秒 |
| 终端输出行 | 30 秒 |
| SSH 主机密钥 challenge | 30 秒 |
| 标签数、对话框、按钮、关闭等其他 `waitFor` | 默认 20 秒 |
| 夹具停止 / 进程停止宽限 | 15 秒 / 5 秒 |
| 整个作业 | 40 分钟 |

输出行等待的 30 秒从输入调用返回后开始计时（timing 开启时还包括 mark 调用）；`*-send-to-row` 则从输入之前计到行出现。因此该值略高于 30,000 ms 时场景仍可能通过，例如 `39764709186` 曾记录 30,204.8 ms。是否通过只看场景状态，不根据计时值改判。

**trace 门禁**：场景 6 在 Linux 和 Windows 都安装 `installTerminalTrace`，Linux 不开 stage。trace 只追踪两次 `pty_open`，且须与固定的 shell、cwd、空 env、默认 locale 匹配，容量上限 256 KiB。`stop()` 时，任一槽缺数据或缺 fulfilled 的 `pty_open`、槽数不是两个，或出现 callback/fetch 异常等原因，都会置 `incomplete`；有记录被丢弃则置 `truncated`。功能断言成功后，只要 trace 为 incomplete 或 truncated，场景即失败。不扩大容量，也不忽略任何原因。

**独立 stderr**：native runner 不单独采集 PowerShell stderr。终端输出经 ConPTY 和 xterm 合流，`tauri-driver.log` 合并了驱动的 stdout 与 stderr。本刷新不提供独立 stderr 证据，也不替代或放宽诊断 workflow 中“未知 stderr 严格判失败”的门禁。

## 预先声明的判据

通过须同时满足以下四条：

1. 运行绑定：`event=workflow_dispatch`、`headBranch=p1/integration`、`headSha=<HEAD>`、`attempt=1`、`conclusion=success`；两个 native 作业为 success，`gssapi` 与 desktop matrix 为 skipped。
2. 两平台的 `summary.json`：`result=passed`，没有顶层 `error`；`platform/arch` 分别为 `linux/x64` 和 `win32/x64`；`shellRepeats=0`；`counts.base` 为 planned 7 / attempted 7 / passed 7 / failed 0 / skipped 0，`counts.diagnostic` 为 planned 0 / attempted 0；`scenarios` 恰为上表的 7 个名称且顺序一致。
3. 两平台的 `06-local-terminal-shell-trace.json`：`schema=1`、`limitBytes=262144`、`incomplete=false`、`truncated=false`、`droppedRecords=0`、`incompleteReasons=[]`。
4. 两平台 helper 单测步骤均为 0 failed。通过数和跳过数按日志原样记录，跳过的测试不计为通过。

以下任一情况都不算通过：SSH 场景 skipped、任一场景 failed、fatal、作业失败、超时或取消、工件缺失、绑定不符。失败按三类记录：前置步骤失败（未进入场景）、场景失败、无效（取消、绑定不符、多余运行、工件缺失或核验失败）。分类只用于记录，三类都不允许重跑。

`driverExit`、`fixtureExit.report`（历史记录为 `active=0`）、各场景的 `remainingTabs` 与 `versions.log` 原样记录。出现异常值时须报告，并且不能再写“清理正常”，但不改写上述通过或失败的结论。

## 停止规则

- 只 dispatch 一次，只采用 attempt 1。第一次失败（含无效）即停止本刷新：不执行 `gh run rerun`（含 `--failed`），不再次 dispatch，不把 `windows_shell_repeats` 改成非 0 来追加样本，不循环补跑，也不用后来的成功覆盖或抵消这次失败。
- 不放宽任何时间门限、trace 容量、断言或 stderr 门禁。不改用模块限定查询，不预先执行 `Import-Module`，不合并命令，不修改产品八项白名单。结果记录完成之前，不改产品或测试代码。
- 两平台作业相互独立（`fail-fast: false`）。一方失败时，另一方结果仍原样记录，整体按失败计。
- 运行中不主动取消。若因并发或外部原因被取消，记为无效，不自动重新 dispatch。
- 任何后续运行都需要用户新的决定，并须先修订本方案或另行预注册。新运行单独记录，不与本次运行拼接。

## 允许与禁止的解读

**通过时允许写**：精确 `<HEAD>`（含 `85ce71b`/`b3716ad` 的当前产品树）在本次 GitHub runner 的 Linux WebKitGTK 与 Windows Server 2022 WebView2 上，既有 7 个原生场景各一次通过，覆盖默认和显式 Shell、首次与重开、中文空格 cwd、普通查询、环境/locale 及完整 trace。Windows 计时作为单次描述，可以与 `39783803294` 并列展示。

**通过时禁止写**：

- Windows 目录查询慢路径已修复、根因已定，或 `39063630062` 的失败已关闭；
- 第四批已验收、P1 已通过或可以合并 main。本入口跳过五个非 native 作业，不是七作业全套门禁；
- Windows Server 2025、macOS WKWebView、PowerShell 7、IME、读屏、高输出性能、签名公证或真实用户桌面已验收；
- loopback russh 夹具等同于 OpenSSH；
- 与 `39783803294` 的计时差是产品改动的效果或“改善”。两次运行的 SHA 不同，`windows_shell_repeats` 为 3 与 0，runner 镜像和运行时间也不同，不构成配对控制；
- 显式导入等候选产品方案已获支持。

**失败时**须原样记录失败场景、阶段（如 `initial cwd query`）、错误文本和 failure 工件。不得据此归因于 Enter 丢失、WebDriver、IPC、ConPTY、PowerShell 初始化、早期输入门控或 runner 负载，不得称为偶发或 flaky，也不得用历史成功抵消。Windows 场景 6 若在 30 秒行等待中超时，只能记为与 `39063630062` 同类的现象，不能据此确定根因。

## 参照：历史运行 `39783803294`

以下数值引自执行记录。该运行的被测提交为 `263658e`，参数为 `native_only=true`、`windows_shell_repeats=3`、`windows_webview_timing=true`；Linux 与 Windows 的 native 作业均为 success。执行记录写作“10/10 场景通过”；按 runner 逻辑，重复只作用于 Windows，即 Windows 7 个基础场景加 3 次 Shell 诊断。

- Windows 8 个首次/重开 PowerShell 样本：`cwd-typeInTerminal` 63.1–70.3 ms，`cwd-send-to-row` 21,596.8–27,648.6 ms，`open→ready` 约 110.9–132.6 ms。
- 按 run 元数据，Linux 作业为 13:05:27–13:12:40 UTC，Windows 作业为 13:05:26–13:16:19 UTC（2026-10-22）。

本刷新 repeats 为 0，Windows 只有场景 6 的两个 PowerShell 样本和场景 5 的两个 cmd 样本，不能与上述 8 个样本合并统计。另有已知失败：`39063630062`（`eb76e4b`）的 Windows 场景 6 在首次 cwd 查询时 30 秒超时。因此，本刷新因 30 秒门限失败是预先可以预见的结果之一；若发生，按失败记录，不改门限。

## 工件独立核验与记录

由 dispatch 执行者以外的独立核验者完成以下步骤，结果写入[执行记录](RESULTS.zh-CN.md)新的小节“当前产品树有限原生验收刷新（工作流 `<RUN_ID>`）”：

1. **run/SHA 绑定**：执行 `gh run view <RUN_ID> --repo mofyer/new-windterm --json headSha,headBranch,event,status,conclusion,attempt,jobs,createdAt,updatedAt`，并用 `gh run list --repo mofyer/new-windterm --commit <HEAD> --json databaseId,workflowName,event,status,conclusion` 列出同一 SHA 的全部运行。本 workflow 在该 SHA 下应只有这一条 dispatch；其他 workflow 的运行单独列出，不并入本刷新。
2. **下载与 SHA-256**：用 `gh api repos/mofyer/new-windterm/actions/runs/<RUN_ID>/artifacts` 记录两个工件的 id、name、size_in_bytes 和 digest。逐个执行 `gh api repos/mofyer/new-windterm/actions/artifacts/<ARTIFACT_ID>/zip > <新空目录>/<name>.zip`，API 返回的 `digest` 形如 `sha256:<64 位十六进制>`，去掉 `sha256:` 前缀后，须与 `shasum -a 256` 输出的前 64 位十六进制完全一致（统一按小写比较）；不一致即为核验失败，不自行改判。随后解压到各自的新空目录 `.artifacts/p1/native-refresh/<RUN_ID>/<name>/`。工件按不可信数据处理，核验脚本放在其他目录，只通过路径参数读取。须在 14 天保留期内完成。
3. **固定字段**：按判据 1–4 逐项核对 summary 与 trace，并核对以下场景证据：
   - `workbench.href`；
   - 本地 Shell 身份行；
   - SSH 指纹与 `ssh-fixture.log` 横幅一致；
   - 重开前后的标签；
   - `expected` 含 `p1 中文-`，且首次与重开的 cwd 与之匹配；
   - 场景 6 的两次 `identities` 相同，并记录实际版本（历史为 `P1_SHELL=5.1.20348.5622`）；
   - 场景 7 各 phase 的输出行与 `remainingTabs`；
   - `versions.log` 中的 tauri-driver、WebKitGTK 与驱动，或 msedgedriver 与 WebView2 版本；
   - 作业日志中的 helper 计数与 `result: passed` 行。
4. **文件哈希**：记录两个 zip，以及每个平台的 `summary.json`、`06-local-terminal-shell-trace.json`、`07-local-terminal-environment.json` 的 SHA-256；若有 failure JSON，一并记录。
5. **记录内容**：被测 `<HEAD>` 及其相对 `c3b3a68` 的产品差异、`<RUN_ID>`、三项输入、两作业结论与时长、7 个场景的状态与耗时、Windows `timings` 原值、trace 字段、清理附记、核验者与核验结论。工件不提交进仓库。Linux runner 缺少 CJK 字体时截图会出现方块，截图不作为字形验收。

## 需要用户批准的事项

以下各项都是对外操作或范围决定。本方案的本地提交不代表其中任何一项已获批准：

1. 将协调者集成后的 `p1/integration`（含本预注册）推送到远端。
2. 执行上文唯一的 dispatch 命令。
3. 失败或无效后，是否另行运行、修改参数或预注册新实验。
4. 根据结果，是否评估并实施单个产品方案。显式导入仍只是候选，不会静默加入产品。
5. 第四批合并 main：须在完成验收后单独批准。

P1 与第四批均未验收，P2 仅在准备，main 不合并。
