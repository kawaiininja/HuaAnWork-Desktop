/**
 * Test helper of the offline administrator CLI.
 *
 * Owned by this workspace (the server's `tests/helpers.ts` is only a reference):
 *
 *   - boots the REAL catalog server in-process on an ephemeral loopback port
 *     against a throwaway root (`entries/`, `data/`, generated keyring),
 *   - generates an EPHEMERAL Ed25519 keypair and writes its PKCS#8 private key
 *     to a 0600 file that only `--private-key` ever reads,
 *   - spawns the REAL CLI as a child process with a sanitized environment,
 *   - records every invocation and every audit trail so the suite can assert
 *     that no token and no private-key material ever reaches stdout/stderr/logs.
 *
 * No production token, key or fixture is committed: the constants below are
 * obvious test strings and every keypair exists only for one test.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildUnsignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
  type AgentPackageDigest,
  type AgentPackageFile,
  type AgentPackageManifest,
} from '@huaanwork/agent-package-format'
import {
  fingerprintPublicKeyHex,
  generateKeyPair,
  canonicalJson,
  type CatalogKeyringEntry,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'

import { loadAgentCatalogConfig, type AgentCatalogConfig } from '../../agent-catalog-server/src/config.ts'
import {
  createAgentCatalogRuntime,
  createAgentCatalogServer,
  type AgentCatalogRuntime,
} from '../../agent-catalog-server/src/server.ts'
import type { SubmissionDetail } from '../src/client.ts'

export const READ_TOKEN = 'admin-cli-test-read-token-012345678901234567890'
export const PUBLISH_TOKEN = 'admin-cli-test-publish-token-012345678901234567'
export const ADMIN_TOKEN = 'admin-cli-test-admin-token-0123456789012345678901'

/** The real CLI entry point (already a real path: `import.meta.dirname` is one). */
export const CLI_PATH = join(import.meta.dirname, '..', 'src', 'cli.ts')

export interface CliResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Every CLI invocation of this process, in order (leakage assertions). */
const invocations: CliResult[] = []
/** Every audit trail of a closed test catalog (leakage assertions). */
const auditTrails: string[] = []
/** Every generated PEM of this process (leakage assertions). */
const privateKeys: string[] = []

export function cliInvocations(): readonly CliResult[] {
  return invocations
}

export function collectedAuditTrails(): readonly string[] {
  return auditTrails
}

export function collectedPrivateKeys(): readonly string[] {
  return privateKeys
}

/**
 * Run the CLI as a child process.
 *
 * The child environment inherits the host but drops every `AGENT_CATALOG_*`
 * variable, so a developer's real token can never leak into a test run. The
 * spawn is ASYNCHRONOUS on purpose: the catalog and persona servers live in
 * this process, and a synchronous wait would block their event loop (every
 * request would time out).
 */
export function runCli(
  args: readonly string[],
  envOverrides: Record<string, string> = {},
  options: { readonly cwd?: string; readonly entry?: string } = {},
): Promise<CliResult> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AGENT_CATALOG_')) continue
    env[key] = value
  }
  Object.assign(env, envOverrides)

  // `entry` lets a test launch a symlink/hardlink to the CLI instead of the
  // real path — the shape a wrapper or a `bin` link produces.
  const entry = options.entry ?? CLI_PATH

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', entry, ...args],
      {
        env,
        cwd: options.cwd ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 60_000)
    child.on('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      const record: CliResult = { status, stdout, stderr }
      invocations.push(record)
      resolve(record)
    })
  })
}

export type TestBody = Buffer | string | Record<string, unknown>

export interface TestRequestOptions {
  readonly token?: string
  readonly method?: string
  readonly body?: TestBody
  readonly headers?: Record<string, string>
}

export interface TestResponse<T = unknown> {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: T
  readonly buffer: Buffer
}

export interface TestCatalogOptions {
  /** Legacy M-A0 entries written into `entries/<name>.json` before boot. */
  readonly entries?: ReadonlyArray<Record<string, unknown>>
}

export interface TestCatalog {
  readonly root: string
  readonly baseUrl: string
  readonly dataDir: string
  readonly entriesDir: string
  readonly keyPair: GeneratedKeyPair
  readonly privateKeyPath: string
  readonly keyring: CatalogKeyringEntry
  readonly config: AgentCatalogConfig
  readonly runtime: AgentCatalogRuntime
  request: <T = unknown>(path: string, options?: TestRequestOptions) => Promise<TestResponse<T>>
  readAuditRaw: () => Promise<string>
  readAudit: () => Promise<Array<Record<string, unknown>>>
  close: () => Promise<void>
}

export async function bootTestCatalog(options: TestCatalogOptions = {}): Promise<TestCatalog> {
  const root = await mkdtemp(join(tmpdir(), 'agent-catalog-admin-'))
  const entriesDir = join(root, 'entries')
  const dataDir = join(root, 'data')
  await mkdir(entriesDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  for (const [index, entry] of (options.entries ?? []).entries()) {
    const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : `entry-${String(index)}`
    await writeFile(join(entriesDir, `${name}.json`), `${JSON.stringify(entry, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  const keyPair = generateKeyPair()
  privateKeys.push(keyPair.privateKeyPem)
  const keyId = fingerprintPublicKeyHex(keyPair.publicKeyHex)
  const keyringPath = join(root, 'keyring.json')
  await writeFile(
    keyringPath,
    `${JSON.stringify(
      { schemaVersion: 1, keys: [{ keyId, publicKeyHex: keyPair.publicKeyHex, slot: 1 }] },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  const privateKeyPath = join(root, 'signing-key.pem')
  await writeFile(privateKeyPath, keyPair.privateKeyPem, { mode: 0o600 })

  // Exercise the real env parsing, then pin the listener to an ephemeral port.
  const config: AgentCatalogConfig = {
    ...loadAgentCatalogConfig({
      HOST: '127.0.0.1',
      PORT: '18080',
      AGENT_CATALOG_ENTRIES_DIR: entriesDir,
      AGENT_CATALOG_DATA_DIR: dataDir,
      AGENT_CATALOG_TOKEN: READ_TOKEN,
      AGENT_CATALOG_PUBLISH_TOKEN: PUBLISH_TOKEN,
      AGENT_CATALOG_ADMIN_TOKEN: ADMIN_TOKEN,
      AGENT_CATALOG_KEYRING_PATH: keyringPath,
    }),
    port: 0,
  }
  const runtime = await createAgentCatalogRuntime(config)
  const server = createAgentCatalogServer(config, runtime)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(address.port)}`
  const auditPath = join(dataDir, 'audit.jsonl')

  const request = <T = unknown>(
    path: string,
    requestOptions: TestRequestOptions = {},
  ): Promise<TestResponse<T>> =>
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
        (response) => {
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
    root,
    baseUrl,
    dataDir,
    entriesDir,
    keyPair,
    privateKeyPath,
    keyring: { keyId, publicKeyHex: keyPair.publicKeyHex, slot: 1 },
    config,
    runtime,
    request,
    readAuditRaw,
    readAudit: async () =>
      (await readAuditRaw())
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      auditTrails.push(await readAuditRaw())
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** The complete CLI environment of one test catalog. */
export function adminEnv(catalog: TestCatalog): Record<string, string> {
  return {
    AGENT_CATALOG_URL: catalog.baseUrl,
    AGENT_CATALOG_ADMIN_TOKEN: ADMIN_TOKEN,
    AGENT_CATALOG_TOKEN: READ_TOKEN,
    AGENT_CATALOG_PUBLISH_TOKEN: PUBLISH_TOKEN,
  }
}

export function testManifest(
  overrides: Partial<AgentPackageManifest> = {},
): AgentPackageManifest {
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

export interface SubmitTestPackageOptions {
  readonly slug?: string
  readonly version?: string
  readonly persona?: string
  readonly description?: string
  readonly displayName?: string
  readonly extraFiles?: readonly AgentPackageFile[]
  readonly token?: string
}

export interface SubmittedTestPackage {
  readonly submission: SubmissionDetail
  readonly manifest: AgentPackageManifest
  readonly digest: AgentPackageDigest
  readonly bundle: Buffer
}

/** Build a legal unsigned bundle and submit it through the REAL publish route. */
export async function submitTestPackage(
  catalog: TestCatalog,
  options: SubmitTestPackageOptions = {},
): Promise<SubmittedTestPackage> {
  const manifest = testManifest({
    ...(options.slug === undefined ? {} : { slug: options.slug }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
  })
  const files: AgentPackageFile[] = [
    { path: 'agent.json', data: Buffer.from(JSON.stringify(manifest)) },
    { path: 'persona.md', data: Buffer.from(options.persona ?? '你是周报助手') },
    ...(options.extraFiles ?? []),
  ]
  const bundle = await buildUnsignedAgentPackageBundle(files)
  const inspected = await inspectUnsignedAgentPackageBundle(bundle)
  const response = await catalog.request('/v1/agent-packages/submissions', {
    method: 'POST',
    token: options.token ?? PUBLISH_TOKEN,
    body: bundle,
    headers: { 'content-type': 'application/gzip' },
  })
  if (response.status !== 201) {
    throw new Error(
      `submitTestPackage: unexpected ${String(response.status)} ${response.buffer.toString('utf8')}`,
    )
  }
  return {
    submission: response.body as SubmissionDetail,
    manifest,
    digest: inspected.digest,
    bundle,
  }
}

/** sha256 of the canonical digest — mirrors the CLI receipt contract. */
export function receiptDigestSha256(digest: unknown): string {
  return createHash('sha256').update(canonicalJson(digest), 'utf8').digest('hex')
}

/** A throwaway HTTP server used for persona payloads and tampered digests. */
export interface StubRequestRecord {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
}

export interface StubServer {
  readonly baseUrl: string
  readonly requests: StubRequestRecord[]
  close: () => Promise<void>
}

export type StubHandler = (
  request: StubRequestRecord,
) => { readonly status?: number; readonly contentType?: string; readonly body: string } | undefined

export async function startStubServer(handler: StubHandler): Promise<StubServer> {
  const requests: StubRequestRecord[] = []
  const server = createServer((incoming, response) => {
    const record: StubRequestRecord = {
      method: incoming.method ?? 'GET',
      path: incoming.url ?? '/',
      authorization: typeof incoming.headers.authorization === 'string'
        ? incoming.headers.authorization
        : undefined,
    }
    requests.push(record)
    const result = handler(record)
    if (result === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    response.writeHead(result.status ?? 200, {
      'content-type': result.contentType ?? 'application/json',
    })
    response.end(result.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
