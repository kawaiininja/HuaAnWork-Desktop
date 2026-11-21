/**
 * 自动化终态封套适配器(设计 §6.2 / 计划 Task 3)。
 *
 * 一次 agent 自动化的完整可见输出只在 prepare 阶段经过这里：
 * `fullText.trim()` 整体必须是一个 JSON 文档；带 `type/schemaVersion` 标记的封套
 * 按固定字段校验，无标记的对象/数组走旧 JSON → 块树 → Markdown 兼容路径，
 * 普通文本 skipped。坏标记封套报 `invalid-result-envelope`，不降级为兼容文档。
 *
 * 只调用 {@link prepareArtifact} 写隐藏暂存；不 commit、不 emit、不查询既有记录。
 * run/automation/session 已在 executeRun 同步 begin 的 scope 中捕获，本模块不建 lease。
 */
import { blocksToMarkdown, jsonToBlocks } from '../client-huaanwork/logic/runResultRender.ts'
import type { ArtifactFormat } from '../client-huaanwork/rpc-types.ts'
import { prepareArtifact, type ArtifactWrite } from './artifacts-host.ts'

/** 固定提示契约(规格 §6.2)：追加在 prompt 之后、`<automation-fire>` 封装之前。 */
export const AUTOMATION_RESULT_CONTRACT = [
  '<task-result-contract>',
  '若形成可交付任务结果，最终可见输出必须且只能是一个 JSON 对象，不要输出 Markdown 代码围栏或任何解释文字。',
  '对象形状为 {"schemaVersion":1,"type":"huaanwork.task-result","title":"简短标题","format":"markdown 或 html","content":"完整结果内容","downloadName":"可选文件名"}。',
  'content 必须是 JSON 字符串；format 只能使用 markdown 或 html；同一结果只提交一次。',
  '若不生成 Artifact，则保持原有输出，不得输出 huaanwork.task-result 标记。',
  '</task-result-contract>',
].join('\n')

/**
 * prepare 的三个结局：prepared 只暴露已校验 title/format；
 * failed 仅在内容通过校验、准备/存储失败时携带 title/format，坏封套不携带。
 */
export type AutomationArtifactPreparation =
  | { outcome: 'prepared'; title: string; format: ArtifactFormat }
  | { outcome: 'failed'; artifactError: string; artifactTitle?: string; artifactFormat?: ArtifactFormat }
  | { outcome: 'skipped' }

/** 新协议封套固定字段(设计 §6.2)。 */
type AutomationResultEnvelope = {
  schemaVersion: 1
  type: 'huaanwork.task-result'
  title: string
  format: 'markdown' | 'html'
  content: string
  downloadName?: string
}

const ENVELOPE_TYPE = 'huaanwork.task-result'
const INVALID_ENVELOPE = 'invalid-result-envelope'
/** 兼容 JSON 没有标题来源：与客户端失败卡回退一致。 */
const COMPAT_RESULT_TITLE = '任务结果'
/** 存储定义的稳定具名错误码形如 `artifact-too-large`；其余写盘异常统一为写入失败。 */
const NAMED_STORAGE_ERROR = /^artifact-[a-z][a-z-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `type` 或 `schemaVersion` 任一在场即视为带标记封套，坏标记不得走兼容路径。 */
function isMarkedEnvelope(value: Record<string, unknown>): boolean {
  return value.type === ENVELOPE_TYPE || Object.hasOwn(value, 'schemaVersion')
}

/**
 * 封套完整性校验先于任何写盘；前置条件与存储侧 validateBody 一致
 * (title 非空单行、format 白名单、content/downloadName 类型)，
 * 因此校验失败时 title/format 不可确认，不携带。
 */
function parseEnvelope(value: Record<string, unknown>): AutomationResultEnvelope | undefined {
  if (value.schemaVersion !== 1 || value.type !== ENVELOPE_TYPE) return undefined
  const title = value.title
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) return undefined
  const format = value.format
  if (format !== 'markdown' && format !== 'html') return undefined
  const content = value.content
  if (typeof content !== 'string') return undefined
  const downloadName = value.downloadName
  if (downloadName !== undefined && typeof downloadName !== 'string') return undefined
  return {
    schemaVersion: 1,
    type: ENVELOPE_TYPE,
    title: title.trim(),
    format,
    content,
    ...(downloadName === undefined ? {} : { downloadName }),
  }
}

function stableArtifactError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return NAMED_STORAGE_ERROR.test(message) ? message : 'artifact-write-failed'
}

/**
 * 把一次运行的完整采集文本准备为待提交 Artifact。
 *
 * @param write executeRun 同步建立的唯一 lease
 * @param fullText stripModelThinking 后的完整 collector 文本(尚未按摘要截断)
 * @returns 已准备、失败(稳定错误码)或跳过；不 commit、不 emit
 */
export async function prepareAutomationResult(
  write: ArtifactWrite,
  fullText: string,
): Promise<AutomationArtifactPreparation> {
  let parsed: unknown
  try {
    // 整段 trim 后必须是唯一 JSON 文档；解释文字/代码围栏包围的封套不抽取。
    parsed = JSON.parse(fullText.trim())
  } catch {
    return { outcome: 'skipped' }
  }

  let title: string
  let format: ArtifactFormat
  let content: string
  let downloadName: string | undefined
  if (isRecord(parsed) && isMarkedEnvelope(parsed)) {
    const envelope = parseEnvelope(parsed)
    if (!envelope) return { outcome: 'failed', artifactError: INVALID_ENVELOPE }
    title = envelope.title
    format = envelope.format
    content = envelope.content
    downloadName = envelope.downloadName
  } else if (Array.isArray(parsed) || isRecord(parsed)) {
    // 旧 JSON 结果兼容路径：块树 → Markdown 纯函数，不猜测标题。
    title = COMPAT_RESULT_TITLE
    format = 'markdown'
    content = blocksToMarkdown(jsonToBlocks(parsed))
  } else {
    return { outcome: 'skipped' }
  }

  try {
    await prepareArtifact(write, {
      title,
      format,
      content,
      ...(downloadName === undefined ? {} : { downloadName }),
    })
  } catch (error) {
    return {
      outcome: 'failed',
      artifactError: stableArtifactError(error),
      artifactTitle: title,
      artifactFormat: format,
    }
  }
  return { outcome: 'prepared', title, format }
}
