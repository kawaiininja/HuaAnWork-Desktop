# 智能体包 M1 Windows GHA 探针证据

绿跑之后的标签：`PASS（GHA Windows 探针）`。第一次 dispatch 未通过，当前不是 PASS。

退出码不是 0 的运行不要写成 PASS。下面先记这次失败，绿跑另起一节，不覆盖失败记录。

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

## 如何把结果填进来

保留命令原文。不要改写探针 JSON，不要删掉失败字段。

| 项 | 值 |
| --- | --- |
| 日期 | （待填） |
| workflow run URL | （待填） |
| 结论 | （待填：job 退出码 0 才写 `PASS（GHA Windows 探针）`） |
| commit | （待填，与 run 的 SHA 一致） |
| runner OS | （待填，例如 `RUNNER_OS` 与报告里的 `runner.osRelease`） |
| 探针报告 | （待填：artifact 文件名，或把 JSON 贴在下一节） |

### 探针 JSON

把 stdout 的单行 JSON 或 artifact `windows-agent-package-acceptance.json` 贴在这里。至少保留：

- `decision.verdict` 与 `decision.exitCode`
- `sandboxProbe.facts`（`enforcement`、`httpReady`、`writeDenied`、`readOutside`、`networkOutside`）
- `phases` 里 `httpAfterIdle`、`mcpAfterIdle`、`hostExit` 的 `started` / `stopped` / `residuals`
- `forceKill`（只是观察；`countsAsHardFail` 应为 false）
- `details.hostExit.processQuery.command`、`residuals` 与 `matches`

进程查询是 `Get-CimInstance Win32_Process`。报告只收录命令行含 `agents\<slug>\` 或 `agents/<slug>/` 的行，外加扫描到的进程数。不要把 runner 上其他进程的命令行贴进仓库。

### 进程查询输出

```text
（待填：报告中的 processQuery，或 job 日志里对应的 stderr 行）
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

至少 1–2 次本页记录的绿跑之后：

1. 将 job 放入 `.github/workflows/ci.yml`，条件为 `needs.changes.outputs.product == 'true'`，或给本 workflow 增加 `pull_request` / `push` 并使用同一条件。
2. 不要加 `continue-on-error`，也不要删除 `yarn check`、`desktop-windows` 或 `test:host-liveness-win`。
3. 再把 `windows-agent-package-acceptance` 加为 required check。
4. GUI 与真实模型验收仍然不进入该 job。
