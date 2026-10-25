# 智能体包 M2 Windows GHA 验收证据

当前结论：**`BLOCKED`（未运行，不是 PASS）**。

原因（裁定 C21）：本执行环境是一台 macOS 主机，**不能推送分支**，因此无法触发
`workflow_dispatch`（GitHub Actions 只能对远端已存在的 ref 派发运行），也没有第二台
Windows 机器。按本任务规则，未产生退出码 0 的 Windows 运行就只能记 `BLOCKED`，不得写
`PASS`，也不得用同机双 Profile 的结果冒充 Windows 真机。

本文件只记录**待执行的命令与 runbook 步骤**。运行 URL 一栏是占位符，必须由实际执行者
替换为真实 URL 并附上 artifact 里的原始 JSON。

## 1. 状态

| 项 | 值 |
| --- | --- |
| 结论 | `BLOCKED` |
| 运行日期 | 未运行 |
| workflow run URL | `<未产生；执行后填入 https://github.com/<owner>/<repo>/actions/runs/<run_id>>` |
| 退出码 | 未产生（不得写 0） |
| commit | 未产生 |
| runner | 未产生（预期 `windows-latest`，Node 22.23.2） |
| artifact | 未产生（预期 `windows-agent-package-acceptance`，含 `windows-agent-package-m2-acceptance.json`） |

在拿到退出码 0 的运行之前，`docs/huaanwork-agent-packages-m2.md` 的 Windows 行保持
`BLOCKED`，且**不得**出现“M2 双平台验收 PASS”。

## 2. 触发方式（实际执行者照做）

1. 把包含本任务改动的分支推到远端（本地 `feat/agent-packages-m2`；本环境未 push）。
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

## 5. 运行记录（待填）

```text
日期:
workflow run URL:
commit:
runner(os/osRelease/name/arch/node):
M1 step 退出码:
M2 step 退出码:
探针 verdict / exitCode:
residualProcesses / cleanup.matches:
artifact 文件名:
原始 JSON:
（粘贴 windows-agent-package-m2-acceptance.json 全文）
```

## 6. 已知边界（与平台无关）

- 探针不打开 GUI、不做会话访谈/确认卡、不跑真实模型；这些是独立人工项。
- 探针的沙箱是 passthrough seam：M2 验证签名包生命周期，沙箱 `enforcement`、写入拒绝、
  读/网络观察由 M1 的 Windows sandbox probe 负责。Windows 上沙箱自报 `partial`、读与网络
  不隔离是已接受事实。
- 探针每次运行生成新 key/token，`submissionId`、`keyId`、端口每次不同属正常。
