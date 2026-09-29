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
 *
 * `assertMacArtifactIsUniversal` is tested in three layers: basename marker
 * tripwire (no tools needed), Mach-O reports driven by fake `lipo`/`file`
 * tools on a controlled PATH (the synthetic fixture is a fat Mach-O), and -
 * on a macOS host with hdiutil - against a real UDZO dmg built at test time by
 * `hdiutil create`, whose packed app executable is synthesized from a real
 * universal system binary. The real-image layer is the one that matches the
 * release pipeline (`electron-builder --mac dmg --universal`); it is skipped
 * only where the host genuinely lacks the tooling.
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
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

const execFileAsync = promisify(execFile)

/** Whether `command` is resolvable on PATH (the gate finds its tools there). */
function hostHasCommand(command: string): boolean {
  return (process.env.PATH ?? '')
    .split(':')
    .some(directory => directory !== '' && existsSync(join(directory, command)))
}

/**
 * A real system Mach-O that contains both an x86_64 and a true arm64 slice.
 * Most macOS binaries carry arm64e rather than arm64, so the candidates are
 * probed with lipo instead of assumed; the fat inner executable of the
 * real-image tests is synthesized from this file.
 */
function findUniversalSystemBinary(): string | null {
  const candidates = ['/usr/bin/file', '/usr/bin/sed', '/bin/cat', '/bin/ls', '/usr/bin/true', '/bin/sh']
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let report: string
    try {
      report = execFileSync('lipo', ['-info', candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      // Not a Mach-O, or lipo is missing: try the next candidate.
      continue
    }
    const tokens = report.split(/[^0-9A-Za-z_]+/u)
    if (tokens.includes('x86_64') && tokens.includes('arm64')) return candidate
  }
  return null
}

const UNIVERSAL_SYSTEM_BINARY = findUniversalSystemBinary()

/**
 * The real-image tests build a genuine UDZO dmg (`hdiutil create`) and mount
 * it again, and synthesize the inner executable with `lipo -thin`/`-create`.
 * Skipped only where the host genuinely lacks that tooling; the refusal paths
 * are pinned everywhere else.
 */
const REAL_DMG_TESTS_SUPPORTED = process.platform === 'darwin'
  && hostHasCommand('hdiutil')
  && hostHasCommand('lipo')
  && UNIVERSAL_SYSTEM_BINARY !== null

/**
 * Build a real UDZO dmg - the shape the release pipeline ships - whose packed
 * app executable is either fat (x86_64 + arm64) or a single arm64 slice.
 *
 * @param directory - scratch directory to stage and build in.
 * @param fat - whether the app executable carries both slices.
 * @returns path of the created dmg (basename carries the universal marker).
 */
async function buildProbeDmg(directory: string, fat: boolean): Promise<string> {
  const source = UNIVERSAL_SYSTEM_BINARY
  if (source === null) throw new Error('no universal system binary is available on this host')
  const contentsDirectory = join(directory, 'payload', 'Probe.app', 'Contents')
  const macosDirectory = join(contentsDirectory, 'MacOS')
  await mkdir(macosDirectory, { recursive: true })
  await writeFile(
    join(contentsDirectory, 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Probe</string></dict></plist>\n',
  )
  const executable = join(macosDirectory, 'Probe')
  if (fat) {
    const slices = join(directory, 'slices')
    await mkdir(slices, { recursive: true })
    const thinArm64 = join(slices, 'arm64.bin')
    const thinX86 = join(slices, 'x86_64.bin')
    await execFileAsync('lipo', ['-thin', 'arm64', source, '-output', thinArm64])
    await execFileAsync('lipo', ['-thin', 'x86_64', source, '-output', thinX86])
    await execFileAsync('lipo', ['-create', thinArm64, thinX86, '-output', executable])
  } else {
    await execFileAsync('lipo', ['-thin', 'arm64', source, '-output', executable])
  }
  await chmod(executable, 0o755)
  const dmgPath = join(directory, fat ? 'probe-universal.dmg' : 'probe-thin-universal.dmg')
  await execFileAsync('hdiutil', ['create', '-quiet', '-format', 'UDZO', '-srcfolder', join(directory, 'payload'), dmgPath])
  return dmgPath
}

/**
 * The gate must always detach the image it mounted - even when it refuses the
 * artifact. `hdiutil info` reports the resolved path, so the (unique) basename
 * is what is matched here.
 */
async function expectImageDetached(dmgPath: string): Promise<void> {
  const { stdout } = await execFileAsync('hdiutil', ['info'], { encoding: 'utf8' })
  expect(stdout).not.toContain(basename(dmgPath))
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
    const dir = await tempDir()
    for (const file of vectors) {
      // Inspect each vector under a universal-marked name (the tripwire must
      // not be the reason a synthetic thin fixture is refused), so the vector
      // exercises the architecture report itself: the fat Mach-O fixture -
      // what the mac channel publishes today - must keep passing.
      const marked = /universal/iu.test(file.name) ? file.name : file.name.replace(/\.dmg$/u, '-universal.dmg')
      const inspectionPath = join(dir, `inspection-${marked}`)
      await copyFile(join(SHAPE_FIXTURES, file.name), inspectionPath)
      const verdict = await assertMacArtifactIsUniversal(inspectionPath)
        .then(() => true, () => false)
      expect(verdict, `${file.name} (${file.construction})`).toBe(file.universal)
    }
  })
})

describe('assertMacArtifactIsUniversal', () => {
  /**
   * Run `run` with PATH pointing at `bin` only, so the arch report and the
   * mount tooling come from a controlled directory instead of whatever the
   * host has installed.
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

  async function writeTool(bin: string, name: string, script: string): Promise<void> {
    const path = join(bin, name)
    await writeFile(path, `#!/bin/sh\n${script}\n`, 'utf8')
    await chmod(path, 0o755)
  }

  async function writeFakeTool(bin: string, name: string, output: string): Promise<void> {
    await writeTool(bin, name, `echo '${output}'`)
  }

  it('refuses a basename without the release pipeline universal marker before any tool runs', async () => {
    const bin = await tempDir() // empty: the marker tripwire must come first

    await withPath(bin, async () => {
      const failure = await assertMacArtifactIsUniversal('/nonexistent/installer.dmg').catch(cause => cause)
      expect(failure).toBeInstanceOf(InvalidInstallerError)
      expect(String(failure.message)).toContain('universal marker')

      // The marker is case-insensitive: this name passes the tripwire and only
      // fails because no tool can report an architecture.
      const pastTripwire = await assertMacArtifactIsUniversal('/nonexistent/Installer-UNIVERSAL.dmg').catch(cause => cause)
      expect(String(pastTripwire.message)).toContain('neither lipo nor file')
    })
  })

  it('accepts a report naming both the x86_64 and the arm64 slice', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'lipo', 'Architectures in the fat file: installer.dmg are: x86_64 arm64')

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer-universal.dmg')).resolves.toBeUndefined()
    })
  })

  it('refuses a report that names a single architecture', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'lipo', 'Non-fat file: installer.dmg is architecture: arm64')

    await withPath(bin, async () => {
      const failure = await assertMacArtifactIsUniversal('/nonexistent/installer-universal.dmg').catch(cause => cause)
      expect(failure).toBeInstanceOf(InvalidInstallerError)
      expect(String(failure.message)).toContain('does not name both x86_64 and arm64')
    })
  })

  it('does not mistake the arm64e subtype for the arm64 slice', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'lipo', 'Non-fat file: installer.dmg is architecture: arm64e')

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer-universal.dmg')).rejects.toThrow(InvalidInstallerError)
    })
  })

  it('falls back to file when lipo is unavailable', async () => {
    const bin = await tempDir()
    await writeFakeTool(bin, 'file', 'Mach-O universal binary with 2 architectures: [x86_64] [arm64]')

    await withPath(bin, async () => {
      await expect(assertMacArtifactIsUniversal('/nonexistent/installer-universal.dmg')).resolves.toBeUndefined()
    })
  })

  it('refuses to publish when neither lipo nor file is available (fail closed)', async () => {
    const bin = await tempDir()

    await withPath(bin, async () => {
      const failure = await assertMacArtifactIsUniversal('/nonexistent/installer-universal.dmg').catch(cause => cause)
      expect(failure).toBeInstanceOf(InvalidInstallerError)
      expect(String(failure.message)).toContain('neither lipo nor file')
    })
  })

  it.runIf(process.platform !== 'win32')(
    'refuses a disk image when hdiutil is unavailable, naming the macOS host requirement',
    async () => {
      const dir = await tempDir()
      // A koly-trailered file is classified as a disk image without building a
      // real one; the fake lipo fails exactly like the real one on a dmg.
      const artifact = await writeFixtureFile(dir, 'probe-universal.dmg', dmgBytes(1024, KOLY_TRAILER))
      const bin = await tempDir()
      await writeTool(bin, 'lipo', 'echo "fatal error: lipo: can\'t figure out the architecture type of: $2" 1>&2\nexit 1')
      await writeTool(bin, 'file', 'echo "$1: zlib compressed data"')

      await withPath(bin, async () => {
        const failure = await assertMacArtifactIsUniversal(artifact).catch(cause => cause)
        expect(failure).toBeInstanceOf(InvalidInstallerError)
        expect(String(failure.message)).toContain('macOS host')
      })
    },
  )

  it.skipIf(!REAL_DMG_TESTS_SUPPORTED)(
    'accepts a real UDZO dmg whose packed app executable carries both slices',
    async () => {
      const dir = await tempDir()
      const dmg = await buildProbeDmg(dir, true)

      await expect(assertMacArtifactIsUniversal(dmg)).resolves.toBeUndefined()
      await expectImageDetached(dmg)
    },
    60_000, // hdiutil create and attach routinely take seconds on a loaded host
  )

  it.skipIf(!REAL_DMG_TESTS_SUPPORTED)(
    'refuses a real UDZO dmg whose packed app executable is arm64-only',
    async () => {
      const dir = await tempDir()
      const dmg = await buildProbeDmg(dir, false)

      const failure = await assertMacArtifactIsUniversal(dmg).catch(cause => cause)
      expect(failure).toBeInstanceOf(InvalidInstallerError)
      expect(String(failure.message)).toContain('inside the dmg is not universal')
      await expectImageDetached(dmg) // the refusal path detaches too
    },
    60_000,
  )
})
