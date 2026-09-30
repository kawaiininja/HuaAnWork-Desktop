/**
 * market-server HTTP surface (Task 1; extended by Task 2).
 *
 * Public routes:
 *
 *   GET /v1/plugins             Provider-page catalog endpoint (contract
 *                               encoding: q / category / capability / cursor /
 *                               limit / sort / locale); every served item is
 *                               self-validated by the upstream contract
 *                               validator, and the assembled page is validated
 *                               AS A WHOLE before it is sent (Task 6.7 fix
 *                               round 1 — a page the contract rejects is never
 *                               served). A stored entry that violates the
 *                               contract is isolated from THIS response only
 *                               (ruling D-M6-26): the count travels in the
 *                               `x-catalog-isolated-entries` response header
 *                               and the per-entry reason in the server log;
 *                               an all-invalid result answers 500
 *                               `invalid-stored-catalog` instead of an empty
 *                               page. An envelope-level refusal (reachably: a
 *                               legal-but-oversized query whose cursor exceeds
 *                               the contract's 2048-char cap) answers 400
 *                               `query-not-paginable` — a request-level
 *                               refusal, not stored-state corruption.
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
 * Operational hardening (Task 6.5, P8): an explicit `Host` allowlist
 * (config.allowedHosts → 403 `host-not-allowed`), a cap on concurrent uploads
 * (config.maxConcurrentUploads → 429 `too-many-uploads`) and explicit non-zero
 * `requestTimeout` / `headersTimeout` / `timeout` values on the server object.
 *
 * market-server is NOT a standard source (round3 R4): it serves no
 * `catalog-source` manifest and makes no https/443 transport claim; only the
 * provider-page payload layer is contract-compatible.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { CatalogContractError } from 'dsh-community-market/contracts'
import { ADMIN_ARTIFACTS_PATH, handleAdminRequest } from './admin/routes.ts'
import { renderAdminPage } from './admin/ui.ts'
import {
  CatalogPageEnvelopeError,
  CatalogQueryError,
  CatalogService,
  InvalidStoredCatalogError,
  type IsolatedCatalogEntry,
} from './catalog/service.ts'
import type { CatalogStore } from './catalog/store.ts'
import type { MarketServerConfig } from './config.ts'
import { handleArtifactGet } from './tarball/http.ts'
import type { ArtifactStore } from './tarball/store.ts'

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}

/**
 * Ruling D-M6-26: an isolated catalog entry must reach the operator's log with
 * its contract reason — isolation is never a silent drop. One shape for every
 * arm (partial isolation, all-invalid refusal) so the journal reads the same;
 * the ajv issue detail stays here and never enters a client body (review D3b).
 */
function logIsolatedEntries(isolated: readonly IsolatedCatalogEntry[]): void {
  for (const entry of isolated) {
    // name/id are stored values (possibly hand-edited, hence possibly ugly):
    // JSON-encode them so one isolation always stays one log line.
    console.error(
      `[market-server] isolated catalog entry ${JSON.stringify(entry.name)} (${JSON.stringify(entry.id)}): ${entry.reason}`,
    )
  }
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } })
}

/**
 * Whether a request Host header is covered by the configured whitelist (P8).
 *
 * Matching is case-insensitive and port-aware: an entry with a port matches
 * that exact authority, an entry without a port matches any port of that host.
 * A missing, empty, or malformed Host header never matches. This mirrors
 * update-server's `isAllowedHost` — the two servers keep one semantics.
 */
function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (hostHeader === undefined) return false
  const authority = hostHeader.trim().toLowerCase()
  if (authority === '' || /[\s,]/u.test(authority)) return false
  const hostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0] ?? ''
  if (hostname === '' || hostname === '[') return false

  for (const entry of allowedHosts) {
    const allowed = entry.trim().toLowerCase()
    if (allowed === authority) return true
    if (!allowed.includes(':') && allowed === hostname) return true
  }
  return false
}

/** Upload concurrency cap (P8): a slot per in-flight `POST /v1/admin/artifacts`. */
class UploadSlots {
  #inUse = 0
  readonly #cap: number

  constructor(cap: number) {
    this.#cap = cap
  }

  tryAcquire(): boolean {
    if (this.#inUse >= this.#cap) return false
    this.#inUse += 1
    return true
  }

  release(): void {
    if (this.#inUse > 0) this.#inUse -= 1
  }
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
  const uploadSlots = new UploadSlots(config.maxConcurrentUploads)

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      // P8: Host whitelist first, before any routing (fail closed). A Host that
      // is not configured means the request was addressed to some other name —
      // nothing downstream consumed `headers.host` before this, so the check is
      // hygiene (DNS rebinding / virtual-host confusion), not a fix. The 403
      // `host-not-allowed` answer mirrors update-server.
      if (!isAllowedHost(request.headers.host, config.allowedHosts)) {
        sendError(response, 403, 'host-not-allowed', 'the request Host header is not allowed by this server')
        return
      }

      const url = new URL(request.url ?? '/', config.publicOrigin)
      const method = request.method ?? 'GET'

      // P8: upload concurrency cap. The slot is held for the whole request and
      // released when the response closes — 'close' fires for a completed
      // response AND for a premature client disconnect.
      if (method === 'POST' && url.pathname === ADMIN_ARTIFACTS_PATH) {
        if (!uploadSlots.tryAcquire()) {
          sendError(
            response,
            429,
            'too-many-uploads',
            `this server already has ${String(config.maxConcurrentUploads)} uploads in flight; retry when they finish`,
          )
          return
        }
        response.on('close', () => uploadSlots.release())
      }

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

      // Task 2: operator management page. P7: a static shell that renders the
      // same bytes whether or not an admin token is configured — the page is
      // unauthenticated, so it must not disclose "is a token configured?" (the
      // `admin-disabled` answer belongs to the JSON API).
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        if (method !== 'GET') {
          sendError(response, 405, 'method-not-allowed', 'only GET is supported')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderAdminPage())
        return
      }

      if (method !== 'GET') {
        sendError(response, 405, 'method-not-allowed', 'only GET is supported')
        return
      }

      if (url.pathname === '/v1/plugins') {
        try {
          const { page, isolated } = catalog.queryWithIsolation(parseQueryParams(url))
          if (isolated.length > 0) {
            // Ruling D-M6-26: the isolation is honestly visible in BOTH
            // channels. The count travels as response metadata (a probe can
            // alert on it, and it needs no contract change: the payload stays a
            // field-exact CatalogProviderPage); the per-entry name/id/reason
            // goes to the operator log only (review D3b — ajv detail must not
            // reach unauthenticated clients).
            logIsolatedEntries(isolated)
            sendJson(response, 200, page, { 'x-catalog-isolated-entries': String(isolated.length) })
            return
          }
          sendJson(response, 200, page)
        } catch (cause) {
          if (cause instanceof InvalidStoredCatalogError) {
            // Fail-closed arm of the read-side isolation: every candidate entry
            // was isolated, so a 200 would carry an EMPTY catalog and tell
            // clients the market is empty. Report the data fault it is; the
            // per-entry reasons stay in the operator log (D3b).
            console.error(
              `[market-server] every catalog entry matching the request violates the provider-page contract ` +
                `(${String(cause.isolated.length)} isolated); refusing to answer with an empty catalog`,
            )
            logIsolatedEntries(cause.isolated)
            sendError(
              response,
              500,
              'invalid-stored-catalog',
              'every catalog entry matching this query violates the provider-page contract; refusing to answer with an empty catalog (details in the server log)',
            )
            return
          }
          if (cause instanceof CatalogPageEnvelopeError) {
            // Task 6.7 fix round 1: every served entry passed the per-entry
            // validator, so the page failed AS A WHOLE — an envelope-level
            // refusal with no single stored entry at fault (reachably: the
            // contract caps page.nextCursor at 2048 characters and a
            // legal-but-large query overflows it). The request provokes it, so
            // it is answered as a request-level refusal, NOT as stored-state
            // corruption, and the schema-violating payload is never served.
            console.error('[market-server] refusing to serve a provider page that fails the whole-page contract envelope:', cause)
            if (cause.isolated.length > 0) logIsolatedEntries(cause.isolated)
            if (cause.cursorOverflow) {
              sendError(
                response,
                400,
                'query-not-paginable',
                'the effective query is too large to paginate within the provider-page contract: page.nextCursor is capped at 2048 characters and this request\'s normalized query key exceeds that; narrow q/category/capability and retry',
              )
              return
            }
            // Not cursor-bound: an envelope fault this assembly cannot explain
            // (unreachable today). Fail closed without blaming the stored
            // catalog; the detail stays in the operator log (review D3b).
            sendError(
              response,
              500,
              'page-envelope-invalid',
              'the server could not assemble a contract-valid provider page for this request (details in the server log)',
            )
            return
          }
          if (cause instanceof CatalogContractError) {
            if (cause.contract === 'query') {
              // Genuine request-side query contract violation.
              sendError(response, 400, 'invalid-query', cause.message)
              return
            }
            // Defense-in-depth arm: the read path converts both its contract
            // checks before this point (per-entry violations become
            // EntryContractError → isolated; a rejected page becomes
            // CatalogPageEnvelopeError), so only a 'query' contract error can
            // reach here today. Kept fail-closed in case the read path changes
            // shape; the ajv instancePath/pattern details go to the operator
            // log only (review D3b — the contract doc security boundary says
            // error bodies never leak internals to unauthenticated clients).
            console.error('[market-server] provider-page contract error escaped the catalog read path:', cause)
            sendError(response, 500, 'invalid-stored-catalog', 'stored catalog state cannot produce a valid provider page')
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
    })().catch((cause) => {
      // Never swallow silently: the 500 body stays generic (contract security
      // boundary), but the caught error must reach the operator's log.
      console.error('[market-server] unhandled route error:', cause)
      if (!response.headersSent) sendError(response, 500, 'internal-error', 'internal error')
      else response.destroy()
    })
  })

  // P8: explicit, non-zero timeouts. Node's own default for `timeout` is 0
  // ("never"), so a stalled connection could hold its resources forever; the
  // values are config fields (see config.ts) so the deployment has one story.
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = config.headersTimeoutMs
  server.timeout = config.socketTimeoutMs

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
