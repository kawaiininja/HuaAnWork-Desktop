import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const scriptsDir = import.meta.dirname
const EXPECTED = JSON.parse(readFileSync(join(scriptsDir, 'expected-root-gate-scripts.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(scriptsDir, '..', 'package.json'), 'utf8'))
const rootScripts = manifest.scripts

// `yarn <script>` as a whole token, so `yarn workspace <pkg> <script>` resolves to
// `workspace` (not a root script) instead of being mistaken for a script reference.
const YARN_REFERENCE = /(?:^|[\s;&|])yarn\s+(?!-)([A-Za-z0-9@][A-Za-z0-9@:._/-]*)/gu
// A concrete test path. The `test:scripts` glob (`scripts/*.test.mjs`) deliberately
// never matches this pattern, so glob execution cannot stand in for explicit wiring.
// The trailing boundary keeps lookalikes such as `scripts/x.test.mjs.bak` out.
const TEST_FILE_REFERENCE = /scripts\/([A-Za-z0-9_.-]+\.test\.mjs)(?![A-Za-z0-9_.-])/gu

/** 从 root 脚本出发递归解析 `yarn <script>`,返回 `check` 能到达的脚本名集合。 */
function resolveGateClosure(root, scripts) {
  const closure = new Set()
  const pending = [root]
  // `closure` doubles as the visited set, so a `check` <-> `check:*` cycle terminates.
  while (pending.length > 0) {
    const name = pending.pop()
    if (closure.has(name)) continue
    closure.add(name)
    const command = scripts[name]
    if (typeof command !== 'string') continue
    for (const [, reference] of command.matchAll(YARN_REFERENCE)) {
      if (reference !== undefined && Object.hasOwn(scripts, reference)) pending.push(reference)
    }
  }
  return closure
}

test('the shared gate-script fixture equals the root manifest', () => {
  assert.strictEqual(EXPECTED.fixtureVersion, 3)
  assert.strictEqual(manifest.scripts.build, EXPECTED.build)
  assert.strictEqual(manifest.scripts.typecheck, EXPECTED.typecheck)
  assert.strictEqual(manifest.scripts.test, EXPECTED.test)
  assert.strictEqual(manifest.scripts.check, EXPECTED.check)
})

test('every scripts/*.test.mjs is explicitly wired into the check closure', () => {
  const testFiles = readdirSync(scriptsDir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
  assert.ok(testFiles.length > 0, 'scripts/ must contain at least one *.test.mjs file')

  const closure = resolveGateClosure('check', rootScripts)
  assert.ok(closure.has('test:gate-scripts'), 'the check closure must reach test:gate-scripts')
  // `test:scripts` is the only glob invocation of these files; letting it into the gate
  // would run every test twice and make explicit wiring unnecessary-but-required.
  assert.strictEqual(closure.has('test:scripts'), false, 'the check closure must not run the test:scripts glob')

  const referenced = new Set()
  for (const name of closure) {
    const command = rootScripts[name]
    if (typeof command !== 'string') continue
    for (const [, file] of command.matchAll(TEST_FILE_REFERENCE)) {
      if (file !== undefined) referenced.add(file)
    }
  }

  const unreferenced = testFiles.filter(file => !referenced.has(file))
  assert.deepEqual(
    unreferenced,
    [],
    `every scripts/*.test.mjs must be named by a script in the check closure; ` +
      `the test:scripts glob does not count: ${unreferenced.join(', ')}`,
  )
})

test('the gate closure parser terminates on reference cycles', () => {
  const scripts = { check: 'yarn check:inner', 'check:inner': 'yarn check && yarn check:inner' }
  assert.deepEqual([...resolveGateClosure('check', scripts)].sort(), ['check', 'check:inner'])
})
