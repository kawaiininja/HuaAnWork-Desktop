import type { Dirent } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

import { AUTO_SESSION_PREFIX, LEGACY_CHAT_AUTO_SESSION_PREFIX } from './automation-session-ids.ts'
import { readSessionHeader } from './session-view.ts'

/**
 * 项目存量会话的一次性启动清扫 + 级联删除辅助。
 *
 * 判据与 huaanwork-chat-auto-* 的前缀清扫不同:这里是「cwd 归属 + task 引用」判定。
 * 会话存储可能为两级结构 sessions/<escaped-cwd>/<sessionId>.jsonl[.zstd]
 * 或三级结构 sessions/<escaped-cwd>/<sessionId>/session.jsonl[.zstd](dsh 原生),
 * 同目录会话共享 cwd,因此每个 cwd 目录只读一份 header 判定是否落在项目根内(O(cwd 目录数)),
 * 命中项目根的目录再逐文件/子目录读 header.id 与引用集合比对。
 *
 * 定向改动(相对旧 sidecar session-sweep.ts):sessions 根由调用方显式传入
 * (旧版在函数内 join(dshHome, "sessions"),与 settings 同原则);
 * 自动化前缀常量改自本目录 automation-session-ids.ts(Task 10 的 automations 域
 * 铸造入口也引用同一模块)。
 */

function isLogFile(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')
}

/** 与 sessions.ts sessionWithinRoot 同语义:resolve 后做「等于或前缀+分隔符」比较。 */
function cwdWithinAnyRoot(cwd: string | undefined, roots: readonly string[]): boolean {
  if (!cwd) return false
  const dir = resolve(cwd)
  return roots.some((root) => {
    const base = resolve(root)
    return dir === base || dir.startsWith(`${base}${sep}`)
  })
}

/**
 * 逐文件删除前的保留判定(规格 §1.3 排除清单,计划评审 P1-1/P3-2):
 * - 被 task.sessionId 引用的会话;
 * - 自动化运行会话(huaanwork-auto- 前缀;旧 huaanwork-chat-auto- 前缀兜底——正常已被
 *   启动清扫 automation-sweep.ts 的 sweepLegacyChatAutoSessions 清掉,这里是清扫失败
 *   残留的保险);
 * - 非 topLevel 日志(origin=subagent / 有 parentSession 的子代理日志,与 session.list 口径一致:
 *   UI 从不展示它们,父日志仍含工具调用摘要,不随清扫误删)。
 */
function shouldKeepSession(header: Record<string, unknown> | undefined, referencedSessionIds: ReadonlySet<string>): boolean {
  const id = typeof header?.id === 'string' ? header.id : undefined
  if (id && referencedSessionIds.has(id)) return true
  if (id && (id.startsWith(AUTO_SESSION_PREFIX) || id.startsWith(LEGACY_CHAT_AUTO_SESSION_PREFIX))) return true
  if (header?.origin === 'subagent' || typeof header?.parentSession === 'string') return true
  return false
}

/**
 * 删除「cwd 落在任一已登记项目根内、且 id 不被任何 task.sessionId 引用」的会话日志。
 * 单文件失败记 skipped 并继续(容错优先于彻底);sessions 目录不存在即 no-op。
 *
 * protectedRoots(规格 §1.3):中立根 $DSH_HOME/workspace 下的游离会话永不清扫——
 * 即使某个登记的项目根恰好是中立根的祖先目录(cwd 前缀命中该项目根),只要 cwd 也落在
 * protectedRoots 内就优先保留。调用方传入 [defaultWorkspaceRoot]。
 */
export async function sweepProjectLegacySessions(
  sessionsRoot: string,
  projectRoots: readonly string[],
  referencedSessionIds: ReadonlySet<string>,
  protectedRoots: readonly string[] = [],
): Promise<{ removed: number; skipped: number }> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return { removed: 0, skipped: 0 }
  }
  let removed = 0
  let skipped = 0
  for (const entry of entries) {
    const path = join(sessionsRoot, entry.name)
    if (entry.isDirectory()) {
      let items: Dirent[]
      try {
        items = await readdir(path, { withFileTypes: true })
      } catch {
        skipped += 1
        continue
      }
      if (items.length === 0) continue
      // 目录级判定:同目录共享 cwd,只读一份 header。
      let sampleLogFile: string | undefined
      for (const item of items) {
        if (item.isFile() && isLogFile(item.name)) {
          sampleLogFile = join(path, item.name)
          break
        }
        if (item.isDirectory()) {
          try {
            const sub = (await readdir(join(path, item.name))).filter(isLogFile)
            const first = sub[0]
            if (first !== undefined) {
              sampleLogFile = join(path, item.name, first)
              break
            }
          } catch {
            // 忽略读取子目录失败
          }
        }
      }
      if (!sampleLogFile) continue

      let dirCwd: string | undefined
      try {
        const header = await readSessionHeader(sampleLogFile)
        dirCwd = typeof header?.cwd === 'string' ? header.cwd : undefined
      } catch {
        skipped += 1
        continue
      }
      if (cwdWithinAnyRoot(dirCwd, protectedRoots)) continue
      if (!cwdWithinAnyRoot(dirCwd, projectRoots)) continue
      for (const item of items) {
        if (item.isFile() && isLogFile(item.name)) {
          try {
            const header = await readSessionHeader(join(path, item.name))
            if (shouldKeepSession(header, referencedSessionIds)) continue
            await rm(join(path, item.name), { force: true })
            removed += 1
          } catch {
            skipped += 1
          }
        } else if (item.isDirectory()) {
          try {
            const dirPath = join(path, item.name)
            const sub = (await readdir(dirPath)).filter(isLogFile)
            const first = sub[0]
            if (first === undefined) continue
            const header = await readSessionHeader(join(dirPath, first))
            if (shouldKeepSession(header, referencedSessionIds)) continue
            await rm(dirPath, { recursive: true, force: true })
            removed += 1
          } catch {
            skipped += 1
          }
        }
      }
    } else if (entry.isFile() && isLogFile(entry.name)) {
      // 顶层散文件(历史布局残留):读自身 header 判定。
      try {
        const header = await readSessionHeader(path)
        const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
        if (
          !cwdWithinAnyRoot(cwd, protectedRoots) &&
          cwdWithinAnyRoot(cwd, projectRoots) &&
          !shouldKeepSession(header, referencedSessionIds)
        ) {
          await rm(path, { force: true })
          removed += 1
        }
      } catch {
        skipped += 1
      }
    }
  }
  return { removed, skipped }
}

/** 级联删除:按 header.id 定位并删除会话日志;返回删除数。未命中不计错。 */
export async function removeSessionFilesById(sessionsRoot: string, sessionIds: readonly string[]): Promise<number> {
  if (sessionIds.length === 0) return 0
  const wanted = new Set(sessionIds)
  let entries: Dirent[]
  try {
    entries = await readdir(sessionsRoot, { recursive: true, withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !isLogFile(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    try {
      const header = await readSessionHeader(path)
      const id = typeof header?.id === 'string' ? header.id : undefined
      if (id && wanted.has(id)) {
        const parentDir = entry.parentPath
        if (basename(parentDir) === id) {
          await rm(parentDir, { recursive: true, force: true })
        } else {
          await rm(path, { force: true })
        }
        removed += 1
      }
    } catch {
      // 单文件失败跳过,级联删除不阻断主流程。
    }
  }
  return removed
}
