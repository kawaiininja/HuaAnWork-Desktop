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
