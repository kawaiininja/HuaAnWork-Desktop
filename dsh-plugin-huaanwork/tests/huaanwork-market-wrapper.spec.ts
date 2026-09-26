import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  assertMarketVerificationReady,
  DEFAULT_MARKET_VERIFICATION_PINS,
  HUAANWORK_MARKET_BUNDLE_NAME,
  HuaanworkMarketConfigError,
  HUAANWORK_MARKET_DEFAULT_ORIGIN,
  HUAANWORK_MARKET_ORIGIN_ENV,
  HUAANWORK_MARKET_SUBPATH_EXPORT,
  PINS_AT_RELEASE,
  parsePinnedMarketKey,
  resolveMarketOrigin,
  usableMarketVerificationKeys,
  type MarketVerificationPins,
} from '../src/huaanwork-host/market/config.ts'
import {
  apply,
  HUAANWORK_MARKET_ROUTES,
  inject,
  name,
} from '../src/huaanwork-host/market/index.ts'

const THROWAWAY_TEST_KEY_HEX = '64322a78276819bd7312efdbbe338ba69b74035ce772a21c9dda63773d45ab69'

function envWith(origin?: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {}
  if (origin !== undefined) env[HUAANWORK_MARKET_ORIGIN_ENV] = origin
  return env as NodeJS.ProcessEnv
}

describe('huaanwork-market config origin', () => {
  it('pins the compiled-in intranet origin by default', () => {
    expect(resolveMarketOrigin(envWith())).toBe(HUAANWORK_MARKET_DEFAULT_ORIGIN)
    expect(HUAANWORK_MARKET_DEFAULT_ORIGIN).toBe('http://market.intranet.example:8787')
  })

  it('honors the HUAANWORK_MARKET_ORIGIN env override and normalizes to a bare origin', () => {
    expect(resolveMarketOrigin(envWith('http://market.internal:9000/'))).toBe('http://market.internal:9000')
    expect(resolveMarketOrigin(envWith('https://market.internal'))).toBe('https://market.internal')
  })

  it.each([
    'ftp://market.internal',
    'http://user@market.internal',
    'http://user:pass@market.internal',
    'http://market.internal/path',
    'http://market.internal?query=1',
    'http://market.internal#fragment',
    '',
    'not a url',
  ])('rejects the invalid origin %j fail-closed', origin => {
    expect(() => resolveMarketOrigin(envWith(origin))).toThrow(HuaanworkMarketConfigError)
  })
})

describe('huaanwork-market pinned verification keys', () => {
  it('ships no placeholder key: verification always rejects until release provisioning', () => {
    expect(DEFAULT_MARKET_VERIFICATION_PINS).toEqual({})
    expect(PINS_AT_RELEASE).toBe(DEFAULT_MARKET_VERIFICATION_PINS)
    expect(() => assertMarketVerificationReady()).toThrow(/no pinned verification public key/u)
    expect(() => assertMarketVerificationReady({})).toThrow(HuaanworkMarketConfigError)
  })

  it('accepts the release-pinned current key only in raw 32-byte lowercase hex form', () => {
    const key = assertMarketVerificationReady({ current: { publicKeyHex: THROWAWAY_TEST_KEY_HEX } })
    expect(key.publicKeyHex).toBe(THROWAWAY_TEST_KEY_HEX)
    for (const publicKeyHex of [
      '64322A78276819BD7312EFDBBE338BA69B74035CE772A21C9DDA63773D45AB69', // uppercase
      '64322a78', // truncated
      `64322a78276819bd7312efdbbe338ba69b74035ce772a21c9dda63773d45ab69${'00'}`, // oversize
      'zz322a78276819bd7312efdbbe338ba69b74035ce772a21c9dda63773d45ab69', // non-hex
    ]) {
      expect(() => parsePinnedMarketKey({ publicKeyHex }, 'test key')).toThrow(HuaanworkMarketConfigError)
    }
  })

  it('resolves usable keys across the two-slot rotation window', () => {
    const current = { publicKeyHex: THROWAWAY_TEST_KEY_HEX }
    const previous = {
      key: { publicKeyHex: '472d9a7adf9dd19cc20f187551e94d73e1b380dd07c07c47c04f6d17f5dfc3b6' },
      retiredAt: '2026-10-01T00:00:00Z',
    }
    const now = new Date('2026-09-26T00:00:00Z')
    expect(usableMarketVerificationKeys({}, now)).toEqual([])
    expect(usableMarketVerificationKeys({ current }, now)).toEqual([current])
    expect(usableMarketVerificationKeys({ current, previous }, now)).toEqual([current, previous.key])
    // 槽 2 过 retiredAt 即拒(round4 C3)。
    const afterRetired = new Date('2026-10-02T00:00:00Z')
    expect(usableMarketVerificationKeys({ current, previous }, afterRetired)).toEqual([current])
    // 槽 2 缺/坏 retiredAt = 配置事故,fail-closed 抛错,不静默降级。
    const pinsWithoutRetiredAt: MarketVerificationPins = {
      current,
      previous: { key: previous.key } as unknown as NonNullable<MarketVerificationPins['previous']>,
    }
    expect(() => usableMarketVerificationKeys(pinsWithoutRetiredAt, now)).toThrow(HuaanworkMarketConfigError)
    expect(() => usableMarketVerificationKeys({
      current,
      previous: { key: previous.key, retiredAt: 'not-a-date' },
    }, now)).toThrow(/retiredAt/u)
  })
})

describe('huaanwork-market bundle surface', () => {
  it('declares the canonical bundle identity and the four-capability inject surface', () => {
    expect(name).toBe(HUAANWORK_MARKET_BUNDLE_NAME)
    expect(inject).toEqual(['webServer', 'desktopProfiles', 'desktopPnpm', 'desktopRuntime'])
    // Task 4 占位:routes 清单为空,Task 5 补 7 条表外 routes(守则 5)。
    expect(HUAANWORK_MARKET_ROUTES).toEqual([])
    expect(HUAANWORK_MARKET_SUBPATH_EXPORT).toBe('./huaanwork-market')
  })

  function fakeCtx(overrides: Record<string, unknown>): Context {
    return overrides as unknown as Context
  }

  it('apply throws named capability errors fail-closed on narrow hosts', () => {
    const complete = {
      desktopRuntime: { requestConfirmedRestart: async () => true },
      desktopProfiles: { current: { name: 'desktop', dir: '/tmp/profile' } },
      desktopPnpm: { runPlugin: () => { throw new Error('not reached') } },
    }
    expect(() => apply(fakeCtx({ ...complete, desktopRuntime: {} })))
      .toThrow('huaanwork-market: desktopRuntime 缺少 requestConfirmedRestart()')
    expect(() => apply(fakeCtx({ ...complete, desktopProfiles: { current: {} } })))
      .toThrow('huaanwork-market: desktopProfiles 缺少 current.dir')
    expect(() => apply(fakeCtx({ ...complete, desktopPnpm: {} })))
      .toThrow('huaanwork-market: desktopPnpm 缺少 runPlugin()')
  })

  it('apply resolves the pinned origin and rejects an invalid env override', () => {
    const complete = {
      desktopRuntime: { requestConfirmedRestart: async () => true },
      desktopProfiles: { current: { name: 'desktop', dir: '/tmp/profile' } },
      desktopPnpm: { runPlugin: () => { throw new Error('not reached') } },
    }
    const previous = process.env[HUAANWORK_MARKET_ORIGIN_ENV]
    try {
      process.env[HUAANWORK_MARKET_ORIGIN_ENV] = 'http://market.override:9999'
      expect(() => apply(fakeCtx(complete))).not.toThrow()
      process.env[HUAANWORK_MARKET_ORIGIN_ENV] = 'ftp://nope'
      expect(() => apply(fakeCtx(complete))).toThrow(HuaanworkMarketConfigError)
    } finally {
      if (previous === undefined) delete process.env[HUAANWORK_MARKET_ORIGIN_ENV]
      else process.env[HUAANWORK_MARKET_ORIGIN_ENV] = previous
    }
  })
})
