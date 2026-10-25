/**
 * Atomic JSON state store (Task 4).
 *
 * One `state.json` document is the entire persisted server state. Durability
 * and consistency rules:
 *
 *   update(mutator)   deep-copies the current state, lets the mutator mutate
 *                     the copy, writes `${dataDir}/state.json.tmp-<pid>-<rand>`,
 *                     fsyncs it, renames it over state.json, and only then
 *                     makes the copy visible to readers. All updates run
 *                     through ONE in-process write queue, so two requests can
 *                     never interleave read-modify-write cycles.
 *   withPackageLock   per `${slug}/${version}` serialization for handlers
 *                     that must not race (submit vs. approve vs. revoke).
 *   open()            creates the data dir, deletes only its own `state.json`
 *                     temp files (crash leftovers), and NEVER deletes bundle
 *                     recovery evidence (e.g. `submissions/<id>/bundle.tgz*`).
 *                     A corrupt state file is an operator error: it is left
 *                     untouched and `StoreCorruptError` is thrown.
 *
 * Security: the file is written 0600 inside a 0700 directory. Only public
 * catalog metadata is stored — never a token, never a private key.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open as openFile, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyCatalogState, packageKey, type CatalogState } from './types.ts'

export { emptyCatalogState, packageKey }

export const STATE_FILE_NAME = 'state.json'
export const STATE_FILE_MODE = 0o600
export const DATA_DIRECTORY_MODE = 0o700

/** Temp files written by {@link CatalogStore.update}; `<pid>` + random hex. */
const STATE_TEMP_PATTERN = /^state\.json\.tmp-\d+-[0-9a-f]+$/u

export class StoreCorruptError extends Error {
  readonly path: string

  constructor(path: string, cause: Error) {
    super(
      `agent-catalog-server: state file ${path} is not valid CatalogState: ${cause.message}. ` +
        'The file was left untouched; restore it from backup before restarting.',
    )
    this.name = 'StoreCorruptError'
    this.path = path
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a parsed state document without trusting the disk. */
function parseState(path: string, contents: string): CatalogState {
  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch (cause) {
    throw new StoreCorruptError(path, cause as Error)
  }
  if (!isPlainObject(document)) {
    throw new StoreCorruptError(path, new Error('the document must be a JSON object'))
  }
  if (document.schemaVersion !== 1) {
    throw new StoreCorruptError(path, new Error('schemaVersion must be 1'))
  }
  for (const collection of ['submissions', 'packages', 'delistRequests', 'revocations'] as const) {
    if (!isPlainObject(document[collection])) {
      throw new StoreCorruptError(path, new Error(`${collection} must be an object`))
    }
  }
  return document as unknown as CatalogState
}

export class CatalogStore {
  readonly dataDir: string

  private state: CatalogState
  /** The single global write queue: every update runs strictly after the previous one. */
  private writeTail: Promise<unknown> = Promise.resolve()
  /** Per-package locks; a lock entry disappears once its queue drains. */
  private readonly packageLocks = new Map<string, Promise<unknown>>()

  private constructor(dataDir: string, state: CatalogState) {
    this.dataDir = dataDir
    this.state = state
  }

  /**
   * Open (or initialize) the store in `dataDir`. Crash leftovers of the STATE
   * file are removed; everything else — submissions/, audit.jsonl, audit temp
   * files — is left alone because it may be recovery evidence.
   */
  static async open(dataDir: string): Promise<CatalogStore> {
    await mkdir(dataDir, { recursive: true, mode: DATA_DIRECTORY_MODE })
    // Best effort: an existing directory keeps its mode otherwise.
    await chmod(dataDir, DATA_DIRECTORY_MODE).catch(() => undefined)

    for (const file of await readdir(dataDir)) {
      if (STATE_TEMP_PATTERN.test(file)) {
        await unlink(join(dataDir, file)).catch(() => undefined)
      }
    }

    const statePath = join(dataDir, STATE_FILE_NAME)
    let contents: string
    try {
      contents = await readFile(statePath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return new CatalogStore(dataDir, emptyCatalogState())
      }
      throw cause
    }
    return new CatalogStore(dataDir, parseState(statePath, contents))
  }

  /** A deep copy of the committed state; callers may keep or mutate it. */
  read(): CatalogState {
    return structuredClone(this.state)
  }

  /**
   * Run `mutator` against a deep copy of the state and commit it atomically.
   * The mutator's result is returned after the commit succeeded. A throwing
   * mutator commits nothing and does not wedge the queue.
   */
  update<T>(mutator: (draft: CatalogState) => T | Promise<T>): Promise<T> {
    const run = this.writeTail.then(async () => {
      const draft = structuredClone(this.state)
      const result = await mutator(draft)
      await this.writeState(draft)
      this.state = draft
      return result
    })
    // Keep the queue usable after a failed update; the rejection still
    // reaches this caller through `run`.
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Serialize a critical section for one package `${slug}/${version}`.
   * Different packages are independent and may run concurrently.
   */
  withPackageLock<T>(slug: string, version: string, fn: () => Promise<T>): Promise<T> {
    const key = packageKey(slug, version)
    const previous = this.packageLocks.get(key) ?? Promise.resolve()
    const run = previous.then(
      () => fn(),
      () => fn(),
    )
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.packageLocks.set(key, tail)
    void tail.finally(() => {
      if (this.packageLocks.get(key) === tail) this.packageLocks.delete(key)
    })
    return run
  }

  private async writeState(state: CatalogState): Promise<void> {
    const statePath = join(this.dataDir, STATE_FILE_NAME)
    const tempPath = join(
      this.dataDir,
      `${STATE_FILE_NAME}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`,
    )
    const payload = `${JSON.stringify(state, null, 2)}\n`
    const handle = await openFile(tempPath, 'w', STATE_FILE_MODE)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, statePath)
    // Directory fsync makes the rename durable. Not supported on every
    // platform (Windows refuses to open a directory), so it is best effort.
    const directory = await openFile(this.dataDir, 'r').catch(() => null)
    if (directory !== null) {
      try {
        await directory.sync()
      } catch {
        // Ignore: the file itself is already fsynced and renamed.
      } finally {
        await directory.close()
      }
    }
  }
}
