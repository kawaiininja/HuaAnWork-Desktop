import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLegacyAccount, migrateAuthStep } from '../../src/huaanwork-migration/auth.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'

describe('isLegacyAccount', () => {
  const valid = { username: 'u', salt: 's', hash: 'h', kdf: 'scrypt', N: 16384, r: 8, p: 1 }

  it('accepts the legacy scrypt record verbatim', () => {
    expect(isLegacyAccount(valid)).toBe(true)
  })

  it.each([
    ['a different kdf', { ...valid, kdf: 'argon2' }],
    ['a different N', { ...valid, N: 32768 }],
    ['a different r', { ...valid, r: 16 }],
    ['a different p', { ...valid, p: 2 }],
    ['a missing hash', { username: 'u', salt: 's', kdf: 'scrypt', N: 16384, r: 8, p: 1 }],
    ['a non-record', 'nope'],
  ])('rejects %s', (_label, value) => {
    expect(isLegacyAccount(value)).toBe(false)
  })
})

describe('migrateAuthStep', () => {
  function fixture(options: {
    readonly account?: unknown
    readonly session?: unknown
    readonly destAccount?: unknown
  } = {}) {
    const userData = mkdtempSync(join(tmpdir(), 'mig-auth-src-'))
    if (options.account !== undefined) {
      writeFileSync(join(userData, 'account.json'), typeof options.account === 'string' ? options.account : JSON.stringify(options.account), 'utf8')
    }
    if (options.session !== undefined) {
      writeFileSync(join(userData, 'auth-session.json'), typeof options.session === 'string' ? options.session : JSON.stringify(options.session), 'utf8')
    }
    const homeDir = mkdtempSync(join(tmpdir(), 'mig-auth-home-'))
    const profileDir = join(homeDir, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    if (options.destAccount !== undefined) {
      writeFileSync(join(profileDir, 'account.json'), JSON.stringify(options.destAccount), 'utf8')
    }
    return { source: resolveLegacySource(userData), target: { homeDir, profileDir }, profileDir, userData }
  }

  const validAccount = { username: 'alice', salt: 's123', hash: 'h456', kdf: 'scrypt', N: 16384, r: 8, p: 1 }

  it('copies account.json into the profile directory', async () => {
    const f = fixture({ account: validAccount })
    const report = createMigrationReport()
    await migrateAuthStep.run(f.source, f.target, report)
    const written = JSON.parse(readFileSync(join(f.profileDir, 'account.json'), 'utf8'))
    expect(written).toEqual(validAccount)
    expect(report.counts.account).toBe(1)
  })

  it('refuses a record whose KDF parameters do not match, and says so', async () => {
    const f = fixture({ account: { ...validAccount, N: 32768 } })
    const report = createMigrationReport()
    await migrateAuthStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'account.json'))).toBe(false)
    expect(report.counts.account).toBeUndefined()
    expect(report.counts.accountRejected).toBe(1)
    expect(report.skipped).toContain('account.json: unrecognized credential record')
  })

  it('never writes auth-session.json', async () => {
    const f = fixture({ account: validAccount, session: { username: 'alice', token: 'tok' } })
    const report = createMigrationReport()
    await migrateAuthStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'account.json'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'auth-session.json'))).toBe(false)
    expect(report.skipped).toContain('auth-session.json: intentionally expired')
  })

  it('never overwrites an existing account', async () => {
    const existing = { ...validAccount, username: 'bob' }
    const f = fixture({ account: validAccount, destAccount: existing })
    const report = createMigrationReport()
    await migrateAuthStep.run(f.source, f.target, report)
    const written = JSON.parse(readFileSync(join(f.profileDir, 'account.json'), 'utf8'))
    expect(written.username).toBe('bob')
    expect(report.counts.account).toBeUndefined()
    expect(report.skipped).toContain('account.json: destination already exists')
  })

  it('is a silent no-op when legacy account is missing', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateAuthStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'account.json'))).toBe(false)
    expect(report.counts.account).toBeUndefined()
  })

  it('records skip when legacy account is unparseable', async () => {
    const f = fixture({ account: 'invalid-json{' })
    const report = createMigrationReport()
    await migrateAuthStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'account.json'))).toBe(false)
    expect(report.skipped).toContain('account.json: unparseable, left in place')
  })
})
