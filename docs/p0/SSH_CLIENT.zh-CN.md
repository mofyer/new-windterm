# P0 固定命令 SSH 验证入口

更新日期：2026-10-11。本页记录前一轮新增且继续保留的独立“SSH 验证”入口：Rust 直接建立 SSH 连接，展示 Ed25519 主机指纹，用户明确选择“仅本次信任”后重新核对同一主机公钥、读取指定私钥并认证，只执行固定的 `fixture-check`。此入口不打开交互终端；当前轮新增的独立交互入口见 [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)。普通连接表单、SFTP 面板和会话持久化仍为演示。本文末尾的 `84c24df` 验收是历史固定命令证据，最新代码/CI 状态见 [RESULTS](RESULTS.zh-CN.md)。

## 信任与数据边界

1. `ssh_context` 返回当前窗口文档的随机 scope token。同一代际重复调用不旋转；页面开始加载或窗口销毁时使旧 token 失效。`ssh_probe` / `ssh_accept` 必须带当前 `scopeToken`，因此旧页面延迟送达的操作不能在新页面发起连接。
2. `ssh_probe` 只接收 host、port、username、绝对 `privateKeyPath`。首次握手观察 Ed25519 原始公钥及 SHA-256 指纹，然后拒绝该未知公钥，未读取私钥、未进行用户认证。证书及其他主机密钥算法暂不支持。
3. 返回 60 秒的一次性 `challengeToken`，服务端绑定窗口、完整目标/用户名/私钥路径和公钥字节。前端不能在接受阶段替换目标或公钥。拒绝、过期或已经使用的挑战无法认证；过期记录在使用或后续探测时清理，最多保存 8 条。
4. 接受消耗挑战后建立第二条连接，原始 SSH 公钥字节必须完全一致，变更直接拒绝且不会自动生成新挑战。成功核对之后才读取唯一指定的未加密 Ed25519 私钥；不读取 SSH config、known_hosts、默认密钥或 agent，不支持密码。
5. 私钥必须为普通文件，元数据和限长读取均检查 64 KiB 上限；错误文本不包含文件路径、原始 OS/协议错误或密钥内容。读取缓冲使用 `Zeroizing`，私钥只在 Rust 内部使用。Unix 非阻塞打开避免 FIFO 路径交换后阻塞。
6. 固定执行 `fixture-check`，不申请 PTY，不拼接用户命令，不提供任意 shell。stdout/stderr 以原始字节返回，总收集上限 64 KiB，要求真实退出状态；非零退出状态仍是命令结果。UI 只以文本显示，不能把远端输出当 HTML 或终端控制指令执行。

初次指纹必须通过独立可信渠道核对。UI 中的“仅本次信任”不是真实性背书；不写入永久信任数据库。CLI 探针要求调用方传入独立取得的完整 SHA-256 指纹，不能自动相信刚收到的指纹。

## 取消、超时与资源

- 同时最多 4 个网络操作；每个探测/执行整体期限 15 秒，包含 DNS、握手、认证和命令。最多 8 条待确认挑战。
- 每个操作由窗口和 UUID 绑定。取消、reload、destroy 和退出撤销当前操作，清理相应挑战。底层保留独立 TCP descriptor，在 future 被丢弃时执行 `shutdown(Both)`，不依赖 russh `Handle::drop` 终止其内部任务。正常完成还尝试 disconnect，并最多等待 250 ms；已完整收到的命令结果不被优雅关闭失败覆盖。
- 私钥读取在 blocking pool 上执行。取消不能强杀已经开始的操作系统文件读取，例如失去响应的网络挂载；独立的 4 个读取 permit 由后台闭包一直持有到真实结束，防止反复取消积累无界读取。尚未开始的闭包会检查取消状态，晚到结果不继续认证。
- 已注册操作和最近 128 个已完成操作的取消不消耗抢先取消记录；未知 UUID 的“先取消、后分派”记录最多 128 条，达到上限后该窗口拒绝新操作直到重启。该极端保护不影响连续正常打开/取消/关闭，已有 256 次回归覆盖。
- 64 KiB 是应用输出收集上限，不是 russh、网络缓冲和密钥解析的全部内存上限。固定命令模式的 russh 使用默认 channel/window 队列；此入口没有宣称硬实时期限、整个进程内存上限或所有 OS 文件读取均可强制终止。

## 复现与验证

在仓库根目录，先执行：

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features dev-tools --bin ssh_probe
node --test tests/fixtures/ssh-sftp/rust-client.test.mjs
```

自动单元测试覆盖窗口/文档 scope、一次性/过期挑战、拒绝/reload、抢先取消及容量、普通取消不耗尽容量、两路输出合并上限、路径与文件限制、真实 TCP 卡住握手的取消及 15 秒期限后对端 EOF，以及后台读取取消后 permit 真实保留。`real_fixture_reconnect_mismatch` 是需要本机隔离 OpenSSH 的显式 ignored 集成测试，由 Node harness 单独运行，不把未运行的外部夹具测试算作常规单元测试通过。

真实夹具验证：

- 独立 known_hosts 的 Ed25519 指纹匹配 → 私钥认证 → UTF-8 `P0_SSH_OK 中文 🌏` 加换行 → exit 7。
- 错误独立指纹在认证前被拒绝；使用不存在的私钥路径证明该分支未读取私钥。
- 错误客户端私钥被服务器拒绝。
- 首次探测后测试改变服务端存储的预期公钥字节，再执行真实重连，返回 host-key-changed，未读取不存在的私钥。该测试验证重连严格比对路径，不声称真正在线轮换了服务器 host key。
- harness 终止每个临时 sshd，并断言临时连接材料已删除；原有夹具自身的 6 项 OpenSSH/SFTP 检查也先行运行。应用 SFTP 尚未接入。

实验中，把所有拒绝样本串在同一个 OpenSSH 10.3 实例后，服务器默认 `PerSourcePenalties` 会累计拒绝认证并对 loopback 激活约 15 秒惩罚，下一次握手被 reset。临时 DEBUG1 日志确认了 `srclimit_penalise` / `drop connection ... penalty: failed authentication`。最终 harness 使用两个独立服务器样本，保留原始服务器策略、不增加客户端重试；测试二进制预编译位于夹具生命周期和协议期限之外。

本机真实验证目标是 macOS 非 root、登录 shell 为 `/bin/zsh` 的已有隔离夹具。Rust 使用跨平台 TCP/russh API；Windows/Linux 的构建与测试应以对应 CI receipt 为准，不能把 macOS 协议验收当作其他平台 GUI、真实连接或密钥文件行为已验证。

## 依赖和后续

- `russh = 0.64.1`，关闭默认 features，仅启用 `ring`；Tokio 保持现有锁版本 1.50.0，zeroize 1.9.1。
- russh-cryptovec 的 nix 依赖要求 libc 0.2.180，因此从 0.2.177 升至 0.2.180；需要同时保留既有 PTY 回归和跨平台编译检查。
- 官方依据：[russh 0.64.1 client](https://github.com/Eugeny/russh/blob/v0.64.1/russh/src/client/mod.rs)、[Cargo features](https://github.com/Eugeny/russh/blob/v0.64.1/russh/Cargo.toml)、[Handler API](https://docs.rs/russh/0.64.1/russh/client/trait.Handler.html)。示例中的无条件接受主机公钥不适用于本实现。
- 当前交互终端流另见 [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)；可复用受信连接、SFTP、加密密钥/agent、跳板机及持久化 known-hosts 仍需继续实现。完整 WindTerm 功能对齐目标保持不变。


## 前一轮历史验收回执（2026-10-11，`84c24df`）

Rust 独立复验与代码审查通过：fmt、check、clippy（all-targets/all-features，`-D warnings`）及 diff 检查均通过；常规测试 24 passed、0 failed、1 explicit ignored。Node 真实夹具 harness 2/2 通过，并显式执行上述 ignored 的真实重连密钥不匹配测试。它们与浏览器 84 项契约回归属于不同证据层，不相加为产品功能完成数。

主任务当时通过 CUA 实测该轮新构建的原生应用，以下是主任务直接观察，不称为独立原生复验：

- debug 构建耗时 12.72 秒，产物 58.47 MiB，架构为 Mach-O arm64；未签名公证。
- 在 `tauri://localhost` WKWebView 依次打开「新建连接」→「SSH 验证」，输入该次 loopback 夹具的临时连接材料。显示的主机指纹与独立 known_hosts 计算结果一致后，选择「仅本次信任并验证」。
- 实际返回 stdout 22 字节：`P0_SSH_OK 中文 🌏` 加换行，stderr 0 字节，退出码 7；界面正确显示 UTF-8 文本与退出状态。使用临时测试密钥，没有使用个人密钥或 SSH 配置。
- 关闭验证后返回工作台，仅保留原有 1 个演示标签。向该次夹具发送 TERM 后正常退出 0，临时目录已不存在。

该轮覆盖真实指纹核对、显式信任、认证、固定命令与正常清理这一条原生成功路径，不替代原生取消/超时/重载等完整矩阵、交互 SSH、SFTP 或 IME 验收。历史提交 `84c24df` 的 [run 38110885626](https://github.com/mofyer/new-windterm/actions/runs/38110885626) 三平台构建与各自测试范围均 success；三端真实 SSH 夹具测试仍为 ignored，本机 Node harness 的 2/2 不外推为三端真实 SSH/GUI 通过。Windows 真实 PTY skipped，桌面链接存在非阻塞 PDB 同名 warning；完整计数、Unix PTY 与警告记录见 [跨平台回执](CROSS_PLATFORM_VALIDATION.zh-CN.md)。

## 当前代码的固定命令回归（`807e0eb`）

2026-10-11，独立 Rust 审查通道再次构建 `ssh_probe --locked`（7.04 秒）并执行 `tests/fixtures/ssh-sftp/rust-client.test.mjs`：**2/2 passed、0 skipped，3.507 秒**。覆盖明确指纹信任、UTF-8、exit 7、错误客户端密钥，且显式激活常规测试中 ignored 的 `real_fixture_reconnect_mismatch`。两次 finally 检查临时材料均返回 ENOENT，额外检查未见当前夹具目录或进程残留。

这是当前共享 SSH 代码的本机 OpenSSH **固定命令**回归，不是交互 shell、三平台 OpenSSH 或应用 SFTP 验收；当前轮其他证据见 [RESULTS](RESULTS.zh-CN.md)。

## 后续交互通道与重协商边界

后续新增的独立 `ssh_open` 入口见 [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md)；本页所述 `ssh_accept` 固定命令语义保持不变。核对 russh 0.64.1 源码发现主机 key 回调仅在初始交换调用，因此当前共享 handler 在第二次 `kex_done` 时明确拒绝 rekey 并关闭连接，不默许未重新核验的主机 key；长期交互会话需要重新连接。此为 P0 临时限制，并非最终功能范围缩减。
