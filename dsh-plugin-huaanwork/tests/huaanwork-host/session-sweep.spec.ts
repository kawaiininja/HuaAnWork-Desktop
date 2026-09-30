import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { bootHuaanworkHost, hostConfig, writeJsonFile, writeSessionLog } from './startup-sweep-fixture.ts'

/**
 * 启动路径上的项目存量清扫(Task 6.12,旧 host.ts:936 语义;`sweepProjectLegacySessions`
 * 的既有单测在 sessions.spec.ts:378)。这里钉的是**生产调用点传入的判据原料**:
 * ① 登记项目根取自 profileDir/projects.json,被 task.sessionId 引用的会话取自 tasks.json;
 * ② 中立根(profile 'workspace')必须作为 protectedRoots 传入——登记项目根可能是它的
 *    祖先目录,规格 §1.3 要求中立根下的游离会话永不清扫(旧 host.ts 同款注释);
 * ③ `shouldKeepSession` 的自动化双前缀保护(session-sweep.ts:48)在启动路径上照样生效。
 */

let tmpRoots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-session-sweep-spec-'))
  tmpRoots.push(root)
  return root
}

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
