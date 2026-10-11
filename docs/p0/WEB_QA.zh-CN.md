# P0 浏览器交互与终端探针验收

日期：2026-10-11。此报告是独立测试通道的实测结果，范围为浏览器原型；不代表原生 WKWebView、Rust PTY、真实 SSH/SFTP 或 117 项功能完成。

## 结果

- 命令：在 `apps/desktop` 下执行 `npx playwright test --config playwright.config.ts`。
- 重设计后最终完整执行：**70 passed，0 failed，0 skipped，0 flaky；18.5 秒**，未配置重试。`npm run build`（TypeScript 严格检查与 Vite 打包）也通过。
- 其中 **67 项交互/正向终端/前端 IPC 契约/响应/主题对比度及隔离 PoC 断言通过，2 项确认现有兼容缺口，1 项复现默认 Unicode6 旧列宽问题**。后面三项的通过表示反例被复现，绝不能计入对应功能完成数。
- 环境：macOS arm64，系统 Chrome `154.0.8037.99` headless；Playwright `1.64.0`，xterm.js `6.0.0`。
- 没有修改应用生产代码；对已有原型进行验收测试，不声称这组事后验收是 TDD 实现过程。
- 未采集代码覆盖率，不能由 70 项测试推算单元测试覆盖百分比。这是 E2E 专用套件；Rust 单元与集成测试另行记录。

独立审查发现 8 会话上限时主机确认按钮误报已打开会话；新增测试先复现失败，界面作者修复后最终完整回归已通过。重设计删除了旧营销标题与页脚，布局测试更新为新标签栏、终端工具栏和文件面板区域。兼容探针得到两个明确缺口，见下表。

## 可复现

先在独立终端启动开发服务器，再运行测试：

```sh
cd apps/desktop
npm ci
npm run dev
# 另一个终端，仍在 apps/desktop
npx playwright test --config playwright.config.ts
```

配置使用本机 Chrome channel；需要安装 Google Chrome。测试默认连接 `http://127.0.0.1:1420`，不会自动启动或停止已有服务。使用两个 worker，独立浏览器 context 隔离 localStorage。模拟传输使用 Playwright clock 驱动时间，不以延长 sleep 或失败重试掩盖不稳定。

## 可见控件与状态覆盖

| 入口 | 已执行状态/断言 | 限制 |
| --- | --- | --- |
| 外观选择 | light、dark、system 重载持久化；system 随系统颜色偏好变化 | 不等同真实系统设置应用或 Retina 色彩验收 |
| 紧凑布局 | 开/关、布局 padding 实际变化 | 视觉品质由独立截图复核 |
| 会话侧栏 | 折叠/恢复、名称筛选、无匹配、点击选择切换活动标签 | 暂无会话持久化 |
| 添加终端/侧栏加号 | 新建、8 会话上限、关闭后释放额度 | 演示会话 |
| 标签/关闭 | 分屏聚焦更新活动标签；关闭最后会话为空态；样本按钮禁用；重建恢复 | 未证明 Rust 子进程关闭 |
| 会话生命周期 | 重复创建/关闭观察器断开、xterm DOM 移除；持续输出中关闭后剩余终端可输入 | 未用堆快照证明所有内存释放 |
| 分屏 | 自动补第二会话、两面板可见、恢复单面板、焦点选择 | 不覆盖任意嵌套布局 |
| 命令面板 | 按钮与 Ctrl+Shift+K 打开、方向键/Enter 新建、搜索无匹配、无匹配 Enter、Esc 恢复焦点 | 未逐一执行全部命令别名；对应主控件另测。⌘K 原生全局键由桌面通道验收 |
| 本地终端 | 浏览器显示明确桌面要求，不伪造本机 PTY 会话 | 真正本地终端另测 |
| 字符与颜色样本 | xterm 屏读树包含中文/日文/emoji/组合字符、颜色文本、无替换字符；独立探针核验真彩 RGB | 程序写入字符不证明 IME 组合输入/字形视觉正确 |
| 持续输出 | Ctrl-C 中断，后续 pwd 可执行，接收计数停止增长 | 演示指令；不是生产吞吐或无限历史测试 |
| 新建连接 | 确认、拒绝、取消；端口空/0/65536 被阻止；空主机被阻止 | 主机名仅 required 校验，尚未验证合法 hostname/IP 语法或空白修整；无真实网络 |
| 主机身份模拟 | 确认创建演示会话、状态标明未连接；拒绝不增加会话；未写 known_hosts localStorage | 固定演示指纹，无真正 known_hosts 文件操作 |
| 不可信输入 | 主机/会话名含 img/onerror 字符串仍显示为文本，不产生 img 或脚本副作用 | 非完整安全审计 |
| 文件面板 | 开/关、中文文件选择、属性与文件匹配 | 不读本机或远端文件 |
| 模拟下载/队列 | 空队列提示、任务新增、取消与失败后进度保持、完成明确无文件落盘、折叠、8 项上限 | mock 时间，仅测试模拟状态机 |
| 查看边界 | 打开、返回按钮、关闭图标；文案说明 SSH/SFTP 未验收 | 无原生可访问性声明 |
| 网络边界 | 连接确认、传输、边界弹窗流程未发起非本地 HTTP 请求 | 观察覆盖该测试操作窗口；非系统级抓包 |
| 窗口布局 | 1000×650、1280×900、1440×900，在分屏和文件面板同时开启时，标题工具栏/侧栏/标签栏/终端工具栏/提示/终端/状态栏/队列/文件面板均在 viewport 内 | 测的是区域几何边界；不自动证明每处文字无省略 |

## 终端兼容实测

探针独立创建和销毁 xterm 实例，不依赖演示命令解析器。测试输入与结果作为 JSON attachment 写入报告。

| 探针 | 实际结果 | 判定 |
| --- | --- | --- |
| UTF-8 每 3 字节切块 | `中文 日本語 café é 👋 🌏` 完整恢复 | 此样本通过 |
| ANSI 真彩 `38;2;145;90;190m` | 单元格前景 RGB `0x915abe` | 此样本通过 |
| Alternate screen `?1049h/l` | 切到 alternate，返回恢复原缓冲 `X` | 此样本通过 |
| VT52 `ESC[?2l` 后 `ESCY!#X` | 期望写完 X 后零基 row=1、col=4；实际 row=0、col=3，第一行输出 `!#X` | **缺口已确认：该 VT52 切换/定位路径不兼容** |
| DECSCL 请求 VT200 前后查询 conformance | `DCS $ q " p ST` 前后均返回 `DCS 1 $ r 61 ; 1 " p ST`；安装的 xterm 源码也标注未支持 | **缺口已确认；primary DA 仅记录身份，不再用作 conformance 判据** |

这两条是具体序列的可重复证据，不能外推为所有 VT 方言全不支持，也不能因其测试为 green 就说 legacy terminal parity 通过。下一阶段需选择兼容层、替代终端内核或明确扩展 xterm；保留用户要求的完整功能目标。

## Unicode 列宽回归与 IPC 契约审查

父任务的 WKWebView 实机验收发现 🌏 命令回显错列。默认 xterm Unicode 6 在独立 baseline 中确实将 🌏 计为 1 列；当前应用工厂 `src/terminal.ts#createWorkspaceTerminal` 加载官方 Unicode11 addon。新增 6 项专项测试全部通过：

- 🌏、👋、中分别占 2 列；e + combining acute 占 1 列，同时断言 buffer cell width 与 cursorX。
- 模拟 shell 的 `A🌏BC` 后 `CSI 2 D` 再写 X，得到 `A🌏XC`；断言 🌏 在 col 1、X 在 col 3、尾部 C 在 col 4、光标在 col 4。
- 对未加载 addon 的默认实例保留反例，重现 🌏 width=1、重绘后 cursorX=3。该测试通过表示旧问题可复现，不是再增加一项功能兼容通过。

这些测试调用实际应用使用的终端工厂，验证终端缓冲位置，不只匹配字符串。仍不代表系统 IME 候选窗或所有现代 emoji/ZWJ 序列已经验收。

独立审查覆盖前端 open/close、晚到事件、已退出状态、ACK Promise 链、输入分块和错误处理。新增 5 项 stub IPC 契约测试全部通过：

1. 打开未完成时关闭会话，晚到的原生 ID 仍发出关闭请求。
2. exit 事件早于 open 返回时，不重新标为运行状态。
3. 原生关闭失败保留标签并允许重试。
4. xterm 解析完成后发送 ACK，并等待前一 ACK 完成才发下一条。
5. 5,000 字节合成 paste 按 4,096 / 904 分块，后一块等待前一次 IPC 完成。

此处使用测试注入的 IPC stub，未启动 shell，不能替代 Rust/Channel 序列化或真实 PTY 集成验收。合成 paste 也不构成系统剪贴板实测。审查确认的主机上限误报问题已有独立失败→修复→通过证据，最终全套包含这条回归。

## 最终白银浮层配色与正文对比度

最终版本按用户补充要求改为白色终端、银白浮层、24px 圆角和更明确的外留白/柔阴影，仅保留绿色控件强调。在此基础上新增的低色度深色版本，以及响应/watch 与隔离 VT52 实验，合并全套共 70 项通过；本次没有放宽布局/对比度断言。报告与 layout 截图已经刷新为此最终版本，旧版大片 mint 底色截图不作为本次证据。

检测读取实际 computed style，将透明背景逐层合成，并计入按钮 `filter: brightness(...)` 对文字与背景的影响。测试停用动画，避免把 theme 过渡帧误判为最终配色。每个测点均按普通正文标准 **4.5:1** 检查，未因字号较小或辅助说明降低阈值。

| 测点 | 浅色比值 | 深色比值 |
| --- | ---: | ---: |
| body 默认文字 | 11.486 | 13.793 |
| 底部运行提示 muted | 4.875 | 8.082 |
| 侧栏分类 muted | 4.674 | 7.199 |
| 已选会话文字 | 5.225 | 6.321 |
| 新建连接 CTA 文字（浅色白字/深色墨色字） | 4.792 | 8.006 |
| 连接弹窗说明 muted | 4.674 | 6.925 |
| 弹窗 primary 默认 | 6.054 | 8.006 |
| 弹窗 primary hover | 5.805 | 7.292 |

当前深色采用低色度灰黑表面与浅灰蓝控件，按钮改用墨色正文；以上是实际 computed style 实测值。旧 mint 版本的数值不作为当前深色验收证据。所有阈值保持不变。

此处是上述正文与主要控件色彩对比度验收，不是整套 WCAG 合规认证；不包含禁用按钮、图标/边框非文字对比度，也不要求用户程序自行指定的 ANSI/truecolor 输出全部满足 4.5。1000×650 的分屏加文件面板几何边界在此最终配色版本再次通过。

## 响应与开发构建隔离的独立复核

只读审查 `main.ts`、`responsiveness.ts` 和 `vite.config.ts`：没有发现阻塞本轮合并的实现缺陷。输出状态更新只调度一个 100 ms 计时器，ACK 和输入 Promise 链不等待该计时器；error/exit 同步刷新并取消待更新任务，后台输出不刷活动会话状态。输入、ACK 的原有串行、限额与关闭路径保留。

本次完整运行的响应场景完成 512 / 512 有序 ACK，最大 16 个未确认块；2,096,640 字节输入下仅尺寸/字节节点发生 3 次变化，另四控件无冗余写入。单次 Chrome stub 流耗时 333.1 ms，keydown→stub IPC 0.3 ms；不将它们外推为真实 WKWebView 改善。原生响应关卡仍按 [RESPONSIVENESS](RESPONSIVENESS.zh-CN.md) 保留未验收。

实际开发诊断 snapshot 为 **13 个数字字段**，文档数值已核对一致；没有输入、输出、路径或会话 ID。生产 build 后搜索诊断对象名、查询参数和全部 13 个字段名，共 15 个标记，全部未出现在发布 JS 中。watch 回归通过：受控 Rust target HTML 改动未产生相应 Vite reload 消息，也未改变页面加载计数。

VT52 独立 PoC 的 6 项和原始探针的 5 项随全套再次通过；PoC 没有接入实际应用/PTY。具体控制序列与未覆盖边界见 [TERMINAL_COMPAT](TERMINAL_COMPAT.zh-CN.md)。DECSCL 已采用前后 conformance 查询及源码判据，修正旧的仅用 primary DA 判断方式。

## 证据与未验收范围

- 测试源码：`apps/desktop/tests/e2e/workspace.spec.ts`、`terminal-probes.spec.ts`、`unicode-width.spec.ts`、`pty-ui-contract.spec.ts`、`contrast.spec.ts`、`responsiveness.spec.ts`、`dev-watch.spec.ts`、`vt52-compat.spec.ts`。
- 原始统计/探针 attachment：`apps/desktop/test-results/results.json`。
- 布局截图：`apps/desktop/test-results/layout-1000.png`、`layout-1280.png`、`layout-1440.png`。
- 最终深色工作台/弹窗预览：`docs/assets/p0-dark-workspace.png`、`docs/assets/p0-dark-connection.png`，1440×900，分屏与文件面板同时开启；均已查看。深色 1000×650 另核对全部主区域无越界，过程无 pageerror。
- `test-results/` 被忽略；重跑会覆盖，父任务可归档到 `.artifacts/p0/`。未将机器截图或原始本地运行目录提交仓库。

本轮独立原生通道已完成 WKWebView 中性灰主题下的真实 PTY 粘贴中文/emoji、尺寸与退出冒烟，见 [RESULTS](RESULTS.zh-CN.md)；CUA typeText 未送出 Unicode，不能将 paste 成功计作中文键盘或 IME 通过。仍需完整原生专项：输入法组合与候选窗、VoiceOver、Retina、全量 VT/ECMA 方言、高输出响应与资源、剪贴板安全、真实 SSH 信任与认证、SFTP 一致性及各平台发布签名。E2E headless 的通过不替代这些证据。
