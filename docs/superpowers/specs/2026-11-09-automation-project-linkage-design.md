# 自动化任务、项目与运行子任务联动设计

- 日期：2026-11-09
- 状态：已复核；已吸收独立架构复核发现的运行身份恢复、跨文件重试、在途删除竞争、运行标签重复和 prune 活跃续聊问题
- 实施边界：仅 `dsh-plugin-huaanwork/`；不修改 `deepseek-harness/`
- 关联规格：`2026-11-07-neutral-subroots-and-automation-projects-design.md`

## 1. 背景与目标

当前 `automation.create` 已在 `projectId:null` 时创建同名项目，也允许显式复用已有项目和后续改绑。每次 agent 运行已有独立 `runId/sessionId`，但没有项目子任务；运行记录点击只在自动化页打开只读详情。看板 tab、widget 配置以及运行结果 `<pre>` 仍在生产界面。

本设计落地四项行为：

1. 保留并验证“默认创建同名项目、可复用已有项目”的创建合同。
2. 每次实际开始执行的 agent 自动化运行，在本轮所属项目下创建一个带执行日期的子任务，并把运行会话归属该子任务。
3. 新版运行记录跳转到对应项目子任务会话；历史和无会话记录有明确降级。
4. 移除自动化页看板与运行采集结果展示，但保留宿主 `output`，供 `taskShape:"merged"` 继承上下文。

“一次运行”指通过准入并进入 started，而不是点击按钮、进入 queued、被准入跳过或仅产生 missed 记录。

## 2. 已确认裁定

确认来源：项目归属与运行子任务范围两项经用户问答明确确认（2026-11-09）；其余各项随聊天中呈现的完整设计与五项推荐规则获用户整体批准（「复核预期，落成设计文档并撰写实施计划」）。批准链与评审校准详见 [`2026-11-09-automation-project-linkage-design-review.md`](./2026-11-09-automation-project-linkage-design-review.md) §1。

| 决策点 | 规则 |
| --- | --- |
| 项目归属 | 默认新建同名项目；允许用户显式选择已有项目与后续改绑 |
| 同名 | 名称不是键；同名自动化和项目使用不同 UUID，不按名称复用 |
| 改名 | 只保证创建时同名；后续自动化、项目、运行子任务改名互不回写 |
| 运行子任务范围 | 仅 agent；script 不建子任务、不伪造会话 |
| 创建时点 | agent 实际 started、项目校验通过后、`runAgentTurn` 前；准入跳过、queued 取消、missed 不建 |
| 子任务名称 | `<自动化名称> · YYYY-MM-DD HH:mm:ss`，取宿主机本地时区的实际 `startedAt` |
| 多次运行 | 每个 runId 都新建 Task/Session；`merged` 只继承文本，不复用 Task/Session |
| 历史数据 | 不批量回填 Task；旧无 taskId 有 sessionId 的运行保留只读详情，不自动重建可续聊标签 |
| 存量中立自动化 | `projectId:null` 不自动迁移；改绑到已有项目后，新运行才创建子任务 |
| 恢复后续聊 | 新版运行子任务恢复成功后允许续聊；恢复失败不得自动创建替代 Task/Session |
| 看板 | 删除 tab、BoardView、widget 输入与运行时事件；旧 JSON 的 widget 属性仅容忍读取 |
| 采集结果 | 删除任务行和运行记录的 output 展示；不删除宿主 output 存储和 merged 消费 |

## 3. 对象模型与不变量

```text
Project 1 ── N Automation（项目可复用）
Project 1 ── N Task
Automation 1 ── N Run
新版 agent Run 1 ── 1 Task 1 ── 1 Session（正常关联路径）
script / 旧 Run / 未实际启动 Run 1 ── 0 Task
```

### 3.1 新增字段

```ts
type TaskInfo = {
  id: string
  projectId: string
  name: string
  createdAt: number
  sessionId?: string
  modelId?: string
  automationId?: string
  runId?: string
}

type RunSummary = {
  // 既有字段省略
  taskId?: string
}

type AutomationInfo = {
  // 既有字段省略
  activeRunId?: string
}
```

- `TaskInfo.automationId/runId` 只能成对出现；普通任务和旧任务没有这两个字段。
- `RunSummary.taskId`、`AutomationInfo.activeRunId` 均为可选，旧 JSON/JSONL 零迁移可读。
- `activeRunId` 只在注册表为 running 时存在；任何终态对账都必须清除。
- 新版 Run、Task、Session 的权威键分别是 `runId/taskId/sessionId`，禁止按名称或时间戳建立关联。

### 3.2 一致性不变量

1. `(automationId, runId)` 在一个 profile 内最多对应一个 Task。
2. 一个 sessionId 最多绑定一个 Task；沿用现有一对一约束。
3. Task.projectId 是本轮开始时的项目快照；自动化改绑不回写历史 Task。
4. Run.taskId 存在时，必须指向同 `automationId/runId` 的 Task；删除或清理后允许成为不可跳转的历史引用。
5. Task 创建成功是调用 `runAgentTurn` 的前置条件；失败时不得执行模型。
6. `taskRegistryLock` 内只做 tasks.json 读改写，不得持有它调用 `appendRun/markAutomation/finishAutomation`。
7. 不承诺 projects.json、tasks.json、automations.json、runs.jsonl 和会话目录之间的原子事务；所有跨文件删除必须按本设计的锚点顺序幂等重试。

## 4. 创建自动化与同名项目

保留 `automation.create` 的现有主流程：

1. `normalizeAutomationInput` 完成全部字段校验，并预检自动化数量上限。
2. `projectId` 非空时校验项目存在，直接创建自动化，不新建项目。
3. `projectId:null` 时生成新 projectId 和 `<profileDir>/workspace-projects/<projectId>`，项目名使用规范化后的自动化名称，再创建并绑定自动化。
4. 只有项目和自动化均成功才返回成功；客户端同时刷新 projects/automations。
5. 自动化写入失败时沿用现有 best-effort rollback；只有“本次新建、目录仍为空、无其他自动化引用”才删除项目记录和目录。崩溃或回滚失败留下的空项目不自动按名称清理。

后续改名不同步。用户重试一个结果未知的创建请求可能产生另一个合法同名对象；本设计不新增请求幂等键。

## 5. 运行子任务创建与执行

### 5.1 持久化运行身份

`markAutomation(..., {lastStatus:"running"})` 必须在同一次 automations.json 写入中记录 `activeRunId=runId`。`finishAutomation` 或恢复对账写入终态时清除它。

崩溃覆盖：

- running 写入前崩溃：没有 Task，按既有无终态记录窗口处理。
- running 写入后、Task 写入前崩溃：可由 activeRunId 恢复 runId，并推导 agent sessionId。
- Task 写入后崩溃：可由 `(automationId, activeRunId)` 精确找到 Task。
- Run 落盘后、终态注册表写入前崩溃：恢复必须按原 Run 对账，不能再补 cancelled。

### 5.2 执行顺序

`executeRun` 保留现有“取消检查、阶段翻转、run-start 发射之间无 await”的同步段。run-start 只更新运行状态，不创建聊天标签。

1. 标记 started，生成 `startedAt/sessionId` 并发射既有 `automation/run-start`。
2. 写入 `lastStatus=running + activeRunId`。
3. 读取并校验本轮项目；绑定项目已删除时按既有 MISSING_PROJECT 路径收尾，不创建 Task，也不写不存在的 sessionId。
4. 对有有效项目的 agent 调用专用 `createAutomationRunTask`，在同一次 task 锁内完成：
   - 按 `(automationId,runId)` 幂等查找；已存在时校验 projectId/sessionId，名称允许被用户改过。
   - 检查 sessionId 未被其他 Task 占用。
   - 写入 `id/projectId/name/createdAt=startedAt/sessionId/automationId/runId`。
5. 发射 `automation/run-task`，载荷含完整 `task`、`runId/sessionId/trigger`。
6. 调用 `runAgentTurn`，使用同一 sessionId；可写根继续由现有 Task 绑定优先规则解析到项目根。
7. `finishAutomation` 写入 `taskId/sessionId`，并在终态注册表写入中清除 activeRunId。

script 仍使用 `script:<runId>` 写者键，不创建 Task，也没有 sessionId。

### 5.3 失败规则

- Task 创建失败：不调用模型；写 error Run，不带 taskId/sessionId；UI 显示“未建立子任务会话”。
- Task 成功后模型失败、超时或取消：保留 Task/Session，Run 写对应终态和关联字段。
- Run 写入失败：保留 Task/Session 和真实工作，不删除来修复索引；记录宿主错误。
- 新运行未产生会话日志：Task 保留；恢复尝试给出错误，不铸造替代会话。

## 6. 重启残留恢复

首个 scheduler tick 对 `lastStatus=running` 且属于旧 Host generation 的自动化执行：

1. 有 activeRunId 时，先按原 runId 查 runs.jsonl。
2. 若原 Run 已存在：不追加 cancelled；按该 Run 的 `endedAt/ok/status` 对账 lastRunAt/lastStatus，清除 activeRunId，并完成 once 自动化的既有禁用收尾。
3. 若原 Run 不存在：以原 runId 补 cancelled；按 `(automationId,activeRunId)` 查 Task，带上可用 taskId/sessionId。没有 Task 的 agent 仍由 activeRunId 推导 sessionId；script 无 sessionId。
4. 旧 running 记录没有 activeRunId 时保留现有随机 runId 的兼容补记，不伪造 Task 关联。
5. 补记或对账按自动化逐条隔离失败：单条失败写日志并保留 running/activeRunId，不中断同批其余项，使后续启动仍可重试；不得把真实已成功落盘的 Run 改报为失败。

## 7. 自动化页与运行标签

### 7.1 删除范围

- 删除看板 tab、board 分支、BoardView、页头看板文案、任务行 widget chip、创建/编辑 widget 控件。
- 删除前端 `automation/widget` 消费和宿主发射；新记录不再写 widget。读取旧记录不要求 widget 字段，旧属性不参与任何行为。
- 删除任务行展开历史和 RunsPanel 的 `run.output` `<pre>` 及不再使用的样式。
- 保留运行状态、时间、耗时、触发、筛选、删除、会话结果附件和 merged 的 output 消费。

### 7.2 运行标签单一路径

- run-start 不再创建标签。
- run-task 创建或补齐唯一 `run-<runId>` 标签，写入 `taskId/projectId/sessionId/automationId`，标签名取 Task.name；仅 trigger=manual 时聚焦。
- 若相同 taskId 或 sessionId 的标签已存在，只对账字段并激活/复用，不创建第二个标签。
- run-end 继续按 runId 结算运行态并携带 taskId。
- 重启重建只接受“Run.taskId 能解析到现存自动化 Task 且 sessionId 一致”的运行；旧无 taskId、已删 Task、已 prune Task 不重建。重建必须等待首次 tasks 快照成功加载，不能把并发启动时的空快照误判为全部已删。
- `refreshTasks` 必须带单调请求序号：只提交最新一次请求的应答，过期应答直接丢弃；stale 标签对账只消费最新快照。否则早于 Task 落盘发出、晚于 run-task 返回的旧 task.list 会把刚建的运行标签误判为失效并关闭（run-end 不刷新 tasks，无法自愈）。
- 删除运行、删除自动化和 prune 后，客户端在 tasks 权威快照刷新后对账并关闭 taskId 已不存在的自动化标签；刷新失败保留旧快照，不凭空列表误关。
- 重建回填失败时关闭该骨架标签并显示错误，不保留可输入的旧 session 标签。
- `selectSubtask` 对自动化 Task 同时按 taskId/sessionId 去重；恢复失败只显示错误，不走普通任务“发送后新建子任务”的降级。

## 8. 运行记录跳转

RunsPanel 接收最新 tasks 和 `onOpenRunTask`：

1. run.taskId 存在时，按 taskId 查客户端常驻 tasks 快照中的现存 Task；快照由 run-task/删除/prune 后的 onChanged 统一刷新（带请求序号，过期应答丢弃），点击时不单独按需刷新。
2. 只有 Task 存在、来源字段与 Run 匹配且有 sessionId 才可跳转。
3. App 复用子任务选择流程：切主视图、按 Task.projectId 对齐项目、设置 selectedTaskId、复用已有标签或 open+resume。
4. Task 不存在或关联不匹配时不可点，显示“对应子任务或会话已删除/清理”；不得改用自动化当前 projectId 猜测。
5. Task 存在但日志恢复失败时显示错误和重试入口，不创建新 Task/Session。
6. 旧无 taskId 有 sessionId 的记录只读打开现有 HistoryDetailPane。
7. script、missed、无会话取消、Task 创建失败等无 taskId/sessionId 的记录不可点，并显示无会话原因。
8. 删除运行、删除自动化和 prune 后统一刷新 tasks/sessions，并按 taskId 或 sessionId 关闭所有受影响标签，不只关闭 automationId 标签。

## 9. 可重试删除、项目级联与 prune

### 9.1 在途互斥

- 自动化删除先进入进程内 deleting guard，再检查 queued/started 和 scheduler 的 activeAutomationIds；有已准入但尚未入 inFlight 表的 catchup 也拒绝并释放 guard。
- 手动和调度准入在同步调用 scheduler.admitAutomation 前检查 deleting guard；guard 与 admit 之间不得有 await。admit 后到 enqueue 前的窗口由 rootWriter 中持久于内存的 automationId 覆盖。
- 项目删除先进入进程内 `deletingProjectIds` guard，再对其当前绑定的全部 doomed Automations 进入 automation guard 并完成全量在途/活跃预检，然后才逐项删除；任一预检失败时项目注册项保留且不开始级联。已经开始后的子步骤失败不回滚已完成项，保留项目锚点供重试。guard 在 finally 释放。
- 项目 guard 存续期间，`automation.create` 的显式绑定、`automation.update` 的改绑目标校验、`task.create` 必须在同步段 assert 项目不在删除中，否则拒绝——覆盖「级联期间项目仍在 projects.json、存在性检查可通过」的绑定窗口（锚点最后删引入的新窗口，非既有问题）。
- 删除运行、删除自动化生成的 Task、删除自动化时，若目标 sessionId 在权威 activeSessionIds **快照**中，拒绝删除。**该活跃拒绝只覆盖自动化来源对象**；普通 task/project 级联保持既有 release-then-delete 语义（先释放运行态再删日志），不得因普通任务正在对话而拒绝删除项目。
- 残余窗口登记（与 routes.ts 改绑守卫的 check-then-act 先例同形）：activeSessionIds 是调用时快照，`sessionSend` 准入不查删除守卫；快照之后、删目录之前准入的续聊仍会被 release-then-delete。本设计承诺「快照时刻活跃者跳过」，不承诺消除该窗口；同类窗口在既有 deleteAutomationRun/session.remove 已存在。
- activeSessionIds 由 TurnScheduler 的 rootWriters、starting、queue 与 automationCollector 求并集，覆盖自动化结束后的用户续聊；activeAutomationIds 从自动化 rootWriter 的 automationId 读取，覆盖 admit→enqueue 窗口。

### 9.2 删除单条 Run

以 Run 为持久锚点，顺序改为：

1. 拒绝在途 run 或活跃续聊会话。
2. 从 Run 和 `(automationId,runId)` 找到匹配自动 Task。
3. 释放运行态并删除会话目录；ENOENT 视为成功，其他错误中止，保留 Run 供重试。
4. 删除匹配 Task；失败中止，Run 仍保留。
5. 最后删除 Run 行，再按既有规则重算 lastRun 字段。

因此任何崩溃点都能用仍存在的 Run 重试；不再出现“Run 先删、后续失败就永久丢失清理锚点”。

### 9.3 删除 Automation

以自动化注册项为锚点：

1. 进入 deleting guard，拒绝在途自动化或活跃续聊。
2. 收集该 automationId 跨全部项目的自动 Task 和既有 auto-prefix 会话。
3. 逐个释放并删除会话；任何非 ENOENT 失败都中止，注册项保留。
4. 删除该 automationId 的全部自动 Task；失败则注册项保留。
5. 删除 runs/audit；失败则注册项保留。
6. 最后删除自动化注册项并清除调度状态。

项目本身保留。删除项目时逐项复用上述 Automation 删除，再清理该项目剩余 Task/Session，最后才删除 projects.json 条目；项目目录不删除。这样改绑前的旧项目 Task 也会随 doomed Automation 清理。剩余普通 Task 的清理保持既有 release-then-delete 级联（sessions.spec.ts 的 task/project 级联钉子语义不变），不适用自动化来源的活跃拒绝。

### 9.4 prune

prune 的候选是新自动 Task 与旧 auto-prefix 会话目录的并集：

1. 每自动化最近 20 条 Run 对应 sessionId、automationCollector 和 TurnScheduler activeSessionIds 均在 keep 集。
2. 对不在 keep 的候选先经路由释放会话运行态，再删会话目录；ENOENT 成功，其他失败保留 Task 并计入 failed，不得增加 removed。
3. 会话删除成功后，才删除 sessionId 匹配的自动化 Task；普通 Task 永不删除。
4. Task 删除失败时，下一次 prune 仍能由 Task 注册表生成候选并重试。
5. Run 保留；其 taskId 成为不可跳转历史引用。应答含 `removed/tasksRemoved/failed`，前端明确报告部分失败并可重试。
6. runs.jsonl 超过 50 条的自动淘汰仍只删旧 Run，不级联 Task/Session。

边界登记（N2）：keep 集来自最近 20 条 Run 与活跃快照；「Task 已建但 appendRun 失败、Run 未落盘」的会话不在 keep，prune 会清掉该次工作的唯一载体。该窗口随 M2（finishAutomation 失败路径摘 inFlight 条目）修复后触发概率极低，本设计登记接受，不新增保护机制。

## 10. 关键边界汇总

| 场景 | 结果 |
| --- | --- |
| 同名自动化/项目 | 允许，UUID 区分 |
| 自动化或项目改名 | 不回写其他对象 |
| 同日多次/同毫秒运行 | 每 runId 独立 Task；恢复不靠时间戳 |
| 改绑项目 | 旧 Run 经旧 Task 回旧项目，新 Run 进新项目 |
| 存量 projectId:null | 保持旧执行根；不建 Task，运行记录走旧只读会话降级 |
| Task 创建失败 | 不执行模型；Run 无关联且不可跳会话 |
| agent 执行失败/取消/超时 | Task/Session 保留，Run 带终态 |
| 用户删除运行 Task | Run 保留但不可跳转；活跃时拒绝删除 |
| 删除 Automation | 清跨项目自动 Task，保留项目 |
| prune 活跃续聊 | 快照时刻活跃者跳过；快照后准入的残余窗口见 §9.1 登记 |
| 会话恢复失败 | 显示错误/重试，不创建替代 Task/Session |

## 11. 改动文件范围

- `src/client-huaanwork/rpc-types.ts`、`logic/projects.ts`：新增可选关联字段、activeRunId、run-task 事件，退役 widget 合同。
- `src/client-huaanwork/projects.ts`：同步 deleteRun/prune 等 RPC 包装应答类型。
- `src/huaanwork-host/stores.ts`：自动 Task 原子创建、查询和按来源删除。
- `src/huaanwork-host/automations-store.ts`：activeRunId、可重试删除、自动化级联和 prune。
- `src/huaanwork-host/automations-host.ts`：运行创建点、run-task、终态关联和 deleting guard。
- `src/huaanwork-host/automation-scheduler.ts`：准入 guard 和原运行恢复对账。
- `src/huaanwork-host/turn-scheduler.ts`：只读 activeSessionIds/activeAutomationIds 快照，不改互斥原语。
- `src/huaanwork-host/routes.ts`：级联接线、项目/自动化删除守卫和刷新应答。
- `src/huaanwork-host/acceptance-hooks.ts`：验收专用的运行崩溃点注入（主开关 gating，生产默认惰性），供真机恢复验收。
- `src/client-huaanwork/App.tsx`、`logic/runTabsLogic.ts`、`logic/chatTabs.ts`：标签单一路径、恢复、导航和关闭。
- `src/client-huaanwork/logic/automationRunLink.ts`：新建；运行记录跳转目标判定与 stale 标签对账纯函数。
- `src/client-huaanwork/AutomationsView.tsx`：看板/output 移除与运行跳转。
- `src/client-huaanwork/BoardView.tsx`：删除。
- `src/client-huaanwork/styles.css` 及生成产物：清理失效样式。
- 对应 host/client 测试、迁移 fixture 和真机验收证据。

## 12. 验收标准

1. 默认创建自动化出现同名项目；显式复用不新增；同名、失败回滚均通过。
2. agent 手动/schedule/catchup 每次实际 started 只创建一个日期 Task，runId/taskId/sessionId 一致。
3. script、missed、准入跳过、queued 取消不建 Task；merged 仍每轮新建且能读上一轮 output。
4. Task 创建失败不调用模型；执行失败、超时、取消保留关联。
5. 崩溃覆盖 running→Task、Task→Run、Run→终态三个窗口；恢复不丢原身份、不重复 Run、不把成功改失败。
6. 改绑后旧 Run 打开旧项目 Task；新 Run 使用新项目。
7. 运行标签无双开；重启只重建仍有效的新版关联；恢复失败不能写入旧会话或创建替代任务。
8. 自动化页无看板、widget 和 output 展示；新版 Run 正确跳子任务，旧 Run 只读，无会话记录不可点。
9. 删除 Run/Automation/Project、Task 和 prune 的每个失败点均可重试，无失去锚点的半删除；快照时刻活跃的续聊不被清理（残余窗口已登记）；项目删除期间新建/改绑/建子任务被拒绝，普通任务级联语义不变。
10. `corepack yarn test`、`corepack yarn typecheck`、`corepack yarn check` 全部通过。
11. 真机隔离实例逐项验证创建、手动/定时/补跑、跨项目跳转、续聊、删除、prune、Host 重启；未实际执行的项目标 BLOCKED，不以单测代替。
