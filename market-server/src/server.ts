/**
 * market-server HTTP surface (Task 1).
 *
 * Routes (all GET; the admin mutating surface lands with Task 2):
 *
 *   GET /v1/plugins   Provider-page catalog endpoint. Query parameters follow
 *                     the standard contract encoding: `q`, repeated
 *                     `category` / `capability`, `cursor`, `limit`, `sort`,
 *                     `locale`. Requests are parsed by the upstream
 *                     `normalizeCatalogQuery`; the response is a
 *                     `CatalogProviderPage` that already passed
 *                     `parseCatalogProviderPage` self-validation.
 *   GET /v1/manifest  The stored offline-signed catalog manifest, verbatim
 *                     (pass-through; signature verification/activation is
 *                     Task 2). 404 until one is stored.
 *   GET /healthz      Liveness probe: {"ok":true}.
 *
 * Error bodies are `{"error":{"code","message"}}` and never leak paths, env,
 * or internals (contract doc security boundary).
 *
 * market-server is NOT a standard source (round3 R4): it serves no
 * `catalog-source` manifest and makes no https/443 transport claim; only the
 * provider-page payload layer is contract-compatible.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { CatalogContractError } from 'dsh-community-market/contracts'
import { CatalogQueryError, CatalogService } from './catalog/service.ts'
import type { CatalogStore } from './catalog/store.ts'
import type { MarketServerConfig } from './config.ts'

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } })
}

/** Parse the standard contract query encoding from the request URL. */
export function parseQueryParams(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {}
  const q = url.searchParams.get('q')
  if (q !== null) query.q = q
  const category = url.searchParams.getAll('category')
  if (category.length > 0) query.category = category
  const capability = url.searchParams.getAll('capability')
  if (capability.length > 0) query.capability = capability
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null) query.cursor = cursor
  const limit = url.searchParams.get('limit')
  if (limit !== null) query.limit = /^-?\d+$/u.test(limit) ? Number(limit) : limit
  const sort = url.searchParams.get('sort')
  if (sort !== null) query.sort = sort
  const locale = url.searchParams.get('locale')
  if (locale !== null) query.locale = locale
  return query
}

export interface MarketHttpServer {
  readonly server: Server
  readonly config: MarketServerConfig
  readonly catalog: CatalogService
  readonly store: CatalogStore
}

export function createMarketServer(config: MarketServerConfig, store: CatalogStore): MarketHttpServer {
  const catalog = new CatalogService(store)

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', config.publicOrigin)
      const method = request.method ?? 'GET'

      if (method !== 'GET') {
        sendError(response, 405, 'method-not-allowed', 'only GET is supported')
        return
      }

      if (url.pathname === '/healthz') {
        sendJson(response, 200, { ok: true })
        return
      }

      if (url.pathname === '/v1/plugins') {
        try {
          const page = catalog.query(parseQueryParams(url))
          sendJson(response, 200, page)
        } catch (cause) {
          if (cause instanceof CatalogContractError) {
            sendError(response, 400, 'invalid-query', cause.message)
            return
          }
          if (cause instanceof CatalogQueryError) {
            sendError(response, 400, cause.code, cause.message)
            return
          }
          if (cause instanceof TypeError) {
            // Stored-state structural errors: fail closed, say nothing internal.
            sendError(response, 500, 'invalid-stored-catalog', 'stored catalog state cannot produce a valid provider page')
            return
          }
          throw cause
        }
        return
      }

      if (url.pathname === '/v1/manifest') {
        const manifest = store.manifest()
        if (manifest === null) {
          sendError(response, 404, 'manifest-not-found', 'no signed catalog manifest has been activated yet')
          return
        }
        sendJson(response, 200, manifest)
        return
      }

      sendError(response, 404, 'not-found', 'unknown route')
    })().catch(() => {
      if (!response.headersSent) sendError(response, 500, 'internal-error', 'internal error')
      else response.destroy()
    })
  })

  return { server, config, catalog, store }
}

export async function listen(market: MarketHttpServer): Promise<void> {
  const { server, config } = market
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(config.port, () => {
      server.removeListener('error', rejectPromise)
      resolvePromise()
    })
  })
}
