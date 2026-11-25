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

/**
 * 把正文/标题/路径预处理成 FTS5 索引文本：token 以单个空格连接。
 * 长度 ≥ 2 的汉字串同时发射 unigram 与相邻 bigram，长度 1 只发射 unigram。
 */
export function tokenizeForFts(text: string): string {
  const tokens: string[] = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const run = match[0]
    if (HAN_RUN_PATTERN.test(run)) {
      const chars = [...run]
      for (const char of chars) tokens.push(char)
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.push(chars.slice(index, index + 2).join(''))
      }
    } else {
      tokens.push(run.toLowerCase())
    }
  }
  return tokens.join(' ')
}

/**
 * 把用户原始查询转成只含双引号字面量的 FTS5 查询；无可检索词时返回空串。
 * 去重后按首次出现顺序保留最多 `FTS_QUERY_MAX_TERMS` 个词。
 */
export function buildSafeFtsQuery(rawQuery: string): string {
  const stripped = rawQuery
    .replace(FTS_OPERATOR_CHAR_PATTERN, ' ')
    .replace(FTS_OPERATOR_KEYWORD_PATTERN, ' ')
  const seen = new Set<string>()
  const terms: string[] = []
  for (const token of tokenizeForFts(stripped).split(' ')) {
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    terms.push(token)
    if (terms.length >= FTS_QUERY_MAX_TERMS) break
  }
  return terms.map((term) => `"${term}"`).join(' ')
}
