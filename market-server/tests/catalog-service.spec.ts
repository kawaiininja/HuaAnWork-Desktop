import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCatalogProviderPage, parseCatalogQuery, CatalogContractError } from 'dsh-community-market/contracts'
import { CatalogService, CatalogPageEnvelopeError, CatalogQueryError, InvalidStoredCatalogError } from '../src/catalog/service.ts'
import { CatalogStore, type CatalogEntry } from '../src/catalog/store.ts'
import { deadProcessPid } from './helpers/server.ts'

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
    const signed = { envelope: { revision: 7 }, catalog: { items: [] }, files: [] }
    await store.activate(signed, { signature: 'deadbeef' }, 7)
    // A restart releases the previous instance's lock before reopening (P6).
    await store.close()
    const reopened = await CatalogStore.open(dir)
    expect(reopened.manifest()).toEqual(signed)
    expect(reopened.signature()).toEqual({ signature: 'deadbeef' })
    expect(reopened.maxRevision()).toBe(7)
    await reopened.close()
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

// ---------------------------------------------------------------------------
// Read-side per-entry isolation (D3 residual; ruling D-M6-26)
//
// One contract-violating stored entry — the exposure face left after the
// write-side guards (review D3) is an operator hand-editing the state file or
// restoring an old backup — used to fail the WHOLE catalog, because the
// assembled page was validated as a whole. Now every candidate entry is judged
// with the same single-entry validator the write path runs: the violating ones
// are isolated and reported, and only an all-invalid result fails closed (a
// 200 + empty page would tell clients the market is empty).
// ---------------------------------------------------------------------------

/** Control character in displayName: violates the contract's plainText rule. */
const POISONED: CatalogEntry = entry({
  id: 'poisoned',
  displayName: 'bad\u0007name',
  summary: 'A poisoned entry',
})

describe('read-side per-entry isolation (D-M6-26)', () => {
  it('serves the valid entries when one entry violates the contract', async () => {
    const service = await serviceWith([...ENTRIES, POISONED])
    const { page, isolated } = service.queryWithIsolation({})
    expect(page.items.map(item => item.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(page.page.total).toBe(3)
    // The served page is still a contract page: the upstream WHOLE-page
    // validator accepts it, i.e. the isolation is complete rather than partial.
    expect(() => parseCatalogProviderPage(JSON.parse(JSON.stringify(page)))).not.toThrow()
    expect(isolated).toHaveLength(1)
  })

  it('reports which entry was isolated and why, for the operator', async () => {
    const service = await serviceWith([...ENTRIES, POISONED])
    const { isolated } = service.queryWithIsolation({})
    expect(isolated.map(isolatedEntry => isolatedEntry.name)).toEqual(['@huaanwork/poisoned'])
    expect(isolated[0]?.id).toBe('poisoned')
    expect(isolated[0]?.reason).toContain('displayName')
    // A healthy catalog reports nothing (the signal is not background noise).
    expect((await serviceWith(ENTRIES)).queryWithIsolation({}).isolated).toEqual([])
  })

  it('isolates before pagination, so totals and cursors describe what is served', async () => {
    const service = await serviceWith([POISONED, ...ENTRIES])
    const first = service.queryWithIsolation({ limit: 1, sort: 'name' })
    expect(first.page.items.map(item => item.displayName)).toEqual(['Alpha Plugin'])
    expect(first.page.page.total).toBe(3) // the isolated entry is not counted as served
    expect(first.isolated).toHaveLength(1)
    const second = service.queryWithIsolation({ limit: 1, sort: 'name', cursor: first.page.page.nextCursor })
    expect(second.page.items.map(item => item.displayName)).toEqual(['Beta Plugin'])
    const third = service.queryWithIsolation({ limit: 1, sort: 'name', cursor: second.page.page.nextCursor })
    expect(third.page.items.map(item => item.displayName)).toEqual(['Gamma Tool'])
    expect(third.page.page.nextCursor).toBeUndefined()
  })

  it('judges only the entries the effective query would serve', async () => {
    const service = await serviceWith([...ENTRIES, POISONED])
    const matched = service.queryWithIsolation({ q: 'alpha' })
    expect(matched.page.items.map(item => item.id)).toEqual(['alpha'])
    // The poisoned entry does not match this query, so nothing was isolated
    // from THIS response (the signal describes the response, not the state).
    expect(matched.isolated).toEqual([])
    // A query that matches nothing is an empty result, not an isolation
    // failure: it must not be turned into the fail-closed arm.
    const none = service.queryWithIsolation({ q: 'no-such-plugin' })
    expect(none.page.items).toEqual([])
    expect(none.isolated).toEqual([])
  })

  it('fails closed when every matching entry violates the contract (no 200 + empty page)', async () => {
    const service = await serviceWith([POISONED])
    const outcome = ((): unknown => {
      try {
        return service.queryWithIsolation({})
      } catch (cause) {
        return cause
      }
    })()
    expect(outcome).toBeInstanceOf(InvalidStoredCatalogError)
    const error = outcome as InvalidStoredCatalogError
    expect(error.isolated).toHaveLength(1)
    expect(error.isolated[0]?.name).toBe('@huaanwork/poisoned')
    // The convenience wrapper fails closed the same way (callers cannot get an
    // empty page out of this state by using it).
    expect(() => service.query({})).toThrow(InvalidStoredCatalogError)
  })
})

// ---------------------------------------------------------------------------
// Page-envelope guard (Task 6.7 fix round 1)
//
// Per-entry isolation must not be the only guard: the per-entry validator says
// nothing about the page ENVELOPE, whose `page.nextCursor` is capped at 2048
// characters by the upstream schema. This service's cursor is the base64url of
// the normalized effective query key, and the query schema permits q (200
// chars) + 20 categories (64 chars each) + 32 capabilities (96 chars each), so
// a legal request can need a longer cursor. The assembled page is therefore
// validated as a WHOLE again after the per-entry pass; a page the contract
// rejects fails closed as a request-level refusal (CatalogPageEnvelopeError) —
// never a 200 carrying a schema-violating payload, and never blamed on stored
// state.
// ---------------------------------------------------------------------------

describe('page-envelope guard (Task 6.7 fix round 1)', () => {
  /** q at its 200-character bound; both entries carry it in their summary. */
  const BIG_Q = 'x'.repeat(200)
  /** 20 distinct category ids at their 64-character bound (the query maxItems). */
  const BIG_CATEGORIES = Array.from(
    { length: 20 },
    (_, index) => `${String.fromCharCode(97 + index)}${'a'.repeat(63)}`,
  )

  async function serviceWithOversizedQuery(): Promise<CatalogService> {
    return serviceWith([
      entry({ id: 'big-one', summary: `${BIG_Q} first`, categories: [BIG_CATEGORIES[0]!] }),
      entry({ id: 'big-two', summary: `${BIG_Q} second`, categories: [BIG_CATEGORIES[0]!] }),
    ])
  }

  it('fails closed when the effective query is too large to carry a contract-valid cursor', async () => {
    const service = await serviceWithOversizedQuery()
    const query = { q: BIG_Q, category: BIG_CATEGORIES, limit: 1 }

    // Premise check: the cursor this query needs really exceeds the contract
    // cap (base64url of the normalized query key).
    const normalizedKey = JSON.stringify({ q: BIG_Q, category: BIG_CATEGORIES, limit: 1 })
    const cursorLength = Buffer.from(
      JSON.stringify({ v: 1, o: 1, k: normalizedKey }),
      'utf8',
    ).toString('base64url').length
    expect(cursorLength).toBeGreaterThan(2048)

    // The same query is legal and servable when no cursor is needed: the
    // envelope guard must not fire for the entries themselves.
    const whole = service.queryWithIsolation({ q: BIG_Q, category: BIG_CATEGORIES, limit: 2 })
    expect(whole.page.items).toHaveLength(2)
    expect(whole.isolated).toEqual([])

    const outcome = ((): unknown => {
      try {
        return service.queryWithIsolation(query)
      } catch (cause) {
        return cause
      }
    })()
    // The honest fail-closed outcome: a request-level envelope refusal, NOT a
    // stored-state fault (and definitely not a 200 with a bad payload).
    expect(outcome).toBeInstanceOf(CatalogPageEnvelopeError)
    expect(outcome).not.toBeInstanceOf(InvalidStoredCatalogError)
    const error = outcome as CatalogPageEnvelopeError
    expect(error.cursorOverflow).toBe(true)
    expect(error.issues.map(issue => issue.path)).toEqual(['/page/nextCursor'])
    expect(error.message).toContain('2048')
    expect(error.message).toContain('narrow q/category/capability')
    expect(error.message).toContain('the stored catalog is not at fault')
    expect(error.isolated).toEqual([])
    // The convenience wrapper fails closed the same way.
    expect(() => service.query(query)).toThrow(CatalogPageEnvelopeError)
  })
})

// ---------------------------------------------------------------------------
// P6: single-instance guard (M6 Task 6.5)
//
// A second instance against the same data directory (or a state JSON restored
// while another instance is running) silently serves stale state. `<dataDir>/
// server.lock` records the holding pid + start time; a second instance fails at
// startup with an honest error naming the holder. A lock whose recorded owner is
// gone (crashed process) is taken over atomically, so restarts keep working.
// ---------------------------------------------------------------------------

describe('P6 single instance guard', () => {
  it('refuses a second instance against the same data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-instance-'))
    const first = await CatalogStore.open(dir)
    try {
      const failure = await CatalogStore.open(dir).then(() => null, (cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).name).toBe('InstanceLockError')
      // The refusal leaves the holding instance's lock in place.
      const recorded = JSON.parse(await readFile(join(dir, 'server.lock'), 'utf8')) as { pid: number }
      expect(recorded.pid).toBe(process.pid)
    } finally {
      await first.close()
    }
  })

  it('reports the holding pid so the operator can act', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-instance-'))
    const first = await CatalogStore.open(dir)
    try {
      const lockFile = join(dir, 'server.lock')
      const recorded = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number; startedAt: number }
      expect(recorded.pid).toBe(process.pid)
      expect(recorded.startedAt).toBeGreaterThan(0)

      const failure = await CatalogStore.open(dir).then(() => null, (cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      const error = failure as Error & { holderPid?: number | null; lockPath?: string }
      expect(error.holderPid).toBe(process.pid)
      expect(error.lockPath).toBe(lockFile)
      expect(error.message).toContain('server.lock')
      expect(error.message).toContain(`pid ${String(process.pid)}`)
    } finally {
      await first.close()
    }
  })

  it('refuses a second instance with an honest error when the lock names no process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-instance-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'server.lock'), '{ not a lock record', { mode: 0o600 })
    const failure = await CatalogStore.open(dir).then(() => null, (cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).name).toBe('InstanceLockError')
    expect((failure as Error).message).toContain('server.lock')
  })

  it('takes the lock over when the previous holder is gone (crash recovery)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-instance-'))
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'server.lock'),
      `${JSON.stringify({ pid: await deadProcessPid(), startedAt: Date.now() - 60_000, token: 'crashed-instance' })}\n`,
      { mode: 0o600 },
    )
    const store = await CatalogStore.open(dir)
    // The lock now names THIS process, not the crashed one.
    const recorded = JSON.parse(await readFile(join(dir, 'server.lock'), 'utf8')) as { pid: number }
    expect(recorded.pid).toBe(process.pid)
    const failed = await CatalogStore.open(dir).then(() => null, (cause: unknown) => cause)
    expect(failed).toBeInstanceOf(Error) // the takeover holder is alive → refused
    await store.close()
  })

  it('releases the lock on close, so the directory can be opened again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-server-instance-'))
    const first = await CatalogStore.open(dir)
    await first.close()
    await expect(readFile(join(dir, 'server.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const reopened = await CatalogStore.open(dir)
    await reopened.close()
  })
})
