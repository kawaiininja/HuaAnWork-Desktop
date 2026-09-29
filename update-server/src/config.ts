/**
 * update-server configuration (Task 3.1).
 *
 * All values are env-injected; there are NO config files. This is the read-only
 * intranet update server: it deliberately has NO admin token and NO upload
 * settings of any kind (2026-09-28 revision - the write path was removed and
 * task 3.4 is void). Releases are published out of band on the deploy host with
 * scripts/publish-release.mjs (Task 3.3); the server only ever reads
 * `<dataDir>/channels/<channel>.json`.
 *
 * Fail-closed: any missing or invalid value throws UpdateServerConfigError
 * whose message is operator guidance.
 *
 *   UPDATE_SERVER_PORT                REQUIRED. TCP port to listen on
 *                                     (integer 1..65535)
 *   UPDATE_SERVER_DATA_DIR            REQUIRED. absolute path to the release
 *                                     data directory (populated by the deploy
 *                                     host; the server never creates or writes
 *                                     it)
 *   UPDATE_SERVER_PUBLIC_ORIGIN       REQUIRED. public origin of this server,
 *                                     e.g. http://update.intranet.lan:8790
 *                                     (plain http is allowed on the intranet:
 *                                      artifact integrity is pinned by the
 *                                      client-side sha256, not TLS)
 *
 * OPTIONAL:
 *
 *   UPDATE_SERVER_ALLOWED_HOSTS       comma-separated Host header whitelist.
 *                                     Unset or empty derives it from the host of
 *                                     UPDATE_SERVER_PUBLIC_ORIGIN. An entry
 *                                     without a port covers every port of that
 *                                     host.
 *   UPDATE_SERVER_REQUEST_TIMEOUT_MS  HTTP request, header, and socket
 *                                     inactivity timeout in milliseconds
 *                                     (integer > 0; default 30000). Never 0 -
 *                                     an unbounded socket timeout is the
 *                                     market-server P8 defect form.
 *   UPDATE_SERVER_LISTEN_HOST         listen address (default 0.0.0.0: intranet
 *                                     deployments must be reachable from the
 *                                     fleet). This server has no accounts, so it
 *                                     must be deployed on a controlled intranet
 *                                     segment (runbook: Task 3.5).
 *
 * There is deliberately no UPDATE_SERVER_ADMIN_TOKEN: a read-only server has no
 * admin face, and keeping a token env for a future one would only preserve a
 * dead 401 surface (YAGNI).
 *
 * The entry point may pass CLI conveniences (`--port` / `--data`, Task 3.5) as
 * overrides. An env value always wins: deployment config stays authoritative.
 */

import { isAbsolute, resolve } from 'node:path'

export const ENV_KEYS = {
  port: 'UPDATE_SERVER_PORT',
  dataDir: 'UPDATE_SERVER_DATA_DIR',
  publicOrigin: 'UPDATE_SERVER_PUBLIC_ORIGIN',
  allowedHosts: 'UPDATE_SERVER_ALLOWED_HOSTS',
  requestTimeoutMs: 'UPDATE_SERVER_REQUEST_TIMEOUT_MS',
  listenHost: 'UPDATE_SERVER_LISTEN_HOST',
} as const

export interface UpdateServerConfig {
  readonly port: number
  readonly dataDir: string
  /** Validated origin (http or https), no credentials, path, query, or fragment. */
  readonly publicOrigin: string
  /** Listen address; `0.0.0.0` unless UPDATE_SERVER_LISTEN_HOST overrides it. */
  readonly listenHost: string
  /** requestTimeout / headersTimeout / socket inactivity timeout, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Host header whitelist (case-insensitive); defaults to publicOrigin's host. */
  readonly allowedHosts: readonly string[]
}

export class UpdateServerConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'UpdateServerConfigError'
    this.code = code
  }
}

const GUIDANCE = `update-server requires exactly these environment variables:

  ${ENV_KEYS.port}              listening TCP port (integer 1..65535)
  ${ENV_KEYS.dataDir}           absolute path to the release data directory
                                (populated by the deploy host; the server only
                                reads <dataDir>/channels/<channel>.json)
  ${ENV_KEYS.publicOrigin}      public origin of this server, e.g.
                                http://update.intranet.lan:8790
                                (http or https; no userinfo, path, query, or
                                fragment)

OPTIONAL:

  ${ENV_KEYS.allowedHosts}      comma-separated Host header whitelist. When unset
                                or empty it is derived from the host of
                                ${ENV_KEYS.publicOrigin}.
  ${ENV_KEYS.requestTimeoutMs}  request/headers/socket timeout in milliseconds
                                (integer > 0, default 30000).
  ${ENV_KEYS.listenHost}        listen address (default 0.0.0.0).

This server is READ-ONLY and exposes no admin surface, so no admin token is
configured here. Releases are published out of band on the deploy host with
scripts/publish-release.mjs.`

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_LISTEN_HOST = '0.0.0.0'

function fail(code: string, reason: string): never {
  throw new UpdateServerConfigError(code, `${reason}\n\n${GUIDANCE}`)
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') fail('missing-env', `${ENV_KEYS.port} is missing: the listen port is required.`)
  const value = raw.trim()
  if (!/^\d+$/u.test(value)) {
    fail('invalid-port', `${ENV_KEYS.port} must be an integer port, got ${JSON.stringify(raw)}.`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('invalid-port', `${ENV_KEYS.port} must be a port within 1..65535, got ${port}.`)
  }
  return port
}

function parseDataDir(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    fail('missing-env', `${ENV_KEYS.dataDir} is missing: the data directory is required.`)
  }
  const value = raw.trim()
  if (!isAbsolute(value)) fail('invalid-data-dir', `${ENV_KEYS.dataDir} must be an absolute path, got ${JSON.stringify(value)}.`)
  return resolve(value)
}

function parsePublicOrigin(raw: string | undefined): URL {
  if (raw === undefined || raw.trim() === '') {
    fail('missing-env', `${ENV_KEYS.publicOrigin} is missing: the public origin is required.`)
  }
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('invalid-public-origin', `${ENV_KEYS.publicOrigin} is not a valid absolute origin, got ${JSON.stringify(value)}.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('invalid-public-origin', `${ENV_KEYS.publicOrigin} must use http: or https: as its origin protocol, got ${JSON.stringify(url.protocol)}.`)
  }
  if (url.username !== '' || url.password !== '') {
    fail('invalid-public-origin', `${ENV_KEYS.publicOrigin} must not embed credentials (userinfo) in the origin.`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    fail('invalid-public-origin', `${ENV_KEYS.publicOrigin} must be a bare origin: no path, query, or fragment.`)
  }
  return url
}

// A whitelist entry is a hostname, IPv4 address, or bracketed IPv6 address,
// optionally with a port. Wildcards are rejected loudly: an entry that could
// never match would silently deny every request.
const HOST_ENTRY_PATTERN =
  /^(?<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(?<port>[0-9]{1,5}))?$/u

function parseAllowedHosts(raw: string | undefined, origin: URL): readonly string[] {
  const derived = [origin.host]
  if (raw === undefined || raw.trim() === '') return derived
  const entries = raw.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  if (entries.length === 0) return derived
  for (const entry of entries) {
    const match = HOST_ENTRY_PATTERN.exec(entry)
    if (match === null) {
      fail('invalid-allowed-hosts', `${ENV_KEYS.allowedHosts} entry ${JSON.stringify(entry)} is not a host or host:port value.`)
    }
    const port = match.groups?.port
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
      fail('invalid-allowed-hosts', `${ENV_KEYS.allowedHosts} entry ${JSON.stringify(entry)} has a port outside 1..65535.`)
    }
  }
  return entries
}

function parseRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REQUEST_TIMEOUT_MS
  const value = raw.trim()
  if (!/^\d+$/u.test(value)) {
    fail('invalid-request-timeout', `${ENV_KEYS.requestTimeoutMs} must be an integer number of milliseconds, got ${JSON.stringify(raw)}.`)
  }
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < 1) {
    fail('invalid-request-timeout', `${ENV_KEYS.requestTimeoutMs} must be greater than 0, got ${timeout}.`)
  }
  return timeout
}

function parseListenHost(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LISTEN_HOST
  const value = raw.trim()
  if (/[\s/\\]/u.test(value)) {
    fail('invalid-listen-host', `${ENV_KEYS.listenHost} must be a bare listen address, got ${JSON.stringify(value)}.`)
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
export function loadUpdateServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Record<'port' | 'dataDir', string>> = {},
): UpdateServerConfig {
  const port = parsePort(env[ENV_KEYS.port] ?? overrides.port)
  const dataDir = parseDataDir(env[ENV_KEYS.dataDir] ?? overrides.dataDir)
  const publicOrigin = parsePublicOrigin(env[ENV_KEYS.publicOrigin])
  const listenHost = parseListenHost(env[ENV_KEYS.listenHost])
  const requestTimeoutMs = parseRequestTimeoutMs(env[ENV_KEYS.requestTimeoutMs])
  const allowedHosts = parseAllowedHosts(env[ENV_KEYS.allowedHosts], publicOrigin)
  return {
    port,
    dataDir,
    publicOrigin: publicOrigin.origin,
    listenHost,
    requestTimeoutMs,
    allowedHosts,
  }
}
