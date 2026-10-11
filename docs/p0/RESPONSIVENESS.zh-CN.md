# P0 高输出响应：前端观测与状态更新

日期：2026-10-11。结论：已消除可复现的逐块状态 DOM 冗余写入；本报告没有证明原生 WKWebView 的 Ctrl-C 延迟已经解决。

## 复现边界与基线

使用真实应用的终端工厂、Unicode 11、xterm.write、Channel 前端回调、逐序 ACK 和输入队列。仅 IPC 后端替换为可控 stub，不启动 PTY、不经过 Rust、不涉及 WKWebView。

环境：macOS 27.0.1 arm64，Chrome 154.0.8037.99，Playwright 1.64.0，Node 26.0.0；1280×800，单 worker，xterm 6.0.0，`screenReaderMode: true` 保持开启。

负载：每块 4095 字节（1365 行 `y\r\n`），共 512 块 / 2,096,640 字节；最多 16 块未 ACK。stub 收到按序 ACK 后才补充数据，不会无限注入。

改动前每个 xterm write callback 都调用 updateStatus，执行三次 textContent、两次 disabled 赋值，即使值完全没有变化。

| 指标 | 基线单次观测 | 修改后最终单次观测 |
| --- | ---: | ---: |
| 完成 ACK | 512，顺序正确 | 512，顺序正确 |
| 最大未 ACK 块数 | 16 | 16 |
| 状态文字 DOM 变更 | 512 | 0 |
| 尺寸/接收字节 DOM 变更 | 512 | 4 |
| 会话说明 DOM 变更 | 512 | 0 |
| 两个样本按钮 disabled 变更 | 各 512 | 各 0 |
| 上述控件总 DOM 变更 | 2560 | 4 |
| 流处理耗时（Chrome stub） | 356.2 ms | 352.1 ms |

计数由 MutationObserver 观察五个实际控件，不计 xterm 自身渲染与无障碍 DOM。基线初次观察器还观察到了 xterm 子树，但上表只使用具名状态控件记录；正式回归仅观察这五个控件，减少测量扰动。**单次耗时不是受控统计比较，不能据此宣称吞吐提升或代表 macOS 原生性能。**

另一个持续输出场景中，Ctrl-C 在累计 ACK 84 块、已送入 100 块时进入 IPC；最后一次 Chrome 测得 keydown 到 stub `pty_write` 约 0.2 ms。这确认链路没有等待状态刷新，并不代表系统事件、WKWebView、PTY 和前台进程的真实延迟。

## 实施变化

- 字节数等非关键输出状态按 100 ms 合并，仅保留一个计时器；事件循环繁忙时显示可能更晚。该计时器不是 ACK 或输入的前置条件。
- 缓存五个状态节点，只在文本/disabled 值改变时写 DOM。
- 非活动终端输出不刷新活动终端状态。
- exit、error 同步刷新并取消低优先级待刷新；内容、ACK 与输入不等待 100 ms。
- 保留串行 ACK、4096 字节输入分块、64 KiB 输入限制、Unicode 配置和 screenReaderMode；未以关闭无障碍换取性能。
- 产品布局、样式、用户可见按钮没有增加诊断信息。

## 仅开发模式诊断

开发服务器打开 `http://127.0.0.1:1420/?p0Diagnostics`，开发工具 Console 手动读取：

```js
window.__WINDTERM_P0_DIAGNOSTICS__.snapshot()
```

返回固定 13 个聚合数字：接收块/字节、解析块、ACK 提交/完成、输入事件/IPC 次数、当前/峰值输入积压、最大输入排队/解析等待/ACK 排队时长、状态刷新次数。**没有采样数组、时间序列、日志或后台采样计时器；不保留输入、输出、路径或会话 ID。** 快照是冻结的数字对象，统计累计至刷新，不是分位数。

- `maxInputWaitMs`：输入进入串行队列至开始发送，不含后续 IPC/PTY 时间。
- `maxParseWaitMs`：Channel 数据抵达至 xterm.write callback，含 xterm 内排队。
- `maxAckQueueWaitMs`：解析 callback 至 ACK 开始 invoke，不含该 ACK 后端完成。
- `statusFlushes`：含初始状态/布局的函数调用次数，不是 DOM 变更次数。

没有查询参数不安装诊断对象；生产 build 删除诊断表面，已确认产物不含对象名、查询参数或诊断字段名。诊断只是额外观测，不替代原生测量。

## 验证与复跑

```sh
cd apps/desktop
npm run dev
# 另一个终端，复用 1420 服务
npx playwright test tests/e2e/responsiveness.spec.ts tests/e2e/pty-ui-contract.spec.ts --workers=1
npm run build
```

新响应测试 7 项，加已有 PTY 契约 5 项，共 **12 passed**。覆盖有界输出全序 ACK 与状态合并、输出中 Ctrl-C、error/exit 同步可见、后台输出不刷新活动状态、诊断开关与仅数字数据、暂停输入 IPC 后的队列等待和顺序。已有测试仍覆盖打开/关闭竞态、关闭失败、ACK 先后与长输入分块。

报告附有 `stream-metrics.json`、`input-metrics.json`；Playwright 的 test-results 为临时本地产物，后续运行会覆盖。TypeScript 严格检查与 Vite 生产构建通过。

## 待原生复验

上一轮原生 `yes` 大输出中多次操作 Ctrl-C 才停止，不能仅据 Chrome 结果归因为 DOM、Rust 死锁或输入丢失。需在相同原生环境、明确焦点、受控有限输出下，关联单次键盘事件、前端输入、Rust 接收、PTY 信号和输出停止。真实 WKWebView 延迟、CPU、内存、VoiceOver 高输出行为仍待测；本轮不将 P0 高输出关卡标为通过。

## 开发服务器的 Rust 构建隔离

新增 `apps/desktop/vite.config.ts`，按 [Tauri 官方 Vite 8 配置](https://v2.tauri.app/start/frontend/vite/) 将 `server.watch.ignored` 设为 `['**/src-tauri/**']`，保留现有脚本的 127.0.0.1 / 1420 / strictPort。首次添加配置需要重启已运行的无配置 Vite 服务。

`dev-watch.spec.ts` 在独立 `src-tauri/target/p0-watch-probe-<pid>/index.html` 受控新建、改写并清理文件，同时观察 Vite WebSocket full-reload 消息及页面 sessionStorage 加载计数。**旧服务复现了 full-reload 消息，配置生效后为零，加载计数不变；专项 1 passed。** 单看 Vite 的 page reload 日志或仅看加载计数都不充分：本轮旧服务会发送带目标路径的 reload 消息，但根页面没有因此实际导航，因此没有将日志等同于浏览器会话已中断。

此项是在上述 12 项之外的额外回归。配置生效后生产构建再次通过，开发服务已重启并保持运行供全套回归使用。
