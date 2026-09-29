/**
 * Server side of the cross-workspace contract reconciliation.
 *
 * update-server/src/channels.ts mirrors the client's
 * matchesReleaseChannelVersionShape by necessity (the dependency-direction
 * guard forbids importing across the workspace boundary), so both sides assert
 * one committed vector set instead of trusting either implementation:
 * dsh-plugin-huaanwork/tests/update-server-contract.spec.ts reads this same
 * file by path. Regenerate it with
 * `cd dsh-plugin-huaanwork && node scripts/gen-channel-version-vectors.ts`
 * whenever the rule changes, and commit the new fixture with both specs.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UPDATE_SERVER_CHANNELS, matchesChannelVersionShape } from '../src/channels.ts'

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'channel-version-vectors.json'), 'utf8'),
) as {
  fixtureVersion: number
  channels: readonly string[]
  vectors: readonly { channel: string; version: string; expected: boolean }[]
}

describe('release channel version shape (server side)', () => {
  it('pins the shared fixture version', () => {
    expect(FIXTURE.fixtureVersion).toBe(1)
  })

  it('serves exactly the channels the fixture covers', () => {
    expect([...UPDATE_SERVER_CHANNELS].sort()).toEqual([...FIXTURE.channels].sort())
  })

  it('reproduces every shared vector', () => {
    for (const { channel, version, expected } of FIXTURE.vectors) {
      expect(matchesChannelVersionShape(channel as typeof UPDATE_SERVER_CHANNELS[number], version), `${channel} ${version}`)
        .toBe(expected)
    }
  })
})
