# 智能体包 M2 Windows GHA 验收证据

当前结论（2026-10-25 fix round 1 更新）：**M2 的 Windows step `PASS`（exit 0）**——run
`40198346429`（commit `93c1bb0291`，`workflow_dispatch`）。修复方式是裁定 **R-T13-1** 的选项
(b)：workflow 的 M2 step 改用 `node --experimental-transform-types`（该探针静态 import
`routes.ts`，其 `RouteError` 用 TypeScript 参数属性，strip-only 无法加载）。同一次 run 里
**M1 探针也 PASS**。证据见 §9。

历史：同一天的首次运行 `40195462983`（commit `650e749af7`）**M2 step FAILED（exit 1）**，根因
是 workflow 当时用无 flag 的 `node`，与产品行为无关；M1 在那一轮同样 PASS。该失败原文保留在
§8，不删除、不被后来的绿跑覆盖。

跨机器验收仍为 **`BLOCKED`**（没有第二台 Windows 机器）。

> 2026-10-24 的历史记录（§1–§7 的部分行文）写的是「未运行 / `BLOCKED`」，原因是当时环境
> 不能 push。后续环境**可以** push（`origin` 已配置、`gh` 已认证），因此按任务要求实际推了
> 分支并触发 `workflow_dispatch`。**跨机器验收的 `BLOCKED` 没有变**：它需要第二台 Windows
> 机器，**不得**用 macOS 探针或同机双 Profile 冒充。


## 1. 状态

| 项 | 值 |
| --- | --- |
| 结论（M2 Windows step） | **`PASS`**（exit 0；run `40198346429`，见 §9） |
| 结论（M1 Windows probe，同一 run） | `PASS`（exit 0，见 §9.3） |
| 结论（跨机器验收） | `BLOCKED`（没有第二台 Windows 机器，见 §4） |
| 运行日期 | 2026-10-25T13:36:01Z（run 创建）；job 于 2026-10-25T13:40:22Z 成功结束（4m18s） |
| workflow run URL | <https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40198346429> |
| 退出码 | M1 step `0` / M2 step `0` |
| commit | `93c1bb029134aa79d26ce3cff3ba2d55e5aa5bf1`（`feat/agent-packages-m2`） |
| runner | `windows-latest`：Windows / `10.0.26100` / GitHub Actions 1000000569 / x64 / Node `v22.23.2` |
| artifact | `windows-agent-package-acceptance`（ID `12601040539`）：含 M1 与 M2 两份 JSON |

上一次（失败的）运行 `40195462983`（commit `650e749af7`）保留在 §8：M1 step `0`、M2 step `1`
（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，见 §8.4）。

M2 双平台（macOS 本机探针 + Windows GHA）现在都有 exit 0 的运行，但这只覆盖**同机双
Profile 集成测试**；跨机器验收仍是 `BLOCKED`，`docs/huaanwork-agent-packages-m2.md` 里
「M2 双平台验收 PASS」的措辞只能同时标注跨机器仍 `BLOCKED`。

## 2. 触发方式（实际执行者照做）

1. 把包含本任务改动的分支推到远端（`feat/agent-packages-m2` 已于 2026-10-25 非 force
   push 到 `origin`；复跑前先确认远端是该提交或其后继）。
2. GitHub → Actions → **Windows agent package acceptance** → **Run workflow**，选择该分支。
   `run_host_liveness` 保持关闭（它不是 M2 验收；打开会先构建包再跑 Host 存活测试）。
3. 等待 job `windows-agent-package-acceptance` 结束。M1 步骤与 M2 步骤是**两个独立 step**：
   - `Windows agent-package acceptance probe`（M1，保持不变，无 flag 的 `node`）；
   - `Windows agent-package M2 acceptance probe`：
     ```bash
     node --experimental-transform-types \
       dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
       --platform win32 --out windows-agent-package-m2-acceptance.json
     ```
     该 flag 是必需的（裁定 R-T13-1）：M2 探针静态 import `src/huaanwork-host/routes.ts`，
     其 `RouteError` 使用 TypeScript 参数属性，strip-only 模式无法加载。
   workflow 没有 `continue-on-error`；任一步非 0 即 job 失败。
4. 下载 artifact `windows-agent-package-acceptance`，取其中的
   `windows-agent-package-m2-acceptance.json`；或从 job 日志复制探针 stdout 的 JSON 行。
5. 把 URL、commit、runner、退出码、原始 JSON 与进程扫描结果填进 §1 与 §5。

本地不能替代这次运行：非 Windows 上执行 `--platform win32` 会以退出码 2 拒绝。

## 3. 通过判据（执行后逐项核对）

`windows-agent-package-m2-acceptance.json` 必须同时满足：

- `verdict` 为 `"PASS"`，`exitCode` 为 `0`；
- `submitted`、`reviewedAndSigned`、`secondProfileInstalled`、`signatureVerified`、
  `enabledAndHttpRan`、`updatedPreservingEnabled`、`delistedInstalledStillRan`、
  `delistedStatusVisible`、`revocationStoppedActiveTurn`、`revokedEnableRejected` 全为 `true`；
- `residualProcesses` 为 `0`，且 `cleanup.matches` 为空数组；`cleanup.command` 为
  `Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine`；
- `platform` 为 `"win32"`（探针拒绝把 darwin 运行标成 win32）。

退出码含义：`0` PASS；`1` FAIL（报告里有 `error` / `failedField`）；`3` BLOCKED（服务或环境
起不来）；`2` 用法错误。**退出码不是 0 的运行不要写成 PASS**；失败的尝试留在 §5，不拿后来
的绿跑覆盖它。

## 4. 跨机器验收（同样 `BLOCKED`）

同机双 Profile 只算集成测试，不能替代这一组。需要三处材料同时具备：

1. **macOS 创建者机**：独立测试 Profile，`publishLocalAgentPackage` 提交 1.0.0，保存提交号
   与界面/日志证据。
2. **离线管理员机**：同一临时目录的 keyring 与**离线测试私钥**（不是生产 key），执行
   `pending` → `review` → `approve`；保存 review.json 与 approve 输出（不含私钥/token）。
3. **Windows 消费机**：把同一公钥 keyring 放成 `{profileDir}/agent-catalog-keyring.json`，
   填入读/发布 token；在独立测试 Profile 下载、启用、`@` 运行；再按同一流程升级 1.0.1，
   最后接收撤销。
4. 两台机器各保存原始探针/界面证据与**进程清单**（macOS `ps -ax -o pid=,command=`；
   Windows `Get-CimInstance Win32_Process`），并确认没有命令行引用测试目录的残留进程。

当前状态：`BLOCKED`（只有一台 macOS 主机，无法完成第 3 步）。后续执行者按上面四步补齐，
不要用 macOS 单机结果代替。

## 5. 运行记录（2026-10-25 首次运行，M2 step FAILED——历史，保留）

当前有效运行见 §9。下面是 strip-only 失败那一轮的原始记录，**不删、不被绿跑覆盖**。

```text
日期: 2026-10-25（run 创建 12:58Z；M2 step 失败于 13:01:27Z）
workflow run URL: https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40195462983
commit: 650e749af7f8445b37c26c49df4feaf33e267f92
runner(os/osRelease/name/arch/node): Windows / 10.0.26100 / GitHub Actions 1000000568 / x64 / v22.23.2
M1 step 退出码: 0（sandbox/http/mcp/host-exit 四相全过，residuals 全空）
M2 step 退出码: 1（import 阶段 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，见 §8.4）
探针 verdict / exitCode: 未产生（M2 的 JSON 文件不存在）
residualProcesses / cleanup.matches: 未产生
artifact 文件名: windows-agent-package-acceptance（ID 12599578870；仅含 M1 的 JSON）
原始 JSON: M1 摘要见 §8.3；M2 无 JSON
```

## 6. 已知边界（与平台无关）

- 探针不打开 GUI、不做会话访谈/确认卡、不跑真实模型；这些是独立人工项。
- 探针的沙箱是 passthrough seam：M2 验证签名包生命周期，沙箱 `enforcement`、写入拒绝、
  读/网络观察由 M1 的 Windows sandbox probe 负责。Windows 上沙箱自报 `partial`、读与网络
  不隔离是已接受事实。
- 探针每次运行生成新 key/token，`submissionId`、`keyId`、端口每次不同属正常。

## 7. 本轮 root 门禁（macOS 主机；Windows 见 §8）

这些结果只证明代码与工具链在 macOS 主机上通过，**不**构成 Windows 的 M2 验收证据
（Windows 的 M2 结论只由 §9 的 GHA 运行产生；§8 是修复前的失败运行）。

| 项 | 结果 |
| --- | --- |
| `corepack yarn check` | 本轮未重跑（Task 14 收口时执行）；上一轮 `c144a73383` 为 0（15 个顶层步骤全过） |
| `corepack yarn check:desktop-variants` | 同上 |
| `corepack yarn typecheck` | 0（`dsh-plugin-huaanwork`，2026-10-25 补救轮单独执行） |
| `corepack yarn test` | 同上（本轮只跑了相关 spec，见 macOS 证据） |
| macOS 探针最终运行 | `PASS`，exit 0；权威运行是 macOS 证据 §9（commit `f2eebef933`，`--experimental-transform-types`），`residualProcesses=0` |
| Windows GHA | **`PASS`**：run `40198346429`（commit `93c1bb0291`）；M1 step `0`、M2 step `0`，见 §9 |
| Windows GHA（历史失败） | run `40195462983`（commit `650e749af7`）：M1 `0`、M2 `1`（结构性 strip-only），见 §8 |
| 跨机器验收 | **`BLOCKED`**：只有一台 macOS 主机 |

Windows 结论仍然只能由 §2 的 `workflow_dispatch` 运行产生；跨机器验收需要第二台 Windows
机器。

## 8. 2026-10-25 首次运行（Task 13 补救轮；M2 step FAILED——历史，保留）

### 8.1 触发步骤（实际执行，非模板）

```bash
git push -u origin feat/agent-packages-m2      # EXIT=0，新建远端分支（非 force）
gh workflow run windows-agent-package-acceptance.yml \
  --ref feat/agent-packages-m2 --repo kawaiininja/HuaAnWork-Desktop
# → https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40195462983
gh run watch 40195462983 --repo kawaiininja/HuaAnWork-Desktop --interval 20 --exit-status   # EXIT=1
gh run view 40195462983 --repo kawaiininja/HuaAnWork-Desktop --log
gh run download 40195462983 --repo kawaiininja/HuaAnWork-Desktop --dir <tmp>
```

### 8.2 step 结果

| step | 结果 |
| --- | --- |
| Set up job / checkout（`submodules: recursive`）/ setup-node 22.23.2 / corepack / yarn cache / `yarn install --immutable` | 全部 ✓ |
| Verdict self-check（`node --test huaanwork-host-windows-acceptance.spec.mjs`） | ✓ |
| Windows agent-package acceptance probe（M1） | ✓ exit 0 |
| Windows agent-package M2 acceptance probe | **✗ exit 1** |
| Upload acceptance report（`if: always()`） | ✓（artifact 只有 M1 的 JSON） |
| Build HuaAnWork / Real Host liveness | 跳过（`run_host_liveness` 关闭） |

job 总时长 3m27s，结论 `failure`（唯一失败 step 是 M2）。

### 8.3 M1 artifact 摘要（同一 run，commit `650e749af7`）

```json
{
  "kind": "huaanwork-agent-package-windows-acceptance",
  "platform": "win32",
  "commit": "650e749af7f8445b37c26c49df4feaf33e267f92",
  "runner": { "os": "Windows", "osRelease": "10.0.26100", "name": "GitHub Actions 1000000568", "arch": "x64" },
  "decision": { "exitCode": 0, "verdict": "PASS", "hardFailures": [], "blockers": [] },
  "sandboxProbe": { "exitCode": 0, "timedOut": false, "facts": { "platform": "win32", "enforcement": "partial", "httpReady": true, "writeDenied": true, "readOutside": true, "networkOutside": true } },
  "phases": [
    { "name": "httpAfterIdle", "started": true, "stopped": true, "residuals": [] },
    { "name": "mcpAfterIdle", "started": true, "stopped": true, "residuals": [] },
    { "name": "hostExit", "started": true, "stopped": true, "residuals": [] }
  ]
}
```

（`processQuery.scanned` 三个相位均为 142，`matches` 均为空；`enforcement:partial`、读与网络
不隔离是 Windows 上已接受事实。）

### 8.4 M2 step 失败日志（原文摘录）

```text
Run node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs --platform win32 --out windows-agent-package-m2-acceptance.json
file:///D:/a/HuaAnWork-Desktop/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts:137
export class RouteError extends Error {
  constructor(public status: number, public code: string, message: string) {
                     ^^^^^^^^^^^^^^
    super(message)

SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
    at parseTypeScript (node:internal/modules/typescript:63:40)
    ...
  code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
}

Node.js v22.23.2
##[error]Process completed with exit code 1.
```

### 8.5 根因与收尾选项

根因：Task 13 要求探针静态 import `src/huaanwork-host/routes.ts` 以走真实
`agent.packageRefresh`，而该文件的 `RouteError` 使用 TypeScript **参数属性**
（`constructor(public status: number, public code: string, …)`）。Node `v22.23.2` 默认
`process.features.typescript === 'strip'`，strip-only 模式不支持参数属性；workflow 的 M2 step
用的正是无 flag 的 `node`，因此在 **import 阶段**（任何断言之前）就以
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 退出。同一失败已在 macOS 本机复现（macOS 证据 §8.2
命令 A），因此这是**跨平台一致的结构问题**，不是 Windows 特有缺陷、更不是 M2 包生命周期
行为失败。

收尾选项（当时**均超出 Task 13 的 Files 白名单，未执行**）：

- (a) 把 `RouteError` 改成可擦除语法：显式字段声明 + 构造函数内赋值（约 4 行，构造签名与
  `instanceof` 行为不变）。`src/huaanwork-host/` 是单侧前缀，不占变体白名单名额；改完
  macOS 与 Windows 都能用 brief 的字面命令跑。
- (b) 在 workflow 的 M2 step 与 runbook 命令上加 `--experimental-transform-types`（只改
  TS 语法转译方式，不改探针逻辑）；代价是 workflow 与文档同时偏离 strip-only 约定。

> **处置（2026-10-25 fix round 1，裁定 R-T13-1）**：采纳 **选项 (b)**，未改 `RouteError`、
  未动任何产品源码。`windows-agent-package-acceptance.yml` 的 M2 step、探针 usage 注释、
  runbook 与证据命令都改为 `node --experimental-transform-types …`；M1 step 保持无 flag。
  重跑结果见 §9（`PASS`，exit 0）。

### 8.6 当时仍然 `BLOCKED` 的部分

- **跨机器验收**（macOS 创建者 + 离线管理员 + Windows 消费机）：没有第二台 Windows 机器，
  按 §4 的四步执行，不得用同机双 Profile 替代（**现在仍是 `BLOCKED`**）。
- **Windows M2 探针重跑**：依赖 §8.5 的 (a) 或 (b) 先落地 —— 已由 (b) 完成，重跑见 §9。

## 9. 2026-10-25 fix round 1 实际运行（M2 step PASS）

### 9.1 触发步骤（实际执行，非模板）

```bash
git push origin feat/agent-packages-m2                 # EXIT=0，fast-forward f2eebef933..93c1bb0291（非 force）
gh workflow run windows-agent-package-acceptance.yml \
  --ref feat/agent-packages-m2 --repo kawaiininja/HuaAnWork-Desktop
# → https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40198346429
gh run watch 40198346429 --repo kawaiininja/HuaAnWork-Desktop --interval 20 --exit-status   # EXIT=0
gh run download 40198346429 --repo kawaiininja/HuaAnWork-Desktop --dir <tmp>
```

### 9.2 step 结果

| step | 结果 |
| --- | --- |
| Set up job / checkout（`submodules: recursive`）/ setup-node 22.23.2 / corepack / yarn cache / `yarn install --immutable` | 全部 ✓ |
| Verdict self-check（`node --test huaanwork-host-windows-acceptance.spec.mjs`） | ✓ |
| Windows agent-package acceptance probe（M1，无 flag `node`） | ✓ exit 0 |
| Windows agent-package M2 acceptance probe（`node --experimental-transform-types`） | ✓ **exit 0** |
| Upload acceptance report（`if: always()`） | ✓（artifact 含 M1 + M2 两份 JSON） |
| Build HuaAnWork / Real Host liveness | 跳过（`run_host_liveness` 关闭） |

job 总时长 4m18s（13:36:04Z → 13:40:22Z），结论 **`success`**（17 个 step 全为 success/skipped，
无失败）。M2 step 的日志首行即真实命令：

```text
Run node --experimental-transform-types dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs --platform win32 --out windows-agent-package-m2-acceptance.json
(node:6472) ExperimentalWarning: Transform Types is an experimental feature and might change at any time
```

### 9.3 运行记录

```text
日期: 2026-10-25（run 创建 13:36:01Z；job 结束 13:40:22Z）
workflow run URL: https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40198346429
commit: 93c1bb029134aa79d26ce3cff3ba2d55e5aa5bf1
runner(os/osRelease/name/arch/node): Windows / 10.0.26100 / GitHub Actions 1000000569 / x64 / v22.23.2
M1 step 退出码: 0（decision.verdict=PASS；三相位 residuals 全空；scanned=138）
M2 step 退出码: 0（verdict=PASS；11 个布尔全 true；residualProcesses=0）
探针 verdict / exitCode: PASS / 0
residualProcesses / cleanup.matches: 0 / []
cleanup.command: Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine
cleanup.scannedProcesses: 138
artifact: windows-agent-package-acceptance（ID 12601040539；含 M1 与 M2 两份 JSON）
revokedAt（审计时间戳）: 2026-10-25T13:39:45.003Z
auditLines: 44
```

M1（同一 run）：`decision.exitCode:0`、`decision.verdict:"PASS"`、`hardFailures:[]`、
`blockers:[]`；三相位 `httpAfterIdle` / `mcpAfterIdle` / `hostExit` 的 `residuals` 均为空，
`processQuery.scanned:138`。

### 9.4 M2 原始 JSON（artifact `windows-agent-package-m2-acceptance.json`，未改动字段值）

```json
{
  "submitted": true,
  "reviewedAndSigned": true,
  "secondProfileInstalled": true,
  "signatureVerified": true,
  "enabledAndHttpRan": true,
  "updatedPreservingEnabled": true,
  "delistedInstalledStillRan": true,
  "delistedStatusVisible": true,
  "revocationStoppedActiveTurn": true,
  "revokedEnableRejected": true,
  "residualProcesses": 0,
  "kind": "huaanwork-agent-package-m2-acceptance",
  "platform": "win32",
  "commit": "93c1bb029134aa79d26ce3cff3ba2d55e5aa5bf1",
  "runner": {
    "os": "Windows",
    "osRelease": "10.0.26100",
    "name": "GitHub Actions 1000000569",
    "arch": "x64",
    "node": "v22.23.2"
  },
  "scope": {
    "server": "agent-catalog-server in-process, real HTTP, ephemeral loopback port",
    "adminCli": "agent-catalog-admin/src/cli.ts spawned as a child process",
    "gui": false,
    "realModel": false,
    "note": "No GUI, no model interview and no packaged app. The sandbox is a passthrough seam; sandbox enforcement is covered by the M1 Windows sandbox probe."
  },
  "environment": {
    "note": "entriesDir, dataDir, keyring, profiles and workspace are throwaway directories under the OS temp dir; the Ed25519 keypair is generated per run and never committed; all three tokens are random per run."
  },
  "tempRoot": "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\huaanwork-m2-accept-ese7dK",
  "steps": {
    "submitted": {
      "submissionId": "2b9ffc71-9977-43b7-a898-fe6c9875c76e",
      "slug": "m2-acceptance-agent",
      "version": "1.0.0",
      "publishStatus": "pending-review",
      "catalogList": {
        "items": []
      }
    },
    "reviewedAndSigned": {
      "cli": [
        {
          "command": "agent-catalog-admin pending",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin review",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin approve",
          "exitCode": 0
        }
      ],
      "publishedStatus": "published",
      "signedKeyId": "bc65572c7a5b661d2d198f825c0a684f82aae7e5f154eaab14a301fb3b871e0c",
      "receipt": "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\huaanwork-m2-accept-ese7dK\\review-1.0.0\\review.json",
      "creatorPublishStatus": "published"
    },
    "secondProfileInstalled": {
      "profile": "consumer-profile",
      "version": "1.0.0",
      "enabled": false,
      "publishStatus": "installed",
      "creatorProfileState": "published"
    },
    "signatureVerified": {
      "keyId": "bc65572c7a5b661d2d198f825c0a684f82aae7e5f154eaab14a301fb3b871e0c",
      "slot": 1,
      "version": "1.0.0",
      "digestFiles": 4,
      "note": "verifyAgentPackageDirectory re-reads the installed directory and checks keyId-authoritative Ed25519."
    },
    "enabledAndHttpRan": {
      "version": "1.0.0",
      "httpPort": 61852,
      "health": {
        "status": 200,
        "body": "ok"
      },
      "invoke": {
        "ok": true,
        "result": {
          "echo": {
            "task": "m2-acceptance",
            "version": "1.0.0"
          }
        }
      },
      "activationDisposed": true,
      "portClosedAfterIdle": true,
      "sandbox": "passthrough (M2 checks signed-package lifecycle; M1 probe owns sandbox enforcement)"
    },
    "updatedPreservingEnabled": {
      "cli": [
        {
          "command": "agent-catalog-admin review",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin approve",
          "exitCode": 0
        }
      ],
      "from": "1.0.0",
      "to": "1.0.1",
      "enabled": true,
      "publishStatus": "installed"
    },
    "delistedStatusVisible": {
      "cli": [
        {
          "command": "agent-catalog-admin delist-requests",
          "exitCode": 0
        },
        {
          "command": "agent-catalog-admin delist-approve",
          "exitCode": 0
        }
      ],
      "requestId": "5d2e738a-b549-4a18-bd9e-9aa23d51f4f5",
      "publishStatus": "delisted",
      "enabled": true,
      "primary": "agent.packageRefresh",
      "crossCheck": "host.listLocal",
      "rpc": {
        "method": "agent.packageRefresh",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": true,
          "publishStatus": "delisted",
          "latestVersion": "1.0.0",
          "updateAvailable": false
        },
        "catalogError": null,
        "revocationWarning": null
      },
      "list": {
        "method": "agent.packageList",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": true,
          "publishStatus": "delisted",
          "latestVersion": "1.0.0",
          "updateAvailable": false
        }
      },
      "catalogRefresh": {
        "route": "agent.packageRefresh → getAgentsDirectory().refresh()",
        "catalogError": null,
        "legacyItems": 0
      },
      "statusTransition": {
        "before": "installed",
        "after": "delisted",
        "via": "agent.packageRefresh"
      }
    },
    "delistedInstalledStillRan": {
      "version": "1.0.1",
      "invoke": {
        "ok": true,
        "result": {
          "echo": {
            "task": "m2-acceptance",
            "version": "1.0.1"
          }
        }
      },
      "note": "delisted metadata changes the card, not the runtime; revocation is the security control.",
      "portClosedAfterIdle": true
    },
    "revocationStoppedActiveTurn": {
      "cli": {
        "command": "agent-catalog-admin revoke",
        "exitCode": 0
      },
      "primary": "agent.packageRefresh",
      "crossCheck": "security.refreshRevocations",
      "warnings": null,
      "crossCheckWarning": null,
      "rpc": {
        "method": "agent.packageRefresh",
        "card": {
          "slug": "m2-acceptance-agent",
          "displayName": "M2 验收助手",
          "description": "M2 双 Profile 验收用的签名智能体包",
          "version": "1.0.1",
          "source": "catalog",
          "enabled": false,
          "publishStatus": "delisted",
          "revoked": {
            "slug": "m2-acceptance-agent",
            "version": "1.0.1",
            "reason": "M2 验收:撤销当前版本",
            "revokedAt": "2026-10-25T13:39:45.003Z"
          },
          "broken": {
            "reason": "该版本已被管理员撤销：M2 验收:撤销当前版本"
          },
          "latestVersion": "1.0.0",
          "updateAvailable": false
        },
        "catalogError": null
      },
      "session": "m2-acceptance-session-3",
      "httpPort": 61872,
      "activationDisposed": true,
      "activationResultPending": true,
      "portClosed": true,
      "state": {
        "enabled": false,
        "revokedVersion": "1.0.1",
        "revokedReason": "M2 验收:撤销当前版本"
      }
    },
    "revokedEnableRejected": {
      "enableError": "智能体 @m2-acceptance-agent 已损坏:该版本已被管理员撤销：M2 验收:撤销当前版本",
      "staleDispatchError": "该版本已被管理员撤销：M2 验收:撤销当前版本",
      "assertRunnableError": "该版本已被管理员撤销：M2 验收:撤销当前版本",
      "primary": "agent.packageRefresh",
      "crossCheck": "host.listLocal",
      "cardBroken": "该版本已被管理员撤销：M2 验收:撤销当前版本"
    },
    "finalState": {
      "creator": {
        "source": "local",
        "enabled": true,
        "installedVersion": "1.0.1",
        "publishStatus": "published",
        "publishedVersion": "1.0.1",
        "submissionId": "f5a8d58c-173a-4b3a-95c0-408ba6dc3a89",
        "delistRequestId": "5d2e738a-b549-4a18-bd9e-9aa23d51f4f5"
      },
      "consumer": {
        "source": "catalog",
        "enabled": false,
        "installedVersion": "1.0.1",
        "publishStatus": "delisted",
        "revoked": {
          "slug": "m2-acceptance-agent",
          "version": "1.0.1",
          "reason": "M2 验收:撤销当前版本",
          "revokedAt": "2026-10-25T13:39:45.003Z"
        }
      },
      "auditLines": 44
    }
  },
  "negatives": {
    "wrongToken": {
      "status": 401,
      "body": {
        "error": "口令错误"
      },
      "ok": true
    },
    "unknownKey": {
      "error": "包校验失败，未安装或未运行。请联系管理员",
      "ok": true
    },
    "tamperedContent": {
      "error": "包校验失败，未安装或未运行。请联系管理员",
      "ok": true
    },
    "olderVersionReplay": {
      "error": "该版本不是目录中的最新版本，已拒绝安装",
      "ok": true
    },
    "delistedVersionInstall": {
      "error": "目录中没有版本 1.0.1",
      "ok": true,
      "coveredBy": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts:602 「rejects a revoked version and reports the administrator reason」"
    },
    "coveredByIntegrationTests": {
      "unsignedOrSignatureCarryingBundle": "packages/agent-package-format/tests/bundle.test.ts",
      "extraFilesAndMismatchedManifest": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts",
      "retiredAndWrongKeys": "agent-catalog-server/tests/submissions.spec.ts",
      "tooManyEntriesAndLongPaths": "packages/agent-package-format/tests/bundle.test.ts",
      "downgradeAndDelistedLatest": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts",
      "wrongPublishOrAdminToken": "agent-catalog-server/tests/auth-legacy.spec.ts",
      "revocationAndActiveTurn": "dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts"
    }
  },
  "cleanup": {
    "scannedProcesses": 138,
    "matches": [],
    "command": "Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine",
    "note": "Matches are processes whose command line references the throwaway temp root; the probe itself is excluded."
  },
  "verdict": "PASS",
  "exitCode": 0
}
```

### 9.5 与 §8 的差异

- 唯一代码差异是 workflow 的 M2 step 加了 `--experimental-transform-types`（M1 不变）；
  探针逻辑、断言与产品源码零改动。
- M2 step：`1` → `0`；artifact 从「只有 M1 JSON」变为「M1 + M2 两份 JSON」。
- 随机量（`submissionId`、`signedKeyId`、`requestId`、`tempRoot`、端口、`revokedAt`）每轮
  不同属正常；稳定量（11 个布尔、负例集合与文案、`auditLines:44`、`residualProcesses:0`、
  `cleanup.matches:[]`）与 macOS 权威运行一致。
- `cleanup.scannedProcesses` 为 138（Windows 进程基数，与 M1 的三相位一致）。
- 本轮记录本证据的两次文档提交发生在 run 之后（`32db078253`、`2069df57d3`），只改 `docs/`；
  探针与 workflow 的字节与被运行的 `93c1bb0291` 相同。

### 9.6 仍然 `BLOCKED` 的部分

**跨机器验收**（macOS 创建者 + 离线管理员 + Windows 消费机）：没有第二台 Windows 机器，
按 §4 的四步执行，不得用同机双 Profile 或 macOS 探针替代。本文件的 `PASS` 只覆盖
「GitHub Windows runner 上的同机双 Profile 集成测试」。

---

## 10. 最终代码 HEAD 的复跑（final fix wave 之后）

§9 的 green run 在 `93c1bb0291`；final fix wave 在 `b2821f27f7` 修改了 publish sidecar 与
audit reconciliation。按〈最终门槛〉“验收须在最终 HEAD 通过”，本节是最终代码 HEAD 的
canonical 运行。

| 项 | 值 |
| --- | --- |
| 代码 HEAD | `68580abfca5160a2d2e9ea6e96ea636f81585089` |
| 运行 commit | `c966107b19266bdc80f6de01101b07c196aa4694`（其后仅 `docs/` 变更；探针/workflow 字节与代码 HEAD 相同） |
| workflow run | [40205892750](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40205892750) |
| runner | `windows-latest`，Node `v22.23.2` |
| 结果 | job `success`，2m49s；`Windows agent-package acceptance probe` exit 0；`Windows agent-package M2 acceptance probe` exit 0 |
| M2 JSON | `verdict: PASS`，`exitCode: 0`，`platform: "win32"`，11 个字段全 `true`；`residualProcesses: 0`，`cleanup.scannedProcesses: 135`，`cleanup.matches: []` |
| 下架卡片 | `primary: agent.packageRefresh`，`publishStatus: delisted`，`enabled: true`，`catalogError: null`，`revocationWarning: null` |
| 撤销卡片 | `primary: agent.packageRefresh`，`enabled: false`，`revoked.version: 1.0.1`，`activationDisposed: true`，`portClosed: true` |
| artifact | `windows-agent-package-acceptance`（本次下载后归档为 `docs/evidence/2026-10-25-agent-package-m2-windows-finalfix.json`） |

跨机器验收仍为 `BLOCKED`（没有第二台 Windows 机器）；不能用本节的同机双 Profile 结果替代。

