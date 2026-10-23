# 2026-10-23 M1.0 沙箱可行性探针证据(长驻 agent package 服务)

> 工件性质:M1 Task 1 硬门槛证据(macOS 实测 + Windows 阻断记录)
> Worktree:`feat-chat-created-agent-packages-m1`(基点 `5f2ed71feb`)
> 探针:`dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs`
> 运行时:`@deepseek-ai/dsh-sandbox-local` / `dsh-sandbox-policy` / `dsh-subprocess-local` 均为 `0.2.1-rc.1`

## 1. 结论

| 平台 | 结果 | 说明 |
| --- | --- | --- |
| darwin(macOS) | **PASS** | 长驻 HTTP 服务经 `ctx.sandbox.confine` 启动、可访问、可存活;写越界被拒;读越界与外网连通(即这两项**不隔离**,属已知事实而非缺陷) |
| win32 | **BLOCKED** | 本机无 Windows 真机,未运行、未伪造。按任务口径,这一支不构成 macOS 侧的失败,但 **M1 的 Windows 前提仍未验证**,在真机跑出对应 JSON 前不得宣布 M1 在 Windows 可开工 |

macOS 一侧的 M1 关键假设成立:**DSH 沙箱允许在 workspace 内长期运行一个监听 127.0.0.1 的 Node 服务进程**,写边界生效,读与网络按上游 Seatbelt 配置不设限。

## 2. 命令与原始输出

命令(在 worktree 根目录执行,与 brief Step 2 一字不差):

```sh
node dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs --platform darwin
```

stdout 恰一行(exit code `0`):

```json
{"platform":"darwin","enforcement":"full","httpReady":true,"writeDenied":true,"readOutside":true,"networkOutside":true}
```

同一命令多次运行(含探针定稿后的最后一次)stdout 逐字节一致;临时目录与子进程均已清理(`pgrep` 无残留、`$HOME/.huaanwork-sandbox-probe-*` 无残留)。

stderr 诊断(一次完整运行的全部诊断行;EPERM 堆栈按行省略;仅诊断信息,不进入 stdout):

```text
[sandbox-probe] workspace=/Users/amonmiao/.huaanwork-sandbox-probe-ws-Wo7SVN
[sandbox-probe] outside=/Users/amonmiao/.huaanwork-sandbox-probe-out-XtyRlF
[sandbox-probe] policy={"mode":"workspace-write","workspaceRoot":"/Users/amonmiao/.huaanwork-sandbox-probe-ws-Wo7SVN"}
[sandbox-probe] server.runner=sandbox-exec enforcement=full
[sandbox-probe] server.port=57194
[sandbox-probe] health={"ok":true,"status":200,"body":"ok"}
[sandbox-probe] insideWrite.code=0 landed=true
[sandbox-probe] outsideWrite.code=1 landed=false denialEvidence=true
[sandbox-probe] outsideWrite.stderr=... Error: EPERM: operation not permitted, open '.../.huaanwork-sandbox-probe-out-XtyRlF/denied.txt' ...
[sandbox-probe] outsideRead.code=0 contentMatch=true denialEvidence=false
[sandbox-probe] confinedNet.code=0 reply={"ok":true,"target":"1.1.1.1:443"} denialEvidence=false
[sandbox-probe] healthAfterProbes=true
[sandbox-probe] verdict=PASS
```

## 3. 运行环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-23 11:33–11:36 CST(首轮 11:33:57,另有多轮复跑与一次负向对照) |
| 机器 | `Mac16,8`,arm64(Apple Silicon) |
| 系统 | macOS 27.0.1(build 26A434) |
| Node | v22.23.2(`/opt/homebrew/bin/node`) |
| 沙箱 runner | `/usr/bin/sandbox-exec`(Seatbelt;`confine` 返回的 `enforcement` = `full`) |

## 4. 观察项判定口径

| 字段 | 期望 | 实测 | 证据 |
| --- | --- | --- | --- |
| `httpReady` | `true` | `true` | `server.mjs` 经 `confine` 包装为 `sandbox-exec -p <profile> -- <execPath> server.mjs` 启动,打印 `READY 57194`;父子未隔离的探针侧 `GET http://127.0.0.1:57194/health` 返回 `200 "ok"` |
| `writeDenied` | `true` | `true` | 同一 policy 下子进程写 `$HOME/.huaanwork-sandbox-probe-out-*/denied.txt`:exit 1、stderr `EPERM: operation not permitted`、文件不存在;反向对照「workspace 内写入」exit 0 且落盘,排除「一律拒写」的假阳性 |
| `readOutside` | `true`(即读**不**隔离) | `true` | 子进程读取 workspace 外的 `secret.txt` 成功,内容与父进程写入值一致 |
| `networkOutside` | `true`(即网络**不**隔离) | `true` | 子进程 `connect` 到 `1.1.1.1:443`(公网 IP,排除 DNS 变量)成功 |
| `enforcement` | `full` | `full` | `confine` 返回值,runner = Seatbelt |

两个临时目录都放在 `$HOME` 下而不是 `mkdtemp()` 默认位置,原因:`workspace-write` 的 `writableRoots`(`@deepseek-ai/dsh-sandbox` 源码)把 `/tmp` 与 per-user temp 目录整体授予写权限,只有 `$HOME` 下的路径能证明 workspace 边界。

## 5. 读 / 网络不隔离的观察(对 M1 的约束)

- Seatbelt profile 是 `(allow default)` + `(deny file-write*)` + 对可写根目录的豁免(`seatbeltProfileArgs`)。因此本沙箱**只围栏文件写**,读与外网连通都不在围栏内 —— 实测两项均为「可越界」。
- 对 M1 的直接含义:agent package 的常驻服务可以读取用户可读的任意文件、可以对外发起连接,也可以监听回环端口。任何「agent package 被隔离」的表述只能是**写边界隔离**;不能据此承诺文件读取保密或出网管控。
- 网络观测用的是公网 IP 直连而非域名:若某个部署环境本身没有出网路由,探针会在 stderr 打 `BLOCKED: network-inconclusive` 并以 exit 3 退出,不会把环境不可达误报成沙箱拦截。

## 6. Windows 步骤:BLOCKED

- 应有命令(未执行,须在 Windows 真机):`node dsh-plugin-huaanwork\scripts\agent-package-sandbox-probe.mjs --platform win32`
- 期望(未验证):`{"platform":"win32","enforcement":"partial","httpReady":true,"writeDenied":true,"readOutside":true,"networkOutside":true}` —— `partial` 来自 `windows-acl` runner 的自述(NTFS 硬链接、读不设限等)。
- 阻断原因:**本次执行环境没有 Windows 真机**,按任务口径记录 `BLOCKED`,不伪造任何 win32 结果,也不把这一支算作 macOS 失败。
- 探针本身拒绝跨平台贴标签:在 darwin 上跑 `--platform win32` 直接 exit 2,stdout 为空:

```text
[sandbox-probe] refusing to label a darwin run as win32: the win32 probe must run on a real win32 machine
```

- 余下未验证面:restricted-token runner 下长驻服务的启动与监听、写边界、读与外网行为。真机跑完后把该 JSON 补进本文件即可闭环,不需要改探针。

## 7. 探针自身失败路径的负向自检

「不能提交假 PASS」由探针结构保证,并用一次人工负向对照实测:在 `PATH` 前面放一个立即 `exit 1` 的假 `sandbox-exec`,同一命令输出

```json
{"platform":"darwin","enforcement":"full","httpReady":false,"writeDenied":true,"readOutside":false,"networkOutside":false}
```

exit code `3`,stderr 打 `BLOCKED: server-not-ready` 与 `BLOCKED: workspace-write control failed`。即:runner 无法执行被包装命令时,长驻服务标记为未就绪、整体判 BLOCKED,不会因为「写越界也失败」而误判成沙箱生效(`writeDenied` 单看会被启动失败伪造,workspace 内写入对照正是为此存在)。该次为人工负向对照,不是产品运行结果。

## 8. Gate 判定

- macOS:`httpReady` / `writeDenied` / `readOutside` / `networkOutside` 四项与 brief 期望完全一致,`enforcement:"full"` ⇒ **门槛通过**,M1 的「沙箱内长驻服务」假设成立。
- Windows:BLOCKED(无真机) ⇒ **M1 的跨平台前提未闭环**;按 brief Step 3,在真机结果落地前不能宣布 M1 可开工。本任务未改动任何产品代码。
