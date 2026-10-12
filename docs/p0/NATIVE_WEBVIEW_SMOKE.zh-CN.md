# 原生 WebView 冒烟测试（tauri-driver）

日期：2026-10-12。状态：**脚本与 CI job 已提交，CI 尚未运行，以下场景均未在原生 WebView 中得到通过回执。** 首次运行后应在本页补记运行编号、提交、各平台结果和实际版本号。

## 为什么需要

此前所有界面测试（`apps/desktop/tests/e2e/`）都在 Chrome 中运行，并用 `window.__TAURI_INTERNALS__` 的 IPC stub 代替 Rust 后端，没有任何测试在真实 Tauri 原生 WebView 中运行过。本测试通过 tauri-driver（Tauri 官方 WebDriver 中间层）启动真实应用：生产构建的前端资源、真实 Tauri IPC、打包进应用的 ACL 与 `capabilities/main.json`、真实 PTY 和 Rust SSH 客户端。

tauri-driver 只支持两种平台：

| 平台 | WebView | 原生 WebDriver | 本测试 |
| --- | --- | --- | --- |
| Linux | WebKitGTK（`libwebkit2gtk-4.1`） | WebKitWebDriver（apt `webkit2gtk-driver`），在 Xvfb 中运行 | CI `ubuntu-24.04` |
| Windows | WebView2 Runtime | msedgedriver | CI `windows-2022` |
| macOS | WKWebView | 无 | `node tests/native/run.mjs` 输出 `skipped: tauri-driver does not support macOS` 并以 0 退出 |

## 文件

| 文件 | 作用 |
| --- | --- |
| `tests/native/webdriver.mjs` | 基于 Node 内置 `fetch` 的最小 W3C WebDriver 客户端：新建会话、查找元素、点击、清空、输入、取文本、执行脚本、键盘 actions、截图、删除会话；不新增 npm 依赖 |
| `tests/native/scenarios.mjs` | 三个冒烟场景 |
| `tests/native/processes.mjs` | 启停 tauri-driver 与 SSH 夹具、解析夹具输出 |
| `tests/native/run.mjs` | 入口：选择空闲端口，启动 tauri-driver，建会话，依次执行场景，写证据，清理进程 |
| `tests/native/msedgedriver.mjs` | 仅 Windows CI：按 WebView2 Runtime 版本下载同版本 msedgedriver |
| `tests/native/webdriver.test.mjs`、`support.test.mjs` | 单元测试：客户端对 stub HTTP 服务端的请求与错误处理、超时、夹具输出解析、进程启停、版本解析、macOS 跳过 |
| `.github/workflows/p0-cross-platform.yml` 中的 `native-webview` job | 独立 job，不改动已有 `desktop` job |

## 构建与工具版本

应用构建与 `desktop` job 的「Link desktop executable」步骤是同一条命令：先 `npm run build`，再

```sh
cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --bin new-windterm-desktop
```

产物是带内嵌前端资源的 **debug** 可执行文件，不是 release 构建、安装包或签名产物。SSH 夹具另外用 `--features dev-tools` 构建 `ssh_terminal_fixture`，不影响应用二进制。

| 工具 | 固定方式 | 版本 |
| --- | --- | --- |
| tauri-driver | `cargo install tauri-driver --locked --version =2.0.6`，装到 `$RUNNER_TEMP/native-tools` | 2.0.6（Apache-2.0 OR MIT）。2.1.0 与它的源码差别只有 edition 2024 与 MSRV 1.90，行为相同 |
| WebKitWebDriver | `apt-get install webkit2gtk-driver=<libwebkit2gtk-4.1-0 的已安装版本>` | 与应用链接的 WebKitGTK 完全同一构建；具体版本由 runner 镜像决定，写入 `versions.log`，**首次运行后补记** |
| msedgedriver | 从注册表 `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 读取 WebView2 Runtime 的 `pv`，下载 `https://msedgedriver.microsoft.com/<pv>/edgedriver_win64.zip`；`msedgedriver --version` 必须与 `pv` 完全一致，否则失败，不退而求其次用同主版本驱动 | 与 runner 的 WebView2 Runtime 完全一致；版本、下载地址和压缩包 SHA-256 写入 `msedgedriver.json`，**首次运行后补记** |
| Node / Rust | 与 `desktop` job 相同 | Node 26.0.0、Rust 1.99.0 |

WebDriver 和夹具都只监听 127.0.0.1，端口由 `run.mjs` 动态选择。

版本记录注意：WebKitGTK 下 WebDriver 会话返回的 `browserName`/`browserVersion` 是 wry 通过 `ApplicationInfo` 上报的 `wry 0.57.0`，不是 WebKitGTK 版本；WebKitGTK 版本以 `dpkg-query` 和 `ldd` 的记录为准。Windows 下会话返回的 `browserVersion` 是 WebView2 Runtime 版本，另与注册表值并列记录。

## 场景与各自证明的内容

### 1. 工作台加载（workbench）

等待页面加载完成、出现一个标签页，且 xterm.js 的可访问性树中出现演示横幅 `Terminal workspace`。随后检查：

- `location.href` 是自定义协议来源（Linux `tauri://localhost`，Windows `http(s)://tauri.localhost`），证明加载的是内嵌的生产前端，不是 1420 开发服务器；
- `window.__TAURI_INTERNALS__.invoke` 存在；
- 底部说明以「桌面原型」开头，证明前端 `isTauri()` 为真；
- 记录窗口标题、视口、主题和 User-Agent，并截图 `01-workbench.png`。

证明：生产资源在该平台原生 WebView 中能在 CSP 下加载并执行，xterm.js 能渲染。不证明：像素级视觉、字体、HiDPI、主题切换。

### 2. 本地终端（local-terminal）

点击「本地终端」，等待状态栏出现「本机 shell 已启动」（`pty_open` 返回会话），然后：

- 用 WebDriver 键盘输入 `echo p0native<12 位随机十六进制>` 和 Enter：先在页面内聚焦 xterm 的输入 textarea，再对它执行 Element Send Keys；若驱动拒绝这个不可见元素，则改用 actions API，实际使用的路径写入证据。
- 等待终端中出现**恰好等于**标记的一行。输入行带有 `echo ` 前缀（Linux 还有 `P0 <目录> $ ` 提示符），只有 shell 的输出行会等于标记本身。读取来源是 xterm 的可访问性树与 DOM 渲染行。
- 核对 shell 身份，只用不需要 Shift 的按键：Linux 输入 `help help`，期望 Bash 内建命令的 `help: help [` 开头；Windows 输入 `ver`，期望 cmd.exe 内建命令输出的 `Microsoft Windows [Version …]`。
- 截图 `02-local-terminal.png`，行快照写入 `02-local-terminal.txt`；点击标签关闭按钮，等待标签数恢复。

经过的 IPC 命令：`pty_open`、`pty_resize`、`pty_write`、`pty_ack`、`pty_close`，全部经过真实 ACL。证明：WebView 中的键盘事件经 xterm.js、IPC 和 ACL 到达真实 PTY（Linux `/bin/bash --noprofile --norc -i`，Windows `cmd.exe /D /Q /K` 的 ConPTY），输出再回到 xterm.js。不证明：输入法、粘贴、高输出性能、PowerShell、ConPTY 句柄泄漏（另有 Rust 测试覆盖）。按键由 WebKitGTK 自动化或 CDP 合成，不经过操作系统输入法。

### 3. SSH 终端（ssh-terminal）

`run.mjs` 启动 `ssh_terminal_fixture`（回环 russh 内存服务端，不执行任何 OS shell），读取它打印的端口、临时私钥路径和主机指纹。界面流程：

1. 「新建连接」→「打开真实 SSH 终端」，等待「检查主机指纹」按钮可用（`ssh_context` 返回窗口范围令牌）；
2. 填写主机、端口、用户名 `fixture` 和私钥路径（WebDriver 清空并输入后读回校验；只有读回不一致时才改用脚本赋值，并在证据中标为 `script`）；
3. 点击「检查主机指纹」（`ssh_probe`），界面显示的指纹必须与夹具打印的完全一致；
4. 「仅本次信任并打开终端」（`ssh_open`；`trust: new`，不勾选保存，不写 known_hosts），等待「SSH 已连接」和夹具横幅；
5. 输入 `size`，期望 `SIZE <列> <行>`，并记录当时状态栏的列×行；输入 `unicode`，期望 `中文 🌏`；截图 `03-ssh-terminal.png`；
6. 输入 `exit`，期望状态「已退出 · code 7」，然后关闭标签。

夹具没有 `echo` 命令，所以这里的往返用它的 `size`/`unicode` 命令代替回显：输入经 `ssh_write` 到达服务端，回复经 `ssh_ack` 流控回到 xterm.js。证明：原生 WebView 中 SSH 对话框、指纹核对、交接和交互通道在真实 IPC/ACL 下能走通。不证明：与 OpenSSH 或真实主机互操作、其他认证方式、跳板与代理、known_hosts 持久化。

## 证据

CI artifact `p0-native-webview-<host>-<runner>-<attempt>`（保留 14 天），即 `$RUNNER_TEMP/p0-native/`：

- `summary.json`：平台、WebDriver 会话能力、每个场景的结果、耗时和证据字段，以及 tauri-driver、夹具的退出状态；
- `run.log`、`tauri-driver.log`（含原生驱动 stderr，以及由它启动的应用的 stderr）、`ssh-fixture.log`；
- `versions.log`（tauri-driver、WebKitGTK 包与 `ldd`，或 `msedgedriver.json` 内容）；
- `01-workbench.png`、`02-local-terminal.png`、`03-ssh-terminal.png`，`02-local-terminal.txt`、`03-ssh-terminal.txt`；
- 失败时另有 `failure-<场景>.png` 与 `failure-<场景>.json`（地址、状态栏、提示、打开的对话框、标签和终端行）。

job summary 写入各场景结果和会话能力。

## 本地运行

只有 Linux/Windows 能真正运行；macOS 上入口直接跳过。

```sh
cd apps/desktop && npm ci && npm run build && cd ../..
M=apps/desktop/src-tauri/Cargo.toml
cargo build --locked --manifest-path $M --features custom-protocol --bin new-windterm-desktop
cargo build --locked --manifest-path $M --features dev-tools --bin ssh_terminal_fixture
cargo install tauri-driver --locked --version =2.0.6
# Linux 另需 webkit2gtk-driver 与 xvfb；Windows 需要与 WebView2 同版本的 msedgedriver（P0_NATIVE_EDGEDRIVER）
P0_NATIVE_SSH_FIXTURE=apps/desktop/src-tauri/target/debug/ssh_terminal_fixture \
  xvfb-run -a node tests/native/run.mjs          # Windows 去掉 xvfb-run
node --test tests/native/webdriver.test.mjs tests/native/support.test.mjs   # 任何平台
```

其他环境变量：`P0_NATIVE_APP`（应用路径）、`P0_NATIVE_OUT`（证据目录，默认系统临时目录下新建）、`P0_NATIVE_TAURI_DRIVER`。不设置 `P0_NATIVE_SSH_FIXTURE` 时 SSH 场景记为 skipped，不算通过。

## 已验证与未验证

本机（macOS）已验证：

- 所有脚本 `node --check` 通过，工作流 YAML 可解析；
- `node --test tests/native/webdriver.test.mjs tests/native/support.test.mjs` 15 项通过（stub HTTP 服务端、替身夹具进程与无法启动的二进制）；
- `node tests/native/run.mjs` 输出 `skipped: tauri-driver does not support macOS` 并以 0 退出；
- 另用未提交的临时脚本，以 Playwright 替身会话加类 shell 的 IPC stub，在 Chrome 中对生产构建的前端跑了三个场景函数：本地终端与 SSH 场景走通（含 actions API 回退路径），工作台场景按预期在来源检查处失败（来源是 `http://127.0.0.1`）。这只说明选择器和流程与当前前端一致，不是原生 WebView 结果。

尚未验证或不在本测试范围：

- **CI 尚未运行**：Linux WebKitGTK 与 Windows WebView2 下三个场景是否通过、tauri-driver 与驱动能否在 runner 上启动应用，都还没有回执；
- macOS WKWebView（tauri-driver 不支持）；
- 输入法（中文、日文等组合输入）、操作系统级键盘布局；
- 可访问性：终端开启了 `screenReaderMode`，但没有任何读屏软件或平台无障碍 API 的验收；
- 签名、公证、安装包、release 构建；
- 高输出性能、长时间运行、多窗口；
- Windows PowerShell、`windows-2025` runner、WebView2 固定版本运行时；Linux Wayland（只测 Xvfb 下的 X11）、HiDPI、Ubuntu 24.04 以外的发行版；
- 真实 OpenSSH 与 SFTP 界面。

## 维护说明

- `native-webview` job 与 `desktop` job 共用工作流触发条件，`paths` 不含 `tests/native/**`；只改这些脚本时需手动 `workflow_dispatch`。
- 升级 tauri-driver 时修改 job 的 `TAURI_DRIVER_VERSION` 和本页版本表。
- 新增前端 IPC 命令或改动场景用到的选择器（`#local-open`、`#tabs`、`.terminal-pane.focused-pane`、`#ssh-*`、`#terminal-state`）时，同步更新 `tests/native/scenarios.mjs`。
- 源码阅读观察（未在运行中验证）：tauri-runtime-wry 2.12.1 只要进程环境变量 `TAURI_WEBVIEW_AUTOMATION=true` 就允许 WebView 自动化，不区分 debug/release；tauri-driver 正是通过这个变量启用自动化的。发行前的安全评审应考虑这一点。
