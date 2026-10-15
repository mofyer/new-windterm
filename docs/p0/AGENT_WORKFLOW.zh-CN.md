# 多代理协作方式（协调者与子代理）

本文记录 2026-10-11 至 10-13 实际使用的协作方式，供新会话直接沿用。进度与结论见 [P0 工作归档](P0_ARCHIVE_2026-10.zh-CN.md)。

**2026-10-15 阶段更新**：P0 已获用户批准关闭并合入 main，用户随后要求继续 P1。当前协调者集成分支改为 `p1/integration`，任务分支使用 `p1/*`，新结果写入 [P1 执行记录](../p1/RESULTS.zh-CN.md)。下文 `p0/integration` 为历史名称，P1 执行对应步骤时使用当前集成分支；隔离 worktree、独立审查、代码门禁和 main 合并前确认规则继续适用。纯文档仅做文档一致性检查，不为历史代码重复触发全套构建；产品代码修改继续执行全套门禁。

## 协调者的循环

1. **派发任务**：把独立任务派给后台子代理。
   - 每个子代理使用独立的 git worktree（Agent 工具的 `isolation: "worktree"`）和不同的 Vite 端口（14xx）。
   - 每批大约 4 个。一次派 9–12 个时，曾多次撞上会话或每周用量上限，所有代理同时中断。
   - 优先派接近完成的任务。
2. **转发评审结果**：子代理请求的评审结果有时会送到协调者这里，而不是送到请求它的代理。遇到这种情况，用 SendMessage 把结果转给对应代理。
3. **合并与门禁**：代理提交后，由协调者合并进 `p0/integration`，在合并后的树上跑全套门禁：
   - `cargo fmt --check`；clippy（`-D warnings`）；`tools/wincheck/wincheck.sh`（Windows 目标类型检查）；
   - `cargo test --locked --all-features`；
   - 真实 OpenSSH 夹具：`node --test tests/fixtures/ssh-sftp/rust-client.test.mjs` 等；
   - `npm run build` 和 Playwright 全套。需要先在 1420 端口另开 Vite：`npx vite --port 1420 --strictPort --host 127.0.0.1`。
   - 改到产品代码时，提交前跑 `/verify`。
   - 提交使用 conventional 格式；只改文档的提交，标题末尾加 `[skip ci]`。
4. **推送与 CI**：
   - 推送 `p0/integration`，然后执行 `gh workflow run p0-cross-platform.yml --ref p0/integration`。
   - 在同一分支上新触发一次，会取消正在运行的那次，所以要等上一次跑完。
   - 设置为不阻塞（`continue-on-error`）的步骤要看测试日志，不能只看步骤状态。
5. **记录结论**：把结论写进 RESULTS、交接文档和三处台账。改台账后要运行 [结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证) 的三段脚本。

## 给子代理的规则

派发任务时，把下面这些规则写进提示词，或者让代理先读本节。

**工作区**
- 只在任务指定的 worktree 中工作。
- 如果是续做，先用 `git status` 和 `git diff` 查看前一个代理留下的改动，在此基础上继续。
- 如果 HEAD 不在 `p0/integration` 之后，先 `git merge p0/integration`。

**Git**
- 只在当前 worktree 的分支上提交，不推送，不碰 `main`、`p0/integration` 和其它分支。
- 使用 conventional 提交格式；只改文档的提交，标题末尾加 `[skip ci]`。
- 提交信息末尾加上协作者署名行。

**文档**
- 使用中文（`*.zh-CN.md`）。
- 不得声称功能已对齐、P0/P1 已通过或产品可用；已验证和未验证要分开写。

**依赖**
- 能不加就不加。必须加的话：精确锁定版本，核对许可证，更新 [DEPENDENCIES](DEPENDENCIES.zh-CN.md)，并提交锁文件。

**Tauri 命令**
- 新增命令要在三处登记：`lib.rs` 的 `generate_handler!`、`build.rs` 的 `AppManifest::commands`、`capabilities/main.json` 中的 `allow-<kebab-case>`。

**Rust**
- 使用 `--locked --all-features`；fmt、clippy（`-D warnings`）和测试都要通过。
- Windows 专属代码在本机只能用 `tools/wincheck/wincheck.sh` 做类型检查。

**浏览器测试**
- 只使用分配给自己的端口：`npx vite --port <端口> --strictPort`。
- 用一个不提交的 `playwright.local.config.ts` 覆盖 `baseURL`。
- 测完按 PID 停掉自己的 Vite。

**进程与安全**
- 不杀不是自己启动的进程；不启动 GUI 应用；不用 sudo。
- SSH 夹具按 [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md) 的规则清理，不要执行全局 `pkill sshd`。
- 测试不得触碰用户的 `~/.ssh`、`~/Downloads`、真实 agent 和 Kerberos 配置。如果系统组件绕不开，测试默认跳过，并写明原因。

**评审**
- 代码改动在提交前，要由 `rust-reviewer` 和/或 `code-reviewer` 子代理独立审查。
- 等评审给出结论，修复 CRITICAL、HIGH、MEDIUM 级问题后再提交。
- 只改文档的任务不需要评审。

**协调者负责的文件**
- 不要编辑 RESULTS、交接文档和 `CLAUDE.md`，这些由协调者维护。
- 共享文件（`ssh.rs`、`lib.rs`、`main.ts`、CI workflow）的改动要尽量集中、局部。

**最终报告**
- 写明：提交号、改动的文件、实际运行的测试命令和结果计数、评审结论、限制。

## 续做被中断的任务

新会话看不到旧会话的子代理，`SendMessage` 发不过去。续做方法：
1. 用 `git worktree list` 找到 worktree，再看 `git -C <路径> status` 和 `log`。
2. 新派一个代理，不用 isolation 参数，让它先 `cd` 到那个 worktree。
3. 在提示词中说明：前一个代理做到了哪里，然后附上原任务描述。

截至 2026-10-13 的在途任务，列在 [P0 工作归档](P0_ARCHIVE_2026-10.zh-CN.md#5-未完成与在途事项) 第 5 节。

## 用户授权的边界

用户已授权的事项见归档第 3 节：
- 推送 `p0/*` 工作分支，并手动触发 CI；
- 用 Homebrew 安装 lrzsz 和 telnetd，只作测试对端；
- 在隔离副本中运行上游 2.7.0。

合并到 `main`、新增基线 ID、分发第三方二进制，都要每次单独征得用户同意。
