# P0 跨平台编译与协议/PTY 验证

日期：2026-10-11。最终目标仍是三平台完整功能一致；交付顺序保持 macOS Apple Silicon 优先，Windows/Linux 后续。本文区分代码适配、编译、真实 PTY 和 GUI 验收，不能以 CI 绿色代替整个平台可用。

## Windows ConPTY 生命周期（工作分支，第六次尝试通过）

工作分支 `p0/windows-conpty` 的 [run 38134532830](https://github.com/mofyer/new-windterm/actions/runs/38134532830) **success**：Windows x64 Rust 48 passed / 2 ignored（含 10 项 ConPTY 生命周期测试），SSH target 10/10；macOS arm64 41 passed，Linux x64 40 passed，均 2 ignored，默认与 readiness PTY 探针通过。此前 run 38130718974（已取消）、38131377983、38132281341、38132935391、38133799928 失败，原因与修复见 [RESULTS](RESULTS.zh-CN.md) 的 Windows 一节。Windows 上的 Unix `pty_probe` 仍跳过，ConPTY 验证在 Rust 测试步骤中完成。

## 上一提交：只读 SFTP IPC 与 Windows shell 契约（第六次 CI 通过）

提交 `32163390df223beb7cb367b8deb7c53dec800c58` 的 [run 38126837364](https://github.com/mofyer/new-windterm/actions/runs/38126837364) **success**。本轮把 `russh-sftp 3.0.1` 只读 Rust wrapper 接入 Tauri IPC，并为未来 Windows ConPTY 适配保留经过 `ComSpec` 校验的 `cmd.exe /D /Q /K` 命令契约；Windows gate 仍保持拒绝，未执行真实 ConPTY 探针。

| 实际 host / job | Rust unit / SSH target | 前端 / fmt / check / test / clippy / link | 默认 / readiness PTY |
| --- | ---: | --- | --- |
| [aarch64-apple-darwin](https://github.com/mofyer/new-windterm/actions/runs/38126837364/job/114432851070) | 30/0/1；10/10 | 全部 success | success / success |
| [x86_64-unknown-linux-gnu](https://github.com/mofyer/new-windterm/actions/runs/38126837364/job/114432850901) | 29/0/1；10/10 | 全部 success | success / success |
| [x86_64-pc-windows-msvc](https://github.com/mofyer/new-windterm/actions/runs/38126837364/job/114432851220) | 28/0/1；10/10 | 全部 success | skipped / skipped |

Windows all-targets、unit、Clippy 与链接均通过，真实 PTY 两项按策略跳过；这不证明 ConPTY 同步 reader 的取消、回收或完整 shell 行为。macOS/Linux Unix PTY 继续通过 2 MiB 完整性与 readiness 检查。SFTP IPC 已完成三端编译接线，但尚未进行 OpenSSH SFTP 网络验收、前端面板验收或大目录内存峰值验收。

## 历史当前轮：Windows 取消钩子预备代码（第四次 CI 通过）

提交 `9dbf8acb8cd14f3590087f7fbdd218255acaa8a1` 的 [run 38116705227](https://github.com/mofyer/new-windterm/actions/runs/38116705227) **success**：三端前端资源、fmt/check/test/clippy 和桌面链接均通过；macOS/Linux 默认与 readiness PTY 通过，Windows 两项真实 PTY 继续 skipped。Windows-only `ChildKiller` 仅作为未来 ConPTY 取消生命周期的预备钩子，Windows 平台拒绝策略没有解除。

| 实际 host / job | 单元 passed / failed / ignored | SSH target | 前端 / fmt / check / test / clippy / link | 默认 / readiness PTY |
| --- | ---: | ---: | --- | --- |
| [aarch64-apple-darwin](https://github.com/mofyer/new-windterm/actions/runs/38116705227/job/114402901901) | 28 / 0 / 1 | 10/10 | 全部 success | success / success |
| [x86_64-unknown-linux-gnu](https://github.com/mofyer/new-windterm/actions/runs/38116705227/job/114402901871) | 27 / 0 / 1 | 10/10 | 全部 success | success / success |
| [x86_64-pc-windows-msvc](https://github.com/mofyer/new-windterm/actions/runs/38116705227/job/114402901784) | 25 / 0 / 1 | 10/10 | 全部 success | skipped / skipped |

本次回执只证明 Windows 条件编译和现有拒绝策略保持健康；没有证明同步 ConPTY reader 可在关闭后收敛、子进程树可完整回收或 Windows 真实终端可用。下一步仍需按[ConPTY 决策记录](WINDOWS_CONPTY_ADR.zh-CN.md)增加 Windows idle close、reader join 和进程树验收。

## 历史当前轮：交互 SSH 与 readiness（第三次 CI 通过）

当前提交 `8ee49a49a970fbb364c6b2ca463cd4e10fdd1acf` 的第三次 [run 38113572772](https://github.com/mofyer/new-windterm/actions/runs/38113572772) **success**：三端前端资源、fmt/check/test/clippy 和桌面链接均通过，Mac/Linux 默认与 readiness PTY 均通过，Windows 两项 PTY 明确跳过。Windows 最小修订已独立审查通过；前两次 failure 及各自部分通过结果继续保留于下文。

最初 `807e0eb` 的本机 macOS 独立复验为 28 项单元 passed、1 explicit ignored，9 项真实 SSH 集成 passed，fmt/check/clippy 和独立审查通过；同提交首轮 hosted CI 三端标记等待超时，证明本机结果不能外推。该失败和后续修订回执均保留于下文。

本次运行范围及其边界：

- 三端 `cargo test --all-targets --all-features`：包含单元、平台策略和真实 loopback SSH 协议集成测试；之前的 `--lib` 不覆盖新增集成测试。
- macOS/Linux 分别运行默认 `pty_probe` 和显式 `--features pty-readiness` 探针；Windows 两项真实 PTY 均跳过，分配前拒绝策略保留。
- 默认桌面链接只启用 `custom-protocol`，不默认打开 readiness。SSH 协议夹具采用有限命令 russh 服务端，不启动系统 shell；不代表 OpenSSH 互操作或桌面 GUI 验收。
- 本机 readiness 三组配对属于 macOS CLI 诊断，不外推 Linux 性能或三端 GUI。[实验报告](PTY_READINESS.zh-CN.md) · [当前结果](RESULTS.zh-CN.md)

### 最终成功回执（`8ee49a4`）

| 实际 host / job | 单元 passed / failed / ignored | SSH target | 前端 / fmt / check / test / clippy / link | 默认 / readiness PTY |
| --- | --- | --- | --- | --- |
| [aarch64-apple-darwin](https://github.com/mofyer/new-windterm/actions/runs/38113572772/job/114393915952) | 28 / 0 / 1 | 10/10，20.88 s | 全部 success | success / success |
| [x86_64-unknown-linux-gnu](https://github.com/mofyer/new-windterm/actions/runs/38113572772/job/114393916119) | 27 / 0 / 1 | 10/10，22.96 s | 全部 success | success / success |
| [x86_64-pc-windows-msvc](https://github.com/mofyer/new-windterm/actions/runs/38113572772/job/114393916089) | 25 / 0 / 1 | 10/10，25.44 s | 全部 success | skipped / skipped |

每端 SSH target 的 10 项为 **9 项真实 loopback 协议 + 1 项扫描 helper**；三端 ignored 仍为依赖系统 OpenSSH 夹具的 `real_fixture_reconnect_mismatch`，并未在 CI 运行。此前本机单独激活该项的证据归属 `807e0eb`，不冒充三端 OpenSSH 验收。Windows test/link 日志仍有非阻塞 Cargo PDB 同名 warning，不称所有构建零 warning。

| Unix 2 MiB 功能探针 | 完整性阶段耗时 | 观察速度 | 未 ACK 字节峰值 |
| --- | ---: | ---: | ---: |
| macOS 默认 | 32.39 s | 63.2 KiB/s | 18,599 B |
| macOS readiness | 0.48 s | 4,294.1 KiB/s | 8,306 B |
| Linux 默认 | 0.55 s | 3,730.5 KiB/s | 65,535 B |
| Linux readiness | 0.39 s | 5,217.3 KiB/s | 65,521 B |

四个探针分别通过精确 **2,097,152 B**、300 ms 人工 ACK 暂停、预算、尺寸、UTF-8、Ctrl-C、退出码及各 12 次关闭/worker 回收。它们是单次 hosted 功能检查，不是交替配对 benchmark，不能据此宣布默认应用或 GUI 性能达标；`pty-readiness` 默认关闭保持不变。

运行 metadata、完整日志与 artifacts 位于本地忽略目录 `.artifacts/p0/ssh-terminal-round/ci-38113572772/`，公共 job 链接见表。该 CI 没有执行 GUI、IME、原生高输出性能、交互 OpenSSH、SFTP、签名或安装包验收，也不证明 Windows ConPTY 或完整 WindTerm 功能对齐。

### 首轮失败回执与测试扫描修订

运行 [38112425584](https://github.com/mofyer/new-windterm/actions/runs/38112425584)，被测 commit `807e0ebf7178fc112c1a84b5dcb3ac1951944ed3`，2026-10-11，三端均 **failure**。

| 实际 host | 单元测试 passed / failed / ignored | 真实 SSH 集成 passed / failed | 失败样本 |
| --- | --- | --- | --- |
| aarch64-apple-darwin | 28 / 0 / 1 | 8 / 1 | `bounded_two_mib_output_recovers_after_ack_pause_and_interrupts` |
| x86_64-unknown-linux-gnu | 27 / 0 / 1 | 7 / 2 | `bounded_two_mib_output_recovers_after_ack_pause_and_interrupts`、`burst_with_prompt_ack_is_not_false_overload` |
| x86_64-pc-windows-msvc | 25 / 0 / 1 | 7 / 2 | `bounded_two_mib_output_recovers_after_ack_pause_and_interrupts`、`burst_with_prompt_ack_is_not_false_overload` |

失败均位于该提交 `tests/ssh_terminal.rs:74` 的 `until` 标记等待，触发既有 10 秒期限。后续 clippy、桌面链接及两种 PTY 探针均 skipped，不能算通过。Windows 日志仍出现非阻塞 PDB 同名 warning。原始运行材料位于本地忽略目录 `.artifacts/p0/ssh-terminal-round/ci-38112425584/`；上方公共运行页保留对应 job 日志。

排查发现测试消费者每收到一块就从头扫描累计历史，形成 O(n²) 比较。修订仅改测试 scanner：检查新字节及可能跨块的必要重叠；保留生产代码、数据完整性断言和 10 秒期限，并新增 helper 边界回归。修订后该集成测试 target 共 10 项（9 项真实协议 + 1 项扫描 helper）；作者本机执行 20.27 秒通过；独立 Rust 审查 APPROVE，target **10/10，20.34 秒**，fmt、target check 与 clippy 通过。修订仅涉及测试，生产源码及此前原生/前端证据未变；其 hosted 回执见下面第二次运行。

同机有限 debug 比较使用相同 2,097,168 B 输入：旧扫描 540,012,035 次比较、3580.016 ms，增量扫描 2,097,155 次比较、13.870 ms。原始数据在 `.artifacts/p0/ssh-terminal-round/marker-scan/results.txt`。这证明该测试扫描器在所测输入下避免重复工作，不能只凭单次本机比较认定所有 hosted 失败原因或宣布三平台已修复。后续运行须单独记录，不覆盖本次失败。

### 第二次运行：SSH 全通过，Windows Clippy 失败

运行 [38112943897](https://github.com/mofyer/new-windterm/actions/runs/38112943897)，被测 commit `ff664ac819d5962bf91825fd889fb483d7d5fc9e`，整体 **failure**。三端 SSH target 的 10 项为 **9 项真实协议 + 1 项扫描 helper**，不能称为 10 项真实协议。

| 实际 host | 单元 passed / failed / ignored | SSH target | clippy / 桌面链接 | 默认 / readiness PTY | job |
| --- | --- | --- | --- | --- | --- |
| aarch64-apple-darwin | 28 / 0 / 1 | 10/10，21.38 s | success / success | success / success | success |
| x86_64-unknown-linux-gnu | 27 / 0 / 1 | 10/10，22.71 s | success / success | success / success | success |
| x86_64-pc-windows-msvc | 25 / 0 / 1 | 10/10，25.21 s | failure / skipped | skipped / skipped | failure |

Windows Clippy 的两项错误为该提交 `pty.rs:516` 的 `drop_non_drop`（非 Unix 占位类型）与 `platform.rs:102` 的 `items_after_test_module`（非 Unix 定义位于测试模块之后）。后续修订范围限于条件编译与条目位置，独立审查已通过；第三次 CI 修订成功见文首，不改写本次失败。Windows ConPTY 仍未实现，真实 PTY 本来就不在该平台执行。

| Unix 2 MiB 功能探针 | 完整性阶段耗时 | 观察速度 | 未 ACK 字节峰值 |
| --- | ---: | ---: | ---: |
| macOS 默认 | 43.02 s | 47.6 KiB/s | 13,479 B |
| macOS readiness | 0.56 s | 3,650.3 KiB/s | 19,483 B |
| Linux 默认 | 0.49 s | 4,184.3 KiB/s | 65,533 B |
| Linux readiness | 0.36 s | 5,621.7 KiB/s | 65,535 B |

四个探针均精确接收 2,097,152 B，并分别完成 12 次关闭/worker 回收。全部包含 300 ms 人工 ACK 暂停，未 ACK 峰值不超过 65,536 B。这是 hosted 功能检查，不是交替配对 benchmark；不能据单次耗时宣称 GUI 加速或平台性能达标。此运行支持增量 scanner 在三端的协议回归与两种 Unix PTY 的完整性，但 Windows Clippy 未通过、链接未执行；也不覆盖 GUI/IME、交互 OpenSSH 或应用 SFTP。

### Windows 最小修订与第三次运行

提交 `8ee49a49a970fbb364c6b2ca463cd4e10fdd1acf`：`pty.rs` 将显式 `drop` 限于 Unix；`platform.rs` 将平台定义移动至测试模块之前。测试模块 2680 B 字节完全相同，没有删改测试或放宽 lint。Unix 描述符释放顺序、Windows 创建 PTY 前拒绝策略、默认功能与 SSH 语义保持。

修复作者本机全量检查通过：28 项 unit passed、1 explicit ignored，集成 target 10/10（9 协议 + 1 helper），fmt/check/clippy 通过。独立审查 **APPROVE**，另执行 fmt/check/clippy 与定向 platform 测试 **5/5** 通过。这是本机及代码审查证据；Windows hosted 编译与 Clippy 另由文首第三次 [run 38113572772](https://github.com/mofyer/new-windterm/actions/runs/38113572772) 成功回执确认。

本修订未改变本机默认编译的运行语义，保留先前明确版本的原生/浏览器证据，没有把它们重新标为该提交的原生重测。

## 前一轮历史：SSH 固定命令与 PTY 诊断（2026-10-11）

运行 [38110885626](https://github.com/mofyer/new-windterm/actions/runs/38110885626)，被测 commit `84c24df697a6ee0858f4654368e35ec146746174`，整体 **success**。三端前端构建、Rust fmt/check/test/clippy 与桌面可执行文件链接成功；check/clippy 使用 `--all-targets --all-features`，test 使用 `--lib --all-features`，clippy 保留 `-D warnings`。默认桌面构建与真实 PTY 探针未启用诊断计时。

| 实际 host / job | Rust 单测 | 真实 PTY | job outcome |
| --- | --- | --- | --- |
| [aarch64-apple-darwin](https://github.com/mofyer/new-windterm/actions/runs/38110885626/job/114386025521) | 24 passed、0 failed、1 ignored | 2 MiB 完整性、尺寸、UTF-8、归属、Ctrl-C、exit 7、12 轮关闭与 worker 回收通过 | success |
| [x86_64-unknown-linux-gnu](https://github.com/mofyer/new-windterm/actions/runs/38110885626/job/114386025712) | 23 passed、0 failed、1 ignored | 同一生产 PTY 探针通过 | success |
| [x86_64-pc-windows-msvc](https://github.com/mofyer/new-windterm/actions/runs/38110885626/job/114386025694) | 23 passed、0 failed、1 ignored | skipped；ConPTY 仍未实现 | success |

三端 ignored 均为需要受控 OpenSSH 对端的 `real_fixture_reconnect_mismatch`。CI 未运行该真实 SSH 夹具，也未进行 GUI、SSH/SFTP 实际连接或输入法验收。本机 macOS 的 Node harness 2/2 与原生 SSH 成功路径另见 [SSH_CLIENT](SSH_CLIENT.zh-CN.md)，不能外推为三平台真实 SSH 已通过。

| Unix 2 MiB 功能探针 | 完整性阶段耗时 | 观察速度 | 未确认字节峰值 |
| --- | ---: | ---: | ---: |
| macOS arm64 | 32.71 s | 62.6 KiB/s | 21,671 B |
| Linux x64 | 0.56 s | 3,626.2 KiB/s | 64,511 B |

两端均精确接收 2,097,152 字节，包含 300 ms 人工 ACK 暂停，峰值低于 65,536 B 预算；均完成 12 轮关闭与回收。这是不同 hosted runner 的单次功能检查，不是公平吞吐比较或性能达标结论，不以本轮与旧轮的耗时差宣称优化。

Windows 桌面链接成功，但记录了非阻塞的 `output filename collision` warning：同名 bin/lib 的调试符号文件均为 `new_windterm_desktop.pdb`。这不是 clippy 失败，也不应描述为所有构建零 warning；后续需单独处理符号产物命名。

原始 run 元数据、完整日志与三端 artifacts 已归档至本地忽略目录 `.artifacts/p0/ci/38110885626/`，公共日志入口为上方 run/job 链接。下方第二轮旧失败、取消与修订成功回执全部保留，只覆盖各自提交。P0、Windows 真实终端、三端 GUI 与完整 WindTerm 功能对齐仍未完成。

## 第二轮历史状态（`a82770d`）

| 平台 | 当前适配 | 已取得证据 | 尚缺证据 |
| --- | --- | --- | --- |
| macOS arm64 | zsh + Unix PTY，可取消读写、ACK 背压及回收 | 本机 macOS 27.0.1 与 hosted 前端/检查/12 单测/链接及真实 PTY 探针通过；首次探针期限失败与修订回执均保留 | hosted 2 MiB 用时 35.51 秒，仅完整性通过；吞吐性能、签名、公证及完整功能验收未完成 |
| Linux x64 | Bash + Unix PTY，复用已有有界传输和取消逻辑 | Ubuntu 24.04 hosted 前端/检查/11 单测/链接及真实 PTY 探针通过 | GUI/WebKit/IME 未测；其他发行版及完整功能未验收 |
| Windows x64 | 保留明确的未实现平台检查；创建 PTY 之前拒绝 | Windows Server 2022 hosted 前端/检查/11 单测/链接通过，包含平台拒绝策略 | ConPTY 可取消 I/O、进程树清理及真实终端尚未实现；GUI 未验收 |

Linux 证据仅覆盖本次 Ubuntu runner 的生产 PTY 层，不表示所有发行版兼容或桌面 GUI 验收。Windows 的绿色编译任务不能解释为 Windows 终端已支持。

## 平台边界

`apps/desktop/src-tauri/src/platform.rs` 负责 shell、参数、环境、起始目录、Unix 非阻塞设置与 EOF 语义；会话归属、窗口代次、ACK 和预算仍由共享 `pty.rs` 实现。

- macOS 保持 `/bin/zsh -f -i`，隔离用户 zsh 配置与历史。
- Linux 先检查 `/bin/bash` 是存在的普通文件，再构造 `--noprofile --norc -i`；没有 Bash 时在创建 PTY 前明确失败，不静默更换 shell。实际执行权限失败仍由进程创建 API 报告。
- Linux 清空继承环境，再设置受限 PATH、TERM、`LANG/LC_ALL=C.UTF-8`、Bash 的 `PS1` 和禁用历史文件；只保留 HOME。使用系统临时目录作为初始目录。不携带 macOS 的 `LC_CTYPE=UTF-8`、ZDOTDIR 或 PROMPT，也不继承 SSH agent、BASH_ENV、ENV、LD_PRELOAD。
- 本轮 Linux 验证目标是 Ubuntu 24.04/glibc；其他发行版是否具有 Bash/C.UTF-8、对应桌面系统库仍需单独验收。
- macOS/Linux 使用同一 Unix 描述符非阻塞策略和已有取消循环。Windows 没有以跳过 `fcntl` 的方式接入；需要明确处理 ConPTY 阻塞管道的取消、句柄释放和进程树，再解除平台检查。
- Unix EIO 的 EOF 约定只在 Unix 编译；Windows 原生错误 5 不当作 EOF。`libc` 为 Unix target 的直接依赖。

## CI 执行内容

工作流：`.github/workflows/p0-cross-platform.yml`。公开仓库 Actions 已启用。当前轮状态见文首；下方历史回执只覆盖各自提交，运行中步骤不能计为通过。

| Runner | 预期 Rust host | 真实 PTY |
| --- | --- | --- |
| `macos-15` | `aarch64-apple-darwin` | 执行 |
| `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | 执行 |
| `windows-2022` | `x86_64-pc-windows-msvc` | 明确跳过；另运行平台拒绝策略与 loopback SSH 协议测试 |

每个任务记录实际 Node/Rust/OS/架构并校验 host；固定 Rust 1.99.0、Node 26.0.0，使用 npm/Cargo 锁文件。顺序执行前端资源构建、Rust format/check/all-targets tests/clippy、含本地资源的桌面可执行文件链接。Unix 任务分别执行默认与 readiness `pty_probe`：尺寸、Unicode 字节、2 MiB 完整输出、背压、Ctrl-C、退出码、越权拒绝及 12 轮关闭回收。

Ubuntu 通过 Tauri 官方清单安装 `libwebkit2gtk-4.1-dev`、编译工具、`libxdo-dev`、`libssl-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等。探针直接调用生产 PTY 层，不启动 GTK 窗口；不需要伪造 GUI 成功，也不通过 xvfb 掩盖显示环境问题。

工作流权限仅 `contents: read`，checkout 不持久保存凭据；不使用发布密钥、不上传安装包、不签名、不发布 Release。Actions 使用官方仓库已核验的完整 commit SHA。各平台日志作为单独 artifact 保存 14 天，job summary 分别记录各检查的实际 outcome，失败或跳过不能计作通过。没有启用 larger/付费 runner。

## 本地复现

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin pty_probe
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features pty-readiness --bin pty_probe
```

各平台条件编译会使测试数量不同；当前代码的实际计数见文首 `8ee49a4` 成功回执，不沿用历史 12 项。平台专属测试只有在对应 runner 实际运行后才有该平台证据。

## 回执补录要求

运行：[38107971793](https://github.com/mofyer/new-windterm/actions/runs/38107971793)，被测 commit `f6b04b706a9921be90dece7fd7f6a7005309e9cd`，2026-10-11，整体 **failure**。前次运行 `38107796175` 被更新提交自动取消，不能计为通过或失败。

| 实际 host / job | 前端、fmt、check、clippy、桌面链接 | 单测 | 真实 PTY | job outcome |
| --- | --- | --- | --- | --- |
| [aarch64-apple-darwin](https://github.com/mofyer/new-windterm/actions/runs/38107971793/job/114377456049) | 全部通过 | 12 通过 | 2 MiB 负载未在旧 10 秒总期限内结束 | failure |
| [x86_64-unknown-linux-gnu](https://github.com/mofyer/new-windterm/actions/runs/38107971793/job/114377456123) | 全部通过 | 11 通过 | 完整性、Ctrl-C、退出码和 12 轮关闭回收通过；峰值 65,531 B | success |
| [x86_64-pc-windows-msvc](https://github.com/mofyer/new-windterm/actions/runs/38107971793/job/114377456159) | 全部通过 | 11 通过，含 `pending_adapter_rejects_session_before_allocating_a_pty` | skipped；适配器仍未实现 | success |

Mac 原始失败：`FAIL PTY probe: Probe output timed out waiting for "END_LOAD"; received 691618 bytes`。数据持续到达后触发探针的统一 10 秒总期限；日志没有显示 2 秒无输出或生产 ACK 超时。后续仅将 2 MiB 完整性负载改为独立、有界的 60 秒期限，普通标记 10 秒、无进展 2 秒、生产 ACK 15 秒、8 MiB 探针输出上限以及 2,097,152 字节完整性断言均保留。负载耗时和 KiB/s 仅作诊断，不代表吞吐性能验收。修订后的 hosted 回执见下。

Linux 原始成功输出：

```text
P0 real PTY probe: OS=linux ARCH=x86_64
PASS real PTY: ownership, resize 132x43, UTF-8 bytes, 2 MiB exact output, Ctrl-C, exit 7, idempotent close; peak unacknowledged=65531 bytes
PASS 12 real PTY open/write/close cycles with withheld ACKs and worker reaping
```

原始 job 日志、run 元数据及三端上传的检查日志已归档于本地 `.artifacts/p0/ci/38107971793/`；公共 Actions 运行页可查对应 job 与 14 天日志 artifact。本次失败保留，不被后续成功覆盖。

### 修订后回执

验证运行：[38108375014](https://github.com/mofyer/new-windterm/actions/runs/38108375014)，被测 commit `a82770db2dc5fc4ccc04ba3865ef18ff6168c614`，2026-10-11，整体 **success**。三端实际 host 与预期一致；每端前端资源构建、Rust fmt/check/clippy、桌面可执行文件链接均成功。

| 实际 host / job | 单测 | 真实 PTY | job outcome |
| --- | --- | --- | --- |
| [aarch64-apple-darwin](https://github.com/mofyer/new-windterm/actions/runs/38108375014/job/114378599131) | 12 通过 | 2 MiB 完整性、尺寸、UTF-8、归属、Ctrl-C、退出码、12 轮关闭回收通过 | success |
| [x86_64-unknown-linux-gnu](https://github.com/mofyer/new-windterm/actions/runs/38108375014/job/114378599215) | 11 通过 | 与 macOS 相同的生产 PTY 探针通过 | success |
| [x86_64-pc-windows-msvc](https://github.com/mofyer/new-windterm/actions/runs/38108375014/job/114378598998) | 11 通过，含 PTY 分配前拒绝测试 | skipped；ConPTY 适配器仍未实现 | success |

macOS 原始探针输出：

```text
P0 real PTY probe: OS=macos ARCH=aarch64
PASS 2 MiB byte integrity: 2097152 payload bytes in 35.51s including ACK pause; 57.7 KiB/s observed (diagnostic only)
PASS real PTY: ownership, resize 132x43, UTF-8 bytes, 2 MiB exact output, Ctrl-C, exit 7, idempotent close; peak unacknowledged=24743 bytes
PASS 12 real PTY open/write/close cycles with withheld ACKs and worker reaping
```

Linux 原始探针输出：

```text
P0 real PTY probe: OS=linux ARCH=x86_64
PASS 2 MiB byte integrity: 2097152 payload bytes in 0.55s including ACK pause; 3701.7 KiB/s observed (diagnostic only)
PASS real PTY: ownership, resize 132x43, UTF-8 bytes, 2 MiB exact output, Ctrl-C, exit 7, idempotent close; peak unacknowledged=65536 bytes
PASS 12 real PTY open/write/close cycles with withheld ACKs and worker reaping
```

两端输出均保持在 65,536 B 未确认预算内。上述速度包含 300 ms 人工 ACK 暂停，来自不同 hosted runner 的单次功能探针；不能用来宣称平台吞吐性能达标或作公平性能对比。macOS 的 35.51 秒需要后续独立性能分析；本轮没有更改生产 I/O、ACK 或预算策略。

最终日志归档：`.artifacts/p0/ci/38108375014/`（三份 job 日志、`run.json`、每端 environment/frontend/check/tests/clippy/link 日志及 Unix PTY 日志）。公共运行页的日志 artifact 保存 14 天。三端编译成功不包含 GUI、WebView/IME、安装/签名、SSH/SFTP、Windows 真终端或 WindTerm 全功能一致性验收。

## 官方依据

- [Tauri 系统前置依赖](https://v2.tauri.app/start/prerequisites/)：Ubuntu 系统库与 Windows/macOS 工具链要求。
- [GitHub hosted runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)：当前 runner 标签及架构；实际 host 仍由 CI 检查。
- [portable-pty 0.9.0](https://docs.rs/portable-pty/0.9.0/portable_pty/)：Unix 和 ConPTY 底层后端；库支持不自动等于本应用支持。
- [Bash 调用选项](https://www.gnu.org/software/bash/manual/html_node/Invoking-Bash.html)：`--noprofile`、`--norc` 和交互模式。
