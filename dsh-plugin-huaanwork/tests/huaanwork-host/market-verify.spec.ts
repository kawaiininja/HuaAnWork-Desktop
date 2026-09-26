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
  checkEnvelope,
  marketKeySlotsFromPins,
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
