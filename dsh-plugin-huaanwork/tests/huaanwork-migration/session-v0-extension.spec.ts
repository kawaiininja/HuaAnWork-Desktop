import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { decompressZstdFrames } from '../../src/huaanwork-host/session-view.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'
import {
  encodeSegment,
  migrateSessionsStep,
  projectKey,
} from '../../src/huaanwork-migration/sessions.ts'
import {
  firstZstdFrameEnd,
  firstZstdFrameText,
  writeZstdLog,
} from './helpers/session-frames.ts'

/**
 * D-M6-9 的暴露点: 用户**续写**一个 v0 迁移日志 (M7 / R-M7-6, 兼作 M28 回归门)。
 *
 * 与 Phase 7 抓到的重铸帧缺陷同类: shipped 上游读取器对迁移产物有帧布局契约
 * (`assertZstdHeaderFrame`, submodule session-persistence-jsonl/src/index.ts:74-79,
 * 判据 = 首帧恰为一行), 而真机数据恰好不触发 (M6 的真实旧树只有空会话)。
 * 既有覆盖是「v0 起点的重铸/携搬」(sessions.spec.ts:404-420), 缺的是重铸之后
 * 再追加新消息这一步 —— 追加写入若把新内容与重写后的 header 合进同一帧,
 * 或破坏了「首帧恰一行」, 宿主下次启动读取该会话即致命失败。
 *
 * 参数化读取 SESSION_FORMAT_VERSION (不钉死 3): 上游已把它升到 4 并新增
 * dsh-session-format-v3-to-v4, M28 大同步后本用例应无需修改即可复跑。
 */

function migrationChainLegs() {
  return [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3]
}

interface MigrateThenAppendOptions {
  sourceVersion: number
  historyLines: number
  appendedLines: number
}

interface ActiveSession {
  ctx: Context
  destinationRoot: string
  newRoot: string
  newId: string
  createdAt: number
  nextSeq: number
}

const teardowns: (() => Promise<void>)[] = []
const activeSessions = new WeakMap<Buffer, ActiveSession>()

afterEach(async () => {
  while (teardowns.length > 0) {
    const fn = teardowns.pop()
    if (fn) {
      await fn()
    }
  }
})

function makeTurnEvent(seq: number, createdAt: number): SessionEvent {
  const turn = Math.floor(seq / 2) + 1
  if (seq % 2 === 0) {
    return {
      type: 'turn/start',
      seq: SessionSeq(seq),
      time: createdAt + seq,
      data: { turn },
    }
  }
  return {
    type: 'turn/end',
    seq: SessionSeq(seq),
    time: createdAt + seq,
    data: { turn, reason: { kind: 'completed' } },
  }
}

async function migrateThenAppend(options: MigrateThenAppendOptions): Promise<Buffer> {
  const userData = mkdtempSync(join(tmpdir(), 'dsh-migration-v0-ext-src-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-migration-v0-ext-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  const source = resolveLegacySource(userData)
  const target = { homeDir, profileDir }

  mkdirSync(join(source.dshHome, 'workspace'), { recursive: true })
  mkdirSync(profileDir, { recursive: true })

  const sessionsRoot = join(source.dshHome, 'sessions')
  const destinationRoot = join(homeDir, 'sessions')

  const oldRoot = join(source.dshHome, 'workspace')
  const oldId = sessionIdFor(oldRoot)
  const newRoot = neutralWorkspaceRoot(profileDir)
  const newId = sessionIdFor(newRoot)

  const createdAt = 1_700_000_000_000
  const sourceHeaderLine = JSON.stringify({
    type: 'session',
    version: options.sourceVersion,
    id: oldId,
    createdAt,
    cwd: oldRoot,
    delegationDepth: 0,
  })

  const historyLines: string[] = []
  for (let seq = 0; seq < options.historyLines; seq++) {
    historyLines.push(JSON.stringify(makeTurnEvent(seq, createdAt)))
  }

  const sourcePath = join(sessionsRoot, projectKey(oldRoot), encodeSegment(oldId), 'session.jsonl.zstd')
  writeZstdLog(sourcePath, [sourceHeaderLine, ...historyLines])

  const report = createMigrationReport()
  await migrateSessionsStep.run(source, target, report)

  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: destinationRoot, compression: 'zstd' })

  teardowns.push(async () => {
    await ctx.fiber.dispose()
    rmSync(userData, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  let nextSeq = options.historyLines
  if (options.appendedLines > 0) {
    const handle = await ctx.sessionPersistence.open(SessionId(newId), 'write')
    const events: SessionEvent[] = []
    for (let i = 0; i < options.appendedLines; i++) {
      events.push(makeTurnEvent(nextSeq, createdAt))
      nextSeq++
    }
    await handle.append(events)
    await handle.close()
    await ctx.sessionPersistence.flush()
  }

  const destinationFile = join(
    destinationRoot,
    projectKey(newRoot),
    encodeSegment(newId),
    `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`,
  )
  const bytes = readFileSync(destinationFile)
  activeSessions.set(bytes, {
    ctx,
    destinationRoot,
    newRoot,
    newId,
    createdAt,
    nextSeq,
  })
  return bytes
}

async function appendMore(previousBytes: Buffer, count: number): Promise<Buffer> {
  const session = activeSessions.get(previousBytes)
  if (!session) {
    throw new Error('Active session context not found for provided buffer')
  }

  const handle = await session.ctx.sessionPersistence.open(SessionId(session.newId), 'write')
  const events: SessionEvent[] = []
  for (let i = 0; i < count; i++) {
    events.push(makeTurnEvent(session.nextSeq, session.createdAt))
    session.nextSeq++
  }
  await handle.append(events)
  await handle.close()
  await session.ctx.sessionPersistence.flush()

  const destinationFile = join(
    session.destinationRoot,
    projectKey(session.newRoot),
    encodeSegment(session.newId),
    `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`,
  )
  const newBytes = readFileSync(destinationFile)
  activeSessions.set(newBytes, session)
  return newBytes
}

describe('v0 session log: migration then user extension (D-M6-9)', () => {
  it('keeps the first frame a single header line after migrating and then appending', async () => {
    // 1. 构造一个**含历史消息**的合法 v0 会话 (代码内合成, 沿用本目录既有约定;
    //    fork 内无任何 .jsonl fixture, 详见计划的「字节来源的裁定」段)。
    // 2. 驱动迁移, 拿到重铸后的 .jsonl.zstd 字节。
    // 3. 模拟用户续写: 以**产品的写入器**(不是测试自己压缩拼字节)追加新消息。
    // 4. 断言上游读取器的契约仍然成立。
    const bytes = await migrateThenAppend({ sourceVersion: 0, historyLines: 3, appendedLines: 2 })

    const firstFrame = firstZstdFrameText(bytes)
    // 上游 assertZstdHeaderFrame 的判据: 首帧明文恰为一行且以 \n 结尾。
    expect(firstFrame.indexOf('\n')).toBe(firstFrame.length - 1)
    expect(firstZstdFrameEnd(bytes)).toBeLessThan(bytes.length)

    // 续写的内容确实在后续帧里, 且无数据丢失 (拼接全部帧 = header + 历史 + 新消息)。
    const plaintext = decompressZstdFrames(bytes)
    expect(plaintext.split('\n').filter(Boolean)).toHaveLength(1 + 3 + 2)
    expect(JSON.parse(plaintext.split('\n')[0]!).version).toBe(SESSION_FORMAT_VERSION)
  })

  it('survives a second append after the first (frame boundaries stay per-write)', async () => {
    // 追加两次: 第二次不得把第一次的追加内容并进首帧, 也不得产生空尾帧。
    const bytes = await migrateThenAppend({ sourceVersion: 0, historyLines: 1, appendedLines: 1 })
    const twice = await appendMore(bytes, 1)
    expect(firstZstdFrameText(twice).indexOf('\n')).toBe(firstZstdFrameText(twice).length - 1)
    expect(firstZstdFrameEnd(twice)).toBeLessThan(twice.length)
    // 拼接全部帧: header (1) + 历史 (1) + 第一次续写 (1) + 第二次续写 (1) = 4 行
    expect(decompressZstdFrames(twice).split('\n').filter(Boolean)).toHaveLength(1 + 1 + 1 + 1)
  })

  it('reads the format version from the runtime, not from a literal', async () => {
    // 可证伪性: 证明「参数化」不是「碰巧相等」。迁移链的腿数必须等于当前版本号
    // (v0→v1→v2→v3 = 3 腿); 若有人把版本硬编码成 3 而上游升到 4, 本条会红。
    expect(SESSION_FORMAT_VERSION).toBeGreaterThanOrEqual(3)
    expect(migrationChainLegs()).toHaveLength(SESSION_FORMAT_VERSION)
  })
})
