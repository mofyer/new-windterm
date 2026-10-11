# P0 性能基线（本机 macOS arm64）

日期：2026-10-11。本文为 [ROADMAP](../ROADMAP.zh-CN.md) 中 P0 交付物“性能基线”提供**一台机器上的可复现测量**：Rust PTY 吞吐与 Ctrl-C 延迟、浏览器内 xterm.js 解析吞吐与状态刷新开销、桌面 release 包的体积/架构/启动/空闲资源，以及可选的 loopback russh 测试耗时。

**范围声明**：这些数字是基线，不是性能承诺，也不代表 P0 性能关卡通过；没有与 WindTerm 做任何对比；浏览器数字来自 headless Chrome，不等于 Tauri 的 WKWebView；测量期间本机有其他代理并行跑 cargo/Playwright，属于嘈杂环境（见各表的 load 列）。只报告实际测到的值，未测项目在文末列出。

## 环境

| 项目 | 值 |
| --- | --- |
| 机器 | Apple M5 Pro，`hw.ncpu=18`（perflevel0 6 / perflevel1 12），内存 48 GiB |
| 系统 | macOS 27.0.1（26A434），arm64 |
| 工具链 | Rust/cargo 1.99.0（`rust-toolchain.toml`），Node 26.0.0，npm 12.0.2，Playwright 1.64.0，Chrome 154.0.8037.99（`channel: 'chrome'`，headless），Swift 6.4（仅编译测量辅助程序），Tauri CLI 2.12.2 / tauri 2.12.3，xterm 6.0.0 |
| 被测提交 | `9afcafef5026e2a2e624eb1a21ef20a97fe45278`（本文所在提交只新增测量脚本与本文，未改生产代码） |
| 系统负载 | 测量期间 1 分钟 load average 为 5.9–74.9，来自本机其他并行任务；每次测量旁记录了 load（`uptime`/`getloadavg`） |

所有表格格式为 **中位数 [最小值–最大值]**；n 为样本数。

## 1. Rust PTY 吞吐与 Ctrl-C 延迟

### 方法

复用既有二进制，不改其逻辑；每次运行都是新进程、新 PTY 会话，default/readiness 交替顺序（A/B、B/A、A/B）。四个二进制分别构建后复制到独立路径，避免后一次构建覆盖前一种 feature。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
tests/perf/rust-pty-baseline.sh debug 3     # 构建并运行，原始日志写入 .artifacts/p0/perf-baseline/rust-debug/
tests/perf/rust-pty-baseline.sh release 3
node tests/perf/summarize.mjs rust .artifacts/p0/perf-baseline/rust-debug
node tests/perf/summarize.mjs rust .artifacts/p0/perf-baseline/rust-release
```

脚本内部等价于（`$M` 为 `apps/desktop/src-tauri/Cargo.toml`，release 时加 `--release`；探针二进制现由 `dev-tools` feature 门控，见[发行包说明](RELEASE.zh-CN.md)）：

```sh
cargo build --locked --manifest-path $M --features dev-tools --bin pty_probe
cargo build --locked --manifest-path $M --features dev-tools,pty-readiness --bin pty_probe
cargo build --locked --manifest-path $M --features dev-tools,pty-diagnostics --bin pty_diagnose
cargo build --locked --manifest-path $M --features dev-tools,pty-diagnostics,pty-readiness --bin pty_diagnose
/usr/bin/time -l <副本>/pty_diagnose --sample
/usr/bin/time -l <副本>/pty_probe
```

指标定义沿用 [PTY readiness 实验](PTY_READINESS.zh-CN.md) 与 [PTY 吞吐诊断](PTY_PERFORMANCE_DIAGNOSIS.zh-CN.md)：

- `pty_diagnose --sample`：Rust 生成器写出精确 2 MiB，**负载耗时含 300 ms 人工 ACK 暂停**；MiB/s 为 2 MiB ÷ 该耗时。首标记读回是首字节延迟的上界；“输出中 Ctrl-C”为生成器 flush 开始标记后 50 ms 发送 Ctrl-C，到恢复标记读回的时间；idle 读调用是约 1 秒空闲窗口内的 `read` 次数（等待/唤醒代理指标，不是 CPU）。
- `pty_probe`：`head -c 2097152 /dev/zero | tr '\000' x` 负载，同样含 300 ms 暂停；整命令 real 包含其后的 12 次打开/关闭循环。
- 两者都只走 `Session` 与内存 channel，**不含 Tauri IPC、JSON、xterm.js 或 WebView**。

### `pty_diagnose --sample`（n=3）

| 构建 / 策略 | 2 MiB 负载 ms | MiB/s（含暂停） | 首标记 ms | 输出中 Ctrl-C ms | idle 读调用 | 未 ACK 峰值 B | 整命令 real s | 最大 RSS MiB | load1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| debug / 默认 5 ms 轮询 | 6863.9 [6693.7–7154.7] | 0.291 [0.280–0.299] | 7.96 [7.57–9.43] | 18.06 [14.66–18.89] | 171 [169–171] | 61,745 [59,697–61,745] | 8.07 [7.91–8.37] | 12.88 [12.86–12.91] | 7.7 [5.9–9.9] |
| debug / readiness | 335.5 [333.7–341.7] | 5.96 [5.85–5.99] | 0.444 [0.211–0.464] | 0.836 [0.748–0.894] | 6 [6–8] | 62,464 | 1.52 [1.51–1.54] | 13.05 [13.03–13.20] | 8.7 [8.1–9.0] |
| release / 默认 5 ms 轮询 | 8425.1 [8127.3–8930.4] | 0.237 [0.224–0.246] | 10.34 [7.72–12.14] | 18.79 [14.99–22.47] | 169 [167–169] | 56,627 [53,555–61,747] | 9.60 [9.31–10.12] | 12.47 [12.47–12.48] | 18.9 [17.5–21.9] |
| release / readiness | 329.2 [326.6–401.6] | 6.08 [4.98–6.12] | 0.326 [0.319–1.57] | 1.08 [0.993–1.11] | 8 [6–8] | 61,457 | 1.50 [1.49–1.58] | 12.81 [12.81–12.86] | 15.3 [14.1–16.1] |

### `pty_probe`（n=3，均输出 3 条 PASS：所有权/尺寸/UTF-8/2 MiB 完整性/Ctrl-C/退出码 7/幂等关闭，以及 12 次回收循环）

| 构建 / 策略 | 2 MiB 阶段 s（含暂停） | KiB/s（含暂停） | 未 ACK 峰值 B | 整命令 real s | 最大 RSS MiB | load1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| debug / 默认 | 6.97 [6.97–7.16] | 293.9 [286.2–293.9] | 61,607 [56,487–61,607] | 17.52 [17.46–17.67] | 13.16 [13.11–13.19] | 8.2 [6.9–9.5] |
| debug / readiness | 0.41 [0.41–0.43] | 4969.9 [4805.5–5023.8] | 7,168 [4,096–7,168] | 10.84 [10.83–10.86] | 13.36 [13.34–13.39] | 8.4 [7.8–8.7] |
| release / 默认 | 8.38 [8.16–8.66] | 244.4 [236.4–251.1] | 54,439 [51,367–56,487] | 18.89 [18.66–19.17] | 12.83 | 20.4 [16.7–23.8] |
| release / readiness | 0.39 [0.37–0.41] | 5303.9 [5029.0–5578.1] | 6,199 [3,395–16,707] | 10.83 [10.81–10.88] | 13.02 [12.95–13.05] | 16.1 [14.4–18.9] |

### 读法

- 默认 5 ms 轮询在 debug 与 release 下都是秒级（6.7–8.9 s / 2 MiB），release 并不更快；这与既有诊断“负载窗口以 `WouldBlock` 后 sleep 为主”相容。release 组运行时 load 明显更高（15–24 对 6–10），两者差异不能归因于构建模式。
- readiness 的负载耗时约 0.33 s，贴近 300 ms 人工暂停下限，因此其 MiB/s 主要受暂停限制，不是吞吐上限。本次 debug 中位数（默认 6863.9 ms / readiness 335.5 ms，Ctrl-C 18.06 / 0.836 ms）与 [readiness 实验](PTY_READINESS.zh-CN.md) 的 6898.175 / 342.195 ms 同量级。readiness 仍是默认关闭的实验，本文不改变该结论。
- `pty_probe` 的 readiness 未 ACK 峰值只有 3–17 KB，而默认约 51–62 KB；`pty_probe` 没有诊断计数，原因未测量（可能与小块读取触及 64 块上限有关，属未验证推测）。

## 2. 浏览器内 xterm.js 解析吞吐与状态刷新开销

### 方法

测量专用 Playwright spec：[`apps/desktop/tests/perf/xterm-throughput.perf.spec.ts`](../../apps/desktop/tests/perf/xterm-throughput.perf.spec.ts)，独立配置 [`playwright.perf.config.ts`](../../apps/desktop/tests/perf/playwright.perf.config.ts)。它位于默认 `tests/e2e` 之外，默认 `npx playwright test --config playwright.config.ts` 仍是 98 个测试，不会运行它。spec 只做有效性断言（ACK 顺序、块数、解析器回到 ground 状态），没有性能阈值。

```sh
cd apps/desktop
npx vite --host 127.0.0.1 --port 1432 --strictPort   # 另开；本次因端口协调使用 1432，默认端口为 1420
PERF_BASE_URL=http://127.0.0.1:1432 PERF_RUNS=3 npx playwright test --config tests/perf/playwright.perf.config.ts
node ../../tests/perf/summarize.mjs jsonl test-results/perf/xterm-perf.jsonl
```

固定负载在页面内确定性生成（不计时）：

- **ASCII 10 MiB**：95 种可打印 ASCII 行轮换，每行 78 字符 + `\r\n`，共 131,072 行，恰好 10,485,760 B。
- **混合 10 MiB**：每行含 SGR 粗体/256 色/真彩色、CJK、韩文、全角拉丁、emoji（含肤色修饰与 ZWJ 家庭序列）、组合重音和行号，平均 164 B/行，共 63,950 行，末尾补 120 个 `x` 至恰好 10,485,760 B。

两种负载每字节对应的单元格数量不同，MiB/s 不能跨负载直接比较。所有场景都按应用的数据形态分 4096 B 块、最多 16 块未完成（等于 Rust 64 KiB 未 ACK 字节预算），每次运行新开页面。

- **xterm core**：动态导入应用自身的 `createWorkspaceTerminal()`（Unicode 11、`screenReaderMode: true`、scrollback 5000），尺寸 120×36，直接 `terminal.write(Uint8Array)`。`no-renderer` 不调用 `open()`（纯解析与缓冲）；`opened` 挂到 1100×700 的可见容器上（含 DOM 渲染与无障碍树更新的交错）。
- **app stub**：真实 `main.ts` 链路（Channel 回调 → `new Uint8Array(number[])` → `xterm.write` → 按序 `pty_ack` → 100 ms 合并的状态刷新），IPC 由与 [响应性测试](RESPONSIVENESS.zh-CN.md) 相同思路的有界 stub 替代；数据块预先转成 `number[]`，模拟反序列化后的 Channel 负载，但不含 JSON 解析与 Tauri IPC。用 `?p0Diagnostics` 读取聚合计数，MutationObserver 统计五个状态控件的 DOM 变更。
- **app stub profiled**：同上，另用 CDP `Profiler`（100 µs 采样）统计 `updateStatus` / `scheduleStatusUpdate` 的包含时间及非 idle 采样总时间。采样分辨率决定亚毫秒值只有几个样本，误差大；开启 profiler 也会改变耗时，故耗时单列。

### 解析吞吐（n=3，load1 7.7–9.0）

| 场景 | 负载 | 耗时 ms | MiB/s |
| --- | --- | ---: | ---: |
| xterm core no-renderer | ASCII | 163.7 [162.4–179.2] | 61.09 [55.80–61.58] |
| xterm core opened | ASCII | 259.6 [248.8–261.9] | 38.52 [38.18–40.19] |
| app stub 全链路 | ASCII | 972.2 [921.1–982.0] | 10.29 [10.18–10.86] |
| xterm core no-renderer | 混合 | 131.7 [131.1–132.7] | 75.93 [75.36–76.28] |
| xterm core opened | 混合 | 210.5 [209.5–211.7] | 47.51 [47.24–47.73] |
| app stub 全链路 | 混合 | 917.9 [916.2–930.3] | 10.89 [10.75–10.91] |

### 状态刷新开销（n=3）

| 场景 | 负载 | 状态刷新次数 | 五个状态控件 DOM 变更 | 最大解析等待 ms | 最大 ACK 排队 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| app stub | ASCII | 11 [11–11] | 10 [10–10] | 8.0 [7.9–8.2] | 5.8 [4.7–6.1] |
| app stub | 混合 | 11 [11–11] | 10 [10–10] | 12.9 [12.5–13.6] | 5.9 [4.1–6.0] |

| 场景（开启 profiler） | 负载 | 耗时 ms | 非 idle 采样 ms | `updateStatus` 包含时间 ms | 占非 idle % | 刷新次数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| app stub profiled | ASCII | 850.9 [847.6–855.1] | 277.0 [275.6–278.2] | 0.399 [0.139–0.528] | 0.143 [0.050–0.192] | 10 [10–10] |
| app stub profiled | 混合 | 868.7 [868.3–902.6] | 305.3 [303.4–358.6] | 0.522 [0.396–0.867] | 0.172 [0.130–0.242] | 11 [10–11] |

`scheduleStatusUpdate` 在所有 profile 中采样时间为 0。10 MiB 流约 0.9 s，状态只刷新约 10 次（与 100 ms 合并一致），其 DOM 变更只来自字节数文本。

### 读法

- 在 headless Chrome 中，应用全链路比同一 xterm 工厂直接写入（opened）慢约 3.7–4.4 倍（中位数之比）；profile 显示该链路约 0.85–0.90 s 中只有约 0.28–0.36 s 是主线程非 idle 采样。剩余时间在等什么**未分析**（候选包括 ACK promise 链、stub 的微任务补数据与 xterm 写入调度的定时器间隔），不得据此推断 WKWebView 中同样存在或同样比例。
- 状态刷新的可测开销很小（包含时间 < 1 ms / 10 MiB），与 [响应性报告](RESPONSIVENESS.zh-CN.md) 中合并状态刷新的结论一致；这里只证明 Chrome stub 环境下的量级。

## 3. 桌面应用（release 包）

### 构建、体积与架构

```sh
cd apps/desktop && npm run tauri build -- --bundles app
```

构建成功（`tauri.conf.json` 中 `bundle.active` 为 false，但 Tauri CLI 2.12.2 在显式 `--bundles app` 时仍生成了 `.app`；这是 CLI 的设计行为，原因见[发行包说明](RELEASE.zh-CN.md)）。release 依赖此前已由第 1 节脚本编译，本次 `tauri build` 墙钟 26.9 s，不代表全新构建时间。

| 项目 | 值 |
| --- | --- |
| `New WindTerm P0.app`（`du -sk`） | 22,236 KiB（约 21.7 MiB） |
| 主程序 `Contents/MacOS/new-windterm-desktop` | 14,513,184 B |
| 同包内其他可执行文件 | `pty_probe` 1,004,480 B，`ssh_probe` 3,949,312 B，`ssh_terminal_fixture` 3,285,536 B |
| 前端产物（嵌入主程序） | JS 392.48 kB（gzip 105.06 kB），CSS 22.79 kB |
| 架构 | 四个可执行文件 `file` 均为 `Mach-O 64-bit executable arm64`，`lipo -info` 均为 `Non-fat file ... architecture: arm64`；`otool -L` 只链接系统框架（WebKit、AppKit 等），无第三方动态库 |
| 签名 | `codesign -dv`：`Signature=adhoc`，`flags=0x20002(adhoc,linker-signed)`；未签名发行、未公证 |

注意：Tauri 打包把 crate 中未被 `required-features` 排除的全部二进制都放进了 `.app`（当时只有 `pty_diagnose` 因需要 `pty-diagnostics` 而未入包），测试/夹具二进制约占 8.2 MB。这是发行前需要处理的打包问题，本轮只记录、不修改。后续已用 `dev-tools` feature 把它们移出 release 包，前后体积对比见[发行包说明](RELEASE.zh-CN.md)；上表仍是当时提交的测量值。

### 启动到首个窗口

辅助程序 [`tests/perf/app-launch.swift`](../../tests/perf/app-launch.swift) 由 [`tests/perf/app-baseline.sh`](../../tests/perf/app-baseline.sh) 用 `swiftc -O` 预先编译（编译不在计时内），需要调用终端具备辅助功能权限：

```sh
tests/perf/app-baseline.sh "apps/desktop/src-tauri/target/release/bundle/macos/New WindTerm P0.app" 3
node tests/perf/summarize.mjs jsonl .artifacts/p0/perf-baseline/app-release/app-set*.jsonl
```

- 计时起点：调用 `NSWorkspace.openApplication`（LaunchServices，新实例，激活）之前。
- `launch_callback_ms`：LaunchServices 回调返回进程句柄。
- `window_ms`：`CGWindowListCopyWindowInfo` 每 2 ms 轮询，出现属于该 pid、layer 0、高度 ≥ 300 pt 的屏上窗口。它表示窗口服务器已有窗口，**不是**网页首次绘制。
- `ui_button_ms`：此后每 25 ms 通过辅助功能 API 遍历，直到 WebView 暴露“本地终端”按钮（DOM 已渲染的近似）；首次 AX 请求会触发 WebKit 构建无障碍树，因此偏保守。
- 未执行 `sudo purge`，文件缓存可能是热的，**不是严格冷启动**。构建后第一次启动单列。

| 样本 | n | 启动回调 ms | 首个屏上窗口 ms | UI 按钮可见 ms | load1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 构建后第一次启动 | 1 | 80.6 | 348.2 | 760.6 | 11.5 |
| 后续启动（4 组 × 3 次） | 12 | 56.4 [46.6–71.0] | 267.9 [233.0–415.4] | 487.2 [433.7–711.3] | 18.9 [11.7–59.5] |

每次启动后都请求退出并确认该应用及其子进程（按 responsible pid）无残留：12/12 为 0。

### 空闲与打开 1 个本地终端后的 RSS/CPU

- 采样对象：应用主进程，以及 `responsibility_get_pid_responsible_for_pid` 归属到该应用的全部进程（WebKit GPU/WebContent/Networking 与系统 XPC 辅助进程，打开终端后另有 zsh）。用 `ps -axo pid,rss,%cpu,time,comm` 采样；`ps %cpu` 是带衰减的平均值（含启动阶段），因此另以两次采样间累计 CPU 时间差 ÷ 10 s 计算窗口 CPU。
- 时序：启动 → +10 s 采样 → +20 s 采样 → 通过 AX 按“本地终端” → 等到 zsh 子进程出现 → 按下后 +10 s、+20 s 采样 → 退出。AX 访问会激活 WebKit 无障碍树，终端阶段的内存可能因此偏高。
- RSS 按进程相加会重复计算共享页面，是上界，不是物理占用（未测 `footprint`/phys_footprint）。

逐次结果（MiB / %）：

| 时间（UTC） | load1 | 空闲 +10 s 主进程 / WebKit / 合计 RSS | 空闲 10–20 s 窗口 CPU | 按下到 zsh 出现 ms | 终端 +10 s 主进程 / WebKit / 合计 RSS | 终端 10–20 s 窗口 CPU | 进程数（空闲/终端） |
| --- | ---: | --- | ---: | ---: | --- | ---: | --- |
| 11:35:04 | 12.3 | 122.1 / 124.2 / 318.5 | 2.1 | 259.9 | 123.7 / 122.1 / 358.7 | 0.5 | 8 / 11 |
| 11:35:48 | 10.8 | 103.3 / 96.5 / 240.9 | 0.1 | 362.9 | 105.5 / 94.8 / 269.9 | 0.5 | 7 / 10 |
| 11:36:32 | 16.5 | 118.4 / 114.7 / 291.1 | 1.9 | 311.9 | 126.5 / 118.8 / 344.6 | 0.6 | 7 / 10 |
| 11:39:43 | 45.7 | 87.8 / 75.9 / 201.3 | 0.1 | 1531.6 | 101.5 / 86.4 / 263.0 | 0.3 | 7 / 10 |

汇总（n=4）：

| 指标 | 空闲 +10 s | 打开 1 个本地终端后 +10 s |
| --- | ---: | ---: |
| 主进程 RSS MiB | 110.8 [87.8–122.1] | 114.6 [101.5–126.5] |
| WebKit 辅助进程 RSS MiB | 105.6 [75.9–124.2] | 106.8 [86.4–122.1] |
| 归属进程合计 RSS MiB | 266.0 [201.3–318.5] | 307.3 [263.0–358.7] |
| `ps %cpu` 合计（衰减平均） | 1.8 [0.0–4.1] | 0.2 [0.2–0.3] |
| 随后 10 s 窗口 CPU % | 1.0 [0.1–2.1] | 0.5 [0.3–0.6] |

空闲 +20 s 合计 RSS 为 259.0 [184.4–312.4] MiB。第 4 次记录了进程名：空闲时为主进程、WebKit GPU/WebContent/Networking、`com.apple.SafariPlatformSupport.Helper`、`com.apple.audio.SandboxHelper`、`SetStoreUpdateService`；打开终端后另有 zsh（3.3 MiB）、`ThemeWidgetControlViewService` 和第二个 `SetStoreUpdateService`。空闲窗口 CPU 呈 0.1% 与约 2% 两档，当时窗口是否在前台、是否被遮挡没有受控记录，原因未分析。

样本只有 4 个的原因：第一组 3 次全部完成；之后 6 次资源测量尝试（第 2 组 3 次，第 3、4 组各 1 次后脚本按失败中止，另有 1 次单独调试）都在 AX 查找阶段失败（后几次记录到根元素返回 `kAXErrorCannotComplete`，应用不在前台）。系统日志显示，一次手工启动的窗口在约 2.7 s 后收到关闭按钮的鼠标点击（`trackMouse ... windowShouldClose`）后退出，推测是本机其他操作关闭了窗口；为避免继续干扰，不再重复启动。第 4 行来自同一方法的一次单独调试运行（当时 load1 45.7），按下到 zsh 出现的 1.5 s 应结合该负载阅读。这些失败尝试没有计入统计，原始输出保留在本地。第一组使用的辅助程序版本只做单次 AX 遍历、未输出进程名；之后加入的有界重试（10 s）、AX 消息超时（10 s）、进程名与前台状态记录只影响按下按钮之前的查找与输出字段，不改变空闲阶段的采样方法。

## 4. 可选：loopback russh 2 MiB 测试耗时

```sh
tests/perf/ssh-loopback-baseline.sh 3   # cargo test --test ssh_terminal --all-features --no-run 后直接计时测试可执行文件
```

| 测试（debug，`--exact`） | n | 整测试 real s | user s | 最大 RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| `bounded_two_mib_output_recovers_after_ack_pause_and_interrupts` | 3 | 4.29 [4.22–4.32] | 0.19 [0.17–0.25] | 19.2 |
| `burst_with_prompt_ack_is_not_false_overload` | 3 | 0.09 [0.09–0.10] | 0.07 [0.07–0.08] | 19.2 |

load1 为 7.8–15.8。耗时是整测试墙钟，包含进程内 loopback 服务端启动、测试自带的暂停与第二轮中断，`/usr/bin/time` 分辨率 10 ms，不是 SSH 吞吐指标；loopback russh 服务端不等于 OpenSSH 或真实远端 shell。

## 未测量与限制

- **headless Chrome ≠ WKWebView**：第 2 节没有 Tauri IPC、JSON 序列化、WKWebView 渲染或真实 PTY；不能推导桌面应用中的同等吞吐。
- **没有 GUI 全链路高输出测量**：Rust PTY → Tauri IPC → WKWebView xterm 的吞吐、原生 Ctrl-C 延迟、高输出时的 CPU/内存都未测；第 1 节 CLI 与第 2 节浏览器数字不能相加得出 GUI 结果。
- **没有与 WindTerm 对比**：仓库仅有上游 2.7.0 x86_64 dmg（需 Rosetta），本轮未运行，也不得用本文数字作“更快/更省”的结论。
- **嘈杂环境**：其他代理并行编译与浏览器测试，1 分钟 load 在 5.9–74.9 间波动；每组记录了 load，但未做安静机器复测、未做显著性检验，n=3/4 只能看量级与离散程度。
- **启动**：非严格冷启动（未清文件缓存）；只测到窗口出现和 AX 可见按钮，未测首帧绘制或首次可交互输入。
- **资源**：RSS 为相加上界；未测 phys_footprint、能耗、长时间运行、大量 scrollback 后的内存或多会话；窗口前后台/遮挡状态未受控。
- **平台**：仅本机 macOS arm64；Linux/Windows 未测（Windows ConPTY 只在 CI 上验证了 cmd.exe 的生命周期，没有做性能测量）。release 包为 ad-hoc 签名、未公证，不代表发行验收。
- 本文只新增测量脚本与文档，未改生产代码；readiness 仍默认关闭。

## 原始数据位置（本地、已被 `.gitignore` 忽略，不随 Git 发布）

- `.artifacts/p0/perf-baseline/rust-{debug,release}/`：二进制副本、`meta.txt`、每次运行的输出、`/usr/bin/time -l` 与 load。
- `.artifacts/p0/perf-baseline/app-release/`：`bundle.txt`、`app-set1..4.jsonl`、`app-resources-extra.jsonl`、`first-launch.jsonl`，以及各组控制台日志。
- `.artifacts/p0/perf-baseline/ssh-loopback/`：每次测试输出、time 与 load。
- `apps/desktop/test-results/perf/xterm-perf.jsonl`（另有一次未计入的 1 轮试跑 `xterm-perf-trial.jsonl`）与 Playwright JSON 报告。
