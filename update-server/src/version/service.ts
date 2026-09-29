/**
 * Version endpoint logic for `GET /api/desktop/version` (Task 3.2).
 *
 * Client headers are validated here before anything is logged or answered: any
 * value carrying CR, LF, or another control character is rejected outright and
 * the offending value is neither logged nor echoed, and the channel header must
 * name a channel this server serves - missing or unknown is an error, never a
 * fallback to stable.
 *
 * The response carries the published version, the channel label the client
 * requires for non-stable channels (D-M6-2), and the per-platform artifact
 * sha256 recorded at publish time (D-M6-23). The installed-version and
 * installation-id headers are recorded in the log at most: update checks are
 * idempotent reads, so there is nothing to authenticate or deduplicate
 * (D-M6-11), and comparing versions is the client's job.
 */

import type { IncomingHttpHeaders } from 'node:http'
import type { UpdateServerChannel } from '../channels.ts'
import {
  ARTIFACT_PLATFORMS,
  readChannelRecord,
  type ArtifactPlatform,
  type ChannelRecordStore,
  type UpdateChannelRecord,
} from './store.ts'

/** Channel header; mirrors the client's DESKTOP_RELEASE_CHANNEL_HEADER. */
export const DESKTOP_CHANNEL_HEADER = 'X-DSH-Desktop-Channel'
/** Installed-version header; recorded in the log, never compared here. */
export const DESKTOP_VERSION_HEADER = 'X-DSH-Desktop-Version'
/** Installation-id header; logged at most, never used for auth or dedupe (D-M6-11). */
export const DESKTOP_INSTALLATION_ID_HEADER = 'X-DSH-Desktop-Installation-Id'

/** Response body of `GET /api/desktop/version`. */
export interface VersionResponsePayload {
  readonly version: string
  readonly channel: UpdateServerChannel
  /** Only the platforms present in the record; absent platforms have no key. */
  readonly sha256: Readonly<Partial<Record<ArtifactPlatform, string>>>
}

/** The three client headers, after the control-character check. */
export interface VersionRequestHeaders {
  readonly channel: string | undefined
  readonly installedVersion: string | undefined
  readonly installationId: string | undefined
}

/** A client header value carries characters that cannot survive a header line. */
export class InvalidHeaderValueError extends Error {
  readonly code = 'invalid-header'
  readonly headerName: string

  constructor(headerName: string) {
    super(`update-server: request header ${headerName} contains control characters`)
    this.name = 'InvalidHeaderValueError'
    this.headerName = headerName
  }
}

// C0 controls (CR, LF, and HTAB included) and DEL: such a value must never
// reach the log or the response, so it is rejected before either happens.
const DISALLOWED_HEADER_CHARACTERS = /[\u0000-\u001f\u007f]/u

function readClientHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  if (value === undefined) return undefined
  const text = Array.isArray(value) ? value.join(', ') : value
  if (DISALLOWED_HEADER_CHARACTERS.test(text)) throw new InvalidHeaderValueError(name)
  return text
}

/**
 * Read and validate the three client headers.
 *
 * @param headers - incoming request headers (Node lowercases their names).
 * @returns the header values, `undefined` where absent.
 * @throws InvalidHeaderValueError when any value carries control characters.
 */
export function readVersionRequestHeaders(headers: IncomingHttpHeaders): VersionRequestHeaders {
  return {
    channel: readClientHeader(headers, DESKTOP_CHANNEL_HEADER),
    installedVersion: readClientHeader(headers, DESKTOP_VERSION_HEADER),
    installationId: readClientHeader(headers, DESKTOP_INSTALLATION_ID_HEADER),
  }
}

/**
 * Look up one channel's version response payload.
 *
 * @param store - read-only channel record store.
 * @param channel - validated channel to answer for.
 * @returns the response payload, or null when the channel has no release yet.
 * @throws CorruptChannelRecordError when the record file is not a valid record.
 */
export async function lookupChannelVersion(
  store: ChannelRecordStore,
  channel: UpdateServerChannel,
): Promise<VersionResponsePayload | null> {
  const record = await readChannelRecord(store, channel)
  if (record === null) return null
  return buildVersionResponse(record, channel)
}

/** Project a record onto the response; absent platforms stay absent. */
function buildVersionResponse(record: UpdateChannelRecord, channel: UpdateServerChannel): VersionResponsePayload {
  const sha256: Partial<Record<ArtifactPlatform, string>> = {}
  for (const platform of ARTIFACT_PLATFORMS) {
    const artifact = record.artifacts[platform]
    if (artifact !== undefined) sha256[platform] = artifact.sha256
  }
  return { version: record.version, channel, sha256 }
}
