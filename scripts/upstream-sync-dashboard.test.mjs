import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { collectUpstreamReview, formatDashboard } from './upstream-sync-dashboard.mjs'

const REPOSITORY = 'https://github.com/anywhere-labs/dsh-desktop.git'
// Two arbitrary SHAs for the fixture's gitlink entries. Git only needs mode 160000 and a
// 40-hex object name; the commit they name does not have to exist locally, exactly like a
// submodule pin in an uninitialized checkout.
const GITLINK_COMMITS = ['0123456789abcdef0123456789abcdef01234567', '89abcdef0123456789abcdef0123456789abcdef']
function writeConfig(root, reviewedCommit, { path = 'desktop-upstream.json', watchedPaths = ['scripts/'] } = {}) {
  writeFileSync(isAbsolute(path) ? path : join(root, path), `${JSON.stringify({
    schemaVersion: 1,
    repository: REPOSITORY,
    ref: 'upstream/master',
    reviewedCommit,
    sourcePackage: 'dsh-plugin-desktop-beta',
    watchedPaths,
  }, null, 2)}\n`)
}

function dashboardFixture(t, {
  nonAscii = false,
  quotedPath = false,
  conflictMerge = false,
  watchedPaths = ['scripts/'],
  gitlink = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'single-desktop-upstream-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const commit = (path, text, subject) => {
    write(path, text)
    git(['add', path])
    git(['commit', '-m', subject])
  }
  git(['init', '-b', 'master'])
  git(['config', 'user.name', 'Dashboard Test'])
  git(['config', 'user.email', 'dashboard@example.invalid'])
  git(['remote', 'add', 'upstream', REPOSITORY])
  commit('README.md', 'base\n', 'base')
  // `docs/` must exist as a directory at reviewedCommit, otherwise the directory-shaped
  // watchedPaths case below only exercises the missing-path branch and a regression that
  // dropped the mode whitelist would stay green.
  commit('docs/base.md', 'base docs\n', 'base docs')
  // The default watchedPaths entry is directory-shaped, so it must also exist at
  // reviewedCommit rather than being created only by the pending commits.
  commit('scripts/base.mjs', 'export const base = true\n', 'base scripts')
  if (gitlink) {
    git(['update-index', '--add', '--cacheinfo', `160000,${GITLINK_COMMITS[0]},deepseek-harness`])
    git(['commit', '-m', 'base gitlink'])
  }
  const reviewedCommit = git(['rev-parse', 'HEAD'])
  writeConfig(root, reviewedCommit, { watchedPaths })
  git(['checkout', '-b', 'side', reviewedCommit])
  if (conflictMerge) {
    commit('scripts/conflict.mjs', 'export const value = "side"\n', 'side conflict')
    commit('docs/side-only.md', 'side only\n', 'side only')
  } else {
    git(['commit', '--allow-empty', '-m', 'side'])
  }
  git(['checkout', 'master'])
  commit('scripts/change.mjs', 'export const value = 1\n', 'watched change')
  commit('docs/note.md', 'note\n', 'unwatched change')
  if (nonAscii) commit('docs/中文.md', '中文\n', 'non-ascii change')
  if (quotedPath) commit('docs/say "hi".md', 'quoted\n', 'quoted path change')
  if (conflictMerge) commit('scripts/conflict.mjs', 'export const value = "master"\n', 'master conflict')
  if (gitlink) {
    git(['update-index', '--cacheinfo', `160000,${GITLINK_COMMITS[1]},deepseek-harness`])
    git(['commit', '-m', 'gitlink bump'])
  }
  if (conflictMerge) {
    assert.throws(() => git(['merge', '--no-ff', 'side', '-m', 'merge container']))
    write('scripts/conflict.mjs', 'export const value = "resolved"\n')
    write('docs/merge-only.md', 'merge only\n')
    git(['add', 'scripts/conflict.mjs', 'docs/merge-only.md'])
    git(['commit', '-m', 'merge container'])
  } else {
    git(['merge', '--no-ff', 'side', '-m', 'merge container'])
  }
  const tip = git(['rev-parse', 'HEAD'])
  git(['update-ref', 'refs/remotes/upstream/master', tip])
  return { root, git, reviewedCommit, tip }
}

test('reports every pending commit and classifies every direct file exactly once', t => {
  const { root, reviewedCommit, tip } = dashboardFixture(t)
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reviewedCommit, reviewedCommit)
  assert.equal(result.upstreamSha, tip)
  assert.equal(result.pendingCount, 4)
  assert.match(result.asOf, /^\d{4}-\d{2}-\d{2}T/u)
  const commits = new Map(result.commits.map(commit => [commit.subject, commit]))
  assert.deepEqual(commits.get('watched change').files, { watched: ['scripts/change.mjs'], unwatched: [] })
  assert.deepEqual(commits.get('unwatched change').files, { watched: [], unwatched: ['docs/note.md'] })
  assert.deepEqual(commits.get('side').files, { watched: [], unwatched: [] })
  assert.deepEqual(commits.get('merge container').files, { watched: [], unwatched: [] })
  assert.equal('mergeBase' in result, false)
  assert.equal('overlap' in result, false)
})

test('fails loudly for a missing ref, config, or non-ancestor reviewedCommit', t => {
  const { root, git } = dashboardFixture(t)
  assert.match(collectUpstreamReview({ root, upstreamRef: 'upstream/missing' }).error, /docs\/upstream-sync\.md/u)
  const empty = mkdtempSync(join(tmpdir(), 'single-desktop-no-config-'))
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  assert.match(collectUpstreamReview({ root: empty }).error, /desktop-upstream\.json/u)
  const tree = git(['rev-parse', 'HEAD^{tree}'])
  const unrelated = git(['commit-tree', tree, '-m', 'unrelated'])
  const configPath = join(root, 'unrelated.json')
  writeConfig(root, unrelated, { path: configPath })
  assert.match(collectUpstreamReview({ root, configPath }).error, /ancestor/u)
})

test('formats full SHAs and does not truncate files or require reference trees', t => {
  const { root, reviewedCommit, tip } = dashboardFixture(t)
  const text = formatDashboard(collectUpstreamReview({ root }))
  assert.match(text, new RegExp(reviewedCommit))
  assert.match(text, new RegExp(tip))
  assert.match(text, /scripts\/change\.mjs/u)
  assert.match(text, /docs\/note\.md/u)
})

test('reports merge-only and conflict-resolution files without repeating clean side changes', t => {
  const { root } = dashboardFixture(t, { conflictMerge: true })
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  const commit = result.commits.find(commit => commit.subject === 'merge container')
  assert.deepEqual(commit.files, {
    watched: ['scripts/conflict.mjs'],
    unwatched: ['docs/merge-only.md'],
  })
})

test('classifies non-ASCII paths without git quotePath escaping', t => {
  const { root } = dashboardFixture(t, { nonAscii: true, watchedPaths: ['docs/'] })
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  const commit = result.commits.find(commit => commit.subject === 'non-ascii change')
  assert.deepEqual(commit.files, { watched: ['docs/中文.md'], unwatched: [] })
})

test('classifies paths containing double quotes without C-style quoting', t => {
  const { root } = dashboardFixture(t, { quotedPath: true, watchedPaths: ['docs/'] })
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  const commit = result.commits.find(commit => commit.subject === 'quoted path change')
  assert.deepEqual(commit.files, { watched: ['docs/say "hi".md'], unwatched: [] })
})

test('fails loudly for a missing upstream remote or a mismatched repository URL', t => {
  const { root, git } = dashboardFixture(t)
  git(['remote', 'remove', 'upstream'])
  const missing = collectUpstreamReview({ root })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /docs\/upstream-sync\.md/u)

  git(['remote', 'add', 'upstream', 'https://github.com/example/other.git'])
  const mismatched = collectUpstreamReview({ root })
  assert.equal(mismatched.ok, false)
  assert.match(mismatched.error, /upstream remote URL differs from desktop-upstream\.json/u)
})

test('fails loudly for a directory-shaped watchedPaths entry that is missing at reviewedCommit', t => {
  const { root } = dashboardFixture(t, { watchedPaths: ['scriptss/'] })
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, false)
  assert.match(result.error, /"scriptss\/"/u)
  assert.match(result.error, /does not resolve to a directory/u)
  assert.match(result.error, /docs\/upstream-sync\.md/u)
})

test('fails loudly for a directory-shaped watchedPaths entry missing its trailing slash', t => {
  const { root, git, reviewedCommit } = dashboardFixture(t, { watchedPaths: ['docs'] })
  assert.match(git(['ls-tree', reviewedCommit, '--', 'docs']), /^040000 tree /u,
    'fixture must contain a directory (040000 tree) at reviewedCommit')
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, false)
  assert.match(result.error, /"docs"/u)
  assert.match(result.error, /must end with "\/"/u)
  assert.match(result.error, /docs\/upstream-sync\.md/u)
})

test('accepts a submodule gitlink watched by exact path and classifies its update', t => {
  const { root, git, reviewedCommit } = dashboardFixture(t, { gitlink: true, watchedPaths: ['deepseek-harness'] })
  assert.match(git(['ls-tree', reviewedCommit, '--', 'deepseek-harness']), /^160000 commit /u,
    'fixture must contain a gitlink (160000 commit) at reviewedCommit')
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  const commit = result.commits.find(commit => commit.subject === 'gitlink bump')
  assert.deepEqual(commit.files, { watched: ['deepseek-harness'], unwatched: [] })
})
