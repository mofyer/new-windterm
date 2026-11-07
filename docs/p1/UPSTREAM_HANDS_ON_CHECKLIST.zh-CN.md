# 上游 WindTerm 2.7.0 实机核对清单（P1）

用途：汇总 P1 各切片中“先上游实测再定”的项，供一次 CUA 实机核对使用。依据 2026-11-07 两组用户决定（见 [执行记录](RESULTS.zh-CN.md)）：核对须用户在场；在隔离副本中运行上游（沿用 2026-10-12 的授权方式，见 `docs/p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md` 决定记录）；临时修改的上游偏好设置在结束后恢复；只记录行为观察，不复制上游代码、图标、音频或二进制。本清单只列核对项，**尚未执行**；每项的“当前实现”以对应预案为准。

| 来源 | 核对项 | 当前实现 / 待定内容 | 预案 |
| --- | --- | --- | --- |
| T27 响铃 | `bellStyle` 取值与默认样式、间隔单位与节流起点、静音时的标签提示、窗口级提示等 7 项 | 默认视觉提示；按会话节流，默认 2 秒 | [响铃方案](TERMINAL_BELL_PLAN.zh-CN.md) 第 1.2 节 |
| T32 清屏与复位 | 6 个动作的实际效果；备用屏中“清除回滚”；Windows/Linux 快捷键（上游 Ctrl+L 与 Shell `^L` 的关系） | 6 个本地写入动作；仅 macOS Cmd+L / Cmd+Shift+L | [清屏复位方案](CLEAR_RESET_PLAN.zh-CN.md) |
| 启动后执行命令 | 发送时机、多行、重开 / 重连、延迟设置 | 单行、`pty_open` 后入队一次、重开再发并提示、不提供延迟 | [启动命令预案](STARTUP_COMMAND_PLAN.zh-CN.md) 第 9 节 Q5 |
| T33 编码 | Hexadecimal 的语义；自动检测行为 | 未实现，待实测后定 | [会话字符编码设计](SESSION_ENCODING_PLAN.zh-CN.md) 第 15 节 |
| T31 键盘 | `backspaceKey` / `deleteKey` / `altModifierKey` / `metaModifierKey` 的 0/1 取值对应；初始 LNM 下回车是否发 CR LF；应用小键盘编码；Alt/Meta “8 位字符”的字节语义；`formatOtherKeys` / modifyOtherKeys | 已交付退格、删除、macOS Option 作 Meta、初始 DECCKM | [键盘与初始模式方案](KEYBOARD_MODES_PLAN.zh-CN.md) 第 8 节 |
| 历史视图与搜索 | 查找界面（FindPane）的快捷键、Find All 与上下文预览、大小写 / 方向 / 命中上限默认值 | 覆盖面板、纯文本搜索、快照 | [历史视图方案](HISTORY_VIEW_PLAN.zh-CN.md) 第 14 节 |
