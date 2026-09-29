/**
 * Client side of the cross-workspace contract reconciliation.
 *
 * The dependency-direction guard forbids src/ imports across the boundary, and
 * this package's tsconfig.tests.json pins rootDir to the package, so NO import
 * may cross into update-server/ — the shared truth is a JSON fixture read by
 * path (same pattern as market-test-server.ts reading signing-vectors.json).
 *
 * Two contracts are reconciled here:
 *
 *   - the release-channel version shape: update-server/src/channels.ts mirrors
 *     matchesReleaseChannelVersionShape, and both sides assert one committed
 *     vector set (scripts/gen-channel-version-vectors.ts regenerates it);
 *   - the installer shape and size: update-server/src/artifact/validate.ts
 *     mirrors the private validateArtifact of src/update-download.ts against
 *     the committed installer-shapes fixture. The client side below does not
 *     re-implement the criteria: it drives the real download path
 *     (downloadDesktopUpdate through a stub request) so the private validator
 *     actually runs on the fixture bytes.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SUPPORTED_RELEASE_CHANNELS,
  checkForDesktopUpdate,
  matchesReleaseChannelVersionShape,
  parseSemVer,
  type DesktopReleaseChannel,
} from '../src/update-checker.ts'
import {
  MAX_UPDATE_DOWNLOAD_BYTES,
  UpdateDownloadError,
  desktopDownloadUrls,
  downloadDesktopUpdate,
} from '../src/update-download.ts'

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../update-server/tests/fixtures/channel-version-vectors.json'), 'utf8'),
) as {
  fixtureVersion: number
  channels: readonly string[]
  vectors: readonly { channel: string; version: string; expected: boolean }[]
}

const SHAPE_FIXTURES = join(import.meta.dirname, '../../update-server/tests/fixtures/installer-shapes')

interface ShapeFixture {
  readonly name: string
  readonly platform: 'darwin' | 'win32'
  readonly shape: 'valid' | 'invalid'
  readonly universal: boolean | null
  readonly bytes: number
  readonly construction: string
}

interface ShapeFixtureManifest {
  readonly fixtureVersion: number
  readonly sizeCapBytes: number
  readonly sizeVectors: readonly { readonly bytes: number; readonly expected: boolean; readonly reason: string }[]
  readonly files: readonly ShapeFixture[]
}

const SHAPE_MANIFEST = JSON.parse(
  readFileSync(join(SHAPE_FIXTURES, 'manifest.json'), 'utf8'),
) as ShapeFixtureManifest

const UPDATE_ORIGIN = 'http://update.intranet.example:8790'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'huaanwork-contract-'))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface DownloadOutcome {
  readonly ok: boolean
  readonly code: string | undefined
  readonly requestedUrl: string | undefined
}

/**
 * Drive the real download path over `bytes` without a network: the stub
 * request answers 200 with the fixture bytes, so downloadDesktopUpdate writes
 * them and runs the private validateArtifact exactly as it does against the
 * deployed server.
 */
async function clientVerdict(
  bytes: Buffer,
  platform: 'darwin' | 'win32',
  declaredBytes = bytes.byteLength,
): Promise<DownloadOutcome> {
  const directory = await tempDir()
  const destination = join(directory, `installer${platform === 'darwin' ? '.dmg' : '.exe'}`)
  let requestedUrl: string | undefined
  try {
    await downloadDesktopUpdate({
      platform,
      version: '0.2.0',
      channel: 'huaanwork',
      destinationPath: destination,
      origin: UPDATE_ORIGIN,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      request: async (url: string) => {
        requestedUrl = url
        // Uint8Array (not Buffer) so the body satisfies the DOM/undici BodyInit.
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-length': String(declaredBytes), 'content-type': 'application/octet-stream' },
        })
      },
    })
    return { ok: true, code: undefined, requestedUrl }
  } catch (cause) {
    return {
      ok: false,
      code: cause instanceof UpdateDownloadError ? cause.code : undefined,
      requestedUrl,
    }
  }
}

describe('release channel version shape (client side)', () => {
  it('pins the shared fixture version', () => {
    expect(FIXTURE.fixtureVersion).toBe(1)
  })

  it('covers exactly the channels the client supports', () => {
    expect([...FIXTURE.channels].sort()).toEqual([...SUPPORTED_RELEASE_CHANNELS].sort())
  })

  it('reproduces every shared vector', () => {
    for (const { channel, version, expected } of FIXTURE.vectors) {
      // This narrowing is safe only because the channel-set assertion above
      // holds: every channel string in the fixture is a client union member.
      const actual = isAdmissible(channel as DesktopReleaseChannel, version)
      expect(actual, `${channel} ${version}`).toBe(expected)
    }
  })

  it('agrees with the real admission path on every shared vector', async () => {
    // The same verdict the version checker itself reaches: it accepts only a
    // version whose canonical form equals the input, so an inadmissible value
    // makes the check fail closed (null) no matter what the service answers.
    for (const { channel, version, expected } of FIXTURE.vectors) {
      const typedChannel = channel as DesktopReleaseChannel
      const result = await checkForDesktopUpdate({
        currentVersion: version,
        channel: typedChannel,
        origin: UPDATE_ORIGIN,
        request: async () => new Response(JSON.stringify({ version, channel }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      })
      expect(result !== null, `${channel} ${version}`).toBe(expected)
    }
  })
})

/**
 * The client's private parseCanonicalChannelVersion, mirrored here and in
 * scripts/gen-channel-version-vectors.ts: canonical parse (the input must equal
 * its own canonical form) followed by the per-channel prerelease shape.
 */
function isAdmissible(channel: DesktopReleaseChannel, version: string): boolean {
  const parsed = parseSemVer(version)
  if (parsed === null || parsed.version !== version) return false
  return matchesReleaseChannelVersionShape(channel, parsed)
}

describe('download endpoint paths (client side)', () => {
  it('matches the paths update-server serves', () => {
    const urls = desktopDownloadUrls(UPDATE_ORIGIN)

    expect([new URL(urls.darwin).pathname, new URL(urls.win32).pathname])
      .toEqual(['/api/downloads/mac', '/api/downloads/windows'])
  })

  it('requests the artifact for the platform it is downloading for', async () => {
    const outcome = await clientVerdict(
      readFileSync(join(SHAPE_FIXTURES, 'windows-valid.exe')),
      'win32',
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.requestedUrl).toBe(`${UPDATE_ORIGIN}/api/downloads/windows`)
  })
})

describe('installer shape', () => {
  it('pins the shared size cap against the client download constant', () => {
    expect(MAX_UPDATE_DOWNLOAD_BYTES).toBe(SHAPE_MANIFEST.sizeCapBytes)
  })

  it('agrees on every fixture between the server gate and the client validator', async () => {
    expect(SHAPE_MANIFEST.files.length).toBeGreaterThanOrEqual(4)
    for (const file of SHAPE_MANIFEST.files) {
      const bytes = readFileSync(join(SHAPE_FIXTURES, file.name))
      expect(bytes.byteLength, file.name).toBe(file.bytes)
      const outcome = await clientVerdict(bytes, file.platform)
      expect(outcome.ok, `${file.name} (${file.construction})`).toBe(file.shape === 'valid')
      if (!outcome.ok) expect(outcome.code, file.name).toBe('invalid-artifact')
    }
  })

  it('refuses every size the shared fixture marks invalid', async () => {
    for (const vector of SHAPE_MANIFEST.sizeVectors) {
      // The declared length is what the client enforces before it writes
      // anything; update-server's sparse-file test asserts the same numbers
      // against the file itself.
      const outcome = await clientVerdict(Buffer.alloc(Math.min(vector.bytes, 1)), 'win32', vector.bytes)
      expect(outcome.ok, `${String(vector.bytes)} bytes (${vector.reason})`).toBe(vector.expected)
    }
  })
})
