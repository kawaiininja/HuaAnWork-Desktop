import assert from 'node:assert/strict'
import { test } from 'vitest'
import { assertPostBootGate, inject, REQUIRED_TOOL_NAMES } from '../../src/huaanwork-host/gates.ts'

type GateOverrides = {
  catalog?: readonly string[]
  visible?: readonly string[]
  /** Global-catalog schemas, for providers that register after the first read. */
  toolSchemas?: () => readonly string[]
  /** `unknown` so tests can model a registered-but-wrongly-shaped service. */
  planMode?: unknown
  userQuestions?: unknown
  /** Overrides the agent registry; defaults to one materialized main agent. */
  agents?: {
    list(): readonly {
      ctx?: { get?: (name: string) => { restrict?: unknown; schemas?: () => readonly { name?: string }[] } | undefined }
    }[]
  }
}

/**
 * A composition that satisfies every pre-existing gate check. Required-tool
 * assertions read the global catalog and the main agent's (restricted) schemas,
 * so the two lists are settable independently. The plan services are exposed
 * through `ctx.get()` exactly like production (`inject` must not carry them).
 */
function gateContext(overrides: GateOverrides = {}) {
  const catalog = [...(overrides.catalog ?? ['read', ...REQUIRED_TOOL_NAMES])]
  const visible = [...(overrides.visible ?? catalog)]
  const agentTools = {
    restrict() {
      return () => undefined
    },
    schemas: () => visible.map((name) => ({ name })),
  }
  const services = new Map<string, unknown>()
  if (!('planMode' in overrides)) {
    services.set('planMode', { set() { return 'queued' } })
  } else if (overrides.planMode !== undefined) {
    services.set('planMode', overrides.planMode)
  }
  if (!('userQuestions' in overrides)) {
    services.set('userQuestions', {
      async ask() {
        return { answers: [] }
      },
    })
  } else if (overrides.userQuestions !== undefined) {
    services.set('userQuestions', overrides.userQuestions)
  }
  return {
    get: (name: string) => services.get(name),
    waterfall: async () => ({ kind: 'ask' }),
    tools: {
      guard: () => () => undefined,
      async execute() {
        return { isError: true as const, error: new Error('denied'), content: [] }
      },
      schemas: () => (overrides.toolSchemas ?? (() => catalog))().map((name) => ({ name })),
    },
    agents: overrides.agents ?? {
      list: () => [{
        ctx: {
          get: (name: string) => (name === 'tools' ? agentTools : undefined),
        },
      }],
    },
    webServer: { port: 0 },
  }
}

test('the gate injects only the three original services so it cannot be re-masked', () => {
  assert.deepEqual(inject, ['tools', 'agents', 'webServer'])
})

test('a missing planMode service fails the gate within the deadline', async () => {
  const started = Date.now()
  await assert.rejects(
    assertPostBootGate(gateContext({ planMode: undefined }), new Set(), { toolWaitMs: 50 }),
    /planMode service is missing/,
  )
  assert.ok(Date.now() - started < 1_000, 'the gate must not wait past its deadline')
})

test('a missing userQuestions service fails the gate within the deadline', async () => {
  const started = Date.now()
  await assert.rejects(
    assertPostBootGate(gateContext({ userQuestions: undefined }), new Set(), { toolWaitMs: 50 }),
    /userQuestions service is missing/,
  )
  assert.ok(Date.now() - started < 1_000, 'the gate must not wait past its deadline')
})

test('a registered planMode service with the wrong shape fails the gate', async () => {
  await assert.rejects(
    assertPostBootGate(gateContext({ planMode: {} }), new Set(), { toolWaitMs: 0 }),
    /planMode service is missing or malformed/,
  )
})

test('the gate polls until a required tool registers after the first read', async () => {
  let ready = false
  const incomplete = ['read', ...REQUIRED_TOOL_NAMES.filter((name) => name !== 'propose_plan')]
  const complete = ['read', ...REQUIRED_TOOL_NAMES]
  const context = gateContext({ toolSchemas: () => (ready ? complete : incomplete) })
  const timer = setTimeout(() => {
    ready = true
  }, 100)
  try {
    await assert.doesNotReject(assertPostBootGate(context, new Set(), { toolWaitMs: 300 }))
  } finally {
    clearTimeout(timer)
  }
}, 15_000)

test('a required tool that never registers still fails within the deadline', async () => {
  const catalog = ['read', ...REQUIRED_TOOL_NAMES].filter((name) => name !== 'exit_plan_mode')
  const started = Date.now()
  await assert.rejects(
    assertPostBootGate(gateContext({ catalog }), new Set(), { toolWaitMs: 100 }),
    /required tool\(s\) not registered: exit_plan_mode/,
  )
  assert.ok(Date.now() - started < 2_000, 'the gate must not wait past its deadline')
})

test('a route tool missing from the catalog fails the gate', async () => {
  const catalog = ['read', ...REQUIRED_TOOL_NAMES].filter((name) => name !== 'propose_plan')
  await assert.rejects(
    assertPostBootGate(gateContext({ catalog }), new Set(), { toolWaitMs: 0 }),
    /required tool\(s\) not registered: propose_plan/,
  )
})

test('a goal tool missing from the catalog fails the gate while tool-goal is enabled', async () => {
  const catalog = ['read', ...REQUIRED_TOOL_NAMES].filter((name) => name !== 'update_goal')
  await assert.rejects(
    assertPostBootGate(gateContext({ catalog }), new Set(), { toolWaitMs: 0 }),
    /required tool\(s\) not registered: update_goal/,
  )
})

test('a registered route tool hidden from the main agent fails the gate', async () => {
  const visible = ['read', ...REQUIRED_TOOL_NAMES].filter((name) => name !== 'exit_plan_mode')
  await assert.rejects(
    assertPostBootGate(gateContext({ visible }), new Set(), { toolWaitMs: 0 }),
    /required tool\(s\) not visible to the main agent: exit_plan_mode/,
  )
})

test('a complete composition passes the gate', async () => {
  const getActiveHandles = (process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[]
  })._getActiveHandles
  const baseline = new Set<unknown>(getActiveHandles?.() ?? [])
  await assert.doesNotReject(assertPostBootGate(gateContext(), baseline, { toolWaitMs: 0 }))
}, 15_000)

test('the gate skips restrict() when no agent exists before the first session', async () => {
  // Agents are created per session, so a fresh Host has none: the shared audit
  // passes and the gate must not throw on the same legitimate state.
  const getActiveHandles = (process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[]
  })._getActiveHandles
  const baseline = new Set<unknown>(getActiveHandles?.() ?? [])
  await assert.doesNotReject(
    assertPostBootGate(gateContext({ agents: { list: () => [] } }), baseline, { toolWaitMs: 0 }),
  )
}, 15_000)

test('the gate skips restrict() while the main agent has not materialized its context', async () => {
  const getActiveHandles = (process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[]
  })._getActiveHandles
  const baseline = new Set<unknown>(getActiveHandles?.() ?? [])
  await assert.doesNotReject(
    assertPostBootGate(gateContext({ agents: { list: () => [{}] } }), baseline, { toolWaitMs: 0 }),
  )
}, 15_000)

test('a materialized agent without restrict() still fails the gate', async () => {
  const agents = {
    list: () => [{
      ctx: {
        get: (name: string) => (name === 'tools'
          ? { schemas: () => ['read', ...REQUIRED_TOOL_NAMES].map((tool) => ({ name: tool })) }
          : undefined),
      },
    }],
  }
  await assert.rejects(
    assertPostBootGate(gateContext({ agents }), new Set(), { toolWaitMs: 0 }),
    /agent ctx\.get\('tools'\)\.restrict must be a function/,
  )
})
