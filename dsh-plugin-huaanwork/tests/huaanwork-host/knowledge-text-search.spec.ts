import { describe, expect, it } from 'vitest'
import { chunkExtractedDocument } from '../../src/huaanwork-host/knowledge/chunker.ts'
import { mergeMultiKbResults, rerankSingleKbCandidates, type SingleKbCandidate } from '../../src/huaanwork-host/knowledge/ranker.ts'
import { buildRelaxedFtsQuery, buildSafeFtsQuery, FTS_QUERY_MAX_TERMS, tokenizeForFts } from '../../src/huaanwork-host/knowledge/tokenizer.ts'
import type { ExtractedDocument } from '../../src/huaanwork-host/knowledge/types.ts'

function makeRankerCandidate(kbId: string, ordinal: number, content: string, bm25: number): SingleKbCandidate {
  return {
    kbId,
    kbName: kbId,
    docId: `${kbId}-d${ordinal}`,
    relPath: `a-${ordinal}.md`,
    sha256: 'h1',
    extractConfigHash: 'c1',
    chunkId: `${kbId}-c${ordinal}`,
    ordinal,
    headingPath: '',
    locator: { kind: 'line', startLine: 1, endLine: 2 },
    content,
    bm25,
  }
}

describe('knowledge tokenizer, chunker, and ranker', () => {
  it('tokenizes Han runs into unigrams and bigrams while keeping lowercase alphanumeric words', () => {
    const tokens = tokenizeForFts('C类基金税率2026').split(' ')
    expect(tokens).toContain('c')
    expect(tokens).toContain('类')
    expect(tokens).toContain('基')
    expect(tokens).toContain('税')
    expect(tokens).toContain('率')
    expect(tokens).toContain('类基')
    expect(tokens).toContain('基金')
    expect(tokens).toContain('税率')
    expect(tokens).toContain('2026')
  })

  it('emits a lone unigram for single Han characters and lowercases latin runs', () => {
    expect(tokenizeForFts('税').split(' ')).toEqual(['税'])
    expect(tokenizeForFts('FILTER_2026').split(' ')).toEqual(['filter_2026'])
    expect(tokenizeForFts('   ')).toBe('')
  })

  it('strips FTS5 operators and wraps each term in double quotes', () => {
    const q = buildSafeFtsQuery('foo-bar:baz OR AND NOT NEAR * ^ ( ) "税率"')
    // Unquoted skeleton must be empty: every emitted term stays inside double quotes,
    // so a leaked operator (e.g. raw `AND`) fails here and in the per-term check below.
    const skeleton = q.replace(/"[^"]*"/gu, ' ')
    expect(skeleton).not.toMatch(/\b(?:or|and|not|near)\b/iu)
    expect(skeleton.replace(/\s+/gu, '')).toBe('')
    for (const term of q.split(' ')) {
      expect(term).toMatch(/^"[^"]+"$/u)
    }
    expect(q).toContain('"foo"')
    expect(q).toContain('"bar"')
    expect(q).toContain('"baz"')
    expect(q).toContain('"税率"')
    const lower = q.toLowerCase()
    // User-supplied operator words may only appear as quoted literals, never bare.
    for (const keyword of ['or', 'and', 'not', 'near']) {
      const occurrences = lower.match(new RegExp(`\\b${keyword}\\b`, 'gu')) ?? []
      const quoted = lower.match(new RegExp(`"${keyword}"`, 'gu')) ?? []
      expect(occurrences).toHaveLength(quoted.length)
    }
    expect(buildSafeFtsQuery('   --- ::: *** () ""  ')).toBe('')
  })

  it('caps chunks at 500, enforces maxTextBytes, and repeats headerRow on every sheet chunk', () => {
    const hugeSections = Array.from({ length: 600 }, (_, i) => ({
      headingPath: `H${i}`,
      locator: { kind: 'line' as const, startLine: i + 1, endLine: i + 1 },
      text: `第${i}段内容`.repeat(30),
    }))
    const doc: ExtractedDocument = {
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: hugeSections,
    }
    const capped = chunkExtractedDocument(doc)
    expect(capped.chunks).toHaveLength(500)
    expect(capped.truncated).toBe(true)

    const byteCapped = chunkExtractedDocument(doc, { maxTextBytes: 2_048 })
    expect(byteCapped.truncated).toBe(true)
    const totalBytes = byteCapped.chunks.reduce((sum, c) => sum + Buffer.byteLength(c.content, 'utf8'), 0)
    expect(totalBytes).toBeLessThanOrEqual(2_048)

    const sheetDoc: ExtractedDocument = {
      format: 'xlsx',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: [{
        headingPath: 'Sheet1',
        locator: { kind: 'sheet', sheet: 'Sheet1', rowStart: 2, rowEnd: 200 },
        headerRow: '基金代码 | 税率 | 备注',
        text: Array.from({ length: 80 }, (_, i) => `000${i} | 1.5% | ${'说明'.repeat(12)}`).join('\n'),
      }],
    }
    const sheetRes = chunkExtractedDocument(sheetDoc)
    expect(sheetRes.chunks.length).toBeGreaterThan(1)
    for (const chunk of sheetRes.chunks) {
      expect(chunk.content.startsWith('基金代码 | 税率 | 备注')).toBe(true)
      // Controller ruling M-8: the chunker owns per-chunk tokenization.
      expect(chunk.tokenized).toContain('税率')
      expect(chunk.tokenized).not.toContain('\n')
    }
    expect(sheetRes.chunks[0]?.content).toContain('0000 | 1.5%')
    expect(sheetRes.chunks.map((chunk) => chunk.ordinal)).toEqual(
      sheetRes.chunks.map((_, index) => index),
    )
  })

  it('skips empty sections and assigns contiguous ordinals', () => {
    const doc: ExtractedDocument = {
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: [
        { headingPath: '', locator: { kind: 'file' }, text: '   \n\t ' },
        { headingPath: 'A', locator: { kind: 'file' }, text: '有效内容' },
      ],
    }
    const res = chunkExtractedDocument(doc)
    expect(res.truncated).toBe(false)
    expect(res.chunks.map((chunk) => chunk.ordinal)).toEqual([0])
    expect(res.chunks[0]?.content).toBe('有效内容')
  })

  it('reranks only the first 60 candidates and returns the default top 30', () => {
    const candidates = Array.from({ length: 70 }, (_, i) =>
      makeRankerCandidate('kb', i, `条目${i}`, -70 + i))
    const ranked = rerankSingleKbCandidates(candidates, '不存在的短语')
    expect(ranked).toHaveLength(30)
    expect(ranked.map((candidate) => candidate.ordinal)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    )
    expect(rerankSingleKbCandidates(candidates, '不存在的短语', 5)).toHaveLength(5)
  })

  it('merges disparate-scale KBs fairly by reciprocal rank and enforces topK <= 20', () => {
    const make = (kbId: string, ordinal: number, content: string, bm25: number): SingleKbCandidate => ({
      kbId,
      kbName: kbId,
      docId: `${kbId}-d${ordinal}`,
      relPath: `a-${ordinal}.md`,
      sha256: 'h1',
      extractConfigHash: 'c1',
      chunkId: `${kbId}-c${ordinal}`,
      ordinal,
      headingPath: '',
      locator: { kind: 'line', startLine: 1, endLine: 2 },
      content,
      bm25,
    })
    const kbBig = Array.from({ length: 15 }, (_, i) => make('big', i, i === 0 ? '包含普通基金说明' : `条目${i}`, -100 + i))
    const kbSmall = Array.from({ length: 15 }, (_, i) => make('small', i, i === 0 ? '精准命中 C类基金税率 条款' : `条目${i}`, -0.5 + i * 0.01))

    const merged = mergeMultiKbResults([rerankSingleKbCandidates(kbBig, 'C类基金税率'), rerankSingleKbCandidates(kbSmall, 'C类基金税率')], 'C类基金税率', 99)
    expect(merged).toHaveLength(20)
    expect(merged[0]?.kbId).toBe('small')
    expect(merged[1]?.kbId).toBe('big')

    const defaultMerged = mergeMultiKbResults([rerankSingleKbCandidates(kbBig, 'C类基金税率'), rerankSingleKbCandidates(kbSmall, 'C类基金税率')], 'C类基金税率')
    expect(defaultMerged).toHaveLength(8)
  })

  it('keeps bigrams and trailing ASCII/year terms within 24-term cap and builds relaxed fallback for unspaced Han runs (I-7)', () => {
    const longQuery = '请查询关于二零二六年企业所得税年度汇算清缴以及研发费用加计扣除政策细则 ２０２６ ___'
    const strict = buildSafeFtsQuery(longQuery)
    const terms = strict.split(' ')
    expect(terms.length).toBeLessThanOrEqual(FTS_QUERY_MAX_TERMS)
    expect(terms).toContain('"2026"')
    expect(terms).not.toContain('"___"')
    // ≥2 字汉字串不再发射单字 unigram 挤占 24 词配额。
    expect(terms).not.toContain('"请"')
    expect(terms).toContain('"请查"')

    expect(buildRelaxedFtsQuery('基金税率')).toBe('"基" "金" "税" "率"')
    expect(buildRelaxedFtsQuery('费率')).toBe('')
  })

  it('never splits UTF-16 surrogate pairs across chunk overlap (I-11) and handles NaN limits, CSV headers, and non-duplicated chunk-0 sheet headers (M-5)', () => {
    // 构造全为 4 字节代理对（🚀）的长段落，覆盖滑窗切点与 100-unit 重叠回退边界。
    const emojiText = '🚀'.repeat(900)
    const emojiDoc: ExtractedDocument = {
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: [{ headingPath: 'Emoji', locator: { kind: 'line', startLine: 1, endLine: 1 }, text: emojiText }],
    }
    const emojiChunks = chunkExtractedDocument(emojiDoc)
    expect(emojiChunks.chunks.length).toBeGreaterThan(1)
    for (const chunk of emojiChunks.chunks) {
      expect(chunk.content.isWellFormed()).toBe(true)
    }

    // NaN 上限回退默认值；CSV 首片不重复 headerRow、后续片保留 headerRow。
    const csvHeader = 'code,rate,note'
    const csvDoc: ExtractedDocument = {
      format: 'csv',
      extractMode: 'text',
      extractConfigHash: 'cfg1',
      status: 'indexed',
      sections: [{
        headingPath: '',
        locator: { kind: 'line', startLine: 1, endLine: 100 },
        headerRow: csvHeader,
        text: `${csvHeader}\n${Array.from({ length: 60 }, (_, i) => `00${String(i)},1.5%,${'说明'.repeat(12)}`).join('\n')}`,
      }],
    }
    const csvChunks = chunkExtractedDocument(csvDoc, { maxChunks: Number.NaN, maxTextBytes: Number.NaN })
    expect(csvChunks.chunks.length).toBeGreaterThan(1)
    expect(csvChunks.chunks[0]?.content.startsWith(`${csvHeader}\n${csvHeader}\n`)).toBe(false)
    expect(csvChunks.chunks[0]?.content.startsWith(`${csvHeader}\n`)).toBe(true)
    expect(csvChunks.chunks[1]?.content.startsWith(`${csvHeader}\n`)).toBe(true)

    // Ranker NaN guards + phrase bonus breaks BM25 ties.
    const a = makeRankerCandidate('kb', 0, '其他内容 基金 与 税率 分散', -1.0)
    const b = makeRankerCandidate('kb', 1, '精准包含 基金税率 原短语', -1.0)
    const reranked = rerankSingleKbCandidates([a, b], '基金税率 OR NOT', Number.NaN)
    expect(reranked[0]?.ordinal).toBe(1)
    expect(mergeMultiKbResults([reranked], '基金税率', Number.NaN)).toHaveLength(2)
  })
})
