# 《多项目并发任务》规格评审意见

- **评审对象**：`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`（含 Kimi 写入的 §4.2.1、§5.1.1、§5.2.1、§5.3.1、§5.5）
- **评审日期**：2026-11-03；修订复审同日
- **评审方式**：对照华安宿主与上游 agent-loop 的当前源码复核。本文件只记录评审意见，不修改设计稿，也不修改实现
- **评审结论**：**ITERATE（有条件通过）**。Kimi 补上的跨根调度、会话根推导、模型传递和无人值守 Map，方向与现有代码一致，可以留在规格里。§5.5 的释放时序、恢复准入、队列重入，以及只删 `cross` 却留下的全局调度门，会在实施时把写者名额提前交还，或让其他项目的自动化仍然全部停住。批准进入实施计划之前，须先把下面的 P1 写进规格
- **修订复审**：上一轮 P1-1 至 P1-5、P2-1 至 P2-3 已写入规格，补法与本文件第二节、第三节一致。复审又发现两处规格仍未写死的时序，见 §五。这两句补进规格之前，不进入实施计划

## 一、复核后维持的修订

| 修订 | 处置 | 复核要点 |
| --- | --- | --- |
| §4.2.1 删除 `automationRootDecision` 的 `cross` | **维持** | `cross` 的唯一判据是目标根不等于 `routeCtx.workspaceRoot.current`（`automations-host.ts:212-228`）。手动运行会先 `openWorkspace` 把前台拽到目标项目，再要求判定为 `same`（`routes.ts:1177-1195`）。方案 2 的前台根不再代表后台任务的沙箱根，这条门应删除。手动触发改为对目标根做准入，不再先切换前台 |
| §5.1.1 用任务绑定和会话 id 前缀推导可写根 | **维持**，补一个边界 | `sessionIdFor` 是 `huaanwork-` 加根路径 SHA-256 的前 16 位十六进制。`freshSessionIdFor` 是这个稳定 id 再加 `-` 和 8 位随机后缀（`session-id.ts:5-11`）。前缀匹配成立，但必须是「整个稳定 id」或「稳定 id 加 `-`」，不能拿更短的哈希片段去比 |
| §5.2.1 用 `GenerateOptions.sessionId` 传递模型绑定 | **维持** | `GenerateOptions` 已有 `sessionId`（`deepseek-harness/packages/llm/llm/src/types.ts:564`）。agent-loop 组请求时写入 `sessionId: this.session.id`（`deepseek-harness/packages/core/agent-loop/src/agent.ts:700`）。宿主持有 `sessionId → modelId`，适配器只读这张表，不必改上游 |
| §5.3.1 `huaanworkUnattended` 改为按会话的 Map | **维持** | `runAgentTurn` 现在写入单独一格 `holder.current`，`finally` 里再清掉（`automations-host.ts:289-296`、`:338`）。两条自动化会互相覆盖。`automationRunSessionId` 是 `huaanwork-auto-<automationId>-<runId>`（`automation-session-ids.ts:7-8`），每次运行都不同，可以当 Map 键 |
| §5.3.1 拆除 `automationTail`，脚本槽保留 | **维持**，条件见 P1-4 | `automationTail` 把全部 agent 自动化串成一条链，并发恒 1（`automations-host.ts:36`、`:104`、`:693-705`）。脚本走上限 2 的槽位池，不占这条链（`:709-718`）。不同项目根并行之后，全局链应拆除；同根互斥改由写者名额负责。脚本槽可以保留，获取槽位前仍要先拿到该根的写者名额 |
| §5.5 用回合调度器替换 `sessionSendBlockers` | **维持方向** | 今天 `session.send` / `session.cancel` 用全局 `assertSessionSendable`（`sessions.ts:582-589`）。按根和名额准入是对的。接口里的占坑与释放时序按 P1-1、P1-2、P1-3 改，不按现在的映射表实施 |

## 二、必须先写进规格的修正

### P1-1 写者名额要在回合结束时释放，不能在 `session.send` 返回时释放（§5.5）

§5.5 的映射把 `sessionSend` 写成 `admitUserTurn` → `sendToAgent` → `release`。`sendToAgent` 在 `followup` 被受理后就返回。自动化自己的注释写明了这一点，并在返回之后再 `await whenIdle()` 才算整轮结束（`automations-host.ts:297-301`）。

按这张映射，工具还在写文件时写者名额已经交还，同根的下一条会启动。现有 agent 自动化是在整次 `runBound` 的 promise 结束时才把 `agentAutomationActive` 减回去（`automations-host.ts:697-704`），不是在入队函数返回时减。

规格要改成：

- `admit` 成功后调用 `followup`。
- `followup` 之前就失败：立刻 `release`，不留下写者。
- `followup` 已受理：保持写者，直到该会话回合结束（`whenIdle` 完成，或等价的 `session/end`）再 `release`。
- 用户队列和会调用模型的自动化都用这个时序。脚本自动化在脚本进程结束时释放写者名额。

### P1-2 `session.cancel` 不能立刻 `release`（§5.5）

§5.5 把 `sessionCancel` 写成 `release(sessionId)` 加 `cancelQueued(sessionId)`。`sessionCancel` 今天调用的是 `cancelAgent`（`sessions.ts:587-589`），它发出取消，并不等待文件写入停止。

立刻 `release` 会在取消尚未停稳时启动同根的下一条。等待项的移除可以留在取消请求里。执行中回合的写者名额仍按 P1-1，等这轮结束再释放。

同一会话上可以既有正在执行的回合，又有后来排上的消息。`cancelQueued(sessionId)` 会删掉该会话的全部等待项。规格 §4.2 允许等待时再发下一条，也允许单独取消某一条等待。这两句要合成一条：等待项有自己的 id；取消某一条等待只移除那个 id；停止正在执行的回合不顺带删掉尚未取消的等待项，除非用户明确取消的是整条标签上的全部等待。

### P1-3 恢复历史会话不占写者名额（§5.5）

§5.5 让 `sessionResume` 删除 `assertAutomationIdle` 之后改走 `admitUserTurn`。`sessionResume` 今天只按会话 id 把持久化日志恢复成 live agent（`sessions.ts:618-630`），不发送用户消息。`admitUserTurn` 的入参还要求 `text` 和 `modelId`，并在成功时占用 `activeTurns` 和该根的写者。

恢复不应占用并发名额，也不应占用写者。它只去掉「必须先等全局自动化空闲」。名额和写者从这名用户的下一次 `session.send` 开始占用。恢复时仍然要校验持久化 `cwd` 落在该会话的可写根内；校验失败保持 §6 的拒绝，不启动回合。

### P1-4 扫描队列不能再调用 `admitUserTurn`（§5.5）

`admitUserTurn` 在根忙或名额满时会把一项再追加进 `queue`。`drainQueue` 又写「对合格项执行 `admitUserTurn`」。对已经在队列里的项再调用一次，要么重复入队，要么在项还留在队列里时再占一个名额。

扫描应先按入队时间选出合格项，把它从队列取出，再写入 `rootWriters` 并增加 `activeTurns`，然后启动。启动前失败则按 P1-1 释放，并继续扫描其余项。

### P1-5 只删 `cross` 以后，调度器仍会因为前台对话停掉所有项目（§4.2.1、§5.5）

§4.2.1 删除了 `cross`，并说到期自动化由回合调度器按根判定。当前 tick 在此之前还有两道全局门：

- `sessionSendBlockers.agentAutomationQueued > 0` 时整次 tick 返回（`automation-scheduler.ts:111`）。
- `agentIdle` 为假时返回，或在分组入队前 `break`（`:112`、`:197-200`）。`agentIdle` 只看 `sessionIdFor(当前前台根)` 那一个通道代理（`automations-host.ts:191-194`）。

因此只要前台会话不空闲，或者其他任意项目上已有一条 agent 自动化在排队，其余项目的到期任务都不会被评估。`cross` 分支删掉之后，这两道门仍在。

规格要补上：

- tick 不再因「有任意 agent 自动化在排队」或「前台通道代理不空闲」而整次返回。
- 每条到期自动化单独做 `admitAutomation`。根忙或名额满时返回跳过，不记为失败运行，也不推进 `nextRunAt`，保持到期，留给后续 tick。
- 跳过不进入用户消息队列。用户队列重新扫描时可以再评估一次已到期且尚未开始的自动化，但不能替代调度 tick 自己的重试。

## 三、应一并写清的缺口

### P2-1 等待消息的输入框有两种读法（§4.2、§5.4）

§4.2 规定该条用户消息出现在标签里，输入框清空，用户可以再写下一条。§5.4 仍写「输入保留为已提交状态」。两句都能实现，验收对不上。

以 §4.2 为准，并改 §5.4：等待中的是已经进入标签的那条消息；输入框清空；再输入的是另一条队列项。

### P2-2 认不出会话 id 时，不能先于 `header.cwd` 落回中立工作区（§5.1.1）

§5.1.1 的第三步是任务绑定和稳定 id 都未命中时返回中立工作区。新鲜会话的 id 能被第二步认到。任务绑定丢失、但会话日志 `header.cwd` 仍在某个项目根之内的历史会话，会被收进中立工作区；随后 §5.1 又因 `cwd` 不在中立根内而拒绝恢复。

第三步之前增加：若 `header.cwd` 位于且仅位于一个 `projects.json` 项目根之内，可写根取该项目根。都不位于时才用中立工作区。

### P2-3 网络门禁在后续请求里也要使用绑定模型的地址（§5.2.1）

§5.2.1 把网络门禁改到 `sendToAgent` 准入，并写「不再读全局 `settings.base_url`」。准入时按绑定条目的 `base_url` 判断是对的。目标续轮和子代理的请求发生在准入之后，`stream` 仍会发起新的完成请求。

`stream` 选择绑定条目的同时，用这次实际要请求的 `base_url` 再做一次网络门禁。不要只在准入时查一次，也不要让后续请求退回全局 `active_model_id` 的地址。模型条目在回合进行中被改掉地址时，下一次请求按改后的地址判断；不允许则该次请求失败并写回该会话，不改打全局模型。

## 四、不在本轮改的范围

以下句子复核后不需要因本次评审改写：并发上限 1–8、缺省 3；同一项目根一个写者，子目录不另算一根；前台切换不调用 `pinWorkspace`；子代理不另占名额并沿用父会话模型；越界路径收回到该会话自己的可写根；不做 worktree、多 Host、云端任务，也不恢复 Run Coordinator。

## 五、修订复审仍须写进规格的两句

上一轮 P1、P2 的正文已经落在设计稿里。下面两句是对照修订稿和现有调度、客户端超时之后新看到的，尚未写进设计稿。

### P1-6 `session.send` 的应答不要等 `whenIdle`（§5.5）

§5.5 的映射把用户发送写成 `admitUserTurn` → `sendToAgent` → `whenIdle` → `release`。释放放在 `whenIdle` 之后是对的。这条链没有分开「应答返回」和「稍后释放」。

客户端把 `session.send` 标成一次最长 30 分钟的调用（`api.ts` 的 `LONG_RUNNING_METHODS` 与 `LONG_REQUEST_TIMEOUT_MS`）。排队结果必须马上回到界面，标签才能显示「等待当前任务」并清空输入框。回合停在审批上时，这条应答也不能一直挂到批准或超时。

规格要补的一句是：`session.send` 的应答在「已开始」或「已排队」时返回；`whenIdle` 之后的 `release` 是应答发出之后的延续，不把应答推迟到回合结束。

### P1-7 因根忙或名额满而跳过的自动化，不能掉进 10 分钟错过宽限（§4.2.1）

§4.2.1 规定跳过不记为失败运行，也不推进 `nextRunAt`，保持到期留给后续 tick。现有到期窗口不是无限的。`dueAutomations` 只收录 `nextRunAt` 之后 10 分钟内的任务；超过 `MISSED_GRACE_MS`（`automations-store.ts:34`，10 分钟）就进入 `missedAutomations`，记一条 missed，一次性任务还会被停用。

用户回合和同根自动化都可以超过 10 分钟。只写「不推进 `nextRunAt`」时，跳过等待仍会在宽限结束后被记成错过。

规格要补的一句是：因根上已有写者或并发名额已满而跳过的到期项，在被跳过期间不得记成 missed，也不得停用；10 分钟错过宽限只用于调度器根本没有评估到的到期项。跳过项保持可被后续 tick 再次准入。
