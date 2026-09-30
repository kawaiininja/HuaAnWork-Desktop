/**
 * Shared test helper: boot a real market-server on an ephemeral port with a
 * generated signing keypair, ready for end-to-end admin/two-step tests.
 */

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

export async function bootTestMarket(options: { readonly adminToken?: string | null; readonly maxCatalogEntries?: number } = {}): Promise<TestMarket> {
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
    close: async () => new Promise<void>(resolve => market.server.close(() => resolve())),
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
