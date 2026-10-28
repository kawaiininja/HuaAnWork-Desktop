import assert from 'node:assert/strict'

import { describe, expect, test } from 'vitest'

import type { SubagentRunRegistry } from '../../src/huaanwork-host/subagent-runs.ts'
import { createSubagentRunRegistry } from '../../src/huaanwork-host/subagent-runs.ts'
import { ROUTE_TABLE, RouteError, type RouteContext, type RouteTableEntry } from '../../src/huaanwork-host/routes.ts'

/**
 * `subagent.list` / `subagent.cancel` 的 HTTP 契约(Task 3)。
 *
 * 路由 handler 直接经 `ROUTE_TABLE` 调用,只钉契约本身:
 * - cancel 只认 `parentSessionId + runId` 精确匹配,未知/跨父会话一律 404;
 * - cancel 在清理闭包仍挂起时就返回 accepted(不 await 清理);
 * - list 缺 `parentSessionId` 是 400,成功时原样返回 registry snapshot。
 */

function route(method: string): RouteTableEntry {
  const entry = ROUTE_TABLE.find((candidate) => candidate.method === method)
  assert.ok(entry, `missing route ${method}`)
  return entry
}

function makeRouteCtx(registry: SubagentRunRegistry): RouteContext {
  return {
    dshHome: '/tmp/huaanwork-dsh',
    profileDir: '/tmp/huaanwork-profile',
    workspaceRoot: { current: '/tmp/huaanwork-workspace' },
    emit: () => undefined,
    logger: () => undefined,
    runtimeCtx: { huaanworkSubagentRuns: registry },
    requestRestart: async () => true,
  }
}

function makeRegistry(): SubagentRunRegistry {
  return createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
}

describe('subagent routes', () => {
  test('cancel validates parent and returns accepted before deferred cleanup finishes', async () => {
    let finish!: () => void
    const registry = makeRegistry()
    const routeCtx = makeRouteCtx(registry)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    registry.attachCancel(runId, () => new Promise<void>((resolve) => { finish = resolve }))
    const entry = route('subagent.cancel')

    const result = await entry.handler(
      { params: {}, query: new URLSearchParams(), body: { parentSessionId: 'parent', runId } },
      routeCtx,
    )
    assert.deepEqual(result, { status: 'accepted', runId })

    await assert.rejects(
      entry.handler(
        { params: {}, query: new URLSearchParams(), body: { parentSessionId: 'other', runId } },
        routeCtx,
      ),
      (error: unknown) => error instanceof RouteError && error.status === 404 && error.code === 'subagent-run-not-found',
    )
    finish()
  })

  test('cancel rejects body without parentSessionId or runId with 400', async () => {
    const entry = route('subagent.cancel')
    const routeCtx = makeRouteCtx(makeRegistry())

    for (const body of [{ runId: 'run-1' }, { parentSessionId: 'parent' }, undefined]) {
      await assert.rejects(
        entry.handler({ params: {}, query: new URLSearchParams(), body }, routeCtx),
        (error: unknown) => error instanceof RouteError && error.status === 400 && error.code === 'bad-request',
      )
    }
  })

  test('list requires parentSessionId and returns the parent-scoped snapshot unchanged', async () => {
    const registry = makeRegistry()
    const routeCtx = makeRouteCtx(registry)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    registry.begin({ parentSessionId: 'other-parent', kind: 'legacy', label: '@sibling' })
    const entry = route('subagent.list')

    for (const query of [new URLSearchParams(), new URLSearchParams({ parentSessionId: '' })]) {
      await assert.rejects(
        entry.handler({ params: {}, query, body: undefined }, routeCtx),
        (error: unknown) => error instanceof RouteError && error.status === 400 && error.code === 'bad-request',
      )
    }

    const result = await entry.handler(
      { params: {}, query: new URLSearchParams({ parentSessionId: 'parent' }), body: undefined },
      routeCtx,
    )
    assert.deepEqual(result, registry.snapshot('parent'))
    const snapshot = result as { runs: { runId: string; parentSessionId: string }[] }
    assert.deepEqual(snapshot.runs.map((run) => run.runId), [runId])
    expect(snapshot.runs.every((run) => run.parentSessionId === 'parent')).toBe(true)
  })
})
