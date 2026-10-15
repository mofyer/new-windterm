# P0 最小原生验证：执行状态

日期：2026-10-15。实现及应用二进制与[首轮原生报告](NATIVE_ACCEPTANCE_2026-10-15.zh-CN.md)相同。本轮在收尾边界批准后补资源归属与有界前台测试。**前台负载和真实 VoiceOver 结果尚待用户操作回传，不能据本文关闭决策包 2。**

## 已完成：包含 WebKit 的归属采样

协调者通过 CUA 启动自己的测试应用，主 PID `36556`，打开 Local 2。采样复用仓库 `tests/perf/app-launch.swift` 中的归属方法，仅抽取只读进程查询，不执行其中的启动、AX 或退出逻辑：`responsibility_get_pid_responsible_for_pid(pid) == appPID`，另含主进程本身。没有将系统所有 WebKit 进程求和。

本地原始数据在 ignored `.artifacts/p0/closeout-20261015/resources.jsonl`：180 个样本，Unix 时间 `1792049872.889635` 至 `1792050074.870276`，跨度约 202 秒。该段测试负载尚未启动，没有前台状态确认，作为空闲观察，不作为输出性能数据。

| RSS（KiB） | 首样本 | 样本峰值 | 末样本 |
| --- | ---: | ---: | ---: |
| 主应用及归属辅助进程合计 | 258960 | 259040 | 226096 |
| 其中 WebKit GPU/WebContent/Networking | 91728 | 91808 | 70320 |

归属集合还包含应用启动的本地 zsh，以及 SetStoreUpdateService、audio SandboxHelper、ThemeWidgetControlViewService、SafariPlatformSupport.Helper。逐样本保存 PID、responsible PID、进程 basename 和 RSS；未记录命令参数或用户内容。该系统内部归属接口仅是本机观测工具，不能推广为跨版本稳定 API。

RSS 合计可能重复共享页，不是物理 footprint；采样间隔目标为一秒，另有查询开销。没有据此声明内存预算、泄漏或前台流畅度通过。这一结果补齐首轮仅看主进程的边界，并证明本机能够取得限定归属的 WebKit 资源数据。

## 已准备：一次有界前台负载

应用 Local 2 已填入 `/usr/bin/perl /tmp/new-windterm-closeout-20261015.pl`，尚未由协调者按回车。用户被请求将窗口置前台后执行，并在完成后做最小读屏检查。

- 负载为 256 块，每块 64 行、每行 78 个 ASCII `x` 加 CRLF，总 payload **1,310,720 字节**；每块间隔目标 20 ms，20 秒 alarm 上限。
- 自然结束打印 `P0_FIXED_DONE payload=1310720`、12 条 `P0_SEQ_01` 至 `P0_SEQ_12` 和 `P0_VO_HELLO`，随后恢复 shell 提示符。
- `/tmp/new-windterm-closeout-20261015-phases.txt` 记录生成器 start / generator_done / end 或 interrupted / timeout 的时间；这些是生成器阶段，不等于屏幕绘制完成时间。
- `.artifacts/p0/closeout-20261015/sample-load.swift` 只读采样应用归属进程，等待阶段文件的监听有 10 分钟上限；触发后取 30 个样本。超过等待上限或没有覆盖负载，下一次执行前须重新准备采样，不能把空闲样本当负载样本。
- 12 条可见编号行可作有限顺序读回；末尾 marker 不证明中间全部 1.25 MiB 在 xterm 中逐字节完整。输入方向的 1 MiB 字节匹配仍引用首轮证据，不能混成输出方向完整性结论。

中断后续做时再次核对：阶段文件尚未生成，也没有负载采样文件；原监听工具会话已不可用，未取得其退出码，不能认定已捕获负载。下一次短测前须重新准备采样。实际前台输出、结束恢复、负载资源及 VoiceOver 可达/朗读结果保留待回填。协调者没有通过自动化启用 VoiceOver；用户被请求测完恢复。AX 中存在终端文本不能替代真实朗读。

## 有界结论与剩余动作

当前只能确认现有 WKWebView/PTY 路径有有限正向输入证据，且可取得应用关联资源；仍缺这一次明确前台条件的负载与最小朗读结果。复杂字符字形与后台截图差异保留在首轮报告，不新增完整 Unicode 调查。

回传后只补一轮结果与路线判断：可继续、需调整或证据不足。完整输入法、读屏、VT、长期压力按已批准方案留对应交付前验收；P0 最终出口另行评审。
