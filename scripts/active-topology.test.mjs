import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

test('upstream.json carries exactly the supported top-level keys', () => {
  const upstream = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(upstream).sort(), ['activeChannel', 'channels', 'marketPeerPolicy', 'repository'])
  assert.equal(upstream.activeChannel, 'huaanwork')
})

test('no reference-only script survives', () => {
  assert.deepEqual(readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.reference.mjs')), [])
})

test('reference-only desktop tools do not re-enter the root test glob', () => {
  const tests = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs'))
  for (const retired of [
    'verify-desktop-variants.test.mjs',
    'export-app-icons.test.mjs',
    'inspector-compat.test.mjs',
  ]) assert.equal(tests.includes(retired), false, `${retired} must not run in the single-desktop root test glob`)
  // The selective-review dashboard is a live, hermetic report: its test belongs in the root glob.
  assert.equal(tests.includes('upstream-sync-dashboard.test.mjs'), true)
})

test('reference desktop implementations and their dedicated tools are gone', () => {
  for (const path of [
    'verify-desktop-variants.mjs',
    'classify-variant-tests-drift.mjs',
    'export-app-icons.mjs',
    'upstream-merge-spike.mjs',
    'verify-desktop-onboarding-browser.mjs',
    'verify-desktop-variants.reference.mjs',
    'export-app-icons.reference.mjs',
    'inspector-compat.reference.mjs',
    'upstream-sync-dashboard.reference.mjs',
  ]) assert.equal(existsSync(new URL(path, import.meta.url)), false, path)
})
