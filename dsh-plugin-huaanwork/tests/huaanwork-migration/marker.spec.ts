import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MIGRATION_MARKER_FILENAME,
  MIGRATION_MARKER_VERSION,
  readMigrationMarker,
  writeMigrationMarker,
} from '../../src/huaanwork-migration/marker.ts'

function profile(): string {
  return mkdtempSync(join(tmpdir(), 'marker-profile-'))
}

const MARKER = {
  version: MIGRATION_MARKER_VERSION,
  migratedAt: '2026-09-27T00:00:00.000Z',
  source: { configDir: '/old/cfg', dshHome: '/old/cfg/dsh' },
  counts: { settings: 1 },
  skipped: ['cordis.yml'],
  notMigrated: ['profiles/huaanwork'],
}

describe('migration marker', () => {
  it('reads null before the first migration', async () => {
    await expect(readMigrationMarker(profile())).resolves.toBeNull()
  })

  it('round-trips the marker', async () => {
    const dir = profile()
    await writeMigrationMarker(dir, MARKER)
    await expect(readMigrationMarker(dir)).resolves.toEqual(MARKER)
  })

  it('writes the marker private and atomic', async () => {
    const dir = profile()
    await writeMigrationMarker(dir, MARKER)
    const path = join(dir, MIGRATION_MARKER_FILENAME)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    expect(() => statSync(`${path}.tmp`)).toThrow()
  })

  it('treats a corrupt marker as absent so the migration can be re-run', async () => {
    const dir = profile()
    await writeMigrationMarker(dir, MARKER)
    const path = join(dir, MIGRATION_MARKER_FILENAME)
    writeFileSync(path, 'not json', 'utf8')
    await expect(readMigrationMarker(dir)).resolves.toBeNull()
  })

  it('treats a marker from a future version as absent', async () => {
    const dir = profile()
    await writeMigrationMarker(dir, { ...MARKER, version: MIGRATION_MARKER_VERSION + 1 })
    await expect(readMigrationMarker(dir)).resolves.toBeNull()
  })
})
