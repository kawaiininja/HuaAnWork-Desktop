import { attachAgentTools, detachAgentTools, type AttachmentMaps } from '../huaanwork-guardrails/agent-attachments.ts'
import { refreshAgentRestrict } from '../huaanwork-guardrails/present-as.ts'
import { bundledSkillDir, getBundledSkill } from '../huaanwork-guardrails/skills.ts'
import {
  cancelSkillCreation,
  commitSkillCreation,
  hasSkillCreationDraftOnDisk,
  loadSkillCreationDraft,
  proposeSkillCreation,
  type CancelOptions,
  type SkillCommitResult,
  type SkillProposalInput,
  type SkillProposeResult,
} from './skill-creation-drafts.ts'
import { wrapSkillPrompt } from './skill-invoke.ts'

/**
 * 对话创建技能的宿主门面:入口注入、按会话挂载工具与有界的回合状态。
 *
 * 草稿与授权原语在 `skill-creation-drafts.ts`;本模块只持有每个会话的最近原句、
 * 「同一轮已 propose」与「本轮命中创建入口」标记。`noteUserText` 在每轮用户发送时
 * 调用,`noteCreationTurn` 只在技能创建/继续创建分支调用;`propose` 成功后置位,
 * `commit` 自己读取两个标记——路由不得透传覆盖。
 */

/** 创建流程一次只挂这两个工具;技能中心入口与草稿继续入口共用同一对。 */
export const SKILL_PROPOSE_TOOL = 'skill_propose'
export const SKILL_COMMIT_TOOL = 'skill_commit'
export const SKILL_CREATION_TOOLS = [SKILL_PROPOSE_TOOL, SKILL_COMMIT_TOOL] as const

/** 每会话原句与回合标记只保留最近一批;上限防止长驻宿主按会话无限增长。 */
const MAX_TRACKED_SESSIONS = 256

export type SkillCreationMode = 'create' | 'continue'

/**
 * 技能创建/管理共用的宿主门面。`hasDraft` 读磁盘(`skill-creation-drafts/` 下的
 * 草稿文件),不是内存镜像——跨重启的互斥与双草稿守卫依赖这一事实源。
 * `describeDraft` 返回草稿里的技能名;损坏草稿抛 `CorruptSkillCreationDraftError`。
 */
export type SkillCreationHost = {
  propose(sessionId: string, input: SkillProposalInput): Promise<SkillProposeResult>
  commit(sessionId: string, draftId: string, rawUserText: string): Promise<SkillCommitResult>
  cancel(sessionId: string, options?: CancelOptions): Promise<boolean>
  hasDraft(sessionId: string): boolean
  lastUserText(sessionId: string): string | undefined
  noteUserText(sessionId: string, text: string): void
  noteCreationTurn(sessionId: string, text: string): void
  describeDraft(sessionId: string): string | undefined
}

type CreationContext = {
  huaanworkAttachments?: AttachmentMaps
  /** present-as 的 restrict 状态挂在根 Context 上;工具子插件的桥接对象用它指回真实 ctx。 */
  root?: object
}

const MODE_HINTS: Record<SkillCreationMode, string> = {
  create: '',
  continue:
    '本轮沿用已有草稿:如果用户整句只是同意(可以/确认/同意/就这样/按这个建),直接调用 `skill_commit`,不要再追问;不要新建第二份草稿;其他回复继续访谈。',
}

/**
 * 把内置 `create-skill` 技能正文包装进本轮用户消息。
 *
 * @param text 用户原句(或入口提供的已定信息)
 * @param mode 技能中心新建入口,或已有草稿的继续创建回合
 * @returns 带技能正文与用户请求的完整提示
 */
export function injectCreateSkill(text: string, mode: SkillCreationMode = 'create'): string {
  const skill = getBundledSkill('create-skill')
  if (!skill) throw new Error('create-skill 技能缺失:找不到内置 skills/create-skill/SKILL.md')
  const hint = MODE_HINTS[mode]
  const resourceDir = bundledSkillDir('create-skill')
  return wrapSkillPrompt({
    name: 'create-skill',
    content: hint ? `${hint}\n\n${skill.content}` : skill.content,
    text,
    ...(resourceDir !== undefined ? { resourceDir } : {}),
  })
}

/** 把 `skill_propose` / `skill_commit` 挂到这一会话,并刷新 agent 的可见工具集。 */
export function attachSkillCreationTools(ctx: CreationContext, sessionId: string): void {
  if (!ctx.huaanworkAttachments) return
  attachAgentTools(ctx.huaanworkAttachments, sessionId, SKILL_CREATION_TOOLS)
  refreshAgentRestrict(ctx as never, sessionId)
}

/** 卸下技能创建工具;commit 成功与取消两条终态路径共用,访谈中途不卸。 */
export function detachSkillCreationTools(ctx: CreationContext, sessionId: string): void {
  if (!ctx.huaanworkAttachments) return
  detachAgentTools(ctx.huaanworkAttachments, sessionId, SKILL_CREATION_TOOLS)
  refreshAgentRestrict(ctx as never, sessionId)
}

/**
 * 注入的宿主门面。`sessions.ts` 的发送入口与工具子插件共用同一实例;未注入时
 * (单测或未装载创建能力的组合)路由保持原样。
 */
let skillCreationHost: SkillCreationHost | undefined

/** 由 host `apply()` 注入;测试可注入 fake host,结束后传 undefined 复位。 */
export function setSkillCreationHost(host: SkillCreationHost | undefined): void {
  skillCreationHost = host
}

/** 当前宿主门面;未注入时返回 undefined。 */
export function getSkillCreationHost(): SkillCreationHost | undefined {
  return skillCreationHost
}

/** 插入式 LRU:同一会话的写入移到最新端,超限时淘汰最老条目。 */
function rememberLastText(lastText: Map<string, string>, sessionId: string, text: string): void {
  lastText.delete(sessionId)
  lastText.set(sessionId, text)
  if (lastText.size <= MAX_TRACKED_SESSIONS) return
  const oldest = lastText.keys().next().value
  if (oldest !== undefined) lastText.delete(oldest)
}

/** 与 lastText 同一上限:长驻宿主不能按会话无限累积回合标记。 */
function markBounded(markers: Set<string>, sessionId: string): void {
  markers.delete(sessionId)
  markers.add(sessionId)
  if (markers.size <= MAX_TRACKED_SESSIONS) return
  const oldest = markers.values().next().value
  if (oldest !== undefined) markers.delete(oldest)
}

/**
 * 创建技能门面。
 *
 * @param options.profileDir 技能与草稿的存储根(`skill-creation-drafts/` 在其下)
 * @returns 与路由、工具子插件共用的同一实例
 */
export function createSkillCreationHost(options: { profileDir: string }): SkillCreationHost {
  const profileDir = options.profileDir
  const lastText = new Map<string, string>()
  const proposedThisTurn = new Set<string>()
  const creationTurns = new Set<string>()

  return {
    async propose(sessionId, input) {
      const result = await proposeSkillCreation(profileDir, sessionId, input)
      if (result.ok) markBounded(proposedThisTurn, sessionId)
      return result
    },

    async commit(sessionId, draftId, rawUserText) {
      // 两个回合标记只由宿主自己读取;路由不得把 proposedThisTurn 透传成可关闭的门禁。
      const result = await commitSkillCreation(profileDir, sessionId, draftId, rawUserText, {
        proposedThisTurn: proposedThisTurn.has(sessionId),
        creationTurn: creationTurns.has(sessionId),
      })
      if (result.ok) proposedThisTurn.delete(sessionId)
      return result
    },

    async cancel(sessionId, cancelOptions) {
      proposedThisTurn.delete(sessionId)
      return cancelSkillCreation(profileDir, sessionId, cancelOptions)
    },

    hasDraft(sessionId) {
      // 磁盘事实源:跨重启后的互斥与双草稿守卫不能读内存 Map。
      return hasSkillCreationDraftOnDisk(profileDir, sessionId)
    },

    lastUserText(sessionId) {
      return lastText.get(sessionId)
    },

    noteUserText(sessionId, text) {
      rememberLastText(lastText, sessionId, text)
      proposedThisTurn.delete(sessionId)
      creationTurns.delete(sessionId)
    },

    noteCreationTurn(sessionId, text) {
      rememberLastText(lastText, sessionId, text)
      proposedThisTurn.delete(sessionId)
      markBounded(creationTurns, sessionId)
    },

    describeDraft(sessionId) {
      const draft = loadSkillCreationDraft(profileDir, sessionId)
      return draft?.proposal.name
    },
  }
}
