import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createAgentPackageRuntimeDisposer,
  disposeAgentPackageHostRuntime,
  disposeAgentPackageRuntime,
} from '../../src/huaanwork-host/index.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
} from '../../src/huaanwork-host/agent-package/host.ts'
import type { AgentPackageTurnRuntime } from '../../src/huaanwork-host/agent-package/types.ts'

/**
 * 应用退出收尾(最终评审 I2)。
 *
 * 旧实现用 `void (async () => { await cancelAll(); await stopAll() })()`:
 * 应用可能在 `activation.dispose()`(上限 600s)期间退出,detached 子进程收不到
 * SIGTERM。现在的 effect disposer 返回 promise,并**先同步启动** kill 路径。
 *
 * 这里用与 index effect 相同的工厂与真实的在途回合登记表,只把 runtime 的
 * 启停换成内存桩 —— 不 spawn 任何真实长驻进程。
 */

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function installLocalPackage(): string {
  const profileDir = mkdtempSync(join(tmpdir(), 'huaanwork-host-dispose-'))
  roots.push(profileDir)
  const packageDir = join(profileDir, 'agents', 'weekly-report')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'agent.json'),
    JSON.stringify({
      schemaVersion: 1,
      slug: 'weekly-report',
      displayName: '周报助手',
      description: '把一周工作整理成周报',
      version: '1.0.0',
      draftId: 'draft-dispose',
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
      persona: 'persona.md',
      skill: null,
      tools: { mode: 'none' },
      allowSkills: [],
    }),
    'utf8',
  )
  writeFileSync(join(packageDir, 'persona.md'), '你是周报助手。', 'utf8')
  writeFileSync(
    join(profileDir, 'agents-state.json'),
    JSON.stringify({ 'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' } }),
    'utf8',
  )
  return profileDir
}

describe('host runtime disposal', () => {
  test('starts the kill path before awaiting turn cancellation and leaves no runtime', async () => {
    const profileDir = installLocalPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const order: string[] = []
    const stopped: string[] = []

    const host = createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      activeTurns: turns,
      createRuntime: async (options): Promise<AgentPackageTurnRuntime> => ({
        slug: options.manifest.slug,
        packageDir: options.packageDir,
        workspaceRoot: options.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      }),
      stopRuntime: async (runtime) => {
        stopped.push(runtime.slug)
      },
    })

    const pkg = await host.findInvocable('weekly-report')
    expect(pkg?.broken).toBeUndefined()
    const dispatched = await host.dispatch({
      ctx: {
        huaanworkWorkspaceRoot: { current: join(profileDir, 'workspace') },
        subagents: {
          startActivation: async () => ({
            childId: 'child',
            // 永不结算的长回合;收尾必须靠 dispose,不是等 result。
            result: new Promise(() => undefined),
            dispose: async () => {
              order.push('dispose')
            },
          }),
        },
      } as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写一份周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    // 与 index effect 相同的 disposer;stopAll 用内存桩记录调用顺序。
    const dispose = createAgentPackageRuntimeDisposer(turns, async () => {
      order.push('stop-all')
    })
    await dispose()

    // kill 路径在取消收尾之前同步启动,且两者都被 await 到。
    expect(order).toEqual(['stop-all', 'dispose'])
    expect(stopped).toEqual(['weekly-report'])
    await dispatched.afterIdle()
  })

  test('disposeAgentPackageRuntime awaits a slow stop-all before resolving', async () => {
    const turns = createAgentPackageActiveTurnRegistry()
    let releaseStop: () => void = () => undefined
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let resolved = false
    const disposing = disposeAgentPackageRuntime(turns, () => stopGate).then(() => {
      resolved = true
    })

    // 没有在途回合时 cancelAll 立即结算,但 disposer 仍必须等 stop-all 结算。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolved).toBe(false)
    releaseStop()
    await disposing
    expect(resolved).toBe(true)
  })

  /**
   * 最终评审 Critical 回归:effect cleanup 必须**直接发起**收尾。
   *
   * `ctx.effect` 的 cleanup 返回值被 Cordis 当作 disposer 保存。旧实现
   * `return createAgentPackageRuntimeDisposer(agentPackageTurns)` 返回的是工厂造出的
   * **函数**,Cordis 只把它存起来、永远不会调用 ⇒ `cancelAll('dispose')` 与
   * `stopAllAgentPackageProcesses()` 在应用退出/热替换时从不执行。
   *
   * 这里走 index.ts 里 effect cleanup 实际调用的同一表达式
   * (`disposeAgentPackageHostRuntime`),而不是直接调工厂。
   */
  test('the effect cleanup entry point starts the teardown instead of returning a function', async () => {
    const profileDir = installLocalPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const order: string[] = []
    const stopped: string[] = []
    let releaseStop: () => void = () => undefined
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let releaseDispose: () => void = () => undefined
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })

    const host = createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      activeTurns: turns,
      createRuntime: async (options): Promise<AgentPackageTurnRuntime> => ({
        slug: options.manifest.slug,
        packageDir: options.packageDir,
        workspaceRoot: options.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      }),
      stopRuntime: async (runtime) => {
        stopped.push(runtime.slug)
      },
    })

    const pkg = await host.findInvocable('weekly-report')
    expect(pkg?.broken).toBeUndefined()
    const dispatched = await host.dispatch({
      ctx: {
        huaanworkWorkspaceRoot: { current: join(profileDir, 'workspace') },
        subagents: {
          startActivation: async () => ({
            childId: 'child',
            result: new Promise(() => undefined),
            dispose: async () => {
              order.push('dispose')
              // 回合收尾故意拖住:证明 kill 路径不是在 cancelAll 结算之后才启动。
              await disposeGate
            },
          }),
        },
      } as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写一份周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    // 回归形状对照:工厂返回的是一个函数(旧 cleanup 的返回值),不是 promise。
    const factoryShaped = createAgentPackageRuntimeDisposer(turns)
    expect(typeof factoryShaped).toBe('function')
    expect(factoryShaped).not.toBeInstanceOf(Promise)

    // effect cleanup 实际执行的表达式;返回值必须是收尾 promise。
    const cleanup = disposeAgentPackageHostRuntime(turns, () => {
      order.push('stop-kick')
      return stopGate
    })
    expect(cleanup).toBeInstanceOf(Promise)

    // kill 路径在本次 tick 内同步启动:回合的取消收尾还没跑完,它已经发出。
    expect(order[0]).toBe('stop-kick')

    let settled = false
    void cleanup.then(() => {
      settled = true
    })
    // stop-all 未结算 ⇒ 整条收尾不 resolve。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    releaseStop()
    // 回合收尾仍未结算 ⇒ 继续等 cancelAll,不是「kill 完就 return」。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    releaseDispose()
    await cleanup

    // 收尾完成后:kill 先发、回合与 runtime 都停、没有留下运行中的回合。
    expect(order).toEqual(['stop-kick', 'dispose'])
    expect(stopped).toEqual(['weekly-report'])
    await dispatched.afterIdle()
    await expect(turns.cancelAll('dispose')).resolves.toBeUndefined()
  })
})

/**
 * Task 8(R-T8-1):清理失败不再被吞。
 *
 * 取消路径(`record.cancel`,update/remove/revoke 走它)必须把 dispose/stop 的
 * 超时或拒绝聚合成 rejection;idle 路径(`afterIdle`)只记录日志并 resolve —
 * 父会话的 idle 清理被一个卡住的子代理拖成 rejection 会把正常的 idle 变成错误。
 */
describe('cleanup failure propagation', () => {
  function neverDisposingActivation(): {
    childId: string
    result: Promise<unknown>
    dispose: () => Promise<void>
  } {
    return {
      childId: 'child',
      result: new Promise(() => undefined),
      dispose: () => new Promise(() => undefined),
    }
  }

  function makeTimeoutHost(profileDir: string, activeTurns: ReturnType<typeof createAgentPackageActiveTurnRegistry>) {
    return createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      activeTurns,
      cleanupTimeoutMs: 20,
      createRuntime: async (options): Promise<AgentPackageTurnRuntime> => ({
        slug: options.manifest.slug,
        packageDir: options.packageDir,
        workspaceRoot: options.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      }),
      stopRuntime: async () => undefined,
    })
  }

  test('reports a dispose timeout from the cancel path instead of silently claiming cleanup succeeded', async () => {
    const profileDir = installLocalPackage()
    const activeTurns = createAgentPackageActiveTurnRegistry()
    const host = makeTimeoutHost(profileDir, activeTurns)
    const pkg = await host.findInvocable('weekly-report')
    expect(pkg?.broken).toBeUndefined()

    await host.dispatch({
      ctx: {
        huaanworkWorkspaceRoot: { current: join(profileDir, 'workspace') },
        subagents: { startActivation: async () => neverDisposingActivation() },
      } as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写一份周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    // update/remove 走的是 record.cancel ⇒ 清理超时必须到达调用方。
    await expect(activeTurns.cancelBySlug('weekly-report', 'remove')).rejects.toThrow(/清理失败|dispose/)
  })

  test('logs cleanup failures on the idle path instead of rejecting afterIdle', async () => {
    const profileDir = installLocalPackage()
    const activeTurns = createAgentPackageActiveTurnRegistry()
    const host = makeTimeoutHost(profileDir, activeTurns)
    const pkg = await host.findInvocable('weekly-report')
    expect(pkg?.broken).toBeUndefined()

    const dispatched = await host.dispatch({
      ctx: {
        huaanworkWorkspaceRoot: { current: join(profileDir, 'workspace') },
        subagents: { startActivation: async () => neverDisposingActivation() },
      } as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写一份周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(' '))
    })
    try {
      await expect(dispatched.afterIdle()).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(logged.join('\n')).toMatch(/清理失败/)
  })
})
