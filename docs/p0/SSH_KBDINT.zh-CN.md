# SSH keyboard-interactive 实时提示（C13）

## 2026-10-11：连接过程中逐轮显示服务器提示

状态：**Rust 协议层对 loopback russh 夹具验证通过，浏览器 IPC 契约通过；未对真实 PAM / OpenSSH 服务器验证，未在桌面窗口中手工验收。** 原有“按提示顺序预填答案”（`keyboardInteractive { responses }`）保留不变。

### 行为

- 新凭据 `{ "method": "keyboardInteractivePrompted" }` 不携带任何答案。`ssh_accept`、`ssh_open`、`ssh_sftp_open` 以及 `ssh_sftp_list/metadata/read` 新增可选参数 `onAuth`（Tauri Channel）。选择该方式却没有传 `onAuth` 时，命令在消费指纹 challenge、建立连接之前就失败（`SSH keyboard-interactive prompts need an answer channel`），challenge 仍可再用。
- 主机密钥与已确认的指纹一致后才开始认证。服务器每发来一轮非空 `InfoRequest`，后端通过该命令自带的 Channel 只向发起命令的那个 WebView 发送 `{ operationId, round, name, instructions, prompts: [{ text, echo }], expiresInSeconds }`，然后等待新命令 `ssh_auth_respond { operationId, round, answers }`。空轮由后端自动应答，不打扰用户。
- 答案按“窗口 + 操作 ID + 轮次”绑定：其他窗口回答返回 `SSH operation not owned by this window`；轮次号不是当前轮、答案个数不符、单个答案超过 1024 字节或含 NUL、没有等待中的轮次，都会被拒绝，且不影响当前等待的轮次。一轮只能被回答一次，回答后同一答案不能重放。
- 上限：最多 8 轮、每轮 16 个提示（沿用原模块）；服务器文本在后端截断（名称 256 字节、说明 2048 字节、每个提示 512 字节），去掉 `\r`，把其余控制字符和双向文字覆盖字符（U+202A–U+202E、U+2066–U+2069 等）替换成 U+FFFD，使提示无法伪装。
- 期限：每一轮最多等待 120 秒，超时即失败关闭（`SSH keyboard-interactive prompt timed out`），不会自动发送任何答案。操作原有的 15 秒网络期限改为“暂停式”：等待用户输入的时间不计入，其余握手、认证往返与通道建立仍受 15 秒约束。等待期间连接静默，因此 prompted 方式的 russh `inactivity_timeout` 放宽为 135 秒（终端通道原本即为不设）。
- 取消：`ssh_cancel(operationId)` 立即中止等待中的轮次并关闭连接；窗口重新加载 / 销毁（`close_owner`）与应用退出（`shutdown`）同样清除该窗口所有等待中的轮次。取消后服务器收不到任何答案。
- 秘密：答案在 Rust 中以 `Zeroizing<String>` 传递，不写日志、不出现在错误信息中、不保存。只读 SFTP 授权（grant）对 prompted 方式只记住“需要提示”这一方法，不保存任何答案；因此之后每次列目录、读属性或预览都会重新连接并再次弹出提示（一次性验证码不能重放）。
- 前端（`src/ssh-kbdint.ts`）：认证方式下拉框新增“键盘交互（连接时按服务器提示输入）”。核对指纹后，每一轮在独立的模态对话框中显示：名称、说明与提示文字全部用 `textContent` 渲染（对话框骨架是不含服务器数据的静态模板）；`echo=false` 使用密码输入框，`echo=true` 使用普通文本框。提交后立即清空并禁用输入框，按钮在下一轮到来前不可再点，因此每轮答案只发送一次。“取消连接”和 Esc 都调用 `ssh_cancel`。同一时间有多个操作在等待时排队逐个显示；已结束或取消的操作再收到的轮次会被丢弃。验证对话框、终端标签与 SFTP 面板（打开与后续操作）使用同一对话框。
- 新命令 `ssh_auth_respond` 已同时登记在 `lib.rs` 的 `generate_handler!`、`build.rs` 与 `capabilities/main.json`（`allow-ssh-auth-respond`）。

### 证据（macOS arm64，本地）

- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features`：库单元测试 71 通过（4 个需外部夹具的保持 ignored），`tests/ssh_kbdint.rs` 5 通过，`tests/ssh_terminal.rs` 14 通过，`tests/tmux_control.rs` 1 通过。`cargo fmt --check` 与 `cargo clippy --all-targets --all-features -- -D warnings` 无告警。
- `tests/ssh_kbdint.rs`（russh 夹具依次询问 `Password:`（不回显）与 `Verification code: `（回显））：
  1. 固定命令、交互终端、SFTP 打开三条路径都逐轮收到两轮提示，回答后认证成功：固定命令输出夹具文本且 exit 7；终端出现提示符并 exit 7；SFTP 在认证成功之后才因夹具拒绝 subsystem 而失败（服务端认证计数 +1）。
  2. 验证码错误时服务器拒绝（`SSH keyboard-interactive authentication rejected`），错误信息不含任何答案，之后没有新的轮次。
  3. 等待第一轮时 `ssh_cancel` 或重新加载窗口：操作以 `SSH operation cancelled` 结束，之后的回答被拒绝，服务器认证计数仍为 0，连接全部关闭。
  4. 把轮次期限缩短为 400 ms 且不回答：操作以超时失败，耗时远小于 5 秒，服务器未收到任何答案。
  5. 其他窗口回答或取消被拒；错误轮次号、错误答案个数、不存在的操作 ID、非法 ID 均被拒，且都不影响当前轮次；没有 `onAuth` 时不消费 challenge。
- 库单元测试另覆盖：服务器文本的截断与控制字符替换、按窗口 / 轮次 / 个数绑定的回答登记、关闭窗口时清除、等待用户期间网络期限暂停且恢复后仍会到期、取消中止等待、prompted 凭据不接受附带答案或通道字段、prompted SFTP 授权在没有 `onAuth` 时连接前即失败且保留授权。
- Playwright（IPC stub，`tests/e2e/ssh-kbdint.spec.ts` 4 项）：服务器名称 / 说明 / 提示中的 `<img onerror>`、`<script>`、`<b>` 原样显示为文字，对话框内没有生成任何元素，也没有执行脚本；`echo=false` 为密码框、`echo=true` 为文本框；双击提交和连按回车时每轮只调用一次 `ssh_auth_respond`，答案只出现在该命令中；终端标签取消时对同一操作 ID 调用 `ssh_cancel`、不发送答案，取消后迟到的轮次被忽略；SFTP 打开时提示，之后刷新目录会再次提示，Esc 取消该次操作；其它认证方式不传 `onAuth`。完整浏览器套件 137 项通过。
- `npm run build`（`tsc --noEmit` + `vite build`）通过。

### 限制与未验收

- **未对真实 PAM / OpenSSH 服务器验证**（如 `KbdInteractiveAuthentication yes` + PAM、Google Authenticator 等），也未验证其轮次形态、`LoginGraceTime`（OpenSSH 默认 120 秒，可能早于本端期限断开）与提示文本编码；loopback russh 夹具通过不等于 OpenSSH 互操作通过。
- 浏览器测试使用 IPC stub，不证明 Tauri Channel 在真实 WebView 中的投递；未在桌面窗口中手工走通，Windows / Linux CI 尚未运行这些改动。
- 秘密清零有边界：WebView 中的输入值与 IPC JSON、以及 russh `authenticate_keyboard_interactive_respond` 需要的 `Vec<String>` 副本都不能保证清零（与原有密码 / 口令路径相同）。
- 不支持 RFC 4256 `submethods` 提示选择；转发 / 跳板探针（`connect_pinned`）没有界面，prompted 方式在那里直接失败。
- SFTP 每次操作都需重新回答提示，体验较差；需要复用已认证连接的长连接 SFTP 会话后才能改善，当前未做。
