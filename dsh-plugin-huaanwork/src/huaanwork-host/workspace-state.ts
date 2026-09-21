import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE_FILENAME = 'huaanwork-workspace.json'

/** 中立根:profile 目录下的 workspace(spec §4.2:旧 $DSH_HOME/workspace 概念落 profile 目录)。 */
export function neutralWorkspaceRoot(profileDir: string): string {
  const root = join(profileDir, 'workspace')
  mkdirSync(root, { recursive: true })
  return root
}

/** workspace.open 写入的待切换根;组合期消费一次,由 huaanwork-host 首个 effect 清除。 */
export function readPendingWorkspaceRoot(profileDir: string): string | null {
  const file = join(profileDir, STATE_FILENAME)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pendingRoot?: unknown }
    return typeof parsed.pendingRoot === 'string' && parsed.pendingRoot.length > 0 ? parsed.pendingRoot : null
  } catch {
    return null
  }
}

export function writePendingWorkspaceRoot(profileDir: string, root: string | null): void {
  const file = join(profileDir, STATE_FILENAME)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(root === null ? {} : { pendingRoot: root })}\n`, 'utf8')
  renameSync(tmp, file)
}
