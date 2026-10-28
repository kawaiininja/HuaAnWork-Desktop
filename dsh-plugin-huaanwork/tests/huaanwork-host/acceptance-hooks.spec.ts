import { describe, expect, test } from 'vitest'

import {
  HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV,
  HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV,
  HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS_ENV,
  HUAANWORK_ACCEPTANCE_HOLD_END_ENV,
  HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_ENV,
  HUAANWORK_ACCEPTANCE_HOOKS_ENV,
  HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME_ENV,
  HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS_ENV,
  HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV,
  HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV,
  HUAANWORK_ACCEPTANCE_TOOL_FAILURE_ENV,
  acceptanceCleanupTimeoutMs,
  acceptanceDisposeFailure,
  acceptanceExtraWarnings,
  acceptanceHoldEndMs,
  acceptanceHoldFinalizingMs,
  acceptanceHooksEnabled,
  acceptanceInjectToolName,
  acceptancePackageDelayMs,
  acceptancePackageDelayPoint,
  acceptanceTerminalReason,
  acceptanceToolFailure,
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

  test('disabled hooks keep every new seam inert', () => {
    const env = {
      [HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_ENV]: '100',
      [HUAANWORK_ACCEPTANCE_HOLD_END_ENV]: '100',
      [HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV]: 'createRuntime',
      [HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS_ENV]: '100',
      [HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME_ENV]: 'injected_tool',
      [HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV]: 'max-tokens',
      [HUAANWORK_ACCEPTANCE_TOOL_FAILURE_ENV]: '1',
      [HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS_ENV]: '1',
    }
    expect(acceptanceHoldFinalizingMs(env)).toBe(0)
    expect(acceptanceHoldEndMs(env)).toBe(0)
    expect(acceptancePackageDelayPoint(env)).toBe('none')
    expect(acceptancePackageDelayMs(env)).toBe(0)
    expect(acceptanceInjectToolName(env)).toBeUndefined()
    expect(acceptanceTerminalReason(env)).toBeUndefined()
    expect(acceptanceToolFailure(env)).toBe(false)
    expect(acceptanceExtraWarnings(env)).toEqual([])
  })

  test('enabled hooks parse hold and package delays with fallback on invalid values', () => {
    const base = { [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '1' }
    expect(acceptanceHoldFinalizingMs({ ...base, [HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_ENV]: '2500' })).toBe(2500)
    expect(acceptanceHoldEndMs({ ...base, [HUAANWORK_ACCEPTANCE_HOLD_END_ENV]: '12.6' })).toBe(13)
    for (const raw of [undefined, '', 'abc', '0', '-5', 'Infinity', 'NaN']) {
      const env = raw === undefined ? base : { ...base, [HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_ENV]: raw, [HUAANWORK_ACCEPTANCE_HOLD_END_ENV]: raw, [HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS_ENV]: raw }
      expect(acceptanceHoldFinalizingMs(env)).toBe(0)
      expect(acceptanceHoldEndMs(env)).toBe(0)
      expect(acceptancePackageDelayMs(env)).toBe(0)
    }
    expect(acceptancePackageDelayPoint({ ...base, [HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV]: 'createRuntime' })).toBe('createRuntime')
    expect(acceptancePackageDelayPoint({ ...base, [HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV]: 'startActivation' })).toBe('startActivation')
    for (const raw of [undefined, '', 'none', 'runtime', 'CreateRuntime']) {
      const env = raw === undefined ? base : { ...base, [HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV]: raw }
      expect(acceptancePackageDelayPoint(env)).toBe('none')
    }
  })

  test('enabled hooks inject tool, terminal reason, tool failure, and extra warnings with fallback', () => {
    const base = { [HUAANWORK_ACCEPTANCE_HOOKS_ENV]: '1' }
    expect(acceptanceInjectToolName({ ...base, [HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME_ENV]: ' injected_tool ' })).toBe('injected_tool')
    for (const raw of [undefined, '', '   ']) {
      const env = raw === undefined ? base : { ...base, [HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME_ENV]: raw }
      expect(acceptanceInjectToolName(env)).toBeUndefined()
    }
    expect(acceptanceTerminalReason({ ...base, [HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV]: 'max-tokens' })).toBe('max-tokens')
    expect(acceptanceTerminalReason({ ...base, [HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV]: 'refusal' })).toBe('refusal')
    expect(acceptanceTerminalReason({ ...base, [HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV]: 'unknown' })).toBe('unknown')
    for (const raw of [undefined, '', 'error', 'completed', 'Max-Tokens']) {
      const env = raw === undefined ? base : { ...base, [HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV]: raw }
      expect(acceptanceTerminalReason(env)).toBeUndefined()
    }
    expect(acceptanceToolFailure({ ...base, [HUAANWORK_ACCEPTANCE_TOOL_FAILURE_ENV]: '1' })).toBe(true)
    expect(acceptanceToolFailure({ ...base, [HUAANWORK_ACCEPTANCE_TOOL_FAILURE_ENV]: 'true' })).toBe(false)
    expect(acceptanceExtraWarnings({ ...base, [HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS_ENV]: '1' })).toEqual([
      { code: 'acceptance-warning-info', severity: 'info' },
      { code: 'acceptance-warning-error', severity: 'error' },
    ])
    expect(acceptanceExtraWarnings({ ...base, [HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS_ENV]: 'true' })).toEqual([])
  })
})
