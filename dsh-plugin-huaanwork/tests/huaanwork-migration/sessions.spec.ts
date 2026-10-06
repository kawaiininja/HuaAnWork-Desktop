import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { firstZstdFrameEnd, firstZstdFrameText, writeZstdLog } from './helpers/session-frames.ts'
import { runHuaanworkLegacyMigration } from '../../src/huaanwork-migration/index.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'
import {
  createMigrateSessionsStep,
  encodeSegment,
  migrateSessionsStep,
  projectKey,
  rewriteSessionHeader,
} from '../../src/huaanwork-migration/sessions.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { decompressZstdFrames } from '../../src/huaanwork-host/session-view.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'

const PLAN = { oldNeutralId: 'huaanwork-0000000000000000', newNeutralId: 'huaanwork-1111111111111111' }
const ROOTS = { oldNeutral: '/old/cfg/dsh/workspace', newNeutral: '/new/profiles/desktop/workspace' }

describe('rewriteSessionHeader', () => {
  it('re-mints the id and the cwd of a neutral-root header', () => {
    const line = JSON.stringify({ type: 'session', version: 0, id: PLAN.oldNeutralId, createdAt: 1, cwd: ROOTS.oldNeutral })
    expect(JSON.parse(rewriteSessionHeader(line, PLAN, ROOTS))).toEqual({
      type: 'session', version: 0, id: PLAN.newNeutralId, createdAt: 1, cwd: ROOTS.newNeutral,
    })
  })

  it('preserves the v0 format version rather than upgrading it (D-M6-9)', () => {
    const line = JSON.stringify({ type: 'session', version: 0, id: 'huaanwork-2222222222222222', createdAt: 1 })
    expect(JSON.parse(rewriteSessionHeader(line, PLAN, ROOTS)).version).toBe(0)
  })

  it('rewrites a parentSession that pointed at the neutral root', () => {
    const line = JSON.stringify({ type: 'session', version: 0, id: 'sub-1', parentSession: PLAN.oldNeutralId, origin: 'subagent' })
    expect(JSON.parse(rewriteSessionHeader(line, PLAN, ROOTS)).parentSession).toBe(PLAN.newNeutralId)
  })

  it('returns the line verbatim when nothing in it needs rewriting', () => {
    const line = JSON.stringify({ type: 'session', version: 0, id: 'huaanwork-chat-9f8e7d6c5b4a3210', cwd: '/abs/project' })
    expect(rewriteSessionHeader(line, PLAN, ROOTS)).toBe(line)
  })

  it('returns a non-header first line verbatim instead of corrupting it', () => {
    expect(rewriteSessionHeader('{"type":"turn"}', PLAN, ROOTS)).toBe('{"type":"turn"}')
    expect(rewriteSessionHeader('not json at all', PLAN, ROOTS)).toBe('not json at all')
  })
})

describe('projectKey / encodeSegment (pinned upstream transcription)', () => {
  it('produces the project directory names the legacy disk holds, escapes included', () => {
    expect(projectKey('/Users/x/proj')).toBe('--Users-x-proj--')
    expect(projectKey('C:\\Users\\x\\proj')).toBe('--C-Users-x-proj--')
    expect(projectKey('/Users/x/我的 项目')).toBe('--Users-x-~6211~7684~0020~9879~76EE--')
  })

  it('keeps huaanwork session ids as literal directory names and escapes everything else', () => {
    expect(encodeSegment('huaanwork-0123456789abcdef')).toBe('huaanwork-0123456789abcdef')
    expect(encodeSegment('huaanwork-auto-a1-r1')).toBe('huaanwork-auto-a1-r1')
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('a/b')).toBe('a~002Fb')
  })
})

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'mig-sessions-src-'))
  const dshHome = join(userData, 'dsh')
  // 旧中性根目录必须存在(旧 <OLD_DSH>/workspace 是 sessionIdFor 的输入)。
  mkdirSync(join(dshHome, 'workspace'), { recursive: true })
  const homeDir = mkdtempSync(join(tmpdir(), 'mig-sessions-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  return {
    source: resolveLegacySource(userData),
    target: { homeDir, profileDir },
    userData, dshHome, homeDir, profileDir,
    sessionsRoot: join(dshHome, 'sessions'),
    destinationRoot: join(homeDir, 'sessions'),
  }
}

/** 构造一份真实的 zstd 会话日志:首行 header + 两行 turn,逐帧压缩后拼接。 */
function writeZstdSession(dir: string, sessionId: string, cwd: string | undefined): string {
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session', version: 0, id: sessionId, createdAt: 1_700_000_000_000,
    ...(cwd === undefined ? {} : { cwd }), delegationDepth: 0,
  })
  const body = [header, JSON.stringify({ type: 'turn', index: 0 }), JSON.stringify({ type: 'turn', index: 1 })]
  // 逐帧压缩再拼接:decompressZstdFrames 依赖「多个独立 zstd 帧串接」这一真实形状。
  const frames = Buffer.concat(body.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
  const path = join(dir, 'session.jsonl.zstd')
  writeFileSync(path, frames)
  return path
}

/** 未压缩的 JSONL 会话日志(旧两级布局与 generation-0 原生布局都可能是它)。 */
function writePlainSession(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

/** 读回一份日志的首行(与读侧同源:zstd 走逐帧解压)。 */
function firstLine(path: string): string {
  const bytes = readFileSync(path)
  const text = path.endsWith('.zstd') ? decompressZstdFrames(bytes) : bytes.toString('utf8')
  return text.split('\n', 1)[0] ?? ''
}

describe('migrateSessionsStep', () => {
  it('copies project-rooted sessions verbatim, keeping their ids and projectKey directories', async () => {
    const f = fixture()
    // 旧侧磁盘上的真实目录名(literal 断言,不是本实现算出来的)——
    // 与上游 projectKey(format.ts:224-244)逐字对齐。
    const cases = [
      { dir: '--Users-x-proj--', cwd: '/Users/x/proj', id: 'huaanwork-2222222222222222' },
      { dir: '--C-Users-x-proj--', cwd: 'C:\\Users\\x\\proj', id: 'huaanwork-2222222222222223' },
      { dir: '--Users-x-~6211~7684~0020~9879~76EE--', cwd: '/Users/x/我的 项目', id: 'huaanwork-2222222222222224' },
    ]
    const fixtures = cases.map((item) => ({
      ...item,
      source: writeZstdSession(join(f.sessionsRoot, item.dir, item.id), item.id, item.cwd),
    }))
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    for (const item of fixtures) {
      const destination = join(f.destinationRoot, item.dir, item.id, 'session.jsonl.zstd')
      expect(existsSync(destination)).toBe(true)
      expect(readFileSync(destination).equals(readFileSync(item.source))).toBe(true)
      expect(JSON.parse(firstLine(destination))).toMatchObject({ id: item.id, cwd: item.cwd })
    }
    expect(report.counts.sessions).toBe(3)
    expect(report.counts.sessionsCarried).toBe(3)
    expect(report.counts.sessionsReminted).toBe(0)
    expect(report.skipped).toEqual([])
  })

  it('re-mints a neutral-root session: directory, compressed header id, and cwd', async () => {
    const f = fixture()
    const oldRoot = join(f.dshHome, 'workspace')
    const oldId = sessionIdFor(oldRoot)
    const newRoot = neutralWorkspaceRoot(f.profileDir)
    const newId = sessionIdFor(newRoot)
    const source = writeZstdSession(join(f.sessionsRoot, projectKey(oldRoot), encodeSegment(oldId)), oldId, oldRoot)
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const destination = join(f.destinationRoot, projectKey(newRoot), encodeSegment(newId), 'session.jsonl.zstd')
    expect(existsSync(destination)).toBe(true)
    // F2:会话日志落新 DSH_HOME,不是 profileDir。
    expect(existsSync(join(f.profileDir, 'sessions'))).toBe(false)
    expect(JSON.parse(firstLine(destination))).toMatchObject({ type: 'session', version: 0, id: newId, cwd: newRoot })
    expect(report.counts.sessions).toBe(1)
    expect(report.counts.sessionsReminted).toBe(1)
    expect(report.counts.sessionsCarried).toBe(0)
    // 不删源:源文件原样保留(失败策略 §8)。
    expect(existsSync(source)).toBe(true)
  })

  it('keeps the v0 basename and format version so the upstream migration chain still applies', async () => {
    const f = fixture()
    const oldRoot = join(f.dshHome, 'workspace')
    const oldId = sessionIdFor(oldRoot)
    const newRoot = neutralWorkspaceRoot(f.profileDir)
    const newId = sessionIdFor(newRoot)
    writeZstdSession(join(f.sessionsRoot, projectKey(oldRoot), encodeSegment(oldId)), oldId, oldRoot)
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const destination = join(f.destinationRoot, projectKey(newRoot), encodeSegment(newId), 'session.jsonl.zstd')
    expect(basename(destination)).toBe('session.jsonl.zstd')
    expect(existsSync(join(dirname(destination), 'session.v3.jsonl.zstd'))).toBe(false)
    expect(JSON.parse(firstLine(destination)).version).toBe(0)
  })

  it('carries a legacy chat session and an automation run session unchanged', async () => {
    const f = fixture()
    const chat = writeZstdSession(
      join(f.sessionsRoot, '--Users-x-proj--', 'huaanwork-chat-9f8e7d6c5b4a3210'),
      'huaanwork-chat-9f8e7d6c5b4a3210',
      '/Users/x/proj',
    )
    const auto = writeZstdSession(
      join(f.sessionsRoot, '--Users-x-proj--', 'huaanwork-auto-a1-r1'),
      'huaanwork-auto-a1-r1',
      '/Users/x/proj',
    )
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const chatDestination = join(f.destinationRoot, '--Users-x-proj--', 'huaanwork-chat-9f8e7d6c5b4a3210', 'session.jsonl.zstd')
    const autoDestination = join(f.destinationRoot, '--Users-x-proj--', 'huaanwork-auto-a1-r1', 'session.jsonl.zstd')
    expect(readFileSync(chatDestination).equals(readFileSync(chat))).toBe(true)
    expect(readFileSync(autoDestination).equals(readFileSync(auto))).toBe(true)
    expect(JSON.parse(firstLine(chatDestination))).toMatchObject({ id: 'huaanwork-chat-9f8e7d6c5b4a3210' })
    expect(report.counts.sessions).toBe(2)
    expect(report.counts.sessionsCarried).toBe(2)
    expect(report.counts.sessionsReminted).toBe(0)
  })

  it('handles the two-level legacy layout and stray top-level files', async () => {
    const f = fixture()
    // 旧 session-sweep.ts:11-14 记载的两级布局:sessions/<escaped-cwd>/<sessionId>.jsonl[.zstd]。
    const legacyPath = join(f.sessionsRoot, '--Users-x-legacy--', 'huaanwork-chat-abcdef0123456789.jsonl.zstd')
    writeZstdLog(legacyPath, [
      JSON.stringify({ type: 'session', version: 0, id: 'huaanwork-chat-abcdef0123456789', createdAt: 5, cwd: '/Users/x/legacy', delegationDepth: 0 }),
      JSON.stringify({ type: 'turn', index: 0 }),
    ])
    // 顶层游离文件(历史布局残留)。
    const strayPath = join(f.sessionsRoot, 'orphan-session.jsonl.zstd')
    writeZstdLog(strayPath, [
      JSON.stringify({ type: 'session', version: 0, id: 'huaanwork-chat-0011223344556677', createdAt: 6, cwd: '/Users/x/stray', delegationDepth: 0 }),
    ])
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const legacyDestination = join(f.destinationRoot, '--Users-x-legacy--', 'huaanwork-chat-abcdef0123456789.jsonl.zstd')
    const strayDestination = join(f.destinationRoot, 'orphan-session.jsonl.zstd')
    expect(existsSync(legacyDestination)).toBe(true)
    expect(existsSync(strayDestination)).toBe(true)
    expect(readFileSync(legacyDestination).equals(readFileSync(legacyPath))).toBe(true)
    expect(readFileSync(strayDestination).equals(readFileSync(strayPath))).toBe(true)
    expect(report.counts.sessions).toBe(2)
    expect(report.counts.sessionsCarried).toBe(2)
  })

  it('rewrites a plain .jsonl log in place without turning it into .zstd', async () => {
    const f = fixture()
    const oldRoot = join(f.dshHome, 'workspace')
    const oldId = sessionIdFor(oldRoot)
    const newRoot = neutralWorkspaceRoot(f.profileDir)
    const newId = sessionIdFor(newRoot)
    writePlainSession(join(f.sessionsRoot, projectKey(oldRoot), encodeSegment(oldId), 'session.jsonl'), [
      JSON.stringify({ type: 'session', version: 0, id: oldId, createdAt: 7, cwd: oldRoot }),
      JSON.stringify({ type: 'turn', index: 0 }),
    ])
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const destination = join(f.destinationRoot, projectKey(newRoot), encodeSegment(newId), 'session.jsonl')
    expect(existsSync(destination)).toBe(true)
    expect(existsSync(join(dirname(destination), 'session.jsonl.zstd'))).toBe(false)
    const written = readFileSync(destination, 'utf8')
    expect(JSON.parse(written.split('\n', 1)[0] ?? '')).toMatchObject({ id: newId, cwd: newRoot })
    expect(written.endsWith(`${JSON.stringify({ type: 'turn', index: 0 })}\n`)).toBe(true)
    expect(report.counts.sessionsReminted).toBe(1)
  })

  it('never overwrites an existing destination session directory', async () => {
    const f = fixture()
    const oldRoot = join(f.dshHome, 'workspace')
    const oldId = sessionIdFor(oldRoot)
    const newRoot = neutralWorkspaceRoot(f.profileDir)
    const newId = sessionIdFor(newRoot)
    writeZstdSession(join(f.sessionsRoot, projectKey(oldRoot), encodeSegment(oldId)), oldId, oldRoot)
    const destination = join(f.destinationRoot, projectKey(newRoot), encodeSegment(newId), 'session.jsonl.zstd')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, 'sentinel\n', 'utf8')
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    expect(readFileSync(destination, 'utf8')).toBe('sentinel\n')
    const relativePath = join(projectKey(oldRoot), encodeSegment(oldId), 'session.jsonl.zstd')
    expect(report.skipped).toContain(`${relativePath}: destination already exists`)
    expect(report.counts.sessions).toBe(0)
    expect(report.counts.sessionsReminted).toBe(0)
  })

  it('leaves _no-cwd sessions alone', async () => {
    const f = fixture()
    const id = 'huaanwork-chat-0f0f0f0f0f0f0f0f'
    const source = writeZstdSession(join(f.sessionsRoot, '_no-cwd', id), id, undefined)
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const destination = join(f.destinationRoot, '_no-cwd', id, 'session.jsonl.zstd')
    expect(existsSync(destination)).toBe(true)
    expect(readFileSync(destination).equals(readFileSync(source))).toBe(true)
    expect(JSON.parse(firstLine(destination))).toMatchObject({ id })
    expect(Object.hasOwn(JSON.parse(firstLine(destination)) as object, 'cwd')).toBe(false)
    expect(report.counts.sessionsCarried).toBe(1)
    expect(report.counts.sessionsReminted).toBe(0)
  })

  it('rewrites a parentSession back-reference while carrying the file', async () => {
    const f = fixture()
    const oldId = sessionIdFor(join(f.dshHome, 'workspace'))
    const newId = sessionIdFor(neutralWorkspaceRoot(f.profileDir))
    const path = join(f.sessionsRoot, '--Users-x-proj--', 'sub-1', 'session.jsonl.zstd')
    writeZstdLog(path, [
      JSON.stringify({ type: 'session', version: 0, id: 'sub-1', createdAt: 8, cwd: '/Users/x/proj', parentSession: oldId, origin: 'subagent' }),
      JSON.stringify({ type: 'turn', index: 0 }),
    ])
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const destination = join(f.destinationRoot, '--Users-x-proj--', 'sub-1', 'session.jsonl.zstd')
    expect(JSON.parse(firstLine(destination))).toMatchObject({ id: 'sub-1', parentSession: newId, cwd: '/Users/x/proj' })
    expect(report.counts.sessionsCarried).toBe(1)
    expect(report.counts.sessionsReminted).toBe(0)
  })

  it('skips a file that exceeds the per-file size cap', async () => {
    const f = fixture()
    const smallId = 'huaanwork-chat-0000000000000004'
    const bigId = 'huaanwork-chat-0000000000000005'
    writePlainSession(join(f.sessionsRoot, '--Users-x-proj--', smallId, 'session.jsonl'), [
      JSON.stringify({ type: 'session', version: 0, id: smallId, createdAt: 1, cwd: '/Users/x/proj' }),
    ])
    writePlainSession(join(f.sessionsRoot, '--Users-x-proj--', bigId, 'session.jsonl'), [
      JSON.stringify({ type: 'session', version: 0, id: bigId, createdAt: 1, cwd: '/Users/x/proj', padding: 'x'.repeat(400) }),
    ])
    const step = createMigrateSessionsStep({ maxFileBytes: 200, totalDecompressedBudgetBytes: 1_000_000 })
    const report = createMigrationReport()
    await step.run(f.source, f.target, report)
    const bigRelative = join('--Users-x-proj--', bigId, 'session.jsonl')
    expect(report.skipped).toContain(`${bigRelative}: exceeds the migration size cap`)
    expect(existsSync(join(f.destinationRoot, bigRelative))).toBe(false)
    expect(existsSync(join(f.destinationRoot, '--Users-x-proj--', smallId, 'session.jsonl'))).toBe(true)
    expect(report.counts.sessions).toBe(1)
  })

  it('skips the remaining files once the cumulative decompression budget is spent', async () => {
    const f = fixture()
    const ids = [
      'huaanwork-chat-0000000000000001',
      'huaanwork-chat-0000000000000002',
      'huaanwork-chat-0000000000000003',
    ]
    const textOf = (id: string): string => `${[
      JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/Users/x/proj', padding: 'x'.repeat(200) }),
      JSON.stringify({ type: 'turn', index: 0 }),
    ].join('\n')}\n`
    for (const id of ids) {
      writeZstdLog(join(f.sessionsRoot, '--Users-x-proj--', id, 'session.jsonl.zstd'), textOf(id).split('\n').slice(0, -1))
    }
    // 预算只够两份:第三份起(含第三份)逐文件记 skip,迁移整体不失败。
    const step = createMigrateSessionsStep({
      maxFileBytes: 1_000_000,
      totalDecompressedBudgetBytes: textOf(ids[0] ?? '').length + 10,
    })
    const report = await runHuaanworkLegacyMigration({ source: f.source, target: f.target, steps: [step] })
    expect(report.performed).toBe(true)
    expect(existsSync(join(f.profileDir, 'huaanwork-migration.json'))).toBe(true)
    expect(report.marker?.counts.sessions).toBe(2)
    expect(report.counts.sessions).toBe(2)
    expect(report.counts.sessionsCarried).toBe(2)
    const skippedRelative = join('--Users-x-proj--', 'huaanwork-chat-0000000000000003', 'session.jsonl.zstd')
    expect(report.skipped).toContain(`${skippedRelative}: exceeds the cumulative decompression budget`)
    expect(existsSync(join(f.destinationRoot, skippedRelative))).toBe(false)
  })
})

describe('re-minted session frame layout (upstream first-frame contract)', () => {
  /** 重铸目标路径与两侧文本,内容种子 = header + turn(R1 真机发现 2 的复现形状)。 */
  function remintFixture() {
    const f = fixture()
    const oldRoot = join(f.dshHome, 'workspace')
    const oldId = sessionIdFor(oldRoot)
    const newRoot = neutralWorkspaceRoot(f.profileDir)
    const newId = sessionIdFor(newRoot)
    const createdAt = 1_700_000_000_000
    const sourceHeaderLine = JSON.stringify({ type: 'session', version: 0, id: oldId, createdAt, cwd: oldRoot, delegationDepth: 0 })
    const rewrittenHeaderLine = JSON.stringify({ type: 'session', version: 0, id: newId, createdAt, cwd: newRoot, delegationDepth: 0 })
    const turnLine = JSON.stringify({ type: 'turn', index: 0 })
    const sourcePath = join(f.sessionsRoot, projectKey(oldRoot), encodeSegment(oldId), 'session.jsonl.zstd')
    const destination = join(f.destinationRoot, projectKey(newRoot), encodeSegment(newId), 'session.jsonl.zstd')
    return { f, sourceHeaderLine, rewrittenHeaderLine, turnLine, sourcePath, destination }
  }

  it('keeps the rewritten header as its own first frame and the rest of the log as a later frame', async () => {
    const { f, sourceHeaderLine, rewrittenHeaderLine, turnLine, sourcePath, destination } = remintFixture()
    writeZstdLog(sourcePath, [sourceHeaderLine, turnLine])
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const bytes = readFileSync(destination)
    // (a) 独立可解码的第一帧恰为一行 header(上游 assertZstdHeaderFrame 的判据;
    // 单帧合并 header+content 在此为红 —— R1 真机发现 2)。
    const firstFrame = firstZstdFrameText(bytes)
    expect(firstFrame.indexOf('\n')).toBe(firstFrame.length - 1)
    expect(firstFrame).toBe(`${rewrittenHeaderLine}\n`)
    // 内容行确实在后续帧里,而不是被第一帧吞掉。
    expect(firstZstdFrameEnd(bytes)).toBeLessThan(bytes.length)
    // (b) 拼接全部帧的明文 = header + content,无数据丢失。
    expect(decompressZstdFrames(bytes)).toBe(`${rewrittenHeaderLine}\n${turnLine}\n`)
    expect(report.counts.sessionsReminted).toBe(1)
  })

  it('emits a single header frame for a header-only re-minted session', async () => {
    const { f, sourceHeaderLine, rewrittenHeaderLine, sourcePath, destination } = remintFixture()
    writeZstdLog(sourcePath, [sourceHeaderLine])
    const report = createMigrationReport()
    await migrateSessionsStep.run(f.source, f.target, report)
    const bytes = readFileSync(destination)
    // header-only 会话不产生空尾帧(镜像上游空会话的单帧编码)。
    expect(firstZstdFrameEnd(bytes)).toBe(bytes.length)
    expect(firstZstdFrameText(bytes)).toBe(`${rewrittenHeaderLine}\n`)
    expect(decompressZstdFrames(bytes)).toBe(`${rewrittenHeaderLine}\n`)
    expect(report.counts.sessionsReminted).toBe(1)
  })
})
