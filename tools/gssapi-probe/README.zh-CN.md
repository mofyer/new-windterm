# C14：隔离 Linux GSSAPI 探针

状态（2026-10-15）：**已实现探针与容器夹具；[首次 Linux CI](https://github.com/mofyer/new-windterm/actions/runs/38690044571) 的 valid 场景失败；短名称补全修复后，第二轮 Linux 四场景与三次健康复验通过；不是产品认证入口或 C14 对齐结论。** macOS 只做编译、单元测试与 lint，不调用本机 Kerberos 认证。没有 Tauri 命令、界面或产品库改动。

## 验证什么

客户端是本目录独立 Rust crate：`russh =0.64.1` 发送 SSH `gssapi-with-mic` 报文；`gss.rs` 实现 `GssapiAuthenticator`，经系统 MIT GSS API 生成令牌和 MIC。没有调用系统 `ssh` 来替代 Rust 认证。系统 `kinit` 只为夹具准备票据。

- 只提供 Kerberos DER OID，并校验服务端选择与完成后的实际机制；完成时必须具有 mutual/integrity，不能携带 delegation 旗标；对 russh 提供的 MIC 数据调用 `gss_get_mic`。
- SSH 固定临时主机密钥的 SHA256 指纹，拒绝证书或不匹配密钥；没有公钥、密码或 keyboard-interactive 回退。
- GSS 输出 buffer、imported name、partial/complete context 均由 RAII 释放。没有手动 `Send`/`Sync`；原生调用同步完成后返回 `Ready` future。
- `repr(C)` 定义只含标准 ABI：`OM_uint32 = u32`、buffer 长度为 `usize`、OID 长度为 `u32`、opaque handle 为指针。依据 [RFC 2744](https://www.rfc-editor.org/rfc/rfc2744.html) §3、§5、§6 和 [RFC 4462](https://www.rfc-editor.org/rfc/rfc4462.html) §3；签名同时对照本机 Apple SDK 官方 `GSS.framework/Headers/gssapi_protos.h` 的六个标准函数。Linux 实际 ABI 已由修复版 CI 编译和受控互操作验证，范围见末节。
- 输出只包含固定结果标记和 GSS 数字状态，不打印令牌、keytab、ccache 或秘密路径。传输/协议/不变量错误返回 2，认证拒绝返回 10，认证并执行固定远端命令成功才返回 0。

## 四个场景

| 场景 | 前提检查 | Rust 期望 | 远端执行计数 |
| --- | --- | --- | --- |
| valid | 临时 keytab 获取 5 分钟 TGT；`klist -s` 成功 | 0；收到固定输出且通道退出码 0 | 从 0 增至 1 |
| missing | 私有 FILE ccache 路径不存在 | 10，不能是连接/超时错误 | 不变 |
| expired | 真正申请 1 秒票据，文件存在；等待 5 秒后 `klist -s` 必须返回 1 | 10 | 不变 |
| wrong-service | 恢复有效 TGT；目标为不存在的 `host@missing.invalid` | 10 | 不变 |

负例不会发出远端 exec；容器内的固定 forced command 另行写执行计数，任一负例使计数变化即失败。每个负例之后删除独立 health cache，再用 keytab 重新从 KDC 获取 TGT；Rust 用该新 cache 获取服务票据并完成一次正向认证/执行，必须成功且计数恰好增加 1。这样不依赖之前已缓存的服务票据，可排除 KDC 或 sshd 中途失效制造的假阴性。四场景加三次健康复验结束时计数为 4。脚本没有 skip 路径。最终必须输出：

```text
P0_GSSAPI_RESULT 4 passed; 0 skipped
```

这不覆盖跨 realm、委托、票据续期、企业 KDC、macOS GSS.framework 认证、Windows SSPI 或上游 WindTerm 实机行为。

## 容器隔离与 CI 接入

不要在宿主直接执行 `fixture.sh`。它只在带构建标记的私有测试镜像内运行，创建的 `p0gss` 用户属于一次性容器；不会使用 runner 的真实用户或 `~/.k5login`。所有 KRB5 配置、数据库、stash、keytab、ccache 都在 `/fixture/run.*`，SSH key、配置、日志同样私有。未继承 SSH agent，也未启用 KRB5_TRACE。

KDC 和 sshd 只监听容器 loopback 高端口，运行时 `--network none`。sshd 仅接受 `gssapi-with-mic`，关闭其它认证、用户环境/rc、PTY 和全部转发。`GSSAPIStrictAcceptorCheck no` 仅用于让容器临时 hostname 与唯一的 `host/localhost` keytab 解耦；服务端仍必须持有对应 keytab，客户端仍检查 `host@localhost` 服务名和主机密钥，不可把这个配置直接复制到产品环境。

临时 `krb5.conf` 同时设置 `dns_canonicalize_hostname = false` 和 `qualify_shortname = ""`。MIT 在关闭 DNS 解析后仍可能给无点的 `localhost` 追加 resolver 搜索域，因此必须显式关闭短名称补全，见 [MIT krb5 1.20.1 的名称转换实现](https://github.com/krb5/krb5/blob/krb5-1.20.1-final/src/lib/krb5/os/sn2princ.c#L55-L126)。首次 CI 的 valid 场景返回 `0x96c73a07`（服务主体不存在）；该行为是修复依据，是否消除此 CI 失败仍需重跑确认。夹具在独立 cache 中用 `kvno -S host localhost` 预检实际请求的主体为 `host/localhost@P0.TEST`，随后删除该 cache，只输出固定成功标记，不预热 Rust 客户端的 service ticket。

协调者在独立 Linux CI job 接入（不需要 Tauri/WebKitGTK）：

```sh
docker build --progress=plain -t p0-gssapi tools/gssapi-probe
docker run --name p0-gssapi-check --rm --network none --hostname localhost \
  --pids-limit 128 --memory 512m p0-gssapi
```

Job 设置整体 timeout；另设 `if: always()` 步骤 `docker rm -f p0-gssapi-check`，确保取消任务时容器也销毁。禁止 privileged、host network、Docker socket/宿主目录挂载或凭据注入。构建可联网下载公开依赖；运行阶段没有外部网络。只收集标准输出及构建日志，不上传容器文件系统、KDC/sshd 原始日志、票据或密钥。

每次 probe 同时有 Rust 25 秒和 shell 30 秒/2 秒 KILL 上限；外层 shell 上限也涵盖可能阻塞 runtime 的原生 GSS 调用。配置工具有 10–15 秒上限，daemon readiness 有 5 秒上限；cleanup 只停止自身 PID，TERM 后 2 秒强制 KILL，随后删除私有目录。容器删除覆盖 daemon 后代进程和用户 home 中的证明文件。

## 版本、许可与可复现范围

- 独立 `Cargo.toml/Cargo.lock` 固定 `russh =0.64.1`（Apache-2.0）、`tokio =1.50.0`（MIT）及传递依赖；由现有应用锁文件裁剪生成，没有引入新 Rust 包版本。使用 `--locked` 构建，不影响产品锁文件。
- 构建镜像 `rust:1.99.0-bookworm`，运行镜像 `debian:bookworm-slim`；构建安装 `libkrb5-dev`，运行使用系统 `libgssapi-krb5-2`、`krb5-kdc`、`krb5-admin-server`、`krb5-user`、`openssh-server`。系统 GSS 只动态链接进测试可执行文件，不链接进产品。
- 镜像使用明确发行版/工具链标签；标签与 Debian 安全更新仍可变，因此**当前不是逐字节可复现镜像**。CI 构建日志记录解析出的镜像 digest，夹具输出五个运行包的实际版本（含提供 `kadmin.local` 的 `krb5-admin-server`）；复现实测时使用该次 digest 和软件包版本。要冻结发行基准，需要另行固定 image digest 与 apt snapshot。
- MIT Kerberos 含 MIT/BSD 等上游许可与第三方 notices，OpenSSH 为 BSD 等许可；以镜像内 `/usr/share/doc/<package>/copyright` 为准。Debian 基础系统还包含 GPL 工具。它们是独立测试环境，不随桌面程序分发；本仓库不发布这个测试镜像。应用依赖清单见 [DEPENDENCIES](../../docs/p0/DEPENDENCIES.zh-CN.md)。

## 本机检查与证据边界

```sh
cargo fmt --manifest-path tools/gssapi-probe/Cargo.toml -- --check
cargo clippy --locked --all-features --all-targets --manifest-path tools/gssapi-probe/Cargo.toml -- -D warnings
cargo test --locked --all-features --manifest-path tools/gssapi-probe/Cargo.toml
bash -n tools/gssapi-probe/fixture.sh
```

macOS 使用系统 GSS.framework 进行链接检查，单元测试只检查机制拒绝、ABI 布局和主机指纹正负例，不进行认证、不读取真实票据。运行入口拒绝非 Linux，Linux 入口还要求显式隔离标记和所有 KRB5 路径位于 `/fixture/`。Windows 不是本探针的构建目标。Linux 四场景须以 CI 日志为准；本机没有 Docker/KDC，不能把本机单元测试计为 Kerberos 互操作成功。

## Linux CI 证据（2026-10-15）

[run 38691371347 / job 116277797906](https://github.com/mofyer/new-windterm/actions/runs/38691371347/job/116277797906)，head `fb824cf`，输出 `P0_GSSAPI_RESULT 4 passed; 0 skipped`；三次 fresh-cache 健康复验也通过，最终远端执行计数 4。Linux 单元测试 3/3。MIT Kerberos `1.20.1-2+deb12u5`，OpenSSH `1:9.2p1-2+deb12u10`。此为独立探针证据，不代表桌面产品已支持 GSSAPI。
