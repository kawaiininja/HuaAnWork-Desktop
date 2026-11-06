# 多项目并发任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已登记的不同项目根可以同时各跑一个可写任务，并发上限可配置（1–8，默认 3），每个任务绑定自己的模型，同一根上的后续任务可见排队。

**Architecture:** 新增纯函数调度器负责写者名额、并发计数和内存队列。调用方先异步算出可写根，再把 `root` 传进准入。宿主在 `followup` 已受理、消息已排队或确认未启动时都立刻应答，不等待 `whenIdle`；回合真正结束后才释放名额并继续出队。可写根和模型绑定都放在宿主 Map 里，不写入上游 `SessionHeader`。沙箱、护栏、Git、截图、diff 和智能体包按这张根表夹紧，不再跟随前台根。`sendToAgent` 准入、`net-gate.ts` 和 `model.ts` 的 `stream` 都按本次绑定模型的 `base_url` 做网络门禁。自动化拆除全局串行链；每次运行只准入一次。因根忙或名额满而跳过的到期项不进入 10 分钟错过宽限，超过宽限后仍可被后续 tick 准入。

**2026-11-04 修订：** 吸收 `docs/superpowers/plans/2026-11-03-concurrent-project-turns-plan-review.md` 里经复核成立的条目。`header.writableRoot` 不再作为通道。`resolveRoot` 从调度器删除。`net-gate.ts`、`policy.ts`、`git.ts`、`web.ts`、`bridge.ts`、`agent-package/host.ts`、`agent-package-tools.ts` 纳入对应任务。出队有客户端事件。每次运行只调用一次 `admitAutomation`。`task.setModel` 走 RPC。路由契约的方法计数随新路由更新。Task 11 的 `rg` 命令不改 PATH。同日第二轮只补两处：Agent 自动化与已持久化会话登记自己的可写根；出队遵守名额上限，复检失败后再次 `releaseAndDrain`。

**2026-11-04 Kimi 复核吸收：** 两张会话 Map 先登记进 `holders.ts` 再赋值。`admitAutomation` 成功时写入 `rootWriters`。调度键用 `path.resolve`。run-once catchup 走同一次准入。脚本释放等子进程 `close`。每次准入只有一个 `releaseOnce`。出队启动失败发 `session/queue-fail`。客户端按回合身份结算停止、终态和 diff。同日确认：带 `queueItemId` 的取消只移除该项；队列保存 `skill` 与 `at` 并原样重放。规格 §4.2 与 §5.5 已按这两条改过。

**2026-11-04 第五轮复审吸收：** `session.send` 增加 `started`。创建取消和更新失败提示返回 `started: false`，仍只发原来的 `agent/notice`，不抛成路由错误。出队后没受理 `followup` 时只发 `session/queue-fail`，不发 `session/queue-start`。客户端的 epoch、`turn-started` 和 `running` 只在直接应答 `started: true` 或 `session/queue-start` 时发生。epoch 按标签存放。既有 `sessionSend` / `session.send` 测试调用补上 `tabId`。规格 §4.6、§5.2.1、§5.4、§5.5 与失败表已按这三条改过。

**2026-11-04 Map 规则复审吸收：** 可写根与模型不再共用写入时点。根表在 create/resume 前登记，自动化在 `sendToAgent` 前登记；模型表只在 `followup` 受理后登记。自动化把启动时的 `activeModelId` 显式传给 `sendToAgent`，不再预写模型表。新增首建会话根与自动化启动模型两条回归。

**2026-11-04 第七轮开放项吸收：** 排队和 `started:false` 不再清停止闩锁或重置进度；goal active 的中间结束不清 running，stale idle 与停止票据都读所属标签 epoch。`queueItemId` 在应答后写回已插入的用户消息。queue-fail 与既有 notice 去重，源码测试同时覆盖 send 与 queue-start，接口函数计数和 Architecture 应答表述同步订正。

**2026-11-04 第八轮竞态吸收：** fetch 应答与 WebSocket 事件不保证先后。每次发送在 RPC 前建立 pending 关联，早到的 session/end、queue-start、queue-fail 先按本次发送缓冲；应答先写回 started/queueItemId，再初始化对应回合并按序重放。started:false 只丢弃本次缓冲，同标签上一回合的事件不得被一并延迟。

**2026-11-05 第八轮抛错路径吸收：** `session.send` 抛错只失败本次发送：保留同标签正在执行回合的停止闩锁、`stopping`、epoch 与 `running`，不把该标签标成 `sessionFailed`，仍追加失败原因。未启动且无 `queueItemId` 的消息不参与终态或最新用户消息选择；`catch` / `finally` 清理本次 pending 与缓冲。Task 11 同时补上降低并发上限的自动条款。

**2026-11-05 R8-M1 复审补遗：** R8-M1 专项复审通过。Task 9 的方法计数同步补上第四处 `market-routes.spec.ts`（「ROUTE_TABLE 不受影响(表外注册,71 不破)」的断言值与测试标题随 71→72 一起改），并把它加入 Task 9 的 Files、Step 4 运行命令与提交清单。

**2026-11-06 P 波订正：** 三轮复核的 P-1..P-4 处置与规格对齐：pending 记录保持按标签一条（每标签发送护栏串行化发送，标签键已唯一）；无 `sessionId` 且没有唯一占名额回合时，宿主不做 diff 快照、不发事件；持久化会话缺 `cwd` 时按现有「其他工作区」消息 fail closed，不靠推导出的根放行。

**Tech Stack:** TypeScript ESM、Vitest、现有 `huaanwork-settings.json` / `projects.json` / `tasks.json`、Yarn 4.18.0 / Corepack。不新增依赖，不修改 `deepseek-harness/`。

## Global Constraints

- 设计真相源：`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`。评审：`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design-review.md`。实施只改 `dsh-plugin-huaanwork/` 与本计划点名的证据记录。
- `max_concurrent_turns` 是整数。缺省、缺失、非整数、非有限数为 3；小于 1 生效为 1；大于 8 生效为 8。读取不改写文件。用户保存时写下生效值。
- 同一可写根同时只有一个写者。子目录不另算一根。子代理不另占名额，沿用父会话的模型绑定。
- `session.send` 的应答在「已开始」「已排队」或「未启动」时返回，不等待 `whenIdle`。返回体是 `{ queued: true, waiting: boolean, started: boolean, sessionId: string, queueItemId?: string }`。`waiting: true` 时 `started` 为 false。`waiting: false` 且 `started: true` 表示 `followup` 已受理。`waiting: false` 且 `started: false` 表示没有把回合交给 agent：创建取消和更新失败提示走这条，HTTP 正常返回，不抛错，不把标签标成发送失败。网络门禁、缺文本、缺 `tabId`、根不存在、模型不在列表中仍抛错。`whenIdle` 之后的 `release` 是应答之后的延续，并且必须接着消费 `drainQueue()`。`drainQueue` 在 `activeTurns >= max` 时不再取出。出队后的复检失败、出队后抛错、出队后 `started: false` 都要 `releaseAndDrain`，不能只 `release`。这三种都不发 `session/queue-start`。`session.cancel` 不立刻 `release`。`session.resume` 不走 `admitUserTurn`。
- `huaanworkSessionRoots` 与 `huaanworkSessionModels` 不共用写入时点。根表在 `agents.create` / `agents.resume` 前登记；项目级 Agent 自动化在 `sendToAgent` 前登记，因为创建会话和沙箱夹紧都需要它。模型表只在 `followup` 受理后写入。没调用 `followup` 就返回时，不写模型表，也不删除这次发送之前已经存在的模型键。根表始终保存会话的真实可写根：本次已为创建/恢复登记的有效根不因无 `followup` 而删除或改回前台；自动化运行自己的两个键仍在其 `finally` 中清理，`sessionRemove` / `subagent/end` 按既有规则清理。
- 客户端只在直接应答 `started: true`，或收到 `session/queue-start` 时，才增加该标签的 epoch、发出 `turn-started`、把该标签 `running` 设为 true，并记下活动用户消息。排队应答和 `started: false` 不做这些事。`session/queue-fail` 只去掉对应等待项；仍在执行的上一回合保持 `running`。epoch 按标签 id 存放。一个标签排队或另一个标签开始回合，都不改变正在执行的标签的 epoch。`finishStop` 比较该标签自己的 epoch。
- 排队和 `started: false` 还不得清除正在执行回合的 `userStopSessionRef`、`latchOwnerRef`、`stopping` 或既有进度。`goal/round` 只恢复事件所属标签的 `running`；目标相位仍为 `active` 的中间 `session/end` 不清该标签的 `running`，真正终局才清理。`consumeStaleIdle`、`stopTurn` 造票据、`settleStop` 与 `finishStop` 全部读取事件所属标签的 epoch，不拿另一标签的当前值判定旧结束。
- fetch 应答与 WebSocket 事件不保证先后。每次 `send()` 在 RPC 前以 `tabId + 本地 userMsg.id` 建一条 pending 记录，保存已知 sessionId，但 pending 本身不开目标窗、不增加 epoch。未知 queueItemId 的 `session/queue-start` / `session/queue-fail` 若落在该标签的 pending 期间，按标签和到达顺序暂存；已能匹配其他等待消息的队列事件仍即时处理。直接 pending 且该标签没有正在执行的同会话回合时，匹配 sessionId 的早到 `session/end` 与 goal 事件也暂存；若上一回合仍在执行，它的事件必须照常即时处理，不能为了新发送而缓冲。应答回来后，先写回 started/queueItemId，再在 started:true 或重放 queue-start 的时点初始化回合，最后按原顺序重放本次事件；started:false 只丢弃本次缓冲。`agent/notice` 不缓冲，创建取消和更新失败仍即时展示。
- `session.send` 抛错只失败本次发送。它不得清除同标签正在执行回合的 `userStopSessionRef`、`latchOwnerRef`、`stopping`、epoch 或 `running`，不得把仍在执行的标签标成 `sessionFailed`，也不得因停止闩锁仍扣着而吞掉本次错误脚注。已插入但这次没有成为活动回合、也没有 `queueItemId` 的用户消息不参与终态或「最后一条用户消息」选择。`catch` 与 `finally` 必须让本次 pending 及其缓冲得到幂等清理，不得拖住上一回合的后续事件。
- 不向 `session.header` 写入 `writableRoot`。上游 `SessionStore.prepare` 只保留既有 header 字段，构造后 `deepFreeze`。可写根只放在 `ctx.huaanworkSessionRoots`。
- 调度器不推导根、不读磁盘。`admitUserTurn` 的 `root` 由调用方先 `await writableRootForSession(...)` 得到。根路径不是现存目录时，该次不启动，标签显示原因，不入队。
- `admitAutomation` 每次运行只调用一次。调度 tick 和 `automation.run` 是仅有的两个入口，二者不叠在同一次运行上。`enqueueAgentAutomation` / `enqueueScriptAutomation` 不再准入。脚本写者的键是 `` `script:${runId}` ``。
- 模型绑定在回合真正开始时写入 `huaanworkSessionModels`，下一次准入覆盖，`sessionRemove` 时删除。不在 `whenIdle` 删除，避免回合刚结束的标题生成改读全局模型。子代理在 `subagent/start` 时复制父会话的模型 id 和可写根；`subagent/end` 只删除子会话这两个键。父会话删除前先快照后代 id，再级联删除后代键。解析时不读 `currentCallerSession()`。
- `huaanworkSessionModels` 与 `huaanworkSessionRoots` 写在 Cordis `ctx` 上。赋值前必须进 `holders.ts` 的 module augmentation 和 `HUAANWORK_CONTEXT_PROPS`。route context、guardrails 与 sessions 读同一 Map 引用。未登记就赋值会在真实 Host 上抛 `cannot set property ... without provide`。
- `admitAutomation` 成功时写入 `rootWriters`。`countsTowardCap` 只决定是否 `activeTurns += 1`。脚本成功也占根，不占并发名额。调度器对传入的 `root` 做 `path.resolve`，再作为写者、队列和释放的键。调度器仍不读盘、不 `stat`。
- 每次成功准入在调用方创建一个 `releaseOnce`。同一回合的 idle 成功、idle 失败、followup 前抛错、尚未交接的 return，都只能调用这一个函数。它内部只调用一次 `release` + `drainQueue`。已经把执行权交给 `followup` 之后，只有该回合的 `whenIdle` 可以调用它。已经把执行权交给脚本子进程之后，只有该进程的 `close` 可以调用它。不要直接调用 `scheduler.release`。
- `missedPolicy === 'run-once'` 的 catchup 与到期项共用 `admitAutomation`。`skip` 不推进 `nextRunAt`、不记运行、不执行。`start` 之后才执行并推进。
- 缺 `sessionId` 的 diff 只在 `soleCapWriterSessionId()` 有值时补上那个会话 id。这个函数只数占名额写者。脚本写者和两张会话 Map 都不能用来猜。
- `session.cancel` 带 `queueItemId` 时只 `cancelQueuedItem`，不调用 `cancelAgent`，不释放活动写者。没有 `queueItemId` 时才 `cancelAgent`。两种都不立刻 `release`。
- 队列项在规格字段之外保存可选的 `skill` 与 `at: { name, clientMessageId? }`。出队时原样传给 `sendToAgent`，不把它们折回 `text`。
- 因根上已有写者或名额已满而跳过的到期自动化，等待期间不得记成 missed，也不得停用。`MISSED_GRACE_MS`（10 分钟）只用于调度器根本没有评估到的到期项。已经记入 `admissionSkips` 的项，超过 10 分钟后仍进入待准入列表。
- 越界路径收回到该会话自己的可写根，不收回到前台正在查看的其他项目。后台任务开始时不调用 `pinWorkspace`，也不改 `workspaceRoot.current`。
- 用户队列出队先于同一次释放触发的自动化重评估。自动化重评估失败时保持到期，不记 missed。调度 tick 仍是自动化重试的主路径；这次重评估只避免空等最长 60 秒的 tick。
- 不打开 `jobs`、`hmr`、`tool-jobs`、`run_in_background`。不做 Git worktree，不做多 Host，不放开单实例锁，不恢复 Run Coordinator。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0`。测试和门禁保持 headless。`corepack yarn check` 不要与另一条含 `verify:aa` 的门禁并行。
- 每个任务的 commit 步骤只有在用户明确要求提交时才执行；否则跳过提交并保留工作树变更。
- **在新分支上实施，不在 `master` 上实施。** 分支名固定为 `feat/huaanwork-concurrent-project-turns`，从当时的 `master` 拉出。Task 1 及其后的任何修改、提交都不得发生在 `master`。不推远程、不合并、不 force-push；这些要等用户另行要求。
- 每个任务开始执行的第一条 git 命令都是 `git branch --show-current`。结果不是 `feat/huaanwork-concurrent-project-turns` 就停止，不要在当前分支上继续改代码。

## 开工分支

实施代码之前先离开 `master`。设计稿、评审和本计划可以留在工作区里一起带上新分支；不要把 `.gstack/`、`.qoder/` 加进提交。

- [ ] **Step 1: 确认起点是 master**

```bash
git branch --show-current
git status -sb
```

Expected: 当前分支是 `master`。若已经在 `feat/huaanwork-concurrent-project-turns` 上，跳过 Step 2。若在其他分支上，停止并问用户，不要从那条分支再拉。

- [ ] **Step 2: 从 master 建分支并切过去**

```bash
git switch -c feat/huaanwork-concurrent-project-turns
git branch --show-current
```

Expected: `feat/huaanwork-concurrent-project-turns`。此步骤不提交、不推送。

---

## File Structure

- `dsh-plugin-huaanwork/src/huaanwork-host/settings.ts`：解析并保存 `max_concurrent_turns`。
- `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts`：写者、名额、队列。调用方传入 `root`。无文件 IO。
- `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts`：从已载入的任务、项目和 `header.cwd` 同步推导可写根。
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts`：按 `huaanworkSessionRoots` 夹紧。创建会话时不再把 `meta.cwd` 夹回前台根。
- `dsh-plugin-huaanwork/src/huaanwork-host/session-models.ts`：`sessionId → modelId`，子会话回溯父会话，并按该条目做网络门禁。
- `dsh-plugin-huaanwork/src/huaanwork-host/net-gate.ts`：`llm/stream` 前置门禁改读本次会话的模型条目。
- `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`：发送、取消、恢复改走调度器；写出根表和模型表；出队失败继续扫描。
- `dsh-plugin-huaanwork/src/huaanwork-host/workspace.ts`：切换前台不再调用 `assertAutomationIdle`。
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts`：`stream` 读会话绑定并再次做网络门禁。
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/{policy,question-answerer,git,web,bridge}.ts` 与 `agent-package/host.ts`：执行期改读会话可写根。
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts`：不再回退 `huaanworkRouteAgent.current` 或 `currentCallerSession()`。
- `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`：登记 `huaanworkSessionModels` 与 `huaanworkSessionRoots`；无人值守改为 Map。`automations-host.ts`：拆除 `automationTail`；脚本 cwd 用目标根；释放等到子进程 `close`。
- `dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts`：删除跨根门和前台空闲门；跳过项超过宽限仍可准入。
- `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts`、`routes.ts`、`client-huaanwork/{api,projects,rpc-types}.ts` 与 `logic/projects.ts`：`task.setModel` 与同一份带可选 `modelId` 的 `TaskInfo`。
- `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts`：标签上的执行、等待项，以及出队开始。
- `dsh-plugin-huaanwork/src/client-huaanwork/Settings.tsx` 与 `App.tsx`：上限输入、模型选择、排队文案、按标签停止。拆除自动化全局锁和回合单槽。

---

### Task 1: 并发上限设置

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/settings.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/settings.spec.ts`

**Interfaces:**
- Consumes: 现有 `parseSettings`、`mergeSettings`、`AppSettings`。
- Produces: `AppSettings.max_concurrent_turns: number`；`parseConcurrentTurns(value: unknown): number`。缺省 3，范围 1–8。

- [ ] **Step 1: 写失败测试**

在 `settings.spec.ts` 增加：

```ts
test('parseSettings clamps max_concurrent_turns to 1..8 and defaults to 3', () => {
  expect(parseSettings({}).max_concurrent_turns).toBe(3)
  expect(parseSettings({ max_concurrent_turns: 3 }).max_concurrent_turns).toBe(3)
  expect(parseSettings({ max_concurrent_turns: 0 }).max_concurrent_turns).toBe(1)
  expect(parseSettings({ max_concurrent_turns: -2 }).max_concurrent_turns).toBe(1)
  expect(parseSettings({ max_concurrent_turns: 9 }).max_concurrent_turns).toBe(8)
  expect(parseSettings({ max_concurrent_turns: 1.5 }).max_concurrent_turns).toBe(3)
  expect(parseSettings({ max_concurrent_turns: '4' }).max_concurrent_turns).toBe(3)
  const saved = mergeSettings(parseSettings({}), { max_concurrent_turns: 9 })
  expect(saved.max_concurrent_turns).toBe(8)
  const kept = mergeSettings(parseSettings({ max_concurrent_turns: 4 }), { theme: 'dark' })
  expect(kept.max_concurrent_turns).toBe(4)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/settings.spec.ts`
Expected: FAIL，`max_concurrent_turns` 不存在。

- [ ] **Step 3: 实现解析**

在 `settings.ts` 增加并在 `defaultSettings`、`parseSettings`、`mergeSettings` 的返回对象里写入该字段：

```ts
export const DEFAULT_MAX_CONCURRENT_TURNS = 3

export function parseConcurrentTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_MAX_CONCURRENT_TURNS
  if (value < 1) return 1
  if (value > 8) return 8
  return value
}
```

`mergeSettings` 只在 `rec.max_concurrent_turns !== undefined` 时调用 `parseConcurrentTurns`；缺省保持 `current.max_concurrent_turns`。不要在 `parseSettings` 里写文件。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/settings.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/settings.ts dsh-plugin-huaanwork/tests/huaanwork-host/settings.spec.ts
git commit -m "feat: clamp concurrent turn limit in HuaAnWork settings"
```

仅当用户明确要求提交时执行。

---

### Task 2: 回合调度器

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts`

**Interfaces:**
- Consumes: 无宿主单例。调用方传入上限、模型是否存在，以及已经算好的 `root`。本任务不接收 `resolveRoot`。
- Produces:

```ts
export type QueueItem = {
  queueItemId: string
  sessionId: string
  tabId: string
  text: string
  root: string
  modelId: string
  enqueuedAt: number
  skill?: string
  at?: { name: string; clientMessageId?: string }
}

export type AdmitUserResult =
  | { kind: 'start'; root: string }
  | { kind: 'queued'; root: string; queueItemId: string }
  | { kind: 'error'; reason: string }

export type AdmitAutomationResult = { kind: 'start'; root: string } | { kind: 'skip'; reason: 'root-busy' | 'cap-full' }

export function createTurnScheduler(options: {
  maxConcurrentTurns: () => number
  modelExists: (modelId: string) => boolean
  now?: () => number
  createId?: () => string
}): {
  admitUserTurn(input: { sessionId: string; tabId: string; text: string; modelId: string; root: string; skill?: string; at?: { name: string; clientMessageId?: string } }): AdmitUserResult
  admitAutomation(input: { automationId: string; sessionId: string; root: string; runId?: string; countsTowardCap: boolean }): AdmitAutomationResult
  release(sessionId: string): void
  cancelQueuedItem(queueItemId: string): void
  clearAdmissionSkip(automationId: string): void
  drainQueue(): QueueItem[]
  isAdmissionSkipped(automationId: string): boolean
  activeTurnCount(): number
  soleCapWriterSessionId(): string | undefined
}
```

`drainQueue` 返回本次实际取出并占坑的项，不调用 `admitUserTurn`，也不启动 `followup`。`release` 不嵌套调用 `drainQueue`。调用方在 `release` 之后自己调用 `drainQueue`，并负责启动或回滚。比较和存储 `root` 之前执行 `path.resolve`。调度器内部不读项目文件、不读会话日志、不 `stat`。`soleCapWriterSessionId` 只在占名额写者恰好一个时返回它的 `sessionId`。

- [ ] **Step 1: 写失败测试**

`turn-scheduler.spec.ts` 覆盖：

```ts
function scheduler(max = 3) {
  return createTurnScheduler({
    maxConcurrentTurns: () => max,
    modelExists: (id) => id === 'm1' || id === 'm2',
    now: () => 1,
    createId: (() => {
      let n = 0
      return () => `q${++n}`
    })(),
  })
}

test('two roots start together and the same root queues', () => {
  const turns = scheduler()
  expect(turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'one', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
  expect(turns.admitUserTurn({ sessionId: 'b1', tabId: 't2', text: 'two', modelId: 'm2', root: '/proj-b' }).kind).toBe('start')
  const third = turns.admitUserTurn({ sessionId: 'a2', tabId: 't3', text: 'three', modelId: 'm1', root: '/proj-a' })
  expect(third).toMatchObject({ kind: 'queued', root: '/proj-a', queueItemId: 'q1' })
  expect(turns.activeTurnCount()).toBe(2)
})

test('drain starts a later free root before a busy-root head and does not requeue', () => {
  const turns = scheduler(2)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'c1', tabId: 't0', text: 'cap', modelId: 'm1', root: '/proj-c' })
  turns.admitUserTurn({ sessionId: 'a2', tabId: 't2', text: 'wait-a', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'b1', tabId: 't3', text: 'wait-b', modelId: 'm2', root: '/proj-b' })
  turns.release('c1')
  const started = turns.drainQueue()
  expect(started.map((item) => item.sessionId)).toEqual(['b1'])
  expect(turns.drainQueue()).toEqual([])
  expect(turns.activeTurnCount()).toBe(2)
})

test('drain stops when the cap is full', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'b1', tabId: 't2', text: 'wait-b', modelId: 'm1', root: '/proj-b' })
  turns.admitUserTurn({ sessionId: 'c1', tabId: 't3', text: 'wait-c', modelId: 'm2', root: '/proj-c' })
  turns.release('a1')
  expect(turns.drainQueue().map((item) => item.sessionId)).toEqual(['b1'])
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.admitUserTurn({ sessionId: 'd', tabId: 't4', text: 'no', modelId: 'missing', root: '/proj-d' })).toMatchObject({
    kind: 'error',
    reason: '模型不存在',
  })
})

test('cancel removes one queued item and cap drop does not cancel a running turn', () => {
  let max = 2
  const turns = createTurnScheduler({
    maxConcurrentTurns: () => max,
    modelExists: () => true,
    createId: () => 'only',
  })
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm', root: '/same' })
  const queued = turns.admitUserTurn({ sessionId: 'a2', tabId: 'ta2', text: 'wait', modelId: 'm', root: '/same' })
  max = 1
  turns.cancelQueuedItem(queued.kind === 'queued' ? queued.queueItemId : '')
  const capped = turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'wait for cap', modelId: 'm', root: '/other' })
  expect(capped).toMatchObject({ kind: 'queued' })
  expect(turns.drainQueue()).toEqual([])
  expect(turns.activeTurnCount()).toBe(1)
})

test('admission skip is remembered until release of that automation', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't', text: 'run', modelId: 'm1', root: '/proj-a' })
  const skipped = turns.admitAutomation({
    automationId: 'auto-1',
    sessionId: 'auto-session',
    root: '/proj-b',
    countsTowardCap: true,
  })
  expect(skipped).toEqual({ kind: 'skip', reason: 'cap-full' })
  expect(turns.isAdmissionSkipped('auto-1')).toBe(true)
  turns.clearAdmissionSkip('auto-1')
  expect(turns.isAdmissionSkipped('auto-1')).toBe(false)
})
```

`resolve` 从 `node:path` 引入。下面断言返回的 `root` 用 `resolve(...)`，避免 Windows 上盘符前缀把字面量 `/proj-a` 打红。

```ts
test('automation start occupies the root and release frees it', () => {
  const turns = scheduler(3)
  expect(turns.admitAutomation({
    automationId: 'agent-1',
    sessionId: 'agent-session',
    root: '/proj-a',
    runId: 'r1',
    countsTowardCap: true,
  })).toEqual({ kind: 'start', root: resolve('/proj-a') })
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.admitUserTurn({ sessionId: 'u', tabId: 't', text: 'x', modelId: 'm1', root: '/proj-a' }).kind).toBe('queued')
  turns.release('agent-session')
  expect(turns.activeTurnCount()).toBe(0)
  const script = turns.admitAutomation({
    automationId: 'script-1',
    sessionId: 'script:r2',
    root: '/proj-a',
    runId: 'r2',
    countsTowardCap: false,
  })
  expect(script.kind).toBe('start')
  expect(turns.activeTurnCount()).toBe(0)
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
  expect(turns.admitAutomation({
    automationId: 'script-2',
    sessionId: 'script:r3',
    root: '/proj-a',
    countsTowardCap: false,
  })).toEqual({ kind: 'skip', reason: 'root-busy' })
  turns.release('script:r2')
  expect(turns.admitUserTurn({ sessionId: 'u2', tabId: 't2', text: 'y', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
})

test('trailing slash and dotdot share one writer across user and automation', () => {
  const turns = scheduler(3)
  expect(turns.admitUserTurn({ sessionId: 'u', tabId: 't', text: 'run', modelId: 'm1', root: '/tmp/proj/' }).kind).toBe('start')
  expect(turns.admitAutomation({
    automationId: 'auto',
    sessionId: 's',
    root: '/tmp/proj/../proj',
    countsTowardCap: false,
  })).toEqual({ kind: 'skip', reason: 'root-busy' })
})

test('sole cap writer is absent at zero and at two', () => {
  const turns = scheduler(3)
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/a' })
  expect(turns.soleCapWriterSessionId()).toBe('a')
  turns.admitAutomation({
    automationId: 'script-only',
    sessionId: 'script:1',
    root: '/scripts',
    countsTowardCap: false,
  })
  expect(turns.soleCapWriterSessionId()).toBe('a')
  turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'run', modelId: 'm1', root: '/b' })
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
})
```

同根第二条在上限仍有余量时也必须排队。把上面第一个测试的第三条断言为 `queued` 已经覆盖同根。再加一条：上限 3、只有项目 A 的第二条，`kind === 'queued'`，`activeTurnCount() === 1`。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-scheduler.spec.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现调度器**

`admitUserTurn` 与 `admitAutomation` 都先 `path.resolve(root)`。之后的写者键、队列项和返回值里的 `root` 用这个结果。不回调外部函数，不 `stat`。用户路径：模型不存在返回 `{ kind: 'error', reason: '模型不存在' }`，不入队。解析后的根已有写者，或 `activeTurnCount >= max` 时入队，并把本次的 `skill`、`at` 原样放进 `QueueItem`。否则写入 `rootWriters`（`kind: 'user'`）并 `activeTurns += 1`。`drainQueue` 返回的项仍带这两项。

`admitAutomation`：解析后的根已有写者，返回 `{ kind: 'skip', reason: 'root-busy' }`。`countsTowardCap && activeTurns >= max` 返回 `{ kind: 'skip', reason: 'cap-full' }`。两种 skip 都 `admissionSkips.add(automationId)`，不写 `rootWriters`。成功时写入 `rootWriters`，记录 `sessionId` 与可选 `runId`。`countsTowardCap === true` 时 `kind` 为 `agent-automation` 且 `activeTurns += 1`；否则 `kind` 为 `script-automation` 且不增加 `activeTurns`。成功时 `admissionSkips.delete(automationId)`。不要在本函数里判断目录是否存在。

`soleCapWriterSessionId` 统计 `kind` 为 `user` 或 `agent-automation` 的写者。恰好一个时返回它的 `sessionId`，否则返回 `undefined`。`script-automation` 不计入。

`release` 只删除该 `sessionId` 的写者并在该写者占名额时减一。写者已经不存在时不要再减。不要在 `release` 内部调用 `drainQueue`。

`drainQueue` 按 `enqueuedAt` 扫描副本。根仍有写者则留下。`activeTurns >= maxConcurrentTurns()` 时停止，不再取出后面的项。否则从队列删除、占坑、放进返回数组。这里不重新调用 `modelExists`：模型在出队后被删掉时，由 Task 6 的启动器失败并 `releaseAndDrain`。不要在调度器里启动代理。

`cancelQueuedItem` 只按 `queueItemId` 删除，不减 `activeTurns`。`clearAdmissionSkip` 只从 `admissionSkips` 删除该 id。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-scheduler.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
git commit -m "feat: schedule HuaAnWork turns by project root"
```

仅当用户明确要求提交时执行。

---

### Task 3: 可写根推导

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts`

**Interfaces:**
- Consumes: `sessionIdFor`（`session-id.ts`）、`neutralWorkspaceRoot`。
- Produces:

```ts
export function writableRootForSession(input: {
  profileDir: string
  sessionId: string
  projects: readonly { root: string }[]
  tasks: readonly { sessionId?: string; projectId: string }[]
  projectIdByTask?: readonly { id: string; root: string }[]
  headerCwd?: string
}): string
```

任务上的 `projectId` 通过 `projects` 里同 id 的项取根。测试直接传入 `{ id, root }` 与任务的 `projectId`。函数签名使用：

```ts
projects: readonly { id: string; root: string }[]
tasks: readonly { sessionId?: string; projectId: string }[]
```

顺序：任务绑定；`sessionId === sessionIdFor(root)` 或 `sessionId.startsWith(sessionIdFor(root) + '-')`；`header.cwd` 位于且仅位于一个项目根内；否则 `neutralWorkspaceRoot(profileDir)`。

- [ ] **Step 1: 写失败测试**

```ts
test('fresh project session and lost task binding stay on that project', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-root-'))
  const project = mkdtempSync(join(tmpdir(), 'huaanwork-proj-'))
  const fresh = freshSessionIdFor(project)
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: fresh,
    projects: [{ id: 'p', root: project }],
    tasks: [],
  })).toBe(resolve(project))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'legacy',
    projects: [{ id: 'p', root: project }],
    tasks: [],
    headerCwd: join(project, 'notes'),
  })).toBe(resolve(project))
})

test('unknown session falls back to the neutral workspace', () => {
  const profile = mkdtempSync(join(tmpdir(), 'huaanwork-neutral-'))
  expect(writableRootForSession({
    profileDir: profile,
    sessionId: 'nope',
    projects: [],
    tasks: [],
  })).toBe(neutralWorkspaceRoot(profile))
})
```

再断言任务 `sessionId` 命中时用该任务的项目根，即使 id 前缀属于另一个目录。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/writable-root.spec.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现推导**

用 `resolve` 比较路径。`header.cwd` 用与 `sandbox-cwd.ts` 相同的「等于根或在根之内」判断。命中两个项目根时不要猜，落到中立根。匹配会话 id 时不得使用短于完整 `sessionIdFor(root)` 的片段。

函数保持同步，参数里的数组和 `headerCwd` 由调用方载入。不要在这里调用 `listProjects`、`listTasks` 或 `findSessionHeader`，三者都是异步的。也不要检查目录是否存在；不存在的根由 Task 6 拒绝启动。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/writable-root.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts
git commit -m "feat: derive a session writable root without the foreground folder"
```

仅当用户明确要求提交时执行。

---

### Task 4: 沙箱按会话可写根夹紧

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts`（新增 `parentSessionOf`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/sandbox-cwd.spec.ts`

**Interfaces:**
- Consumes: 现有 `pinnedCwd`。`ctx.huaanworkSessionRoots?: Map<string, string>`。
- Produces: `pinnedCwd(ctx, requested?, allowedRoot?)`。`parentSessionOf(childSessionId): string | undefined`，沿 `registerChildSession` 的表向父级走，不读 `currentCallerSession()`。传入 `allowedRoot` 时，只相对该根夹紧，不读取前台根。

- [ ] **Step 1: 写失败测试**

```ts
test("a session allowed root rejects the foreground project", () => {
  const allowed = mkdtempSync(join(tmpdir(), "huaanwork-allowed-"));
  const foreground = mkdtempSync(join(tmpdir(), "huaanwork-foreground-"));
  const outside = mkdtempSync(join(tmpdir(), "huaanwork-outside-"));
  try {
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: { current: foreground } }, join(allowed, "a.txt"), allowed), join(allowed, "a.txt"));
    assert.equal(pinnedCwd({ huaanworkWorkspaceRoot: { current: foreground } }, outside, allowed), allowed);
    assert.notEqual(pinnedCwd({ huaanworkWorkspaceRoot: { current: foreground } }, outside, allowed), foreground);
  } finally {
    rmSync(allowed, { recursive: true, force: true });
    rmSync(foreground, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
```

再加一条：`sessions.create` 的包装在 `huaanworkSessionRoots` 已有该 `sessionId` 时，保留落在该根内的 `meta.cwd`，不得改成前台根。`sandboxPolicy.resolve` 对 `header.id` 命中根表的请求返回该根；子会话未入表时用 `parentSessionOf` 或 `header.parentSession` 再查一次。未入表且没有父会话时，维持现有前台根行为，供尚未绑定的旧调用使用。

保留现有「未传 `allowedRoot` 时用前台根」的测试，不要改松它们。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/sandbox-cwd.spec.ts`
Expected: FAIL，第三参被忽略，越界路径回到 `foreground`。

- [ ] **Step 3: 实现夹紧**

`allowedRoot` 非空时：请求路径在该根之内则返回请求路径，否则返回 `allowedRoot`。不要因为前台根不同而改写。未传 `allowedRoot` 时维持现有 `pinnedCwd` 行为。

不要读取 `request.session.header.writableRoot`。上游构造 header 时会丢掉这个字段，并且 `deepFreeze` 之后不能再挂上。`sandboxPolicy.resolve` 的允许根只来自 `ctx.huaanworkSessionRoots`：先 `header.id`，未命中则 `parentSessionOf(header.id)`，再未命中则 `header.parentSession`。三处都没有时沿用前台根。

`withPinnedCwd` 增加会话 id。`sessions.create` / `sessions.prepare` 把 id 传进去。根表已有该 id，或能通过 `options.meta.parentSession` 找到父会话的根时，用那个根做 `allowedRoot`，再决定保留还是夹紧 `meta.cwd`。根表没有该 id 时维持现在的前台夹紧，避免未接线的调用突然放开。根表由 Task 6 在 `create` 之前写入。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/sandbox-cwd.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/sandbox-cwd.spec.ts
git commit -m "fix: clamp sandbox paths to the session writable root"
```

仅当用户明确要求提交时执行。

---

### Task 5: 会话模型绑定与网络门禁

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/session-models.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts`（`stream` 选条目处）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/net-gate.ts`（`llm/stream` 前置门禁）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`（`subagent/start` 把父会话的模型 id 复制到子会话 id）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-models.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts`（若无该文件则新建一个只覆盖选择函数的用例；选择逻辑放在 `session-models.ts`，`model.ts` 调用它）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`（更新 `blocks public endpoints unless allow_network is on`，并加会话绑定用例）

**Interfaces:**
- Consumes: `workNetworkGateError`、设置里的 `models` 与 `allow_network`、Task 4 的 `parentSessionOf`。
- Produces:

```ts
export type SessionModelTable = Map<string, string>

export function resolveSessionModel(input: {
  sessionId: string | undefined
  table: SessionModelTable
  models: readonly { id: string; base_url: string; model: string; api_key: string }[]
  active: { base_url: string; model: string; api_key: string }
  allowNetwork: boolean
  parentOf?: (sessionId: string) => string | undefined
}): { ok: true; base_url: string; model: string; api_key: string } | { ok: false; reason: string }
```

有绑定且条目还在：用该条目，并用它的 `base_url` 做门禁。有绑定但条目已删：`{ ok: false, reason: '模型不存在' }`，不回落全局。`sessionId` 未入表时，用 `parentOf` 向父会话走，命中父会话的绑定就用父会话的条目，直到没有父会话。全程不读 `currentCallerSession()`。无绑定：用 `active`，同样用实际 `base_url` 做门禁。门禁失败返回 `{ ok: false, reason }`，reason 为 `workNetworkGateError` 的原文。

本任务不写表。`sendToAgent`、自动化运行和 `sessionRemove` 的 `set` / `delete` 在 Task 6 与 Task 8。

- [ ] **Step 1: 写失败测试**

```ts
test('pinned models stay apart from the global active model', () => {
  const table = new Map([['s1', 'local-model'], ['s2', 'other-model']])
  const models = [
    { id: 'local-model', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' },
    { id: 'other-model', base_url: 'http://10.0.0.8:8000/v1', model: 'llama', api_key: 'k' },
  ]
  const active = { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' }
  expect(resolveSessionModel({ sessionId: 's2', table, models, active, allowNetwork: false })).toMatchObject({
    ok: true, model: 'llama', base_url: 'http://10.0.0.8:8000/v1',
  })
  expect(resolveSessionModel({ sessionId: 's2', table, models: models.slice(0, 1), active, allowNetwork: true })).toEqual({
    ok: false, reason: '模型不存在',
  })
  expect(resolveSessionModel({
    sessionId: 'child',
    table,
    models,
    active: { base_url: 'https://api.example.com/v1', model: 'cloud', api_key: '' },
    allowNetwork: false,
    parentOf: (id) => (id === 'child' ? 's1' : undefined),
  })).toMatchObject({ ok: true, model: 'qwen', base_url: 'http://127.0.0.1:11434/v1' })
})
```

再加一条：绑定的 `base_url` 是公网且 `allowNetwork: false` 时 `ok === false`，reason 来自现有网络门禁，而不是静默改打 `active`。

`sessions.spec.ts` 保留「无 sessionId 时按 settings.base_url 拦截公网」。另加：全局 `base_url` 是公网、表里该 `sessionId` 是局域网时，`assertStreamNetworkAllowed` 不抛；反过来全局是局域网、绑定是公网时抛。这覆盖 `net-gate.ts` 在适配器之前执行的那一层。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/session-models.spec.ts tests/huaanwork-host/sessions.spec.ts`
Expected: FAIL，模块不存在，或前置门禁仍只看全局 `base_url`。

- [ ] **Step 3: 实现并接到 stream 与前置门禁**

`model.ts` 的 `stream` 在发请求前调用 `resolveSessionModel`。`options.sessionId` 传入。`parentOf` 传 `parentSessionOf`。表由宿主放在 `ctx.huaanworkSessionModels`，`model.ts` 的 `apply` 读取同一 Map 引用。`ok === false` 时抛出 `reason`，不发 fetch。无会话记录、且父链也没有记录的调用继续用全局 `active_model_id` 对应条目。

`net-gate.ts` 的 `llm/stream` 监听改为把 `options.sessionId` 和同一张表交给 `resolveSessionModel`（或只调用已含门禁的那个函数）。不要再单独用 `settings.base_url` 决定这次请求是否放行。`allow_network` 仍来自当前设置。无 sessionId 时行为与现在相同。

`skills.ts` 的 `subagent/start` 在现有 `registerChildSession` 之后，把父会话在 `huaanworkSessionModels` 里的值复制到子会话 id。父会话没有绑定时不写入。`subagent/end` 只删除子会话的模型键，不删除父会话。根键在 Task 6 的同一个 `subagent/end` 回调里删除。不要用 `currentCallerSession()` 做这次复制。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/session-models.spec.ts tests/huaanwork-host/sessions.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/session-models.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts dsh-plugin-huaanwork/src/huaanwork-host/net-gate.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/tests/huaanwork-host/session-models.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
git commit -m "feat: pin a model and network gate to each HuaAnWork session"
```

仅当用户明确要求提交时执行。

---

### Task 6: 发送、取消、恢复接入调度器

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`（登记两张 Map；Task 7 再改无人值守类型）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`（创建唯一 `createTurnScheduler`、`huaanworkSessionModels`、`huaanworkSessionRoots`，赋到已登记的 Cordis `ctx`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/holders-context.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/workspace.ts`（`openWorkspace` / `closeWorkspace` 去掉 `assertAutomationIdle`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`、`question-answerer.ts`、`git.ts`、`web.ts`、`bridge.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`（`session/queue-start`、`session/queue-fail`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`（补 `tabId`，并断言创建取消与更新失败返回 `started: false`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`（只给两处 `session.send` 补 `tabId`；旧断言留给 Task 8）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/workspace.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`（`workspace` 域「automation-idle」用例改为前台仍可切换）

**Interfaces:**
- Consumes: Task 2 的调度器、Task 3 的 `writableRootForSession`、Task 4 的根表读法、Task 5 的 `resolveSessionModel`。
- Produces: `session.send` 返回 `{ queued: true, waiting: boolean, started: boolean, sessionId: string, queueItemId?: string }`。`waiting: true` 时不调用 `followup`，`started` 为 false。`started: true` 只表示 `followup` 已经受理。`session.new` 接受可选绝对路径 `cwd`，并且不改 `workspaceRoot.current`。

- [ ] **Step 1: 写失败测试**

在现有 sessions 测试的宿主桩上增加。`deferred` 是本文件内的辅助函数：`function deferred<T>() { let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }`。`followups` 是桩 agent 的 `followup` 收到的文本。`released` 由测试里的 `release` 替身写入。

```ts
test('session.send returns before the turn is idle and queues a second writer on the same root', async () => {
  let released = false
  const idle = deferred<void>()
  const secondFollowup = deferred<void>()
  const sent = await sessionSend(ctx, routeCtx, { text: 'first', sessionId: 'a1', tabId: 'tab-a', modelId: 'm1' })
  expect(sent).toMatchObject({ queued: true, waiting: false, started: true })
  expect(released).toBe(false)
  const queued = await sessionSend(ctx, routeCtx, { text: 'second', sessionId: 'a2', tabId: 'tab-b', modelId: 'm1' })
  expect(queued).toMatchObject({ queued: true, waiting: true, started: false })
  expect(followups).toEqual(['first'])
  idle.resolve()
  await secondFollowup.promise
  expect(released).toBe(true)
  expect(followups).toEqual(['first', 'second'])
})
```

桩里的 `whenIdle` 返回 `idle.promise`。第一次准入的 `releaseOnce` 把 `released` 设为 true。第二次 `followup` 被调用时 `secondFollowup.resolve()`。出队启动第二条时要发出 `session/queue-start`，载荷含 `sessionId`、`tabId`、`queueItemId`。`tabId` 来自 `session.send` 的参数，不从宿主现猜。`startQueuedItem` 还要异步读设置，不要在 `await idle.promise` 的同一拍断言 `followups` 已经包含第二条。再断言：

- `sessionCancel` 后、`idle.resolve()` 前 `released` 仍为 false。
- `sessionResume` 在另一个项目的代理仍在跑时不抛「后台自动化任务运行中」。持久化 `cwd` 在推导根之内时用 `isInside` 放行，不要求等于前台根。
- 推导根不是现存目录时，`session.send` 抛出含「不存在」的错误，不调用 `followup`，不入队。测试名写 `a missing writable root does not start`。
- 出队时模型已从列表删除，且当时 `max_concurrent_turns` 生效值为 1：该项不 `followup`，发出 `session/queue-fail`，名额被释放后再次出队。队列里另一个根的合格项必须接着 `followup`。名额大于 1 时两项会在同一次 `drainQueue()` 里一起返回，盖不住这个失败路径。测试名写 `a failed queued item releases the cap for the next root`。
- 子代理启动不改变 `activeTurnCount()`。测试名写 `a child session does not increment the active turn count`。
- 同一 `sessionId` 上 T1 执行、T2 排队。T1 的 `releaseOnce` 出队并启动 T2 之后，再调用同一次 `releaseOnce` 不得移除 T2 的写者，也不得让 T3 与 T2 同时 `followup`。测试名写 `a late release from the first turn does not drop the next turn`。
- 同会话一项在执行、一项在等待。只取消等待项时 `cancelQueuedItem` 被调用，primary 与 child 的 `cancel` 都不被调用，活动写者还在。测试名写 `cancelling a queued item leaves the running turn`。
- 排队项带 `skill` 或 `at.{name, clientMessageId}`。出队后的 `sendToAgent` 收到同一组字段，不把它们折进 `text`。`session/queue-start` 的 `tabId` 是发送时的标签。测试名写 `a queued skill and at replay on dequeue`。
- 有文本但没有 `tabId` 时抛出「缺少标签」，并且不调用 `followup`。测试名写 `session.send without a tab throws 缺少标签`。`{}` 这个缺文本用例仍抛 `requires params.text`，不要被「缺少标签」截断。
- `sessions.spec.ts` 里现有的 13 处 `sessionSend(`、`agent-package-creation.spec.ts` 里现有的 4 处 `sessionSend(`，以及 `automations-host.spec.ts` 里两处 `handler('session.send')(body({ text: 'hi' }))`，参数都补上 `tabId`。生产路径不把缺省 `tabId` 当成合法。网络门禁用例补上 `tabId` 后仍因公网失败。`@reviewer` 用例补上 `tabId` 后仍因未启用或不存在失败。

`agent-package-creation.spec.ts` 里这两则现有用例改为断言返回值，不要只看通知：

- `cancel discards the draft, emits the fixed notice, and sends nothing to the model`：`sessionSend` 正常返回 `{ queued: true, waiting: false, started: false, sessionId }`，不 reject。通知文案、草稿被丢弃、`followup` 没收到消息，这些原断言保留。
- `/create-agent update <missing> emits a notice instead of failing the send`：把 `toEqual({ queued: true, sessionId })` 改成 `toEqual({ queued: true, waiting: false, started: false, sessionId })`。通知文案和「没有交给模型」保留。

再加两则排队用例。同一可写根上先发一条会 `followup` 并停在 `whenIdle` 的消息，再发第二条。第二条立刻返回 `waiting: true, started: false`。放开第一条之后：

- 第二条是已有草稿上的「取消」。不发 `session/queue-start`，发 `session/queue-fail` 和原来的取消通知，不调用 `followup`，写者被释放。测试名写 `a queued creation cancel fails without starting`。
- 第二条是 `/create-agent update` 加一个不存在的 slug。同样不发 `queue-start`，发 `queue-fail` 和原来的更新失败通知，不调用 `followup`。测试名写 `a queued update failure fails without starting`。

`agent-package-creation.spec.ts` 的 `makeSessionCtx` 今天没有调度器。这四则现有 `sessionSend` 和上面两则新用例要能走到创建门禁，夹具里要放上 Task 6 的调度器，并且两次发送共用同一个实例。可写根用现有 `profileDir` 的中立目录，目录必须已经存在。设置缺文件时走 `emptySettings()`，本地模型要能通过网络门禁。缺调度器或目录会在创建取消之前抛错，那种失败不算这几则通过。直接调用 `sendToAgent` 的用例不经过 `session.send`，不要给它们加 `tabId` 门槛。
- `new Context()` 上赋值 `huaanworkSessionModels` 与 `huaanworkSessionRoots` 不抛错。guardrails 侧读到的是同一 Map 引用。测试名写 `context maps assign on a cordis context`，放在 `holders-context.spec.ts`。
- 开始执行后 `huaanworkSessionModels.get(sessionId)` 是本次 `modelId`，`huaanworkSessionRoots.get(sessionId)` 是推导根。`whenIdle` 之后这两项仍在。`sessionRemove` 之后都没有。
- `session.new` 传入另一个现存目录作为 `cwd` 时，返回该目录，且 `workspaceRoot.current` 不变。
- 前台根改去另一个项目后，已经写入根表的会话在 `git` / `policy` 用的根仍是原来的根。测试名写 `foreground switch leaves the background session root`。可以只断言导出的 `sessionWorkspaceRoot(ctx, sessionId)`，不必真的跑 Git。
- 前台停在项目 A，首次为项目 B 的新会话调用 `sessionSend`。在 `agents.create` 的桩里断言 `huaanworkSessionRoots.get(sessionId)` 已是 B 且 `meta.cwd` 是 B，不是 A；`followup` 受理后模型表才是本次 `modelId`。测试名写 `first project creation keeps its root while another is foreground`。另用创建取消断言 `started:false` 时不写本次模型键、预置的旧模型键仍保留。

`workspace.spec.ts` 里「后台自动化非空闲 → open/close 拒绝」改为：计数器非 0 时 `openWorkspace` / `closeWorkspace` 仍然切到目标目录。`routes.spec.ts` 里把 `agentAutomationQueued = 1` 后期望 `workspace.close` 400 的用例改成期望 200。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-creation.spec.ts tests/huaanwork-host/holders-context.spec.ts tests/huaanwork-host/workspace.spec.ts`
Expected: FAIL。新断言要先红在返回值没有 `waiting` / `started`、创建取消仍被当成成功启动、排队取消没有 `queue-fail`、Cordis 赋值抛错，或工作区切换仍被自动化计数挡住。不要红在「缺少标签」上。

- [ ] **Step 3: 接入**

`holders.ts` 的 `Context` 声明和 `HUAANWORK_CONTEXT_PROPS` 增加 `huaanworkSessionModels: Map<string, string>` 与 `huaanworkSessionRoots: Map<string, string>`。`index.ts` 在 `installHuaanworkHolders` 之后创建唯一的调度器和这两张 Map，赋到 Cordis `ctx` 上。route context 若暴露它们，必须是同一引用，不能再 `new Map()`。调度器的 `modelExists` 读当前设置里的模型列表。不要给调度器传 `resolveRoot`。`session.send` 在已经有文本之后读取 `tabId`；有文本但缺失 `tabId` 时抛出「缺少标签」。没有文本的 `{}` 仍先抛 `requires params.text`。Task 10 的客户端发送带上当前标签 id。上面点名的既有调用都补上 `tabId`，不要为了让旧测试通过而在生产路径上接受缺省标签。

`sessionSend` 不再调用 `assertSessionSendable`。先载入数据再准入：

```ts
const projects = await listProjects(routeCtx.profileDir)
const tasks = await listTasks(routeCtx.profileDir)
const header = await findSessionHeader(join(routeCtx.dshHome, 'sessions'), sessionId)
const root = writableRootForSession({
  profileDir: routeCtx.profileDir,
  sessionId,
  projects,
  tasks,
  headerCwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
})
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error('可写根目录不存在')
}
const settings = await readHuaanworkSettings(routeCtx.profileDir)
const resolved = resolveSessionModel({
  sessionId,
  table: new Map([[sessionId, modelId]]),
  models: settings.models,
  active: { base_url: settings.base_url, model: settings.model, api_key: settings.api_key },
  allowNetwork: settings.allow_network,
})
if (!resolved.ok) throw new Error(resolved.reason)
const admitted = scheduler.admitUserTurn({ sessionId, tabId, text, modelId, root, skill, at })
```

`modelId` 缺省时用当时的 `active_model_id`。本任务不写 `tasks.json`。子任务尚无 `modelId` 时的写回放在 Task 9，那里 `setTaskModel` 已经存在。

`admitted.kind === 'error'` 时抛 `admitted.reason`。`queued` 时返回 `{ queued: true, waiting: true, started: false, sessionId, queueItemId }`，不写两张 Map，不 `followup`。`start` 时把准入的 `root`、`modelId` 随其余参数一起交给 `sendToAgent`。显式会话的根表由下面的 `ensureChannelAgent` 在 create/resume 前登记。`sendToAgent` 只有在调用了 `followup` 之后才写 `huaanworkSessionModels.set(sessionId, modelId)`；通道默认会话若此前没有根表项，此时再按准入 `root` 补记，然后返回 `{ queued: true, sessionId, started: true }`。没调用 `followup` 就返回时，不写模型表，也不删除这次发送之前已经存在的模型键，返回 `{ queued: true, sessionId, started: false }`。`ensureChannelAgent` 已为创建/恢复登记的真实根保留，不因这条早退删除或改回前台。`session.send` 把结果补成 `waiting: false`。`sendToAgent` 里删掉对 `settings.base_url` 的直接门禁；准入已经按本次 `modelId` 判断过。不要在 `whenIdle` 里 `delete` 这两张表。

每次成功准入创建一个 `releaseOnce`。不要在回合外直接调用 `scheduler.release`。

```ts
function releaseAndDrain(sessionId: string): void {
  scheduler.release(sessionId)
  for (const item of scheduler.drainQueue()) void startQueuedItem(item)
  reevaluateDueAutomations?.()
}

function createReleaseOnce(sessionId: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    releaseAndDrain(sessionId)
  }
}
```

`whenIdle` 的成功和失败回调都调用这一次准入的 `releaseOnce`，不要各写一次 `releaseAndDrain`。`followup` 已经受理之后，只有这次 `whenIdle` 可以调用它。`followup` 之前抛错，或 `sendToAgent` 在没有调用 `followup` 时返回（创建取消、更新失败提示），调用这同一个 `releaseOnce`，并且不要再登记 `whenIdle`。没调用 `followup` 的返回不写模型表，也不删除该会话原有的模型键；根表只保留本次创建/恢复所登记的真实根，不能为了迎合早退而删掉有效根或改回前台。创建取消和更新失败提示仍只 `emit` 原来的 `agent/notice`。直接 `session.send` 对这两条返回 `{ queued: true, waiting: false, started: false, sessionId }`，不抛错。网络门禁、缺文本、缺标签、根不存在、模型不在列表中这些错误仍抛回这次 HTTP。不要 `await whenIdle()` 再返回 HTTP 应答。

`startQueuedItem` 再次检查根目录仍存在、`modelId` 仍在列表里、网络门禁仍通过。复检失败时先 `emit session/queue-fail`，再调用该项自己的 `releaseOnce`。不要只 `scheduler.release`，也不要发 `session/queue-start`。`drainQueue` 在名额用尽时已经停住，失败项独占这次返回数组时，后面的合格项还在调度器队列里；只 `release` 不会再出队。失败项不要重新入队。复检通过后把队列项里的 `root`、`modelId` 一并交给 `sendToAgent`，其余参数使用队列项里的 `text`、`skill`、`at`，不重新解析文本。根表仍由 `ensureChannelAgent` 在 create/resume 前登记；`followup` 受理后才写模型表，再 `emit({ event: 'session/queue-start', sessionId, tabId, queueItemId })`。`queue-start` 使用队列项里的 `tabId`。`sendToAgent` 抛错或返回 `started: false` 时不发 `queue-start`，改发 `session/queue-fail`，并调用该项自己的 `releaseOnce`。创建取消和更新失败走 `started: false` 这一支，`reason` 用已经发给用户的那句 notice。`queue-fail` 只结束这条等待项，不把同一标签上仍在执行的上一回合标成结束。

`reevaluateDueAutomations` 由 `index.ts` 注入，指向 Task 8 导出的单次评估函数。Task 8 落地前用空函数占位，避免循环依赖：`sessions.ts` 不 import `automation-scheduler.ts`。用户项先出队，然后才评估到期自动化。

`sessionCancel` 在请求带 `queueItemId` 时只 `cancelQueuedItem`，不调用 `cancelAgent`，不释放活动写者。没有 `queueItemId` 时才调用现有 `cancelAgent`。两种都不 `release`。

`sessionRemove` 在 `forgetChildSessions` 之前快照该会话的后代 id，删除本会话和这些后代的模型键、根键。`subagent/end` 只删除该子会话的模型键和根键，不删父键。不要因为一个子会话结束就删除仍在运行的父会话。

`sessionResume` 删除 `assertAutomationIdle()`。不调用 `admitUserTurn`。`ensureChannelAgent` 自己决定根，`sessionResume` 不再另做一套前台根比较。

`ensureChannelAgent` 的 `create` 和 `persisted` 两条都走同一个根。先读 `huaanworkSessionRoots.get(sessionId)`。没有再 `writableRootForSession`。不要用这次推导覆盖表里已经有的值。`persisted` 分支删掉 `resolve(cwd) !== resolve(routeCtx.workspaceRoot.current)`。改为 `isInside(root, cwd)`。不在根内则抛出「该会话属于其他工作区，请先打开对应项目后再继续。」通过后，在 `agents.resume` 之前把这个根写入 `huaanworkSessionRoots`。`create` 分支在 `agents.create` 之前写入同一张表，`meta.cwd` 用这个根。两条都不读 `workspaceRoot.current`，也不调用 `pinWorkspace`。

`sessions.spec.ts` 的「别的工作区拒绝恢复」保持拒绝。那个用例的 cwd 不落在任何已登记项目内，推导根是中立工作区，`isInside` 仍然失败。已登记项目的历史会话在前台根不同、但 `cwd` 落在该项目根内时必须恢复。

`sessionNew`：请求里的 `cwd` 是现存绝对目录时用它生成 id 并作为返回值；否则仍用前台根。两种情况都不写 `workspaceRoot.current`。

`workspace.ts` 的 `openWorkspace` 和 `closeWorkspace` 删除 `assertAutomationIdle()`。前台切换只改 holder。`assertAutomationIdle` 没有剩余调用方时删除导出。`sessionSendBlockers` 不再由本任务增减；Task 8 去掉自动化对它的 `+= 1`。

执行期读根的函数统一为 `sessionWorkspaceRoot(ctx, sessionId)`，从 `sandbox-cwd.ts` 导出：查 `huaanworkSessionRoots`，未命中则 `parentSessionOf`，再未命中才回退 `huaanworkWorkspaceRoot.current ?? process.cwd()`。改这些调用点：`policy.ts` 的 `toToolCall`、`question-answerer.ts` 的 `confirmInput`、`git.ts` 的 `workspaceRoot`、`web.ts` 的截图目录、`bridge.ts` 的 `emitGitDiff`、`agent-package/host.ts` 里交给 `createRuntime` 的 `workspaceRoot`。Git 和截图从工具执行参数取 `sessionIdOfAgentRef`。`emitGitDiff` 仍带上这次工具的 `sessionId`，但 diff 文本来自该会话的根，不来自前台根。缺少 `sessionId` 时调用 `soleCapWriterSessionId()`：有值则补上那个 id 再发；没有值则 `routeCtx.logger` 一条且不补 id。不要只看 `activeTurnCount()`。

子代理启动路径不得调用 `admitUserTurn` 或 `admitAutomation`。`skills.ts` 在复制模型 id 时，同样把父会话的 `huaanworkSessionRoots` 复制到子会话 id。同一个 `subagent/end` 回调删除子会话的根键。父会话删除走上面的快照级联，不在 `forgetChildSession` 之后再查已经清空的登记表。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-creation.spec.ts tests/huaanwork-host/holders-context.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/workspace.spec.ts tests/huaanwork-host/routes.spec.ts`
Expected: PASS。`automations-host.spec.ts` 不放进这条命令。那里两处 `session.send` 已经补了 `tabId`，但旧的「后台自动化任务运行中」断言要等 Task 8 改写，本任务不靠放宽那两条来换绿。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/huaanwork-host/workspace.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/git.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/holders-context.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/workspace.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts
git commit -m "feat: admit HuaAnWork sends without holding the reply open"
```

仅当用户明确要求提交时执行。

---

### Task 7: 无人值守与分流工具按会话隔离

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`（`runAgentTurn` 的 holder 写入）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tool-plugin.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`（`degradeIfUnattended`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts`（`sessionIdOf` 与 `runtimeSessionId`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/route-tool-plugin.spec.ts`（已有则追加；没有则只给新增的纯查找函数建 `unattended-scope.spec.ts`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/policy-type.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/question-answerer.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`（无人值守用例改为读 Map）

**Interfaces:**
- Consumes: `automationRunSessionId`、Task 4 的 `parentSessionOf`。
- Produces: `huaanworkUnattended` 的类型改为 `Map<string, UnattendedScope>`。`runAgentTurn` 用 `map.set(sessionId, scope)`，`finally` 里 `map.delete(sessionId)`。`policy.ts` 的 `degradeIfUnattended`、`route-tool-plugin.ts` 的 `waitForInput`、`question-answerer.ts` 的审批降级都只 `map.get(本次 sessionId)`。未命中时用 `parentSessionOf` 再查父会话，查到就沿用父会话的无人值守范围。

分流工具和智能体包工具不再读取 `huaanworkRouteAgent.current`，也不再读取 `currentCallerSession()`。执行上下文没有 agent、且父链也没有会话 id 时，该次工具调用抛错并写回该会话。

`question-answerer.ts` 现有的 `ctx.huaanworkUnattended?.current` 在监听回调开头，那里没有名为 `sessionId` 的局部变量。先用 `sessionIdOfAgentRef(request.agent)` 取出 id，再 `map.get`。不要假设 `unattendedOwns` 内部的局部变量在外层可见。`policy.ts` 用 `sessionIdOfAgentRef(execution.agent)`。

- [ ] **Step 1: 写失败测试**

```ts
test('one unattended scope does not answer another session', () => {
  const scopes = new Map<string, { sessionId: string }>([['auto-a', { sessionId: 'auto-a' }]])
  expect(scopes.get('auto-b')).toBeUndefined()
  expect(scopes.get('auto-a')?.sessionId).toBe('auto-a')
})
```

若已有 route-tool 测试，追加：`exec.agent` 缺失时不使用预先写入的 `huaanworkRouteAgent.current`，调用抛错。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/route-tool-plugin.spec.ts`
Expected: FAIL，或现有测试仍把全局槽当回退。若文件不存在，先写新测试文件再运行，预期 FAIL 为找不到导出。

- [ ] **Step 3: 改 holder 与两处读取**

`holders.ts` 初始化 `new Map()`。`runAgentTurn` 不再写 `holder.current`。`route-tool-plugin.ts` 的 `currentAgent` 改为只接受 `exec?.agent`。`question-answerer.ts` 按上一节取出 `sessionId` 后 `map.get`。`policy.ts` 的 `degradeIfUnattended` 同样改掉 `.current`。`agent-package-tools.ts` 的两处 `exec?.agent ?? ctx.huaanworkRouteAgent?.current` 只保留 `exec?.agent`；`runtimeSessionId` 去掉 `currentCallerSession()` 回退。

既有测试若仍写 `.current`，在本任务里改成 Map。`automations-host.spec.ts` 里把 holder 传进 `policy.apply` 的无人值守用例必须在 Map 上 `set` 当前会话，再期望 `{ kind: 'allow' }`。不要留 `.current` 与 Map 两套字段。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/route-tool-plugin.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/policy-type.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/huaanwork-guardrails/question-answerer.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tool-plugin.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/route-tool-plugin.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/policy-type.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/question-answerer.spec.ts
git commit -m "fix: isolate unattended automation state by session"
```

仅当用户明确要求提交时执行。

---

### Task 8: 自动化按根准入并豁免错过宽限

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`（`automation.run`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`

**Interfaces:**
- Consumes: `admitAutomation`、`isAdmissionSkipped`、`clearAdmissionSkip`、Task 6 的 `releaseAndDrain`。
- Produces: 导出 `evaluateDueAutomations(now?: number): Promise<void>`，供 `releaseAndDrain` 在用户队列出完后调用一次。删除 `automationTail` 对 agent 运行的串行等待。脚本在唯一一次准入成功之后才 `acquireScriptSlot`。手动运行不再调用 `openWorkspace` / `closeWorkspace` / `assertAutomationIdle` / `agentIdle`。

`admitAutomation` 只出现在两个入口，同一次运行不会两个都走到：

1. 调度 tick 对每条到期项调用一次。`skip` 则结束该项。`start` 则把已经占坑的 `sessionId` 交给执行体。
2. `automation.run` 对这一次手动运行调用一次。`skip` 则返回。`start` 则把同一 `sessionId` 交给执行体。

`enqueueAgentAutomation` 和 `enqueueScriptAutomation` 不再调用 `admitAutomation`。执行体假定坑已经占上。直接调用 enqueue 的测试要先准入，或改走 `automation.run`。

- [ ] **Step 1: 写失败测试，并改写已被规格推翻的旧断言**

下面三则现有测试钉的是旧行为，本任务改断言，不要为了让它们继续通过而保留全局门：

- `cross-root due stays due and a deleted project still runs`：别的项目根上的到期任务改为进入 `run-start`。已删除项目仍按 `missing-project` 处理。
- `same-root due agents enqueue through the serial tail, grouped together`：同一项目根的第二条在第一条 `release` 之前不得 `followup`。
- `agentIdle between groups keeps the later group due`：前台通道代理挂起时，另一个项目根的到期任务仍然启动。

`automations-host.spec.ts` 里这五则也要改，不要留着旧全局锁：

- `manual run returns queued immediately and agent runs stay serial on automationTail`：同根第二条不再抛「后台自动化任务运行中」。它不 `followup`，直到第一条释放。
- `script concurrency stops at 2 and the third waits for a slot`：三个脚本分属三个项目根。同根仍只有一个写者。槽位池上限 2 只在不同根之间生效。
- `agent run rejects session.send and session.cancel; script run lets session.send through`：同根 `session.send` 在脚本占用该根时进入等待，不立即 `followup`。另一项目根的发送在名额够时立即 `followup`。这两处 body 保留 Task 6 补上的 `tabId`。
- `tokens attribute to the run session and approvals stay isolated across a concurrent script`：脚本和 agent 改到两个不同的 `project.root` 上再同时跑。
- `agentIdle rejects a manual run while the user agent is busy`：前台会话忙时，另一个项目根的手动运行仍可开始。同根才跳过。

新增。第一次 tick 必须落在 10 分钟宽限内，让 `admitAutomation` 真的返回 skip；然后再把 `nextRunAt` 推进到宽限之外。不要在 `start(h)` 之前就把 `dueAt` 设成 `now - MISSED_GRACE_MS - 5000`，那样 `dueAutomations` 不会选中它，`admissionSkips` 永远是空的，断言会红。

```ts
test('an admission skip survives the missed grace window', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-busy-'))
  dirs.push(elsewhere)
  const project = await createProject(h.profileDir, { root: elsewhere, name: '占用' })
  const due = await makeTask(h.profileDir, { projectId: project.id, kind: 'agent', prompt: '稍后', name: '稍后' })
  const firstDue = Date.now() - 1_000
  await arm(h.profileDir, due.id, firstDue)
  h.installUserAgent(() => new Promise(() => undefined))
  await sessionSend(h.runtime, h.routeCtx, { text: '占住这个根', sessionId: freshSessionIdFor(elsewhere), tabId: 'tab-root', modelId: 'default' })
  start(h)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', due.id)).toHaveLength(0)
  expect((await recentRuns(h.profileDir, due.id)).some((run) => run.status === 'missed')).toBe(false)
  const lateDue = Date.now() - MISSED_GRACE_MS - 5_000
  await arm(h.profileDir, due.id, lateDue)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const stored = await findAutomation(h.profileDir, due.id)
  expect(stored.enabled).toBe(true)
  expect(stored.nextRunAt).toBe(lateDue)
  expect((await recentRuns(h.profileDir, due.id)).some((run) => run.status === 'missed')).toBe(false)
  h.release()
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', due.id)).toHaveLength(1)
})
```

`sessionSend` 与 `freshSessionIdFor` 从 `sessions.ts`、`session-id.ts` 引入。用户写者必须占的是 `elsewhere` 这个项目根，而不是前台中立根。`h.release()` 必须让 Task 6 的写者名额释放；若桩的 `release` 只解开 agent 而不调用 `releaseAndDrain`，在测试里显式调用调度器的 `release` 再触发一次 tick。

在 `automations-host.spec.ts` 增加一个重叠测试：两个不同 `project.root` 的 agent 自动化都调用 `followup` 之后，才 `release` 第一条。同一 `project.root` 的第二条在第一条 `release` 之前，`followups.length` 仍为 1。脚本自动化的目标根已有写者时，不调用脚本执行函数。项目级 agent 自动化 `followup` 时，`huaanworkSessionRoots.get(本次 automationRunSessionId)` 是该项目根，不是中立工作区；运行结束并释放之后，这个键和对应的模型键都不在。

再加 `automation binds its startup model after followup`：启动时 `active_model_id` 为 `model-a`，在 `followup` 桩的入口断言本次模型键尚未写入、根键已是目标项目；让 `sendToAgent` 按统一规则在受理后写模型键，随后把全局当前模型改成 `model-b`，本次生成仍解析 `model-a`。运行 `finally` 后本次根键和模型键都清理。另设一条未受理 `followup` 的失败分支，证明不留下本次模型键。

再加 `a queued script stopped while waiting for a slot releases its root`：脚本已经准入、还在等槽时被 stop，轮到执行后从 `cancelRequested` 早退。早退之后同根用户发送可以 `followup`。超时用例里，`runScript` 的 Promise 在 `close` 之前不得 resolve；下一条同根回合不得与尚未 `close` 的进程树重叠。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automation-scheduler.spec.ts tests/huaanwork-host/automations-host.spec.ts`
Expected: FAIL。tick 仍在 `agentAutomationQueued > 0` 或 `agentIdle` 为假时返回，或超过宽限的跳过项被记成 missed。

- [ ] **Step 3: 实现**

删除 `automation-scheduler.ts` 里 `agentAutomationQueued > 0` 的整次返回，以及 `agentIdle` 的整次返回和分组前 `break`。删除 `automationRootDecision` 的 `cross` 返回；项目不存在仍返回 `missing-project`。去掉 `enqueueAgentAutomation` 对 `sessionSendBlockers` 的加减。

待准入列表 = `dueAutomations(list, now)` 再并上「enabled、非 manual、`nextRunAt <= now`、且 `isAdmissionSkipped(id)`」的项，再并上本次 `missedAutomations` 里 `policy === 'run-once'` 且尚未 `start` 的项。后两段不受 `MISSED_GRACE_MS` 过滤。按 id 去重。`missedAutomations` 的结果里，`isAdmissionSkipped(automation.id)` 为 true 的跳过 missed 记录和停用。`policy === 'run-once'` 的项不要在准入之前 `advanceNextRunAt`，也不要调用不再准入的 `enqueueAutomation({ trigger: 'catchup' })`。它和到期项一样先 `admitAutomation`：`skip` 时不推进、不 `appendRun`、不执行，保持可被后续 tick 再试；`start` 之后才执行，并在执行体启动后推进 `nextRunAt`。任务被禁用、删除或修改计划时间时调用 `clearAdmissionSkip`。

改写这两则仍钉住「跨根 catchup 不执行」的旧测试，不要为了让它们继续通过而留着绕过准入的 catchup：

- `missed skip records a run, run-once catchup enqueues, cross-root catchup does not`
- `cross-root run-once catchup stays pending, emits missed once, and runs after the workspace matches`

另加 `catchup waits for the root writer`：同根已有写者或名额已满时，逾期 run-once 不执行、不记失败运行、不推进 `nextRunAt`；写者释放后的后续 tick 才执行。

每条到期自动化在调度器里调用一次 `admitAutomation`。传入的 `root` 是该自动化所属项目的 `root`；没有项目时用中立根。不要对 `automationRunSessionId(...)` 调用 `writableRootForSession`。那个 id 对不上任务绑定，也不匹配 `sessionIdFor(项目根)` 加 `-` 的前缀，推导结果会变成中立工作区。agent 的 `sessionId` 用 `automationRunSessionId(automation.id, runId)`，`countsTowardCap: true`。脚本的 `sessionId` 用 `` `script:${runId}` ``，`countsTowardCap: false`。不要把脚本的 `sessionId` 留成 `undefined`。`skip` 时不 `appendRun`、不 `advanceNextRunAt`、不停用，也不要在执行体里再准入一次。`start` 之后调用执行体。

`enqueueAgentAutomation` 不再串 `automationTail`，也不再调用 `admitAutomation`。这一次准入只有一个 `releaseOnce`。`whenIdle` 结束和尚未 `followup` 的失败都调用它，不要各写一次释放。`runAgentTurn` 开始时先读取并保存当时的 `activeModelId`，在 `sendToAgent` 之前只写根表：`huaanworkSessionRoots.set(sessionId, path.resolve(root))`，用的是这次准入已经知道的项目根或中立根，供 create/resume 与沙箱使用。调用 `sendToAgent` 时显式传入这个 `activeModelId` 和同一个 root；由 `sendToAgent` 在 `followup` 受理后写 `huaanworkSessionModels`，不要在受理前预写模型表，也不要让它改读后来的全局 `active_model_id`。`sendToAgent` / `ensureChannelAgent` 看见表里已有根就用它，不得再推导成中立工作区。`finally` 只删除这次运行的这两个键，不第二次释放写者。绑定模型通不过网络门禁时记一次失败运行并调用这同一个 `releaseOnce`，不要记成 admission skip，否则会每个 tick 永久重试。

脚本执行的 cwd 用该自动化的项目根；没有项目时用中立根。传入调度器的 `root` 用 `path.resolve` 之后的路径，与用户准入的键相同。不要把 `routeCtx.workspaceRoot.current` 传给 `runScript`。槽位在这一次准入成功之后获取。`runScript` 的完成 Promise 在超时杀进程后也要等到子进程 `close`，不能在 `kill` 之后立刻 resolve。`releaseOnce` 只挂在实际 `close`、启动失败，以及 `executeRun` 里尚未把执行权交给子进程的 return（含 `cancelRequested` 早退和项目已删除的早退）。等槽期间被 stop、轮到后从早退返回的脚本，必须走这个 `releaseOnce`，否则根写者会留下。交接给子进程之后，不要在 `await runScript` 之前再释放一次。

`routes.ts` 的 `automation.run` 删除 `openWorkspace`、`closeWorkspace`、`assertAutomationIdle` 和 `agentIdle(ctx)` 那一行。这里是手动运行的唯一准入点，不要再进会自己准入的 enqueue。`skip` 时返回 `{ queued: false, waiting: true, runId, workspaceRoot: ctx.workspaceRoot.current }`。成功启动时仍返回 `{ queued: true, runId, workspaceRoot: ctx.workspaceRoot.current }`。两种都保留 `workspaceRoot`，避免路由契约的必含键被拆掉。`waiting` 只在 skip 时出现，把它写进 `route-contract.spec.ts` 的 `OPTIONAL_KEYS_WHITELIST['automation.run']`。不把前台根改成目标项目。

导出 `evaluateDueAutomations`。它复用 tick 里「列出到期项并准入」的那段，不另写一套 skip 规则。Task 6 的注入在这里接上真实函数。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automation-scheduler.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/route-contract.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts dsh-plugin-huaanwork/src/huaanwork-host/automation-scheduler.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts
git commit -m "feat: run HuaAnWork automations on their own project roots"
```

仅当用户明确要求提交时执行。

---

### Task 9: 子任务记住模型

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`（`RpcRequest` 增加 `task.setModel`；若保留 `TaskInfo`，字段与 `logic/projects.ts` 一致）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts`（`TaskInfo.modelId?: string`，这是界面实际使用的那一份）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/stores.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`（仿 `task.rename` 增加 `task.setModel`）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/projects.ts`（`setTaskModel` 客户端函数，内部 `rpcCall('task.setModel', params)`，返回 `logic/projects.ts` 的 `TaskInfo`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts`（没有则新建只覆盖 `setTaskModel`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`（「ROUTE_TABLE 不受影响」用例的计数与标题）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`

**Interfaces:**
- Consumes: `TaskInfo`、现有 `task.rename` 的路由形状。
- Produces: `logic/projects.ts` 的 `TaskInfo.modelId?: string`。`setTaskModel(storageRoot, input: { taskId: string; modelId: string }): Promise<TaskInfo>`。RPC `task.setModel` 返回 `{ task }`，客户端函数返回同一份 `TaskInfo`。旧文件没有该字段时 `isTaskInfo` 仍接受。渲染进程只通过这个 RPC 写模型，不直接 import `stores.ts`。`App.tsx` 从 `projects.ts` 拿到的任务类型必须有 `modelId`，否则 `task.modelId` 会 TS2339。`rpc-types.ts` 里若还留着另一份 `TaskInfo`，字段与 `logic/projects.ts` 对齐，或改成从那份类型引出。

- [ ] **Step 1: 写失败测试**

```ts
test('setTaskModel keeps an existing task readable without the field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huaanwork-tasks-'))
  const project = await createProject(dir, { root: mkdtempSync(join(tmpdir(), 'huaanwork-task-root-')) })
  const task = await createTask(dir, { projectId: project.id, name: '周报' })
  expect(task.modelId).toBeUndefined()
  const saved = await setTaskModel(dir, { taskId: task.id, modelId: 'local-model' })
  expect(saved.modelId).toBe('local-model')
  expect((await listTasks(dir, project.id))[0]?.modelId).toBe('local-model')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/stores.spec.ts`
Expected: FAIL，`setTaskModel` 不存在。

- [ ] **Step 3: 实现**

`isTaskInfo` 不要求 `modelId`。若存在则必须是非空字符串，否则忽略该字段而不是丢弃整条任务。`setTaskModel` 在任务锁内写入。空 `modelId` 抛出「任务模型不存在」。不要在这里检查模型列表，列表检查留在发送准入。

`sessionSend` 在返回 `started: true` 且这条会话绑着子任务、该任务没有 `modelId` 时，用本次准入的 `modelId` 调用 `setTaskModel`。`started: false` 不写回。已有 `modelId` 的任务不被这次发送改写。排队项不写回，避免还没执行就把选择落盘；出队且 `followup` 受理后再写。

路由按 `task.rename` 的 POST 形状增加 `task.setModel`，路径 `/huaanwork/task/setModel`，必含返回键 `task`。`RpcRequest`、`api.ts` 的 `ROUTES`、`projects.ts` 的客户端函数一起加上。`route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts` 里方法总数从 71 改为 72，两边的方法集合和 `task.setModel` 的必含键同时改。只改一边会让双向键集合测试失败。第四处手写计数在 `market-routes.spec.ts` 的「ROUTE_TABLE 不受影响(表外注册,71 不破)」：断言值和测试标题里的 71 一起改成 72，该用例的本意（市场路由在表外注册）不变。漏掉这一处时 Task 9 自己的命令仍会绿，要到 Task 11 Step 3 全目录跑才撞红。

同一批把 `session.send` 的声明键从 `['ok']` 改成 `['queued', 'waiting', 'started', 'sessionId']`，`queueItemId` 放进 `OPTIONAL_KEYS_WHITELIST`。`started` 每次都在，创建取消和排队也返回 false，不要把它放进可选键。这三份文件是手写对照表，不解析 handler 的 return。只改运行时返回值不会让它们变红；新路由若不改计数，72 个方法会对着 `toBe(71)` 失败。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/stores.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/market-routes.spec.ts tests/client-huaanwork/api.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/stores.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/projects.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/projects.ts dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts
git commit -m "feat: store the model chosen for a HuaAnWork task"
```

仅当用户明确要求提交时执行。

---

### Task 10: 客户端排队状态与设置输入

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/Settings.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`（终态落到活动回合的用户消息，不取最后一条）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts`（等待中或本次发送已抛错的用户消息不算更新的回合）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts`（排队发送不得提前清掉上一回合的目标窗）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`（epoch 与 `turn-started` 的位置）

**Interfaces:**
- Consumes: `session.send` 的 `{ waiting, started, queueItemId }`，以及 `session/queue-start`、`session/queue-fail`。
- Produces:

```ts
export type TabRunState = { running: boolean; waitingIds: string[] }

export function sendOpensTurn(result: { waiting: boolean; started: boolean }): boolean
export function noteSendResult(state: TabRunState, result: { waiting: boolean; started: boolean; queueItemId?: string }): TabRunState
export function noteTurnEnded(state: TabRunState): TabRunState
export function noteWaitingStarted(state: TabRunState, queueItemId: string): TabRunState
export function noteWaitingCancelled(state: TabRunState, queueItemId: string): TabRunState
export function noteWaitingFailed(state: TabRunState, queueItemId: string): TabRunState
```

`sendOpensTurn` 只在 `waiting: false` 且 `started: true` 时返回 true。`noteSendResult` 在这时把 `running` 设为 true，不清除已有 `waitingIds`。`waiting: true` 且有 `queueItemId` 时只追加该 id，不改变 `running`。`started: false` 时原样返回。`noteTurnEnded` 只把 `running` 设为 false，不删除 `waitingIds`。`noteWaitingStarted` 去掉该 `queueItemId` 并把 `running` 设为 true。`noteWaitingFailed` 只去掉该 `queueItemId`，不改变 `running`。用户消息的 `ChatItem` 增加可选 `queueItemId?: string` 与本地 `sendRejected?: boolean`。等待文案挂在带 `queueItemId` 的那条 `kind: "user"` 上，不挂在标签级的另一份列表上；`sendRejected` 只标记本次 RPC 已抛错且未启动的消息，不参与宿主应答契约。

- [ ] **Step 1: 写失败测试**

```ts
test('a second send on a running tab stays running and records the waiting item', () => {
  const running = noteSendResult({ running: false, waitingIds: [] }, { waiting: false, started: true })
  const both = noteSendResult(running, { waiting: true, started: false, queueItemId: 'q1' })
  expect(both).toEqual({ running: true, waitingIds: ['q1'] })
  expect(noteTurnEnded(both)).toEqual({ running: false, waitingIds: ['q1'] })
  expect(noteWaitingStarted(noteTurnEnded(both), 'q1')).toEqual({ running: true, waitingIds: [] })
  expect(noteWaitingCancelled(both, 'q1')).toEqual({ running: true, waitingIds: [] })
  expect(noteWaitingFailed(both, 'q1')).toEqual({ running: true, waitingIds: [] })
})

test('a send that does not start leaves the tab idle', () => {
  const idle = { running: false, waitingIds: [] as string[] }
  expect(sendOpensTurn({ waiting: false, started: false })).toBe(false)
  expect(sendOpensTurn({ waiting: true, started: false })).toBe(false)
  expect(sendOpensTurn({ waiting: false, started: true })).toBe(true)
  expect(noteSendResult(idle, { waiting: false, started: false })).toEqual(idle)
})

test('stopping one tab leaves the other running', () => {
  const stopped = noteTurnEnded({ running: true, waitingIds: [] })
  const other = { running: true, waitingIds: [] as string[] }
  expect(stopped.running).toBe(false)
  expect(other.running).toBe(true)
})
```

再加一条纯函数：`diff` 按标签保存。带 `sessionId` 时只进入该会话的标签；不带 `sessionId` 时不猜测标签。切到另一个标签读到的是自己的 diff。测试名写 `a background diff stays off the visible tab`。

`toolPanel.spec.ts` 增加 `turn final settles the active user message`，直接调用 `applyTurnFinalToTabs`：同一标签上先有活动用户消息，后面还有带 `queueItemId` 的等待消息。`session/end` 把终态记到活动消息的 id 上，不记到最后一条等待消息。`outcomeCheck.spec.ts` 增加 `a waiting user message does not drop the active outcome`：`appendOutcomeNotes` 在最新用户消息仍在等待时，保留活动回合的核对结果。

再加 `stopping one tab does not consume the other stop ticket`：停止票据按标签 id 存放。标签 A 的票据在飞时，标签 B 仍可记下自己的票据。`stopPendingRef`、`userStopSessionRef`、`stopping`、`turnPulse` 和回合 epoch 不再是进程里唯一的一份。

`goalRound.spec.ts` 增加 `a queued send does not clear the running turn goal window`。直接调用 `reduceGoalTurn`，同一 `sessionId` 上先 `turn-started`，再 `goal-state` phase `paused`，`suppressed` 含该会话。此时不再调用 `turn-started`，直接 `session-end` 且 `ok: true`，action 是 `none`。对照序列在 `session-end` 之前多插一次 `turn-started`，同一条结束的 action 是 `outcome`。这条对照说明提前开窗会放掉上一回合的暂停结论。`GoalTurnState` 仍按 `sessionId` 存储，不改成按用户消息 id 做键。

`appWiring.spec.ts` 增加以下接线回归，不能只测纯函数：

- `a queued send preserves the running turn stop latch`：A 的停止已扣闩，B 仅排队后，A 的停止闩锁、`stopping` 和 epoch 不变；A 的结束仍记为用户停止。测试同时证明 B 不改 A 的停止票据。
- `a goal intermediate end keeps the tab running`：目标相位仍 active 时收到中间 `session/end`，标签 running 与停止按钮保留；后续 `goal/round` 只恢复该标签的执行态。
- `stale idle uses the event tab epoch`：A、B epoch 不同，A 的旧结束只按 A 的 epoch 判定，B 的当前 epoch 不得影响结果。
- `a queued response backfills the inserted user message`：消息先插入、应答后补 `queueItemId`，等待文案挂在 B 上，A 的终态仍落在 A 的活动消息 id 上。
- `queue fail does not duplicate the emitted notice`：创建取消/更新失败已经收到 `agent/notice` 时，queue-fail 只移除等待文案，不重复插入相同 reason；模型被删等无 notice 分支仍插入 reason。
- `early session end is buffered until the started response`：直接发送的 fetch 尚未 resolve 时先到 `session/end`，此时不得把未初始化回合错误结算；应答 `started:true` 后先开窗再重放结束，最终 running 为 false、终态落在本次用户消息上，epoch 只增加一次。
- `early queue start is buffered until the queued response`：waiting 应答尚未返回时先到 `queue-start`，不得提前清等待或初始化；应答先写回 queueItemId，再重放 queue-start，最终 waitingIds 清空、running 为 true、活动消息是本次消息，不得出现 running 与 waiting 并存。
- `pending send does not buffer the previous turn events`：A 执行、B pending 时，A 的 session/end 必须即时结算，不得进入 B 的缓冲；随后 B 的 waiting 应答不得撤销 A 的停止闩锁或终态。
- `a rejected send leaves the running turn stop latch`：A 正在执行且停止已扣闩时，B 因模型不存在或根目录不存在而 `session.send` reject。断言 A 的停止闩锁、`stopping`、epoch 和 `running` 全部不变，标签仍显示 B 的失败原因且不被标成 `sessionFailed`；随后 A 的结束仍记为用户停止，终态落在 A 而不是 B，B 不参与最新用户消息或 outcome 选择；B 的 pending 与缓冲已清理，A 的事件不被拖住。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/concurrentTurn.spec.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现并接到界面**

实现上面接口列出的全部六个函数。状态按标签 id 放一份 `TabRunState`，不要再靠进程级 `turnActive` 表示「有没有回合」。

`Settings.tsx` 的模型区增加数字输入，标签「同时进行的任务数」，`min={1}` `max={8}` `step={1}`。变更时 `rpcCall('settings.set', { max_concurrent_turns: Number(value) })`。`ModelSettingsPayload` 增加可选 `max_concurrent_turns?: number`。

`App.tsx` 的 `send()` 删除 `turnActive` 全局早退，也删除 `automationActiveRef.current` 那段「后台任务运行中，请稍候再发送消息」。进程级 `sendingRef` 改成按标签 id 记录的在途发送；它只挡住同一标签的重入，不挡住另一个标签。`selectSubtask`、`createProjectFlow`、`openProjectById` 去掉 `automationActiveRef` 早退。项目列表上 `disabled={runningAutomationIds.size > 0 || ...}` 去掉 `runningAutomationIds.size > 0`。`selectBusy` 仍只表示这次选择点击还没返回。

`turnTabRef`、`turnSessionRef`、`liveChatRef` 不再作为唯一回合的槽。`App.tsx` 里的 `stopPendingRef`、`userStopSessionRef`、`latchOwnerRef`、`stopping`、`turnPulse` 和 `turnEpochRef` 也改成按标签存放。标签 A 的停止请求在飞时，不得挡住标签 B 的停止，也不得把 B 的 `session/end` 记成 A 的用户停止。排队和 `started:false` 不得清除正在执行回合的停止闩锁、不得把 `stopping` 拨回 false、不得重置既有 `turnPulse`。`finishStop`、`settleStop`、`stopTurn` 造票据和 `consumeStaleIdle` 都比较事件所属标签自己的 epoch；另一个标签开始回合不增加这一标签的 epoch，也不能用另一标签的当前 epoch 判定旧结束。`goal/round` 按事件 sessionId 找到标签，只把该标签的 `running` 设回 true。`session/end` 仍按 sessionId 找标签，但若 `GoalTurnState.phases[sessionId] === 'active'`，这是目标续轮的中间结束，不得清 running、不得撤停止按钮；非 active 的真正终局才清 running。进度条和停止按钮读该标签的 `TabRunState.running`。`bridge.reportTurns` 改为占名额的 `running` 标签数加上 `runningRuns.size`，不再用 `(turnActive ? 1 : 0)`。`appWiring.spec.ts:353` 和 `:553` 钉的是旧公式，改成新的按标签计数和按标签进度条，不要为了让旧正则通过而把单槽留着。

`send()` 保持现有顺序：先按本地 `userMsg.id` 把用户消息插入标签，再以 `tabId + userMsg.id` 建 pending 记录并调用 `session.send`。pending 只保存本次已知 sessionId 和早到事件，不增加 epoch、不发 `turn-started`、不清停止闩锁。若该标签没有正在执行的同会话回合，匹配 sessionId 的早到 `session/end` 与 goal 事件进入本次 pending；若上一回合仍执行，它的事件照常即时处理。未知 queueItemId 的 queue-start/queue-fail 在 pending 期间按标签和到达顺序入本次缓冲，已能匹配其他等待消息的队列事件不得被扣住。

应答回来后先写回身份：`waiting:true` 时按本地 `userMsg.id` 把 `queueItemId` 写回**已经插入的同一条用户消息**并显示「等待当前任务」，只更新 `waitingIds` 不算完成；`started:false` 不写 queueItemId、不标等待、不记活动回合，并只丢弃本次缓冲。随后 `sendOpensTurn` 为 true 时才增加该标签 epoch、发出 `turn-started` 并记下活动 `ChatItem.id`。对 waiting 应答，只重放 queueItemId 与应答一致的缓存 queue-start/queue-fail；重放 queue-start 的时点才执行同样的 epoch/turn-started/active 初始化。其他未知 id 不得套用到这条消息。直接 started:true 的缓存 `session/end` 与 goal 事件在初始化后按原到达顺序重放，保证早到结束最终仍清 running，而不是被应答覆盖成假运行。

`session.send` 的 `catch` 不得沿用现有的无条件 `setTurnActive(false)`、`stopping.current = false` 后提前 return、或无条件 `sessionFailed: true`。它要给本次 `userMsg` 标上 `sendRejected: true`，并把错误原因作为 note 追加到发送标签；停止闩锁仍扣着时也必须追加。该标签仍有正在执行的回合时，保留其 `userStopSessionRef`、`latchOwnerRef`、`stopping`、epoch、`running` 和 `sessionFailed` 原状态。`catch` 删除本次 pending 与缓冲，`finally` 再按 `tabId + userMsg.id` 做幂等清理；不得清除其他发送的 pending，也不得让上一回合事件进入这次已失败的缓冲。

`applyTurnFinalToTabs` 和 goal/outcome 用实际活动消息 id 结算。仍带 `queueItemId`、尚未收到或重放 `session/queue-start` 的用户消息是等待项，带 `sendRejected` 的消息是未启动项；两者都不参与「最后一条用户消息」的选择。`latestUserItemId` / `appendOutcomeNotes` 选择或比较最新用户消息时同样跳过这两类，不能仅按 `kind === "user"` 取最后一项。`toolPanel.spec.ts` 里既有单回合用例保持原期望。`appWiring.spec.ts` 里钉死 `applyTurnFinalToTabs(prev, tabId, event, phase)` 的正则改成把活动用户消息 id 传进去。同文件同时钉 `send()` 与 `session/queue-start` 处理函数的源码顺序：在 `send()` 中，`turnEpochRef` 自增和 `kind:'turn-started'` 都位于 `rpcCall('session.send')` 之后且在 `sendOpensTurn` 为真的分支里；在 queue-start 分支中，二者都位于 `noteWaitingStarted` 之后。测试名写 `queued send opens the goal window only when the turn starts`。

`session/queue-start` 早于本次 waiting 应答到达时，不得直接执行启动分支，先按上一节进入 pending；只有身份已写回、或应答后的重放阶段，才用事件里的 `tabId` 找到标签，调用 `noteWaitingStarted`，清掉该 `queueItemId` 的等待文案，然后才增加该标签的 epoch、发出 `turn-started`，并把该条用户消息记为这个标签的活动回合。`session/queue-fail` 同样先经 pending 排序，再调用 `noteWaitingFailed`，只去掉这条等待，不把 `running` 改成 false。若 `reason` 与刚收到的 `agent/notice.text` 相同，只保留原来的 notice，不重复插第二条失败脚注；模型删除、根目录消失等没有 notice 的复检失败仍显示 `reason`。调用 `session.send` 后用 `noteSendResult` 更新该标签，并按上一节把 `queueItemId` 写回已插入的用户消息。`session.send` 的参数带上当前标签 id、所选 `modelId`，以及本次的 `skill` 或 `at`。停止按钮只对 `running === true` 的标签调用 `session.cancel`，不带 `queueItemId`。等待消息上的取消调用 `session.cancel`，只带该条消息的 `queueItemId`。

发送前不再为了铸造会话去调用 `ensureNeutralWorkspace()` 或 `alignWorkspaceOnly()`。标签已有项目时，`session.new` 传入该项目根；未绑定项目时传入中立根。宿主返回的 `cwd` 只属于这条新会话。

发送区增加模型选择，选项为 `settings.models`。新任务默认 `active_model_id`。已有 `task.modelId` 时用它。变更时调用 Task 9 的客户端 `setTaskModel`。

差异按标签保存，替换现在的进程级 `setDiff`。有 `sessionId` 时只写入该会话的标签；当前标签不是它时，不改当前标签的 diff，也不因此切到 diff 页。没有 `sessionId` 时客户端不写入任何标签。宿主在 `emitGitDiff` 缺少 `sessionId` 时调用 `soleCapWriterSessionId()`：有值则补上那个会话 id 再发出；没有值时 `routeCtx.logger` 记一条，并且不补 id。不要用 `activeTurnCount()` 代替这个查询，计数看不出是哪一个会话。不要在客户端用 `console.warn` 代替这条宿主日志。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/concurrentTurn.spec.ts tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts tests/client-huaanwork/goalRound.spec.ts`
Expected: PASS

再跑与发送接线相关的现有客户端测试。`appWiring.spec.ts` 里钉住 `turnActive` 早退、`(turnActive ? 1 : 0)` 和 `turnActive && turnPulse.tabId === activeChat.id` 的断言，改成按标签的执行状态。不要恢复全局早退，也不要恢复单槽公式来换绿。

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts dsh-plugin-huaanwork/src/client-huaanwork/Settings.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat: show queued HuaAnWork tasks while another project runs"
```

仅当用户明确要求提交时执行。

---

### Task 11: 规格条款回归

本任务不写新功能。它核对规格 §7 和评审 P1-6、P1-7 是否各有一条仍然失败就会红的测试，再跑会被本功能改动碰到的既有套件。局部文件通过不得写成 workspace 通过。

**Files:**
- Modify only when a listed clause has no test or a regression is reproduced: the owning source/test files from Tasks 1–10
- Create: `docs/evidence/2026-11-03-concurrent-project-turns-verification.md`（只在本任务的命令跑完后写入实际结果）

**Interfaces:**
- Consumes: Tasks 1–10 的实现。
- Produces: 一张「规格条款 → 测试名 → 命令 → 结果」表。缺测试名的条款记为未验收，不得记通过。

- [ ] **Step 1: 核对每条验收条款都有测试名**

在仓库根目录执行。每一条都必须在对应文件里出现测试名；零命中就回到拥有该行为的任务补测试，不要在本任务放宽条款。

```bash
rg -n "clamps max_concurrent_turns" dsh-plugin-huaanwork/tests/huaanwork-host/settings.spec.ts
rg -n "two roots start together" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "drain starts a later free root" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "fresh project session and lost task binding" dsh-plugin-huaanwork/tests/huaanwork-host/writable-root.spec.ts
rg -n "session allowed root rejects the foreground" dsh-plugin-huaanwork/tests/huaanwork-guardrails/sandbox-cwd.spec.ts
rg -n "pinned models stay apart" dsh-plugin-huaanwork/tests/huaanwork-host/session-models.spec.ts
rg -n "session.send returns before the turn is idle" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "a failed queued item releases the cap for the next root" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "drain stops when the cap is full" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "cancel removes one queued item and cap drop does not cancel a running turn" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "one unattended scope does not answer another session" dsh-plugin-huaanwork/tests/huaanwork-guardrails
rg -n "admission skip survives the missed grace" dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts
rg -n "second send on a running tab" dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts
rg -n "setTaskModel keeps an existing task" dsh-plugin-huaanwork/tests/huaanwork-host/stores.spec.ts
rg -n "a child session does not increment the active turn count" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "a missing writable root does not start" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "foreground switch leaves the background session root" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "stopping one tab leaves the other running" dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts
rg -n "a background diff stays off the visible tab" dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts
rg -n "automation start occupies the root" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "trailing slash and dotdot share one writer" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "sole cap writer is absent at zero and at two" dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts
rg -n "context maps assign on a cordis context" dsh-plugin-huaanwork/tests/huaanwork-host/holders-context.spec.ts
rg -n "a late release from the first turn does not drop the next turn" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "cancelling a queued item leaves the running turn" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "a queued skill and at replay on dequeue" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "catchup waits for the root writer" dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts
rg -n "a queued script stopped while waiting for a slot releases its root" dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts
rg -n "turn final settles the active user message" dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts
rg -n "a waiting user message does not drop the active outcome" dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts
rg -n "stopping one tab does not consume the other stop ticket" dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts
rg -n "session.send without a tab throws" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "a queued creation cancel fails without starting" dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts
rg -n "a queued update failure fails without starting" dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts
rg -n "first project creation keeps its root while another is foreground" dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
rg -n "automation binds its startup model after followup" dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts
rg -n "a send that does not start leaves the tab idle" dsh-plugin-huaanwork/tests/client-huaanwork/concurrentTurn.spec.ts
rg -n "a queued send does not clear the running turn goal window" dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts
rg -n "queued send opens the goal window only when the turn starts" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "a queued send preserves the running turn stop latch" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "a goal intermediate end keeps the tab running" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "stale idle uses the event tab epoch" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "a queued response backfills the inserted user message" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "queue fail does not duplicate the emitted notice" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "early session end is buffered until the started response" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "early queue start is buffered until the queued response" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "pending send does not buffer the previous turn events" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
rg -n "a rejected send leaves the running turn stop latch" dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
```

Expected: 每条 rg exit 0，且只命中测试名或它的 `test(` / `it(` 行。把命中行写入证据文档的「条款对照」表。表的行固定为：

| 条款 | 必须存在的测试名 | 所在文件 |
| --- | --- | --- |
| 上限缺省 3，小于 1 为 1，大于 8 为 8，非整数为 3 | `clamps max_concurrent_turns` | `settings.spec.ts` |
| 两个项目根同时开始，同根第二条排队 | `two roots start together` | `turn-scheduler.spec.ts` |
| 队头根忙时，后面的空闲根先开始 | `drain starts a later free root` | `turn-scheduler.spec.ts` |
| 任务绑定丢失后仍按 `header.cwd` 留在项目根 | `fresh project session and lost task binding` | `writable-root.spec.ts` |
| 越界路径回到会话自己的根，不回到前台项目 | `session allowed root rejects the foreground` | `sandbox-cwd.spec.ts` |
| 两个会话各用各的模型，删掉的模型不回落全局 | `pinned models stay apart` | `session-models.spec.ts` |
| 应答在回合结束前返回；取消不提前释放名额 | `session.send returns before the turn is idle` | `sessions.spec.ts` |
| 名额只剩 1 时，出队复检失败会让下一个根继续启动 | `a failed queued item releases the cap for the next root` | `sessions.spec.ts` |
| 出队在名额用尽时停止 | `drain stops when the cap is full` | `turn-scheduler.spec.ts` |
| 调低上限不取消已执行回合，新发送在新上限下等待 | `cancel removes one queued item and cap drop does not cancel a running turn` | `turn-scheduler.spec.ts` |
| 一条无人值守记录不回答另一条会话 | `one unattended scope does not answer another session` | `tests/huaanwork-guardrails` |
| 跳过的到期自动化越过 10 分钟宽限仍不记 missed、不停用 | `admission skip survives the missed grace` | `automation-scheduler.spec.ts` |
| 正在跑的标签再发一条仍保持执行中，并记下等待项 | `second send on a running tab` | `concurrentTurn.spec.ts` |
| 旧任务没有 `modelId` 仍可读，写入后能读回 | `setTaskModel keeps an existing task` | `stores.spec.ts` |
| 子代理不使执行中的回合数加一 | `a child session does not increment the active turn count` | `sessions.spec.ts` |
| 可写根目录已不存在时该次不启动 | `a missing writable root does not start` | `sessions.spec.ts` |
| 前台切换后后台会话的根不变 | `foreground switch leaves the background session root` | `sessions.spec.ts` |
| 停止一个标签不影响另一个标签 | `stopping one tab leaves the other running` | `concurrentTurn.spec.ts` |
| 后台会话的 diff 不写入当前正在查看的标签 | `a background diff stays off the visible tab` | `concurrentTurn.spec.ts` |
| 自动化成功占根，释放后同根才能再开始 | `automation start occupies the root` | `turn-scheduler.spec.ts` |
| 尾分隔符和 `..` 与用户准入共用一个写者 | `trailing slash and dotdot share one writer` | `turn-scheduler.spec.ts` |
| 零个或两个占名额写者时不猜 diff 会话 | `sole cap writer is absent at zero and at two` | `turn-scheduler.spec.ts` |
| 两张 Map 能赋到真实 Cordis Context 并被另一侧读到 | `context maps assign on a cordis context` | `holders-context.spec.ts` |
| 同一会话上一项的迟到释放不拆掉下一项 | `a late release from the first turn does not drop the next turn` | `sessions.spec.ts` |
| 只取消等待项时，正在执行的回合和子代理不被取消 | `cancelling a queued item leaves the running turn` | `sessions.spec.ts` |
| 排队后的技能和 @ 按原字段重放，并回到原标签 | `a queued skill and at replay on dequeue` | `sessions.spec.ts` |
| run-once catchup 在同根忙时不执行，释放后才执行 | `catchup waits for the root writer` | `automation-scheduler.spec.ts` |
| 等槽时被停止的脚本会放开根 | `a queued script stopped while waiting for a slot releases its root` | `automations-host.spec.ts` |
| 终态落到活动用户消息，不落到后面的等待消息 | `turn final settles the active user message` | `toolPanel.spec.ts` |
| 等待中的用户消息不丢掉活动回合的核对结果 | `a waiting user message does not drop the active outcome` | `outcomeCheck.spec.ts` |
| 一个标签的停止票据不占用另一个标签 | `stopping one tab does not consume the other stop ticket` | `concurrentTurn.spec.ts` |
| 有文本但没有标签时拒绝发送 | `session.send without a tab throws 缺少标签` | `sessions.spec.ts` |
| 排队中的创建取消不启动回合 | `a queued creation cancel fails without starting` | `agent-package-creation.spec.ts` |
| 排队中的更新失败不启动回合 | `a queued update failure fails without starting` | `agent-package-creation.spec.ts` |
| 前台在另一项目时，首建会话在 create 前已登记自己的根，受理后才写模型 | `first project creation keeps its root while another is foreground` | `sessions.spec.ts` |
| 自动化根在发送前登记，启动时模型在 followup 受理后绑定且不读后来的全局模型 | `automation binds its startup model after followup` | `automations-host.spec.ts` |
| 未启动的发送不把标签标成执行中 | `a send that does not start leaves the tab idle` | `concurrentTurn.spec.ts` |
| 排队发送不提前清掉上一回合的目标暂停 | `a queued send does not clear the running turn goal window` | `goalRound.spec.ts` |
| epoch 和 turn-started 发生在回合真正开始之后 | `queued send opens the goal window only when the turn starts` | `appWiring.spec.ts` |
| 排队或未启动发送保留正在执行回合的停止闩锁与 epoch | `a queued send preserves the running turn stop latch` | `appWiring.spec.ts` |
| goal active 的中间结束不清执行态，续轮只恢复所属标签 | `a goal intermediate end keeps the tab running` | `appWiring.spec.ts` |
| 旧结束只按事件所属标签的 epoch 判定 | `stale idle uses the event tab epoch` | `appWiring.spec.ts` |
| 应答后把 queueItemId 写回已插入消息，终态不落等待消息 | `a queued response backfills the inserted user message` | `appWiring.spec.ts` |
| 已发 notice 的 queue-fail 不重复显示同一 reason | `queue fail does not duplicate the emitted notice` | `appWiring.spec.ts` |
| 直接 started 应答前的早到结束先缓冲，初始化后重放 | `early session end is buffered until the started response` | `appWiring.spec.ts` |
| waiting 应答前的早到出队先缓冲，写回 id 后重放 | `early queue start is buffered until the queued response` | `appWiring.spec.ts` |
| pending 发送不延迟上一回合的结束与停止闩锁 | `pending send does not buffer the previous turn events` | `appWiring.spec.ts` |
| 发送抛错保留正在执行回合的闩锁与终态，显示失败原因并清理 pending | `a rejected send leaves the running turn stop latch` | `appWiring.spec.ts` |

直接取消和更新失败沿用 `agent-package-creation.spec.ts` 里已有的两则测试名：`cancel discards the draft, emits the fixed notice, and sends nothing to the model`，以及 `/create-agent update <missing> emits a notice instead of failing the send`。这两则必须断言 `started: false` 且不 reject。另外打开 `sessions.spec.ts`、`agent-package-creation.spec.ts`、`automations-host.spec.ts`，确认每一处 `sessionSend(` 和 `session.send` 的 body 都带了 `tabId`。缺一处就算这条未验收。网络门禁、缺文本、技能不存在这些用例的失败文案仍是原来的原因。

- [ ] **Step 2: 跑这些条款测试，失败则回到拥有该行为的任务**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run \
  tests/huaanwork-host/settings.spec.ts \
  tests/huaanwork-host/turn-scheduler.spec.ts \
  tests/huaanwork-host/writable-root.spec.ts \
  tests/huaanwork-guardrails/sandbox-cwd.spec.ts \
  tests/huaanwork-host/session-models.spec.ts \
  tests/huaanwork-host/sessions.spec.ts \
  tests/huaanwork-host/holders-context.spec.ts \
  tests/huaanwork-guardrails/route-tool-plugin.spec.ts \
  tests/huaanwork-host/automation-scheduler.spec.ts \
  tests/huaanwork-host/automations-host.spec.ts \
  tests/huaanwork-host/stores.spec.ts \
  tests/huaanwork-host/route-contract.spec.ts \
  tests/huaanwork-host/routes.spec.ts \
  tests/huaanwork-host/workspace.spec.ts \
  tests/huaanwork-host/policy-type.spec.ts \
  tests/huaanwork-guardrails/policy.cordis.spec.ts \
  tests/huaanwork-guardrails/question-answerer.spec.ts \
  tests/client-huaanwork/api.spec.ts \
  tests/client-huaanwork/concurrentTurn.spec.ts \
  tests/client-huaanwork/toolPanel.spec.ts \
  tests/client-huaanwork/outcomeCheck.spec.ts \
  tests/client-huaanwork/goalRound.spec.ts \
  tests/client-huaanwork/appWiring.spec.ts \
  tests/huaanwork-host/agent-package-creation.spec.ts
```

Expected: PASS。失败时保存完整失败名和断言差异。禁止删掉断言、放宽文案或把跨根测试改回「跨根不执行」来换绿。旧调度测试若仍要求 `automationTail` 串行全部项目，或要求跨根到期任务保持 due，按 Task 8 改断言后再跑，不在本任务保留旧行为。

- [ ] **Step 3: 跑会被改动碰到的相邻套件**

这些目录里的既有用例会读到会话发送、沙箱夹紧、自动化门、设置合并和客户端发送早退。本功能的新文件全绿不能代替它们。

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host tests/huaanwork-guardrails tests/client-huaanwork
```

Expected: PASS。记录三个目录各自的 passed / failed / skipped 计数。环境性失败保留原始输出，并写明它是否在改动这些目录之前已经存在；不得把它改记成「本功能通过」。

- [ ] **Step 4: 跑 HuaAnWork 包的全量测试和类型检查**

一次一条。前一条非零则停，不开始下一条。

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: 两条都 exit 0。`test` 的汇总行（passed / failed / skipped）原样写入证据。类型错误若来自 `max_concurrent_turns`、`TaskInfo.modelId`、`huaanworkUnattended` 的 Map、`huaanworkSessionModels`、`huaanworkSessionRoots` 或 `session.send` 的新返回字段，回到对应任务修，不在证据里写成已知例外。

- [ ] **Step 5: 把条款表和命令结果写入证据，并核对工作树**

`docs/evidence/2026-11-03-concurrent-project-turns-verification.md` 至少包含：

- 执行日期、`node -v`、`corepack yarn -v`、`git rev-parse HEAD`
- Step 1 的条款表，每行一个测试名和 rg 命中
- Step 2、Step 3、Step 4 的命令、exit code、汇总行
- 明确写「root `corepack yarn test` / `typecheck` / `check` 尚未在本任务执行」以及「图形界面尚未走查」

然后运行：

```bash
git status --short
git diff --check
```

Expected: `git diff --check` 无输出且 exit 0。`git status` 不得把 `.gstack/`、`.qoder/` 或与本功能无关的既有未跟踪文件列入本任务要提交的路径。

- [ ] **Step 6: 条件式提交**

只有本任务产生了回归修复，且用户明确要求提交时，才提交修复。证据文档留到 Task 12，避免把未跑完的 root 门禁和一份写着「通过」的证据一起提交。

```bash
git add dsh-plugin-huaanwork/tests dsh-plugin-huaanwork/src
git commit -m "test: close concurrent project turn regressions"
```

没有修复就不要执行这段 `git add`。

---

### Task 12: Root 门禁与证据

**Files:**
- Modify: `docs/evidence/2026-11-03-concurrent-project-turns-verification.md`

**Interfaces:**
- Consumes: Task 11 已经绿的 HuaAnWork 包测试。
- Produces: 三条 root 命令的真实 exit code。未执行的命令保持「未执行」，不得预写通过。

- [ ] **Step 1: 串行运行 root 测试**

不要同时跑 `corepack yarn check` 或其他含 `verify:aa` 的命令。

Run:

```bash
corepack yarn test
```

记录 exit code、汇总行，以及失败用例的完整名称。非零则停止，不进入 Step 2。

- [ ] **Step 2: 串行运行 root 类型检查**

Run:

```bash
corepack yarn typecheck
```

记录 exit code。失败全文留在证据里，不摘成「类型有问题」。

- [ ] **Step 3: 串行运行完整 headless 门禁**

Run:

```bash
corepack yarn check
```

记录 exit code、停在哪一个 script、以及该 script 的尾部错误。npm、网络、market 或 Agents Anywhere 的环境失败不要改写成功能测试通过，也不要为此改产品代码。

- [ ] **Step 4: 更新证据里的 root 段**

用 Step 1–3 的真实结果替换 Task 11 写下的「尚未执行」。保留 Task 11 的条款表。仍写明图形走查还没有做。

核对：

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exit 0。

- [ ] **Step 5: 条件式提交证据**

仅当用户明确要求提交时执行。这次提交只含证据文件。

```bash
git add docs/evidence/2026-11-03-concurrent-project-turns-verification.md
git commit -m "docs: record concurrent project turn gate results"
```

---

### Task 13: 场景走查

**Files:**
- Modify: `docs/evidence/2026-11-03-concurrent-project-turns-verification.md`

**Interfaces:**
- Consumes: Task 12 的门禁结果。门禁失败时仍可记录走查，但证据结论写「门禁未过」，不写「可以发布」。
- Produces: 每条场景一个结果：`真实 UI`、`headless 已覆盖` 或 `未验收`。未启动图形界面时，走查项全部是 `未验收`。

- [ ] **Step 1: 没有明确同意就不要启动应用**

只有用户明确同意图形启动后才执行：

```bash
corepack yarn dev
```

未同意时，本任务在证据里把 Step 2–4 全部标为 `未验收`，然后停。不要用 Task 11 的 Vitest 结果填这些格子。

- [ ] **Step 2: 两个项目同时写，前台切换不带走后台目录**

准备两个已登记项目目录，里面各放一个空文件 `a.txt`、`b.txt`。

1. 在项目 A 发送「把 a.txt 改成 A」。生成开始后，文件树仍停在 A 时，打开项目 B。
2. 在项目 B 发送「把 b.txt 改成 B」。A 的回合还没结束时，B 的标签已经出现自己的执行状态，输入框是空的。
3. 回到 A。A 的差异或文件变化仍是 `a.txt`，不能变成 `b.txt`。B 的标签不被 A 的差异覆盖。
4. 两边都结束后，`a.txt` 只在 A 的目录里变化，`b.txt` 只在 B 的目录里变化。

任一步失败就停，把看到的标签文案、当前项目名和两个文件的内容写入证据。

- [ ] **Step 3: 同根排队、停止和等待项**

1. 项目 A 的第一条仍在执行时，再发第二条。第二条显示「等待当前任务」，输入框被清空，可以继续打字。
2. 停止第一条。第二条在第一条真正结束后才开始。停止按下的瞬间，第二条不得已经开始改文件。
3. 第一条执行中、第二条等待时，只取消第二条。第一条继续跑，第二条从列表消失。
4. 把「同时进行的任务数」改成 1。已经在跑的回合不被取消；此时再开项目 B 的发送，B 显示等待。改回 3 后，B 在有空额时开始，且不需要重新输入。

- [ ] **Step 4: 模型、自动化和未绑定项目**

1. 给 A、B 各选一个已保存列表里的不同模型。发送后，把设置里的当前模型改成第三个。A 和 B 已开始的回合仍用各自选中的模型；证据记下两侧请求或界面上显示的模型名。
2. 删掉 A 正在排队的那条所绑定的模型。轮到它时，A 的标签显示失败原因。B 若根空闲且名额够，仍能开始。
3. 项目 A 上有一条会调用模型的到期自动化，同时 A 里有用户回合。自动化不开始，也不在超过 10 分钟后变成错过或被停用。项目 B 在名额允许时仍能手动跑自己的自动化，前台项目名不因此从 A 跳到 B。
4. 未绑定项目的会话里，若工具路径指向项目 A 的文件，结果文件出现在中立工作区，不出现在 A。

- [ ] **Step 5: 把每条写成证据，并条件式提交**

证据里 Step 2–4 的每一条都有结果标签、实际看到的文案和文件结果。做不到的条目标 `未验收` 并写原因。不要把 Task 11 或 Task 12 的通过抄进这些格子。

仅当用户明确要求提交时：

```bash
git add docs/evidence/2026-11-03-concurrent-project-turns-verification.md
git commit -m "docs: record concurrent project turn scenario acceptance"
```
