import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const EXPECTED = JSON.parse(readFileSync(join(import.meta.dirname, 'expected-root-gate-scripts.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))

test('the shared gate-script fixture equals the root manifest', () => {
  assert.strictEqual(EXPECTED.fixtureVersion, 3)
  assert.strictEqual(manifest.scripts.build, EXPECTED.build)
  assert.strictEqual(manifest.scripts.typecheck, EXPECTED.typecheck)
  assert.strictEqual(manifest.scripts.test, EXPECTED.test)
  assert.strictEqual(manifest.scripts.check, EXPECTED.check)
})
