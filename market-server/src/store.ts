/**
 * JSON file store with atomic write + advisory file lock (market-server).
 *
 * Follows the desktop-market state.json precedent (dsh-plugin-desktop
 * desktop-market.ts): state directory 0700, state file 0600. Atomic write is
 * tmp-file-in-same-directory + rename; the advisory lock is a lockfile
 * acquired with O_CREAT|O_EXCL so concurrent writers (operator scripts,
 * future admin endpoints) serialize instead of interleaving writes.
 *
 * Lock discipline (Task 6.5, P5/P6). Two defects are closed here:
 *
 *   P5 — a stale lock used to be broken with `unlink(lockPath)`, so two
 *        processes that both saw the same stale lock could delete EACH OTHER's
 *        fresh lock and both end up believing they held it. A lock is now only
 *        broken when its recorded owner is CONFIRMED gone (a `process.kill(pid,
 *        0)` probe, EPERM counting as alive) and the takeover itself is a
 *        single atomic `rename` into a quarantine name. The takeover then
 *        verifies by content that the file it moved is the exact lock it
 *        inspected; if a fresh lock appeared in between, it is put back with a
 *        non-clobbering `link` — a fresh lock is never destroyed. A takeover
 *        that cannot be undone fails honestly (`LockTakeoverError`) instead of
 *        pretending the lock is held.
 *   P6 — the same primitive backs `<dataDir>/server.lock`, the single-instance
 *        guard (see catalog/store.ts).
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

import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const STATE_DIRECTORY_MODE = 0o700
export const STATE_FILE_MODE = 0o600

/** A lockfile older than this is a takeover CANDIDATE (its owner must also be gone). */
export const LOCK_STALE_MS = 30_000
export const LOCK_ACQUIRE_TIMEOUT_MS = 10_000
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

/** What a lock file records about the process that holds it. */
export interface LockFileOwner {
  /** Process id of the holder. */
  readonly pid: number
  /** Epoch milliseconds at which the holder created the lock. */
  readonly startedAt: number
}

/** Why a lock must not be taken over. */
export type LockFileConflictReason = 'owner-alive' | 'not-stale' | 'unknown-owner'

/** Everything a caller needs to report an honest "the lock is taken" error. */
export interface LockFileConflict {
  readonly reason: LockFileConflictReason
  /** The recorded owner, or null when the file did not name a process. */
  readonly holder: LockFileOwner | null
}

export type LockFileAcquisition =
  | { readonly ok: true; readonly release: () => Promise<void> }
  | { readonly ok: false; readonly conflict: LockFileConflict }

/** Timing knobs for {@link acquireLockFile}; production uses the defaults. */
export interface LockFileTiming {
  /**
   * Takeover is only considered once the lock is at least this old. `0` means
   * "no age requirement": the recorded owner's liveness is the only gate
   * (used by the single-instance guard, where the lock lives for days).
   */
  readonly staleMs?: number
  /** How long to keep retrying while a lock that must not be broken is held (0 = fail now). */
  readonly waitMs?: number
  /** Retry interval while waiting. */
  readonly retryMs?: number
}

export class LockTimeoutError extends Error {
  readonly lockPath: string
  /** The recorded owner at the moment the wait gave up; null = the file named no process. */
  readonly holder: LockFileOwner | null

  constructor(lockPath: string, conflict?: LockFileConflict) {
    const holder = conflict?.holder ?? null
    super(
      `market-server: timed out acquiring the lock ${lockPath}; another process may be stuck` +
        (holder === null ? ' (the lock file does not name a process — inspect it before removing it).' : ` (held by pid ${String(holder.pid)}).`),
    )
    this.name = 'LockTimeoutError'
    this.lockPath = lockPath
    this.holder = holder
  }
}

/**
 * A stale lock could not be taken over safely: the takeover moved a file it did
 * not inspect and could not put it back. Failing loudly is the honest option —
 * continuing would mean running without the lock (P5).
 */
export class LockTakeoverError extends Error {
  readonly lockPath: string

  constructor(lockPath: string, detail: string) {
    super(`market-server: failed to take over the stale lock ${lockPath} atomically: ${detail}`)
    this.name = 'LockTakeoverError'
    this.lockPath = lockPath
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Liveness probe: signal 0 checks existence without touching the process. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    // ESRCH = no such process; EPERM = it exists but belongs to another user.
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw cause
  }
}

/** Parse a lock file: the current single-line JSON record, or a Task 1/2 bare pid. */
function parseLockFile(raw: string): LockFileOwner | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null
    return { pid: record.pid, startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0 }
  }
  return /^\d+$/u.test(trimmed) && Number(trimmed) > 0 ? { pid: Number(trimmed), startedAt: 0 } : null
}

function lockFileContent(owner: LockFileOwner): string {
  // The random token makes every acquisition identifiable: the takeover below
  // compares the exact bytes it inspected against the bytes it moved.
  return `${JSON.stringify({ pid: owner.pid, startedAt: owner.startedAt, token: randomUUID() })}\n`
}

async function ensureStateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: STATE_DIRECTORY_MODE })
  await chmod(directory, STATE_DIRECTORY_MODE).catch(() => undefined)
}

interface LockFileIdentity {
  readonly ino: number | bigint
  readonly dev: number | bigint
}

/** Exclusive create (O_EXCL); null = the path is already taken. */
async function createLockFile(lockPath: string, contents: string): Promise<LockFileIdentity | null> {
  try {
    const handle = await open(lockPath, 'wx', STATE_FILE_MODE)
    try {
      await handle.writeFile(contents)
      const stats = await handle.stat()
      return { ino: stats.ino, dev: stats.dev }
    } finally {
      await handle.close()
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw cause
  }
}

/**
 * Atomic stale-lock takeover (P5). `inspected` are the exact bytes that were
 * read while deciding to break the lock; the caller has already confirmed that
 * the recorded owner is gone.
 *
 * `rename` is atomic, so at most one process can move that directory entry. The
 * moved file is then verified by content: if it is not the lock that was
 * inspected (a fresh lock appeared while we were deciding), it is restored with
 * `link`, which refuses to overwrite — never destroying a fresh lock. A
 * restore that cannot be completed is an honest {@link LockTakeoverError}.
 */
async function takeOverLockFile(lockPath: string, inspected: string): Promise<void> {
  const quarantine = `${lockPath}.takeover-${String(process.pid)}-${randomUUID()}`
  try {
    await rename(lockPath, quarantine)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return // someone else already broke it
    throw cause
  }

  if (await readFile(quarantine, 'utf8') === inspected) {
    await unlink(quarantine)
    return
  }

  // We moved a lock we did not inspect: a fresh lock was created between the
  // inspection and the rename. Put it back without clobbering, then let the
  // caller retry its acquisition (it will now see a live, fresh lock).
  try {
    await link(quarantine, lockPath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another lock appeared at the path while the fresh one was moved away:
      // the takeover cannot be undone. Leave the moved file in quarantine —
      // deleting it could destroy a live holder's lock (the contract is that a
      // fresh lock is NEVER destroyed) — and fail honestly.
      throw new LockTakeoverError(
        lockPath,
        `a fresh lock was created while taking over the stale one; the moved file cannot be put back and was preserved at ${quarantine}`,
      )
    }
    throw cause
  }
  await unlink(quarantine)
}

/**
 * Acquire `lockPath` exclusively, taking over a stale lock atomically when its
 * recorded owner is gone. Never throws for ordinary contention: it reports the
 * conflict and lets the caller name its own honest error (the state lock times
 * out, the single-instance guard refuses startup).
 */
export async function acquireLockFile(lockPath: string, timing: LockFileTiming = {}): Promise<LockFileAcquisition> {
  const staleMs = timing.staleMs ?? LOCK_STALE_MS
  const waitMs = timing.waitMs ?? LOCK_ACQUIRE_TIMEOUT_MS
  const retryMs = timing.retryMs ?? LOCK_RETRY_INTERVAL_MS
  const startedAt = Date.now()
  const deadline = startedAt + waitMs
  const contents = lockFileContent({ pid: process.pid, startedAt })
  let conflict: LockFileConflict = { reason: 'not-stale', holder: null }

  await ensureStateDirectory(dirname(lockPath))
  for (;;) {
    const identity = await createLockFile(lockPath, contents)
    if (identity !== null) {
      let released = false
      return {
        ok: true,
        release: async () => {
          if (released) return
          released = true
          const current = await stat(lockPath).catch(() => null)
          if (current === null || current.ino !== identity.ino || current.dev !== identity.dev) {
            // Our entry is gone: another process took the file over. Never
            // delete a lock we do not own (that is the P5 defect) — report it.
            console.error(
              `[market-server] lock ${lockPath} is no longer the file this process created; ` +
                'leaving it in place (another process may hold it) — mutual exclusion was compromised.',
            )
            return
          }
          await unlink(lockPath)
        },
      }
    }

    // Contended: decide whether this lock may be taken over.
    const observed = await stat(lockPath).catch(() => null)
    if (observed === null) continue // the entry vanished: retry the exclusive create
    const raw = await readFile(lockPath, 'utf8').catch(() => null)
    if (raw === null) continue // ditto: read lost the race with a takeover
    const holder = parseLockFile(raw)
    const age = Date.now() - observed.mtimeMs
    if (holder === null) {
      // An unattributable lock cannot be proven stale: never break it.
      conflict = { reason: 'unknown-owner', holder: null }
    } else if (isProcessAlive(holder.pid)) {
      conflict = { reason: 'owner-alive', holder }
    } else if (staleMs > 0 && age <= staleMs) {
      conflict = { reason: 'not-stale', holder }
    } else {
      await takeOverLockFile(lockPath, raw)
      continue
    }

    if (Date.now() >= deadline) return { ok: false, conflict }
    await delay(retryMs)
  }
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
  /**
   * Test seam: override the lock timing. Production always uses the module
   * defaults ({@link LOCK_STALE_MS} / {@link LOCK_ACQUIRE_TIMEOUT_MS}).
   */
  readonly lockTiming?: LockFileTiming
}

export class JsonFileStore<T> {
  readonly #path: string
  readonly #directory: string
  readonly #lockPath: string
  readonly #defaultValue: T
  readonly #validate: (value: unknown) => T
  readonly #lockTiming: LockFileTiming

  constructor(directory: string, fileName: string, options: JsonFileStoreOptions<T>) {
    this.#directory = directory
    this.#path = join(directory, fileName)
    this.#lockPath = `${this.#path}.lock`
    this.#defaultValue = options.defaultValue
    this.#validate = options.validate
    this.#lockTiming = options.lockTiming ?? {}
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
   * the lockfile (P5: stale locks are only broken with an atomic, verified
   * takeover of a lock whose owner is confirmed gone).
   */
  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    const acquisition = await acquireLockFile(this.#lockPath, this.#lockTiming)
    if (!acquisition.ok) throw new LockTimeoutError(this.#lockPath, acquisition.conflict)
    try {
      const current = await this.load()
      const next = this.#validate(await mutator(current))
      await writeAtomic(this.#path, this.#directory, `${JSON.stringify(next, null, 2)}\n`)
      return next
    } finally {
      // The release never masks the outcome above: it reports a compromised
      // lock through the operator log instead of throwing (see above).
      await acquisition.release()
    }
  }
}
