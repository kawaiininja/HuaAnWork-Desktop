/** Headless version checks against the public DSH Desktop release service. */

import {
  assertDesktopInstallationId,
  DESKTOP_INSTALLATION_ID_HEADER,
  type DesktopInstallationId,
} from './desktop-installation-id.ts'

/**
 * Deployment-configured intranet origin serving this product's release channel.
 *
 * The placeholder is unreachable by construction: an unconfigured deployment
 * fails every version check closed instead of querying the upstream DSH public
 * service, which does not answer for the huaanwork channel and would only leak
 * installation metadata. Set HUAANWORK_UPDATE_ORIGIN at release provisioning.
 */
export const HUAANWORK_UPDATE_DEFAULT_ORIGIN = 'http://update.intranet.example:8790'

/** Environment variable carrying the deployment update origin. */
export const HUAANWORK_UPDATE_ORIGIN_ENV = 'HUAANWORK_UPDATE_ORIGIN'

/** Raised when the configured update origin cannot be used as an absolute base. */
export class UpdateOriginError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UpdateOriginError'
  }
}

/** Normalize the deployment update origin, rejecting anything that is not a bare absolute http(s) base. */
export function resolveUpdateOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[HUAANWORK_UPDATE_ORIGIN_ENV] ?? HUAANWORK_UPDATE_DEFAULT_ORIGIN).trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch (cause) {
    throw new UpdateOriginError('The update origin must be an absolute http(s) URL.', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpdateOriginError('The update origin must use http or https.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new UpdateOriginError('The update origin must not embed credentials.')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UpdateOriginError('The update origin must not include a path.')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new UpdateOriginError('The update origin must not include a query or fragment.')
  }
  return url.origin
}

/** Absolute version-check endpoint for one deployment origin. */
export function desktopVersionEndpoint(origin: string = resolveUpdateOrigin()): string {
  return `${origin}/api/desktop/version`
}

/** Header carrying the installed Desktop version to the fixed version endpoint. */
export const DESKTOP_CURRENT_VERSION_HEADER = 'X-DSH-Desktop-Version'

/** Header selecting an isolated Desktop release stream. */
export const DESKTOP_RELEASE_CHANNEL_HEADER = 'X-DSH-Desktop-Channel'

/** Release streams supported by the Desktop service. */
export type DesktopReleaseChannel = 'stable' | 'beta' | 'huaanwork'

/** Every channel this build can validate a version against, in declaration order. */
export const SUPPORTED_RELEASE_CHANNELS: readonly DesktopReleaseChannel[] = ['stable', 'beta', 'huaanwork']

/** Maximum response body bytes accepted from the version service. */
export const MAX_VERSION_RESPONSE_BYTES = 4 * 1024

/** Strictly parsed SemVer components. Numeric components remain strings to avoid overflow. */
export interface ParsedSemVer {
  /** Canonical version without the optional leading `v`. */
  readonly version: string
  /** Major numeric identifier. */
  readonly major: string
  /** Minor numeric identifier. */
  readonly minor: string
  /** Patch numeric identifier. */
  readonly patch: string
  /** Ordered prerelease identifiers, or an empty list for a stable version. */
  readonly prerelease: readonly string[]
  /** Build identifiers, ignored for version precedence. */
  readonly build: readonly string[]
}

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one channel-scoped version check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as canonical SemVer. */
  readonly currentVersion: string
  /** Release stream that must be returned by the service. */
  readonly channel: DesktopReleaseChannel
  /** Channel of the installed application when explicitly switching streams. */
  readonly currentChannel?: DesktopReleaseChannel
  /** Treat a different older version as selectable for an explicit channel switch. */
  readonly allowDowngrade?: boolean
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
  /** Installation UUID attached only to the fixed version-check endpoint. */
  readonly installationId?: DesktopInstallationId
  /** Deployment update origin; defaults to the HUAANWORK_UPDATE_ORIGIN environment. */
  readonly origin?: string
}

/** Successful comparison returned by the stable version service. */
export type UpdateCheckResult = {
  /** Whether the service reports a version newer than the installed application. */
  readonly status: 'up-to-date' | 'update-available'
  /** Canonical installed version, including any prerelease identifiers. */
  readonly currentVersion: string
  /** Canonical latest stable version returned by the service. */
  readonly latestVersion: string
  /**
   * D-M6-23 channel-record passthrough. Upstream only models the two desktop
   * installer platforms (see installerSha256); this field preserves the full,
   * hex-validated multi-artifact digest record the huaanwork channel publishes.
   * parseVersionResponse fails the whole check closed if any entry is malformed.
   */
  readonly sha256?: Readonly<Record<string, string>>
  /**
   * Optional per-platform hex SHA-256 digests of the published installers.
   * Whenever the service publishes them, the download path enforces them as
   * a hard integrity gate before execution; they are optional only because
   * the version endpoint does not publish digests yet.
   */
  readonly installerSha256?: Readonly<Partial<Record<'win32' | 'darwin', string>>>
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Parse strict SemVer with an optional lowercase `v` prefix.
 * @param input - complete version or release tag.
 * @returns parsed identifiers, or null when the input is not valid SemVer.
 */
export function parseSemVer(input: string): ParsedSemVer | null {
  const version = input.startsWith('v') ? input.slice(1) : input
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return null

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return null

  return {
    version,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Compare two strict SemVer strings without numeric overflow.
 * @param left - first strict SemVer value.
 * @param right - second strict SemVer value.
 * @returns negative, zero, or positive precedence, or null when either value is invalid.
 */
export function compareSemVerVersions(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left)
  const rightVersion = parseSemVer(right)
  if (leftVersion === null || rightVersion === null) return null
  return compareParsedSemVer(leftVersion, rightVersion)
}

/**
 * Check the fixed DSH Desktop version endpoint for a release in one channel.
 * @param options - installed version, caller-owned signal, and optional request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForDesktopUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const current = parseCanonicalChannelVersion(
    options.currentVersion,
    options.currentChannel ?? options.channel,
  )
  if (current === null) return null

  let headers: HeadersInit
  try {
    headers = desktopVersionRequestHeaders(options.installationId, current.version, options.channel)
  } catch {
    return null
  }

  const init: RequestInit = {
    method: 'GET',
    headers,
    cache: 'no-store',
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const request = options.request ?? defaultRequest

  let response: Response
  try {
    response = await request(desktopVersionEndpoint(options.origin), init)
  } catch {
    return null
  }
  if (response.status !== 200) return null

  let body: string
  try {
    body = await readLimitedBody(response)
  } catch {
    return null
  }

  let digestInput: unknown
  try {
    digestInput = JSON.parse(body)
  } catch {
    digestInput = undefined
  }
  const latest = parseVersionResponse(body, options.channel)
  if (latest === null) return null
  const comparison = compareParsedSemVer(latest, current)
  const digests = parseInstallerDigestResponse(digestInput)
  return {
    status: comparison > 0 || (options.allowDowngrade === true && comparison !== 0)
      ? 'update-available'
      : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
    ...(latest.sha256 === undefined ? {} : { sha256: latest.sha256 }),
    ...(digests === undefined ? {} : { installerSha256: digests }),
  }
}

/** Backward-compatible stable-channel entry point for existing callers. */
export function checkForStableUpdate(
  options: Omit<UpdateCheckOptions, 'channel'>,
): Promise<UpdateCheckResult | null> {
  return checkForDesktopUpdate({ ...options, channel: 'stable' })
}

/** Build the complete header set for the fixed version-check request only. */
export function desktopVersionRequestHeaders(
  installationId?: string,
  currentVersion?: string,
  channel?: DesktopReleaseChannel,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (channel !== undefined) headers[DESKTOP_RELEASE_CHANNEL_HEADER] = channel
  if (currentVersion !== undefined) {
    const parsed = channel === undefined
      ? parseCanonicalChannelVersion(currentVersion, 'stable')
      : parseCanonicalSupportedVersion(currentVersion)
    if (parsed === null) {
      throw new Error(channel === undefined
        ? 'Desktop current version must be canonical stable SemVer.'
        : 'Desktop current version must be canonical SemVer.')
    }
    headers[DESKTOP_CURRENT_VERSION_HEADER] = parsed.version
  }
  if (installationId !== undefined) {
    headers[DESKTOP_INSTALLATION_ID_HEADER] = assertDesktopInstallationId(installationId)
  }
  return headers
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_VERSION_RESPONSE_BYTES)) {
    throw new Error('version response is too large')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > MAX_VERSION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('version response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseVersionResponse(
  body: string,
  expectedChannel: DesktopReleaseChannel,
): (ParsedSemVer & { readonly sha256?: Readonly<Record<string, string>> }) | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.version !== 'string') return null
  // beta 与 huaanwork 都要求服务端显式回显通道标签:未配置该通道的服务端因此恒返回 null(fail-closed)
  if (expectedChannel !== 'stable' && value.channel !== expectedChannel) return null
  if (value.channel !== undefined && value.channel !== expectedChannel) return null

  // D-M6-23 channel-record integrity: a published digest record must be a hex-
  // validated object or the whole check fails closed (replayed fork semantic
  // upstream does not carry). Each entry is first normalized the same way the
  // shared stable/beta extractor normalizes (trim + lowercase) so an uppercase
  // or whitespace-padded but otherwise valid digest is accepted, not rejected;
  // only entries invalid after normalization trip the fail-closed rejection.
  // Valid records flow through to installerSha256 via the shared
  // parseInstallerDigestResponse extractor below.
  let sha256: Record<string, string> | undefined
  if (value.sha256 !== undefined) {
    if (!isRecord(value.sha256)) return null
    sha256 = {}
    for (const [platform, hash] of Object.entries(value.sha256)) {
      if (typeof hash !== 'string') return null
      const normalized = hash.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/u.test(normalized)) return null
      sha256[platform] = normalized
    }
  }

  const parsed = parseCanonicalChannelVersion(value.version, expectedChannel)
  if (parsed === null) return null
  return sha256 === undefined ? parsed : Object.assign(parsed, { sha256 })
}

/**
 * Version-shape rule for one release stream.
 *
 * `huaanwork` mirrors `stable`: canonical SemVer with no prerelease identifiers.
 * The exhaustive switch has no default branch on purpose - adding a fourth
 * channel must fail typecheck here rather than silently inherit beta's shape.
 */
export function matchesReleaseChannelVersionShape(
  channel: DesktopReleaseChannel,
  parsed: ParsedSemVer,
): boolean {
  switch (channel) {
    case 'stable':
    case 'huaanwork':
      return parsed.prerelease.length === 0
    case 'beta':
      return parsed.prerelease.length === 2
        && parsed.prerelease[0] === 'beta'
        && isNumeric(parsed.prerelease[1]!)
  }
}

export function parseCanonicalChannelVersion(
  input: string,
  channel: DesktopReleaseChannel,
): ParsedSemVer | null {
  const parsed = parseCanonicalVersion(input)
  if (parsed === null) return null
  return matchesReleaseChannelVersionShape(channel, parsed) ? parsed : null
}

/**
 * Extract optional per-platform installer digests from the parsed version
 * response: `{ "version": "2.0.2", "sha256": { "windows": "<hex>", "mac": "<hex>" } }`.
 * Hex digits are case-normalized; absent or malformed fields simply leave the
 * digest gate unset for that platform.
 */
function parseInstallerDigestResponse(value: unknown): UpdateCheckResult['installerSha256'] | undefined {
  if (!isRecord(value) || !isRecord(value.sha256)) return undefined
  const digests: Partial<Record<'win32' | 'darwin', string>> = {}
  const normalize = (digest: unknown): string | undefined => {
    if (typeof digest !== 'string') return undefined
    const normalized = digest.trim().toLowerCase()
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : undefined
  }
  const windows = normalize(value.sha256.windows ?? value.sha256.win32)
  const mac = normalize(value.sha256.mac ?? value.sha256.darwin)
  if (windows !== undefined) digests.win32 = windows
  if (mac !== undefined) digests.darwin = mac
  return Object.keys(digests).length > 0 ? digests : undefined
}

function parseCanonicalSupportedVersion(input: string): ParsedSemVer | null {
  const parsed = parseCanonicalVersion(input)
  if (parsed === null) return null
  return SUPPORTED_RELEASE_CHANNELS.some(channel => matchesReleaseChannelVersionShape(channel, parsed))
    ? parsed
    : null
}

function parseCanonicalVersion(input: string): ParsedSemVer | null {
  const parsed = parseSemVer(input)
  return parsed !== null && parsed.version === input ? parsed : null
}

function compareParsedSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumeric(leftIdentifier)
    const rightNumeric = isNumeric(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
