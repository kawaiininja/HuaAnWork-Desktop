import { describe, expect, it } from 'vitest'
import {
  buildSessionIdRewritePlan,
  rewriteSessionId,
  NEUTRAL_ROOT_SESSION_ID,
} from '../../src/huaanwork-migration/session-id.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'

describe('buildSessionIdRewritePlan', () => {
  it('derives both neutral ids with the shared sessionIdFor algorithm', () => {
    const plan = buildSessionIdRewritePlan('/old/cfg/dsh/workspace', '/new/profiles/desktop/workspace')
    expect(plan.oldNeutralId).toBe(sessionIdFor('/old/cfg/dsh/workspace'))
    expect(plan.newNeutralId).toBe(sessionIdFor('/new/profiles/desktop/workspace'))
    expect(plan.oldNeutralId).toMatch(NEUTRAL_ROOT_SESSION_ID)
    expect(plan.newNeutralId).toMatch(NEUTRAL_ROOT_SESSION_ID)
    expect(plan.oldNeutralId).not.toBe(plan.newNeutralId)
  })

  it('is a no-op plan when the neutral root did not move', () => {
    const plan = buildSessionIdRewritePlan('/same/workspace', '/same/workspace')
    expect(plan.oldNeutralId).toBe(plan.newNeutralId)
  })
})

describe('rewriteSessionId', () => {
  const plan = { oldNeutralId: 'huaanwork-0000000000000000', newNeutralId: 'huaanwork-1111111111111111' }

  it('re-mints the neutral root session', () => {
    expect(rewriteSessionId('huaanwork-0000000000000000', plan)).toBe('huaanwork-1111111111111111')
  })

  it('re-mints the parent digest and preserves the random suffix', () => {
    expect(rewriteSessionId('huaanwork-0000000000000000-abcd1234', plan))
      .toBe('huaanwork-1111111111111111-abcd1234')
  })

  it.each([
    'huaanwork-2222222222222222',
    'huaanwork-2222222222222222-abcd1234',
    'huaanwork-chat-9f8e7d6c5b4a3210',
    'huaanwork-auto-a1-r1',
    'huaanwork-chat-auto-a1-r1',
    'unrelated-id',
  ])('carries %s verbatim', id => {
    expect(rewriteSessionId(id, plan)).toBe(id)
  })
})
