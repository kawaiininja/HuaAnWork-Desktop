/**
 * Secret redaction shared by the M2 agent-package acceptance probe (Task 7 /
 * I-8).
 *
 * The probe shells out to the offline admin CLI and records whatever that
 * process printed into a failure report. That output is untrusted free text: a
 * manifest `description`, a remote error body, a temp path. Any of it can carry
 * one of the per-run tokens or a PEM private-key block, and the report is
 * written to `--out` AND to stdout (CI logs), so it must be redacted first.
 *
 * This is a DELIBERATE COPY of `redactSecrets` in
 * `agent-catalog-server/src/audit.ts` (and of `agent-catalog-admin/src/redaction.ts`).
 * The three copies MUST stay behaviorally identical — same PEM patterns, same
 * longest-first substitution, same `[REDACTED]` / `[REDACTED PRIVATE KEY]`
 * markers. The probe lives outside every workspace, so it cannot import any of
 * them.
 */

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
const UNTERMINATED_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/u

/** A PEM private-key header, terminated or not. */
const PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u

/**
 * Replace every configured token value and every PEM private-key block.
 *
 * Substitution is LONGEST-FIRST: when one configured token is a prefix of
 * another, replacing the shorter one first would leave the longer token's tail
 * (`…-extended`) in the output. Sorting by descending length makes the longest
 * value win regardless of configuration order; equal lengths keep their order.
 */
export function redactSecrets(text, secrets) {
  let redacted = String(text)
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED PRIVATE KEY]')
    .replace(UNTERMINATED_PRIVATE_KEY_PATTERN, '[REDACTED PRIVATE KEY]')
  const ordered = [...new Set(secrets.filter((secret) => secret !== ''))].sort(
    (left, right) => right.length - left.length,
  )
  for (const secret of ordered) {
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
}

/** True when `text` still carries a PEM private-key header. */
export function containsPrivateKey(text) {
  return PRIVATE_KEY_HEADER_PATTERN.test(String(text))
}

/**
 * Deep-redact a report object: every string value (including array items and
 * nested objects) passes through {@link redactSecrets}, so no free-text field —
 * `error`, `blocked`, `cleanup.error`, the `negatives.*` messages, a logged CLI
 * line embedded in a step — can leak into the JSON or stdout. Structure and
 * non-string values are preserved.
 */
export function redactReport(value, secrets) {
  if (typeof value === 'string') return redactSecrets(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactReport(item, secrets))
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = redactReport(item, secrets)
    return result
  }
  return value
}
