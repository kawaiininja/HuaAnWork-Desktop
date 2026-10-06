/**
 * 临时 worktree 试 merge 与 hunk 级冲突清单脚本 (M17.3; 裁定 R-M7-3 阶段 A spike).
 *
 * 关键纪律:
 * 1. 本脚本为只读 spike: 所有写操作都在独立临时 worktree 内完成，主工作树零足迹。
 * 2. 严禁在主工作树产生任何 merge 提交或脏状态。
 * 3. 必须在 try/finally 中确保 merge --abort 和 worktree remove 100% 执行。
 * 4. 统计并分类所有 conflict hunk，产出用于 M8 规划的结构化报告数据。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const args = {
    target: 'upstream/master',
    out: null,
  }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) {
      args.target = argv[++i]
    } else if (argv[i] === '--out' && i + 1 < argv.length) {
      args.out = argv[++i]
    }
  }
  return args
}

export function classifyHunk(file, hunkIndex, headFirstLine, upstreamFirstLine) {
  // 1. fork-owned-override: permanent override files in docs/upstream-sync.md §6
  if (
    file === 'scripts/verify-desktop-variants.mjs' ||
    file === 'scripts/expected-root-gate-scripts.json' ||
    file === 'scripts/market-manifest-byte-budget.json'
  ) {
    return 'fork-owned-override'
  }

  // 2. matrix-preserve: CI matrix hunks
  if (
    file === '.github/workflows/ci.yml' &&
    (headFirstLine.includes('workspace:') || upstreamFirstLine.includes('workspace:'))
  ) {
    return 'matrix-preserve'
  }

  // 3. package.spec.ts matrix assertions vs readFileSync
  if (
    (file === 'dsh-plugin-desktop/tests/package.spec.ts' ||
      file === 'dsh-plugin-desktop-beta/tests/package.spec.ts') &&
    (headFirstLine.includes('workspace: [') || upstreamFirstLine.includes('workspace: ['))
  ) {
    return 'matrix-preserve'
  }
  if (
    file === 'dsh-plugin-desktop/tests/package.spec.ts' ||
    file === 'dsh-plugin-desktop-beta/tests/package.spec.ts'
  ) {
    return 'fork-owned-override'
  }

  // 4. replay-fork: lockfile, package.json, gitignore, layout verification
  if (
    file === 'yarn.lock' ||
    file === 'package.json' ||
    file === '.gitignore' ||
    file === 'dsh-plugin-desktop/package.json' ||
    file === 'dsh-plugin-desktop-beta/package.json' ||
    file === 'scripts/verify-layout.mjs'
  ) {
    return 'replay-fork'
  }

  // 5. take-upstream: third party notices or minor upstream documentation sync
  if (
    file === 'dsh-plugin-desktop/THIRD_PARTY_NOTICES.md' ||
    file === 'dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md'
  ) {
    return 'take-upstream'
  }

  // 6. modify-delete: check for deleted files (none in pure UU)
  // If either side deleted the file or region entirely
  if (headFirstLine === '(empty)' && upstreamFirstLine.includes('dsh-desktop-next')) {
    return 'replay-fork'
  }

  // 7. needs-ruling: kernel/runtime divergences, update checks, vendor provenance
  return 'needs-ruling'
}

export function runMergeSpike({ root = repoRoot, target = 'upstream/master' } = {}) {
  const startedAt = new Date().toISOString()

  // 1. Check clean status in main tree (ignoring the spike script itself and report artifacts)
  const preStatusRaw = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  const preStatusLines = preStatusRaw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(l => !l.includes('upstream-merge-spike') && !l.includes('2026-10-m7-upstream-merge-spike.md'))
  if (preStatusLines.length > 0) {
    throw new Error(`cannot run merge spike with dirty working tree:\n${preStatusLines.join('\n')}`)
  }

  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const targetSha = execFileSync('git', ['rev-parse', target], { cwd: root, encoding: 'utf8' }).trim()
  const targetCommitDate = execFileSync('git', ['show', '-s', '--format=%cI', targetSha], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const mergeBase = execFileSync('git', ['merge-base', headSha, targetSha], { cwd: root, encoding: 'utf8' }).trim()
  const mergeBaseCommitDate = execFileSync('git', ['show', '-s', '--format=%cI', mergeBase], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const preWorktreeList = execFileSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' }).trim()

  const tmpWorktreeDir = mkdtempSync(join(tmpdir(), 'zz-m7-merge-spike-'))

  const tagCounts = {
    'take-upstream': 0,
    'replay-fork': 0,
    'fork-owned-override': 0,
    'modify-delete': 0,
    'matrix-preserve': 0,
    'needs-ruling': 0,
  }
  const conflictsByFile = []
  const needsRulingList = []
  let totalHunks = 0
  let unmergedFiles = []

  try {
    execFileSync('git', ['worktree', 'add', '--detach', tmpWorktreeDir, headSha], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let mergeExitedNonZero = false
    try {
      execFileSync('git', ['merge', '--no-commit', '--no-ff', target], {
        cwd: tmpWorktreeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      mergeExitedNonZero = true
    }

    const unmergedOutput = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: tmpWorktreeDir,
      encoding: 'utf8',
    }).trim()
    unmergedFiles = unmergedOutput ? unmergedOutput.split('\n').map(s => s.trim()).filter(Boolean) : []

    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmpWorktreeDir,
      encoding: 'utf8',
    }).trim()
    const statusLines = statusOutput ? statusOutput.split('\n').filter(Boolean) : []
    const modifyDeleteLines = statusLines.filter(l => l.startsWith('UD') || l.startsWith('DU'))

    for (const md of modifyDeleteLines) {
      const file = md.slice(3).trim()
      tagCounts['modify-delete']++
      conflictsByFile.push({
        file,
        status: md.slice(0, 2),
        hunks: [
          {
            index: 1,
            headFirstLine: '(modify-delete)',
            upstreamFirstLine: '(modify-delete)',
            tag: 'modify-delete',
          },
        ],
      })
    }

    for (const file of unmergedFiles) {
      const fullPath = join(tmpWorktreeDir, file)
      const content = readFileSync(fullPath, 'utf8')
      const regex = /<{7}[^\n]*\n([\s\S]*?)={7}\n([\s\S]*?)>{7}[^\n]*/gu
      let match
      let hunkIndex = 0
      const fileHunks = []

      while ((match = regex.exec(content)) !== null) {
        hunkIndex++
        totalHunks++
        const headFirstLine = (match[1].split('\n').map(s => s.trim()).filter(Boolean)[0] || '(empty)').slice(0, 120)
        const upstreamFirstLine = (match[2].split('\n').map(s => s.trim()).filter(Boolean)[0] || '(empty)').slice(0, 120)
        const tag = classifyHunk(file, hunkIndex, headFirstLine, upstreamFirstLine)
        tagCounts[tag]++
        const hunkRecord = {
          index: hunkIndex,
          headFirstLine,
          upstreamFirstLine,
          tag,
        }
        fileHunks.push(hunkRecord)
        if (tag === 'needs-ruling') {
          needsRulingList.push({
            file,
            hunkIndex,
            headFirstLine,
            upstreamFirstLine,
          })
        }
      }

      conflictsByFile.push({
        file,
        status: 'UU',
        hunkCount: fileHunks.length,
        hunks: fileHunks,
      })
    }
  } finally {
    try {
      execFileSync('git', ['merge', '--abort'], {
        cwd: tmpWorktreeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {}
    try {
      execFileSync('git', ['worktree', 'remove', '--force', tmpWorktreeDir], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {}
    try {
      rmSync(tmpWorktreeDir, { recursive: true, force: true })
    } catch {}
  }

  const endedAt = new Date().toISOString()
  const postStatusRaw = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
  const postStatusLines = postStatusRaw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(l => !l.includes('upstream-merge-spike') && !l.includes('2026-10-m7-upstream-merge-spike.md'))
  const postWorktreeList = execFileSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' }).trim()

  return {
    ok: true,
    statement: '本 spike 不落地：主工作树零改动、无 merge 提交',
    window: {
      startedAt,
      endedAt,
    },
    refs: {
      headSha,
      target,
      targetSha,
      targetCommitDate,
      mergeBase,
      mergeBaseCommitDate,
    },
    verification: {
      preStatusLines: preStatusLines.length,
      postStatusLines: postStatusLines.length,
      preWorktreeCount: preWorktreeList.split('\n').length,
      postWorktreeCount: postWorktreeList.split('\n').length,
    },
    summary: {
      conflictFileCount: conflictsByFile.length,
      totalHunks,
      tagCounts,
      needsRulingCount: needsRulingList.length,
    },
    needsRulingList,
    conflictsByFile,
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectExecution) {
  const args = parseArgs(process.argv)
  const result = runMergeSpike({ root: repoRoot, target: args.target })

  const jsonText = JSON.stringify(result, null, 2)
  if (args.out) {
    writeFileSync(args.out, `${jsonText}\n`, 'utf8')
    process.stdout.write(`upstream-merge-spike: report written to ${args.out}\n`)
  } else {
    process.stdout.write(`${jsonText}\n`)
  }

  process.stdout.write(
    `upstream-merge-spike: completed in detached temporary worktree (${result.window.startedAt} -> ${result.window.endedAt})\n` +
    `  conflict files : ${String(result.summary.conflictFileCount)}\n` +
    `  total hunks    : ${String(result.summary.totalHunks)}\n` +
    `  tags           : take-upstream=${String(result.summary.tagCounts['take-upstream'])}, ` +
    `replay-fork=${String(result.summary.tagCounts['replay-fork'])}, ` +
    `fork-owned-override=${String(result.summary.tagCounts['fork-owned-override'])}, ` +
    `modify-delete=${String(result.summary.tagCounts['modify-delete'])}, ` +
    `matrix-preserve=${String(result.summary.tagCounts['matrix-preserve'])}, ` +
    `needs-ruling=${String(result.summary.tagCounts['needs-ruling'])}\n` +
    `  verification   : preStatusLines=${String(result.verification.preStatusLines)}, postStatusLines=${String(result.verification.postStatusLines)}, worktrees=${String(result.verification.postWorktreeCount)}\n`
  )
}
