/**
 * 上游落后量与冲突面看板脚本 (M17.2; 依据评估 M17 交付②)。
 *
 * 为什么需要它:
 * 记录从 fork merge-base 到 upstream/master 的落后 commit 数与三个重叠冲突面
 * (白名单面、三包同形面、永久 override 面)，用于大同步 (Phase B / M8) 的风险估算。
 *
 * 关键纪律:
 * 1. 只读脚本，仅读取本地现有 git ref 与工作树源码，绝不运行 git fetch。
 * 2. 本脚本依赖 git fetch upstream 后的本地 ref，在无网络环境或缺少 upstream
 *    remote 时无法运行，因此【绝对不得接进 package.json 任何 scripts、绝不得接进 gate】。
 * 3. 动态求 merge-base (git merge-base HEAD <upstreamRef>)，不硬编码历史 SHA。
 * 4. upstream remote 缺失时显式报错并指向 docs/upstream-sync.md §1 和 §3，
 *    绝不隐式回落到其他任何 remote 或分支。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PAIRS } from './verify-desktop-variants.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

function listFiles(dir, base = dir) {
  const result = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) result.push(...listFiles(path, base))
      else if (entry.isFile()) result.push(relative(base, path).split(sep).join('/'))
    }
  } catch {
    // directory doesn't exist
  }
  return result
}

export function collectUpstreamLag({ root = repoRoot, upstreamRef = 'upstream/master' } = {}) {
  // 1. Verify upstream ref exists; fail loudly with explicit pointer without falling back
  try {
    execFileSync('git', ['rev-parse', '--verify', upstreamRef], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return {
      ok: false,
      error: 'the "upstream" remote is not configured or not fetched; see docs/upstream-sync.md §1 and §3',
    }
  }

  // 2. Dynamic merge-base calculation
  let mergeBase
  try {
    mergeBase = execFileSync('git', ['merge-base', 'HEAD', upstreamRef], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    return {
      ok: false,
      error: `failed to find merge-base between HEAD and ${upstreamRef}: ${String(err)}`,
    }
  }

  // 3. Upstream SHA & commit dates
  const upstreamSha = execFileSync('git', ['rev-parse', upstreamRef], { cwd: root, encoding: 'utf8' }).trim()
  const upstreamCommitDate = execFileSync('git', ['show', '-s', '--format=%cI', upstreamSha], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const mergeBaseCommitDate = execFileSync('git', ['show', '-s', '--format=%cI', mergeBase], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  const asOf = new Date().toISOString()
  const behindCount = Number(
    execFileSync('git', ['rev-list', '--count', `${mergeBase}..${upstreamRef}`], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  )
  const aheadCount = Number(
    execFileSync('git', ['rev-list', '--count', `${upstreamRef}..HEAD`], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  )

  // 4. Git diff between mergeBase and upstreamRef
  const diffOutput = execFileSync('git', ['diff', '--name-only', mergeBase, upstreamRef], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const diffFiles = diffOutput ? diffOutput.split('\n').map(s => s.trim()).filter(Boolean) : []
  const diffSet = new Set(diffFiles)

  // Scope A: whitelist (beta↔huaanwork 22 + stable↔beta 19 -> deduplicated 36)
  const norm = p => (p.startsWith('src/') || p.startsWith('scripts/')) ? p : `src/${p}`
  const whitelistSet = new Set([
    ...PAIRS[0].allowedDifferences.map(norm),
    ...PAIRS[1].allowedDifferences.map(norm),
  ])
  const whitelistHitsSet = new Set()
  for (const file of diffFiles) {
    for (const pkg of ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']) {
      if (file.startsWith(`${pkg}/`)) {
        const rel = file.slice(pkg.length + 1)
        if (whitelistSet.has(rel)) {
          whitelistHitsSet.add(rel)
        }
      }
    }
  }
  const whitelistHits = [...whitelistHitsSet].sort()

  // Scope B: threePackageIdentical (src/ files identical across all 3 packages)
  const pkgs = ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta', 'dsh-plugin-huaanwork']
  const sets = pkgs.map(p => new Set(listFiles(join(root, p, 'src'))))
  const union = new Set([...sets[0], ...sets[1], ...sets[2]])
  const inAll = [...union].filter(f => sets.every(s => s.has(f)))
  const sha = f => pkgs.map(p => createHash('sha256').update(readFileSync(join(root, p, 'src', f))).digest('hex'))
  const identical = inAll.filter(f => {
    const h = sha(f)
    return h[0] === h[1] && h[1] === h[2]
  }).sort()

  const threePkgHitsSet = new Set()
  for (const f of identical) {
    if (diffSet.has(`dsh-plugin-desktop/src/${f}`) || diffSet.has(`dsh-plugin-desktop-beta/src/${f}`)) {
      threePkgHitsSet.add(f)
    }
  }
  const threePkgHits = [...threePkgHitsSet].sort()

  // Scope C: permanentOverride (parsed from docs/upstream-sync.md Section 6)
  const docText = readFileSync(join(root, 'docs/upstream-sync.md'), 'utf8')
  const sec6Match = docText.match(/## 6\.\s+永久 Fork-Owned Override 清单([\s\S]*?)(?=## 7\.|$)/u)
  if (!sec6Match) {
    throw new Error('docs/upstream-sync.md Section 6 not found')
  }
  const rawMatches = [...sec6Match[1].matchAll(/`([^`\n]+)`/gu)].map(m => m[1].trim())
  const overridePaths = [...new Set(rawMatches.filter(p => p.includes('/') && !p.includes(' ')))].sort()
  const overrideHits = overridePaths.filter(p => diffSet.has(p)).sort()

  return {
    ok: true,
    asOf,
    upstreamCommitDate,
    ref: upstreamRef,
    upstreamSha,
    mergeBase,
    mergeBaseCommitDate,
    behindCount,
    aheadCount,
    overlap: {
      whitelist: {
        hits: whitelistHits.length,
        denominator: whitelistSet.size,
        hitFiles: whitelistHits,
      },
      threePackageIdentical: {
        hits: threePkgHits.length,
        denominator: identical.length,
        hitFiles: threePkgHits,
      },
      permanentOverride: {
        hits: overrideHits.length,
        denominator: overridePaths.length,
        hitFiles: overrideHits,
      },
    },
  }
}

function formatHitsList(files) {
  if (!files || files.length === 0) return ''
  const limit = 20
  const shown = files.slice(0, limit)
  const truncation = files.length > limit ? `\n        … and ${String(files.length - limit)} more` : ''
  return `\n      hits (${String(files.length)}):\n` + shown.map(f => `        - ${f}`).join('\n') + truncation
}

export function formatDashboard(result) {
  if (!result.ok) {
    return `upstream-sync-dashboard: error: ${result.error}\n`
  }

  const { whitelist, threePackageIdentical, permanentOverride } = result.overlap
  return (
    `upstream-sync-dashboard: as-of ${result.asOf} / upstream commit ${result.upstreamCommitDate}\n` +
    `  ref        = ${result.ref} @ ${result.upstreamSha}\n` +
    `  merge-base = ${result.mergeBase} (${result.mergeBaseCommitDate})\n` +
    `  behind     = ${String(result.behindCount)} commits   ahead = ${String(result.aheadCount)} commits\n` +
    `  overlap (三个口径分别计,不相加):\n` +
    `    whitelist            : ${String(whitelist.hits)}/${String(whitelist.denominator)}  (beta↔huaanwork 22 + stable↔beta 19, 去重后 ${String(whitelist.denominator)})` +
    formatHitsList(whitelist.hitFiles) + '\n' +
    `    threePackageIdentical: ${String(threePackageIdentical.hits)}/${String(threePackageIdentical.denominator)}  (三包 src/ 逐字节相同的隐含同步面)` +
    formatHitsList(threePackageIdentical.hitFiles) + '\n' +
    `    permanentOverride    : ${String(permanentOverride.hits)}/${String(permanentOverride.denominator)}  (docs/upstream-sync.md §6 列的 fork-owned 文件)` +
    formatHitsList(permanentOverride.hitFiles) + '\n' +
    `  note: read-only. Not wired into any gate. Re-run after \`git fetch upstream\` and record the as-of pair.\n`
  )
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectExecution) {
  const result = collectUpstreamLag({ root: repoRoot })
  if (!result.ok) {
    process.stderr.write(`upstream-sync-dashboard: error: ${result.error}\n`)
    process.exit(1)
  }
  process.stdout.write(formatDashboard(result))
}
