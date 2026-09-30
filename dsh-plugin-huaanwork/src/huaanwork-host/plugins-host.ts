import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

import type { DesktopPnpm, DesktopPnpmHandle } from '../pnpm.ts'
import { DESKTOP_PACKAGE_NAMES } from '../product-identity.ts'
import {
  gcRemovedPackageArtifacts,
  isMarketArtifactVersion,
  MarketArtifactIoError,
  marketArtifactsDir,
  stageMarketArtifact,
} from './market/artifacts.ts'
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

/**
 * 取消重启的诚实告知——**共享文案常量**(Task 6.9 P3;spec §14 第 33 条:
 * 取消 ≠ 未生效)。声明式清单已落盘,下次启动照常生效/不再加载。
 *
 * 安装(addPlugin)、卸载(removePlugin)与表外 restart 路由
 * (`market/routes.ts` 的 request-restart)三处取消分支按名引用本对象,字面量
 * 只允许活在这一处:此前路由回裸「已取消重启」,与两处插件措辞漂移。
 */
export const RESTART_CANCELLED_MESSAGES = {
  /** 插件安装取消:制品已写进 profile 的声明式清单。 */
  installed: '已取消重启：插件已写入清单，下次启动时生效',
  /** 插件卸载取消:已从声明式清单移除。 */
  removed: '已取消重启：插件已从清单移除，下次启动时不再加载',
  /**
   * 表外 restart 路由取消:该路由没有安装/卸载语境(待生效的变更可能是增也可能
   * 是删),故取增删皆准的中立陈述「变更已保存」——不写「已写入清单」(卸载时
   * 事实相反),也不写「未生效」。
   */
  pending: '已取消重启：变更已保存，下次启动时生效',
} as const

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
 * 本地/市场插件写路径的 pnpm 能力面。`runPlugin`(经 `dsh plugin` CLI 安装/卸载)
 * 必需;`run`(直跑 pnpm)可选——本地**目录**源要用它跑 `pnpm pack`,缺席时诚实
 * 503 而不是退回「把源路径直接交给 pnpm」(那正是 Task 6.2 要修的悬空 `file:` 缺陷)。
 * 生产由 DesktopPnpmService 同时实现两者(holders.ts 传的是完整服务实例)。
 */
export type PluginPnpmCapability = Pick<DesktopPnpm, 'runPlugin'> & Partial<Pick<DesktopPnpm, 'run'>>

/**
 * plugin.add / plugin.remove 的调用方。RouteContext 结构上满足本类型;
 * desktopPnpm 由 holders 挂上,缺席时再向 runtimeCtx 查 desktopPnpm 服务。
 */
export interface PluginMutationContext {
  profileDir: string
  logger(message: string): void
  requestRestart(): Promise<boolean>
  desktopPnpm?: PluginPnpmCapability
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
 * 顺序是本地源制品化(裁定 R-2,见 stageLocalPluginSource)→ listPlugins →
 * desktopPnpm.runPlugin → requestRestart。安装必须先结束:
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
/** addPlugin 的可选选项。M5 市场远程安装传 offline:true;本地调用方不传(M4 语义不变,
 *  本地安装的 argv 恒不带两 flag——制品已落 `.market-artifacts/`,不需要 --offline)。 */
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
  // 本地源先落 `.market-artifacts/`(裁定 R-2):安装的是**制品路径**而非源路径,
  // 源被移动/删除不再影响 profile(缺陷机理与取舍见 stageLocalPluginSource)。
  // 已在制品目录内的路径(市场安装链传入的制品)原样直通——不二次落盘、不判版本。
  const staged = await stageLocalPluginSource(routeCtx, resolved)
  const before = listPlugins(routeCtx.profileDir).bundles
  const argv: readonly [string, string, ...string[]] = opts?.offline === true
    ? ['add', staged.artifactPath, '--offline', '--ignore-scripts']
    : ['add', staged.artifactPath]
  await runDesktopPlugin(routeCtx, argv)
  if (!await routeCtx.requestRestart()) {
    return {
      bundles: [...before],
      message: RESTART_CANCELLED_MESSAGES.installed,
    }
  }
  const listed = bundlesAfterAdd(routeCtx, before, staged.packageName)
  return { bundles: listed.bundles, restarting: true, ...(listed.message ? { message: listed.message } : {}) }
}

/**
 * 本地源 → `.market-artifacts/` 制品(裁定 R-2,spec §14 第 42/48 条)。
 *
 * `pnpm add <本地路径>` 把 `file:<源绝对路径>` 写进 profile package.json,制品与
 * 该引用共存亡:源被移动/删除后,**任何后续 `pnpm add` 都以 ENOENT(EXIT=254)
 * 确定性失败**(2026-09-25 实验 A/C;2026-09-30 以随包 pnpm 11.8.0 复现)。故本地
 * 源先复制/打包成制品(与市场安装**同一**命名与落盘函数,见 market/artifacts.ts),
 * 再安装制品路径:制品装后不删,并自动受 checkpoint-aware 的保留/GC 判据保护
 * (第 50 条)。身份(name/version)取自源自身的 package.json。
 *
 * **已在 `.market-artifacts/` 落位的制品直通**(修复轮 1,Important 1):市场安装
 * (`executeMarketInstall`)传进来的就是本目录产物——`isStagedMarketArtifact` 命中时
 * 原样返回,**不二次落盘、不做身份/版本拒绝**。判据是内禀位置而非 `opts.offline`:
 * 发布侧门(market-server gate.ts)只要求 filename-safe 版本(点分 4 段/`abc`/`V1.0`
 * 均可发布),本地命名边界更窄;若把本地门套到市场制品上,今天是「下载成功 →
 * 确定性拒绝」并留下孤儿制品,且读起来像用户的本地源有问题。位置命中即回到本 Task
 * 之前逐字一致的市场行为(裁定 R-2 的拒绝面只针对**本地源**)。
 *
 * `packageName` 只对目录源有值(沿用 M4:`bundlesAfterAdd` 的清单推断分支不认
 * `.tgz` 源);本地路径的 argv 不带 market 的两 flag(`offline` 仅市场安装传)。
 */
async function stageLocalPluginSource(
  routeCtx: PluginMutationContext,
  resolved: string,
): Promise<{ artifactPath: string; packageName?: string }> {
  if (isStagedMarketArtifact(routeCtx.profileDir, resolved)) {
    return { artifactPath: resolved }
  }
  if (isTarballFile(resolved)) {
    // `.tgz`:字节原样复制——被安装字节 = 被复制字节(与市场路径解法 A 同精神)。
    const bytes = readLocalSourceBytes(resolved)
    const identity = localArchiveIdentity(await readLocalTarballManifest(bytes, routeCtx.logger))
    assertStorableIdentity(identity.name, identity.version)
    return { artifactPath: stageLocalBytes(routeCtx, identity, bytes) }
  }
  // 目录:先校验身份(M4 校验语义 + 制品命名边界),再 `pnpm pack` 成 `.tgz`
  // ——目录不能被 pnpm 以 `file:` 引用后删源(M4 缺陷的另一半)。
  const identity = validatedDirectoryPackage(resolved)
  assertStorableIdentity(identity.name, identity.version)
  const bytes = await packLocalDirectory(routeCtx, resolved)
  return {
    artifactPath: stageLocalBytes(routeCtx, identity, bytes),
    packageName: identity.name,
  }
}

/**
 * 解析后的路径是否已在**本 profile 的** `.market-artifacts/` 内(市场安装链
 * `executeMarketInstall` 传入的制品恒在此;market/install.ts 落盘后即调 addPlugin)。
 * 内禀位置判别:命中 ⇒ 制品已落位,直通(见 stageLocalPluginSource,修复轮 1)。
 * `relative` 判据对 `..` 与绝对路径两侧都封死;`resolve` 只做规范化,不触符号链接
 * ——profileDir 与制品路径同基,前缀比较自洽。
 */
function isStagedMarketArtifact(profileDir: string, resolved: string): boolean {
  const dir = resolve(marketArtifactsDir(profileDir))
  const rel = relative(dir, resolved)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 落盘本地源字节;落盘 IO 失败是**宿主**故障 ⇒ 具名 500(消息只带 errno,评审 P1)。 */
function stageLocalBytes(
  routeCtx: PluginMutationContext,
  identity: { name: string; version: string },
  bytes: Buffer,
): string {
  try {
    return stageMarketArtifact(routeCtx.profileDir, identity.name, identity.version, bytes).artifactPath
  } catch (error) {
    if (error instanceof MarketArtifactIoError) {
      throw new PluginCommandError(
        500,
        'plugin-error',
        `plugin add: could not stage the local source into .market-artifacts (${error.errno})`,
      )
    }
    throw error
  }
}

/**
 * 读本地 `.tgz` 的顶层 package.json。
 *
 * 复用 market/install.ts 的 `readTarballPackageJson`(**唯一**的 ustar walker,其
 * manifest 选取规则与发布侧门由共享 fixture 钉住;另写一份会让两侧漂移)——用
 * 懒加载:静态 import 会重新引入 artifacts.ts 的模块注释所要避免的
 * install.ts ⇄ plugins-host.ts 循环依赖。
 *
 * 本地源不是市场制品:那份拒绝文案里的「downloaded」对本地文件不成立(诚实文案),
 * 故只把原因码回给用户、把原文交给宿主日志。
 */
async function readLocalTarballManifest(
  bytes: Buffer,
  logger: (message: string) => void,
): Promise<Record<string, unknown>> {
  const { MarketInstallGateError, readTarballPackageJson } = await import('./market/install.ts')
  try {
    return readTarballPackageJson(bytes)
  } catch (error) {
    if (error instanceof MarketInstallGateError) {
      logger(`plugin add: local source is not a usable .tgz archive: ${error.message}`)
      throw new Error(`plugin source is not a usable .tgz package archive (${error.code})`)
    }
    throw error
  }
}

/** `.tgz` 源的自述身份(name/version 必须是字符串;合法性另由 assertStorableIdentity 判)。 */
function localArchiveIdentity(manifest: Record<string, unknown>): { name: string; version: string } {
  const { name, version } = manifest
  if (typeof name !== 'string' || !name) throw new Error('plugin package.json is missing name')
  if (typeof version !== 'string' || !version) throw new Error('plugin package.json is missing version')
  return { name, version }
}

/** 读源 `.tgz` 字节。源在校验后消失/不可读时诚实报错(只回 errno,不回含绝对路径的 fs message)。 */
function readLocalSourceBytes(source: string): Buffer {
  try {
    return readFileSync(source)
  } catch (error) {
    const errno = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : 'unknown'
    throw new Error(`plugin source could not be read (${errno}): ${source}`)
  }
}

/**
 * 目录源 → `.tgz` 字节:`pnpm -C <源目录> pack --pack-destination <私有临时目录>`。
 *
 * `DesktopPnpmService.run` 的 cwd 恒为 profileDir,故用 pnpm 的全局 `-C` 指向源
 * 目录;打包目的地是本次调用私有的临时目录,读完即删(不往用户目录与 profile 里
 * 留中间产物)。**不带任何 flag**:本地源是用户自己选的工程,其 prepack/prepare
 * 构建照常执行——`--ignore-scripts` 是市场路径对**不可信制品**的封死,不适用于此
 * (且 pnpm 11 对带构建脚本的包在忽略脚本时直接硬失败)。
 */
async function packLocalDirectory(routeCtx: PluginMutationContext, source: string): Promise<Buffer> {
  const destination = mkdtempSync(join(tmpdir(), 'huaanwork-plugin-pack-'))
  try {
    await runDesktopPnpm(
      routeCtx,
      ['-C', source, 'pack', '--pack-destination', destination],
      (exitCode) => `pnpm pack of the plugin source failed (exit ${exitCode})`,
    )
    const tarballs = readdirSync(destination).filter((entry) => entry.endsWith('.tgz'))
    const packedName = tarballs[0]
    if (tarballs.length !== 1 || packedName === undefined) {
      throw new PluginCommandError(
        500,
        'plugin-error',
        `plugin pack: expected exactly one packed tarball, found ${String(tarballs.length)}`,
      )
    }
    return readFileSync(join(destination, packedName))
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

/** 制品名里不允许出现的字符(控制字符;路径分隔符已由 safeArtifactName 折成 `-`)。 */
const UNSAFE_ARTIFACT_NAME = /[\u0000-\u001f\u007f]/u

/**
 * 命名边界守卫(本地源侧):`<safeName>-<version>-<sha12>.tgz` 必须能承载该身份,
 * 否则与 `gcRemovedPackageArtifacts` 的候选正则失配——卸载时制品漏删,只能等启动
 * 孤儿清扫兜底。**拒绝安装并诚实报错,不放宽 GC 正则**(spec §14 第 42/49 条)。
 */
function assertStorableIdentity(name: string, version: string): void {
  if (UNSAFE_ARTIFACT_NAME.test(name)) {
    throw new Error(`plugin name ${JSON.stringify(name)} cannot be staged as a plugin artifact; names must not contain control characters`)
  }
  if (!isMarketArtifactVersion(version)) {
    throw new Error(
      `plugin version ${JSON.stringify(version)} cannot be staged as a plugin artifact; ` +
      'versions must be 1-3 dot-separated numeric segments with an optional -/+ suffix (e.g. "1.0", "1.0.0", "1.0.0-beta.1")',
    )
  }
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
      message: RESTART_CANCELLED_MESSAGES.removed,
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

/**
 * 本地目录源的身份与声明校验(M4 语义:name 必填、`dsh.bundle` 必声明);
 * Task 6.2 起 version 也必填——制品名是 `<name>-<version>-<sha256前12>.tgz`,
 * 没有版本就无处落盘(且落成无版本名会让 GC 候选正则失配)。
 */
function validatedDirectoryPackage(source: string): { name: string; version: string } {
  const manifest = readManifest(join(source, 'package.json'))
  if (typeof manifest.name !== 'string' || !manifest.name) {
    throw new Error('plugin package.json is missing name')
  }
  if (manifest.dsh?.bundle == null) {
    throw new Error('package must declare dsh.bundle')
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('plugin package.json is missing version')
  }
  return { name: manifest.name, version: manifest.version }
}

function readManifest(path: string): { name?: string; version?: string; dsh?: { bundle?: unknown } } {
  if (!existsSync(path)) {
    throw new Error(`plugin source is not a local package: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string; dsh?: { bundle?: unknown } }
}

function desktopPnpmOf(routeCtx: PluginMutationContext): PluginPnpmCapability {
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
    return service as PluginPnpmCapability
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
 * 跑一次 pnpm 子进程并等它结束:`start` 决定入口(runPlugin 走 `dsh plugin` CLI、
 * run 直跑 pnpm)。单并发冲突映 409(不排队);非零退出映**具名 500**(评审 P1:
 * pnpm 非零退出是服务端故障,裸 Error 会被 market routes 的 catch-all 当成客户端
 * 错误答 400;具名后 code 稳定为 plugin-error,message 不含路径)。
 */
async function awaitPnpm(
  start: () => DesktopPnpmHandle,
  failure: (exitCode: number | null) => string,
): Promise<void> {
  let handle: DesktopPnpmHandle
  try {
    handle = start()
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
    throw new PluginCommandError(500, 'plugin-error', failure(outcome.exitCode))
  }
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
  await awaitPnpm(
    () => desktopPnpmOf(routeCtx).runPlugin(argv, invokingDir),
    (exitCode) => `dsh plugin ${argv[0]} failed (exit ${exitCode})`,
  )
}

/**
 * 直跑 pnpm(DesktopPnpm.run;cwd 恒为 profileDir,故需要换目录时用 pnpm 的全局
 * `-C`)。本地路径只有**目录源 pack** 用它;执行器缺席时诚实 503。
 */
async function runDesktopPnpm(
  routeCtx: PluginMutationContext,
  argv: readonly string[],
  failure: (exitCode: number | null) => string,
): Promise<void> {
  const pnpm = desktopPnpmOf(routeCtx)
  if (typeof pnpm.run !== 'function') {
    throw new PluginCommandError(503, 'pnpm-unavailable', 'desktopPnpm.run is not available')
  }
  const run = pnpm.run.bind(pnpm)
  await awaitPnpm(() => run(argv), failure)
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
