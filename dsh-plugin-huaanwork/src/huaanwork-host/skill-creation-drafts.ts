import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { SkillFieldError } from '../client-huaanwork/rpc-types.ts'
import { isCreationConsentText } from './creation-utterances.ts'
import {
  createSkillFromDraft,
  findSkillByCreationDraftId,
  takenNames,
  validateSkillFields,
} from './skills-host.ts'
import type { SkillInput } from './skills-host.ts'

/**
 * 对话创建技能的草稿、授权门禁与提交原语(设计 §6.3、§7、§8)。
 *
 * 一个会话只有一份草稿,写在 `{profileDir}/skill-creation-drafts/{sessionId}.json`,
 * 不放进 `skills/`。草稿不产生正式技能;提交必须晚于提出草稿的一轮、由完整
 * 同意句触发,并最终委托 `createSkillFromDraft` 在技能存储锁内完成权威校验与落盘。
 *
 * 与智能体创建流程双向互斥:本模块只读探测对方草稿是否存在,不导入
 * `agent-package/drafts.ts`,避免循环依赖。
 */

const DRAFTS_DIR = 'skill-creation-drafts'
const MAX_SESSION_ID_LENGTH = 128
const MAX_DRAFT_ID_LENGTH = 128
const SCHEMA_VERSION = 1 as const

export class CorruptSkillCreationDraftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptSkillCreationDraftError'
  }
}

export type SkillProposalInput = {
  name: string
  description: string
  whenToUse?: string
  body: string
}

export type SkillCreationDraft = {
  schemaVersion: typeof SCHEMA_VERSION
  draftId: string
  sessionId: string
  proposal: SkillProposalInput
  createdAt: string
  updatedAt: string
}

export type SkillProposeResult =
  | { ok: true; draftId: string; proposal: SkillProposalInput }
  | { ok: false; fieldErrors: SkillFieldError[] }

export type SkillCommitResult =
  | {
      ok: true
      draftId: string
      name: string
      alreadyCommitted: boolean
      card?: { name: string; description: string; whenToUse?: string; contentPreview: string }
    }
  | { ok: false; fieldErrors: SkillFieldError[] }

export type CommitTurnContext = {
  proposedThisTurn: boolean
  creationTurn: boolean
}

export type CancelOptions = { explicit?: boolean }

const draftDir = (profileDir: string) => join(profileDir, DRAFTS_DIR)
const draftPath = (profileDir: string, sessionId: string) => join(draftDir(profileDir), `${sessionId}.json`)

/** 与 `agent-package/drafts.ts` 的 `draftPath` 同路径(`{profileDir}/agents/.drafts/{sessionId}.json`)。 */
const agentDraftPath = (profileDir: string, sessionId: string) =>
  join(profileDir, 'agents', '.drafts', `${sessionId}.json`)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话 id 必须是单个路径段,与智能体草稿的约束一致。 */
function isValidSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string') return false
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return false
  if (sessionId === '.' || sessionId === '..') return false
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return false
  if (sessionId.includes('\0')) return false
  return basename(sessionId) === sessionId
}

function isValidDraftId(draftId: string): boolean {
  return typeof draftId === 'string' && draftId.length > 0 && draftId.length <= MAX_DRAFT_ID_LENGTH
}

function fieldError(field: string, message: string): { ok: false; fieldErrors: SkillFieldError[] } {
  return { ok: false, fieldErrors: [{ field, message }] }
}

/**
 * 智能体创建草稿的只读存在性检查。
 *
 * 路径固定为 `{profileDir}/agents/.drafts/{sessionId}.json`,与
 * `agent-package/drafts.ts` 的 `draftPath` 一致;任一路径变更必须同步另一处。
 * 这里不导入智能体草稿模块,避免形成循环依赖。只读存在性:损坏的智能体草稿
 * 也算「在场」,由路由的损坏检测分支处理。
 */
export function hasAgentCreationDraftOnDisk(profileDir: string, sessionId: string): boolean {
  if (!isValidSessionId(sessionId)) return false
  return existsSync(agentDraftPath(profileDir, sessionId))
}

/** 技能创建草稿的只读存在性检查;损坏草稿同样算「在场」,不得伪装成无草稿。 */
export function hasSkillCreationDraftOnDisk(profileDir: string, sessionId: string): boolean {
  if (!isValidSessionId(sessionId)) return false
  return existsSync(draftPath(profileDir, sessionId))
}

function toSkillInput(proposal: SkillProposalInput): SkillInput {
  return {
    name: proposal.name,
    description: proposal.description,
    ...(proposal.whenToUse !== undefined ? { whenToUse: proposal.whenToUse } : {}),
    content: proposal.body,
  }
}

/** 结构校验(类型层)。字段语义由 `validateSkillFields` 统一校验。 */
function parseProposal(raw: unknown): { ok: true; proposal: SkillProposalInput } | { ok: false; fieldErrors: SkillFieldError[] } {
  if (!isRecord(raw)) return fieldError('name', '技能提案必须是对象')
  const errors: SkillFieldError[] = []
  for (const field of ['name', 'description', 'body'] as const) {
    if (typeof raw[field] !== 'string') errors.push({ field, message: `${field} 必须是字符串` })
  }
  if (raw.whenToUse !== undefined && typeof raw.whenToUse !== 'string') {
    errors.push({ field: 'whenToUse', message: 'whenToUse 必须是字符串' })
  }
  if (errors.length > 0) return { ok: false, fieldErrors: errors }
  const proposal: SkillProposalInput = {
    name: raw.name as string,
    description: raw.description as string,
    ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string } : {}),
    body: raw.body as string,
  }
  return { ok: true, proposal }
}

function corruptDraft(path: string, reason: string): CorruptSkillCreationDraftError {
  return new CorruptSkillCreationDraftError(`技能创建草稿损坏(${reason}):${path}`)
}

function validateDraftDocument(rawInput: unknown, expectedSessionId: string, path: string): SkillCreationDraft {
  if (!isRecord(rawInput)) throw corruptDraft(path, '必须是 JSON 对象')
  const raw = rawInput
  if (raw.schemaVersion !== SCHEMA_VERSION) throw corruptDraft(path, 'schemaVersion 必须为 1')
  if (!isValidDraftId(raw.draftId as string)) throw corruptDraft(path, 'draftId 非法')
  if (!isValidSessionId(raw.sessionId as string)) throw corruptDraft(path, 'sessionId 非法')
  if (raw.sessionId !== expectedSessionId) throw corruptDraft(path, 'sessionId 与会话不匹配')
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) throw corruptDraft(path, 'createdAt 非法')
  if (typeof raw.updatedAt !== 'string' || raw.updatedAt.length === 0) throw corruptDraft(path, 'updatedAt 非法')
  const parsed = parseProposal(raw.proposal)
  if (!parsed.ok) {
    throw corruptDraft(path, parsed.fieldErrors.map((error) => `${error.field}:${error.message}`).join('；'))
  }
  const fieldErrors = validateSkillFields(toSkillInput(parsed.proposal), new Set())
  if (fieldErrors.length > 0) {
    throw corruptDraft(path, fieldErrors.map((error) => `${error.field}:${error.message}`).join('；'))
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    draftId: raw.draftId as string,
    sessionId: raw.sessionId as string,
    proposal: parsed.proposal,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  }
}

/**
 * 读取这一会话的草稿:缺失返回 `undefined`;损坏 JSON、错误 schemaVersion、
 * 跨会话或非法字段抛 `CorruptSkillCreationDraftError`,绝不把损坏解释成无草稿。
 */
export function loadSkillCreationDraft(profileDir: string, sessionId: string): SkillCreationDraft | undefined {
  if (!isValidSessionId(sessionId)) return undefined
  const path = draftPath(profileDir, sessionId)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CorruptSkillCreationDraftError(
      `技能创建草稿无法读取(${path}):${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CorruptSkillCreationDraftError(`技能创建草稿不是合法 JSON:${path}`)
  }
  return validateDraftDocument(parsed, sessionId, path)
}

/** 同目录 `.tmp` + rename:草稿替换对读者不可见。 */
async function writeSkillCreationDraft(profileDir: string, draft: SkillCreationDraft): Promise<void> {
  const target = draftPath(profileDir, draft.sessionId)
  const tmp = `${target}.tmp`
  await fs.mkdir(dirname(target), { recursive: true })
  try {
    await fs.writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 校验并覆盖这一会话的草稿。跨流程互斥检查先于任何写入:对方智能体草稿在场时
 * 直接拒绝,不覆盖已有技能草稿。成功使用新的 `randomUUID()` 使旧 draftId 失效。
 */
export async function proposeSkillCreation(
  profileDir: string,
  sessionId: string,
  input: SkillProposalInput,
): Promise<SkillProposeResult> {
  if (!isValidSessionId(sessionId)) return fieldError('sessionId', '会话 id 必须是单个路径段')
  if (hasAgentCreationDraftOnDisk(profileDir, sessionId)) {
    return fieldError('session', '当前会话存在智能体创建草稿，请先完成或取消智能体创建')
  }
  // 旧草稿只用于 fail-closed 探测:损坏必须抛 CorruptSkillCreationDraftError,不得被
  // 新 propose 静默覆盖(设计 §11);合法旧草稿仍照常被新 draftId 覆盖。
  loadSkillCreationDraft(profileDir, sessionId)
  const parsed = parseProposal(input)
  if (!parsed.ok) return parsed
  const errors = validateSkillFields(toSkillInput(parsed.proposal), await takenNames(profileDir))
  if (errors.length > 0) return { ok: false, fieldErrors: errors }

  const now = new Date().toISOString()
  const draft: SkillCreationDraft = {
    schemaVersion: SCHEMA_VERSION,
    draftId: randomUUID(),
    sessionId,
    proposal: parsed.proposal,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await writeSkillCreationDraft(profileDir, draft)
  } catch (error) {
    return fieldError(
      'session',
      `技能草稿无法写入:${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { ok: true, draftId: draft.draftId, proposal: draft.proposal }
}

function contentPreviewOf(body: string): string {
  return Array.from(body).slice(0, 500).join('')
}

/**
 * 提交草稿。门禁顺序本身就是授权约束:
 * 会话 → 创建/继续创建轮次且无对方智能体草稿 → 本轮未重新 propose →
 * 最近用户原句是完整同意句 → draftId 合法性 → 先查已提交凭证(支持草稿已删的
 * 正常重放,且跨会话不可重放) → 才要求活动草稿匹配 → 锁外重读并重校验字段 →
 * `createSkillFromDraft`(自行取存储锁;此处绝不能再包 `withSkillStorageLock`,
 * 锁非重入会死锁) → 成功后删除仍在场的同 ID 草稿。
 *
 * 任何首次写入失败都保留草稿;名称冲突不覆盖既有技能目录。
 */
export async function commitSkillCreation(
  profileDir: string,
  sessionId: string,
  draftId: string,
  rawUserText: string,
  context: CommitTurnContext,
): Promise<SkillCommitResult> {
  if (!isValidSessionId(sessionId)) return fieldError('sessionId', '会话 id 必须是单个路径段')
  if (context.creationTurn !== true) {
    return fieldError('consent', '当前轮次不是技能创建或继续创建，不能提交技能草稿')
  }
  if (hasAgentCreationDraftOnDisk(profileDir, sessionId)) {
    return fieldError('session', '当前会话存在智能体创建草稿，请先完成或取消智能体创建')
  }
  if (context.proposedThisTurn) {
    return fieldError('draftId', '本轮刚提出技能草稿，需等待用户下一条确认消息')
  }
  if (typeof rawUserText !== 'string' || !isCreationConsentText(rawUserText)) {
    return fieldError('consent', '需要用户明确整句同意（例如「确认」）后才能创建技能')
  }
  if (!isValidDraftId(draftId)) return fieldError('draftId', 'draftId 非法')

  // 凭证先于活动草稿检查:正常成功重放时草稿已被删除,仍须返回已提交结果;
  // 查询同时按 creationSessionId 限定,其他会话凭同一 draftId 无法重放。
  const credential = await findSkillByCreationDraftId(profileDir, draftId, sessionId)
  if (credential) {
    return { ok: true, draftId, name: credential.name, alreadyCommitted: true }
  }

  const active = loadSkillCreationDraft(profileDir, sessionId)
  if (!active || active.draftId !== draftId) {
    return fieldError('draftId', '技能草稿不存在或已被替换，请重新提出草稿')
  }

  // 锁外重读:活动草稿可能在两次读取之间被新 propose 替换。最终权威校验仍由
  // createSkillFromDraft 内的锁保证,这里提前失败只为不启动正式写入。
  const current = loadSkillCreationDraft(profileDir, sessionId)
  if (!current || current.draftId !== draftId) {
    return fieldError('draftId', '技能草稿不存在或已被替换，请重新提出草稿')
  }
  const input = toSkillInput(current.proposal)
  const errors = validateSkillFields(input, await takenNames(profileDir))
  if (errors.length > 0) return { ok: false, fieldErrors: errors }

  const created = await createSkillFromDraft(profileDir, input, draftId, sessionId)
  if (!created.ok) return created

  // 成功后清理仍在场的同 ID 草稿;新 propose 已替换的草稿不得误删。
  try {
    const remaining = loadSkillCreationDraft(profileDir, sessionId)
    if (remaining?.draftId === draftId) rmSync(draftPath(profileDir, sessionId), { force: true })
  } catch {
    // 落盘已经成功;草稿读取/清理失败留给下一次重放或显式取消处理,不能反向报告失败。
  }

  if (created.alreadyCommitted) {
    return { ok: true, draftId, name: created.name, alreadyCommitted: true }
  }
  return {
    ok: true,
    draftId,
    name: created.name,
    alreadyCommitted: false,
    card: {
      name: current.proposal.name,
      description: current.proposal.description,
      ...(current.proposal.whenToUse !== undefined ? { whenToUse: current.proposal.whenToUse } : {}),
      contentPreview: contentPreviewOf(current.proposal.body),
    },
  }
}

/**
 * 取消技能创建草稿。对方智能体草稿在场且未显式 `{explicit:true}` 时返回 `false`
 * 且不触碰任何文件;显式入口只删除本技能草稿,绝不级联清理对方。
 * 删除不存在的草稿是幂等成功(`true`)。
 */
export async function cancelSkillCreation(
  profileDir: string,
  sessionId: string,
  options?: CancelOptions,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false
  if (hasAgentCreationDraftOnDisk(profileDir, sessionId) && options?.explicit !== true) return false
  try {
    rmSync(draftPath(profileDir, sessionId), { force: true })
    return true
  } catch {
    return false
  }
}
