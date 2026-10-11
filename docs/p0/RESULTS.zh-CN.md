# P0 结果与下一步

日期：2026-10-11。**P0 仍在进行中**，完整功能基线、关键可行性与阶段验收均未完成。浅色白银浮层方向保持用户认可；用户随后明确回复“沿这个中性炭灰方向继续”，认可深色方向。本轮继续真实 SSH 验证与 PTY 分支计量；方向认可与有限测试均不代表 IME、高输出性能或完整功能验收。

## 当前轮：SSH 验证与 PTY 分支计量

| 内容 | 当前结果 | 边界与证据 |
| --- | --- | --- |
| 独立 SSH 入口 | 桌面已接真实指纹获取、本次信任、未加密 Ed25519 测试密钥认证及固定 `fixture-check`；实现窗口代际、重连固定主机密钥、取消与超时 | [SSH_CLIENT](SSH_CLIENT.zh-CN.md)；Rust/真实夹具已独立复验，原生成功路径由主任务实测；不代表完整 SSH 功能验收 |
| 浏览器全套 | **84/84，24.6 秒，0 failed/skipped/flaky**；严格 TypeScript 检查与 build 通过；原 70 项上新增 14 项 SSH 界面/IPC 契约 | [WEB_QA](WEB_QA.zh-CN.md)；81 项正向/契约含隔离 PoC，另 2 项终端缺口及 1 项旧 Unicode 反例；没有真实网络或 Rust 验证 |
| PTY 分支诊断 | 九次有界 2 MiB 样本为 5.960–7.233 秒；负载窗口 WouldBlock sleep 为 5.860–7.133 秒，预算等待约 5–74 ms，块预算停顿为 0 | [PTY_PERFORMANCE_DIAGNOSIS](PTY_PERFORMANCE_DIAGNOSIS.zh-CN.md)；显式 feature 聚合计量、默认生产策略未改；不是安静环境基准，不代表 GUI 性能解决 |
| 本轮 Rust 独立复验 | all-targets/all-features：24 passed、0 failed、1 explicit ignored；fmt/check/clippy `-D warnings` 与 diff 检查通过；Node Rust 夹具 2/2 通过，独立审查通过 | ignored 为依赖真实对端的测试，已由 Node harness 显式激活执行；不计为常规单测通过，也不与浏览器数量相加 |
| 本轮原生 SSH 实测 | 新 debug 构建 12.72 秒、58.47 MiB、Mach-O arm64；WKWebView 指纹与独立 known_hosts 一致，本次信任后 stdout 22 字节、stderr 0、exit 7 | 主任务经 CUA 实测：`P0_SSH_OK 中文 🌏` 加换行；关闭后仅余原演示标签，夹具正常退出并删除临时目录；不是另一独立原生审查 |
| 本轮 CI | `84c24df` 的 [run 38110885626](https://github.com/mofyer/new-windterm/actions/runs/38110885626) 三端 success；Mac 24 passed、Linux/Windows 各 23 passed，均 0 failed、1 ignored；Mac/Linux 真实 PTY 通过 | [平台回执](CROSS_PLATFORM_VALIDATION.zh-CN.md)；Windows PTY skipped，真实 SSH 夹具三端均未运行；Windows 链接存在非阻塞 PDB 同名 warning，不代表三端 GUI/SSH 或性能通过 |

普通「新建连接」仍打开演示会话，交互 SSH shell 与 SFTP 文件界面尚未实现；独立 SSH 验证不保存长期信任，不支持密码、带口令密钥、agent 或跳板。受控夹具已被本轮 Rust 集成测试使用，其既有系统 OpenSSH 6 项协议与 2 项生命周期结果保留为独立历史证据。

## 第二轮历史交付与证据

| 内容 | 当前结果 | 边界与证据 |
| --- | --- | --- |
| 高输出状态更新 | 专项 Chrome 512 块输出中状态控件 DOM 写入从 2,560 次降至 4 次；最终全套观察 3 次；512 块 ACK 顺序与有界窗口保留 | [RESPONSIVENESS](RESPONSIVENESS.zh-CN.md)、[WEB_QA](WEB_QA.zh-CN.md)；IPC stub，无 Rust/PTY/WKWebView，不宣称原生性能解决 |
| 开发诊断 | 仅开发模式按参数启用，固定 13 个聚合数字；无输入/输出/路径/会话 ID 或采样数组 | 同上；无查询参数不安装，生产产物删除诊断表面 |
| 开发服务隔离 | Vite 忽略 `src-tauri` 变更，专项验证不再发送相应 full-reload 消息 | 同上；旧日志消息不等于页面实际导航，不以假设替代观察 |
| VT52 隔离实验 | 6 项有限实验通过，验证跨块基本输出转换、有界状态和未实现诊断 | [TERMINAL_COMPAT](TERMINAL_COMPAT.zh-CN.md)；没有接生产 UI/PTY，非完整 VT52 或 WindTerm 对齐 |
| DECSCL 缺口判据 | 改为 DECRQSS 查询 conformance 的前后响应，并核对 xterm 源码 | 同上；移除以 primary DA class 判断切换成功的旧断言 |
| 跨平台 CI | 修订后三个任务均成功；Mac 12 项、Linux/Windows 各 11 项单测；Mac/Linux 真实 PTY 通过，Windows 真实 PTY 跳过 | [CROSS_PLATFORM_VALIDATION](CROSS_PLATFORM_VALIDATION.zh-CN.md)保留原失败与成功回执；ConPTY 未实现，CI 成功不等于三端产品可用或性能达标 |
| 当轮本机 Rust | 当轮 Mac 单测为 12 项，含 Linux 命令/环境及缺失 shell 策略；检查和探针按专项报告记录 | 各目标条件测试数可不同，不把未运行的 Windows/Linux 测试计入 |
| 界面与全套浏览器验收 | 70/70，18.5 秒，0 failed/skipped/flaky；67 正向/契约含 6 项隔离 VT52 PoC，另 2 项原始 VT 缺口及 1 项旧 Unicode 反例；build 通过 | [WEB_QA](WEB_QA.zh-CN.md)、[设计系统](DESIGN_SYSTEM.zh-CN.md)；浅深色方向均获认可，反例与 PoC 不算生产兼容通过 |
| 当轮原生冒烟 | 当轮 arm64 debug 构建约 11.89 秒、31.76 MiB；中性灰深色下真实 PTY 粘贴中文/emoji 回显和输出完整，23 行/129 列、exit 7 | WKWebView 实测；只证明粘贴路径，不证明键盘中文/IME或高输出响应 |
| SSH/SFTP 受控夹具 | macOS `/bin/zsh` 下 6 项真实协议检查与 2 项生命周期测试经独立复验通过；1,048,596 字节源/服务器/下载 SHA-256 一致，正常及监听器异常退出均完成清理 | [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md)；loopback 与临时密钥，无 chroot、保留同 UID 文件权限；这组历史证据来自系统 OpenSSH；本轮 Rust/桌面接入另见上表，交互 SSH/SFTP 仍未实现 |
| 原生 PTY 等待诊断 | 一次本机有界 2 MiB 输出为 7.45 秒；消费阶段 99.4% 时间等待事件，ACK 调用累计 0.932 ms；报告通过独立核对 | [PTY_PERFORMANCE_DIAGNOSIS](PTY_PERFORMANCE_DIAGNOSIS.zh-CN.md)；候选为短读与两处 5 ms 轮询，尚未认定根因，未改生产策略，不是性能基准 |

状态 DOM 合并不改变终端内容、ACK 或输入时序，不关闭 screenReaderMode。诊断只是观测，Chrome 单次耗时与 keydown→stub 延迟不能用于宣布 WKWebView 的 Ctrl-C 延迟已解决。详见[响应专项](RESPONSIVENESS.zh-CN.md)。

## 终端兼容边界

原始 xterm 的 VT52 地址序列缺口继续保留。隔离 PoC 只处理干净 ANSI 初态下的一组基本 VT52 输出；污染 origin/滚动区域、图形字符集、输入键映射、身份响应等仍未完成。未来接入时 ACK 必须按原输入块与字节计数，不能按转换长度或等待后续块补齐控制序列；当前生产终端不经过该适配器。

DECSCL 的旧 primary DA 判据已撤回。新探针先查询 `DCS $ q " p ST`，发送 `CSI 62 ; 1 " p` 后再查询，实际前后均为 `DCS 1 $ r 61 ; 1 " p ST`；结合 xterm 6.0.0 源码硬编码与未支持说明确认缺口。DA 仅作身份观察。实验通过和缺口复现均不等于完整兼容性验收。

## 历史跨平台执行状态（`a82770d`）

- macOS arm64：当轮 Rust/PTY 检查及 Carbon 原生粘贴、尺寸和退出冒烟已有记录，高输出与 IME 未验收。
- Linux：Bash/Unix PTY 已在 Ubuntu 24.04 hosted 完成编译、链接、单测与真实 PTY 探针；GUI、其他发行版和完整功能仍未验收。
- Windows：hosted 编译/链接及拒绝策略已有通过记录；ConPTY 的可取消 I/O、句柄与进程树尚未实现，真实 PTY 明确跳过。

`.github/workflows/p0-cross-platform.yml` 使用 macos-15、ubuntu-24.04、windows-2022。首轮 Mac hosted 负载探针触及旧 10 秒总期限失败；修订探针总期限后，三平台编译/检查/链接及各自测试范围均成功，Windows 真实 PTY 仍明确跳过。原失败、取消运行和成功 commit/run 统一记录在[执行回执](CROSS_PLATFORM_VALIDATION.zh-CN.md)。Mac/Linux 的 2 MiB 探针耗时分别为 35.51 秒和 0.55 秒，来自不同 runner 并含人工 ACK 暂停，仅作功能诊断，不能用作公平吞吐对比或性能通过结论。[跨平台计划](../CROSS_PLATFORM.zh-CN.md)

## 上一轮保留证据

以下仅作为历史，不冒充本轮新代码、深色主题或原生性能验收：

- 56 项浏览器通过：53 正向/契约（含 2 项对比度）、2 项终端缺口、1 项旧 Unicode6 反例；原 DECSCL 断言在第二轮纠正。该轮 Rust 为 10 项，第二轮 Mac 增至 12 项；本轮计数另行记录。
- 真实 PTY 探针完成 2 MiB 字节完整性、背压、Ctrl-C、resize、exit 7 与 12 轮关闭；普通前台进程未见该探针残留，不覆盖守护化/脱离会话进程。[PTY_PROBE](PTY_PROBE.zh-CN.md)
- 旧 Mint 原生窗口持续 `yes` 累计约 41.9 MB 后，多次 Ctrl-C 才观察停止，随后恢复 `printf` 与 exit 7 成功；AX/GUI 输入与队列延迟尚未量化。
- 同生产 Session 独立后端诊断在 8,390,577 字节后注入 `0x03`，暂停 ACK 300ms，316.16ms 后收到恢复 `printf`（包含暂停），pending 峰值 5,937 字节，正常回收；不代表 GUI 性能，也不足以将此前延迟归因为 Rust 死锁。
- 上一轮白银原生 `.app` 在 WKWebView 中完成 `P0_SILVER_OK 中文 🌏` 回显/输出、`stty size`=`23 129` 与 exit 7。仅为当时版本冒烟，不是 IME、Unicode13/ZWJ 或本轮全量验收。

## Carbon 视觉与原生冒烟（历史版本）

浅色方向保持：[工作台](../assets/p0-light-workspace.png)、[连接表单](../assets/p0-light-connection.png)。中性炭灰深色已更新并获用户方向认可：[工作台](../assets/p0-dark-workspace.png)、[连接表单](../assets/p0-dark-connection.png)。浏览器正文/控件所测最低对比度为浅色 4.674:1、深色 6.321:1，1000×650 分屏与文件面板无几何越界或 pageerror；这不是完整可访问性认证。

当轮构建在 `tauri://localhost` WKWebView 的真实本地终端粘贴 `printf 'P0_CARBON_PASTE 中文 🌏\n'; stty size; exit 7`，AX 可见命令与输出均含完整中文/emoji，尺寸 23 行、129 列，退出码 7。首次 CUA `typeText` 通道未送出 Unicode，改为 paste 后才成功；因此仅记录**粘贴回显成功**，不称为中文键盘或 IME 通过。该轮没有重测原生高输出，不解决旧 Ctrl-C 延迟。

## 复核入口

macOS 开发环境需 Node.js/npm、仓库 Rust 工具链及 Xcode Command Line Tools：

```sh
cd apps/desktop
npm ci
npm run tauri dev
```

桌面模式自动启动开发服务器。纯浏览器演示改用 `npm run dev`；两者不要同时占用 1420。前端检查为 `npm run build`，浏览器全套为 `npx playwright test --config playwright.config.ts`（需服务已运行和系统 Chrome）。

仓库根目录执行 Rust 检查和真实 PTY 探针：

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo run --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --bin pty_probe
```

本机 debug 产物位于 `apps/desktop/src-tauri/target/debug/bundle/macos/New WindTerm P0.app`，不随 Git 分发，无签名公证。浏览器临时回执位于被忽略的 `apps/desktop/test-results/`，后续运行会覆盖。

## 未完成与下一步

1. 在本轮 CI、Rust 独立复验与原生 SSH 成功路径实测基础上继续原生响应、Windows ConPTY 与桌面平台专项；保留原失败及修订成功记录，沿已认可的浅深色方向完善。
2. 完成原生 IME、Ctrl-C 分层延迟、资源与可访问性专项，不能以 Chrome 状态优化代替。
3. 继续 VT52 接入策略、其他 VT 方言、Free Type、折叠与压缩历史验证；当前台账为130项：原117项保留，新增13项（11项入口已观察、2项静态候选），新增项行为均未实测；完整基线尚未冻结、功能对齐未完成，不降低完整功能目标。
4. 在固定命令 SSH 验证基础上继续交互 channel/PTY、长期主机信任、完整认证与 Rust SFTP；再扩展 agent、跳板/转发及 tmux 等夹具，不能将有限验证等同远程连接产品。
5. 完成功能基线、平台运行与风险预算后才重估工期、判断 P0 出口；当前没有正式发行版，P0 未完成。
