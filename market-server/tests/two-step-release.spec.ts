import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
import { intakeSignature, preparePendingManifest } from '../src/manifest-prepare.ts'
import { CatalogService } from '../src/catalog/service.ts'
import { MAX_ENVELOPE_TTL_MS, signManifest, type MarketManifest } from '../src/signing.ts'
import { adminHeaders, bootTestMarket, publishTgz, PUBLIC_ORIGIN, type TestMarket } from './helpers/server.ts'
import { cleanPackageManifest } from './helpers/tar.ts'

const execFileAsync = promisify(execFile)

function envelopeOf(manifest: unknown): { domain: string; revision: number; issuedAt: string; notAfter: string } {
  return (manifest as { envelope: { domain: string; revision: number; issuedAt: string; notAfter: string } }).envelope
}

describe('two-step offline-signed release flow', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  async function signOffline(manifest: unknown, slot: 1 | 2 = 1): Promise<Record<string, unknown>> {
    const signedAt = new Date().toISOString()
    return signManifest(manifest as MarketManifest, {
      privateKeyPem: market.key.privateKeyPem,
      slot,
      signedAt,
    }) as unknown as Record<string, unknown>
  }

  async function postSignature(record: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${market.baseUrl}/v1/admin/manifest/signature`, {
      method: 'POST',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify(record),
    })
    return { status: response.status, body: await response.json() }
  }

  async function prepare(): Promise<unknown> {
    const response = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { pendingManifest: unknown }).pendingManifest
  }

  it('prepares a canonical pending manifest: domain = configured origin, monotonic revision, TTL = 7d', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await prepare()
    const envelope = envelopeOf(pending)
    expect(envelope.domain).toBe(PUBLIC_ORIGIN)
    expect(envelope.revision).toBe(1)
    const ttl = Date.parse(envelope.notAfter) - Date.parse(envelope.issuedAt)
    expect(ttl).toBe(MAX_ENVELOPE_TTL_MS)

    // catalog payload alone is provider-page valid; files carry the sha manifest
    expect(() => parseCatalogProviderPage((pending as { catalog: unknown }).catalog)).not.toThrow()
    const files = (pending as { files: Array<{ name: string; version: string; sha256: string; tarballPath: string; size: number }> }).files
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('@huaanwork/sample-plugin')
    expect(files[0]?.tarballPath).toMatch(/^\/artifacts\//u)
  })

  it('fail-closed: an unsigned pending manifest NEVER activates', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    await prepare()
    const manifest = await fetch(`${market.baseUrl}/v1/manifest`)
    expect(manifest.status).toBe(404)
    const signature = await fetch(`${market.baseUrl}/v1/manifest/signature`)
    expect(signature.status).toBe(404)
  })

  it('activates only after a valid signature; sha256 in the manifest matches the hosted .tgz bytes', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await prepare()
    const record = await signOffline(pending)

    const intake = await postSignature(record)
    expect(intake.status).toBe(200)
    expect(intake.body).toEqual({ activated: true, revision: 1, slot: 1 })

    // The served manifest is byte-identical to what was signed; the sidecar
    // is served separately.
    const served = await (await fetch(`${market.baseUrl}/v1/manifest`)).json()
    expect(served).toEqual(pending)
    const servedSignature = await (await fetch(`${market.baseUrl}/v1/manifest/signature`)).json()
    expect(servedSignature).toEqual(record)

    // The manifest sha256 matches the ACTUAL hosted artifact bytes.
    const files = (served as { files: Array<{ sha256: string; tarballPath: string }> }).files
    const downloaded = Buffer.from(
      await (await fetch(`${market.baseUrl}${files[0]!.tarballPath}`)).arrayBuffer(),
    )
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(files[0]!.sha256)

    // The pending slot is consumed; state reports the activation.
    const pendingAfter = await fetch(`${market.baseUrl}/v1/admin/manifest/pending`, { headers: adminHeaders('test-admin-token') })
    expect(pendingAfter.status).toBe(404)
    const state = (await (await fetch(`${market.baseUrl}/v1/admin/state`, { headers: adminHeaders('test-admin-token') })).json()) as {
      active: boolean
      activeRevision: number
      maxRevision: number
    }
    expect(state).toMatchObject({ active: true, activeRevision: 1, maxRevision: 1 })
  })

  it('end-to-end with the REAL offline tool (scripts/sign-manifest.mjs), private key never touching the server', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await prepare()
    const dir = await mkdtemp(join(tmpdir(), 'market-server-offline-sign-'))
    const manifestPath = join(dir, 'pending.json')
    const keyPath = join(dir, 'signing-key.pem')
    await writeFile(manifestPath, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 })
    await writeFile(keyPath, market.key.privateKeyPem, { mode: 0o600 })

    await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/sign-manifest.mjs', '--manifest', manifestPath, '--key', keyPath, '--slot', '1'],
      { cwd: join(import.meta.dirname, '..') },
    )
    const { readFile } = await import('node:fs/promises')
    const record = JSON.parse(await readFile(`${manifestPath}.sig.json`, 'utf8')) as Record<string, unknown>

    const intake = await postSignature(record)
    expect(intake.status).toBe(200)
    expect(intake.body).toMatchObject({ activated: true, revision: 1 })
  })

  it('rejects a tampered signature and never activates', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await prepare()
    const record = await signOffline(pending)
    record.signature = Buffer.from('tampered-bytes-tampered-bytes-tampered-bytes-tampe').toString('base64')

    const intake = await postSignature(record)
    expect(intake.status).toBe(400)
    expect(intake.body).toEqual({ activated: false, reason: 'invalid-signature' })
    expect((await fetch(`${market.baseUrl}/v1/manifest`)).status).toBe(404)
  })

  it('rejects a signature made over a DIFFERENT (operator-tampered) manifest', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await prepare()
    const tampered = {
      ...(pending as Record<string, unknown>),
      files: [{ name: 'evil', version: '9.9.9', sha256: 'f'.repeat(64), tarballPath: '/artifacts/evil.tgz', size: 1 }],
    }
    const record = await signOffline(tampered)
    const intake = await postSignature(record)
    expect(intake.status).toBe(400)
    expect((intake.body as { reason: string }).reason).toBe('invalid-signature')
    expect((await fetch(`${market.baseUrl}/v1/manifest`)).status).toBe(404)
  })

  it('rejects envelope negatives at intake: revision regression, expired, domain mismatch', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const base = await prepare() as MarketManifest

    const sign = (manifest: MarketManifest): Promise<Record<string, unknown>> => signOffline(manifest)

    // First activation advances the persisted max revision to 1; a second
    // full release cycle advances it to 2 (idempotent same-revision re-reads
    // are accepted since the 2026-09-26 ruling, so a genuinely OLDER pending
    // is required to exercise revision-regression — spec §14 第十轮 第 49 条).
    const first = await sign(base)
    expect((await postSignature(first)).status).toBe(200)
    const second = await prepare()
    expect(envelopeOf(second).revision).toBe(2)
    expect((await postSignature(await sign(second as MarketManifest))).status).toBe(200)
    const regression = await sign({ ...base }) // same revision 1 signed again
    const regressionResult = await postSignature(regression)
    // After activation there is no pending manifest left, so the honest verdict is no-pending-manifest;
    // the revision check itself is proven against a seeded pending below (direct intake).
    expect(regressionResult.status).toBe(400)

    // Direct intake proof of the three envelope negatives (same code path the route calls).
    const now = Date.now()
    const regressionPending: MarketManifest = {
      ...base,
      envelope: { ...base.envelope, revision: 1, issuedAt: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 60_000).toISOString() },
    }
    await market.store.setPendingManifest(regressionPending)
    const regressionVerdict = await intakeSignature({
      store: market.store,
      config: market.config,
      signatureRecord: await sign(regressionPending),
      nowMs: now,
    })
    expect(regressionVerdict).toEqual({ ok: false, reason: 'revision-regression' })

    const expiredPending: MarketManifest = {
      ...base,
      envelope: { ...base.envelope, revision: 2, issuedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), notAfter: new Date(now - 60_000).toISOString() },
    }
    await market.store.setPendingManifest(expiredPending)
    const expiredVerdict = await intakeSignature({
      store: market.store,
      config: market.config,
      signatureRecord: await sign(expiredPending),
      nowMs: now,
    })
    expect(expiredVerdict).toEqual({ ok: false, reason: 'expired' })

    const foreignDomainPending: MarketManifest = {
      ...base,
      envelope: { ...base.envelope, revision: 2, domain: 'http://evil.intranet.example:9999', issuedAt: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 60_000).toISOString() },
    }
    await market.store.setPendingManifest(foreignDomainPending)
    const domainVerdict = await intakeSignature({
      store: market.store,
      config: market.config,
      signatureRecord: await sign(foreignDomainPending),
      nowMs: now,
    })
    expect(domainVerdict).toEqual({ ok: false, reason: 'domain-mismatch' })

    // None of the negatives activated anything; the served manifest is the
    // revision-2 release from the second cycle.
    expect((await fetch(`${market.baseUrl}/v1/manifest`)).status).toBe(200)
    expect(envelopeOf((await (await fetch(`${market.baseUrl}/v1/manifest`)).json())).revision).toBe(2)
  })

  it('concurrent double-intake of the same pending never surfaces a bare 5xx', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await prepare()
    const record = await signOffline(pending)
    // Both requests read the same pending and both pass verification. The loser
    // resolves one of two ways depending on interleaving, and BOTH are honest
    // (final review finding 2 was about it being a bare 500):
    //   - it loses the locked activate() because maxRevision already advanced
    //     => 409 manifest-activation-conflict;
    //   - the winner already consumed `pending` before it read it
    //     => 400 { activated: false, reason }.
    // Asserting only 409 made this test ~20% flaky (measured 2/10) without ever
    // catching a real defect, so pin the property that matters: exactly one
    // activation, and the loser gets a 4xx with a machine-readable body.
    const [winner, loser] = await Promise.all([
      postSignature(record),
      postSignature(record),
    ])
    const statuses = [winner.status, loser.status].sort()
    expect(statuses).toContain(200)
    const activated = [winner, loser].filter((response) => response.status === 200)
    expect(activated).toHaveLength(1)

    const conflicted = winner.status === 200 ? loser : winner
    expect(conflicted.status, `loser status must be 4xx, not ${String(conflicted.status)}`).toBeLessThan(500)
    expect([400, 409]).toContain(conflicted.status)
    if (conflicted.status === 409) {
      expect((conflicted.body as { error: { code: string } }).error.code).toBe('manifest-activation-conflict')
    } else {
      const body = conflicted.body as { activated: boolean; reason?: string }
      expect(body.activated).toBe(false)
      expect(typeof body.reason).toBe('string')
    }
  })

  it('advances revision monotonically across releases and persists maxRevision in the state document', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const first = await prepare()
    expect(envelopeOf(first).revision).toBe(1)
    expect((await postSignature(await signOffline(first))).status).toBe(200)

    await publishTgz(market.baseUrl, 'test-admin-token', cleanPackageManifest({ version: '1.3.0' }))
    const second = await prepare()
    expect(envelopeOf(second).revision).toBe(2)
    expect((await postSignature(await signOffline(second))).status).toBe(200)

    // Restart = reopen the same data directory: the persisted max revision
    // and the activated manifest survive (§13 full recovery), and the next
    // pending manifest continues monotonically (no revision regression).
    // The stopped instance releases the data directory's single-instance lock
    // first (P6) — a restart is stop-then-start, not two live instances.
    await market.store.close()
    const { CatalogStore } = await import('../src/catalog/store.ts')
    const { ArtifactStore: ReopenArtifactStore } = await import('../src/tarball/store.ts')
    const reopenedStore = await CatalogStore.open(market.dataDir)
    expect(reopenedStore.maxRevision()).toBe(2)
    expect(envelopeOf(reopenedStore.manifest()!).revision).toBe(2)

    const reopenedArtifacts = await ReopenArtifactStore.open(market.dataDir)
    const third = await preparePendingManifest({
      store: reopenedStore,
      catalog: new CatalogService(reopenedStore),
      config: market.config,
      artifactSize: async fileName => (await reopenedArtifacts.stat(fileName))?.size ?? null,
    })
    expect(envelopeOf(third).revision).toBe(3)
    await reopenedStore.close()
  })

  it('a re-prepare regenerates the pending manifest (fresh issuedAt/notAfter, same next revision)', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const first = await prepare()
    const second = await prepare()
    expect(envelopeOf(second).revision).toBe(envelopeOf(first).revision)
    expect(Date.parse(envelopeOf(second).issuedAt)).toBeGreaterThanOrEqual(Date.parse(envelopeOf(first).issuedAt))

    // only the latest pending can activate; a signature over the FIRST pending no longer matches
    const stale = await signOffline(first)
    expect((await postSignature(stale)).status).toBe(400)
    const fresh = await signOffline(second)
    expect((await postSignature(fresh)).status).toBe(200)
  })
})

describe('detached sidecar never breaks the strict contract schema', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  it('the full manifest document is NOT strict-schema valid; its catalog member IS', async () => {
    await publishTgz(market.baseUrl, 'test-admin-token')
    const pending = await (await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })).json() as { pendingManifest: unknown }
    const manifest = pending.pendingManifest as { catalog: unknown; envelope: unknown; files: unknown[] }

    // additionalProperties:false at the page top level — the wrapper MUST
    // detach the sidecar (envelope/files) before parseCatalogProviderPage.
    expect(() => parseCatalogProviderPage(manifest)).toThrow()
    expect(() => parseCatalogProviderPage(manifest.catalog)).not.toThrow()

    // and after a real activation, the served manifest keeps that property
    const record = signManifest(manifest as unknown as MarketManifest, {
      privateKeyPem: market.key.privateKeyPem,
      slot: 1,
      signedAt: new Date().toISOString(),
    })
    await fetch(`${market.baseUrl}/v1/admin/manifest/signature`, {
      method: 'POST',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify(record),
    })
    const served = await (await fetch(`${market.baseUrl}/v1/manifest`)).json() as { catalog: unknown }
    expect(() => parseCatalogProviderPage(served.catalog)).not.toThrow()
    const signature = await (await fetch(`${market.baseUrl}/v1/manifest/signature`)).json()
    expect((signature as { algorithm: string }).algorithm).toBe('Ed25519')
  })
})
