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

const SUBMISSION_STATUSES: ReadonlySet<string> = new Set(['pending-review', 'published', 'rejected'])
const PACKAGE_STATUSES: ReadonlySet<string> = new Set(['published', 'delisted', 'revoked'])
const DELIST_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'rejected'])

/**
 * Validate a parsed state document without trusting the disk.
 *
 * The four collections are checked record by record (Task 4 / M-3): required
 * fields and their JSON types, status enums, and the identity relationships
 * (`packages`/`revocations` key === `${slug}/${version}`, `delistRequests` key
 * === `id`). A semantically broken document is an operator error exactly like
 * invalid JSON: it is never "repaired" by dropping or re-keying records.
 *
 * `manifest`/`digest`/`signature` only have to be plain objects here — their
 * inner shape is owned by the package/signature validators and re-checked at
 * read time; duplicating those schemas in the store would let them drift.
 */
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

  const requireString = (value: unknown, field: string, nonEmpty = true): string => {
    if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
      throw new StoreCorruptError(path, new Error(`${field} must be a non-empty string`))
    }
    return value
  }
  const requireObject = (value: unknown, field: string): Record<string, unknown> => {
    if (!isPlainObject(value)) throw new StoreCorruptError(path, new Error(`${field} must be an object`))
    return value
  }
  const requireStatus = (value: unknown, allowed: ReadonlySet<string>, field: string): void => {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new StoreCorruptError(path, new Error(`${field} is invalid`))
    }
  }
  /**
   * Minimal digest shape. The inner schema is owned by the package/signature
   * validators, but `files` is consumed synchronously by admin approve
   * (`countSignedInstalledEntries`), so a malformed value must be refused at
   * startup instead of surfacing as an approve-time 500.
   */
  const requireDigest = (value: unknown, field: string): void => {
    const digest = requireObject(value, field)
    if (digest.schemaVersion !== 1) {
      throw new StoreCorruptError(path, new Error(`${field}.schemaVersion must be 1`))
    }
    requireString(digest.slug, `${field}.slug`)
    requireString(digest.version, `${field}.version`)
    requireString(digest.manifestSha256, `${field}.manifestSha256`)
    if (!Array.isArray(digest.files)) {
      throw new StoreCorruptError(path, new Error(`${field}.files must be an array`))
    }
    digest.files.forEach((file, index) => {
      const entry = requireObject(file, `${field}.files[${index}]`)
      requireString(entry.path, `${field}.files[${index}].path`)
      if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0) {
        throw new StoreCorruptError(
          path,
          new Error(`${field}.files[${index}].size must be a non-negative number`),
        )
      }
      requireString(entry.sha256, `${field}.files[${index}].sha256`)
    })
  }

  const submissions = document.submissions as Record<string, unknown>
  for (const [key, raw] of Object.entries(submissions)) {
    const record = requireObject(raw, `submissions.${key}`)
    requireString(record.id, `submissions.${key}.id`)
    requireString(record.slug, `submissions.${key}.slug`)
    requireString(record.version, `submissions.${key}.version`)
    requireString(record.submittedAt, `submissions.${key}.submittedAt`)
    requireString(record.updatedAt, `submissions.${key}.updatedAt`)
    requireString(record.actor, `submissions.${key}.actor`)
    requireStatus(record.status, SUBMISSION_STATUSES, `submissions.${key}.status`)
    requireDigest(record.digest, `submissions.${key}.digest`)
    if (record.reason !== undefined) requireString(record.reason, `submissions.${key}.reason`)
    if (record.migrationFrom !== undefined) {
      requireString(record.migrationFrom, `submissions.${key}.migrationFrom`)
    }
  }

  const packages = document.packages as Record<string, unknown>
  for (const [key, raw] of Object.entries(packages)) {
    const record = requireObject(raw, `packages.${key}`)
    const slug = requireString(record.slug, `packages.${key}.slug`)
    const version = requireString(record.version, `packages.${key}.version`)
    if (packageKey(slug, version) !== key) {
      throw new StoreCorruptError(
        path,
        new Error(`packages.${key} does not match its slug/version (${packageKey(slug, version)})`),
      )
    }
    requireStatus(record.status, PACKAGE_STATUSES, `packages.${key}.status`)
    requireObject(record.manifest, `packages.${key}.manifest`)
    requireDigest(record.digest, `packages.${key}.digest`)
    requireObject(record.signature, `packages.${key}.signature`)
    if (typeof record.size !== 'number' || !Number.isFinite(record.size) || record.size < 0) {
      throw new StoreCorruptError(path, new Error(`packages.${key}.size must be a non-negative number`))
    }
    requireString(record.updatedAt, `packages.${key}.updatedAt`)
    requireString(record.actor, `packages.${key}.actor`)
    if (record.migrationFrom !== undefined) {
      requireString(record.migrationFrom, `packages.${key}.migrationFrom`)
    }
  }

  const delistRequests = document.delistRequests as Record<string, unknown>
  for (const [key, raw] of Object.entries(delistRequests)) {
    const record = requireObject(raw, `delistRequests.${key}`)
    const id = requireString(record.id, `delistRequests.${key}.id`)
    if (id !== key) {
      throw new StoreCorruptError(path, new Error(`delistRequests.${key}.id does not match its key`))
    }
    requireString(record.slug, `delistRequests.${key}.slug`)
    requireString(record.version, `delistRequests.${key}.version`)
    requireString(record.reason, `delistRequests.${key}.reason`)
    requireString(record.actor, `delistRequests.${key}.actor`)
    requireString(record.createdAt, `delistRequests.${key}.createdAt`)
    requireStatus(record.status, DELIST_STATUSES, `delistRequests.${key}.status`)
    if (record.resolvedAt !== undefined) requireString(record.resolvedAt, `delistRequests.${key}.resolvedAt`)
  }

  const revocations = document.revocations as Record<string, unknown>
  for (const [key, raw] of Object.entries(revocations)) {
    const record = requireObject(raw, `revocations.${key}`)
    const slug = requireString(record.slug, `revocations.${key}.slug`)
    const version = requireString(record.version, `revocations.${key}.version`)
    if (packageKey(slug, version) !== key) {
      throw new StoreCorruptError(
        path,
        new Error(`revocations.${key} does not match its slug/version (${packageKey(slug, version)})`),
      )
    }
    requireString(record.reason, `revocations.${key}.reason`)
    requireString(record.revokedAt, `revocations.${key}.revokedAt`)
    requireString(record.actor, `revocations.${key}.actor`)
  }

  if (document.lastMutation !== undefined) {
    const mutation = requireObject(document.lastMutation, 'lastMutation')
    requireString(mutation.requestId, 'lastMutation.requestId')
    requireString(mutation.action, 'lastMutation.action')
    requireString(mutation.at, 'lastMutation.at')
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
   * A mutating operation bound to the audit intent of ONE request (Task 4).
   * The request id is stamped onto the draft BEFORE the mutator runs, so the
   * commit and the id always travel together: a crash after the commit lets
   * startup reconciliation decide, from `state.lastMutation`, whether the
   * matching intent actually happened.
   *
   * Only real mutations go through this method; conflict/replay paths return
   * before touching the state and must not fake a commit.
   */
  mutate<T>(
    requestId: string,
    action: string,
    mutator: (draft: CatalogState) => T | Promise<T>,
  ): Promise<T> {
    return this.update(draft => {
      draft.lastMutation = { requestId, action, at: new Date().toISOString() }
      return mutator(draft)
    })
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
