/**
 * Task 8: publish a local skill to the intranet center.
 *
 * Real loopback catalog server: the test asserts the actual token header,
 * content type, expectation header and archive bytes. The local snapshot is
 * rebuilt from disk on every upload; enable state is never touched.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

import { inspectSkillArchive } from '@huaanwork/skill-format'

import { setUserSkillToggle, readSkillLocalState, writeSkillLocalEntry } from '../../src/huaanwork-host/skill-local-state.ts'
import * as skillLocalState from '../../src/huaanwork-host/skill-local-state.ts'
import {
  SkillUploadError,
  uploadLocalSkill,
} from '../../src/huaanwork-host/skill-catalog-upload.ts'
import {
  configureSkillCatalog,
  resetSkillCatalogForTests,
  type SkillCatalogSettings,
} from '../../src/huaanwork-host/skill-catalog-client.ts'

const UPLOAD_TOKEN = 'skill-upload-token-012345678901234567890123456789'
const READ_TOKEN = 'skill-read-token-012345678901234567890123456789'

const homes: string[] = []
const servers: Server[] = []

afterEach(async () => {
  resetSkillCatalogForTests()
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skill-upload-'))
  homes.push(home)
  return home
}

function writeLocalSkill(profileDir: string, name: string, body = '正文'): void {
  const dir = join(profileDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`, 'utf8')
  writeFileSync(join(dir, 'run.mjs'), 'console.log("uploaded")\n', 'utf8')
}

interface PublishBehavior {
  created?: boolean
  revision?: number
  status?: number
  body?: unknown
  duringRequest?: () => void
}

interface CapturedRequest {
  token: string | undefined
  contentType: string | undefined
  expectedRevision: string | undefined
  archive: Buffer
}

async function bootCatalogServer(behavior: PublishBehavior = {}): Promise<{
  port: number
  requests: CapturedRequest[]
}> {
  const requests: CapturedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      behavior.duringRequest?.()
      const archive = Buffer.concat(chunks)
      requests.push({
        token: request.headers.authorization,
        contentType: request.headers['content-type'],
        expectedRevision: request.headers['x-skill-expected-revision'] as string | undefined,
        archive,
      })
      if (behavior.status !== undefined) {
        response.writeHead(behavior.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(behavior.body ?? { error: 'x', code: 'skill-name-conflict' }))
        return
      }
      if (request.headers.authorization !== `Bearer ${UPLOAD_TOKEN}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: '口令错误' }))
        return
      }
      void inspectSkillArchive(archive).then(inspected => {
        const revision = behavior.revision ?? 1
        response.writeHead(behavior.created === false ? 200 : 201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          skill: {
            name: inspected.name,
            revision,
            description: inspected.description,
            publisher: 'alice',
            digest: inspected.digest,
            size: archive.byteLength,
            updatedAt: '2026-11-14T00:00:00.000Z',
          },
          created: behavior.created ?? true,
        }))
      })
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { port: address.port, requests }
}

function bindClient(port: number, uploadToken = UPLOAD_TOKEN): void {
  const settings: SkillCatalogSettings = {
    agents_host: '127.0.0.1',
    agents_port: port,
    agents_catalog_token: READ_TOKEN,
    agents_skill_upload_token: uploadToken,
  }
  configureSkillCatalog({ readSettings: () => settings })
}

test('uploads a local snapshot without changing its enable state', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo')
  setUserSkillToggle(profile, 'demo', true)
  const server = await bootCatalogServer()
  bindClient(server.port)

  const result = await uploadLocalSkill(profile, 'demo')
  assert.equal(result.created, true)
  assert.equal(result.skill.publishedRevision, 1)
  assert.equal(result.skill.publishState, 'published')
  assert.equal(readSkillLocalState(profile).skills.demo?.origin.kind, 'created')
  // Enable state untouched.
  const { readUserSkillToggles } = await import('../../src/huaanwork-host/skill-local-state.ts')
  assert.equal(readUserSkillToggles(profile).demo, true)

  const request = server.requests[0]!
  assert.equal(request.token, `Bearer ${UPLOAD_TOKEN}`)
  assert.equal(request.contentType, 'application/gzip')
  assert.equal(request.expectedRevision, undefined)
  const inspected = await inspectSkillArchive(request.archive)
  assert.deepEqual(inspected.files.map(file => file.path).sort(), ['SKILL.md', 'run.mjs'])
})

test('sends the local publishedRevision as the expectation on updates', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo')
  const server = await bootCatalogServer()
  bindClient(server.port)
  await uploadLocalSkill(profile, 'demo')
  const second = await bootCatalogServer({ created: true, revision: 2 })
  bindClient(second.port)
  const updated = await uploadLocalSkill(profile, 'demo')
  assert.equal(updated.created, true)
  assert.equal(second.requests[0]?.expectedRevision, '1')
  assert.equal(updated.skill.publishedRevision, 2)
})

test('same-digest retry is idempotent', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo')
  const first = await bootCatalogServer()
  bindClient(first.port)
  await uploadLocalSkill(profile, 'demo')
  const retry = await bootCatalogServer({ created: false, revision: 1 })
  bindClient(retry.port)
  const result = await uploadLocalSkill(profile, 'demo')
  assert.equal(result.created, false)
  assert.equal(result.skill.publishedRevision, 1)
  assert.equal(result.skill.publishState, 'published')
})

test('maps server conflicts without touching the local publish state', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo')
  const first = await bootCatalogServer()
  bindClient(first.port)
  await uploadLocalSkill(profile, 'demo')
  const before = readSkillLocalState(profile).skills.demo
  assert.equal(before?.publishedRevision, 1)

  for (const [code, status] of [['skill-name-conflict', 409], ['skill-revision-conflict', 409]] as const) {
    const server = await bootCatalogServer({ status, body: { error: '冲突', code } })
    bindClient(server.port)
    await assert.rejects(
      uploadLocalSkill(profile, 'demo'),
      (cause: unknown) => cause instanceof SkillUploadError && cause.code === code,
    )
    const after = readSkillLocalState(profile).skills.demo
    assert.equal(after?.publishedRevision, before?.publishedRevision)
    assert.equal(after?.publishedDigest, before?.publishedDigest)
  }
})

test('never echoes the server error text into the surfaced message', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo')
  const server = await bootCatalogServer({
    status: 409,
    body: { error: 'SECRET-SERVER-TEXT', code: 'skill-name-conflict' },
  })
  bindClient(server.port)
  await assert.rejects(
    uploadLocalSkill(profile, 'demo'),
    (cause: unknown) => cause instanceof SkillUploadError
      && cause.code === 'skill-name-conflict'
      && cause.message.includes('其他发布者')
      && !cause.message.includes('SECRET-SERVER-TEXT'),
  )
})

test('rebuilds the snapshot from disk and reports an edit made during upload as modified', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo', '第一版')
  const first = await bootCatalogServer()
  bindClient(first.port)
  await uploadLocalSkill(profile, 'demo')
  // A realistic update round trip (revision 2) where the file changes mid-flight.
  const second = await bootCatalogServer({
    revision: 2,
    duringRequest: () => {
      writeFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n\n改过\n', 'utf8')
    },
  })
  setUserSkillToggle(profile, 'demo', true)
  bindClient(second.port)
  const result = await uploadLocalSkill(profile, 'demo')
  assert.equal(result.skill.publishedRevision, 2)
  assert.equal(result.skill.publishState, 'modified')
  assert.notEqual(result.skill.publishedDigest, result.skill.contentDigest)
  assert.match(readFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), 'utf8'), /改过/)
})

test('refreshes a stale stored digest from the disk before publishing', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo', '第一版')
  const first = await bootCatalogServer()
  bindClient(first.port)
  await uploadLocalSkill(profile, 'demo')
  // Out-of-band edit after the recorded digest.
  writeFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n\n外部改过\n', 'utf8')
  const second = await bootCatalogServer({ revision: 2 })
  bindClient(second.port)
  const result = await uploadLocalSkill(profile, 'demo')
  const inspected = await inspectSkillArchive(second.requests[0]!.archive)
  assert.match(inspected.skillMarkdown, /外部改过/)
  assert.equal(result.skill.publishState, 'published')
})

test('an empty upload token disables upload without any request', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo')
  const server = await bootCatalogServer()
  bindClient(server.port, '')
  await assert.rejects(
    uploadLocalSkill(profile, 'demo'),
    (cause: unknown) => cause instanceof SkillUploadError && cause.code === 'upload-token-missing',
  )
  assert.equal(server.requests.length, 0)
})

test('normalizes a flat markdown skill to one SKILL.md entry', async () => {
  const profile = makeHome()
  mkdirSync(join(profile, 'skills'), { recursive: true })
  writeFileSync(
    join(profile, 'skills', 'flat-one.md'),
    '---\nname: flat-one\ndescription: flat\n---\n\n扁平正文\n',
    'utf8',
  )
  const server = await bootCatalogServer()
  bindClient(server.port)
  const result = await uploadLocalSkill(profile, 'flat-one')
  assert.equal(result.created, true)
  const inspected = await inspectSkillArchive(server.requests[0]!.archive)
  assert.deepEqual(inspected.files.map(file => file.path), ['SKILL.md'])
  assert.match(inspected.skillMarkdown, /扁平正文/)
})

test('refuses a first publish that reuses a bundled skill name', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'pdf')
  const server = await bootCatalogServer()
  bindClient(server.port)
  await assert.rejects(
    uploadLocalSkill(profile, 'pdf'),
    (cause: unknown) => cause instanceof SkillUploadError && cause.code === 'skill-already-exists',
  )
  assert.equal(server.requests.length, 0)
})

test('the pre-publish merge re-reads the latest entry inside the lock (评审 Minor 3)', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'demo', '第一版')
  const first = await bootCatalogServer()
  bindClient(first.port)
  await uploadLocalSkill(profile, 'demo')
  // 带外编辑使记录摘要过期,触发发布前合并;并发写者把 publishedRevision 推进到 2。
  writeFileSync(join(profile, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n\n第二版\n', 'utf8')
  const recorded = readSkillLocalState(profile).skills.demo!
  writeSkillLocalEntry(profile, 'demo', { ...recorded, publishedRevision: 2 })
  // 锁外快照读到推进前的旧值 1;锁内重读必须看到磁盘上的 2。发布失败时合并结果留存。
  const real = skillLocalState.readSkillLocalState
  let snapshotTaken = false
  const spy = vi.spyOn(skillLocalState, 'readSkillLocalState').mockImplementation((dir: string) => {
    const doc = real(dir)
    if (!snapshotTaken) {
      snapshotTaken = true
      return { ...doc, skills: { ...doc.skills, demo: { ...doc.skills.demo!, publishedRevision: 1 } } }
    }
    return doc
  })
  const failing = await bootCatalogServer({ status: 500 })
  bindClient(failing.port)
  await assert.rejects(uploadLocalSkill(profile, 'demo'), SkillUploadError)
  spy.mockRestore()
  assert.equal(readSkillLocalState(profile).skills.demo!.publishedRevision, 2)
})
