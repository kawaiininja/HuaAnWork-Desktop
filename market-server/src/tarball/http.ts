/**
 * Streaming artifact download endpoint (Task 2).
 *
 * `GET /artifacts/<fileName>` serves the stored .tgz with a streaming
 * `fs.createReadStream` pipeline — the artifact never enters memory whole.
 * Unknown names 404; the lookup is a plain directory join whose file name is
 * content-derived at publish time (sha256[:12] in the name), so no path
 * traversal is possible for names the server itself minted; we still reject
 * any name containing a separator for defense in depth.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { ArtifactStore } from './store.ts'

export const ARTIFACTS_ROUTE_PREFIX = '/artifacts/'

export function isSafeArtifactName(fileName: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/u.test(fileName)
}

/**
 * Handle `GET /artifacts/<fileName>`. Returns false when the request is not
 * an artifact route; sends the response otherwise.
 */
export async function handleArtifactGet(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  artifacts: ArtifactStore,
): Promise<boolean> {
  if (!pathname.startsWith(ARTIFACTS_ROUTE_PREFIX)) return false
  const fileName = decodeURIComponent(pathname.slice(ARTIFACTS_ROUTE_PREFIX.length))

  const notFound = (): void => {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`${JSON.stringify({ error: { code: 'artifact-not-found', message: 'no such artifact' } })}\n`)
  }

  if (request.method !== 'GET' || !isSafeArtifactName(fileName)) {
    notFound()
    return true
  }

  const info = await artifacts.stat(fileName)
  if (info === null) {
    notFound()
    return true
  }

  response.writeHead(200, {
    'content-type': 'application/gzip',
    'content-length': String(info.size),
    'cache-control': 'no-store',
  })
  await pipeline(artifacts.openReadStream(fileName), response)
  return true
}
