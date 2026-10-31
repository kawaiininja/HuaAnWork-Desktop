/**
 * 上游 selective review 看板 (Task 12; 依据 2026-10-29 单桌面维护计划)。
 *
 * 为什么需要它:
 * 单桌面仓库不再整仓合并上游,而是按 `desktop-upstream.json` 的 `reviewedCommit`
 * 逐提交、逐文件审阅从该基点到 `upstream/master` 的全部待审提交。本脚本只做
 * 只读枚举与分诊(watched / unwatched),供人工或审阅流程登记处置结论。
 *
 * 关键纪律:
 * 1. 只读脚本:仅读取本地 git ref 与工作树里的配置文件,绝不运行 git fetch,
 *    绝不写回任何状态。推进 `reviewedCommit` 是人工动作(见 docs/upstream-sync.md)。
 * 2. 只依赖本地 git ref:本地已解析出 upstream/master 时可完全离线工作(读数只是
 *    最后一次 fetch 的陈旧值)。只有缺少该 ref、remote URL 与配置不符、reviewedCommit
 *    不是该 ref 的祖先,或 watchedPaths 的某个目录型条目在 reviewedCommit 解析不到
 *    tree、非目录型条目解析不到文件时,才报错并以非零码退出,绝不静默输出 0。因此
 *    【绝对不得接进 package.json 任何 scripts,也不得接进任何 gate】。
 * 3. 不读取、不比较三个参考桌面树;watchedPaths 只提供覆盖面与分诊,不验证移植的
 *    完整性或等价性。
 * 4. 输出不截断:文本与 --json 都给出全部提交与全部 direct files、as-of 时间与完整
 *    SHA,便于把结果原样落入证据文档。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')

export function collectUpstreamReview({ root = repoRoot, upstreamRef, configPath } = {}) {
  let config
  try {
    config = JSON.parse(readFileSync(configPath ?? join(root, 'desktop-upstream.json'), 'utf8'))
    if (config.schemaVersion !== 1 || typeof config.repository !== 'string'
      || typeof config.ref !== 'string' || !/^[0-9a-f]{40}$/u.test(config.reviewedCommit)
      || typeof config.sourcePackage !== 'string' || !Array.isArray(config.watchedPaths)
      || config.watchedPaths.length === 0 || config.watchedPaths.some(path => typeof path !== 'string' || path.length === 0)) {
      throw new Error('invalid desktop-upstream.json schema')
    }
  } catch (error) {
    return { ok: false, error: `cannot load desktop-upstream.json: ${String(error)}; see docs/upstream-sync.md` }
  }
  const ref = upstreamRef ?? config.ref
  const git = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const gitRaw = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let upstreamSha
  try {
    if (git(['remote', 'get-url', 'upstream']) !== config.repository) throw new Error('upstream remote URL differs from desktop-upstream.json')
    upstreamSha = git(['rev-parse', '--verify', `${ref}^{commit}`])
    git(['rev-parse', '--verify', `${config.reviewedCommit}^{commit}`])
    execFileSync('git', ['merge-base', '--is-ancestor', config.reviewedCommit, upstreamSha], { cwd: root, stdio: 'ignore' })
  } catch (error) {
    return { ok: false, error: `upstream ref is unavailable, or reviewedCommit is not an ancestor: ${String(error)}; see docs/upstream-sync.md` }
  }
  const lines = value => value ? value.split('\n').filter(Boolean) : []
  const isFileEntry = path => {
    const [entry] = lines(git(['ls-tree', config.reviewedCommit, '--', path]))
    if (!entry) return false
    const [mode] = entry.split(' ')
    // `cat-file -e <commit>:<path>` 无法区分文件与目录(tree 也存在),submodule gitlink
    // 的目标对象又不在本仓;ls-tree 的 mode 同时覆盖两点:160000 是 diff-tree 里按
    // 单路径(文件型)出现的 submodule pin,只有 040000 才是必须写成 `<path>/` 的目录。
    return mode === '100644' || mode === '100755' || mode === '120000' || mode === '160000'
  }
  const isDirectoryEntry = path => {
    const [entry] = lines(git(['ls-tree', config.reviewedCommit, '--', path.replace(/\/$/u, '')]))
    return entry?.startsWith('040000 tree ') === true
  }
  const invalidWatch = config.watchedPaths.find(path => path.endsWith('/') ? !isDirectoryEntry(path) : !isFileEntry(path))
  if (invalidWatch !== undefined) {
    const shape = invalidWatch.endsWith('/') ? 'directory' : 'file'
    const slashHint = shape === 'file' ? '; directory entries must end with "/"' : ''
    return {
      ok: false,
      error: `watchedPaths entry "${invalidWatch}" in desktop-upstream.json does not resolve to a ${shape} at reviewedCommit ${config.reviewedCommit}${slashHint}; see docs/upstream-sync.md`,
    }
  }
  const shas = lines(git(['rev-list', '--reverse', '--topo-order', `${config.reviewedCommit}..${upstreamSha}`]))
  const isWatched = file => config.watchedPaths.some(path => path.endsWith('/') ? file.startsWith(path) : file === path)
  const commits = shas.map(sha => {
    const [date, subject] = git(['show', '-s', '--format=%cI%x00%s', sha]).split('\0')
    // `-c` includes what a merge commit itself introduced (conflict resolutions and
    // merge-only files) without `-m`'s repetition of clean parent-side files. `-z`
    // keeps paths byte-exact, including double quotes that `core.quotePath=false`
    // still C-quotes.
    const files = gitRaw(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-c', '-z', sha])
      .split('\0').filter(Boolean)
    return {
      sha, date, subject,
      files: {
        watched: files.filter(isWatched),
        unwatched: files.filter(file => !isWatched(file)),
      },
    }
  })
  return {
    ok: true,
    asOf: new Date().toISOString(),
    repository: config.repository,
    ref,
    upstreamSha,
    upstreamCommitDate: git(['show', '-s', '--format=%cI', upstreamSha]),
    reviewedCommit: config.reviewedCommit,
    sourcePackage: config.sourcePackage,
    pendingCount: commits.length,
    commits,
  }
}

export function formatDashboard(result) {
  if (!result.ok) return `upstream-sync-dashboard: error: ${result.error}\n`
  const lines = [
    `upstream-sync-dashboard: as-of ${result.asOf} / upstream commit ${result.upstreamCommitDate}`,
    `  ref      = ${result.ref} @ ${result.upstreamSha}`,
    `  reviewed = ${result.reviewedCommit}`,
    `  source   = ${result.sourcePackage}`,
    `  pending  = ${String(result.pendingCount)} commits`,
  ]
  for (const commit of result.commits) {
    lines.push(`  ${commit.sha} ${commit.date} ${commit.subject}`)
    for (const file of commit.files.watched) lines.push(`    watched: ${file}`)
    for (const file of commit.files.unwatched) lines.push(`    unwatched: ${file}`)
    if (commit.files.watched.length + commit.files.unwatched.length === 0) lines.push('    (zero direct files)')
  }
  lines.push('  note: read-only; not a gate. Re-run after git fetch upstream and record as-of plus full SHAs.')
  return `${lines.join('\n')}\n`
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectExecution) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--json') || args.length > 1) throw new Error('usage: node scripts/upstream-sync-dashboard.mjs [--json]')
  const result = collectUpstreamReview({ root: repoRoot })
  if (!result.ok) {
    process.stderr.write(formatDashboard(result))
    process.exit(1)
  }
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatDashboard(result))
}
