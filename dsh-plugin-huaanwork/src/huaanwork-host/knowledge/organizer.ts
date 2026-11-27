/**
 * 单库单槽知识库整理执行器（规格 §8.1–§8.3 / M1-2 Task 5）。
 *
 * 每个知识库固定一个 `huaanwork-kb-org-<kbId>` 槽：先做模型预检，再向
 * `TurnScheduler.admitKbOrganize` 申请唯一全局整理名额；准入后 open 唯一权威批次，
 * 补建 `wiki/` 根、登记会话根/工具白名单/模型并驱动真实 Agent 回合，回合结束在
 * `finally` 中按固定顺序 dispose、结算、清理并释放名额。纯墓碑批零进展只在这里的
 * 内存中做 1/5/3 退避，不扩 SQLite schema；文档级失败计次完全交给 Host/Storage。
 *
 * 本文件会在 Host 线程以 `.ts` 源码/构建产物两种形态加载，保持可擦除 TypeScript
 * 语法；纯类型导入必须写 `import type`，相对导入保留 `.ts` 后缀。
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Agent, AgentCancelCause, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'

import {
  attachAgentTools,
  detachAgentTools,
  type AttachmentMaps,
} from '../../huaanwork-guardrails/agent-attachments.ts'
import { appendKnowledgeEvent } from './events.ts'
import type { KnowledgeHost, KnowledgeOrganizeBatchSettlement } from './host.ts'
import { KB_ORG_ALLOWED_TOOLS, KB_ORG_TOOLS } from './org-tools.ts'
import { registerKnowledgeOrganizerActivity } from './organizer-activity.ts'
import { kbOrganizeSessionId } from './session-ids.ts'
import type {
  KnowledgeBaseRecord,
  KnowledgeOrganizerPhase,
  PendingOrganizeBatch,
} from './types.ts'
import { resolveSessionModel } from '../session-models.ts'
import { removeSessionFilesById } from '../session-sweep.ts'
import { DEFAULT_AUTOMATION_TIMEOUT_MS, readHuaanworkSettingsSync } from '../settings.ts'
import type { TurnScheduler } from '../turn-scheduler.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../workspace-state.ts'

/** 看门狗与 mkdir 失败的具名终止原因。 */
const WIKI_ROOT_UNWRITABLE = 'knowledge-organize-wiki-root-unwritable'
const IDLE_TIMEOUT = 'knowledge-organize-idle-timeout'
const UNMARKED = 'knowledge-organize-unmarked'

/** 纯墓碑零进展的两次进程内重试间隔（第三次后停止自动重试）。 */
const TOMBSTONE_RETRY_FIRST_MS = 60_000
const TOMBSTONE_RETRY_SECOND_MS = 300_000
/** 写入失败错误文本的前端上限，避免把 bridge 原始多行文本写进文档行。 */
const TERMINAL_ERROR_MAX_CHARS = 300

/** 固定驱动指令：只处理 `kb_org_get_delta` 返回的当前批，不携带随后台入库变化的文档数。 */
const KB_ORG_FOLLOWUP_TEXT =
  '处理 kb_org_get_delta 返回的当前整理批次。先阅读并改写 Wiki 卡片与索引，再按提示词完成结算。'

/**
 * 整理执行器依赖。`createAgent` 由 Host 注入真实 Agent 工厂；`releaseSlot` 是唯一
 * 名额释放器（Task 6 注入 `releaseAndDrain`）；`now`/`timeoutMs` 供看门狗与退避使用。
 */
export interface KnowledgeOrganizerDeps {
  readonly profileDir: string
  readonly dshHome: string
  readonly host: KnowledgeHost
  readonly scheduler: TurnScheduler
  readonly sessionRoots: Map<string, string>
  readonly sessionToolAllow: Map<string, readonly string[]>
  readonly sessionModels: Map<string, string>
  readonly attachments: AttachmentMaps
  readonly createAgent: (options: CreateAgentOptions) => Promise<AgentHandle>
  readonly releaseSlot: (sessionId: string) => void
  readonly now: () => number
  readonly timeoutMs: () => number
}

export interface KnowledgeOrganizer {
  scheduleEvaluate(input?: { manualKbIds?: readonly string[] }): Promise<void>
  triggerManual(
    kbId: string,
    opts?: { docId?: string; retryFailed?: boolean },
  ): Promise<void>
  cancelForKb(
    kbId: string,
    reason: 'user-stop' | 'preempt' | 'maintenance' | 'dispose',
  ): Promise<void>
  cancelAll(): Promise<void>
  waitForKbSlotIdle(kbId: string): Promise<void>
  noteSystemResume(): void
}

type CancelReason = 'user-stop' | 'preempt' | 'maintenance' | 'dispose'

type Terminal =
  | { readonly kind: 'cancel'; readonly reason: CancelReason }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly message: string }

interface IdleDeadline {
  readonly promise: Promise<never>
  touch(): void
  dispose(): void
}

interface ZeroProgressState {
  count: number
  timer: ReturnType<typeof setTimeout> | undefined
}

interface Claim {
  readonly record: KnowledgeBaseRecord
  readonly admitted: Promise<boolean>
  readonly lifecycle: Promise<void>
  readonly resolveAdmitted: (value: boolean) => void
  readonly resolveLifecycle: () => void
  started: boolean
}

interface NextAction {
  scheduleNext: boolean
  backoffCount?: number
}

interface BatchLocals {
  admitted: boolean
  opened: boolean
  batchStarted: boolean
  handle: AgentHandle | undefined
  idleDeadline: IdleDeadline | undefined
  disposeActivity: (() => void) | undefined
  terminal: Terminal | undefined
  firstModelError: string | undefined
}

/** 看门狗超时的模块私有错误：与模型/回合错误区分，保证首个终止原因可判定。 */
class KnowledgeOrganizeIdleTimeoutError extends Error {
  constructor() {
    super(IDLE_TIMEOUT)
    this.name = 'KnowledgeOrganizeIdleTimeoutError'
  }
}

/** bridge 原始错误可能多行；持久化前折成单行并截断。 */
function sanitizeTerminalError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value)
  const folded = raw.replace(/\s+/gu, ' ').trim()
  if (folded === '') return 'knowledge-organize-error'
  return folded.length > TERMINAL_ERROR_MAX_CHARS
    ? `${folded.slice(0, TERMINAL_ERROR_MAX_CHARS)}…`
    : folded
}

function isEmptyBatch(batch: PendingOrganizeBatch): boolean {
  return batch.docs.length === 0 && batch.tombstones.length === 0
}

/** 权威待整理签名：文档与墓碑都排序，数据库返回顺序不构成“新工作”。 */
function pendingSignature(batch: PendingOrganizeBatch): string {
  const docs = [...batch.docs]
    .map(doc => [doc.docId, doc.sha256] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]))
  const tombstones = [...batch.tombstones]
    .map(item => [item.docId, item.deletedAt] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1])
  return JSON.stringify({ docs, tombstones })
}

function cancelCause(reason: CancelReason): AgentCancelCause {
  switch (reason) {
    case 'user-stop':
      return { kind: 'user' }
    case 'preempt':
    case 'maintenance':
      return { kind: 'hook', reason: `knowledge-organize-${reason}` }
    case 'dispose':
      return { kind: 'disposed' }
  }
}

/** 提示词只约定 Wiki 内相对路径与结算顺序；库名按字面插入，interpolate=false。 */
function organizerPrompt(kbName: string): string {
  return [
    `你是知识库 Wiki 整理智能体，负责知识库「${kbName}」的当前整理批次。`,
    '',
    '工作约定：',
    '- 只处理 kb_org_get_delta 返回的当前冻结批次；批次开始后新入库的文档不属于本批。',
    '- Wiki 内链统一写相对 wiki/ 根路径：docs/<docId>.md、topics/<slug>.md、INDEX.md；不要附加 #锚点（除非带行号）。',
    '- 先更新 INDEX.md 与 topics/ 专题页，确认索引和专题完成后再调用 kb_org_mark_organized 提交 clearedTombstones。',
    '- 处理文档时先调用 kb_org_read_doc 读取切片，再写 wiki/docs/<docId>.md 卡片；卡片必须非空、≤ 256 KB、非符号链接。',
    '- 宿主只删除墓碑登记的 docs/<docId>.md 卡片，不会按参数删除专题页；专题页的清理由你改写 topics/ 完成。',
    '- 本批完成后必须用 kb_org_mark_organized 提交 processed 与 clearedTombstones；未提交的文档会按失败计次。',
  ].join('\n')
}

export function createKnowledgeOrganizer(deps: KnowledgeOrganizerDeps): KnowledgeOrganizer {
  /** 同库 create/delete 的生命周期锁；值在整批结算（含会话日志删除）后才兑现。 */
  const inFlightOrganizeByKb = new Map<string, Promise<void>>()
  /** 在途批次的取消原因；create 前与 followup 前各查一次。 */
  const cancelReasonByKb = new Map<string, CancelReason>()
  /** 已创建 Agent 的库，用于外部取消；dispose 后删除。 */
  const activeAgentByKb = new Map<string, Agent>()
  /** 每库最近一次权威待整理签名；只有签名变化才复位纯墓碑零进展。 */
  const lastPendingSignatureByKb = new Map<string, string>()
  /** 纯墓碑批零进展 1/5/3，仅进程内状态，不写 Storage。 */
  const zeroProgressByKb = new Map<string, ZeroProgressState>()
  /** 当前批次的看门狗；`noteSystemResume()` 只刷新它。 */
  let activeIdleDeadline: IdleDeadline | undefined
  let disposed = false

  function clearZeroProgress(kbId: string): void {
    const state = zeroProgressByKb.get(kbId)
    if (state?.timer !== undefined) clearTimeout(state.timer)
    zeroProgressByKb.delete(kbId)
  }

  function clearBackoffTimerOnly(kbId: string): void {
    const state = zeroProgressByKb.get(kbId)
    if (state?.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  function isBackoffBlocked(kbId: string): boolean {
    const state = zeroProgressByKb.get(kbId)
    if (state === undefined) return false
    return state.timer !== undefined || state.count >= 3
  }

  function pruneDeletedKbs(): void {
    const registered = deps.host.getRegisteredKnowledgeBaseIds()
    for (const kbId of [...lastPendingSignatureByKb.keys()]) {
      if (!registered.has(kbId)) lastPendingSignatureByKb.delete(kbId)
    }
    for (const [kbId, state] of [...zeroProgressByKb]) {
      if (registered.has(kbId)) continue
      if (state.timer !== undefined) clearTimeout(state.timer)
      zeroProgressByKb.delete(kbId)
    }
  }

  /**
   * 记录权威快照签名；签名实际变化（真实新文档或墓碑集合变化）才清零退避。
   * 重复 peek、无变更对账与普通 drain 保持原次数。
   */
  function observePendingSignature(kbId: string, batch: PendingOrganizeBatch): void {
    const signature = pendingSignature(batch)
    const previous = lastPendingSignatureByKb.get(kbId)
    if (previous === undefined) {
      lastPendingSignatureByKb.set(kbId, signature)
      return
    }
    if (previous === signature) return
    lastPendingSignatureByKb.set(kbId, signature)
    clearZeroProgress(kbId)
  }

  function createIdleDeadline(): IdleDeadline {
    let baseline = deps.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    let stopped = false
    let rejectDeadline!: (error: Error) => void
    const promise = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject
    })
    // 超时可能早于 whenIdle 的 Promise.race 挂接（create/事件写入窗口）；先消费拒绝，
    // 保证此后 race 仍能读到同一个 timeout 原因，且不会触发进程级未处理拒绝。
    void promise.catch(() => undefined)
    const timeout = (): number => {
      const raw = deps.timeoutMs()
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_AUTOMATION_TIMEOUT_MS
    }
    const arm = (delayMs: number): void => {
      if (expired || stopped) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(wake, Math.max(0, delayMs))
      timer.unref?.()
    }
    const wake = (): void => {
      timer = undefined
      if (expired || stopped) return
      const elapsed = deps.now() - baseline
      if (elapsed >= timeout()) {
        expired = true
        rejectDeadline(new KnowledgeOrganizeIdleTimeoutError())
        return
      }
      arm(timeout() - elapsed)
    }
    const touch = (): void => {
      if (expired || stopped) return
      baseline = deps.now()
      arm(timeout())
    }
    arm(timeout())
    return {
      promise,
      touch,
      dispose() {
        if (stopped) return
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      },
    }
  }

  /** 模型预检必须发生在名额准入之前；返回预检失败相位或激活模型条目 id。 */
  function precheckModel(
    sessionId: string,
  ): { ok: true; activeModelId: string } | { ok: false; phase: KnowledgeOrganizerPhase } {
    let settings
    try {
      settings = readHuaanworkSettingsSync(deps.profileDir)
    } catch {
      return { ok: false, phase: 'blocked-no-model' }
    }
    const activeModelId = settings.active_model_id
    const activeEntry = settings.models.find(model => model.id === activeModelId)
    const resolved = resolveSessionModel({
      sessionId,
      table: new Map([[sessionId, activeModelId]]),
      models: settings.models,
      active: {
        base_url: settings.base_url,
        model: settings.model,
        api_key: settings.api_key,
      },
      allowNetwork: settings.allow_network,
    })
    if (!resolved.ok) {
      // 条目不存在/空 model 是模型缺失；条目存在但被公网门禁拒绝是网络阻断。
      return { ok: false, phase: activeEntry?.model.trim() ? 'blocked-network' : 'blocked-no-model' }
    }
    if (resolved.model.trim() === '') return { ok: false, phase: 'blocked-no-model' }
    return { ok: true, activeModelId }
  }

  async function appendEvent(
    kbId: string,
    kind: 'organize_started' | 'organize_completed' | 'organize_failed' | 'organize_cancelled',
    level: 'info' | 'error',
    summary: string,
  ): Promise<void> {
    try {
      await appendKnowledgeEvent(neutralKnowledgeRootPath(deps.profileDir, kbId), {
        kind,
        level,
        summary,
      })
    } catch {
      // 事件日志写失败绝不阻断批次结算或名额释放。
    }
  }

  /**
   * 唯一结算入口：close 后按权威快照判定未 mark 文档、纯墓碑进展与事件。
   * `settlement` 只来自 open 快照，不再查询 pending。
   */
  async function settleBatch(
    kbId: string,
    settlement: KnowledgeOrganizeBatchSettlement,
    terminal: Terminal | undefined,
    firstModelError: string | undefined,
  ): Promise<{ cancelled: boolean; scheduleNext: boolean; backoffCount?: number }> {
    const reason = terminal?.kind === 'cancel'
      ? terminal.reason
      : terminal === undefined
        ? cancelReasonByKb.get(kbId)
        : undefined
    const cancelled = reason !== undefined
    const timedOut = terminal?.kind === 'timeout'
    const terminalErrorText = terminal?.kind === 'error'
      ? sanitizeTerminalError(terminal.message)
      : terminal === undefined && firstModelError !== undefined
        ? sanitizeTerminalError(firstModelError)
        : undefined
    const terminalError = cancelled
      ? undefined
      : timedOut
        ? IDLE_TIMEOUT
        : terminalErrorText ?? UNMARKED

    const organized = new Set(settlement.organizedDocIds)
    const unmarked = settlement.batch.docs.filter(doc => !organized.has(doc.docId))
    if (!cancelled) {
      // 文档级 retry_after 不另设计时器：到期后的再评估由周期对账
      // （DEFAULT_RECONCILE_INTERVAL_MS）与排空后的 reevaluateKbOrganize 触发；
      // 只有纯墓碑零进展使用进程内 1/5/3 计时器。
      for (const doc of unmarked) {
        try {
          await deps.host.recordOrganizeFailure(
            kbId,
            doc.docId,
            doc.sha256,
            terminalError ?? UNMARKED,
            deps.now(),
          )
        } catch {
          // 单文档计次失败不阻断其它文档与后续清理；批次事件仍按首次终止原因结算。
        }
      }
    }

    const cleared = new Set(settlement.clearedTombstoneIds)
    const allTombstonesCleared = settlement.batch.tombstones.every(item => cleared.has(item.docId))
    const completed = !cancelled
      && !timedOut
      && terminalErrorText === undefined
      && unmarked.length === 0
      && allTombstonesCleared
    const pureTombstone = settlement.batch.docs.length === 0 && settlement.batch.tombstones.length > 0

    if (cancelled) {
      await appendEvent(kbId, 'organize_cancelled', 'info', `整理已取消（${reason}）`)
    } else if (completed) {
      await appendEvent(
        kbId,
        'organize_completed',
        'info',
        `整理完成：推进 ${String(organized.size)} 份文档，清除 ${String(cleared.size)} 个墓碑`,
      )
    } else {
      await appendEvent(
        kbId,
        'organize_failed',
        'error',
        `整理失败：${terminalError ?? UNMARKED}（未推进 ${String(unmarked.length)} 份文档）`,
      )
    }

    if (pureTombstone && !cancelled) {
      if (cleared.size > 0) {
        clearZeroProgress(kbId)
      } else {
        const state = zeroProgressByKb.get(kbId) ?? { count: 0, timer: undefined }
        state.count += 1
        zeroProgressByKb.set(kbId, state)
        return {
          cancelled,
          scheduleNext: false,
          ...(state.count <= 2 ? { backoffCount: state.count } : {}),
        }
      }
    }
    return { cancelled, scheduleNext: !cancelled }
  }

  function armZeroProgressRetry(kbId: string, count: number): void {
    const state = zeroProgressByKb.get(kbId)
    if (state === undefined) return
    const delay = count === 1
      ? TOMBSTONE_RETRY_FIRST_MS
      : count === 2
        ? TOMBSTONE_RETRY_SECOND_MS
        : undefined
    if (delay === undefined) return
    const timer = setTimeout(() => {
      const current = zeroProgressByKb.get(kbId)
      if (current !== state || current.timer !== timer) return
      current.timer = undefined
      if (disposed) return
      // 到点必须走统一评估与准入，绝不直接 create。
      void scheduleEvaluate().catch(() => undefined)
    }, delay)
    timer.unref?.()
    state.timer = timer
  }

  function createClaim(record: KnowledgeBaseRecord): Claim {
    let resolveAdmitted!: (value: boolean) => void
    let resolveLifecycle!: () => void
    const admitted = new Promise<boolean>((resolve) => {
      resolveAdmitted = resolve
    })
    const lifecycle = new Promise<void>((resolve) => {
      resolveLifecycle = resolve
    })
    // 必须在首个 await 前同步占位，阻止同库并发 create/delete。
    inFlightOrganizeByKb.set(record.id, lifecycle)
    return {
      record,
      admitted,
      lifecycle,
      resolveAdmitted: (value: boolean) => {
        resolveAdmitted(value)
      },
      resolveLifecycle,
      started: false,
    }
  }

  async function runCandidate(claim: Claim): Promise<NextAction> {
    const kbId = claim.record.id
    const sessionId = kbOrganizeSessionId(kbId)
    const wikiRoot = neutralKnowledgeWikiRootPath(deps.profileDir, kbId)
    const nextAction: NextAction = { scheduleNext: false }
    const locals: BatchLocals = {
      admitted: false,
      opened: false,
      batchStarted: false,
      handle: undefined,
      idleDeadline: undefined,
      disposeActivity: undefined,
      terminal: undefined,
      firstModelError: undefined,
    }
    let admissionResolved = false
    const finishAdmission = (value: boolean): void => {
      if (admissionResolved) return
      admissionResolved = true
      claim.resolveAdmitted(value)
    }

    const recordTerminal = (error: unknown): void => {
      if (locals.terminal !== undefined) return
      const reason = cancelReasonByKb.get(kbId)
      if (error instanceof KnowledgeOrganizeIdleTimeoutError) {
        locals.terminal = reason === undefined
          ? { kind: 'timeout' }
          : { kind: 'cancel', reason }
        if (reason === undefined) {
          activeAgentByKb.get(kbId)?.cancel({ kind: 'hook', reason: IDLE_TIMEOUT })
        }
        return
      }
      locals.terminal = reason === undefined
        ? { kind: 'error', message: sanitizeTerminalError(error) }
        : { kind: 'cancel', reason }
    }

    const body = async (): Promise<void> => {
      if (disposed) {
        finishAdmission(false)
        return
      }
      const peek = await deps.host.peekPendingOrganizeBatch(kbId, deps.now())
      observePendingSignature(kbId, peek)
      if (isEmptyBatch(peek)) {
        deps.host.clearOrganizerPhase(kbId)
        finishAdmission(false)
        return
      }
      if (isBackoffBlocked(kbId)) {
        finishAdmission(false)
        return
      }

      const model = precheckModel(sessionId)
      if (!model.ok) {
        deps.host.setOrganizerPhase(kbId, model.phase)
        finishAdmission(false)
        return
      }

      deps.host.setOrganizerPhase(kbId, 'waiting-turn-slot')
      const admission = deps.scheduler.admitKbOrganize({
        kbId,
        sessionId,
        root: wikiRoot,
        onPreempt: () => {
          void cancelForKb(kbId, 'preempt').catch(() => undefined)
        },
      })
      if (admission.kind !== 'start') {
        finishAdmission(false)
        return
      }
      locals.admitted = true
      finishAdmission(true)
      deps.host.setOrganizerPhase(kbId, 'organizing')

      const batch = await deps.host.openOrganizeBatch(kbId, deps.now())
      locals.opened = true
      observePendingSignature(kbId, batch)
      if (isEmptyBatch(batch)) {
        return
      }
      locals.batchStarted = true
      nextAction.scheduleNext = true

      try {
        // 新库 M1-1 只建 <kbDir>；不补 wiki/ 根会让全部 fs 工具按路径逃逸拒绝。
        await mkdir(wikiRoot, { recursive: true, mode: 0o700 })
      } catch {
        locals.terminal = { kind: 'error', message: WIKI_ROOT_UNWRITABLE }
        return
      }

      await removeSessionFilesById(join(deps.dshHome, 'sessions'), [sessionId])
      deps.sessionRoots.set(sessionId, wikiRoot)
      deps.sessionToolAllow.set(sessionId, KB_ORG_ALLOWED_TOOLS)
      deps.sessionModels.set(sessionId, model.activeModelId)
      attachAgentTools(deps.attachments, sessionId, KB_ORG_TOOLS)

      locals.idleDeadline = createIdleDeadline()
      activeIdleDeadline = locals.idleDeadline
      locals.disposeActivity = registerKnowledgeOrganizerActivity(sessionId, {
        touch: () => {
          locals.idleDeadline?.touch()
        },
        noteError: (message: string) => {
          locals.firstModelError ??= message
        },
      })

      locals.handle = await deps.createAgent({
        sessionId: sessionId as CreateAgentOptions['sessionId'],
        meta: { cwd: wikiRoot },
        agentOptions: { provider: 'deepseek-official', model: 'local' },
        setup(agentCtx) {
          agentCtx.systemPrompt.context({
            name: 'huaanwork:kb-organizer',
            order: 40,
            required: true,
            interpolate: false,
            text: organizerPrompt(claim.record.name),
          })
        },
      })
      activeAgentByKb.set(kbId, locals.handle.agent)

      const earlyReason = cancelReasonByKb.get(kbId)
      if (earlyReason !== undefined) {
        locals.terminal = { kind: 'cancel', reason: earlyReason }
        return
      }

      await appendEvent(
        kbId,
        'organize_started',
        'info',
        `开始整理：${String(batch.docs.length)} 份文档，${String(batch.tombstones.length)} 个墓碑`,
      )
      // 事件写入也是 await：followup 前再查一次，取消不得在写事件窗口里漏掉。
      const reasonAfterEvent = cancelReasonByKb.get(kbId)
      if (reasonAfterEvent !== undefined) {
        locals.terminal = { kind: 'cancel', reason: reasonAfterEvent }
        return
      }

      try {
        locals.handle.agent.followup({
          id: MessageId(randomUUID()),
          role: 'user',
          content: [{ type: 'text', text: KB_ORG_FOLLOWUP_TEXT }],
          source: { kind: 'user' },
        })
        const turn = locals.handle.agent.whenIdle()
        // 晚到的 turn rejection 必须被消费；首个终止原因仍由 recordTerminal 决定。
        void turn.catch(() => undefined)
        await Promise.race([turn, locals.idleDeadline.promise])
      } catch (error) {
        recordTerminal(error)
      }

      if (
        locals.firstModelError !== undefined
        && locals.terminal === undefined
        && cancelReasonByKb.get(kbId) === undefined
      ) {
        locals.terminal = { kind: 'error', message: locals.firstModelError }
      }
    }

    try {
      await body()
    } catch (error) {
      recordTerminal(error)
      nextAction.scheduleNext = locals.admitted && cancelReasonByKb.get(kbId) === undefined
    } finally {
      // 准入必须每条路径都兑现：peek/open/admission 等预启动步骤抛错时，
      // scheduleEvaluate 仍要拿到结果并继续处理本轮其余候选，绝不悬挂等待。
      finishAdmission(locals.admitted)
      locals.idleDeadline?.dispose()
      if (activeIdleDeadline === locals.idleDeadline) activeIdleDeadline = undefined

      if (locals.handle !== undefined) {
        try {
          await locals.handle.dispose()
        } catch {
          // dispose 失败不阻断关闭批次、清理会话槽与释放名额。
        }
      }

      if (locals.opened) {
        try {
          const settlement = deps.host.closeOrganizeBatch(kbId)
          if (locals.batchStarted) {
            const result = await settleBatch(
              kbId,
              settlement,
              locals.terminal,
              locals.firstModelError,
            )
            nextAction.scheduleNext = result.scheduleNext
            if (result.backoffCount !== undefined) nextAction.backoffCount = result.backoffCount
          }
        } catch {
          // 结算失败时仍继续后续清理；事件/计次保持至多一次。
        }
      }

      try {
        locals.disposeActivity?.()
      } catch {
        // 注销 activity 只影响心跳观察，不让清理序列中断。
      }
      activeAgentByKb.delete(kbId)
      cancelReasonByKb.delete(kbId)

      deps.sessionModels.delete(sessionId)
      deps.sessionRoots.delete(sessionId)
      deps.sessionToolAllow.delete(sessionId)
      try {
        detachAgentTools(deps.attachments, sessionId, KB_ORG_TOOLS)
      } catch {
        // 附件表清理失败不阻断名额释放。
      }
      if (locals.admitted) {
        try {
          await removeSessionFilesById(join(deps.dshHome, 'sessions'), [sessionId])
        } catch {
          // 会话日志删除失败不阻断名额释放；下一批开始前还会再清一次。
        }
      }

      if (locals.admitted) {
        try {
          deps.host.clearOrganizerPhase(kbId)
        } catch {
          // 相位清理失败不阻断名额释放。
        }
        try {
          // releaseSlot 是唯一名额释放器（Task 6 注入 releaseAndDrain）。
          deps.releaseSlot(sessionId)
        } catch {
          // 释放器内部异常不得跳过 inFlight 删除与后续退避。
        }
      }
    }
    return nextAction
  }

  function startClaim(claim: Claim): void {
    claim.started = true
    void (async () => {
      let action: NextAction = { scheduleNext: false }
      try {
        action = await runCandidate(claim)
      } catch {
        // runCandidate 已自行结算；显式兜底保证 lifecycle 一定兑现。
      } finally {
        // runCandidate 在进入自身 finally 前任何异常也必须兑现准入，避免评估轮悬挂与槽位泄漏。
        claim.resolveAdmitted(false)
        if (inFlightOrganizeByKb.get(claim.record.id) === claim.lifecycle) {
          inFlightOrganizeByKb.delete(claim.record.id)
        }
        if (!disposed) {
          if (action.backoffCount !== undefined) {
            armZeroProgressRetry(claim.record.id, action.backoffCount)
          } else if (action.scheduleNext) {
            void scheduleEvaluate().catch(() => undefined)
          }
        }
        claim.resolveLifecycle()
      }
    })()
  }

  async function scheduleEvaluate(input?: { manualKbIds?: readonly string[] }): Promise<void> {
    if (disposed) return
    const manualKbIds = new Set(input?.manualKbIds ?? [])
    pruneDeletedKbs()

    const running = [...inFlightOrganizeByKb.values()]
    if (running.length > 0) {
      await Promise.all(running.map(promise => promise.catch(() => undefined)))
    }
    if (disposed) return

    const candidates = deps.host.listOrganizeCandidates(manualKbIds)
    const claims: Claim[] = []
    for (const record of candidates) {
      if (inFlightOrganizeByKb.has(record.id)) continue
      claims.push(createClaim(record))
    }
    try {
      for (const claim of claims) {
        startClaim(claim)
        await claim.admitted
      }
    } finally {
      for (const claim of claims) {
        if (claim.started) continue
        if (inFlightOrganizeByKb.get(claim.record.id) === claim.lifecycle) {
          inFlightOrganizeByKb.delete(claim.record.id)
        }
        claim.resolveAdmitted(false)
        claim.resolveLifecycle()
      }
    }
    await Promise.all(claims.map(claim => claim.lifecycle.catch(() => undefined)))
  }

  async function triggerManual(
    kbId: string,
    opts?: { docId?: string; retryFailed?: boolean },
  ): Promise<void> {
    // 第一件事：在任何 reset、计时器或候选集副作用之前完成同步校验。
    deps.host.assertOrganizeAllowed(kbId)
    if (opts?.docId !== undefined) {
      await deps.host.resetOrganizeFailures(kbId, opts.docId)
    } else if (opts?.retryFailed === true) {
      await deps.host.resetOrganizeFailures(kbId)
    }
    clearZeroProgress(kbId)
    await waitForKbSlotIdle(kbId)
    await scheduleEvaluate({ manualKbIds: [kbId] })
  }

  async function cancelForKb(kbId: string, reason: CancelReason): Promise<void> {
    // 先清退避计时器：四类取消只清计时器、不增加零进展次数。
    clearBackoffTimerOnly(kbId)
    const inFlight = inFlightOrganizeByKb.get(kbId)
    if (inFlight === undefined) return
    cancelReasonByKb.set(kbId, reason)
    activeAgentByKb.get(kbId)?.cancel(cancelCause(reason))
    // 等刚捕获的同一个生命周期彻底结算（dispose + removeSessionFiles 完成）。
    await inFlight.catch(() => undefined)
  }

  async function cancelAll(): Promise<void> {
    disposed = true
    for (const state of zeroProgressByKb.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
    }
    zeroProgressByKb.clear()
    lastPendingSignatureByKb.clear()

    const kbIds = new Set([...activeAgentByKb.keys(), ...inFlightOrganizeByKb.keys()])
    const waits: Array<Promise<void>> = []
    for (const kbId of kbIds) {
      cancelReasonByKb.set(kbId, 'dispose')
      activeAgentByKb.get(kbId)?.cancel(cancelCause('dispose'))
      const inFlight = inFlightOrganizeByKb.get(kbId)
      if (inFlight !== undefined) waits.push(inFlight.catch(() => undefined))
    }
    await Promise.allSettled(waits)
  }

  async function waitForKbSlotIdle(kbId: string): Promise<void> {
    const inFlight = inFlightOrganizeByKb.get(kbId)
    if (inFlight === undefined) return
    await inFlight.catch(() => undefined)
  }

  return {
    scheduleEvaluate,
    triggerManual,
    cancelForKb,
    cancelAll,
    waitForKbSlotIdle,
    noteSystemResume() {
      activeIdleDeadline?.touch()
    },
  }
}
