/**
 * The legacy M-A0 catalog: `entriesDir/*.json`, read on every request.
 *
 * Behaviour is preserved EXACTLY from the external service:
 *   - one file per entry, only `*.json` files are considered;
 *   - a directory that does not exist serves an empty list;
 *   - a file that fails to parse is skipped with a console warning — one bad
 *     entry must never take the whole catalog (or the process) down;
 *   - the parsed document is served verbatim (no field renaming/normalizing).
 *
 * There is no snapshot and no cache: editing an entry file is live on the
 * next request, exactly like the M-A0 service. Publishing discipline therefore
 * lives in review, not in the read path.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LegacyCatalogEntry } from './types.ts'

/** Central redaction hook for parser diagnostics (tokens, PEM blocks). */
export type LegacyRedactor = (text: string) => string

const identityRedactor: LegacyRedactor = text => text

/** Load every entry of `dir`; malformed files are skipped with a warning. */
export function loadEntries(
  dir: string,
  redact: LegacyRedactor = identityRedactor,
): LegacyCatalogEntry[] {
  if (!existsSync(dir)) return []
  const items: LegacyCatalogEntry[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const path = join(dir, file)
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      // The M-A0 service pushed any parsed JSON value; keep that permissive
      // shape (clients validate entries) but record it as an object-typed
      // entry only when it actually is one. Non-object documents are skipped
      // the same way a broken file is: they can never be a valid entry.
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        items.push(parsed as LegacyCatalogEntry)
      } else {
        console.error(redact(`条目文件解析失败,已跳过: ${path} (expected a JSON object)`))
      }
    } catch (error) {
      console.error(redact(`条目文件解析失败,已跳过: ${path} (${(error as Error).message})`))
    }
  }
  return items
}

/**
 * Every entry whose `name` matches. Submission conflict checks need ALL of
 * them: two files can legally hold the same name, and the migration exception
 * must never be unlocked by whichever file happened to be read first.
 */
export function findEntries(
  dir: string,
  name: string,
  redact: LegacyRedactor = identityRedactor,
): LegacyCatalogEntry[] {
  return loadEntries(dir, redact).filter(item => item.name === name)
}

/**
 * Find one entry by its `name` field; undefined when absent. First match wins,
 * exactly like M-A0 (the legacy read route keeps that behaviour).
 */
export function findEntry(
  dir: string,
  name: string,
  redact: LegacyRedactor = identityRedactor,
): LegacyCatalogEntry | undefined {
  return loadEntries(dir, redact).find(item => item.name === name)
}
