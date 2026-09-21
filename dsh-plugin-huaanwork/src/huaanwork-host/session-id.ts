import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

/** 与旧 sidecar host.ts:1596 逐字一致:会话 id 由 workspace 根哈希派生。 */
export function sessionIdFor(root: string): string {
  return `huaanwork-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}`
}

/** 每个新对话/任务的独立会话 id:稳定前缀 + 随机后缀(旧 host.ts:1602 原样移入)。 */
export function freshSessionIdFor(root: string): string {
  return `${sessionIdFor(root)}-${randomUUID().slice(0, 8)}`
}
