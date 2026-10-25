# ConPTY frame 诊断真实构建准备与一次验证预注册

本轮仅补独立诊断的真实前端构建准备，不修改产品、Rust bin、frame parser、旧 wrapper、Cargo feature 或既定门限。旧运行 `40161857832` 在准确 SHA `b0ee3324ead6f18f243ab949837dde43fa0af86f` 两平台均 `tests-failed/exit 101`、`build=null/samples=[]`，没有运行 worker；其失败结论保留。内容受限工件不能区分当时的编译或断言错误，下述本机证据不能冒称已确定 Windows 历史失败原因。

## 本机证据与修复范围

同一 `b0ee332` 的干净 worktree 在无 `apps/desktop/dist`、无 `TAURI_CONFIG` 覆盖的条件下，以 Rust 1.99.0 执行 `cargo check --locked --all-features`，得到 exit 101 和固定 `frontend-dist-missing` 构建输入错误。`--all-features` 启用 Tauri `custom-protocol`，需要真实前端产物；旧 framed workflow 没有执行前端构建，而之前的本机审查 worktree 有 dist，因此本机通过没有覆盖缺构建输入的情况。

负向为 check、正向为 test，并非同一命令的红绿回归。独立正向对照仍为准确 `b0ee332`，初始无 dist/无 `TAURI_CONFIG`，Node 26.0.0、npm 12.0.2、Rust 1.99.0；真实 `npm ci` 与 `npm run build` 均 exit 0，后者执行固定 `tsc --noEmit && vite build`，生成真实 `dist/index.html`。随后原 `cargo test --locked --all-features --bin powershell_conpty_qualified_probe` 为 **55 passed / 0 failed / 0 ignored**，tracked 文件未改。内容受限本机记录为 `/tmp/p1-frame-assets-positive-evidence.json`，不上传为 Windows 证据。此对照支持修复已复现的构建输入缺失，不证明此前 Windows run 的唯一根因。

本轮保留 `--locked --all-features`，不通过减少 feature、伪造 index.html、TAURI_CONFIG 覆盖或已有 dist 缓存绕过构建。测试失败分类 collector 草案未纳入交付。

## 新 wrapper 与准备规则

新增 `conpty-framed-prepared-report.mjs`。准备前检查 dist：只有明确不存在才继续，已有文件/目录、软链或其他文件系统错误都保守失败，不删除用户文件。通过当前 Node 安装目录的固定候选寻找 npm，验证 package name=`npm`、bin=`bin/npm-cli.js`、canonical CLI 位于 canonical package 路径且为普通文件；Windows 使用 node 同目录的 node_modules/npm，标准 Node Unix 布局使用相邻 lib；不扩展 Homebrew 等其他安装布局。路径只留内存，不使用 PATH/env 发现、不调用 shell 或 npm.cmd。

使用 `process.execPath` 执行已验证 npm-cli.js，依次运行固定 `--logs-max=0 --prefix apps/desktop ci`、`--logs-max=0 --prefix apps/desktop run build`。`--logs-max=0` 禁用 npm 自身 debug 日志落盘，不上传或保留 npm 原文日志。真实 npm 输出只由已有有界 process runner 在内存计数并丢弃，不写日志或工件，也不要求 npm stderr 为空。两个步骤共享 **180 秒** deadline，解析和准备后检查耗时也计入；任一步失败、超时或未确认退出/资源释放立即停止。成功 build 后只接受非软链的 dist 目录及非空普通 `dist/index.html` 文件，超时检查后才调用原 framed runner。准备失败不调用 Cargo 或 PowerShell worker。

原 runner 的 Cargo 测试/构建共享 **14 分钟**、每 worker 外层 **45 秒**、每平台最多两个顺序 worker、首失败停止保持；5 秒启动双确认、500 ms 退出 ACK+child exit、4.5/5 秒 cleanup 与 frame/隐私边界按[原 frame 预注册](CONPTY_FRAMED_PLAN.zh-CN.md)不变。本轮新 wrapper 复用原 runner，不重写嵌套测量或放宽旧规则。

## 固定报告和预算

新工件只含 schema version 1、mode=`startup-framed-prepared` 的固定顶层：`version, mode, phase, status, failure, preparation, diagnostic, diagnosticPassed`。phase 仅 `preparation/diagnostic/done`。preparation 固定为 `dependencyInstall, frontendBuild, distReady`；前两者为 null 或旧 runner 的固定 `exitCode/failure/outputBytes/cleanup` 进程结果。failure 仅 `dist-not-fresh/npm-unavailable/preparation-timeout/dependency-install-failed/frontend-build-failed/dist-missing/diagnostic-failed` 或 null。

`diagnostic` 初始为 null，准备成功后嵌套原 schema 1/mode `startup-framed` 的完整原报告；嵌套 `startupSuccess/experimentComplete/diagnosticPassed`、samples、READY 写入字段、清理和失败语义完全不变。顶层通过只映射原诊断 `diagnosticPassed=true`，准备成功本身不代表启动成功。每一步更新固定工件；不落 nonce、命令/编译/断言原文、路径或环境值。

job 仍硬限 **20 分钟**。准备 3 分钟 + Cargo 14 分钟 + 两 worker 各 45 秒的名义总上限为 18.5 分钟；工具链安装、checkout/helper、调度与终止清理另占时间，因此剩余余量有限，不能称 18.5 分钟是整个 job 上限，也不保证最慢边界组合能完成。若 job 被取消或上传缺失，保留未完成状态，不追加重跑。

## 一次执行与停止条件

先完成新 wrapper 有意义的 Node 测试、固定准备调用验证、上述真实干净正反对照以及独立审查。实现、测试、本计划先 `[skip ci]` 提交推送；新 prepared workflow 单独提交，触发路径仅新 wrapper/test/workflow，避免旧 framed workflow再次运行。

只有协调者批准本轮冻结 SHA 后，在 `windows-2022/windows-2025` 各执行一次准备和原诊断：每平台最多两个 worker，前置或采样首失败即止，不补样本、不 retry、不混入目录查询或环境矩阵。只上传 `.artifacts/p1/powershell-conpty-framed-prepared/report.json`，准确 SHA/run/状态和报告需独立读回。若再次在 Cargo 前置步骤失败，保持未知原因并另立最小取证，不临时追加 55 名称 collector 或原始日志。

新结果不重判旧运行，不证明 PowerShell 独立 stderr 为空或首次目录查询问题已解决，不改产品白名单、普通原生查询或 30 秒门禁。P1/第四批未验收，P2 仅准备，main 不合并。
