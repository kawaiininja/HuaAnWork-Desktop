# Expert Team Multi-Agent Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HuaAnWork 桌面端交付可创建、配置和通过 `@team:<slug>` 调用的专家团，由主会话团长真实派发独立智能体包成员，完成受控调度、审查返修、聚合状态和统一 Artifact/会话交付。

**Architecture:** 团队定义按 profile 原子持久化，团队运行采用有界内存投影。主会话通过附件-only 的 `expert_team_dispatch` 调用桌面 Host 协调器，成员经团队专用包派发路径以 `delivery: 'caller'` 返回文本；会话事件在当前 `turn/end` 同步封闭并结算，`afterIdle` 仅清理，主 Artifact 复用 `result_present` 与既有 tool-call 幂等。

**Tech Stack:** TypeScript、React、Vitest、Cordis、DeepSeek Harness subagent、既有 HuaAnWork Host/RPC/Artifact/子智能体运行投影、Electron（仅真机验收）。

**Spec:** `docs/superpowers/specs/2026-11-21-expert-team-design.md`

**Baseline:** 外层代码基线 `ed823cde6614a090ddacac1a4f934d1652ffb332`，上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`；设计基线为上述代码加已通过评审的规格。旧行号仅用于定位，实施时以符号和测试为准。

**Review status:** 已按规格、源码基线与第三轮独立反证复核完成修订（含 owner 裁定：旧 `@` 保留任意位置触发）；待实施。所有实现、门禁和真机验收复选框均未完成。

## Global Constraints

- 产品实现只进入 `dsh-plugin-huaanwork/` 与必要的桌面自有共享包 `packages/huaanwork-policy/`；不得修改 `deepseek-harness/`，不得调整子模块 pin，不引入 experimental `agent-team`，不改变普通 `@智能体` 的既有语义。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0` 与 Corepack Yarn `4.18.0`。本计划不新增运行时依赖，不修改锁文件。
- 团队规模为 2–8 名成员；并发上限为 1–4，默认 2；每次运行最多 24 次派工工具调用；每次派工输入（`task`、渲染后的引用结果、成员职责和输出要求，不含包 `persona`）最多 256 KiB UTF-8；成员包 `persona` 沿用其独立 64 KiB 上限。
- 成员仅允许本地创建及已安装启用的智能体包（消费 `AgentPackageHost.listWithLegacy().packages`），严禁企业目录 legacy 智能体或工具条目入团；成员沿用包原生工具、模型、工作区根、沙箱和委派深度，不得增加团队级只读/写入配置，不得修改上游 allowlist 或包血缘限制。
- 不使用上游 `outputSchema` / `structured_output`。成员输出仅拼接 text 块，忽略 reasoning；其它非文本负载报 `unsupported-output`，无有效文本报 `empty-output`。
- `expert_team_dispatch` 全局注册但只在团队回合按附件与租约可见，必须同时接入 `model.ts` 的 `isRegisteredToolName`（放行真实 SSE/文本协议工具调用）、`SESSION_ATTACHED_TOOLS` 和 `decide.ts` 的显式“挂载即允许、未挂载即拒绝”分支；不得加入全局 `ALLOWED_TOOLS`。
- 普通包派发的 `dispatch()` 签名、`pendingTurns`、`delivery: 'parent'`、MCP 工具名和 `afterIdle` 行为保持不变；团队路径独立使用 `reservedChildId`、请求 Map、MCP 命名、caller 结果、`activeTurns` 登记与单成员即时清理。
- 团队运行不持久化：每父会话最多 20 条终态、全局最多 100 条终态；Host 重启后只保留既有会话消息与 Artifact 卡，不重建团队卡或审查链。
- 回合锚使用同一个 `resolveFollowupClientMessageId(params)` 结果，只计算一次；`TurnScheduler` 队列项必须保留 `at.kind: 'expert-team'`，严禁排队出队后回退成普通 `@<slug>`。上游事件顺序为 `turn/start` 先于 `agent/inbox/claimed`，观察器必须从 `agent/inbox/claimed` 载荷读取 `turn`，并在当前 `turn/end` 同步封闭派工并结算；取消按 `stopping → stopped` 异步收敛，团队分支跳过 `cleanup` 第二次 `whenIdle()`。
- 主 Artifact 只由父会话 `result_present` 生产，继续使用 `{ kind: 'tool', callId }` 幂等；不得新增 `expert_team_finish`、`teamRunId` Artifact 幂等域、finish 指纹或模型自报 outcome。`index.ts` 的 `toolCtx` 必须显式透传团队 holder，确保生产接线生效。
- 仅会话模式的最终汇总只统计本轮最后 `tool/result` 后的助手 text，忽略 reasoning；不得新增生产 `snapshotEvents()` 调用。
- 所有跨模块身份使用稳定 ID，不使用显示名称；模型派工不传 `teamRunId`，Host 从父会话、租约、回合锚与工具 `callId` 绑定唯一活动运行并记录 `dispatchId`。
- 修改 `styles.css` 后运行 `corepack yarn workspace dsh-plugin-huaanwork gen:styles`。
- 所有命令在仓库根执行；每个任务先写失败测试再实现并提交。最终运行 `corepack yarn check`，不得与其他含 `verify:aa` 的命令并发。
- 中文输入法、真实取消清理、Host 重启、Artifact 预览下载和包原生沙箱体验必须真机验收，不得用单元测试冒充真机结论。

---

## Delivery Order

1. 团队契约、定义存储与 CRUD/可用性 RPC。
2. 内存运行注册表、输出与调度纯函数。
3. 包运行时隔离、caller 派发、协调器和工具策略。
4. 会话启动、事件观察、turn/end 结算与 Artifact 交付。
5. 客户端契约、管理页、`@team` 和运行卡。
6. 真实组合测试、完整门禁与真机验收。

---

### Task 1: 专家团契约、默认值、校验与中文检索

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamsLogic.spec.ts`
- Test fixture: `dsh-plugin-huaanwork/tests/fixtures/expert-team/team.ts`

**Interfaces:**
- Produces: `ExpertTeam`、`ExpertTeamMember`、`ExpertTeamAgentRef`、`ExpertTeamValidationResult`。
- Produces: `defaultExpertTeamRules(members)`、`validateExpertTeam(value: unknown)`、`effectiveTeamMaxParallel(team)`、`atExpertTeams(items, query)`。
- Produces test fixtures: `validTeamInput(overrides?)`、`validTeam()`、`executeResult(resultId, overrides?)`、`artifact(overrides?)`，供后续 Host/客户端测试共享，不在各任务复制不同形状的团队对象。
- Consumes: 无；Host 定义存储和客户端编辑器共用这些纯函数，不在 Host 另写一套默认值或字段规则。

- [ ] **Step 1: 写字段、默认值、成员约束和中文检索失败测试**

```ts
import { describe, expect, it } from 'vitest'
import type { ExpertTeam } from '../../src/client-huaanwork/rpc-types.ts'
import { validTeamInput } from '../fixtures/expert-team/team.ts'
import {
  atExpertTeams,
  defaultExpertTeamRules,
  effectiveTeamMaxParallel,
  validateExpertTeam,
} from '../../src/client-huaanwork/logic/expertTeamsLogic.ts'

const validTeam = (): ExpertTeam => validTeamInput()

describe('expert team contract', () => {
  it('provides spec defaults and validates a complete team', () => {
    expect(defaultExpertTeamRules(validTeam().members)).toEqual({
      orchestration: { assignmentMode: 'by-responsibility', executionOrder: 'parallel', maxParallel: 2 },
      review: { mode: 'unified', maxRevisionRounds: 1 },
      summary: { delivery: 'artifact', artifactFormat: 'markdown', mode: 'integrated' },
    })
    expect(defaultExpertTeamRules([]).review.mode).toBe('none')
    expect(validateExpertTeam(validTeam())).toMatchObject({ ok: true })
  })

  it('rejects duplicate agents and reviewer-less review modes', () => {
    const duplicate = validTeam()
    duplicate.members[1]!.agentRef = duplicate.members[0]!.agentRef
    expect(validateExpertTeam(duplicate)).toMatchObject({ ok: false, errors: { members: expect.any(String) } })
    const noReviewer = validTeam()
    noReviewer.members = [noReviewer.members[0]!]
    noReviewer.members.push({ ...noReviewer.members[0]!, memberId: crypto.randomUUID(), agentRef: { source: 'local', slug: 'writer-2' } })
    expect(validateExpertTeam(noReviewer)).toMatchObject({ ok: false, errors: { review: expect.any(String) } })
  })

  it('forces effective concurrency to one for sequential execution', () => {
    const team = validTeam()
    team.orchestration.executionOrder = 'sequential'
    team.orchestration.maxParallel = 4
    expect(effectiveTeamMaxParallel(team)).toBe(1)
  })

  it('searches Chinese names, scenarios, descriptions and slugs', () => {
    const team = validTeam()
    expect(atExpertTeams([team], '合规')).toHaveLength(1)
    expect(atExpertTeams([team], '条款复核')).toHaveLength(1)
    expect(atExpertTeams([team], 'compliance-team')).toHaveLength(1)
    expect(atExpertTeams([team], '不存在')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 确认测试因模块缺失失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/expertTeamsLogic.spec.ts
```
Expected: FAIL，`expertTeamsLogic.ts` 不存在。

- [ ] **Step 3: 定义共享类型与纯函数**

`rpc-types.ts` 增加与规格 §8.1/§8.2 完全一致的 `ExpertTeam` 和 `ExpertTeamMember`，包括 `orchestration.assignmentMode/executionOrder/maxParallel/instructions`、`review.mode/criteria/maxRevisionRounds`、`summary.delivery/artifactFormat/mode/instructions`，不要加入 `workspaceAccess` 或派工 `access`。

`expertTeamsLogic.ts` 导出：

```ts
export type ExpertTeamValidationResult =
  | { ok: true; team: ExpertTeam }
  | { ok: false; errors: Partial<Record<'slug' | 'name' | 'description' | 'scenarios' | 'members' | 'orchestration' | 'review' | 'summary', string>> }

export function defaultExpertTeamRules(members: readonly ExpertTeamMember[]): Pick<ExpertTeam, 'orchestration' | 'review' | 'summary'> {
  return {
    orchestration: { assignmentMode: 'by-responsibility', executionOrder: 'parallel', maxParallel: 2 },
    review: { mode: members.some((member) => member.role === 'reviewer') ? 'unified' : 'none', maxRevisionRounds: 1 },
    summary: { delivery: 'artifact', artifactFormat: 'markdown', mode: 'integrated' },
  }
}

export function effectiveTeamMaxParallel(team: ExpertTeam): 1 | 2 | 3 | 4 {
  return team.orchestration.executionOrder === 'sequential' ? 1 : team.orchestration.maxParallel
}
```

`tests/fixtures/expert-team/team.ts` 定义唯一测试对象源（每次调用均返回**全新克隆对象**，防止用例原地修改串染；可选属性遵守 `exactOptionalPropertyTypes: true`，不写入显式 `undefined`）：
- `validTeamInput(overrides = {})` 默认返回完整 `ExpertTeam`：`slug: 'compliance-team'`、`name: '合规审查小分队'`、`description: '审查合同与业务合规条款'`、`scenarios: '合同条款复核'`、`enabled: true`，两名不同成员（`{ memberId: 'm-exec-1', agentRef: { source: 'local', slug: 'writer' }, role: 'executor', responsibility: '提取合同关键条款并起草结论' }` 与 `{ memberId: 'm-rev-1', agentRef: { source: 'local', slug: 'reviewer' }, role: 'reviewer', responsibility: '统一合规审查并指出风险项' }`），规则字段取 `defaultExpertTeamRules(members)` 默认值，并仅在 `overrides` 显式给出时覆盖对应字段；`validTeam()` 是无覆盖别名（同样每次返回新对象）。
- `executeResult(resultId, overrides = {})` 返回全新 `ExpertTeamResult`（默认 `memberId: 'm-exec-1'`、`agentRef: { source: 'local', slug: 'writer' }`、`packageVersion: '1.0.0'`、`kind: 'execute'`、`status: 'completed'`、`output: '有效文本'`、`inputResultIds: []`），支持覆盖 `memberId`/`status`/`kind`/`supersedesResultId`/`reviewVerdict`/`reviewError`/`error` 等字段。
- `artifact(overrides = {})` 返回带 `artifactId/sessionId/title/format/downloadName/sizeBytes/sha256/createdAt/anchor` 的全新 `TaskArtifactSummary`，默认锚为 `{ kind: 'turn', clientMessageId: 'm1' }`。

后续任务统一从这些导出构造 fixture，不再复制不同默认对象。

`validateExpertTeam` 必须在不可信 JSON 边界逐项检查：`schemaVersion === 1`；`slug` 为 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且 1–32；`name` 1–40、`description` 1–200、`scenarios/instructions/criteria` 各自不超过 500；`enabled` 为布尔值；成员 2–8、`memberId` 非空且团内唯一、`agentRef.source` 只能 `'local' | 'catalog'` 且 `source + slug` 去重、`role` 只能 `'executor' | 'reviewer'`、至少一名 executor、`responsibility` 非空白；`orchestration.assignmentMode`（`by-responsibility | broadcast`）、`executionOrder`（`sequential | parallel | dynamic`）、`maxParallel`（`1 | 2 | 3 | 4`）；`review.mode`（`none | unified | per-member`）非 `none` 时至少一名 reviewer、无 reviewer 时只能 `none`、`maxRevisionRounds` 只能 `0 | 1 | 2`；`summary.delivery`（`artifact | message`）、`artifactFormat`（`markdown | html`）、`mode`（`integrated | by-member | integrated-with-appendix`）。非法输入返回字段错误，不抛未本地化异常，不静默修复后通过。

注意：`expertTeamsLogic.ts` 会被 Host（`tsconfig.json`，开启 `exactOptionalPropertyTypes: true` 与 `noUncheckedIndexedAccess: true`）导入，实现不得向可选属性显式写入 `undefined`，并处理索引访问收窄。

`atExpertTeams` 对 query 做 `trim().toLocaleLowerCase()`，逐项匹配 `name/slug/description/scenarios ?? ''`，保持原顺序且只返回匹配项。

- [ ] **Step 4: 运行契约测试与双端类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/expertTeamsLogic.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.json --noEmit
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.client.json --noEmit
```
Expected: 全部 PASS；Host 严格模式与客户端类型检查均无错误。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamsLogic.spec.ts dsh-plugin-huaanwork/tests/fixtures/expert-team/team.ts
git commit -m "feat(expert-team): add team contract and validation"
```

---

### Task 2: 团队定义的原子持久化

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/types.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-store.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `ExpertTeam`、`validateExpertTeam`；既有 `dsh-plugin-huaanwork/src/huaanwork-host/workspace-state.ts` 已导出的 `assertSafePathSegment`（直接复用，不在契约模块重复实现）。
- Produces: `ExpertTeamRecord = { id: string; team?: ExpertTeam; error?: 'expert-team-corrupt' }`、`ExpertTeamStore`。
- Produces: `createExpertTeamStore(profileDir, options?: { now?: () => string }): ExpertTeamStore`，支持 `list/get/create/update/setEnabled/remove`；活动运行删除保护与新建成员有效性校验由 Task 4 路由层执行。

- [ ] **Step 1: 写持久化、slug 唯一、路径段校验和损坏隔离失败测试**

```ts
it('persists definitions atomically and preserves slug identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'expert-team-store-'))
  let tick = 1
  const store = createExpertTeamStore(root, { now: () => new Date(1_700_000_000_000 + (tick++ * 1000)).toISOString() })
  const created = await store.create(validTeamInput({ slug: 'compliance' }))
  expect(readFileSync(join(root, 'expert-teams', `${created.id}.json`), 'utf8')).toContain('"slug": "compliance"')
  await expect(store.create(validTeamInput({ slug: 'compliance' }))).rejects.toThrow('expert-team-slug-exists')
  const updated = await store.update(created.id, { name: '新名称' })
  expect(updated).toMatchObject({ id: created.id, slug: 'compliance', name: '新名称', createdAt: created.createdAt })
  expect(updated.updatedAt).not.toBe(created.updatedAt)
  await store.setEnabled(created.id, false)
  expect((await store.get(created.id)).team?.enabled).toBe(false)
})

it('fails closed for one corrupt file without hiding other teams or losing its id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'expert-team-corrupt-'))
  const store = createExpertTeamStore(root)
  const good = await store.create(validTeamInput({ slug: 'good' }))
  const corrupt = await store.create(validTeamInput({ slug: 'corrupt' }))
  const corruptPath = join(root, 'expert-teams', `${corrupt.id}.json`)
  writeFileSync(corruptPath, '{not-json')
  expect(await store.get(corrupt.id)).toEqual({ id: corrupt.id, error: 'expert-team-corrupt' })
  expect((await store.list()).find((record) => record.id === corrupt.id)?.error).toBe('expert-team-corrupt')
  expect((await store.list()).find((record) => record.team?.id === good.id)?.team?.slug).toBe('good')
  expect(readFileSync(corruptPath, 'utf8')).toBe('{not-json')
  await expect(store.update(corrupt.id, { name: '覆盖损坏文件' })).rejects.toThrow('expert-team-corrupt')
  await expect(store.get('../escape')).rejects.toThrow()
})

it('isolates team definitions across separate profile directories', async () => {
  const profileA = mkdtempSync(join(tmpdir(), 'expert-team-prof-a-'))
  const profileB = mkdtempSync(join(tmpdir(), 'expert-team-prof-b-'))
  const storeA = createExpertTeamStore(profileA)
  const storeB = createExpertTeamStore(profileB)
  const created = await storeA.create(validTeamInput({ slug: 'prof-a-only' }))
  expect((await storeA.list()).map((record) => record.team?.slug)).toEqual(['prof-a-only'])
  expect(await storeB.list()).toEqual([])
  await expect(storeB.get(created.id)).rejects.toThrow('expert-team-not-found')
})
```

另用 `readdirSync(expertTeamsRoot)` 断言写入后没有 `.tmp-` 或 `.old-` 残留；损坏记录可经 `store.remove(corrupt.id)` 删除；删除只移除目标 JSON，不删除 `agents/`、会话或 Artifact 目录。

- [ ] **Step 2: 确认存储测试失败**

`validTeamInput` 直接导入 Task 1 的共享 fixture，不另建缺字段对象；`validTeamInput({slug})` 仅覆盖 slug，其余成员、调度和交付字段保持完整。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-store.spec.ts
```
Expected: FAIL，`expert-team/store.ts` 不存在。

- [ ] **Step 3: 实现按 profile 隔离的原子 store**

`types.ts` 只 re-export Task 1 契约并声明：

```ts
export type ExpertTeamRecord = { id: string; team?: ExpertTeam; error?: 'expert-team-corrupt' }
export type ExpertTeamStore = {
  list(): Promise<ExpertTeamRecord[]>
  get(id: string): Promise<ExpertTeamRecord>
  create(input: unknown): Promise<ExpertTeam>
  update(id: string, patch: unknown): Promise<ExpertTeam>
  setEnabled(id: string, enabled: boolean): Promise<ExpertTeam>
  remove(id: string): Promise<void>
}
```

`store.ts` 将每个定义保存为 `<profileDir>/expert-teams/<id>.json`。所有按 `id` 读写的入口必须先经 `assertSafePathSegment(id, 'teamId')` 校验，拒绝路径穿越。创建时生成 `id = randomUUID()`、校验完整定义并检查所有有效文件的 slug 唯一；更新只允许规格可编辑字段，保留 `id/slug/createdAt` 并刷新 `updatedAt`（支持注入 `now` 时钟避免同毫秒测试脆弱性）。写入采用同目录 `.tmp-<uuid>` 完整写入、`renameSync` 替换；启动加载不恢复临时文件，也不自动覆盖损坏原文件。`list/get` 将单个损坏定义映射为 `{ id, error: 'expert-team-corrupt' }`，保留文件 `id` 供列表展示和显式删除，其它文件照常返回。

- [ ] **Step 4: 运行存储测试与 Host 类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-store.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
```
Expected: 全部 PASS；无临时文件残留或类型错误。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/store.ts dsh-plugin-huaanwork/src/huaanwork-host/expert-team/types.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-store.spec.ts
git commit -m "feat(expert-team): persist team definitions"
```

---

### Task 3: 有界内存团队运行注册表

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/runs.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-runs.spec.ts`

**Interfaces:**
- Consumes: `ExpertTeam`、`TaskArtifactSummary`、既有 `RpcEvent`。
- Produces: `ExpertTeamRun`、`ExpertTeamResult`、`ExpertTeamRunSnapshot`、`ExpertTeamCancelResult`、`ExpertTeamRunNotFoundError`、`ExpertTeamRunRegistry`。
- Produces: `begin/get/activeBySession/byTurn/list/update/hasActive/hasActiveForSession/attachCancel/requestCancel/cancelBySession/cancelAll/markStopped/sealDelivery/noteSessionArtifact/noteArtifactLinkError`；不写磁盘，事件只含摘要和运行文本结果，不含 Artifact 正文。

- [ ] **Step 1: 写 generation/revision、淘汰、异步取消收敛与 Artifact 关联失败测试**

```ts
it('projects generation and monotonic revision with bounded terminal history', () => {
  const events: RpcEvent[] = []
  const registry = createExpertTeamRunRegistry({ generation: 'g1', terminalPerParent: 1, terminalGlobal: 2, emit: (event) => events.push(event) })
  const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
  expect(registry.list({ sessionId: 's1' })).toMatchObject({ generation: 'g1', revision: 1, runs: [{ teamRunId: run.teamRunId, revision: 1 }] })
  registry.update(run.teamRunId, (current) => { current.dispatchAttempts = 1 })
  expect(events.at(-1)).toMatchObject({ event: 'expertTeam/run', generation: 'g1', run: { revision: 2, dispatchAttempts: 1 } })
  registry.update(run.teamRunId, (current) => { current.status = 'completed'; current.endedAt = new Date(0).toISOString() })
  const second = registry.begin({ parentSessionId: 's1', clientMessageId: 'm2', teamSnapshot: validTeam() })
  registry.update(second.teamRunId, (current) => { current.status = 'failed'; current.endedAt = new Date(0).toISOString() })
  expect(registry.list({ sessionId: 's1' }).runs.map((item) => item.teamRunId)).toEqual([second.teamRunId])
  expect(events.some((event) => event.event === 'expertTeam/run-remove' && typeof event.revision === 'number')).toBe(true)
})

it('latches stopping immediately without blocking RPC, converges via markStopped, and associates matching persisted turn anchors', async () => {
  const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
  const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
  let calls = 0
  let releaseCancel!: () => void
  registry.attachCancel(run.teamRunId, () => {
    calls += 1
    return new Promise<void>((resolve) => { releaseCancel = resolve })
  })
  const first = registry.requestCancel('s1', run.teamRunId)
  const second = registry.requestCancel('s1', run.teamRunId)
  expect(first).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
  expect(second).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
  expect(calls).toBe(1)
  expect(registry.get(run.teamRunId)?.status).toBe('stopping')
  expect(registry.hasActive(run.teamId)).toBe(true)
  expect(registry.hasActiveForSession('s1')).toBe(true)
  releaseCancel()
  registry.markStopped(run.teamRunId)
  expect(registry.get(run.teamRunId)?.status).toBe('stopped')
  expect(registry.hasActive(run.teamId)).toBe(false)
  expect(registry.noteSessionArtifact('s1', 'call-1', artifact({ anchor: { kind: 'turn', clientMessageId: 'other' } }))).toBe(false)
  expect(registry.noteSessionArtifact('s1', 'call-1', artifact({ anchor: { kind: 'turn', clientMessageId: 'm1' } }))).toBe(false) // 未先 seal
  registry.sealDelivery(run.teamRunId, 'call-1')
  expect(registry.noteSessionArtifact('s1', 'call-1', artifact({ anchor: { kind: 'turn', clientMessageId: 'm1' } }))).toBe(true)
  expect(registry.get(run.teamRunId)).toMatchObject({ primaryArtifactCallId: 'call-1', artifactStatus: 'created', deliverySealed: true })
})

it('enforces default 20-per-parent and 100-global terminal eviction without evicting active runs, converges cancelAll, and isolates registries', async () => {
  const regA = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
  const regB = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
  // 单会话默认最多保留 20 条终态；活跃/stopping 不被淘汰
  const activeRun = regA.begin({ parentSessionId: 's-keep', clientMessageId: 'm-active', teamSnapshot: validTeam() })
  for (let i = 0; i < 21; i += 1) {
    const r = regA.begin({ parentSessionId: 's-keep', clientMessageId: `m-t-${i}`, teamSnapshot: validTeam() })
    regA.update(r.teamRunId, (cur) => { cur.status = 'completed'; cur.endedAt = new Date(i * 1000).toISOString() })
  }
  const keepRuns = regA.list({ sessionId: 's-keep' }).runs
  expect(keepRuns.some((item) => item.teamRunId === activeRun.teamRunId)).toBe(true)
  expect(keepRuns.filter((item) => item.status === 'completed')).toHaveLength(20)

  // 全局默认最多保留 100 条终态（跨 6 个会话合计 > 100 条终态）
  for (let s = 0; s < 5; s += 1) {
    for (let i = 0; i < 20; i += 1) {
      const r = regA.begin({ parentSessionId: `s-bulk-${s}`, clientMessageId: `m-${s}-${i}`, teamSnapshot: validTeam() })
      regA.update(r.teamRunId, (cur) => { cur.status = 'completed'; cur.endedAt = new Date((s * 20 + i + 100) * 1000).toISOString() })
    }
  }
  const allA = regA.list().runs
  expect(allA.filter((item) => item.status === 'completed')).toHaveLength(100)
  expect(allA.some((item) => item.teamRunId === activeRun.teamRunId)).toBe(true)
  // 不同 Host/profile 的 registry 投影严格隔离
  expect(regB.list().runs).toEqual([])

  // cancelAll 触发全部活跃/stopping 取消闭包并等待收敛
  const otherActive = regA.begin({ parentSessionId: 's-other', clientMessageId: 'm-other', teamSnapshot: validTeam() })
  const settled: string[] = []
  regA.attachCancel(activeRun.teamRunId, async () => { settled.push(activeRun.teamRunId) })
  regA.attachCancel(otherActive.teamRunId, async () => { settled.push(otherActive.teamRunId) })
  await regA.cancelAll()
  expect(settled).toEqual(expect.arrayContaining([activeRun.teamRunId, otherActive.teamRunId]))
  expect(regA.get(activeRun.teamRunId)?.status).toBe('stopping')
  expect(regA.get(otherActive.teamRunId)?.status).toBe('stopping')
})
```

- [ ] **Step 2: 确认注册表测试失败**

`validTeam()` 和 `artifact()` 均使用 Task 1 共享 fixture；`createExpertTeamRunRegistry` 的 `emit` 直接收集真实 RpcEvent，不伪造事件对象。取消闭包计数器只通过公开 `attachCancel` 注册。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-runs.spec.ts
```
Expected: FAIL，`expert-team/runs.ts` 不存在。

- [ ] **Step 3: 实现运行类型与有界 registry**

`rpc-types.ts` 按规格 §8.3/§8.4 增加 `ExpertTeamRun`（含可选 `artifactLinkError?: string` 以明确标记 commit 成功但关联失败的残态）、`ExpertTeamResult`、`ExpertTeamRunSnapshot = { generation: string; revision: number; runs: ExpertTeamRun[] }`、`ExpertTeamCancelResult = { status: 'accepted' | 'already-terminal'; teamRunId: string }`；同时在 `SubagentRunProjection` 上新增可选 `teamRunId?: string`（供 Task 7 标记团队成员 run、Task 16 防止主聊流重复渲染独立 `SubagentRunCard`）。新增事件：

```ts
| { event: 'expertTeam/changed'; teamId?: string }
| { event: 'expertTeam/run'; generation: string; run: ExpertTeamRun }
| { event: 'expertTeam/run-remove'; generation: string; revision: number; teamRunId: string; parentSessionId: string }
```

`ExpertTeamRunRegistry` 核心接口：

```ts
export class ExpertTeamRunNotFoundError extends Error {}
export interface ExpertTeamRunRegistry {
  begin(input: { parentSessionId: string; clientMessageId: string; teamSnapshot: ExpertTeam }): ExpertTeamRun
  get(teamRunId: string): ExpertTeamRun | undefined
  /** 仅返回当前 parentSessionId 仍处于 running 的唯一活动运行；不含 stopping/终态。 */
  activeBySession(parentSessionId: string): ExpertTeamRun | undefined
  /** 按父会话 + 持久回合锚精确查找未淘汰运行（含 stopping 与终态），供 result_present 与测试对账。 */
  byTurn(parentSessionId: string, clientMessageId: string): ExpertTeamRun | undefined
  list(input?: { sessionId?: string }): ExpertTeamRunSnapshot
  update(teamRunId: string, mutate: (run: ExpertTeamRun) => void): ExpertTeamRun
  /** running 或 stopping 均视为活跃，阻止团队删除或同会话第二次团队调用。 */
  hasActive(teamId: string): boolean
  hasActiveForSession(parentSessionId: string): boolean
  attachCancel(teamRunId: string, cancel: () => Promise<void>): void
  /** 同步置 stopping、触发取消闭包（最多一次）并立即返回，不阻塞 RPC 等待 600s 清理；未知/跨会话抛 NotFound。 */
  requestCancel(parentSessionId: string, teamRunId: string): ExpertTeamCancelResult
  /** 同步置 stopping 并触发该会话活跃运行的取消闭包（幂等，不抛未捕获 rejection）。 */
  cancelBySession(parentSessionId: string): Promise<void>
  /** Host teardown 专用：取消全部活跃/stopping 运行并等待其取消闭包收敛。 */
  cancelAll(): Promise<void>
  /** 在父回合与成员清理收敛后把 stopping 推进为 stopped（幂等，不覆盖已终态）。 */
  markStopped(teamRunId: string): ExpertTeamRun | undefined
  sealDelivery(teamRunId: string, callId: string): void
  noteSessionArtifact(parentSessionId: string, callId: string, artifact: TaskArtifactSummary): boolean
  noteArtifactLinkError(teamRunId: string, reason: string): void
}
```

默认 `terminalPerParent = 20`、`terminalGlobal = 100`，`running` 和 `stopping` 永不淘汰；全 registry 维护单调递增 `revision`（与 `subagent-runs.ts` 同构），`list()` 返回 `{ generation, revision, runs }`，`expertTeam/run-remove` 同样携带 `revision`。所有返回对象的调用方得到副本；每次 mutation 同步增加 `revision` 并 emit。`requestCancel` 同步置 `stopping` 并启动最多一次的后台取消闭包（复用同一 Promise，供 `afterIdle` / `cancelBySession` / `cancelAll` 等待），绝不在 RPC 句柄中无限阻塞至 180s 超时；终态收敛统一由 `afterIdle`（或清理确认点）调 `markStopped` 完成。`noteSessionArtifact` 扫描该父会话下所有未淘汰运行（含 `stopping`/`stopped` 以覆盖 commit 与取消竞态），要求 `artifact.anchor.kind === 'turn'`、锚中的 `clientMessageId` 与运行一致且已记录相同 `primaryArtifactCallId`；关联失败保持 `artifactStatus: 'pending'` 并由调用方记 `noteArtifactLinkError`，不抛“Artifact 未创建”的假错误；关联成功时写入 `primaryArtifactId`、`artifactStatus: 'created'` 并清除既有 `artifactLinkError`（覆盖首次关联失败后的同 `callId` 重放恢复）。

- [ ] **Step 4: 运行注册表测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-runs.spec.ts
```
Expected: PASS，覆盖默认上限、快照/移除 `revision`、非阻塞 `requestCancel` + `markStopped` 收敛、`cancelAll` 和持久锚匹配。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/expert-team/runs.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-runs.spec.ts
git commit -m "feat(expert-team): add bounded run registry"
```

---

### Task 4: 定义可用性、CRUD 与运行 RPC

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/availability.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team-routes.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`（在 `SessionRuntimeContext` 补充 `huaanworkExpertTeamStore?` 与 `huaanworkExpertTeamRuns?` 供 `requireRuntime(ctx)` 类型检查通过）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-routes.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`

**Interfaces:**
- Consumes: Task 2 store、Task 3 registry、`AgentPackageHost.listWithLegacy().packages`（`AgentPackageListItem[]`，严禁消费 `catalogAgents` 或 `AgentListItem[]`）及 `AgentPackageHost.detail(slug)`（提取包原生脚本/HTTP/MCP 能力摘要）。
- Produces: `ExpertTeamMemberCapabilities`、`ExpertTeamAvailability`、`resolveExpertTeamAvailability(record, packages, detailOf?)`、`expertTeamRoutes`。
- Produces RPC（9 条，路由总数由 83 增至 92）：
  - `expertTeam.list`：`GET /huaanwork/expert-team/list` → `{ teams, packages }`（`packages` 附带成员可选健康包的原生能力摘要）
  - `expertTeam.get`：`GET /huaanwork/expert-team/get`（query `id`）→ `{ id, team?, error?, availability }`
  - `expertTeam.create`：`POST /huaanwork/expert-team/create` → `{ ok: true; team } | { ok: false; fieldErrors }`
  - `expertTeam.update`：`POST /huaanwork/expert-team/update` → `{ ok: true; team } | { ok: false; fieldErrors }`
  - `expertTeam.setEnabled`：`POST /huaanwork/expert-team/setEnabled` → `{ ok: true; team }`
  - `expertTeam.remove`：`POST /huaanwork/expert-team/remove` → `{ removed: true }`
  - `expertTeam.invocableList`：`GET /huaanwork/expert-team/invocable` → `{ teams }`
  - `expertTeam.runList`：`GET /huaanwork/expert-team/run/list`（query `sessionId`）→ `{ generation, revision, runs }`
  - `expertTeam.cancel`：`POST /huaanwork/expert-team/cancel`（body `{ parentSessionId, teamRunId }`）→ `{ status, teamRunId }`
- Produces holders: `ctx.huaanworkExpertTeamStore`、`ctx.huaanworkExpertTeamRuns`。

- [ ] **Step 1: 写包本位可用性（拒绝 legacy/tool）、新建成员全量校验、活动删除保护与 92 路由契约失败测试**

```ts
it('computes availability exclusively from AgentPackageListItem and never accepts legacy agents', () => {
  const record = { id: 't1', team: validTeam() }
  const packages: AgentPackageListItem[] = [
    { slug: 'writer', displayName: '写手', source: 'local', enabled: true, version: '1.0.0', description: '' },
  ]
  const availability = resolveExpertTeamAvailability(record, packages)
  expect(availability).toMatchObject({ invocable: false, kind: 'member-invalid' })
  expect(availability.members.map((member) => member.reason)).toContain('expert-team-member-missing')
})

it('rejects creating a team with invalid/missing members, blocks deletion during active or stopping runs, and returns snapshot revision', async () => {
  const { runs, routes } = await makeExpertTeamRouteFixture()
  const missingMember = await routes.create({ body: validTeamInput({ members: [validTeam().members[0]!, { ...validTeam().members[1]!, agentRef: { source: 'catalog', slug: 'legacy-only' } }] }) })
  expect(missingMember).toMatchObject({ ok: false, fieldErrors: expect.arrayContaining([expect.objectContaining({ field: 'members' })]) })
  const created = await routes.create({ body: validTeamInput() })
  expect(created).toMatchObject({ ok: true, team: { slug: 'compliance-team' } })
  if (!created.ok) throw new Error('expected create to succeed')
  const { team } = created
  await expect(routes.remove({ body: { id: randomUUID() } })).rejects.toThrow('expert-team-not-found')
  const run = runs.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: team })
  await expect(routes.remove({ body: { id: team.id } })).rejects.toThrow('expert-team-active')
  expect(await routes.cancel({ body: { parentSessionId: 's1', teamRunId: run.teamRunId } })).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
  // stopping 期间仍禁止删除
  await expect(routes.remove({ body: { id: team.id } })).rejects.toThrow('expert-team-active')
  runs.markStopped(run.teamRunId)
  expect(await routes.runList({ query: new URLSearchParams({ sessionId: 's1' }) })).toMatchObject({
    generation: runs.list({ sessionId: 's1' }).generation,
    revision: expect.any(Number),
  })
  await expect(routes.remove({ body: { id: team.id } })).resolves.toEqual({ removed: true })
})
```

同时同步更新 `rpc-types.ts` 的 `RpcRequest['method']`、以及全部 4 个测试文件中共 6 处硬编码 `83` 路由总数的断言（`route-contract.spec.ts:424,425`、`routes.spec.ts:56,222`、`market-routes.spec.ts:236`、`api.spec.ts:165`）至 `92`，并逐项登记 `CLIENT_REQUIRED_KEYS`、`SERVER_EXPECTED_KEYS` 和 `OPTIONAL_KEYS_WHITELIST`；`agent.invocableList` 不作任何修改。

- [ ] **Step 2: 确认可用性与路由测试失败**

`makeExpertTeamRouteFixture` 使用临时 profile 的真实 store/registry 与提供两个健康智能体包（`writer` + `reviewer`）的 fake `AgentPackageHost`，并将 `expertTeamRoutes` handler 包装成调用器（`query` 使用真实 `URLSearchParams`）；`validTeamInput` 来自 Task 1 共享 fixture。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-routes.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/market-routes.spec.ts tests/client-huaanwork/api.spec.ts
```
Expected: FAIL，`availability.ts` 与 `expert-team-routes.ts` 不存在。

- [ ] **Step 3: 实现可用性和 RPC 装配**

```ts
export type ExpertTeamMemberCapabilities = {
  tools: 'none' | 'http' | 'mcp' | 'both'
  skillScripts: string[]
}
export type ExpertTeamAvailability = {
  kind: 'invocable' | 'disabled' | 'incomplete' | 'member-invalid'
  invocable: boolean
  reasons: string[]
  members: Array<{
    memberId: string
    displayName: string
    version?: string
    capabilities?: ExpertTeamMemberCapabilities
    reason?: string
  }>
}
```

`resolveExpertTeamAvailability` 先处理损坏（`record.error === 'expert-team-corrupt'` → `incomplete`）、定义校验与停用，再**只**从 `AgentPackageHost.listWithLegacy().packages`（`AgentPackageListItem[]`）按 `pkg.source === member.agentRef.source && pkg.slug === member.agentRef.slug` 精确匹配；严禁把 `catalogAgents`（企业目录 legacy 智能体）或 `AgentListItem` 混入输入，确保满足 R3。只有 `pkg.enabled === true && pkg.broken === undefined && pkg.revoked === undefined` 的包可用；匹配成功时可经 `detail(pkg.slug)` 附加 `capabilities`（`tools` 模式与 `skill?.scripts ?? []`），供客户端编辑器与保存前摘要展示。`invocableList` 只返回 `enabled && invocable` 的团队摘要。

`expert-team-routes.ts` 导出 `expertTeamRoutes`：
- `expertTeam.create`：校验定义字段并在写入前实时校验**所有成员均存在于 `packages` 且可用**（规格 §9.2），校验/重名失败返回 `{ ok: false, fieldErrors }` 供编辑器按字段回显；
- `expertTeam.update`：校验定义字段与不可变字段（保留 `id/slug/createdAt`），按规格 §9.2 允许在存在失效成员时保存其他字段，损坏原文件仍 fail-closed 拒绝；
- `expertTeam.remove`：先检查 `runs.hasActive(id)`（覆盖 `running` 与 `stopping`），再删 JSON（允许删除损坏定义），返回 `{ removed: true }`；
- CRUD 写成功后广播 `{ event: 'expertTeam/changed', teamId }`；
- `expertTeam.runList` 读取 `query.get('sessionId')` 并返回 `{ generation, revision, runs }`；
- `expertTeam.cancel` 只接受 `parentSessionId + teamRunId`，调用非阻塞 `runs.requestCancel`（未知/跨父会话映射为 `RouteError(404, 'expert-team-run-not-found', ...)`），不得按 slug 取消。

`holders.ts` 的类型、`HUAANWORK_CONTEXT_PROPS` 和 boot 初始化同步增加两个 holder；`sessions.ts` 的 `SessionRuntimeContext` 同步补充可选 `huaanworkExpertTeamStore?` 与 `huaanworkExpertTeamRuns?`（供 `expert-team-routes.ts` 经 `requireRuntime(ctx)` 强类型读取）；`index.ts` 创建一次 store/registry，运行期只 mutate，不重新给 ctx 属性赋值。`routes.ts` 将 `expertTeamRoutes` 加入 `ROUTE_TABLE`，`api.ts` 添加同名 9 条 `ROUTES`，`rpc-types.ts` 扩展 `RpcRequest['method']`。

- [ ] **Step 4: 运行路由与全部既有契约测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-routes.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/market-routes.spec.ts tests/client-huaanwork/api.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.json --noEmit
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.client.json --noEmit
```
Expected: 全部 PASS；92 条路由双端一致，既有路由含义不变。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/availability.ts dsh-plugin-huaanwork/src/huaanwork-host/expert-team-routes.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts
git commit -m "feat(expert-team): expose definition and run routes"
```

---

### Task 5: 成员文本与审查标记协议

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/text-protocol.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-text-protocol.spec.ts`

**Interfaces:**
- Consumes: 上游 `ContentBlock` 类型，不修改上游。
- Produces: `renderMemberOutput(blocks): MemberTextResult`、`parseReviewVerdict(text): { reviewVerdict?: 'pass' | 'revise'; reviewError?: 'invalid-verdict' }`。

- [ ] **Step 1: 写 reasoning、非文本负载与末行标记失败测试**

```ts
it('accepts reasoning metadata while rendering only text blocks', () => {
  expect(renderMemberOutput([
    { type: 'reasoning', text: '内部分析' },
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])).toEqual({ ok: true, text: '第一段\n\n第二段' })
  expect(renderMemberOutput([{ type: 'reasoning', text: '只有思考' }])).toEqual({ ok: false, error: 'empty-output' })
  expect(renderMemberOutput([{ type: 'text', text: ' \n' }])).toEqual({ ok: false, error: 'empty-output' })
})

it.each([
  [{ type: 'image', data: 'x' }],
  [{ type: 'file', name: 'a.txt' }],
  [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
  [{ type: 'future-block', value: true }],
])('rejects unsupported payload %j', (block) => {
  expect(renderMemberOutput([{ type: 'text', text: '正文' }, block as never])).toEqual({ ok: false, error: 'unsupported-output' })
})

it('parses only the exact final verdict line', () => {
  expect(parseReviewVerdict('依据\n[VERDICT: PASS]\n')).toEqual({ reviewVerdict: 'pass' })
  expect(parseReviewVerdict('依据\n[VERDICT: REVISE]')).toEqual({ reviewVerdict: 'revise' })
  expect(parseReviewVerdict('[VERDICT: PASS] extra')).toEqual({ reviewError: 'invalid-verdict' })
  expect(parseReviewVerdict('[VERDICT: PASS]\n没有标记')).toEqual({ reviewError: 'invalid-verdict' })
  expect(parseReviewVerdict('没有标记')).toEqual({ reviewError: 'invalid-verdict' })
})
```

- [ ] **Step 2: 确认协议测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-text-protocol.spec.ts
```
Expected: FAIL，`text-protocol.ts` 不存在。

- [ ] **Step 3: 实现严格文本提取与标记解析**

```ts
export type MemberTextResult = { ok: true; text: string } | { ok: false; error: 'empty-output' | 'unsupported-output' }

export function renderMemberOutput(blocks: readonly ContentBlock[]): MemberTextResult {
  const text: string[] = []
  for (const block of blocks) {
    if (block.type === 'reasoning') continue
    if (block.type !== 'text') return { ok: false, error: 'unsupported-output' }
    text.push(block.text)
  }
  const rendered = text.join('\n\n')
  return rendered.trim() === '' ? { ok: false, error: 'empty-output' } : { ok: true, text: rendered }
}

export function parseReviewVerdict(text: string) {
  const last = text.trim().split(/\r?\n/).at(-1)?.trim()
  if (last === '[VERDICT: PASS]') return { reviewVerdict: 'pass' as const }
  if (last === '[VERDICT: REVISE]') return { reviewVerdict: 'revise' as const }
  return { reviewError: 'invalid-verdict' as const }
}
```

未知块走 default 拒绝，不能因 TypeScript 联合未来扩展而被静默当作 reasoning。

- [ ] **Step 4: 运行协议测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-text-protocol.spec.ts
```
Expected: PASS，包括 `reasoning + text` 正常通过和纯 reasoning 空输出。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/text-protocol.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-text-protocol.spec.ts
git commit -m "feat(expert-team): parse member text and review verdicts"
```

---

### Task 6: 调度 scope、返修与终态纯函数

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-orchestration.spec.ts`

**Interfaces:**
- Consumes: Task 3 运行类型、Task 5 审查标记结果。
- Produces: `currentEffectiveResultIds`、`resolveReviewScope`、`assertReviewScopeCurrent`、`validateDispatchRule`、`canSubmitPrimaryArtifact`、`computeExpertTeamTerminalStatus`。

- [ ] **Step 1: 写 scope、失败替代、派工规则、返修周期、技术失败部分报告和预算豁免失败测试**

```ts
it('resolves unified scope at entry and rejects empty/subset/stale scopes', () => {
  const run = runWithResults([executeResult('r1'), executeResult('r2')])
  expect(resolveReviewScope(run, { kind: 'review', memberId: 'reviewer' })).toEqual({ ok: true, inputResultIds: ['r1', 'r2'] })
  expect(resolveReviewScope(run, { kind: 'review', memberId: 'reviewer', inputResultIds: ['r1'] })).toMatchObject({ ok: false, error: 'expert-team-review-scope' })
  expect(resolveReviewScope(runWithResults([]), { kind: 'review', memberId: 'reviewer' })).toMatchObject({ ok: false, error: 'expert-team-empty-review-scope' })
  expect(assertReviewScopeCurrent(runWithResults([executeResult('r3')]), ['r1', 'r2'])).toBe('expert-team-review-scope-changed')
})

it('keeps the previous valid result when a revision fails', () => {
  const original = executeResult('original')
  const failedRevision = { ...executeResult('failed'), kind: 'revision' as const, status: 'failed' as const, supersedesResultId: 'original' }
  expect(currentEffectiveResultIds(runWithResults([original, failedRevision]))).toEqual(['original'])
})

it('distinguishes invalid reviews from exhausted business revisions, covers all terminal statuses including message mode, and marks artifactLinkError as partial', () => {
  expect(computeExpertTeamTerminalStatus({ run: runWithResults([]), finalSummaryPresent: true })).toBe('failed')
  expect(computeExpertTeamTerminalStatus({ run: runWithCompletedDelivery(), finalSummaryPresent: true })).toBe('completed')
  expect(computeExpertTeamTerminalStatus({ run: runWithInvalidReview(), finalSummaryPresent: true })).toBe('partial')
  expect(computeExpertTeamTerminalStatus({ run: runWithExhaustedRevision(), finalSummaryPresent: true })).toBe('completed_with_issues')
  expect(computeExpertTeamTerminalStatus({
    run: runWithExhaustedRevision({ artifactStatus: 'pending', artifactLinkError: 'expert-team-artifact-link-failed' }),
    finalSummaryPresent: true,
  })).toBe('partial')
  expect(computeExpertTeamTerminalStatus({ run: runWithMessageDelivery(), finalSummaryPresent: false })).toBe('partial')
  expect(computeExpertTeamTerminalStatus({ run: runWithMessageDelivery(), finalSummaryPresent: true })).toBe('completed')
})

it('enforces none/per-member scope rules, sequential order, execute retry via supersedesResultId, and 0/1/2 revision rounds', () => {
  // review.mode === 'none' 禁止 review 与 revision
  const noneReviewRun = runWithReviewMode('none', [executeResult('r1', { memberId: 'm-exec-1' })])
  expect(validateDispatchRule(noneReviewRun, { memberId: 'm-rev-1', kind: 'review', task: '不应允许' })).toEqual({
    ok: false,
    error: 'expert-team-review-disabled',
  })
  expect(validateDispatchRule(noneReviewRun, { memberId: 'm-exec-1', kind: 'revision', task: '不应允许', supersedesResultId: 'r1' })).toEqual({
    ok: false,
    error: 'expert-team-review-disabled',
  })

  // per-member scope 必须显式提供目标单例（省略或多选均拒绝）
  const perMemberScopeRun = runWithReviewMode('per-member', [executeResult('r1', { memberId: 'm-exec-1' }), executeResult('r2', { memberId: 'm-exec-2' })])
  expect(resolveReviewScope(perMemberScopeRun, { kind: 'review', memberId: 'm-rev-1' })).toMatchObject({ ok: false, error: 'expert-team-review-scope' })
  expect(resolveReviewScope(perMemberScopeRun, { kind: 'review', memberId: 'm-rev-1', inputResultIds: ['r1', 'r2'] })).toMatchObject({ ok: false, error: 'expert-team-review-scope' })
  expect(resolveReviewScope(perMemberScopeRun, { kind: 'review', memberId: 'm-rev-1', inputResultIds: ['r1'] })).toEqual({ ok: true, inputResultIds: ['r1'] })

  const seqRun = runWithSequentialExecutors(['m-exec-1', 'm-exec-2'])
  expect(validateDispatchRule(seqRun, { memberId: 'm-exec-2', kind: 'execute', task: '抢跑' })).toEqual({
    ok: false,
    error: 'expert-team-sequential-order',
  })
  const afterFirst = runWithSequentialExecutors(['m-exec-1', 'm-exec-2'], [executeResult('r1', { memberId: 'm-exec-1' })])
  expect(validateDispatchRule(afterFirst, { memberId: 'm-exec-2', kind: 'execute', task: '未引用前序', inputResultIds: [] })).toEqual({
    ok: false,
    error: 'expert-team-sequential-reference',
  })
  expect(validateDispatchRule(afterFirst, { memberId: 'm-exec-2', kind: 'execute', task: '引用前序', inputResultIds: ['r1'] })).toEqual({ ok: true })

  // execute + supersedesResultId 仅允许重试同成员失败/停止的 execute，且不消耗返修轮数
  const failedExecRun = runWithResults([executeResult('r-fail', { memberId: 'm-exec-1', status: 'failed' })])
  expect(validateDispatchRule(failedExecRun, { memberId: 'm-exec-1', kind: 'execute', task: '重试', supersedesResultId: 'r-fail' })).toEqual({ ok: true })
  expect(validateDispatchRule(afterFirst, { memberId: 'm-exec-1', kind: 'execute', task: '试图替代成功结果', supersedesResultId: 'r1' })).toEqual({
    ok: false,
    error: 'expert-team-invalid-supersede',
  })

  // maxRevisionRounds = 0：首次返修即被拒，有有效 revise 即可结 completed_with_issues
  const zeroQuotaUnified = runWithUnifiedRevise(['r1', 'r2'], { maxRevisionRounds: 0, unifiedRevisionRounds: 0 })
  expect(validateDispatchRule(zeroQuotaUnified, { memberId: 'm-exec-1', kind: 'revision', task: '0 额度返修', supersedesResultId: 'r1' })).toEqual({
    ok: false,
    error: 'expert-team-revision-limit',
  })

  // unified 返修周期（maxRevisionRounds = 1）：首份返修开启周期（opensUnifiedRevisionCycle=true），同周期第二名成员返修复用，全员复审关闭周期后超额返修被拒
  const unifiedReviseRun = runWithUnifiedRevise(['r1', 'r2'], { maxRevisionRounds: 1, unifiedRevisionRounds: 0 })
  expect(validateDispatchRule(unifiedReviseRun, { memberId: 'm-exec-1', kind: 'revision', task: '返修 1', supersedesResultId: 'r1' })).toEqual({
    ok: true,
    opensUnifiedRevisionCycle: true,
  })
  const midCycleRun = runWithUnifiedRevise(['r1-rev', 'r2'], { maxRevisionRounds: 1, unifiedRevisionRounds: 1, cycleOpen: true })
  expect(validateDispatchRule(midCycleRun, { memberId: 'm-exec-2', kind: 'revision', task: '同周期返修 2', supersedesResultId: 'r2' })).toEqual({
    ok: true,
    opensUnifiedRevisionCycle: false,
  })
  const exhaustedUnified = runWithUnifiedRevise(['r1-rev', 'r2-rev'], { maxRevisionRounds: 1, unifiedRevisionRounds: 1, cycleOpen: false })
  expect(validateDispatchRule(exhaustedUnified, { memberId: 'm-exec-1', kind: 'revision', task: '超额返修', supersedesResultId: 'r1-rev' })).toEqual({
    ok: false,
    error: 'expert-team-revision-limit',
  })

  // maxRevisionRounds = 2：允许开启第 2 轮周期，第 2 轮复审关闭后再返修被拒
  const round2Open = runWithUnifiedRevise(['r1-rev', 'r2-rev'], { maxRevisionRounds: 2, unifiedRevisionRounds: 1, cycleOpen: false })
  expect(validateDispatchRule(round2Open, { memberId: 'm-exec-1', kind: 'revision', task: '第 2 轮返修', supersedesResultId: 'r1-rev' })).toEqual({
    ok: true,
    opensUnifiedRevisionCycle: true,
  })
  const round2Exhausted = runWithUnifiedRevise(['r1-rev2', 'r2-rev'], { maxRevisionRounds: 2, unifiedRevisionRounds: 2, cycleOpen: false })
  expect(validateDispatchRule(round2Exhausted, { memberId: 'm-exec-1', kind: 'revision', task: '超 2 轮返修', supersedesResultId: 'r1-rev2' })).toEqual({
    ok: false,
    error: 'expert-team-revision-limit',
  })

  // per-member 按单条结果链的 revision 次数独立计数（覆盖 0/1/2）
  const perMemberRun = runWithPerMemberChain({ memberId: 'm-exec-1', revisionsInChain: 1, maxRevisionRounds: 1 })
  expect(validateDispatchRule(perMemberRun, { memberId: 'm-exec-1', kind: 'revision', task: '单链超额', supersedesResultId: 'r1-rev' })).toEqual({
    ok: false,
    error: 'expert-team-revision-limit',
  })
  const perMemberRound2 = runWithPerMemberChain({ memberId: 'm-exec-1', revisionsInChain: 1, maxRevisionRounds: 2 })
  expect(validateDispatchRule(perMemberRound2, { memberId: 'm-exec-1', kind: 'revision', task: '单链第 2 轮', supersedesResultId: 'r1-rev' })).toMatchObject({ ok: true })
})

it('allows partial artifact when every required member/reviewer has at least technical failure evidence, and waives unattempted broadcast/review obligations only at 24 attempts', () => {
  const failedReviewRun = runWithInvalidReview({ artifactStatus: 'pending', deliverySealed: false })
  expect(canSubmitPrimaryArtifact(failedReviewRun, { inFlight: false, artifactFormat: 'markdown', callId: 'call-partial' })).toEqual({ ok: true })
  const run = runWithMissingReview({ dispatchAttempts: 24, artifactStatus: 'pending', deliverySealed: false })
  expect(canSubmitPrimaryArtifact(run, { inFlight: false, artifactFormat: 'markdown', callId: 'call-new' })).toEqual({ ok: true })
  expect(canSubmitPrimaryArtifact(run, { inFlight: true, artifactFormat: 'markdown', callId: 'call-new' })).toMatchObject({ ok: false, error: 'expert-team-dispatch-in-flight' })
  expect(canSubmitPrimaryArtifact({ ...run, dispatchAttempts: 23 }, { inFlight: false, artifactFormat: 'markdown', callId: 'call-new' })).toMatchObject({ ok: false, error: 'expert-team-review-incomplete' })
  expect(canSubmitPrimaryArtifact(run, { inFlight: false, artifactFormat: 'html', callId: 'call-new' })).toMatchObject({ ok: false, error: 'expert-team-artifact-format' })

  const broadcastMissing = runWithUnattemptedBroadcastExecutor({ dispatchAttempts: 23 })
  expect(canSubmitPrimaryArtifact(broadcastMissing, { inFlight: false, artifactFormat: 'markdown', callId: 'call-b1' })).toMatchObject({
    ok: false,
    error: 'expert-team-broadcast-incomplete',
  })
  expect(canSubmitPrimaryArtifact({ ...broadcastMissing, dispatchAttempts: 24 }, { inFlight: false, artifactFormat: 'markdown', callId: 'call-b2' })).toEqual({ ok: true })
})
```

- [ ] **Step 2: 确认调度纯函数测试失败**

本文件内显式定义纯测试工厂（均基于 Task 1 `validTeam()` 与 `executeResult(resultId, overrides?)` 返回 `ExpertTeamRun`，不依赖后续 coordinator；严格遵守 `exactOptionalPropertyTypes: true`，不向可选属性传入显式 `undefined`）：
工厂若使用 `m-exec-2`、`reviewer`、`executor-2` 等不在 `validTeam()` 默认两成员名单内的 `memberId`，必须同步扩展 `run.teamSnapshot.members`（保持角色匹配），不得让被测实现按字面拒绝期望 `ok: true` 的用例。

- `runWithResults(results, overrides?)`：替换 `results`；
- `runWithCompletedDelivery(overrides?)`：一份有效 `execute`、一份有效 `pass` `review`、已关联 `primaryArtifactId` 与 `artifactStatus: 'created'`；
- `runWithMessageDelivery(overrides?)`：`summary.delivery: 'message'`、`artifactStatus: 'not-required'`、一份有效 `execute` 与 `pass` `review`；
- `runWithReviewMode(mode, results)`：构造指定 `review.mode`（`'none' | 'unified' | 'per-member'`）的运行；
- `runWithInvalidReview(overrides?)`：一份有效 `execute` 加一份 `completed` 但 `reviewError='invalid-verdict'` 的 `review`（默认无 `primaryArtifactId`）；
- `runWithExhaustedRevision(overrides?)`：original→成功 revision 的结果链、`unifiedRevisionRounds=1`、最新有效 revise 和已创建主 Artifact；
- `runWithMissingReview(overrides?)`：一份有效 execute、无 review、pending 且未封闭；
- `runWithSequentialExecutors(memberIds, results?)`：构造 `executionOrder: 'sequential'` 的双执行员运行；
- `runWithUnifiedRevise(effectiveIds, opts)`：构造 `review.mode: 'unified'` 且存在最新有效 `revise` 结论的运行；注意 **`cycleOpen` 仅为本测试工厂入参而非 `ExpertTeamRun` 字段**（遵守规格 §8.3，`validateDispatchRule` 完全从 `run.results` 派生周期开/闭）：`cycleOpen: true` 表示在最近一轮全员 `revise` 审查之后已经存在一份同周期 `revision` 结果且尚未发起新一轮全员复审，`cycleOpen: false`（默认）表示当前 `effectiveIds` 上已完成全员统一审查且尚无新一轮 `revision`；
- `runWithPerMemberChain(opts)`：构造 `review.mode: 'per-member'` 的单成员结果链与 `revise` 结论；
- `runWithUnattemptedBroadcastExecutor(overrides?)`：构造 `assignmentMode: 'broadcast'` 且仍有未派工执行员的运行。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-orchestration.spec.ts
```
Expected: FAIL，`orchestration.ts` 不存在。

- [ ] **Step 3: 实现确定性规则**

`currentEffectiveResultIds` 仅保留满足 `completed + 非空文本 + 无结果级 error` 的 execute/revision，并排除被后续**有效**结果的 `supersedesResultId` 指向的 ID，按 ID 排序去重。`resolveReviewScope` 对 unified 省略 ID 时返回全集，显式输入必须完全相等；per-member 只接受目标单例，空全集禁止 review。`assertReviewScopeCurrent` 在出队时重新计算并返回 `expert-team-review-scope-changed`，不得重新填充成另一组结果。

`validateDispatchRule(run, input)` 统一实现确定性派工校验：
- 角色匹配与 `review.mode === 'none'` 禁 review/revision（拒绝码 `expert-team-review-disabled`）；
- `inputResultIds` 归属本运行且已完成；
- `sequential` 首轮按成员列表顺序推进且后序必须引用前序有效结果；
- `execute` 携带 `supersedesResultId` 时，目标必须属于同成员且为 `failed` / `stopped` 的 `execute`（不得替代成功结果/review/revision，也不消耗返修轮数）；
- `revision` 必须携带 `supersedesResultId` 指向同成员当前有效执行结果且响应当前有效 `revise`；`unified` 判断是否需要开启新返修周期（全员统一审查完成后首个 `revision` 才递增 `unifiedRevisionRounds`，同周期内其他成员返修复用当前周期，下一次全员统一审查关闭周期），`per-member` 按该结果链中已有 `revision` 次数检查 `maxRevisionRounds`。

`canSubmitPrimaryArtifact(run, input)` 依次检查 `running`/未取消/未封闭、至少一份有效执行、无在途（含等待队列）、格式匹配、尚无 `primaryArtifactId`、广播与必审/返修义务：
- 区分**从未派工**与**已有技术失败证据**：`broadcast` 仅在存在**从未派工**的执行成员时拒绝；必审仅在存在**从未尝试**（既无有效结论、也无明确的 `failed / stopped / invalid-verdict` 记录）的必审员时拒绝；已有技术失败/无效标记证据时不阻止提交如实披露的部分报告（回合仍结 `partial`）；当前审查轮/结果链仍有返修额度且存在有效 `revise` 却未执行必要返修时拒绝；
- 只有 `dispatchAttempts >= 24` 且满足至少一份有效结果与无在途时，豁免 `broadcast` 缺执行员、必审缺失、额度内必要返修三类拒绝；运行归属、格式、取消与交付封闭校验永不豁免；
- 相同 `primaryArtifactCallId` 走 Task 12 的幂等重放分支，不按新提交拒绝。

`computeExpertTeamTerminalStatus({ run, finalSummaryPresent, protocolError? })` 按规格 §12.4.2 优先级实现：取消不在这里直接判 `stopped`（由清理收敛后 `markStopped` 发布），无有效执行为 `failed`，任一技术缺失（未被有效结果替代的失败/停止执行或返修、最新审查尝试失败/停止/缺失/无效标记、`broadcast` 缺有效首轮结果、必审不完整或额度内未返修、Artifact 模式缺已关联 `primaryArtifactId` 或存在 `artifactLinkError`、仅会话模式缺 `finalSummaryPresent`、协议错误）为 `partial`，返修额度耗尽的有效 `revise` 为 `completed_with_issues`，其余 `completed`。`reviewError` 永远属于技术缺失；失败 revision 不替代旧有效结果。

- [ ] **Step 4: 运行调度纯函数测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-orchestration.spec.ts
```
Expected: PASS，覆盖 unified/per-member、0/1/2 返修轮次、预算豁免边界和全部终态。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/orchestration.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-orchestration.spec.ts
git commit -m "feat(expert-team): add deterministic orchestration rules"
```

---

### Task 7: 团队包派发的子会话隔离与 caller 结果

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/dispatch.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/types.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`（仅补充 `SessionRuntimeContext` 新增的 `huaanworkAgentPackageTeamRequests` 类型）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-dispatch.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts`

**Interfaces:**
- Consumes: `composeAgentPackageToolAllowList`、`mountSessionMcp`、`startActivation`、`AgentPackageSubagentRequest`、`activeTurns`/`lifecycle`/`security`、Task 5 `renderMemberOutput`。
- Produces: `TeamMemberDispatchInput`、`TeamMemberDispatchResult`、`AgentPackageHost.dispatchTeamMember(input)`、`teamMcpServerName(slug, reservedChildId)`；`SubagentRunRegistry.begin` 支持可选 `teamRunId?: string`。
- Produces holder: `ctx.huaanworkAgentPackageTeamRequests: Map<string, AgentPackageSubagentRequest>`（在 `holders.ts` 的 `installHuaanworkHolders` 初始化并加入 `HUAANWORK_CONTEXT_PROPS`）。

- [ ] **Step 1: 写双 MCP 隔离、实时 `onRunCreated`、包撤销/更新中止、provider 换 id 与普通路径回归失败测试**

```ts
it('binds two MCP members only to their reserved child sessions and notifies onRunCreated before result settles', async () => {
  const { host, attachments, activations } = await makeTeamPackageFixture({ mcp: true })
  const seenRunIds: string[] = []
  const [first, second] = await Promise.all([
    host.dispatchTeamMember(teamInput('parent', 'alpha', 'task A', { onRunCreated: ({ runId }) => seenRunIds.push(runId) })),
    host.dispatchTeamMember(teamInput('parent', 'alpha', 'task B', { onRunCreated: ({ runId }) => seenRunIds.push(runId) })),
  ])
  expect(seenRunIds).toEqual(expect.arrayContaining([first.runId, second.runId]))
  expect(first.reservedChildId).not.toBe(second.reservedChildId)
  expect(attachments.sessionAgentTools.has('parent')).toBe(false)
  for (const result of [first, second]) {
    expect(teamMcpServerName('a-very-long-agent-slug-name', result.reservedChildId)).toHaveLength(32)
    expect(activations.get(result.runId)?.delivery).toBe('caller')
    expect(activations.get(result.runId)?.disposed).toBe(true) // 成员结果结算后即时清理，不泄漏 MCP/进程
  }
})

it('rebinds an actual child id without rekeying the request map and cancels on package revoke/update via activeTurns', async () => {
  const { host, requests, activation, activeTurns } = await makeTeamPackageFixture({ providerChangesChildId: true })
  const result = await host.dispatchTeamMember(teamInput('parent', 'alpha', 'task'))
  expect(result.actualChildId).not.toBe(result.reservedChildId)
  expect(requests.has(result.reservedChildId)).toBe(false)
  expect(requests.has(result.actualChildId)).toBe(false)
  expect(activation.boundChildren).toEqual(expect.arrayContaining([result.reservedChildId, result.actualChildId]))
  expect(activeTurns.registeredCount).toBeGreaterThan(0)
})
```

- [ ] **Step 2: 确认隔离测试失败**

`makeTeamPackageFixture` 复用 `createRuntime` 注入缝和 `package-subagent-lineage.spec.ts` 的 composing tools fake，显式返回 host、真实 `AttachmentMaps`（`attachments = emptyAttachments()`，断言用 `attachments.sessionAgentTools.has(...)`）、activations、requests、activeTurns 与 activation；`teamInput(sessionId, slug, remainder, overrides?)` 返回 `TeamMemberDispatchInput`，`dispatchWithOutput(blocks)` 用同一 fake activation 返回指定 `SubagentResult.output`。这些工厂负责所有 reserved/actual id、MCP mount 和 caller 结果记录，不在断言中绕过被测实现。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-dispatch.spec.ts
```
Expected: FAIL，`dispatchTeamMember` 不存在。

- [ ] **Step 3: 实现团队专用 runtime、MCP 命名、请求 Map、`activeTurns` 接入与单成员即时清理**

```ts
export type TeamMemberDispatchInput = {
  ctx: AgentPackageDispatchContext
  sessionId: string
  teamRunId: string
  pkg: AgentPackageDetail
  remainder: string
  clientMessageId?: string
  signal?: AbortSignal
  onRunCreated?: (info: { runId: string; reservedChildId: SessionId }) => void
  resolveParent?: () => Promise<unknown>
  mcpServerName?: string
}

export function teamMcpServerName(slug: string, reservedChildId: string): string {
  return `${slug.slice(0, 22)}__${reservedChildId.replaceAll('-', '').slice(0, 8)}`
}
```

`dispatchTeamMember` 与现有 `dispatch` 并排，不修改普通函数签名、`pendingTurns`、父会话 registry 绑定、旧单槽或 parent delivery（不触碰 `agent-invoke.ts`）。团队路径行为如下：
1. **实时可见与外部取消**：在 `subagentRuns.begin({ parentSessionId: sessionId, kind: 'package', label: `@${pkg.slug}`, packageVersion: pkg.version, teamRunId: input.teamRunId, ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}) })` 并生成 `reservedChildId` 后，**立即**触发 `input.onRunCreated?.({ runId, reservedChildId })`（早于任何 `await`），使协调器在成员运行期间即可写入 `memberRunId` 并支持单成员/整团取消；将外部 `input.signal` 与本回合内部 `AbortController` 联动，触发 `cancelTurn('cancel')`。
2. **复用包安全面与在途登记**：按与 `dispatch` 相同的顺序执行 `lifecycle.isBusy(pkg.slug)`、撤销检查与两次 `security.assertRunnable(pkg.slug, pkg.version)`；将本成员回合登记进 `activeTurns.register(record)`（不写 `pendingTurns`，也不传 `releaseReservation`），确保目录包更新/移除/撤销或应用退出能中止在途团队成员。
3. **子会话隔离与 MCP 命名**：在 `createRuntime` 前预留 `reservedChildId`，直接 `registry.bind(reservedChildId, runtime)` 与 `mountSessionMcp({ sessionId: reservedChildId, serverName })`；活动 `serverName` 用集合登记，冲突报 `expert-team-mcp-server-name-conflict`，dispose 必须释放；allow 使用实际 `mounted.names`，不手工拼接公开工具名。
4. **请求 Map 与 provider 换 id**：`holders.ts` 在 `installHuaanworkHolders` 初始化 `ctx.huaanworkAgentPackageTeamRequests = new Map()` 并加入 `HUAANWORK_CONTEXT_PROPS`；同步在 `agent-package/host.ts` 的 `AgentPackageDispatchContext`（L72-88）补充可选 `huaanworkAgentPackageTeamRequests?: Map<string, AgentPackageSubagentRequest>`。`skills.ts` 的 `startActivation` 包装器中**必须把 `specChildId` 提取提前到读 `pkg` 之前**（现行代码 L685 先读 `pkg`、L693 才算 `specChildId`），先按 `typeof specChildId === 'string'` 从 `huaanworkAgentPackageTeamRequests.get(specChildId)` 精确取团队请求，未命中再回落旧单槽 `huaanworkAgentPackageRequest?.current`；`finally` 仅当 `pkg` 源自团队 Map 且 `map.get(specChildId) === pkg` 时删除该键（普通单槽清理逻辑不变）。启动失败由 `dispatchTeamMember` 的 catch/finally 兜底删除未消费键。provider 改实际 `childId` 时不重键请求 Map，runtime/附件/血缘按现有逻辑补绑并同时清理 reserved 与实际两类 ID。
5. **单成员即时清理**：`activation.result` 结算（或取消/启动失败）后，立即执行本成员的 `disposeActivation + stopTurnRuntime + mcpDispose + releaseChildBindings + unregister(activeTurns)`，绝不把 24 个成员的进程/MCP 作用域泄漏到父回合结束；同时返回 `cleanupPromise` 供父回合 `afterIdle` 在取消竞态下等待收尾确认。

- [ ] **Step 4: 写 caller 文本与运行状态失败测试**

```ts
it('returns caller text without parent notification or structured output', async () => {
  const { host, activation } = await makeTeamPackageFixture({
    output: [{ type: 'reasoning', text: '分析' }, { type: 'text', text: '成员结论' }],
  })
  const result = await host.dispatchTeamMember(teamInput('parent', 'alpha', 'task'))
  expect(activation.spec).toMatchObject({ delivery: 'caller' })
  expect(activation.spec).not.toHaveProperty('outputSchema')
  expect(result.output).toEqual({ ok: true, text: '成员结论' })
  expect(activation.parentNotifications).toEqual([])
})

it('marks empty and unsupported output without changing upstream stopReason', async () => {
  const empty = await dispatchWithOutput([{ type: 'reasoning', text: '仅思考' }])
  expect(empty).toMatchObject({ stopReason: 'completed', output: { ok: false, error: 'empty-output' } })
  const unsupported = await dispatchWithOutput([{ type: 'image', data: 'x' }])
  expect(unsupported).toMatchObject({ stopReason: 'completed', output: { ok: false, error: 'unsupported-output' } })
})
```

- [ ] **Step 5: 实现 caller 返回与文本结果**

`TeamMemberDispatchResult` 固定为：

```ts
export type TeamMemberDispatchResult = {
  runId: string
  reservedChildId: SessionId
  actualChildId: SessionId
  stopReason: string
  diagnostic?: string
  output: MemberTextResult
  cleanupPromise: Promise<void>
}
```

团队 activation 使用 `delivery: 'caller'` 且不传 `outputSchema`，等待 `activation.result` 后调用 Task 5 渲染文本并保留上游 `diagnostic`，同时触发单成员清理并将 `cleanupPromise` 返回调用方。`subagentRuns` 继续记录包版本、reserved/actual child、`teamRunId`、取消、`stopReason` 和清理警告；输出协议失败由协调器映射为团队结果 `failed`，不改上游 `stopReason`。

- [ ] **Step 6: 运行团队派发和普通包回归测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-dispatch.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-host/subagent-runs.spec.ts
```
Expected: 全部 PASS；普通 `@智能体` 的 pendingTurns、MCP 工具名和 parent 投递不回归。

- [ ] **Step 7: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/dispatch.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/types.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-dispatch.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts
git commit -m "feat(expert-team): isolate caller member dispatch"
```

---

### Task 8: 团队运行协调器、团队租约与派工排队

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-coordinator.spec.ts`

**Interfaces:**
- Consumes: Task 3 registry、Task 6 纯规则（含 `validateDispatchRule`）、Task 7 `dispatchTeamMember`。
- Produces: `ExpertTeamLease`（按 `parentSessionId + clientMessageId + teamRunId` 签发与显式失效，附件释放失败时仍必须失效租约）、`ExpertTeamCoordinator`（`begin/dispatch/hasInFlight/isLeaseValid/invalidateLease/waitMemberCleanups/cancelRun`），以及工具桥使用的 `ExpertTeamDispatchInput/Result`。

- [ ] **Step 1: 写预算、并发、租约失效、scope、256 KiB 边界和失败结果返回失败测试**

```ts
it('enforces team and per-member concurrency without pendingTurns', async () => {
  const { coordinator, gate } = await makeCoordinatorFixture({ maxParallel: 2 })
  const first = coordinator.dispatch(dispatchInput('a'))
  const second = coordinator.dispatch(dispatchInput('b'))
  const third = coordinator.dispatch(dispatchInput('c'))
  const fourth = coordinator.dispatch(dispatchInput('d'))
  await gate.waitStarted(2)
  expect(gate.running).toBe(2)
  expect(gate.startedIds).toHaveLength(2)
  gate.releaseAll()
  await Promise.all([first, second, third, fourth])
  expect(gate.maxRunning).toBe(2)

  // 单成员并发上限恒为 1：即使团队 maxParallel=2，同一成员的两条派工也必须串行
  const sameMember = await makeCoordinatorFixture({ maxParallel: 2 })
  const mFirst = sameMember.coordinator.dispatch(dispatchInput('a', { callId: 'same-1' }))
  const mSecond = sameMember.coordinator.dispatch(dispatchInput('a', { callId: 'same-2' }))
  await sameMember.gate.waitStarted(1)
  await Promise.resolve()
  expect(sameMember.gate.running).toBe(1)
  sameMember.gate.release(1)
  await mFirst
  await sameMember.gate.waitStarted(1)
  sameMember.gate.releaseAll()
  await mSecond
  expect(sameMember.gate.maxRunning).toBe(1)
})

it('increments unifiedRevisionRounds once per cycle even under parallel revisions and rejects revisions after quota exhaustion', async () => {
  const { coordinator, gate } = await makeCoordinatorFixture({ maxParallel: 2, reviewMode: 'unified', maxRevisionRounds: 1 })
  // 首轮 2 名执行成员产出 r1/r2，随后统一审查给出 revise
  const r1 = await coordinator.dispatch(dispatchInput('executor', { callId: 'u-e1' }))
  const r2 = await coordinator.dispatch(dispatchInput('executor-2', { callId: 'u-e2' }))
  await coordinator.dispatch(dispatchInput('reviewer', { callId: 'u-rev1', kind: 'review', task: '首轮审查' })) // fixture 返回 [VERDICT: REVISE]
  // 启动前校验被拒（超 256 KiB）不得消耗 unifiedRevisionRounds
  await expect(coordinator.dispatch(dispatchInput('executor', {
    callId: 'u-bad-rev', kind: 'revision', supersedesResultId: r1.resultId, task: '超长'.repeat(150 * 1024),
  }))).rejects.toThrow('expert-team-prompt-too-large')
  expect(coordinator.runs.byTurn('s1', 'm1')?.unifiedRevisionRounds).toBe(0)

  // 同周期并行返修两名成员：首份开启周期（0 -> 1），第二份复用同一周期（仍为 1，不得重复递增为 2）
  const revA = coordinator.dispatch(dispatchInput('executor', { callId: 'u-r1', kind: 'revision', supersedesResultId: r1.resultId, task: '返修 A' }))
  const revB = coordinator.dispatch(dispatchInput('executor-2', { callId: 'u-r2', kind: 'revision', supersedesResultId: r2.resultId, task: '返修 B' }))
  gate.releaseAll()
  const [resA] = await Promise.all([revA, revB])
  expect(coordinator.runs.byTurn('s1', 'm1')?.unifiedRevisionRounds).toBe(1)

  // 全员复审再次返回 revise 关闭该周期后，第 2 轮返修因超过 maxRevisionRounds=1 被拒绝
  await coordinator.dispatch(dispatchInput('reviewer', { callId: 'u-rev2', kind: 'review', task: '复审' }))
  await expect(coordinator.dispatch(dispatchInput('executor', {
    callId: 'u-r3', kind: 'revision', supersedesResultId: resA.resultId, task: '超额返修',
  }))).rejects.toThrow('expert-team-revision-limit')
})

it('counts each arrival once and rejects calls after 24', async () => {
  const { coordinator } = await makeCoordinatorFixture()
  for (let index = 0; index < 24; index += 1) await coordinator.dispatch(dispatchInput('a', { callId: `c-${index}`, task: `task-${index}` }))
  await expect(coordinator.dispatch(dispatchInput('a', { callId: 'c-24' }))).rejects.toThrow('expert-team-dispatch-budget')
  expect(coordinator.runs.byTurn('s1', 'm1')?.dispatchAttempts).toBe(25)
})

it('resolves unified scope once and rejects stale queued scope', async () => {
  const { coordinator, gate } = await makeCoordinatorFixture({ maxParallel: 1, reviewMode: 'unified' })
  const first = coordinator.dispatch(dispatchInput('executor', { callId: 'c1' }))
  await gate.waitStarted(1) // 第一名执行成员仍在运行，当前全集为空
  const second = coordinator.dispatch(dispatchInput('executor-2', { callId: 'c2' }))
  gate.release(1)
  await first // 当前全集只有 executor 的 r1，executor-2 已占据唯一执行槽
  await gate.waitStarted(1)
  const pending = coordinator.dispatch(dispatchInput('reviewer', { callId: 'c3', kind: 'review', task: '审查全部结果' }))
  gate.releaseAll() // executor-2 产出 r2 后，排队中的 review 出队发现 r1,r2 与入口 r1 不同
  await second
  await expect(pending).rejects.toThrow('expert-team-review-scope-changed')
  expect(gate.reviewPrompts).toHaveLength(0)
})

it('enforces the exact 256 KiB UTF-8 byte boundary (including multibyte characters) without counting package persona, and returns structured failure on upstream subagent capacity exhaustion', async () => {
  const { coordinator, activations, exactTaskForBytes } = await makeCoordinatorFixture({ packagePersonaBytes: 48 * 1024 })
  // 含中文/emoji 的多字节文本：合计恰好 256 * 1024 UTF-8 字节时允许启动（即便包 persona 另有 48 KiB）
  const exact256KiB = exactTaskForBytes('a', 256 * 1024, '审🧪')
  await expect(coordinator.dispatch(dispatchInput('a', { callId: 'c-exact', task: exact256KiB }))).resolves.toMatchObject({ status: 'completed' })
  expect(activations).toHaveLength(1)

  // 多 1 个 UTF-8 字节（256 * 1024 + 1）在启动成员前直接拒绝
  await expect(coordinator.dispatch(dispatchInput('a', { callId: 'c-over', task: `${exact256KiB}x` }))).rejects.toThrow('expert-team-prompt-too-large')
  expect(activations).toHaveLength(1)

  // 上游剩余子智能体容量不足时：计入 24 次预算并返回带 resultId 的失败结果，不隐藏重试
  const capFixture = await makeCoordinatorFixture({ maxActiveSubagentsError: 'maxActiveSubagents reached' })
  const capRes = await capFixture.coordinator.dispatch(dispatchInput('a', { callId: 'c-cap' }))
  expect(capRes).toMatchObject({ status: 'failed', error: expect.stringContaining('maxActiveSubagents') })
  expect(capFixture.coordinator.runs.byTurn('s1', 'm1')?.dispatchAttempts).toBe(1)
})
```

另测：① `callId` 缺失拒绝、写入 `ExpertTeamResult.dispatchId`；② `invalidateLease` 后（即使附件摘除抛错）后续派工一律拒绝；③ 成员启动/执行失败或单成员取消时返回带 `resultId` 的 `{ status: 'failed' | 'stopped', error }`（而非吞掉 `resultId` 抛错），团长可凭该 `resultId` 以 `execute + supersedesResultId` 重试失败 `execute`；④ 成员进入运行即写入 `memberRunId`，整团取消可立刻中止等待队列与在途成员并等待 `cleanupPromise`；⑤ `sequential` 引用前序、`broadcast` 缺员、`revision` 响应有效 `revise`、统一/单链返修额度。

- [ ] **Step 2: 确认协调器测试失败**

`makeCoordinatorFixture` 使用真实 registry/coordinator 和可控 Task 7 fake dispatch；`dispatchInput` 使用 `executor`、`executor-2`、`reviewer` 等成员时，fixture 必须同步把对应 `memberId` 与角色加入 `teamSnapshot.members`（不得仅靠字符串约定）；`gate` 提供 `waitStarted(n)`（等待 n 个派工处于 running）、`release(n)`（完成当前最早的 n 个在途派工）、`releaseAll()`、`running/maxRunning/startedIds/reviewPrompts`，证明等待队列而非绕过信号量。`dispatchInput(memberId, overrides?)` 生成带 `callId`、`parentSessionId='s1'`、`clientMessageId='m1'`、`kind='execute'`、`task='task'` 的完整输入；`exactTaskForBytes(memberId, targetTotalBytes, seed)` 先计算该成员的固定提示词开销（`responsibility`、`outputInstructions`、引用结果渲染及模板头尾，不含包 `persona`），再以多字节 `seed` 补齐 `task` 使**渲染后总派工输入**的 UTF-8 字节数恰好等于 `targetTotalBytes`（而非让 `task` 单独等于 256 KiB）。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-coordinator.spec.ts
```
Expected: FAIL，`coordinator.ts` 不存在。

- [ ] **Step 3: 实现租约、预算、双信号量与出队重验**

```ts
export type ExpertTeamLease = {
  teamRunId: string
  parentSessionId: string
  clientMessageId: string
  valid: boolean
}

export type ExpertTeamDispatchInput = {
  callId: string
  parentSessionId: string
  clientMessageId: string
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  task: string
  inputResultIds?: string[]
  supersedesResultId?: string
}

export type ExpertTeamDispatchResult = {
  resultId: string
  memberId: string
  agentSlug: string
  kind: ExpertTeamDispatchInput['kind']
  inputResultIds: string[]
  status: 'completed' | 'failed' | 'stopped'
  output?: string
  reviewVerdict?: 'pass' | 'revise'
  reviewError?: 'invalid-verdict'
  error?: string
}
```

每次到达先校验 `callId` 非空，再按 `parentSessionId + clientMessageId` 及有效 `ExpertTeamLease` 绑定唯一 `running` 且未封闭的运行，并增加一次 `dispatchAttempts`（超 24 拒绝）；随后调用 Task 6 `validateDispatchRule` 与 `resolveReviewScope`。协调器拒绝错误码统一具名，禁止匿名字符串：
- 运行已停止/已终态/`deliverySealed === true` 或租约失效：`expert-team-terminal`（与 Task 11 / Task 17 断言一致）；
- 派工次数超过 24：`expert-team-dispatch-budget`；
- 派工输入超过 256 KiB UTF-8：`expert-team-prompt-too-large`；
- 排队出队时统一审查全集已变化：`expert-team-review-scope-changed`；
- 规则与返修上限拒绝：透传 Task 6 `validateDispatchRule` / `resolveReviewScope` 错误码（如 `expert-team-review-disabled`、`expert-team-revision-limit`、`expert-team-sequential-order` 等）。

实现每 run 和每 member 两个可取消信号量，等待队列不创建 `memberRun`，但计入 `hasInFlight(teamRunId)`。出队时重验租约、取消、`deliverySealed`、`validateDispatchRule`、`assertReviewScopeCurrent`、替代关系、顺序和成员包实时可用性；任一不满足返回对应具名错误且不重复扣预算。`invalidateLease(teamRunId)` 同步置 `lease.valid = false`，即便上层摘除附件或刷新 restrict 抛错也不得回滚租约失效状态（规格 §10.3）。

- [ ] **Step 4: 实现 256 KiB 输入、实时 `memberRunId`、`unifiedRevisionRounds` 写者、失败返回形态与取消闭包**

派工提示词只包含 `task`、成员团内 `responsibility`、`outputInstructions`、Host 实际解析后的 `inputResultIds` 渲染文本，以及审查任务所需的末行 `[VERDICT: PASS]` / `[VERDICT: REVISE]` 要求；**不包含成员包 `persona`**（`persona` 由 `dispatchTeamMember` 按其独立 64 KiB 上限拼接，规格 §12.2）。按 `Buffer.byteLength(..., 'utf8')` 校验不超过 256 KiB，超限在启动成员前直接拒绝（报 `expert-team-prompt-too-large`）。

通过出队重验与 256 KiB 校验后，在**同一同步 `registry.update(teamRunId, ...)` 临界区**内重新基于当前 `run.results` 判定 `validateDispatchRule`（若拒绝则直接抛错，不建结果）：分配 `resultId`（记录 `dispatchId = input.callId`）写入 `run.results`，且当 `rule.opensUnifiedRevisionCycle === true` 时同步递增 `run.unifiedRevisionRounds += 1`（`cycleOpen` 不落字段、完全由 `run.results` 派生；以此同时保证：① 启动前校验失败不误扣返修轮次；② 同周期并行两条 `revision` 在同步临界区顺序落入 `run.results`，只有首条看到 `opensUnifiedRevisionCycle: true` 并加 1，第二条复用同一周期）。随后调用 Task 7 `dispatchTeamMember` 并传入运行级 `AbortSignal` 与 `onRunCreated` 回调（立即把 `runId` 写入 `ExpertTeamResult.memberRunId` 并推 `expertTeam/run`），同时把 `cleanupPromise` 记入本运行清理集合供 `waitMemberCleanups(teamRunId)` 等待：
- **入队前/出队前校验拒绝（预算、参数、scope 变化、超长、租约失效）**：不创建 `ExpertTeamResult`，直接抛错；
- **已启动派工的成员失败、被中止或输出协议失败**：更新同一 `ExpertTeamResult`（`stopReason === 'completed' && output.ok` → `completed`；`stopReason === 'aborted'` 或命中单成员取消 → `stopped`；其它 `stopReason`、启动异常（如上游 `maxActiveSubagents` 满、包中途失效/撤销、MCP 冲突）或 `!output.ok` → `failed` 并写入 `error`/`diagnostic`），**返回完整 `ExpertTeamDispatchResult`（携带 `resultId`）给团长**，使团长可按 §12.3 用 `execute + supersedesResultId` 重试失败执行；review 完成后调用 Task 5 解析末行标记。

注册进 registry 的取消闭包必须同步 `invalidateLease`、abort 运行级 `AbortController`、排空拒绝全部等待队列、对所有已知在途 `memberRunId` 触发 `subagentRuns.requestCancel(parentSessionId, memberRunId)` 并等待 `waitMemberCleanups(teamRunId)`；单成员停止结果返回团长，不自动重试。

- [ ] **Step 5: 运行协调器与既有调度测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-coordinator.spec.ts tests/huaanwork-host/turn-scheduler.spec.ts
```
Expected: PASS，实际最大并发不超过配置、租约失效与取消立即可见且普通会话调度不变。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-coordinator.spec.ts
git commit -m "feat(expert-team): coordinate bounded member dispatch"
```

---

### Task 9: 团长附件工具、模型流放行、Host 接线与 policy 放行

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/expert-team-dispatch.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `packages/huaanwork-policy/src/decide.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/expert-team-dispatch.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts`
- Test: `packages/huaanwork-policy/src/decide.test.ts`

**Interfaces:**
- Consumes: Task 8 coordinator、既有附件和 `refreshAgentRestrict`。
- Produces: `EXPERT_TEAM_DISPATCH_TOOL`、`registerExpertTeamDispatchTool`、`makeExpertTeamClaimed`；holder `ctx.huaanworkExpertTeamCoordinator`；`model.ts` 的 `isRegisteredToolName('expert_team_dispatch') === true`。
- Produces policy: attached 时三档在 `preExecute` 与 `guard` 均允许，未挂载一律拒绝；工具输入不含 `teamRunId`。

- [ ] **Step 1: 写工具 schema、claim 对称清理（含 goal 续拍不重挂）、模型流工具名放行和策略失败测试**

`tests/huaanwork-guardrails/expert-team-dispatch.spec.ts`（Vitest）：

```ts
it('declares a concurrency-safe tool without teamRunId and requires exec.callId', async () => {
  const tool = expertTeamDispatchDefinition(fixtureContext())
  expect(tool.isConcurrencySafe?.({})).toBe(true)
  expect(tool.parameters).not.toHaveProperty('teamRunId')
  expect(tool.parameters).toHaveProperty('memberId')
  expect(tool.parameters).toHaveProperty('inputResultIds')
  await expect(tool.execute({ memberId: 'm1', kind: 'execute', task: 't' }, { agent: parentAgent })).rejects.toThrow('expert-team-dispatch-context-missing')
})

it('attaches only for an active running team matching message.id and detaches on ordinary or goal continuation turns', () => {
  const { listener, attachments, refresh, settleTeam } = makeClaimFixture()
  listener({ agent: parentAgent, message: teamMessage, turn: 1 })
  expect(isAgentToolAttached(attachments, 'parent', 'expert_team_dispatch')).toBe(true)
  settleTeam()
  listener({ agent: parentAgent, message: goalMessage, turn: 2 })
  expect(isAgentToolAttached(attachments, 'parent', 'expert_team_dispatch')).toBe(false)
  listener({ agent: parentAgent, message: ordinaryMessage, turn: 3 })
  expect(isAgentToolAttached(attachments, 'parent', 'expert_team_dispatch')).toBe(false)
  expect(refresh).toHaveBeenCalledWith('parent')
})
```

在 `tests/huaanwork-guardrails/model.spec.ts` 新增断言：`isRegisteredToolName('expert_team_dispatch')` 返回 `true`，且 `HuaAnWorkAdapter.stream` 能正常透传原生 SSE `expert_team_dispatch` `tool_calls`（不会被 `parseSseToolCalls` / `parseTextProtocol` 的静态白名单静默丢弃）。

`packages/huaanwork-policy/src/decide.test.ts`（使用包内既有 `node:test` + `node:assert/strict`，而非 Vitest 语法）：

```ts
test("expert_team_dispatch allows when attached and denies when detached in both seams", () => {
  for (const mode of ["ask", "smart", "full"] as const) {
    assert.equal(preExecuteExplained({ name: "expert_team_dispatch", args: {}, workspaceRoot: ws, attached: true }, mode).decision, "allow");
    assert.equal(guardExplained({ name: "expert_team_dispatch", args: {}, workspaceRoot: ws, attached: true }, mode).decision, "allow");
    assert.equal(preExecuteExplained({ name: "expert_team_dispatch", args: {}, workspaceRoot: ws, attached: false }, mode).decision, "deny");
    assert.equal(guardExplained({ name: "expert_team_dispatch", args: {}, workspaceRoot: ws, attached: false }, mode).decision, "deny");
  }
});
```

- [ ] **Step 2: 确认工具、模型流和策略测试失败**

`fixtureContext()` 提供真实 `AttachmentMaps`（`emptyAttachments()`）、turn anchor 和 fake coordinator；`makeClaimFixture()` 返回同步 listener、真实 `AttachmentMaps`（用 `isAgentToolAttached(attachments, 'parent', 'expert_team_dispatch')` 断言）、refresh 记录与 `settleTeam()`，`teamMessage`（`id === run.clientMessageId`）/ `goalMessage`（`source.kind === 'goal'`）/ `ordinaryMessage` 均按真实 `UserMessage` 构造。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/expert-team-dispatch.spec.ts tests/huaanwork-guardrails/model.spec.ts
corepack yarn workspace @huaanwork/policy test
```
Expected: FAIL，工具、`isRegisteredToolName` 分支与显式 policy 分支不存在。

- [ ] **Step 3: 实现附件工具、claim 入口、`model.ts` 放行与 `index.ts` 生产接线**

工具 `execute(args, exec)` 校验 `sessionId`、`exec.callId`（缺失报 `expert-team-dispatch-context-missing`）、附件已挂（`isAgentToolAttached`）与当前 `huaanworkTurnAnchors.current(sessionId)?.clientMessageId`，再把 `{ callId: exec.callId, parentSessionId: sessionId, clientMessageId, ...args }` 交给 Task 8 coordinator；模型只传 `memberId/kind/task/inputResultIds/supersedesResultId`。

`makeExpertTeamClaimed(ctx)` 在首步工具快照前同步执行：先幂等调用 `ctx.huaanworkTurnAnchors?.notePreStep(sessionId, [message], new Date().toISOString())`（不依赖与 `makeResultPresentClaimed` 的注册先后顺序），仅当 `runs.activeBySession(sessionId)` 存在、状态为 `running`、且 `message.id === active.clientMessageId`（普通/goal 续拍消息均不命中）并持有有效租约时才挂 `expert_team_dispatch`，其余回合对称摘除并 `refreshAgentRestrict`；同步异常必须调用 `agent.cancel({ kind: 'hook', reason: 'expert-team-attachment-sync-failed' })`，不能静默继续。

生产接线：
- `model.ts` 的 `isRegisteredToolName(name)` 增加 `|| name === "expert_team_dispatch"`（与 `result_present`、`call_host_tool` 同列，避免 `HuaAnWorkAdapter` 在解析真实模型 SSE / 文本协议时静默丢弃 `expert_team_dispatch` 调用；执行权限仍由 `present-as` 会话附件与 `policy` attached 门禁双重兜底）；
- `holders.ts` 增加 `huaanworkExpertTeamCoordinator` 声明与 `HUAANWORK_CONTEXT_PROPS`；
- `index.ts`：
  1. 在顶层 `apply(ctx)` 中创建 `coordinator` 挂到 `ctx.huaanworkExpertTeamCoordinator`，并在顶层 `apply(ctx)`（紧邻现有 `makeResultPresentClaimed(ctx)`，**不在** `pc.effect` 内以防 `tools` 重提供时重复挂监听）注册 `ctx.on('agent/inbox/claimed', makeExpertTeamClaimed(ctx), { global: true })`；
  2. 在 `pc.effect` 内把 `ctx.huaanworkExpertTeamCoordinator` 与 `ctx.huaanworkExpertTeamRuns` 一并注入 `toolCtx`（使 `registerExpertTeamDispatchTool` 与 Task 12 的 `registerResultArtifactTools` 在生产运行时共享同一实例），注册 `expert_team_dispatch`；
  3. `pc.effect` disposer 先注销 `expert_team_dispatch`，再串联返回 `runs.cancelAll().finally(() => disposeAgentPackageHostRuntime(agentPackageTurns))`（先取消团队在途运行与成员，再释放包运行时进程，不顶掉既有收尾 promise）。

`policy.ts` 将 `expert_team_dispatch` 加入 `SESSION_ATTACHED_TOOLS`，`decide.ts` 在 `result_present` 后添加：

```ts
case "expert_team_dispatch":
  return input.attached ? ALLOW : deny(reasonToolUnattached(input.name));
```

- [ ] **Step 4: 运行工具、模型流、policy 和既有附件回归测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/expert-team-dispatch.spec.ts tests/huaanwork-guardrails/model.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/huaanwork-guardrails/result-artifact-tools.spec.ts
corepack yarn workspace @huaanwork/policy test
```
Expected: 全部 PASS；真实 SSE 工具流可透传 `expert_team_dispatch`，默认 ask/smart 不逐次审批，未挂载调用在 `preExecute` 与 `guard` 均拒绝。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/expert-team-dispatch.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts dsh-plugin-huaanwork/src/huaanwork-host/holders.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts packages/huaanwork-policy/src/decide.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/expert-team-dispatch.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts packages/huaanwork-policy/src/decide.test.ts
git commit -m "feat(expert-team): attach leader dispatch tool"
```

---

### Task 10: 回合事件观察器与 abort 联动

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-observer.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`

**Interfaces:**
- Consumes: `session/event`、`agent/inbox/claimed`（实测在 `turn/start` **之后**触发，payload 为 `{ agent, message, turn }`）、`turn/end`、`agent/error: isAbortError`、Task 3 `cancelBySession`。
- Produces: `createExpertTeamTurnObserver(options): ExpertTeamTurnObserver`、`bindExpertTeamObserver(ctx, observer): () => void`（以 `{ global: true }` 订阅 `agent/inbox/claimed` 与 `session/event` 并返回统一 disposer），输出 `finalSummaryPresent` 与 `turn/end` 回调事实。
- Produces: `cancelAgent`、`releaseSessionRuntime`（覆盖 `session.remove` 与 task/project 级联删除）及 `bridge.ts` 的 `expertTeamRuns.cancelBySession(sessionId)` 联动与观察器清理。

- [ ] **Step 1: 写 claim 时序（turn/start 先于 claimed）、最终文本、seq 异常与 abort 失败测试**

```ts
it('binds to payload.turn when claimed after turn/start and ignores earlier turns and reasoning', () => {
  const observer = createExpertTeamTurnObserver({ parentSessionId: 's1', followupId: 'm1', onTurnEnd: vi.fn() })
  // 上一普通回合：turn/start 先于 claimed，不匹配 followupId
  observer.event(session('s1'), turnStart({ seq: 1, turn: 1 }))
  observer.claim({ message: { id: 'other' }, turn: 1 })
  observer.event(session('s1'), assistantMessage({ seq: 2, turn: 1, text: '旧回合文本' }))
  observer.event(session('s1'), turnEnd({ seq: 3, turn: 1, reason: { kind: 'completed' } }))

  // 目标团队回合：上游先发 turn/start(turn=2)，随后发 agent/inbox/claimed({ message: { id: 'm1' }, turn: 2 })
  observer.event(session('s1'), turnStart({ seq: 4, turn: 2 }))
  observer.claim({ message: { id: 'm1' }, turn: 2 })
  observer.event(session('s1'), assistantMessage({ seq: 5, turn: 2, text: '先安排成员' }))
  observer.event(session('s1'), toolResult({ seq: 6, turn: 2 }))
  observer.event(session('s1'), assistantMessage({ seq: 7, turn: 2, blocks: [{ type: 'reasoning', text: '思考' }] }))
  expect(observer.finalSummaryPresent()).toBe(false)
  observer.event(session('s1'), assistantMessage({ seq: 8, turn: 2, text: '最终汇总第一段' }))
  observer.event(session('s1'), assistantMessage({ seq: 9, turn: 2, text: '最终汇总第二段' }))
  expect(observer.finalSummaryPresent()).toBe(true)
})

it('uses the last tool result boundary across multiple assistant messages and fails closed on non-monotonic seq', () => {
  const observer = activeObserver({ turn: 2 })
  observer.event(session('s1'), assistantMessage({ seq: 10, turn: 2, text: '过渡语' }))
  observer.event(session('s1'), toolResult({ seq: 11, turn: 2 }))
  observer.event(session('s1'), assistantMessage({ seq: 12, turn: 2, text: '第一段' }))
  observer.event(session('s1'), toolResult({ seq: 13, turn: 2 }))
  observer.event(session('s1'), assistantMessage({ seq: 14, turn: 2, text: '第二段' }))
  observer.event(session('s1'), assistantMessage({ seq: 15, turn: 2, text: '第三段' }))
  expect(observer.finalSummaryPresent()).toBe(true)
  observer.event(session('s1'), turnEnd({ seq: 16, turn: 2, reason: { kind: 'completed' } }))
  expect(observer.turnEndFacts()).toMatchObject({ turn: 2, finalSummaryPresent: true, eventMissing: false })

  const corrupt = activeObserver({ turn: 3 })
  corrupt.event(session('s1'), toolResult({ seq: 20, turn: 3 }))
  corrupt.event(session('s1'), assistantMessage({ seq: 19, turn: 3, text: '乱序/回退 seq 必须 fail-closed' }))
  expect(corrupt.finalSummaryPresent()).toBe(false)
})
```

- [ ] **Step 2: 确认观察器测试失败**

`session(id)`、`turnStart({seq,turn})`、`assistantMessage({seq,turn,text?,blocks?})`、`toolResult({seq,turn})`、`turnEnd({seq,turn,reason})` 是测试文件内的 SessionEvent 工厂，显式带 `turn`/`step=1` 和最小合法 `data`；`activeObserver({ turn })` 按真实上游顺序先发 `turnStart({ seq: 1, turn })` 再调用 `claim({ message: { id: 'm1' }, turn })`。测试不得调用 `snapshotEvents` 或改写 observer 私有状态。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-observer.spec.ts
```
Expected: FAIL，`observer.ts` 不存在。

- [ ] **Step 3: 实现事件观察器与 `{ global: true }` 订阅封装**

```ts
export type ExpertTeamTurnObserver = {
  claim(payload: { message: { id: string }; turn: number }): void
  event(session: { id?: string }, event: SessionEvent): void
  afterIdle(): void
  finalSummaryPresent(): boolean
  turnEndFacts(): { turn: number; finalSummaryPresent: boolean; eventMissing: boolean } | undefined
  dispose(): void
}
```

关键语义：
- 上游 `agent-loop` 在消费收件箱时先发 `turn/start`，再发 `agent/inbox/claimed { agent, message, turn }`；因此 `claim(payload)` 匹配 `payload.message.id === followupId` 后**直接锁定 `activeTurn = payload.turn`**，绝不能在 `claim` 之后等待下一条 `turn/start`（否则永远无法绑定本回合）。
- 仅处理 `session.id === parentSessionId` 且归属 `activeTurn` 的事件；严格校验 `event.seq` 为递增数字（缺失或非严格单调递增时 fail-closed，丢弃本次摘要并标异常）。
- 每个 `tool/result` 更新 `lastToolResultSeq = event.seq` 并清空此前累积的摘要文本；之后对 `event.seq > lastToolResultSeq` 的每条 `assistant/message`，提取 `text` 块并忽略 `reasoning` 块，合并为非空最终汇总（`finalSummaryPresent()`）。
- 当前 `activeTurn` 收到 `turn/end` 时同步锁定事实并只调用一次 `onTurnEnd({ turn, reason, finalSummaryPresent })`（`reason.kind === 'aborted'` 同时调用 `onAbort`），随后忽略后续任何 goal turn 事件；`afterIdle()` 仅在尚未收到当前回合 `turn/end` 时以 `eventMissing: true` 回调，永不调用 `snapshotEvents()`。
- `bindExpertTeamObserver(ctx, observer)` 必须以 `{ global: true }` 订阅 `agent/inbox/claimed`（按 `sessionIdOfAgentRef(payload.agent) === parentSessionId` 过滤后调 `observer.claim(payload)`）与 `session/event`，`dispose()` 同步注销两条监听器防止跨回合泄漏；在 `sessions.ts` 的 `SessionRuntimeContext` 类型上继续补充 Cordis `ctx` 原生具备的可选 `on?(name: string, listener: (...args: never[]) => unknown, options?: boolean | { global?: boolean }): () => void` 以及 `huaanworkExpertTeamCoordinator?`（`huaanworkExpertTeamStore?` / `huaanworkExpertTeamRuns?` 已于 Task 4 补充）。

- [ ] **Step 4: 接入 `cancelAgent`、`releaseSessionRuntime` 与 `bridge.ts` 并写取消/删除测试**

- `cancelAgent`（`sessions.ts`）在 `primary.cancel` 前同步调用 `expertTeamRuns.cancelBySession(sessionId)`；`queueItemId` 分支保持只取消排队消息。
- `releaseSessionRuntime(sessionId)`（`sessions.ts`，被 `session.remove` 及 task/project 级联删除调用）同步调用 `expertTeamRuns.cancelBySession(sessionId)`、注销该会话在途观察器并摘除 `expert_team_dispatch` 附件；Host 卸载由 Task 9 的 `index.ts` disposer 调用 `runs.cancelAll()` 兜底。
- `bridge.ts` 在其 `Context` 类型上声明 `huaanworkExpertTeamRuns?: Pick<ExpertTeamRunRegistry, 'cancelBySession'>`，并在 `session/disposed`、`turn/end: aborted` 与 `agent/error: isAbortError` 三处调用同一 `cancelBySession(sessionId)`，由 Task 3 registry 保证幂等。

新增测试断言：用户停止立即取消等待队列与在途成员、`session.remove` / `releaseSessionRuntime` 立即取消活动团队并卸载观察器、两条 abort 信号只触发一次清理、非 abort error 不变为 stopped、`queueItemId` 不取消活动团队。

- [ ] **Step 5: 运行观察器、会话与 bridge 回归测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-observer.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-guardrails/bridge.spec.ts
```
Expected: 全部 PASS；不新增同步快照读取，无遗留全局监听器。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-observer.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts
git commit -m "feat(expert-team): observe turns and cancellation"
```

---

### Task 11: 团队会话启动、排队隔离与 turn/end 结算

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-session.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`

**Interfaces:**
- Consumes: Task 4 store/availability、Task 8 coordinator（含租约与 `waitMemberCleanups`）、Task 10 observer、Task 6 终态纯函数、`resolveFollowupClientMessageId`。
- Produces: `dispatchExpertTeam(input): Promise<{ text: string; afterIdle: () => Promise<void>; skipPostCleanupIdle: true; abortBeforeSend: (err: unknown) => void }>`、`settleExpertTeamTurn(input)`、`QueueItem.at` 保留 `kind?: 'expert-team'`。

- [ ] **Step 1: 写启动、排队隔离、锚点、goal 和异常路径失败测试**

```ts
it('uses one followupId (both omitted and explicit top-level clientMessageId) for run, anchor and followup and rejects a second team call while active or stopping', async () => {
  const { sessionSend, runs, anchors, followups } = await makeSessionFixture({})
  await sessionSend(teamSend({ task: '审查合同' }))
  const run = runs.activeBySession('s1')!
  const followupId = run.clientMessageId
  expect(followupId).toMatch(/^[0-9a-f-]{36}$/)
  // 通过真实 TurnAnchorStore.notePreStep 验证该 followupId 已以 origin='advanced' 登记为 pending 锚点
  expect(anchors.notePreStep('s1', [{ role: 'user', id: followupId, source: { kind: 'user' } }], new Date().toISOString()))
    .toMatchObject({ clientMessageId: followupId, origin: 'advanced' })
  expect(followups[0]?.id).toBe(followupId)
  // 同一父会话存在活跃/stopping 专家团时，准入前即拒绝，不得进入 turn-scheduler 静默排队
  await expect(sessionSend(teamSend({ task: '第二次团队调用' }))).rejects.toThrow('expert-team-session-busy')

  // 顶层 clientMessageId 存在时同样只计算一次并贯穿 run / anchor / followup
  const explicit = await makeSessionFixture({ clientMessageId: 'explicit-uuid-1' })
  await explicit.sessionSend(teamSend({ task: '显式锚点审查', clientMessageId: 'explicit-uuid-1' }))
  expect(explicit.resolveFollowupIdSpy).toHaveBeenCalledTimes(1)
  expect(explicit.runs.activeBySession('s1')?.clientMessageId).toBe('explicit-uuid-1')
  expect(explicit.anchors.notePreStep('s1', [{ role: 'user', id: 'explicit-uuid-1', source: { kind: 'user' } }], new Date().toISOString()))
    .toMatchObject({ clientMessageId: 'explicit-uuid-1', origin: 'advanced' })
  expect(explicit.followups[0]?.id).toBe('explicit-uuid-1')
})

it('preserves at.kind="expert-team" when queued behind an ordinary turn, rejects disabled/deleted teams without @agent fallback, and releases queued ordinary turns only after settlement and attachment cleanup', async () => {
  const { sessionSend, finishOrdinaryTurn, runs, agentInvokeSpy } = await makeSessionFixture({ ordinaryTurnInFlight: true })
  const queued = await sessionSend(teamSend({ task: '排队中的合规审查' }))
  // sessions.ts 中直接启动也返回 queued: true，必须以 waiting: true, started: false 确认真正进入排队
  expect(queued).toMatchObject({ queued: true, waiting: true, started: false })
  expect(runs.activeBySession('s1')).toBeUndefined()
  await finishOrdinaryTurn()
  expect(runs.activeBySession('s1')?.teamSnapshot.slug).toBe('compliance-team')
  expect(agentInvokeSpy).not.toHaveBeenCalled()

  // 缓存团队已停用或删除时（即使存在同名智能体）：Host 拒绝且绝不回退成普通 @agent
  const disabledFix = await makeSessionFixture({ teamEnabled: false, sameSlugAgentExists: true })
  await expect(disabledFix.sessionSend(teamSend({ task: '停用团队' }))).rejects.toThrow(/expert-team-/)
  expect(disabledFix.runs.list({ sessionId: 's1' }).runs).toEqual([])
  expect(disabledFix.agentInvokeSpy).not.toHaveBeenCalled()

  const deletedFix = await makeSessionFixture({ teamDeleted: true, sameSlugAgentExists: true })
  await expect(deletedFix.sessionSend(teamSend({ task: '已删团队' }))).rejects.toThrow(/expert-team-/)
  expect(deletedFix.agentInvokeSpy).not.toHaveBeenCalled()

  // 团队回合在途时后续普通消息排队；仅在 turn/end 结算并摘除 expert_team_dispatch 附件且 afterIdle 清理后才放行下一条排队消息
  const releaseFix = await makeSessionFixture()
  await releaseFix.sessionSend(teamSend({ task: '先跑团队' }))
  const runId = releaseFix.runs.activeBySession('s1')!.teamRunId
  const queuedOrdinary = await releaseFix.sessionSend({ text: '下一条普通消息', tabId: 'tab-1', sessionId: 's1' })
  expect(queuedOrdinary).toMatchObject({ queued: true, waiting: true, started: false })
  expect(releaseFix.followups).toHaveLength(1)
  releaseFix.observer.event(session('s1'), turnEnd({ seq: 10, turn: 1, reason: { kind: 'completed' } }))
  await releaseFix.finishTeamIdle()
  expect(releaseFix.runs.get(runId)?.status).not.toBe('running')
  expect(isAgentToolAttached(releaseFix.attachments, 's1', 'expert_team_dispatch')).toBe(false)
  expect(releaseFix.followups).toHaveLength(2)
})

it('seals at turn/end before a goal continuation can dispatch and fails closed even if attachment refresh throws during settlement', async () => {
  const { sessionSend, coordinator, observer, goal, runs } = await makeSessionFixture({ activeGoal: true })
  await sessionSend(teamSend({ task: '审查合同' }))
  const runId = runs.activeBySession('s1')!.teamRunId
  observer.event(session('s1'), turnEnd({ seq: 10, turn: 1, reason: { kind: 'completed' } }))
  expect(coordinator.isLeaseValid(runId)).toBe(false)
  goal.continue()
  await expect(coordinator.dispatch(dispatchInput('executor'))).rejects.toThrow('expert-team-terminal')
  expect(runs.get(runId)?.status).not.toBe('running')

  // 上游 invokeContainedSessionObservers 会收容 session/event 异常：即使摘附件/refreshAgentRestrict 抛错，也必须先失效租约并把运行收敛出 running
  const throwFix = await makeSessionFixture({ refreshRestrictThrows: true })
  await throwFix.sessionSend(teamSend({ task: '结算抛错守卫' }))
  const throwRunId = throwFix.runs.activeBySession('s1')!.teamRunId
  expect(() => throwFix.observer.event(session('s1'), turnEnd({ seq: 10, turn: 1, reason: { kind: 'completed' } }))).not.toThrow()
  expect(throwFix.coordinator.isLeaseValid(throwRunId)).toBe(false)
  expect(throwFix.runs.get(throwRunId)?.status).not.toBe('running')
})

it('fails once without duplicate afterIdle settlement when resolveAgent/followup rejects or admission cancels before followup', async () => {
  const { sessionSend, runs, afterIdle, anchors } = await makeSessionFixture({ followupError: new Error('reject') })
  await expect(sessionSend(teamSend({ task: 'x' }))).rejects.toThrow('reject')
  const [failedRun] = runs.list({ sessionId: 's1' }).runs
  expect(failedRun?.status).toBe('failed')
  const revAfterFail = failedRun!.revision
  await afterIdle.invokeFinally()
  expect(runs.get(failedRun!.teamRunId)?.revision).toBe(revAfterFail)
  // pending anchor 已由 sessions.ts catch 回滚，后续同 id pre-step 不得再被认作 advanced
  expect(anchors.notePreStep('s1', [{ role: 'user', id: failedRun!.clientMessageId, source: { kind: 'user' } }], new Date().toISOString())?.origin).toBe('unknown')

  // 另测 admission.cancelled() 在 resolveAgent() 后早退（不抛错、绕过 catch）时，finally 仍调用 abortBeforeSend 且立刻释放名额
  const cancelled = await makeSessionFixture({ cancelBeforeFollowup: true })
  await expect(cancelled.sessionSend(teamSend({ task: 'y' }))).resolves.toMatchObject({ started: false })
  expect(cancelled.runs.activeBySession('s1')).toBeUndefined()
})
```

- [ ] **Step 2: 确认会话集成测试失败**

`makeSessionFixture` 使用 `sessions.spec.ts` 的真实 `sessionSend`/`sendToAgent`/`turnAnchors`/`turnScheduler` 与真实 `AttachmentMaps`（`emptyAttachments()`）组合和可脚本化 Agent，支持 `clientMessageId`、`ordinaryTurnInFlight`、`teamEnabled`、`teamDeleted`、`sameSlugAgentExists`、`activeGoal`、`refreshRestrictThrows`、`followupError`、`cancelBeforeFollowup` 选项，返回 `runs`、`anchors`、`attachments`、`followups`、`observer`、`coordinator`、`goal`、`agentInvokeSpy`、`resolveFollowupIdSpy`、`finishOrdinaryTurn`、`finishTeamIdle` 与 `afterIdle.invokeFinally()`；`teamSend({ task, clientMessageId? })` 生成 `at: { kind: 'expert-team', name: 'compliance-team' }` 的完整 params，`dispatchInput` 在本文件按 Task 8 的同一字段结构（含 `callId`）生成。`goal.continue()` 通过 `goal-round-driver` 的同款 followup 唤醒，而不是直接改 coordinator 状态。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-session.spec.ts
```
Expected: FAIL，团队发送分支与 `turn-scheduler` `at.kind` 透传不存在。

- [ ] **Step 3: 实现准入前拦截、排队 `at.kind` 透传、统一 `followupId` 与异常/早退回滚**

- `turn-scheduler.ts` 与 `sessions.ts:1346` 联动保留 `at.kind`：`turn-scheduler.ts` 的 `QueueItem.at` 和 `admitUserTurn` 参数扩展保留 `kind?: 'expert-team'`；同时修改 **`sessions.ts:1346`**（当前该行把 `params.at` 重建为 `{ name: atName, ...(atClientMessageId ...) }` 会丢弃 `kind`），改为同步透传 `kind: 'expert-team'`（`startQueuedItem` 在 `sessions.ts:1232` 原样传 `at: item.at`），确保排队出队后绝不误入普通 `@<slug>` 路径。
- `sessionSend`（`sessions.ts`）在调用 `admitUserTurn` **之前**：若 `at?.kind === 'expert-team'`，校验正文非空（空任务直接拒 `expert-team-task-empty`）且 `runs.hasActiveForSession(sessionId)` 必须为 `false`（包含 `running` 与 `stopping`，命中即拒 `expert-team-session-busy`，绝不排队第二次团队调用）。
- `sendToAgent`（`sessions.ts`）：在 `dispatchAt` 前只计算一次 `followupId = resolveFollowupClientMessageId(params)`，后续单次 `turnAnchors.register({ sessionId, clientMessageId: followupId, origin })`（沿用真实单对象签名）与 `agent.followup({ id: followupId, ... })` 复用同一 ID（`dispatchExpertTeam` 不重复调用 `turnAnchors.register`）。当 `at.kind === 'expert-team'` 时走 `dispatchExpertTeam`，typed token 永不回退智能体；并在出队执行前再次校验 `hasActiveForSession` 与团队存在、已启用、定义完整且全部成员可用（缓存中已停用/已删除团队直接拒绝，不回退同名 `@agent`）。
- `dispatchExpertTeam` 创建运行、登记租约与 `attachCancel`、挂载 Task 10 全局 observer，并组装团长提示词（成员名册、职责、结构化调度、`[VERDICT: PASS]`/`[VERDICT: REVISE]` 末行标记与交付模式：Artifact 模式指示最终调用 `result_present`，`message` 模式明确禁止该工具）。
- 在 `sendToAgent` 的 `finally` 中 `if (!followupAccepted)` 入口（位于 `if (afterIdle === undefined)` 判支**之前**），统一执行团队 `abortBeforeSend`（原地置 `failed`/取消、失效租约、摘除附件、dispose observer）并将 `afterIdle = undefined`——从而同时覆盖 `resolveAgent()`/`agent.followup()` 抛错与 `admission?.cancelled?.()` 第 510 行早退（不经过 `catch`）两条路径，保证立即走 `restoreProvisionalBindings?.()` + `releaseOnce?.()` 释放名额，而 `followup` 抛错的 `rollbackAnchor?.()` 继续由既有 `sessions.ts:549` 负责；此外在 `sessions.ts` 的 `cleanup` 中，对 `skipPostCleanupIdle === true` 的团队回合跳过第二次 `acceptedAgent?.whenIdle?.()` 等待，避免被后续 goal turn 拖住或污染终态。

- [ ] **Step 4: 实现 `turn/end` 同步封闭、fail-closed 异常守卫与 `afterIdle` 收敛**

由于上游 `session/index.ts:399-416`（`invokeContainedSessionObservers`）会捕获并仅 `warn` 记录 `session/event` 监听器抛出的异常，**`settleExpertTeamTurn` 必须内置 fail-closed 顺序与异常守卫**（遵守规格 §10.3 / §16.10，禁止因清理异常导致运行滞留在 `running`）：
1. **第一步无条件同步执行** `coordinator.invalidateLease(teamRunId)`（绝不抛出，先封死后续派工）；
2. **第二步独立 `try/catch`** 摘除 `expert_team_dispatch` 附件并调用 `refreshAgentRestrict`，若抛错则记录 `protocolError = 'expert-team-attachment-detach-failed'` 而不中断结算（且绝不回滚已失效的租约）；
3. **第三步封闭派工并写状态**（终态闩与 Artifact 的 `deliverySealed` 严格分离，不得用后者代替回合终态），外层再包一层兜底 `try/catch`，一旦结算计算本身异常，仍以 `partial`（有有效结果）或 `failed`（无有效结果）落地终态并记录 `failure`：
   - 若 `reason.kind === 'aborted'` 或取消闩已置位：同步确保 `runs.requestCancel`（`stopping`）已触发且取消队列与在途成员；`afterIdle` 等待 `coordinator.waitMemberCleanups(teamRunId)` 与 observer dispose 后调用 `runs.markStopped(teamRunId)` 收敛为 `stopped`。
   - 非取消路径：同步调用 Task 6 `computeExpertTeamTerminalStatus`（透传上述 `protocolError`）写入终态；`afterIdle` 仅执行 observer dispose 与幂等清尾。
   - 缺失 `turn/end`：在 `afterIdle` 立即走同一 fail-closed 顺序封闭租约/附件/派工并按 `eventMissing: true` 写 `partial`/`failed`，不归入后续 goal turn。

- [ ] **Step 5: 运行团队会话与既有会话回归测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-session.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/expert-team-observer.spec.ts
```
Expected: 全部 PASS；同会话第二团队立即拒绝、普通回合后排队的团队保留 `at.kind`、goal 续拍不能迟到派工、普通 `session.send` 路径不回归。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/expert-team/session.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/turn-scheduler.ts dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts dsh-plugin-huaanwork/src/huaanwork-host/expert-team/observer.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-session.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
git commit -m "feat(expert-team): run and settle team turns"
```

---

### Task 12: result_present 团队交付与预算豁免

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/result-artifact-tools.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifacts-host.spec.ts`

**Interfaces:**
- Consumes: Task 3 `byTurn`/`sealDelivery`/`noteSessionArtifact`/`noteArtifactLinkError`、Task 6 `canSubmitPrimaryArtifact`、Task 8 `isLeaseValid`、Task 9 在 `index.ts` `toolCtx` 中已注入的 `huaanworkExpertTeamRuns` 与 `huaanworkExpertTeamCoordinator`、既有 ArtifactHost 两阶段协议。
- Produces: 团队 `result_present` 提交前校验、`message` 模式 claim 门控、commit 前取消/租约复查、commit→seal→note→emit 和同 `callId` 幂等重放（含关联恢复）。

- [ ] **Step 1: 写提交守卫、24 次豁免、同 callId 重放与关联失败测试**

```ts
it('allows an exhausted-budget partial artifact without waiving other guards', async () => {
  const { execute, runs, runId } = await makeResultPresentFixture({ dispatchAttempts: 24, missingReview: true, validExecution: true })
  await expect(execute({ title: '部分报告', format: 'markdown', content: '# 部分结论\n\n缺审说明' })).resolves.toContain('artifactId')
  const run = runs.get(runId)!
  expect(run.primaryArtifactId).toBeDefined()
  expect(run.deliverySealed).toBe(true)
  expect(run.artifactStatus).toBe('created')
})

it('recovers the persisted-anchor link on same-callId replay after an initial link failure', async () => {
  const { execute, runs, runId, setCurrentAnchor, noteSessionArtifactSpy } = await makeResultPresentFixture({ validExecution: true, clientMessageId: 'm1', failFirstLink: true })
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  expect(runs.get(runId)).toMatchObject({ artifactStatus: 'pending', artifactLinkError: 'expert-team-artifact-link-failed' })
  setCurrentAnchor('m2')
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  expect(runs.get(runId)).toMatchObject({ artifactStatus: 'created', deliverySealed: true })
  expect(runs.get(runId)?.artifactLinkError).toBeUndefined()
  expect(noteSessionArtifactSpy).toHaveBeenLastCalledWith('s1', 'call-1', expect.objectContaining({ anchor: { kind: 'turn', clientMessageId: 'm1' } }))
  expect(runs.byTurn('s1', 'm2')).toBeUndefined()
})

it('replays the same callId against its persisted manifest anchor even when current anchor differs, and rejects a new callId after sealing', async () => {
  const { execute, runs, runId, emitted, setCurrentAnchor } = await makeResultPresentFixture({ validExecution: true, clientMessageId: 'm1' })
  // 首次 commit 在锚点 m1 成功，模拟此前关联尚未完成（或直接验证重放不改锚）
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  const originalArtifactId = runs.get(runId)!.primaryArtifactId!
  // 把当前会话锚切换为不同的 m2（证明重放读的是 commit 返回的持久 manifest 锚 m1，而非 current() 锚 m2）
  setCurrentAnchor('m2')
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  expect(runs.get(runId)?.primaryArtifactCallId).toBe('call-1')
  expect(runs.get(runId)?.primaryArtifactId).toBe(originalArtifactId)
  expect(runs.byTurn('s1', 'm2')).toBeUndefined()
  // 切回 m1 后不同 callId 的二次提交被交付封闭拒绝
  setCurrentAnchor('m1')
  await expect(execute({ callId: 'call-2', title: '第二份', format: 'markdown', content: '# 不应创建' })).rejects.toThrow('expert-team-delivery-sealed')
  expect(emitted.filter((event) => event.event === 'artifact/created')).toHaveLength(1)
})

it('keeps artifactStatus pending on Artifact prepare/commit write failure, allows same-turn retry, and settles partial/failed if turn ends unrecovered', async () => {
  const { execute, runs, runId, emitted, settleTurn } = await makeResultPresentFixture({ validExecution: true })
  // 超过 5 MiB 触发真实 prepareArtifact 拒绝 artifact-too-large（不静默截断、不封存交付）
  await expect(execute({ callId: 'call-big', title: '超大报告', format: 'markdown', content: 'x'.repeat(5 * 1024 * 1024 + 1) }))
    .rejects.toThrow('artifact-too-large')
  expect(runs.get(runId)).toMatchObject({ artifactStatus: 'pending', deliverySealed: false })
  expect(runs.get(runId)?.primaryArtifactId).toBeUndefined()
  expect(emitted.filter((event) => event.event === 'artifact/created')).toHaveLength(0)
  // 未重试直接结算回合：有有效执行结果为 partial（无有效执行结果用例则断言 failed）
  expect(settleTurn()).toBe('partial')

  // 同回合修正体积后重调 result_present 可正常 commit 并封存
  const retryFix = await makeResultPresentFixture({ validExecution: true })
  await expect(retryFix.execute({ callId: 'call-big-2', title: '超大报告', format: 'markdown', content: 'x'.repeat(5 * 1024 * 1024 + 1) }))
    .rejects.toThrow('artifact-too-large')
  await expect(retryFix.execute({ callId: 'call-ok', title: '修正报告', format: 'markdown', content: '# 修正后正文' }))
    .resolves.toContain('artifactId')
  expect(retryFix.runs.get(retryFix.runId)).toMatchObject({ artifactStatus: 'created', deliverySealed: true })
})
```

另测：
- `prepare` 后 `commit` 前取消或租约失效（仅针对新提交 `!isIdempotentReplay`）直接 discard 不创建 Artifact；
- `noteSessionArtifact` 返回 `false` 时调用 `runs.noteArtifactLinkError`，保留 Artifact 文件与 `artifact/created` 事件、团队维持 `artifactStatus: 'pending'` 与终态 `partial`；
- `message` 模式 claim 不挂 `result_present`；
- 24 次前有在途或无有效结果不能使用预算豁免；
- 后续普通用户回合（新 `clientMessageId`）调用 `result_present` 不受前一已封存团队回合影响；
- 验证 `index.ts` `toolCtx` 透传了 `huaanworkExpertTeamRuns` 与 `huaanworkExpertTeamCoordinator` 给 `registerResultArtifactTools`。

- [ ] **Step 2: 确认 Artifact 测试失败**

`makeResultPresentFixture` 使用真实 `result-artifact-tools.ts` 和 ArtifactHost，以当前 `huaanworkTurnAnchors.current(sessionId)`、`callId`、真实 `ExpertTeamRunRegistry`、`coordinator` 和 `emitted` 事件构造 `execute(args)`，并暴露 `setCurrentAnchor(clientMessageId)`（切换当前会话锚点以验证重放以持久 manifest 锚为准）、`noteSessionArtifactSpy`（记录实际关联调用的父会话、callId 与 artifact summary）与 `settleTurn()`（按当前 `runs.get(runId)` 调用 Task 6 终态函数）；`failFirstLink: true` 让 registry 的首次 `noteSessionArtifact` 返回 `false`（模拟 commit 成功但关联失败），后续重放恢复真实关联；所有默认运行由 Task 1 `validTeam()` 创建，只有测试声明的 `dispatchAttempts`/`missingReview`/`validExecution`/`clientMessageId` 等字段不同。返回的 `artifact.content` 在 driver 中统一解码为 UTF-8 字符串。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/result-artifact-tools.spec.ts
```
Expected: FAIL，团队提交守卫与关联钩子不存在。

- [ ] **Step 3: 实现 claim 门控与基于 `runs.byTurn` 的提交前校验**

- `ToolContext`（`result-artifact-tools.ts:57-62`）扩展可选 `huaanworkExpertTeamRuns?: ExpertTeamRunRegistry` 与 `huaanworkExpertTeamCoordinator?: Pick<ExpertTeamCoordinator, 'isLeaseValid' | 'hasInFlight'>`；同时扩展 **`ResultPresentClaimedContext`**（`result-artifact-tools.ts:132-135`）增加可选 `huaanworkExpertTeamRuns?: Pick<ExpertTeamRunRegistry, 'byTurn'>`（生产环境中由 Task 9 已接入的 `index.ts` `toolCtx` 与顶层 `ctx` 注入）。
- `makeResultPresentClaimed` 在现有 `origin === 'advanced'` 判定上增加：通过 `runs.byTurn(sessionId, anchor.clientMessageId)` 查当前回合所属团队运行，若 `teamRun.teamSnapshot.summary.delivery === 'message'` 则 `wantAttached = false`；Artifact 模式团队和普通高级会话保持原行为。
- `execute` 在 `beginArtifactWrite` 前用 `runs.byTurn(sessionId, anchor.clientMessageId)` 查找本回合团队（不依赖 `activeBySession`，确保已终态/已封存的团队回合在同锚 goal continuation 中仍被命中，而下一条普通用户回合 `m2` 查不到团队运行、保持普通语义）：
  - 计算 `const isIdempotentReplay = teamRun !== undefined && teamRun.primaryArtifactCallId !== undefined && teamRun.primaryArtifactCallId === exec.callId`；
  - 若 `teamRun !== undefined && !isIdempotentReplay`：调用 Task 6 `canSubmitPrimaryArtifact(teamRun, { inFlight: coordinator.hasInFlight(teamRun.teamRunId), artifactFormat: args.format, callId: exec.callId })` 并校验 `coordinator.isLeaseValid(teamRun.teamRunId)`，不通过直接抛出具名错误；
  - 若 `isIdempotentReplay`：放行进入幂等重放路径（不因 `deliverySealed` 或后续取消误拒）。

- [ ] **Step 4: 实现新提交的取消/租约复查和按持久 manifest 锚的 commit 后关联**

- `prepare` 后、`commitPreparedArtifact` 前：仅对命中 `teamRun` 的新提交（`teamRun !== undefined && !isIdempotentReplay`）再次检查取消闩（`teamRun.status === 'stopping'` 或已终态）与 `coordinator.isLeaseValid(teamRun.teamRunId)`；若已取消/失效，立即 `discardPreparedArtifact` 并抛错，绝不提交新 Artifact。
- `commitPreparedArtifact` 返回 `{ artifact, created }` 后，**一律以持久化 `artifact.anchor`（而非当前 `huaanworkTurnAnchors.current(sessionId)`）解析目标运行** `const persistedRun = artifact.anchor.kind === 'turn' && artifact.anchor.clientMessageId ? runs?.byTurn(sessionId, artifact.anchor.clientMessageId) : undefined`：
  1. 若 `created === true` 且 `teamRun !== undefined`：先调用 `runs.sealDelivery(teamRun.teamRunId, exec.callId)`；再调用 `const linked = runs.noteSessionArtifact(sessionId, exec.callId, artifact)`；若 `!linked`，调用 `runs.noteArtifactLinkError(teamRun.teamRunId, 'expert-team-artifact-link-failed')`（**绝不**抛“Artifact 未创建”的假错误、也不删除已持久化的 Artifact）；
  2. 若 `created === false`（同 `callId` 幂等重放，即使此时当前锚已切走）：**绝不用本次重放去 `sealDelivery` 当前锚对应的其他运行**；仅对持久锚命中的 `persistedRun`（若存在）幂等调用 `runs.sealDelivery(persistedRun.teamRunId, exec.callId)` 与 `runs.noteSessionArtifact(sessionId, exec.callId, artifact)` 以恢复此前可能失败的关联（仍不命中时对 `persistedRun` 记 `noteArtifactLinkError`）；
  3. 仅在 `created === true` 时 emit `artifact/created`。

- [ ] **Step 5: 运行 Artifact 全量回归测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/result-artifact-tools.spec.ts tests/huaanwork-host/artifacts-host.spec.ts tests/huaanwork-host/artifact-routes.spec.ts
```
Expected: 全部 PASS；普通 `result_present`、幂等和 Artifact 卡行为不回归。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts dsh-plugin-huaanwork/src/huaanwork-host/expert-team/coordinator.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/result-artifact-tools.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifacts-host.spec.ts
git commit -m "feat(expert-team): deliver primary artifacts"
```

---

### Task 13: 客户端团队运行投影与卡片锚定

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamRuns.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamRuns.spec.ts`

**Interfaces:**
- Consumes: Task 3 `ExpertTeamRun`、`ExpertTeamRunSnapshot`、`expertTeam/run`、`expertTeam/run-remove`（均含单调 `revision`）、顶层 `clientMessageId`。
- Produces: `ExpertTeamRunsState`、`ExpertTeamRunAction`、`ExpertTeamRunCardItem`、`reduceExpertTeamRuns`、`insertExpertTeamRunCard`、`expertTeamCounts`、`isExpertTeamTerminal`。

- [ ] **Step 1: 写乱序、换代、空快照按会话对账、断连、淘汰和锚定失败测试**

```ts
it('merges only same-generation revisions in order and prevents status regressions', () => {
  let state = emptyExpertTeamRuns()
  state = reduceExpertTeamRuns(state, { type: 'snapshot', sessionId: 's1', generation: 'g1', revision: 2, runs: [run({ revision: 2 })] })
  state = reduceExpertTeamRuns(state, { type: 'run', generation: 'g1', run: run({ revision: 1, status: 'failed' }) })
  expect(state.runs.get('run-1')).toMatchObject({ revision: 2, status: 'running' })
  state = reduceExpertTeamRuns(state, { type: 'run', generation: 'g1', run: run({ revision: 3, status: 'completed' }) })
  expect(state.runs.get('run-1')).toMatchObject({ revision: 3, status: 'completed' })
  // 同代空快照在 snapshot.revision >= existing.revision 时仅清理当前 sessionId 的缺失终态，不误删新于 snapshot.revision 的运行或其他 tab
  state = reduceExpertTeamRuns(state, { type: 'snapshot', sessionId: 's1', generation: 'g1', revision: 4, runs: [] })
  expect(state.runs.has('run-1')).toBe(false)
})

it('freezes timers on disconnect, unfreezes on same-generation reconnect snapshot, and drops old-generation cards on Host restart', () => {
  let state = stateWithActiveRun({ startedAt: '2026-01-01T00:00:00Z' })
  state = reduceExpertTeamRuns(state, { type: 'disconnect', at: '2026-01-01T00:00:05Z' })
  expect(state.connection).toBe('closed')
  expect(state.frozenAt).toBe('2026-01-01T00:00:05Z')

  // 同代重连 snapshot 必须恢复 connection='open' 并清除 frozenAt，使运行卡操作立即可用
  state = reduceExpertTeamRuns(state, { type: 'snapshot', sessionId: 's1', generation: 'g1', revision: 2, runs: [run({ revision: 2 })] })
  expect(state.connection).toBe('open')
  expect(state.frozenAt).toBeUndefined()
  expect(state.runs.get('run-1')?.revision).toBe(2)

  // 再次断连后换代：清空旧运行、恢复 open 并清除 frozenAt
  state = reduceExpertTeamRuns(state, { type: 'disconnect', at: '2026-01-01T00:00:10Z' })
  state = reduceExpertTeamRuns(state, { type: 'snapshot', sessionId: 's1', generation: 'g2', revision: 0, runs: [] })
  expect(state.runs.size).toBe(0)
  expect(state.generation).toBe('g2')
  expect(state.connection).toBe('open')
  expect(state.frozenAt).toBeUndefined()
})

it('anchors the aggregate card after the exact user clientMessageId', () => {
  const items = [userItem('m1'), assistantItem('a1'), userItem('m2')]
  let nextId = 100
  const inserted = insertExpertTeamRunCard(items, {
    teamRunId: 'run-1',
    clientMessageId: 'm1',
    allocateId: () => ++nextId,
  })
  expect(inserted.map((item) => item.kind)).toEqual(['user', 'expert-team-run', 'assistant', 'user'])
})
```

另以每父会话 20/全局 100 的小参数 fixture 验证终态淘汰（活跃与 `stopping` 不淘汰）、`remove` 校验 `generation` 与 `existing.revision <= action.revision`、以及 `run-remove` 不删除 Artifact 项。

- [ ] **Step 2: 确认客户端投影测试失败**

`emptyExpertTeamRuns()` 返回空 `Map`/revision `0`/`open` 状态；`run(overrides)` 以 Task 1 团队生成 `teamRunId='run-1'`、`parentSessionId='s1'`、`clientMessageId='m1'`、`revision=1` 的运行；`stateWithActiveRun()` 保留该 running 项；`userItem(id)`/`assistantItem(id)` 只构造会话流所需字段。所有工厂在测试文件内显式定义，Artifact 项用 Task 1 `artifact()` 创建。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/expertTeamRuns.spec.ts
```
Expected: FAIL，`expertTeamRuns.ts` 不存在。

- [ ] **Step 3: 实现 reducer、淘汰和锚定**

```ts
export type ExpertTeamRunsState = {
  generation?: string
  revision: number
  runs: ReadonlyMap<string, ExpertTeamRun>
  connection: 'open' | 'closed'
  frozenAt?: string
}
export type ExpertTeamRunAction =
  | { type: 'snapshot'; sessionId?: string; generation: string; revision: number; runs: ExpertTeamRun[] }
  | { type: 'run'; generation: string; run: ExpertTeamRun }
  | { type: 'remove'; generation: string; revision: number; teamRunId: string; parentSessionId: string }
  | { type: 'disconnect'; at: string }
export type ExpertTeamRunCardItem = { id: number; kind: 'expert-team-run'; teamRunId: string }
```

语义与 `subagentRuns.ts`（特别是 `reduceSnapshot` L219-224 每次快照均返回 `connection: "live"` 且不携带 `frozenAt`）对齐并遵守规格 §8.5/§13.3/§16：
- `snapshot` 是 `generation` 与连接恢复的唯一来源：**无论换代还是同代重连，任何 `snapshot` 都必须恢复 `connection = 'open'` 并清除 `frozenAt`**。换代（`state.generation !== undefined && state.generation !== action.generation`）时清空旧运行，不标 `interrupted`、不保留旧 `running`，并重置 `revision = action.revision`。
- 同代 `snapshot`：恢复 `connection = 'open'`、清除 `frozenAt`，更新 `revision = Math.max(state.revision, action.revision)`，仅写入 `existing === undefined || existing.revision <= action.revision` 的项；对同代中缺席于 `action.runs` 的终态运行，**仅当**其属于 `action.sessionId`（或 `action.runs` 涉及的父会话）且 `existing.revision <= action.revision` 且 `isExpertTeamTerminal(existing)` 时移除（绝不误删其他 tab、活跃/`stopping` 或捕获快照后新到达的高 `revision` 运行）。
- 同代 `run`：只接受严格更高的 `revision`，并禁止终态回退为 `running`/`stopping` 或 `stopping` 回退为 `running`。
- `remove`：校验同 `generation`、`existing.revision <= action.revision` 且 `isExpertTeamTerminal(existing)` 才移除。
- `disconnect` 只设 `connection = 'closed'` 并冻结首次 `frozenAt`，绝不把 `running` 改成 `stopped`。
- 实现每父会话 20 / 全局 100 的终态淘汰。
- `insertExpertTeamRunCard(items, { teamRunId, clientMessageId, allowSnapshotFallback, allocateId })`：与 `insertSubagentRunCard` 同构，优先按顶层 `clientMessageId` 精确锚定在对应 `user` 条目之后（已存在同 `teamRunId` 时去重返回原数组），仅当 `allowSnapshotFallback === true`（重连 snapshot 对账）且未精确命中时才允许回退到最后一条 `user` 消息之后。

- [ ] **Step 4: 运行客户端投影测试与类型检查**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/expertTeamRuns.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.client.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamRuns.ts dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamRuns.spec.ts
git commit -m "feat(expert-team): project runs on client"
```

---

### Task 14: 专家团管理页与结构化编辑器

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamsView.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamListPanel.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamEditor.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/ExpertTeamsView.spec.ts`

**Interfaces:**
- Consumes: Task 1 校验、Task 4 `expertTeam.list`（含已过滤健康 `AgentPackageListItem[]` 与 `ExpertTeamMemberCapabilities`）与 CRUD/`invocableList`、`expertTeam/changed` 事件（严禁从 `AgentListItem` 或 `catalogAgents` 构造可选成员）。
- Produces: `ExpertTeamsView`、`ExpertTeamListPanel`、`ExpertTeamEditor` 和 `App.tsx` 的 `View = 'teams'` 分支与 `expertTeam/changed` 刷新接入。

- [ ] **Step 1: 写列表、编辑器、成员排序、损坏记录删除与可用性失败测试**

使用 `// @vitest-environment jsdom` 和有状态 Harness：

```tsx
it('creates a team with structured rules, ordered members, and native package capabilities summary', async () => {
  const harness = renderExpertTeamsView()
  await harness.click('新建专家团')
  await harness.fill('名称', '合规审查小分队')
  await harness.fill('描述', '审查合同与业务数据')
  await harness.fill('适用场景', '合同合规')
  await harness.addMember({ slug: 'writer', role: 'executor', responsibility: '提取条款' })
  await harness.addMember({ slug: 'reviewer', role: 'reviewer', responsibility: '统一合规审查' })
  expect(harness.text()).toContain('HTTP / MCP') // 展示包原生能力摘要
  await harness.click('成员 reviewer：上移')
  expect(harness.memberSlugs()).toEqual(['reviewer', 'writer'])
  await harness.select('执行顺序', 'sequential')
  expect(harness.field('最大并发')).toBeDisabled()
  await harness.click('保存专家团')
  expect(harness.lastCreate()).toMatchObject({ slug: expect.any(String), review: { mode: 'unified', maxRevisionRounds: 1 }, orchestration: { executionOrder: 'sequential' } })
})

it('shows unavailable members without blocking edits to other fields, and allows deleting corrupt team files', async () => {
  const harness = renderExpertTeamsView({ teams: [teamWithMissingMember(), corruptTeamRecord('corrupt-1')] })
  expect(harness.text()).toContain('成员失效')
  expect(harness.text()).toContain('定义文件已损坏')
  await harness.click('删除损坏记录 corrupt-1')
  await harness.click('确认删除')
  expect(harness.lastRemove()).toEqual({ id: 'corrupt-1' })
  await harness.click('编辑')
  await harness.fill('描述', '更新后的描述')
  await harness.click('保存专家团')
  expect(harness.lastUpdate().patch.description).toBe('更新后的描述')
  expect(harness.invocableSlugs()).not.toContain('missing-member-team')
})

it('toggles enabled status, displays incomplete badges, enforces editor rule linkages, guards unsaved leave, and preserves draft on field errors', async () => {
  const harness = renderExpertTeamsView({
    teams: [validTeamRecord(), incompleteTeamRecord('incomplete-1')],
    createResult: { ok: false, fieldErrors: [{ field: 'slug', message: '调用名已存在' }] },
  })
  expect(harness.text()).toContain('配置不完整')
  // 启停 toggle 后标为已停用且从 @ 可选列表排除
  await harness.click('停用 compliance-team')
  expect(harness.text()).toContain('已停用')
  expect(harness.invocableSlugs()).not.toContain('compliance-team')

  // 编辑器联动：仅会话隐藏 Artifact 格式；无 reviewer 时审查模式锁定为 none；未保存离开弹确认；字段错误回显并保留草稿
  await harness.click('新建专家团')
  await harness.fill('名称', '草稿团队')
  await harness.fill('描述', '草稿描述')
  await harness.addMember({ slug: 'writer', role: 'executor', responsibility: '执行 1' })
  await harness.addMember({ slug: 'writer-2', role: 'executor', responsibility: '执行 2' })
  expect(harness.field('审查模式')).toHaveValue('none')
  expect(harness.field('审查模式')).toBeDisabled()
  await harness.select('默认交付', 'message')
  expect(harness.queryField('报告格式')).toBeNull()
  await harness.click('保存专家团')
  expect(harness.text()).toContain('调用名已存在')
  expect(harness.field('名称')).toHaveValue('草稿团队')
  await harness.click('返回列表')
  expect(harness.text()).toContain('未保存')
})
```

- [ ] **Step 2: 确认组件测试失败**

`renderExpertTeamsView` 使用真实组件和 fake `expertTeam.*` RPC（`list` 返回 `{ teams, packages }`，其中 `packages` 为健康 `AgentPackageListItem` 附带 `capabilities`，支持可选 `createResult` 覆盖保存回包）；Harness 的 `fill`/`addMember`/`select`/`click`/`field`/`queryField`/`memberSlugs`/`lastCreate`/`lastUpdate`/`lastRemove`/`invocableSlugs` 只通过 DOM 与记录调用实现，不直接修改编辑器 state。`validTeamRecord()`、`teamWithMissingMember()`（将 reviewer slug 改为不存在的包）、`incompleteTeamRecord(id)`（返回 `availability.kind = 'incomplete'`）与 `corruptTeamRecord(id)`（返回 `{ id, error: 'expert-team-corrupt', availability }`）均基于 Task 1 `validTeam()` 构造。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ExpertTeamsView.spec.ts
```
Expected: FAIL，管理组件不存在。

- [ ] **Step 3: 实现列表与编辑器**

`ExpertTeamsView` 用页面内部选中态切换列表和编辑器，不增加 URL 路由。`ExpertTeamListPanel` 复用 `page-view`/`page-head`/`search-input`/`recent-list`/`hint`/`banner` 模式：
- 正常定义卡片展示名称、描述、场景、成员数、调度/审查/交付和可用性，支持编辑、启停、二次确认删除；
- 损坏定义记录（`record.error === 'expert-team-corrupt'`）显式展示“定义文件已损坏”徽标、记录 `id` 与可点击的二次确认删除按钮（编辑/启停禁用），满足规格 §9.3。

`ExpertTeamEditor` 分基本信息、成员与职责、调度规则、审查与汇总四区。首次编辑自动生成可修改 slug，首次保存后锁定并展示实际 `@team:<slug>`；保存前摘要集中列出成员角色、调度、并发/24 次预算、包原生能力（`tools`、`skillScripts`）、必审名单/返修上限、交付格式。成员选择**只消费** `expertTeam.list` 返回的健康 `packages`（`AgentPackageListItem` + `capabilities`，已由 Task 4 过滤为 `enabled && !broken && !revoked` 且排除 legacy/tool），展示名称、来源（`local`/`catalog`）、版本、描述和包原生能力；支持上下排序、角色、职责、输出要求。结构化控件和默认值严格来自 Task 1，无 reviewer 时 review 只能 `none`；仅会话模式隐藏 Artifact 格式。离开有未保存确认，保存失败（`ok: false, fieldErrors`）按字段回显并保留草稿。

- [ ] **Step 4: 接入侧边栏、`expertTeam/changed` 刷新与样式并运行测试**

`App.tsx` 仅在 View 联合、智能体与知识库之间的导航按钮、视图渲染分支及 `expertTeam/changed` 事件触发列表刷新四处接入，自动化和插件市场顺序不变。新增 CSS 类复用现有 token；运行：

```bash
corepack yarn workspace dsh-plugin-huaanwork gen:styles
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ExpertTeamsView.spec.ts tests/client-huaanwork/styles-generated.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.client.json --noEmit
```
Expected: 全部 PASS，生成样式与源类名一致。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamsView.tsx dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamListPanel.tsx dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamEditor.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/tests/client-huaanwork/ExpertTeamsView.spec.ts
git commit -m "feat(expert-team): add team management views"
```

---

### Task 15: @team 检索、键盘交互与发送

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/ComposerMentionMenu.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AtAgentMenu.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamsLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agentsLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`（存在性 regex 钉死 `App.tsx` 触发接线）

**Interfaces:**
- Consumes: Task 1 中文检索、Task 4 `invocableList`、`expertTeam/changed`。
- Produces: `composerAtTokenAt`、`resolveComposerMentionState`（开头优先走 `composerAtTokenAt` 同时开放“智能体”与“专家团”两组，非开头回落 `atTokenAt` 仅开放“智能体”组）、`leadingTeamAtSlug`、`parseTeamAtInvoke`（判别联合）、`mentionKeyAction`、`ComposerMentionMenu` 分组/图标支持、`SessionSendParams.at.kind = 'expert-team'`。
- Constraint: 旧 `atTokenAt`（保留任意位置匹配与 ASCII `/^[a-z0-9-]*$/` 契约）/`parseAtInvoke` 函数与 `@<agent-slug>` 路径不改；**owner 裁定（2026-11-22）：旧 `@` 菜单保留任意位置触发，仅专家团分组与 `parseTeamAtInvoke` 限开头，不得整体替换 `App.tsx:1230` 触发**。

- [ ] **Step 1: 写中文/team 词法、中段旧 `@` 任意位置回归、空任务拦阻、IME 与发送失败测试**

```ts
it('extracts leading team/Chinese @ tokens while keeping arbitrary-position legacy @agent menu triggers', () => {
  expect(composerAtTokenAt('@合规', 3)).toEqual({ query: '合规', start: 0, end: 3 })
  expect(composerAtTokenAt('@team:comp', 10)).toEqual({ query: 'team:comp', start: 0, end: 10 })
  expect(composerAtTokenAt('正文 @合规', 6)).toBeUndefined()
  expect(leadingTeamAtSlug('@team:compliance ')).toBe('compliance')

  // owner 裁定回归：正文中段输入 @agent 仍由 atTokenAt 触发补全，但只开放智能体分组、不开放专家团分组
  expect(resolveComposerMentionState('请看 @writer', 10)).toEqual({
    token: { query: 'writer', start: 3, end: 10 },
    allowTeams: false,
  })
  expect(resolveComposerMentionState('@合规', 3)).toEqual({
    token: { query: '合规', start: 0, end: 3 },
    allowTeams: true,
  })
  expect(resolveComposerMentionState('正文 @合规', 6)).toBeUndefined()
})

it('classifies leading @team targets into valid, empty-task, conflict, or non-team', () => {
  expect(parseTeamAtInvoke('@team:compliance 审查合同')).toEqual({ kind: 'valid', name: 'compliance', remainder: '审查合同' })
  expect(parseTeamAtInvoke('@team:compliance   ')).toEqual({ kind: 'empty-task', name: 'compliance' })
  expect(parseTeamAtInvoke('@team:compliance')).toEqual({ kind: 'empty-task', name: 'compliance' })
  expect(parseTeamAtInvoke('@team:one @team:two 审查')).toEqual({ kind: 'conflict', reason: 'multiple-targets' })
  expect(parseTeamAtInvoke('@team:one @writer 审查')).toEqual({ kind: 'conflict', reason: 'multiple-targets' })
  expect(parseTeamAtInvoke('正文 @team:compliance 审查')).toBeUndefined()
  expect(parseTeamAtInvoke('@writer 审查')).toBeUndefined()
})

it('does not select or submit while composing Chinese text', () => {
  expect(mentionKeyAction({ key: 'Enter', isComposing: true, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'none' })
  expect(mentionKeyAction({ key: 'Tab', isComposing: false, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'pick', index: 0 })
  expect(mentionKeyAction({ key: 'ArrowDown', isComposing: false, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'move', index: 1 })
  expect(mentionKeyAction({ key: 'Escape', isComposing: false, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'close' })
})

it('builds a typed team target using real buildSessionSendParams signature without changing legacy at params', () => {
  const teamParams = buildSessionSendParams({
    text: '@team:compliance 审查',
    tabId: 'tab-1',
    clientMessageId: 'm1',
    userItemId: 1,
    sessionId: 's1',
    invokedTeam: { name: 'compliance', remainder: '审查' },
  })
  expect(teamParams.text).toBe('审查')
  expect(teamParams.at).toEqual({ kind: 'expert-team', name: 'compliance' })
  expect(teamParams.clientMessageId).toBe('m1')

  const legacyParams = buildSessionSendParams({
    text: '@writer 审查',
    tabId: 'tab-1',
    clientMessageId: 'm2',
    userItemId: 2,
    sessionId: 's1',
    invokedAt: { name: 'writer', remainder: '审查' },
  })
  expect(legacyParams.at).toEqual({ name: 'writer', clientMessageId: '2' })
})
```

- [ ] **Step 2: 确认词法与发送测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/expertTeamsLogic.spec.ts tests/client-huaanwork/sessionChannel.spec.ts
```
Expected: FAIL，`composerAtTokenAt`/`parseTeamAtInvoke` 判别联合与 `invokedTeam` 不存在。

- [ ] **Step 3: 实现团队词法、分组菜单与发送参数**

- `expertTeamsLogic.ts`：
  - `composerAtTokenAt(text, cursor)`：仅识别输入开头 `@` 后至光标的连续非空白 token（允许中文、Unicode、ASCII 与 `team:` 前缀）；既有 `agentsLogic.ts` 中的 `atTokenAt`（任意位置 ASCII 触发）和 `parseAtInvoke` 保持零修改；
  - `resolveComposerMentionState(text, cursor)`：先尝试 `composerAtTokenAt(text, cursor)`，命中则返回 `{ token, allowTeams: true }`（开头同时允许“智能体”与“专家团”分组）；未命中则回落 `atTokenAt(text, cursor)`，命中则返回 `{ token, allowTeams: false }`（保留正文中段旧 `@agent` 任意位置补全，仅隐藏专家团分组）；
  - `leadingTeamAtSlug(text)`：识别开头 `@team:<slug>`（无论是否已键入任务正文），供输入框草稿摘要条立即展示所选专家团；
  - `parseTeamAtInvoke(text)`：返回 `{ kind: 'valid', name, remainder } | { kind: 'empty-task', name } | { kind: 'conflict', reason: 'multiple-targets' } | undefined`，使客户端在空任务或同条多目标时明确拦截并提示，绝不把未填任务的 `@team:<slug>` 当普通文本发给模型；
  - `mentionKeyAction`：把 `isComposing` 作为显式输入，组合态 `Enter`/`Tab` 永远返回 `{ kind: 'none' }`。
- `sessionChannel.ts`：`SessionSendParams.at` 声明为判别联合 `{ name: string; clientMessageId: string } | { kind: 'expert-team'; name: string }`；`buildSessionSendParams` 新增可选 `invokedTeam?: { name: string; remainder: string }`，存在时生成 `text: invokedTeam.remainder` 与 `at: { kind: 'expert-team', name: invokedTeam.name }`（不携带旧卡 `clientMessageId`）；顶层 `clientMessageId` 与既有 `invokedAt`（保留 `at: { name, clientMessageId: String(userItemId) }` 且无 `kind`）路径完全不变。
- `ComposerMentionMenu.tsx`：`ComposerMentionItem` 新增可选 `group?: string`、`icon?: ReactNode`，并把第 23 行 props 内联的 `items: { key: string; ... }[]` 改为直接引用 `items: ComposerMentionItem[]`（避免两处声明漂移）；存在 `group` 时按组渲染分组标题，兼容既有 `/skill` 扁平调用方；`AtAgentMenu.tsx` 在 `allowTeams` 为真时合并“智能体”与“专家团”分组（非开头仅展示“智能体”组），团队条目显示“专家团”标识、图标、成员数、调度/审查/交付摘要。

- [ ] **Step 4: 接入 App 检索、选择、实时刷新与发送**

`App.tsx` 接入：
- `@` 菜单触发（`App.tsx:1230`）改用 `resolveComposerMentionState(draft, atCursor)`（不得直接用仅限开头的 `composerAtTokenAt` 整体替换 `atTokenAt`）：`allowTeams === true` 时合并智能体列表与 `expertTeam.invocableList`（并监听 WS `expertTeam/changed` 自动刷新 `invocableList`）；`allowTeams === false`（正文中段）仅展示智能体分组，完整保留旧 `@agent` 任意位置补全；
- `pickAtAgent`（`App.tsx:3034-3040`）使用同一 `resolveComposerMentionState(draft, atCursor)?.token` 替换当前激活 token（确保开头输入中文 `@合规` 并选中某按描述命中的智能体时原地替换，而非把 `@agent` 拼接在中文后）；`pickAtTeam` 插入 `@team:<slug> `，输入框依据 `leadingTeamAtSlug` 立即显示专家团草稿摘要；
- 在 `appWiring.spec.ts` 增加源码存在性断言 `assert.match(body, /resolveComposerMentionState\(draft, atCursor\)/)`，把触发接线钉死，防止实施者退回 leading-only 的 `composerAtTokenAt` 整体替换（owner 裁定：中段旧 `@agent` 仍触发补全）。
- 发送分支先查 `parseTeamAtInvoke(draft)`：`empty-task` 或 `conflict` 阻止发送并显示明确内联提示；`valid` 保持在既有单条 `rpcCall<SessionSendResult>("session.send", buildSessionSendParams({ ... }))` 入参中追加 `...(invokedTeam ? { invokedTeam } : {}),`（保持 `...(invokedAt ? { invokedAt } : {}),` 与 `...(invokedSkill ? { invokedSkill } : {}),` 字面量不变以继续满足 `appWiring.spec.ts:1247-1251` 的存在性匹配并避免重复发送分支），保留既有 `isComposing` 守卫与旧 `@<agent-slug>` 无 `kind` 路径。

- [ ] **Step 5: 运行新旧 @ 测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/expertTeamsLogic.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/agentsLogic.spec.ts tests/client-huaanwork/appWiring.spec.ts
```
Expected: 全部 PASS；中文检索、空任务拦截和旧 ASCII slug 均不回归。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/expertTeamsLogic.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/ComposerMentionMenu.tsx dsh-plugin-huaanwork/src/client-huaanwork/AtAgentMenu.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/expertTeamsLogic.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/agentsLogic.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat(expert-team): invoke teams from composer"
```

---

### Task 16: 聚合运行卡、右栏进度投影、成员取消与重连对账

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/ExpertTeamRunCard.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/progressPanel.spec.ts`

**Interfaces:**
- Consumes: Task 13 reducer、Task 4 `expertTeam.runList`/`cancel`、既有 `subagent.cancel`、`SubagentRunSummary`（含 Task 3 `SubagentRunProjection.teamRunId`）、Artifact 预览入口与 Artifact 卡。
- Produces: `ExpertTeamRunCard`、`ProgressPanel` 专家团投影区块、`ToolPanelItem` 支持 `kind: 'expert-team-run'`、以及 `App.tsx` 中 `kind: 'expert-team-run'` 渲染、成员独立卡去重与 WS 对账。

- [ ] **Step 1: 写卡片、7 种状态文案、Artifact 入口/关联异常、右栏投影与冻结失败测试**

使用 `// @vitest-environment jsdom`：

```tsx
it('shows mixed activities, distinct 7-state labels, primary artifact entry, and two-level cancel', async () => {
  const cancelTeam = vi.fn().mockResolvedValue({ status: 'accepted', teamRunId: 'run-1' })
  const cancelMember = vi.fn().mockResolvedValue({ ok: true })
  const previewArtifact = vi.fn()
  const card = renderExpertTeamRunCard({
    run: runWithExecutingAndReviewingMembers({ primaryArtifactId: 'art-1', artifactStatus: 'created' }),
    onCancelTeam: cancelTeam,
    onCancelMember: cancelMember,
    onPreviewArtifact: previewArtifact,
  })
  expect(card.text()).toContain('执行与审查')
  expect(card.text()).not.toContain('2/5')
  await card.click('查看主报告')
  expect(previewArtifact).toHaveBeenCalledWith('art-1')
  await card.click('终止成员')
  expect(cancelMember).toHaveBeenCalledWith({ parentSessionId: 's1', runId: 'member-run-1' })
  await card.click('终止专家团')
  expect(cancelTeam).toHaveBeenCalledWith({ parentSessionId: 's1', teamRunId: 'run-1' })
})

it('renders pairwise distinct copy for all 7 states, expands member versions/supersedes/invalid-verdict, and keeps the Artifact card visible on artifactLinkError', async () => {
  const allStatuses = ['running', 'stopping', 'completed', 'completed_with_issues', 'partial', 'stopped', 'failed'] as const
  const labels = allStatuses.map((status) => renderExpertTeamRunCard({ run: runWithStatus(status) }).statusLabel())
  expect(new Set(labels).size).toBe(7)

  const partialLinkErr = renderExpertTeamRunCard({
    run: runWithStatus('partial', {
      deliverySealed: true,
      artifactStatus: 'pending',
      artifactLinkError: 'expert-team-artifact-link-failed',
      results: [
        executeResult('r1', { output: '初版结果' }),
        executeResult('r2', { kind: 'revision', supersedesResultId: 'r1', output: '返修结果' }),
        executeResult('rev-1', { kind: 'review', memberId: 'm-rev-1', reviewError: 'invalid-verdict', output: '缺少末行标记' }),
      ],
    }),
  })
  expect(partialLinkErr.text()).toContain('主报告关联异常')
  // 关联异常时聊天流中的已有 Artifact 卡片仍保持可见，不得被隐藏
  expect(partialLinkErr.queryArtifact()).not.toBeNull()
  await partialLinkErr.click('展开成员结果 r2')
  expect(partialLinkErr.text()).toContain('返修结果')
  expect(partialLinkErr.text()).toContain('替代')
  await partialLinkErr.click('展开成员结果 rev-1')
  expect(partialLinkErr.text()).toContain('invalid-verdict')
})

it('freezes operations on disconnect, unfreezes on same-generation reconnect, and drops old-generation cards while keeping artifacts', () => {
  const card = renderExpertTeamRunCard({ run: runningTeam(), connection: 'closed' })
  expect(card.button('终止专家团')).toBeDisabled()
  expect(card.text()).toContain('连接已断开')
  // 同代重连快照解冻：操作重新可用且清除断连提示
  card.reconcile({ sessionId: 's1', generation: 'g1', revision: 2, runs: [runningTeam({ revision: 2 })] })
  expect(card.button('终止专家团')).not.toBeDisabled()
  expect(card.text()).not.toContain('连接已断开')
  // 换代快照：移除旧聚合卡并保留已提交 Artifact 卡片
  card.reconcile({ sessionId: 's1', generation: 'new-generation', revision: 0, runs: [] })
  expect(card.queryTeamRun()).toBeNull()
  expect(card.queryArtifact()).not.toBeNull()
})
```

在 `progressPanel.spec.ts` 新增断言：`selectProgressPanelModel` 投影当前会话活跃或当前回合的 `expertTeams`，并把携带 `teamRunId` 的成员 `subagents` 从独立“子代理”列表剔除（防止同一次专家团派工在右栏或主流重复渲染独立子代理卡）。

- [ ] **Step 2: 确认运行卡与右栏投影测试失败**

`renderExpertTeamRunCard` 使用真实组件并返回 DOM Harness（挂载时默认附带对应会话的 Artifact 项供 `queryArtifact()` 验证）；`runWithExecutingAndReviewingMembers(overrides?)` 含一个 running execute（`memberRunId: 'member-run-1'`）和一个 running review，`runningTeam(overrides?)` 是无成员结果的 running run（默认 `generation: 'g1'`），`runWithStatus(status, overrides?)` 覆盖全部 7 种终态/运行态，`executeResult` 来自 Task 1 共享 fixture。`reconcile`/`queryTeamRun`/`queryArtifact`/`statusLabel` 驱动 Task 13 reducer 和现有 Artifact 项，不断言组件私有字段。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ExpertTeamRunCard.spec.ts tests/client-huaanwork/progressPanel.spec.ts
```
Expected: FAIL，`ExpertTeamRunCard.tsx` 与右栏专家团投影不存在。

- [ ] **Step 3: 实现卡片、两级取消与右栏投影**

- `ExpertTeamRunCard.tsx`：
  - 显示团队名、7 种清晰区分的状态文案（`running` / `stopping` / `completed` / `completed_with_issues` / `partial` / `stopped` / `failed`，明确区分业务未完全收敛的 `completed_with_issues` 与技术异常的 `partial`）、混合活动、耗时、实际派工/进行/完成/失败/审查/返修计数、Artifact 状态和成员扁平行；
  - 若 `run.primaryArtifactId` 存在，渲染可点击入口触发 `onPreviewArtifact(run.primaryArtifactId)` 打开既有 Artifact 预览面板；若 `run.deliverySealed && run.artifactStatus === 'pending'`（或 `run.artifactLinkError` 存在），显式展示“主报告关联异常”并说明聊天流中的 Artifact 卡片仍可查看；
  - 成员行复用 `SubagentRunSummary`，可展开文本结果、审查意见、`invalid-verdict` 和替代关系；
  - 整团取消调用 `expertTeam.cancel({ parentSessionId, teamRunId })`；单成员取消调用既有 `subagent.cancel({ parentSessionId, runId: memberRunId })`。确认态、`cancelBusy`/`cancelError` 按 runId 与 surface（`'chat' | 'progress'`）管理，不虚报清理成功。
- `progressPanel.ts` & `ProgressPanel.tsx`：
  - `ProgressPanelInput` 新增**可选** `expertTeams?: readonly ExpertTeamRun[]`（缺省 `[]`），`ProgressPanelModel` 新增**可选** `expertTeams?: readonly ExpertTeamRun[]`（按当前 `sessionId` 且活跃或匹配 `currentTurnClientMessageId` 筛选；保持与 `appWiring.spec.ts` 4 处调用、`progressPanel.spec.ts` 及 `ProgressPanelComponent.spec.ts` 的 `model()` 零破坏兼容）；
  - `selectProgressPanelModel` 的 `subagents` 过滤条件增加 `run.teamRunId === undefined`，把团队成员归口到右栏专家团区块，避免独立“子代理”区重复展示；
  - `ProgressPanel.tsx` 新增的专家团取消/预览回调 props 同样声明为可选，渲染专家团摘要与共享取消确认回调。

- [ ] **Step 4: 接入 `App.tsx` WS 拦截、主流去重、对账、清理与样式**

`App.tsx` 精确接入以下 6 处：
1. `applyEvent` 顶部（会话级消息处理之前）拦截 `expertTeam/run` 与 `expertTeam/run-remove`，更新 `expertTeamRunsState`，按需经 `insertExpertTeamRunCard` 锚定到对应 tab；WS 断连/退出时同步派发 `{ type: 'disconnect', at }`；
2. 成员子代理主流去重：`applySubagentEvent` 与 `anchorSnapshotSubagentCards` 仍更新 `subagentRunsState`（供 `ExpertTeamRunCard` 展示成员实时进度），但当 `run.teamRunId !== undefined` 时**跳过**在主流插入独立 `{ kind: 'subagent-run' }` 卡片；
3. WS 恢复后按 `expertTeam.runList({ sessionId })` 携带 `{ sessionId, generation, revision, runs }` 对账并复用现有重试节奏；收到 `expertTeam/run-remove` 或 Host 换代时，同步从 `chatTabs` 中移除失效的 `{ kind: 'expert-team-run', teamRunId }` 条目，绝不删除用户/助手消息或 Artifact 卡片；
4. `toolPanel.ts` 的 `ToolPanelItem` 非工具 `kind` 联合加入 `| 'expert-team-run'`；`App.tsx` 的 `ChatItem` 联合增加 `{ id: number; kind: 'expert-team-run'; teamRunId: string }`，渲染时在 `contentItem` 前处理该 kind 并传入 `onPreviewArtifact`，同步在 `ContentChatItem`（`App.tsx:5318`）、`contentItems` 循环过滤（`if (item.kind === 'subagent-run' || item.kind === 'expert-team-run') continue;`）及 `contentItem` 参数类型三处统一排除 `{ kind: 'subagent-run' | 'expert-team-run' }`；
5. 向 `selectProgressPanelModel` / `ProgressPanel` 传入 `expertTeams` 投影与整团/单成员取消回调；
6. `styles.css` 只增团队卡片与右栏区块样式并运行：

```bash
corepack yarn workspace dsh-plugin-huaanwork gen:styles
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ExpertTeamRunCard.spec.ts tests/client-huaanwork/expertTeamRuns.spec.ts tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/ProgressPanelComponent.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/styles-generated.spec.ts
corepack yarn workspace dsh-plugin-huaanwork tsc -p tsconfig.tests.client.json --noEmit
```
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ExpertTeamRunCard.tsx dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/progressPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/ProgressPanel.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/tests/client-huaanwork/ExpertTeamRunCard.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/progressPanel.spec.ts
git commit -m "feat(expert-team): add aggregate run cards and progress panel projection"
```

---

### Task 17: 真实组合与 Loader 专家团场景

**Files:**
- Create: `dsh-plugin-huaanwork/tests/fixtures/expert-team/driver.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-composition.spec.ts`
- Create: `dsh-plugin-huaanwork/scripts/huaanwork-expert-team-smoke.mjs`
- Modify: `dsh-plugin-huaanwork/package.json`

**Interfaces:**
- Consumes: 全部前序任务；真实 `prepareDesktopProfile` / `boot` / `DesktopProfileService`、session.send、包 runtime、Artifact store、编译产物 `lib/*.js`。
- Produces: `createComplianceTeamScenario(ctx)`、`runComplianceTeamSmoke(scenario, options)`、`restartHostWithSameProfile(ctx)`（供 Vitest 真实 Host 组合测试，TypeScript 严格受 `tsconfig.tests.json` 校验）以及独立编译产物冒烟脚本 `scripts/huaanwork-expert-team-smoke.mjs` 和命令 `corepack yarn workspace dsh-plugin-huaanwork verify:expert-team`。
- Constraint: 不使用真实 API key，不访问外网；模型与 MCP 均由本地脚本驱动，Host/RPC/附件/存储走真实实现；`scripts/huaanwork-expert-team-smoke.mjs` **只** import `../lib/*.js`（不 import `src/*.ts`），以验证真实编译后发布产物。

- [ ] **Step 1: 写端到端失败场景**

```ts
it('runs two executors, one unified reviewer, one revision and one primary artifact (Spec §18.4 default)', async () => {
  const scenario = await createComplianceTeamScenario(ctx)
  const result = await runComplianceTeamSmoke(scenario, {
    executionOrder: 'parallel', maxParallel: 2,
    reviewVerdicts: ['revise', 'pass'], dualMcp: true,
  })
  expect(result.maxMemberConcurrency).toBe(2)
  expect(result.dispatches.map((item) => item.kind)).toEqual(['execute', 'execute', 'review', 'revision', 'review'])
  expect(result.memberRunIds).toHaveLength(5)
  expect(result.parentMcpAttachments).toEqual([])
  expect(result.primaryArtifactIds).toHaveLength(1)
  expect(result.artifact.content).toContain('未解决项')
  expect(result.run.status).toBe('completed')
  expect(result.parentNotifications.filter((item) => item.kind === 'subagent-notification')).toEqual([])
})

it('re-reviews with all reviewers in parallel after revision when a team has two reviewers, and respects parent maxParallelToolCalls=1 even when team maxParallel=4', async () => {
  const scenario = await createComplianceTeamScenario(ctx, { reviewerCount: 2 })
  const result = await runComplianceTeamSmoke(scenario, {
    executionOrder: 'parallel', maxParallel: 2,
    // 4 次 review 按派工顺序逐条消费，禁止用短数组循环复用：首轮 1 人 revise + 1 人 pass -> 触发 1 次 revision -> 第二轮 2 人全员复审均为 pass
    reviewVerdicts: ['revise', 'pass', 'pass', 'pass'],
  })
  expect(result.dispatches.map((item) => item.kind)).toEqual(['execute', 'execute', 'review', 'review', 'revision', 'review', 'review'])
  expect(result.memberRunIds).toHaveLength(7)
  expect(result.run.status).toBe('completed')

  // 规格 §10.2 / §18.1：团队 maxParallel=4 但父会话 maxParallelToolCalls=1 时，实际并发取最小值 1
  const serialPool = await runComplianceTeamSmoke(scenario, {
    executionOrder: 'parallel', maxParallel: 4, parentMaxParallelToolCalls: 1,
    reviewVerdicts: ['pass', 'pass'],
  })
  expect(serialPool.maxMemberConcurrency).toBe(1)
  expect(serialPool.run.status).toBe('completed')
})

it('allows a partial artifact after the dispatch budget is exhausted and settles partial on unrecovered Artifact write failure (Spec §18.4 item 6)', async () => {
  const scenario = await createComplianceTeamScenario(ctx)
  const result = await runComplianceTeamSmoke(scenario, { failUntilBudgetExhausted: true })
  expect(result.dispatches).toHaveLength(24)
  expect(result.run.status).toBe('partial')
  expect(result.artifact.content).toContain('失败与遗漏')
  expect(result.primaryArtifactIds).toHaveLength(1)

  // Artifact 写失败（如 prepare 返回 artifact-too-large 或 commit 写盘失败）且本回合未成功重试：保持 pending 且回合结算为 partial
  const writeFailed = await runComplianceTeamSmoke(scenario, { failArtifactWrite: true })
  expect(writeFailed.primaryArtifactIds).toEqual([])
  expect(writeFailed.run.artifactStatus).toBe('pending')
  expect(writeFailed.run.status).toBe('partial')
})

it('uses final post-tool text for message delivery and seals before goal continuation', async () => {
  const scenario = await createComplianceTeamScenario(ctx)
  const result = await runComplianceTeamSmoke(scenario, { delivery: 'message', activeGoal: true, transitionalTextBeforeDispatch: '我先安排成员' })
  expect(result.run.status).toBe('completed')
  expect(result.finalSummary).toBe('最终合规汇总')
  expect(result.goalDispatchError).toBe('expert-team-terminal')
})

it('drops run projections but preserves messages and artifacts after Host restart', async () => {
  const scenario = await createComplianceTeamScenario(ctx)
  const first = await runComplianceTeamSmoke(scenario, {})
  const restarted = await restartHostWithSameProfile(ctx)
  expect(restarted.expertTeamRuns).toEqual([])
  expect(restarted.artifactIds).toContain(first.primaryArtifactIds[0])
  expect(restarted.messages.map((item) => item.text)).toContain(first.finalSummary)
})
```

- [ ] **Step 2: 确认组合场景失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-composition.spec.ts
```
Expected: FAIL，场景 driver 与完整接线不存在。

- [ ] **Step 3: 实现本地场景 driver（TypeScript）与真实组合**

`tests/fixtures/expert-team/driver.ts` 导出场景工厂（受 `tsconfig.tests.json` 类型检查约束）：

```ts
export async function createComplianceTeamScenario(ctx: CompositionContext, opts?: { reviewerCount?: 1 | 2 }) {
  const members = await installExpertTeamPackages(ctx, opts?.reviewerCount ?? 1)
  const team = await createExpertTeamDefinition(ctx, members)
  return {
    ctx, team, members,
    run: (options: ComplianceTeamSmokeOptions) => executeScriptedTeamRun({ ctx, team, members, options }),
  }
}
export async function runComplianceTeamSmoke(scenario: ComplianceTeamScenario, options: ComplianceTeamSmokeOptions) {
  return scenario.run(options)
}
```

- `installExpertTeamPackages` 使用真实包 store 和现有 `AgentPackageDetail` fixture 在临时 profile 中生成真实包目录：默认 2 个执行包 + 1 个审查包（与规格 §18.4 一致；`reviewerCount: 2` 时增建第 2 个审查包验证多审查员全员复审）；
- `createExpertTeamDefinition` 通过 `expertTeam.create` 创建团队；
- `executeScriptedTeamRun` 驱动真实 `sessionSend` 和包 activation，脚本模型按规格发出真实工具调用：默认场景为 2 次 `execute` → 1 次 `review`（`revise`）→ 1 次 `revision` → 1 次 `review`（`pass`）→ 1 次 `result_present`；`reviewVerdicts` 按审查派工顺序逐条消费（不循环复用短数组：例如 `['revise', 'pass', 'pass', 'pass']` 触发一次返修后双审查员全员复审通过，而 `['pass', 'pass']` 表示首轮两名审查员均直接通过、不进返修）；`parentMaxParallelToolCalls` 通过上游 `agent-loop` 的 `ctx.agentLoop.config.maxParallelToolCalls` volatile 配置（`tool-calls.ts:132,200`）注入，并由脚本团长在同一步（单个 `tool_calls` 数组）同时发出多条 `expert_team_dispatch`，实测工具池并发与团队信号量的最小值约束；
- `dualMcp` 启动两个本地 loopback MCP fixture server，验证实际 `mounted.names`、父会话无 MCP 附件、`serverName` ≤ 32；
- `activeGoal` 在首个 `turn/end` 后立即触发 goal 续拍并断言 `expert_team_dispatch` 被 `expert-team-terminal` 拒绝且工具已摘除；
- `failUntilBudgetExhausted` 真实执行至协调器第 24 次派工（不篡改 `dispatchAttempts`），再验证可提交部分 Artifact 且终态 `partial`；`failArtifactWrite` 使脚本团长提交超 5 MiB 报告（触发真实 `artifact-too-large` 写失败）后不重试直接结束回合，验证 `artifactStatus: 'pending'`、`primaryArtifactIds: []` 与终态 `partial`；
- `restartHostWithSameProfile` 先 dispose 旧 Host，再用同一 profile 创建全新 registry/Host，验证持久消息与 Artifact 保留、团队运行投影为空。所有辅助函数均在 `driver.ts` 内完整实现并导出。

- [ ] **Step 4: 实现编译产物 Loader smoke（完整复用 `verify-profile-boot.mjs` 启动序列 + 真实 HTTP 路由探活）**

`scripts/huaanwork-expert-team-smoke.mjs` 只导入 `../lib/*.js` 与既有桌面运行时模块，在 `try ... finally` 中完整复用 `verify-profile-boot.mjs` 的启动、鉴权与清理流程。注意：**`dsh-plugin-huaanwork/cordis.patch.yml`（经 `profile.ts:1488,1506`）已经把 `desktop-shell` 插入 `prepared.patches`**（`verify-profile-boot.mjs:98-101` 写入 `profile.patchPath` 的仅是不带 `insert` 的覆盖 patch），因此严禁在 `patches` 末尾追加 `{ insert: [DESKTOP_SHELL_PATCH_ENTRY] }`（否则无论是否 seed 都会重复插入 `desktop-shell` 行），必须与 `verify-profile-boot.mjs:157` 保持一致仅拼接 `prepared.patches` 与 `prepared.overlays`：

```js
const patches = [...prepared.patches, ...prepared.overlays]
ctx = await boot(
  'dsh-plugin-huaanwork-expert-team-smoke',
  prepared.rootConfig,
  patches,
  async (host) => {
    profileBoot.prepare(host)
    host.loader.internal = undefined
    host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
    host.provide('desktopBrowserAccess', BROWSER_ACCESS)
    host.provide('desktopLanHttps', LAN_HTTPS)
    host.provide('desktopRuntime', runtime)
    host.provide('desktopPnpmBootstrap', pnpmBootstrap)
    await host.plugin(DesktopProfileService, desktopProfileServiceOptions)
    provideCmdline(host, { args: ['--host', '127.0.0.1', '--port', '0'], exit: () => {} })
  },
  prepared.bareModuleBaseUrl,
)
profileBoot.markReady()
await runtime.mountScheduled()

// 1. 验证工具已在真实 Loader ToolRegistry 注册
const toolNames = (ctx.get('tools')?.schemas() ?? []).map((schema) => schema.name)
if (!toolNames.includes('expert_team_dispatch')) {
  throw new Error('expert-team-loader-tool-missing')
}
// 2. 通过与 verify-profile-boot.mjs 相同的 rendererHeader + authenticationUrl 换取 session cookie，
//    并附带同源 Origin（loopback.ts:isSameOriginLoopbackRequest 要求即使 GET /huaanwork/* 也必须带精确 Origin 或 Sec-Fetch-Site+Referer，否则回 403），
//    向真实 HTTP 服务器发送探活请求，确认新路由不仅存在于静态表，而且在运行期 webServer 上可响应 200
const loopbackOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
const huaanworkHeaders = { ...authedHeaders, Origin: loopbackOrigin }
const listRes = await fetch(`${loopbackOrigin}/huaanwork/expert-team/list`, { headers: huaanworkHeaders })
const invocableRes = await fetch(`${loopbackOrigin}/huaanwork/expert-team/invocable`, { headers: huaanworkHeaders })
if (listRes.status !== 200 || invocableRes.status !== 200) {
  throw new Error(`expert-team-loader-http-failed: list=${listRes.status}, invocable=${invocableRes.status}`)
}
const listBody = await listRes.json()
const invocableBody = await invocableRes.json()
if (!Array.isArray(listBody.teams) || !Array.isArray(invocableBody.teams)) {
  throw new Error('expert-team-loader-http-payload-invalid')
}
```

`finally` 块严格按 `verify-profile-boot.mjs:490-495` 顺序释放 `ctx?.fiber.dispose()`、`releasePackageResolver?.()`、`pnpmRuntime?.dispose()` 与临时 `home` 目录。`package.json` 增加 `"verify:expert-team": "node scripts/huaanwork-expert-team-smoke.mjs"`，并把 `yarn run verify:expert-team` 精准插入 package `check` 链的 `yarn run verify:host` 之后、`yarn run verify:aa` 之前（`package.json:203`），保证后续 CI 也执行该编译产物 Loader 冒烟。

- [ ] **Step 5: 构建并运行组合与 Loader 测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/expert-team-composition.spec.ts
corepack yarn workspace dsh-plugin-huaanwork verify:expert-team
```
Expected: 全部 PASS；场景结束后所有 profile、端口、子进程和 Host disposer 均释放。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-huaanwork/tests/fixtures/expert-team/driver.ts dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-composition.spec.ts dsh-plugin-huaanwork/scripts/huaanwork-expert-team-smoke.mjs dsh-plugin-huaanwork/package.json
git commit -m "test(expert-team): cover composed team execution"
```

---

### Task 18: 完整门禁与真机验收证据

**Files:**
- Create: `docs/evidence/2026-11-22-expert-team-acceptance.md`
- Modify: `docs/superpowers/plans/2026-11-22-expert-team.md`（仅执行时勾选已完成步骤）

**Interfaces:**
- Consumes: 所有实现任务和组合测试。
- Produces: 可审计的 headless gate 结果与真机验收记录；未实际执行的验收不得标为通过。

- [ ] **Step 1: 运行最终完整 headless gate**

```bash
corepack yarn check
```

Expected: PASS。不得与其它含 `verify:aa` 的命令并发；若失败，记录原始失败命令和错误并回到对应任务修复，不得只重跑至偶然通过。

- [ ] **Step 2: 运行最终差异与格式检查**

```bash
git diff --check
git status --short
```

Expected: 无 whitespace 错误；没有 `deepseek-harness/`、锁文件、无关 CI 或意外二进制变更。

- [ ] **Step 3: 执行真机验收并记录证据**

在 `docs/evidence/2026-11-22-expert-team-acceptance.md` 逐项记录实际命令、版本、日志和结果：

- [ ] 新建“合规审查小分队”：两名执行成员、一名审查成员，默认统一审查和 Markdown 主 Artifact；检查成员包原生脚本/HTTP/MCP 能力。
- [ ] 中文检索并调用 `@team`，确认真实独立成员 run、包版本、最多两路并行、动态补派和统一审查一次返修后全员复审。
- [ ] 验证 reasoning + text 正常执行，纯 reasoning 显示 empty-output，混合 image/file 显示 unsupported-output。
- [ ] 验证一份主 Artifact、正文工具卡抑制、预览、全屏和原字节下载；主报告后派工封闭。
- [ ] 验证仅会话模式：派工前过渡语不算最终汇总，最后 tool/result 后文本才算。
- [ ] 分别验证成员中途失效、无效审查标记、单成员取消、整团取消、父会话停止、24 次预算耗尽后的部分 Artifact。
- [ ] 验证同会话双 MCP 成员并行、普通 `@智能体` 行为、goal 续拍不能迟到派工。
- [ ] 验证 Host 重启后团队卡不恢复，消息和 Artifact 卡仍在；验证 Artifact 写失败（如超 5 MiB 或写盘异常）后保持 pending、可同回合重试且未重试结 partial；关联失败时 Artifact 可见但团队 pending/partial。
- [ ] 验证中文输入法组合态、键盘选择、断连冻结、重连对账和终态淘汰。

证据文件必须区分“自动化测试通过”和“真机人工验收通过”，任何未执行项保持未勾选并注明原因。

- [ ] **Step 4: 提交最终实现与证据**

```bash
git add dsh-plugin-huaanwork packages/huaanwork-policy docs/superpowers/plans/2026-11-22-expert-team.md docs/evidence/2026-11-22-expert-team-acceptance.md
git commit -m "test(expert-team): verify desktop collaboration"
```

---

## Self-Review Checklist

- [ ] 规格 §1–§19 的每项要求均能映射到 Task 1–Task 18；普通 `@智能体`、不修改上游、R3 包本位准入与真机验收没有被遗漏。
- [ ] 所有任务都有失败测试、运行命令、实现接口和提交步骤；没有“待定”“稍后实现”“适当补测试”等占位内容。
- [ ] `ExpertTeam`、`ExpertTeamRecord`、`ExpertTeamRun`、`ExpertTeamRunSnapshot`、`ExpertTeamDispatchInput/Result`、`ExpertTeamLease`、`dispatchTeamMember`、`validateDispatchRule`、`requestCancel`/`markStopped`、`activeBySession`/`byTurn`、`noteSessionArtifact`、`composerAtTokenAt`/`resolveComposerMentionState`、`parseTeamAtInvoke`、`resolveFollowupClientMessageId` 的签名跨任务一致；`unifiedRevisionRounds` 在 Task 8 同步临界区唯一写回且 `cycleOpen` 仅从 `results` 派生。
- [ ] 团队终态为 `turn/end` 封闭（且 `turn/start` 先于 `agent/inbox/claimed`）而非 afterIdle/whenIdle，结算点内置 fail-closed 异常守卫（先失效租约、附件/restrict 独立 try/catch、确保必写终态）；`requestCancel` 非阻塞置 `stopping`，在清理收敛后由 `markStopped` 置 `stopped`；技术失败允许部分报告且 24 次预算豁免只豁免未尝试义务、不豁免在途/格式/单交付物守卫；同代重连快照恢复 `connection='open'` 并清除 `frozenAt`。
- [ ] 生产接线覆盖 `model.ts`（`isRegisteredToolName`）、`holders.ts`、`index.ts`（含 `toolCtx`、全局 listener 与 disposer `cancelAll()`）、`sessions.ts:1346` + `turn-scheduler.ts`（`at.kind` 透传）、`agent-package/host.ts`（`AgentPackageDispatchContext`）+ `skills.ts`（`specChildId` 前移）、`result-artifact-tools.ts`（`ToolContext` + `ResultPresentClaimedContext` + 按持久 manifest 锚重放关联）、`toolPanel.ts` / `ProgressPanel`（类型链、右栏投影与成员去重）、`App.tsx`（旧 `@` 保留任意位置触发）及编译产物 `lib/*.js` 真实 HTTP Loader 冒烟（不重复插入 `desktop-shell`）。
- [ ] 最终验收证据只在实际命令和真机步骤完成后填写。
