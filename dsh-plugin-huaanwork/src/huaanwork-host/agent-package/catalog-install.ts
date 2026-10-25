import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  inspectSignedAgentPackageBundle,
  type SignedAgentPackageInspection,
} from '@huaanwork/agent-package-format/bundle'
import type { AgentPackageDigest, AgentPackageFile } from '@huaanwork/agent-package-format/digest'
import {
  compareAgentPackageVersions,
  type AgentPackageManifest,
} from '@huaanwork/agent-package-format/manifest'
import {
  canonicalJson,
  parseCatalogKeyring,
  type CatalogKeyringEntry,
  type CatalogSignature,
} from '@huaanwork/catalog-signing'

import { agentsEnabledPath } from '../agents-host.ts'
import {
  getAgentCatalogBinding,
  type AgentCatalogBinding,
  type AgentPackageMetadata,
  type AgentPackageSummary,
} from './catalog-client.ts'
import { logAgentPackageAction } from './catalog-publish.ts'
import {
  agentPackageDir,
  agentPackagesRoot,
  agentPackageStatePath,
  isValidAgentPackageSlug,
  lookupAgentPackageState,
  readAgentPackageState,
  readAgentPackageVersionFromDir,
  writeAgentPackageState,
} from './store.ts'
import type {
  AgentPackagePublishStatus,
  AgentPackageRevocation,
  AgentPackageState,
  AgentPackageStateEntry,
} from './types.ts'

/**
 * 从签名广场验签安装、更新、移除智能体包,以及 legacy `catalog-legacy`
 * 条目的迁移与崩溃恢复。
 *
 * 安全边界:
 * - 只有 `client.listPackages` 里该 slug 的**当前最高**已发布版本可被安装/更新;
 *   直接请求旧版本按重放拒绝,更新低于已安装版本按降级拒绝;
 * - bundle 先流式写入暂存区根部的 `bundle.tgz`(5 MiB 中止),再由
 *   `inspectSignedAgentPackageBundle` 用 `{profileDir}/agent-catalog-keyring.json`
 *   验签;清单 slug/version 必须与请求一致;
 * - 撤销检查每次都新拉 `getRevocations`,网络/解析失败 fail closed;
 * - 正式目录的替换只经 rename 完成,暂存区根部的 `bundle.tgz` 与
 *   `transaction.json` 永不进入正式包;
 * - 日志只经 `logAgentPackageAction` 的白名单字段,不写 token、下载
 *   Authorization 或 bundle 内容。
 *
 * Task 10 的撤销/在途回合中止只按 {@link AgentPackageTurnStopper} 结构注入;
 * 本模块不导入 `catalog-security.ts`。
 */

/** IT 下发的公钥 keyring 文件名;缺失/非法时只让广场安装与运行 fail closed。 */
export const AGENT_CATALOG_KEYRING_FILE = 'agent-catalog-keyring.json'

/** 验签失败时唯一对外文案:不区分缺文件、篡改、未知密钥或清单不符。 */
export const AGENT_PACKAGE_VERIFY_FAILURE = '包校验失败，未安装或未运行。请联系管理员'

const LEGACY_ENABLED_FILE = 'agents-enabled.json'
const INSTALL_PREFIX = '.install-'
const REMOVE_PREFIX = '.remove-'
const OLD_PREFIX = '.old-'
const STAGING_PACKAGE_DIR = 'package'
const BUNDLE_FILE = 'bundle.tgz'
const TRANSACTION_FILE = 'transaction.json'
const SIGNATURE_DIR = '.signature'
const SIGNATURE_DIGEST_PATH = `${SIGNATURE_DIR}/package-digest.json`
const SIGNATURE_RECORD_PATH = `${SIGNATURE_DIR}/signature.json`
const LEGACY_KEY_PREFIX = 'catalog:'

/** update/remove 在改名前停止该 slug 的在途回合;Task 10 注入真实实现。 */
export type AgentPackageTurnStopper = (
  slug: string,
  reason: 'revoke' | 'update' | 'remove',
) => Promise<void>

/** 一次成功验签安装的完整结果;state 键固定为 `catalog:<slug>`。 */
export type VerifiedCatalogInstall = {
  manifest: AgentPackageManifest
  files: AgentPackageFile[]
  digest: AgentPackageDigest
  signature: CatalogSignature
}

/**
 * 暂存区根部的交易记录。
 *
 * - `previousState` 存在 = 一次更新,回滚时恢复该条目;
 * - `migrationFrom` 存在 = 一次 `catalog-legacy` 迁移,回滚时保留旧启用键;
 * - 两者都不存在 = 首次安装,回滚时删除新目录与 catalog 状态键。
 */
export type CatalogInstallTransaction = {
  slug: string
  targetVersion: string
  previousState?: AgentPackageStateEntry
  migrationFrom?: string
}

type InstallPlan = {
  slug: string
  version: string
  previousState: AgentPackageStateEntry | undefined
  migrationFrom: string | undefined
  migrationEnabled: boolean
}

type StateSnapshot = { exists: boolean; text: string }

/**
 * 读取 IT 下发的目录公钥 keyring。
 *
 * 缺失、不可读、JSON 非法或结构不符一律收敛为同一句 `包校验失败`;Task 10 的
 * 运行前复验复用本函数,不另写一份解析。
 */
export function readCatalogKeyring(profileDir: string): CatalogKeyringEntry[] {
  try {
    const text = readFileSync(join(profileDir, AGENT_CATALOG_KEYRING_FILE), 'utf8')
    const parsed: unknown = JSON.parse(text)
    return parseCatalogKeyring(parsed)
  } catch {
    throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
  }
}

/**
 * 首次安装(含 legacy 迁移)。
 *
 * 只接受该 slug 当前最高 published 版本;`version` 更旧按重放拒绝、更新版本
 * 按目录不存在拒绝。首次安装默认关闭;`catalog-legacy` 迁移保持旧启用态。
 */
export async function installCatalogAgentPackage(
  slug: string,
  version: string,
): Promise<VerifiedCatalogInstall> {
  const binding = getAgentCatalogBinding()
  const action = 'install'
  try {
    const result = await runCatalogInstall(binding, slug, version)
    logAgentPackageAction(binding.logger, action, {
      slug,
      version: result.manifest.version,
      outcome: 'ok',
    })
    return result
  } catch (error) {
    logAgentPackageAction(binding.logger, action, {
      slug,
      version,
      outcome: 'error',
      reason: errorMessage(error),
    })
    throw error
  }
}

/**
 * 更新到目录里该 slug 的最高 published 版本。
 *
 * 候选不高于已安装版本、目录最新已下架/撤销时不下载;确认可升级后、任何
 * rename 之前调用 `stopTurns(slug,'update')`,停止失败不触碰旧目录/state。
 */
export async function updateCatalogAgentPackage(
  slug: string,
  stopTurns: AgentPackageTurnStopper,
): Promise<VerifiedCatalogInstall> {
  const binding = getAgentCatalogBinding()
  const action = 'update'
  try {
    const result = await runCatalogUpdate(binding, slug, stopTurns)
    logAgentPackageAction(binding.logger, action, {
      slug,
      version: result.manifest.version,
      outcome: 'ok',
    })
    return result
  } catch (error) {
    logAgentPackageAction(binding.logger, action, {
      slug,
      outcome: 'error',
      reason: errorMessage(error),
    })
    throw error
  }
}

/**
 * 移除一个从广场安装的包。
 *
 * 只有 `source:'catalog'` 允许;任何 rename 之前调用 `stopTurns(slug,'remove')`,
 * 再把正式目录 rename 到 `.remove-*`,删除 state 后删目录。state 删除失败时
 * 目录 rename 回滚。本地包一律报 `本地创建的智能体不能通过广场移除`。
 */
export async function removeCatalogAgentPackage(
  slug: string,
  stopTurns: AgentPackageTurnStopper,
): Promise<void> {
  const binding = getAgentCatalogBinding()
  const action = 'remove'
  try {
    await runCatalogRemove(binding, slug, stopTurns)
    logAgentPackageAction(binding.logger, action, { slug, outcome: 'ok' })
  } catch (error) {
    logAgentPackageAction(binding.logger, action, { slug, outcome: 'error', reason: errorMessage(error) })
    throw error
  }
}

/**
 * 按目录 metadata 同步已安装包的发布状态。
 *
 * 只处理 `source:'catalog'` 的条目,按精确 `{slug,installedVersion}` 查 metadata:
 * `delisted` 只写 `publishStatus:'delisted'`,`published` 保持/恢复 `'installed'`;
 * `revoked` 交给 Task 10 的撤销应用,本函数不伪造也不清除。404/超时/网络失败
 * 保留旧状态并返回 warning,不把「列表中消失」推断成下架。只有实际变化才写
 * state;本函数不发 `agent/changed`(Task 11 在 `changed=true` 时统一发一次)。
 */
export async function refreshInstalledCatalogPackageStatuses(): Promise<{
  warning?: string
  changed: boolean
}> {
  const binding = getAgentCatalogBinding()
  const profileDir = binding.profileDir
  const state = readAgentPackageState(profileDir)
  const keys = Object.keys(state)
    .filter((key) => key.startsWith(LEGACY_KEY_PREFIX))
    .sort(compareStrings)
  const changes = new Map<string, { desired: AgentPackagePublishStatus; installedVersion: string }>()
  const failures: string[] = []

  for (const key of keys) {
    const entry = state[key]
    if (entry === undefined || entry.source !== 'catalog') continue
    const slug = key.slice(LEGACY_KEY_PREFIX.length)
    if (!isValidAgentPackageSlug(slug) || entry.installedVersion.length === 0) continue
    let metadata: AgentPackageMetadata
    try {
      metadata = await binding.client.getPackage(slug, entry.installedVersion)
    } catch (error) {
      failures.push(`${slug}: ${errorMessage(error)}`)
      continue
    }
    // revoked 由 Task 10 的撤销缓存应用精确禁用;这里既不写 broken 也不改状态。
    if (metadata.status === 'revoked') continue
    const desired: AgentPackagePublishStatus = metadata.status === 'delisted' ? 'delisted' : 'installed'
    if ((entry.publishStatus ?? 'installed') === desired) continue
    changes.set(key, { desired, installedVersion: entry.installedVersion })
  }

  let changed = false
  if (changes.size > 0) {
    // 网络等待期间 state 可能被并发改写:只把仍对得上身份的变化合入最新表。
    const latest = readAgentPackageState(profileDir)
    const next: AgentPackageState = { ...latest }
    for (const [key, change] of changes) {
      const live = latest[key]
      if (live === undefined || live.source !== 'catalog') continue
      if (live.installedVersion !== change.installedVersion) continue
      if ((live.publishStatus ?? 'installed') === change.desired) continue
      next[key] = { ...live, publishStatus: change.desired }
      changed = true
    }
    if (changed) writeAgentPackageState(profileDir, next)
  }

  return failures.length > 0
    ? { changed, warning: `已安装智能体状态同步失败：${failures[0]!}` }
    : { changed }
}

/** 本进程正在写入的暂存区/垃圾桶;恢复扫描必须跳过它们,否则会删掉在途安装。 */
const activeOperations = new Set<string>()

/**
 * 按 `.install-*` 交易记录与 `.remove-*` 残留恢复中断的安装/更新/移除。
 *
 * 必须在 M1 的通用 `.old-*` 清理**之前**运行(host 的 list/detail/dispatch
 * 读路径与 Task 10 的启动接线);每个目录独立容错,单个损坏的暂存区不会让
 * 列表整体失败。
 */
export function recoverCatalogPackageInstalls(profileDir: string): void {
  const root = agentPackagesRoot(profileDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const names = entries.map((entry) => entry.name)
  for (const name of names) {
    if (!name.startsWith(REMOVE_PREFIX)) continue
    if (activeOperations.has(join(root, name))) continue
    try {
      recoverRemove(profileDir, root, name)
    } catch (error) {
      logRecover('recover.remove', name, error)
    }
  }
  for (const name of names) {
    if (!name.startsWith(INSTALL_PREFIX)) continue
    if (activeOperations.has(join(root, name))) continue
    try {
      recoverInstall(profileDir, root, name, names)
    } catch (error) {
      logRecover('recover.install', name, error)
    }
  }
}

// ---------------------------------------------------------------------------
// 安装/更新共用路径
// ---------------------------------------------------------------------------

/**
 * 首次安装:占住 slug 后跑完整交易(验签、暂存、rename、state 提交)。
 *
 * 门禁必须覆盖到 rename/state 提交结束:安装期间同名 `@slug` 不得启动回合,
 * 第二次安装也不得与本次暂存区交错。
 */
async function runCatalogInstall(
  binding: AgentCatalogBinding,
  slug: string,
  version: string,
): Promise<VerifiedCatalogInstall> {
  return binding.lifecycle.run(slug, '安装', () => runCatalogInstallLocked(binding, slug, version))
}

async function runCatalogInstallLocked(
  binding: AgentCatalogBinding,
  slug: string,
  version: string,
): Promise<VerifiedCatalogInstall> {
  assertSlug(slug)
  assertVersion(version)
  const profileDir = binding.profileDir

  const lookup = lookupAgentPackageState(readAgentPackageState(profileDir), slug)
  if (lookup.kind === 'corrupt') throw new Error(lookup.reason)
  if (lookup.kind === 'catalog') {
    throw new Error(`智能体 @${slug} 已安装，无需重复安装`)
  }
  if (lookup.kind === 'local') {
    throw new Error(`智能体 @${slug} 与本地创建的智能体重名，不能安装`)
  }
  assertNoLocalEndpointConflict(profileDir, slug)
  if (pathExists(agentPackageDir(profileDir, slug))) {
    throw new Error(`智能体 @${slug} 的目录已存在，不能覆盖`)
  }

  const legacyEnabled = readLegacyEnabledMap(profileDir)[`${LEGACY_KEY_PREFIX}${slug}`] === true

  const latest = selectLatestVersion(await binding.client.listPackages(), slug)
  if (latest === undefined) throw new Error(`目录中没有智能体 @${slug}`)
  const requestedComparison = compareVersions(version, latest)
  if (requestedComparison < 0) {
    throw new Error('该版本不是目录中的最新版本，已拒绝安装')
  }
  if (requestedComparison > 0) {
    throw new Error(`目录中没有版本 ${version}`)
  }

  const metadata = await binding.client.getPackage(slug, version)
  if (metadata.status !== 'published') {
    throw new Error(metadata.status === 'delisted' ? '该版本已下架，无法安装' : '该版本已撤销，无法安装')
  }
  let migrationFrom: string | undefined
  if (legacyEnabled) {
    // 迁移只认同一目录、同一 slug 的 published metadata;普通 legacy 冲突不自动迁移。
    if (metadata.migrationFrom !== slug) {
      throw new Error(`智能体 @${slug} 与旧目录智能体重名，未获准迁移，不能安装`)
    }
    migrationFrom = slug
  }

  return performVerifiedInstall(binding, {
    slug,
    version,
    previousState: undefined,
    migrationFrom,
    migrationEnabled: legacyEnabled,
  })
}

/**
 * 更新:门禁在 `stopTurns` **之前**获取,并覆盖到 rename 与 state 提交结束。
 *
 * 停止失败时交易以 stopTurns 的错误中止,目录/state 都未触碰;门禁随后释放。
 */
async function runCatalogUpdate(
  binding: AgentCatalogBinding,
  slug: string,
  stopTurns: AgentPackageTurnStopper,
): Promise<VerifiedCatalogInstall> {
  return binding.lifecycle.run(slug, '更新', () => runCatalogUpdateLocked(binding, slug, stopTurns))
}

async function runCatalogUpdateLocked(
  binding: AgentCatalogBinding,
  slug: string,
  stopTurns: AgentPackageTurnStopper,
): Promise<VerifiedCatalogInstall> {
  assertSlug(slug)
  const profileDir = binding.profileDir

  const lookup = lookupAgentPackageState(readAgentPackageState(profileDir), slug)
  if (lookup.kind === 'corrupt') throw new Error(lookup.reason)
  if (lookup.kind === 'local') throw new Error('本地创建的智能体不能通过广场更新')
  if (lookup.kind === 'none') throw new Error(`智能体 @${slug} 未安装，无法更新`)
  const installed = lookup.entry.installedVersion
  if (installed.length === 0) {
    throw new Error(`智能体 @${slug} 的已安装版本未知，请先移除后重装`)
  }

  const latest = selectLatestVersion(await binding.client.listPackages(), slug)
  // 列表中只剩已发布版本:slug 消失意味着目录已下架/撤销,不提供更新。
  if (latest === undefined) throw new Error('没有更高版本，已是最新')
  const metadata = await binding.client.getPackage(slug, latest)
  if (metadata.status !== 'published') {
    throw new Error('目录最新版本已下架或撤销，暂不提供更新')
  }
  if (compareVersions(latest, installed) <= 0) {
    throw new Error('版本低于已安装版本，已拒绝更新')
  }
  const revoked = findRevocation(await binding.client.getRevocations(), slug, latest)
  if (revoked !== undefined) throw new Error(`该版本已被管理员撤销：${revoked.reason}`)

  // 确认存在可升级版本后才停止在途回合;停止失败不触碰旧目录/state。
  await stopTurns(slug, 'update')

  return performVerifiedInstall(binding, {
    slug,
    version: latest,
    previousState: lookup.entry,
    migrationFrom: undefined,
    migrationEnabled: false,
  })
}

/**
 * 下载、验签、暂存与原子提交。
 *
 * 暂存区固定在 `agents/.install-{slug}-{random}/`,根部只放 `bundle.tgz`、
 * `transaction.json` 与新包目录 `package/`;正式目录替换只经 rename,失败按
 * 交易记录恢复旧目录与旧 state。
 */
async function performVerifiedInstall(
  binding: AgentCatalogBinding,
  plan: InstallPlan,
): Promise<VerifiedCatalogInstall> {
  const profileDir = binding.profileDir
  const root = agentPackagesRoot(profileDir)
  const formal = agentPackageDir(profileDir, plan.slug)
  mkdirSync(root, { recursive: true })

  const staging = join(root, `${INSTALL_PREFIX}${plan.slug}-${randomSuffix()}`)
  const stagingPackage = join(staging, STAGING_PACKAGE_DIR)
  let oldDir: string | undefined
  let installedNew = false
  /** 回滚未能把磁盘与 state 一起恢复:暂存区要留给下一次读路径继续对账。 */
  let keepStagingForRecovery = false
  // 下载/验签期间 staging 里还没有 transaction.json;登记后恢复扫描不得把它当残留删掉。
  activeOperations.add(staging)

  try {
    mkdirSync(stagingPackage, { recursive: true })
    const bundlePath = join(staging, BUNDLE_FILE)
    await binding.client.downloadBundleToFile(plan.slug, plan.version, bundlePath)

    const inspection = await inspectSignedAgentPackageBundle(
      readFileSync(bundlePath),
      readCatalogKeyring(profileDir),
    )
    if (inspection.manifest.slug !== plan.slug || inspection.manifest.version !== plan.version) {
      throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
    }
    const revoked = findRevocation(await binding.client.getRevocations(), plan.slug, plan.version)
    if (revoked !== undefined) throw new Error(`该版本已被管理员撤销：${revoked.reason}`)

    writeVerifiedPackage(stagingPackage, inspection)
    writeTransaction(staging, {
      slug: plan.slug,
      targetVersion: plan.version,
      ...(plan.previousState === undefined ? {} : { previousState: plan.previousState }),
      ...(plan.migrationFrom === undefined ? {} : { migrationFrom: plan.migrationFrom }),
    })

    // 提交段:以下全部同步执行,没有 await,不会与并发写交错。
    const stateSnapshot = snapshotAgentState(profileDir)
    try {
      if (plan.previousState !== undefined) {
        if (!pathExists(formal)) throw new Error(`智能体 @${plan.slug} 的正式目录缺失，无法更新`)
        oldDir = join(root, `${OLD_PREFIX}${plan.slug}-${randomSuffix()}`)
        renameSync(formal, oldDir)
      } else if (pathExists(formal)) {
        throw new Error(`智能体 @${plan.slug} 的目录已存在，不能覆盖`)
      }
      renameSync(stagingPackage, formal)
      installedNew = true
      commitAgentState(profileDir, plan)
      if (plan.migrationFrom !== undefined) {
        try {
          deleteLegacyEnabledKey(profileDir, `${LEGACY_KEY_PREFIX}${plan.migrationFrom}`)
        } catch (error) {
          throw new Error(`旧目录启用状态清理失败，已回滚安装：${errorMessage(error)}`, { cause: error })
        }
      }
    } catch (error) {
      // 回滚自己也可能失败(磁盘只读等):状态或目录没能恢复时保留
      // staging/transaction.json,让下一次读路径的安装恢复按交易记录继续对账,
      // 而不是把唯一的重建证据一并删掉。
      keepStagingForRecovery = !rollbackInstall(profileDir, formal, oldDir, installedNew, stateSnapshot)
      throw error
    }

    // 提交完成后清理;失败留给下一次读路径的恢复。
    if (oldDir !== undefined) removeQuietly(oldDir)
    removeQuietly(staging)
    return inspection
  } catch (error) {
    // 提交段已回滚且磁盘与 state 一致时清掉暂存区:交易记录不再需要,残留的
    // `.install-*` 只会让下一次读路径重复处理同一笔已失败的安装。回滚未能
    // 收敛时保留 transaction.json,由下一次读路径的恢复继续处理。
    if (!keepStagingForRecovery) removeQuietly(staging)
    throw error
  } finally {
    activeOperations.delete(staging)
  }
}

/** 写 state:更新保留 enabled 与全部 M2 字段,首次安装默认关闭或取迁移旧键。 */
function commitAgentState(profileDir: string, plan: InstallPlan): void {
  const state = readAgentPackageState(profileDir)
  const key = `${LEGACY_KEY_PREFIX}${plan.slug}`
  if (plan.previousState !== undefined) {
    const live = state[key]
    if (
      live === undefined ||
      live.source !== 'catalog' ||
      live.installedVersion !== plan.previousState.installedVersion
    ) {
      throw new Error('智能体状态已变化，请刷新后重试')
    }
    state[key] = { ...live, installedVersion: plan.version }
    writeAgentPackageState(profileDir, state)
    return
  }
  if (state[key] !== undefined) throw new Error('智能体状态已变化，请刷新后重试')
  state[key] = {
    source: 'catalog',
    enabled: plan.migrationEnabled,
    installedVersion: plan.version,
    publishStatus: 'installed',
  }
  writeAgentPackageState(profileDir, state)
}

/**
 * 回滚:恢复 state 快照,删除本次换入的新 formal,把 `.old-*` 改回正式目录。
 *
 * @returns 磁盘与 state 是否都已回到提交前;`false` 时调用方必须保留
 *   `transaction.json`,由下一次读路径的安装恢复继续对账。
 */
function rollbackInstall(
  profileDir: string,
  formal: string,
  oldDir: string | undefined,
  installedNew: boolean,
  snapshot: StateSnapshot,
): boolean {
  let stateRestored = false
  try {
    restoreAgentState(profileDir, snapshot)
    stateRestored = true
  } catch {
    // 恢复失败不得覆盖原始错误;交易记录保留给下一次读路径继续对账。
  }
  // 只有本次真的把新包 rename 进 formal 时才删它:首次安装撞到既有目录的失败
  // 路径绝不能删除那个既有目录。
  let directoryRestored = true
  if (installedNew && pathExists(formal)) {
    try {
      rmSync(formal, { recursive: true, force: true })
    } catch {
      directoryRestored = false
    }
  }
  if (oldDir !== undefined && pathExists(oldDir)) {
    try {
      renameSync(oldDir, formal)
    } catch {
      // 恢复失败时保留 `.old-*`;下一次读路径的恢复会重试。
      directoryRestored = false
    }
  }
  return stateRestored && directoryRestored
}

/** 把验签结果写入暂存包目录:内容文件 + 两个 `.signature` 文件,每级防 symlink。 */
function writeVerifiedPackage(packageDir: string, inspection: SignedAgentPackageInspection): void {
  const files: AgentPackageFile[] = [
    ...inspection.files,
    { path: SIGNATURE_DIGEST_PATH, data: Buffer.from(canonicalJson(inspection.digest), 'utf8') },
    { path: SIGNATURE_RECORD_PATH, data: Buffer.from(JSON.stringify(inspection.signature), 'utf8') },
  ]
  for (const file of files) writeVerifiedFile(packageDir, file.path, file.data)
}

function writeVerifiedFile(packageDir: string, relativePath: string, data: Buffer): void {
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error(`包校验失败：包内文件路径非法（${relativePath}）`)
  }
  let current = packageDir
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!)
    if (index === segments.length - 1) {
      let stat
      try {
        stat = lstatSync(current)
      } catch {
        stat = undefined
      }
      if (stat !== undefined) {
        throw new Error(`包校验失败：包内文件重复或已存在（${relativePath}）`)
      }
      writeFileSync(current, data, { flag: 'wx' })
      continue
    }
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      mkdirSync(current)
      continue
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`包校验失败：包内文件路径不得经过符号链接（${relativePath}）`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`包校验失败：包内文件路径与目录冲突（${relativePath}）`)
    }
  }
}

function writeTransaction(stagingDir: string, transaction: CatalogInstallTransaction): void {
  writeFileSync(
    join(stagingDir, TRANSACTION_FILE),
    `${JSON.stringify(transaction, null, 2)}\n`,
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// 移除
// ---------------------------------------------------------------------------

/**
 * 移除:门禁覆盖 `stopTurns`、目录 rename 与 state 删除。
 *
 * 停止失败以 stopTurns 的错误中止,目录/state 不受影响。
 */
async function runCatalogRemove(
  binding: AgentCatalogBinding,
  slug: string,
  stopTurns: AgentPackageTurnStopper,
): Promise<void> {
  return binding.lifecycle.run(slug, '移除', () => runCatalogRemoveLocked(binding, slug, stopTurns))
}

async function runCatalogRemoveLocked(
  binding: AgentCatalogBinding,
  slug: string,
  stopTurns: AgentPackageTurnStopper,
): Promise<void> {
  assertSlug(slug)
  const profileDir = binding.profileDir
  const lookup = lookupAgentPackageState(readAgentPackageState(profileDir), slug)
  if (lookup.kind === 'corrupt') throw new Error(lookup.reason)
  if (lookup.kind === 'local') throw new Error('本地创建的智能体不能通过广场移除')
  if (lookup.kind === 'none') throw new Error(`智能体 @${slug} 未安装，无法移除`)

  // 任何目录 rename 之前停止在途回合;停止失败直接中止,不触碰目录/state。
  await stopTurns(slug, 'remove')

  const formal = agentPackageDir(profileDir, slug)
  const root = agentPackagesRoot(profileDir)
  const trash = join(root, `${REMOVE_PREFIX}${slug}-${randomSuffix()}`)
  activeOperations.add(trash)
  try {
    let moved = false
    if (pathExists(formal)) {
      renameSync(formal, trash)
      moved = true
    }
    try {
      const state = readAgentPackageState(profileDir)
      const live = lookupAgentPackageState(state, slug)
      if (live.kind !== 'catalog') throw new Error('智能体状态已变化，请刷新后重试')
      const next: AgentPackageState = { ...state }
      delete next[`${LEGACY_KEY_PREFIX}${slug}`]
      writeAgentPackageState(profileDir, next)
    } catch (error) {
      if (moved) {
        try {
          renameSync(trash, formal)
        } catch {
          // 保留 `.remove-*`;下一次读路径的恢复会把它改回正式目录。
        }
      }
      throw error
    }
    if (moved) removeQuietly(trash)
  } finally {
    activeOperations.delete(trash)
  }
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

function recoverRemove(profileDir: string, root: string, name: string): void {
  const slug = slugFromSuffixedName(name, REMOVE_PREFIX)
  const target = join(root, name)
  if (slug === undefined) {
    removeQuietly(target)
    return
  }
  const formal = agentPackageDir(profileDir, slug)
  const state = readAgentPackageState(profileDir)
  if (state[`${LEGACY_KEY_PREFIX}${slug}`] !== undefined && !pathExists(formal)) {
    try {
      renameSync(target, formal)
      return
    } catch {
      // 恢复失败时保留 `.remove-*`;下一次读路径会重试。
      return
    }
  }
  removeQuietly(target)
}

function recoverInstall(profileDir: string, root: string, name: string, names: readonly string[]): void {
  const staging = join(root, name)
  const transaction = readTransaction(staging)
  if (transaction === undefined) {
    // 没有(或损坏的)交易记录:只是临时目录,不参与正式包。
    removeQuietly(staging)
    return
  }
  const slug = transaction.slug
  const formal = agentPackageDir(profileDir, slug)
  const stagingPackage = join(staging, STAGING_PACKAGE_DIR)
  const oldDirs = names
    // 只认解析后 slug 相等的 `.old-*`:前缀匹配会把 `foo-bar` 的备份算到 `foo` 头上。
    .filter((candidate) => slugFromSuffixedName(candidate, OLD_PREFIX) === slug)
    .map((candidate) => join(root, candidate))
  const key = `${LEGACY_KEY_PREFIX}${slug}`
  const entry = readAgentPackageState(profileDir)[key]

  if (entry !== undefined && entry.source === 'catalog' && entry.installedVersion === transaction.targetVersion) {
    // 交易已提交(含迁移):先补删 legacy 旧键,失败则按安装失败语义回滚。
    if (transaction.migrationFrom !== undefined) {
      const legacyKey = `${LEGACY_KEY_PREFIX}${transaction.migrationFrom}`
      // 无条件补删。旧表的可读性不能由 readLegacyEnabledMap 的宽空表决定:
      // 不可读/损坏时它会折叠成 {},据此跳过补删会把 legacy 键留在原处并清掉
      // 交易/旧目录,留下 legacy/catalog 双份补全。deleteLegacyEnabledKey 对
      // ENOENT 与键不存在都是 no-op,不可读/损坏则抛错,走下面的回滚分支。
      try {
        deleteLegacyEnabledKey(profileDir, legacyKey)
      } catch (error) {
        rollbackCommittedInstall(profileDir, slug, formal, oldDirs, transaction)
        removeQuietly(staging)
        logRecover('recover.migration', slug, error)
        return
      }
    }
    if (!pathExists(formal)) {
      if (pathExists(stagingPackage)) {
        try {
          renameSync(stagingPackage, formal)
        } catch {
          // 交由 .old 分支或下一次恢复。
        }
      } else if (oldDirs.length > 0) {
        try {
          renameSync(oldDirs[0]!, formal)
        } catch {
          // 保留 .old-*;通用恢复还会再试一次。
        }
      }
    } else {
      const formalVersion = readAgentPackageVersionFromDir(formal)
      if (formalVersion !== undefined && formalVersion !== transaction.targetVersion) {
        // 状态新、磁盘旧(不可能由本事务的提交顺序产生):以磁盘为准回滚 state。
        restoreTransactionState(profileDir, slug, transaction)
      }
    }
    removeQuietly(staging)
    for (const oldDir of oldDirs) removeQuietly(oldDir)
    return
  }

  // 交易未提交:文件系统回到提交前。
  if (!pathExists(formal)) {
    if (oldDirs.length > 0) {
      // 旧目录已 rename、新 formal 未就位:先改回旧正式目录,旧 state 不变。
      try {
        renameSync(oldDirs[0]!, formal)
      } catch {
        // 保留 `.old-*`;通用恢复还会再试一次。
      }
    }
    removeQuietly(staging)
    return
  }

  const formalVersion = readAgentPackageVersionFromDir(formal)
  if (formalVersion !== undefined && formalVersion === transaction.targetVersion) {
    // 新 formal 已就位但 state 未写:删除新目录并恢复旧目录(首次安装则只删)。
    removeQuietly(formal)
    if (oldDirs.length > 0) {
      try {
        renameSync(oldDirs[0]!, formal)
      } catch {
        // 保留 `.old-*`;下一次读路径会重试。
      }
    }
  }
  removeQuietly(staging)
}

/** legacy 补删失败:删除新 formal、恢复旧目录与旧 state,保留 legacy 旧键。 */
function rollbackCommittedInstall(
  profileDir: string,
  slug: string,
  formal: string,
  oldDirs: readonly string[],
  transaction: CatalogInstallTransaction,
): void {
  if (pathExists(formal) && readAgentPackageVersionFromDir(formal) === transaction.targetVersion) {
    removeQuietly(formal)
    if (oldDirs.length > 0 && !pathExists(formal)) {
      try {
        renameSync(oldDirs[0]!, formal)
      } catch {
        // 保留 `.old-*`;下一次读路径会重试。
      }
    }
  }
  restoreTransactionState(profileDir, slug, transaction)
  for (const oldDir of oldDirs) {
    if (pathExists(oldDir) && pathExists(formal)) removeQuietly(oldDir)
  }
}

/** 把一条 catalog 状态恢复成交易前:更新恢复 `previousState`,首次安装删除键。 */
function restoreTransactionState(
  profileDir: string,
  slug: string,
  transaction: CatalogInstallTransaction,
): void {
  const state = readAgentPackageState(profileDir)
  const key = `${LEGACY_KEY_PREFIX}${slug}`
  if (transaction.previousState !== undefined) state[key] = transaction.previousState
  else delete state[key]
  writeAgentPackageState(profileDir, state)
}

function readTransaction(stagingDir: string): CatalogInstallTransaction | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(stagingDir, TRANSACTION_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const { slug, targetVersion, migrationFrom } = raw
  if (typeof slug !== 'string' || !isValidAgentPackageSlug(slug)) return undefined
  if (typeof targetVersion !== 'string' || targetVersion.length === 0) return undefined
  if (migrationFrom !== undefined && (typeof migrationFrom !== 'string' || !isValidAgentPackageSlug(migrationFrom))) {
    return undefined
  }
  const previousState = parsePreviousState(raw.previousState)
  return {
    slug,
    targetVersion,
    ...(previousState === undefined ? {} : { previousState }),
    ...(migrationFrom === undefined ? {} : { migrationFrom }),
  }
}

/** 交易里的 previousState 只由本模块写入;形状不符时按「没有旧 state」处理。 */
function parsePreviousState(value: unknown): AgentPackageStateEntry | undefined {
  if (!isRecord(value)) return undefined
  if (value.source !== 'catalog') return undefined
  if (typeof value.enabled !== 'boolean') return undefined
  if (typeof value.installedVersion !== 'string' || value.installedVersion.length === 0) return undefined
  return value as unknown as AgentPackageStateEntry
}

// ---------------------------------------------------------------------------
// legacy 启用表(C16:不编辑 agents-host.ts,直接按旧路径读改写)
// ---------------------------------------------------------------------------

function readLegacyEnabledMap(profileDir: string): Record<string, boolean> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(agentsEnabledPath(profileDir), 'utf8'))
  } catch {
    return {}
  }
  if (!isRecord(raw)) return {}
  const map: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === true) map[key] = true
  }
  return map
}

/**
 * 从旧启用表原子删除一个 `catalog:<slug>` 键,保留其余所有键。
 *
 * 缺失文件视为已删除;不可读或结构异常时抛错,由调用方回滚安装——损坏的旧表
 * 不能被当成空表覆盖,否则会静默丢掉其它 legacy 条目的启用态。
 */
function deleteLegacyEnabledKey(profileDir: string, key: string): void {
  const filePath = agentsEnabledPath(profileDir)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (isEnoent(error)) return
    throw new Error(`${LEGACY_ENABLED_FILE} 不可读，无法完成迁移`, { cause: error })
  }
  if (!isRecord(raw)) throw new Error(`${LEGACY_ENABLED_FILE} 格式异常，无法完成迁移`)
  if (!Object.hasOwn(raw, key)) return
  const { [key]: _removed, ...rest } = raw
  const tempPath = `${filePath}.tmp`
  try {
    writeFileSync(tempPath, `${JSON.stringify(rest, null, 2)}\n`, 'utf8')
    renameSync(tempPath, filePath)
  } catch (error) {
    removeQuietly(tempPath)
    throw error
  }
}

/** 本地工具/本地 agent 入口占用同一 `@name` 命名空间,安装前拒绝重名。 */
function assertNoLocalEndpointConflict(profileDir: string, slug: string): void {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(profileDir, 'agents-endpoints.json'), 'utf8'))
  } catch {
    return
  }
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return
  for (const entry of raw.entries) {
    if (isRecord(entry) && entry.name === slug) {
      throw new Error(`智能体 @${slug} 与现有智能体或本地工具重名，不能安装`)
    }
  }
}

// ---------------------------------------------------------------------------
// state 快照
// ---------------------------------------------------------------------------

function snapshotAgentState(profileDir: string): StateSnapshot {
  try {
    return { exists: true, text: readFileSync(agentPackageStatePath(profileDir), 'utf8') }
  } catch (error) {
    // 只有 ENOENT 才是「状态文件不存在」。其他读取错误不能折叠成空快照:
    // 回滚会据此 rmSync 整个 state 文件,连带删掉其它智能体的条目。
    // 快照在任何 rename 之前读取,这里抛出即为干净中止。
    if (isEnoent(error)) return { exists: false, text: '' }
    throw new Error(`智能体状态不可读，已中止安装：${errorMessage(error)}`, { cause: error })
  }
}

/**
 * 回滚 state 时按原始字节写回,保证旧 state 不被重新序列化。
 *
 * 写入失败必须向上抛:调用方据此保留交易记录,下一次读路径继续对账。
 */
function restoreAgentState(profileDir: string, snapshot: StateSnapshot): void {
  const filePath = agentPackageStatePath(profileDir)
  if (!snapshot.exists) {
    // rmSync 失败同样要抛出:状态没能回到「不存在」就不是一次完成的回滚。
    rmSync(filePath, { force: true })
    return
  }
  const tempPath = `${filePath}.restore-tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(tempPath, snapshot.text, 'utf8')
    renameSync(tempPath, filePath)
  } catch (error) {
    removeQuietly(tempPath)
    throw error
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function assertSlug(slug: string): void {
  if (!isValidAgentPackageSlug(slug)) throw new Error(`智能体 @标识「${slug}」无效`)
}

function assertVersion(version: string): void {
  if (typeof version !== 'string' || version.length === 0) throw new Error('版本号不能为空')
  compareVersions(version, version)
}

/** 非法 semver 直接拒绝,避免把损坏的目录版本当成可安装/可升级。 */
function compareVersions(a: string, b: string): -1 | 0 | 1 {
  try {
    return compareAgentPackageVersions(a, b)
  } catch {
    throw new Error(`版本号不是合法 semver：${a}`)
  }
}

/** 目录列表里该 slug 的最高 published 版本;非法的版本号被跳过。 */
function selectLatestVersion(items: readonly AgentPackageSummary[], slug: string): string | undefined {
  let latest: string | undefined
  for (const item of items) {
    if (item.slug !== slug || item.status !== 'published') continue
    let comparison: -1 | 0 | 1
    try {
      comparison = latest === undefined ? 1 : compareAgentPackageVersions(item.version, latest)
    } catch {
      continue
    }
    if (comparison > 0) latest = item.version
  }
  return latest
}

function findRevocation(
  items: readonly AgentPackageRevocation[],
  slug: string,
  version: string,
): AgentPackageRevocation | undefined {
  return items.find((item) => item.slug === slug && item.version === version)
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

/** 清理失败不能覆盖调用方的结果;残留由下一次读路径的恢复重试。 */
function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // 尽力而为。
  }
}

function slugFromSuffixedName(name: string, prefix: string): string | undefined {
  const rest = name.slice(prefix.length)
  const separator = rest.lastIndexOf('-')
  if (separator <= 0) return undefined
  const slug = rest.slice(0, separator)
  return isValidAgentPackageSlug(slug) ? slug : undefined
}

function randomSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

function logRecover(action: string, name: string, error: unknown): void {
  try {
    logAgentPackageAction(getAgentCatalogBinding().logger, action, {
      reason: `${name}: ${errorMessage(error)}`,
      outcome: 'error',
    })
  } catch {
    // 目录绑定尚未初始化(启动早期恢复):恢复本身已经完成,不因日志失败中断。
  }
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
