#!/usr/bin/env node
/**
 * Regenerator for the shared signing test vectors
 * (tests/fixtures/signing-vectors.json).
 *
 * The committed fixture is the CROSS-SIDE contract proof (round3 R10): a
 * future wrapper-side test (dsh-plugin-huaanwork) consumes the same file to
 * prove its node:crypto re-implementation agrees with market-server on every
 * verdict. Ed25519 is deterministic, so regenerating produces byte-identical
 * signatures for unchanged vectors.
 *
 * The private keys in the fixture are THROWAWAY test material. They sign
 * nothing in production and must never be reused as real signing keys.
 *
 * Usage: node scripts/gen-test-vectors.mjs
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  ENVELOPE_VERSION,
  SIGNATURE_VERSION,
  generateKeyPair,
  fingerprintPublicKeyHex,
  signManifest,
} from '../src/signing.ts'

const DOMAIN = 'http://market.intranet.example:8787'
const OTHER_DOMAIN = 'http://evil.intranet.example:9999'
const ISSUED_AT = '2026-09-25T00:00:00Z'
const NOT_AFTER = '2026-10-01T00:00:00Z' // 6 days, inside the 7-day cap
const NOW = '2026-09-26T00:00:00.000Z'
const SLOT2_RETIRED_AT = '2026-10-01T00:00:00Z' // one release window after rotation

function makeManifest(overrides = {}) {
  const envelope = {
    version: ENVELOPE_VERSION,
    domain: DOMAIN,
    revision: 5,
    issuedAt: ISSUED_AT,
    notAfter: NOT_AFTER,
    ...(overrides.envelope ?? {}),
  }
  const catalog = {
    generatedAt: ISSUED_AT,
    packages: [
      { name: '@huaanwork/sample-plugin', version: '1.2.3', description: 'fixture package' },
    ],
  }
  const files = [
    {
      name: '@huaanwork/sample-plugin',
      version: '1.2.3',
      sha256: '0'.repeat(64),
      tarballPath: '/artifacts/huaanwork-sample-plugin-1.2.3.tgz',
      size: 4096,
    },
  ]
  return { envelope, catalog, ...(overrides.catalog ? { catalog: overrides.catalog } : {}), files }
}

function signedBy(manifest, key, slot, signedAt = ISSUED_AT) {
  return signManifest(manifest, { privateKeyPem: key.privateKeyPem, slot, signedAt })
}

function keyFixture(key) {
  return {
    publicKeyHex: key.publicKeyHex,
    privateKeyPem: key.privateKeyPem,
    fingerprint: fingerprintPublicKeyHex(key.publicKeyHex),
  }
}

const slot1Key = generateKeyPair()
const slot2Key = generateKeyPair()
const unknownKey = generateKeyPair()

const slotsInOverlap = [
  { slot: 1, keyId: fingerprintPublicKeyHex(slot1Key.publicKeyHex), publicKeyHex: slot1Key.publicKeyHex },
  { slot: 2, keyId: fingerprintPublicKeyHex(slot2Key.publicKeyHex), publicKeyHex: slot2Key.publicKeyHex, retiredAt: SLOT2_RETIRED_AT },
]

function expectOk(slot) {
  return { ok: true, slot }
}
function expectReject(reason) {
  return { ok: false, reason }
}

const vectors = []

// 1. happy path: current slot
{
  const manifest = makeManifest()
  vectors.push({
    name: 'valid-current-slot',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectOk(1),
  })
}

// 2. happy path: previous slot still inside its retirement window
{
  const manifest = makeManifest()
  vectors.push({
    name: 'valid-previous-slot-within-retired-at',
    manifest,
    signature: signedBy(manifest, slot2Key, 2),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectOk(2),
  })
}

// 3. missing anti-replay field
{
  const manifest = makeManifest()
  delete manifest.envelope.notAfter
  vectors.push({
    name: 'missing-not-after',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('missing-field'),
  })
}

// 4. revision regression against the persisted per-source maximum
{
  const manifest = makeManifest()
  vectors.push({
    name: 'revision-regression',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 5 },
    expect: expectReject('revision-regression'),
  })
}

// 5. expired notAfter
{
  const manifest = makeManifest()
  vectors.push({
    name: 'expired-not-after',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: '2026-10-02T00:00:00.000Z', lastSeenRevision: 4 },
    expect: expectReject('expired'),
  })
}

// 6. domain mismatch (cross-source whole-manifest replay)
{
  const manifest = makeManifest()
  vectors.push({
    name: 'domain-mismatch',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: OTHER_DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('domain-mismatch'),
  })
}

// 7. issuedAt in the future
{
  const manifest = makeManifest({ envelope: { issuedAt: '2026-09-27T00:00:00Z' } })
  vectors.push({
    name: 'not-yet-valid',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('not-yet-valid'),
  })
}

// 8. envelope lifetime beyond the 7-day cap
{
  const manifest = makeManifest({ envelope: { notAfter: '2026-10-03T00:00:01Z' } }) // issuedAt + 8d + 1s
  vectors.push({
    name: 'ttl-exceeds-cap',
    manifest,
    signature: signedBy(manifest, slot1Key, 1),
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('ttl-exceeds-cap'),
  })
}

// 9. slot 2 used after its retirement moment
{
  const manifest = makeManifest()
  const slotsRetired = [
    slotsInOverlap[0],
    { ...slotsInOverlap[1], retiredAt: '2026-09-20T00:00:00Z' },
  ]
  vectors.push({
    name: 'slot-retired',
    manifest,
    signature: signedBy(manifest, slot2Key, 2),
    slots: slotsRetired,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('slot-retired'),
  })
}

// 10. keyId not present in any configured slot
{
  const manifest = makeManifest()
  const signature = signedBy(manifest, unknownKey, 1)
  vectors.push({
    name: 'unknown-key',
    manifest,
    signature,
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('unknown-key'),
  })
}

// 11. record claims slot 1 but carries slot 2's keyId
{
  const manifest = makeManifest()
  const signature = { ...signedBy(manifest, slot2Key, 2), slot: 1 }
  vectors.push({
    name: 'slot-key-mismatch',
    manifest,
    signature,
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('slot-key-mismatch'),
  })
}

// 12. manifest tampered after signing (sha manifest integrity)
{
  const manifest = makeManifest()
  const signature = signedBy(manifest, slot1Key, 1)
  const tampered = {
    ...manifest,
    files: [{ ...manifest.files[0], sha256: '1'.repeat(64) }],
  }
  vectors.push({
    name: 'tampered-manifest',
    manifest: tampered,
    signature,
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('invalid-signature'),
  })
}

// 13. unsupported signature record version
{
  const manifest = makeManifest()
  const signature = { ...signedBy(manifest, slot1Key, 1), version: SIGNATURE_VERSION + 1 }
  vectors.push({
    name: 'unsupported-signature-version',
    manifest,
    signature,
    slots: slotsInOverlap,
    context: { domain: DOMAIN, now: NOW, lastSeenRevision: 4 },
    expect: expectReject('invalid-signature'),
  })
}

const fixture = {
  fixtureVersion: 1,
  comment:
    'Shared signing test vectors (round3 R10). Consumed by market-server tests now and by the wrapper-side verifier test (dsh-plugin-huaanwork) later — the wrapper re-implements the same semantics over node:crypto and must reproduce every verdict. The private keys below are THROWAWAY test material, never reuse them as real signing keys. Regenerate with: node scripts/gen-test-vectors.mjs',
  domain: DOMAIN,
  keys: {
    slot1: keyFixture(slot1Key),
    slot2: keyFixture(slot2Key),
    unknown: keyFixture(unknownKey),
  },
  vectors,
}

const here = dirname(fileURLToPath(import.meta.url))
const outPath = join(here, '..', 'tests', 'fixtures', 'signing-vectors.json')
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${outPath} with ${vectors.length} vectors`)
