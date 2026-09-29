/** Resolution of the legacy Tauri data layout into the Desktop profile layout. */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Old Tauri config dir and the $DSH_HOME nested inside it. */
export interface HuaanworkLegacySource {
  readonly configDir: string
  readonly dshHome: string
}

/** New DSH_HOME and the active profile directory. */
export interface HuaanworkMigrationTarget {
  readonly homeDir: string
  readonly profileDir: string
}

/**
 * Files that only the legacy Tauri app wrote into its config dir.
 *
 * The new Electron app shares this directory (both products are named
 * "HuaAnWork", so app.getPath('userData') resolves to the same place) and writes
 * Cookies / Preferences / main-window-state.json / profile-selection /
 * desktop-market there. Presence detection must therefore key on legacy-only
 * names, never on "the directory is non-empty".
 */
const LEGACY_CONFIG_FILES = ['settings.json', 'account.json', 'auth-session.json'] as const

const LEGACY_DSH_HOME = 'dsh'

/** Derive the legacy source locations from the Electron userData directory. */
export function resolveLegacySource(userDataDir: string): HuaanworkLegacySource {
  return { configDir: userDataDir, dshHome: join(userDataDir, LEGACY_DSH_HOME) }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** True when at least one legacy-only artifact is present. */
export async function legacySourceExists(source: HuaanworkLegacySource): Promise<boolean> {
  if (await exists(source.dshHome)) return true
  for (const name of LEGACY_CONFIG_FILES) {
    if (await exists(join(source.configDir, name))) return true
  }
  return false
}

/** Read a legacy JSON document, returning null when absent or unparseable. */
export async function readLegacyJson(source: HuaanworkLegacySource, relative: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(join(source.configDir, relative), 'utf8')) as unknown
  } catch {
    return null
  }
}
