/**
 * Task 5: skill catalog HTTP surface.
 *
 * Upload is publish; reads are list/metadata/exact-revision archive. Skill
 * requests authenticate with their own uploader tokens and write to their own
 * audit journal (`<dataDir>/skills/audit.jsonl`).
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

import { MAX_SKILL_ARCHIVE_BYTES, buildSkillArchive } from '@huaanwork/skill-format'

import { loadAgentCatalogConfig } from '../src/config.ts'
import { createAgentCatalogRuntime } from '../src/server.ts'
import { SkillStoreCorruptError } from '../src/skill-store.ts'
import {
  ALICE_SKILL_TOKEN,
  BOB_SKILL_TOKEN,
  PUBLISH_TOKEN,
  READ_TOKEN,
  actorOf,
  bootTestAgentCatalog,
  createConfigEnvironment,
  type TestAgentCatalog,
} from './helpers.ts'

const validFiles = [
  { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: 演示\n---\n\n正文\n', 'utf8') },
  { path: 'scripts/run.mjs', data: Buffer.from('console.log("demo")\n', 'utf8') },
]
const validArchive = await buildSkillArchive(validFiles)
const updatedFiles = [
  { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: 演示二版\n---\n\n正文二版\n', 'utf8') },
]
const updatedArchive = await buildSkillArchive(updatedFiles)

interface PublishOptions {
  readonly token?: string
  readonly archive?: Buffer
  readonly expected?: number
  readonly headers?: Record<string, string>
}

function publish(catalog: TestAgentCatalog, name: string, options: PublishOptions = {}) {
  return catalog.request(`/v1/skills/${name}`, {
    method: 'POST',
    token: options.token ?? ALICE_SKILL_TOKEN,
    raw: options.archive ?? validArchive,
    headers: {
      'content-type': 'application/gzip',
      ...(options.expected === undefined ? {} : { 'x-skill-expected-revision': String(options.expected) }),
      ...options.headers,
    },
  })
}

test('publishes immediately and serves the exact revision archive', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog, 'demo')
    assert.equal(published.status, 201)
    assert.equal(published.body.skill.revision, 1)
    assert.equal(published.body.created, true)
    assert.equal('archivePath' in published.body.skill, false)

    const listed = await catalog.request<{ items: Array<{ name: string; revision: number }> }>('/v1/skills', {
      token: READ_TOKEN,
    })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.items.map(item => item.name), ['demo'])

    const meta = await catalog.request<{ skill: { name: string; digest: string } }>('/v1/skills/demo/1', {
      token: READ_TOKEN,
    })
    assert.equal(meta.status, 200)
    assert.equal(meta.body.skill.name, 'demo')

    const downloaded = await catalog.request('/v1/skills/demo/1/archive', { token: READ_TOKEN })
    assert.equal(downloaded.status, 200)
    assert.equal(downloaded.headers['content-type'], 'application/gzip')
    assert.deepEqual(downloaded.buffer, validArchive)
  } finally {
    await catalog.close()
  }
})

test('separates skill upload tokens from every agent role', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // The read token authenticates for reads only.
    assert.equal((await publish(catalog, 'demo', { token: READ_TOKEN })).status, 403)
    // The agent publish token cannot publish skills.
    assert.equal((await publish(catalog, 'demo', { token: PUBLISH_TOKEN })).status, 403)
    // A skill upload token cannot reach agent-package approval.
    const approve = await catalog.request('/v1/agent-packages/submissions/any-id/approve', {
      method: 'POST',
      token: ALICE_SKILL_TOKEN,
    })
    assert.equal(approve.status, 403)
    // And cannot browse: GET /v1/skills is read-only.
    assert.equal((await catalog.request('/v1/skills', { token: ALICE_SKILL_TOKEN })).status, 403)
  } finally {
    await catalog.close()
  }
})

test('an identical first publish is idempotent without an expected revision', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const first = await publish(catalog, 'demo')
    const replay = await publish(catalog, 'demo')
    assert.equal(first.status, 201)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.created, false)
    assert.equal(replay.body.skill.revision, 1)
    const listed = await catalog.request<{ items: unknown[] }>('/v1/skills', { token: READ_TOKEN })
    assert.equal(listed.body.items.length, 1)
  } finally {
    await catalog.close()
  }
})

test('maps owner, existence and revision conflicts to 409 codes', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    await publish(catalog, 'demo')

    const alreadyExists = await publish(catalog, 'demo', { archive: updatedArchive })
    assert.equal(alreadyExists.status, 409)
    assert.equal(alreadyExists.body.code, 'skill-already-exists')

    const nonOwner = await publish(catalog, 'demo', {
      token: BOB_SKILL_TOKEN,
      archive: updatedArchive,
      expected: 1,
    })
    assert.equal(nonOwner.status, 409)
    assert.equal(nonOwner.body.code, 'skill-name-conflict')

    const second = await publish(catalog, 'demo', { archive: updatedArchive, expected: 1 })
    assert.equal(second.status, 201)
    assert.equal(second.body.skill.revision, 2)

    const stale = await publish(catalog, 'demo', { archive: validArchive, expected: 1 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'skill-revision-conflict')
  } finally {
    await catalog.close()
  }
})

test('rejects malformed archives, name mismatches and bad expectation headers', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const notGzip = await publish(catalog, 'demo', { archive: Buffer.from('not gzip') })
    assert.equal(notGzip.status, 400)
    assert.equal(notGzip.body.code, 'invalid-skill')

    const mismatched = await publish(catalog, 'other')
    assert.equal(mismatched.status, 400)
    assert.equal(mismatched.body.code, 'invalid-skill')

    const wrongType = await catalog.request('/v1/skills/demo', {
      method: 'POST',
      token: ALICE_SKILL_TOKEN,
      raw: validArchive,
      headers: { 'content-type': 'application/octet-stream' },
    })
    assert.equal(wrongType.status, 400)
    assert.equal(wrongType.body.code, 'invalid-skill')

    for (const header of ['0', 'abc', '-1']) {
      const bad = await publish(catalog, 'demo', { headers: { 'x-skill-expected-revision': header } })
      assert.equal(bad.status, 400)
      assert.equal(bad.body.code, 'invalid-skill')
    }
  } finally {
    await catalog.close()
  }
})

test('enforces the archive cap without buffering the excess', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const oversized = await publish(catalog, 'demo', {
      archive: Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES + 16, 1),
    })
    assert.equal(oversized.status, 400)
    assert.equal(oversized.body.code, 'skill-too-large')
  } finally {
    await catalog.close()
  }
})

test('paginates the catalog with cursors and validates the page size', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    for (const name of ['zeta', 'alpha', 'mike']) {
      const files = [
        { path: 'SKILL.md', data: Buffer.from(`---\nname: ${name}\ndescription: ${name}\n---\n\n正文\n`, 'utf8') },
      ]
      const archive = await buildSkillArchive(files)
      assert.equal((await publish(catalog, name, { archive })).status, 201)
    }
    const first = await catalog.request<{ items: Array<{ name: string }>; nextCursor?: string }>('/v1/skills?limit=2', {
      token: READ_TOKEN,
    })
    assert.deepEqual(first.body.items.map(item => item.name), ['alpha', 'mike'])
    assert.equal(typeof first.body.nextCursor, 'string')
    const second = await catalog.request<{ items: Array<{ name: string }>; nextCursor?: string }>(
      `/v1/skills?limit=2&cursor=${first.body.nextCursor ?? ''}`,
      { token: READ_TOKEN },
    )
    assert.deepEqual(second.body.items.map(item => item.name), ['zeta'])
    assert.equal(second.body.nextCursor, undefined)

    for (const limit of ['0', '101', 'abc']) {
      const invalid = await catalog.request(`/v1/skills?limit=${limit}`, { token: READ_TOKEN })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.body.code, 'invalid-limit')
    }
    const badCursor = await catalog.request('/v1/skills?cursor=not-a-cursor', { token: READ_TOKEN })
    assert.equal(badCursor.status, 400)
    assert.equal(badCursor.body.code, 'invalid-cursor')
  } finally {
    await catalog.close()
  }
})

test('answers 404 for missing skills and malformed revisions', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    await publish(catalog, 'demo')
    for (const path of [
      '/v1/skills/missing/1',
      '/v1/skills/missing/1/archive',
      '/v1/skills/demo/0',
      '/v1/skills/demo/abc',
      '/v1/skills/demo/9/archive',
    ]) {
      const response = await catalog.request(path, { token: READ_TOKEN })
      assert.equal(response.status, 404, path)
      assert.equal(response.body.code, 'skill-not-found', path)
    }
  } finally {
    await catalog.close()
  }
})

test('writes skill requests to the skill audit journal only', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const published = await publish(catalog, 'demo')
    assert.equal(published.status, 201)
    await catalog.request('/v1/skills', { token: READ_TOKEN })

    const skillAudit = await catalog.readSkillAudit()
    const publishLine = skillAudit.find(record => record.action === 'skills.publish' && record.status === 201)
    assert.ok(publishLine)
    assert.equal(publishLine.slug, 'demo')
    assert.equal(publishLine.version, '1')
    assert.equal(publishLine.actor, actorOf(ALICE_SKILL_TOKEN))
    const listLine = skillAudit.find(record => record.action === 'skills.list' && record.status === 200)
    assert.ok(listLine)

    const agentAudit = await catalog.readAudit()
    assert.equal(agentAudit.some(record => record.action === 'skills.publish'), false)

    // The skill journal never echoes an upload token.
    const rawSkillAudit = await readFile(catalog.skillAuditPath, 'utf8')
    assert.equal(rawSkillAudit.includes(ALICE_SKILL_TOKEN), false)
    assert.equal(rawSkillAudit.includes(BOB_SKILL_TOKEN), false)
  } finally {
    await catalog.close()
  }
})

test('routes pre-dispatch denials and method errors to the skill journal', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    assert.equal((await publish(catalog, 'demo', { token: READ_TOKEN })).status, 403)
    const wrongMethod = await catalog.request('/v1/skills/demo', { token: ALICE_SKILL_TOKEN })
    assert.equal(wrongMethod.status, 405)

    const skillAudit = await catalog.readSkillAudit()
    assert.ok(skillAudit.some(record => record.action === 'skills.publish' && record.outcome === 'denied'))
    assert.ok(skillAudit.some(record => record.action === 'route.method-not-allowed'))
    const agentAudit = await catalog.readAudit()
    assert.equal(agentAudit.some(record => record.action === 'skills.publish'), false)
    assert.equal(agentAudit.some(record => record.action === 'route.method-not-allowed'), false)
  } finally {
    await catalog.close()
  }
})

test('records 401 denials on the matched skill journal and unknown routes on the agent journal', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // Missing token and an unknown token on a MATCHED skill route: 401 on the
    // skill journal.
    assert.equal((await catalog.request('/v1/skills/demo', {
      method: 'POST', raw: validArchive, headers: { 'content-type': 'application/gzip' },
    })).status, 401)
    assert.equal((await publish(catalog, 'demo', { token: 'wrong-token' })).status, 401)
    const skillAudit = await catalog.readSkillAudit()
    assert.equal(skillAudit.filter(record => record.action === 'auth.denied').length, 2)

    // An unknown route (even one carrying an upload token in the path) stays on
    // the agent journal, and the token is redacted there.
    const unknown = await catalog.request(`/v1/nope/${ALICE_SKILL_TOKEN}`, { token: READ_TOKEN })
    assert.equal(unknown.status, 404)
    const agentRaw = await catalog.readAuditRaw()
    assert.ok(agentRaw.includes('route.unknown'))
    assert.equal(agentRaw.includes(ALICE_SKILL_TOKEN), false)
    assert.ok(agentRaw.includes('[REDACTED]'))
  } finally {
    await catalog.close()
  }
})

test('writes the publish intent to the skill journal only', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    assert.equal((await publish(catalog, 'demo')).status, 201)
    const intents = (await readFile(join(catalog.dataDir, 'skills', 'audit-intents.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { action: string; slug?: string })
    const intent = intents.find(record => record.action === 'skills.publish')
    assert.ok(intent)
    assert.equal(intent.slug, 'demo')
    // The agent intent journal was never touched.
    await assert.rejects(readFile(join(catalog.dataDir, 'audit-intents.jsonl'), 'utf8'))
  } finally {
    await catalog.close()
  }
})

test('refuses a skill publish while the skill audit is unavailable', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // A directory at the intents path makes every intent append fail.
    await mkdir(join(catalog.dataDir, 'skills', 'audit-intents.jsonl'), { recursive: true })
    const response = await publish(catalog, 'demo')
    assert.equal(response.status, 500)
    assert.equal(response.body.code, 'audit-write-failed')
    assert.deepEqual(catalog.runtime.skillStore.read().skills, {})
  } finally {
    await catalog.close()
  }
})

test('routes handler failures to the skill journal', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    assert.equal((await publish(catalog, 'demo')).status, 201)
    await rm(join(catalog.dataDir, 'skills', 'archives', 'demo', '1.tar.gz'))
    assert.equal((await catalog.request('/v1/skills/demo/1/archive', { token: READ_TOKEN })).status, 500)
    const skillAudit = await catalog.readSkillAudit()
    assert.ok(skillAudit.some(record => record.action === 'skills.archive' && record.status === 500))
  } finally {
    await catalog.close()
  }
})

test('accepts exactly the archive cap and rejects one byte over', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // Exactly 5 MiB is buffered and reaches inspection (which rejects the
    // garbage bytes as an invalid archive, not as too large).
    const atCap = await publish(catalog, 'demo', { archive: Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES, 1) })
    assert.equal(atCap.status, 400)
    assert.equal(atCap.body.code, 'invalid-skill')
    const overCap = await publish(catalog, 'demo', { archive: Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES + 1, 1) })
    assert.equal(overCap.status, 400)
    assert.equal(overCap.body.code, 'skill-too-large')
  } finally {
    await catalog.close()
  }
})

test('reconciles each audit journal against its own store', async () => {
  const environment = await createConfigEnvironment()
  try {
    const { dataDir } = environment
    const now = new Date().toISOString()
    await mkdir(join(dataDir, 'skills'), { recursive: true })
    await writeFile(join(dataDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      submissions: {},
      packages: {},
      delistRequests: {},
      revocations: {},
      lastMutation: { requestId: 'agent-req', action: 'agentPackages.submissions.create', at: now },
    }), 'utf8')
    await writeFile(join(dataDir, 'audit-intents.jsonl'), `${JSON.stringify({
      action: 'agentPackages.submissions.create',
      actor: 'a1b2c3d4e5f6',
      requestId: 'agent-req',
      timestamp: now,
    })}\n${JSON.stringify({
      action: 'skills.publish',
      actor: 'a1b2c3d4e5f6',
      requestId: 'skill-req',
      timestamp: now,
    })}\n`, 'utf8')
    await writeFile(join(dataDir, 'skills', 'state.json'), JSON.stringify({
      schemaVersion: 1,
      skills: {},
      lastMutation: { requestId: 'skill-req', action: 'skills.publish', at: now },
    }), 'utf8')
    await writeFile(join(dataDir, 'skills', 'audit-intents.jsonl'), `${JSON.stringify({
      action: 'skills.publish',
      actor: 'a1b2c3d4e5f6',
      requestId: 'skill-req',
      timestamp: now,
    })}\n${JSON.stringify({
      action: 'agentPackages.submissions.create',
      actor: 'a1b2c3d4e5f6',
      requestId: 'agent-req',
      timestamp: now,
    })}\n`, 'utf8')

    const config = loadAgentCatalogConfig(environment.env)
    await createAgentCatalogRuntime(config)

    // Each journal is judged by ITS OWN store: the cross-seeded intent cannot
    // see the other store's lastMutation and is closed as an error.
    const agentResults = (await readFile(join(dataDir, 'audit.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { requestId: string; status: number })
    assert.deepEqual(agentResults.map(record => record.requestId), ['agent-req', 'skill-req'])
    assert.equal(agentResults[0]?.status, 200)
    assert.equal(agentResults[1]?.status, 500)

    const skillResults = (await readFile(join(dataDir, 'skills', 'audit.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { requestId: string; status: number })
    assert.deepEqual(skillResults.map(record => record.requestId), ['skill-req', 'agent-req'])
    assert.equal(skillResults[0]?.status, 200)
    assert.equal(skillResults[1]?.status, 500)
  } finally {
    await environment.cleanup()
  }
})

test('refuses startup when the skill state is corrupt', async () => {
  const environment = await createConfigEnvironment()
  try {
    await mkdir(join(environment.dataDir, 'skills'), { recursive: true })
    await writeFile(join(environment.dataDir, 'skills', 'state.json'), '{ not json', 'utf8')
    const config = loadAgentCatalogConfig(environment.env)
    await assert.rejects(
      createAgentCatalogRuntime(config),
      (cause: unknown) => cause instanceof SkillStoreCorruptError,
    )
  } finally {
    await environment.cleanup()
  }
})
