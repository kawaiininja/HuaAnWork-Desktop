/**
 * Review fix #3: the acceptance probe's depth-degradation detector.
 *
 * `scripts/huaanwork-acceptance-degradation.mjs` is a plain ESM module (the probe
 * is a `.mjs` script, not part of any `tsc` program), so the import carries a
 * `@ts-expect-error` for the missing declaration file.
 *
 * The detector must FAIL a double-blind run only when the model reports an
 * affirmative depth degradation. A healthy-path report that NEGATES degradation
 * — including compound negations like "未降级为单会话多轮自审" — must NOT trip it.
 * The affirmative set must still catch every real degradation phrase.
 */

import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped ESM helper shared with the .mjs acceptance probe
import { reportsDepthDegradation } from '../../scripts/huaanwork-acceptance-degradation.mjs'

describe('acceptance probe depth-degradation detector', () => {
  it('does not trip on compound negations of the healthy path', () => {
    // These describe the HEALTHY path (no degradation). Each must be false.
    assert.equal(reportsDepthDegradation('未降级为单会话多轮自审'), false)
    assert.equal(reportsDepthDegradation('不存在深度降级'), false)
    assert.equal(reportsDepthDegradation('双路一致，未降级为单会话多轮自审'), false)
    assert.equal(reportsDepthDegradation('没有降级为单会话'), false)
  })

  it('does not trip on simple negations or the R1 cross-validation downgrade', () => {
    assert.equal(reportsDepthDegradation('未降级'), false)
    assert.equal(reportsDepthDegradation('未触发深度降级'), false)
    assert.equal(reportsDepthDegradation('没有发生深度降级'), false)
    // R1 same-model cross-validation downgrade is always disclosed; not a depth degradation.
    assert.equal(reportsDepthDegradation('交叉验证已降级'), false)
    assert.equal(reportsDepthDegradation('两路一致，未触发深度降级，交叉验证已降级'), false)
  })

  it('still catches every affirmative depth-degradation phrase', () => {
    expect(reportsDepthDegradation('当前环境递归深度不足，已降级为单会话多轮自审')).toBe(true)
    expect(reportsDepthDegradation('SubagentDepthError: subagent depth 2 exceeds maxDepth 1')).toBe(true)
    expect(reportsDepthDegradation('非双盲')).toBe(true)
    expect(reportsDepthDegradation('深度降级')).toBe(true)
    expect(reportsDepthDegradation('降级为单会话')).toBe(true)
    expect(reportsDepthDegradation('递归深度不足')).toBe(true)
  })
})