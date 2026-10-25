/**
 * Secret redaction shared by the offline administrator CLI (Task 7 / I-8).
 *
 * The CLI prints server-provided free text: the whole manifest on `review`
 * (a `description` is operator-authored), and remote error bodies / URLs on
 * every failure path. Any of those can contain a token value the operator
 * configured or a PEM private-key block, so every write to stdout/stderr goes
 * through {@link redactSecrets} (see the `safeIo` wrapper in `cli.ts`).
 *
 * This is a DELIBERATE COPY of `redactSecrets` in
 * `agent-catalog-server/src/audit.ts`: the admin CLI must never depend on the
 * server package (it is an offline tool that runs where the server is not
 * installed), so the helper is duplicated instead of imported. The two copies
 * MUST stay behaviorally identical — same PEM patterns, same longest-first
 * substitution, same `[REDACTED]` / `[REDACTED PRIVATE KEY]` markers. The
 * acceptance probe keeps a third copy in
 * `dsh-plugin-huaanwork/scripts/acceptance-redaction.mjs` for the same reason.
 */

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
const UNTERMINATED_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/u

/**
 * Replace every configured token value and every PEM private-key block.
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
