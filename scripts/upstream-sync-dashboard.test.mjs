import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { collectUpstreamReview, formatDashboard } from './upstream-sync-dashboard.mjs'

const REPOSITORY = 'https://github.com/anywhere-labs/dsh-desktop.git'
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

function dashboardFixture(t, { nonAscii = false, watchedPaths = ['scripts/'] } = {}) {
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
  const reviewedCommit = git(['rev-parse', 'HEAD'])
  writeConfig(root, reviewedCommit, { watchedPaths })
  git(['checkout', '-b', 'side', reviewedCommit])
  git(['commit', '--allow-empty', '-m', 'side'])
  git(['checkout', 'master'])
  commit('scripts/change.mjs', 'export const value = 1\n', 'watched change')
  commit('docs/note.md', 'note\n', 'unwatched change')
  if (nonAscii) commit('docs/中文.md', '中文\n', 'non-ascii change')
  git(['merge', '--no-ff', 'side', '-m', 'merge container'])
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

test('classifies non-ASCII paths without git quotePath escaping', t => {
  const { root } = dashboardFixture(t, { nonAscii: true, watchedPaths: ['docs/'] })
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  const commit = result.commits.find(commit => commit.subject === 'non-ascii change')
  assert.deepEqual(commit.files, { watched: ['docs/中文.md'], unwatched: [] })
})

test('fails loudly for a directory-shaped watchedPaths entry missing its trailing slash', t => {
  const { root } = dashboardFixture(t, { watchedPaths: ['docs'] })
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, false)
  assert.match(result.error, /"docs"/u)
  assert.match(result.error, /must end with "\/"/u)
  assert.match(result.error, /docs\/upstream-sync\.md/u)
})
