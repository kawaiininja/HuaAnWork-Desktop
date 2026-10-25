import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  buildUnsignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
} from '@huaanwork/agent-package-format/bundle'
import { readUnsignedPackageFiles } from '@huaanwork/agent-package-format/digest'
import { canonicalJson } from '@huaanwork/catalog-signing'

import {
  AGENT_CATALOG_AUTH_ERROR,
  getAgentCatalogBinding,
  type AgentCatalogBinding,
  type AgentCatalogSettings,
  type AgentPackageSubmission,
  type AgentPackageSubmissionStatus,
} from './catalog-client.ts'
import { agentPackagePublishLock } from './publish-lock.ts'
import {
  agentPackageDir,
  lookupAgentPackageState,
  readAgentPackage,
  readAgentPackageState,
  writeAgentPackageState,
} from './store.ts'
import type {
  AgentPackagePublishStatus,
  AgentPackageStateEntry,
} from './types.ts'

/**
 * 本地智能体包的发布生命周期:提交审查、刷新审查/下架状态、申请下架,以及
 * 本地内容变化后的发布状态复位。
 *
 * 所有依赖来自 `catalog-client.ts` 的单一绑定;本模块不持有 profileDir 或 token,
 * 也不把 token / Authorization / 私钥字段交给日志函数。Task 9 的安装/更新/移除
 * 复用同一 `logAgentPackageAction`。
 */

const LOG_FIELD_KEYS = ['slug', 'version', 'submissionId', 'outcome', 'reason'] as const

/**
 * 网络等待期间本地内容或发布身份发生变化时的统一拒绝文案。
 *
 * 上传/刷新/下架都在 await 之后重新读取 state:若内容、提交或版本已经变了,
 * 旧请求的结果不再对应当前内容,绝不能写回发布字段。
 */
const STATE_CHANGED_ERROR = '智能体状态已变化，请刷新后重试'

export type AgentPackageLogOutcome = 'ok' | 'error'

/** 日志字段白名单:不接受 token、Authorization、私钥或任意额外字段。 */
export type AgentPackageLogFields = {
  slug?: string
  version?: string
  submissionId?: string
  outcome?: AgentPackageLogOutcome
  reason?: string
}

/**
 * 记录一条发布/安装动作。只输出白名单字段;调用方即便传入别的键(测试会这么
 * 做)也不会进入日志。token 与私钥永不进日志。
 */
export function logAgentPackageAction(
  logger: (message: string) => void,
  action: string,
  fields: AgentPackageLogFields = {},
): void {
  const parts: string[] = [`[agent-package] ${sanitizeLogValue(action)}`]
  for (const key of LOG_FIELD_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) {
      parts.push(`${key}=${sanitizeLogValue(value)}`)
    }
  }
  logger(parts.join(' '))
}

/** `refreshLocalAgentPackagePublishStatus` 的可见结果。 */
export type LocalAgentPackagePublication = {
  slug: string
  publishStatus: AgentPackagePublishStatus
  publishedVersion?: string
  submissionId?: string
  reviewReason?: string
  delistRequestId?: string
  /**
   * 对账未能完成的非致命原因(例如 sidecar 中的提交暂时查不到)。调用方可以
   * 照常使用其余字段;缺席表示本次刷新没有额外告警。
   */
  warning?: string
}

/** `requestLocalAgentPackageDelist` 的结果;服务端的 request id。 */
export type LocalAgentPackageDelistResult = {
  requestId: string
}

/**
 * 一条「已发出、本地尚未确认」的提交(Task 10 / I-15)。
 *
 * 键是 slug。`submissionId` 在两种情形下缺席:POST 已发出但响应丢失(201 lost),
 * 或响应已到但写它之前崩溃。只要 `idempotencyKey` 在,下一次提交带同一个键
 * 就能从服务端拿回原记录。
 */
type PendingSubmission = {
  submissionId?: string
  version: string
  digestSha256: string
  idempotencyKey: string
  createdAt: string
}

const PENDING_SUBMISSIONS_FILE = 'agent-catalog-pending-submissions.json'
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function pendingSubmissionsPath(profileDir: string): string {
  return join(profileDir, PENDING_SUBMISSIONS_FILE)
}

/** 缺失/损坏按空表处理:sidecar 只是恢复线索,不是权威状态。 */
function readPendingSubmissions(profileDir: string): Record<string, PendingSubmission> {
  let text: string
  try {
    text = readFileSync(pendingSubmissionsPath(profileDir), 'utf8')
  } catch {
    return {}
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(raw)) return {}
  const entries: Record<string, PendingSubmission> = {}
  for (const [slug, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const { submissionId, version, digestSha256, idempotencyKey, createdAt } = value
    if (typeof version !== 'string' || version.length === 0) continue
    if (typeof digestSha256 !== 'string' || digestSha256.length === 0) continue
    if (typeof idempotencyKey !== 'string' || !UUID_SHAPE.test(idempotencyKey)) continue
    if (typeof createdAt !== 'string' || createdAt.length === 0) continue
    if (submissionId !== undefined && (typeof submissionId !== 'string' || submissionId.length === 0)) continue
    entries[slug] = {
      ...(submissionId === undefined ? {} : { submissionId }),
      version,
      digestSha256,
      idempotencyKey,
      createdAt,
    }
  }
  return entries
}

/** tmp+rename 写入;表为空时删除文件(与写入同样保持单文件原子)。 */
function writePendingSubmissions(
  profileDir: string,
  entries: Record<string, PendingSubmission>,
): void {
  const target = pendingSubmissionsPath(profileDir)
  if (Object.keys(entries).length === 0) {
    try {
      rmSync(target, { force: true })
    } catch {
      // 删除失败不影响已确认的发布状态:下一次写入会覆盖它。
    }
    return
  }
  const temp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  try {
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 尽力而为;残留的 .tmp 不影响读取。
    }
    throw error
  }
}

function recordPendingSubmission(profileDir: string, slug: string, entry: PendingSubmission): void {
  const entries = readPendingSubmissions(profileDir)
  entries[slug] = entry
  writePendingSubmissions(profileDir, entries)
}

/** 只清自己确认过的那条:并发写者可能已经替换了同一 slug 的线索。 */
function clearPendingSubmission(
  profileDir: string,
  slug: string,
  submissionId: string | undefined,
): void {
  const entries = readPendingSubmissions(profileDir)
  const current = entries[slug]
  if (current === undefined || current.submissionId !== submissionId) return
  delete entries[slug]
  try {
    writePendingSubmissions(profileDir, entries)
  } catch {
    // state 已经写成;sidecar 残留只会让下一次提交走同键重放,不会丢事实。
  }
}

/**
 * 把本地包提交审查。
 *
 * 只允许 `source:'local'`、未损坏、未处于待审查的包;先在本机生成 unsigned
 * bundle 再提交,成功后才写 `pending-review` + submissionId 并触发
 * `agent/changed`。失败不改旧状态。
 *
 * 幂等(Task 10 / I-15):同一 profile+slug 的 publish 与 commit 串行;提交前
 * 把幂等键写进 sidecar,收到响应先落 submissionId 再写 state。任何一步失败
 * 都留下可重试的线索:重试复用同一个键/ID,不会创建第二条远端 submission。
 */
export async function publishLocalAgentPackage(slug: string): Promise<{ submissionId: string }> {
  const binding = getAgentCatalogBinding()
  return agentPackagePublishLock.run(binding.profileDir, slug, () => publishLocalAgentPackageLocked(binding, slug))
}

async function publishLocalAgentPackageLocked(
  binding: AgentCatalogBinding,
  slug: string,
): Promise<{ submissionId: string }> {
  const action = 'publish.submit'
  try {
    const detail = readAgentPackage(binding.profileDir, slug)
    if (detail === undefined) throw new Error(`智能体 @${slug} 不存在`)
    if (detail.source !== 'local') throw new Error('只有本地创建的智能体可以提交审查')
    if (detail.broken !== undefined) throw new Error(`智能体 @${slug} 已损坏：${detail.broken.reason}`)

    const state = readAgentPackageState(binding.profileDir)
    const lookup = lookupAgentPackageState(state, slug)
    if (lookup.kind === 'corrupt') throw new Error(lookup.reason)
    if (lookup.kind === 'catalog') throw new Error('只有本地创建的智能体可以提交审查')
    if (lookup.kind === 'local' && lookup.entry.publishStatus === 'pending-review') {
      throw new Error('该智能体已在审查中，请勿重复提交')
    }

    const settings = binding.readSettings()
    requirePublishToken(settings)

    // 上传最多 5 秒;期间内容可能被一次 commit 改写。publish lock 已把同 slug
    // 的 commit 挡在外面,下面的内容身份快照仍是写入前的最后一道守卫。
    const submittedVersion = detail.version
    const submittedEntry = lookup.kind === 'local' ? lookup.entry : undefined

    const files = readUnsignedPackageFiles(agentPackageDir(binding.profileDir, slug))
    const bundle = await buildUnsignedAgentPackageBundle(files)
    // 与目录服务相同的 inspector:本地身份必须等于服务端会重算出的 digest。
    const inspection = await inspectUnsignedAgentPackageBundle(bundle)
    const digestSha256 = createHash('sha256')
      .update(canonicalJson(inspection.digest), 'utf8')
      .digest('hex')

    const pending = readPendingSubmissions(binding.profileDir)[slug]
    if (
      pending !== undefined
      && (pending.version !== submittedVersion || pending.digestSha256 !== digestSha256)
    ) {
      // 内容已变化:旧提交既不能被新内容覆盖提交,也不能被静默丢弃。
      throw new Error(
        `上一次提交 ${pending.submissionId ?? pending.idempotencyKey} 仍在对账，请先刷新状态`,
      )
    }

    const idempotencyKey = pending?.idempotencyKey ?? randomUUID()
    if (pending === undefined) {
      // 键必须先落盘再发请求:上传与本地状态写入之间崩溃时,它是唯一的恢复句柄。
      recordPendingSubmission(binding.profileDir, slug, {
        version: submittedVersion,
        digestSha256,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      })
    }

    let submissionId: string
    let submissionVersion: string
    let submissionStatus: AgentPackageSubmissionStatus
    let submissionReason: string | undefined

    if (pending?.submissionId !== undefined) {
      // 已有远端 ID:重试先取真实状态(等待期间 admin 可能已 approve/reject)。
      const submission = await binding.client.getSubmission(pending.submissionId)
      if (submission.slug !== slug) throw new Error('目录返回的提交与本地智能体不一致')
      submissionId = submission.submissionId
      submissionVersion = submission.version
      submissionStatus = submission.status
      submissionReason = submission.reason
    } else {
      const submission = await binding.client.submit(bundle, { idempotencyKey })
      submissionId = submission.submissionId
      submissionVersion = submission.version
      submissionStatus = submission.status
      submissionReason = submission.reason
      // 远端事实先落 sidecar,再跑任何可能拒绝本次调用的本地守卫(I-15)。
      recordPendingSubmission(binding.profileDir, slug, {
        submissionId,
        version: submittedVersion,
        digestSha256,
        idempotencyKey,
        createdAt: pending?.createdAt ?? new Date().toISOString(),
      })
      if (submission.slug !== slug) throw new Error('目录返回的提交与本地智能体不一致')
    }
    // 服务端回显的版本必须是上传前捕获的版本;否则说明文件在上传窗口里被换过。
    if (submissionVersion !== submittedVersion) throw new Error(STATE_CHANGED_ERROR)

    // 写入前重新读取 state 并核对内容身份:live 条目的 installedVersion 必须仍是
    // 上传前的版本,submissionId 也必须仍是上传前的值(防止并发重复提交)。
    const latest = readAgentPackageState(binding.profileDir)
    const live = lookupAgentPackageState(latest, slug)
    if (live.kind === 'corrupt' || live.kind === 'catalog') throw new Error(STATE_CHANGED_ERROR)
    if (live.kind === 'none') {
      if (submittedEntry !== undefined) throw new Error(STATE_CHANGED_ERROR)
    } else if (
      live.entry.installedVersion !== submittedVersion ||
      live.entry.submissionId !== submittedEntry?.submissionId
    ) {
      throw new Error(STATE_CHANGED_ERROR)
    }

    const previous = live.kind === 'local' ? live.entry : undefined
    const next: AgentPackageStateEntry = {
      source: 'local',
      enabled: previous?.enabled ?? detail.enabled,
      installedVersion: previous?.installedVersion || submittedVersion,
      ...publicationFields(
        submissionStatus,
        submissionId,
        submissionVersion,
        submissionReason,
        previous?.publishedVersion,
      ),
    }
    writeAgentPackageState(binding.profileDir, {
      ...latest,
      [`local:${slug}`]: next,
    })
    // state 已确认才清线索;写失败时 sidecar 保留,重试复用同一个 ID。
    clearPendingSubmission(binding.profileDir, slug, submissionId)

    logAgentPackageAction(binding.logger, action, {
      slug,
      version: submissionVersion,
      submissionId,
      outcome: 'ok',
    })
    binding.emitChanged?.(slug)
    return { submissionId }
  } catch (error) {
    logAgentPackageAction(binding.logger, action, {
      slug,
      outcome: 'error',
      reason: errorMessage(error),
    })
    throw error
  }
}

/** 服务端状态 → 本地发布字段;重试发现已 approve/reject 时也写真实结果。 */
function publicationFields(
  status: AgentPackageSubmissionStatus,
  submissionId: string,
  version: string,
  reason: string | undefined,
  previousPublishedVersion: string | undefined,
): Pick<
  AgentPackageStateEntry,
  'publishStatus' | 'submissionId' | 'publishedVersion' | 'reviewReason'
> {
  switch (status) {
    case 'pending-review':
      return {
        publishStatus: 'pending-review',
        submissionId,
        ...(previousPublishedVersion === undefined
          ? {}
          : { publishedVersion: previousPublishedVersion }),
      }
    case 'published':
      return { publishStatus: 'published', submissionId, publishedVersion: version }
    case 'rejected':
      return {
        publishStatus: 'rejected',
        submissionId,
        ...(previousPublishedVersion === undefined
          ? {}
          : { publishedVersion: previousPublishedVersion }),
        ...(reason === undefined ? {} : { reviewReason: reason }),
      }
  }
}

/**
 * 按已保存的 submissionId 刷新审查结果,并在已发布时检查目录 metadata 是否
 * 已下架。网络失败直接抛错,state 保持原样。
 *
 * 同时负责 sidecar 对账(Task 10 / I-15):上一次 publish 已拿到远端 ID 但
 * 没写成 state 时,用 `getSubmission` 把真实状态补回来;查询失败保留 sidecar
 * 并把原因放进 `warning`,不推翻已有发布状态。
 */
export async function refreshLocalAgentPackagePublishStatus(
  slug: string,
): Promise<LocalAgentPackagePublication> {
  const binding = getAgentCatalogBinding()
  const action = 'publish.status'
  try {
    const lookup = lookupAgentPackageState(readAgentPackageState(binding.profileDir), slug)
    if (lookup.kind === 'corrupt') throw new Error(lookup.reason)
    if (lookup.kind === 'catalog') throw new Error('只有本地创建的智能体才有发布状态')

    const detail = readAgentPackage(binding.profileDir, slug)
    const pending = readPendingSubmissions(binding.profileDir)[slug]
    if (lookup.kind === 'none' && pending === undefined) {
      throw new Error(`智能体 @${slug} 没有本地发布状态`)
    }

    const currentVersion =
      detail !== undefined && detail.source === 'local'
        ? detail.version
        : lookup.kind === 'local'
          ? lookup.entry.installedVersion
          : (pending?.version ?? '')
    // 网络等待期间本地内容可能被 commit 复位(或重新提交):记下发起刷新时的
    // 身份,最终写回前必须仍然一致。
    const initialEntry: AgentPackageStateEntry =
      lookup.kind === 'local'
        ? lookup.entry
        : {
            source: 'local',
            enabled: detail?.enabled ?? false,
            installedVersion: currentVersion,
            publishStatus: 'none',
          }
    let next: AgentPackageStateEntry = { ...initialEntry }

    // sidecar 是「远端已受理、本地未确认」的事实,优先于 state 里的旧身份。
    const pendingId = pending?.submissionId
    const targetId = pendingId ?? next.submissionId
    if (targetId === undefined && pending !== undefined) {
      // 只有幂等键、没有远端 ID(201 丢失)。刷新无法对账,保留线索并提示:
      // 下一次提交带同一个键会拿回原记录。
      return {
        ...toPublication(slug, initialEntry),
        warning: `上一次提交 ${pending.idempotencyKey} 尚未取得回执，请重新提交以恢复`,
      }
    }
    if (targetId !== undefined) {
      let submission: AgentPackageSubmission
      try {
        submission = await binding.client.getSubmission(targetId)
      } catch (error) {
        if (pendingId === undefined) throw error
        // 对账失败保留 sidecar:它是下一次刷新/提交的唯一线索。
        logAgentPackageAction(binding.logger, action, {
          slug,
          version: pending?.version ?? currentVersion,
          submissionId: pendingId,
          outcome: 'ok',
          reason: 'reconcile-pending',
        })
        return {
          ...toPublication(slug, initialEntry),
          warning: `上一次提交 ${pendingId} 仍在对账：${errorMessage(error)}`,
        }
      }
      if (submission.slug !== slug) throw new Error('目录返回的提交与本地智能体不一致')
      next.submissionId = submission.submissionId
      switch (submission.status) {
        case 'pending-review':
          next.publishStatus = 'pending-review'
          break
        case 'rejected':
          next.publishStatus = 'rejected'
          if (submission.reason === undefined) delete next.reviewReason
          else next.reviewReason = submission.reason
          break
        case 'published':
          next.publishStatus = 'published'
          // sidecar 记录的是旧内容的一次提交:当前内容若已变化,不能把它说成
          // 已发布,只记远端事实的版本。
          next.publishedVersion =
            pendingId === undefined ? currentVersion || submission.version : submission.version
          delete next.reviewReason
          break
      }
    }

    if (
      next.publishedVersion !== undefined &&
      (next.publishStatus === 'published' || next.publishStatus === 'delisted')
    ) {
      // metadata 读取失败不推翻已确认的 submission 状态:下架检查是尽力而为,
      // 真正的安装/运行安全由 Task 10 的撤销与验签负责。
      try {
        const metadata = await binding.client.getPackage(slug, next.publishedVersion)
        if (metadata.status === 'delisted') next.publishStatus = 'delisted'
      } catch {
        // 保留 submission 状态。
      }
    }

    const state = readAgentPackageState(binding.profileDir)
    const live = lookupAgentPackageState(state, slug)
    if (live.kind === 'corrupt' || live.kind === 'catalog') throw new Error(STATE_CHANGED_ERROR)
    if (live.kind === 'local' && lookup.kind === 'none') {
      // 刷新期间有别人先写了状态:本次放弃,sidecar 保留给下一次对账。
      return toPublication(slug, live.entry)
    }
    if (live.kind === 'local' && (
      live.entry.submissionId !== initialEntry.submissionId ||
      live.entry.installedVersion !== initialEntry.installedVersion
    )) {
      // 刷新期间本地内容被 commit 复位(或重新提交):本次查询到的旧 publication
      // 字段已不对应当前内容,整次刷新放弃,只返回最新状态、不写任何字段。
      logAgentPackageAction(binding.logger, action, {
        slug,
        version: live.entry.publishedVersion ?? currentVersion,
        ...(live.entry.submissionId === undefined ? {} : { submissionId: live.entry.submissionId }),
        outcome: 'ok',
        reason: 'state-changed',
      })
      return toPublication(slug, live.entry)
    }
    if (live.kind === 'none' && lookup.kind === 'local') throw new Error(STATE_CHANGED_ERROR)
    // 以刷新期间落盘的最新条目为底,只覆盖本次查询到的发布字段,避免丢掉
    // 并发写入的 delistRequestId 等 M2 字段。
    const merged: AgentPackageStateEntry = { ...(live.kind === 'local' ? live.entry : initialEntry) }
    merged.publishStatus = next.publishStatus ?? merged.publishStatus ?? 'none'
    if (next.publishedVersion !== undefined) merged.publishedVersion = next.publishedVersion
    if (next.submissionId !== undefined) merged.submissionId = next.submissionId
    if (next.reviewReason === undefined) delete merged.reviewReason
    else merged.reviewReason = next.reviewReason
    writeAgentPackageState(binding.profileDir, {
      ...state,
      [`local:${slug}`]: merged,
    })
    if (pendingId !== undefined) clearPendingSubmission(binding.profileDir, slug, pendingId)

    logAgentPackageAction(binding.logger, action, {
      slug,
      version: merged.publishedVersion ?? currentVersion,
      ...(merged.submissionId === undefined ? {} : { submissionId: merged.submissionId }),
      outcome: 'ok',
      reason: merged.publishStatus ?? 'none',
    })
    return toPublication(slug, merged)
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
 * 为已发布的本地版本申请下架。只允许 `publishStatus:'published'` 且有
 * `publishedVersion` 的本地条目;成功后保存服务端返回的下架 request id。
 */
export async function requestLocalAgentPackageDelist(
  slug: string,
  rawReason: string,
): Promise<LocalAgentPackageDelistResult> {
  const binding = getAgentCatalogBinding()
  const action = 'publish.delist'
  try {
    const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
    if (reason.length === 0) throw new Error('下架原因不能为空')
    if (reason.length > 500) throw new Error('下架原因不能超过 500 个字符')

    const state = readAgentPackageState(binding.profileDir)
    const lookup = lookupAgentPackageState(state, slug)
    if (lookup.kind === 'corrupt') throw new Error(lookup.reason)
    if (lookup.kind === 'catalog') throw new Error('只有本地创建的智能体可以申请下架')
    if (lookup.kind === 'none') throw new Error(`智能体 @${slug} 没有本地发布状态`)
    const entry = lookup.entry
    if (entry.publishStatus !== 'published' || entry.publishedVersion === undefined) {
      throw new Error('只有已发布的版本可以申请下架')
    }

    requirePublishToken(binding.readSettings())
    const request = await binding.client.requestDelist(slug, entry.publishedVersion, reason)

    const latest = readAgentPackageState(binding.profileDir)
    const live = lookupAgentPackageState(latest, slug)
    if (
      live.kind !== 'local' ||
      live.entry.submissionId !== entry.submissionId ||
      live.entry.installedVersion !== entry.installedVersion ||
      live.entry.publishStatus !== 'published' ||
      live.entry.publishedVersion !== entry.publishedVersion
    ) {
      throw new Error(STATE_CHANGED_ERROR)
    }
    const next: AgentPackageStateEntry = { ...live.entry, delistRequestId: request.id }
    writeAgentPackageState(binding.profileDir, {
      ...latest,
      [`local:${slug}`]: next,
    })

    logAgentPackageAction(binding.logger, action, {
      slug,
      version: entry.publishedVersion,
      outcome: 'ok',
    })
    return { requestId: request.id }
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
 * 本地内容 commit 成功后复位发布状态。
 *
 * 只清 `publishStatus/submissionId/reviewReason/delistRequestId/revoked`,置
 * `publishStatus:'none'`;`enabled`、`installedVersion` 与 `publishedVersion`
 * 保留(后者作为发布历史)。不触碰 catalog 键。
 */
export function resetLocalAgentPackagePublication(profileDir: string, slug: string): void {
  const state = readAgentPackageState(profileDir)
  const key = `local:${slug}`
  const entry = state[key]
  if (entry === undefined) return
  const next: AgentPackageStateEntry = {
    source: 'local',
    enabled: entry.enabled,
    installedVersion: entry.installedVersion,
    publishStatus: 'none',
    ...(entry.publishedVersion === undefined ? {} : { publishedVersion: entry.publishedVersion }),
  }
  writeAgentPackageState(profileDir, {
    ...state,
    [key]: next,
  })
}

function toPublication(slug: string, entry: AgentPackageStateEntry): LocalAgentPackagePublication {
  return {
    slug,
    publishStatus: entry.publishStatus ?? 'none',
    ...(entry.publishedVersion === undefined ? {} : { publishedVersion: entry.publishedVersion }),
    ...(entry.submissionId === undefined ? {} : { submissionId: entry.submissionId }),
    ...(entry.reviewReason === undefined ? {} : { reviewReason: entry.reviewReason }),
    ...(entry.delistRequestId === undefined ? {} : { delistRequestId: entry.delistRequestId }),
  }
}

function requirePublishToken(settings: AgentCatalogSettings): void {
  if (settings.agents_catalog_publish_token.trim().length === 0) {
    throw new Error(AGENT_CATALOG_AUTH_ERROR)
  }
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 300)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
