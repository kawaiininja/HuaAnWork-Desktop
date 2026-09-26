/**
 * market-server HTTP surface (Task 1; extended by Task 2).
 *
 * Public routes:
 *
 *   GET /v1/plugins             Provider-page catalog endpoint (contract
 *                               encoding: q / category / capability / cursor /
 *                               limit / sort / locale); responses are
 *                               self-validated by parseCatalogProviderPage.
 *   GET /v1/manifest            The ACTIVATED offline-signed manifest,
 *                               verbatim (pending → offline sign → verified
 *                               intake/activation; 404 until one activates).
 *   GET /v1/manifest/signature  The detached signature record (sidecar) of
 *                               the activated manifest; 404 until activation.
 *   GET /artifacts/<file>       Streaming .tgz download (never whole-file in
 *                               memory); names are content-derived at publish.
 *   GET /admin                  Operator management page (static shell; all
 *                               data calls are token-authenticated).
 *   GET /healthz                Liveness probe: {"ok":true}.
 *
 * Admin routes (Task 2, bearer-token auth, fail-closed — see admin/routes.ts):
 *
 *   GET  /v1/admin/state
 *   POST /v1/admin/artifacts
 *   PATCH /v1/admin/entries/:id
 *   POST /v1/admin/entries/:id/unpublish
 *   POST /v1/admin/manifest/prepare
 *   GET  /v1/admin/manifest/pending
 *   POST /v1/admin/manifest/signature
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
import { handleAdminRequest } from './admin/routes.ts'
import { renderAdminPage } from './admin/ui.ts'
import { CatalogQueryError, CatalogService } from './catalog/service.ts'
import type { CatalogStore } from './catalog/store.ts'
import type { MarketServerConfig } from './config.ts'
import { handleArtifactGet } from './tarball/http.ts'
import type { ArtifactStore } from './tarball/store.ts'

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
  readonly artifacts: ArtifactStore
}

export function createMarketServer(config: MarketServerConfig, store: CatalogStore, artifacts: ArtifactStore): MarketHttpServer {
  const catalog = new CatalogService(store)
  const adminContext = { config, store, catalog, artifacts }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', config.publicOrigin)
      const method = request.method ?? 'GET'

      if (url.pathname === '/healthz') {
        if (method !== 'GET') {
          sendError(response, 405, 'method-not-allowed', 'only GET is supported')
          return
        }
        sendJson(response, 200, { ok: true })
        return
      }

      // Task 2: streaming artifact download (public; sha256 trust comes from
      // the signed manifest, not from this endpoint's transport).
      if (await handleArtifactGet(request, response, url.pathname, artifacts)) return

      // Task 2: token-authed admin surface (disabled = 401 admin-disabled).
      if (url.pathname.startsWith('/v1/admin/')) {
        if (await handleAdminRequest(request, response, url, adminContext)) return
      }

      // Task 2: operator management page (static shell, no server-side data).
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        if (method !== 'GET') {
          sendError(response, 405, 'method-not-allowed', 'only GET is supported')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderAdminPage({ adminEnabled: config.adminToken !== null }))
        return
      }

      if (method !== 'GET') {
        sendError(response, 405, 'method-not-allowed', 'only GET is supported')
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

      if (url.pathname === '/v1/manifest/signature') {
        const signature = store.signature()
        if (signature === null) {
          sendError(response, 404, 'signature-not-found', 'no activated manifest signature yet')
          return
        }
        sendJson(response, 200, signature)
        return
      }

      sendError(response, 404, 'not-found', 'unknown route')
    })().catch(() => {
      if (!response.headersSent) sendError(response, 500, 'internal-error', 'internal error')
      else response.destroy()
    })
  })

  return { server, config, catalog, store, artifacts }
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
