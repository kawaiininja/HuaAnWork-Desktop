import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** 与旧 sidecar host.ts:1596 逐字一致:会话 id 由 workspace 根哈希派生。 */
export function sessionIdFor(root: string): string {
  return `huaanwork-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}`
}
