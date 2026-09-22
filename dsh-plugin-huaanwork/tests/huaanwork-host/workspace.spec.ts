import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RouteError, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import { sessionSendBlockers } from '../../src/huaanwork-host/sessions.ts'
import {
  clearPendingWorkspaceRoot,
  neutralWorkspaceRoot,
  readPendingWorkspaceRoot,
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
    expect(JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')))
      .toEqual({ pendingRoot: resolve(target) })
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
    expect(JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')))
      .toEqual({ pendingRoot: neutral })
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
})
