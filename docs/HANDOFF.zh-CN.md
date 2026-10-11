# New WindTerm 交接词

以下内容可直接复制给下一位模型，作为本项目继续工作的上下文。

---

你正在接手公开仓库 `https://github.com/mofyer/new-windterm`，本地目录为 `/Users/yafan/Workspace/www/new-windterm`。目标是使用 Rust + Tauri 2 + xterm.js，独立重构 WindTerm 2.7.0 的完整已有功能；视觉方向为现代苹果风，浅色 Silver Soft UI、深色中性 Carbon Dark；Apache-2.0；macOS Apple Silicon 优先，但 Windows/Linux 从架构和测试层面同步考虑。

用户明确要求：功能一致，允许更新 UI 风格；不能因为先做 macOS 就删减 Windows/Linux 或 WindTerm 功能；目前仍处于 P0，不能宣布完整重构完成、P1 通过或产品可用。

## 当前仓库状态

- 分支：`main`
- 远程：`git@github.com:mofyer/new-windterm.git`
- 当前 HEAD：`21b6150 docs: record sftp ipc ci evidence [skip ci]`
- 最近功能提交：`3216339 feat: expose bounded read-only sftp ipc`
- 工作区交接时应先执行 `git status --short`，保留其他未提交改动，不要重置或覆盖用户改动。
- P0 总路线：[docs/ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)
- 功能总矩阵：[docs/FEATURE_PARITY.zh-CN.md](FEATURE_PARITY.zh-CN.md)，当前追踪 130 项，完整基线尚未冻结。
- 当前结果：[docs/p0/RESULTS.zh-CN.md](p0/RESULTS.zh-CN.md)
- 跨平台计划：[docs/CROSS_PLATFORM.zh-CN.md](CROSS_PLATFORM.zh-CN.md)

## 已完成且有证据的内容

1. Rust + Tauri 2 + xterm.js 原型可运行，已形成真实本地 PTY、交互 SSH 和苹果风界面原型。
2. 交互 SSH 已接入 xterm 标签页，覆盖有限范围的输入、输出、resize、取消和关闭。
3. 新增受限只读 SFTP Rust 抽象和 Tauri IPC：
   - `ssh_sftp_list`
   - `ssh_sftp_metadata`
   - `ssh_sftp_read`
4. SFTP IPC 当前每次操作都重新建立连接，消费当前窗口 scope、唯一 operation ID 和一次性 host-key challenge；使用明确指定的未加密 Ed25519 测试密钥；操作完成后断开；不保存长期凭据。
5. 没有 SFTP 写入、删除、重命名、权限修改接口；前端文件面板尚未接入这些 IPC。
6. 本地检查已通过：
   - `cargo fmt -- --check`
   - `cargo check --locked --all-targets --all-features`
   - `cargo clippy --locked --all-targets --all-features -- -D warnings`
   - Rust 单测 30 passed / 1 ignored
   - SSH 集成测试 10/10 passed
7. 三平台 CI 已成功：[run 38126837364](https://github.com/mofyer/new-windterm/actions/runs/38126837364)。
   - macOS arm64：30 passed / 1 ignored，SSH 10/10，默认和 readiness PTY 通过
   - Linux x64：29 passed / 1 ignored，SSH 10/10，默认和 readiness PTY 通过
   - Windows x64：28 passed / 1 ignored，SSH 10/10，编译、测试、Clippy、链接通过
   - Windows 真实 ConPTY PTY 仍按策略跳过，不能称 Windows 终端已支持

## 绝对不能误报的边界

- 不能说 WindTerm 功能已经完整对齐。
- 不能说 SFTP 已完成：目前没有前端文件面板、真实 OpenSSH SFTP 网络验收、持久连接、写操作、取消/断线验收。
- `russh-sftp 3.0.1` 的 `read_dir` 会先由依赖收集远端目录结果，再由 wrapper 限制返回最多 4096 项；当前上限不是完整的恶意超大目录内存预算。
- Windows 的 ConPTY 同步 reader 取消、idle close、reader join、进程树回收和真实 PTY 探针仍未完成；`platform::ensure_supported()` 继续拒绝 Windows PTY。
- macOS arm64 CI 或本地 debug 构建不等于真机 IME、高输出性能、签名、公证或完整发行验收。
- 浏览器 E2E 使用 IPC stub，不能外推 Rust 网络或原生 GUI 成功。
- 有限 loopback russh 服务端不等于真实远端 OS shell/OpenSSH 互操作。

## 推荐下一步顺序

### 第一优先级：完成只读 SFTP 的可验收闭环

1. 先阅读 `apps/desktop/src/ssh-verification.ts`、`apps/desktop/src/main.ts`、`apps/desktop/src/style.css` 和 `apps/desktop/src-tauri/src/ssh.rs`，复用现有 host trust、scope、operation 和取消语义。
2. 将只读 SFTP IPC 接入一个真实的前端文件面板：目录列表、元数据显示、64 KiB 读取预览、加载/错误/取消状态；不要添加未经设计的写操作。
3. 为前端面板补浏览器契约测试；浏览器测试必须标明 IPC stub 边界。
4. 使用现有 OpenSSH 夹具或新增受控 fixture，补 Rust wrapper 的真实 subsystem 网络验收；保存原始日志、退出状态和清理证据。
5. 处理大目录边界：优先研究分页/可中止的 raw SFTP 读取；如果暂时无法修复，保留显式失败和文档门槛，不得把 `take(4097)` 写成内存安全保证。

### 第二优先级：完善 P0 连接安全和跨平台门槛

1. 评估 `read_key_bounded` 在 Windows 非普通文件/命名管道路径上的阻塞风险，确保取消或超时不会永久占用 key-reader permit。
2. 按 `docs/p0/WINDOWS_CONPTY_ADR.zh-CN.md` 实现并验证 Windows ConPTY reader cancellation、idle close、自然退出、重复 close/reload、ACK timeout、子进程树回收。
3. 继续主机信任、完整认证、长期会话、rekey、OpenSSH shell、代理/跳板/转发等 P0 盘点；不能跳过功能矩阵。

### 第三优先级：继续终端和功能基线盘点

- 输入法、中文组合态、emoji、宽字符和粘贴路径
- VT100/VT220/VT52、DECSCL、Free Type、折叠和压缩历史
- 真实 shell、tmux、标签页、分屏、会话恢复
- WindTerm 2.7.0 功能矩阵逐项证据
- macOS 签名、公证、配置迁移和发行流程

## 本地验证命令

在本机使用已安装的 Rust 工具链：

```sh
export PATH="/Users/yafan/.cargo/bin:$PATH"
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --all-features
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test ssh_terminal --all-features
```

提交前执行：

```sh
git diff --check
git status --short
git log --oneline -5
```

代码改动后必须让 Rust reviewer 或 verifier 独立审查；不要在没有真实证据时宣称跨平台运行、SFTP 完成或 WindTerm parity 完成。文档更新应同步记录提交、测试范围、平台和未验收边界。

## 交接后的工作方式

- 继续执行，不要只给计划；先检查现状，再做最小可验证改动。
- 进度用中文简短报告：当前动作、证据、未验证范围、下一步。
- 不要询问已经明确的技术路线或视觉方向。
- 不要重置工作区，不要覆盖其他模型或用户的未提交改动。
- 任何外部发布、删除、覆盖、发送消息等不可逆操作都要在具体结果准备好后再确认；普通本地开发、测试、文档和提交可直接继续。
