import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  resolveTargetBase,
  root,
  runWhitespaceCheck,
} from './check-whitespace.mjs'

test('resolveTargetBase prioritizes valid BASE_SHA environment variable', () => {
  const base = resolveTargetBase({ BASE_SHA: 'abc1234567890abcdef1234567890abcdef1234' })
  assert.strictEqual(base, 'abc1234567890abcdef1234567890abcdef1234')

  const baseWithWhitespace = resolveTargetBase({ BASE_SHA: '  def456  ' })
  assert.strictEqual(baseWithWhitespace, 'def456')
})

test('resolveTargetBase ignores all-zero BASE_SHA and falls back to git merge-base', () => {
  const expectedRealBase = execFileSync('git', ['merge-base', 'origin/master', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  const allZeros40 = resolveTargetBase({ BASE_SHA: '0'.repeat(40) })
  assert.strictEqual(allZeros40, expectedRealBase)

  const allZerosShort = resolveTargetBase({ BASE_SHA: '0000' })
  assert.strictEqual(allZerosShort, expectedRealBase)
})

test('resolveTargetBase falls back to git merge-base when BASE_SHA is empty or missing', () => {
  const expectedRealBase = execFileSync('git', ['merge-base', 'origin/master', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  const unsetBase = resolveTargetBase({})
  assert.strictEqual(unsetBase, expectedRealBase)

  const emptyBase = resolveTargetBase({ BASE_SHA: '' })
  assert.strictEqual(emptyBase, expectedRealBase)

  const spacesBase = resolveTargetBase({ BASE_SHA: '   ' })
  assert.strictEqual(spacesBase, expectedRealBase)
})

test('resolveTargetBase throws informative error if git merge-base fails', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-git-fail-'))
  try {
    assert.throws(
      () => resolveTargetBase({}, tempDir),
      /failed to determine base commit via "git merge-base origin\/master HEAD"/u,
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runWhitespaceCheck detects clean range and trailing whitespace errors in a git repository', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-git-check-'))
  try {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Check Bot'], { cwd: tempDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: tempDir, stdio: 'ignore' })

    const sampleFile = join(tempDir, 'sample.txt')
    writeFileSync(sampleFile, 'initial line\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir, stdio: 'ignore' })
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).trim()

    // 1. Clean commit
    writeFileSync(sampleFile, 'initial line\nclean second line\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'clean commit'], { cwd: tempDir, stdio: 'ignore' })

    const cleanResult = runWhitespaceCheck({ cwd: tempDir, targetBase: baseSha, stdio: 'pipe' })
    assert.strictEqual(cleanResult.ok, true)
    assert.strictEqual(cleanResult.status, 0)
    assert.strictEqual(cleanResult.stdout, '')

    // 2. Commit with trailing whitespace
    writeFileSync(sampleFile, 'initial line\nclean second line\nline with trailing whitespace   \n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'dirty whitespace commit'], { cwd: tempDir, stdio: 'ignore' })

    const dirtyResult = runWhitespaceCheck({ cwd: tempDir, targetBase: baseSha, stdio: 'pipe' })
    assert.strictEqual(dirtyResult.ok, false)
    assert.notStrictEqual(dirtyResult.status, 0)
    assert.match(dirtyResult.stdout, /trailing whitespace/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runWhitespaceCheck passes on current repository master branch', () => {
  const result = runWhitespaceCheck({ cwd: root, stdio: 'pipe' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.status, 0)
})

test('scripts/check-whitespace.mjs CLI execution exits 0 on clean tree and 1 on error', () => {
  const scriptPath = resolve(root, 'scripts/check-whitespace.mjs')

  // Clean execution on repository
  const cleanRun = spawnSync('node', [scriptPath], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.strictEqual(cleanRun.status, 0)

  // Execution with invalid base SHA fails with code 1
  const badRun = spawnSync('node', [scriptPath], {
    cwd: root,
    env: { ...process.env, BASE_SHA: 'invalid_sha_that_does_not_exist' },
    encoding: 'utf8',
  })
  assert.strictEqual(badRun.status, 1)
})
