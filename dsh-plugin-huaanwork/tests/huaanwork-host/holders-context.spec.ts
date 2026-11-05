import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'

import { installContextHolders } from '../../src/huaanwork-host/holders.ts'
import { sessionWorkspaceRoot } from '../../src/huaanwork-guardrails/sandbox-cwd.ts'
import { createTurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'

describe('huaanwork Cordis holders', () => {
  test('context maps assign on a cordis context', () => {
    installContextHolders()
    const ctx = new Context()
    const models = new Map([['session-a', 'm1']])
    const roots = new Map([['session-a', '/projects/a']])
    ctx.huaanworkSessionModels = models
    ctx.huaanworkSessionRoots = roots
    const scheduler = createTurnScheduler({ maxConcurrentTurns: () => 3, modelExists: () => true })
    ctx.huaanworkTurnScheduler = scheduler

    expect(ctx.huaanworkSessionModels).toBe(models)
    expect(ctx.huaanworkSessionRoots).toBe(roots)
    expect(ctx.huaanworkTurnScheduler).toBe(scheduler)
    // guardrails 侧与 holder 读同一张表。
    expect(sessionWorkspaceRoot(ctx, 'session-a')).toBe('/projects/a')
    expect(sessionWorkspaceRoot(ctx, 'unknown')).toBe(ctx.huaanworkWorkspaceRoot?.current ?? process.cwd())
  })
})
