import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { AGENT_NAME_RE } from '@huaanwork/policy/agent-catalog'

import { parseSkillMarkdown } from '../../huaanwork-guardrails/skills.ts'
import { resolveInvocableSkill } from '../skill-invoke.ts'
import { parseAgentPackageManifest } from './manifest.ts'
import {
  agentPackageBytes,
  agentPackageDir,
  agentPackagesRoot,
  assertAgentPackageSlugFree,
  isAgentPackageScriptPath,
  listLocalAgentPackages,
  MAX_ENTRY_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PERSONA_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_SCRIPTS,
  MAX_SKILL_BYTES,
  readAgentPackage,
  readAgentPackageFile,
  readAgentPackageState,
  setAgentPackageEnabled,
  writeAgentPackageAtomically,
} from './store.ts'
import {
  AGENT_PACKAGE_SCHEMA_VERSION,
  type AgentPackageConfirmCard,
  type AgentPackageDetail,
  type AgentPackageManifest,
  type AgentPackageProposalInput,
  type AgentPackageToolsMode,
} from './types.ts'

/**
 * 智能体创建草稿与同意门禁(设计 §4.3、§5)。
 *
 * 一个会话只有一份草稿,写在 `{profileDir}/agents/.drafts/{sessionId}.json`;
 * `propose` 覆盖它,`commit` 只在用户原句是同意、`draftId` 对得上、且同一轮
 * 没有刚提出草稿时落盘。落盘复用 store 的原子写与 manifest 校验,新建默认
 * 关闭、更新保留启用态并 patch+1。
 */

const DRAFTS_DIR = '.drafts'

const MAX_SESSION_ID_LENGTH = 128
const MAX_SLUG_LENGTH = 32
const MAX_DISPLAY_NAME_LENGTH = 40
const MAX_DESCRIPTION_LENGTH = 200
const MAX_SUMMARY_LENGTH = 200
const MAX_DRAFT_ID_LENGTH = 128
/** 人设、整份 SKILL.md 与每个允许技能的正文合计上限。 */
const MAX_COMBINED_BODY_BYTES = 64 * 1024
const INITIAL_VERSION = '1.0.0'
/** 校验期 manifest 的时间戳占位:ISO 时间字节数固定,只用于估算整包大小。 */
const VALIDATION_TIMESTAMP = '1970-01-01T00:00:00.000Z'

const FORBIDDEN_ALLOW_SKILL = 'create-agent'
const CONSENT_PHRASES: ReadonlySet<string> = new Set(['可以', '确认', '同意', '就这样', '按这个建'])
const CANCEL_PHRASES: ReadonlySet<string> = new Set(['取消', '先不要'])
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['。', '！', '!', '？', '?'])

const TOOL_MODES: readonly AgentPackageToolsMode[] = ['none', 'http', 'mcp', 'both']
const TOOL_LABELS: Record<AgentPackageToolsMode, string> = {
  none: '不要',
  http: 'HTTP',
  mcp: 'MCP',
  both: 'HTTP 和 MCP',
}

const SANDBOX_WARNING = '脚本将在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。'
const CONSENT_HINT = '回复「可以」创建（默认关闭）；回复「取消」放弃。'
const NO_SKILL_SUMMARY = '无专属技能包'

export type AgentPackageFieldError = { field: string; message: string }

export type AgentPackageDraftSkill = {
  summary: string
  markdown: string
  scripts: Array<{ path: string; content: string }>
}

/** 一份待确认的创建/更新草稿;落盘前不会写入 `agents/{slug}/`。 */
export type AgentPackageDraft = {
  schemaVersion: typeof AGENT_PACKAGE_SCHEMA_VERSION
  draftId: string
  mode: 'create' | 'update'
  slug: string
  displayName: string
  description: string
  persona: string
  personaSummary: string
  skillSummary: string
  skill: AgentPackageDraftSkill | null
  allowSkills: string[]
  tools: AgentPackageToolsMode
  httpServer?: string
  mcpServer?: string
}

export type ProposeResult =
  | {
      ok: true
      draftId: string
      slug: string
      mode: 'create' | 'update'
      card: AgentPackageConfirmCard
      cardText: string
    }
  | { ok: false; fieldErrors: AgentPackageFieldError[] }

export type CommitResult =
  | {
      ok: true
      draftId: string
      slug: string
      packagePath: string
      card: AgentPackageConfirmCard
      cardText: string
      alreadyCommitted: boolean
      /**
       * 这次提交是新建还是更新,供成功文案区分「默认关闭」与「启用状态不变」。
       * 重复提交时草稿可能已被删除,无法还原原始模式,故可缺席。
       */
      mode?: 'create' | 'update'
    }
  | { ok: false; error: string; fieldErrors?: AgentPackageFieldError[] }

/** 同意说法:去首尾空白、去掉结尾一个 `。！!？?` 之后整句等于五种说法之一。 */
export function isAgentConsentText(text: string): boolean {
  return CONSENT_PHRASES.has(normalizeUtterance(text))
}

/** 取消说法:与同意同一套规范化,整句等于 `取消` 或 `先不要`。 */
export function isAgentCancelText(text: string): boolean {
  return CANCEL_PHRASES.has(normalizeUtterance(text))
}

/**
 * 校验并覆盖这一会话的草稿。
 *
 * `mode:'create'` 要求字段齐全;`mode:'update'` 以现有本地包为基底,只覆盖
 * 传入的字段。任一约束失败时不写包、返回逐字段错误,草稿保持不变。
 *
 * @param profileDir profile 数据目录(`agents/` 的上级)
 * @param sessionId 当前会话 id,必须是单个路径段
 * @param input 草稿字段;`mode:'update'` 时省略的字段沿用现有包
 * @param takenSlugs 已占用的本地入口/工具名,用于 slug 冲突检查
 * @returns 草稿 id 与宿主生成的确认单正文,或逐字段错误
 */
export async function proposeAgentPackage(
  profileDir: string,
  sessionId: string,
  input: AgentPackageProposalInput,
  takenSlugs: readonly string[],
): Promise<ProposeResult> {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, fieldErrors: [{ field: 'sessionId', message: '会话 id 必须是单个路径段' }] }
  }
  if (input.mode !== 'create' && input.mode !== 'update') {
    return { ok: false, fieldErrors: [{ field: 'mode', message: 'mode 必须是 create 或 update' }] }
  }

  const previous = loadAgentPackageDraft(profileDir, sessionId)
  const baseRead = resolveUpdateBase(profileDir, input, previous)
  if (baseRead.errors.length > 0) return { ok: false, fieldErrors: baseRead.errors }

  const draft: AgentPackageDraft = {
    schemaVersion: AGENT_PACKAGE_SCHEMA_VERSION,
    draftId: randomUUID(),
    mode: input.mode,
    ...mergeProposal(input, baseRead.base),
  }
  const fieldErrors = await validateDraft(profileDir, draft, takenSlugs)
  if (fieldErrors.length > 0) return { ok: false, fieldErrors }

  try {
    writeDraft(profileDir, sessionId, draft)
  } catch (error) {
    return {
      ok: false,
      fieldErrors: [{ field: 'session', message: `草稿无法写入:${errorMessage(error)}` }],
    }
  }

  const { card, cardText } = renderConfirmCard(draft)
  return { ok: true, draftId: draft.draftId, slug: draft.slug, mode: draft.mode, card, cardText }
}

/**
 * 核对原句是同意、`draftId` 对得上、同一轮没有刚提出草稿后落盘。
 *
 * 新建写 `enabled:false` 的状态;更新保留启用态并把 patch 版本加一。落盘成功
 * 后删除草稿;任何失败都保留草稿。相同 `draftId` 已落过盘时返回已有确认单,
 * 不覆盖包文件。
 *
 * @param profileDir profile 数据目录
 * @param sessionId 当前会话 id
 * @param draftId `propose` 返回的草稿 id
 * @param rawUserText 这一轮用户原句,必须是同意说法
 * @param takenSlugs 已占用的本地入口/工具名
 * @param opts `proposedThisTurn` 为真时拒绝(同一轮刚提出草稿)
 * @returns 落盘路径与确认单,或拒绝原因
 */
export async function commitAgentPackage(
  profileDir: string,
  sessionId: string,
  draftId: string,
  rawUserText: string,
  takenSlugs: readonly string[],
  opts?: { proposedThisTurn?: boolean },
): Promise<CommitResult> {
  if (!isValidSessionId(sessionId)) return refused('会话 id 必须是单个路径段')
  if (typeof rawUserText !== 'string' || !isAgentConsentText(rawUserText)) {
    return refused('用户原句不是同意创建的说法')
  }
  if (opts?.proposedThisTurn === true) {
    return refused('同一轮里刚提出草稿，不能立即提交；请等下一轮用户确认')
  }
  if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > MAX_DRAFT_ID_LENGTH) {
    return refused('draftId 无效')
  }

  const alreadyCommitted = findPackageByDraftId(profileDir, draftId)
  if (alreadyCommitted !== undefined) {
    const stale = loadAgentPackageDraft(profileDir, sessionId)
    if (stale?.draftId === draftId) removeDraft(profileDir, sessionId)
    const card = cardForStoredPackage(alreadyCommitted.manifest, alreadyCommitted.detail)
    return {
      ok: true,
      draftId,
      slug: alreadyCommitted.slug,
      packagePath: agentPackageDir(profileDir, alreadyCommitted.slug),
      card,
      cardText: renderCardText(card),
      alreadyCommitted: true,
      ...(stale?.draftId === draftId ? { mode: stale.mode } : {}),
    }
  }

  const draft = loadAgentPackageDraft(profileDir, sessionId)
  if (draft === undefined) return refused('没有待确认的草稿')
  if (draft.draftId !== draftId) return refused('draftId 与当前草稿不匹配，草稿未落盘')

  const fieldErrors = await validateDraft(profileDir, draft, takenSlugs)
  if (fieldErrors.length > 0) {
    return {
      ok: false,
      error: `草稿校验失败:${fieldErrors.map((error) => `${error.field}: ${error.message}`).join('；')}`,
      fieldErrors,
    }
  }

  const now = new Date().toISOString()
  const existing = draft.mode === 'update' ? readOnDiskManifest(profileDir, draft.slug) : undefined
  if (draft.mode === 'update' && existing === undefined) {
    return refused(`要更新的智能体 @${draft.slug} 不存在，草稿保留`)
  }

  const manifest = buildManifest(draft, existing, now)

  try {
    writeAgentPackageAtomically({
      profileDir,
      manifest,
      persona: draft.persona,
      skill: draft.skill === null ? null : { markdown: draft.skill.markdown, scripts: draft.skill.scripts },
      ...(draft.httpServer === undefined ? {} : { httpServer: draft.httpServer }),
      ...(draft.mcpServer === undefined ? {} : { mcpServer: draft.mcpServer }),
      replace: draft.mode === 'update',
    })
  } catch (error) {
    return refused(`写入智能体 @${draft.slug} 失败:${errorMessage(error)}`)
  }

  // 更新保留原来的启用态;新建写关闭。
  const enabled =
    existing !== undefined && readAgentPackageState(profileDir)[`local:${draft.slug}`]?.enabled === true
  try {
    setAgentPackageEnabled(profileDir, draft.slug, enabled)
  } catch (error) {
    return refused(`写入启用状态失败:${errorMessage(error)}`)
  }

  removeDraft(profileDir, sessionId)
  const { card, cardText } = renderConfirmCard(draft)
  return {
    ok: true,
    draftId: draft.draftId,
    slug: draft.slug,
    packagePath: agentPackageDir(profileDir, draft.slug),
    card,
    cardText,
    alreadyCommitted: false,
    mode: draft.mode,
  }
}

/**
 * 丢弃这一会话的草稿。
 *
 * @param profileDir profile 数据目录
 * @param sessionId 当前会话 id
 * @returns 之前是否存在草稿
 */
export async function cancelAgentPackage(profileDir: string, sessionId: string): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false
  const target = draftPath(profileDir, sessionId)
  if (!existsSync(target)) return false
  try {
    rmSync(target, { force: true })
    return true
  } catch {
    // 删除失败与「本来就没有草稿」同回 false:残留草稿由下一次 propose 覆盖,
    // commit 仍会用自己的 draftId 校验兜底。
    return false
  }
}

/**
 * 读取这一会话的草稿;文件缺失、损坏或 `sessionId` 非法时返回 undefined。
 *
 * @param profileDir profile 数据目录
 * @param sessionId 当前会话 id
 * @returns 已校验的草稿
 */
export function loadAgentPackageDraft(profileDir: string, sessionId: string): AgentPackageDraft | undefined {
  if (!isValidSessionId(sessionId)) return undefined
  let text: string
  try {
    text = readFileSync(draftPath(profileDir, sessionId), 'utf8')
  } catch {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  return parseDraft(raw)
}

/**
 * 以现有本地包为基底写一份 `mode:'update'` 草稿,供后续只提交变化字段。
 *
 * @param profileDir profile 数据目录
 * @param sessionId 当前会话 id
 * @param slug 要更新的本地包
 *
 * @throws 会话 id 非法、包不存在或已损坏
 */
export async function beginAgentPackageUpdate(
  profileDir: string,
  sessionId: string,
  slug: string,
): Promise<void> {
  if (!isValidSessionId(sessionId)) throw new Error('会话 id 必须是单个路径段')
  if (!isValidSlug(slug)) throw new Error(`智能体 @标识「${slug}」无效`)
  const base = readUpdateBase(profileDir, slug)
  const draft: AgentPackageDraft = {
    schemaVersion: AGENT_PACKAGE_SCHEMA_VERSION,
    draftId: randomUUID(),
    mode: 'update',
    ...base,
  }
  writeDraft(profileDir, sessionId, draft)
}

type DraftBody = Omit<AgentPackageDraft, 'schemaVersion' | 'draftId' | 'mode'>

function resolveUpdateBase(
  profileDir: string,
  input: AgentPackageProposalInput,
  previous: AgentPackageDraft | undefined,
): { base?: DraftBody; errors: AgentPackageFieldError[] } {
  if (input.mode !== 'update') return { errors: [] }

  const requested = normalizeSlug(input.slug)
  const priorSlug = previous?.mode === 'update' ? previous.slug : undefined
  if (requested !== undefined && priorSlug !== undefined && requested !== priorSlug) {
    return { errors: [{ field: 'slug', message: '更新时不能修改 @标识，请换一个会话新建' }] }
  }
  const slug = requested ?? priorSlug
  if (slug === undefined) {
    return { errors: [{ field: 'slug', message: '更新时必须提供要更新的 @标识' }] }
  }
  try {
    return { base: readUpdateBase(profileDir, slug), errors: [] }
  } catch (error) {
    return { errors: [{ field: 'slug', message: errorMessage(error) }] }
  }
}

function readUpdateBase(profileDir: string, slug: string): DraftBody {
  const detail = readAgentPackage(profileDir, slug)
  if (detail === undefined) throw new Error(`智能体 @${slug} 不存在`)
  if (detail.broken !== undefined) throw new Error(`智能体 @${slug} 已损坏:${detail.broken.reason}`)
  const manifest = readOnDiskManifest(profileDir, slug)
  if (manifest === undefined) throw new Error(`智能体 @${slug} 的 agent.json 不可读`)

  const persona = readAgentPackageFile(profileDir, slug, 'persona.md')
  if (persona === undefined) throw new Error(`智能体 @${slug} 缺少 persona.md`)

  let skill: AgentPackageDraftSkill | null = null
  if (manifest.skill !== null) {
    const markdown = readAgentPackageFile(profileDir, slug, 'skill/SKILL.md')
    if (markdown === undefined) throw new Error(`智能体 @${slug} 缺少 skill/SKILL.md`)
    const scripts: Array<{ path: string; content: string }> = []
    for (const scriptPath of detail.skill?.scripts ?? []) {
      const content = readAgentPackageFile(profileDir, slug, scriptPath)
      if (content === undefined) throw new Error(`智能体 @${slug} 的技能脚本不可读:${scriptPath}`)
      scripts.push({ path: scriptPath, content })
    }
    skill = { summary: manifest.skill.summary, markdown, scripts }
  }

  const mode = manifest.tools.mode
  const httpServer = readEntryText(profileDir, slug, mode === 'http' || mode === 'both', 'tools/http/server.mjs')
  const mcpServer = readEntryText(profileDir, slug, mode === 'mcp' || mode === 'both', 'tools/mcp/server.mjs')

  return {
    slug: manifest.slug,
    displayName: manifest.displayName,
    description: manifest.description,
    persona,
    personaSummary: deriveSummary(persona),
    skillSummary: manifest.skill?.summary ?? NO_SKILL_SUMMARY,
    skill,
    allowSkills: manifest.allowSkills,
    tools: mode,
    ...(httpServer === undefined ? {} : { httpServer }),
    ...(mcpServer === undefined ? {} : { mcpServer }),
  }
}

function readEntryText(
  profileDir: string,
  slug: string,
  wanted: boolean,
  relativePath: string,
): string | undefined {
  if (!wanted) return undefined
  const content = readAgentPackageFile(profileDir, slug, relativePath)
  if (content === undefined) throw new Error(`智能体 @${slug} 缺少 ${relativePath}`)
  return content
}

function mergeProposal(input: AgentPackageProposalInput, base: DraftBody | undefined): DraftBody {
  const slug = base?.slug ?? normalizeSlug(input.slug) ?? ''
  const displayName = (input.displayName ?? base?.displayName ?? '').trim()
  const description = (input.description ?? base?.description ?? '').trim()
  const persona = input.persona ?? base?.persona ?? ''
  const tools = input.tools ?? base?.tools ?? 'none'
  const wantsHttp = tools === 'http' || tools === 'both'
  const wantsMcp = tools === 'mcp' || tools === 'both'

  let skill: AgentPackageDraftSkill | null
  if (input.skill === undefined) skill = base?.skill ?? null
  else if (input.skill === null) skill = null
  else {
    skill = {
      summary: input.skill.summary.trim(),
      markdown: input.skill.markdown,
      scripts: input.skill.scripts.map((script) => ({ path: script.path, content: script.content })),
    }
  }

  const httpServer = input.httpServer ?? (wantsHttp ? base?.httpServer : undefined)
  const mcpServer = input.mcpServer ?? (wantsMcp ? base?.mcpServer : undefined)

  const personaSummary = pickSummary(
    input.personaSummary,
    input.persona === undefined && base !== undefined ? base.personaSummary : undefined,
    () => deriveSummary(persona),
  )
  const skillSummary = pickSummary(
    input.skillSummary,
    input.skill === undefined && base !== undefined ? base.skillSummary : undefined,
    () => (skill === null ? NO_SKILL_SUMMARY : deriveSkillSummary(skill.markdown) || NO_SKILL_SUMMARY),
  )

  const allowSkills = (input.allowSkills ?? base?.allowSkills ?? []).map((name) => name.trim())

  return {
    slug,
    displayName,
    description,
    persona,
    personaSummary,
    skillSummary,
    skill,
    allowSkills: [...new Set(allowSkills)],
    tools,
    ...(httpServer === undefined ? {} : { httpServer }),
    ...(mcpServer === undefined ? {} : { mcpServer }),
  }
}

function pickSummary(
  provided: string | undefined,
  carried: string | undefined,
  derive: () => string,
): string {
  const explicit = provided?.trim()
  if (explicit) return explicit
  const previous = carried?.trim()
  if (previous) return previous
  return derive()
}

/** 由草稿生成落盘 manifest;校验期也用它估算整包字节,两条路径不会各建一份。 */
function buildManifest(
  draft: AgentPackageDraft,
  existing: AgentPackageManifest | undefined,
  now: string,
): AgentPackageManifest {
  return {
    schemaVersion: AGENT_PACKAGE_SCHEMA_VERSION,
    slug: draft.slug,
    displayName: draft.displayName,
    description: draft.description,
    version: existing === undefined ? INITIAL_VERSION : bumpPatch(existing.version),
    draftId: draft.draftId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    persona: 'persona.md',
    skill: draft.skill === null ? null : { entry: 'skill/SKILL.md', summary: manifestSkillSummary(draft) },
    tools: buildToolsEntry(draft),
    allowSkills: draft.allowSkills,
  }
}

async function validateDraft(
  profileDir: string,
  draft: AgentPackageDraft,
  takenSlugs: readonly string[],
): Promise<AgentPackageFieldError[]> {
  const errors: AgentPackageFieldError[] = []

  if (!isValidSlug(draft.slug)) {
    errors.push({
      field: 'slug',
      message: `@标识必须匹配 ${AGENT_NAME_RE.source} 且长度为 1-${MAX_SLUG_LENGTH}`,
    })
  }
  if (draft.displayName.length === 0 || draft.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    errors.push({
      field: 'displayName',
      message: `显示名去首尾空白后必须是 1-${MAX_DISPLAY_NAME_LENGTH} 个字符`,
    })
  }
  if (draft.description.length === 0 || draft.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      field: 'description',
      message: `能力简介去首尾空白后必须是 1-${MAX_DESCRIPTION_LENGTH} 个字符`,
    })
  }
  if (!draft.persona.trim()) {
    errors.push({ field: 'persona', message: '人设正文不能为空' })
  } else if (utf8Length(draft.persona) > MAX_PERSONA_BYTES) {
    errors.push({ field: 'persona', message: `人设正文不得超过 ${MAX_PERSONA_BYTES / 1024} KiB` })
  }
  if (draft.personaSummary.length === 0 || draft.personaSummary.length > MAX_SUMMARY_LENGTH) {
    errors.push({ field: 'personaSummary', message: `人设要点必须是 1-${MAX_SUMMARY_LENGTH} 个字符` })
  }
  if (draft.skillSummary.length === 0 || draft.skillSummary.length > MAX_SUMMARY_LENGTH) {
    errors.push({ field: 'skillSummary', message: `技能包要点必须是 1-${MAX_SUMMARY_LENGTH} 个字符` })
  }

  let skillMarkdown = ''
  if (draft.skill !== null) {
    errors.push(...validateSkill(draft.slug, draft.skill))
    skillMarkdown = draft.skill.markdown
  }

  if (!TOOL_MODES.includes(draft.tools)) {
    errors.push({ field: 'tools', message: '工具必须选择 none / http / mcp / both' })
  }
  validateEntry('httpServer', draft.tools === 'http' || draft.tools === 'both', draft.httpServer, errors)
  validateEntry('mcpServer', draft.tools === 'mcp' || draft.tools === 'both', draft.mcpServer, errors)

  const allowErrors = await collectAllowSkillBodies(profileDir, draft.allowSkills)
  errors.push(...allowErrors.errors)
  if (errors.length === 0) {
    // 整份 SKILL.md(含 frontmatter)计入上限,与落盘的文件大小约束一致。
    const combined =
      utf8Length(draft.persona) +
      utf8Length(skillMarkdown) +
      allowErrors.bodies.reduce((total, body) => total + utf8Length(body), 0)
    if (combined > MAX_COMBINED_BODY_BYTES) {
      errors.push({
        field: 'skill',
        message: `人设、整份 SKILL.md 与允许技能的正文合计不得超过 ${MAX_COMBINED_BODY_BYTES / 1024} KiB(当前 ${combined} 字节)`,
      })
    }
  }
  if (errors.length === 0) {
    // 与写入路径共用同一字节合计:propose 不能放行 commit 永远写不出的草稿。
    const existing = draft.mode === 'update' ? readOnDiskManifest(profileDir, draft.slug) : undefined
    const packageBytes = agentPackageBytes({
      manifest: buildManifest(draft, existing, VALIDATION_TIMESTAMP),
      persona: draft.persona,
      skill: draft.skill,
      ...(draft.httpServer === undefined ? {} : { httpServer: draft.httpServer }),
      ...(draft.mcpServer === undefined ? {} : { mcpServer: draft.mcpServer }),
    })
    if (packageBytes > MAX_PACKAGE_BYTES) {
      errors.push({
        field: 'package',
        message: `整包(manifest、人设、技能、脚本与工具入口)不得超过 ${MAX_PACKAGE_BYTES / (1024 * 1024)} MiB(当前 ${packageBytes} 字节)`,
      })
    }
  }

  if (draft.mode === 'create') {
    // slug 格式错误已单独报出;这里只回答「是否重名/已存在」。更新模式沿用 base.slug,不会撞名。
    if (isValidSlug(draft.slug)) {
      try {
        assertAgentPackageSlugFree(profileDir, draft.slug, takenSlugs)
      } catch (error) {
        errors.push({ field: 'slug', message: errorMessage(error) })
      }
    }
  }

  return errors
}

function validateSkill(slug: string, skill: AgentPackageDraftSkill): AgentPackageFieldError[] {
  const errors: AgentPackageFieldError[] = []
  if (!skill.markdown.trim()) {
    errors.push({ field: 'skill.markdown', message: 'SKILL.md 不能为空' })
    return errors
  }
  if (utf8Length(skill.markdown) > MAX_SKILL_BYTES) {
    errors.push({ field: 'skill.markdown', message: `SKILL.md 不得超过 ${MAX_SKILL_BYTES / 1024} KiB` })
  }
  const frontmatterName = parseSkillMarkdown(skill.markdown).name
  if (frontmatterName !== slug) {
    errors.push({
      field: 'skill.name',
      message: `SKILL.md frontmatter 的 name(${frontmatterName || '空'})必须等于 @标识 ${slug}`,
    })
  }
  if (skill.summary.length > MAX_SUMMARY_LENGTH) {
    errors.push({ field: 'skill.summary', message: `技能要点不得超过 ${MAX_SUMMARY_LENGTH} 个字符` })
  }
  if (skill.scripts.length > MAX_SCRIPTS) {
    errors.push({ field: 'skill.scripts', message: `技能脚本最多 ${MAX_SCRIPTS} 个` })
  }
  const seenPaths = new Set<string>()
  skill.scripts.forEach((script, index) => {
    const field = `skill.scripts[${index}]`
    if (!isAgentPackageScriptPath(script.path)) {
      errors.push({ field, message: `技能脚本必须位于 skill/scripts/ 下且不得包含 . 或 .. 段:${script.path}` })
      return
    }
    if (seenPaths.has(script.path.toLowerCase())) {
      errors.push({ field, message: `重复的技能脚本路径:${script.path}` })
      return
    }
    seenPaths.add(script.path.toLowerCase())
    if (utf8Length(script.content) > MAX_SCRIPT_BYTES) {
      errors.push({ field, message: `技能脚本 ${script.path} 超过 ${MAX_SCRIPT_BYTES / 1024} KiB` })
    }
  })
  return errors
}

function validateEntry(
  field: 'httpServer' | 'mcpServer',
  wanted: boolean,
  content: string | undefined,
  errors: AgentPackageFieldError[],
): void {
  if (!wanted) {
    if (content !== undefined) {
      errors.push({ field, message: `未选择${field === 'httpServer' ? ' HTTP' : ' MCP'} 时不得提供 ${field}` })
    }
    return
  }
  if (content === undefined || !content.trim()) {
    errors.push({ field, message: `选择${field === 'httpServer' ? ' HTTP' : ' MCP'} 时必须提供入口文件内容` })
    return
  }
  if (utf8Length(content) > MAX_ENTRY_BYTES) {
    errors.push({ field, message: `${field} 不得超过 ${MAX_ENTRY_BYTES / 1024} KiB` })
  }
}

async function collectAllowSkillBodies(
  profileDir: string,
  names: readonly string[],
): Promise<{ bodies: string[]; errors: AgentPackageFieldError[] }> {
  const bodies: string[] = []
  const errors: AgentPackageFieldError[] = []
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index] ?? ''
    const field = `allowSkills[${index}]`
    if (!name) {
      errors.push({ field, message: '技能名不能为空' })
      continue
    }
    if (name === FORBIDDEN_ALLOW_SKILL) {
      errors.push({ field, message: `${FORBIDDEN_ALLOW_SKILL} 不能放进允许技能` })
      continue
    }
    try {
      const resolved = await resolveInvocableSkill(profileDir, name)
      bodies.push(resolved.skill.content)
    } catch (error) {
      errors.push({ field, message: errorMessage(error) })
    }
  }
  return { bodies, errors }
}

function buildToolsEntry(draft: AgentPackageDraft): AgentPackageManifest['tools'] {
  const wantsHttp = draft.tools === 'http' || draft.tools === 'both'
  const wantsMcp = draft.tools === 'mcp' || draft.tools === 'both'
  return {
    mode: draft.tools,
    ...(wantsHttp ? { http: { entry: 'tools/http/server.mjs' as const } } : {}),
    ...(wantsMcp ? { mcp: { entry: 'tools/mcp/server.mjs' as const } } : {}),
  }
}

function manifestSkillSummary(draft: AgentPackageDraft): string {
  const candidates = [
    draft.skill?.summary ?? '',
    draft.skillSummary,
    draft.skill === null ? '' : deriveSkillSummary(draft.skill.markdown),
  ]
  return candidates.map((candidate) => candidate.trim()).find((candidate) => candidate.length > 0) ?? NO_SKILL_SUMMARY
}

function renderConfirmCard(draft: AgentPackageDraft): {
  card: AgentPackageConfirmCard
  cardText: string
} {
  const card: AgentPackageConfirmCard = {
    displayName: draft.displayName,
    slug: draft.slug,
    description: draft.description,
    personaSummary: draft.personaSummary,
    skillSummary: draft.skillSummary,
    tools: draft.tools,
    toolLabel: TOOL_LABELS[draft.tools],
    warning: SANDBOX_WARNING,
    consentHint: CONSENT_HINT,
  }
  return { card, cardText: renderCardText(card) }
}

function renderCardText(card: AgentPackageConfirmCard): string {
  return [
    '请确认是否创建这名智能体：',
    `显示名：${card.displayName}`,
    `@标识：${card.slug}`,
    `能力简介：${card.description}`,
    `人设要点：${card.personaSummary}`,
    `技能包：${card.skillSummary}`,
    `工具：${card.toolLabel}`,
    card.warning,
    card.consentHint,
  ].join('\n')
}

function cardForStoredPackage(
  manifest: AgentPackageManifest,
  detail: AgentPackageDetail | undefined,
): AgentPackageConfirmCard {
  return {
    displayName: manifest.displayName,
    slug: manifest.slug,
    description: manifest.description,
    personaSummary: deriveSummary(detail?.persona ?? ''),
    skillSummary: manifest.skill?.summary ?? NO_SKILL_SUMMARY,
    tools: manifest.tools.mode,
    toolLabel: TOOL_LABELS[manifest.tools.mode],
    warning: SANDBOX_WARNING,
    consentHint: CONSENT_HINT,
  }
}

function findPackageByDraftId(
  profileDir: string,
  draftId: string,
): { slug: string; manifest: AgentPackageManifest; detail: AgentPackageDetail | undefined } | undefined {
  for (const item of listLocalAgentPackages(profileDir)) {
    const manifest = readOnDiskManifest(profileDir, item.slug)
    if (manifest?.draftId !== draftId) continue
    return { slug: manifest.slug, manifest, detail: readAgentPackage(profileDir, manifest.slug) }
  }
  return undefined
}

function readOnDiskManifest(profileDir: string, slug: string): AgentPackageManifest | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(agentPackageDir(profileDir, slug), 'agent.json'), 'utf8'))
  } catch {
    return undefined
  }
  const parsed = parseAgentPackageManifest(raw)
  return parsed.ok ? parsed.manifest : undefined
}

function writeDraft(profileDir: string, sessionId: string, draft: AgentPackageDraft): void {
  const target = draftPath(profileDir, sessionId)
  const temp = `${target}.tmp`
  mkdirSync(join(agentPackagesRoot(profileDir), DRAFTS_DIR), { recursive: true })
  try {
    writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    removeQuietly(temp)
    throw error
  }
}

function removeDraft(profileDir: string, sessionId: string): void {
  try {
    rmSync(draftPath(profileDir, sessionId), { force: true })
  } catch {
    // 草稿删除失败不影响已落盘的包;下一次 propose 会覆盖它。
  }
}

function draftPath(profileDir: string, sessionId: string): string {
  return join(agentPackagesRoot(profileDir), DRAFTS_DIR, `${sessionId}.json`)
}

function parseDraft(raw: unknown): AgentPackageDraft | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== AGENT_PACKAGE_SCHEMA_VERSION) return undefined
  const draftId = raw.draftId
  const mode = raw.mode
  const slug = raw.slug
  const displayName = raw.displayName
  const description = raw.description
  const persona = raw.persona
  const personaSummary = raw.personaSummary
  const skillSummary = raw.skillSummary
  const tools = raw.tools
  const allowSkills = raw.allowSkills
  const httpServer = raw.httpServer
  const mcpServer = raw.mcpServer

  if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > MAX_DRAFT_ID_LENGTH) return undefined
  if (mode !== 'create' && mode !== 'update') return undefined
  if (typeof slug !== 'string') return undefined
  for (const value of [displayName, description, persona, personaSummary, skillSummary]) {
    if (typeof value !== 'string') return undefined
  }
  if (typeof tools !== 'string' || !TOOL_MODES.includes(tools as AgentPackageToolsMode)) return undefined
  if (!Array.isArray(allowSkills) || allowSkills.some((name) => typeof name !== 'string')) return undefined
  if (httpServer !== undefined && typeof httpServer !== 'string') return undefined
  if (mcpServer !== undefined && typeof mcpServer !== 'string') return undefined

  let skill: AgentPackageDraftSkill | null = null
  if (raw.skill !== null) {
    const rawSkill: unknown = raw.skill
    if (!isRecord(rawSkill)) return undefined
    const summary = rawSkill.summary
    const markdown = rawSkill.markdown
    const scripts = rawSkill.scripts
    if (typeof summary !== 'string' || typeof markdown !== 'string' || !Array.isArray(scripts)) return undefined
    const parsedScripts: Array<{ path: string; content: string }> = []
    for (const script of scripts) {
      if (!isRecord(script) || typeof script.path !== 'string' || typeof script.content !== 'string') {
        return undefined
      }
      parsedScripts.push({ path: script.path, content: script.content })
    }
    skill = { summary, markdown, scripts: parsedScripts }
  }

  return {
    schemaVersion: AGENT_PACKAGE_SCHEMA_VERSION,
    draftId,
    mode,
    slug,
    displayName: displayName as string,
    description: description as string,
    persona: persona as string,
    personaSummary: personaSummary as string,
    skillSummary: skillSummary as string,
    skill,
    allowSkills: allowSkills as string[],
    tools: tools as AgentPackageToolsMode,
    ...(typeof httpServer === 'string' ? { httpServer } : {}),
    ...(typeof mcpServer === 'string' ? { mcpServer } : {}),
  }
}

function isValidSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string') return false
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) return false
  if (sessionId === '.' || sessionId === '..') return false
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) return false
  if (sessionId.includes('\0')) return false
  return basename(sessionId) === sessionId
}

function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && AGENT_NAME_RE.test(slug)
}

function normalizeSlug(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function normalizeUtterance(text: string): string {
  const trimmed = text.trim()
  const last = trimmed.at(-1)
  if (last === undefined || !TRAILING_PUNCTUATION.has(last)) return trimmed
  return trimmed.slice(0, -1)
}

function deriveSummary(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  return truncate(line ?? '', MAX_SUMMARY_LENGTH)
}

function deriveSkillSummary(markdown: string): string {
  const parsed = parseSkillMarkdown(markdown)
  const description = parsed.description.trim()
  return truncate(description || deriveSummary(parsed.content), MAX_SUMMARY_LENGTH)
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text
}

function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return INITIAL_VERSION
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`
}

function refused(error: string): CommitResult {
  return { ok: false, error }
}

function removeQuietly(target: string): void {
  try {
    rmSync(target, { force: true })
  } catch {
    // 尽力而为;残留的 .tmp 不影响草稿读取。
  }
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
