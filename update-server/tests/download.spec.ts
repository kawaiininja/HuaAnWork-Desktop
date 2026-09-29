/**
 * Task 3.3 Step 2: GET /api/downloads/{mac,windows} and its write side,
 * scripts/publish-release.mjs (run by an operator on the deploy host).
 *
 * Every HTTP test boots the real server through tests/helpers/server.ts. The
 * artifact files are placed where the runbook puts them, under
 * `<dataDir>/artifacts/<channel>/<platform>/<filename>`, and the channel record
 * is written by the real publish script - so the route is exercised against
 * exactly the state an operator produces.
 *
 * The `mac-universal.dmg` fixture is a hand-crafted fat Mach-O whose slices
 * satisfy the real `lipo -info`, so the mac publish path is tested end to end
 * instead of being mocked.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { PUBLISH_MAX_ARTIFACT_BYTES } from '../src/artifact/validate.ts'
import { readDownloadRequestHeaders } from '../src/download/routes.ts'
import { InvalidHeaderValueError } from '../src/version/service.ts'
import type { UpdateChannelRecord } from '../src/version/store.ts'
import { bootTestUpdateServer, type TestUpdateServer } from './helpers/server.ts'

const execFileAsync = promisify(execFile)

const PUBLISH_SCRIPT = join(import.meta.dirname, '..', 'scripts', 'publish-release.mjs')
const SHAPE_FIXTURES = join(import.meta.dirname, 'fixtures', 'installer-shapes')
const MAC_ARTIFACT = join(SHAPE_FIXTURES, 'mac-universal.dmg')
const THIN_MAC_ARTIFACT = join(SHAPE_FIXTURES, 'mac-thin-arm64.dmg')
const BAD_MAC_ARTIFACT = join(SHAPE_FIXTURES, 'mac-bad-trailer.dmg')
const WINDOWS_ARTIFACT = join(SHAPE_FIXTURES, 'windows-valid.exe')
const BAD_WINDOWS_ARTIFACT = join(SHAPE_FIXTURES, 'windows-bad-pe.exe')

/** A Mach-O architecture report needs lipo or a Mach-O-aware file(1). */
const MACHO_TOOLS_AVAILABLE = process.platform !== 'win32'
/** NTFS extends a non-sparse file by allocating; the cap test skips there. */
const SPARSE_FIXTURES_SUPPORTED = process.platform !== 'win32'

const bootedServers: TestUpdateServer[] = []
const tempDirs: string[] = []

async function boot(): Promise<TestUpdateServer> {
  const booted = await bootTestUpdateServer()
  bootedServers.push(booted)
  return booted
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'update-server-download-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(bootedServers.splice(0).map(booted => booted.close().catch(() => undefined)))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface PlacedArtifact {
  readonly path: string
  readonly filename: string
  readonly sha256: string
  readonly bytes: number
}

/** Put an artifact where the runbook puts it and hash the bytes on disk (D-M6-23). */
async function placeArtifact(
  dataDir: string,
  channel: string,
  platform: 'mac' | 'windows',
  source: string,
  name = basename(source),
): Promise<PlacedArtifact> {
  const directory = join(dataDir, 'artifacts', channel, platform)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, name)
  await copyFile(source, path)
  const bytes = await readFile(path)
  return {
    path,
    filename: name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

interface PublishResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function publish(
  dataDir: string,
  channel: string,
  version: string,
  platform: 'mac' | 'windows',
  file: string,
): Promise<PublishResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [PUBLISH_SCRIPT, '--channel', channel, '--version', version, '--platform', platform, '--file', file, '--data-dir', dataDir],
      { encoding: 'utf8' },
    )
    return { code: 0, stdout, stderr }
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

async function readRecord(dataDir: string, channel: string): Promise<UpdateChannelRecord | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'channels', `${channel}.json`), 'utf8')) as UpdateChannelRecord
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}

interface DownloadResponse {
  readonly status: number
  readonly headers: Headers
  readonly bytes: Buffer
  readonly text: string
}

async function getDownload(
  booted: TestUpdateServer,
  path: string,
  headers: Record<string, string> = {},
): Promise<DownloadResponse> {
  const response = await fetch(`${booted.origin}/api/downloads/${path}`, { headers, redirect: 'manual' })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') }
}

function appHeaders(channel: string, version: string): Record<string, string> {
  return { 'X-DSH-Desktop-Channel': channel, 'X-DSH-Desktop-Target-Version': version }
}

describe('GET /api/downloads/:platform', () => {
  it.runIf(MACHO_TOOLS_AVAILABLE)('serves the published artifact with an accurate content-length', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'mac', MAC_ARTIFACT)

    const result = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'mac', placed.path)
    expect(result.code, result.stderr).toBe(0)

    const download = await getDownload(booted, 'mac', appHeaders('huaanwork', '0.2.0'))

    expect(download.status).toBe(200)
    expect(download.headers.get('content-length')).toBe(String(placed.bytes))
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
    expect(download.bytes).toEqual(await readFile(placed.path))
  })

  it('serves a windows artifact with an accurate content-length', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)

    const result = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)
    expect(result.code, result.stderr).toBe(0)

    const download = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))

    expect(download.status).toBe(200)
    expect(download.headers.get('content-length')).toBe(String(placed.bytes))
    expect(download.bytes).toEqual(await readFile(placed.path))
  })

  it.runIf(MACHO_TOOLS_AVAILABLE)('reports the artifact sha256 so operators can reconcile out of band', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'mac', MAC_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'mac', placed.path)

    const download = await getDownload(booted, 'mac', appHeaders('huaanwork', '0.2.0'))
    const record = await readRecord(booted.dataDir, 'huaanwork')

    expect(download.headers.get('x-huaanwork-artifact-sha256')).toBe(placed.sha256)
    expect(record?.artifacts.mac?.sha256).toBe(placed.sha256)
  })

  it('returns 404 version-mismatch when the target version is not the published one', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    const download = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.1.9'))

    expect(download.status).toBe(404)
    expect(JSON.parse(download.text)).toEqual({ error: { code: 'version-mismatch', message: expect.any(String) } })
  })

  it('returns 404 version-mismatch when the target version header is absent', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    const download = await getDownload(booted, 'windows', { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(download.status).toBe(404)
    expect(JSON.parse(download.text)).toEqual({ error: { code: 'version-mismatch', message: expect.any(String) } })
  })

  it('returns 404 no-artifact when the channel record has no entry for this platform', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'mac', MAC_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'mac', placed.path)

    // The mac release is fine; windows simply has not been published yet, which
    // is a normal state, not an incident.
    const download = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))

    expect(download.status).toBe(404)
    expect(JSON.parse(download.text)).toEqual({ error: { code: 'no-artifact', message: expect.any(String) } })
  })

  it('returns 500 artifact-missing-or-truncated when the record points at a file that is absent or short', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    await rm(placed.path)
    const missing = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))
    expect(missing.status).toBe(500)
    expect(JSON.parse(missing.text)).toEqual({
      error: { code: 'artifact-missing-or-truncated', message: expect.any(String) },
    })

    // Short file: the record's byte count no longer matches the disk, so the
    // response must not go out with a fabricated content-length either.
    await writeFile(placed.path, Buffer.alloc(placed.bytes - 1))
    const short = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))
    expect(short.status).toBe(500)
    expect(JSON.parse(short.text)).toEqual({
      error: { code: 'artifact-missing-or-truncated', message: expect.any(String) },
    })

    // Neither case may degrade into 404: a client reads 404 as "no update" and
    // would turn a publish incident into a normal state.
    expect(missing.status).not.toBe(404)
    expect(short.status).not.toBe(404)
  })

  it('returns 404 unknown-channel when the channel header is absent or foreign', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    const absent = await getDownload(booted, 'windows', { 'X-DSH-Desktop-Target-Version': '0.2.0' })
    const foreign = await getDownload(booted, 'windows', appHeaders('nightly', '0.2.0'))

    for (const download of [absent, foreign]) {
      expect(download.status).toBe(404)
      expect(JSON.parse(download.text)).toEqual({ error: { code: 'unknown-channel', message: expect.any(String) } })
    }
  })

  it('never serves a file outside the platform directory, whatever the record filename says', async () => {
    const booted = await boot()
    // A record can be hand-edited on the deploy host, so the filename is only
    // turned into a path after it is checked; this one must never be served.
    const outside = await readFile(WINDOWS_ARTIFACT)
    await mkdir(join(booted.dataDir, 'channels'), { recursive: true, mode: 0o700 })
    await writeFile(join(booted.dataDir, 'outside.exe'), outside)
    await writeFile(join(booted.dataDir, 'channels', 'huaanwork.json'), `${JSON.stringify({
      version: '0.2.0',
      publishedAt: '2026-09-28T08:00:00.000Z',
      artifacts: {
        windows: {
          filename: '../../outside.exe',
          sha256: createHash('sha256').update(outside).digest('hex'),
          bytes: outside.byteLength,
        },
      },
    })}\n`)

    const download = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))

    expect(download.status).toBe(500)
    expect(JSON.parse(download.text)).toEqual({
      error: { code: 'artifact-missing-or-truncated', message: expect.any(String) },
    })
    expect(download.text).not.toContain(outside.toString('utf8'))
  })

  it('answers a non-GET method on the download endpoint with 405', async () => {
    const booted = await boot()

    const response = await fetch(`${booted.origin}/api/downloads/mac`, { method: 'POST' })

    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: { code: 'method-not-allowed', message: expect.any(String) } })
  })

  it('returns 404 no-release when the channel has no record at all', async () => {
    const booted = await boot()

    const download = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))

    expect(download.status).toBe(404)
    expect(JSON.parse(download.text)).toEqual({ error: { code: 'no-release', message: expect.any(String) } })
  })

  it('answers an unknown platform path with 404 not-found', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    const download = await getDownload(booted, 'linux', appHeaders('huaanwork', '0.2.0'))

    expect(download.status).toBe(404)
    expect(JSON.parse(download.text)).toEqual({ error: { code: 'not-found', message: expect.any(String) } })
  })

  it.runIf(MACHO_TOOLS_AVAILABLE)('serves windows and mac artifacts independently', async () => {
    const booted = await boot()
    const mac = await placeArtifact(booted.dataDir, 'huaanwork', 'mac', MAC_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'mac', mac.path)
    const windows = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', windows.path)

    const macDownload = await getDownload(booted, 'mac', appHeaders('huaanwork', '0.2.0'))
    const windowsDownload = await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))
    const record = await readRecord(booted.dataDir, 'huaanwork')

    expect(macDownload.bytes).toEqual(await readFile(mac.path))
    expect(windowsDownload.bytes).toEqual(await readFile(windows.path))
    // Publishing the second platform merges into the same version's record.
    expect(record?.version).toBe('0.2.0')
    expect(Object.keys(record?.artifacts ?? {}).sort()).toEqual(['mac', 'windows'])
    expect(record?.artifacts.windows?.sha256).toBe(windows.sha256)
    expect(record?.artifacts.mac?.sha256).toBe(mac.sha256)
  })

  it('does not leak the data directory path in any error body', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    const bodies: string[] = []
    bodies.push((await getDownload(booted, 'windows', appHeaders('nightly', '0.2.0'))).text) // unknown-channel
    bodies.push((await getDownload(booted, 'windows', appHeaders('beta', '0.2.0'))).text) // no-release
    bodies.push((await getDownload(booted, 'windows', appHeaders('huaanwork', '0.1.0'))).text) // version-mismatch
    bodies.push((await getDownload(booted, 'mac', appHeaders('huaanwork', '0.2.0'))).text) // no-artifact
    await rm(placed.path)
    bodies.push((await getDownload(booted, 'windows', appHeaders('huaanwork', '0.2.0'))).text) // truncated
    await writeFile(join(booted.dataDir, 'channels', 'stable.json'), '{ not json')
    bodies.push((await getDownload(booted, 'windows', appHeaders('stable', '0.2.0'))).text) // corrupt record

    expect(bodies.join('\n')).not.toContain(booted.dataDir)
    expect(bodies.join('\n')).not.toContain('artifacts/')
  })

  it('rejects a target version header containing CRLF', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)
    await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)

    // A CRLF-carrying value cannot be sent by fetch (undici refuses to build
    // it); HTAB is the control character that survives to a handler, and the
    // literal CRLF string is pinned by the unit test below, which shares the
    // header reader with the version endpoint.
    const download = await getDownload(booted, 'windows', {
      'X-DSH-Desktop-Channel': 'huaanwork',
      'X-DSH-Desktop-Target-Version': '0.2.0\tX-Injected: 1',
    })

    expect(download.status).toBe(400)
    expect(JSON.parse(download.text)).toEqual({ error: { code: 'invalid-header', message: expect.any(String) } })
    expect(download.headers.get('x-injected')).toBeNull()
  })
})

describe('download request headers (defense in depth)', () => {
  it('rejects a target version value carrying CR, LF, or another control character', () => {
    expect(() => readDownloadRequestHeaders({ 'x-dsh-desktop-target-version': '0.2.0\r\nX-Injected: 1' }))
      .toThrow(InvalidHeaderValueError)
    expect(() => readDownloadRequestHeaders({ 'x-dsh-desktop-target-version': '0.2.0\u0000' }))
      .toThrow(InvalidHeaderValueError)
    expect(() => readDownloadRequestHeaders({ 'x-dsh-desktop-channel': 'huaanwork\u007f' }))
      .toThrow(InvalidHeaderValueError)
    expect(readDownloadRequestHeaders({
      'x-dsh-desktop-channel': 'huaanwork',
      'x-dsh-desktop-target-version': '0.2.0',
    })).toEqual({ channel: 'huaanwork', targetVersion: '0.2.0' })
  })
})

describe('publish-release.mjs (the write side, run by an operator on the deploy host)', () => {
  it.runIf(MACHO_TOOLS_AVAILABLE)('refuses a dmg that is not universal', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'mac', THIN_MAC_ARTIFACT)

    const result = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'mac', placed.path)

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('universal')
    expect(await readRecord(booted.dataDir, 'huaanwork')).toBeNull()
    expect(await readFile(placed.path)).toEqual(await readFile(THIN_MAC_ARTIFACT))
  })

  it('refuses an artifact whose bytes fail the installer shape gate', async () => {
    const booted = await boot()
    const badMac = await placeArtifact(booted.dataDir, 'huaanwork', 'mac', BAD_MAC_ARTIFACT)
    const badWindows = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', BAD_WINDOWS_ARTIFACT)

    const macResult = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'mac', badMac.path)
    const windowsResult = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', badWindows.path)

    expect(macResult.code).not.toBe(0)
    expect(windowsResult.code).not.toBe(0)
    expect(await readRecord(booted.dataDir, 'huaanwork')).toBeNull()
  })

  it.skipIf(!SPARSE_FIXTURES_SUPPORTED)('refuses an artifact larger than the client download cap', async () => {
    const booted = await boot()
    const directory = join(booted.dataDir, 'artifacts', 'huaanwork', 'windows')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'HuaAnWork-0.2.0-x64-Setup.exe')
    const header = Buffer.alloc(256)
    header.write('MZ', 0, 'ascii')
    header.writeUInt32LE(0x80, 0x3c)
    Buffer.from([0x50, 0x45, 0x00, 0x00]).copy(header, 0x80)
    await writeFile(path, header)
    await truncate(path, PUBLISH_MAX_ARTIFACT_BYTES + 1)

    const result = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', path)

    // The shape gate passes; only the 1 GiB cap - the same number the client
    // enforces on download - may refuse this artifact.
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(String(PUBLISH_MAX_ARTIFACT_BYTES))
    expect(await readRecord(booted.dataDir, 'huaanwork')).toBeNull()
  })

  it('refuses a version whose shape does not match the channel', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)

    const cases = [
      ['huaanwork', '0.2.0-beta.1'], // prerelease on a plain-release channel
      ['beta', '0.2.0'], // no -beta.<n> prerelease on the beta channel
      ['stable', 'v0.2.0'], // not canonical
      ['nightly', '0.2.0'], // not a channel this server serves
    ] as const
    for (const [channel, version] of cases) {
      const result = await publish(booted.dataDir, channel, version, 'windows', placed.path)
      expect(result.code, `${channel} ${version}`).not.toBe(0)
    }
    expect(await readRecord(booted.dataDir, 'huaanwork')).toBeNull()
  })

  it('streams the artifact to compute sha256 instead of buffering it (D-M6-12)', async () => {
    const source = await readFile(PUBLISH_SCRIPT, 'utf8')

    expect(source).toContain('createReadStream')
    expect(source).toContain('hash.update')
    // A whole-artifact read would put the memory peak at the artifact size.
    expect(/\breadFileSync\b/u.test(source)).toBe(false)
  })

  it('writes the channel record atomically and never leaves a .tmp behind', async () => {
    const booted = await boot()
    const placed = await placeArtifact(booted.dataDir, 'huaanwork', 'windows', WINDOWS_ARTIFACT)

    const first = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)
    expect(first.code, first.stderr).toBe(0)
    const firstBytes = await readFile(join(booted.dataDir, 'channels', 'huaanwork.json'))

    // Same artifact, same version: a rerun publishes the same record instead of
    // reporting a conflict.
    const second = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', placed.path)
    expect(second.code, second.stderr).toBe(0)
    const secondBytes = await readFile(join(booted.dataDir, 'channels', 'huaanwork.json'))

    expect(secondBytes).toEqual(firstBytes)
    expect((await readdir(join(booted.dataDir, 'channels'))).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect((await stat(join(booted.dataDir, 'channels', 'huaanwork.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(booted.dataDir, 'channels'))).mode & 0o777).toBe(0o700)
    expect(first.stdout).toContain(join(booted.dataDir, 'artifacts', 'huaanwork', 'windows', placed.filename))
  })

  it('refuses to publish an artifact that is not where the server will serve it from', async () => {
    const booted = await boot()
    const staging = await tempDir()
    const path = join(staging, basename(WINDOWS_ARTIFACT))
    await copyFile(WINDOWS_ARTIFACT, path)

    const result = await publish(booted.dataDir, 'huaanwork', '0.2.0', 'windows', path)

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(join(booted.dataDir, 'artifacts', 'huaanwork', 'windows'))
    expect(await readRecord(booted.dataDir, 'huaanwork')).toBeNull()
  })
})
