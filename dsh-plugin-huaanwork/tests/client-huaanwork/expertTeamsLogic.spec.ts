import { describe, expect, it } from 'vitest'
import type { ExpertTeam } from '../../src/client-huaanwork/rpc-types.ts'
import { validTeamInput } from '../fixtures/expert-team/team.ts'
import {
  atExpertTeams,
  composerAtTokenAt,
  defaultExpertTeamRules,
  effectiveTeamMaxParallel,
  expertTeamMentionSummary,
  leadingTeamAtSlug,
  mentionKeyAction,
  parseTeamAtInvoke,
  resolveComposerMentionState,
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

  it('derives rule defaults from overridden members', () => {
    const executorOnly = validTeamInput({
      members: [
        { memberId: 'm-exec-1', agentRef: { source: 'local', slug: 'writer' }, role: 'executor', responsibility: '提取合同关键条款并起草结论' },
        { memberId: 'm-exec-2', agentRef: { source: 'local', slug: 'writer-2' }, role: 'executor', responsibility: '整理业务背景与合规依据' },
      ],
    })
    expect(validateExpertTeam(executorOnly)).toMatchObject({ ok: true, team: { review: { mode: 'none' } } })
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
    // 开头已是 `@team:<slug>` 时，正文中段 `@` 按普通文本处理，不再弹出智能体补全菜单诱导混用；
    // 光标回到开头 `@team:` token 内仍可编辑/切换目标。
    expect(resolveComposerMentionState('@team:compliance 请看 @writer', 27)).toBeUndefined()
    expect(resolveComposerMentionState('@team:comp 请看 @writer', 10)).toEqual({
      token: { query: 'team:comp', start: 0, end: 10 },
      allowTeams: true,
    })
  })

  it('classifies leading @team targets into valid, empty-task, conflict, or non-team', () => {
    expect(parseTeamAtInvoke('@team:compliance 审查合同')).toEqual({ kind: 'valid', name: 'compliance', remainder: '审查合同' })
    expect(parseTeamAtInvoke('@team:compliance   ')).toEqual({ kind: 'empty-task', name: 'compliance' })
    expect(parseTeamAtInvoke('@team:compliance')).toEqual({ kind: 'empty-task', name: 'compliance' })
    expect(parseTeamAtInvoke('@team:one @team:two 审查')).toEqual({ kind: 'conflict', reason: 'multiple-targets' })
    // 紧跟中文标点的第二个 `@team:` 目标同样判定冲突，但邮箱/词中 `@team:` 不误判。
    expect(parseTeamAtInvoke('@team:one 和 @team:two，请一起审')).toEqual({ kind: 'conflict', reason: 'multiple-targets' })
    expect(parseTeamAtInvoke('@team:one 联系 user@team:two')).toEqual({
      kind: 'valid',
      name: 'one',
      remainder: '联系 user@team:two',
    })
    // 规格 §11.2 裁定：只有正文第二个 `@team:` 目标是冲突；正文 @word 是普通文本。
    expect(parseTeamAtInvoke('@team:one @writer 审查')).toEqual({
      kind: 'valid',
      name: 'one',
      remainder: '@writer 审查',
    })
    expect(parseTeamAtInvoke('@team:dev 把结果发到 @dev 频道')).toEqual({
      kind: 'valid',
      name: 'dev',
      remainder: '把结果发到 @dev 频道',
    })
    expect(parseTeamAtInvoke('正文 @team:compliance 审查')).toBeUndefined()
    expect(parseTeamAtInvoke('@writer 审查')).toBeUndefined()
  })

  it('does not select or submit while composing Chinese text', () => {
    expect(mentionKeyAction({ key: 'Enter', isComposing: true, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'none' })
    expect(mentionKeyAction({ key: 'Tab', isComposing: false, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'pick', index: 0 })
    expect(mentionKeyAction({ key: 'ArrowDown', isComposing: false, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'move', index: 1 })
    expect(mentionKeyAction({ key: 'Escape', isComposing: false, itemCount: 2, activeIndex: 0 })).toEqual({ kind: 'close' })
  })

  it('summarizes members, orchestration, review and delivery for the composer token', () => {
    const team = validTeam()
    expect(expertTeamMentionSummary(team)).toBe('2 名成员 · 按职责分工 · 并行（≤2） · 统一审查 · Markdown Artifact')
  })
})
