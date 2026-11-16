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
