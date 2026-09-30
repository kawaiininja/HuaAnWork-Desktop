/**
 * wrapper 验签跨侧证明(round3 R10):复现 market-server 共享测试向量的**每一条**
 * verdict——wrapper 的 node:crypto 自实现与 market-server signing.ts 语义一致。
 *
 * 另锁 Task 4 fail-closed 决策:空钉扎(PINS_AT_RELEASE 默认)⇒ 验签入口恒抛,
 * 不存在「无公钥放行」路径;三负例(篡改清单/缺签名/错公钥)。
 */
import { describe, expect, test } from 'vitest'
import { PINS_AT_RELEASE, type MarketVerificationPins } from '../../src/huaanwork-host/market/config.ts'
import {
  canonicalJson,
  checkEnvelope,
  marketKeySlotsFromPins,
  publicKeyFromHex,
  verifyCanonical,
  verifyMarketManifest,
  verifyWithKeySlots,
  type KeySlotConfig,
  type MarketManifest,
  type VerificationContext,
} from '../../src/huaanwork-host/market/verify.ts'
import { loadSigningVectors, signManifestForTest } from './market-test-server.ts'

interface Vector {
  readonly name: string
  readonly manifest: MarketManifest
  readonly signature: unknown
  readonly slots: readonly KeySlotConfig[]
  readonly context: { domain: string; now: string; lastSeenRevision?: number }
  readonly expect: { ok: boolean; slot?: 1 | 2; reason?: string }
}

const fixture = loadSigningVectors()
const vectors = (() => {
  const raw = JSON.parse(JSON.stringify(fixture)) as { keys?: unknown; vectors?: unknown }
  return (raw.vectors ?? []) as Vector[]
})()

/** 向量 slots → wrapper 钉扎形态(两槽旋转窗的 pins 供给)。 */
function pinsFromVectorSlots(slots: readonly KeySlotConfig[]): MarketVerificationPins {
  const slot1 = slots.find(slot => slot.slot === 1)
  const slot2 = slots.find(slot => slot.slot === 2)
  return {
    current: { publicKeyHex: slot1!.publicKeyHex },
    previous: { key: { publicKeyHex: slot2!.publicKeyHex }, retiredAt: slot2!.retiredAt! },
  }
}

function contextOf(vector: Vector): VerificationContext {
  return {
    domain: vector.context.domain,
    now: Date.parse(vector.context.now),
    ...(vector.context.lastSeenRevision !== undefined ? { lastSeenRevision: vector.context.lastSeenRevision } : {}),
  }
}

describe('wrapper verify mirrors market-server semantics across all shared vectors', () => {
  test('the shared fixture is pinned to fixtureVersion 3 (both sides assert it)', () => {
    expect(fixture.fixtureVersion).toBe(3)
  })

  test.each(vectors.map(vector => [vector.name, vector] as const))('vector %s', (_name, vector) => {
    const pins = pinsFromVectorSlots(vector.slots)
    const verdict = verifyMarketManifest(vector.manifest, vector.signature as never, pins, contextOf(vector))
    expect(verdict).toEqual(vector.expect)
  })

  test('marketKeySlotsFromPins resolves keyIds identical to the vector slot config', () => {
    for (const vector of vectors) {
      const slots = marketKeySlotsFromPins(pinsFromVectorSlots(vector.slots))
      for (const expected of vector.slots) {
        const actual = slots.find(slot => slot.slot === expected.slot)
        expect(actual?.keyId).toBe(expected.keyId)
        expect(actual?.publicKeyHex).toBe(expected.publicKeyHex)
      }
    }
  })
})

describe('wrapper verify fail-closed gate', () => {
  const sample = vectors.find(vector => vector.name === 'valid-current-slot')!
  const pins = pinsFromVectorSlots(sample.slots)
  const context = contextOf(sample)

  test('empty pins (PINS_AT_RELEASE default) always rejects: no key, no pass', () => {
    expect(PINS_AT_RELEASE).toEqual({})
    expect(() => verifyMarketManifest(sample.manifest, sample.signature as never, PINS_AT_RELEASE, context))
      .toThrow(/no pinned verification public key/u)
  })

  test('tampered manifest after signing is rejected (invalid-signature)', () => {
    const tampered: MarketManifest = {
      ...sample.manifest,
      files: sample.manifest.files.map((file, index) => (index === 0 ? { ...file, sha256: `ff${file.sha256.slice(2)}` } : file)),
    }
    const verdict = verifyMarketManifest(tampered, sample.signature as never, pins, context)
    expect(verdict).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  test('missing signature record is rejected with a verdict, never a throw', () => {
    for (const malformed of [null, undefined, {}, { version: 1 }]) {
      const verdict = verifyWithKeySlots(sample.manifest, malformed as never, marketKeySlotsFromPins(pins), context)
      expect(verdict.ok).toBe(false)
    }
  })

  test('wrong public key (signed by an unpinned key) is rejected as unknown-key', () => {
    const wrong = signManifestForTest(sample.manifest, fixture.keys.unknown.privateKeyPem, 1)
    const verdict = verifyMarketManifest(sample.manifest, wrong, pins, context)
    expect(verdict).toEqual({ ok: false, reason: 'unknown-key' })
  })

  test('envelope checks reject across-source replay even with a valid signature', () => {
    const crossDomain: VerificationContext = { ...context, domain: 'http://evil.intranet.example:9999' }
    expect(checkEnvelope(sample.manifest.envelope, crossDomain)).toEqual({ ok: false, reason: 'domain-mismatch' })
  })
})

/**
 * 裁定 R-1(spec §14 第 52 条,落地记录 = 第 63 条):KeyId 解析权威、声明槽降为
 * 元数据;`retiredAt` 仍按**解析到的槽**判定。K1 = 旧钥,K2 = 新钥,真实 ed25519
 * 密钥对(共享 fixture 的 throwaway 测试钥),不用 mock。
 *
 * 后四条是**安全面不收缩的证明**:放宽一条判定时必须钉住其余判定仍然生效。
 */
describe('key rotation has an overlap window (R-1)', () => {
  const sample = vectors.find(vector => vector.name === 'valid-current-slot')!
  const manifest = sample.manifest
  const context = contextOf(sample)
  const K1 = fixture.keys.slot1
  const K2 = fixture.keys.slot2

  const sigByK1Slot1 = signManifestForTest(manifest, K1.privateKeyPem, 1)
  const sigByK2Slot1 = signManifestForTest(manifest, K2.privateKeyPem, 1)

  const pinsUnrotated: MarketVerificationPins = { current: { publicKeyHex: K1.publicKeyHex } }
  const pinsAfterRelease: MarketVerificationPins = {
    current: { publicKeyHex: K2.publicKeyHex },
    previous: { key: { publicKeyHex: K1.publicKeyHex }, retiredAt: '2026-10-01T00:00:00Z' },
  }
  const pinsPreviousRetired: MarketVerificationPins = {
    current: { publicKeyHex: K1.publicKeyHex },
    previous: { key: { publicKeyHex: K2.publicKeyHex }, retiredAt: '2026-09-20T00:00:00Z' },
  }

  test('accepts a K1-signed manifest while the client pins K2 as current and K1 as previous', () => {
    // spec §14 第 52 条实测表第 2 行:M5 下 REJECT slot-key-mismatch;放宽后必须 ACCEPT
    // (重叠期旧钥清单仍可验——第 41 条的原始意图)。声明槽仍是服务端的 slot 1。
    expect(verifyMarketManifest(manifest, sigByK1Slot1, pinsAfterRelease, context)).toEqual({ ok: true, slot: 2 })
  })

  test('accepts a K2-signed manifest once the client pins K2 as current', () => {
    // 第 3 行,原本就 OK。
    expect(verifyMarketManifest(manifest, sigByK2Slot1, pinsAfterRelease, context)).toEqual({ ok: true, slot: 1 })
  })

  test('still rejects a manifest signed by a key the client does not pin at all', () => {
    // 第 4 行:current=K1(未升级) vs K2/slot1 → REJECT unknown-key(不得因放宽而放行)。
    expect(verifyMarketManifest(manifest, sigByK2Slot1, pinsUnrotated, context)).toEqual({ ok: false, reason: 'unknown-key' })
  })

  test('still rejects a manifest whose declared key has passed its retiredAt', () => {
    // retiredAt 按**解析到的槽**判定:previous 槽已过 retiredAt → REJECT slot-retired。
    expect(verifyMarketManifest(manifest, sigByK2Slot1, pinsPreviousRetired, context)).toEqual({ ok: false, reason: 'slot-retired' })
  })

  test('still rejects an invalid signature under a pinned key', () => {
    const tampered: MarketManifest = {
      ...manifest,
      files: manifest.files.map((file, index) => (index === 0 ? { ...file, sha256: `ff${file.sha256.slice(2)}` } : file)),
    }
    expect(verifyMarketManifest(tampered, sigByK1Slot1, pinsAfterRelease, context)).toEqual({ ok: false, reason: 'invalid-signature' })
  })

  test('still rejects an older revision (replay) while accepting an idempotent re-read', () => {
    // spec §14 第 49 条:revision < lastSeen → reject;等值 → 放行。放宽槽号判定不得影响这条。
    expect(verifyMarketManifest(manifest, sigByK1Slot1, pinsAfterRelease, { ...context, lastSeenRevision: manifest.envelope.revision + 1 }))
      .toEqual({ ok: false, reason: 'revision-regression' })
    expect(verifyMarketManifest(manifest, sigByK1Slot1, pinsAfterRelease, { ...context, lastSeenRevision: manifest.envelope.revision }))
      .toEqual({ ok: true, slot: 2 })
  })
})

/**
 * P9/P10 镜像证明(market-server Task 6.5):两侧语义镜像不变 ——
 *
 * - P9:`publicKeyFromHex` 对畸形 hex 返回 `null`,**绝不抛**(旧实现按
 *   `Buffer.from(hex,'hex')` 的解码长度判定,畸形串会抛);`verifyCanonical`
 *   对畸形钥答 `false`。
 * - P10:`not-yet-valid` 有 30s 时钟偏移宽限(具名常量 `CLOCK_SKEW_GRACE_MS`,
 *   与 `market-server/src/signing.ts` 同名同值;runbook
 *   `docs/market-server-deployment.md` 引用该名并写明 NTP 前置条件)。
 */
describe('wrapper mirrors the P9/P10 hardening (market-server Task 6.5)', () => {
  const sample = (): Vector => vectors.find(vector => vector.name === 'valid-current-slot')!

  test('publicKeyFromHex returns null for malformed hex instead of throwing', () => {
    for (const hex of ['', 'zz', '00'.repeat(31), '00'.repeat(33), `${'00'.repeat(32)}zz`]) {
      expect(publicKeyFromHex(hex), hex).toBeNull()
    }
    expect(publicKeyFromHex(fixture.keys.slot1.publicKeyHex)?.type).toBe('public')
  })

  test('verifyCanonical answers false for a malformed key, never throws', () => {
    const vector = sample()
    const signature = signManifestForTest(vector.manifest, fixture.keys.slot1.privateKeyPem, 1)
    expect(verifyCanonical(canonicalJson(vector.manifest), signature.signature, 'zz')).toBe(false)
    expect(verifyCanonical(canonicalJson(vector.manifest), signature.signature, fixture.keys.slot1.publicKeyHex)).toBe(true)
  })

  test('names the grace constant so the runbook can cite it', async () => {
    const exports = (await import('../../src/huaanwork-host/market/verify.ts')) as unknown as Record<string, unknown>
    expect(exports.CLOCK_SKEW_GRACE_MS).toBe(30_000)
  })

  test('accepts a not-yet-valid manifest inside the grace window, rejects one outside it', () => {
    const vector = sample()
    const issuedAtMs = Date.parse(vector.manifest.envelope.issuedAt)
    expect(checkEnvelope({ ...vector.manifest.envelope }, { ...contextOf(vector), now: issuedAtMs - 1_000 })).toEqual({ ok: true })
    expect(checkEnvelope({ ...vector.manifest.envelope }, { ...contextOf(vector), now: issuedAtMs - 300_000 }))
      .toEqual({ ok: false, reason: 'not-yet-valid' })
  })
})
