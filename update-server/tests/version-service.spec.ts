/**
 * Task 3.2: GET /api/desktop/version and the read-only channel-record store.
 *
 * Channel records are seeded here by hand in the pinned UpdateChannelRecord
 * shape: publish-release.mjs (Task 3.3) does not exist yet, and when it lands
 * it will drive exactly this record shape. Artifact bytes are written to the
 * data directory and hashed from disk, so the sha256 assertions compare the
 * response against real bytes rather than against a copied literal.
 *
 * Every HTTP test boots the real server through tests/helpers/server.ts, whose
 * Host whitelist keeps the production Host gate satisfied.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InvalidHeaderValueError, readVersionRequestHeaders } from '../src/version/service.ts'
import type { UpdateChannelRecord } from '../src/version/store.ts'
import { bootTestUpdateServer, type TestUpdateServer } from './helpers/server.ts'

const MAC_BYTES = Buffer.from('HuaAnWork 0.2.0 mac universal dmg fixture bytes (Task 3.2)\n', 'utf8')
const WINDOWS_BYTES = Buffer.from('HuaAnWork 0.2.0 windows x64 nsis fixture bytes (Task 3.2)\n', 'utf8')
const PUBLISHED_AT = '2026-09-28T08:00:00.000Z'

const bootedServers: TestUpdateServer[] = []

async function boot(options: { readonly dataDir?: string } = {}): Promise<TestUpdateServer> {
  const booted = await bootTestUpdateServer(options)
  bootedServers.push(booted)
  return booted
}

afterEach(async () => {
  // The restart test closes its first server explicitly; a second close only
  // rejects with ERR_SERVER_NOT_RUNNING and must not fail the suite.
  await Promise.all(bootedServers.splice(0).map(booted => booted.close().catch(() => undefined)))
})

async function writeArtifact(dataDir: string, filename: string, bytes: Buffer): Promise<string> {
  const artifactsDir = join(dataDir, 'artifacts')
  await mkdir(artifactsDir, { recursive: true })
  const path = join(artifactsDir, filename)
  await writeFile(path, bytes)
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function seedRecord(dataDir: string, channel: string, record: unknown): Promise<void> {
  const channelsDir = join(dataDir, 'channels')
  await mkdir(channelsDir, { recursive: true })
  await writeFile(join(channelsDir, `${channel}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

/** Publish a mac-only huaanwork release and return the on-disk artifact sha256. */
async function seedHuaanworkRelease(dataDir: string, version = '0.2.0'): Promise<string> {
  const filename = `HuaAnWork-${version}-universal.dmg`
  const sha256 = await writeArtifact(dataDir, filename, MAC_BYTES)
  const record: UpdateChannelRecord = {
    version,
    publishedAt: PUBLISHED_AT,
    artifacts: { mac: { filename, sha256, bytes: MAC_BYTES.byteLength } },
  }
  await seedRecord(dataDir, 'huaanwork', record)
  return sha256
}

async function getVersion(
  booted: TestUpdateServer,
  headers: Record<string, string> = {},
): Promise<{ readonly response: Response; readonly status: number; readonly text: string; readonly body: unknown }> {
  const response = await fetch(`${booted.origin}/api/desktop/version`, {
    headers,
    redirect: 'manual',
  })
  const text = await response.text()
  return { response, status: response.status, text, body: JSON.parse(text) as unknown }
}

/** Raw request bytes straight onto the socket; the Host header is not settable via fetch. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    socket.on('connect', () => socket.write(request))
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

describe('GET /api/desktop/version', () => {
  it('echoes the published huaanwork version together with its channel label', async () => {
    const booted = await boot()
    const sha256 = await seedHuaanworkRelease(booted.dataDir)

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(response.status).toBe(200)
    expect(response.response.headers.get('content-type')).toContain('application/json')
    expect(response.body).toEqual({ version: '0.2.0', channel: 'huaanwork', sha256: { mac: sha256 } })
  })

  it('never redirects (the client uses redirect:"error")', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)

    const response = await fetch(`${booted.origin}/api/desktop/version`, {
      headers: { 'X-DSH-Desktop-Channel': 'huaanwork' },
      redirect: 'manual',
    })

    expect(response.status).toBe(200)
    expect(response.status).toBeLessThan(300)
  })

  it('keeps the body far below the client-side 4 KiB cap', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(response.text.length).toBeLessThan(4 * 1024)
  })

  it('answers each channel independently', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir, '0.2.0')
    // stable ships windows only and beta carries a prerelease version, so a
    // cross-wired answer would also show the other channel's platform map or
    // reject the version shape.
    const windowsFilename = 'DSH-Desktop-Setup-2.0.4.exe'
    const windowsSha256 = await writeArtifact(booted.dataDir, windowsFilename, WINDOWS_BYTES)
    await seedRecord(booted.dataDir, 'stable', {
      version: '2.0.4',
      publishedAt: PUBLISHED_AT,
      artifacts: { windows: { filename: windowsFilename, sha256: windowsSha256, bytes: WINDOWS_BYTES.byteLength } },
    })
    const betaFilename = 'DSH-Desktop-2.0.6-beta.1-universal.dmg'
    const betaSha256 = await writeArtifact(booted.dataDir, betaFilename, MAC_BYTES)
    await seedRecord(booted.dataDir, 'beta', {
      version: '2.0.6-beta.1',
      publishedAt: PUBLISHED_AT,
      artifacts: { mac: { filename: betaFilename, sha256: betaSha256, bytes: MAC_BYTES.byteLength } },
    })

    const huaanwork = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })
    const stable = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'stable' })
    const beta = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'beta' })

    expect(huaanwork.body).toMatchObject({ version: '0.2.0', channel: 'huaanwork' })
    expect(stable.body).toMatchObject({ version: '2.0.4', channel: 'stable', sha256: { windows: windowsSha256 } })
    expect((stable.body as { sha256: Record<string, string> }).sha256).not.toHaveProperty('mac')
    expect(beta.body).toMatchObject({ version: '2.0.6-beta.1', channel: 'beta', sha256: { mac: betaSha256 } })
  })

  it('carries per-platform artifact sha256 recorded at publish time (D-M6-23)', async () => {
    const booted = await boot()
    const macSha256 = await seedHuaanworkRelease(booted.dataDir)

    const macOnly = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })
    const macOnlyHashes = (macOnly.body as { sha256: Record<string, string> }).sha256
    expect(macOnlyHashes.mac).toBe(macSha256)
    // An unpublished platform must be absent - never an empty string or a placeholder.
    expect('windows' in macOnlyHashes).toBe(false)

    const windowsFilename = 'HuaAnWork-0.2.0-setup.exe'
    const windowsSha256 = await writeArtifact(booted.dataDir, windowsFilename, WINDOWS_BYTES)
    await seedRecord(booted.dataDir, 'huaanwork', {
      version: '0.2.0',
      publishedAt: PUBLISHED_AT,
      artifacts: {
        mac: { filename: 'HuaAnWork-0.2.0-universal.dmg', sha256: macSha256, bytes: MAC_BYTES.byteLength },
        windows: { filename: windowsFilename, sha256: windowsSha256, bytes: WINDOWS_BYTES.byteLength },
      },
    })

    const bothPlatforms = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })
    expect((bothPlatforms.body as { sha256: Record<string, string> }).sha256)
      .toEqual({ mac: macSha256, windows: windowsSha256 })
  })

  it('returns 404 unknown-channel for a channel this product does not ship', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'nightly' })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: { code: 'unknown-channel', message: expect.any(String) } })
  })

  it('returns 404 unknown-channel when the header is absent', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)

    const response = await getVersion(booted)

    // Falling back to stable would silently hand a misconfigured client another
    // channel's artifacts.
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: { code: 'unknown-channel', message: expect.any(String) } })
  })

  it('returns 404 no-release when the channel has nothing published', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'beta' })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: { code: 'no-release', message: expect.any(String) } })
  })

  it('records the installed version header without letting it change the answer', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)
    const installationId = 'd3aa0dd0-1f5b-4f2e-9a37-6f4a2f2b7c31'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const response = await getVersion(booted, {
        'X-DSH-Desktop-Channel': 'huaanwork',
        'X-DSH-Desktop-Version': '99.0.0',
        'X-DSH-Desktop-Installation-Id': installationId,
      })

      // The comparison is the client's job (update-checker.ts); the server must
      // not decide "you are up to date" and must not dedupe by installation id.
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ version: '0.2.0' })
      expect(logSpy.mock.calls.flat().join(' ')).toContain(installationId)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('rejects a header value carrying CRLF or another control character rather than echoing or logging it', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir)

    // A CRLF-carrying value cannot reach any handler: fetch refuses to build it
    // (undici throws), and the same bytes on a raw socket are indistinguishable
    // from two separate header lines, which llhttp parses as such. HTAB is the
    // control character that can actually reach a header value over HTTP, so the
    // end-to-end pin uses it; the guard rejects the whole C0 class, and the
    // literal "huaanwork\r\nX-Injected: 1" value is pinned in the unit test below.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork\tX-Injected: 1' })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: { code: 'invalid-header', message: expect.any(String) } })
      expect(response.response.headers.get('x-injected')).toBeNull()
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('X-Injected')
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('version request headers (defense in depth)', () => {
  it('rejects any client header value carrying CR, LF, or another control character', () => {
    expect(() => readVersionRequestHeaders({ 'x-dsh-desktop-channel': 'huaanwork\r\nX-Injected: 1' }))
      .toThrow(InvalidHeaderValueError)
    expect(() => readVersionRequestHeaders({ 'x-dsh-desktop-channel': 'huaanwork\u0000' }))
      .toThrow(InvalidHeaderValueError)
    expect(() => readVersionRequestHeaders({ 'x-dsh-desktop-version': '0.1.0\u007f' }))
      .toThrow(InvalidHeaderValueError)
    expect(() => readVersionRequestHeaders({ 'x-dsh-desktop-installation-id': 'a\tb' }))
      .toThrow(InvalidHeaderValueError)
  })

  it('reads the three client headers when they are clean', () => {
    expect(readVersionRequestHeaders({
      'x-dsh-desktop-channel': 'huaanwork',
      'x-dsh-desktop-version': '0.1.0',
      'x-dsh-desktop-installation-id': 'abc-123',
    })).toEqual({ channel: 'huaanwork', installedVersion: '0.1.0', installationId: 'abc-123' })
  })
})

describe('channel record store (read-only)', () => {
  it('reads a record written externally by the publish script', async () => {
    const booted = await boot()
    const sha256 = await seedHuaanworkRelease(booted.dataDir)

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(response.body).toEqual({ version: '0.2.0', channel: 'huaanwork', sha256: { mac: sha256 } })
  })

  it('survives a restart because it holds no state of its own', async () => {
    const first = await boot()
    const sha256 = await seedHuaanworkRelease(first.dataDir)
    const before = await getVersion(first, { 'X-DSH-Desktop-Channel': 'huaanwork' })
    await first.close()

    const second = await boot({ dataDir: first.dataDir })
    const after = await getVersion(second, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(after.body).toEqual(before.body)
    expect(after.body).toEqual({ version: '0.2.0', channel: 'huaanwork', sha256: { mac: sha256 } })
  })

  it('reflects an external republish on the very next request (no in-memory cache)', async () => {
    const booted = await boot()
    await seedHuaanworkRelease(booted.dataDir, '0.2.0')
    const before = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })
    expect(before.body).toMatchObject({ version: '0.2.0' })

    const republishedSha256 = await seedHuaanworkRelease(booted.dataDir, '0.3.0')
    const after = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(after.body).toEqual({ version: '0.3.0', channel: 'huaanwork', sha256: { mac: republishedSha256 } })
  })

  it('fails closed on a corrupt record instead of reporting no update', async () => {
    const booted = await boot()

    const cases: readonly (readonly [string, unknown])[] = [
      ['a missing version', { publishedAt: PUBLISHED_AT, artifacts: {} }],
      ['a sha256 that is not 64 lowercase hex characters', {
        version: '0.2.0',
        publishedAt: PUBLISHED_AT,
        artifacts: { mac: { filename: 'x.dmg', sha256: 'NOT-A-SHA256', bytes: MAC_BYTES.byteLength } },
      }],
      ['an unknown artifact platform', {
        version: '0.2.0',
        publishedAt: PUBLISHED_AT,
        artifacts: { linux: { filename: 'x.AppImage', sha256: 'a'.repeat(64), bytes: 1 } },
      }],
    ]

    for (const [label, record] of cases) {
      await seedRecord(booted.dataDir, 'huaanwork', record)
      const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })
      expect(response.status, label).toBe(500)
      expect(response.body, label).toEqual({ error: { code: 'corrupt-channel-record', message: expect.any(String) } })
    }
  })

  it('fails closed on a record that is not even JSON', async () => {
    const booted = await boot()
    const channelsDir = join(booted.dataDir, 'channels')
    await mkdir(channelsDir, { recursive: true })
    await writeFile(join(channelsDir, 'huaanwork.json'), '')

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: { code: 'corrupt-channel-record', message: expect.any(String) } })
  })

  it('rejects a record whose version shape does not match its channel', async () => {
    const booted = await boot()
    await seedRecord(booted.dataDir, 'huaanwork', {
      // publish-release.mjs (Task 3.3) rejects this first, but the server must
      // re-check: the record file can be edited by hand on the deploy host.
      version: '0.2.0-beta.1',
      publishedAt: PUBLISHED_AT,
      artifacts: {},
    })

    const response = await getVersion(booted, { 'X-DSH-Desktop-Channel': 'huaanwork' })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: { code: 'corrupt-channel-record', message: expect.any(String) } })
  })
})

describe('http skeleton pinning (Task 3.1 review minor #3)', () => {
  it('answers GET /healthz with 200', async () => {
    const booted = await boot()

    const response = await fetch(`${booted.origin}/healthz`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('answers an unknown route with 404', async () => {
    const booted = await boot()

    const response = await fetch(`${booted.origin}/nope`)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not-found', message: expect.any(String) } })
  })

  it('answers a non-GET method on the version endpoint with 405', async () => {
    const booted = await boot()

    const response = await fetch(`${booted.origin}/api/desktop/version`, { method: 'POST' })

    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: { code: 'method-not-allowed', message: expect.any(String) } })
  })

  it('rejects a foreign Host header with 403', async () => {
    const booted = await boot()

    const raw = await rawRequest(
      booted.server.port,
      `GET /api/desktop/version HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    )

    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden')
    expect(raw).toContain('host-not-allowed')
  })
})
