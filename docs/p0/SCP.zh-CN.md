# 经 SFTP 授权的旧版 SCP 传输原型（F08/F09）

状态更新：2026-10-12。**本页记录的是原型，不是验收。** 原有的 SCP 探针（[`ssh_scp.rs`](../../apps/desktop/src-tauri/src/ssh_scp.rs)，见 [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md#scpf08f09)）现在有了 IPC 与界面：在只读 SFTP 文件面板里，可以显式改用旧版 SCP 协议上传或下载**单个普通文件**。

| 层面 | 结果 | 未覆盖的部分 |
| --- | --- | --- |
| Rust 协议层 | 脚本化通道的单元测试；macOS arm64 本地对系统 OpenSSH `scp -t/-f` 夹具验证通过 | — |
| 前端 | 浏览器 IPC stub 测试通过 | — |
| 桌面窗口 | 未做手工验收 | 原生 WKWebView / WebView2 / WebKitGTK 的 raw body IPC 和下载目录解析没有实测 |
| Linux / Windows | 没有运行 | OpenSSH 夹具只在 macOS 实跑；脚本化单元测试与授权门控测试不依赖平台，会随 CI 的 `cargo test` 在三个平台运行，但本提交尚无 CI 结果 |

不能据此宣称以下任何一项：WindTerm 文件传输已对齐、SCP 已完成、F08/F09 已通过、产品可用。

## 设计

### 文件

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/ssh_scp.rs`（`crate::ssh::scp`） | SCP 协议（`C` 记录解析、流式接收、分块发送、应答字节）；经授权运行的 `Job`；`Ssh::scp_upload` / `Ssh::scp_download` |
| `src-tauri/src/ssh_scp_tests.rs` | 脚本化通道的协议测试、授权门控测试、ignored 的真实夹具测试 |
| `src-tauri/src/sftp_ipc.rs` | 新增 `ssh_scp_upload`、`ssh_scp_download` 两个 Tauri 命令 |
| `src/sftp-scp.ts` | SCP 上传头部约定与界面文案 |
| `src/sftp-panel.ts` | 文件面板里的 SCP 选项与上传 / 下载分支 |

`ssh.rs` 只做了局部改动：`SftpRequest` 增加 `Scp` 变体；`connect_sftp` 拆出 `connect_grant`（重新连接、固定主机密钥、认证，不打开任何通道），SCP 在这条连接上开 exec 通道，SFTP 仍在其上打开 `sftp` subsystem。`ssh_sftp_write.rs` 的 `writes()` 把 SCP 上传算作写请求，传输期限对 SCP 一律取 300 秒。

协议读写经过一个私有的 `Wire` 抽象（接收消息、发送字节、EOF）：生产代码用 russh 通道，单元测试用按顺序回放服务端消息的脚本，因此不需要 SSH 服务器就能测试各种异常应答。

### 命令

两个新命令都登记在三处：`lib.rs` 的 `generate_handler!`、`build.rs`、`capabilities/main.json`（`allow-ssh-scp-upload`、`allow-ssh-scp-download`）。只有 `main` 窗口可以调用。

| 命令 | 输入 | 行为 |
| --- | --- | --- |
| `ssh_scp_upload` | raw IPC body（文件字节）；`x-sftp-grant`、`x-sftp-scope`、`x-sftp-operation`、`x-sftp-path`（UTF-8 的十六进制）、可选 `x-sftp-on-auth`、`x-sftp-on-progress` | 与 `ssh_sftp_upload` 的头部规则相同（ASCII、每个名字最多一次、单值 ≤ 16 KiB、hex 严格解码、body ≤ 16 MiB），但**不得带 `x-sftp-overwrite`**：SCP 无法拒绝覆盖，带上这个头部就是请求错误。成功返回 `null` |
| `ssh_scp_download` | `grantToken`、`operationId`、`scopeToken`、`path`、可选 `onAuth`、`onProgress` | 保存到 Tauri `download_dir()`，**WebView 不能指定本机路径**。返回 `{ path, bytes }`，`path` 仅用于显示 |

### 每次传输的路径

与 SFTP 写操作相同，都经 `Ssh::sftp_request`：

1. 登记 `operationId`（可被 `ssh_cancel` 取消）；
2. 按窗口 owner、页面 scope、存活期校验授权；**上传要求授权已切换为可写**，否则不连网络就返回 `SFTP session is read-only; allow writes first`，授权保留；下载在只读授权上也允许；
3. 按授权确认过的路线（直连、代理、ProxyCommand、跳板）重新连接，并固定校验已确认的主机密钥；
4. 重新读取私钥并认证（键盘交互授权每次重新提示）；
5. 打开一个 exec 通道运行 `scp -t -d -- '<目录>'` 或 `scp -f -- '<路径>'`（sh 单引号转义），完成后断开。

失败沿用授权的吊销 / 保留分类：主机密钥变化、凭据被服务器拒绝、rekey 吊销授权；SCP 协议错误、本机失败、超时和取消保留授权。与 SFTP 一样，传输完成后才发现 rekey 时也报告为失败并吊销授权；此时已下载的文件已经保存。

可以在发请求前判断的错误都在连接之前拒绝：路径必须是绝对且规范的（与 SFTP 写操作的 `validate_target` 相同）；上传不超过 16 MiB；文件名不得含 `/`、NUL、换行；下载目录必须是已存在的绝对目录。

### 语义

- **上传（F09）**：
  - 服务端命令带 `-d`：目标目录必须已是目录。没有 `-d` 时，OpenSSH 会把不存在的或普通文件的“父目录”当作目标文件本身，从而创建或覆盖它（例如请求 `/tmp/a/b.txt` 却写入 `/tmp/a`）；带 `-d` 时服务器直接报 `Not a directory` 等错误，不写任何内容。
  - 发送 `C0644 <大小> <名称>`（服务器的 umask 生效；不支持 `-p` 保留时间与权限），每 32 KiB 发送一块并报告进度（每 256 KiB 一次），最后发送结束字节，等待服务器确认和退出码 0。
  - 中途发送失败（通常是远端命令已退出）时，在 1 秒内读取服务器给出的原因（1/2 应答或退出码）作为错误；通道先 EOF、后报告退出码时也会短暂等待退出码，因此缺少 `scp` 等情况会显示为 `SCP ended early (exit 127)`。
  - **SCP 没有独占创建，也没有临时文件**：同名文件会被原地替换；失败或取消时，目标文件名上可能留下不完整的内容。这一点与 SFTP 上传（`.part` 临时文件 + 不替换的 rename）不同。
  - 目标是目录或其他类型时由服务器拒绝；前端在列表中看到同名目录、链接时不发送请求。
- **下载（F08）**，遵循 SFTP 下载规则：
  - 服务器的 `C` 记录必须是普通文件（目录记录 `D` 等被拒绝），名称必须与请求路径的末段**完全相同**（防止服务器换名），大小不超过 64 MiB。任一条件不满足时回复 `\x02` 错误并中止，**此时还没有创建本机文件**。
  - 记录通过后才创建本机文件：文件名经 `sanitize_file_name` 清理，用 `create_new`（Unix 上加 `O_NOFOLLOW`）创建，冲突时编号 `名称 (1).扩展名`，与 SFTP 下载共用 `LocalTarget`。
  - 数据边收边写，不整体缓存在内存中；收到服务器在数据后的确认字节，并在 `sync_all` 后核对磁盘长度，才提交文件。
  - 提交前的任何失败或取消（操作 future 被丢弃）都会删除半成品文件。
  - 提交后才发送最后的确认并关闭通道；这一步失败不影响已完成的文件，与 SFTP 先提交、再关闭远端句柄的做法一致。
- **服务端消息**：SCP 的 1/2 应答带有服务器文本。它被当作不可信文本：去掉控制字符以及零宽、双向控制等不可见字符，最多保留 200 个字符，以 `SCP: ` 开头显示，界面只用 `textContent` 渲染。控制行（`C` 记录、消息）最长 4096 字节。

### 前端

- 文件面板工具栏下方有一个复选框：“**用旧版 SCP 协议传输单个文件**”。默认不勾选；每次新的授权（断开、重新连接、重新加载）都恢复为不勾选。勾选后显示说明：SCP 是旧协议，一次一个普通文件，上传直接替换同名文件且没有临时文件，下载规则与 SFTP 相同。
- 勾选后：
  - 下载按钮变为“用 SCP 下载到“下载”文件夹”，调用 `ssh_scp_download`，进度与取消提示与 SFTP 下载相同；
  - 上传仍然需要先“允许写入”，按钮变为“用 SCP 上传文件…”，调用 `ssh_scp_upload`。同名普通文件存在时先确认，并说明 SCP 会直接写入该文件、没有临时文件；同名目录或链接直接拒绝；取消时提示远端可能留下不完整的文件。
  - 新建空文件、新建目录、重命名、删除和修改权限仍走 SFTP。
- 操作进行中或确认框打开时，复选框被禁用。所有远端名称、服务器消息都以文本渲染。

## 证据（macOS arm64 本地，2026-10-12）

环境：macOS 27.0.1（arm64）、Rust 1.99.0、Node 26.0.0、OpenSSH 10.3p1。工作树基于 `p0/integration` 的 `d38302a`。

### Rust 单元测试（`cargo test --lib --all-features`，不需要外部服务）

| 测试 | 覆盖内容 |
| --- | --- |
| `ssh::scp::tests::headers_are_parsed_strictly` | `C` 记录：最多 4 位八进制权限、无符号十进制大小、单段名称；服务器消息去掉控制、零宽和双向控制字符并截断 |
| `upload_sends_the_header_data_and_terminator_with_progress` | 发送的字节序列为头部 + 数据 + 结束字节，随后 EOF；进度以 `(总数, 总数)` 结束 |
| `upload_reports_refusals_and_failed_exits` | 服务器拒绝头部后不再发送数据；非零退出码、提前结束都报错；先 EOF 后退出码时报告退出码 |
| `failed_sends_report_the_server_reason` | 数据发送失败后报告服务器的 1/2 消息或退出码，都没有时才报 `SCP send failed` |
| `download_streams_into_a_new_sanitized_local_file` | 数据跨多条消息到达；`a:b.txt` 清理为 `a_b.txt`，与已有文件冲突时保存为 `a_b (1).txt`，已有文件不变 |
| `failed_downloads_leave_no_local_file` | 服务器错误、换名、超过 64 MiB、目录记录、非法头部、数据中途结束、数据后报错、非法应答字节：下载目录都保持为空；拒绝时回复 `\x02` 而不是继续 |
| `an_unusable_download_folder_refuses_the_file_before_its_data` | 本机目录不可用时在请求数据前回复错误 |
| `control_lines_are_bounded` | 超长控制行被拒绝（无论换行是否已到达）；跨消息的数据正确拼接 |
| `uploads_need_a_writable_grant_before_connecting` | 只读授权上的上传、非法路径、超限上传、不可用的下载目录都**不建立连接**；只读授权上的下载会连接；失败后授权保留 |
| `sftp_ipc::tests::scp_upload_headers_have_no_overwrite_switch` | SCP 上传头部不含 overwrite；带任何 overwrite 值都被拒绝 |

### 真实 OpenSSH 夹具

`node --test --test-name-pattern=SCP tests/fixtures/ssh-sftp/rust-client.test.mjs`：1/1 通过。该用例在独立夹具实例上运行 ignored 测试 `ssh::scp::tests::real_fixture_scp_round_trip`。夹具的命令白名单只允许 `scp -f|-t|-t -d -- '<路径>'` 且路径必须在本次夹具的 `remote/` 目录内。测试先运行原有的会话级探针，并验证 `-d`：父路径是普通文件 `plain.txt` 时上传被服务器拒绝、该文件内容不变；父目录不存在时被拒绝、也不会以该名称创建文件。然后经 `Ssh` 服务（不经过 WebView）走文件面板使用的授权路径：

- 只读授权上的上传被拒绝，远端没有出现文件；
- 切换为可写后，上传 1,048,583 字节、名称含中文、空格和单引号的文件，磁盘内容逐字节一致，进度单调递增并以 `(总数, 总数)` 结束；
- 再次上传同名文件时内容被替换（SCP 语义）；
- 上传到 `plain.txt/b.txt`（父路径是普通文件）和 `missing-dir/b.txt`（父目录不存在）都被拒绝，`plain.txt` 不变，`missing-dir` 没有出现；
- 切回只读后下载 1,048,583 字节，内容一致；再次下载保存为 `source (1).bin`；`冒号:名 .txt` 保存为 `冒号_名 .txt`；
- 不存在的文件（`SCP: ` 开头的服务器错误）、夹具目录外的 `/etc/hosts`（被夹具拒绝）、超过 64 MiB 的稀疏文件（在数据前拒绝）都失败，且下载目录不变；
- 8 MiB 下载在首个进度事件时取消：返回 `SSH operation cancelled`，下载目录与之前完全相同；
- 以上失败之后授权仍可用；关闭授权后再下载返回过期。

**夹具隔离：** 下载目录由测试传入，是夹具临时根目录下的 `downloads/`，随夹具一起删除。测试从不解析真实的“下载”文件夹；运行后 `~/Downloads` 中没有出现测试文件。

### 前端

- `npm run build` 通过。
- Playwright `tests/e2e/sftp-scp.spec.ts`（IPC stub，3 项）通过：选项文字与默认状态；勾选后下载只调用 `ssh_scp_download`，参数中没有本机目录，进度只接受本操作的事件；64 MiB 上限；取消提示与 `ssh_cancel`；取消勾选后回到 SFTP；上传需要允许写入、raw 字节、ASCII 头部、不含 `x-sftp-overwrite`；覆盖前确认且说明没有临时文件；取消提示；同名目录与超限文件不发 IPC；新建空文件仍走 SFTP；只读错误让写入开关复位；服务器消息与恶意文件名以文本显示；吊销后要求重新连接；新授权恢复为不勾选。

### 全部检查（本提交）

- `cargo fmt --check` 无差异；`cargo clippy --locked --all-targets --all-features -- -D warnings` 无告警。
- `cargo test --locked --all-targets --all-features`：库单元测试 161 通过、7 ignored（需外部夹具）；`ssh_agent_forwarding` 1、`ssh_forwarding` 8、`ssh_terminal` 14、`ssh_kbdint` 5、`ssh_routes` 5、`net_terminal` 7、`release_bins` 3、`tmux_control` 1 通过。
- `node --test tests/fixtures/ssh-sftp/fixture.test.mjs tests/fixtures/ssh-sftp/rust-client.test.mjs`：8/8 通过（夹具白名单改为也接受 `scp -t -d` 后，其他模式不受影响）。
- `npm run build` 通过；Playwright 全套（IPC stub，系统 Chrome，独立 Vite 端口 1448）370/370 通过。

### 独立审查

| 审查 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| `rust-reviewer` | HIGH | `scp -t` 不带 `-d`：父路径不存在或是普通文件时，OpenSSH 会把它当作目标文件写入 | 改为 `scp -t -d`；夹具白名单接受 `-t -d`；真实夹具新增父路径为普通文件、父目录不存在两种情况 |
| `rust-reviewer` | MEDIUM | 发送中途失败只报 `SCP send failed` | 失败后 1 秒内读取服务器原因或退出码 |
| `rust-reviewer` | MEDIUM | EOF 先于退出码到达时丢失退出码 | EOF 后短暂等待退出码 |
| `rust-reviewer` | MEDIUM | `SSH_AUTH_SOCK` 读取两次、Windows 管道名重复 | 打开终端时读取一次并登记到该连接的 `Routes`；共用 `AGENT_PIPE` |
| `rust-reviewer` | LOW | 拒绝时未清除 agent 路由；消息未去除双向控制字符；控制行长度在找到换行后未检查；测试恢复环境变量没有守卫；rekey 文档 | 均已处理 |
| `code-reviewer` | LOW | `byte()` 的移位、测试修改环境变量的说明、夹具正则顺序 | 补充说明、调整正则；`byte()` 每次传输只调用几次，缓冲区不超过一条消息，保留现状 |

`code-reviewer` 未发现 CRITICAL / HIGH / MEDIUM 问题。

## 限制与未验收项

- **原生窗口未实测**：WKWebView 下的 raw body 上传、`download_dir()` 解析、文件选择器都没有真实运行证据。浏览器 E2E 使用 IPC stub。
- **平台**：OpenSSH 夹具只在 macOS arm64 实跑；Linux 未跑夹具，Windows 夹具直接拒绝。CI 没有运行 OpenSSH 夹具。
- **服务器**：只测试了 OpenSSH 的 `scp`（legacy 模式的服务端）。不提供 `scp` 程序、限制 exec 的服务器（例如只允许 SFTP 的 `ForceCommand internal-sftp`）会让 SCP 失败；其他实现的错误文本与权限处理可能不同。
- **完整性**：
  - 上传原地写入，没有临时文件，失败或取消可能留下不完整的远端文件；无法拒绝覆盖，前端的同名检查只基于当前列表，存在竞态。
  - 只核对字节数，没有哈希校验。
  - 服务器在收到最后的确认前退出时，本机文件已经完整提交。
- **功能范围**：一次一个普通文件；不支持目录、递归、`-p`、多选、断点续传；上传上限 16 MiB（整个读入 WebView 内存），下载上限 64 MiB；没有带宽限制；原有的模拟传输队列没有接入。
- **安全加固未做**：与 SFTP 下载相同，没有 quarantine 标记和总量上限；可写开关记录用户意图，不是针对被攻破的 WebView 的安全边界（见 [SFTP_WRITE](SFTP_WRITE.zh-CN.md#写入权限决策)）。
- **台账未更新**：`FEATURE_PARITY`、`BASELINE`、`baseline.json` 中 F08/F09 的证据由协调者在集成时统一更新。建议的证据说明是：“经 SFTP 授权的 SCP 单文件上传 / 下载原型（真实 OpenSSH scp、IPC stub 面板），见 [SCP](SCP.zh-CN.md)；无原生 WKWebView 实测”。
