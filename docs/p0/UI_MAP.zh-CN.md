# P0 界面原型：入口与验收清单

日期：2026-10-11。范围是可交互原型、本地 PTY、交互 SSH 入口与固定命令验证入口，不是 130 项完整功能验收。功能矩阵仍是完整重构的目标；下列映射不改变其状态。

## 运行

```sh
cd apps/desktop
npm ci
npm run dev          # http://127.0.0.1:1420，演示终端
npm run tauri dev    # 桌面窗口，可点击「本地终端」启动本机 shell
npm run build        # TypeScript 严格检查与前端打包
```

纯 TypeScript、CSS 与 xterm.js，不加载 CDN、远程字体或远程脚本。版本固定在 package.json 与 package-lock.json。前端使用本机 Avenir Next / PingFang SC 字体回退（14px 默认基准），终端使用 SFMono-Regular / Menlo 等宽字体（14px）；不从网络下载字体。

## 新版布局

Silver Soft UI 方向参考用户指定的 Health & Wellness 示例与“干净通透、层次与圆角”补充：默认 62px 浮起工具栏，距窗口边缘20px；232px银白会话卡片与纯白终端面板之间相隔22px。主面板/侧栏/工具栏24px圆角，采用明确右下灰紫投影与左上白高光。文件检查器为内部17px圆角卡片，传输队列独立浮起，底部保留原型说明。连接表单为24px圆角sheet，输入框内凹。绿色只用于选择和主动作，不铺满画布。1000×650自动采用54px工具栏、12px外距和198px侧栏；紧凑模式仍可选。设计规范见 [DESIGN_SYSTEM.zh-CN.md](DESIGN_SYSTEM.zh-CN.md)。

## 已实现的原型行为

| 原型入口 | 对应目标 ID | 交互范围 | 键盘路径 |
| --- | --- | --- | --- |
| 会话侧栏、顶部侧栏按钮 | S02、S11、G09 | 会话筛选、选择、折叠侧栏；尚无持久化分组 | Tab 到按钮或筛选框；命令面板可切换 |
| 新建连接 | S01、C01、C11、C12 | 表单校验；固定模拟指纹；确认仅打开演示会话，不读取凭据、不连网络、不保存信任 | Tab 浏览输入；Enter 提交；Esc 取消 |
| 真实 SSH 验证 | C01、C11、C12 | 独立桌面入口；实际指纹、本次或保存的信任（变化即阻断，需独立替换）、未加密 Ed25519 测试密钥与固定 `fixture-check`；不创建交互终端 | 新建连接内「打开真实 SSH 验证」或命令面板；Tab、Enter、Esc 取消 |
| 真实 SSH 终端 | C01、C09、C11、C12、T01、S08 | 独立桌面入口；实际指纹、本次或保存的信任；私钥（可带口令）、密码或 SSH agent 认证与交互 shell | 新建连接内「打开真实 SSH 终端」或命令面板；信任后进入 SSH 标签 |
| 只读 SFTP 文件浏览 | F01 | 独立桌面入口；实际指纹确认后在文件面板列目录、查看类型/大小/权限/修改时间、解析符号链接、预览不超过 64 KiB 的 UTF-8 文本或十六进制；加载可取消，授权失效时要求重新核对指纹。写操作原型（F02–F07，见 [SFTP_WRITE](SFTP_WRITE.zh-CN.md)）：下载到本机“下载”文件夹，不覆盖已有文件；「允许写入…」确认后可新建目录、新建空文件、上传、重命名、修改权限和删除，删除、覆盖、修改权限逐项确认，不递归删除；未在原生窗口验收 | 文件面板内「只读连接 SFTP」或命令面板；Tab 到条目，Enter 选中，再用「打开目录」「预览前 64 KiB」「下载到“下载”文件夹」；写入工具在「允许写入…」之后出现，对话框 Esc 取消 |
| 本地终端 | T01、G10 | 桌面构建通过 Rust PTY 启动本机 shell；浏览器明确提示不可用 | Tab 到按钮或命令面板 |
| 标签页与关闭按钮 | G26、G27、S08 | 标签切换、逐个关闭；关闭真实会话失败保留标签并报告错误 | Tab 选中标签或关闭按钮 |
| 分屏按钮 | G18 | 并排显示当前与另一个已有会话；不足两会话时新增演示；每实例独立 xterm | 命令面板「切换分屏」；Tab 切换焦点 |
| 文件面板 | F01、F13、G09 | 固定演示文件、选择与属性显示；无真实目录读取 | 命令面板打开；Tab 选择文件 |
| 模拟下载、传输队列 | F02、F03、F21 | 显式模拟进度、取消、模拟断线、结束（无文件落盘）；最多保留 8 项 | Tab 到对应动作；队列可折叠 |
| 外观选择 | G24、G19 | 浅色（首次默认）、深色、跟随系统；仅外观偏好保存在 localStorage | Tab 到原生 select，方向键切换 |
| 紧凑布局 | G04、G18 | 缩小外部布局间距与侧栏；尚非上游 Focus 模式完整实现 | 命令面板或侧栏按钮 |
| 命令面板 | G07 | 搜索已实现入口、方向键选择、Enter 执行、Esc 关闭 | macOS ⌘K；跨平台 Ctrl+Shift+K |
| 字符与颜色样本 | T12—T16、T18 | CJK、emoji、组合字符、ANSI、24 位颜色；UTF-8 刻意每 3 字节切块写入 | 演示终端 `sample` 或按钮 |
| 持续输出样本 | Q05、Q06 | 20,000 行有限演示；每块等待 xterm.write callback；Ctrl-C 中止 | 演示终端 `stress` 或按钮 |
| 查看边界 | 全部 | 清楚区分原型、模拟、真实本机行为和未验收能力 | 底部「查看边界」或命令面板 |

首次默认浅色包含工具栏、侧栏和纯白终端；深色主题采用中性炭灰三级明度、最深终端与低饱和青灰强调色。「跟随系统」可选且持久化。完整产品默认策略待用户确认。分屏、标签、文件与连接配置暂不持久化。

## 字节流与生命周期

- xterm.js 是唯一实时终端状态；Rust 仅转发原始字节、管理 PTY。
- 所有工作区实例通过 `src/terminal.ts` 统一启用官方 `@xterm/addon-unicode11@0.9.0` 的 Unicode 11 宽度表。xterm 6 默认 Unicode 6 会把 `🌏` 算为 1 列，与本机 shell 常见的 2 列回显冲突；该修复使用 xterm 标为实验性的 Unicode provider API，依赖升级需重跑宽度回归。它不等于 Unicode 13、较新 emoji / ZWJ 序列或中文输入法已验收。
- `pty_open({onEvent, cols, rows}) → {id}`；Channel 事件使用 `kind: data | exit | error`。
- `data` 经 `Utf8Boundary` 暂留块尾未完整的 UTF-8 序列（最多 3 字节，拼到下一块前面）后传入 `xterm.write(Uint8Array, callback)`，仍不逐块 UTF-8 解码；这是对 xterm.js 6.0.0 拆分解码缺陷的规避，见 [INPUT_PATHS](INPUT_PATHS.zh-CN.md)；callback 后通过每会话 Promise 链顺序提交 `pty_ack({id,sequence})`。
- 文本输入按 UTF-8 编码；二进制鼠标输入按单字节传递；大输入每 4096 字节串行提交 `pty_write`，同一时间只有一个写入在途；后端队列满时退避重发同一块；前端未完成输入总量限制为 16 MiB，超额的单次输入整体拒绝并提示。粘贴先去除 HT/LF/CR 以外的 C0、DEL 与 C1 控制字符。
- ResizeObserver 调用 FitAddon，xterm resize 事件调用 `pty_resize`。隐藏标签不进行无效 fit，恢复时重算尺寸。
- 会话关闭释放 ResizeObserver、xterm、输出任务并调用 `pty_close`。打开途中关闭的会话在取得 PTY ID 后立即关闭；退出事件先于 open 返回时不恢复为运行状态。
- SSH 使用相同的原始字节、4096 字节输入分块、16 MiB 前端输入积压上限（后端 16 × 4 KiB 有界队列满时退避重发）、串行 ACK 与 resize 路径，命令为 `ssh_open/write/resize/ack/close`。`ssh_open` 必须携带窗口作用域、一次性挑战和操作 ID；先同步预留标签，再将挑战所有权移交给该标签。满 8 个会话时不消耗挑战。
- SSH 打开中关闭先取消操作；迟到的 open ID 再幂等 close。退出或致命错误先于 open 返回时不恢复运行状态；致命错误禁用输入。正常关闭或取消失败保留标签以便重试。页面离开关闭已建立会话、取消仍在打开的操作；原生页面重载清理仍由后端负责。
- 原型最多打开 8 个会话，xterm 滚动历史明确限制为 5,000 行；这不是无限历史或动态压缩实现。
- Ctrl-C 不被全局快捷键拦截；⌘K / Ctrl+Shift+K 在 xterm 自定义键盘处理器中让给命令面板。
- 标签和用户输入均用 textContent 写入 UI。固定 SVG 和模板不拼入不可信输入；不接入 OSC 剪贴板或自动打开链接。

## SSH 指纹确认与两条入口

`src/ssh-verification.ts` 与普通演示连接流程分离，复用指纹确认窗口，但终端与固定命令入口各自明确标识用途。桌面入口准备窗口作用域后才能提交；输入主机、端口、用户名和临时私钥路径，先获取真实指纹，尚未认证。固定命令入口中，用户明确选择「仅本次信任并验证」后，后端重新连接并固定校验主机密钥、认证和执行 `fixture-check`。路径不保存、私钥不进入前端，信任不写 known_hosts。

交互终端入口中，用户选择「仅本次信任并打开终端」后，在 SSH 标签中等待认证与 shell 创建；窗口立即清除私钥路径和表单，取消操作由该标签负责。标题、主机与状态使用文本写入，不将远端文本拼入 HTML。真实 SSH 标签禁用演示字符/输出样本。只读 SFTP 由文件面板独立入口建立，与终端标签不共享连接；远端文件名、路径和预览内容均以文本写入。

关闭、Esc、取消、拒绝、过期和页面离开清理当前操作/挑战；晚到结果不得重新打开窗口。stdout/stderr 以文本显示，原始字节可展开为 hex，退出码 7 作为命令结果显示而非一概认定连接失败。纯浏览器禁用真实验证并说明桌面要求。浏览器契约已独立验收；Rust/原生端到端状态见 [RESULTS](RESULTS.zh-CN.md)，详细协议范围见 [SSH_CLIENT](SSH_CLIENT.zh-CN.md)。

## QA inventory

以下为复核步骤，执行结果由父任务的验收证据单独记录；不能把本表当作已通过报告。

| 检查 | 操作与期望 |
| --- | --- |
| 首屏与尺寸 | 1440×900、1280×800 打开；工具栏、终端、状态栏完整可见，无横向溢出；窄窗口保留专业桌面最小宽度约束 |
| 外观 | 浅、深、跟随系统切换；重载后偏好恢复；终端前背景同步变化 |
| 焦点 | Tab 触达可见按钮；焦点轮廓清晰；对话框 Esc 后返回活动终端 |
| 命令面板 | ⌘K / Ctrl+Shift+K 打开、筛选、↑↓、Enter；Ctrl-C 不打开面板 |
| 会话生命周期 | 新建 8 会话后明确限制；关闭一会话后能再次新建；分屏焦点切换与关闭无错位 |
| 连接演示 | 修改名称与主机、端口超范围校验、拒绝确认、确认；不存在密码字段，未进行 SSH 连接 |
| SSH 交互终端 | 显式信任前不认证；原始跨块 UTF-8、顺序 ACK、输入分块/限额、resize、打开中取消、迟到 open、提前退出/致命错误、关闭失败重试与页面离开；真实对端另行验收 |
| SSH 固定命令验证 | 浏览器禁用；桌面准备失败、检查、指纹确认/拒绝、过期、取消、晚到结果、错误重试与退出输出；真实对端另行验收 |
| 文件与传输演示 | 选择中文文件、模拟下载、取消、模拟失败、结束；每处均保留模拟标识且不误报真实传输成功 |
| 字节与字体 | sample 的中文、emoji、组合字符；字符跨块输出不产生 UTF-8 替换字符；列宽与 IME 仍需真实设备验收 |
| 输出与取消 | stress 输出中 Ctrl-C，中止后可继续输入；结束时间仅为该次渲染样本耗时，不作为生产吞吐结论 |
| PTY 桌面 | 点击本地终端、真实 shell 交互、窗口 resize、Ctrl-C、exit、关闭重开；浏览器版本只提示桌面运行方式 |
| 特殊偏好 | prefers-reduced-motion 禁用提示动画；减少透明度禁用 backdrop blur；增强对比度提高边线和次要文字对比 |
| 资源清理 | 重复打开/关闭；Rust 会话与 shell 进程释放需后端实测，不仅依赖 UI 消失 |

## 未覆盖

没有实现 SFTP 写操作与下载落盘、RSA 私钥与 keyboard-interactive、长期凭据保存与自动登录、已保存主机的管理界面、恢复/同步输入、tmux 集成、大规模历史/压缩、终端搜索与完整 VT 方言兼容。交互 SSH 与固定命令验证都只是完整 SSH 能力的一部分；浏览器 IPC 契约不等于真实网络、终端兼容性或跨平台桌面已验收。演示命令处理器仅用于确定性 UI 验证，不模拟完整 shell 编辑能力。中文输入法、VoiceOver、macOS 系统快捷键、Retina、多行粘贴安全策略与持久化恢复均需后续真实环境证据。

## API 依据

- [xterm.js Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/)：write(Uint8Array, callback)、onData、onBinary、onResize、dispose。
- 官方 Unicode 11 插件用法与版本依据：锁定安装包 `node_modules/@xterm/addon-unicode11/README.md`、`src/Unicode11Addon.ts`；默认宽度依据：`@xterm/xterm/src/common/input/UnicodeV6.ts` 与 `src/common/services/UnicodeService.ts`。
- [xterm.js 流控说明](https://xtermjs.org/docs/guides/flowcontrol/)：解析完成回调与生产者节流。
- [Tauri Channel](https://v2.tauri.app/develop/calling-frontend/#channels)：Rust 到前端流式消息。
- 锁定依赖的实际 `.d.ts` 随 npm install 获得，TypeScript 构建校验接口；网页示例不代替锁定版本检查。
