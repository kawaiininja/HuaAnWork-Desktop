import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHuaanworkLegacyMigration, type HuaanworkMigrationStep } from '../../src/huaanwork-migration/index.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'mig-userdata-'))
  const dshHome = join(userData, 'dsh')
  mkdirSync(dshHome, { recursive: true })
  const homeDir = mkdtempSync(join(tmpdir(), 'mig-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  return {
    source: resolveLegacySource(userData),
    target: { homeDir, profileDir },
    userData, dshHome, profileDir,
  }
}

const countingStep = (calls: string[]): HuaanworkMigrationStep => ({
  name: 'counting',
  async run(_s, _t, report) {
    calls.push('counting')
    report.counts.counting = (report.counts.counting ?? 0) + 1
  },
})

describe('migration orchestration', () => {
  it('runs every step once and writes the marker', async () => {
    const calls: string[] = []
    const f = fixture()
    const report = await runHuaanworkLegacyMigration({ source: f.source, target: f.target, steps: [countingStep(calls)] })
    expect(calls).toEqual(['counting'])
    expect(report.performed).toBe(true)
    expect(report.counts.counting).toBe(1)
    expect(JSON.parse(readFileSync(join(f.profileDir, 'huaanwork-migration.json'), 'utf8')).counts.counting).toBe(1)
  })

  it('is a no-op on the second run', async () => {
    const calls: string[] = []
    const f = fixture()
    const steps = [countingStep(calls)]
    await runHuaanworkLegacyMigration({ source: f.source, target: f.target, steps })
    const second = await runHuaanworkLegacyMigration({ source: f.source, target: f.target, steps })
    expect(calls).toEqual(['counting'])
    expect(second.performed).toBe(false)
    expect(second.marker?.counts.counting).toBe(1)
  })

  it('rethrows a step failure, writes no marker, and leaves the legacy tree untouched', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'projects.json'), '{"projects":[]}', 'utf8')
    const failing: HuaanworkMigrationStep = {
      name: 'failing',
      async run() { throw new Error('disk on fire') },
    }
    await expect(runHuaanworkLegacyMigration({
      source: f.source, target: f.target, steps: [countingStep([]), failing],
    })).rejects.toThrow('disk on fire')
    expect(existsSync(join(f.profileDir, 'huaanwork-migration.json'))).toBe(false)
    expect(readFileSync(join(f.dshHome, 'projects.json'), 'utf8')).toBe('{"projects":[]}')
  })

  it('records the explicitly not-migrated set even on a successful run', async () => {
    const f = fixture()
    const report = await runHuaanworkLegacyMigration({ source: f.source, target: f.target, steps: [] })
    expect(report.notMigrated).toEqual(expect.arrayContaining([
      'cordis.yml', 'cordis.patch.yml', 'logs/plugin.log', 'logs/sidecar.log',
      'auth-session.json', 'profiles/huaanwork',
    ]))
  })

  it('is a no-op when no legacy source exists', async () => {
    const cleanUserData = mkdtempSync(join(tmpdir(), 'clean-userdata-'))
    const target = {
      homeDir: mkdtempSync(join(tmpdir(), 'clean-home-')),
      profileDir: mkdtempSync(join(tmpdir(), 'clean-profile-')),
    }
    const calls: string[] = []
    const report = await runHuaanworkLegacyMigration({
      source: resolveLegacySource(cleanUserData),
      target,
      steps: [countingStep(calls)],
    })
    expect(calls).toEqual([])
    expect(report.performed).toBe(false)
    expect(report.marker).toBeNull()
    expect(existsSync(join(target.profileDir, 'huaanwork-migration.json'))).toBe(false)
  })
})
