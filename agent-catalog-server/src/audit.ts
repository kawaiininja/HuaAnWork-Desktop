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

export const AUDIT_FILE_NAME = 'audit.jsonl'
export const AUDIT_FILE_MODE = 0o600

export type AuditOutcome = 'ok' | 'denied' | 'error'

export interface AuditEvent {
  /** Stable dotted action, e.g. `catalog.list`, `agentPackages.submissions.create`. */
  readonly action: string
  readonly outcome: AuditOutcome
  /** HTTP status of the response that follows this record. */
  readonly status: number
  /** 12-hex token hash prefix, or `anonymous`. */
  readonly actor: string
  readonly slug?: string
  readonly version?: string
  readonly submissionId?: string
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
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED PRIVATE KEY]')
    .replace(UNTERMINATED_PRIVATE_KEY_PATTERN, '[REDACTED PRIVATE KEY]')
  for (const secret of secrets) {
    if (secret === '') continue
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
}

export class AuditLog {
  readonly path: string

  private readonly secrets: readonly string[]
  private tail: Promise<void> = Promise.resolve()
  /**
   * Fail-closed latch: after the first failed append the log is considered
   * unavailable until restart. Serving a write request while auditing is
   * broken would be exactly the "silently continue without an audit line"
   * behaviour this class exists to prevent.
   */
  private failure: Error | null = null

  private constructor(path: string, secrets: readonly string[]) {
    this.path = path
    this.secrets = secrets
  }

  /**
   * Open the log at `${dataDir}/audit.jsonl`. The data directory is created if
   * needed (the state store usually wins the race; both are idempotent).
   */
  static async open(dataDir: string, secrets: readonly string[]): Promise<AuditLog> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    return new AuditLog(join(dataDir, AUDIT_FILE_NAME), secrets.map(secret => secret).filter(secret => secret !== ''))
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
      slug?: string
      version?: string
      submissionId?: string
      reason?: string
    } = {
      timestamp: new Date().toISOString(),
      action: redactSecrets(event.action, this.secrets),
      outcome: event.outcome,
      status: event.status,
      actor: redactSecrets(event.actor, this.secrets),
    }
    if (event.slug !== undefined) record.slug = redactSecrets(event.slug, this.secrets)
    if (event.version !== undefined) record.version = redactSecrets(event.version, this.secrets)
    if (event.submissionId !== undefined) {
      record.submissionId = redactSecrets(event.submissionId, this.secrets)
    }
    if (event.reason !== undefined) record.reason = redactSecrets(event.reason, this.secrets)
    return record
  }

  private async append(record: AuditRecord): Promise<void> {
    const existing = await readFile(this.path, 'utf8').catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return ''
      throw cause
    })
    // Keep the log line-oriented even if the previous writer died mid-line.
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
    const payload = `${prefix}${JSON.stringify(record)}\n`

    const tempPath = `${this.path}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`
    const handle = await openFile(tempPath, 'w', AUDIT_FILE_MODE)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, this.path)
  }
}
