/**
 * Host-side enforcement for the conversation surface the HuaAnWork profile promises:
 * `planMode`, `userQuestions`, and the route/plan/goal tools.
 *
 * `huaanwork-gates` is an optional startup entry. Cordis leaves a plugin whose
 * `apply` throws in an error state, but `dsh-app-boot` only warns for entries it
 * does not consider required (`huaanwork-gates` is not in the vendor-owned
 * required set) and `boot()` still resolves. The gate's own throw is therefore
 * advisory. This audit is the enforcement: both Host boot paths call it after
 * `boot()` resolves, so its throw reaches the startup failure path — the
 * recovery window for the in-process Host, a rejected `boot` RPC (and Host
 * exit) for the isolated Host.
 *
 * The gate calls {@link assertConversationSurface} too, so the two checks cannot
 * drift apart.
 *
 * The services and the global tool catalog are always fail-closed. The
 * main-agent catalog check is conditional: agents are created per session on
 * demand, so a fresh Host legitimately has no agent at boot. Waiting for one
 * that never appears must not abort startup.
 */

type ToolSchema = { name?: string }

type MainAgentTools = {
  schemas?: () => readonly ToolSchema[]
}

type AgentRecord = {
  ctx?: {
    get?: (name: string) => MainAgentTools | undefined
  }
}

/**
 * Everything this audit reads. Cordis `Context` satisfies it structurally;
 * `tools`/`agents` are optional only so a composition missing one fails with a
 * diagnostic instead of a property-access `TypeError`.
 */
export type ConversationSurfaceContext = {
  /** Read a service by name without requiring it in `inject`. */
  get(name: string): unknown
  tools?: {
    schemas?: () => readonly ToolSchema[]
  }
  agents?: {
    list?: () => readonly AgentRecord[]
  }
}

export type ConversationSurfaceAuditOptions = {
  /** Bounded wait for the plan services and the tool catalogs to settle; defaults to 5 s. */
  timeoutMs?: number
  /**
   * Bounded wait for the main agent to materialize; defaults to 10 s. When no
   * agent appears the audit resolves on the global checks instead of throwing:
   * agents are created per session, so a fresh Host has none at boot.
   */
  agentTimeoutMs?: number
}

/**
 * The tools this profile must expose to the model, matching the locked rows in
 * `profile.ts`:
 * - `propose_plan` / `request_input`: the routing tools (route-tool-plugin);
 * - `exit_plan_mode`: the official plan-mode review exit;
 * - the goal trio: `tool-goal` is an always-enabled override row.
 *
 * Registration alone is not enough — `present-as` restricts per agent, so the
 * main agent's schema dump must carry them too. Exported so tests and the gate
 * build fixtures from the same list instead of copying it.
 */
export const REQUIRED_CONVERSATION_TOOL_NAMES = [
  'propose_plan',
  'request_input',
  'exit_plan_mode',
  'get_goal',
  'create_goal',
  'update_goal',
] as const

const DEFAULT_WAIT_TIMEOUT_MS = 5_000
const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 10_000
const WAIT_POLL_MS = 100

/**
 * Throws when a boot-enforced part of the conversation surface is missing.
 *
 * The Loader activates entries concurrently, so a provider in the same wave can
 * still be registering when the first read happens; every wait is bounded by
 * `timeoutMs`/`agentTimeoutMs` and a missing service or global tool still fails
 * (fail-closed). After `boot()` resolves the tree is settled, so the default
 * deadline is only a safety margin.
 *
 * The main-agent check differs: agents are created per session on demand, so a
 * fresh Host legitimately has none. When no agent materializes within the
 * bounded wait the per-agent restriction has nothing to read and the audit
 * resolves on the checks above; it does not treat an absent agent as a missing
 * surface. If an agent does exist, its restricted schema dump must carry every
 * required tool or the audit throws.
 */
export async function assertConversationSurface(
  ctx: ConversationSurfaceContext,
  options: ConversationSurfaceAuditOptions = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
  // The plan services are deliberately absent from the gate's `inject`: an
  // unmet inject leaves the gate fiber pending, and `dsh-app-boot` only warns
  // for optional entries, so a missing service would boot green while the
  // route/answerer plugins stay suspended. Resolve them here and fail closed on
  // absence or wrong shape.
  const planMode = await waitForService<{ set?: unknown }>(
    ctx,
    'planMode',
    service => typeof service.set === 'function',
    deadline,
  )
  if (planMode === undefined) {
    throw new Error(
      'conversation surface audit failed: planMode service is missing or malformed (the plan-mode row did not activate)',
    )
  }
  const userQuestions = await waitForService<{ ask?: unknown }>(
    ctx,
    'userQuestions',
    service => typeof service.ask === 'function',
    deadline,
  )
  if (userQuestions === undefined) {
    throw new Error(
      'conversation surface audit failed: userQuestions service is missing or malformed (the user-questions row did not activate)',
    )
  }

  const readCatalog = (): readonly ToolSchema[] => {
    const tools = ctx.tools
    if (typeof tools?.schemas !== 'function') {
      throw new Error('conversation surface audit failed: the tools service has no schema dump')
    }
    return tools.schemas()
  }
  const unregistered = await waitForRequiredTools(readCatalog, deadline)
  if (unregistered.length > 0) {
    throw new Error(`conversation surface audit failed: required tool(s) not registered: ${unregistered.join(', ')}`)
  }

  // The registry materializes asynchronously in some environments (the old
  // sidecar intermittently saw an empty list), so wait before judging. An
  // absent agent is not a failure: sessions create their agents on demand, so
  // before the first session there is no per-agent surface to verify.
  const agent = await waitForAgent(ctx, Date.now() + (options.agentTimeoutMs ?? DEFAULT_AGENT_WAIT_TIMEOUT_MS))
  if (agent?.ctx === undefined) {
    return
  }
  const mainAgentTools = agent.ctx.get?.('tools')
  const dumpSchema = mainAgentTools?.schemas
  if (typeof dumpSchema !== 'function') {
    throw new Error('conversation surface audit failed: the main-agent schema dump is unavailable')
  }
  const readMainAgentSchemas = (): readonly ToolSchema[] => dumpSchema.call(mainAgentTools)
  const hidden = await waitForRequiredTools(readMainAgentSchemas, deadline)
  if (hidden.length > 0) {
    throw new Error(`conversation surface audit failed: required tool(s) not visible to the main agent: ${hidden.join(', ')}`)
  }
}

export function toolNames(schemas: readonly ToolSchema[]): Set<string> {
  return new Set(schemas.flatMap(schema => (
    typeof schema.name === 'string' ? [schema.name] : []
  )))
}

/**
 * Services are not injected, so they may activate after their consumers. Poll
 * `ctx.get()` until the shared deadline; a service that is missing or has the
 * wrong shape still returns undefined and fails the audit (fail-closed).
 */
async function waitForService<T>(
  ctx: ConversationSurfaceContext,
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
  while (service === undefined && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, WAIT_POLL_MS))
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
  schemas: () => readonly ToolSchema[],
  deadline: number,
): Promise<string[]> {
  const missing = (): string[] =>
    REQUIRED_CONVERSATION_TOOL_NAMES.filter(name => !toolNames(schemas()).has(name))
  let unresolved = missing()
  while (unresolved.length > 0 && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, WAIT_POLL_MS))
    unresolved = missing()
  }
  return unresolved
}

/**
 * The main agent carries the per-agent tool restriction (`present-as`), so its
 * schema dump is the only proof that the required tools are actually visible.
 * The registry can materialize asynchronously; poll until the deadline. An
 * agent that never appears is a legitimate fresh-Host state (agents are created
 * per session), so this returns undefined and the caller skips the per-agent
 * check rather than failing.
 */
async function waitForAgent(
  ctx: ConversationSurfaceContext,
  deadline: number,
): Promise<AgentRecord | undefined> {
  const read = (): AgentRecord | undefined => ctx.agents?.list?.()[0]
  let agent = read()
  while (agent?.ctx === undefined && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, WAIT_POLL_MS))
    agent = read()
  }
  return agent
}
