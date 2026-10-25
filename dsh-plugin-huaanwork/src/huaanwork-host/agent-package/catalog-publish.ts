import { buildUnsignedAgentPackageBundle } from '@huaanwork/agent-package-format/bundle'
import { readUnsignedPackageFiles } from '@huaanwork/agent-package-format/digest'

import {
  AGENT_CATALOG_AUTH_ERROR,
  getAgentCatalogBinding,
  type AgentCatalogSettings,
} from './catalog-client.ts'
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
}

/** `requestLocalAgentPackageDelist` 的结果;服务端的 request id。 */
export type LocalAgentPackageDelistResult = {
  requestId: string
}

/**
 * 把本地包提交审查。
 *
 * 只允许 `source:'local'`、未损坏、未处于待审查的包;先在本机生成 unsigned
 * bundle 再提交,成功后才写 `pending-review` + submissionId 并触发
 * `agent/changed`。失败不改旧状态。
 */
export async function publishLocalAgentPackage(slug: string): Promise<{ submissionId: string }> {
  const binding = getAgentCatalogBinding()
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

    // 上传最多 5 秒;期间内容可能被一次 commit 改写。先记下上传前的内容身份,
    // 上传完成后必须仍然一致,否则旧内容的 submissionId 会落到新版本头上。
    const submittedVersion = detail.version
    const submittedEntry = lookup.kind === 'local' ? lookup.entry : undefined

    const files = readUnsignedPackageFiles(agentPackageDir(binding.profileDir, slug))
    const bundle = await buildUnsignedAgentPackageBundle(files)
    const submission = await binding.client.submit(bundle)
    if (submission.slug !== slug) throw new Error('目录返回的提交与本地智能体不一致')
    // 服务端回显的版本必须是上传前捕获的版本;否则说明文件在上传窗口里被换过。
    if (submission.version !== submittedVersion) throw new Error(STATE_CHANGED_ERROR)

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
      publishStatus: 'pending-review',
      submissionId: submission.submissionId,
      ...(previous?.publishedVersion === undefined
        ? {}
        : { publishedVersion: previous.publishedVersion }),
    }
    writeAgentPackageState(binding.profileDir, {
      ...latest,
      [`local:${slug}`]: next,
    })

    logAgentPackageAction(binding.logger, action, {
      slug,
      version: submission.version,
      submissionId: submission.submissionId,
      outcome: 'ok',
    })
    binding.emitChanged?.(slug)
    return { submissionId: submission.submissionId }
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
 * 按已保存的 submissionId 刷新审查结果,并在已发布时检查目录 metadata 是否
 * 已下架。网络失败直接抛错,state 保持原样。
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
    if (lookup.kind === 'none') throw new Error(`智能体 @${slug} 没有本地发布状态`)

    const detail = readAgentPackage(binding.profileDir, slug)
    const currentVersion =
      detail !== undefined && detail.source === 'local' ? detail.version : lookup.entry.installedVersion
    // 网络等待期间本地内容可能被 commit 复位(或重新提交):记下发起刷新时的
    // 身份,最终写回前必须仍然一致。
    const initialEntry = lookup.entry
    let next: AgentPackageStateEntry = { ...initialEntry }

    if (next.submissionId !== undefined) {
      const submission = await binding.client.getSubmission(next.submissionId)
      if (submission.slug !== slug) throw new Error('目录返回的提交与本地智能体不一致')
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
          next.publishedVersion = currentVersion || submission.version
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
    if (live.kind !== 'local') throw new Error(STATE_CHANGED_ERROR)
    if (
      live.entry.submissionId !== initialEntry.submissionId ||
      live.entry.installedVersion !== initialEntry.installedVersion
    ) {
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
    // 以刷新期间落盘的最新条目为底,只覆盖本次查询到的发布字段,避免丢掉
    // 并发写入的 delistRequestId 等 M2 字段。
    const merged: AgentPackageStateEntry = { ...live.entry }
    merged.publishStatus = next.publishStatus ?? live.entry.publishStatus ?? 'none'
    if (next.publishedVersion !== undefined) merged.publishedVersion = next.publishedVersion
    if (next.submissionId !== undefined) merged.submissionId = next.submissionId
    if (next.reviewReason === undefined) delete merged.reviewReason
    else merged.reviewReason = next.reviewReason
    writeAgentPackageState(binding.profileDir, {
      ...state,
      [`local:${slug}`]: merged,
    })

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
