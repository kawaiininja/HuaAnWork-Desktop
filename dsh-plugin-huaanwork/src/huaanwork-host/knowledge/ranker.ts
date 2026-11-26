/**
 * 知识库检索候选的单库重排与多库倒数排名归并（规格 §7.2 / 计划 Task 3）。
 *
 * 单库：`rerankSingleKbCandidates` 只消费输入前 60 条（已按单库 BM25 升序），
 * 对原短语精确命中与查询词邻近度加分后稳定排序，默认返回前 30 条。BM25 越小
 * 越好，加分通过从 BM25 中扣除实现，因此仍是升序。
 *
 * 多库：各库独立 SQLite 的原始 BM25 不可跨库比较，`mergeMultiKbResults` 只使用
 * 单库内名次：`1 / (60 + rankInKb)`（`rankInKb` 从 1 起），含精确原短语命中的
 * 候选再加固定小权重 `0.002`，最后截断到 `Math.max(1, Math.min(topK ?? 8, 20))`。
 *
 * 本文件会被 Worker/测试以 `.ts` 源码直接加载（Node type-stripping），因此
 * 不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { tokenizeForFts } from './tokenizer.ts'
import type { ChunkLocator } from './types.ts'

const RERANK_POOL_SIZE = 60
const RERANK_DEFAULT_LIMIT = 30
/** 单库重排加分；只用于打破接近的 BM25 平局，不压过明显的 BM25 差距。 */
const RERANK_PHRASE_BONUS = 0.5
const RERANK_PROXIMITY_BONUS = 0.25

const RRF_RANK_OFFSET = 60
const RRF_PHRASE_BONUS = 0.002
const MULTI_KB_DEFAULT_TOP_K = 8
const MULTI_KB_MAX_TOP_K = 20

/** 单库全文检索的候选行（Storage Worker `searchFts` 产出）。 */
export interface SingleKbCandidate {
  readonly kbId: string
  readonly kbName: string
  readonly docId: string
  readonly relPath: string
  readonly sha256: string
  readonly extractConfigHash: string
  readonly chunkId: string
  readonly ordinal: number
  readonly headingPath: string
  readonly locator: ChunkLocator
  readonly content: string
  readonly bm25: number
  /** 文档索引时的字节大小与修改时间（Storage `searchFts` 附带，Host 用于实时 `stale` 校验）。 */
  readonly docSize?: number
  readonly docMtimeMs?: number
}

function normalizedPhrase(rawQuery: string): string {
  return rawQuery.trim().toLowerCase()
}

function containsPhrase(content: string, phrase: string): boolean {
  return phrase !== '' && content.toLowerCase().includes(phrase)
}

/** 查询去重词表；分词复用 `tokenizeForFts`，与索引口径一致。 */
function queryTerms(rawQuery: string): string[] {
  return [...new Set(tokenizeForFts(rawQuery).split(' ').filter((term) => term !== ''))]
}

/**
 * 查询词在内容中的邻近度（0–1）：只统计查询词首次出现位置的最短覆盖跨度，
 * 跨度过大或命中词过少时趋近 0。
 */
function proximityScore(content: string, terms: readonly string[]): number {
  if (terms.length < 2) return 0
  const haystack = content.toLowerCase()
  let first = Number.POSITIVE_INFINITY
  let last = -1
  let matched = 0
  for (const term of terms) {
    const index = haystack.indexOf(term)
    if (index === -1) continue
    matched += 1
    if (index < first) first = index
    const end = index + term.length
    if (end > last) last = end
  }
  if (matched < 2) return 0
  const span = Math.max(last - first, 1)
  const density = Math.max(0, Math.min(1, 1 - span / Math.max(haystack.length, 1)))
  return density * (matched / terms.length)
}

/**
 * 单库重排：只取输入前 60 条，按「BM25 - 原短语加分 - 邻近度加分」稳定升序，
 * 返回前 `limit`（默认 30）条。
 */
export function rerankSingleKbCandidates(
  candidates: readonly SingleKbCandidate[],
  rawQuery: string,
  limit: number = RERANK_DEFAULT_LIMIT,
): SingleKbCandidate[] {
  const phrase = normalizedPhrase(rawQuery)
  const terms = queryTerms(rawQuery)
  const pool = candidates.slice(0, RERANK_POOL_SIZE).map((candidate, index) => ({
    candidate,
    index,
    score: candidate.bm25
      - (containsPhrase(candidate.content, phrase) ? RERANK_PHRASE_BONUS : 0)
      - RERANK_PROXIMITY_BONUS * proximityScore(candidate.content, terms),
  }))
  pool.sort((left, right) => left.score - right.score || left.index - right.index)
  const take = Math.max(0, Math.min(limit, pool.length))
  return pool.slice(0, take).map((entry) => entry.candidate)
}

/**
 * 多库归并：跨库只信单库内名次（`1 / (60 + rankInKb)`），精确原短语命中额外
 * 加 `0.002`；按分数降序稳定输出，截断到 `[1, 20]` 内的 `topK`（默认 8）。
 */
export function mergeMultiKbResults(
  perKbLists: readonly (readonly SingleKbCandidate[])[],
  rawQuery: string,
  topK: number = MULTI_KB_DEFAULT_TOP_K,
): Array<SingleKbCandidate & { score: number }> {
  const cap = Math.max(1, Math.min(topK, MULTI_KB_MAX_TOP_K))
  const phrase = normalizedPhrase(rawQuery)
  const scored: Array<{ candidate: SingleKbCandidate; score: number; order: number }> = []
  let order = 0
  for (const list of perKbLists) {
    for (let rankInKb = 1; rankInKb <= list.length; rankInKb += 1) {
      const candidate = list[rankInKb - 1]
      if (candidate === undefined) continue
      const score = 1 / (RRF_RANK_OFFSET + rankInKb)
        + (containsPhrase(candidate.content, phrase) ? RRF_PHRASE_BONUS : 0)
      scored.push({ candidate, score, order })
      order += 1
    }
  }
  scored.sort((left, right) => right.score - left.score || left.order - right.order)
  return scored.slice(0, cap).map((entry) => ({ ...entry.candidate, score: entry.score }))
}
