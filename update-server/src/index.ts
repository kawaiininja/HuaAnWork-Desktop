/** Intranet release-channel update server entry point. */

import { loadUpdateServerConfig } from './config.ts'
import { startUpdateServer } from './server.ts'

const config = loadUpdateServerConfig(process.env)
const server = await startUpdateServer(config)

process.stdout.write(`update-server: listening on ${String(server.port)} for ${config.publicOrigin}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0))
  })
}
