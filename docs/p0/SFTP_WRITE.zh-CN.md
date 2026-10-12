# SFTP 写操作原型（F02–F07）

状态更新：2026-10-12。**本页记录的是原型，不是验收。** 在只读 SFTP 授权（grant）模型之上，加入了以下操作：下载到本机、上传、删除、重命名、新建空文件、新建目录和修改权限位。

| 层面 | 结果 | 未覆盖的部分 |
| --- | --- | --- |
| Rust 协议层 | macOS arm64 本地，对系统 OpenSSH `sftp-server` 夹具验证通过 | — |
| 前端 | 浏览器 IPC stub 测试通过 | — |
| 桌面窗口 | 未做手工验收 | 原生 WKWebView / WebView2 / WebKitGTK 的 raw body IPC 和下载目录解析没有实测 |
| Linux / Windows | 没有运行 | — |

不能据此宣称以下任何一项：WindTerm 文件传输已对齐、SFTP 已完成、F02–F07 已通过、产品可用。只读浏览部分见 [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md)。

## 设计

### 分层与文件

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/sftp_write.rs`（`crate::sftp::write`） | `Writer`：mkdir、rename、删除文件、删除空目录、chmod、上传；路径、权限位、上传大小校验；批量请求 `batch()`；服务端错误映射 |
| `src-tauri/src/sftp_local.rs`（`crate::sftp::local`） | 远端单个普通文件下载到本机目录：文件名清理、`create_new` 落盘、冲突编号、失败删除半成品 |
| `src-tauri/src/ssh_sftp_write.rs`（`crate::ssh::sftp_write`） | 授权的可写开关、`sftp_mutate`、`sftp_download`、进度通道、传输期限；测试在 `ssh_sftp_write_tests.rs` |
| `src-tauri/src/sftp_ipc.rs` | 4 个 Tauri 命令的薄包装；窗口 label 作为 owner |
| `src/sftp-write.ts` | 名称与权限位校验、上传头部约定、共用的确认 / 输入对话框 |
| `src/sftp-panel.ts` | 文件面板：写入开关、写操作按钮、确认流程、进度与取消提示 |

`ssh.rs` 只做了局部改动：

- `Grant` 增加 `writable` 字段；
- `SftpRequest` 增加 `Change` / `Fetch` 两个变体；
- `use_grant` 增加 `writes` 参数；
- 运行期限改为按请求选择。

`ReadOnlySftp` 本身仍然只开放只读方法；写操作必须显式构造 `Writer`。

### 命令

四个新命令都登记在三处：`lib.rs` 的 `generate_handler!`、`build.rs`、`capabilities/main.json`（`allow-ssh-sftp-set-writable`、`allow-ssh-sftp-change`、`allow-ssh-sftp-upload`、`allow-ssh-sftp-download`）。只有 `main` 窗口可以调用。

| 命令 | 输入 | 行为 |
| --- | --- | --- |
| `ssh_sftp_set_writable` | `grantToken`、`scopeToken`、`writable` | 切换本窗口某个授权的只读 / 可写状态。不连网络，不刷新空闲时间；owner 或 scope 不符时与其他授权用法一样失败或吊销 |
| `ssh_sftp_change` | `grantToken`、`operationId`、`scopeToken`、`change`、可选 `onAuth` | `change` 是带 `kind` 标签的封闭枚举：`mkdir` / `rename` / `removeFile` / `removeDir` / `chmod`，拒绝未知字段。chmod 返回服务器修改后报告的条目，其余返回 `null` |
| `ssh_sftp_upload` | raw IPC body，即文件字节；`x-sftp-grant`、`x-sftp-scope`、`x-sftp-operation`、`x-sftp-path`（UTF-8 的十六进制）、`x-sftp-overwrite`（`true`/`false`）、可选 `x-sftp-on-auth`、`x-sftp-on-progress` | 字节不经 JSON 数字数组膨胀。头部必须是 ASCII，每个名字最多出现一次，单值不超过 16 KiB，hex 严格解码；body 超过 16 MiB 时在复制前拒绝 |
| `ssh_sftp_download` | `grantToken`、`operationId`、`scopeToken`、`path`、可选 `onAuth`、`onProgress` | 保存到 Tauri `download_dir()`。**WebView 不能指定本机路径。** 返回 `{ path, bytes }`，其中 `path` 仅用于显示 |

### 每个操作共用的路径

写操作和下载都复用只读浏览的 `Ssh::sftp_request`。每次调用都按以下顺序执行，最后断开：

1. 登记 `operationId`（UUID，可被 `ssh_cancel` 取消，不可重用）；
2. 按窗口 owner、页面 scope、存活期校验授权；
3. 重新连接，并固定校验已确认的主机密钥；
4. 重新读取私钥并认证；
5. 打开 `sftp` subsystem 执行操作。

失败的处理沿用原有的吊销 / 保留分类：

- **吊销授权**：带安全证据的连接阶段失败，即主机密钥变化、凭据被服务器拒绝、rekey。错误末尾附 `reconnect and verify the host again`，前端据此回到重新核对指纹。
- **保留授权**：文件级错误、本地失败、超时和用户取消。

写请求在只读授权上直接失败（`SFTP session is read-only; allow writes first`）：不连网络，不刷新空闲时间，授权仍然有效。

可以在发请求前判断的错误都在连接之前拒绝，也不刷新授权：

- 路径必须是绝对且规范的（无空段、`.`、`..`、控制字符），末段非空且不超过 255 字节；
- 权限位只接受 000–777；
- 上传不超过 16 MiB；
- 下载目录必须是已存在的绝对目录。

### 期限与性能

| 范围 | 期限 |
| --- | --- |
| mkdir / rename / 删除 / chmod | 沿用 15 秒 |
| 上传和下载 | 300 秒 |
| 单个 SFTP 请求（russh-sftp 默认） | 10 秒 |
| 连接空闲（russh `inactivity_timeout`） | 15 秒 |

对端停止响应时，会由单个请求的超时或连接空闲超时在十几秒内结束，300 秒只限制“慢但仍在进行”的传输。

传输按 32 KiB 分块，每 8 块（256 KiB）作为一批同时发出再等待回复（`batch()`），往返次数约为逐块等待的 1/8。按往返时间粗略估算，64 MiB 需要 256 批：

- RTT 50 ms 时约 13 秒；
- RTT 100 ms 时约 26 秒；
- 另加带宽时间。

**这是估算。** 实测只有 loopback：含 64 MiB 下载的整个写操作用例约 4.6–5.8 秒。没有在真实广域网或模拟延迟下测量。

### 各操作的语义

- **新建目录（F07）**：先 `lstat`，已存在则报 `Remote path already exists`，不覆盖；再 `mkdir`，权限由服务器默认值和 umask 决定。
- **新建空文件（F06）**：前端以 0 字节、不覆盖的方式调用上传，语义同下文的新上传。
- **重命名（F05）**：
  - 源必须存在，源与目标不能相同；
  - 先用 `lstat` 确认目标不存在，再用 SFTP v3 `rename`；
  - OpenSSH 的 v3 rename 本身拒绝已存在的目标；其他服务器可能直接替换。因此“不覆盖”在并发修改时只在 OpenSSH 上有服务器端保证。
- **删除（F04）**：
  - `removeFile` 只删普通文件或符号链接本身，不删链接目标。目录会被拒绝，并提示改用删除空目录；其他类型也会被拒绝。
  - `removeDir` 只删目录，非空时服务器拒绝（`the directory is not empty or cannot be removed`）。
  - **没有递归删除。**
- **修改权限**：
  - 只改 rwx 位（000–777），拒绝 setuid / setgid / sticky；
  - 只作用于普通文件和目录，不经符号链接修改；
  - `setstat` 后再 `lstat`，返回服务器实际报告的结果（服务器可能忽略部分位）。
- **上传（F03）**：
  - 字节由 WebView 读成一个数组，经 raw IPC body 交给 Rust，前后端都限制在 16 MiB 以内。
  - 先 `lstat` 目标：
    - 不存在时走新上传（即使请求了覆盖也一样）；
    - 是普通文件且明确请求覆盖时，才原地覆盖；
    - 其他情况拒绝：已存在且未请求覆盖，或目标是目录、链接、其他类型。
  - **新上传**的流程：
    1. 以 `WRITE|CREATE|EXCLUDE` 独占创建同目录的隐藏临时文件 `.<名称>.<8 位十六进制>.part`；
    2. 分批写入；
    3. 关闭句柄，关闭失败也算上传失败；
    4. 关闭后 `lstat`，要求是普通文件，且大小等于源字节数；
    5. 用不替换的 `rename` 放到最终名称。

    所以最终名称上永远不会出现不完整的内容。临时文件写入、校验或改名失败时，会删除该临时文件（独占创建证明它属于本次操作）。
  - **覆盖**以 `WRITE|TRUNCATE` 打开，不带 `CREATE`，因此目标在此期间被删除时会失败，而不是非独占地新建。之后原地重写，关闭后同样校验大小。这样会保留原文件的权限，但失败或取消后无法恢复原内容，错误信息会注明 `the remote file may now be incomplete`。
  - 以上 `lstat` 预检查都只是提示性的：服务器上的并发修改仍可能在检查与请求之间发生。
- **下载（F02）**：
  - 只需要只读授权。
  - `stat`（跟随符号链接）确认是普通文件，且不超过 64 MiB。
  - **远端文件打开后才创建本机文件**：
    - 保存在系统“下载”目录；
    - 文件名取远端名经 `sanitize_file_name` 清理的结果：分隔符、Windows 保留字符、控制字符、零宽和双向控制字符替换为 `_`；去掉首部空格和尾部的点与空格；Windows 设备名（含 `COM¹²³`、`LPT¹²³`）加 `_` 前缀；最长 200 字节；空名用 `download`。
  - 用 `create_new` 创建：即 `O_CREAT|O_EXCL`，Unix 上再加 `O_NOFOLLOW`。已存在的任何条目都不会被打开、截断或跟随，包括悬空的符号链接。冲突时依次尝试 `名称 (1).扩展名` 到 `(999)`。
  - 分批读取：
    - 多请求 1 个字节，用于发现 `stat` 之后文件变大；
    - 短读会丢弃本批其余回复，从新偏移重读，并把块大小降到服务器实际返回的长度；
    - 总字节数必须等于 `stat` 的大小；
    - `sync_all` 后再核对磁盘长度，才算提交。
  - **先提交本机文件，再关闭远端句柄**，因此远端关闭慢或失败不会丢弃完整的下载。
  - 提交前的任何失败或取消（操作 future 被丢弃）都会删除半成品文件。
  - 本机文件操作在多线程运行时中经 `block_in_place` 执行，不会占住其他异步任务。
- **服务端错误文本**：从不显示。错误只由状态码选择固定说明（no such file、permission denied、not supported、the server refused the request、超时、会话失败），因为服务器文本不可信、长度无界，且可能带有服务端路径。

### 前端

- 文件面板标题徽标显示 `SFTP · 只读` / `SFTP · 可写`。只读时，写操作按钮全部隐藏；下载按钮对普通文件可用，超过 64 MiB 时禁用并说明原因。
- 「允许写入…」先弹出确认对话框，内容含主机与端口，确认后才调用 `ssh_sftp_set_writable`。「恢复只读」不需要确认。以下情况下前端回到只读：
  - 断开、页面重新加载；
  - 授权过期或被吊销；
  - 后端返回只读错误。
- 新建目录、新建空文件和重命名使用输入对话框，逐字校验以下几点，校验不通过时禁用确认按钮：
  - 非空，且不是 `.` / `..`；
  - 不含 `/` 和控制字符；
  - 不超过 255 字节；
  - 当前目录没有同名项（重命名时还要求名称有变化）。
- **删除、覆盖、修改权限每次都弹出确认**（确认按钮为危险样式），取消时不发送任何请求：
  - 删除时，按文件、符号链接本身、空目录分别说明后果；
  - 覆盖时，显示原文件大小，并说明无法恢复、失败或取消可能留下不完整的文件；
  - 修改权限时，显示当前与修改后的 `rwx` 字符串，只接受三位八进制。
- 远端名称、路径、错误、下载保存路径都用 `textContent` 写入。对话框骨架是不含数据的静态模板。
- 同一时刻只运行一个操作。对话框打开期间与操作进行期间，所有动作按钮都禁用，入口函数也会再次检查。
- 进度通道只接受本操作 `operationId` 的事件。
- 取消提示按操作类型区分：

  | 取消的操作 | 提示内容 |
  | --- | --- |
  | 只读操作 | 未修改远端 |
  | 修改类操作 | 可能已在服务器上完成，请刷新核对 |
  | 新上传 | 最终名称不会有不完整内容，但可能留下 `.part` 隐藏文件 |
  | 覆盖 | 目标可能不完整 |
  | 下载 | 半成品会被删除；取消前已完成的下载会保留 |

- 修改完成后，前端刷新当前目录并重新选中相关条目。

## 写入权限决策

1. **授权默认只读，写入需要按授权显式开启。**

   开启后的状态只存在于 Rust 内存中这一个授权上，不持久化，不跨窗口。以下情况下自动失效：

   - 断开连接；
   - 页面重新加载；
   - 授权空闲 5 分钟，或签发满 30 分钟；
   - 授权被吊销。

   新授权总是从只读开始。之所以按授权而不是按全局设置，是因为一次授权对应一次指纹确认和一台主机，用户确认写入时看到的正是这台主机。

2. **这个开关记录的是用户意图，不是针对被攻破的 WebView 的安全边界。** WebView 本来就持有授权令牌。使用私钥或 agent 认证时，同一个 WebView 也能打开 SSH 终端并输入任意命令。

   真正的边界仍然是：

   - 按窗口与 scope 归属；
   - 固定主机密钥；
   - 不保存凭据；
   - 服务器自身的文件权限。

   本轮没有引入原生对话框插件（新依赖）。

   例外是密码认证。授权在 Rust 内存中持有密码，而 WebView 要打开终端必须重新提供密码。对这类主机，“可写”是被攻破的 WebView 原本没有的能力。因此发布前应改为在后端弹出原生确认后才开启写入。在那之前，不得在任何说明中把该开关描述为安全边界。

3. **逐项确认。** 不可逆或会丢失数据的操作（删除、覆盖、修改权限），即使已允许写入，也每次单独确认。新建目录、新建文件和重命名在后端拒绝覆盖已有条目，因此只需要输入名称。

4. **下载不需要可写授权。** 下载只读取服务器，本机写入位置由后端固定为“下载”目录，并且绝不覆盖已有文件。

5. **不做递归删除、不改特殊权限位、不经符号链接修改权限。** 这样可以把 P0 原型的破坏范围限制在单个条目上。

## 证据（macOS arm64 本地，2026-10-12）

环境：

- macOS 27.0.1（arm64）
- Rust 1.99.0
- Node 26.0.0
- OpenSSH 10.3p1 / LibreSSL 3.3.6

工作树已合入 `p0/integration` 的 `68b9e07`。

### Rust 检查与测试

以下命令都在仓库根目录执行，`M=apps/desktop/src-tauri/Cargo.toml`：

- `cargo fmt --manifest-path $M -- --check` 无差异；`cargo clippy --locked --manifest-path $M --all-targets --all-features -- -D warnings` 无告警。
- `cargo test --locked --manifest-path $M --all-targets --all-features` 结果如下：

  | 测试目标 | 通过 | ignored |
  | --- | --- | --- |
  | 库单元测试 | 123 | 5（需外部夹具） |
  | `tests/net_terminal.rs` | 7 | — |
  | `tests/release_bins.rs` | 3 | — |
  | `tests/ssh_kbdint.rs` | 5 | — |
  | `tests/ssh_terminal.rs` | 14 | — |
  | `tests/tmux_control.rs` | 1 | — |

  本轮新增的库测试共 22 项，其中 21 项直接运行，1 项为 ignored 的夹具测试：

  | 模块 | 覆盖内容 |
  | --- | --- |
  | `sftp::write` | 路径、权限位、上传上限；状态码映射不泄露服务端文本；进度节流；`batch()` 同时发出全部请求并保序（用 Barrier 构造：逐个等待就会超时失败）；`.part` 名称在 255 字节内 |
  | `sftp::local` | 文件名清理，包括 `../`、Windows 保留字符与设备名、双向和零宽字符、UTF-8 边界截断；冲突编号不触碰已有文件和符号链接（含悬空链接）；未提交或长度不符时删除；下载目录校验 |
  | `ssh::sftp_write` | 只读授权在连接前拒绝写入，且保留授权；可写开关校验 owner 与 scope；非法参数在使用授权前失败；传输期限；进度事件带操作 ID |
  | `sftp_ipc` | 上传头部的严格解析；`change` 标签枚举拒绝未知字段与 upload 伪装 |

### 真实 OpenSSH 夹具

`node --test tests/fixtures/ssh-sftp/rust-client.test.mjs`：5/5 通过。新增的第 4 个用例在独立夹具实例上运行 ignored 测试 `ssh::sftp_write::tests::real_fixture_sftp_write_operations`。它经 Rust `Ssh` 服务（不经过 WebView）对系统 OpenSSH `sftp-server` 依次验证了以下内容。

**只读授权与下载：**

- 只读授权下，mkdir 被拒绝，且磁盘上没有出现任何条目。
- 下载 1,048,583 字节，逐字节一致，进度单调递增，并以 `(总数, 总数)` 结束。
- 第二次下载同一文件，保存为 `source (1).bin`。
- 含冒号的中文名清理为 `冒号_名 .txt`；经符号链接下载得到的是目标内容。
- 恰好 64 MiB（上限）的稀疏文件完整下载。
- 以下下载失败且不留本机文件：目录、超过 64 MiB、不存在的路径。
- 首个进度事件后取消，本机目录与下载前完全相同。

**可写授权下的写操作：**

- 中文带空格的目录名创建成功，重复创建被拒绝。
- 1 MiB 上传：进度事件共 5 次，内容逐字节一致，目录中没有残留 `.part` 文件。
- 不覆盖时，上传到同名文件被拒绝，原内容不变。
- 明确覆盖后内容被替换。
- 对符号链接和目录请求覆盖都被拒绝，原内容不变。
- 0 字节文件上传成功。
- 重命名到已存在的名称被拒绝；重命名到新名称后，旧名称消失。
- chmod 640：磁盘与返回值一致；经符号链接修改权限被拒绝。
- 新上传在首个进度事件后取消：最终名称不存在；留下恰好 1 个 `.取消.bin.<tag>.part`，大小介于 256 KiB 与源大小之间；随后可以删除它。
- 删除符号链接本身，目标保留。
- 删除目录时用 removeFile 被拒绝；非空目录 rmdir 被拒绝；清空后 rmdir 成功。

**权限错误与收尾：**

- 在 0500 目录内 mkdir、删除、上传，都报 `permission denied`，且不带服务端文本；原文件不变。
- 切回只读后写入再次被拒绝。
- 关闭授权后返回过期。
- 结束时没有残留的操作或授权。

**夹具隔离：** 下载目录由测试传入，是夹具临时根目录下的 `downloads/`，随夹具一起删除。运行前后 `ls -la ~/Downloads` 完全相同，测试未触碰真实的“下载”文件夹。整个写操作用例耗时约 4.6–5.8 秒（loopback，debug 构建，三次运行）。

### 前端

- `npm run build`（`tsc --noEmit` + `vite build`）通过。
- Playwright 浏览器套件（IPC stub，系统 Chrome，独立 Vite 端口 1443）：225 项全部通过。本轮修复后，SFTP 相关的两个 spec 共 17 项（`sftp-panel` 10 项、`sftp-write` 7 项）再次全部通过。`sftp-write.spec.ts` 覆盖：
  - 授权从只读开始；开启写入需要确认，取消时不调用后端；断开后的新授权恢复只读。
  - 下载：参数中没有本机目录；进度只接受本操作的事件；显示最终路径；取消时只对该操作调用 `ssh_cancel`。
  - 名称校验：`/`、`..`、同名、控制字符、超过 255 字节都禁用确认按钮；mkdir、空文件、重命名的参数与刷新正确。
  - 删除、覆盖、修改权限都先确认，按 Esc 或取消时不发送请求；名为 `<img src=x onerror=alert(1)>` 的文件在对话框里显示为文本，不生成元素。
  - 上传：raw 字节与 ASCII 头部、hex 路径、16 MiB 上限；新上传、覆盖、修改类操作各自的取消提示。
  - 对话框打开期间与操作进行期间，按钮都禁用。
  - 只读错误让开关复位；吊销后要求重新连接。

### 独立审查

本轮做了两项独立审查，结论与处理如下：

| 审查 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| `rust-reviewer` | HIGH | 64 MiB 下载逐块往返，广域网下会超时 | 改为 8 块一批，期限 300 秒；仅 loopback 实测 |
| `rust-reviewer` | MEDIUM | 本机文件同步阻塞异步线程 | `block_in_place` |
| `rust-reviewer` | MEDIUM | 完整下载可能在远端关闭时被丢弃 | 先提交后关闭 |
| `rust-reviewer` | MEDIUM | 取消的新上传在最终名称留下半成品；“不存在时覆盖”非独占 | `.part` 临时文件 + 不替换的 rename；不存在时一律独占创建 |
| `rust-reviewer` | MEDIUM | 依赖 `fstat` 校验 | 改为关闭后 `lstat` |
| `rust-reviewer` | MEDIUM | rename 不覆盖只在 OpenSSH 上有服务器端保证 | 写入文档 |
| `rust-reviewer` | MEDIUM | 原生写入确认 | 按“写入权限决策”第 2 条有意不做；复核时接受原型现状，但指出密码认证的例外，发布前需重新处理 |
| `rust-reviewer` | MEDIUM | 下载总量上限与 macOS quarantine 标记 | 列为限制；复核认为它们是待办项，不能视为可发布 |
| `rust-reviewer` | LOW | 补充上标设备名，以及其他 LOW 项 | 已处理 |
| `code-reviewer` | MEDIUM | 对话框打开期间未禁用其他动作 | 已修复，并补充测试 |
| `code-reviewer` | MEDIUM | 下载入口缺少 busy 检查 | 已修复，并补充测试 |

修复后两项审查都做了复核。

## 限制与未验收项

- **原生窗口未实测。** 没有在 Tauri 桌面窗口中手工操作，以下几项都没有真实运行证据：
  - WKWebView 下 `invoke(cmd, Uint8Array, { headers })` 的 raw body 与自定义头部；
  - `download_dir()` 的解析；
  - 文件选择器读取本机文件；
  - 大文件在 WebView 内存中的表现。

  浏览器 E2E 使用 IPC stub，通过不等于 Rust 或原生成功。
- **平台：** 只在 macOS arm64 实跑。
  - 夹具在 Linux 分支未实跑，Windows 直接拒绝。
  - Windows 上 `create_new` 遇到重解析点、设备名清理，以及 WebView2 的上传路径，都没有运行证据。
  - `O_NOFOLLOW` 只用于 Unix。
- **服务器：** 只测试了 OpenSSH `sftp-server`（SFTP v3）。其他服务器（Windows OpenSSH、商业服务器等）在以下方面可能不同：
  - rename 是否替换目标、错误状态码、短读行为；
  - 不允许以 `.` 开头的文件名，或会隐藏它们。
- **性能：**
  - 只有 loopback 数据，没有广域网或延迟模拟测量。
  - 每次操作都重新连接和认证，不保持长连接。
  - 上传整个读入 WebView 内存，并在 IPC 和 Rust 中各复制一次。
  - 上限：上传 16 MiB，下载 64 MiB。
  - 进度每 256 KiB 报告一次，反映的是服务器写入确认，不是端到端校验。
  - 没有断点续传。
- **完整性：**
  - 上传和下载只核对字节数，没有哈希校验。
  - 覆盖是原地截断重写，不是原子替换，失败或取消后原内容无法恢复。
  - 取消的新上传会留下 `.part` 隐藏文件，需要用户手动删除。
  - 取消发生在下载提交之后时，完整文件会保留，但界面提示的是取消。
  - 所有 `lstat` 预检查只是提示性的。
  - 下载不写 `com.apple.quarantine`，没有总量或次数上限，不拦截可执行文件类型。
  - 下载不 fsync 目录项。
- **功能范围：**
  - 不支持以下操作：
    - 目录上传或下载、递归删除、多选与批量操作；
    - 拖放；
    - 选择下载位置，或“在访达中显示”；
    - chown、时间戳保留、特殊权限位。
  - 上传冲突只有“覆盖”和“放弃”两种选择，没有重命名或跳过。
  - 原有的模拟传输队列没有接入真实传输。
  - 名称校验只拒绝 `/` 和控制字符，服务器可能拒绝其他名称。
  - 本机文件名经过清理后可能与远端名不同；没有处理 macOS 的 Unicode 规范化差异。
- **可写开关不是安全边界**，见上文“写入权限决策”。对密码认证的主机，发布前需要改为后端原生确认。
- **下载的安全加固未做。** 下载是终端所没有的新能力：把远端选定名称的文件写入本机“下载”目录。缺少 quarantine 标记和总量上限，是发布前的待办项。
- **台账未更新。** `FEATURE_PARITY`、`BASELINE`、`baseline.json` 与冻结提议 (d) 节中 F02–F07 的 P0 证据，本提交没有修改：这些台账的计数由协调者在集成时统一更新，以免与并行分支冲突。建议的证据说明是：“写操作原型（真实 OpenSSH sftp-server、IPC stub 面板），见 [SFTP_WRITE](SFTP_WRITE.zh-CN.md)；无原生 WKWebView 实测”。修改权限属于 F24 候选（文件面板辅助），不在现有 130 个 ID 内。
