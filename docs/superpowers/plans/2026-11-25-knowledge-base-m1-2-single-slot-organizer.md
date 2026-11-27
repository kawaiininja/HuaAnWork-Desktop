# Knowledge Base M1-2: Single-Slot Organizer Agent, Dual-Layer Tool Allowlist & Preemptive Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M1-1 底座上交付每库单槽整理 Agent（`huaanwork-kb-org-<kbId>`）：6 点可见性隔离、`sandbox-cwd` / `writable-root` fail-closed 钉死 `wiki/`、新增 `ctx.huaanworkSessionToolAllow` 双层白名单并修复 `present-as.ts:156` 空交集 fail-open、3 个整理工具与受控墓碑删除、`TurnScheduler` `kb-organize` 抢占式调度及严格失败计次退避。

**Architecture:** 每库固定复用单一槽位 `huaanwork-kb-org-<kbId>`，避免每批新 ID 撑爆上游 `session_projcache`（删库不触碰上游私有缓存，零修改 `deepseek-harness/`）。整理会话在 `agents.create` 前写入 `huaanworkSessionRoots`（指向 `wiki/`）、`huaanworkSessionToolAllow`（6 个 fs 工具不含 `str_replace_editor` + 3 个 `kb_org_*`）与 `huaanworkSessionModels`（每批快照 `settings.active_model_id` 并判空 `model`），不登记 `huaanworkUnattended`。全局并发名额抢占与单库 `inFlightOrganizeByKb` 槽位生命周期锁显式解耦。

**Tech Stack:** TypeScript、Cordis、Vitest、`@huaanwork/policy`（纯逻辑零三方依赖）、DeepSeek Harness `agents.create({ setup })` / `systemPrompt.context({ interpolate: false })`。

**Spec:** [`docs/superpowers/specs/2026-11-24-knowledge-base-design.md`](../specs/2026-11-24-knowledge-base-design.md)（v2.5 §4、§5.3、§8、§11.1）
**Prerequisite:** M1-1（[`2026-11-25-knowledge-base-m1-1-registry-indexing.md`](./2026-11-25-knowledge-base-m1-1-registry-indexing.md)）已完成并通过 `corepack yarn check`。

---

## Global Constraints

- 全部改动收敛在 `dsh-plugin-huaanwork/` 与 `packages/huaanwork-policy/`；`packages/huaanwork-policy/` 保持纯逻辑、零三方依赖；严禁修改 `deepseek-harness/`。
- 所有新增 `ctx.huaanwork*` holder 必须登记在 `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts` 的 `HUAANWORK_CONTEXT_PROPS` 中，并在全部共享护栏里做可选链缺省降级。
- 整理工具与 organizer 只能经同一个 `KnowledgeHost` 使用 M1-1 的私有 `KnowledgeStorageClient`；禁止在 `org-tools.ts` / `organizer.ts` 另建 StorageClient 或第二个 Storage Worker。
- 整理白名单为 `['read', 'read_file', 'glob', 'grep', 'write', 'edit', 'kb_org_get_delta', 'kb_org_read_doc', 'kb_org_mark_organized']`，**严禁包含 `str_replace_editor`**；整理槽**绝不登记 `ctx.huaanworkUnattended`**。
- 整理会话对 `wiki/` 外路径（含 OS 平台临时目录）与符号链接写入一律拒绝；宿主墓碑删除只删表里登记过的 `wiki/docs/<docId>.md`，绝不按模型参数删任意专题路径。
- 本计划完成后独立通过 `corepack yarn check`（勿与其他含 `verify:aa` 命令并发），且仍保持 `ROUTE_TABLE` 长度为 92（路由在 M1-3 注册）。

---

## Delivery Order

1. 整理槽前缀、6 点可见性隔离与 `sandbox-cwd` / `writable-root` fail-closed 写边界。
2. `ctx.huaanworkSessionToolAllow` 双层白名单、`present-as.ts` 空交集修复、整理临时目录拒写与 3 个 `kb_org_*` 策略/模型注册。
3. 三个整理宿主工具（`kb_org_get_delta`、`kb_org_read_doc`、`kb_org_mark_organized`）与受控墓碑删除。
4. `TurnScheduler` `kb-organize` 抢占式调度、`soleCapWriterSessionId` 排除与后置唤醒顺序。
5. 单库单槽整理执行器（模型快照预检、`inFlightOrganizeByKb`、看门狗休眠豁免、失败计次退避与 `dispose` 日志清理）。
6. Host 接线、抢占与单槽复用集成回归测试及 M1-2 门禁。

## 2026-11-26 评审校准落点

同轮应补按这个顺序写入正文：I-1 触发缝（Task 6）、I-2 对话流隔离（Task 1）、I-3 `knowledgeHost` 桥接（Task 3/6）、I-4 可写根登记（Task 1）、I-5 `cancelForKb` 适配（Task 5/6）、I-6 结束后唤醒排队用户（Task 5）、I-7 看门狗（Task 5；事件与相位已按 D2 写入）、I-8 纯墓碑清行（Task 3）、I-9 悬空符号链接（Task 2）、I-10 全库 50 MiB（Task 3）、I-11 模型注册名（Task 2）。

不阻断项同轮收进正文：N-3 的 persistence 早退顺序升到 Task 1 的缺根检查之前；N-1/N-2/N-4/N-5 改正文件名、签名和提示词；N-6/N-8 收紧 Task 6 的退场与无头桩；N-7 标明真机项不在本计划；N-9 在 Task 4 写明接受抢占后的同根窗口。

## 2026-11-26 §8 复审修订落点

- R2-1：Task 5 用真实 `AgentHandle.agent.followup()` + `whenIdle()` 驱动并等待整理回合，Task 6 的无头桩从 followup 内执行脚本，杜绝“只 create 不运行”。
- R2-2：Task 3 扩展同一 `KnowledgeHost` 的整理存储与不可变批次接口，Task 5 扩展 SyncEngine/Host 相位接口；Task 1/6 使用同步注册 id provider。全程复用同一个 StorageClient。
- R2-3：Task 1 新增 `organizer-activity.ts`，bridge 在 UI 早退前发活动心跳；Task 5 注册/注销看门狗 touch。
- R2-4：Task 6 在对账统一回调之外，补 create、重绑与 rebuild 提交后的排期；rebuild 必须在维护门闩释放后触发，Wiki reset pending 不触发。
- R2-5：Task 3 以 `open/get/closeOrganizeBatch` 冻结并结算唯一批次；Task 5 预检只 peek，准入后重新 open，Agent 工具与失败计次共享 open 快照；纯墓碑零进展按 §9 裁定做进程内 1/5/3 退避。
- R2-N1：Task 4 把 `sessionSend` 实际返回分支列入 Files，`drainUserQueue` 返回本轮全部出队 id，并钉死出队项只由 `startQueuedItem` 启动。

## 2026-11-26 §10 聚焦复审修订落点

- R3-1：Task 4 的出队应答固定为 `waiting:false + started:false + queueItemId`；`App.tsx` 按 queueItemId 登记 owner 与重放 queue-start/queue-fail，queue-start 是唯一客户端回合初始化点。覆盖 start/fail 各自早于/晚于应答的四条时序。
- R3-2：Task 5 新增 `KnowledgeHost.assertOrganizeAllowed`，`triggerManual` 在 reset/计时器变更前拒绝维护、删除与 recovery；自动整理关闭不阻断手动。
- R3-N1：统一 `deps.host`、Storage 同步返回类型、queueItemIds 复数与 Task 3/6 disposer 职责描述。

## 2026-11-27 §12 GLM 复核修订落点

- G-I1：Task 5 Step 3 准入后、`createAgent` 前 `await mkdir(wikiRoot, { recursive: true, mode: 0o700 })`（M1-1 只建 `<kbDir>`，`wiki/` 仅在损坏恢复/重建路径创建），失败按批次失败结算并带具名 `terminalError`；Task 6 测试 1 补判别性断言（createAgent 桩内 `existsSync(wikiRoot)` + 真实 `preExecuteExplained` 的 allow/deny 对照）。
- G-M1（2026-11-27 owner 裁定方案一）：present-as 只消费 `huaanworkSessionToolAllow`，不读 `huaanworkPackageChildAllow`，`@agent` 路径零改动；Task 2 测试 2 改为断言 packageChildAllow 不影响可见集。
- G-N1：Task 5 setup 片段补 `PromptContext` 必填的 `name`/`order`；G-N2：各 Task 类型检查统一为 `corepack yarn workspace dsh-plugin-huaanwork typecheck`（5 个工程，含 tests）；G-N3：Task 3 测试 9 的 unlink spy 改黑盒断言（真实 worker 线程，主线程 spy 不可见）；G-N4：Task 3 墓碑校验先 `lstat`（ENOENT 即可清行）再 `resolveInside(forWrite)`；G-N5：看门狗钉死「定时器只唤醒 + `deps.now()` 与 `touch()` 基准比较，`noteSystemResume()` 即 `touch()`」；G-N6：`pauseWatch`/`resumeWatch` 三处加 `isOrganizerPhase` 守卫；G-N7：Task 4 测试 7 / Task 5 测试 8 的前置构造写进测试描述；G-N8：写明文档级 `retry_after` 不设计时器，由周期对账与排空后再评估触发。

---

### Task 1: 整理槽前缀、6 点可见性隔离与 `sandbox-cwd` / `writable-root` fail-closed

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/session-ids.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer-activity.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts:30-92`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts:56-134`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:576-579,709,1103-1106,1395,1480-1484`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-sweep.ts:51-57`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts:16,180-206`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`（`mapTokens`、`tools/execute`、`agent/status`、`agent/error`；文件里没有 `AUTO_SESSION_PREFIX`）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:11-28,65-75`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（约 2304，自动化流过滤旁边）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-org-isolation.spec.ts`

**Interfaces:**
- Produces in `knowledge/session-ids.ts`: `KB_ORG_SESSION_PREFIX = 'huaanwork-kb-org-'`、`kbOrganizeSessionId(kbId: string)`、`isKbOrganizeSessionId(id: string | undefined): boolean`、`kbIdFromOrganizeSessionId(id: string): string | undefined`。
- Client mirror in `sessionChannel.ts`: `KB_ORG_SESSION_PREFIX = "huaanwork-kb-org-"`、`isKbOrganizeSessionId(id)`（对齐 `AUTO_SESSION_PREFIX` 的双端独立声明模式）。
- Produces the synchronous registry-id provider seam in `writable-root.ts` and the activity seam in `organizer-activity.ts`:

```ts
export function setRegisteredKnowledgeBaseIdsProvider(
  provider: (() => ReadonlySet<string>) | undefined,
): () => void
export function registeredKnowledgeBaseIds(): ReadonlySet<string>

export type KnowledgeOrganizerActivity =
  | 'token' | 'reasoning' | 'tool/start' | 'tool/end' | 'diff' | 'compaction/done'
export interface KnowledgeOrganizerActivityObserver {
  touch(kind: KnowledgeOrganizerActivity): void
  noteError(message: string): void
}
export function registerKnowledgeOrganizerActivity(
  sessionId: string,
  observer: KnowledgeOrganizerActivityObserver,
): () => void
export function noteKnowledgeOrganizerActivity(
  sessionId: string | undefined,
  kind: KnowledgeOrganizerActivity,
): void
export function noteKnowledgeOrganizerError(
  sessionId: string | undefined,
  message: string,
): void
```

`setRegisteredKnowledgeBaseIdsProvider` 未注入时 `registeredKnowledgeBaseIds()` 返回空集合。两个 setter/register 都返回带所有权校验的 disposer：仅注销仍属于本次注册的 provider/observer，旧 Host 的晚到退场不得清掉新 Host 注册。活动表只保存当前整理槽，disposer 删除后不得残留 sessionId。

- [ ] **Step 1: 写 6 点隔离与缺根 fail-closed 失败测试**

覆盖（对应规格 §5.3、§8.1、§11.1 第 2/8 项）：
1. `sandbox-cwd.ts`：`withPinnedCwd`、`sandboxPolicy.resolve` 与 `sessionWorkspaceRoot` 在遇到 `huaanwork-kb-org-kb1` 且 `huaanworkSessionRoots` 无条目时**直接抛错拒绝**，绝不回落前台工作区 `huaanworkWorkspaceRoot.current` 或 `process.cwd()`；已登记根时仅夹紧到该 `wiki/`。`withPinnedCwd` 在 `seedSource === 'persistence'` 时也抛这个错：缺根检查写在 `sandbox-cwd.ts:95` 的 persistence 早退之前；
2. `writableRootForSession` 对整理前缀读取入参 `registeredKbIds`。id 在集合内则返回 `neutralKnowledgeWikiRootPath(profileDir, kbId)`；集合缺省或不含该 id 时抛 `knowledge-organize-root-unregistered`。不得用 `existsSync(wiki)` 代替登记，也不得回落中立工作区；
3. `turnOriginForSession('huaanwork-kb-org-kb1') === 'knowledge'`，且 `TurnAnchor['origin']` 包含 `'knowledge'`（`sessions.ts:579` 把该返回值登记进锚点）。`'knowledge'` 不挂载 `result_present`；
4. `sessionList` 与客户端 `unscopedSessions` 均过滤掉 `huaanwork-kb-org-*`；
5. `installTurnAnchorHooks` 对 `huaanwork-kb-org-*` 早退，不写入 `turnAnchors` 也不挤占 256 条 LRU；
6. `bridge.ts` 对整理槽不 `emit` `token` / `reasoning` / `tool/start` / `tool/end` / `diff` / `session/end` / `compaction/done`，也不调用 `emitGitDiff`。在同一事件源、UI 早退之前调用 `noteKnowledgeOrganizerActivity`，spy 必须依次看到 token/reasoning/tool-start/tool-end/diff/compaction 心跳，`agent/error` 只让 `observer.noteError` 收到清洗后的错误文本而不广播 `session/end`。`tools/execute` 必须恰好调用一次 `await next()`，并保持既有 `capResult` 返回形状；`mapTokens` 必须完整消费并 `yield` 全部 chunk，测试用两个文本块和一个 reasoning 块断言下游全部收到。`App.tsx` 在 `isAutomationSessionId` 早退旁边对 `isKbOrganizeSessionId` 同样 return；
7. `session-sweep.ts` 在 `AUTO_SESSION_PREFIX` 判断旁边保留 `huaanwork-kb-org-*`，不被项目旧会话清扫误删。
8. provider 缺省时 `registeredKnowledgeBaseIds()` 为空；注入 live Set 后增删库立即反映，不缓存启动快照。先注册 old、再注册 new，调用 old disposer 不得清掉 new；activity 注册执行同样所有权测试，最后 new disposer 后 note 为 no-op 且内部表无 sessionId。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-org-isolation.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 实现前缀常量与 6 处隔离点**

- `sandbox-cwd.ts`：引入 `isKbOrganizeSessionId`。`withPinnedCwd` 的第一件事就是缺根检查，位于 `seedSource === 'persistence'` 早退之前。`sandboxPolicy.resolve` 与 `sessionWorkspaceRoot` 同样检查。若 `isKbOrganizeSessionId(sessionId)` 且 `rootOf(roots, sessionId)` 为 `undefined`，立即 `throw new Error(\`knowledge-organize-root-missing: ${sessionId}\`)`。
- `writable-root.ts`：整理前缀在项目根 / 中立工作区回落之前分支。入参增加 `registeredKbIds?: ReadonlySet<string>`。已登记则返回 `neutralKnowledgeWikiRootPath`；否则抛 `knowledge-organize-root-unregistered`。`sessions.ts` 约 709 与 1395 两处传入 `registeredKnowledgeBaseIds()`。`setRegisteredKnowledgeBaseIdsProvider` 保存的是实时 getter 而不是启动时快照，未设置时为空集合，整理前缀失败关闭；其返回 disposer 只在 provider 身份仍匹配时清回空实现。Task 6 用 KnowledgeHost 的当前登记 id getter 注入。
- `session-sweep.ts`：`shouldKeepSession` 在自动化前缀旁把 `KB_ORG_SESSION_PREFIX` 视为保留。
- `sessions.ts`：`turnOriginForSession` 返回类型扩为 `'automation' | 'knowledge' | 'advanced'`。`sessionList` 过滤 `!isKbOrganizeSessionId(session.id)`。
- `turn-anchors.ts`：`TurnAnchor['origin']` 加上 `'knowledge'`。`agent/pre-step` 与 `session/disposed` 入口对整理槽直接 `return next()` / `return`。
- `bridge.ts`：`mapTokens`、`tools/execute`、`session/event` 的 `compaction/end`、`agent/status`、`agent/error` 都先识别整理槽。token/reasoning/tool-start/tool-end/compaction 在抑制 UI 前调用 `noteKnowledgeOrganizerActivity`；`diff` 心跳只在原本会做 diff 快照的位置记录，但不执行 git。`agent/error` 在抑制 `session/end` 前调用 `noteKnowledgeOrganizerError(sessionId, errorMessage(payload?.error))`，包括 abort 形状；organizer 用首个取消/超时原因决定它是否只是取消。`tools/execute` 的整理分支必须执行 `const result = await next()`，不得 return 掉工具本身；`mapTokens` 用 `for await` 原样 `yield chunk`，不得用提前 return 跳过模型流。随后才跳过 `emit` / `emitGitDiff`。不要到文件里找 `AUTO_SESSION_PREFIX`，自动化对话流过滤在客户端。
- `organizer-activity.ts`：用模块内 `Map<sessionId, KnowledgeOrganizerActivityObserver>` 实现上述窄注册器；`noteActivity` / `noteError` 对未注册/非字符串 id 为 no-op。注册同一 id 时先注销旧 observer，disposer 必须按对象身份删除，防止旧批次清理新批次。
- `sessionChannel.ts`：`unscopedSessions` 与常规侧栏过滤排除整理槽。`App.tsx` 约 2304 行与 `isAutomationSessionId` 使用同一个 `isKbOrganizeSessionId`。

- [ ] **Step 4: 运行测试与双端类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-org-isolation.spec.ts tests/huaanwork-host/turn-anchors.spec.ts tests/huaanwork-host/writable-root.spec.ts tests/huaanwork-guardrails/sandbox-cwd.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/session-ids.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer-activity.ts dsh-plugin-huaanwork/src/huaanwork-host/writable-root.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/sandbox-cwd.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/session-sweep.ts dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-org-isolation.spec.ts
git commit -m "feat(knowledge): add single-slot prefix, 6-point visibility isolation, and fail-closed sandbox root"
```

---

### Task 2: `ctx.huaanworkSessionToolAllow` 双层白名单、`present-as.ts` 空交集修复与策略/模型接线

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts:28-128`（登记 `huaanworkSessionToolAllow: Map<string, readonly string[]>`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:59-75,127-167`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts:28-37,71-98,117-160,253-283`
- Modify: `packages/huaanwork-policy/src/decide.ts:6-18,92-152`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts:61-81`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/knowledge-tool-allow.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts`
- Test: `packages/huaanwork-policy/src/decide.test.ts`（node:test，由 `yarn workspace @huaanwork/policy test` 执行；没有 `packages/huaanwork-policy/tests/`）

**Interfaces:**
- Produces in `holders.ts`: `ctx.huaanworkSessionToolAllow: Map<string, readonly string[]>`（初始化 `new Map()`，登记在 `HUAANWORK_CONTEXT_PROPS`）。
- Modifies `present-as.ts`: 只读取 `sessionAllow = ctx.huaanworkSessionToolAllow?.get(sessionId)`；存在时与 `(ALLOWED_TOOLS ∪ extra)` 取交集；**当存在显式白名单、`tools.schemas().length > 0` 且交集为空时，调用 `tools.restrict({ allow: [] })`**（彻底消除 L156 fail-open；无显式白名单或 `schemas()` 为空时保持原行为）。**不消费 `ctx.huaanworkPackageChildAllow`**（2026-11-27 owner 裁定 G-M1 方案一）：该表维持现状只供 `hideSkill` 判定（`present-as.ts:147`），包儿童收窄仍由 `skills.ts` 的 `allow ∩ schemas` 完成，`@agent` 路径零改动。
- Modifies `policy.ts` + `decide.ts`:
  - `SESSION_ATTACHED_TOOLS` 与 `isRegisteredToolName` 新增 `'kb_org_get_delta'`、`'kb_org_read_doc'`、`'kb_org_mark_organized'`；
  - `decide.ts` 为这三个工具增加显式分支 `return input.attached ? ALLOW : deny(reasonToolUnattached(input.name))`（永不返回 `ask`）；
  - `policy.ts` 在 `tools/pre-execute` 与 `tools.guard` 中检查 `ctx.huaanworkSessionToolAllow?.get(sessionId)`，不在名单内直接拒绝；同时对 `isKbOrganizeSessionId(sessionId)` 的 `write` / `edit` 额外拒绝 OS 临时目录（`os.tmpdir()`）。符号链接判断放在这一层，不放进 `@huaanwork/policy`：对候选路径做 `lstat`，是符号链接就拒绝；`lstat` 得到 `ENOENT` 表示新文件，继续走 `decide.ts`。不要用 `stat`，悬空链接的 `stat` 也是 `ENOENT`。`resolveInside` 已经拒绝目标仍存在的越界链接，盖不住悬空链接。

- [ ] **Step 1: 写空交集 fail-closed、双层白名单、禁 temp/symlink 与无 `ask` 失败测试**

覆盖（对应规格 §5.3、§11.1 第 2 项）：
1. `present-as.ts`：设置 `huaanworkSessionToolAllow.set(sid, ['nonexistent'])` 且 `tools.schemas()` 非空 → 必须调用 `tools.restrict({ allow: [] })`；当 `tools.schemas()` 为空（尚未注册）时不调用 `restrict({ allow: [] })` 锁死，待 `tools/change` 再收窄；无显式白名单时原行为不变；
2. `huaanworkPackageChildAllow` 不影响 present-as 可见集：只设置 `huaanworkPackageChildAllow`（无 `huaanworkSessionToolAllow`）时行为与现状逐字一致；两者同时存在时只按 `huaanworkSessionToolAllow` 交集裁决（G-M1 方案一，`@agent` 路径零改动）；
3. 整理白名单内 6 个 fs 工具（在 `wiki/` 内）+ 3 个 `kb_org_*`（已挂载）在 `ask`/`smart`/`full` 三档均返回 `allow`，绝不返回 `ask`（验证无需 `huaanworkUnattended`）；
4. 整理会话调用 `bash` / `pwsh` / `str_replace_editor` / `skill` / `web_fetch` / `request_input` / `result_present` 在 `present-as` 不可见且在 `policy`（`pre-execute` + `guard`）被拒；
5. 整理会话向 `os.tmpdir()` 写被拒。`wiki/` 内一条悬空符号链接（链接本身在库内，目标尚不存在且落在库外，目标的父目录存在）调用 `write`/`edit` 被拒。目标仍存在的越界链接不算这条测试，`resolveInside` 已经拒绝它；
6. `isRegisteredToolName('kb_org_get_delta' | 'kb_org_read_doc' | 'kb_org_mark_organized') === true`，且 `parseSseToolCalls` 保留这三个名字的 SSE tool call（对照 `model.spec.ts` 里 `result_present` 的形状）。漏注册会把调用静默丢掉，回合看起来正常结束。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/knowledge-tool-allow.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 实现 `holders.ts`、`present-as.ts`、`policy.ts`、`decide.ts`、`model.ts`**

- 注意 `policy.ts` 里读取 `ctx.huaanworkSessionToolAllow` 全部用可选链 `?.`，保证最小化测试桩零破坏。悬空链接用 `lstat` 判断。
- `model.ts` 的 `isRegisteredToolName` 在 `result_present` 旁边加上三个 `kb_org_*`。
- `packages/huaanwork-policy/src/decide.ts` 保持零三方依赖（仅用 `node:fs`、`./paths.ts`、`./shell.ts`）。三个工具的分支与 `result_present` 相同：`attached ? ALLOW : deny`。策略单测改 `src/decide.test.ts`。

- [ ] **Step 4: 运行护栏、策略与类型检查**

Run:
```bash
corepack yarn workspace @huaanwork/policy test
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/knowledge-tool-allow.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/huaanwork-guardrails/model.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/huaanwork-policy/src/decide.ts packages/huaanwork-policy/src/decide.test.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/knowledge-tool-allow.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts
git commit -m "feat(knowledge): add huaanworkSessionToolAllow dual-layer guard and fix present-as empty-intersection fail-open"
```

---

### Task 3: 三个整理宿主工具与受控墓碑删除

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/org-tools.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host-ref.ts`（`setKnowledgeHost` / `getKnowledgeHost`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`（tools effect 约 491 起注册工具；`knowledgeHost` 在 296–325 的另一个 effect 里，不能透传）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts`（扩展同一宿主的整理批次/存储门面，复用私有 `storage`，禁止另建 Worker）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-protocol.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-client.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-worker.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-org-tools.spec.ts`

**Interfaces:**
- Produces in `knowledge/org-tools.ts`:
  - `KB_ORG_TOOLS = ['kb_org_get_delta', 'kb_org_read_doc', 'kb_org_mark_organized'] as const`
  - `KB_ORG_ALLOWED_TOOLS = ['read', 'read_file', 'glob', 'grep', 'write', 'edit', ...KB_ORG_TOOLS] as const`
  - `registerKnowledgeOrgTools(toolCtx): () => void`（执行时读 `getKnowledgeHost()`，不从 tools effect 的闭包接收 host）
- Produces in `knowledge/host-ref.ts`: `setKnowledgeHost(host: KnowledgeHost): () => void` 与 `getKnowledgeHost(): KnowledgeHost | undefined`。setter 返回按 host 身份注销的 disposer，旧 Host 晚到清理不得摘除新 Host。
- Produces in `knowledge/host.ts` the only organizer storage/batch facade. These are Host-internal TypeScript methods, not new routes:

```ts
export interface KnowledgeOrganizeBatchSettlement {
  readonly batch: PendingOrganizeBatch
  readonly organizedDocIds: readonly string[]
  readonly clearedTombstoneIds: readonly string[]
}

interface KnowledgeHost {
  getRegisteredKnowledgeBaseIds(): ReadonlySet<string>
  listOrganizeCandidates(manualKbIds?: ReadonlySet<string>): readonly KnowledgeBaseRecord[]
  peekPendingOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch>
  openOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch>
  getOpenOrganizeBatch(kbId: string): PendingOrganizeBatch
  closeOrganizeBatch(kbId: string): KnowledgeOrganizeBatchSettlement
  readOrganizeDoc(
    kbId: string,
    docId: string,
    startOrdinal: number,
    limit: number,
  ): Promise<readonly ChunkWindowItem[]>
  markOrganizeProcessed(
    kbId: string,
    docId: string,
    sha256: string,
  ): Promise<{ readonly updated: boolean }>
  clearOrganizeTombstones(kbId: string, docIds: readonly string[]): Promise<readonly string[]>
  recordOrganizeFailure(
    kbId: string,
    docId: string,
    sha256: string,
    error: string,
    nowMs: number,
  ): Promise<{ readonly attempts: number; readonly retryAfter: number | null }>
  resetOrganizeFailures(kbId: string, docId?: string): Promise<void>
}
```

`peek` 只读不写；`open` 再查询一次并保存深拷贝/冻结的唯一当前批，已有 open 批则抛 `knowledge-base-busy`。`getOpen` 没有当前批时抛 `knowledge-organize-batch-not-open`；`close` 原子取出并删除当前批及其实际 `updated=true` 文档、实际删除墓碑行 id。`getRegisteredKnowledgeBaseIds` 返回排除 `deletingIds` 的新 Set；`listOrganizeCandidates` 只含 `autoOrganize=true` 或 id 属于本次 `manualKbIds`、且非删除/维护、非 `wiki-reset-pending`/`index-error` 的存活记录；无 manual 参数时就是纯自动候选。所有方法都调用 M1-1 已有的 `storage` 闭包实例。
- Tool scope enforcement: 从 `execution.agent` 取出 `sessionId` → `kbIdFromOrganizeSessionId(sessionId)` 锁定当前 `kbId`（非整理槽直接拒）；不接受跨库 `kbId` 参数。`kb_org_get_delta()` 只返回 `getOpenOrganizeBatch` 的那份冻结快照，不得重新查询 Storage。`kb_org_read_doc` / `processed` 的 docId 必须属于快照 docs，`clearedTombstones` 必须属于快照 tombstones；默认/最大分页 `limit=12`。
- `kb_org_mark_organized` 校验：
  1. 每个 `processed` 项对应磁盘路径必须为 `wiki/docs/<docId>.md`（过 `resolveInside(wikiRoot)`），`lstat` 必须为非符号链接常规文件、字节数 `1..256 KiB`。全库 `wiki/` 总大小用 `lstat` 累加、不跟随指向库外的链接，默认上限 `MAX_WIKI_TOTAL_BYTES`（50 MiB）；检查函数允许测试注入更小上限；
  2. 有 `processed` 项时经 `host.markOrganizeProcessed` 调用已有 `markOrganizedAtomic`（固定 `wikiNotePath=docs/<docId>.md`，`WHERE doc_id = ? AND sha256 = ?`）。不命中则报告 `stale-sha256`、不推进指纹，也不加入 `organizedDocIds`。工具不把 `clearedTombstones` 传给这个 op：`processed` 为空时它没有可更新的文档行；
  3. 墓碑先在 Host 工具层一次性校验全部 docId 都属于当前批快照。`wikiNotePath=null` 表示无卡片可删；非 null 必须逐字等于 `docs/<docId>.md`；随后**先 `lstat`**：`ENOENT` 即视为可清行（文件已不存在）；存在则过 `resolveInside(wikiRoot, rel, { forWrite: true })` 并确认非符号链接常规文件后删除文件。顺序不得颠倒——不带 `forWrite` 的 `resolveInside` 对不存在的文件返回 `null`（`paths.ts:24-31`），先 resolve 会把「文件已丢」的墓碑永远拒在副作用之前。任一参数/路径非法则整次调用在副作用前拒绝；单个 `unlink` 失败只保留该 id 行。随后调用 `host.clearOrganizeTombstones` → 新 storage op `clearOrganizeTombstones(kbId, docIds)`，**Storage Worker 只在事务里删行并返回实际删除 id，绝不 unlink Wiki 文件**。Host 把返回 id 加入 `clearedTombstoneIds`。`processed` 为空的纯墓碑批也走这条路径，绝不删除 `topics/` 或模型给出的其它路径。

- [ ] **Step 1: 写整理工具作用域、非空/256KB/符号链接校验、`WHERE sha256 = ?` 原子提交与墓碑删除失败测试**

覆盖（对应规格 §8.1、§11.1 第 4 项）：
1. `kb_org_get_delta` 仅返回本批（≤ 10 文档 / 80 KB）到期文档与墓碑，跳过 `organize_retry_after > now` 或 `organize_attempts >= 3` 的文档；
2. `kb_org_read_doc` 默认 `limit = 12` 分页返回切片；
3. `kb_org_mark_organized` 拒绝 0 字节文件、> 256 KB 文件、符号链接、越界路径；源文件在整理途中变动（`sha256` 改变）时不推进 `organized_sha256`；
4. `clearedTombstones` 仅删除数据库登记过的 `wiki/docs/<docId>.md`，传入越界或专题路径参数被拒绝。`processed` 为空且只有墓碑时，不调用 `markOrganizedAtomic`，墓碑行被 `clearOrganizeTombstones` 删掉，文件先于行删除；
5. 全库 `wiki/` 超过上限时拒绝 mark。测试注入一个很小的上限证明拒绝；另断言生产默认值是 `MAX_WIKI_TOTAL_BYTES`（50 MiB），不要在测试里写满 50 MiB 文件；
6. 非整理会话调用 `kb_org_*` 直接拒绝。`getKnowledgeHost()` 为空时同样拒绝。
7. 未 `openOrganizeBatch` 时 `kb_org_get_delta` 抛 `knowledge-organize-batch-not-open`。open 后再向数据库加入新文档/新墓碑，`get_delta` 仍逐字返回 open 时的 docs/tombstones；`closeOrganizeBatch` 返回同一快照以及真正 `updated=true` / 真正删行的 id，第二次 close 抛 not-open。
8. `kb_org_read_doc`、`processed`、`clearedTombstones` 传入当前批外 docId 时全部拒绝，且没有文件或数据库写副作用。非法墓碑列表含一个越界 id 时，合法 id 也不得被部分删除。
9. Storage Worker 的 `clearOrganizeTombstones` 测试注入不存在的 id，返回数组只含实际删行 id；「Worker 绝不 unlink」用黑盒断言：建一条带真实 `wiki/docs/<docId>.md` 文件的墓碑行，经真实 `createKnowledgeStorageClient()` 调用后行已删、文件仍在（knowledge 系列测试驱动真实 `worker_threads`（`knowledge-storage.spec.ts:307`），主线程 spy 看不到 worker 模块，不用 `unlink` spy）。Host 工具层分别覆盖文件存在、文件已不存在、null wikiNotePath、unlink 失败保留行。
10. `host-ref.ts` 先注册 old host 再注册 new host，old disposer 不得清掉 new；new disposer 后 `getKnowledgeHost()` 为 undefined。`getRegisteredKnowledgeBaseIds` 的返回值是副本，调用方 mutate 不得改变 Host 注册表；删除中的 id 不出现。
11. `listOrganizeCandidates` 用真实 Host 记录验证：自动开启库入选，自动关闭库仅在 manual 集合中入选；watchPaused/watch-failed/source-unavailable 不阻断阶段 2，维护/删除/wiki-reset-pending/index-error 一律排除。

核心快照断言按下面的真实调用顺序写，不得只测两个独立数据库查询：

```ts
const opened = await host.openOrganizeBatch('kb1', 1_000)
await storage.upsertDocument('kb1', newDocumentAfterOpen)
expect(host.getOpenOrganizeBatch('kb1')).toEqual(opened)
const settled = host.closeOrganizeBatch('kb1')
expect(settled.batch).toEqual(opened)
expect(settled.organizedDocIds).toEqual([])
expect(settled.clearedTombstoneIds).toEqual([])
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-org-tools.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 实现同一 Host 的整理批次/存储门面、`knowledge/org-tools.ts` 与 `index.ts` 接线**

- 使用与 `result-artifact-tools.ts` / `expert-team-dispatch.ts` 相同的 `defineTool` 模式全局注册。tools effect 通过 `getKnowledgeHost()` 取宿主，不把 296 行那个 effect 的局部 `knowledgeHost` 透进 `toolCtx`。
- tools effect 的 disposer 先注销三个 `kb_org_*`。knowledge effect 保持注册在 tools plugin 之前；本 Task 不复制知识库退场，Task 6 再统一接入 resume 退订、provider/host-ref 所有权清理与 `knowledgeHost.dispose()`。跨这两个 Task 的总顺序仍是先注销工具，再 dispose host。
- `host.ts` 增加下列私有状态，并把本 Task Interfaces 的方法加入返回对象；不得把 `storage` 本身导出：

```ts
const openOrganizeBatches = new Map<string, {
  batch: PendingOrganizeBatch
  organizedDocIds: Set<string>
  clearedTombstoneIds: Set<string>
}>()
```

`open` 在 Storage 查询完成后再次检查记录仍存活且非删除/维护，再写 Map；等待期间被删除则抛 `knowledge-base-not-found`，不得复活批次。`close` 返回数组副本。`markOrganizeProcessed` 只在 `updated=true` 时记 id；`clearOrganizeTombstones` 只记 storage 实际返回的删行 id。
- `clearOrganizeTombstones` 加进 storage protocol、client、worker 与 `storage-db.ts`。Host/client 返回 `Promise<readonly string[]>`；`StorageResultMap`、Worker 同步 case 与 `storage-db.ts` 函数的返回类型均为 `readonly string[]`。数据库实现用 `inImmediateTransaction` 逐 id 删除并收集 `changes>0` 的 docId；不要在 `storage-worker.ts` / `storage-db.ts` import `unlink` 或操作 Wiki 文件。不要改 `markOrganizedAtomic` 现有的 `clearedTombstones` 行为，整理工具只是不走那条参数。

- [ ] **Step 4: 运行测试与类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-org-tools.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/org-tools.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host-ref.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-protocol.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-client.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-worker.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/storage-db.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-org-tools.spec.ts
git commit -m "feat(knowledge): add organizer tools with atomic sha256 commit and controlled tombstone deletion"
```

---

### Task 4: `TurnScheduler` `kb-organize` 抢占式调度与 `soleCapWriterSessionId` 排除

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts:28-282`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:1203-1233,1366-1468`（新增 `setReevaluateKbOrganize` 钩子，严格排在 `drainQueue()` 与 `reevaluateDueAutomations()` 之后；同时修改 `sessionSend` 的真实 queued 返回分支）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`SessionSendResult` 注释、`takePendingBuffer` 约 1060–1074、queue owner 写回约 3762–3771；queueItemId 同时覆盖等待中与已出队待 queue-start）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts`（只更新 `noteSendResult` 的 queueItemId 注释为“waiting 或已出队待 queue-start”，`sendOpensTurn` / `noteSendResult` 逻辑不变）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts:276-298`（`takeEarlyPendingEvents` 的第二道守卫同步改为按 queueItemId，更新排队/出队应答注释）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler-kb-organize.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`（start/fail 各自早于/晚于出队应答的四条时序）

**Interfaces:**
- Modifies `turn-scheduler.ts`:

```ts
export type AdmitUserResult =
  | { kind: 'start'; root: string }
  | { kind: 'queued'; root: string; queueItemId: string; drain?: true }
  | { kind: 'error'; reason: string }
```

普通排队省略 `drain`，从而保持既有 `AdmitUserResult` 深相等形状；只有“抢占成功且调用前队列非空”的新到项返回 `drain=true`。`sessions.ts` 的 `drainUserQueue(...): readonly string[]` 返回本轮全部出队 id，既有调用方可以忽略返回值。
  - `RootWriter['kind']` 增加 `'kb-organize'`，附加可选 `kbId?: string` 与 `onPreempt?: () => void`；
  - 新增 `admitKbOrganize(input: { kbId: string; sessionId: string; root: string; onPreempt: () => void }): { kind: 'start'; root: string } | { kind: 'skip'; reason: 'root-busy' | 'cap-full' | 'kb-busy' | 'queue-non-empty' }`（全局最多 1 个 `kb-organize`；用户队列非空直接 skip）；
  - `soleCapWriterSessionId()` 排除 `writer.kind === 'kb-organize'`；
  - `admitUserTurn`：仅当 `!rootWriters.has(root) && activeTurns >= options.maxConcurrentTurns()` 且存在活跃 `kb-organize` 写者时，触发其 `onPreempt()`、立即从 `rootWriters` 移除该整理写者并递减 `activeTurns`（整理方 `finally` 调用 `release(sessionId)` 时因已不在 `rootWriters` 而幂等 no-op，绝不二次扣减）。若调用前用户队列为空，该用户立即准入为 `{ kind: 'start' }`。若调用前用户队列非空，该用户按现有规则入队（`enqueuedAt` 为当前时刻）并返回 `{ kind: 'queued', drain: true, queueItemId }`，由 `sessions.ts` 在返回前调用一次 `drainUserQueue`（不要在 `admitUserTurn` 内复制出队）。`drainUserQueue` 返回本轮全部出队 `queueItemIds: readonly string[]`；现有调用方忽略返回值。本次发送若仍在队列，`session.send` 返回 `waiting: true`；若本次 `queueItemId` 已由这次排空出队，只由 `startQueuedItem` 启动，`session.send` 返回 `waiting: false, started: false, queueItemId`，不得再直接 `sendToAgent`。出队只表示启动所有权已移交，不表示 followup 已受理；客户端等待 queue-start 才初始化回合。已排队、根空闲、且 `enqueuedAt` 更早的用户先获得名额；更早等待者根仍忙则跳过。若 `rootWriters.has(root)`（同根忙碌），直接排队，**不无谓取消整理**！规格：§8.2(3)（2026-11-26）。

- [ ] **Step 1: 写抢占、同根不误杀、幂等释放、全局单槽与 `soleCapWriterSessionId` 排除失败测试**

覆盖（对应规格 §8.2、§11.1 第 6 项）：
1. 用户队列为空、`maxConcurrentTurns = 1` 且 `kb-organize` 占槽时，不同根的用户回合到来 → 触发 `onPreempt`、立即可启动（`kind: 'start'`）、`activeTurnCount() === 1`；随后被抢占的整理 `finally` 调用 `release(orgSessionId)` 后 `activeTurnCount()` 仍为 `1`（无二次扣减）；
2. `maxConcurrentTurns = 2` 且用户 A 在根 R 运行、整理在 `wiki/` 运行，此时同根 R 的用户 B 到来 → 用户 B 排队且**不触发**整理 `onPreempt`；
3. 全局同时只能存在 1 个 `kb-organize`（第二个库 `admitKbOrganize` 返回 `skip: 'kb-busy'`）；
4. 用户队列非空时 `admitKbOrganize` 返回 `skip: 'queue-non-empty'`；
5. 仅 `kb-organize` 占槽时 `soleCapWriterSessionId()` 返回 `undefined`；用户 + `kb-organize` 共占槽时 `soleCapWriterSessionId()` 返回该用户会话 id；
6. `drainUserQueue` 调用顺序严格为 `drainQueue()` → `reevaluateDueAutomations()` → `reevaluateKbOrganize()`；
7. 队列中已有用户甲（根已空闲、更早入队），整理占满名额，不同根的用户乙到来 → 触发 `onPreempt`，返回 `{ kind: 'queued', drain: true }` 而不是 `{ kind: 'start' }`；随后 `drainQueue()` 先启动用户甲，用户乙仍留在队列。若用户甲的根仍忙，同一次 `drainQueue()` 可以启动用户乙，且只启动一次。**前置状态必须特殊构造**（普通占名额写者构造不出来：`admitKbOrganize` 遇非空队列直接 skip，普通写者释放后 `drainQueue` 会立刻启动甲）：整理先占满名额；甲的根被不占名额的 `script-automation` 写者（`countsTowardCap=false`，`turn-scheduler.ts:160-166`）占住，甲到来按根忙入队；script 写者释放后 `drainQueue` 因整理满额无法启动甲，即得「甲已入队且根空闲、整理占名额」。也可让甲与整理写者同根（命中「同根排队、不取消整理」）。
8. 经真实 `sessionSend` 覆盖两种返回：甲出队而乙未出队时，乙收到 `{ waiting: true, started: false, queueItemId }`；乙在本次出队时收到 `{ waiting: false, started: false, queueItemId }`，且乙的 `sendToAgent` 只来自 `startQueuedItem` 一次。出队应答绝不在 followup 受理前伪造 `started:true`。
9. `appWiring.spec.ts` 固定 `sent={waiting:false,started:false,queueItemId:'qb'}` 并跑四条时序：queue-start 早于应答时先进 pending，应答登记 owner 后重放并恰好 `openTurnForTab` 一次；queue-start 晚于应答时由已登记 owner 即时处理，同样只开一次。queue-fail 早于/晚于应答都不得 openTurn，running 保持 false、用户消息标 notStarted、模型选择回滚且原因可见。普通直接 `{started:true}` 应答与既有 waiting 应答必须原样通过。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-scheduler-kb-organize.spec.ts tests/client-huaanwork/appWiring.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 修改 `turn-scheduler.ts` 与 `sessions.ts`**

- 注意 `TurnScheduler` 保持纯内存、零磁盘 I/O；现有 `tests/huaanwork-host/turn-scheduler.spec.ts` 行为保持 100% 兼容。
- `drainUserQueue` 继续是 `drainQueue()` → `reevaluateDueAutomations()` → `reevaluateKbOrganize()`。先保存 `const started = scheduler.drainQueue()`，逐项 `void startQueuedItem(...)`，完成两个后置评估后返回 `started.map(item => item.queueItemId)`。Task 5 的整理结束必须调用 `releaseAndDrain`（内部就是 `release` 加这一次 `drainUserQueue`），不能只调 `turnScheduler.release`。
- `sessionSend` 只在 `admitted.kind==='queued' && admitted.drain` 时调用一次 `drainUserQueue`；返回值包含本次 id 就表示已交给出队启动路径。按下面分支实现，禁止在 contains 分支后再调 `sendToAgent`：

```ts
if (admitted.kind === 'queued') {
  const startedIds = admitted.drain ? drainUserQueue(ctx, routeCtx) : []
  if (startedIds.includes(admitted.queueItemId)) {
    return {
      queued: true,
      waiting: false,
      started: false,
      sessionId,
      queueItemId: admitted.queueItemId,
    }
  }
  return {
    queued: true,
    waiting: true,
    started: false,
    sessionId,
    queueItemId: admitted.queueItemId,
  }
}
```
- `App.tsx` 保留既有 queue owner 记录体，但入口条件从 `sent.waiting && sent.queueItemId !== undefined` 改为仅 `sent.queueItemId !== undefined`，使出队应答也登记 owner 并把 queueItemId 挂到原用户消息；`noteSendResult` 不变，只有 waiting 才新增 waitingIds。`SessionSendResult` 注释改为“queueItemId 覆盖等待中与已出队待 queue-start”。
- `takePendingBuffer` 在 `sendOpensTurn(sent)=false` 后，只要 `sent.queueItemId !== undefined` 就调用 `takeEarlyPendingEvents` 过滤 queue-start/queue-fail，不再要求 waiting。`sessionChannel.ts` 的 helper 自身也把 `if (!(sent.waiting && sent.queueItemId !== undefined)) return []` 改为 `if (sent.queueItemId === undefined) return []`，并更新“排队/出队应答”的函数注释；两层条件必须同改。`sendOpensTurn` 与直接 started 分支不变；queue-start 经既有 `beginQueuedTurn` 成为唯一队列回合初始化点，queue-fail 因 owner 存在而能回滚模型并标 notStarted。
- 抢占把整理写者移出 `rootWriters` 之后、旧 agent 的 `dispose` 完成之前，`wiki/` 根在调度器里是空的。若有用户会话的可写根正好是这个 `wiki/`，随后的 `drainQueue` 可以准入。接受这个窗口：不另加根锁。`inFlightOrganizeByKb` 只串行整理槽的 `create` / 删库，不挡住用户回合。在抢占分支旁用一句话写明。

- [ ] **Step 4: 运行调度器测试与类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/turn-scheduler.spec.ts tests/huaanwork-host/turn-scheduler-kb-organize.spec.ts tests/client-huaanwork/appWiring.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/logic/concurrentTurn.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/tests/huaanwork-host/turn-scheduler-kb-organize.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat(knowledge): add preemptive kb-organize scheduling and exclude from soleCapWriterSessionId"
```

---

### Task 5: 单库单槽整理执行器（模型预检、`inFlightOrganizeByKb`、看门狗与失败计次退避）

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts`（消费 Task 3 批次门面，并增加整理相位窄方法）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/types.ts`（`KnowledgeOrganizerPhase`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts`（整理相位不被 `settlePhase` 刷回空闲相位，并提供受控 set/clear）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-organizer.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-organizer-phase.spec.ts`

**Interfaces:**
- Produces in `knowledge/types.ts` and `knowledge/organizer.ts` these exact cross-task contracts:

```ts
export type KnowledgeOrganizerPhase =
  | 'waiting-turn-slot'
  | 'organizing'
  | 'blocked-no-model'
  | 'blocked-network'

export interface KnowledgeOrganizerDeps {
  readonly profileDir: string
  readonly dshHome: string
  readonly host: KnowledgeHost
  readonly scheduler: TurnScheduler
  readonly sessionRoots: Map<string, string>
  readonly sessionToolAllow: Map<string, readonly string[]>
  readonly sessionModels: Map<string, string>
  readonly attachments: AttachmentMaps
  readonly createAgent: (options: CreateAgentOptions) => Promise<AgentHandle>
  readonly releaseSlot: (sessionId: string) => void
  readonly now: () => number
  readonly timeoutMs: () => number
}

export interface KnowledgeOrganizer {
  scheduleEvaluate(input?: { manualKbIds?: readonly string[] }): Promise<void>
  triggerManual(
    kbId: string,
    opts?: { docId?: string; retryFailed?: boolean },
  ): Promise<void>
  cancelForKb(
    kbId: string,
    reason: 'user-stop' | 'preempt' | 'maintenance' | 'dispose',
  ): Promise<void>
  cancelAll(): Promise<void>
  waitForKbSlotIdle(kbId: string): Promise<void>
  noteSystemResume(): void
}

export function createKnowledgeOrganizer(deps: KnowledgeOrganizerDeps): KnowledgeOrganizer
```

`CreateAgentOptions` / `AgentHandle` 从 `@deepseek-ai/dsh-agent` 以 `import type` 引入，`AttachmentMaps` 从 `../../huaanwork-guardrails/agent-attachments.ts` 引入，`TurnScheduler` 来自 `../turn-scheduler.ts`，`KnowledgeHost` 来自 `./host.ts`。`KnowledgeOrganizer` 的返回方法全部由工厂闭包实现，不依赖 `this`，可直接作为回调传递。`KnowledgeHost` 同步增加以下内部方法，不能从 organizer 直接访问 `runtime`：

```ts
interface KnowledgeHost {
  assertOrganizeAllowed(kbId: string): void
  setOrganizerPhase(kbId: string, phase: KnowledgeOrganizerPhase): boolean
  clearOrganizerPhase(kbId: string): void
}
```

`assertOrganizeAllowed` 依次复用 `requireRecord`、`assertNotDeleting`、`assertNotMaintaining`，再按 `engine.getState(kbId)?.phase` 拒绝 `wiki-reset-pending` / `index-error` 并抛同名 `KnowledgeSyncError`；不得检查 `autoOrganize`，手动整理允许自动开关关闭。两个相位方法委托 SyncEngine。`scheduleEvaluate` 返回 Promise 供无头测试等待，生产回调用 `void scheduleEvaluate()` 并消费拒绝。
- `createKnowledgeOrganizer(deps)` 的运行规则：
  - `scheduleEvaluate(input)` 先构造 `manualKbIds = new Set(input?.manualKbIds ?? [])`，再扫描 `host.listOrganizeCandidates(manualKbIds)`，不在 `KnowledgeHost` 外读注册表；同库 `inFlightOrganizeByKb` 项必须在首个 await 前同步占位。先 `peekPendingOrganizeBatch` 判断空批与退避，再 `admitKbOrganize`；准入成功后调用 `openOrganizeBatch` 再冻结一次，接下来 Agent 工具与回合末结算只能使用这份 open 快照。open 后为空则释放名额，不建 Agent。
  - organizer 保存 `lastPendingSignatureByKb`，签名使用排序后的 `docs:[docId,sha256]` 与 `tombstones:[docId,deletedAt]`，不能用数据库返回顺序当变化。只有签名实际变化才重置该库纯墓碑零进展状态；重复 peek、无变更对账与普通 drain 不变。每轮用 `host.getRegisteredKnowledgeBaseIds()`  prune 已删库的签名/零进展状态并取消其计时器，避免累计删库留下内存条目。`triggerManual` 显式取消旧退避计时器并清零后再走 `scheduleEvaluate({ manualKbIds: [kbId] })`，候选是全部自动库加本次手动库，不缩成单库私有链路。
  - `triggerManual(kbId, opts?)` 第一件事调用 `deps.host.assertOrganizeAllowed(kbId)`；只有校验通过才按 `docId` / `retryFailed` 清零 `organize_attempts`/`organize_retry_after`、取消旧退避计时器并触发。未知库、删除、维护、recovery 的拒绝均发生在任何 reset/计时器副作用之前；
  - `cancelForKb(kbId, reason)` 先取消该库退避计时器并读取当前 `inFlightOrganizeByKb`；没有在途批次就直接返回，不写 cancelReason。存在在途批次才写 `cancelReasonByKb`、对 `activeAgentByKb` 发取消并 await 刚捕获的同一个 inFlight Promise。create 尚未 resolve 时只记录原因；create 返回后、followup 前必须再查原因，已取消则跳过 followup 并直接清理。取消映射：`user-stop → {kind:'user'}`，`preempt/maintenance → {kind:'hook',reason:'knowledge-organize-'+reason}`，`dispose → {kind:'disposed'}`。M1-1 的 `KnowledgeOrganizerHooks.cancelForKb(kbId)` 与 `sync-engine` 的 `cancelOrganizerForKb(kbId)` 都没有 `reason`，不要改这两处签名。引擎回调固定映射为 `maintenance`；`cancelAll` 映射为 `dispose`；抢占回调用 `preempt`；手动停止用 `user-stop`。四类都不递增 `organize_attempts` 或纯墓碑零进展次数；
  - `cancelAll()` 先置 organizer `disposed=true`，清完全部退避计时器，再对每个 active/inFlight kb 以 `dispose` 发取消并 `await Promise.allSettled`；之后 `scheduleEvaluate` 与计时器回调一律 no-op，Host 重启创建新 organizer 才复位。
  - `waitForKbSlotIdle(kbId): Promise<void>`（供重绑、重建、删库与同库下一批复用前等待 `handle.dispose()` + `removeSessionFilesById(sessionsRoot, [sessionId])` 彻底结算）；
  - `noteSystemResume()`（等价于一次 `touch()`：把看门狗基准重置为 `deps.now()` 当前值，忽略这一次向前跳变）；
  - organizer 在 `agents.create` 前调用 `registerKnowledgeOrganizerActivity(sessionId, { touch: () => idleDeadline.touch(), noteError: message => { firstModelError ??= message } })`，`handle.dispose()` 后注销；`firstModelError` 是本批局部变量，bridge 的心跳与 UI 隔离因此同时成立，且模型错误不会被误当正常 idle。`deps.releaseSlot(sessionId)` 是唯一名额释放器，整理结束禁止直接调用 `turnScheduler.release`。
  - `KnowledgeSyncEngine` / `KnowledgeHost` 增加同名相位方法。`setOrganizerPhase` 在 runtime 不 live、维护/删除锁或 `needsRecovery` 时返回 false；否则写入四个整理相位之一并返回 true。`clearOrganizerPhase` 仅在当前仍是四个整理相位之一时恢复 `idlePhase(runtime)`，绝不覆盖 `rebuilding`、`wiki-reset-pending`、`index-error` 或新同步相位。
- 看门狗：超时读 `readHuaanworkSettingsSync(profileDir).automation_timeout_ms`，缺省 `DEFAULT_AUTOMATION_TIMEOUT_MS`（10 分钟）。`deps` 注入 `now(): number` 与 `timeoutMs(): number`。机制钉死为**「定时器只负责唤醒，唤醒时用 `deps.now()` 与 `touch()` 维护的基准比较」**：本槽的 `token`、`reasoning`、`tool/start`、`tool/end`、`diff`、`compaction/done` 心跳调用 `touch()`，把基准重置为 `deps.now()` 并重新武装定时器；定时器到点先比较 `deps.now() - 基准 >= timeoutMs()`，成立才拒绝，否则按剩余时间重新武装。`noteSystemResume()` 即 `touch()`。纯定时器观察不到注入时钟跳变、纯基准比较没有人负责唤醒，两种字面单实现都只能满足测试 5 的一半，不得各取一半。测试 5 的拨钟顺序钉死为：只把 `deps.now` 向前拨 20 分钟（不推进 fake timer）→ `noteSystemResume()` → 再推进 fake timer（不足 `timeoutMs()`）→ 不超时、不计次；反例省掉 `noteSystemResume()`，推进 fake timer 到唤醒 → 超时并计次。「同时推进 fake timer 与 `deps.now`」只适用于纯墓碑退避计时器（测试 9）。
- 纯墓碑批零进展退避（2026-11-26 owner 裁定）：不扩 SQLite schema，在 organizer 内按 kbId 保存零进展次数与可取消重试计时器，时钟复用 `deps.now` 并支持 fake timer。纯墓碑批非取消结束且一个墓碑也未清除时写 `organize_failed`：第 1 次 `60_000 ms` 后重试、第 2 次 `300_000 ms` 后重试、第 3 次停止自动重试；等待退避期间不持全局整理槽、不建 Agent。实际清除至少一个墓碑即清零并继续；只有出现真实新待整理工作（新文档或墓碑集合变化）或 `triggerManual` 才清零并重新评估，无变更对账与普通 `scheduleEvaluate` 不得清零。Host 重启自然复位；抢占、`user-stop`、`maintenance` 和 `dispose` 清计时器但不增加次数。
- 提示词写明：先改 `INDEX.md` 与 `topics/`，再提交 `clearedTombstones`。宿主不会按模型参数删专题页。
- 事件与相位（规格 §8.3，2026-11-26）：经现有 `appendKnowledgeEvent` 写 `events.jsonl`，只能经 `host.setOrganizerPhase` / `clearOrganizerPhase` 改相位（`host.list` 已读 `state.phase`）。等待名额时相位为 `waiting-turn-slot`；模型预检失败为 `blocked-no-model`；网络门禁拒绝为 `blocked-network`；批次已启动为 `organize_started` 且相位 `organizing`；本批按口径成功结束为 `organize_completed`；计为失败为 `organize_failed`；抢占、`user-stop`、`maintenance`、`dispose` 为 `organize_cancelled`。整理结束、取消或让出相位时调用 `clearOrganizerPhase`。`settlePhase` 遇到 `organizing`、`waiting-turn-slot`、`blocked-no-model`、`blocked-network` 时保留，不刷回 `watching`。不注册 `knowledge/changed` 与 `knowledge/event`，不改 `ROUTE_TABLE`。

- [ ] **Step 1: 写单槽复用、模型空串阻断、失败计次退避、休眠看门狗与并发取消锁失败测试**

覆盖（对应规格 §8.1–§8.2、§11.1 第 6 项）：
1. **模型预检**：`settings.active_model_id` 不存在或 `resolved.model.trim() === ''` → 记 `blocked-no-model`，不建 Agent、不递增 `organize_attempts`、不空转；网络门禁拒 → `blocked-network`；
2. **单槽生命周期与 `inFlightOrganizeByKb`**：被用户抢占立即释放全局槽后，同库立刻再次触发整理或删库，必须 `await` 旧 `handle.dispose()` 与 `removeSessionFilesById()` 完成再 `create()`，不抛 `SessionAlreadyExistsError`；
3. **提示词防插值**：库名含 `{{季度}}` 通过 `setup` 注册 `systemPrompt.context({ name, order, required: true, interpolate: false, text })`，断言注册不抛错（`name`/`order` 为 `PromptContext` 必填，非有限 `order` 注册即抛 `TypeError`，`system-prompt/src/index.ts:79-90,513-516`）。提示词约定 `wiki/` 根相对路径、无非行号 `#锚点`，并要求先更新 `INDEX.md` / `topics/` 再清墓碑；
4. **失败计次严格口径**：
   - 抢占取消、`user-stop`、`maintenance`、`blocked-*`、`dispose` 均**不递增** `organize_attempts`；
   - 模型/回合抛错、空闲看门狗超时、或回合正常结束但本批有文档未成功 `kb_org_mark_organized` → 各未推进文档 `organize_attempts += 1`：第 1 次 `retry_after = now + 60_000`、第 2 次 `now + 300_000`、第 3 次 `organize-failed` 且 `retry_after = null` 不再自动排期。文档级 `retry_after` **不另设计时器**：到期后的再评估由周期对账（`DEFAULT_RECONCILE_INTERVAL_MS`，默认 300 秒，`sync-engine.ts:54`）与排空后的 `reevaluateKbOrganize` 触发，60 秒不是精确重试时刻；只有纯墓碑零进展退避使用进程内计时器；
   - `triggerManual(kbId, { docId })` 或 `{ retryFailed: true }` 清零计数并可重新整理；
   - `mkdir(wikiRoot)` 失败（用同名 regular file 占位 `wiki/` 构造）按批次失败结算：写 `organize_failed`、`terminalError` 为 `knowledge-organize-wiki-root-unwritable`、释放名额，不静默跳过、不建 Agent；并计入 `organize_attempts`（与未 mark 同口径）；
5. **休眠时钟跳变豁免**：注入时钟向前跳 20 分钟（拨钟期间不推进 fake timer）并调用 `noteSystemResume()` 时，看门狗不超时。同一次跳变若不调用 `noteSystemResume()`，则推进 fake timer 到唤醒后超时并计次。测试使用 fake timer 与 `deps.now`，不依赖墙钟；
6. **不操作 `session_projcache`**（断言无任何删除缓存调用）且**不登记 `huaanworkUnattended`**；
7. **事件与相位**：等待名额只见 `waiting-turn-slot`；空模型见 `blocked-no-model`；网络拒绝见 `blocked-network`；批次启动写入 `organize_started` 且相位为 `organizing`；成功、失败、取消分别写入 `organize_completed` / `organize_failed` / `organize_cancelled`。其后一次对账的 `settlePhase` 不得把这四个相位刷成 `watching`。断言未注册 `knowledge/changed` 与 `knowledge/event`；
8. **结束后唤醒**：用户甲已在队列中且根已空闲，整理占着唯一名额。整理正常结束后甲被启动。前置构造同 Task 4 测试 7（script-automation 占根后释放，或甲与整理同根；普通占名额写者构造不出该状态）。实现若只调用 `turnScheduler.release`，甲仍停在队列里，这条测试失败。
9. **纯墓碑零进展 1/5/3**：构造只有墓碑的批次，分别覆盖正常结束、模型/回合报错与看门狗超时且未清墓碑：均写 `organize_failed` 并进入进程内退避。第 1 次后不得立即 `create`；同步推进 fake timer 与 `deps.now` 60 秒触发第 2 次，再推进 300 秒触发第 3 次，此后继续推进不得出现第 4 次；退避期间调度器没有整理写者。另验证：实际清除 1 个墓碑即清零并继续；真实新文档/墓碑集合变化与 `triggerManual` 取消旧计时器并复位；无变更 `onIndexCommitted` / `scheduleEvaluate` 不复位；四类取消只清计时器不计次，`cancelAll` 后再次 `scheduleEvaluate`、推进旧计时器都不得 create，`dispose` 后计时器不得启动 Agent。
10. **真实 Agent 驱动**：fake `AgentHandle` 的 `followup` 是 spy，`whenIdle` 返回测试可控 deferred。create resolve 后必须恰好 followup 一次，且 idle 未 resolve 时 organizer 不得结算/释放；idle resolve 后才 dispose、close batch、清理并 release。followup 同步抛错走模型/回合失败。另让 create deferred，期间 `cancelForKb('kb1','preempt')`，create 随后 resolve 时不得 followup、不得计次，只 dispose/cleanup。另在全部文档已 `updated=true` 后调用 observer `noteError('model boom')` 再 idle，事件必须是 `organize_failed` 而非 completed，且未 mark 文档数为 0。无 inFlight 时 `cancelForKb` 只清退避计时器；随后 `triggerManual` 必须能正常 followup，不得读取到陈旧 cancelReason。
11. **唯一权威批次**：peek 返回 A、open 返回 B，open 后再让数据库出现 C；`kb_org_get_delta` 必须返回 B，回合末只对 B 中未出现在 `settlement.organizedDocIds` 的文档调用 `recordOrganizeFailure`，不得对 A 独有或 C 新到文档计次。纯墓碑进展只认 `settlement.clearedTombstoneIds.length`，不认模型自述。
12. **相位窄接口**：在 `knowledge-organizer-phase.spec.ts` 用真实 SyncEngine + 注入 storage/watcher，逐个设置四个整理相位后跑无变更对账，相位保持；clear 后分别恢复 watching/watch-paused/watch-failed/source-unavailable。runtime 不存在、维护中、删除锁与两种 recovery 相位下 set 返回 false 且不覆盖原相位；clear 不得抹掉随后进入的 syncing/rebuilding/recovery。整理相位中调用 `pauseWatch`/`resumeWatch` 不覆盖整理相位。
13. **手动整理校验与自动开关**：`autoOrganize=false` 且有待整理文档时，无参 `scheduleEvaluate()` 不 create；`triggerManual(kbId)` 后必须 create/followup，且同一轮其它自动库仍按全局单槽规则参与，不得绕开 `admitKbOrganize`。维护、删除、wiki-reset-pending、index-error、未知库分别抛 `knowledge-base-busy` / `knowledge-base-deleting` / 对应 recovery code / not-found；每种拒绝都断言 `resetOrganizeFailures` 零调用、退避计时器未变、没有 create。

“只 create”必须让测试失败，核心断言形状如下：

```ts
const run = organizer.triggerManual('kb1')
await vi.waitFor(() => expect(handle.agent.followup).toHaveBeenCalledTimes(1))
expect(handle.dispose).not.toHaveBeenCalled()
resolveIdle()
await run
expect(handle.dispose).toHaveBeenCalledTimes(1)
expect(releaseSlot).toHaveBeenCalledTimes(1)
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-organizer.spec.ts tests/huaanwork-host/knowledge-organizer-phase.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 实现 `knowledge/organizer.ts`、真实回合驱动、批次结算与 Host/SyncEngine 相位接口**

- 批次开始前清理崩溃残留：`removeSessionFilesById` 来自 `session-sweep.ts:249`，签名是 `(sessionsRoot, readonly string[])`。调用 `removeSessionFilesById(join(dshHome, 'sessions'), [sessionId])`。`routes.ts:1686` 是单 id 的现成写法。
- 写入 `deps.sessionRoots.set(sessionId, wikiRoot)`、`deps.sessionToolAllow.set(sessionId, KB_ORG_ALLOWED_TOOLS)`、`deps.sessionModels.set(sessionId, activeModelId)`，并通过 `attachAgentTools(deps.attachments, sessionId, KB_ORG_TOOLS)` 挂载 3 个整理工具。不得在 organizer 内捕获整个 Cordis ctx。
- `host.ts` 实现 `assertOrganizeAllowed` 时直接调用现有 `requireRecord` / `assertNotDeleting` / `assertNotMaintaining`，不复制锁集合；仅 recovery 相位读取 engine state 并抛对应 `KnowledgeSyncError`。`organizer.triggerManual` 在调用 `resetOrganizeFailures`、清理退避计时器或构造 manualKbIds 之前同步执行这一校验。
- 模型预检在名额准入前完成；准入后 `openOrganizeBatch`，随后 **`await mkdir(wikiRoot, { recursive: true, mode: 0o700 })`**（与 `createInner` 同 mode。M1-1 只创建 `<kbDir>`（`host.ts:407`、`sync-engine.ts:1188`），`wiki/` 仅在损坏恢复/重建提交路径由 `performWikiReset` 创建；不补这一层，新建库的全部 fs 工具会被策略层按 `REASON_PATH_ESCAPE` 拒绝——`resolveInside` 对不存在的根返回 `null`（`paths.ts:18-22`）——回合「正常结束」但一份笔记都写不出，三批后全库 `organize-failed`）。mkdir 失败按批次失败结算并带具名 `terminalError`（`knowledge-organize-wiki-root-unwritable`），不得静默跳过。提前建空目录无副作用：`performWikiReset` 对已存在空 `wiki/` 幂等（`storage-db.ts:415-427`），`isUsableWikiCard` 对缺失路径容错（`:1316-1323`）。随后注册 activity touch 并 create。`setup` 只注册系统提示，绝不驱动 Agent。create resolve 后先复查 `cancelReasonByKb`，未取消才按下面顺序驱动：

```ts
await mkdir(wikiRoot, { recursive: true, mode: 0o700 })
const handle = await deps.createAgent({
  sessionId,
  meta: { cwd: wikiRoot },
  agentOptions: { provider: 'deepseek-official', model: 'local' },
  setup(agentCtx) {
    agentCtx.systemPrompt.context({
      name: 'huaanwork:kb-organizer',
      order: 40,
      required: true,
      interpolate: false,
      text: organizerPrompt,
    })
  },
})
activeAgentByKb.set(kbId, handle.agent)
if (!cancelReasonByKb.has(kbId)) {
  handle.agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: KB_ORG_FOLLOWUP_TEXT }],
    source: { kind: 'user' },
  })
  const turn = handle.agent.whenIdle()
  await Promise.race([turn, idleDeadline.promise])
}
```

`KB_ORG_FOLLOWUP_TEXT` 是固定“处理 `kb_org_get_delta` 返回的当前批”指令，不塞入会随后台入库变化的文档数。看门狗超时用 `{kind:'hook',reason:'knowledge-organize-idle-timeout'}` 取消；必须消费 `turn` 的晚到 rejection。首个终止原因获胜：已记录 timeout 后，晚到 dispose 不得把失败改成取消；外部取消先到时，后续 abort error 不得计失败。
- `handle.dispose()` 完成、所有工具已退场后才 `closeOrganizeBatch`。非取消批次按实际结算计次，禁止再查一次 pending 代替本批。`terminalError` 取首个终止原因：`mkdir(wikiRoot)` 失败为 `knowledge-organize-wiki-root-unwritable`，看门狗为 `knowledge-organize-idle-timeout`，模型/回合异常为 `firstModelError` 或 followup/whenIdle 的清洗后 error message，正常结束但有未 mark 文档为 `knowledge-organize-unmarked`：

```ts
const settlement = deps.host.closeOrganizeBatch(kbId)
const organized = new Set(settlement.organizedDocIds)
const unmarked = settlement.batch.docs.filter(doc => !organized.has(doc.docId))
for (const doc of unmarked) {
  await deps.host.recordOrganizeFailure(
    kbId,
    doc.docId,
    doc.sha256,
    terminalError,
    deps.now(),
  )
}
```

`settlement.batch.docs.length===0 && tombstones.length>0` 时，以 `clearedTombstoneIds.length===0` 判零进展；模型返回文本或自称完成都不算进展。只有无 timeout/throw/firstModelError、`unmarked.length===0` 且本批墓碑均已实际清除时才写 `organize_completed`；其余非取消结束写 `organize_failed`。事件与相位只结算一次，空批/取消/成功/失败/退避分别走各自唯一出口。
- 看门狗只用 `deps.now` 与 `deps.timeoutMs`。organizer 内建立局部 `idleDeadline: { promise: Promise<never>; touch(): void; dispose(): void }`：在自动化 `activityDeadline`（`automations-host.ts:283-315`，纯 `setTimeout` + `touch()` 重新起算）之上加时钟基准——定时器只负责唤醒，唤醒时比较 `deps.now()` 与 `touch()` 维护的基准，未超时按剩余时间重新武装，超时 promise 拒绝 `knowledge-organize-idle-timeout`。activity observer 的 `touch` 是本 Task 唯一看门狗刷新入口，`noteError` 只记录首条模型错误、不刷新 idleDeadline。`noteSystemResume()` 即 `touch()`，不把休眠跳变算成空闲。
- 批次 `finally` 顺序固定：`await handle.dispose()` → `closeOrganizeBatch`（若已 open）并完成唯一一次事件/失败计次 → 注销 activity touch、`activeAgentByKb` 与旧 cancelReason → 清理 `deps.sessionModels` / `sessionRoots` / `sessionToolAllow` 与附件 → `removeSessionFilesById(sessionsRoot, [sessionId])` → `clearOrganizerPhase` → `releaseAndDrain(sessionId)` → 删除 `inFlightOrganizeByKb` 键 → 武装纯墓碑退避或安排下一批评估。写者已被抢占移除时，`scheduler.release` 是幂等 no-op，不会二次扣减；`releaseAndDrain` 仍然继续 `drainUserQueue`。任何一步抛错都由外层 finally 继续执行剩余清理，不能因 close/事件写失败跳过 release。
- 空批次（无到期文档且无墓碑）直接返回，不调用模型。
- 纯墓碑批比较本批开始与结束时的墓碑集合，以实际删除数判断进展；零进展次数和重试计时器只住 organizer 内存，禁止写入 `documents` / `organize_tombstones` 或新增存储列。批次 `finally` 释放全局名额后才按次数武装 60 秒 / 300 秒计时器，第 3 次不武装；到点必须走统一 `scheduleEvaluate` → `admitKbOrganize`，不得直接 `create`。复位时先取消旧计时器再清零；`scheduleEvaluate` 只有权威待整理快照真的新增文档或墓碑集合变化时才复位，空对账不得续命。回调执行前复核 disposing、维护/删除门闩与库存活，取消或退场后不得启动 Agent。
- 提示词包含「先改 INDEX.md / topics/，再清墓碑」。
- 事件用 `appendKnowledgeEvent`；相位只经 Host/SyncEngine 新方法。`sync-engine.ts` 把 `isOrganizerPhase` 作为四个值的类型守卫，`settlePhase` 在 `needsRecovery` 之外也对这四个值直接保留；同一守卫加到 `pauseWatch`（`sync-engine.ts:1329,1340`）与 `resumeWatch`（`:1349`）——这三处现状只挡 `needsRecovery`，不挡整理相位，用户在整理中切换「暂停监听」会把 `organizing` 刷成 `watch-paused`/`watching`（显示一致性，不影响结算）。`setOrganizerPhase` / `clearOrganizerPhase` 按 Interfaces 的 live/维护/recovery 规则实现。`host.ts` 只做委托，不复制状态机。不注册 WS 推送。

- [ ] **Step 4: 运行测试与类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-organizer.spec.ts tests/huaanwork-host/knowledge-organizer-phase.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/organizer.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/types.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-organizer.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-organizer-phase.spec.ts
git commit -m "feat(knowledge): add single-slot organizer runner with backoff, model check, and slot lifecycle lock"
```

---

### Task 6: 整合 `organizer` 进 `KnowledgeHost`、接线 `index.ts` 与 M1-2 完整门禁

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts`（对账成功后调用 `onIndexCommitted`；没有 `onStage1Completed`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts`（把已有 `KnowledgeOrganizerHooks` 接到 organizer；`dispose()` 已并行调用 `cancelAll`，不要再写一套退场）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`（`setKnowledgeHost`、`setReevaluateKbOrganize`、登记 id getter、`releaseAndDrain`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-organizer-integration.spec.ts`

**Interfaces:**
- `KnowledgeSyncEngineOptions` 新增 `onIndexCommitted?: (kbId: string) => void`；Host 构造 engine 时委托 `organizerHooks?.notifyPending?.(kbId)`。
- Task 6 只消费 Task 5 的 `KnowledgeOrganizer` 与 Task 1 的 provider/activity 注册器，不再定义另一套批次、相位或取消类型。
- `host.setOrganizerHooks` 的 `notifyPending(kbId)` 忽略参数用于定位来源，但排期必须调用无参全局 `scheduleEvaluate()`，不得只扫描这个 kbId。

- [ ] **Step 1: 写自动整理主链路、维护后排期、取消退场与生产相位/心跳失败测试**

覆盖：
1. 新建库放 2 份文本 → 阶段 1 对账成功后自动调度阶段 2 → 整理工具产出 `wiki/docs/<docId>.md` 并推进 `organized_sha256`。无头：不调用真实模型，但也不再以“替代整个 agent 的脚本”绕过驱动接口。fake `AgentHandle.agent.followup` 收到固定指令后才依次调用 `kb_org_get_delta`、写入笔记、`kb_org_mark_organized`，随后 resolve `whenIdle`；断言 followup/whenIdle/dispose 各一次。设置里放一条非空 `active_model_id`，并让网络预检通过。**G-I1 判别性断言**：经真实 `host.create` 建库、不触发任何 wiki reset；fake 不创建 `wiki/` 根（`docs/` 与笔记文件按上游 `write` 的行为由 fake 补建）；在 `createAgent` 桩内断言 `existsSync(wikiRoot) === true`，并用真实 `preExecuteExplained({ name: 'write', args: { file_path: 'docs/<docId>.md' }, workspaceRoot: wikiRoot }, 'ask')`（`decide.ts:61`）断言 `decision === 'allow'`；同一调用对一个未创建 `wiki/` 的对照库根必须得 `deny`（`REASON_PATH_ESCAPE`），证明该断言对「 organizer 不建 wiki/」有区分力，而不是被夹具自建目录掩盖；
2. 防抖、周期、启动、手动 `sync`、恢复、重绑这六种 trigger 在对账真正完成时都走到同一个 `onIndexCommitted`。失败对账、以及 epoch 失效后的中途返回不调用。`notifyPending` 调用无参 `scheduleEvaluate()`，不把扫描范围收成单个 kbId；
3. 整理进行中触发 `rebuild` 或 `remove` → 钩子以 `maintenance` 取消、`await inFlightOrganizeByKb`、不计入 `organize_attempts`、无 `SessionAlreadyExistsError`；
4. 整理回合卡死时 Host `dispose()` 发出已有的 `cancelAll`（映射为 `dispose`），在途回合结算，并且 1 秒内返回。只断言耗时不够：`dispose` 有 950 ms 的 `Promise.race`，取消没发出也会变绿。
5. **提交后排期**：人为让 create 的启动对账在注册表 commit 前完成，最终仍必须因 create 成功后的补偿通知整理一次。重绑时 `reconcileInner` 的回调发生在维护中，organizer 第一次 skip；`host.update` 成功且 `maintainingIds` 删除后必须再通知并真正整理。rebuild 成功同样只在维护锁释放后通知，spy 执行时 `listOrganizeCandidates` 必须已包含该库；失败 rebuild、epoch 失效、`wiki-reset-pending`/`index-error` 不得通知。
6. **生产相位与心跳接线**：真实 Host list 能依次观察到 waiting/organizing/blocked 相位并在 clear 后恢复；fake timer 超过 timeout 但 bridge 持续 note 活动时回合不取消，UI emit 仍为零。`onSystemResume` 必须实际调用 organizer `noteSystemResume`，退订后不再调用。

本计划不跑规格 §11.2 真机项。源目录拖入、防抖、重命名和暂停后移动目录是 M1-1 已交付行为。维护页、composer 与引用预览的真机检查随 M1-3。打包应用里的整理槽端到端观察随发布验收。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-organizer-integration.spec.ts
```
Expected: FAIL。

- [ ] **Step 3: 完成 `sync-engine.ts`、`host.ts` 与 `index.ts` 接线**

- 在 `reconcileInner` 确认 epoch 仍 live、写完事件并 `settlePhase` 之后调用 `onIndexCommitted(kbId)`。函数中途因 epoch 失效或未 live 而 return 的路径不调用，`reconcile()` 的 `catch` 也不调用。`startup` / `debounce` / `periodic` / `manual` / `resume` / `rebind` 都经过这一处。没有 `onStage1Completed`。`host.sync` 不是唯一入口。
- `host.ts` 补三个不能依赖统一对账回调的成功出口：`createInner` 在注册表 commit 成功后通知；`update` 用 `rebindSucceeded` / `updateSucceeded` 标志，在 finally 的 `maintainingIds.delete(kbId)` 之后仅对成功重绑通知；`rebuild` 在 `maintainingIds` finally 结束、`refreshStats` 完成后通知，且当前相位不是 `wiki-reset-pending` / `index-error`。通知统一为 `organizerHooks?.notifyPending?.(kbId)`，失败路径不调用。重绑在 `reconcileInner` 内已发的一次通知可以因维护被 skip，不得因此省略解锁后的补偿通知。
- `setOrganizerHooks`：`cancelForKb` 转成 `organizer.cancelForKb(kbId, 'maintenance')`，`cancelAll` 直接委托 `organizer.cancelAll()`（内部映射 dispose 并清全部退避计时器），`notifyPending` 用 `void organizer.scheduleEvaluate().catch(log)` 做全局评估。`host.dispose` 里已有的 `hooks.cancelAll()` 并行任务保持不动。
- knowledge effect 在 `start()` 前创建 organizer、注册 host/ref/provider 并订阅 resume；保留 M1-1 已有 desktopRuntime/powerMonitor 订阅。tools effect 仍在其后注册，执行工具时再 `getKnowledgeHost()`：

```ts
const organizer = createKnowledgeOrganizer({
  profileDir: config.profileDir,
  dshHome: config.dshHome,
  host: knowledgeHost,
  scheduler: ctx.huaanworkTurnScheduler,
  sessionRoots: ctx.huaanworkSessionRoots,
  sessionToolAllow: ctx.huaanworkSessionToolAllow,
  sessionModels: ctx.huaanworkSessionModels,
  attachments: ctx.huaanworkAttachments,
  createAgent: options => ctx.agents.create(options),
  releaseSlot: sessionId => releaseAndDrain(ctx, routeCtx, sessionId),
  now: () => Date.now(),
  timeoutMs: () =>
    readHuaanworkSettingsSync(config.profileDir).automation_timeout_ms,
})
const unregisterKnowledgeHost = setKnowledgeHost(knowledgeHost)
const unregisterKnowledgeIds = setRegisteredKnowledgeBaseIdsProvider(
  () => knowledgeHost.getRegisteredKnowledgeBaseIds(),
)
const unsubscribeOrganizerResume = knowledgeHost.onSystemResume(
  organizer.noteSystemResume,
)
knowledgeHost.setOrganizerHooks({
  cancelForKb: kbId => organizer.cancelForKb(kbId, 'maintenance'),
  cancelAll: () => organizer.cancelAll(),
  notifyPending: () => {
    void organizer.scheduleEvaluate().catch(error =>
      routeCtx.logger(`[knowledge] organize evaluation failed: ${String(error)}`),
    )
  },
})
```

knowledge disposer 先 `unsubscribeOrganizerResume`，再用两个带所有权校验的 disposer 注销 provider/host-ref，最后 `await knowledgeHost.dispose()`；退场整体仍是 tools effect 先注销 `kb_org_*`，随后 knowledge effect dispose host。
- `setReevaluateKbOrganize(() => { void organizer.scheduleEvaluate().catch(error => routeCtx.logger('[knowledge] organize evaluation failed: ' + String(error))) })` 接在 `drainUserQueue` 里自动化评估之后；knowledge disposer 在 host dispose 后恢复 undefined。整理结束使用 `releaseAndDrain`。

- [ ] **Step 4: 运行组合测试与完整 `corepack yarn check` 门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/knowledge-organizer-integration.spec.ts
corepack yarn check
```
Expected: 全部 PASS（0 失败，路由总数仍为 92）。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/knowledge/sync-engine.ts dsh-plugin-huaanwork/src/huaanwork-host/knowledge/host.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/tests/huaanwork-host/knowledge-organizer-integration.spec.ts
git commit -m "feat(knowledge): wire M1-2 single-slot organizer into knowledge host and turn scheduler"
```
