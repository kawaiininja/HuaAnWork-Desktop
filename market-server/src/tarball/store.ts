/**
 * Artifact (.tgz) storage for market-server (Task 2).
 *
 * Files live in `<dataDir>/artifacts/` (0700; files 0600, following the
 * state-directory precedent). Uploads STREAM to a temp file while the sha256
 * is computed incrementally — the tarball bytes are hashed as they arrive,
 * and the digest becomes part of the final file name
 * (`<name>-<version>-<sha256[:12]>.tgz`), so a stored artifact's name is a
 * content-derived integrity handle. An optional client-claimed sha256
 * (`?sha256=` on the upload) is checked against the computed digest and a
 * mismatch rejects the upload with nothing left behind.
 */

import { createHash } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { chmod, mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { STATE_DIRECTORY_MODE, STATE_FILE_MODE } from '../store.ts'

export const ARTIFACTS_SUBDIRECTORY = 'artifacts'
export const SHA256_HEX_LENGTH = 64
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u
/** Upload size cap: an honest guard against accidental huge payloads (admin-only surface). */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024
/**
 * Stale-upload sweep threshold (review P11): a `.upload-*.tmp` file older than
 * this when the store opens is debris from a killed process (uploads are
 * second-scale, and the deployment shape is a single process per data dir),
 * not an in-flight upload. Swept best-effort; fresh temps are never touched.
 */
export const UPLOAD_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

export class ArtifactShaMismatchError extends Error {
  constructor() {
    super('claimed sha256 does not match the uploaded bytes')
    this.name = 'ArtifactShaMismatchError'
  }
}

export class ArtifactTooLargeError extends Error {
  constructor() {
    super(`artifact exceeds the ${String(MAX_ARTIFACT_BYTES)}-byte upload cap`)
    this.name = 'ArtifactTooLargeError'
  }
}

export interface SavedArtifact {
  /** Content-derived file name inside the artifacts directory. */
  readonly fileName: string
  /** Lowercase hex sha256 of the exact stored bytes. */
  readonly sha256: string
  readonly size: number
}

/** Derive the safe file-stem from package identity (gate-validated name/version). */
export function artifactFileName(name: string, version: string, sha256: string): string {
  const stem = name.replace(/^@/u, '').replace(/\//gu, '-')
  return `${stem}-${version}-${sha256.slice(0, 12)}.tgz`
}

/** Best-effort sweep of stale upload temps left behind by killed processes (review P11). */
async function sweepStaleUploadTemps(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => undefined)
  if (names === undefined) return
  const now = Date.now()
  for (const name of names) {
    if (!name.startsWith('.upload-') || !name.endsWith('.tmp')) continue
    const path = join(directory, name)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) continue
    if (now - info.mtimeMs < UPLOAD_TEMP_MAX_AGE_MS) continue
    await unlink(path).catch(() => undefined)
  }
}

export class ArtifactStore {
  readonly #directory: string

  private constructor(directory: string) {
    this.#directory = directory
  }

  get directory(): string {
    return this.#directory
  }

  static async open(dataDir: string): Promise<ArtifactStore> {
    const directory = join(dataDir, ARTIFACTS_SUBDIRECTORY)
    await mkdir(directory, { recursive: true, mode: STATE_DIRECTORY_MODE })
    await chmod(directory, STATE_DIRECTORY_MODE).catch(() => undefined)
    await sweepStaleUploadTemps(directory)
    return new ArtifactStore(directory)
  }

  pathOf(fileName: string): string {
    return join(this.#directory, fileName)
  }

  /**
   * Stream an upload to a temp file while hashing. Returns the temp name and
   * the computed digest; the caller inspects the staged bytes (publish gate)
   * and then either `commit`s to a content-derived final name or `discard`s.
   * `claimedSha256` (optional `?sha256=` upload param) is checked against the
   * computed digest and rejects the whole upload.
   */
  async stage(stream: Readable, claimedSha256?: string): Promise<{ tempName: string } & SavedArtifact> {
    const hash = createHash('sha256')
    let size = 0
    const tempName = `.upload-${String(process.pid)}-${String(Date.now())}.tmp`
    const handle = await open(join(this.#directory, tempName), 'wx', STATE_FILE_MODE)
    try {
      for await (const chunk of stream) {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > MAX_ARTIFACT_BYTES) throw new ArtifactTooLargeError()
        hash.update(buffer)
        await handle.write(buffer)
      }
    } catch (cause) {
      await handle.close().catch(() => undefined)
      await unlink(join(this.#directory, tempName)).catch(() => undefined)
      throw cause
    }
    await handle.close()

    const sha256 = hash.digest('hex')
    if (claimedSha256 !== undefined && claimedSha256 !== sha256) {
      await unlink(join(this.#directory, tempName)).catch(() => undefined)
      throw new ArtifactShaMismatchError()
    }
    return { tempName, fileName: tempName, sha256, size }
  }

  /** Move a staged temp file to its content-derived final name. */
  async commit(tempName: string, fileName: string): Promise<void> {
    const temporary = join(this.#directory, tempName)
    try {
      await rename(temporary, join(this.#directory, fileName))
    } catch (cause) {
      await unlink(temporary).catch(() => undefined)
      throw cause
    }
    await chmod(join(this.#directory, fileName), STATE_FILE_MODE).catch(() => undefined)
  }

  /** Drop a staged temp file (publish-gate rejection cleanup). */
  async discard(tempName: string): Promise<void> {
    await unlink(join(this.#directory, tempName)).catch(() => undefined)
  }

  /** Raw write of already-known bytes (tests/seeding); returns the computed digest. */
  async writeBytes(fileName: string, bytes: Buffer): Promise<SavedArtifact> {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const finalPath = join(this.#directory, fileName)
    await writeFile(finalPath, bytes, { mode: STATE_FILE_MODE })
    await chmod(finalPath, STATE_FILE_MODE).catch(() => undefined)
    return { fileName, sha256, size: bytes.length }
  }

  /** Streaming read handle for the download endpoint (never whole-file-in-memory). */
  openReadStream(fileName: string): ReadStream {
    return createReadStream(this.pathOf(fileName))
  }

  async stat(fileName: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(this.pathOf(fileName))
      return { size: info.size }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  }

  /** Remove a stored artifact (operator cleanup; NOT part of unpublish). */
  async remove(fileName: string): Promise<boolean> {
    try {
      await unlink(this.pathOf(fileName))
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw cause
    }
  }
}
