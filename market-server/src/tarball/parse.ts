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

import { gunzipSync } from 'node:zlib'

export class TarballError extends Error {
  readonly code: 'invalid-tarball' | 'missing-package-json' | 'invalid-package-json'

  constructor(code: TarballError['code'], message: string) {
    super(message)
    this.name = 'TarballError'
    this.code = code
  }
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
  /** All depth-1 package.json candidates; the shallowest name wins below. */
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
    if (type !== 'file') continue

    const name = (state.pendingName ?? headerName(block)).replace(/^\.\//u, '')
    state.pendingName = null
    // Pax metadata header entries (node-tar/npm convention: a PaxHeaders
    // path segment) masquerade as files; never treat them as the manifest.
    const isPaxMetadata = name.split('/').some(segment => segment.startsWith('PaxHeaders'))
    if (!isPaxMetadata && /^[^/]+\/package\.json$/u.test(name)) {
      state.packageJsonCandidates.push({ name, data: Buffer.from(data) })
    }
  }
}

/**
 * Gunzip + walk a .tgz and return its parsed `<dir>/package.json` manifest.
 * Throws TarballError (fail-closed) on anything malformed.
 */
export function extractPackageManifest(tgzBytes: Buffer): Record<string, unknown> {
  let tar: Buffer
  try {
    tar = gunzipSync(tgzBytes)
  } catch (cause) {
    throw new TarballError('invalid-tarball', `not a gzip-compressed tarball: ${(cause as Error).message}`)
  }
  const state: TarWalkState = { pendingName: null, packageJsonCandidates: [] }
  walkEntries(tar, state)
  // The shallowest depth-1 package.json is the package manifest; longer
  // candidates are tooling headers (e.g. PaxHeaders/... entries).
  const winner = state.packageJsonCandidates.reduce<(typeof state.packageJsonCandidates)[number] | null>(
    (best, candidate) => (best === null || candidate.name.length < best.name.length ? candidate : best),
    null,
  )
  if (winner === null) {
    throw new TarballError('missing-package-json', 'tarball has no <dir>/package.json entry')
  }
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
