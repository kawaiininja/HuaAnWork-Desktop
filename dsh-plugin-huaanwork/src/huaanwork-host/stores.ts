import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type {
  AutomationInfo,
  AutomationTemplate,
  ProjectInfo,
  RunSummary,
  TaskInfo,
} from '../client-huaanwork/rpc-types.ts'
import { AUTO_SESSION_PREFIX } from './automation-session-ids.ts'

/**
 * M4 域存储读路径(Task 10):projects / tasks / automations 的注册表与运行历史,
 * 逐字移植自旧 sidecar 的 projects.ts / tasks.ts / automations.ts(读路径段)。
 *
 * 存储根:旧 sidecar 传 $DSH_HOME;Desktop 组合下这些文件存于 profileDir
 * (与 settings.json 同目录,文件名与旧布局一致:projects.json / tasks.json /
 * automations.json / automations/<id>.runs.jsonl)。automations 的写路径
 * (create/update/remove 与纯函数)在 automations-store.ts,与本文件共用同一把
 * automationRegistryLock;run / pruneSessions 路由与调度器仍属后续任务。
 */

// —— projects(旧 projects.ts 逐字;参数 dshHome → storageRoot)——

type ProjectRegistry = { projects: ProjectInfo[] }

async function readProjectRegistry(storageRoot: string): Promise<ProjectRegistry> {
  try {
    const parsed = JSON.parse(await readFile(projectRegistryPath(storageRoot), 'utf8')) as Partial<ProjectRegistry>
    return { projects: Array.isArray(parsed.projects) ? parsed.projects.filter(isProjectInfo) : [] }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return { projects: [] }
    throw error
  }
}

async function writeProjectRegistry(storageRoot: string, registry: ProjectRegistry): Promise<void> {
  await mkdir(dirname(projectRegistryPath(storageRoot)), { recursive: true })
  await writeFile(projectRegistryPath(storageRoot), `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

function projectRegistryPath(storageRoot: string): string {
  return join(storageRoot, 'projects.json')
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.root === 'string' &&
    typeof candidate.createdAt === 'number'
  )
}

export async function listProjects(storageRoot: string): Promise<ProjectInfo[]> {
  return (await readProjectRegistry(storageRoot)).projects
    .slice()
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
}

export async function createProject(storageRoot: string, params: { name?: string; root: string }): Promise<ProjectInfo> {
  const root = typeof params.root === 'string' ? params.root.trim() : ''
  if (!root) throw new Error('project.create requires params.root')
  const info = await stat(root).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`project.create requires an existing directory: ${root}`)

  const registry = await readProjectRegistry(storageRoot)
  if (registry.projects.some((project) => project.root === root)) {
    throw new Error(`该目录已是项目：${registry.projects.find((project) => project.root === root)?.name ?? root}`)
  }

  const name = (typeof params.name === 'string' ? params.name.trim() : '') || basename(root) || root
  const project: ProjectInfo = { id: randomUUID(), name, root, createdAt: Date.now() }
  registry.projects.push(project)
  await writeProjectRegistry(storageRoot, registry)
  return project
}

export async function renameProject(storageRoot: string, projectId: string, name: string): Promise<ProjectInfo> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('project.rename requires a non-empty name')
  const registry = await readProjectRegistry(storageRoot)
  const project = registry.projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`project ${projectId} was not found`)
  project.name = trimmed
  await writeProjectRegistry(storageRoot, registry)
  return project
}

export async function removeProject(storageRoot: string, projectId: string): Promise<ProjectInfo> {
  const registry = await readProjectRegistry(storageRoot)
  const index = registry.projects.findIndex((item) => item.id === projectId)
  if (index < 0) throw new Error(`project ${projectId} was not found`)
  const removed = registry.projects[index]!
  registry.projects.splice(index, 1)
  await writeProjectRegistry(storageRoot, registry)
  return removed
}

/** 记录项目最近一次被打开(切换工作区)的时间,用于列表排序。 */
export async function touchProject(storageRoot: string, projectId: string): Promise<void> {
  const registry = await readProjectRegistry(storageRoot)
  const project = registry.projects.find((item) => item.id === projectId)
  if (!project) return
  project.lastOpenedAt = Date.now()
  await writeProjectRegistry(storageRoot, registry)
}

// —— tasks(旧 tasks.ts 逐字;参数 dshHome → storageRoot)——

type TaskRegistry = { tasks: TaskInfo[] }

/**
 * 注册表读改写互斥链(与 automations 的 withRegistryLock 同款):
 * bindSession/rename/remove 与 UI 侧的级联删除可能交错,串行化避免后写覆盖先写。
 * 读函数不加锁——读者看到完整旧态或新态即可。
 */
let taskRegistryLock: Promise<unknown> = Promise.resolve()

function withTaskRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = taskRegistryLock.then(fn)
  taskRegistryLock = run.catch(() => undefined)
  return run
}

function taskRegistryPath(storageRoot: string): string {
  return join(storageRoot, 'tasks.json')
}

function isTaskInfo(value: unknown): value is TaskInfo {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.createdAt === 'number'
  )
}

async function readTaskRegistry(storageRoot: string): Promise<TaskRegistry> {
  try {
    const parsed = JSON.parse(await readFile(taskRegistryPath(storageRoot), 'utf8')) as Partial<TaskRegistry>
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isTaskInfo) : [] }
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return { tasks: [] }
    throw error
  }
}

async function writeTaskRegistry(storageRoot: string, registry: TaskRegistry): Promise<void> {
  await mkdir(dirname(taskRegistryPath(storageRoot)), { recursive: true })
  await writeFile(taskRegistryPath(storageRoot), `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

export async function listTasks(storageRoot: string, projectId?: string): Promise<TaskInfo[]> {
  const all = (await readTaskRegistry(storageRoot)).tasks
  const scoped = projectId ? all.filter((task) => task.projectId === projectId) : all
  return scoped.slice().sort((a, b) => a.createdAt - b.createdAt)
}

export async function createTask(
  storageRoot: string,
  input: { projectId: string; name: string },
  now = Date.now(),
): Promise<TaskInfo> {
  const projectId = input.projectId.trim()
  const name = input.name.trim()
  if (!projectId) throw new Error('task requires projectId')
  if (!name) throw new Error('task requires a name')
  return withTaskRegistryLock(async () => {
    const registry = await readTaskRegistry(storageRoot)
    const task: TaskInfo = { id: randomUUID(), projectId, name, createdAt: now }
    registry.tasks.push(task)
    await writeTaskRegistry(storageRoot, registry)
    return task
  })
}

/** 绑定子任务的唯一会话(一对一:task 未绑、会话未被占才放行;重复绑同一会话幂等)。 */
export async function bindTaskSession(
  storageRoot: string,
  input: { taskId: string; sessionId: string },
): Promise<TaskInfo> {
  const taskId = input.taskId.trim()
  const sessionId = input.sessionId.trim()
  if (!taskId) throw new Error('bindSession requires taskId')
  if (!sessionId) throw new Error('bindSession requires sessionId')
  return withTaskRegistryLock(async () => {
    const registry = await readTaskRegistry(storageRoot)
    const task = registry.tasks.find((item) => item.id === taskId)
    if (!task) throw new Error(`task ${taskId} was not found`)
    if (task.sessionId === sessionId) return task
    if (task.sessionId) throw new Error(`task ${taskId} is already bound to session ${task.sessionId}`)
    const conflict = registry.tasks.find((item) => item.id !== taskId && item.sessionId === sessionId)
    if (conflict) throw new Error(`session ${sessionId} is already bound to task ${conflict.id}`)
    task.sessionId = sessionId
    await writeTaskRegistry(storageRoot, registry)
    return task
  })
}

/** 重命名子任务。 */
export async function renameTask(
  storageRoot: string,
  input: { taskId: string; name: string },
): Promise<TaskInfo> {
  const taskId = input.taskId.trim()
  const name = input.name.trim()
  if (!taskId) throw new Error('rename requires taskId')
  if (!name) throw new Error('rename requires a name')
  return withTaskRegistryLock(async () => {
    const registry = await readTaskRegistry(storageRoot)
    const task = registry.tasks.find((item) => item.id === taskId)
    if (!task) throw new Error(`task ${taskId} was not found`)
    task.name = name
    await writeTaskRegistry(storageRoot, registry)
    return task
  })
}

/** 删除单任务,返回被删任务(调用方级联清理其会话日志)。 */
export async function removeTask(storageRoot: string, taskId: string): Promise<TaskInfo> {
  return withTaskRegistryLock(async () => {
    const registry = await readTaskRegistry(storageRoot)
    const index = registry.tasks.findIndex((task) => task.id === taskId)
    if (index < 0) throw new Error(`task ${taskId} was not found`)
    const removed = registry.tasks[index]!
    registry.tasks.splice(index, 1)
    await writeTaskRegistry(storageRoot, registry)
    return removed
  })
}

/** 项目删除时级联清理该项目全部子任务,返回被删任务绑定过的 sessionId 列表。 */
export async function removeTasksOfProject(storageRoot: string, projectId: string): Promise<string[]> {
  return withTaskRegistryLock(async () => {
    const registry = await readTaskRegistry(storageRoot)
    const doomed = registry.tasks.filter((task) => task.projectId === projectId)
    if (doomed.length === 0) return []
    registry.tasks = registry.tasks.filter((task) => task.projectId !== projectId)
    await writeTaskRegistry(storageRoot, registry)
    return doomed.map((task) => task.sessionId).filter((id): id is string => typeof id === 'string')
  })
}

// —— automations 读路径(旧 automations.ts:376-387,713-754 逐字)。
// 写路径在 automations-store.ts,必须复用下面这把锁,禁止再造第二把。——

/** 每个任务保留的运行历史条数。 */
export const RUNS_LIMIT = 50
/** 自动化运行会话 id 前缀(级联删除用):`huaanwork-auto-<automationId>-<suffix>`(统一从 automation-session-ids.ts 引入并重新导出)。 */
export { AUTO_SESSION_PREFIX }

type AutomationRegistry = { automations: AutomationInfo[] }

/**
 * 注册表读改写周期的互斥链:级联删除(removeAutomationsOfProject)与 M4 写周期
 * 串行执行,避免并发周期互相覆盖丢更新。读函数不加锁——原子 rename 保证读者
 * 看到的是完整旧态或完整新态。
 */
let automationRegistryLock: Promise<unknown> = Promise.resolve()

export function withAutomationRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = automationRegistryLock.then(fn)
  // 操作抛错不能弄断链:吞掉错误后链继续。
  automationRegistryLock = run.catch(() => undefined)
  return run
}

function automationRegistryPath(storageRoot: string): string {
  return join(storageRoot, 'automations.json')
}

function isAutomationInfo(value: unknown): value is AutomationInfo {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    // projectId 可空(issue #2):null = 中立归属;放宽方向与 Phase 1 可选字段一致,不破坏旧记录。
    (typeof candidate.projectId === 'string' || candidate.projectId === null) &&
    typeof candidate.name === 'string' &&
    (candidate.kind === 'agent' || candidate.kind === 'script') &&
    candidate.schedule !== null &&
    typeof candidate.schedule === 'object' &&
    typeof candidate.createdAt === 'number'
  )
}

export async function readAutomationRegistry(storageRoot: string): Promise<AutomationRegistry> {
  const path = automationRegistryPath(storageRoot)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return { automations: [] }
    throw error
  }
  try {
    const parsed = JSON.parse(text) as Partial<AutomationRegistry>
    return { automations: Array.isArray(parsed.automations) ? parsed.automations.filter(isAutomationInfo) : [] }
  } catch {
    // 注册表损坏:改名留证后返回空表,绝不让 automation.list 持续失败。
    const backup = `${path}.corrupt-${Date.now()}`
    const renamed = await rename(path, backup).then(
      () => true,
      () => false,
    )
    console.error(
      renamed
        ? `[automations] 注册表损坏,已备份为 ${backup} 并重置为空表`
        : '[automations] 注册表损坏且备份改名失败,返回空表(下次写入将覆盖坏文件)',
    )
    return { automations: [] }
  }
}

export async function writeAutomationRegistry(storageRoot: string, registry: AutomationRegistry): Promise<void> {
  const path = automationRegistryPath(storageRoot)
  await mkdir(dirname(path), { recursive: true })
  // 先写临时文件再原子 rename:进程在写入中途崩溃也不会留下截断的注册表。
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export async function listAutomations(storageRoot: string, projectId?: string): Promise<AutomationInfo[]> {
  const all = (await readAutomationRegistry(storageRoot)).automations
  const scoped = projectId ? all.filter((item) => item.projectId === projectId) : all
  return scoped.slice().sort((a, b) => a.createdAt - b.createdAt)
}

export async function findAutomation(storageRoot: string, automationId: string): Promise<AutomationInfo> {
  const registry = await readAutomationRegistry(storageRoot)
  const automation = registry.automations.find((item) => item.id === automationId)
  if (!automation) throw new Error(`automation ${automationId} was not found`)
  return automation
}

function runsDir(storageRoot: string): string {
  return join(storageRoot, 'automations')
}

function runsPath(storageRoot: string, automationId: string): string {
  return join(runsDir(storageRoot), `${automationId}.runs.jsonl`)
}

/**
 * 级联删除运行会话目录:`<sessionsRoot>/<escaped-cwd>/huaanwork-auto-<automationId>-*`。
 * 会话 id 由运行侧铸造(前缀 + automationId + "-" + 后缀),按前缀匹配即可;目录不存在或个别 cwd
 * 读取失败都不炸(删除路径的容错优先于清理彻底)。
 * 注意:Desktop 组合下会话日志在 dshHome/sessions(不在 profileDir 下),调用方显式传根。
 */
export async function removeAutomationSessions(sessionsRoot: string, automationId: string): Promise<void> {
  const wantedPrefixes = [`${AUTO_SESSION_PREFIX}${automationId}-`]
  let cwds: string[]
  try {
    cwds = await readdir(sessionsRoot)
  } catch {
    return
  }
  await Promise.all(
    cwds.map(async (cwd) => {
      const cwdDir = join(sessionsRoot, cwd)
      let entries: string[]
      try {
        entries = await readdir(cwdDir)
      } catch {
        return
      }
      await Promise.all(
        entries
          .filter((entry) => wantedPrefixes.some((prefix) => entry.startsWith(prefix)))
          .map((entry) => rm(join(cwdDir, entry), { recursive: true, force: true }).catch(() => undefined)),
      )
    }),
  )
}

/** 项目删除时级联清理该项目全部任务及其运行历史。 */
export async function removeAutomationsOfProject(
  storageRoot: string,
  projectId: string,
  sessionsRoot: string = join(storageRoot, 'sessions'),
): Promise<void> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const doomed = registry.automations.filter((item) => item.projectId === projectId)
    if (doomed.length === 0) return
    registry.automations = registry.automations.filter((item) => item.projectId !== projectId)
    await writeAutomationRegistry(storageRoot, registry)
    await Promise.all(
      doomed.map((automation) => rm(runsPath(storageRoot, automation.id), { force: true }).catch(() => undefined)),
    )
    // Phase 2:无人值守降级审计行随项目级联一并清理(与 removeAutomation 同口径)。
    await Promise.all(
      doomed.map((automation) =>
        rm(join(runsDir(storageRoot), `${automation.id}.audit.jsonl`), { force: true }).catch(() => undefined),
      ),
    )
    await Promise.all(doomed.map((automation) => removeAutomationSessions(sessionsRoot, automation.id)))
  })
}

/** 最近的运行记录(新的在后);文件缺失或损坏时返回空数组。 */
export async function recentRuns(storageRoot: string, automationId: string, limit = RUNS_LIMIT): Promise<RunSummary[]> {
  let text: string
  try {
    text = await readFile(runsPath(storageRoot, automationId), 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
  const runs: RunSummary[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (
        typeof parsed.runId === 'string' &&
        typeof parsed.startedAt === 'number' &&
        typeof parsed.endedAt === 'number' &&
        typeof parsed.ok === 'boolean' &&
        typeof parsed.output === 'string'
      ) {
        // 校验白名单保持五字段不动(旧记录没有新字段也必须入列),
        // 缺省或非法的新字段在这里收敛为合法值:status 按 ok 推导,trigger 统一视为调度触发。
        // status/trigger 先剥离再回填:summary 的类型级可选值可能为 undefined,
        // exactOptionalPropertyTypes 下不得把显式 undefined 写回可选键。
        const { status: rawStatus, trigger: rawTrigger, ...rest } = parsed as unknown as RunSummary
        runs.push({
          ...rest,
          // 注:RunSummary['status'] 含 undefined(可选键索引),收敛结果显式收窄到合法字面量并集。
          status: (RUN_STATUSES.has(rawStatus as string) ? rawStatus : rest.ok ? 'ok' : 'error') as 'ok' | 'error' | 'missed' | 'timeout' | 'cancelled',
          trigger: (RUN_TRIGGERS.has(rawTrigger as string) ? rawTrigger : 'schedule') as 'manual' | 'schedule' | 'catchup',
        })
      }
    } catch {
      // 坏行跳过,绝不让历史展示因单条损坏记录失败。
    }
  }
  return runs.slice(-limit)
}

/** 运行状态合法值(recentRuns 收敛与 automation.runs 的 status 筛选共用)。 */
export const RUN_STATUSES: ReadonlySet<string> = new Set(['ok', 'error', 'missed', 'timeout', 'cancelled'])
const RUN_TRIGGERS: ReadonlySet<string> = new Set(['manual', 'schedule', 'catchup'])

// —— 内置任务模板(旧 templates.ts:23 逐字;资源照 skills 的 ../.. 原则)——

const TEMPLATES_PATH = join(import.meta.dirname, '..', '..', 'templates', 'automations.json')

/** 读取内置任务模板列表;文件缺失或格式错误直接抛错(模板随包分发,不该在运行期缺失)。 */
export async function readAutomationTemplates(): Promise<AutomationTemplate[]> {
  const text = await readFile(TEMPLATES_PATH, 'utf8')
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error('automations.json 模板文件格式错误:应为数组')
  return parsed as AutomationTemplate[]
}
