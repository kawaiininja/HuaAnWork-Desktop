import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'

test('reference-only desktop tools do not re-enter the root test glob', () => {
  const tests = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs'))
  for (const retired of [
    'verify-desktop-variants.test.mjs',
    'export-app-icons.test.mjs',
    'inspector-compat.test.mjs',
    'upstream-sync-dashboard.test.mjs',
  ]) assert.equal(tests.includes(retired), false, `${retired} must not run in Phase A`)
})
