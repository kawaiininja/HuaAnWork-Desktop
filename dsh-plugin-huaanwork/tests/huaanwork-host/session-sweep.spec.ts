import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  resetProjectLegacySweepLatch,
  sweepProjectLegacySessions,
  sweepProjectLegacySessionsOncePerProcess,
  type ProjectLegacySweepFileSystem,
} from '../../src/huaanwork-host/session-sweep.ts'
import { readSessionHeader } from '../../src/huaanwork-host/session-view.ts'
import { bootHuaanworkHost, hostConfig, writeJsonFile, writeSessionLog } from './startup-sweep-fixture.ts'

/**
 * 启动路径上的项目存量清扫(Task 6.12,旧 host.ts:936 语义;`sweepProjectLegacySessions`
 * 的既有单测在 sessions.spec.ts:378)。这里钉的是**生产调用点传入的判据原料**:
 * ① 登记项目根取自 profileDir/projects.json,被 task.sessionId 引用的会话取自 tasks.json;
 * ② 中立根(profile 'workspace')必须作为 protectedRoots 传入——登记项目根可能是它的
 *    祖先目录,规格 §1.3 要求中立根下的游离会话永不清扫(旧 host.ts 同款注释);
 * ③ `shouldKeepSession` 的自动化双前缀保护(session-sweep.ts:48)在启动路径上照样生效。
 *
 * 另钉裁定 R-6.12-1 的进程级门闩:每次 `apply()`(generation 重启)不能重读会话日志。
 * 门闩是进程域的,单测要在一支 vitest 进程里演「新宿主进程」⇒ beforeEach 复位。
 */

let tmpRoots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-session-sweep-spec-'))
  tmpRoots.push(root)
  return root
}

beforeEach(() => {
  // 每个用例模拟一个新的宿主进程(门闩随进程生灭;不清则用例间互相干扰)。
  resetProjectLegacySweepLatch()
})

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
  tmpRoots = []
})

describe('startup project legacy sweep (旧 host.ts:936 语义)', () => {
  test('protects the neutral root even when a registered project root is its ancestor', async () => {
    const root = freshRoot()
    const config = hostConfig(root)
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    // 登记项目根 = root,是中立根 <profileDir>/workspace 的祖先目录。
    writeJsonFile(join(config.profileDir, 'projects.json'), {
      projects: [{ id: 'p1', name: 'P', root, createdAt: 1 }],
    })
    const sessionsRoot = join(config.dshHome, 'sessions')
    const neutralRoot = join(config.profileDir, 'workspace')
    const neutralSession = writeSessionLog(sessionsRoot, 'neutral-repo', 'huaanwork-aaaaaaaaaaaaaaaa', neutralRoot)
    const projectSession = writeSessionLog(sessionsRoot, 'project-repo', 'huaanwork-bbbbbbbbbbbbbbbb', projectRoot)

    const booted = await bootHuaanworkHost(config)

    expect(existsSync(neutralSession)).toBe(true)
    expect(existsSync(projectSession)).toBe(false)
    await booted.ctx.fiber.dispose()
  })

  test('keeps unreferenced automation sessions while sweeping the project tree', async () => {
    const root = freshRoot()
    const config = hostConfig(root)
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    writeJsonFile(join(config.profileDir, 'projects.json'), {
      projects: [{ id: 'p1', name: 'P', root: projectRoot, createdAt: 1 }],
    })
    const sessionsRoot = join(config.dshHome, 'sessions')
    const automationSession = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-auto-a1-r2', projectRoot)
    const plainSession = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-cccccccccccccccc', projectRoot)

    const booted = await bootHuaanworkHost(config)

    expect(existsSync(automationSession)).toBe(true)
    expect(existsSync(plainSession)).toBe(false)
    await booted.ctx.fiber.dispose()
  })
})

/** 计数桩:readdir / readEntryNames / readHeader(= 整份日志读 + 解压)/ remove 各自计数。 */
function countingFileSystem(): {
  fs: ProjectLegacySweepFileSystem
  counts: () => { readdir: number; readEntryNames: number; readHeader: number; remove: number }
} {
  const counts = { readdir: 0, readEntryNames: 0, readHeader: 0, remove: 0 }
  return {
    counts: () => ({ ...counts }),
    fs: {
      readdir: async (path, options) => {
        counts.readdir += 1
        return await readdir(path, options)
      },
      readEntryNames: async (path) => {
        counts.readEntryNames += 1
        return await readdir(path)
      },
      readHeader: async (path) => {
        counts.readHeader += 1
        return await readSessionHeader(path)
      },
      remove: async (path, options) => {
        counts.remove += 1
        await rm(path, options)
      },
    },
  }
}

describe('进程级一次性门闩(R-6.12-1:项目清扫每宿主进程只扫一次)', () => {
  test('the second generation claims no slot and performs zero session-log reads', async () => {
    const root = freshRoot()
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    const sessionsRoot = join(root, 'dsh', 'sessions')
    const unreferenced = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-eeeeeeeeeeeeeeee', projectRoot)
    const counting = countingFileSystem()

    // 第一代:清扫执行——读 header 判 cwd 归属,删掉未被 task 引用的项目会话。
    const first = await sweepProjectLegacySessionsOncePerProcess(sessionsRoot, [projectRoot], new Set(), [], counting.fs)
    expect(first).toEqual({ ran: true, removed: 1, skipped: 0 })
    expect(existsSync(unreferenced)).toBe(false)
    const afterFirst = counting.counts()
    expect(afterFirst.readdir).toBeGreaterThan(0)
    expect(afterFirst.readHeader).toBeGreaterThan(0)

    // 两代之间新落一个未被引用的项目会话:第二代若仍清扫,它会被删。
    const mintedBetween = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-ffffffffffffffff', projectRoot)
    const second = await sweepProjectLegacySessionsOncePerProcess(sessionsRoot, [projectRoot], new Set(), [], counting.fs)

    expect(second).toEqual({ ran: false, removed: 0, skipped: 0 })
    expect(counting.counts()).toEqual(afterFirst) // 零新增 readdir / readHeader:不再重读会话日志
    expect(existsSync(mintedBetween)).toBe(true)
  })

  test('the latch is per process: resetting it (new host process) re-arms the sweep', async () => {
    const root = freshRoot()
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    const sessionsRoot = join(root, 'dsh', 'sessions')
    const counting = countingFileSystem()
    const run = () => sweepProjectLegacySessionsOncePerProcess(sessionsRoot, [projectRoot], new Set(), [], counting.fs)

    expect((await run()).ran).toBe(true)
    expect((await run()).ran).toBe(false)
    resetProjectLegacySweepLatch() // 模拟新的宿主进程
    expect((await run()).ran).toBe(true)
  })

  test('costs zero I/O when no project roots are registered (R-6.12-1 第 3 条)', async () => {
    const root = freshRoot()
    const sessionsRoot = join(root, 'dsh', 'sessions')
    // cwd 目录真实存在也不是项目根:判据恒不成立 ⇒ 不该发生任何 readdir / 日志读。
    const elsewhereSession = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-abababababababab', join(root, 'elsewhere'))
    const counting = countingFileSystem()

    const swept = await sweepProjectLegacySessions(sessionsRoot, [], new Set(), [], counting.fs)

    expect(swept).toEqual({ removed: 0, skipped: 0 })
    expect(existsSync(elsewhereSession)).toBe(true)
    expect(counting.counts()).toEqual({ readdir: 0, readEntryNames: 0, readHeader: 0, remove: 0 })
  })
})
