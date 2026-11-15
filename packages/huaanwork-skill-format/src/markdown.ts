/**
 * SKILL.md frontmatter parsing and serialization shared by the desktop Host
 * and the intranet skill catalog.
 *
 * The managed keys and the `extraLines` preservation rule are the format
 * contract: editing a skill may reorder managed keys, but every non-managed
 * frontmatter line (including multi-line `metadata` blocks) must round-trip
 * in its original order and content. Line endings normalize to LF.
 *
 * @module markdown
 */

/** dsh's skill-name grammar (same as `@deepseek-ai/dsh-skill`'s SKILL_NAME). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const MANAGED_KEYS = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable'])

export type ParsedSkillMarkdown = {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  content: string
  /** Non-managed frontmatter lines (including multi-line blocks), in original order. */
  extraLines: string[]
}

function parseFrontmatterBool(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false
    default:
      return undefined
  }
}

/**
 * Parse a SKILL.md document. A document without frontmatter is all body.
 *
 * Indented frontmatter lines are continuations of a multi-line value and stay
 * in {@link ParsedSkillMarkdown.extraLines}; unknown top-level keys are kept in
 * their original order for the next serialize.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  // 闭合 `---` 允许落在 EOF(无尾随换行)或为空 frontmatter;正文可选。
  const match = raw.match(/^---\r?\n((?:[\s\S]*?\r?\n)?)---(?:\r?\n([\s\S]*))?$/u)
  const body = (match ? match[2] ?? '' : raw).trim()
  const known = new Map<string, string>()
  const extraLines: string[] = []
  for (const rawLine of (match?.[1] ?? '').split('\n')) {
    // CRLF 输入统一归一为 LF,避免 extraLines 回写时 \r\n 与 \n 混排。
    const line = rawLine.replace(/\r$/u, '')
    if (/^[ \t]/u.test(line)) {
      extraLines.push(line)
      continue
    }
    const index = line.indexOf(':')
    if (index === -1) {
      if (line.trim()) extraLines.push(line)
      continue
    }
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (MANAGED_KEYS.has(key)) known.set(key, value)
    else extraLines.push(line)
  }
  const disableModelInvocation = known.has('disable-model-invocation')
    ? parseFrontmatterBool(known.get('disable-model-invocation')!)
    : undefined
  const userInvocable = known.has('user-invocable')
    ? parseFrontmatterBool(known.get('user-invocable')!)
    : undefined
  return {
    name: known.get('name') ?? '',
    description: known.get('description') ?? '',
    ...(known.get('whenToUse') ? { whenToUse: known.get('whenToUse')! } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    content: body,
    extraLines,
  }
}

/**
 * Serialize managed keys first, then every preserved extra line, then the body.
 * Invocation booleans are only emitted when they were present in the source.
 */
export function serializeSkillMarkdown(skill: ParsedSkillMarkdown): string {
  const lines = [`name: ${skill.name}`, `description: ${skill.description}`]
  if (skill.whenToUse) lines.push(`whenToUse: ${skill.whenToUse}`)
  if (skill.disableModelInvocation !== undefined) {
    lines.push(`disable-model-invocation: ${String(skill.disableModelInvocation)}`)
  }
  if (skill.userInvocable !== undefined) lines.push(`user-invocable: ${String(skill.userInvocable)}`)
  lines.push(...skill.extraLines)
  return `---\n${lines.join('\n')}\n---\n\n${skill.content.trim()}\n`
}
