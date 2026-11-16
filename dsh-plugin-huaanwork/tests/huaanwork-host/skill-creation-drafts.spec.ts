import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CorruptSkillCreationDraftError,
  commitSkillCreation,
  hasSkillCreationDraftOnDisk,
  loadSkillCreationDraft,
  proposeSkillCreation,
} from '../../src/huaanwork-host/skill-creation-drafts.ts'
import { createSkill, createSkillFromDraft, listUserSkills } from '../../src/huaanwork-host/skills-host.ts'
import { readSkillLocalState } from '../../src/huaanwork-host/skill-local-state.ts'

describe('skill creation drafts', () => {
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

  it('deletes a same-id draft left behind when a committed credential is replayed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-draft-credential-cleanup-'))
    const proposal = { name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报' }
    const proposed = await proposeSkillCreation(root, 'session-1', proposal)
    if (!proposed.ok) throw new Error('propose failed')

    // 模拟崩溃窗口:状态写入成功、草稿尚未删除;重放命中凭证时必须补上这次清理,
    // 否则会话会带着草稿继续注入访谈,即使成功早已展示。
    const created = await createSkillFromDraft(root, {
      name: proposal.name, description: proposal.description, content: proposal.body,
    }, proposed.draftId, 'session-1')
    expect(created).toEqual({ ok: true, name: 'daily-summary', alreadyCommitted: false })
    expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)

    const replay = await commitSkillCreation(root, 'session-1', proposed.draftId, '确认', {
      proposedThisTurn: false, creationTurn: true,
    })
    expect(replay).toMatchObject({ ok: true, alreadyCommitted: true, name: 'daily-summary' })
    expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(false)
  })

  it('never deletes a replaced draft when a committed credential is replayed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-draft-credential-mismatch-'))
    const first = await proposeSkillCreation(root, 'session-1', {
      name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
    })
    if (!first.ok) throw new Error('first propose failed')
    const created = await createSkillFromDraft(root, {
      name: 'daily-summary', description: '生成日报', content: '整理输入并生成日报',
    }, first.draftId, 'session-1')
    expect(created.ok).toBe(true)

    // 新 propose 用不同 draftId 替换了草稿;重放旧凭证不得误删新草稿。
    const second = await proposeSkillCreation(root, 'session-1', {
      name: 'weekly-report', description: '生成周报', body: '整理周报素材',
    })
    if (!second.ok) throw new Error('second propose failed')
    expect(second.draftId).not.toBe(first.draftId)

    const replay = await commitSkillCreation(root, 'session-1', first.draftId, '确认', {
      proposedThisTurn: false, creationTurn: true,
    })
    expect(replay).toMatchObject({ ok: true, alreadyCommitted: true, name: 'daily-summary' })
    expect(loadSkillCreationDraft(root, 'session-1')?.draftId).toBe(second.draftId)
    expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
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
    expect(readSkillLocalState(root).skills['daily-summary']!.creationDraftId).toBe(proposed.draftId)
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

  it('fails closed when proposing over a corrupt draft without overwriting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-draft-propose-corrupt-'))
    try {
      const path = join(root, 'skill-creation-drafts', 'session-1.json')
      await mkdir(join(root, 'skill-creation-drafts'), { recursive: true })
      await writeFile(path, '{corrupt')
      await expect(proposeSkillCreation(root, 'session-1', {
        name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报',
      })).rejects.toThrow(CorruptSkillCreationDraftError)
      expect(await readFile(path, 'utf8')).toBe('{corrupt')
      expect(await listUserSkills(root)).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
    expect(committed.fieldErrors[0]!.field).toBe('name')
    expect(hasSkillCreationDraftOnDisk(root, 'session-1')).toBe(true)
    const skills = await listUserSkills(root)
    expect(skills).toHaveLength(1)
    expect(skills[0]!.description).toBe('既有技能')
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
})
