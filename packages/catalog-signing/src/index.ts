/**
 * Zero-dependency canonical-JSON and Ed25519 signing primitives.
 *
 * This is the single byte-compatible implementation shared by every side of
 * the intranet catalog toolchain (market-server today; the catalog server/CLI
 * and Desktop in later milestones). It owns only the generic primitives:
 *
 *   - `canonicalJson` — deterministic JSON serialization (object keys sorted
 *     recursively, no insignificant whitespace). The exact bytes that get
 *     signed.
 *   - Ed25519 key generation, raw-hex public-key conversion, fingerprinting,
 *     detached signing and verification over `node:crypto`.
 *   - The agent-package detached-signature record (`CatalogSignature`) and its
 *     keyring (`CatalogKeyringEntry`), with keyId-authoritative verification:
 *     the record's declared `slot` is operator metadata and never gates the
 *     verdict (ruling R-1 semantics, shared with the market envelope).
 *
 * Deliberately NOT here: the market anti-replay envelope, market manifest
 * types, `verifyWithKeySlots` and market-specific reason strings — those stay
 * in `market-server/src/signing.ts`. This package must stay dependency-free
 * (no `tar`, no market types, no Node types beyond `node:crypto`).
 *
 * Byte compatibility with the market implementation is pinned by
 * `market-server/tests/fixtures/signing-vectors.json` (fixtureVersion 3),
 * which this package reads and must reproduce exactly; the fixture is never
 * regenerated here.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${String(value)}`)
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
  }
}

/** Deterministic JSON serialization; the exact bytes that get signed. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value)
}

// ---------------------------------------------------------------------------
// Ed25519 primitives (node:crypto only, zero dependencies)
// ---------------------------------------------------------------------------

export interface GeneratedKeyPair {
  /** Raw 32-byte Ed25519 public key, lowercase hex — the pinnable format. */
  readonly publicKeyHex: string
  /** PKCS#8 PEM private key. Offline material: chmod 0600, never committed. */
  readonly privateKeyPem: string
}

export function generateKeyPair(): GeneratedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyHex: extractRawPublicKeyHex(publicKey),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  }
}

const ED25519_SPKI_DER_LENGTH = 44
const ED25519_RAW_KEY_LENGTH = 32

/** The pinned public-key format: 64 hex characters (raw 32-byte Ed25519 key). */
const ED25519_RAW_KEY_HEX_PATTERN = /^[0-9a-fA-F]{64}$/u

/** Extract the raw 32-byte key from an SPKI DER Ed25519 public key (last 32 bytes). */
export function extractRawPublicKeyHex(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  if (spki.length !== ED25519_SPKI_DER_LENGTH) {
    throw new Error(`unexpected Ed25519 SPKI length ${spki.length}`)
  }
  return spki.subarray(ED25519_SPKI_DER_LENGTH - ED25519_RAW_KEY_LENGTH).toString('hex')
}

/** sha256 hex fingerprint of the raw public key bytes; doubles as keyId. */
export function fingerprintPublicKeyHex(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')
}

/**
 * Rebuild a node KeyObject from the pinned raw-hex format (via JWK, no PEM
 * needed). NEVER throws: the pinned format is exactly 64 hex characters —
 * anything else (bad characters, wrong length, trailing garbage) returns null,
 * and callers must handle the null explicitly (verifyCanonical → false, the
 * verify chain → `invalid-signature`).
 */
export function publicKeyFromHex(publicKeyHex: string): KeyObject | null {
  if (!ED25519_RAW_KEY_HEX_PATTERN.test(publicKeyHex)) return null
  const raw = Buffer.from(publicKeyHex, 'hex')
  return createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
  })
}

/** Sign the canonical bytes of a payload with a PKCS#8 PEM private key. */
export function signCanonical(canonical: string, privateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64')
}

/**
 * Verify a base64 Ed25519 signature over the canonical bytes with a raw-hex
 * public key. A malformed key (null from publicKeyFromHex) answers false —
 * never a throw.
 */
export function verifyCanonical(canonical: string, signatureBase64: string, publicKeyHex: string): boolean {
  const publicKey = publicKeyFromHex(publicKeyHex)
  if (publicKey === null) return false
  return cryptoVerify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(signatureBase64, 'base64'))
}

// ---------------------------------------------------------------------------
// Agent-package detached signature + keyring
// ---------------------------------------------------------------------------

const SIGNATURE_VERSION = 1 as const
const SIGNATURE_ALGORITHM = 'Ed25519' as const

/** slot 1 = current key; slot 2 = previous (rotation) key. */
export type CatalogKeySlot = 1 | 2

/** One configured public key of the trust root. */
export interface CatalogKeyringEntry {
  /** = fingerprintPublicKeyHex(publicKeyHex); the authoritative key identifier. */
  readonly keyId: string
  /** Raw 32-byte Ed25519 public key, lowercase hex. */
  readonly publicKeyHex: string
  /** Declared slot. Verification resolves by keyId; this is metadata. */
  readonly slot: CatalogKeySlot
  /** Optional retirement moment (ISO 8601 UTC). At or after it the key rejects. */
  readonly retiredAt?: string
}

/** Detached signature record over an agent-package digest. */
export interface CatalogSignature {
  readonly version: typeof SIGNATURE_VERSION
  readonly algorithm: typeof SIGNATURE_ALGORITHM
  /** = fingerprintPublicKeyHex(publicKeyHex); the authoritative key identifier. */
  readonly keyId: string
  /** Operator bookkeeping metadata: verification resolves by keyId. */
  readonly slot: CatalogKeySlot
  /** ISO 8601 UTC signing time (bookkeeping; replay control belongs to envelopes). */
  readonly signedAt: string
  /** base64 of the 64-byte Ed25519 signature over utf8(canonicalJson(digest)). */
  readonly signature: string
}

/** Machine-readable rejection reasons of the agent-package verifier. */
export type CatalogSignatureRejectionReason =
  | 'unknown-key'
  | 'slot-retired'
  | 'invalid-signature'
  | 'invalid-timestamp'

export type CatalogSignatureVerdict =
  | { readonly ok: true; readonly slot: CatalogKeySlot }
  | { readonly ok: false; readonly reason: CatalogSignatureRejectionReason }

/** Raised by {@link parseCatalogKeyring} on any malformed keyring document. */
export class CatalogKeyringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogKeyringError'
  }
}

export interface SignAgentPackageDigestOptions {
  readonly privateKeyPem: string
  readonly slot: CatalogKeySlot
  /** ISO 8601 UTC signing time. */
  readonly signedAt: string
}

/**
 * Produce the detached signature record for an agent-package digest.
 * PRIVATE-KEY material path — only the offline signing tool may call this.
 * The keyId is derived from the private key's public half, so a wrong key can
 * never be silently accepted.
 */
export function signAgentPackageDigest(digest: unknown, options: SignAgentPackageDigestOptions): CatalogSignature {
  const publicKeyHex = extractRawPublicKeyHex(createPublicKey(createPrivateKey(options.privateKeyPem)))
  return {
    version: SIGNATURE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    keyId: fingerprintPublicKeyHex(publicKeyHex),
    slot: options.slot,
    signedAt: options.signedAt,
    signature: signCanonical(canonicalJson(digest), options.privateKeyPem),
  }
}

function isCatalogSignature(value: unknown): value is CatalogSignature {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === SIGNATURE_VERSION
    && record.algorithm === SIGNATURE_ALGORITHM
    && typeof record.keyId === 'string'
    && record.keyId.length > 0
    && (record.slot === 1 || record.slot === 2)
    && typeof record.signedAt === 'string'
    && typeof record.signature === 'string'
  )
}

function parseEpochMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Verify a detached agent-package signature against a keyring.
 *
 * KeyId-authoritative: the key is looked up by `signature.keyId` across ALL
 * keyring slots and the entry's declared `slot` is reported as metadata only.
 * Any entry with a `retiredAt` at or before `now` rejects (`slot-retired`),
 * regardless of which slot number it declares. Fail-closed: unknown keys,
 * malformed records/signatures and unparseable timestamps all reject.
 */
export function verifyAgentPackageDigestSignature(
  digest: unknown,
  signature: unknown,
  keyring: readonly CatalogKeyringEntry[],
  now: number = Date.now(),
): CatalogSignatureVerdict {
  if (!isCatalogSignature(signature)) return { ok: false, reason: 'invalid-signature' }
  if (parseEpochMs(signature.signedAt) === null) return { ok: false, reason: 'invalid-timestamp' }

  const entry = keyring.find((candidate) => candidate.keyId === signature.keyId)
  if (entry === undefined) return { ok: false, reason: 'unknown-key' }

  if (entry.retiredAt !== undefined) {
    const retiredAtMs = parseEpochMs(entry.retiredAt)
    if (retiredAtMs === null) return { ok: false, reason: 'invalid-timestamp' }
    if (now >= retiredAtMs) return { ok: false, reason: 'slot-retired' }
  }

  if (!verifyCanonical(canonicalJson(digest), signature.signature, entry.publicKeyHex)) {
    return { ok: false, reason: 'invalid-signature' }
  }

  return { ok: true, slot: entry.slot }
}

/**
 * Parse an operator keyring document: `{ schemaVersion: 1, keys: [...] }`.
 *
 * Enforces the trust-root invariants: each `keyId` equals the sha256
 * fingerprint of its 64-hex public key, keyIds are unique, exactly one key
 * occupies slot 1 and at most one occupies slot 2, and `retiredAt` (when
 * present) is parseable. Anything else throws {@link CatalogKeyringError}.
 */
export function parseCatalogKeyring(raw: unknown): CatalogKeyringEntry[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CatalogKeyringError('catalog keyring must be an object')
  }
  const document = raw as Record<string, unknown>
  if (document.schemaVersion !== 1) {
    throw new CatalogKeyringError('catalog keyring schemaVersion must be 1')
  }
  const keys = document.keys
  if (!Array.isArray(keys)) {
    throw new CatalogKeyringError('catalog keyring keys must be an array')
  }
  if (keys.length === 0) {
    throw new CatalogKeyringError('catalog keyring must contain at least one key')
  }

  const entries: CatalogKeyringEntry[] = []
  const seenKeyIds = new Set<string>()
  for (const [index, value] of keys.entries()) {
    const label = `catalog keyring keys[${index}]`
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CatalogKeyringError(`${label} must be an object`)
    }
    const key = value as Record<string, unknown>
    if (key.slot !== 1 && key.slot !== 2) {
      throw new CatalogKeyringError(`${label} slot must be 1 or 2`)
    }
    if (typeof key.publicKeyHex !== 'string' || !ED25519_RAW_KEY_HEX_PATTERN.test(key.publicKeyHex)) {
      throw new CatalogKeyringError(`${label} publicKeyHex must be 64 hex characters`)
    }
    if (typeof key.keyId !== 'string') {
      throw new CatalogKeyringError(`${label} keyId must be a string`)
    }
    if (key.keyId !== fingerprintPublicKeyHex(key.publicKeyHex)) {
      throw new CatalogKeyringError(`${label} keyId does not match the public key fingerprint`)
    }
    if (seenKeyIds.has(key.keyId)) {
      throw new CatalogKeyringError(`${label} keyId is duplicated`)
    }
    seenKeyIds.add(key.keyId)

    const entry: { keyId: string; publicKeyHex: string; slot: CatalogKeySlot; retiredAt?: string } = {
      keyId: key.keyId,
      publicKeyHex: key.publicKeyHex,
      slot: key.slot,
    }
    if (key.retiredAt !== undefined) {
      if (typeof key.retiredAt !== 'string') {
        throw new CatalogKeyringError(`${label} retiredAt must be an ISO 8601 string`)
      }
      if (parseEpochMs(key.retiredAt) === null) {
        throw new CatalogKeyringError(`${label} retiredAt is not a parseable timestamp`)
      }
      entry.retiredAt = key.retiredAt
    }
    entries.push(entry)
  }

  const currentKeys = entries.filter((entry) => entry.slot === 1).length
  if (currentKeys !== 1) {
    throw new CatalogKeyringError(`catalog keyring must declare exactly one slot 1 key (found ${currentKeys})`)
  }
  const previousKeys = entries.filter((entry) => entry.slot === 2).length
  if (previousKeys > 1) {
    throw new CatalogKeyringError(`catalog keyring must declare at most one slot 2 key (found ${previousKeys})`)
  }

  return entries
}
