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
      if (key === ENV_KEYS.adminToken) continue // admin token is optional (Task 2: unset = admin surface disabled)
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
