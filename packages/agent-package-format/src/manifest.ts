import { AGENT_NAME_RE } from '@huaanwork/policy/agent-catalog'

export const AGENT_PACKAGE_SCHEMA_VERSION = 1 as const

export type AgentPackageToolsMode = 'none' | 'http' | 'mcp' | 'both'

export type AgentPackageManifest = {
  schemaVersion: typeof AGENT_PACKAGE_SCHEMA_VERSION
  slug: string
  displayName: string
  description: string
  version: string
  draftId: string
  createdAt: string
  updatedAt: string
  persona: 'persona.md'
  skill: { entry: 'skill/SKILL.md'; summary: string } | null
  tools: {
    mode: AgentPackageToolsMode
    http?: { entry: 'tools/http/server.mjs'; argumentsSchema?: unknown }
    mcp?: { entry: 'tools/mcp/server.mjs' }
  }
  allowSkills: string[]
}

type FieldError = { field: string; message: string }

const MAX_SLUG_LENGTH = 32
const MAX_DISPLAY_NAME_LENGTH = 40
const MAX_DESCRIPTION_LENGTH = 200
const MAX_SKILL_SUMMARY_LENGTH = 200
const MAX_DRAFT_ID_LENGTH = 128
const MAX_ARGUMENTS_SCHEMA_LENGTH = 1024

// semver.org 的官方正则;本地包版本由宿主维护,不接受范围写法。
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

const MANIFEST_KEYS = [
  'schemaVersion',
  'slug',
  'displayName',
  'description',
  'version',
  'draftId',
  'createdAt',
  'updatedAt',
  'persona',
  'skill',
  'tools',
  'allowSkills',
] as const
const SKILL_KEYS = ['entry', 'summary'] as const
const TOOLS_KEYS = ['mode', 'http', 'mcp'] as const
const HTTP_KEYS = ['entry', 'argumentsSchema'] as const
const MCP_KEYS = ['entry'] as const

/**
 * 解析并校验 `agent.json`。
 *
 * 不信任磁盘内容:未知字段、类型不符、超长、`tools.mode` 与入口不一致都拒绝;
 * 错误按字段收集,供创建流程逐项回问。`displayName`/`description`/`skill.summary`
 * 去首尾空白后存储。返回的 manifest 只含已声明字段。
 */
export function parseAgentPackageManifest(
  raw: unknown,
): { ok: true; manifest: AgentPackageManifest } | { ok: false; fieldErrors: FieldError[] } {
  if (!isRecord(raw)) {
    return { ok: false, fieldErrors: [{ field: 'manifest', message: 'manifest 必须是 JSON 对象' }] }
  }

  const errors: FieldError[] = []
  rejectUnknownKeys(raw, MANIFEST_KEYS, 'manifest', errors)

  if (raw.schemaVersion !== AGENT_PACKAGE_SCHEMA_VERSION) {
    errors.push({ field: 'schemaVersion', message: 'schemaVersion 必须为 1' })
  }

  const slug = typeof raw.slug === 'string' ? raw.slug : ''
  if (!AGENT_NAME_RE.test(slug) || slug.length > MAX_SLUG_LENGTH) {
    errors.push({
      field: 'slug',
      message: `slug 必须匹配 ${AGENT_NAME_RE.source} 且长度为 1-${MAX_SLUG_LENGTH}`,
    })
  }

  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : ''
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    errors.push({
      field: 'displayName',
      message: `displayName 去首尾空白后必须是 1-${MAX_DISPLAY_NAME_LENGTH} 个 UTF-16 码元`,
    })
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      field: 'description',
      message: `description 去首尾空白后必须是 1-${MAX_DESCRIPTION_LENGTH} 个 UTF-16 码元`,
    })
  }

  const version = typeof raw.version === 'string' ? raw.version : ''
  if (!SEMVER_RE.test(version)) {
    errors.push({ field: 'version', message: 'version 必须是 semver(如 1.0.0)' })
  }

  const draftId = typeof raw.draftId === 'string' ? raw.draftId : ''
  if (!draftId.trim() || draftId.length > MAX_DRAFT_ID_LENGTH) {
    errors.push({ field: 'draftId', message: `draftId 必须是非空字符串且不超过 ${MAX_DRAFT_ID_LENGTH} 个字符` })
  }

  for (const field of ['createdAt', 'updatedAt'] as const) {
    const value = raw[field]
    if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
      errors.push({ field, message: `${field} 必须是 ISO 时间(如 2026-10-23T00:00:00.000Z)` })
    }
  }

  if (raw.persona !== 'persona.md') {
    errors.push({ field: 'persona', message: 'persona 必须固定为 persona.md' })
  }

  let skill: AgentPackageManifest['skill'] = null
  let skillSummary = ''
  if (raw.skill !== null) {
    if (!isRecord(raw.skill)) {
      errors.push({ field: 'skill', message: 'skill 必须是对象或 null' })
    } else {
      rejectUnknownKeys(raw.skill, SKILL_KEYS, 'skill', errors)
      if (raw.skill.entry !== 'skill/SKILL.md') {
        errors.push({ field: 'skill.entry', message: 'skill.entry 必须固定为 skill/SKILL.md' })
      }
      skillSummary = typeof raw.skill.summary === 'string' ? raw.skill.summary.trim() : ''
      if (!skillSummary || skillSummary.length > MAX_SKILL_SUMMARY_LENGTH) {
        errors.push({
          field: 'skill.summary',
          message: `skill.summary 去首尾空白后必须是 1-${MAX_SKILL_SUMMARY_LENGTH} 个 UTF-16 码元`,
        })
      }
      skill = { entry: 'skill/SKILL.md', summary: skillSummary }
    }
  }

  const tools = parseTools(raw.tools, errors)

  const allowSkills: string[] = []
  if (!Array.isArray(raw.allowSkills)) {
    errors.push({ field: 'allowSkills', message: 'allowSkills 必须是字符串数组' })
  } else {
    raw.allowSkills.forEach((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        errors.push({ field: `allowSkills[${index}]`, message: 'allowSkills 的每一项必须是非空技能名' })
        return
      }
      allowSkills.push(item.trim())
    })
  }

  if (errors.length > 0) {
    return { ok: false, fieldErrors: errors }
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: AGENT_PACKAGE_SCHEMA_VERSION,
      slug,
      displayName,
      description,
      version,
      draftId,
      createdAt: raw.createdAt as string,
      updatedAt: raw.updatedAt as string,
      persona: 'persona.md',
      skill,
      tools,
      allowSkills,
    },
  }
}

/**
 * 按 semver 优先级比较两个包版本(更新检查用)。
 *
 * major/minor/patch 按数值比较;prerelease 依 semver.org §11.4 逐段比较
 * (数值段按数值、字母数字段按 ASCII、数值段低于字母数字段、段数少者更低);
 * build metadata 不参与先后。非法版本号直接抛错,避免把损坏的包当成可升级。
 */
export function compareAgentPackageVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a)
  const right = parseSemver(b)
  for (const field of ['major', 'minor', 'patch'] as const) {
    const result = compareNumericIdentifier(left[field], right[field])
    if (result !== 0) return result
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

type SemverParts = {
  major: string
  minor: string
  patch: string
  prerelease: string | undefined
}

function parseSemver(version: string): SemverParts {
  const match = SEMVER_RE.exec(version)
  if (match === null) throw new Error(`版本号不是合法 semver:${version}`)
  return { major: match[1]!, minor: match[2]!, patch: match[3]!, prerelease: match[4] }
}

function compareNumericIdentifier(left: string, right: string): -1 | 0 | 1 {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePrerelease(left: string | undefined, right: string | undefined): -1 | 0 | 1 {
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1

  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const segmentA = a[index]
    const segmentB = b[index]
    if (segmentA === undefined) return -1
    if (segmentB === undefined) return 1

    const numericA = /^\d+$/.test(segmentA)
    const numericB = /^\d+$/.test(segmentB)
    if (numericA && numericB) {
      const result = compareNumericIdentifier(segmentA, segmentB)
      if (result !== 0) return result
      continue
    }
    if (numericA) return -1
    if (numericB) return 1
    if (segmentA !== segmentB) return segmentA < segmentB ? -1 : 1
  }
  return 0
}

function parseTools(raw: unknown, errors: FieldError[]): AgentPackageManifest['tools'] {
  if (!isRecord(raw)) {
    errors.push({ field: 'tools', message: 'tools 必须是对象' })
    return { mode: 'none' }
  }

  rejectUnknownKeys(raw, TOOLS_KEYS, 'tools', errors)

  const validModes: readonly AgentPackageToolsMode[] = ['none', 'http', 'mcp', 'both']
  const mode = typeof raw.mode === 'string' && validModes.includes(raw.mode as AgentPackageToolsMode)
    ? (raw.mode as AgentPackageToolsMode)
    : 'none'
  if (mode !== raw.mode) {
    errors.push({ field: 'tools.mode', message: 'tools.mode 必须是 none / http / mcp / both' })
  }

  const wantsHttp = mode === 'http' || mode === 'both'
  const wantsMcp = mode === 'mcp' || mode === 'both'
  let http: NonNullable<AgentPackageManifest['tools']['http']> | undefined
  let mcp: NonNullable<AgentPackageManifest['tools']['mcp']> | undefined

  if (wantsHttp) {
    if (!isRecord(raw.http)) {
      errors.push({ field: 'tools.http', message: '选择 HTTP 时必须声明 tools.http 入口' })
    } else {
      rejectUnknownKeys(raw.http, HTTP_KEYS, 'tools.http', errors)
      if (raw.http.entry !== 'tools/http/server.mjs') {
        errors.push({ field: 'tools.http.entry', message: 'tools.http.entry 必须固定为 tools/http/server.mjs' })
      }
      const hasSchema = Object.hasOwn(raw.http, 'argumentsSchema')
      if (hasSchema) {
        try {
          const serialized = JSON.stringify(raw.http.argumentsSchema)
          if (serialized === undefined) {
            errors.push({ field: 'tools.http.argumentsSchema', message: 'argumentsSchema 必须可序列化为 JSON' })
          } else if (serialized.length > MAX_ARGUMENTS_SCHEMA_LENGTH) {
            errors.push({
              field: 'tools.http.argumentsSchema',
              message: `argumentsSchema 序列化后不得超过 ${MAX_ARGUMENTS_SCHEMA_LENGTH} 个字符`,
            })
          }
        } catch {
          errors.push({ field: 'tools.http.argumentsSchema', message: 'argumentsSchema 必须可序列化为 JSON' })
        }
      }
      http = hasSchema
        ? { entry: 'tools/http/server.mjs', argumentsSchema: raw.http.argumentsSchema }
        : { entry: 'tools/http/server.mjs' }
    }
  } else if (raw.http !== undefined) {
    errors.push({ field: 'tools.http', message: '未选择 HTTP 时不得声明 tools.http' })
  }

  if (wantsMcp) {
    if (!isRecord(raw.mcp)) {
      errors.push({ field: 'tools.mcp', message: '选择 MCP 时必须声明 tools.mcp 入口' })
    } else {
      rejectUnknownKeys(raw.mcp, MCP_KEYS, 'tools.mcp', errors)
      if (raw.mcp.entry !== 'tools/mcp/server.mjs') {
        errors.push({ field: 'tools.mcp.entry', message: 'tools.mcp.entry 必须固定为 tools/mcp/server.mjs' })
      }
      mcp = { entry: 'tools/mcp/server.mjs' }
    }
  } else if (raw.mcp !== undefined) {
    errors.push({ field: 'tools.mcp', message: '未选择 MCP 时不得声明 tools.mcp' })
  }

  return {
    mode,
    ...(http === undefined ? {} : { http }),
    ...(mcp === undefined ? {} : { mcp }),
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({ field: `${prefix}.${key}`, message: '不支持的字段' })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
