# P1 执行记录

## 2026-10-15：第一批启动

从已合并的 `a35582f` 创建 `p1/integration`，按[计划](PLAN.zh-CN.md)推进本地终端失败/退出/重新打开。前端与原生场景在独立 worktree 并行；本批是 A1/A2 的局部交付，没有声称 P1 或 T01/T34 全项通过。

沿用 `.github/workflows/p0-cross-platform.yml` 的已有跨平台门禁。文件名保留以减少无关变化，P1 在自己的分支手动触发；执行证据须记录实际提交和作业结果，不复用 P0 结果冒充新代码验证。

## 第一批实现与评审

- `bd44492`（来源 `937ebb8`）：启动失败进入终态，清空早期输入队列；初次 resize 与启动错误分离，晚到错误不覆盖退出/销毁状态；结束态提示不再发送输入。
- 已退出/启动失败的本地终端提供“重新打开”，创建新的标签、PTY 和输入队列，旧输出保留；同步切换活动标签避免连续点击重复创建，不自动重放旧输入。
- `f8eeba2`（来源 `598e7c9`）：新增原生 `local-terminal-reopen` 场景，真实独立输出行→exit 7→新标签输出→新旧输出隔离→旧退出状态保留→关闭两个标签。测试不把输入回显当作命令执行结果。
- CI 路径过滤新增 `tests/native/**`，让后续单改原生场景也会触发 main/PR 检查；现有 P1 集成分支用手动 dispatch。

独立 code-reviewer 对前端三文件、原生场景、CI 与阶段文档给出 APPROVE，无阻塞发现；两个低优先级 CLAUDE 旧阶段/Windows 证据指向问题已修正。审查采用 TypeScript、Node 语法和文件链接检查；没有可调用 LSP/AST 工具，不声称运行这些工具。

TDD：原实现上原 6 项契约通过，新增用例中 4 项失败，复现终态/提示及晚到错误问题；实现后 12 项契约全过。测试边界仍是 IPC stub。

## 集成验证

| 门禁 | 本轮结果 | 边界 |
| --- | --- | --- |
| 前端 TypeScript / Vite build | 通过 | 不代表原生运行 |
| Rust fmt / Clippy all targets、all features | `13c9aee` 集成复验通过 | 生产入口保留全局容量池 |
| Rust all targets、all features | `13c9aee` 集成复验 210 passed / 0 failed / 33 ignored | 新增 1 项容量回归；ignored 不算通过 |
| Windows wincheck | 通过 | 只做类型检查，不是运行 |
| Native runner helper | 15 passed / 0 failed | 不代表新增原生场景已执行 |
| 浏览器全套 | 376 passed / 0 failed（2.2 分钟） | IPC stub；含 12 项本地生命周期契约 |
| 真实 OpenSSH 夹具 | 11 passed / 0 failed / 0 skipped | 受控本机夹具 |
| macOS 原生退出/重开 | 单轮通过，见[专题记录](NATIVE_LIFECYCLE_2026-10-15.zh-CN.md) | CUA 真实 WKWebView；不覆盖失败注入、完整 IME/读屏/VT |
| 跨平台 CI 与新增原生场景 | `ed6501d` 的首轮 run `38706436663` 已发现两个 Linux 失败，待修复复验 | 不记为通过，见下文 |

本轮不改变默认 Shell、启动参数、凭据、协议或终端屏幕状态来源；功能台账保持原状态。main 仍为 P0 关闭提交 `a35582f`，本批合并前需用户确认。

## 首轮 CI 发现与修复

[首轮 CI](https://github.com/mofyer/new-windterm/actions/runs/38706436663) 被测提交为 `ed6501d`。Linux 原生作业的前三个场景通过，新增第四个场景在标签名称比较处失败：WebDriver `getText` 返回空串，同一失败工件的 DOM JSON 和截图却显示 Local 4、Local 5 两个标签及新 Shell 提示符。失败发生在新会话输出与旧会话回看之前，因此不能据此宣布第四场景通过。

`09a0362`（来源 `5ddaa49`）将标签读回改为 DOM `textContent`，断言非空、旧标签位置与名称保持、新标签名称不同且已选中。真实输出、双向隔离、旧退出码和关闭检查全部保留；独立 code-reviewer APPROVE，Node 语法、helper 15/15 和 diff 检查通过，原生运行待下一轮 CI。

同轮 Linux desktop 的 `cancelled_reader_holds_capacity_until_blocking_work_really_ends` 在等待启动信号时出现 `RecvError`，Rust lib 结果 159 passed / 1 failed / 7 ignored；后续 lrzsz 等步骤未执行，不能算通过。测试先占用全局池的大部分许可，其他并发认证可能抢走最后一个许可；容量拒绝会丢弃未启动闭包，使通知接收端得到 `RecvError`。具体争用者无法从日志确定。

`13c9aee`（来源 `7eeb760`）保留生产 `KEY_READS` 全局池和原入口，将同一读取算法抽为接收容量池的内部函数；原测试使用独立池，继续验证取消后阻塞读取实际结束前不能释放容量。新增确定性满池回归验证上述错误链及另一个池的独立执行。定向 3/3、10 轮并发回归 30/30；独立 Rust reviewer APPROVE，check / fmt / Clippy / 全 Rust 测试 210 passed、33 ignored。

修复合入 `13c9aee` 后重新完成集成门禁：fmt、Clippy、Rust 210 passed / 33 ignored、wincheck、前端 build、浏览器 376 passed（2.2 分钟）、真实 OpenSSH 11 passed / 0 skipped。原生 helper 在 `09a0362` 上为 15/15，后续 Rust 修复没有改动原生脚本。日志保留在本机 ignored `.artifacts/p1/batch1/*-final.log`。跨平台修复复验仍待运行。

首轮最终为 5 个作业成功、2 个失败，整体失败。Windows 原生四个场景通过，独立复核 summary 与第四场景文本确认新旧输出隔离、退出码 7 保留、关闭后仅剩初始标签；Windows helper 为 14 passed / 1 skipped。Linux GSSAPI 3 个单元测试、四认证场景与三次新 cache 健康复验通过。macOS desktop 为 209 passed / 33 ignored，两种真实 PTY 探针通过；Windows 2022、2025 desktop 均为 203 passed / 7 ignored，另 2 项隔离 ConPTY 诊断通过。Server 2022 保留每轮一个句柄的系统基线增长，不代表零泄漏；Server 2025 该检查稳定。
