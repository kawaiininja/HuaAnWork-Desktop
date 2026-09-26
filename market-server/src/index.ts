/**
 * market-server entry point.
 *
 * Fail-closed startup (D4): a missing/invalid env config or an unreadable /
 * corrupt state file prints operator guidance and exits 1 — the server never
 * starts half-configured.
 *
 * Run:  node --experimental-strip-types src/index.ts
 */

import { CatalogStore } from './catalog/store.ts'
import { ConfigError, loadConfig, type MarketServerConfig } from './config.ts'
import { StoreCorruptError } from './store.ts'
import { createMarketServer, listen } from './server.ts'
import { ArtifactStore } from './tarball/store.ts'

async function main(): Promise<void> {
  let config: MarketServerConfig
  try {
    config = loadConfig(process.env)
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(cause.message)
      process.exit(1)
    }
    throw cause
  }

  let store: CatalogStore
  try {
    store = await CatalogStore.open(config.dataDir)
  } catch (cause) {
    if (cause instanceof StoreCorruptError) {
      console.error(cause.message)
      process.exit(1)
    }
    throw cause
  }

  const artifacts = await ArtifactStore.open(config.dataDir)
  if (config.adminToken === null) {
    console.warn(
      'market-server: MARKET_SERVER_ADMIN_TOKEN is not configured; the admin surface is DISABLED ' +
        '(all /v1/admin/* endpoints answer 401 admin-disabled). Set a strong random token and restart to enable publishing.',
    )
  }

  const market = createMarketServer(config, store, artifacts)
  await listen(market)
  console.log(
    `market-server listening on port ${config.port} (public origin ${config.publicOrigin}, data dir ${config.dataDir})`,
  )
}

main().catch((cause: unknown) => {
  console.error('market-server failed to start:', cause instanceof Error ? cause.message : String(cause))
  process.exit(1)
})
