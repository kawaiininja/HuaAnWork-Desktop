/**
 * Two-step offline-signed release flow (Task 2 Step 2).
 *
 * The market-server NEVER signs anything (round3 R9: the private key never
 * enters this process). It only:
 *
 *   PREPARE  — build the canonical PENDING manifest: sha256 of every hosted
 *              artifact + the anti-replay envelope (`domain` = the configured
 *              public origin, `revision` = persisted per-source max + 1,
 *              `issuedAt`/`notAfter` with TTL ≤ 7 days) + the provider-page
 *              catalog payload. Stored in the pending slot — NOT active.
 *   INTAKE   — verify an uploaded DETACHED signature record against the
 *              STORED pending manifest with the configured public key slot
 *              (three-input two-slot verdict from signing.ts, envelope
 *              negatives included). Only a fully valid verdict ACTIVATES:
 *              the manifest + signature become the served pair and the
 *              persisted max revision advances. Fail-closed otherwise — a
 *              manifest without a valid signature is NEVER activated.
 *
 * Manifest wire shape (sidecar ruling, Task 5 Step 1):
 *
 *   { "envelope": {...anti-replay...},
 *     "catalog": { "schemaVersion":"1.0.0", "generatedAt", "items", "page" },
 *     "files": [{ "name", "version", "sha256", "tarballPath", "size" }] }
 *
 * `catalog` alone passes `parseCatalogProviderPage`; `envelope`/`files` are
 * sidecar siblings (the strict schema has additionalProperties:false, so the
 * wrapper detaches them before parsing — proven by tests).
 */

import {
  ENVELOPE_VERSION,
  MAX_ENVELOPE_TTL_MS,
  fingerprintPublicKeyHex,
  verifyWithKeySlots,
  type KeySlotConfig,
  type MarketManifest,
  type MarketManifestFile,
  type MarketManifestSignature,
} from './signing.ts'
import type { CatalogService } from './catalog/service.ts'
import type { CatalogStore } from './catalog/store.ts'
import type { MarketServerConfig } from './config.ts'

/**
 * The signed manifest carries at most one provider page — the UPSTREAM
 * CONTRACT maximum (`items` `maxItems: 200` in
 * dsh-community-market's catalog-provider-page schema), not this service's
 * implementation choice. This constant is the single definition of the
 * contract default/ceiling: `config.ts` defaults the effective cap
 * (`MarketServerConfig.maxCatalogEntries`) to it and refuses startup with any
 * higher value, and both caps below read the effective value from config
 * (Task 6.4, ruling R-3).
 */
export const MAX_MANIFEST_ENTRIES = 200

export class ManifestPrepareError extends Error {
  readonly code: 'catalog-too-large' | 'artifact-missing'

  constructor(code: ManifestPrepareError['code'], message: string) {
    super(message)
    this.name = 'ManifestPrepareError'
    this.code = code
  }
}

export type IntakeVerdict =
  | { readonly ok: true; readonly revision: number; readonly slot: 1 | 2 }
  | { readonly ok: false; readonly reason: string }

/** The single configured public key is slot 1 (M5 single-source ruling). */
export function keySlotsFromConfig(config: MarketServerConfig): readonly KeySlotConfig[] {
  return [
    {
      slot: 1,
      keyId: fingerprintPublicKeyHex(config.verifyPublicKeyHex),
      publicKeyHex: config.verifyPublicKeyHex,
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the canonical pending manifest. `artifactSize` resolves the stored
 * size of a hosted artifact file name (null = missing on disk → fail closed:
 * an entry pointing at a vanished artifact blocks the release). `maxEntries`
 * is the effective catalog scale cap from config (default = the contract
 * maximum); it bounds both the guard and the provider page built here.
 */
export async function buildPendingManifest(args: {
  readonly store: CatalogStore
  readonly catalog: CatalogService
  readonly domain: string
  readonly now: Date
  readonly maxEntries: number
  readonly artifactSize: (fileName: string) => Promise<number | null>
}): Promise<MarketManifest> {
  const entries = args.store.entries()
  if (entries.length > args.maxEntries) {
    throw new ManifestPrepareError(
      'catalog-too-large',
      `this source has ${String(entries.length)} entries but the configured catalog cap is ${String(args.maxEntries)} ` +
        `(a signed manifest carries one provider page; the upstream contract pins \`items\` to maxItems: ${String(MAX_MANIFEST_ENTRIES)}). ` +
        'Split the source before releasing — paginated / multi-page manifests are not implemented (ruling R-3).',
    )
  }

  const page = args.catalog.query({ limit: args.maxEntries })
  const files: MarketManifestFile[] = []
  for (const entry of entries) {
    if (entry.sha256 === undefined || entry.tarball === undefined) continue
    const size = await args.artifactSize(entry.tarball)
    if (size === null) {
      throw new ManifestPrepareError(
        'artifact-missing',
        `catalog entry ${entry.id} points at artifact ${entry.tarball} which is not on disk; ` +
          're-publish the artifact or unpublish the entry before releasing.',
      )
    }
    files.push({
      name: entry.packageName,
      version: entry.version,
      sha256: entry.sha256,
      tarballPath: `/artifacts/${entry.tarball}`,
      size,
    })
  }

  const issuedAtMs = args.now.getTime()
  return {
    envelope: {
      version: ENVELOPE_VERSION,
      domain: args.domain,
      revision: args.store.maxRevision() + 1,
      issuedAt: args.now.toISOString(),
      notAfter: new Date(issuedAtMs + MAX_ENVELOPE_TTL_MS).toISOString(),
    },
    catalog: {
      schemaVersion: '1.0.0',
      generatedAt: args.now.toISOString(),
      items: page.items as readonly Record<string, unknown>[],
      page: { total: page.page.total ?? page.items.length },
    },
    files,
  }
}

/** PREPARE step: build + persist the canonical pending manifest. */
export async function preparePendingManifest(args: {
  readonly store: CatalogStore
  readonly catalog: CatalogService
  readonly config: MarketServerConfig
  readonly now?: Date
  readonly artifactSize: (fileName: string) => Promise<number | null>
}): Promise<MarketManifest> {
  const now = args.now ?? new Date()
  const manifest = await buildPendingManifest({
    store: args.store,
    catalog: args.catalog,
    domain: args.config.publicOrigin,
    now,
    maxEntries: args.config.maxCatalogEntries,
    artifactSize: args.artifactSize,
  })
  await args.store.setPendingManifest(manifest)
  return manifest
}

/**
 * INTAKE step: verify an uploaded detached signature record against the
 * STORED pending manifest and, ONLY on a fully valid verdict, activate.
 * Fail-closed: any envelope negative, key/slot problem, or signature
 * mismatch returns {ok:false, reason} and nothing is activated.
 */
export async function intakeSignature(args: {
  readonly store: CatalogStore
  readonly config: MarketServerConfig
  readonly signatureRecord: unknown
  readonly nowMs?: number
}): Promise<IntakeVerdict> {
  const pending = args.store.pendingManifest()
  if (!isRecord(pending) || !isRecord(pending.envelope)) {
    return { ok: false, reason: 'no-pending-manifest' }
  }
  const envelope = pending.envelope
  if (typeof envelope.revision !== 'number' || !Number.isInteger(envelope.revision) || envelope.revision < 1) {
    return { ok: false, reason: 'invalid-revision' }
  }

  const verdict = verifyWithKeySlots(
    pending as unknown as MarketManifest,
    args.signatureRecord as MarketManifestSignature,
    keySlotsFromConfig(args.config),
    {
      domain: args.config.publicOrigin,
      now: args.nowMs ?? Date.now(),
      lastSeenRevision: args.store.maxRevision(),
    },
  )
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  await args.store.activate(pending, args.signatureRecord, envelope.revision)
  return { ok: true, revision: envelope.revision, slot: verdict.slot }
}
