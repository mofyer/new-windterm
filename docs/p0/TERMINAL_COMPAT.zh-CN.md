# P0 终端兼容性探针与 VT52 隔离实验

日期：2026-10-11。依赖：`@xterm/xterm 6.0.0`。状态：**有限序列实验通过，未接生产 UI，不能视为完整 VT52 或 P0 验收通过。**

## 本轮结论

原样 xterm 的 VT52 地址序列仍存在缺口。新增的 `Vt52Stream` 证明：在初始 ANSI 模式干净的条件下，可以用有界、跨块的字节适配器转换一组基本 VT52 输出控制。运行中的应用和真实 PTY 仍使用原来的 xterm 管线，本实验没有改变应用宣称的终端能力。

独立浏览器中实际创建 xterm，断言光标、屏幕行内容、行/屏幕擦除和顶部反向滚屏；并保留未适配 xterm 的缺口测试。测试通过表示这些明确案例的行为可重现，不等于所有 VT 模式兼容。

## 接口与数据边界

实现：[`vt52-stream.ts`](../../apps/desktop/src/terminal-compat/vt52-stream.ts)。

```ts
push(input: Uint8Array): {
  output: Uint8Array;
  inputBytes: number;
  diagnostics: { code: string; byteOffset: number; detail: string }[];
}
reset(): void
finish(): Vt52Result // same result shape as push
```

- `inputBytes` 是本次消费的原始输入长度，独立于转换后的长度；`finish()` 为 0。偏移从最近一次 reset/finish 后开始。
- 输入限于 **7 位控制序列与 UTF-8 文本**；不按块解码文本，不把 UTF-8 continuation byte 当作 C1 控制。8 位/编码后的 C1 控制与历史字符编码不在本实验契约中。
- ANSI 模式每个字节立即透传，只对准确的 `ESC [ ? 2 l` 进入 VT52；多参数、前导零、嵌入 C0 的变体均未实现。
- ANSI CSI 识别最多保留 128 字节，超限时诊断并继续原字节透传，直到结束或取消。OSC/DCS 等字符串不缓存内容；普通文本 `[?2l` 不切模式。新的 ESC 会中断字符串，后续按 ESC/CSI 重新解析；CAN/SUB 取消，OSC 的 BEL 结束字符串。
- VT52 未完成序列最多保留 3 字节。CAN/SUB 或新的 ESC 取消残留控制并报告 `cancelled`，不会把旧坐标拼到新命令上。普通 C0 字节透传；UTF-8 正常文本保持原字节。
- `finish()` 对未完成控制报告 `truncated`，将延迟的 VT52 原字节排出并重置适配器。`reset()` 显式丢弃适配器状态；调用方若要重置终端还必须另行重置 xterm。该策略用于结束/重置实验流，不等于对所有无效序列的终端标准仿真。

## 已转换与未实现

| 序列 | 实验处理 |
| --- | --- |
| `ESC A/B/C/D` | 映射为 ANSI 上/下/右/左一格 |
| `ESC H` | ANSI Home |
| `ESC I` | ANSI reverse index |
| `ESC J/K` | ANSI 从光标擦除至屏幕/行尾 |
| `ESC Y row col` | 7 位坐标减 32，转换为 1 基 ANSI CUP；窗口范围由 xterm 裁剪 |
| `ESC <` | 回到 ANSI 识别，不合成设备响应 |
| `ESC F/G/=/>/Z` | 记录 `unsupported`，消费命令，不让 xterm 误执行不同语义；尤其 `ESC Z` 不返回伪造设备身份 |
| 其他 ESC 命令 | `unsupported` 诊断并透传，后续 xterm 行为不属于已验证兼容范围 |

进入 VT52 总会报告 `clean-state-required`。本实验假设 origin、滚动区域、insert、wrap 和 charset 为默认值，**不会静默清屏或修改继承状态**。测试明确记录：先设置 ANSI 上下边距和 origin 模式，再进入 VT52，Home 会落在滚动区域起点，仍然不同于干净 VT52 的绝对左上角。因此，生产接入前必须决定 mode/margin 恢复策略或采用独立状态层。

未覆盖：VT52 图形字符集、键盘/小键盘输入映射、身份响应、完整控制取消规则、所有宽字符/换行/边界语义、VT200/VT340/VT420/VT520、SIXEL、完整 vttest，以及与 WindTerm 实机逐项对照。

## DECSCL 缺口判据修正

旧探针用 primary DA 是否以 `62` 开头推断 DECSCL 能力，这不足以证明 conformance 切换是否被执行，已移除该断言。

新探针先发送 `DCS $ q " p ST` 查询 conformance，再发送 `CSI 62 ; 1 " p` 请求 VT200，随后再次查询。当前实际前后均返回 `DCS 1 $ r 61 ; 1 " p ST`。DA 只作为设备身份观察附在报告中，不用作支持判定。

这条运行证据结合已安装官方源码 `node_modules/@xterm/xterm/src/common/InputHandler.ts` 的 `requestStatusString`：`"p` 分支硬编码 `61;1"p`，上方支持表明确注明 DECSCL 未支持。它支持“xterm 6.0.0 未实现 DECSCL”的缺口结论，不能反向把固定响应算成兼容。上游参考：[xterm 控制序列说明](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)、[xterm.js 官方输入处理源码](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/InputHandler.ts)。

## 验证

先运行本地 Vite 服务 `127.0.0.1:1420`，在 `apps/desktop` 执行：

```sh
npx playwright test tests/e2e/vt52-compat.spec.ts tests/e2e/terminal-probes.spec.ts --reporter=line
npm run build
```

本轮结果：**11 项专项通过，TypeScript 与 Vite 构建通过**。其中 6 项为本实验，5 项为原始 xterm 探针；后者包括两项“确认现有缺口”的测试。

覆盖：基本序列/中文/emoji 的所有单切点与逐字节输入一致、真实 xterm 光标/擦除/反向滚屏/越界地址裁剪、污染 origin 的已知差异、OSC/DCS 与取消边界、未实现命令诊断/无伪造身份、截断 flush、128/129 字节 CSI 上限、100 KB 超长 CSI 后恢复、reset/finish 再用。未运行完整 WindTerm 对照或硬件终端套件。

## 未来接入的 ACK 约束

当前尚未接入任何 PTY ACK。生产方案必须保留原始输入的 sequence 与长度：ACK 基于原输入块，不能用转换输出长度替代，也不能等未来块补齐 ESC/UTF-8 才 ACK 前块。一个已经被有界状态机接收、只留下最多 3 字节残留的块，应在该块可写部分交给 xterm 并完成写回调后确认；输出为空也必须有可完成的确认路径。进入下一阶段前还需测试取消、关闭、超时、队列上限与输入公平性，不能直接把本 PoC 插入现有 UI。
