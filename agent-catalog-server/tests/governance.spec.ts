/**
 * Task 6: delisting requests, revocations and the shared distribution state
 * machine.
 *
 * Every assertion goes through the REAL HTTP surface (`tests/helpers.ts`) and a
 * dynamically generated Ed25519 keypair; no token, key or bundle in this file is
 * production material. Packages are published with the Task 5 flow (submit with
 * the publish token, sign the server digest, approve with the admin token), so
 * the governance routes are exercised exactly as an operator would use them.
 *
 * The three public read routes (list / metadata / bundle) must all derive their
 * withdrawal behaviour from the ONE `packageDistributionStatus` helper: a
 * delisted or revoked version disappears from the list, keeps serving metadata
 * (installed clients must be able to explain the state) and answers 410 for the
 * bundle.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  buildUnsignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
  type AgentPackageDigest,
  type AgentPackageFile,
  type AgentPackageManifest,
} from '@huaanwork/agent-package-format'
import { signAgentPackageDigest, type CatalogSignature } from '@huaanwork/catalog-signing'

import {
  ADMIN_TOKEN,
  PUBLISH_TOKEN,
  READ_TOKEN,
  actorOf,
  bootTestAgentCatalog,
  type TestAgentCatalog,
} from './helpers.ts'
import { packageKey } from '../src/store.ts'
import {
  packageDistributionStatus,
  type CatalogState,
  type DelistRequest,
  type Revocation,
} from '../src/types.ts'

const PERSONA = '你是测试助手'
const SLUG = 'weekly-report'

/** Same fixture shape as the Task 5 suite; kept local so the two files stay independent. */
function manifestFor(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    schemaVersion: 1,
    slug: SLUG,
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

function sign(catalog: TestAgentCatalog, digest: unknown): CatalogSignature {
  return signAgentPackageDigest(digest, {
    privateKeyPem: catalog.activeKey.privateKeyPem,
    slot: 1,
    signedAt: new Date().toISOString(),
  })
}

/** Submit, sign the SERVER digest and approve; asserts both statuses. */
async function publish(
  catalog: TestAgentCatalog,
  overrides: Partial<AgentPackageManifest> = {},
): Promise<TestBundle & { submissionId: string; signature: CatalogSignature }> {
  const made = await makeBundle(overrides)
  const submitted = await catalog.request('/v1/agent-packages/submissions', {
    method: 'POST',
    token: PUBLISH_TOKEN,
    body: made.bundle,
    headers: { 'content-type': 'application/gzip' },
  })
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body))
  const submissionId = submitted.body.submissionId as string
  const signature = sign(catalog, submitted.body.digest)
  const approved = await catalog.request(`/v1/agent-packages/submissions/${submissionId}/approve`, {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { signature },
  })
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  return { ...made, submissionId, signature }
}

async function readState(catalog: TestAgentCatalog): Promise<CatalogState> {
  try {
    return JSON.parse(await readFile(join(catalog.dataDir, 'state.json'), 'utf8')) as CatalogState
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    return { schemaVersion: 1, submissions: {}, packages: {}, delistRequests: {}, revocations: {} }
  }
}

function requestDelist(
  catalog: TestAgentCatalog,
  slug: string,
  version: string,
  reason: unknown,
  token: string = PUBLISH_TOKEN,
) {
  return catalog.request(`/v1/agent-packages/${slug}/${version}/delist-requests`, {
    method: 'POST',
    token,
    body: { reason } as Record<string, unknown>,
  })
}

function listDelistRequests(catalog: TestAgentCatalog, token: string = ADMIN_TOKEN) {
  return catalog.request('/v1/agent-packages/delist-requests?status=pending', { token })
}

function approveDelist(catalog: TestAgentCatalog, id: string, token: string = ADMIN_TOKEN) {
  return catalog.request(`/v1/agent-packages/delist-requests/${id}/approve`, { method: 'POST', token })
}

function rejectDelist(
  catalog: TestAgentCatalog,
  id: string,
  reason?: string,
  token: string = ADMIN_TOKEN,
) {
  return catalog.request(`/v1/agent-packages/delist-requests/${id}/reject`, {
    method: 'POST',
    token,
    ...(reason === undefined ? {} : { body: { reason } }),
  })
}

function revoke(
  catalog: TestAgentCatalog,
  slug: string,
  version: string,
  reason: unknown,
  token: string = ADMIN_TOKEN,
) {
  return catalog.request(`/v1/agent-packages/${slug}/${version}/revoke`, {
    method: 'POST',
    token,
    body: { reason } as Record<string, unknown>,
  })
}

function listRevocations(catalog: TestAgentCatalog, token: string = READ_TOKEN) {
  return catalog.request('/v1/agent-packages/revocations', { token })
}

function metadata(catalog: TestAgentCatalog, slug: string, version: string, token = READ_TOKEN) {
  return catalog.request(`/v1/agent-packages/${slug}/${version}`, { token })
}

function bundle(catalog: TestAgentCatalog, slug: string, version: string, token = READ_TOKEN) {
  return catalog.request(`/v1/agent-packages/${slug}/${version}/bundle`, { token })
}

function listedSlugs(body: { items: Array<{ slug: string; version: string }> }): string[] {
  return body.items.map(item => `${item.slug}/${item.version}`)
}

// ---------------------------------------------------------------------------
// The shared distribution state machine
// ---------------------------------------------------------------------------

test('derives every distribution decision from one helper', () => {
  assert.deepEqual(packageDistributionStatus({ status: 'published' }), {
    status: 'published',
    listed: true,
    downloadable: true,
  })
  assert.deepEqual(packageDistributionStatus({ status: 'delisted' }), {
    status: 'delisted',
    listed: false,
    downloadable: false,
    error: '版本已下架',
    code: 'package-delisted',
  })
  assert.deepEqual(packageDistributionStatus({ status: 'revoked' }), {
    status: 'revoked',
    listed: false,
    downloadable: false,
    error: '版本已撤销',
    code: 'package-revoked',
  })
})

// ---------------------------------------------------------------------------
// Delist requests: apply, stay published, approve, reject
// ---------------------------------------------------------------------------

test('keeps a version published and downloadable while its delist request is pending', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog)
    const version = published.manifest.version
    const signedBytes = await readFile(join(catalog.dataDir, 'packages', SLUG, version, 'bundle.tgz'))

    const requested = await requestDelist(catalog, SLUG, version, '  内容需要下线  ')
    assert.equal(requested.status, 201, JSON.stringify(requested.body))
    const request = requested.body as DelistRequest
    assert.equal(request.slug, SLUG)
    assert.equal(request.version, version)
    assert.equal(request.status, 'pending')
    // The reason is trimmed; the actor is the token HASH prefix, never the token.
    assert.equal(request.reason, '内容需要下线')
    assert.equal(request.actor, actorOf(PUBLISH_TOKEN))
    assert.equal('resolvedAt' in request, false)
    assert.equal(Number.isNaN(Date.parse(request.createdAt)), false)
    assert.match(request.id, /^[0-9a-f-]{36}$/u)

    // Pending is not withdrawn: the list, metadata and bytes are untouched.
    const listed = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.deepEqual(listedSlugs(listed.body), [`${SLUG}/${version}`])
    const detail = await metadata(catalog, SLUG, version)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.status, 'published')
    assert.equal(typeof detail.body.bundleUrl, 'string')
    const downloaded = await bundle(catalog, SLUG, version)
    assert.equal(downloaded.status, 200)
    assert.deepEqual(downloaded.buffer, signedBytes)

    // The admin queue shows exactly this request; the read token cannot see it.
    const pending = await listDelistRequests(catalog)
    assert.equal(pending.status, 200)
    assert.equal(pending.body.items.length, 1)
    assert.deepEqual(pending.body.items[0], request)
    assert.equal((await listDelistRequests(catalog, READ_TOKEN)).status, 403)
    assert.equal((await listDelistRequests(catalog, PUBLISH_TOKEN)).status, 403)

    const state = await readState(catalog)
    assert.equal(state.packages[packageKey(SLUG, version)]?.status, 'published')
    assert.deepEqual(state.delistRequests[request.id], request)
    assert.deepEqual(state.revocations, {})
  } finally {
    await catalog.close()
  }
})

test('approving a delist request hides the version but keeps metadata readable', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog)
    const version = published.manifest.version
    const requested = await requestDelist(catalog, SLUG, version, '不再维护')
    const request = requested.body as DelistRequest

    const approved = await approveDelist(catalog, request.id)
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    const resolved = approved.body as DelistRequest
    assert.equal(resolved.id, request.id)
    assert.equal(resolved.status, 'approved')
    assert.equal(resolved.reason, '不再维护')
    assert.equal(resolved.actor, actorOf(PUBLISH_TOKEN))
    assert.equal(Number.isNaN(Date.parse(String(resolved.resolvedAt))), false)

    // ONE commit moved both records.
    const state = await readState(catalog)
    assert.equal(state.packages[packageKey(SLUG, version)]?.status, 'delisted')
    assert.equal(state.delistRequests[request.id]?.status, 'approved')
    assert.equal(state.delistRequests[request.id]?.resolvedAt, resolved.resolvedAt)

    const pendingAfter = await listDelistRequests(catalog)
    assert.equal(pendingAfter.status, 200)
    assert.deepEqual(pendingAfter.body, { items: [] })

    // The list hides it; the bundle is gone with the documented 410.
    const listed = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.deepEqual(listed.body, { items: [] })
    const withdrawn = await bundle(catalog, SLUG, version)
    assert.equal(withdrawn.status, 410)
    assert.deepEqual(withdrawn.body, { error: '版本已下架', code: 'package-delisted' })

    // Installed clients keep the digest and signature to explain the state.
    const detail = await metadata(catalog, SLUG, version)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.status, 'delisted')
    assert.equal('bundleUrl' in detail.body, false)
    assert.deepEqual(detail.body.digest, published.digest)
    assert.deepEqual(detail.body.signature, published.signature)
    assert.equal(detail.body.version, version)

    // A resolved request is never resolved twice.
    const again = await approveDelist(catalog, request.id)
    assert.equal(again.status, 409)
    assert.deepEqual(again.body, { error: '下架申请已处理', code: 'delist-request-not-pending' })
    const rejectedLate = await rejectDelist(catalog, request.id, '太迟了')
    assert.equal(rejectedLate.status, 409)
    assert.equal(rejectedLate.body.code, 'delist-request-not-pending')

    // An already-delisted version cannot be requested again.
    const duplicate = await requestDelist(catalog, SLUG, version, '再下一次')
    assert.equal(duplicate.status, 409)
    assert.deepEqual(duplicate.body, { error: '版本未处于已发布状态', code: 'package-not-published' })
  } finally {
    await catalog.close()
  }
})

test('rejecting a delist request leaves the version published', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog)
    const version = published.manifest.version
    const first = (await requestDelist(catalog, SLUG, version, '想下线')).body as DelistRequest

    const rejected = await rejectDelist(catalog, first.id, '内容合规')
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
    const resolved = rejected.body as DelistRequest
    assert.equal(resolved.id, first.id)
    assert.equal(resolved.status, 'rejected')
    assert.equal(resolved.reason, '想下线')
    assert.equal(Number.isNaN(Date.parse(String(resolved.resolvedAt))), false)

    // Reject only touches the request: the package keeps serving.
    const state = await readState(catalog)
    assert.equal(state.packages[packageKey(SLUG, version)]?.status, 'published')
    assert.equal(state.delistRequests[first.id]?.status, 'rejected')
    const listed = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.deepEqual(listedSlugs(listed.body), [`${SLUG}/${version}`])
    assert.equal((await bundle(catalog, SLUG, version)).status, 200)

    // The admin reason is optional and lands in the audit, never in the record.
    const second = (await requestDelist(catalog, SLUG, version, '还是想下线')).body as DelistRequest
    assert.notEqual(second.id, first.id)
    assert.equal(second.status, 'pending')
    const rejectedWithoutReason = await rejectDelist(catalog, second.id)
    assert.equal(rejectedWithoutReason.status, 200)
    assert.equal(rejectedWithoutReason.body.status, 'rejected')

    const audit = await catalog.readAudit()
    const rejections = audit.filter(record => record.action === 'agentPackages.delistRequests.reject')
    assert.equal(rejections.length, 2)
    assert.match(String(rejections[0]?.reason), /内容合规/u)
    assert.match(String(rejections[1]?.reason), /rejected/u)
  } finally {
    await catalog.close()
  }
})

test('returns the same request id for a duplicate pending request', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const version = (await publish(catalog)).manifest.version
    const first = await requestDelist(catalog, SLUG, version, '第一次申请')
    assert.equal(first.status, 201)
    const firstId = (first.body as DelistRequest).id

    const duplicate = await requestDelist(catalog, SLUG, version, '换一个理由')
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body))
    assert.equal((duplicate.body as DelistRequest).id, firstId)
    // Idempotent, not a rewrite: the FIRST reason survives.
    assert.equal((duplicate.body as DelistRequest).reason, '第一次申请')

    const state = await readState(catalog)
    assert.equal(Object.keys(state.delistRequests).length, 1)
    assert.equal((await listDelistRequests(catalog)).body.items.length, 1)

    // The package lock makes two concurrent applications share one record.
    assert.equal((await approveDelist(catalog, firstId)).status, 200)
    const version2 = '1.0.1'
    await publish(catalog, { version: version2 })
    const [left, right] = await Promise.all([
      requestDelist(catalog, SLUG, version2, '并发甲'),
      requestDelist(catalog, SLUG, version2, '并发乙'),
    ])
    assert.deepEqual([left.status, right.status].sort(), [200, 201])
    assert.equal((left.body as DelistRequest).id, (right.body as DelistRequest).id)
    const afterRace = await readState(catalog)
    assert.equal(
      Object.values(afterRace.delistRequests).filter(
        record => record.slug === SLUG && record.version === version2,
      ).length,
      1,
    )
  } finally {
    await catalog.close()
  }
})

test('only the creator of the published version may request delisting', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const version = (await publish(catalog)).manifest.version

    // Role matrix: only the publish token may apply at all.
    assert.equal((await requestDelist(catalog, SLUG, version, '我来申请', READ_TOKEN)).status, 403)
    assert.equal((await requestDelist(catalog, SLUG, version, '我来申请', ADMIN_TOKEN)).status, 403)

    // The published record's `actor` is the APPROVING administrator (Task 5).
    // The creator is the actor of the submission that produced the version, so
    // a publish actor that did not create this version is refused.
    const state = await readState(catalog)
    const submissionId = Object.keys(state.submissions)[0] as string
    await catalog.runtime.store.update(draft => {
      ;(draft.submissions[submissionId] as { actor: string }).actor = 'ffffffffffff'
    })
    const denied = await requestDelist(catalog, SLUG, version, '不是我的包')
    assert.equal(denied.status, 403)
    assert.deepEqual(denied.body, { error: '权限不足', code: 'forbidden' })
    assert.equal(Object.keys((await readState(catalog)).delistRequests).length, 0)

    // Fallback: with no surviving submission link the stored creator actor is
    // the only evidence, so it is accepted instead of locking the version out.
    const otherSlug = 'orphaned-report'
    const otherVersion = (await publish(catalog, { slug: otherSlug })).manifest.version
    const otherState = await readState(catalog)
    const otherSubmission = Object.values(otherState.submissions).find(
      record => record.slug === otherSlug,
    )
    assert.ok(otherSubmission)
    await catalog.runtime.store.update(draft => {
      delete draft.submissions[otherSubmission.id]
      ;(draft.packages[packageKey(otherSlug, otherVersion)] as { actor: string }).actor =
        actorOf(PUBLISH_TOKEN)
    })
    const fallback = await requestDelist(catalog, otherSlug, otherVersion, '创建者本人')
    assert.equal(fallback.status, 201, JSON.stringify(fallback.body))
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Revocations and the shared read filtering
// ---------------------------------------------------------------------------

test('revokes versions, hides them and serves exact revocation records', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const alpha = await publish(catalog, { slug: 'alpha', version: '1.0.0' })
    await publish(catalog, { slug: 'bravo', version: '1.0.0' })
    await publish(catalog, { slug: 'charlie', version: '1.0.0' })
    await publish(catalog, { slug: 'delta', version: '1.0.0' })

    const revoked = await revoke(catalog, 'alpha', '1.0.0', '包含危险指令')
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    const record = revoked.body as Revocation
    assert.deepEqual(Object.keys(record).sort(), ['actor', 'reason', 'revokedAt', 'slug', 'version'])
    assert.equal(record.slug, 'alpha')
    assert.equal(record.version, '1.0.0')
    assert.equal(record.reason, '包含危险指令')
    assert.equal(record.actor, actorOf(ADMIN_TOKEN))
    assert.equal(Number.isNaN(Date.parse(record.revokedAt)), false)

    assert.equal((await revoke(catalog, 'bravo', '1.0.0', '凭据泄露')).status, 200)
    assert.equal((await revoke(catalog, 'unknown-slug', '1.0.0', 'x')).status, 404)

    // List/metadata/bundle all consult the same distribution helper.
    const listed = await catalog.request('/v1/agent-packages', { token: READ_TOKEN })
    assert.deepEqual(listedSlugs(listed.body), ['charlie/1.0.0', 'delta/1.0.0'])
    const withdrawn = await bundle(catalog, 'alpha', '1.0.0')
    assert.equal(withdrawn.status, 410)
    assert.deepEqual(withdrawn.body, { error: '版本已撤销', code: 'package-revoked' })
    const detail = await metadata(catalog, 'alpha', '1.0.0')
    assert.equal(detail.status, 200)
    assert.equal(detail.body.status, 'revoked')
    assert.equal('bundleUrl' in detail.body, false)
    assert.deepEqual(detail.body.digest, alpha.digest)
    assert.deepEqual(detail.body.signature, alpha.signature)

    // The revocation list is read-token only and carries exact fields.
    assert.equal((await listRevocations(catalog, PUBLISH_TOKEN)).status, 403)
    const revocations = await listRevocations(catalog)
    assert.equal(revocations.status, 200)
    const items = revocations.body.items as Revocation[]
    assert.equal(items.length, 2)
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ['actor', 'reason', 'revokedAt', 'slug', 'version'])
    }

    // Stable order: revokedAt first, then slug/version. Force a tie to pin the
    // tie-break, then distinct times to pin the precedence.
    await catalog.runtime.store.update(draft => {
      for (const item of Object.values(draft.revocations)) {
        ;(item as { revokedAt: string }).revokedAt = '2026-10-24T00:00:00.000Z'
      }
    })
    const tied = (await listRevocations(catalog)).body.items as Revocation[]
    assert.deepEqual(
      tied.map(item => `${item.slug}/${item.version}`),
      ['alpha/1.0.0', 'bravo/1.0.0'],
    )
    await catalog.runtime.store.update(draft => {
      ;(draft.revocations[packageKey('alpha', '1.0.0')] as { revokedAt: string }).revokedAt =
        '2026-10-24T00:00:02.000Z'
      ;(draft.revocations[packageKey('bravo', '1.0.0')] as { revokedAt: string }).revokedAt =
        '2026-10-24T00:00:01.000Z'
    })
    const ordered = (await listRevocations(catalog)).body.items as Revocation[]
    assert.deepEqual(
      ordered.map(item => `${item.slug}/${item.version}`),
      ['bravo/1.0.0', 'alpha/1.0.0'],
    )

    const state = await readState(catalog)
    assert.equal(state.packages[packageKey('alpha', '1.0.0')]?.status, 'revoked')
    assert.equal(Object.keys(state.revocations).length, 2)
  } finally {
    await catalog.close()
  }
})

test('revocation is idempotent and a delisted version can be revoked', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const version = (await publish(catalog)).manifest.version
    const first = (await revoke(catalog, SLUG, version, '第一次撤销')).body as Revocation
    const stateAfterFirst = await readState(catalog)

    const second = await revoke(catalog, SLUG, version, '第二次理由不同')
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, first)
    const stateAfterSecond = await readState(catalog)
    assert.deepEqual(stateAfterSecond.revocations, stateAfterFirst.revocations)
    // No write at all: the package timestamp did not move either.
    assert.equal(
      stateAfterSecond.packages[packageKey(SLUG, version)]?.updatedAt,
      stateAfterFirst.packages[packageKey(SLUG, version)]?.updatedAt,
    )
    const audit = await catalog.readAudit()
    const revocations = audit.filter(record => record.action === 'agentPackages.revoke')
    assert.equal(revocations.length, 2)
    assert.match(String(revocations[1]?.reason), /idempotent/u)

    // A delisted version can still be revoked (delist is not a security action).
    const delistedSlug = 'withdrawn-report'
    const delistedVersion = (await publish(catalog, { slug: delistedSlug })).manifest.version
    const request = (await requestDelist(catalog, delistedSlug, delistedVersion, '先下架')).body as DelistRequest
    assert.equal((await approveDelist(catalog, request.id)).status, 200)
    const escalated = await revoke(catalog, delistedSlug, delistedVersion, '后来发现不安全')
    assert.equal(escalated.status, 200, JSON.stringify(escalated.body))
    assert.equal((escalated.body as Revocation).reason, '后来发现不安全')
    const state = await readState(catalog)
    assert.equal(state.packages[packageKey(delistedSlug, delistedVersion)]?.status, 'revoked')
    assert.equal(state.delistRequests[request.id]?.status, 'approved')
    assert.equal((await bundle(catalog, delistedSlug, delistedVersion)).status, 410)
    assert.equal((await metadata(catalog, delistedSlug, delistedVersion)).body.status, 'revoked')
  } finally {
    await catalog.close()
  }
})

test('rejects unknown versions and malformed governance reasons', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const version = (await publish(catalog)).manifest.version

    // Unknown versions are 404 on every governance write.
    assert.equal((await requestDelist(catalog, SLUG, '9.9.9', 'x')).status, 404)
    assert.equal((await requestDelist(catalog, 'no-such-slug', version, 'x')).status, 404)
    assert.equal((await revoke(catalog, SLUG, '9.9.9', 'x')).status, 404)
    assert.equal((await revoke(catalog, 'no-such-slug', version, 'x')).status, 404)
    // Identity-looking traversal never resolves to state.
    assert.equal((await revoke(catalog, '..%2Falpha', version, 'x')).status, 404)

    // reason must be a trimmed string of 1-500 characters.
    for (const bad of ['', '   ', 'x'.repeat(501), 42, null]) {
      const response = await requestDelist(catalog, SLUG, version, bad)
      assert.equal(response.status, 400, `delist reason ${JSON.stringify(bad)}`)
      assert.deepEqual(response.body, { error: '原因需为 1-500 个字符', code: 'invalid-reason' })
      const revoked = await revoke(catalog, SLUG, version, bad)
      assert.equal(revoked.status, 400, `revoke reason ${JSON.stringify(bad)}`)
      assert.equal(revoked.body.code, 'invalid-reason')
    }
    // A missing body is a body error, not a reason error.
    assert.equal(
      (await catalog.request(`/v1/agent-packages/${SLUG}/${version}/delist-requests`, {
        method: 'POST',
        token: PUBLISH_TOKEN,
      })).status,
      400,
    )
    // The 500-character boundary is accepted.
    const boundary = await revoke(catalog, SLUG, version, 'x'.repeat(500))
    assert.equal(boundary.status, 200)
  } finally {
    await catalog.close()
  }
})

test('denies unrevoke, wrong roles and unknown governance routes', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const version = (await publish(catalog)).manifest.version
    const request = (await requestDelist(catalog, SLUG, version, '申请')).body as DelistRequest

    // Wrong roles never reach a governance handler.
    assert.equal((await revoke(catalog, SLUG, version, '越权', PUBLISH_TOKEN)).status, 403)
    assert.equal((await revoke(catalog, SLUG, version, '越权', READ_TOKEN)).status, 403)
    assert.equal((await approveDelist(catalog, request.id, PUBLISH_TOKEN)).status, 403)
    assert.equal((await rejectDelist(catalog, request.id, '越权', PUBLISH_TOKEN)).status, 403)
    assert.equal((await approveDelist(catalog, request.id, READ_TOKEN)).status, 403)

    // There is deliberately no unrevoke route.
    const unrevoke = await catalog.request(`/v1/agent-packages/${SLUG}/${version}/unrevoke`, {
      method: 'POST',
      token: ADMIN_TOKEN,
    })
    assert.equal(unrevoke.status, 404)
    assert.deepEqual(unrevoke.body, { error: 'Not Found' })

    // Methods are enforced after authorization.
    assert.equal(
      (await catalog.request(`/v1/agent-packages/${SLUG}/${version}/revoke`, {
        method: 'PUT',
        token: ADMIN_TOKEN,
      })).status,
      405,
    )
    assert.equal(
      (await catalog.request(`/v1/agent-packages/${SLUG}/${version}/delist-requests`, {
        method: 'GET',
        token: PUBLISH_TOKEN,
      })).status,
      405,
    )

    // The pending queue only supports `status=pending`.
    assert.equal(
      (await catalog.request('/v1/agent-packages/delist-requests', { token: ADMIN_TOKEN })).status,
      400,
    )
    assert.equal(
      (await catalog.request('/v1/agent-packages/delist-requests?status=all', { token: ADMIN_TOKEN })).status,
      400,
    )

    // Malformed request ids are misses, never state lookups.
    assert.equal((await approveDelist(catalog, 'not-a-request-id')).status, 404)
    assert.equal((await rejectDelist(catalog, 'not-a-request-id')).status, 404)
    assert.equal((await approveDelist(catalog, '00000000-0000-4000-8000-000000000000')).status, 404)

    // Refusals on a request route still name the request in the audit trail.
    const audit = await catalog.readAudit()
    const deniedApprovals = audit.filter(
      record =>
        record.action === 'agentPackages.delistRequests.approve' && record.outcome === 'denied',
    )
    assert.equal(deniedApprovals.length, 2)
    for (const record of deniedApprovals) {
      assert.equal(record.delistRequestId, request.id)
      assert.equal(record.status, 403)
    }
    const deniedRejections = audit.filter(
      record =>
        record.action === 'agentPackages.delistRequests.reject' && record.outcome === 'denied',
    )
    assert.equal(deniedRejections.length, 1)
    assert.equal(deniedRejections[0]?.delistRequestId, request.id)
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Audit and the approval/revocation race
// ---------------------------------------------------------------------------

test('audits governance writes with the request id and never the tokens', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const version = (await publish(catalog)).manifest.version
    const approvedRequest = (await requestDelist(catalog, SLUG, version, '合规下线')).body as DelistRequest
    assert.equal((await approveDelist(catalog, approvedRequest.id)).status, 200)

    const rejectedVersion = '1.0.1'
    await publish(catalog, { version: rejectedVersion })
    const rejectedRequest = (await requestDelist(catalog, SLUG, rejectedVersion, '误报')).body as DelistRequest
    assert.equal((await rejectDelist(catalog, rejectedRequest.id, '内容无问题')).status, 200)

    const revokedSlug = 'rogue-report'
    await publish(catalog, { slug: revokedSlug })
    assert.equal((await revoke(catalog, revokedSlug, '1.0.0', '不安全')).status, 200)

    const audit = await catalog.readAudit()
    const creates = audit.filter(record => record.action === 'agentPackages.delistRequests.create')
    assert.equal(creates.length, 2)
    for (const record of creates) {
      assert.equal(record.outcome, 'ok')
      assert.equal(record.slug, SLUG)
      assert.equal(record.actor, actorOf(PUBLISH_TOKEN))
      assert.equal(typeof record.delistRequestId, 'string')
    }
    assert.deepEqual(
      creates.map(record => record.delistRequestId),
      [approvedRequest.id, rejectedRequest.id],
    )

    const approvals = audit.filter(record => record.action === 'agentPackages.delistRequests.approve')
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0]?.status, 200)
    assert.equal(approvals[0]?.delistRequestId, approvedRequest.id)
    assert.equal(approvals[0]?.actor, actorOf(ADMIN_TOKEN))

    const rejections = audit.filter(record => record.action === 'agentPackages.delistRequests.reject')
    assert.equal(rejections.length, 1)
    assert.equal(rejections[0]?.delistRequestId, rejectedRequest.id)
    assert.match(String(rejections[0]?.reason), /内容无问题/u)

    const revocations = audit.filter(record => record.action === 'agentPackages.revoke')
    assert.equal(revocations.length, 1)
    assert.equal(revocations[0]?.slug, revokedSlug)
    assert.equal(revocations[0]?.version, '1.0.0')
    assert.equal(revocations[0]?.status, 200)
    assert.equal(revocations[0]?.actor, actorOf(ADMIN_TOKEN))

    const raw = await catalog.readAuditRaw()
    for (const token of [READ_TOKEN, PUBLISH_TOKEN, ADMIN_TOKEN]) {
      assert.equal(raw.includes(token), false, `audit log leaked ${token}`)
    }
    assert.equal(raw.toLowerCase().includes('authorization'), false)
  } finally {
    await catalog.close()
  }
})

test('serializes delist approval against revocation and always ends revoked', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // Order 1: the approval wins the lock first, the revocation then escalates.
    const first = await publish(catalog, { slug: 'ordered-report' })
    const firstRequest = (await requestDelist(catalog, 'ordered-report', first.manifest.version, '先下架'))
      .body as DelistRequest
    assert.equal((await approveDelist(catalog, firstRequest.id)).status, 200)
    assert.equal((await revoke(catalog, 'ordered-report', first.manifest.version, '再撤销')).status, 200)

    // Order 2: the revocation wins; a later approval must NOT downgrade it.
    const second = await publish(catalog, { slug: 'reversed-report' })
    const secondRequest = (await requestDelist(catalog, 'reversed-report', second.manifest.version, '申请下架'))
      .body as DelistRequest
    assert.equal((await revoke(catalog, 'reversed-report', second.manifest.version, '先撤销')).status, 200)
    const lateApproval = await approveDelist(catalog, secondRequest.id)
    assert.equal(lateApproval.status, 200, JSON.stringify(lateApproval.body))
    assert.equal(lateApproval.body.status, 'approved')
    assert.equal(
      (await readState(catalog)).packages[packageKey('reversed-report', second.manifest.version)]?.status,
      'revoked',
    )

    // Order 3: a genuine concurrent race is serialized by the package lock.
    const third = await publish(catalog, { slug: 'raced-report' })
    const thirdRequest = (await requestDelist(catalog, 'raced-report', third.manifest.version, '并发下架'))
      .body as DelistRequest
    const [approval, revocation] = await Promise.all([
      approveDelist(catalog, thirdRequest.id),
      revoke(catalog, 'raced-report', third.manifest.version, '并发撤销'),
    ])
    assert.equal(approval.status, 200, JSON.stringify(approval.body))
    assert.equal(revocation.status, 200, JSON.stringify(revocation.body))
    assert.equal((revocation.body as Revocation).reason, '并发撤销')

    const state = await readState(catalog)
    assert.equal(
      state.packages[packageKey('raced-report', third.manifest.version)]?.status,
      'revoked',
    )
    assert.equal(state.delistRequests[thirdRequest.id]?.status, 'approved')
    assert.equal(
      state.revocations[packageKey('raced-report', third.manifest.version)]?.reason,
      '并发撤销',
    )

    // Both operations left their own audit line for the same version.
    const audit = await catalog.readAudit()
    const racedApprovals = audit.filter(
      record =>
        record.action === 'agentPackages.delistRequests.approve' &&
        record.slug === 'raced-report',
    )
    const racedRevocations = audit.filter(
      record => record.action === 'agentPackages.revoke' && record.slug === 'raced-report',
    )
    assert.equal(racedApprovals.length, 1)
    assert.equal(racedApprovals[0]?.status, 200)
    assert.equal(racedApprovals[0]?.delistRequestId, thirdRequest.id)
    assert.equal(racedRevocations.length, 1)
    assert.equal(racedRevocations[0]?.status, 200)
    assert.equal(racedRevocations[0]?.version, third.manifest.version)
  } finally {
    await catalog.close()
  }
})
