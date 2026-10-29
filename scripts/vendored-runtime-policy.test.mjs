import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { marketPeerRange, ownsMarketRuntime } from './vendored-runtime-policy.mjs'

function policyDocument(stableHistorical, dormantAlpha1) {
  return {
    activeChannel: 'huaanwork',
    marketPeerPolicy: { stableHistorical, dormantAlpha1 },
    channels: { huaanwork: { sourceVersion: '0.2.1-rc.1' } },
  }
}

test('constructs the peer range only from HuaAnWork and explicit historical policy', () => {
  assert.equal(marketPeerRange(policyDocument('retain', 'retain')), '0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1')
  assert.equal(marketPeerRange(policyDocument('retain', 'retire')), '0.2.0-rc.2 || 0.2.1-rc.1')
  assert.equal(marketPeerRange(policyDocument('retire', 'retain')), '0.2.1-rc.1 || 0.2.1-alpha.1')
  assert.equal(marketPeerRange(policyDocument('retire', 'retire')), '0.2.1-rc.1')
  assert.throws(() => marketPeerRange(policyDocument('unknown', 'retire')), /marketPeerPolicy/u)
  assert.throws(() => marketPeerRange({ activeChannel: 'huaanwork', channels: {} }), /HuaAnWork/u)
})

test('the real metadata has only HuaAnWork and the ruled peer policy', () => {
  const document = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(document.channels), ['huaanwork'])
  assert.deepEqual(document.marketPeerPolicy, { stableHistorical: 'retain', dormantAlpha1: 'retire' })
  assert.equal(ownsMarketRuntime(document.activeChannel), true)
  assert.equal(marketPeerRange(document), '0.2.0-rc.2 || 0.2.1-rc.1')
})
