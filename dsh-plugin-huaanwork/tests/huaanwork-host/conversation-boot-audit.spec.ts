import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  assertConversationSurface,
  REQUIRED_CONVERSATION_TOOL_NAMES,
} from '../../src/huaanwork-host/conversation-boot-audit.ts'
import { REQUIRED_TOOL_NAMES } from '../../src/huaanwork-host/gates.ts'

/**
 * `agents` is per session in production: a fresh Host has no agent before the
 * first session, so the audit must resolve on the global checks in that state.
 */
type AuditOverrides = {
  catalog?: readonly string[]
  visible?: readonly string[]
  /** `unknown` so tests can model a registered-but-wrongly-shaped service. */
  planMode?: unknown
  userQuestions?: unknown
  /** `false` models a registry that never materializes. */
  agents?: boolean
  /** `false` models an agent whose tools service never attaches. */
  agentTools?: boolean
}

/**
 * A composition that satisfies every audit check. The global catalog and the
 * main agent's (restricted) schemas are settable independently; the plan
 * services are exposed through `ctx.get()` like production.
 */
function auditContext(overrides: AuditOverrides = {}) {
  const catalog = [...(overrides.catalog ?? ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES])]
  const visible = [...(overrides.visible ?? catalog)]
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
    tools: { schemas: () => catalog.map(name => ({ name })) },
    agents: {
      list: () => overrides.agents === false
        ? []
        : [{
          ctx: {
            get: (name: string) => (name === 'tools' && overrides.agentTools !== false
              ? { schemas: () => visible.map(name => ({ name })) }
              : undefined),
          },
        }],
    },
  }
}

/** No settling wait: a missing item is judged on the first read. */
const immediate = { timeoutMs: 0, agentTimeoutMs: 0 }

test('a missing planMode service fails the audit', async () => {
  await assert.rejects(
    assertConversationSurface(auditContext({ planMode: undefined }), immediate),
    /planMode service is missing or malformed/,
  )
})

test('a registered planMode service with the wrong shape fails the audit', async () => {
  await assert.rejects(
    assertConversationSurface(auditContext({ planMode: {} }), immediate),
    /planMode service is missing or malformed/,
  )
})

test('a missing userQuestions service fails the audit', async () => {
  await assert.rejects(
    assertConversationSurface(auditContext({ userQuestions: undefined }), immediate),
    /userQuestions service is missing or malformed/,
  )
})

for (const missing of REQUIRED_CONVERSATION_TOOL_NAMES) {
  test(`a catalog without ${missing} fails the audit`, async () => {
    const catalog = ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES].filter(name => name !== missing)
    await assert.rejects(
      assertConversationSurface(auditContext({ catalog }), immediate),
      new RegExp(`required tool\\(s\\) not registered: ${missing}`),
    )
  })

  test(`${missing} hidden from the main agent fails the audit`, async () => {
    const visible = ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES].filter(name => name !== missing)
    await assert.rejects(
      assertConversationSurface(auditContext({ visible }), immediate),
      new RegExp(`required tool\\(s\\) not visible to the main agent: ${missing}`),
    )
  })
}

test('an agent registry that never materializes skips the agent check and resolves without waiting', async () => {
  const started = Date.now()
  // Production defaults: the opportunistic agent check must read once and move
  // on. Waiting here used to add 10 s to every boot (gate audit, then the Host
  // post-boot audit, then the boot itself).
  await assert.doesNotReject(assertConversationSurface(auditContext({ agents: false })))
  assert.ok(Date.now() - started < 1_000, 'the audit must not wait for an agent')
})

test('the global checks still fail the audit when no agent materializes', async () => {
  const catalog = ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES].filter(name => name !== 'propose_plan')
  await assert.rejects(
    assertConversationSurface(auditContext({ agents: false, catalog }), immediate),
    /required tool\(s\) not registered: propose_plan/,
  )
})

test('the service checks still fail the audit when no agent materializes', async () => {
  await assert.rejects(
    assertConversationSurface(auditContext({ agents: false, userQuestions: undefined }), immediate),
    /userQuestions service is missing or malformed/,
  )
})

test('an agent that exists on the first read still fails the audit for a hidden tool', async () => {
  const visible = ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES].filter(name => name !== 'exit_plan_mode')
  const started = Date.now()
  // Only `timeoutMs` is overridden: `agentTimeoutMs` keeps its production
  // default, proving the default is a single read, not a wait.
  await assert.rejects(
    assertConversationSurface(auditContext({ visible }), { timeoutMs: 0 }),
    /required tool\(s\) not visible to the main agent: exit_plan_mode/,
  )
  assert.ok(Date.now() - started < 1_000, 'a present agent must be judged on the first read')
})

test('an agent whose tools service never attaches fails the audit', async () => {
  await assert.rejects(
    assertConversationSurface(auditContext({ agentTools: false }), immediate),
    /the main-agent schema dump is unavailable/,
  )
})

test('a complete surface resolves', async () => {
  await assert.doesNotReject(assertConversationSurface(auditContext(), immediate))
})

test('the audit waits for a required tool that registers after the first read', async () => {
  let ready = false
  const incomplete = ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES.filter(name => name !== 'propose_plan')]
  const complete = ['read', ...REQUIRED_CONVERSATION_TOOL_NAMES]
  const context = {
    get: auditContext().get,
    tools: {
      schemas: () => (ready ? complete : incomplete).map(name => ({ name })),
    },
    agents: {
      list: () => [{
        ctx: {
          get: () => ({ schemas: () => complete.map(name => ({ name })) }),
        },
      }],
    },
  }
  const timer = setTimeout(() => {
    ready = true
  }, 100)
  try {
    await assert.doesNotReject(assertConversationSurface(context, { timeoutMs: 300, agentTimeoutMs: 0 }))
  } finally {
    clearTimeout(timer)
  }
}, 15_000)

test('the gate re-exports the audit required-tool list so the two checks cannot drift', () => {
  assert.equal(REQUIRED_TOOL_NAMES, REQUIRED_CONVERSATION_TOOL_NAMES)
})

/**
 * `huaanwork-gates` is an optional startup entry, so its throw is advisory.
 * Both Host boot paths must run the shared audit after `boot()` resolves and
 * before `profileBoot.markReady()`, which is what makes the failure fatal.
 * Runtime proof of the wiring belongs to the Task 8 boot smoke; this pins the
 * call order in the two entries.
 */
test('both Host boot paths audit the conversation surface after boot and before markReady', () => {
  for (const entry of ['host-bootstrap.ts', 'main.ts'] as const) {
    const source = readFileSync(join(import.meta.dirname, '../../src', entry), 'utf8')
    const bootAt = source.indexOf('const ctx = await boot(')
    const auditAt = source.indexOf('await assertConversationSurface(ctx)')
    const readyAt = source.indexOf('profileBoot.markReady()')
    assert.ok(bootAt >= 0, `${entry} must boot a Host context`)
    assert.ok(auditAt > bootAt, `${entry} must audit after boot() resolves`)
    assert.ok(readyAt > auditAt, `${entry} must audit before marking the profile ready`)
  }
})
