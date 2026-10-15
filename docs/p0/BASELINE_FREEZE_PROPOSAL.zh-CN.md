# P0 功能基线冻结提议（2026-10-12 已决定）

日期：2026-10-11；2026-10-12 按其后合入的原型刷新证据索引（见 [(d)](#d-逐项-p0-证据汇总) 的“2026-10-12 刷新”）。状态：**已决定；功能基线已于 2026-10-12 冻结**。用户对 E1–E12 全部按建议作出决定，[baseline.json](baseline.json) 的 `scope_frozen` 已置为 `true`，见[决定记录](#决定记录2026-10-12)。本文原是 P0 出口交付物“冻结功能基线”的准备材料，整理冻结前必须由用户拍板的事项；(a)–(e) 节保留提议时的选项与理由，作为决定依据，并在各节补记决定。输入为[上游静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md)、三处台账（[功能矩阵](../FEATURE_PARITY.zh-CN.md)、[基线台账](BASELINE.zh-CN.md)、[baseline.json](baseline.json)）、[证据记录](BASELINE_EVIDENCE.zh-CN.md)和 [P0 结果](RESULTS.zh-CN.md)链接的各探针文档。

## 边界声明

- **冻结不改变任何一行的状态。** 决定后，三处台账按[决定记录](#决定记录2026-10-12)新增 31 个 ID（(b) 表中建议纳入的候选），改写 13 行的验收要点，更新 C14 的未测原因，并给 S08、F08、F09 加上对齐计数标记。原始 117 个 ID 与第二轮 13 个 ID 的名称、阶段与状态都没有改，没有删除任何 ID。提议阶段（2026-10-11 至决定前）本文不改动台账，“提议 ID”只是讨论编号。
- 提议阶段对三处台账只补充证据索引，即每个 ID 的静态复核结论和当前 P0 原型/探针记录的链接：两份 Markdown 台账各新增一列和一段指向静态复核发现的说明；JSON 在各行 `evidence` 数组末尾追加条目，并新增索引字段。能力名称、阶段、验收要点、状态与原有证据条目都没有改。2026-10-12 的刷新同样只改证据索引：为 30 个 ID 补充或更新 P0 链接、分组、证据层级与说明，没有改任何状态、ID 或能力名称。
- **静态证据不等于行为已验证。** 默认配置、菜单动作、翻译字符串和链接符号只说明发布包里有入口或代码引用。
- **P0 原型/探针不等于对齐通过。** “原型/探针”分组只表示有运行证据涉及该行至少一项验收要点。具体证据层级各不相同：
  - 浏览器测试使用 IPC stub；
  - loopback russh 或测试内服务器不等于真实 OpenSSH、telnetd 或网络设备；
  - 隔离 PoC 没有接入生产终端；
  - 原型都没有与 WindTerm 2.7.0 做实机对照。
- 本轮没有运行、挂载或复制上游应用，也没有读取用户 profile。所有“需实机确认”的事项都仍未确认。用户在 E1 中授权的实机盘点尚未开始。

## 决定记录（2026-10-12）

- **决定日期**：2026-10-12。
- **批准人**：用户（项目负责人）。
- **决定方式**：E1–E12 全部按本文建议采纳，逐项见 [(e)](#e-冻结前需要用户决定的事项) 末列。
- **冻结依据**：README 加上游静态证据（E1 选项 (ii)）。
- **冻结结果**：ID 集合从 130 项变为 161 项，`scope_frozen` 置为 `true`。原始 117 个 ID 与第二轮 13 个 ID 保留，没有删除任何 ID，**没有改变任何一行的状态**。

| 编号 | 决定 | 写入台账的改动 |
| --- | --- | --- |
| E1 | 采纳 (ii)：以 README 加静态证据冻结。同时授权 (i)：在隔离副本中实机盘点上游 WindTerm 2.7.0，条件为 x86_64 经 Rosetta 运行、使用隔离 profile、不读取用户数据 | 无。盘点结果以后按变更规则修订“待实测”行；授权记录见[证据记录](BASELINE_EVIDENCE.zh-CN.md#上游实机盘点授权e12026-10-12) |
| E2 | [a1](#a1-g13本地远程模式快捷键) 选项 B | G13 验收要点 |
| E3 | [a2](#a2-f08f09scp-是否属于-27-实际功能) 选项 B | F08、F09 验收要点前加“先确认上游 SCP 入口”一段；计数标记为“先确认上游是否存在” |
| E4 | [a3](#a3-q06unlimited与默认-999999-行) 选项 B | Q06 验收要点（A 的措辞加 B 的补充） |
| E5 | [a4](#a4-c14gssapi-已随发布包链接) 选项 A | C14 验收要点与未测原因。状态保持“待实测”：是否改为“未实现”没有决定。测试 Kerberos 领域在冻结后提供 |
| E6 | [a5](#a5-g02自动补全已有完整资源) 选项 A，并确认数据来源约束 | G02 验收要点，含“不复制上游命令定义文件” |
| E7 | [a6](#a6-其他需要同步决定的措辞) 的建议全部采纳 | S11、G17、G33、F21 验收要点 |
| E8 | [(b)](#b-36-项静态候选) 按建议采纳；编号不复用 | 新增 31 个 ID（ID 与能力名称同 (b) 表）；G43 不纳入，两点补入 T12、G12 验收要点；C23、C28、G54、G55 暂缓，不写入台账 |
| E9 | [c1](#c1-t14-unicode-13-与宽字符) 的措辞 | T14 验收要点 |
| E10 | [c2](#c2-s08-重启恢复布局) 选项 C，实机盘点后改为 A 或 B | S08 计数标记为“上游未证实”，暂不计入对齐完成率；验收要点不变 |
| E11 | 冻结后补做 Windows/Linux 上游包的只读静态核对 | 无；列为后续事项 |
| E12 | 批准[冻结的含义](#冻结的含义2026-10-12-已批准)中的变更规则；冻结日期 2026-10-12，由用户批准 | `scope_frozen` 置为 `true`；扩展[结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证) |

**新增的 31 个 ID**：

| 系列 | 数量 | ID 与能力名称 |
| --- | ---: | --- |
| C | 5 | C22 隧道管理器（独立对话框、与会话绑定、状态显示）；C24 SSH 算法、重协商与证书公钥类型配置；C25 主机指纹信任管理（信任/取消信任/查看）；C26 连接超时、保活与 TCP 选项；C27 应用级全局代理（无/系统/HTTP/SOCKS5，代理 DNS） |
| T | 5 | T30 远端读写剪贴板（OSC 52）权限；T31 终端键盘与初始模式设置；T32 终端清屏与复位；T33 其余会话字符集、十六进制显示与自动检测；T34 本地 Shell 会话启动参数 |
| F | 5 | F22 文件面板与终端当前目录同步；F23 远端文件用外部编辑器打开并回传；F24 文件面板辅助：新建链接、属性与权限编辑、复制路径/名称到终端、隐藏项；F25 传输队列暂停/恢复/移除与并发参数（F21 拆分）；F26 X/Y/Z Modem 冲突策略、填充与拖放协议（F21 拆分） |
| G | 12 | G41 触发器（全局/会话级）；G42 OneKey 凭据模板与登录向导（expect/send）；G44 命令级导航、选择、复制与命令历史存储；G45 会话颜色/图标与标签标题跟随远端；G46 标签栏行为与关闭确认；G47 多窗口与窗口管理器；G48 停靠窗格布局、栏显隐、工具栏定制与状态栏项；G49 Anything 面板、跳转行/符号/会话与计算器面板；G50 手动文本高亮标记（Text Marks）；G51 字体缩放与文本显示选项（行号、空白、行尾、缩进线、列标记）；G52 列/块选择与高级选择（锁定、拆分、反选、分词符）；G53 用户自定义动作/键位与配置目录 |
| S | 4 | S14 会话导入（OpenSSH config / PuTTY / Shell）；S15 地址栏快速连接与会话 URL；S16 断开/重连会话与回车重连；S17 重新打开已关闭视图与最近会话 |

新增行的写法沿用第二轮新增项：`scope_origin` 为 `baseline_freeze_2026_10_12`，`scope_classification` 为 `static_candidate`，证据为 `bundle_static_resource` 加一条指向[静态复核候选表](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id)的 `upstream_static_review`；状态为“未实现”，上游行为未测。阶段一律以 P0（上游实机盘点）开头，再接实现阶段。验收要点依据各候选的静态证据与 (b) 表的理由拟定。静态结论记为“支持”：(b) 的纳入标准（发布包有明确的菜单、动作、配置或字符串）与[静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md#证据类型与结论分类)对“支持”的定义一致。这仍然只是静态证据。

**不纳入与暂缓的候选**（编号保留，不复用；baseline.json 的 `baseline_freeze` 中有同样的列表）：

| 序号 | 编号 | 候选能力 | 处理 |
| --- | --- | --- | --- |
| 7 | G43 | 括号粘贴与大段发送确认 | 不纳入（并入）：括号粘贴补入 T12，大段发送确认补入 G12 |
| 5 | C23 | 内置 X Server（Windows VcXsrv 包装） | 暂缓：未核对 Windows 包；捆绑第三方 X Server 需单独做许可证与分发评估 |
| 24 | C28 | 复制 SSH 通道（同连接新通道） | 暂缓：待 C06 语义实测后决定单列还是并入 |
| 35 | G54 | 外部工具/方案工具（低置信） | 暂缓：需实机确认终端套件是否可达 |
| 36 | G55 | 内置文本编辑器套件（低置信） | 暂缓：需实机确认 2.7 终端版是否可达，不可达则排除 |

**对齐计数标记**：三处台账用同一个标记表示某行是否计入对齐完成率。Markdown 台账在证据索引中写“计数：…”，baseline.json 写 `parity_counting` 字段；没有标记的行照常计入。

| `parity_counting` | 台账写法 | 当前使用 |
| --- | --- | --- |
| `upstream_unconfirmed` | 上游未证实，不计入对齐完成率 | S08（E10，冻结时先用，实机后改为 c2 的 A 或 B）；以后确认上游不存在的能力也用此标记 |
| `conditional_upstream_check` | 先确认上游是否存在；确认不存在则标为本项目增强项，不计入对齐完成率 | F08、F09（E3）。确认存在则去掉标记、按现有要点验收；确认不存在则改为下一行 |
| `project_enhancement` | 本项目增强项，不计入对齐完成率 | 暂无 |

**后续事项**（不阻断冻结，按变更规则处理）：

1. 实机盘点上游 2.7.0（E1 授权，尚未开始）：G13 默认快捷键、F08/F09 的 SCP 入口、Q06 的可设最大值、S08 的恢复范围、G33 隐藏的对象、C14 的认证入口、T14 的列宽、S11 的会话搜索含义，以及 31 个新增 ID 的实际行为。
2. Windows/Linux 上游包的只读静态核对（E11），会影响 C23 和 T02–T06、Q02、Q03 的措辞。
3. C14：用户在冻结后提供测试 Kerberos 领域；状态是否从“待实测”改为“未实现”另行决定。
4. S08 按实机结果改为 c2 的 A 或 B；F08/F09 按实机结果去掉标记或改为本项目增强项。
5. 暂缓的 C23、C28、G54、G55 在实机盘点与 E11 之后再定。

## 冻结的含义（2026-10-12 已批准）

冻结固定以下三样东西，不固定实现状态：

1. ID 集合：原有 130 项，加上用户决定采纳的 31 项候选，共 161 项。
2. 每项的能力名称与验收要点措辞。能力名称不改；措辞只按本文选项调整。
3. 阶段归属。

用户于 2026-10-12 批准以下变更规则（提议时的原文）：
- 新发现的上游能力只能以新 ID 补入，并附证据与用户批准。
- 不删除 ID。确认上游不存在的能力保留 ID，标为“上游未证实”，不计入对齐完成率。
- 措辞修改要附证据并记录理由。
- 每次修改都同步三处台账，并重跑[结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证)。

“上游未证实”与 E3 的“本项目增强项”用同一个对齐计数标记表达，见[决定记录](#决定记录2026-10-12)。

## 结论摘要

下表为冻结后补入 T35–T37 的当前数字；冻结前 130 项与冻结当时 161 项的数字另行注明。

| 项目 | 数字 |
| --- | --- |
| 追踪 ID | 164（原 117 + 第二轮 13 + 冻结新增 31 + 冻结后新增 3）；冻结前 130，冻结当时 161 |
| 静态复核结论 | 支持 135（含冻结新增 31 项与冻结后新增 3 项，取自候选表）、部分 23、矛盾 4（其中 Q06 为弱矛盾）、沉默 2；冻结前支持 101 |
| P0 证据分组 | 原型/探针 67、仅静态 96、皆无 1（S08）；冻结前 64、65、1；2026-10-11 时为 57、72、1 |
| “原型/探针”的证据层级 | 真实对端 23、真实平台 7、loopback 夹具 8、浏览器 29；冻结前 21、7、9、27；2026-10-11 时为 6、7、17、27 |
| 需要定措辞的冲突 | 4 项矛盾（G13、F08/F09、Q06）与 2 项路线图不一致（C14、G02），另有 4 项同步措辞（S11、G17、G33、F21）：均已按 E2–E7 定稿 |
| 静态候选 | 36 项：纳入 31（其中 G53 限定范围）、不纳入 1（G43）、暂缓 4（C23、C28、G54、G55） |
| 对齐计数标记 | S08 上游未证实；F08、F09 先确认上游是否存在；其余 161 项照常计入 |
| 冻结前需要用户决定的事项 | 12 项，2026-10-12 全部决定，见 [(e)](#e-冻结前需要用户决定的事项) 与[决定记录](#决定记录2026-10-12) |

## (a) 矛盾与路线图不一致：验收措辞选项

下文引用的缩写（`RD`、`KEY`、`SCF`、`BIN` 等）与[静态复核的路径缩写](UPSTREAM_STATIC_REVIEW.zh-CN.md#路径缩写均相对-reference)一致。每项给出可直接替换验收要点的措辞选项；任何选项都不改变该行状态。

### a1 G13：本地/远程模式快捷键

- **现行验收要点**：“Shift+Enter 切换，当前模式可见且输入不误发送”。
- **静态证据**：
  - `RD:83` 写的是 Shift+Enter。
  - 发布包默认键位 `KEY:1082–1097` 用 `<Ctrl+Enter>` 在 local↔remote 之间切换，同一组绑定还切换 normal↔command。
  - 全文件唯一的 `<Shift+Enter>`（`KEY:2346`）绑定的是 `OutlinePane.RepeatedlyExecute`。
  - 菜单 `MNU:724–725` 和状态栏 `SBR:6` 都有模式入口。
- **平台注意**：Qt 在 macOS 上默认把 Ctrl 修饰键映射到 ⌘ 键。键位文件中的 `<Ctrl+Enter>` 在 macOS 上实际是 ⌃↩ 还是 ⌘↩，需要实机确认。
- **P0 证据**：无原型。P0 的 [Free Type 草稿 PoC](FREE_TYPE.zh-CN.md#结论) 已把 Shift+Enter 用作草稿内换行。

| 选项 | 验收要点措辞 | 评价 |
| --- | --- | --- |
| A 以发布包默认键位为准 | 通过上游默认快捷键（2.7 默认键位表为 `<Ctrl+Enter>`，各平台实际按键以实机为准）与菜单入口在本地/远程模式间切换；当前模式可见，切换与输入不误发送；快捷键可重新绑定 | 与发布包一致，但默认键位仍需实机确认 |
| **B 与具体键位解耦（建议）** | 通过菜单、命令面板和默认快捷键在本地/远程模式间切换，默认快捷键以上游 2.7 各平台实测为准（README 写 Shift+Enter，默认键位表为 Ctrl+Enter）；当前模式可见，输入不误发送；与 normal/command 模式、大纲重复执行的键位冲突单独记录 | 冻结时不依赖未确认的按键，实机后补默认键 |
| C 保留 README | 保持“Shift+Enter 切换” | 不建议：与发布包默认键位冲突，也与大纲 RepeatedlyExecute、P0 Free Type 草稿换行冲突 |

**决定（2026-10-12，E2）**：采纳 B，已写入三处台账的 G13 验收要点。各平台默认快捷键待实机盘点后补记。

### a2 F08/F09：SCP 是否属于 2.7 实际功能

- **现行验收要点**：
  - F08“协议兼容、路径和完整性、取消”；
  - F09“协议兼容、路径和完整性、覆盖”。
- **静态证据（弱反证）**：
  - `RD:61` 写“Integrated sftp, scp client”。
  - 主程序 `nm -u BIN` 有 47 个 `_sftp_*` 导入，scp 相关为 0。
  - 随包 libssh 导出 22 个 `_ssh_scp_*`，主程序没有引用。
  - `BIN` 和 `LOC` 都没有 scp 文案，只有 `TRG` 的超链接正则里出现 `scp://`。
  - 只检查了 macOS 包，Windows/Linux 包未检查。
- **P0 证据**：[`ssh_scp.rs`](SSH_SFTP_FIXTURE.zh-CN.md#scpf08f09) 在 exec 通道上实现了单文件 `scp -t/-f`。它与真实 OpenSSH 完成了 1 MiB 中文文件名文件的往返；没有目录、递归和界面。

| 选项 | 处理与措辞 | 评价 |
| --- | --- | --- |
| A 保持现状 | F08/F09 按 README 作为对齐项，验收不变 | 可能去对齐一项上游并不存在的能力，而且没有上游行为可对照 |
| **B 先确认上游是否存在（建议）** | 在两行验收要点前加：“先在 2.7 各平台发布包与实机确认 SCP 入口（菜单、拖放、协议选择或命令）；存在则按现有要点验收；确认不存在则保留 ID，标为本项目增强项，不计入对齐完成率” | ID 不删；P0 SCP 实现照样保留 |
| C 并入 SFTP | 若 README 的 “scp client” 实指 SFTP 传输，则把两行改为 F02/F03 的 SCP 回退 | 不建议：静态上没有看到回退迹象 |

**决定（2026-10-12，E3）**：采纳 B。F08、F09 的验收要点前已加上该段，计数标记为“先确认上游是否存在”（`conditional_upstream_check`，见[决定记录](#决定记录2026-10-12)）；P0 的 SCP 原型照样保留。

### a3 Q06：“unlimited”与默认 999,999 行

- **现行验收要点**：“盘点上游容量行为，验证检索、压缩和资源上限，不静默丢数据”（状态：待实测）。
- **静态证据**：
  - `RD:195/206` 基准表称 WindTerm 回滚历史 “unlimited”，但那是 1.72 版本的数据。
  - 2.7 默认 `SCF:77` 为 `window.scrollbackLimit=999999`。
  - `BIN` 有设置项 “&Lines of scrollback:”。
  - `SRC/Widgets/ScrollBar.h` 使用 64 位范围。
- **P0 证据**：[压缩历史 PoC](HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机) 用有界热窗口加压缩冷历史处理 5 万行，0 缺口；行在归档前被裁掉时会上报缺口。它没有接入生产终端；原型终端的回滚历史仍限 5,000 行。

| 选项 | 验收要点措辞 | 评价 |
| --- | --- | --- |
| A 以默认值为准 | 默认滚动历史上限与上游一致（2.7 默认 999,999 行，以实机为准），可配置范围与上游一致；达到上限时裁剪最旧行的行为可见、可预期，上限以内不静默丢数据；检索与压缩在上限内一致 | 与发布包一致，但没有回答上游能否设为无限 |
| **B 以可配置最大值为准（建议）** | 在 A 的基础上：实测上游设置项允许的最大值，以及是否接受“无限”；若上游可设为无限，本项目提供同等设置，并以 Q04 压缩和明确的内存/磁盘预算约束，超预算时提示而不是静默丢弃 | 同时覆盖默认值与上限语义 |
| C 以 README 为准 | 不设行数上限，只受资源预算约束 | 不建议直接采用：README 数字来自 1.72 基准，与 2.7 默认值不一致 |

**决定（2026-10-12，E4）**：采纳 B。Q06 的验收要点为 A 的措辞加 B 的补充；状态仍为“待实测”。

### a4 C14：GSSAPI 已随发布包链接

- **现行状态**：待实测。现行验收要点为：“2.7 UI选项可见；README与延期路线图冲突未解，需受控KDC、票据与认证结果核对，不能用默认勾选代替成功认证”。
- **台账中已过时的说法**：[基线台账](BASELINE.zh-CN.md)和 baseline.json 的未测原因仍写“未获发布构建配置”。
- **静态证据**：
  - `RD:57` 列出 gssapi-with-mic，`RD:365` 路线图又写“延期”。
  - 默认配置 `SCF:40` 为 `ssh.authGssapiWithMic=true`。
  - 主程序导入 `_ssh_userauth_gssapi`。
  - 随包 libssh 导出 `_ssh_gssapi_auth_mic` 等符号，`otool -L` 显示链接 `Kerberos.framework`。
  - 结论：链接层面已经说明发布构建启用了 GSSAPI，上层也有引用。但这仍不能证明端到端认证成功。
- **P0 证据**：只有[决策记录](X11_GSSAPI_ADR.zh-CN.md#gssapigssapi-with-micc14)，没有代码和 KDC 实验。
  - russh 0.64.1 已提供 `authenticate_gssapi_with_mic`。
  - 需要接入各平台系统 GSS：macOS GSS.framework、Linux libgssapi、Windows SSPI。

| 选项 | 处理与措辞 | 评价 |
| --- | --- | --- |
| **A 按已有功能纳入基线（建议）** | 验收要点改为：“在受控 KDC/sshd 上完成 gssapi-with-mic 认证；有效、过期、缺失票据与错误服务主体分别给出可区分的结果；服务端限制或日志证明最终认证方式，防止回退到密码/公钥掩盖失败；默认勾选不代替认证成功”。同时把未测原因更新为“链接层证据显示发布构建启用 GSSAPI；仍缺 KDC 端到端认证” | 与链接证据一致；状态是否从“待实测”改为“未实现”另由用户决定 |
| B 等上游 KDC 实验后再定 | 保持现措辞与“待实测”；若上游实验显示入口存在但认证不可用，再讨论如何处理 | 冻结时留下一个未定项 |
| C 按路线图移出对齐范围 | 标为路线图候选 | 不建议：与链接证据矛盾，且 ID 不能删除 |

无论选哪项，端到端验证都需要用户提供测试 Kerberos 领域，或批准在 Linux CI 容器内搭建 KDC 与 sshd。

**决定（2026-10-12，E5）**：采纳 A，验收要点与未测原因已改写。状态保持“待实测”，是否改为“未实现”没有决定。测试 Kerberos 领域由用户在冻结后提供。

### a5 G02：自动补全已有完整资源

- **现行验收要点**：“来源、候选、选择、取消；敏感输入不收集”。
- **静态证据**：
  - 功能列表 `RD:72` 有 Auto Complete，但 2.x 路线图 `RD:376` 把它列为未来项。
  - 发布包 `GCF:44–52` 有完整的 `terminal.autoComplete.*` 设置。
  - `APP/terminal/commands/` 下有 3809 个命令定义：cmd 32、linux 42、powershell 3696、git 39。
  - 各方案有 `*.complete` 文件，`MNU:463–465` 有 IntelliSense 入口。
- **P0 证据**：无原型。

| 选项 | 验收要点措辞 | 评价 |
| --- | --- | --- |
| **A 按已有功能细化（建议）** | 盘点上游补全来源（命令定义、方案 `*.complete`、命令历史、路径）与触发方式；候选显示、选择、取消与上游一致；补全数据由本项目独立编写或取自许可证兼容的来源，不复制上游命令定义文件；密码、口令等敏感输入不进入历史或补全 | 与静态证据一致，并写明数据来源约束 |
| B 只加备注 | 保持现措辞，备注写明路线图冲突已由静态证据倾向功能列表 | 冻结后仍需再细化 |

**决定（2026-10-12，E6）**：采纳 A，并确认数据来源约束：补全数据由本项目独立编写或取自许可证兼容的来源，不复制上游命令定义文件。

### a6 其他需要同步决定的措辞

以下四项不是静态矛盾，但如果冻结时不定，后续验收会产生歧义。

| ID | 问题 | 建议措辞 |
| --- | --- | --- |
| S11 会话搜索 | 路线图称 “Search in sessions” 延期；静态上只见会话树过滤框（`TBR:43–45`）和紧邻 “&All Sessions” 的查找字符串；P0 原型有会话侧栏名称筛选 | 建议把 S11 定为“会话树名称过滤”，跨会话输出搜索在实机确认后另立候选 ID |
| G17 大纲 | 上游语义是按命令生成的输出大纲：`LOC:1936` 把 Outline 译为“历史命令”，大纲窗格提供 Execute/RepeatedlyExecute/CopyOutput | 验收要点改为“按命令生成大纲，支持导航、重新执行/重复执行与复制输出，并随新输出更新”；P0 [折叠/大纲 PoC](FOLDING.zh-CN.md#结论) 已按提示符分段 |
| G33 输入时隐藏鼠标指针 | 设置文案为 “Hide cursor when typing”（`LOC:1195`），cursor 指鼠标指针还是文本插入符未知 | 暂写“输入时按上游实测隐藏鼠标指针（若实测为插入符则据实修订）”，实机后定稿 |
| F21 传输的其他实际选项 | 本行验收要求“确认后拆分为独立 ID”；静态已能列出拆分清单 | 若采纳候选 18/19（F25/F26），F21 保留为总括行，验收要点收窄为“递归传输、续传等其余选项，以实机盘点为准”；不删除 F21 |

**决定（2026-10-12，E7）**：四项建议全部采纳。S11 的能力名称仍为“会话搜索”，验收要点定为会话树名称过滤；G33 在建议措辞后保留原有的“移动恢复和设置”；F21 保留为总括行，传输队列暂停/恢复与并发参数拆到 F25，Modem 冲突策略拆到 F26。

## (b) 36 项静态候选

候选来自[静态复核的候选表](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id)，序号沿用该表。提议 ID 接在各系列现有最大编号之后：C22–C28、T30–T34、F22–F26、G41–G55、S14–S17。提议阶段这些 ID 没有写入台账；2026-10-12 用户按建议采纳（E8）后，建议纳入的 31 项已按此编号和能力名称写入三处台账。

编号规则（2026-10-12 已批准）：用户采纳后按此编号写入三处台账，并相应扩展结构验证脚本；不纳入或暂缓的编号保留，不给其他能力复用，避免同一编号先后指代不同能力。

判断标准：

| 建议 | 标准 |
| --- | --- |
| 纳入 | 发布包有明确的菜单、动作、配置或字符串；行为可以独立验收；现有行的验收要点没有完整覆盖 |
| 不纳入（并入） | 现有行的验收要点已覆盖，改为补充该行验收要点 |
| 暂缓 | 低置信、对应平台的发布包未核对，或语义依赖另一个待决行 |

| 序号 | 提议 ID | 候选能力 | 静态证据（摘要） | 关联 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | G41 | 触发器（全局/会话级） | `MNU:747/270` 全局与会话级触发器管理；`TRG` 默认 4 条；`BIN` 7 种动作类型与连接前后事件；`LOC:4030` | `RD:389` | 纳入 | 入口、默认配置与动作类型齐全；“运行命令”“发送文本”类动作需加入安全确认和不误发送的验收要点 |
| 2 | G42 | OneKey 凭据模板与登录向导（expect/send） | `MNU:746`；`GCF:56–57/59/66`，登录向导默认类型为 OneKey；`BIN` “OneKey Manager”；`LOC:1561/3880` | G06、C11 | 纳入 | 上游默认登录方式；涉及凭据保存，需与 Keychain 方案和 G06 一起验收，不解密旧凭据 |
| 3 | S14 | 会话导入（OpenSSH config / PuTTY / Shell） | `MNU:220–224`；`BIN` Host/HostName/IdentityFile/ProxyJump/各类 Forward 解析键与 ssh_config、PuTTY 会话路径；`LOC:1273` | S01、S02 | 纳入 | 需要导入预览、冲突处理和只读源文件；与“非秘密 WindTerm 配置导入”分开验收 |
| 4 | C22 | 隧道管理器（独立对话框、与会话绑定、状态显示） | `MNU:748`；`LOC:3466`；`BIN` 删除会话时连带隧道的提示 | C16–C18 | 纳入 | C16–C18 验收协议行为；管理器的绑定、生命周期与状态显示是独立工作流。P0 只有已打开 SSH 终端上的临时[端口转发面板](SSH_FORWARDING.zh-CN.md#界面)（russh 夹具、IPC stub），不保存、不与会话配置绑定，不是隧道管理器 |
| 5 | C23 | 内置 X Server（Windows VcXsrv 包装） | `GCF:130–138` `xserver.*`；`BIN` “X Server &Settings...”“-multiwindow”；`LOC:3388` VcXsrv 参数 | C15 | 暂缓 | 只在 macOS 包中看到设置键，没有核对 Windows 包是否随附 X Server；捆绑第三方 X Server 需单独做许可证与分发评估 |
| 6 | T30 | 远端读写剪贴板（OSC 52）权限 | `SCF:11–12` 读/写默认值 2；`BIN` OSC 52 格式串与询问/允许/禁止选项；`LOC:2926` | T12、G29 | 纳入 | 安全相关且有独立设置。P0 [VT 矩阵](VT_MATRIX.zh-CN.md#osc)确认 xterm.js 内核忽略 OSC 52（O04），公开钩子可接管（H03）；生产适配器已改为读取始终拒绝、写入需会话级授权（[OSC 52 剪贴板](VT_MATRIX.zh-CN.md#osc-52-剪贴板)，仅浏览器） |
| 7 | G43 | 括号粘贴与大段发送确认 | `BIN` “[200~”“[201~” 与 “You are sending a large amount of text (%1 bytes).” | G12、T12 | 不纳入（并入） | 括号粘贴属于 T12 控制序列（VT 矩阵 A03 原样可用），大段发送确认属于 G12 粘贴对话框；建议把两点补入 T12/G12 验收要点，编号不启用。P0 [输入路径探针](INPUT_PATHS.zh-CN.md#粘贴input-pastespects26-项)已有粘贴控制字符清洗与有序输入队列，但没有大段发送确认（仅浏览器） |
| 8 | C24 | SSH 算法、重协商与证书公钥类型配置 | `BIN` 算法/密钥交换/MAC/公钥类型设置与默认顺序（含 `*-cert-v01@openssh.com`）；`SCF:44–45` rekey 数据量与时间上限；`LOC:523/1603` | C01、C12 | 纳入 | 会话设置有独立页面；P0 目前显式拒绝 rekey，不支持证书与 RSA，需要单独验收和安全评审 |
| 9 | C25 | 主机指纹信任管理（信任/取消信任/查看） | `LOC:3064/3133`；`BIN` `ssh.serverFingerprint`；`nm -u BIN` `_ssh_write_knownhost` | C01 | 纳入 | C01 只验收首次确认与变化拒绝；查看、取消信任是管理工作流。P0 已有 known_hosts 持久化，但没有管理界面 |
| 10 | C26 | 连接超时、保活与 TCP 选项 | `SCF:15/17/27–30`；`LOC:802/2497/1609` | C01–C03、S01 | 纳入 | 超时与保活有可测行为（断线发现、空闲连接）；TCP 选项作为本行配置项，不再单列 |
| 11 | C27 | 应用级全局代理（无/系统/HTTP/SOCKS5，代理 DNS） | `GCF:5–6`；`BIN` 全局代理键、“System proxy”、会话代理类型 “Global”；`LOC:3484` | C19、C20 | 纳入 | 有系统代理与全局继承语义，不同于会话级代理。P0 代理探针与连接对话框路线只覆盖单次连接的 HTTP/SOCKS5，没有全局或系统代理 |
| 12 | T31 | 终端键盘与初始模式设置 | `SCF:50–63`：Alt/Meta 修饰、answerBack、Backspace/Delete、光标键与小键盘模式、换行模式、反显、formatOtherKeys；`LOC:220/352/3523` | T07–T13 | 纳入 | 键盘编码直接影响 vim、tmux 等应用；每个设置都能用字节捕获验收。P0 [输入路径探针](INPUT_PATHS.zh-CN.md#按键input-keysspects12-项)记录了 xterm.js 6.0.0 的光标键、功能键与 Ctrl 组合字节，macOS 上 Option 默认不作 Meta（仅浏览器） |
| 13 | T32 | 终端清屏与复位 | `MNU:260–262/297–301`：清回滚、清屏、全部清除、软/硬复位、复位字符集；`ACT:744/950` | T07–T13 | 纳入 | 这是用户动作，验收方式不同于控制序列行；P0 VT 矩阵 X01/X02 已记录 DECSTR、RIS 的原样行为 |
| 14 | G44 | 命令级导航、选择、复制与命令历史存储 | `MNU:246/265–268`；`GCF:53–55` 命令历史 30 天、10000 条、默认持久化；`BIN` “commands.history”；`LOC:3637/3811` | G02、G17 | 纳入 | 命令历史默认写盘，涉及隐私与秘密过滤；需与 G02 补全来源、G17 大纲联合验收 |
| 15 | F22 | 文件面板与终端当前目录同步 | `SCF:2` 默认关闭；`ACT:172/348`；`BIN` tmux “pane-cwd-changed”；`LOC:3682` | F01、F13 | 纳入 | 有动作与默认设置；依赖 shell 当前目录探测，P0 未涉及 |
| 16 | F23 | 远端文件用外部编辑器打开并回传 | `ACT:313/344`；`BIN` 分平台默认编辑器；`LOC:103` 修改后回传提示 | F02、F03 | 纳入 | 涉及临时文件、变更检测与覆盖确认，验收独立于上传和下载 |
| 17 | F24 | 文件面板辅助：新建链接、属性与权限编辑、复制路径/名称到终端、隐藏项 | `MNU:103/185/187–195/106`；`nm -u BIN` `_sftp_symlink`、`_sftp_chmod`、`_sftp_setstat`；`BIN` UID/GID/Sticky/Octal；`GCF:23`；`LOC:703` | F01–F07、F13–F20 | 纳入 | 有导入符号与菜单，可在实机后再细分。P0 只读 SFTP 能显示权限、解析符号链接；[SFTP 写操作原型](SFTP_WRITE.zh-CN.md#各操作的语义)可改 rwx 权限位（真实 OpenSSH 夹具），没有新建链接、属主与特殊权限位 |
| 18 | F25 | 传输队列暂停/恢复/移除与并发参数（F21 拆分） | `MNU:238–243`；`SCF:64–72`；`BIN` “&Open directory after download” | F21 | 纳入 | F21 要求“确认后拆分为独立 ID”；P0 传输队列仍是模拟数据 |
| 19 | F26 | X/Y/Z Modem 冲突策略、填充与拖放协议（F21 拆分） | `BIN` “When destination file &exists:” 及覆盖、追加、重命名、续传、跳过等策略，填充字符；`SCF:3`；`LOC:2704/3199` | F10–F12、F21 | 纳入 | 同上；P0 modem 探针没有覆盖冲突策略与落盘 |
| 20 | T33 | 其余会话字符集、十六进制显示与自动检测 | `BIN` 分组字符集表（GB2312/GB18030/GBK、Shift-JIS、韩文、西里尔、UTF-16/32 等）、“System”、“Hexadecimal”；uchardet 类探测器 | T28、T29 | 纳入 | 矩阵已注明“其他字符集仍待盘点”；先用一个 ID 承接，UI 盘点后按字符集分组拆分。P0 终端只处理 UTF-8 |
| 21 | S15 | 地址栏快速连接与会话 URL | `TBR:9`；`MNU:559`；`LOC:2416/3382`；`BIN` 会话 URL 正则；`ACT:771` 复制会话 URL | S01 | 纳入 | 独立入口与 URL 语法，需要输入校验和不可信 URL 处理 |
| 22 | S16 | 断开/重连会话与回车重连 | `MNU:419–420`；`KEY:263` 未连接时 Enter 触发重连；`LOC:2938` | C01–C04 | 纳入 | 路线图的安全要求“重连不自动重放此前输入”需要落到具体 ID；P0 SSH 没有断线恢复 |
| 23 | S17 | 重新打开已关闭视图与最近会话 | `MNU:75–81`；`ACT:2371`；`BIN` “global/reopen.history”；`LOC:2203` | S07 | 纳入 | 与重启恢复（S07）触发方式不同；同样要验证不重放输入 |
| 24 | C28 | 复制 SSH 通道（同连接新通道） | `MNU:385`；`ACT:801`；`LOC:3586` | C06 | 暂缓 | 可能就是上游 ControlMaster（C06）的实现方式；P0 [ControlMaster 决策](CONTROLMASTER_ADR.zh-CN.md#决策)已按应用内多通道复用提议。待 C06 语义实测后再决定单列还是并入 |
| 25 | G45 | 会话颜色/图标与标签标题跟随远端 | `BIN` `session.color`、`session.icon`；`SCF:16/75`；`LOC:2515/2521/3205` | G25 | 纳入 | 会话级持久化与远端标题不同于 G25 标签颜色；远端标题是不可信数据 |
| 26 | G46 | 标签栏行为与关闭确认 | `GCF:33–40` 标签栏设置（双击关闭、中键重命名、悬停、序号、省略、缩略图）；`GCF:42–43` | G26、G27 | 纳入 | 多个可配置行为；中键默认是重命名，需要与 G31 中键粘贴联合核对 |
| 27 | G47 | 多窗口与窗口管理器 | `MNU:417/776–778`；`ACT:6/2697`；`ACT:370` 移动窗格到新窗口；`LOC:3256` | G18 | 纳入 | 不同于分屏；本项目会话按窗口归属校验，需要验收跨窗口移动 |
| 28 | G48 | 停靠窗格布局、栏显隐、工具栏定制与状态栏项 | `MNU:33–61/648–658`；`ACT:2591/2688`；`SBR` 模式、行列、方案、时钟、锁屏等项 | G09–G11、S08 | 纳入 | 与 S08 布局恢复相互依赖；视觉方向已定，可重组入口但不删能力 |
| 29 | G49 | Anything 面板、跳转行/符号/会话与计算器面板 | `MNU:561–563/624`；`APP/global/palettes/` 下的计算器与跳转行定义；`LOC:226` | G07、G26 | 纳入 | 前缀式面板与计算器超出 G07 命令面板；实机后可决定与 G07 合并验收 |
| 30 | G50 | 手动文本高亮标记（Text Marks） | `MNU:252–253/478`；`ACT:1308`；`LOC:3826/4018` | G19、G20 | 纳入 | 独立动作，不同于配色方案和搜索 |
| 31 | G51 | 字体缩放与文本显示选项（行号、空白、行尾、缩进线、列标记） | `MNU:303–343/673–714`；`ACT:2134`；`GCF` `text.*` | G15、G16 | 纳入 | 一组显示选项，实机后按选项细分 |
| 32 | G52 | 列/块选择与高级选择（锁定、拆分、反选、分词符） | `MNU:480–557`；`ACT:1920` 列编辑切换；`SCF:73/83` | G29、G37 | 纳入 | 选择模型不同于多光标（G37）和选择即复制（G29） |
| 33 | G53 | 用户自定义动作/键位与配置目录 | `BIN` “user.actions”“user.keymaps”；动作与键位以 JS `script` 定义；`ACT:10` 配置目录；`APP/profiles.config` | `RD:381` 路线图 | 纳入（限定范围） | 只纳入键位与动作覆盖、配置目录位置；JS 脚本、宏和插件系统仍按路线图候选处理，不属于本 ID |
| 34 | T34 | 本地 Shell 会话启动参数 | `BIN` 工作目录、启动后执行命令、环境变量、locale 变量；`SCF:5`；`LOC:940/3613` | T01–T06、C05 | 纳入 | P0 本地 PTY 目前使用固定环境与起始目录；这些参数直接影响 T01–T06 的验收 |
| 35 | G54 | 外部工具/方案工具（低置信） | `ACT:2193–2229` `Tool.*`（Build 标注 Editor 套件）；终端菜单未暴露；`LOC:958` | `RD:371` 路线图 | 暂缓 | 终端菜单未暴露，路线图仍列为未来项；需要实机确认终端套件是否可达 |
| 36 | G55 | 内置文本编辑器套件（低置信） | `ACT:89–169` `Editor.*`、在文件中查找、展开片段；`GCF:19–22`；发布包没有编辑器菜单配置 | `RD:364` | 暂缓 | 需要实机确认 2.7 终端版是否可达；不可达则排除 |

合计：纳入 31（含限定范围的 G53），不纳入 1（G43），暂缓 4（C23、C28、G54、G55）。按系列，纳入的是 C 5、T 5、F 5、G 12、S 4。README 路线图中的 Mosh、Rlogin、FTP/FTPS、Chat mode、Log viewer 在发布包中找不到对应字符串，与“未实现”一致，不列为候选。

**决定（2026-10-12，E8）**：按上表的建议采纳。纳入的 31 项写入三处台账，状态为“未实现”，P0 分组与证据层级按 (d) 的规则判定（见 [(d) 的冻结新增说明](#2026-10-12-冻结新增-31-项)）；G43 不纳入，括号粘贴补入 T12、大段发送确认补入 G12 的验收要点；C23、C28、G54、G55 暂缓，不写入台账，列在[决定记录](#决定记录2026-10-12)和 baseline.json 的 `baseline_freeze.deferred_candidates` 中。五个未启用的编号都不复用。

## (c) T14 与 S08 的处理

这两行除 README 外没有静态证据。能力名称属于原 117 项，不能改名；下面只讨论验收依据与措辞。

### c1 T14 Unicode 13 与宽字符

- **静态**：沉默。只有 `RD:70`，`BIN` 和 `LOC` 中都没有 Unicode 版本串。
- **P0 证据**：
  - 生产终端工厂启用 `@xterm/addon-unicode11@0.9.0`。浏览器回归确认 🌏、👋、中各占 2 列，组合重音占 1 列；不加载插件时的 1 列旧问题可以复现。见 [WEB_QA](WEB_QA.zh-CN.md#unicode-列宽回归与-ipc-契约审查)。
  - 真实 OpenSSH 交互 shell 输出了中文与 emoji。
  - 2026-10-12 的[输入路径探针](INPUT_PATHS.zh-CN.md#宽字符input-widespects27-项)（浏览器、CDP 模拟输入法、IPC stub）记录了更多列宽：ZWJ 家庭占 6 列、旗帜为 2 个窄格、肤色修饰占 4 列、VS16 不加宽，均列为已知差距；还修复了 xterm.js 6.0.0 在输出块边界丢字的缺陷。这些都没有与 shell 的 `wcwidth` 或 WindTerm 对照，不回答 E9。
  - 这是 Unicode 11 宽度表，不是 Unicode 13。
- **提议**：保留 T14，验收依据从“README 声明”改为“README 声明 + 实机列宽对照”。验收要点建议改为：

  > 以 WindTerm 2.7 实测列宽为基线：建立覆盖 CJK、组合字符、Unicode 12/13 新增宽字符、emoji 修饰符与 ZWJ 序列的样本，同时记录上游显示、本项目显示与常见 shell 的 wcwidth 结果；在有差异的字符上，选区、光标与复制保持一致，差异处理策略写明。

- **技术备注**：当前的 Unicode 11 宽度表覆盖不到 Unicode 12/13 新增的字符。P1 前需要评估更新宽度表，或采用 xterm.js 官方更新的 Unicode 宽度方案；后者尚未安装、未锁版本，可用性需先核实。

**决定（2026-10-12，E9）**：采纳上述措辞，已写入 T14 的验收要点。

### c2 S08 重启恢复布局

- **静态**：沉默。只有 `RD:109`，没有找到布局持久化键或文件名。但静态复核没有读取运行时生成的用户 profile，而布局可能在运行时才写入，所以“静态沉默”不能说明上游没有该功能。
- **P0 证据**：无。原型明确不持久化分屏、标签、文件面板和连接配置（[UI_MAP](UI_MAP.zh-CN.md#已实现的原型行为)）。这是 130 项中唯一既无静态证据、也无 P0 原型的一行。
- **相关候选**：G47 多窗口、G48 停靠布局。

| 选项 | 处理 | 评价 |
| --- | --- | --- |
| **A 保留并以实机定基线（建议）** | 在隔离 profile 中建立分屏、多标签、停靠窗格与多窗口，正常退出后重启，记录实际恢复了什么，再把验收要点收窄到实测恢复的范围 | 需要授权运行上游应用（见 E1） |
| B 并入 S07 的验收 | 若上游只恢复会话、不恢复布局，S08 的验收要点改为引用 S07，并注明布局不恢复 | ID 保留；需要实机结果支撑 |
| C 标为“上游未证实” | 与 F08/F09 选项 B 同一机制：保留 ID，不计入对齐完成率，直到实机确认 | 冻结时可先采用，实机后再改 A 或 B |

**决定（2026-10-12，E10）**：先用 C。S08 保留 ID，计数标记为“上游未证实”（`upstream_unconfirmed`），不计入对齐完成率；验收要点与状态不变。实机盘点后改为 A 或 B。

## (d) 逐项 P0 证据汇总

分组定义：

| 分组 | 含义 |
| --- | --- |
| 原型/探针 | 有 P0 原型、隔离 PoC 或探针，其运行证据直接涉及该行至少一项验收要点。**不代表对齐或验收通过** |
| 仅静态 | 有静态复核证据（支持、部分或矛盾），但没有 P0 运行证据；只有方案或 ADR 的行也归入此组 |
| 皆无 | 除 README 外没有静态证据，也没有 P0 原型或探针 |

证据层级：

| 层级 | 含义 |
| --- | --- |
| 真实对端 | 系统 OpenSSH、tmux 等真实程序 |
| 真实平台 | CI 或本机真实 PTY、原生构建与冒烟 |
| loopback 夹具 | russh 测试服务端、测试内 TCP 服务器或自发自收 |
| 浏览器 | headless Chrome 探针、隔离 PoC 或 IPC stub 界面原型 |

本节与三处台账的证据索引必须一致，由[结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证)第二段脚本逐项核对。证据层级只记录在本节和 baseline.json 的 `p0_evidence_level` 字段。

| 系列 | 总数 | 原型/探针 | 仅静态 | 皆无 |
| --- | ---: | ---: | ---: | ---: |
| C | 26 | 18 | 8 | 0 |
| T | 37 | 22 | 15 | 0 |
| F | 26 | 12 | 14 | 0 |
| G | 52 | 7 | 45 | 0 |
| S | 17 | 2 | 14 | 1 |
| Q | 6 | 6 | 0 | 0 |
| 合计 | 164 | 67 | 96 | 1 |

“原型/探针”组按证据层级再分：真实对端 23 项（真实 OpenSSH、tmux、telnetd、lrzsz，以及 Linux CI 上的 OpenSSH 加 Xvfb），真实平台 7 项（CI 或本机真实 PTY、原生构建），loopback 夹具 8 项（russh 或测试内服务器、自发自收），浏览器 29 项（headless Chrome 探针、隔离 PoC 或 IPC stub 界面原型）。“仅静态”组中 C04、C14、F12 另有方案或决策记录，但没有运行证据。冻结前（130 项）分组为 64、65、1，层级为 21、7、9、27；差额来自冻结新增的 31 项和冻结后新增的 T35–T37，分别见下文对应记录；后 3 项只增加“仅静态”计数，不改变运行证据层级。

[UI_MAP](UI_MAP.zh-CN.md#已实现的原型行为) 还把部分界面原型映射到 S02、S08、G04、G09、G10、G19、G26、G27、F13、F21。这些入口使用演示数据或模拟状态机，或者语义与该行不同，因此不计为运行证据。各行的“覆盖范围与缺口”写明了理由；baseline.json 的 `evidence_refresh.ui_prototype_not_counted` 列出同一组 ID。F02、F03 原先也在这一组；2026-10-12 起它们有 SFTP 写操作原型的运行证据，因此移出，但原型中的模拟传输队列仍然不计为运行证据。

### 2026-10-12 刷新

本次刷新只处理 2026-10-11 冻结提议之后合入 `p0/integration` 的原型，没有改任何状态、ID 或能力名称。每行仍只记一个证据层级，取直接涉及该行验收要点的最强运行证据，其余部分的层级写在“覆盖范围与缺口”中。

| 来源 | 涉及 ID | 分组或层级变化 |
| --- | --- | --- |
| [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | F02–F07 | 仅静态 → 原型/探针，层级为真实对端：Rust 服务对系统 OpenSSH `sftp-server` 夹具，面板为 IPC stub。修改权限属于候选 F24，刷新时不在 130 项内；冻结时 F24 已纳入，见下文“2026-10-12 冻结新增 31 项” |
| [SSH_ROUTES](SSH_ROUTES.zh-CN.md#证据macos-arm64本地) | C07、C08、C19、C20、C21 | loopback 夹具 → 真实对端：只读 SFTP 经各路线到达系统 OpenSSH。HTTP/SOCKS5 代理仍是测试内代理，跳板仍是 russh 夹具。C21 与 C08 共用跳板证据，属于本次按功能矩阵做的映射，SSH_ROUTES 原文只列 C07、C08、C19、C20 |
| [NET_TERMINAL](NET_TERMINAL.zh-CN.md#真实-telnetd-互操作2026-10-12) | C02 | loopback 夹具 → 真实对端：本机 Apple telnetd 308，被测程序是测试脚本，不是 login(1) |
| [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) | C16、C17、C18 | 无变化（loopback 夹具）；补充已打开 SSH 终端的端口转发面板（IPC stub） |
| [VT_MATRIX](VT_MATRIX.zh-CN.md#生产-vt-适配器) | T07、T08、T10、T11、T12、T16、T20、T21 | 无变化（浏览器）；说明改为原样行为加生产 VT 适配器 |
| [INPUT_PATHS](INPUT_PATHS.zh-CN.md#探针覆盖与结论) | T12、T14、T15；G12 只加说明 | 无变化（浏览器）。G12 仍为仅静态：粘贴清洗与有序队列不是粘贴对话框 |
| [WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位) | T03、Q02 | 无变化（真实平台）；补充 Server 2022 与 2025 CI 和句柄泄漏定位 |
| [RELEASE](RELEASE.zh-CN.md#4-本地验证) | Q01 | 无变化（真实平台）；补充 release `.app` 排除测试二进制与声明的最低 macOS 13.3 |
| [TERMINAL_CORE_ADR](TERMINAL_CORE_ADR.zh-CN.md#原型) | T09 | 无变化（浏览器）；补充隔离 SIXEL 原型。ADR 本身是提议，不计为运行证据 |
| [X11_GSSAPI_ADR](X11_GSSAPI_ADR.zh-CN.md#验证记录) | C15 | 仅静态 → 原型/探针，层级为真实对端：Linux CI 上经系统 OpenSSH 在远端运行 `xdpyinfo`，读到带 cookie 保护的 Xvfb（[run 38207141339](https://github.com/mofyer/new-windterm/actions/runs/38207141339)） |
| [MODEM](MODEM.zh-CN.md#lrzsz-互操作2026-10-12) | F10、F11 | loopback 夹具 → 真实对端：本机 lrzsz 0.13.1；Linux CI 上 Ubuntu lrzsz 0.12.21rc 10/11。F12 不变（仅静态）：`zmodem2` 评估的是第三方实现，不计为本项目原型 |
| [SCP](SCP.zh-CN.md#真实-openssh-夹具) | F08、F09 | 无变化（真实对端）；补充 SFTP 文件面板中的 SCP 选项（IPC stub 界面）与经 SFTP 授权的真实 OpenSSH 夹具往返。仍是单文件，无目录与递归，无原生窗口实测 |
| [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#agent-转发实测2026-10-12macos-arm64本机) | C10 | 无变化（loopback 夹具）：russh 夹具加私有临时 ssh-agent 与 IPC stub 界面；无 OpenSSH 服务端互操作 |
| [NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md#场景与各自证明的内容) | T02、T03、Q02、Q03 | 无变化（真实平台）；补充 tauri-driver 在 Linux WebKitGTK 与 Windows WebView2 上的 CI 原生窗口冒烟（工作台、本地终端真实 PTY、SSH 终端）。映射依据：T02、T03 的验收含 shell 命令交互，冒烟在原生窗口中输入命令并读回输出；Q02、Q03 是平台行，冒烟只覆盖其中一部分（仍无完整回归、安装与升级）。T01、Q01 的说明已有 macOS 冒烟，tauri-driver 不支持 macOS，不在本次映射。SSH、转发、SFTP 等其余行未经原生窗口验证，不映射 |

合计：6 个 ID 从“仅静态”移入“原型/探针”（F02–F07）；6 个 ID 在“原型/探针”内从 loopback 夹具升为真实对端（C02、C07、C08、C19、C20、C21）；其余 18 个 ID 只更新链接或说明。随后又有 1 个 ID 从“仅静态”移入“原型/探针”（C15），2 个 ID 在“原型/探针”内从 loopback 夹具升为真实对端（F10、F11）。再随后 F08、F09、C10、T02、T03、Q02、Q03 只补充链接与说明，分组和层级不变。

### 2026-10-12 冻结新增 31 项

E8 决定后，(b) 表中纳入的 31 项按本节的分组与层级规则加入下面各系列表，排在各系列原有行之后。判定依据是 (b) 表理由列提到的原型，逐项核对是否“直接涉及该行至少一项验收要点”：

| 判定 | ID | 依据 |
| --- | --- | --- |
| 原型/探针，浏览器 | T30 | VT 矩阵 O04 与生产适配器的 OSC 52 策略直接涉及远端读写剪贴板的权限结果；没有询问/允许/禁止设置项 |
| 原型/探针，浏览器 | T31 | 输入路径探针记录了光标键、功能键、Ctrl 组合、Backspace 与 Option/Alt 的发送字节，直接涉及键盘设置的字节验收；没有设置项 |
| 原型/探针，真实对端 | F24 | SFTP 写操作原型对真实 OpenSSH 修改 rwx 权限位，直接涉及权限编辑；无新建链接、属主与特殊位 |
| 仅静态（说明写明不计） | C22 | 端口转发面板是已打开 SSH 终端上的临时面板，不保存、不与会话绑定，不是隧道管理器 |
| 仅静态（说明写明不计） | C27 | 代理探针只覆盖单次连接的 HTTP/SOCKS5（计入 C19、C20），没有全局或系统代理 |
| 仅静态（说明写明不计） | C25、T32、T34、F25、F26 | 相近原型不涉及本行验收要点：known_hosts 持久化计入 C01，没有查看或取消信任的界面；VT 矩阵 X01/X02 只记录远端发送的 DECSTR、RIS，没有用户触发的动作；本地 PTY 计入 T01–T03，没有启动参数；原型传输队列是模拟状态机；modem 互操作计入 F10、F11，没有冲突策略与落盘 |
| 仅静态 | 其余 21 项 | 没有 P0 原型或探针 |

合计：31 项中原型/探针 3 项（浏览器 2、真实对端 1），仅静态 28 项。31 项的静态结论都记为“支持”，链接[静态复核候选表](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id)。

### C 协议、认证、代理与转发

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | SSH v2 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_TERMINAL](SSH_TERMINAL.zh-CN.md#验证与未验收项)、[OPENSSH_INTERACTIVE](OPENSSH_INTERACTIVE.zh-CN.md#rust-ssh_open-互操作)、[RESULTS](RESULTS.zh-CN.md#持久化主机信任) | loopback russh 交互通道、真实 OpenSSH shell 互操作与主机信任持久化；无断线重连，rekey 被拒绝 |
| C02 | Telnet | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [NET_TERMINAL](NET_TERMINAL.zh-CN.md#证据)、[TRANSPORTS](TRANSPORTS.zh-CN.md#telnetc02)、[NET_TERMINAL](NET_TERMINAL.zh-CN.md#真实-telnetd-互操作2026-10-12) | Telnet 编解码与终端标签（测试内 loopback 服务器）；本机以非 root 对 Apple telnetd 308 做回环互操作，被测程序是测试脚本而非 login(1)；无网络设备与其它 telnetd，CI 未运行 |
| C03 | Raw TCP | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [NET_TERMINAL](NET_TERMINAL.zh-CN.md#证据) | Raw TCP 终端标签的字节完整性与背压，仅 loopback；无真实服务互操作 |
| C04 | 串口 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 仅静态 | — | [TRANSPORTS](TRANSPORTS.zh-CN.md#串口c04) | 仅验证计划，需要 USB 串口设备；无代码（不计为运行证据） |
| C05 | SSH 认证后自动执行 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 仅静态 | — | — | 无 P0 原型或探针 |
| C06 | SSH ControlMaster | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [CONTROLMASTER_ADR](CONTROLMASTER_ADR.zh-CN.md#证据) | 单连接多 PTY 通道探针（russh 夹具）与提议 ADR；无外部 ControlPath |
| C07 | ProxyCommand | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#经代理连接与-proxycommandc07c19c20)、[SSH_ROUTES](SSH_ROUTES.zh-CN.md#证据macos-arm64本地) | 不经 shell 的 ProxyCommand 探针；已接入连接对话框，确认 argv 后经 /usr/bin/nc 到达真实 OpenSSH（只读 SFTP）与 russh 夹具，IPC stub 界面；不保存配置，只在 macOS 运行 |
| C08 | ProxyJump | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_ROUTES](SSH_ROUTES.zh-CN.md#证据macos-arm64本地) | 两跳跳板探针，逐跳固定主机密钥与独立认证（russh 夹具）；连接对话框一跳跳板路线的两步信任，以 russh 夹具作跳板到达真实 OpenSSH（只读 SFTP），IPC stub 界面；OpenSSH 作跳板未测，无多跳与配置保存 |
| C09 | SSH agent | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [RESULTS](RESULTS.zh-CN.md#ssh-认证方式) | 临时 ssh-agent 认证（russh 集成，仅 macOS 本机）；Windows 命名管道只经交叉编译 |
| C10 | agent forwarding | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#远端转发与-agent-转发c17c10)、[SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#agent-转发实测2026-10-12macos-arm64本机)、[SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#与-openssh-服务端互操作2026-10-12) | agent 转发默认拒绝、显式开启后可用；SSH 终端连接对话框逐连接开启（IPC stub 界面）；对系统 OpenSSH（本机 10.3p1、Linux CI）用私有临时 ssh-agent 验证：未开启时远端无 agent，开启后远端 ssh-add -l 只列出该密钥；未验证经转发的签名与原生窗口 |
| C11 | 密码认证及自动登录 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [RESULTS](RESULTS.zh-CN.md#ssh-认证方式) | 密码正确/错误（russh 集成）；无保存与自动登录 |
| C12 | 公钥认证及自动登录 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [RESULTS](RESULTS.zh-CN.md#ssh-认证方式)、[OPENSSH_INTERACTIVE](OPENSSH_INTERACTIVE.zh-CN.md#rust-ssh_open-互操作) | Ed25519/ECDSA 私钥及口令（russh 集成、真实 OpenSSH 夹具）；无 RSA、无安全保存与自动登录 |
| C13 | keyboard-interactive | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [SSH_KBDINT](SSH_KBDINT.zh-CN.md#证据macos-arm64本地) | 多轮提示与实时对话框（russh 夹具、IPC stub）；无真实 PAM/OpenSSH |
| C14 | gssapi-with-mic | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 仅静态 | — | [X11_GSSAPI_ADR](X11_GSSAPI_ADR.zh-CN.md#gssapigssapi-with-micc14) | 仅决策记录；无实现与 KDC 实验（不计为运行证据） |
| C15 | X11 forwarding | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [X11_GSSAPI_ADR](X11_GSSAPI_ADR.zh-CN.md#验证记录)、[X11_GSSAPI_ADR](X11_GSSAPI_ADR.zh-CN.md#x11-转发c15) | Rust 探针：假 cookie 替换、通道上限、随终端拆除（loopback 夹具与假 X 服务器）；Linux CI 经系统 OpenSSH（X11Forwarding）在远端运行 xdpyinfo，读到带 cookie 保护的 Xvfb；无界面，未验证 XQuartz、Windows 与真实图形程序 |
| C16 | 本地/直接端口转发 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) | 本地转发 4 路并发、端口冲突、仅回环、停止（russh 夹具）；已打开 SSH 终端的端口转发面板（russh 夹具、IPC stub）；无配置保存，无 OpenSSH 互操作 |
| C17 | 远端/反向端口转发 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#远端转发与-agent-转发c17c10)、[SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) | 远端转发往返、未登记通道拒绝、取消监听（russh 夹具）；已打开 SSH 终端的端口转发面板（russh 夹具、IPC stub）；无配置保存，无 OpenSSH 互操作 |
| C18 | 动态端口转发 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | loopback 夹具 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测2026-10-12macos-arm64本机) | SOCKS5 动态转发 CONNECT（russh 夹具）；已打开 SSH 终端的端口转发面板（russh 夹具、IPC stub）；SOCKS 无认证，无配置保存，无 OpenSSH 互操作 |
| C19 | HTTP 代理 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#经代理连接与-proxycommandc07c19c20)、[SSH_ROUTES](SSH_ROUTES.zh-CN.md#证据macos-arm64本地) | HTTP CONNECT 含 Basic 认证与 407（本机测试代理）；已接入连接对话框，经测试代理到达真实 OpenSSH（只读 SFTP），IPC stub 界面；未测真实代理软件，不保存配置 |
| C20 | SOCKS5 代理 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#经代理连接与-proxycommandc07c19c20)、[SSH_ROUTES](SSH_ROUTES.zh-CN.md#证据macos-arm64本地) | SOCKS5 代理含用户名/密码（本机测试代理）；已接入连接对话框，经测试代理到达真实 OpenSSH（只读 SFTP），IPC stub 界面；未测真实代理软件，不保存配置 |
| C21 | Jump Server 会话代理 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#协议认证代理与转发) | 原型/探针 | 真实对端 | [SSH_FORWARDING](SSH_FORWARDING.zh-CN.md#实测cargo-test---lib-forward连续-3-轮)、[SSH_ROUTES](SSH_ROUTES.zh-CN.md#证据macos-arm64本地) | 协议层跳板与连接对话框一跳跳板路线（与 C08 共用；russh 夹具作跳板、真实 OpenSSH 作目标）；无已保存跳板会话复用 |
| C22 | 隧道管理器（独立对话框、与会话绑定、状态显示） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 已打开 SSH 终端的临时端口转发面板（russh 夹具、IPC stub）不保存、不与会话配置绑定，不是隧道管理器，不计为运行证据；协议层证据计入 C16–C18 |
| C24 | SSH 算法、重协商与证书公钥类型配置 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| C25 | 主机指纹信任管理（信任/取消信任/查看） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | P0 的 known_hosts 持久化计入 C01，没有查看或取消信任的界面，不计为运行证据 |
| C26 | 连接超时、保活与 TCP 选项 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| C27 | 应用级全局代理（无/系统/HTTP/SOCKS5，代理 DNS） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | P0 代理探针与连接对话框路线只覆盖单次连接的 HTTP/SOCKS5（计入 C19、C20），没有全局或系统代理，不计为运行证据 |

### T 本地 Shell、终端与 tmux

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | macOS bash/zsh/PowerShell Core | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 真实平台 | [PTY_PROBE](PTY_PROBE.zh-CN.md#已执行检查)、[RESULTS](RESULTS.zh-CN.md#当前轮原生-pty-数据路径冒烟) | macOS zsh 真实 PTY 探针与 WKWebView 冒烟；bash、PowerShell Core 未测 |
| T02 | Linux bash/zsh/PowerShell Core | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 真实平台 | [CROSS_PLATFORM_VALIDATION](CROSS_PLATFORM_VALIDATION.zh-CN.md#平台边界)、[NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md#2-本地终端local-terminal) | Ubuntu 24.04 CI 上 Bash 真实 PTY 探针；经 tauri-driver 在 WebKitGTK 原生窗口中输入命令并读回 Bash 输出；zsh、PowerShell Core、输入法未测 |
| T03 | Windows Cmd | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 真实平台 | [WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md#实现结果更新)、[CROSS_PLATFORM_VALIDATION](CROSS_PLATFORM_VALIDATION.zh-CN.md#windows-conpty-生命周期工作分支第六次尝试通过)、[WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位)、[NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md#2-本地终端local-terminal) | cmd.exe ConPTY 生命周期（Windows Server 2022 与 2025 CI）；Server 2022 每会话多 1 个句柄，来自系统 ConPTY；经 tauri-driver 在 WebView2 原生窗口中输入命令并读回 cmd.exe 输出；输入法与真实用户环境未测 |
| T04 | Windows PowerShell | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T05 | Windows 管理员 Cmd | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T06 | Windows 管理员 PowerShell | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T07 | VT100 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#按终端类型的结论) | xterm.js 6.0.0 原样行为探针加生产 VT 适配器（vt100 身份、DECOM 下 CPR）：部分；DECDWL/DECDHL、DECSCNM/DECCOLM 等缺口 |
| T08 | VT220 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#按终端类型的结论) | 原样行为探针加生产适配器（vt220 身份、DECSCL 等级报告）：部分；SS2/SS3、S8C1T、DECSCL 不切换功能等缺口 |
| T09 | VT340 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#图形)、[TERMINAL_CORE_ADR](TERMINAL_CORE_ADR.zh-CN.md#原型) | 原样行为探针：SIXEL 被吞掉；隔离 SIXEL 原型（@xterm/addon-image 0.9.0）可绘制，但生产 CSP 阻止其 WebAssembly 解码器，未接生产终端；ReGIS 未测 |
| T10 | VT420 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#按终端类型的结论) | 原样行为探针加生产适配器（vt420 身份）：DECIC/DECDC 可用；左右边距与矩形操作缺口 |
| T11 | VT520 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#按终端类型的结论) | 原样行为探针加生产适配器（vt520 身份、DECSCUSR 报告）：部分；DECST8C 缺口，DECSCL 只改报告 |
| T12 | xterm | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#按终端类型的结论)、[VT_MATRIX](VT_MATRIX.zh-CN.md#osc-52-剪贴板)、[INPUT_PATHS](INPUT_PATHS.zh-CN.md#按键input-keysspects12-项) | 原样行为探针加生产适配器：大部分可用，XTVERSION 有回复，OSC 52 写入需会话授权、读取拒绝；按键编码探针（浏览器）；1005/1015、XTGETTCAP 等缺口 |
| T13 | xterm-256-colors | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#sgr-与颜色) | 原样行为探针：16/256 色可用 |
| T14 | Unicode 13 与宽字符 | [沉默](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#unicode-列宽回归与-ipc-契约审查)、[INPUT_PATHS](INPUT_PATHS.zh-CN.md#探针覆盖与结论) | 生产终端工厂的 Unicode 11 宽度回归，及宽字符、CDP 模拟输入法组合与跨块 UTF-8 输出探针（浏览器）；不是 Unicode 13，原生输入法未测 |
| T15 | emoji | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#unicode-列宽回归与-ipc-契约审查)、[OPENSSH_INTERACTIVE](OPENSSH_INTERACTIVE.zh-CN.md#rust-ssh_open-互操作)、[INPUT_PATHS](INPUT_PATHS.zh-CN.md#宽字符input-widespects27-项) | emoji 列宽与跨块 UTF-8（浏览器、真实 OpenSSH 输出）；ZWJ、旗帜、肤色、VS16 的列宽差距已记录（浏览器）；字形回退未测 |
| T16 | true-color | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#sgr-与颜色) | 原样行为探针：24 位色可用；DECRQSS 颜色报告靠生产适配器 |
| T17 | 终端鼠标协议 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#鼠标与焦点) | 原样行为探针：1000/1002/1003/1006 可用；1005/1015 不支持 |
| T18 | 自动换行模式 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#自动换行与反向换行) | 原样行为探针：部分；待换行列号与反向换行差异 |
| T19 | 自定义协议 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T20 | 自定义终端类型 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#适配钩子可行性公开-api)、[VT_MATRIX](VT_MATRIX.zh-CN.md#终端类型与身份回复) | 会话级 terminalType 决定身份与 DECSCL 等级回复（生产适配器）；无界面入口，TERM 不变，自定义终端类型未实现 |
| T21 | vttest 兼容范围 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#阻断-windterm-对齐的缺口) | 63 项 vttest 相关序列样本（含生产适配器）；vttest 未运行 |
| T22 | tmux 集成 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 真实对端 | [TMUX_CONTROL](TMUX_CONTROL.zh-CN.md#实测) | control-mode 解析器对真实 tmux 3.6b；无界面映射 |
| T23 | Powerline / Oh-My-Zsh | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T24 | Powerline / Oh-My-Posh | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T25 | VT52 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [TERMINAL_COMPAT](TERMINAL_COMPAT.zh-CN.md#验证) | 隔离 VT52 字节适配 PoC（浏览器）；未接生产终端 |
| T26 | VT102 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#插入删除重复与-vt220vt420-编辑) | 原样行为探针：IL/DL/ICH/DCH/IRM 可用；DA 不能报告 VT102 |
| T27 | 终端 Bell 与节流设置 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T28 | Big5 会话字符编码 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T29 | EUC-JP 会话字符编码 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#本地-shell终端与-tmux) | 仅静态 | — | — | 无 P0 原型或探针 |
| T30 | 远端读写剪贴板（OSC 52）权限 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 原型/探针 | 浏览器 | [VT_MATRIX](VT_MATRIX.zh-CN.md#osc-52-剪贴板)、[VT_MATRIX](VT_MATRIX.zh-CN.md#osc) | xterm.js 6.0.0 内核忽略 OSC 52（O04）；生产适配器读取始终拒绝、写入默认关闭并需会话级授权（浏览器）；没有询问/允许/禁止设置项，原生 WebView 剪贴板写入未验证，未与上游对照 |
| T31 | 终端键盘与初始模式设置 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 原型/探针 | 浏览器 | [INPUT_PATHS](INPUT_PATHS.zh-CN.md#按键input-keysspects12-项)、[INPUT_PATHS](INPUT_PATHS.zh-CN.md#option--alt-作为-meta) | xterm.js 6.0.0 光标键、功能键、Ctrl 组合与 Backspace 的发送字节探针；macOS Option 默认不作 Meta，应用小键盘未编码（浏览器）；没有设置项，未与上游对照 |
| T32 | 终端清屏与复位 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | VT_MATRIX X01/X02 只记录远端发送 DECSTR、RIS 时 xterm.js 的原样行为，没有用户触发的清屏或复位动作，不计为运行证据 |
| T33 | 其余会话字符集、十六进制显示与自动检测 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| T34 | 本地 Shell 会话启动参数 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | P0 本地 PTY 使用固定环境与起始目录（计入 T01–T03），没有启动参数，不计为运行证据 |

### F 文件传输与本地文件管理

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | SFTP 文件浏览 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md#真实-openssh-验收)、[RESULTS](RESULTS.zh-CN.md#只读-sftp-文件面板闭环) | 只读浏览（真实 OpenSSH sftp-server、IPC stub 面板）；无原生 WKWebView 实测 |
| F02 | SFTP 下载 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | 下载到本机“下载”文件夹，逐字节一致、不覆盖、取消后删除半成品（真实 OpenSSH sftp-server、IPC stub 面板）；无原生 WKWebView 实测，上限 64 MiB，模拟传输队列仍未接入 |
| F03 | SFTP 上传 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | 上传经 .part 校验大小后改名、显式覆盖与取消（真实 OpenSSH sftp-server、IPC stub 面板）；无原生 WKWebView 实测，上限 16 MiB，覆盖非原子，模拟传输队列仍未接入 |
| F04 | SFTP 删除 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | 删除文件、符号链接本身与空目录，非空目录与无权限被拒（真实 OpenSSH sftp-server、IPC stub 面板）；无递归删除，无原生 WKWebView 实测 |
| F05 | SFTP 重命名 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | 重命名到已存在名称被拒、到新名称成功（真实 OpenSSH sftp-server、IPC stub 面板）；不覆盖只在 OpenSSH 上有服务器端保证，无原生 WKWebView 实测 |
| F06 | SFTP 新建文件 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | 新建空文件即 0 字节不覆盖上传，同名被拒（真实 OpenSSH sftp-server、IPC stub 面板）；无原生 WKWebView 实测 |
| F07 | SFTP 新建目录 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | 中文带空格目录创建，重复创建与无权限被拒（真实 OpenSSH sftp-server、IPC stub 面板）；无原生 WKWebView 实测 |
| F08 | SCP 下载 | [矛盾](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md#scpf08f09)、[SCP](SCP.zh-CN.md#真实-openssh-夹具) | scp -f 单文件下载（真实 OpenSSH 夹具，经 SFTP 授权；含取消、重名另存、64 MiB 上限）；SFTP 文件面板有 SCP 选项（IPC stub 界面）；无目录与递归，无原生窗口实测 |
| F09 | SCP 上传 | [矛盾](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [SSH_SFTP_FIXTURE](SSH_SFTP_FIXTURE.zh-CN.md#scpf08f09)、[SCP](SCP.zh-CN.md#真实-openssh-夹具) | scp -t 单文件上传（真实 OpenSSH 夹具，经 SFTP 授权；含只读授权拒绝、父路径检查、同名替换）；SFTP 文件面板有 SCP 选项（IPC stub 界面）；无目录与递归，无原生窗口实测 |
| F10 | XModem | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [MODEM](MODEM.zh-CN.md#已验证)、[MODEM](MODEM.zh-CN.md#lrzsz-互操作2026-10-12) | sans-IO 状态机；本机对 lrzsz 0.13.1 互操作（XMODEM 校验和、CRC、1K 收发，取消与对端退出）；Linux CI 对 Ubuntu lrzsz 0.12.21rc 10/11（对端中途被杀一项失败，待查）；未接任何链路 |
| F11 | YModem | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 原型/探针 | 真实对端 | [MODEM](MODEM.zh-CN.md#已验证)、[MODEM](MODEM.zh-CN.md#lrzsz-互操作2026-10-12) | sans-IO 状态机（批量）；本机对 lrzsz 0.13.1 做 YMODEM 批量互操作（空文件、非 ASCII 名、非 128 整数倍大小）；Linux CI 对 Ubuntu lrzsz 0.12.21rc 10/11（同 F10）；未接任何链路 |
| F12 | ZModem | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | [MODEM](MODEM.zh-CN.md#adrzmodemf12) | 仅 ADR；无代码（不计为运行证据） |
| F13 | 本地文件浏览 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 原型文件面板是固定演示数据，不读本机目录（WEB_QA），不计为运行证据 |
| F14 | 本地文件移动 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F15 | 本地文件复制到目标 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F16 | 本地文件从来源复制 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F17 | 本地删除 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F18 | 本地重命名 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F19 | 本地新建文件 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F20 | 本地新建目录 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 无 P0 原型或探针 |
| F21 | 传输的其他实际选项 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#文件传输与本地文件管理) | 仅静态 | — | — | 原型传输队列的取消、失败与 8 项上限只是模拟状态机（WEB_QA），不计为运行证据 |
| F22 | 文件面板与终端当前目录同步 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| F23 | 远端文件用外部编辑器打开并回传 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| F24 | 文件面板辅助：新建链接、属性与权限编辑、复制路径/名称到终端、隐藏项 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 原型/探针 | 真实对端 | [SFTP_WRITE](SFTP_WRITE.zh-CN.md#证据macos-arm64-本地2026-10-12) | SFTP 写操作原型可改 rwx 权限位：chmod 640 后磁盘与返回值一致，经符号链接修改被拒（真实 OpenSSH sftp-server、IPC stub 面板）；无新建链接、属主与特殊权限位，无复制到终端与隐藏项，无原生窗口实测 |
| F25 | 传输队列暂停/恢复/移除与并发参数（F21 拆分） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 原型传输队列的取消、失败与 8 项上限只是模拟状态机（WEB_QA），不计为运行证据 |
| F26 | X/Y/Z Modem 冲突策略、填充与拖放协议（F21 拆分） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | MODEM 状态机与 lrzsz 互操作（计入 F10、F11）没有冲突策略与落盘，不计为运行证据 |

### G GUI 与工作流

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | 多语言界面 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G02 | 自动补全 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G03 | Free Type 模式 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [FREE_TYPE](FREE_TYPE.zh-CN.md#实测headless-chrome真实键盘事件) | 隔离草稿编辑 PoC（浏览器）；未接生产终端 |
| G04 | Focus 模式 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 紧凑布局原型只缩小间距与侧栏，UI_MAP 注明不是上游 Focus 模式，不计为运行证据 |
| G05 | 同步输入 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G06 | 用户名/密码保护 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G07 | 命令面板 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围) | 命令面板界面原型（浏览器）；未与上游命令集对照 |
| G08 | 命令发送器 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G09 | Explorer 面板 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 原型文件面板是演示数据，侧栏折叠不是 Explorer 树的展开折叠，不计为运行证据；只读 SFTP 面板的目录导航计入 F01 |
| G10 | Shell 面板 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 原型只有“本地终端”按钮，没有 Shell 面板，不计为运行证据；本地 PTY 证据计入 T01 |
| G11 | Quick Bar | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G12 | 粘贴对话框 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | INPUT_PATHS 的粘贴清洗、换行规范化与有序队列只涉及粘贴字节路径，没有粘贴对话框、预览或确认，不计为运行证据 |
| G13 | 本地/远程输入模式 | [矛盾](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G14 | Vim 键位 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G15 | 时间戳 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G16 | 文本折叠 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [FOLDING](FOLDING.zh-CN.md#实测headless-chrome) | 只读历史视图折叠 PoC；实时屏幕不能折叠 |
| G17 | 大纲 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [FOLDING](FOLDING.zh-CN.md#实测headless-chrome) | 按提示符生成大纲 PoC；上游语义待对照 |
| G18 | 分屏 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围) | 两面板分屏界面原型（浏览器）；无任意嵌套 |
| G19 | 输出配色方案 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 原型的外观选择属于 UI 主题（计入 G24），不是输出语法配色方案，不计为运行证据 |
| G20 | 文本搜索 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [HISTORY_ARCHIVE](HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机)、[FOLDING](FOLDING.zh-CN.md#实测headless-chrome) | 仅历史归档与折叠视图的搜索 PoC；无终端搜索界面 |
| G21 | 搜索预览 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G22 | 配对分隔符高亮 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G23 | 自定义分隔符 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G24 | UI 主题 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#最终白银浮层配色与正文对比度) | 浅色/深色/跟随系统外观原型与对比度测量；未与上游主题对照 |
| G25 | 标签颜色 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G26 | 已打开标签搜索 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 原型标签只能切换和逐个关闭，没有已打开标签搜索，不计为运行证据 |
| G27 | 关闭右侧标签 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 原型标签只能逐个关闭，没有关闭右侧标签，不计为运行证据 |
| G28 | 窗口透明度 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G29 | 选择即复制 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G30 | 右键粘贴 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G31 | 中键粘贴 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G32 | 在线文本搜索 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G33 | 输入时隐藏鼠标指针 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G34 | 锁屏 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G35 | Hex 编辑模式 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G36 | 虚拟空间 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G37 | 多插入符号 / 多光标 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G38 | 全屏模式 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G39 | 窗口总是置顶 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G40 | 会话 Debug 模式 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#gui-与工作流) | 仅静态 | — | — | 无 P0 原型或探针 |
| G41 | 触发器（全局/会话级） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G42 | OneKey 凭据模板与登录向导（expect/send） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G44 | 命令级导航、选择、复制与命令历史存储 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G45 | 会话颜色/图标与标签标题跟随远端 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G46 | 标签栏行为与关闭确认 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G47 | 多窗口与窗口管理器 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G48 | 停靠窗格布局、栏显隐、工具栏定制与状态栏项 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G49 | Anything 面板、跳转行/符号/会话与计算器面板 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G50 | 手动文本高亮标记（Text Marks） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G51 | 字体缩放与文本显示选项（行号、空白、行尾、缩进线、列标记） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G52 | 列/块选择与高级选择（锁定、拆分、反选、分词符） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| G53 | 用户自定义动作/键位与配置目录 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |

### S 会话

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | 会话配置对话框 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围)、[UI_MAP](UI_MAP.zh-CN.md#已实现的原型行为) | 连接表单与校验原型（浏览器）；无会话保存与编辑 |
| S02 | 会话树与分组 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 原型侧栏只列当前打开的演示会话，点击切换活动标签；没有分组层级、持久化与批量操作，不计为运行证据 |
| S03 | 会话重命名 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S04 | 会话复制 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S05 | 手动会话日志 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S06 | 自动会话日志 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S07 | 重启恢复会话 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S08 | 重启恢复布局 | [沉默](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 皆无 | — | — | UI_MAP 把标签和 SSH 终端入口列到本行，但原型明确不持久化分屏、标签、文件面板与连接配置，不计为运行证据 |
| S09 | 启动指定单会话 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S10 | 启动指定会话集合 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S11 | 会话搜索 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 浏览器 | [WEB_QA](WEB_QA.zh-CN.md#原有控件与状态覆盖保留历史范围) | 会话侧栏名称筛选原型（浏览器）；跨会话搜索未做 |
| S12 | 本地 Shell Sysmon | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S13 | SSH 远端 Sysmon | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 仅静态 | — | — | 无 P0 原型或探针 |
| S14 | 会话导入（OpenSSH config / PuTTY / Shell） | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| S15 | 地址栏快速连接与会话 URL | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| S16 | 断开/重连会话与回车重连 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |
| S17 | 重新打开已关闭视图与最近会话 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id) | 仅静态 | — | — | 无 P0 原型或探针 |

### Q 平台与性能

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| Q01 | macOS 平台 | [支持](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 真实平台 | [PERFORMANCE_BASELINE](PERFORMANCE_BASELINE.zh-CN.md#3-桌面应用release-包)、[RESULTS](RESULTS.zh-CN.md#当前轮原生交互-ssh-冒烟)、[RELEASE](RELEASE.zh-CN.md#4-本地验证) | arm64 构建、启动与原生冒烟；release .app 已排除测试二进制，声明最低 macOS 13.3（未在旧系统运行）；ad-hoc 签名，未公证 |
| Q02 | Windows 平台 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 真实平台 | [CROSS_PLATFORM_VALIDATION](CROSS_PLATFORM_VALIDATION.zh-CN.md#windows-conpty-生命周期工作分支第六次尝试通过)、[WINDOWS_CONPTY_ADR](WINDOWS_CONPTY_ADR.zh-CN.md#句柄泄漏定位)、[NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md#场景与各自证明的内容) | Windows Server 2022 与 2025 CI 构建与 cmd.exe ConPTY；WebView2 原生窗口冒烟（工作台、本地终端、SSH 终端）；无完整回归、安装与升级 |
| Q03 | Linux 平台 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 真实平台 | [CROSS_PLATFORM_VALIDATION](CROSS_PLATFORM_VALIDATION.zh-CN.md#平台边界)、[NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md#场景与各自证明的内容) | Ubuntu 24.04 CI 构建与 PTY 探针；WebKitGTK 原生窗口冒烟（Xvfb 下的工作台、本地终端、SSH 终端）；无完整回归、包与升级 |
| Q04 | 动态内存压缩 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 浏览器 | [HISTORY_ARCHIVE](HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机) | 压缩冷历史 PoC（约 7.4 倍）；未接生产终端 |
| Q05 | 吞吐与低延迟 | [部分](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 真实平台 | [PERFORMANCE_BASELINE](PERFORMANCE_BASELINE.zh-CN.md#1-rust-pty-吞吐与-ctrl-c-延迟)、[PTY_READINESS](PTY_READINESS.zh-CN.md#本机配对结果) | 本机嘈杂环境基线；无 GUI 全链路，无 WindTerm 对比 |
| Q06 | 大规模滚动历史 | [矛盾（弱）](UPSTREAM_STATIC_REVIEW.zh-CN.md#会话平台与性能) | 原型/探针 | 浏览器 | [HISTORY_ARCHIVE](HISTORY_ARCHIVE.zh-CN.md#实测headless-chromemacos-arm64本机) | 有界热窗口加压缩冷历史与缺口上报 PoC；未接生产终端 |

### 冻结后新增（2026-10-12 用户批准）

来源为 [Windows/Linux 静态复核的平台专属候选](UPSTREAM_STATIC_REVIEW_WINLINUX.zh-CN.md#平台专属候选提议未分配-id)。WL-1、WL-2、WL-3 分别分配为 T35、T36、T37；三项仅有 Windows 发布包静态证据，行为尚未验证。

| ID | 能力 | 静态结论 | P0 分组 | 证据层级 | P0 证据 | 覆盖范围与缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| T35 | WSL 发行版作为本地 Shell 会话（枚举、启动、当前目录检测） | [支持](UPSTREAM_STATIC_REVIEW_WINLINUX.zh-CN.md#平台专属候选提议未分配-id) | 仅静态 | — | — | P0 本地 PTY 在 macOS 与 Linux 上运行，Windows 只验证了 cmd.exe（计入 T01–T03），没有 WSL 发行版枚举或启动，不计为运行证据 |
| T36 | Git Bash 与 Cygwin 本地 Shell 自动发现 | [支持](UPSTREAM_STATIC_REVIEW_WINLINUX.zh-CN.md#平台专属候选提议未分配-id) | 仅静态 | — | — | P0 本地 PTY 没有 Git Bash 或 Cygwin 的发现与启动，Windows 只验证了 cmd.exe（计入 T03），不计为运行证据 |
| T37 | cmd 会话注入 Clink 行编辑 | [支持](UPSTREAM_STATIC_REVIEW_WINLINUX.zh-CN.md#平台专属候选提议未分配-id) | 仅静态 | — | — | P0 的 Windows cmd 会话是 cmd.exe /D /Q /K，不带 Clink，也关闭了 AutoRun（计入 T03），不计为运行证据 |

## (e) 冻结前需要用户决定的事项

“阻断”表示不决定就无法冻结；“不阻断”表示可以先冻结，按变更规则后补。

**2026-10-12 用户对 E1–E12 全部按建议作出决定**，见末列与[决定记录](#决定记录2026-10-12)。前五列保留提议时的原文。

2026-10-12 刷新时逐项核对过：新合入的证据都是本项目原型的运行证据，没有一项涉及上游 WindTerm 2.7.0 的实机行为，因此不直接回答 E1–E12 中任何一项，下表的选项与建议保持原样。与候选 F24、T30、C22、G43、T31 有关的原型已写入 [(b)](#b-36-项静态候选) 表的理由列，不改变其中的建议；T14 的补充证据见 [c1](#c1-t14-unicode-13-与宽字符)。

| 编号 | 决定事项 | 可选项 | 建议 | 是否阻断冻结 | 决定（2026-10-12） |
| --- | --- | --- | --- | --- | --- |
| E1 | 冻结依据 | (i) 先授权在隔离副本中运行上游 2.7.0（x86_64，需 Rosetta）做实机盘点，再冻结；(ii) 以“README + 静态证据”冻结，实机结果按变更规则修订 | (ii) 先冻结 ID 集合与措辞；同时授权 (i) 的实机盘点，用于 a1、a2、a3、c2 等待实测项 | 阻断 | 已决定：采纳 (ii)，以 README 加静态证据冻结；同时授权 (i) 的实机盘点（隔离副本，x86_64 经 Rosetta，隔离 profile，不读取用户数据），盘点结果按变更规则修订待实测行 |
| E2 | G13 措辞 | [a1](#a1-g13本地远程模式快捷键) 的 A、B、C | B | 阻断 | 已决定：B |
| E3 | F08/F09 处理 | [a2](#a2-f08f09scp-是否属于-27-实际功能) 的 A、B、C | B | 阻断 | 已决定：B；F08、F09 计数标记为“先确认上游是否存在” |
| E4 | Q06 措辞 | [a3](#a3-q06unlimited与默认-999999-行) 的 A、B、C | B | 阻断 | 已决定：B |
| E5 | C14 措辞与资源 | [a4](#a4-c14gssapi-已随发布包链接) 的 A、B、C；另需提供测试 Kerberos 领域，或批准在 Linux CI 容器中搭建 KDC | A；资源可在冻结后提供 | 措辞阻断，资源不阻断 | 已决定：A（措辞与未测原因）；状态保持“待实测”，是否改变未决定；测试 Kerberos 领域在冻结后提供 |
| E6 | G02 措辞与补全数据来源 | [a5](#a5-g02自动补全已有完整资源) 的 A、B；是否确认“不复制上游命令定义文件” | A，并确认数据来源约束 | 阻断 | 已决定：A，并确认不复制上游命令定义文件 |
| E7 | S11、G17、G33、F21 的措辞 | [a6](#a6-其他需要同步决定的措辞) 中的建议 | 全部采纳 | 阻断 | 已决定：全部采纳 |
| E8 | 36 项静态候选 | 逐项确认[(b)](#b-36-项静态候选)的纳入、不纳入或暂缓；确认编号规则（不复用） | 按表采纳：纳入 31、不纳入 1、暂缓 4 | 阻断 | 已决定：按表采纳，纳入 31（ID 与名称同 (b) 表）、不纳入 G43（两点并入 T12、G12）、暂缓 C23、C28、G54、G55；编号不复用 |
| E9 | T14 验收依据 | [c1](#c1-t14-unicode-13-与宽字符) 的措辞 | 采纳 | 阻断 | 已决定：采纳 |
| E10 | S08 处理 | [c2](#c2-s08-重启恢复布局) 的 A、B、C | 冻结时先用 C，实机后改为 A 或 B | 阻断 | 已决定：C（上游未证实，不计入对齐完成率）；实机盘点后改为 A 或 B |
| E11 | 是否先静态核对 Windows/Linux 上游包 | 静态复核只检查了 macOS 包；T02–T06、Q02、Q03 只有部分证据，C23 也依赖 Windows 包 | 冻结前补做同样只读的静态核对，或明确在冻结后补 | 不阻断，但影响 C23 和 T 系列措辞 | 已决定：冻结后补做，列为后续事项 |
| E12 | 冻结后的变更规则与 `scope_frozen` 置位 | 确认[冻结的含义](#冻结的含义2026-10-12-已批准)中的规则；由谁批准、何时把 `scope_frozen` 置为 `true` | 用户批准本提议后，一次性更新三处台账、扩展结构验证、置位并提交 | 阻断 | 已决定：批准变更规则；`scope_frozen` 于 2026-10-12 置为 `true`，由用户批准 |

以下资源不影响冻结，但相关行在提供之前无法取得运行证据：

| 资源 | 涉及 ID |
| --- | --- |
| USB 串口设备 | C04 |
| XQuartz 安装许可（Linux 上的 Xvfb 方案已在 CI 运行） | C15 在 macOS 上的验证 |
| 测试 Kerberos 领域 | C14 |
| 网络设备或其它 telnetd 实现（本机 Apple telnetd 308 已测，见 [NET_TERMINAL](NET_TERMINAL.zh-CN.md#真实-telnetd-互操作2026-10-12)） | C02 |
| 原生 IME 与 VoiceOver 实机 | T14、T15 等 |

## 复核

- 三处台账的证据索引一致性与锚点有效性：运行[结构验证](BASELINE_EVIDENCE.zh-CN.md#结构验证)中的三段脚本。第一段检查冻结后的结构（164 项、原 117 项名称、31 项冻结新增、3 项冻结后新增与保留编号、`scope_frozen`），第二段检查证据索引、对齐计数标记与本文 (d)、(e) 两节。同一节的第三段脚本与冻结前的提交对照，确认原有 130 行的名称、阶段与状态没有改变。
- 本文的数字可以从 baseline.json 的 `evidence_refresh`、`baseline_freeze`、`static_review_conclusion`、`p0_evidence_group`、`p0_evidence_level` 和 `parity_counting` 字段复算。
- 静态候选的原始定位与证据类型以[静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md)为准；本文只做摘要。
