import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * P36 (M6 Task 6.8) — workspace dependency pinning.
 *
 * `dsh-community-market` is a fork-owned `private: true` workspace package,
 * and market-server's write path runs its contract validators
 * (`dsh-community-market/contracts` in `src/catalog/entry-contract.ts`). A
 * plain semver range would silently resolve to a registry copy once the
 * workspace version drifts, changing the write-side validation semantics;
 * `workspace:^` pins the resolution to this checkout.
 *
 * The second assertion keeps `dependencies` honest: every declared runtime
 * dependency must actually be imported by `src/` or `scripts/`. It walks and
 * string-matches the sources instead of shelling out to grep because the CI
 * matrix includes Windows runners, where grep is not on PATH.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_DIRS = ['src', 'scripts']
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u

// Import forms used in this package: static `from 'x'` (also re-exports),
// dynamic `import('x')`, `require('x')`, and side-effect `import 'x'`.
const IMPORT_SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/gu,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
]

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Manifest
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listSourceFiles(path))
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) files.push(path)
  }
  return files
}

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null
  }
  const [first, second] = specifier.split('/')
  if (first === undefined) return null
  if (first.startsWith('@')) return second === undefined ? null : `${first}/${second}`
  return first
}

function importedPackageNames(): ReadonlySet<string> {
  const names = new Set<string>()
  for (const directory of SOURCE_DIRS) {
    for (const file of listSourceFiles(join(PACKAGE_ROOT, directory))) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of IMPORT_SPECIFIERS) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1]
          if (specifier === undefined) continue
          const name = packageNameOf(specifier)
          if (name !== null) names.add(name)
        }
      }
    }
  }
  return names
}

describe('workspace dependency pinning (P36)', () => {
  it('resolves dsh-community-market from the workspace, not the registry', () => {
    const manifest = readManifest()
    expect(manifest.dependencies?.['dsh-community-market']).toBe('workspace:^')
  })

  it('declares no dependency the sources do not import', () => {
    const imported = importedPackageNames()
    // Guard against a silently empty walk turning the loop below vacuous.
    expect(imported.size).toBeGreaterThan(0)
    for (const name of Object.keys(readManifest().dependencies ?? {})) {
      expect(
        imported.has(name),
        `${name} is declared in market-server/package.json but never imported by src/ or scripts/`,
      ).toBe(true)
    }
  })
})
