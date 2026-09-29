/**
 * Regenerator for the shared channel-version vectors
 * (../../update-server/tests/fixtures/channel-version-vectors.json).
 *
 * The client (src/update-checker.ts) is the AUTHORITY for the version-shape
 * rule; update-server/src/channels.ts mirrors it because the dependency-direction
 * guard forbids importing across the workspace boundary. Both sides assert
 * against this committed fixture, so a drift on either side fails its own test.
 *
 * Deterministic: no key material, no timestamps — regenerating produces a
 * byte-identical file. (Do NOT model this on market-server/scripts/
 * gen-test-vectors.mjs, which calls generateKeyPair per run and therefore
 * rewrites 93 lines of its fixture every time.)
 *
 * `expected` is the client's real ADMISSION rule, which is two steps, not one:
 * the canonical parse (`parseCanonicalVersion`: the input must equal its own
 * canonical form, so `v0.1.0` and `0.1` are rejected even though parseSemVer
 * tolerates a `v` prefix or a shortened component) followed by the per-channel
 * prerelease shape. Composing only parseSemVer + matchesReleaseChannelVersionShape
 * would claim `v0.1.0` is publishable, while every client caller and
 * update-server's canonical-only matchesChannelVersionShape reject it.
 *
 * Usage: node scripts/gen-channel-version-vectors.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SUPPORTED_RELEASE_CHANNELS, matchesReleaseChannelVersionShape, parseSemVer } from '../src/update-checker.ts'

const VERSIONS = [
  '0.1.0', '0.2.0', '2.0.4', '0.1.0-beta.1', '2.0.6-beta.1',
  '0.1', 'v0.1.0', '0.1.0+mac.arm64', '01.0.0', '1.2.3-01',
] as const

/** The client's private parseCanonicalChannelVersion, mirrored verbatim. */
function isAdmissible(channel: (typeof SUPPORTED_RELEASE_CHANNELS)[number], version: string): boolean {
  const parsed = parseSemVer(version)
  if (parsed === null || parsed.version !== version) return false
  return matchesReleaseChannelVersionShape(channel, parsed)
}

const vectors = SUPPORTED_RELEASE_CHANNELS.flatMap(channel =>
  VERSIONS.map(version => ({
    channel,
    version,
    expected: isAdmissible(channel, version),
  })),
)

const out = join(import.meta.dirname, '../../update-server/tests/fixtures/channel-version-vectors.json')
// 首跑时 update-server/tests/fixtures/ 还不存在(Task 0.2 只建到 tests/,Step 1/2 的
// 字节都在内存里构造),而 writeFileSync 不创建父目录 ⇒ 必须先 mkdir。
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ fixtureVersion: 1, channels: SUPPORTED_RELEASE_CHANNELS, vectors }, null, 2)}\n`)
console.log(`wrote ${out} with ${vectors.length} vectors`)
