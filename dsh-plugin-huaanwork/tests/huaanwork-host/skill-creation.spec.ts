import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CorruptSkillCreationDraftError,
  hasSkillCreationDraftOnDisk,
  proposeSkillCreation,
} from '../../src/huaanwork-host/skill-creation-drafts.ts'
import { createSkillCreationHost, injectCreateSkill } from '../../src/huaanwork-host/skill-creation.ts'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-creation-host-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

const PROPOSAL = {
  name: 'daily-summary',
  description: '生成日报',
  whenToUse: '需要汇总一天工作时',
  body: '整理输入并生成日报',
}

describe('SkillCreationHost turn state', () => {
  it('owns both turn markers and rejects a same-turn commit', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })
    const sessionId = 'session-1'

    host.noteCreationTurn(sessionId, '帮我创建一个技能')
    const proposed = await host.propose(sessionId, PROPOSAL)
    expect(proposed).toMatchObject({ ok: true, proposal: PROPOSAL })
    if (!proposed.ok) return
    expect(host.hasDraft(sessionId)).toBe(true)

    // 同一轮刚 propose 不能 commit:宿主自己读取 proposedThisTurn,路由不得覆盖。
    const sameTurn = await host.commit(sessionId, proposed.draftId, '确认')
    expect(sameTurn).toMatchObject({ ok: false })
    if (!sameTurn.ok) expect(sameTurn.fieldErrors.map((error) => error.field)).toContain('draftId')

    // 下一轮同意句:路由只调用 noteCreationTurn,宿主自己清除 propose 标记并放行。
    host.noteCreationTurn(sessionId, '确认')
    const committed = await host.commit(sessionId, proposed.draftId, '确认')
    expect(committed).toMatchObject({ ok: true, name: 'daily-summary', alreadyCommitted: false })
    expect(host.hasDraft(sessionId)).toBe(false)

    const replay = await host.commit(sessionId, proposed.draftId, '确认')
    expect(replay).toMatchObject({ ok: true, alreadyCommitted: true, name: 'daily-summary' })
  })

  it('lets noteUserText overwrite the raw sentence and clear both turn markers', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })
    const sessionId = 'session-1'

    host.noteCreationTurn(sessionId, '帮我创建一个技能')
    const proposed = await host.propose(sessionId, PROPOSAL)
    if (!proposed.ok) throw new Error('propose failed')
    expect(host.lastUserText(sessionId)).toBe('帮我创建一个技能')

    host.noteUserText(sessionId, '普通聊天')
    expect(host.lastUserText(sessionId)).toBe('普通聊天')
    const rejected = await host.commit(sessionId, proposed.draftId, '普通聊天')
    expect(rejected).toMatchObject({ ok: false })
    if (!rejected.ok) expect(rejected.fieldErrors.map((error) => error.field)).toContain('consent')

    // 即使下一轮是同意句,没有命中创建入口也不能凭旧草稿提交。
    host.noteUserText(sessionId, '确认')
    const stillRejected = await host.commit(sessionId, proposed.draftId, '确认')
    expect(stillRejected).toMatchObject({ ok: false })
    if (!stillRejected.ok) expect(stillRejected.fieldErrors.map((error) => error.field)).toContain('consent')
    expect(host.hasDraft(sessionId)).toBe(true)
  })

  it('requires a later creation turn even when the draft was proposed', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })
    const sessionId = 'session-1'

    host.noteCreationTurn(sessionId, '帮我创建一个技能')
    const proposed = await host.propose(sessionId, PROPOSAL)
    if (!proposed.ok) throw new Error('propose failed')

    host.noteUserText(sessionId, '确认')
    const rejected = await host.commit(sessionId, proposed.draftId, '确认')
    expect(rejected).toMatchObject({ ok: false })
    if (!rejected.ok) expect(rejected.fieldErrors.map((error) => error.field)).toContain('consent')
  })

  it('caps lastText and creationTurns at 256 sessions with insertion-order LRU', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })

    for (let index = 0; index <= 256; index += 1) host.noteUserText(`session-${String(index)}`, `text-${String(index)}`)
    expect(host.lastUserText('session-0')).toBeUndefined()
    expect(host.lastUserText('session-1')).toBe('text-1')
    expect(host.lastUserText('session-256')).toBe('text-256')

    for (let index = 0; index <= 256; index += 1) host.noteCreationTurn(`turn-${String(index)}`, '确认')
    expect(host.lastUserText('turn-0')).toBeUndefined()
    expect(host.lastUserText('turn-256')).toBe('确认')

    // 插入顺序 LRU 只淘汰最老会话:第 0 个会话不再被视为创建轮。
    const evicted = await host.commit('turn-0', 'missing-draft', '确认')
    expect(evicted).toMatchObject({ ok: false })
    if (!evicted.ok) expect(evicted.fieldErrors[0]?.message).toContain('不是技能创建或继续创建')
    const kept = await host.commit('turn-256', 'missing-draft', '确认')
    expect(kept).toMatchObject({ ok: false })
    if (!kept.ok) expect(kept.fieldErrors[0]?.message).toContain('技能草稿不存在')
  })
})

describe('SkillCreationHost disk truth', () => {
  it('reads hasDraft from disk instead of a memory cache', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })
    const sessionId = 'session-1'

    expect(host.hasDraft(sessionId)).toBe(false)
    const proposed = await host.propose(sessionId, PROPOSAL)
    if (!proposed.ok) throw new Error('propose failed')
    expect(hasSkillCreationDraftOnDisk(root, sessionId)).toBe(true)
    expect(host.hasDraft(sessionId)).toBe(true)

    // 带外删除草稿后宿主立即读到不存在,不保留任何内存镜像。
    rmSync(join(root, 'skill-creation-drafts', `${sessionId}.json`), { force: true })
    expect(host.hasDraft(sessionId)).toBe(false)

    // 另一个进程写入的草稿同样被读到(跨重启的互斥事实源)。
    await proposeSkillCreation(root, 'session-2', { ...PROPOSAL, name: 'other-summary' })
    expect(host.hasDraft('session-2')).toBe(true)
  })

  it('describes the draft by name and fails closed on a corrupt draft', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })

    expect(host.describeDraft('session-1')).toBeUndefined()
    await proposeSkillCreation(root, 'session-1', PROPOSAL)
    expect(host.describeDraft('session-1')).toBe('daily-summary')

    mkdirSync(join(root, 'skill-creation-drafts'), { recursive: true })
    writeFileSync(join(root, 'skill-creation-drafts', 'session-2.json'), '{corrupt', 'utf8')
    expect(() => host.describeDraft('session-2')).toThrow(CorruptSkillCreationDraftError)
  })

  it('cancels only the skill draft and respects the agent-draft mutual exclusion', async () => {
    const root = makeRoot()
    const host = createSkillCreationHost({ profileDir: root })
    const sessionId = 'session-1'

    await proposeSkillCreation(root, sessionId, PROPOSAL)
    expect(await host.cancel(sessionId)).toBe(true)
    expect(hasSkillCreationDraftOnDisk(root, sessionId)).toBe(false)

    await proposeSkillCreation(root, sessionId, PROPOSAL)
    mkdirSync(join(root, 'agents', '.drafts'), { recursive: true })
    const agentDraft = join(root, 'agents', '.drafts', `${sessionId}.json`)
    writeFileSync(agentDraft, '{"keep":"me"}', 'utf8')

    expect(await host.cancel(sessionId)).toBe(false)
    expect(hasSkillCreationDraftOnDisk(root, sessionId)).toBe(true)

    expect(await host.cancel(sessionId, { explicit: true })).toBe(true)
    expect(hasSkillCreationDraftOnDisk(root, sessionId)).toBe(false)
    expect(host.describeDraft(sessionId)).toBeUndefined()
  })
})

describe('injectCreateSkill', () => {
  it('injects the internal create-skill body for both entry modes', () => {
    const created = injectCreateSkill('帮我创建一个技能', 'create')
    expect(created).toContain('对话创建技能')
    expect(created).toContain('skill_propose')
    expect(created).toContain('帮我创建一个技能')

    const continued = injectCreateSkill('可以', 'continue')
    expect(continued).toContain('skill_commit')
    expect(continued).toContain('沿用已有草稿')
  })
})
