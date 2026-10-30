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

test('scope is huaanwork only and registers no out-of-scope README', () => {
  assert.deepStrictEqual(
    README_VERSION_SCOPES.map(scope => scope.packageDir),
    ['dsh-plugin-huaanwork'],
  )
  for (const scope of README_VERSION_SCOPES) {
    assert.deepStrictEqual(scope.outOfScopeRegistered, [])
  }
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
    writeFileSync(
      join(root, 'dsh-plugin-huaanwork', 'README.zh.md'),
      '# x\n\n`HuaAnWork-0.2.0-x64-Portable.zip`\n',
    )
    const result = checkReadmeVersions(root)
    assert.strictEqual(result.violations.length, 1)
    assert.match(result.violations[0].reason, /0\.1\.0/u)
    assert.match(result.violations[0].reason, /0\.2\.0/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing in-scope README is a violation, not a vacuous pass (M7 review fix round)', () => {
  const root = mkdtempSync(join(tmpdir(), 'readme-versions-missing-'))
  try {
    mkdirSync(join(root, 'dsh-plugin-huaanwork'), { recursive: true })
    writeFileSync(
      join(root, 'dsh-plugin-huaanwork', 'package.json'),
      `${JSON.stringify({ name: 'dsh-plugin-huaanwork', version: '0.2.0' }, null, 2)}\n`,
    )
    // 只写 zh 一个;删掉另一个在管 README 不得让守卫反而更绿。
    writeFileSync(
      join(root, 'dsh-plugin-huaanwork', 'README.zh.md'),
      '# x\n\n`HuaAnWork-0.2.0-x64-Portable.zip`\n',
    )
    const result = checkReadmeVersions(root)
    assert.strictEqual(result.violations.length, 1)
    assert.strictEqual(result.violations[0].file, 'dsh-plugin-huaanwork/README.md')
    assert.match(result.violations[0].reason, /not found/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a README with zero artifact version strings is a violation, not a vacuous pass (M7 review fix round)', () => {
  const root = mkdtempSync(join(tmpdir(), 'readme-versions-zero-'))
  try {
    mkdirSync(join(root, 'dsh-plugin-huaanwork'), { recursive: true })
    writeFileSync(
      join(root, 'dsh-plugin-huaanwork', 'package.json'),
      `${JSON.stringify({ name: 'dsh-plugin-huaanwork', version: '0.2.0' }, null, 2)}\n`,
    )
    // 版本串被连同文案一起改写掉的形态:两个 README 都零命中 ⇒ checked=0,旧守卫全绿。
    writeFileSync(join(root, 'dsh-plugin-huaanwork', 'README.md'), '# x\n\nno versions here\n')
    writeFileSync(join(root, 'dsh-plugin-huaanwork', 'README.zh.md'), '# x\n\nalso none\n')
    const result = checkReadmeVersions(root)
    assert.strictEqual(result.checked, 0)
    assert.strictEqual(result.violations.length, 2)
    assert.ok(result.violations.every(v => /pass vacuously/u.test(v.reason)))
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
  // No README is out of scope any more: the retired Stable/Beta trees are deleted,
  // so the CLI must not append an empty "out of scope" clause or an M28 deferral.
  assert.doesNotMatch(out, /out of scope/u)
  assert.doesNotMatch(out, /M28/u)
})
