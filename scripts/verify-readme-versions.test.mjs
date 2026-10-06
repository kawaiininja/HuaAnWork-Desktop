import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { README_VERSION_SCOPES, checkReadmeVersions } from './verify-readme-versions.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

test('the huaanwork READMEs agree with their own package.json version', () => {
  const result = checkReadmeVersions(repoRoot)
  assert.deepStrictEqual(result.violations, [], `README version drift: ${JSON.stringify(result.violations)}`)
  assert.ok(result.checked >= 2, `expected at least the two huaanwork READMEs, checked ${String(result.checked)}`)
})

test('scope is huaanwork only, with stable/beta drift registered as an M28 item', () => {
  assert.deepStrictEqual(
    README_VERSION_SCOPES.map(scope => scope.packageDir),
    ['dsh-plugin-huaanwork'],
  )
  assert.deepStrictEqual(
    README_VERSION_SCOPES[0].outOfScopeRegistered,
    [
      'dsh-plugin-desktop/README.md',
      'dsh-plugin-desktop/README.zh.md',
      'dsh-plugin-desktop-beta/README.md',
      'dsh-plugin-desktop-beta/README.zh.md',
    ],
  )
})

test('a drifted README version makes the guard exit non-zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'readme-versions-'))
  try {
    mkdirSync(join(root, 'dsh-plugin-huaanwork'), { recursive: true })
    writeFileSync(
      join(root, 'dsh-plugin-huaanwork', 'package.json'),
      `${JSON.stringify({ name: 'dsh-plugin-huaanwork', version: '0.2.0' }, null, 2)}\n`,
    )
    writeFileSync(
      join(root, 'dsh-plugin-huaanwork', 'README.md'),
      '# x\n\n`HuaAnWork-0.1.0-x64-Setup.exe`\n',
    )
    const result = checkReadmeVersions(root)
    assert.strictEqual(result.violations.length, 1)
    assert.match(result.violations[0].reason, /0\.1\.0/u)
    assert.match(result.violations[0].reason, /0\.2\.0/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI prints what it checked and exits non-zero on drift', () => {
  const out = execFileSync(process.execPath, ['scripts/verify-readme-versions.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.match(out, /^verify-readme-versions: /u)
  assert.match(out, /dsh-plugin-huaanwork/u)
  assert.match(out, /out of scope \(M28\)/u)
})
