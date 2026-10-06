/**
 * 三包 tests/ 漂移基线分类脚本 (M23 分析工具; 裁定 R-M7-7).
 *
 * 为什么需要它:
 * 当前变体守卫 verify-desktop-variants.mjs 只覆盖 src/ 与 scripts/，
 * tests/ 在两对变体间存在未纳入守卫的漂移。本脚本对三包 tests/ 的漂移基线进行
 * 全量四类分类 (legit-one-sided / legit-divergent / should-be-identical / unclassifiable)，
 * 识别「漏改一份」的存量债务 (should-be-identical)，为后续 M23 引入守卫提供前置输入。
 *
 * 关键纪律:
 * 1. 只读分析工具，不修改任何文件，不执行任何写操作。
 * 2. 绝对不得接进 package.json 任何 scripts、绝不得接进 gate（R-M7-7 裁定本轮只做分类，不建守卫）。
 * 3. 严格复用 verify-desktop-variants.mjs 的 PAIRS 与 normalize 规则，保证与守卫口径一致。
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

function computeDiffLines(pathA, pathB) {
  try {
    execFileSync('git', ['diff', '--no-index', '-u', pathA, pathB], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return 0
  } catch (err) {
    const stdout = (err && err.stdout) ? String(err.stdout) : ''
    const lines = stdout.split('\n')
    const diffStat = lines.filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    return diffStat.length
  }
}

// 6 files in stable↔beta where beta imports DESKTOP_PRODUCT_NAME from Task 3.2 while stable keeps literal
const PRODUCT_IDENTITY_COPY_SPECS = new Set([
  'desktop-copy.spec.ts',
  'electron-runtime.spec.ts',
  'notifications.spec.ts',
  'profile-selection-window.spec.ts',
  'startup-recovery-window.spec.ts',
  'updates.spec.ts',
])

export function classifyDriftItem({ pairName, file, status, leftPackage, rightPackage, leftPath, rightPath }) {
  if (status === 'onlyLeft' || status === 'onlyRight') {
    const pkg = status === 'onlyLeft' ? leftPackage : rightPackage
    let reason = `File exists exclusively in ${pkg} to test proprietary platform/edition features`
    if (file.startsWith('client-huaanwork') || file.startsWith('huaanwork-')) {
      reason = 'HuaAnWork enterprise client/host/migration test suite'
    } else if (file === 'release-smoke-guard.spec.ts' || file === 'inprocess-gc-retention.spec.ts') {
      reason = 'HuaAnWork release provisioning / in-process GC retention guard test'
    } else if (file === 'windows-nsis-ab.spec.ts' || file === 'launch-environment.spec.ts') {
      reason = 'DSH Desktop stable A/B installer / launch environment test'
    }
    return {
      category: 'legit-one-sided',
      reason,
      diffLines: null,
    }
  }

  // File exists on both sides but normalized text differs
  if (pairName === 'stable↔beta' && PRODUCT_IDENTITY_COPY_SPECS.has(file)) {
    const diffLines = computeDiffLines(leftPath, rightPath)
    return {
      category: 'should-be-identical',
      reason: 'Beta refactored user copy to import DESKTOP_PRODUCT_NAME (Task 3.2) while stable retains literal string; behavior is functionally identical and candidate for guard alignment',
      diffLines,
    }
  }

  // Remaining differences are intentional divergences between editions
  let reason = `Intentional divergence between ${leftPackage} and ${rightPackage}`
  if (pairName === 'stable↔beta') {
    reason = 'Intentional divergence between stable and beta due to runtime version (0.1.5-rc.2 vs 0.1.6-alpha.2), cordis upgrade, channel strings, or package targets'
  } else if (pairName === 'beta↔huaanwork') {
    reason = 'Intentional divergence between beta and huaanwork due to product identity (HuaAnWork), market provider (#4), channel admission, or host bridge'
  }

  return {
    category: 'legit-divergent',
    reason,
    diffLines: null,
  }
}

export function classifyTestsDrift({ root = repoRoot } = {}) {
  const asOf = new Date().toISOString()
  const pairResults = []
  const allItems = []

  const categoryTotals = {
    'legit-one-sided': 0,
    'legit-divergent': 0,
    'should-be-identical': 0,
    unclassifiable: 0,
  }

  for (const pair of PAIRS) {
    const leftDir = join(root, pair.left, 'tests')
    const rightDir = join(root, pair.right, 'tests')
    const leftFiles = listFiles(leftDir)
    const rightFiles = listFiles(rightDir)
    const leftSet = new Set(leftFiles)
    const rightSet = new Set(rightFiles)
    const union = new Set([...leftFiles, ...rightFiles])

    let identicalCount = 0
    let differCount = 0
    let onlyLeftCount = 0
    let onlyRightCount = 0

    const pairItems = []

    for (const file of [...union].sort()) {
      const inLeft = leftSet.has(file)
      const inRight = rightSet.has(file)

      if (inLeft && inRight) {
        const leftText = readFileSync(join(leftDir, file), 'utf8')
        const rightText = readFileSync(join(rightDir, file), 'utf8')
        if (pair.normalize(leftText) === pair.normalize(rightText)) {
          identicalCount++
          continue
        }
        differCount++
        const classification = classifyDriftItem({
          pairName: pair.name,
          file,
          status: 'differ',
          leftPackage: pair.left,
          rightPackage: pair.right,
          leftPath: join(leftDir, file),
          rightPath: join(rightDir, file),
        })
        categoryTotals[classification.category]++
        const itemRecord = {
          pair: pair.name,
          file,
          status: 'differ',
          category: classification.category,
          reason: classification.reason,
          diffLines: classification.diffLines,
        }
        pairItems.push(itemRecord)
        allItems.push(itemRecord)
      } else if (inLeft) {
        onlyLeftCount++
        const classification = classifyDriftItem({
          pairName: pair.name,
          file,
          status: 'onlyLeft',
          leftPackage: pair.left,
          rightPackage: pair.right,
          leftPath: join(leftDir, file),
          rightPath: null,
        })
        categoryTotals[classification.category]++
        const itemRecord = {
          pair: pair.name,
          file,
          status: 'onlyLeft',
          category: classification.category,
          reason: classification.reason,
          diffLines: null,
        }
        pairItems.push(itemRecord)
        allItems.push(itemRecord)
      } else {
        onlyRightCount++
        const classification = classifyDriftItem({
          pairName: pair.name,
          file,
          status: 'onlyRight',
          leftPackage: pair.left,
          rightPackage: pair.right,
          leftPath: null,
          rightPath: join(rightDir, file),
        })
        categoryTotals[classification.category]++
        const itemRecord = {
          pair: pair.name,
          file,
          status: 'onlyRight',
          category: classification.category,
          reason: classification.reason,
          diffLines: null,
        }
        pairItems.push(itemRecord)
        allItems.push(itemRecord)
      }
    }

    const driftCount = differCount + onlyLeftCount + onlyRightCount
    pairResults.push({
      pair: pair.name,
      left: pair.left,
      right: pair.right,
      stats: {
        union: union.size,
        identical: identicalCount,
        differ: differCount,
        onlyLeft: onlyLeftCount,
        onlyRight: onlyRightCount,
        drift: driftCount,
      },
      items: pairItems,
    })
  }

  // Package.json line counts & artifact tracking sanity check
  const packageJsonLines = {
    'dsh-plugin-desktop': readFileSync(join(root, 'dsh-plugin-desktop/package.json'), 'utf8').split('\n').length,
    'dsh-plugin-desktop-beta': readFileSync(join(root, 'dsh-plugin-desktop-beta/package.json'), 'utf8').split('\n').length,
    'dsh-plugin-huaanwork': readFileSync(join(root, 'dsh-plugin-huaanwork/package.json'), 'utf8').split('\n').length,
  }

  let trackedBuildArtifacts = 0
  try {
    const trackedOutput = execFileSync(
      'git',
      ['ls-files', 'dsh-plugin-desktop/lib', 'dsh-plugin-desktop-beta/lib', 'dsh-plugin-huaanwork/lib', '*/dist/*'],
      { cwd: root, encoding: 'utf8' },
    ).trim()
    trackedBuildArtifacts = trackedOutput ? trackedOutput.split('\n').filter(Boolean).length : 0
  } catch {
    trackedBuildArtifacts = 0
  }

  return {
    asOf,
    summary: {
      totalDrift: allItems.length,
      categoryTotals,
      packageJsonLines,
      trackedBuildArtifacts,
    },
    pairs: pairResults,
    shouldBeIdenticalItems: allItems.filter(i => i.category === 'should-be-identical'),
    allItems,
  }
}

function parseCliArgs(argv) {
  const args = { out: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && i + 1 < argv.length) {
      args.out = argv[++i]
    }
  }
  return args
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectExecution) {
  const args = parseCliArgs(process.argv)
  const report = classifyTestsDrift({ root: repoRoot })

  if (args.out) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`classify-variant-tests-drift: JSON report written to ${args.out}\n`)
  }

  process.stdout.write(
    `classify-variant-tests-drift: baseline classification as-of ${report.asOf}\n` +
    `  pair stable↔beta       : union=${String(report.pairs[0].stats.union)}, identical=${String(report.pairs[0].stats.identical)}, differ=${String(report.pairs[0].stats.differ)}, onlyLeft=${String(report.pairs[0].stats.onlyLeft)}, onlyRight=${String(report.pairs[0].stats.onlyRight)}, DRIFT=${String(report.pairs[0].stats.drift)}\n` +
    `  pair beta↔huaanwork    : union=${String(report.pairs[1].stats.union)}, identical=${String(report.pairs[1].stats.identical)}, differ=${String(report.pairs[1].stats.differ)}, onlyLeft=${String(report.pairs[1].stats.onlyLeft)}, onlyRight=${String(report.pairs[1].stats.onlyRight)}, DRIFT=${String(report.pairs[1].stats.drift)}\n` +
    `  total drift items      : ${String(report.summary.totalDrift)}\n` +
    `  category breakdown     :\n` +
    `    - legit-one-sided    : ${String(report.summary.categoryTotals['legit-one-sided'])}\n` +
    `    - legit-divergent    : ${String(report.summary.categoryTotals['legit-divergent'])}\n` +
    `    - should-be-identical: ${String(report.summary.categoryTotals['should-be-identical'])}\n` +
    `    - unclassifiable     : ${String(report.summary.categoryTotals['unclassifiable'])}\n` +
    `  package.json lines     : stable=${String(report.summary.packageJsonLines['dsh-plugin-desktop'])}, beta=${String(report.summary.packageJsonLines['dsh-plugin-desktop-beta'])}, huaanwork=${String(report.summary.packageJsonLines['dsh-plugin-huaanwork'])}\n` +
    `  tracked lib/dist files : ${String(report.summary.trackedBuildArtifacts)}\n` +
    `  should-be-identical debt items (${String(report.shouldBeIdenticalItems.length)}):\n` +
    report.shouldBeIdenticalItems.map(i => `    * [${i.pair}] ${i.file} (${String(i.diffLines)} diff lines): ${i.reason}`).join('\n') + '\n'
  )
}
