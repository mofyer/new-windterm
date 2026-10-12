# P0 第二轮基线证据与复核方法

日期：2026-10-11；2026-10-12 补记基线冻结。只补齐已观察入口和默认资源对应的验收条目；不重新启动上游应用、不访问用户配置、不增加本轮协议实测结论。原始117个ID及名称保留；新增13个ID后共130项。新增中11项入口已观察、2项仅静态候选，**新增行为已测0项、未测13项**。GSSAPI C14的文档冲突仍未解。

**2026-10-12 冻结**：用户批准冻结功能基线（[决定记录](BASELINE_FREEZE_PROPOSAL.zh-CN.md#决定记录2026-10-12)），依据为 README 加上游静态证据。ID 集合从 130 项变为 161 项：静态候选中纳入 31 项（见[冻结新增 31 项的证据](#冻结新增-31-项的证据2026-10-12)），G43 不纳入，C23、C28、G54、G55 暂缓。冻结没有改变任何一行的状态；新增 31 项行为已测 0 项。用户同时授权实机盘点上游，见[授权记录](#上游实机盘点授权e12026-10-12)。

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

## 上游实机盘点授权（E1，2026-10-12）

用户在冻结决定 E1 中选择以 README 加静态证据冻结，同时授权实机盘点上游 WindTerm 2.7.0。授权条件：

- 只在隔离副本中运行上游 2.7.0 的 x86_64 构建，经 Rosetta 执行；
- 使用隔离 profile，**不读取用户数据**（用户 profile、凭据、会话与配置）；
- 不复制上游代码、图标、二进制或带专有标记的资源到本项目，只记录行为事实、步骤与证据；
- 盘点结果按[冻结的变更规则](BASELINE_FREEZE_PROPOSAL.zh-CN.md#冻结的含义2026-10-12-已批准)修订“待实测”行与相关措辞：新能力只以新 ID 补入，不删除 ID，措辞修改附证据与理由，并同步三处台账、重跑下文的结构验证。

截至本文更新，**实机盘点尚未开始**；本文和三处台账中没有任何来自该盘点的结论。优先核对的事项见[决定记录](BASELINE_FREEZE_PROPOSAL.zh-CN.md#决定记录2026-10-12)的后续事项：G13 默认快捷键、F08/F09 的 SCP 入口、Q06 可设最大值、S08 恢复范围、G33 隐藏对象、C14 认证入口、T14 列宽、S11 会话搜索含义，以及 31 个新增 ID 的实际行为。Windows/Linux 上游包的只读静态核对（E11）同样列为冻结后的后续事项。

## 冻结新增 31 项的证据（2026-10-12）

新增 31 项来自[上游静态复核的候选表](UPSTREAM_STATIC_REVIEW.zh-CN.md#静态候选不在-130-项内未分配-id)，ID 与能力名称同[冻结提议 (b)](BASELINE_FREEZE_PROPOSAL.zh-CN.md#b-36-项静态候选)。写法沿用第二轮新增项：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `scope_origin` | `baseline_freeze_2026_10_12` | 区别于 `initial_117` 与 `p0_round_2` |
| `scope_classification` | `static_candidate` | 与 S12/S13 相同：只有静态证据，没有 UI 入口观察 |
| `evidence` | `bundle_static_resource` 与 `upstream_static_review` 各一条 | 前者摘录候选表中的相对定位（`MNU`、`SCF`、`BIN` 等缩写见[静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md#路径缩写均相对-reference)），后者链接候选表；T30、T31、F24 另有 `p0_prototype_probe` |
| `static_review_conclusion` | `supported` | 候选的纳入标准（发布包有明确的菜单、动作、配置或字符串）与“支持”的定义一致；仍只是静态证据 |
| `upstream_ui`、`upstream_behavior` | `not_tested` | 上游入口与行为都没有实测 |
| `implementation_status` | `not_delivered` | 功能矩阵状态为“未实现” |
| `static_candidate_no` | 1–34 中的 31 个 | 候选表序号 |

baseline.json 的 `baseline_freeze` 记录决定、候选序号与 ID 的对应、不纳入（G43）与暂缓（C23、C28、G54、G55）的候选和不复用的编号，以及对齐计数标记 `parity_counting` 的含义。冻结新增行没有复制上游资源内容，只引用相对定位与短键名。

## C14 GSSAPI 证据范围

[固定README功能段](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#ssh-telnet-tcp-shell-serial-tmux)列出gssapi-with-mic；[同一README路线图](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/README.md#roadmap-of-v27-february-2025-for-reference-only)又将SSH GSSAPI认证延期。2.7实际UI有选项，默认会话资源也有字段，故可以确认的是“产品暴露了配置入口”。

第三方libssh的[DefineOptions.cmake](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/libssh/DefineOptions.cmake#L1)默认请求GSSAPI构建，但[ConfigureChecks.cmake](https://github.com/kingToolbox/WindTerm/blob/a8336c1d1e3dd1a981500dae8ef9eb42066de95f/src/libssh/ConfigureChecks.cmake#L463)在依赖探测失败时可以关闭该选项。**构建选项存在既不能证明发布包启用GSSAPI，也不能证明上层调用或端到端认证成功**；当前无发布构建日志或受控KDC运行证据，冲突保留。

2026-10-11 的[上游静态复核](UPSTREAM_STATIC_REVIEW.zh-CN.md#最重要的矛盾与张力)补充了链接层证据：主程序导入 `_ssh_userauth_gssapi`，随包 libssh 链接 Kerberos.framework。这说明发布构建启用了 GSSAPI，但仍不能证明端到端认证成功。措辞选项见[冻结提议](BASELINE_FREEZE_PROPOSAL.zh-CN.md#a4-c14gssapi-已随发布包链接)。

2026-10-12 冻结决定 E5 采纳冻结提议 a4 的选项 A：C14 的验收要点改为在受控 KDC/sshd 上完成认证并区分有效、过期、缺失票据与错误服务主体，未测原因改为“链接层证据显示发布构建启用 GSSAPI；仍缺 KDC 端到端认证”。状态保持“待实测”，是否改为“未实现”没有决定；测试 Kerberos 领域由用户在冻结后提供。

C14关闭问题所需最小实验：建立隔离KDC/sshd、客户端测试票据和专用测试用户；服务端限制为目标认证方式或通过日志明确最终使用的方式，防止密码/公钥回退掩盖失败；分别测试有效、过期、缺失票据与错误服务主体，记录最终认证方法/结果及错误反馈。日志脱敏；不复用生产票据。当前台账没有声称任何一个案例已运行。

## 结构验证

在仓库根目录运行以下只读命令。第一段与第二段是每次修改台账后必须通过的检查；第三段是冻结时与冻结前提交的一次性对照，需要 Git 历史。

第一段验证冻结后的结构：

- 161 个唯一 ID；
- 原始 117 个 ID 与名称不变（名称按 2026-10-11 的值做 SHA-256 比对），第二轮 13 项同样比对；
- 130 → 161：新增的 31 个 ID 与能力名称和[冻结提议 (b)](BASELINE_FREEZE_PROPOSAL.zh-CN.md#b-36-项静态候选)中“纳入”的行一致，没有删除任何 ID；
- 不纳入与暂缓的编号（G43、C23、C28、G54、G55）不作为 ID 出现，候选序号 1–36 全部有去向；
- 两份 Markdown 台账的名称、阶段、验收要点与验证路径和 baseline.json 一致，新增行状态为“未实现”；
- 新增项都没有上游行为通过或对齐通过；
- `scope_frozen` 为 `true`，冻结日期为 2026-10-12。

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json, re
root = Path('.')
data = json.loads((root / 'docs/p0/baseline.json').read_text())
features, freeze = data['features'], data['baseline_freeze']
byid = {f['id']: f for f in features}
ids = [f['id'] for f in features]
initial = {f'{p}{n:02d}' for p, c in {'C': 21, 'T': 24, 'F': 21, 'G': 34, 'S': 11, 'Q': 6}.items() for n in range(1, c + 1)}
round2 = {f'T{n}' for n in range(25, 30)} | {f'G{n}' for n in range(35, 41)} | {'S12', 'S13'}
added = ({'C22'} | {f'C{n}' for n in range(24, 28)} | {f'T{n}' for n in range(30, 35)} | {f'F{n}' for n in range(22, 27)}
         | {'G41', 'G42'} | {f'G{n}' for n in range(44, 54)} | {f'S{n}' for n in range(14, 18)})
held = {'C23', 'C28', 'G43', 'G54', 'G55'}
origin = lambda o: {f['id'] for f in features if f['scope_origin'] == o}
assert len(ids) == len(set(ids)) == 161 and len(added) == 31
assert origin('initial_117') == initial and origin('p0_round_2') == round2 and origin('baseline_freeze_2026_10_12') == added
assert set(ids) == initial | round2 | added and not set(ids) & held
assert set(freeze['reserved_ids_never_reused']) == held and set(freeze['added_ids']) == added
assert {c['proposed_id'] for c in freeze['deferred_candidates']} == {'C23', 'C28', 'G54', 'G55'}
assert {c['proposed_id'] for c in freeze['excluded_candidates']} == {'G43'}
cand = {c['candidate']: c['id'] for c in freeze['candidate_id_map']}
held_no = [c['candidate'] for c in freeze['deferred_candidates'] + freeze['excluded_candidates']]
assert set(cand.values()) == added and sorted([*cand, *held_no]) == list(range(1, 37))
assert all(byid[i]['static_candidate_no'] == n for n, i in cand.items())
digest = lambda s: hashlib.sha256('\n'.join(f"{i}\t{byid[i]['capability']}" for i in sorted(s)).encode()).hexdigest()
assert digest(initial) == '063efb312ef2adca043e75ef022308354de768076b6d7dfc9fe44b837af3c926'
assert digest(round2) == 'b66861cc8e128d09d5064b7c3a17b2900fd6760b4fe0963d3b87dda7cab389aa'
proposal = (root / 'docs/p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md').read_text().split('## (b) ', 1)[1].split('\n## ', 1)[0]
b = re.findall(r'^\| (\d+) \| ([CTFGS]\d\d) \| ([^|]+?) \| [^|]+ \| [^|]+ \| ([^|]+?) \|', proposal, re.M)
assert len(b) == 36 and all(cand.get(int(n)) == i or i in held for n, i, _, _ in b)
assert {i: name for _, i, name, rec in b if rec.startswith('纳入')} == {i: byid[i]['capability'] for i in added}
assert {i for _, i, _, rec in b if not rec.startswith('纳入')} == held
fp = (root / 'docs/FEATURE_PARITY.zh-CN.md').read_text()
bl = (root / 'docs/p0/BASELINE.zh-CN.md').read_text()
for text in (fp, bl):
    rows = re.findall(r'^\| ([CTFGSQ]\d\d) \| ([^|]+?) \|', text, re.M)
    assert len(rows) == 161 and dict(rows) == {f['id']: f['capability'] for f in features}
fp_rows = {m[1]: m.groups()[1:] for m in re.finditer(r'^\| ([CTFGSQ]\d\d) \| [^|]+? \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \|', fp, re.M)}
bl_rows = {m[1]: m[2] for m in re.finditer(r'^\| ([CTFGSQ]\d\d) \| [^|]+? \| [^|]+? \| ([^|]+?) \|', bl, re.M)}
for f in features:
    assert fp_rows[f['id']][:2] == (f['phase'], f['acceptance']) and f['verification_path'].endswith(f['acceptance']), f['id']
    assert bl_rows[f['id']] == f"{f['verification_path']} **未测原因：**{f['not_tested_reason']}", f['id']
assert all(fp_rows[i][2] == '未实现' for i in added)
r2, r3 = [byid[i] for i in round2], [byid[i] for i in added]
assert sum(f['scope_classification'] == 'entry_observed' for f in r2) == 11
assert sum(f['scope_classification'] == 'static_candidate' for f in r2) == 2
assert all(f['scope_classification'] == 'static_candidate' and f['upstream_ui'] == 'not_tested' for f in r3)
assert all(f['upstream_behavior'] == 'not_tested' and f['parity'] == 'not_verified' and f['implementation_status'] == 'not_delivered'
           and f['evidence'] and f['verification_path'] and f['not_tested_reason'] for f in r2 + r3)
assert {f.get('parity_counting') for f in features} <= set(freeze['parity_counting_meaning']) - {'absent'} | {None}
assert data['scope_frozen'] is True and freeze['frozen_on'] == '2026-10-12' and freeze['id_count_after'] == 161
print('PASS: 161 unique IDs; 117 original IDs and names preserved; 130 -> 161 (+31 freeze IDs, names as in proposal (b));'
      ' 5 held candidate IDs absent; scope frozen on 2026-10-12; no added behavior pass')
PY
```

第二段核对证据索引，范围如下：

- 每个 ID 在 baseline.json、两份 Markdown 台账和[冻结提议](BASELINE_FREEZE_PROPOSAL.zh-CN.md)(d) 节中，静态复核结论、P0 分组、证据链接、已决链接、对齐计数标记与说明一致；
- 所有证据链接指向的文件和标题锚点存在；
- 分组与 `p0_evidence_level` 自洽，`evidence_refresh` 中的计数和冻结提议 (d) 节的分系列计数可以复算；
- 冻结提议有决定记录，(e) 节 E1–E12 每行都有决定列；
- `scope_frozen` 为 `true`，31 个候选已分配 ID，5 个没有。

```sh
python3 - <<'PY'
from pathlib import Path
import json, os, re, unicodedata
root = Path('.')
data = json.loads((root / 'docs/p0/baseline.json').read_text())
features, refresh = data['features'], data['evidence_refresh']
LABEL = {'supported': '支持', 'partial': '部分', 'contradicting': '矛盾', 'contradicting_weak': '矛盾（弱）', 'silent': '沉默'}
GROUP = {'prototype_or_probe': '原型/探针', 'static_only': '仅静态', 'neither': '皆无'}
LEVEL = {'real_peer': '真实对端', 'real_platform': '真实平台', 'loopback_fixture': 'loopback 夹具', 'browser': '浏览器'}
COUNT = {'upstream_unconfirmed': '上游未证实，不计入对齐完成率',
         'conditional_upstream_check': '先确认上游是否存在；确认不存在则标为本项目增强项，不计入对齐完成率',
         'project_enhancement': '本项目增强项，不计入对齐完成率'}
LINK = re.compile(r'\[([^\]]+)\]\(([^)\s]+)\)')
cache = {}

def anchors(path):
    if path not in cache:
        cache[path], seen, fence = set(), {}, False
        for line in path.read_text().splitlines():
            fence ^= line.startswith('`' * 3)
            m = None if fence else re.match(r'#{1,6} (.+)', line)
            if m:
                text = LINK.sub(r'\1', m.group(1)).replace('`', '').lower()
                s = ''.join(c for c in text if unicodedata.category(c)[0] in 'LNM' or c in '-_ ').replace(' ', '-')
                seen[s] = seen.get(s, -1) + 1
                cache[path].add(s if seen[s] == 0 else f'{s}-{seen[s]}')
    return cache[path]

def resolve(base, target):
    name, _, frag = target.partition('#')
    path = Path(os.path.normpath(base / name))
    assert path.is_file() and (not frag or frag in anchors(path)), (base, target)
    return f'{path.as_posix()}#{frag}'

expected = {}
for f in features:
    refs = {t: [resolve(root, e['source']) for e in f['evidence'] if e['type'] == t]
            for t in ('upstream_static_review', 'p0_prototype_probe', 'p0_decision_record')}
    group, level = f['p0_evidence_group'], f.get('p0_evidence_level')
    assert len(refs['upstream_static_review']) == 1 and group in GROUP, f['id']
    assert (group == 'prototype_or_probe') == bool(refs['p0_prototype_probe']) == (level in LEVEL), f['id']
    assert (group == 'neither') == (f['static_review_conclusion'] == 'silent' and not refs['p0_prototype_probe']), f['id']
    decision = f.get('freeze_decision_ref')
    expected[f['id']] = dict(static=(LABEL[f['static_review_conclusion']], refs['upstream_static_review'][0]),
                             group=GROUP[group], p0=refs['p0_prototype_probe'] + refs['p0_decision_record'],
                             decision=decision and resolve(root, decision), count=COUNT.get(f.get('parity_counting')),
                             note=f.get('p0_evidence_note'), level=LEVEL.get(level, '—'))
assert all(f.get('parity_counting') in COUNT for f in features if 'parity_counting' in f)
CELL = re.compile(r'静态：\[(.+?)\]\((\S+?)\)；P0：(原型/探针|仅静态|皆无)(.*?)(?:；已决：\[冻结提议\]\((\S+?)\))?'
                  r'(?:；计数：([^。]+))?(?:。说明：(.+))?')
for name, with_note in [('docs/FEATURE_PARITY.zh-CN.md', False), ('docs/p0/BASELINE.zh-CN.md', True)]:
    doc = root / name
    rows = {m[1]: m[2] for m in re.finditer(r'^\| ([CTFGSQ]\d\d) \|.* \| (静态：.+) \|$', doc.read_text(), re.M)}
    assert rows.keys() == expected.keys(), name
    for fid, cell in rows.items():
        label, static, group, rest, decision, count, note = CELL.fullmatch(cell).groups()
        got = dict(static=(label, resolve(doc.parent, static)), group=group,
                   p0=[resolve(doc.parent, t) for _, t in LINK.findall(rest)],
                   decision=decision and resolve(doc.parent, decision), count=count,
                   note=note if with_note else expected[fid]['note'])
        assert got == {k: expected[fid][k] for k in got}, (name, fid)
doc = root / 'docs/p0/BASELINE_FREEZE_PROPOSAL.zh-CN.md'
text = doc.read_text()
section = text.split('## (d) ', 1)[1].split('\n## ', 1)[0]
rows = [[c.strip() for c in line.strip('|').split(' | ')] for line in section.splitlines() if re.match(r'\| [CTFGSQ]\d\d \|', line)]
assert sorted(r[0] for r in rows) == sorted(expected), 'proposal (d) rows'
for fid, _, static, group, level, links, note in rows:
    want = expected[fid]
    (label, target), = LINK.findall(static)
    assert (label, resolve(doc.parent, target)) == want['static'] and group == want['group'] and level == want['level'], fid
    assert [resolve(doc.parent, t) for _, t in LINK.findall(links)] == want['p0'], fid
    assert note.removesuffix('（不计为运行证据）') == (want['note'] or '无 P0 原型或探针'), fid
count = lambda key, value: sum(1 for f in features if f.get(key) == value)
groups = {g: count('p0_evidence_group', g) for g in GROUP}
assert refresh['p0_evidence_counts'] == groups and refresh['p0_evidence_level_counts'] == {k: count('p0_evidence_level', k) for k in LEVEL}
assert refresh['static_review_counts'] == {k: count('static_review_conclusion', k) for k in LABEL}
assert set(refresh['freeze_decision_ids']) == {f['id'] for f in features if f.get('freeze_decision_ref')}
assert all(f['p0_evidence_group'] != 'prototype_or_probe' and f.get('p0_evidence_note') for f in features if f['id'] in refresh['ui_prototype_not_counted'])
for prefix in 'CTFGSQ':
    row = [sum(1 for f in features if f['id'][0] == prefix)] + [sum(1 for f in features if f['id'][0] == prefix and f['p0_evidence_group'] == g) for g in GROUP]
    assert f'| {prefix} | ' + ' | '.join(map(str, row)) + ' |' in section, prefix
assert f'| 合计 | {len(features)} | ' + ' | '.join(str(groups[g]) for g in GROUP) + ' |' in section
assert all(resolve(doc.parent, doc.name + t if t[0] == '#' else t) for _, t in LINK.findall(text) if not t.startswith('http'))
decided = text.split('## (e) ', 1)[1].split('\n## ', 1)[0]
e_rows = re.findall(r'^\| (E\d+) \| (.+) \|$', decided, re.M)
assert [r[0] for r in e_rows] == [f'E{n}' for n in range(1, 13)] and all(len(r[1].split(' | ')) == 5 for r in e_rows)
assert '决定记录2026-10-12' in anchors(doc) and data['baseline_freeze']['decision_record'].endswith('#决定记录2026-10-12')
assert data['scope_frozen'] is True and refresh['candidate_ids_assigned'] == 31 and refresh['static_candidates_outside_ids'] == 5
print(f"PASS: evidence index consistent in 3 ledgers + proposal; {len(features)} IDs; groups {groups}; "
      f"levels {refresh['p0_evidence_level_counts']}; counting markers {sorted((f['id'], f['parity_counting']) for f in features if 'parity_counting' in f)}")
PY
```

第三段与冻结前的提交 `e0dd423` 对照，确认原有 130 行的名称、阶段、状态与证据条目没有改变，验收要点只在 13 个已决定的行上改写，未测原因只改了 C14：

```sh
python3 - <<'PY'
import json, re, subprocess
from pathlib import Path
BASE = 'e0dd42354b893d0d7bf1f9bd1be2942de57c2722'  # p0/integration 冻结前的最后一个提交
show = lambda p: subprocess.run(['git', 'show', f'{BASE}:{p}'], capture_output=True, text=True, check=True).stdout
ROW = re.compile(r'^\| ([CTFGSQ]\d\d) \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \|', re.M)
old = {m[1]: m.groups()[1:] for m in ROW.finditer(show('docs/FEATURE_PARITY.zh-CN.md'))}
new = {m[1]: m.groups()[1:] for m in ROW.finditer(Path('docs/FEATURE_PARITY.zh-CN.md').read_text())}
REWORDED = {'G13', 'F08', 'F09', 'Q06', 'C14', 'G02', 'S11', 'G17', 'G33', 'F21', 'T14', 'T12', 'G12'}
assert len(old) == 130 and len(new) == 161 and set(old) < set(new)
for i, (name, phase, acceptance, status) in old.items():
    assert new[i][0] == name and new[i][1] == phase and new[i][3] == status, i
    assert (new[i][2] != acceptance) == (i in REWORDED), i
oj = {f['id']: f for f in json.loads(show('docs/p0/baseline.json'))['features']}
nj = {f['id']: f for f in json.loads(Path('docs/p0/baseline.json').read_text())['features']}
KEEP = ['capability', 'phase', 'evidence', 'static_review_conclusion', 'p0_evidence_group', 'p0_evidence_level',
        'p0_evidence_note', 'upstream_ui', 'upstream_protocol', 'upstream_behavior', 'parity', 'scope_origin',
        'scope_classification', 'implementation_status']
for i, f in oj.items():
    assert all(nj[i].get(k) == f.get(k) for k in KEEP), i
    assert (nj[i]['acceptance'] != f['acceptance']) == (i in REWORDED), i
assert {i for i in oj if nj[i]['not_tested_reason'] != oj[i]['not_tested_reason']} == {'C14'}
print(f'PASS: {len(old)} pre-freeze rows keep name, phase, status and evidence; acceptance reworded only for '
      f'{len(REWORDED)} decided rows; only C14 not-tested reason updated; {len(new) - len(old)} rows added')
PY
```

上述命令只验证结构、名称、措辞记录与证据索引的一致性。结构通过不代表任何功能行为通过；索引里的“原型/探针”也不代表对齐或验收通过。
