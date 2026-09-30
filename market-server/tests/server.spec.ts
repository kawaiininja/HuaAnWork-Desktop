import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
import { CatalogStore, type CatalogEntry } from '../src/catalog/store.ts'
import type { MarketServerConfig } from '../src/config.ts'
import { MAX_MANIFEST_ENTRIES } from '../src/manifest-prepare.ts'
import { createMarketServer, type MarketHttpServer } from '../src/server.ts'
import { ArtifactStore } from '../src/tarball/store.ts'
import { bootTestMarket, type TestMarket } from './helpers/server.ts'

const KEY_HEX = 'b2'.repeat(32)

function testConfig(dataDir: string): MarketServerConfig {
  return {
    port: 0,
    dataDir,
    publicOrigin: 'http://market.intranet.example:8787',
    verifyPublicKeyPath: '/nonexistent/key.hex',
    verifyPublicKeyHex: KEY_HEX,
    adminToken: 'test-admin-token',
    maxCatalogEntries: MAX_MANIFEST_ENTRIES,
    allowedHosts: ['127.0.0.1'],
    maxConcurrentUploads: 4,
    requestTimeoutMs: 300_000,
    headersTimeoutMs: 60_000,
    socketTimeoutMs: 120_000,
  }
}

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    packageName: `@huaanwork/${id}`,
    version: '1.0.0',
    displayName: `Plugin ${id}`,
    summary: `Sample plugin ${id}`,
    categories: ['utility'],
    updatedAt: '2026-09-25T00:00:00Z',
    ...overrides,
  }
}

describe('market-server HTTP surface', () => {
  let dataDir: string
  let store: CatalogStore
  let artifacts: ArtifactStore
  let market: MarketHttpServer
  let baseUrl: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'market-server-http-'))
    store = await CatalogStore.open(dataDir)
    artifacts = await ArtifactStore.open(dataDir)
    market = createMarketServer(testConfig(dataDir), store, artifacts)
    await new Promise<void>(resolve => market.server.listen(0, '127.0.0.1', resolve))
    const address = market.server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => market.server.close(() => resolve()))
    // P6: release the data directory's single-instance lock.
    await store.close()
  })

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`)
    return { status: response.status, body: await response.json() }
  }

  it('answers /healthz', async () => {
    const { status, body } = await getJson('/healthz')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
  })

  it('serves a self-validated provider page from /v1/plugins', async () => {
    await store.replaceEntries([entry('alpha'), entry('beta')])
    const { status, body } = await getJson('/v1/plugins')
    expect(status).toBe(200)
    expect(() => parseCatalogProviderPage(body)).not.toThrow()
    const page = body as { items: Array<{ id: string }>; page: { total: number } }
    expect(page.items.map(item => item.id)).toEqual(['alpha', 'beta'])
    expect(page.page.total).toBe(2)
  })

  it('parses repeated category params and limit via the contract encoding', async () => {
    await store.replaceEntries([
      entry('alpha', { categories: ['utility'] }),
      entry('gamma', { categories: ['productivity'] }),
    ])
    const orFilter = await getJson('/v1/plugins?category=utility&category=productivity')
    expect((orFilter.body as { page: { total: number } }).page.total).toBe(2)
    const single = await getJson('/v1/plugins?category=productivity')
    expect((single.body as { items: Array<{ id: string }> }).items.map(item => item.id)).toEqual(['gamma'])
    const limited = await getJson('/v1/plugins?limit=1')
    expect((limited.body as { items: unknown[] }).items).toHaveLength(1)
  })

  it('returns 400 for contract-invalid queries', async () => {
    for (const path of ['/v1/plugins?limit=0', '/v1/plugins?limit=201', '/v1/plugins?sort=bogus']) {
      const { status, body } = await getJson(path)
      expect(status, path).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('invalid-query')
    }
  })

  it('returns 400 for a cursor that belongs to a different query', async () => {
    await store.replaceEntries([entry('alpha'), entry('beta'), entry('gamma')])
    const first = await getJson('/v1/plugins?limit=2&sort=name')
    const cursor = (first.body as { page: { nextCursor: string } }).page.nextCursor
    const reused = await getJson(`/v1/plugins?limit=2&sort=updated&cursor=${encodeURIComponent(cursor)}`)
    expect(reused.status).toBe(400)
    expect((reused.body as { error: { code: string } }).error.code).toBe('invalid-cursor')
  })

  it('follows pagination to exhaustion', async () => {
    await store.replaceEntries([entry('a1'), entry('a2'), entry('a3')])
    const seen: string[] = []
    let cursor = ''
    for (;;) {
      const suffix = cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`
      const { body } = await getJson(`/v1/plugins?limit=2${suffix}`)
      const page = body as { items: Array<{ id: string }>; page: { nextCursor?: string } }
      seen.push(...page.items.map(item => item.id))
      if (page.page.nextCursor === undefined) break
      cursor = page.page.nextCursor
    }
    expect(seen).toEqual(['a1', 'a2', 'a3'])
  })

  it('passes through the stored signed manifest verbatim; 404 before activation', async () => {
    const before = await getJson('/v1/manifest')
    expect(before.status).toBe(404)
    expect((before.body as { error: { code: string } }).error.code).toBe('manifest-not-found')
    const signatureNotFound = await getJson('/v1/manifest/signature')
    expect(signatureNotFound.status).toBe(404)
    const signed = { envelope: { domain: 'http://market.intranet.example:8787', revision: 3 }, signature: 'cafe' }
    await store.activate(signed, { signature: 'cafe' }, 3)
    const after = await getJson('/v1/manifest')
    expect(after.status).toBe(200)
    expect(after.body).toEqual(signed)
    const sig = await getJson('/v1/manifest/signature')
    expect(sig.status).toBe(200)
    expect(sig.body).toEqual({ signature: 'cafe' })
  })

  it('serves the admin management page shell without embedding server-side data', async () => {
    const response = await fetch(`${baseUrl}/admin`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('market-server')
    expect(html).toContain('/v1/admin/manifest/prepare')
  })

  it('fully recovers catalog state across a server restart', async () => {
    await store.replaceEntries([entry('alpha', { version: '3.2.1' })])
    await new Promise<void>(resolve => market.server.close(() => resolve()))
    // A restart stops the old instance first: it must release the single-instance
    // lock before the new instance can open the same data directory (P6).
    await store.close()
    const reopenedStore = await CatalogStore.open(dataDir)
    store = reopenedStore
    expect(reopenedStore.entries().map(e => `${e.id}@${e.version}`)).toEqual(['alpha@3.2.1'])
    const reopenedArtifacts = await ArtifactStore.open(dataDir)
    market = createMarketServer(testConfig(dataDir), reopenedStore, reopenedArtifacts)
    await new Promise<void>(resolve => market.server.listen(0, '127.0.0.1', resolve))
    const address = market.server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}`
    const { status, body } = await getJson('/v1/plugins')
    expect(status).toBe(200)
    expect((body as { items: Array<{ latestVersion: string }> }).items[0]?.latestVersion).toBe('3.2.1')
  })

  it('returns 404 for unknown routes and 405 for non-GET methods', async () => {
    expect((await getJson('/nope')).status).toBe(404)
    const post = await fetch(`${baseUrl}/v1/plugins`, { method: 'POST' })
    expect(post.status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// P8: operational hardening (M6 Task 6.5)
//
// Explicit server timeouts (the defect was Node's `timeout = 0`: a stuck
// connection could hold its slots forever), an upload concurrency cap answered
// with an honest 429, and a `Host` allowlist. The brief's premise, verified:
// there is no `headers.host` consumer anywhere in this server today, so the
// allowlist is hygiene (DNS-rebinding / Host-confusion defense in depth), not a
// fix for an exploited path.
// ---------------------------------------------------------------------------

describe('P8 server hardening', () => {
  let market: MarketHttpServer
  let store: CatalogStore
  let dataDir: string
  let port: number
  const extraMarkets: TestMarket[] = []

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'market-server-hardening-'))
    store = await CatalogStore.open(dataDir)
    const artifacts = await ArtifactStore.open(dataDir)
    market = createMarketServer(testConfig(dataDir), store, artifacts)
    await new Promise<void>(resolve => market.server.listen(0, '127.0.0.1', resolve))
    port = (market.server.address() as AddressInfo).port
  })

  afterEach(async () => {
    await Promise.all(extraMarkets.splice(0).map(async (extra) => extra.close()))
    await new Promise<void>(resolve => market.server.close(() => resolve()))
    await store.close()
  })

  /** Raw node:http request, so the test controls the Host header verbatim. */
  function rawGet(path: string, hostHeader: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path, headers: { host: hostHeader } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', reject)
      request.end()
    })
  }

  it('sets explicit request, header and socket timeouts from config', () => {
    // All three must be explicit and non-zero (`server.timeout = 0` means
    // "never", which is what P8 closes).
    expect(market.config.requestTimeoutMs).toBeGreaterThan(0)
    expect(market.config.headersTimeoutMs).toBeGreaterThan(0)
    expect(market.config.socketTimeoutMs).toBeGreaterThan(0)
    expect(market.server.requestTimeout).toBe(market.config.requestTimeoutMs)
    expect(market.server.headersTimeout).toBe(market.config.headersTimeoutMs)
    expect(market.server.timeout).toBe(market.config.socketTimeoutMs)
  })

  it('caps upload concurrency and answers 429 beyond it', async () => {
    const capped = await bootTestMarket({ maxConcurrentUploads: 1 })
    extraMarkets.push(capped)
    const probe = async (): Promise<{ status: number; code: string | null }> => {
      const response = await fetch(`${capped.baseUrl}/v1/admin/artifacts?displayName=Probe&summary=Probe`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/gzip' },
      })
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null
      return { status: response.status, code: body?.error?.code ?? null }
    }
    // Hold the single upload slot with a request whose body never completes.
    const held = http.request({
      host: '127.0.0.1',
      port: Number(new URL(capped.baseUrl).port),
      path: '/v1/admin/artifacts?displayName=Held&summary=Held',
      method: 'POST',
      headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/gzip' },
    })
    held.on('error', () => undefined)
    held.write(Buffer.alloc(64 * 1024)) // partial body: the route is staging

    let captured = { status: 0, code: null as string | null }
    const deadline = Date.now() + 3_000
    while (captured.status !== 429 && Date.now() < deadline) {
      captured = await probe()
      if (captured.status !== 429) await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(captured.status).toBe(429)
    expect(captured.code).toBe('too-many-uploads')

    // Aborting the held upload frees the slot for the next request.
    held.destroy()
    let afterRelease = 429
    const releaseDeadline = Date.now() + 3_000
    while (afterRelease === 429 && Date.now() < releaseDeadline) {
      afterRelease = (await probe()).status
      if (afterRelease === 429) await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(afterRelease).not.toBe(429)
    expect(afterRelease).toBe(400) // the empty body fails the publish gate, not the cap
  })

  it('rejects a Host header outside the allowlist', async () => {
    const rejected = await rawGet('/healthz', 'evil.example:8787')
    expect(rejected.status).toBe(403)
    expect((JSON.parse(rejected.body) as { error: { code: string } }).error.code).toBe('host-not-allowed')
    // The allowlist's own host keeps working, and a bare entry matches any port.
    const accepted = await rawGet('/healthz', `127.0.0.1:${String(port)}`)
    expect(accepted.status).toBe(200)
    expect(accepted.body).toContain('"ok":true')
    const anyPort = await rawGet('/healthz', '127.0.0.1:1')
    expect(anyPort.status).toBe(200)
  })

  it('pins the port when an allowlist entry carries one', async () => {
    const pinnedDir = await mkdtemp(join(tmpdir(), 'market-server-hardening-pinned-'))
    const pinnedStore = await CatalogStore.open(pinnedDir)
    const pinned = createMarketServer(
      { ...testConfig(pinnedDir), allowedHosts: ['127.0.0.1:1'] },
      pinnedStore,
      await ArtifactStore.open(pinnedDir),
    )
    await new Promise<void>(resolve => pinned.server.listen(0, '127.0.0.1', resolve))
    try {
      const actualPort = (pinned.server.address() as AddressInfo).port
      const rejected = await new Promise<number>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: actualPort, path: '/healthz' }, (response) => {
          resolve(response.statusCode ?? 0)
          response.resume()
        })
        request.on('error', reject)
        request.end()
      })
      expect(rejected).toBe(403)
    } finally {
      await new Promise<void>(resolve => pinned.server.close(() => resolve()))
      await pinnedStore.close()
    }
  })
})
