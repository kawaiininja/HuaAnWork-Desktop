import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMarketServer, type MarketHttpServer } from '../src/server.ts'
import { CatalogStore } from '../src/catalog/store.ts'
import type { MarketServerConfig } from '../src/config.ts'
import { ArtifactStore, artifactFileName } from '../src/tarball/store.ts'
import { cleanPackageManifest, buildTgz } from './helpers/tar.ts'

const KEY_HEX = 'b2'.repeat(32)

describe('artifact hosting round-trip', () => {
  let dataDir: string
  let store: CatalogStore
  let artifacts: ArtifactStore
  let market: MarketHttpServer
  let baseUrl: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'market-server-artifacts-'))
    store = await CatalogStore.open(dataDir)
    artifacts = await ArtifactStore.open(dataDir)
    const config: MarketServerConfig = {
      port: 0,
      dataDir,
      publicOrigin: 'http://market.intranet.example:8787',
      verifyPublicKeyPath: '/nonexistent/key.hex',
      verifyPublicKeyHex: KEY_HEX,
      adminToken: 'test-admin-token',
    }
    market = createMarketServer(config, store, artifacts)
    await new Promise<void>(resolve => market.server.listen(0, '127.0.0.1', resolve))
    const address = market.server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => market.server.close(() => resolve()))
  })

  it('streams the stored bytes back with a content-derived name and matching sha256', async () => {
    const bytes = buildTgz(cleanPackageManifest())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const fileName = artifactFileName('@huaanwork/sample-plugin', '1.2.3', sha256)
    await artifacts.writeBytes(fileName, bytes)

    const response = await fetch(`${baseUrl}/artifacts/${fileName}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/gzip')
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
    const downloaded = Buffer.from(await response.arrayBuffer())
    expect(downloaded.equals(bytes)).toBe(true)
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(sha256)
  })

  it('404s unknown artifact names and unsafe path segments', async () => {
    const missing = await fetch(`${baseUrl}/artifacts/nope-1.0.0-deadbeefdead.tgz`)
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('artifact-not-found')

    const traversal = await fetch(`${baseUrl}/artifacts/..%2Fcatalog-state.json`)
    expect(traversal.status).toBe(404)
    const literal = await fetch(`${baseUrl}/artifacts/..%2F..%2Fetc%2Fpasswd`)
    expect(literal.status).toBe(404)

    // Malformed percent-encoding must not escape as a 500 with a stack (P2).
    for (const bad of ['/artifacts/%zz', '/artifacts/%2', '/artifacts/%']) {
      const malformed = await fetch(`${baseUrl}${bad}`)
      expect(malformed.status, bad).toBe(404)
      expect(((await malformed.json()) as { error: { code: string } }).error.code, bad).toBe('artifact-not-found')
    }
  })

  it('rejects a re-upload whose claimed sha256 does not match the bytes (corrupt tarball guard)', async () => {
    const bytes = buildTgz(cleanPackageManifest())
    const wrong = createHash('sha256').update(Buffer.from('other bytes')).digest('hex')
    const params = new URLSearchParams({ displayName: 'Sample', summary: 'x', sha256: wrong })
    const response = await fetch(`${baseUrl}/v1/admin/artifacts?${params.toString()}`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/gzip' },
      body: bytes,
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('sha256-mismatch')
    // Nothing staged behind.
    expect((await artifacts.stat('.upload-1-1.tmp'))).toBeNull()
  })

  it('accepts a re-upload whose claimed sha256 matches the bytes', async () => {
    const bytes = buildTgz(cleanPackageManifest())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const params = new URLSearchParams({ displayName: 'Sample', summary: 'Sample plugin', sha256 })
    const response = await fetch(`${baseUrl}/v1/admin/artifacts?${params.toString()}`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/gzip' },
      body: bytes,
    })
    expect(response.status).toBe(201)
    const body = await response.json() as { entry: { id: string; tarball: string }; sha256: string }
    expect(body.sha256).toBe(sha256)
    const hosted = await fetch(`${baseUrl}/artifacts/${body.entry.tarball}`)
    expect(hosted.status).toBe(200)
  })

  it('stages/uploads stream (Readable bodies are consumed incrementally)', async () => {
    const bytes = buildTgz(cleanPackageManifest())
    const staged = await artifacts.stage(Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]))
    expect(staged.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    await artifacts.discard(staged.tempName)
  })
})
