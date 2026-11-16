/**
 * 创建流程共享的整句用语(智能体创建与对话创建技能同源)。
 *
 * 规范化只做两件事:去首尾空白、去掉结尾一个 `。！!？?`;夹带修改不算同意。
 */

const CONSENT_PHRASES = new Set(['可以', '确认', '同意', '就这样', '按这个建'])
const CANCEL_PHRASES = new Set(['取消', '先不要'])

export function normalizeCreationUtterance(text: string): string {
  return text.trim().replace(/[。！!？?]$/, '')
}

export function isCreationConsentText(text: string): boolean {
  return CONSENT_PHRASES.has(normalizeCreationUtterance(text))
}

export function isCreationCancelText(text: string): boolean {
  return CANCEL_PHRASES.has(normalizeCreationUtterance(text))
}
