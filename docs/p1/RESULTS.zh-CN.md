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
| Rust fmt / Clippy all targets、all features | 通过 | Rust 产品代码未修改 |
| Rust all targets、all features | 209 passed / 0 failed / 33 ignored | ignored 不算通过 |
| Windows wincheck | 通过 | 只做类型检查，不是运行 |
| Native runner helper | 15 passed / 0 failed | 不代表新增原生场景已执行 |
| 浏览器全套 | 376 passed / 0 failed（2.2 分钟） | IPC stub；含 12 项本地生命周期契约 |
| 真实 OpenSSH 夹具 | 11 passed / 0 failed / 0 skipped | 受控本机夹具 |
| 跨平台 CI 与新增原生场景 | 待推送后执行 | Linux/Windows 真正结果另记 |

本轮不改变默认 Shell、启动参数、凭据、协议或终端屏幕状态来源；功能台账保持原状态。main 仍为 P0 关闭提交 `a35582f`，本批合并前需用户确认。
