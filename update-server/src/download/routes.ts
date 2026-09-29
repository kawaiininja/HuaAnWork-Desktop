/**
 * Installer download endpoint (Task 3.3): GET /api/downloads/{mac,windows}.
 *
 * The request carries the same channel header as the version endpoint plus the
 * target version the client just checked (X-DSH-Desktop-Target-Version). The
 * answer is the artifact recorded in `<dataDir>/channels/<channel>.json`,
 * streamed from `<dataDir>/artifacts/<channel>/<platform>/<filename>` with the
 * record's byte count as Content-Length and its publish-time sha256 in
 * X-HuaAnWork-Artifact-Sha256, so an operator can reconcile what the fleet
 * received against what was published (D-M6-23).
 *
 * Failure semantics are deliberate:
 *
 *   - a missing or foreign channel header is 404 unknown-channel;
 *   - a channel with no record is 404 no-release;
 *   - a target version that is not the published one is 404 version-mismatch
 *     (the client pins its download to the version it checked);
 *   - a platform the record does not carry is 404 no-artifact;
 *   - a record that points at a file which is absent, not a regular file, or
 *     not exactly the recorded size is 500 artifact-missing-or-truncated, and
 *     never a 404: a client reads 404 as "no update", which would disguise a
 *     publish incident as a normal state ("an unreachable source must say so").
 *
 * Content-Length always comes from the record *after* the on-disk length was
 * verified, never from a bare statSync: a mismatch must fail the request
 * rather than emit a response whose length disagrees with the record.
 */

import { createReadStream, statSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isUpdateServerChannel, type UpdateServerChannel } from '../channels.ts'
import type { UpdateServerConfig } from '../config.ts'
import { DESKTOP_CHANNEL_HEADER, InvalidHeaderValueError, readClientHeader } from '../version/service.ts'
import {
  CorruptChannelRecordError,
  readChannelRecord,
  type ArtifactPlatform,
  type UpdateChannelArtifact,
  type UpdateChannelRecord,
} from '../version/store.ts'

/** Header pinning a download request to the release the client checked. */
export const DESKTOP_TARGET_VERSION_HEADER = 'X-DSH-Desktop-Target-Version'

/** Response header carrying the publish-time sha256 of the served bytes. */
export const ARTIFACT_SHA256_HEADER = 'X-HuaAnWork-Artifact-Sha256'

/** Public download paths, one per platform this server hosts. */
export const DOWNLOAD_PATHS: Readonly<Record<ArtifactPlatform, string>> = Object.freeze({
  mac: '/api/downloads/mac',
  windows: '/api/downloads/windows',
})

/** What a download request carries, after the control-character check. */
export interface DownloadRequestHeaders {
  readonly channel: string | undefined
  readonly targetVersion: string | undefined
}

/** The parts of the request the download route needs; server.ts supplies them. */
export interface DownloadRouteContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly config: UpdateServerConfig
}

/**
 * Read and validate the two client headers.
 *
 * @param headers - incoming request headers (Node lowercases their names).
 * @returns the header values, `undefined` where absent.
 * @throws InvalidHeaderValueError when any value carries control characters.
 */
export function readDownloadRequestHeaders(headers: IncomingHttpHeaders): DownloadRequestHeaders {
  return {
    channel: readClientHeader(headers, DESKTOP_CHANNEL_HEADER),
    targetVersion: readClientHeader(headers, DESKTOP_TARGET_VERSION_HEADER),
  }
}

/**
 * Serve one platform's installer for one channel and target version.
 *
 * @param context - request, response, and the server's data directory.
 * @param platform - platform whose artifact path and record entry are used.
 */
export async function handleDesktopDownload(context: DownloadRouteContext, platform: ArtifactPlatform): Promise<void> {
  const { request, response, config } = context

  let headers: DownloadRequestHeaders
  try {
    headers = readDownloadRequestHeaders(request.headers)
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
  console.log(`[update-server] download request: channel=${channel} platform=${platform}`
    + ` target=${headers.targetVersion ?? '-'}`)

  let record: UpdateChannelRecord | null
  try {
    record = await readChannelRecord({ dataDir: config.dataDir }, channel)
  } catch (cause) {
    if (!(cause instanceof CorruptChannelRecordError)) throw cause
    console.error(`[update-server] ${cause.message}`)
    sendError(response, 500, 'corrupt-channel-record', 'the release record exists but is not a valid channel record')
    return
  }
  if (record === null) {
    sendError(response, 404, 'no-release', `channel ${channel} has no published release yet`)
    return
  }

  // An absent header is a mismatch too: it names no version, so it cannot be
  // the published one, and substituting the current release would hand out
  // bytes the client did not ask for.
  if (headers.targetVersion !== record.version) {
    sendError(response, 404, 'version-mismatch', `channel ${channel} does not publish the requested target version`)
    return
  }

  const artifact = record.artifacts[platform]
  if (artifact === undefined) {
    sendError(response, 404, 'no-artifact', `channel ${channel} publishes no ${platform} artifact`)
    return
  }

  const path = artifactPath(config.dataDir, channel, platform, artifact.filename)
  if (path === null || !artifactMatchesRecord(path, artifact)) {
    // The path itself is operator-facing detail and stays in the log.
    console.error(`[update-server] channel ${channel} ${platform} artifact is missing, unreadable, or does not match`
      + ` its recorded ${String(artifact.bytes)} bytes`)
    sendError(response, 500, 'artifact-missing-or-truncated',
      'the release record points at an artifact that is missing or does not match its recorded size')
    return
  }

  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(artifact.bytes),
    'cache-control': 'no-store',
    [ARTIFACT_SHA256_HEADER]: artifact.sha256,
  })
  try {
    // Streaming, never buffered: an installer may reach the client's 1 GiB cap.
    await pipeline(createReadStream(path), response)
  } catch (cause) {
    // The headers (and therefore the promised Content-Length) are already out;
    // the only honest remaining move is to break the connection so the client
    // sees a failed download instead of a short body it would hash and reject.
    console.error('[update-server] artifact stream failed:', cause)
    response.destroy()
  }
}

/**
 * Resolve the served file, or null when the recorded name cannot be one.
 *
 * The record only guarantees a non-empty filename string, so the name is
 * checked here before it becomes a path: a separator or a traversal segment
 * could otherwise point the route outside the platform directory.
 */
function artifactPath(
  dataDir: string,
  channel: UpdateServerChannel,
  platform: ArtifactPlatform,
  filename: string,
): string | null {
  if (filename === '' || filename === '.' || filename === '..' || /[/\\]/u.test(filename)) return null
  return join(dataDir, 'artifacts', channel, platform, filename)
}

/** Whether the file on disk is a regular, non-empty file of exactly the recorded size. */
function artifactMatchesRecord(path: string, artifact: UpdateChannelArtifact): boolean {
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size > 0 && stats.size === artifact.bytes
  } catch {
    // ENOENT, ENOTDIR, EACCES: all of them mean "cannot serve the recorded bytes".
    return false
  }
}

/**
 * The same `{"error":{"code","message"}}` envelope server.ts sends, kept local
 * so this module never imports the server that dispatches to it (no cycle).
 */
function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  const payload = `${JSON.stringify({ error: { code, message } })}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}
