# Managed Subagent Progress Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按选项 2 让普通父会话不能绕过 registry 自主派发子 agent，将 `explore/test-fix` 派生运行纳管，并在右侧“进度”同步展示 Task、工具活动和受管运行。

**Architecture:** 从全局 `ALLOWED_TOOLS` 默认移除 `subagent`，再通过包血缘附件和系统技能租约按会话开放；系统技能调用经 `tools/execute`（around-dispatch）ALS 与 `startActivation` 包装进入现有 run registry。右栏只投影既有 todo、工具看板和 run 状态，不建立第二套执行事实源。共享回合锚点由通用前置任务新建的 `huaanwork-host/turn-anchors.ts` 唯一提供。

**Tech Stack:** TypeScript、React、Vitest、Node AsyncLocalStorage、既有 DSH tools/restrict、既有 `subagent-runs` registry。

**Spec:** `docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`（§6 共享回合锚点契约是本文档 Task 1 的权威）

**Plan order:** 2/3。先完成 `2026-11-15-chat-created-skills.md`；本计划完成后再执行 Artifact 计划。Artifact 计划消费的“既有通用回合锚点”即本计划 Task 1 的 `turn-anchors.ts`（`ctx.huaanworkTurnAnchors`），不存在 phantom dependency。

## Global Constraints

- 基线为外层 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`（已合入 `#29 feat/chat-created-skills`），上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 只修改 `dsh-plugin-huaanwork/` 和必要的自有共享包 `packages/huaanwork-policy/`；不得修改 `deepseek-harness/`。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0` 与 Corepack Yarn `4.18.0`。
- `dsh-plugin-huaanwork/tsconfig.json` 启用 `exactOptionalPropertyTypes: true`（仅 `tsconfig.client.json` 对 `src/client*` 关闭）；所有宿主/护栏/共享类型可选字段写入均须用条件展开，禁止直接写入显式 `| undefined`。
- 不得全局禁用 profile 的 `tool-subagent`，不得移除宿主 `ctx.subagents` 服务。
- 普通父会话、无人值守自动化和 legacy/system-skill 儿童不得获得模型面 `subagent`；显式 `@agent/@slug` 宿主派发不得回归。
- 包儿童只有在包 allow 与血缘均允许时才获得 `subagent`；C4/C5 与既有包运行取消契约不变。
- 包 lane 一期不独立建卡，只聚合外层包儿童自身工具摘要（不含深度 2 lane 内部工具）；不得宣称有独立 lane 取消。
- 系统技能租约不得因正常完成轮次的 `goal.phase === 'active'` 轮间 idle 提前解挂（active goal 状态须独立于当前租约是否已存在维护，确保先激活 goal 再取租约的后续轮次同样在正常轮间保留）；但 `agent/error`、中断/异常 `turn/end` 及会话销毁/删除（`session/disposed` / `releaseSessionRuntime`）必须**无条件释放**（同步清租约、独立 active goal 标记与对应 `pendingByAgent` 状态；即使租约缺席也清理缓存）；显式 `/explore`、`/test-fix`（`session.send.skill` 直发与排队出队）须在 `agent.followup` 之前先检查受管儿童拒发、同步失效该会话既有 `pendingByAgent` 旧缓存（防止 active goal 留下的旧模型技能覆盖显式新租约）、挂载租约并刷新 restrict（保证 Step 1 `systemPrompt.assemble()` 可见），`followup` 抛错立即精确回滚（仅释放本次显式租约，不误清除既有 active goal 标记）。
- `system-skill` 必须进入现有 registry；复用 generation、revision、快照、严格 stopped 和定向取消语义；提前挂接 `attachCancel`，pending 期取消无论后续成功还是失败/childId 异常都须配合清理确认收敛；停止预算覆盖 result 等待、dispose 与不吃中止信号的独立观察窗——`dispose` 成功（`cleanupOk: true`）且执行终结时收敛为 `stopped`；若 `dispose` 失败或超时（`ok: false`）则按既有严格停止仲裁保留 error 告警与 `stopping`，不得伪装已停或私自改写 `failed`。
- 共享回合锚点（规格 §6）：持久锚定一律用 `crypto.randomUUID()`/自动化 runId，禁止用客户端数值 id；`notePreStep` 与 `session-view` 只认 `source.kind === 'user'`/`''`（与 `goal` 续轮），`subagent-settled` 与其他非人类/系统通知不换锚、不当普通用户回合；goal 续轮保留原 anchor 与 startedAt；无锚 fail closed；不以客户端 `sentAt` 冒充 Host `TurnAnchor.startedAt`；store 内 pending/anchors 有界 LRU 256，禁止模块级全局单槽；`session/disposed` 与 `releaseSessionRuntime` 同步清理。
- 实时系统技能主流卡禁止 last-user 回退；snapshot 对账才允许 `allowSnapshotFallback`。
- 技能类型跨阶段载体只允许 `tools/execute`（around-dispatch）ALS（上游 pre-execute waterfall 的 `next()` 不包 `dispatchToolBody`，事实见 Task 2 Step 4），`pendingByAgent` 缺席时回落共享租约 `kindOf(sessionId)` 覆盖显式斜杠入口；既有 `pendingSpawn` 兼容桥接不得删除，但必须按调用令牌（token + 执行对象/父代理归属）精确清理与保护——覆盖 `tools/execute` 进入 ALS、`tools/pre-execute` 拒绝/抛错、**`tools/pre-execute` 返回 `allow` 但后续因取消或 `guardReason` 直接走 `post-result`/`final-result` 的出口（经同步 `tools/result` 监听精确幂等清理），以及租约释放/显式重挂时的父代理槽位兜底清理**，禁止留下陈旧单槽污染后续 `@`。
- 子 agent 正文、reasoning 和完整工具输出不得进入父会话。
- todo 总进度只计算 `completed/total`；归属 = 当前回合 `user.clientMessageId` 精确匹配 + `roundKey` 必填且不小于当前快照 roundKey；不得伪造单步百分比或 Task↔工具/子 agent 关联。
- 历史坏 todo 参数只显示安全 note，不展开原始参数；结构化 todos 由宿主 `session-view` 先用 `parseToolArguments` 解码原始 JSON 字符串/对象后提取，而非读 200 字截断 `args`；实施后从 `AGENTS.md` 移除该活跃债行并在 `docs/project-memory-archive.md` 闭环 R-12 归档。
- 修改 `styles.css` 后运行 `corepack yarn workspace dsh-plugin-huaanwork gen:styles`。
- 所有命令在仓库根执行；全量 `check` 不得与其他含 `verify:aa` 的命令并发；`verify:aa` 并发竞争如实串行重跑并记录。
- 共享包 `@huaanwork/policy` 的包级 `corepack yarn workspace @huaanwork/policy check` 与根 `corepack yarn check` 都必须实际执行并记录真实结果（根 `check` 不含 policy 包 check，根 `test` 含 policy 测试）。
- 文件清单与 commit 只列实际修改/新增的文件；仅运行未修改的测试不得 `git add`。
- App.tsx 是技能计划（已合入的 `skillChangeSignal` → `SkillsView.refreshSignal`）与本计划、Artifact 计划的共同修改面；修订时不得覆盖已有 `skillChangeSignal` 等 #29 接线。

---

### Task 1: 通用前置 — 共享回合锚点 store 与发送/宿主接线

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:448-522,782-807,927-940,1067-1155,1178-1252`（含 `startQueuedItem` 重建发送参数与 `releaseSessionRuntime` 锚点清理）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts:10-46,102-123,192-235`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:389-397`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:284-296,1740-1775,2895-2985,3313-3344`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:91-128`（新增 `buildSessionSendParams` 纯函数与历史 user 锚点）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts:296-313`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:153-158,203-220`（人类 `source.kind` 白名单过滤与 user `data.id` 透传）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:434-449`（历史 user `clientMessageId`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/turn-anchors.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Produces: `TurnAnchor`、`TurnAnchorStore`、`createTurnAnchorStore()`、`installTurnAnchorHooks(ctx)`（`agent/pre-step` 监听 + `session/disposed` 清理）、`ctx.huaanworkTurnAnchors`。
- Produces: `resolveFollowupClientMessageId(params): string`（顶层 `clientMessageId ?? randomUUID()`，**不用 `at.clientMessageId` 兜底**）与 `turnOriginForSession(sessionId)`（`huaanwork-auto-` 前缀 → `'automation'`，否则 `'advanced'`），从 `sessions.ts` 导出供测试。
- Produces: `buildSessionSendParams(input): SessionSendParams`（`logic/sessionChannel.ts`）：每次发送顶层携带 `clientMessageId`（调用方 `crypto.randomUUID()`）；`@` 时保留 `at.clientMessageId = String(userItemId)` 兼容。
- Produces: `automationRunUserItem(runId, taskName, items)`（App.tsx 导出纯 helper，与 `upsertTodoItem` 同先例）：无该 clientMessageId 的 user 条目时返回追加条目，否则返回 `undefined`。
- Produces: 历史 `SessionDetailRecord`/`HistoryChatItem`/`ChatItem` 的 user `clientMessageId?: string` 全链；`session-view.ts` 从 `user/message` 的 `data.id` 透传，渲染数值 `id` 仍由 `allocId()` 生成。
- Preserves: `at.clientMessageId` 继续随 `@` 发送（仅旧 @ 卡展示兼容）；`insertSubagentRunCard` 的 `allowSnapshotFallback` 语义不变。

- [ ] **Step 1: 写锚点 store 与监听失败测试**

`tests/huaanwork-host/turn-anchors.spec.ts` 覆盖：

```ts
const message = (id: string, kind = 'user') => ({ role: 'user', id, source: { kind } })

it('registers pending state and exposes an anchor only after pre-step', () => {
  const store = createTurnAnchorStore()
  store.register({ sessionId: 's1', clientMessageId: 'm1', origin: 'advanced' })
  expect(store.current('s1')).toBeUndefined()
  expect(store.notePreStep('s1', [message('m1')], '2026-11-15T10:00:00.000Z')).toEqual({
    clientMessageId: 'm1', startedAt: '2026-11-15T10:00:00.000Z', origin: 'advanced',
  })
})

it('marks unregistered ordinary users unknown and keeps note idempotent', () => {
  const store = createTurnAnchorStore()
  const first = store.notePreStep('s1', [message('m1')], 't1')
  const replay = store.notePreStep('s1', [message('m1')], 't2')
  expect(first?.origin).toBe('unknown')
  expect(replay).toEqual(first)
  store.register({ sessionId: 's1', clientMessageId: 'm2', origin: 'advanced' })
  expect(store.notePreStep('s1', [message('m2')], 't3')).toMatchObject({ clientMessageId: 'm2', startedAt: 't3' })
})

it('keeps the original anchor across goal continuation and fails closed without one', () => {
  const store = createTurnAnchorStore()
  store.register({ sessionId: 's1', clientMessageId: 'm1', origin: 'advanced' })
  const original = store.notePreStep('s1', [message('m1')], 't1')
  expect(store.notePreStep('s1', [message('goal-2', 'goal')], 't9')).toEqual(original)
  expect(store.notePreStep('s2', [message('goal-1', 'goal')], 't2')).toBeUndefined()
})

it('keeps the anchor unchanged across subagent-settled and non-human notices while resolving paired human turns', () => {
  const store = createTurnAnchorStore()
  store.register({ sessionId: 's1', clientMessageId: 'm1', origin: 'advanced' })
  const original = store.notePreStep('s1', [message('m1')], 't1')
  // subagent-settled 完成通知与 agent-instructions 等系统消息不得换锚或写成 unknown
  expect(store.notePreStep('s1', [message('notice-1', 'subagent-settled')], 't2')).toEqual(original)
  expect(store.notePreStep('s1', [message('inst-1', 'agent-instructions')], 't3')).toEqual(original)
  // 同批次尾随系统通知时仍可从前向后扫到真实用户消息
  store.register({ sessionId: 's1', clientMessageId: 'm2', origin: 'advanced' })
  expect(store.notePreStep('s1', [message('m2'), message('notice-2', 'subagent-settled')], 't4')).toMatchObject({
    clientMessageId: 'm2',
    startedAt: 't4',
    origin: 'advanced',
  })
})

it('leaves the anchor unchanged for steps without a new user message', () => {
  const store = createTurnAnchorStore()
  store.notePreStep('s1', [message('m1')], 't1')
  expect(store.notePreStep('s1', [{ role: 'tool', id: 'tool-1' }], 't2')?.clientMessageId).toBe('m1')
})

it('evicts least-recently-used sessions and clears pending and anchors', () => {
  const store = createTurnAnchorStore({ limit: 1 })
  store.notePreStep('s1', [message('m1')], 't1')
  store.notePreStep('s2', [message('m2')], 't2')
  expect(store.current('s1')).toBeUndefined()
  store.clearSession('s2')
  expect(store.current('s2')).toBeUndefined()
})

it('rolls back only the current pending registration when followup fails', () => {
  const store = createTurnAnchorStore()
  store.notePreStep('s1', [message('old')], 't1')
  const rollback = store.register({ sessionId: 's1', clientMessageId: 'new', origin: 'advanced' })
  rollback()
  expect(store.current('s1')?.clientMessageId).toBe('old')
  expect(store.notePreStep('s1', [message('new')], 't2')?.origin).toBe('unknown')
})
```

监听契约测试（同一个 spec）：`agent/pre-step` 监听器**必须 `return next()`**（waterfall 继续）；listener A/B 都以各自载荷幂等调用 `notePreStep`，按 A→B 与 B→A 各跑一次，最终 anchor 与 startedAt 相同、`next` 均各调用一次。不得让 B 在 A 尚未执行时断言 anchor 已存在，那会把顺序依赖误写成测试。`session/disposed` 清理该会话。

- [ ] **Step 2: 确认测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-anchors.spec.ts
```
Expected: FAIL，`turn-anchors.ts` 不存在。

- [ ] **Step 3: 实现 store、holders 注入与 pre-step 钩子**

`turn-anchors.ts`：

```ts
export type TurnAnchor = { clientMessageId: string; startedAt: string; origin: 'advanced' | 'automation' | 'unknown' }
export type TurnAnchorStore = {
  register(input: { sessionId: string; clientMessageId: string; origin: TurnAnchor['origin'] }): () => void
  notePreStep(sessionId: string, messages: readonly unknown[], startedAt: string): TurnAnchor | undefined
  current(sessionId: string): TurnAnchor | undefined
  clearSession(sessionId: string): void
}
export function createTurnAnchorStore(options?: { limit?: number; now?: () => string }): TurnAnchorStore
export function installTurnAnchorHooks(ctx: {
  huaanworkTurnAnchors?: TurnAnchorStore
  on(event: string, listener: (...args: never[]) => unknown, options?: { global?: boolean }): void
}): void
```

实现要点：`anchors`/`pending` 为实例内 Map + 简单 LRU（get/set 时刷新次序，超 `limit`（默认 256）淘汰最久未用会话），**禁止模块级全局变量**；`register` 只写 `pending` 并返回精确回滚闭包（仅当 pending 仍等于本次 messageId 时移除，不清旧 anchor）；`notePreStep` 判定工具函数只把 `source?.kind === 'user'`（或历史夹具缺 `source.kind` 的 `''`）与 `source?.kind === 'goal'` 视作回合边界消息，从 `messages` 末尾向前跳过 `subagent-settled`、`agent-instructions`、`user-question-reply`、`user-approval`、`working-directory`、`skill-catalog`/`skill-invocation`、`runtime-context` 等非人类/系统通知：找到 `source.kind === 'goal'` 时不动 anchor（无原 anchor 则返回 `undefined`，fail closed）；找到普通真实用户消息（`'user'`/`''`）且带字符串 `id` 时，从 pending 取已登记 origin（未登记仍保持 `'unknown'` 降级），与现有 `clientMessageId` 相同则保持 startedAt 不变，不同则写入一次新 anchor；`pending` 记录 `{ messageId, startedAt }` 供幂等判断；未找到真实用户或 goal 消息直接返回当前 anchor（不改动、不写成 unknown）。`notePreStep` 返回处理后的当前 anchor，供其他 listener 使用。`installTurnAnchorHooks` 注册 `agent/pre-step`（载荷 `{ agent, messages, turn, signal }`，取 `sessionIdOfAgentRef(agent)`，调用 `notePreStep(sessionId, messages, new Date().toISOString())`，监听器**显式 `return next()`**）与 `session/disposed`（`clearSession` 同时清 pending/anchors）。

`holders.ts`：`declare module` 增加 `huaanworkTurnAnchors: TurnAnchorStore` 并加入 `HUAANWORK_CONTEXT_PROPS`；`installHuaanworkHolders` 内 `ctx.huaanworkTurnAnchors = createTurnAnchorStore()`。`index.ts` 在 holders 安装后调用 `installTurnAnchorHooks(ctx)`。

- [ ] **Step 4: 写宿主接线失败测试并确认失败**

`tests/huaanwork-host/turn-scheduler.spec.ts` 增补：入队项携带顶层 `clientMessageId`，`drainQueue()` 返回项保留该字段。`tests/huaanwork-host/turn-anchors.spec.ts` 增补：`resolveFollowupClientMessageId` 顶层优先、缺顶层生成 UUID、**不读 at.clientMessageId**；`turnOriginForSession('huaanwork-auto-x-y') === 'automation'`、普通会话 `'advanced'`；followup 抛错调用 register 回滚后，本次 pending 被移除且上一回合 anchor 保持不变。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-anchors.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts
```
Expected: FAIL（helper 不存在 / 字段未透传）。

- [ ] **Step 5: 实现宿主接线**

- `sessions.ts`：新增 `objectTopLevelClientMessageId(params)`（与 `objectAtClientMessageId` 同形，读 `params.clientMessageId`）。**两个解析分开**：followup 消息 id 一律 `resolveFollowupClientMessageId(params)`（顶层 ?? `randomUUID()`，不读 at）；legacy/包运行卡的 `dispatchAt` 透传值用 `objectTopLevelClientMessageId(params) ?? objectAtClientMessageId(params)`（at 值仅为无顶层的旧客户端保留）。`sessionSend` 把两个值分别传入 `admitUserTurn`（顶层 `clientMessageId` 随排队项透传；at 结构维持现状）；`sendToAgent` 在 `agent.followup(...)` 之前（注意 Task 2 的 `isUnmanagedChildSession` 拒发校验须置于 `turnAnchors.register` **之前**或与 `followup` 共享同一 `try/catch` 回滚，防止拒发抛错时残留未消费的 pending）：`const followupId = resolveFollowupClientMessageId(params)`，`const rollback = ctx.huaanworkTurnAnchors?.register({ sessionId, clientMessageId: followupId, origin: turnOriginForSession(sessionId) })`，随后用 `try { agent.followup({ id: followupId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }) } catch (error) { rollback?.(); throw error }` 受理；回滚只清本次 pending，不清上一回合 anchor。此外 `releaseSessionRuntime`（`sessions.ts:782-807`）对 `[sessionId, ...descendants]` 调用 `ctx.huaanworkTurnAnchors?.clearSession(id)`，保证 `session.remove` 删除未激活或稳定通道会话后重建同 id 时不残留旧 anchor。
- `turn-scheduler.ts`：`QueueItem` 与 `admitUserTurn` 输入增可选 `clientMessageId`，入队项保存；`startQueuedItem` 重建参数时带 `...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId })`。
- `automations-host.ts`：`runAgentTurn` 调 `sendToAgent`（`automations-host.ts:391-396`）的参数增 `clientMessageId: runId`（origin 由前缀判定为 `'automation'`，`UserMessage.id = runId`，历史 session-view 透传同一 id）。
- `session-view.ts`：与 `turn-anchors.ts` 保持同一**真实用户回合判定**——在 `summarizeSessionLog`（`:153-158`）与 `detailRecords`（`:203-220`）中仅放行 `kind === 'user' || kind === ''` 与（`detailRecords` 下）有效 `kind === 'goal' && goalRound > 0`，过滤掉 `subagent-settled`、`runtime-context`、`agent-instructions`、`skill-catalog`、`skill-invocation`、`user-question-reply`、`user-approval`、`working-directory`、`compact-checkpoint`、`plugin`、`tool` 等一切非人类/系统 `user/message`；仅普通用户记录（`goalRound === undefined`）增 `...(typeof data.id === 'string' && data.id.length > 0 ? { clientMessageId: data.id } : {})`（`goalRound` 续轮记录不写 `clientMessageId`）；`rpc-types.ts` 的历史 user record 增同名可选字段。此处只处理通用用户锚点与非人消息过滤，todo 的 ordinary-user 顺序跟踪与结构化 todos 留在 Task 4。

- [ ] **Step 6: 写客户端接线失败测试**

`tests/client-huaanwork/appWiring.spec.ts` 增补（对导出纯函数断言，不整挂载 App；并**同步更新既有 `:903-907` 源码正则钉**以匹配 `buildSessionSendParams(...)` 调用形态，不再硬编码旧对象字面量）：
- `buildSessionSendParams`：顶层 `clientMessageId` 恒等于传入的 UUID；`@` 发送仍带 `at.clientMessageId = String(userItemId)`；skill/普通发送不带 at；
- `automationRunUserItem(event.runId, task.name, items)`：无该 clientMessageId 时返回 user 条目（文案含任务名、clientMessageId 等于 runId）；已存在时返回 `undefined`（不重复追加）。

`tests/client-huaanwork/subagentRuns.spec.ts` 增补：`insertSubagentRunCard` 以 `user.clientMessageId` 精确命中；旧条目无 `clientMessageId` 时以 `String(item.id)` 兼容命中；实时（无 `allowSnapshotFallback`）且无精确锚点时**不插入**（钉死禁止 last-user 回退）。`tests/huaanwork-host/session-view.spec.ts` 同步更新既有 `:275-285` 严格 `.toEqual`（`userMessage` 夹具自带 `data.id: 'm1'`，普通 user 记录新增 `clientMessageId: 'm1'`、goal 续轮不带 `clientMessageId`），并增补：user/message `data.id` → `clientMessageId` 透传，以及 `subagent-settled`/`runtime-context`/`agent-instructions`/`skill-catalog` 等非人类 `user/message` 在 `detailRecords` 与 `summarizeSessionLog` 均不产出 `user` 记录、保留旧无 `source` 夹具通过；`tests/client-huaanwork/sessionChannel.spec.ts` 与 `appWiring.spec.ts` 分别钉 HistoryChatItem/ChatItem user 保留该字段、渲染 `id` 仍重新分配且完成通知不切出第二条用户回合。`tests/huaanwork-host/turn-anchors.spec.ts`（或 `sessions.spec.ts`）验证 `releaseSessionRuntime` 清理会话 anchor。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/subagentRuns.spec.ts
```
Expected: FAIL。

- [ ] **Step 7: 实现客户端接线**

- `App.tsx`：`ChatItem` user 分支增可选 `clientMessageId?: string`（不写 `sentAt` 客户端时钟回退）；发送路径 `const clientMessageId = crypto.randomUUID()`（先例 `Settings.tsx` 的 `crypto.randomUUID()`；**禁止** `String(userMsg.id)` 作持久锚——allocId 刷新后可重复），写入 `userMsg`（`clientMessageId`），`session.send` 参数改由 `buildSessionSendParams` 构造（顶层携带 UUID）；`@` 的 `at.clientMessageId: String(userMsg.id)` 保留不动。`automation/run-task` 分支（`1740-1775`）：`if (found)` 复用分支与新建分支**均**调 `automationRunUserItem(event.runId, task.name, targetItems)`，返回非 `undefined` 时补入该 user 条目（含 `clientMessageId: event.runId`；新建分支置于既有“自动化运行中…”note 之前；注意无项目绑定自动化按宿主契约不发 `automation/run-task`，由历史与快照对账兜底）。
- `logic/subagentRuns.ts`：`insertSubagentRunCard` 泛型约束扩为 `{ id: number; kind: string; clientMessageId?: string }`，精确匹配改为 `item.kind === "user" && (item.clientMessageId ?? String(item.id)) === input.clientMessageId`；`allowSnapshotFallback` 逻辑不动。
- `logic/sessionChannel.ts`：`HistoryChatItem` user 分支增 `clientMessageId?: string` 并从 record 透传；`App.tsx` 的 `historyToChatItems` user 分支保留该字段，数值 `id` 仍 `allocId()`，不得复用历史 ID 充当 React key。

- [ ] **Step 8: 运行回归并 Commit**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-anchors.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/session-view.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/subagentRuns.spec.ts tests/client-huaanwork/sessionChannel.spec.ts
```
Expected: PASS（`sessions.spec.ts` 为只运行回归，未修改则不进 commit 清单）。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts dsh-plugin-huaanwork/tests/huaanwork-host/turn-anchors.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat(anchors): add shared turn anchor store and UUID send wiring"
```

---

### Task 2: `subagent` 默认隐藏、包血缘附件与系统技能回合租约

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/system-skill-leases.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:471-522,782-807`（显式 `/explore`/`/test-fix` 的 `agent.followup` 前系统技能租约/附件挂载与回滚，以及 `releaseSessionRuntime` 同步清理）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:15-43`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-attachments.ts:11`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:103-107,149-278,295-378,520-539`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:108-252`
- Modify: `packages/huaanwork-policy/src/agent-catalog.ts:57-67`
- Modify: `packages/huaanwork-policy/src/agent-catalog.test.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts:113-122,1627-1631`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/system-skill-leases.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`

**Interfaces:**
- Produces: `SystemSkillKind = "explore" | "test-fix"`；`acquireSystemSkillLease(ctx, sessionId, kind)`、`acquireExplicitSystemSkillLease(ctx, sessionId, kind)`、`releaseSystemSkillLease(ctx, sessionId, options?)`、`systemSkillLeaseKindOf(ctx, sessionId)`、`noteSystemSkillGoalPhase(ctx, sessionId, phase)`、`releaseSystemSkillLeaseOnIdle(ctx, sessionId)`；`ctx.huaanworkSystemSkillLeases`（暴露 `acquire` / `acquireExplicit` / `release` / `kindOf` / `onInvalidate` 订阅，供 `skills.ts` 在租约释放与显式预挂载时同步失效对应 `agent` 的 `pendingByAgent` 与残留槽）。
- Produces: `spawnKind` ALS（`tools/execute` around-dispatch，优先取 `pendingByAgent`，缺席回落共享租约 `kindOf(sessionId)`）；消费点统一 `spawnKind.getStore() ?? pendingSpawn?.kind`。
- Preserves: `attachAgentTools/detachAgentTools` 签名与幂等性；`pendingSpawn` 兼容桥接不删除，且改为带调用归属 token 精确消费与清理。

- [ ] **Step 1: 写有效工具矩阵失败测试（含多层交集 fixture）**

`present-as.cordis.spec.ts` 覆盖单层矩阵：

```ts
const matrix = [
  { name: 'ordinary parent', parent: false, pkg: false, skill: undefined, unattended: false, expected: false },
  { name: 'attended automation outside system skill', parent: false, pkg: false, skill: undefined, unattended: false, automation: true, expected: false },
  { name: 'unattended automation', parent: false, pkg: false, skill: 'explore', unattended: true, expected: false },
  { name: 'package child with explicit allow', parent: false, pkg: true, allow: ['subagent'], expected: true },
  { name: 'legacy child', parent: true, pkg: false, skill: 'explore', unattended: false, expected: false },
  { name: 'attended explore turn', parent: false, pkg: false, skill: 'explore', unattended: false, expected: true },
] as const
```

逐项断言有效 allow 是否含 `subagent`。**PM-1**：包儿童行另在多层 restrict 交集 fixture（本文件 `:24-63` 的 `createMockAgent` 形态：schemas 全集 → present-as restrict → 二次 allow 求交）补一条钉：包 allow 含 `subagent` 且血缘在场时，交集结果仍含 `subagent`；包 allow 不含时交集不含。包儿童另跑既有 C4/C5 测试，不允许为通过新测试而删除血缘钉。

`skills.spec.ts` 增补：命中 explore 的回合 acquire 后模型可见 `subagent`；legacy 儿童与无人值守自动化 acquire 恒 false；重复 acquire 幂等。

**harness 前置改造（本 Step 与 Step 4 配套）**：新增 `dispatchTool(agent, name, args, body)`——先跑 `tools/pre-execute` waterfall（现状 `emitWaterfall`），再跑 `tools/execute` waterfall 且 **terminal = body**；`invokeSubagent` 的 `agent/created`、`subagent/start` emit 移入 terminal 内，忠实上游两阶段派发（pre-execute waterfall 的 next() 不包 body，见 Step 4 上游事实）。旧 `invokeSubagent` 形态（pre-execute 后散装 emit）删除。

- [ ] **Step 2: 确认默认可见性测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts
```
Expected: FAIL，普通父会话当前仍含 `subagent`，系统技能尚未建立租约。

- [ ] **Step 3: 实现默认移除与包儿童精确附件**

从 `ALLOWED_TOOLS` 删除 `"subagent"`；`AGENT_PACKAGE_CHILD_TOOLS = ['agent_http', 'agent_skill_run', 'subagent'] as const`。

**PM-2 措辞落地（写代码注释时按此描述，不得沿用旧计划的错误说法）**：包儿童附件有两个挂载点——`skills.ts` 的 start 包装**无条件** attach 原始 `AGENT_PACKAGE_CHILD_TOOLS`，不经 allow 过滤（rc.1 下该路径 dormant）；activation 包装按 `agentPackageChildAttachmentNames(pkg.allow, mcpNames)` 计算（`subagent` 仅当包 allow 含它才挂），allow 过滤只在这一路径发生。真正的可见性收敛在 present-as（`ALLOWED_TOOLS ∪ 附件`）与 skills.ts 的 `pkg.allow ∩ schemas` 两层 restrict 交集；`composeAgentPackageToolAllowList` 现状把 `subagent` 放进每个包基础 allow（`agent-package/runtime.ts:173-180`），故正常包儿童仍可见，普通父会话不可见。

`profile.ts`：`tool-subagent` 行保持 `disabled:false`，`:1627-1631` 注释追加 R1/R2：普通父会话默认无模型面（present-as 移除 + 系统技能租约）；系统技能与包儿童经附件获得；宿主服务始终保留；保持启用是为包 lane 深度 2 与条件可见回合。**PM-4**：`:113-122` 的 `DESKTOP_SUBAGENT_MAX_DEPTH = 2` 注释显式判定——该理由在 R1/R2 下不变（包儿童经附件保留 `subagent`，lane 深度 2 派发仍可达），追加一行注明“可见性由 present-as/租约按会话控制，与本深度默认无关”，不改动常量。

- [ ] **Step 4: 实现 `tools/execute` ALS 技能载体（PC-1 唯一修法）**

上游事实（PC-1 根因，写入代码注释）：`execute = prepareExecution(exec, prepared => completeScheduledExecution(prepared))`（上游 `packages/core/tools/src/index.ts:1377-1379`）；`prepareExecution` 的 `tools/pre-execute` waterfall 终止回调只返回 `{kind:'allow'}`（`:1513-1516`），waterfall 解析完后才 `next({kind:'dispatch', exec})`（`:1543`）；body 在 `dispatchScheduledExecution` 的 `tools/execute` waterfall 终止回调 `dispatchToolBody` 里执行（`:1609-1616` → `:1572-1600` → `tool.execute` `:1589`）。**pre-execute 里建立的 ALS 作用域到 body 阶段已出栈，读不到技能类型。**

实现（只此一种，不采用父会话 Map 备选，且 `pendingSpawn` 必须带**调用归属令牌 token**——修复 `QP-I1` 与 `QR-I1`）：

```ts
// skills.ts apply() 内
type PendingSpawnSlot = { kind: SkillKind; token: symbol; agent?: object }
const spawnKind = new AsyncLocalStorage<SkillKind | undefined>()
let pendingSpawn: PendingSpawnSlot | undefined
const slotByExecution = new WeakMap<object, PendingSpawnSlot>()
const slotsByParent = new WeakMap<object, PendingSpawnSlot[]>()

const releaseOwnedSlot = (slot: PendingSpawnSlot | undefined) => {
  if (slot !== undefined && pendingSpawn?.token === slot.token) pendingSpawn = undefined
}

const removeSlotFromParent = (agent: object | undefined, slot: PendingSpawnSlot) => {
  if (agent === undefined) return
  const queue = slotsByParent.get(agent)
  if (queue === undefined) return
  const idx = queue.indexOf(slot)
  if (idx >= 0) queue.splice(idx, 1)
  if (queue.length === 0) slotsByParent.delete(agent)
}

const clearExecutionSlot = (execution: object, agent?: object) => {
  const slot = slotByExecution.get(execution)
  if (slot === undefined) return
  slotByExecution.delete(execution)
  removeSlotFromParent(agent ?? slot.agent, slot)
  releaseOwnedSlot(slot)
}

const takeSlotForExecute = (execution: { agent?: object }): PendingSpawnSlot | undefined => {
  const byExec = slotByExecution.get(execution)
  if (byExec !== undefined) {
    slotByExecution.delete(execution)
    removeSlotFromParent(execution.agent ?? byExec.agent, byExec)
    return byExec
  }
  return execution.agent === undefined ? undefined : slotsByParent.get(execution.agent)?.shift()
}

ctx.on('tools/execute', ((execution: { name: string; agent?: object }, next: () => Promise<unknown>) => {
  if (execution.name !== 'subagent') return next()
  const slot = takeSlotForExecute(execution)
  // 进入 ALS 作用域前立即释放归属本次调用的兼容槽（若已被他方无 ALS 路径覆写则 token 不等、不误清）。
  releaseOwnedSlot(slot)
  const sessionId = sessionIdOf(execution.agent)
  const kind =
    slot?.kind ??
    (execution.agent === undefined ? undefined : pendingByAgent.get(execution.agent)) ??
    (sessionId === undefined ? undefined : ctx.huaanworkSystemSkillLeases?.kindOf(sessionId))
  return spawnKind.run(kind, () => next())
}) as never, true)

// QR-I1：tools/pre-execute 返回 allow 后，若等待期（如 workspace-changes recorder.settled()）发生取消
// 或被 tools.guard 拒绝，上游 prepareExecution 直接返回 post-result 跳过 tools/execute 并触发 tools/result。
// 同步按同一 execution 对象精确幂等清理，不按 FIFO 误拿其他调用的槽；正常派发下已在 takeSlotForExecute 摘除，此处为 no-op。
ctx.on('tools/result', ((execution: { name?: string; agent?: object }) => {
  if (execution?.name !== 'subagent') return
  clearExecutionSlot(execution, execution.agent)
}) as never, true)
```

pre-execute 保留既有判定（但对受管儿童的 `unmanaged-child-system-skill` 拒绝必须在 `rememberSkill` **之前**返回，且仅当 `acquireSystemSkillLease` 返回 `true` 时才调 `rememberSkill`，避免拒绝或无锚/无人值守返回 `false` 时在 `pendingByAgent` 留下陈旧缓存）：`rememberSkill`（写 `pendingByAgent`）、`rememberSubagentSpawn`（读取 `pendingByAgent.get(execution.agent) ?? kindOf(sessionId)`；命中时生成 `slot = { kind, token: Symbol(), ...(execution.agent === undefined ? {} : { agent: execution.agent }) }`，写入 `slotByExecution`/`slotsByParent` 及模块内兼容槽 `pendingSpawn = slot`）与 `huaanwork-${kind}` deny。`tools/pre-execute` 对已分配 `slot` 用 `try { const decision = await next(); if (decision.kind !== 'allow') clearExecutionSlot(execution, execution.agent); return decision } catch (err) { clearExecutionSlot(execution, execution.agent); throw err }` 精确回收。消费点统一改为：

```ts
const consumePendingSpawn = (agent: Agent) => {
  const fromAls = spawnKind.getStore()
  const kind = fromAls ?? pendingSpawn?.kind
  if (!kind) return
  if (pendingByAgent.has(agent)) return
  applyKind(agent, kind)
  // 只有无 ALS 覆盖的回落路径消费完单槽时清零。
  if (fromAls === undefined) pendingSpawn = undefined
}
```

这样 `agent/created`（`:224-226`）、`subagent/start`（`:258`）、start 包装（`:373`）与 activation 包装（`:521`）四个消费点在 body 阶段由 ALS 覆盖；真实 `explore/test-fix`（含 `skill` 工具与显式 `/explore`/`/test-fix`）进入 `tools/execute` 或不派发直达 `tools/result` 时即已精准释放自己的 `pendingSpawn` token 与归属表（并在租约失效/释放回调兜底清理该父代理的 `slotsByParent` 与归属 `pendingSpawn`，覆盖并行 `runGroup` 兄弟异常跳过 `tools/result` 的边界），后续任何会话（含同一或另一已存在父会话）的顺序显式 `@` 都不会继承残留的 `'explore'`/`'test-fix'`；而并发重叠且其中一方走无 ALS 兼容路径时，`token` 不匹配也不会误清他方尚未消费的 `pendingSpawn`。

`skills.spec.ts` 补六条 `QP-I1` / `QR-I1` 回归钉：（1）`explore` 成功派发完成后（及 `startActivation` reject 清理后），另一已存在父会话或同会话紧接着走无 ALS 显式 `@`（调用 `startActivation` 并触发 `agent/created` / `subagent/start`），断言该 `@` 子代理**不被**安装 `explore` restrict/guard（可执行写工具）；（2）`tools/pre-execute(name='subagent')` 返回 `deny` / 抛错后，后续显式 `@` 不受污染；（3）**`QR-I1` allow 后取消**：`tools/pre-execute` 在下游 async hook（模拟 `workspace-changes` 等待）后仍返回 `allow`，此时外部直接触发 `tools/result` 跳过 `tools/execute`，断言 `slotByExecution`/`slotsByParent`/`pendingSpawn` 已幂等清理且同/异父后续无 ALS `@` 不受污染；（4）**`QR-I1` allow 后 `guard` 拒绝**：`tools/pre-execute` 返回 `allow` 后模拟 `guardReason` 拒绝直走 `tools/result`（不进 `tools/execute`），同上断言清理且后续 `@` 不受污染；（5）并发重叠：`A` 完成 `pre-execute`、兼容路径 `B` 随后写入自己的 `pendingSpawn`、`A` 进入 `tools/execute` 或经 `tools/result` 收尾后均不得清掉 `B` 的兼容槽，`B` 无 ALS 消费仍生效；（6）**PC-1 防假绿钉**：`skills.ts` 导出只读测试钩 `currentDispatchSkillKind(): SkillKind | undefined`（即 `spawnKind.getStore()`），`skills.spec.ts` 在 `dispatchTool` 的 terminal（body 阶段）内断言 explore 流程该值为 `'explore'`（错挂 pre-execute 必红）。`Context.on` 联合类型增 `"tools/execute" | "tools/result"`，第三个参数保持 `prepend?: boolean`（与现行 `skills.spec.ts:151` harness 兼容；top-level profile 插件在无 filter 子上下文时生效，后续若迁入带 filter 子作用域再统一改 `{ global: true, prepend: true }` 并更新 harness）。

`skills.ts` 同步把 `startRun`/`subagent/start`/活动分流附近“模型自主嵌套不纳管”旧注释订正为：普通父会话模型面已不可达（R1）；系统技能派生走 `system-skill` 运行（Task 3）；包 lane 仍只受血缘收窄且一期不独立建卡（R5）。

- [ ] **Step 5: 实现租约获取、双入口接线（含显式 `/explore`/`/test-fix`）、goal 相位与权威解挂**

`system-skill-leases.ts`（holders 注入 `ctx.huaanworkSystemSkillLeases`，实例内 Map/Set，随宿主生命周期）：

```ts
type SystemSkillLease = { kind: SystemSkillKind; goalPhase?: GoalPhase }
// 独立于 leases 记录当前处于 goal.phase === 'active' 的会话，避免「goal 先激活、后续轮次才取技能租约」
// 时 commitLease 丢失 active 状态并在正常轮间 idle 提前解挂。
const activeGoalSessions = new Set<string>()

function guardSystemSkillEligible(ctx, sessionId): boolean {
  if (ctx.huaanworkUnattended?.has(sessionId)) return false
  if (isUnmanagedChildSession(sessionId)) return false        // PM-5，见下
  if (ctx.huaanworkAttachments === undefined) return false
  return true
}
acquire(ctx, sessionId, kind):
  if (!guardSystemSkillEligible(ctx, sessionId)) return false
  if (ctx.huaanworkTurnAnchors?.current(sessionId) === undefined) return false
  return commitLease(ctx, sessionId, kind)
// 显式 /explore、/test-fix 入口专供 sendToAgent 在 agent.followup 之前调用：
// 上游 systemPrompt.assemble() 在 agent/pre-step 建立锚点前即采集 Step 1 工具列表，
// 因此不能等到 pre-step 后才挂载 subagent 附件；调用方须先完成受管儿童检查、再 turnAnchors.register 登记，
// 且必须在 followup 抛错时回滚 release（不清除既有 activeGoalSessions）。
// QR-I2：显式入口写入新租约前先触发 onInvalidate(sessionId)，同步清掉同一父 agent 上残留的旧 pendingByAgent 与残留槽。
acquireExplicit(ctx, sessionId, kind):
  if (!guardSystemSkillEligible(ctx, sessionId)) return false
  notifyInvalidate(sessionId)
  return commitLease(ctx, sessionId, kind)
commitLease(ctx, sessionId, kind):
  const existing = leases.get(sessionId)
  const goalActive = activeGoalSessions.has(sessionId) || existing?.goalPhase === 'active'
  // 遵循 exactOptionalPropertyTypes: true，不向可选属性写入 explicit undefined
  leases.set(sessionId, { kind, ...(goalActive ? { goalPhase: 'active' as const } : {}) })
  attachAgentTools(ctx.huaanworkAttachments!, sessionId, ['subagent'])
  refreshAgentRestrict(ctx as never, sessionId)
  return true
kindOf(sessionId): leases.get(sessionId)?.kind
release(ctx, sessionId, options?: { clearGoal?: boolean }):
  if (options?.clearGoal === true) activeGoalSessions.delete(sessionId)
  // 即使 leases 缺席（如先前 acquire 返回 false），仍通知失效回调并幂等卸除附件，确保不残留 pendingByAgent/slots。
  notifyInvalidate(sessionId)
  if (leases.delete(sessionId)) {
    detachAgentTools(ctx.huaanworkAttachments!, sessionId, ['subagent'])
    refreshAgentRestrict(ctx as never, sessionId)
  }
noteSystemSkillGoalPhase(ctx, sessionId, phase):
  if (phase === 'active') {
    activeGoalSessions.add(sessionId)
    const existing = leases.get(sessionId)
    if (existing !== undefined) leases.set(sessionId, { ...existing, goalPhase: 'active' })
  } else {
    release(ctx, sessionId, { clearGoal: true })
  }
releaseSystemSkillLeaseOnIdle(ctx, sessionId):
  if (activeGoalSessions.has(sessionId) || leases.get(sessionId)?.goalPhase === 'active') return
  release(ctx, sessionId)
```

**PM-5**：判别函数命名 `isUnmanagedChildSession`（不叫 isLegacyChild）：`parentSessionOf(sessionId) !== undefined && !ctx.huaanworkPackageChildAllow.has(sessionId)`——无包血缘条目的受管儿童（legacy 与 system-skill 派生儿童）一律不得获取租约。注释写明：守卫内“无人值守 → 受管儿童 → 附件/锚点”的早退顺序是**正确守卫**，受管儿童命中第二跳是有意覆盖，不是顺序缺陷，禁止改成排除 system-skill 儿童。

双入口接线：
1. **模型 `skill` 工具入口**（`skills.ts` `tools/pre-execute`）：在合法性守卫最前处检查 `execution.name === 'skill' && isUnmanagedChildSession(sessionId) && ['explore','test-fix'].includes(name)` → 立即返回 `{ kind: 'deny', reason: 'unmanaged-child-system-skill' }`（在 `rememberSkill` **之前**）；非受管儿童且命中 `explore/test-fix` 时先调 `acquireSystemSkillLease(ctx, sessionId, skillName)`，**仅当返回 `true` 时**调 `rememberSkill(execution)`（返回 `false` 时不写 `pendingByAgent`，技能仍按现有规则执行且模型看不到 `subagent`）。
2. **显式 `/explore`、`/test-fix` 入口**（`sessions.ts` `sendToAgent` `:471-495`）：`session.send.skill`（含立即执行与 `turn-scheduler.ts:114` / `sessions.ts:1116` 排队出队后的 `startQueuedItem → sendToAgent`）在 `invokeSkillText` + `resolveAgent()` + `cancelled()` 检查之后：
   - 若 `skillName === 'explore' || skillName === 'test-fix'` 且 `isUnmanagedChildSession(sessionId)` → 在 `turnAnchors.register` **之前**直接拒发（抛 `'unmanaged-child-system-skill'`，不留下未消费 anchor）；
   - `turnAnchors.register` 之后、`agent.followup(...)` **之前**：若 `skillName === 'explore' || skillName === 'test-fix'`，调用 `acquireExplicitSystemSkillLease(ctx, sessionId, skillName)`（无人值守或缺附件表时返回 `false`，工具仍对模型隐藏；成功时已同步失效既有 `pendingByAgent` 旧缓存，修复 `QR-I2`）；
   - `agent.followup(...)` 若抛错（已有 `catch` 调 Anchor `rollback`），同步调用 `releaseSystemSkillLease(ctx, sessionId)` 清理本次显式租约、附件与 `pendingByAgent`（不传 `clearGoal`，保留既有 active goal 语义）！

`bridge.ts`（注意上游 [goal-round-driver/src/index.ts#L124-L132, L262-L265] 在 `agent/error` 只 `disarm(state)` 并保留持久 `goal.phase === 'active'`，且用户 cancel 经 `agent-loop` `kick` 捕获后走 `agent/status idle` 而非 `agent/error`）：
- `goal/change` 分支在现有 emit 前调 `noteSystemSkillGoalPhase`（`clear`/非 active 相位释放并清 `activeGoalSessions`，active 记录进 `activeGoalSessions` 与既有 lease）；
- `agent/status idle` 父会话分支在 `session/end` 前调 `releaseSystemSkillLeaseOnIdle`（仅正常完成后的 active goal 轮间保留；`skills.ts` 向 `system-skill-leases` 注册 `onInvalidate(sessionId)` 回调，租约释放或显式入口更新时同步移除对应 `agent` 在 `pendingByAgent` 中的缓存并清理其 `slotsByParent` / 归属 `pendingSpawn`，不依赖跨监听次序）；
- `agent/error` 父会话分支在 `session/end` 前**无条件调用 `releaseSystemSkillLease(ctx, sessionId, { clearGoal: true })`**（abort 与异常绝不泄漏到下一回合，且清理已 disarm 的 active goal 保留标记）；
- `session/event` 新增 `turn/end` 分支：当 `reason.kind === 'aborted' || reason.kind === 'error'` 且非已知子代理时，**无条件调用 `releaseSystemSkillLease(ctx, sessionId, { clearGoal: true })`**（兜住用户中止经过 `kick` 直接 `idle` 的窗口）；
- `session/disposed`（`bridge.ts:110-113`）与 `sessions.ts` `releaseSessionRuntime`（`782-807`）：对对应 `sessionId`（含后代）无条件调用 `releaseSystemSkillLease(ctx, id, { clearGoal: true })`。
技能未实际派生时回合结束同样清理附件。`system-skill-leases.spec.ts`、`sessions.spec.ts`、`skills.spec.ts` 与 `bridge.spec.ts` 须补钉：显式直发 `/explore` & `/test-fix`（`followup` 前已挂好 `subagent` 与租约、Step 1 可调用、失败回滚）、排队出队 `/explore` & `/test-fix`、模型调用 `skill` 工具三入口同一矩阵（均走 `tools/execute` ALS + 守住无人值守与受管儿童限制）；**`QR-I2` 切换钉**：active goal 下先经模型 `skill('test-fix')` 留缓存并正常 idle、再以显式 `/explore`（直发与排队出队）触发派发，验证 ALS 技能类型、`system-skill` run 标签与子代只读允许列表均切换为 `'explore'`（以及反向 `'explore'` → `/test-fix` 允许写工具）；**先 `goal/change(active)` 后获取租约**时正常轮间 idle 仍保留租约；`acquireSystemSkillLease` 返回 `false` 时不留脏 `pendingByAgent`；以及 Active Goal + `agent/error`、Active Goal + `turn/end (aborted)`、`session/disposed`/`releaseSessionRuntime` 均释放租约并清标记。

- [ ] **Step 6: 封闭 legacy 直接路径（共享包）**

`packages/huaanwork-policy/src/agent-catalog.ts` 的 `filterAgentAllow` 过滤集合增加 `'subagent'`（与 `run_code`/`call_host_tool`/`mcp__*` 同列）；`agent-catalog.test.ts` 增补：显式 allow 含 `subagent` 的条目被过滤、默认 allow 不含、既有过滤项不回归。显式 legacy 父运行不经此儿童 allow 计算，不受影响。

- [ ] **Step 7: 运行矩阵、goal、包/legacy 回归与共享包门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/system-skill-leases.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts
corepack yarn workspace @huaanwork/policy check
```
Expected: PASS。`agent-package-runtime.spec.ts`、`policy.cordis.spec.ts` 为规格评审点名回归（`:297,317,321,841,1009`、`:938-939`），只运行未修改则不进 commit；包级 check 结果如实记录。

- [ ] **Step 8: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/system-skill-leases.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-attachments.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts packages/huaanwork-policy/src/agent-catalog.ts packages/huaanwork-policy/src/agent-catalog.test.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/huaanwork-host/system-skill-leases.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts
git commit -m "feat(subagents): gate model spawning behind managed leases"
```

---

### Task 3: `system-skill` 运行进入 registry 并支持定向取消

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-cleanup.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:66-72`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts`（改接抽取的 helper，行为不变）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:62-108,396-539`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:494-525`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `ctx.huaanworkTurnAnchors`；Task 2 的 `spawnKind` ALS 与租约。
- Produces: `SubagentRunKind = "legacy" | "package" | "system-skill"`；每次系统技能派生的 Host `runId`。
- Produces: `disposeActivationWithTimeout(handle, timeoutMs)`（入参窄化为 `Pick<SubagentActivationHandle, 'dispose'>`）、`waitResultWithBudget(observed, signal, timeoutMs)`、`settleWithin(promise, timeoutMs)`（从 `agent-invoke.ts` / `agent-package/host.ts` 抽取复用至 `subagent-cleanup.ts`；后处置观察窗不得复用已 abort 的 `controller.signal`）。
- Preserves: `begin/reserveChild/bindActivation/bindUpstreamStart/attachCancel/failRun/settleResult/rejectResult/confirmCleanup/settleUpstreamEnd/parentSessionIdOf` 方法名；legacy/package 现有生命周期行为不变。

- [ ] **Step 1: 扩展 createHarness 并写启动前可见/取消失败测试（PI-1）**

`skills.spec.ts` 的 `createHarness` 扩展（**红测基建，先写测试再实现**）：

```ts
// ctx 增加（现有 harness 无 subagents 服务，invokeSubagent 从不调用 startActivation——PI-1 假绿根因）：
subagents: {
  startActivation: async (...args: never[]) => {
    const gate = deferred<ActivationRun>()
    activationGates.push({ args, gate })
    return gate.promise
  },
},
huaanworkSubagentRuns: runs,
huaanworkTurnAnchors: anchors,
// runs 是测试创建的真实 registry 或覆盖 begin/reserveChild/bindActivation/bindUpstreamStart/
// attachCancel/failRun/settleResult/rejectResult/confirmCleanup/noteCleanupBudget/snapshot 的最小 fake；
// anchors.current(sessionId) 返回 Task 1 已注册的 UUID 锚。二者与 subagents 同批注入。
// invokeSubagent 改为忠实两阶段派发：先 tools/pre-execute waterfall，再 tools/execute waterfall，
// fake startActivation 与 agent/created、subagent/start 都在 tools/execute 的 terminal（body 阶段）内触发；
// 不得在任何 pre-execute next() 内同步触发 startActivation（否则 ALS 假绿，掩盖 PC-1）。
```

测试：调用系统技能派生后、**释放 activation 之前**断言 `runs.snapshot(parentSessionId).runs[0]` 为 `{ kind: 'system-skill', phase: 'starting', label: 'explore', parentSessionId, clientMessageId: <Task 1 注册的 UUID 锚> }` 且 runId 非空；随后释放 activation、绑定 child/upstream，`subagent.cancel` 只 dispose 该 run，兄弟 run 与另一父会话不变；activation 抛错 → `failed`；**自动化会话**用 runId 锚（`origin: 'automation'`）同一断言。registry 缺失（ctx 无 `huaanworkSubagentRuns`）→ startActivation 包装抛 `subagent run registry is not initialized`；childId 不可解析 → dispose + `failRun` + `confirmCleanup` + 抛错；预留了非空 `specChildId` 且 activation 返回其他 childId 时 → 同样 dispose + `failRun` + `confirmCleanup` + 抛错，且不得调用 `bindActivation`（而 `specChildId === undefined` 如上游 `tool-subagent` 正常放行）。

另补四条生命周期钉（使用真实 `subagent-runs` registry 组合测试而非仅用 mock 替身）：
1. **pending 期取消 → activation 正常释放**：保持 `startActivation` gate 未释放，先 `requestCancel` 并断言受理（`stopping`）；随后释放 activation，包装通过提前挂载的 `attachCancel` / 晚到取消分支立即 `dispose`，在结果已结算且清理成功（`ok: true`）时最终收敛 `stopped`。
2. **pending 期取消 → 启动失败或 childId 异常**：先 `requestCancel` 进入 `stopping`，随后让 `startActivation` reject（或返回空 childId），包装必须同时调用 `failRun` 与清理确认，若无 activation（`ok: true`）或 `dispose` 成功则收敛为 `stopped`，不得因 `cleanupOk` 仍为 `false` 而永久停留 `stopping`。
3. **dispose 后观察窗独立超时（防 0ms 短路）**：在 `cancel` 已执行 `controller.abort()` 且 `dispose` fulfilled 后，`result` 持续 pending；使用虚假时钟推进一个预算窗，确认取消期间没有 0ms 立即报错，推进满预算窗后才触发 `rejectResult(systemRunId, 'execution result missing after dispose')` 并收敛终态 `stopped`。断言兄弟 run 与另一父会话仍不受影响。
4. **`dispose` 失败 / 超时严格停止仲裁（QP-I2）**：在真实 `subagent-runs` registry 下测试 `cancel` + `dispose` reject（及 timeout）与执行 `error`/`aborted`/正常结果组合——确认 `cleanupOk: false` 时写入 `activation-dispose-failed` / `activation-dispose-timeout` error 告警且**如实停留在 `stopping`**（绝不伪装 `stopped` 或私自改写成 `failed`）；而执行 `error`/`aborted` + `dispose` fulfilled（`cleanupOk: true`）按既有严格停止仲裁收敛 `stopped`。

- [ ] **Step 2: 确认系统技能当前不产生 Host run**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/subagent-runs.spec.ts
```
Expected: FAIL，模型自主分支当前没有 Host runId。

- [ ] **Step 3: 抽取共享清理 helper**

`subagent-cleanup.ts`：自 `agent-invoke.ts` 抽取 `disposeLegacyActivation`（改名 `disposeActivationWithTimeout`，**入参收窄为实际仅消费 `.dispose()` 的 `Pick<SubagentActivationHandle, 'dispose'>`**，修复 `QP-M4` 与 `childId?: unknown` 不兼容的 `TS2345`）、`waitForLegacyResult`（改名 `waitResultWithBudget`），并导入/再导出 `settleWithin`（自 `agent-package/host.ts`），保留验收注入缝；`agent-invoke.ts` 改 import，行为零变化（既有 legacy 测试保持绿）。

- [ ] **Step 4: 在 `startActivation` 第一个 await 前建立 run 并接线生命周期**

`skills.ts`：

```ts
// ActivationRun 扩展（PM-3① + QP-M4）：保留 childId?: unknown 边界解析（由 sessionIdOf 校验），
// 将上游 receipt 恒有的 result: Promise<unknown> 与 dispose(): Promise<void> 设为必填，
// 消除 result undefined（TS18048）与 dispose 可选冲突，并可无断言传给 Pick<SubagentActivationHandle, 'dispose'>；
// 同步在 skills.spec.ts 等清理夹具中按该合同补齐 result/dispose 桩。
// Context.huaanworkSubagentRuns 的 Pick 扩展为实际调用全集（PM-3②，保留 settleUpstreamEnd——
// subagent/end 监听 :267 消费它，按字面替换会丢）：
// begin/reserveChild/bindActivation/attachCancel/failRun/settleResult/rejectResult/confirmCleanup/noteCleanupBudget
// + 既有 bindUpstreamStart/settleUpstreamEnd/parentSessionIdOf。

const skillKind = spawnKind.getStore()
const registry = ctx.huaanworkSubagentRuns
let systemRunId: string | undefined
if (
  hostRunId === undefined &&
  parentFromCall !== undefined &&
  skillKind !== undefined &&
  ctx.huaanworkPackageChildAllow?.has(parentFromCall) !== true
) {
  if (registry === undefined || typeof registry.begin !== 'function') {
    throw new Error('subagent run registry is not initialized') // 装配错误要响亮，禁止 ?.begin 静默继续
  }
  const anchor = ctx.huaanworkTurnAnchors?.current(parentFromCall)
  systemRunId = registry.begin({
    parentSessionId: parentFromCall,
    kind: 'system-skill',
    label: skillKind,
    ...(anchor?.clientMessageId !== undefined ? { clientMessageId: anchor.clientMessageId } : {}),
  })
}
const effectiveRunId = hostRunId ?? systemRunId
```

当 `systemRunId !== undefined` 时（同 `agent-invoke.ts:242-329` 结构，在首个 `await` 与 `startRun.run` **之前**）：
1. 若 `typeof specChildId === 'string' && specChildId.length > 0`，先 `activeRegistry.reserveChild(systemRunId, specChildId)`；
2. 提前声明本次调用级 `controller = new AbortController()`、`let activation: ActivationRun | undefined`、`let cancelRequested = false`、`let cancelledAfterPublish = false`、`let cleanupPromise: Promise<void> | undefined`、`let resultObserved: Promise<void> | undefined`、`let failedReported = false`；
3. 提前注册 `activeRegistry.attachCancel(systemRunId, async () => { cancelRequested = true; controller.abort(); if (activation !== undefined) await cleanup('cancel') })`；
4. 用 `effectiveRunId` 进入现有 `startRun.run(effectiveRunId, ...)`；返回后若发现 `effectiveRunId !== undefined` 的三方 parent-mismatch：当 `systemRunId !== undefined` 时先设 `activation = run`、`failedReported = true`、调 `failRun(systemRunId, 'subagent activation parent mismatch')` 并经 `await cleanup('cancel')` 再 `throw`（避免既内部吞错 `dispose` 又让外层 `catch` 二次以 `ok: true` 调 `confirmCleanup`）；`hostRunId` 沿用既有 C4 `dispose + throw`；
5. `activation` 返回后解析 `childSessionId = sessionIdOf(run?.childId)`；若 `run === undefined || childSessionId === undefined` 或 `(typeof specChildId === 'string' && specChildId.length > 0 && childSessionId !== specChildId)`：
   - 令 `activation = run`；先标记 `failedReported = true` 并调用 `activeRegistry.failRun(systemRunId, ...)`；
   - 若 `run !== undefined` 经 `await cleanup('cancel')`（dispose + 跳过 `resultObserved` 检查 + `confirmCleanup`），再 `throw`（外层 `catch` 因 `failedReported` 不重复调 `failRun`）；
6. 校验通过且已完成 TypeScript 窄化后：`activation = run`、`bindActivation(systemRunId, { childId: childSessionId })`，立即调 `observeResult(run)`（`run.result` 必填，无需 `!` 或可选跳过）；
   - 若启动期已收到取消（`cancelRequested === true`）：标记 `cancelledAfterPublish = true`，立即 `await cleanup('cancel')` 并抛出取消错误（同 `agent-invoke.ts:400-402`，避免向上游 `tool-subagent` 返回已处置的激活句柄）；
   - 外层 `catch`：`systemRunId !== undefined` 时，若 `!cancelledAfterPublish && !failedReported` 先调 `failRun(systemRunId, errorText(error))`（标记 `failedReported = true`），并 `await cleanup(cancelRequested ? 'cancel' : 'idle')`（`activation === undefined` 时 `ok = true` 并调用 `confirmCleanup`），既防止晚到取消污染 `failure` 字段，也保证 pending 期取消且 `dispose` 成功时的 `stopping` run 必定收敛。

`cleanup(mode: 'idle' | 'cancel')`（PI-2，`cleanupPromise ??=` 去重）：
1. 若 `activation === undefined` → `ok = true`，进 `finally` 调 `confirmCleanup(systemRunId, { ok: true, warnings })`；
2. 仅 `mode === 'idle' && !cancelRequested && resultObserved !== undefined` 时做 graceful result 等待：`waitResultWithBudget(resultObserved, controller.signal, cleanupTimeoutMs)`；超时 → `noteCleanupBudget` + 日志，转 dispose；`cancel` 模式跳过本步；
3. `disposeActivationWithTimeout`：`fulfilled` → `ok = true`；`rejected`/`timeout` → 追加对应 `activation-dispose-failed` / `activation-dispose-timeout` error 告警且 `ok = false`；
4. `dispose` 后结算观察窗：若 `resultObserved !== undefined`（已在 item 4/5 由 `failRun` 结束执行的路径无 `resultObserved`，跳过本步），调用 **`await settleWithin(resultObserved, cleanupTimeoutMs)`**（**禁止传入已 `abort()` 的 `controller.signal` 调 `waitResultWithBudget`，否则 0ms 立即返回 `'cancelled'`；也不得把 `undefined` 传入 `settleWithin`，否则 `promise.then` 抛 TypeError**）；返回 `false`（超窗）→ 调 `activeRegistry.rejectResult(systemRunId, 'execution result missing after dispose')` 补 `executionEnded`；
5. `finally` → `activeRegistry.confirmCleanup(systemRunId, { ok, warnings })`。
正常完成（`observeResult` settled 且 `!cancelRequested`）→ 触发 `void cleanup('idle')`。

cancel 后终态仲裁完全遵守既有 `subagent-runs.ts` 严格停止语义（`QP-I2`）：`stopping` 吸收 `error`/`aborted` 执行结局并在 `executionEnded && cleanupOk` 为真时收敛为 `stopped`（`dispose` 成功 + 独立观察窗保证清理已确认路径不永停 `stopping`）；若 `dispose` reject 或超时导致 `confirmCleanup(..., { ok: false, warnings })`，run **如实保留 `error` 告警并停留在 `stopping`**，包装层不得手动置 `stopped`，也不得误写成 `failed`。同批把 `stopReasonOf`/`errorText` 自 `agent-invoke.ts` 导出复用。

- [ ] **Step 5: 扩展类型**

`subagent-runs.ts` begin 输入 kind 联合与 `rpc-types.ts` `SubagentRunProjection.kind` 增加 `'system-skill'`；RPC 投影增规格预留可选字段 `taskId?: string; parentRunId?: string; depth?: number`。实时主流卡只用统一 clientMessageId 精确锚定——**删除旧计划“锚点缺失时回退到当前标签最后一条用户消息”的提案**：App 实时路径维持现状（不传 `allowSnapshotFallback`），无精确锚点即不插卡，等历史/snapshot 对账；goal 续轮 run 沿用原 anchor（store 保证 startedAt 不换新 wall-clock）；自动化会话由 Task 1 的 runId 锚定。`subagentRuns` 的 phase/alerts/revision/stale 不按 kind 分支复制。

- [ ] **Step 6: 运行 registry、路由和客户端回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-host/subagent-routes.spec.ts tests/huaanwork-host/agent-package-legacy.spec.ts tests/client-huaanwork/subagentRuns.spec.ts tests/client-huaanwork/SubagentRunCard.spec.ts
```
Expected: PASS；终态不复活、stopping 不回退、严格 stopped、快照去重与 legacy 生命周期不变；`subagent-routes.spec.ts`、`agent-package-legacy.spec.ts`、`SubagentRunCard.spec.ts` 只运行未修改则不进 commit。

- [ ] **Step 7: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/subagent-cleanup.ts dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts
git commit -m "feat(subagents): register system skill runs"
```

---

### Task 4: todo 实时回合归属（clientMessageId + roundKey）与历史待办投影

**Files:**
- Create: `packages/huaanwork-policy/src/todo.ts`
- Create: `packages/huaanwork-policy/src/todo.test.ts`
- Modify: `packages/huaanwork-policy/package.json`（exports 增加 `./todo`）
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/todoProjection.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:120-172,396-414`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:1-12,200-256`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:434-449,538-549`（历史 `SessionDetailRecord` 与实时 `tool/start` 变体同批扩字段）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:91-202`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:299,938-953,1687-1715,2904-2988,3313-3344,4476-4481,4730-4736`（含 `PendingSend` / `takePendingBuffer` 在 `waiting` 交错分支重放已启动 todo）
- Modify: `AGENTS.md:67`
- Modify: `docs/project-memory-archive.md:90`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/todoProjection.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts`

**Interfaces:**
- Produces: `normalizeTodoEntries(value: unknown): TodoEntry[] | undefined`（**`@huaanwork/policy/todo` 中唯一实现，bridge 与 session-view 共用**；非数组 → undefined；数组 → flatMap 丢坏条目，空数组合法）。
- Produces: `shouldApplyTodoEvent(items, currentTurnStart, event, snapshotRoundKey): boolean`（当前回合 `user.clientMessageId` **严格精确匹配** + roundKey 必填且不小于当前快照 roundKey；**无锚 user 条目即使 `String(id)` 相等亦拒绝**，修复 `QP-M2`）。
- Produces: `currentSnapshotRoundKey(items, currentTurnStart): number | undefined`。
- Produces: 历史 `HistoryChatItem {kind:"todo"; todos; roundKey?; clientMessageId?}`；RPC `SessionDetailRecord` tool-call 增 `todos?`/`clientMessageId?`。
- Preserves: Task 1 已完成的 user `clientMessageId` 类型与 session-view/sessionChannel/App 透传；本任务不重复实现。
- Preserves: bridge.spec.ts:534-560 既有 flatMap 语义；非 todo 工具的历史与实时映射。

- [ ] **Step 1: 写共享解析与归属失败测试**

```ts
it('normalizes the three todo states and drops malformed entries', () => {
  expect(normalizeTodoEntries([
    { content: '分析', status: 'completed' },
    { content: '实施', status: 'in_progress' },
    { content: '验证', status: 'pending' },
  ])).toHaveLength(3)
  // 与实时 bridge（bridge.spec.ts:534-560）同一语义：坏条目逐条丢弃，不是整单拒绝
  expect(normalizeTodoEntries([{ content: '核对', status: 'weird' }, { content: 3, status: 'pending' }])).toEqual([])
  expect(normalizeTodoEntries([])).toEqual([])            // 空数组合法
  expect(normalizeTodoEntries('{"todos":[]}')).toBeUndefined()  // 非数组 → undefined
})

it('rejects events without exact anchor or with stale roundKey', () => {
  const items = [
    { kind: 'user', id: 1, clientMessageId: 'm-1' },
    { kind: 'todo', todos: [{ content: '旧任务', status: 'completed' as const }], roundKey: 4, id: 2 },
    { kind: 'tool', roundKey: 4, id: 3 },
  ]
  const turnStart = 1
  expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: 'm-0', roundKey: 5 }, 4)).toBe(false) // 上一回合迟到
  expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: 'm-1', roundKey: 3 }, 4)).toBe(false) // roundKey 回退
  expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: 'm-1', roundKey: 4 }, 4)).toBe(true)  // 同 roundKey 允许
  expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: 'm-1', roundKey: 5 }, 4)).toBe(true)
  expect(shouldApplyTodoEvent(items, turnStart, { roundKey: 5 }, 4)).toBe(false)                          // 无锚 fail-closed
  expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: 'm-1' }, 4)).toBe(false)             // roundKey 必填
  // QP-M2：用户条目无 clientMessageId 时，即使事件 clientMessageId 恰好等于 String(id) 亦必须拒绝
  expect(shouldApplyTodoEvent([{ kind: 'user', id: 7 }], 1, { clientMessageId: '7', roundKey: 5 }, 0)).toBe(false)
})
```

goal 续轮与完成通知：当前回合 user 条目仍为原 anchor id 时事件携带同一 id → 通过（不另设 user 条目）；在 `session-view.spec.ts`、`sessionChannel.spec.ts` 与 `turn-anchors.spec.ts` 补一条联动夹具：真实用户发送 → `subagent-settled`（及 `runtime-context`/`agent-instructions`/`skill-catalog`）落盘 → 续调 `todo_write` 与回放历史，确认全过程只保留 1 条用户回合、todo_write 仍锚定原真实用户 `clientMessageId`。

在 `appWiring.spec.ts` 同时补全早到 `todo_write` 行为测试（保留既有 `:1646-1658` 与 `:1710-1711` 源码正则钉）：`started: true` 分支重放；`waiting` 应答到达前已收 `[queue-start(qb), tool/start(todo_write, mb)]` 时（含 `goalIntermediate === true` 导致前端 `running === true` 的连续排队场景）确认本次排队项已启动并按 `clientMessageId === mb` 保留缓冲且重放（`queue-start` 先于 `todo_write`）；未启动/`queue-fail(qb)`/携带旧回合或他项 id 的 `todo_write` 一律丢弃不吞旧回合。

- [ ] **Step 2: 确认测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/todoProjection.spec.ts
```
Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现共享解析、bridge 归属字段与实时守卫**

`packages/huaanwork-policy/src/todo.ts` 实现 `normalizeTodoEntries` 并导出结构化 `TodoEntry` 类型，`src/todo.test.ts` 覆盖 Step 1 的解析矩阵；`package.json.exports` 增加 `"./todo": "./src/todo.ts"`。`todoProjection.ts` 从 `@huaanwork/policy/todo` 导入并再导出该解析函数供 bridge 使用，自身只实现 `shouldApplyTodoEvent` 与 `currentSnapshotRoundKey`（`TodoEntry` 与 `logic/outcomeCheck.ts` 的现有结构保持兼容）。`shouldApplyTodoEvent` 不再扫描 `previousMaximum`：取 `items[currentTurnStart - 1]`（当前回合开启者），严格校验 `item.kind === 'user' && typeof item.clientMessageId === 'string' && item.clientMessageId === event.clientMessageId` 才算命中（删除旧运行的 `String(id)` 数值回退，修复 `QP-M2`）；goal 续轮与 `subagent-settled` 通知后均不插 user 条目，自然落在同一开启者上。

`bridge.ts`：`Context` 增 `huaanworkTurnAnchors?: { current(sessionId: string): { clientMessageId: string } | undefined }`；`tool/start` emit 增 `...(anchor?.clientMessageId === undefined ? {} : { clientMessageId: anchor.clientMessageId })`（`const anchor = sessionId === undefined ? undefined : ctx.huaanworkTurnAnchors?.current(sessionId)`，保留 roundKey）；`startDetail` 的 todo 分支改调 `normalizeTodoEntries(objectArgs.todos)`（语义与现状一致，bridge.spec.ts:534-560 不改也绿）。

`App.tsx`：
- `ChatItem` todo 分支增 `roundKey?: number; clientMessageId?: string`；`PendingSend` 增 `clientMessageId: string`；
- **早到实时事件防误丢（含 `waiting` 与 `goalIntermediate` 交错分支，`QP-I6`）**：
  1. `holdEarlyEvent`（`1687-1715`）补入 `incoming.event === "tool/start" && incoming.name === "todo_write"`：置于 `running-turn` 守卫**之前**判断 `pendingSendOfSession(sessionId)` 与 **`incoming.clientMessageId === pending.clientMessageId`**，匹配时缓冲并提前返回 `true`（从而 `goalIntermediate === true` 保留前端 `running === true` 期间，同会话新排队回合在 `waiting` 返回前早到的 `todo_write` 不会被 `running-turn` 守卫丢弃，而上一回合或他项因 `clientMessageId` 不匹配天然不进 `pending.buffered`）；同时保留 `isGoalEvent` 末尾的 `pending.buffered.push(incoming);` 在 `crossTabGuard` 之后，确保 `appWiring.spec.ts:1710-1711` 的 `lastIndexOf("pending.buffered.push(incoming);") > crossTabGuardAt` 源码钉继续成立；
  2. 抽取可单测纯函数（如 `logic/sessionChannel.ts` `takeEarlyPendingEvents(sent, buffered, pendingClientMessageId, isQueueControl)` 供 `takePendingBuffer` `938-953` 调用），并在 `takePendingBuffer` 函数体内原样保留 `appWiring.spec.ts:1646-1658` 所需的字面量分支与匹配谓词（即保留 `if (sent.waiting && sent.queueItemId !== undefined)` 及内联传入 `isQueueControl` 中的 `(event.event === "session/queue-start" || event.event === "session/queue-fail") && event.queueItemId === queueItemId`，切勿把该字面量完全移走）：
     - `sendOpensTurn(sent)` 为真时返回全量 `buffered`；
     - `sent.waiting && sent.queueItemId !== undefined` 分支：筛选匹配本次 `queueItemId` 的 `session/queue-start` / `session/queue-fail`；**仅当 `buffered` 中已包含本次 `queueItemId` 对应的 `session/queue-start` 时**，同步保留 `event.event === "tool/start" && event.name === "todo_write" && event.clientMessageId === pendingClientMessageId`，并确保 `session/queue-start`（调 `beginQueuedTurn` 开回合清 `notStarted`）先于 `tool/start(todo_write)` 重放；未启动、`queue-fail` 或他项/无 `clientMessageId` 事件一律继续丢弃；
- `tool/start` todo 分支（`4476-4481`）：先 `currentTurnStart(prev)` 与 `currentSnapshotRoundKey(prev, turnStart)`，未过 `shouldApplyTodoEvent` 直接返回 `prev`（面板与主流都不更新），通过则 `upsertTodoItem(prev, todos, allocId, event.roundKey, event.clientMessageId)`（`upsertTodoItem` 增 `roundKey`/`clientMessageId` 并写入 todo 条目）。

- [ ] **Step 4: 实现宿主历史结构化字段（PC-2 & QP-I4）**

`session-view.ts`：
- 沿用 Task 1 的人类 `user/message` 白名单（仅 `kind === 'user' || kind === ''` 视作普通人类回合，有效 `kind === 'goal' && goalRound > 0` 保留 `goalRound`；过滤 `subagent-settled`、`runtime-context`、`agent-instructions`、`skill-catalog`、`skill-invocation`、`user-question-reply`、`user-approval`、`working-directory`、`compact-checkpoint` 等非人类/系统消息）与 `data.id` 透传；
- 顺序扫描维护 `currentOrdinaryUserClientId`：仅推入真实普通用户记录（`kind === 'user' || kind === ''`，无 `goalRound`）时用其 `clientMessageId` 更新；goal 续轮记录（带 `goalRound`）与已被过滤的系统/插件消息**不清空也不篡改**它；
- `tool/call` 的 `todo_write` 分支（`240-255`）：从 `@huaanwork/policy/todo` 导入 `normalizeTodoEntries`，并从已导入的 `../client-huaanwork/logic/commandOutcome.ts` 再引入 `parseToolArguments`：**必须先执行 `const parsedArgs = asObject(parseToolArguments(data.arguments))`**（真实 JSONL 持久化日志的 `data.arguments` 为 JSON 字符串，`session-view.spec.ts:302-310` 已证实直接传给 `asObject` 会返回 `{}`），再执行 `const todos = normalizeTodoEntries(parsedArgs.todos)`，记录携带 `...(todos !== undefined ? { todos } : {})`、`...(currentOrdinaryUserClientId !== undefined ? { clientMessageId: currentOrdinaryUserClientId } : {})` 与既有 `roundKey`；其余 tool-call 不动。**不从 `formatToolArguments`（200 字截断）恢复 todos，也不从客户端 UI 模块反向导入。** `session-view.spec.ts` 必须同时覆盖对象形状与长 JSON 字符串形状（> 200 字符）两条 `todo_write` 日志用例。

`rpc-types.ts`：`tool/start` 事件变体增 `clientMessageId?: string`，与 bridge 新增字段同批落地；历史 tool-call 增 `todos?: { content: string; status: "pending" | "in_progress" | "completed" }[]` 与 `clientMessageId?: string`；user 的同名可选字段由 Task 1 提供，本任务只消费。

- [ ] **Step 5: 实现历史映射、tool-result 去重与 R-12 关闭**

`sessionChannel.ts`：沿用 Task 1 的 user `clientMessageId` 透传，新增 todo 联合分支 `{ kind: "todo"; todos: TodoEntry[]; roundKey?: number; clientMessageId?: string }`。`historyItemsFromRecords`：
- tool-call 的 `todo_write`：非数组 `record.todos` → `{ kind: "note", text: "历史待办无法解析" }`；数组 → `{ kind: "todo", todos: record.todos, ...(roundKey), ...(clientMessageId) }`（坏条目已由 session-view 逐条过滤；空数组是合法空快照）；同时把 callId 记入 `todoCallIds`；
- tool-result 分支开头：`record.callId !== undefined && todoCallIds.has(record.callId)` 时 `continue`（不生成第二次 todo、不生成孤儿工具失败 note）。

`App.tsx` `historyToChatItems`：user 分支沿用 Task 1 的 `clientMessageId` 透传；新增显式 todo 分支 `{ id: allocId(), kind: "todo", todos: item.todos, ...(roundKey), ...(clientMessageId) }`，不落入 note 兜底。

按当前仓规（`AGENTS.md:48` 只留活跃项、已关闭项放 `docs/project-memory-archive.md`）：从 `AGENTS.md:67` 活跃表删除「`Live todo_write becomes a todo card while historical todo_write remains a tool card, so counts can differ.`」行，并在 `docs/project-memory-archive.md:90` 的 `todo_write` R-12 条目补注已由本计划 Task 4 与上述测试关闭（实时/历史均投影待办卡；不得删除历史记录）。

- [ ] **Step 6: 运行历史/实时回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/todoProjection.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-host/session-view.spec.ts
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace @huaanwork/policy check
```
Expected: PASS；新回合未收到 todo 时没有旧快照冒充当前任务；`@huaanwork/policy/todo` 在 tsdown ESM 与 Vite CJS 双构建均解析成功；`toolPanel.spec.ts`、`outcomeCheck.spec.ts`、`bridge.spec.ts` 未修改则不进 commit。

- [ ] **Step 7: Commit**

```bash
git add packages/huaanwork-policy/package.json packages/huaanwork-policy/src/todo.ts packages/huaanwork-policy/src/todo.test.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/todoProjection.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx AGENTS.md docs/project-memory-archive.md dsh-plugin-huaanwork/tests/client-huaanwork/todoProjection.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts
git commit -m "fix(progress): align live and historical todo projection"
```

---

### Task 5: 右侧 ProgressPanel 聚合投影、全量门禁与 agent 真机走查自动化测试

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:1043-1067,4136-4141`（替换右栏 `rightTab === "progress"` 占位并接线 `ProgressPanel` + 二次确认）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`（由 gen:styles 重新生成）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/progressPanel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/ProgressPanel.spec.ts`
- Create: `dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs`（Step 7 agent CDP 真机走查自动化脚本）
- Test: `dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs`（走查判据/日志解析纯函数 `node --test` 单测，自动纳入 `verify:host`）
- Create: `docs/evidence/2026-11-15-progress-sidebar-acceptance.md`（Step 7 执行自动化走查后生成脱敏文本证据）

**Interfaces:**
- Consumes: `TodoEntry`、`ToolPanelView`、`SubagentRunView`、Task 4 的 todo roundKey/clientMessageId、Task 1 的锚点、Task 3 的 run kind；Step 7 复用 `scripts/huaanwork-accept-host-restart.mjs` 的 `assertHostRestartEvidence` 及既有 CDP/zstd 走查约定。
- Produces: `selectProgressPanelModel(input): ProgressPanelModel`、默认导出 `ProgressPanel`、`SubagentRunSummary`；CLI `node dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs --out <dir> [--timeout <ms>] [--cdp <port>]`（exit `0` PASS / `1` FAIL / `3` BLOCKED），并导出 `assertProgressSidebarAcceptanceFacts` / `inspectSessionHeaderTools` 等纯判据函数。
- Preserves: 会话主流中的 todo、工具和子 agent 卡。

- [ ] **Step 1: 写选择器失败测试**

```ts
const baseInput = {
  sessionId: 'session-1',
  items: [
    { kind: 'user' as const, id: 1, clientMessageId: 'message-1' },
    { kind: 'todo' as const, id: 2, clientMessageId: 'message-1', roundKey: 5, todos: [
      { content: '一', status: 'completed' as const },
      { content: '二', status: 'in_progress' as const },
      { content: '三', status: 'pending' as const },
    ] },
  ],
  currentTurnClientMessageId: 'message-1',
  turnFinal: false,
  activity: [],
  subagents: [],
  connection: 'live' as const,
}

it('projects counts without inventing per-task percentages', () => {
  const model = selectProgressPanelModel(baseInput)
  expect(model.completedCount).toBe(1)
  expect(model.totalCount).toBe(3)
  expect(model.tasks.map((task) => task.displayStatus)).toEqual(['completed', 'in_progress', 'pending'])
  expect(model).not.toHaveProperty('percentage')
})

it('overlays interruption without rewriting the source todo', () => {
  const model = selectProgressPanelModel({ ...baseInput, turnFinal: true })
  expect(model.tasks.map((task) => task.displayStatus)).toEqual(['completed', 'interrupted', 'pending'])
  expect(baseInput.items[1].todos.map((todo) => todo.status)).toEqual(['completed', 'in_progress', 'pending'])
})
```

另测：空任务与已结束无 todo 回合显示 `empty`（不显示百分比、不误判 `waiting`）；有已启动且未终结当前回合且无 todo 时显示 `waiting`；多个 `in_progress` 全保留；**当前回合 `activity` 筛选**（多回合 `toolRows` 输入时，前序历史回合的工具面板不得进入右栏 `activity`，只保留 `currentTurnStart` 之后的当前回合面板，且原 `turnFinalByUserId` 判断不丢失）；`connection` 三态（`sidecarDead → 'disconnected'`、`!sidecarDead && ((!ready && sawReady) || subagentConnection === 'disconnected') → 'reconnecting'`、其余及初始启动态 → `'live'`）；活跃 run 全进、`clientMessageId === currentTurnClientMessageId` 的终态 run 进、其他回合终态与无锚终态（如 LRU 淘汰或历史未记录锚点）fail-closed 不进终态列表；包 lane 无独立行。

- [ ] **Step 2: 确认选择器与组件测试失败**

在 `ProgressPanel.spec.ts` 同时补钉**二次确认行为**：点击摘要「终止」只触发 `onRequestCancel(run.runId)`（绝不直接调 `confirmCancel` / `subagent.cancel`），仅当 `confirmingRunId === run.runId` 展开确认区后点击「确认终止」才调用 `onConfirmCancel(run.runId)`，点击「取消」调 `onDismissCancel(run.runId)`。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/ProgressPanel.spec.ts
```
Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现纯选择器**

类型与规格 §9 一致（`taskPhase: 'ready' | 'waiting' | 'empty'`）。
1. **分步任务区**：只读当前回合最后一个 todo 快照（`currentTurnStart` 之后最后一条 todo 条目，clientMessageId 已在 Task 4 守卫），计算 `completed/total`；存在 todo 快照时 `taskPhase = 'ready'`，并按 `turnFinal === true` 给原始 `in_progress` 叠加 `interrupted`（含正常/历史结束仍未标记 completed 的项，不改原数组）；无 todo 时若存在已启动且 `!turnFinal` 的当前用户回合（`currentTurnStart > 0`）则 `taskPhase = 'waiting'`，否则（空会话或回合已结束无 todo）`taskPhase = 'empty'`。
2. **当前回合活动筛选**：入参保留完整 `items` 与 `toolRows`（`projectToolPanels(items, ...)`），选择器按 `items.slice(currentTurnStart(items))` 中条目的 `id` 集合过滤 `toolRows`，只提取属于当前回合的 `ToolPanelView[]`（确保前序历史回合工具面板不渗入右栏，也不破坏 `turnFinalByUserId` 对当前回合的折叠计算）。
3. **子 agent 与连接三态**：子 agent 列表包含全部活跃 run，以及 `typeof currentTurnClientMessageId === 'string' && run.clientMessageId === currentTurnClientMessageId` 的终态 run（`App.tsx` 直接传当前回合已启动 user 条目的 `clientMessageId`，**不传递、也不回退客户端 `user.sentAt` 时钟**，修复 `QP-M1`——缺权威锚点时无锚 `system-skill` 仅在活跃期显示、终态 fail-closed 不进列表）。连接三态由现有 `ready`/`sawReady`/`sidecarDead`/`subagentRuns.connection` 按规格 §9 合成：`sidecarDead ? 'disconnected' : (!ready && sawReady) || subagentConnection === 'disconnected' ? 'reconnecting' : 'live'`。

- [ ] **Step 4: 实现窄栏组件并替换占位**

组件分三区（结构同原设计）：连接状态提示（`disconnected` / `reconnecting`）、分步任务（`waiting`/`empty`/计数/列表）、当前执行活动（复用 `ToolPanel` 的 `panel/onToggle`）、子 agent（从 `SubagentRunCard` 抽取 `SubagentRunSummary` 与共享确认子结构：接收 `run`、`now`、`frozenAt`、`confirming`、`cancelBusy`、`cancelError`、`onRequestCancel`、`onConfirmCancel`、`onDismissCancel`，完整复用 `requestCancelSubagent` → 行内二次确认 → `confirmCancelSubagent(run.runId)` 与 `STALE_TEXT`/告警/耗时/工具摘要纯函数，不另建第二套确认 state）。将 `App.tsx:4136-4141` 的“任务进度将显示在这里”占位替换为当前会话 `ProgressPanel`；保留主流卡片与现有 reducer。合并 #29 技能代码时确认 `skillChangeSignal` 等既有接线不被覆盖（见 Global Constraints）。

- [ ] **Step 5: 生成样式并运行聚焦与全量门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork gen:styles
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/ProgressPanel.spec.ts tests/client-huaanwork/styles-generated.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn workspace @huaanwork/policy check
corepack yarn check
```
Expected: PASS，真实结果如实记录；`styles-generated.spec.ts` 只运行未修改则不进 commit。若 `verify:aa` 出现既有并发竞争，串行单独重跑并如实记录。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/tests/client-huaanwork/progressPanel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/ProgressPanel.spec.ts
git commit -m "feat(progress): add managed task and subagent sidebar"
```

- [ ] **Step 7: 编写并执行 agent 真机走查自动化测试（规格 §14.2）**

先按 TDD 原则为走查脚本的纯判定逻辑建立失败测试：创建 `dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs`（覆盖 `assertProgressSidebarAcceptanceFacts` 与 `inspectSessionHeaderTools`：`request/header.tools` schema 提取、普通回合不含 `subagent`、系统技能三阶段开放-收回对比、包 lane 深度 2 身份链检验、Host 重启接力校验及单次 `subagent.cancel` 校验）。

Run:
```bash
node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs
```
Expected: FAIL，`huaanwork-accept-progress-sidebar.mjs` 尚未实现。

实现 `dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs`（导出上述纯判据函数供 `.spec.mjs` 导入，并在 CLI 主入口按 `scripts/huaanwork-accept-three-packages.mjs` 与 `scripts/huaanwork-subagent-run-windows-acceptance.mjs` 先例在隔离临时 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1` 下启动工作区构建 Electron `lib/main.js`）：

- **前置检查与退出码**：只读复制本机 `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 中的真实模型配置到隔离 profile（绝不打印或入库 `api_key`；缺失或 `zstd` CLI 缺失直接报 `BLOCKED` 并 exit `3`）；CLI 固定 exit `0` PASS / `1` FAIL / `3` BLOCKED，自动化测试全部在隔离 workspace 内执行。
- **七项自动化 CDP 驱动与断言**（每项自动抓取 DOM facts + 截图到 `--out` 目录，并在失败时抓拍 `99-failure.png` 与日志）：
  1. **复杂任务进度**：CDP 发送包含 3 个以上 Task 的复杂请求 → 切换右栏「进度」页签 → 断言任务列表渲染、高亮项存在、顶部计数 `已完成 X/Y` 匹配且主流 `.todo-card` 唯一，读取 `session.v4.jsonl.zstd` 确认含 `todo_write`。
  2. **活动无虚构百分比**：执行期间与完成后采集右栏 DOM → 断言任何单步无百分比文本/进度条、顶部计数保持 `X/Y`、工具活动区仅含当前回合工具面板且与 `session.v4.jsonl.zstd` 中对应 `clientMessageId`/`roundKey` 的 `tool/start` 一致。
  3. **普通父会话不可自主派发**：普通请求完成后通过 `zstd -dc` 解析 `session.v4.jsonl.zstd`，调用 `inspectSessionHeaderTools` 断言普通回合全部 `request/header` 的 `header.tools` schema 不含 `subagent`；随后 CDP 发送显式 `@agent` 请求，断言 `.subagent-run-card` 出现并能执行定向终止收敛。
  4. **`explore` 与 `test-fix` 双入口双技能纳管**：依次自动驱动 `explore`（分别覆盖模型触发 `skill` 与显式 `/explore`）及 `test-fix`（显式 `/test-fix`），断言右栏与主流均出现 `system-skill` 运行卡且支持定向停止；对比“普通预备回合 → 执行期 → 下一普通回合”三阶段 `request/header.tools` schema，自动断言 `subagent` 仅在执行期出现并在结束后收回。
  5. **包 lane 正常（Clarify Phase-1 粒度）**：在隔离 profile 播种/启用既有智能体包 `@slug` 并发送深度 2 lane 派发 → 断言外层包运行卡与右栏聚合工具摘要存在、右栏无独立 lane 运行行，并经 `session.v4.jsonl.zstd` 会话头身份链（`parentSession`/`origin`/`delegationDepth === 2`）验证两层派发与非错误结果。
  6. **切换/断连/重连/历史归属与 Host 重启失效**：自动切换会话标签并切回、刷新重载历史（断言上一回合 todo 不冒充当前回合）、检验断连/重连横幅，并在活跃运行期间调用 `window.huaanworkAcceptance.restartHost()` 接力 `assertHostRestartEvidence`（`scripts/huaanwork-accept-host-restart.mjs`）断言 Host PID 改变、renderer 文档未替换、卡片呈现 `状态不可恢复 · Host 已重启，结果未确认`、终止禁用与耗时冻结（若某前置条件无法构造，必须按 fail-closed 记为 `BLOCKED` exit `3` 并注明原因，不得跳过）。
  7. **主流卡片无双重更新与单次取消隔离**：构造兄弟并发运行场景，CDP 点击右栏「终止 → 确认终止」两次确认按钮 → 断言主流 todo/工具/运行卡唯一不重复，且对照宿主/WS/RPC 日志断言单次确认只触发一条命中目标 `runId` 的 `subagent.cancel` 请求、兄弟运行持续完成不受影响。

运行判据单测、执行自动化真机走查并按仓库脱敏规范清理备份临时副本：

```bash
node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-progress-sidebar.mjs --out /tmp/progress-sidebar-accept
# 完成后将 /tmp/progress-sidebar-accept 中的 PNG 截图与 facts JSON 备份至 ~/huaanwork-progress-sidebar-accept-evidence-$(date +%F)（仓库外），清理含密钥临时 DSH_HOME/profile
```
Expected: 单测与走查脚本均 exit `0`（若环境缺少真实模型或条件无法构造，如实记录 exit `3` `BLOCKED` 与具体原因）；将脱敏后的命令、退出码、facts JSON 摘要、本地备份截图路径、`request/header.tools` diff 摘录、Host 重启校验结果、RPC 日志摘录及 `corepack yarn workspace @huaanwork/policy check` / `corepack yarn check` / `verify:host` 最终结果写入 `docs/evidence/2026-11-15-progress-sidebar-acceptance.md`（并保证最终代码改动后再重跑 `verify:host` 与 `corepack yarn check`）。

- [ ] **Step 8: 提交走查自动化测试与脱敏证据**

仅提交脚本、单测与文字证据文档（截图、`fixture` 及任何含密钥临时目录严禁 `git add`）：

```bash
git add dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs docs/evidence/2026-11-15-progress-sidebar-acceptance.md
git commit -m "test(progress): automate agent CDP walkthrough acceptance for sidebar"
```

## Completion Criteria

- 普通父会话和无人值守自动化不能自主调用 `subagent`；显式 `@`、包 lane 和有人值守系统技能双入口（模型 `skill` 工具受 `turnAnchors.current` 锚定守卫，显式 `/explore`、`/test-fix` 在 `followup` 前依次使旧 `pendingByAgent` 失效、注册 `turnAnchors` 并挂显式租约，且 `followup` 抛错时仅回滚本轮租约不误伤独立追踪的 `activeGoalSessions`、`goal/change('active')` 先于租约激活亦不丢失）均按矩阵工作；非白名单 `sendToAgent` 先校验 `isUnmanagedChildSession` 再 `turnAnchors.register`；`pendingSpawn` 兼容槽绑定 `agent` 与调用 token，经 `tools/result` 同步清零与租约释放 `onInvalidate` 兜底双向清理（覆盖 `allow` → `post-result`/`final-result`、连续多轮 `skill → ordinary → skill` 及并行 `runGroup` 抛错），不污染顺序 `@` 或误清并发在途槽；`acquireSystemSkillLease` 返回 `false` 时不写脏 `pendingByAgent`；多层 restrict 交集 fixture 下包儿童可见性有钉。
- 系统技能运行具有 `system-skill` runId、状态、快照和定向取消；取消经提前挂载 `attachCancel` / 晚到处理 + result 等待/处置/独立无中止信号观察窗 + `confirmCleanup` 仲裁：`dispose` 成功（`cleanupOk: true`）且执行终结收敛 `stopped`，`dispose` reject/超时（`ok: false`）保留 error 告警并如实保持 `stopping`（不伪装 `stopped` 或 `failed`）；goal 正常轮间保留租约、anchor 与 startedAt 不换 wall-clock，`agent/error`、中止/异常 `turn/end`、`goal/change` 非活跃/`clear` 与 `session/disposed`/`releaseSessionRuntime` 无条件释放租约（传 `{ clearGoal: true }`）并触发对应 `pendingByAgent` 失效清理。
- legacy 直接/间接派生均被拒绝（先拒后记且受 `acquireSystemSkillLease` 真值门控，不留脏 `pendingByAgent`；含共享包 `filterAgentAllow` 单测）；规格评审点名的包 C4/C5、`policy.cordis`、`agent-package-runtime` 回归钉保持绿。
- 回合锚点由 `turn-anchors.ts` 唯一提供：UUID/runId 锚定、`notePreStep` 只把 `source.kind === 'user'`/`''`（及 `goal` 续轮）视作回合边界，`subagent-settled` 与其他非人类/系统通知不换锚、保持 `turnFinal` 单调不重开已结案回合、未登记真实用户保留 `unknown` 降级、无锚 fail closed、LRU 256、`session/disposed` 与 `releaseSessionRuntime` 清理、监听 `return next()` 且次序无关；Artifact 计划可消费该模块；`session-view.spec.ts` 普通 `user` exact-match 断言与 `appWiring.spec.ts` 同步更新并保持绿。
- todo 实时/历史一致：`clientMessageId` 严格精确匹配（无数值 `String(id)` 兼容回退）+ `roundKey` 门槛 + `session.send` 在飞期（含 `waiting` 前已收到 `queue-start` 及 `goalIntermediate === true` 保留前端 `running === true` 期间的交错分支）早到 `todo_write` 缓冲置于 `running-turn` 守卫前按 `clientMessageId` 匹配保留并重放，同时守住 `appWiring.spec.ts:1646-1658`、`1710-1711` 源码正则钉；`session-view` 采人类 `source.kind` 白名单并先用 `parseToolArguments` 解码真实 JSON 字符串与对象原始 `data.arguments` 而非截断 args；坏条目 flatMap 丢弃、空数组合法；tool-result 不重复；`AGENTS.md` 活跃行已清理且 `docs/project-memory-archive.md` R-12 已闭环。
- 右栏按当前回合正确筛选 `activity` 并渲染 Task、`connection` 三态与受管运行（无锚运行仅活跃期显示、终态 fail-closed，不使用客户端 `sentAt` 冒充 Host 起点；包运行汇总粒度澄清为外层包儿童）；取消按钮复用同一二次确认；无虚构百分比、跨回合错挂、实时 last-user 回退或第二套 reducer。
- 宿主/护栏代码通过 `exactOptionalPropertyTypes: true` 类型检查（含 `ActivationRun` 与 `Pick<SubagentActivationHandle, 'dispose'>` 收窄）；`dsh-plugin-huaanwork` 构建（`tsdown` + Vite 客户端）、包级 `typecheck`、共享包 `@huaanwork/policy check` 与仓级 `corepack yarn check`（含新增 `verify:host` 走查判据单测）已实际执行并记录真实结果。
- 规格 §14.2 七项 agent 真机走查自动化测试脚本（`dsh-plugin-huaanwork/scripts/huaanwork-accept-progress-sidebar.mjs` 及 `scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs`，含 `request/header` 工具 schema 核验、双技能/双入口切换、不可逆 Host 重启失效接力与单次取消 RPC 隔离）已实际运行并通过（或按规则如实记录 `BLOCKED`），脱敏证据落盘 `docs/evidence/2026-11-15-progress-sidebar-acceptance.md`；单元测试与静态门禁不替代该真机走查自动化测试。
