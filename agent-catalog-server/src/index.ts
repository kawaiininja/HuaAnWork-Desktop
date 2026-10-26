#!/usr/bin/env -S node --experimental-strip-types
/**
 * agent-catalog-server entry point.
 *
 * Fail-closed startup: a missing/invalid env value, an unreadable keyring, or
 * a corrupt state file prints operator guidance and exits 1 — the server never
 * starts half-configured or with an unvalidated trust root.
 *
 * Run:  node --experimental-strip-types src/index.ts
 *
 * Startup deliberately never reads a private-key path: signatures are produced
 * offline; this process only holds public verification keys. Logs contain no
 * token and no Authorization header.
 */

import { AgentCatalogConfigError, loadAgentCatalogConfig, type AgentCatalogConfig } from './config.ts'
import {
  createAgentCatalogRuntime,
  createAgentCatalogServer,
  type AgentCatalogRuntime,
} from './server.ts'
import { StoreCorruptError } from './store.ts'

async function main(): Promise<void> {
  let config: AgentCatalogConfig
  try {
    config = loadAgentCatalogConfig(process.env)
  } catch (cause) {
    if (cause instanceof AgentCatalogConfigError) {
      console.error(cause.message)
      process.exit(1)
    }
    throw cause
  }

  let runtime: AgentCatalogRuntime
  try {
    runtime = await createAgentCatalogRuntime(config)
  } catch (cause) {
    if (cause instanceof StoreCorruptError) {
      console.error(cause.message)
      process.exit(1)
    }
    throw cause
  }

  const server = createAgentCatalogServer(config, runtime)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  console.log(
    `agent-catalog-server listening on http://${config.host}:${String(config.port)} ` +
      `(entries: ${config.entriesDir}, data: ${config.dataDir}, ` +
      `keyring keys: ${String(config.keyring.length)})`,
  )
}

main().catch((cause: unknown) => {
  console.error(
    'agent-catalog-server failed to start:',
    cause instanceof Error ? cause.message : String(cause),
  )
  process.exit(1)
})
