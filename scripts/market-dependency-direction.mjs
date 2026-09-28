import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu
const DESKTOP_MODULE = /(?:^|\/)dsh-plugin-(?:desktop(?:-beta)?|huaanwork)(?:\/|$)/u
const SERVER_WORKSPACE_MODULE = /(?:^|\/)(?:market-server|update-server)(?:\/|$)/u

// Market 面受检根(round3 R10):market 源只 import 上游 contracts/标准库,
// 不得 import 任何 dsh-plugin-* 桌面实现。
const MARKET_SOURCE_ROOTS = ['dsh-community-market/src', 'market-server/src', 'update-server/src']
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
      if (SERVER_WORKSPACE_MODULE.test(normalizePath(specifier))) {
        violations.push(normalizePath(path))
        break
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Desktop source must not import a server workspace (market-server / update-server): ${violations.join(', ')}`)
  }
  return { fileCount: files.length }
}

// 解法 A(spec §14 第 40 条)的机器守卫(评审 P15):远程市场安装**绝不**经
// runExternalMarketPluginInstall 或 pnpm 的 registry 流——那条路让 pnpm 自行下载
// tarball、只信 registry 元数据的 dist.integrity,已验签清单被绕过(P0,计划
// plan-review 第二轮订正);同理**绝不**以 --prefer-offline 降级替代 --offline
// (会回网,兜底失效)。此前这两条只有「wrapper 从不 import 它」的结构性事实与
// e2e 的 argv 精确快照,无专门守卫;任何未来改动引入即红。
// 放在本文件是因为它同属 market 面的架构约束、且复用同一套 git ls-files 受检根。
const MARKET_WRAPPER_ROOT = 'dsh-plugin-huaanwork/src/huaanwork-host/market'
// 匹配**代码形态**而非裸词:install.ts 的两处 docstring 就在解释「为什么不走这条
// 路」,裸词匹配会误报。故要求调用括号、具名 import 花括号、或引号内的 flag 字面量。
const INSTALL_PATH_BYPASS_PATTERNS = [
  /runExternalMarketPluginInstall\s*\(/u,
  /import\s*\{[^}]*\brunExternalMarketPluginInstall\b/u,
  /['"`]--registry\b/u,
  /['"`]--prefer-offline\b/u,
  /\bnpm_config_registry\b/u,
]

export function verifyMarketInstallPathHasNoRegistryBypass(files) {
  const violations = []
  for (const [path, source] of files) {
    if (!normalizePath(path).startsWith(`${MARKET_WRAPPER_ROOT}/`)) continue
    for (const pattern of INSTALL_PATH_BYPASS_PATTERNS) {
      if (pattern.test(source)) {
        violations.push(`${normalizePath(path)} (${String(pattern)})`)
        break
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Market wrapper install path must not bypass the signed manifest (no runExternalMarketPluginInstall, no pnpm --registry, no --prefer-offline downgrade): ${violations.join(', ')}`,
    )
  }
  return { fileCount: files.length }
}

function readTrackedSources(root, dirs) {  const paths = execFileSync('git', ['ls-files', '-z', '--', ...dirs], {
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
  const wrapperFiles = readTrackedSources(root, [MARKET_WRAPPER_ROOT])
  verifyMarketDependencyDirection(marketFiles)
  verifyDesktopDependencyDirection(desktopFiles)
  verifyMarketInstallPathHasNoRegistryBypass(wrapperFiles)
  return {
    fileCount: marketFiles.length + desktopFiles.length,
    wrapperFileCount: wrapperFiles.length,
  }
}
