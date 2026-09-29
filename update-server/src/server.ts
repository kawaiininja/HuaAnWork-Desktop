/**
 * update-server HTTP skeleton (Task 3.1).
 *
 * Hardening is built in from the start (market-server P8, minus uploads, which
 * do not exist on a read-only server): every request passes the Host whitelist
 * gate, and the server never runs on Node's unbounded socket default
 * (`timeout = 0`) - requestTimeout, headersTimeout, and the socket inactivity
 * timeout all come from config.
 *
 * Routes (Task 3.3 appends the download endpoints):
 *
 *   GET /healthz              Liveness probe: {"ok":true}.
 *   GET /api/desktop/version  Channel-scoped release metadata for the desktop
 *                             update checker: version, channel label, and the
 *                             per-platform artifact sha256 from the channel
 *                             record. Never redirects; unknown channel 404
 *                             unknown-channel, no release 404 no-release,
 *                             corrupt record 500 corrupt-channel-record.
 *
 * Error bodies are `{"error":{"code","message"}}` (spec §9), matching the
 * desktop-side routes; they never leak paths, env, or internals.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isUpdateServerChannel } from './channels.ts'
import type { UpdateServerConfig } from './config.ts'
import {
  DESKTOP_CHANNEL_HEADER,
  InvalidHeaderValueError,
  lookupChannelVersion,
  readVersionRequestHeaders,
  type VersionRequestHeaders,
  type VersionResponsePayload,
} from './version/service.ts'
import { CorruptChannelRecordError } from './version/store.ts'

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

/**
 * Whether a request Host header is covered by the whitelist.
 *
 * Matching is case-insensitive and port-aware: an entry with a port matches
 * that exact authority, an entry without a port matches any port of that host.
 * A missing, empty, or malformed Host header never matches.
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

interface RouteContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
  readonly method: string
  readonly config: UpdateServerConfig
}

type RouteHandler = (context: RouteContext) => void | Promise<void>

interface Route {
  readonly path: string
  readonly method: string
  readonly handle: RouteHandler
}

function handleHealthz({ response }: RouteContext): void {
  sendJson(response, 200, { ok: true })
}

async function handleDesktopVersion({ request, response, config }: RouteContext): Promise<void> {
  let headers: VersionRequestHeaders
  try {
    headers = readVersionRequestHeaders(request.headers)
  } catch (cause) {
    if (!(cause instanceof InvalidHeaderValueError)) throw cause
    // The offending value is deliberately neither logged nor echoed.
    sendError(response, 400, 'invalid-header', 'a request header value contains control characters')
    return
  }

  const channel = headers.channel
  if (channel === undefined || !isUpdateServerChannel(channel)) {
    sendError(response, 404, 'unknown-channel', `the ${DESKTOP_CHANNEL_HEADER} header must name a channel this server serves`)
    return
  }

  // Installation id and installed version are log-only (D-M6-11): they never
  // select a record and never suppress an answer.
  console.log('[update-server] version request:'
    + ` channel=${channel} installed=${headers.installedVersion ?? '-'} installation=${headers.installationId ?? '-'}`)

  // The store is a plain dataDir holder created per request, and the record is
  // re-read per request: no lock file and no in-memory cache.
  let payload: VersionResponsePayload | null
  try {
    payload = await lookupChannelVersion({ dataDir: config.dataDir }, channel)
  } catch (cause) {
    if (!(cause instanceof CorruptChannelRecordError)) throw cause
    console.error(`[update-server] ${cause.message}`)
    sendError(response, 500, 'corrupt-channel-record', 'the release record exists but is not a valid channel record')
    return
  }
  if (payload === null) {
    sendError(response, 404, 'no-release', `channel ${channel} has no published release yet`)
    return
  }
  sendJson(response, 200, payload)
}

/** Dispatch table; Task 3.3 appends the download endpoints here. */
const ROUTES: readonly Route[] = [
  { path: '/healthz', method: 'GET', handle: handleHealthz },
  { path: '/api/desktop/version', method: 'GET', handle: handleDesktopVersion },
]

export interface UpdateServer {
  /** Port actually bound; equals the configured port unless it was 0 (ephemeral). */
  readonly port: number
  close(): Promise<void>
}

export async function startUpdateServer(config: UpdateServerConfig): Promise<UpdateServer> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (!isAllowedHost(request.headers.host, config.allowedHosts)) {
        sendError(response, 403, 'host-not-allowed', 'the request Host header is not allowed by this server')
        return
      }

      const url = new URL(request.url ?? '/', config.publicOrigin)
      const method = request.method ?? 'GET'
      const route = ROUTES.find(candidate => candidate.path === url.pathname)
      if (route === undefined) {
        sendError(response, 404, 'not-found', 'unknown route')
        return
      }
      if (method !== route.method) {
        sendError(response, 405, 'method-not-allowed', `only ${route.method} is supported`)
        return
      }
      await route.handle({ request, response, url, method, config })
    })().catch((cause: unknown) => {
      // Never swallow silently: the 500 body stays generic, but the caught
      // error must reach the operator's log.
      console.error('[update-server] unhandled route error:', cause)
      if (!response.headersSent) sendError(response, 500, 'internal-error', 'internal error')
      else response.destroy()
    })
  })

  // Explicit timeouts only. Node leaves `server.timeout` at 0 (no socket
  // inactivity timeout) by default, which is exactly market-server P8's defect.
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = config.requestTimeoutMs
  server.timeout = config.requestTimeoutMs

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(config.port, config.listenHost, () => {
      server.removeListener('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('update-server: the HTTP server did not bind a TCP address')
  }

  return {
    port: address.port,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error === undefined) resolvePromise()
        else rejectPromise(error)
      })
    }),
  }
}
