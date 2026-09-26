import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_ENVELOPE_TTL_MS,
  canonicalJson,
  checkEnvelope,
  fingerprintPublicKeyHex,
  generateKeyPair,
  publicKeyFromHex,
  signManifest,
  verifyCanonical,
  verifyWithKeySlots,
  type KeySlotConfig,
  type MarketManifest,
  type MarketManifestSignature,
  type VerificationContext,
  type VerificationVerdict,
} from '../src/signing.ts'

const DOMAIN = 'http://market.intranet.example:8787'
const NOW = Date.parse('2026-09-26T00:00:00.000Z')

function makeManifest(overrides: {
  revision?: number
  domain?: string
  issuedAt?: string
  notAfter?: string
} = {}): MarketManifest {
  return {
    envelope: {
      version: 1,
      domain: overrides.domain ?? DOMAIN,
      revision: overrides.revision ?? 5,
      issuedAt: overrides.issuedAt ?? '2026-09-25T00:00:00Z',
      notAfter: overrides.notAfter ?? '2026-10-01T00:00:00Z',
    },
    catalog: {
      generatedAt: '2026-09-25T00:00:00Z',
      packages: [{ name: '@huaanwork/sample-plugin', version: '1.2.3' }],
    },
    files: [
      {
        name: '@huaanwork/sample-plugin',
        version: '1.2.3',
        sha256: '0'.repeat(64),
        tarballPath: '/artifacts/huaanwork-sample-plugin-1.2.3.tgz',
        size: 4096,
      },
    ],
  }
}

function context(overrides: { domain?: string; now?: number; lastSeenRevision?: number } = {}): VerificationContext {
  const base: { domain: string; now: number; lastSeenRevision?: number } = { domain: DOMAIN, now: NOW }
  if (overrides.domain !== undefined) base.domain = overrides.domain
  if (overrides.now !== undefined) base.now = overrides.now
  if (overrides.lastSeenRevision !== undefined) base.lastSeenRevision = overrides.lastSeenRevision
  return base
}

function slotConfig(slot: 1 | 2, key: { publicKeyHex: string }, retiredAt?: string): KeySlotConfig {
  const base: KeySlotConfig = {
    slot,
    keyId: fingerprintPublicKeyHex(key.publicKeyHex),
    publicKeyHex: key.publicKeyHex,
  }
  if (retiredAt !== undefined) {
    return { ...base, retiredAt }
  }
  return base
}

describe('key generation', () => {
  it('produces a valid Ed25519 pair: exported public key verifies signatures made by the private key', () => {
    const key = generateKeyPair()
    expect(key.publicKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY')

    const manifest = makeManifest()
    const signature = signManifest(manifest, { privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-09-25T00:00:01Z' })
    expect(verifyManifest(key, signature, manifest)).toBe(true)
  })

  it('keyId is the sha256 fingerprint of the raw public key', () => {
    const key = generateKeyPair()
    expect(fingerprintPublicKeyHex(key.publicKeyHex)).toMatch(/^[0-9a-f]{64}$/)
    expect(() => publicKeyFromHex(key.publicKeyHex)).not.toThrow()
    expect(() => publicKeyFromHex('abcd')).toThrow()
  })
})

function verifyManifest(key: { publicKeyHex: string }, signature: MarketManifestSignature, manifest: MarketManifest): boolean {
  const slots: KeySlotConfig[] = [slotConfig(signature.slot, key)]
  const verdict = verifyWithKeySlots(manifest, signature, slots, context())
  return verdict.ok
}

describe('sign / verify round trip', () => {
  it('a signed manifest verifies against the matching slot', () => {
    const key = generateKeyPair()
    const manifest = makeManifest()
    const signature = signManifest(manifest, { privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-09-25T00:00:01Z' })
    const verdict = verifyWithKeySlots(manifest, signature, [slotConfig(1, key)], context())
    expect(verdict).toEqual({ ok: true, slot: 1 })
  })

  it('signManifest derives keyId from the private key, so it always matches the signer slot', () => {
    const key = generateKeyPair()
    const manifest = makeManifest()
    const signature = signManifest(manifest, { privateKeyPem: key.privateKeyPem, slot: 2, signedAt: '2026-09-25T00:00:01Z' })
    expect(signature.keyId).toBe(fingerprintPublicKeyHex(key.publicKeyHex))
    expect(signature.slot).toBe(2)
  })
})

describe('envelope anti-replay field check', () => {
  it('accepts a well-formed in-window envelope', () => {
    expect(checkEnvelope(makeManifest().envelope, context())).toEqual({ ok: true })
  })

  it.each([
    ['missing domain', (e: Record<string, unknown>) => delete e.domain],
    ['missing revision', (e: Record<string, unknown>) => delete e.revision],
    ['missing issuedAt', (e: Record<string, unknown>) => delete e.issuedAt],
    ['missing notAfter', (e: Record<string, unknown>) => delete e.notAfter],
  ])('rejects %s as missing-field', (_label, mutate) => {
    const envelope = { ...makeManifest().envelope } as unknown as Record<string, unknown>
    mutate(envelope)
    expect(checkEnvelope(envelope, context())).toEqual({ ok: false, reason: 'missing-field' })
  })

  it('rejects unsupported envelope version', () => {
    const envelope = { ...makeManifest().envelope, version: 2 }
    expect(checkEnvelope(envelope, context())).toEqual({ ok: false, reason: 'unsupported-envelope-version' })
  })

  it('rejects non-integer / sub-1 revisions', () => {
    expect(checkEnvelope({ ...makeManifest().envelope, revision: 0 }, context())).toEqual({ ok: false, reason: 'invalid-revision' })
    expect(checkEnvelope({ ...makeManifest().envelope, revision: 1.5 }, context())).toEqual({ ok: false, reason: 'invalid-revision' })
  })

  it('rejects revision regression against the persisted per-source maximum', () => {
    expect(checkEnvelope(makeManifest({ revision: 5 }).envelope, context({ lastSeenRevision: 5 }))).toEqual({
      ok: false,
      reason: 'revision-regression',
    })
    expect(checkEnvelope(makeManifest({ revision: 6 }).envelope, context({ lastSeenRevision: 5 }))).toEqual({ ok: true })
  })

  it('rejects expired notAfter', () => {
    const envelope = makeManifest().envelope
    expect(checkEnvelope(envelope, context({ now: Date.parse('2026-10-02T00:00:00.000Z') }))).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects a domain that differs from the configured source origin', () => {
    const envelope = makeManifest({ domain: 'http://other.intranet.example:1' }).envelope
    expect(checkEnvelope(envelope, context())).toEqual({ ok: false, reason: 'domain-mismatch' })
  })

  it('rejects future-dated issuedAt (not yet valid)', () => {
    const envelope = makeManifest({ issuedAt: '2026-09-27T00:00:00Z' }).envelope
    expect(checkEnvelope(envelope, context())).toEqual({ ok: false, reason: 'not-yet-valid' })
  })

  it('rejects malformed timestamps', () => {
    const envelope = makeManifest({ notAfter: 'not-a-date' }).envelope
    expect(checkEnvelope(envelope, context())).toEqual({ ok: false, reason: 'invalid-timestamp' })
  })

  it('enforces the 7-day notAfter cap (round5 N7)', () => {
    const within = makeManifest({ issuedAt: '2026-09-25T00:00:00Z', notAfter: '2026-10-02T00:00:00.000Z' }).envelope
    expect(checkEnvelope(within, context())).toEqual({ ok: true })
    const beyond = makeManifest({ issuedAt: '2026-09-25T00:00:00Z', notAfter: '2026-10-02T00:00:00.001Z' }).envelope
    expect(checkEnvelope(beyond, context())).toEqual({ ok: false, reason: 'ttl-exceeds-cap' })
    expect(MAX_ENVELOPE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('three-input two-slot rotation verification', () => {
  it('accepts either non-retired slot during the rotation overlap', () => {
    const current = generateKeyPair()
    const previous = generateKeyPair()
    const manifest = makeManifest()
    const slots = [slotConfig(1, current), slotConfig(2, previous, '2026-10-01T00:00:00Z')]

    const byCurrent = signManifest(manifest, { privateKeyPem: current.privateKeyPem, slot: 1, signedAt: '2026-09-25T00:00:01Z' })
    const byPrevious = signManifest(manifest, { privateKeyPem: previous.privateKeyPem, slot: 2, signedAt: '2026-09-25T00:00:01Z' })

    expect(verifyWithKeySlots(manifest, byCurrent, slots, context())).toEqual({ ok: true, slot: 1 })
    expect(verifyWithKeySlots(manifest, byPrevious, slots, context())).toEqual({ ok: true, slot: 2 })
  })

  it('rejects the slot-2 key once retiredAt has passed (round4 C3)', () => {
    const previous = generateKeyPair()
    const manifest = makeManifest()
    const slots = [slotConfig(1, generateKeyPair()), slotConfig(2, previous, '2026-09-20T00:00:00Z')]
    const signature = signManifest(manifest, { privateKeyPem: previous.privateKeyPem, slot: 2, signedAt: '2026-09-25T00:00:01Z' })
    expect(verifyWithKeySlots(manifest, signature, slots, context())).toEqual({
      ok: false,
      reason: 'slot-retired',
    })
  })

  it('rejects a signature from a key that matches no configured slot', () => {
    const rogue = generateKeyPair()
    const manifest = makeManifest()
    const slots = [slotConfig(1, generateKeyPair()), slotConfig(2, generateKeyPair(), '2026-10-01T00:00:00Z')]
    const signature = signManifest(manifest, { privateKeyPem: rogue.privateKeyPem, slot: 1, signedAt: '2026-09-25T00:00:01Z' })
    expect(verifyWithKeySlots(manifest, signature, slots, context())).toEqual({
      ok: false,
      reason: 'unknown-key',
    })
  })

  it('rejects a record whose keyId does not match the claimed slot', () => {
    const current = generateKeyPair()
    const previous = generateKeyPair()
    const manifest = makeManifest()
    const slots = [slotConfig(1, current), slotConfig(2, previous, '2026-10-01T00:00:00Z')]
    const signature = { ...signManifest(manifest, { privateKeyPem: previous.privateKeyPem, slot: 2, signedAt: '2026-09-25T00:00:01Z' }), slot: 1 as const }
    expect(verifyWithKeySlots(manifest, signature, slots, context())).toEqual({
      ok: false,
      reason: 'slot-key-mismatch',
    })
  })

  it('rejects a tampered manifest even when the envelope fields still parse', () => {
    const key = generateKeyPair()
    const manifest = makeManifest()
    const signature = signManifest(manifest, { privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-09-25T00:00:01Z' })
    const tampered: MarketManifest = { ...manifest, files: [{ ...manifest.files[0]!, sha256: '1'.repeat(64) }] }
    expect(verifyWithKeySlots(tampered, signature, [slotConfig(1, key)], context())).toEqual({
      ok: false,
      reason: 'invalid-signature',
    })
  })
})

// ---------------------------------------------------------------------------
// Shared test vectors: the cross-side contract with the future wrapper verifier
// (round3 R10). A wrapper-side test must load the same JSON file and reproduce
// every expected verdict with its own node:crypto implementation.
// ---------------------------------------------------------------------------

interface VectorContext {
  readonly domain: string
  readonly now: string
  readonly lastSeenRevision?: number
}

interface Vector {
  readonly name: string
  readonly manifest: MarketManifest
  readonly signature: MarketManifestSignature
  readonly slots: readonly KeySlotConfig[]
  readonly context: VectorContext
  readonly expect: VerificationVerdict
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'signing-vectors.json'), 'utf8'),
) as {
  readonly domain: string
  readonly vectors: readonly Vector[]
}

describe('shared test vectors (wrapper-side reusable contract)', () => {
  it('the committed fixture carries vectors for every verdict class', () => {
    const reasons = new Set(fixture.vectors.filter((v) => !v.expect.ok).map((v) => (v.expect as { reason: string }).reason))
    for (const expected of [
      'missing-field',
      'revision-regression',
      'expired',
      'domain-mismatch',
      'slot-retired',
      'unknown-key',
      'slot-key-mismatch',
      'invalid-signature',
    ]) {
      expect(reasons.has(expected), `fixture covers ${expected}`).toBe(true)
    }
    expect(fixture.vectors.some((v) => v.expect.ok)).toBe(true)
  })

  it.each(fixture.vectors.map((v) => [v.name, v] as const))('vector %s reproduces its expected verdict', (_name, vector) => {
    const ctx: VerificationContext = {
      domain: vector.context.domain,
      now: Date.parse(vector.context.now),
      ...(vector.context.lastSeenRevision !== undefined ? { lastSeenRevision: vector.context.lastSeenRevision } : {}),
    }
    expect(verifyWithKeySlots(vector.manifest, vector.signature, vector.slots, ctx)).toEqual(vector.expect)
  })
})

describe('verifyCanonical primitive', () => {
  it('verifies a detached signature over canonical bytes independently of envelope logic', () => {
    const key = generateKeyPair()
    const manifest = makeManifest()
    const signature = signManifest(manifest, { privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-09-25T00:00:01Z' })
    expect(verifyCanonical(canonicalJson(manifest), signature.signature, key.publicKeyHex)).toBe(true)
    expect(verifyCanonical(canonicalJson({ ...manifest, catalog: { generatedAt: 'x', packages: [] } }), signature.signature, key.publicKeyHex)).toBe(false)
  })
})
