import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RouteError, type RouteContext } from '../../src/huaanwork-host/routes.ts'
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
  rmSync(profileDir, { recursive: true, force: true })
})

function makeRouteCtx(): { ctx: RouteContext; requestRestart: ReturnType<typeof vi.fn> } {
  const requestRestart = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
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
  test('合法目录:写 pendingRoot(绝对路径)+ 调 requestRestart + 返回 { restarting: true }', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hw-ws-target-'))
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(openWorkspace(ctx, target)).resolves.toEqual({ restarting: true })
    expect(readPendingWorkspaceRoot(profileDir)).toBe(resolve(target))
    expect(JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')))
      .toEqual({ pendingRoot: resolve(target) })
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
})

describe('closeWorkspace', () => {
  test('写 pendingRoot=中立根(非删文件)+ 调 requestRestart', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
    await expect(closeWorkspace(ctx)).resolves.toEqual({ restarting: true })
    const neutral = neutralWorkspaceRoot(profileDir)
    expect(readPendingWorkspaceRoot(profileDir)).toBe(neutral)
    // 旧语义钉中立根:文件保留 `{}` 以外的可读状态,不删除。
    expect(JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')))
      .toEqual({ pendingRoot: neutral })
    expect(requestRestart).toHaveBeenCalledTimes(1)
  })
})

describe('pendingRoot 生命周期', () => {
  test('写 → 读 → 清(首个 effect)→ 读 null 往返一致;文件不删', async () => {
    const { ctx, requestRestart } = makeRouteCtx()
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
