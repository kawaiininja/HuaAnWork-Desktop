import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu
const DESKTOP_MODULE = /(?:^|\/)dsh-plugin-(?:desktop(?:-beta)?|huaanwork)(?:\/|$)/u
const MARKET_SERVER_MODULE = /(?:^|\/)market-server(?:\/|$)/u

// Market 面受检根(round3 R10):market 源只 import 上游 contracts/标准库,
// 不得 import 任何 dsh-plugin-* 桌面实现。
const MARKET_SOURCE_ROOTS = ['dsh-community-market/src', 'market-server/src']
// 反向规则(round3 R10):桌面插件源不得 import market-server 服务端内部
// (market-server 是独立服务端工作区,消费面经 wrapper + 上游 contracts,不直通服务端代码)。
const DESKTOP_SOURCE_ROOTS = [
  'dsh-plugin-desktop/src',
  'dsh-plugin-desktop-beta/src',
  'dsh-plugin-huaanwork/src',
]

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function importedSpecifiers(source) {
  return [...source.matchAll(IMPORT_SPECIFIER)].map(match => match[1] ?? '')
}

export function verifyMarketDependencyDirection(files) {
  const violations = []
  for (const [path, source] of files) {
    for (const specifier of importedSpecifiers(source)) {
      if (DESKTOP_MODULE.test(normalizePath(specifier))) {
        violations.push(normalizePath(path))
        break
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Market source must not import Desktop implementation: ${violations.join(', ')}`)
  }
  return { fileCount: files.length }
}

export function verifyDesktopDependencyDirection(files) {
  const violations = []
  for (const [path, source] of files) {
    for (const specifier of importedSpecifiers(source)) {
      if (MARKET_SERVER_MODULE.test(normalizePath(specifier))) {
        violations.push(normalizePath(path))
        break
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Desktop source must not import the market-server workspace: ${violations.join(', ')}`)
  }
  return { fileCount: files.length }
}

function readTrackedSources(root, dirs) {
  const paths = execFileSync('git', ['ls-files', '-z', '--', ...dirs], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(path => /\.[cm]?[jt]sx?$/u.test(path))
    .map(normalizePath)
  return paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')])
}

export function verifyTrackedMarketDependencyDirection(root) {
  // 注意:受检文件集来自 git ls-files——未跟踪的新文件须先 git add 才受检
  // (market-server/src 尚不存在时 ls-files 自然返回空集,守卫不空转报错)。
  const marketFiles = readTrackedSources(root, MARKET_SOURCE_ROOTS)
  const desktopFiles = readTrackedSources(root, DESKTOP_SOURCE_ROOTS)
  verifyMarketDependencyDirection(marketFiles)
  verifyDesktopDependencyDirection(desktopFiles)
  return { fileCount: marketFiles.length + desktopFiles.length }
}
