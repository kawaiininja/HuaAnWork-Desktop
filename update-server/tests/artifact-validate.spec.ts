/**
 * Task 3.3 Step 1: the publish-side installer gate (src/artifact/validate.ts).
 *
 * `validateInstallerShape` mirrors the client's private validateArtifact
 * (dsh-plugin-huaanwork/src/update-download.ts): darwin must end in a 'koly'
 * DMG trailer, win32 must carry a DOS 'MZ' header with a valid 'PE\0\0'
 * signature at the offset stored at 0x3c, and the artifact must be non-empty
 * and at most PUBLISH_MAX_ARTIFACT_BYTES - the same 1 GiB cap the client
 * enforces on download (D-M6-12 note: the checks read the header and trailer
 * only, never the whole file).
 *
 * The last two describes are the server side of the cross-workspace contract:
 * they assert this gate against the committed shared fixture
 * (tests/fixtures/installer-shapes) that dsh-plugin-huaanwork's
 * tests/update-server-contract.spec.ts reads by path.
 */

import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  InvalidInstallerError,
  PUBLISH_MAX_ARTIFACT_BYTES,
  assertMacArtifactIsUniversal,
  validateInstallerShape,
} from '../src/artifact/validate.ts'

const SHAPE_FIXTURES = join(import.meta.dirname, 'fixtures', 'installer-shapes')

interface ShapeFixture {
  readonly name: string
  readonly platform: 'darwin' | 'win32'
  readonly shape: 'valid' | 'invalid'
  readonly universal: boolean | null
  readonly bytes: number
  readonly construction: string
}

interface SizeVector {
  readonly bytes: number
  readonly expected: boolean
  readonly reason: string
}

interface ShapeFixtureManifest {
  readonly fixtureVersion: number
  readonly sizeCapBytes: number
  readonly sizeVectors: readonly SizeVector[]
  readonly files: readonly ShapeFixture[]
}

const MANIFEST = JSON.parse(
  readFileSync(join(SHAPE_FIXTURES, 'manifest.json'), 'utf8'),
) as ShapeFixtureManifest

/** NTFS extends a non-sparse file by allocating; these tests skip there. */
const SPARSE_FIXTURES_SUPPORTED = process.platform !== 'win32'

const KOLY_TRAILER = (() => {
  const trailer = Buffer.alloc(512)
  trailer.write('koly', 0, 'ascii')
  return trailer
})()

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'update-server-artifact-'))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function writeFixtureFile(dir: string, name: string, bytes: Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

/** `size` bytes of deterministic filler ending in the given 512-byte trailer. */
function dmgBytes(size: number, trailer: Buffer): Buffer {
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size - trailer.byteLength; index += 1) bytes[index] = index & 0xff
  trailer.copy(bytes, size - trailer.byteLength)
  return bytes
}

/** `MZ` + filler, with `offset` stored at 0x3c and `magic` written at `offset` when it fits. */
function peBytes(size: number, offset: number, magic: Buffer | null): Buffer {
  const bytes = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) bytes[index] = index & 0xff
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(offset, 0x3c)
  if (magic !== null && offset + magic.byteLength <= size) magic.copy(bytes, offset)
  return bytes
}

/** A `size`-byte sparse file whose final 512 bytes start with 'koly'. */
async function writeSparseDmg(path: string, size: number): Promise<void> {
  if (size < KOLY_TRAILER.byteLength) {
    await writeFile(path, Buffer.alloc(size))
    return
  }
  const handle = await open(path, 'w')
  try {
    await handle.write(KOLY_TRAILER, 0, KOLY_TRAILER.byteLength, size - KOLY_TRAILER.byteLength)
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}

describe('validateInstallerShape', () => {
  it('accepts a dmg whose final 512 bytes start with the koly trailer', async () => {
    const dir = await tempDir()
    const path = await writeFixtureFile(dir, 'good.dmg', dmgBytes(1024, KOLY_TRAILER))

    await expect(validateInstallerShape('darwin', path)).resolves.toBeUndefined()
  })

  it('rejects a dmg without the koly trailer', async () => {
    const dir = await tempDir()
    const trailer = Buffer.alloc(512, 0x2e)
    trailer.write('xxxx', 0, 'ascii')
    const path = await writeFixtureFile(dir, 'bad.dmg', dmgBytes(1024, trailer))

    await expect(validateInstallerShape('darwin', path)).rejects.toThrow(InvalidInstallerError)
  })

  it('rejects a dmg shorter than the trailer', async () => {
    const dir = await tempDir()
    const path = await writeFixtureFile(dir, 'short.dmg', Buffer.alloc(100, 0x2e))

    await expect(validateInstallerShape('darwin', path)).rejects.toThrow(InvalidInstallerError)
  })

  it('accepts a PE image with MZ and a valid PE header at the 0x3c offset', async () => {
    const dir = await tempDir()
    const path = await writeFixtureFile(dir, 'good.exe', peBytes(256, 0x80, Buffer.from([0x50, 0x45, 0x00, 0x00])))

    await expect(validateInstallerShape('win32', path)).resolves.toBeUndefined()
  })

  it('rejects a PE image whose magic is missing at the declared offset', async () => {
    const dir = await tempDir()
    const path = await writeFixtureFile(dir, 'bad-pe.exe', peBytes(256, 0x80, Buffer.from('XXXX', 'ascii')))

    await expect(validateInstallerShape('win32', path)).rejects.toThrow(InvalidInstallerError)
  })

  it('rejects a file that is not MZ at all', async () => {
    const dir = await tempDir()
    const path = await writeFixtureFile(dir, 'not-mz.exe', Buffer.alloc(256, 0x2e))

    await expect(validateInstallerShape('win32', path)).rejects.toThrow(InvalidInstallerError)
  })

  it('rejects an empty file and a directory path', async () => {
    const dir = await tempDir()
    const empty = await writeFixtureFile(dir, 'empty.dmg', Buffer.alloc(0))

    await expect(validateInstallerShape('darwin', empty)).rejects.toThrow(InvalidInstallerError)
    await expect(validateInstallerShape('darwin', dir)).rejects.toThrow(InvalidInstallerError)
  })

  it.skipIf(!SPARSE_FIXTURES_SUPPORTED)(
    'reads only the header and the trailer, never the whole file',
    async () => {
      const dir = await tempDir()
      // Exactly at the cap: only a header/trailer read can accept it in
      // milliseconds (streaming the whole 1 GiB takes ~900 ms on the reference
      // machine) and without allocating the file.
      const atCap = join(dir, 'at-the-cap.dmg')
      await writeSparseDmg(atCap, PUBLISH_MAX_ARTIFACT_BYTES)
      const rssBefore = process.memoryUsage().rss
      const acceptedStart = Date.now()
      await validateInstallerShape('darwin', atCap)
      const acceptedMs = Date.now() - acceptedStart
      const rssGrowth = process.memoryUsage().rss - rssBefore

      // One byte past the cap, same koly trailer: only the size rule may reject
      // it, and a whole-file read would need seconds for 4 GiB.
      const overCap = join(dir, 'over-the-cap.dmg')
      await writeSparseDmg(overCap, 4 * PUBLISH_MAX_ARTIFACT_BYTES)
      const rejectedStart = Date.now()
      await expect(validateInstallerShape('darwin', overCap)).rejects.toThrow(InvalidInstallerError)
      const rejectedMs = Date.now() - rejectedStart

      // The cap is inclusive (1 GiB passes) and the gate stays in the
      // header/trailer class of reads for both verdicts.
      expect(acceptedMs).toBeLessThan(500)
      expect(rejectedMs).toBeLessThan(1_000)
      expect(rssGrowth).toBeLessThan(256 * 1024 * 1024)
    },
  )
})

describe('shared installer-shape fixture (server gate vs client validator)', () => {
  it('pins the shared fixture version', () => {
    expect(MANIFEST.fixtureVersion).toBe(1)
  })

  it('pins the publish size cap to the shared client download cap', () => {
    // update-server refuses to publish what a client would refuse to download;
    // the client spec asserts its own MAX_UPDATE_DOWNLOAD_BYTES against the same number.
    expect(PUBLISH_MAX_ARTIFACT_BYTES).toBe(MANIFEST.sizeCapBytes)
  })

  it('agrees on every shared shape vector', async () => {
    expect(MANIFEST.files.length).toBeGreaterThanOrEqual(4)
    for (const file of MANIFEST.files) {
      const path = join(SHAPE_FIXTURES, file.name)
      const bytes = readFileSync(path)
      expect(bytes.byteLength, file.name).toBe(file.bytes)
      const verdict = await validateInstallerShape(file.platform, path).then(() => true, () => false)
      expect(verdict, `${file.name} (${file.construction})`).toBe(file.shape === 'valid')
    }
  })

  it.skipIf(!SPARSE_FIXTURES_SUPPORTED)('agrees on every shared size vector', async () => {
    const dir = await tempDir()
    for (const vector of MANIFEST.sizeVectors) {
      const path = join(dir, `size-${String(vector.bytes)}.dmg`)
      await writeSparseDmg(path, vector.bytes)
      const verdict = await validateInstallerShape('darwin', path).then(() => true, () => false)
      expect(verdict, `${String(vector.bytes)} bytes (${vector.reason})`).toBe(vector.expected)
    }
  })

  it.skipIf(process.platform !== 'darwin')('agrees on every shared mac-universal vector', async () => {
    const vectors = MANIFEST.files.filter(file => file.universal !== null)
    expect(vectors.length).toBeGreaterThanOrEqual(2)
    for (const file of vectors) {
      const verdict = await assertMacArtifactIsUniversal(join(SHAPE_FIXTURES, file.name))
        .then(() => true, () => false)
      expect(verdict, `${file.name} (${file.construction})`).toBe(file.universal)
    }
  })
})

describe('assertMacArtifactIsUniversal', () => {
  /**
   * Run `run` with PATH pointing at `bin` only, so the arch report comes from a
   * controlled tool instead of whatever the host has installed.
   */
  async function withPath(bin: string, run: () => Promise<void>): Promise<void> {
    const previous = process.env.PATH
    process.env.PATH = bin
    try {
      await run()
    } finally {
      process.env.PATH = previous
    }
  }

  async function writeFakeTool(bin: string, name: string, output: string): Promise<void> {
    const path = join(bin, name)
    await writeFile(path, `#!/bin/sh\necho '${output}'\n`, 'utf8')
    await chmod(path, 0o755)
  }

  it('accepts a report naming both the x86_64 and the arm64 slice', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'lipo', 'Architectures in the fat file: installer.dmg are: x86_64 arm64')

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer.dmg')).resolves.toBeUndefined()
    })
  })

  it('refuses a report that names a single architecture', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'lipo', 'Non-fat file: installer.dmg is architecture: arm64')

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer.dmg')).rejects.toThrow(InvalidInstallerError)
    })
  })

  it('falls back to file when lipo is unavailable', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'file', 'Mach-O universal binary with 2 architectures: [x86_64] [arm64]')

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer.dmg')).resolves.toBeUndefined()
    })
  })

  it('refuses to publish when neither lipo nor file is available (fail closed)', async () => {
    const bin = await tempDir()

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer.dmg')).rejects.toThrow(InvalidInstallerError)
    })
  })
})
