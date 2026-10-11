# Free Type 草稿编辑概念验证（G03）

日期：2026-10-11。状态：**隔离实验通过，未接生产终端；不代表 G03 验收。** Free Type 是 WindTerm 的输入编辑模式，不是 FreeType 字体库。

## 要回答的问题

FEASIBILITY 要求验证“Free Type 草稿编辑/发送/取消”：能否在 xterm 之上提供可以自由编辑的输入层，并保证在用户确认前不向 shell 发送任何字节，同时不破坏输入法和终端焦点。

## 结论

**可行。** [`free-type.ts`](../../apps/desktop/src/terminal-compat/free-type.ts) 在终端光标所在单元格叠加一个原生 textarea 作为草稿：

- 激活后按键、粘贴、输入法组合都只进入草稿，终端 `onData` 不会触发，PTY 收不到任何字节。
- 草稿内可用系统原生编辑（方向键、Home/End、选择、退格、鼠标点选），中文输入走浏览器原生 IME。
- Enter 把整段草稿一次性交给调用方（由它写入 PTY），多行内容按行以 CR 发送；Shift+Enter 插入换行；Esc 丢弃草稿；输入法组合中的 Enter 不会提交。
- 草稿框随光标移动和终端尺寸变化重新定位，宽度占满光标到行尾。

## 实测（headless Chrome，真实键盘事件）

| 场景 | 结果 |
| --- | --- |
| 输入 `echo hello`，回到行首插入再删除，追加中文后 Enter | 终端 `onData` 0 次；提交 1 次，内容为 `echo hello 中文\r`；焦点回到 xterm |
| 粘贴两行（第二行为危险命令）再 Shift+Enter 加一行 | Enter 前提交 0 次；Enter 后一次性提交三行 |
| Esc | 提交 0 次、`onData` 0 次，草稿关闭 |
| 输入法组合中的 Enter | 不提交；组合结束后 Enter 正常提交 |
| 定位 | 草稿左边缘对齐第 5 列光标；60 → 40 列后宽度按新单元格宽度重算 |

## 约束与未完成

- 只验证了“新输入的草稿”。编辑已经发给 shell 的命令行需要与 shell 行编辑器同步（发送光标键/退格或依赖 shell integration），尚未验证。
- 多行一次性提交适合粘贴保护；WindTerm 2.7.0 的实际 Free Type 交互（是否多行、快捷键、与 Sync Input 的组合）需实机对照。
- 浏览器测试不能代替原生 WKWebView 中的中文输入法验收；草稿样式未接入设计系统。

## 复核

在 `apps/desktop` 下先运行 `npm run dev`，然后：

```sh
npx playwright test --config playwright.config.ts tests/e2e/free-type.spec.ts --reporter=list
```
