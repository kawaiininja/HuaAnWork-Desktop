import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

import type { DesktopPnpm, DesktopPnpmHandle } from '../pnpm.ts'
import { DESKTOP_PACKAGE_NAMES } from '../product-identity.ts'

/**
 * 插件清单读路径(Task 10):读 profileDir package.json 的 `dsh.profile.bundles`,
 * 逐字移植自旧 sidecar plugins.ts:35,142-154 的 listPlugins / readBundleList。
 *
 * 存储根:旧 sidecar 读 `$DSH_HOME/profiles/<name>/package.json`;Desktop 组合下
 * profileDir 本身就是该目录,直接读 `<profileDir>/package.json`。manifest 缺失
 * (档案尚未物化)时回落 REQUIRED_BUNDLES(src/profile.ts:85 desktopBundleList 的
 * composition 前导,即随包分发的 web 模板 bundle)。注意 dsh-plugin-huaanwork 是
 * DESKTOP_PACKAGE_NAME(走 patch 行组合,src/profile.ts:981),从不出现在
 * dsh.profile.bundles 清单里,不得列入回落。
 */

/**
 * 档案清单缺失时的回落 bundle 清单 = REQUIRED_BUNDLES(web profile 模板,
 * PROFILE_TEMPLATES.web.bundles;与 src/profile.ts:239 requiredWebBundles 同源)。
 * 读路径不硬失败:物化器不可用时回落到发布期已知的 web 模板前导。
 */
export function fallbackProfileBundles(): string[] {
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  return [...template.bundles]
}

/**
 * 不可移除的 bundle(与 src/desktop-plugins.ts IMMUTABLE_BUNDLES 同口径:
 * web 模板 bundle + 桌面包名(DESKTOP_PACKAGE_NAMES)+ 历史/市场固定项;
 * M4 plugin.remove 写路径消费,防止把随包 carrier 标为可移除)。
 */
export const IMMUTABLE_BUNDLES: ReadonlySet<string> = new Set([
  ...fallbackProfileBundles(),
  '@deepseek-ai/dsh-desktop-app',
  ...DESKTOP_PACKAGE_NAMES,
  'dsh-community-market',
])

export function listPlugins(storageRoot: string): { bundles: string[] } {
  return { bundles: readBundleList(storageRoot) }
}

function readBundleList(storageRoot: string): string[] {
  const path = join(storageRoot, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((bundle): bundle is string => typeof bundle === 'string') : []
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallbackProfileBundles()
    throw error
  }
}

const remoteSource = /github:|git\+|https?:\/\//i

/**
 * plugin.add / plugin.remove 的调用方。RouteContext 结构上满足本类型;
 * desktopPnpm 由 holders 挂上,缺席时再向 runtimeCtx 查 desktopPnpm 服务。
 */
export interface PluginMutationContext {
  profileDir: string
  logger(message: string): void
  requestRestart(): Promise<boolean>
  desktopPnpm?: Pick<DesktopPnpm, 'runPlugin'>
  runtimeCtx?: object
}

/**
 * `{ bundles }` 必含。`restarting` 只在用户确认重启时出现。
 * 目录安装能从 package.json name 推断出新清单时,确认体只有这份清单,不带 message。
 * message 只在确认体确实是未改过的上一份清单(tarball,或名字已经在清单里)或档案回落清单时出现。
 */
export type PluginMutationResult = { bundles: string[]; restarting?: true; message?: string }

/**
 * 带 HTTP 状态的插件命令失败(单并发 409、执行器缺席 503)。
 * 其余校验失败抛普通 Error,由 pluginRoute 映成 400 plugin-error。
 */
export class PluginCommandError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PluginCommandError'
    this.status = status
    this.code = code
  }
}

/**
 * 本地插件安装与卸载。
 *
 * 顺序是 listPlugins → desktopPnpm.runPlugin → requestRestart。安装必须先结束:
 * requestConfirmedRestart 确认后用 setImmediate 安排 relaunch,CLI 未结束就被掐会留下半成品。
 *
 * 取消不置 restarting,应答安装前的 listPlugins 快照(评审 P1-2)。本函数不改写 profile,
 * 也不自造回滚。CLI 若已写入声明式清单,取消只是不重启。
 *
 * 安装后 boot 失败(bad bundle 触发 row-id 断言失败等)不是自动回滚。Desktop 由
 * routeDesktopStartupFailure(main.ts:1776-1812)转入启动恢复窗口(openStartupRecoveryWindow),
 * 用户在其中选 slot、preview→confirm 还原(profile-checkpoint.ts:642 restoreSlot)。
 * 健康快照由 captureHealthy()(profile-checkpoint.ts:564)在成功启动时写入,反映上一次
 * 健康启动的声明式清单。这是需人工介入的恢复。compose gate 的 Desktop 等价是 boot 期
 * row-id 启动断言,重启即被覆盖,此处不另造检查。
 */
export async function addPlugin(routeCtx: PluginMutationContext, source: string): Promise<PluginMutationResult> {
  if (!source) throw new Error('plugin.add requires source')
  assertNotRemote(source)
  const resolved = resolve(source)
  const packageName = isTarballFile(resolved) ? undefined : validatedDirectoryPackage(resolved)
  const before = listPlugins(routeCtx.profileDir).bundles
  await runDesktopPlugin(routeCtx, ['add', resolved])
  if (!await routeCtx.requestRestart()) {
    return { bundles: [...before] }
  }
  const listed = bundlesAfterAdd(routeCtx, before, packageName)
  return { bundles: listed.bundles, restarting: true, ...(listed.message ? { message: listed.message } : {}) }
}

/** remove 与 add 同构:无来源校验,IMMUTABLE_BUNDLES 直接拒绝。恢复口径见 addPlugin。 */
export async function removePlugin(routeCtx: PluginMutationContext, name: string): Promise<PluginMutationResult> {
  if (!name) throw new Error('plugin.remove requires name')
  if (IMMUTABLE_BUNDLES.has(name)) {
    throw new Error(`cannot remove protected package ${name}`)
  }
  const before = listPlugins(routeCtx.profileDir).bundles
  await runDesktopPlugin(routeCtx, ['remove', name])
  if (!await routeCtx.requestRestart()) {
    return { bundles: [...before] }
  }
  const listed = bundlesAfterRemove(routeCtx, before, name)
  return { bundles: listed.bundles, restarting: true, ...(listed.message ? { message: listed.message } : {}) }
}

function assertNotRemote(source: string): void {
  if (remoteSource.test(source)) {
    throw new Error(`remote plugin sources are not allowed: ${source}`)
  }
}

function isTarballFile(source: string): boolean {
  if (!source.toLowerCase().endsWith('.tgz')) return false
  try {
    return existsSync(source) && statSync(source).isFile()
  } catch {
    return false
  }
}

function validatedDirectoryPackage(source: string): string {
  const manifest = readManifest(join(source, 'package.json'))
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new Error('plugin package.json is missing name')
  }
  if (manifest.dsh?.bundle == null) {
    throw new Error('package must declare dsh.bundle')
  }
  return manifest.name
}

function readManifest(path: string): { name?: string; dsh?: { bundle?: unknown } } {
  if (!existsSync(path)) {
    throw new Error(`plugin source is not a local package: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; dsh?: { bundle?: unknown } }
}

function desktopPnpmOf(routeCtx: PluginMutationContext): Pick<DesktopPnpm, 'runPlugin'> {
  if (routeCtx.desktopPnpm && typeof routeCtx.desktopPnpm.runPlugin === 'function') {
    return routeCtx.desktopPnpm
  }
  const runtime = routeCtx.runtimeCtx as { get?: (name: string) => unknown } | undefined
  let service: unknown
  try {
    service = runtime?.get?.('desktopPnpm')
  } catch {
    service = undefined
  }
  if (service && typeof (service as { runPlugin?: unknown }).runPlugin === 'function') {
    return service as Pick<DesktopPnpm, 'runPlugin'>
  }
  throw new PluginCommandError(503, 'pnpm-unavailable', 'desktopPnpm.runPlugin is not available')
}

function asPnpmBusy(error: unknown): PluginCommandError | undefined {
  if (error instanceof PluginCommandError) return error
  if (error instanceof Error && error.message.includes('another desktop pnpm operation is already running')) {
    return new PluginCommandError(409, 'pnpm-busy', error.message)
  }
  return undefined
}

async function runDesktopPlugin(routeCtx: PluginMutationContext, argv: readonly [string, string]): Promise<void> {
  const invokingDir = resolve(routeCtx.profileDir)
  let handle: DesktopPnpmHandle
  try {
    handle = desktopPnpmOf(routeCtx).runPlugin(argv, invokingDir)
  } catch (error) {
    const busy = asPnpmBusy(error)
    if (busy) throw busy
    throw error
  }
  resumePipe(handle.stdout)
  resumePipe(handle.stderr)
  let outcome: Awaited<DesktopPnpmHandle['done']>
  try {
    outcome = await handle.done
  } catch (error) {
    const busy = asPnpmBusy(error)
    if (busy) throw busy
    throw error
  }
  if (outcome.exitCode !== 0) {
    const command = argv[0]
    throw new Error(`dsh plugin ${command} failed (exit ${outcome.exitCode})`)
  }
}

function resumePipe(stream: { resume?: () => void } | undefined): void {
  try {
    stream?.resume?.()
  } catch {
    // 测试桩可以不提供可读流。
  }
}

function readBundlesAfter(routeCtx: PluginMutationContext, phase: string): string[] | undefined {
  try {
    return listPlugins(routeCtx.profileDir).bundles
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    routeCtx.logger(`plugin ${phase}: post-change bundle list unreadable (${detail}); returning the previous list`)
    return undefined
  }
}

function bundlesAfterAdd(
  routeCtx: PluginMutationContext,
  before: string[],
  packageName: string | undefined,
): { bundles: string[]; message?: string } {
  const after = readBundlesAfter(routeCtx, 'add')
  if (after !== undefined && after.length > 0) return { bundles: after }
  if (packageName !== undefined && !before.includes(packageName)) {
    routeCtx.logger('plugin add: post-install bundle list empty; inferred the added package onto the previous list')
    return { bundles: [...before, packageName] }
  }
  if (before.length > 0) {
    const message = 'could not read a non-empty installed bundle list; returning the previous list'
    routeCtx.logger(`plugin add: ${message}`)
    return { bundles: [...before], message }
  }
  const fallback = fallbackProfileBundles()
  if (fallback.length > 0) {
    const message = 'could not read a non-empty installed bundle list; returning the profile fallback'
    routeCtx.logger(`plugin add: ${message}`)
    return { bundles: fallback, message }
  }
  throw new PluginCommandError(500, 'plugin-error', 'plugin add: bundle list is empty')
}

function bundlesAfterRemove(
  routeCtx: PluginMutationContext,
  before: string[],
  name: string,
): { bundles: string[]; message?: string } {
  const after = readBundlesAfter(routeCtx, 'remove')
  if (after !== undefined && after.length > 0) return { bundles: after }
  const message = 'could not read a non-empty installed bundle list; returning the previous list'
  routeCtx.logger(`plugin remove: ${message}`)
  return {
    bundles: nonEmptyBundles(routeCtx, before.filter((bundle) => bundle !== name), before, 'remove'),
    message,
  }
}

/** 不把空数组静默交回客户端。读不到新清单时回上一份非空清单,并记一条日志。 */
function nonEmptyBundles(routeCtx: PluginMutationContext, bundles: string[], prior: string[], phase: string): string[] {
  if (bundles.length > 0) return bundles
  if (prior.length > 0) {
    routeCtx.logger(`plugin ${phase}: bundle list empty; returning the previous list`)
    return prior
  }
  const fallback = fallbackProfileBundles()
  if (fallback.length > 0) {
    routeCtx.logger(`plugin ${phase}: bundle list empty; returning the profile fallback`)
    return fallback
  }
  throw new PluginCommandError(500, 'plugin-error', `plugin ${phase}: bundle list is empty`)
}
