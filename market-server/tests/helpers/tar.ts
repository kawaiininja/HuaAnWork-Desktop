/**
 * Test helpers: build minimal ustar tarballs in-memory (gzipSync) so the
 * publish-gate and hosting tests stay hermetic — no system `tar` binary and
 * no tar npm package (the same zero-dependency constraint the src honors).
 */

import { gzipSync } from 'node:zlib'

const TAR_BLOCK_SIZE = 512

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function tarHeader(name: string, size: number, typeflag: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE)
  header.write(name, 0, 'latin1')
  header.write(octal(0o644, 8), 100, 'latin1') // mode
  header.write(octal(0, 8), 108, 'latin1') // uid
  header.write(octal(0, 8), 116, 'latin1') // gid
  header.write(octal(size, 12), 124, 'latin1') // size
  header.write(octal(0, 12), 136, 'latin1') // mtime
  header.write('        ', 148, 'latin1') // chksum spaces
  header.writeUInt8(typeflag, 156)
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  header.write('node', 265, 'latin1') // uname
  header.write('node', 297, 'latin1') // gname
  // POSIX checksum: sum of all header bytes with chksum field as spaces.
  let sum = 0
  for (const byte of header) sum += byte
  header.write(octal(sum, 8), 148, 'latin1')
  return header
}

export interface TarEntrySpec {
  readonly name: string
  readonly data: Buffer | string
  /** tar typeflag byte as a one-char string; default regular file ('0'). */
  readonly typeflag?: string
}

/** Build a ustar archive from file entries (directories implicit). */
export function buildTar(entries: readonly TarEntrySpec[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    parts.push(tarHeader(entry.name, data.length, entry.typeflag === undefined ? 0x30 : entry.typeflag.charCodeAt(0)))
    parts.push(data)
    const remainder = data.length % TAR_BLOCK_SIZE
    if (remainder !== 0) parts.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder))
  }
  parts.push(Buffer.alloc(TAR_BLOCK_SIZE)) // zero block terminates the archive
  return Buffer.concat(parts)
}

/** Build a gzipped npm-style tarball: package/package.json + optional extra files. */
export function buildTgz(packageManifest: Record<string, unknown>, extraFiles: readonly TarEntrySpec[] = []): Buffer {
  const entries: TarEntrySpec[] = [
    { name: 'package/package.json', data: JSON.stringify(packageManifest) },
    ...extraFiles.map(file => ({ name: `package/${file.name}`, data: file.data })),
  ]
  return gzipSync(buildTar(entries))
}

/** A publish-gate-clean package manifest. */
export function cleanPackageManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: '@huaanwork/sample-plugin', version: '1.2.3', ...overrides }
}
