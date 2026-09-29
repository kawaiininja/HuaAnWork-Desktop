/**
 * Shared test helper: boot a real update-server on an ephemeral loopback port,
 * ready for end-to-end route tests (Task 3.2/3.3 use it).
 *
 * The server's Host whitelist is enforced by server.ts, so the config below
 * whitelists the loopback authorities this helper serves on (and the public
 * origin, for tests that assert the production-facing host). A test that builds
 * its own UpdateServerConfig must likewise list the host it will fetch.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateServerConfig } from '../../src/config.ts'
import { startUpdateServer, type UpdateServer } from '../../src/server.ts'

export const PUBLIC_ORIGIN = 'http://update.intranet.example:8790'

export interface TestUpdateServer {
  readonly dataDir: string
  readonly server: UpdateServer
  readonly origin: string
  readonly config: UpdateServerConfig
  close: () => Promise<void>
}

export interface TestUpdateServerOptions {
  /** Reuse an existing data directory (restart tests); a fresh temp dir otherwise. */
  readonly dataDir?: string
}

export async function bootTestUpdateServer(options: TestUpdateServerOptions = {}): Promise<TestUpdateServer> {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'update-server-e2e-'))
  const config: UpdateServerConfig = {
    port: 0,
    dataDir,
    publicOrigin: PUBLIC_ORIGIN,
    listenHost: '127.0.0.1',
    requestTimeoutMs: 30_000,
    allowedHosts: ['127.0.0.1', 'localhost', new URL(PUBLIC_ORIGIN).host],
  }
  const server = await startUpdateServer(config)
  return {
    dataDir,
    server,
    origin: `http://127.0.0.1:${String(server.port)}`,
    config,
    close: () => server.close(),
  }
}
