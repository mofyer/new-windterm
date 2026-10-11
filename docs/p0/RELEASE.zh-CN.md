# P0 发行包卫生与最低 macOS 版本

日期：2026-10-11。改动从 `p0/integration` 的 `5b8d83e` 开始，提交前已快进合入 `d3917d8`（这两个新提交只改 Windows 测试与 CI，不影响 macOS 产物）。本文只处理 release `.app` 里装了什么，以及最低 macOS 版本的声明。

**这不是发行验收**：没有代码签名、公证、DMG，也没有安装、升级、卸载验证；只在本机 macOS 27.0.1 arm64 上构建并静态检查产物，没有启动 `.app`，也没有在其它 macOS 版本上运行。

## 1. 测试与探针二进制移出 release 包

### 问题

[性能基线](PERFORMANCE_BASELINE.zh-CN.md)发现 release `.app` 的 `Contents/MacOS` 里除主程序外还有 `pty_probe`、`ssh_probe`、`ssh_terminal_fixture`。原因是 Cargo 会自动把 `src/bin/*.rs` 识别为二进制，`tauri build` 会全部编译并打包。当时 `pty_diagnose` 没有入包，因为它已有 `required-features = ["pty-diagnostics"]`。

### 方案：`dev-tools` feature 加 `[[bin]] required-features`

`Cargo.toml` 新增一个空 feature `dev-tools`，并为 `src/bin` 下的四个二进制写出显式 `[[bin]]`：

| 二进制 | `required-features` | 用途 |
| --- | --- | --- |
| `pty_probe` | `dev-tools` | 真实 Unix PTY 探针，CI 在 macOS 和 Linux 上运行 |
| `pty_diagnose` | `dev-tools`、`pty-diagnostics` | PTY 吞吐诊断 |
| `ssh_probe` | `dev-tools` | OpenSSH 夹具的固定命令客户端 |
| `ssh_terminal_fixture` | `dev-tools` | 手工测试 SSH 终端用的 loopback 夹具 |

这样做能生效，依据 Tauri CLI 2.12.2 的源码（`crates/tauri-cli/src/interface/rust.rs`）：

- 编译阶段：`tauri build` 执行 `cargo build --bins --release`，features 只有 `tauri/custom-protocol` 加上用户通过 `--features` 传入的值。Cargo 会跳过 `required-features` 不满足的二进制，所以这四个根本不会被编译。
- 打包阶段：`get_binaries` 先遍历 `[[bin]]`，用 `required_features_enabled(&options.features)` 判断，未满足的记为禁用；然后扫描 `src/bin` 目录，跳过与禁用项匹配的文件。**其它 `src/bin` 文件即使没有写 `[[bin]]` 也会被打包**。
- 实测证据：本轮两次“改后”构建时，`target/release/` 里都残留着前一次构建产生的 `pty_probe`、`ssh_probe`、`ssh_terminal_fixture`，但它们没有进入 `.app`；而加 `--features dev-tools` 的对照构建会把它们重新打进包（见第 4 节）。这说明排除依据是 feature，而不是文件是否存在。

由此得出两条规则：

1. 新增 `src/bin` 二进制时，必须写显式 `[[bin]]` 并加上 `required-features = ["dev-tools", ...]`。[`tests/release_bins.rs`](../../apps/desktop/src-tauri/tests/release_bins.rs) 会检查这一点，共两项：一是遍历 `src/bin`，要求每一项都有匹配 `path` 的 `[[bin]]`，且 `required-features` 包含 `dev-tools`；二是要求 `Cargo.toml` 中每个显式 `[[bin]]`（不论源文件放在哪里）都包含 `dev-tools`，因为应用本身是自动发现的 `src/main.rs`，显式 `[[bin]]` 都是工具。CI 的 `cargo test --all-targets --all-features` 会运行它。这是对 `Cargo.toml` 的逐行文本检查，不是完整的 TOML 解析：表头按整行匹配，注释里出现 `[[bin]]` 不会被当成表；多行数组、内联 `bin = [...]` 等写法会让守卫失败，需要改回单行写法。本轮手工删掉 `ssh_probe` 的门控后，两项测试都失败。
2. 不要给 `tauri build` 传 `--features dev-tools`，否则探针会被重新打进包。

没有采用的方案：

- **移到 `examples/`**：同样能排除，但所有命令要改成 `--example`，产物路径变为 `target/<profile>/examples/`，`ssh_terminal_fixture.rs` 的 `#[path]` 也要调整，改动更大。另外，这些是测试工具，不是示例。
- **Tauri bundle 配置**：`tauri.conf.json` 没有排除二进制的配置项。`bundle.externalBin` 只能增加 sidecar。

### 命令变化

不带 feature 时，`cargo run --bin pty_probe` 会由 Cargo 报错，并提示加 `--features="dev-tools"`。`cargo check/clippy/test --all-targets --all-features` 仍然会编译和检查这四个二进制。不带 `--all-features` 的 `--all-targets` 会跳过它们，所以 CLAUDE.md 要求始终带 `--all-features`。

| 用途 | 现在的命令 |
| --- | --- |
| PTY 探针（CI 与本地） | `cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features dev-tools --bin pty_probe` |
| readiness PTY 探针 | `... --features dev-tools,pty-readiness --bin pty_probe` |
| PTY 诊断 | `... --features dev-tools,pty-diagnostics --bin pty_diagnose` |
| 手工 SSH 终端夹具（在 `apps/desktop/src-tauri` 下） | `cargo run --locked --features dev-tools --bin ssh_terminal_fixture` |
| OpenSSH 夹具 runner | `node --test tests/fixtures/ssh-sftp/rust-client.test.mjs`。runner 现在自己以 `--locked --features dev-tools` 构建 `ssh_probe`，并从 Cargo 的 JSON 回执里取可执行文件路径，不再假定 `target/debug/ssh_probe` 已存在 |

已同步修改：`.github/workflows/p0-cross-platform.yml` 的两个 `pty_probe` 步骤、`tests/perf/rust-pty-baseline.sh`、`CLAUDE.md`，以及 PTY_PROBE、PTY_READINESS、PTY_PERFORMANCE_DIAGNOSIS、PERFORMANCE_BASELINE、CROSS_PLATFORM_VALIDATION、SSH_CLIENT、SSH_TERMINAL 中的复现命令。`docs/p0/RESULTS.zh-CN.md` 的 Rust 复现命令块（两条 `cargo run --bin pty_probe`）和 `docs/HANDOFF.zh-CN.md` 的“发行前问题”一条由协调者维护，本轮未改，需要协调者按上表同步。`tests/fixtures/ssh-terminal/*.mjs` 只构建 lib 测试二进制，不调用这四个二进制，所以只给其中的 cargo 调用补了 `--locked`。

## 2. `bundle.active` 为 false 时为何仍生成 `.app`

Tauri CLI 2.12.2 的 `crates/tauri-cli/src/build.rs` 是这样判断的：

```rust
if !options.no_bundle && (config.bundle.active || options.bundles.is_some()) {
```

也就是说，显式传 `--bundles` 会覆盖 `bundle.active`。`bundle.active` 只决定没有传 `--bundles` 时是否打包；`--no-bundle` 才能在任何情况下跳过打包。这是 CLI 的设计行为，不是缺陷。

本项目保持 `"active": false`，预期行为如下：

| 命令（在 `apps/desktop` 下） | 结果 |
| --- | --- |
| `npm run tauri build` | 只编译 `src-tauri/target/release/new-windterm-desktop`，不打包 |
| `npm run tauri build -- --bundles app` | 另外生成 `src-tauri/target/release/bundle/macos/New WindTerm P0.app`，供 P0 本地检查 |
| `npm run tauri build -- --no-bundle` | 任何情况下都不打包 |
| `--bundles dmg` 等安装包 | 未验证；P0 不产出安装包 |

其它说明：

- 没有配置签名身份，bundler 不会调用 `codesign`。可执行文件上只有链接器自动加的 ad-hoc 签名（`flags=0x20002(adhoc,linker-signed)`）。
- `bundle.icon` 为空，`.app` 没有图标。

`bundle.macOS.minimumSystemVersion` 在构建时有三个作用：

- tauri-cli 把它写入 `Info.plist` 的 `LSMinimumSystemVersion`。
- tauri-cli（`build.rs`/`bundle.rs`）在调用 cargo 前把它设为 `MACOSX_DEPLOYMENT_TARGET`。
- 启用 `custom-protocol` 的非 dev 构建中，tauri-build 2.7.2 还会给本 crate 输出 `cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET`。

所以主程序 Mach-O 的 `LC_BUILD_VERSION minos` 与 plist 一致（见第 4 节）。修改该值后，增量构建只会重编译声明跟踪这个变量的依赖（本轮是带 C 代码的 `ring`、`objc2-exception-helper`）及其下游，共 19 个 crate。其余缓存依赖的目标文件仍带旧下限；旧下限比新下限低，不影响在新下限及以上的系统上运行。

## 3. 最低 macOS 版本：13.3

**决定**：`bundle.macOS.minimumSystemVersion = "13.3"`。原值 `12.0` 来自初始提交，与 Tauri 文档示例相同，当时没有单独论证；按下面的分析，它实际偏低。

| 约束 | 下限 | 依据 |
| --- | --- | --- |
| Apple Silicon 与 Rust | 11.0 | M1 随 macOS 11.0 发布；Rust 1.99.0 `aarch64-apple-darwin` 的默认部署目标是 11.0（`rustc --print deployment-target`） |
| Tauri 2 | 10.13（运行）／10.15（开发环境） | tauri-utils 2.10.1 的 `minimumSystemVersion` 默认值是 10.13；[Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)要求开发机为 Catalina 10.15 及以上。wry 0.57.0 对 macOS 11–14 的新 API 都做运行时判断，例如 `setUnderPageBackgroundColor` 要求 12+，自定义数据存储要求 14+，因此不构成更高的下限 |
| 我们的代码与 xterm.js 6 实际用到的 WebKit 能力 | Safari 15.4（macOS 12.3 自带） | 详见下文 |
| 前端构建目标 | Safari 16.4（macOS 13.3 自带） | 详见下文 |

**代码实际用到的 WebKit 能力**。生产包中以下能力都从 Safari 15.4 开始提供：

- `crypto.randomUUID()`：生成会话 ID 和操作 ID，共 5 处。
- `HTMLDialogElement.showModal()`：新建连接、主机指纹、命令面板、SSH 连接、Telnet/Raw TCP 和 keyboard-interactive 提示等对话框。
- CSS `dvh`：主布局高度。
- `:focus-visible`、`accent-color`。

xterm.js 6.0.0 有两处更新的能力，但都有回退，不构成下限：

- 用 `OffscreenCanvas` 测量字符宽度（2D 上下文从 Safari 16.4 开始提供），失败时 try/catch 回退到 DOM 测量。
- `requestIdleCallback` 不可用时回退到 `setTimeout`。

**前端构建目标**。Vite 8.3.4 的默认 `build.target` 是 `baseline-widely-available`，即 `chrome111`/`edge111`/`firefox114`/`safari16.4`/`ios16.4`。Vite 只降级语法，不补 API。Safari 16.4 已支持的语法，例如正则后行断言、class static block，会原样输出；旧 WebKit 解析失败时整个脚本都不会执行。`vite.config.ts` 现在显式写出完全相同的五项 target，Vite 升级不会悄悄改变它。改前后的前端产物文件名哈希相同（`index-IxSJsILr.js`、`index-BJy7O36U.css`），说明这次固定没有改变输出。

WKWebView 使用系统自带的 WebKit。按 [Tauri 的 WebKit 版本对照表](https://v2.tauri.app/reference/webview-versions/)，各系统自带的 Safari 版本如下：

| macOS | 自带 Safari |
| --- | --- |
| 12.0 | 15.0 |
| 12.3 | 15.4 |
| 13.0 | 16.1 |
| 13.3 | 16.4 |

旧系统能否通过单独的 Safari 更新获得更新的 WKWebView，本项目没有验证。`LSMinimumSystemVersion` 也只能表达系统版本，所以下限按“该系统自带的 WebKit 满足构建目标”来取，结果是 13.3。

取舍：

- **11.x、12.0–12.2**：自带 WebKit 缺 `randomUUID` 和 `<dialog>`，界面会直接失效。原来的 12.0 声明就落在这个区间。
- **12.3–13.2**：能满足现有代码，但低于构建目标。以后只要代码用到 16.4 的语法，这些系统就会整包解析失败，而构建不会报错。
- **14.0 或 15.0**：没有技术上的必要。所有 Apple Silicon Mac 都能升级到当前 macOS，抬高下限只会排除仍停留在 Ventura 的用户。代价是：按 Apple 通常只为最近三个大版本提供安全更新的惯例推断，Ventura 已不再获得安全更新（未逐条核对 Apple 公告）。这个风险由用户的系统承担，本项目无法替用户修补。
- **结论**：在 Apple Silicon 上，满足以上全部技术约束的最旧版本是 13.3。

维护规则：

- 修改 `vite.config.ts` 中 `build.target` 的 Safari 版本时，按对照表同步修改 `minimumSystemVersion`；反之亦然。
- 引入 Safari 16.4 之后才有的 Web API 时，必须做特性检测并提供回退，或者先提高下限。

[跨平台计划](../CROSS_PLATFORM.zh-CN.md)、[总体架构](../ARCHITECTURE.zh-CN.md)和[路线图](../ROADMAP.zh-CN.md)原先写“最低 macOS 版本暂不承诺／在 P0 确定”，现已补充指向本文，并注明 13.3 只是声明的下限、未经旧系统实机验证。

## 4. 本地验证

环境：

- Apple M5 Pro，macOS 27.0.1（26A434）arm64，macOS SDK 27.0。
- Rust 1.99.0，Node 26.0.0，Tauri CLI 2.12.2。
- 没有设置签名相关环境变量。

三次构建，都没有启动 `.app`：

- **改前**：`5b8d83e` 在本 worktree 中的首次构建（依赖从零编译，`tauri build` 墙钟 56.2 s）。
- **对照**：改后代码在 `d3917d8` 上加 `--features dev-tools` 构建（`npm run tauri build -- --bundles app --features dev-tools`，增量，墙钟 15 s）。三个探针重新进入 `.app`，说明排除确实由这个 feature 决定，也印证了“不要给 `tauri build` 传 `dev-tools`”。
- **改后**：改后代码在 `d3917d8` 上的正常构建（增量，墙钟 13 s）。它在对照构建之后运行，所以 `target/release/` 里残留着对照构建的三个探针，但它们没有进入 `.app`。数值与合入 `d3917d8` 之前在 `5b8d83e` 上的改后构建逐字节相同。代码审查后 `vite.config.ts` 补齐 `ios16.4` 再构建一次，前端产物哈希与下表数值都不变。

```sh
cd apps/desktop && npm run tauri build -- --bundles app
A="src-tauri/target/release/bundle/macos/New WindTerm P0.app"
du -sk "$A"; ls -l "$A/Contents/MacOS"
/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$A/Contents/Info.plist"
lipo -info "$A"/Contents/MacOS/*; otool -l "$A/Contents/MacOS/new-windterm-desktop" | grep -A4 LC_BUILD_VERSION
```

| 项目 | 改前（`5b8d83e`） | 对照（`--features dev-tools`） | 改后 |
| --- | --- | --- | --- |
| `.app`（`du -sk`） | 23,912 KiB | 23,920 KiB | 14,972 KiB |
| `.app` 内文件字节合计 | 24,471,644 B | 24,482,332 B | 15,324,092 B（比改前减少 9,147,552 B，约 8.7 MiB） |
| Tauri 报告体积 | 23.34 MiB | 23.35 MiB | 14.61 MiB |
| `Contents/MacOS` | `new-windterm-desktop` 15,323,152 B；`pty_probe` 1,005,216 B；`ssh_probe` 4,493,888 B；`ssh_terminal_fixture` 3,648,448 B | `new-windterm-desktop` 15,332,496 B；`pty_probe` 1,005,440 B；`ssh_probe` 4,494,640 B；`ssh_terminal_fixture` 3,648,816 B | 只有 `new-windterm-desktop` 15,323,152 B |
| `LSMinimumSystemVersion` | 12.0 | 13.3 | 13.3 |
| 主程序 `LC_BUILD_VERSION` | `minos 12.0`，`sdk 27.0` | `minos 13.3`，`sdk 27.0` | `minos 13.3`，`sdk 27.0` |
| `lipo -info` | 四个文件都是 `Non-fat file ... architecture: arm64` | 四个文件都是 `Non-fat file ... architecture: arm64` | `Non-fat file ... architecture: arm64` |
| `codesign -dv` | `Signature=adhoc`，`flags=0x20002(adhoc,linker-signed)` | 相同 | 相同 |

对照构建的主程序大 9,344 B，是因为 feature 集合不同会改变 crate 的元数据哈希和符号名，代码本身没有区别。

### Rust 检查与命令回归（`d3917d8` 加本轮改动，本机 macOS arm64）

`M=apps/desktop/src-tauri/Cargo.toml`，均带 `--locked`：

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --manifest-path $M -- --check` | 通过 |
| `cargo check --manifest-path $M --all-targets --all-features` | 通过 |
| `cargo clippy --manifest-path $M --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test --manifest-path $M --all-targets --all-features` | lib 102 passed / 4 ignored；`net_terminal` 7、`release_bins` 3、`ssh_kbdint` 5、`ssh_terminal` 14、`tmux_control` 1 均通过；四个探针二进制的单元测试目标 0 项 |
| `cargo run --manifest-path $M --bin pty_probe`（不带 feature） | 按预期失败（exit 101），Cargo 提示 ``requires the features: `dev-tools` `` |
| `cargo run --manifest-path $M --features dev-tools --bin pty_probe` | 3 条 PASS |
| `cargo run --manifest-path $M --features dev-tools,pty-readiness --bin pty_probe` | 3 条 PASS |
| `cargo build --manifest-path $M --features dev-tools,pty-diagnostics --bin pty_diagnose --bin ssh_terminal_fixture` | 通过 |
| `tests/perf/rust-pty-baseline.sh debug 1`（`PERF_OUT` 指向临时目录） | 四个变体各构建并运行一次：`pty_diagnose` 各 1 条 PASS，`pty_probe` 各 3 条 PASS；只验证脚本可用，不作为性能数据 |
| `node --test tests/fixtures/ssh-sftp/rust-client.test.mjs` | 4/4 passed（固定命令客户端、重连主机密钥不匹配、只读 SFTP、SCP） |
| `node --test tests/fixtures/ssh-terminal/rust-client.test.mjs` | 1/1 passed |
| `node --test tests/fixtures/ssh-terminal/fixture.test.mjs` | 2/2 passed |
| 守卫变异检查：临时删掉 `ssh_probe` 的 `required-features` 后运行 `--test release_bins` | 两项守卫测试失败，恢复后通过 |

夹具结束后没有残留的 sshd 或夹具进程。`vite.config.ts` 只改了 `build.target`，开发服务器不读这个选项，因此没有重跑 Playwright；`tauri build` 内的 `npm run build`（`tsc --noEmit` 加 `vite build`）通过，产物哈希与改前相同。CI 的三平台运行没有在本轮触发。

## 未验证边界

- 没有在 macOS 13.3–26.x 上运行。CI 的 macos-15 runner 只编译并运行 Rust PTY 探针，不运行 WKWebView。13.3 是声明的安装下限，不代表这些系统上已验证可用。
- 本轮没有启动 `.app`，没有做原生界面、IME 或性能检查。
- 没有签名、公证、DMG、安装、升级或卸载验证。
- Windows（WebView2 常青版）和 Linux（WebKitGTK 版本随发行版）的最低版本尚未决定。
