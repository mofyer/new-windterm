# P0 第二轮：跨平台编译与 Unix PTY 验证

日期：2026-10-11。最终目标仍是三平台完整功能一致；交付顺序保持 macOS Apple Silicon 优先，Windows/Linux 后续。本文区分代码适配、编译、真实 PTY 和 GUI 验收，不能以 CI 绿色代替整个平台可用。

## 当前状态

| 平台 | 当前适配 | 已取得证据 | 尚缺证据 |
| --- | --- | --- | --- |
| macOS arm64 | zsh + Unix PTY，可取消读写、ACK 背压及回收 | 本机 macOS 27.0.1：Rust 检查/单测及真实 PTY 探针；此前另有 native GUI 记录 | 本轮 hosted CI 运行记录待触发；签名、公证及完整功能验收未完成 |
| Linux x64 | 新增 Bash + Unix PTY，复用已有有界传输和取消逻辑 | Linux 命令构造策略已在 Mac 单元测试检查；**这不等于 Linux 已运行** | Ubuntu 24.04 hosted 编译、链接、单测及真实 PTY 探针均待 CI 回执；GUI/WebKit/IME 未测 |
| Windows x64 | 保留明确的未实现平台检查；创建 PTY 之前拒绝 | 预备 ICO 资源、Windows cfg 错误隔离与拒绝策略测试 | hosted 编译/链接及拒绝策略测试待 CI 回执；ConPTY 可取消 I/O、进程树清理及真实终端尚未实现 |

Linux “新增适配”表示实现已写入代码，不表示发行版兼容或运行通过。Windows 的绿色编译任务也不能解释为 Windows 终端已支持。

## 平台边界

`apps/desktop/src-tauri/src/platform.rs` 负责 shell、参数、环境、起始目录、Unix 非阻塞设置与 EOF 语义；会话归属、窗口代次、ACK 和预算仍由共享 `pty.rs` 实现。

- macOS 保持 `/bin/zsh -f -i`，隔离用户 zsh 配置与历史。
- Linux 先检查 `/bin/bash` 是存在的普通文件，再构造 `--noprofile --norc -i`；没有 Bash 时在创建 PTY 前明确失败，不静默更换 shell。实际执行权限失败仍由进程创建 API 报告。
- Linux 清空继承环境，再设置受限 PATH、TERM、`LANG/LC_ALL=C.UTF-8`、Bash 的 `PS1` 和禁用历史文件；只保留 HOME。使用系统临时目录作为初始目录。不携带 macOS 的 `LC_CTYPE=UTF-8`、ZDOTDIR 或 PROMPT，也不继承 SSH agent、BASH_ENV、ENV、LD_PRELOAD。
- 本轮 Linux 验证目标是 Ubuntu 24.04/glibc；其他发行版是否具有 Bash/C.UTF-8、对应桌面系统库仍需单独验收。
- macOS/Linux 使用同一 Unix 描述符非阻塞策略和已有取消循环。Windows 没有以跳过 `fcntl` 的方式接入；需要明确处理 ConPTY 阻塞管道的取消、句柄释放和进程树，再解除平台检查。
- Unix EIO 的 EOF 约定只在 Unix 编译；Windows 原生错误 5 不当作 EOF。`libc` 为 Unix target 的直接依赖。

## CI 执行内容

工作流：`.github/workflows/p0-cross-platform.yml`。本次已只读确认公开仓库的 Actions 已启用且允许全部 actions；工作流仍需推送后才能取得运行结论。

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

推送后在此记录 Actions run URL、被测 commit、每个 job 的 outcome、Rust host、实际测试数及 PTY 探针原始输出。若任何任务失败，应保留失败日志并修复后记录新运行，不把后续 Mac 成功覆盖之前的 Linux/Windows 失败。当前 hosted 回执：**待触发，无三平台成功声明**。

## 官方依据

- [Tauri 系统前置依赖](https://v2.tauri.app/start/prerequisites/)：Ubuntu 系统库与 Windows/macOS 工具链要求。
- [GitHub hosted runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)：当前 runner 标签及架构；实际 host 仍由 CI 检查。
- [portable-pty 0.9.0](https://docs.rs/portable-pty/0.9.0/portable_pty/)：Unix 和 ConPTY 底层后端；库支持不自动等于本应用支持。
- [Bash 调用选项](https://www.gnu.org/software/bash/manual/html_node/Invoking-Bash.html)：`--noprofile`、`--norc` 和交互模式。
