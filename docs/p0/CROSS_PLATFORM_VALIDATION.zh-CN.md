# P0 第二轮：跨平台编译与 Unix PTY 验证

日期：2026-10-11。最终目标仍是三平台完整功能一致；交付顺序保持 macOS Apple Silicon 优先，Windows/Linux 后续。本文区分代码适配、编译、真实 PTY 和 GUI 验收，不能以 CI 绿色代替整个平台可用。

## 本轮 SSH 与 PTY 诊断集成回执（2026-10-11）

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

工作流：`.github/workflows/p0-cross-platform.yml`。公开仓库 Actions 已启用。当前验证运行已启动，最终结论见下方回执；运行中步骤不能计为通过。

| Runner | 预期 Rust host | 真实 PTY |
| --- | --- | --- |
| `macos-15` | `aarch64-apple-darwin` | 执行 |
| `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | 执行 |
| `windows-2022` | `x86_64-pc-windows-msvc` | 明确跳过；仅运行未实现适配器拒绝测试 |

每个任务记录实际 Node/Rust/OS/架构并校验 host；固定 Rust 1.99.0、Node 26.0.0，使用 npm/Cargo 锁文件。顺序执行前端资源构建、Rust format/check/unit tests/clippy、含本地资源的桌面可执行文件链接。Unix 任务另执行 `pty_probe`：尺寸、Unicode 字节、2 MiB 完整输出、背压、Ctrl-C、退出码、越权拒绝及 12 轮关闭回收。

Ubuntu 通过 Tauri 官方清单安装 `libwebkit2gtk-4.1-dev`、编译工具、`libxdo-dev`、`libssl-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev` 等。探针直接调用生产 PTY 层，不启动 GTK 窗口；不需要伪造 GUI 成功，也不通过 xvfb 掩盖显示环境问题。

工作流权限仅 `contents: read`，checkout 不持久保存凭据；不使用发布密钥、不上传安装包、不签名、不发布 Release。Actions 使用官方仓库已核验的完整 commit SHA。各平台日志作为单独 artifact 保存 14 天，job summary 分别记录各检查的实际 outcome，失败或跳过不能计作通过。没有启用 larger/付费 runner。

## 本地复现

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin pty_probe
```

当前 Mac 单测为 12 项，新增 Linux 命令/环境配置及缺失 shell 错误测试；各平台条件编译会使数量不同。平台专属测试只有在对应 runner 实际运行后才有该平台证据。

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
