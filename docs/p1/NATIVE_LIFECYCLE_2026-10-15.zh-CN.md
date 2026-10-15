# P1 第一批 macOS 原生生命周期检查

日期：2026-10-15。被测提交 `ed6501df94d671c37d759f02dda9ba5bd32f9a02`；macOS 27.0.1（26A434）、Apple Silicon。通过 `npm run tauri build -- --debug --bundles app` 构建成功，Rust 构建阶段 11.54 秒。主程序 SHA-256：`5444985bbdf63123e4bfac9972dcad766a24c0ab602f1f00170c2163652648b6`。

应用显示名仍为 `New WindTerm P0.app`，这是本批未修改的包名，不代表仍在 P0。协调者先退出旧实例，再从本仓库 debug bundle 完整路径启动新包；通过 CUA 的窗口 Raise、点击和粘贴执行以下流程。所有命令仅在本项目自己的本地测试终端内运行。

| 步骤 | 实际观察 |
| --- | --- |
| 新建 Local 2，执行 `HISTFILE=/dev/null; HISTSIZE=0; printf 'P1_OLD_7f32\n'; exit 7` | 截图与 AX 都显示独立结果行 `P1_OLD_7f32`；状态为「已退出 · code 7」，说明为「本机 shell 已结束 / 不再发送输入」，恢复按钮可见 |
| 点击「重新打开本地终端」 | 标签数由 2 增至 3，Local 2 保留，新 Local 3 为活动标签；启动成功，恢复按钮隐藏 |
| 新会话执行 `HISTFILE=/dev/null; HISTSIZE=0; printf 'P1_NEW_91ab\n'` | 截图与 AX 显示独立结果行 `P1_NEW_91ab` 及提示符，无旧 marker |
| 切回 Local 2 | AX 保留旧结果及 code 7，没有新 marker；新旧会话输出隔离 |
| 向旧终端粘贴 `printf 'P1_ENDED_INPUT_MUST_NOT_RUN\n'` 并回车 | AX 树不变，仍为旧退出状态；只是 UI 观察，不是 IPC 或系统调用级字节审计 |
| 关闭 Local 3，再关闭 Local 2 | 标签数依次回到 2、1，仅剩 Getting started；随后 Cmd-Q 退出，CUA 返回 App quit |

截图在会话工具返回中可见，没有附加为仓库文件。构建日志在本地 ignored `.artifacts/p1/batch1/native-build.log`；未将本机临时工件当作公开附件。

结论：该轮支持 macOS 原生正常退出后新建恢复、旧输出保留及标签关闭路径。启动失败和 resize/exit 竞态通过浏览器 IPC 契约验证，本轮没有在原生环境注入这些失败；重复点击压力、持续负载、完整 IME/读屏/VT 仍未在本批原生复验。没有重新启用 VoiceOver或修改输入法。本次结果不代替 P1 整阶段验收。
