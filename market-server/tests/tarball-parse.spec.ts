import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TarballError, extractPackageManifest, extractPackageManifestFromFile } from '../src/tarball/parse.ts'
import { buildTar, buildTgz, cleanPackageManifest } from './helpers/tar.ts'

describe('extractPackageManifest (zero-dependency ustar walk)', () => {
  it('extracts package/package.json from an npm-style tarball', () => {
    const tgz = buildTgz(cleanPackageManifest({ description: 'hello' }), [
      { name: 'index.js', data: 'module.exports = 1' },
    ])
    const manifest = extractPackageManifest(tgz)
    expect(manifest).toMatchObject({ name: '@huaanwork/sample-plugin', version: '1.2.3', description: 'hello' })
  })

  it('finds <dir>/package.json at depth 1 regardless of surrounding entries', () => {
    const tar = buildTar([
      { name: 'some-dir/README.md', data: 'readme' },
      { name: 'mydir/package.json', data: '{"name":"plain-pkg","version":"0.0.1"}' },
      { name: 'mydir/lib/index.js', data: '' },
    ])
    const manifest = extractPackageManifest(gzipSync(tar))
    expect(manifest).toEqual({ name: 'plain-pkg', version: '0.0.1' })
  })

  it('handles ustar prefix continuation for long names', () => {
    const longDir = 'a'.repeat(90)
    const tar = buildTar([{ name: `${longDir}/package.json`, data: '{"name":"long-pkg","version":"2.0.0"}' }])
    // Rewrite the header into prefix+name form to exercise the prefix field:
    // name field = "package.json", prefix field = the 90-char directory.
    const header = tar.subarray(0, 512)
    header.fill(0, 0, 100)
    header.write('package.json', 0, 'latin1')
    header.fill(0, 345, 500)
    header.write(longDir, 345, 'latin1')
    header.fill(0, 148, 156)
    header.write('        ', 148, 'latin1')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
    const manifest = extractPackageManifest(gzipSync(tar))
    expect(manifest).toEqual({ name: 'long-pkg', version: '2.0.0' })
  })

  it('handles a PAX extended header path override', () => {
    // PAX record: "<len> path=<name>\n" where <len> covers the whole record.
    const target = 'paxdir/package.json'
    const record = ` path=${target}\n`
    const paxData = Buffer.from(`${String(record.length + String(record.length).length)}${record}`, 'utf8')
    const tar = buildTar([
      { name: 'PaxHeaders/package.json', data: paxData, typeflag: 'x' },
      { name: 'package.json', data: '{"name":"pax-pkg","version":"3.0.0"}' },
    ])
    const manifest = extractPackageManifest(gzipSync(tar))
    expect(manifest).toEqual({ name: 'pax-pkg', version: '3.0.0' })
  })

  it('consumes a PAX path override on a directory entry without leaking it to the next entry (P4)', () => {
    // npm/node-tar emits per-entry pax headers for long or non-ASCII paths
    // (e.g. package/中文目录/). The directory entry consumes pendingName and
    // must clear it — a leak re-labels the following package.json entry and
    // a legitimate tarball gets rejected as missing-package-json.
    const dirTarget = 'package/中文目录/'
    const dirRecord = ` path=${dirTarget}\n`
    // PAX record length is counted in BYTES (non-ASCII targets differ from
    // string length); len covers the digits themselves plus the record.
    const recordBytes = Buffer.byteLength(dirRecord, 'utf8')
    const dirPax = Buffer.from(`${String(recordBytes + String(recordBytes).length)}${dirRecord}`, 'utf8')
    const tar = buildTar([
      { name: 'PaxHeaders/dir', data: dirPax, typeflag: 'x' },
      { name: 'shortdir', data: '', typeflag: '5' },
      { name: 'package/package.json', data: '{"name":"pax-dir-pkg","version":"1.0.0"}' },
    ])
    const manifest = extractPackageManifest(gzipSync(tar))
    expect(manifest).toEqual({ name: 'pax-dir-pkg', version: '1.0.0' })
  })

  it('applies a GNU longname override to exactly the next entry (P4)', () => {
    // GNU longname (typeflag 'L'): data is the NUL-terminated name for the
    // NEXT entry only. Long directory path + regular manifest afterwards.
    const longDir = `${'d'.repeat(110)}/`
    const tar = buildTar([
      { name: 'dummy-long', data: `${longDir}\0`, typeflag: 'L' },
      { name: 'shortdir', data: '', typeflag: '5' },
      { name: 'package/package.json', data: '{"name":"longname-pkg","version":"2.0.0"}' },
      { name: 'package/README.md', data: 'readme' },
    ])
    const manifest = extractPackageManifest(gzipSync(tar))
    expect(manifest).toEqual({ name: 'longname-pkg', version: '2.0.0' })
  })

  it('rejects an ambiguous tarball with more than one depth-1 package.json (D1)', () => {
    // Decoy smuggling: a clean manifest plus a dirty one must be rejected,
    // never tie-broken (buffered path parity with the streaming test below).
    const tar = buildTar([
      { name: 'a/package.json', data: '{"name":"a","version":"1.0.0"}' },
      { name: 'b/package.json', data: '{"name":"b","version":"1.0.0"}' },
    ])
    expect(() => extractPackageManifest(gzipSync(tar))).toThrow(/ambiguous/u)
    expect(() => extractPackageManifest(gzipSync(tar))).toThrow(/a\/package\.json, b\/package\.json/u)
  })

  it('rejects bytes that are not gzip at all', () => {
    expect(() => extractPackageManifest(Buffer.from('definitely not gzip'))).toThrow(TarballError)
    expect(() => extractPackageManifest(Buffer.from('definitely not gzip'))).toThrow(/not a gzip/u)
  })

  it('rejects gzip bytes that are not a tar (missing package.json)', () => {
    const notTar = gzipSync(Buffer.from('hello world, no tar here'))
    let caught: unknown
    try {
      extractPackageManifest(notTar)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(TarballError)
    expect((caught as TarballError).code).toBe('missing-package-json')
  })

  it('rejects an unparseable tar size field as an invalid tarball', () => {
    const tar = buildTar([{ name: 'package/package.json', data: '{"name":"x","version":"1"}' }])
    tar.write('not-octal!!', 124, 'latin1') // corrupt the size field
    expect(() => extractPackageManifest(gzipSync(tar))).toThrow(/unparseable size/u)
  })

  it('rejects a package.json that is not valid JSON', () => {
    const tar = buildTar([{ name: 'package/package.json', data: '{not json' }])
    expect(() => extractPackageManifest(gzipSync(tar))).toThrow(/not valid JSON/u)
  })

  it('rejects a package.json that is not a JSON object', () => {
    const tar = buildTar([{ name: 'package/package.json', data: '[1,2,3]' }])
    expect(() => extractPackageManifest(gzipSync(tar))).toThrow(/must be a JSON object/u)
  })
})

describe('decompression cap (review D6, gzip-bomb guard)', () => {
  // A zero-filled tar entry compresses ~1028×, so a "bomb" is cheap to build:
  // ~70 MiB of zeros gzip down to tens of KiB but decompress past the cap.
  function gzipBomb(decompressedBytes: number): Buffer {
    return gzipSync(buildTar([
      { name: 'package/package.json', data: JSON.stringify(cleanPackageManifest()) },
      { name: 'package/payload.bin', data: Buffer.alloc(decompressedBytes, 0) },
    ]))
  }

  it('a normal artifact decompresses far under the cap and still parses', () => {
    const tgz = buildTgz(cleanPackageManifest(), [{ name: 'index.js', data: 'module.exports = 1' }])
    expect(extractPackageManifest(tgz)).toMatchObject({ name: '@huaanwork/sample-plugin', version: '1.2.3' })
  })

  it('rejects a gzip bomb over the cap with an honest fail-closed error (buffer path)', () => {
    const bomb = gzipBomb(70 * 1024 * 1024)
    expect(bomb.length).toBeLessThan(1024 * 1024) // sanity: this IS a bomb
    let caught: unknown
    try {
      extractPackageManifest(bomb)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(TarballError)
    expect((caught as TarballError).code).toBe('decompressed-tarball-too-large')
    expect((caught as Error).message).toContain('67108864')
  })

  it('streaming file path: valid artifact parses with identical D1 walk rules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-tarball-'))
    const path = join(dir, 'valid.tgz')
    await writeFile(path, buildTgz(cleanPackageManifest({ description: 'streamed' }), [{ name: 'index.js', data: '1' }]))
    await expect(extractPackageManifestFromFile(path)).resolves.toMatchObject({
      name: '@huaanwork/sample-plugin',
      version: '1.2.3',
      description: 'streamed',
    })
    // Behavior parity for the D1 rules under the streaming path (shared tail):
    const dotdot = join(dir, 'dotdot.tgz')
    await writeFile(dotdot, gzipSync(buildTar([
      { name: 'package/escape/../package.json', data: '{"name":"x","version":"1.0.0"}' },
    ])))
    await expect(extractPackageManifestFromFile(dotdot)).rejects.toMatchObject({
      code: 'invalid-tarball',
    })
    const ambiguous = join(dir, 'ambiguous.tgz')
    await writeFile(ambiguous, gzipSync(buildTar([
      { name: 'a/package.json', data: '{"name":"a","version":"1.0.0"}' },
      { name: 'b/package.json', data: '{"name":"b","version":"1.0.0"}' },
    ])))
    await expect(extractPackageManifestFromFile(ambiguous)).rejects.toMatchObject({
      code: 'invalid-tarball',
    })
    const notGzip = join(dir, 'not-gzip.tgz')
    await writeFile(notGzip, Buffer.from('definitely not gzip'))
    await expect(extractPackageManifestFromFile(notGzip)).rejects.toMatchObject({
      code: 'invalid-tarball',
    })
  })

  it('streaming file path: a gzip bomb file over the cap is rejected, not loaded whole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-tarball-'))
    const path = join(dir, 'bomb.tgz')
    await writeFile(path, gzipBomb(70 * 1024 * 1024))
    await expect(extractPackageManifestFromFile(path)).rejects.toMatchObject({
      code: 'decompressed-tarball-too-large',
    })
  })
})
