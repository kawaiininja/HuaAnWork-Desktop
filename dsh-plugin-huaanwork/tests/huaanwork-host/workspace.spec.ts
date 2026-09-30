import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RouteError, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import { sessionSendBlockers } from '../../src/huaanwork-host/sessions.ts'
import {
  clearPendingWorkspaceRoot,
  neutralWorkspaceRoot,
  PENDING_ROOT_TTL_MS,
  readPendingWorkspaceRoot,
  type PendingRootDrop,
} from '../../src/huaanwork-host/workspace-state.ts'
import { closeWorkspace, openWorkspace } from '../../src/huaanwork-host/workspace.ts'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'hw-ws-'))
})

afterEach(() => {
  // 自动化门禁用例会拨动 blockers,归位避免跨用例泄漏。
  sessionSendBlockers.agentAutomationQueued = 0
  sessionSendBlockers.workspaceDisplaced = false
  rmSync(profileDir, { recursive: true, force: true })
})

function makeRouteCtx(): { ctx: RouteContext; requestRestart: ReturnType<typeof vi.fn<() => Promise<boolean>>> } {
  const requestRestart = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  return {
    requestRestart,
    ctx: {
      dshHome: profileDir,
      profileDir,
      workspaceRoot: { current: profileDir },
      emit: (_event: RpcEvent) => {},
      logger: () => {},
      requestRestart,
    },
  }
}

describe('openWorkspace', () => {
  test('合法目录:写 pendingRoot(绝对路径)+ 调 requestRestart + 返回 { restarting: true, workspaceRoot }', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hw-ws-target-'))
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(openWorkspace(ctx, target)).resolves.toEqual({ restarting: true, workspaceRoot: resolve(target) })
    expect(readPendingWorkspaceRoot(profileDir)).toBe(resolve(target))
    // spec §14 第 23 条残余:`pendingRoot` 落盘带写入时刻(组合期 TTL 判据的原料)。
    const state = JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')) as
      { pendingRoot?: string; writtenAt?: string }
    expect(state.pendingRoot).toBe(resolve(target))
    expect(typeof state.writtenAt).toBe('string')
    expect(Math.abs(Date.now() - Date.parse(state.writtenAt!))).toBeLessThan(60_000)
    expect(requestRestart).toHaveBeenCalledTimes(1)
    rmSync(target, { recursive: true, force: true })
  })

  test('确认框取消:清除已写 pendingRoot + 返回当前根(不应答 restarting)(评审 D2)', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hw-ws-cancel-'))
    const { ctx, requestRestart } = makeRouteCtx()
    requestRestart.mockResolvedValue(false)
    await expect(openWorkspace(ctx, target)).resolves.toEqual({ workspaceRoot: profileDir })
    // pendingRoot 先写后清:文件留 `{}` 占位,读回 null——下次冷启动不会静默切换。
    expect(readPendingWorkspaceRoot(profileDir)).toBeNull()
    expect(JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8'))).toEqual({})
    expect(requestRestart).toHaveBeenCalledTimes(1)
    rmSync(target, { recursive: true, force: true })
  })

  test('相对路径 resolve 后写盘', async () => {
    const target = join(profileDir, 'subdir')
    mkdirSync(target)
    const previous = process.cwd()
    process.chdir(profileDir)
    try {
      const { ctx } = makeRouteCtx()
      await openWorkspace(ctx, 'subdir')
      // macOS 上 process.cwd() 返回 /private/var 实路径,resolve 以 cwd 为准。
      expect(readPendingWorkspaceRoot(profileDir)).toBe(join(process.cwd(), 'subdir'))
    } finally {
      process.chdir(previous)
    }
  })

  test('不存在路径 → 400 validation 且不写文件', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
    const missing = join(profileDir, 'nope')
    await expect(openWorkspace(ctx, missing)).rejects.toMatchObject({
      status: 400,
      code: 'validation',
    })
    expect(existsSync(join(profileDir, 'huaanwork-workspace.json'))).toBe(false)
    expect(requestRestart).not.toHaveBeenCalled()
  })

  test('文件(非目录)路径 → 400 validation', async () => {
    const file = join(profileDir, 'file.txt')
    writeFileSync(file, 'x')
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(openWorkspace(ctx, file)).rejects.toBeInstanceOf(RouteError)
    expect(requestRestart).not.toHaveBeenCalled()
  })

  test('空 root → 400 validation(旧 sidecar workspacePath 同语义)', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(openWorkspace(ctx, '')).rejects.toMatchObject({ status: 400, code: 'validation' })
    expect(requestRestart).not.toHaveBeenCalled()
  })

  test('已在目标根 → 短路:不写 pendingRoot、不重启,返回 { workspaceRoot }(旧 host.ts:1013 语义)', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hw-ws-same-'))
    const { ctx, requestRestart } = makeRouteCtx()
    ctx.workspaceRoot.current = target
    await expect(openWorkspace(ctx, target)).resolves.toEqual({ workspaceRoot: target })
    expect(requestRestart).not.toHaveBeenCalled()
    expect(existsSync(join(profileDir, 'huaanwork-workspace.json'))).toBe(false)
    rmSync(target, { recursive: true, force: true })
  })

  test('同根异写法(尾部分隔符 + .)同样短路:resolve 后比较', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hw-ws-same2-'))
    const { ctx, requestRestart } = makeRouteCtx()
    ctx.workspaceRoot.current = target
    await expect(openWorkspace(ctx, `${target}${sep}.`)).resolves.toEqual({ workspaceRoot: target })
    expect(requestRestart).not.toHaveBeenCalled()
    rmSync(target, { recursive: true, force: true })
  })

  test('后台自动化非空闲 → open 拒绝(旧 assertAutomationIdle 文案),不写不重启', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hw-ws-busy-'))
    sessionSendBlockers.agentAutomationQueued = 1
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(openWorkspace(ctx, target)).rejects.toThrow('后台自动化任务运行中，请稍候再试')
    expect(requestRestart).not.toHaveBeenCalled()
    expect(existsSync(join(profileDir, 'huaanwork-workspace.json'))).toBe(false)
    rmSync(target, { recursive: true, force: true })
  })
})

describe('closeWorkspace', () => {
  test('写 pendingRoot=中立根(非删文件)+ 调 requestRestart,确认后返回中立根', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
    const neutral = neutralWorkspaceRoot(profileDir)
    await expect(closeWorkspace(ctx)).resolves.toEqual({ restarting: true, workspaceRoot: neutral })
    expect(readPendingWorkspaceRoot(profileDir)).toBe(neutral)
    // 旧语义钉中立根:文件保留 `{}` 以外的可读状态,不删除。
    const state = JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')) as
      { pendingRoot?: string; writtenAt?: string }
    expect(state.pendingRoot).toBe(neutral)
    expect(typeof state.writtenAt).toBe('string')
    expect(requestRestart).toHaveBeenCalledTimes(1)
  })

  test('确认框取消:清除 pendingRoot + 返回当前根(评审 D2)', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
    requestRestart.mockResolvedValue(false)
    await expect(closeWorkspace(ctx)).resolves.toEqual({ workspaceRoot: profileDir })
    expect(readPendingWorkspaceRoot(profileDir)).toBeNull()
    expect(requestRestart).toHaveBeenCalledTimes(1)
  })

  test('已在中立根 → 短路:不写不重启,返回 { workspaceRoot }(旧 host.ts:1021 语义)', async () => {
    const neutral = neutralWorkspaceRoot(profileDir)
    const { ctx, requestRestart } = makeRouteCtx()
    ctx.workspaceRoot.current = neutral
    await expect(closeWorkspace(ctx)).resolves.toEqual({ workspaceRoot: neutral })
    expect(requestRestart).not.toHaveBeenCalled()
    expect(existsSync(join(profileDir, 'huaanwork-workspace.json'))).toBe(false)
  })

  test('后台自动化非空闲 → close 拒绝(旧 assertAutomationIdle 文案),不写不重启', async () => {
    sessionSendBlockers.workspaceDisplaced = true
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(closeWorkspace(ctx)).rejects.toThrow('后台自动化任务运行中，请稍候再试')
    expect(requestRestart).not.toHaveBeenCalled()
    expect(existsSync(join(profileDir, 'huaanwork-workspace.json'))).toBe(false)
  })
})

describe('pendingRoot 生命周期', () => {
  test('写 → 读 → 清(首个 effect)→ 读 null 往返一致;文件不删', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
    // 当前根指向别处,确保 open 走真重启写盘路径。
    ctx.workspaceRoot.current = join(profileDir, 'current-root')
    await openWorkspace(ctx, profileDir)
    const pending = readPendingWorkspaceRoot(profileDir)
    expect(pending).toBe(resolve(profileDir))
    // 模拟 apply 首个 effect:重启 generation 前清除。
    clearPendingWorkspaceRoot(profileDir)
    expect(readPendingWorkspaceRoot(profileDir)).toBeNull()
    expect(existsSync(join(profileDir, 'huaanwork-workspace.json'))).toBe(true)
    expect(requestRestart).toHaveBeenCalledTimes(1)
  })

  /**
   * spec §14 第 23 条残余:确认框挂起期间进程被杀 ⇒ pendingRoot 已落盘而无裁决。
   * 写入时刻 + TTL 把「无限期残留」收窄为「TTL 内残留」;超期在组合期丢弃并回报
   * 诚实诊断(丢弃 ≠ 静默:onDrop 诊断经 profile.ts 出组合结果、main.ts 落日志行)。
   */
  function writeStateFile(payload: Record<string, unknown>): void {
    writeFileSync(join(profileDir, 'huaanwork-workspace.json'), `${JSON.stringify(payload)}\n`, 'utf8')
  }

  test('超期 pendingRoot(> TTL)读回 null,并回报可诊断文案', () => {
    const now = Date.now()
    const writtenAt = new Date(now - PENDING_ROOT_TTL_MS - 60_000)
    writeStateFile({ pendingRoot: '/stale/root', writtenAt: writtenAt.toISOString() })
    const drops: PendingRootDrop[] = []
    expect(readPendingWorkspaceRoot(profileDir, { now, onDrop: drop => drops.push(drop) })).toBeNull()
    expect(drops).toHaveLength(1)
    expect(drops[0]!.root).toBe('/stale/root')
    expect(drops[0]!.message).toContain('/stale/root')
    expect(drops[0]!.message).toContain(String(PENDING_ROOT_TTL_MS / 60_000))
  })

  test('TTL 边界:恰在 TTL 上仍消费(丢弃判据是 age > TTL,不是 >=)', () => {
    const now = Date.now()
    writeStateFile({ pendingRoot: '/edge/root', writtenAt: new Date(now - PENDING_ROOT_TTL_MS).toISOString() })
    const drops: unknown[] = []
    expect(readPendingWorkspaceRoot(profileDir, { now, onDrop: drop => drops.push(drop) })).toBe('/edge/root')
    expect(drops).toHaveLength(0)
  })

  /**
   * 无 `writtenAt` = 本 TTL 之前的构建落盘的旧文件(一次性升级过渡):年龄不可知
   * 不等于必须丢弃——TTL 只收窄「无限期残留」,不回溯改变旧文件的消费语义
   * (逆向影响:升级前那次**已确认**的切换会被吞掉)。旧文件由首个 effect 清除。
   */
  test('无 writtenAt(或值不可解析)的旧文件维持既有消费语义,不被 TTL 判据误伤', () => {
    const now = Date.now()
    for (const payload of [{ pendingRoot: '/legacy/root' }, { pendingRoot: '/legacy/root', writtenAt: 'not-a-time' }]) {
      writeStateFile(payload)
      const drops: unknown[] = []
      expect(readPendingWorkspaceRoot(profileDir, { now, onDrop: drop => drops.push(drop) })).toBe('/legacy/root')
      expect(drops).toHaveLength(0)
    }
    // 时钟偏移(writtenAt 在未来)同样按「未超期」消费,不因偏移误伤。
    writeStateFile({ pendingRoot: '/skewed/root', writtenAt: new Date(now + 60_000).toISOString() })
    expect(readPendingWorkspaceRoot(profileDir, { now })).toBe('/skewed/root')
  })

  test('未注入 onDrop 时超期同样丢弃(诊断是可选透出,不是消费条件)', () => {
    const now = Date.now()
    writeStateFile({ pendingRoot: '/stale/root', writtenAt: new Date(now - PENDING_ROOT_TTL_MS - 1).toISOString() })
    expect(readPendingWorkspaceRoot(profileDir)).toBeNull()
  })
})
