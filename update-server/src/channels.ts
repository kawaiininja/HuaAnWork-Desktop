/**
 * Release-channel version shapes, mirroring dsh-plugin-huaanwork's
 * matchesReleaseChannelVersionShape (src/update-checker.ts).
 *
 * The dependency-direction guard forbids importing across the workspace
 * boundary, so this is a second implementation by necessity. The two are kept
 * honest by dsh-plugin-huaanwork/tests/update-server-contract.spec.ts, which
 * asserts both sides against one shared vector set.
 */

/** Release streams this server publishes and answers for. */
export type UpdateServerChannel = 'stable' | 'beta' | 'huaanwork'

/** Every channel this server serves, in declaration order. */
export const UPDATE_SERVER_CHANNELS: readonly UpdateServerChannel[] = Object.freeze([
  'stable',
  'beta',
  'huaanwork',
] as const)

/** Whether a value names a channel this server serves. */
export function isUpdateServerChannel(value: unknown): value is UpdateServerChannel {
  return typeof value === 'string' && (UPDATE_SERVER_CHANNELS as readonly string[]).includes(value)
}

// Identical to the client's SEMVER_PATTERN: numeric components without leading
// zeros, prerelease identifiers `[0-9A-Za-z-]+`, optional ignored build metadata.
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Whether this exact version string may be published and served for a channel.
 *
 * Mirrors the client's two-step rule in one string-input function: canonical
 * parse (the input must equal its own canonical form, so a `v` prefix or a
 * shortened `0.1` is rejected) followed by the per-channel prerelease shape.
 * `stable` and `huaanwork` take plain releases; `beta` takes exactly
 * `-beta.<numeric>`.
 *
 * The switch has no default branch on purpose - adding a fourth channel must
 * fail typecheck here rather than silently inherit beta's shape (same rule as
 * the client's matchesReleaseChannelVersionShape).
 *
 * @param channel - release stream that must accept the version.
 * @param version - complete version string, e.g. `0.2.0` or `2.0.6-beta.1`.
 * @returns whether the version shape fits the channel.
 */
export function matchesChannelVersionShape(channel: UpdateServerChannel, version: string): boolean {
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return false
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return false

  switch (channel) {
    case 'stable':
    case 'huaanwork':
      return prerelease.length === 0
    case 'beta':
      return prerelease.length === 2
        && prerelease[0] === 'beta'
        && isNumeric(prerelease[1]!)
  }
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}
