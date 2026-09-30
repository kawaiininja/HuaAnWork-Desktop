import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { HUAANWORK_EVENTS_PATH } from '../../src/huaanwork-host/events.ts'
import { resetProjectLegacySweepLatch } from '../../src/huaanwork-host/session-sweep.ts'
import { HUAANWORK_MIGRATION_STEPS, runHuaanworkLegacyMigration } from '../../src/huaanwork-migration/index.ts'
import { bootHuaanworkHost, hostConfig, writeJsonFile, writeSessionLog } from './startup-sweep-fixture.ts'

/**
 * 生产调用点断言(Task 6.12,裁定 D-M6-24 / R-6.12-1):`apply()` 在每次 generation
 * 启动时执行 ① legacy chat-auto 清扫(旧 host.ts:922 语义,**每代都跑**)与
 * ② 项目存量会话清扫(旧 host.ts:936 语义,**进程级门闩:每宿主进程只跑一次**——
 * 它要解压会话日志读 cwd,generation 重启不得重读);清扫天然晚于 main.ts 的一次性
 * 迁移钩子 ⇒ 迁移搬进来的 legacy chat-auto 日志由同一次启动清掉。
 */

let tmpRoots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-host-index-spec-'))
  tmpRoots.push(root)
  return root
}

beforeEach(() => {
  // 门闩随宿主进程生灭;单测要在一支 vitest 进程里演「新进程 / 两代」⇒ 逐用例复位。
  resetProjectLegacySweepLatch()
})

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
  tmpRoots = []
})

describe('sweepProjectLegacySessions has a production call site', () => {
  test('runs from the host plugin apply()', async () => {
    // 源码文本断言:两个清扫的生产调用点确实写在 apply() 所在的 index.ts 里(不是死代码)。
    // 项目侧经门闩包裹体接入(index.ts → session-sweep.ts 内调 sweepProjectLegacySessions)。
    const source = readFileSync(new URL('../../src/huaanwork-host/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('sweepLegacyChatAutoSessions(')
    expect(source).toContain('sweepProjectLegacySessionsOncePerProcess(')
    const sweepSource = readFileSync(new URL('../../src/huaanwork-host/session-sweep.ts', import.meta.url), 'utf8')
    expect(sweepSource).toContain('sweepProjectLegacySessions(')

    // 行为断言:起临时 profile、boot,三类存量各归其位。
    const root = freshRoot()
    const config = hostConfig(root)
    const sessionsRoot = join(config.dshHome, 'sessions')
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    writeJsonFile(join(config.profileDir, 'projects.json'), {
      projects: [{ id: 'p1', name: 'P', root: projectRoot, createdAt: 1 }],
    })
    const referencedId = 'huaanwork-1111111111111111'
    writeJsonFile(join(config.profileDir, 'tasks.json'), {
      tasks: [{ id: 't1', projectId: 'p1', name: 'Task', createdAt: 1, sessionId: referencedId }],
    })
    // cwd 在项目根内、未被 task 引用 ⇒ 项目存量清扫删除(旧 host.ts:936)。
    const unreferenced = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-feedfacecafebeef', projectRoot)
    // 被 task.sessionId 引用 ⇒ 保留。
    const referenced = writeSessionLog(sessionsRoot, 'repo', referencedId, projectRoot)
    // legacy chat-auto 会话:cwd 在项目根外,只有前缀清扫管它(旧 host.ts:922)。
    const chatAuto = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1', join(root, 'elsewhere'))

    const booted = await bootHuaanworkHost(config)

    expect(existsSync(unreferenced)).toBe(false)
    expect(existsSync(chatAuto)).toBe(false)
    expect(existsSync(referenced)).toBe(true)
    // apply() 的其余接线未因清扫接线而回归:routes 与 upgrade 照常注册。
    expect(booted.registeredPaths).toContain('/huaanwork')
    expect(booted.upgradePaths).toContain(HUAANWORK_EVENTS_PATH)
    await booted.ctx.fiber.dispose()
  })

  test('runs after the one-time migration, not before', async () => {
    const root = freshRoot()
    const config = hostConfig(root)
    const legacyConfigDir = join(root, 'legacy-user-data')
    const legacyDshHome = join(legacyConfigDir, 'dsh')
    // 迁移按相对路径搬运(header.cwd 非旧中立根、路径非 canonical),故落点目录名不变。
    const legacyChatAuto = writeSessionLog(
      join(legacyDshHome, 'sessions'),
      'repo',
      'huaanwork-chat-auto-a1-r1',
      join(root, 'proj'),
    )

    const migration = await runHuaanworkLegacyMigration({
      source: { configDir: legacyConfigDir, dshHome: legacyDshHome },
      target: { homeDir: config.dshHome, profileDir: config.profileDir },
      steps: HUAANWORK_MIGRATION_STEPS,
    })
    expect(migration.performed).toBe(true)

    const migrated = join(config.dshHome, 'sessions', 'repo', 'huaanwork-chat-auto-a1-r1')
    expect(existsSync(migrated)).toBe(true)
    expect(existsSync(legacyChatAuto)).toBe(true) // spec §8:源树永不删除

    const booted = await bootHuaanworkHost(config)

    // 同一次启动的清扫掉了迁移搬进来的 legacy chat-auto 日志 ⇒ 清扫确实晚于迁移。
    expect(existsSync(migrated)).toBe(false)
    expect(existsSync(legacyChatAuto)).toBe(true)
    await booted.ctx.fiber.dispose()
  })

  test('is idempotent on a generation restart (second boot removes nothing more)', async () => {
    const root = freshRoot()
    const config = hostConfig(root)
    const sessionsRoot = join(config.dshHome, 'sessions')
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    writeJsonFile(join(config.profileDir, 'projects.json'), {
      projects: [{ id: 'p1', name: 'P', root: projectRoot, createdAt: 1 }],
    })
    writeSessionLog(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1', join(root, 'elsewhere'))
    const surviving = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-feedfacecafebeef', join(root, 'elsewhere'))
    const sweptOnFirstBoot = join(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1')

    const first = await bootHuaanworkHost(config)
    await first.ctx.fiber.dispose()
    expect(existsSync(sweptOnFirstBoot)).toBe(false)
    const snapshot = readdirSync(join(sessionsRoot, 'repo')).sort()
    const second = await bootHuaanworkHost(config)
    await second.ctx.fiber.dispose()

    expect(existsSync(surviving)).toBe(true)
    expect(readdirSync(join(sessionsRoot, 'repo')).sort()).toEqual(snapshot)
  })

  test('runs the project sweep once per host process (generation restart does not re-read session logs)', async () => {
    const root = freshRoot()
    const config = hostConfig(root)
    const projectRoot = join(root, 'proj')
    mkdirSync(projectRoot, { recursive: true })
    writeJsonFile(join(config.profileDir, 'projects.json'), {
      projects: [{ id: 'p1', name: 'P', root: projectRoot, createdAt: 1 }],
    })
    const sessionsRoot = join(config.dshHome, 'sessions')
    const sweptOnFirstGeneration = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-1212121212121212', projectRoot)

    const first = await bootHuaanworkHost(config)
    await first.ctx.fiber.dispose()
    expect(existsSync(sweptOnFirstGeneration)).toBe(false) // 第一代:项目清扫执行

    // 两代之间新落两个会话:未被引用的项目会话(只有项目清扫管)与 legacy chat-auto
    // (每代都跑的 chat-auto 清扫管)。
    const mintedBetween = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-3434343434343434', projectRoot)
    const chatAuto = writeSessionLog(sessionsRoot, 'repo', 'huaanwork-chat-auto-a9-r9', join(root, 'elsewhere'))

    const second = await bootHuaanworkHost(config)
    await second.ctx.fiber.dispose()

    // 门闩(R-6.12-1 第 2 条):第二代不再读会话日志 ⇒ 两代之间新落的未引用项目会话留存。
    expect(existsSync(mintedBetween)).toBe(true)
    // chat-auto 清扫不走门闩,仍在每次 generation 执行(R-6.12-1 第 1 条)。
    expect(existsSync(chatAuto)).toBe(false)
  })
})
