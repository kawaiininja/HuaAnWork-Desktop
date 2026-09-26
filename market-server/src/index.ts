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

  const market = createMarketServer(config, store)
  await listen(market)
  console.log(
    `market-server listening on port ${config.port} (public origin ${config.publicOrigin}, data dir ${config.dataDir})`,
  )
}

main().catch((cause: unknown) => {
  console.error('market-server failed to start:', cause instanceof Error ? cause.message : String(cause))
  process.exit(1)
})
