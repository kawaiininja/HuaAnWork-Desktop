import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseServerArgv } from '../src/argv.ts'
import { ConfigError, ENV_KEYS, loadConfig } from '../src/config.ts'

const VALID_KEY_HEX = 'a1'.repeat(32)

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [ENV_KEYS.port]: '8787',
    [ENV_KEYS.dataDir]: '/tmp/market-server-test-data',
    [ENV_KEYS.publicOrigin]: 'http://market.intranet.example:8787',
    [ENV_KEYS.verifyPublicKeyPath]: '/tmp/market-server-test-key.hex',
    [ENV_KEYS.adminToken]: 'test-admin-token',
    ...overrides,
  }
}

describe('loadConfig', () => {
  let keyDir: string
  let keyPath: string
  let dataDir: string

  beforeEach(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'market-server-key-'))
    keyPath = join(keyDir, 'verify.pub.hex')
    await writeFile(keyPath, `${VALID_KEY_HEX}\n`, { mode: 0o600 })
    dataDir = await mkdtemp(join(tmpdir(), 'market-server-data-'))
  })

  function completeEnv(): NodeJS.ProcessEnv {
    return env({
      [ENV_KEYS.verifyPublicKeyPath]: keyPath,
      [ENV_KEYS.dataDir]: dataDir,
    })
  }

  it('loads a complete configuration', () => {
    const config = loadConfig(completeEnv())
    expect(config.port).toBe(8787)
    expect(config.dataDir).toBe(dataDir)
    expect(config.publicOrigin).toBe('http://market.intranet.example:8787')
    expect(config.verifyPublicKeyHex).toBe(VALID_KEY_HEX)
    expect(config.adminToken).toBe('test-admin-token')
  })

  it('fails closed when any required variable is missing, with guidance', () => {
    for (const key of Object.values(ENV_KEYS)) {
      // Optional keys have documented defaults: the admin token disables the
      // admin surface (Task 2), the catalog cap defaults to the contract
      // maximum (Task 6.4), and the P8 hardening knobs have explicit defaults.
      if (
        key === ENV_KEYS.adminToken
        || key === ENV_KEYS.maxCatalogEntries
        || key === ENV_KEYS.allowedHosts
        || key === ENV_KEYS.maxConcurrentUploads
      ) continue
      const partial = completeEnv()
      delete partial[key]
      let caught: unknown
      try {
        loadConfig(partial)
      } catch (cause) {
        caught = cause
      }
      expect(caught, `expected failure when ${key} is missing`).toBeInstanceOf(ConfigError)
      expect((caught as ConfigError).message).toContain(key)
      expect((caught as ConfigError).message).toContain(ENV_KEYS.port)
    }
  })

  it('treats a missing or empty admin token as "admin surface disabled" (fail-closed)', () => {
    const missing = completeEnv()
    delete missing[ENV_KEYS.adminToken]
    expect(loadConfig(missing).adminToken).toBeNull()
    expect(loadConfig(completeEnvWith({ [ENV_KEYS.adminToken]: '   ' })).adminToken).toBeNull()
    expect(loadConfig(completeEnv()).adminToken).toBe('test-admin-token')
  })

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.port]: 'abc' }))).toThrow(ConfigError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.port]: '70000' }))).toThrow(ConfigError)
  })

  it('rejects an unparseable public origin', () => {
    expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.publicOrigin]: 'not a url' }))).toThrow(ConfigError)
  })

  it('rejects origins with credentials, query, or fragment', () => {
    for (const bad of [
      'http://user:pass@market.intranet.example:8787',
      'http://market.intranet.example:8787/?x=1',
      'http://market.intranet.example:8787/#x',
      'ftp://market.intranet.example:8787',
    ]) {
      expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.publicOrigin]: bad })), bad).toThrow(ConfigError)
    }
  })

  it('accepts plain http origins (intranet; authenticity comes from the signed manifest)', () => {
    const config = loadConfig(completeEnvWith({ [ENV_KEYS.publicOrigin]: 'http://market.intranet.example:8787' }))
    expect(config.publicOrigin).toBe('http://market.intranet.example:8787')
  })

  it('fails closed when the verify public key file is missing or malformed', async () => {
    expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.verifyPublicKeyPath]: join(keyDir, 'nope.hex') }))).toThrow(ConfigError)
    const badPath = join(keyDir, 'bad.hex')
    await writeFile(badPath, 'zz'.repeat(32), { mode: 0o600 })
    expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.verifyPublicKeyPath]: badPath }))).toThrow(ConfigError)
  })

  // 裁定 R-3 / 评审 D15:上游契约只允许单个 provider page(`items` maxItems 200),
  // 故 200 是**契约天花板**而非本服务的实现选择。可配置只允许调低;调高在启动时
  // 诚实失败(放得更宽只会把失败推迟到 prepare 阶段,即 D15 修掉的冻结态)。
  describe('catalog scale cap (D15 / ruling R-3)', () => {
    it('defaults to the upstream contract maximum of 200 entries', () => {
      expect(loadConfig(completeEnv()).maxCatalogEntries).toBe(200)
    })

    it('refuses to configure a cap above the contract maximum, citing the upstream maxItems', () => {
      let caught: unknown
      try {
        loadConfig(completeEnvWith({ [ENV_KEYS.maxCatalogEntries]: '201' }))
      } catch (cause) {
        caught = cause
      }
      expect(caught).toBeInstanceOf(ConfigError)
      const message = (caught as ConfigError).message
      expect(message).toContain(ENV_KEYS.maxCatalogEntries)
      expect(message).toContain('maxItems')
      expect(message).toContain('200')
    })

    it('allows a lower cap for a small deployment', () => {
      expect(loadConfig(completeEnvWith({ [ENV_KEYS.maxCatalogEntries]: '50' })).maxCatalogEntries).toBe(50)
    })

    it('rejects a cap that is not a positive integer', () => {
      for (const bad of ['abc', '0', '-1', '1.5']) {
        expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.maxCatalogEntries]: bad })), bad).toThrow(ConfigError)
      }
    })
  })

  // P8 (Task 6.5): the Host whitelist and the upload concurrency cap are part of
  // config (same shape as update-server's UPDATE_SERVER_ALLOWED_HOSTS), and the
  // three server timeouts have explicit non-zero defaults.
  describe('operational hardening config (P8)', () => {
    it('derives the Host whitelist from the public origin when unset', () => {
      expect(loadConfig(completeEnv()).allowedHosts).toEqual(['market.intranet.example:8787'])
    })

    it('accepts an explicit comma-separated whitelist', () => {
      const config = loadConfig(completeEnvWith({ [ENV_KEYS.allowedHosts]: 'market.intranet.example:8787, 10.0.0.5' }))
      expect(config.allowedHosts).toEqual(['market.intranet.example:8787', '10.0.0.5'])
    })

    it('treats a blank whitelist as unset and rejects wildcard or garbage entries', () => {
      const derived = loadConfig(completeEnv()).allowedHosts
      expect(loadConfig(completeEnvWith({ [ENV_KEYS.allowedHosts]: '   ' })).allowedHosts).toEqual(derived)
      expect(loadConfig(completeEnvWith({ [ENV_KEYS.allowedHosts]: ',' })).allowedHosts).toEqual(derived)
      for (const bad of ['*,market.intranet.example:8787', 'market.intranet.example:8787/evil', 'a b', 'host:70000']) {
        expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.allowedHosts]: bad })), bad).toThrow(ConfigError)
      }
    })

    it('defaults the upload concurrency cap and rejects a non-positive one', () => {
      expect(loadConfig(completeEnv()).maxConcurrentUploads).toBeGreaterThan(0)
      expect(loadConfig(completeEnvWith({ [ENV_KEYS.maxConcurrentUploads]: '2' })).maxConcurrentUploads).toBe(2)
      for (const bad of ['0', '-1', 'abc']) {
        expect(() => loadConfig(completeEnvWith({ [ENV_KEYS.maxConcurrentUploads]: bad })), bad).toThrow(ConfigError)
      }
    })

    it('keeps the three server timeouts explicit and non-zero', () => {
      const config = loadConfig(completeEnv())
      expect(config.requestTimeoutMs).toBeGreaterThan(0)
      expect(config.headersTimeoutMs).toBeGreaterThan(0)
      expect(config.socketTimeoutMs).toBeGreaterThan(0)
    })
  })

  // Mirrors update-server/tests/config.spec.ts (Task 3.5): the two servers expose
  // the same CLI conveniences, and the environment stays authoritative on both.
  describe('server argv', () => {
    it('accepts --port and --data as conveniences', () => {
      expect(parseServerArgv(['--port', '9000', '--data', '/srv/u'])).toEqual({ port: '9000', dataDir: '/srv/u' })
    })

    it('ignores unknown flags rather than guessing', () => {
      expect(parseServerArgv(['--nope', 'x'])).toEqual({})
    })

    it('lets the environment win over the command line', () => {
      const config = loadConfig(completeEnv(), { port: '9000', dataDir: '/srv/other' })
      expect(config.port).toBe(8787)
      expect(config.dataDir).toBe(dataDir)
    })

    it('rejects a flag given without a value', () => {
      expect(() => parseServerArgv(['--port'])).toThrow(/requires a value/u)
    })
  })

  function completeEnvWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
    return { ...completeEnv(), ...overrides }
  }
})
