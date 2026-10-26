import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  CatalogKeyringError,
  canonicalJson,
  fingerprintPublicKeyHex,
  generateKeyPair,
  parseCatalogKeyring,
  signAgentPackageDigest,
  verifyAgentPackageDigestSignature,
  type CatalogKeyringEntry,
  type CatalogSignature,
} from '../src/index.ts'

/**
 * The shared signing-vectors fixture is the byte-compatibility contract with
 * market-server (round3 R10, ruling R-1). This package never regenerates it:
 * it reads the committed bytes and must reproduce the same canonical form and
 * the same signatures with its own primitives.
 */
interface VectorSlot {
  readonly slot: 1 | 2
  readonly keyId: string
  readonly publicKeyHex: string
  readonly retiredAt?: string
}

interface Vector {
  readonly name: string
  readonly manifest: unknown
  readonly signature: CatalogSignature
  readonly slots: readonly VectorSlot[]
  readonly context: { readonly domain: string; readonly now: string; readonly lastSeenRevision?: number }
  readonly expect: { readonly ok: true; readonly slot: 1 | 2 } | { readonly ok: false; readonly reason: string }
}

interface Fixture {
  readonly fixtureVersion: number
  readonly keys: Record<'slot1' | 'slot2' | 'unknown', {
    readonly publicKeyHex: string
    readonly privateKeyPem: string
    readonly fingerprint: string
  }>
  readonly vectors: readonly Vector[]
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../market-server/tests/fixtures/signing-vectors.json'), 'utf8'),
) as Fixture

function vector(name: string): Vector {
  const found = fixture.vectors.find((entry) => entry.name === name)
  assert.ok(found, `fixture vector ${name} is missing`)
  return found
}

function keyringOf(slots: readonly VectorSlot[]): CatalogKeyringEntry[] {
  return slots.map((slot) => ({
    keyId: slot.keyId,
    publicKeyHex: slot.publicKeyHex,
    slot: slot.slot,
    ...(slot.retiredAt !== undefined ? { retiredAt: slot.retiredAt } : {}),
  }))
}

test('canonicalJson preserves market byte ordering', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 }, z: [true, null] }), '{"a":{"c":3,"d":2},"b":1,"z":[true,null]}')
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite number/)
})

test('signs digest and rejects wrong, unknown, and retired keys', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0', files: [] }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-10-24T00:00:00.000Z',
  })
  const entry = { keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 as const }
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, [entry], 1), { ok: true, slot: 1 })
  assert.equal(verifyAgentPackageDigestSignature({ ...digest, version: '1.0.1' }, signature, [entry], 1).ok, false)
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, [], 1), { ok: false, reason: 'unknown-key' })
  assert.deepEqual(
    verifyAgentPackageDigestSignature(digest, signature, [{ ...entry, retiredAt: '1970-01-01T00:00:00.000Z' }], 1),
    { ok: false, reason: 'slot-retired' },
  )
})

// ---------------------------------------------------------------------------
// Byte compatibility with the committed market fixture (never regenerated)
// ---------------------------------------------------------------------------

test('the shared fixture is pinned to fixtureVersion 3', () => {
  assert.equal(fixture.fixtureVersion, 3)
})

test('canonicalJson reproduces the exact signed bytes of every healthy fixture vector', () => {
  const signed = fixture.vectors.filter((entry) => entry.expect.ok)
  assert.ok(signed.length > 0)
  for (const entry of signed) {
    const canonical = canonicalJson(entry.manifest)
    const resolved = entry.slots.find((slot) => slot.keyId === entry.signature.keyId)
    assert.ok(resolved, `${entry.name}: signature keyId resolves to a fixture slot`)
    assert.equal(
      canonical,
      canonicalJson(JSON.parse(canonical)),
      `${entry.name}: canonical form is a fixed point`,
    )
    const verified = verifyAgentPackageDigestSignature(
      entry.manifest,
      entry.signature,
      keyringOf(entry.slots),
      Date.parse(entry.context.now),
    )
    assert.deepEqual(verified, { ok: true, slot: resolved.slot }, `${entry.name}: canonical bytes and signature agree`)
  }
})

test('the fixture private keys reproduce the committed signatures byte for byte', () => {
  const current = vector('valid-current-slot')
  const reproducedCurrent = signAgentPackageDigest(current.manifest, {
    privateKeyPem: fixture.keys.slot1.privateKeyPem,
    slot: 1,
    signedAt: '2026-09-25T00:00:00Z',
  })
  assert.deepEqual(reproducedCurrent, current.signature)
  assert.equal(reproducedCurrent.keyId, fixture.keys.slot1.fingerprint)

  const previous = vector('valid-previous-slot-within-retired-at')
  const reproducedPrevious = signAgentPackageDigest(previous.manifest, {
    privateKeyPem: fixture.keys.slot2.privateKeyPem,
    slot: 2,
    signedAt: '2026-09-25T00:00:00Z',
  })
  assert.deepEqual(reproducedPrevious, previous.signature)
  assert.equal(reproducedPrevious.keyId, fixture.keys.slot2.fingerprint)
})

test('a tampered fixture manifest still canonicalizes but fails the signature', () => {
  const tampered = vector('tampered-manifest')
  const verdict = verifyAgentPackageDigestSignature(
    tampered.manifest,
    tampered.signature,
    keyringOf(tampered.slots),
    Date.parse(tampered.context.now),
  )
  assert.deepEqual(verdict, { ok: false, reason: 'invalid-signature' })
})

// ---------------------------------------------------------------------------
// KeyId-authoritative verification (declared slot is metadata)
// ---------------------------------------------------------------------------

test('resolves the key by keyId across all slots and ignores the declared slot', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0' }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 2,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  const entries: CatalogKeyringEntry[] = [{ keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 }]
  // The record declares slot 2, but the key lives in slot 1: the resolved slot wins.
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, entries, 0), { ok: true, slot: 1 })
})

test('retirement applies to any slot, at or before now', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0' }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  const retiredAt = '2026-10-24T00:00:00.000Z'
  const entries: CatalogKeyringEntry[] = [{ keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1, retiredAt }]
  assert.deepEqual(
    verifyAgentPackageDigestSignature(digest, signature, entries, Date.parse(retiredAt)),
    { ok: false, reason: 'slot-retired' },
  )
  assert.deepEqual(
    verifyAgentPackageDigestSignature(digest, signature, entries, Date.parse(retiredAt) - 1),
    { ok: true, slot: 1 },
  )
})

test('rejects unparseable retiredAt and signedAt as invalid-timestamp', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0' }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  const entry: CatalogKeyringEntry = { keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1, retiredAt: 'not-a-date' }
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, [entry], 0), {
    ok: false,
    reason: 'invalid-timestamp',
  })
  assert.deepEqual(
    verifyAgentPackageDigestSignature(digest, { ...signature, signedAt: 'not-a-date' }, [entry], 0),
    { ok: false, reason: 'invalid-timestamp' },
  )
})

test('rejects malformed signature records as invalid-signature', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0' }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  const entries: CatalogKeyringEntry[] = [{ keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 }]
  for (const malformed of [
    null,
    'signature',
    { ...signature, version: 2 },
    { ...signature, algorithm: 'RSA' },
    { ...signature, signature: 'not-base64!' },
    { ...signature, keyId: 42 },
    { ...signature, slot: 3 },
    { ...signature, signedAt: 42 },
  ]) {
    assert.deepEqual(
      verifyAgentPackageDigestSignature(digest, malformed, entries, 0),
      { ok: false, reason: 'invalid-signature' },
      `rejects ${JSON.stringify(malformed)}`,
    )
  }
})

test('verifyAgentPackageDigestSignature defaults now to the current clock', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0' }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-01-01T00:00:00.000Z',
  })
  const entries: CatalogKeyringEntry[] = [{ keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 }]
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, entries), { ok: true, slot: 1 })
})

// ---------------------------------------------------------------------------
// Keyring parsing
// ---------------------------------------------------------------------------

test('parseCatalogKeyring accepts a well-formed two-slot keyring', () => {
  const current = generateKeyPair()
  const previous = generateKeyPair()
  const raw = {
    schemaVersion: 1,
    keys: [
      { keyId: fingerprintPublicKeyHex(current.publicKeyHex), publicKeyHex: current.publicKeyHex, slot: 1 },
      {
        keyId: fingerprintPublicKeyHex(previous.publicKeyHex),
        publicKeyHex: previous.publicKeyHex,
        slot: 2,
        retiredAt: '2027-01-01T00:00:00.000Z',
      },
    ],
  }
  assert.deepEqual(parseCatalogKeyring(raw), [
    { keyId: fingerprintPublicKeyHex(current.publicKeyHex), publicKeyHex: current.publicKeyHex, slot: 1 },
    {
      keyId: fingerprintPublicKeyHex(previous.publicKeyHex),
      publicKeyHex: previous.publicKeyHex,
      slot: 2,
      retiredAt: '2027-01-01T00:00:00.000Z',
    },
  ])
})

test('parseCatalogKeyring rejects malformed keyrings with CatalogKeyringError', () => {
  const current = generateKeyPair()
  const other = generateKeyPair()
  const third = generateKeyPair()
  const entryOf = (publicKeyHex: string, slot: 1 | 2, extra: Record<string, unknown> = {}) => ({
    keyId: fingerprintPublicKeyHex(publicKeyHex),
    publicKeyHex,
    slot,
    ...extra,
  })
  const currentEntry = entryOf(current.publicKeyHex, 1)
  const cases: readonly [string, unknown][] = [
    ['non-object', 'keyring'],
    ['wrong schemaVersion', { schemaVersion: 2, keys: [currentEntry] }],
    ['missing keys', { schemaVersion: 1 }],
    ['empty keys', { schemaVersion: 1, keys: [] }],
    ['no slot 1', { schemaVersion: 1, keys: [entryOf(current.publicKeyHex, 2)] }],
    ['two slot 1', { schemaVersion: 1, keys: [currentEntry, entryOf(other.publicKeyHex, 1)] }],
    ['two slot 2', {
      schemaVersion: 1,
      keys: [currentEntry, entryOf(other.publicKeyHex, 2), entryOf(third.publicKeyHex, 2)],
    }],
    ['keyId is not the fingerprint', {
      schemaVersion: 1,
      keys: [{ ...currentEntry, keyId: fingerprintPublicKeyHex(other.publicKeyHex) }],
    }],
    ['short public key', { schemaVersion: 1, keys: [entryOf('abcd', 1)] }],
    ['non-hex public key', { schemaVersion: 1, keys: [entryOf('z'.repeat(64), 1)] }],
    ['unparseable retiredAt', { schemaVersion: 1, keys: [entryOf(current.publicKeyHex, 1, { retiredAt: 'not-a-date' })] }],
    ['non-string retiredAt', { schemaVersion: 1, keys: [entryOf(current.publicKeyHex, 1, { retiredAt: 42 })] }],
    ['duplicate keyId', { schemaVersion: 1, keys: [currentEntry, { ...currentEntry, slot: 2 }] }],
  ]
  for (const [label, raw] of cases) {
    assert.throws(() => parseCatalogKeyring(raw), CatalogKeyringError, label)
  }
})
