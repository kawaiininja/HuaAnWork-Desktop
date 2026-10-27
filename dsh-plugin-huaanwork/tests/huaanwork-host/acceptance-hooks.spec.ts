import { describe, expect, test } from 'vitest'

import {
  HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV,
  HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV,
  HUAANWORK_ACCEPTANCE_HOOKS_ENV,
  acceptanceCleanupTimeoutMs,
  acceptanceDisposeFailure,
  acceptanceHooksEnabled,
} from '../../src/huaanwork-host/acceptance-hooks.ts'

/**
 * 验收注入缝的契约:主开关关闭时一切返回值等于生产默认;打开后只接受
 * 明确的合法值,其余一律回落。测试用普通对象 env,不改 `process.env`。
 */

const FALLBACK_TIMEOUT_MS = 600_000

describe('acceptance hooks', () => {
  test('master switch is on only for the exact value "1"', () => {
    expect(acceptanceHooksEnabled({})).toBe(false)
    expect(acceptanceHooksEnabled({ [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '0' })).toBe(false)
    expect(acceptanceHooksEnabled({ [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: 'true' })).toBe(false)
    expect(acceptanceHooksEnabled({ [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '1' })).toBe(true)
  })

  test('disabled hooks keep the production timeout and dispose mode', () => {
    const env = {
      [HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV]: '25',
      [HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV]: 'reject',
    }
    expect(acceptanceCleanupTimeoutMs(FALLBACK_TIMEOUT_MS, env)).toBe(FALLBACK_TIMEOUT_MS)
    expect(acceptanceDisposeFailure(env)).toBe('none')
  })

  test('enabled hooks accept a finite positive timeout and round it', () => {
    const base = { [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '1' }
    expect(
      acceptanceCleanupTimeoutMs(FALLBACK_TIMEOUT_MS, { ...base, [HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV]: '2500' }),
    ).toBe(2500)
    expect(
      acceptanceCleanupTimeoutMs(FALLBACK_TIMEOUT_MS, { ...base, [HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV]: '12.6' }),
    ).toBe(13)
  })

  test('enabled hooks fall back for missing, malformed, non-finite, and non-positive timeouts', () => {
    const base = { [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '1' }
    for (const raw of [undefined, '', 'abc', '0', '-5', 'Infinity', 'NaN']) {
      const env = raw === undefined ? base : { ...base, [HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV]: raw }
      expect(acceptanceCleanupTimeoutMs(FALLBACK_TIMEOUT_MS, env)).toBe(FALLBACK_TIMEOUT_MS)
    }
  })

  test('enabled hooks inject only the exact dispose values reject and hang', () => {
    const base = { [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '1' }
    expect(acceptanceDisposeFailure({ ...base, [HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV]: 'reject' })).toBe('reject')
    expect(acceptanceDisposeFailure({ ...base, [HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV]: 'hang' })).toBe('hang')
    for (const raw of [undefined, '', 'none', 'timeout', 'Reject']) {
      const env = raw === undefined ? base : { ...base, [HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV]: raw }
      expect(acceptanceDisposeFailure(env)).toBe('none')
    }
  })
})
