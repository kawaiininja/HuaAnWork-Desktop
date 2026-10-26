/**
 * Signing trust anchor for the M5 intranet market (market-server side).
 *
 * Trust model (round3 R9): TRUE offline two-step release flow. The Ed25519
 * private key NEVER enters the market-server process and is never read by any
 * server-side code path — the server only holds the configured public key(s).
 * The private key lives on the signing operator's offline machine and is used
 * exclusively by `scripts/sign-manifest.mjs`.
 *
 * The wrapper side (dsh-plugin-huaanwork) MUST NOT import this file
 * (dependency-direction guard). The wrapper re-implements the same semantics
 * over `node:crypto`; cross-side consistency is proven by the shared test
 * vectors in `tests/fixtures/signing-vectors.json` (round3 R10).
 *
 * Envelope anti-replay (round3 R3 + round4 M3', round5 N7):
 *   - `domain`    = the configured source origin; a manifest replayed across
 *                   sources fails the domain check outright.
 *   - `revision`  = monotonic per source; replaying an older revision fails
 *                   against the persisted per-source maximum. Re-reading the
 *                   CURRENT revision is idempotent and accepted (final-review
 *                   ruling 2026-09-26, spec §14 第十轮 第 49 条): only
 *                   `revision < lastSeenRevision` rejects.
 *   - `issuedAt` / `notAfter` = validity window; expired manifests are
 *                   rejected. The TTL cap (notAfter - issuedAt) is at most
 *                   MAX_ENVELOPE_TTL (7 days) — the maximum exposure window
 *                   of a leaked signing key. `not-yet-valid` carries a small
 *                   clock-skew grace (CLOCK_SKEW_GRACE_MS, Task 6.5 P10): the
 *                   signing machine is expected to run NTP, and the grace is
 *                   the mechanism backstop for a clock that is a moment fast.
 *
 * Two-slot rotation, keyId-authoritative (ruling R-1, spec §14 entry 63):
 *   - slot 1 = current key; slot 2 = previous key, valid only until its
 *     `retiredAt` moment (one app-release window after rotation).
 *   - The keyId resolves the key against ALL configured slots; the declared
 *     slot in the signature record is operator bookkeeping (metadata) and does
 *     not gate the verdict. `retiredAt` is judged on the RESOLVED slot: after
 *     it, that key's signatures are rejected by machine-checkable rule
 *     (round4 C3). Unknown keys are rejected.
 *
 * Canonical form: the signature covers `canonicalJson(manifest)` — a
 * deterministic JSON serialization (object keys sorted recursively, no
 * insignificant whitespace). The canonicalizer and the Ed25519 primitives are
 * the zero-dependency shared implementation in `@huaanwork/catalog-signing`
 * (packages/catalog-signing); this module keeps only the market-owned trust
 * surface (envelope, manifest types, reason strings, `verifyWithKeySlots`,
 * `signManifest`) and re-exports the generic primitives for existing callers.
 * Both the offline signer and the verifiers (server-side Task 2, wrapper-side
 * Task 4/5) must use the same canonicalization.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import {
  canonicalJson,
  extractRawPublicKeyHex,
  fingerprintPublicKeyHex,
  generateKeyPair,
  publicKeyFromHex,
  signCanonical,
  verifyCanonical,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'

// ---------------------------------------------------------------------------
// Constants (normative; mirrored by the wrapper verifier)
// ---------------------------------------------------------------------------

export const ENVELOPE_VERSION = 1 as const
export const SIGNATURE_VERSION = 1 as const
export const SIGNATURE_ALGORITHM = 'Ed25519' as const

/** Maximum envelope lifetime: notAfter - issuedAt <= 7 days (round5 N7). */
export const MAX_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Clock-skew grace on `not-yet-valid` (Task 6.5, P10): an offline signing
 * machine whose clock runs a little fast would otherwise fail every intake
 * with an attack-flavored reason code. A manifest whose `issuedAt` is at most
 * this far in the future is accepted; the operational counterpart is the NTP
 * precondition in docs/market-server-deployment.md (the grace is a mechanism
 * backstop, not a reason to skip time synchronization). Mirrored by the
 * wrapper verifier under the same name.
 */
export const CLOCK_SKEW_GRACE_MS = 30_000

/** Rotation overlap: slot 2 survives one app-release window via `retiredAt`. */
export type KeySlotNumber = 1 | 2

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Anti-replay envelope header. `domain` is the configured source origin. */
export interface MarketEnvelope {
  readonly version: number
  readonly domain: string
  /** Monotonic per source; integer >= 1. */
  readonly revision: number
  /** ISO 8601 UTC. */
  readonly issuedAt: string
  /** ISO 8601 UTC; must satisfy notAfter <= issuedAt + MAX_ENVELOPE_TTL_MS. */
  readonly notAfter: string
}

/**
 * Catalog payload. The `catalog` member of the signed manifest is a
 * provider-page compatible load (schemaVersion/items/page) — it must pass
 * `parseCatalogProviderPage` after the envelope/files sidecar is detached
 * (the strict schema has `additionalProperties: false` at the top level, so
 * the sidecar must NEVER be merged into this body — Task 2 ruling).
 * Signing treats the payload as opaque records.
 */
export interface MarketCatalogPayload {
  readonly schemaVersion: '1.0.0'
  readonly generatedAt: string
  readonly items: readonly Record<string, unknown>[]
  readonly page: { readonly total: number }
}

/** One hosted artifact entry in the sha manifest. */
export interface MarketManifestFile {
  readonly name: string
  readonly version: string
  /** Lowercase hex sha256 of the artifact bytes. */
  readonly sha256: string
  /** Server-relative tarball path, e.g. `/artifacts/<name>-<version>.tgz`. */
  readonly tarballPath: string
  readonly size: number
}

/**
 * The signed manifest: anti-replay envelope + catalog payload + sha manifest.
 * The DETACHED signature record lives outside this document (sidecar), so the
 * strict contract schema never carries signature material.
 */
export interface MarketManifest {
  readonly envelope: MarketEnvelope
  readonly catalog: MarketCatalogPayload
  readonly files: readonly MarketManifestFile[]
}

/** Detached signature sidecar for a MarketManifest. */
export interface MarketManifestSignature {
  readonly version: number
  readonly algorithm: typeof SIGNATURE_ALGORITHM
  /** = fingerprintPublicKeyHex(publicKeyHex); the authoritative key identifier. */
  readonly keyId: string
  /** Operator bookkeeping metadata: verification resolves by keyId (ruling R-1). */
  readonly slot: KeySlotNumber
  /** ISO 8601 UTC signing time (operator bookkeeping; replay control is the envelope's job). */
  readonly signedAt: string
  /** base64 of the 64-byte Ed25519 signature over utf8(canonicalJson(manifest)). */
  readonly signature: string
}

/** A configured key slot (public material only — the server never holds private keys). */
export interface KeySlotConfig {
  readonly slot: KeySlotNumber
  /** sha256 hex fingerprint of the raw 32-byte Ed25519 public key. */
  readonly keyId: string
  /** Raw 32-byte Ed25519 public key, lowercase hex. This is the pinnable format. */
  readonly publicKeyHex: string
  /** Slot 2 only: retirement moment (ISO 8601 UTC). After this instant the slot rejects. */
  readonly retiredAt?: string
}

// ---------------------------------------------------------------------------
// Verdict types (stable machine-readable reasons; mirrored by the wrapper)
// ---------------------------------------------------------------------------

export type EnvelopeRejectionReason =
  | 'missing-field'
  | 'unsupported-envelope-version'
  | 'invalid-revision'
  | 'revision-regression'
  | 'invalid-timestamp'
  | 'domain-mismatch'
  | 'not-yet-valid'
  | 'expired'
  | 'ttl-exceeds-cap'

export type SlotRejectionReason =
  | 'unknown-key'
  | 'slot-retired'
  | 'invalid-signature'

export type VerificationReason = EnvelopeRejectionReason | SlotRejectionReason

export type EnvelopeVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: EnvelopeRejectionReason }

export type VerificationVerdict =
  | { readonly ok: true; readonly slot: KeySlotNumber }
  | { readonly ok: false; readonly reason: VerificationReason }

export interface VerificationContext {
  /** The configured source origin the envelope domain must equal. */
  readonly domain: string
  /** Verification instant, epoch milliseconds (injectable for tests/determinism). */
  readonly now: number
  /** Persisted per-source maximum revision already accepted; replaying < this rejects (equal = idempotent re-read, accepted). */
  readonly lastSeenRevision?: number
}

// ---------------------------------------------------------------------------
// Generic primitives (canonical JSON + Ed25519)
//
// The byte-compatible implementation lives in the zero-dependency shared
// package `@huaanwork/catalog-signing` (packages/catalog-signing); it is
// re-exported here so existing market-server callers keep the same surface.
// The P9 "publicKeyFromHex never throws" contract is implemented in the shared
// package and still pinned end-to-end by market-server's own signing tests
// through this re-export.
// ---------------------------------------------------------------------------

export {
  canonicalJson,
  fingerprintPublicKeyHex,
  generateKeyPair,
  publicKeyFromHex,
  signCanonical,
  verifyCanonical,
}
export type { GeneratedKeyPair }

// ---------------------------------------------------------------------------
// Envelope anti-replay: pure field check
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parse an ISO-8601 string to unix epoch milliseconds, returning null if invalid.
 * Reused by `/healthz` to compute remaining envelope lifetime (M11).
 */
export function parseEpochMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Pure anti-replay field check on the envelope. Fail-closed: any malformed,
 * mismatched, regressed or expired envelope rejects with a stable reason.
 */
export function checkEnvelope(envelope: unknown, context: VerificationContext): EnvelopeVerdict {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return { ok: false, reason: 'missing-field' }
  }
  const env = envelope as Record<string, unknown>

  if (env.version !== ENVELOPE_VERSION) return { ok: false, reason: 'unsupported-envelope-version' }
  if (!isNonEmptyString(env.domain)) return { ok: false, reason: 'missing-field' }
  if (env.revision === undefined || env.revision === null) return { ok: false, reason: 'missing-field' }
  if (typeof env.revision !== 'number' || !Number.isInteger(env.revision) || env.revision < 1) {
    return { ok: false, reason: 'invalid-revision' }
  }
  if (!isNonEmptyString(env.issuedAt) || !isNonEmptyString(env.notAfter)) {
    return { ok: false, reason: 'missing-field' }
  }

  if (env.domain !== context.domain) return { ok: false, reason: 'domain-mismatch' }

  const issuedAtMs = parseEpochMs(env.issuedAt)
  const notAfterMs = parseEpochMs(env.notAfter)
  if (issuedAtMs === null || notAfterMs === null) return { ok: false, reason: 'invalid-timestamp' }
  if (notAfterMs <= issuedAtMs) return { ok: false, reason: 'invalid-timestamp' }
  if (notAfterMs - issuedAtMs > MAX_ENVELOPE_TTL_MS) return { ok: false, reason: 'ttl-exceeds-cap' }

  if (context.lastSeenRevision !== undefined && env.revision < context.lastSeenRevision) {
    return { ok: false, reason: 'revision-regression' }
  }

  // P10: a signing machine whose clock runs a little fast must not fail every
  // intake with an attack-flavored reason code — a small grace window applies
  // to `not-yet-valid` (the NTP precondition in the runbook is the real fix).
  if (context.now < issuedAtMs - CLOCK_SKEW_GRACE_MS) return { ok: false, reason: 'not-yet-valid' }
  if (context.now > notAfterMs) return { ok: false, reason: 'expired' }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// KeyId-authoritative rotation verification (ruling R-1; the record's
// declared slot is metadata, not a gate)
// ---------------------------------------------------------------------------

function findSlotByKeyId(slots: readonly KeySlotConfig[], keyId: string): KeySlotConfig | undefined {
  return slots.find((slot) => slot.keyId === keyId)
}

/**
 * KeyId-authoritative verification (ruling R-1): the detached signature and the
 * RESOLVED slot's `retiredAt` retirement moment — plus the anti-replay envelope
 * check. The keyId resolves the signer against all configured slots; the slot
 * the record claims is metadata and never gates the verdict. Fail-closed at
 * every step; the manifest's sha manifest may be trusted only when this
 * returns ok.
 */
export function verifyWithKeySlots(
  manifest: MarketManifest,
  signatureRecord: MarketManifestSignature,
  slots: readonly KeySlotConfig[],
  context: VerificationContext,
): VerificationVerdict {
  const envelope = checkEnvelope(manifest.envelope, context)
  if (!envelope.ok) return envelope

  // Shape guard first: a malformed record (or a malformed configured key, P9:
  // `publicKeyFromHex` returns null and `verifyCanonical` answers false) must
  // yield a verdict, never throw (Task 2 intake pre-validates too; this is the
  // defense-in-depth layer).
  if (typeof signatureRecord !== 'object' || signatureRecord === null) {
    return { ok: false, reason: 'invalid-signature' }
  }
  if (
    signatureRecord.version !== SIGNATURE_VERSION
    || signatureRecord.algorithm !== SIGNATURE_ALGORITHM
    || typeof signatureRecord.keyId !== 'string'
    || (signatureRecord.slot !== 1 && signatureRecord.slot !== 2)
    || typeof signatureRecord.signature !== 'string'
  ) {
    return { ok: false, reason: 'invalid-signature' }
  }

  // Resolve the keyId against ALL configured slots: the resolved slot is
  // authoritative; the record's claimed slot is metadata (ruling R-1).
  const slot = findSlotByKeyId(slots, signatureRecord.keyId)
  if (slot === undefined) return { ok: false, reason: 'unknown-key' }

  if (slot.slot === 2 && slot.retiredAt !== undefined) {
    const retiredAtMs = parseEpochMs(slot.retiredAt)
    if (retiredAtMs === null) return { ok: false, reason: 'invalid-timestamp' }
    if (context.now >= retiredAtMs) return { ok: false, reason: 'slot-retired' }
  }

  const canonical = canonicalJson(manifest)
  if (!verifyCanonical(canonical, signatureRecord.signature, slot.publicKeyHex)) {
    return { ok: false, reason: 'invalid-signature' }
  }

  return { ok: true, slot: slot.slot }
}

// ---------------------------------------------------------------------------
// Offline signing helper (used by scripts/sign-manifest.mjs and tests only)
// ---------------------------------------------------------------------------

export interface SignManifestOptions {
  readonly privateKeyPem: string
  readonly slot: KeySlotNumber
  /** ISO 8601 UTC signing time. */
  readonly signedAt: string
}

/**
 * Produce the detached signature record for a manifest. PRIVATE-KEY material
 * path — only the offline signing tool may call this; the market-server
 * process never holds the private key (round3 R9).
 */
export function signManifest(manifest: MarketManifest, options: SignManifestOptions): MarketManifestSignature {
  // Derive the public half from the private key so keyId always matches the signer.
  const publicKeyHex = extractRawPublicKeyHex(createPublicKey(createPrivateKey(options.privateKeyPem)))
  return {
    version: SIGNATURE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    keyId: fingerprintPublicKeyHex(publicKeyHex),
    slot: options.slot,
    signedAt: options.signedAt,
    signature: signCanonical(canonicalJson(manifest), options.privateKeyPem),
  }
}
