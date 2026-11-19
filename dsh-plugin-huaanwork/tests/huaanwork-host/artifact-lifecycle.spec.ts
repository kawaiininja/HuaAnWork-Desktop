/**
 * 全生命周期清理(Task 8 / 设计 §5.3、§9)。
 *
 * 每条用例都用真实存储原语建 Artifact 与运行/会话记录，再调用对应的公开删除原语，
 * 以实际磁盘目录与读取结果作证据；兄弟 Artifact 必须保留。删除与两阶段写入的竞态
 * 用 `node:fs/promises` 的 rm 部分 mock 定点挂起，不靠定时器猜时序；同一 mock 记录
 * 每次 readdir，用文件系统枚举而不是模块导出来证明删除不扫描全 profile。
 * 符号链接逃逸用例使用真实临时目录与 `symlinkSync`，由 afterEach 连根删除。
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { ArtifactWriteScope } from '../../src/huaanwork-host/artifacts-host.ts'
import * as artifactStore from '../../src/huaanwork-host/artifacts-host.ts'
import {
  ARTIFACT_CLEANUP_INCOMPLETE_MESSAGE,
  beginArtifactWrite,
  commitPreparedArtifact,
  createArtifact,
  discardPreparedArtifact,
  listArtifacts,
  prepareArtifact,
  removeArtifactOfRun,
  removeArtifactsOfAutomation,
  removeArtifactsOfSession,
} from '../../src/huaanwork-host/artifacts-host.ts'
import { automationRunSessionId } from '../../src/huaanwork-host/automation-session-ids.ts'
import {
  appendRun,
  createAutomation,
  deleteAutomationRun,
  normalizeAutomationInput,
  pruneAutomationSessions,
  removeAutomation,
} from '../../src/huaanwork-host/automations-store.ts'
import { ROUTE_TABLE, type RouteContext, type RouteHandler } from '../../src/huaanwork-host/routes.ts'
import { sessionRemove } from '../../src/huaanwork-host/sessions.ts'
import { createProject, recentRuns } from '../../src/huaanwork-host/stores.ts'

/** 删除 I/O 屏障与文件系统枚举观测:拦 `deletionIo.path` 的那一次 rm,并记录每次 readdir。 */
const deletionIo = vi.hoisted(() => ({
  path: undefined as string | undefined,
  wait: undefined as undefined | (() => Promise<void>),
  failure: undefined as undefined | Error,
  readdirs: [] as string[],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    readdir: async (path: string, options?: { withFileTypes: true; recursive?: boolean }) => {
      deletionIo.readdirs.push(path)
      return options === undefined ? real.readdir(path) : real.readdir(path, options)
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (args[0] === deletionIo.path) {
        await deletionIo.wait?.()
        const failure = deletionIo.failure
        if (failure !== undefined) throw failure
      }
      return real.rm(args[0], args[1])
    },
  }
})

function deletionBarrier() {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => {
      entered.resolve()
      await released.promise
    },
  }
}

const roots: string[] = []

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  deletionIo.path = undefined
  deletionIo.wait = undefined
  deletionIo.failure = undefined
  deletionIo.readdirs.length = 0
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type SeedOptions = {
  profileDir?: string
  runId?: string
  title?: string
  includeSessionId?: boolean
  persistRun?: boolean
  projectId?: string
}

type SeededRun = {
  profileDir: string
  automationId: string
  runId: string
  sessionId: string
  artifactId: string
}

/** 真实原语夹具:createAutomation + createArtifact + appendRun。 */
async function seedRunArtifact(opts: SeedOptions = {}): Promise<SeededRun> {
  const profileDir = opts.profileDir ?? makeRoot('artifact-life-')
  const automation = await createAutomation(profileDir, normalizeAutomationInput({
    name: '结果任务',
    kind: 'agent',
    schedule: { kind: 'manual' },
    prompt: '生成结果',
    ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
  }))
  const runId = opts.runId ?? randomUUID()
  const sessionId = automationRunSessionId(automation.id, runId)
  const title = opts.title ?? '结果'
  const artifact = await createArtifact(profileDir, {
    sessionId,
    anchor: { kind: 'automation-run', automationId: automation.id, runId },
    idempotency: { kind: 'automation-run', automationId: automation.id, runId },
    title,
    format: 'markdown',
    content: `# ${title}`,
  })
  if (opts.persistRun !== false) {
    await appendRun(profileDir, automation.id, {
      runId,
      startedAt: 1,
      endedAt: 2,
      ok: true,
      output: 'ok',
      status: 'ok',
      ...(opts.includeSessionId === false ? {} : { sessionId }),
    })
  }
  return { profileDir, automationId: automation.id, runId, sessionId, artifactId: artifact.artifactId }
}

function routeCtx(profileDir: string, dshHome: string): RouteContext {
  return {
    dshHome,
    profileDir,
    workspaceRoot: { current: profileDir },
    emit() {},
    logger() {},
    requestRestart: async () => false,
  }
}

function handler(method: string): RouteHandler {
  const found = ROUTE_TABLE.find((item) => item.method === method)
  if (!found) throw new Error(`missing route ${method}`)
  return found.handler
}

function makeSessionLog(dshHome: string, sessionId: string, cwd: string): string {
  const dir = join(dshHome, 'sessions', 'some-cwd')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', id: sessionId, createdAt: 1, cwd })}\n`, 'utf8')
  return file
}

async function artifactIds(profileDir: string, sessionId: string): Promise<string[]> {
  return (await listArtifacts(profileDir, sessionId)).map((item) => item.artifactId)
}

it('session.remove deletes the session artifacts and keeps a sibling session', async () => {
  const seeded = await seedRunArtifact()
  const sibling = await seedRunArtifact({ profileDir: seeded.profileDir, runId: 'sibling-run' })
  const dshHome = makeRoot('artifact-life-dsh-')
  const log = makeSessionLog(dshHome, seeded.sessionId, join(dshHome, 'workspace'))

  const report = await sessionRemove(undefined, routeCtx(seeded.profileDir, dshHome), {
    sessionId: seeded.sessionId,
  })
  expect(report).toEqual({ removed: true })
  expect(existsSync(log)).toBe(false)
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([])
  expect(existsSync(join(seeded.profileDir, 'artifacts', seeded.sessionId))).toBe(false)
  expect(await artifactIds(seeded.profileDir, sibling.sessionId)).toEqual([sibling.artifactId])
})

it('automation.deleteRun deletes only that run artifact record row', async () => {
  const seeded = await seedRunArtifact()
  const sibling = await seedRunArtifact({ profileDir: seeded.profileDir, runId: 'keep-run' })

  const report = await deleteAutomationRun(seeded.profileDir, seeded.automationId, seeded.runId, {
    sessionsRoot: join(seeded.profileDir, 'sessions'),
  })
  expect(report).toMatchObject({ removed: true })
  expect(await recentRuns(seeded.profileDir, seeded.automationId, 100))
    .not.toContainEqual(expect.objectContaining({ runId: seeded.runId }))
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([])
  expect(existsSync(join(seeded.profileDir, 'artifacts', seeded.sessionId, seeded.artifactId))).toBe(false)
  expect(await artifactIds(seeded.profileDir, sibling.sessionId)).toEqual([sibling.artifactId])
})

it('automation.remove cascades to all artifacts of that automation only', async () => {
  const seeded = await seedRunArtifact()
  const sibling = await seedRunArtifact({ profileDir: seeded.profileDir, runId: 'keep-run' })

  await removeAutomation(seeded.profileDir, seeded.automationId)
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([])
  expect(existsSync(join(seeded.profileDir, 'artifacts', seeded.sessionId, seeded.artifactId))).toBe(false)
  expect(await artifactIds(seeded.profileDir, sibling.sessionId)).toEqual([sibling.artifactId])
})

it('project.remove cascades to the artifacts of its automations only', async () => {
  const profileDir = makeRoot('artifact-life-')
  const dshHome = makeRoot('artifact-life-dsh-')
  const project = await createProject(profileDir, { root: makeRoot('artifact-life-root-'), name: '季度' })
  const seeded = await seedRunArtifact({ profileDir, projectId: project.id })
  const other = await seedRunArtifact({ profileDir })

  const report = await handler('project.remove')({ params: {}, body: { projectId: project.id }, query: new URLSearchParams() }, routeCtx(profileDir, dshHome))
  expect(report).toMatchObject({ removed: true })
  expect(await artifactIds(profileDir, seeded.sessionId)).toEqual([])
  expect(await artifactIds(profileDir, other.sessionId)).toEqual([other.artifactId])
})

it('automation.pruneSessions deletes only the artifacts of sessions actually removed', async () => {
  const seeded = await seedRunArtifact({ persistRun: false })
  const kept = await seedRunArtifact({ profileDir: seeded.profileDir, runId: 'kept-run' })
  const sessionsRoot = join(seeded.profileDir, 'sessions')
  mkdirSync(join(sessionsRoot, 'project', seeded.sessionId), { recursive: true })
  mkdirSync(join(sessionsRoot, 'project', kept.sessionId), { recursive: true })

  const result = await pruneAutomationSessions(seeded.profileDir, new Set([kept.sessionId]), sessionsRoot)
  expect(result.removed).toBe(1)
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([])
  expect(existsSync(join(sessionsRoot, 'project', seeded.sessionId))).toBe(false)
  expect(await artifactIds(seeded.profileDir, kept.sessionId)).toEqual([kept.artifactId])
  expect(existsSync(join(sessionsRoot, 'project', kept.sessionId))).toBe(true)
})

it('treats a missing artifact directory as an idempotent success', async () => {
  const profileDir = makeRoot('artifact-life-')
  await expect(removeArtifactsOfSession(profileDir, 'absent-session')).resolves.toBeUndefined()
  await expect(removeArtifactsOfSession(profileDir, 'absent-session')).resolves.toBeUndefined()
  await expect(removeArtifactOfRun(profileDir, 'absent-session', 'automation-1', 'run-1')).resolves.toBeUndefined()
  await expect(removeArtifactsOfAutomation(profileDir, 'automation-1')).resolves.toBeUndefined()
})

it('reports incomplete cleanup instead of silently succeeding', async () => {
  const seeded = await seedRunArtifact()
  const dshHome = makeRoot('artifact-life-dsh-')
  makeSessionLog(dshHome, seeded.sessionId, join(dshHome, 'workspace'))
  deletionIo.path = join(seeded.profileDir, 'artifacts', seeded.sessionId)
  deletionIo.failure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

  const report = await sessionRemove(undefined, routeCtx(seeded.profileDir, dshHome), {
    sessionId: seeded.sessionId,
  })
  expect(report).toEqual({
    removed: true,
    artifactCleanup: { complete: false, message: ARTIFACT_CLEANUP_INCOMPLETE_MESSAGE },
  })
  expect(JSON.stringify(report)).toContain('记录已删除、结果文件未能完全清理')
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([seeded.artifactId])
})

it('locates a run artifact directly via RunSummary.sessionId without scanning', async () => {
  const seeded = await seedRunArtifact()
  const sibling = await seedRunArtifact({ profileDir: seeded.profileDir, runId: 'no-scan-sibling' })
  const artifactRoot = join(seeded.profileDir, 'artifacts')
  const scan = vi.spyOn(artifactStore, 'scanArtifactManifests')
  deletionIo.readdirs.length = 0
  try {
    const report = await deleteAutomationRun(seeded.profileDir, seeded.automationId, seeded.runId, {
      sessionsRoot: join(seeded.profileDir, 'sessions'),
    })
    // 文件系统证据(名称空间 spy 看不到模块内部调用):删除期间只枚举本会话目录,
    // 不列 artifacts 根,也不列任何兄弟会话目录。
    const artifactEnumerations = deletionIo.readdirs.filter(
      (path) => path === artifactRoot || path.startsWith(`${artifactRoot}${sep}`),
    )
    expect(report).toMatchObject({ removed: true })
    expect(artifactEnumerations).toEqual([join(artifactRoot, seeded.sessionId)])
    expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([])
    expect(await artifactIds(seeded.profileDir, sibling.sessionId)).toEqual([sibling.artifactId])
    expect(scan).not.toHaveBeenCalled()
  } finally {
    scan.mockRestore()
  }
})

it('scans manifests by exact automation anchor when sessions are gone', async () => {
  const first = await seedRunArtifact({ runId: 'run-1', title: '同名结果' })
  const other = await seedRunArtifact({
    profileDir: first.profileDir,
    runId: 'run-2',
    title: '同名结果',
  })
  rmSync(join(first.profileDir, 'sessions', first.sessionId), { recursive: true, force: true })
  await removeAutomation(first.profileDir, first.automationId)
  expect(await artifactIds(first.profileDir, first.sessionId)).toEqual([])
  expect(existsSync(join(first.profileDir, 'artifacts', first.sessionId, first.artifactId))).toBe(false)
  expect(await artifactIds(other.profileDir, other.sessionId)).toEqual([other.artifactId])
})

it('reports incomplete cleanup when RunSummary lacks sessionId', async () => {
  const seeded = await seedRunArtifact({ includeSessionId: false })
  const report = await deleteAutomationRun(seeded.profileDir, seeded.automationId, seeded.runId, {
    sessionsRoot: join(seeded.profileDir, 'sessions'),
  })
  expect(JSON.stringify(report)).toContain('记录已删除、结果文件未能完全清理')
  expect((await recentRuns(seeded.profileDir, seeded.automationId, 100)).some((run) => run.runId === seeded.runId)).toBe(false)
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([seeded.artifactId])
})

it('invalidates writes begun while deletion awaits I/O even when no final directory exists', async () => {
  const root = makeRoot('artifact-delete-race-')
  const scope: ArtifactWriteScope = {
    sessionId: 'session-1', anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'race' },
  }
  const before = beginArtifactWrite(root, scope)
  const writes = [before]
  const gate = deletionBarrier()
  deletionIo.path = join(root, 'artifacts', scope.sessionId)
  deletionIo.wait = gate.wait
  const removing = removeArtifactsOfSession(root, scope.sessionId)
  try {
    await gate.entered
    const during = beginArtifactWrite(root, scope)
    writes.push(during)
    await prepareArtifact(during, { title: '迟到', format: 'markdown', content: '# 不应复活' })
    gate.release()
    await removing
    for (const write of writes) {
      await expect(commitPreparedArtifact(write)).rejects.toThrow('artifact-owner-deleted')
      await discardPreparedArtifact(write)
    }
    expect(await listArtifacts(root, scope.sessionId)).toEqual([])
    expect(existsSync(join(root, 'artifacts', scope.sessionId))).toBe(false)
  } finally {
    gate.release()
    await removing
    deletionIo.path = undefined
    deletionIo.wait = undefined
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    rmSync(root, { recursive: true, force: true })
  }
})

it('reports the artifact removal failure but still invalidates the lease in finally', async () => {
  const root = makeRoot('artifact-delete-fail-')
  const scope: ArtifactWriteScope = {
    sessionId: 'session-1', anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'fail' },
  }
  const write = beginArtifactWrite(root, scope)
  await prepareArtifact(write, { title: '失败', format: 'markdown', content: '# 正文' })
  const gate = deletionBarrier()
  deletionIo.path = join(root, 'artifacts', scope.sessionId)
  deletionIo.wait = gate.wait
  deletionIo.failure = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
  const removing = removeArtifactsOfSession(root, scope.sessionId)
  try {
    await gate.entered
    gate.release()
    await expect(removing).rejects.toThrow('EIO')
    await expect(commitPreparedArtifact(write)).rejects.toThrow('artifact-owner-deleted')
  } finally {
    gate.release()
    await removing.catch(() => undefined)
    deletionIo.path = undefined
    deletionIo.wait = undefined
    deletionIo.failure = undefined
    await discardPreparedArtifact(write)
    rmSync(root, { recursive: true, force: true })
  }
})

it('invalidates the run lease without guessing a directory when sessionId is unknown', async () => {
  const seeded = await seedRunArtifact()
  const scope: ArtifactWriteScope = {
    sessionId: seeded.sessionId,
    anchor: { kind: 'automation-run', automationId: seeded.automationId, runId: seeded.runId },
    idempotency: { kind: 'automation-run', automationId: seeded.automationId, runId: seeded.runId },
  }
  const write = beginArtifactWrite(seeded.profileDir, scope)
  await prepareArtifact(write, { title: '迟到', format: 'markdown', content: '# 迟到正文' })

  await removeArtifactOfRun(seeded.profileDir, undefined, seeded.automationId, seeded.runId)
  await expect(commitPreparedArtifact(write)).rejects.toThrow('artifact-owner-deleted')
  await discardPreparedArtifact(write)
  // 窄化输入不猜目录:已有结果文件保持原样,由调用方报告清理不完整。
  expect(await artifactIds(seeded.profileDir, seeded.sessionId)).toEqual([seeded.artifactId])
})

it('rejects session removal when the session directory is a symlink out of the profile', async () => {
  const profileDir = makeRoot('artifact-escape-')
  const outside = makeRoot('artifact-outside-')
  writeFileSync(join(outside, 'keep.md'), '# 外部数据', 'utf8')
  mkdirSync(join(profileDir, 'artifacts'), { recursive: true })
  symlinkSync(outside, join(profileDir, 'artifacts', 'linked-session'), 'dir')

  await expect(removeArtifactsOfSession(profileDir, 'linked-session')).rejects.toThrow('artifact-path-escape')
  expect(readFileSync(join(outside, 'keep.md'), 'utf8')).toBe('# 外部数据')
  expect(lstatSync(join(profileDir, 'artifacts', 'linked-session')).isSymbolicLink()).toBe(true)
})

it('rejects a run removal whose target escapes through the session link', async () => {
  const seeded = await seedRunArtifact()
  const outside = makeRoot('artifact-outside-')
  const movedSession = join(outside, 'session')
  const sessionDir = join(seeded.profileDir, 'artifacts', seeded.sessionId)
  renameSync(sessionDir, movedSession)
  symlinkSync(movedSession, sessionDir, 'dir')

  // manifest 仍可经链接读到,但解析后的目标在 profile 之外,必须在任何 rm 之前拒绝。
  await expect(removeArtifactOfRun(seeded.profileDir, seeded.sessionId, seeded.automationId, seeded.runId))
    .rejects.toThrow('artifact-path-escape')
  // 自动化级扫描不把符号链接目录当作会话目录,因此同样不进入外链。
  await expect(removeArtifactsOfAutomation(seeded.profileDir, seeded.automationId)).resolves.toBeUndefined()
  expect(readFileSync(join(movedSession, seeded.artifactId, 'content.md'), 'utf8')).toBe('# 结果')
})

it('unlinks a symlinked artifact directory instead of following it outside the profile', async () => {
  const seeded = await seedRunArtifact()
  const outside = makeRoot('artifact-outside-')
  writeFileSync(join(outside, 'keep.md'), '# 外部正文', 'utf8')
  const artifactDir = join(seeded.profileDir, 'artifacts', seeded.sessionId, seeded.artifactId)
  rmSync(artifactDir, { recursive: true, force: true })
  symlinkSync(outside, artifactDir, 'dir')

  await expect(removeArtifactsOfSession(seeded.profileDir, seeded.sessionId)).resolves.toBeUndefined()
  expect(existsSync(join(seeded.profileDir, 'artifacts', seeded.sessionId))).toBe(false)
  expect(readdirSync(outside)).toEqual(['keep.md'])
  expect(readFileSync(join(outside, 'keep.md'), 'utf8')).toBe('# 外部正文')
})

it('treats dangling links and a missing profile root as no-op removals', async () => {
  const profileDir = makeRoot('artifact-dangling-')
  mkdirSync(join(profileDir, 'artifacts', 'linked-session'), { recursive: true })
  symlinkSync(join(profileDir, 'missing-artifact'), join(profileDir, 'artifacts', 'linked-session', 'dangling-artifact'), 'dir')
  await expect(removeArtifactsOfSession(profileDir, 'linked-session')).resolves.toBeUndefined()
  expect(() => lstatSync(join(profileDir, 'artifacts', 'linked-session'))).toThrow()

  symlinkSync(join(profileDir, 'missing-session'), join(profileDir, 'artifacts', 'dangling-session'), 'dir')
  await expect(removeArtifactsOfSession(profileDir, 'dangling-session')).resolves.toBeUndefined()
  expect(() => lstatSync(join(profileDir, 'artifacts', 'dangling-session'))).toThrow()

  const missingProfile = join(profileDir, 'no-such-profile')
  await expect(removeArtifactsOfSession(missingProfile, 'session-1')).resolves.toBeUndefined()
  await expect(removeArtifactOfRun(missingProfile, 'session-1', 'automation-1', 'run-1')).resolves.toBeUndefined()
  await expect(removeArtifactsOfAutomation(missingProfile, 'automation-1')).resolves.toBeUndefined()
})
