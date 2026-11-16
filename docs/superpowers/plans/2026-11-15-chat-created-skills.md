# Chat-Created Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在普通会话中通过访谈、草稿、确认和幂等提交创建单个 `SKILL.md`，并让它立即出现在“技能中心 → 我的技能”且默认未启用。

**Architecture:** 新增与智能体创建平行的轻量技能创建状态机；智能体/技能草稿在同一会话双向互斥。模型工具只负责草稿和提交，正式写盘复用 `skills-host.ts` 的锁、校验、原子写与本地状态，不复制第二套落盘实现。

**Tech Stack:** TypeScript、React、Vitest、Yarn 4.18、既有 DSH tools/present-as/attachments、既有 `@huaanwork/skill-format`。

**Spec:** `docs/superpowers/specs/2026-11-15-chat-created-skills-design.md`

**Plan order:** 1/3。先交付本计划，再执行 `2026-11-15-progress-sidebar.md`，最后执行 `2026-11-15-task-result-artifacts.md`。

## Global Constraints

- 基线为外层 `ff29debd37d72a92f10d446eafa07867d17befd8`，上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 只修改 `dsh-plugin-huaanwork/`；不得修改 `deepseek-harness/`。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0`，通过 Corepack 调用根 Yarn `4.18.0`。
- 技能创建一期只支持新建；不支持对话更新、脚本、资源包、HTTP/MCP、自动启用或自动上传。
- 新技能必须 `source=user`、`origin={kind:"created"}`、默认未启用，并立即进入“我的技能”。
- `description`、`whenToUse` 为单行；正文 UTF-8 不超过 64 KiB；描述不超过 1024 字符。
- 智能体与技能草稿双向互斥；互斥检查先于继续创建、注入、挂载和提交。
- 同意/取消语义只有一份实现；确认按钮只通过 `session.send` 发送精确文本 `确认`。
- `creationDraftId` 与配套 `creationSessionId` 是内部字段，不得加入 `SkillInput` 或允许 RPC/表单调用方传入；幂等查询必须同时匹配二者。
- 工具结果定稿前不得解绑当前工具；成功提交后使用 `huaanworkOnToolResult` 解绑。
- 修改 `styles.css` 后必须运行 `corepack yarn workspace dsh-plugin-huaanwork gen:styles`。
- 所有命令均在仓库根执行；提交只包含当前任务列出的文件。
- 包级 `typecheck`/`check` 之外，收尾必须按仓库根约定执行 `corepack yarn check`；自动化门禁不替代 §12.2 的人类验收。

---

### Task 1: 共享创建用语与内部 `create-skill`

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/creation-utterances.ts`
- Create: `dsh-plugin-huaanwork/skills/create-skill/SKILL.md`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts:65-67,137-142,974-979`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts:676`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/skillsLogic.ts:97`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/creation-utterances.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/skillsLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts`

**Interfaces:**
- Produces: `normalizeCreationUtterance(text)`、`isCreationConsentText(text)`、`isCreationCancelText(text)`。
- Preserves: `isAgentConsentText` 和 `isAgentCancelText` 的既有导出与行为。
- Produces: 内部技能 `create-skill`，不出现在技能中心且不能被同名用户技能占用。

- [ ] **Step 1: 写共享用语和保留名的失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { isCreationCancelText, isCreationConsentText } from '../../src/huaanwork-host/creation-utterances.ts'

describe('creation utterances', () => {
  it('uses the same exact consent and cancellation semantics as agent creation', () => {
    expect(isCreationConsentText('确认')).toBe(true)
    expect(isCreationConsentText('确认。')).toBe(true)
    expect(isCreationConsentText('我确认可以')).toBe(false)
    expect(isCreationCancelText('先不要！')).toBe(true)
    expect(isCreationCancelText('取消这个字段')).toBe(false)
  })
})
```

在 `skillsLogic.spec.ts` 添加：

```ts
it('reserves create-skill for the internal creation flow', () => {
  expect(RESERVED_SKILL_NAMES).toContain('create-skill')
})
```

在 `skills-host.spec.ts` 添加宿主侧保留名钉（`takenNames` 含 `INTERNAL_BUNDLED_SKILLS`，名称被占用即拒绝）：

```ts
it('rejects user skills named create-skill on the host side', async () => {
  const root = makeHome()
  const result = await createSkill(root, { name: 'create-skill', description: '占用内部名', content: '正文' })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.fieldErrors.map((error) => error.field)).toContain('name')
})
```

- [ ] **Step 2: 运行测试并确认因模块/成员缺失而失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/creation-utterances.spec.ts tests/client-huaanwork/skillsLogic.spec.ts tests/huaanwork-host/skills-host.spec.ts
```
Expected: FAIL，`creation-utterances.ts` 不存在、`RESERVED_SKILL_NAMES` 不含 `create-skill`、宿主侧 `createSkill({name:'create-skill'})` 当前可成功。

- [ ] **Step 3: 实现共享用语**

```ts
const CONSENT_PHRASES = new Set(['可以', '确认', '同意', '就这样', '按这个建'])
const CANCEL_PHRASES = new Set(['取消', '先不要'])

export function normalizeCreationUtterance(text: string): string {
  return text.trim().replace(/[。！!？?]$/, '')
}

export function isCreationConsentText(text: string): boolean {
  return CONSENT_PHRASES.has(normalizeCreationUtterance(text))
}

export function isCreationCancelText(text: string): boolean {
  return CANCEL_PHRASES.has(normalizeCreationUtterance(text))
}
```

在 `agent-package/drafts.ts` 导入上述函数，并把现有两个导出改为委托：

```ts
export function isAgentConsentText(text: string): boolean {
  return isCreationConsentText(text)
}

export function isAgentCancelText(text: string): boolean {
  return isCreationCancelText(text)
}
```

删除 drafts 内重复的 `CONSENT_PHRASES`、`CANCEL_PHRASES`、`normalizeUtterance` 与 `TRAILING_PUNCTUATION`（删除规范化函数后该常量再无引用，属死代码，一并移除），不得改变既有测试期望。

- [ ] **Step 4: 添加内部访谈技能和两份保留名**

`skills/create-skill/SKILL.md`：

```markdown
---
name: create-skill
description: 通过对话访谈并创建仅含 SKILL.md 的本地技能
disable-model-invocation: true
---

# 对话创建技能

一次只问一个必要问题；用户已经提供的信息不要重复询问。

1. 确认用途、典型输入和触发场景。
2. 确认 kebab-case 名称、单行描述和单行 whenToUse。
3. 整理执行步骤、限制与输出要求，形成正文。
4. 只能调用 skill_propose 提交草稿；不得声称已经创建。
5. 原样说明确认卡内容；只有用户下一轮整句明确同意后才能调用 skill_commit。
6. 同一轮 propose 后不得 commit；不得生成脚本、URL、HTTP/MCP 或资源目录。
7. 用户继续修改时更新草稿；用户取消时不得提交。
```

在两个集合中加入 `"create-skill"`：

```ts
const INTERNAL_BUNDLED_SKILLS = new Set(['create-agent', 'create-skill'])
const RESERVED_SKILL_NAMES = ['explore', 'test-fix', 'create-agent', 'create-skill']
```

若现有声明为 `export` 或 `as const`，保留原修饰符，只增加值。

- [ ] **Step 5: 运行聚焦测试和智能体用语回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/creation-utterances.spec.ts tests/client-huaanwork/skillsLogic.spec.ts tests/huaanwork-host/skills-host.spec.ts tests/huaanwork-host/agent-package-drafts.spec.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/creation-utterances.ts dsh-plugin-huaanwork/skills/create-skill/SKILL.md dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/skillsLogic.ts dsh-plugin-huaanwork/tests/huaanwork-host/creation-utterances.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/skillsLogic.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts
git commit -m "feat(skills): add internal conversational creation contract"
```

---

### Task 2: 技能状态幂等字段与唯一正式创建入口

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:147-152`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-local-state.ts:146-168`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts:227-247,360-450`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts:84-95,133-141`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-local-state.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-upload.spec.ts`

**Interfaces:**
- Produces: `SkillLocalEntry.creationDraftId?: string` 与 `SkillLocalEntry.creationSessionId?: string`。
- Produces: `createSkillFromDraft(storageRoot, input, creationDraftId, creationSessionId)` 与 `findSkillByCreationDraftId(storageRoot, creationDraftId, creationSessionId)`；两者只在草稿 ID 与会话归属同时匹配时命中。
- Produces: 导出的 `validateSkillFields(input, taken)`，供草稿 propose/commit 复用。
- Preserves: 表单 `createSkill(storageRoot, input)` 的签名和返回类型。

- [ ] **Step 1: 写状态往返、单行校验和幂等创建的失败测试**

在 `skills-host.spec.ts` 使用现有临时目录 harness 添加：

```ts
it('creates from a draft once and preserves identity after editing', async () => {
  const root = makeHome()
  const input = { name: 'weekly-report', description: '生成周报', content: '按步骤生成周报' }
  const first = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
  expect(first).toMatchObject({ ok: true, alreadyCommitted: false, name: 'weekly-report' })
  await expect(resolveInvocableSkill(root, 'weekly-report')).rejects.toThrow('weekly-report is disabled')
  setUserSkillToggle(root, 'weekly-report', true)
  await expect(resolveInvocableSkill(root, 'weekly-report')).resolves.toMatchObject({ skill: { name: 'weekly-report' } })

  const edited = await updateSkill(root, 'weekly-report', { ...input, content: '更新后的正文' })
  expect(edited.ok).toBe(true)

  const replay = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
  expect(replay).toMatchObject({ ok: true, alreadyCommitted: true, name: 'weekly-report' })
  expect(readSkillLocalState(root).skills['weekly-report'].creationDraftId).toBe('draft-1')
  expect(readSkillLocalState(root).skills['weekly-report'].creationSessionId).toBe('session-1')
})

it('rejects multiline frontmatter fields', async () => {
  const root = makeHome()
  const result = await createSkill(root, {
    name: 'multiline-test', description: '第一行\n第二行', content: '正文',
  })
  expect(result.ok).toBe(false)
})

it('rejects idempotent replay as a field error when the state key remains but the directory is gone', async () => {
  const root = makeHome()
  const input = { name: 'weekly-report', description: '生成周报', content: '按步骤生成周报' }
  const first = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
  expect(first.ok).toBe(true)

  await rm(join(root, 'skills', 'weekly-report'), { recursive: true, force: true })

  const replay = await createSkillFromDraft(root, input, 'draft-1', 'session-1')
  expect(replay.ok).toBe(false)
  if (!replay.ok) expect(replay.fieldErrors.map((error) => error.field)).toContain('name')
  expect(readSkillLocalState(root).skills['weekly-report'].creationDraftId).toBe('draft-1')
  expect(readSkillLocalState(root).skills['weekly-report'].creationSessionId).toBe('session-1')
})
```

其中 `rm` 从 `node:fs/promises`、`join` 从 `node:path` 导入；第三条即 phantom 测试：带外删除目录后扫描命中状态键，必须报字段错误而不是 phantom 成功。

在 `skill-local-state.spec.ts` 增加 `creationDraftId` 与 `creationSessionId` 的写入→读取断言，以及“只有其中一个键即损坏并拒绝读取”的成对约束测试；在上传 spec 的既有“带外编辑采纳”和“发布回写”用例中，先给状态条目设置 `creationDraftId: 'draft-1'` 与 `creationSessionId: 'session-1'`，操作后添加：

```ts
expect(readSkillLocalState(root).skills[name].creationDraftId).toBe('draft-1')
expect(readSkillLocalState(root).skills[name].creationSessionId).toBe('session-1')
```

“带外编辑采纳”用例还须预置 stale `contentDigest`（让本地 digest 与 `uploadDigest` 不一致），使 `skill-catalog-upload.ts:85` 的 `contentDigest !== uploadDigest` 采纳分支真正执行；否则保键断言空转。

- [ ] **Step 2: 确认新 API 和单行校验测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/skills-host.spec.ts tests/huaanwork-host/skill-local-state.spec.ts tests/huaanwork-host/skill-catalog-upload.spec.ts
```
Expected: FAIL，`createSkillFromDraft` 不存在，多行描述当前可写入。

- [ ] **Step 3: 显式解析内部字段并收紧单行校验**

在 `SkillLocalEntry` 添加：

```ts
creationDraftId?: string
creationSessionId?: string
```

在 `validateEntry` 返回前添加：

```ts
if (value.creationDraftId !== undefined) {
  entry.creationDraftId = requireString(value.creationDraftId, `${name}.creationDraftId`, path)
}
if (value.creationSessionId !== undefined) {
  entry.creationSessionId = requireString(value.creationSessionId, `${name}.creationSessionId`, path)
}
if ((value.creationDraftId === undefined) !== (value.creationSessionId === undefined)) {
  throw new CorruptSkillLocalStateError(`本地技能状态 creationDraftId 与 creationSessionId 必须同时存在:${path}`)
}
```

将 `validateSkillFields` 导出，并加入：

```ts
for (const [field, value] of [
  ['description', input.description],
  ['whenToUse', input.whenToUse],
] as const) {
  if (value !== undefined && /[\r\n]/.test(value)) {
    errors.push({ field, message: `${field} 必须是单行文本` })
  }
}
```

在 `updateSkill` 的 `localEntry` 以及上传模块两处重建条目时保留：

```ts
...(previous?.creationDraftId !== undefined ? { creationDraftId: previous.creationDraftId } : {}),
...(previous?.creationSessionId !== undefined ? { creationSessionId: previous.creationSessionId } : {})
```

上传发布回写若变量名为 `entry`/`fresh`，展开该实际变量；不得从上传参数读取此字段。

- [ ] **Step 4: 抽取锁内创建主体并增加草稿入口**

将现有 `createSkill` 锁内主体原样抽为 `createSkillLocked(storageRoot, input, creationDraftId?, creationSessionId?)`，只在 `localEntry` 增加：

```ts
const localEntry: SkillLocalEntry = {
  origin: { kind: 'created' },
  contentDigest,
  ...(creationDraftId !== undefined ? { creationDraftId } : {}),
  ...(creationSessionId !== undefined ? { creationSessionId } : {}),
}
```

保留原表单入口：

```ts
export async function createSkill(storageRoot: string, input: SkillInput): Promise<SkillWriteResult> {
  return withSkillStorageLock(storageRoot, () => createSkillLocked(storageRoot, input))
}
```

新增：

```ts
export type SkillCreateFromDraftResult =
  | { ok: true; name: string; alreadyCommitted: boolean }
  | { ok: false; fieldErrors: SkillFieldError[] }

export async function createSkillFromDraft(
  storageRoot: string,
  input: SkillInput,
  creationDraftId: string,
  creationSessionId: string,
): Promise<SkillCreateFromDraftResult> {
  return withSkillStorageLock(storageRoot, async () => {
    const state = readSkillLocalState(storageRoot)
    const liveNames = new Set((await listUserSkills(storageRoot)).map((skill) => skill.name))
    for (const [name, entry] of Object.entries(state.skills)) {
      if (entry.creationDraftId === creationDraftId && entry.creationSessionId === creationSessionId) {
        if (!liveNames.has(name)) {
          return {
            ok: false,
            fieldErrors: [{ field: 'name', message: `技能 ${name} 的目录已不存在，幂等凭证失效` }],
          }
        }
        return { ok: true, name, alreadyCommitted: true }
      }
    }
    const result = await createSkillLocked(storageRoot, input, creationDraftId, creationSessionId)
    if (!result.ok) return result
    return { ok: true, name: input.name, alreadyCommitted: false }
  })
}
```

不得在持锁后再次调用会获取同一锁的 `createSkill` 或 `createSkillFromDraft`——`withSkillStorageLock`（skills-host.ts:255-272）是 promise 链锁、**非重入**：外层持锁时内层 `await` 外层的 current，而外层 release 要等 fn 完成，嵌套即循环等待死锁。

另提供已提交凭证查询，供草稿已经删除后的 commit 重放使用：

```ts
export async function findSkillByCreationDraftId(
  storageRoot: string,
  creationDraftId: string,
  creationSessionId: string,
): Promise<{ name: string } | undefined> {
  const state = readSkillLocalState(storageRoot)
  const names = new Set((await listUserSkills(storageRoot)).map((skill) => skill.name))
  for (const [name, entry] of Object.entries(state.skills)) {
    if (
      entry.creationDraftId === creationDraftId
      && entry.creationSessionId === creationSessionId
      && names.has(name)
    ) return { name }
  }
  return undefined
}
```

`createSkillFromDraft` 内部的幂等扫描命中状态键后，必须再用 `listUserSkills` 确认对应本地技能目录仍存在（上面代码已内含）；状态有键但目录已消失时返回字段错误，不得报告 phantom 成功。

- [ ] **Step 5: 运行状态、编辑、上传和另存回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/skills-host.spec.ts tests/huaanwork-host/skill-local-state.spec.ts tests/huaanwork-host/skill-catalog-upload.spec.ts tests/huaanwork-host/skill-catalog-download.spec.ts tests/huaanwork-host/skill-duplicate.spec.ts
```
Expected: PASS；另存的新条目没有 `creationDraftId`；`skills-host.spec.ts` 的既有导入与 `/name` 调用用例、`skill-catalog-download.spec.ts` 的既有下载用例均保持绿（这些未修改的测试只运行，不加入提交清单）。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-local-state.ts dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-local-state.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-upload.spec.ts
git commit -m "feat(skills): preserve conversational creation idempotency"
```

---

### Task 3: 技能草稿、校验与提交原语

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-creation-drafts.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation-drafts.spec.ts`

**Interfaces:**
- Consumes: `createSkillFromDraft`、`findSkillByCreationDraftId`、`validateSkillFields`、`takenNames`、共享同意/取消函数。
- Produces: `SkillProposalInput`、`SkillCreationDraft`、`SkillProposeResult`、`SkillCommitResult`。
- Produces: `proposeSkillCreation`、`commitSkillCreation`、`cancelSkillCreation`、`loadSkillCreationDraft`、`hasSkillCreationDraftOnDisk`。

- [ ] **Step 1: 写草稿校验、授权和幂等失败测试**

```ts
it('requires a later consented turn and commits only once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-'))
  const proposal = { name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报' }
  const proposed = await proposeSkillCreation(root, 'session-1', proposal)
  expect(proposed.ok).toBe(true)
  if (!proposed.ok) return

  const sameTurn = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: true, creationTurn: true,
  })
  expect(sameTurn.ok).toBe(false)

  const committed = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(committed).toMatchObject({ ok: true, alreadyCommitted: false, name: 'daily-summary' })

  const replay = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(replay).toMatchObject({ ok: true, alreadyCommitted: true })
})

it('replays a committed draft by credential after the draft file is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-replay-'))
  const proposal = { name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报' }
  const proposed = await proposeSkillCreation(root, 'session-1', proposal)
  if (!proposed.ok) throw new Error('propose failed')

  const committed = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(committed).toMatchObject({ ok: true, alreadyCommitted: false })
  expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(false)

  // 正常成功重放：草稿已删，按 draftId 命中已提交凭证，不得被“活动 draftId”检查先挡住。
  const replay = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(replay).toMatchObject({ ok: true, alreadyCommitted: true, name: 'daily-summary' })
})

it('rejects a committed credential replayed from another session without duplicating the skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-cross-session-'))
  const proposed = await proposeSkillCreation(root, 'session-1', {
    name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
  })
  if (!proposed.ok) throw new Error('propose failed')
  const committed = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(committed).toMatchObject({ ok: true, alreadyCommitted: false })

  const replay = await commitSkillCreation(root, 'session-2', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(replay.ok).toBe(false)
  expect(replay).not.toMatchObject({ alreadyCommitted: true })
  expect((await listUserSkills(root)).filter((skill) => skill.name === 'daily-summary')).toHaveLength(1)
})

it('refuses replay without phantom success when the directory vanishes behind a state key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-phantom-'))
  const proposal = { name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报' }
  const proposed = await proposeSkillCreation(root, 'session-1', proposal)
  if (!proposed.ok) throw new Error('propose failed')

  // 模拟状态已写入、草稿尚未删除的崩溃窗口；不要让正常 commit 先删掉草稿。
  const created = await createSkillFromDraft(root, {
    name: proposal.name, description: proposal.description, content: proposal.body,
  }, proposed.draftId, 'session-1')
  expect(created.ok).toBe(true)
  expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
  await rm(join(root, 'skills', 'daily-summary'), { recursive: true, force: true })

  const replay = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(replay.ok).toBe(false)
  if (!replay.ok) expect(replay.fieldErrors.map((error) => error.field)).toContain('name')
  expect(replay).not.toMatchObject({ alreadyCommitted: true })
  expect(readSkillLocalState(root).skills['daily-summary'].creationDraftId).toBe(proposed.draftId)
  expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
})

it('rejects multiline frontmatter and another active agent draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-guard-'))
  const bad = await proposeSkillCreation(root, 'session-1', {
    name: 'bad-lines', description: '一\n二', body: '正文',
  })
  expect(bad.ok).toBe(false)

  const agentDraft = join(root, 'agents', '.drafts')
  await mkdir(agentDraft, { recursive: true })
  await writeFile(join(agentDraft, 'session-1.json'), '{}')
  const blocked = await proposeSkillCreation(root, 'session-1', {
    name: 'blocked-skill', description: '被阻止', body: '正文',
  })
  expect(blocked.ok).toBe(false)
})

it('refuses to commit on a non-creation turn even with a valid consent text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-noncreation-'))
  const proposed = await proposeSkillCreation(root, 'session-1', {
    name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
  })
  if (!proposed.ok) throw new Error('propose failed')
  const committed = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: false,
  })
  expect(committed.ok).toBe(false)
  expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
  expect(await listUserSkills(root)).toHaveLength(0)
})

it('refuses a wrong draftId and keeps the active draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-wrongid-'))
  const proposed = await proposeSkillCreation(root, 'session-1', {
    name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
  })
  if (!proposed.ok) throw new Error('propose failed')
  const committed = await commitSkillCreation(root, 'session-1', 'wrong-id', '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(committed.ok).toBe(false)
  expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
  expect(await listUserSkills(root)).toHaveLength(0)
})

it('fails closed on a corrupt draft without creating or overwriting anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-corrupt-'))
  const proposed = await proposeSkillCreation(root, 'session-1', {
    name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
  })
  if (!proposed.ok) throw new Error('propose failed')
  await writeFile(join(root, 'skill-creation-drafts', 'session-1.json'), '{corrupt')
  await expect(commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })).rejects.toThrow(CorruptSkillCreationDraftError)
  expect(await listUserSkills(root)).toHaveLength(0)
})

it('keeps the draft and the existing skill when the name is taken before commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-conflict-'))
  const proposed = await proposeSkillCreation(root, 'session-1', {
    name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
  })
  if (!proposed.ok) throw new Error('propose failed')
  const occupied = await createSkill(root, { name: 'daily-summary', description: '既有技能', content: '既有正文' })
  expect(occupied.ok).toBe(true)
  const committed = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(committed.ok).toBe(false)
  if (committed.ok) throw new Error('unreachable')
  expect(committed.fieldErrors[0].field).toBe('name')
  expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
  const skills = await listUserSkills(root)
  expect(skills).toHaveLength(1)
  expect(skills[0].description).toBe('既有技能')
})

it('returns a success card whose fields match the proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-draft-card-'))
  const body = '字'.repeat(600)
  const proposed = await proposeSkillCreation(root, 'session-1', {
    name: 'daily-summary', description: '生成日报', whenToUse: '需要日报时', body,
  })
  if (!proposed.ok) throw new Error('propose failed')
  const committed = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
    proposedThisTurn: false, creationTurn: true,
  })
  expect(committed).toMatchObject({ ok: true, alreadyCommitted: false })
  if (!committed.ok) throw new Error('unreachable')
  expect(committed.card).toEqual({
    name: 'daily-summary',
    description: '生成日报',
    whenToUse: '需要日报时',
    contentPreview: Array.from(body).slice(0, 500).join(''),
  })
})
```

`mkdtempSync`/`mkdir`/`writeFile` 来自 `node:fs`，`rm` 来自 `node:fs/promises`，`join`/`tmpdir` 分别来自 `node:path`/`node:os`，`readSkillLocalState` 来自 `skill-local-state.ts`，`createSkill`/`listUserSkills` 来自 `skills-host.ts`，`hasSkillCreationDraftOnDisk`/`CorruptSkillCreationDraftError` 为被测模块导出。

- [ ] **Step 2: 确认新草稿模块测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/skill-creation-drafts.spec.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现严格草稿与原子写**

```ts
export type SkillProposalInput = {
  name: string
  description: string
  whenToUse?: string
  body: string
}

export type SkillCreationDraft = {
  schemaVersion: 1
  draftId: string
  sessionId: string
  proposal: SkillProposalInput
  createdAt: string
  updatedAt: string
}
```

实现时固定：

```ts
const draftDir = (profileDir: string) => join(profileDir, 'skill-creation-drafts')
const draftPath = (profileDir: string, sessionId: string) => join(draftDir(profileDir), `${sessionId}.json`)
```

`loadSkillCreationDraft` 对缺失返回 `undefined`，对损坏 JSON、错误 schemaVersion、跨 session 或非法字段抛出 `CorruptSkillCreationDraftError`；不得把损坏当成无草稿。写入使用同目录 `.tmp` + rename。新 propose 使用 `randomUUID()` 覆盖同会话旧草稿。

- [ ] **Step 4: 实现 propose/commit/cancel**

propose 先做跨流程检查：技能 propose 前检查对方智能体草稿的磁盘存在性（只读存在性 helper `hasAgentCreationDraftOnDisk(profileDir, sessionId)`，由 `skill-creation-drafts.ts` 导出，不导入 `agent-package/drafts.ts`，避免循环依赖），存在即返回字段错误拒绝，不得先写草稿再拒绝。helper 路径固定为 `<profileDir>/agents/.drafts/<sessionId>.json`，与 `agent-package/drafts.ts:889-891` 的 `draftPath` 一致；**两处加交叉注释**（skill-creation-drafts.ts 的 helper 与 drafts.ts 的 draftPath 互指，任一路径变更必须同步另一方），测试 seeding（`seedBothDrafts` 与 Task 3 的 `join(root,'agents','.drafts')`）使用同一路径表达式，不得各写一份。Task 5 路由的 6a 损坏检测复用同一 helper。随后将 `body` 映射到 `SkillInput.content`，调用：

```ts
const errors = validateSkillFields(
  { name: input.name, description: input.description, ...(input.whenToUse !== undefined ? { whenToUse: input.whenToUse } : {}), content: input.body },
  await takenNames(profileDir),
)
```

commit 门禁顺序固定为：会话 ID → 本轮技能创建/继续创建上下文且不存在另一类智能体草稿 → `proposedThisTurn` 未置位 → 最近用户原句是完整同意句 → `draftId` 合法性 → **先按 `sessionId + draftId` 查已提交凭证** `findSkillByCreationDraftId(profileDir, draftId, sessionId)`；命中即返回 `{ok:true,name,alreadyCommitted:true}`，即使草稿已删除——正常成功重放不得被“活动 draftId”检查先挡住，其他会话也不能凭 draftId 重放。凭证未命中时，才要求 `draftId` 对应当前活动技能草稿（在场且内容匹配），随后执行首次提交：**锁外**重读草稿并重校验字段 → `createSkillFromDraft(profileDir, input, draftId, sessionId)`（该函数**自行取存储锁**，权威校验与落盘在其锁内完成）→ 成功后删除仍在场的同 ID 草稿。**不得把这一整段再包一层 `withSkillStorageLock`**：锁非重入，`createSkillFromDraft` 内层取同 key 锁会死锁（见 Task 2 Step 4 警告）；锁外重读与锁内权威校验之间的竞态由 `createSkillLocked` 锁内的 `validateSkillFields + takenNames` 兜底。首次成功返回 `{ok:true,name,alreadyCommitted:false,card}`；`card` 固定为 `{name,description,whenToUse?,contentPreview}`，其中 `contentPreview` 使用 `Array.from(body).slice(0, 500).join('')`，不截断 UTF-8 代理对。重放成功只需要 name/alreadyCommitted，不要求重建原确认卡。任何首次写入失败保留草稿；名称冲突不得覆盖既有目录。

`cancelSkillCreation(profileDir, sessionId, options?: {explicit?: boolean})` 同样先读对方智能体草稿：对方在场且未传 `{explicit:true}` 时返回 `false` 且双方文件不变；显式入口只允许删除本技能草稿，不得级联清理对方。

- [ ] **Step 5: 运行草稿和正式技能回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/skill-creation-drafts.spec.ts tests/huaanwork-host/skills-host.spec.ts
```
Expected: PASS，包括重复提交、非创建轮、错误 draftId、损坏草稿和名称冲突保留草稿。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skill-creation-drafts.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation-drafts.spec.ts
git commit -m "feat(skills): add consented conversational skill drafts"
```

---

### Task 4: 技能创建 Host 门面与模型工具

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-creation.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skill-creation-tools.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:448-463,521-598`（`SkillConfirmCard` 与四个 `skill/*` 事件变体必须随首个发送方同批落地）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skill-creation-tools.spec.ts`

**Interfaces:**
- Produces: `SkillCreationHost`、`createSkillCreationHost({profileDir})`、`setSkillCreationHost/getSkillCreationHost`。
- Produces: `SKILL_CREATION_TOOLS = ['skill_propose','skill_commit']`。
- Produces: `attachSkillCreationTools/detachSkillCreationTools`、`injectCreateSkill`。
- Produces: `registerSkillCreationTools(ctx, host): () => void`。
- Produces: `SkillConfirmCard` RPC 数据类型及 `skill/confirm`、`skill/success`、`skill/notice`、`skill/changed` 四个 `RpcEvent` 变体；`skill/success` 载荷含 `text/draftId/name/sessionId`。

- [ ] **Step 1: 写工具结果定稿后解绑的失败测试**

构造只含声明方法的 fake host 和注册上下文，执行 `skill_commit` 后断言：执行体内未解绑；触发保存的 `tools/result` listener 后才调用 `detachAgentTools`。同时断言 `skill_propose` 成功发出 `skill/confirm`，失败发出 `skill/notice` 并抛错；`skill_commit` 成功只发出 `skill/success` 与 `skill/changed`（不发 `skill/notice` 成功文案），失败发出 `skill/notice` 错误并抛错、不设置 pendingDetach，随后到达的 `tools/result` 也不触发解绑。

```ts
expect(events.filter((event) => event.event === 'skill/confirm')).toHaveLength(1)
expect(events.filter((event) => event.event === 'skill/success')).toHaveLength(1)
expect(events.filter((event) => event.event === 'skill/notice')).toHaveLength(0)
expect(events.find((event) => event.event === 'skill/success')).toMatchObject({ draftId: 'draft-1', name: 'daily-summary' })
expect(detachedBeforeResult).toBe(false)
resultListener({ callId: 'call-1' })
expect(detachAgentTools).toHaveBeenCalledWith(attachments, 'session-1', ['skill_propose', 'skill_commit'])
```

`alreadyCommitted` 重放用例钉：重放再次发出同一 `draftId`/`name` 的 `skill/success` 与 `skill/changed`（补偿丢失事件），但不重复写盘、不设置第二个 `pendingDetach`。

失败用例另钉：

```ts
expect(events.filter((event) => event.event === 'skill/notice')).toHaveLength(1)
expect(events.some((event) => event.event === 'skill/success')).toBe(false)
await expect(failedCommit).rejects.toThrow()
resultListener({ callId: 'call-fail' })
expect(detachAgentTools).not.toHaveBeenCalled()
```

- [ ] **Step 2: 确认工具注册测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skill-creation-tools.spec.ts tests/huaanwork-host/skill-creation.spec.ts
```
Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现有界 Host 状态机**

`SkillCreationHost` 至少包含：

```ts
export type SkillCreationHost = {
  propose(sessionId: string, input: SkillProposalInput): Promise<SkillProposeResult>
  commit(sessionId: string, draftId: string, rawUserText: string): Promise<SkillCommitResult>
  cancel(sessionId: string, options?: { explicit?: boolean }): Promise<boolean>
  hasDraft(sessionId: string): boolean
  lastUserText(sessionId: string): string | undefined
  noteUserText(sessionId: string, text: string): void
  noteCreationTurn(sessionId: string, text: string): void
  describeDraft(sessionId: string): string | undefined
}
```

`hasDraft(sessionId)` 必须调用 Task 3 的 `hasSkillCreationDraftOnDisk(profileDir, sessionId)` 读取磁盘草稿存在性，不得改用 memory-only Map；跨重启后的互斥与双草稿守卫依赖这一事实源。`describeDraft` 返回草稿的 `proposal.name`（缺失返回 `undefined`；损坏草稿抛出具名损坏错误并 fail-closed，不得伪装成无草稿），供互斥提示携带名称/摘要（规格 §7 第 4 步）。使用 `lastText`、`proposedThisTurn`、`creationTurns` 三个 Map/Set；插入式 LRU 上限 256。`noteUserText` 每轮清除两个回合标记并覆盖原句；`propose` 成功才设置 `proposedThisTurn`；`commit` 必须读取 `creationTurns.has(sessionId)`，路由不得透传覆盖。

- [ ] **Step 4: 实现 RPC 事件、工具与注册**

先在 `client-huaanwork/rpc-types.ts` 定义 Task 6 使用的 `SkillConfirmCard` 四字段数据类型，并在 `RpcEvent` 联合同批加入 `skill/confirm`、`skill/success`、`skill/notice`、`skill/changed`；不能在 Task 4/5 先发送尚未入联合的事件、到 Task 6 才补类型。`skill/confirm` 携带 `card` 与可选 `sessionId`，`skill/notice` 携带 `text` 与可选 `sessionId`，`skill/success` 携带 `text/draftId/name/sessionId`，`skill/changed` 携带 `name` 与 `origin`。

工具只投影四个提案字段和一个 draftId；`sessionId` 使用 `sessionIdOfAgentRef(exec.agent)`。`skill_commit` 成功只发 `skill/success`（成功卡数据源，载荷含成功文案、`draftId` 与 `name`，由客户端渲染 `SkillSuccessCard` 并按 `draftId` 去重，提供“前往我的技能”动作）与 `skill/changed`；`skill/notice` 不再承载成功文案，只留错误与一般提示：

```ts
emit(ctx, { event: 'skill/success', text: `已保存技能 ${result.name}，请在“我的技能”中启用`, draftId, name: result.name, sessionId })
emit(ctx, { event: 'skill/changed', name: result.name, origin: { kind: 'created' } })
pendingDetach.set(exec.callId, sessionId)
exec.concludeTurn?.()
return { text: `已保存技能 ${result.name}，请在“我的技能”中启用` }
```

`alreadyCommitted` 重放路径返回同一结果，并重发同一 `draftId`/`name` 的 `skill/success` 与 `skill/changed` 以补偿丢失事件；客户端按 `draftId` 去重成功卡，重放不得产生第二张成功卡或第二个技能目录。失败路径发 `skill/notice` 错误并抛错，由模型据此修正；不得设置 `pendingDetach`、不得解绑工具，后续 `tools/result` 到达也不触发解绑。

无 `callId`/结果通道的测试嵌入沿用智能体先例，以 `setTimeout(..., 0)` 延迟解绑。将两个工具加入 policy 的 attached 工具判定；在 Host `index.ts` 创建唯一门面并注册，dispose 时先注销工具再清空门面。

`attachSkillCreationTools`/`detachSkillCreationTools` 必须镜像 `creation.ts:99-111` 的智能体先例——**每次挂/卸后调用 `refreshAgentRestrict`**，只改附件表不够：

```ts
export function attachSkillCreationTools(ctx: CreationContext, sessionId: string): void {
  if (!ctx.huaanworkAttachments) return
  attachAgentTools(ctx.huaanworkAttachments, sessionId, SKILL_CREATION_TOOLS)
  refreshAgentRestrict(ctx as never, sessionId)
}

export function detachSkillCreationTools(ctx: CreationContext, sessionId: string): void {
  if (!ctx.huaanworkAttachments) return
  detachAgentTools(ctx.huaanworkAttachments, sessionId, SKILL_CREATION_TOOLS)
  refreshAgentRestrict(ctx as never, sessionId)
}
```

附件 Map 变更不触发上游 `tools/change`；不刷新则两个创建工具直到某个无关 `tools/change` 才进入模型可见工具集——访谈轮模型看不到 `skill_propose`，流程卡死（不是「等下一轮」）。`ctx as never` 沿用桌面树既有惯用法（creation.ts:103/110；评审文档 XM-A4 owner 裁定）。函数级测试各补一条断言：挂/卸后 `refreshAgentRestrict` 以同一 sessionId 被调用。

- [ ] **Step 5: 运行工具、附件和策略测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skill-creation-tools.spec.ts tests/huaanwork-host/skill-creation.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/huaanwork-guardrails/agent-attachments.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS；未挂附件的会话不能执行两个工具，四个 `skill/*` 事件在首个发送方提交点已通过类型检查。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skill-creation.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skill-creation-tools.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/skill-creation-tools.spec.ts
git commit -m "feat(skills): register conversational creation tools"
```

---

### Task 5: 会话路由与智能体/技能双向互斥

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:130-240`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts:158-171,213-245,379-394`（低层防护 + 新增 `loadAgentPackageDraftStrict`/`CorruptAgentPackageDraftError`；不改 `loadAgentPackageDraft` 宽松语义）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`（补 `describeDraft`，供互斥提示携带对方草稿名）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-creation.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts`

**Interfaces:**
- Consumes: 两个 Host 的 `hasDraft/noteUserText/noteCreationTurn`、草稿模块的磁盘存在性检查。
- Produces: `detectSkillCreationIntent(text): {kind:'create';initialText:string} | undefined`。
- Preserves: `/create-agent`、`/create-agent update`、普通 `/name` 和 `@agent` 分流。

- [ ] **Step 1: 写双向互斥、双草稿与入口顺序失败测试**

在 Host/路由测试建立以下矩阵（自然语言 fixture 必须是 `CREATE_SKILL_RE` 实际可命中的说法，不得为用例放宽正则）：

```ts
const cases = [
  { existing: 'agent', incoming: '/create-skill', rejected: true },
  { existing: 'agent', incoming: '帮我创建一个技能', rejected: true },
  { existing: 'skill', incoming: '/create-agent', rejected: true },
  { existing: 'skill', incoming: '/create-agent update weekly-report', rejected: true },
  { existing: 'skill', incoming: '新建一个智能体', rejected: true },
  { existing: 'agent', incoming: '/create-agent', rejected: false },
  { existing: 'skill', incoming: '/create-skill', rejected: false },
  { existing: 'none', incoming: '修改技能 weekly-report', rejected: false },
] as const
```

每个 rejected 用例断言：没有注入技能、没有挂新工具、没有覆盖/删除对方草稿，提示包含对方草稿的名称或草稿摘要。`修改技能` 负例断言不误判为新建入口。双草稿用例的 `seedBothDrafts()` 必须直接写入两份合法磁盘草稿，并由 Host 的磁盘 `hasDraft` 读出，不得只预置内存状态。另写以下回归：

```ts
it('does not let an agent draft hijack /create-skill into agent continue and commit', async () => {
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '/create-skill' })
  expect(result.started).toBe(false)
  expect(events.filter((event) => event.event === 'agent/confirm')).toHaveLength(0)
  expect(proposeAgentPackage).not.toHaveBeenCalled()
  expect(commitAgentPackage).not.toHaveBeenCalled()
  expect(readFileSync(agentDraftPath, 'utf8')).toBe(originalAgentDraft)
})

it('terminates the creation routing with a notice when the agent draft is corrupt', async () => {
  await writeFile(agentDraftPath, '{corrupt')
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '/create-skill' })
  expect(result.started).toBe(false)
  expect(events.at(-1)?.text).toContain('损坏')
  expect(injectCreateSkill).not.toHaveBeenCalled()
  expect(attachSkillCreationTools).not.toHaveBeenCalled()
  expect(readFileSync(agentDraftPath, 'utf8')).toBe('{corrupt')
})

it('lets /create-agent cancel clean a corrupt agent draft (NI-1 recovery path)', async () => {
  await writeFile(agentDraftPath, '{corrupt')
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '/create-agent cancel' })
  expect(result.started).toBe(false)
  expect(events.at(-1)?.text).toContain('已取消创建智能体')
  expect(packageHost.cancel).toHaveBeenCalledWith('session-1', { explicit: true })
  expect(() => readFileSync(agentDraftPath, 'utf8')).toThrow()
})

it('cleans a corrupt agent draft alongside a valid skill draft without touching the skill draft', async () => {
  seedBothDrafts()
  await writeFile(agentDraftPath, '{corrupt')
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '/create-agent cancel' })
  expect(result.started).toBe(false)
  expect(() => readFileSync(agentDraftPath, 'utf8')).toThrow()
  expect(readFileSync(skillDraftPath, 'utf8')).toBe(originalSkillDraft)
})

it('does not reject a normal skill turn with creation-like body while an agent draft exists', async () => {
  const result = await sendToAgent(ctx, routeCtx, {
    sessionId: 'session-1', skill: 'weekly-report', text: '创建技能正文，但仍是一次普通技能调用',
  })
  expect(result).toMatchObject({ started: true })
  expect(events.filter((event) => event.event === 'skill/notice' && event.text.includes('请先完成'))).toHaveLength(0)
  expect(injectCreateSkill).not.toHaveBeenCalled()
  expect(readFileSync(agentDraftPath, 'utf8')).toBe(originalAgentDraft)
})

it('does not reject an @agent turn with creation-like body while a skill draft exists', async () => {
  const result = await sendToAgent(ctx, routeCtx, {
    sessionId: 'session-1', at: { name: 'legacy-agent' }, text: '创建技能正文，但仍是一次显式 @ 调用',
  })
  expect(result).toMatchObject({ started: true })
  expect(dispatchAt).toHaveBeenCalledTimes(1)
  expect(events.filter((event) => event.event === 'skill/notice' && event.text.includes('请先完成'))).toHaveLength(0)
  expect(injectCreateSkill).not.toHaveBeenCalled()
})

it('rejects bare cancel, propose and commit while both drafts exist', async () => {
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '取消' })
  expect(result.started).toBe(false)
  expect(events.at(-1)?.text).toContain('/create-skill cancel')
  expect(readFileSync(agentDraftPath, 'utf8')).toBe(originalAgentDraft)
  expect(readFileSync(skillDraftPath, 'utf8')).toBe(originalSkillDraft)
  expect(packageHost.cancel).not.toHaveBeenCalled()
  expect(skillHost.cancel).not.toHaveBeenCalled()
  expect(proposeAgentPackage).not.toHaveBeenCalled()
  expect(commitAgentPackage).not.toHaveBeenCalled()
  expect(await proposeSkillCreation(root, 'session-1', proposal)).toMatchObject({ ok: false })
  expect(await commitSkillCreation(root, 'session-1', 'draft-1', '确认', {
    proposedThisTurn: false, creationTurn: true,
  })).toMatchObject({ ok: false })
})

it('keeps ordinary chat out of both creation flows while both drafts exist', async () => {
  seedBothDrafts()
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '普通聊天，不继续任何创建流程' })
  expect(result.started).toBe(true)
  expect(injectCreateSkill).not.toHaveBeenCalled()
  expect(injectCreateAgentSkill).not.toHaveBeenCalled()
  expect(attachSkillCreationTools).not.toHaveBeenCalled()
  expect(attachCreationTools).not.toHaveBeenCalled()
  expect(readFileSync(agentDraftPath, 'utf8')).toBe(originalAgentDraft)
  expect(readFileSync(skillDraftPath, 'utf8')).toBe(originalSkillDraft)
})

it.each(['/create-skill', '/create-agent'])('rejects explicit creation entry %s while both drafts exist', async (entry) => {
  seedBothDrafts()
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: entry })
  expect(result.started).toBe(false)
  expect(events.at(-1)?.text).toContain('检测到并存')
  expect(injectCreateSkill).not.toHaveBeenCalled()
  expect(injectCreateAgentSkill).not.toHaveBeenCalled()
  expect(attachSkillCreationTools).not.toHaveBeenCalled()
  expect(attachCreationTools).not.toHaveBeenCalled()
  expect(readFileSync(agentDraftPath, 'utf8')).toBe(originalAgentDraft)
  expect(readFileSync(skillDraftPath, 'utf8')).toBe(originalSkillDraft)
})

it('cancels only the named flow via explicit cancel entries and recovers the other', async () => {
  const skillCancel = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '/create-skill cancel' })
  expect(skillCancel.started).toBe(false)
  expect(existsSync(skillDraftPath)).toBe(false)
  expect(readFileSync(agentDraftPath, 'utf8')).toBe(originalAgentDraft)
  expect(events.at(-1)?.text).toContain('已取消创建技能')

  seedBothDrafts()
  const agentCancel = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '/create-agent cancel' })
  expect(agentCancel.started).toBe(false)
  expect(existsSync(agentDraftPath)).toBe(false)
  expect(readFileSync(skillDraftPath, 'utf8')).toBe(originalSkillDraft)
  expect(events.at(-1)?.text).toContain('已取消创建智能体')

  const continued = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '继续修改技能' })
  expect(continued.started).toBe(true)
  expect(injectCreateSkill).toHaveBeenCalledWith('继续修改技能', 'continue')
})

it('routes single-draft bare cancel to the skill flow and names it', async () => {
  const result = await sendToAgent(ctx, routeCtx, { sessionId: 'session-1', text: '取消' })
  expect(result.started).toBe(false)
  expect(existsSync(skillDraftPath)).toBe(false)
  expect(events.at(-1)?.text).toContain('已取消创建技能')
  expect(packageHost.cancel).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 确认互斥测试在现路由上失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/skill-creation.spec.ts tests/huaanwork-host/agent-package-creation.spec.ts
```
Expected: FAIL，智能体草稿优先接管技能入口；双草稿与显式取消用例失败（现路由无对应分支）。

- [ ] **Step 3: 实现技能入口识别、显式取消与互斥路由**

技能入口只接受：

```ts
const CREATE_SKILL_RE = /^(?:帮我)?(?:新建|创建|建)(?:一个|个)?(?:技能)/
const CREATE_SKILL_COMMAND = /^\/create-skill(?:\s+([\s\S]*))?$/
```

`sendToAgent` 的顺序固定如下（注释编号对应规格 §7）：

```ts
// 1. 每轮先记录用户原句：技能同意门禁读 lastUserText，漏接会使 happy-path commit 恒拒。
const skillHost = getSkillCreationHost()
skillHost?.noteUserText(sessionId, text)

// 2. 规范化内部创建入口（含显式取消），清出普通 skill 分流；显式取消在互斥检查之前解析。
// 边缘行为变化（M-3）：现网 sessions.ts:200-201 的清分流带 packageHost !== undefined 守卫；
// 此处无条件规范化。宿主门面未注入的纯测试组合下，/create-agent 从「普通技能解析报错」
// 变为「普通聊天文本」。index.ts 恒注入 host，生产无用户可见影响；测试组合需知悉该差异。
const createAgentEntry = skillName === 'create-agent'
if (createAgentEntry) skillName = undefined
const createSkillEntry = skillName === 'create-skill'
if (createSkillEntry) skillName = undefined

const agentSlash = /^\/create-agent(?:\s+([\s\S]*))?$/.exec(text.trim())
const skillSlash = CREATE_SKILL_COMMAND.exec(text.trim())
const agentCancel = agentSlash !== null && /^\s*cancel\s*$/.test(agentSlash[1] ?? '')
const skillCancel = skillSlash !== null && /^\s*cancel\s*$/.test(skillSlash[1] ?? '')

// 3. 显式取消是终止操作，不得再被当成 create 意图；目标缺席也不能触碰另一流程。
if (skillCancel) {
  if (skillHost?.hasDraft(sessionId) !== true) {
    const notice = '当前没有可取消的技能创建。'
    routeCtx.emit({ event: 'skill/notice', text: notice, sessionId })
    return { queued: true, sessionId, started: false, reason: notice }
  }
  await skillHost.cancel(sessionId, { explicit: true })
  detachSkillCreationTools(ctx, sessionId)
  const notice = '已取消创建技能，没有写入技能。'
  routeCtx.emit({ event: 'skill/notice', text: notice, sessionId })
  return { queued: true, sessionId, started: false, reason: notice }
}
if (agentCancel) {
  // NI-1：守卫放宽——宽松 hasDraft 为假且磁盘文件也不在场才报「没有可取消」；
  // 损坏草稿（磁盘在场、宽松读不出）必须放行到 cancelAgentPackage（existsSync+rmSync 可清理），
  // 否则 6a 提示的 /create-agent cancel 补救入口被本守卫挡死。
  if (packageHost?.hasDraft(sessionId) !== true && !hasAgentCreationDraftOnDisk(routeCtx.profileDir, sessionId)) {
    const notice = '当前没有可取消的智能体创建。'
    routeCtx.emit({ event: 'agent/notice', text: notice, sessionId })
    return { queued: true, sessionId, started: false, reason: notice }
  }
  await packageHost.cancel(sessionId, { explicit: true })
  detachCreationTools(ctx, sessionId)
  const notice = '已取消创建智能体，没有写入智能体。'
  routeCtx.emit({ event: 'agent/notice', text: notice, sessionId })
  return { queued: true, sessionId, started: false, reason: notice }
}

// 4. 流程类型识别：自然语言入口只在无显式 /name、无 @agent 时计入；显式命令不受此限。
const nlAllowed = !atName && !skillName
const requestedAgent =
  createAgentEntry || agentSlash !== null || (nlAllowed && detectAgentCreationIntent(text) !== undefined)
const requestedSkill =
  createSkillEntry || skillSlash !== null || (nlAllowed && detectSkillCreationIntent(text) !== undefined)

const agentDraft = packageHost?.hasDraft(sessionId) === true
const skillDraft = skillHost?.hasDraft(sessionId) === true

// 5. 双草稿异常态：显式取消已在上方处理；只拦截创建/续建入口与裸取消，普通聊天、普通 /name 和 @agent 不被全量拒绝。
const bareCreationCancel = nlAllowed && isCreationCancelText(text)
if (agentDraft && skillDraft && (requestedAgent || requestedSkill || bareCreationCancel)) {
  const notice = '检测到并存的智能体与技能创建草稿，请先分别用 /create-skill cancel 或 /create-agent cancel 取消其中一个。'
  routeCtx.emit({ event: 'skill/notice', text: notice, sessionId })
  return { queued: true, sessionId, started: false, reason: notice }
}

// 6. 双向互斥：提示带对方草稿的名称或摘要（describeDraft 由各 Host 提供）。
// 6a. 对方草稿损坏检测（I-2）：智能体侧 hasDraft 是宽松读取（损坏吞成 undefined），
// 磁盘文件在场却读不出 ⇒ 损坏，fail-closed 终止；不得让技能流程绕过损坏的智能体草稿。
// 补救路径由放宽后的 agentCancel 守卫保证（NI-1）：磁盘在场即可 /create-agent cancel 清理。
// 条件与 R8 一致：技能草稿在场时普通消息即「继续创建」，损坏文件算「在场」；无技能草稿时普通聊天不触发。
if ((requestedSkill || skillDraft) && hasAgentCreationDraftOnDisk(routeCtx.profileDir, sessionId) && !agentDraft) {
  const notice = '检测到损坏的智能体创建草稿，已终止本次创建路由。请用 /create-agent cancel 显式清理后重试。'
  routeCtx.emit({ event: 'skill/notice', text: notice, sessionId })
  return { queued: true, sessionId, started: false, reason: notice }
}
if ((requestedAgent && skillDraft) || (requestedSkill && agentDraft)) {
  const currentKind = requestedAgent ? '技能' : '智能体'
  // describeDraft 对损坏草稿抛具名错误（技能侧 CorruptSkillCreationDraftError、
  // 智能体侧 CorruptAgentPackageDraftError）；捕获并终止，不得让异常穿透 sendToAgent
  // （覆盖 hasDraft 与 describeDraft 两次读取之间草稿被损坏的竞态窗口）。
  let summary: string | undefined
  try {
    summary = requestedAgent
      ? skillHost?.describeDraft(sessionId)
      : packageHost?.describeDraft(sessionId)
  } catch (error) {
    if (error instanceof CorruptSkillCreationDraftError || error instanceof CorruptAgentPackageDraftError) {
      const notice = '检测到损坏的创建草稿，已终止本次创建路由。请用对应流程的 cancel 入口显式取消后重试。'
      routeCtx.emit({ event: 'skill/notice', text: notice, sessionId })
      return { queued: true, sessionId, started: false, reason: notice }
    }
    throw error
  }
  const notice = `请先完成或取消当前的${currentKind}创建：${summary ?? (requestedAgent ? '技能草稿' : '智能体草稿')}`
  routeCtx.emit({ event: requestedAgent ? 'agent/notice' : 'skill/notice', text: notice, sessionId })
  return { queued: true, sessionId, started: false, reason: notice }
}

// 7. 单技能草稿的裸取消只清技能流程；双草稿已在上方拒绝，智能体单草稿仍走既有取消分支。
if (!agentDraft && skillDraft && bareCreationCancel) {
  await skillHost!.cancel(sessionId)
  detachSkillCreationTools(ctx, sessionId)
  const notice = '已取消创建技能，没有写入技能。'
  routeCtx.emit({ event: 'skill/notice', text: notice, sessionId })
  return { queued: true, sessionId, started: false, reason: notice }
}

// 8. 同类创建/继续创建才注入技能并挂工具；技能中心入口按 create，已有草稿按 continue。双草稿普通聊天不得注入任一方。
if (skillHost && nlAllowed && !agentDraft && (requestedSkill || skillDraft)) {
  skillHost.noteCreationTurn(sessionId, text)
  text = injectCreateSkill(text, skillDraft && !requestedSkill ? 'continue' : 'create')
  attachSkillCreationTools(ctx, sessionId)
}
```

`injectCreateSkill(text, mode: 'create' | 'continue')` 在 Task 4 的门面中定义；`create` 使用用户已提供的信息开始访谈，`continue` 保留当前草稿并继续，不得新建第二份草稿。智能体同类 continue/update 沿用既有分支，但也必须位于上述互斥检查之后，其继续/注入条件同样增加 `!skillDraft`。双草稿且未明确选择创建流程的普通聊天不得注入任一内部创建技能或挂载创建工具，继续走普通聊天；普通 `/name` 与 `@agent` 也保持既有分流。`describeDraft`：技能侧在 Task 4 的 `SkillCreationHost` 上已补齐（取草稿 `proposal.name`）；智能体侧在本任务的 `AgentPackageHost` 上补同名方法（取草稿 slug/displayName）。两者都是缺失返回 `undefined`、损坏抛出具名错误；路由对缺失回落“草稿摘要”，对损坏终止本次创建路由并发出损坏提示，不得继续注入或挂载。

**智能体侧严格读取的实现路径（I-2）**：在 `agent-package/drafts.ts` 新增 `loadAgentPackageDraftStrict(profileDir, sessionId)` 与 `CorruptAgentPackageDraftError`——文件缺失（ENOENT）返回 `undefined`；读取失败、JSON 解析失败或 `parseDraft` 任一字段非法抛 `CorruptAgentPackageDraftError`。**不得改动 `loadAgentPackageDraft` 的宽松语义**（`host.ts:420-424` 的 `hasDraft` 依赖它，改语义会破坏每轮互斥读取与智能体 continue 现状）。`AgentPackageHost.describeDraft` 用严格读取取 slug/displayName：缺失→`undefined`、损坏→抛。注意可达性：宽松 `hasDraft` 把损坏读成「 absent」，互斥分支不会仅因损坏草稿触发，因此路由代码草稿在互斥前加 6a 检测——`hasAgentCreationDraftOnDisk` 为真而 `agentDraft` 为假即损坏，fail-closed 终止并提示 `/create-agent cancel`（`cancelAgentPackage` 用 existsSync+rmSync，可清理损坏文件）；describeDraft 的 try/catch 覆盖两次读取之间的竞态窗口。**agentCancel 守卫同批放宽（NI-1）**：宽松 hasDraft 为假**且磁盘文件也不在场**才报「没有可取消」，磁盘在场即放行到 cancelAgentPackage 清理损坏文件，保证 6a 提示的补救入口不被自己的守卫挡死。损坏智能体草稿 + 有效技能草稿双在场时，6a 因 skillDraft=true 对每个创建/续建回合触发；逃生链为先 `/create-skill cancel` 或 `/create-agent cancel`（显式取消在 6a 之前解析，放宽守卫可清理损坏文件）再重建，Step 1 已补两条回归（cancel 清理损坏文件、双在场时技能草稿不被触碰）。技能侧已有 `CorruptSkillCreationDraftError`（Task 3）且 `hasDraft` 本就是磁盘存在性，无需 6a 对称分支。Step 1 补一条回归：损坏智能体草稿 + `/create-skill` → 路由发损坏提示、`started:false`、不注入不挂载、`sendToAgent` 不抛。

- [ ] **Step 4: 在低层草稿入口补对等防护**

在 `proposeAgentPackage` 和 `commitAgentPackage` 的既有校验之后、任何写入之前检查 `hasSkillCreationDraftOnDisk(profileDir, sessionId)`。存在时分别返回字段错误或 `refused('当前会话存在技能创建草稿')`，不得依赖路由单点。技能草稿模块对智能体草稿的磁盘检查使用只读存在性，不导入 `agent-package/drafts.ts`，避免形成循环依赖；对称地，技能侧 propose/commit 低层入口（Task 3）已带对方智能体草稿检查。

两个低层取消入口统一显式选择语义：

```ts
cancelSkillCreation(profileDir, sessionId, options?: { explicit?: boolean }): Promise<boolean>
packageHost.cancel(sessionId, options?: { explicit?: boolean }): Promise<boolean>
```

任一取消入口检测到另一类草稿且 `options.explicit !== true` 时，必须返回拒绝/ `false`，不得删除任何草稿；只有路由的 `/create-skill cancel` 与 `/create-agent cancel` 传 `{explicit:true}`，此时也只删除本入口所属流程。单草稿裸取消无需该选项。Step 1 的双草稿测试除路由断言外，直接调用两个低层取消入口，分别覆盖“无 explicit 双草稿拒绝”和“explicit 只清指定方”，防止只靠路由守卫。

- [ ] **Step 5: 运行路由和既有创建回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/skill-creation.spec.ts tests/huaanwork-host/agent-package-creation.spec.ts tests/huaanwork-host/agent-package-drafts.spec.ts tests/huaanwork-host/sessions.spec.ts
```
Expected: PASS；取消只清理明确选择的流程并点名对象；双草稿三向拒绝与显式取消恢复路径通过。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-creation.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts
git commit -m "fix(sessions): isolate agent and skill creation drafts"
```

---

### Task 6: 技能确认卡、变更事件与“我的技能”入口

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/SkillConfirmCard.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/SkillSuccessCard.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx:99,307-314`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/skill-confirm-card.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/skill-success-card.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/skillsView.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`
- Run-only（不修改）: `dsh-plugin-huaanwork/tests/client-huaanwork/styles-generated.spec.ts`（13 行 styles.css↔generated 新鲜度比对；列入 Step 5/6 运行命令，不入提交清单）

**Interfaces:**
- Consumes: Task 4 已落地的 `SkillConfirmCard` 与四个 `skill/*` RPC 事件变体；本任务不重复修改事件联合。
- Produces: `SkillConfirmCard`/`SkillSuccessCard` 组件与独立 `skillChangeSignal`，供 SkillsView 和 `/` 补全刷新。
- Consumes: 普通会话打开/发送能力；确认按钮不得调用 `skill.create`。

- [ ] **Step 1: 写确认卡、成功卡与页面入口失败测试**

```ts
it('sends the exact consent phrase through the normal conversation path', async () => {
  const onConsent = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const card = { name: 'daily-summary', description: '生成日报', whenToUse: '需要日报时', contentPreview: '整理输入并生成日报' }
  await act(async () => {
    root.render(createElement(SkillConfirmCard, { card, onConsent, onRevise: vi.fn(), onCancel: vi.fn() }))
  })
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '确认创建')
  await act(async () => { button?.click() })
  expect(onConsent).toHaveBeenCalledTimes(1)
  await act(async () => { root.unmount() })
  container.remove()
})

it('navigates to My Skills only when the success card action is clicked', async () => {
  const onGoToMine = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(SkillSuccessCard, { name: 'daily-summary', draftId: 'draft-1', onGoToMine }))
  })
  // 渲染成功卡本身不触发跳转。
  expect(onGoToMine).not.toHaveBeenCalled()
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '前往我的技能')
  await act(async () => { button?.click() })
  expect(onGoToMine).toHaveBeenCalledTimes(1)
  await act(async () => { root.unmount() })
  container.remove()
})
```

在 `appWiring.spec.ts` 钉成功卡去重：同一 `draftId` 的 `skill/success` 事件到达两次，会话消息流只插入一张成功卡；不同 `draftId` 正常各插一张；`skill/notice` 不插入成功卡。测试直接覆盖 App 暴露的纯投影 helper：

```ts
it('dedupes success cards by draftId', () => {
  const event = { draftId: 'draft-1', name: 'daily-summary', text: '已保存技能' }
  const first = upsertSkillSuccess([], event, () => 10)
  const replay = upsertSkillSuccess(first, event, () => 11)
  expect(replay).toBe(first)
  expect(replay).toHaveLength(1)

  const other = upsertSkillSuccess(replay, { ...event, draftId: 'draft-2' }, () => 12)
  expect(other.map((item) => item.kind)).toEqual(['skill-success', 'skill-success'])
  expect(other.map((item) => item.id)).toEqual([10, 12])
})
```

实现 helper 时保持同一引用短路：

```ts
function upsertSkillSuccess(
  items: ChatItem[],
  event: { draftId: string; name: string; text: string },
  allocId: () => number,
): ChatItem[] {
  if (items.some((item) => item.kind === 'skill-success' && item.draftId === event.draftId)) return items
  return [...items, { id: allocId(), kind: 'skill-success', ...event }]
}
```

```ts
it('opens conversational creation from Mine', async () => {
  const onStartConversationCreate = vi.fn()
  const view = await mount({ mine: [], onStartConversationCreate })
  await act(async () => { buttonByText(view, '我的技能')?.click() })
  await act(async () => { buttonByText(view, '对话创建技能')?.click() })
  expect(onStartConversationCreate).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 确认客户端组件/入口测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/skill-confirm-card.spec.ts tests/client-huaanwork/skill-success-card.spec.ts tests/client-huaanwork/skillsView.spec.ts tests/client-huaanwork/appWiring.spec.ts
```
Expected: FAIL，新组件和 prop 不存在。

- [ ] **Step 3: 实现确认卡、成功卡和独立刷新信号**

确认卡数据复用 Task 4 在 `rpc-types.ts` 定义的 `SkillConfirmCard`，props 固定：

```ts
type SkillConfirmCardProps = {
  card: SkillConfirmCard
  onConsent: () => void
  onRevise: () => void
  onCancel: () => void
}
```

成功卡 props 固定；`skill/success` 的 `{ text: string; draftId: string; name: string; sessionId: string }` 载荷类型已在 Task 4 落地：

```ts
type SkillSuccessCardProps = {
  name: string
  draftId: string
  onGoToMine: () => void
}
```

App 的 `onConsent` 必须走现有普通 `send('确认')` 路径；`onRevise` 保持当前草稿并聚焦输入框；`onCancel` 发送 `取消`。`ChatItem` 增加 `{id:number;kind:'skill-confirm';card:SkillConfirmCard}` 与 `{id:number;kind:'skill-success';draftId:string;name:string;text:string}` 两个变体（`appWiring.spec.ts` 对两者形状各一条直断言），事件处理固定：`skill/confirm` 插入 `{kind:'skill-confirm',card}` 确认卡；`skill/success` 调用上文 `upsertSkillSuccess`（导出供 `appWiring.spec.ts` 直测）按 `draftId` 去重后插入成功卡，重放重发不新增第二张成功卡，点击“前往我的技能”才切换技能页标签、不自动打断会话；`skill/notice` 只写标签脚注，不插入成功卡；`skill/changed` 增加 `skillChangeSignal` 并刷新 `/` 列表。SkillsView 的 `refreshSignal` 改用新信号，不再复用 `agentChangeSignal`。

- [ ] **Step 4: 接入“我的技能”按钮和样式**

按钮只在“我的技能”标签显示，与“创建技能”和“导入技能”并存。扩展 `skillsView.spec.ts` 的 `mount` 夹具以接收并传递回调，**保留现有默认参数 `= { mine: [LOCAL] }` 与夹具内既有 rpc mock**（既有 4 处裸 `mount()` 调用依赖该默认值，不得破坏）：

```ts
async function mount(options: {
  mine: LocalSkillInfo[]
  warning?: string
  onStartConversationCreate?: () => void
} = { mine: [LOCAL] }): Promise<HTMLDivElement> {
  // 既有 rpc mock、container 与 root 初始化保持不变。
  await act(async () => {
    root!.render(createElement(SkillsView, {
      ...(options.onStartConversationCreate !== undefined
        ? { onStartConversationCreate: options.onStartConversationCreate }
        : {}),
    }))
  })
  await flush()
  return container!
}
```

App 传入两个回调并分清语义：**启动回调**（“对话创建技能”按钮）固定打开/复用普通会话标签并发送 `/create-skill`；**同意回调**（确认卡“确认创建”按钮）固定走普通 `send('确认')` 路径——两者不得互相串用。在 `appWiring.spec.ts` 对两个调用点分别加接线钉。点击“对话创建技能”后不得自动启用或跳转上传。修改 `styles.css` 后运行：

```bash
corepack yarn workspace dsh-plugin-huaanwork gen:styles
```

- [ ] **Step 5: 运行客户端、类型和全包门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/skill-confirm-card.spec.ts tests/client-huaanwork/skill-success-card.spec.ts tests/client-huaanwork/skillsView.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/styles-generated.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn workspace dsh-plugin-huaanwork check
```
Expected: 全部 PASS；`check` 中若出现既有 `verify:aa` 并发竞争，单独串行重跑并如实记录，不得写成通过。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/SkillConfirmCard.tsx dsh-plugin-huaanwork/src/client-huaanwork/SkillSuccessCard.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/tests/client-huaanwork/skill-confirm-card.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/skill-success-card.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/skillsView.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat(skills): complete conversational creation flow"
```

---

### Task 7: 人类验收（规格 §12.2）与证据落盘

**Files:**
- Create: `docs/evidence/2026-11-chat-created-skills-acceptance.md`（记录验收结果与证据）

**Interfaces:**
- Consumes: Task 1–6 全部已合入的构建产物；本任务只执行规格 §12.2 的五项人类验收并落盘证据，不改产品代码。

- [ ] **Step 1: 按规格 §12.2 逐项执行并记录**

以下五项必须真人执行，不得用自动化测试替代；每项记录环境（OS/构建号）、操作步骤、观察结果与截图/日志证据路径：

1. 从“我的技能”点击“对话创建技能”，完成访谈并看到确认卡。
2. 选择继续修改时草稿更新；选择取消时没有新技能。
3. 确认后成功卡出现，“我的技能”立即可见该技能且默认未启用；同一 `draftId` 的 `skill/success` 重放不新增第二张成功卡。
4. 手动启用后可通过 `/name` 调用；禁用后不可调用。
5. 全程没有生成脚本、端点或外部接口配置，没有自动上传或发布。

- [ ] **Step 2: 运行仓库根门禁**

Run:
```bash
corepack yarn check
```
Expected: PASS（若 `verify:aa` 并发竞争失败，串行重跑并如实记录）。根门禁结果与包级结果一并写入证据文档。

- [ ] **Step 3: Commit**

```bash
git add docs/evidence/2026-11-chat-created-skills-acceptance.md
git commit -m "docs(skills): record conversational creation human acceptance"
```

## Completion Criteria

- 从“我的技能”发起对话创建，确认后 `skill.mineList` 可见，默认未启用；启用后可 `/name` 调用，启用前 `/name` 不可调用。
- 两类草稿不能共存接管；普通技能/@ 回合不能借旧草稿提交，也不被互斥误拒。
- 同会话重复提交在编辑和上传后仍返回 `alreadyCommitted`，不覆盖后续内容；跨会话重放同一 draftId 被拒绝；成功卡按 `draftId` 去重，重放不产生第二张成功卡或第二个目录。
- 异常双草稿态 propose/commit/裸取消均被拒绝，`/create-skill cancel` 与 `/create-agent cancel` 只清指定流程并恢复剩余流程。
- 没有脚本、HTTP/MCP、自动启用、自动上传或第二套正式写盘路径。
- 包级 `typecheck` 与 `check` 已实际执行并记录真实结果；仓库根 `corepack yarn check` 已实际执行并记录真实结果。
- 规格 §12.2 五项人类验收已真人执行，证据落盘 `docs/evidence/2026-11-chat-created-skills-acceptance.md`；自动化门禁不替代人类验收。
