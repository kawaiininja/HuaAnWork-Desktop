/**
 * agent-catalog-server configuration (Task 4).
 *
 * All values are env-injected; there are NO config files, and there is
 * deliberately NO private-key configuration item anywhere: the Ed25519 private
 * key lives only on the offline signing machine. Startup reads and validates
 * the PUBLIC keyring and never touches a private-key path.
 *
 * Fail-closed: a missing/blank path, a missing/short/duplicated token, or an
 * unreadable/invalid keyring throws `AgentCatalogConfigError` whose message is
 * operator guidance (printed by src/index.ts before exit 1). Error messages
 * never echo a configured token value.
 *
 *   HOST                        listen address (default 127.0.0.1)
 *   PORT                        listen port (default 18080)
 *   AGENT_CATALOG_ENTRIES_DIR   directory of legacy M-A0 `*.json` entries
 *                               (read per request; a missing dir serves [])
 *   AGENT_CATALOG_DATA_DIR      directory of state.json / audit.jsonl
 *   AGENT_CATALOG_TOKEN         READ token (browse/download/revocations)
 *   AGENT_CATALOG_PUBLISH_TOKEN PUBLISH token (submit, own submissions,
 *                               delist requests)
 *   AGENT_CATALOG_ADMIN_TOKEN   ADMIN token (review/approve/reject/delist/
 *                               revoke)
 *   AGENT_CATALOG_KEYRING_PATH  path to the PUBLIC keyring document
 *                               `{ schemaVersion: 1, keys: [...] }`; validated
 *                               by @huaanwork/catalog-signing
 *
 * The three tokens must be pairwise distinct and at least 32 characters long.
 * Distinct roles are the whole point of the split: a leaked read token must
 * never be able to publish, and a leaked publish token must never approve.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CatalogKeyringError,
  parseCatalogKeyring,
  type CatalogKeyringEntry,
} from '@huaanwork/catalog-signing'

export const AGENT_CATALOG_ENV = {
  host: 'HOST',
  port: 'PORT',
  entriesDir: 'AGENT_CATALOG_ENTRIES_DIR',
  dataDir: 'AGENT_CATALOG_DATA_DIR',
  readToken: 'AGENT_CATALOG_TOKEN',
  publishToken: 'AGENT_CATALOG_PUBLISH_TOKEN',
  adminToken: 'AGENT_CATALOG_ADMIN_TOKEN',
  keyringPath: 'AGENT_CATALOG_KEYRING_PATH',
} as const

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 18_080

/** Minimum token length. Anything shorter is refused at startup. */
export const MIN_TOKEN_LENGTH = 32

export interface AgentCatalogConfig {
  readonly host: string
  readonly port: number
  readonly entriesDir: string
  readonly dataDir: string
  readonly readToken: string
  readonly publishToken: string
  readonly adminToken: string
  readonly keyringPath: string
  /** Validated public keyring; the trust root for package signatures. */
  readonly keyring: readonly CatalogKeyringEntry[]
}

export class AgentCatalogConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentCatalogConfigError'
  }
}

const GUIDANCE = `agent-catalog-server requires these environment variables:

  ${AGENT_CATALOG_ENV.entriesDir}
      directory of legacy M-A0 catalog entries (*.json). Read on every
      request; a missing directory simply serves an empty list.
  ${AGENT_CATALOG_ENV.dataDir}
      directory holding state.json and audit.jsonl (created if missing).
  ${AGENT_CATALOG_ENV.readToken}
      READ token: GET /v1/catalog*, published-package listing/metadata/bundle,
      GET /v1/agent-packages/revocations. At least ${String(MIN_TOKEN_LENGTH)} characters.
  ${AGENT_CATALOG_ENV.publishToken}
      PUBLISH token: create submissions, read your own submission, request
      delisting. At least ${String(MIN_TOKEN_LENGTH)} characters.
  ${AGENT_CATALOG_ENV.adminToken}
      ADMIN token: pending lists, submission review bundle, approve/reject,
      delist approval, revoke. At least ${String(MIN_TOKEN_LENGTH)} characters.
  ${AGENT_CATALOG_ENV.keyringPath}
      path to the PUBLIC keyring document { schemaVersion: 1, keys: [...] }
      (keyId + raw 32-byte hex Ed25519 public key + slot).

OPTIONAL:

  ${AGENT_CATALOG_ENV.host} (default ${DEFAULT_HOST})
  ${AGENT_CATALOG_ENV.port} (default ${String(DEFAULT_PORT)})

The three tokens must be pairwise DISTINCT. There is deliberately no
private-key configuration item: package signatures are produced offline and
this server only ever holds public verification keys.`

function fail(reason: string): never {
  throw new AgentCatalogConfigError(`${reason}\n\n${GUIDANCE}`)
}

function parseHost(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOST
  return raw.trim()
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const value = raw.trim()
  if (!/^\d+$/u.test(value)) {
    fail(`${AGENT_CATALOG_ENV.port} must be an integer, got ${JSON.stringify(raw)}.`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(`${AGENT_CATALOG_ENV.port} must be within 1..65535, got ${port}.`)
  }
  return port
}

/**
 * Required directory: missing/blank refuses startup. Relative paths are
 * resolved against the working directory so the stored config is absolute and
 * never depends on a later `process.chdir`.
 */
function parseDirectory(raw: string | undefined, key: string): string {
  if (raw === undefined || raw.trim() === '') fail(`${key} is missing.`)
  return resolve(raw.trim())
}

function parseToken(raw: string | undefined, key: string): string {
  if (raw === undefined || raw.trim() === '') fail(`${key} is missing.`)
  const token = raw.trim()
  if (token.length < MIN_TOKEN_LENGTH) {
    fail(`${key} must be at least ${String(MIN_TOKEN_LENGTH)} characters long.`)
  }
  return token
}

function parseKeyring(raw: string | undefined): { path: string; entries: readonly CatalogKeyringEntry[] } {
  if (raw === undefined || raw.trim() === '') fail(`${AGENT_CATALOG_ENV.keyringPath} is missing.`)
  const path = resolve(raw.trim())
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (cause) {
    fail(
      `${AGENT_CATALOG_ENV.keyringPath} does not point to a readable keyring file: ` +
        `${(cause as Error).message}`,
    )
  }
  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch (cause) {
    fail(`${AGENT_CATALOG_ENV.keyringPath} is not valid JSON: ${(cause as Error).message}`)
  }
  try {
    return { path, entries: parseCatalogKeyring(document) }
  } catch (cause) {
    if (cause instanceof CatalogKeyringError) {
      fail(`${AGENT_CATALOG_ENV.keyringPath} is not a valid catalog keyring: ${cause.message}`)
    }
    throw cause
  }
}

/**
 * Build the config from the environment (fail-closed).
 *
 * @param env - process environment (defaults to `process.env`); tests pass a
 *   synthetic object so the real environment is never mutated.
 */
export function loadAgentCatalogConfig(env: NodeJS.ProcessEnv = process.env): AgentCatalogConfig {
  const entriesDir = parseDirectory(env[AGENT_CATALOG_ENV.entriesDir], AGENT_CATALOG_ENV.entriesDir)
  const dataDir = parseDirectory(env[AGENT_CATALOG_ENV.dataDir], AGENT_CATALOG_ENV.dataDir)
  const readToken = parseToken(env[AGENT_CATALOG_ENV.readToken], AGENT_CATALOG_ENV.readToken)
  const publishToken = parseToken(env[AGENT_CATALOG_ENV.publishToken], AGENT_CATALOG_ENV.publishToken)
  const adminToken = parseToken(env[AGENT_CATALOG_ENV.adminToken], AGENT_CATALOG_ENV.adminToken)

  if (readToken === publishToken || readToken === adminToken || publishToken === adminToken) {
    // Never echo the values: the message names the variables only.
    fail(
      `${AGENT_CATALOG_ENV.readToken}, ${AGENT_CATALOG_ENV.publishToken} and ` +
        `${AGENT_CATALOG_ENV.adminToken} must be pairwise distinct.`,
    )
  }

  const keyring = parseKeyring(env[AGENT_CATALOG_ENV.keyringPath])

  return {
    host: parseHost(env[AGENT_CATALOG_ENV.host]),
    port: parsePort(env[AGENT_CATALOG_ENV.port]),
    entriesDir,
    dataDir,
    readToken,
    publishToken,
    adminToken,
    keyringPath: keyring.path,
    keyring: keyring.entries,
  }
}
