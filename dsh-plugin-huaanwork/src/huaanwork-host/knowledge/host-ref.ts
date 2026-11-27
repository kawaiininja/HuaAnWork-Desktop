/**
 * 知识库 Host 的进程内引用(M1-2 Task 3)。
 *
 * 知识库宿主在顶层 knowledge effect 中创建,三个 `kb_org_*` 工具在后面的 tools
 * effect 中全局注册。工具执行时经本模块取当前宿主,不把 knowledge effect 的局部
 * 变量透进 toolCtx,也不另建第二个 StorageClient/Worker。
 *
 * setter 返回按宿主身份注销的 disposer:旧 Host 的晚到退场不得摘除新 Host。
 */

import type { KnowledgeHost } from './host.ts'

let currentKnowledgeHost: KnowledgeHost | undefined

/**
 * 注入当前知识库宿主。
 *
 * @param host 本次进程内唯一的 KnowledgeHost
 * @returns 所有权校验的 disposer;仅当当前宿主仍是 `host` 时才清空引用
 */
export function setKnowledgeHost(host: KnowledgeHost): () => void {
  currentKnowledgeHost = host
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (currentKnowledgeHost === host) currentKnowledgeHost = undefined
  }
}

/** 当前知识库宿主;尚未接线(Task 6)或已退场时为 `undefined`,调用方 fail closed。 */
export function getKnowledgeHost(): KnowledgeHost | undefined {
  return currentKnowledgeHost
}
