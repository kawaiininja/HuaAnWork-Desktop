/**
 * Task 4: revisioned skill storage.
 *
 * One skill series per name; revisions are monotonically increasing integers.
 * The store owns the archive path (client paths never reach the disk layout),
 * archives land before the state that references them, and every name has its
 * own write queue so concurrent publishes cannot interleave check-then-act.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { buildSkillArchive } from '@huaanwork/skill-format'
import { SkillStore, SkillStoreCorruptError, SkillStoreError } from '../src/skill-store.ts'

const validFiles = [
  { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: 演示\n---\n\n正文\n', 'utf8') },
  { path: 'scripts/run.mjs', data: Buffer.from('console.log("demo")\n', 'utf8') },
]
const validArchive = await buildSkillArchive(validFiles)

const digestA = `sha256:${'a'.repeat(64)}`
const digestB = `sha256:${'b'.repeat(64)}`

let roots: string[] = []

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

function publishInput(overrides: Partial<Parameters<SkillStore['publish']>[0]> = {}): Parameters<SkillStore['publish']>[0] {
  return {
    name: 'demo',
    publisher: 'alice',
    digest: digestA,
    description: '演示',
    archive: validArchive,
    expectedRevision: undefined,
    requestId: 'r1',
    createdAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  }
}

test('only the owner advances a skill revision', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  const first = await store.publish(publishInput())
  assert.equal(first.created, true)
  await assert.rejects(
    store.publish(publishInput({
      publisher: 'bob',
      digest: digestB,
      description: '覆盖',
      expectedRevision: 1,
      requestId: 'r2',
      createdAt: '2026-11-14T00:01:00.000Z',
    })),
    (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'skill-name-conflict',
  )
})

test('same-digest replay is idempotent before any revision conflict', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  const first = await store.publish(publishInput())
  const replay = await store.publish(publishInput({
    expectedRevision: 999,
    requestId: 'r2',
    createdAt: '2026-11-14T00:01:00.000Z',
  }))
  assert.equal(first.created, true)
  assert.equal(replay.created, false)
  assert.equal(replay.skill.revision, 1)
  assert.equal(replay.skill.digest, digestA)
})

test('same owner advances revisions and conflicts on a stale expectation', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  await store.publish(publishInput())
  const second = await store.publish(publishInput({
    digest: digestB,
    description: '第二版',
    expectedRevision: 1,
    requestId: 'r2',
    createdAt: '2026-11-14T00:01:00.000Z',
  }))
  assert.equal(second.created, true)
  assert.equal(second.skill.revision, 2)
  assert.equal(second.skill.description, '第二版')

  await assert.rejects(
    store.publish(publishInput({
      digest: `sha256:${'c'.repeat(64)}`,
      description: '过期',
      expectedRevision: 1,
      requestId: 'r3',
      createdAt: '2026-11-14T00:02:00.000Z',
    })),
    (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'skill-revision-conflict',
  )
})

test('new names must not carry an expectation; updates must', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  await assert.rejects(
    store.publish(publishInput({ expectedRevision: 1 })),
    (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'skill-revision-conflict',
  )
  await store.publish(publishInput())
  // 同名更新不带 expectedRevision:不能静默覆盖,按乐观并发冲突处理。
  await assert.rejects(
    store.publish(publishInput({
      digest: digestB,
      expectedRevision: undefined,
      requestId: 'r2',
      createdAt: '2026-11-14T00:01:00.000Z',
    })),
    (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'skill-revision-conflict',
  )
})

test('concurrent publishes of one name serialize on the name queue', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  const results = await Promise.allSettled([
    store.publish(publishInput({ requestId: 'r1' })),
    store.publish(publishInput({
      digest: digestB,
      requestId: 'r2',
      createdAt: '2026-11-14T00:01:00.000Z',
    })),
  ])
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<SkillStore['publish']>>> => result.status === 'fulfilled')
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(fulfilled[0]?.value.skill.revision, 1)
  assert.equal((rejected[0]?.reason as SkillStoreError).code, 'skill-revision-conflict')
})

test('writes the archive before the state that references it', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  const published = await store.publish(publishInput())
  assert.equal(published.skill.size, validArchive.byteLength)
  // The API projection never exposes the internal archive path.
  assert.equal('archivePath' in published.skill, false)

  const archivePath = join(dataDir, 'skills', 'archives', 'demo', '1.tar.gz')
  assert.deepEqual(await readFile(archivePath), validArchive)
  const state = JSON.parse(await readFile(join(dataDir, 'skills', 'state.json'), 'utf8')) as {
    skills: Record<string, { revisions: Record<string, { archivePath: string }> }>
  }
  assert.equal(state.skills.demo?.revisions['1']?.archivePath, archivePath)

  // A rejected publish leaves no archive behind for the revision it never made.
  await assert.rejects(
    store.publish(publishInput({
      publisher: 'bob',
      digest: digestB,
      requestId: 'r2',
      createdAt: '2026-11-14T00:01:00.000Z',
    })),
  )
  await assert.rejects(readFile(join(dataDir, 'skills', 'archives', 'demo', '2.tar.gz')))
})

test('serves exact revisions and deep-copies the committed state', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  await store.publish(publishInput())
  await store.publish(publishInput({
    digest: digestB,
    description: '第二版',
    expectedRevision: 1,
    requestId: 'r2',
    createdAt: '2026-11-14T00:01:00.000Z',
  }))
  assert.equal(store.get('demo', 1)?.description, '演示')
  assert.equal(store.get('demo', 2)?.description, '第二版')
  assert.equal(store.get('demo', 3), undefined)
  assert.equal(store.get('missing', 1), undefined)

  const snapshot = store.read()
  delete snapshot.skills.demo
  assert.equal(store.get('demo', 2)?.revision, 2)
})

test('paginates by name with a stable cursor and rejects broken cursors', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  for (const name of ['zeta', 'alpha', 'mike']) {
    await store.publish(publishInput({ name, requestId: `r-${name}` }))
  }
  const first = store.listAfter(undefined, 2)
  assert.deepEqual(first.items.map(item => item.name), ['alpha', 'mike'])
  assert.equal(typeof first.nextCursor, 'string')
  const second = store.listAfter(first.nextCursor, 2)
  assert.deepEqual(second.items.map(item => item.name), ['zeta'])
  assert.equal(second.nextCursor, undefined)

  for (const cursor of ['not-base64url-%%', Buffer.from('{').toString('base64url'), Buffer.from('{"name":1}').toString('base64url')]) {
    assert.throws(
      () => store.listAfter(cursor, 2),
      (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'invalid-cursor',
      `cursor ${cursor} must be rejected`,
    )
  }
})

test('rejects non-kebab names before deriving any path', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  for (const name of ['../escape', 'Bad Name', 'a--b']) {
    await assert.rejects(
      store.publish(publishInput({ name })),
      (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'invalid-skill',
      `${name} must be rejected`,
    )
  }
})

test('rejects an empty description instead of writing an unloadable state', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  await assert.rejects(
    store.publish(publishInput({ description: '' })),
    (cause: unknown) => cause instanceof SkillStoreError && cause.code === 'invalid-skill',
  )
  assert.equal(store.get('demo', 1), undefined)
  // The same document must stay loadable: no archive, no revision.
  assert.deepEqual((await SkillStore.open(dataDir)).read().skills, {})
})

test('sweeps interrupted archive temp files on open', async () => {
  const dataDir = await makeHome()
  const archiveDir = join(dataDir, 'skills', 'archives', 'demo')
  await mkdir(archiveDir, { recursive: true })
  const leftover = join(archiveDir, '1.tar.gz.tmp-123-abcd')
  await writeFile(leftover, 'partial', 'utf8')
  await SkillStore.open(dataDir)
  await assert.rejects(readFile(leftover))
})

test('refuses to open a corrupt state document', async () => {
  const dataDir = await makeHome()
  await mkdir(join(dataDir, 'skills'), { recursive: true })
  await writeFile(join(dataDir, 'skills', 'state.json'), '{ not json', 'utf8')
  await assert.rejects(SkillStore.open(dataDir), (cause: unknown) => cause instanceof SkillStoreCorruptError)

  const wrongSchemaDir = await makeHome()
  await mkdir(join(wrongSchemaDir, 'skills'), { recursive: true })
  await writeFile(join(wrongSchemaDir, 'skills', 'state.json'), JSON.stringify({ schemaVersion: 2, skills: {} }), 'utf8')
  await assert.rejects(SkillStore.open(wrongSchemaDir), (cause: unknown) => cause instanceof SkillStoreCorruptError)
})

test('reopens committed state after a restart', async () => {
  const dataDir = await makeHome()
  const store = await SkillStore.open(dataDir)
  await store.publish(publishInput())
  const reopened = await SkillStore.open(dataDir)
  assert.equal(reopened.get('demo', 1)?.digest, digestA)
  const replay = await reopened.publish(publishInput({ requestId: 'r2' }))
  assert.equal(replay.created, false)
  assert.equal(replay.skill.revision, 1)
})
