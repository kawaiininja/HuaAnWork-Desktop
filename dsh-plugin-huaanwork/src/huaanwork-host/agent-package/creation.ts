import { attachAgentTools, detachAgentTools, type AttachmentMaps } from '../../huaanwork-guardrails/agent-attachments.ts'
import { refreshAgentRestrict } from '../../huaanwork-guardrails/present-as.ts'
import { bundledSkillDir, getBundledSkill } from '../../huaanwork-guardrails/skills.ts'
import type { AgentPackageHost } from './host.ts'
import { wrapSkillPrompt } from '../skill-invoke.ts'

/**
 * 会话创建入口:识别 `/create-agent` 与三种规范说法、注入内置技能正文、按会话
 * 挂载 `agent_propose` / `agent_commit`。
 *
 * 技能正文直接读包内 `skills/create-agent/SKILL.md`,不经 `skill-toggles`,也不注册进
 * 全局技能目录;入口未命中且没有草稿时本模块不参与发送链路。
 */

/** 创建流程一次只挂这两个工具;`agent_skill_run` / `agent_http` 属于 `@` 运行链路。 */
export const CREATION_TOOLS = ['agent_propose', 'agent_commit'] as const

export type AgentCreationMode = 'create' | 'update' | 'continue'

export type AgentCreationIntent =
  | { kind: 'create'; initialText: string }
  | { kind: 'update'; slug: string; initialText: string }

/** 保守入口正则(设计 §6.1):只认开头这三种说法,近似说法留给用户改写。 */
const CREATE_RE = /^(?:帮我)?(?:新建|创建|建)(?:一个|个)?(?:智能体|数字员工|助手)/

/** 说法之后紧跟的标点不属于用户信息。 */
const LEADING_SEPARATORS = /^[\s，,。.：:；;、!！?？]+/

type CreationContext = {
  huaanworkAttachments?: AttachmentMaps
  /** present-as 的 restrict 状态挂在根 Context 上;工具子插件的桥接对象用它指回真实 ctx。 */
  root?: object
}

/**
 * 解析 `/create-agent` 之后的命令正文;skill 参数入口与斜杠说法共用同一解析。
 *
 * @param text `/create-agent` 之后的文字,例如 `update weekly-report 改名字`
 * @returns 更新意图(带 slug 与剩余文字)或新建意图(整段文字作为已提供信息)
 */
export function detectCreateAgentCommand(text: string): AgentCreationIntent {
  const trimmed = text.trim()
  const update = /^update(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (update?.[1]) {
    return { kind: 'update', slug: update[1], initialText: (update[2] ?? '').trim() }
  }
  return { kind: 'create', initialText: trimmed }
}

/**
 * 识别创建入口:整段 `/create-agent [...]`,或开头命中保守正则的规范说法。
 *
 * @param text 用户原句
 * @returns 创建/更新意图与已提供的信息;不匹配时 undefined
 */
export function detectAgentCreationIntent(text: string): AgentCreationIntent | undefined {
  const trimmed = text.trim()
  const slash = /^\/create-agent(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (slash) return detectCreateAgentCommand(slash[1] ?? '')

  const match = CREATE_RE.exec(trimmed)
  if (!match) return undefined
  return { kind: 'create', initialText: trimmed.slice(match[0].length).replace(LEADING_SEPARATORS, '') }
}

const MODE_HINTS: Record<AgentCreationMode, (slug?: string) => string> = {
  create: () => '',
  update: (slug) =>
    [
      slug ? `更新目标：@${slug}。` : '',
      '本轮是更新模式:只提交要改的字段;宿主会合并现有包并把 patch 版本加一。',
    ].join(''),
  continue: () =>
    '本轮沿用已有草稿:如果用户整句只是同意(可以/确认/同意/就这样/按这个建),直接调用 `agent_commit`,不要再追问;其他回复继续访谈。',
}

/**
 * 把内置 `create-agent` 技能正文包装进本轮用户消息。
 *
 * @param text 用户原句(或入口提供的已定信息)
 * @param mode 新建 / 更新 / 沿用草稿的后续回合
 * @param slug 更新模式的目标 `@` 标识
 * @returns 带技能正文与用户请求的完整提示
 */
export function injectCreateAgentSkill(text: string, mode: AgentCreationMode = 'create', slug?: string): string {
  const skill = getBundledSkill('create-agent')
  if (!skill) throw new Error('create-agent 技能缺失:找不到内置 skills/create-agent/SKILL.md')
  const hint = MODE_HINTS[mode](slug)
  const resourceDir = bundledSkillDir('create-agent')
  return wrapSkillPrompt({
    name: 'create-agent',
    content: hint ? `${hint}\n\n${skill.content}` : skill.content,
    text,
    ...(resourceDir !== undefined ? { resourceDir } : {}),
  })
}

/** 把 `agent_propose` / `agent_commit` 挂到这一会话,并刷新 agent 的可见工具集。 */
export function attachCreationTools(ctx: CreationContext, sessionId: string): void {
  if (!ctx.huaanworkAttachments) return
  attachAgentTools(ctx.huaanworkAttachments, sessionId, CREATION_TOOLS)
  refreshAgentRestrict(ctx as never, sessionId)
}

/** 卸下创建工具;commit 成功与取消两条终态路径共用,访谈中途不卸。 */
export function detachCreationTools(ctx: CreationContext, sessionId: string): void {
  if (!ctx.huaanworkAttachments) return
  detachAgentTools(ctx.huaanworkAttachments, sessionId, CREATION_TOOLS)
  refreshAgentRestrict(ctx as never, sessionId)
}

/**
 * 注入的宿主门面。`sessions.ts` 的发送入口与工具子插件共用同一实例;未注入时(单测
 * 或未装载创建能力的组合)发送链路保持原样。
 */
let agentPackageHost: AgentPackageHost | undefined

/** 由 host `apply()` 注入;测试可注入 fake host,结束后传 undefined 复位。 */
export function setAgentPackageHost(host: AgentPackageHost | undefined): void {
  agentPackageHost = host
}

/** 当前宿主门面;未注入时返回 undefined。 */
export function getAgentPackageHost(): AgentPackageHost | undefined {
  return agentPackageHost
}

/**
 * 记录这一轮的用户原句并标记本轮命中创建/继续创建入口。
 *
 * 宿主据此同时完成两件事:覆盖上一轮原句、清除「同一轮已 propose」标记,
 * 并让 `agent_commit` 只接受创建流程回合的同意句。
 */
export function noteCreationTurn(sessionId: string, rawText: string): void {
  agentPackageHost?.noteCreationTurn(sessionId, rawText)
}
