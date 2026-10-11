# tmux 控制模式概念验证（T22）

日期：2026-10-11。对端：tmux 3.6b（Homebrew，macOS arm64）。状态：**协议解析与模型通过真实 tmux 验证；未接入终端界面，不代表 T22 验收。**

## 要回答的问题

FEASIBILITY 指出“运行 tmux 不等于集成”：需要 control-mode 解析器、窗格/窗口 ID 模型、布局同步，并先验证分包、转义、事件与命令响应交错。

## 结论

**可行。** Rust 模块 [`tmux_control.rs`](../../apps/desktop/src-tauri/src/tmux_control.rs) 把 `tmux -C`（或 `-CC` 的 DCS 包装）字节流解析为事件，不依赖 tmux 进程本身，可运行在本地 PTY 或 SSH 通道上：

- 命令响应：`%begin … %end/%error` 块，带命令编号和“来自本客户端”标记，按发送顺序对应；错误命令得到 `ok: false` 与 tmux 的错误文本。
- 窗格输出：`%output %<id>` 按 tmux 规则解码（仅小于 0x20 的字节与反斜杠以 `\ooo` 转义，UTF-8 原样），得到可直接写入对应 xterm 的原始字节。
- 通知：窗口新增/关闭/重命名（含中文名）、布局变化、活动窗格、会话变化、`%exit`；未建模的通知保留为 `Other` 以便诊断。
- 布局：解析 `校验和,宽x高,x,y{…}/[…]` 嵌套结构，校验 tmux 的 16 位校验和，可列出每个窗格的位置和尺寸。
- 边界：单行 ≤ 1 MiB、单个响应 ≤ 65,536 行，超限报错；任意分块方式（包括逐字节）解析结果一致。

## 实测

| 检查 | 结果 |
| --- | --- |
| 单元：真实 tmux 输出样本 | 在每个可能的切分点切成两块、以及逐字节输入，事件序列都与整块输入一致 |
| 单元：布局与转义 | 嵌套布局、校验和错误、截断布局、非法八进制转义、超长行、非法窗格 ID 均按预期处理 |
| 集成：真实 tmux 3.6b（私有 socket、`-f /dev/null`、受控 `/bin/sh`） | 中文窗口重命名、左右分屏后布局含 2 个窗格且窗格归属正确、`display-message` 响应、错误命令响应；新窗格输出的 TAB、反斜杠、中文字节逐字节解码正确；键入 `echo P0_IN_$((6*7))` 后收到 `P0_IN_42`；`kill-server` 后收到 `%exit`；无残留进程与 socket |
| 反向验证 | 把期望改为 `P0_IN_43` 时测试在期限处失败，证明断言有效 |

## 约束与未完成

- 还没有界面：每个窗格映射到一个 xterm、窗口映射到标签/分屏、输入经 `send-keys` 回写、尺寸经 `refresh-client -C` 同步，都待实现。
- 未覆盖 `%pause/%continue` 流控（`refresh-client -f pause-after`）、`%extended-output`、断开重连与多会话切换。
- 上游 WindTerm 2.7.0 的 tmux 集成行为（以及不支持嵌套、Sender Pane、Sync Input 组合的限制）需实机对照。
- Linux CI 若安装了 tmux 会运行该集成测试，否则跳过；Windows 跳过。

## 复核

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features --lib tmux_control
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features --test tmux_control
```
