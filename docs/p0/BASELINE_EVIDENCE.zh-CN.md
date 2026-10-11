# P0 第二轮基线证据与复核方法

日期：2026-10-11。只补齐已观察入口和默认资源对应的验收条目；不重新启动上游应用、不访问用户配置、不增加本轮协议实测结论。原始117个ID及名称保留；新增13个ID后共130项。新增中11项入口已观察、2项仅静态候选，**新增行为已测0项、未测13项**。GSSAPI C14的文档冲突仍未解。

## 来源、身份与证据等级

发布包为[官方 WindTerm 2.7.0 macOS release](https://github.com/kingToolbox/WindTerm/releases/tag/2.7.0)的隔离副本，DMG/执行文件身份见[基线台账](BASELINE.zh-CN.md#固定来源与身份)。默认资源定位均相对 `WindTerm-P0.app/Contents/MacOS/`，公开源码固定在[`a8336c1`](https://github.com/kingToolbox/WindTerm/tree/a8336c1d1e3dd1a981500dae8ef9eb42066de95f)。未将带专有标记的term规则、菜单脚本或资源复制到新应用；以下只记录功能事实、相对定位与哈希。

| 等级 | 意义 | 不能据此作出的结论 |
| --- | --- | --- |
| D 文档声明 | README或产品说明写有功能 | 不能认定当前发布版成功运行 |
| R 静态资源 | 默认字段、term定义或菜单动作存在 | 不能认定对应代码启用或行为正确 |
| S 源码配置 | 公开源码有配置/条件编译路径 | 不能认定发布包使用该构建参数 |
| U入口 | 隔离上游UI显示选项/控件 | 不能认定操作、协议或安全语义通过 |
| 行为已测 | 固定步骤、预期/实际、fixture与运行证据齐备 | 仍只覆盖所执行案例；本轮新增项均未达到此级 |

下列UI记录来自本会话主执行通道先前通过CUA操作隔离2.7副本后的即时观察，本轮按记录归档，未重新操作。**本报告没有对应可随仓库复查的原始截图/AX快照文件**，所以只用于入口盘点；正式行为验收时必须补独立运行记录，不能把这些段落当重放成功的证据。

## E-UI-AUTH

会话创建对话框观察到 Shell、SSH、Telnet、Tcp、Serial；SSH认证页可见密码、公钥、keyboard-interactive、gssapi-with-mic、服务器指纹验证、身份文件和认证后执行命令。映射既有 C01–C05、C11–C14、T01、S01。GSSAPI选项默认勾选这一观察仅描述UI状态，没有真实KDC认证成功记录。此前通用证据文字已拆正，不再将每个协议入口都描述为GSSAPI证据。

## E-UI-TERM

终端类型下拉观察到 vt100、vt102、vt220、vt340、vt420、vt52、vt520、xterm-256color、xterm。既有T07–T13保持不变，新增 **T25 VT52**、**T26 VT102**。两个发布包term文件进一步证实配置定义存在；文件存在不说明设备应答、输入键码或屏幕行为已通过。新项目现有VT52有限原型见[终端兼容报告](TERMINAL_COMPAT.zh-CN.md)，与上游行为台账分开。

## E-UI-SETTINGS

会话设置中观察到 Bell、Big5、EUC-JP及Sysmon入口。Bell映射 **T27**；两种已观察编码分别映射 **T28/T29**，不预先枚举未观察的编码。

Sysmon观察没有明确区分本地和SSH各自入口。默认配置却有独立的 `shell.sysmon` 与 `ssh.sysmon` 字段，所以分别建立 **S12/S13静态候选**，两行 `upstream_ui=not_tested`；不能把通用控件观察重复计成两项已确认入口。指标种类、采样来源、依赖命令和支持平台均未确认。

## E-UI-MODE

模式菜单观察到远程/本地模式、Hex编辑、自动换行、虚拟空间、多插入符号、专注模式/设置、全屏、总是置顶、锁屏及调试模式。已有G13/T18/G04/G34吸收对应入口记录；新增 **G35 Hex**、**G36虚拟空间**、**G37多光标**、**G38全屏**、**G39置顶**、**G40 Debug**。没有执行输入/模式切换行为；尤其不将Hex解释为完整文件编辑器，不将Debug解释为任意协议调试功能，不将多光标等同G05同步输入。

## 默认资源复核定位

| ID | 相对资源定位 | 静态结论 |
| --- | --- | --- |
| T25 | `terminal/terms/vt52.term:3` | 独立终端定义存在 |
| T26 | `terminal/terms/vt102.term:3` | 独立终端定义存在 |
| T27 | `terminal/configs/session.config:54`、`global/locales/zh-CN.locale:3541` | Bell间隔/样式默认字段与设置文案存在；数字值不用于猜测具体样式 |
| T28/T29 | E-UI-SETTINGS | 本轮限定资源中没有额外记录编码映射实现；只保留已有UI观察 |
| S12/S13 | `terminal/configs/session.config:37`、`:47` | 本地/SSH默认Sysmon字段分别存在；不是两个UI入口实测 |
| G35 | `global/wind.actions:1939`、`terminal/configs/menu.config:727` | Hex模式动作及菜单入口存在 |
| G36 | `global/wind.config:124`、`global/wind.actions:2004` | 虚拟空间开关及动作存在 |
| G37 | `global/wind.config:118`、`global/wind.actions:1986` | 多插入符号开关及动作存在 |
| G38 | `terminal/configs/menu.config:736`、`global/wind.actions:2603` | 窗口全屏动作存在 |
| G39 | `terminal/configs/menu.config:737`、`global/wind.actions:2576` | 置顶动作存在 |
| G40 | `terminal/configs/menu.config:741`、`global/wind.actions:2586` | 当前终端视图Debug开关存在 |

SHA-256：

| 相对资源 | 哈希 |
| --- | --- |
| `terminal/terms/vt52.term` | `85aba9adfb0bd3c3a00be361a2faf3cbb1c665563246e11ff6dae8e9286b7c72` |
| `terminal/terms/vt102.term` | `0c1b8f01890140717592a255df6d8f880e5905af700656a1a58ea10a1cf3f2df` |
| `terminal/configs/menu.config` | `6e8c9cd3055dc811271aef2c9465c606952c67dcb2cfab03d296d33015245622` |
| `global/wind.config` | `dd39069ee518050e9b5d6c5b8b54054e86f6719a08bd8917c62cd5059320b10d` |
| `global/locales/zh-CN.locale` | `43fe4e285fe8718b88ab33c630c6726a7c9a6557a0586f5d0a4aef9dfdc66c1d` |

## C14 GSSAPI 证据范围

[固定README功能段](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#ssh-telnet-tcp-shell-serial-tmux)列出gssapi-with-mic；[同一README路线图](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#roadmap-of-v27-february-2025-for-reference-only)又将SSH GSSAPI认证延期。2.7实际UI有选项，默认会话资源也有字段，故可以确认的是“产品暴露了配置入口”。

第三方libssh的[DefineOptions.cmake](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/libssh/DefineOptions.cmake#L1)默认请求GSSAPI构建，但[ConfigureChecks.cmake](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/libssh/ConfigureChecks.cmake#L463)在依赖探测失败时可以关闭该选项。**构建选项存在既不能证明发布包启用GSSAPI，也不能证明上层调用或端到端认证成功**；当前无发布构建日志或受控KDC运行证据，冲突保留。

C14关闭问题所需最小实验：建立隔离KDC/sshd、客户端测试票据和专用测试用户；服务端限制为目标认证方式或通过日志明确最终使用的方式，防止密码/公钥回退掩盖失败；分别测试有效、过期、缺失票据与错误服务主体，记录最终认证方法/结果及错误反馈。日志脱敏；不复用生产票据。当前台账没有声称任何一个案例已运行。

## 结构验证

在仓库根目录运行以下只读命令，验证130项唯一ID、117个原ID与名称保留、三份台账一致、13项新增证据分级及未通过状态：

```sh
python3 - <<'PY'
from pathlib import Path
import json, re
root = Path('.')
data = json.loads((root / 'docs/p0/baseline.json').read_text())
features = data['features']
ids = [f['id'] for f in features]
initial = {
    f'{prefix}{number:02d}'
    for prefix, count in {'C': 21, 'T': 24, 'F': 21, 'G': 34, 'S': 11, 'Q': 6}.items()
    for number in range(1, count + 1)
}
new = [f for f in features if f['scope_origin'] == 'p0_round_2']
assert len(ids) == len(set(ids)) == 130
assert {f['id'] for f in features if f['scope_origin'] == 'initial_117'} == initial
expected_new = {f'T{n}' for n in range(25, 30)} | {f'G{n}' for n in range(35, 41)} | {'S12', 'S13'}
assert set(ids) - initial == expected_new and len(new) == 13
for name in ['docs/FEATURE_PARITY.zh-CN.md', 'docs/p0/BASELINE.zh-CN.md']:
    rows = re.findall(r'^\| ([CTFGSQ]\d\d) \| ([^|]+?) \|', (root / name).read_text(), re.M)
    assert len(rows) == 130 and len(dict(rows)) == 130, name
    assert dict(rows) == {f['id']: f['capability'] for f in features}, name
assert sum(f['scope_classification'] == 'entry_observed' for f in new) == 11
assert sum(f['scope_classification'] == 'static_candidate' for f in new) == 2
assert all(f['upstream_behavior'] == 'not_tested' and f['parity'] == 'not_verified' for f in new)
assert all(f['evidence'] and f['verification_path'] and f['not_tested_reason'] for f in new)
assert data['scope_frozen'] is False
print('PASS: 130 unique IDs; 117 preserved IDs; 13 additions (11 entry / 2 static); no added behavior pass')
PY
```

上述命令验证当前结构与名称一致性；原始117行名称是否被更名，另与本轮修改前的Git HEAD作只读比对。结构通过不代表任何功能行为通过。
