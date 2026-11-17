# Managed Subagent Progress Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按选项 2 让普通父会话不能绕过 registry 自主派发子 agent，将 `explore/test-fix` 派生运行纳管，并在右侧“进度”同步展示 Task、工具活动和受管运行。

**Architecture:** 从全局 `ALLOWED_TOOLS` 默认移除 `subagent`，再通过包血缘附件和系统技能租约按会话开放；系统技能调用经 `tools/execute`（around-dispatch）ALS 与 `startActivation` 包装进入现有 run registry。右栏只投影既有 todo、工具看板和 run 状态，不建立第二套执行事实源。共享回合锚点由通用前置任务新建的 `huaanwork-host/turn-anchors.ts` 唯一提供。

**Tech Stack:** TypeScript、React、Vitest、Node AsyncLocalStorage、既有 DSH tools/restrict、既有 `subagent-runs` registry。

**Spec:** `docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`（§6 共享回合锚点契约是本文档 Task 1 的权威）

**Plan order:** 2/3。先完成 `2026-11-15-chat-created-skills.md`；本计划完成后再执行 Artifact 计划。Artifact 计划消费的“既有通用回合锚点”即本计划 Task 1 的 `turn-anchors.ts`（`ctx.huaanworkTurnAnchors`），不存在 phantom dependency。

## Global Constraints

- 基线为外层 `ff29debd37d72a92f10d446eafa07867d17befd8`，上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 只修改 `dsh-plugin-huaanwork/` 和必要的自有共享包 `packages/huaanwork-policy/`；不得修改 `deepseek-harness/`。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0` 与 Corepack Yarn `4.18.0`。
- 不得全局禁用 profile 的 `tool-subagent`，不得移除宿主 `ctx.subagents` 服务。
- 普通父会话、无人值守自动化和 legacy/system-skill 儿童不得获得模型面 `subagent`；显式 `@agent/@slug` 宿主派发不得回归。
- 包儿童只有在包 allow 与血缘均允许时才获得 `subagent`；C4/C5 与既有包运行取消契约不变。
- 包 lane 一期不独立建卡，只聚合到父包运行；不得宣称有独立 lane 取消。
- 系统技能租约不得因单次 idle 或 goal 续轮间 idle 提前解挂；使用 goal 相位与权威回合结束。
- `system-skill` 必须进入现有 registry；复用 generation、revision、快照、严格 stopped 和定向取消语义；停止预算同时覆盖 result 等待、dispose 与结算观察窗，不得永停 stopping。
- 共享回合锚点（规格 §6）：持久锚定一律用 `crypto.randomUUID()`/自动化 runId，禁止用客户端数值 id；goal 续轮保留原 anchor 与 startedAt；无锚 fail closed；store 内 pending/anchors 有界 LRU 256，禁止模块级全局单槽。
- 实时系统技能主流卡禁止 last-user 回退；snapshot 对账才允许 `allowSnapshotFallback`。
- 技能类型跨阶段载体只允许 `tools/execute`（around-dispatch）ALS（上游 pre-execute waterfall 的 `next()` 不包 `dispatchToolBody`，事实见 Task 2 Step 4）；既有 `pendingSpawn` 桥接不得删除。
- 子 agent 正文、reasoning 和完整工具输出不得进入父会话。
- todo 总进度只计算 `completed/total`；归属 = 当前回合 `user.clientMessageId` 精确匹配 + `roundKey` 必填且不小于当前快照 roundKey；不得伪造单步百分比或 Task↔工具/子 agent 关联。
- 历史坏 todo 参数只显示安全 note，不展开原始参数；结构化 todos 来自宿主 session-view 而非 200 字截断 args；实施后订正 AGENTS.md 的 R-12 行。
- 修改 `styles.css` 后运行 `corepack yarn workspace dsh-plugin-huaanwork gen:styles`。
- 所有命令在仓库根执行；全量 `check` 不得与其他含 `verify:aa` 的命令并发；`verify:aa` 并发竞争如实串行重跑并记录。
- 共享包 `@huaanwork/policy` 的包级 `corepack yarn workspace @huaanwork/policy check` 与根 `corepack yarn check` 都必须实际执行并记录真实结果（根 `check` 不含 policy 包 check，根 `test` 含 policy 测试）。
- 文件清单与 commit 只列实际修改/新增的文件；仅运行未修改的测试不得 `git add`。
- App.tsx 是技能计划（skillChangeSignal → SkillsView.refreshSignal）与本计划、Artifact 计划的共同修改面；合并时逐项核对信号接线互不覆盖。

---

### Task 1: 通用前置 — 共享回合锚点 store 与发送/宿主接线

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:296-330,713-727,859-883,890-1044`（含 `startQueuedItem` 重建发送参数）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts:10-20,38-46,101-123`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:395-420`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:2797-2820,3235,1742-1755`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`（新增 `buildSessionSendParams` 纯函数与历史 user 锚点）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts:296-313`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:199-220`（user `data.id` 透传）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:432-446`（历史 user `clientMessageId`）
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

实现要点：`anchors`/`pending` 为实例内 Map + 简单 LRU（get/set 时刷新次序，超 `limit`（默认 256）淘汰最久未用会话），**禁止模块级全局变量**；`register` 只写 `pending` 并返回精确回滚闭包（仅当 pending 仍等于本次 messageId 时移除，不清旧 anchor）；`notePreStep` 从 `messages` 末尾找最近一条 `role === 'user'` 且带字符串 `id` 的消息——`source.kind === 'goal'` 时不动 anchor（无原 anchor 则返回 `undefined`，fail closed），普通消息时：从 pending 取已登记 origin（未登记为 `unknown`），与现有 `clientMessageId` 相同则保持 startedAt 不变，不同则写入一次新 anchor；`pending` 记录 `{ messageId, startedAt }` 供幂等判断；无用户消息直接返回当前值。`notePreStep` 返回处理后的当前 anchor，供其他 listener 使用。`installTurnAnchorHooks` 注册 `agent/pre-step`（载荷 `{ agent, messages, turn, signal }`，取 `sessionIdOfAgentRef(agent)`，调用 `notePreStep(sessionId, messages, new Date().toISOString())`，监听器**显式 `return next()`**）与 `session/disposed`（`clearSession` 同时清 pending/anchors）。

`holders.ts`：`declare module` 增加 `huaanworkTurnAnchors: TurnAnchorStore` 并加入 `HUAANWORK_CONTEXT_PROPS`；`installHuaanworkHolders` 内 `ctx.huaanworkTurnAnchors = createTurnAnchorStore()`。`index.ts` 在 holders 安装后调用 `installTurnAnchorHooks(ctx)`。

- [ ] **Step 4: 写宿主接线失败测试并确认失败**

`tests/huaanwork-host/turn-scheduler.spec.ts` 增补：入队项携带顶层 `clientMessageId`，`drainQueue()` 返回项保留该字段。`tests/huaanwork-host/turn-anchors.spec.ts` 增补：`resolveFollowupClientMessageId` 顶层优先、缺顶层生成 UUID、**不读 at.clientMessageId**；`turnOriginForSession('huaanwork-auto-x-y') === 'automation'`、普通会话 `'advanced'`；followup 抛错调用 register 回滚后，本次 pending 被移除且上一回合 anchor 保持不变。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-anchors.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts
```
Expected: FAIL（helper 不存在 / 字段未透传）。

- [ ] **Step 5: 实现宿主接线**

- `sessions.ts`：新增 `objectTopLevelClientMessageId(params)`（与 `objectAtClientMessageId` 同形，读 `params.clientMessageId`）。**两个解析分开**：followup 消息 id 一律 `resolveFollowupClientMessageId(params)`（顶层 ?? `randomUUID()`，不读 at）；legacy/包运行卡的 `dispatchAt` 透传值用 `objectTopLevelClientMessageId(params) ?? objectAtClientMessageId(params)`（at 值仅为无顶层的旧客户端保留）。`sessionSend` 把两个值分别传入 `admitUserTurn`（顶层 `clientMessageId` 随排队项透传；at 结构维持现状）；`sendToAgent` 在 `agent.followup(...)` 之前：`const followupId = resolveFollowupClientMessageId(params)`，`const rollback = ctx.huaanworkTurnAnchors?.register({ sessionId, clientMessageId: followupId, origin: turnOriginForSession(sessionId) })`，随后用 `try { agent.followup({ id: followupId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }) } catch (error) { rollback?.(); throw error }` 受理；回滚只清本次 pending，不清上一回合 anchor。
- `turn-scheduler.ts`：`QueueItem` 与 `admitUserTurn` 输入增可选 `clientMessageId`，入队项保存；`startQueuedItem` 重建参数时带 `...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId })`。
- `automations-host.ts`：`runAgentTurn` 调 `sendToAgent` 的参数增 `clientMessageId: runId`（origin 由前缀判定为 `'automation'`，`UserMessage.id = runId`，历史 session-view 透传同一 id）。
- `session-view.ts`：user/message 记录增 `...(typeof data.id === 'string' && data.id.length > 0 ? { clientMessageId: data.id } : {})`；`rpc-types.ts` 的历史 user record 增同名可选字段。此处只处理通用用户锚点，todo 的 ordinary-user 顺序跟踪与结构化 todos 留在 Task 4。

- [ ] **Step 6: 写客户端接线失败测试**

`tests/client-huaanwork/appWiring.spec.ts` 增补（对导出纯函数断言，不整挂载 App）：
- `buildSessionSendParams`：顶层 `clientMessageId` 恒等于传入的 UUID；`@` 发送仍带 `at.clientMessageId = String(userItemId)`；skill/普通发送不带 at；
- `automationRunUserItem(event.runId, task.name, items)`：无该 clientMessageId 时返回 user 条目（文案含任务名、clientMessageId 等于 runId）；已存在时返回 `undefined`（不重复追加）。

`tests/client-huaanwork/subagentRuns.spec.ts` 增补：`insertSubagentRunCard` 以 `user.clientMessageId` 精确命中；旧条目无 `clientMessageId` 时以 `String(item.id)` 兼容命中；实时（无 `allowSnapshotFallback`）且无精确锚点时**不插入**（钉死禁止 last-user 回退）。`tests/huaanwork-host/session-view.spec.ts` 增补 user/message `data.id` → `clientMessageId` 透传；`tests/client-huaanwork/sessionChannel.spec.ts` 与 `appWiring.spec.ts` 分别钉 HistoryChatItem/ChatItem user 保留该字段且渲染 `id` 仍重新分配。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/subagentRuns.spec.ts
```
Expected: FAIL。

- [ ] **Step 7: 实现客户端接线**

- `App.tsx`：`ChatItem` user 分支增可选 `clientMessageId?: string` 与 `sentAt?: number`（客户端时钟，选择器比较 run.startedAt 用）；发送路径 `const clientMessageId = crypto.randomUUID()`（先例 `Settings.tsx` 的 `crypto.randomUUID()`；**禁止** `String(userMsg.id)` 作持久锚——allocId 刷新后可重复），写入 `userMsg`，`session.send` 参数改由 `buildSessionSendParams` 构造（顶层携带 UUID）；`@` 的 `at.clientMessageId: String(userMsg.id)` 保留不动。`automation/run-task` 分支：调 `automationRunUserItem(event.runId, task.name, tab.items)`，返回非 `undefined` 时把该 user 条目（含 `sentAt: Date.now()`）追加到目标标签（既有“自动化运行中…”note 保留在其后）。
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
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:15-43`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-attachments.ts:11`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:149-205,207-259`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:199-251`
- Modify: `packages/huaanwork-policy/src/agent-catalog.ts:57-67`
- Modify: `packages/huaanwork-policy/src/agent-catalog.test.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts:113-122,1627-1631`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/system-skill-leases.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`

**Interfaces:**
- Produces: `SystemSkillKind = "explore" | "test-fix"`；`acquireSystemSkillLease(ctx, sessionId, kind)`、`releaseSystemSkillLease(ctx, sessionId)`、`noteSystemSkillGoalPhase(ctx, sessionId, phase)`、`releaseSystemSkillLeaseOnIdle(ctx, sessionId)`；`ctx.huaanworkSystemSkillLeases`。
- Produces: `spawnKind` ALS（`tools/execute` around-dispatch）；消费点统一 `spawnKind.getStore() ?? pendingSpawn`。
- Preserves: `attachAgentTools/detachAgentTools` 签名与幂等性；`pendingSpawn` 单槽桥接不删除。

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

实现（只此一种，不采用父会话 Map 备选）：

```ts
// skills.ts apply() 内
const spawnKind = new AsyncLocalStorage<SkillKind | undefined>()
ctx.on('tools/execute', ((execution: { name: string; agent?: object }, next: () => Promise<unknown>) => {
  if (execution.name !== 'subagent') return next()
  const kind = execution.agent === undefined ? undefined : pendingByAgent.get(execution.agent)
  return spawnKind.run(kind, () => next())
}) as never, true)
```

pre-execute 保留既有判定：`rememberSkill`（写 `pendingByAgent`）、`rememberSubagentSpawn`（**继续写模块内 `pendingSpawn` 单槽，桥接不得删除**）与 `huaanwork-${kind}` deny。消费点统一改为：

```ts
const consumePendingSpawn = (agent: Agent) => {
  const kind = spawnKind.getStore() ?? pendingSpawn
  if (!kind) return
  if (pendingByAgent.has(agent)) return
  applyKind(agent, kind)
  // ALS 命中时不得清除可能属于另一在途回落路径的模块单槽。
  if (spawnKind.getStore() === undefined) pendingSpawn = undefined
}
```

这样 `agent/created`（`:224-226`）、`subagent/start`（`:258`）、start 包装（`:373`）与 activation 包装（`:521`）四个消费点在 body 阶段由 ALS 覆盖，宿主 `@` start 包装等无 ALS 路径回落单槽。

**PC-1 防假绿钉**：`skills.ts` 导出只读测试钩 `currentDispatchSkillKind(): SkillKind | undefined`（即 `spawnKind.getStore()`）；`skills.spec.ts` 在 `dispatchTool` 的 terminal（body 阶段）内断言 explore 流程该值为 `'explore'`。把 ALS 错挂到 pre-execute 的实现此处必红（body 阶段已出栈读到 undefined，即便单槽兜底能让 restrict 通过，测试钩仍钉死挂点）。`Context.on` 联合类型增 `"tools/execute"`。

`skills.ts` 同步把 `startRun`/`subagent/start`/活动分流附近“模型自主嵌套不纳管”旧注释订正为：普通父会话模型面已不可达（R1）；系统技能派生走 `system-skill` 运行（Task 3）；包 lane 仍只受血缘收窄且一期不独立建卡（R5）。

- [ ] **Step 5: 实现租约获取、goal 相位与权威解挂**

`system-skill-leases.ts`（holders 注入 `ctx.huaanworkSystemSkillLeases`，实例内 Map，随宿主生命周期）：

```ts
type SystemSkillLease = { kind: SystemSkillKind; goalPhase?: GoalPhase }
acquire(ctx, sessionId, kind):
  if (ctx.huaanworkUnattended?.has(sessionId)) return false
  if (isUnmanagedChildSession(sessionId)) return false        // PM-5，见下
  if (ctx.huaanworkAttachments === undefined) return false
  const anchor = ctx.huaanworkTurnAnchors?.current(sessionId)
  if (anchor === undefined) return false
  leases.set(sessionId, { kind, goalPhase: lease?.goalPhase })  // 重复获取幂等，不覆盖进行中 goal 相位
  attachAgentTools(ctx.huaanworkAttachments, sessionId, ['subagent'])
  refreshAgentRestrict(ctx as never, sessionId)
  return true
release(ctx, sessionId): detachAgentTools(...,['subagent']) + 删租约 + refreshAgentRestrict（缺席即 no-op）
noteSystemSkillGoalPhase(ctx, sessionId, phase): phase === 'active' ? 记 goalPhase='active' : release(...)
releaseSystemSkillLeaseOnIdle(ctx, sessionId): leases.get(sessionId)?.goalPhase === 'active' ? 保留 : release(...)
```

**PM-5**：判别函数命名 `isUnmanagedChildSession`（不叫 isLegacyChild）：`parentSessionOf(sessionId) !== undefined && !ctx.huaanworkPackageChildAllow.has(sessionId)`——无包血缘条目的受管儿童（legacy 与 system-skill 派生儿童）一律不得获取租约。注释写明：acquire 内“无人值守 → 受管儿童 → 锚点/附件”的早退顺序是**正确守卫**，受管儿童命中第二跳是有意覆盖，不是顺序缺陷，禁止改成排除 system-skill 儿童。

`skills.ts` pre-execute 在 `rememberSkill(execution)` 后接线（仅 `execution.name === 'skill'` 且名为 explore/test-fix 且能解析 sessionId 时）`acquireSystemSkillLease(ctx, sessionId, skillName)`；acquire 返回 false 时技能仍可按现有规则执行，但模型看不到 `subagent`。legacy 儿童间接路径拒绝（`rememberSkill` 后、`next()` 前）：`execution.name === 'skill' && isUnmanagedChildSession(sessionId) && ['explore','test-fix'].includes(name)` → `{ kind: 'deny', reason: 'unmanaged-child-system-skill' }`。

`bridge.ts`：`goal/change` 分支在现有 emit 前调 `noteSystemSkillGoalPhase`（`clear`/非 active 相位释放，active 记录）；`agent/status idle` 与 `agent/error` 父会话分支在 `session/end` 前调 `releaseSystemSkillLeaseOnIdle`。goal active 轮间 idle 保留租约；complete/paused/blocked/round-limit 立即释放；运行中的子 agent 不因此自动取消。技能未实际派生时回合结束同样清理附件。

- [ ] **Step 6: 封闭 legacy 直接路径（共享包）**

`packages/huaanwork-policy/src/agent-catalog.ts` 的 `filterAgentAllow` 过滤集合增加 `'subagent'`（与 `run_code`/`call_host_tool`/`mcp__*` 同列）；`agent-catalog.test.ts` 增补：显式 allow 含 `subagent` 的条目被过滤、默认 allow 不含、既有过滤项不回归。显式 legacy 父运行不经此儿童 allow 计算，不受影响。

- [ ] **Step 7: 运行矩阵、goal、包/legacy 回归与共享包门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/system-skill-leases.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts
corepack yarn workspace @huaanwork/policy check
```
Expected: PASS。`agent-package-runtime.spec.ts`、`policy.cordis.spec.ts` 为规格评审点名回归（`:297,317,321,1009`、`:938-939`），只运行未修改则不进 commit；包级 check 结果如实记录。

- [ ] **Step 8: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/system-skill-leases.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-attachments.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts packages/huaanwork-policy/src/agent-catalog.ts packages/huaanwork-policy/src/agent-catalog.test.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/huaanwork-host/system-skill-leases.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts
git commit -m "feat(subagents): gate model spawning behind managed leases"
```

---

### Task 3: `system-skill` 运行进入 registry 并支持定向取消

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-cleanup.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts:66-72`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts`（改接抽取的 helper，行为不变）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:62-108,396-539`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:486-518`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `ctx.huaanworkTurnAnchors`；Task 2 的 `spawnKind` ALS 与租约。
- Produces: `SubagentRunKind = "legacy" | "package" | "system-skill"`；每次系统技能派生的 Host `runId`。
- Produces: `disposeActivationWithTimeout(handle, timeoutMs)`、`waitResultWithBudget(observed, signal, timeoutMs)`（自 `agent-invoke.ts` 原样抽取到 `subagent-cleanup.ts`，两处共用）。
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

测试：调用系统技能派生后、**释放 activation 之前**断言 `runs.snapshot(parentSessionId).runs[0]` 为 `{ kind: 'system-skill', phase: 'starting', label: 'explore', parentSessionId, clientMessageId: <Task 1 注册的 UUID 锚> }` 且 runId 非空；随后释放 activation、绑定 child/upstream，`subagent.cancel` 只 dispose 该 run，兄弟 run 与另一父会话不变；activation 抛错 → `failed`；**自动化会话**用 runId 锚（`origin: 'automation'`）同一断言。registry 缺失（ctx 无 `huaanworkSubagentRuns`）→ startActivation 包装抛 `subagent run registry is not initialized`；childId 不可解析 → dispose + `failRun` + 抛错；activation 返回 childId 与非空 `specChildId` 不一致 → 同样 dispose + `failRun` + 抛错，且不得调用 `bindActivation`。

另补 **activation pending 启动期取消**钉：保持 `startActivation` gate 未释放，先 `requestCancel` 并断言受理；随后释放 activation，包装通过 registry `attachCancel` 的晚绑定立即执行清理，在结果已结算且清理成功的受控夹具下最终收敛 `stopped`，不得因 cancel 闭包尚未注册而永久停留 `starting/stopping`。断言兄弟 run 与另一父会话仍不受影响。

- [ ] **Step 2: 确认系统技能当前不产生 Host run**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/subagent-runs.spec.ts
```
Expected: FAIL，模型自主分支当前没有 Host runId。

- [ ] **Step 3: 抽取共享清理 helper**

`subagent-cleanup.ts`：自 `agent-invoke.ts` 原样搬出 `disposeLegacyActivation`（改名 `disposeActivationWithTimeout`）与 `waitForLegacyResult`（改名 `waitResultWithBudget`），保留验收注入缝；`agent-invoke.ts` 改 import，行为零变化（既有 legacy 测试保持绿）。

- [ ] **Step 4: 在 `startActivation` 第一个 await 前建立 run 并接线生命周期**

`skills.ts`：

```ts
// ActivationRun 扩展（PM-3①）：增加 result?: Promise<unknown>（上游 handle 恒有）。
// Context.huaanworkSubagentRuns 的 Pick 扩展为实际调用全集（PM-3②，保留 settleUpstreamEnd——
// subagent/end 监听 :267 消费它，按字面替换会丢）：
// begin/reserveChild/bindActivation/attachCancel/failRun/settleResult/rejectResult/confirmCleanup/noteCleanupBudget
// + 既有 bindUpstreamStart/settleUpstreamEnd/parentSessionIdOf。

const skillKind = spawnKind.getStore()
const registry = ctx.huaanworkSubagentRuns
let systemRunId: string | undefined
if (hostRunId === undefined && parentFromCall !== undefined && skillKind !== undefined) {
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
if (systemRunId !== undefined) {
  const activeRegistry = registry
  if (activeRegistry === undefined) throw new Error('subagent run registry is not initialized')
  if (typeof specChildId === 'string' && specChildId.length > 0) {
    activeRegistry.reserveChild(systemRunId, specChildId) // 必须在 startRun.run 与第一个启动 await 之前
  }
}
// effectiveRunId 进入现有 startRun.run(...)，subagent/start 据此绑定 upstreamRunId。
```

activation 返回后：`systemRunId !== undefined` 时解析 `childSessionId`，不可解析 → `try { await run?.dispose?.() } catch {}` + `failRun(systemRunId, 'subagent lineage child id missing')` + `throw`（与 C4 分支同形）；可解析 → `bindActivation(systemRunId, { childId: childSessionId })` 并挂接生命周期。进入生命周期块前沿用上述失败分支显式排除 `run === undefined` 并完成 TypeScript 窄化，不使用 `run!`。**预留 ID 的绑定顺序**：上文已在 `startRun.run` 前对非空 `specChildId` 调用 `reserveChild`；activation 实际返回其他 childId 时同样 dispose + failRun + throw，不得把预留身份换成别的会话。收到 `subagent/start` 后沿用现有 `bindUpstreamStart`。`catch` 中 `systemRunId !== undefined` → `failRun(systemRunId, error)`。

生命周期（PI-2，与 legacy `cleanupLegacyRun` 同形、三段预算）。上游工具先自建 spec 再进入本包装，本层不能向该 spec 补注入 signal；启动期取消必须依赖 registry 的 cancel latch 与 `attachCancel` 晚绑定（Step 1 已补钉），`controller.abort()` 只控制包装自建控制器，不得被当作上游 spec 信号的替代：

```ts
if (systemRunId !== undefined) {
  const activeRegistry = registry
  if (activeRegistry === undefined) throw new Error('subagent run registry is not initialized')
  const observeResult = () => (resultObserved ??= (run.result ?? Promise.resolve()).then(
    (value) => activeRegistry.settleResult(systemRunId, { stopReason: stopReasonOf(value) }), // executionEnded 唯一来源
    (error) => activeRegistry.rejectResult(systemRunId, errorText(error)),
  ))
  observeResult() // 立即观察，正常终态不等取消
  activeRegistry.attachCancel(systemRunId, async () => {
    cancelRequested = true
    controller.abort()
    await cleanup('cancel')   // 不等 graceful result，直接 dispose
  })
  // cleanup('idle' | 'cancel')：
  //  1) 仅 mode === 'idle' && !cancelRequested 时做 graceful result 等待：
  //     waitResultWithBudget(..., cleanupTimeoutMs=ACTIVATION_CLEANUP_TIMEOUT_MS=600_000)；
  //     超时 → noteCleanupBudget + 日志，转 dispose。cancel 跳过本步，不得先等满 10 分钟；
  //  2) disposeActivationWithTimeout：fulfilled → ok=true；rejected/timeout → 对应 cleanup 告警 + ok=false；
  //  3) dispose 后结算观察窗：resultObserved 仍未结算时再等一个预算窗，超窗 → rejectResult(systemRunId,
  //     'execution result missing after dispose') 补 executionEnded——只用于解锁终态仲裁，
  //     已结算 result 先到先得不受影响，绝不永停 stopping；启动后路径绝不走 failRun；
  //  finally → confirmCleanup(systemRunId, { ok, warnings })（复用既有幂等，成功可先存）。
  // 正常完成（observeResult 已结算且未取消）→ 触发 cleanup('idle') 释放 activation 资源；
  // cleanupPromise ??= 去重，cancel 与正常收尾不会双跑。
}
```

cancel 后终态仲裁完全交给 registry 既有规则：`stopped` 需 stopping + executionEnded + cleanupOk；stopReason 为 error/aborted 或清理失败按既有仲裁归 `failed`；包装层不得手动置终态、不得把受理取消当已停止。同批把 `stopReasonOf`/`errorText` 自 `agent-invoke.ts` 导出复用。

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
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:199-255`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:432-446,524-536`（历史 `SessionDetailRecord` 与实时 `tool/start` 变体同批扩字段）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:91-202`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:294,4359-4363,4586-4593,3211-3242`
- Modify: `AGENTS.md:90`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/todoProjection.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Produces: `normalizeTodoEntries(value: unknown): TodoEntry[] | undefined`（**`@huaanwork/policy/todo` 中唯一实现，bridge 与 session-view 共用**；非数组 → undefined；数组 → flatMap 丢坏条目，空数组合法）。
- Produces: `shouldApplyTodoEvent(items, currentTurnStart, event, snapshotRoundKey): boolean`（当前回合 `user.clientMessageId` 精确匹配 + roundKey 必填且不小于当前快照 roundKey；旧条目以 `String(id)` 兼容）。
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
})
```

goal 续轮：当前回合 user 条目仍为原 anchor id 时事件携带同一 id → 通过（不另设 user 条目）。

- [ ] **Step 2: 确认测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/todoProjection.spec.ts
```
Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现共享解析、bridge 归属字段与实时守卫**

`packages/huaanwork-policy/src/todo.ts` 实现 `normalizeTodoEntries` 并导出结构化 `TodoEntry` 类型，`src/todo.test.ts` 覆盖 Step 1 的解析矩阵；`package.json.exports` 增加 `"./todo": "./src/todo.ts"`。`todoProjection.ts` 从 `@huaanwork/policy/todo` 导入并再导出该解析函数供 bridge 使用，自身只实现 `shouldApplyTodoEvent` 与 `currentSnapshotRoundKey`（`TodoEntry` 与 `logic/outcomeCheck.ts` 的现有结构保持兼容）。`shouldApplyTodoEvent` 不再扫描 `previousMaximum`：取 `items[currentTurnStart - 1]`（当前回合开启者），`kind === 'user'` 且 `(clientMessageId ?? String(id)) === event.clientMessageId` 才算命中；goal 续轮不插 user 条目，自然落在同一开启者上。

`bridge.ts`：`Context` 增 `huaanworkTurnAnchors?: { current(sessionId: string): { clientMessageId: string } | undefined }`；`tool/start` emit 增 `...(anchor?.clientMessageId === undefined ? {} : { clientMessageId: anchor.clientMessageId })`（`const anchor = sessionId === undefined ? undefined : ctx.huaanworkTurnAnchors?.current(sessionId)`，保留 roundKey）；`startDetail` 的 todo 分支改调 `normalizeTodoEntries(objectArgs.todos)`（语义与现状一致，bridge.spec.ts:534-560 不改也绿）。

`App.tsx`：`ChatItem` todo 分支增 `roundKey?: number; clientMessageId?: string`；`tool/start` todo 分支改为：先 `currentTurnStart(prev)` 与 `currentSnapshotRoundKey(prev, turnStart)`，未过 `shouldApplyTodoEvent` 直接返回 `prev`（面板与主流都不更新），通过则 `upsertTodoItem(prev, todos, allocId, event.roundKey)`（`upsertTodoItem` 增 roundKey 形参并写入 todo 条目）。

- [ ] **Step 4: 实现宿主历史结构化字段（PC-2）**

`session-view.ts`：
- 沿用 Task 1 已完成的 user/message `data.id` 透传，不重复实现；
- 顺序扫描维护 `currentOrdinaryUserClientId`：推入无 `goalRound` 的 user 记录时用其 `clientMessageId` 更新；goal 续轮记录（带 `goalRound`）**不清空**它；
- `tool/call` 的 `todo_write` 分支：从 `@huaanwork/policy/todo` 导入 `normalizeTodoEntries`，执行 `const todos = normalizeTodoEntries(asObject(data.arguments).todos)`，记录携带 `...(todos !== undefined ? { todos } : {})`、`...(currentOrdinaryUserClientId !== undefined ? { clientMessageId: currentOrdinaryUserClientId } : {})` 与既有 roundKey；其余 tool-call 不动。**不从 `formatToolArguments`（200 字截断）恢复 todos，也不从客户端 UI 模块反向导入。**

`rpc-types.ts`：`tool/start` 事件变体增 `clientMessageId?: string`，与 bridge 新增字段同批落地；历史 tool-call 增 `todos?: { content: string; status: "pending" | "in_progress" | "completed" }[]` 与 `clientMessageId?: string`；user 的同名可选字段由 Task 1 提供，本任务只消费。

- [ ] **Step 5: 实现历史映射、tool-result 去重与 R-12 关闭**

`sessionChannel.ts`：沿用 Task 1 的 user `clientMessageId` 透传，新增 todo 联合分支 `{ kind: "todo"; todos: TodoEntry[]; roundKey?: number; clientMessageId?: string }`。`historyItemsFromRecords`：
- tool-call 的 `todo_write`：非数组 `record.todos` → `{ kind: "note", text: "历史待办无法解析" }`；数组 → `{ kind: "todo", todos: record.todos, ...(roundKey), ...(clientMessageId) }`（坏条目已由 session-view 逐条过滤；空数组是合法空快照）；同时把 callId 记入 `todoCallIds`；
- tool-result 分支开头：`record.callId !== undefined && todoCallIds.has(record.callId)` 时 `continue`（不生成第二次 todo、不生成孤儿工具失败 note）。

`App.tsx` `historyToChatItems`：user 分支沿用 Task 1 的 `clientMessageId` 透传；新增显式 todo 分支 `{ id: allocId(), kind: "todo", todos: item.todos, ...(roundKey), ...(clientMessageId) }`，不落入 note 兜底。

`AGENTS.md:90` 的 R-12 行改为已关闭：指向本计划 Task 4 与上述测试，说明实时/历史均投影待办卡；不得删除历史记录。

- [ ] **Step 6: 运行历史/实时回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/todoProjection.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-host/session-view.spec.ts
corepack yarn workspace @huaanwork/policy check
```
Expected: PASS；新回合未收到 todo 时没有旧快照冒充当前任务；`toolPanel.spec.ts`、`outcomeCheck.spec.ts` 只运行未修改则不进 commit。

- [ ] **Step 7: Commit**

```bash
git add packages/huaanwork-policy/package.json packages/huaanwork-policy/src/todo.ts packages/huaanwork-policy/src/todo.test.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/todoProjection.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx AGENTS.md dsh-plugin-huaanwork/tests/client-huaanwork/todoProjection.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "fix(progress): align live and historical todo projection"
```

---

### Task 5: 右侧 ProgressPanel 聚合投影、全量门禁与人类验收

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:3970-4035`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`（由 gen:styles 重新生成）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/progressPanel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/ProgressPanel.spec.ts`
- Create: `docs/evidence/2026-11-15-progress-sidebar-acceptance.md`（Step 7 真人验收后生成）

**Interfaces:**
- Consumes: `TodoEntry`、`ToolPanelView`、`SubagentRunView`、Task 4 的 todo roundKey/clientMessageId、Task 1 的锚点、Task 3 的 run kind。
- Produces: `selectProgressPanelModel(input): ProgressPanelModel`、默认导出 `ProgressPanel`、`SubagentRunSummary`。
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
  currentTurnAnchor: { clientMessageId: 'message-1', startedAt: Date.parse('2026-11-15T10:00:00.000Z') },
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

另测：空任务不显示百分比；新回合 waiting；多个 in_progress 全保留；活跃 run 全进、clientMessageId 等于锚点的终态 run 进、其他回合终态不进；无锚 system-skill 终态 run 用 `run.startedAt >= anchor.startedAt` 归属（不按名称）；包 lane 无独立行。

- [ ] **Step 2: 确认选择器与组件测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/ProgressPanel.spec.ts
```
Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现纯选择器**

类型与规格 §9 一致（`taskPhase: 'ready' | 'waiting' | 'empty'`）。只读当前回合最后一个 todo 快照（`currentTurnStart` 之后最后一条 todo 条目，clientMessageId 已在 Task 4 守卫），计算 `completed/total`；`turnFinal` 只给原始 in_progress 叠加 interrupted。子 agent 列表包含全部活跃 run 与锚点相等的终态 run；无锚终态 run 按 `run.startedAt` 与 `currentTurnAnchor.startedAt` 比较（goal 续轮 run 的 startedAt 是本轮 wall-clock，原 anchor 的 startedAt 不被 store 刷新，比较成立）。连接三态由现有 ready/sidecarDead/reducer connection 合成。App 从当前回合 user 条目构造锚点输入 `{ clientMessageId?: string; startedAt?: number }`（`startedAt` 取 `userItem.sentAt`，与 registry `run.startedAt` 统一为 **epoch-ms 数值**，fixture 与实现不得混用 ISO 字符串）：`clientMessageId` 缺失时终态 run 不进列表（只留活跃项）；`clientMessageId` 命中但 `startedAt` 缺失（历史恢复的标签）时按精确 id 归组、跳过 startedAt 比较。

- [ ] **Step 4: 实现窄栏组件并替换占位**

组件分三区（结构同原设计）：分步任务（waiting/empty/计数/列表）、当前执行活动（复用 `ToolPanel` 的 `panel/onToggle`）、子 agent（从 `SubagentRunCard` 抽取 `SubagentRunSummary`，props `{ run: SubagentRunView; onCancel: () => void }`，复用现有相位/工具摘要/耗时/告警纯函数）。`onCancelSubagent` 调 `confirmCancelSubagent(run.runId)`。将 `App.tsx` 的“任务进度将显示在这里”占位替换为当前会话 `ProgressPanel`；保留主流卡片与现有 reducer。合并技能计划时注意 `skillChangeSignal` 接线不冲突（见 Global Constraints）。

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

- [ ] **Step 7: 规格 §14.2 七项人类验收（可执行步骤 + 证据要求；本计划不声称已执行）**

在 `docs/evidence/2026-11-15-progress-sidebar-acceptance.md` 落盘验收记录（含日期与构建/commit 标识），逐项执行并附证据：

1. **复杂任务进度**：发起含 3 个以上 Task 的复杂请求。证据：右栏“进度”截图（列表 + 当前项高亮 + 已完成 X/Y），同一会话主流待办卡截图；会话日志 JSONL 中 todo_write 记录摘录。
2. **活动无虚构百分比**：执行期间观察工具活动区。证据：截图中单步无百分比、顶部计数为 X/Y；宿主 tool/start 事件摘录（含 clientMessageId/roundKey）。
3. **普通父会话不可自主派发**：普通会话直接询问模型其可用工具（不让其调用）。证据：模型回答/工具调用记录中无 subagent；显式 @agent 宿主派发成功截图（运行卡出现且可定向停止）。
4. **explore/test-fix 纳管**：运行 explore 技能使其派生子 agent。证据：右栏与主流运行卡截图（system-skill 标签）、定向停止成功截图、回合结束后再次询问模型可用工具（无 subagent）的截图或日志。
5. **包 lane 正常**：对已有智能体包发起深度 2 lane 派发。证据：父包运行卡聚合工具摘要更新截图；右栏无独立 lane 行；既有 C4/C5 自动化测试运行记录。
6. **切换/断连/重连/历史归属**：切换会话、断开 sidecar 后恢复、刷新历史重开旧会话。证据：各阶段右栏截图；上一回合 todo 不冒充当前回合的截图；不可恢复运行显示“记录不可用/已失效”的截图（如可构造）。
7. **主流卡片无双重更新**：验收 1–4 过程中观察主流。证据：主流 todo/工具/运行卡各只有一份、右栏操作不重复写状态的截图；WS 事件序列摘录（同一 todo 快照不重复推送）。

每项记录：执行人/日期/环境、操作步骤、预期、实际、证据链接；任一项失败先回修再复验，不得改验收标准。

- [ ] **Step 8: 提交真实验收证据**

```bash
git add docs/evidence/2026-11-15-progress-sidebar-acceptance.md
git commit -m "docs(progress): record sidebar human acceptance"
```

## Completion Criteria

- 普通父会话和无人值守自动化不能自主调用 `subagent`；显式 @、包 lane 和有人值守系统技能路径均按矩阵工作；多层 restrict 交集 fixture 下包儿童可见性有钉。
- 系统技能运行具有 `system-skill` runId、状态、快照和定向取消；取消经 result 等待/处置/结算观察窗收敛终态，不永停 stopping；goal 续轮不提前解挂，anchor 与 startedAt 不换 wall-clock。
- legacy 直接/间接派生均被拒绝（含共享包 `filterAgentAllow` 单测）；规格评审点名的包 C4/C5、`policy.cordis` 回归钉保持绿。
- 回合锚点由 `turn-anchors.ts` 唯一提供：UUID/runId 锚定、goal 续轮保留原 anchor、无锚 fail closed、LRU 256、监听 return next() 且次序无关；Artifact 计划可消费该模块。
- todo 实时/历史一致：clientMessageId 精确匹配 + roundKey 门槛；结构化 todos 来自 session-view 而非截断 args；坏条目 flatMap 丢弃、空数组合法；tool-result 不重复；AGENTS.md R-12 已订正。
- 右栏正确显示 Task、工具活动和受管运行，无虚构百分比、跨回合错挂、实时 last-user 回退或第二套 reducer。
- 包级 `typecheck`、共享包 `@huaanwork/policy check` 与仓级 `corepack yarn check` 已实际执行并记录真实结果。
- 规格 §14.2 七项人类验收已真人执行，证据落盘 `docs/evidence/2026-11-15-progress-sidebar-acceptance.md`；自动化门禁不替代人类验收。
