import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { sessionIdFor } from './session-id.ts'
import {
  neutralAutomationRootPath,
  neutralAutomationsBaseDir,
  neutralSessionRootPath,
  neutralWorkspaceRoot,
  neutralWorkspaceRootPath,
} from './workspace-state.ts'

/**
 * 会话可写根推导(规格 §3.2.3)。projects / tasks / headerCwd 由调用方先载入再传入。
 * 这里不调 listProjects / listTasks / findSessionHeader，也不创建 workspace-sessions。
 * 中立前缀的已铸造会话至多做两次 existsSync + statSync 检查，用来确认目录已由 session.new 建好。
 * 删掉这次读取后，刚铸造、尚未写 header 的会话会掉回共享 workspace。
 *
 * 推导顺序(前一级命中即返回):
 * 1. 任务绑定。
 * 2. 项目稳定 id。例外:项目根解析后等于中立 workspace，且会话 id 以中立稳定 id 加 `-`
 *    开头，并且 workspace-sessions/<sessionId> 已存在或 headerCwd 在该目录内时，
 *    不返回这个项目。恰好等于 work-1 稳定 id 的会话仍返回 workspace。
 * 3. 中立稳定 id 与中立前缀。前缀会话只认 workspace 内的存量 cwd、已铸造的会话目录，
 *    以及「目录已存在且还没有 header」。其余情况返回 workspace，不再按 cwd 改判到其他项目。
 * 4. 非中立前缀时，header.cwd 位于且仅位于一个项目根内。
 * 5. 非中立前缀时，header.cwd 位于 workspace-automations/<automationId>。
 * 6. 中立根。只有中立根作为结果返回时才创建 <profile>/workspace。
 */
export function writableRootForSession(input: {
  profileDir: string
  sessionId: string
  projects: readonly { id: string; root: string }[]
  tasks: readonly { sessionId?: string; projectId: string }[]
  headerCwd?: string | undefined
}): string {
  const { profileDir, sessionId, projects, tasks, headerCwd } = input

  const boundTask = tasks.find((task) => task.sessionId === sessionId)
  if (boundTask) {
    const project = projects.find((item) => item.id === boundTask.projectId)
    if (project) return resolve(project.root)
  }

  const neutralRoot = resolve(neutralWorkspaceRootPath(profileDir))
  const neutralStable = sessionIdFor(neutralRoot)
  const neutralPrefixed = sessionId.startsWith(`${neutralStable}-`)
  // 非法分量在这里抛错，不回落到共享 workspace。合法 id 只是拼出路径，不建目录。
  const mintedRoot = neutralPrefixed
    ? resolve(neutralSessionRootPath(profileDir, sessionId))
    : undefined
  const mintedDirectoryReady = mintedRoot !== undefined
    && (
      (typeof headerCwd === 'string' && headerCwd.length > 0 && isInside(mintedRoot, headerCwd))
      || (existsSync(mintedRoot) && statSync(mintedRoot).isDirectory())
    )

  for (const project of projects) {
    const projectRoot = resolve(project.root)
    const stable = sessionIdFor(project.root)
    if (sessionId !== stable && !sessionId.startsWith(`${stable}-`)) continue
    // D3: workspace 被登记成项目时，已铸造的会话目录优先。work-1 的精确稳定 id 不带 `-` 后缀，不会进这个分支。
    if (projectRoot === neutralRoot && mintedDirectoryReady) continue
    return projectRoot
  }

  if (sessionId === neutralStable) {
    return resolve(neutralWorkspaceRoot(profileDir))
  }
  if (neutralPrefixed && mintedRoot !== undefined) {
    if (typeof headerCwd === 'string' && headerCwd.length > 0) {
      if (isInside(neutralRoot, headerCwd)) {
        return resolve(neutralWorkspaceRoot(profileDir))
      }
      if (isInside(mintedRoot, headerCwd)) {
        return mintedRoot
      }
    } else if (existsSync(mintedRoot) && statSync(mintedRoot).isDirectory()) {
      return mintedRoot
    }
    // D4: 中立前缀的其余情况留在 workspace，不落到下面的项目 cwd / 自动化目录识别。
    return resolve(neutralWorkspaceRoot(profileDir))
  }

  const cwdRoot = soleContainingProjectRoot(projects, headerCwd)
  if (cwdRoot !== undefined) return cwdRoot

  const autoRoot = containingAutomationRoot(profileDir, headerCwd)
  if (autoRoot !== undefined) return autoRoot

  return resolve(neutralWorkspaceRoot(profileDir))
}

function containingAutomationRoot(profileDir: string, headerCwd: string | undefined): string | undefined {
  if (typeof headerCwd !== 'string' || headerCwd.length === 0) return undefined
  const base = resolve(neutralAutomationsBaseDir(profileDir))
  const rel = relative(base, resolve(headerCwd))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const firstSegment = rel.split(sep)[0]
  if (!firstSegment) return undefined
  return resolve(neutralAutomationRootPath(profileDir, firstSegment))
}

/**
 * `header.cwd` 唯一所属的项目根;没有命中或多于一个根命中时返回 undefined。
 * 同一目录被登记两次不算歧义(两个 id 指向同一个根,结论一致),按去重后的根计数。
 */
function soleContainingProjectRoot(
  projects: readonly { root: string }[],
  headerCwd: string | undefined,
): string | undefined {
  if (typeof headerCwd !== 'string' || headerCwd.length === 0) return undefined
  const matched = new Set<string>()
  for (const project of projects) {
    const root = resolve(project.root)
    if (isInside(root, headerCwd)) matched.add(root)
  }
  if (matched.size !== 1) return undefined
  const [only] = matched
  return only
}

/** 「等于根或在根之内」,与 `huaanwork-guardrails/sandbox-cwd.ts` 的 isInside 同规则。 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
