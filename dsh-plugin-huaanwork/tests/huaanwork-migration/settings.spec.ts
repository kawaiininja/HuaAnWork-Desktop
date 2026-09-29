import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { convertLegacySettings, migrateSettingsStep } from '../../src/huaanwork-migration/settings.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'

describe('convertLegacySettings', () => {
  it('carries all thirteen documented keys through unchanged', () => {
    const raw = {
      base_url: 'http://127.0.0.1:11434/v1', model: 'llama3', api_key: 'k',
      theme: 'dark', models: [{ id: 'm1', name: 'n', base_url: 'b', model: 'm', api_key: 'a' }],
      active_model_id: 'm1', allow_network: true, guard_mode: 'smart',
      automation_timeout_ms: 600000, keep_awake: false,
      agents_host: '192.168.1.5', agents_port: 8787, agents_catalog_token: 'tok',
    }
    expect(convertLegacySettings(raw)).toEqual(raw)
  })

  it('applies the one-shot work_allow_network fallback and writes only the new key', () => {
    const converted = convertLegacySettings({ work_allow_network: true })
    expect(converted.allow_network).toBe(true)
    expect(converted).not.toHaveProperty('work_allow_network')
  })

  it('prefers an explicit allow_network over the legacy key', () => {
    expect(convertLegacySettings({ allow_network: false, work_allow_network: true }).allow_network).toBe(false)
  })

  it('treats a non-boolean legacy key as false', () => {
    expect(convertLegacySettings({ work_allow_network: 'yes' }).allow_network).toBe(false)
  })

  it('drops unknown keys rather than smuggling them into the new document', () => {
    expect(convertLegacySettings({ base_url: 'b', something_else: 1 })).not.toHaveProperty('something_else')
  })

  it('returns an empty document for a non-record input', () => {
    expect(convertLegacySettings(null)).toEqual({})
    expect(convertLegacySettings('nope')).toEqual({})
  })
})

describe('migrateSettingsStep', () => {
  function fixture(legacySettings: unknown) {
    const userData = mkdtempSync(join(tmpdir(), 'mig-settings-'))
    writeFileSync(join(userData, 'settings.json'), JSON.stringify(legacySettings), 'utf8')
    const homeDir = mkdtempSync(join(tmpdir(), 'mig-settings-home-'))
    const profileDir = join(homeDir, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    return { source: resolveLegacySource(userData), target: { homeDir, profileDir }, profileDir }
  }

  it('writes huaanwork-settings.json into the profile directory', async () => {
    const f = fixture({ allow_network: true, guard_mode: 'full' })
    const report = createMigrationReport()
    await migrateSettingsStep.run(f.source, f.target, report)
    const written = JSON.parse(readFileSync(join(f.profileDir, 'huaanwork-settings.json'), 'utf8'))
    expect(written).toMatchObject({ allow_network: true, guard_mode: 'full' })
    expect(report.counts.settings).toBe(1)
  })

  it('never overwrites settings the new app already wrote', async () => {
    const f = fixture({ base_url: 'http://legacy' })
    writeFileSync(join(f.profileDir, 'huaanwork-settings.json'), JSON.stringify({ base_url: 'http://current' }), 'utf8')
    const report = createMigrationReport()
    await migrateSettingsStep.run(f.source, f.target, report)
    expect(JSON.parse(readFileSync(join(f.profileDir, 'huaanwork-settings.json'), 'utf8')).base_url).toBe('http://current')
    expect(report.counts.settings).toBeUndefined()
    expect(report.skipped).toContain('settings.json: destination already exists')
  })

  it('is a silent no-op when the legacy file is absent', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'mig-settings-none-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'mig-settings-none-home-'))
    const profileDir = join(homeDir, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    const report = createMigrationReport()
    await migrateSettingsStep.run(resolveLegacySource(userData), { homeDir, profileDir }, report)
    expect(existsSync(join(profileDir, 'huaanwork-settings.json'))).toBe(false)
    expect(report.counts.settings).toBeUndefined()
  })

  it('reports an unparseable legacy file instead of writing garbage', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'mig-settings-bad-'))
    writeFileSync(join(userData, 'settings.json'), '{ not json', 'utf8')
    const homeDir = mkdtempSync(join(tmpdir(), 'mig-settings-bad-home-'))
    const profileDir = join(homeDir, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    const report = createMigrationReport()
    await migrateSettingsStep.run(resolveLegacySource(userData), { homeDir, profileDir }, report)
    expect(existsSync(join(profileDir, 'huaanwork-settings.json'))).toBe(false)
    expect(report.skipped).toContain('settings.json: unparseable, left in place')
  })
})
