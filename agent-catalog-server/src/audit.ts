/**
 * Full-request audit log (Task 4).
 *
 * EVERY request — successful reads, 401 authentication failures, 403 wrong-role
 * refusals, unknown routes, wrong methods, and later the mutating submission /
 * governance routes — is recorded in `${dataDir}/audit.jsonl` BEFORE its
 * response is written. If the audit line cannot be durably written, the server
 * answers 500 `audit-write-failed`; it never lets a request (and therefore a
 * write) succeed unaudited.
 *
 * Append discipline (do not simplify to `appendFile`/single rename):
 *   read the existing file → append ONE complete JSON line → write a temp
 *   file → fsync → rename over the log. A crash can therefore lose at most
 *   the in-flight line; it can never truncate or replace the recorded history
 *   with just the newest record. Writes are serialized by one async queue.
 *
 * Write intents (Task 4 / I-5) live in a SEPARATE `audit-intents.jsonl` and use
 * the same append discipline (their own queue). A mutating request writes its
 * intent BEFORE the handler can commit state; the result line in `audit.jsonl`
 * carries the same `requestId` and closes it. A crash between the state commit
 * and the result line therefore leaves an intent behind, and startup
 * reconciliation (`reconcile`) appends the missing result line — determined by
 * `state.lastMutation` — so no successful change can stay unaudited. Keeping
 * intents out of `audit.jsonl` preserves the exact line-count contract of the
 * result log.
 *
 * Actor disclosure: the raw token never reaches the log. `actor` is only the
 * first 12 hex characters of the token's SHA-256 (`anonymous` when absent),
 * which lets an operator correlate requests from one credential without
 * storing the credential itself. `redactSecrets` additionally strips all three
 * configured token values and any PEM private-key block from free text before
 * it is serialized — a handler that echoes a token/path/error must not leak it.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open as openFile, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { CatalogState } from './types.ts'

export const AUDIT_FILE_NAME = 'audit.jsonl'
export const AUDIT_INTENTS_FILE_NAME = 'audit-intents.jsonl'
export const AUDIT_FILE_MODE = 0o600

export type AuditOutcome = 'ok' | 'denied' | 'error'

/**
 * A mutating request's durable intent. It carries no outcome/status: the result
 * line with the SAME `requestId` closes it, or startup reconciliation does.
 */
export interface AuditIntent {
  readonly action: string
  readonly actor: string
  readonly requestId: string
  readonly slug?: string
  readonly version?: string
  readonly submissionId?: string
  readonly delistRequestId?: string
}

/** One intent line as written: the intent plus the time it was decided. */
interface AuditIntentRecord extends AuditIntent {
  readonly timestamp: string
}

export interface AuditEvent {
  /** Stable dotted action, e.g. `catalog.list`, `agentPackages.submissions.create`. */
  readonly action: string
  readonly outcome: AuditOutcome
  /** HTTP status of the response that follows this record. */
  readonly status: number
  /** 12-hex token hash prefix, or `anonymous`. */
  readonly actor: string
  /**
   * Correlates this result line with its durable write intent (Task 4). Set for
   * every request; only mutating requests have a matching intent line.
   */
  readonly requestId?: string
  readonly slug?: string
  readonly version?: string
  readonly submissionId?: string
  /** Delist request id (Task 6); never a submission id. */
  readonly delistRequestId?: string
  /** Human-readable cause; ALWAYS redacted before serialization. */
  readonly reason?: string
}

export interface AuditRecord extends AuditEvent {
  /** ISO 8601 UTC time at which the request was audited. */
  readonly timestamp: string
}

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
const UNTERMINATED_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/u

/**
 * Replace every configured token value and every PEM private-key block.
 * Applied to each free-text field (and thus to `reason`) before JSON encoding,
 * so the replacement cannot break the line's JSON syntax.
 *
 * Substitution is LONGEST-FIRST: when one configured token is a prefix of
 * another, replacing the shorter one first would leave the longer token's tail
 * (`…-extended`) in the output. Sorting by descending length makes the longest
 * value win regardless of configuration order; equal lengths keep their order.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED PRIVATE KEY]')
    .replace(UNTERMINATED_PRIVATE_KEY_PATTERN, '[REDACTED PRIVATE KEY]')
  const ordered = [...new Set(secrets.filter(secret => secret !== ''))].sort(
    (left, right) => right.length - left.length,
  )
  for (const secret of ordered) {
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
}

export class AuditLog {
  readonly path: string

  private readonly intentsPath: string
  private readonly secrets: readonly string[]
  private tail: Promise<void> = Promise.resolve()
  /** The intent journal has its own queue: the two files never interleave. */
  private intentTail: Promise<void> = Promise.resolve()
  /**
   * Fail-closed latch: after the first failed append the log is considered
   * unavailable until restart. Serving a write request while auditing is
   * broken would be exactly the "silently continue without an audit line"
   * behaviour this class exists to prevent.
   */
  private failure: Error | null = null

  private constructor(dataDir: string, secrets: readonly string[]) {
    this.path = join(dataDir, AUDIT_FILE_NAME)
    this.intentsPath = join(dataDir, AUDIT_INTENTS_FILE_NAME)
    this.secrets = secrets
  }

  /**
   * Open the log at `${dataDir}/audit.jsonl`. The data directory is created if
   * needed (the state store usually wins the race; both are idempotent).
   */
  static async open(dataDir: string, secrets: readonly string[]): Promise<AuditLog> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    return new AuditLog(dataDir, secrets.map(secret => secret).filter(secret => secret !== ''))
  }

  /** True after an append failed; callers must refuse further writes. */
  get unavailable(): boolean {
    return this.failure !== null
  }

  /**
   * Append one record. Calls are serialized; the returned promise resolves
   * only after the new log file has been fsynced and renamed into place.
   */
  writeAudit(event: AuditEvent): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure)
    const record = this.sanitize(event)
    const run = this.tail.then(
      () => this.appendTracked(record),
      () => this.appendTracked(record),
    )
    // The queue must survive a failed append; the failure still reaches the
    // caller through `run`.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Append one durable write intent to `audit-intents.jsonl` BEFORE a mutating
   * handler runs. Same read+append+tmp+fsync+rename discipline as `writeAudit`;
   * a rejection means the request must be refused with 500 and the handler must
   * not run. Intent failures do not latch the result log — the caller refuses
   * this one write, while reads keep a working audit trail.
   */
  writeIntent(intent: AuditIntent): Promise<void> {
    const record = this.sanitizeIntent(intent)
    const run = this.intentTail.then(
      () => this.appendLine(this.intentsPath, record),
      () => this.appendLine(this.intentsPath, record),
    )
    this.intentTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Close every intent that has no result line yet (Task 4 / I-5). Called once
   * at startup, AFTER the state store was opened: an intent is `ok` only when
   * `state.lastMutation` names its request id, otherwise the change never
   * committed and the honest result is a 500. Malformed journal lines are
   * skipped, exactly like a malformed result line.
   */
  async reconcile(state: CatalogState): Promise<void> {
    const readLines = async (path: string): Promise<string[]> => {
      try {
        return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw cause
      }
    }
    const intentLines = await readLines(this.intentsPath)
    const resultLines = await readLines(this.path)
    const intents = new Map<string, AuditIntent & { timestamp: string }>()
    const results = new Set<string>()
    for (const line of intentLines) {
      try {
        const intent = JSON.parse(line) as AuditIntent & { timestamp: string }
        if (typeof intent.requestId === 'string') intents.set(intent.requestId, intent)
      } catch {
        // A torn intent line means the crash happened before the intent was
        // durable; the handler therefore cannot have run. Nothing to close.
      }
    }
    for (const line of resultLines) {
      try {
        const record = JSON.parse(line) as AuditRecord
        if (typeof record.requestId === 'string') results.add(record.requestId)
      } catch {
        // Skip malformed result lines; reconciliation is best-effort forensics.
      }
    }
    for (const [requestId, intent] of intents) {
      if (results.has(requestId)) continue
      const committed = state.lastMutation?.requestId === requestId
      await this.writeAudit({
        action: intent.action,
        outcome: committed ? 'ok' : 'error',
        status: committed ? 200 : 500,
        actor: intent.actor,
        requestId,
        ...(intent.slug === undefined ? {} : { slug: intent.slug }),
        ...(intent.version === undefined ? {} : { version: intent.version }),
        ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
        ...(intent.delistRequestId === undefined ? {} : { delistRequestId: intent.delistRequestId }),
        reason: committed
          ? 'reconciled after restart: state.lastMutation matches the intent'
          : 'reconciled after restart: the intent did not commit',
      })
    }
  }

  private async appendTracked(record: AuditRecord): Promise<void> {
    try {
      await this.append(record)
    } catch (cause) {
      this.failure = cause instanceof Error ? cause : new Error(String(cause))
      throw this.failure
    }
  }

  private sanitize(event: AuditEvent): AuditRecord {
    const record: {
      timestamp: string
      action: string
      outcome: AuditOutcome
      status: number
      actor: string
      requestId?: string
      slug?: string
      version?: string
      submissionId?: string
      delistRequestId?: string
      reason?: string
    } = {
      timestamp: new Date().toISOString(),
      action: redactSecrets(event.action, this.secrets),
      outcome: event.outcome,
      status: event.status,
      actor: redactSecrets(event.actor, this.secrets),
    }
    if (event.requestId !== undefined) record.requestId = redactSecrets(event.requestId, this.secrets)
    if (event.slug !== undefined) record.slug = redactSecrets(event.slug, this.secrets)
    if (event.version !== undefined) record.version = redactSecrets(event.version, this.secrets)
    if (event.submissionId !== undefined) {
      record.submissionId = redactSecrets(event.submissionId, this.secrets)
    }
    if (event.delistRequestId !== undefined) {
      record.delistRequestId = redactSecrets(event.delistRequestId, this.secrets)
    }
    if (event.reason !== undefined) record.reason = redactSecrets(event.reason, this.secrets)
    return record
  }

  private sanitizeIntent(intent: AuditIntent): AuditIntentRecord {
    const record: {
      timestamp: string
      action: string
      actor: string
      requestId: string
      slug?: string
      version?: string
      submissionId?: string
      delistRequestId?: string
    } = {
      timestamp: new Date().toISOString(),
      action: redactSecrets(intent.action, this.secrets),
      actor: redactSecrets(intent.actor, this.secrets),
      requestId: redactSecrets(intent.requestId, this.secrets),
    }
    if (intent.slug !== undefined) record.slug = redactSecrets(intent.slug, this.secrets)
    if (intent.version !== undefined) record.version = redactSecrets(intent.version, this.secrets)
    if (intent.submissionId !== undefined) {
      record.submissionId = redactSecrets(intent.submissionId, this.secrets)
    }
    if (intent.delistRequestId !== undefined) {
      record.delistRequestId = redactSecrets(intent.delistRequestId, this.secrets)
    }
    return record
  }

  private async append(record: AuditRecord): Promise<void> {
    await this.appendLine(this.path, record)
  }

  /**
   * The one append discipline both files use: read → append one complete JSON
   * line → temp file → fsync → rename. Callers serialize per file.
   */
  private async appendLine(path: string, record: object): Promise<void> {
    const existing = await readFile(path, 'utf8').catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return ''
      throw cause
    })
    // Keep the log line-oriented even if the previous writer died mid-line.
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
    const payload = `${prefix}${JSON.stringify(record)}\n`

    const tempPath = `${path}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`
    const handle = await openFile(tempPath, 'w', AUDIT_FILE_MODE)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, path)
  }
}
