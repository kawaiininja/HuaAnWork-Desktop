/**
 * Task 4: M-A0 catalog contract, three-token role separation, fail-closed
 * configuration, atomic state store and full-request audit.
 *
 * The legacy assertions are pinned against the external M-A0 service: the
 * three `tests/fixtures/entries/*.json` files are exact copies of its
 * `entries/` directory, so "field-for-field" means a deep equality with the
 * raw parsed documents — not a hand-written subset of fields.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { test, vi } from 'vitest'

import { generateKeyPair } from '@huaanwork/catalog-signing'
import { redactSecrets } from '../src/audit.ts'
import {
  AgentCatalogConfigError,
  loadAgentCatalogConfig,
  type AgentCatalogConfig,
} from '../src/config.ts'
import { CatalogStore, StoreCorruptError, emptyCatalogState, packageKey } from '../src/store.ts'
import {
  ADMIN_TOKEN,
  FAKE_PRIVATE_KEY_PEM,
  PUBLISH_TOKEN,
  READ_TOKEN,
  actorOf,
  bootTestAgentCatalog,
  createConfigEnvironment,
  createTestKeyring,
  loadFixtureEntries,
  writeKeyringFile,
} from './helpers.ts'

const TEST_TOKENS = [READ_TOKEN, PUBLISH_TOKEN, ADMIN_TOKEN]
const HALF_A_SECOND = 500

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// M-A0 contract
// ---------------------------------------------------------------------------

test('keeps M-A0 catalog contract and separates roles', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { request } = catalog
    assert.equal((await request('/v1/catalog', { token: READ_TOKEN })).status, 200)
    assert.deepEqual((await request('/v1/catalog', {})).body, { error: '口令错误' })
    assert.equal((await request('/v1/catalog/typo-check', { token: READ_TOKEN })).body.name, 'typo-check')
    assert.equal((await request('/v1/catalog/%E0%A4%A', { token: READ_TOKEN })).status, 404)
    assert.equal(
      (await request('/v1/agent-packages/submissions', { token: READ_TOKEN, method: 'POST', body: Buffer.alloc(1) })).status,
      403,
    )
    assert.equal((await request('/v1/agent-packages/submissions?status=pending', { token: PUBLISH_TOKEN })).status, 403)
  } finally {
    await catalog.close()
  }
})

test('serves the three M-A0 entries field-for-field', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const fixtures = await loadFixtureEntries()
    const listed = await catalog.request<{ items: Array<Record<string, unknown>> }>('/v1/catalog', { token: READ_TOKEN })
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items.length, fixtures.length)

    const byName = new Map(listed.body.items.map(item => [String(item.name), item]))
    for (const fixture of fixtures) {
      const name = String(fixture.name)
      // Deep equality against the RAW parsed fixture: every field, nested
      // schema and array must survive the read path unchanged.
      assert.deepEqual(byName.get(name), fixture)

      const single = await catalog.request<Record<string, unknown>>(`/v1/catalog/${name}`, { token: READ_TOKEN })
      assert.equal(single.status, 200)
      assert.deepEqual(single.body, fixture)
    }
  } finally {
    await catalog.close()
  }
})

test('preserves the M-A0 401, 404 and 405 bodies and URL-decoding behaviour', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { request } = catalog

    // 401: missing, malformed, and wrong bearer tokens all share one body.
    assert.deepEqual((await request('/v1/catalog')).body, { error: '口令错误' })
    assert.deepEqual((await request('/v1/catalog', { token: 'not-the-token' })).body, { error: '口令错误' })
    assert.deepEqual(
      (await request('/v1/catalog', { headers: { authorization: 'Basic dXNlcjpwYXNz' } })).body,
      { error: '口令错误' },
    )

    // 404: an unknown entry and a malformed percent-encoding share one body.
    const missing = await request('/v1/catalog/does-not-exist', { token: READ_TOKEN })
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.body, { error: '条目不存在' })
    const malformed = await request('/v1/catalog/%E0%A4%A', { token: READ_TOKEN })
    assert.equal(malformed.status, 404)
    assert.deepEqual(malformed.body, { error: '条目不存在' })
    const traversal = await request('/v1/catalog/%2E%2E%2Fsecrets', { token: READ_TOKEN })
    assert.equal(traversal.status, 404)
    assert.deepEqual(traversal.body, { error: '条目不存在' })

    // M-A0 answers 405 for any non-GET once authenticated; unknown routes 404.
    const wrongMethod = await request('/v1/catalog', { token: READ_TOKEN, method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.deepEqual(wrongMethod.body, { error: '只支持 GET' })
    const unknownRoute = await request('/v1/not-a-route', { token: READ_TOKEN })
    assert.equal(unknownRoute.status, 404)
    assert.deepEqual(unknownRoute.body, { error: 'Not Found' })
    const unknownMethod = await request('/v1/agent-packages/revocations', { token: READ_TOKEN, method: 'PUT' })
    assert.equal(unknownMethod.status, 405)
    assert.deepEqual(unknownMethod.body, { error: '方法不允许', code: 'method-not-allowed' })
  } finally {
    await catalog.close()
  }
})

test('skips a broken entry file with a warning and treats a missing entries dir as empty', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    await writeFile(join(catalog.entriesDir, 'broken.json'), '{ this is not json', 'utf8')
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(value => String(value)).join(' '))
    }
    try {
      const listed = await catalog.request<{ items: Array<Record<string, unknown>> }>('/v1/catalog', {
        token: READ_TOKEN,
      })
      assert.equal(listed.status, 200)
      assert.equal(listed.body.items.length, 3)
      assert.equal(listed.body.items.some(item => item.name === 'broken'), false)
    } finally {
      console.error = original
    }
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /条目文件解析失败/u)
    assert.match(errors[0] ?? '', /broken\.json/u)
  } finally {
    await catalog.close()
  }

  const emptyCatalog = await bootTestAgentCatalog({ entriesMode: 'missing' })
  try {
    const listed = await emptyCatalog.request<{ items: unknown[] }>('/v1/catalog', { token: READ_TOKEN })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body, { items: [] })
    const single = await emptyCatalog.request('/v1/catalog/typo-check', { token: READ_TOKEN })
    assert.equal(single.status, 404)
    assert.deepEqual(single.body, { error: '条目不存在' })
  } finally {
    await emptyCatalog.close()
  }
})

test('redacts secrets in malformed legacy entry diagnostics', async () => {
  // A token the server actually knows (minted for a different role than the
  // request presents); an arbitrary `sk-` string is not a configured secret and
  // therefore not something the redactor can recognize.
  const token = ADMIN_TOKEN
  const pem = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'
  const catalog = await bootTestAgentCatalog()
  // Both the file name (the logged path) and the file content (the parser
  // message excerpt) carry the secret; neither may reach the log verbatim.
  await writeFile(join(catalog.entriesDir, `${token}.json`), `${token}\n${pem}`, 'utf8')
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(value => String(value)).join(' '))
  })
  try {
    const listed = await catalog.request('/v1/catalog', { token: READ_TOKEN })
    assert.equal(listed.status, 200)
    const joined = errors.join('\n')
    assert.equal(joined.includes(token), false)
    assert.equal(joined.includes('BEGIN PRIVATE KEY'), false)
    assert.match(joined, /\[REDACTED/u)
    assert.match(joined, /条目文件解析失败/u)
  } finally {
    spy.mockRestore()
    await catalog.close()
  }
})

test('does not log the Authorization header or any token', async () => {
  const catalog = await bootTestAgentCatalog()
  const logs: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => {
    logs.push(args.map(value => String(value)).join(' '))
  }
  console.error = (...args: unknown[]) => {
    logs.push(args.map(value => String(value)).join(' '))
  }
  try {
    await catalog.request('/v1/catalog', { token: READ_TOKEN })
    await catalog.request('/v1/catalog', { token: 'wrong-token' })
    await catalog.request('/v1/agent-packages/submissions', { token: READ_TOKEN, method: 'POST' })
  } finally {
    console.log = originalLog
    console.error = originalError
    await catalog.close()
  }
  const combined = logs.join('\n')
  for (const token of [...TEST_TOKENS, 'wrong-token', 'Bearer ']) {
    assert.equal(combined.includes(token), false, `log output leaked ${token}`)
  }
})

// ---------------------------------------------------------------------------
// Three-token role separation
// ---------------------------------------------------------------------------

test('enforces the three-token role matrix with 403 before any handler runs', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { request } = catalog
    const forbidden = { error: '权限不足', code: 'forbidden' }

    // Read token cannot reach the publish or admin surfaces.
    for (const [path, method, body] of [
      ['/v1/agent-packages/submissions', 'POST', Buffer.alloc(1)],
      ['/v1/agent-packages/submissions?status=pending', 'GET', undefined],
      ['/v1/agent-packages/submissions/abc', 'GET', undefined],
      ['/v1/agent-packages/submissions/abc/bundle', 'GET', undefined],
      ['/v1/agent-packages/submissions/abc/approve', 'POST', { signature: 'x' }],
      ['/v1/agent-packages/delist-requests?status=pending', 'GET', undefined],
      ['/v1/agent-packages/delist-requests/abc/approve', 'POST', undefined],
      ['/v1/agent-packages/demo/1.0.0/delist-requests', 'POST', { reason: 'x' }],
      ['/v1/agent-packages/demo/1.0.0/revoke', 'POST', { reason: 'x' }],
    ] as ReadonlyArray<readonly [string, string, unknown]>) {
      const response = await request(path, { token: READ_TOKEN, method, ...(body === undefined ? {} : { body: body as Buffer }) })
      assert.equal(response.status, 403, `${method} ${path} must be forbidden for the read token`)
      assert.deepEqual(response.body, forbidden)
    }

    // Publish token cannot read the catalog or reach the admin surfaces.
    for (const [path, method, body] of [
      ['/v1/catalog', 'GET', undefined],
      ['/v1/agent-packages', 'GET', undefined],
      ['/v1/agent-packages/revocations', 'GET', undefined],
      ['/v1/agent-packages/demo/1.0.0', 'GET', undefined],
      ['/v1/agent-packages/submissions?status=pending', 'GET', undefined],
      ['/v1/agent-packages/delist-requests?status=pending', 'GET', undefined],
      ['/v1/agent-packages/demo/1.0.0/revoke', 'POST', { reason: 'x' }],
    ] as ReadonlyArray<readonly [string, string, unknown]>) {
      const response = await request(path, { token: PUBLISH_TOKEN, method, ...(body === undefined ? {} : { body: body as Buffer }) })
      assert.equal(response.status, 403, `${method} ${path} must be forbidden for the publish token`)
      assert.deepEqual(response.body, forbidden)
    }

    // Admin token cannot use any read or publish surface.
    for (const [path, method, body] of [
      ['/v1/catalog', 'GET', undefined],
      ['/v1/catalog/typo-check', 'GET', undefined],
      ['/v1/agent-packages', 'GET', undefined],
      ['/v1/agent-packages/revocations', 'GET', undefined],
      ['/v1/agent-packages/submissions', 'POST', Buffer.alloc(1)],
      ['/v1/agent-packages/demo/1.0.0/delist-requests', 'POST', { reason: 'x' }],
    ] as ReadonlyArray<readonly [string, string, unknown]>) {
      const response = await request(path, { token: ADMIN_TOKEN, method, ...(body === undefined ? {} : { body: body as Buffer }) })
      assert.equal(response.status, 403, `${method} ${path} must be forbidden for the admin token`)
      assert.deepEqual(response.body, forbidden)
    }

    // Right-role requests are NOT rejected by authorization. (Their handlers
    // land in Tasks 5/6; asserting "not 403" keeps this matrix stable then.)
    for (const [path, method, token, body] of [
      ['/v1/agent-packages', 'GET', READ_TOKEN, undefined],
      ['/v1/agent-packages/revocations', 'GET', READ_TOKEN, undefined],
      ['/v1/agent-packages/demo/1.0.0/bundle', 'GET', READ_TOKEN, undefined],
      ['/v1/agent-packages/submissions', 'POST', PUBLISH_TOKEN, Buffer.alloc(1)],
      ['/v1/agent-packages/submissions/abc', 'GET', PUBLISH_TOKEN, undefined],
      ['/v1/agent-packages/submissions/abc', 'GET', ADMIN_TOKEN, undefined],
      ['/v1/agent-packages/submissions?status=pending', 'GET', ADMIN_TOKEN, undefined],
      ['/v1/agent-packages/demo/1.0.0/revoke', 'POST', ADMIN_TOKEN, { reason: 'x' }],
    ] as ReadonlyArray<readonly [string, string, string, unknown]>) {
      const response = await request(path, { token, method, ...(body === undefined ? {} : { body: body as Buffer }) })
      assert.notEqual(response.status, 403, `${method} ${path} must be allowed for its role`)
    }

    // Missing credentials are 401 everywhere, including agent-package routes.
    for (const path of ['/v1/agent-packages', '/v1/agent-packages/submissions?status=pending', '/v1/unknown']) {
      const response = await request(path)
      assert.equal(response.status, 401)
      assert.deepEqual(response.body, { error: '口令错误' })
    }
  } finally {
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Full-request audit
// ---------------------------------------------------------------------------

test('audits every request with timestamp, actor, action and outcome', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const { request } = catalog
    const startedAt = Date.now()
    await request('/v1/catalog', { token: READ_TOKEN })
    await request('/v1/catalog', {})
    await request('/v1/agent-packages/submissions', { token: READ_TOKEN, method: 'POST' })
    await request('/v1/not-a-route', { token: READ_TOKEN })
    await request('/v1/catalog', { token: READ_TOKEN, method: 'POST' })
    await request('/v1/catalog', { token: 'wrong-token' })

    // The audit line is durable BEFORE the response was written: reading the
    // file immediately after the last response must see all six records.
    const records = await catalog.readAudit()
    assert.equal(records.length, 6)
    const raw = await catalog.readAuditRaw()

    const readActor = actorOf(READ_TOKEN)
    const actions = records.map(record => record.action)
    assert.ok(actions.includes('catalog.list'))
    assert.ok(actions.includes('catalog.list') && records.some(r => r.status === 405))
    assert.equal(records.filter(record => record.action === 'catalog.list' && record.status === 200).length, 1)
    assert.ok(records.some(record => record.action === 'auth.denied' && record.status === 401 && record.actor === 'anonymous'))
    assert.ok(
      records.some(
        record =>
          record.action === 'agentPackages.submissions.create'
          && record.status === 403
          && record.outcome === 'denied'
          && record.actor === readActor,
      ),
    )
    assert.ok(records.some(record => record.action === 'route.unknown' && record.status === 404 && record.actor === readActor))

    for (const record of records) {
      assert.equal(typeof record.timestamp, 'string')
      assert.equal(Number.isNaN(Date.parse(record.timestamp)), false)
      assert.match(record.actor, /^(?:anonymous|[0-9a-f]{12})$/u)
      assert.equal(typeof record.action, 'string')
      assert.ok(['ok', 'denied', 'error'].includes(record.outcome))
      assert.equal(typeof record.status, 'number')
      assert.ok(Date.parse(record.timestamp) >= startedAt - HALF_A_SECOND)
    }

    // Actor isolation: no raw token, no Authorization header, no bearer text.
    for (const token of TEST_TOKENS) {
      assert.equal(raw.includes(token), false)
    }
    assert.equal(raw.toLowerCase().includes('authorization'), false)
    assert.equal(raw.toLowerCase().includes('bearer'), false)
    assert.equal(raw.includes(readActor), true)
  } finally {
    await catalog.close()
  }
})

test('redacts configured tokens and private-key blocks before they reach disk', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    // Direct audit write with the token AND a PEM block deliberately placed in
    // `reason` (the shape Tasks 5/6 will pass through from handler errors).
    await catalog.runtime.audit.writeAudit({
      action: 'test.redaction',
      outcome: 'error',
      status: 500,
      actor: 'anonymous',
      reason: `token=${READ_TOKEN} publish=${PUBLISH_TOKEN} admin=${ADMIN_TOKEN}\n${FAKE_PRIVATE_KEY_PEM}`,
    })

    // Integration path: a token swallowed by the route falls into the audit
    // reason for the legacy 404 (`entry not found: <name>`).
    const tokenInPath = await catalog.request(`/v1/catalog/${READ_TOKEN}`, { token: READ_TOKEN })
    assert.equal(tokenInPath.status, 404)

    const raw = await catalog.readAuditRaw()
    for (const token of TEST_TOKENS) {
      assert.equal(raw.includes(token), false, `audit log leaked ${token}`)
    }
    assert.equal(raw.includes('BEGIN PRIVATE KEY'), false)
    assert.equal(raw.includes('END PRIVATE KEY'), false)
    assert.equal(raw.includes('[REDACTED]'), true)
    // The line stays one complete JSON document per record.
    const lines = raw.split('\n').filter(line => line.trim() !== '')
    assert.equal(lines.length, 2)
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line))
    }
  } finally {
    await catalog.close()
  }
})

test('redacts secrets standalone and keeps ordinary text intact', () => {
  const text = `read=${READ_TOKEN} publish=${PUBLISH_TOKEN} admin=${ADMIN_TOKEN}`
  const redacted = redactSecrets(text, TEST_TOKENS)
  assert.equal(redacted, 'read=[REDACTED] publish=[REDACTED] admin=[REDACTED]')

  const pem = redactSecrets(`before\n${FAKE_PRIVATE_KEY_PEM}\nafter`, TEST_TOKENS)
  assert.equal(pem.includes('BEGIN PRIVATE KEY'), false)
  assert.equal(pem.includes('END PRIVATE KEY'), false)
  assert.equal(pem, 'before\n[REDACTED PRIVATE KEY]\nafter')

  // An unterminated block must not leak its body either.
  const truncated = redactSecrets('before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretbody', TEST_TOKENS)
  assert.equal(truncated, 'before\n[REDACTED PRIVATE KEY]')

  // Redaction runs longest-first: a secret that is a PREFIX of another must
  // not be replaced first (that would leave the longer one's tail on disk).
  const shortSecret = 'prefix-secret-012345678901234567890123456789'
  const longSecret = `${shortSecret}-extended-tail`
  assert.equal(
    redactSecrets(`a ${longSecret} b ${shortSecret} c`, [shortSecret, longSecret]),
    'a [REDACTED] b [REDACTED] c',
  )

  assert.equal(redactSecrets('plain catalog text', TEST_TOKENS), 'plain catalog text')
})

test('returns 500 when the audit log cannot be written and never answers 200 unaudited', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    assert.equal((await catalog.request('/v1/catalog', { token: READ_TOKEN })).status, 200)
    await rm(catalog.dataDir, { recursive: true, force: true })

    const response = await catalog.request('/v1/catalog', { token: READ_TOKEN })
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, { error: '审计写入失败', code: 'audit-write-failed' })

    // The failure latches fail-closed: later writes are refused BEFORE their
    // handler runs instead of being applied unaudited.
    assert.equal(catalog.runtime.audit.unavailable, true)
    await assert.rejects(
      catalog.runtime.audit.writeAudit({
        action: 'test.after-failure',
        outcome: 'ok',
        status: 200,
        actor: 'anonymous',
      }),
    )
    const write = await catalog.request('/v1/agent-packages/submissions', {
      token: PUBLISH_TOKEN,
      method: 'POST',
      body: Buffer.alloc(1),
    })
    assert.equal(write.status, 500)
    assert.deepEqual(write.body, { error: '审计写入失败', code: 'audit-write-failed' })
  } finally {
    await catalog.close()
  }
})

test('caps JSON responses at 1 MiB instead of streaming an oversized body', async () => {
  const catalog = await bootTestAgentCatalog()
  try {
    const huge = { name: 'huge-entry', description: 'x'.repeat(1_100_000) }
    await writeFile(join(catalog.entriesDir, 'huge.json'), JSON.stringify(huge), 'utf8')
    const response = await catalog.request('/v1/catalog', { token: READ_TOKEN })
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, { error: '响应过大', code: 'response-too-large' })
    const records = await catalog.readAudit()
    const last = records.at(-1)
    assert.equal(last?.status, 500)
    assert.equal(last?.outcome, 'error')
  } finally {
    await catalog.close()
  }
})

test('audits an unexpected handler failure instead of answering an unaudited 500', async () => {
  const catalog = await bootTestAgentCatalog()
  const originalError = console.error
  const logs: string[] = []
  console.error = (...args: unknown[]) => {
    logs.push(args.map(value => String(value)).join(' '))
  }
  try {
    // A regular FILE where the entries DIRECTORY is expected makes
    // `readdirSync` throw inside the handler. This is the portable form of the
    // failure (chmod tricks are not meaningful on Windows) and the shape Tasks
    // 5/6 multiply: parsing, state and bundle writes all throw from dispatch.
    await rm(catalog.entriesDir, { recursive: true, force: true })
    await writeFile(catalog.entriesDir, 'not a directory', 'utf8')

    const listed = await catalog.request('/v1/catalog', { token: READ_TOKEN })
    assert.equal(listed.status, 500)
    assert.deepEqual(listed.body, { error: '内部错误', code: 'internal' })

    const single = await catalog.request('/v1/catalog/typo-check', { token: READ_TOKEN })
    assert.equal(single.status, 500)
    assert.deepEqual(single.body, { error: '内部错误', code: 'internal' })

    // Exactly one durable record per failed request: the action is derived
    // from the route, the outcome is `error`, the actor is the token hash and
    // the reason survives for forensics (redacted).
    const records = await catalog.readAudit()
    assert.deepEqual(
      records.map(record => ({
        action: record.action,
        status: record.status,
        outcome: record.outcome,
        actor: record.actor,
      })),
      [
        { action: 'catalog.list', status: 500, outcome: 'error', actor: actorOf(READ_TOKEN) },
        { action: 'catalog.get', status: 500, outcome: 'error', actor: actorOf(READ_TOKEN) },
      ],
    )
    for (const record of records) {
      assert.match(record.reason ?? '', /ENOTDIR|not a directory/u)
    }
    assert.equal(logs.some(line => /request handler failed/u.test(line)), true)
    const raw = await catalog.readAuditRaw()
    for (const token of TEST_TOKENS) {
      assert.equal(raw.includes(token), false, `audit log leaked ${token}`)
    }
  } finally {
    console.error = originalError
    await catalog.close()
  }
})

// ---------------------------------------------------------------------------
// Fail-closed configuration
// ---------------------------------------------------------------------------

test('loads a valid configuration, with documented defaults for host and port', async () => {
  const environment = await createConfigEnvironment()
  try {
    const config = loadAgentCatalogConfig(environment.env)
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 18_080)
    assert.equal(config.entriesDir, environment.entriesDir)
    assert.equal(config.dataDir, environment.dataDir)
    assert.equal(config.readToken, READ_TOKEN)
    assert.equal(config.publishToken, PUBLISH_TOKEN)
    assert.equal(config.adminToken, ADMIN_TOKEN)
    assert.equal(config.keyring.length, 1)
    assert.equal(config.keyring[0]?.slot, 1)
    assert.equal(config.keyring[0]?.publicKeyHex, environment.keyring.publicKeyHex)
    // There is deliberately no private-key configuration item.
    assert.deepEqual(Object.keys(config).sort(), [
      'adminToken',
      'dataDir',
      'entriesDir',
      'host',
      'keyring',
      'keyringPath',
      'port',
      'publishToken',
      'readToken',
    ])

    const overridden = loadAgentCatalogConfig({
      ...environment.env,
      HOST: '0.0.0.0',
      PORT: '19090',
    })
    assert.equal(overridden.host, '0.0.0.0')
    assert.equal(overridden.port, 19_090)
  } finally {
    await environment.cleanup()
  }
})

test('refuses to start when any path, token or keyring is missing', async () => {
  const environment = await createConfigEnvironment()
  try {
    const required: Array<keyof NodeJS.ProcessEnv> = [
      'AGENT_CATALOG_ENTRIES_DIR',
      'AGENT_CATALOG_DATA_DIR',
      'AGENT_CATALOG_TOKEN',
      'AGENT_CATALOG_PUBLISH_TOKEN',
      'AGENT_CATALOG_ADMIN_TOKEN',
      'AGENT_CATALOG_KEYRING_PATH',
    ]
    for (const key of required) {
      const env = { ...environment.env }
      delete env[key]
      assert.throws(
        () => loadAgentCatalogConfig(env),
        (cause: unknown) =>
          cause instanceof AgentCatalogConfigError
          && cause.message.includes(String(key))
          && !TEST_TOKENS.some(token => cause.message.includes(token)),
        `${String(key)} must be required`,
      )
    }
  } finally {
    await environment.cleanup()
  }
})

test('requires three distinct tokens of at least 32 characters', async () => {
  const environment = await createConfigEnvironment()
  try {
    const base = environment.env

    for (const key of ['AGENT_CATALOG_TOKEN', 'AGENT_CATALOG_PUBLISH_TOKEN', 'AGENT_CATALOG_ADMIN_TOKEN']) {
      assert.throws(
        () => loadAgentCatalogConfig({ ...base, [key]: 'x'.repeat(31) }),
        (cause: unknown) => cause instanceof AgentCatalogConfigError && cause.message.includes('at least 32'),
        `${key} must enforce the 32-character floor`,
      )
      assert.throws(
        () => loadAgentCatalogConfig({ ...base, [key]: '   ' }),
        (cause: unknown) => cause instanceof AgentCatalogConfigError && cause.message.includes(key),
        `${key} must reject a blank value`,
      )
    }

    assert.throws(
      () => loadAgentCatalogConfig({ ...base, AGENT_CATALOG_PUBLISH_TOKEN: READ_TOKEN }),
      (cause: unknown) =>
        cause instanceof AgentCatalogConfigError
        && /distinct/u.test(cause.message)
        && !cause.message.includes(READ_TOKEN),
      'identical read/publish tokens must be refused',
    )
    assert.throws(
      () => loadAgentCatalogConfig({ ...base, AGENT_CATALOG_ADMIN_TOKEN: PUBLISH_TOKEN }),
      (cause: unknown) => cause instanceof AgentCatalogConfigError && /distinct/u.test(cause.message),
    )
    assert.throws(
      () => loadAgentCatalogConfig({ ...base, AGENT_CATALOG_ADMIN_TOKEN: READ_TOKEN }),
      (cause: unknown) => cause instanceof AgentCatalogConfigError && /distinct/u.test(cause.message),
    )
  } finally {
    await environment.cleanup()
  }
})

test('refuses an unreadable, malformed, or invalid keyring', async () => {
  const environment = await createConfigEnvironment()
  try {
    const base = environment.env

    assert.throws(
      () =>
        loadAgentCatalogConfig({
          ...base,
          AGENT_CATALOG_KEYRING_PATH: join(environment.root, 'does-not-exist.json'),
        }),
      (cause: unknown) =>
        cause instanceof AgentCatalogConfigError && cause.message.includes('AGENT_CATALOG_KEYRING_PATH'),
    )

    const malformedPath = join(environment.root, 'malformed-keyring.json')
    await writeFile(malformedPath, '{ not json', 'utf8')
    assert.throws(
      () => loadAgentCatalogConfig({ ...base, AGENT_CATALOG_KEYRING_PATH: malformedPath }),
      (cause: unknown) => cause instanceof AgentCatalogConfigError && /keyring/u.test(cause.message),
    )

    // Two slot-1 keys violate the trust-root invariant (parseCatalogKeyring).
    const first = generateKeyPair()
    const second = generateKeyPair()
    const invalidPath = join(environment.root, 'invalid-keyring.json')
    await writeKeyringFile(invalidPath, [
      { publicKeyHex: first.publicKeyHex, slot: 1 },
      { publicKeyHex: second.publicKeyHex, slot: 1 },
    ])
    assert.throws(
      () => loadAgentCatalogConfig({ ...base, AGENT_CATALOG_KEYRING_PATH: invalidPath }),
      (cause: unknown) =>
        cause instanceof AgentCatalogConfigError
        && cause.message.includes('exactly one slot 1 key'),
    )
  } finally {
    await environment.cleanup()
  }
})

test('resolves relative directories to absolute paths without reading private keys', async () => {
  const environment = await createConfigEnvironment()
  try {
    const config = loadAgentCatalogConfig({
      ...environment.env,
      AGENT_CATALOG_ENTRIES_DIR: 'relative/entries',
      AGENT_CATALOG_DATA_DIR: 'relative/data',
    })
    assert.equal(isAbsolute(config.entriesDir), true)
    assert.equal(isAbsolute(config.dataDir), true)
    assert.equal(JSON.stringify(config).includes('PRIVATE KEY'), false)
    assert.equal(JSON.stringify(config).includes(environment.keyring.privateKeyPem), false)
  } finally {
    await environment.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Atomic state store
// ---------------------------------------------------------------------------

test('stores an empty CatalogState and persists updates atomically', async () => {
  const environment = await createConfigEnvironment()
  try {
    const dataDir = join(environment.root, 'store-data')
    const store = await CatalogStore.open(dataDir)
    assert.deepEqual(store.read(), emptyCatalogState())
    assert.deepEqual(store.read(), {
      schemaVersion: 1,
      submissions: {},
      packages: {},
      delistRequests: {},
      revocations: {},
    })
    assert.deepEqual(emptyCatalogState(), store.read())

    const result = await store.update(draft => {
      draft.revocations[packageKey('demo', '1.0.0')] = {
        slug: 'demo',
        version: '1.0.0',
        reason: 'unsafe',
        revokedAt: '2026-10-24T00:00:00.000Z',
        actor: 'administrator',
      }
      return 'committed'
    })
    assert.equal(result, 'committed')

    const statePath = join(dataDir, 'state.json')
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    assert.equal(persisted.schemaVersion, 1)
    assert.equal(Object.keys(persisted.revocations as Record<string, unknown>).length, 1)

    if (process.platform !== 'win32') {
      assert.equal((await stat(statePath)).mode & 0o777, 0o600)
    }

    // A restart (re-open) reads the committed state back.
    const reopened = await CatalogStore.open(dataDir)
    assert.equal(reopened.read().revocations['demo/1.0.0']?.reason, 'unsafe')
  } finally {
    await environment.cleanup()
  }
})

test('serializes concurrent updates through one write queue without losing writes', async () => {
  const environment = await createConfigEnvironment()
  try {
    const dataDir = join(environment.root, 'concurrent-data')
    const store = await CatalogStore.open(dataDir)

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update(draft => {
          draft.revocations[`pkg-${String(index)}/1.0.0`] = {
            slug: `pkg-${String(index)}`,
            version: '1.0.0',
            reason: 'concurrent',
            revokedAt: '2026-10-24T00:00:00.000Z',
            actor: 'administrator',
          }
        }),
      ),
    )

    assert.equal(Object.keys(store.read().revocations).length, 20)
    const persisted = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) as {
      revocations: Record<string, unknown>
    }
    assert.equal(Object.keys(persisted.revocations).length, 20)

    // A throwing mutator leaves the committed state untouched and does not
    // wedge the queue for subsequent updates.
    await assert.rejects(
      store.update(() => {
        throw new Error('mutator exploded')
      }),
      /mutator exploded/u,
    )
    assert.equal(Object.keys(store.read().revocations).length, 20)
    await store.update(draft => {
      draft.revocations['after-failure/1.0.0'] = {
        slug: 'after-failure',
        version: '1.0.0',
        reason: 'still works',
        revokedAt: '2026-10-24T00:00:01.000Z',
        actor: 'administrator',
      }
    })
    assert.equal(Object.keys(store.read().revocations).length, 21)
  } finally {
    await environment.cleanup()
  }
})

test('serializes per package and lets different packages proceed concurrently', async () => {
  const environment = await createConfigEnvironment()
  try {
    const store = await CatalogStore.open(join(environment.root, 'lock-data'))
    const events: string[] = []

    await Promise.all([
      store.withPackageLock('alpha', '1.0.0', async () => {
        events.push('alpha-1-start')
        await wait(30)
        events.push('alpha-1-end')
      }),
      store.withPackageLock('alpha', '1.0.0', async () => {
        events.push('alpha-2-start')
        events.push('alpha-2-end')
      }),
      store.withPackageLock('beta', '1.0.0', async () => {
        events.push('beta-start')
        await wait(30)
        events.push('beta-end')
      }),
    ])

    assert.ok(events.indexOf('alpha-1-end') < events.indexOf('alpha-2-start'), 'same package must serialize')
    assert.ok(events.indexOf('beta-start') < events.indexOf('alpha-1-end'), 'different packages must overlap')

    // A rejected critical section releases the lock for the next waiter.
    await assert.rejects(
      store.withPackageLock('gamma', '1.0.0', async () => {
        throw new Error('section failed')
      }),
      /section failed/u,
    )
    assert.equal(await store.withPackageLock('gamma', '1.0.0', async () => 'ok'), 'ok')
  } finally {
    await environment.cleanup()
  }
})

test('startup deletes only its own state temp files and never bundle recovery evidence', async () => {
  const environment = await createConfigEnvironment()
  try {
    const dataDir = join(environment.root, 'temp-data')
    await mkdir(join(dataDir, 'submissions', 'sub-1'), { recursive: true })
    const evidence = join(dataDir, 'submissions', 'sub-1', 'bundle.tgz.recover')
    await writeFile(evidence, 'recovery evidence', 'utf8')
    const ownTemp = join(dataDir, `state.json.tmp-${String(process.pid)}-deadbeef`)
    const staleTemp = join(dataDir, 'state.json.tmp-1-deadbeef')
    const auditTemp = join(dataDir, `audit.jsonl.tmp-${String(process.pid)}-deadbeef`)
    await writeFile(ownTemp, 'partial', 'utf8')
    await writeFile(staleTemp, 'partial', 'utf8')
    await writeFile(auditTemp, 'partial', 'utf8')

    await CatalogStore.open(dataDir)

    const remaining = (await readdir(dataDir)).sort()
    assert.equal(remaining.includes(`state.json.tmp-${String(process.pid)}-deadbeef`), false)
    assert.equal(remaining.includes('state.json.tmp-1-deadbeef'), false)
    assert.equal(remaining.includes(`audit.jsonl.tmp-${String(process.pid)}-deadbeef`), true)
    assert.equal(await readFile(evidence, 'utf8'), 'recovery evidence')
  } finally {
    await environment.cleanup()
  }
})

test('fails closed on a corrupt state file without overwriting it', async () => {
  const environment = await createConfigEnvironment()
  try {
    const dataDir = join(environment.root, 'corrupt-data')
    await mkdir(dataDir, { recursive: true })
    const statePath = join(dataDir, 'state.json')
    await writeFile(statePath, '{ "schemaVersion": 1, "submissions": ', 'utf8')

    await assert.rejects(() => CatalogStore.open(dataDir), StoreCorruptError)
    assert.equal(await readFile(statePath, 'utf8'), '{ "schemaVersion": 1, "submissions": ')

    await writeFile(statePath, JSON.stringify({ schemaVersion: 2, submissions: {} }), 'utf8')
    await assert.rejects(() => CatalogStore.open(dataDir), StoreCorruptError)
  } finally {
    await environment.cleanup()
  }
})

test('createConfigEnvironment and createTestKeyring keep private material out of config', async () => {
  const environment = await createConfigEnvironment()
  try {
    const second = await createTestKeyring(environment.root, 2)
    assert.notEqual(second.keyId, environment.keyring.keyId)
    const config: AgentCatalogConfig = loadAgentCatalogConfig(environment.env)
    assert.equal('privateKeyPem' in config, false)
    assert.equal(JSON.stringify(config).includes(second.privateKeyPem), false)
  } finally {
    await environment.cleanup()
  }
})
