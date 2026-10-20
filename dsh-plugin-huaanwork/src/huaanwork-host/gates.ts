/**
 * HuaAnWork post-boot gate(旧 packages/sidecar/src/gates.ts:73-142 的移植)。
 * 组合锁(Task 3)只验证静态条目;本插件在真实组合 boot 完成后逐条探活:
 * planMode/userQuestions 服务在位、waterfall 可用、git_push 探针经 waterfall 得 ask、
 * guard/execute 存在、同探针经 execute 必 isError、全局 schemas 无 run_code、
 * 分流/计划/目标工具在全局目录且对主 agent 可见、agent 注册表有界等待非空、
 * agent ctx 有 restrict、主 agent schemas 无 web_search/run_code。
 * 任一失败即 throw → `boot()` 拒绝 → 启动 catch 进恢复窗口(spec §6 第 3 条)。
 *
 * 旧 `assertNoListeningServers` 的 Desktop 改造:loopback DesktopWebServer 是
 * sanctioned listener——白名单 = 「`ctx.webServer` 实际监听端口 + apply 时刻
 * 已存在(基线)的 handle」,除此之外不得有新增 TCP/UDP listener(brief 严格
 * 语义;AA 桥等组合的既有 listener 在 apply 前已绑定,落入基线,实测见任务
 * 报告的 race 验证)。
 */

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

/** `exit_plan_mode` 的评审通道由本服务提供(plan-mode 的 inject 同源)。 */
type PlanModeService = {
  set(agent: unknown, active: boolean): unknown
}

/** `request_input`/plan-review 的答案通道;answerer 与 route 工具都依赖它。 */
type UserQuestionService = {
  ask(request: unknown): Promise<unknown>
}

/** cordis ctx 无单独类型导出(上游 0.1.6-alpha.2 逐字比对);同旧 sidecar 的 duck-type 风格。 */
type GatesContext = {
  /**
   * 按名取服务,不要求在 `inject` 里声明。planMode/userQuestions 必须走这里,
   * 原因见 {@link inject} 的注释。
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

/**
 * 本 profile 必须向模型暴露的工具(profile.ts 的锁层逐行对应):
 * - `propose_plan` / `request_input`:分流工具(route-tool-plugin);
 * - `exit_plan_mode`:官方 plan-mode 的评审出口;
 * - 目标三件套:profile.ts 始终启用 tool-goal(行断言亦要求该 override 命中)。
 * 只验证注册不够——present-as 按 agent restrict,故还要查主 agent 的 schema。
 * 导出给测试构建 fixture,避免测试另抄一份名单后与生产名单静默漂移。
 */
export const REQUIRED_TOOL_NAMES = [
  'propose_plan',
  'request_input',
  'exit_plan_mode',
  'get_goal',
  'create_goal',
  'update_goal',
] as const

/**
 * Loader entries activate concurrently, so a service or tool provider in the
 * same wave as the gate may still be registering when the gate first reads it.
 * Wait a bounded time before judging, the same way the agent registry is
 * awaited below; anything that never appears still fails (fail-closed).
 * This deadline is shared by the service waits and the tool waits.
 */
const BOOT_WAIT_TIMEOUT_MS = 5_000
const BOOT_WAIT_POLL_MS = 100

/** Tests shrink the shared deadline to 0/300 ms; production keeps the bounded wait. */
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
 * cordis `_reload` 会 await 它——门禁失败 → fiber _error → loader 上报 →
 * `boot()` 拒绝 → 启动 catch 进恢复窗口(spec §6 第 3 条)。
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
  const deadline = Date.now() + (options.toolWaitMs ?? BOOT_WAIT_TIMEOUT_MS)
  // 锁层要求 plan-mode 与 user-questions 两行必须生效。这两个服务不能放进
  // inject(见 inject 注释),所以门禁自己经 ctx.get 有界等待并判形状;缺失或
  // 形状不对都必须 throw,否则 route-tools / question-answerer 会被静默挂起。
  const planMode = await waitForService<PlanModeService>(
    ctx,
    'planMode',
    (service) => typeof service.set === 'function',
    deadline,
  )
  if (!planMode) {
    throw new Error('post-boot gate failed: planMode service is missing or malformed (the plan-mode row did not activate)')
  }
  const userQuestions = await waitForService<UserQuestionService>(
    ctx,
    'userQuestions',
    (service) => typeof service.ask === 'function',
    deadline,
  )
  if (!userQuestions) {
    throw new Error(
      'post-boot gate failed: userQuestions service is missing or malformed (the user-questions row did not activate)',
    )
  }
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
  const unregistered = await waitForRequiredTools(() => ctx.tools.schemas(), deadline)
  if (unregistered.length > 0) {
    throw new Error(`post-boot gate failed: required tool(s) not registered: ${unregistered.join(', ')}`)
  }
  // Re-check after the wait: a provider that registers late can also add a
  // forbidden name after the first read.
  assertNoForbiddenTools(toolNames(ctx.tools.schemas()), CATALOG_FORBIDDEN, 'global catalog')

  // dsh 的 agent 注册表在部分环境下异步物化(旧 sidecar 实测:vendored node+pnpm
  // 同时在 PATH 时间歇性返回空表)。有界等待再判负——超时仍无 agent 才算门禁失败
  // (fail-closed)。
  const AGENT_WAIT_TIMEOUT_MS = 10_000
  const agentDeadline = Date.now() + AGENT_WAIT_TIMEOUT_MS
  let agent = ctx.agents.list()[0]
  if (!agent?.ctx) {
    console.error('post-boot gate: agent registry empty at first check; waiting for materialization')
    while (!agent?.ctx && Date.now() < agentDeadline) {
      await new Promise((done) => setTimeout(done, 100))
      agent = ctx.agents.list()[0]
    }
  }
  if (!agent?.ctx) {
    throw new Error('post-boot gate failed: no agent is available to verify restrict()')
  }
  if (typeof agent.ctx.get?.('tools')?.restrict !== 'function') {
    throw new Error("post-boot gate failed: agent ctx.get('tools').restrict must be a function")
  }
  const mainAgentTools = agent.ctx.get('tools')
  const dumpAgentSchemas = mainAgentTools?.schemas
  if (typeof dumpAgentSchemas !== 'function') {
    throw new Error('post-boot gate failed: main-agent schema dump is unavailable')
  }
  const readAgentSchemas = () => dumpAgentSchemas.call(mainAgentTools)
  assertNoForbiddenTools(toolNames(readAgentSchemas()), MAIN_AGENT_FORBIDDEN, 'main-agent schema')
  const hidden = await waitForRequiredTools(readAgentSchemas, deadline)
  if (hidden.length > 0) {
    throw new Error(`post-boot gate failed: required tool(s) not visible to the main agent: ${hidden.join(', ')}`)
  }
  // Same late-registration hazard as the global catalog above.
  assertNoForbiddenTools(toolNames(readAgentSchemas()), MAIN_AGENT_FORBIDDEN, 'main-agent schema')
  await assertNoUnexpectedListeners(ctx, existingHandles)
}

function toolNames(schemas: readonly { name?: string }[]): Set<string> {
  return new Set(schemas.flatMap((schema) => (
    typeof schema.name === 'string' ? [schema.name] : []
  )))
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
 * Services are deliberately not injected, so they may activate after this gate.
 * Poll `ctx.get()` until the shared deadline; a service that is missing or has
 * the wrong shape still returns undefined and fails the gate (fail-closed).
 */
async function waitForService<T>(
  ctx: GatesContext,
  serviceName: string,
  isValid: (service: T) => boolean,
  deadline: number,
): Promise<T | undefined> {
  const read = (): T | undefined => {
    let value: unknown
    try {
      value = ctx.get(serviceName)
    } catch {
      return undefined
    }
    if (value === undefined || value === null) return undefined
    return isValid(value as T) ? value as T : undefined
  }
  let service = read()
  while (!service && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, BOOT_WAIT_POLL_MS))
    service = read()
  }
  return service
}

/**
 * Required tools may be registering in a concurrent Loader wave; poll until the
 * shared deadline so a slow-but-correct provider is not mistaken for a missing
 * one.
 * @returns names still missing when the deadline passes.
 */
async function waitForRequiredTools(
  schemas: () => readonly { name?: string }[],
  deadline: number,
): Promise<string[]> {
  const missing = (): string[] => REQUIRED_TOOL_NAMES.filter((name) => !toolNames(schemas()).has(name))
  let unresolved = missing()
  while (unresolved.length > 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, BOOT_WAIT_POLL_MS))
    unresolved = missing()
  }
  return unresolved
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
