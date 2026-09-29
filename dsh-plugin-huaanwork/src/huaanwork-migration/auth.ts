/** Migration of the local account document into the profile layout. */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import type { HuaanworkMigrationStep } from './index.ts'
import type { HuaanworkLegacySource, HuaanworkMigrationTarget } from './paths.ts'

export const LEGACY_KDF = 'scrypt' as const
export const LEGACY_KDF_N = 16384
export const LEGACY_KDF_R = 8
export const LEGACY_KDF_P = 1

const ACCOUNT_FILENAME = 'account.json'
const SESSION_FILENAME = 'auth-session.json'
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The legacy scrypt credential record (sidecar auth.ts:25-33).
 *
 * All four KDF parameters must match exactly, mirroring the legacy isAccount
 * guard: a record produced with different parameters cannot be verified by the
 * ported auth route, and copying it would lock the user out with no diagnosis.
 */
export function isLegacyAccount(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.username === 'string'
    && typeof record.salt === 'string'
    && typeof record.hash === 'string'
    && record.kdf === LEGACY_KDF
    && record.N === LEGACY_KDF_N
    && record.r === LEGACY_KDF_R
    && record.p === LEGACY_KDF_P
}

export const migrateAuthStep: HuaanworkMigrationStep = {
  name: 'auth',
  async run(
    source: HuaanworkLegacySource,
    target: HuaanworkMigrationTarget,
    report: HuaanworkMigrationReport,
  ): Promise<void> {
    // spec §8: the legacy session is treated as expired, so it is not copied.
    // The legacy authStatus() logs a user in purely from this file's presence
    // (sidecar auth.ts:132-147); copying it would skip the required re-login.
    const legacySessionPath = join(source.configDir, SESSION_FILENAME)
    if (await exists(legacySessionPath)) {
      recordSkip(report, 'auth-session.json: intentionally expired')
    }

    const destination = join(target.profileDir, ACCOUNT_FILENAME)
    if (await exists(destination)) {
      recordSkip(report, 'account.json: destination already exists')
      return
    }

    // F2: the legacy account document lives in dirname($DSH_HOME), not inside it.
    const legacyAccountPath = join(source.configDir, ACCOUNT_FILENAME)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(legacyAccountPath, 'utf8')) as unknown
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') return
      recordSkip(report, 'account.json: unparseable, left in place')
      return
    }

    if (!isLegacyAccount(raw)) {
      bumpCount(report, 'accountRejected')
      recordSkip(report, 'account.json: unrecognized credential record')
      return
    }

    await writeFileAtomic(destination, `${JSON.stringify(raw, null, 2)}\n`, {
      mode: FILE_MODE,
      dirMode: DIRECTORY_MODE,
    })
    bumpCount(report, 'account')
  },
}
