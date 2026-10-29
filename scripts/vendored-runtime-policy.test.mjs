import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { marketPeerRange, ownsMarketRuntime } from './vendored-runtime-policy.mjs'

const document = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))

test('HuaAnWork owns market runtime checks without changing the Phase A peer range', () => {
  assert.equal(document.activeChannel, 'huaanwork')
  assert.deepEqual(Object.keys(document.channels).sort(), ['beta', 'huaanwork', 'stable'])
  assert.equal(ownsMarketRuntime('huaanwork'), true)
  assert.equal(ownsMarketRuntime('beta'), false)
  assert.equal(ownsMarketRuntime('stable'), false)
  assert.equal(marketPeerRange(document), '0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1')
})
