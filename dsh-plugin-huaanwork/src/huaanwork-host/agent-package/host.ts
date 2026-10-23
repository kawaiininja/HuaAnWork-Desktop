import {
  beginAgentPackageUpdate,
  cancelAgentPackage,
  commitAgentPackage,
  loadAgentPackageDraft,
  proposeAgentPackage,
  type CommitResult,
  type ProposeResult,
} from './drafts.ts'
import { listLocalAgentPackages, readAgentPackage, setAgentPackageEnabled } from './store.ts'
import type { AgentPackageDetail, AgentPackageListItem, AgentPackageProposalInput } from './types.ts'

/**
 * 智能体创建/管理的宿主门面(计划 Task 3 基线;Task 6/7 在同一导出类型上
 * 追加运行时与 legacy 方法)。
 *
 * 宿主自己持有每个会话的 `lastUserText` 与「同一轮已提出草稿」标记:
 * `noteUserText` 由创建入口在每一轮用户原句到达时调用(写入新原句并清除
 * 同轮标记),`propose` 成功后置位,`commit` 读取后拒绝同轮提交。写路径
 * 成功后的 `agent/changed` 事件由上层路由发出,本宿主不持有 hub。
 */
export type AgentPackageHost = {
  propose(sessionId: string, input: AgentPackageProposalInput): Promise<ProposeResult>
  commit(
    sessionId: string,
    draftId: string,
    rawUserText: string,
    opts?: { proposedThisTurn?: boolean },
  ): Promise<CommitResult>
  cancel(sessionId: string): Promise<boolean>
  hasDraft(sessionId: string): boolean
  beginUpdate(sessionId: string, slug: string): Promise<void>
  lastUserText(sessionId: string): string | undefined
  noteUserText(sessionId: string, text: string): void
  listLocal(): AgentPackageListItem[]
  detail(slug: string): AgentPackageDetail | undefined
  setEnabled(slug: string, enabled: boolean): void
}

export type CreateAgentPackageHostOptions = {
  profileDir: string
  /** 每次调用都读当前值:本地入口与已有智能体的占用名会随会话变化。 */
  takenSlugs: () => readonly string[]
  /** 兼容旧调用方的回落来源;`noteUserText` 写入的原句优先。 */
  lastUserText?: (sessionId: string) => string | undefined
}

/**
 * 组装 `AgentPackageHost`。
 *
 * @param options profile 目录、`takenSlugs` 提供方,以及可选的原句回落读取
 * @returns 宿主门面
 */
export function createAgentPackageHost(options: CreateAgentPackageHostOptions): AgentPackageHost {
  const { profileDir, takenSlugs } = options
  const lastText = new Map<string, string>()
  const proposedThisTurn = new Set<string>()

  return {
    async propose(sessionId, input) {
      const result = await proposeAgentPackage(profileDir, sessionId, input, takenSlugs())
      if (result.ok) proposedThisTurn.add(sessionId)
      return result
    },

    async commit(sessionId, draftId, rawUserText, opts) {
      return commitAgentPackage(profileDir, sessionId, draftId, rawUserText, takenSlugs(), {
        proposedThisTurn: opts?.proposedThisTurn ?? proposedThisTurn.has(sessionId),
      })
    },

    async cancel(sessionId) {
      proposedThisTurn.delete(sessionId)
      return cancelAgentPackage(profileDir, sessionId)
    },

    hasDraft(sessionId) {
      return loadAgentPackageDraft(profileDir, sessionId) !== undefined
    },

    async beginUpdate(sessionId, slug) {
      await beginAgentPackageUpdate(profileDir, sessionId, slug)
      proposedThisTurn.delete(sessionId)
    },

    lastUserText(sessionId) {
      const noted = lastText.get(sessionId)
      if (noted !== undefined) return noted
      return options.lastUserText?.(sessionId)
    },

    noteUserText(sessionId, text) {
      lastText.set(sessionId, text)
      proposedThisTurn.delete(sessionId)
    },

    listLocal() {
      return listLocalAgentPackages(profileDir)
    },

    detail(slug) {
      return readAgentPackage(profileDir, slug)
    },

    setEnabled(slug, enabled) {
      const detail = readAgentPackage(profileDir, slug)
      if (detail === undefined) throw new Error(`智能体 @${slug} 不存在`)
      if (detail.broken !== undefined) throw new Error(`智能体 @${slug} 已损坏:${detail.broken.reason}`)
      setAgentPackageEnabled(profileDir, slug, enabled)
    },
  }
}
