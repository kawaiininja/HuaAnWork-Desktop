/**
 * Task 5: reviewed and signed agent package publishing.
 *
 * Every assertion goes through the REAL HTTP surface (`tests/helpers.ts`) and
 * a dynamically generated Ed25519 keypair; no token, key or bundle in this file
 * is production material. The server must never trust a client-supplied digest:
 * each expectation compares against the digest recomputed from the uploaded
 * bytes by `inspectUnsignedAgentPackageBundle`.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  MAX_AGENT_PACKAGE_BUNDLE_BYTES,
  buildSignedAgentPackageBundle,
  buildUnsignedAgentPackageBundle,
  createAgentPackageDigest,
  inspectSignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
  type AgentPackageDigest,
  type AgentPackageFile,
  type AgentPackageManifest,
} from '@huaanwork/agent-package-format'
import { generateKeyPair, signAgentPackageDigest, type CatalogSignature } from '@huaanwork/catalog-signing'

import {
  ADMIN_TOKEN,
  PUBLISH_TOKEN,
  READ_TOKEN,
  actorOf,
  bootTestAgentCatalog,
  type TestAgentCatalog,
} from './helpers.ts'
import type { CatalogState, PackageStatus } from '../src/types.ts'
import { packageKey } from '../src/store.ts'

const PERSONA = '你是测试助手'

function manifestFor(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    schemaVersion: 1,
    slug: 'weekly-report',
    displayName: '周报小助手',
    description: '把一周工作整理成周报',
    version: '1.0.0',
    draftId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    persona: 'persona.md',
    skill: null,
    tools: { mode: 'none' },
    allowSkills: [],
    ...overrides,
  }
}

interface TestBundle {
  readonly bundle: Buffer
  readonly manifest: AgentPackageManifest
  readonly digest: AgentPackageDigest
}

/** A VALID unsigned bundle plus the digest an independent inspector computes. */
async function makeBundle(
  overrides: Partial<AgentPackageManifest> = {},
  persona = PERSONA,
): Promise<TestBundle> {
  const manifest = manifestFor(overrides)
  const files: AgentPackageFile[] = [
    { path: 'agent.json', data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'persona.md', data: Buffer.from(persona) },
  ]
  const bundle = await buildUnsignedAgentPackageBundle(files)
  const inspected = await inspectUnsignedAgentPackageBundle(bundle)
  return { bundle, manifest, digest: inspected.digest }
}

/** `count` content files: the valid pair plus zero-byte fillers at the root. */
function contentFiles(count: number): AgentPackageFile[] {
  return [
    { path: 'agent.json', data: Buffer.from(JSON.stringify(manifestFor())) },
    { path: 'persona.md', data: Buffer.from(PERSONA) },
    ...Array.from({ length: count - 2 }, (_, index) => ({
      path: `filler-${String(index).padStart(4, '0')}.md`,
      data: Buffer.alloc(0),
    })),
  ]
}

function sign(
  catalog: TestAgentCatalog,
  digest: unknown,
  options: { privateKeyPem?: string; slot?: 1 | 2; signedAt?: string } = {},
): CatalogSignature {
  return signAgentPackageDigest(digest, {
    privateKeyPem: options.privateKeyPem ?? catalog.activeKey.privateKeyPem,
    slot: options.slot ?? 1,
    signedAt: options.signedAt ?? new Date().toISOString(),
  })
}

interface SubmitOptions {
  readonly token?: string
  readonly headers?: Record<string, string>
  /** `null` sends no Content-Type at all. */
  readonly contentType?: string | null
}

function submit(catalog: TestAgentCatalog, body: Buffer, options: SubmitOptions = {}) {
  const headers: Record<string, string> = { ...options.headers }
  const contentType = options.contentType === undefined ? 'application/gzip' : options.contentType
  if (contentType !== null) headers['content-type'] = contentType
  return catalog.request('/v1/agent-packages/submissions', {
    method: 'POST',
    token: options.token ?? PUBLISH_TOKEN,
    body,
    headers,
  })
}

function approve(
  catalog: TestAgentCatalog,
  submissionId: string,
  signature: unknown,
  token: string = ADMIN_TOKEN,
) {
  return catalog.request(`/v1/agent-packages/submissions/${submissionId}/approve`, {
    method: 'POST',
    token,
    body: { signature },
  })
}

function reject(catalog: TestAgentCatalog, submissionId: string, body: unknown) {
  return catalog.request(`/v1/agent-packages/submissions/${submissionId}/reject`, {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: body as Record<string, unknown>,
  })
}

/** Submit, sign the SERVER digest and approve; asserts both statuses. */
async function publish(
  catalog: TestAgentCatalog,
  overrides: Partial<AgentPackageManifest> = {},
  options: SubmitOptions = {},
): Promise<TestBundle & { submissionId: string }> {
  const made = await makeBundle(overrides)
  const submitted = await submit(catalog, made.bundle, options)
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body))
  const submissionId = submitted.body.submissionId as string
  const approved = await approve(catalog, submissionId, sign(catalog, submitted.body.digest))
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  return { ...made, submissionId }
}

async function readState(catalog: TestAgentCatalog): Promise<CatalogState> {
  try {
    return JSON.parse(await readFile(join(catalog.dataDir, 'state.json'), 'utf8')) as CatalogState
  } catch (cause) {
    // The store only persists state.json on the first commit; before that the
    // logical state is the empty document.
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    return { schemaVersion: 1, submissions: {}, packages: {}, delistRequests: {}, revocations: {} }
  }
}

async function readPackageBundle(catalog: TestAgentCatalog, slug: string, version: string): Promise<Buffer> {
  return readFile(join(catalog.dataDir, 'packages', slug, version, 'bundle.tgz'))
}

async function setPackageStatus(
  catalog: TestAgentCatalog,
  slug: string,
  version: string,
  status: PackageStatus,
): Promise<void> {
  await catalog.runtime.store.update(draft => {
    const record = draft.packages[packageKey(slug, version)]
    assert.ok(record, `package ${slug}/${version} must exist`)
    record.status = status
  })
}

async function writeLegacyEntry(catalog: TestAgentCatalog, entry: Record<string, unknown>): Promise<void> {
  await mkdir(catalog.entriesDir, { recursive: true })
  await writeFile(join(catalog.entriesDir, `${String(entry.name)}.json`), JSON.stringify(entry), 'utf8')
}

// ---------------------------------------------------------------------------
// Review → signature → publish
// ---------------------------------------------------------------------------

test('publishes only after a valid admin signature', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle, manifest, digest } = await makeBundle()
    const submitted = await submit(catalog, bundle)
    assert.equal(submitted.status, 201)
    assert.equal(submitted.body.status, 'pending-review')
    assert.equal(submitted.body.slug, manifest.slug)
    assert.equal(submitted.body.version, manifest.version)
    assert.deepEqual(submitted.body.digest, digest)
    assert.equal(typeof submitted.body.submissionId, 'string')
    assert.equal(Number.isNaN(Date.parse(submitted.body.submittedAt)), false)
    assert.equal(Number.isNaN(Date.parse(submitted.body.updatedAt)), false)
    assert.equal(submitted.headers.location, `/v1/agent-packages/submissions/${submitted.body.submissionId}`)

    const before = await catalog.request(
      `/v1/agent-packages/${manifest.slug}/${manifest.version}/bundle`,
      { token: READ_TOKEN },
    )
    assert.equal(before.status, 404)

    // A leaked publish or read token must never approve.
    for (const token of [PUBLISH_TOKEN, READ_TOKEN]) {
      const denied = await approve(catalog, submitted.body.submissionId, sign(catalog, digest), token)
      assert.equal(denied.status, 403, `${token} must not approve`)
    }

    const approved = await approve(catalog, submitted.body.submissionId, sign(catalog, digest))
    assert.equal(approved.status, 200)
    assert.equal(approved.body.status, 'published')

    const downloaded = await catalog.request(
      `/v1/agent-packages/${manifest.slug}/${manifest.version}/bundle`,
      { token: READ_TOKEN },
    )
    assert.equal(downloaded.status, 200)
    assert.equal(downloaded.headers['content-type'], 'application/gzip')
    const inspected = await inspectSignedAgentPackageBundle(downloaded.buffer, catalog.keyringEntries)
    assert.deepEqual(inspected.digest, digest)
    assert.equal(inspected.manifest.slug, manifest.slug)
    assert.equal(inspected.signature.keyId, catalog.keyring.keyId)

    const metadata = await catalog.request(
      `/v1/agent-packages/${manifest.slug}/${manifest.version}`,
      { token: READ_TOKEN },
    )
    assert.equal(metadata.status, 200)
    assert.equal(metadata.body.status, 'published')
    assert.deepEqual(metadata.body.digest, digest)
    assert.equal(metadata.body.signature.keyId, catalog.keyring.keyId)
    assert.equal(metadata.body.size, downloaded.buffer.byteLength)
    assert.equal(metadata.body.displayName, manifest.displayName)
    assert.equal(metadata.body.bundleUrl, `/v1/agent-packages/${manifest.slug}/${manifest.version}/bundle`)

    const listed = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items.length, 1)
    const item = listed.body.items[0] as Record<string, unknown>
    assert.deepEqual(Object.keys(item).sort(), [
      'description',
      'displayName',
      'size',
      'slug',
      'status',
      'updatedAt',
      'version',
    ])
    assert.equal(item.slug, manifest.slug)
    assert.equal(item.version, manifest.version)
    assert.equal(item.size, downloaded.buffer.byteLength)
    assert.equal(item.status, 'published')
  } finally {
    await catalog.close()
  }
})

test('accepts gzip parameters but refuses other content types and oversized uploads', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle } = await makeBundle()

    const json = await catalog.request('/v1/agent-packages/submissions', {
      method: 'POST',
      token: PUBLISH_TOKEN,
      body: { hello: 'world' },
    })
    assert.equal(json.status, 415)
    assert.deepEqual(json.body, { error: '只接受 application/gzip', code: 'unsupported-media-type' })

    const noType = await submit(catalog, bundle, { contentType: null })
    assert.equal(noType.status, 415)

    const garbage = await submit(catalog, Buffer.from('not a gzip stream'))
    assert.equal(garbage.status, 400)
    assert.equal(garbage.body.code, 'invalid-bundle')
    assert.match(String(garbage.body.error), /包结构非法/u)

    // The read aborts at the cap (5 MiB + 1) instead of buffering the body.
    const oversized = await submit(catalog, Buffer.alloc(MAX_AGENT_PACKAGE_BUNDLE_BYTES + 1, 0))
    assert.equal(oversized.status, 413)
    assert.deepEqual(oversized.body, { error: '请求体过大', code: 'payload-too-large' })

    const state = await readState(catalog)
    assert.deepEqual(state.submissions, {})
    await assert.rejects(() => readdir(join(catalog.dataDir, 'submissions')))

    // Content-Type parameters are accepted (only the media type is pinned).
    const withParameters = await submit(catalog, bundle, { contentType: 'Application/GZIP; charset=binary' })
    assert.equal(withParameters.status, 201)
  } finally {
    await catalog.close()
  }
})

test('rejects an unsigned submission that cannot fit the signed entry budget', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // 1022 content + 2 signature files + `.signature` = 1025 installed entries.
    // The unsigned bytes are legal on their own; submit must reject them before
    // they can become a pending submission that approval could never sign.
    const tooMany = await submit(catalog, await buildUnsignedAgentPackageBundle(contentFiles(1022)))
    assert.equal(tooMany.status, 400)
    assert.equal(tooMany.body.code, 'invalid-bundle')
    assert.match(String(tooMany.body.error), /条目数超过1024/u)
    const empty = await readState(catalog)
    assert.deepEqual(empty.submissions, {})
    await assert.rejects(() => readdir(join(catalog.dataDir, 'submissions')))

    // 1021 content + 3 installed entries = 1024: submit and approve both pass.
    const boundary = await submit(catalog, await buildUnsignedAgentPackageBundle(contentFiles(1021)))
    assert.equal(boundary.status, 201, JSON.stringify(boundary.body))
    const approved = await approve(catalog, boundary.body.submissionId, sign(catalog, boundary.body.digest))
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
  } finally {
    await catalog.close()
  }
})

test('refuses to approve a stored submission that cannot fit the signed entry budget', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // A submission accepted before the submit-time guard existed: the stored
    // unsigned bytes are legal, but the signed projection exceeds the budget.
    // Approval must answer a client-visible 4xx, never a 500.
    const files = contentFiles(1022)
    const manifest = manifestFor()
    const digest = createAgentPackageDigest(manifest, files)
    const submissionId = '00000000-0000-4000-8000-0000000000bb'
    const now = new Date().toISOString()
    const submissionDir = join(catalog.dataDir, 'submissions', submissionId)
    await mkdir(submissionDir, { recursive: true })
    await writeFile(join(submissionDir, 'bundle.tgz'), await buildUnsignedAgentPackageBundle(files))
    await catalog.runtime.store.update(draft => {
      draft.submissions[submissionId] = {
        id: submissionId,
        slug: manifest.slug,
        version: manifest.version,
        status: 'pending-review',
        submittedAt: now,
        updatedAt: now,
        actor: actorOf(PUBLISH_TOKEN),
        digest,
      }
    })

    const approved = await approve(catalog, submissionId, sign(catalog, digest))
    assert.equal(approved.status, 422)
    assert.deepEqual(approved.body, { error: '包条目数超过上限', code: 'package-too-many-entries' })
    const after = await readState(catalog)
    assert.equal(Object.keys(after.packages).length, 0)
    assert.equal(after.submissions[submissionId]?.status, 'pending-review')
  } finally {
    await catalog.close()
  }
})

test('recomputes the digest and never trusts a client-supplied one', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle, digest } = await makeBundle()
    const forged: AgentPackageDigest = {
      schemaVersion: 1,
      slug: 'weekly-report',
      version: '1.0.0',
      manifestSha256: 'f'.repeat(64),
      files: [],
    }

    const submitted = await submit(catalog, bundle, {
      headers: {
        'x-agent-catalog-digest': 'f'.repeat(64),
        'x-agent-package-digest': JSON.stringify(forged),
      },
    })
    assert.equal(submitted.status, 201)
    assert.deepEqual(submitted.body.digest, digest)
    assert.notDeepEqual(submitted.body.digest, forged)

    // A signature over the forged digest is worthless: the server verifies the
    // signature against the digest it stored.
    const wrong = await approve(catalog, submitted.body.submissionId, sign(catalog, forged))
    assert.equal(wrong.status, 400)
    assert.deepEqual(wrong.body, { error: '签名无效', code: 'invalid-signature' })

    const ok = await approve(catalog, submitted.body.submissionId, sign(catalog, digest))
    assert.equal(ok.status, 200)
  } finally {
    await catalog.close()
  }
})

test('refuses a wrong signature, an unknown key and a retired key', async () => {
  const catalog = await bootTestAgentCatalog({
    retiredKeyAt: new Date(Date.now() - 60_000).toISOString(),
  })
  try {
    const { bundle, digest } = await makeBundle({ slug: 'alpha' })
    const submitted = await submit(catalog, bundle)
    assert.equal(submitted.status, 201)
    const id = submitted.body.submissionId as string

    const differentDigest = { ...digest, manifestSha256: '0'.repeat(64) }
    const tampered = await approve(catalog, id, sign(catalog, differentDigest))
    assert.equal(tampered.status, 400)
    assert.equal(tampered.body.code, 'invalid-signature')

    const stranger = generateKeyPair()
    const unknown = await approve(catalog, id, sign(catalog, digest, { privateKeyPem: stranger.privateKeyPem }))
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.code, 'invalid-signature')

    const retiredKey = catalog.retiredKey
    assert.ok(retiredKey, 'the retired-key fixture must be configured')
    const retired = await approve(
      catalog,
      id,
      sign(catalog, digest, { privateKeyPem: retiredKey.privateKeyPem, slot: 2 }),
    )
    assert.equal(retired.status, 400)
    assert.equal(retired.body.code, 'invalid-signature')

    const state = await readState(catalog)
    assert.equal(state.submissions[id]?.status, 'pending-review')
    assert.deepEqual(state.packages, {})
    assert.equal((await catalog.request('/v1/agent-packages/alpha/1.0.0', { token: READ_TOKEN })).status, 404)
  } finally {
    await catalog.close()
  }
})

test('rejects malformed approve and reject bodies', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle, digest } = await makeBundle()
    const submitted = await submit(catalog, bundle)
    const id = submitted.body.submissionId as string

    const empty = await catalog.request(`/v1/agent-packages/submissions/${id}/approve`, {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: {},
    })
    assert.equal(empty.status, 400)
    assert.deepEqual(empty.body, { error: '请求无效', code: 'invalid-body' })

    const extra = await catalog.request(`/v1/agent-packages/submissions/${id}/approve`, {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { signature: sign(catalog, digest), digest },
    })
    assert.equal(extra.status, 400)
    assert.deepEqual(extra.body, { error: '请求无效', code: 'invalid-body' })

    // The signature record itself must have exactly the documented fields: an
    // unknown extra key must not be persisted into the signed bundle.
    const unknownSignatureField = await catalog.request(`/v1/agent-packages/submissions/${id}/approve`, {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { signature: { ...sign(catalog, digest), note: 'extra' } },
    })
    assert.equal(unknownSignatureField.status, 400)
    assert.deepEqual(unknownSignatureField.body, { error: '请求无效', code: 'invalid-body' })

    const notJson = await catalog.request(`/v1/agent-packages/submissions/${id}/approve`, {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(notJson.status, 400)
    assert.deepEqual(notJson.body, { error: '请求无效', code: 'invalid-body' })

    const tooLarge = await catalog.request(`/v1/agent-packages/submissions/${id}/reject`, {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: Buffer.alloc(65 * 1024, 0x20),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(tooLarge.status, 413)
    assert.deepEqual(tooLarge.body, { error: '请求体过大', code: 'payload-too-large' })

    const state = await readState(catalog)
    assert.equal(state.submissions[id]?.status, 'pending-review')
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Duplicate versions, concurrency and rejected resubmission
// ---------------------------------------------------------------------------

test('treats pending and published duplicates as conflicts', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle, manifest, digest } = await makeBundle()
    const first = await submit(catalog, bundle)
    assert.equal(first.status, 201)

    const pendingDuplicate = await submit(catalog, bundle)
    assert.equal(pendingDuplicate.status, 409)
    assert.deepEqual(pendingDuplicate.body, { error: '该版本已在审查中', code: 'version-conflict' })

    const approved = await approve(catalog, first.body.submissionId, sign(catalog, digest))
    assert.equal(approved.status, 200)

    const publishedDuplicate = await submit(catalog, bundle)
    assert.equal(publishedDuplicate.status, 409)
    assert.deepEqual(publishedDuplicate.body, { error: '该版本已发布', code: 'version-conflict' })

    const state = await readState(catalog)
    assert.equal(Object.keys(state.submissions).length, 1)
    assert.equal(Object.keys(state.packages).length, 1)
    assert.equal(state.packages[packageKey(manifest.slug, manifest.version)]?.status, 'published')
  } finally {
    await catalog.close()
  }
})

test('rejects reserved route slugs at submit and at approve', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // Submit: a package named like a static route would be shadowed forever.
    for (const slug of ['submissions', 'delist-requests', 'revocations']) {
      const made = await makeBundle({ slug })
      const response = await submit(catalog, made.bundle)
      assert.equal(response.status, 400, `slug ${slug}`)
      assert.deepEqual(response.body, {
        error: `标识「${slug}」是目录保留路径，不能用作包名`,
        code: 'reserved-slug',
      })
    }
    const state = await readState(catalog)
    assert.equal(Object.keys(state.submissions).length, 0)
    assert.equal(Object.keys(state.packages).length, 0)

    // Approve: a record that predates the submit guard must not become
    // publishable either (the approve guard runs before signature/bundle I/O).
    const made = await makeBundle({ slug: 'submissions' })
    const submissionId = '00000000-0000-4000-8000-0000000000aa'
    const now = new Date().toISOString()
    await catalog.runtime.store.update(draft => {
      draft.submissions[submissionId] = {
        id: submissionId,
        slug: 'submissions',
        version: '1.0.0',
        status: 'pending-review',
        submittedAt: now,
        updatedAt: now,
        actor: actorOf(PUBLISH_TOKEN),
        digest: made.digest,
      }
    })
    const approved = await approve(catalog, submissionId, sign(catalog, made.digest))
    assert.equal(approved.status, 400)
    assert.deepEqual(approved.body, {
      error: '标识「submissions」是目录保留路径，不能用作包名',
      code: 'reserved-slug',
    })
    const after = await readState(catalog)
    assert.equal(Object.keys(after.packages).length, 0)
    assert.equal(after.submissions[submissionId]?.status, 'pending-review')
  } finally {
    await catalog.close()
  }
})

test('lets exactly one of two concurrent identical submissions win', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle, manifest } = await makeBundle()
    const [left, right] = await Promise.all([submit(catalog, bundle), submit(catalog, bundle)])
    const statuses = [left.status, right.status].sort()
    assert.deepEqual(statuses, [201, 409])
    const winner = left.status === 201 ? left : right
    const loser = left.status === 409 ? left : right
    assert.equal(loser.body.code, 'version-conflict')
    assert.equal(winner.body.status, 'pending-review')

    const state = await readState(catalog)
    const matching = Object.values(state.submissions).filter(
      record => record.slug === manifest.slug && record.version === manifest.version,
    )
    assert.equal(matching.length, 1)
    assert.equal(matching[0]?.id, winner.body.submissionId)
  } finally {
    await catalog.close()
  }
})

test('allows a higher version of the same slug but freezes rejected version content', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog)
    const slug = published.manifest.slug

    // The update path: same slug, higher version, same process.
    const next = await makeBundle({ slug, version: '1.0.1', displayName: '周报小助手 2' })
    const submitted = await submit(catalog, next.bundle)
    assert.equal(submitted.status, 201)
    const id = submitted.body.submissionId as string

    const rejected = await reject(catalog, id, { reason: '  请补充数据来源说明  ' })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.status, 'rejected')
    assert.equal(rejected.body.reason, '请补充数据来源说明')
    assert.equal(rejected.body.submissionId, id)

    // Same digest may reuse the rejected version number, as a NEW submission.
    const again = await submit(catalog, next.bundle)
    assert.equal(again.status, 201)
    assert.notEqual(again.body.submissionId, id)
    assert.equal(again.body.status, 'pending-review')

    // Reject the new one too, then a DIFFERENT body for the same version is out.
    assert.equal((await reject(catalog, again.body.submissionId, { reason: '仍然缺少说明' })).status, 200)
    const different = await makeBundle({ slug, version: '1.0.1' }, '完全不同的文案')
    const conflict = await submit(catalog, different.bundle)
    assert.equal(conflict.status, 409)
    assert.deepEqual(conflict.body, {
      error: '该版本已被拒绝且内容不同，请提升版本号',
      code: 'rejected-digest-conflict',
    })

    // Rejection bodies are validated and only pending submissions may be rejected.
    const fresh = await submit(catalog, await makeBundle({ slug, version: '1.0.2' }).then(made => made.bundle))
    const freshId = fresh.body.submissionId as string
    for (const reason of ['', '   ', 'x'.repeat(501), 42, undefined]) {
      const invalid = await reject(catalog, freshId, reason === undefined ? {} : { reason })
      assert.equal(invalid.status, 400, `reason ${String(reason)} must be refused`)
      assert.deepEqual(invalid.body, { error: '原因需为 1-500 个字符', code: 'invalid-reason' })
    }
    assert.equal(
      (await reject(catalog, published.submissionId, { reason: '已发布版本不能拒绝' })).status,
      409,
    )

    const state = await readState(catalog)
    assert.equal(state.submissions[published.submissionId]?.status, 'published')
    assert.equal(state.packages[packageKey(slug, '1.0.0')]?.status, 'published')
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Legacy directory entries and the migration exception
// ---------------------------------------------------------------------------

test('conflicts with legacy entries and honours only a matching agent migration header', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    await writeLegacyEntry(catalog, {
      name: 'legacy-agent',
      version: '1.0.0',
      kind: 'agent',
      description: '旧目录智能体',
      persona: '你是旧条目',
    })
    await writeLegacyEntry(catalog, {
      name: 'legacy-tool',
      version: '0.1.0',
      kind: 'tool',
      description: '旧目录工具',
    })

    // No header: same-name legacy entries always conflict.
    const plainAgent = await submit(catalog, (await makeBundle({ slug: 'legacy-agent' })).bundle)
    assert.equal(plainAgent.status, 409)
    assert.deepEqual(plainAgent.body, { error: '标识与目录条目冲突：legacy-agent', code: 'legacy-conflict' })

    // A forged header (value !== manifest.slug) does not unlock the exception.
    const forged = await submit(catalog, (await makeBundle({ slug: 'legacy-agent', version: '1.0.1' })).bundle, {
      headers: { 'x-agent-catalog-migration': 'another-slug' },
    })
    assert.equal(forged.status, 409)
    assert.equal(forged.body.code, 'legacy-conflict')

    // Tools are never migratable, even with a correct header.
    const tool = await submit(catalog, (await makeBundle({ slug: 'legacy-tool' })).bundle, {
      headers: { 'x-agent-catalog-migration': 'legacy-tool' },
    })
    assert.equal(tool.status, 409)
    assert.equal(tool.body.code, 'legacy-conflict')

    // The legal migration: matching header, kind:"agent" entry present.
    await publish(
      catalog,
      { slug: 'legacy-agent', displayName: '旧目录智能体' },
      { headers: { 'x-agent-catalog-migration': 'legacy-agent' } },
    )
    const metadata = await catalog.request('/v1/agent-packages/legacy-agent/1.0.0', { token: READ_TOKEN })
    assert.equal(metadata.status, 200)
    assert.equal(metadata.body.migrationFrom, 'legacy-agent')
    assert.equal((await catalog.request('/v1/agent-packages/legacy-agent/1.0.0/bundle', { token: READ_TOKEN })).status, 200)

    // A normal publish must never fabricate migrationFrom, even when the header
    // is present: no legacy entry exists for this slug, so nothing was migrated.
    const plain = await publish(
      catalog,
      { slug: 'plain-agent' },
      { headers: { 'x-agent-catalog-migration': 'plain-agent' } },
    )
    const plainMetadata = await catalog.request('/v1/agent-packages/plain-agent/1.0.0', { token: READ_TOKEN })
    assert.equal(plainMetadata.status, 200)
    assert.equal('migrationFrom' in plainMetadata.body, false)

    const state = await readState(catalog)
    assert.equal(state.packages[packageKey('legacy-agent', '1.0.0')]?.migrationFrom, 'legacy-agent')
    assert.equal(state.packages[packageKey('plain-agent', '1.0.0')]?.migrationFrom, undefined)
    assert.equal(state.packages[packageKey('plain-agent', '1.0.0')]?.status, 'published')
    assert.equal(plain.submissionId.length > 0, true)
  } finally {
    await catalog.close()
  }
})

test('re-checks legacy conflicts at approval time', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const uploaded = await makeBundle({ slug: 'late-legacy' })
    const submitted = await submit(catalog, uploaded.bundle)
    assert.equal(submitted.status, 201)
    const id = submitted.body.submissionId as string

    // A legacy entry appears while the submission is pending.
    await writeLegacyEntry(catalog, { name: 'late-legacy', version: '1.0.0', kind: 'agent' })
    const blocked = await approve(catalog, id, sign(catalog, uploaded.digest))
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.code, 'legacy-conflict')

    const state = await readState(catalog)
    assert.equal(state.submissions[id]?.status, 'pending-review')
    assert.deepEqual(state.packages, {})

    // A tool that appears late is equally fatal.
    const uploadedTool = await makeBundle({ slug: 'late-tool' })
    const toolSubmission = await submit(catalog, uploadedTool.bundle)
    assert.equal(toolSubmission.status, 201)
    await writeLegacyEntry(catalog, { name: 'late-tool', version: '0.1.0', kind: 'tool' })
    const toolBlocked = await approve(
      catalog,
      toolSubmission.body.submissionId,
      sign(catalog, uploadedTool.digest),
    )
    assert.equal(toolBlocked.status, 409)
    assert.equal(toolBlocked.body.code, 'legacy-conflict')
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Admin review surface
// ---------------------------------------------------------------------------

test('reports previousVersion and previousDigest to administrators only', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog, { slug: 'weekly-report', version: '1.0.0' })
    const slug = published.manifest.slug

    const second = await makeBundle({ slug, version: '1.0.1' })
    const submitted = await submit(catalog, second.bundle)
    const id = submitted.body.submissionId as string

    const admin = await catalog.request(`/v1/agent-packages/submissions/${id}`, { token: ADMIN_TOKEN })
    assert.equal(admin.status, 200)
    assert.equal(admin.body.previousVersion, '1.0.0')
    assert.deepEqual(admin.body.previousDigest, published.digest)

    const creator = await catalog.request(`/v1/agent-packages/submissions/${id}`, { token: PUBLISH_TOKEN })
    assert.equal(creator.status, 200)
    assert.equal('previousVersion' in creator.body, false)
    assert.equal('previousDigest' in creator.body, false)

    // Delisted and revoked records still anchor the diff.
    await setPackageStatus(catalog, slug, '1.0.0', 'delisted')
    const third = await makeBundle({ slug, version: '1.0.2' })
    const thirdSubmitted = await submit(catalog, third.bundle)
    const delistedView = await catalog.request(
      `/v1/agent-packages/submissions/${thirdSubmitted.body.submissionId}`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(delistedView.status, 200)
    assert.equal(delistedView.body.previousVersion, '1.0.0')
    assert.deepEqual(delistedView.body.previousDigest, published.digest)

    await setPackageStatus(catalog, slug, '1.0.0', 'revoked')
    const revokedView = await catalog.request(`/v1/agent-packages/submissions/${id}`, { token: ADMIN_TOKEN })
    assert.equal(revokedView.body.previousVersion, '1.0.0')

    // A slug with no signed package has no previous version at all.
    const fresh = await makeBundle({ slug: 'brand-new' })
    const freshSubmitted = await submit(catalog, fresh.bundle)
    const freshView = await catalog.request(
      `/v1/agent-packages/submissions/${freshSubmitted.body.submissionId}`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(freshView.status, 200)
    assert.equal('previousVersion' in freshView.body, false)

    // The approved submission itself is not its own "previous".
    const afterApprove = await catalog.request(
      `/v1/agent-packages/submissions/${published.submissionId}`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(afterApprove.status, 200)
    assert.equal('previousVersion' in afterApprove.body, false)
  } finally {
    await catalog.close()
  }
})

test('serves the pending queue, submission detail and review bundle to admins', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const pendingA = await makeBundle({ slug: 'alpha' })
    const pendingB = await makeBundle({ slug: 'beta' })
    const a = await submit(catalog, pendingA.bundle)
    const b = await submit(catalog, pendingB.bundle)
    const done = await makeBundle({ slug: 'gamma' })
    const publishedSubmission = await submit(catalog, done.bundle)
    assert.equal((await approve(catalog, publishedSubmission.body.submissionId, sign(catalog, done.digest))).status, 200)
    const rejected = await makeBundle({ slug: 'delta' })
    const rejectedSubmission = await submit(catalog, rejected.bundle)
    assert.equal((await reject(catalog, rejectedSubmission.body.submissionId, { reason: '不合规' })).status, 200)

    const pending = await catalog.request('/v1/agent-packages/submissions?status=pending', { token: ADMIN_TOKEN })
    assert.equal(pending.status, 200)
    assert.deepEqual(
      pending.body.items.map((item: { submissionId: string }) => item.submissionId).sort(),
      [a.body.submissionId, b.body.submissionId].sort(),
    )
    assert.equal(pending.body.items[0].status, 'pending-review')

    for (const query of ['', '?status=published', '?status=nonsense']) {
      const invalid = await catalog.request(`/v1/agent-packages/submissions${query}`, { token: ADMIN_TOKEN })
      assert.equal(invalid.status, 400, `query ${query} must be refused`)
      assert.deepEqual(invalid.body, { error: '不支持的提交状态筛选', code: 'invalid-status' })
    }

    const unknown = await catalog.request('/v1/agent-packages/submissions/does-not-exist', { token: ADMIN_TOKEN })
    assert.equal(unknown.status, 404)
    assert.deepEqual(unknown.body, { error: '提交不存在', code: 'not-found' })

    // The creator may read its own submission; a foreign actor may not.
    const own = await catalog.request(`/v1/agent-packages/submissions/${a.body.submissionId}`, { token: PUBLISH_TOKEN })
    assert.equal(own.status, 200)
    assert.equal(own.body.submissionId, a.body.submissionId)

    await catalog.runtime.store.update(draft => {
      const record = draft.submissions[a.body.submissionId as string]
      assert.ok(record)
      ;(record as { actor: string }).actor = 'ffffffffffff'
    })
    const foreign = await catalog.request(`/v1/agent-packages/submissions/${a.body.submissionId}`, { token: PUBLISH_TOKEN })
    assert.equal(foreign.status, 403)
    assert.deepEqual(foreign.body, { error: '权限不足', code: 'forbidden' })
    const adminStillReads = await catalog.request(
      `/v1/agent-packages/submissions/${a.body.submissionId}`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(adminStillReads.status, 200)

    // The admin review download returns the ORIGINAL unsigned bytes.
    const review = await catalog.request(`/v1/agent-packages/submissions/${a.body.submissionId}/bundle`, {
      token: ADMIN_TOKEN,
    })
    assert.equal(review.status, 200)
    assert.equal(review.headers['content-type'], 'application/gzip')
    assert.deepEqual(review.buffer, pendingA.bundle)
    const inspected = await inspectUnsignedAgentPackageBundle(review.buffer)
    assert.deepEqual(inspected.digest, pendingA.digest)
    assert.equal((await catalog.request('/v1/agent-packages/submissions/does-not-exist/bundle', { token: ADMIN_TOKEN })).status, 404)

    // Rejected submissions keep their evidence downloadable.
    const rejectedReview = await catalog.request(
      `/v1/agent-packages/submissions/${rejectedSubmission.body.submissionId}/bundle`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(rejectedReview.status, 200)
    assert.deepEqual(rejectedReview.buffer, rejected.bundle)
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Atomic visibility, stored metadata and recovery
// ---------------------------------------------------------------------------

test('keeps unpublished state invisible and stores only server-computed metadata', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { bundle, manifest, digest } = await makeBundle()
    const submitted = await submit(catalog, bundle)
    const id = submitted.body.submissionId as string
    const slug = manifest.slug
    const version = manifest.version

    // A pending submission is durable but NOT published: no metadata, no bundle.
    const pendingState = await readState(catalog)
    assert.equal(pendingState.submissions[id]?.status, 'pending-review')
    assert.equal(pendingState.submissions[id]?.actor, actorOf(PUBLISH_TOKEN))
    assert.deepEqual(pendingState.packages, {})
    assert.equal((await catalog.request(`/v1/agent-packages/${slug}/${version}`, { token: READ_TOKEN })).status, 404)
    assert.equal(
      (await catalog.request(`/v1/agent-packages/${slug}/${version}/bundle`, { token: READ_TOKEN })).status,
      404,
    )

    const signature = sign(catalog, digest)
    const approved = await approve(catalog, id, signature)
    assert.equal(approved.status, 200)

    const signedBytes = await readPackageBundle(catalog, slug, version)
    const state = await readState(catalog)
    const record = state.packages[packageKey(slug, version)]
    assert.ok(record)
    assert.deepEqual(Object.keys(record).sort(), [
      'actor',
      'digest',
      'manifest',
      'signature',
      'size',
      'slug',
      'status',
      'updatedAt',
      'version',
    ])
    assert.equal(record.status, 'published')
    assert.equal(record.actor, actorOf(ADMIN_TOKEN))
    assert.equal(record.size, signedBytes.byteLength)
    assert.deepEqual(record.digest, digest)
    assert.equal(record.signature.signature, signature.signature)
    assert.equal(record.manifest.displayName, manifest.displayName)
    assert.equal(state.submissions[id]?.status, 'published')
    assert.equal(Number.isNaN(Date.parse(record.updatedAt)), false)

    const downloaded = await catalog.request(`/v1/agent-packages/${slug}/${version}/bundle`, { token: READ_TOKEN })
    assert.deepEqual(downloaded.buffer, signedBytes)
    assert.equal(downloaded.buffer.byteLength, record.size)
  } finally {
    await catalog.close()
  }
})

test('recovers an identical leftover bundle and refuses a conflicting one', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const slug = 'recoverable'

    // Identical leftover: the exact signed bytes are already on disk while the
    // state still says pending, so approval must adopt them.
    const first = await makeBundle({ slug })
    const submitted = await submit(catalog, first.bundle)
    const id = submitted.body.submissionId as string
    const signature = sign(catalog, first.digest)
    const files = await inspectUnsignedAgentPackageBundle(first.bundle)
    const signed = await buildSignedAgentPackageBundle(files.files, first.digest, signature)
    await mkdir(join(catalog.dataDir, 'packages', slug, '1.0.0'), { recursive: true })
    await writeFile(join(catalog.dataDir, 'packages', slug, '1.0.0', 'bundle.tgz'), signed)

    const approved = await approve(catalog, id, signature)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.equal((await readPackageBundle(catalog, slug, '1.0.0')).byteLength, signed.byteLength)
    assert.equal((await readState(catalog)).packages[packageKey(slug, '1.0.0')]?.size, signed.byteLength)

    // Conflicting leftover: different bytes for the same version are refused.
    const second = await makeBundle({ slug, version: '1.0.1' })
    const secondSubmitted = await submit(catalog, second.bundle)
    const secondId = secondSubmitted.body.submissionId as string
    const other = await makeBundle({ slug, version: '1.0.1' }, '另一个内容')
    const otherFiles = await inspectUnsignedAgentPackageBundle(other.bundle)
    const otherSignature = sign(catalog, other.digest)
    const otherSigned = await buildSignedAgentPackageBundle(otherFiles.files, other.digest, otherSignature)
    await mkdir(join(catalog.dataDir, 'packages', slug, '1.0.1'), { recursive: true })
    const target = join(catalog.dataDir, 'packages', slug, '1.0.1', 'bundle.tgz')
    await writeFile(target, otherSigned)

    const conflict = await approve(catalog, secondId, sign(catalog, second.digest))
    assert.equal(conflict.status, 409)
    assert.deepEqual(conflict.body, { error: '该版本已存在不同内容的包', code: 'bundle-conflict' })
    assert.deepEqual(await readFile(target), otherSigned)
    assert.equal((await readState(catalog)).submissions[secondId]?.status, 'pending-review')

    // Garbage at the final path is a conflict too, never an overwrite.
    const third = await makeBundle({ slug, version: '1.0.2' })
    const thirdSubmitted = await submit(catalog, third.bundle)
    await mkdir(join(catalog.dataDir, 'packages', slug, '1.0.2'), { recursive: true })
    await writeFile(join(catalog.dataDir, 'packages', slug, '1.0.2', 'bundle.tgz'), 'not a bundle')
    const garbageConflict = await approve(
      catalog,
      thirdSubmitted.body.submissionId,
      sign(catalog, third.digest),
    )
    assert.equal(garbageConflict.status, 409)
    assert.equal(garbageConflict.body.code, 'bundle-conflict')
  } finally {
    await catalog.close()
  }
})

test('refuses to approve when the stored bundle no longer matches the digest', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const original = await makeBundle({ slug: 'tampered' })
    const submitted = await submit(catalog, original.bundle)
    const id = submitted.body.submissionId as string

    const replacement = await makeBundle({ slug: 'tampered' }, '被替换的人设')
    await writeFile(join(catalog.dataDir, 'submissions', id, 'bundle.tgz'), replacement.bundle)

    const approved = await approve(catalog, id, sign(catalog, original.digest))
    assert.equal(approved.status, 409)
    assert.deepEqual(approved.body, { error: '存储的提交包与摘要不一致', code: 'digest-mismatch' })

    const state = await readState(catalog)
    assert.equal(state.submissions[id]?.status, 'pending-review')
    assert.deepEqual(state.packages, {})
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Public read surface
// ---------------------------------------------------------------------------

test('serves the public list, metadata and bundle with withdrawal semantics', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const empty = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { items: [] })

    const alphaOlder = await publish(catalog, { slug: 'alpha', version: '1.0.0' })
    const alphaNewer = await publish(catalog, { slug: 'alpha', version: '1.1.0', displayName: 'Alpha 新版' })
    await publish(catalog, { slug: 'beta', version: '2.0.0' })
    await publish(catalog, { slug: 'gamma', version: '3.0.0' })
    await publish(catalog, { slug: 'delta', version: '4.0.0' })

    // Withdraw two whole slugs: one delisted, one revoked.
    await setPackageStatus(catalog, 'beta', '2.0.0', 'delisted')
    await setPackageStatus(catalog, 'delta', '4.0.0', 'revoked')

    const listed = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.body.items.map((item: { slug: string; version: string }) => [item.slug, item.version]),
      [
        ['alpha', '1.1.0'],
        ['gamma', '3.0.0'],
      ],
    )
    assert.equal(listed.body.items[0].displayName, 'Alpha 新版')
    assert.equal(listed.body.items[0].size, (await readPackageBundle(catalog, 'alpha', '1.1.0')).byteLength)
    assert.equal(listed.body.items[0].status, 'published')

    // The older published version is still reachable by exact version.
    const older = await catalog.request('/v1/agent-packages/alpha/1.0.0', { token: READ_TOKEN })
    assert.equal(older.status, 200)
    assert.deepEqual(older.body.digest, alphaOlder.digest)
    assert.equal(typeof older.body.bundleUrl, 'string')

    // Withdrawn versions keep serving metadata (installed clients) but no URL.
    const delisted = await catalog.request('/v1/agent-packages/beta/2.0.0', { token: READ_TOKEN })
    assert.equal(delisted.status, 200)
    assert.equal(delisted.body.status, 'delisted')
    assert.equal('bundleUrl' in delisted.body, false)
    assert.equal(delisted.body.digest.slug, 'beta')
    assert.equal(typeof delisted.body.signature.keyId, 'string')
    const delistedBundle = await catalog.request('/v1/agent-packages/beta/2.0.0/bundle', { token: READ_TOKEN })
    assert.equal(delistedBundle.status, 410)
    assert.deepEqual(delistedBundle.body, { error: '版本已下架', code: 'package-delisted' })

    const revoked = await catalog.request('/v1/agent-packages/delta/4.0.0', { token: READ_TOKEN })
    assert.equal(revoked.status, 200)
    assert.equal(revoked.body.status, 'revoked')
    assert.equal('bundleUrl' in revoked.body, false)
    const revokedBundle = await catalog.request('/v1/agent-packages/delta/4.0.0/bundle', { token: READ_TOKEN })
    assert.equal(revokedBundle.status, 410)
    assert.deepEqual(revokedBundle.body, { error: '版本已撤销', code: 'package-revoked' })

    // Unknown versions are plain 404s, and a traversal-looking slug never
    // resolves to a file on disk.
    assert.equal((await catalog.request('/v1/agent-packages/alpha/9.9.9', { token: READ_TOKEN })).status, 404)
    assert.equal((await catalog.request('/v1/agent-packages/nope/1.0.0/bundle', { token: READ_TOKEN })).status, 404)
    assert.equal(
      (await catalog.request('/v1/agent-packages/%2E%2E%2Falpha/1.0.0/bundle', { token: READ_TOKEN })).status,
      404,
    )
    assert.equal((await catalog.request('/v1/agent-packages/alpha/1.0.0', { token: PUBLISH_TOKEN })).status, 403)
    assert.equal((await catalog.request('/v1/agent-packages/alpha/1.0.0', { token: READ_TOKEN, method: 'POST' })).status, 405)

    assert.equal(alphaNewer.submissionId.length > 0, true)
  } finally {
    await catalog.close()
  }
})

test('keeps static admin routes ahead of the dynamic slug route', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // `/submissions` is matched as a static segment: a read token gets the
    // admin/publish role refusal, never a "package not found" from the dynamic
    // `/{slug}/{version}` handler.
    const pending = await catalog.request('/v1/agent-packages/submissions?status=pending', { token: READ_TOKEN })
    assert.equal(pending.status, 403)
    assert.deepEqual(pending.body, { error: '权限不足', code: 'forbidden' })

    const review = await catalog.request('/v1/agent-packages/submissions/abc/bundle', { token: PUBLISH_TOKEN })
    assert.equal(review.status, 403)

    // The reserved governance routes are still recognized as static paths (they
    // are Task 6's to implement; they must not be swallowed by `/{slug}`).
    const delist = await catalog.request('/v1/agent-packages/delist-requests?status=pending', { token: READ_TOKEN })
    assert.equal(delist.status, 403)
    const revocations = await catalog.request('/v1/agent-packages/revocations', { token: PUBLISH_TOKEN })
    assert.equal(revocations.status, 403)
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('audits submit, duplicate, signature failure, approve and reject without secrets', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const first = await makeBundle({ slug: 'audited' })
    const submitted = await submit(catalog, first.bundle)
    const id = submitted.body.submissionId as string
    assert.equal(submitted.status, 201)

    assert.equal((await submit(catalog, first.bundle)).status, 409)

    const wrongDigest = { ...first.digest, manifestSha256: '1'.repeat(64) }
    assert.equal((await approve(catalog, id, sign(catalog, wrongDigest))).status, 400)

    assert.equal((await approve(catalog, id, sign(catalog, first.digest))).status, 200)

    const second = await makeBundle({ slug: 'audited', version: '1.0.1' })
    const secondSubmitted = await submit(catalog, second.bundle)
    assert.equal((await reject(catalog, secondSubmitted.body.submissionId, { reason: '缺少说明' })).status, 200)

    const records = await catalog.readAudit()
    assert.equal(records.length, 6)

    const creates = records.filter(record => record.action === 'agentPackages.submissions.create')
    assert.equal(creates.length, 3)
    assert.equal(creates[0]?.status, 201)
    assert.equal(creates[0]?.outcome, 'ok')
    assert.equal(creates[0]?.slug, 'audited')
    assert.equal(creates[0]?.version, '1.0.0')
    assert.equal(creates[0]?.submissionId, id)
    assert.equal(creates[0]?.actor, actorOf(PUBLISH_TOKEN))
    assert.equal(creates[1]?.status, 409)
    assert.equal(creates[1]?.outcome, 'error')
    assert.equal(creates[2]?.status, 201)
    assert.equal(creates[2]?.version, '1.0.1')

    const approvals = records.filter(record => record.action === 'agentPackages.submissions.approve')
    assert.equal(approvals.length, 2)
    assert.equal(approvals[0]?.status, 400)
    assert.equal(approvals[0]?.outcome, 'error')
    assert.match(String(approvals[0]?.reason), /invalid-signature/u)
    assert.equal(approvals[1]?.status, 200)
    assert.equal(approvals[1]?.outcome, 'ok')
    assert.equal(approvals[1]?.submissionId, id)
    assert.equal(approvals[1]?.actor, actorOf(ADMIN_TOKEN))

    const rejects = records.filter(record => record.action === 'agentPackages.submissions.reject')
    assert.equal(rejects.length, 1)
    assert.equal(rejects[0]?.status, 200)
    assert.equal(rejects[0]?.outcome, 'ok')

    const raw = await catalog.readAuditRaw()
    for (const token of [READ_TOKEN, PUBLISH_TOKEN, ADMIN_TOKEN]) {
      assert.equal(raw.includes(token), false, `audit log leaked ${token}`)
    }
    assert.equal(raw.includes('BEGIN PRIVATE KEY'), false)
    assert.equal(raw.includes('END PRIVATE KEY'), false)
    assert.equal(raw.toLowerCase().includes('authorization'), false)
  } finally {
    await catalog.close()
  }
})
