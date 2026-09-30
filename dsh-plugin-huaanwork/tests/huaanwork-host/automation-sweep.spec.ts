import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  filterLegacyChatAutoRuns,
  removeLegacyChatAutoSessionDirs,
  sweepLegacyChatAutoSessions,
  type AutomationSweepFileSystem,
} from '../../src/huaanwork-host/automation-sweep.ts'

/**
 * G6 legacy chat-auto 清扫的移植回归(Task 6.12;源码 = 旧 sidecar
 * `packages/sidecar/src/automations.ts:573-655`)。
 *
 * 判据(逐字保持):
 * ① 只删 `huaanwork-chat-auto-*`,两级(散文件)与三级(会话目录)布局都扫;
 * ② `huaanwork-auto-` 当前通道会话与 `huaanwork-chat-<digest>` 用户会话永不触碰;
 * ③ `automations/*.runs.jsonl` 只删引用 legacy 会话的行,**不可解析的行保留**
 *    (清扫绝不抹掉无法解析的历史);
 * ④ 返回删除数;幂等 —— 第二跑为 0 且 readdir 次数不随会话数增长
 *    (裁定 D-M6-24:apply() 每次 generation 重启都会跑,不能全树遍历)。
 */

let tmpRoots: string[] = []

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-automation-sweep-spec-'))
  tmpRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
  tmpRoots = []
})

function sessionLog(id: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1_000, cwd, delegationDepth: 0 })}\n`
}

/** 三级布局:会话目录 `<sessionsRoot>/<cwdKey>/<sessionId>/session.jsonl`。 */
function writeSessionDir(sessionsRoot: string, cwdKey: string, id: string, cwd: string): string {
  const dir = join(sessionsRoot, cwdKey, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), sessionLog(id, cwd), 'utf8')
  return dir
}

/** 顶层会话目录(历史布局残留):`<sessionsRoot>/<sessionId>/session.jsonl`。 */
function writeTopLevelSessionDir(sessionsRoot: string, id: string, cwd: string): string {
  const dir = join(sessionsRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl'), sessionLog(id, cwd), 'utf8')
  return dir
}

/** 两级布局(历史残留):散文件 `<sessionsRoot>/<cwdKey>/<sessionId>.jsonl`。 */
function writeSessionFile(sessionsRoot: string, cwdKey: string, id: string, cwd: string): string {
  mkdirSync(join(sessionsRoot, cwdKey), { recursive: true })
  const path = join(sessionsRoot, cwdKey, `${id}.jsonl`)
  writeFileSync(path, sessionLog(id, cwd), 'utf8')
  return path
}

function writeRunsFile(runsDir: string, automationId: string, lines: readonly string[]): string {
  mkdirSync(runsDir, { recursive: true })
  const path = join(runsDir, `${automationId}.runs.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

/** 计数 fs 桩(readdir 调用数 = 清扫的目录枚举工作量;文件内容读不计数)。 */
function countingFs(): { fs: AutomationSweepFileSystem; readdirCalls: () => number } {
  let calls = 0
  return {
    readdirCalls: () => calls,
    fs: {
      readdir: async (path) => {
        calls += 1
        return await readdir(path)
      },
      readFile: (path, encoding) => readFile(path, encoding),
      rm: (path, options) => rm(path, options),
      writeFile: (path, data, encoding) => writeFile(path, data, encoding),
    },
  }
}

describe('legacy chat-auto sweep (G6)', () => {
  test('deletes only huaanwork-chat-auto-* session directories at host startup', async () => {
    const root = freshRoot()
    const sessionsRoot = join(root, 'sessions')
    const keptAuto = writeSessionDir(sessionsRoot, 'repo', 'huaanwork-auto-a1-r1', join(root, 'proj'))
    const doomed = writeSessionDir(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1', join(root, 'proj'))
    const keptUser = writeSessionDir(sessionsRoot, 'repo', 'huaanwork-0123456789abcdef', join(root, 'proj'))

    const removed = await sweepLegacyChatAutoSessions(sessionsRoot, join(root, 'automations'))

    expect(removed).toBe(1)
    expect(existsSync(doomed)).toBe(false)
    expect(existsSync(keptAuto)).toBe(true)
    expect(existsSync(keptUser)).toBe(true)
  })

  test('handles both the three-level and the two-level legacy layouts', async () => {
    const root = freshRoot()
    const sessionsRoot = join(root, 'sessions')
    // 旧 session-sweep.ts:11-14 记载的两种存量布局:三级(会话目录)与两级(散文件)。
    const doomedDir = writeSessionDir(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1', join(root, 'proj'))
    const doomedFile = writeSessionFile(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r2', join(root, 'proj'))
    const keptDir = writeSessionDir(sessionsRoot, 'repo', 'huaanwork-auto-a1-r3', join(root, 'proj'))

    const removed = await sweepLegacyChatAutoSessions(sessionsRoot, join(root, 'automations'))

    expect(removed).toBe(2)
    expect(existsSync(doomedDir)).toBe(false)
    expect(existsSync(doomedFile)).toBe(false)
    expect(existsSync(keptDir)).toBe(true)
  })

  test('filters run records referencing swept sessions out of *.runs.jsonl', async () => {
    const root = freshRoot()
    const runsDir = join(root, 'automations')
    const legacyLine = JSON.stringify({
      runId: 'r1',
      startedAt: 1,
      endedAt: 2,
      ok: true,
      sessionId: 'huaanwork-chat-auto-a1-r1',
      output: '旧通道运行',
    })
    const currentLine = JSON.stringify({
      runId: 'r2',
      startedAt: 3,
      endedAt: 4,
      ok: true,
      sessionId: 'huaanwork-auto-a1-r2',
      output: '当前通道运行',
    })
    const junkLine = '{not json'
    const runsPath = writeRunsFile(runsDir, 'a1', [legacyLine, currentLine, junkLine])
    // 无 legacy 引用的文件一字不动(没有任何行被删时不重写)。
    const untouchedPath = writeRunsFile(runsDir, 'a2', [currentLine])

    const removed = await sweepLegacyChatAutoSessions(join(root, 'sessions'), runsDir)

    expect(removed).toBe(0)
    expect(readFileSync(runsPath, 'utf8')).toBe(`${currentLine}\n${junkLine}\n`)
    expect(readFileSync(untouchedPath, 'utf8')).toBe(`${currentLine}\n`)
  })

  test('empties a runs file whose records all referenced legacy sessions', async () => {
    const root = freshRoot()
    const runsDir = join(root, 'automations')
    const legacyLine = JSON.stringify({ runId: 'r1', sessionId: 'huaanwork-chat-auto-a1-r1' })
    const runsPath = writeRunsFile(runsDir, 'a1', [legacyLine])

    await filterLegacyChatAutoRuns(runsDir)

    expect(readFileSync(runsPath, 'utf8')).toBe('')
  })

  test('never touches huaanwork-chat-<digest> user sessions', async () => {
    const root = freshRoot()
    const sessionsRoot = join(root, 'sessions')
    const nested = writeSessionDir(sessionsRoot, 'repo', 'huaanwork-chat-feedfacecafebeef', join(root, 'proj'))
    const flat = writeSessionFile(sessionsRoot, 'repo', 'huaanwork-chat-deadbeefdeadbeef', join(root, 'proj'))
    const topLevel = writeTopLevelSessionDir(sessionsRoot, 'huaanwork-chat-0123456789abcdef', join(root, 'proj'))

    const removed = await sweepLegacyChatAutoSessions(sessionsRoot, join(root, 'automations'))

    expect(removed).toBe(0)
    expect(existsSync(nested)).toBe(true)
    expect(existsSync(flat)).toBe(true)
    expect(existsSync(topLevel)).toBe(true)
  })

  test('returns the number of removed directories and is a no-op on the second run', async () => {
    const root = freshRoot()
    const sessionsRoot = join(root, 'sessions')
    writeSessionDir(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1', join(root, 'proj'))
    writeTopLevelSessionDir(sessionsRoot, 'huaanwork-chat-auto-a1-r2', join(root, 'proj'))
    writeSessionFile(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r3', join(root, 'proj'))

    const first = await sweepLegacyChatAutoSessions(sessionsRoot, join(root, 'automations'))
    const second = await sweepLegacyChatAutoSessions(sessionsRoot, join(root, 'automations'))

    expect(first).toBe(3)
    expect(second).toBe(0)
  })

  test('is idempotent and cheap on a generation restart', async () => {
    const buildProfile = (sessionCount: number): { sessionsRoot: string; runsDir: string } => {
      const root = freshRoot()
      const sessionsRoot = join(root, 'sessions')
      writeSessionDir(sessionsRoot, 'repo', 'huaanwork-chat-auto-a1-r1', join(root, 'proj'))
      for (let index = 0; index < sessionCount; index += 1) {
        writeSessionDir(sessionsRoot, 'repo', `huaanwork-${index.toString(16).padStart(16, '0')}`, join(root, 'proj'))
      }
      const runsDir = join(root, 'automations')
      writeRunsFile(runsDir, 'a1', [JSON.stringify({ runId: 'r2', sessionId: 'huaanwork-auto-a1-r2' })])
      return { sessionsRoot, runsDir }
    }

    const small = buildProfile(2)
    const big = buildProfile(40)
    const smallFs = countingFs()
    const bigFs = countingFs()

    // 第一跑清掉 legacy;第二跑(generation 重启)没有可删项。
    expect(await sweepLegacyChatAutoSessions(small.sessionsRoot, small.runsDir, smallFs.fs)).toBe(1)
    expect(await sweepLegacyChatAutoSessions(small.sessionsRoot, small.runsDir, smallFs.fs)).toBe(0)
    expect(await sweepLegacyChatAutoSessions(big.sessionsRoot, big.runsDir, bigFs.fs)).toBe(1)
    expect(await sweepLegacyChatAutoSessions(big.sessionsRoot, big.runsDir, bigFs.fs)).toBe(0)

    // 两跑 readdir 次数 = 顶层 sessions/ + 各非 legacy 顶层项下探一层 + runs 目录。
    // 判据是「不随会话数增长」(40 条与 2 条同值),不钉精确数字:将来给清扫加一条
    // probe readdir 不应假红;下界只防计数桩本身失效(恒 0)。
    expect(smallFs.readdirCalls()).toBeGreaterThan(0)
    expect(bigFs.readdirCalls()).toBe(smallFs.readdirCalls())
    expect(await removeLegacyChatAutoSessionDirs(big.sessionsRoot)).toBe(0)
  })
})
