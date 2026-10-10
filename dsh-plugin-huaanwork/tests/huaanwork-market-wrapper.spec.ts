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
    expect(HUAANWORK_MARKET_DEFAULT_ORIGIN).toBe('http://market.intranet.lan:8787')
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
  it('keeps the empty default pin fail-closed and ships a paired release pin', () => {
    expect(DEFAULT_MARKET_VERIFICATION_PINS).toEqual({})
    expect(() => assertMarketVerificationReady(DEFAULT_MARKET_VERIFICATION_PINS)).toThrow(/no pinned verification public key/u)
    expect(() => assertMarketVerificationReady({})).toThrow(HuaanworkMarketConfigError)
    const pinned = assertMarketVerificationReady(PINS_AT_RELEASE)
    expect(pinned.publicKeyHex).toMatch(/^[0-9a-f]{64}$/u)
    expect(pinned.keyId).toMatch(/^[0-9a-f]{64}$/u)
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

  /**
   * P13(Task 6.9):槽 2 `retiredAt` 判定只允许有一个实现——`verify.ts` 的
   * `marketKeySlotsFromPins`(Task 6.1 起 keyId 权威,槽号只是元数据)。config.ts
   * 的 `usableMarketVerificationKeys` 是其重复实现(且生产零消费),已删除;
   * 该判定的行为面由 market-verify.spec.ts 的向量回放与旋转窗用例钉住。
   */
  it('P13: there is exactly one implementation of the slot retirement rule', async () => {
    const configExports = (await import('../src/huaanwork-host/market/config.ts')) as unknown as Record<string, unknown>
    const verifyExports = (await import('../src/huaanwork-host/market/verify.ts')) as unknown as Record<string, unknown>
    expect('usableMarketVerificationKeys' in configExports).toBe(false)
    expect(typeof verifyExports.marketKeySlotsFromPins).toBe('function')
  })
})

describe('huaanwork-market bundle surface', () => {
  it('declares the canonical bundle identity and the four-capability inject surface', () => {
    expect(name).toBe(HUAANWORK_MARKET_BUNDLE_NAME)
    expect(inject).toEqual(['webServer', 'desktopProfiles', 'desktopPnpm', 'desktopRuntime'])
    // Task 5:恰 7 条表外 routes(守则 5);routes spec 断言逐一注册且总量恰 7。
    expect(HUAANWORK_MARKET_ROUTES).toEqual([
      '/api/huaanwork-market/state',
      '/api/huaanwork-market/catalog',
      '/api/huaanwork-market/installable',
      '/api/huaanwork-market/installations',
      '/api/huaanwork-market/operations/preview',
      '/api/huaanwork-market/operations/execute',
      '/api/huaanwork-market/desktop/request-restart',
    ])
    expect(HUAANWORK_MARKET_SUBPATH_EXPORT).toBe('./huaanwork-market')
  })

  function fakeCtx(overrides: Record<string, unknown>): Context {
    return {
      effect: () => {},
      logger: { info: () => {} },
      webServer: {
        port: 9,
        register: () => () => {},
      },
      ...overrides,
    } as unknown as Context
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
