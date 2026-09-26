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
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const ENV_KEYS = {
  port: 'MARKET_SERVER_PORT',
  dataDir: 'MARKET_SERVER_DATA_DIR',
  publicOrigin: 'MARKET_SERVER_PUBLIC_ORIGIN',
  verifyPublicKeyPath: 'MARKET_SERVER_VERIFY_PUBLIC_KEY',
  adminToken: 'MARKET_SERVER_ADMIN_TOKEN',
} as const

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MarketServerConfig {
  const port = parsePort(env[ENV_KEYS.port])
  const dataDir = parseDataDir(env[ENV_KEYS.dataDir])
  const publicOrigin = parsePublicOrigin(env[ENV_KEYS.publicOrigin])
  const verifyPublicKey = parseVerifyPublicKey(env[ENV_KEYS.verifyPublicKeyPath])
  const adminToken = parseAdminToken(env[ENV_KEYS.adminToken])
  return {
    port,
    dataDir,
    publicOrigin,
    verifyPublicKeyPath: verifyPublicKey.path,
    verifyPublicKeyHex: verifyPublicKey.hex,
    adminToken,
  }
}
