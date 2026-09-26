import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TarballError, extractPackageManifest } from '../src/tarball/parse.ts'
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
