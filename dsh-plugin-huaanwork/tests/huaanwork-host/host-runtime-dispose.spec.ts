import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  createAgentPackageRuntimeDisposer,
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
})
