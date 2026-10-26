/**
 * Task 4: deep validation of the persisted `CatalogState` (M-3) and
 * request-bound mutations (I-5).
 *
 * A syntactically valid state document is still operator data: a `null` record,
 * an unknown status, or a key that disagrees with its own record means the file
 * was edited or written by something other than this store. Every such document
 * must be refused at startup with `StoreCorruptError` and left byte-for-byte
 * untouched — the server never "repairs" state by dropping or re-keying records.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { CatalogStore, StoreCorruptError, emptyCatalogState } from '../src/store.ts'
import type { CatalogState } from '../src/types.ts'

const NOW = '2026-10-25T00:00:00.000Z'
const SUBMISSION_ID = '00000000-0000-4000-8000-000000000001'
const DELIST_ID = '00000000-0000-4000-8000-000000000002'

/** The minimum digest shape the server consumes (approve counts `files`). */
function digestRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    slug: 'a',
    version: '1.0.0',
    manifestSha256: '0'.repeat(64),
    files: [{ path: 'agent.json', size: 1, sha256: '0'.repeat(64) }],
  }
}

/** The minimum shape `parseState` requires of a published package. */
function publishedRecord(): Record<string, unknown> {
  return {
    slug: 'a',
    version: '1.0.0',
    manifest: { schemaVersion: 1, slug: 'a', version: '1.0.0' },
    digest: digestRecord(),
    signature: {
      version: 1,
      algorithm: 'ed25519',
      keyId: 'test-key',
      slot: 1,
      signedAt: NOW,
      signature: '00',
    },
    status: 'published',
    size: 1,
    updatedAt: NOW,
    actor: 'administrator',
  }
}

function revocationRecord(slug: string, version: string): Record<string, unknown> {
  return { slug, version, reason: 'unsafe', revokedAt: NOW, actor: 'administrator' }
}

function submissionRecord(): Record<string, unknown> {
  return {
    id: SUBMISSION_ID,
    slug: 'a',
    version: '1.0.0',
    status: 'pending-review',
    submittedAt: NOW,
    updatedAt: NOW,
    actor: 'publisher',
    digest: digestRecord(),
  }
}

function delistRecord(id: string): Record<string, unknown> {
  return {
    id,
    slug: 'a',
    version: '1.0.0',
    status: 'pending',
    reason: 'please withdraw',
    actor: 'publisher',
    createdAt: NOW,
  }
}

async function writeDocument(path: string, document: unknown): Promise<string> {
  const contents = `${JSON.stringify(document)}\n`
  await writeFile(path, contents, 'utf8')
  return contents
}

test('rejects syntactically valid state with semantic corruption and leaves the file untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-store-'))
  const path = join(dir, 'state.json')
  const base = emptyCatalogState()
  const cases: unknown[] = [
    { ...base, submissions: { x: null } },
    { ...base, packages: { 'a/1.0.0': { ...publishedRecord(), status: 'unknown' } } },
    { ...base, revocations: { 'wrong/1.0.0': revocationRecord('actual', '1.0.0') } },
  ]
  for (const document of cases) {
    const contents = await writeDocument(path, document)
    await assert.rejects(CatalogStore.open(dir), StoreCorruptError)
    assert.equal(await readFile(path, 'utf8'), contents)
  }
})

test('reports the precise corrupt field for missing fields, bad enums and mismatched keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-store-'))
  const path = join(dir, 'state.json')
  const base = emptyCatalogState()

  const missingId = submissionRecord()
  delete missingId.id
  const missingSlug = publishedRecord()
  delete missingSlug.slug
  const mismatchedDelist = { ...delistRecord(DELIST_ID), id: 'another-id' }
  const invalidSubmissionStatus = { ...submissionRecord(), status: 'archived' }
  const invalidDelistStatus = { ...delistRecord(DELIST_ID), status: 'unknown' }
  const missingManifest = publishedRecord()
  delete missingManifest.manifest
  // `approve` counts digest.files synchronously; a malformed digest used to
  // pass startup and fail that request with a 500.
  const missingDigestFiles = submissionRecord()
  delete (missingDigestFiles.digest as Record<string, unknown>).files
  const malformedDigestFile = publishedRecord()
  malformedDigestFile.digest = { ...digestRecord(), files: [{ path: 42, size: 1, sha256: '0'.repeat(64) }] }

  const cases: ReadonlyArray<{ readonly field: RegExp; readonly document: unknown }> = [
    { field: /submissions\..*\.id/u, document: { ...base, submissions: { [SUBMISSION_ID]: missingId } } },
    {
      field: /submissions\..*\.status is invalid/u,
      document: { ...base, submissions: { [SUBMISSION_ID]: invalidSubmissionStatus } },
    },
    { field: /packages\..*\.slug/u, document: { ...base, packages: { 'a/1.0.0': missingSlug } } },
    { field: /packages\..*\.manifest/u, document: { ...base, packages: { 'a/1.0.0': missingManifest } } },
    {
      field: /submissions\..*\.digest\.files must be an array/u,
      document: { ...base, submissions: { [SUBMISSION_ID]: missingDigestFiles } },
    },
    {
      field: /packages\..*\.digest\.files\[0\]\.path/u,
      document: { ...base, packages: { 'a/1.0.0': malformedDigestFile } },
    },
    {
      field: /delistRequests\..*\.id/u,
      document: { ...base, delistRequests: { [DELIST_ID]: mismatchedDelist } },
    },
    {
      field: /delistRequests\..*\.status is invalid/u,
      document: { ...base, delistRequests: { [DELIST_ID]: invalidDelistStatus } },
    },
    {
      field: /revocations\.wrong\/1\.0\.0/u,
      document: { ...base, revocations: { 'wrong/1.0.0': revocationRecord('actual', '1.0.0') } },
    },
    {
      field: /lastMutation\.requestId/u,
      document: {
        ...base,
        lastMutation: { requestId: '', action: 'agentPackages.revoke', at: NOW },
      },
    },
  ]

  for (const { field, document } of cases) {
    const contents = await writeDocument(path, document)
    await assert.rejects(
      CatalogStore.open(dir),
      (cause: unknown) => cause instanceof StoreCorruptError && field.test(cause.message),
    )
    assert.equal(await readFile(path, 'utf8'), contents)
  }
})

test('accepts every legal record shape including optional fields and lastMutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-store-'))
  const path = join(dir, 'state.json')
  const document: CatalogState = {
    schemaVersion: 1,
    lastMutation: { requestId: 'request-1', action: 'agentPackages.submissions.reject', at: NOW },
    submissions: {
      [SUBMISSION_ID]: {
        ...(submissionRecord() as unknown as CatalogState['submissions'][string]),
        status: 'rejected',
        reason: 'needs work',
        migrationFrom: 'legacy-agent',
      },
    },
    packages: {
      'a/1.0.0': {
        ...(publishedRecord() as unknown as CatalogState['packages'][string]),
        status: 'delisted',
        migrationFrom: 'legacy-agent',
      },
    },
    delistRequests: {
      [DELIST_ID]: {
        ...(delistRecord(DELIST_ID) as unknown as CatalogState['delistRequests'][string]),
        status: 'rejected',
        resolvedAt: NOW,
      },
    },
    revocations: {
      'a/1.0.0': revocationRecord('a', '1.0.0') as unknown as CatalogState['revocations'][string],
    },
  }
  await writeDocument(path, document)

  const store = await CatalogStore.open(dir)
  assert.deepEqual(store.read(), document)
})

test('mutate records the committing request id and a failed mutator commits nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-store-'))
  const store = await CatalogStore.open(dir)

  await store.mutate('request-1', 'agentPackages.revoke', draft => {
    draft.revocations['a/1.0.0'] = revocationRecord('a', '1.0.0') as unknown as CatalogState['revocations'][string]
  })

  const committed = store.read()
  assert.equal(committed.lastMutation?.requestId, 'request-1')
  assert.equal(committed.lastMutation?.action, 'agentPackages.revoke')
  assert.equal(typeof committed.lastMutation?.at, 'string')
  assert.equal(Number.isNaN(Date.parse(committed.lastMutation?.at ?? '')), false)

  await assert.rejects(
    store.mutate('request-2', 'agentPackages.revoke', draft => {
      draft.revocations['b/1.0.0'] = {
        ...(revocationRecord('b', '1.0.0') as unknown as CatalogState['revocations'][string]),
      }
      throw new Error('mutator exploded')
    }),
    /mutator exploded/u,
  )

  const afterFailure = store.read()
  assert.equal(afterFailure.lastMutation?.requestId, 'request-1')
  assert.equal(afterFailure.revocations['b/1.0.0'], undefined)

  // The committed document (including lastMutation) must survive a restart.
  const reopened = await CatalogStore.open(dir)
  assert.equal(reopened.read().lastMutation?.requestId, 'request-1')
  assert.equal(reopened.read().revocations['a/1.0.0']?.reason, 'unsafe')
})
