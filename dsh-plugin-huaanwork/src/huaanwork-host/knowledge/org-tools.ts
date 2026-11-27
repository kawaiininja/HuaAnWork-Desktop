/**
 * 知识库整理槽的三个宿主工具(规格 §8.1 / M1-2 Task 3)。
 *
 * 工具全局注册(与 `result-artifact-tools.ts` / `expert-team-dispatch.ts` 相同的
 * `defineTool` 模式),但只在 `huaanwork-kb-org-<kbId>` 会话内可用:
 * - `kb_org_get_delta()` 只返回 `openOrganizeBatch` 时的冻结快照,绝不重新查询 Storage;
 * - `kb_org_read_doc({ docId, startOrdinal?, limit? })` 只读本批快照内的切片,默认/最大 12 片;
 * - `kb_org_mark_organized({ processed, clearedTombstones?, summary })` 先完整校验
 *   (快照归属、卡片文件、全库 wiki 体积、墓碑登记路径),再按「文件先于行」顺序落副作用。
 *
 * 执行时经 `getKnowledgeHost()` 取当前宿主,不接受跨库 `kbId` 参数;未接线或非整理
 * 会话一律 fail closed。Storage Worker 只删墓碑行,绝不 unlink Wiki 文件。
 */

import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'
import { resolveInside } from '@huaanwork/policy/paths'

import { MAX_WIKI_FILE_BYTES, MAX_WIKI_TOTAL_BYTES } from './types.ts'
import type { KnowledgeHost } from './host.ts'
import type { OrganizeTombstoneRecord, PendingOrganizeBatch } from './types.ts'
import { getKnowledgeHost } from './host-ref.ts'
import { kbIdFromOrganizeSessionId } from './session-ids.ts'
import { neutralKnowledgeWikiRootPath } from '../workspace-state.ts'

/** 三个整理工具名;Task 5/6 与 `present-as` 白名单共用这一份定义。 */
export const KB_ORG_TOOLS = ['kb_org_get_delta', 'kb_org_read_doc', 'kb_org_mark_organized'] as const

/** 整理槽可用工具:`wiki/` 内 6 个 fs 工具加 3 个限定单库宿主工具。 */
export const KB_ORG_ALLOWED_TOOLS = ['read', 'read_file', 'glob', 'grep', 'write', 'edit', ...KB_ORG_TOOLS] as const

/** `kb_org_read_doc` 默认与最大分页大小(规格 §8.1)。 */
const READ_DOC_LIMIT = 12

/** Wiki 内文档卡片目录(相对 wiki 根)。 */
const WIKI_DOCS_DIRNAME = 'docs'

/**
 * 测试注入缝:缩小全库 wiki 上限 / 替换文件删除实现。
 * 生产永远使用 `MAX_WIKI_TOTAL_BYTES` 与 `node:fs/promises` 的 `unlink`。
 */
export interface KnowledgeOrgToolTestHooks {
  readonly maxWikiTotalBytes?: number
  readonly unlinkFile?: (path: string) => Promise<void>
}

type ToolContext = {
  tools?: { register(definition: unknown): () => void }
  huaanworkProfileDir?: string
  huaanworkKnowledgeOrgTestHooks?: KnowledgeOrgToolTestHooks
}

type ToolExec = { readonly agent?: unknown; readonly callId?: string }

const TEXT_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: { text: { type: 'string' as const, required: true as const } },
  },
  render(_args: unknown, value: { text: string }) {
    return [{ type: 'text' as const, text: value.text }]
  },
}

function fail(code: string, detail?: string): never {
  throw new Error(detail === undefined ? code : `${code}: ${detail}`)
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

interface OrganizerToolContext {
  readonly kbId: string
  readonly host: KnowledgeHost
  readonly profileDir: string
}

/** 会话前缀锁定唯一 kbId;非整理槽、未接线宿主或缺 profileDir 全部 fail closed。 */
function requireOrganizerContext(ctx: ToolContext, exec: ToolExec): OrganizerToolContext {
  const sessionId = sessionIdOfAgentRef(
    exec.agent as { id?: string; session?: { id?: string } } | undefined,
  )
  const kbId = sessionId === undefined ? undefined : kbIdFromOrganizeSessionId(sessionId)
  if (kbId === undefined) fail('knowledge-organize-session-required')
  const host = getKnowledgeHost()
  if (host === undefined) fail('knowledge-base-unavailable')
  const profileDir = ctx.huaanworkProfileDir
  if (profileDir === undefined || profileDir === '') fail('knowledge-organize-context-missing')
  return { kbId, host, profileDir }
}

function stringArrayArg(value: unknown, key: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('knowledge-organize-args-invalid', key)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') fail('knowledge-organize-args-invalid', key)
    items.push(item)
  }
  return items
}

function requiredDocId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('knowledge-organize-args-invalid', 'docId')
  return value
}

function ordinalArg(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('knowledge-organize-args-invalid', key)
  const truncated = Math.trunc(value)
  if (truncated < 0) fail('knowledge-organize-args-invalid', key)
  return truncated
}

/** 模型必须给出非空 summary(规格 §8.1 的 `kb_org_mark_organized` 参数)。 */
function requireSummary(value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') fail('knowledge-organize-args-invalid', 'summary')
}

function cardRelPath(docId: string): string {
  return `${WIKI_DOCS_DIRNAME}/${docId}.md`
}

/**
 * 全库 `wiki/` 字节总量:递归 `lstat` 累加常规文件,不跟随任何符号链接;
 * 超过上限立即返回,避免大目录全量遍历。
 */
async function measureWikiTotalBytes(wikiRoot: string, limit: number): Promise<number> {
  let total = 0
  const stack = [wikiRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) continue
      throw error
    }
    for (const name of entries) {
      const target = join(dir, name)
      let info
      try {
        info = await lstat(target)
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) continue
        throw error
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        stack.push(target)
        continue
      }
      if (info.isFile()) total += info.size
      if (total > limit) return total
    }
  }
  return total
}

/** 卡片必须是 `wiki/docs/<docId>.md` 内的非符号链接常规文件、1..256 KiB。 */
async function validateCardFile(wikiRoot: string, docId: string): Promise<void> {
  const rel = cardRelPath(docId)
  if (resolveInside(wikiRoot, rel) === null) fail('knowledge-organize-path-invalid', rel)
  let info
  try {
    // 对字面路径做 lstat:符号链接(含指向库内的链接)一律拒绝。
    info = await lstat(join(wikiRoot, rel))
  } catch {
    fail('knowledge-organize-wiki-card-invalid', rel)
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > MAX_WIKI_FILE_BYTES) {
    fail('knowledge-organize-wiki-card-invalid', rel)
  }
}

interface TombstoneDeletePlan {
  readonly docId: string
  readonly targetPath: string
}

/**
 * 单条墓碑的可删计划:
 * - `wikiNotePath = null` → 无卡片可删;
 * - 非 null 必须逐字等于 `docs/<docId>.md`;
 * - 先 `lstat`:ENOENT 视为可清行;存在则必须是非符号链接常规文件,再过
 *   `resolveInside(forWrite)` 确认仍在库内。顺序不可颠倒——不带 `forWrite` 的
 *   `resolveInside` 对不存在的文件返回 null。
 */
async function planTombstoneClear(
  wikiRoot: string,
  tombstone: OrganizeTombstoneRecord,
): Promise<TombstoneDeletePlan | undefined> {
  if (tombstone.wikiNotePath === null) return undefined
  const expected = cardRelPath(tombstone.docId)
  if (tombstone.wikiNotePath !== expected) fail('knowledge-organize-path-invalid', tombstone.wikiNotePath)
  const literal = join(wikiRoot, expected)
  let info
  try {
    info = await lstat(literal)
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return undefined
    fail('knowledge-organize-wiki-card-invalid', expected)
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('knowledge-organize-wiki-card-invalid', expected)
  const resolved = resolveInside(wikiRoot, expected, { forWrite: true })
  if (resolved === null) fail('knowledge-organize-path-invalid', expected)
  return { docId: tombstone.docId, targetPath: resolved }
}

/** `kb_org_get_delta`:逐字返回 open 时的冻结快照,绝不重新查询 Storage。 */
async function executeGetDelta(ctx: ToolContext, exec: ToolExec): Promise<{ text: string }> {
  const { kbId, host } = requireOrganizerContext(ctx, exec)
  const batch: PendingOrganizeBatch = host.getOpenOrganizeBatch(kbId)
  return { text: JSON.stringify(batch) }
}

/** `kb_org_read_doc`:只读本批快照内的切片,默认/最大 12 片。 */
async function executeReadDoc(
  ctx: ToolContext,
  args: Record<string, unknown>,
  exec: ToolExec,
): Promise<{ text: string }> {
  const { kbId, host } = requireOrganizerContext(ctx, exec)
  const docId = requiredDocId(args.docId)
  const startOrdinal = ordinalArg(args.startOrdinal, 'startOrdinal', 0)
  const requestedLimit = ordinalArg(args.limit, 'limit', READ_DOC_LIMIT)
  if (requestedLimit < 1) fail('knowledge-organize-args-invalid', 'limit')
  const limit = Math.min(requestedLimit, READ_DOC_LIMIT)
  const batch = host.getOpenOrganizeBatch(kbId)
  if (!batch.docs.some(item => item.docId === docId)) fail('knowledge-organize-doc-not-in-batch', docId)
  const chunks = await host.readOrganizeDoc(kbId, docId, startOrdinal, limit)
  return { text: JSON.stringify({ docId, startOrdinal, chunks }) }
}

/**
 * `kb_org_mark_organized`:整个调用先校验(快照归属 → 全库体积 → 每张卡片 →
 * 每条墓碑),任一失败在副作用前拒绝;随后按「推进文档指纹 → 删墓碑文件 → 删行」
 * 执行。单个 unlink 失败只保留该 id 行。
 */
async function executeMarkOrganized(
  ctx: ToolContext,
  args: Record<string, unknown>,
  exec: ToolExec,
): Promise<{ text: string }> {
  const { kbId, host, profileDir } = requireOrganizerContext(ctx, exec)
  requireSummary(args.summary)
  const processed = stringArrayArg(args.processed, 'processed')
  const clearedTombstones = stringArrayArg(args.clearedTombstones, 'clearedTombstones')
  const snapshot = host.getOpenOrganizeBatch(kbId)
  const docsById = new Map(snapshot.docs.map(item => [item.docId, item]))
  const tombstonesById = new Map(snapshot.tombstones.map(item => [item.docId, item]))

  for (const docId of processed) {
    if (!docsById.has(docId)) fail('knowledge-organize-doc-not-in-batch', docId)
  }
  for (const docId of clearedTombstones) {
    if (!tombstonesById.has(docId)) fail('knowledge-organize-tombstone-not-in-batch', docId)
  }

  const wikiRoot = neutralKnowledgeWikiRootPath(profileDir, kbId)
  const hooks = ctx.huaanworkKnowledgeOrgTestHooks
  const totalLimit = hooks?.maxWikiTotalBytes ?? MAX_WIKI_TOTAL_BYTES
  const wikiTotalBytes = await measureWikiTotalBytes(wikiRoot, totalLimit)
  if (wikiTotalBytes > totalLimit) fail('knowledge-organize-wiki-too-large', String(wikiTotalBytes))

  for (const docId of processed) await validateCardFile(wikiRoot, docId)

  const deletePlans: TombstoneDeletePlan[] = []
  const clearableWithoutFile: string[] = []
  for (const docId of clearedTombstones) {
    const tombstone = tombstonesById.get(docId)
    if (tombstone === undefined) fail('knowledge-organize-tombstone-not-in-batch', docId)
    const plan = await planTombstoneClear(wikiRoot, tombstone)
    if (plan === undefined) clearableWithoutFile.push(docId)
    else deletePlans.push(plan)
  }

  // 副作用阶段:只有全部校验通过才会走到这里。
  const organized: string[] = []
  const stale: string[] = []
  for (const docId of processed) {
    const doc = docsById.get(docId)
    if (doc === undefined) fail('knowledge-organize-doc-not-in-batch', docId)
    const result = await host.markOrganizeProcessed(kbId, docId, doc.sha256)
    if (result.updated) organized.push(docId)
    else stale.push(docId)
  }

  const unlinkFile = hooks?.unlinkFile ?? unlink
  const deletedFiles: string[] = []
  const keptTombstones: string[] = []
  for (const plan of deletePlans) {
    try {
      await unlinkFile(plan.targetPath)
      deletedFiles.push(plan.docId)
    } catch {
      // 单个 unlink 失败只保留该 id 的墓碑行,不影响同批其它墓碑。
      keptTombstones.push(plan.docId)
    }
  }

  const idsToClear = [...clearableWithoutFile, ...deletedFiles]
  const clearedTombstoneIds = idsToClear.length === 0
    ? []
    : await host.clearOrganizeTombstones(kbId, idsToClear)
  return {
    text: JSON.stringify({
      organized,
      stale,
      clearedTombstones: clearedTombstoneIds,
      keptTombstones,
    }),
  }
}

function getDeltaTool(ctx: ToolContext) {
  return defineTool({
    name: 'kb_org_get_delta',
    description: [
      '读取当前整理批次的待整理文档与待清理墓碑。',
      '- 批次在批次开始时冻结，本工具不会返回之后新入库的文档；',
      '- 先调用本工具取得 delta，再阅读、改写 wiki 卡片，最后用 kb_org_mark_organized 结算。',
    ].join('\n'),
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args: Record<string, never>, exec: unknown) {
      return await executeGetDelta(ctx, exec as ToolExec)
    },
  })
}

function readDocTool(ctx: ToolContext) {
  return defineTool({
    name: 'kb_org_read_doc',
    description: [
      '读取当前整理批次内一份文档的切片（按 ordinal 升序）。',
      '- 只能读取本批快照内的文档；',
      '- 默认且最多返回 12 片，可用 startOrdinal 继续分页。',
    ].join('\n'),
    parameters: {
      docId: { type: 'string', required: true, description: '本批快照中的文档 id' },
      startOrdinal: { type: 'number', description: '起始切片序号，缺省 0' },
      limit: { type: 'number', description: '本次最多返回的切片数，缺省并最多 12' },
    },
    output: TEXT_OUTPUT,
    async execute(args: { docId: string; startOrdinal?: number; limit?: number }, exec: unknown) {
      return await executeReadDoc(
        ctx,
        {
          docId: args.docId,
          ...(args.startOrdinal === undefined ? {} : { startOrdinal: args.startOrdinal }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
        exec as ToolExec,
      )
    },
  })
}

function markOrganizedTool(ctx: ToolContext) {
  return defineTool({
    name: 'kb_org_mark_organized',
    description: [
      '结算本次整理：推进已写好卡片的文档，并清除已完成的删除墓碑。',
      '- 每个 processed 文档必须已存在 wiki/docs/<docId>.md（非空、≤ 256 KB、非符号链接）；',
      '- clearedTombstones 只填本批墓碑 docId：先更新 INDEX.md 与 topics/，再提交；',
      '- 宿主只删除墓碑登记的那一张文档卡片，绝不按参数删除专题页。',
    ].join('\n'),
    parameters: {
      processed: {
        type: 'array',
        items: { type: 'string' },
        description: '已写好 wiki 卡片的本批文档 id 列表',
      },
      clearedTombstones: {
        type: 'array',
        items: { type: 'string' },
        description: '已更新索引与专题、可清除的本批墓碑 docId 列表',
      },
      summary: { type: 'string', required: true, description: '本次整理的简要说明' },
    },
    output: TEXT_OUTPUT,
    async execute(
      args: { processed?: string[]; clearedTombstones?: string[]; summary: string },
      exec: unknown,
    ) {
      return await executeMarkOrganized(
        ctx,
        {
          ...(args.processed === undefined ? {} : { processed: args.processed }),
          ...(args.clearedTombstones === undefined ? {} : { clearedTombstones: args.clearedTombstones }),
          summary: args.summary,
        },
        exec as ToolExec,
      )
    },
  })
}

/**
 * 全局注册三个整理宿主工具。
 *
 * @param ctx tools 服务与 profileDir 的桥接对象(工具子插件内构建)
 * @returns 卸下三个工具的 disposer;缺少 tools 服务时为空 disposer
 */
export function registerKnowledgeOrgTools(ctx: unknown): () => void {
  const toolContext = ctx as ToolContext
  if (!toolContext.tools?.register) return () => undefined
  const disposers = [
    toolContext.tools.register(getDeltaTool(toolContext)),
    toolContext.tools.register(readDocTool(toolContext)),
    toolContext.tools.register(markOrganizedTool(toolContext)),
  ]
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // 卸载单个工具失败不应留下另外两个仍可调用的工具。
      }
    }
  }
}
