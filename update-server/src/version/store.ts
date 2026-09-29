/**
 * Read-only channel-record store (Task 3.2).
 *
 * `<dataDir>/channels/<channel>.json` is the single source of truth for one
 * channel's published release: the version endpoint reads its `version` and
 * per-platform `sha256`, and the download route (Task 3.3) will read
 * `filename` / `bytes`. The file is written by scripts/publish-release.mjs on
 * the deploy host (atomic temp file + rename, 0600); this module only ever
 * reads it - no write, mkdir, unlink, lock file, or in-memory cache, so an
 * external republish is visible on the very next request.
 *
 * The record is validated on read against the pinned shape. A file that exists
 * but does not match it throws CorruptChannelRecordError, which the route maps
 * to `500 corrupt-channel-record`: a broken record must never degrade into a
 * silent "no update" (fail-closed, plan global constraints 7/8).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matchesChannelVersionShape, type UpdateServerChannel } from '../channels.ts'

/** Platforms whose installers this server hosts. */
export type ArtifactPlatform = 'mac' | 'windows'

/** Every platform a record may carry, in declaration order. */
export const ARTIFACT_PLATFORMS: readonly ArtifactPlatform[] = Object.freeze(['mac', 'windows'] as const)

/** One installer artifact as recorded at publish time. */
export interface UpdateChannelArtifact {
  readonly filename: string
  /** Lowercase hex sha256 of the artifact bytes, computed at publish time (D-M6-23). */
  readonly sha256: string
  readonly bytes: number
}

/** One channel's published release: all release metadata this server holds. */
export interface UpdateChannelRecord {
  readonly version: string
  readonly publishedAt: string
  readonly artifacts: Readonly<Partial<Record<ArtifactPlatform, UpdateChannelArtifact>>>
}

/** A data directory to read channel records from; holds no state of its own. */
export interface ChannelRecordStore {
  readonly dataDir: string
}

/** The record file exists but cannot be served; never falls back to "no release". */
export class CorruptChannelRecordError extends Error {
  readonly code = 'corrupt-channel-record'
  readonly path: string

  constructor(path: string, reason: string) {
    super(`update-server: channel record ${path} is corrupt: ${reason}`)
    this.name = 'CorruptChannelRecordError'
    this.path = path
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isArtifactPlatform(value: string): value is ArtifactPlatform {
  return (ARTIFACT_PLATFORMS as readonly string[]).includes(value)
}

function parseArtifact(path: string, platform: ArtifactPlatform, raw: unknown): UpdateChannelArtifact {
  if (!isRecord(raw)) throw new CorruptChannelRecordError(path, `artifacts.${platform} is not an object`)
  const { filename, sha256, bytes } = raw
  if (typeof filename !== 'string' || filename === '') {
    throw new CorruptChannelRecordError(path, `artifacts.${platform}.filename must be a non-empty string`)
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new CorruptChannelRecordError(path, `artifacts.${platform}.sha256 must be 64 lowercase hex characters`)
  }
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new CorruptChannelRecordError(path, `artifacts.${platform}.bytes must be a non-negative integer`)
  }
  return { filename, sha256, bytes }
}

function parseChannelRecord(channel: UpdateServerChannel, path: string, parsed: unknown): UpdateChannelRecord {
  if (!isRecord(parsed)) throw new CorruptChannelRecordError(path, 'the record must be a JSON object')
  const { version, publishedAt, artifacts } = parsed
  if (typeof version !== 'string' || !matchesChannelVersionShape(channel, version)) {
    throw new CorruptChannelRecordError(path, `version must be a canonical ${channel} version`)
  }
  if (typeof publishedAt !== 'string') {
    throw new CorruptChannelRecordError(path, 'publishedAt must be a string')
  }
  if (!isRecord(artifacts)) throw new CorruptChannelRecordError(path, 'artifacts must be an object')

  const parsedArtifacts: Partial<Record<ArtifactPlatform, UpdateChannelArtifact>> = {}
  for (const [platform, artifact] of Object.entries(artifacts)) {
    // An unknown platform would be dropped from every response; fail closed
    // instead of silently hiding part of a release.
    if (!isArtifactPlatform(platform)) {
      throw new CorruptChannelRecordError(path, `artifacts.${platform} is not a platform this server serves`)
    }
    parsedArtifacts[platform] = parseArtifact(path, platform, artifact)
  }
  return { version, publishedAt, artifacts: parsedArtifacts }
}

/**
 * Read one channel's release record, re-read on every call.
 *
 * @param store - data directory holding `channels/<channel>.json`.
 * @param channel - channel to read; callers pass a validated channel name.
 * @returns the record, or null when this channel has no release file yet.
 * @throws CorruptChannelRecordError when the file exists but is not a valid record.
 */
export async function readChannelRecord(
  store: ChannelRecordStore,
  channel: UpdateServerChannel,
): Promise<UpdateChannelRecord | null> {
  const path = join(store.dataDir, 'channels', `${channel}.json`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CorruptChannelRecordError(path, 'the file does not contain valid JSON')
  }
  return parseChannelRecord(channel, path, parsed)
}
