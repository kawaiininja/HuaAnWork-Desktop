# 自动化项目与运行子任务联动 — 真机验收证据

- 日期：2026-11-10
- 计划：`docs/superpowers/plans/2026-11-09-automation-project-linkage.md` Task 9
- 规格：`docs/superpowers/specs/2026-11-09-automation-project-linkage-design.md`
- 分支：`feat/automation-project-linkage`
- 基线：master `9c70989d53`；实现提交 `38d8b47327`…`f48f0d8bb1`（本证据文档随后单独提交）
- 隔离实例：`mktemp -d` 临时根（700），复制 `~/.huaanwork` 与 `profile-selection/state.json`；`DSH_HOME=<tmp>/.huaanwork`，`--user-data-dir=<tmp>/userData`，CDP `9333`；**未使用共用生产数据的 dev 实例**
- 模型：profile 自带 `deepseek-flash`（`api.deepseek.com`），验收期间真实调用成功

**验收对象映射（两个 agent 自动化）**

- 主自动化 `6eb42412-…`（名称「每日十万个为什么」，提示词「用一句话解释为什么天空是蓝色的。」）：崩溃窗口 1-3、第 2 项手动运行、第 6 项的 Run/Task 删除、第 7 项 prune 均使用它。
- 副本自动化 `db63ccef-…`（同名，提示词「再说一句为什么云是白色的。」）：第 3 项定时/补跑、第 5 项改绑、第 6 项 Automation/Project 删除使用它。
- 脚本自动化 `a3a8024b-…`（名称「验收脚本」）：第 8 项 script 记录无会话。

## 1. 全量门禁与构建（Task 9 Step 1-3）

| 命令 | 结果 |
| --- | --- |
| `corepack yarn test` | exit 0（标记 `GATE_TEST_EXIT=0`） |
| `corepack yarn typecheck` | exit 0（标记 `GATE_TYPECHECK_EXIT=0`） |
| `corepack yarn check` | exit 0（标记 `GATE_CHECK_EXIT=0`） |
| `corepack yarn workspace dsh-plugin-huaanwork build` | exit 0 |
| `corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native` | exit 0 |

未跳过任何 hook、未裁剪门禁。完整日志尾部见实现会话报告 `.superpowers/sdd/2026-11-09-automation-project-linkage/task-9-report.md`（未入库；门禁标记已在此表内联）。

## 2. 三个崩溃窗口（Task 9 Step 4）

方法：以 `HUAANWORK_ACCEPTANCE_HOOKS=1` + `HUAANWORK_ACCEPTANCE_CRASH_POINT=<point>` 启动隔离实例 → UI「立即运行」→ Host 在注入点 `process.exit(1)`（日志 `DSH Host exited (1); restart the application to reconnect`）→ 记录崩溃时磁盘状态 → 不带 crash point 正常重启 → 等待首个 tick（默认 60s）→ 核对恢复结果。

> 现场偏差（已登记）：
> - 本版本 supervisor 不自动重启 Host，而是提示「restart the application」；恢复发生在我们正常重启后的新 Host generation 首个 tick，恢复语义与窗口覆盖不变。
> - 成功恢复**不打印日志行**（现有实现只在失败时 `console.error`）；三个窗口的恢复日志侧证据只有上述崩溃退出行 + 恢复期间无错误输出，恢复结果以磁盘状态为准。这是证据字段的限制，不是跳过证据。

| 窗口 | 崩溃时磁盘状态 | 恢复后断言 | 判定 |
| --- | --- | --- | --- |
| `after-running-mark` | `automations.json`：`lastRunAt:1794287478719`、`lastStatus:"running"`、`activeRunId:"d2e16ec2-219b-41aa-8a77-a1062272c500"`；`tasks.json` 无新 Task（仍为验收前的 2 条普通任务）；该自动化无 runs 文件 | 补一条 `cancelled` Run，复用**原 runId** `d2e16ec2-…`；`sessionId` 为推导的 `huaanwork-auto-6eb42412-…-d2e16ec2-…`；无 Task 不伪造；`lastStatus:"error"`、`activeRunId` 清除 | PASS |
| `after-run-task` | `automations.json`：`lastRunAt:1794287594701`、`lastStatus:"running"`、`activeRunId:"a048cd5c-94ea-4177-a934-c1ff0a026d7f"`；Task 已建 `9e15dbfb-…`（名称 `每日十万个为什么 · 2026-11-10 13:13:14`，`sessionId:"huaanwork-auto-6eb42412-…-a048cd5c-…"`、`automationId:"6eb42412-…"`、`runId:"a048cd5c-…"`）；runs 文件只有窗口 1 的补记 | `cancelled` Run 带**原 runId** `a048cd5c-…`、`taskId:"9e15dbfb-…"`、`sessionId`；Task 保留且来源字段完整（本次未单独点开该 Task 验证跳转；跳转路径由第 2/4 项覆盖）；`lastStatus:"error"` | PASS |
| `after-run-append` | Run 已落盘且 `status:"ok"`、`ok:true`、带 `taskId/sessionId`；注册表仍 `running` + `activeRunId:"e85678e5-…"` | 不重复补记（runs 仍 3 条）；按原 Run 对账 `lastStatus:"ok"`（**未把成功的 Run 改报失败**）；`activeRunId` 清除 | PASS |

窗口 1 恢复后 runs.jsonl（原 runId 复用、无 taskId、推导 sessionId）：

```json
{"runId":"d2e16ec2-219b-41aa-8a77-a1062272c500","startedAt":1794287478719,"endedAt":1794287556050,"ok":false,"output":"sidecar 重启，上次运行被中断","status":"cancelled","trigger":"schedule","durationMs":77331,"sessionId":"huaanwork-auto-6eb42412-dbf7-4e34-8de7-b6fa52740e48-d2e16ec2-219b-41aa-8a77-a1062272c500"}
```

窗口 2 恢复后 runs.jsonl（原 runId 复用、携带 Task 关联）：

```json
{"runId":"a048cd5c-94ea-4177-a934-c1ff0a026d7f","startedAt":1794287594701,"endedAt":1794287669631,"ok":false,"output":"sidecar 重启，上次运行被中断","status":"cancelled","trigger":"schedule","durationMs":74930,"taskId":"9e15dbfb-3bb6-4999-9618-97b25c742fdd","sessionId":"huaanwork-auto-6eb42412-dbf7-4e34-8de7-b6fa52740e48-a048cd5c-94ea-4177-a934-c1ff0a026d7f"}
```

窗口 3 恢复后 runs.jsonl（既有 ok Run 保留、未重复、未改报失败）：

```json
{"runId":"e85678e5-f59c-4d41-88a7-435c530b2d99","startedAt":1794287691026,"endedAt":1794287692758,"ok":true,"output":"天空是蓝色的，主要因为太阳光穿过大气层时…","status":"ok","trigger":"manual","durationMs":1732,"sessionId":"huaanwork-auto-6eb42412-dbf7-4e34-8de7-b6fa52740e48-e85678e5-f59c-4d41-88a7-435c530b2d99","taskId":"ab765ed9-f8ce-441d-b71c-5a810053b764"}
```

## 3. 交互验收（Task 9 Step 5）

| # | 项目 | 执行与证据 | 判定 |
| --- | --- | --- | --- |
| 1 | 创建「每日十万个为什么」，侧栏立即出现同名项目；同名再建得到不同 UUID | 创建后侧栏即时出现 `每日十万个为什么` + UUID `ddfe513f-…`；同名再建得到 `7c898ae2-…`（`projects.json` 两条同名不同 id）；脚本自动化同样自动建同名项目 `044df1f8-…` | PASS |
| 2 | 手动运行，项目下出现带本机日期时间的子任务，运行标签与运行记录指向同一 Session | 主自动化 Run `e85678e5-…` 的 Task `ab765ed9-…` 名称 `每日十万个为什么 · 2026-11-10 13:14:51`；该 Run 的 `taskId`/`sessionId` 与 Task 完全一致；运行记录点击打开该 Task 会话 | PASS |
| 3 | 等待一次定时运行并触发一次 catchup；每次实际 started 各一个新 Task | 副本自动化 interval=1 分钟：定时 Run `c8bfaf15-…`（Task `1e71d254-…`，13:19:01）；另一次 interval Run（13:20:21）；把 `nextRunAt` 置为 15 分钟前（超出 10 分钟宽限、`missedPolicy=run-once`）→ catchup Run `8d2bc1fb-…`（`trigger:"catchup"`、`coalescedCount:17`、Task 13:21:49） | PASS |
| 4 | 运行记录点击切到正确项目/Task；重复点击不产生重复标签 | 点击成功 Run 打开对应 Task 会话；同一 Run 重复点击后侧栏运行标签仍只有 1 个（按 tabId/taskId/sessionId 去重） | PASS |
| 5 | 改绑项目后点击旧 Run，仍回旧项目；新 Run 进新项目 | 副本自动化改绑到「自动化文件搬运」后：旧 3 个 Task 仍在 `7c898ae2-…`（旧项目）；新 Run `78e6e5ca-…` 的 Task 在 `2b4a041d-…`（新项目）。验收时目检截图 `old-run-project.png`（旧项目高亮）与 `after-new-run-click.png`（新项目高亮）；**截图未入库、已随临时根删除，该项高亮判断不可独立复核** | PASS |
| 6 | 删除 Run、Task、Automation、Project 各走一遍；确认无悬空 Task/Session；项目删除期间新建/改绑/建子任务被拒绝（T1） | 删除 Run `d2e16ec2-…`：runs 行消失、无 Task 受影响；删除 Task `9e15dbfb-…`：Task 消失、Run 保留且运行记录显示「对应子任务或会话已删除/清理」；删除副本 Automation `db63ccef-…`：它的 4 个跨项目 Task、runs 文件、会话目录全部清除；删除 Project `7c898ae2-…`：`projects.json` 条目消失、该项目 Task 为空、**项目目录仍在磁盘**（规格要求）。T1 的「删除期间拒绝创建/改绑/建子任务」为进程内同步窗口，实机未复现该时序；由 `routes.spec.ts` 路由级用例覆盖（`beginProjectDeletion` 存续期间三个消费点均拒绝） | PASS；**T1 实机时序 BLOCKED（以路由测试为证）** |
| 7 | 对旧 Run 执行续聊，再 prune；活跃续聊会话不被删，超保留期 Task 与会话按协议清理，Run 保留且不可跳 | 停实例后为主自动化 `6eb42412-…` 播种 22 条 Run（其中 `seed-old-1` 带 Task `seed-task-1` 与会话目录），使既有 Run 落在最近 20 条之外；重启后从运行记录打开旧 Run `e85678e5-…` 并发送长回合，回合进行中执行「清理历史运行会话」：结果 `已清理 1 个历史运行会话、1 个运行子任务`。核对：**活跃**会话（e856）与其 Task 保留；`seed-task-1` 与其会话目录删除；runs 仍 24 条（Run 不删）；`seed-old-1` 行显示「对应子任务或会话已删除/清理」且不可点 | PASS |
| 8 | 自动化页确认无看板、widget、采集结果；script 记录明确无会话 | 自动化页/运行记录页：`.run-output` 节点 0、`[class*=board]` 0、页面文本不含「看板」「推送到项目看板」；创建并手动运行 script 自动化「验收脚本」（`echo hello-from-script`）：Run 有 `output:"hello-from-script\n"`、**无 sessionId**、无 Task；运行记录显示「脚本运行无会话」 | PASS |

## 4. 残余风险与登记

- **T2 快照窗口**（spec §9.1 已登记）：活跃检查是调用时快照；`sessionSend` 准入不查删除守卫，快照后准入的续聊仍可能被 release-then-delete。本次未承诺消除。
- **N2 边界**（spec §9.4 已登记）：「Task 已建但 appendRun 失败、Run 未落盘」的会话不在 keep 集，prune 可能清掉该次工作的唯一载体；M2 修复后触发概率极低。
- **验收播种**：第 7 项为制造「超保留期」条件，在停实例后向隔离实例的 profile 副本播种了 22 条合成 Run、1 个 Task 与 1 个会话目录；prune 执行的是生产代码，非单测替身。
- **未执行 / BLOCKED**：第 6 项的 T1 实机删除期时序未复现（以路由级测试为证据，已在第 6 行标注 BLOCKED）；无 Windows 主机，Windows 侧未验证（超出本计划范围）。
- **截图不可复核**：`old-run-project.png`、`after-new-run-click.png`、`automation-runs-final.png` 位于临时根（已随清理删除），未入库（public 仓库不提交截图）；其内容仅为验收时目检记录，非可独立复核证据。
- **存量中性（`projectId:null`）agent 自动化没有实时运行标签**：run-start 不再建标签、也不创建 Task，其运行只能在「运行记录」里作为旧版只读会话打开。这是规格 §7.2/§10 的直接后果，登记给下一次规格触达。
- **规格 §8.5「显示错误和重试入口」按「只显示错误」实施**（计划 Task 5 Step 4）：重试方式为再次点击该运行记录，验收第 4 项已覆盖。登记为有意的收窄，不是缺陷。

## 5. 清理与交付

- 隔离实例已停止；临时根仅含本次验收数据，已删除。
- 未 push、未创建 PR；未修改 `deepseek-harness/`。
