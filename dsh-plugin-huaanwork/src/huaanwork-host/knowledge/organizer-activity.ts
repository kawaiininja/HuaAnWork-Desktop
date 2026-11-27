/**
 * 知识库整理活动观察器(规格 §8.1 / M1-2 Task 1 产出,Task 5 看门狗消费)。
 *
 * 职责很窄:整理槽的 token/reasoning/工具/diff/压缩心跳与错误文案,经这里转给
 * 当前批次的 observer(空闲看门狗 touch、首个取消/超时原因 noteError)。表里只保存
 * 当前活跃的整理槽;注册同一 id 即替换旧 observer,disposer 按对象身份删除,防止
 * 旧 Host 的晚到退场清掉新 Host 注册。
 */

export type KnowledgeOrganizerActivity =
  | 'token'
  | 'reasoning'
  | 'tool/start'
  | 'tool/end'
  | 'diff'
  | 'compaction/done'

export interface KnowledgeOrganizerActivityObserver {
  touch(kind: KnowledgeOrganizerActivity): void
  noteError(message: string): void
}

const observers = new Map<string, KnowledgeOrganizerActivityObserver>()

/**
 * 注册(或替换)某整理槽的活动 observer;返回所有权校验的 disposer。
 * 只注销仍属于本次注册的 observer:同一 id 被新批次覆盖后,旧 disposer 是 no-op。
 */
export function registerKnowledgeOrganizerActivity(
  sessionId: string,
  observer: KnowledgeOrganizerActivityObserver,
): () => void {
  observers.set(sessionId, observer)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (observers.get(sessionId) === observer) observers.delete(sessionId)
  }
}

/** 记录一次整理活动;未注册或非字符串 id 为 no-op。 */
export function noteKnowledgeOrganizerActivity(
  sessionId: string | undefined,
  kind: KnowledgeOrganizerActivity,
): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  observers.get(sessionId)?.touch(kind)
}

/** 记录一条整理错误;未注册或非字符串 id 为 no-op。 */
export function noteKnowledgeOrganizerError(sessionId: string | undefined, message: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  observers.get(sessionId)?.noteError(message)
}
