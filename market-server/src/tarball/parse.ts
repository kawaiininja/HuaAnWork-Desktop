/**
 * Minimal .tgz reader for the publish gate (Task 2).
 *
 * The dependency-closure ruling (round4 (c)) forbids the market-server runtime
 * from depending on ANY npm package, so there is no `tar` dependency: this is
 * a hand-rolled ustar header walk (~100 lines) over `node:zlib` gunzipped
 * bytes. It reads ONLY what the publish gate needs: the tarball's
 * `package/package.json` (or `<dir>/package.json` at depth 1).
 *
 * Supported tar dialects: POSIX ustar (incl. the `prefix` continuation
 * field), PAX extended headers (`typeflag 'x'`, applying its `path=` record
 * to the next entry), and GNU longname (`typeflag 'L'`). Directory entries,
 * hard links, and other file types are skipped.
 */

import { createReadStream } from 'node:fs'
import { createGunzip, gunzipSync } from 'node:zlib'

export class TarballError extends Error {
  readonly code: 'invalid-tarball' | 'missing-package-json' | 'invalid-package-json' | 'decompressed-tarball-too-large'

  constructor(code: TarballError['code'], message: string) {
    super(message)
    this.name = 'TarballError'
    this.code = code
  }
}

/**
 * Decompressed-tar ceiling for the publish gate (review D6): the gate reads
 * only the manifest, and a zero-dependency plugin artifact is package.json
 * plus a small payload, so 64 MiB decompressed is generous next to the
 * 100 MiB COMPRESSED upload cap (MAX_ARTIFACT_BYTES). Without a cap a ~61 KB
 * gzip bomb measured to expand ~1028× (→ ~60 MiB) and a larger one OOMs the
 * single event-loop process. Both the buffered and the streaming paths
 * enforce exactly this ceiling.
 *
 * KEEP IN SYNC with the install side's ceiling of the same value
 * (`dsh-plugin-huaanwork/src/huaanwork-host/market/install.ts`,
 * MAX_TAR_DECOMPRESSED_BYTES — spec §14 第 53 条): an install-side ceiling
 * that is stricter makes legitimately published artifacts uninstallable, a
 * looser one loses the gzip-bomb protection. The dependency-direction guard
 * forbids any cross-package import, so equality is held by this comment plus
 * a unit test on each side (here: `tarball-parse.spec.ts`, over-cap bombs on
 * both the buffered and the streaming file path).
 */
export const MAX_TAR_DECOMPRESSED_BYTES = 64 * 1024 * 1024

/** Map a node:zlib failure onto a fail-closed, honest TarballError. */
function mapGunzipError(cause: unknown): TarballError {
  if ((cause as NodeJS.ErrnoException | null)?.code === 'ERR_BUFFER_TOO_LARGE') {
    return new TarballError(
      'decompressed-tarball-too-large',
      `decompressed tarball exceeds the ${String(MAX_TAR_DECOMPRESSED_BYTES)}-byte limit (possible gzip bomb); artifact rejected`,
    )
  }
  return new TarballError('invalid-tarball', `not a gzip-compressed tarball: ${(cause as Error).message}`)
}

const TAR_BLOCK_SIZE = 512
const HEADER_NAME_END = 100
const HEADER_SIZE_START = 124
const HEADER_SIZE_END = 136
const HEADER_TYPEFLAG = 156
const HEADER_MAGIC_START = 257
const HEADER_PREFIX_START = 345
const HEADER_PREFIX_END = 500

type TarTypeFlag = 'file' | 'directory' | 'pax' | 'longname' | 'other'

function typeFlagOf(byte: number | undefined): TarTypeFlag {
  switch (byte) {
    case 0x00: // old-style regular file
    case 0x30: // '0'
      return 'file'
    case 0x35: // '5'
      return 'directory'
    case 0x78: // 'x'
      return 'pax'
    case 0x4c: // 'L'
      return 'longname'
    default:
      return 'other'
  }
}

function parseOctal(field: Buffer): number | null {
  const text = field.toString('latin1').replace(/[\0 ]+$/u, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) return null
  return Number.parseInt(text, 8)
}

function headerName(block: Buffer): string {
  const rawName = block.subarray(0, HEADER_NAME_END).toString('latin1').replace(/\0.*$/u, '')
  const magic = block.toString('latin1', HEADER_MAGIC_START, HEADER_MAGIC_START + 5)
  if (magic === 'ustar') {
    const prefix = block.subarray(HEADER_PREFIX_START, HEADER_PREFIX_END).toString('latin1').replace(/\0.*$/u, '')
    if (prefix !== '') return `${prefix}/${rawName}`
  }
  return rawName
}

/** Parse a PAX extended-header data block for its `path=` record value. */
function paxPathOverride(data: Buffer): string | null {
  const text = data.toString('utf8')
  for (const record of text.split('\n')) {
    const space = record.indexOf(' ')
    if (space === -1) continue
    const keyValue = record.slice(space + 1)
    const equals = keyValue.indexOf('=')
    if (equals === -1) continue
    if (keyValue.slice(0, equals) === 'path') return keyValue.slice(equals + 1)
  }
  return null
}

/** Parse a GNU longname data block: NUL-terminated UTF-8 name. */
function gnuLongNameOverride(data: Buffer): string {
  const nul = data.indexOf(0)
  return data.subarray(0, nul === -1 ? data.length : nul).toString('utf8')
}

interface TarWalkState {
  pendingName: string | null
  /** All depth-1 package.json candidates; exactly one is required (see below). */
  packageJsonCandidates: { readonly name: string; readonly data: Buffer }[]
}

function walkEntries(tar: Buffer, state: TarWalkState): void {
  let offset = 0
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const block = tar.subarray(offset, offset + TAR_BLOCK_SIZE)
    offset += TAR_BLOCK_SIZE
    if (block.every(byte => byte === 0)) return // zero block: end of archive
    const size = parseOctal(block.subarray(HEADER_SIZE_START, HEADER_SIZE_END))
    if (size === null || size < 0) {
      throw new TarballError('invalid-tarball', 'tar header has an unparseable size field')
    }
    if (offset + size > tar.length) {
      throw new TarballError('invalid-tarball', 'tar entry extends past the end of the archive')
    }
    const data = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE

    const type = typeFlagOf(block[HEADER_TYPEFLAG])
    if (type === 'pax') {
      const override = paxPathOverride(data)
      if (override !== null) state.pendingName = override
      continue
    }
    if (type === 'longname') {
      state.pendingName = gnuLongNameOverride(data)
      continue
    }

    // Every non-pax, non-longname entry consumes the pending override — including
    // symlinks/hardlinks/fifos, which typeFlagOf maps to 'other' (review P4). The
    // previous `if (type !== 'file' && type !== 'directory') continue` skipped them
    // BEFORE the override was consumed, so a pax/longname aimed at a link entry
    // leaked onto the NEXT entry: a legitimate tarball could be rejected as
    // missing its manifest, or a non-manifest file could newly match the depth-1
    // regex. It also diverged from the wrapper install side, which clears on every
    // non-longname entry.
    const name = (state.pendingName ?? headerName(block)).replace(/^\.\//u, '')
    state.pendingName = null
    // Fail closed on path traversal (review D1): a ".." segment must never
    // appear in any entry name — it would otherwise match the depth-1
    // manifest regex below (".." is a valid [^/]+ segment). Checked for every
    // entry kind, not just files, matching the wrapper's stricter scope.
    if (name.split('/').includes('..')) {
      throw new TarballError('invalid-tarball', `tar entry name contains a ".." segment: ${JSON.stringify(name)}`)
    }
    if (type !== 'file') continue
    // Pax metadata header entries (node-tar/npm convention: a PaxHeaders
    // path segment) masquerade as files; never treat them as the manifest.
    const isPaxMetadata = name.split('/').some(segment => segment.startsWith('PaxHeaders'))
    if (!isPaxMetadata && /^[^/]+\/package\.json$/u.test(name)) {
      state.packageJsonCandidates.push({ name, data: Buffer.from(data) })
    }
  }
}

/**
 * Shared selection tail: walk the decompressed tar, require exactly one
 * depth-1 <dir>/package.json, and parse it. Used by BOTH the buffered entry
 * point and the streaming file entry point, so every walk rule (`..` segments,
 * PaxHeaders exclusion, ambiguity rejection) is identical on both paths.
 */
function extractManifestFromTar(tar: Buffer): Record<string, unknown> {
  const state: TarWalkState = { pendingName: null, packageJsonCandidates: [] }
  walkEntries(tar, state)
  // Manifest selection rule (review D1): exactly ONE depth-1 <dir>/package.json
  // is acceptable. npm-packed artifacts always carry exactly one
  // package/package.json; more than one candidate is an ambiguous tarball and
  // must be rejected, not tie-broken — otherwise a clean decoy manifest can
  // smuggle a dirty one past the gate.
  //
  // The wrapper install side applies the SAME rule (leading "./" normalization,
  // ".." rejection, PaxHeaders exclusion, this depth-1 regex, no tie-break), and
  // the agreement is machine-checked rather than comment-asserted: both packages
  // run tests/fixtures/publish-gate-vectors.json (fix-round N-2 — the "./"
  // normalization was missing on the wrapper side, so `tar -czf x.tgz .` output
  // published 201 here and then failed every user's install). Known intentional
  // differences are listed in the wrapper's readTarballPackageJson docstring.
  if (state.packageJsonCandidates.length === 0) {
    throw new TarballError('missing-package-json', 'tarball has no <dir>/package.json entry')
  }
  if (state.packageJsonCandidates.length > 1) {
    const names = state.packageJsonCandidates.map(candidate => candidate.name).sort()
    throw new TarballError(
      'invalid-tarball',
      `tarball is ambiguous: ${String(state.packageJsonCandidates.length)} depth-1 package.json entries (${names.join(', ')}); expected exactly one`,
    )
  }
  const winner = state.packageJsonCandidates[0]!
  let parsed: unknown
  try {
    parsed = JSON.parse(winner.data.toString('utf8'))
  } catch (cause) {
    throw new TarballError('invalid-package-json', `package.json is not valid JSON: ${(cause as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TarballError('invalid-package-json', 'package.json must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Gunzip + walk a .tgz and return its parsed `<dir>/package.json` manifest.
 * Throws TarballError (fail-closed) on anything malformed.
 */
export function extractPackageManifest(tgzBytes: Buffer): Record<string, unknown> {
  let tar: Buffer
  try {
    tar = gunzipSync(tgzBytes, { maxOutputLength: MAX_TAR_DECOMPRESSED_BYTES })
  } catch (cause) {
    throw mapGunzipError(cause)
  }
  return extractManifestFromTar(tar)
}

/**
 * Streaming variant of extractPackageManifest over a staged artifact file
 * (review D6): createReadStream piped through createGunzip with
 * maxOutputLength = MAX_TAR_DECOMPRESSED_BYTES.
 *
 * Memory claim, stated precisely (fix-round N-5 — the previous wording
 * overclaimed): the staged artifact is read from disk in chunks, so the
 * COMPRESSED bytes (up to 100 MiB) are never held whole. The DECOMPRESSED tar
 * IS collected into a single Buffer before the walk — peak ≈ the decompressed
 * size (capped at 64 MiB), transiently ≈ 2× during the final Buffer.concat
 * (measured: a 60 MiB decompressed artifact peaks ~128 MiB of external memory).
 * Making the walk itself incremental would remove that too; not worth it at this
 * cap. The collected bytes feed the SAME extractManifestFromTar tail, so every
 * walk rule is shared with the buffered entry point.
 *
 * A staged-file read error is deliberately NOT mapped to TarballError: it is a
 * server-side fault, so it propagates to the route catch-all as a generic 500
 * rather than being reported to the operator as a 4xx they caused.
 */
export function extractPackageManifestFromFile(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const source = createReadStream(path)
    const gunzip = createGunzip({ maxOutputLength: MAX_TAR_DECOMPRESSED_BYTES })
    const settle = (error: Error | null, tar?: Buffer) => {
      if (settled) return
      settled = true
      if (error !== null) {
        rejectPromise(error)
        return
      }
      try {
        resolvePromise(extractManifestFromTar(tar!))
      } catch (cause) {
        rejectPromise(cause)
      }
    }
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_TAR_DECOMPRESSED_BYTES) {
        // Fail closed the moment the ceiling is crossed; no need to keep
        // draining a (potentially hostile) stream into memory.
        source.destroy()
        gunzip.destroy()
        settle(mapGunzipError(Object.assign(new Error('buffer too large'), { code: 'ERR_BUFFER_TOO_LARGE' })))
        return
      }
      chunks.push(chunk)
    })
    source.on('error', cause => settle(cause as Error))
    // With maxOutputLength set, zlib itself errors ERR_BUFFER_TOO_LARGE once
    // the decompressed total crosses the ceiling; either way the honest
    // fail-closed TarballError is the same.
    gunzip.on('error', cause => settle(mapGunzipError(cause)))
    gunzip.on('end', () => settle(null, Buffer.concat(chunks)))
    source.pipe(gunzip)
  })
}
