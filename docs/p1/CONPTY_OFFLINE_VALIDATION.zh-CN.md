# ConPTY 启动行解析与退出生命周期的离线验证

本轮承接 startup-only 运行 [`39833719372`](https://github.com/mofyer/new-windterm/actions/runs/39833719372)：Windows 2022 第二样本已有完整 embedded READY 形状但严格行首未接受；Windows 2025 首样本启动完成后退出异常。两类现象分别验证，不把它们归为同一根因。本文只记录固定合成输入与本机生命周期夹具，不复原或保存实际 Windows 终端输出，也不追认历史运行通过。

## 同一输入分别交给 xterm 与真实 Rust 解析器

固定输入位于 [`tests/fixtures/conpty-startup-layout.json`](../../tests/fixtures/conpty-startup-layout.json)。文件含 15 个具名案例、人工固定 nonce、100 列/4 行屏幕尺寸、xterm 屏幕/光标预期，以及 Rust `Parser::startup` 的版本确认、strict/embedded 计数与原因预期；不包含实际终端、路径、环境变量或错误消息。

[`conpty-startup-layout.spec.ts`](../../apps/desktop/tests/e2e/conpty-startup-layout.spec.ts) 使用已有 VT harness 创建真实、独立的 `@xterm/xterm 6.0.0` 实例，设置 `vt: false`，不启用产品适配器；屏幕行与光标来自公开 buffer API。每例分别按完整输入、每个双块切分位置（包含空首/尾块）、逐字符分块写入；输入均为 ASCII，因此这些位置也是字节边界。15 例共 977 种分块，每次先复位 xterm、等待写入处理完成后观察，未另写 TypeScript 协议解析器。

Rust 一侧使用同一个 JSON 调用实际 `Parser::startup`，检查输入结束后的分类与失败原因，同样覆盖所有双块切点及逐字节分块，共 962 组；空首/尾块的切点已包含整段输入，不额外重复一次。两边断言刻意分别保存，不能用屏幕结果自动生成协议预期，也不能把任一边当成 Windows 原始输出复现。

| 合成案例 | xterm 屏幕观测 | 协议判断需要区分的含义 |
| --- | --- | --- |
| 独立 READY、SGR 颜色包裹 | 独立完整 READY 行 | 颜色不改变行内容 |
| 普通前缀 + READY | 前缀与 READY 同行 | 仅包含 marker 不等于独立记录 |
| CR 覆盖、CR + EL、CHA 回到首列 | 显示为独立 READY 行 | 丢弃 CR/CSI 后的字节行仍带原前缀 |
| CUP 移到下一行 | 原前缀与 READY 显示在不同屏幕行 | CSI 定位不是 LF，字节行仍可能拼在一起 |
| 命令回显、无效后缀、嵌入无效后缀 | 可见包含 READY 的文本 | 不应通过包含关系接受协议 |
| 重复 READY | 显示两条完整 READY 行 | 第二条仍可能违反一次性协议 |
| OSC 中的 READY（BEL / ST 结束） | 屏幕不显示 READY | 隐藏控制字符串不能生成协议记录 |
| READY 后 CR + EL，再 LF | 屏幕已清空 | 解析器仍可在字节行中看到完整记录；屏幕状态不等于协议历史 |
| READY 无结尾 LF | 屏幕已有完整文本 | 流记录尚未终结 |

这些案例证明了两种模型有差异：不能仅凭“屏幕看起来是独立 READY”就修改协议放行，也不能把 ANSI 剥离后的 LF 行视为完整终端屏幕。特别是“READY 已清除”的反向案例，阻止将屏幕行识别直接当作协议正确性证明。真实 Windows 2022 使用了哪一种序列仍未知；本轮不把其 embedded 计数归因于某个合成案例。

## 本机验证记录

- Playwright：15/15 通过，977 种分块，9.370 秒，使用本机 Chrome 与独立 Vite 端口 1443。CUP 移到下一行的案例中，原前缀保留已打印的尾随空格。
- 定向 TypeScript 检查通过；未新增依赖，未修改产品终端、Rust 协议接受规则或原生验收门禁。
- Rust 专项：31/31 通过，0.54 秒，包括上述共享 JSON 的 15 例/962 组实际解析器检查，以及实际 writer/cleanup 的生命周期夹具。原本仅 Windows 编译的 I/O 与清理单测现可在本机执行；模拟 reader/writer/child 不代表实际 Windows 句柄或 ConPTY 实跑。
- 将输入端关闭顺序临时还原为旧策略后，同一“子进程独立进展尚未完成”夹具在 `!closed_while_running` 断言失败；恢复修订后完整 31 项通过。该受控反例验证夹具能检出提前关闭输入端的顺序差异，不证明历史 Windows 异常由它引起。
- 独立 Rust check、clippy（`-D warnings`）、fmt、31/31 专项测试及 Windows cfg 全目标检查通过。Windows cfg 仅类型检查，不链接或执行 Windows 程序；本轮未新增 Windows 实跑证据。

## 复现 xterm 侧验证

在已按锁文件安装依赖的 `apps/desktop` 目录使用空闲端口启动 Vite：

```sh
./node_modules/.bin/vite --port 1443 --strictPort --host 127.0.0.1
```

另建不提交的 `playwright.local.config.ts`，仅覆盖默认配置的地址：

```ts
import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://127.0.0.1:1443' },
});
```

```sh
./node_modules/.bin/playwright test tests/e2e/conpty-startup-layout.spec.ts --config playwright.local.config.ts
./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --resolveJsonModule --lib ES2022,DOM,DOM.Iterable --skipLibCheck tests/e2e/conpty-startup-layout.spec.ts
```

测试后停止自己启动的 Vite，并删除临时配置。独立 worktree 可临时链接已安装的同一锁文件依赖，但不得提交该链接。本次临时配置、依赖链接及 Vite 进程均已清理。Playwright 的报告来自固定合成文本，不是 Windows 工件。

在仓库根目录运行 Rust 专项：

```sh
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-features --bin powershell_conpty_qualified_probe
```

本机执行复用了主仓库的 Cargo target 缓存；输入夹具与被测 Rust 文件均来自本轮隔离工作树，不拼接不同代码版本的结果。

## 退出生命周期与后续边界

上一轮 startup-only 代码只将 `exit 0` 入队，没有专门确认其实际 write/flush；清理先关闭输入 sender，再等待子进程退出，writer 排空后关闭输入端。本轮修订仅调整 startup-only 的诊断清理：在原 500 ms 优雅退出窗口内确认 `exit 0` 的完整 write/flush，ACK 与子进程退出共用该窗口，并在观察退出前保留输入 sender。超过期限或写入失败仍走原有受限终止回退；清理总计 4.5 秒内部期限与 5 秒外部等待不扩展，旧 `--sample` 行为不改。

生命周期夹具驱动实际 writer 与 cleanup，覆盖部分 write 后 flush 才确认、flush 失败保留首个原因、迟到/未收到 ACK、子进程未退出时的终止回退。子进程进展由独立 barrier 控制，成功 write/flush 不会直接等同于子进程退出，因此夹具可观察到“命令已写入，但进程仍运行”的中间阶段。先关输入的受控反例在该阶段失败，修订在观察到退出后才关闭输入。这只是诊断顺序的确定性离线证据，不能单独解释历史退出码或宣称 Windows 修复。

本轮不新触发 Windows CI、不追加环境或查询矩阵。后续 Windows 验证需要另行预注册并绑定准确提交；此前运行的失败、原 5 秒启动窗口、30 秒查询窗口、输出与清理界限保持。P1/第四批仍未验收，P2 仅准备，main 不合并。
