/**
 * 任务结果 Artifact 存储(设计 §5.3 / 计划 Task 1)。
 *
 * 这里直接读真实磁盘记录，不用 fake summary：两阶段入口、幂等裁决、读侧摘要复核
 * 与失败回收都以实际文件为证据。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { ArtifactWriteScope } from '../../src/huaanwork-host/artifacts-host.ts'
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS_PER_SESSION,
  beginArtifactWrite,
  commitPreparedArtifact,
  createArtifact,
  discardPreparedArtifact,
  findArtifactByRun,
  getArtifact,
  listArtifacts,
  prepareArtifact,
  readArtifactContent,
  readArtifactRecord,
  removeArtifactOfRun,
  removeArtifactsOfAutomation,
  removeArtifactsOfSession,
  sanitizeArtifactDownloadName,
  scanArtifactManifests,
} from '../../src/huaanwork-host/artifacts-host.ts'

const roots: string[] = []

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

it('persists and replays one markdown artifact', async () => {
  const root = makeRoot('artifact-store-')
  const input = {
    sessionId: 'session-1', title: '日报', format: 'markdown' as const,
    content: '# 日报\n\n完成存储', anchor: { kind: 'turn' as const },
    idempotency: { kind: 'tool' as const, callId: 'call-1' },
  }
  const first = await createArtifact(root, input)
  const replay = await createArtifact(root, input)
  expect(first.artifactId).toBe(replay.artifactId)
  expect(first.downloadName).toBe('日报.md') // title 兜底也必须经 sanitizer 并强制扩展名
  expect((await readArtifactContent(root, 'session-1', first.artifactId)).toString('utf8')).toBe(input.content)
  expect((await listArtifacts(root, 'session-1')).map((item) => item.artifactId)).toEqual([first.artifactId])
  await expect(readArtifactContent(root, 'other-session', first.artifactId)).rejects.toThrow('artifact-not-found')

  const summary = await getArtifact(root, 'session-1', first.artifactId)
  expect(summary).toMatchObject({
    artifactId: first.artifactId,
    sessionId: 'session-1',
    title: '日报',
    format: 'markdown',
    sizeBytes: Buffer.byteLength(input.content, 'utf8'),
    anchor: { kind: 'turn' },
  })
  expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(existsSync(join(root, 'artifacts', 'session-1', first.artifactId, 'manifest.json'))).toBe(true)
  expect(existsSync(join(root, 'artifacts', 'session-1', first.artifactId, 'content.md'))).toBe(true)

  const renamed = await createArtifact(root, {
    ...input, title: '报告', downloadName: 'a:b.txt', idempotency: { kind: 'tool', callId: 'call-2' },
  })
  expect(renamed.downloadName).toBe('a-b.md') // 原始名先清理再进入 summary，download 链路不得另猜名称
})

it('rejects oversized content and cross-session reads', async () => {
  const root = makeRoot('artifact-limit-')
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '过大', format: 'html', content: 'x'.repeat(5 * 1024 * 1024 + 1),
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-large' },
  })).rejects.toThrow('artifact-too-large')
  expect(await listArtifacts(root, 'session-1')).toEqual([])
})

it('keeps prepared bytes private and commits one record for concurrent replay', async () => {
  const root = makeRoot('artifact-prepared-')
  const scope: ArtifactWriteScope = {
    sessionId: 'session-1',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
  }
  const writes = [beginArtifactWrite(root, scope), beginArtifactWrite(root, scope)]
  try {
    await Promise.all(writes.map((write) => prepareArtifact(write, {
      title: '报告', format: 'markdown', content: '# 完整正文',
    })))
    expect(await listArtifacts(root, scope.sessionId)).toEqual([])
    expect(existsSync(join(root, 'artifacts', scope.sessionId))).toBe(false)
    const results = await Promise.all(writes.map((write) => commitPreparedArtifact(write)))
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.artifact.artifactId)).size).toBe(1)
    expect(await readArtifactContent(root, scope.sessionId, results[0]!.artifact.artifactId))
      .toEqual(Buffer.from('# 完整正文', 'utf8'))
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    expect(await listArtifacts(root, scope.sessionId)).toHaveLength(1) // discard 已提交句柄不删除正文
  } finally {
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
  }
})

it('replays one tool call against its persisted manifest anchor', async () => {
  const root = makeRoot('artifact-tool-replay-')
  const first = await createArtifact(root, {
    sessionId: 'session-1', title: '主报告', format: 'markdown', content: '# 首次正文',
    anchor: { kind: 'turn', clientMessageId: 'm1' },
    idempotency: { kind: 'tool', callId: 'call-1' },
  })
  // goal 续拍或迟到重放携带的当前锚不同:幂等命中仍返回原 manifest 锚与正文。
  const replay = await createArtifact(root, {
    sessionId: 'session-1', title: '主报告', format: 'markdown', content: '# 不应覆盖',
    anchor: { kind: 'turn', clientMessageId: 'm2' },
    idempotency: { kind: 'tool', callId: 'call-1' },
  })
  expect(replay.artifactId).toBe(first.artifactId)
  expect(replay.anchor).toEqual({ kind: 'turn', clientMessageId: 'm1' })
  expect((await readArtifactContent(root, 'session-1', replay.artifactId)).toString('utf8')).toBe('# 首次正文')
  expect(await listArtifacts(root, 'session-1')).toHaveLength(1)
})

it('validates runtime input beyond TypeScript types', async () => {
  const root = makeRoot('artifact-validate-')
  const base = {
    sessionId: 'session-1', anchor: { kind: 'turn' as const },
    idempotency: { kind: 'tool' as const, callId: 'call-v' },
  }
  await expect(createArtifact(root, { ...base, title: '', format: 'markdown', content: 'x' }))
    .rejects.toThrow('artifact-invalid-title')
  await expect(createArtifact(root, { ...base, title: '多\n行', format: 'markdown', content: 'x' }))
    .rejects.toThrow('artifact-invalid-title')
  await expect(createArtifact(root, { ...base, title: 't', format: 'pdf' as never, content: 'x' }))
    .rejects.toThrow('artifact-invalid-format')
  await expect(createArtifact(root, { ...base, title: 't', format: 'markdown', content: 42 as never }))
    .rejects.toThrow('artifact-invalid-content')
  await expect(createArtifact(root, { ...base, title: 't', format: 'markdown', content: 'x', downloadName: 7 as never }))
    .rejects.toThrow('artifact-invalid-download-name')
})

it('measures the size budget in UTF-8 bytes, not string length', async () => {
  const root = makeRoot('artifact-utf8-')
  const fit = '汉'.repeat(Math.floor(MAX_ARTIFACT_BYTES / 3)) // MAX-2 字节，处于预算内
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '边界', format: 'markdown', content: fit,
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-fit' },
  })).resolves.toBeDefined()
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '越界', format: 'markdown', content: `${fit}汉`, // MAX+1 字节
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-over' },
  })).rejects.toThrow('artifact-too-large')
})

it('round-trips original bytes with BOM, CRLF, Chinese and emoji', async () => {
  const root = makeRoot('artifact-bytes-')
  const content = '﻿# 标题\r\n正文 😀 中文\r\n'
  const artifact = await createArtifact(root, {
    sessionId: 'session-1', title: '字节', format: 'markdown', content,
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-bytes' },
  })
  expect(await readArtifactContent(root, 'session-1', artifact.artifactId))
    .toEqual(Buffer.from(content, 'utf8'))
})

it('sanitizes windows-illegal characters and reserved device names', () => {
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'a:b*c?d"e<f>g|h.md')).toBe('a-b-c-d-e-f-g-h.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'CON.txt')).toBe('_CON.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'com1.log')).toBe('_com1.md')
  expect(sanitizeArtifactDownloadName('报告', 'html', '结果')).toBe('结果.html')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'x.txt')).toBe('x.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', '../../etc/passwd')).not.toContain('/')
})

it('strips path separators and control characters from download names', () => {
  const name = sanitizeArtifactDownloadName('报告', 'html', '..\\evil\x01name/part.txt')
  expect(name).not.toMatch(/[/\\\x00-\x1f]/)
  expect(name.endsWith('.html')).toBe(true)
  expect(sanitizeArtifactDownloadName('  报告  ', 'markdown')).toBe('报告.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', '   ')).toBe('报告.md')
})

it('replays automation runs by their manifest idempotency key', async () => {
  const root = makeRoot('artifact-auto-')
  const input = {
    sessionId: 'auto-session-1',
    title: '自动化报告',
    format: 'html' as const,
    content: '<h1>自动化</h1>',
    anchor: { kind: 'automation-run' as const, automationId: 'automation-1', runId: 'run-1' },
    idempotency: { kind: 'automation-run' as const, automationId: 'automation-1', runId: 'run-1' },
  }
  const first = await createArtifact(root, input)
  const replay = await createArtifact(root, { ...input, title: '改过的标题', content: '<h1>新内容</h1>' })
  expect(replay.artifactId).toBe(first.artifactId)
  expect(replay.title).toBe('自动化报告')
  expect(replay.sha256).toBe(first.sha256)

  expect((await findArtifactByRun(root, 'automation-1', 'run-1'))?.artifactId).toBe(first.artifactId)
  expect(await findArtifactByRun(root, 'automation-1', 'run-2')).toBeUndefined()
  expect(await findArtifactByRun(root, 'automation-2', 'run-1')).toBeUndefined()
})

it('caps a session at the artifact budget without evicting existing records', async () => {
  const root = makeRoot('artifact-cap-')
  const created: string[] = []
  for (let index = 0; index < MAX_ARTIFACTS_PER_SESSION; index += 1) {
    const artifact = await createArtifact(root, {
      sessionId: 'session-1', title: `结果 ${index}`, format: 'markdown', content: `# ${index}`,
      anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: `call-${index}` },
    })
    created.push(artifact.artifactId)
  }
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '第 101 个', format: 'markdown', content: '# 多出来的',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-overflow' },
  })).rejects.toThrow('artifact-session-full')

  const listed = await listArtifacts(root, 'session-1')
  expect(listed.map((item) => item.artifactId).sort()).toEqual([...created].sort())
  // 幂等重放不受数量上限阻断：命中已有记录时返回原摘要且不新建。
  const replay = await createArtifact(root, {
    sessionId: 'session-1', title: '重放', format: 'markdown', content: '# 重放',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-0' },
  })
  expect(replay.artifactId).toBe(created[0])
})

it('rejects ids that are not single path segments', async () => {
  const root = makeRoot('artifact-path-')
  expect(() => beginArtifactWrite(root, {
    sessionId: '../escape', anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-1' },
  })).toThrow('artifact-invalid-scope')
  expect(() => beginArtifactWrite(root, {
    sessionId: 'session-1',
    anchor: { kind: 'automation-run', automationId: 'automation/1', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation/1', runId: 'run-1' },
  })).toThrow('artifact-invalid-scope')
  expect(() => beginArtifactWrite(root, {
    sessionId: 'session-1', anchor: { kind: 'turn' },
    idempotency: { kind: 'tool', callId: '' },
  })).toThrow('artifact-invalid-scope')

  await expect(readArtifactContent(root, '../session-1', 'artifact-1')).rejects.toThrow('artifact-not-found')
  await expect(getArtifact(root, 'session-1', '../artifact-1')).rejects.toThrow('artifact-not-found')
  await expect(listArtifacts(root, '..')).rejects.toThrow('artifact-not-found')
})

it('fails closed on corrupt manifests instead of returning an empty list', async () => {
  const root = makeRoot('artifact-corrupt-')
  const artifact = await createArtifact(root, {
    sessionId: 'session-1', title: '损坏', format: 'markdown', content: '# 原内容',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-corrupt' },
  })
  const manifestPath = join(root, 'artifacts', 'session-1', artifact.artifactId, 'manifest.json')
  writeFileSync(manifestPath, '{"artifactId":"broken"', 'utf8')

  await expect(listArtifacts(root, 'session-1')).rejects.toThrow('artifact-corrupt')
  await expect(getArtifact(root, 'session-1', artifact.artifactId)).rejects.toThrow('artifact-corrupt')
  await expect(readArtifactContent(root, 'session-1', artifact.artifactId)).rejects.toThrow('artifact-corrupt')
  await expect(readArtifactRecord(root, 'session-1', artifact.artifactId)).rejects.toThrow('artifact-corrupt')
})

it('re-verifies content bytes and digest on read', async () => {
  const root = makeRoot('artifact-digest-')
  const artifact = await createArtifact(root, {
    sessionId: 'session-1', title: '摘要', format: 'markdown', content: '# 原内容',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-digest' },
  })
  writeFileSync(join(root, 'artifacts', 'session-1', artifact.artifactId, 'content.md'), '# 被篡改', 'utf8')

  await expect(readArtifactContent(root, 'session-1', artifact.artifactId)).rejects.toThrow('artifact-corrupt')
  await expect(readArtifactRecord(root, 'session-1', artifact.artifactId)).rejects.toThrow('artifact-corrupt')
  await expect(getArtifact(root, 'session-1', artifact.artifactId)).rejects.toThrow('artifact-corrupt')
  await expect(listArtifacts(root, 'session-1')).rejects.toThrow('artifact-corrupt')
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '重放', format: 'markdown', content: '# 原内容',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-digest' },
  })).rejects.toThrow('artifact-corrupt')
})

it('reads summary and content as one verified record for content/download routes', async () => {
  const root = makeRoot('artifact-record-')
  const input = {
    sessionId: 'session-1', title: '合并读', format: 'markdown' as const,
    content: '# 一次读取\n\n中文与 emoji 🚀', anchor: { kind: 'turn' as const },
    idempotency: { kind: 'tool' as const, callId: 'call-record' },
  }
  const summary = await createArtifact(root, input)
  const record = await readArtifactRecord(root, 'session-1', summary.artifactId)
  // 与分离读取完全同值：路由合并不得改变摘要或字节。
  expect(record.artifact).toEqual(await getArtifact(root, 'session-1', summary.artifactId))
  expect(record.content.toString('utf8')).toBe(input.content)
  expect(record.content.equals(await readArtifactContent(root, 'session-1', summary.artifactId))).toBe(true)
  await expect(readArtifactRecord(root, 'other-session', summary.artifactId)).rejects.toThrow('artifact-not-found')
  await expect(readArtifactRecord(root, '../session-1', summary.artifactId)).rejects.toThrow('artifact-not-found')
})

it('captures immutable scope copies and ignores later caller mutation', async () => {
  const root = makeRoot('artifact-scope-')
  const anchor = { kind: 'automation-run' as const, automationId: 'automation-1', runId: 'run-1' }
  const idempotency = { kind: 'automation-run' as const, automationId: 'automation-1', runId: 'run-1' }
  const write = beginArtifactWrite(root, { sessionId: 'session-1', anchor, idempotency })
  ;(anchor as { runId: string }).runId = 'run-mutated'
  ;(idempotency as { automationId: string }).automationId = 'automation-mutated'

  await prepareArtifact(write, { title: '复制', format: 'markdown', content: '# 正文' })
  const committed = await commitPreparedArtifact(write)
  expect(committed.artifact.anchor).toEqual({ kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' })
  expect((await findArtifactByRun(root, 'automation-1', 'run-1'))?.artifactId).toBe(committed.artifact.artifactId)
  expect(await findArtifactByRun(root, 'automation-mutated', 'run-1')).toBeUndefined()
  await discardPreparedArtifact(write)
})

it('releases every lease without a permanent owner tombstone', async () => {
  const root = makeRoot('artifact-lease-')
  const base = { sessionId: 'session-1', anchor: { kind: 'turn' as const } }

  // prepare 失败后 discard：lease 回收，旧句柄不能再提交。
  const failed = beginArtifactWrite(root, {
    ...base, idempotency: { kind: 'tool', callId: 'lease-failed' },
  })
  await expect(prepareArtifact(failed, {
    title: '过大', format: 'markdown', content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1),
  })).rejects.toThrow('artifact-too-large')
  await discardPreparedArtifact(failed)
  await discardPreparedArtifact(failed) // 重复 discard 幂等
  await expect(commitPreparedArtifact(failed)).rejects.toThrow('artifact-owner-deleted')

  // 未 prepare 就 discard：同样回收 lease。
  const unprepared = beginArtifactWrite(root, {
    ...base, idempotency: { kind: 'tool', callId: 'lease-unprepared' },
  })
  await discardPreparedArtifact(unprepared)
  await expect(commitPreparedArtifact(unprepared)).rejects.toThrow('artifact-owner-deleted')

  // 同 session 的新 begin 不受旧句柄影响，证明没有永久 owner 墓碑。
  const fresh = beginArtifactWrite(root, {
    ...base, idempotency: { kind: 'tool', callId: 'lease-fresh' },
  })
  await prepareArtifact(fresh, { title: '恢复', format: 'markdown', content: '# 可用正文' })
  const committed = await commitPreparedArtifact(fresh)
  expect(committed.created).toBe(true)
  await discardPreparedArtifact(fresh)
  await discardPreparedArtifact(fresh) // commit 后 discard 不删除正文
  expect(await listArtifacts(root, 'session-1')).toHaveLength(1)
  await expect(commitPreparedArtifact(fresh)).rejects.toThrow('artifact-owner-deleted')
})

it('invalidates a prepared lease on session removal and leaves no permanent tombstone', async () => {
  const root = makeRoot('artifact-remove-session-')
  const scope: ArtifactWriteScope = {
    sessionId: 'session-1',
    anchor: { kind: 'turn' },
    idempotency: { kind: 'tool', callId: 'remove-1' },
  }
  const write = beginArtifactWrite(root, scope)
  await prepareArtifact(write, { title: '删除中', format: 'markdown', content: '# 迟到正文' })
  const committed = await createArtifact(root, {
    sessionId: 'session-1', title: '已有', format: 'markdown', content: '# 已有正文',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'existing' },
  })

  await removeArtifactsOfSession(root, scope.sessionId)
  await expect(commitPreparedArtifact(write)).rejects.toThrow('artifact-owner-deleted')
  await discardPreparedArtifact(write)
  expect(await listArtifacts(root, scope.sessionId)).toEqual([])
  expect(existsSync(join(root, 'artifacts', scope.sessionId, committed.artifactId))).toBe(false)

  // 删除完成后 begin 不受旧删除影响:不保留永久删除标记。
  const fresh = beginArtifactWrite(root, {
    sessionId: 'session-1',
    anchor: { kind: 'turn' },
    idempotency: { kind: 'tool', callId: 'fresh-after-remove' },
  })
  await prepareArtifact(fresh, { title: '恢复', format: 'markdown', content: '# 新正文' })
  expect((await commitPreparedArtifact(fresh)).created).toBe(true)
  await discardPreparedArtifact(fresh)
  expect(await listArtifacts(root, 'session-1')).toHaveLength(1)
})

it('invalidates only the exact automation-run anchor for a run removal', async () => {
  const root = makeRoot('artifact-remove-run-')
  const runScope: ArtifactWriteScope = {
    sessionId: 'auto-session-1',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
  }
  const siblingRun: ArtifactWriteScope = {
    sessionId: 'auto-session-1',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-2' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-2' },
  }
  const otherAutomation: ArtifactWriteScope = {
    sessionId: 'auto-session-2',
    anchor: { kind: 'automation-run', automationId: 'automation-2', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-2', runId: 'run-1' },
  }
  const removed = beginArtifactWrite(root, runScope)
  const sibling = beginArtifactWrite(root, siblingRun)
  const other = beginArtifactWrite(root, otherAutomation)
  await Promise.all([
    prepareArtifact(removed, { title: '被删', format: 'markdown', content: '# 被删' }),
    prepareArtifact(sibling, { title: '保留', format: 'markdown', content: '# 保留' }),
    prepareArtifact(other, { title: '别家', format: 'markdown', content: '# 别家' }),
  ])
  const onDisk = await createArtifact(root, {
    sessionId: runScope.sessionId, title: '旧记录', format: 'markdown', content: '# 旧正文',
    anchor: runScope.anchor, idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
  })

  await removeArtifactOfRun(root, runScope.sessionId, 'automation-1', 'run-1')
  await expect(commitPreparedArtifact(removed)).rejects.toThrow('artifact-owner-deleted')
  expect(await listArtifacts(root, runScope.sessionId)).toEqual([])
  expect(existsSync(join(root, 'artifacts', runScope.sessionId, onDisk.artifactId))).toBe(false)

  expect((await commitPreparedArtifact(sibling)).created).toBe(true)
  expect((await commitPreparedArtifact(other)).created).toBe(true)
  const kept = await listArtifacts(root, runScope.sessionId)
  expect(kept.map((item) => item.anchor)).toEqual([siblingRun.anchor])
  for (const write of [removed, sibling, other]) await discardPreparedArtifact(write)
})

it('invalidates all leases of one automation and deletes only its manifests', async () => {
  const root = makeRoot('artifact-remove-automation-')
  const removedScope: ArtifactWriteScope = {
    sessionId: 'auto-session-1',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-late' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-late' },
  }
  const keptScope: ArtifactWriteScope = {
    sessionId: 'auto-session-2',
    anchor: { kind: 'automation-run', automationId: 'automation-2', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-2', runId: 'run-1' },
  }
  const removed = beginArtifactWrite(root, removedScope)
  const kept = beginArtifactWrite(root, keptScope)
  await Promise.all([
    prepareArtifact(removed, { title: '被删', format: 'markdown', content: '# 被删' }),
    prepareArtifact(kept, { title: '保留', format: 'markdown', content: '# 保留' }),
  ])
  await createArtifact(root, {
    sessionId: removedScope.sessionId, title: '旧一', format: 'markdown', content: '# 旧一',
    anchor: removedScope.anchor, idempotency: removedScope.idempotency,
  })
  const otherRun = await createArtifact(root, {
    sessionId: 'auto-session-1', title: '同会话别家自动化', format: 'markdown', content: '# 别家',
    anchor: { kind: 'automation-run', automationId: 'automation-2', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-2', runId: 'run-1' },
  })

  await removeArtifactsOfAutomation(root, 'automation-1')
  await expect(commitPreparedArtifact(removed)).rejects.toThrow('artifact-owner-deleted')
  expect((await commitPreparedArtifact(kept)).created).toBe(true)
  const remaining = await listArtifacts(root, removedScope.sessionId)
  expect(remaining.map((item) => item.artifactId)).toEqual([otherRun.artifactId])
  const scan = await scanArtifactManifests(root)
  expect(scan.every((record) => record.anchor.kind !== 'automation-run' || record.anchor.automationId !== 'automation-1')).toBe(true)
  for (const write of [removed, kept]) await discardPreparedArtifact(write)
})

it('scans manifests read-only and returns nothing for an absent profile root', async () => {
  const root = makeRoot('artifact-scan-')
  expect(await scanArtifactManifests(root)).toEqual([])
  const first = await createArtifact(root, {
    sessionId: 'session-1', title: '扫描', format: 'markdown', content: '# 一',
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'scan-1' },
  })
  const second = await createArtifact(root, {
    sessionId: 'session-2', title: '扫描', format: 'html', content: '<p>二</p>',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-9' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-9' },
  })
  const records = await scanArtifactManifests(root)
  expect(records.map((record) => [record.sessionId, record.artifactId]).sort()).toEqual([
    ['session-1', first.artifactId],
    ['session-2', second.artifactId],
  ].sort())
  expect(records.find((record) => record.artifactId === second.artifactId)?.anchor).toEqual({
    kind: 'automation-run', automationId: 'automation-1', runId: 'run-9',
  })
})
