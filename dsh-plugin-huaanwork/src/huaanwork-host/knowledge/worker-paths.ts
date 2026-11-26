/**
 * 知识库 Worker 入口的深度无关路径解析（R3-B2 修复）。
 *
 * Worker 以 `.ts` 源码（Vitest / Node type-stripping）或构建产物 `.js`
 * 两种形态装载，调用方可能位于 `src/...`、`lib/...` 的不同目录深度。
 * 因此这里不按固定 `../` 层数推导，而是从调用方文件向上找到最近的
 * `package.json` 包根，再按「调用方是否在包内 `src/` 下的 `.ts` 源码」
 * 选择同构的 Worker 入口扩展名。
 */

import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 向上查找包根的最大层数：源码树深度远小于此，超出即按最高已检查目录回退。 */
const MAX_PACKAGE_ROOT_WALK_DEPTH = 8

/** 知识库 Worker 种类。 */
export type KnowledgeWorkerKind = 'storage-worker' | 'extraction-worker'

function findPackageRoot(fromDir: string): string {
  let current = fromDir
  for (let depth = 0; depth < MAX_PACKAGE_ROOT_WALK_DEPTH; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`resolveKnowledgeWorkerUrl: could not locate package.json above ${fromDir}`)
}

/**
 * 解析知识库 Worker 入口 URL。
 *
 * @param kind - Worker 种类，决定入口文件名。
 * @param fromUrl - 调用方模块的 URL（缺省为本模块的 `import.meta.url`）。
 * @returns `src/...` 源码树调用方 → `.ts` 入口；`lib/...` 构建产物调用方 → `.js` 入口。
 */
export function resolveKnowledgeWorkerUrl(kind: KnowledgeWorkerKind, fromUrl?: string): URL {
  const callerUrl = fromUrl ?? import.meta.url
  const callerPath = fileURLToPath(callerUrl)
  const pkgRoot = findPackageRoot(dirname(callerPath))
  const relFromPkg = relative(pkgRoot, callerPath)
  // Windows 下 relative 用 `\` 分隔，POSIX 下用 `/`；首段比较必须两种都兼容。
  const isSource = callerPath.endsWith('.ts') && relFromPkg.split(/[/\\]/u)[0] === 'src'
  return isSource
    ? pathToFileURL(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', `${kind}.ts`))
    : pathToFileURL(join(pkgRoot, 'lib', 'huaanwork-host', 'knowledge', `${kind}.js`))
}
