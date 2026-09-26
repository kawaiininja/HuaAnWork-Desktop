/**
 * JSON file store with atomic write + advisory file lock (market-server).
 *
 * Follows the desktop-market state.json precedent (dsh-plugin-desktop
 * desktop-market.ts): state directory 0700, state file 0600. Atomic write is
 * tmp-file-in-same-directory + rename; the advisory lock is a lockfile
 * acquired with O_CREAT|O_EXCL so concurrent writers (operator scripts,
 * future admin endpoints) serialize instead of interleaving writes.
 *
 * Fail-safe recovery semantics (§13 mitigation, review D6):
 *   - missing file  -> the default value is used; the file is created lazily
 *                      on the first locked update;
 *   - corrupt JSON  -> StoreCorruptError; the file is NEVER overwritten or
 *                      truncated — the operator restores from backup
 *                      (docs/market-server-deployment.md). Restarting after a
 *                      crash mid-rename cannot corrupt the state: readers see
 *                      either the whole old file or the whole new one.
 *
 * No native dependencies, no SQLite (review D6): one JSON document is the
 * entire server state, so a restart is a full recovery.
 */

import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const STATE_DIRECTORY_MODE = 0o700
export const STATE_FILE_MODE = 0o600

/** A lockfile older than this is considered stale (holder crashed). */
const LOCK_STALE_MS = 30_000
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000
const LOCK_RETRY_INTERVAL_MS = 50

export class StoreCorruptError extends Error {
  readonly path: string

  constructor(path: string, cause: Error) {
    super(`market-server: state file ${path} is not valid JSON: ${cause.message}. ` +
      'The file was left untouched; restore it from backup (see docs/market-server-deployment.md).')
    this.name = 'StoreCorruptError'
    this.path = path
  }
}

export class LockTimeoutError extends Error {
  readonly lockPath: string

  constructor(lockPath: string) {
    super(`market-server: timed out acquiring the state lock ${lockPath}; another process may be stuck.`)
    this.name = 'LockTimeoutError'
    this.lockPath = lockPath
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
  let brokeStaleLock = false
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', STATE_FILE_MODE)
      await handle.writeFile(String(process.pid))
      await handle.close()
      return async () => {
        await unlink(lockPath).catch(() => undefined)
      }
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code !== 'EEXIST') throw error
      const age = await stat(lockPath).then(s => Date.now() - s.mtimeMs).catch(() => 0)
      if (age > LOCK_STALE_MS && !brokeStaleLock) {
        // The previous holder crashed without releasing; break the stale lock once.
        brokeStaleLock = true
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) throw new LockTimeoutError(lockPath)
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
    }
  }
}

async function ensureStateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: STATE_DIRECTORY_MODE })
  await chmod(directory, STATE_DIRECTORY_MODE).catch(() => undefined)
}

async function writeAtomic(path: string, directory: string, contents: string): Promise<void> {
  await ensureStateDirectory(directory)
  const temporary = join(directory, `.${Date.now()}.${process.pid}.tmp`)
  await writeFile(temporary, contents, { mode: STATE_FILE_MODE })
  try {
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  await chmod(path, STATE_FILE_MODE).catch(() => undefined)
}

export interface JsonFileStoreOptions<T> {
  /** Used when the state file does not exist yet. */
  readonly defaultValue: T
  /** Structural check after every load; throwing rejects startup. */
  readonly validate: (value: unknown) => T
}

export class JsonFileStore<T> {
  readonly #path: string
  readonly #directory: string
  readonly #lockPath: string
  readonly #defaultValue: T
  readonly #validate: (value: unknown) => T

  constructor(directory: string, fileName: string, options: JsonFileStoreOptions<T>) {
    this.#directory = directory
    this.#path = join(directory, fileName)
    this.#lockPath = `${this.#path}.lock`
    this.#defaultValue = options.defaultValue
    this.#validate = options.validate
  }

  get path(): string {
    return this.#path
  }

  /** Load the state document. Missing file -> default; corrupt JSON -> StoreCorruptError. */
  async load(): Promise<T> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return this.#defaultValue
      throw cause
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new StoreCorruptError(this.#path, cause as Error)
    }
    return this.#validate(parsed)
  }

  /**
   * Locked read-modify-write. The mutator sees the latest persisted value and
   * its result replaces the state atomically. Concurrent callers serialize on
   * the lockfile.
   */
  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    await ensureStateDirectory(this.#directory)
    const release = await acquireLock(this.#lockPath)
    try {
      const current = await this.load()
      const next = this.#validate(await mutator(current))
      await writeAtomic(this.#path, this.#directory, `${JSON.stringify(next, null, 2)}\n`)
      return next
    } finally {
      await release()
    }
  }
}
