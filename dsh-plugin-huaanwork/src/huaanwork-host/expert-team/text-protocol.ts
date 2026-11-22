import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 成员输出文本渲染结果；失败时不提供任何正文，调用方据此记 `status = 'failed'`。 */
export type MemberTextResult = { ok: true; text: string } | { ok: false; error: 'empty-output' | 'unsupported-output' }

/**
 * 审查结论的解析结果。
 *
 * 两个可选键互斥：有 `reviewVerdict` 时没有 `reviewError`，反之亦然。无效结论
 * 不得折算成 `revise`（spec §10.4）。
 */
export type ReviewVerdictResult =
  | { reviewVerdict: 'pass' | 'revise'; reviewError?: never }
  | { reviewVerdict?: never; reviewError: 'invalid-verdict' }

/**
 * 按 spec §8.4 渲染成员结果：只按原顺序拼接 `text` 块并以空行分隔，忽略 `reasoning`
 * 思考元数据；任何既非 `text` 又非 `reasoning` 的块（含未知块）一律 `unsupported-output`，
 * 即使同批还有文本。过滤后无非空白内容记 `empty-output`（纯 reasoning 即属此类）。
 */
export function renderMemberOutput(blocks: readonly ContentBlock[]): MemberTextResult {
  const text: string[] = []
  for (const block of blocks) {
    if (block.type === 'reasoning') continue
    if (block.type !== 'text') return { ok: false, error: 'unsupported-output' }
    text.push(block.text)
  }
  const rendered = text.join('\n\n')
  return rendered.trim() === '' ? { ok: false, error: 'empty-output' } : { ok: true, text: rendered }
}

/**
 * 按 spec §10.4 解析审查标记：只取去除首尾空白后的最后一个非空行，且必须与该行
 * 完全一致；缺少、无法识别或同一行含其它内容都记 `invalid-verdict`。
 */
export function parseReviewVerdict(text: string): ReviewVerdictResult {
  const last = text.trim().split(/\r?\n/).at(-1)?.trim()
  if (last === '[VERDICT: PASS]') return { reviewVerdict: 'pass' }
  if (last === '[VERDICT: REVISE]') return { reviewVerdict: 'revise' }
  return { reviewError: 'invalid-verdict' }
}
