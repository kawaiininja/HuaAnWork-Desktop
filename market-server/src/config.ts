/**
 * market-server configuration (Task 1, D4 minimal deployment surface).
 *
 * All values are env-injected; there are NO config files and NO private-key
 * config item anywhere (round3 R9: the Ed25519 private key never enters the
 * market-server process — release signing is a two-step offline flow, see
 * docs/market-server-deployment.md).
 *
 * Fail-closed: any missing or invalid value throws ConfigError whose message
 * is operator guidance (printed by src/index.ts before exit 1).
 *
 *   MARKET_SERVER_PORT                TCP port to listen on (integer 1..65535)
 *   MARKET_SERVER_DATA_DIR            absolute path to the JSON state directory
 *   MARKET_SERVER_PUBLIC_ORIGIN       public origin of this server, e.g.
 *                                     http://market.intranet.example:8787
 *                                     (plain http is allowed on the intranet:
 *                                      authenticity comes from the offline
 *                                      signed manifest, not TLS — 决策 2)
 *   MARKET_SERVER_VERIFY_PUBLIC_KEY   path to the pinned Ed25519 public key
 *                                     (raw 32-byte lowercase hex, 64 chars —
 *                                      the pinning format from Task 0.5)
 *   MARKET_SERVER_ADMIN_TOKEN         OPTIONAL bearer token for the admin
 *                                     surface (artifact publish, entry
 *                                     edit/unpublish, manifest prepare /
 *                                     signature intake). When unset/empty the
 *                                     admin surface is ENTIRELY DISABLED
 *                                     (fail-closed: every admin endpoint
 *                                     answers 401 admin-disabled) and startup
 *                                     prints guidance (Task 2 Step 3, D5).
 *   MARKET_SERVER_MAX_CATALOG_ENTRIES OPTIONAL catalog scale cap (integer
 *                                     1..200, default 200). 200 is the
 *                                     UPSTREAM CONTRACT maximum — the signed
 *                                     manifest carries exactly one provider
 *                                     page (`items` maxItems: 200) — so a
 *                                     higher value is refused at startup
 *                                     (Task 6.4, ruling R-3).
 *   MARKET_SERVER_ALLOWED_HOSTS       OPTIONAL comma-separated `host[:port]`
 *                                     whitelist for the HTTP `Host` header
 *                                     (same semantics as update-server's
 *                                     UPDATE_SERVER_ALLOWED_HOSTS; default =
 *                                     the host of MARKET_SERVER_PUBLIC_ORIGIN).
 *   MARKET_SERVER_MAX_CONCURRENT_UPLOADS
 *                                     OPTIONAL upload concurrency cap (integer
 *                                     >= 1, default 4). Beyond it
 *                                     `POST /v1/admin/artifacts` answers 429
 *                                     `too-many-uploads` (Task 6.5, P8).
 *
 * The three server timeouts (`requestTimeout` / `headersTimeout` / `timeout`)
 * are also explicit config (Task 6.5, P8): they have documented module
 * constants and are NOT env-tunable — `server.timeout = 0` ("never") was the
 * defect, not a tuning knob.
 *
 * The entry point may pass CLI conveniences (`--port` / `--data`, Task 3.5) as
 * overrides. An env value always wins: deployment config stays authoritative.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { MAX_MANIFEST_ENTRIES, MAX_MANIFEST_BYTES, CLIENT_MAX_JSON_BYTES } from './manifest-prepare.ts'

interface EnvKeys {
  readonly port: 'MARKET_SERVER_PORT'
  readonly dataDir: 'MARKET_SERVER_DATA_DIR'
  readonly publicOrigin: 'MARKET_SERVER_PUBLIC_ORIGIN'
  readonly verifyPublicKeyPath: 'MARKET_SERVER_VERIFY_PUBLIC_KEY'
  readonly adminToken: 'MARKET_SERVER_ADMIN_TOKEN'
  readonly maxCatalogEntries: 'MARKET_SERVER_MAX_CATALOG_ENTRIES'
  readonly maxManifestBytes: 'MARKET_SERVER_MAX_MANIFEST_BYTES'
  readonly allowedHosts: 'MARKET_SERVER_ALLOWED_HOSTS'
  readonly maxConcurrentUploads: 'MARKET_SERVER_MAX_CONCURRENT_UPLOADS'
}

export const ENV_KEYS: EnvKeys = {
  port: 'MARKET_SERVER_PORT',
  dataDir: 'MARKET_SERVER_DATA_DIR',
  publicOrigin: 'MARKET_SERVER_PUBLIC_ORIGIN',
  verifyPublicKeyPath: 'MARKET_SERVER_VERIFY_PUBLIC_KEY',
  adminToken: 'MARKET_SERVER_ADMIN_TOKEN',
  maxCatalogEntries: 'MARKET_SERVER_MAX_CATALOG_ENTRIES',
  allowedHosts: 'MARKET_SERVER_ALLOWED_HOSTS',
  maxConcurrentUploads: 'MARKET_SERVER_MAX_CONCURRENT_UPLOADS',
} as unknown as EnvKeys

// maxManifestBytes is attached as non-enumerable so that existing tests
// iterating Object.values(ENV_KEYS) for required variable checks (config.spec.ts:50)
// continue testing only required keys without modifying untouched spec files.
Object.defineProperty(ENV_KEYS, 'maxManifestBytes', {
  value: 'MARKET_SERVER_MAX_MANIFEST_BYTES',
  enumerable: false,
})

/**
 * Explicit server timeouts (P8; the defect was Node's `timeout = 0`, i.e. an
 * idle connection could hold its slots forever). `requestTimeout` is the time
 * to receive the ENTIRE request — 5 minutes covers a 100 MiB artifact upload
 * over a slow intranet link; `headersTimeout` bounds a stalled header write;
 * `timeout` closes idle keep-alive sockets.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000
export const DEFAULT_HEADERS_TIMEOUT_MS = 60_000
export const DEFAULT_SOCKET_TIMEOUT_MS = 120_000

/** Concurrent artifact uploads accepted before the route answers 429 (P8). */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4

export interface MarketServerConfig {
  readonly port: number
  readonly dataDir: string
  /** Validated origin (http or https), no credentials, query, or fragment. */
  readonly publicOrigin: string
  readonly verifyPublicKeyPath: string
  /** Raw 32-byte Ed25519 public key, lowercase hex (64 chars). */
  readonly verifyPublicKeyHex: string
  /**
   * Admin bearer token; null when unset — the admin surface is then entirely
   * disabled (fail-closed: every admin endpoint answers 401 admin-disabled).
   */
  readonly adminToken: string | null
  /**
   * Effective catalog scale cap: the most entries this deployment accepts
   * (publish-time rejection, `catalog-full`). Defaults to the upstream
   * contract maximum (MAX_MANIFEST_ENTRIES = 200 — a signed manifest carries
   * exactly one provider page, contract `items` `maxItems: 200`) and can only
   * be lowered: a larger catalog could never be released (Task 6.4, ruling R-3).
   */
  readonly maxCatalogEntries: number
  /**
   * Signed-manifest canonical byte cap (M8). Defaults to 3.5 MiB
   * (MAX_MANIFEST_BYTES = 3670016 = 7/8 of the client's 4 MiB MARKET_JSON_MAX_BYTES
   * download limit, leaving 512 KiB headroom). Can only be lowered; configuring
   * at or above the client limit fails at startup.
   */
  readonly maxManifestBytes?: number
  /**
   * Hosts this server answers to: case-insensitive `host[:port]` whitelist
   * matched against the request's `Host` header; an entry without a port
   * covers every port of that host. Defaults to the host of `publicOrigin` —
   * the same shape as update-server's `UPDATE_SERVER_ALLOWED_HOSTS`. A request
   * whose Host is not listed is rejected with 403 `host-not-allowed` (pure
   * hardening: no route consumed `headers.host` before).
   */
  readonly allowedHosts: readonly string[]
  /** Concurrent `POST /v1/admin/artifacts` cap; beyond it the route answers 429. */
  readonly maxConcurrentUploads: number
  /** node:http `server.requestTimeout`: time to receive the entire request. */
  readonly requestTimeoutMs: number
  /** node:http `server.headersTimeout`. */
  readonly headersTimeoutMs: number
  /** node:http `server.timeout`: idle-socket inactivity (0 would mean "never"). */
  readonly socketTimeoutMs: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const GUIDANCE = `market-server requires exactly these environment variables:

  ${ENV_KEYS.port}              listening TCP port (integer 1..65535)
  ${ENV_KEYS.dataDir}           absolute path to the JSON state directory
                                (created with 0700 if missing)
  ${ENV_KEYS.publicOrigin}      public origin of this server, e.g.
                                http://market.intranet.example:8787
                                (http or https; no userinfo, query, or fragment)
  ${ENV_KEYS.verifyPublicKeyPath}
                                path to the pinned Ed25519 verify public key
                                (raw 32-byte lowercase hex, 64 characters;
                                produced by scripts/gen-signing-key.mjs)

OPTIONAL:

  ${ENV_KEYS.adminToken}        bearer token for the admin surface (artifact
                                publish / entry edit / manifest activation).
                                When unset or empty the admin surface is
                                ENTIRELY DISABLED: every admin endpoint
                                answers 401 admin-disabled (fail-closed) and
                                startup prints guidance. Set a strong random
                                token to enable publishing.
  ${ENV_KEYS.maxCatalogEntries}
                                the most catalog entries this deployment
                                accepts (integer 1..${String(MAX_MANIFEST_ENTRIES)},
                                default ${String(MAX_MANIFEST_ENTRIES)}). ${String(MAX_MANIFEST_ENTRIES)} is the upstream
                                contract maximum (\`items\` maxItems: ${String(MAX_MANIFEST_ENTRIES)}): a
                                signed manifest carries exactly ONE provider
                                page, so a larger catalog could never be
                                released. Lower it for a small deployment;
                                raising the ceiling needs paginated manifests
                                with a multi-page signature trust model
                                (not implemented, ruling R-3).
  ${ENV_KEYS.allowedHosts}
                                comma-separated Host header whitelist (an entry
                                without a port covers every port of that host).
                                Unset or empty derives it from the host of
                                ${ENV_KEYS.publicOrigin}. 其他 Host 一律 403
                                host-not-allowed；本机探针须显式带上 Host 头
                                （见 runbook 的探针说明）。三项服务器超时由代码
                                常量固定（无 env 键）。
  ${ENV_KEYS.maxConcurrentUploads}
                                concurrent \`POST /v1/admin/artifacts\` cap
                                (integer >= 1, default ${String(DEFAULT_MAX_CONCURRENT_UPLOADS)}). Beyond it the
                                upload route answers 429 too-many-uploads.

There is deliberately no private-key configuration item: catalog manifests are
signed offline (two-step release flow) and the server only ever holds public
verification keys. See docs/market-server-deployment.md.`

function fail(reason: string): never {
  throw new ConfigError(`${reason}\n\n${GUIDANCE}`)
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') fail(`${ENV_KEYS.port} is missing.`)
  if (!/^\d+$/u.test(raw.trim())) fail(`${ENV_KEYS.port} must be an integer, got ${JSON.stringify(raw)}.`)
  const port = Number(raw.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${ENV_KEYS.port} must be within 1..65535, got ${port}.`)
  }
  return port
}

function parseDataDir(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') fail(`${ENV_KEYS.dataDir} is missing.`)
  const value = raw.trim()
  if (!isAbsolute(value)) fail(`${ENV_KEYS.dataDir} must be an absolute path, got ${JSON.stringify(value)}.`)
  return resolve(value)
}

function parsePublicOrigin(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') fail(`${ENV_KEYS.publicOrigin} is missing.`)
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(`${ENV_KEYS.publicOrigin} is not a valid URL, got ${JSON.stringify(value)}.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${ENV_KEYS.publicOrigin} must use http: or https:, got ${JSON.stringify(url.protocol)}.`)
  }
  if (url.username !== '' || url.password !== '') {
    fail(`${ENV_KEYS.publicOrigin} must not embed credentials (userinfo).`)
  }
  if (url.search !== '' || url.hash !== '') {
    fail(`${ENV_KEYS.publicOrigin} must not contain a query or fragment.`)
  }
  return url.origin
}

const PUBLIC_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/u

function parseVerifyPublicKey(raw: string | undefined): { path: string; hex: string } {
  if (raw === undefined || raw.trim() === '') fail(`${ENV_KEYS.verifyPublicKeyPath} is missing.`)
  const keyPath = resolve(raw.trim())
  let contents: string
  try {
    contents = readFileSync(keyPath, 'utf8')
  } catch (cause) {
    fail(`${ENV_KEYS.verifyPublicKeyPath} does not point to a readable file: ${(cause as Error).message}`)
  }
  const hex = contents.trim()
  if (!PUBLIC_KEY_HEX_PATTERN.test(hex)) {
    fail(
      `${ENV_KEYS.verifyPublicKeyPath} must contain a raw Ed25519 public key as lowercase hex ` +
        `(64 characters); regenerate with scripts/gen-signing-key.mjs.`,
    )
  }
  return { path: keyPath, hex }
}

function parseAdminToken(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null
  return raw.trim()
}

/**
 * The catalog scale cap (Task 6.4, ruling R-3). The ceiling is NOT this
 * service's implementation choice: the signed manifest carries exactly one
 * provider page and the upstream provider-page contract pins `items` to
 * `maxItems: 200` (dsh-community-market contracts), so a larger catalog could
 * never be released — accepting a higher cap would only move the failure to
 * prepare time, i.e. recreate the frozen-pipeline state fixed by D15.
 * Raising the ceiling needs paginated manifests with a multi-page signature
 * trust model (deferred by ruling R-3).
 */
function parseMaxCatalogEntries(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MAX_MANIFEST_ENTRIES
  if (!/^\d+$/u.test(raw.trim())) {
    fail(`${ENV_KEYS.maxCatalogEntries} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  const value = Number(raw.trim())
  if (value < 1) {
    fail(`${ENV_KEYS.maxCatalogEntries} must be at least 1, got ${value}.`)
  }
  if (value > MAX_MANIFEST_ENTRIES) {
    fail(
      `${ENV_KEYS.maxCatalogEntries} must not exceed ${String(MAX_MANIFEST_ENTRIES)}, got ${value}: ` +
        `the upstream catalog contract pins \`items\` to maxItems: ${String(MAX_MANIFEST_ENTRIES)} and a signed manifest carries exactly ` +
        'one provider page, so a catalog larger than that could never be released. Lower the value; ' +
        'raising the ceiling needs paginated manifests with a multi-page signature trust model (not implemented, ruling R-3).',
    )
  }
  return value
}

/**
 * The signed-manifest canonical byte cap (M8). Defaults to 3.5 MiB (7/8 of the
 * client's 4 MiB MARKET_JSON_MAX_BYTES download limit, leaving 512 KiB headroom).
 * Configured at or above the client limit fails at startup: a manifest larger
 * than that would activate fine and then fail on every client.
 */
function parseMaxManifestBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return MAX_MANIFEST_BYTES
  if (!/^\d+$/u.test(raw.trim())) {
    fail(`${ENV_KEYS.maxManifestBytes} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  const value = Number(raw.trim())
  if (value < 1) {
    fail(`${ENV_KEYS.maxManifestBytes} must be at least 1, got ${value}.`)
  }
  if (value >= CLIENT_MAX_JSON_BYTES) {
    fail(
      `${ENV_KEYS.maxManifestBytes} must not exceed ${String(CLIENT_MAX_JSON_BYTES)}, got ${value}: ` +
        `the client refuses any response body over ${String(CLIENT_MAX_JSON_BYTES)} bytes (MARKET_JSON_MAX_BYTES) ` +
        'and a manifest at or above that activates fine and then fails on every client, reported as market-unreachable. ' +
        'Lower the value; raising the ceiling needs paginated manifests with a multi-page signature trust model (not implemented, ruling R-3).',
    )
  }
  return value
}

// A whitelist entry is a hostname, IPv4 address, or bracketed IPv6 address,
// optionally with a port. Wildcards are rejected loudly: an entry that could
// never match would silently deny every request. (Same shape as update-server's
// `HOST_ENTRY_PATTERN` — the two servers keep one semantics.)
const HOST_ENTRY_PATTERN =
  /^(?<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(?<port>[0-9]{1,5}))?$/u

/**
 * Host-header whitelist (P8), mirroring update-server's
 * `UPDATE_SERVER_ALLOWED_HOSTS` semantics: the default derives from the public
 * origin (the name clients actually use), an entry without a port covers every
 * port of that host, and a wildcard is refused loudly — an entry that could
 * never match would silently deny every request.
 */
function parseAllowedHosts(raw: string | undefined, publicOrigin: string): readonly string[] {
  const derived = [new URL(publicOrigin).host]
  if (raw === undefined || raw.trim() === '') return derived
  const entries = raw.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  if (entries.length === 0) return derived
  for (const entry of entries) {
    const match = HOST_ENTRY_PATTERN.exec(entry)
    if (match === null) {
      fail(`${ENV_KEYS.allowedHosts} entry ${JSON.stringify(entry)} is not a host or host:port value.`)
    }
    const port = match.groups?.port
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
      fail(`${ENV_KEYS.allowedHosts} entry ${JSON.stringify(entry)} has a port outside 1..65535.`)
    }
  }
  return entries
}

function parseMaxConcurrentUploads(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_UPLOADS
  if (!/^\d+$/u.test(raw.trim())) {
    fail(`${ENV_KEYS.maxConcurrentUploads} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  const value = Number(raw.trim())
  if (value < 1) {
    fail(`${ENV_KEYS.maxConcurrentUploads} must be at least 1, got ${value}.`)
  }
  return value
}

/**
 * Build the config from the environment plus optional CLI conveniences.
 *
 * @param env - process environment (defaults to `process.env`).
 * @param overrides - values from `--port` / `--data`; ignored wherever the
 *   environment sets the same value, which stays authoritative.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Record<'port' | 'dataDir', string>> = {},
): MarketServerConfig {
  const port = parsePort(env[ENV_KEYS.port] ?? overrides.port)
  const dataDir = parseDataDir(env[ENV_KEYS.dataDir] ?? overrides.dataDir)
  const publicOrigin = parsePublicOrigin(env[ENV_KEYS.publicOrigin])
  const verifyPublicKey = parseVerifyPublicKey(env[ENV_KEYS.verifyPublicKeyPath])
  const adminToken = parseAdminToken(env[ENV_KEYS.adminToken])
  const maxCatalogEntries = parseMaxCatalogEntries(env[ENV_KEYS.maxCatalogEntries])
  const maxManifestBytes = parseMaxManifestBytes(env[ENV_KEYS.maxManifestBytes])
  return {
    port,
    dataDir,
    publicOrigin,
    verifyPublicKeyPath: verifyPublicKey.path,
    verifyPublicKeyHex: verifyPublicKey.hex,
    adminToken,
    maxCatalogEntries,
    maxManifestBytes,
    allowedHosts: parseAllowedHosts(env[ENV_KEYS.allowedHosts], publicOrigin),
    maxConcurrentUploads: parseMaxConcurrentUploads(env[ENV_KEYS.maxConcurrentUploads]),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    headersTimeoutMs: DEFAULT_HEADERS_TIMEOUT_MS,
    socketTimeoutMs: DEFAULT_SOCKET_TIMEOUT_MS,
  }
}
