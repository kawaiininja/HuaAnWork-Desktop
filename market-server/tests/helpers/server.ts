/**
 * Shared test helper: boot a real market-server on an ephemeral port with a
 * generated signing keypair, ready for end-to-end admin/two-step tests.
 */

import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { CatalogStore, type CatalogStore as CatalogStoreType } from '../../src/catalog/store.ts'
import type { MarketServerConfig } from '../../src/config.ts'
import { MAX_MANIFEST_ENTRIES } from '../../src/manifest-prepare.ts'
import { generateKeyPair } from '../../src/signing.ts'
import { createMarketServer, type MarketHttpServer } from '../../src/server.ts'
import { ArtifactStore } from '../../src/tarball/store.ts'
import { buildTgz, cleanPackageManifest } from './tar.ts'

export const PUBLIC_ORIGIN = 'http://market.intranet.example:8787'
export const ADMIN_TOKEN = 'test-admin-token'

export interface TestMarket {
  readonly dataDir: string
  readonly store: CatalogStoreType
  readonly artifacts: ArtifactStore
  readonly market: MarketHttpServer
  readonly baseUrl: string
  readonly key: ReturnType<typeof generateKeyPair>
  readonly config: MarketServerConfig
  close: () => Promise<void>
}

export async function bootTestMarket(options: {
  readonly adminToken?: string | null
  readonly maxCatalogEntries?: number
  readonly maxConcurrentUploads?: number
} = {}): Promise<TestMarket> {
  const dataDir = await mkdtemp(join(tmpdir(), 'market-server-e2e-'))
  const store = await CatalogStore.open(dataDir)
  const artifacts = await ArtifactStore.open(dataDir)
  const key = generateKeyPair()
  const config: MarketServerConfig = {
    port: 0,
    dataDir,
    publicOrigin: PUBLIC_ORIGIN,
    verifyPublicKeyPath: '/nonexistent/key.hex',
    verifyPublicKeyHex: key.publicKeyHex,
    adminToken: options.adminToken === undefined ? ADMIN_TOKEN : options.adminToken,
    maxCatalogEntries: options.maxCatalogEntries ?? MAX_MANIFEST_ENTRIES,
    // The test client connects to 127.0.0.1:<ephemeral port>; the default
    // allowlist is built from the public origin, so the loopback name is
    // spelled out here (P8).
    allowedHosts: ['127.0.0.1'],
    maxConcurrentUploads: options.maxConcurrentUploads ?? 4,
    requestTimeoutMs: 300_000,
    headersTimeoutMs: 60_000,
    socketTimeoutMs: 120_000,
  }
  const market = createMarketServer(config, store, artifacts)
  await new Promise<void>(resolve => market.server.listen(0, '127.0.0.1', resolve))
  const address = market.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(address.port)}`
  return {
    dataDir,
    store,
    artifacts,
    market,
    baseUrl,
    key,
    config,
    close: async () => {
      await new Promise<void>(resolve => market.server.close(() => resolve()))
      // P6: the catalog store holds the data directory's single-instance lock
      // (server.lock); a restart against the same directory needs it released.
      await store.close()
    },
  }
}

/**
 * A pid that is guaranteed to be gone: spawn a child that exits immediately and
 * reap it (P5/P6 use it to seed locks left behind by a crashed holder).
 */
export async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (pid === undefined) throw new Error('spawn returned no pid')
  return pid
}

/** A live process this test controls: `pid` stays alive until `stop()`. */
export async function liveProcess(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('spawn returned no pid')
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  return {
    pid,
    stop: async () => {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    },
  }
}

export function adminHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export async function publishTgz(
  baseUrl: string,
  token: string,
  packageManifest: Record<string, unknown> = cleanPackageManifest(),
  query: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const params = new URLSearchParams({ displayName: 'Sample Plugin', summary: 'A sample plugin', ...query })
  const response = await fetch(`${baseUrl}/v1/admin/artifacts?${params.toString()}`, {
    method: 'POST',
    headers: { ...adminHeaders(token), 'content-type': 'application/gzip' },
    body: buildTgz(packageManifest),
  })
  return { status: response.status, body: await response.json() }
}
