# 智能体包 M1 Windows GHA 探针证据

当前结论：`PASS（GHA Windows 探针）`。绿跑是 [run 40058507608](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40058507608)（`7bd33a5162`，job 退出码 0，`decision.verdict` 为 `PASS`）。这是无界面探针，不是 GUI 真机，也不覆盖真实模型。

退出码不是 0 的运行不要写成 PASS。失败尝试留在下一节，不拿绿跑覆盖它。

PASS 的含义：job `windows-agent-package-acceptance` 退出码 0。它证明下面的硬失败项，不证明 GUI 真机。

仍为可选项、本探针明确不做：

- 会话里「帮我新建一个智能体」的访谈
- 确认卡与同意原句
- 真实模型上的 `@slug`

## 如何触发

1. 打开 GitHub → Actions → **Windows agent package acceptance**。
2. Run workflow，选择含 `.github/workflows/windows-agent-package-acceptance.yml` 的分支。
3. `run_host_liveness` 保持关闭，除非另外要跑 Host 存活测试。该测试不是 Step 5。
4. 运行结束后下载 artifact `windows-agent-package-acceptance`，或从 job 日志复制探针 stdout 的那一行 JSON。

本地不能代替这次运行。非 Windows 上执行 `--platform win32` 会退出码 2。

## 失败记录：run 40057259357

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-24 |
| workflow run URL | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40057259357 |
| 结论 | 未通过。退出码 3，verdict `BLOCKED`。不是 `PASS（GHA Windows 探针）`。 |
| commit | `81769a1b8d9a5bc3ee95c8d6c364bd6216f3d34e` |
| 探针报告 | artifact `windows-agent-package-acceptance`。job 日志里的 blocker 是 `hostExit:Cannot read properties of undefined (reading 'length')`。 |

通过的部分：沙箱探针退出码 0，`enforcement=partial`，`httpReady`、`writeDenied`、`readOutside`、`networkOutside` 均为 true。`httpAfterIdle` 与 `mcpAfterIdle` 均为 started+stopped，`residuals=[]`，端口关闭。

失败的部分：`hostExit` 的 `started` 为 false。子进程日志打出 `host-exit child slug=win-exit-probe` 之后，父进程把 CIM 查询收成只含 `matches` 的摘要，再读 `residuals.length`。`residuals` 是 undefined，TypeError 被记成 fatal。HTTP/MCP 的空 `matches` 说明这不是残留进程。stderr 里重复的 `refreshAgentRestrict: restrict state not found` 不是这次退出码的原因。

## 绿跑：run 40058507608

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-24 |
| workflow run URL | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40058507608 |
| 结论 | `PASS（GHA Windows 探针）`。job `windows-agent-package-acceptance` conclusion `success`。探针 `decision.verdict` 为 `PASS`，`decision.exitCode` 为 0。 |
| commit | `7bd33a516201496cd84410fc0ae7656e36794a04` |
| runner OS | `RUNNER_OS=Windows`，`runner.osRelease=10.0.26100`，`arch=x64`，`runner.name=GitHub Actions 1000000513` |
| 探针报告 | artifact `windows-agent-package-acceptance`（`windows-agent-package-acceptance.json`）。可选的 Host 存活步骤被跳过。 |

`httpAfterIdle`、`mcpAfterIdle`、`hostExit` 都是 `started: true`、`stopped: true`、`residuals: []`。沙箱 `enforcement` 为 `partial`，`httpReady`、`writeDenied`、`readOutside`、`networkOutside` 均为 true。`forceKill.attempted` 为 false，`countsAsHardFail` 为 false。三次 CIM 查询都是 `Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine`，`scanned` 为 138，`residuals` 与 `matches` 都是空数组。报告里没有其他进程的命令行，下面也不贴。

### 探针 JSON

摘自该 run 的 artifact。字段值未改。省略 `sandboxProbe.stderrTail`（沙箱子进程的 EPERM 栈；事实在 `facts`）和临时目录路径。

```json
{
  "kind": "huaanwork-agent-package-windows-acceptance",
  "platform": "win32",
  "commit": "7bd33a516201496cd84410fc0ae7656e36794a04",
  "runner": {
    "os": "Windows",
    "osRelease": "10.0.26100",
    "name": "GitHub Actions 1000000513",
    "arch": "x64"
  },
  "scope": {
    "gui": false,
    "realModel": false
  },
  "sandboxProbe": {
    "exitCode": 0,
    "facts": {
      "platform": "win32",
      "enforcement": "partial",
      "httpReady": true,
      "writeDenied": true,
      "readOutside": true,
      "networkOutside": true
    },
    "timedOut": false
  },
  "phases": [
    { "name": "httpAfterIdle", "started": true, "stopped": true, "residuals": [] },
    { "name": "mcpAfterIdle", "started": true, "stopped": true, "residuals": [] },
    { "name": "hostExit", "started": true, "stopped": true, "residuals": [] }
  ],
  "forceKill": { "countsAsHardFail": false, "attempted": false, "results": [] },
  "decision": {
    "exitCode": 0,
    "verdict": "PASS",
    "hardFailures": [],
    "blockers": [],
    "forceKillIgnored": []
  }
}
```

### 进程查询输出

```text
command: Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine
httpAfterIdle: scanned=138 residuals=[] matches=[] error=null portClosed=true
mcpAfterIdle:  scanned=138 residuals=[] matches=[] error=null portClosed=true
hostExit:      scanned=138 residuals=[] matches=[] error=null portsClosed http=true mcp=true childExitCode=0
```

## 硬失败与观察

硬失败（任一不成立则 job 退出码 1）：

- 沙箱事实为 `enforcement:"partial"`，且 `httpReady`、`writeDenied`、`readOutside`、`networkOutside` 均为 true
- HTTP fixture 在 `afterIdle` 之后端口关闭，且没有该 slug 的残留进程
- MCP fixture 在 `afterIdle` 之后同样停止（现有 fixture 的 JSON-RPC 握手）
- `stopAllAgentPackageProcesses()` 结束且子进程退出后，CIM 查询没有 `agents\<slug>\`，端口也不再接受连接

观察、不决定退出码：

- 残留进程上的 `taskkill /T /F` 是否成功
- `run_host_liveness` 若被打开，其 `test:host-liveness-win` 结果（失败会让 job 失败，但那不是 Step 5 的定义）

退出码 3 表示探针没能开始（例如沙箱探针自身 BLOCKED）。这不是 PASS。

## 升成产品门禁

本页已有 1 次退出码 0 的 run（40058507608）。记录这一次不改 workflow，也不把该检查标成 required。至少 1–2 次本页记录的绿跑之后：

1. 将 job 放入 `.github/workflows/ci.yml`，条件为 `needs.changes.outputs.product == 'true'`，或给本 workflow 增加 `pull_request` / `push` 并使用同一条件。
2. 不要加 `continue-on-error`，也不要删除 `yarn check`、`desktop-windows` 或 `test:host-liveness-win`。
3. 再把 `windows-agent-package-acceptance` 加为 required check。
4. GUI 与真实模型验收仍然不进入该 job。
