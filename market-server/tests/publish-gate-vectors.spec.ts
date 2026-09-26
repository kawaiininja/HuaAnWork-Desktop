/**
 * Shared publish-gate vectors (review D1/D4): the SAME fixture drives the
 * server-side gate (tarball/parse.ts + tarball/gate.ts) and the wrapper
 * install-side gate (dsh-plugin-huaanwork market-gate-vectors.spec.ts), so
 * any divergence between the two gates' verdicts turns red on one side.
 * Precedent: signing-vectors.json is shared the same way (round3 R10).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { checkPublishGate } from '../src/tarball/gate.ts'
import { extractPackageManifest } from '../src/tarball/parse.ts'
import { buildTar, type TarEntrySpec } from './helpers/tar.ts'

interface GateVectorEntry {
  readonly path: string
  readonly manifest?: Record<string, unknown>
  readonly raw?: string
}

interface GateVector {
  readonly name: string
  readonly reason: string
  readonly tarball: { readonly entries: readonly GateVectorEntry[] }
  readonly expected: {
    readonly accept: boolean
    readonly code?: string
    readonly wrapperCode?: string
    readonly messageIncludes?: string
  }
}

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'publish-gate-vectors.json'), 'utf8'),
) as readonly GateVector[]

function buildVectorTgz(vector: GateVector): Buffer {
  const entries: TarEntrySpec[] = vector.tarball.entries.map(entry => ({
    name: entry.path,
    data: entry.manifest !== undefined ? JSON.stringify(entry.manifest) : (entry.raw ?? ''),
  }))
  return gzipSync(buildTar(entries))
}

describe('publish-gate-vectors.json (server-side gate, shared with the wrapper)', () => {
  for (const vector of vectors) {
    it(`${vector.name}: ${vector.reason}`, () => {
      const bytes = buildVectorTgz(vector)
      // Tarball-structure rejections surface from extractPackageManifest.
      if (vector.expected.code === 'invalid-tarball') {
        let caught: unknown
        try {
          extractPackageManifest(bytes)
        } catch (cause) {
          caught = cause
        }
        expect(caught).toBeInstanceOf(Error)
        expect((caught as { code?: string }).code).toBe('invalid-tarball')
        expect((caught as Error).message).toContain(vector.expected.messageIncludes ?? '')
        return
      }
      const manifest = extractPackageManifest(bytes)
      const result = checkPublishGate(manifest)
      if (vector.expected.accept) {
        expect(result.ok).toBe(true)
        return
      }
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.rejection.code).toBe(vector.expected.code)
        expect(result.rejection.message).toContain(vector.expected.messageIncludes ?? '')
      }
    })
  }
})
