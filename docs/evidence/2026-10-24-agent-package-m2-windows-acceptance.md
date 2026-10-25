# 智能体包 M2 Windows GHA 验收证据

当前结论（2026-10-25 Task 13 补救轮更新）：M2 的 Windows step **已实际运行并失败**
（`FAILED`，exit 1，run `40195462983`）。失败原因**不是产品行为**，而是 TypeScript
strip-only 的结构性限制：探针新引入的 `routes.ts` 含参数属性，`node`（无 flag）在 import
阶段就抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（§8）。同一次 run 里 **M1 的 Windows 探针
PASS**，说明 Windows 主机、Node 与 workflow 本身可用。

跨机器验收仍为 **`BLOCKED`**（没有第二台 Windows 机器）。

> 2026-10-24 的历史记录（§1–§7 的部分行文）写的是「未运行 / `BLOCKED`」，原因是当时环境
> 不能 push。本轮环境**可以** push（`origin` 已配置、`gh` 已认证），因此按任务要求实际推了
> 分支并触发 `workflow_dispatch`，结论从「未运行」前移为「运行了、M2 step 失败」。M2 仍
> **不是** `PASS`，也不得被读成 `PASS`，且**不得**用 macOS 探针或同机双 Profile 冒充。

## 1. 状态

| 项 | 值 |
| --- | --- |
| 结论（M2 Windows step） | **`FAILED`**（exit 1；结构性 strip-only，见 §8） |
| 结论（M1 Windows probe，同一 run） | `PASS`（exit 0，见 §8） |
| 结论（跨机器验收） | `BLOCKED`（没有第二台 Windows 机器，见 §4） |
| 运行日期 | 2026-10-25T12:58Z（run 创建）；M2 step 于 2026-10-25T13:01:27Z 失败 |
| workflow run URL | <https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40195462983> |
| 退出码 | M1 step `0` / M2 step `1` |
| commit | `650e749af7f8445b37c26c49df4feaf33e267f92`（`feat/agent-packages-m2`） |
| runner | `windows-latest`：Windows / `10.0.26100` / GitHub Actions 1000000568 / x64 / Node `v22.23.2` |
| artifact | `windows-agent-package-acceptance`（ID `12599578870`）：**只**含 `windows-agent-package-acceptance.json`（M1）；M2 的 JSON 不存在（step 在 import 阶段就退出） |

在 M2 step 拿到退出码 0 之前，`docs/huaanwork-agent-packages-m2.md` 的 Windows 行保持
`BLOCKED`，且**不得**出现“M2 双平台验收 PASS”。

## 2. 触发方式（实际执行者照做）

1. 把包含本任务改动的分支推到远端（`feat/agent-packages-m2` 已于 2026-10-25 非 force
   push 到 `origin`；复跑前先确认远端是该提交或其后继）。
2. GitHub → Actions → **Windows agent package acceptance** → **Run workflow**，选择该分支。
   `run_host_liveness` 保持关闭（它不是 M2 验收；打开会先构建包再跑 Host 存活测试）。
3. 等待 job `windows-agent-package-acceptance` 结束。M1 步骤与 M2 步骤是**两个独立 step**：
   - `Windows agent-package acceptance probe`（M1，保持不变）；
   - `Windows agent-package M2 acceptance probe`：
     ```bash
     node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
       --platform win32 --out windows-agent-package-m2-acceptance.json
     ```
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

## 5. 运行记录（2026-10-25 实际运行）

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
（Windows 上 M1 探针 PASS、M2 探针因 strip-only 失败，见 §8）。

| 项 | 结果 |
| --- | --- |
| `corepack yarn check` | 本轮未重跑（Task 14 收口时执行）；上一轮 `c144a73383` 为 0（15 个顶层步骤全过） |
| `corepack yarn check:desktop-variants` | 同上 |
| `corepack yarn typecheck` | 0（`dsh-plugin-huaanwork`，2026-10-25 补救轮单独执行） |
| `corepack yarn test` | 同上（本轮只跑了相关 spec，见 macOS 证据） |
| macOS 探针最终运行 | `PASS`，exit 0，commit `650e749af7`（干净已跟踪树），`residualProcesses=0`；原始 JSON 见 macOS 证据 §8.6 |
| Windows GHA | **已实际运行**：run `40195462983`；M1 step `PASS`(0)，M2 step `FAILED`(1，结构性)，见 §8 |
| 跨机器验收 | **`BLOCKED`**：只有一台 macOS 主机 |

Windows 结论仍然只能由 §2 的 `workflow_dispatch` 运行产生；在看到 M2 step 退出码 0 之前，
本文件与 runbook 都不得写 `PASS`。

## 8. 2026-10-25 实际运行（Task 13 补救轮）

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

收尾选项（**均超出 Task 13 的 Files 白名单，本轮未执行**，需 Task 14 裁定）：

- (a) 把 `RouteError` 改成可擦除语法：显式字段声明 + 构造函数内赋值（约 4 行，构造签名与
  `instanceof` 行为不变）。`src/huaanwork-host/` 是单侧前缀，不占变体白名单名额；改完
  macOS 与 Windows 都能用 brief 的字面命令跑。
- (b) 在 workflow 的 M2 step 与 runbook 命令上加 `--experimental-transform-types`（只改
  TS 语法转译方式，不改探针逻辑）；代价是 workflow 与文档同时偏离 strip-only 约定。

在任一选项落地并重跑成功之前，Windows 的 M2 结论保持 `FAILED`，跨机器保持 `BLOCKED`。

### 8.6 仍然 `BLOCKED` 的部分

- **跨机器验收**（macOS 创建者 + 离线管理员 + Windows 消费机）：没有第二台 Windows 机器，
  按 §4 的四步执行，不得用同机双 Profile 替代。
- **Windows M2 探针重跑**：依赖 §8.5 的 (a) 或 (b) 先落地，然后重跑
  `windows-agent-package-acceptance.yml` 并把新 run URL 与 artifact 填回 §1/§5。
