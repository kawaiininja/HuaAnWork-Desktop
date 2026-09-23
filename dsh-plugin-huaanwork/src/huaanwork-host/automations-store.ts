import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AutomationInfo, AutomationSchedule, RunSummary } from '../client-huaanwork/rpc-types.ts'
import { isAutomationSessionEntry } from './automation-session-ids.ts'
import { nextFireAfter, parseCron, periodOf } from './schedule.ts'
import {
  RUNS_LIMIT,
  readAutomationRegistry,
  recentRuns,
  removeAutomationSessions,
  withAutomationRegistryLock,
  writeAutomationRegistry,
} from './stores.ts'

/**
 * 任务注册表写路径与调度纯函数(旧 automations.ts 的 create/update/remove、
 * normalize、missed/due/expired、prune、advanceNextRunAt)。
 *
 * 注册表锁只有 stores.ts 里那一把:本文件的写周期全部走
 * {@link withAutomationRegistryLock},与 removeAutomationsOfProject 串行。
 * parseCron / nextFireAfter / periodOf 从 ./schedule.ts 再导出;humanizeCron
 * 留在 schedule.ts,只给迁移测试用,不接任何展示路径。
 */

export { nextFireAfter, parseCron, periodOf }

/** 错过宽限:过期在该窗口内照常补跑;超过则不执行,记一条 missed 并推进 nextRunAt。 */
export const MISSED_GRACE_MS = 10 * 60_000
/** 提示词入库前的 UTF-8 字节上限(8 KB,按字节数而非字符数计)。 */
export const PROMPT_MAX_BYTES = 8 * 1024
/** 任务总数上限:注册表读改写周期内防膨胀的最后防线。 */
export const MAX_AUTOMATIONS = 50

/**
 * 无人值守授权可表达的工具名全集。`run_code` 永远不在这个集合里——
 * 即便调用方塞进 allow,sanitize 也会剔除。
 */
export const UNATTENDED_TOOL_NAMES = [
  'read',
  'read_file',
  'glob',
  'grep',
  'edit',
  'write',
  'str_replace_editor',
  'bash',
  'pwsh',
] as const
export type UnattendedToolName = (typeof UNATTENDED_TOOL_NAMES)[number]

/** 打开无人值守但未显式给 allow 时的默认白名单:只读 + 写/编辑,不含 bash/pwsh。 */
export const UNATTENDED_DEFAULT_ALLOW: UnattendedToolName[] = [
  'read',
  'read_file',
  'glob',
  'grep',
  'edit',
  'write',
  'str_replace_editor',
]

export type AutomationInput = {
  /** 项目归属:null = 中立。创建后不可改(update 白名单不含 projectId)。 */
  projectId: string | null
  name: string
  kind: 'agent' | 'script'
  schedule: AutomationSchedule
  prompt?: string
  command?: string
  widget: boolean
  enabled: boolean
  expiresAt?: number
  missedPolicy?: 'skip' | 'run-once'
  taskShape?: 'independent' | 'merged'
  unattended?: { enabled: boolean; allow: string[] }
}

/** 校验并规范化前端提交的任务字段;任何缺失/非法字段直接抛错。 */
export function normalizeAutomationInput(params: Record<string, unknown>, now = Date.now()): AutomationInput {
  if (params.projectId !== undefined && params.projectId !== null && typeof params.projectId !== 'string') {
    throw new Error('automation.projectId 必须是字符串或 null')
  }
  const projectId = optionalString(params.projectId) ?? null
  const name = requiredString(params, 'name', 'automation requires a name')
  const kind = params.kind
  if (kind !== 'agent' && kind !== 'script') throw new Error('automation.kind must be "agent" or "script"')

  const schedule = normalizeSchedule(params.schedule, now)
  const prompt = optionalString(params.prompt)
  if (prompt && new TextEncoder().encode(prompt).length > PROMPT_MAX_BYTES) {
    throw new Error('提示词过长（超过 8 KB），请精简 prompt')
  }
  const command = optionalString(params.command)
  if (kind === 'agent' && !prompt) throw new Error('agent 任务必须填写提示词（prompt）')
  if (kind === 'script' && !command) throw new Error('脚本任务必须填写命令（command）')

  return {
    projectId,
    name,
    kind,
    schedule,
    ...(prompt ? { prompt } : {}),
    ...(command ? { command } : {}),
    widget: params.widget === true,
    enabled: params.enabled !== false,
    ...(typeof params.expiresAt === 'number' ? { expiresAt: params.expiresAt } : {}),
    ...(params.missedPolicy === 'skip' || params.missedPolicy === 'run-once' ? { missedPolicy: params.missedPolicy } : {}),
    ...(params.taskShape === 'independent' || params.taskShape === 'merged' ? { taskShape: params.taskShape } : {}),
    ...(params.unattended !== undefined ? { unattended: normalizeUnattended(params.unattended) } : {}),
  }
}

function normalizeUnattended(value: unknown): { enabled: boolean; allow: string[] } {
  if (value === null || typeof value !== 'object') throw new Error('automation.unattended 必须是对象')
  const raw = value as Record<string, unknown>
  const enabled = raw.enabled === true
  const provided = Array.isArray(raw.allow) ? raw.allow : undefined
  const source = provided ?? (enabled ? UNATTENDED_DEFAULT_ALLOW : [])
  return { enabled, allow: sanitizeUnattendedAllow(source) }
}

/** 白名单过滤 + 去重,保留原始顺序;未知工具名(含 run_code)一律剔除。 */
function sanitizeUnattendedAllow(list: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    if (!(UNATTENDED_TOOL_NAMES as readonly string[]).includes(item)) continue
    seen.add(item)
  }
  return [...seen]
}

function normalizeSchedule(value: unknown, now = Date.now()): AutomationSchedule {
  if (value === null || typeof value !== 'object') throw new Error('automation requires schedule')
  const schedule = value as Record<string, unknown>
  switch (schedule.kind) {
    case 'manual':
      return { kind: 'manual' }
    case 'once': {
      const at = Number(schedule.at)
      if (!Number.isFinite(at)) throw new Error('once 任务要求 at 为触发时间戳（epoch 毫秒）')
      if (at <= now) throw new Error('once 任务的触发时间已过去，请选择一个未来时刻')
      return { kind: 'once', at }
    }
    case 'interval': {
      const minutes = Number(schedule.minutes)
      if (!Number.isInteger(minutes) || minutes < 1) throw new Error('interval 任务要求 minutes 为不小于 1 的整数')
      return { kind: 'interval', minutes }
    }
    case 'hourly': {
      const minute = Number(schedule.minute)
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('hourly 任务要求 minute 为 0-59 的整数')
      return { kind: 'hourly', minute }
    }
    case 'daily':
      return { kind: 'daily', time: normalizeClockTime(schedule.time, 'daily') }
    case 'weekly':
      return { kind: 'weekly', days: normalizeDayList(schedule.days), time: normalizeClockTime(schedule.time, 'weekly') }
    case 'monthly':
      return { kind: 'monthly', dates: normalizeDateList(schedule.dates), time: normalizeClockTime(schedule.time, 'monthly') }
    case 'cron': {
      const expr = typeof schedule.expr === 'string' ? schedule.expr.trim() : ''
      parseCron(expr)
      return { kind: 'cron', expr }
    }
    default:
      throw new Error('schedule.kind 必须是 manual / once / interval / hourly / daily / weekly / monthly / cron')
  }
}

function normalizeDayList(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('weekly 任务要求 days 为星期列表（0-6 的整数，周日可用 0 或 7）')
  const days = new Set<number>()
  for (const item of value) {
    const day = Number(item)
    if (!Number.isInteger(day) || day < 0 || day > 7) {
      throw new Error('weekly 任务的 days 元素必须是 0-6 的整数（周日可用 0 或 7）')
    }
    days.add(day === 7 ? 0 : day)
  }
  if (days.size === 0) throw new Error('weekly 任务至少选择一天（days 不能为空）')
  return [...days].sort((a, b) => a - b)
}

function normalizeDateList(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('monthly 任务要求 dates 为日期列表（1-31 的整数）')
  const dates = new Set<number>()
  for (const item of value) {
    const date = Number(item)
    if (!Number.isInteger(date) || date < 1 || date > 31) throw new Error('monthly 任务的 dates 元素必须是 1-31 的整数')
    dates.add(date)
  }
  if (dates.size === 0) throw new Error('monthly 任务至少选择一天（dates 不能为空）')
  return [...dates].sort((a, b) => a - b)
}

function normalizeClockTime(value: unknown, kindLabel: string): string {
  const time = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`${kindLabel} 任务要求 time 为 HH:MM`)
  const [hour, minute] = time.split(':').map(Number)
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) {
    throw new Error(`${kindLabel} 任务的 time 超出合法范围`)
  }
  return time
}

function requiredString(params: Record<string, unknown>, key: string, message: string): string {
  const value = typeof params[key] === 'string' ? (params[key] as string).trim() : ''
  if (!value) throw new Error(message)
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * 到期任务:启用中、非 manual、nextRunAt 已过期、且仍在宽限窗口内(边界等于宽限算 due)。
 * 超过宽限的由 {@link missedAutomations} 处理,两个列表互斥。
 */
export function dueAutomations(list: AutomationInfo[], now: number, graceMs: number = MISSED_GRACE_MS): AutomationInfo[] {
  return list.filter((item) => {
    if (!item.enabled || item.schedule.kind === 'manual') return false
    if (item.nextRunAt === undefined) return false
    return item.nextRunAt <= now && now - item.nextRunAt <= graceMs
  })
}

export type MissedAutomation = {
  automation: AutomationInfo
  nextRunAt?: number
  disable?: boolean
  policy: 'skip' | 'run-once'
  coalescedCount: number
}

/**
 * 错过宽限的任务。once 错过特判为 disable(nextFireAfter 对已过的 at 返回 undefined,
 * 不特判会被数据异常分支吞掉)。
 */
export function missedAutomations(
  list: AutomationInfo[],
  now: number,
  graceMs: number = MISSED_GRACE_MS,
): MissedAutomation[] {
  const missed: MissedAutomation[] = []
  for (const item of list) {
    if (!item.enabled || item.schedule.kind === 'manual') continue
    if (item.nextRunAt === undefined || now - item.nextRunAt <= graceMs) continue
    const policy = item.missedPolicy === 'run-once' ? 'run-once' : 'skip'
    if (item.schedule.kind === 'once') {
      missed.push({ automation: item, disable: true, policy, coalescedCount: 1 })
      continue
    }
    const next = nextFireAfter(item.schedule, now)
    if (next === undefined) {
      console.error(`[automations] task ${item.id} is stale but has no next fire time (schedule kind: ${item.schedule.kind})`)
      continue
    }
    const periodMs = periodOf(item.schedule)
    const coalescedCount = periodMs ? Math.floor((now - item.nextRunAt) / periodMs) + 1 : 1
    missed.push({ automation: item, nextRunAt: next, policy, coalescedCount })
  }
  return missed
}

/** 生效截止已过的启用任务:边界 expiresAt === now 算过期。 */
export function expiredAutomations(list: AutomationInfo[], now: number): AutomationInfo[] {
  return list.filter((item) => item.enabled && item.expiresAt !== undefined && item.expiresAt <= now)
}

export async function createAutomation(storageRoot: string, input: AutomationInput, now = Date.now()): Promise<AutomationInfo> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    if (registry.automations.length >= MAX_AUTOMATIONS) {
      throw new Error(`任务数量已达上限（${MAX_AUTOMATIONS} 个），请先删除不再需要的任务`)
    }
    const nextRunAt = nextFireAfter(input.schedule, now)
    const automation: AutomationInfo = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    }
    registry.automations.push(automation)
    await writeAutomationRegistry(storageRoot, registry)
    return automation
  })
}

export async function updateAutomation(
  storageRoot: string,
  automationId: string,
  patch: Record<string, unknown>,
  now = Date.now(),
): Promise<AutomationInfo> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const automation = registry.automations.find((item) => item.id === automationId)
    if (!automation) throw new Error(`automation ${automationId} was not found`)

    const next = { ...automation }
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
    if (patch.kind === 'agent' || patch.kind === 'script') next.kind = patch.kind
    if (patch.schedule !== undefined) next.schedule = normalizeSchedule(patch.schedule)
    const prompt = optionalString(patch.prompt)
    if (prompt !== undefined) next.prompt = prompt
    if (patch.prompt === '') delete next.prompt
    const command = optionalString(patch.command)
    if (command !== undefined) next.command = command
    if (patch.command === '') delete next.command
    if (typeof patch.widget === 'boolean') next.widget = patch.widget
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.expiresAt === 'number') next.expiresAt = patch.expiresAt
    if (patch.expiresAt === '') delete next.expiresAt
    if (patch.missedPolicy === 'skip' || patch.missedPolicy === 'run-once') next.missedPolicy = patch.missedPolicy
    if (patch.missedPolicy === '') delete next.missedPolicy
    if (patch.taskShape === 'independent' || patch.taskShape === 'merged') next.taskShape = patch.taskShape
    if (patch.taskShape === '') delete next.taskShape
    if (patch.unattended === '') delete next.unattended
    else if (patch.unattended !== undefined) next.unattended = normalizeUnattended(patch.unattended)

    if (next.kind === 'agent' && !next.prompt) throw new Error('agent 任务必须填写提示词（prompt）')
    if (next.kind === 'script' && !next.command) throw new Error('脚本任务必须填写命令（command）')

    const scheduleChanged = JSON.stringify(automation.schedule) !== JSON.stringify(next.schedule)
    if (scheduleChanged || patch.enabled !== undefined) {
      const nextRunAt = nextFireAfter(next.schedule, now)
      if (nextRunAt === undefined) delete next.nextRunAt
      else next.nextRunAt = nextRunAt
    }

    const index = registry.automations.indexOf(automation)
    registry.automations[index] = next
    await writeAutomationRegistry(storageRoot, registry)
    return next
  })
}

function runsFile(storageRoot: string, automationId: string): string {
  return join(storageRoot, 'automations', `${automationId}.runs.jsonl`)
}

function auditFile(storageRoot: string, automationId: string): string {
  return join(storageRoot, 'automations', `${automationId}.audit.jsonl`)
}

export async function removeAutomation(
  storageRoot: string,
  automationId: string,
  sessionsRoot: string = join(storageRoot, 'sessions'),
): Promise<void> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const index = registry.automations.findIndex((item) => item.id === automationId)
    if (index < 0) throw new Error(`automation ${automationId} was not found`)
    registry.automations.splice(index, 1)
    await writeAutomationRegistry(storageRoot, registry)
    await rm(runsFile(storageRoot, automationId), { force: true }).catch(() => undefined)
    await rm(auditFile(storageRoot, automationId), { force: true }).catch(() => undefined)
    await removeAutomationSessions(sessionsRoot, automationId)
  })
}

/**
 * 只推进 nextRunAt(错过宽限的处理路径):不碰 lastRunAt/lastStatus。
 * 任务不存在时静默返回。
 */
export async function advanceNextRunAt(storageRoot: string, automationId: string, nextRunAt: number): Promise<void> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const automation = registry.automations.find((item) => item.id === automationId)
    if (!automation) return
    automation.nextRunAt = nextRunAt
    await writeAutomationRegistry(storageRoot, registry)
  })
}

/** 产出截断:入库前统一上限(旧 automations.ts OUTPUT_MAX_CHARS)。 */
export const OUTPUT_MAX_CHARS = 32 * 1024

export function clipOutput(output: string): string {
  return output.length <= OUTPUT_MAX_CHARS ? output : `${output.slice(0, OUTPUT_MAX_CHARS)}…（已截断）`
}

/**
 * 回写 lastRunAt / lastStatus。nextRunAt 只在进入 running 时按 lastRunAt 推进一次。
 * 完成时再按 endedAt 算会跨过运行期间的下一次触发,把那一档跳掉。
 * 调用方显式传入 nextRunAt 时仍按该值写入。任务不存在时静默返回。
 */
export async function markAutomation(
  storageRoot: string,
  automationId: string,
  status: {
    lastRunAt: number
    lastStatus: 'ok' | 'error' | 'running'
    nextRunAt?: number
  },
): Promise<void> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const automation = registry.automations.find((item) => item.id === automationId)
    if (!automation) return
    automation.lastRunAt = status.lastRunAt
    automation.lastStatus = status.lastStatus
    if (status.nextRunAt !== undefined) {
      automation.nextRunAt = status.nextRunAt
    } else if (automation.schedule.kind !== 'manual' && status.lastStatus === 'running') {
      const next = nextFireAfter(automation.schedule, status.lastRunAt)
      if (next === undefined) delete automation.nextRunAt
      else automation.nextRunAt = next
    }
    await writeAutomationRegistry(storageRoot, registry)
  })
}

/** 同一任务的运行记录读改写串行;两个 script 同时结束不能互相覆盖丢掉一条。 */
const appendRunTail = new Map<string, Promise<unknown>>()

function withAppendRunLock<T>(storageRoot: string, automationId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${storageRoot}\0${automationId}`
  const prev = appendRunTail.get(key) ?? Promise.resolve()
  const run = prev.then(fn, () => fn())
  appendRunTail.set(key, run.then(() => undefined, () => undefined))
  return run
}

/** 追加一条运行记录;超过 RUNS_LIMIT 时丢弃最旧的(整文件重写)。 */
export async function appendRun(storageRoot: string, automationId: string, run: RunSummary): Promise<void> {
  return withAppendRunLock(storageRoot, automationId, async () => {
    const path = runsFile(storageRoot, automationId)
    const existing = await recentRuns(storageRoot, automationId)
    // 读和写之间让出一次。锁外并发会在这里互相盖掉;锁内下一笔要等这一笔写完再读。
    await Promise.resolve()
    const clipped: RunSummary = { ...run, output: clipOutput(run.output) }
    const lines = [...existing, clipped].slice(-RUNS_LIMIT).map((entry) => JSON.stringify(entry))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  })
}

/**
 * 清理历史运行会话目录:保留运行文件里最近 {@link RUNS_LIMIT} 条对应的会话,
 * 以及调用方声明的活跃会话。只删会话目录,不改 runs/audit 文件。不加注册表锁。
 */
export async function pruneAutomationSessions(
  storageRoot: string,
  activeSessionIds: ReadonlySet<string> = new Set(),
  sessionsRoot: string = join(storageRoot, 'sessions'),
): Promise<number> {
  const keep = new Set(activeSessionIds)
  const registry = await readAutomationRegistry(storageRoot)
  await Promise.all(
    registry.automations.map(async (automation) => {
      const runs = await recentRuns(storageRoot, automation.id, RUNS_LIMIT)
      for (const run of runs) {
        if (run.sessionId) keep.add(run.sessionId)
      }
    }),
  )

  let cwds: string[]
  try {
    cwds = await readdir(sessionsRoot)
  } catch {
    return 0
  }
  let removed = 0
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
          .filter((entry) => isAutomationSessionEntry(entry) && !keep.has(entry))
          .map(async (entry) => {
            await rm(join(cwdDir, entry), { recursive: true, force: true }).catch(() => undefined)
            removed += 1
          }),
      )
    }),
  )
  return removed
}
