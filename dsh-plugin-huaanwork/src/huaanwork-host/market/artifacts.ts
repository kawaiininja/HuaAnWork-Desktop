/**
 * huaanwork-market 制品目录助手(M5 Task 5)。
 *
 * 制品布局(round5 N1,〈安装入口边界〉④):
 * `<profileDir>/.market-artifacts/<name>-<version>-<sha256前12>.tgz`
 * ——目录 0700、文件 0600、**安装后不删除**(pnpm add 把 `file:<绝对路径>` 写进
 * profile package.json,制品与引用共存亡;删制品 ⇒ 任何后续 pnpm 操作 ENOENT,
 * round5 实验 C 实证)。GC 规则:profile package.json 不再含指向制品的 `file:`
 * 引用时才可删(removePlugin 成功后清对应制品;启动时惰性清扫孤儿)。
 *
 * 本模块只放纯助手(无 cordis / 无 plugins-host 依赖),供 install.ts(安装)、
 * routes/index(惰性清扫)与 plugins-host.removePlugin(卸载 GC)共用——
 * 避免 install.ts ⇄ plugins-host.ts 循环依赖。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 制品目录名(profileDir 下,0700)。 */
export const MARKET_ARTIFACTS_DIR_NAME = '.market-artifacts'

/** 计划命名:`<name>-<version>-<sha256前12>.tgz`。 */
export function marketArtifactName(name: string, version: string, sha256hex: string): string {
  return `${safeArtifactName(name)}-${version}-${sha256hex.slice(0, 12)}.tgz`
}

/** scoped 名(如 `@huaanwork/sample`)落盘前净化(与 market-server store 同口径)。 */
export function safeArtifactName(name: string): string {
  return name.replace(/^@/, '').replace(/[\\/]/g, '-')
}

export function marketArtifactsDir(profileDir: string): string {
  return join(profileDir, MARKET_ARTIFACTS_DIR_NAME)
}

/** 确保制品目录存在且为 0700(已存在不改动其权限位,避免与既有目录打架)。 */
export function ensureMarketArtifactsDir(profileDir: string): string {
  const dir = marketArtifactsDir(profileDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

/** 读 profile package.json 的 dependencies 原样(缺文件/缺键返回 {})。 */
export function readProfileDependencies(profileDir: string): Record<string, string> {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return {}
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  return manifest.dependencies ?? {}
}

/**
 * profile dependencies 里所有 `file:` 引用是否都实际存在(N1 回归门的核心断言;
 * 亦是孤儿清扫的判据——无 `file:` 引用指向的制品即孤儿)。
 */
export function profileFileReferencesExist(profileDir: string): boolean {
  for (const reference of Object.values(readProfileDependencies(profileDir))) {
    if (!reference.startsWith('file:')) continue
    if (!existsSync(reference.slice('file:'.length))) return false
  }
  return true
}

function referencedArtifactPaths(profileDir: string): Set<string> {
  const referenced = new Set<string>()
  for (const reference of Object.values(readProfileDependencies(profileDir))) {
    if (!reference.startsWith('file:')) continue
    referenced.add(resolve(reference.slice('file:'.length)))
  }
  return referenced
}

/** 判定制品文件是否被 profile 的 `file:` 引用指向(惰性清扫的保留判据)。 */
export function isArtifactReferenced(profileDir: string, artifactPath: string): boolean {
  return referencedArtifactPaths(profileDir).has(resolve(artifactPath))
}

/**
 * removePlugin 成功后的制品 GC:删除 `<safeName>-*.tgz` 的全部制品
 * (同一包多版本各留一份,卸载即清该包全部制品——其 `file:` 引用已被 pnpm 移除)。
 * best-effort:任何失败只记日志,绝不阻断卸载;不存在的目录直接返回。
 */
export function gcRemovedPackageArtifacts(profileDir: string, packageName: string, logger: (message: string) => void): void {
  const dir = marketArtifactsDir(profileDir)
  if (!existsSync(dir)) return
  const prefix = `${safeArtifactName(packageName)}-`
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tgz')) continue
    const path = join(dir, entry)
    try {
      rmSync(path)
      logger(`huaanwork-market: removed artifact ${entry} after uninstall of ${packageName}`)
    } catch (error) {
      logger(`huaanwork-market: failed to remove artifact ${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 启动时惰性清扫:只删**无 `file:` 引用指向**的孤儿制品(N1:有引用者删了必坏)。
 * best-effort;返回清扫掉的文件名(便于测试断言与日志)。
 */
export function sweepOrphanMarketArtifacts(profileDir: string, logger: (message: string) => void): string[] {
  const dir = marketArtifactsDir(profileDir)
  if (!existsSync(dir)) return []
  const referenced = referencedArtifactPaths(profileDir)
  const removed: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.tgz')) continue
    const path = join(dir, entry)
    if (referenced.has(resolve(path))) continue
    try {
      if (!statSync(path).isFile()) continue
      rmSync(path)
      removed.push(entry)
      logger(`huaanwork-market: swept orphan market artifact ${entry}`)
    } catch (error) {
      logger(`huaanwork-market: failed to sweep artifact ${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return removed
}
