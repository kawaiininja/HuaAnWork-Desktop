import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
import { CatalogStore, type CatalogEntry } from '../src/catalog/store.ts'
import type { MarketServerConfig } from '../src/config.ts'
import { createMarketServer, type MarketHttpServer } from '../src/server.ts'
import { ArtifactStore } from '../src/tarball/store.ts'

const KEY_HEX = 'b2'.repeat(32)

function testConfig(dataDir: string): MarketServerConfig {
  return {
    port: 0,
    dataDir,
    publicOrigin: 'http://market.intranet.example:8787',
    verifyPublicKeyPath: '/nonexistent/key.hex',
    verifyPublicKeyHex: KEY_HEX,
    adminToken: 'test-admin-token',
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
    const reopenedStore = await CatalogStore.open(dataDir)
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
