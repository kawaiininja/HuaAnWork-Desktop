/**
 * CLI conveniences for the market-server entry point (Task 3.5).
 *
 * Deployment configuration lives in the environment (D4 contract); the two
 * flags exist so an operator running `src/index.ts` by hand - or through the
 * registered `bin` - does not have to export both required values first.
 * `loadConfig` keeps the environment authoritative: an env value always wins
 * over the same-named override.
 */

/**
 * CLI conveniences. The environment stays authoritative: deployment config is
 * the source of truth, and a stray --port must not silently override it.
 */
export function parseServerArgv(argv: readonly string[]): Partial<Record<'port' | 'dataDir', string>> {
  const parsed: Partial<Record<'port' | 'dataDir', string>> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== '--port' && flag !== '--data') continue
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    parsed[flag === '--port' ? 'port' : 'dataDir'] = value
    index += 1
  }
  return parsed
}
