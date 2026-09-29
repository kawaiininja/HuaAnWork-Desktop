import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacySourceExists, readLegacyJson, resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'

describe('legacy source resolution', () => {
  it('derives the old $DSH_HOME from the Electron userData dir (F1: the two overlap)', () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-'))
    expect(resolveLegacySource(userData)).toEqual({
      configDir: userData,
      dshHome: join(userData, 'dsh'),
    })
  })

  it('reports absent when neither the old config files nor the old dsh home exist', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-clean-'))
    await expect(legacySourceExists(resolveLegacySource(userData))).resolves.toBe(false)
  })

  it('reports present on the old dsh home alone', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-dsh-'))
    mkdirSync(join(userData, 'dsh'), { recursive: true })
    await expect(legacySourceExists(resolveLegacySource(userData))).resolves.toBe(true)
  })

  it('reports present on a bare old settings.json with no dsh home', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-settings-'))
    writeFileSync(join(userData, 'settings.json'), '{}', 'utf8')
    await expect(legacySourceExists(resolveLegacySource(userData))).resolves.toBe(true)
  })

  it('does not mistake the new app\'s own userData files for legacy data', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-new-only-'))
    writeFileSync(join(userData, 'Preferences'), '{}', 'utf8')
    writeFileSync(join(userData, 'main-window-state.json'), '{}', 'utf8')
    mkdirSync(join(userData, 'profile-selection'), { recursive: true })
    mkdirSync(join(userData, 'desktop-market'), { recursive: true })
    await expect(legacySourceExists(resolveLegacySource(userData))).resolves.toBe(false)
  })
})

describe('readLegacyJson', () => {
  it('returns parsed json object when file exists and is valid', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-json-'))
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ a: 1 }), 'utf8')
    const source = resolveLegacySource(userData)
    await expect(readLegacyJson(source, 'settings.json')).resolves.toEqual({ a: 1 })
  })

  it('returns null when file does not exist', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-missing-'))
    const source = resolveLegacySource(userData)
    await expect(readLegacyJson(source, 'nonexistent.json')).resolves.toBeNull()
  })

  it('returns null when file contains malformed json', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'userdata-bad-json-'))
    writeFileSync(join(userData, 'bad.json'), 'not-json', 'utf8')
    const source = resolveLegacySource(userData)
    await expect(readLegacyJson(source, 'bad.json')).resolves.toBeNull()
  })
})
