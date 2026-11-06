import { isAbsolute, relative, resolve } from 'node:path'

import { sessionIdFor } from './session-id.ts'
import { neutralWorkspaceRoot, neutralWorkspaceRootPath } from './workspace-state.ts'

/**
 * 会话可写根推导(规格 §5.1.1)。同步推导:projects / tasks / headerCwd 都由
 * 调用方先异步载入再传入,这里不读盘、不调 listProjects / listTasks /
 * findSessionHeader,也不检查根目录是否存在(不存在的根由会话发送路径拒绝启动)。
 * 推导唯一的副作用在结果上:只有中立根作为结果返回时创建 `<profile>/workspace`。
 *
 * 推导顺序(逐级回落,前一级命中即返回):
 * 1. 任务绑定:某任务 `sessionId` 正是本会话 ⇒ 用该任务 `projectId` 在 `projects`
 *    里同 id 项的 root。项目已从注册表消失时不做猜测,继续往下推导。
 * 2. 稳定会话 id:等于某项目根的 `sessionIdFor(root)` 或中立根的 `sessionIdFor(neutralRoot)`,
 *    或以对应稳定 id + '-' 开头。必须整段匹配稳定 id,不得用更短的哈希片段,也不能接受无
 *    `-` 的直接拼接。项目根与中立根同属这一步:同一 id 只可能等于其中一个根的稳定 id,
 *    两者检查的先后不影响结果;命中即返回,不再看 cwd。
 * 3. `header.cwd` 位于且仅位于一个项目根内(含等于根)。落在两个项目根内(如嵌套
 *    项目)属歧义,不猜,直接落到中立根。
 * 4. 中立根 `neutralWorkspaceRoot(profileDir)`。
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

  for (const project of projects) {
    const stable = sessionIdFor(project.root)
    if (sessionId === stable || sessionId.startsWith(`${stable}-`)) return resolve(project.root)
  }

  // 中立根也承载通道默认会话的稳定 id(规格 §5.1.1 第 2 步)。比较只用纯路径:
  // 中立目录只在它以结果身份被返回时创建,项目根推导不再顺带 mkdir。
  const neutralRoot = resolve(neutralWorkspaceRootPath(profileDir))
  const neutralStable = sessionIdFor(neutralRoot)
  if (sessionId === neutralStable || sessionId.startsWith(`${neutralStable}-`)) {
    return resolve(neutralWorkspaceRoot(profileDir))
  }

  const cwdRoot = soleContainingProjectRoot(projects, headerCwd)
  if (cwdRoot !== undefined) return cwdRoot

  return resolve(neutralWorkspaceRoot(profileDir))
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
