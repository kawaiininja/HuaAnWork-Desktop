/**
 * Depth-degradation detection shared by the three-package acceptance probe
 * (review fix #3).
 *
 * Extracted verbatim from `huaanwork-accept-three-packages.mjs` so the detector
 * can be pinned by a unit test: the probe is a `.mjs` script that parses argv at
 * module top level, so it cannot be imported directly. Same pure-helper pattern
 * as `huaanwork-acceptance-redaction.mjs`.
 *
 * Affirmative depth-degradation claims only. A model that reports "未降级为单会话
 * 多轮自审" / "未触发深度降级" is describing the healthy path, and the typo-check
 * package always discloses the R1 same-model cross-validation downgrade
 * ("交叉验证已降级") — neither is a depth degradation. The affirmative set
 * therefore requires an explicit depth/lane phrase, not a bare `降级` or a bare
 * `maxDepth` mention.
 */
export function reportsDepthDegradation(text) {
  // The negation strip must consume the WHOLE negated clause, not just the
  // "未…降级" prefix: "未降级为单会话多轮自审" leaves "为单会话多轮自审" behind
  // (an affirmative phrase) if the tail is not stripped, and "不存在深度降级"
  // needs the verb 存在. Both otherwise false-FAIL a healthy run (review #3).
  const stripped = text
    .replace(/(?:未|并未|没有|不会|不能|无|不)(?:发生|出现|进行|被|触发|涉及|采用|存在)?\s*[*_]{0,4}(?:递归)?(?:深度)?降级(?:为单会话(?:多轮自审)?)?/gu, '')
    .replace(/(?:未|并未|没有|不会|不能|无|不)[^。；\n]{0,10}深度不足/gu, '')
    .replace(/(?:并非|不是|非)\s*[*_]{0,4}单会话多轮自审/gu, '')
  return /(?:递归)?深度不足|单会话多轮自审|非双盲|SubagentDepthError|降级为单会话|已降级为单会话|深度降级/u.test(stripped)
}