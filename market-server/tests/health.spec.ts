import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ENVELOPE_TTL_MS, signManifest, type MarketManifest } from '../src/signing.ts'
import { adminHeaders, bootTestMarket, publishTgz, type TestMarket } from './helpers/server.ts'
import { cleanPackageManifest } from './helpers/tar.ts'

interface HealthResponseBody {
  readonly ok: boolean
  readonly envelope: {
    readonly active: boolean
    readonly revision: number
    readonly notAfter: string | null
    readonly expiresInSeconds: number | null
    readonly warning: boolean
  }
  readonly manifestCanonicalBytes: number
  readonly entryCount: number
  readonly averageEntryBytes: number
}

describe('/healthz envelope lifetime (M11)', () => {
  let market: TestMarket

  beforeEach(async () => {
    market = await bootTestMarket()
  })

  afterEach(async () => {
    await market.close()
  })

  async function publishAndActivate(name: string, version: string): Promise<void> {
    const published = await publishTgz(market.baseUrl, 'test-admin-token', cleanPackageManifest({ name, version }))
    expect(published.status).toBe(201)

    const prepareRes = await fetch(`${market.baseUrl}/v1/admin/manifest/prepare`, {
      method: 'POST',
      headers: adminHeaders('test-admin-token'),
    })
    expect(prepareRes.status).toBe(200)
    const { pendingManifest } = (await prepareRes.json()) as { pendingManifest: MarketManifest }

    const signature = signManifest(pendingManifest, {
      privateKeyPem: market.key.privateKeyPem,
      slot: 1,
      signedAt: new Date().toISOString(),
    })

    const intakeRes = await fetch(`${market.baseUrl}/v1/admin/manifest/signature`, {
      method: 'POST',
      headers: { ...adminHeaders('test-admin-token'), 'content-type': 'application/json' },
      body: JSON.stringify(signature),
    })
    expect(intakeRes.status).toBe(200)
  }

  it('reports ok only, when no manifest has ever been activated', async () => {
    const body = (await (await fetch(`${market.baseUrl}/healthz`)).json()) as HealthResponseBody
    expect(body.ok).toBe(true)
    expect(body.envelope).toEqual({ active: false, revision: 0, notAfter: null, expiresInSeconds: null, warning: false })
  })

  it('exposes the remaining lifetime of the activated envelope', async () => {
    await publishAndActivate('@huaanwork/probe', '1.0.0')
    const body = (await (await fetch(`${market.baseUrl}/healthz`)).json()) as HealthResponseBody
    expect(body.ok).toBe(true)
    expect(body.envelope.active).toBe(true)
    expect(body.envelope.revision).toBe(1)
    expect(typeof body.envelope.notAfter).toBe('string')
    expect(body.envelope.expiresInSeconds).toBeLessThanOrEqual(MAX_ENVELOPE_TTL_MS / 1000)
    expect(body.envelope.expiresInSeconds).toBeGreaterThan(MAX_ENVELOPE_TTL_MS / 1000 - 120)
    expect(body.envelope.warning).toBe(false)
  })

  it('flags warning once less than 48h of envelope lifetime remains', async () => {
    // 用 now 注入缝把「当前时间」推到 notAfter 前 47 小时 —— 不等真机 7 天。
    await publishAndActivate('@huaanwork/probe', '1.0.0')
    const body = (await (await fetch(`${market.baseUrl}/healthz`, {
      headers: { 'x-test-now': new Date(Date.now() + MAX_ENVELOPE_TTL_MS - 47 * 3600 * 1000).toISOString() },
    })).json()) as HealthResponseBody
    expect(body.envelope.warning).toBe(true)
    expect(body.envelope.expiresInSeconds).toBeLessThan(48 * 3600)
  })

  it('reports an expired envelope as not-ok rather than silently healthy', async () => {
    // 过期即全市场四条 route 全 502(客户端无缓存、每次读都重验,verify.ts:288 过期即
    // `expired`)。/healthz 若仍报 ok:true,就是把「全市场停摆」显示成健康 —— 与 M9 要
    // 消除的 fail-silent 同类,故这里必须 ok:false。
    await publishAndActivate('@huaanwork/probe', '1.0.0')
    const body = (await (await fetch(`${market.baseUrl}/healthz`, {
      headers: { 'x-test-now': new Date(Date.now() + MAX_ENVELOPE_TTL_MS + 60_000).toISOString() },
    })).json()) as HealthResponseBody
    expect(body.ok).toBe(false)
    expect(body.envelope.active).toBe(true)
    expect(body.envelope.expiresInSeconds).toBeLessThan(0)
    expect(body.envelope.warning).toBe(true)
  })

  it('carries the M18 observables added by Task 4.1', async () => {
    await publishAndActivate('@huaanwork/probe', '1.0.0')
    const body = (await (await fetch(`${market.baseUrl}/healthz`)).json()) as HealthResponseBody
    expect(typeof body.manifestCanonicalBytes).toBe('number')
    expect(body.entryCount).toBe(1)
    expect(typeof body.averageEntryBytes).toBe('number')
  })
})
