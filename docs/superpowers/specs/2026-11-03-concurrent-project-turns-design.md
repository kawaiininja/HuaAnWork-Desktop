# 多项目并发任务设计

- 日期：2026-11-03
- 状态：待评审
- 实施边界：仅 `dsh-plugin-huaanwork/`。不改 `deepseek-harness/`，不恢复已退役的多桌面树。

## 1. 背景与目标

华安工作台可以登记多个项目，每个项目下可以有多条子任务。发送却被一个全局 `turnActive` 挡住：任一用户回合进行中，再发一条会直接返回。沙箱根也是进程里的一个值，落在当前打开目录之外的路径会被收回到这个目录。因此第二个任务既发不出去，也不能在另一个项目目录里安全地写文件。

本设计让已登记的不同项目可以同时各跑一个可写任务。用户能配置同时进行的任务数，也能给每个任务选定已保存列表里的模型。

## 2. 已确认的产品选择

| 决策点 | 已确认方案 |
| --- | --- |
| 第一期范围 | 直接做会话自带目录、同一 Host 内有限并发。不做「只排队、全局仍一个执行槽」的过渡版 |
| 并发上限 | 设置项 `max_concurrent_turns`，整数，允许 1–8，缺省 3 |
| 模型 | 每个任务从已保存的模型列表绑定一个模型。不同任务可以绑定不同模型 |
| 同一目录 | 同一项目根同时只有一个可写回合。第二个写任务可见排队，结束后自动开始 |
| 前台项目 | 切换前台只改变正在查看的目录，不改变其他会话的沙箱根 |
| 隔离方式 | 以 `projects.json` 里的项目根隔离。本版不做 Git worktree，不做一项目多 Host |

## 3. 范围与非目标

### 范围内

- 不同项目根上的用户回合并行执行，受 `max_concurrent_turns` 约束。
- 同一项目根、中立工作区根上的后续可写回合排队，并在根空闲且名额够时自动开始。
- 排队项记录目标目录和模型，执行时使用这两项记录。
- 任务绑定模型，生成请求使用该绑定，不读取之后变更的全局 `active_model_id`。
- 设置页可改并发上限。任务发送处可改该任务的模型。
- 审批、停止、差异视图按会话归属，停止只作用于被停止的那一条。
- 自动化按项目根互斥。会调用模型的自动化占用一个并发名额。

### 非目标

- 不打开 `jobs`、`hmr`、`tool-jobs`、`run_in_background`。
- 不做 Git worktree，不做合并界面。没有 `.git` 的目录不提供隔离检出。
- 不做每个窗口一个 Host，不放开 Electron 单实例锁。
- 不把任务送到云端虚拟机或公网代理。
- 不恢复 2026-10-18《对话编排》里的 Run Coordinator、动作账本和执行租约。
- 不把子代理计成独立任务。子代理仍挂在父回合上。
- 不新增模型供应商，不在任务上单独编辑接口地址或密钥。
- 不把同一项目下的两个子目录算成两个可写根。
- 第一期不做「只读追问不占名额」。同一项目上的后续发送都进入该根的队列。

## 4. 行为

### 4.1 谁可以同时写

可写根只有两类：

1. `projects.json` 中某个项目的 `root`。
2. 该 profile 的中立工作区（profile 目录下的 `workspace`）。未绑定项目的会话使用这一根。

一条会话的可写根是它所属项目的 `root`。未绑定项目时，可写根是中立工作区。会话的 `cwd` 必须落在自己的可写根之内。同一项目下的子目录共用该项目根的一个写者名额。

同时处于执行中的用户回合加上会调用模型的自动化，总数不超过当时生效的 `max_concurrent_turns`。子代理不另占名额，沿用父回合已经占用的名额和模型绑定。

同一可写根上最多一个写者。写者包括：正在执行的用户回合，以及目标根是该可写根的任何自动化（含脚本自动化）。脚本自动化不占用 `max_concurrent_turns`，只占用该根的写者名额。会调用模型的自动化两项都占。

### 4.2 发送与排队

用户在某个标签发送时，宿主先做准入，再决定立即执行或排队。

立即执行的条件同时满足：

- 该会话的可写根当前没有写者。
- 执行中的占名额回合数小于 `max_concurrent_turns`。
- 本次指定的 `modelId` 存在于模型列表。

否则本次进入宿主内存队列，该条用户消息出现在标签里并显示「等待当前任务」，输入框清空。消息不丢，也不写入另一个项目的目录。用户可以在同一标签继续写下一条，下一条单独准入。

队列项保存：会话 id、标签 id、用户文本、可写根、`modelId`、入队时间，以及本次请求里的可选 `skill` 与 `at`（`name`、`clientMessageId`）。轮到执行时使用项内的根、模型和这两项，原样交给 `sendToAgent`，不把 `skill` / `at` 折回文本。前台当时打开哪个项目、全局当时选中哪个模型，都不改变这项记录。

准入顺序：按入队时间从早到晚扫描。根上已有写者的项跳过，留在队列中。这样项目 A 的第二条不会挡住项目 B 的第一条。根空闲且名额足够时，启动扫描到的第一项，然后重新扫描，直到没有可启动项或名额用尽。

等待中的项可以单独取消。取消只移除该项，不停止已经在执行的回合。

进程退出后内存队列消失。重启不自动补跑尚未 `followup` 的等待项。已经在执行的回合仍按现有 Host 生命周期结束，本设计不新增崩溃续跑。

会调用模型的自动化不进入这条用户消息队列。它在现有调度器真正启动该次回合之前做同一次准入。根上已有写者或名额已满时，这次不开始、不记为失败运行。用户队列重新扫描时，顺带让调度器再评估一次已经到期且尚未开始的自动化。脚本自动化只检查该根的写者名额，不检查 `max_concurrent_turns`。

#### 4.2.1 调度器跨根逻辑修订

`automationRootDecision` 的 `cross` 分支（目标根 ≠ 当前前台根即跳过）删除。调度触发时只做两项检查：

1. 项目是否仍存在（`missing-project` 保留）。
2. 目标根是否有写者、并发名额是否足够（由回合调度器统一判定，见 §5.5）。

同时删除调度 tick 上的两道全局门：

- `sessionSendBlockers.agentAutomationQueued > 0` 时整次 tick 返回（`automation-scheduler.ts:111`）——删除。
- `agentIdle(routeCtx)` 为假时整次 tick 返回、或在分组入队前 `break`（`:112`、`:197-200`）——删除。`agentIdle` 只看 `sessionIdFor(当前前台根)` 的通道代理（`automations-host.ts:191-194`），与按根并行的目标矛盾。

每条到期自动化单独做 `admitAutomation`。根忙或名额满时返回跳过，不记为失败运行，也不推进 `nextRunAt`，保持到期，留给后续 tick。跳过不进入用户消息队列；用户队列重新扫描时可以再评估一次已到期且尚未开始的自动化，但不能替代调度 tick 自己的重试。

**跳过项不得掉进 10 分钟错过宽限**：因根上已有写者或并发名额已满而跳过的到期项，在被跳过期间不得记成 missed，也不得停用。`MISSED_GRACE_MS`（10 分钟）只用于调度器根本没有评估到的到期项。跳过项保持可被后续 tick 再次准入，直到成功启动或任务被删除。

手动触发（`manual`）不再要求「先切换到该项目」，改为直接对目标根做准入。用户可以在项目 A 的界面手动触发项目 B 的自动化，只要 B 的根空闲且名额够。

### 4.3 前台根

`workspaceRoot.current` 只表示界面正在查看的目录。文件树、项目高亮和「当前项目」读它。

发送、恢复和沙箱解析读会话自己的可写根。后台会话开始执行时，不调用 `pinWorkspace` 去改前台根。用户切换前台项目时，已在执行或等待的会话保持原来的可写根。

### 4.4 模型绑定

模型列表和全局 `active_model_id` 保持现有含义。`active_model_id` 是新任务的默认选择。

每个子任务可以保存 `modelId`。已有 `tasks.json` 没有该字段时，发送时默认取当时的 `active_model_id`，并把这次选择写回任务。未绑定子任务的标签把选择留在标签状态里，随 `session.send` 交给宿主。

宿主为每个已接受的会话记录 `modelId`。该会话后续的生成请求，包括目标续轮和它的子代理，都使用这条记录。用户改全局当前模型，或改设置里的其他条目，不改已经绑定的会话。

会调用模型的自动化在开始时绑定当时的全局 `active_model_id`，并在该次运行期间保持这个绑定。

`modelId` 必须是模型列表中的 `id`。列表中找不到时，这次发送失败并在该标签显示原因，不回落到全局模型，也不改去打另一个端点。条目在排队期间被删掉时，轮到该项就按同样方式失败，并继续扫描队列里的其他项。

两个任务可以绑定同一个模型。并发名额按回合计，不按模型再拆一份额度。

### 4.5 并发上限的读写

设置键是 `max_concurrent_turns`，放在现有 `huaanwork-settings.json`，经现有 `settings` 读写路径更新。

| 输入 | 生效值 |
| --- | --- |
| 缺省、缺失、非整数、非有限数 | 3 |
| 整数小于 1 | 1 |
| 整数大于 8 | 8 |
| 1 到 8 的整数 | 该整数 |

用户保存该设置时，文件里写下生效值。读取时按上表解释，不因为文件里留有旧的越界值就在读取过程中改写文件。设置页的模型区提供数字输入，标签为「同时进行的任务数」，可选范围 1–8。

每次准入时读取当前生效值。把上限调低不取消已经在执行的回合。已超出新上限的回合跑完为止，在执行数降到新上限之下之前，队列不再启动新项。

### 4.6 停止、审批和差异

停止按钮只取消该标签对应会话及其子代理。其他标签的执行和等待不受影响。

同一会话上一条还在执行时再发一条，新的一条只进入等待。等待期间不推进该标签的回合 epoch，也不发出 `turn-started`。epoch 和 `turn-started` 留到这条真正开始：直接应答 `started: true`，或稍后的 `session/queue-start`。epoch 按标签存放，另一个标签开始回合不改变这一标签的停止票据。目标结算仍按 `sessionId` 记在 `GoalTurnState` 里，只是下一回合的开窗要等它真正开始，避免清掉上一回合的 `settled` / `suppressed`。

排队和 `started:false` 不得清除正在执行回合的停止闩锁、`stopping` 或既有进度。`goal/round` 只恢复事件所属标签的 `running`；目标相位仍为 `active` 的中间 `session/end` 不清执行态、不撤停止按钮，非 active 的真正终局才清理。`consumeStaleIdle`、停止票据的构造与结算都只读取事件所属标签的 epoch，不用另一标签的当前值判定旧结束。

fetch 应答与 WebSocket 事件不保证先后。客户端在 RPC 前以 `tabId + 本地 userMsg.id` 建 pending 记录，pending 本身不开目标窗。直接发送尚未应答时，若没有正在执行的同会话回合，早到的 `session/end` 与 goal 事件进入本次缓冲；若上一回合仍执行，它的事件必须即时处理。未知 queueItemId 的早到 `session/queue-start` / `session/queue-fail` 也进入本次缓冲，已能匹配其他等待消息的事件不得被扣住。应答先写回 started/queueItemId，再初始化对应回合并按原顺序重放；`started:false` 只丢弃本次缓冲。`agent/notice` 不缓冲。

审批卡继续按 `approvalRequestId` 回写到持有该卡的标签。回答一条卡不会提交到另一条会话。

带 `sessionId` 的差异事件只记入该会话的标签。没有 `sessionId` 时，仅当占名额的执行中回合恰好一个，记入那个标签；同时有多个时不记入任何标签，并写一条宿主日志。当前标签只显示自己已记下的差异。

## 5. 架构

仍是一个 Electron 进程、一个 Host。并行单位是宿主里的多个 agent 实例，隔离单位是会话的可写根。

```text
设置 max_concurrent_turns、模型列表
        │
标签发送 ──► 宿主准入
              ├─ 根空闲且名额够 ──► 该会话 followup（使用项内的根与 modelId）
              └─ 否则进入内存队列，标签显示「等待当前任务」
                        │
              某回合结束或等待项被取消
                        │
                        └─ 重新扫描队列并启动所有当时合格的项

沙箱解析：请求路径在该会话可写根内则使用该路径，否则收回到该会话自己的可写根
```

### 5.1 沙箱

`sandbox-cwd.ts` 的夹紧规则改为按会话可写根判断。

- 会话已绑定项目，且请求路径在该项目 `root` 之内：使用请求路径。
- 会话已绑定项目，请求路径在该项目 `root` 之外：收回到该项目 `root`。
- 会话未绑定项目，请求路径在中立工作区之内：使用请求路径。
- 会话未绑定项目，请求路径不在中立工作区之内：收回到中立工作区。
- 任何会话的越界路径都收回到它自己的可写根，不收回到前台正在查看的其他项目。

`sessions.ts` 恢复持久化会话时，比较的是持久化 `cwd` 与该会话的可写根，不再要求它等于前台根。`cwd` 不在自己的可写根内时拒绝恢复，并说明要打开对应项目。

#### 5.1.1 可写根推导

新增 `writableRootForSession(routeCtx, sessionId): Promise<string>`，推导顺序：

1. **任务绑定**：查 `tasks.json`，若某 `task.sessionId === sessionId`，则查 `projects.json` 得 `project.root`，返回该根。
2. **通道默认会话**：若 `sessionId` 等于某项目 `sessionIdFor(project.root)` 或 `sessionIdFor(neutralWorkspaceRoot)`，返回对应根。匹配必须是「整个稳定 id」或「稳定 id 加 `-` 前缀」，不能拿更短的哈希片段去比。
3. **持久化 `cwd` 回退**：若会话日志 `header.cwd` 位于且仅位于一个 `projects.json` 项目根之内，可写根取该项目根。这一步兜住任务绑定丢失但 `cwd` 仍有效的历史会话，避免它们被错误收进中立工作区后拒绝恢复。
4. **中立回落**：以上均未命中，返回 `neutralWorkspaceRoot(profileDir)`。

推导结果在 `sendToAgent` 准入时计算一次，随队列项保存，执行时不再重新推导。`ensureChannelAgent` 接收准入时冻结的根作为参数；没有准入的 `sessionResume` 由 `ensureChannelAgent` 在内部按同一顺序推导。两者都不读 `routeCtx.workspaceRoot.current`。

`ctx.huaanworkSessionRoots` 的登记不随模型表推迟：它必须在 `agents.create` / `agents.resume` 之前写入，供会话创建和沙箱夹紧使用；项目级 Agent 自动化在 `sendToAgent` 前写入已知目标根。没调用 `followup` 的早退不改变这条根规则——已经为创建/恢复登记的真实根保持有效，不删除、不改回前台；自动化的根键与模型键在回合真正 settle 时删除，drain 到期只停止等待、不删除工具仍可读到的绑定，`sessionRemove` 与 `subagent/end` 按各自规则清理。

会话日志的 `header.cwd` 在创建时写入推导根，恢复时校验 `cwd` 在该根之内（`isInside` 检查，非严格相等）。

### 5.2 生成请求

`model.ts` 的 `stream` 按发起请求的会话读取宿主记录的 `modelId`，再取该条目的 `base_url`、`model`、`api_key`。没有会话记录的调用维持现有行为，读取全局 `active_model_id`。网络门禁继续按这次实际使用的 `base_url` 判断。

`ensureChannelAgent` 里的 `model: 'local'` 只作为适配器占位。真正的端点和模型名以会话绑定为准，避免两条会话在续轮时一起读到后来的全局选择。

#### 5.2.1 模型绑定的传递通道

上游 `GenerateOptions` 已包含 `sessionId` 字段（`deepseek-harness/packages/llm/llm/src/types.ts:564`），且 agent-loop 在 `buildRequest` 中写入 `sessionId: this.session.id`（`agent.ts:700`）。`PreparedLlmCall.stream` 与 `LlmRuntime.stream` 均透传完整 `GenerateOptions`，因此 `HuaAnWorkAdapter.stream(options)` 可直接读取 `options.sessionId`，无需修改上游。

宿主侧新增 `ctx.huaanworkSessionModels: Map<string, string>`（`sessionId → modelId`），在 `followup` 受理后写入，会话结束或删除时清除。没调用 `followup` 就返回时不写入，也不删除这次发送之前已经存在的模型键。这个受理后规则只适用于模型表；可写根的登记时点见 §5.1.1，不把根表一并推迟。会调用模型的自动化在 `runAgentTurn` 开始时保存当时的 `activeModelId` 并显式传给 `sendToAgent`，由后者在受理后绑定，不预写模型表，也不读取之后的全局选择。`HuaAnWorkAdapter` 的 `apply(ctx)` 读取该 Map 引用。

`stream` 中的读取顺序：

1. `options.sessionId` 存在且 `huaanworkSessionModels` 中有记录：使用该 `modelId` 查 `models` 列表，取 `base_url`、`model`、`api_key`。
2. 无记录（如一次性调用 `session-title`、通道默认会话未绑定）：维持现有行为，读全局 `active_model_id`。
3. `modelId` 在 `models` 列表中已不存在：按 §4.4 失败处理，不回落到全局模型。

网络门禁在 `sendToAgent` 准入时即按本次选定的 `modelId` 对应的 `base_url` 判断，不再读全局 `settings.base_url`。

`stream` 选择绑定条目的同时，用这次实际要请求的 `base_url` 再做一次网络门禁。目标续轮和子代理的请求发生在准入之后，模型条目在回合进行中被改掉地址时，下一次请求按改后的地址判断；不允许则该次请求失败并写回该会话，不改打全局模型。

### 5.3 单槽状态

以下状态今天是进程内一格，并发后必须按会话分开：

- `huaanworkRouteAgent`：工具路由只使用本次执行上下文里的 agent。上下文没有 agent 时，这次工具调用失败并写回该会话，不读取全局那一格。
- `huaanworkUnattended`：按会话保存无人值守范围。判定某次输入或护栏时只查该会话自己的记录。
- 客户端 `turnActive`：改为每个标签一份执行状态。全局只保留「执行中的占名额回合数」和队列，用来做准入。
- 右侧 diff：按标签保存。

`agentAutomationActive` 不再拒绝所有 `session.send`。它按可写根计入该根的写者。另一根上的发送只要名额够就可以开始。

#### 5.3.1 自动化并发与无人值守隔离

`automationTail` 串行链（`automations-host.ts:104`）拆除，agent 自动化改为经回合调度器按根并行。脚本自动化保留现有槽位池（上限 2），但槽位获取前需先经调度器检查该根写者名额。

`huaanworkUnattended` 从 `{ current: UnattendedScope | null }` 改为 `Map<string, UnattendedScope>`（`sessionId → scope`）：

- `runAgentTurn` 启动时：`unattendedMap.set(sessionId, { runId, automationId, allow, sessionId })`。
- `runAgentTurn` 结束（`finally`）：`unattendedMap.delete(sessionId)`。
- `route-tool-plugin.ts` 的 `waitForInput`：`unattendedMap.get(sessionId)`，命中即拒绝。
- `question-answerer.ts` 的审批降级：`unattendedMap.get(sessionId)`，命中按白名单降级。

每个自动化运行的 `sessionId` 由 `automationRunSessionId(automation.id, runId)` 生成，天然唯一，因此 Map 键不会冲突。

### 5.4 界面

- 并发已满，或该根已有写者：该条用户消息出现在标签里并显示「等待当前任务」，输入框清空。客户端可以先按本地消息 id 插入用户消息，但必须在 `session.send` 应答后把 `queueItemId` 写回同一条已插入消息；只更新标签级 `waitingIds` 不算完成。等待中的是已经进入标签的那条消息；再输入的是另一条队列项。用户可以切换到其他标签。这条等待不把标签标成执行中，也不打开新的目标结算窗。
- 等待中的标签可以取消等待。
- 执行中的标签显示自己的进度，并可以停止自己。直接应答 `started: false` 时不进入这个状态。创建取消和更新失败提示仍只显示原来的 `agent/notice`。
- 出队真正开始时发 `session/queue-start`，这时才把该条等待消息变成活动回合。若 queue-start 早于 waiting 应答到达，先进入本次 pending；应答写回 queueItemId 后才重放启动，不能提前清等待或开窗。出队后没开始则发 `session/queue-fail`，只去掉这条等待，不结束同一标签上仍在执行的回合。若失败原因已经由同一句 `agent/notice` 展示，queue-fail 不重复插入相同文案；没有 notice 的复检失败仍显示 `reason`。
- 任务使用的模型在该任务的发送区选择。新建时带出全局当前模型。
- 设置中的「同时进行的任务数」写入 `max_concurrent_turns`。

### 5.5 回合调度器

新增 `turn-scheduler.ts`，收敛所有准入、排队、释放逻辑，替换现有 `sessionSendBlockers` 全局单例。

#### 数据结构

```typescript
type QueueItem = {
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

type RootWriter = {
  kind: 'user' | 'agent-automation' | 'script-automation'
  sessionId: string
  runId?: string
}

type TurnScheduler = {
  /** 执行中的占名额回合数（用户回合 + 会调用模型的自动化）。 */
  activeTurns: number
  /** 每个可写根的当前写者；无写者时键不存在。 */
  rootWriters: Map<string, RootWriter>
  /** 等待队列，按入队时间排序。 */
  queue: QueueItem[]
}
```

#### 接口

- `admitUserTurn(sessionId, tabId, text, modelId): { kind: 'start'; root: string } | { kind: 'queued'; root: string } | { kind: 'error'; reason: string }`
  - 推导 `root`，检查 `modelId` 在列表中。
  - `rootWriters` 无该根写者且 `activeTurns < maxConcurrentTurns`：写入 `rootWriters`，`activeTurns += 1`，返回 `start`。
  - 否则追加 `queue`，返回 `queued`。
- `admitAutomation(automation, runId): { kind: 'start'; root: string } | { kind: 'skip' }`
  - 推导 `root`（项目根或中立根）。
  - `rootWriters` 无该根写者：
    - `kind === 'agent'` 且 `activeTurns >= maxConcurrentTurns`：返回 `skip`（不记为失败运行）。
    - 否则写入 `rootWriters`（`kind === 'agent'` 时 `activeTurns += 1`），返回 `start`。
  - 有写者：返回 `skip`。
- `release(sessionId): void`
  - 从 `rootWriters` 删除该 `sessionId` 对应的写者，若是占名额类型则 `activeTurns -= 1`。
  - 触发 `drainQueue()`。
  - **调用时机**：必须在回合真正结束后调用（`whenIdle` 完成，或等价的 `session/end`），不能在 `sendToAgent` 返回时调用。`sendToAgent` 在 `followup` 受理后即返回，此时工具可能仍在写文件。
  - **与应答的关系**：`session.send` 的应答在「已开始」「已排队」或「未启动」时立即返回；`whenIdle` 之后的 `release` 是应答发出之后的后台延续，不把应答推迟到回合结束。未启动是 `started: false`：创建取消和更新失败提示已经发出 `agent/notice`，这次没有 `followup`。客户端把 `session.send` 标为最长 30 分钟调用（`api.ts` 的 `LONG_RUNNING_METHODS`），但排队结果、未启动结果和审批卡点都不能让应答挂到超时。
- `cancelQueuedItem(queueItemId): void`
  - 从 `queue` 移除指定 `queueItemId` 的项，不释放已占名额，不影响同会话的其他等待项。
- `drainQueue(): void`
  - 按入队时间扫描 `queue`，跳过 `rootWriters` 仍有写者的项。
  - 对合格项：从 `queue` 取出，写入 `rootWriters`，`activeTurns += 1`，然后启动。启动前失败则立即 `release` 并继续扫描其余项。
  - **不再调用 `admitUserTurn`**，避免重复入队或重复占名额。
- `setMaxConcurrentTurns(n: number): void`
  - 更新上限。若当前 `activeTurns > n`，不取消已有回合，仅阻止新启动。

#### 与现有代码的映射

| 现有位置 | 改动 |
| --- | --- |
| `sessions.ts:83-93` `sessionSendBlockers` | 删除，由 `turn-scheduler.ts` 替代 |
| `sessions.ts:96-111` `assertAutomationIdle` / `assertSessionSendable` | 删除，由 `admitUserTurn` / `admitAutomation` 替代 |
| `automations-host.ts:104` `automationTail` | 拆除串行链，改为 `admitAutomation` 后直接 `executeRun` |
| `automations-host.ts:695-704` `enqueueAgentAutomation` | 改为 `admitAutomation` → `executeRun` → `whenIdle` → `release` |
| `automations-host.ts:709-720` `enqueueScriptAutomation` | 保留槽位池，但先经 `admitAutomation` 检查根写者；脚本进程结束时 `release` |
| `sessions.ts:582-585` `sessionSend` | 改为 `admitUserTurn` → `sendToAgent` → `whenIdle` → `release`；`followup` 前失败或未调用 `followup` 就返回时立即 `release`。创建取消和更新失败提示返回 `started: false`，不变成路由错误 |
| `sessions.ts:587-590` `sessionCancel` | 请求带 `queueItemId` 时只 `cancelQueuedItem`，不调用 `cancelAgent`，不停止正在执行的回合。没有 `queueItemId` 时 `cancelAgent`（发出取消信号，不等待）。两种都**不立刻 `release`**，写者名额仍按 `whenIdle` 后释放 |
| `sessions.ts:618-630` `sessionResume` | 删除 `assertAutomationIdle`；**不走 `admitUserTurn`**，恢复本身不占名额和写者；仍校验 `cwd` 在该会话可写根内 |

## 6. 失败

| 情况 | 结果 |
| --- | --- |
| `modelId` 不在列表中 | 该次发送失败，标签显示原因，队列中的其他项仍可启动 |
| 恢复时 `cwd` 不在该会话可写根内 | 拒绝恢复，提示打开对应项目 |
| 可写根目录已不存在 | 该次不启动，标签显示原因 |
| 准入时设置无法解析 | 按 3 处理 |
| 调低上限时已有更多回合在执行 | 不取消它们；多出来的名额腾出前不启动队列 |
| Host 在队列尚未执行时退出 | 等待项不补跑 |
| 创建取消，或更新目标不存在 | 发出既有 `agent/notice`，应答 `started: false`。不进入执行中，不抛成路由错误。该项若在队列里，出队时发 `session/queue-fail`，不发 `session/queue-start` |

## 7. 测试

至少覆盖：

- 两个不同项目根可以同时执行，且各自的沙箱根保持为自己的项目根。
- 前台从一个项目切到另一个项目后，后台会话的 `cwd` 和后续工具路径不变。
- 同一项目根上的第二个发送进入等待，第一个结束或停止后自动开始，并且写在该项目根内。
- 队列头是忙碌根时，后面的空闲根可以先启动。
- `max_concurrent_turns` 缺省为 3；0 和负数生效为 1；9 及以上生效为 8；非整数生效为 3。
- 上限从 3 调到 1 时，已经在执行的回合继续，新的发送等待。
- 两个任务绑定不同 `modelId` 时，各自的生成请求使用自己的条目。中途修改 `active_model_id` 不改变已绑定会话。
- 绑定了一个已删除的 `modelId` 时，该标签失败，另一项目的合格任务仍能启动。
- 停止一个标签不影响另一个标签的执行。
- 排队或未启动发送不清正在执行回合的停止闩锁；goal active 的中间结束不清 running；旧结束只按事件所属标签的 epoch 判定。
- 应答后把 `queueItemId` 写回已插入的用户消息，前一回合的终态不落到仍在等待的消息上。
- 直接 started 应答前到达的 `session/end` 先缓冲，初始化后重放，最终不被应答覆盖成假运行。
- waiting 应答前到达的 `queue-start` 先缓冲，写回 queueItemId 后重放；pending 发送不得延迟上一回合的事件。
- 后台会话的 diff 不写入当前正在查看的标签。
- 项目 A 的自动化占用 A 的写者名额；项目 B 在名额允许时仍能开始。
- 子代理不使执行中的回合数加一。
- 未绑定项目的会话在工具路径越出中立工作区时，路径收回到中立工作区，不收回到前台项目。
- 创建取消和更新失败都不进入执行中。直接发送与排队出队都不调用 `followup`；排队出队只发 `session/queue-fail`。
- 同一会话上一条还在执行、下一条只是排队时，下一条真正开始之前，上一条的目标暂停标记仍压住结束结论。另一标签开始回合不改变这一标签的停止 epoch。

## 8. 实施注意

改动落在华安插件内的设置、宿主准入、沙箱夹紧、模型适配和客户端标签状态。`profile.ts` 启动时的 `sandbox-policy.workspaceRoot` 仍是默认前台根。会话开始执行后，以该会话的可写根为准。

上游 agent 的 `followup` 已经是每个 agent 实例自己的队列。本设计利用这一点，在华安宿主做准入，不修改 `deepseek-harness/`。
