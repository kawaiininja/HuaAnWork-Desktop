import { describe, expect, it } from 'vitest'
import { parseReviewVerdict, renderMemberOutput } from '../../src/huaanwork-host/expert-team/text-protocol.ts'

describe('renderMemberOutput', () => {
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
})

describe('parseReviewVerdict', () => {
  it('parses only the exact final verdict line', () => {
    expect(parseReviewVerdict('依据\n[VERDICT: PASS]\n')).toEqual({ reviewVerdict: 'pass' })
    expect(parseReviewVerdict('依据\n[VERDICT: REVISE]')).toEqual({ reviewVerdict: 'revise' })
    expect(parseReviewVerdict('[VERDICT: PASS] extra')).toEqual({ reviewError: 'invalid-verdict' })
    expect(parseReviewVerdict('[VERDICT: PASS]\n没有标记')).toEqual({ reviewError: 'invalid-verdict' })
    expect(parseReviewVerdict('没有标记')).toEqual({ reviewError: 'invalid-verdict' })
  })
})
