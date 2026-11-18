# 复杂任务与子 agent 右侧进度面板设计规格

- 日期：2026-11-15（2026-11-17 基线重校、§16–§18 复核闭环及 §14.2 自动化走查口径修订）
- 状态：设计已确认；已吸收独立设计评审（含 §7 复核）、实施计划评审（PC-1/PC-2/PI-1/PI-2/PM-1…PM-6）、owner 选项 2 裁定（2026-11-15）、共享回合锚点契约修订（2026-11-15，含 UUID 与自动化 runId 锚定修正）、PR #29 复审修订、[实施计划评审 §16–§18](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-implementation-plans-review.md#L580-L807)（`QP-I1`…`QP-I6`、`QP-M1`…`QP-M4`、`QR-I1`、`QR-I2`、`QR-M1`、`QR-M2` 及复核补遗）闭环修订，以及 2026-11-17 §14.2 agent 真机走查自动化测试更新；实施计划已同步闭环
- 基线：外层仓库 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`（已合入 `#29 feat/chat-created-skills`）；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`dsh-v0.2.1-alpha.2-981-g1600d8a1e1`）
- 范围：HuaAnWork 高级模式右侧“进度”页、父会话 `subagent` 工具可见性、系统技能派生运行纳管，以及分步任务、工具活动和受管子 agent 的聚合投影
- 约束：只改 `dsh-plugin-huaanwork/` 及必要的自有共享包（本规格为 `packages/huaanwork-policy`）；不修改 `deepseek-harness/`；复用并扩展现有 run registry，不新建第二套宿主执行状态机

## 1. 背景与结论

右侧“进度”目前是空占位，但主要展示数据已经存在：

1. 实时 `todo_write` 被转换为当前回合的 todo 快照。
2. `projectToolPanels` 已把工具调用按用户回合和 `step/start` 轮次组织成看板。
3. 显式 `@agent` 与智能体包 `@slug` 已有 Host 权威 run registry、WebSocket 投影、快照对账、定向取消和客户端 reducer。
4. 子 agent 活动已有相位、工具摘要、计时和告警，不需要把子会话正文并入父会话。

同时，当前普通父会话的模型仍可见 `subagent` 工具；`explore/test-fix` 也依赖该工具派生子运行。只做前端投影会留下“用户选择让所有子 agent 受管，但系统技能派生运行仍无运行卡”的缺口。

根据 owner 最新裁定，一期采用**宿主工具可见性控制 + 系统技能运行纳管 + 现有状态的前端聚合投影**。这里的“所有子 agent 都受管”指所有允许发起的派发都受到明确策略约束，普通父会话不能自主绕过 registry，系统技能派生运行可展示和定向取消；不等于每个包 lane/孙代都必须在一期拥有独立运行卡。

## 2. 目标与非目标

### 2.1 目标

1. 模型通过 `todo_write` 拆解任务后，右侧“进度”同步展示各分步内容和状态。
2. 展示整体完成数及由完成数计算的总进度，不虚构单步百分比。
3. 展示当前回合的模型轮次和工具执行活动。
4. 普通交互父会话和自动化父会话在非系统技能回合不向模型暴露 `subagent`；显式 `@agent/@slug` 的宿主派发保持可用。
5. `explore/test-fix` 回合按现有附件机制临时开放 `subagent`，其派生运行进入同一 registry，具备状态、快照和定向取消。
6. 包儿童按既有血缘和包 allow 保留必要能力；包 lane 继续受 C4/C5 约束，并聚合到父包运行卡。
7. legacy 儿童不能直接或经 `skill(explore/test-fix)` 间接自主派生未纳管后代。
8. 会话切换、断连、重连、快照对账和历史加载使用一致的会话归属与状态语义。
9. 保留会话主流中的待办卡、工具看板和子 agent 卡；右栏是同一状态的另一视图。

### 2.2 非目标

- 一期不为包儿童继续派生的 lane/孙代建立独立运行卡或独立取消入口；其运行仍受包血缘约束并随父包生命周期收尾。
- 不新增持久化 Task Store、任务级 SLA 或第二套进度事件通道。
- 不全局删除 `subagent` 工具、不禁用 profile 中的 `tool-subagent`，也不移除宿主 `ctx.subagents` 服务。
- 不根据工具数、token 数、耗时或子 agent 相位推断业务完成百分比。
- 不在缺少关联 ID 时猜测 Task 与工具调用、子 agent 的从属关系。
- 不把子 agent 的 reasoning、token 正文或完整工具输出引入父会话。
- 不改变 `todo_write` 全量替换语义，也不改变既有受管运行的严格停止语义。
- 不批量修改旧日志或上游 `step/start` 协议。

## 3. 已确认的产品裁定

| 编号 | 裁定 |
| --- | --- |
| R1 | owner 选择选项 2：在普通父会话对模型隐藏 `subagent`，保留宿主服务和包 lane 所需的受控能力 |
| R2 | `explore/test-fix` 采用“条件可见 + 纳管”：命中回合临时挂载，派生运行进入 registry，可展示和定向取消 |
| R3 | 采用宿主纳管与前端聚合的组合方案；进度面板不再是纯前端-only 改造 |
| R4 | 包儿童不能因全局隐藏而失去合法 lane 派发；legacy 儿童的直接和技能间接派发均需封闭 |
| R5 | 包 lane 一期聚合到父包运行卡；未来独立建卡使用 `parentRunId/depth`，不在本期暗增 |
| R6 | 没有关联 ID 时，任务、工具活动和子 agent 分区展示，不做模糊匹配 |
| R7 | 总进度只等于 `completed / total`；活动中的单步不显示虚构百分比 |
| R8 | 历史 `todo_write` 投影纳入本需求，实施时同步关闭 `AGENTS.md` 中的活跃债并在 `docs/project-memory-archive.md` 闭环 R-12 归档 |

## 4. 方案取舍

| 方案 | 优点 | 主要缺陷 | 结论 |
| --- | --- | --- | --- |
| A. 父会话隐藏 + 系统技能条件纳管 + 现有状态选择器 | 所有允许派发均有明确边界；复用 registry；右栏无第二事实源 | 需要修改工具可见性、系统技能生命周期和 registry 类型 | **采用** |
| B. 仅做现有状态的前端投影 | 改动最小 | 普通父会话仍可自主派发；系统技能运行不可见，不满足选项 2 | 排除 |
| C. 全局从 ALLOWED_TOOLS 删除 `subagent` | 表面简单 | 会破坏包儿童合法 lane 和系统技能；不符合分层 restrict 语义 | 排除 |
| D. 新增 Host Task/Progress Store 与专用 WS 通道 | 可支持更细粒度关联和长期持久化 | 与 todo、registry 重复；仲裁、迁移和恢复成本高 | 后续有明确数据需求再立项 |

## 5. 现有事实源与复用边界

| 能力 | 现有位置 | 本需求用法 |
| --- | --- | --- |
| 有效工具计算 | `present-as.ts` 的 `ALLOWED_TOOLS ∪ 会话附件`、`refreshAgentRestrict` | 按会话类型和临时附件决定 `subagent` 可见性 |
| 系统技能调用标记 | `skills.ts` 的 `pendingByAgent`、token 归属兼容槽与 `tools/execute` ALS，及共享租约 `kindOf` | 识别模型调用 `skill` 与显式 `/explore`/`/test-fix` 入口及其派生调用 |
| 子 agent 宿主服务 | `ctx.subagents.startActivation` | 显式 @ 与包路径继续走宿主服务，不依赖父会话模型工具 |
| 模型面工具 | 上游 `tool-subagent`，最终走 `startActivation`（上游 `tool-subagent/src/index.ts:330`） | 系统技能纳管挂在 `startActivation` 包装，不误挂到仅处理 start 的分支 |
| 包血缘 | `huaanworkPackageChildSessions`、`huaanworkPackageChildAllow`、C4/C5 | 包儿童识别与 lane 收窄；不能全局删工具 |
| todo 快照 | `App.tsx` 的 `upsertTodoItem`、`ChatItem kind="todo"` | 当前回合最近一次完整快照 |
| 工具轮次 | `logic/toolPanel.ts` 的 `projectToolPanels`、`splitRounds` | 当前执行活动与六态工具状态 |
| 子 agent 状态 | `logic/subagentRuns.ts`、`huaanwork-host/subagent-runs.ts` | 系统技能与显式 @ 共用状态、快照、计时和告警 |
| 定向取消 | `confirmCancelSubagent`、`subagent.cancel` | 系统技能运行复用同一实例级取消 |
| 回合锚点 | 新增 `huaanwork-host/turn-anchors.ts`（§6） | todo 归属、运行卡锚定与 Artifact 定位共用的会话级回合身份 |

既有 Host registry 继续是受管运行状态的唯一权威；右栏不得另建一份可独立改变状态的运行记录。

## 6. 共享回合锚点契约（通用前置）

本节是**本规格与任务结果 Artifact 规格共用的唯一回合锚点契约**。Artifact 可消费本模块，但不依赖 ProgressPanel 组件或右栏状态；本模块由本规格的实施计划通用前置任务唯一提供，Artifact 计划不得另起不兼容设计。

### 6.1 模块与注入

- 新独立模块：`dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts`。
- `holders.ts` 安装宿主 holders 时创建 store 并经 Cordis 注入 `ctx.huaanworkTurnAnchors`；禁止模块级全局单槽，运行期状态只存在于 store 实例内。
- store 内部 `pending`/`anchors` 两张表均为有界 LRU（容量 256，按会话 id 键控，超界淘汰最久未用条目）。

### 6.2 类型与接口

```ts
type TurnAnchor = {
  clientMessageId: string;
  startedAt: string; // ISO 时间，回合执行前记录
  origin: "advanced" | "automation" | "unknown";
};

type TurnAnchorStore = {
  register(input: { sessionId: string; clientMessageId: string; origin: TurnAnchor["origin"] }): () => void;
  /** 在 step 执行前记录；对同一消息幂等；goal 续轮保留原 anchor。 */
  notePreStep(sessionId: string, messages: readonly unknown[], startedAt: string): TurnAnchor | undefined;
  current(sessionId: string): TurnAnchor | undefined;
  clearSession(sessionId: string): void;
};
```

### 6.3 发送侧契约（客户端 → 宿主）

1. App 每次 `session.send`（不只 `@`）都生成 `const clientMessageId = crypto.randomUUID()`（渲染进程先例见 `Settings.tsx` 的 `crypto.randomUUID()`；**不复用 `allocId()` 数值 id**——刷新后数值可重复，不满足上游 MessageId 稳定唯一要求），写入本地 `ChatItem user.clientMessageId`，并作为**顶层** `clientMessageId` 随 `session.send` 发送。
2. `@` 发送现有的 `at.clientMessageId`（`String(userMsg.id)`）保留不动，仅供旧 @ 运行卡展示匹配兼容；新锚定一律走顶层 UUID + `user.clientMessageId` 精确匹配。
3. 顶层 `clientMessageId` 必须随调度器排队项透传（`turn-scheduler.ts` 的 `QueueItem`/`admitUserTurn` 扩展该字段），出队重建 `sendToAgent` 参数时不丢失。
4. 自动化运行回合：`automations-host.ts` 的 `runAgentTurn` 调 `sendToAgent` 时传顶层 `clientMessageId = runId`（`automation/run-start` 已携带同一 runId）；App 在 `automation/run-task` 创建/补齐运行标签时，插入该回合的用户条目并设 `user.clientMessageId = runId`。这样自动化会话的实时 todo 与系统技能主流卡都能精确匹配，不必等待快照或历史。运行标签首条用户消息文案用任务名（历史恢复时显示真实 prompt 文本）；锚点只依赖 clientMessageId，不依赖文案。

### 6.4 宿主侧契约

1. Host 采用 `顶层 clientMessageId ?? randomUUID()` 作为 followup `UserMessage.id`（**不使用 `at.clientMessageId` 兜底**——旧数值 id 刷新后同样可能重复；旧客户端缺顶层时 Host 生成 UUID，旧 @ 展示逻辑不变）。
2. followup 受理前调用 `register`：普通高级会话 `origin: "advanced"`；自动化运行会话（`huaanwork-auto-` 前缀）`origin: "automation"`；仅经 pre-step 观察到、从未登记的普通用户消息记 `origin: "unknown"`。`register` 只写 pending，返回精确回滚闭包；followup 抛错时调用该闭包，只移除本次 pending，不得清掉上一回合 anchor，也不得留下永不被消费的登记。
3. turn-anchors 模块在宿主侧监听 `agent/pre-step`（上游载荷 `{ agent, messages, turn, signal }`），在 step 执行前用自己的载荷调用 `notePreStep(sessionId, messages, startedAt)`。监听器**必须 `return next()`**；`notePreStep` 从自己的事件载荷读取消息，与 bridge、Artifact 等其他 `agent/pre-step` 监听器的注册次序无关。
4. `notePreStep` 语义（`QP-I4` 人类回合分类与非人通知隔离）：从 `messages` 末尾向前查找最近一条 `role === "user"` 且带字符串 `id` 的消息时，**只把真实用户开启消息（`source.kind === "user"`，或旧测试/旧日志缺 `source` 时的空 `kind === ""`）与 `source.kind === "goal"` 纳入回合锚点状态机**：
   - 凡 `subagent-settled`、`agent-instructions`、`user-question-reply`、`user-approval`、`working-directory`、`skill-catalog`、`skill-invocation`、`runtime-context` 等非人类/系统插件注入的 `role: "user"` 通知消息，一律**不得切换 anchor、也不得写成 `origin: "unknown"` 的新回合**，继续向前扫描或保持原 anchor 不变；
   - `source.kind === "goal"` 的续轮**保留原 anchor**（`clientMessageId` 与 `startedAt` 均不换成新 wall-clock）；无原 anchor 时 fail closed（返回 `undefined`，不得猜测）；
   - 仅普通用户消息（`source.kind === "user" | ""`）读取并消费 `pending`（未登记时以 `origin: "unknown"` 补记；与现有 `clientMessageId` 相同则保持 `startedAt` 不变）；无新用户消息或仅含系统通知的 step 不改动 anchor。调用后返回当前有效 anchor，供 Artifact 等 listener 在不依赖注册顺序的情况下消费。
5. 会话释放与删除时同步清理：不仅监听 `session/disposed`，`session.remove` 调用的 `releaseSessionRuntime` 也须执行 `clearSession(sessionId)`（含稳定通道会话被删除后同 id 重建的场景）。

### 6.5 消费侧契约

1. bridge `tool/start` 事件增加 `clientMessageId = store.current(sessionId)?.clientMessageId`（保留既有 `roundKey`）。
2. todo 归属判定：当前回合 `user.clientMessageId` **精确匹配**事件 `clientMessageId`（**todo 不采用运行时才授权给旧 `@` 运行卡的数值 `String(id)` 兼容回退**，无锚 user 条目一律 fail-closed），且 `roundKey` 必填、不小于当前 todo 快照的 `roundKey`；不再用“上一回合最大 roundKey 扫描”（`previousMaximum > -Infinity`）推断。goal 续轮事件携带原 anchor id 自然通过；无锚事件、部署边界事件、上一回合迟到事件一律 fail-closed 不更新。当 `session.send` 尚未返回 `started: true` 而本回合的 `tool/start(todo_write)` 先到达时，客户端须暂存并待回合开启后重放——包括并发排队下 `waiting` 应答到达前该队列项已启动并提前送出 `session/queue-start` + 首条 `tool/start(todo_write)` 的交错情形（按 `queueItemId` 确认本次队列项已启动且按发送 `clientMessageId` 匹配保留，未启动/失败或他回合事件仍丢弃），不得因本地 `user` 条目尚带 `notStarted` 或 `waiting` 过滤丢弃首条 todo。
3. `ChatItem user` 与 `HistoryChatItem user` 增加可选 `clientMessageId`；条目数值 `id` 仍由 `allocId()` 分配，不复用、不编码锚点。`session-view.ts` 对 `user/message` 采用与 `notePreStep` 一致的真实用户白名单：`kind === "user"` 或旧日志缺省 `kind === ""` 才生成普通 `user` 历史记录、从 `data.id` 透传 `clientMessageId` 并推进顺序扫描跟踪的“当前普通用户消息 clientMessageId”；`kind === "goal"` 且 `round > 0` 时保留 `goalRound` 且**不清空**当前普通用户 id；`subagent-settled`、`runtime-context`、`agent-instructions`、`skill-catalog`、`skill-invocation`、`user-question-reply`、`user-approval`、`working-directory`、`compact-checkpoint`、`plugin`、`tool` 等一切系统/插件消息既不生成历史普通 `user` 条目，也不推进当前普通用户 id（`summarizeSessionLog` 同步过滤非人类消息）。`todo_write` 的 `tool/call` 历史记录同时携带结构化 `todos`、当前普通用户 `clientMessageId` 与既有 `roundKey`。
4. `insertSubagentRunCard` 精确匹配 `user.clientMessageId`（旧数据/旧测试可用 `String(id)` 兼容）；**实时事件禁止 last-user 回退**，只有 snapshot 对账沿用既有 `allowSnapshotFallback`。
5. 降级诚实声明：自动化运行回合的锚定为宿主分配的 runId，若运行标签尚未建立（`automation/run-task` 未到达），实时主流卡可能无精确落点——此时不得回退最后一条用户消息，等历史加载（session-view 透传同一 id）或 snapshot 对账落卡；右栏按 `parentSessionId` 实时展示不受锚点影响。旧日志没有 clientMessageId 的用户记录不伪造锚点。

## 7. 子 agent 可见性与纳管架构

### 7.1 有效工具矩阵

| 会话/执行环境 | 模型可见 `subagent` | 运行呈现与控制 |
| --- | --- | --- |
| 普通交互父会话 | 否 | 显式 `@agent/@slug` 仍由宿主派发并进 registry |
| 有人值守的自动化父会话 | 平时否；命中系统技能时按下一行临时开放 | 不改变既有自动化执行模型，系统技能派生运行同样纳管 |
| 无人值守的自动化父会话 | 否 | 既有无人值守白名单不含 `skill`，不能进入系统技能条件开放路径；不为其新增隐式例外 |
| 命中 `explore/test-fix` 的父会话回合 | 仅该技能执行上下文临时可见 | 每次派生均建立 `system-skill` 运行，可展示和定向取消 |
| explore/test-fix 派生的子会话 | 否 | 其现有只读/测试工具收窄不变，不能继续自主派生 |
| 智能体包儿童会话 | 仅在包 allow 与血缘均允许时可见 | lane 受 C4/C5 约束，聚合进父包运行卡；一期无独立 lane 卡 |
| legacy 儿童会话 | 否 | 同时拦截经 `skill(explore/test-fix)` 的间接派生 |

无法明确识别为合法包儿童或系统技能执行上下文时，`subagent` 默认不可见，不能因分类信号暂时缺失而 fail-open。

`tool-subagent` profile 行保持启用，因为系统技能临时附件和包儿童仍需要模型面；`ctx.subagents` 服务与工具可见性是两个独立层面。

### 7.2 系统技能条件可见

1. 本轮命中 `explore/test-fix` 时，统一覆盖**两条真实入口**并经共享系统技能租约与附件机制控制 `subagent` 可见性与派生类型：
   - **模型调用 `skill` 工具路径**：`tools/pre-execute(name="skill")` 先执行受管儿童/策略拒绝守卫，再申请系统技能租约（**仅当租约取得成功时**才写 `pendingByAgent`，避免缺锚/无人值守返回 `false` 时留下陈旧缓存）并挂载 `subagent`、刷新 restrict，供后续 step 模型调用；
   - **显式 `/explore`、`/test-fix` 入口（`session.send.skill`，含直接发送与排队出队）**：由于 `invokeSkillText` 直接把技能正文编入用户消息而不走 `tools/pre-execute(name="skill")`，且上游 `systemPrompt.assemble()` 在 `agent/pre-step` 之前采集 Step 1 的工具目录，宿主 `sendToAgent` 必须在 `agent.followup` **之前**完成安全守卫校验、登记系统技能身份与租约、**同步清掉/失效该会话既有活 `agent` 上残留的旧 `pendingByAgent` 缓存**（防止 active goal 轮间保留的旧模型技能优先覆盖显式新租约）、挂载 `subagent` 附件并刷新 restrict（`followup` 抛错时立即精确回滚租约与附件）；`tools/execute(name="subagent")` 同源读取 `pendingByAgent` 或共享租约 `kindOf(sessionId)` 建立 ALS 作用域，确保 Step 1 即可调用 `subagent`、产生 `system-skill` 运行并收窄子代工具。
2. 挂载只保留到当前技能所属用户回合的权威终结；正常完成一轮后的 `agent/status idle` 若处于 `goal.phase === 'active'` 轮间态不得提前解挂（active goal 状态须独立于租约本身维护，即使 goal 先于系统技能租约激活，后续轮次取得租约后在正常轮间 idle 仍不得提前解挂）。
3. 回合失败（`agent/error`）、中断/异常 `turn/end`（`aborted`/`error`）、回合自然完成，以及会话释放/删除（`session/disposed` / `releaseSessionRuntime`）后必须**无条件解挂、清理租约与对应 `pendingByAgent` 状态（即使当前无活跃租约也触发清理通知，防止遗留缓存）并再次刷新**；注意上游 `goal-round-driver` 在 `agent/error` 或部分中止路径会 `disarm` 并保留持久 `goal.phase === 'active'`，不得在这些路径按 active goal 保留租约（且必须同步清除进程内的 active goal 轮间保留标记）；下一回合必须重新命中系统技能或显式 `/explore`/`/test-fix` 才能再次获得工具。
4. 技能未实际派生子 agent 时，回合结束同样清理附件，不留常驻能力。
5. 挂载期间每次 `subagent` 调用仍按 `restrictKind` 使用对应系统技能的子代 allow，不扩大子代工具权限。

租约判定守卫：`无人值守自动化 → 拒绝；受管子代理会话（legacy/system-skill 等无包血缘条目的儿童，判别见 §7.4）→ 拒绝；缺附件表 → 拒绝；模型 skill 工具入口另须当前回合已有锚点（turnAnchors.current 存在），缺锚即拒绝`。显式 `/explore`、`/test-fix` 入口已为本次发送调用 `turnAnchors.register` 登记待决锚点并在 `agent.followup` 前预挂载（`followup` 抛错即回滚），因此不要求前置 `current` 锚点。该“受管子代理”早退是**正确守卫**（这些儿童不得获取回合租约），不是顺序缺陷，命名与注释必须表达这一意图，防后续误改。

### 7.3 系统技能运行进入 registry

模型工具最终触发 `startActivation` 包装时，在任何启动 `await` 之前建立运行记录：

1. `begin({ kind: "system-skill", parentSessionId, label, clientMessageId? })` 生成 Host `runId`；clientMessageId 取自 §6 `store.current(parentSessionId)`，无锚则不带（fail closed 到右栏展示，不回退最后用户消息）。`effectiveRunId = hostRunId ?? systemRunId` 须同时进入 `startRun.run` 与包装内的三方 parent 一致性 fail-closed 检查。
2. activation 返回后绑定实际 child；有非空预留 `specChildId` 时必须在 `startRun.run` 与首个启动 `await` 之前先 `reserveChild`，仅当预留了非空 `specChildId` 而实际 childId 不符时按缺失同一路径 dispose + failRun + 抛错（上游 `tool-subagent` 默认不传 `childId` 时不视为不匹配）；收到 `subagent/start` 后绑定 `upstreamRunId`（复用既有 ALS 与监听，见下）。
3. **registry 服务缺失必须抛错**（“subagent run registry is not initialized”，与 legacy 路径同形），不得用可选链把 `begin` 静默吞掉导致派发不受管。
4. activation 返回后 childId 不可解析（或非空 `specChildId` 不匹配）：先 `dispose` 本次 activation，再标记 `failRun` 并同步完成清理确认，再抛错（与 C4 血缘分支同形；注意避免外层 `catch` 二次 `failRun`）。
5. activation 启动抛错走 `failRun` 并完成清理确认；结果与上游 end 冲突继续沿用现有终态仲裁。
6. **生命周期**：`ActivationRun` 保持 `childId?: unknown` 边界解析，并将上游 handle 恒有的 `result` 与 `dispose` 声明为必填（共享清理 helper 入参收窄为 `Pick<SubagentActivationHandle, 'dispose'>`）；提前注册 `attachCancel`（覆盖 `startActivation` pending 期取消，若取消时未取得 activation 则在启动失败或晚到返回时统一收敛）；以 `observeResult` 挂 `result.then(settleResult, rejectResult)` 提供 `executionEnded`（决不走只表示启动失败的 `failRun`）。`attachCancel` 闭包 = 置取消闩 + abort + 若已有 activation 则 `await cleanup('cancel')` → `confirmCleanup(runId, { ok, warnings })`；若取消发生在 `startActivation` pending 期且随后启动 reject / childId 异常，必须同时调用 `failRun` 与清理确认，避免因 `cleanupOk` 缺失而永久停在 `stopping`。停止预算覆盖三段：graceful result 等待（超时记 `noteCleanupBudget` 后转入 dispose）、dispose 等待、dispose 完成后 result 仍未结算的观察窗（**必须使用不吃已中止取消信号的独立超时原语**，避免复用已 abort 的 `controller.signal` 导致 0ms 短路；超窗由 `rejectResult` 补 `executionEnded`）。按 §2.2 既有严格停止仲裁：`stopping` 吸收 `error`/`aborted` 结局，**仅当 `dispose` 成功确认（`cleanupOk: true`）且执行已终结时由 registry 原子发布 `stopped`**（清理已确认路径不再因缺少观察窗永停 `stopping`）；当 `dispose` 失败或超时（`ok: false`）时，写入 `activation-dispose-failed` / `activation-dispose-timeout` error 告警并**如实保持 `stopping`**，不得伪装为 `stopped` 也不得私自改写成 `failed`；受理取消不得当作已经停止。
7. `subagent.cancel` 只停止选中的系统技能运行；复用现有 `generation`、`revision`、快照对账、断连冻结和有界终态历史。
8. 技能类型桥接：pre-execute 判定保留（`rememberSkill`、显式/工具双入口与 legacy 拒绝），但跨阶段的技能类型载体是 `tools/execute`（around-dispatch）waterfall 里的 AsyncLocalStorage——上游 pre-execute waterfall 的 `next()` 只到 dispatch 决定、**不包住** `dispatchToolBody`（上游 `packages/core/tools/src/index.ts:1377-1379,1513-1543,1609-1616`），ALS 挂错阶段会让 body 阶段读不到技能类型；`tools/execute` 优先从 `pendingByAgent` 读取，缺席时回落共享租约 `kindOf(sessionId)`（支撑显式 `/explore`/`/test-fix`）。既有 `pendingSpawn` 单槽桥接**不得删除**，但必须绑定**调用归属令牌（token + 执行对象/父代理归属）**：`tools/execute` 进入 ALS 作用域时、`tools/pre-execute` 被拒/中止/抛错时、**`tools/pre-execute` 返回 `allow` 但后续因取消或 `guardReason` 直接落入 `post-result`/`final-result` 时（经同步 `tools/result` 监听精确幂等清理），以及租约释放兜底时**，只清理仍归属本次 token/会话的槽位与归属队列（既保证真实 `explore/test-fix` 走 ALS 及未派发收尾后不留下陈旧 `pendingSpawn` 污染后续顺序 `@`，又防止并发重迭派发误清他方尚未消费的兼容槽）；`agent/created`、`subagent/start`、start/startActivation 包装内的消费点一律“ALS 值 ?? 单槽值”读取，并在无 ALS 消费单槽后立即清空该槽。
9. 实时主流运行卡与右栏终态运行均以统一 `clientMessageId` 精确锚定（§6.5）；goal 续轮沿用原 anchor，自动化运行回合用 §6.3 第 4 条的 `runId` 锚定。

Host 与 RPC 的 run kind 联合类型需新增 `system-skill`，客户端标签显示对应系统技能名；不得把这类运行伪装成 legacy 或 package。

### 7.4 包与 legacy 边界

- 包儿童的有效工具仍是 `present-as` 与包 `allow ∩ schemas` 的多层交集。普通父会话隐藏规则不得误伤包儿童。
- 包 lane 的 C4 childId fail-closed、C5 执行期收窄、activation 结果结算后清理等既有安全约束不变。
- 包 lane 一期没有独立 `runId` 卡片（[原规格评审 §4.2 第 7 条](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-three-feature-designs-review.md#L129) 已登记为一期非阻断）；右侧只显示**外层包儿童自身**调用工具（含调用 `subagent`）的聚合工具摘要，**不聚合深度 2 lane 内部工具调用**。未来若需独立展示或内部工具聚合，再通过 `parentRunId/depth` 建立运行树。
- legacy 儿童过滤 `subagent` 的同时，还须在技能 pre-execute 或等价策略层拒绝其调用会派生后代的 `explore/test-fix`。仅删除 `subagent` 不足以封闭间接路径。
- 显式 legacy `@agent` 父运行本身仍进入现有 registry；此处限制的是其儿童继续自主派生。
- legacy 儿童判别 = `parentSessionOf(sessionId)` 有值且 `huaanworkPackageChildAllow.has(sessionId)` 为 false；该判别同时覆盖 system-skill 派生儿童，命名与注释须写明这是有意覆盖（它们同样不得获取技能租约或自主派发），不得被“修正”为排除 system-skill 儿童。

## 8. 面板结构

### 8.1 分步任务区

显示当前选中会话、当前用户回合的最近一次 todo 快照：

- 按快照顺序显示内容和状态；
- 状态为待执行、执行中、已完成；
- 顶部显示 `已完成 X/Y`；
- `Y > 0` 时显示总进度条，数值为 `X/Y`；
- 没有 todo 快照时显示“暂无任务拆解”，不显示 `0%` 进度条；
- 当前执行项高亮；若快照含多个 `in_progress`，全部如实高亮。

`todo_write` 是全量替换，不做逐项 diff。没有持久 `taskId` 时，列表 key 只保证当前快照内稳定，不得宣称跨快照身份连续。

新用户回合开始后、新 todo 到达前，任务区显示“正在等待任务拆解”，不沿用上一回合快照冒充当前任务；上一回合内容仍保留在会话主流和历史中。

### 8.2 当前执行活动区

复用工具看板投影但**必须按当前用户回合边界裁剪**：仅展示当前用户回合（`currentTurnStart` 对应回合内）的最新/进行中模型轮次、正在运行和最近结束的工具，以及成功、失败、中断、未确认和结果缺失状态，不把会话前面历史回合的工具面板整段混入右栏；展开/收起交互继续复用同一 `anchorId` 状态。

该区域是“回合活动”，不是某个 todo 的子列表。只有未来事件明确携带有效 `taskId` 时，才允许把活动归到具体任务。

### 8.3 子 agent 区

显示当前 `parentSessionId` 下所有活跃受管运行，以及当前回合已结束的运行，包括显式 `@agent/@slug` 和新增纳管的 `system-skill` 运行：

- 展示名称和独立运行实例；同名并发不能合并；
- 复用九相状态：启动、推理、生成、工具、收尾、停止中、完成、失败、停止；
- 复用当前工具摘要、已运行时间、最近活动和告警优先级；
- 如展示停止按钮，必须调用同一定向取消及二次确认流程（`requestCancel` → 行内确认 → `confirmCancel`，同步复用 `confirmingRunId` / 忙态 / 错误状态）；
- 子 agent 失败或停止不会自动修改 todo 原始状态；
- 包 lane 不生成独立行，只在父包运行中聚合展示外层包儿童自身工具调用摘要（不含深度 2 lane 内部工具明细）。

窄栏使用摘要展示，可抽取 `SubagentRunCard` 的展示子组件；不得复制一份新的状态 reducer 或第二份取消确认状态。

## 9. 投影模型

建议新增纯函数选择器：

```ts
type ProgressPanelModel = {
  sessionId: string;
  connection: "live" | "disconnected" | "reconnecting";
  taskPhase: "ready" | "waiting" | "empty";
  tasks: ProgressTaskView[];
  completedCount: number;
  totalCount: number;
  activity: ToolPanelView[];
  subagents: SubagentRunView[];
};

type ProgressTaskView = {
  content: string;
  sourceStatus: "pending" | "in_progress" | "completed";
  displayStatus: "pending" | "in_progress" | "completed" | "interrupted";
};
```

选择器输入是当前标签已有的消息条目、工具面板投影、回合终态、连接状态、子 agent run 列表与当前回合锚点（§6）；输出只供展示，不回写上述输入。

`interrupted` 是只用于展示的叠加状态：当原始状态为 `in_progress` 且所属回合已终结（`turnFinal === true`，含回合取消、失败、异常结束，或回合正常/历史结束时仍未置为 `completed`）时叠加 `interrupted`，避免回合结束后仍永久显示“执行中”。`pending` 在同样情况下仍显示未执行；任何终态都不得把原始非完成项自动改为已完成。`taskPhase` 仅在当前存在已启动用户回合、尚未终结且尚无 todo 快照时为 `waiting`；空会话或回合已终结且无 todo 时为 `empty`。当无 active goal 的父会话先 idle（已结算 `turnFinal === true`）随后被 `subagent-settled` 通知唤醒时，保留原用户 `clientMessageId` 归属但不重开已终结的逻辑回合（`turnFinal` 维持单调），后续未完成项仍沿用本条 `interrupted` 叠加口径，直到 `todo_write` 标记 `completed` 或开启新用户回合。

子 agent 列表包含全部活跃 run，以及 `clientMessageId` 等于当前回合权威锚点 id（`currentTurnClientMessageId`）的终态 run；**缺权威锚点时间时不以客户端发送时钟冒充 Host 锚点起点**——无锚 `system-skill` 运行在活跃期继续按 `parentSessionId` 展示，一旦终态且缺少 `clientMessageId` 匹配则按 fail-closed 退出终态筛选（不以 `user.sentAt` 或名称猜测；`TurnAnchor.startedAt` 仍由 Host 侧 `turn-anchors.ts` 权威维护）。

`connection` 三态由现有连接状态合成，不要求宿主新增字段：

- `disconnected`：`sidecarDead === true`（WS/执行进程已断开）；
- `reconnecting`：`sidecarDead === false` 且已有过就绪/曾断开并处于重新连接或子代理快照对账未收敛（`!ready && sawReady`，或 `ready && subagentRuns.connection === 'disconnected'`）；
- `live`：其余正常就绪态（含初始未建连前不误报 `reconnecting`）。

## 10. 实时、历史与重连流程

### 10.1 实时

```text
tool/start(todo_write)  → 快照(clientMessageId 精确归属 + roundKey 门) → tasks
tool/start/tool/end     → 当前回合 toolRows（tool/start 带 clientMessageId/roundKey） → activity
显式 @ / system-skill run → 同一 registry/reducer（run 带统一 clientMessageId） → subagents
                                                                    ↓
                                                 ProgressPanel 重新选择并渲染
```

右栏不订阅第二套 WebSocket，不发起逐 token 轮询。渲染使用 `App.tsx` 已有的共享计时 tick；断连时沿用 `frozenAt/staleAt` 冻结，不继续把耗时增长显示为新的执行进展。

todo 归属按 §6.5 第 2 条：事件到达时取当前回合用户条目的 `clientMessageId` 精确匹配，roundKey 必填且不小于当前快照 roundKey。上一回合迟到的 `todo_write`（携带旧 clientMessageId 或旧 roundKey）不得刷新新回合的右侧任务区。无法确认归属时，右栏保持当前快照并记录诊断，不猜测挂入最新回合。

### 10.2 历史

`historyItemsFromRecords` 将历史 `todo_write` 工具调用还原为与实时一致的 todo 快照：

1. 结构化 `todos` 由宿主 `session-view.ts` 在 `tool/call` 先解析原始 `data.arguments`（真实持久化日志常为 JSON 字符串，需经与实时/命令行一致的 `parseToolArguments` 解码为对象并兼容已解析对象，**不读 200 字符截断摘要** `formatToolArguments`）后提取 `.todos`（与实时 bridge 共用 `@huaanwork/policy/todo` 的 `normalizeTodoEntries` 纯函数）；记录同时携带当前普通用户消息 clientMessageId（顺序扫描跟踪，goal 不清空）与既有 `roundKey`。
2. 历史映射：`todos` 非数组 → 生成不含原始参数全文的“历史待办无法解析”note；数组 → 逐条过滤坏条目（与实时 flatMap 丢弃语义一致，空数组合法为空快照），推入 `kind="todo"` 条目；不得回退成会展开完整参数的普通工具卡，也不得伪造空完成状态。
3. `tool-result` 配对逻辑跳过 todo_write 的 callId，不生成第二次 todo。
4. `historyToChatItems` 必须显式保留 `todo` 分支（todos/roundKey/clientMessageId）与 `user.clientMessageId`，不能落入通用兜底 note。
5. 历史主流从此显示与实时相同的待办卡；实施完成后同步清理 `AGENTS.md` 中的活跃待办差异行，并在 `docs/project-memory-archive.md` 闭环 R-12 归档。
6. 无 `step/start` 的旧日志继续采用既有轮次降级，不宣称能恢复不存在的精确轮次；旧日志用户记录无 clientMessageId 时不伪造锚点（§6.5 第 5 条）。

### 10.3 断连与重连

- 断连：右栏整体显示“连接中断，状态可能不是最新”；单条运行摘要沿用 `SubagentRunCard` 既有断连冻结口径。
- ready：沿用现有子 agent 快照对账；重连未完成对账前右栏显示重连状态；旧世代非终态卡保持 stale/失效语义。
- 迟到事件：子 agent 继续按 generation 和 revision 合并；终态不复活，stopping 不回退。
- 会话切换：忽略上一选择会话的迟到快照应答，右栏只显示当前 `sessionId`。
- Host 重启后无法恢复的子 agent：复用既有 `SubagentRunCard` 的失效状态展示（“状态不可恢复 · Host 已重启，结果未确认” / 已失效语义），不得猜测为成功。

## 11. 未来关联协议预留

一期允许在客户端投影类型中预留：

```ts
taskId?: string;
parentRunId?: string;
depth?: number;
```

约束如下：

1. 字段缺失时不得通过名称、开始时间或“当前唯一活动项”猜测关联。
2. `parentRunId` 指向另一次受管运行，不等于 `parentSessionId`；`depth` 描述未来运行树层级。
3. 包 lane 一期可不填写上述字段，因为不建立独立 lane 卡；未来独立建卡时才定义其权威来源和快照语义。
4. 未来若增加 `taskId`，必须来自明确执行协议，而不是要求上游现有 `todo_write` 立即提供新字段。
5. 选项 2 的落地不依赖这些预留字段；系统技能纳管必须使用本期已定义的 registry 身份。

## 12. 涉及模块

| 类型 | 建议模块 |
| --- | --- |
| 新增 | `huaanwork-host/turn-anchors.ts`：TurnAnchorStore（LRU 256）、`agent/pre-step` 监听（return next()）、§6 唯一锚点提供方 |
| 修改 | `huaanwork-host/holders.ts`：注入 `ctx.huaanworkTurnAnchors` 与系统技能租约表 |
| 修改 | `huaanwork-host/sessions.ts`：顶层 clientMessageId 解析、followup `UserMessage.id = 顶层 ?? randomUUID()`、register 接线、dispatchAt 透传 UUID、显式 `/explore`/`/test-fix`（`session.send.skill`）在 `agent.followup` 之前挂载系统技能租约（失败回滚）、`releaseSessionRuntime` 清理锚点与系统技能租约 |
| 修改 | `huaanwork-host/turn-scheduler.ts`：顶层 clientMessageId 随排队项透传 |
| 修改 | `huaanwork-host/automations-host.ts`：runAgentTurn 传 `clientMessageId = runId` |
| 新增 | `huaanwork-host/system-skill-leases.ts`：租约获取/释放/goal 相位 |
| 新增 | `huaanwork-host/subagent-cleanup.ts`：从 `agent-invoke.ts` 抽取共享激活释放与无信号观察窗超时原语（`disposeActivationWithTimeout` / `waitResultWithBudget` / `settleWithin`） |
| 修改 | `huaanwork-guardrails/present-as.ts`：按会话类型和附件控制 `subagent` 有效可见性 |
| 修改 | `huaanwork-guardrails/agent-attachments.ts`、`skills.ts`：系统技能条件挂载、goal/回合终结解挂、`startActivation` 纳管、`tools/execute` ALS 技能载体；同批订正其中关于“模型自主嵌套”的旧注释 |
| 修改 | `huaanwork-guardrails/bridge.ts`：`tool/start` 携带 clientMessageId、goal/idle/error/aborted `turn/end`/`session/disposed` 租约解挂接线 |
| 修改 | `huaanwork-host/subagent-runs.ts`：新增 `system-skill` run 投影类型 |
| 修改 | `huaanwork-host/agent-invoke.ts`、`packages/huaanwork-policy/src/agent-catalog.ts`：legacy 儿童直接与间接派生封闭；复用 `subagent-cleanup.ts` |
| 修改 | `huaanwork-host/session-view.ts`：user `data.id` 透传、ordinary user 跟踪、`parseToolArguments` 解码后提取 `todo_write` 结构化 todos |
| 保持启用并订正注释 | `profile.ts` 的 `tool-subagent` 行及 2026-11-13 裁定注释（含 :113-122 maxDepth 注释判断） |
| 修改 | `client-huaanwork/rpc-types.ts`：run kind 联合、`SessionDetailRecord` 的 todos/clientMessageId、必要的可选未来关联字段 |
| 新增 | `packages/huaanwork-policy/src/todo.ts`：Host/Client 共用的结构化 todo 解析，避免 Host 反向依赖客户端模块 |
| 新增 | `client-huaanwork/logic/todoProjection.ts`：归属判断纯函数并再导出共享解析 |
| 修改 | `client-huaanwork/logic/sessionChannel.ts`：历史 todo 分支、tool-result 去重、user.clientMessageId |
| 修改 | `client-huaanwork/logic/subagentRuns.ts`：`user.clientMessageId` 精确匹配（String(id) 兼容） |
| 新增 | `client-huaanwork/logic/progressPanel.ts`：纯选择器、计数和展示态 |
| 新增 | `client-huaanwork/ProgressPanel.tsx`：三个区域的窄栏展示 |
| 修改 | `client-huaanwork/App.tsx`：每次发送 UUID、运行标签用户条目、todo 归属守卫、右栏接线、`historyToChatItems` todo/user 分支（todo 条目的 roundKey/clientMessageId 为 App 本地 ChatItem 类型扩展） |
| 复用/最小抽取 | `logic/subagentRuns.ts`、`SubagentRunCard.tsx`：摘要与告警展示 |

本需求需要修改宿主 registry 和护栏，但不新增第二套进度 RPC 通道；`subagent.list/cancel` 继续复用。会话主流中的原有卡片保持可用。

样式只改 `styles.css` 源文件，并重新生成 `styles.generated.ts`。

## 13. 异常与关键约束

- todo 是模型提交的状态快照，不是宿主已验证的业务事实；UI 展示其状态，但不宣称额外完成度。
- 总进度只来自任务完成计数；子 agent 相位和工具活动不参与该百分比。
- 不强制串行。多个 `in_progress`、多个子 agent 和同名运行都必须可显示。
- 父回合 idle 不等于子 agent 全部结束；右栏继续显示活跃子运行，系统技能附件也不能因瞬时 idle 提前解挂。
- 子 agent 的定向取消不得退化为父会话级取消；受理取消后仍须等待权威清理完成才显示 `stopped`，停止预算覆盖 result 等待、dispose 与不吃中止信号的独立结算观察窗；当 `dispose` 成功确认（`ok: true`）且执行终结时收敛为 `stopped`，当 `dispose` 失败或超时（`ok: false`）时按既有严格停止语义保留告警与 `stopping`，不得伪装为 `stopped` 或私自改写 `failed`。
- 不自动把失败、取消或断连后的未完成任务标成 completed。
- 不把子 agent 正文、思考或完整工具输出复制到父会话；右栏沿用现有摘要安全边界。
- 普通父会话隐藏工具不能误伤显式 @ 宿主派发、包儿童合法 lane 或系统技能纳管路径。
- legacy 防护必须同时覆盖直接 `subagent` 与 `skill(explore/test-fix)` 间接路径。
- “受管”不等于“每层独立建卡”；包 lane 的独立运行树仍属后续范围。
- 右栏是只读投影，除了复用既有取消动作外，不得直接修改 todo 或 run 状态。
- 回合锚点不得使用模块级全局单槽；pending/anchors 有界（LRU 256）；goal 续轮保留原 anchor 与 startedAt；无锚 fail closed，不按事件到达顺序或 `currentTurnStart` 猜测。
- 持久消息锚定一律使用 UUID/runId，不复用客户端数值 id；旧 at 数值 id 只作旧 @ 卡展示兼容。
- todo 归属必须 `clientMessageId` 精确匹配（无数值 `String(id)` 兼容回退）+ `roundKey` 门槛；无锚、部署边界、上一回合迟到一律不更新。
- 系统技能实时主流卡无精确锚点时不得回退最后一条用户消息；历史/snapshot 对账前不落卡，右栏亦只在活跃期展示，终态不以客户端发送时间冒充权威锚点起点（fail-closed）。

## 14. 测试与验收

### 14.1 自动化测试

至少覆盖：

1. 无 todo、空 todo、单个和多个任务的计数；`0/0` 不显示百分比。
2. 全量替换、多个 `in_progress`、重复内容、完成数变化和无持久 taskId 的 key 语义。
3. 取消/失败时 `in_progress → interrupted` 的展示叠加，原始 todo 不被改写；pending/completed 不误改。
4. todo 归属：当前回合 `user.clientMessageId` 精确匹配（无锚 user 条目即使 `String(id)` 相等亦拒绝）+ `roundKey` 必填且不小于当前快照 `roundKey`；goal 续轮同 id 通过；上一回合迟到、无锚、部署边界事件 fail-closed 不更新面板；`session.send` 在飞期早到 `todo_write` 经缓冲在 `started: true` **以及排队 `waiting` 应答前已收 `session/queue-start` 的交错分支**均按 `clientMessageId` 重放不丢失（未启动/失败或他回合事件仍丢弃）。
5. 工具六态与当前回合筛选（不混入前序历史回合工具面板）；不把工具挂到无关联的任务下。
6. 普通父会话、有人值守自动化非系统技能回合及无人值守自动化均不可见 `subagent`；显式 `@agent/@slug` 宿主派发不回归；`explore/test-fix` 后接顺序 `@agent/@slug`、预检 `allow` 后取消/`guard` 拒绝直走 `tools/result`（不进 `tools/execute`）后接 `@agent/@slug`，以及并发重叠派发均不互相污染/误清工具限制。
7. 有人值守的 `explore/test-fix` 双入口（模型调 `skill` 工具与显式 `/explore`/`/test-fix` 即 `session.send.skill` 直发/排队出队）均可见 `subagent` 并进入 `system-skill` run、`followup` 失败精确回滚，active goal 下先激活 goal 再取租约、以及从模型 `skill(test-fix/explore)` 切换到显式 `/explore`/`/test-fix`（含双向与直发/排队）均保持一致的技能身份、租约保留与子代允许列表；`acquire` 返回 `false` 时不留脏 `pendingByAgent`；正常结束、`agent/error`、中止/错误 `turn/end`、未派生时回合结束及 `session/disposed`/`releaseSessionRuntime` 均清理附件/租约/`pendingByAgent`；无人值守自动化与受管儿童不因任一入口获得 `skill` 或 `subagent`。
8. 系统技能每次派生均生成 `system-skill` run，具备启动/活动/终态、快照对账和定向取消；子代 allow 不扩大；registry 缺失抛错；childId 不可解析（或非空预留 `specChildId` 不一致）时 dispose+failRun+清理确认+抛错；pending 期取消无论后续成功激活还是启动失败，只要 `dispose` 确认成功均收敛 `stopped`，`dispose` reject/超时（`ok: false`）则保留真实 error 告警并如实保持 `stopping`；取消后经独立非中止观察窗等待 result 并超时 `rejectResult`，不因信号已中止 0ms 短路；`ActivationRun` 与 `Pick<SubagentActivationHandle, 'dispose'>` 类型收窄通过 strict 类型检查。
9. 包儿童合法 lane 与既有 C4/C5 测试保持绿（含规格评审点名的 `agent-package-runtime.spec.ts:297,317,321,1009`、`policy.cordis.spec.ts:938-939`、`package-subagent-lineage.spec.ts:75,153,173`）；多层 restrict 交集 fixture 下包儿童可见 `subagent`；一期无独立 lane 卡，右栏只汇总外层包儿童自身工具摘要，不聚合深度 2 lane 内部工具。
10. legacy 儿童直接 `subagent` 和经 `skill(explore/test-fix)` 的间接派生均被拒绝；显式 legacy 父运行不受影响；共享包 `filterAgentAllow` 单测覆盖 subagent 排除。
11. 活跃与当前回合终态子 agent（无锚运行活跃期展示、终态 fail-closed 不借用客户端发送时间）、同名并发、`stopping`、`completed`/`failed`/`stopped` 和 `stale`。
12. generation/revision 合并、终态不复活、断连冻结、重连快照（含三态 connection 合成）和跨会话迟到应答。
13. 历史 `todo_write` 与实时快照一致（从真实 JSON 字符串与对象两类原始 `data.arguments` 解码解析，而非截断 args）；坏 args 安全 note；数组内坏条目 flatMap 丢弃、空数组合法；`historyToChatItems` 不丢失 todo；tool-result 不重复推进；`user.clientMessageId` 从日志透传；`session-view` 只认 `source.kind` 为 `'user'`/`''`（与有效 `goal`）而不把 `subagent-settled`、`runtime-context`、`agent-instructions`、`skill-catalog` 等系统消息映射到 `user` 记录或覆盖 `currentOrdinaryUserClientId`。
14. 右栏取消按钮复用同一定向取消及二次确认（`requestCancel` → 行内确认 → `confirmCancel`），一次确认只发一次取消 RPC 且不影响兄弟运行或父会话。
15. 会话主流原有待办卡、工具卡和子 agent 卡保持可用；同步清理 `AGENTS.md` 活跃行并在 `docs/project-memory-archive.md` 闭环 R-12 归档。
16. 回合锚点 store：register/current、pre-step 幂等、`subagent-settled` 与其他非人类/系统 `source.kind` 不换锚（仅 `'user'`/`''` 与 `'goal'` 参与，未登记真实用户保留 `unknown` 降级）、goal 续轮保留原 anchor 与 startedAt、无锚 fail closed、LRU 有界、clearSession（含 `session/disposed` 与 `releaseSessionRuntime`）；`agent/pre-step` 监听 return next() 且与其他监听次序无关；完成通知（`subagent-settled`）到达后再发 `todo_write`/二次派发及历史回放均保持原用户锚点；自动化 runId 锚定与运行标签 user.clientMessageId 接线。

### 14.2 agent 真机走查自动化测试

**验收执行方式（2026-11-17 调整，取代人工真人验收）**：以下七项由 agent 编写并运行可重复的 CDP 真机走查自动化脚本（`dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs` 及其判据单测 `dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs`）完成——在包含分支最新构建产物的工作区 Electron（`lib/main.js`）上，隔离临时 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1`，从本机配置只读导入真实模型配置（绝不打印或入库 `api_key`；缺可用模型配置或 `zstd` CLI 等前提时按 `BLOCKED` 退出码 `3` 退出，不得静默降级或以单测通过冒充），由脚本通过 CDP 自动驱动 UI、抓取截图/DOM facts、解压 `session.v4.jsonl.zstd` 校验 `request/header` 工具 schema、身份链与 RPC 轨迹。脚本返回码固定为 `0`（PASS）/ `1`（FAIL）/ `3`（BLOCKED）；走查结束后备份证据到本地备份目录并清理含密钥临时副本，仅将脚本、单测与脱敏文本证据落盘提交（截图与临时 profile 不进 git 仓）：

1. **复杂任务进度自动化校验**：脚本通过 CDP 发起包含 3 个以上 Task 的复杂请求；断言右栏“进度”页渲染完整任务列表、当前项高亮、顶部 `已完成 X/Y` 计数正确、主流仅存在唯一待办卡，且对应 `session.v4.jsonl.zstd` 包含 `todo_write` 记录并截图留证。
2. **活动无虚构百分比自动化校验**：工具执行期间及完成后检查右栏 DOM；断言任何单步均不存在百分比文本/进度条、顶部计数保持 `X/Y`，且工具活动区内容与持久化会话中带 `clientMessageId`/`roundKey` 的 `tool/start` 事件及当前回合边界一致。
3. **普通父会话不可自主派发自动化校验**：普通父会话完成普通请求后，脚本解压对应 `session.v4.jsonl.zstd` 断言所有 `request/header` 的 `header.tools` schema 均不含 `subagent`；随后通过 CDP 发送显式 `@agent` 请求，断言 `.subagent-run-card` 出现并可执行定向停止且终态收敛。
4. **`explore` 与 `test-fix` 双入口双技能纳管自动化校验**：脚本依次触发 `explore`（分别覆盖模型调用 `skill` 与显式 `/explore`）与 `test-fix`（显式 `/test-fix`）；断言右栏与主流均出现带 `system-skill` 标签的运行卡且支持定向取消；对比“前置普通回合 → 系统技能执行期 → 下一普通回合”三阶段真实 `request/header` 的 `header.tools` schema，自动断言 `subagent` 仅在执行期出现并在回合结束后收回。
5. **包 lane 正常自动化校验（Clarify Phase-1 粒度）**：在隔离 profile 播种/启用既有智能体包 `@slug` 并触发深度 2 lane 派发；断言外层包 `.subagent-run-card` 与右栏仅展示外层包儿童聚合工具摘要、无独立 lane 运行行，并经 `session.v4.jsonl.zstd` 身份链（`parentSession`/`origin`/`delegationDepth === 2`）验证两层派发与非错误结果。
6. **切换/断连/重连/历史归属与 Host 重启失效自动化校验**：脚本自动执行会话切换、刷新重载历史（含验证上一回合 todo 不冒充当前回合）、观察断连/重连状态横幅，并在活跃 `@agent` / `system-skill` 运行期间调用 `window.huaanworkAcceptance.restartHost()` 接力 `assertHostRestartEvidence`（`scripts/huaanwork-accept-host-restart.mjs`）断言 Host PID 更换、renderer 文档未重建、不可恢复卡片呈现固定文案 `状态不可恢复 · Host 已重启，结果未确认`、终止按钮禁用且耗时冻结（若环境/断连时序无法稳定构造，按 fail-closed 记为 `BLOCKED` exit `3` 并在报告注明，不以旁路视作通过）。
7. **主流卡片无双重更新与单次取消隔离自动化校验**：脚本构造存在兄弟并发运行的场景并触发右栏「终止 → 确认终止」两步点击；断言主流 todo/工具/运行卡各自唯一不重复，且结合 CDP/RPC 与宿主日志核验一次确认只发送一条 `subagent.cancel`（仅命中目标 `runId`），兄弟运行持续完成不受影响。

以上七项由实施计划 `Task 5` 的 Step 7 落地脚本并实际运行输出报告；未执行脚本运行前不得在计划或评审结论中声称已通过。

## 15. 独立性与后续演进

本需求不依赖对话创建技能。任务结果 Artifact 的回合定位**消费**本规格 §6 的 `turn-anchors.ts` 模块（`ctx.huaanworkTurnAnchors`），该模块由本规格的实施计划通用前置任务唯一提供；Artifact 不依赖 ProgressPanel 组件或右栏投影状态。后续若 Artifact 需要显示在某个 Task 下，必须先有明确 `taskId + artifactId` 关联；不能通过右栏的显示顺序推断。

未来若需要包 lane/孙代的独立卡片、独立取消、持久化每一步耗时或精确单步进度，再基于 `parentRunId/depth/taskId` 另立运行树与存储设计。当前选项 2 的一期目标不依赖这些后续能力。
