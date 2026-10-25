import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  verifyAgentPackageDirectory,
  type AgentPackageDigest,
} from '@huaanwork/agent-package-format/digest'
import type { CatalogKeyringEntry, CatalogSignature } from '@huaanwork/catalog-signing'

import {
  getAgentCatalogBinding,
  isAgentCatalogConfigured,
  type AgentCatalogClient,
} from './catalog-client.ts'
import {
  AGENT_PACKAGE_VERIFY_FAILURE,
  readCatalogKeyring,
  type AgentPackageTurnStopper,
} from './catalog-install.ts'
import type { AgentPackageActiveTurnRegistry } from './host.ts'
import {
  agentPackageDir,
  readAgentPackageState,
  writeAgentPackageState,
} from './store.ts'
import type { AgentPackageRevocation, AgentPackageState } from './types.ts'

/**
 * 签名广场的信任根、撤销缓存与运行前复验(Task 10)。
 *
 * 安全边界:
 * - keyring 只在构造时读一次 `{profileDir}/agent-catalog-keyring.json`(IT 下发,
 *   不在用户设置界面暴露);缺失/非法时**只有** catalog 包的安装与运行 fail
 *   closed,本地包与 legacy 完全不受影响;
 * - 撤销缓存落 `{profileDir}/agent-catalog-revocations.json`,tmp+rename;解析失败
 *   必须备份为 `.corrupt-<timestamp>` 并告警,绝不把坏缓存当成空列表静默放行;
 * - 刷新成功替换缓存并应用;失败保留缓存(磁盘与内存)并按缓存继续执行撤销,
 *   warning 上报给调用方;没有后台推送,唯一的周期刷新由 Task 12 的 UI 负责;
 * - 撤销应用只精确匹配 `catalog:<slug>` + `installedVersion`,写
 *   `enabled:false` + `revoked`;delisted 由 Task 9 的 metadata 刷新只改
 *   `publishStatus`,不写 broken、不中止回合;
 * - 撤销 generation 在 `registry.cancelBySlug` **之前**自增,`assertRunnable`
 *   复验后比对 generation,保证「复验期间到达的撤销」不会被漏掉;在途回合的
 *   spawn 门由 host 传入的同一 signal 承担;
 * - `verifyInstalled` 每次从磁盘复验,失败只回对外统一文案;`assertRunnable`
 *   把任何失败映射成同一句 `包校验失败`,不泄露本地路径。
 *
 * 本模块只通过 {@link AgentPackageActiveTurnRegistry} 结构取消回合,不反向访问
 * `host.dispatch` 的闭包;Task 9 的 update/remove 以
 * `stopAgentPackageTurnsForSlug` 作为 `AgentPackageTurnStopper` 注入。
 */

/** IT 下发的撤销缓存文件名(与 keyring 同目录,不暴露给用户编辑)。 */
export const AGENT_CATALOG_REVOCATIONS_FILE = 'agent-catalog-revocations.json'

const CATALOG_STATE_PREFIX = 'catalog:'
const REVOCATION_CACHE_SCHEMA_VERSION = 1
/** `assertRunnable` 的复检上限:generation 持续变化时 fail closed。 */
const MAX_ASSERT_ATTEMPTS = 5

/** 一次运行前复验的结果;失败时 `reason` 已是对外分类文案,不含本地路径。 */
export type AgentPackageVerification =
  | { ok: true; digest: AgentPackageDigest; signature: CatalogSignature }
  | { ok: false; reason: string }

/**
 * 运行前安全面。
 *
 * `stopAgentPackageTurnsForSlug` 仅委托 `registry.cancelBySlug`,签名与 Task 9
 * 的 {@link AgentPackageTurnStopper} 相同,因此 Task 11 可以直接把它传给
 * update/remove。
 */
export type AgentCatalogSecurity = {
  /**
   * 读取并应用磁盘缓存的撤销列表(启动与离线回落共用)。
   *
   * 同步完成 state 写入与 generation 自增;撤销引发的回合取消以异步方式
   * 发起(启动时还没有在途回合)。坏缓存备份后返回 warning,内存里已应用的
   * 撤销保持有效。
   */
  loadCachedRevocations(): { items: AgentPackageRevocation[]; warning?: string }
  /**
   * 拉取并应用撤销列表;失败保留缓存、按缓存继续撤销并返回 warning。
   * 目录未配置(`agents_host`/`agents_port` 为空)时不发请求、不返回 warning。
   */
  refreshRevocations(): Promise<{ warning?: string }>
  /** 每次从磁盘复验已安装的 catalog 包;local 包不适用本方法。 */
  verifyInstalled(slug: string): Promise<AgentPackageVerification>
  /**
   * 运行前门:撤销/验签失败一律抛出。
   *
   * 复验后重新比对 revocation generation,复验期间到达的撤销不会被漏掉。
   */
  assertRunnable(slug: string, version: string): Promise<void>
  /** Task 9 update/remove 的回合停止注入点;仅委托 registry.cancelBySlug。 */
  stopAgentPackageTurnsForSlug: AgentPackageTurnStopper
  /**
   * 该 slug 当前生效的撤销记录(先看 state 里的持久化撤销,再看内存撤销表)。
   * `version` 省略时以 state 的 `installedVersion` 为准。
   */
  revocationFor(slug: string, version?: string): AgentPackageRevocation | undefined
}

export type CreateAgentCatalogSecurityOptions = {
  profileDir: string
  /** 与 host/sessions 共用的同一在途回合登记表(index 只建一个)。 */
  registry: AgentPackageActiveTurnRegistry
  /** 测试缝:替代目录绑定里的 client;缺省在每次网络操作时读单例绑定。 */
  client?: AgentCatalogClient
  /**
   * 测试缝:目录是否已配置。缺省读绑定设置(`agents_host`/`agents_port`)。
   * 注入 `client` 而不注入本项时按「已配置」处理(测试替身不依赖设置面)。
   */
  isCatalogConfigured?: () => boolean
  /** 测试缝:替代磁盘验签(用于构造复验期间的竞态)。 */
  verify?: (slug: string) => AgentPackageVerification | Promise<AgentPackageVerification>
}

/** 撤销卡片与失败文案的唯一来源:版本号 + 管理员给出的原因。 */
export function agentPackageRevokedMessage(revocation: Pick<AgentPackageRevocation, 'reason'>): string {
  return `该版本已被管理员撤销：${revocation.reason}`
}

/** `{profileDir}/agent-catalog-revocations.json`。 */
export function agentCatalogRevocationsPath(profileDir: string): string {
  return join(profileDir, AGENT_CATALOG_REVOCATIONS_FILE)
}

/**
 * 组装运行前安全面。
 *
 * @param options profile 目录、共用的在途回合登记表,以及可选测试缝
 * @returns 运行前复验、撤销缓存与回合停止的组合门面
 */
export function createAgentCatalogSecurity(options: CreateAgentCatalogSecurityOptions): AgentCatalogSecurity {
  const { profileDir, registry } = options
  /** keyring 只在构造时读一次;缺失/非法时 catalog 路径全程 fail closed。 */
  const keyring: CatalogKeyringEntry[] | undefined = loadKeyring(profileDir)
  let revocations: AgentPackageRevocation[] = []
  /** 每次应用撤销列表自增;assertRunnable 用它发现复验期间到达的撤销。 */
  let generation = 0

  const resolveClient = (): AgentCatalogClient => options.client ?? getAgentCatalogBinding().client

  /**
   * M1-only 用户没有目录根(`agents_host`/`agents_port` 为空):此时任何目录请求
   * 都只会得到 `目录不可达…`,刷新撤销列表必须整段跳过,否则每轮刷新都会挂一条
   * 假的撤销告警。测试替身(`options.client`)不经过设置面,按已配置处理。
   */
  const catalogConfigured = (): boolean => {
    if (options.isCatalogConfigured !== undefined) return options.isCatalogConfigured()
    if (options.client !== undefined) return true
    return isAgentCatalogConfigured()
  }

  const verifyInstalled = async (slug: string): Promise<AgentPackageVerification> => {
    if (options.verify !== undefined) return options.verify(slug)
    if (keyring === undefined) return { ok: false, reason: AGENT_PACKAGE_VERIFY_FAILURE }
    try {
      const verified = verifyAgentPackageDirectory(agentPackageDir(profileDir, slug), keyring)
      return { ok: true, digest: verified.digest, signature: verified.signature }
    } catch (error) {
      // 目录验签失败已由包格式收敛成统一文案;再兜一层,任何异常都不外泄路径。
      return { ok: false, reason: errorMessage(error) || AGENT_PACKAGE_VERIFY_FAILURE }
    }
  }

  const revocationFor = (slug: string, version?: string): AgentPackageRevocation | undefined => {
    const entry = readAgentPackageState(profileDir)[`${CATALOG_STATE_PREFIX}${slug}`]
    const target = version ?? entry?.installedVersion
    if (target !== undefined && target.length > 0) {
      if (entry?.revoked !== undefined && entry.revoked.version === target) return entry.revoked
      const cached = revocations.find((item) => item.slug === slug && item.version === target)
      if (cached !== undefined) return cached
    }
    return undefined
  }

  /**
   * 把撤销列表应用到 state 并返回需要停止回合的 slug。
   *
   * 全部同步完成(没有 await),因此与其它 state 写路径不会交错;generation
   * 在任何 cancel 之前自增。state 写入失败仍返回 slugs:内存撤销表已经生效,
   * 运行门保持 fail closed。
   */
  const applyRevocations = (items: readonly AgentPackageRevocation[]): { slugs: string[]; warning?: string } => {
    generation += 1
    const state = readAgentPackageState(profileDir)
    const next: AgentPackageState = { ...state }
    const slugs: string[] = []
    let changed = false
    for (const [key, entry] of Object.entries(state)) {
      if (!key.startsWith(CATALOG_STATE_PREFIX) || entry.source !== 'catalog') continue
      const slug = key.slice(CATALOG_STATE_PREFIX.length)
      if (entry.installedVersion.length === 0) continue
      const match = items.find((item) => item.slug === slug && item.version === entry.installedVersion)
      if (match === undefined) continue
      const unchanged =
        entry.enabled === false &&
        entry.revoked !== undefined &&
        entry.revoked.slug === match.slug &&
        entry.revoked.version === match.version &&
        entry.revoked.reason === match.reason &&
        entry.revoked.revokedAt === match.revokedAt
      if (unchanged) continue
      next[key] = { ...entry, enabled: false, revoked: match }
      slugs.push(slug)
      changed = true
    }
    if (!changed) return { slugs }
    try {
      writeAgentPackageState(profileDir, next)
    } catch (error) {
      // state 写不进去时内存撤销仍拦住运行门;warning 让 UI 有机会提示重试。
      return { slugs, warning: `撤销状态保存失败：${errorMessage(error)}` }
    }
    return { slugs }
  }

  /**
   * 只读缓存文档;不改 state、不取消回合。`parsed:false` 表示缓存缺失/损坏,
   * 调用方必须保留内存里已应用的撤销,不能当成空列表。
   */
  const readCachedRevocations = (): {
    items: AgentPackageRevocation[]
    parsed: boolean
    warning?: string
  } => {
    const filePath = agentCatalogRevocationsPath(profileDir)
    let text: string
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (isEnoent(error)) return { items: [...revocations], parsed: false }
      return { items: [...revocations], parsed: false, warning: `撤销缓存不可读：${errorMessage(error)}` }
    }

    const items = parseRevocationCache(text)
    if (items === undefined) {
      const backup = backupCorruptCache(filePath)
      return {
        items: [...revocations],
        parsed: false,
        warning: `撤销缓存已损坏，已备份为 ${backup}，未按空列表处理`,
      }
    }
    revocations = items
    return { items, parsed: true }
  }

  const loadCachedRevocations = (): { items: AgentPackageRevocation[]; warning?: string } => {
    const cached = readCachedRevocations()
    if (!cached.parsed) {
      return {
        items: cached.items,
        ...(cached.warning === undefined ? {} : { warning: cached.warning }),
      }
    }
    const applied = applyRevocations(cached.items)
    // 同步入口(启动/离线回落)不阻塞调用方;取消请求已经发起。
    for (const slug of applied.slugs) {
      void registry.cancelBySlug(slug, 'revoke').catch((error: unknown) => {
        // Task 8:取消路径会把清理失败聚合成 rejection。同步入口没有异步 warning
        // 通道,记录日志即可——撤销状态已写入 state/内存,运行门仍 fail closed。
        console.error(`中止在途回合失败：${errorMessage(error)}`)
      })
    }
    const warnings = [cached.warning, applied.warning].filter((value): value is string => value !== undefined)
    return {
      items: cached.items,
      ...(warnings.length === 0 ? {} : { warning: warnings.join('；') }),
    }
  }

  const refreshRevocations = async (): Promise<{ warning?: string }> => {
    // 未配置目录根 = 没有可拉取的撤销源,也没有可报告的目录故障:静默跳过
    // (与 `refreshCatalogPackageCache` 的未配置语义一致)。
    if (!catalogConfigured()) return {}
    let items: AgentPackageRevocation[]
    try {
      items = await resolveClient().getRevocations()
    } catch (error) {
      // 失败保留缓存:离线时必须继续按上次成功拉取的撤销列表执行(含中止在途回合)。
      const cached = readCachedRevocations()
      const parts = [`撤销列表刷新失败：${errorMessage(error)}`]
      if (cached.warning !== undefined) parts.push(cached.warning)
      if (cached.parsed) {
        const applied = applyRevocations(cached.items)
        for (const slug of applied.slugs) {
          try {
            await registry.cancelBySlug(slug, 'revoke')
          } catch (cancelError) {
            // Task 8:回合停止失败是 warning,不阻断缓存回落与撤销应用。
            parts.push(`中止在途回合失败：${errorMessage(cancelError)}`)
          }
        }
        if (applied.warning !== undefined) parts.push(applied.warning)
      }
      return { warning: parts.join('；') }
    }

    let cacheWarning: string | undefined
    try {
      writeRevocationCache(profileDir, items)
    } catch (error) {
      // 缓存写不进去不影响本次应用:内存表仍按最新列表执行撤销。
      cacheWarning = `撤销缓存写入失败：${errorMessage(error)}`
    }
    revocations = items
    const applied = applyRevocations(items)
    const cancelWarnings: string[] = []
    for (const slug of applied.slugs) {
      try {
        await registry.cancelBySlug(slug, 'revoke')
      } catch (error) {
        // Task 8:缓存写入/应用照常完成;回合没停下来以 warning 上报。
        cancelWarnings.push(`中止在途回合失败：${errorMessage(error)}`)
      }
    }
    const warnings = [cacheWarning, applied.warning, ...cancelWarnings].filter(
      (value): value is string => value !== undefined,
    )
    return warnings.length > 0 ? { warning: warnings.join('；') } : {}
  }

  const assertRunnable = async (slug: string, version: string): Promise<void> => {
    for (let attempt = 0; attempt < MAX_ASSERT_ATTEMPTS; attempt += 1) {
      const snapshot = generation
      const revoked = revocationFor(slug, version)
      if (revoked !== undefined) throw new Error(agentPackageRevokedMessage(revoked))
      const verification = await verifyInstalled(slug)
      if (!verification.ok) throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
      // 复验期间没有新的撤销应用:可以放行。
      if (snapshot === generation) return
    }
    // generation 持续变化(撤销列表在反复刷新)时 fail closed,不猜。
    throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
  }

  return {
    loadCachedRevocations,
    refreshRevocations,
    verifyInstalled,
    assertRunnable,
    async stopAgentPackageTurnsForSlug(slug, reason) {
      await registry.cancelBySlug(slug, reason)
    },
    revocationFor,
  }
}

// ---------------------------------------------------------------------------
// 缓存文件
// ---------------------------------------------------------------------------

function loadKeyring(profileDir: string): CatalogKeyringEntry[] | undefined {
  try {
    return readCatalogKeyring(profileDir)
  } catch {
    // 缺失/非法 keyring 只让 catalog 包 fail closed;本地与 legacy 不受影响。
    return undefined
  }
}

type RevocationCacheDocument = {
  schemaVersion: 1
  fetchedAt: string
  items: AgentPackageRevocation[]
}

/** 严格解析缓存;任何形状不符返回 undefined(由调用方备份并告警)。 */
function parseRevocationCache(text: string): AgentPackageRevocation[] | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  if (raw.schemaVersion !== REVOCATION_CACHE_SCHEMA_VERSION) return undefined
  if (typeof raw.fetchedAt !== 'string' || raw.fetchedAt.length === 0) return undefined
  if (!Array.isArray(raw.items)) return undefined
  const items: AgentPackageRevocation[] = []
  for (const value of raw.items) {
    const item = parseRevocation(value)
    // 单条损坏也按整份缓存损坏处理:跳过一条就等于静默放行一个已撤销版本。
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

function parseRevocation(value: unknown): AgentPackageRevocation | undefined {
  if (!isRecord(value)) return undefined
  const { slug, version, reason, revokedAt } = value
  if (
    typeof slug !== 'string' ||
    slug.length === 0 ||
    typeof version !== 'string' ||
    version.length === 0 ||
    typeof reason !== 'string' ||
    reason.length === 0 ||
    typeof revokedAt !== 'string' ||
    revokedAt.length === 0
  ) {
    return undefined
  }
  // 服务端 `actor` 只用于审计,不进入桌面状态。
  return { slug, version, reason, revokedAt }
}

/** tmp+rename;失败清临时文件,调用方决定是否降级为 warning。 */
function writeRevocationCache(profileDir: string, items: readonly AgentPackageRevocation[]): void {
  const filePath = agentCatalogRevocationsPath(profileDir)
  const tempPath = `${filePath}.tmp`
  const document: RevocationCacheDocument = {
    schemaVersion: REVOCATION_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    items: items.map((item) => ({ ...item })),
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(tempPath, filePath)
  } catch (error) {
    removeQuietly(tempPath)
    throw error
  }
}

/**
 * 把坏缓存改名留存,返回磁盘上的文件名(不含目录)。
 *
 * 不删除损坏证据:运维需要它判断是写入中断、磁盘损坏还是被人改动。
 */
function backupCorruptCache(filePath: string): string {
  const target = `${filePath}.corrupt-${String(Date.now())}`
  try {
    renameSync(filePath, target)
    return basename(target)
  } catch {
    return basename(filePath)
  }
}

function removeQuietly(target: string): void {
  try {
    rmSync(target, { force: true })
  } catch {
    // 尽力而为:残留临时文件由下一次写入覆盖。
  }
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
