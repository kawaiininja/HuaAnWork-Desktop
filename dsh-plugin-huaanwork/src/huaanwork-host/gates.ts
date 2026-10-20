/**
 * HuaAnWork post-boot gate(旧 packages/sidecar/src/gates.ts:73-142 的移植)。
 * 组合锁(Task 3)只验证静态条目;本插件在真实组合 boot 完成后逐条探活:
 * 会话面(planMode/userQuestions 服务 + 分流/计划/目标工具在全局目录且对
 * 主 agent 可见,由 `conversation-boot-audit.ts` 的共享审计判定)、waterfall
 * 可用、git_push 探针经 waterfall 得 ask、guard/execute 存在、同探针经
 * execute 必 isError、全局 schemas 无 run_code、agent ctx 有 restrict、
 * 主 agent schemas 无 web_search/run_code。
 *
 * 本条目是 optional startup entry:`apply` 抛错时 `dsh-app-boot` 只对非必需
 * 条目告警、`boot()` 照常 resolve ⇒ 门禁自身的 throw 只是 advisory。强制点
 * 是 Host-side 的同源审计:两条 Host 启动路径(host-bootstrap.ts 的隔离 Host、
 * main.ts 的同进程分支)在 `boot()` resolve 后调用
 * `assertConversationSurface`,其 throw 才进既有启动失败路径——同进程进恢复
 * 窗口,隔离 Host 让 boot RPC 拒绝并退出。门禁复用同一审计,两处判定不会漂移。
 *
 * 旧 `assertNoListeningServers` 的 Desktop 改造:loopback DesktopWebServer 是
 * sanctioned listener——白名单 = 「`ctx.webServer` 实际监听端口 + apply 时刻
 * 已存在(基线)的 handle」,除此之外不得有新增 TCP/UDP listener(brief 严格
 * 语义;AA 桥等组合的既有 listener 在 apply 前已绑定,落入基线,实测见任务
 * 报告的 race 验证)。
 */

import { assertConversationSurface, toolNames } from './conversation-boot-audit.ts'

/**
 * 必装工具清单的唯一真相源在审计模块;保留本别名给既有测试与消费方。
 */
export { REQUIRED_CONVERSATION_TOOL_NAMES as REQUIRED_TOOL_NAMES } from './conversation-boot-audit.ts'

type ToolExecution = {
  callId: string
  name: string
  arguments: unknown
  signal: AbortSignal
}

type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

type ToolExecutionResult =
  | { isError: true; error: unknown; content: unknown[] }
  | { isError: false; value: unknown; content: unknown[] }

type AgentCtxTools = {
  restrict?: unknown
  schemas?: () => readonly { name?: string }[]
}

/** cordis ctx 无单独类型导出(上游 0.1.6-alpha.2 逐字比对);同旧 sidecar 的 duck-type 风格。 */
type GatesContext = {
  /**
   * 按名取服务,不要求在 `inject` 里声明。共享审计经这里解析 planMode/
   * userQuestions,原因见 {@link inject} 的注释。
   */
  get(name: string): unknown
  waterfall(
    event: string,
    execution: ToolExecution,
    next: () => Promise<{ kind: 'allow' }>,
  ): Promise<unknown>
  tools: {
    guard(guard: ToolGuard): () => void
    execute(execution: ToolExecution): Promise<ToolExecutionResult>
    schemas(): readonly { name?: string }[]
  }
  agents: {
    list(): readonly {
      ctx?: { get?: (name: string) => AgentCtxTools | undefined }
    }[]
  }
  webServer: {
    /** 实际监听端口(config.port 为 0 时由 OS 分配,见 dsh-host-webserver)。 */
    readonly port: number
  }
}

/** Tests shrink the shared audit deadline to 0/300 ms; production keeps the bounded wait. */
type GateOptions = {
  toolWaitMs?: number
}

export const name = 'huaanwork-gates'
/**
 * Only the three pre-existing services belong here. `planMode` and
 * `userQuestions` must NOT be injected: an unmet inject leaves this fiber
 * pending, and `dsh-app-boot` only warns for non-required entries, so the gate
 * body would never run and a missing service would boot green while the
 * route/answerer plugins stay suspended. They are resolved through
 * `ctx.get()` inside {@link assertPostBootGate} instead.
 */
export const inject = ['tools', 'agents', 'webServer']

/**
 * 必须是 async function:cordis 的 isConstructor 把一切带 .prototype 的普通函数
 * 当 class 用 `new` 调用,返回的 Promise 会被丢弃(拒绝变 unhandledRejection,
 * 进程级崩溃而非启动失败);async function 无 prototype,按普通回调调用,
 * cordis `_reload` 会 await 它,门禁失败因此能被 Loader 记录。但本条目是
 * optional 的:`dsh-app-boot` 只为非必需条目告警,`boot()` 仍会 resolve ⇒
 * 门禁失败本身不改写启动结果,强制点见文件头注释。
 */
export async function apply(ctx: GatesContext): Promise<void> {
  const existingHandles = snapshotActiveHandles()
  await assertPostBootGate(ctx, existingHandles)
}

export async function assertPostBootGate(
  ctx: GatesContext,
  existingHandles: ReadonlySet<unknown> = new Set(),
  options: GateOptions = {},
): Promise<void> {
  // 会话面(planMode/userQuestions 服务、必装工具在全局目录且对主 agent 可见)
  // 由共享审计判定:门禁与 Host 启动后审计同源,两处判定不会漂移。门禁自身的
  // throw 在 optional 条目下只是 advisory;强制点是 host-bootstrap.ts / main.ts
  // 在 boot() resolve 之后调用的同一次审计。
  await assertConversationSurface(
    ctx,
    options.toolWaitMs === undefined ? {} : { timeoutMs: options.toolWaitMs },
  )
  const probe = {
    callId: 'huaanwork-start-gate',
    name: 'git_push',
    arguments: {},
    signal: new AbortController().signal,
  }
  const decision = await ctx.waterfall('tools/pre-execute', probe, async () => ({ kind: 'allow' }))
  if ((decision as { kind?: string } | undefined)?.kind !== 'ask') {
    throw new Error('post-boot gate failed: git_push must require approval')
  }
  if (typeof ctx.tools.guard !== 'function') {
    throw new Error('post-boot gate failed: ctx.tools.guard is missing')
  }
  if (typeof ctx.tools.execute !== 'function') {
    throw new Error('post-boot gate failed: ctx.tools.execute is missing')
  }
  const result = await ctx.tools.execute(probe)
  if (!result.isError) {
    throw new Error('post-boot gate failed: git_push must be denied by the guard')
  }
  assertNoForbiddenTools(toolNames(ctx.tools.schemas()), CATALOG_FORBIDDEN, 'global catalog')

  // 审计已经把 agent 注册表等到物化(旧 sidecar 实测:某些环境下异步出现);
  // 这里再取一次只验 restrict,因为审计只读 schemas。
  const agent = ctx.agents.list()[0]
  if (!agent?.ctx) {
    throw new Error('post-boot gate failed: no agent is available to verify restrict()')
  }
  const mainAgentTools = agent.ctx.get?.('tools')
  if (typeof mainAgentTools?.restrict !== 'function') {
    throw new Error("post-boot gate failed: agent ctx.get('tools').restrict must be a function")
  }
  const dumpAgentSchemas = mainAgentTools?.schemas
  if (typeof dumpAgentSchemas !== 'function') {
    throw new Error('post-boot gate failed: main-agent schema dump is unavailable')
  }
  assertNoForbiddenTools(toolNames(dumpAgentSchemas.call(mainAgentTools)), MAIN_AGENT_FORBIDDEN, 'main-agent schema')
  await assertNoUnexpectedListeners(ctx, existingHandles)
}

/** `run_code` must never be registered in the global catalog. */
const CATALOG_FORBIDDEN = ['run_code'] as const
/** The main agent must also not see `web_search` (unregistered or present-as hidden). */
const MAIN_AGENT_FORBIDDEN = ['run_code', 'web_search'] as const

function assertNoForbiddenTools(
  names: ReadonlySet<string>,
  forbidden: readonly string[],
  scope: string,
): void {
  const found = forbidden.find((name) => names.has(name))
  if (found) {
    throw new Error(`post-boot gate failed: disabled tool ${found} is visible in the ${scope}`)
  }
}

/**
 * 旧 sidecar 要求零 listener;Desktop 下 loopback DesktopWebServer 是
 * sanctioned listener。语义(brief 原文 + fix round 3 的实测race修正):
 * 除 apply 时刻已存在的 handle 基线外,不得有新增 TCP/UDP listener——
 * 唯一例外是绑定在 `ctx.webServer` 实际监听端口上的 listener(含 webServer 自身)。
 * IPC pipe Server(address() 返回 string)不是 TCP/UDP listener,不计入。
 *
 * race 证据(见任务报告 Fix round 3):cordis 并行激活互不依赖的插件,
 * AA 启用时 agents-anywhere bridge 在 huaanwork-gates apply 后 ~100ms 才
 * bind loopback 端口(5/5 复现),单次快照必然误杀。因此采用有界 settle-wait:
 * 先给组合 2s  settle 窗口让并行插件完成启动(窗口期内不判负),再取
 * 「settled 基线 = apply 基线 ∪ settle 结束时在听的 listener」,随后 500ms
 * 确认窗口内不得出现基线之外的新 listener。代价:settle 窗口内启动的
 *  listener 被视同组合既有部分(严格单快照语义在并行加载下不可判定);
 * 窗口之后出现的 listener 一律 fail-closed。
 */
const LISTENER_SETTLE_MS = 2_000
const LISTENER_SETTLE_POLL_MS = 100
const LISTENER_CONFIRM_TICKS = 5

async function assertNoUnexpectedListeners(ctx: GatesContext, existingHandles: ReadonlySet<unknown>): Promise<void> {
  const getActiveHandles = (process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[]
  })._getActiveHandles
  if (!getActiveHandles) return

  const sanctionedPort = ctx.webServer.port
  const unexpected = (baseline: ReadonlySet<unknown>): unknown[] =>
    getActiveHandles().filter((handle) => {
      if (baseline.has(handle)) return false
      return isUnexpectedNetworkListener(handle, sanctionedPort)
    })
  const describe = (handle: unknown): string => {
    const value = handle as { constructor?: { name?: string }; address?: () => unknown }
    const name = value.constructor?.name ?? 'unknown'
    let address = ''
    try {
      address = ` ${JSON.stringify(typeof value.address === 'function' ? value.address() : undefined)}`
    } catch {
      address = ' <no address>'
    }
    return `${name}${address}`
  }
  const fail = (offending: unknown[]): never => {
    throw new Error(
      `post-boot gate failed: listeners found outside the DesktopWebServer port ${String(sanctionedPort)}: ${
        offending.map(describe).join(', ')}`,
    )
  }

  // Phase 1 — settle:并行插件完成启动,窗口期内不判负。
  const settleDeadline = Date.now() + LISTENER_SETTLE_MS
  while (Date.now() < settleDeadline) {
    await new Promise((done) => setTimeout(done, LISTENER_SETTLE_POLL_MS))
  }
  // Phase 2 — settled 基线:apply 基线 ∪ settle 结束时在听的 listener。
  const settledBaseline = new Set<unknown>([...existingHandles, ...getActiveHandles()])
  // Phase 3 — 确认窗口:不得出现基线之外的新 listener。
  for (let tick = 0; tick < LISTENER_CONFIRM_TICKS; tick += 1) {
    const offending = unexpected(settledBaseline)
    if (offending.length > 0) fail(offending)
    await new Promise((done) => setTimeout(done, LISTENER_SETTLE_POLL_MS))
  }
}

function isUnexpectedNetworkListener(handle: unknown, sanctionedPort: number): boolean {
  const value = handle as {
    constructor?: { name?: string }
    listening?: unknown
    address?: () => unknown
    type?: unknown
  }
  const name = value.constructor?.name ?? ''
  if (name === 'Server' || name.endsWith('Server')) {
    if (value.listening !== true) return false
    const address = typeof value.address === 'function' ? value.address() : undefined
    // IPC pipe server 不是 TCP/UDP listener。
    if (typeof address === 'string') return false
    if (address && typeof address === 'object' && 'port' in address) {
      return (address as { port?: unknown }).port !== sanctionedPort
    }
    return true
  }
  if (name !== 'Socket' || (value.type !== 'udp4' && value.type !== 'udp6')) return false
  if (typeof value.address !== 'function') return false
  const address = value.address()
  return Boolean(address && typeof address === 'object' && 'port' in address)
}

function snapshotActiveHandles(): ReadonlySet<unknown> {
  const getActiveHandles = (process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[]
  })._getActiveHandles
  if (!getActiveHandles) return new Set()
  return new Set(getActiveHandles())
}
