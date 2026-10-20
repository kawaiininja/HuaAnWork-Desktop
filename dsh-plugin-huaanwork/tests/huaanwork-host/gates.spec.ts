import assert from 'node:assert/strict'
import { test } from 'vitest'
import { assertPostBootGate } from '../../src/huaanwork-host/gates.ts'

const REQUIRED_TOOLS = [
  'propose_plan',
  'request_input',
  'exit_plan_mode',
  'get_goal',
  'create_goal',
  'update_goal',
] as const

type GateOverrides = {
  catalog?: readonly string[]
  visible?: readonly string[]
  planMode?: { set(agent: unknown, active: boolean): unknown } | undefined
  userQuestions?: { ask(request: unknown): Promise<unknown> } | undefined
}

/**
 * A composition that satisfies every pre-existing gate check. Required-tool
 * assertions read the global catalog and the main agent's (restricted) schemas,
 * so the two lists are settable independently.
 */
function gateContext(overrides: GateOverrides = {}) {
  const catalog = [...(overrides.catalog ?? ['read', ...REQUIRED_TOOLS])]
  const visible = [...(overrides.visible ?? catalog)]
  const agentTools = {
    restrict() {
      return () => undefined
    },
    schemas: () => visible.map((name) => ({ name })),
  }
  return {
    waterfall: async () => ({ kind: 'ask' }),
    tools: {
      guard: () => () => undefined,
      async execute() {
        return { isError: true as const, error: new Error('denied'), content: [] }
      },
      schemas: () => catalog.map((name) => ({ name })),
    },
    agents: {
      list: () => [{
        ctx: {
          get: (name: string) => (name === 'tools' ? agentTools : undefined),
        },
      }],
    },
    webServer: { port: 0 },
    ...('planMode' in overrides
      ? (overrides.planMode === undefined ? {} : { planMode: overrides.planMode })
      : { planMode: { set() { return 'queued' } } }),
    ...('userQuestions' in overrides
      ? (overrides.userQuestions === undefined ? {} : { userQuestions: overrides.userQuestions })
      : {
          userQuestions: {
            async ask() {
              return { answers: [] }
            },
          },
        }),
  }
}

test('a missing planMode service fails the gate instead of skipping the route tools', async () => {
  await assert.rejects(
    assertPostBootGate(gateContext({ planMode: undefined })),
    /planMode service is missing/,
  )
})

test('a missing userQuestions service fails the gate instead of skipping the answerer', async () => {
  await assert.rejects(
    assertPostBootGate(gateContext({ userQuestions: undefined })),
    /userQuestions service is missing/,
  )
})

test('a route tool missing from the catalog fails the gate', async () => {
  const catalog = ['read', ...REQUIRED_TOOLS].filter((name) => name !== 'propose_plan')
  await assert.rejects(
    assertPostBootGate(gateContext({ catalog }), new Set(), { toolWaitMs: 0 }),
    /required tool\(s\) not registered: propose_plan/,
  )
})

test('a goal tool missing from the catalog fails the gate while tool-goal is enabled', async () => {
  const catalog = ['read', ...REQUIRED_TOOLS].filter((name) => name !== 'update_goal')
  await assert.rejects(
    assertPostBootGate(gateContext({ catalog }), new Set(), { toolWaitMs: 0 }),
    /required tool\(s\) not registered: update_goal/,
  )
})

test('a registered route tool hidden from the main agent fails the gate', async () => {
  const visible = ['read', ...REQUIRED_TOOLS].filter((name) => name !== 'exit_plan_mode')
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
