/**
 * 知识库全文检索的中文分词与 FTS5 安全查询构造（规格 §7.2 / §11.1(4)）。
 *
 * 分词策略（计划 Task 3 / 控制器裁决 N-2）：连续汉字串在长度 ≥ 2 时同时发射
 * 全部单字 unigram 与相邻 bigram，长度 1 只发射该单字。bigram 保证双字词精度，
 * unigram 让「单字查多字词」（如「税」命中「税率」）成立；单库 50,000 切片上限
 * 下索引增量可控。英文、数字与下划线保留为整词并小写。
 *
 * `buildSafeFtsQuery` 先剥离 FTS5 运算符（`- : * ^ ( ) " +` 与独立关键词
 * `AND / OR / NOT / NEAR`），再用同一分词器去重、截断到 24 词，并逐词用双引号
 * 包裹。引号包裹是唯一的安全保证：输出里不存在任何可被 FTS5 解释为语法的裸词。
 *
 * 本文件会被 Worker/测试以 `.ts` 源码直接加载（Node type-stripping），因此
 * 不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

/** 汉字串或英文/数字/下划线整词；标点与空白不产生 token。 */
const TOKEN_PATTERN = /\p{Script=Han}+|[A-Za-z0-9_]+/gu
const HAN_RUN_PATTERN = /^\p{Script=Han}+$/u
/** 独立出现（非词内）的 FTS5 布尔运算符关键词；大小写不敏感地剥离。 */
const FTS_OPERATOR_KEYWORD_PATTERN = /\b(?:AND|OR|NOT|NEAR)\b/giu
const FTS_OPERATOR_CHAR_PATTERN = /[-:*^()"+]/gu

/** 查询最多保留的去重词数（计划 Task 3 契约）。 */
export const FTS_QUERY_MAX_TERMS = 24

const PURE_UNDERSCORE_PATTERN = /^_+$/u

/** 剥离 FTS5 布尔运算符与保留关键词（供查询构造与重排共用）。 */
export function stripFtsOperators(rawQuery: string): string {
  return rawQuery
    .normalize('NFKC')
    .replace(FTS_OPERATOR_CHAR_PATTERN, ' ')
    .replace(FTS_OPERATOR_KEYWORD_PATTERN, ' ')
}

/**
 * 把正文/标题/路径预处理成 FTS5 索引文本：token 以单个空格连接。
 * 长度 ≥ 2 的汉字串同时发射 unigram 与相邻 bigram，长度 1 只发射 unigram；
 * 全角字母/数字先做 NFKC 归一化，纯下划线 token 跳过（unicode61 视为分隔符）。
 */
export function tokenizeForFts(text: string): string {
  const normalized = text.normalize('NFKC')
  const tokens: string[] = []
  for (const match of normalized.matchAll(TOKEN_PATTERN)) {
    const run = match[0]
    if (HAN_RUN_PATTERN.test(run)) {
      const chars = [...run]
      for (const char of chars) tokens.push(char)
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.push(chars.slice(index, index + 2).join(''))
      }
    } else if (!PURE_UNDERSCORE_PATTERN.test(run)) {
      tokens.push(run.toLowerCase())
    }
  }
  return tokens.join(' ')
}

interface QueryCandidateTerm {
  readonly term: string
  readonly kind: 'han' | 'ascii'
}

/**
 * 在保留原出现顺序的前提下将候选词截断到 `FTS_QUERY_MAX_TERMS`（I-7 修复）：
 * 英文/数字词（如年份 `2026`、代码标识符）优先保留，不被前导长中文串挤出。
 */
function selectBoundedQueryTerms(candidates: readonly QueryCandidateTerm[]): string[] {
  const deduped: QueryCandidateTerm[] = []
  const seen = new Set<string>()
  for (const item of candidates) {
    if (item.term === '' || seen.has(item.term)) continue
    seen.add(item.term)
    deduped.push(item)
  }
  const asciiCount = deduped.reduce((count, item) => count + (item.kind === 'ascii' ? 1 : 0), 0)
  const reservedAscii = Math.min(asciiCount, FTS_QUERY_MAX_TERMS)
  const hanBudget = FTS_QUERY_MAX_TERMS - reservedAscii
  const selected: string[] = []
  let hanUsed = 0
  let asciiUsed = 0
  for (const item of deduped) {
    if (selected.length >= FTS_QUERY_MAX_TERMS) break
    if (item.kind === 'ascii') {
      if (asciiUsed >= reservedAscii) continue
      asciiUsed += 1
      selected.push(item.term)
    } else {
      if (hanUsed >= hanBudget) continue
      hanUsed += 1
      selected.push(item.term)
    }
  }
  return selected
}

/**
 * 把用户原始查询转成只含双引号字面量的 FTS5 查询（I-7 修复）；无可检索词时返回空串。
 * - 长度 ≥ 2 的连续汉字串只发射 bigram（索引侧已有 bigram，不再用冗余 unigram 浪费一半配额）；
 * - 单字汉字仍发射 unigram（保留「税」命中「税率」）；
 * - 英文/数字词在 24 词上限内优先保留，不被长中文前缀挤掉。
 */
export function buildSafeFtsQuery(rawQuery: string): string {
  const stripped = stripFtsOperators(rawQuery)
  const candidates: QueryCandidateTerm[] = []
  for (const match of stripped.matchAll(TOKEN_PATTERN)) {
    const run = match[0]
    if (HAN_RUN_PATTERN.test(run)) {
      const chars = [...run]
      if (chars.length === 1) {
        candidates.push({ term: chars[0] ?? '', kind: 'han' })
      } else {
        for (let index = 0; index + 1 < chars.length; index += 1) {
          candidates.push({ term: chars.slice(index, index + 2).join(''), kind: 'han' })
        }
      }
    } else if (!PURE_UNDERSCORE_PATTERN.test(run)) {
      candidates.push({ term: run.toLowerCase(), kind: 'ascii' })
    }
  }
  return selectBoundedQueryTerms(candidates).map((term) => `"${term}"`).join(' ')
}

/**
 * 无空格中文多词查询的降级召回串（I-7 修复）：仅在严格 bigram 查询 0 命中时由
 * `storage-db.searchFts` 调用。对长度 ≥ 3 的连续汉字串拆成去重单字 AND（例如
 * `"基金税率"` → `"基" "金" "税" "率"`），从而命中 `"该基金的赎回税率为1.5%"`，
 * 同时维持全词 AND 语义，避免 `OR` 带来的噪音召回。无长度 ≥ 3 汉字串时返回空串。
 */
export function buildRelaxedFtsQuery(rawQuery: string): string {
  const stripped = stripFtsOperators(rawQuery)
  let hasLongHanRun = false
  const candidates: QueryCandidateTerm[] = []
  for (const match of stripped.matchAll(TOKEN_PATTERN)) {
    const run = match[0]
    if (HAN_RUN_PATTERN.test(run)) {
      const chars = [...run]
      if (chars.length >= 3) {
        hasLongHanRun = true
        for (const char of chars) candidates.push({ term: char, kind: 'han' })
      } else if (chars.length === 1) {
        candidates.push({ term: chars[0] ?? '', kind: 'han' })
      } else {
        candidates.push({ term: run, kind: 'han' })
      }
    } else if (!PURE_UNDERSCORE_PATTERN.test(run)) {
      candidates.push({ term: run.toLowerCase(), kind: 'ascii' })
    }
  }
  if (!hasLongHanRun) return ''
  return selectBoundedQueryTerms(candidates).map((term) => `"${term}"`).join(' ')
}
