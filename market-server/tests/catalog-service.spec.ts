import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCatalogProviderPage, parseCatalogQuery, CatalogContractError } from 'dsh-community-market/contracts'
import { CatalogService, CatalogQueryError } from '../src/catalog/service.ts'
import { CatalogStore, type CatalogEntry } from '../src/catalog/store.ts'

const FIXED_NOW = () => new Date('2026-09-26T00:00:00.000Z')

function entry(overrides: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    packageName: `@huaanwork/${overrides.id}`,
    version: '1.0.0',
    displayName: overrides.id,
    summary: `Summary for ${overrides.id}`,
    ...overrides,
  }
}

const ENTRIES: readonly CatalogEntry[] = [
  entry({
    id: 'alpha',
    displayName: 'Alpha Plugin',
    summary: 'First sample plugin',
    categories: ['utility'],
    keywords: ['sample'],
    capabilities: ['host.desktop.market'],
    updatedAt: '2026-09-20T00:00:00Z',
    sha256: 'ab'.repeat(32),
    tarball: 'alpha-1.0.0.tgz',
  }),
  entry({
    id: 'beta',
    version: '2.1.0',
    displayName: 'Beta Plugin',
    summary: 'Second sample plugin',
    categories: ['productivity', 'utility'],
    capabilities: ['host.desktop.market', 'host.desktop.settings'],
    updatedAt: '2026-09-25T00:00:00Z',
  }),
  entry({
    id: 'gamma',
    displayName: 'Gamma Tool',
    summary: 'Third sample',
    categories: ['productivity'],
  }),
]

async function serviceWith(entries: readonly CatalogEntry[]): Promise<CatalogService> {
  const dir = await mkdtemp(join(tmpdir(), 'market-server-catalog-'))
  const store = await CatalogStore.open(dir)
  await store.replaceEntries(entries)
  return new CatalogService(store, { now: FIXED_NOW })
}

describe('CatalogService contract conformance', () => {
  it('returns a page that passes the upstream parseCatalogProviderPage validator', async () => {
    const service = await serviceWith(ENTRIES)
    const page = service.query({})
    // Round-trip through the upstream runtime validator: the response IS a
    // contract CatalogProviderPage (self-validation already ran inside query).
    expect(() => parseCatalogProviderPage(JSON.parse(JSON.stringify(page)))).not.toThrow()
    expect(page.schemaVersion).toBe('1.0.0')
    expect(page.items).toHaveLength(3)
    expect(page.page.total).toBe(3)
    expect(page.page.nextCursor).toBeUndefined()
    const alpha = page.items.find(item => item.id === 'alpha')
    expect(alpha?.package).toEqual({ registry: 'npm', name: '@huaanwork/alpha' })
    expect(alpha?.latestVersion).toBe('1.0.0')
    // private-envelope fields never leak into the contract page
    expect(JSON.stringify(page)).not.toContain('sha256')
    expect(JSON.stringify(page)).not.toContain('tgz')
  })

  it('serves an empty catalog as a valid empty page', async () => {
    const service = await serviceWith([])
    const page = service.query({})
    expect(() => parseCatalogProviderPage(page)).not.toThrow()
    expect(page.items).toHaveLength(0)
    expect(page.page).toEqual({ total: 0 })
  })

  it('filters by q (case-insensitive substring)', async () => {
    const service = await serviceWith(ENTRIES)
    expect(service.query({ q: 'BETA' }).items.map(item => item.id)).toEqual(['beta'])
    expect(service.query({ q: 'sample' }).items).toHaveLength(3)
  })

  it('treats repeated category values as an OR filter', async () => {
    const service = await serviceWith(ENTRIES)
    const page = service.query({ category: ['utility', 'productivity'] })
    expect(page.items).toHaveLength(3)
    expect(service.query({ category: ['productivity'] }).items.map(item => item.id)).toEqual(['beta', 'gamma'])
  })

  it('requires ALL requested capabilities on an item', async () => {
    const service = await serviceWith(ENTRIES)
    expect(service.query({ capability: ['host.desktop.market'] }).items.map(item => item.id)).toEqual(['alpha', 'beta'])
    expect(
      service.query({ capability: ['host.desktop.market', 'host.desktop.settings'] }).items.map(item => item.id),
    ).toEqual(['beta'])
  })

  it('sorts by name, updated, and stable order for relevance/downloads', async () => {
    const service = await serviceWith(ENTRIES)
    expect(service.query({ sort: 'name' }).items.map(item => item.displayName)).toEqual([
      'Alpha Plugin',
      'Beta Plugin',
      'Gamma Tool',
    ])
    expect(service.query({ sort: 'updated' }).items.map(item => item.id)).toEqual(['beta', 'alpha', 'gamma'])
    expect(service.query({ sort: 'downloads' }).items.map(item => item.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('paginates with an opaque cursor scoped to the effective query', async () => {
    const service = await serviceWith(ENTRIES)
    const first = service.query({ limit: 2, sort: 'name' })
    expect(first.items).toHaveLength(2)
    expect(first.page.total).toBe(3)
    const cursor = first.page.nextCursor
    expect(cursor).toBeDefined()
    const second = service.query({ limit: 2, sort: 'name', cursor })
    expect(second.items.map(item => item.id)).toEqual(['gamma'])
    expect(second.page.nextCursor).toBeUndefined()
    // A cursor reused with a different query is rejected (scoped cursor rule).
    expect(() => service.query({ limit: 2, sort: 'updated', cursor })).toThrow(CatalogQueryError)
    expect(() => service.query({ limit: 2, sort: 'updated', cursor })).toThrow(/does not belong/)
  })

  it('rejects an undecodable cursor', async () => {
    const service = await serviceWith(ENTRIES)
    expect(() => service.query({ cursor: '!!!not-base64!!!' })).toThrow(CatalogQueryError)
  })

  it('never returns more items than the effective limit (up to 200)', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      entry({ id: `plugin-${String(index).padStart(3, '0')}` }),
    )
    const service = await serviceWith(many)
    const page = service.query({ limit: 200 })
    expect(page.items).toHaveLength(200)
    expect(() => parseCatalogProviderPage(page)).not.toThrow()
    const rest = service.query({ limit: 200, cursor: page.page.nextCursor })
    expect(rest.items).toHaveLength(50)
  })

  it('rejects contract-invalid queries via the upstream parser', async () => {
    const service = await serviceWith(ENTRIES)
    expect(() => service.query({ limit: 0 })).toThrow(CatalogContractError)
    expect(() => service.query({ limit: 201 })).toThrow(CatalogContractError)
    expect(() => service.query({ sort: 'bogus' })).toThrow(CatalogContractError)
    expect(() => service.query({ limit: 'abc' })).toThrow(CatalogContractError)
    expect(() => service.query({ q: 'x'.repeat(201) })).toThrow(CatalogContractError)
    expect(() => service.query({ category: ['Invalid Category!'] })).toThrow(CatalogContractError)
  })

  it('accepts a query validated by the upstream parseCatalogQuery', async () => {
    const service = await serviceWith(ENTRIES)
    const query = parseCatalogQuery({ q: 'sample', limit: 10, sort: 'updated' })
    const page = service.query(query)
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('stores and passes through the signed manifest verbatim (no signing here)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-catalog-'))
    const store = await CatalogStore.open(dir)
    expect(store.manifest()).toBeNull()
    const signed = { envelope: { revision: 7 }, signature: 'deadbeef', catalog: { packages: [] } }
    await store.setManifest(signed)
    const reopened = await CatalogStore.open(dir)
    expect(reopened.manifest()).toEqual(signed)
  })

  it('rejects structurally invalid stored entries at open time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-catalog-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(dir, 'catalog-state.json'),
      JSON.stringify({ version: 1, entries: [{ id: 'x' }], manifest: null }),
      { mode: 0o600 },
    )
    await expect(CatalogStore.open(dir)).rejects.toThrow(TypeError)
  })
})
