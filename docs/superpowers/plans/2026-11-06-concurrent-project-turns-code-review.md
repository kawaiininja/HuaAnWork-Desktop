# 《多项目并发任务》实现评审意见（Code Review）

- **评审对象**：`feat/huaanwork-concurrent-project-turns` 分支相对 `master`（`fdcf80422e`）的完整实现
  - **首轮评审范围**：`10b1e35f01`（`feat: enable concurrent turns across project roots`）
  - **二轮复核范围**：`fdcf80422e..f19900eae8`（共 20 个提交：首轮功能提交 `10b1e35f01` + 针对 R-1..R-5 与 P-1..P-4 的 19 个修复提交 `1f968b5acc..f19900eae8`）
- **对照基准**：
  - 设计规格：`docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md`
  - 实施计划：`docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`（含 Global Constraints 与 2026-11-04 / 2026-11-05 修订）
- **评审日期**：2026-11-06（首轮至三轮）；**2026-11-07 Grok 复核**（见 §A）
- **评审方式**：只读核对 `fdcf80422e..f19900eae8` 与当前工作区中的对应源码、测试与文档。未改产品代码。2026-11-07 这一轮只读核对工作区（含未提交改动），未重跑测试
- **最新总结论（2026-11-07 Grok 复核及同日收口，见 §A）**：**达到合并标准（GO）。** 上一轮合并门槛（Important-1 主路径、Important-2、Minor-3）以及 Grok 复核指出的残余项 §A.2（`@` HTTP/MCP 在 live agent 出现前失败还原临时根与模型）和 §A.3 第 1–3 条 Minor（无 live agent 时已登记根防覆盖、立即发送路径传入 `cancelled` 回调、同标签多条排队发送的模型选择交接与回滚）均已在工作区全部修复并补齐回归单测（见 §A.6）。0 Critical / 0 Important / 0 Open Minor。
- **三轮校准结论（`f19900eae8`，见 §0.5，已被 §A 取代）**：**合并前要修 Important-1 的写入时点。** 包内 `@slug` 在根表登记前就按前台目录启动进程，子代理也会在 `followup` 之前复制到旧模型或空根。Important-2 是交付物核对读错目录，会误报「缺少文件」，不会跨项目写文件，且规格 §1 没有二轮引用的那条不变量。Minor-3 就是「名额已满仍提示同根忙」。已有会话不改根是 Important-1 第 4 点，不要用无条件改写根表来修。
- **二轮原文结论（`f19900eae8`，未经 §0.5 校准）**：**暂不建议直接合并（NO-GO — With fixes；0 Critical / 2 Important / 4 Minor）**。首轮 **R-1..R-5** 与 **P-1..P-4** 在主路径上已落地。二轮另列 Important-1、Important-2 与 Minor-1..Minor-4。原文见 §0.2–§0.3 与 §6.1 修订前的合并建议；历史口径以 §0.5 为准，当前口径以 §A 为准。
- **首轮历史结论（`10b1e35f01`）**：**不能合并（NO-GO）**。合并前要修 **2 项必定打破不变量的缺陷（R-1、R-2）**、**1 项条件触发的跨项目写（R-3）** 与 **2 项行为缺口（R-4、R-5）**；P-1..P-4 为可后做项（详见下文历史章节 §一～§六）。

---

## A. 2026-11-07 Grok 复核（工作区，含未提交改动）

只读对照当前工作区源码。不改产品代码，不重跑测试。审查者：Grok。日期：2026-11-07。

范围是 `feat/huaanwork-concurrent-project-turns` 上的实现：已提交区间 `fdcf80422e..f19900eae8`，加上当时工作区里尚未提交的改动（`sessions.ts`、`App.tsx`、`outcomeCheck.ts`、`routes.ts`、`AutomationsView.tsx`、`projects.ts`、`automations-host.ts` 及对应测试和规格/计划）。结论针对这份工作区，不是单独的 `f19900eae8`。只提交现有 commit、不带上这些改动的话，§0.5 的 Important-1 仍然开着。

对照基准仍是 `docs/superpowers/specs/2026-11-03-concurrent-project-turns-design.md` 与 `docs/superpowers/plans/2026-11-03-concurrent-project-turns.md`。本节先按二次核对后的口径写；第一次表述里写重的部分记在 §A.4，不以那一版为准。

### A.1 上一轮合并项

| 条目 | 工作区状态 | 核对 |
| --- | --- | --- |
| Important-1 写入时点 | **主路径已修** | `sessions.ts:239-248` 在 `dispatchAt`（`:280`）之前写入本轮模型和缺席的根。包运行时在 `resolveParent` 之前读 `sessionWorkspaceRoot`。已登记根不覆盖（`:246-248`、`:319-321`）。live agent 的准入根不一致时，`followup` 之前失败（`:366-377`）。`session.send` 已有登记根时不再推导（`:910-913`）。残余见 §A.2 |
| Important-2 交付物目录 | **已修** | `outcomeCheck.ts:192-204`、`App.tsx:1533-1543`：先会话 cwd，再标签项目根；前台是另一个项目时返回空串，不去那棵树里找文件 |
| Minor-1 模型回滚（2026-11-06 编号） | **已修**，残余见 §A.3 第 3 条 | `started: false`、抛错、`queue-fail`、取消等待都会回滚；发送期间改过的选择保留 |
| Minor-2 读 header 时取消 | **排队路径已修**，残余见 §A.3 第 2 条 | 排队项把 `cancelled` 传入 `ensureChannelAgent`（`sessions.ts:844`、`:383`、`:399`） |
| Minor-3 名额已满文案 | **已修** | `routes.ts:1238` 透传 `reason`；`AutomationsView.tsx:176-180` 对 `cap-full` 与同根忙各用一句 |
| R-1..R-5、P-1..P-4 | **仍成立** | 这批未提交改动没有退回这些修复 |

### A.2 残余：`@` HTTP/MCP 在 agent 出现前失败，不还原临时根

机制属实，不是误报。

`sessions.ts:239-248` 在 `dispatchAt` 之前写入临时模型和根。HTTP 与 MCP 的 `dispatchAt` 不解析父会话：HTTP 直接返回卸工具的 `afterIdle`（`agent-invoke.ts:164-179`），MCP 等挂载完再返回卸 MCP 的 `afterIdle`（`:205-220`）。`sessions.ts:294` 先记下这个钩子，`:299` 才 `resolveAgent()`。

若钩子已经返回、agent 还没建出来就失败（读 header 之后取消、持久化 `cwd` 缺失或不在准入根内、`create` / `resume` 不可用），`followup` 没有受理，但 `afterIdle` 已有值。`sessions.ts:327-333` 只在 `afterIdle === undefined` 时调用 `restoreProvisionalBindings()`。名额仍由随后的清理释放一次（`:147-158`），不会叠两个写者，也不会把文件写进前台项目。留下的是根表和模型表。

下一次 `session.send` 看见根已登记就不再推导（`:910-913`）。这次失败若是 `cwd` 对不上，之后把任务改绑到包含该 `cwd` 的项目也不会重新推导。根表是内存表，`releaseSessionRuntime`（`:575-576`）在删除会话时会清掉，进程重启也会清掉。

不在这条里的失败：工具不存在、入口损坏、MCP 地址缺失，以及包内 `@slug`、旧目录 `@agent`。后两者在 `dispatchAt` 内部就调用 `resolveParent`，抛错发生在 `sessions.ts:294` 之前，还原会执行。已经建出 agent 再取消，根本来就该留下。

规格 §5.1.1 与 §5.2.1 里「没有 `afterIdle` 才还原」写宽了。HTTP/MCP 的 `afterIdle` 只是卸工具，不是子代理还在写根。

修法：`followup` 未受理且 `findAgentBySession` 仍为空时，先 `restoreProvisionalBindings()`，再释放名额。`afterIdle` 继续交给清理去卸工具。只有已经留下 live agent、并且还要等子代理收尾时，才跳过还原。规格那句改成同一口径。补一条回归：`dispatchAt` 只返回 `afterIdle`、不解析父会话，在建出 agent 之前失败，释放名额前两张表都没有这次写入。

### A.3 三条 Minor（不挡合并）

1. **无 live agent 时，`ensureChannelAgent` 仍可能用准入根覆盖表里另一条路径**（`sessions.ts:384-411`）。已有 live agent 才会在根不一致时拒绝（`:366-377`）。新的 `session.send` 在根已登记时沿用登记根，不会自己准入成另一个目录。要覆盖，得同时是：表里已有根、agent 不在，并且队列项是在这次登记之前按另一条根排上的。正常跑完的回合 agent 还在，走拒绝分支。这条更接近 §A.2 留下的根碰上更早的队列项，不是一条常见的独立路径。
2. **立即发送没有把 `cancelled` 传进 `sendToAgent`**（`sessions.ts:957-962`）。`session.remove` 只给调度器 `starting` 里的排队项打取消标记（`turn-scheduler.ts:166-168`）。立即发送正扫 session header 时删除会话，回来后仍可能 `create` 或 `resume`。排队发送已经传入 `cancelled`。界面上的「取消等待」走排队项，不走这条。窗口是一次 header 扫描。
3. **较早一条排队发送失败或取消时，可能清掉同标签上后一条仍要用的隐式模型选择。** 标签原先没有选择时，排队归属不记 `previousModelPick`（`App.tsx:2753-2758`）。`restoreModelPick` 没有旧值就删掉这个键（`:4333-4336`）。`queue-fail`（`:865-868`）和 `cancelWaiting`（`:2851-2852`）都会走到。用户中途改过 chip 时，当前值已经不等于这次送出的 id，不会删。后一条排队请求里已经带了 `modelId`，宿主仍按那个模型跑；被清掉的是标签上的选择，影响的是它之后的下一次发送。任务文件里若已经记下同一个模型，解析还会先用任务模型。

### A.4 第一次表述里写重、二次核对后收窄的部分

二次核对没有整条撤销 §A.2 或 §A.3。收窄的是后果：

- 「之后每次发送都被拒，直到进程退出」只适用于持久化 `cwd` 缺失或不在这次推导根里。健康会话上取消留下的是当时推导出的那条根，下一次普通发送仍能创建或恢复。HTTP 的取消窗口只有读 header 那一下；MCP 挂载期间取消才比较容易碰到。
- 这种 `cwd` 对不上的会话本来就会被 `isInside` 拒绝。新的问题是根被登记之后不再重新推导，后来的任务改绑要删除会话或重启才生效。
- 模型不会跨过下一次 `sendToAgent` 入口一直卡着：入口会先重写模型表（`sessions.ts:247`）。
- Minor 3 不清后一条已经发出的 `modelId`。

### A.5 合并建议

**建议先修 §A.2 再合并。** 不修也不构成跨项目写，也不让健康会话永久不可用。上一轮列为合并门槛的 Important-1 主路径、Important-2、Minor-3 已在这份工作区落地。§A.3 的三条可以同批带上，不单独挡合并。0 Critical。

### A.6 2026-11-07 修复闭环补记（§A.2 与 §A.3 第 1–3 条）

同日已按优先级逐条完成工作区修复与回归覆盖（详见 `docs/evidence/2026-11-03-concurrent-project-turns-verification.md` §18）：

1. **§A.2（`@` HTTP/MCP 在 live agent 出现前失败不还原临时根/模型）— 已修复**：`sessions.ts` 将 `restoreProvisionalBindings` 改为幂等；当 `!followupAccepted && afterIdle !== undefined` 且 `findAgentBySession(ctx, sessionId) === undefined` 时，在 `admission?.deferRelease?.()` 前立即还原临时根与模型，并在 `cleanup` 的 `finally` 中于 `releaseOnce?.()` 前兜底调用 `if (!followupAccepted) restoreProvisionalBindings?.()`。规格 §5.1.1 / §5.2.1 与计划已同步。回归：`sessions.spec.ts` `an @ HTTP tool that fails before creating a live agent restores the provisional bindings and detaches before release`。
2. **§A.3 #1（无 live agent 时 `ensureChannelAgent` 可能覆盖已登记根）— 已修复**：`ensureChannelAgent` 抽出 `assertMatchesRegisteredRoot()`，在入口及异步 header/project/task 读取之后、`roots?.set(sessionId, root)` 之前均校验已登记根，不一致即抛错拒绝。规格 §5.1.1 与计划已同步。回归：`sessions.spec.ts` `a session without a live agent rejects an admission root that differs from its registered root without overwriting it`。
3. **§A.3 #2（立即发送路径未向 `sendToAgent` 传入 `cancelled`）— 已修复**：`sessions.ts` 新增 `directStarts` 与 `cancelDirectStarts`，在 `releaseSessionRuntime` 与 `cancelAgent` 中标记取消，并在立即发送分支（`admitted.kind === 'start'`）向 `sendToAgent` 传入 `cancelled: () => directStart.cancelled`。回归：`sessions.spec.ts` `an immediate session.send whose session is removed during the header read stops before resume and releases the slot`。
4. **§A.3 #3（同标签多条排队发送时取消/失败较早项误删后续项的模型选择或丢失基准）— 已修复**：`App.tsx` 新增 `QueuedModelOwner` 与 `restoreQueuedModelPick`，在回滚较早排队项时把 `previousModelPick` 交接给同标签后续紧邻且继承了本条 `modelId` 的排队项，且在后续排队项仍带 `modelId` 时保留当前标签选择。回归：`appWiring.spec.ts` `rolling back an earlier queued send keeps a later queued send's pick and hands off the pre-queue baseline`。

---

## 零、二轮复核（`10b1e35f01..f19900eae8`）

### 0.1 首轮评审意见（R-1..R-5、P-1..P-4）修复核验

| 编号 | 议题与修复提交 | 二轮核验状态 | 代码与测试核对结论 |
| :--- | :--- | :--- | :--- |
| **R-1** | 智能体子代理与 `delivery: "parent"` 父汇总轮未结束即释放项目根<br>（`1f968b5acc`） | **已修复** | `sessions.ts:136-148, 276-284, 725-779`：`cleanup` 在 `try` 中依次 `await afterIdle?.()` 与 `await acceptedAgent?.whenIdle?.()`，最后在 `finally` 中调用幂等的 `releaseOnce?.()`；若 `afterIdle` 已登记但 `followupAccepted` 尚未置位就抛错，`admission?.deferRelease?.()` 会阻止 `startQueuedItem.fail()` 提前释放名额，交由 `cleanup.finally` 兜底。测试覆盖：`sessions.spec.ts:835-1094`（包内 `@slug`、旧目录 `kind: 'agent'`、`delivery: 'parent'` 二次 `whenIdle`、`afterIdle` 抛错）与 `:2902-3086`（`followup` 抛错但 `afterIdle` 仍在运行时的延迟释放）。 |
| **R-2** | 停止后的过期 `session/end` / `goal/*` 被下一次发送的 `pending.buffered` 吞掉导致停止按钮残留<br>（`973f1615d2`） | **已修复** | `App.tsx:1641` 在 `stopRequestedForSession(sessionId)` 或 `staleIdleRef.current.has(sessionId)` 时跳过 `holdEarlyEvent`，让停止收尾事件直通主处理链；同时 `App.tsx:862-876` 与 `stopGate.ts:107-127`（`consumeBufferedStaleEnds`）在 `takePendingBuffer`（`:889`）与 `dropPending`（`:903`）丢弃缓冲前先行消化已入缓冲的 `session/end`（并仅在 `owner.turn.stopSessionId === sessionId` 时清理 `stopSessionId`）。测试覆盖：`stopGate.spec.ts:71-140`、`appWiring.spec.ts:1296-1347`。 |
| **R-3** | 超时后 120 秒 drain 先到期时，仍在运行的自动化回合删掉自己的根表与模型表<br>（`c9ed075776`） | **已修复** | `automations-host.ts:301-306, 340-344`：`huaanworkSessionRoots.delete(sessionId)` 与 `huaanworkSessionModels.delete(sessionId)` 移入 `turn.finally(...)`；`automationCollector.delete(sessionId)` 与 `unattended?.delete(sessionId)` 保持在 `runAgentTurn` 的 `finally` 中立即清理，M4 D-1 门禁不退化。测试覆盖：`automations-host.spec.ts:1106-1165`。 |
| **R-4** | 出队后、`queue-start` 前取消或删除够不着正在启动的项，且 `queue-start` 晚于 `rememberTaskModel`<br>（`f6ab191529`） | **已修复** | `turn-scheduler.ts:87-89, 148-179, 196` 新增 `starting` 与 `cancelledStarts` 跟踪；`sessions.ts:163, 176, 257-259, 773-795` 在 `sendToAgent` 入口、`resolveAgent` 之后、`followup` 之前三次检查 `admission?.cancelled?.()`，并在 `followup` 受理后、`await rememberTaskModel` 之前同步调用 `admission?.onAccepted?.()` 发出 `session/queue-start`；客户端 `App.tsx:2684, 4246-4264` 为新发送的用户消息打上 `notStarted: true` 并通过 `turnAppendIndex` 将先到的流式片段锚定在未启动用户消息之前。测试覆盖：`turn-scheduler.spec.ts:123-189`、`sessions.spec.ts:681-833`、`appWiring.spec.ts:1350-1391`。 |
| **R-5** | `ensureChannelAgent` / `resume` 未接收队列项锁定的 `admission.root`<br>（`01c16f2205`） | **主路径已修复**（`@` 激活顺序仍有缺口，见 **Important-1**） | `sessions.ts:172, 303-315` 将 `admission?.root` 传给 `ensureChannelAgent`，并在 `create` / `resume` 前优先采用 `admissionRoot ?? roots?.get(sessionId)`。测试覆盖：`sessions.spec.ts:624-679`。但 `@` 激活路径在 `sessions.ts:270-273` 写入 `huaanworkSessionRoots` / `huaanworkSessionModels` 之前就读取了这两张表，详见 **Important-1**。 |
| **P-1** | 任务模型写回未同步到客户端<br>（`d2274bc723`、`f19900eae8`） | **已修复**（未启动路径残余见 **Minor-1**） | `App.tsx:2677-2679, 2713, 2772, 839, 4280-4289` 在发送前将隐式解析出的 `modelId` 记入 `modelPickByTab[chatId]`，回合启动后调用 `refreshTasks()`，并在 `send()` 的 `catch` 中通过 `clearSentModelPick` 回滚。测试覆盖：`appWiring.spec.ts:1393-1451`。 |
| **P-2** | 脚本 `spawn` 成功后触发 `error` 事件会先于 `close` 释放写者<br>（`24f9c88c4b`） | **已修复** | `automations-host.ts:463-471` 仅在 `child.pid === undefined`（从未 spawn 成功）时于 `error` 上立即 `finish`，spawn 成功后一律等 `close`。测试覆盖：`automations-script-error.spec.ts:1-85`。 |
| **P-3** | 无显式 `parent` 的子代理通过进程级 `currentCallerSession` 串继承并发回合的模型与根<br>（`a44cc85281`） | **已修复** | `child-sessions.ts:1-56` 与 `skills.ts:248-253, 303, 372` 删除了 `noteCallerSession` / `currentCallerSession`，仅在存在显式父会话（`header.parentSession` 或 `startParent` `AsyncLocalStorage`）时继承模型与根。测试覆盖：`skills.spec.ts:719-842`。 |
| **P-4** | 9 项周边清理与加固<br>（`16ca9de7bc`..`79713e8074`） | **已修复**（手动运行跳过提示文案见 **Minor-3**） | ① `writable-root.ts:45-55` + `workspace-state.ts:40-49` 拆出纯路径计算 `neutralWorkspaceRootPath`，消除准入阶段 `mkdirSync` 副作用；② `writable-root.spec.ts:186-191` 共享同一 `sessionId`；③ `sessions.ts:330-333` 拒绝缺 `cwd` 的持久化 header；④ `sessions.ts:728-741` `startQueuedItem.fail()` 用 `try ... finally` 包裹 `releaseOnce`；⑤ `bridge.ts:302-314` 无唯一归属会话时不做 diff 快照；⑥ `Settings.tsx:51-56, 392-408` 抽 `clampConcurrentTurns` 消除未夹紧值闪烁；⑦ `App.tsx:761-912` pending 缓冲改为 `tabId + userMsgId` 复合键；⑧ `turn-scheduler.ts:55, 121-128` + `routes.ts:1234` + `AutomationsView.tsx:174-178` 手动运行传入 `{ recordSkip: false }` 并在前端报错提示；⑨ `79713e8074` 删除 `sessionSendBlockers`、`assertSessionSendable` 与 `huaanworkRouteAgent` 死代码并同步规格 §5.1.1 / §5.5。 |

---

### 0.2 二轮新增 / 残余问题（合并前应修：Important）

#### Important-1｜`sendToAgent` 在 `dispatchAt` 之后才写入 `huaanworkSessionModels` 与 `huaanworkSessionRoots`，导致 `@` 智能体包服务/脚本与子代理读到旧根或旧模型

- **位置**：
  - [sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L225-L274)
  - [host.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts#L934-L948)（及 `:994`、`:1028`）
  - [agent-invoke.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts#L334-L395)
  - [skills.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/skills.ts#L248-L253)
  - [session-models.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/session-models.ts#L67-L77)
- **证据与触发路径**：
  1. 在 `sendToAgent` 中，`dispatchAt` 在 `sessions.ts:233` 执行，而 `ctx.huaanworkSessionModels?.set(sessionId, admission.modelId)` 与 `ctx.huaanworkSessionRoots?.set(sessionId, admission.root)` 要等到 `followup` 受理之后的 `sessions.ts:269-274` 才执行。
  2. **跨项目根泄漏（包内 `@slug` 的 HTTP/MCP 服务与 `agent_skill_run` 脚本）**：`agent-package/host.ts:934` 在调用 `input.resolveParent()`（`:994`，即 `ensureChannelAgent`）**之前**先执行 `const workspaceDir = sessionWorkspaceRoot(ctx, sessionId)`，并把 `workspaceDir` 传给 `createRuntime`（`:944`）。对新建会话、刚恢复的会话或走 `waitForAgent` 的默认会话首轮，此时 `ctx.huaanworkSessionRoots.get(sessionId)` 仍为 `undefined`，`sessionWorkspaceRoot`（`sandbox-cwd.ts:126-132`）直接回退到前台 `ctx.huaanworkWorkspaceRoot?.current`。结果：后台项目 B 的首轮 `@slug` 会把包内 HTTP/MCP 子进程与 `agent_skill_run` 脚本的 `cwd` / `WORKSPACE_DIR` 启动在前台项目 A 的目录中，直接违反规格 §1 不变量 1 与 §5.1.2。
  3. **子代理模型与根继承滞后（`@` 智能体子代理）**：`agent-package/host.ts:1028` 与 `agent-invoke.ts:393` 均在 `dispatchAt` 内部（即 `sessions.ts:233`）调用 `startActivation` 启动子代理，同步触发 `subagent/start` 钩子（`skills.ts:250-253`）执行 `inheritSessionModel(ctx.huaanworkSessionModels, parentId, childId)` 与 `inheritSessionRoot(ctx.huaanworkSessionRoots, parentId, childId)`。此时 `sessions.ts:270-273` 尚未执行：
     - 若父会话在第 1 轮使用了模型 `m1`、第 2 轮改选模型 `m2` 发送 `@agent`，`subagent/start` 时 `huaanworkSessionModels.get(parentId)` 仍是 `'m1'`，`childId` 会被显式绑定为 `'m1'`（后续父会话在 `:270` 更新为 `'m2'` 也不会改写已有显式绑定的 `childId`），导致整个子代理回合跑在旧模型 `'m1'` 上；
     - 若父会话是走 `waitForAgent` 分支的默认频道会话（`ensureChannelAgent` 在 `sessions.ts:311` 仅在 `!isChannelId(sessionId)` 时写根），首轮 `@agent` 在 `subagent/start` 时 `huaanworkSessionRoots.get(parentId)` 为 `undefined`，`childId` 无法继承父会话的根绑定。
  4. **已有根条目不随新准入更新**：`sessions.ts:271-273` 写的是 `if (ctx.huaanworkSessionRoots?.has(sessionId) !== true) { ctx.huaanworkSessionRoots?.set(sessionId, admission.root) }`。当会话已有存活 agent 且曾登记过根时，后续回合即便准入根已变更（如排队期间或跨回合任务改绑），也不会更新为本轮的 `admission.root`。
- **修法建议**：
  - 在 `sessions.ts:225`（`/create-agent` 早退分支 `:192-223` 之后、`if (atName)` 之前），只要存在 `admission`，就先记录 `prevModel` / `prevRoot` 并**无条件写入** `admission.modelId` 与 `admission.root`；
  - 若后续 `!followupAccepted && afterIdle === undefined`（即既未进入 `followup`、也未启动需要 `afterIdle` 收尾的子代理就抛错或取消），在 `finally` 中把 `huaanworkSessionModels` 与 `huaanworkSessionRoots` 还原为 `prevModel` / `prevRoot`。

#### Important-2｜后台回合结束时的交付物校验（`readTurn` / `outcomeWorkspace`）优先扫描前台 `workspaceRef.current` 而非回合所属项目根

- **位置**：
  - [App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1510-L1529)
  - [outcomeCheck.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts#L184-L188)
- **证据与触发路径**：
  1. `outcomeWorkspace(currentWorkspace, sessionCwd)`（`outcomeCheck.ts:184-188`）的实现是：
     ```ts
     export function outcomeWorkspace(currentWorkspace: string, sessionCwd: string | undefined): string {
       const current = currentWorkspace.trim()
       if (current) return current
       return (sessionCwd ?? '').trim()
     }
     ```
     只要前台 `workspaceRef.current` 非空，它就**无条件返回前台工作区路径**，忽略传入的 `sessionCwd`。
  2. 在 `App.tsx:1510-1511` 中，当任一会话收到 `session/end` 触发 `readTurn(sessionId)` 且该回合带有 `requiredFiles`（技能/模板交付物检查）时，客户端调用 `outcomeWorkspace(workspaceRef.current, listedCwd)` 并以此路径调用 `listTree(checkCwd, '', 200)` 检查文件是否生成：
     - 若项目 A 的回合在后台完成，而用户当前在前台浏览项目 B，`workspaceRef.current` 是项目 B 的根，`readTurn` 会去项目 B 的目录树里查找项目 A 任务要求生成的文件，进而在项目 A 的会话气泡末尾追加虚假的 `缺少文件：...` 告警；
     - 若未绑定项目的普通会话（实际写入 `neutralWorkspaceRoot`）在后台完成，而前台打开着项目 B，同样会去扫描项目 B；
     - 此外，从侧栏恢复的子任务标签在 `sessionsRef.current` 中被 `visibleMainSessions` 过滤掉（`App.tsx:1104-1108`），其 `listedCwd` 为 `undefined`，若不回退查询 `tab.projectId` 对应的 `project.root`，即使交换优先级也拿不到项目根。
- **修法建议**：
  - 将 `outcomeWorkspace` 的优先级反转为**回合/标签自己的根优先**：优先取 `sessionCwd`（来自 `sessionsRef`）或该 `sessionId` 所属 `tab.projectId` 对应的 `project.root`；
  - 若该标签明确属于未绑定项目的普通会话（无 `sessionCwd` 且无 `tab.projectId`），不应借用无关的前台项目 `workspaceRef.current` 去跑交付物校验（或仅在标签自身与前台同属当前上下文时才回退）。

---

### 0.3 二轮可后做 / 顺手修（Minor）

#### Minor-1｜未真正开始的回合（排队期失败 `session/queue-fail`、排队期取消 `cancelWaiting`、`started: false`）未回滚 `modelPickByTab[chatId]`

- **位置**：[App.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2677-L2679)（及 `:847-855`、`:2728-2740`、`:2802`）
- **现象**：P-1 修复在 `rpcCall("session.send")` 前把隐式解析出的 `sendModelId` 写入 `modelPickByTab[chatId]`，但只在 `send()` 抛异常的 `catch` 分支调用了 `clearSentModelPick()`。若请求返回 `{ started: false, waiting: false }`（如 `/create-agent` 取消或文件未变动），或返回 `{ waiting: true }` 后在排队期间被用户点取消（`cancelWaiting`），或出队重检模型已被删除而触发 `session/queue-fail`（`failQueuedTurn`），宿主从未调用 `rememberTaskModel`，但客户端 `modelPickByTab[chatId]` 已留下该模型 ID（尤其当模型被删才触发 `queue-fail` 时，下次发送仍会携带已删模型 ID 并再次报错）。
- **建议**：仅在用户显式手选模型时写入 `modelPickByTab`，或在 `started: false`、`failQueuedTurn`、`cancelWaiting` 时同步清理本次隐式写入的 `modelPickByTab[chatId]`。

#### Minor-2｜`session.remove`（`releaseSessionRuntime`）与正在 `await findSessionHeader` 的 `ensureChannelAgent` 存在窄竞态

- **位置**：[sessions.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts#L169-L178)（及 `:313-341`、`:568-590`）
- **现象**：当队列项出队进入 `startQueuedItem` → `sendToAgent` → `ensureChannelAgent` 并停在 `await findSessionHeader(ctx, sessionId)`（`:317`）时，若用户恰好删除该会话（`session.remove` → `releaseSessionRuntime`），`releaseSessionRuntime` 当下看到 `ctx.agents.get(sessionId)` 仍为空；随后 `findSessionHeader` 返回，`ensureChannelAgent` 仍会继续执行 `roots?.set(sessionId, root)` 与 `ctx.agents.create` / `ctx.agents.resume`，直到回到 `sendToAgent:176` 才被 `if (admission?.cancelled?.()) throw new Error('已取消')` 拦下，此时已在内存中留下一个孤儿 agent 实例和一条残留的 `huaanworkSessionRoots` 记录。
- **建议**：向 `ensureChannelAgent` 传入 `admission?.cancelled` 回调，在 `await findSessionHeader` 之后、`roots?.set` 与 `ctx.agents.create/resume` 之前再做一次取消检查；或在 `sendToAgent:176` 命中取消分支时调用清理逻辑释放刚创建的 agent 与 root。

#### Minor-3｜手动触发自动化被跳过时的前端提示未区分「同根忙（`root-busy`）」与「全局并发名额已满（`cap-full`）」

- **位置**：
  - [routes.ts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1234-L1243)
  - [AutomationsView.tsx](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx#L174-L178)
- **现象**：`scheduler.admitAutomation` 已区分 `reason: 'root-busy' | 'cap-full'`，但 `routes.ts:1241` 未将 `admission.reason` 透传到响应体，`AutomationsView.tsx:176` 对所有 `res?.waiting` 一律显示 `"同一项目根上已有任务在运行，本次手动运行未开始。"`。当其它项目跑满 `maxConcurrentTurns` 导致 `cap-full` 时，该报错文案与实际原因不符。
- **建议**：在 `routes.ts:1241` 透传 `reason: admission.reason`，前端在 `reason === 'cap-full'` 时显示 `"已达到同时进行的任务数上限，本次手动运行未开始。"`。

#### Minor-4｜计划文档与验证证据中的少量前置措辞未随 P 波次提交同步，且工作区有 4 个未跟踪路径

- **位置**：
  - [2026-11-03-concurrent-project-turns.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-03-concurrent-project-turns.md#L38-L45)（及 `:547`、`:1172-1187`）
  - [2026-11-03-concurrent-project-turns-verification.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-03-concurrent-project-turns-verification.md#L633-L638)
- **现象**：
  1. 计划文档正文 `:38`（`currentCallerSession()` 标注为不变）、`:45`（`neutralWorkspaceRoot` 准入期建目录）、`:547`（`admitAutomation` 无 `options` 签名）、`:1172-1187`（`send()` 前不写 `modelPickByTab`）仍保留 P-1 / P-3 / P-4 修复前的旧描述（规格文档 `2026-11-03-concurrent-project-turns-design.md` 已在 `79713e8074` 同步完毕，无陈旧描述）。
  2. 验证证据文档 `:633-638` 记录的测试计数（71 files / 1180 tests）定格在 `10b1e35f01`，未反映 `1f968b5acc..f19900eae8` 新增的测试文件与用例数。
  3. 当前工作区 `git status` 存在 4 个未跟踪路径：`.gstack/`、`.qoder/`、`docs/superpowers/plans/2026-10-31-single-desktop-maintenance-code-review.md`、`docs/superpowers/plans/2026-11-06-concurrent-project-turns-code-review.md`，合并前需清理工具目录并决定评审文档是否入库。

---

### 0.4 规格与计划全量核对汇总（Tasks 1–13 & 护栏）

| 维度 | 核对结果 | 说明 |
| :--- | :--- | :--- |
| **Task 1–2：可写根推导与并发上限持久化** | **通过** | `writable-root.ts` 四步优先链（显式参数 → 任务 `projectId` → 持久化 `header.cwd` → `sessionProjectIdFromStableId` → `neutralWorkspaceRootPath`）与 `parseConcurrentTurns` / `clampConcurrentTurns`（缺省 3，夹紧 `1..8`）完全符合规格 §4.2、§5.1.1、§5.4。 |
| **Task 3：纯内存 `TurnScheduler`** | **通过** | `turn-scheduler.ts` 零磁盘 I/O；根键经 `path.resolve` 归一化；同根互斥、空闲根越过忙碌队头、全局 `activeTurns < max` 门控、脚本写者 `countsTowardCap: false`、`starting` / `cancelledStarts` 生命周期完整。 |
| **Task 4–6：会话模型表、沙箱/桥接、排队式 `session.send`** | **除 Important-1 外通过** | `session.send` 非阻塞返回、`session/queue-start` / `session/queue-fail` 事件、取消与删除联动、R-1 子代理 `afterIdle` + 二次 `whenIdle` 延迟释放均已到位；唯独 `sendToAgent` 中 `huaanworkSessionModels` / `huaanworkSessionRoots` 的写入晚于 `dispatchAt`（见 **Important-1**）。 |
| **Task 7–8：自动化按根准入、移除单槽阻塞器** | **通过** | 移除 `hasOtherProjectTurn`、整轮 tick 空闲门、`automationTail`、`assertAutomationIdle`、`pinWorkspace`；跳过项记入 `admissionSkips` 豁免 10 分钟 `missed`；每次写者释放后按「用户队列优先 → 自动化 `reevaluate`」顺序推进；R-3 与 P-2 均已闭环。 |
| **Task 9–12：客户端并发状态、按标签停止门、排队气泡、设置项** | **除 Important-2 外通过** | `runningChatIds` 集合、按标签 `stopGate` + R-2 缓冲先消化、排队中「等待当前任务 · 取消」气泡、`tabId + userMsgId` 复合键缓冲、设置页「同时进行的任务数（1–8）」均与规格 §5.3、§5.4 一致；唯独 `readTurn` 交付物检查仍优先读取前台 `workspaceRef.current`（见 **Important-2**）。 |
| **Task 13 & 仓库护栏** | **通过** | `deepseek-harness/` 子模块零改动（`git status` clean）；全部变更落在 `dsh-plugin-huaanwork/` 与 `docs/`。 |

---

### 0.5 三轮校准（核对二轮意见是否属实）

只读对照当前源码。不改产品代码，不重跑测试。二轮正文保留在 §0.2–§0.3，本节只记录核对结果。

#### 属实，且上次审查漏了

**Important-1 的前两条触发路径成立。** `agent-package/host.ts:934` 在 `resolveParent`（`:994`）之前就用 `sessionWorkspaceRoot` 作为包进程的 `workspaceRoot`。新建会话和默认频道会话这时根表还没有该会话，函数落到前台目录。子代理的模型和根在 `dispatchAt` 里的 `subagent/start` 复制（`huaanwork-guardrails/skills.ts` 的 `inheritSessionModel` / `inheritSessionRoot`），父会话要等 `followup` 之后才写入本轮的 `admission.modelId` 和根（`sessions.ts:269-274`）。这一轮改选的模型不会进子代理；根表尚无条目时，子代理不继承根。

两处引用不准确，不推翻结论：

- 仓库里没有 `isChannelId`。默认频道会话走 `waitForAgent`（`sessions.ts:416-426`），这条路径本来就不写根表。
- 继承实现在 `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`，不在 `huaanwork-host/skills.ts`。

**空表时的修法同意二轮。** `dispatchAt` 之前，若根表或模型表还没有该会话，先写入本轮的 `admission.root` 与 `admission.modelId`。这次既没有 `followup`、也没有要等的 `afterIdle` 时，再还原写入前的值。这样包进程和子代理读到的是本轮准入，而不是前台目录或上一轮模型。

#### 第 4 点是上次那条残余，修法不要无条件改写

「已有根条目不随新准入更新」就是上次指出的 live agent 残余：会话已经登记过根时，后续回合不再改成新推导出的根，任务在排队期间改绑后，写者锁和沙箱根可能分开。

不要按二轮建议把已有根无条件改成新的 `admission.root`。会话日志里的 `cwd` 仍在旧目录。改写之后这次工具写到新项目，下次恢复又会因为 `cwd` 不在新根里被拒绝。已有会话继续锁在登记过的根上：`session.send` 准入时若根表已有该会话，就用那条路径，不再调用 `writableRootForSession`。`ensureChannelAgent` 的 live 分支若发现传入根和根表不一致，在 `followup` 之前按未启动失败并释放名额。

#### Important-2：现象属实，规格引用和严重度偏高

`outcomeWorkspace`（`outcomeCheck.ts:184-188`）在前台目录非空时直接返回前台目录。`readTurn`（`App.tsx:1510-1516`）因此会到当前看着的项目里找后台回合要求的文件，可能在该会话上多出「缺少文件」。这是核对读错了树，不会把文件写到别的项目。

规格 §1 是背景与目标，没有二轮所写的「不变量 1」。`App.tsx:1104-1108` 是 `noteTab`，不是会话过滤；仓库里也没有 `visibleMainSessions`。子任务会话仍由 `session.list` 进入 `sessionsRef`，`listedCwd` 一般拿得到。拿到了也会被前台路径盖掉，所以主缺陷仍然成立。它值得修，不与 Important-1 的跨项目启动放在同一档。

#### 上次两条残余落在哪里

| 残余 | 二轮是否包含 |
| --- | --- |
| 手动运行不区分「同根忙」和「名额已满」 | **包含，即 Minor-3。** `routes.ts` 的跳过应答没有带上 `reason`，`AutomationsView.tsx:174-178` 一律显示「同一项目根上已有任务在运行，本次手动运行未开始。」属实。透传 `root-busy` / `cap-full`，名额已满时改说「已达到同时进行的任务数上限，本次手动运行未开始。」 |
| 已有 live agent 不把新准入根写回根表 | **没有单独成条，写在 Important-1 第 4 点。** 现象属实。修法见上一节，不要无条件改写已有根。 |

#### 其余 Minor

- **Minor-1 属实。** `modelPickByTab` 在 `session.send` 之前写入，只有 `send()` 抛错会 `clearSentModelPick`。`started: false`、排队取消、`queue-fail` 都会把这次模型留在标签上。模型已删除时，下一次发送会再带上这个 id。
- **Minor-2 属实，窗口窄。** `ensureChannelAgent` 停在 `await findSessionHeader` 时删除会话，取消标记要等该函数返回后才检查。检查之前已经 `roots.set` 并 `create` / `resume`。应在写根和创建 agent 之前再看一次 `cancelled`，或者命中取消时清掉刚创建的 agent 和根表项。
- **Minor-4 只核对了未跟踪路径。** `.gstack/`、`.qoder/`、`docs/superpowers/plans/2026-10-31-single-desktop-maintenance-code-review.md`、本文档当时确实未跟踪。计划正文是否逐句过时，没有逐段重读。这不影响代码能否合并。

#### 提交号

§0.1 表中的部分修复提交号（如 `973f1615d2`、`c9ed075776`、`f6ab191529`）不在 `master..f19900eae8` 的历史上。对应修复在当前树里，定位以符号和现行行号为准，不要用这些提交号。

---

> 以下 §一～§六为 **首轮评审（针对 `10b1e35f01`）** 的原始记录与一轮校准说明，保留备查。§6.1 已改为三轮校准后的结论。

---

## 一、首轮复核说明（误报、夸大、漏报，针对 `10b1e35f01`）

初审先按四路只读审查汇总，再逐条回到当前函数核对。本文件只保留核对过的意见。

### 1.1 没有整条撤销的误报

R-1 到 R-5 的代码路径都在当前文件里。没有一条是「看错函数」或「把计划原文当成实现」。

### 1.2 校准 4 处夸大与 2 处修法边界

1. **R-1 的范围收窄到智能体子代理，且修法须额外覆盖 `delivery: "parent"` 唤醒的父会话汇总轮。** `sessions.ts` 确实在父会话 `whenIdle` 之后、`afterIdle` 之前释放写者。包路径和旧目录 `kind === "agent"` 的 `afterIdle` 会先等子代理结果，最长 10 分钟（`ACTIVATION_CLEANUP_TIMEOUT_MS`）。HTTP / MCP 的 `afterIdle` 只卸载已经在父回合里跑完的工具，不构成同样的双写者窗口。初审写成「`@` 回合」过宽。同时，两条智能体子代理路径均以 `delivery: "parent"` 调 `startActivation`（`agent-package/host.ts:1042`、`agent-invoke.ts:383`），上游 `manager.ts:1178-1200` 在 resolve `activation.result` 之前会先同步调 `parent.followup(message)` 唤醒父会话汇总结果；因此 `cleanup` 在 `await afterIdle?.()` 之后还必须再 `await acceptedAgent?.whenIdle?.()`，然后才能在 `finally` 里 `releaseOnce?.()`。
2. **R-2 是应答与 WebSocket 交叉时的竞争，不是每次停止后再发送都卡住。** 排队的 `session.send` 在准入后就返回，不等 agent 空闲。idle `session/end` 若晚于这次应答，pending 已经清掉，`consumeStaleIdle` 会在原 epoch 上吃掉标记，后续回合正常。标记被丢掉、停止按钮留下，只发生在这条结束赶在排队 / 未启动 / 抛错应答之前到达的时候。这正是规格要求 pending 缓冲处理的乱序，失败时该标签的 `running` 不再被自己的结束清掉。
3. **R-3 只在「超时后的 120 秒 drain 先到期、回合仍未 settle」时发生，且延迟清理只限根表与模型表。** 取消若在 `timedOutTurnDrainMs` 内让 `whenIdle` 完成，`finally` 删根发生在回合结束之后，写者也会被释放。初审写成「超时后的自动化会拆掉自己的根」把这条失败路径说成了超时的普遍结果。此外，初审修法把 `automationCollector`、`unattended` 与根表、模型表一并延后到 `turn` settle 过宽：`finishAutomation` 在 `runAgentTurn` 返回后即落盘超时记录，保留 `collector` 会造成内存泄漏，失控回合也不应在 120 秒 drain 后继续保有 `unattended` 自动放行特权（且会破坏 M4 D-1 门禁测试 `automations-host.spec.ts:1146-1147`）；只有 `huaanworkSessionRoots` 与 `huaanworkSessionModels` 应延后到 `turn` 真正 settle 后删除。
4. **R-5 在绑定不变时两次推导通常是同一个目录。** `ensureChannelAgent` 不接收队列项上的根，这和计划不符，也会在排队期间绑定变化时让写者锁和沙箱根分开。它不是每条消息都写进别的项目。

### 1.3 降级 2 处初审「应修」

1. **下一次发送重读全局模型，降为可后做（P-1）。** 进行中的生成、目标续轮和子代理读的是 `followup` 之后写入的 `huaanworkSessionModels`。未绑定标签的发送区用的就是 `resolveSendModelId` 的结果，界面和请求一致。缺口只剩：宿主把 `task.modelId` 写回之后，客户端不刷新任务列表；在刷新前若改了全局模型，下一次发送会覆盖会话绑定，任务文件里仍是第一次的 id。
2. **脚本 `error` 提前 `finish`，降为可后做（P-2）。** 启动失败时没有进程，在 `error` 上结束并释放是对的。spawn 成功之后，`kill` 失败再发 `error` 才会在 `close` 之前放开根。这是窄路径，不是脚本超时的正常释放顺序。超时路径仍然等 `close`。

### 1.4 漏报

没有再发现与 R-1 同级的、主路径上的第二个写者或错误终点。补进可后做的有 3 条：

1. **P-3**：`currentCallerSession()` 仍是进程里的一个槽，`subagents.start` / `startActivation` 在调用参数没有 parent 时用它继承模型和根。`@` 路径显式传递 parent，不受影响。模型自己发起、且参数里没有 parent 的子代理，会在并发 `sendToAgent` 改写这个槽之后继承另一次发送的会话。
2. **P-4 补入项（手动运行 `automation.run` 跳过时的静默空转与 `admissionSkips` 污染）**：手动触发（`routes.ts:1224-1236`）复用 `scheduler.admitAutomation`，撞上同根忙或全局名额满时既会把 `automation.id` 写入仅供定时调度豁免 `missed` 的 `admissionSkips`（`turn-scheduler.ts:109, 113`），又只向前端返回 `{ queued: false, waiting: true }`，而手动触发无重评估队列、`AutomationsView.tsx:170-178` 也不消费该字段，导致点击无反馈且不会补跑。
3. **P-4 补入项（`sessions.ts` 单槽/阻塞器死代码残留）**：规格 §5.5 要求删除的 `sessionSendBlockers` 与 `assertSessionSendable` 仍留在 `sessions.ts:94-109, 862`（`workspaceDisplaced` 恒为 `false`、外部零引用），`sessions.ts:264` 仍在写已无生产读取方的 `ctx.huaanworkRouteAgent.current = agent`。

规格 §5.5 仍写「`admitUserTurn` 自己推导根」和「`release` 自己 `drainQueue`」。实现跟随的是计划 Global Constraints，不记为缺陷。规格正文应改到和计划一致。

---

## 二、首轮已核对、与计划一致的部分（`10b1e35f01`）

- `turn-scheduler.ts` 不读盘。根键经过 `path.resolve`。同一根同时一个写者。忙碌队头不挡住后面空闲根。`activeTurns >= max` 时不再取出。脚本写者不增加 `activeTurns`。`soleCapWriterSessionId` 只数占名额写者。
- `parseConcurrentTurns`：缺省、非整数、非有限数为 3；小于 1 为 1；大于 8 为 8。读取不改文件。调低上限不取消已在执行的回合。
- `session.send` 在已开始、已排队、未启动时返回，不等 `whenIdle`。`waiting: true` 时 `started` 为 false。创建取消和更新失败是 HTTP 成功加原来的 `agent/notice`。队列保留 `skill` 与 `at` 并原样回放。
- 模型表只在 `followup` 受理后写入。根表在 `agents.create` / `agents.resume` 之前登记。`session.resume` 不调用 `admitUserTurn`。持久化 `cwd` 用 `isInside` 而不是要求等于前台根。
- 自动化去掉了跨根跳过、整次 tick 的空闲门和 `automationTail`。跳过项进入 `admissionSkips`，超过 10 分钟不记 missed、不停用。用户队列先于同一次释放里的自动化重评估。前台切换不再调用 `assertAutomationIdle`。后台发送不调用 `pinWorkspace`。
- 客户端 epoch、`turn-started` 和 `running` 只在直接 `started: true` 或 `session/queue-start` 时推进。排队应答把 `queueItemId` 写回已经插入的用户消息。设置项标签是「同时进行的任务数」。
- `deepseek-harness/` 不在这个提交范围内。

---

## 三、首轮：合并前必须修（已在 `1f968b5acc..c9ed075776` 修复，见 §0.1）

### R-1｜智能体子代理还在写，父回合已经放开项目根

- **证据**：
  1. `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:158-176`。`cleanup` 先调用 `releaseOnce()`，再 `await afterIdle()`。`scheduleDetachAfterIdle` 把这次 `cleanup` 挂在父会话 `whenIdle` 上。
  2. `releaseOnce` 进入 `releaseAndDrain`（`sessions.ts:688-692`），按该会话 id 删写者并启动同根上的下一条。
  3. 包内 `@slug` 返回 `afterIdle: () => cleanup('idle')`（`agent-package/host.ts:1089`）。这次清理先等 `activation.result`，上限是 `ACTIVATION_CLEANUP_TIMEOUT_MS`（10 分钟，`agent-package/host.ts:299-309`、`:799-817`）。同文件 `:302-305` 写明父会话 `whenIdle` 可以先于长子会话到达。`:790-791` 写明父会话可以在子代理仍在工作时变为空闲。
  4. 旧目录 `kind === "agent"` 同样把 `afterIdle` 设为 `cleanupLegacyRun("idle")`（`agent-invoke.ts:406-407`），空闲清理会等子代理结果（`agent-invoke.ts:286-287`）。
  5. 子代理在 `subagent/start` 复制父会话的可写根（`skills.ts:247-250`）。它不另占名额。桥接把子代理自己的 idle 留在子会话上，不把它当成父会话结束（`bridge.ts:208-211`）。
  6. 包内 `@slug`（`agent-package/host.ts:1042`）与旧目录 `kind === "agent"`（`agent-invoke.ts:383`）均以 `delivery: "parent"` 调用 `startActivation`；上游 `deepseek-harness/packages/subagent/subagent/src/manager.ts:1178-1200` 在 resolve `activation.result` 之前会先同步调用 `notifySettlement` → `parent.followup(message)` 唤醒父会话汇总子代理结果。
- **不在此列**：HTTP / MCP 的 `afterIdle` 只 `detachHostTool` 或 `dispose`（`agent-invoke.ts:174-178`、`:217-219`）。工具调用发生在父回合内，父会话空闲时工作已经结束。
- **后果**：包内智能体和旧目录智能体的子代理还可以再写最多 10 分钟。这段时间同项目根的队列项会启动。两个写者同时写这一根。即便等 `afterIdle` 完成，被 `delivery: "parent"` 唤醒的父会话汇总轮仍在运行，若不等父会话再次空闲就释放，仍会与下一条同根队列项重叠。规格 §4.1 要求子代理沿用父回合的名额。
- **修法**：`cleanup` 中先 `await afterIdle?.()`，随后再 `await acceptedAgent?.whenIdle?.()` 等被 `delivery: "parent"` 唤醒的父会话汇总轮也归于空闲，最后在 `finally` 里调用 `releaseOnce?.()`，避免收尾抛错时名额留下，也避免父会话汇总轮与下一条同根队列项重叠。`releaseOnce` 已有幂等标志，晚到的第二次 idle 不会释放下一回合。没有 `afterIdle` 的普通回合释放时点不变。

### R-2｜停止后的 idle 结束若赶在下一次排队应答之前，该标签的停止按钮会留下

- **证据**：
  1. 取消返回后 `settleStop` 记下过期空闲标记，并把该标签 `running` 设为 false（`App.tsx:2862-2869`）。此时 agent 的 idle 结束通常还没到。同一根的写者要等 `whenIdle` 才释放，所以紧接着的发送会排队。
  2. 桥接对一次停止可以发出两条结束：`agent/error` 的 abort 是 `cancelled: true`（`bridge.ts:224-226`），随后的 `agent/status === "idle"` 是不带 `cancelled` 的 `ok: true`（`bridge.ts:205-213`）。`consumeStaleIdle` 在 epoch 仍相同且事件带 `cancelled` 时保留标记；下一条不带 `cancelled` 的结束才删标记并放行（`stopGate.ts:89-98`）。
  3. 下一次 `session.send` 的 pending 已建立、而 `running` 已是 false 时，`holdEarlyEvent` 会把这条 `session/end` 和 goal 事件放进本次缓冲（`App.tsx:1607-1620`）。仍在执行的同会话回合有豁免；停止后的标签不在豁免里。
  4. 排队应答只重放 `queueItemId` 对得上的队列事件（`App.tsx:864-870`）。`started: false` 丢掉全部缓冲（`App.tsx:872`）。抛错走 `dropPending`（`App.tsx:2728`）。被丢掉的结束不经过 `consumeStaleIdle`。
  5. 之后 `queue-start` 或直接 `started: true` 把该标签 epoch 加一（`App.tsx:775-782`），不清 `staleIdleRef`。新回合自己的 `session/end` 对上另一代 epoch，被 `consumeStaleIdle` 丢掉（`stopGate.ts:94-98`），处理函数随即返回（`App.tsx:1632-1634`）。`running` 在开始时已设回 true，这条结束到不了。
- **触发条件**：idle `session/end` 到达时，同标签的下一次发送仍在等应答，且应答是排队、未启动或抛错。结束若晚于应答，pending 已删除，标记按原 epoch 正常消化。排队发送本身只做项目、任务、header 和设置读取，窗口是这一次 RPC，不是整个回合。
- **后果**：竞争命中时，新回合的结束被当成旧停止的空闲结束丢掉。停止按钮留着。若同时丢掉了本应把目标相位带离 `active` 的 `goal/state`，后面就算还有结束，也会被 `App.tsx:1801-1810` 当成目标中间结束，同样不清 `running`。
- **现有测试**：`appWiring.spec.ts` 里的 pending 用例锁的是源码顺序和纯函数，没有「停止 → 缓冲 idle 结束 → 排队应答 → 新回合结束」这条链。
- **修法**：在 `holdEarlyEvent`（`App.tsx:1607-1620`）中，当 `stopRequestedForSession(sessionId)` 为真或 `staleIdleRef.current` 仍存有该 `sessionId` 的过期空闲标记时，`session/end` 和 `goal/*` 事件立即走主处理链，不进这次发送的 `pending.buffered`。同时作为兜底，排队（`waiting: true`）、未启动（`started: false`）在 `takePendingBuffer`（`App.tsx:860-873`）丢缓冲以及抛错在 `dropPending`（`App.tsx:2728`）丢缓冲之前，先把缓冲里已接住的 `session/end` 事件按所属 epoch 送进 `consumeStaleIdle`（并在匹配时清理 `stopSessionId`）。补一条把上述时序串起来的接线测试。

### R-3｜超时后的 drain 先到期时，仍在运行的自动化改用前台根

- **证据**：
  1. `runAgentTurn` 在超时后取消会话，再等 `timedOutTurnDrainMs`（缺省 120 秒，`automations-host.ts:211-212`、`:311-327`）。注释写明取消可能打不中，`turn` 可以一直不结束。
  2. `finally` 无条件删除这次运行的 `huaanworkSessionRoots` 和 `huaanworkSessionModels`（`automations-host.ts:330-336`）。写者释放只挂在 `sendToAgent` 的 `whenIdle` 上（`sessions.ts:171-175`）。drain 先到期时名额仍占着，根表条目已经没了。
  3. `sessionWorkspaceRoot` 查不到会话根、也查不到父会话根时，返回 `huaanworkWorkspaceRoot.current`（`sandbox-cwd.ts:126-132`）。`policy.ts:223` 每次工具调用都读这个函数。Git、截图、diff 和包运行时同样读取。
  4. 模型表被删后，`resolveSessionModel` 对没有绑定的会话使用全局 `active`（`session-models.ts:55-62`）。
- **触发条件**：自动化先跑满 `automation_timeout_ms`（缺省 10 分钟），然后取消后的 120 秒内 `whenIdle` 仍未完成，且这个 agent 之后还调用工具。取消若在 120 秒内结束回合，删根发生在写者释放之后，不走这条路径。
- **后果**：还在执行的工具写用户当前看着的目录。那个目录可以已有自己的写者。原来的项目根继续占着名额，队列不再启动。随后的模型请求改走全局条目。
- **现有测试**：`automations-host.spec.ts:1114` 的标题写 “returns the writer”。断言是 `inFlight` 仍大于 0（`:1140`），注释写的是 release 不触发（`:1138-1139`）。第二条自动化在另一个项目根上，这个测试看不出第一根的沙箱是否还在。
- **修法**：把 `ctx.huaanworkSessionRoots.delete(sessionId)` 与 `ctx.huaanworkSessionModels.delete(sessionId)` 放到这次 `turn` 真正 settle 之后（如 `turn.finally(...)`），而 **`automationCollector.delete(sessionId)` 与 `unattended?.delete(sessionId)` 保持在 `runAgentTurn` 的 `finally` 中立即清理**（`finishAutomation` 在 `runAgentTurn` 返回后即落盘超时记录，保留 `collector` 会造成无人读取的内存累积；超时且 120 秒 drain 仍未结束的失控回合不应继续持有 `unattended` 自动放行特权；同时保持 M4 D-1 门禁测试 `automations-host.spec.ts:1146-1147` 不退化）。drain 到期只说明 bookkeeping 不再等待，不能在工具还可能执行时删根/删模型，也不能提前 `release`。测试改为断言根表与模型表在 `turn` 未 settle 时仍保留准入值、待 `turn` settle 后才删除，并改掉 `automations-host.spec.ts:1114` 与断言相反的标题。

---

## 四、首轮：合并前应补上（已在 `f6ab191529..01c16f2205` 修复，残余见 Important-1）

### R-4｜出队之后、`queue-start` 之前，取消和删除都够不着这条消息

- **证据**：
  1. `drainQueue` 先把项移出队列并写上写者（`turn-scheduler.ts:154-167`）。`startQueuedItem` 再读设置、调用 `sendToAgent`（`sessions.ts:731-758`）。
  2. `followup` 在 `sessions.ts:265-270` 受理。`session/queue-start` 要等 `rememberTaskModel` 之后才发（`sessions.ts:763-770`）。
  3. `session.cancel` 带 `queueItemId` 时只调用 `cancelQueuedItem`（`sessions.ts:855-860`）。项已经不在队列里，宿主仍返回 `{ accepted: true }`，不调用 `cancelAgent`。
  4. 客户端在 RPC 前就把等待文案撤掉，并把消息标成未启动（`App.tsx:2759-2764`）。随后的 `queue-start` 找不到归属消息时，`queuedTurnRunState` 只收等待项，不开回合（`App.tsx:833-837`、`App.tsx:4264-4267`）。
  5. `releaseSessionRuntime` 也只扫队列（`sessions.ts:488-491`）。删除若落在这段异步里，`startQueuedItem` 仍会把文本交给 agent。
- **后果**：界面还显示「等待当前任务」时，取消看起来成功，宿主随后仍可能 `followup`。回合已经开始而 `queue-start` 未到时，token 写到未启动用户消息的前面，也就是上一回合的位置（`App.tsx:4202-4208`）。`rememberTaskModel` 只是一次任务读取加可能的写回，整段结束赶在 `queue-start` 之前并不常见；取消窗口则从出队一直延伸到 `queue-start`，其中包含 `ensureChannelAgent` 最长 15 秒的等待。
- **修法**：出队后、`followup` 前的项按 `queueItemId` 和 `sessionId` 登记为可取消。取消和删除中止这次启动，`releaseAndDrain`，发 `session/queue-fail`，不发 `session/queue-start`。`queue-start` 紧跟 `followup` 受理发出，放在其后的 `await` 之前。在此之前，这个会话的流式事件先按这条等待消息暂存，`beginQueuedTurn` 之后再重放。

### R-5｜create / resume 使用的根不是队列项上锁住的根

- **证据**：
  1. 规格 §5.1.1 和计划 Task 6 要求 `ensureChannelAgent` 与恢复路径接收准入时算好的根，执行时不再推导。
  2. `sendToAgent` 调用 `ensureChannelAgent(ctx, routeCtx, sessionId)`（`sessions.ts:186`），没有传入 `admission.root`。
  3. 表里没有条目时，函数重新读取项目、任务和 header（`sessions.ts:311-322`），并在 create / resume 前写下推导结果（`sessions.ts:329-334`）。`followup` 之后只有表里还没有这个会话时才写 `admission.root`（`sessions.ts:275-277`）。已有条目不会被队列项上的根替换。
  4. 已有 live agent 时函数直接返回（`sessions.ts:305-306`），同样不看队列项。
- **后果**：项目、任务和 header 在排队期间不变时，重新推导和队列项通常是同一个目录，沙箱不会写错。任务改绑、项目登记变化，或 header 回退与任务绑定在两次推导之间出现差异时，写者锁留在队列项的根上，工具写的是另一根。那一根可以再接纳一个写者。`sessions.spec.ts` 里对应断言能过，是因为两次推导用的是同一份不变输入。
- **修法**：把 `admission.root` 传进 `ensureChannelAgent`。create / resume 前登记这一条，不再覆盖，也不在已有 live agent 时改用另一套推导。自动化在 `sendToAgent` 之前写入的根保持不动。补一条「排队期间任务改绑，执行仍用队列项上的根」的测试。

---

## 五、首轮：可后做（已在 `d2274bc723..f19900eae8` 修复，见 §0.1）

### P-1｜任务模型写回没有回到客户端

`resolveSendModelId` 的顺序是标签手选、任务 `modelId`、全局 `activeModelId`（`Settings.tsx:45-51`）。`send()` 用当时的 `projectTasks` 取值（`App.tsx:2638-2642`），成功后不刷新任务。宿主在 `followup` 后才 `rememberTaskModel`（`sessions.ts:780-784`），且已有 `modelId` 的任务不再改写。刷新发生前，客户端仍认为任务没有 `modelId`。用户若在这之前改了全局模型，下一次发送会把新 id 写入会话表，任务文件保留第一次的 id。进行中的生成不受影响。发送区显示的就是这次会送出的 id。

修法：RPC 前把实际送出的 id 记入 `modelPickByTab`；宿主写回后刷新任务，让 `task.modelId` 优先。

### P-2｜脚本在 spawn 成功之后仍可能因 `error` 提前结束

`runScript` 在 `error` 上调用 `finish`（`automations-host.ts:451`）。启动失败没有进程，这样结束是对的，也和函数注释一致。`kill` 失败也会发出 `error`。`finish` 之后 `executeRun` 的 `finally` 调用这次运行唯一的 `releaseOnce`（`automations-host.ts:637-644`）。进程若还活着，同根的下一回合可以开始。超时路径本身等的是 `close`（`:452-456`）。

修法：只有从未 spawn 成功时，`error` 才立即结束。spawn 之后等到 `close`。

### P-3｜没有 parent 的子代理仍读进程级调用者槽

`noteCallerSession` 把最近一次 `sendToAgent` 的会话写进模块级 `callerSessionId`（`child-sessions.ts:55-60`）。`skills.ts:301` 和 `:370` 在 `parentFromStartArgs` 没有 parent 时用 `currentCallerSession()` 作为继承父会话，随后复制模型和根。`@` 显式传入 parent（`agent-invoke.ts:377-380`）。模型自己发起且参数里没有 parent 的子代理，会在另一次发送改写这个槽之后继承错误会话。

修法：没有 parent 就不要继承。不要用这个进程槽填模型和根。

### P-4｜其余小项

- `writable-root.ts:42-47` 在判断 `header.cwd` 之前调用 `neutralWorkspaceRoot`，推导阶段就会 `mkdirSync`。目录创建留到这次发送确实使用中立根的时候。
- `writable-root.spec.ts:186-190` 对任务和会话各调用了一次 `freshSessionIdFor(project)`，两个 id 不同。第一条期望能过，是因为会话 id 命中稳定 id 前缀，不是因为悬挂任务回落。悬挂任务的回落是下一条 `legacy` 断言。
- `sessions.ts:324-326`：持久化 header 没有 `cwd` 时跳过 `isInside`，恢复继续。缺 `cwd` 按越界拒绝，沿用「请先打开对应项目」。
- `sessions.ts:720-728`：`session/queue-fail` 的 `emit` 若抛错，`releaseOnce` 不会执行。释放放进 `finally`。
- `bridge.ts:302-318`：没有唯一占名额写者时仍对前台根做 diff 快照，再发出没有 `sessionId` 的事件。客户端在 `App.tsx:1785-1787` 丢掉它，不会画到当前标签。没有归属会话时不做这次快照。
- `Settings.tsx:375-384`：输入先写入用户刚打的数，宿主回写后再换成夹紧值。保存结果是夹紧后的值，中间会闪一下。
- pending 按标签 id 存放（`App.tsx:2652-2658`），`finally` 只清 `sendingRef`。同一标签的发送护栏挡住了重叠。计划里的 `tabId + userMsg.id` 仍未落地。
- `routes.ts:1224-1236`、`AutomationsView.tsx:170-178`、`turn-scheduler.ts:106-115`：手动点「立即运行」（`automation.run`）复用 `scheduler.admitAutomation`，撞上同根写者或全局名额上限时：一是 `admitAutomation` 无条件把 `automation.id` 记入只服务定时调度的 `admissionSkips`，污染下次定时触发的 `missed` 豁免；二是路由返回 `{ queued: false, waiting: true, runId, workspaceRoot }`，但手动运行没有重评估队列，前端 `AutomationsView.tsx:170-178` 也未检查 `queued` / `waiting`，用户点击后无任何提示且不会自动补跑。应为 `admitAutomation` 区分手动与定时（手动跳过不写 `admissionSkips`），并在前端或路由层对手动运行被拒给出明确反馈。
- `sessions.ts:94-109, 264, 862`：单槽与阻塞器死代码残留。规格 §5.5 指明删除的 `sessionSendBlockers` 与 `assertSessionSendable` 仍留在 `sessions.ts`（`workspaceDisplaced` 恒为 `false`，仅 `sessionCancel` `:862` 调了一次空检查，测试与外部零引用）；`sessions.ts:264` 仍在写 `ctx.huaanworkRouteAgent.current = agent`，生产代码没有读取方。工具会话来自本次执行上下文里的 agent（`agent-package-tools.ts:86-92`）。该对象仍被传入 `registerCallHostTool` 的上下文（`index.ts:332`），那个函数本身不读它。仓库里没有 `huaanworkLiveAgents`。

---

## 六、结论

当前口径见文首与 §A（2026-11-07 Grok 复核）。§6.1 只保留 2026-11-06 对 `f19900eae8` 的三轮结论。

### 6.1 三轮校准结论（当时的 HEAD `f19900eae8`）

核对依据见 §0.5。二轮把 Important-1 与 Important-2 并列成合并阻断，这里改口径。

1. **合并前要修 Important-1 的写入时点。** 根表和模型表还没有该会话时，在 `dispatchAt` 之前写入本轮准入，未启动再还原。这样包进程不会落到前台目录，子代理也不会复制到旧模型或空根。已经登记过根的会话不要改写，准入继续用根表里的那条路径。
2. **Important-2 值得修，不与跨项目启动放在同一档。** 交付物核对在前台目录非空时忽略会话自己的 `cwd`，可能误报「缺少文件」。它不写别的项目。规格 §1 没有二轮引用的那条不变量。
3. **Minor-3 是「名额已满仍提示同根忙」。** 跳过应答带上 `reason`，两种原因各用一句文案。Minor-1、Minor-2 属实，可以同轮带上。Minor-4 不挡合并。

### 6.2 首轮历史结论（`10b1e35f01`）

**不能合并。**

R-1 在智能体子代理的正常路径上放开项目根，子代理还可以再写最长 10 分钟。R-2 在规格点名的应答 / WebSocket 乱序下会留下停止按钮；它不是每次停止后再发送都发生，但命中后该标签没有自愈。R-3 只在超时取消后的 120 秒 drain 失败时出现，出现后仍在运行的工具改写前台项目，原根的名额也不释放。这三项修完之前不合入。

R-4 和 R-5 应在同一轮补上。前者让「等待当前任务」上的取消在出队后失效；后者让排队期间冻结的根没有真正传给创建和恢复。P-1 到 P-4 不挡这一轮合并。
