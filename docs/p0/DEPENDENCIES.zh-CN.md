# 依赖与许可证清单

日期：2026-10-11；2026-10-12 增加开发依赖 `zmodem2`。依据为仓库锁文件（`apps/desktop/src-tauri/Cargo.lock`、`apps/desktop/package-lock.json`）中的声明许可证，涵盖所有目标平台的条件依赖。本页是 P0 出口要求的清单与风险判断，不是法律意见；发行前仍需生成并随包附带第三方许可证文本。

## 结论

- **没有 GPL/AGPL/SSPL/BUSL 依赖，也没有缺失许可证声明的包。**
- Rust 侧 528 个 crate（含仅用于测试的开发依赖），绝大多数为 MIT / Apache-2.0 双许可。需要注意的只有两类：
  - **MPL-2.0（文件级 copyleft）**：`cssparser`、`cssparser-macros`、`selectors`、`dtoa-short`（Tauri/WebView 工具链的 CSS 解析）与 `option-ext`。不修改源文件时可随 Apache-2.0 项目分发；若修改这些文件，需公开修改后的文件。
  - **LGPL-2.1-or-later 仅作为可选项**：`r-efi` 为 `MIT OR Apache-2.0 OR LGPL-2.1-or-later`，按 MIT/Apache-2.0 使用。
- 其余非 MIT/Apache 许可均为宽松许可：Unicode-3.0（ICU4X 数据与 `unicode-ident`）、Zlib、BSD-2/3-Clause、ISC、0BSD、Unlicense、CC0、`Apache-2.0 WITH LLVM-exception`。`ring` 为 `Apache-2.0 AND ISC`。
- 前端运行时只打包 4 个 npm 包：`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-unicode11`（MIT）与 `@tauri-apps/api`（Apache-2.0 OR MIT）。
- 开发依赖中的 `lightningcss`（MPL-2.0，Vite 构建期 CSS 工具）不进入发行产物。
- Rust 开发依赖 `zmodem2 =0.7.3`（MIT OR Apache-2.0）只被 `tests/zmodem_lrzsz.rs` 的 ZMODEM 评估测试使用，不进入库、应用或发行包。它的依赖 `bitflags`/`hex`/`thiserror` 原本就在锁文件中，引入后锁文件只多了它一项。评估结论是不作为产品依赖采用，见 [MODEM](MODEM.zh-CN.md#zmodem2-评估2026-10-12)。
- 互操作测试使用的 lrzsz（GPL）是测试机上安装的外部程序，只作为独立进程运行；没有链接或复制它的代码，也不随应用分发。
- 原生 WebView 冒烟测试（[NATIVE_WEBVIEW_SMOKE](NATIVE_WEBVIEW_SMOKE.zh-CN.md)）只在 CI runner 上安装三个外部工具，均作为独立进程运行，不进入锁文件、应用或发行包：`tauri-driver =2.0.6`（Apache-2.0 OR MIT，`cargo install --locked`）；Linux 的 apt `webkit2gtk-driver`（WebKit 的 LGPL/BSD 许可，版本与已安装的 `libwebkit2gtk-4.1-0` 相同）；Windows 的 msedgedriver（Microsoft 软件许可条款，按 WebView2 Runtime 版本下载，不再分发）。测试客户端只用 Node 内置 `fetch`，没有新增 npm 依赖。
- `@xterm/addon-image 0.9.0`（MIT）只作为开发依赖，供隔离的 SIXEL 原型与其 Playwright 测试使用，生产入口没有引用它，`vite build` 产物中不含该插件。它的发布包内联了两个 MIT 库编译出的 WebAssembly：`sixel`（jerch/node-sixel）和 `xterm-wasm-parts`，没有运行时依赖。评估过程见[终端内核技术调整建议](TERMINAL_CORE_ADR.zh-CN.md)。

## 直接依赖

| 组件 | 锁定版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| tauri / tauri-build | =2.12.3 / =2.7.2 | Apache-2.0 OR MIT | 桌面壳、IPC、构建 |
| portable-pty | =0.9.0 | MIT | 本地 PTY / ConPTY |
| russh | =0.64.1 | Apache-2.0 | SSH 客户端（ring 后端） |
| russh-sftp | =3.0.1 | Apache-2.0 | SFTP 浏览与写操作原型 |
| tokio | =1.50.0 | MIT | 异步运行时 |
| serde / uuid / zeroize | =1.0.229 / =1.18.1 / =1.9.1 | MIT / Apache-2.0 双许可 | 序列化、ID、秘密清零 |
| libc（Unix） | =0.2.180 | MIT OR Apache-2.0 | PTY 非阻塞与 poll；SFTP 下载落盘的 `O_NOFOLLOW` |
| windows-sys（Windows，`p0/windows-conpty` 分支） | =0.61.2 | MIT OR Apache-2.0 | Job Object、GetFileType；该版本此前已在锁文件中 |
| @xterm/xterm 与插件 | 6.0.0 / 0.11.0 / 0.9.0 | MIT | 终端渲染 |
| @xterm/addon-image（开发依赖） | 0.9.0 | MIT | 仅 SIXEL 隔离原型；与 xterm 6.0.0 同一提交 `f447274` 发布 |
| @tauri-apps/api | 2.12.3 | Apache-2.0 OR MIT | 前端 IPC |
| zmodem2（Rust 开发依赖） | =0.7.3 | MIT OR Apache-2.0 | 仅 ZMODEM 评估测试；不进入产品 |

## 系统组件（不随应用分发）

WebView 由操作系统提供：macOS 的 WKWebView、Windows 的 WebView2 Runtime、Linux 的 WebKitGTK（LGPL，动态链接系统库）。Windows 发行时若捆绑 WebView2 引导程序，需另行遵守 Microsoft 的分发条款；当前没有安装包。

## 发行前待办

1. 生成第三方许可证汇编（例如 `cargo about` 或等价工具，加上 npm 运行时依赖），随 `.app`/安装包附带。
2. 对 MPL-2.0 文件保持不修改；如需补丁，单独记录并公开修改文件。
3. 依赖升级时重跑下方脚本，检查新增许可证类别。

## 复核方法

```sh
cargo metadata --locked --format-version 1 --manifest-path apps/desktop/src-tauri/Cargo.toml > /tmp/meta.json
python3 - <<'PY'
import json, collections
m = json.load(open('/tmp/meta.json'))
pkgs = {p['id']: p for p in m['packages']}
ids = {n['id'] for n in m['resolve']['nodes']} - {m['resolve']['root']}
print(collections.Counter(pkgs[i].get('license') or 'UNKNOWN' for i in ids).most_common())
lock = json.load(open('apps/desktop/package-lock.json'))['packages']
print(collections.Counter((p.get('license', 'UNKNOWN'), bool(p.get('dev'))) for k, p in lock.items() if k))
PY
```
