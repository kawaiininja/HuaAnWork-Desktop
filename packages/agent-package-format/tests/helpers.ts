import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AgentPackageManifest } from '../src/index.ts'

/**
 * A complete, valid M1 manifest. The digest tests use it for both the digest
 * binding (manifest slug/version) and directory enumeration, so the values are
 * exactly the ones the M1 validator accepts.
 */
export const VALID_MANIFEST: AgentPackageManifest = {
  schemaVersion: 1,
  slug: 'weekly-report',
  displayName: '周报小助手',
  description: '把一周工作整理成周报',
  version: '1.0.0',
  draftId: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  persona: 'persona.md',
  skill: null,
  tools: { mode: 'none' },
  allowSkills: [],
}

export const VALID_PERSONA = '你是周报助手'

/** Create an empty temp directory; callers remove it via `t.after`. */
export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-package-format-'))
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Write a map of relative POSIX paths under `dir`, creating parents. */
export function writePackageFiles(dir: string, entries: Record<string, string | Buffer>): void {
  for (const [relativePath, content] of Object.entries(entries)) {
    const target = join(dir, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

/** A temp package directory containing a valid `agent.json` + `persona.md`. */
export function createValidPackageDir(): string {
  const dir = createTempDir()
  writePackageFiles(dir, {
    'agent.json': JSON.stringify(VALID_MANIFEST),
    'persona.md': VALID_PERSONA,
  })
  return dir
}
