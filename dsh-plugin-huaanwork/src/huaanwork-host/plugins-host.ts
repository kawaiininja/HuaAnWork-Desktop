import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

import type { DesktopPnpm, DesktopPnpmHandle } from '../pnpm.ts'
import { DESKTOP_PACKAGE_NAMES } from '../product-identity.ts'
import { gcRemovedPackageArtifacts } from './market/artifacts.ts'
import { HUAANWORK_MARKET_BUNDLE_NAME } from './market/config.ts'

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
 * 不可移除的 bundle(plugin.remove 写路径的权威判定,M4):
 * web 模板 bundle + 桌面包名(DESKTOP_PACKAGE_NAMES)+ 历史/市场固定项。
 * 注意(round3 R20 订正):本集与 src/desktop-plugins.ts 的 IMMUTABLE_BUNDLES
 * **不同口径、各自维护**——后者只服务 DesktopPluginsService 的卸载预览,
 * wrapper 消费面不经由它;两边的增删互不要求同步。
 * M5:内网 market wrapper bundle(huaanwork-market)随包 carrier,防被 remove。
 */
export const IMMUTABLE_BUNDLES: ReadonlySet<string> = new Set([
  ...fallbackProfileBundles(),
  '@deepseek-ai/dsh-desktop-app',
  ...DESKTOP_PACKAGE_NAMES,
  'dsh-community-market',
  HUAANWORK_MARKET_BUNDLE_NAME,
])

export function listPlugins(storageRoot: string): { bundles: string[] } {
  return { bundles: readBundleList(storageRoot) }
}

function readBundleList(storageRoot: string): string[] {
  return readBundleManifest(storageRoot) ?? fallbackProfileBundles()
}

/**
 * 读取档案声明式清单;package.json 缺失(ENOENT)返回 undefined,其余错误照抛。
 * readBundleList 由此回落模板兜底(plugin.list 路由语义不变);post-change 的
 * 权威读取(bundlesAfterAdd/Remove)必须走本函数——ENOENT 时返回 undefined,
 * 不得把模板兜底当作安装结果(M4 评审 P2)。
 */
function readBundleManifest(storageRoot: string): string[] | undefined {
  const path = join(storageRoot, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((bundle): bundle is string => typeof bundle === 'string') : []
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
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
 * 也不自造回滚。CLI 若已写入声明式清单,取消只是不重启——取消应答以 message 诚实告知
 * 「已写入清单,下次启动生效」(M4 评审 D3 处置:remove 侧无原始来源可对称回滚,
 * 主推荐「profile 变更挪到确认之后」因 setImmediate relaunch 不可实施,均见附录 D-3)。
 *
 * 安装后 boot 失败(bad bundle 触发 row-id 断言失败等)不是自动回滚。Desktop 由
 * routeDesktopStartupFailure(main.ts:1776-1812)转入启动恢复窗口(openStartupRecoveryWindow),
 * 用户在其中选 slot、preview→confirm 还原(profile-checkpoint.ts:642 restoreSlot)。
 * 健康快照由 captureHealthy()(profile-checkpoint.ts:564)在成功启动时写入,反映上一次
 * 健康启动的声明式清单。这是需人工介入的恢复。compose gate 的 Desktop 等价是 boot 期
 * row-id 启动断言,重启即被覆盖,此处不另造检查。
 */
/** addPlugin 的可选选项。M5 市场远程安装传 offline:true;本地调用方不传(M4 语义不变)。 */
export interface AddPluginOptions {
  /**
   * 市场远程安装路径专用:true 时 pnpm 恒带 --offline --ignore-scripts。
   * --offline 把「零依赖断言失准」从静默拉公网字节变成确定性失败;
   * --ignore-scripts 机械封死 lifecycle 脚本(即使 profile workspace 被自加
   * allowBuilds,市场制品脚本也永不执行)。flags 经 dsh plugin CLI 直通 pnpm
   * (其 plugin 子命令 allowUnknownOption + verbatim 转发,anchorPathSpec 只
   * 改写 . / .. 相对路径,不影响 flags)。
   */
  readonly offline?: boolean
}

export async function addPlugin(
  routeCtx: PluginMutationContext,
  source: string,
  opts?: AddPluginOptions,
): Promise<PluginMutationResult> {
  if (!source) throw new Error('plugin.add requires source')
  assertNotRemote(source)
  const resolved = resolve(source)
  const packageName = isTarballFile(resolved) ? undefined : validatedDirectoryPackage(resolved)
  const before = listPlugins(routeCtx.profileDir).bundles
  const argv: readonly [string, string, ...string[]] = opts?.offline === true
    ? ['add', resolved, '--offline', '--ignore-scripts']
    : ['add', resolved]
  await runDesktopPlugin(routeCtx, argv)
  if (!await routeCtx.requestRestart()) {
    return {
      bundles: [...before],
      message: '已取消重启：插件已写入清单，下次启动时生效',
    }
  }
  const listed = bundlesAfterAdd(routeCtx, before, packageName)
  return { bundles: listed.bundles, restarting: true, ...(listed.message ? { message: listed.message } : {}) }
}

/** remove 与 add 同构:无来源校验,IMMUTABLE_BUNDLES 直接拒绝。取消应答同样
 * 以 message 诚实告知清单已写入(恢复口径见 addPlugin,M4 评审 D3)。
 * M5(N1 GC):pnpm remove 成功后清理 `.market-artifacts/` 里该包的制品
 * (其 `file:` 引用已被移除;best-effort,绝不阻断卸载)。 */
export async function removePlugin(routeCtx: PluginMutationContext, name: string): Promise<PluginMutationResult> {
  if (!name) throw new Error('plugin.remove requires name')
  if (IMMUTABLE_BUNDLES.has(name)) {
    throw new Error(`cannot remove protected package ${name}`)
  }
  const before = listPlugins(routeCtx.profileDir).bundles
  await runDesktopPlugin(routeCtx, ['remove', name])
  gcRemovedPackageArtifacts(routeCtx.profileDir, name, routeCtx.logger)
  if (!await routeCtx.requestRestart()) {
    return {
      bundles: [...before],
      message: '已取消重启：插件已从清单移除，下次启动时不再加载',
    }
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

/**
 * argv 形如 [command, target, ...flags]:M5 起允许追加 pnpm flags(市场远程安装
 * 的 --offline --ignore-scripts);flags 经 dsh plugin CLI 直通 pnpm。
 */
async function runDesktopPlugin(
  routeCtx: PluginMutationContext,
  argv: readonly [string, string, ...string[]],
): Promise<void> {
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
    // P2(M4 评审):post-change 清单必须权威可读——ENOENT 返回 undefined 走推断/诚实
    // 应答分支,不得把 readBundleList 的模板兜底当作安装结果(新装/既有 bundles 会
    // 从客户端插件列表静默消失)。
    const read = readBundleManifest(routeCtx.profileDir)
    if (read === undefined) {
      routeCtx.logger(`plugin ${phase}: post-change bundle list unreadable (profile manifest missing); not treated as the installed list`)
    }
    return read
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
  const filtered = before.filter((bundle) => bundle !== name)
  const bundles = nonEmptyBundles(routeCtx, filtered, before, 'remove')
  // nonEmptyBundles 在过滤结果为空时交回 prior(即 before)。只有载荷真的去掉了 name 才称推断。
  const inferred = before.includes(name) && !bundles.includes(name)
  const message = inferred
    ? 'could not read a non-empty installed bundle list; inferred the removed package from the previous list'
    : 'could not read a non-empty installed bundle list; returning the previous list'
  routeCtx.logger(`plugin remove: ${message}`)
  return { bundles, message }
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
