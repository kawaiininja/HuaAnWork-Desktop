/**
 * Task 4: the durable write-intent journal and its restart reconciliation (I-5).
 *
 * Every mutating request first appends an intent to `${dataDir}/audit-intents.jsonl`
 * (durable before the handler runs), then its result line closes that intent in
 * `audit.jsonl` under the same `requestId`. A crash between the state commit and
 * the result line therefore leaves an unclosed intent; `reconcile` turns it into
 * an honest result line at startup (ok when `state.lastMutation` matches, error
 * when the change never committed). The intent journal is a SEPARATE file so the
 * existing exact `audit.jsonl` line counts stay intact.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  AUDIT_FILE_NAME,
  AUDIT_INTENTS_FILE_NAME,
  AUDIT_INTENT_RECONCILE_WINDOW_MS,
  AuditLog,
} from '../src/audit.ts'
import { createAgentCatalogRuntime } from '../src/server.ts'
import { emptyCatalogState, type CatalogState } from '../src/types.ts'
import { ADMIN_TOKEN, PUBLISH_TOKEN, READ_TOKEN, bootTestAgentCatalog } from './helpers.ts'

const NOW = '2026-10-25T00:00:00.000Z'
const ACTION = 'agentPackages.submissions.create'

async function readLines(path: string): Promise<Array<Record<string, any>>> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, any>)
}

test('reconciles an intent that committed before the result record was written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const requestId = randomUUID()
  await audit.writeIntent({
    action: ACTION,
    actor: 'anonymous',
    requestId,
  })

  // The intent is durable on its own file; no result line exists yet.
  const intentsBefore = await readLines(join(dir, AUDIT_INTENTS_FILE_NAME))
  assert.equal(intentsBefore.length, 1)
  await assert.rejects(readFile(join(dir, AUDIT_FILE_NAME), 'utf8'), /ENOENT/u)

  const state: CatalogState = {
    ...emptyCatalogState(),
    lastMutation: { requestId, action: ACTION, at: NOW },
  }
  await audit.reconcile(state)

  const lines = await readLines(join(dir, AUDIT_FILE_NAME))
  const result = lines.find(line => line.requestId === requestId)
  assert.ok(result, 'reconcile must close the intent with a result line')
  assert.equal(result.outcome, 'ok')
  assert.equal(result.status, 200)
  assert.match(String(result.reason), /reconciled/u)

  // The intent journal is a separate durable file, cleared once its results
  // are durable in audit.jsonl.
  const intents = await readFile(join(dir, AUDIT_INTENTS_FILE_NAME), 'utf8')
  assert.equal(intents, '')
})

test('reconciles an intent that state.lastMutation does not name as an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const requestId = randomUUID()
  await audit.writeIntent({
    action: ACTION,
    actor: 'publisher-actor',
    requestId,
    slug: 'weekly-report',
    version: '1.0.0',
  })

  const state: CatalogState = {
    ...emptyCatalogState(),
    lastMutation: { requestId: randomUUID(), action: ACTION, at: NOW },
  }
  await audit.reconcile(state)

  const lines = await readLines(join(dir, AUDIT_FILE_NAME))
  const result = lines.find(line => line.requestId === requestId)
  assert.ok(result, 'reconcile must close an intent even when the change never committed')
  assert.equal(result.outcome, 'error')
  assert.equal(result.status, 500)
  assert.match(String(result.reason), /does not name this intent/u)
  // Single-slot `lastMutation` cannot distinguish "never committed" from "a
  // later mutation overwrote the slot", so the reason must not claim the former.
  assert.doesNotMatch(String(result.reason), /did not commit/u)
  // The intent's identity fields are preserved for forensic correlation.
  assert.equal(result.actor, 'publisher-actor')
  assert.equal(result.slug, 'weekly-report')
  assert.equal(result.version, '1.0.0')
})

test('reconciles the lost result of an earlier commit as an error when a later mutation owns the slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const first = randomUUID()
  const second = randomUUID()
  await audit.writeIntent({ action: ACTION, actor: 'publisher-a', requestId: first })
  await audit.writeIntent({ action: ACTION, actor: 'publisher-b', requestId: second })

  // Both mutations committed; only the FIRST one's result line was lost. The
  // single slot now names the second request, which is all reconcile can see.
  const state: CatalogState = {
    ...emptyCatalogState(),
    lastMutation: { requestId: second, action: ACTION, at: NOW },
  }
  await audit.reconcile(state)

  const lines = await readLines(join(dir, AUDIT_FILE_NAME))
  const lost = lines.find(line => line.requestId === first)
  assert.ok(lost, 'the unclosed intent must still be closed with a result line')
  assert.equal(lost.outcome, 'error')
  assert.equal(lost.status, 500)
  assert.equal(lost.actor, 'publisher-a')
  assert.match(String(lost.reason), /does not name this intent/u)
  assert.doesNotMatch(String(lost.reason), /did not commit/u)

  // The mutation that still owns the slot reconciles as committed.
  const latest = lines.find(line => line.requestId === second)
  assert.ok(latest, 'the slot owner must reconcile too')
  assert.equal(latest.outcome, 'ok')
  assert.equal(latest.status, 200)
  assert.equal(latest.actor, 'publisher-b')
})

test('does not reconcile an intent whose result record already exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const requestId = randomUUID()
  await audit.writeIntent({ action: ACTION, actor: 'anonymous', requestId })
  await audit.writeAudit({
    action: ACTION,
    outcome: 'error',
    status: 409,
    actor: 'anonymous',
    requestId,
  })

  await audit.reconcile(emptyCatalogState())

  const lines = await readLines(join(dir, AUDIT_FILE_NAME))
  const results = lines.filter(line => line.requestId === requestId)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.status, 409)
  assert.equal(results[0]?.outcome, 'error')
})

test('threads one request id through the intent and the result line, and skips intents for reads', async () => {
  const catalog = await bootTestAgentCatalog({ entriesMode: 'empty' })
  try {
    // A POST reaches the handler but changes nothing (unknown package): the
    // intent and the result must still share the server-generated request id.
    const response = await catalog.request('/v1/agent-packages/demo/1.0.0/revoke', {
      method: 'POST',
      token: ADMIN_TOKEN,
      body: { reason: 'x' },
    })
    assert.equal(response.status, 404)

    // A read is audited but must never grow the intent journal.
    assert.equal((await catalog.request('/v1/agent-packages', { token: READ_TOKEN })).status, 200)

    const intents = await readLines(join(catalog.dataDir, AUDIT_INTENTS_FILE_NAME))
    assert.equal(intents.length, 1)
    const intent = intents[0]
    assert.ok(intent)
    assert.equal(intent.action, 'agentPackages.revoke')
    assert.equal(typeof intent.requestId, 'string')

    const results = await readLines(join(catalog.dataDir, AUDIT_FILE_NAME))
    const result = results.find(line => line.requestId === intent.requestId)
    assert.ok(result, 'the result line must carry the intent request id')
    assert.equal(result.action, 'agentPackages.revoke')
    assert.equal(result.status, 404)
  } finally {
    await catalog.close()
  }
})

test('refuses a write with 500 audit-write-failed when the intent journal cannot be written', async () => {
  const catalog = await bootTestAgentCatalog({ entriesMode: 'empty' })
  try {
    // A directory where the journal file must be makes every intent append fail.
    await mkdir(join(catalog.dataDir, AUDIT_INTENTS_FILE_NAME))

    const response = await catalog.request('/v1/agent-packages/submissions', {
      method: 'POST',
      token: PUBLISH_TOKEN,
      body: Buffer.alloc(1),
      headers: { 'content-type': 'application/gzip' },
    })
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, { error: '审计写入失败', code: 'audit-write-failed' })

    // The handler never ran: no submission was recorded and no result was faked.
    assert.deepEqual(catalog.runtime.store.read().submissions, {})
    assert.equal(await catalog.readAuditRaw(), '')
  } finally {
    await catalog.close()
  }
})

test('bounds reconciliation to the crash window and clears the journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const now = Date.now()
  const oldId = randomUUID()
  const recentId = randomUUID()
  const malformedId = randomUUID()
  const day = 24 * 60 * 60 * 1000
  assert.equal(AUDIT_INTENT_RECONCILE_WINDOW_MS, day)
  await writeFile(
    join(dir, AUDIT_INTENTS_FILE_NAME),
    [
      JSON.stringify({ timestamp: new Date(now - 30 * day).toISOString(), action: ACTION, actor: 'old', requestId: oldId }),
      JSON.stringify({ timestamp: new Date(now - 60_000).toISOString(), action: ACTION, actor: 'recent', requestId: recentId }),
      JSON.stringify({ timestamp: 'not-a-timestamp', action: ACTION, actor: 'malformed', requestId: malformedId }),
    ].join('\n') + '\n',
    'utf8',
  )

  await audit.reconcile(emptyCatalogState())

  const lines = await readLines(join(dir, AUDIT_FILE_NAME))
  // Only the intent inside the crash window is closed; old and malformed lines
  // are never turned into synthetic results.
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.requestId, recentId)
  assert.equal(lines[0]?.actor, 'recent')
  assert.equal(lines[0]?.outcome, 'error')
  assert.equal(lines[0]?.status, 500)
  assert.equal(lines.some(line => line.requestId === oldId || line.requestId === malformedId), false)

  // The journal is crash recovery only; a completed pass clears it.
  assert.equal(await readFile(join(dir, AUDIT_INTENTS_FILE_NAME), 'utf8'), '')
})

test('a rotated audit log with only historical intents produces no synthetic error lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const existing = `${JSON.stringify({
    timestamp: NOW,
    action: 'catalog.list',
    outcome: 'ok',
    status: 200,
    actor: 'anonymous',
    requestId: randomUUID(),
  })}\n`
  await writeFile(join(dir, AUDIT_FILE_NAME), existing, 'utf8')
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  await writeFile(
    join(dir, AUDIT_INTENTS_FILE_NAME),
    [0, 1, 2]
      .map(index =>
        JSON.stringify({
          timestamp: new Date(now - (30 + index) * day).toISOString(),
          action: ACTION,
          actor: 'historical',
          requestId: randomUUID(),
        }),
      )
      .join('\n') + '\n',
    'utf8',
  )

  // The documented rotation moved audit.jsonl away; the old intents' results
  // live in the archive, so reconcile must not fabricate a single 500.
  await audit.reconcile(emptyCatalogState())

  assert.equal(await readFile(join(dir, AUDIT_FILE_NAME), 'utf8'), existing)
  const lines = await readLines(join(dir, AUDIT_FILE_NAME))
  assert.equal(lines.filter(line => line.outcome === 'error').length, 0)
  assert.equal(await readFile(join(dir, AUDIT_INTENTS_FILE_NAME), 'utf8'), '')
})

test('reconciles a committed mutation at restart and keeps the intent identity fields', async () => {
  const catalog = await bootTestAgentCatalog({ entriesMode: 'empty' })
  try {
    const requestId = randomUUID()
    const action = 'agentPackages.revoke'
    await catalog.runtime.audit.writeIntent({
      action,
      actor: 'administrator',
      requestId,
      slug: 'a',
      version: '1.0.0',
    })
    await catalog.runtime.store.mutate(requestId, action, draft => {
      draft.revocations['a/1.0.0'] = {
        slug: 'a',
        version: '1.0.0',
        reason: 'unsafe',
        revokedAt: NOW,
        actor: 'administrator',
      }
    })

    // Simulate the crash between the state commit and the result record: a
    // fresh runtime must reconcile the orphaned intent at startup.
    const reopened = await createAgentCatalogRuntime(catalog.config)
    assert.equal(reopened.store.read().lastMutation?.requestId, requestId)

    const result = (await catalog.readAudit()).find(record => record.requestId === requestId)
    assert.ok(result, 'startup must reconcile the orphaned intent')
    assert.equal(result.outcome, 'ok')
    assert.equal(result.status, 200)
    assert.match(String(result.reason), /reconciled after restart/u)
    assert.equal(result.slug, 'a')
    assert.equal(result.version, '1.0.0')
    assert.equal(result.actor, 'administrator')
  } finally {
    await catalog.close()
  }
})
