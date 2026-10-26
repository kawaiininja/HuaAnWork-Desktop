/**
 * Shared test helper for the in-repo agent catalog server.
 *
 * Every boot creates a throwaway root under the OS temp directory with:
 *   - entries/    the three M-A0 fixtures (or empty / absent)
 *   - data/       state.json + audit.jsonl live here
 *   - keyring.json  an EPHEMERAL Ed25519 keypair generated at test time
 *
 * No production token, key, or fixture private key is committed: the tokens
 * below are obvious test strings and the keypair exists only for the duration
 * of a test. The server listens on an ephemeral loopback port.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fingerprintPublicKeyHex,
  generateKeyPair,
  type CatalogKeyringEntry,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'
import { loadAgentCatalogConfig, type AgentCatalogConfig } from '../src/config.ts'
import type { AuditRecord } from '../src/audit.ts'
import {
  createAgentCatalogRuntime,
  createAgentCatalogServer,
  type AgentCatalogRuntime,
} from '../src/server.ts'

export const READ_TOKEN = 'test-read-token-012345678901234567890123456789'
export const PUBLISH_TOKEN = 'test-publish-token-012345678901234567890123456789'
export const ADMIN_TOKEN = 'test-admin-token-012345678901234567890123456789'

const FIXTURE_ENTRIES_DIR = join(import.meta.dirname, 'fixtures', 'entries')
const FIXTURE_ENTRY_FILES = ['code-review.json', 'task-orch.json', 'typo-check.json'] as const

/** The three M-A0 entry documents, parsed from the committed fixture copies. */
export async function loadFixtureEntries(): Promise<Array<Record<string, unknown>>> {
  const entries: Array<Record<string, unknown>> = []
  for (const file of FIXTURE_ENTRY_FILES) {
    entries.push(JSON.parse(await readFile(join(FIXTURE_ENTRIES_DIR, file), 'utf8')) as Record<string, unknown>)
  }
  return entries
}

export interface TestKeyring extends GeneratedKeyPair {
  readonly path: string
  readonly keyId: string
  readonly slot: 1 | 2
}

/**
 * Generate an EPHEMERAL Ed25519 keypair and write a single-slot keyring file.
 * `slot` is a test convenience for rotation cases; production keyrings pin a
 * slot 1 key (plus at most one slot 2 key).
 */
export async function createTestKeyring(directory: string, slot: 1 | 2 = 1): Promise<TestKeyring> {
  const pair = generateKeyPair()
  const keyId = fingerprintPublicKeyHex(pair.publicKeyHex)
  const keyringPath = join(directory, slot === 1 ? 'keyring.json' : `keyring-${String(slot)}.json`)
  await writeFile(
    keyringPath,
    `${JSON.stringify({ schemaVersion: 1, keys: [{ keyId, publicKeyHex: pair.publicKeyHex, slot }] }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return { ...pair, path: keyringPath, keyId, slot }
}

export async function writeKeyringFile(
  path: string,
  keys: ReadonlyArray<Omit<CatalogKeyringEntry, 'keyId'> & { keyId?: string }>,
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        keys: keys.map(key => ({
          ...key,
          keyId: key.keyId ?? fingerprintPublicKeyHex(key.publicKeyHex),
        })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

export interface ConfigEnvironment {
  readonly root: string
  readonly entriesDir: string
  readonly dataDir: string
  readonly keyringPath: string
  readonly keyring: TestKeyring
  readonly env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

/**
 * A complete, valid environment for `loadAgentCatalogConfig`. Callers mutate
 * the returned `env` (delete a key, shorten a token, ...) to exercise the
 * fail-closed validation without touching the real process environment.
 */
export async function createConfigEnvironment(): Promise<ConfigEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'agent-catalog-config-'))
  const entriesDir = join(root, 'entries')
  const dataDir = join(root, 'data')
  await mkdir(entriesDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const keyring = await createTestKeyring(root)
  return {
    root,
    entriesDir,
    dataDir,
    keyringPath: keyring.path,
    keyring,
    env: {
      HOST: '127.0.0.1',
      PORT: '18080',
      AGENT_CATALOG_ENTRIES_DIR: entriesDir,
      AGENT_CATALOG_DATA_DIR: dataDir,
      AGENT_CATALOG_TOKEN: READ_TOKEN,
      AGENT_CATALOG_PUBLISH_TOKEN: PUBLISH_TOKEN,
      AGENT_CATALOG_ADMIN_TOKEN: ADMIN_TOKEN,
      AGENT_CATALOG_KEYRING_PATH: keyring.path,
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type TestBody = Buffer | string | Record<string, unknown>

export interface TestRequestOptions {
  readonly token?: string
  readonly method?: string
  readonly body?: TestBody
  readonly headers?: Record<string, string>
}

export interface TestResponse<T = any> {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  /** Parsed JSON body when the response advertises JSON; otherwise undefined. */
  readonly body: T
  readonly buffer: Buffer
}

export interface BootTestAgentCatalogOptions {
  /** 'fixtures' (default) copies the three M-A0 entries; 'empty' leaves the dir empty; 'missing' never creates it. */
  readonly entriesMode?: 'fixtures' | 'empty' | 'missing'
  /**
   * Also generate a slot-2 key retired at this instant. The pair is exposed as
   * `retiredKey` so a test can sign with a key the server must refuse, and the
   * parsed keyring carries its `retiredAt` (verification enforces it).
   */
  readonly retiredKeyAt?: string
}

export interface TestAgentCatalog {
  readonly baseUrl: string
  readonly config: AgentCatalogConfig
  readonly runtime: AgentCatalogRuntime
  readonly dataDir: string
  readonly entriesDir: string
  readonly keyringPath: string
  /** The pinned slot-1 public key (verification trust root). */
  readonly keyring: CatalogKeyringEntry
  /** Every parsed keyring entry, including a retired slot-2 key when configured. */
  readonly keyringEntries: readonly CatalogKeyringEntry[]
  /** The full ephemeral slot-1 keypair; `privateKeyPem` signs test digests. */
  readonly activeKey: TestKeyring
  /** Present only when `retiredKeyAt` was configured. */
  readonly retiredKey?: TestKeyring
  readonly auditPath: string
  request: <T = any>(path: string, options?: TestRequestOptions) => Promise<TestResponse<T>>
  readAudit: () => Promise<AuditRecord[]>
  readAuditRaw: () => Promise<string>
  close: () => Promise<void>
}

export async function bootTestAgentCatalog(
  options: BootTestAgentCatalogOptions = {},
): Promise<TestAgentCatalog> {
  const root = await mkdtemp(join(tmpdir(), 'agent-catalog-server-'))
  const entriesDir = join(root, 'entries')
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  const entriesMode = options.entriesMode ?? 'fixtures'
  if (entriesMode !== 'missing') {
    await mkdir(entriesDir, { recursive: true })
  }
  if (entriesMode === 'fixtures') {
    for (const file of FIXTURE_ENTRY_FILES) {
      await copyFile(join(FIXTURE_ENTRIES_DIR, file), join(entriesDir, file))
    }
  }
  const keyring = await createTestKeyring(root)
  let retiredKey: TestKeyring | undefined
  if (options.retiredKeyAt !== undefined) {
    retiredKey = await createTestKeyring(root, 2)
    // Rewrite the ACTIVE keyring file so it carries both slots: the slot-1 key
    // above plus a slot-2 key that is already retired at the requested instant.
    await writeKeyringFile(keyring.path, [
      { publicKeyHex: keyring.publicKeyHex, slot: 1 },
      { publicKeyHex: retiredKey.publicKeyHex, slot: 2, retiredAt: options.retiredKeyAt },
    ])
  }

  // Exercise the real env parsing, then pin the listener to an ephemeral port
  // (`listen(0)`): PORT=0 is intentionally not a valid configured port.
  const config: AgentCatalogConfig = {
    ...loadAgentCatalogConfig({
      HOST: '127.0.0.1',
      PORT: '18080',
      AGENT_CATALOG_ENTRIES_DIR: entriesDir,
      AGENT_CATALOG_DATA_DIR: dataDir,
      AGENT_CATALOG_TOKEN: READ_TOKEN,
      AGENT_CATALOG_PUBLISH_TOKEN: PUBLISH_TOKEN,
      AGENT_CATALOG_ADMIN_TOKEN: ADMIN_TOKEN,
      AGENT_CATALOG_KEYRING_PATH: keyring.path,
    }),
    port: 0,
  }
  const runtime = await createAgentCatalogRuntime(config)
  const server = createAgentCatalogServer(config, runtime)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(address.port)}`
  const auditPath = join(dataDir, 'audit.jsonl')

  const request = <T = any>(path: string, requestOptions: TestRequestOptions = {}): Promise<TestResponse<T>> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...requestOptions.headers }
      if (requestOptions.token !== undefined) {
        headers.authorization = `Bearer ${requestOptions.token}`
      }
      let payload: Buffer | undefined
      if (requestOptions.body !== undefined) {
        if (Buffer.isBuffer(requestOptions.body)) {
          payload = requestOptions.body
        } else if (typeof requestOptions.body === 'string') {
          payload = Buffer.from(requestOptions.body, 'utf8')
        } else {
          payload = Buffer.from(JSON.stringify(requestOptions.body), 'utf8')
          headers['content-type'] ??= 'application/json'
        }
        headers['content-length'] = String(payload.length)
      }
      const clientRequest = httpRequest(
        `${baseUrl}${path}`,
        { method: requestOptions.method ?? 'GET', headers, agent: false },
        response => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const buffer = Buffer.concat(chunks)
            const contentType = String(response.headers['content-type'] ?? '')
            let body: unknown
            if (contentType.includes('application/json')) {
              try {
                body = JSON.parse(buffer.toString('utf8'))
              } catch {
                body = undefined
              }
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: body as T,
              buffer,
            })
          })
        },
      )
      clientRequest.on('error', reject)
      clientRequest.end(payload)
    })

  const readAuditRaw = async (): Promise<string> => {
    try {
      return await readFile(auditPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw cause
    }
  }

  return {
    baseUrl,
    config,
    runtime,
    dataDir,
    entriesDir,
    keyringPath: keyring.path,
    keyring: { keyId: keyring.keyId, publicKeyHex: keyring.publicKeyHex, slot: keyring.slot },
    keyringEntries: config.keyring,
    activeKey: keyring,
    ...(retiredKey === undefined ? {} : { retiredKey }),
    auditPath,
    request,
    readAudit: async () => {
      const raw = await readAuditRaw()
      return raw
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as AuditRecord)
    },
    readAuditRaw,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** The expected audit actor for a token: first 12 hex of its SHA-256. */
export function actorOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12)
}

/** A syntactically complete (but throwaway) PEM block for redaction tests. */
export const FAKE_PRIVATE_KEY_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MC4CAQAwBQYDK2VwBCIEIB0dummy0dummy0dummy0dummy0dummy0dummy0dummy',
  '-----END PRIVATE KEY-----',
].join('\n')
