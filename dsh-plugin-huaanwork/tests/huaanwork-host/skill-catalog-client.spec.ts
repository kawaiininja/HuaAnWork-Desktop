/**
 * Task 6: skill catalog HTTP client.
 *
 * Real loopback server, no fetch mocks: the client must follow pagination to
 * completion, refuse public hosts, manual-redirects, oversize bodies and
 * truncated listings, and use the shared catalog read token.
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, test } from 'vitest'

import { buildSkillArchive } from '@huaanwork/skill-format'

import {
  MAX_SKILL_CATALOG_PAGES,
  SkillCatalogClientError,
  createSkillCatalogClient,
  resetSkillCatalogForTests,
  type SkillCatalogSettings,
} from '../../src/huaanwork-host/skill-catalog-client.ts'
import { SKILL_CATALOG_UNAVAILABLE } from '../../src/huaanwork-host/skill-center.ts'

const READ_TOKEN = 'skill-read-token-012345678901234567890123456789'

const archiveFiles = [
  { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: 演示\n---\n\n正文\n', 'utf8') },
]
const archive = await buildSkillArchive(archiveFiles)

const servers: Server[] = []

afterEach(async () => {
  resetSkillCatalogForTests()
  while (servers.length > 0) {
    const server = servers.pop()!
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => void

async function bootServer(handler: Handler): Promise<{ host: string; port: number; requests: URL[]; auth: Array<string | undefined> }> {
  const requests: URL[] = []
  const auth: Array<string | undefined> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push(url)
    auth.push(request.headers.authorization)
    handler(request, response, url)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { host: '127.0.0.1', port: address.port, requests, auth }
}

const UPLOAD_TOKEN = 'skill-upload-token-012345678901234567890123456789'

function settingsFor(host: string, port: number | ''): SkillCatalogSettings {
  return {
    agents_host: host,
    agents_port: port,
    agents_catalog_token: READ_TOKEN,
    // Distinct non-empty upload token: reads must still use the READ token.
    agents_skill_upload_token: UPLOAD_TOKEN,
  }
}

function summary(name: string, revision: number) {
  return {
    name,
    revision,
    description: `${name} 描述`,
    publisher: 'alice',
    digest: `sha256:${'a'.repeat(64)}`,
    size: 10,
    updatedAt: '2026-11-14T00:00:00.000Z',
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(payload)
}

test('lists every page until no nextCursor is returned, with the read token', async () => {
  const server = await bootServer((_request, response, url) => {
    if (url.pathname !== '/v1/skills') return sendJson(response, 404, { error: 'nope' })
    const cursor = url.searchParams.get('cursor')
    if (cursor === null) {
      sendJson(response, 200, { items: [summary('alpha', 1), summary('beta', 2)], nextCursor: 'page-2' })
    } else {
      assert.equal(cursor, 'page-2')
      sendJson(response, 200, { items: [summary('gamma', 3)] })
    }
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  const items = await client.listSharedSkills()
  assert.deepEqual(items.map(item => item.name), ['alpha', 'beta', 'gamma'])
  assert.equal(server.requests.length, 2)
  assert.equal(server.auth[0], `Bearer ${READ_TOKEN}`)
  assert.equal(server.requests[0]?.searchParams.get('limit'), '100')
})

test('refuses a public host before any request is sent', async () => {
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor('8.8.8.8', 18080),
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'unreachable',
  )
})

test('refuses redirects instead of following them', async () => {
  const server = await bootServer((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' })
    response.end()
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'redirect',
  )
})

test('times out a hung request', async () => {
  const server = await bootServer((_request, response) => {
    // Never answer; the client timeout must fire.
    void response
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
    timeoutMs: 50,
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'unreachable',
  )
})

test('caps the JSON listing at 1 MiB', async () => {
  const server = await bootServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"items":[')
    response.write(Buffer.alloc(1024 * 1024 + 32, 'x'))
    response.end(']}')
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'response-too-large',
  )
})

test('refuses a listing that never proves completeness', async () => {
  let page = 0
  const server = await bootServer((_request, response) => {
    page += 1
    sendJson(response, 200, { items: [summary(`skill-${String(page)}`, 1)], nextCursor: `cursor-${String(page)}` })
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'page-limit',
  )
  assert.equal(page, MAX_SKILL_CATALOG_PAGES)
})

test('rejects a malformed listing page', async () => {
  const server = await bootServer((_request, response) => {
    sendJson(response, 200, { items: [{ name: 'broken' }] })
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'invalid-response',
  )
})

test('fetches exact revision metadata and bytes, mapping 404 to not-found', async () => {
  const server = await bootServer((_request, response, url) => {
    if (url.pathname === '/v1/skills/demo/1') return sendJson(response, 200, { skill: summary('demo', 1) })
    if (url.pathname === '/v1/skills/demo/1/archive') {
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(archive)
      return
    }
    sendJson(response, 404, { error: '技能不存在', code: 'skill-not-found' })
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  const meta = await client.getSkillRevision('demo', 1)
  assert.equal(meta.revision, 1)
  const bytes = await client.downloadSkillArchive('demo', 1)
  assert.deepEqual(bytes, archive)
  await assert.rejects(
    client.getSkillRevision('missing', 1),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'not-found',
  )
  await assert.rejects(
    client.downloadSkillArchive('missing', 1),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'not-found',
  )
})

test('caps a downloaded archive at 5 MiB', async () => {
  const server = await bootServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.write(Buffer.alloc(5 * 1024 * 1024 + 1, 1))
    response.end()
  })
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor(server.host, server.port),
  })
  await assert.rejects(
    client.downloadSkillArchive('demo', 1),
    (cause: unknown) => cause instanceof SkillCatalogClientError && cause.code === 'response-too-large',
  )
})

test('reports the unavailable sentence when the host is not configured', async () => {
  const client = createSkillCatalogClient({
    readSettings: () => settingsFor('', ''),
  })
  await assert.rejects(
    client.listSharedSkills(),
    (cause: unknown) => cause instanceof SkillCatalogClientError
      && cause.code === 'unreachable'
      && cause.message === SKILL_CATALOG_UNAVAILABLE,
  )
})
