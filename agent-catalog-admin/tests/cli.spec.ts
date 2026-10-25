/**
 * Task 7: the offline administrator CLI against the REAL catalog server.
 *
 * Every scenario spawns `src/cli.ts` as a child process; the catalog is a real
 * HTTP server on an ephemeral loopback port with a throwaway Ed25519 keypair.
 * Nothing here uses a public read route for review, and nothing asserts on
 * production material: the tokens are obvious test strings and each keypair is
 * generated per test.
 */

import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  inspectSignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
  type AgentPackageDigest,
} from '@huaanwork/agent-package-format'
import { generateKeyPair } from '@huaanwork/catalog-signing'

import {
  ADMIN_TOKEN,
  CLI_PATH,
  PUBLISH_TOKEN,
  READ_TOKEN,
  adminEnv,
  bootTestCatalog,
  cliInvocations,
  collectedAuditTrails,
  collectedPrivateKeys,
  receiptDigestSha256,
  runCli,
  startStubServer,
  submitTestPackage,
  type CliResult,
  type SubmittedTestPackage,
  type TestCatalog,
} from './helpers.ts'

interface SubmissionBody {
  submissionId: string
  slug: string
  version: string
  status: string
  digest: AgentPackageDigest
  reason?: string
}

async function reviewDir(catalog: TestCatalog, name: string): Promise<string> {
  const dir = join(catalog.root, 'reviews', name)
  await mkdir(dir, { recursive: true })
  return dir
}

async function reviewViaCli(
  catalog: TestCatalog,
  submissionId: string,
  dir: string,
): Promise<string> {
  const result = await runCli(['review', submissionId, '--out', dir], adminEnv(catalog))
  assert.equal(result.status, 0, `review failed: ${result.stderr}`)
  return result.stdout
}

function approveViaCli(
  catalog: TestCatalog,
  submissionId: string,
  receiptPath: string,
  options: { readonly privateKeyPath?: string; readonly env?: Record<string, string> } = {},
): Promise<CliResult> {
  return runCli(
    [
      'approve',
      submissionId,
      '--review',
      receiptPath,
      '--private-key',
      options.privateKeyPath ?? catalog.privateKeyPath,
      '--slot',
      '1',
      '--yes',
    ],
    options.env ?? adminEnv(catalog),
  )
}

/** Submit → review → approve, all through the real CLI surfaces. */
async function publishViaCli(
  catalog: TestCatalog,
  name: string,
  options: Parameters<typeof submitTestPackage>[1] = {},
): Promise<SubmittedTestPackage> {
  const submitted = await submitTestPackage(catalog, options)
  const dir = await reviewDir(catalog, name)
  await reviewViaCli(catalog, submitted.submission.submissionId, dir)
  const approved = await approveViaCli(
    catalog,
    submitted.submission.submissionId,
    join(dir, 'review.json'),
  )
  assert.equal(approved.status, 0, `approve failed: ${approved.stderr}`)
  return submitted
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

test('runs the command when invoked through a symlinked entry point', async () => {
  const catalog = await bootTestCatalog()
  const linkDir = await mkdtemp(join(tmpdir(), 'agent-catalog-admin-link-'))
  // A `bin` link or a wrapper is exactly this: argv[1] is not the real file.
  // Before the realpath comparison the CLI compared the unresolved path with
  // Node's realpath-resolved `import.meta.url`, matched nothing, and exited 0
  // with no output — a silent success for a signing tool.
  const linkPath = join(linkDir, 'agent-catalog-admin.ts')
  await symlink(CLI_PATH, linkPath)
  try {
    assert.notEqual(linkPath, realpathSync(CLI_PATH))
    assert.equal(realpathSync(linkPath), realpathSync(CLI_PATH))

    const pending = await runCli(['pending'], adminEnv(catalog), { entry: linkPath })
    assert.equal(pending.status, 0, pending.stderr)
    assert.match(pending.stdout, /待审查提交：无/)

    // Usage errors still surface (exit 2), proving the entry guard ran rather
    // than the process doing nothing and reporting success.
    const usage = await runCli([], adminEnv(catalog), { entry: linkPath })
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /缺少子命令/)
  } finally {
    await rm(linkDir, { recursive: true, force: true })
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// review + approve
// ---------------------------------------------------------------------------

test('review prints manifest/files/上一版本：无 and approve publishes a verifiable bundle', async () => {
  const catalog = await bootTestCatalog()
  try {
    const submitted = await submitTestPackage(catalog)
    const submissionId = submitted.submission.submissionId

    const pending = await runCli(['pending'], adminEnv(catalog))
    assert.equal(pending.status, 0, pending.stderr)
    assert.match(pending.stdout, new RegExp(submissionId))

    const dir = await reviewDir(catalog, 'first')
    const review = await runCli(['review', submissionId, '--out', dir], adminEnv(catalog))
    assert.equal(review.status, 0, review.stderr)
    assert.match(review.stdout, /weekly-report/)
    assert.match(review.stdout, /agent\.json/)
    assert.match(review.stdout, /上一版本/)
    assert.match(review.stdout, /上一版本：无/)

    const receiptPath = join(dir, 'review.json')
    const receiptText = await readFile(receiptPath, 'utf8')
    const receipt = JSON.parse(receiptText) as {
      schemaVersion: number
      submissionId: string
      digest: AgentPackageDigest
      digestSha256: string
      reviewedAt: string
    }
    assert.equal(receipt.schemaVersion, 1)
    assert.equal(receipt.submissionId, submissionId)
    assert.deepEqual(receipt.digest, submitted.digest)
    assert.equal(receipt.digestSha256, receiptDigestSha256(submitted.digest))
    assert.ok(!Number.isNaN(Date.parse(receipt.reviewedAt)))
    assert.ok(!receiptText.includes(ADMIN_TOKEN))

    const approved = await approveViaCli(catalog, submissionId, receiptPath)
    assert.equal(approved.status, 0, approved.stderr)
    assert.match(approved.stdout, /已批准并发布：weekly-report\/1\.0\.0/)

    const metadata = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal(metadata.status, 200)
    const meta = metadata.body as {
      status: string
      digest: AgentPackageDigest
      signature: { keyId: string }
    }
    assert.equal(meta.status, 'published')
    assert.equal(meta.signature.keyId, catalog.keyring.keyId)
    assert.deepEqual(meta.digest, submitted.digest)

    const bundle = await catalog.request('/v1/agent-packages/weekly-report/1.0.0/bundle', {
      token: READ_TOKEN,
    })
    assert.equal(bundle.status, 200)
    const inspected = await inspectSignedAgentPackageBundle(bundle.buffer, [catalog.keyring])
    assert.deepEqual(inspected.digest, submitted.digest)
    assert.equal(inspected.manifest.slug, 'weekly-report')

    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    assert.equal((detail.body as SubmissionBody).status, 'published')

    const audit = await catalog.readAudit()
    assert.ok(
      audit.some(
        (record) =>
          record.action === 'agentPackages.submissions.approve' && record.outcome === 'ok',
      ),
    )
  } finally {
    await catalog.close()
  }
})

test('approve without --yes neither signs nor publishes', async () => {
  const catalog = await bootTestCatalog()
  try {
    const submitted = await submitTestPackage(catalog)
    const submissionId = submitted.submission.submissionId
    const dir = await reviewDir(catalog, 'no-yes')
    await reviewViaCli(catalog, submissionId, dir)

    const early = await runCli(
      [
        'approve',
        submissionId,
        '--review',
        join(dir, 'review.json'),
        '--private-key',
        catalog.privateKeyPath,
        '--slot',
        '1',
      ],
      adminEnv(catalog),
    )
    assert.notEqual(early.status, 0)
    assert.match(early.stderr, /--yes/)

    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    assert.equal((detail.body as SubmissionBody).status, 'pending-review')
    const metadata = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal(metadata.status, 404)
    const audit = await catalog.readAudit()
    assert.equal(
      audit.filter((record) => record.action === 'agentPackages.submissions.approve').length,
      0,
    )
  } finally {
    await catalog.close()
  }
})

test('approve refuses when the server digest changed after review', async () => {
  const catalog = await bootTestCatalog()
  try {
    const submitted = await submitTestPackage(catalog)
    const submissionId = submitted.submission.submissionId
    const dir = await reviewDir(catalog, 'tampered')
    await reviewViaCli(catalog, submissionId, dir)

    // A catalog whose stored digest no longer matches what was reviewed: the
    // receipt must win, and no signature may ever be produced for the new one.
    const tampered = {
      ...submitted.submission,
      digest: {
        ...submitted.digest,
        files: submitted.digest.files.map((file, index) =>
          index === 0 ? { ...file, sha256: '0'.repeat(64) } : file,
        ),
      },
    }
    const stub = await startStubServer((request) => {
      if (
        request.method === 'GET'
        && request.path === `/v1/agent-packages/submissions/${submissionId}`
      ) {
        return { body: JSON.stringify(tampered) }
      }
      return undefined
    })
    try {
      const early = await approveViaCli(catalog, submissionId, join(dir, 'review.json'), {
        env: { ...adminEnv(catalog), AGENT_CATALOG_URL: stub.baseUrl },
      })
      assert.notEqual(early.status, 0)
      assert.match(early.stderr, /审查回执不一致|不一致/)
      assert.equal(
        stub.requests.filter((request) => request.method === 'POST').length,
        0,
        'the CLI must not POST an approve for a digest it never reviewed',
      )
    } finally {
      await stub.close()
    }

    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    assert.equal((detail.body as SubmissionBody).status, 'pending-review')
    const metadata = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal(metadata.status, 404)
  } finally {
    await catalog.close()
  }
})

test('approve with a key outside the keyring fails and keeps the submission pending', async () => {
  const catalog = await bootTestCatalog()
  try {
    const submitted = await submitTestPackage(catalog)
    const submissionId = submitted.submission.submissionId
    const dir = await reviewDir(catalog, 'wrong-key')
    await reviewViaCli(catalog, submissionId, dir)

    const wrong = generateKeyPair()
    const wrongKeyPath = join(catalog.root, 'wrong-key.pem')
    await writeFile(wrongKeyPath, wrong.privateKeyPem, { mode: 0o600 })

    const failed = await approveViaCli(catalog, submissionId, join(dir, 'review.json'), {
      privateKeyPath: wrongKeyPath,
    })
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /签名无效|invalid-signature/)
    for (const line of wrong.privateKeyPem.split('\n')) {
      if (line.trim() === '' || line.startsWith('-----')) continue
      assert.ok(!failed.stderr.includes(line))
    }

    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    assert.equal((detail.body as SubmissionBody).status, 'pending-review')
    const metadata = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal(metadata.status, 404)
  } finally {
    await catalog.close()
  }
})

test('approve refuses a receipt whose digestSha256 no longer matches its digest', async () => {
  const catalog = await bootTestCatalog()
  try {
    const submitted = await submitTestPackage(catalog)
    const submissionId = submitted.submission.submissionId
    const dir = await reviewDir(catalog, 'tampered-receipt')
    await reviewViaCli(catalog, submissionId, dir)

    const receiptPath = join(dir, 'review.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    receipt.digestSha256 = 'f'.repeat(64)
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)

    const failed = await approveViaCli(catalog, submissionId, receiptPath)
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /回执/)
    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    assert.equal((detail.body as SubmissionBody).status, 'pending-review')
  } finally {
    await catalog.close()
  }
})

test('review diffs the candidate against the previously signed version', async () => {
  const catalog = await bootTestCatalog()
  try {
    await publishViaCli(catalog, 'v1', {
      version: '1.0.0',
      persona: '第一版人设',
      extraFiles: [{ path: 'notes/old.md', data: Buffer.from('旧附件') }],
    })

    const next = await submitTestPackage(catalog, {
      version: '1.0.1',
      persona: '第二版人设',
      extraFiles: [{ path: 'notes/new.md', data: Buffer.from('新附件') }],
    })
    const dir = await reviewDir(catalog, 'diff')
    const stdout = await reviewViaCli(catalog, next.submission.submissionId, dir)

    assert.match(stdout, /上一版本：1\.0\.0/)
    assert.match(stdout, /added: notes\/new\.md/)
    assert.match(stdout, /removed: notes\/old\.md/)
    assert.match(stdout, /changed: persona\.md/)
    assert.match(stdout, /之前: [0-9a-f]{64}/)
    assert.match(stdout, /之后: [0-9a-f]{64}/)
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// governance
// ---------------------------------------------------------------------------

test('reject hits the real API, trims the reason and validates its budget', async () => {
  const catalog = await bootTestCatalog()
  try {
    const submitted = await submitTestPackage(catalog)
    const submissionId = submitted.submission.submissionId

    const invalid = await runCli(
      ['reject', submissionId, '--reason', '   '],
      adminEnv(catalog),
    )
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /1-500/)

    const rejected = await runCli(
      ['reject', submissionId, '--reason', '  内容不合规  '],
      adminEnv(catalog),
    )
    assert.equal(rejected.status, 0, rejected.stderr)
    assert.match(rejected.stdout, /已拒绝：weekly-report\/1\.0\.0/)

    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    const body = detail.body as SubmissionBody
    assert.equal(body.status, 'rejected')
    assert.equal(body.reason, '内容不合规')
    const metadata = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal(metadata.status, 404)
  } finally {
    await catalog.close()
  }
})

test('delist requests are listed, approved (delists) or rejected (stays published)', async () => {
  const catalog = await bootTestCatalog()
  try {
    await publishViaCli(catalog, 'weekly', { slug: 'weekly-report' })
    await publishViaCli(catalog, 'notes', { slug: 'team-notes' })

    const first = await catalog.request('/v1/agent-packages/weekly-report/1.0.0/delist-requests', {
      method: 'POST',
      token: PUBLISH_TOKEN,
      body: { reason: '内容需要下线' },
    })
    assert.equal(first.status, 201)
    const firstId = (first.body as { id: string }).id

    const second = await catalog.request('/v1/agent-packages/team-notes/1.0.0/delist-requests', {
      method: 'POST',
      token: PUBLISH_TOKEN,
      body: { reason: '暂时下架' },
    })
    assert.equal(second.status, 201)
    const secondId = (second.body as { id: string }).id

    const listed = await runCli(['delist-requests'], adminEnv(catalog))
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, new RegExp(firstId))
    assert.match(listed.stdout, new RegExp(secondId))
    assert.match(listed.stdout, /weekly-report\/1\.0\.0/)

    const approved = await runCli(['delist-approve', firstId], adminEnv(catalog))
    assert.equal(approved.status, 0, approved.stderr)
    assert.match(approved.stdout, /已批准下架：weekly-report\/1\.0\.0/)

    const delisted = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal((delisted.body as { status: string }).status, 'delisted')
    const delistedBundle = await catalog.request('/v1/agent-packages/weekly-report/1.0.0/bundle', {
      token: READ_TOKEN,
    })
    assert.equal(delistedBundle.status, 410)

    const rejected = await runCli(
      ['delist-reject', secondId, '--reason', '  暂不下架  '],
      adminEnv(catalog),
    )
    assert.equal(rejected.status, 0, rejected.stderr)
    assert.match(rejected.stdout, /已驳回下架申请：team-notes\/1\.0\.0/)

    const stillPublished = await catalog.request('/v1/agent-packages/team-notes/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal((stillPublished.body as { status: string }).status, 'published')
    const stillDownloadable = await catalog.request('/v1/agent-packages/team-notes/1.0.0/bundle', {
      token: READ_TOKEN,
    })
    assert.equal(stillDownloadable.status, 200)
    assert.equal(
      catalog.runtime.store.read().delistRequests[secondId]?.status,
      'rejected',
    )

    const audit = await catalog.readAudit()
    assert.ok(
      audit.some(
        (record) =>
          record.action === 'agentPackages.delistRequests.approve' && record.outcome === 'ok',
      ),
    )
    assert.ok(
      audit.some(
        (record) =>
          record.action === 'agentPackages.delistRequests.reject' && record.outcome === 'ok',
      ),
    )
  } finally {
    await catalog.close()
  }
})

test('revoke marks the version revoked, blocks download and keeps the first reason', async () => {
  const catalog = await bootTestCatalog()
  try {
    await publishViaCli(catalog, 'revoke')

    const invalid = await runCli(
      ['revoke', 'weekly-report', '1.0.0', '--reason', '  '],
      adminEnv(catalog),
    )
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /1-500/)

    const revoked = await runCli(
      ['revoke', 'weekly-report', '1.0.0', '--reason', '存在安全问题'],
      adminEnv(catalog),
    )
    assert.equal(revoked.status, 0, revoked.stderr)
    assert.match(revoked.stdout, /已撤销：weekly-report\/1\.0\.0/)

    const metadata = await catalog.request('/v1/agent-packages/weekly-report/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal((metadata.body as { status: string }).status, 'revoked')
    const bundle = await catalog.request('/v1/agent-packages/weekly-report/1.0.0/bundle', {
      token: READ_TOKEN,
    })
    assert.equal(bundle.status, 410)
    const revocations = await catalog.request('/v1/agent-packages/revocations', {
      token: READ_TOKEN,
    })
    const items = (revocations.body as { items: Array<{ slug: string; reason: string }> }).items
    assert.ok(items.some((item) => item.slug === 'weekly-report' && item.reason === '存在安全问题'))

    // Idempotent replay keeps the FIRST reason (server rule) — the CLI surfaces
    // the server answer instead of inventing one.
    const replay = await runCli(
      ['revoke', 'weekly-report', '1.0.0', '--reason', '第二个原因不应覆盖'],
      adminEnv(catalog),
    )
    assert.equal(replay.status, 0, replay.stderr)
    assert.match(replay.stdout, /存在安全问题/)
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// legacy migration
// ---------------------------------------------------------------------------

test('migrate-legacy builds a minimal pending package that is not downloadable yet', async () => {
  const catalog = await bootTestCatalog({
    entries: [
      {
        name: 'legacy-writer',
        kind: 'agent',
        displayName: '旧版写作助手',
        description: '旧目录里的写作助手',
        persona: '你是写作助手。',
        version: '0.3.0',
        permissions: [],
      },
    ],
  })
  try {
    const migrated = await runCli(['migrate-legacy', 'legacy-writer', '--submit'], adminEnv(catalog))
    assert.equal(migrated.status, 0, migrated.stderr)
    assert.match(migrated.stdout, /已提交审查/)
    const match = /submissionId：([0-9a-f-]{36})/u.exec(migrated.stdout)
    assert.ok(match, `missing submissionId in: ${migrated.stdout}`)
    const submissionId = match[1] as string

    const detail = await catalog.request(`/v1/agent-packages/submissions/${submissionId}`, {
      token: ADMIN_TOKEN,
    })
    const submission = detail.body as SubmissionBody
    assert.equal(submission.status, 'pending-review')
    assert.equal(submission.slug, 'legacy-writer')
    assert.equal(submission.version, '1.0.0')
    assert.deepEqual(
      submission.digest.files.map((file) => file.path),
      ['agent.json', 'persona.md'],
    )

    // Nothing is published before a human review + signature.
    const metadata = await catalog.request('/v1/agent-packages/legacy-writer/1.0.0', {
      token: READ_TOKEN,
    })
    assert.equal(metadata.status, 404)
    const bundle = await catalog.request('/v1/agent-packages/legacy-writer/1.0.0/bundle', {
      token: READ_TOKEN,
    })
    assert.equal(bundle.status, 404)

    const pendingBundle = await catalog.request(
      `/v1/agent-packages/submissions/${submissionId}/bundle`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(pendingBundle.status, 200)
    const inspected = await inspectUnsignedAgentPackageBundle(pendingBundle.buffer)
    assert.equal(inspected.manifest.displayName, '旧版写作助手')
    assert.equal(inspected.manifest.description, '旧目录里的写作助手')
    assert.equal(inspected.manifest.version, '1.0.0')
    assert.equal(inspected.manifest.persona, 'persona.md')
    assert.equal(inspected.manifest.skill, null)
    assert.equal(inspected.manifest.tools.mode, 'none')
    assert.deepEqual(inspected.manifest.allowSkills, [])
    assert.match(inspected.manifest.draftId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u)
    assert.ok(!Number.isNaN(Date.parse(inspected.manifest.createdAt)))
    assert.equal(inspected.manifest.createdAt, inspected.manifest.updatedAt)
    const persona = inspected.files.find((file) => file.path === 'persona.md')
    assert.equal(persona?.data.toString('utf8'), '你是写作助手。')

    const audit = await catalog.readAudit()
    assert.ok(
      audit.some(
        (record) =>
          record.action === 'agentPackages.submissions.create'
          && record.outcome === 'ok'
          && record.slug === 'legacy-writer',
      ),
    )
  } finally {
    await catalog.close()
  }
})

test('migrate-legacy reads JSON and raw personaUrl payloads over LAN and refuses public URLs', async () => {
  const personaServer = await startStubServer((request) => {
    if (request.path === '/persona.json') {
      return { body: JSON.stringify({ persona: 'JSON 人设' }) }
    }
    if (request.path === '/persona.md') {
      return { body: 'RAW 人设', contentType: 'text/plain; charset=utf-8' }
    }
    return undefined
  })
  const catalog = await bootTestCatalog({
    entries: [
      {
        name: 'legacy-json',
        kind: 'agent',
        description: 'JSON 人设来源',
        personaUrl: `${personaServer.baseUrl}/persona.json`,
      },
      {
        name: 'legacy-raw',
        kind: 'agent',
        description: '纯文本人设来源',
        personaUrl: `${personaServer.baseUrl}/persona.md`,
      },
      {
        name: 'legacy-public',
        kind: 'agent',
        description: '公网人设来源',
        personaUrl: 'http://93.184.216.34/persona.md',
      },
    ],
  })
  try {
    const json = await runCli(['migrate-legacy', 'legacy-json', '--submit'], adminEnv(catalog))
    assert.equal(json.status, 0, json.stderr)
    const raw = await runCli(['migrate-legacy', 'legacy-raw', '--submit'], adminEnv(catalog))
    assert.equal(raw.status, 0, raw.stderr)

    const pending = await catalog.request('/v1/agent-packages/submissions?status=pending', {
      token: ADMIN_TOKEN,
    })
    const items = (pending.body as { items: SubmissionBody[] }).items
    assert.equal(items.length, 2)
    const bySlug = new Map(items.map((item) => [item.slug, item]))
    for (const [slug, expected] of [
      ['legacy-json', 'JSON 人设'],
      ['legacy-raw', 'RAW 人设'],
    ] as const) {
      const item = bySlug.get(slug)
      assert.ok(item, `missing pending submission for ${slug}`)
      const bundle = await catalog.request(
        `/v1/agent-packages/submissions/${item.submissionId}/bundle`,
        { token: ADMIN_TOKEN },
      )
      const inspected = await inspectUnsignedAgentPackageBundle(bundle.buffer)
      assert.equal(
        inspected.files.find((file) => file.path === 'persona.md')?.data.toString('utf8'),
        expected,
      )
    }

    // The read token is the ONLY credential sent to the persona host.
    assert.ok(personaServer.requests.length >= 2)
    for (const request of personaServer.requests) {
      assert.equal(request.authorization, `Bearer ${READ_TOKEN}`)
    }

    const refused = await runCli(['migrate-legacy', 'legacy-public', '--submit'], adminEnv(catalog))
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /局域网/)
    const after = await catalog.request('/v1/agent-packages/submissions?status=pending', {
      token: ADMIN_TOKEN,
    })
    assert.equal((after.body as { items: SubmissionBody[] }).items.length, 2)
  } finally {
    await catalog.close()
    await personaServer.close()
  }
})

test('migrate-legacy rejects tool entries, empty personas and over-long legacy fields', async () => {
  const catalog = await bootTestCatalog({
    entries: [
      {
        name: 'legacy-tool',
        kind: 'tool',
        description: '旧工具条目',
        entrypoint: { kind: 'http', url: 'http://10.0.0.1/invoke' },
      },
      {
        name: 'legacy-long',
        kind: 'agent',
        description: '长'.repeat(201),
        persona: '人设',
      },
      {
        name: 'legacy-empty',
        kind: 'agent',
        description: '没有内联人设也没有 personaUrl',
      },
    ],
  })
  try {
    const tool = await runCli(['migrate-legacy', 'legacy-tool', '--submit'], adminEnv(catalog))
    assert.notEqual(tool.status, 0)
    assert.match(tool.stderr, /工具条目/)

    const long = await runCli(['migrate-legacy', 'legacy-long', '--submit'], adminEnv(catalog))
    assert.notEqual(long.status, 0)
    assert.match(long.stderr, /description/)
    assert.match(long.stderr, /200/)

    const empty = await runCli(['migrate-legacy', 'legacy-empty', '--submit'], adminEnv(catalog))
    assert.notEqual(empty.status, 0)
    assert.match(empty.stderr, /persona/)

    const pending = await catalog.request('/v1/agent-packages/submissions?status=pending', {
      token: ADMIN_TOKEN,
    })
    assert.equal((pending.body as { items: SubmissionBody[] }).items.length, 0)
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// secret hygiene
// ---------------------------------------------------------------------------

test('no CLI stdout/stderr and no audit trail contains a token or private-key material', () => {
  const invocations = cliInvocations()
  assert.ok(invocations.length >= 10, 'expected the suite to have exercised the CLI')

  const texts: Array<{ label: string; text: string }> = []
  for (const [index, invocation] of invocations.entries()) {
    texts.push({ label: `invocation ${String(index)} stdout`, text: invocation.stdout })
    texts.push({ label: `invocation ${String(index)} stderr`, text: invocation.stderr })
  }
  for (const [index, trail] of collectedAuditTrails().entries()) {
    texts.push({ label: `audit trail ${String(index)}`, text: trail })
  }
  assert.ok(collectedPrivateKeys().length > 0)

  for (const token of [READ_TOKEN, PUBLISH_TOKEN, ADMIN_TOKEN]) {
    for (const { label, text } of texts) {
      assert.ok(!text.includes(token), `${label} leaked a catalog token`)
    }
  }
  for (const [index, pem] of collectedPrivateKeys().entries()) {
    for (const line of pem.split('\n')) {
      if (line.trim() === '' || line.startsWith('-----')) continue
      for (const { label, text } of texts) {
        assert.ok(!text.includes(line), `${label} leaked private key ${String(index)}`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// centralized redaction (Task 7 / I-8)
// ---------------------------------------------------------------------------

test('redacts catalog tokens and PEM blocks from review output and errors', async () => {
  const catalog = await bootTestCatalog()
  // An obvious throwaway token, used ONLY as the CLI credential value in this
  // test: redaction is driven by the configured env values, so the manifest and
  // the remote error below can carry the exact same string.
  const token = 'redaction-test-publish-token-0123456789abcdef'
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
  try {
    // A manifest is server-provided free text: `review` prints the whole
    // manifest, so a token in the description would reach stdout verbatim.
    const submitted = await submitTestPackage(catalog, { description: `周报 ${token}` })
    const dir = await reviewDir(catalog, 'redaction')
    const review = await runCli(
      ['review', submitted.submission.submissionId, '--out', dir],
      { ...adminEnv(catalog), AGENT_CATALOG_PUBLISH_TOKEN: token },
    )
    assert.equal(review.status, 0, review.stderr)
    assert.equal(review.stdout.includes(token), false)
    assert.equal(review.stderr.includes(token), false)
    assert.match(review.stdout, /\[REDACTED\]/)

    // The other leak path: a remote error body echoed into stderr, here
    // carrying both the token and a private-key block.
    const stub = await startStubServer(() => ({
      status: 500,
      body: JSON.stringify({ error: `拒绝失败：${token}`, code: pem }),
    }))
    try {
      const failing = await runCli(['reject', 'sub-1', '--reason', 'x'], {
        ...adminEnv(catalog),
        AGENT_CATALOG_URL: stub.baseUrl,
        AGENT_CATALOG_PUBLISH_TOKEN: token,
      })
      assert.equal(failing.status, 1)
      assert.equal(failing.stderr.includes(token), false)
      assert.equal(failing.stderr.includes('BEGIN PRIVATE KEY'), false)
      assert.match(failing.stderr, /\[REDACTED PRIVATE KEY\]/)
    } finally {
      await stub.close()
    }
  } finally {
    await catalog.close()
  }
})
