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
 * 铸造入口也引用同一模块);fs 以窄接口注入(默认 node:fs/promises),测试用计数桩钉
 * 「一个宿主进程只读一次会话日志」(裁定 R-6.12-1)。
 *
 * 生产调用点是 apply()(每次 generation 重启都跑),而本清扫要解压会话日志读 cwd ——
 * 故经 sweepProjectLegacySessionsOncePerProcess 的进程级门闩包裹:整个宿主进程只扫一次
 * (旧 sidecar host.ts:936 就是「进程启动只扫一次」语义);chat-auto 清扫不走门闩。
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
 * 项目存量清扫的文件系统缝(裁定 R-6.12-1 的 read/readdir 计数用):默认实现 =
 * node:fs/promises + session-view;测试注入计数桩钉「一个宿主进程只读一次会话日志」。
 */
export interface ProjectLegacySweepFileSystem {
  /** 目录枚举(带类型):顶层 sessions/ 与 cwd 目录各一次,不进入会话目录内部。 */
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  /** 会话目录内的日志文件名枚举。 */
  readEntryNames(path: string): Promise<string[]>
  /** 读会话日志首行 header:本清扫唯一读整份日志(含 .jsonl.zstd 逐帧解压)的地方。 */
  readHeader(path: string): Promise<Record<string, unknown> | undefined>
  remove(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>
}

const nodeProjectLegacySweepFileSystem: ProjectLegacySweepFileSystem = {
  readdir: (path, options) => readdir(path, options),
  readEntryNames: (path) => readdir(path),
  readHeader: (path) => readSessionHeader(path),
  remove: (path, options) => rm(path, options),
}

/**
 * 删除「cwd 落在任一已登记项目根内、且 id 不被任何 task.sessionId 引用」的会话日志。
 * 单文件失败记 skipped 并继续(容错优先于彻底);sessions 目录不存在即 no-op。
 *
 * protectedRoots(规格 §1.3):中立根 $DSH_HOME/workspace 下的游离会话永不清扫——
 * 即使某个登记的项目根恰好是中立根的祖先目录(cwd 前缀命中该项目根),只要 cwd 也落在
 * protectedRoots 内就优先保留。调用方传入 [defaultWorkspaceRoot]。
 *
 * 顺序说明(R-6.12-1 第 3 条):`cwd 归属`判定的原料 header.cwd 只能从日志里读出,
 * 而 cwd 目录名(dsh 的 escaped-cwd)不是可反推根的判据 ⇒ 「先判归属、再读日志」不可行,
 * 保持「每 cwd 目录读一份 header」的原顺序。唯一的零 I/O 情形是**没有登记任何项目根**
 * (判据恒不成立),此时连顶层 readdir 都不做,直接返回(见函数体首行)。
 */
export async function sweepProjectLegacySessions(
  sessionsRoot: string,
  projectRoots: readonly string[],
  referencedSessionIds: ReadonlySet<string>,
  protectedRoots: readonly string[] = [],
  fileSystem: ProjectLegacySweepFileSystem = nodeProjectLegacySweepFileSystem,
): Promise<{ removed: number; skipped: number }> {
  // 无登记项目根 ⇒ 删除判据恒不成立:零 I/O 返回(评审 R-6.12-1 点名的
  // 「零登记项目时每个 cwd 目录仍付一次整份日志解压」情形,在这里被直接短路)。
  if (projectRoots.length === 0) return { removed: 0, skipped: 0 }
  let entries: Dirent[]
  try {
    entries = await fileSystem.readdir(sessionsRoot, { withFileTypes: true })
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
        items = await fileSystem.readdir(path, { withFileTypes: true })
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
            const sub = (await fileSystem.readEntryNames(join(path, item.name))).filter(isLogFile)
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
        const header = await fileSystem.readHeader(sampleLogFile)
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
            const header = await fileSystem.readHeader(join(path, item.name))
            if (shouldKeepSession(header, referencedSessionIds)) continue
            await fileSystem.remove(join(path, item.name), { force: true })
            removed += 1
          } catch {
            skipped += 1
          }
        } else if (item.isDirectory()) {
          try {
            const dirPath = join(path, item.name)
            const sub = (await fileSystem.readEntryNames(dirPath)).filter(isLogFile)
            const first = sub[0]
            if (first === undefined) continue
            const header = await fileSystem.readHeader(join(dirPath, first))
            if (shouldKeepSession(header, referencedSessionIds)) continue
            await fileSystem.remove(dirPath, { recursive: true, force: true })
            removed += 1
          } catch {
            skipped += 1
          }
        }
      }
    } else if (entry.isFile() && isLogFile(entry.name)) {
      // 顶层散文件(历史布局残留):读自身 header 判定。
      try {
        const header = await fileSystem.readHeader(path)
        const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
        if (
          !cwdWithinAnyRoot(cwd, protectedRoots) &&
          cwdWithinAnyRoot(cwd, projectRoots) &&
          !shouldKeepSession(header, referencedSessionIds)
        ) {
          await fileSystem.remove(path, { force: true })
          removed += 1
        }
      } catch {
        skipped += 1
      }
    }
  }
  return { removed, skipped }
}

/**
 * 进程级一次性门闩(裁定 R-6.12-1 第 2 条):`apply()` 每次 generation 重启都会执行,
 * 而本清扫要解压会话日志读 cwd ⇒ 整个宿主进程只扫一次(旧 sidecar host.ts:936 就是
 * 「进程启动只扫一次」)。**为什么用 globalThis + Symbol.for**:模块级变量的门闩在模块图
 * 被重建/重新求值时会静默重置(退回每代都扫),而 `Symbol.for` 全局注册表里的槽位不随
 * 模块求值重置、也不与任何其他状态耦合。退化路径:若宿主每代都跑在全新 realm
 * (globalThis 不共享),门闩失效 ⇒ 行为退回今天的「每次 generation 一扫」,无正确性变化。
 */
const PROJECT_LEGACY_SWEEP_SENTINEL = Symbol.for('huaanwork.host.project-legacy-sweep.done')

export interface ProjectLegacySweepAttempt {
  /** 本次调用是否真正执行了清扫(false = 本进程此前已扫过,直接跳过)。 */
  ran: boolean
  removed: number
  skipped: number
}

/**
 * 门闩包裹体:本进程首次调用执行清扫;其后(如 workspace.open 触发的 generation 重启)
 * 直接返回 `{ ran: false }`,不再读任何会话日志。先落闩再扫:清扫抛错也只尝试一次
 * (与旧 host.ts:936 同语义),失败由调用方记日志,新的宿主进程会再试(门闩是进程域,
 * 不是磁盘标记)。
 */
export async function sweepProjectLegacySessionsOncePerProcess(
  sessionsRoot: string,
  projectRoots: readonly string[],
  referencedSessionIds: ReadonlySet<string>,
  protectedRoots: readonly string[] = [],
  fileSystem: ProjectLegacySweepFileSystem = nodeProjectLegacySweepFileSystem,
): Promise<ProjectLegacySweepAttempt> {
  const latch = globalThis as unknown as Record<symbol, boolean | undefined>
  if (latch[PROJECT_LEGACY_SWEEP_SENTINEL] === true) return { ran: false, removed: 0, skipped: 0 }
  latch[PROJECT_LEGACY_SWEEP_SENTINEL] = true
  const { removed, skipped } = await sweepProjectLegacySessions(
    sessionsRoot,
    projectRoots,
    referencedSessionIds,
    protectedRoots,
    fileSystem,
  )
  return { ran: true, removed, skipped }
}

/** 测试缝:清除门闩以模拟「新的宿主进程」(门闩本就随进程生灭;单测需在一个 vitest 进程里演两代)。 */
export function resetProjectLegacySweepLatch(): void {
  delete (globalThis as unknown as Record<symbol, boolean | undefined>)[PROJECT_LEGACY_SWEEP_SENTINEL]
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
