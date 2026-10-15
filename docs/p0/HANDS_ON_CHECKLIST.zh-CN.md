# 上游 2.7.0 实机盘点与本机原生验收清单

初建：2026-10-12；更新：2026-10-15。用途：E1 授权的上游实机盘点，以及本项目在 macOS 真机上的输入法和 VoiceOver 验收。协调者已使用 CUA 操作原生窗口，并由用户补充真实拼音和前台显示对照；结果见[上游实测](UPSTREAM_HANDS_ON_2026-10-15.zh-CN.md)和[原生报告](NATIVE_ACCEPTANCE_2026-10-15.zh-CN.md)。以下仍为完整验收清单，部分实测不代表整项关闭。

## 准备与隔离

- 上游副本：`.reference/WindTerm-Isolated.app`。它从隔离副本 `WindTerm-P0.app` 复制而来，做了两处修改：
  - `profiles.config` 指向 `.reference/upstream-isolated-profile`，不读写 `~/.wind`。
  - bundle id 改为 `local.p0.windterm-isolated`。
- 已知限制：Qt 可能仍然写入 `~/Library/Preferences/KingToolbox.WindTerm.plist`，这个文件与已安装的 WindTerm 共用。开始前它已原样备份，结束后由协调方还原，不查看其内容。
- 开始前请退出已安装的 WindTerm。
- 启动：`open -n /Users/yafan/Workspace/www/new-windterm/.reference/WindTerm-Isolated.app`
- 不要登录任何真实服务器，不要导入个人配置。只打开本地 shell 会话即可。

## A. 上游 WindTerm 2.7.0（结果用于修订冻结台账中的待实测行）

| 编号 | 对应 ID | 步骤 | 需要记录 |
| --- | --- | --- | --- |
| A1 | G13 | 新建一个本地 shell 会话。依次按 ⌃↩（Control+Return）、⌘↩、⇧↩，每按一次就观察状态栏和输入区的本地/远程模式指示 | 哪个组合键会切换模式；菜单中该项显示的快捷键文字（截图） |
| A2 | F08/F09 | 查找所有可能的 SCP 入口：会话菜单、传输菜单、文件面板右键菜单、新建会话对话框中的协议列表、把文件拖到终端 | 有没有出现 “SCP” 字样或 SCP 传输选项（截图）；没有就写“未见” |
| A3 | Q06 | 打开会话 → 首选项 → 默认会话设置 → 窗口 → 回滚行 | 当前初始值（不能未经核实称为出厂默认值）；依次输入 0、1000000、99999999 后实际保存的值；有没有“无限”选项；另测实际容量和 0 的语义 |
| A4 | S08 | 建立布局：两个标签，其中一个左右分屏；移动或隐藏一个停靠窗格（如文件面板）；再开第二个窗口。然后 ⌘Q 正常退出并重新启动 | 重启后恢复了哪些：标签、分屏、停靠窗格位置、多窗口、会话本身（截图对比） |
| A5 | — | 其它与台账描述不一致的地方 | 自由记录 |

## B. 本项目在 macOS 真机上的原生验收（WKWebView）

启动：`cd /Users/yafan/Workspace/www/new-windterm/apps/desktop && npm run tauri dev`（需要先 `npm ci`）。

| 编号 | 对应 ID | 步骤 | 需要记录 |
| --- | --- | --- | --- |
| B1 | T15 | 打开本地终端，切换到系统拼音输入法，输入一句中文后选字上屏 | 候选窗是否出现在光标附近；上屏后文字只发送一次；组字过程中终端有没有收到半截字母 |
| B2 | T14 | 在本地终端执行 `printf '中文 🌏 👨‍👩‍👧 🇨🇳 é\n'` | 字符宽度和光标位置是否正确（截图） |
| B3 | T12 | 粘贴一大段文本（例如 1 MB 的日志），再粘贴含 `ESC[201~` 的文本 | 粘贴是否完整、不乱序；注入的结束序列有没有被执行 |
| B4 | — | 用 ⌘F5 打开 VoiceOver，把焦点移到终端区域 | VoiceOver 能否读出终端内容、标签名和状态栏；有没有无法聚焦的控件 |
| B5 | — | 打开 SFTP 面板和 Telnet 标签页各一次（可以使用 `tests/fixtures/ssh-sftp/fixture.mjs --serve` 启动的夹具） | 面板在原生窗口中能否正常显示和操作（截图） |

## 回传

把截图和记录发回会话即可。协调方会：
1. 还原 `KingToolbox.WindTerm.plist`；
2. 按冻结的变更规则修订 G13、F08/F09、Q06、S08 等行，并附上证据；
3. 把 B 部分的结果记入 RESULTS 与 INPUT_PATHS。

隔离 profile 目录 `.reference/upstream-isolated-profile` 已被 Git 忽略，可以保留作为证据，也可以在之后删除。
